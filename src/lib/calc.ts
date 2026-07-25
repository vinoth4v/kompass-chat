// Exact arithmetic for the model.
//
// Asked to value a portfolio over 360 months with continuously compounded
// returns, inflation-indexed withdrawals and periodic contributions, a free
// model produced two thousand words of working and no number. Part of that is
// answer shape (see research.ts), but part is real: no language model computes
// exp(0.07), a 30-term geometric series and a 360-step recurrence accurately in
// its head, and one that tries will produce a confident wrong figure.
//
// So: a calculator it can call. Deliberately NOT an eval() sandbox — this is a
// recursive-descent parser over a fixed grammar, so the only thing a model can
// make it do is arithmetic. `sum` and `prod` are included because the questions
// that most need exact arithmetic are series, and asking a model to unroll 360
// terms into one expression is asking for a transcription error.

type Tok =
  | { k: "num"; v: number }
  | { k: "id"; v: string }
  | { k: "op"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/\d/.test(c) || (c === "." && /\d/.test(src[i + 1] ?? ""))) {
      // Grouped thousands are matched as ONE number, ahead of the plain form:
      // models write 100,000 and mean 1e5. Stripping the comma as a separate
      // step instead left "100" and "000" as two adjacent numbers, which is a
      // parse error rather than the value the model intended.
      const m =
        /^\d{1,3}(?:,\d{3})+(?:\.\d+)?|^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(
          src.slice(i),
        )!;
      out.push({ k: "num", v: Number(m[0].replace(/,/g, "")) });
      i += m[0].length;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      const m = /^[a-zA-Z_]\w*/.exec(src.slice(i))!;
      out.push({ k: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    if ("+-*/%^(),".includes(c)) {
      out.push({ k: "op", v: c });
      i++;
      continue;
    }
    if (c === "√") {
      out.push({ k: "id", v: "sqrt" });
      i++;
      continue;
    }
    throw new Error(`unexpected character "${c}"`);
  }
  return out;
}

type Node =
  | { t: "num"; v: number }
  | { t: "var"; name: string }
  | { t: "bin"; op: string; l: Node; r: Node }
  | { t: "neg"; e: Node }
  | { t: "call"; name: string; args: Node[] };

const FUNCS: Record<string, (...a: number[]) => number> = {
  exp: Math.exp,
  ln: Math.log,
  log: Math.log, // natural, as in mathematics; log10 is explicit
  log10: Math.log10,
  log2: Math.log2,
  sqrt: Math.sqrt,
  abs: Math.abs,
  sign: Math.sign,
  floor: Math.floor,
  ceil: Math.ceil,
  round: (x, d = 0) => {
    const f = Math.pow(10, d);
    return Math.round(x * f) / f;
  },
  trunc: Math.trunc,
  pow: Math.pow,
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  mod: (a, b) => a % b,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
};

const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

/** Bound to a name so the error text can say which call was wrong. */
const LOOPS = new Set(["sum", "prod"]);

function parse(toks: Tok[]): Node {
  let p = 0;
  const peek = () => toks[p];
  const eat = (v: string) => {
    const t = toks[p];
    if (!t || t.k !== "op" || t.v !== v)
      throw new Error(`expected "${v}"${t ? "" : " but the expression ended"}`);
    p++;
  };

  function expr(): Node {
    let l = term();
    for (;;) {
      const t = peek();
      if (t?.k === "op" && (t.v === "+" || t.v === "-")) {
        p++;
        l = { t: "bin", op: t.v, l, r: term() };
      } else return l;
    }
  }

  function term(): Node {
    let l = unary();
    for (;;) {
      const t = peek();
      if (t?.k === "op" && (t.v === "*" || t.v === "/" || t.v === "%")) {
        p++;
        l = { t: "bin", op: t.v, l, r: unary() };
      } else return l;
    }
  }

  function unary(): Node {
    const t = peek();
    if (t?.k === "op" && (t.v === "-" || t.v === "+")) {
      p++;
      const e = unary();
      return t.v === "-" ? { t: "neg", e } : e;
    }
    return power();
  }

  function power(): Node {
    const base = primary();
    const t = peek();
    if (t?.k === "op" && t.v === "^") {
      p++;
      // Right-associative, and the exponent may itself be signed: 2^-3.
      return { t: "bin", op: "^", l: base, r: unary() };
    }
    return base;
  }

  function primary(): Node {
    const t = peek();
    if (!t) throw new Error("expression ended unexpectedly");
    if (t.k === "num") {
      p++;
      return { t: "num", v: t.v };
    }
    if (t.k === "id") {
      p++;
      const next = peek();
      if (next?.k === "op" && next.v === "(") {
        p++;
        const args: Node[] = [];
        if (!(peek()?.k === "op" && (peek() as { v: string }).v === ")")) {
          args.push(expr());
          while (peek()?.k === "op" && (peek() as { v: string }).v === ",") {
            p++;
            args.push(expr());
          }
        }
        eat(")");
        return { t: "call", name: t.v, args };
      }
      return { t: "var", name: t.v };
    }
    if (t.v === "(") {
      p++;
      const e = expr();
      eat(")");
      return e;
    }
    throw new Error(`unexpected "${t.v}"`);
  }

  const out = expr();
  if (p !== toks.length)
    throw new Error(`unexpected "${(toks[p] as { v: unknown }).v}" after a complete expression`);
  return out;
}

/** Guards a `sum` over a range a model got wrong from hanging the browser. */
const MAX_ITERATIONS = 200_000;

function evalNode(n: Node, env: Record<string, number>): number {
  switch (n.t) {
    case "num":
      return n.v;
    case "var": {
      if (n.name in env) return env[n.name]!;
      const c = CONSTS[n.name.toLowerCase()];
      if (c !== undefined) return c;
      throw new Error(`unknown name "${n.name}"`);
    }
    case "neg":
      return -evalNode(n.e, env);
    case "bin": {
      const a = evalNode(n.l, env);
      const b = evalNode(n.r, env);
      switch (n.op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          if (b === 0) throw new Error("division by zero");
          return a / b;
        case "%":
          return a % b;
        case "^":
          return Math.pow(a, b);
      }
      throw new Error(`unknown operator "${n.op}"`);
    }
    case "call": {
      const name = n.name.toLowerCase();
      if (LOOPS.has(name)) {
        // sum(k, from, to, body) — `k` is bound over the range, body is
        // evaluated per step rather than eagerly.
        const [v, from, to, body] = n.args;
        if (!v || v.t !== "var" || !from || !to || !body)
          throw new Error(
            `${name} takes (variable, from, to, expression) — e.g. sum(k, 1, 12, 1/k)`,
          );
        const lo = Math.round(evalNode(from, env));
        const hi = Math.round(evalNode(to, env));
        if (!Number.isFinite(lo) || !Number.isFinite(hi))
          throw new Error(`${name} bounds must be finite`);
        if (hi - lo + 1 > MAX_ITERATIONS)
          throw new Error(
            `${name} range is too large (${hi - lo + 1} terms, limit ${MAX_ITERATIONS})`,
          );
        let acc = name === "sum" ? 0 : 1;
        const scope = { ...env };
        for (let k = lo; k <= hi; k++) {
          scope[v.name] = k;
          const term = evalNode(body, scope);
          acc = name === "sum" ? acc + term : acc * term;
        }
        return acc;
      }
      const f = FUNCS[name];
      if (!f) throw new Error(`unknown function "${n.name}"`);
      return f(...n.args.map((a) => evalNode(a, env)));
    }
  }
}

/**
 * Evaluate a mathematical expression. Throws with a readable message on bad
 * input — the message goes back to the model, which can then correct itself.
 */
export function evaluate(
  expression: string,
  env: Record<string, number> = {},
): number {
  if (!expression.trim()) throw new Error("empty expression");
  if (expression.length > 4000) throw new Error("expression too long");
  const value = evalNode(parse(tokenize(expression)), env);
  if (typeof value !== "number" || Number.isNaN(value))
    throw new Error("expression did not produce a number");
  if (!Number.isFinite(value))
    throw new Error("result overflowed to infinity — check the exponents");
  return value;
}

/**
 * Full precision plus a human-readable rounding. Both, because the model may
 * need to feed the value into the next step, while the user needs to read it.
 */
export function formatResult(value: number): string {
  const exact = String(value);
  const rounded =
    Math.abs(value) >= 0.01 || value === 0
      ? value.toLocaleString("en-US", { maximumFractionDigits: 2 })
      : value.toPrecision(4);
  return exact === rounded ? exact : `${exact}  (≈ ${rounded})`;
}
