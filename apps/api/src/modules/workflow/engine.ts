/**
 * The workflow engine — pure decision logic, no database.
 *
 * Covers Vol I §0.4 #79–#92: ordered and parallel steps (#81), conditional
 * branching on the record's own field values (#82), role- and group-based
 * assignment (#83), due dates and escalation (#85), template versioning (#89)
 * and the visualisation payload (#91).
 *
 * WHY IT IS ITS OWN FILE
 * The previous engine lived inside the route handlers, and three of its four
 * defects were decisions rather than plumbing:
 *
 *   • an unreadable step snapshot produced zero groups, and zero groups was
 *     read as "everything is decided" — approving the whole instance from a
 *     single click. `planFrom` now distinguishes "no more groups" from "the
 *     snapshot could not be read" and the caller must handle the latter.
 *   • a condition on a field the caller simply omitted evaluated to false via
 *     `Number(undefined) > 1000`, so a cost-threshold approval was skipped by
 *     leaving `cost` out of the request. `conditionOutcome` returns
 *     `unresolved` for that case and the engine FAILS CLOSED — the step is
 *     created pending, never skipped.
 *   • the same approver appearing twice in one parallel group created two
 *     step rows for one person.
 *
 * All three are now testable without a database, which is the point.
 */
import { z } from "zod";
import {
  WORKFLOW_STEP_TYPES,
  WORKFLOW_CONDITION_OPS,
  WORKFLOW_ASSIGNEE_KINDS,
  WORKFLOW_QUORUMS,
} from "@constructos/shared";

/* ------------------------------------------------------------------ */
/* Step definitions                                                    */
/* ------------------------------------------------------------------ */

export const conditionSchema = z.object({
  field: z.string().min(1).max(100),
  op: z.enum(WORKFLOW_CONDITION_OPS),
  value: z
    .union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(z.union([z.string(), z.number(), z.boolean()])).max(50),
    ])
    .optional(),
});
export type WorkflowCondition = z.infer<typeof conditionSchema>;

/**
 * How a step names who must act.
 *
 * `assigneeIds` (explicit user ids) is the original shape and still works.
 * `role` names a permission-template key resolved against the project's
 * memberships at ACTIVATION time, so a template written once keeps working
 * when the PM changes. `groupId` names a distribution group.
 */
export const stepSchema = z
  .object({
    name: z.string().min(1).max(200),
    type: z.enum(WORKFLOW_STEP_TYPES),
    assigneeIds: z.array(z.string().min(1)).max(20).optional(),
    role: z.string().min(1).max(80).optional(),
    groupId: z.string().min(1).max(100).optional(),
    /** ANY-of settles on the first decision; ALL-of needs everyone (default) */
    quorum: z.enum(WORKFLOW_QUORUMS).optional(),
    parallel: z.boolean().optional(),
    dueInDays: z.number().int().min(0).max(365).optional(),
    /** #85 — days after activation at which the step escalates */
    escalateAfterDays: z.number().int().min(0).max(365).optional(),
    /** who the escalation notifies: a user id, or "role:<templateKey>" */
    escalateTo: z.string().min(1).max(120).optional(),
    condition: conditionSchema.optional(),
  })
  .refine(
    (s) => (s.assigneeIds && s.assigneeIds.length > 0) || s.role || s.groupId,
    "A step needs assigneeIds, a role or a groupId",
  );
export type StepDef = z.infer<typeof stepSchema>;

export const stepsSchema = z.array(stepSchema).min(1).max(50);

/** The assignment kind a step declares, for the record on each step row. */
export function assigneeKindOf(step: StepDef): (typeof WORKFLOW_ASSIGNEE_KINDS)[number] {
  if (step.role) return "role";
  if (step.groupId) return "group";
  return "user";
}

export function assigneeKeyOf(step: StepDef): string | null {
  return step.role ?? step.groupId ?? null;
}

/* ------------------------------------------------------------------ */
/* Grouping                                                            */
/* ------------------------------------------------------------------ */

/**
 * Group steps into activation groups: a consecutive run of `parallel: true`
 * steps forms one group that activates together; every other step is its own
 * group and runs in order (#81).
 */
export function buildGroups(steps: StepDef[]): StepDef[][] {
  const groups: StepDef[][] = [];
  for (const step of steps) {
    const last = groups[groups.length - 1];
    if (step.parallel && last && last[last.length - 1]!.parallel) last.push(step);
    else groups.push([step]);
  }
  return groups;
}

/* ------------------------------------------------------------------ */
/* Conditions (#82)                                                    */
/* ------------------------------------------------------------------ */

export type ConditionOutcome = "include" | "skip" | "unresolved";

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Evaluate one step condition against the run's context.
 *
 * Returns `unresolved` when the answer cannot honestly be computed — the
 * field is absent, or a numeric comparison was asked for on something that is
 * not a number. The engine treats `unresolved` as `include`: a cost-threshold
 * approval must happen when the cost is unknown, not be skipped.
 */
export function conditionOutcome(
  cond: WorkflowCondition | undefined,
  context: Record<string, unknown>,
): ConditionOutcome {
  if (!cond) return "include";
  const present = Object.prototype.hasOwnProperty.call(context, cond.field);
  const actual = context[cond.field];

  if (cond.op === "exists") {
    const truthy = present && actual !== null && actual !== undefined && actual !== "";
    const want = cond.value === undefined ? true : Boolean(cond.value);
    return truthy === want ? "include" : "skip";
  }

  if (!present || actual === undefined) return "unresolved";

  switch (cond.op) {
    case "eq":
      return actual === cond.value ? "include" : "skip";
    case "ne":
      return actual !== cond.value ? "include" : "skip";
    case "in":
    case "not_in": {
      if (!Array.isArray(cond.value)) return "unresolved";
      const hit = cond.value.some((v) => v === actual);
      const want = cond.op === "in";
      return hit === want ? "include" : "skip";
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const left = asNumber(actual);
      const right = asNumber(cond.value ?? null);
      if (left === null || right === null) return "unresolved";
      const ok =
        cond.op === "gt"
          ? left > right
          : cond.op === "gte"
            ? left >= right
            : cond.op === "lt"
              ? left < right
              : left <= right;
      return ok ? "include" : "skip";
    }
  }
}

/** Fields a template's conditions read, so a caller can be told what is missing. */
export function requiredContextFields(steps: StepDef[]): string[] {
  const fields = new Set<string>();
  for (const step of steps) if (step.condition) fields.add(step.condition.field);
  return [...fields].sort();
}

/** Which of those fields the context cannot answer. */
export function unresolvedConditionFields(
  steps: StepDef[],
  context: Record<string, unknown>,
): string[] {
  const out = new Set<string>();
  for (const step of steps) {
    if (!step.condition) continue;
    if (conditionOutcome(step.condition, context) === "unresolved") out.add(step.condition.field);
  }
  return [...out].sort();
}

/* ------------------------------------------------------------------ */
/* Activation planning                                                 */
/* ------------------------------------------------------------------ */

export interface PlannedStep {
  name: string;
  stepType: StepDef["type"];
  assigneeId: string;
  assignedVia: (typeof WORKFLOW_ASSIGNEE_KINDS)[number];
  assignedViaKey: string | null;
  quorum: (typeof WORKFLOW_QUORUMS)[number];
  skipped: boolean;
  dueInDays: number | null;
  escalateAfterDays: number | null;
  escalateTo: string | null;
}

export interface PlannedGroup {
  position: number;
  steps: PlannedStep[];
  /** true when every step in the group was skipped by its condition */
  fullySkipped: boolean;
}

export interface ResolvedAssignees {
  /** the ids that will actually decide, in order */
  ids: string[];
  /** why the resolution produced nothing, when it did */
  reason?: string;
}

export type AssigneeResolver = (step: StepDef) => ResolvedAssignees;

/**
 * Plan one group's step rows.
 *
 * Assignees are de-duplicated within the group: the same person named twice
 * (once explicitly, once through their role) decides once. A step whose
 * assignees cannot be resolved is reported rather than silently dropped —
 * dropping it is how an approval chain becomes shorter than its template.
 */
export function planGroup(
  group: StepDef[],
  position: number,
  context: Record<string, unknown>,
  resolve: AssigneeResolver,
): { plan: PlannedGroup; unresolvable: Array<{ step: string; reason: string }> } {
  const steps: PlannedStep[] = [];
  const unresolvable: Array<{ step: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const step of group) {
    const outcome = conditionOutcome(step.condition, context);
    const skipped = outcome === "skip";
    const resolved = resolve(step);
    if (!skipped && resolved.ids.length === 0) {
      unresolvable.push({ step: step.name, reason: resolved.reason ?? "no assignee resolved" });
      continue;
    }
    for (const assigneeId of resolved.ids) {
      if (seen.has(assigneeId)) continue;
      seen.add(assigneeId);
      steps.push({
        name: step.name,
        stepType: step.type,
        assigneeId,
        assignedVia: assigneeKindOf(step),
        assignedViaKey: assigneeKeyOf(step),
        quorum: step.quorum ?? "all",
        skipped,
        dueInDays: step.dueInDays ?? null,
        escalateAfterDays: step.escalateAfterDays ?? null,
        escalateTo: step.escalateTo ?? null,
      });
    }
  }

  return {
    plan: {
      position,
      steps,
      fullySkipped: steps.length > 0 && steps.every((s) => s.skipped),
    },
    unresolvable,
  };
}

/**
 * Has the active group finished?
 *
 * ALL-of: no pending step remains. ANY-of: one decision settles the group, so
 * the remaining pending steps are withdrawn by the caller.
 */
export function groupSettled(
  decisions: Array<{ decision: string; quorum: string }>,
): { settled: boolean; withdrawRemaining: boolean } {
  if (decisions.length === 0) return { settled: true, withdrawRemaining: false };
  const anyOf = decisions.some((d) => d.quorum === "any");
  const decided = decisions.filter((d) => d.decision !== "pending");
  if (anyOf) {
    return { settled: decided.length > 0, withdrawRemaining: decided.length > 0 };
  }
  return { settled: decided.length === decisions.length, withdrawRemaining: false };
}

/* ------------------------------------------------------------------ */
/* Dates (#85)                                                         */
/* ------------------------------------------------------------------ */

/** Add whole days to an ISO date (YYYY-MM-DD), UTC, no timezone drift. */
export function addDays(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.slice(0, 10).split("-").map(Number);
  const base = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

export function stepDates(
  today: string,
  step: { dueInDays: number | null; escalateAfterDays: number | null },
): { dueDate: string | null; escalateAt: string | null } {
  const dueDate = step.dueInDays === null ? null : addDays(today, step.dueInDays);
  const escalateAt =
    step.escalateAfterDays === null
      ? null
      : addDays(today, step.escalateAfterDays);
  return { dueDate, escalateAt };
}

/* ------------------------------------------------------------------ */
/* Visualisation payload (#91)                                         */
/* ------------------------------------------------------------------ */

export interface StepRowLike {
  id: string;
  position: number;
  name: string;
  stepType: string;
  assigneeId: string;
  delegatedToId: string | null;
  assignedVia: string;
  assignedViaKey: string | null;
  decision: string;
  dueDate: string | null;
  escalateAt: string | null;
  escalatedAt: string | null;
  decidedAt: string | null;
  comments: string | null;
}

export interface WorkflowGraphNode {
  position: number;
  label: string;
  parallel: boolean;
  state: "done" | "active" | "pending" | "skipped" | "rejected";
  steps: StepRowLike[];
}

/**
 * Turn a template's groups plus the live step rows into something a UI can
 * draw without re-deriving the engine's rules: one column per group, one chip
 * per step, and a state per column.
 */
export function buildGraph(
  groups: StepDef[][],
  rows: StepRowLike[],
  currentPosition: number,
  instanceStatus: string,
): WorkflowGraphNode[] {
  const byPosition = new Map<number, StepRowLike[]>();
  for (const row of rows) {
    const list = byPosition.get(row.position) ?? [];
    list.push(row);
    byPosition.set(row.position, list);
  }
  return groups.map((group, position) => {
    const steps = byPosition.get(position) ?? [];
    let state: WorkflowGraphNode["state"];
    if (steps.some((s) => s.decision === "rejected")) state = "rejected";
    else if (steps.length > 0 && steps.every((s) => s.decision === "skipped")) state = "skipped";
    else if (steps.length === 0) state = "pending";
    else if (steps.some((s) => s.decision === "pending")) {
      state = position === currentPosition && instanceStatus === "running" ? "active" : "pending";
    } else state = "done";
    return {
      position,
      label: group.map((s) => s.name).join(" · "),
      parallel: group.length > 1,
      state,
      steps,
    };
  });
}
