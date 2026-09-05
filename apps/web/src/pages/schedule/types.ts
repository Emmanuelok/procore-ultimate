/**
 * Shared types + tiny date helpers for the schedule workspace. Shapes mirror
 * the schedule API module (apps/api/src/modules/schedule) — every field the
 * UI dereferences is read defensively where the server may omit it.
 */

export interface ScheduleRow {
  id: string;
  name: string;
  projectStart: string; // ISO date, CPM day 0
  isActive: number;
  computedFinish: string | null;
  computedDurationDays: number | null;
  lastComputedAt: string | null;
  /** progress data date — work before it is actual, after it is forecast */
  dataDate?: string | null;
  source?: string;
  revision?: number;
  parentScheduleId?: string | null;
  defaultCalendarId?: string | null;
}

export interface TaskRow {
  id: string;
  name: string;
  wbsCode: string | null;
  durationDays: number;
  constraintType: string | null;
  constraintDate: string | null;
  actualStart: string | null;
  actualFinish: string | null;
  percentComplete: number;
  sortOrder: number;
  /* computed by CPM, persisted server-side */
  startDate: string | null;
  finishDate: string | null; // inclusive last day
  totalFloat: number | null;
  isCritical: number;
  remainingDurationDays?: number | null;
  taskType?: string;
  calendarId?: string | null;
  isKeyMilestone?: number;
  contractualDate?: string | null;
  budgetedCost?: number | null;
  budgetedHours?: number | null;
  responsibleId?: string | null;
  locationId?: string | null;
}

export interface DepRow {
  id: string;
  predecessorId: string;
  successorId: string;
  depType: string;
  lagDays: number;
}

export interface ScheduleDetail extends ScheduleRow {
  tasks: TaskRow[];
  dependencies: DepRow[];
  summary?: {
    taskCount: number;
    dependencyCount: number;
    criticalCount: number;
  };
}

export interface ComputeSummary {
  projectFinishDate: string | null;
  durationDays: number;
  criticalCount: number;
  cycle?: string[];
}

export interface BaselineRow {
  id: string;
  name: string;
  projectStart: string;
  computedFinish: string | null;
  capturedAt: string;
  taskCount?: number;
}

/** Immutable per-task record inside a baseline snapshot. */
export interface BaselineTask {
  taskId: string;
  name: string;
  wbsCode: string | null;
  durationDays: number;
  startDate: string | null;
  finishDate: string | null;
  totalFloat: number | null;
  isCritical: boolean;
}

export interface BaselineDetail extends BaselineRow {
  snapshot: BaselineTask[];
}

export interface CompareItem {
  taskId: string;
  name: string;
  baselineStart: string | null;
  baselineFinish: string | null;
  currentStart: string | null;
  currentFinish: string | null;
  startVarianceDays: number | null;
  finishVarianceDays: number | null;
  floatChange: number | null;
  becameCritical: boolean;
  droppedCritical: boolean;
  added: boolean;
  removed: boolean;
}

export interface CompareResponse {
  baselineId?: string;
  baselineName?: string;
  capturedAt?: string;
  header: {
    baselineFinish: string | null;
    currentFinish: string | null;
    completionMovementDays: number | null;
  };
  items?: CompareItem[];
  tasks?: CompareItem[]; // defensive alias — accept either key
}

export interface LookaheadResponse {
  weeks: number;
  from: string;
  to: string;
  items: (TaskRow & { inProgress?: boolean; constraints?: ConstraintRow[] })[];
  total: number;
}

export interface QualityCheck {
  count: number;
  ids?: string[];
  ratio?: number | null;
  threshold?: string;
  pass: boolean;
  /** false when the inputs the check needs (baseline, data date, resources) are absent */
  applicable?: boolean;
  /** why the check could not run, or the basis of the computed figure */
  basis?: string;
  value?: number | null;
}

export interface QualityReport {
  taskCount: number;
  dependencyCount: number;
  checks: Record<string, QualityCheck>;
  criticalPercent?: number;
  passed?: number;
  total?: number;
  score: number;
  notApplicable?: string[];
  dataDate?: string | null;
  baselineName?: string | null;
}

/* ------------------------------------------------------------------ */
/* Upgrade-wave shapes (calendars, resources, constraints, EV, …)      */
/* ------------------------------------------------------------------ */

export interface CalendarRow {
  id: string;
  name: string;
  scheduleId: string | null;
  workdays: number[];
  holidays: string[];
  exceptions: string[];
  hoursPerDay: number;
  isDefault: number;
}

export interface ResourceRow {
  id: string;
  taskId: string;
  name: string;
  resourceType: string;
  unit: string | null;
  budgetedUnits: number;
  actualUnits: number;
  unitRate: number | null;
  budgetedCost: number;
  actualCost: number;
}

export interface ConstraintRow {
  id: string;
  number: number;
  scheduleId: string;
  taskId: string | null;
  description: string;
  category: string;
  status: string;
  ownerId: string | null;
  needByDate: string | null;
  clearedAt: string | null;
  escalatedAt: string | null;
  resolution: string | null;
}

export interface MilestoneRow {
  id: string;
  name: string;
  wbsCode: string | null;
  isKeyMilestone: boolean;
  contractualDate: string | null;
  forecastDate: string | null;
  actualFinish: string | null;
  slipDays: number | null;
  status: string;
  totalFloat: number | null;
  isCritical: boolean;
}

export interface EarnedValueResponse {
  scheduleId: string;
  baselineName: string | null;
  basis: string;
  currency: string;
  dataDate: string;
  bac: number;
  pv: number;
  ev: number;
  ac: number;
  sv: number;
  cv: number;
  spi: number | null;
  cpi: number | null;
  eac: number | null;
  etc: number | null;
  vac: number | null;
  scheduleEacDays: number | null;
  plannedDurationDays: number | null;
  pricedActivities: number;
  unpriced: number;
  reasons: string[];
  activities: {
    id: string;
    name: string;
    bac: number;
    pv: number;
    ev: number;
    ac: number;
    sv: number;
    cv: number;
  }[];
}

export interface NarrativeRow {
  id: string;
  title: string;
  body: string;
  periodStart: string | null;
  periodEnd: string | null;
  dataDate: string | null;
  metrics: Record<string, unknown> | null;
  createdAt: string;
}

export interface ImportRunRow {
  id: string;
  format: string;
  fileName: string;
  byteSize: number;
  scheduleId: string | null;
  targetScheduleId: string | null;
  stats: Record<string, unknown>;
  warnings: string[];
  createdAt: string;
}

export interface RevisionDiffSummary {
  totals: {
    from: number;
    to: number;
    added: number;
    removed: number;
    durationChanged: number;
    dateChanged: number;
    logicChanged: number;
  };
  addedTasks: { name: string }[];
  removedTasks: { name: string }[];
  durationChanges: { name: string; fromDays: number; toDays: number; deltaDays: number }[];
  dateChanges?: {
    name: string;
    fromFinish: string | null;
    toFinish: string | null;
    finishDeltaDays: number | null;
  }[];
  progressChanges?: { name: string; fromPercent: number; toPercent: number }[];
  duplicateKeys?: string[];
  logicAdded: { predecessor: string; successor: string; toType?: string }[];
  logicRemoved: { predecessor: string; successor: string; fromType?: string }[];
  logicChanged: { predecessor: string; successor: string; fromType?: string; toType?: string }[];
}

/* ------------------------------------------------------------------ */
/* Date helpers (UTC-day arithmetic, matching the CPM engine)          */
/* ------------------------------------------------------------------ */

export const DAY_MS = 86_400_000;

/** Absolute UTC day index of an ISO date — differences give whole days. */
export function dayNum(iso: string): number {
  return Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
}

export function isoOfDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Compact date for dense tables: "24 Aug". Full date belongs in a title. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/* ------------------------------------------------------------------ */
/* Resource loading (#370), revision comparison (#357), calendar view   */
/* ------------------------------------------------------------------ */

export interface ResourceTypeSummary {
  resourceType: string;
  budgetedUnits: number;
  actualUnits: number;
  budgetedCost: number;
  actualCost: number;
}

export interface ResourcesResponse {
  items: ResourceRow[];
  total: number;
  /** the project's active budget currency, or USD with a reason */
  currency: string;
  reasons: string[];
  byType: ResourceTypeSummary[];
}

export interface RevisionSide {
  id: string;
  name: string;
  revision?: number;
  computedFinish: string | null;
  dataDate: string | null;
}

export interface RevisionCompareResponse {
  from: RevisionSide;
  to: RevisionSide;
  completionMovementDays: number | null;
  diff: RevisionDiffSummary;
}

export interface CalendarViewDay {
  date: string;
  working: boolean;
  starting: { id: string; name: string; isCritical: boolean }[];
  finishing: { id: string; name: string; isCritical: boolean; isMilestone: boolean }[];
  inProgress: number;
}

export interface CalendarViewResponse {
  scheduleId: string;
  from: string;
  to: string;
  calendarId: string | null;
  calendarName: string | null;
  days: CalendarViewDay[];
}
