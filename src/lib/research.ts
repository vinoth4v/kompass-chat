// The agentic turn: a client-driven Anthropic tool-use loop against Kompass.
//
// The model turns go straight to the user's own Kompass Worker (cross-origin
// fetch, bearer in the Authorization header); the two tools it can call are
// executed by this app's own Vercel serverless routes (/api/tools/*), since a
// browser fetch to duckduckgo.com or an arbitrary site would hit CORS. No
// bash/filesystem tools here — that's what the local `kompass ui` is for.
//
// Chat and Research are the SAME loop with different prompts and budgets.
// They were two near-identical copies, and they had already drifted in three
// ways that each cost the user something real: research dropped generated
// documents on one exit path, only chat stripped the FOLLOWUPS marker, and only
// chat withheld tools on the final step. One loop cannot drift from itself.
import { recoverToolCalls } from "./recoverToolCall";
import { unfitModelReplacement } from "./modelFitness";
import {
  CONCLUDE_SYSTEM_PROMPT,
  chatSystemPrompt,
  researchSystemPrompt,
} from "./prompts";
import {
  modelRequest,
  sendMessage,
  type AnthropicMessageWire,
  type AnthropicTextBlockWire,
  type AnthropicToolResultBlockWire,
  type AnthropicToolUseBlockWire,
} from "./kompassClient";
import type { KompassSettings } from "./types";
import {
  TOOL_NAMES,
  TOOLS,
  executeTool,
  type GeneratedDocument,
  type Source,
} from "./tools";

/** Pull the FOLLOWUPS line out of a reply and return the cleaned text. */
export function extractFollowups(text: string): {
  text: string;
  followups?: string[];
} {
  // Deliberately loose. Models wrap the marker in bold, prefix it with a
  // bullet or a horizontal rule, and occasionally spell it "Follow-ups". A
  // marker that leaks into the visible answer is worse than no chips at all.
  const m = /^[ \t>*_-]*\**\s*follow[\s-]?ups?\**\s*:\s*\**[ \t]*(.+)$/im.exec(
    text,
  );
  if (!m) return { text };
  const followups = (m[1] ?? "")
    .split("|")
    .map((q) => q.trim().replace(/^[-*\d.\s]+/, ""))
    .filter((q) => q.length > 3 && q.length < 160)
    .slice(0, 3);
  const cleaned = (
    text.slice(0, m.index) + text.slice(m.index + m[0].length)
  ).trimEnd();
  return { text: cleaned, followups: followups.length ? followups : undefined };
}

/**
 * Citation numbers the answer used that no source backs.
 *
 * Free models cite [3] in an answer built on two sources often enough that it
 * is worth checking mechanically. The user is told; the number is not silently
 * removed, because rewriting a model's answer to look better sourced than it is
 * would be exactly the wrong fix.
 */
export function unbackedCitations(text: string, sourceCount: number): number[] {
  const bad = new Set<number>();
  // Skip markdown links — "[1]: http://…" and "[see](url)" are not citations.
  for (const m of text.matchAll(/\[(\d{1,2})\](?!\()/g)) {
    const n = Number(m[1]);
    if (n < 1 || n > sourceCount) bad.add(n);
  }
  return [...bad].sort((a, b) => a - b);
}

const MAX_ITERATIONS = 6;
const CHAT_MAX_ITERATIONS = 4;

/**
 * 4096 was too small for the open-weight models that think in the OUTPUT
 * channel rather than in a separate reasoning field. Asked a multi-step finance
 * question, one spent the entire budget deliberating and was cut off
 * mid-sentence, having never stated a number. Room to think and then answer.
 */
const MAX_TOKENS = 8192;

/**
 * Some models wrap their scratchpad in tags; some just start typing it.
 * Tagged reasoning is removed outright — it is addressed to the model, not to
 * the reader, and no user asked to watch a model talk itself through a problem.
 */
export function stripReasoning(text: string): string {
  return text
    .replace(
      /<(think|thinking|reason|reasoning|scratchpad|analysis)>[\s\S]*?<\/\1>/gi,
      "",
    )
    // An unclosed opening tag means the reply was cut off mid-thought:
    // everything after it is scratchpad that never reached a conclusion.
    .replace(/<(think|thinking|reason|reasoning|scratchpad|analysis)>[\s\S]*$/i, "")
    .trim();
}

/**
 * Did the model narrate its deliberation instead of answering?
 *
 * Detected rather than assumed, because the fix costs a request. The signature
 * is first-person planning language ("we need to", "let's compute", "wait") in
 * a long reply — the observed failure had a dozen such markers and no result.
 */
export function looksLikeScratchpad(text: string): boolean {
  if (text.length < 900) return false;
  const markers =
    /\b(we need to|we could|let'?s (?:try|compute|define|attempt|denote|just)|let me (?:try|compute|think)|actually,? |wait[,.]? |hmm|i'?ll assume|maybe we|but we need|confusion|tedious|let'?s attempt)/gi;
  const hits = [...text.matchAll(markers)].length;
  // Trailing "?" or an unfinished clause after all that planning means it never
  // landed. Two independent signals rather than one, to avoid flagging an
  // answer that merely explains its reasoning cleanly.
  const unfinished = /[,;:(]\s*$|\b(let'?s|we|actually)\s*$/i.test(text.trim());
  return hits >= 4 || (hits >= 2 && unfinished);
}

/**
 * The only tool still offered on the final step.
 *
 * The research tools are withheld so the turn ends in an answer rather than
 * another search, but create_document stays: if the user asked for a file, the
 * file IS the answer, and withholding it is what produced "Research took too
 * many steps" instead of a PDF.
 */
const DOCUMENT_ONLY_TOOLS = TOOLS.filter((t) => t.name === "create_document");

export interface ResearchResult {
  text: string;
  /** Files create_document produced during this turn. */
  documents?: GeneratedDocument[];
  /** Suggested next questions, stripped out of the reply text. */
  followups?: string[];
  sources: Source[];
  /**
   * Things the user should know about HOW this answer was produced — a search
   * that failed, an answer that was cut off, a citation with nothing behind it.
   * Rendered above the answer rather than hidden in a tool result.
   */
  notices?: string[];
  usage: { input: number; output: number };
  servedBy: string | null;
  lane: string | null;
}

interface LoopConfig {
  system: string;
  maxIterations: number;
  /**
   * Push back once when the model tries to conclude having read nothing. Only
   * research mode, where the user explicitly asked for researched sources —
   * in chat, "what's a closure in JavaScript" needs no citation.
   */
  requireSources: boolean;
  /**
   * Re-run the first step if lane routing lands on a model unfit for the work
   * (see modelFitness). Worth one discarded step in a tool-using loop; not
   * worth it for a one-shot reply.
   */
  requireFitModel: boolean;
}

const textOf = (blocks: { type: string }[]): string =>
  (blocks as AnthropicTextBlockWire[])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");

async function runLoop(
  settings: KompassSettings,
  lane: string,
  conversation: AnthropicMessageWire[],
  config: LoopConfig,
  signal?: AbortSignal,
  sessionId?: string,
): Promise<ResearchResult> {
  const history: AnthropicMessageWire[] = [...conversation];
  const sources: Source[] = [];
  const documents: GeneratedDocument[] = [];
  const seenUrls = new Set<string>();
  const toolErrors: string[] = [];
  /** Any attempt to reach the outside world — search, fetch or data lookup.
   *  Counting only searches missed the turn where get_news was the sole
   *  attempt and it failed. */
  let retrievals = 0;
  let calculations = 0;
  let totalIn = 0;
  let totalOut = 0;
  let servedBy: string | null = null;
  let servedLane: string | null = null;
  let truncated = false;
  let nudgedForSources = false;
  /** Set when the gateway's first pick was not fit for the work — see below. */
  let pin: string | undefined;
  let repinned = false;
  const carried: string[] = [];

  /** Assembled at every exit so both endings report the same way. */
  const finish = async (
    raw: string,
    fallback: string,
  ): Promise<ResearchResult> => {
    let body = stripReasoning(raw);

    // The reply is the model's working, not an answer: it was cut off before
    // concluding, or it narrated its deliberation and never landed. One more
    // request turns that working into the answer the user asked for. This is
    // the difference between "here is 2,000 words of me thinking about your
    // portfolio question" and a number.
    if (body && (truncated || looksLikeScratchpad(body))) {
      try {
        const wire = modelRequest(pin ?? lane);
        const { response } = await sendMessage(
          settings,
          {
            model: wire.model,
            max_tokens: MAX_TOKENS,
            ...(sessionId ? { metadata: { user_id: sessionId } } : {}),
            system: CONCLUDE_SYSTEM_PROMPT,
            messages: [
              ...conversation,
              // Only the tail: the conclusion lives at the end of a scratchpad,
              // and the head is what made it too long in the first place.
              { role: "assistant", content: body.slice(-8000) },
              {
                role: "user",
                content:
                  "That was your working, not an answer. Give the final answer now, in full, " +
                  "as if for the first time.",
              },
            ],
          },
          signal,
          wire.extraHeaders,
        );
        totalIn += response.usage.input_tokens;
        totalOut += response.usage.output_tokens;
        const concluded = stripReasoning(textOf(response.content));
        if (concluded.length > 40 && !looksLikeScratchpad(concluded)) {
          body = concluded;
          truncated = response.stop_reason === "max_tokens";
          carried.push(
            "The model's first reply was its working rather than an answer, so it was asked " +
              "to state the conclusion. What you see is that second pass.",
          );
        }
      } catch {
        // Keep the working. It is poor, but it is what was actually produced,
        // and the notices below say so.
      }
    }

    const { text, followups } = extractFollowups(body);
    const notices: string[] = [...carried];
    if (truncated)
      notices.push(
        "The model hit its output limit — this answer is cut off, not finished.",
      );
    if (looksLikeScratchpad(text))
      notices.push(
        "This reply reads as the model thinking aloud rather than answering. " +
          "Ask it to state the final result, or try a different lane.",
      );
    // In research mode an unsourced answer is always worth flagging, even if
    // the model never tried to search — that is the mode's entire promise. In
    // chat, only flag it when a search was actually attempted and came back
    // empty; "explain closures" needs no source and no warning.
    // A question answered purely by calculation is self-contained: it needs no
    // source, and warning about one would train the user to ignore the warning.
    const selfContained = retrievals === 0 && calculations > 0;
    if (
      sources.length === 0 &&
      !selfContained &&
      (retrievals > 0 || config.requireSources)
    )
      notices.push(
        "No source was read for this answer" +
          (toolErrors.length ? ` (${toolErrors[0]})` : "") +
          " — it comes from the model's own knowledge, which may be out of date.",
      );
    const unbacked = unbackedCitations(text, sources.length);
    if (unbacked.length > 0)
      notices.push(
        `The answer cites ${unbacked.map((n) => `[${n}]`).join(", ")}, which ` +
          `${unbacked.length === 1 ? "matches no source" : "match no sources"} that were ` +
          `actually read. Treat ${unbacked.length === 1 ? "that claim" : "those claims"} as unverified.`,
      );
    return {
      text: text || fallback,
      followups,
      documents: documents.length ? documents : undefined,
      sources,
      notices: notices.length ? notices : undefined,
      usage: { input: totalIn, output: totalOut },
      servedBy,
      lane: servedLane,
    };
  };

  // `iter` advances explicitly rather than in a for-header: the fitness check
  // below re-runs the first step on a different model without consuming one.
  let iter = 0;
  while (iter < config.maxIterations) {
    const lastStep = iter === config.maxIterations - 1;
    const wire = modelRequest(pin ?? lane);
    const {
      response,
      servedBy: sb,
      lane: ln,
      exhausted,
    } = await sendMessage(
      settings,
      {
        model: wire.model,
        max_tokens: MAX_TOKENS,
        ...(sessionId ? { metadata: { user_id: sessionId } } : {}),
        system: config.system,
        messages: history,
        tools: lastStep ? DOCUMENT_ONLY_TOOLS : TOOLS,
      },
      signal,
      wire.extraHeaders,
    );
    // The gateway answers 200 with a synthetic "no model could serve this"
    // notice, which is right for Claude Code and wrong here: rendering it as
    // the assistant's reply presents a routing failure as an answer. The
    // Council has always checked this; chat and research did not.
    if (exhausted) {
      throw new Error(
        "No free model could serve this request (gateway lanes exhausted). " +
          "Try a different lane, or wait for the free-tier quotas to reset.",
      );
    }
    servedBy = sb;
    servedLane = ln;
    totalIn += response.usage.input_tokens;
    totalOut += response.usage.output_tokens;
    if (response.stop_reason === "max_tokens") truncated = true;

    // Is the model the gateway picked actually fit for this work? Vision
    // fallbacks are in the lane chains to read images, not to research: seated
    // on a research question, one searched once, ignored the instruction to
    // fetch, and answered from memory. The Council refuses to seat them; lane
    // routing can still hand one a research turn, so catch it here.
    //
    // Checked on the FIRST step only. The gateway pins a conversation to one
    // model (metadata.user_id), so the model that answers step one is the model
    // for the whole turn — and one discarded step is a far cheaper correction
    // than six.
    if (iter === 0 && !repinned && sb && config.requireFitModel) {
      const replacement = await unfitModelReplacement(settings, sb);
      if (replacement) {
        repinned = true;
        pin = replacement;
        carried.push(
          `${sb} is a vision model and researches poorly, so this answer was re-run on ${replacement}.`,
        );
        history.length = 0;
        history.push(...conversation);
        continue; // same step, different model
      }
    }

    let toolUses = response.content.filter(
      (b): b is AnthropicToolUseBlockWire => b.type === "tool_use",
    );

    // Some open-weight models print the call instead of making it. Asked for a
    // PDF, one emitted a complete create_document call as JSON prose — the user
    // saw the JSON and got no document. Recover the intent rather than showing
    // the plumbing. Only tools offered on this turn are eligible to run.
    if (toolUses.length === 0) {
      const recovered = recoverToolCalls(textOf(response.content), TOOL_NAMES);
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
      const raw = textOf(response.content);
      // An answer that read nothing, in the mode whose whole promise is that it
      // reads things. Push back once — the Council has done this since it was
      // caught answering from search snippets alone, and it works.
      if (
        config.requireSources &&
        sources.length === 0 &&
        !nudgedForSources &&
        !lastStep
      ) {
        nudgedForSources = true;
        history.push({ role: "assistant", content: response.content });
        history.push({
          role: "user",
          content:
            "You have not read a single source yet. Search, then call web_fetch on the most " +
            "promising result and answer grounded in what you actually read. If the tools are " +
            "failing, say so plainly instead of answering from memory.",
        });
        iter++; // the nudge costs a step, unlike the re-pin above
        continue;
      }
      return finish(raw, "(no answer)");
    }

    history.push({ role: "assistant", content: response.content });
    const toolResults: AnthropicToolResultBlockWire[] = [];
    for (const call of toolUses) {
      toolResults.push(
        await executeTool(
          call,
          sources,
          seenUrls,
          {
            onDocument: (d) => documents.push(d),
            onSearch: () => retrievals++,
            onFetch: () => retrievals++,
            onData: () => retrievals++,
            onCalculate: () => calculations++,
            onToolError: (tool, message) =>
              toolErrors.push(`${tool}: ${message}`),
          },
          signal,
        ),
      );
    }

    if (lastStep) {
      // Only create_document was on offer, so run it for its file and answer
      // with whatever text came alongside. Looping again would exceed the
      // ceiling and discard the document the user actually asked for.
      return finish(
        textOf(response.content),
        documents.length
          ? "Here is the document you asked for."
          : "I ran out of research steps before producing an answer. Try asking again, " +
              "or narrow the question — the model kept calling tools without concluding.",
      );
    }
    history.push({ role: "user", content: toolResults });
    iter++;
  }

  // Unreachable: the final iteration always returns. Kept so the function has
  // one type-level exit rather than an implicit undefined.
  return finish(
    "",
    "I ran out of research steps before producing an answer. Try asking again, " +
      "or narrow the question — the model kept calling tools without concluding.",
  );
}

/**
 * Research mode: search, read, then answer from what was actually read.
 * Takes the full conversation, so attached files travel with the question —
 * previously this took the question TEXT only, which silently discarded every
 * attachment before the request was built.
 */
export async function runResearch(
  settings: KompassSettings,
  lane: string,
  conversation: AnthropicMessageWire[],
  signal?: AbortSignal,
  sessionId?: string,
): Promise<ResearchResult> {
  return runLoop(
    settings,
    lane,
    conversation,
    {
      system: researchSystemPrompt(),
      maxIterations: MAX_ITERATIONS,
      requireSources: true,
      requireFitModel: true,
    },
    signal,
    sessionId,
  );
}

/**
 * Chat with optional web access. Same tools and same ground-truth citation rule
 * as research mode — a source is recorded only when a fetch actually succeeds —
 * but the model decides whether to use them at all, so ordinary conversation
 * costs exactly one request as before.
 */
export async function runChatWithTools(
  settings: KompassSettings,
  lane: string,
  history: AnthropicMessageWire[],
  signal?: AbortSignal,
  /** Conversation id — pins the whole chat to one model (see SendMessageRequest). */
  sessionId?: string,
): Promise<ResearchResult> {
  return runLoop(
    settings,
    lane,
    history,
    {
      system: chatSystemPrompt(),
      maxIterations: CHAT_MAX_ITERATIONS,
      requireSources: false,
      requireFitModel: true,
    },
    signal,
    sessionId,
  );
}
