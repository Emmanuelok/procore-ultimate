import {
  computeCpm2,
  type CalendarSpec,
  type Cpm2DependencyInput,
  type Cpm2TaskInput,
} from "../schedule/cpm2.js";

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
 *
 * The network is evaluated by CPM2, the same engine the schedule module
 * persists dates with, so the analysis sees the programme's WORK CALENDARS,
 * its data date and the remaining durations of activities in progress. It
 * used to run on lib/cpm (continuous calendar, no data date): on any
 * programme with a five-day week — which is what both importers create — a
 * ten-day delay was modelled as ten calendar days and the reported
 * `beforeFinish` contradicted the schedule's own computed finish. Two numbers
 * for one programme is worse than a missing one.
 *
 * The fragnet is worked to the STRUCK ACTIVITY'S calendar unless a calendar
 * is named: a delay to an activity that does not work weekends does not
 * consume weekends either. A weather or access delay measured in calendar
 * days should be passed a continuous calendar explicitly.
 */

export const FRAGNET_ID = "__fragnet";

export interface FragnetTiaInput {
  tasks: Cpm2TaskInput[];
  deps: Cpm2DependencyInput[];
  projectStart: string;
  /** progress data date; null = the programme has never been statused */
  dataDate?: string | null;
  calendars?: CalendarSpec[];
  defaultCalendarId?: string | null;
  /** the task the delay strikes (fragnet insertion point) */
  struckTaskId: string;
  fragnetDurationDays: number;
  /** the delay event's start date — fragnet start_no_earlier_than */
  fragnetStartDate: string;
  /** calendar the fragnet works to; defaults to the struck activity's */
  fragnetCalendarId?: string | null;
}

export type FragnetTiaResult =
  | {
      ok: true;
      completionDeltaDays: number;
      beforeFinish: string | null;
      afterFinish: string | null;
      beforeDurationDays: number;
      afterDurationDays: number;
      /** the calendar the fragnet was worked to, for the record */
      fragnetCalendarId: string | null;
    }
  | { ok: false; cycle: string[] };

export function runFragnetTia(input: FragnetTiaInput): FragnetTiaResult {
  const { tasks, deps, struckTaskId } = input;
  const options = {
    projectStart: input.projectStart,
    dataDate: input.dataDate ?? null,
    calendars: input.calendars,
    defaultCalendarId: input.defaultCalendarId ?? null,
  };

  const before = computeCpm2(tasks, deps, options);
  if (!before.ok) return { ok: false, cycle: before.cycle };

  const struck = tasks.find((t) => t.id === struckTaskId);
  const fragnetCalendarId =
    input.fragnetCalendarId !== undefined
      ? input.fragnetCalendarId
      : (struck?.calendarId ?? null);

  const fragnet: Cpm2TaskInput = {
    id: FRAGNET_ID,
    duration: input.fragnetDurationDays,
    constraintType: "start_no_earlier_than",
    constraintDate: input.fragnetStartDate,
    calendarId: fragnetCalendarId,
  };

  const successorIds = new Set<string>();
  for (const d of deps) {
    if (d.predecessorId === struckTaskId && d.successorId !== struckTaskId) {
      successorIds.add(d.successorId);
    }
  }

  const impactedDeps: Cpm2DependencyInput[] = [
    ...deps,
    { predecessorId: struckTaskId, successorId: FRAGNET_ID, type: "FS", lagDays: 0 },
    ...[...successorIds].map(
      (successorId): Cpm2DependencyInput => ({
        predecessorId: FRAGNET_ID,
        successorId,
        type: "FS",
        lagDays: 0,
      }),
    ),
  ];

  const after = computeCpm2([...tasks, fragnet], impactedDeps, options);
  if (!after.ok) return { ok: false, cycle: after.cycle };

  return {
    ok: true,
    completionDeltaDays: after.projectDurationDays - before.projectDurationDays,
    beforeFinish: before.projectFinishDate,
    afterFinish: after.projectFinishDate,
    beforeDurationDays: before.projectDurationDays,
    afterDurationDays: after.projectDurationDays,
    fragnetCalendarId,
  };
}
