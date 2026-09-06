/**
 * Unified consent-to-programme engine (#591) — one answer to the question a
 * programme director actually asks: *which works cannot lawfully start on
 * time, and by how much will that move the programme?*
 *
 * WHY THIS IS ONE ENGINE AND NOT TWO
 *
 * Land and permits used to answer that question separately: the land module
 * listed parcels blocking tasks, the jurisdiction module listed permits
 * blocking tasks, and neither could see the other. A task blocked by BOTH an
 * unacquired parcel and an ungranted environmental consent appeared twice,
 * each time understating the delay, and nothing anywhere summed the exposure.
 * The unit of analysis is the TASK, and a task's start is governed by its
 * worst dependency, so the engine takes both registers and reports per task.
 *
 * HOW DAYS-AT-RISK IS COMPUTED
 *
 * Every unresolved dependency carries an expected resolution date:
 *
 *     expected resolution = today + typical remaining duration for its state
 *
 * "Typical remaining duration" comes from the project's own history where it
 * has any (the median observed elapsed time for parcels that reached
 * `acquired` from that status, or permits that reached `granted` from that
 * status), and falls back to a documented default when it does not. That
 * matters for honesty: a default is a stated assumption, a median is
 * evidence, and the response says which was used.
 *
 *     days at risk = max(0, expected resolution − planned start)
 *
 * The programme slip is the maximum days-at-risk over CRITICAL tasks, plus,
 * for non-critical tasks, the amount by which days-at-risk exceeds the task's
 * total float — because float absorbs delay until it does not. Tasks with no
 * float figure are treated as float 0 only when they are flagged critical;
 * otherwise their contribution is reported separately as unquantified rather
 * than guessed.
 *
 * Pure: no database, no clock beyond the `today` the caller passes in.
 */

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

export type DependencyKind = "parcel" | "permit";

export interface ConsentTask {
  id: string;
  name: string;
  wbsCode: string | null;
  /** CPM planned start, falling back to actual start then constraint date */
  startDate: string | null;
  actualStart: string | null;
  totalFloat: number | null;
  isCritical: boolean;
}

export interface ConsentDependency {
  kind: DependencyKind;
  id: string;
  /** parcel cadastral reference or permit number/title */
  reference: string;
  label: string;
  /** ParcelStatus or PermitStatus */
  status: string;
  /** true when this state no longer blocks the works */
  resolved: boolean;
  taskIds: readonly string[];
  /** extra context for the row (tenure, authority, due date …) */
  detail: Record<string, unknown>;
}

/** Observed elapsed days from a state to resolution, for the median. */
export interface ObservedDuration {
  kind: DependencyKind;
  status: string;
  days: number;
}

/* ------------------------------------------------------------------ */
/* Default durations                                                   */
/* ------------------------------------------------------------------ */

/**
 * Documented fallbacks, in calendar days, for how long a dependency in a
 * given state typically still takes to clear. These are conservative
 * planning assumptions from internationally financed infrastructure practice,
 * NOT measurements — the engine says so in `basis` whenever it uses one.
 */
export const DEFAULT_RESOLUTION_DAYS: Record<DependencyKind, Record<string, number>> = {
  parcel: {
    identified: 180,
    surveyed: 150,
    under_negotiation: 120,
    agreed: 60,
    compensated: 30,
    disputed: 270,
  },
  permit: {
    not_started: 120,
    applied: 60,
    in_review: 45,
    refused: 180,
    expired: 60,
  },
};

/** Used when a state is not in the table at all — long, and flagged as such. */
export const UNKNOWN_STATE_DAYS = 90;

export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface ResolutionEstimate {
  days: number;
  source: "observed_median" | "default" | "unknown_state";
  sampleSize: number;
}

/**
 * Expected remaining days for a dependency in `status`, preferring the
 * project's own observed history (needs at least 3 observations to be worth
 * more than the documented default).
 */
export const MIN_OBSERVATIONS = 3;

export function estimateResolutionDays(
  kind: DependencyKind,
  status: string,
  observations: readonly ObservedDuration[],
): ResolutionEstimate {
  const sample = observations
    .filter((o) => o.kind === kind && o.status === status)
    .map((o) => o.days);
  const med = sample.length >= MIN_OBSERVATIONS ? medianOf(sample) : null;
  if (med != null) {
    return { days: Math.max(0, Math.round(med)), source: "observed_median", sampleSize: sample.length };
  }
  const fallback = DEFAULT_RESOLUTION_DAYS[kind][status];
  if (fallback == null) {
    return { days: UNKNOWN_STATE_DAYS, source: "unknown_state", sampleSize: sample.length };
  }
  return { days: fallback, source: "default", sampleSize: sample.length };
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

export interface ConsentDependencyRow {
  kind: DependencyKind;
  id: string;
  reference: string;
  label: string;
  status: string;
  expectedResolutionDate: string;
  expectedResolutionDays: number;
  estimateSource: ResolutionEstimate["source"];
  estimateSampleSize: number;
  daysAtRisk: number;
  detail: Record<string, unknown>;
}

export interface ConsentTaskRow {
  taskId: string;
  taskName: string;
  wbsCode: string | null;
  plannedStart: string | null;
  actualStart: string | null;
  daysUntilStart: number | null;
  isCritical: boolean;
  totalFloat: number | null;
  /** every unresolved dependency on this task, worst first */
  dependencies: ConsentDependencyRow[];
  /** the governing dependency's days-at-risk */
  daysAtRisk: number;
  /** days-at-risk beyond the float that could absorb it; null when unknowable */
  slipContribution: number | null;
  /** the works have physically started while a dependency is unresolved */
  startedUnconsented: boolean;
  basis: string;
}

export interface ConsentResult {
  horizonDays: number;
  tasks: ConsentTaskRow[];
  summary: {
    blockedTasks: number;
    criticalBlockedTasks: number;
    startedUnconsented: number;
    blockingParcels: number;
    blockingPermits: number;
    /** max slip contribution over quantifiable tasks; null when none */
    projectedSlipDays: number | null;
    /** tasks whose slip could not be quantified (no float, not critical) */
    unquantifiedTasks: number;
    soonestBlockedStart: string | null;
  };
}

const DAY = 86_400_000;

export function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

export function daysBetweenDates(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
}

/**
 * Build the ranked consent-to-programme view.
 *
 * `horizonDays` bounds which tasks are reported: a task starting in three
 * years blocked by an unacquired parcel is true but not actionable, and a
 * list nobody can act on is a list nobody reads.
 */
export function buildConsentView(args: {
  today: string;
  horizonDays: number;
  tasks: readonly ConsentTask[];
  dependencies: readonly ConsentDependency[];
  observations?: readonly ObservedDuration[];
}): ConsentResult {
  const observations = args.observations ?? [];
  const taskById = new Map(args.tasks.map((t) => [t.id, t]));
  const horizonDate = addDays(args.today, args.horizonDays);

  // dependency → its estimate, computed once per (kind,status) pair
  const estimateCache = new Map<string, ResolutionEstimate>();
  const estimateFor = (kind: DependencyKind, status: string): ResolutionEstimate => {
    const key = `${kind}:${status}`;
    const hit = estimateCache.get(key);
    if (hit) return hit;
    const est = estimateResolutionDays(kind, status, observations);
    estimateCache.set(key, est);
    return est;
  };

  const byTask = new Map<string, ConsentDependencyRow[]>();
  for (const dep of args.dependencies) {
    if (dep.resolved) continue;
    const est = estimateFor(dep.kind, dep.status);
    const expectedDate = addDays(args.today, est.days);
    for (const taskId of dep.taskIds) {
      const task = taskById.get(taskId);
      if (!task) continue;
      const start = task.startDate ?? task.actualStart;
      if (!start) continue; // unscheduled: nothing to be at risk against
      if (start > horizonDate) continue;
      const row: ConsentDependencyRow = {
        kind: dep.kind,
        id: dep.id,
        reference: dep.reference,
        label: dep.label,
        status: dep.status,
        expectedResolutionDate: expectedDate,
        expectedResolutionDays: est.days,
        estimateSource: est.source,
        estimateSampleSize: est.sampleSize,
        daysAtRisk: Math.max(0, daysBetweenDates(start, expectedDate)),
        detail: dep.detail,
      };
      const list = byTask.get(taskId);
      if (list) list.push(row);
      else byTask.set(taskId, [row]);
    }
  }

  const tasks: ConsentTaskRow[] = [];
  for (const [taskId, deps] of byTask) {
    const task = taskById.get(taskId)!;
    deps.sort((a, b) => b.daysAtRisk - a.daysAtRisk || a.reference.localeCompare(b.reference));
    const governing = deps[0]!;
    const start = task.startDate ?? task.actualStart;
    const float = task.totalFloat;
    const slip = task.isCritical
      ? governing.daysAtRisk
      : float != null
        ? Math.max(0, governing.daysAtRisk - float)
        : null;
    const sourceWord =
      governing.estimateSource === "observed_median"
        ? `the project's own median of ${governing.estimateSampleSize} comparable resolutions`
        : governing.estimateSource === "default"
          ? `the documented planning assumption for a ${governing.status} ${governing.kind}`
          : `a conservative ${UNKNOWN_STATE_DAYS}-day assumption (no rule for state "${governing.status}")`;
    tasks.push({
      taskId,
      taskName: task.name,
      wbsCode: task.wbsCode,
      plannedStart: task.startDate,
      actualStart: task.actualStart,
      daysUntilStart: start ? daysBetweenDates(args.today, start) : null,
      isCritical: task.isCritical,
      totalFloat: float,
      dependencies: deps,
      daysAtRisk: governing.daysAtRisk,
      slipContribution: slip,
      startedUnconsented: task.actualStart != null,
      basis:
        `Governed by ${governing.kind} ${governing.reference} (${governing.status}), expected to ` +
        `clear ${governing.expectedResolutionDate} on ${sourceWord}, against a planned start of ` +
        `${start ?? "—"}.` +
        (task.isCritical
          ? ` The task is on the critical path, so its ${governing.daysAtRisk} day(s) at risk pass ` +
            `straight into the programme.`
          : float != null
            ? ` ${float} day(s) of total float absorb part of it; ${slip} day(s) would pass into ` +
              `the programme.`
            : ` The task carries no total float figure and is not flagged critical, so the ` +
              `programme effect cannot be quantified from the schedule as it stands.`),
    });
  }

  tasks.sort(
    (a, b) =>
      Number(b.startedUnconsented) - Number(a.startedUnconsented) ||
      Number(b.isCritical) - Number(a.isCritical) ||
      b.daysAtRisk - a.daysAtRisk ||
      (a.plannedStart ?? "").localeCompare(b.plannedStart ?? ""),
  );

  const quantified = tasks
    .map((t) => t.slipContribution)
    .filter((v): v is number => v !== null);
  const blockingParcels = new Set<string>();
  const blockingPermits = new Set<string>();
  for (const t of tasks) {
    for (const d of t.dependencies) {
      if (d.kind === "parcel") blockingParcels.add(d.id);
      else blockingPermits.add(d.id);
    }
  }
  const startedList = tasks.filter((t) => t.startedUnconsented);
  const soonest = tasks
    .map((t) => t.plannedStart)
    .filter((v): v is string => Boolean(v))
    .sort()[0];

  return {
    horizonDays: args.horizonDays,
    tasks,
    summary: {
      blockedTasks: tasks.length,
      criticalBlockedTasks: tasks.filter((t) => t.isCritical).length,
      startedUnconsented: startedList.length,
      blockingParcels: blockingParcels.size,
      blockingPermits: blockingPermits.size,
      projectedSlipDays: quantified.length > 0 ? Math.max(...quantified) : null,
      unquantifiedTasks: tasks.filter((t) => t.slipContribution === null).length,
      soonestBlockedStart: soonest ?? null,
    },
  };
}
