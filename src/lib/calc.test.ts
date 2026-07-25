import { describe, it, expect } from "vitest";
import { evaluate, formatResult } from "./calc";

describe("evaluate", () => {
  it("respects precedence and associativity", () => {
    expect(evaluate("2 + 3 * 4")).toBe(14);
    expect(evaluate("(2 + 3) * 4")).toBe(20);
    expect(evaluate("2 ^ 3 ^ 2")).toBe(512); // right-associative, not 64
    expect(evaluate("10 - 4 - 3")).toBe(3); // left-associative
    expect(evaluate("-2 ^ 2")).toBe(-4); // unary binds looser than ^
    expect(evaluate("2 ^ -1")).toBe(0.5); // signed exponent
  });

  it("computes the functions a money question needs", () => {
    expect(evaluate("exp(0)")).toBe(1);
    expect(evaluate("exp(0.07)")).toBeCloseTo(1.0725081813, 9);
    expect(evaluate("100000 * exp(0.07 * 30)")).toBeCloseTo(816616.99, 1);
    expect(evaluate("ln(e)")).toBeCloseTo(1, 12);
    expect(evaluate("round(2.34567, 2)")).toBe(2.35);
    expect(evaluate("sqrt(144)")).toBe(12);
  });

  it("sums a series without the model unrolling it", () => {
    expect(evaluate("sum(k, 1, 100, k)")).toBe(5050);
    expect(evaluate("sum(k, 1, 3, k^2)")).toBe(14);
    expect(evaluate("prod(k, 1, 5, k)")).toBe(120);
    // A payment rising 2.5% a year, paid monthly for 30 years: the kind of
    // term-by-term arithmetic that is hopeless to do in prose. Checked against
    // the closed form of the same series, computed independently — asserting a
    // number the implementation printed would only test that it is consistent
    // with itself.
    const closedForm = (18000 * (Math.pow(1.025, 30) - 1)) / 0.025;
    expect(evaluate("sum(k, 0, 359, 1500 * 1.025^floor(k/12))")).toBeCloseTo(
      closedForm,
      6,
    );
  });

  it("keeps the loop variable scoped to its own sum", () => {
    expect(evaluate("sum(k, 1, 2, k) + sum(k, 1, 3, k)")).toBe(9);
    expect(() => evaluate("sum(k, 1, 2, k) + k")).toThrow(/unknown name "k"/);
  });

  it("accepts thousands separators without breaking argument lists", () => {
    expect(evaluate("100,000 + 1")).toBe(100001);
    expect(evaluate("max(1,000, 2)")).toBe(1000);
  });

  it("reports bad input in terms the model can act on", () => {
    expect(() => evaluate("2 +")).toThrow(/ended unexpectedly/);
    expect(() => evaluate("(2 + 3")).toThrow(/expected "\)"/);
    expect(() => evaluate("frobnicate(2)")).toThrow(/unknown function/);
    expect(() => evaluate("1 / 0")).toThrow(/division by zero/);
    expect(() => evaluate("")).toThrow(/empty expression/);
    expect(() => evaluate("2 3")).toThrow(/after a complete expression/);
    expect(() => evaluate("exp(100000)")).toThrow(/overflow/);
  });

  it("refuses a runaway series instead of hanging", () => {
    expect(() => evaluate("sum(k, 1, 999999999, k)")).toThrow(/too large/);
  });

  it("evaluates arithmetic only — it is a parser, not a sandbox", () => {
    // There is no path from any of these to execution: they are simply not in
    // the grammar.
    expect(() => evaluate("process.exit(1)")).toThrow();
    expect(() => evaluate("[].constructor")).toThrow();
    expect(() => evaluate("globalThis")).toThrow(/unknown name/);
  });
});

describe("formatResult", () => {
  it("keeps full precision and adds a readable rounding", () => {
    expect(formatResult(816616.9911)).toBe("816616.9911  (≈ 816,616.99)");
    expect(formatResult(12)).toBe("12");
  });
});
