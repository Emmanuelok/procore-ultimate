import {
  computeCpm,
  type CpmDependencyInput,
  type CpmTaskInput,
} from "../../lib/cpm.js";

/**
 * Time Impact Analysis by fragnet insertion (spec Domain D #272) — pure.
 *
 * The delay is modelled as a virtual fragnet task inserted immediately after
 * the struck task: struck --FS--> fragnet --FS--> (every successor of the
 * struck task). The fragnet carries a start_no_earlier_than constraint on the
 * delay's start date, so a delay that begins after the struck task finishes
 * still pushes from its real-world start. Original logic is preserved — the
 * fragnet path simply competes with (and, when the delay bites, dominates)
 * the existing paths. When the struck task has no successors the fragnet just
 * extends after it.
 */

export const FRAGNET_ID = "__fragnet";

export interface FragnetTiaInput {
  tasks: CpmTaskInput[];
  deps: CpmDependencyInput[];
  projectStart: string;
  /** the task the delay strikes (fragnet insertion point) */
  struckTaskId: string;
  fragnetDurationDays: number;
  /** the delay event's start date — fragnet start_no_earlier_than */
  fragnetStartDate: string;
}

export type FragnetTiaResult =
  | {
      ok: true;
      completionDeltaDays: number;
      beforeFinish: string | null;
      afterFinish: string | null;
      beforeDurationDays: number;
      afterDurationDays: number;
    }
  | { ok: false; cycle: string[] };

export function runFragnetTia(input: FragnetTiaInput): FragnetTiaResult {
  const { tasks, deps, projectStart, struckTaskId } = input;

  const before = computeCpm(tasks, deps, { projectStart });
  if (!before.ok) return { ok: false, cycle: before.cycle };

  const fragnet: CpmTaskInput = {
    id: FRAGNET_ID,
    duration: input.fragnetDurationDays,
    constraintType: "start_no_earlier_than",
    constraintDate: input.fragnetStartDate,
  };

  const successorIds = new Set<string>();
  for (const d of deps) {
    if (d.predecessorId === struckTaskId && d.successorId !== struckTaskId) {
      successorIds.add(d.successorId);
    }
  }

  const impactedDeps: CpmDependencyInput[] = [
    ...deps,
    { predecessorId: struckTaskId, successorId: FRAGNET_ID, type: "FS", lagDays: 0 },
    ...[...successorIds].map(
      (successorId): CpmDependencyInput => ({
        predecessorId: FRAGNET_ID,
        successorId,
        type: "FS",
        lagDays: 0,
      }),
    ),
  ];

  const after = computeCpm([...tasks, fragnet], impactedDeps, { projectStart });
  if (!after.ok) return { ok: false, cycle: after.cycle };

  return {
    ok: true,
    completionDeltaDays: after.projectDurationDays - before.projectDurationDays,
    beforeFinish: before.projectFinishDate,
    afterFinish: after.projectFinishDate,
    beforeDurationDays: before.projectDurationDays,
    afterDurationDays: after.projectDurationDays,
  };
}
