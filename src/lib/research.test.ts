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
