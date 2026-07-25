// The one tool surface shared by Chat, Research and the AI Council.
//
// Previously each mode carried its own copy of the tool definitions and its own
// executor, so a capability added to research silently did not exist in chat or
// the council. One definition, one executor, three modes.
//
// Tool COUNT is kept deliberately small. These are free models with modest
// tool-calling ability; every extra tool measurably degrades their choice of
// which to call. So the structured sources are multiplexed behind one
// `get_data` tool with a `kind` argument rather than exposed as six tools.
//
// Citation rule, unchanged and load-bearing: a source is recorded only when a
// fetch or a data lookup actually SUCCEEDS. Nothing is ever cited because a
// model said it read it.
import { evaluate, formatResult } from "./calc";
import type { DocFormat, DocSection } from "./documents";
import type {
  AnthropicToolResultBlockWire,
  AnthropicToolUseBlockWire,
  AnthropicToolWire,
} from "./kompassClient";

export interface Source {
  title: string;
  url: string;
}

export const TOOLS: AnthropicToolWire[] = [
  {
    name: "web_search",
    description:
      "Search the web. Returns a list of results with title, url and snippet. Use for general " +
      "questions, background, and finding pages worth reading.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch a URL and return its main page text. Use this to actually READ a promising search " +
      "result — a snippet alone is not enough to answer on.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL to fetch" },
      },
      required: ["url"],
    },
  },
  {
    name: "get_news",
    description:
      "Current news headlines with publication dates and outlets (Google News). Use for anything " +
      "recent, breaking, or where being out of date would mislead — this is far more reliable " +
      "than recalling events from memory.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "News topic, person, company or event",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_data",
    description:
      "Look up an exact, current fact from an authoritative source. Prefer this over web_search " +
      "whenever it applies — it returns the number itself rather than a page to interpret. " +
      "kind=weather (forecast for a place), sports (live scores/fixtures for a league such as " +
      'NBA/NFL/premier/bundesliga, or a team profile), fx (currency rate, e.g. "EUR to USD"), ' +
      'crypto (coin price by CoinGecko id, e.g. "bitcoin"), stock (quote by ticker, e.g. "AAPL"), ' +
      'macro (World Bank indicator, e.g. "DE NY.GDP.MKTP.CD").',
    input_schema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["weather", "sports", "fx", "crypto", "stock", "macro"],
          description: "Which structured source to query",
        },
        query: {
          type: "string",
          description: "Place, league, team, currency pair, coin or ticker",
        },
      },
      required: ["kind", "query"],
    },
  },
  {
    name: "calculate",
    description:
      "Evaluate a mathematical expression exactly. Use this for EVERY non-trivial calculation — " +
      "compound interest, growth over time, percentages, unit conversions, statistics — rather " +
      "than working the arithmetic out in your reply, which is where numeric answers go wrong. " +
      "Operators + - * / % ^ and parentheses; functions exp, ln, log10, sqrt, abs, pow, min, " +
      "max, round(x,d), floor, ceil, mod, sin, cos, tan; constants pi and e. " +
      "Series are supported: sum(k, from, to, expression) and prod(k, from, to, expression) " +
      'bind k over an inclusive range — e.g. sum(k, 0, 359, 1500 * 1.025^floor(k/12)) totals a ' +
      "monthly payment that rises 2.5% a year for 30 years. Call it repeatedly to build a " +
      "result up in steps; do not round between steps.",
    input_schema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "The expression to evaluate, e.g. 100000 * exp(0.07 * 30)",
        },
      },
      required: ["expression"],
    },
  },
  {
    name: "create_document",
    description:
      "Produce a downloadable PDF, Word (docx), PowerPoint (pptx) or Excel (xlsx) file. Use this " +
      "whenever the user asks for a document, report, deck, spreadsheet or anything to download. " +
      "Supply STRUCTURE, not formatting: headings, paragraphs, bullets and tables. Layout, " +
      "typography and colour are applied for you, so do not attempt markdown or styling inside " +
      "the text. Prefer tables for anything tabular, especially for xlsx where each table becomes " +
      "its own sheet. Write the real content — a document containing placeholders is worthless.",
    input_schema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["pdf", "docx", "pptx", "xlsx"],
          description:
            "pdf/docx for reports, pptx for slide decks, xlsx for tabular data",
        },
        title: { type: "string", description: "Document title" },
        subtitle: {
          type: "string",
          description: "Optional one-line subtitle or date",
        },
        sections: {
          type: "array",
          description:
            "Ordered content. For pptx each section becomes one slide, for xlsx each section " +
            "with a table becomes one sheet.",
          items: {
            type: "object",
            properties: {
              heading: { type: "string" },
              paragraphs: { type: "array", items: { type: "string" } },
              bullets: { type: "array", items: { type: "string" } },
              table: {
                type: "object",
                properties: {
                  headers: { type: "array", items: { type: "string" } },
                  rows: {
                    type: "array",
                    items: { type: "array", items: { type: "string" } },
                  },
                },
                required: ["headers", "rows"],
              },
              notes: {
                type: "string",
                description: "Speaker notes (pptx only)",
              },
            },
          },
        },
      },
      required: ["format", "title", "sections"],
    },
  },
  {
    name: "get_reference",
    description:
      "Look something up in an authoritative register. Use instead of web_search when the " +
      "question is about a known entity, record or publication. " +
      "kind=pubmed (biomedical papers), drug (US FDA drug label: indications, dosage, warnings), " +
      "trials (ClinicalTrials.gov studies), quakes (recent earthquakes, query = minimum " +
      "magnitude), book (Open Library), country (population/capital/currency/languages), " +
      'package (npm by name, or "py <name>" for PyPI: version, license, description), ' +
      "cve (published security vulnerabilities by keyword), food (product nutrition), " +
      "entity (Wikidata facts about a person/place/thing), music (MusicBrainz artists).",
    input_schema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [
            "pubmed",
            "drug",
            "trials",
            "quakes",
            "book",
            "country",
            "package",
            "cve",
            "food",
            "entity",
            "music",
          ],
          description: "Which register to query",
        },
        query: { type: "string", description: "Search term for that register" },
      },
      required: ["kind", "query"],
    },
  },
];

/** Hooks so the Council can drive its live agent cards from the same executor. */
/** Formats renderDocument can actually produce — gates model-supplied input. */
const DOC_FORMATS = new Set<DocFormat>(["pdf", "docx", "pptx", "xlsx"]);

/** A file produced by create_document, surfaced to the UI for download. */
export interface GeneratedDocument {
  filename: string;
  mime: string;
  /** Object URL — created in the browser, never uploaded anywhere. */
  url: string;
  format: string;
  bytes: number;
}

export interface ToolHooks {
  /** Fired when create_document produces a file. */
  onDocument?: (doc: GeneratedDocument) => void;
  onSearch?: (query: string) => void;
  onFetch?: (url: string) => void;
  onData?: (kind: string, query: string) => void;
  onCalculate?: (expression: string) => void;
  /** Fired only on a SUCCESSFUL read — the moment a citation becomes honest. */
  onRead?: () => void;
  /**
   * Fired when a tool fails. The model is told, but the USER was not: a turn
   * where every search backend refused looked identical to a well-researched
   * one, because the only difference was inside a tool result nobody sees.
   */
  onToolError?: (tool: string, message: string) => void;
}

interface SearchResultJson {
  results?: { title: string; url: string; snippet: string }[];
  backend?: string;
  error?: string;
}
interface FetchResultJson {
  text?: string;
  title?: string;
  finalUrl?: string;
  truncated?: boolean;
  error?: string;
}
interface DataResultJson {
  text?: string;
  source?: string;
  error?: string;
}

const err = (
  call: AnthropicToolUseBlockWire,
  msg: string,
  hooks: ToolHooks = {},
): AnthropicToolResultBlockWire => {
  hooks.onToolError?.(call.name, msg);
  return {
    type: "tool_result",
    tool_use_id: call.id,
    content: msg,
    is_error: true,
  };
};

/**
 * Record a source and return its 1-based citation index.
 *
 * One place decides what counts as a citation, so the numbering the model is
 * given and the numbering the user sees are the same list by construction.
 * A URL already read keeps its original number rather than gaining a second.
 */
function cite(
  sources: Source[],
  seenUrls: Set<string>,
  hooks: ToolHooks,
  source: Source,
): number {
  const existing = sources.findIndex((s) => s.url === source.url);
  if (existing >= 0) return existing + 1;
  seenUrls.add(source.url);
  sources.push(source);
  hooks.onRead?.();
  return sources.length;
}

export async function executeTool(
  call: AnthropicToolUseBlockWire,
  sources: Source[],
  seenUrls: Set<string>,
  hooks: ToolHooks = {},
  signal?: AbortSignal,
): Promise<AnthropicToolResultBlockWire> {
  try {
    if (call.name === "web_search") {
      const query = String(call.input.query ?? "");
      hooks.onSearch?.(query);
      const res = await fetch("/api/tools/web_search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
        signal,
      });
      const json = (await res.json()) as SearchResultJson;
      if (!res.ok || !json.results)
        return err(call, `search failed: ${json.error ?? res.status}`, hooks);
      if (json.results.length === 0)
        return err(call, "search returned no results for that query", hooks);
      const summary = json.results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join("\n\n");
      return {
        type: "tool_result",
        tool_use_id: call.id,
        // Spelled out because models routinely answer straight from snippets:
        // a snippet is a search engine's summary, not the page.
        content:
          `${summary}\n\n(These are search snippets, not page contents. ` +
          `Call web_fetch on the ones you intend to rely on.)`,
      };
    }

    if (call.name === "calculate") {
      // Runs in the browser and needs no network: the answer is available
      // before a request would have left the machine.
      const expression = String(call.input.expression ?? "");
      hooks.onCalculate?.(expression);
      try {
        const value = evaluate(expression);
        return {
          type: "tool_result",
          tool_use_id: call.id,
          content: `${expression} = ${formatResult(value)}`,
        };
      } catch (e) {
        // The message names what was wrong with the expression, so the model
        // can correct it rather than abandoning the calculation.
        return err(
          call,
          `cannot evaluate "${expression}": ${e instanceof Error ? e.message : String(e)}`,
          hooks,
        );
      }
    }

    if (call.name === "create_document") {
      // create_document was declared in TOOLS but never implemented, so every
      // model that correctly called it got "unknown tool" back and the user got
      // no file — the whole document feature was advertised and dead.
      const format = String(call.input.format ?? "pdf") as DocFormat;
      if (!DOC_FORMATS.has(format)) {
        return err(call, `unsupported format "${format}"`, hooks);
      }
      const sections = Array.isArray(call.input.sections) ? call.input.sections : [];
      if (sections.length === 0) {
        return err(call, "sections must be a non-empty array", hooks);
      }
      // Rendering happens in the browser: nothing is uploaded, and the object
      // URL is handed straight to a download link.
      const { renderDocument } = await import("./documents");
      const rendered = await renderDocument({
        format,
        title: String(call.input.title ?? "Document"),
        subtitle: call.input.subtitle ? String(call.input.subtitle) : undefined,
        sections: sections as DocSection[],
      });
      hooks.onDocument?.({
        filename: rendered.filename,
        mime: rendered.blob.type,
        url: URL.createObjectURL(rendered.blob),
        format,
        bytes: rendered.blob.size,
      });
      return {
        type: "tool_result",
        tool_use_id: call.id,
        // The model must not then paste the document's contents into the chat.
        content:
          `Created ${rendered.filename} (${format}, ${rendered.blob.size} bytes). ` +
          `It is already offered to the user as a download. Reply with one short ` +
          `sentence confirming it — do not repeat the document's contents.`,
      };
    }

    if (call.name === "web_fetch") {
      const url = String(call.input.url ?? "");
      hooks.onFetch?.(url);
      const res = await fetch("/api/tools/web_fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
        signal,
      });
      const json = (await res.json()) as FetchResultJson;
      if (!res.ok || !json.text)
        return err(call, `fetch failed: ${json.error ?? res.status}`, hooks);
      // Cite what was actually read: a redirect chain means the URL the model
      // asked for is not necessarily the page it got.
      const readUrl = json.finalUrl ?? url;
      const index = cite(sources, seenUrls, hooks, {
        title: json.title ?? readUrl.replace(/^https?:\/\//, "").slice(0, 80),
        url: readUrl,
      });
      return {
        type: "tool_result",
        tool_use_id: call.id,
        // The citation index is handed back with the content so the model can
        // write [n] and have it resolve against the list the user is shown.
        // Without it the "Sources" list under an answer asserted a link between
        // text and source that nothing had established.
        content:
          `Source [${index}] — ${json.title ?? readUrl}\n${readUrl}\n` +
          `Cite this as [${index}] when you use it.\n\n${json.text}` +
          (json.truncated ? "\n\n(Page was truncated.)" : ""),
      };
    }

    if (
      call.name === "get_news" ||
      call.name === "get_data" ||
      call.name === "get_reference"
    ) {
      const kind =
        call.name === "get_news" ? "news" : String(call.input.kind ?? "");
      const query = String(call.input.query ?? "");
      hooks.onData?.(kind, query);
      const res = await fetch("/api/tools/data", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, query }),
        signal,
      });
      const json = (await res.json()) as DataResultJson;
      if (!res.ok || !json.text)
        return err(
          call,
          `${kind} lookup failed: ${json.error ?? res.status}`,
          hooks,
        );
      // A successful structured lookup is a real, citable source — the same
      // standard applied to a fetched page.
      const url = `kompass:${kind}/${encodeURIComponent(query)}`;
      const index = cite(sources, seenUrls, hooks, {
        title: `${json.source ?? kind} — ${query}`,
        url,
      });
      return {
        type: "tool_result",
        tool_use_id: call.id,
        content:
          `${json.text}\n\n(Source [${index}]: ${json.source ?? kind}. ` +
          `Cite this as [${index}].)`,
      };
    }

    return err(call, `unknown tool "${call.name}"`, hooks);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    return err(
      call,
      `${call.name} failed: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`,
      hooks,
    );
  }
}

/** Names eligible for text-form recovery — see recoverToolCall.ts. */
export const TOOL_NAMES: Set<string> = new Set(TOOLS.map((t) => t.name));
