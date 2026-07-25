import { describe, it, expect } from "vitest";
import { normalizeMath } from "./mathMarkdown";

describe("normalizeMath", () => {
  it("converts display math to $$, which is what remark-math reads", () => {
    expect(normalizeMath("\\[ x^2 + y^2 = z^2 \\]")).toBe(
      "\n$$\nx^2 + y^2 = z^2\n$$\n",
    );
  });

  it("converts inline math to $", () => {
    expect(normalizeMath("where \\(a = b\\) holds")).toBe("where $a = b$ holds");
  });

  it("handles the real answer: boxed display math plus inline", () => {
    const src =
      "\\[\n\\boxed{\\displaystyle \\max F(a,b,c)=\\frac16}\n\\]\n" +
      "attained at \\(a=b=c=\\frac13\\).";
    const out = normalizeMath(src);
    expect(out).toContain("$$");
    expect(out).toContain("\\boxed{\\displaystyle \\max F(a,b,c)=\\frac16}");
    expect(out).toContain("$a=b=c=\\frac13$");
    expect(out).not.toContain("\\[");
    expect(out).not.toContain("\\(");
  });

  it("handles multiple formulas in one answer", () => {
    const out = normalizeMath("\\[a\\] then \\[b\\] and \\(c\\)");
    expect(out.match(/\$\$/g)).toHaveLength(4); // two display blocks
    expect(out).toContain("$c$");
  });

  it("leaves fenced code alone — a shell snippet is not mathematics", () => {
    const src = "```bash\nsed -e \\[abc\\] file\n```";
    expect(normalizeMath(src)).toBe(src);
  });

  it("leaves inline code alone", () => {
    const src = "use `arr\\[0\\]` to index";
    expect(normalizeMath(src)).toBe(src);
  });

  it("converts outside a fence while preserving the fence", () => {
    const src = "\\(x\\) then:\n\n```js\nconst a = \\[1\\];\n```\n\nand \\(y\\)";
    const out = normalizeMath(src);
    expect(out).toContain("$x$");
    expect(out).toContain("$y$");
    expect(out).toContain("const a = \\[1\\];"); // untouched inside the fence
  });

  it("leaves an unmatched delimiter alone rather than swallowing the rest", () => {
    const src = "an open \\[ bracket with no partner";
    expect(normalizeMath(src)).toBe(src);
  });

  it("is a no-op on text with no LaTeX at all", () => {
    const src = "# Heading\n\nJust prose, and a [link](https://example.com).";
    expect(normalizeMath(src)).toBe(src);
  });
});
