/**
 * Shared types, vocabulary and presentational helpers for the Resource
 * Planning & Productivity workspace (spec Vol I §5.1–5.2, #676–699).
 *
 * The view-models mirror the API exactly, including its nulls. Three honesty
 * rules are implemented here so every panel obeys them:
 *
 *  1. A week with no recorded availability is UNKNOWN, not zero. It renders
 *     as "—" with the API's reason, never as a full-height red bar.
 *  2. Hours with no earn rate are SPENT, not unproductive. A productivity
 *     factor the API returned as null never renders as 0.
 *  3. A headcount the API could not derive — because the resource type
 *     records no standard working day — is "—" with that sentence attached,
 *     never an assumed eight-hour division.
 */
import { useCallback, useState, type ReactNode } from "react";
import { api, ApiClientError } from "../../lib/api";
import { Alert, Badge, cx } from "../../ui";
import type { Tone } from "../../ui/tokens";
import { useResource, type Loadable, type Paginated } from "../../layouts/project/lib";

export { useResource };
export type { Loadable, Paginated };

/* ================================= Types ================================== */

export interface ResourceType {
  id: string;
  projectId: string | null;
  code: string;
  name: string;
  description: string | null;
  kind: string;
  trade: string | null;
  equipmentCategory: string | null;
  unit: string;
  standardHoursPerDay: number | null;
  workingDaysPerWeek: number | null;
  defaultHourlyCost: number | null;
  currency: string;
  requiredSkillIds: string[];
  mapsToTrade: string | null;
  status: string;
  updatedAt: string;
}

export interface ResourceSkill {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string;
  trade: string | null;
  issuingBody: string | null;
  validityMonths: number | null;
  requiresEvidence: number;
  isMandatory: number;
  status: string;
  expires?: boolean;
  expiryNote?: string;
}

export interface ResourcePlan {
  id: string;
  projectId: string;
  number: number;
  reference: string;
  name: string;
  description: string | null;
  planKind: string;
  status: string;
  scheduleId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  weekStartsOn: number;
  source: string;
  version: number;
  derivedAt: string | null;
  derivedTaskCount: number;
  skippedTaskCount: number;
  demandRowCount: number;
  totalDemandHours: number;
  peakHeadcount: number | null;
  peakWeekStart: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanDetail extends ResourcePlan {
  demandRows: number;
  demandHours: number;
  byResourceType: Array<{
    resourceTypeId: string;
    code: string | null;
    name: string | null;
    kind: string | null;
    demandHours: number;
  }>;
  peakHeadcountBasis: string;
}

export interface DemandRow {
  id: string;
  planId: string;
  resourceTypeId: string;
  weekStart: string;
  demandHours: number;
  headcount: number | null;
  source: string;
  sourceTaskId: string | null;
  basis: string | null;
  resourceTypeCode?: string | null;
  resourceTypeName?: string | null;
  resourceTypeKind?: string | null;
}

export interface AvailabilityRow {
  id: string;
  resourceTypeId: string;
  weekStart: string;
  availableHours: number;
  availableHeadcount: number | null;
  source: string;
  note: string | null;
  resourceTypeCode?: string | null;
  resourceTypeName?: string | null;
}

export interface DeriveResult {
  plan: PlanDetail;
  rowsWritten: number;
  derivedTaskCount: number;
  totalDemandHours: number;
  skipped: Array<{ taskId: string; taskName: string; reason: string }>;
  skippedCount: number;
  calendar: { source: string; isDefault: boolean };
  reasons: string[];
}

export type HistogramState = "over" | "tight" | "ok" | "idle" | "unknown";

export interface HistogramCell {
  resourceTypeId: string;
  weekStart: string;
  demandHours: number;
  availableHours: number | null;
  availabilitySource: string | null;
  overAllocationHours: number | null;
  utilisationPercent: number | null;
  demandHeadcount: number | null;
  availableHeadcount: number | null;
  state: HistogramState;
  contributingTaskIds: string[];
  reasons: string[];
}

export interface HistogramSeries {
  resourceType: {
    id: string;
    code: string;
    name: string;
    kind: string;
    unit: string;
    standardHoursPerDay: number | null;
  };
  cells: HistogramCell[];
  totalDemandHours: number;
  peakDemandHours: number;
  peakWeekStart: string | null;
  totalAvailableHours: number | null;
  overWeeks: number;
  unknownSupplyWeeks: number;
  assumedSupplyWeeks: number;
  reasons: string[];
}

export interface LevellingSuggestion {
  resourceTypeId: string;
  resourceTypeName: string;
  weekStart: string;
  overAllocationHours: number;
  action: string;
  taskId: string | null;
  taskName: string | null;
  floatDays: number | null;
  moveHours: number | null;
  explanation: string;
}

export interface Histogram {
  plan: Pick<ResourcePlan, "id" | "reference" | "name" | "status" | "planKind" | "weekStartsOn"> | null;
  window: { from: string; to: string };
  calendar: { source: string; isDefault: boolean };
  weeks: string[];
  series: HistogramSeries[];
  totals: {
    demandHours: number;
    availableHours: number | null;
    overAllocatedCells: number;
    unknownSupplyCells: number;
    peakWeekStart: string | null;
    peakDemandHours: number;
  };
  levelling: LevellingSuggestion[];
  reasons: string[];
}

export interface Assignment {
  id: string;
  projectId: string;
  number: number;
  reference: string;
  resourceTypeId: string | null;
  subjectKind: string;
  crewId: string | null;
  workerId: string | null;
  equipmentId: string | null;
  subjectLabel: string;
  scheduleTaskId: string | null;
  locationId: string | null;
  fromDate: string;
  toDate: string;
  shift: string;
  hoursPerDay: number | null;
  allocationPercent: number;
  plannedHours: number | null;
  status: string;
  cancelledReason: string | null;
  notes: string | null;
  taskName?: string | null;
  resourceTypeName?: string | null;
  conflicts?: Conflict[];
  conflictWarning?: string | null;
}

export interface Conflict {
  subjectKind: string;
  subjectId: string;
  subjectLabel: string;
  fromDate: string;
  toDate: string;
  days: number;
  participants: Array<{
    assignmentId: string;
    reference: string;
    allocationPercent: number;
    scheduleTaskId: string | null;
    taskName: string | null;
  }>;
  totalAllocationPercent: number;
  overByPercent: number;
  severity: string;
  explanation: string;
}

export interface CalendarView {
  window: { from: string; to: string };
  days: Array<{ date: string; working: boolean }>;
  calendar: { source: string; isDefault: boolean };
  lanes: Array<{
    subjectKind: string;
    subjectId: string;
    subjectLabel: string;
    bookings: Array<{
      id: string;
      reference: string;
      fromDate: string;
      toDate: string;
      status: string;
      allocationPercent: number;
      hoursPerDay: number | null;
      plannedHours: number | null;
      shift: string;
      scheduleTaskId: string | null;
      taskName: string | null;
      notes: string | null;
    }>;
  }>;
  conflicts: Conflict[];
  reasons: string[];
}

export interface UtilisationRow {
  subjectKind: string;
  subjectId: string;
  subjectLabel: string;
  bookedDays: number;
  windowDays: number;
  utilisationPercent: number | null;
  assignments: number;
  plannedHours: number | null;
  reasons: string[];
}

export interface UtilisationView {
  window: { from: string; to: string };
  calendar: { source: string; isDefault: boolean };
  items: UtilisationRow[];
  total: number;
  averageUtilisationPercent: number | null;
  reasons: string[];
}

export interface ProductivityBucket {
  key: string;
  label: string;
  actualHours: number;
  earnedHours: number | null;
  productivityFactor: number | null;
  installedQuantity: number | null;
  unit: string | null;
  achievedUnitRate: number | null;
  plannedUnitRate: number | null;
  unearnableHours: number;
  reasons: string[];
}

export interface ProductivityWeek extends ProductivityBucket {
  weekStart: string;
}

export interface ProductivityReport {
  window: { from: string; to: string };
  weeks: ProductivityWeek[];
  byResourceType: ProductivityBucket[];
  byCrew: ProductivityBucket[];
  totals: {
    actualHours: number;
    earnedHours: number | null;
    productivityFactor: number | null;
    unearnableHours: number;
    allocationsConsidered: number;
    linesMeasured: number;
    linesUnmeasurable: number;
  };
  reasons: string[];
}

export interface MeasuredMilePeriod {
  from: string;
  to: string;
  weeks: number;
  actualHours: number;
  earnedHours: number;
  productivityFactor: number;
}

export interface MeasuredMile {
  window: { from: string; to: string };
  weeks: Array<{
    weekStart: string;
    actualHours: number;
    earnedHours: number | null;
    productivityFactor: number | null;
    reasons: string[];
  }>;
  mile: MeasuredMilePeriod | null;
  impacted: MeasuredMilePeriod | null;
  lostHours: number | null;
  lostHoursPercent: number | null;
  measuredWeeks: number;
  unmeasurableWeeks: number;
  explanation: string;
  forensicsNote: string;
  reasons: string[];
}

export interface ForecastResult {
  method: string;
  budgetHours: number | null;
  actualHours: number;
  earnedHours: number | null;
  productivityFactor: number | null;
  percentComplete: number | null;
  remainingHours: number | null;
  forecastHoursAtCompletion: number | null;
  varianceHours: number | null;
  confidence: string | null;
  basis: string;
  reasons: string[];
}

export interface ForecastView {
  window: { from: string; to: string };
  method: string;
  resourceTypeId: string | null;
  forecast: ForecastResult;
  totals: ProductivityReport["totals"];
  reasons: string[];
  history: Array<{
    id: string;
    asOfDate: string;
    method: string;
    forecastHoursAtCompletion: number | null;
    varianceHours: number | null;
    productivityFactor: number | null;
    confidence: string | null;
    basis: string | null;
  }>;
}

export interface MatrixCell {
  skillId: string;
  skillCode: string;
  skillName: string;
  held: boolean;
  level: string | null;
  status: string | null;
  validity: string;
  daysToExpiry: number | null;
  certificateRef: string | null;
  expiresAt: string | null;
  reason: string;
}

export interface MatrixRow {
  worker: {
    id: string;
    reference: string;
    fullName: string;
    trade: string | null;
    vendorId: string | null;
    status: string;
  };
  cells: MatrixCell[];
  gapCount: number;
  expiringCount: number;
  expiredCount: number;
  unverifiedCount: number;
}

export interface SkillCoverage {
  skill: ResourceSkill;
  workersHolding: number;
  valid: number;
  expiring: number;
  expired: number;
  unknownExpiry: number;
  unverified: number;
  missing: number;
  coveragePercent: number | null;
  reasons: string[];
}

export interface SkillsMatrix {
  rows: MatrixRow[];
  coverage: SkillCoverage[];
  totals: {
    workers: number;
    skills: number;
    mandatoryGaps: number;
    expired: number;
    expiring: number;
    unverified: number;
  };
  warnDays: number;
  truncated: boolean;
  reasons: string[];
}

export interface SkillGap {
  assignmentId: string;
  assignmentReference: string;
  workerId: string;
  workerLabel: string;
  skillId: string;
  skillName: string;
  kind: string;
  severity: string;
  expiresAt: string | null;
  explanation: string;
}

export interface WorkerSkillRow {
  id: string;
  workerId: string;
  skillId: string;
  level: string;
  status: string;
  certificateRef: string | null;
  issuingBody: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  notes: string | null;
  workerReference: string;
  workerName: string;
  skillCode: string;
  skillName: string;
  skillCategory: string;
  isMandatory: boolean;
  validity: string;
  daysToExpiry: number | null;
  validityReason: string;
}

export interface ResourceSignal {
  id: string;
  projectId: string | null;
  detector: string;
  severity: string;
  confidence: number;
  title: string;
  explanation: string;
  disposition: string;
  occurrences: number;
  createdAt: string;
}

export interface ResourceSummary {
  plan: ResourcePlan | null;
  today: string;
  horizonEnd: string;
  coverage: {
    overWeeks: number | null;
    unknownSupplyWeeks: number | null;
    worstShortfall: {
      weekStart: string;
      resourceTypeId: string;
      resourceTypeName: string;
      shortfallHours: number;
      demandHours: number;
      availableHours: number | null;
    } | null;
    peakDemandHours: number | null;
    peakWeekStart: string | null;
  };
  bookings: { active: number; conflicts: number; worstConflict: Conflict | null };
  certifications: {
    workers: number;
    records: number;
    expired: number;
    expiring: number;
    unverified: number;
  };
  productivity: {
    window: { from: string; to: string };
    totals: ProductivityReport["totals"];
    weeks: ProductivityWeek[];
    latestForecast: {
      id: string;
      asOfDate: string;
      method: string;
      forecastHoursAtCompletion: number | null;
      varianceHours: number | null;
      confidence: string | null;
      basis: string | null;
    } | null;
    snapshots: number;
  };
  library: { resourceTypes: number; labourTypes: number; equipmentTypes: number };
  openSignals: { total: number; byDetector: Record<string, number>; items: ResourceSignal[] };
  reasons: string[];
}

/* ============================== Vocabulary ================================ */

export const PLAN_STATUS_TONE: Record<string, Tone> = {
  draft: "neutral",
  active: "success",
  superseded: "warning",
  archived: "neutral",
};

export const ASSIGNMENT_STATUS_TONE: Record<string, Tone> = {
  planned: "info",
  confirmed: "success",
  in_progress: "accent",
  completed: "neutral",
  cancelled: "neutral",
};

export const VALIDITY_TONE: Record<string, Tone> = {
  valid: "success",
  expiring: "warning",
  expired: "danger",
  unknown: "neutral",
};

export const HISTOGRAM_STATE_TONE: Record<HistogramState, Tone> = {
  over: "danger",
  tight: "warning",
  ok: "success",
  idle: "info",
  unknown: "neutral",
};

export const HISTOGRAM_STATE_LABEL: Record<HistogramState, string> = {
  over: "Short",
  tight: "No slack",
  ok: "Covered",
  idle: "Under-used",
  unknown: "Supply unknown",
};

export const FORECAST_METHODS = [
  { value: "productivity_factor", label: "Productivity factor" },
  { value: "remaining_quantity", label: "Remaining quantity" },
  { value: "planned_burn", label: "Planned burn" },
  { value: "manual", label: "Manual" },
] as const;

export const DETECTOR_LABEL: Record<string, string> = {
  resource_over_allocation: "Over-allocation",
  resource_assignment_conflict: "Double booking",
  resource_certification_expiry: "Certification expiry",
  resource_productivity_deviation: "Productivity shortfall",
  resource_unresourced_work: "Unresourced work",
};

export function severityTone(severity: string): Tone {
  if (severity === "critical" || severity === "high") return "danger";
  if (severity === "medium") return "warning";
  if (severity === "low") return "info";
  return "neutral";
}

/* ============================== Formatting ================================ */

export const DASH = "—";

export function num(value: number | null | undefined, dp = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return value.toLocaleString(undefined, { maximumFractionDigits: dp });
}

export function hours(value: number | null | undefined, dp = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: dp })} h`;
}

export function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return value.toLocaleString();
}

/** A productivity factor. 1.00 is on plan; below 1 bought less than it cost. */
export function factor(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return value.toFixed(2);
}

export function percent(value: number | null | undefined, dp = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${value.toFixed(dp)}%`;
}

export function dateOnly(value: string | null | undefined): string {
  if (!value) return DASH;
  return value.slice(0, 10);
}

export function shortDate(value: string | null | undefined): string {
  if (!value) return DASH;
  const d = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return DASH;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? DASH : d.toLocaleString();
}

export function titleCase(value: string | null | undefined): string {
  if (!value) return DASH;
  return value
    .split(/[_\s-]+/)
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function shiftIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return shiftIso(iso, -((d.getUTCDay() - 1 + 7) % 7));
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "The request failed.";
}

/* ============================== Components ================================ */

export function LoadError({
  message,
  onRetry,
  title = "This panel could not be loaded",
}: {
  message: string;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <Alert
      tone="danger"
      title={title}
      actions={
        onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-danger-border bg-surface-raised px-2.5 py-1 text-meta font-medium text-content hover:bg-surface-hover"
          >
            Retry
          </button>
        ) : undefined
      }
    >
      {message}
    </Alert>
  );
}

export function Row({
  label,
  children,
  hint,
}: {
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-meta text-content-subtle">{label}</dt>
      <dd className="min-w-0 text-right text-meta text-content">
        <div>{children}</div>
        {hint ? <div className="text-2xs text-content-subtle">{hint}</div> : null}
      </dd>
    </div>
  );
}

/** Why a figure is not available — printed instead of a zero. */
export function ReasonList({ reasons, className }: { reasons: string[]; className?: string }) {
  if (reasons.length === 0) return null;
  return (
    <ul className={cx("space-y-0.5 text-2xs text-content-subtle", className)}>
      {reasons.map((r, i) => (
        <li key={i}>· {r}</li>
      ))}
    </ul>
  );
}

export function Pill({ status, map }: { status: string; map: Record<string, Tone> }) {
  return (
    <Badge tone={map[status] ?? "neutral"} size="xs" dot>
      {titleCase(status)}
    </Badge>
  );
}

/* ================================ Hooks =================================== */

export function useAction(): {
  busy: string | null;
  error: string | null;
  clear: () => void;
  run: <T>(key: string, fn: () => Promise<T>) => Promise<T | null>;
} {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(key);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);
  const clear = useCallback(() => setError(null), []);
  return { busy, error, clear, run };
}

export function useSummary(projectId: string): Loadable<ResourceSummary> {
  return useResource<ResourceSummary>(
    projectId ? `/api/v1/projects/${projectId}/resources/summary` : null,
  );
}

/* ============================== API surface =============================== */

const p = (projectId: string) => `/api/v1/projects/${projectId}`;

export const resourcesApi = {
  /* library */
  types: (params = "") => api.get<Paginated<ResourceType>>(`/api/v1/resource-types?${params}`),
  createType: (body: unknown) => api.post<ResourceType>("/api/v1/resource-types", body),
  patchType: (id: string, body: unknown) =>
    api.patch<ResourceType>(`/api/v1/resource-types/${id}`, body),
  skills: (params = "") => api.get<Paginated<ResourceSkill>>(`/api/v1/resource-skills?${params}`),
  createSkill: (body: unknown) => api.post<ResourceSkill>("/api/v1/resource-skills", body),

  /* plans */
  plans: (projectId: string, params = "") =>
    api.get<Paginated<ResourcePlan>>(`${p(projectId)}/resource-plans?${params}`),
  plan: (projectId: string, id: string) =>
    api.get<PlanDetail>(`${p(projectId)}/resource-plans/${id}`),
  createPlan: (projectId: string, body: unknown) =>
    api.post<PlanDetail>(`${p(projectId)}/resource-plans`, body),
  activatePlan: (projectId: string, id: string) =>
    api.post<PlanDetail>(`${p(projectId)}/resource-plans/${id}/activate`, {}),
  archivePlan: (projectId: string, id: string) =>
    api.post<PlanDetail>(`${p(projectId)}/resource-plans/${id}/archive`, {}),
  derive: (projectId: string, id: string, body: unknown) =>
    api.post<DeriveResult>(`${p(projectId)}/resource-plans/${id}/derive`, body),
  demand: (projectId: string, planId: string, params = "") =>
    api.get<Paginated<DemandRow>>(`${p(projectId)}/resource-plans/${planId}/demand?${params}`),
  addDemand: (projectId: string, planId: string, body: unknown) =>
    api.post<DemandRow>(`${p(projectId)}/resource-plans/${planId}/demand`, body),
  deleteDemand: (projectId: string, planId: string, id: string) =>
    api.del<{ id: string }>(`${p(projectId)}/resource-plans/${planId}/demand/${id}`),

  /* supply */
  availability: (projectId: string, params = "") =>
    api.get<Paginated<AvailabilityRow>>(`${p(projectId)}/resource-availability?${params}`),
  setAvailability: (projectId: string, body: unknown) =>
    api.put<AvailabilityRow>(`${p(projectId)}/resource-availability`, body),
  bulkAvailability: (projectId: string, body: unknown) =>
    api.post<{ weeks: number }>(`${p(projectId)}/resource-availability/bulk`, body),
  histogram: (projectId: string, params = "") =>
    api.get<Histogram>(`${p(projectId)}/resources/histogram?${params}`),

  /* calendar */
  assignments: (projectId: string, params = "") =>
    api.get<Paginated<Assignment>>(`${p(projectId)}/resource-assignments?${params}`),
  createAssignment: (projectId: string, body: unknown) =>
    api.post<Assignment>(`${p(projectId)}/resource-assignments`, body),
  transitionAssignment: (projectId: string, id: string, action: string, body: unknown = {}) =>
    api.post<Assignment>(`${p(projectId)}/resource-assignments/${id}/${action}`, body),
  calendar: (projectId: string, params: string) =>
    api.get<CalendarView>(`${p(projectId)}/resources/calendar?${params}`),
  utilisation: (projectId: string, params: string) =>
    api.get<UtilisationView>(`${p(projectId)}/resources/utilisation?${params}`),

  /* productivity */
  productivity: (projectId: string, params = "") =>
    api.get<ProductivityReport>(`${p(projectId)}/resources/productivity?${params}`),
  snapshot: (projectId: string, body: unknown) =>
    api.post<{ rowsWritten: number }>(`${p(projectId)}/resources/productivity/snapshot`, body),
  measuredMile: (projectId: string, params = "") =>
    api.get<MeasuredMile>(`${p(projectId)}/resources/measured-mile?${params}`),
  forecast: (projectId: string, params = "") =>
    api.get<ForecastView>(`${p(projectId)}/resources/forecast?${params}`),
  keepForecast: (projectId: string, body: unknown) =>
    api.post<{ id: string }>(`${p(projectId)}/resources/forecast`, body),

  /* skills */
  matrix: (projectId: string, params = "") =>
    api.get<SkillsMatrix>(`${p(projectId)}/resources/skills-matrix?${params}`),
  gaps: (projectId: string, params = "") =>
    api.get<{ window: { from: string; to: string }; total: number; items: SkillGap[]; reasons: string[] }>(
      `${p(projectId)}/resources/skill-gaps?${params}`,
    ),
  workerSkills: (projectId: string, params = "") =>
    api.get<Paginated<WorkerSkillRow>>(`${p(projectId)}/worker-skills?${params}`),
  recordWorkerSkill: (projectId: string, body: unknown) =>
    api.post<WorkerSkillRow>(`${p(projectId)}/worker-skills`, body),
  verifyWorkerSkill: (projectId: string, id: string, body: unknown) =>
    api.post<WorkerSkillRow>(`${p(projectId)}/worker-skills/${id}/verify`, body),

  /* operations */
  runSweeps: (projectId: string, body: unknown = {}) =>
    api.post<Record<string, unknown>>(`${p(projectId)}/resources/sweeps/run`, body),
};
