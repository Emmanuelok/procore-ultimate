/**
 * BUDGET VIEWS — custom columns with calculated fields (spec #486–487).
 *
 * A calculated field is an arithmetic expression over the stored cost-report
 * columns of a budget line: `revisedBudget - committedCost`, or
 * `pct(jobToDateCosts, revisedBudget)`. It is evaluated HERE, by a small
 * recursive-descent parser over a whitelisted identifier set — never by
 * `eval`, never by `new Function` — so a saved view is reproducible, cannot
 * reach anything outside the line, and rejects at save time rather than
 * failing on the grid.
 *
 * Money discipline carries through: a division by zero yields `null` with a
 * reason, never 0 or Infinity, and any reference to a column the line does
 * not carry is a parse error rather than a silent NaN.
 *
 * This file deliberately does NOT touch the database.
 */

/** The stored columns a calculated field may read, by their wire names. */
export const VIEW_COLUMN_KEYS = [
  "originalBudget",
  "budgetModifications",
  "approvedChanges",
  "pendingBudgetChanges",
  "revisedBudget",
  "committedCost",
  "pendingCommitments",
  "directCosts",
  "jobToDateCosts",
  "forecastToComplete",
  "forecastFinal",
  "projectedOverUnder",
  "percentComplete",
  "quantity",
  "unitRate",
] as const;

export type ViewColumnKey = (typeof VIEW_COLUMN_KEYS)[number];

/** Functions available inside an expression. All are total over finite numbers. */
const FUNCTIONS: Record<string, { arity: number; apply: (args: number[]) => number | null }> = {
  min: { arity: -1, apply: (a) => (a.length === 0 ? null : Math.min(...a)) },
  max: { arity: -1, apply: (a) => (a.length === 0 ? null : Math.max(...a)) },
  abs: { arity: 1, apply: (a) => Math.abs(a[0] as number) },
  round: { arity: 1, apply: (a) => Math.round(a[0] as number) },
  /** a as a percentage of b — null when b is zero */
  pct: {
    arity: 2,
    apply: (a) => ((a[1] as number) === 0 ? null : ((a[0] as number) / (a[1] as number)) * 100),
  },
  /** a ÷ b — null when b is zero */
  ratio: { arity: 2, apply: (a) => ((a[1] as number) === 0 ? null : (a[0] as number) / (a[1] as number)) },
};

export type ExprNode =
  | { kind: "number"; value: number }
  | { kind: "ident"; name: ViewColumnKey }
  | { kind: "neg"; operand: ExprNode }
  | { kind: "bin"; op: "+" | "-" | "*" | "/"; left: ExprNode; right: ExprNode }
  | { kind: "call"; fn: string; args: ExprNode[] };

type Token =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: "+" | "-" | "*" | "/" | "(" | ")" | "," }
  | { t: "end" };

const MAX_EXPRESSION_LENGTH = 400;

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9._]/.test(src[j] as string)) j += 1;
      const raw = src.slice(i, j).replace(/_/g, "");
      const value = Number(raw);
      if (!Number.isFinite(value) || raw === "." || (raw.match(/\./g) ?? []).length > 1) {
        throw new Error(`"${src.slice(i, j)}" is not a number`);
      }
      out.push({ t: "num", v: value });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      out.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/(),".includes(c)) {
      out.push({ t: "op", v: c as "+" | "-" | "*" | "/" | "(" | ")" | "," });
      i += 1;
      continue;
    }
    throw new Error(`Unexpected character "${c}" at position ${i + 1}`);
  }
  out.push({ t: "end" });
  return out;
}

/**
 * Parse an expression into an AST, refusing anything outside the grammar:
 *
 *   expr   := term (('+'|'-') term)*
 *   term   := unary (('*'|'/') unary)*
 *   unary  := '-' unary | primary
 *   primary:= number | ident | ident '(' args ')' | '(' expr ')'
 */
export function parseExpression(src: string): ExprNode {
  if (typeof src !== "string" || src.trim() === "") throw new Error("Expression is empty");
  if (src.length > MAX_EXPRESSION_LENGTH) {
    throw new Error(`Expression exceeds ${MAX_EXPRESSION_LENGTH} characters`);
  }
  const tokens = tokenize(src);
  let pos = 0;
  const peek = (): Token => tokens[pos] as Token;
  const next = (): Token => tokens[pos++] as Token;
  const expectOp = (v: string): void => {
    const tok = next();
    if (tok.t !== "op" || tok.v !== v) throw new Error(`Expected "${v}"`);
  };

  function primary(): ExprNode {
    const tok = next();
    if (tok.t === "num") return { kind: "number", value: tok.v };
    if (tok.t === "id") {
      const look = peek();
      if (look.t === "op" && look.v === "(") {
        next();
        const fn = FUNCTIONS[tok.v];
        if (!fn) throw new Error(`Unknown function "${tok.v}"`);
        const args: ExprNode[] = [];
        if (!(peek().t === "op" && (peek() as { v: string }).v === ")")) {
          args.push(expr());
          while (peek().t === "op" && (peek() as { v: string }).v === ",") {
            next();
            args.push(expr());
          }
        }
        expectOp(")");
        if (fn.arity >= 0 && args.length !== fn.arity) {
          throw new Error(`${tok.v}() takes ${fn.arity} argument(s), got ${args.length}`);
        }
        if (fn.arity < 0 && args.length === 0) {
          throw new Error(`${tok.v}() needs at least one argument`);
        }
        return { kind: "call", fn: tok.v, args };
      }
      if (!(VIEW_COLUMN_KEYS as readonly string[]).includes(tok.v)) {
        throw new Error(
          `"${tok.v}" is not a budget column. Available: ${VIEW_COLUMN_KEYS.join(", ")}`,
        );
      }
      return { kind: "ident", name: tok.v as ViewColumnKey };
    }
    if (tok.t === "op" && tok.v === "(") {
      const inner = expr();
      expectOp(")");
      return inner;
    }
    if (tok.t === "op" && tok.v === "-") {
      return { kind: "neg", operand: unary() };
    }
    throw new Error(tok.t === "end" ? "Unexpected end of expression" : `Unexpected "${tok.v}"`);
  }

  function unary(): ExprNode {
    const tok = peek();
    if (tok.t === "op" && tok.v === "-") {
      next();
      return { kind: "neg", operand: unary() };
    }
    return primary();
  }

  function term(): ExprNode {
    let left = unary();
    for (;;) {
      const tok = peek();
      if (tok.t === "op" && (tok.v === "*" || tok.v === "/")) {
        next();
        left = { kind: "bin", op: tok.v, left, right: unary() };
      } else {
        return left;
      }
    }
  }

  function expr(): ExprNode {
    let left = term();
    for (;;) {
      const tok = peek();
      if (tok.t === "op" && (tok.v === "+" || tok.v === "-")) {
        next();
        left = { kind: "bin", op: tok.v, left, right: term() };
      } else {
        return left;
      }
    }
  }

  const tree = expr();
  if (peek().t !== "end") throw new Error(`Unexpected "${(peek() as { v: string }).v}"`);
  return tree;
}

export interface EvalResult {
  value: number | null;
  /** why the value is null; empty when it was computed */
  reasons: string[];
}

/** Evaluate an AST over one line's columns. Null propagates with its reason. */
export function evaluateExpression(
  node: ExprNode,
  columns: Partial<Record<ViewColumnKey, number | null | undefined>>,
): EvalResult {
  const reasons: string[] = [];
  const walk = (n: ExprNode): number | null => {
    switch (n.kind) {
      case "number":
        return n.value;
      case "ident": {
        const v = columns[n.name];
        if (typeof v !== "number" || !Number.isFinite(v)) {
          reasons.push(`${n.name} is not recorded on this line.`);
          return null;
        }
        return v;
      }
      case "neg": {
        const v = walk(n.operand);
        return v === null ? null : -v;
      }
      case "bin": {
        const l = walk(n.left);
        const r = walk(n.right);
        if (l === null || r === null) return null;
        if (n.op === "/") {
          if (r === 0) {
            reasons.push("Division by zero — the denominator is 0 on this line.");
            return null;
          }
          return l / r;
        }
        if (n.op === "*") return l * r;
        if (n.op === "+") return l + r;
        return l - r;
      }
      case "call": {
        const fn = FUNCTIONS[n.fn];
        if (!fn) {
          reasons.push(`Unknown function ${n.fn}`);
          return null;
        }
        const args: number[] = [];
        for (const a of n.args) {
          const v = walk(a);
          if (v === null) return null;
          args.push(v);
        }
        const out = fn.apply(args);
        if (out === null) reasons.push(`${n.fn}() is undefined for these inputs (division by zero).`);
        return out;
      }
      default: {
        const never: never = n;
        reasons.push(`Unknown node ${String(never)}`);
        return null;
      }
    }
  };
  const value = walk(node);
  if (value === null) return { value: null, reasons };
  if (!Number.isFinite(value)) return { value: null, reasons: ["The result is not a finite number."] };
  return { value: Math.round(value * 10000) / 10000, reasons: [] };
}

/** The columns an expression reads — for the view's dependency list. */
export function expressionColumns(node: ExprNode): ViewColumnKey[] {
  const out = new Set<ViewColumnKey>();
  const walk = (n: ExprNode): void => {
    if (n.kind === "ident") out.add(n.name);
    else if (n.kind === "neg") walk(n.operand);
    else if (n.kind === "bin") {
      walk(n.left);
      walk(n.right);
    } else if (n.kind === "call") n.args.forEach(walk);
  };
  walk(node);
  return [...out];
}

export interface CalculatedFieldSpec {
  key: string;
  label: string;
  expression: string;
  format: "currency" | "number" | "percent";
}

const KEY_PATTERN = /^[a-z][a-zA-Z0-9_]{0,39}$/;

/**
 * Validate a set of calculated fields as a whole: keys are identifiers that do
 * not shadow a stored column, are unique, and every expression parses.
 * Returns the parsed trees keyed by field so a caller evaluates once per row.
 */
export function compileCalculatedFields(
  raw: unknown,
): { fields: Array<CalculatedFieldSpec & { tree: ExprNode; reads: ViewColumnKey[] }>; errors: string[] } {
  const errors: string[] = [];
  const fields: Array<CalculatedFieldSpec & { tree: ExprNode; reads: ViewColumnKey[] }> = [];
  if (!Array.isArray(raw)) return { fields, errors: raw === undefined ? [] : ["calculatedFields must be an array"] };
  const seen = new Set<string>();
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object") {
      errors.push(`Field ${i + 1}: not an object`);
      continue;
    }
    const f = item as Record<string, unknown>;
    const key = typeof f["key"] === "string" ? f["key"] : "";
    const label = typeof f["label"] === "string" && f["label"].trim() !== "" ? f["label"] : key;
    const expression = typeof f["expression"] === "string" ? f["expression"] : "";
    const format = f["format"] === "number" || f["format"] === "percent" ? f["format"] : "currency";
    if (!KEY_PATTERN.test(key)) {
      errors.push(`Field ${i + 1}: key "${key}" must be an identifier (letters, digits, _; 40 max)`);
      continue;
    }
    if ((VIEW_COLUMN_KEYS as readonly string[]).includes(key)) {
      errors.push(`Field "${key}" shadows a stored budget column`);
      continue;
    }
    if (seen.has(key)) {
      errors.push(`Field "${key}" is defined twice`);
      continue;
    }
    seen.add(key);
    try {
      const tree = parseExpression(expression);
      fields.push({ key, label, expression, format, tree, reads: expressionColumns(tree) });
    } catch (err) {
      errors.push(`Field "${key}": ${err instanceof Error ? err.message : "invalid expression"}`);
    }
  }
  return { fields, errors };
}

/** Evaluate every compiled field for one line. */
export function evaluateFields(
  fields: ReadonlyArray<CalculatedFieldSpec & { tree: ExprNode }>,
  columns: Partial<Record<ViewColumnKey, number | null | undefined>>,
): Record<string, EvalResult> {
  const out: Record<string, EvalResult> = {};
  for (const f of fields) out[f.key] = evaluateExpression(f.tree, columns);
  return out;
}
