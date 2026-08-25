/**
 * Shared view-models, labels and presentational primitives for the
 * multi-jurisdiction workspace (spec Vol II Domain K / module M19).
 *
 * The types mirror the API exactly. Three conventions carried from the server
 * are load-bearing here and are stated once, in this file, so every tab reads
 * them the same way:
 *
 *  · RATE DIRECTION — a rate `from → to` is the number of units of `to` bought
 *    by one unit of `from`. A portion's `baseRate` is therefore units of the
 *    portion currency per 1 unit of the config's base currency.
 *  · MISSING MARKET RATE — a portion with no quote on or before the as-of date
 *    comes back with nulls, not zeros, and is EXCLUDED from the variance. Null
 *    is rendered as an em-dash, never as 0.00, because a zero variance and an
 *    unknown variance are different statements.
 *  · SIGN — a positive base variance means the contractual rates are expensive
 *    against today's market. Red is reserved for that adverse direction.
 */
import type { ReactNode } from "react";
import { Card, CardBody } from "../../ui";

/* ================================ Types ================================== */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** One currency share of a contract sum (#593-595). */
export interface Portion {
  currency: string;
  proportionPercent: number;
  /** units of `currency` per 1 unit of the config's base currency */
  baseRate: number;
}

export interface CurrencyConfigRow {
  id: string;
  companyId: string;
  projectId: string;
  contractId: string | null;
  baseCurrency: string;
  baseDate: string;
  portions: Portion[];
  rateSource: string;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** How a rate was arrived at — reported so the audit trail is explicit. */
export type ConversionPath = "identity" | "direct" | "inverse" | "triangulated";

export interface RateQuote {
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  rateDate: string;
  source: string;
}

export interface SplitLine {
  currency: string;
  proportionPercent: number;
  baseAmount: number;
  contractualRate: number;
  contractualAmount: number;
  marketRate: number | null;
  marketRateDate: string | null;
  marketRatePath: ConversionPath | null;
  marketAmount: number | null;
  fxVariance: number | null;
  contractualBaseEquivalent: number | null;
  baseVariance: number | null;
}

export interface SplitTotals {
  baseAmount: number;
  proportionPercent: number;
  coveredBaseAmount: number;
  coveredBaseEquivalent: number;
  baseVariance: number;
  missingRates: string[];
}

export interface SplitResponse {
  configId: string;
  contractId: string | null;
  baseDate: string;
  asOf: string;
  amount: number;
  baseCurrency: string;
  lines: SplitLine[];
  totals: SplitTotals;
  note: string | null;
}

export interface ExposureItem {
  configId: string;
  contractId: string | null;
  contractName: string | null;
  baseCurrency: string;
  baseDate: string;
  contractSum: number | null;
  contractualValue: number | null;
  marketValue: number | null;
  variance: number | null;
  variancePercent: number | null;
  lines: SplitLine[];
  missingRates: string[];
  notes: string[];
}

export interface ExposureTotal {
  baseCurrency: string;
  configs: number;
  contractualValue: number;
  marketValue: number;
  variance: number;
}

export interface ExposureResponse {
  asOf: string;
  items: ExposureItem[];
  totals: ExposureTotal[];
  unpriced: number;
}

export interface FxRateRow {
  id: string;
  companyId: string;
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  rateDate: string;
  source: string;
  sourceReference: string | null;
  recordedBy: string;
  createdAt: string;
}

export interface ConvertResponse {
  amount: number;
  fromCurrency: string;
  toCurrency: string;
  converted: number;
  rate: number;
  rateDate: string | null;
  path: ConversionPath;
  via?: string;
  legs: RateQuote[];
  asOf: string;
  source: string | null;
}

export interface PermitCondition {
  id: string;
  text: string;
  dueDate: string | null;
  closed: boolean;
  closedAt: string | null;
  closedBy: string | null;
  note: string | null;
}

/** Permit register row — the server adds the derived block to every read. */
export interface PermitRow {
  id: string;
  companyId: string;
  projectId: string;
  number: number;
  kind: string;
  title: string;
  authority: string;
  jurisdiction: string | null;
  reference: string | null;
  appliedAt: string | null;
  expectedDays: number | null;
  dueAt: string | null;
  grantedAt: string | null;
  expiresAt: string | null;
  status: string;
  conditions: PermitCondition[];
  blockingTaskIds: string[];
  obligationId: string | null;
  fileIds: string[];
  ownerId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /* derived (permitDerived) */
  daysToDue: number | null;
  daysToExpiry: number | null;
  overdue: boolean;
  openConditions: number;
  blockingTaskCount: number;
}

export interface PermitBlockingTask {
  id: string;
  name: string;
  wbsCode: string | null;
  startDate: string | null;
  constraintDate: string | null;
  isCritical: number;
  daysUntilStart: number | null;
}

export interface ObligationRow {
  id: string;
  sourceClause: string;
  trigger: string | null;
  deadline: string | null;
  status: string;
  evidenceRequirement: string | null;
}

export interface PermitDetail extends PermitRow {
  blockingTasks: PermitBlockingTask[];
  obligation: ObligationRow | null;
}

export interface ScheduleRiskItem {
  permitId: string;
  permitNumber: number;
  permitTitle: string;
  kind: string;
  authority: string;
  status: string;
  dueAt: string | null;
  taskId: string;
  taskName: string;
  wbsCode: string | null;
  startDate: string;
  daysUntilStart: number;
  isCritical: boolean;
  /** the point of the view: work that cannot lawfully start on time */
  blocked: boolean;
}

export interface ScheduleRiskResponse {
  days: number;
  horizon: string;
  items: ScheduleRiskItem[];
  total: number;
  summary: {
    blockedTasks: number;
    blockingPermits: number;
    criticalBlocked: number;
    soonestBlockedStart: string | null;
  };
}

export interface LocalReadingRow {
  id: string;
  targetId: string;
  companyId: string;
  readingDate: string;
  value: number;
  /** 0/1 as stored; the API also returns `compliantBool` on detail reads */
  compliant: number;
  basis: string | null;
  recordedBy: string;
  createdAt: string;
}

export interface LocalTargetRow {
  id: string;
  companyId: string;
  projectId: string;
  name: string;
  jurisdiction: string;
  metric: string;
  targetValue: number;
  unit: string;
  periodStart: string | null;
  periodEnd: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /* aggregates added by the list read */
  latestReading: LocalReadingRow | null;
  latestValue: number | null;
  compliant: boolean | null;
  /** positive gap = distance still to travel to reach the floor */
  gap: number | null;
  readingCount: number;
}

export interface ReadingsResponse {
  target: LocalTargetRow;
  items: (LocalReadingRow & { gap: number; compliantBool: boolean })[];
  total: number;
  breaches: number;
}

/** Pickers. */
export interface SchedulePickRow {
  id: string;
  name: string;
  isActive: number;
  projectStart: string | null;
}

export interface ScheduleTaskRow {
  id: string;
  scheduleId: string;
  name: string;
  wbsCode: string | null;
  startDate: string | null;
  constraintDate: string | null;
  durationDays: number;
  isCritical: number;
}

export interface ScheduleDetail extends SchedulePickRow {
  tasks: ScheduleTaskRow[];
}

export interface ContractPickRow {
  id: string;
  name: string;
  contractSum: number | null;
  currency: string | null;
  status: string;
}

/* =============================== Labels ================================== */

export const PERMIT_KIND_LABELS: Record<string, string> = {
  work_permit: "Work permit",
  visa: "Visa",
  import_licence: "Import licence",
  customs_clearance: "Customs clearance",
  road_closure: "Road closure",
  environmental_consent: "Environmental consent",
  planning_condition: "Planning condition",
  utility_wayleave: "Utility wayleave",
  other: "Other",
};

export const PERMIT_STATUS_LABELS: Record<string, string> = {
  not_started: "Not started",
  applied: "Applied",
  in_review: "In review",
  granted: "Granted",
  refused: "Refused",
  expired: "Expired",
};

export const FX_SOURCE_LABELS: Record<string, string> = {
  contractual: "Contractual",
  central_bank: "Central bank",
  market: "Market",
  manual: "Manual",
};

export const FX_SOURCE_DESCRIPTIONS: Record<string, string> = {
  contractual:
    "A rate fixed by the contract itself — the base-date rate the parties agreed to apply, not a market observation.",
  central_bank:
    "Published by the issuing central bank. Usually the reference a rate-of-exchange clause points at.",
  market: "An observed market or dealing rate. Attribute the venue in the reference.",
  manual: "Keyed in by hand. Record where it came from, because a rate dispute is won on provenance.",
};

/** Local content metric labels — humanized, not raw keys (#612-615). */
export const METRIC_LABELS: Record<string, string> = {
  local_spend_percent: "Local spend",
  local_headcount_percent: "Local headcount",
  icv_score: "ICV score",
  national_quota: "National quota",
};

export const METRIC_DESCRIPTIONS: Record<string, string> = {
  local_spend_percent:
    "Share of project spend placed with in-country suppliers and subcontractors, measured on the stated basis.",
  local_headcount_percent:
    "Share of the workforce that are nationals or in-country residents, measured on the stated basis.",
  icv_score:
    "In-Country Value score under the applicable ICV certification scheme. A floor, like every other local-content undertaking.",
  national_quota:
    "Contractual or statutory nationalisation quota — the minimum proportion of nationals the licence requires.",
};

export const PATH_LABELS: Record<ConversionPath, string> = {
  identity: "Identity",
  direct: "Direct quote",
  inverse: "Reciprocal",
  triangulated: "Triangulated",
};

export const PATH_DESCRIPTIONS: Record<ConversionPath, string> = {
  identity: "Same currency both sides — rate 1, no quote used.",
  direct: "A quote for this exact ordered pair was on file.",
  inverse:
    "No quote for this pair; the reciprocal of the opposite quote was used. Arithmetically sound, but note that a dealing spread makes buy and sell rates differ in practice.",
  triangulated:
    "No quote either way; both legs were resolved through a configured base currency. A triangulated rate is only as fresh as its stalest leg, and the date shown is that earlier leg.",
};

/* =============================== Formats ================================= */

export function fmtNum(value: number | null | undefined, dp = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: dp,
  }).format(value);
}

export function fmtPct(value: number | null | undefined, dp = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: dp }).format(value)}%`;
}

/**
 * Money in a named currency. Currency codes here are user-entered contract
 * currencies, so an unknown code falls back to a plain number rather than
 * throwing out of Intl.
 */
export function fmtMoney(value: number | null | undefined, currency?: string | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: (currency || "USD").toUpperCase(),
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${fmtNum(value, 2)}${currency ? ` ${currency}` : ""}`;
  }
}

/** Money with an explicit sign — variances always state their direction. */
export function fmtSignedMoney(value: number | null | undefined, currency?: string | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const body = fmtMoney(Math.abs(value), currency);
  if (value === 0) return body;
  return `${value > 0 ? "+" : "−"}${body}`;
}

/** Rates carry 8 decimals on the wire so that reported equals applied. */
export function fmtRate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  }).format(value);
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Add whole days to an ISO date in UTC — mirrors the server's addDaysISO. */
export function addDaysISO(iso: string, days: number): string | null {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(ms) || !Number.isFinite(days)) return null;
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/** "in 12 days" / "9 days ago" / "today" — countdowns are read, not computed. */
export function countdownLabel(days: number | null | undefined): string {
  if (days === null || days === undefined || !Number.isFinite(days)) return "—";
  if (days === 0) return "today";
  const n = Math.abs(days);
  const unit = n === 1 ? "day" : "days";
  return days > 0 ? `in ${n} ${unit}` : `${n} ${unit} ago`;
}

/* ================================ Tones ================================== */

export function permitStatusTone(status: string): string {
  switch (status) {
    case "granted":
      return "green";
    case "applied":
    case "in_review":
      return "blue";
    case "refused":
    case "expired":
      return "red";
    default:
      return "gray"; // not_started
  }
}

export function fxSourceTone(source: string): string {
  switch (source) {
    case "contractual":
      return "violet";
    case "central_bank":
      return "blue";
    case "market":
      return "green";
    default:
      return "gray"; // manual
  }
}

/**
 * Variance colouring. Positive = the contractual position costs more than the
 * market today, which is the adverse direction, so it is the only one that
 * earns red. Nulls are neither: they are unknown.
 */
export function varianceClass(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "text-ink-400";
  if (value > 0) return "text-red-700";
  if (value < 0) return "text-emerald-700";
  return "text-ink-700";
}

/* ============================ Chart palette ============================== */

export const CHART = {
  brand900: "#19398d",
  brand700: "#164bde",
  brand600: "#1d60f1",
  brand400: "#59a1ff",
  brand200: "#bcdaff",
  brand50: "#eef6ff",
  ink100: "#ebedf1",
  ink200: "#d3d8e0",
  ink300: "#acb6c5",
  ink400: "#7f8ea4",
  ink600: "#4b5a72",
  amber: "#d97706",
  emerald: "#059669",
  red: "#dc2626",
} as const;

/** Round an axis maximum up to a readable 1 / 2 / 5 × 10ⁿ. */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  const n = value / base;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * base;
}

/* ============================= Components ================================ */

export function TabBar({
  tabs,
  active,
  onSelect,
}: {
  tabs: { key: string; label: string }[];
  active: string;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="mb-5 flex flex-wrap gap-1 border-b border-ink-200">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onSelect(t.key)}
          className={
            active === t.key
              ? "-mb-px border-b-2 border-brand-600 px-3 py-2 text-sm font-medium text-brand-700"
              : "-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-ink-500 hover:text-ink-800"
          }
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone,
  title,
  emphasized,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "brand" | "red" | "amber" | "green";
  /** native tooltip — used to explain a measure rather than decorate it */
  title?: string;
  emphasized?: boolean;
}) {
  const valueCls =
    tone === "red"
      ? "text-red-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "green"
          ? "text-emerald-700"
          : tone === "brand"
            ? "text-brand-700"
            : "text-ink-900";
  return (
    <Card className={emphasized ? "ring-2 ring-brand-200" : undefined}>
      <CardBody className="py-3">
        <div className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-ink-400">
          <span>{label}</span>
          {title ? (
            <span
              title={title}
              aria-label={title}
              className="cursor-help rounded-full border border-ink-200 px-1 text-[9px] leading-4 text-ink-400"
            >
              ?
            </span>
          ) : null}
        </div>
        <div
          className={`mt-0.5 ${emphasized ? "text-2xl" : "text-xl"} font-semibold tabular-nums ${valueCls}`}
        >
          {value}
        </div>
        {hint ? <div className="mt-0.5 text-xs text-ink-400">{hint}</div> : null}
      </CardBody>
    </Card>
  );
}

/** Progress meter. Tone is the caller's judgement, not the value's. */
export function Meter({
  percent,
  tone = "brand",
  size = "md",
  title,
}: {
  percent: number;
  tone?: "brand" | "green" | "amber" | "red";
  size?: "sm" | "md" | "lg";
  title?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const fill =
    tone === "red"
      ? "bg-red-600"
      : tone === "amber"
        ? "bg-amber-500"
        : tone === "green"
          ? "bg-emerald-600"
          : "bg-brand-600";
  const h = size === "lg" ? "h-3.5" : size === "sm" ? "h-1.5" : "h-2";
  return (
    <div
      className={`${h} w-full overflow-hidden rounded-full bg-ink-100`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      title={title ?? fmtPct(percent, 1)}
    >
      <div className={`h-full rounded-full ${fill}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}

/** Right-hand slide-over for record detail. */
export function Drawer({
  open,
  title,
  onClose,
  children,
  wide,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink-950/40">
      <div
        className={`h-full overflow-y-auto bg-white p-5 shadow-xl ${wide ? "w-full max-w-2xl" : "w-full max-w-lg"}`}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold text-ink-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A countdown chip: red once past, amber inside the warning window. */
export function Countdown({
  days,
  warnWithin = 30,
  overdueLabel = "overdue",
  title,
}: {
  days: number | null | undefined;
  warnWithin?: number;
  overdueLabel?: string;
  title?: string;
}) {
  if (days === null || days === undefined || !Number.isFinite(days)) {
    return <span className="text-ink-300">—</span>;
  }
  const cls =
    days < 0
      ? "text-red-700 font-medium"
      : days <= warnWithin
        ? "text-amber-700 font-medium"
        : "text-ink-600";
  return (
    <span className={`whitespace-nowrap tabular-nums ${cls}`} title={title}>
      {days < 0 ? `${overdueLabel} — ${countdownLabel(days)}` : countdownLabel(days)}
    </span>
  );
}

/** Compact key/value row used inside drawers. */
export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5 text-sm">
      <div className="w-40 shrink-0 text-xs text-ink-400">{label}</div>
      <div className="min-w-0 flex-1 text-ink-800">{children}</div>
    </div>
  );
}

/** A quiet caveat strip for figures that must not be read as complete. */
export function Caveat({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
      {children}
    </div>
  );
}

/** Small chart legend row. */
export function Legend({ items }: { items: { color: string; label: string; title?: string }[] }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-500">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5" title={i.title}>
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: i.color }}
          />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/** Error message from an API failure, preferring the server's own wording. */
export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
