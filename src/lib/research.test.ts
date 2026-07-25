import { describe, it, expect } from "vitest";
import { extractFollowups, unbackedCitations } from "./research";

describe("extractFollowups", () => {
  it("strips the marker and returns the questions", () => {
    const r = extractFollowups(
      "The answer.\n\nFOLLOWUPS: What next? | Why does it matter?",
    );
    expect(r.text).toBe("The answer.");
    expect(r.followups).toEqual(["What next?", "Why does it matter?"]);
  });

  it("tolerates the ways models mangle the marker", () => {
    const r = extractFollowups("Answer.\n\n**Follow-ups:** One thing? | Another?");
    expect(r.text).toBe("Answer.");
    expect(r.followups).toHaveLength(2);
  });

  it("leaves an answer without the marker untouched", () => {
    const r = extractFollowups("Just an answer.");
    expect(r.text).toBe("Just an answer.");
    expect(r.followups).toBeUndefined();
  });
});

describe("unbackedCitations", () => {
  it("flags a citation number no source backs", () => {
    expect(unbackedCitations("As shown in [3], the figure rose.", 2)).toEqual([
      3,
    ]);
  });

  it("passes citations that resolve", () => {
    expect(unbackedCitations("Per [1] and [2].", 2)).toEqual([]);
  });

  it("reports each bad number once, in order", () => {
    expect(unbackedCitations("[5] then [4] then [5] again.", 1)).toEqual([4, 5]);
  });

  it("ignores markdown links, which are not citations", () => {
    expect(unbackedCitations("See [9](https://example.com) for more.", 0)).toEqual(
      [],
    );
  });

  it("flags every citation when nothing at all was read", () => {
    expect(unbackedCitations("Confidently sourced [1].", 0)).toEqual([1]);
  });
});

describe("extractFollowups — the heading-and-list form", () => {
  // Verbatim from a maths answer where the whole block leaked into the reply.
  const REAL =
    "Therefore the exact maximum value is 1/6.\n\n---\n\n" +
    "**FOLLOW‑UPS**\n" +
    "- How would the answer change if the condition were k(ab+bc+ca)?\n" +
    "- Can the same maximum be obtained by rearrangement?\n" +
    "- What is the minimum of F if the condition is dropped?";

  it("strips a bold heading with a U+2011 hyphen and takes the list", () => {
    const r = extractFollowups(REAL);
    expect(r.text).not.toMatch(/FOLLOW/i);
    expect(r.followups).toHaveLength(3);
    expect(r.followups![0]).toMatch(/^How would the answer change/);
    expect(r.text.trimEnd()).toBe("Therefore the exact maximum value is 1/6.");
  });

  it("still handles the pipe form it asks for", () => {
    const r = extractFollowups("Answer.\n\nFOLLOWUPS: one thing? | two thing?");
    expect(r.followups).toEqual(["one thing?", "two thing?"]);
    expect(r.text).toBe("Answer.");
  });

  it("handles numbered lists under the heading", () => {
    const r = extractFollowups("Answer.\n\nFollow-ups\n1. First one?\n2. Second one?");
    expect(r.followups).toEqual(["First one?", "Second one?"]);
    expect(r.text).toBe("Answer.");
  });

  it("leaves the text alone when the marker introduces nothing usable", () => {
    // "Follow-ups" as a genuine section of the answer, not a chip list.
    const original = "We discussed follow-ups: none are needed right now.";
    const r = extractFollowups(original);
    expect(r.text).toBe(original);
    expect(r.followups).toBeUndefined();
  });
});
