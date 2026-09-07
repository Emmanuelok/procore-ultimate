/**
 * Schedule quality assessment — the full DCMA 14-point check (spec Domain D
 * #283, surfaced as the §2.6 schedule health indicators #371). Pure functions
 * over persisted CPM output plus, where a check needs one, a live CPM2 pass.
 *
 * The fourteen checks, in DCMA order, with this implementation's threshold:
 *   1  logic          — missing predecessors / successors ≤ 5% (one designated
 *                       start activity and one finish activity excepted)
 *   2  leads          — negative lags = 0
 *   3  lags           — positive lags ≤ 5% of relationships
 *   4  relationship   — finish-to-start ≥ 90% of relationships
 *      types
 *   5  hard           — must_start_on ≤ 5% of activities
 *      constraints
 *   6  high float     — total float > 44d ≤ 5% of activities
 *   7  negative float — 0 activities
 *   8  high duration  — duration > 44d ≤ 5% of activities
 *   9  invalid dates  — no forecast work behind the data date and no actual
 *                       dates ahead of it (needs a data date)
 *   10 resources      — every working activity carries a resource (needs a
 *                       resource-loaded programme)
 *   11 missed tasks   — activities finishing later than baseline ≤ 5%
 *   12 critical path  — inflating a critical activity by 600 days must move
 *      test             the completion date by the same amount
 *   13 CPLI           — (critical path length + total float) / length ≥ 0.95
 *   14 BEI            — activities finished ÷ activities baselined to finish
 *                       by the data date ≥ 0.95
 * plus an eleventh-hour honesty check this platform adds:
 *   invalid progress  — percent complete without actual dates = 0
 *
 * A check that cannot be evaluated (no baseline, no data date, no resource
 * loading) is marked `applicable: false` and excluded from the score, instead
 * of being silently failed or silently passed. A score computed over checks
 * that could not run is a lie about the programme.
 */

import { computeCpm2, type CalendarSpec, type Cpm2DependencyInput, type Cpm2TaskInput } from "./cpm2.js";

export const HIGH_FLOAT_THRESHOLD_DAYS = 44;
export const HIGH_DURATION_THRESHOLD_DAYS = 44;
export const RATIO_THRESHOLD = 0.05; // "≤ 5%" checks
export const FS_RATIO_THRESHOLD = 0.9; // "≥ 90%" check
export const CPLI_THRESHOLD = 0.95;
export const BEI_THRESHOLD = 0.95;
/** DCMA's critical-path test injects a 600-day delay. */
export const CRITICAL_PATH_TEST_DAYS = 600;

export interface QualityTaskInput {
  id: string;
  name: string;
  durationDays: number;
  remainingDurationDays?: number | null;
  constraintType: string | null;
  constraintDate?: string | null;
  percentComplete: number;
  actualStart: string | null;
  actualFinish: string | null;
  startDate: string | null;
  finishDate: string | null;
  totalFloat: number | null;
  sortOrder?: number;
  taskType?: string | null;
  calendarId?: string | null;
}

export interface QualityDependencyInput {
  id: string;
  predecessorId: string;
  successorId: string;
  depType: string;
  lagDays: number;
}

/** Baseline row used by the missed-tasks and BEI checks. */
export interface QualityBaselineRow {
  taskId: string;
  finishDate?: string | null;
}

export interface QualityOptions {
  projectStart?: string | null;
  dataDate?: string | null;
  calendars?: CalendarSpec[];
  defaultCalendarId?: string | null;
  baseline?: QualityBaselineRow[] | null;
  /** taskId → number of resource assignments; omit when not resource-loaded */
  resourceCountByTask?: Record<string, number> | null;
}

export interface QualityCheck {
  count: number;
  ids: string[];
  ratio: number | null;
  threshold: string;
  pass: boolean;
  /** false when the inputs the check needs were not available */
  applicable: boolean;
  /** why the check could not run, or the computed figure's basis */
  basis?: string;
  /** the computed metric, where the check produces one (CPLI, BEI, …) */
  value?: number | null;
}

export interface QualityReport {
  taskCount: number;
  dependencyCount: number;
  checks: Record<string, QualityCheck>;
  criticalPercent: number;
  passed: number;
  total: number;
  score: number;
  /** checks skipped for want of a baseline / data date / resource loading */
  notApplicable: string[];
}

const MAX_IDS = 100;

function check(
  ids: string[],
  threshold: string,
  pass: boolean,
  ratio: number | null = null,
  extra: Partial<QualityCheck> = {},
): QualityCheck {
  return {
    count: ids.length,
    ids: ids.slice(0, MAX_IDS),
    ratio,
    threshold,
    pass,
    applicable: true,
    ...extra,
  };
}

function notApplicable(threshold: string, basis: string): QualityCheck {
  return { count: 0, ids: [], ratio: null, threshold, pass: false, applicable: false, basis, value: null };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

const DAY_MS = 86_400_000;
function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);
}

/** Activity classes DCMA excludes from duration/float population checks. */
const EXCLUDED_TYPES = new Set(["level_of_effort", "wbs_summary"]);

export function assessScheduleQuality(
  tasks: QualityTaskInput[],
  deps: QualityDependencyInput[],
  options: QualityOptions = {},
): QualityReport {
  const nTasks = tasks.length;
  const nDeps = deps.length;
  const working = tasks.filter((t) => !EXCLUDED_TYPES.has(t.taskType ?? "task"));

  const hasIncoming = new Set(deps.map((d) => d.successorId));
  const hasOutgoing = new Set(deps.map((d) => d.predecessorId));

  /* ---- 1. logic -------------------------------------------------- */
  /*
   * A programme legitimately has ONE start activity and ONE finish activity
   * with open logic. Excluding every task that happens to sit on the earliest
   * date (the old rule) made this check vacuous: an unlinked task has no
   * predecessor, so it starts on day zero, so it was excused — precisely the
   * defect the check exists to find.
   */
  const orderOf = (t: QualityTaskInput) => t.sortOrder ?? 0;
  const startDates = tasks.map((t) => t.startDate).filter((d): d is string => d !== null);
  const finishDates = tasks.map((t) => t.finishDate).filter((d): d is string => d !== null);
  const minStart = startDates.length > 0 ? startDates.reduce((a, b) => (b < a ? b : a)) : null;
  const maxFinish = finishDates.length > 0 ? finishDates.reduce((a, b) => (b > a ? b : a)) : null;

  const pickOne = (
    candidates: QualityTaskInput[],
    better: (a: QualityTaskInput, b: QualityTaskInput) => boolean,
  ): string | null => {
    let best: QualityTaskInput | null = null;
    for (const t of candidates) if (best === null || better(t, best)) best = t;
    return best?.id ?? null;
  };
  const designatedStart = pickOne(
    working.filter((t) => !hasIncoming.has(t.id) && (minStart === null || t.startDate === minStart)),
    (a, b) => orderOf(a) < orderOf(b) || (orderOf(a) === orderOf(b) && a.id < b.id),
  );
  const designatedFinish = pickOne(
    working.filter((t) => !hasOutgoing.has(t.id) && (maxFinish === null || t.finishDate === maxFinish)),
    (a, b) => orderOf(a) > orderOf(b) || (orderOf(a) === orderOf(b) && a.id > b.id),
  );

  const missingPredIds = working
    .filter((t) => !hasIncoming.has(t.id) && t.id !== designatedStart)
    .map((t) => t.id);
  const missingSuccIds = working
    .filter((t) => !hasOutgoing.has(t.id) && t.id !== designatedFinish)
    .map((t) => t.id);

  /* ---- 2-4. relationships ---------------------------------------- */
  const leadIds = deps.filter((d) => d.lagDays < 0).map((d) => d.id);
  const lagIds = deps.filter((d) => d.lagDays > 0).map((d) => d.id);
  const fsCount = deps.filter((d) => d.depType === "FS").length;

  /* ---- 5-8. constraints, float, duration -------------------------- */
  const hardConstraintIds = tasks.filter((t) => t.constraintType === "must_start_on").map((t) => t.id);
  const highFloatIds = working
    .filter((t) => t.totalFloat !== null && t.totalFloat > HIGH_FLOAT_THRESHOLD_DAYS)
    .map((t) => t.id);
  const negativeFloatIds = working
    .filter((t) => t.totalFloat !== null && t.totalFloat < 0)
    .map((t) => t.id);
  const highDurationIds = working
    .filter((t) => t.durationDays > HIGH_DURATION_THRESHOLD_DAYS)
    .map((t) => t.id);
  const invalidProgressIds = tasks
    .filter((t) => (t.percentComplete > 0 && !t.actualStart) || (t.percentComplete >= 100 && !t.actualFinish))
    .map((t) => t.id);

  /* ---- 9. invalid dates (needs a data date) ----------------------- */
  const dataDate = options.dataDate ?? null;
  const invalidDateIds = dataDate
    ? tasks
        .filter(
          (t) =>
            (t.actualStart !== null && t.actualStart > dataDate) ||
            (t.actualFinish !== null && t.actualFinish > dataDate) ||
            (t.actualFinish === null && t.finishDate !== null && t.finishDate < dataDate),
        )
        .map((t) => t.id)
    : [];

  /* ---- 10. resources ---------------------------------------------- */
  const resourceCounts = options.resourceCountByTask ?? null;
  const totalResources = resourceCounts
    ? Object.values(resourceCounts).reduce((a, b) => a + b, 0)
    : 0;
  const unresourcedIds =
    resourceCounts && totalResources > 0
      ? working
          .filter((t) => t.durationDays > 0 && (resourceCounts[t.id] ?? 0) === 0)
          .map((t) => t.id)
      : [];

  /* ---- 11 & 14. baseline-derived checks --------------------------- */
  const baseline = options.baseline ?? null;
  const baselineFinishById = new Map<string, string>();
  for (const b of baseline ?? []) if (b.finishDate) baselineFinishById.set(b.taskId, b.finishDate);

  const missedIds: string[] = [];
  if (baselineFinishById.size > 0) {
    for (const t of working) {
      const bf = baselineFinishById.get(t.id);
      if (!bf) continue;
      const actual = t.actualFinish ?? t.finishDate;
      if (actual && actual > bf) missedIds.push(t.id);
    }
  }

  let beiValue: number | null = null;
  let beiDue = 0;
  let beiDone = 0;
  if (baselineFinishById.size > 0 && dataDate) {
    for (const t of working) {
      const bf = baselineFinishById.get(t.id);
      if (!bf || bf > dataDate) continue;
      beiDue += 1;
      if (t.actualFinish !== null) beiDone += 1;
    }
    beiValue = beiDue > 0 ? round4(beiDone / beiDue) : null;
  }

  /* ---- 12 & 13. live CPM checks ----------------------------------- */
  const projectStart = options.projectStart ?? null;
  let criticalPathCheck: QualityCheck;
  let cpliCheck: QualityCheck;

  const toCpm = (override?: { id: string; duration: number }): Cpm2TaskInput[] =>
    tasks.map((t) => ({
      id: t.id,
      duration: override && override.id === t.id ? override.duration : t.durationDays,
      remainingDuration: t.remainingDurationDays ?? null,
      percentComplete: t.percentComplete,
      constraintType: (t.constraintType ?? null) as Cpm2TaskInput["constraintType"],
      constraintDate: t.constraintDate ?? null,
      actualStart: t.actualStart,
      actualFinish: t.actualFinish,
      calendarId: t.calendarId ?? null,
      taskType: t.taskType ?? null,
    }));
  const cpmDeps: Cpm2DependencyInput[] = deps.map((d) => ({
    predecessorId: d.predecessorId,
    successorId: d.successorId,
    type: d.depType as Cpm2DependencyInput["type"],
    lagDays: d.lagDays,
  }));

  if (!projectStart || nTasks === 0) {
    criticalPathCheck = notApplicable(
      `a ${CRITICAL_PATH_TEST_DAYS}-day delay on a critical activity must move completion by the same amount`,
      "no schedule start date was supplied, or the schedule has no activities",
    );
    cpliCheck = notApplicable(
      `critical path length index ≥ ${CPLI_THRESHOLD}`,
      "no schedule start date was supplied, or the schedule has no activities",
    );
  } else {
    const opts = {
      projectStart,
      dataDate,
      calendars: options.calendars,
      defaultCalendarId: options.defaultCalendarId ?? null,
    };
    const base = computeCpm2(toCpm(), cpmDeps, opts);
    if (!base.ok) {
      criticalPathCheck = notApplicable(
        `a ${CRITICAL_PATH_TEST_DAYS}-day delay on a critical activity must move completion by the same amount`,
        `the schedule contains a dependency cycle (${base.cycle.slice(0, 5).join(", ")})`,
      );
      cpliCheck = notApplicable(
        `critical path length index ≥ ${CPLI_THRESHOLD}`,
        "the schedule contains a dependency cycle",
      );
    } else {
      /* 12. critical path test */
      const victim =
        base.longestPath.find((id) => {
          const t = tasks.find((x) => x.id === id);
          return t !== undefined && t.durationDays > 0 && t.actualFinish === null;
        }) ??
        base.criticalIds.find((id) => {
          const t = tasks.find((x) => x.id === id);
          return t !== undefined && t.durationDays > 0 && t.actualFinish === null;
        }) ??
        null;
      if (!victim) {
        criticalPathCheck = notApplicable(
          `a ${CRITICAL_PATH_TEST_DAYS}-day delay on a critical activity must move completion by the same amount`,
          "no incomplete critical activity with a duration exists to test",
        );
      } else {
        const victimTask = tasks.find((t) => t.id === victim)!;
        const impacted = computeCpm2(
          toCpm({ id: victim, duration: victimTask.durationDays + CRITICAL_PATH_TEST_DAYS }),
          cpmDeps,
          opts,
        );
        const moved = impacted.ok ? impacted.projectDurationDays - base.projectDurationDays : 0;
        // Calendar activities absorb the injected days over weekends, so the
        // completion moves by AT LEAST 600 days; a shortfall means broken logic.
        const passed = impacted.ok && moved >= CRITICAL_PATH_TEST_DAYS;
        criticalPathCheck = check(
          passed ? [] : [victim],
          `a ${CRITICAL_PATH_TEST_DAYS}-day delay on a critical activity must move completion by the same amount`,
          passed,
          null,
          {
            value: moved,
            basis: `injected ${CRITICAL_PATH_TEST_DAYS}d into "${victimTask.name}"; completion moved ${moved}d`,
          },
        );
      }

      /* 13. CPLI */
      const cplFrom = dataDate ?? projectStart;
      const cpl = base.projectFinishDate ? diffDays(base.projectFinishDate, cplFrom) + 1 : 0;
      const finishFloat =
        base.longestPath.length > 0
          ? (base.tasks.get(base.longestPath[base.longestPath.length - 1]!)?.totalFloat ?? 0)
          : 0;
      if (cpl <= 0) {
        cpliCheck = notApplicable(
          `critical path length index ≥ ${CPLI_THRESHOLD}`,
          "the programme has already finished at the data date — there is no remaining critical path",
        );
      } else {
        const cpli = round4((cpl + finishFloat) / cpl);
        cpliCheck = check([], `critical path length index ≥ ${CPLI_THRESHOLD}`, cpli >= CPLI_THRESHOLD, null, {
          value: cpli,
          basis: `critical path ${cpl}d from ${cplFrom}, completion float ${finishFloat}d`,
        });
      }
    }
  }

  const taskRatio = (n: number) => (working.length === 0 ? 0 : n / working.length);
  const depRatio = (n: number) => (nDeps === 0 ? 0 : n / nDeps);
  const fsShare = nDeps === 0 ? 1 : fsCount / nDeps;
  const criticalCount = working.filter((t) => t.totalFloat !== null && t.totalFloat <= 0).length;

  const checks: Record<string, QualityCheck> = {
    missingPredecessors: check(
      missingPredIds,
      "≤ 5% of activities lack a predecessor (one start activity excepted)",
      taskRatio(missingPredIds.length) <= RATIO_THRESHOLD,
      round4(taskRatio(missingPredIds.length)),
    ),
    missingSuccessors: check(
      missingSuccIds,
      "≤ 5% of activities lack a successor (one finish activity excepted)",
      taskRatio(missingSuccIds.length) <= RATIO_THRESHOLD,
      round4(taskRatio(missingSuccIds.length)),
    ),
    leads: check(leadIds, "no leads (negative lags)", leadIds.length === 0),
    lags: check(
      lagIds,
      "≤ 5% of relationships carry a positive lag",
      depRatio(lagIds.length) <= RATIO_THRESHOLD,
      round4(depRatio(lagIds.length)),
    ),
    fsRatio: check([], "≥ 90% of relationships are finish-to-start", fsShare >= FS_RATIO_THRESHOLD, round4(fsShare), {
      value: round4(fsShare),
    }),
    hardConstraints: check(
      hardConstraintIds,
      "≤ 5% of activities carry a hard constraint (must_start_on)",
      taskRatio(hardConstraintIds.length) <= RATIO_THRESHOLD,
      round4(taskRatio(hardConstraintIds.length)),
    ),
    highFloat: check(
      highFloatIds,
      `≤ 5% of activities with total float > ${HIGH_FLOAT_THRESHOLD_DAYS}d`,
      taskRatio(highFloatIds.length) <= RATIO_THRESHOLD,
      round4(taskRatio(highFloatIds.length)),
    ),
    negativeFloat: check(negativeFloatIds, "no negative float", negativeFloatIds.length === 0),
    highDuration: check(
      highDurationIds,
      `≤ 5% of activities with duration > ${HIGH_DURATION_THRESHOLD_DAYS}d`,
      taskRatio(highDurationIds.length) <= RATIO_THRESHOLD,
      round4(taskRatio(highDurationIds.length)),
    ),
    invalidProgress: check(
      invalidProgressIds,
      "no progress without matching actual dates",
      invalidProgressIds.length === 0,
    ),
    invalidDates: dataDate
      ? check(
          invalidDateIds,
          "no actual dates after the data date and no forecast work behind it",
          invalidDateIds.length === 0,
          null,
          { basis: `data date ${dataDate}` },
        )
      : notApplicable(
          "no actual dates after the data date and no forecast work behind it",
          "the schedule has no data date — status it to run this check",
        ),
    resources:
      resourceCounts && totalResources > 0
        ? check(
            unresourcedIds,
            "every working activity carries a resource assignment",
            unresourcedIds.length === 0,
            round4(taskRatio(unresourcedIds.length)),
          )
        : notApplicable(
            "every working activity carries a resource assignment",
            "the programme is not resource-loaded — load resources to run this check",
          ),
    missedTasks:
      baselineFinishById.size > 0
        ? check(
            missedIds,
            "≤ 5% of activities finish later than their baseline finish",
            taskRatio(missedIds.length) <= RATIO_THRESHOLD,
            round4(taskRatio(missedIds.length)),
          )
        : notApplicable(
            "≤ 5% of activities finish later than their baseline finish",
            "no baseline was supplied — capture a baseline to run this check",
          ),
    criticalPathTest: criticalPathCheck,
    cpli: cpliCheck,
    bei:
      beiValue !== null
        ? check([], `baseline execution index ≥ ${BEI_THRESHOLD}`, beiValue >= BEI_THRESHOLD, null, {
            value: beiValue,
            basis: `${beiDone} of ${beiDue} activities baselined to finish by ${dataDate} are complete`,
          })
        : notApplicable(
            `baseline execution index ≥ ${BEI_THRESHOLD}`,
            baselineFinishById.size === 0
              ? "no baseline was supplied — capture a baseline to run this check"
              : !dataDate
                ? "the schedule has no data date — status it to run this check"
                : "no activity was baselined to finish by the data date",
          ),
  };

  const entries = Object.entries(checks);
  const applicable = entries.filter(([, c]) => c.applicable);
  const passed = applicable.filter(([, c]) => c.pass).length;

  return {
    taskCount: nTasks,
    dependencyCount: nDeps,
    checks,
    criticalPercent: round4(taskRatio(criticalCount)),
    passed,
    total: applicable.length,
    score: applicable.length === 0 ? 1 : round4(passed / applicable.length),
    notApplicable: entries.filter(([, c]) => !c.applicable).map(([k]) => k),
  };
}
