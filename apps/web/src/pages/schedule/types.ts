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
  items: TaskRow[];
  total: number;
}

export interface QualityCheck {
  count: number;
  ids?: string[];
  ratio?: number | null;
  threshold?: string;
  pass: boolean;
  value?: number;
}

export interface QualityReport {
  taskCount: number;
  dependencyCount: number;
  checks: Record<string, QualityCheck>;
  criticalPercent?: number;
  passed?: number;
  total?: number;
  score: number;
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
