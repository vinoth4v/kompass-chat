// AI Council: N agents research the same question independently and in
// parallel, then a judge reads every answer, names the disagreements, weighs
// the evidence and synthesizes one final answer.
//
// Two properties matter more than anything else here:
//
//   1. CITATIONS ARE GROUND TRUTH. Sources are collected from the URLs an agent
//      actually searched and fetched — never from what the model claims it
//      read. A council that confidently cites invented sources is worse than no
//      council, and models invent sources readily.
//
//   2. ONE AGENT FAILING MUST NOT KILL THE COUNCIL. These are free models: the
//      measured success rate across the roster runs 79-97%, so with 3+ agents a
//      failure somewhere is the common case, not the exception. Every agent is
//      settled independently and the judge works with whatever came back.
import {
  KompassTimeoutError,
  REQUEST_TIMEOUT_MS,
  modelRequest,
  sendMessage,
  type AnthropicMessageWire,
  type AnthropicTextBlockWire,
  type AnthropicToolResultBlockWire,
  type AnthropicToolUseBlockWire,
} from "./kompassClient";
import type { KompassSettings } from "./types";
import { TOOLS, TOOL_NAMES, executeTool, type Source } from "./tools";
import { extractObject, recoverToolCalls } from "./recoverToolCall";
import { QUANTITATIVE_INSTRUCTION } from "./prompts";
import { unbackedCitations } from "./research";

export type { Source };

export type ResearchDepth = "fast" | "deep";

/** One seat on the council. `model` is either a kompass-<lane> name or a
 *  concrete "provider/model" entry, which is forced via x-kompass-model. */
export interface AgentSpec {
  id: string;
  label: string;
  model: string;
}

export type AgentPhase =
  "queued" | "searching" | "reading" | "thinking" | "done" | "failed";

export interface AgentState {
  spec: AgentSpec;
  phase: AgentPhase;
  /** Human-readable current activity — the query being searched, the page being read. */
  detail?: string;
  searches: number;
  reads: number;
  answer?: string;
  sources: Source[];
  error?: string;
  servedBy?: string | null;
  usage?: { input: number; output: number };
  elapsedMs?: number;
  /** The seat's preferred model was unavailable. */
  fellBack?: boolean;
  /** The distinct replacement model it ran on, when one was free. */
  replacedWith?: string;
}

export interface Disagreement {
  point: string;
  positions: string[];
}

export interface CouncilVerdict {
  answer: string;
  agreements: string[];
  disagreements: Disagreement[];
  sources: Source[];
  servedBy?: string | null;
  /** Set when the judge's structured block could not be parsed and its prose
   *  was used as-is — the UI says so rather than pretending it found nothing. */
  degraded?: boolean;
  /** Problems with the verdict itself, e.g. a [n] citation backed by nothing.
   *  Same check chat and research apply — a council is not exempt. */
  notices?: string[];
}

export interface CouncilRun {
  agents: AgentState[];
  verdict?: CouncilVerdict;
  judgePhase: "waiting" | "deliberating" | "done" | "failed";
  judgeError?: string;
}

/**
 * Wall-clock budgets. Iteration counts alone never bounded anything: an agent
 * with four steps left and a model that answers in four minutes is a ten-minute
 * seat, and the council waits for the slowest one.
 *
 *   agent  — one seat's whole research loop, first attempt
 *   retry  — the second attempt on a different model, deliberately shorter:
 *            the question is now "can anyone answer this", not "answer it well"
 *   run    — hard ceiling on ALL seats. Whatever is still thinking when this
 *            fires is abandoned and the judge works with what finished, which
 *            is the entire point of a council that tolerates failure.
 */
const BUDGET: Record<ResearchDepth, { agent: number; retry: number; run: number }> = {
  fast: { agent: 120_000, retry: 75_000, run: 210_000 },
  deep: { agent: 240_000, retry: 90_000, run: 360_000 },
};

/** Judge budget. It reads and synthesizes rather than researching, so one call. */
const JUDGE_TIMEOUT_MS = 90_000;

/**
 * Waits before each judge retry. Nothing before the first attempt; then long
 * enough for a per-minute quota window to roll over, because "lanes exhausted"
 * after five seats have just run is a timing problem, not a permanent one.
 */
export const JUDGE_RETRY_WAITS_MS = [0, 12_000, 30_000, 30_000];

const DEPTH: Record<ResearchDepth, { iterations: number; guidance: string }> = {
  fast: {
    iterations: 4,
    guidance:
      "Work quickly: one or two searches, then read at most two of the most promising pages " +
      "before answering.",
  },
  deep: {
    iterations: 7,
    guidance:
      "Be thorough: search from more than one angle, read three to five pages in full, and " +
      "actively look for evidence that CONTRADICTS your initial view before answering.",
  },
};

function agentSystemPrompt(depth: ResearchDepth): string {
  return (
    "You are one member of a council of independent analysts. You are answering on your own — " +
    "you cannot see the other members and must not assume they agree with you. " +
    `${DEPTH[depth].guidance} ` +
    "Ground every substantive claim in a page you actually fetched. Where the sources conflict, " +
    "say so explicitly and state which you find more credible and why. If the evidence is thin, " +
    "say that plainly — a hedged answer is far more useful to the council than a confident " +
    "invented one. Never cite a URL you did not fetch. " +
    "Finish with a clear, self-contained answer in markdown.\n\n" +
    // The seats answer the question themselves, so they need the same rigour
    // rules as chat and research — a council of five sloppy arithmeticians is
    // still sloppy arithmetic.
    QUANTITATIVE_INSTRUCTION
  );
}

const JUDGE_SYSTEM_PROMPT =
  "You are the Council Judge. Several independent analysts have researched the same question " +
  "and each returned an answer plus the list of sources they actually read. Your job is NOT to " +
  "redo the research and NOT to average the answers. It is to weigh them.\n\n" +
  "Do all of the following:\n" +
  "1. Identify what the analysts agree on.\n" +
  "2. Identify every material DISAGREEMENT ABOUT THE SUBJECT — differing conclusions, " +
  "conflicting facts, incompatible recommendations. Do NOT list process observations such as " +
  '"only one analyst finished" as disagreements; how many analysts reported is not a ' +
  "disagreement and is already shown to the user separately. For each real one, say which " +
  "position the evidence " +
  "better supports and why. Do not paper over conflicts — a real disagreement that you surface " +
  "is more valuable than a smooth answer that hides it.\n" +
  "3. Prefer claims backed by sources that were actually fetched. Treat an unsourced confident " +
  "claim as weaker than a sourced hedged one.\n" +
  "4. Note anything important that NO analyst covered, if you can tell.\n\n" +
  "Reply with a fenced ```json block containing exactly:\n" +
  '{"agreements": ["..."], "disagreements": [{"point": "...", "positions": ["..."]}]}\n' +
  "Then, after the block, write the final synthesized answer in markdown. Cite sources inline " +
  "as [n] matching the numbered source list you were given. The final answer must stand on its " +
  "own for someone who never sees the individual analyses.\n\n" +
  // The judge writes the answer the user actually reads, so if the question was
  // quantitative it is the judge that has to get the number right — including
  // adjudicating between analysts who computed different figures.
  QUANTITATIVE_INSTRUCTION;

async function runAgent(
  settings: KompassSettings,
  state: AgentState,
  question: string,
  depth: ResearchDepth,
  emit: () => void,
  signal?: AbortSignal,
  /** Overrides the seat's model — used for the lane-routing retry. */
  modelOverride?: string,
  /** Wall-clock this attempt may consume. */
  budgetMs: number = BUDGET.deep.agent,
): Promise<void> {
  const started = Date.now();
  const deadline = started + budgetMs;
  const { model, extraHeaders } = modelRequest(
    modelOverride ?? state.spec.model,
  );
  // Agents were answering from search snippets alone: 3 searches, 0 pages read,
  // zero sources. An answer with no fetched source is precisely what this
  // council must not produce, so it gets pushed back once before being allowed
  // to conclude.
  let nudgedForSources = false;
  let nudgedToFetch = false;
  const history: AnthropicMessageWire[] = [{ role: "user", content: question }];
  const seenUrls = new Set<string>();
  let totalIn = 0;
  let totalOut = 0;

  state.phase = "thinking";
  emit();

  for (let iter = 0; iter < DEPTH[depth].iterations; iter++) {
    // On the final step the tools are withheld, which forces a conclusion. Two
    // seats previously spent every step searching and returned only the stub
    // "Reached the research step limit" — a wasted seat and nothing for the
    // judge to weigh. A grounded-in-what-you-have answer is always better.
    // Out of time. An agent that has already gathered something keeps it — a
    // partial finding still informs the judge — but one that has produced
    // nothing throws, so the caller can retry it on a different model.
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      if (!state.answer && state.sources.length === 0)
        throw new KompassTimeoutError(budgetMs);
      break;
    }
    const lastStep = iter === DEPTH[depth].iterations - 1;
    const { response, servedBy, exhausted } = await sendMessage(
      settings,
      {
        model,
        max_tokens: 4096,
        system: agentSystemPrompt(depth),
        messages: lastStep
          ? [
              ...history,
              {
                role: "user" as const,
                content:
                  "Stop researching now and give your final answer, grounded in the sources you " +
                  "actually fetched. If you fetched none, say so explicitly and answer with " +
                  "clearly-flagged low confidence.",
              },
            ]
          : history,
        ...(lastStep ? {} : { tools: TOOLS }),
      },
      signal,
      extraHeaders,
      // Never let one call outlive the seat's whole budget.
      Math.min(REQUEST_TIMEOUT_MS, remaining),
    );
    // No model served this turn. The gateway says so with a 200 and a notice,
    // which is right for Claude Code and wrong for a council: rendering that
    // notice as an agent's "finding" is worse than showing no agent at all.
    if (exhausted) {
      throw new Error(
        "No free model could serve this agent (gateway lanes exhausted). " +
          "Fewer agents, fast mode, or a different model per seat usually clears it.",
      );
    }
    state.servedBy = servedBy;
    totalIn += response.usage.input_tokens;
    totalOut += response.usage.output_tokens;
    state.usage = { input: totalIn, output: totalOut };

    let toolUses = response.content.filter(
      (b): b is AnthropicToolUseBlockWire => b.type === "tool_use",
    );

    // Chat and Research recover tool calls a model printed as prose; the
    // Council did not, so a seat that printed its web_fetch call as JSON handed
    // that JSON to the judge as its finding — and the judge weighed it as an
    // opinion. Same models, same failure, so the same recovery applies.
    if (toolUses.length === 0 && !lastStep) {
      const recovered = recoverToolCalls(
        response.content
          .filter((b): b is AnthropicTextBlockWire => b.type === "text")
          .map((b) => b.text)
          .join("\n\n"),
        TOOL_NAMES,
      );
      if (recovered.calls.length > 0) {
        toolUses = recovered.calls;
        response.content = [
          ...(recovered.text
            ? [{ type: "text" as const, text: recovered.text }]
            : []),
          ...recovered.calls,
        ];
      }
    }

    if (toolUses.length === 0) {
      const draft =
        response.content
          .filter((b): b is AnthropicTextBlockWire => b.type === "text")
          .map((b) => b.text)
          .join("\n\n") || "(no answer)";

      if (
        state.sources.length === 0 &&
        !nudgedForSources &&
        iter < DEPTH[depth].iterations - 1
      ) {
        nudgedForSources = true;
        history.push({ role: "assistant", content: response.content });
        history.push({
          role: "user",
          content:
            "You have not fetched a single source yet — search snippets alone are not enough to " +
            "answer on. Pick the most promising result and call web_fetch on it, then answer " +
            "grounded in what you actually read.",
        });
        state.phase = "thinking";
        emit();
        continue;
      }

      state.answer = draft;
      state.phase = "done";
      state.detail = undefined;
      state.elapsedMs = Date.now() - started;
      emit();
      return;
    }

    history.push({ role: "assistant", content: response.content });
    const results: AnthropicToolResultBlockWire[] = [];
    for (const call of toolUses) {
      results.push(
        await executeTool(
          call,
          state.sources,
          seenUrls,
          {
            onSearch: (q) => {
              state.phase = "searching";
              state.detail = q;
              state.searches++;
              emit();
            },
            onFetch: (u) => {
              state.phase = "reading";
              state.detail = u;
              emit();
            },
            onData: (kind, q) => {
              state.phase = "reading";
              state.detail = `${kind}: ${q}`;
              emit();
            },
            onRead: () => {
              state.reads++;
              emit();
            },
          },
          signal,
        ),
      );
    }
    history.push({ role: "user", content: results });

    // Searching repeatedly without ever fetching is the observed failure mode:
    // three searches, zero pages, no answer. The earlier nudge only fired when
    // a model tried to CONCLUDE unsourced, which these never reached.
    if (state.searches >= 2 && state.reads === 0 && !nudgedToFetch) {
      nudgedToFetch = true;
      history.push({
        role: "user",
        content:
          "You have searched more than once and fetched nothing. Stop searching. Call web_fetch " +
          "on the most promising URL you have already seen, and read it before answering.",
      });
    }
    state.phase = "thinking";
    state.detail = undefined;
    emit();
  }

  // Out of iterations or out of time: keep whatever was gathered rather than
  // discarding the agent entirely — partial evidence still informs the judge.
  const ranOut = Date.now() >= deadline ? "time" : "step";
  state.answer =
    state.answer ??
    `Reached the research ${ranOut} limit before concluding. Partial findings only — ` +
      `treat with caution.`;
  state.phase = "done";
  state.elapsedMs = Date.now() - started;
  emit();
}

/**
 * Pull the judge's structure out, tolerating the usual model sloppiness.
 *
 * Only a fenced ```json block used to be accepted, so a judge that emitted the
 * same object unfenced — which several of the free models do — was scored as
 * unparseable and its RAW JSON was printed to the user as the final answer.
 * The fence is now one of two places to look, not the only one.
 */
export function parseJudge(text: string): {
  agreements: string[];
  disagreements: Disagreement[];
  answer: string;
  degraded: boolean;
} {
  for (const found of judgeJsonCandidates(text)) {
    let parsed: { agreements?: unknown; disagreements?: unknown };
    try {
      parsed = JSON.parse(found.json) as typeof parsed;
    } catch {
      continue; // a malformed block is not worth failing the whole run over
    }
    if (!parsed || typeof parsed !== "object") continue;
    const agreements = Array.isArray(parsed.agreements)
      ? parsed.agreements.filter((a): a is string => typeof a === "string")
      : [];
    const disagreements = Array.isArray(parsed.disagreements)
      ? parsed.disagreements
          .filter(
            (d): d is { point: unknown; positions: unknown } =>
              !!d && typeof d === "object",
          )
          .map((d) => ({
            point: typeof d.point === "string" ? d.point : "",
            positions: Array.isArray(d.positions)
              ? d.positions.filter((p): p is string => typeof p === "string")
              : [],
          }))
          .filter((d) => d.point)
      : [];
    if (agreements.length === 0 && disagreements.length === 0) continue;
    // Whatever surrounds the structure is the prose answer. Taking only the
    // tail meant a judge that wrote its answer BEFORE the block fell back to
    // showing the block itself.
    const answer = (
      text.slice(0, found.start) +
      "\n\n" +
      text.slice(found.end)
    ).trim();
    return { agreements, disagreements, answer: answer || text, degraded: false };
  }
  return { agreements: [], disagreements: [], answer: text, degraded: true };
}

/** Places the verdict structure might be, best first: fenced, then bare. */
function judgeJsonCandidates(
  text: string,
): { json: string; start: number; end: number }[] {
  const out: { json: string; start: number; end: number }[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let f: RegExpExecArray | null;
  while ((f = fence.exec(text)) !== null) {
    out.push({
      json: f[1]!.trim(),
      start: f.index,
      end: f.index + f[0].length,
    });
  }
  // Unfenced: anchor on the keys rather than on "{", since a judge's prose is
  // full of braces, and brace-match so nested positions[] cannot end it early.
  const anchor = /\{\s*"(?:agreements|disagreements)"\s*:/g;
  let a: RegExpExecArray | null;
  while ((a = anchor.exec(text)) !== null) {
    const raw = extractObject(text, a.index);
    if (raw) out.push({ json: raw, start: a.index, end: a.index + raw.length });
  }
  return out;
}

/**
 * Re-parse a stored verdict whose structure was missed when it was produced.
 *
 * A council run is persisted whole — verdict included — so a run judged by the
 * old fenced-block-only parser keeps its raw JSON answer forever, and fixing
 * the parser does nothing for it: nothing re-parses on load. Every council
 * conversation a user already has would still show the JSON. Applied on read,
 * so old runs heal the first time they are opened.
 */
export function healVerdict(run: CouncilRun | null): CouncilRun | null {
  const v = run?.verdict;
  if (!run || !v?.degraded || !v.answer) return run;
  const reparsed = parseJudge(v.answer);
  if (reparsed.degraded) return run; // genuinely unstructured — leave it alone
  return {
    ...run,
    verdict: {
      ...v,
      answer: reparsed.answer,
      agreements: reparsed.agreements,
      disagreements: reparsed.disagreements,
      degraded: false,
    },
  };
}

async function runJudge(
  settings: KompassSettings,
  judgeModel: string,
  question: string,
  agents: AgentState[],
  signal?: AbortSignal,
): Promise<CouncilVerdict> {
  // One numbered source list across the whole council, so the judge's inline
  // [n] citations resolve against something the UI can render.
  const sources: Source[] = [];
  const indexOf = new Map<string, number>();
  for (const a of agents) {
    for (const s of a.sources) {
      if (!indexOf.has(s.url)) {
        indexOf.set(s.url, sources.length + 1);
        sources.push(s);
      }
    }
  }

  const brief = agents
    .map((a) => {
      const cites =
        a.sources.map((s) => `[${indexOf.get(s.url)}] ${s.url}`).join("\n") ||
        "(none)";
      return `### ${a.spec.label} (model: ${a.servedBy ?? a.spec.model})\n\nSources actually read:\n${cites}\n\nAnswer:\n${a.answer ?? "(no answer)"}`;
    })
    .join("\n\n---\n\n");

  const sourceList =
    sources.map((s, i) => `[${i + 1}] ${s.url}`).join("\n") || "(none)";
  const { model, extraHeaders } = modelRequest(judgeModel);
  const { response, servedBy, exhausted } = await sendMessage(
    settings,
    {
      model,
      max_tokens: 4096,
      system: JUDGE_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Question:\n${question}\n\nNumbered sources available to cite:\n${sourceList}\n\nAnalyst reports:\n\n${brief}`,
        },
      ],
    },
    signal,
    extraHeaders,
    JUDGE_TIMEOUT_MS,
  );

  if (exhausted) {
    throw new Error(
      "No free model could serve the judge (gateway lanes exhausted). " +
        "The individual agent findings below are unaffected.",
    );
  }
  const text = response.content
    .filter((b): b is AnthropicTextBlockWire => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
  const parsed = parseJudge(text);
  // The judge is handed a numbered source list and asked to cite [n] against
  // it. Checking that the numbers resolve costs nothing and catches the case
  // where a verdict reads as fully sourced while pointing at nothing.
  const unbacked = unbackedCitations(parsed.answer, sources.length);
  return {
    answer: parsed.answer,
    agreements: parsed.agreements,
    disagreements: parsed.disagreements,
    sources,
    servedBy,
    degraded: parsed.degraded,
    notices: unbacked.length
      ? [
          `The verdict cites ${unbacked.map((n) => `[${n}]`).join(", ")}, which ` +
            `${unbacked.length === 1 ? "matches no source" : "match no sources"} ` +
            `any agent actually read.`,
        ]
      : undefined,
  };
}

/**
 * Run the judge, persistently.
 *
 * Exhaustion is the expected failure here, not a freak one: five seats research
 * in parallel and burn the free tier's per-minute allowance, and only THEN does
 * the judge ask for a model. Retrying instantly on another model — which is
 * what it used to do — asks the same drained providers the same question a
 * second later. So: several distinct models, with waits between them long
 * enough for a per-minute window to roll over.
 *
 * The research is the expensive part and it is already done. Failing to
 * synthesize must never throw it away.
 */
async function deliberate({
  settings,
  question,
  run,
  usable,
  judgeModel,
  candidates,
  emit,
  signal,
  waitsMs = JUDGE_RETRY_WAITS_MS,
}: {
  settings: KompassSettings;
  question: string;
  run: CouncilRun;
  usable: AgentState[];
  judgeModel: string;
  candidates: string[];
  emit: () => void;
  signal?: AbortSignal;
  /** Overridable so tests can exercise the retry ladder without waiting a
   *  minute for it; production always uses the real schedule. */
  waitsMs?: number[];
}): Promise<void> {
  // Distinct models first, then the lanes — a lane can still find something the
  // pinned entries cannot, because it walks its own chain.
  const attempts = [
    ...new Set([judgeModel, ...candidates, "kompass-agentic", "kompass-hard"]),
  ];
  // Nothing before the first attempt; a real pause before each retry. Free-tier
  // limits are per minute, so waiting is a genuine strategy rather than a stall.
  const waits = waitsMs;

  let lastError = "";
  for (let i = 0; i < attempts.length; i++) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (waits[i]) {
      run.judgeError =
        `${lastError} Waiting ${Math.round(waits[i]! / 1000)}s for quota to recover, ` +
        `then retrying on ${attempts[i]}…`;
      emit();
      await sleep(waits[i]!, signal);
    }
    try {
      run.verdict = await runJudge(
        settings,
        attempts[i]!,
        question,
        usable,
        signal,
      );
      run.judgePhase = "done";
      run.judgeError = undefined;
      emit();
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  // Every model refused. Rather than showing the user nothing, hand back the
  // best-evidenced analyst answer as a PROVISIONAL verdict, labelled as one.
  // Five researched answers and an error message is a worse outcome than five
  // researched answers and the strongest of them, clearly marked unsynthesized.
  run.judgePhase = "failed";
  run.judgeError = lastError || "The judge could not be run.";
  run.verdict = provisionalVerdict(usable);
  emit();
}

/** Abortable sleep — a pending retry must still respond to the stop button. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * A verdict assembled without a model, for when no model can be had.
 *
 * Explicitly NOT a synthesis, and says so: it is one analyst's answer, chosen
 * for having read the most pages, with every seat's sources behind it. Claiming
 * more than that would be the exact dishonesty the council exists to avoid.
 */
function provisionalVerdict(usable: AgentState[]): CouncilVerdict {
  const best = [...usable].sort(
    (a, b) => b.reads - a.reads || b.sources.length - a.sources.length,
  )[0]!;
  const sources: Source[] = [];
  const seen = new Set<string>();
  for (const a of usable)
    for (const s of a.sources)
      if (!seen.has(s.url)) {
        seen.add(s.url);
        sources.push(s);
      }
  return {
    answer: best.answer ?? "",
    agreements: [],
    disagreements: [],
    sources,
    servedBy: best.servedBy ?? best.spec.model,
    degraded: true,
    notices: [
      `No model could be reached to synthesize the ${usable.length} analyst answers, so this ` +
        `is ${best.spec.label}'s answer on its own — the seat that read the most pages ` +
        `(${best.reads}). It has NOT been weighed against the others, and no disagreement ` +
        `between them has been checked. Read the individual findings above, or retry the ` +
        `synthesis once quota recovers.`,
    ],
  };
}

export interface CouncilOptions {
  settings: KompassSettings;
  question: string;
  agents: AgentSpec[];
  judgeModel: string;
  /** Ranked spare models (councilPlanner), used when a seat's model is down. */
  alternates?: string[];
  depth: ResearchDepth;
  onUpdate: (run: CouncilRun) => void;
  signal?: AbortSignal;
}

export async function runCouncil({
  settings,
  question,
  agents,
  judgeModel,
  alternates = [],
  depth,
  onUpdate,
  signal,
}: CouncilOptions): Promise<CouncilRun> {
  // Every model currently spoken for. A replacement must come from outside it,
  // or the council quietly ends up with duplicate opinions.
  const inUse = new Set<string>([...agents.map((a) => a.model), judgeModel]);
  const spares = [...alternates];
  const claimSpare = (): string | undefined => {
    while (spares.length > 0) {
      const next = spares.shift()!;
      if (!inUse.has(next)) {
        inUse.add(next);
        return next;
      }
    }
    return undefined;
  };
  const run: CouncilRun = {
    agents: agents.map((spec) => ({
      spec,
      phase: "queued",
      searches: 0,
      reads: 0,
      sources: [],
    })),
    judgePhase: "waiting",
  };
  const emit = () =>
    onUpdate({ ...run, agents: run.agents.map((a) => ({ ...a })) });
  emit();

  // Staggered start. The seats still run concurrently, but launching five
  // research loops in the same instant collides with free-tier RPM ceilings
  // (OpenRouter is 20/min across ALL :free models) and the whole council can
  // come back exhausted. A short offset costs nothing perceptible and lets the
  // gateway's ledger pace them.
  const STAGGER_MS = 700;

  // Hard ceiling on the research phase. Without it the council is only as fast
  // as its slowest seat, and a seat that never returns means a run that never
  // ends — five analysts, two finished, and the page thinking for ten minutes.
  // The judge keeps the USER's signal, so abandoning the seats does not
  // abandon the synthesis of what they did produce.
  const seats = new AbortController();
  const onUserAbort = () => seats.abort(signal?.reason);
  signal?.addEventListener("abort", onUserAbort, { once: true });
  let hardStopped = false;
  const ceiling = setTimeout(() => {
    hardStopped = true;
    seats.abort(new KompassTimeoutError(BUDGET[depth].run));
  }, BUDGET[depth].run);
  const agentSignal = seats.signal;

  // allSettled, not all: a rejected agent must not take down the council.
  await Promise.allSettled(
    run.agents.map(async (state, i) => {
      try {
        if (i > 0) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, i * STAGGER_MS);
            agentSignal.addEventListener("abort", () => {
              clearTimeout(t);
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        }
        await runAgent(
          settings,
          state,
          question,
          depth,
          emit,
          agentSignal,
          undefined,
          BUDGET[depth].agent,
        );
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          state.phase = "failed";
          // The seats' signal aborts for two different reasons and the user
          // deserves to know which: they pressed stop, or this seat was still
          // thinking when the council's ceiling ran out.
          state.error = hardStopped
            ? `Abandoned after ${Math.round(BUDGET[depth].run / 1000)}s — the council ` +
              `stopped waiting so the judge could work with the seats that finished.`
            : "cancelled";
          state.detail = undefined;
          emit();
          throw e;
        }
        // Pinning a model via x-kompass-model gives the gateway a chain of
        // exactly ONE entry, so a transient cooldown on that model kills the
        // seat outright — the router's whole fallback ladder is bypassed. Retry
        // once on lane routing: a seat that answers on a different model is far
        // better than an empty chair, and the card says it fell back.
        // A timed-out seat earns a retry whether or not it was pinned: the
        // model it landed on is demonstrably not answering this question, and a
        // different one is the only thing left to try. Previously only pinned
        // seats retried, so a lane-routed seat that hung was simply lost.
        const pinned = !state.spec.model.startsWith("kompass");
        const timedOut = e instanceof KompassTimeoutError;
        if ((pinned || timedOut) && !state.fellBack && !hardStopped) {
          state.fellBack = true;
          state.error = undefined;
          state.sources = [];
          state.searches = 0;
          state.reads = 0;
          // A distinct unused model if one is available; lane routing only as a
          // last resort, since the gateway could otherwise pick a model another
          // seat is already running.
          const replacement = claimSpare();
          state.replacedWith = replacement;
          emit();
          try {
            await runAgent(
              settings,
              state,
              question,
              depth,
              emit,
              agentSignal,
              replacement ?? "kompass-agentic",
              BUDGET[depth].retry,
            );
            return;
          } catch (e2) {
            if (e2 instanceof DOMException && e2.name === "AbortError")
              throw e2;
            state.error = e2 instanceof Error ? e2.message : String(e2);
          }
        } else {
          state.error = e instanceof Error ? e.message : String(e);
        }
        state.phase = "failed";
        state.detail = undefined;
        emit();
      }
    }),
  );

  clearTimeout(ceiling);
  signal?.removeEventListener("abort", onUserAbort);
  // The ceiling firing must NOT end the run — that is the whole point of it.
  // Only the user pressing stop does.
  if (signal?.aborted) return run;
  if (hardStopped) {
    for (const a of run.agents) {
      if (a.phase !== "done" && a.phase !== "failed") {
        a.phase = "failed";
        a.detail = undefined;
        a.error =
          a.error ??
          `Still researching when the council's ${Math.round(BUDGET[depth].run / 1000)}s ` +
            `limit was reached.`;
      }
    }
    emit();
  }

  const usable = run.agents.filter((a) => a.phase === "done" && a.answer);
  if (usable.length === 0) {
    run.judgePhase = "failed";
    run.judgeError = "Every agent failed — nothing to synthesize.";
    emit();
    return run;
  }

  run.judgePhase = "deliberating";
  emit();
  await deliberate({
    settings,
    question,
    run,
    usable,
    judgeModel,
    candidates: [claimSpare(), claimSpare()].filter(
      (m): m is string => typeof m === "string",
    ),
    emit,
    signal,
  });
  emit();
  return run;
}

/**
 * Re-run synthesis on a finished run, without repeating the research.
 *
 * The seats are the expensive part — five models, minutes of wall clock, real
 * quota. When only the judge fails, making the user convene the whole council
 * again to recover from a transient per-minute limit would be absurd. This
 * re-judges the answers already on the run.
 */
export async function retryJudge(
  settings: KompassSettings,
  question: string,
  run: CouncilRun,
  judgeModel: string,
  onUpdate: (run: CouncilRun) => void,
  signal?: AbortSignal,
  waitsMs?: number[],
): Promise<CouncilRun> {
  const next: CouncilRun = { ...run, agents: run.agents.map((a) => ({ ...a })) };
  const usable = next.agents.filter((a) => a.phase === "done" && a.answer);
  const emit = () =>
    onUpdate({ ...next, agents: next.agents.map((a) => ({ ...a })) });
  if (usable.length === 0) {
    next.judgePhase = "failed";
    next.judgeError = "No analyst answers to synthesize.";
    emit();
    return next;
  }
  next.judgePhase = "deliberating";
  next.judgeError = undefined;
  // Drop the provisional verdict: keeping it on screen while a real one is
  // being produced would show two different answers at once.
  next.verdict = undefined;
  emit();
  await deliberate({
    settings,
    question,
    run: next,
    usable,
    judgeModel,
    candidates: [],
    emit,
    signal,
    waitsMs,
  });
  emit();
  return next;
}
