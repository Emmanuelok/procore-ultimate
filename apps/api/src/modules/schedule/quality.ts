/**
 * Schedule quality assessment — a DCMA 14-point-style subset (spec Domain D
 * #283, surfaced as the §2.6 schedule health indicators #371). Pure functions
 * over persisted CPM output; no I/O.
 *
 * Thresholds (documented here, asserted in code):
 *  - missing predecessors  ≤ 5% of tasks (earliest-start task(s) excluded)
 *  - missing successors    ≤ 5% of tasks (finish-side task(s) excluded)
 *  - leads (negative lags) = 0
 *  - lags (positive lags)  ≤ 5% of dependencies
 *  - FS dependencies       ≥ 90% of dependencies
 *  - hard constraints      ≤ 5% of tasks (must_start_on)
 *  - high float (> 44d)    ≤ 5% of tasks
 *  - negative float        = 0
 *  - high duration (> 44d) ≤ 5% of tasks
 *  - invalid progress      = 0 (percent > 0 without actualStart, or = 100
 *                               without actualFinish)
 * criticalPercent is reported as an informational health metric (no
 * pass/fail). Overall score = passed checks / total checks.
 */

export const HIGH_FLOAT_THRESHOLD_DAYS = 44;
export const HIGH_DURATION_THRESHOLD_DAYS = 44;
export const RATIO_THRESHOLD = 0.05; // "≤ 5%" checks
export const FS_RATIO_THRESHOLD = 0.9; // "≥ 90%" check

export interface QualityTaskInput {
  id: string;
  name: string;
  durationDays: number;
  constraintType: string | null;
  percentComplete: number;
  actualStart: string | null;
  actualFinish: string | null;
  startDate: string | null;
  finishDate: string | null;
  totalFloat: number | null;
}

export interface QualityDependencyInput {
  id: string;
  predecessorId: string;
  successorId: string;
  depType: string;
  lagDays: number;
}

export interface QualityCheck {
  /** offending item count */
  count: number;
  /** offending task/dependency ids (bounded for payload safety) */
  ids: string[];
  /** count / population, where a ratio threshold applies */
  ratio: number | null;
  /** human-readable DCMA-style threshold */
  threshold: string;
  pass: boolean;
}

export interface QualityReport {
  taskCount: number;
  dependencyCount: number;
  checks: {
    missingPredecessors: QualityCheck;
    missingSuccessors: QualityCheck;
    leads: QualityCheck;
    lags: QualityCheck;
    fsRatio: QualityCheck;
    hardConstraints: QualityCheck;
    highFloat: QualityCheck;
    negativeFloat: QualityCheck;
    highDuration: QualityCheck;
    invalidProgress: QualityCheck;
  };
  /** informational: share of tasks on the critical path */
  criticalPercent: number;
  passed: number;
  total: number;
  /** passed / total, 0..1 */
  score: number;
}

const MAX_IDS = 100;

function check(
  ids: string[],
  threshold: string,
  pass: boolean,
  ratio: number | null = null,
): QualityCheck {
  return { count: ids.length, ids: ids.slice(0, MAX_IDS), ratio, threshold, pass };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function assessScheduleQuality(
  tasks: QualityTaskInput[],
  deps: QualityDependencyInput[],
): QualityReport {
  const nTasks = tasks.length;
  const nDeps = deps.length;

  const hasIncoming = new Set(deps.map((d) => d.successorId));
  const hasOutgoing = new Set(deps.map((d) => d.predecessorId));

  // Earliest-start task(s): a schedule legitimately begins somewhere — those
  // tasks are not "missing logic". Same for the finish-side task(s).
  const startDates = tasks.map((t) => t.startDate).filter((d): d is string => d !== null);
  const finishDates = tasks.map((t) => t.finishDate).filter((d): d is string => d !== null);
  const minStart = startDates.length > 0 ? startDates.reduce((a, b) => (b < a ? b : a)) : null;
  const maxFinish = finishDates.length > 0 ? finishDates.reduce((a, b) => (b > a ? b : a)) : null;

  const missingPredIds = tasks
    .filter((t) => !hasIncoming.has(t.id) && !(minStart !== null && t.startDate === minStart))
    .map((t) => t.id);
  const missingSuccIds = tasks
    .filter((t) => !hasOutgoing.has(t.id) && !(maxFinish !== null && t.finishDate === maxFinish))
    .map((t) => t.id);

  const leadIds = deps.filter((d) => d.lagDays < 0).map((d) => d.id);
  const lagIds = deps.filter((d) => d.lagDays > 0).map((d) => d.id);
  const fsCount = deps.filter((d) => d.depType === "FS").length;

  const hardConstraintIds = tasks
    .filter((t) => t.constraintType === "must_start_on")
    .map((t) => t.id);
  const highFloatIds = tasks
    .filter((t) => t.totalFloat !== null && t.totalFloat > HIGH_FLOAT_THRESHOLD_DAYS)
    .map((t) => t.id);
  const negativeFloatIds = tasks
    .filter((t) => t.totalFloat !== null && t.totalFloat < 0)
    .map((t) => t.id);
  const highDurationIds = tasks
    .filter((t) => t.durationDays > HIGH_DURATION_THRESHOLD_DAYS)
    .map((t) => t.id);
  const invalidProgressIds = tasks
    .filter(
      (t) =>
        (t.percentComplete > 0 && !t.actualStart) ||
        (t.percentComplete >= 100 && !t.actualFinish),
    )
    .map((t) => t.id);

  const criticalCount = tasks.filter((t) => t.totalFloat !== null && t.totalFloat <= 0).length;

  const taskRatio = (n: number) => (nTasks === 0 ? 0 : n / nTasks);
  const depRatio = (n: number) => (nDeps === 0 ? 0 : n / nDeps);
  const fsShare = nDeps === 0 ? 1 : fsCount / nDeps;

  const checks: QualityReport["checks"] = {
    missingPredecessors: check(
      missingPredIds,
      "≤ 5% of tasks lack a predecessor (schedule start excluded)",
      taskRatio(missingPredIds.length) <= RATIO_THRESHOLD,
      round4(taskRatio(missingPredIds.length)),
    ),
    missingSuccessors: check(
      missingSuccIds,
      "≤ 5% of tasks lack a successor (schedule finish excluded)",
      taskRatio(missingSuccIds.length) <= RATIO_THRESHOLD,
      round4(taskRatio(missingSuccIds.length)),
    ),
    leads: check(leadIds, "no leads (negative lags)", leadIds.length === 0),
    lags: check(
      lagIds,
      "≤ 5% of dependencies carry a positive lag",
      depRatio(lagIds.length) <= RATIO_THRESHOLD,
      round4(depRatio(lagIds.length)),
    ),
    fsRatio: check(
      [],
      "≥ 90% of dependencies are finish-to-start",
      fsShare >= FS_RATIO_THRESHOLD,
      round4(fsShare),
    ),
    hardConstraints: check(
      hardConstraintIds,
      "≤ 5% of tasks carry a hard constraint (must_start_on)",
      taskRatio(hardConstraintIds.length) <= RATIO_THRESHOLD,
      round4(taskRatio(hardConstraintIds.length)),
    ),
    highFloat: check(
      highFloatIds,
      `≤ 5% of tasks with total float > ${HIGH_FLOAT_THRESHOLD_DAYS}d`,
      taskRatio(highFloatIds.length) <= RATIO_THRESHOLD,
      round4(taskRatio(highFloatIds.length)),
    ),
    negativeFloat: check(negativeFloatIds, "no negative float", negativeFloatIds.length === 0),
    highDuration: check(
      highDurationIds,
      `≤ 5% of tasks with duration > ${HIGH_DURATION_THRESHOLD_DAYS}d`,
      taskRatio(highDurationIds.length) <= RATIO_THRESHOLD,
      round4(taskRatio(highDurationIds.length)),
    ),
    invalidProgress: check(
      invalidProgressIds,
      "no progress without matching actual dates",
      invalidProgressIds.length === 0,
    ),
  };

  const entries = Object.values(checks);
  const passed = entries.filter((c) => c.pass).length;

  return {
    taskCount: nTasks,
    dependencyCount: nDeps,
    checks,
    criticalPercent: round4(taskRatio(criticalCount)),
    passed,
    total: entries.length,
    score: entries.length === 0 ? 1 : round4(passed / entries.length),
  };
}
