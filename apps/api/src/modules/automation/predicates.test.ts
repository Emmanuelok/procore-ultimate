import { describe, expect, it } from "vitest";
import {
  evaluateCondition,
  evaluateLeaf,
  getPath,
  referencedFields,
  validateCondition,
  type EvaluationContext,
} from "./predicates.js";

const NOW = "2026-09-01T12:00:00.000Z";
const nowMs = Date.parse(NOW);

function ctx(record: Record<string, unknown>, extra: Partial<EvaluationContext> = {}): EvaluationContext {
  return { event: { action: "create", objectType: "rfi" }, record, now: NOW, ...extra };
}

describe("getPath", () => {
  it("walks nested objects and arrays and never throws", () => {
    const root = { record: { a: { b: [1, { c: "x" }] } } };
    expect(getPath(root, "record.a.b.1.c")).toBe("x");
    expect(getPath(root, "record.a.b.0")).toBe(1);
    expect(getPath(root, "record.missing.deep")).toBeUndefined();
    expect(getPath(root, "record.a.b.notanumber")).toBeUndefined();
    expect(getPath(null, "x")).toBeUndefined();
    expect(getPath(root, "")).toBeUndefined();
  });
});

describe("evaluateLeaf operators", () => {
  it("equality is tolerant of numeric strings and booleans", () => {
    expect(evaluateLeaf("eq", "3", 3, nowMs)).toBe(true);
    // the platform stores booleans as 0/1 integers, so 1 and true agree
    expect(evaluateLeaf("eq", 1, true, nowMs)).toBe(true);
    expect(evaluateLeaf("eq", 0, true, nowMs)).toBe(false);
    expect(evaluateLeaf("eq", true, "true", nowMs)).toBe(true);
    expect(evaluateLeaf("neq", "open", "closed", nowMs)).toBe(true);
    expect(evaluateLeaf("eq", null, undefined, nowMs)).toBe(false);
  });

  it("orders numbers and dates, and refuses incomparable pairs", () => {
    expect(evaluateLeaf("gt", 10, 5, nowMs)).toBe(true);
    expect(evaluateLeaf("gte", "10", 10, nowMs)).toBe(true);
    expect(evaluateLeaf("lt", "2026-01-01", "2026-02-01", nowMs)).toBe(true);
    expect(evaluateLeaf("lte", "abc", 5, nowMs)).toBe(false);
    expect(evaluateLeaf("gt", null, 5, nowMs)).toBe(false);
  });

  it("handles list membership and containment", () => {
    expect(evaluateLeaf("in", "open", ["open", "draft"], nowMs)).toBe(true);
    expect(evaluateLeaf("in", "open", "open, draft", nowMs)).toBe(true);
    expect(evaluateLeaf("not_in", "closed", ["open"], nowMs)).toBe(true);
    expect(evaluateLeaf("contains", ["a", "b"], "b", nowMs)).toBe(true);
    expect(evaluateLeaf("contains", "Rebar spacing", "rebar", nowMs)).toBe(true);
    expect(evaluateLeaf("not_contains", { k: 1 }, "z", nowMs)).toBe(true);
    expect(evaluateLeaf("starts_with", "S-201", "s-", nowMs)).toBe(true);
    expect(evaluateLeaf("ends_with", "S-201", "01", nowMs)).toBe(true);
  });

  it("existence and truthiness operators read the platform's 0/1 integers", () => {
    expect(evaluateLeaf("exists", "", null, nowMs)).toBe(false);
    expect(evaluateLeaf("exists", 0, null, nowMs)).toBe(true);
    expect(evaluateLeaf("not_exists", null, null, nowMs)).toBe(true);
    expect(evaluateLeaf("is_true", 1, null, nowMs)).toBe(true);
    expect(evaluateLeaf("is_true", "1", null, nowMs)).toBe(true);
    expect(evaluateLeaf("is_false", 0, null, nowMs)).toBe(true);
    expect(evaluateLeaf("is_false", null, null, nowMs)).toBe(false);
  });

  it("matches with a bounded regex and rejects catastrophic patterns", () => {
    expect(evaluateLeaf("matches", "RFI-0042", "^rfi-\\d+$", nowMs)).toBe(true);
    expect(evaluateLeaf("matches", "aaaa", "(a+)+$", nowMs)).toBe(false);
    expect(evaluateLeaf("matches", "x", "[", nowMs)).toBe(false);
    expect(evaluateLeaf("matches", 12, "1", nowMs)).toBe(false);
  });

  it("date arithmetic is relative to the supplied now", () => {
    expect(evaluateLeaf("before", "2026-08-01", NOW, nowMs)).toBe(true);
    expect(evaluateLeaf("after", "2026-10-01", NOW, nowMs)).toBe(true);
    // due in 3 days
    expect(evaluateLeaf("due_within_days", "2026-09-04", 5, nowMs)).toBe(true);
    expect(evaluateLeaf("due_within_days", "2026-09-04", 2, nowMs)).toBe(false);
    // already passed: not "due within"
    expect(evaluateLeaf("due_within_days", "2026-08-30", 5, nowMs)).toBe(false);
    // overdue by 3.5 days
    expect(evaluateLeaf("overdue_by_days", "2026-08-29", 3, nowMs)).toBe(true);
    expect(evaluateLeaf("overdue_by_days", "2026-08-31", 3, nowMs)).toBe(false);
    expect(evaluateLeaf("older_than_days", "2026-08-01T00:00:00Z", 14, nowMs)).toBe(true);
    expect(evaluateLeaf("within_days", "2026-09-02", 1, nowMs)).toBe(true);
    expect(evaluateLeaf("within_days", "not-a-date", 1, nowMs)).toBe(false);
    expect(evaluateLeaf("overdue_by_days", null, 3, nowMs)).toBe(false);
  });

  it("unknown operators never match", () => {
    expect(evaluateLeaf("eval", "x", "x", nowMs)).toBe(false);
  });
});

describe("evaluateCondition", () => {
  it("null conditions match everything and say so", () => {
    const r = evaluateCondition(null, ctx({}));
    expect(r.matched).toBe(true);
    expect(r.evaluations).toBeNull();
  });

  it("composes all / any / not and records every leaf", () => {
    const r = evaluateCondition(
      {
        all: [
          { field: "record.status", op: "eq", value: "open" },
          { any: [{ field: "record.dueDate", op: "overdue_by_days", value: 3 }, { field: "record.priority", op: "eq", value: "high" }] },
          { not: { field: "record.assigneeId", op: "not_exists" } },
        ],
      },
      ctx({ status: "open", dueDate: "2026-08-20", priority: "low", assigneeId: "usr_1" }),
    );
    expect(r.matched).toBe(true);
    // `any` short-circuits on its first true leaf, so only 3 of 4 leaves are logged
    expect(r.evaluations?.length).toBe(3);
    expect(r.evaluations?.[1]?.result).toBe(true);
    expect(r.reason).toContain("matched");
  });

  it("explains a miss with the failing leaves", () => {
    const r = evaluateCondition(
      { all: [{ field: "record.status", op: "eq", value: "open" }, { field: "record.total", op: "gte", value: 100000 }] },
      ctx({ status: "open", total: 500 }),
    );
    expect(r.matched).toBe(false);
    expect(r.reason).toContain("record.total gte 100000");
    expect(r.reason).toContain("was 500");
  });

  it("reads event and derived roots", () => {
    const r = evaluateCondition(
      { all: [{ field: "event.action", op: "eq", value: "create" }, { field: "derived.vendorInsuranceValid", op: "is_false" }] },
      ctx({}, { derived: { vendorInsuranceValid: false } }),
    );
    expect(r.matched).toBe(true);
  });
});

describe("validateCondition", () => {
  it("accepts well-formed trees", () => {
    expect(validateCondition({ field: "record.status", op: "eq", value: "open" })).toBeNull();
    expect(validateCondition({ all: [{ field: "a", op: "exists" }, { not: { field: "b", op: "is_true" } }] })).toBeNull();
  });

  it("rejects unknown operators, bad paths, empty groups and wrong shapes", () => {
    expect(validateCondition({ field: "record.status", op: "eval", value: "x" })).toMatch(/unknown operator/);
    expect(validateCondition({ field: "record.status; drop", op: "eq" })).toMatch(/invalid field path/);
    expect(validateCondition({ all: [] })).toMatch(/must not be empty/);
    expect(validateCondition({ any: "nope" })).toMatch(/must be an array/);
    expect(validateCondition("string")).toMatch(/must be an object/);
    expect(validateCondition({ something: 1 })).toMatch(/leaf/);
  });

  it("bounds nesting depth", () => {
    let node: unknown = { field: "a", op: "exists" };
    for (let i = 0; i < 20; i += 1) node = { not: node };
    expect(validateCondition(node)).toMatch(/deeper/);
  });
});

describe("referencedFields", () => {
  it("lists every distinct path", () => {
    expect(
      referencedFields({
        all: [{ field: "record.a", op: "exists" }, { any: [{ field: "record.b", op: "exists" }, { field: "record.a", op: "exists" }] }],
      }).sort(),
    ).toEqual(["record.a", "record.b"]);
    expect(referencedFields(null)).toEqual([]);
  });
});
