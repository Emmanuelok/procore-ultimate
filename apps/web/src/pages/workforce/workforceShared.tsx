/**
 * Shared types and presentation helpers for the workforce rights & welfare
 * workspace (spec Vol II Domain M / module M17). Labour is presented as
 * PEOPLE WITH RIGHTS: the register carries verification state, the
 * reconciliation carries money at risk, and every failing measure is named
 * rather than averaged away.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { Badge, Card, CardBody } from "../../ui";

/* --------------------------------- Types ---------------------------------- */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface VendorRow {
  id: string;
  name: string;
}

export interface WorkerRow {
  id: string;
  reference: string;
  fullName: string;
  dateOfBirth: string | null;
  nationality: string | null;
  vendorId: string | null;
  vendorName: string | null;
  trade: string | null;
  idVerified: number;
  biometricEnrolled: number;
  contractIssued: number;
  contractLanguage: string | null;
  recruitmentAgency: string | null;
  agreedDailyRate: number | null;
  currency: string;
  accommodationRef: string | null;
  inductedAt: string | null;
  demobilisedAt: string | null;
  status: string;
  openRiskFlags: number;
}

export interface RiskFlagRow {
  id: string;
  workerId: string | null;
  vendorId: string | null;
  workerReference?: string | null;
  workerName?: string | null;
  vendorName?: string | null;
  indicator: string;
  severity: string;
  detail: string | null;
  source: string;
  signalId: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  createdAt: string;
  open?: boolean;
}

export interface AccessRow {
  id: string;
  accessDate: string;
  firstIn: string | null;
  lastOut: string | null;
  hoursOnSite: number | null;
  source: string;
}

export interface PayrollRow {
  id: string;
  periodStart: string;
  periodEnd: string;
  daysClaimed: number;
  hoursClaimed: number | null;
  grossPay: number;
  deductions: number;
  netPay: number;
  currency: string;
  paidAt: string | null;
  wpsReference: string | null;
}

export interface WorkerDetail extends WorkerRow {
  age: number | null;
  riskFlags: RiskFlagRow[];
  recentAccess: AccessRow[];
  latestPayroll: PayrollRow | null;
}

export interface ReconRow {
  workerId: string;
  reference: string;
  fullName: string;
  vendorId: string | null;
  currency: string;
  agreedDailyRate: number | null;
  daysClaimed: number;
  accessDays: number;
  unmatchedDays: number;
  claimRatio: number | null;
  impliedDailyRate: number | null;
  grossPay: number;
  valueAtRisk: number;
  wageShortfall: number;
  classification: "ghost" | "overclaim" | "underpaid" | "ok";
  reason: string;
  payrollEntries: number;
}

export interface ReconSummary {
  runId?: string;
  periodStart: string;
  periodEnd: string;
  workers: number;
  ghosts: number;
  overclaims: number;
  underpayments: number;
  signalsRaised?: number;
  persisted?: boolean;
  totals: {
    daysClaimed: number;
    accessDays: number;
    unmatchedDays: number;
    valueAtRisk: number;
    grossPay: number;
    wageShortfall: number;
  };
  rows: ReconRow[];
}

export interface VendorRiskRow {
  vendorId: string | null;
  vendorName: string;
  workers: number;
  contractIssued: number;
  idVerified: number;
  contractIssuedPct: number;
  idVerifiedPct: number;
  openFlags: number;
  flagsByIndicator: Record<string, number>;
  ghostSignals: number;
  overclaimSignals: number;
  components: { flags: number; reconciliation: number; contracts: number; identity: number };
  score: number;
  band: "low" | "medium" | "high" | "critical";
}

export interface VendorRiskResponse {
  items: VendorRiskRow[];
  total: number;
  weighting: string;
}

export interface WelfareArea {
  area: string;
  score: number;
  note: string | null;
  photoFileId: string | null;
}

export interface WelfareAction {
  id: string;
  text: string;
  dueDate: string | null;
  closed: boolean;
  closedAt: string | null;
  note: string | null;
}

export interface WelfareRow {
  id: string;
  inspectionDate: string;
  location: string;
  vendorId: string | null;
  vendorName?: string | null;
  areas: WelfareArea[];
  actions: WelfareAction[];
  occupancyCount: number | null;
  capacity: number | null;
  overallScore: number | null;
  openActions: number;
  failingAreas: number;
  overcrowded: boolean;
}

export interface AuditFinding {
  id: string;
  indicator: string | null;
  description: string;
  severity: string;
  capDueDate: string | null;
  obligationId: string | null;
  closedAt: string | null;
  closedNote: string | null;
  capBreachedAt: string | null;
  obligation?: { id: string; status: string; deadline: string | null } | null;
}

export interface AuditRow {
  id: string;
  vendorId: string;
  vendorName: string;
  scheduledFor: string;
  isUnannounced: number;
  status: string;
  findings: AuditFinding[];
  score: number | null;
  completedAt: string | null;
  findingCount?: number;
  openFindings?: number;
  overdueCaps?: number;
}

/* ------------------------------- Formatting -------------------------------- */

export const BRAND = "#1d60f1";
export const BRAND_MID = "#5b8bf7";
export const BRAND_SOFT = "#9dbafb";
export const BRAND_PALE = "#cddcfe";
export const GRID = "#ebedf1";
export const AXIS_INK = "#7f8ea4";
export const MARK_INK = "#4b5a72";
export const RED = "#dc2626";

export function fmtNum(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: dp });
}

export function fmtMoney(n: number | null | undefined, currency = "USD"): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${currency} ${fmtNum(n, 0)}`;
  }
}

export function fmtPct(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return "—";
  return `${Math.round(fraction * 100)}%`;
}

export function label(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .split(/[_\s]+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Whole days from today to `iso` — negative when the date has passed. Both
 * ends are read as UTC calendar dates so a timezone never shifts a deadline.
 */
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const target = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(target)) return null;
  const today = Date.parse(`${isoToday()}T00:00:00Z`);
  return Math.round((target - today) / 86_400_000);
}

/** "due in 5 days" / "due today" / "9 days overdue" — never a bare date. */
export function countdownText(iso: string | null | undefined): string | null {
  const d = daysUntil(iso);
  if (d === null) return null;
  if (d === 0) return "due today";
  if (d > 0) return `due in ${d} day${d === 1 ? "" : "s"}`;
  const late = Math.abs(d);
  return `${late} day${late === 1 ? "" : "s"} overdue`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* -------------------------------- Tone maps -------------------------------- */

export function bandTone(band: string): "green" | "amber" | "red" | "gray" {
  if (band === "critical" || band === "high") return "red";
  if (band === "medium") return "amber";
  if (band === "low") return "green";
  return "gray";
}

export function classificationTone(c: string): "green" | "amber" | "red" | "gray" {
  if (c === "ghost") return "red";
  if (c === "overclaim" || c === "underpaid") return "amber";
  if (c === "ok") return "green";
  return "gray";
}

export function severityTone(s: string): "green" | "amber" | "red" | "gray" | "blue" {
  if (s === "critical" || s === "high") return "red";
  if (s === "medium") return "amber";
  if (s === "low") return "blue";
  return "gray";
}

export function workerStatusTone(s: string): "green" | "amber" | "red" | "gray" {
  if (s === "active") return "green";
  if (s === "inactive") return "amber";
  if (s === "blocked") return "red";
  return "gray";
}

/** Indicators that evidence forced labour outright rather than poor practice. */
export const CRITICAL_INDICATORS = [
  "passport_retained",
  "debt_bondage",
  "underage",
  "movement_restricted",
];

/* ------------------------------- Components -------------------------------- */

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

export function Stat({
  label: statLabel,
  value,
  hint,
  tone,
  emphasized,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "red" | "amber" | "green" | "brand";
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
      <CardBody className="px-4 py-3">
        <div
          className={`${emphasized ? "text-2xl" : "text-xl"} font-bold tabular-nums ${valueCls}`}
        >
          {value}
        </div>
        <div className="mt-0.5 text-xs font-medium uppercase tracking-wide text-ink-400">
          {statLabel}
        </div>
        {hint ? <div className="mt-0.5 text-xs text-ink-400">{hint}</div> : null}
      </CardBody>
    </Card>
  );
}

/**
 * A failed load is not an empty register. Showing "no workers" when the
 * request actually failed would tell the reader the safest possible lie, so
 * the failure is named and offered a retry instead.
 */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-red-200 bg-red-50/40 px-6 py-12 text-center">
      <p className="text-sm font-medium text-red-800">This view could not be loaded</p>
      <p className="mt-1 max-w-md text-xs text-red-700">{message}</p>
      <p className="mt-1 max-w-md text-xs text-ink-500">
        Nothing below is missing — it is simply unknown. Retry before reading anything into it.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-ink-800 ring-1 ring-ink-200 hover:bg-ink-50"
      >
        Retry
      </button>
    </div>
  );
}

/** Small yes/no verification chip — the register's honesty at a glance. */
export function VerifiedChip({ ok, label: chipLabel }: { ok: boolean; label: string }) {
  return (
    <span
      className={
        ok
          ? "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-emerald-700"
          : "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-ink-400"
      }
      title={ok ? `${chipLabel}: verified` : `${chipLabel}: not verified`}
    >
      <span aria-hidden>{ok ? "✓" : "○"}</span>
      {chipLabel}
    </span>
  );
}

export function IndicatorBadge({ indicator }: { indicator: string }) {
  return (
    <Badge tone={CRITICAL_INDICATORS.includes(indicator) ? "red" : "amber"}>
      {label(indicator)}
    </Badge>
  );
}

/* ---------------------------------- Hooks ---------------------------------- */

/** Company vendor list — the employer picker across every workforce form. */
export function useVendors(): { vendors: VendorRow[]; error: string | null } {
  const [vendors, setVendors] = useState<VendorRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await api.get<ListResponse<VendorRow>>("/api/v1/vendors?pageSize=200");
      setVendors(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load vendors");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { vendors, error };
}
