import { describe, expect, it } from "vitest";
import {
  addDays,
  buildGraph,
  buildGroups,
  conditionOutcome,
  groupSettled,
  planGroup,
  stepDates,
  stepsSchema,
  unresolvedConditionFields,
  type StepDef,
} from "./engine.js";

const user = (name: string, extra: Partial<StepDef> = {}): StepDef => ({
  name,
  type: "approval",
  assigneeIds: ["u1"],
  ...extra,
});

const resolveAll = (step: StepDef) => ({ ids: step.assigneeIds ?? [] });

describe("stepsSchema", () => {
  it("accepts explicit assignees, a role or a group", () => {
    expect(stepsSchema.safeParse([user("A")]).success).toBe(true);
    expect(
      stepsSchema.safeParse([{ name: "A", type: "approval", role: "project_manager" }]).success,
    ).toBe(true);
    expect(stepsSchema.safeParse([{ name: "A", type: "approval", groupId: "dg1" }]).success).toBe(
      true,
    );
  });

  it("refuses a step that names nobody", () => {
    expect(stepsSchema.safeParse([{ name: "A", type: "approval" }]).success).toBe(false);
    expect(
      stepsSchema.safeParse([{ name: "A", type: "approval", assigneeIds: [] }]).success,
    ).toBe(false);
  });
});

describe("buildGroups", () => {
  it("puts a consecutive run of parallel steps into one group", () => {
    const groups = buildGroups([
      user("first"),
      user("p1", { parallel: true }),
      user("p2", { parallel: true }),
      user("last"),
    ]);
    expect(groups.map((g) => g.length)).toEqual([1, 2, 1]);
  });

  it("does not merge a parallel step onto a preceding sequential one", () => {
    const groups = buildGroups([user("first"), user("p1", { parallel: true })]);
    expect(groups.map((g) => g.map((s) => s.name))).toEqual([["first"], ["p1"]]);
  });
});

describe("conditionOutcome — the fail-closed rule", () => {
  it("includes a step with no condition", () => {
    expect(conditionOutcome(undefined, {})).toBe("include");
  });

  it("reports UNRESOLVED for a field the context does not carry", () => {
    // This is the bug that let a cost-threshold approval be skipped simply by
    // starting the workflow without `cost` in the payload.
    expect(conditionOutcome({ field: "cost", op: "gt", value: 1000 }, {})).toBe("unresolved");
  });

  it("reports UNRESOLVED for a non-numeric value in a numeric comparison", () => {
    expect(conditionOutcome({ field: "cost", op: "gt", value: 1000 }, { cost: "banana" })).toBe(
      "unresolved",
    );
  });

  it("coerces a numeric string, because form inputs hand back strings", () => {
    expect(conditionOutcome({ field: "cost", op: "gt", value: 1000 }, { cost: "5000" })).toBe(
      "include",
    );
  });

  it("evaluates every operator", () => {
    expect(conditionOutcome({ field: "s", op: "eq", value: "a" }, { s: "a" })).toBe("include");
    expect(conditionOutcome({ field: "s", op: "ne", value: "a" }, { s: "a" })).toBe("skip");
    expect(conditionOutcome({ field: "n", op: "gte", value: 5 }, { n: 5 })).toBe("include");
    expect(conditionOutcome({ field: "n", op: "lte", value: 5 }, { n: 6 })).toBe("skip");
    expect(conditionOutcome({ field: "n", op: "lt", value: 5 }, { n: 4 })).toBe("include");
    expect(conditionOutcome({ field: "s", op: "in", value: ["a", "b"] }, { s: "b" })).toBe(
      "include",
    );
    expect(conditionOutcome({ field: "s", op: "not_in", value: ["a", "b"] }, { s: "b" })).toBe(
      "skip",
    );
  });

  it("treats `exists` as answerable even when the field is absent", () => {
    expect(conditionOutcome({ field: "x", op: "exists", value: true }, {})).toBe("skip");
    expect(conditionOutcome({ field: "x", op: "exists", value: false }, {})).toBe("include");
    expect(conditionOutcome({ field: "x", op: "exists", value: true }, { x: "" })).toBe("skip");
  });

  it("refuses to guess an `in` comparison against a non-array", () => {
    expect(conditionOutcome({ field: "s", op: "in", value: "a" }, { s: "a" })).toBe("unresolved");
  });
});

describe("unresolvedConditionFields", () => {
  it("names the fields a caller must supply", () => {
    const steps = [
      user("cost gate", { condition: { field: "cost", op: "gt", value: 1000 } }),
      user("status gate", { condition: { field: "status", op: "eq", value: "open" } }),
    ];
    expect(unresolvedConditionFields(steps, { status: "open" })).toEqual(["cost"]);
    expect(unresolvedConditionFields(steps, { status: "open", cost: 10 })).toEqual([]);
  });
});

describe("planGroup", () => {
  it("creates a pending step for an unresolvable condition — it does NOT skip it", () => {
    const { plan } = planGroup(
      [user("cost gate", { condition: { field: "cost", op: "gt", value: 1000 } })],
      0,
      {},
      resolveAll,
    );
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.skipped).toBe(false);
  });

  it("skips a step whose condition is answered false", () => {
    const { plan } = planGroup(
      [user("cost gate", { condition: { field: "cost", op: "gt", value: 1000 } })],
      0,
      { cost: 10 },
      resolveAll,
    );
    expect(plan.steps[0]!.skipped).toBe(true);
    expect(plan.fullySkipped).toBe(true);
  });

  it("de-duplicates an approver named twice in one parallel group", () => {
    const { plan } = planGroup(
      [
        { name: "A", type: "approval", assigneeIds: ["u1", "u2"], parallel: true },
        { name: "B", type: "approval", assigneeIds: ["u2"], parallel: true },
      ],
      0,
      {},
      resolveAll,
    );
    expect(plan.steps.map((s) => s.assigneeId)).toEqual(["u1", "u2"]);
  });

  it("reports an unresolvable assignee rather than dropping the approval", () => {
    const { plan, unresolvable } = planGroup(
      [{ name: "PM approval", type: "approval", role: "project_manager" }],
      0,
      {},
      () => ({ ids: [], reason: "no project member holds the role" }),
    );
    expect(plan.steps).toHaveLength(0);
    expect(unresolvable).toEqual([
      { step: "PM approval", reason: "no project member holds the role" },
    ]);
  });

  it("records how each assignee was chosen", () => {
    const { plan } = planGroup(
      [{ name: "PM approval", type: "approval", role: "project_manager" }],
      1,
      {},
      () => ({ ids: ["pm1"] }),
    );
    expect(plan.steps[0]).toMatchObject({
      assignedVia: "role",
      assignedViaKey: "project_manager",
      assigneeId: "pm1",
    });
    expect(plan.position).toBe(1);
  });
});

describe("groupSettled", () => {
  it("ALL-of waits for every step", () => {
    expect(
      groupSettled([
        { decision: "approved", quorum: "all" },
        { decision: "pending", quorum: "all" },
      ]),
    ).toEqual({ settled: false, withdrawRemaining: false });
  });

  it("ANY-of settles on the first decision and withdraws the rest", () => {
    expect(
      groupSettled([
        { decision: "approved", quorum: "any" },
        { decision: "pending", quorum: "any" },
      ]),
    ).toEqual({ settled: true, withdrawRemaining: true });
  });

  it("an empty group is settled", () => {
    expect(groupSettled([])).toEqual({ settled: true, withdrawRemaining: false });
  });
});

describe("dates", () => {
  it("adds whole days in UTC without timezone drift", () => {
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("computes due and escalation dates only when the step asks for them", () => {
    expect(stepDates("2026-06-01", { dueInDays: 3, escalateAfterDays: 5 })).toEqual({
      dueDate: "2026-06-04",
      escalateAt: "2026-06-06",
    });
    expect(stepDates("2026-06-01", { dueInDays: null, escalateAfterDays: null })).toEqual({
      dueDate: null,
      escalateAt: null,
    });
  });
});

describe("buildGraph", () => {
  const groups = buildGroups([
    user("first"),
    user("p1", { parallel: true }),
    user("p2", { parallel: true }),
  ]);
  const row = (over: Record<string, unknown>) => ({
    id: "s",
    position: 0,
    name: "first",
    stepType: "approval",
    assigneeId: "u1",
    delegatedToId: null,
    assignedVia: "user",
    assignedViaKey: null,
    decision: "pending",
    dueDate: null,
    escalateAt: null,
    escalatedAt: null,
    decidedAt: null,
    comments: null,
    ...over,
  });

  it("labels the active column and marks the finished ones done", () => {
    const nodes = buildGraph(
      groups,
      [
        row({ id: "a", position: 0, decision: "approved" }),
        row({ id: "b", position: 1, name: "p1" }),
        row({ id: "c", position: 1, name: "p2" }),
      ],
      1,
      "running",
    );
    expect(nodes.map((n) => n.state)).toEqual(["done", "active"]);
    expect(nodes[1]!.parallel).toBe(true);
    expect(nodes[1]!.label).toBe("p1 · p2");
  });

  it("marks a rejected column and a fully skipped one", () => {
    const nodes = buildGraph(
      groups,
      [
        row({ id: "a", position: 0, decision: "rejected" }),
        row({ id: "b", position: 1, decision: "skipped" }),
        row({ id: "c", position: 1, decision: "skipped" }),
      ],
      0,
      "rejected",
    );
    expect(nodes[0]!.state).toBe("rejected");
    expect(nodes[1]!.state).toBe("skipped");
  });

  it("shows a column with no rows yet as pending, never as done", () => {
    const nodes = buildGraph(groups, [row({ id: "a", position: 0, decision: "approved" })], 0, "running");
    expect(nodes[1]!.state).toBe("pending");
  });
});
