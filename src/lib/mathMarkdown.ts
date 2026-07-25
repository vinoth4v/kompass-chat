// Normalise the LaTeX delimiters models actually emit.
//
// remark-math understands $…$ and $$…$$. Models — asked for a derivation —
// overwhelmingly write LaTeX's own \(…\) and \[…\] instead, which remark-math
// does not recognise, so a fully correct proof rendered as a wall of backslashes
// and \boxed{} literals. This rewrites the delimiters before parsing.
//
// Code is left alone. A shell snippet containing \[ is not mathematics, and
// silently turning one into a formula would corrupt the very thing a user is
// most likely to copy and run.

/** Spans of the text that must not be touched: fenced blocks and inline code. */
function codeSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  // Fenced first, so a stray backtick inside a fence cannot open an inline span.
  const fence = /^[ \t]*(`{3,}|~{3,})[\s\S]*?^[ \t]*\1[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null)
    spans.push([m.index, m.index + m[0].length]);
  const inline = /`+[^`\n]*`+/g;
  while ((m = inline.exec(text)) !== null) {
    const [s, e] = [m.index, m.index + m[0].length];
    if (!spans.some(([a, b]) => s >= a && e <= b)) spans.push([s, e]);
  }
  return spans.sort((a, b) => a[0] - b[0]);
}

/**
 * Rewrite \[…\] to $$…$$ and \(…\) to $…$, outside code.
 *
 * Display and inline are handled in one pass over the segments so an unmatched
 * opener cannot swallow the rest of the document: each delimiter is only
 * rewritten when its partner is present.
 */
export function normalizeMath(text: string): string {
  if (!text.includes("\\[") && !text.includes("\\(")) return text;
  const spans = codeSpans(text);
  let out = "";
  let at = 0;
  for (const [start, end] of [...spans, [text.length, text.length]]) {
    out += convert(text.slice(at, start!)) + text.slice(start!, end!);
    at = end!;
  }
  return out;
}

function convert(segment: string): string {
  return segment
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, body: string) => `\n$$\n${String(body).trim()}\n$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, body: string) => `$${String(body).trim()}$`);
}
