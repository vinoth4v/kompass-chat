import { describe, expect, it } from "vitest";
import { councilToDocument } from "./councilDocument";
import type { CouncilRun } from "./council";

const run = (over: Partial<CouncilRun> = {}): CouncilRun => ({
  judgePhase: "done",
  agents: [
    {
      spec: { id: "a", label: "Analyst", model: "kompass-hard" },
      phase: "done",
      searches: 2,
      reads: 1,
      answer: "First para.\n\nSecond para.",
      sources: [],
      servedBy: "groq/llama",
    },
    {
      spec: { id: "b", label: "Skeptic", model: "kompass-agentic" },
      phase: "failed",
      searches: 0,
      reads: 0,
      sources: [],
      error: "exhausted",
    },
  ],
  verdict: {
    answer: "The answer.",
    agreements: ["Both agree on X"],
    disagreements: [{ point: "Scope", positions: ["A says narrow", "B says broad"] }],
    sources: [{ title: "Wikipedia", url: "https://en.wikipedia.org/wiki/X" }],
    servedBy: "judge-model",
  },
  ...over,
});

describe("councilToDocument", () => {
  it("puts disagreements before agreements", () => {
    // Where the models diverged is the reason to run a council at all; it is
    // the part no single model could have told you.
    const headings = councilToDocument("Q", run()).sections.map((s) => s.heading);
    expect(headings.indexOf("Points of disagreement")).toBeLessThan(
      headings.indexOf("Points of agreement"),
    );
  });

  it("keeps each agent's own answer so the verdict can be checked", () => {
    const doc = councilToDocument("Q", run());
    expect(doc.sections.some((s) => s.heading?.includes("Analyst"))).toBe(true);
    // A failed agent contributed no answer, so it gets no section.
    expect(doc.sections.some((s) => s.heading?.includes("Skeptic"))).toBe(false);
  });

  it("records how many agents failed, rather than quietly dropping them", () => {
    expect(councilToDocument("Q", run()).subtitle).toContain("1 failed");
  });

  it("renders sources as a table", () => {
    const sources = councilToDocument("Q", run()).sections.find(
      (s) => s.heading === "Sources",
    );
    expect(sources?.table?.rows[0]).toEqual([
      "1",
      "Wikipedia",
      "https://en.wikipedia.org/wiki/X",
    ]);
  });

  it("splits prose on blank lines instead of emitting one wall of text", () => {
    const analyst = councilToDocument("Q", run()).sections.find((s) =>
      s.heading?.includes("Analyst"),
    );
    expect(analyst?.paragraphs).toHaveLength(2);
  });

  it("still produces a document when the run has no verdict", () => {
    const doc = councilToDocument("Q", run({ verdict: undefined }));
    expect(doc.sections.length).toBeGreaterThan(0);
    expect(doc.title).toBe("Q");
  });

  it("falls back to a title when the question is blank", () => {
    expect(councilToDocument("   ", run()).title).toBe("Council run");
  });
});
