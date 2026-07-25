import { describe, expect, it } from "vitest";
import { recoverToolCalls } from "./recoverToolCall";

const KNOWN = new Set(["create_document", "web_search"]);

describe("recoverToolCalls", () => {
  it("recovers the create_document call a model printed as prose", () => {
    // Verbatim shape from a live session: asked for "a pdf paper of the life of
    // Gandhi", the model emitted the call as text and the user got no PDF.
    const leaked =
      '{ "name": "functions.create_document", "arguments": { "title": "Life of ' +
      'Mahatma Gandhi", "format": "pdf", "sections": [ { "heading": "Overview", ' +
      '"paragraphs": [ "Gandhi (1869-1948) led the independence movement." ] } ] } }';
    const { calls, text } = recoverToolCalls(leaked, KNOWN);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("create_document"); // "functions." prefix dropped
    expect((calls[0]!.input as { format: string }).format).toBe("pdf");
    expect(text).toBe(""); // the JSON must not also reach the screen
  });

  it("does not run a tool that was not offered this turn", () => {
    // Otherwise any prose that looks like a call could invoke something.
    const hostile = '{ "name": "delete_everything", "arguments": {} }';
    expect(recoverToolCalls(hostile, KNOWN).calls).toHaveLength(0);
  });

  it("leaves ordinary prose containing braces alone", () => {
    const prose = 'Use `{ "name": "value" }` to configure it.';
    const { calls, text } = recoverToolCalls(prose, KNOWN);
    expect(calls).toHaveLength(0);
    expect(text).toBe(prose);
  });

  it("handles braces and escaped quotes inside string values", () => {
    // Brace-counting alone would stop at the first } inside the prose.
    const leaked =
      '{ "name": "create_document", "arguments": { "title": "A } brace and a ' +
      '\\" quote", "format": "docx" } }';
    const { calls } = recoverToolCalls(leaked, KNOWN);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.input as { title: string }).title).toBe('A } brace and a " quote');
  });

  it("ignores a call truncated by the token limit", () => {
    const truncated = '{ "name": "create_document", "arguments": { "title": "Unfinished';
    expect(recoverToolCalls(truncated, KNOWN).calls).toHaveLength(0);
  });

  it("keeps the surrounding answer when a call is embedded in it", () => {
    const mixed =
      'Here is your document.\n{ "name": "create_document", "arguments": { "format": "pdf" } }\nLet me know.';
    const { calls, text } = recoverToolCalls(mixed, KNOWN);
    expect(calls).toHaveLength(1);
    expect(text).toContain("Here is your document.");
    expect(text).not.toContain("create_document");
  });
});
