// Recover a tool call that a model printed as TEXT instead of calling.
//
// Kompass routes across ~10 free providers, and several of the open-weight
// models are unreliable at structured tool use. Instead of populating the
// tool_use content block they emit the call into the answer as prose. Two
// shapes have been seen live:
//
//   <tool_call> <function=get_news> <parameter=query> … </parameter> </function>
//   { "name": "functions.create_document", "arguments": { "title": … } }
//
// The second is worse, because it is well-formed intent. Asked for "a PDF of
// the life of Gandhi", the model produced a complete, correct create_document
// call — and the user got a wall of JSON and no PDF. The gateway's voice layer
// strips this markup so it stops reaching the screen, but stripping alone
// throws the request away.
//
// So: parse it and run it. The model asked for the right thing in the wrong
// field, and the whole point of the gateway is that the user should not be
// able to tell which model answered.
import type { AnthropicToolUseBlockWire } from "./kompassClient";

export interface RecoveredCall {
  calls: AnthropicToolUseBlockWire[];
  /** The text with the recovered call removed; may be empty. */
  text: string;
}

/**
 * Extract the JSON object starting at `open`, respecting nesting and strings.
 * A regex cannot do this — `create_document` arguments nest several levels and
 * routinely contain braces inside prose.
 */
export function extractObject(s: string, open: number): string | null {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(open, i + 1);
    }
  }
  return null; // truncated mid-object — the model ran out of tokens
}

let seq = 0;

/**
 * Scan text for tool calls the model wrote instead of called.
 *
 * `known` gates what may run: executing an arbitrary named object parsed out of
 * model prose would let any text that happens to look like a tool call invoke
 * one. Only tools already offered on this turn are eligible.
 */
export function recoverToolCalls(text: string, known: Set<string>): RecoveredCall {
  const calls: AnthropicToolUseBlockWire[] = [];
  let out = text;

  // Anchor on the name field rather than on "{": most answers contain braces.
  const anchor = /\{\s*"name"\s*:\s*"([^"]+)"/g;
  const cuts: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(text)) !== null) {
    const raw = extractObject(text, m.index);
    if (!raw) continue;
    let parsed: { name?: string; arguments?: unknown; parameters?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    // Some models namespace the tool ("functions.create_document").
    const name = String(parsed.name ?? "").replace(/^functions?\./, "");
    if (!known.has(name)) continue;
    // `arguments` is the OpenAI spelling, `parameters` shows up too.
    const args = parsed.arguments ?? parsed.parameters ?? {};
    if (typeof args !== "object" || args === null) continue;
    calls.push({
      type: "tool_use",
      id: `recovered_${Date.now()}_${seq++}`,
      name,
      input: args as Record<string, unknown>,
    });
    cuts.push([m.index, m.index + raw.length]);
  }

  // Remove from the end so earlier offsets stay valid.
  for (const [start, end] of cuts.reverse()) {
    out = out.slice(0, start) + out.slice(end);
  }
  return { calls, text: out.trim() };
}
