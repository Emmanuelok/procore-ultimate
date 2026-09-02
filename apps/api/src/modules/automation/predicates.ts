/**
 * Safe predicate evaluator for automation rules (Vol I #82 conditional
 * branching on field values, #79–92).
 *
 * WHAT IT IS
 * A condition is a small tree: leaves are `{ field, op, value }` and branches
 * are `{ all: [...] }`, `{ any: [...] }`, `{ not: ... }`. Fields are dotted
 * paths into the evaluation context — `record.status`, `event.action`,
 * `record.dueDate` — resolved by walking plain objects. There is no
 * expression language, no template strings, and no `eval` anywhere: the
 * only things a rule author can make the engine do are the operators listed
 * in AUTOMATION_CONDITION_OPERATORS, over values the engine loaded itself.
 *
 * Every leaf evaluation is recorded (expected, actual, result) so a run can
 * show WHY it matched or did not — the "show the why" rule applies to the
 * automation log as much as to any computed figure.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * No cross-record lookups, no arithmetic between fields, no side effects.
 * Date operators compare against `now` supplied by the caller so evaluation
 * is deterministic under test.
 */
import type {
  AutomationConditionEvaluation,
  AutomationConditionJson,
  AutomationConditionLeaf,
  AutomationConditionResult,
} from "@constructos/db";
import { AUTOMATION_CONDITION_OPERATORS } from "@constructos/shared";

export interface EvaluationContext {
  event: Record<string, unknown> | null;
  record: Record<string, unknown> | null;
  /** ISO timestamp the evaluation is "at" */
  now: string;
  /** free-form extras a caller wants addressable (e.g. `project.name`) */
  [key: string]: unknown;
}

const MAX_DEPTH = 12;
const MAX_LEAVES = 200;
const DAY_MS = 86_400_000;

/** Walk a dotted path over plain objects and arrays. Never throws. */
export function getPath(root: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
      continue;
    }
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function isLeaf(node: AutomationConditionJson): node is AutomationConditionLeaf {
  return typeof (node as AutomationConditionLeaf).field === "string";
}

/** Structural validation: shape, depth, leaf count and operator names. */
export function validateCondition(
  node: unknown,
  depth = 0,
  counter = { leaves: 0 },
): string | null {
  if (depth > MAX_DEPTH) return `condition nesting deeper than ${MAX_DEPTH}`;
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return "condition must be an object";
  }
  const n = node as Record<string, unknown>;
  if (typeof n["field"] === "string") {
    counter.leaves += 1;
    if (counter.leaves > MAX_LEAVES) return `more than ${MAX_LEAVES} conditions`;
    const field = n["field"] as string;
    if (field.length === 0 || field.length > 200 || !/^[A-Za-z0-9_.]+$/.test(field)) {
      return `invalid field path "${field}"`;
    }
    const op = n["op"];
    if (typeof op !== "string" || !(AUTOMATION_CONDITION_OPERATORS as readonly string[]).includes(op)) {
      return `unknown operator "${String(op)}" on field "${field}"`;
    }
    return null;
  }
  for (const key of ["all", "any"] as const) {
    if (key in n) {
      const list = n[key];
      if (!Array.isArray(list)) return `"${key}" must be an array`;
      if (list.length === 0) return `"${key}" must not be empty`;
      for (const child of list) {
        const err = validateCondition(child, depth + 1, counter);
        if (err) return err;
      }
      return null;
    }
  }
  if ("not" in n) return validateCondition(n["not"], depth + 1, counter);
  return 'condition must be a leaf {field, op, value} or a group {all|any|not}';
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
}

function toDateMs(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  // A bare ISO date is a calendar day, not an instant: pin it to UTC midnight
  // so "2026-01-01" compares the same on every server.
  const s = v.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function equalish(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === "number" || typeof b === "number") {
    const na = toNumber(a);
    const nb = toNumber(b);
    if (na !== null && nb !== null) return na === nb;
  }
  if (typeof a === "boolean" || typeof b === "boolean") {
    return String(a) === String(b);
  }
  return String(a) === String(b);
}

function compareNumbers(a: unknown, b: unknown): number | null {
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== null && nb !== null) return na - nb;
  const da = toDateMs(a);
  const db = toDateMs(b);
  if (da !== null && db !== null) return da - db;
  return null;
}

function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    return v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }
  if (v === null || v === undefined) return [];
  return [v];
}

function containsValue(haystack: unknown, needle: unknown): boolean {
  if (Array.isArray(haystack)) return haystack.some((x) => equalish(x, needle));
  if (typeof haystack === "string") return haystack.toLowerCase().includes(String(needle).toLowerCase());
  if (haystack && typeof haystack === "object") {
    return Object.prototype.hasOwnProperty.call(haystack, String(needle));
  }
  return false;
}

function safeRegex(pattern: unknown): RegExp | null {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 200) return null;
  // Reject the shapes that drive catastrophic backtracking: a quantified
  // group, stacked quantifiers, and lookbehind/named-group syntax.
  if (/\)[+*{]/.test(pattern) || /[+*}]\s*[+*{]/.test(pattern) || /\(\?[^:=!]/.test(pattern)) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

/** Evaluate one operator. Pure; never throws. */
export function evaluateLeaf(
  op: string,
  actual: unknown,
  expected: unknown,
  nowMs: number,
): boolean {
  switch (op) {
    case "eq":
      return equalish(actual, expected);
    case "neq":
      return !equalish(actual, expected);
    case "gt": {
      const c = compareNumbers(actual, expected);
      return c !== null && c > 0;
    }
    case "gte": {
      const c = compareNumbers(actual, expected);
      return c !== null && c >= 0;
    }
    case "lt": {
      const c = compareNumbers(actual, expected);
      return c !== null && c < 0;
    }
    case "lte": {
      const c = compareNumbers(actual, expected);
      return c !== null && c <= 0;
    }
    case "in":
      return asList(expected).some((x) => equalish(actual, x));
    case "not_in":
      return !asList(expected).some((x) => equalish(actual, x));
    case "contains":
      return containsValue(actual, expected);
    case "not_contains":
      return !containsValue(actual, expected);
    case "starts_with":
      return typeof actual === "string" && actual.toLowerCase().startsWith(String(expected).toLowerCase());
    case "ends_with":
      return typeof actual === "string" && actual.toLowerCase().endsWith(String(expected).toLowerCase());
    case "exists":
      return actual !== null && actual !== undefined && actual !== "";
    case "not_exists":
      return actual === null || actual === undefined || actual === "";
    case "is_true":
      return actual === true || actual === 1 || actual === "true" || actual === "1";
    case "is_false":
      return actual === false || actual === 0 || actual === "false" || actual === "0";
    case "matches": {
      const re = safeRegex(expected);
      return re !== null && typeof actual === "string" && re.test(actual);
    }
    case "before": {
      const a = toDateMs(actual);
      const b = toDateMs(expected);
      return a !== null && b !== null && a < b;
    }
    case "after": {
      const a = toDateMs(actual);
      const b = toDateMs(expected);
      return a !== null && b !== null && a > b;
    }
    case "within_days": {
      // |actual - now| <= N days
      const a = toDateMs(actual);
      const n = toNumber(expected);
      return a !== null && n !== null && Math.abs(a - nowMs) <= n * DAY_MS;
    }
    case "older_than_days": {
      // now - actual > N days (the record is at least N days old)
      const a = toDateMs(actual);
      const n = toNumber(expected);
      return a !== null && n !== null && nowMs - a > n * DAY_MS;
    }
    case "due_within_days": {
      // 0 <= actual - now <= N days (deadline approaching, not yet passed)
      const a = toDateMs(actual);
      const n = toNumber(expected);
      if (a === null || n === null) return false;
      const delta = a - nowMs;
      return delta >= 0 && delta <= n * DAY_MS;
    }
    case "overdue_by_days": {
      // now - actual >= N days (deadline passed at least N days ago)
      const a = toDateMs(actual);
      const n = toNumber(expected);
      return a !== null && n !== null && nowMs - a >= n * DAY_MS;
    }
    default:
      return false;
  }
}

/**
 * Evaluate a condition tree. `null` means "no conditions" and matches.
 * Returns the verdict plus every leaf evaluation so the run log can show
 * the why.
 */
export function evaluateCondition(
  node: AutomationConditionJson | null | undefined,
  ctx: EvaluationContext,
): AutomationConditionResult {
  if (node === null || node === undefined) {
    return { matched: true, evaluations: null, reason: "No conditions — every trigger fires." };
  }
  const nowMs = toDateMs(ctx.now) ?? Date.now();
  const evaluations: AutomationConditionEvaluation[] = [];

  const walk = (n: AutomationConditionJson, depth: number): boolean => {
    if (depth > MAX_DEPTH) return false;
    if (isLeaf(n)) {
      const actual = getPath(ctx, n.field);
      const result = evaluateLeaf(n.op, actual, n.value, nowMs);
      evaluations.push({ field: n.field, op: n.op, expected: n.value ?? null, actual: actual ?? null, result });
      return result;
    }
    if ("all" in n) return n.all.every((c) => walk(c, depth + 1));
    if ("any" in n) return n.any.some((c) => walk(c, depth + 1));
    if ("not" in n) return !walk(n.not, depth + 1);
    return false;
  };

  const matched = walk(node, 0);
  const failing = evaluations.filter((e) => !e.result);
  const reason = matched
    ? `${evaluations.length} condition${evaluations.length === 1 ? "" : "s"} evaluated; matched.`
    : failing.length > 0
      ? `Did not match: ${failing
          .slice(0, 3)
          .map((e) => `${e.field} ${e.op} ${JSON.stringify(e.expected)} (was ${JSON.stringify(e.actual)})`)
          .join("; ")}${failing.length > 3 ? ` and ${failing.length - 3} more` : ""}.`
      : "Did not match.";
  return { matched, evaluations, reason };
}

/** Every field path a condition tree references — used by the builder and the dry run. */
export function referencedFields(node: AutomationConditionJson | null | undefined): string[] {
  const out = new Set<string>();
  const walk = (n: AutomationConditionJson | null | undefined, depth: number) => {
    if (!n || depth > MAX_DEPTH) return;
    if (isLeaf(n)) {
      out.add(n.field);
      return;
    }
    if ("all" in n) n.all.forEach((c) => walk(c, depth + 1));
    else if ("any" in n) n.any.forEach((c) => walk(c, depth + 1));
    else if ("not" in n) walk(n.not, depth + 1);
  };
  walk(node, 0);
  return [...out];
}
