import { describe, it, expect } from "vitest";
import { parseJudge } from "./council";

describe("parseJudge", () => {
  const STRUCTURE =
    '{"agreements": ["A and B concur"], "disagreements": [{"point": "Whether war ' +
    'serves a purpose", "positions": ["A says yes", "B says no"]}]}';

  it("reads a fenced block and keeps the prose after it", () => {
    const r = parseJudge("```json\n" + STRUCTURE + "\n```\n\nThe final answer.");
    expect(r.degraded).toBe(false);
    expect(r.agreements).toEqual(["A and B concur"]);
    expect(r.disagreements[0]!.positions).toHaveLength(2);
    expect(r.answer).toBe("The final answer.");
  });

  it("reads the same structure unfenced — the case that leaked raw JSON", () => {
    const r = parseJudge(STRUCTURE + "\n\n## Final Synthesized Answer\nWar is contested.");
    expect(r.degraded).toBe(false);
    expect(r.agreements).toEqual(["A and B concur"]);
    expect(r.disagreements[0]!.point).toBe("Whether war serves a purpose");
    // The braces must not reach the user.
    expect(r.answer).not.toContain('"agreements"');
    expect(r.answer).toContain("War is contested.");
  });

  it("keeps prose written BEFORE the structure", () => {
    const r = parseJudge("Here is my verdict.\n\n" + STRUCTURE);
    expect(r.degraded).toBe(false);
    expect(r.answer).toBe("Here is my verdict.");
  });

  it("brace-matches, so nested objects do not end the structure early", () => {
    const nested =
      '{"agreements": [], "disagreements": [{"point": "p", "positions": ["a {brace} here"]}]}';
    const r = parseJudge(nested + "\nAnswer.");
    expect(r.disagreements[0]!.positions).toEqual(["a {brace} here"]);
    expect(r.answer).toBe("Answer.");
  });

  it("degrades when there is no structure at all", () => {
    const r = parseJudge("Just a plain answer with a { brace } in it.");
    expect(r.degraded).toBe(true);
    expect(r.answer).toBe("Just a plain answer with a { brace } in it.");
    expect(r.agreements).toEqual([]);
  });

  it("skips a malformed block and finds a later valid one", () => {
    const r = parseJudge("```json\n{ not json ```\n" + STRUCTURE + "\nDone.");
    expect(r.degraded).toBe(false);
    expect(r.agreements).toEqual(["A and B concur"]);
  });
});

// A verbatim payload from the deployed app, kept because it is the shape that
// actually reached a user: bare JSON, then the prose answer, no fence in sight.
const REAL = `{"agreements": ["Beating, hitting, or spanking children (corporal punishment) is not good for their development.", "Physical punishment is consistently associated with increased aggression, antisocial behavior, and externalizing problems in children.", "Physical punishment is linked to higher rates of anxiety, depression, and other mental-health difficulties.", "Use of corporal punishment raises the risk of escalation to more severe physical abuse.", "Major pediatric, psychological, and human-rights organizations worldwide (e.g., AAP, APA, WHO, UN Committee on the Rights of the Child) recommend against any form of corporal punishment.", "There is no credible empirical evidence that corporal punishment provides long-term developmental benefits or improves moral internalization."], "disagreements": [{"point": "Magnitude and certainty of the harmful effects", "positions": ["Analysts A and B present the evidence as strongly and consistently showing harm across contexts, with no meaningful dissent.", "Analyst C notes that a 2024 meta-analysis (Larzelere et al.) found spanking accounts for <1% of variance in outcomes, and some researchers (e.g., Larzelere, Ferguson) argue effect sizes are small and causal inference limited by confounding, though the consensus still favors harm."]}]}
Final synthesized answer
**No, beating children is not good for their development.** A large, convergent body of research shows harm.`;

it("parses the exact payload the deployed app failed on", () => {
  const r = parseJudge(REAL);
  expect(r.degraded).toBe(false);
  expect(r.agreements).toHaveLength(6);
  expect(r.disagreements).toHaveLength(1);
  expect(r.answer).not.toContain('"agreements"');
});

