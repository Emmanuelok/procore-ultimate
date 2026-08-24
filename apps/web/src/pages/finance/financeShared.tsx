/**
 * Shared types + presentational helpers for the project finance workspace
 * (spec Vol II Domain O / M14). Mirrors the API view-models: facility rows
 * carry disbursed/undisbursed/openConditions/daysToClosing aggregates, the
 * facility detail nests conditions, disbursements and covenants, and the
 * conditionality gate's 409 body carries the blocking conditions precedent.
 */

/* --------------------------------- Types ----------------------------------- */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Category allocation with utilisation (#739). */
export interface CategoryUtilisation {
  id: string;
  name: string;
  limit: number;
  disbursed: number;
  remaining: number;
}

export interface FacilityRow {
  id: string;
  name: string;
  lender: string;
  instrument: string;
  currency: string;
  committedAmount: number;
  availabilityEndDate: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** aggregates (#739-741) */
  disbursed: number;
  undisbursed: number;
  openConditions: number;
  pendingRequests: number;
  daysToClosing: number | null;
  categories: CategoryUtilisation[];
}

export interface ConditionRow {
  id: string;
  facilityId: string;
  kind: string; // precedent | subsequent
  reference: string | null;
  description: string;
  dueDate: string | null;
  status: string; // open | satisfied | waived | breached
  evidenceIds: string[];
  obligationId: string | null;
  satisfiedAt: string | null;
  satisfiedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Blocking condition as returned inside the 409 conditionality body (#733). */
export interface OpenConditionLite {
  id: string;
  reference: string | null;
  description: string;
  status: string;
  dueDate: string | null;
}

export interface DisbursementRow {
  id: string;
  facilityId: string;
  number: number;
  amount: number;
  categoryId: string | null;
  purpose: string;
  status: string; // draft | submitted | approved | disbursed | rejected
  evidenceIds: string[];
  conditionality: { verifiedAt?: string; openConditions?: OpenConditionLite[] } | null;
  submittedAt: string | null;
  submittedBy: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  disbursedAt: string | null;
  rejectionReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CovenantReadingRow {
  id: string;
  covenantId: string;
  readingDate: string;
  value: number;
  /** 0/1 */
  compliant: number;
  headroom: number;
  note: string | null;
  recordedBy: string;
  createdAt: string;
}

export interface CovenantRow {
  id: string;
  facilityId: string;
  name: string;
  description: string | null;
  operator: string; // gte | lte
  threshold: number;
  unit: string | null;
  createdAt: string;
  latestReading: CovenantReadingRow | null;
  compliant: boolean | null;
  headroom: number | null;
}

export interface FacilityDetailData extends FacilityRow {
  conditions: ConditionRow[];
  disbursements: DisbursementRow[];
  covenants: CovenantRow[];
}

export interface FinanceSummary {
  facilities: number;
  committed: number;
  disbursed: number;
  undisbursed: number;
  pendingRequests: number;
  openConditions: number;
  byCategory: Array<CategoryUtilisation & { facilityId: string; facilityName: string }>;
  covenantStatus: "breached" | "unknown" | "compliant" | null;
}

export interface EvidenceRow {
  id: string;
  kind: string;
  source: string;
  contentHash: string;
  capturedAt: string | null;
  ingestedAt: string;
}

/* -------------------------------- Helpers ----------------------------------- */

/** Facility money — whole units for the big aggregates, cents when present. */
export function fmtMoney(value: number | null | undefined, currency?: string | null): string {
  if (value === null || value === undefined) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "GBP",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  }
}

export function fmtNum(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

export function drLabel(n: number): string {
  return `DR-${String(n).padStart(3, "0")}`;
}

export function instrumentTone(instrument: string): string {
  switch (instrument) {
    case "loan":
      return "blue";
    case "grant":
      return "green";
    case "equity":
      return "violet";
    case "guarantee":
      return "amber";
    default:
      return "gray"; // blended
  }
}

export function conditionTone(status: string): string {
  switch (status) {
    case "open":
      return "blue";
    case "satisfied":
      return "green";
    case "waived":
      return "gray";
    case "breached":
      return "red";
    default:
      return "gray";
  }
}

export function disbursementTone(status: string): string {
  switch (status) {
    case "draft":
      return "gray";
    case "submitted":
      return "blue";
    case "approved":
      return "violet";
    case "disbursed":
      return "green";
    case "rejected":
      return "red";
    default:
      return "gray";
  }
}

export function opGlyph(operator: string): string {
  return operator === "gte" ? "≥" : "≤";
}

/** Whole days from today (local calendar, UTC dates) to an ISO date. */
export function daysUntil(isoDate: string): number {
  const today = new Date().toISOString().slice(0, 10);
  return Math.round(
    (Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
}

/* ------------------------------ Components ---------------------------------- */

/** Due-date countdown chip: red overdue, amber ≤7d, quiet otherwise. */
export function DueCountdown({ days }: { days: number | null | undefined }) {
  if (days === null || days === undefined) return <span className="text-xs text-ink-300">—</span>;
  const cls =
    days < 0
      ? "bg-red-100 text-red-800"
      : days <= 7
        ? "bg-amber-100 text-amber-800"
        : "bg-ink-100 text-ink-600";
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${cls}`}
    >
      {days < 0 ? `${-days}d overdue` : days === 0 ? "due today" : `${days}d left`}
    </span>
  );
}

/** Availability-end countdown (#741): amber inside 60 days, red once past. */
export function ClosingCountdown({ days }: { days: number | null }) {
  if (days === null) return <span className="text-xs text-ink-300">no closing date</span>;
  const cls =
    days < 0
      ? "bg-red-100 text-red-800"
      : days <= 60
        ? "bg-amber-100 text-amber-800"
        : "bg-ink-100 text-ink-600";
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${cls}`}
    >
      {days < 0 ? `closed ${-days}d ago` : days === 0 ? "closes today" : `closes in ${days}d`}
    </span>
  );
}

/** Committed vs disbursed progress bar. */
export function DisbursedBar({
  committed,
  disbursed,
  className,
}: {
  committed: number;
  disbursed: number;
  className?: string;
}) {
  const frac = committed > 0 ? Math.min(1, Math.max(0, disbursed / committed)) : 0;
  return (
    <div
      className={`h-2 w-full overflow-hidden rounded-full bg-ink-100 ${className ?? ""}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(frac * 100)}
      title={`${Math.round(frac * 100)}% disbursed`}
    >
      <div className="h-full rounded-full bg-brand-600" style={{ width: `${frac * 100}%` }} />
    </div>
  );
}
