/**
 * Shared types + helpers for the commercial workspace (spec Vol II Domain B,
 * module M7): BoQ, taking-off, valuations, certificates, variations.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { Card, CardBody } from "../../ui";

/* --------------------------------- Types ---------------------------------- */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface BoqRow {
  id: string;
  name: string;
  method: string;
  status: string;
  currency: string;
  version: number;
  itemCount?: number;
  totalAmount?: number;
}

export interface RateBuildUpComponent {
  kind: string;
  description: string;
  qty: number;
  unit?: string | null;
  rate: number;
  amount?: number;
}

/** One BQ item, flattened out of the tree (or flat) response with its depth. */
export interface FlatBoqItem {
  id: string;
  parentId: string | null;
  depth: number;
  level: string;
  code: string;
  description: string;
  unit: string | null;
  quantity: number | null;
  rate: number | null;
  amount: number | null;
  itemType: string;
  rateBuildUp: RateBuildUpComponent[] | null;
  path?: string;
}

export interface BoqDetail extends BoqRow {
  items: FlatBoqItem[];
  totalAmount?: number;
}

export interface TakeoffLine {
  id: string;
  description: string;
  timesing: number;
  length: number | null;
  width: number | null;
  depth: number | null;
  quantity: number;
  isManual: number;
  drawingSheetId: string | null;
}

export interface ValuationRow {
  id: string;
  boqId: string;
  number: number;
  valuationDate: string;
  basis: string;
  status: string;
  currency: string;
  retentionPercent: number;
  retentionCap: number | null;
  sectionsTotal: number;
  grossTotal: number;
  dueDate: string | null;
  dueDateBasis: string | null;
  workDoneToDate: number;
  materialsOnSite: number;
  materialsOffSite: number;
  retentionHeld: number;
  previousNet: number;
  netDue: number;
  submittedBy?: string | null;
  submittedAt?: string | null;
}

export interface ValuationLine {
  id: string;
  boqItemId: string;
  qtyToDate: number | null;
  percentToDate: number | null;
  amountToDate: number;
  previousAmount: number;
  thisPeriod: number;
  code?: string;
  description?: string;
  unit?: string | null;
  boqQuantity?: number | null;
  rate?: number | null;
  boqAmount?: number | null;
}

export interface ValuationDetail extends ValuationRow {
  lines?: ValuationLine[];
  sections?: ValuationSection[];
  certificates?: CertificateRow[];
}

export interface CertificateRow {
  id: string;
  valuationId: string;
  number: number;
  currency: string;
  certifiedWorkDone: number;
  certifiedMaterials: number;
  certifiedSections: number;
  retentionHeld: number;
  previousCertified: number;
  netCertified: number;
  varianceFromApplication: number;
  varianceReason: string | null;
  dueDate: string | null;
  dueDateBasis: string | null;
  status: string;
  withdrawnReason: string | null;
  paidAmount: number | null;
  paidAt: string | null;
  paymentReference: string | null;
  issuedBy: string;
  issuedAt: string;
  overdue?: boolean;
}

export interface VariationRow {
  id: string;
  number: number;
  title: string;
  description?: string | null;
  status: string;
  basis: string;
  clauseRef?: string | null;
  instructionRef?: string | null;
  instructedAt?: string | null;
  costEstimate: number | null;
  agreedValue: number | null;
  timeImpactDays: number | null;
  boqItemRefs?: string[];
}

export interface CurrencyPosition {
  currency: string;
  boqTotal: number;
  certifiedToDate: number;
  paidToDate: number;
  retentionHeld: number;
  variationsAgreed: number;
  variationsPending: number;
  forecastFinal: number;
  boqCount: number;
}

/**
 * The project commercial position. `byCurrency` is always the truth; the flat
 * fields are populated only when the project holds ONE currency and are null
 * otherwise, with `reasons` saying why. Never render a flat null as 0.
 */
export interface CommercialSummary {
  currency: string | null;
  byCurrency: CurrencyPosition[];
  reasons: string[];
  boqTotal: number | null;
  certifiedToDate: number | null;
  paidToDate: number | null;
  retentionHeld: number | null;
  variationsAgreed: number | null;
  variationsPending: number | null;
  forecastFinal: number | null;
}

/* ------------------------- Upgrade-wave record types ----------------------- */

export interface ValuationSection {
  id: string;
  kind: string;
  description: string;
  sourceType: string | null;
  sourceId: string | null;
  amountToDate: number;
  previousAmount: number;
  thisPeriod: number;
  retentionApplies: boolean;
  evidenceRef: string | null;
  notes: string | null;
}

export interface DayworkItemRow {
  id: string;
  kind: string;
  description: string;
  unit: string | null;
  qty: number;
  rate: number;
  amount: number;
  percentAddition: number;
  amountWithAddition: number;
}

export interface DayworkSheetRow {
  id: string;
  number: number;
  reference: string | null;
  workDate: string;
  description: string;
  location: string | null;
  basis: string;
  status: string;
  currency: string;
  percentAdditions: Record<string, number>;
  netTotal: number;
  additionTotal: number;
  grossTotal: number;
  submittedBy: string | null;
  verifiedBy: string | null;
  rejectionReason: string | null;
  items?: DayworkItemRow[];
}

export interface RemeasurementRow {
  id: string;
  boqId: string;
  boqItemId: string;
  originalQuantity: number | null;
  remeasuredQuantity: number;
  method: string;
  status: string;
  measuredAt: string;
  measuredBy: string;
  witnessedBy: string | null;
  agreedBy: string | null;
  note: string | null;
  code?: string;
  description?: string;
  unit?: string | null;
  rate?: number | null;
  quantityMovement?: number | null;
  valueMovement?: number | null;
}

export interface ProvisionalSumRow {
  id: string;
  boqItemId: string;
  kind: string;
  title: string;
  allowance: number;
  currency: string;
  status: string;
  instructionRef: string | null;
  expendedTotal: number;
  code?: string;
  description?: string;
  variance?: number;
  variancePercent?: number | null;
}

export interface MomFinding {
  itemId: string | null;
  code: string | null;
  ruleId: string;
  severity: "error" | "warning" | "info";
  scope: string;
  message: string;
  reference: string;
}

export interface MomReport {
  method: string;
  standardName: string;
  supported: boolean;
  itemsChecked: number;
  findings: MomFinding[];
  counts: { error: number; warning: number; info: number };
  complianceScore: number | null;
  notes: string[];
}

export interface RateAnalysis {
  itemId: string;
  code: string;
  description: string;
  unit: string | null;
  rate: number | null;
  currency: string;
  buildUp: {
    total: number;
    reconciles: boolean;
    difference: number;
    split: Record<string, number>;
    splitPercent: Record<string, number>;
    observations: string[];
  };
  benchmark: {
    verdict: string;
    rate: number | null;
    sampleSize: number;
    median: number | null;
    p25: number | null;
    p75: number | null;
    deviationPercent: number | null;
    basis: string;
    samples: Array<{ rate: number; source: string; label: string; currency: string }>;
  };
}

export interface CvrRow {
  scope: string;
  label: string;
  packageRef: string | null;
  valueToDate: number | null;
  certifiedToDate: number | null;
  costToDate: number | null;
  accruals: number;
  margin: number | null;
  marginPercent: number | null;
}

export interface CvrResult {
  currency: string;
  currencies: string[];
  periodEnd: string;
  valueToDate: number | null;
  certifiedToDate: number;
  costToDate: number | null;
  accruals: number;
  wip: number | null;
  margin: number | null;
  marginPercent: number | null;
  overUnderCertification: number | null;
  rows: CvrRow[];
  gaps: string[];
  cvrPeriodId: string | null;
}

export interface SCurveResult {
  currency: string;
  currencies: string[];
  points: Array<{
    period: string;
    planned: number;
    plannedCumulative: number;
    actualCumulative: number | null;
  }>;
  totalAllocated: number;
  unallocated: number;
  totalBoq?: number;
  linkedTasks?: number;
  reasons: string[];
}

export interface FinalAccountLine {
  id: string;
  sequence: number;
  category: string;
  description: string;
  amount: number;
  sourceType: string | null;
  sourceId: string | null;
  manual: boolean;
  note: string | null;
}

export interface FinalAccountRow {
  id: string;
  number: number;
  contractId: string;
  status: string;
  currency: string;
  contractSum: number;
  finalContractSum: number;
  certifiedToDate: number;
  balanceDue: number;
  gaps: string[];
  computedAt: string | null;
  issuedAt: string | null;
  contractorSignedBy: string | null;
  employerSignedBy: string | null;
  lines?: FinalAccountLine[];
}

export interface RetentionPosition {
  boqId: string;
  boqName: string;
  currency: string;
  retentionPercent: number;
  retentionCap: number | null;
  retentionHeld: number;
  released: number;
  dueNow: number;
  firstTranche: number;
  firstTrancheDate: string | null;
  secondTranche: number;
  secondTrancheDate: string | null;
  reasons: string[];
}

export interface FluctuationCalcRow {
  id: string;
  formula: string;
  baseDate: string;
  currentPeriod: string;
  nonAdjustable: number;
  workDoneAmount: number;
  factor: number;
  adjustment: number;
  currency: string;
  createdAt: string;
}

export interface IndexSeriesRow {
  id: string;
  code: string;
  name: string;
  source: string | null;
  country: string | null;
  values: Array<{ period: string; value: number }>;
}

/* ------------------------------- Formatting -------------------------------- */

const moneyFmts = new Map<string, Intl.NumberFormat>();

function moneyFormatter(currency: string, decimals: number): Intl.NumberFormat {
  const key = `${currency}:${decimals}`;
  let f = moneyFmts.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency || "USD",
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
    } catch {
      f = new Intl.NumberFormat(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
    }
    moneyFmts.set(key, f);
  }
  return f;
}

/** Money in the BoQ currency, 2 decimal places. */
export function money(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return moneyFormatter(currency, 2).format(value);
}

/** Money rounded to whole units — for stat cards. */
export function money0(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return moneyFormatter(currency, 0).format(value);
}

/** Signed money, for movements and variances. */
export function moneySigned(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${moneyFormatter(currency, 2).format(value)}`;
}

export function percent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function dayworkStatusTone(status: string): string {
  switch (status) {
    case "submitted":
      return "blue";
    case "verified":
      return "green";
    case "valued":
      return "violet";
    case "rejected":
      return "red";
    default:
      return "gray";
  }
}

export function remeasurementTone(status: string): string {
  switch (status) {
    case "proposed":
      return "blue";
    case "agreed":
      return "green";
    case "applied":
      return "violet";
    case "disputed":
      return "red";
    default:
      return "gray";
  }
}

export function severityTone(severity: string): string {
  if (severity === "error") return "red";
  if (severity === "warning") return "amber";
  return "gray";
}

export function verdictTone(verdict: string): string {
  if (verdict === "high") return "red";
  if (verdict === "low") return "amber";
  if (verdict === "in_range") return "green";
  return "gray";
}

export function sectionKindLabel(kind: string): string {
  const map: Record<string, string> = {
    variation: "Variation",
    daywork: "Daywork",
    claim: "Claim / loss & expense",
    fluctuation: "Fluctuation",
    materials_on_site: "Materials on site",
    materials_off_site: "Materials off site",
    contra_charge: "Contra charge",
    provisional_sum: "Provisional sum",
    other: "Other",
  };
  return map[kind] ?? kind;
}

/** Measured quantity, up to 3 decimal places. */
export function qty(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function padNo(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(3, "0")}`;
}

export function methodLabel(method: string): string {
  return method === "custom" ? "Custom" : method.toUpperCase();
}

/* ---------------------------------- Tones ---------------------------------- */

export function boqTone(status: string): string {
  if (status === "issued") return "blue";
  if (status === "agreed") return "green";
  return "gray";
}

export function valuationStatusTone(status: string): string {
  if (status === "submitted") return "blue";
  if (status === "certified") return "green";
  if (status === "paid") return "violet";
  return "gray";
}

export function certTone(status: string): string {
  if (status === "issued") return "blue";
  if (status === "paid") return "green";
  return "gray";
}

export function variationTone(status: string): string {
  switch (status) {
    case "proposed":
      return "blue";
    case "instructed":
      return "amber";
    case "valued":
      return "violet";
    case "agreed":
      return "green";
    case "rejected":
      return "red";
    default:
      return "gray";
  }
}

export function itemTypeTone(itemType: string): string {
  if (itemType.startsWith("provisional")) return "amber";
  if (itemType === "prime_cost") return "violet";
  if (itemType === "daywork") return "blue";
  if (itemType === "contingency") return "red";
  return "gray";
}

/* --------------------------------- Numbers --------------------------------- */

/** Parse a numeric input; returns null for blank, undefined for garbage. */
export function parseNum(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/* ------------------------------ Item flattening ---------------------------- */

const LEVEL_DEPTH: Record<string, number> = { bill: 0, section: 1, item: 2 };

/**
 * The BoQ detail may return `items` as a nested tree ({children}) or as a
 * flat list carrying a materialized `path` — flatten either into depth-first
 * order with an explicit depth for indentation.
 */
export function flattenBoqItems(raw: unknown): FlatBoqItem[] {
  const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  const out: FlatBoqItem[] = [];

  const toFlat = (node: Record<string, unknown>, depth: number): FlatBoqItem => ({
    id: String(node["id"] ?? ""),
    parentId: (node["parentId"] as string | null | undefined) ?? null,
    depth,
    level: String(node["level"] ?? "item"),
    code: String(node["code"] ?? ""),
    description: String(node["description"] ?? ""),
    unit: (node["unit"] as string | null | undefined) ?? null,
    quantity: (node["quantity"] as number | null | undefined) ?? null,
    rate: (node["rate"] as number | null | undefined) ?? null,
    amount: (node["amount"] as number | null | undefined) ?? null,
    itemType: String(node["itemType"] ?? "measured"),
    rateBuildUp: Array.isArray(node["rateBuildUp"])
      ? (node["rateBuildUp"] as RateBuildUpComponent[])
      : null,
    path: typeof node["path"] === "string" ? (node["path"] as string) : undefined,
  });

  const hasTree = list.some((n) => Array.isArray(n["children"]));
  if (hasTree) {
    const walk = (nodes: Record<string, unknown>[], depth: number) => {
      for (const n of nodes) {
        out.push(toFlat(n, depth));
        const children = n["children"];
        if (Array.isArray(children)) walk(children as Record<string, unknown>[], depth + 1);
      }
    };
    walk(list, 0);
    return out;
  }

  // flat list — order by materialized path when present, depth from it
  const sorted = [...list].sort((a, b) =>
    String(a["path"] ?? "").localeCompare(String(b["path"] ?? "")),
  );
  for (const n of sorted) {
    const path = typeof n["path"] === "string" ? (n["path"] as string) : "";
    const depth = path
      ? Math.max(0, path.split("/").length - 1)
      : (LEVEL_DEPTH[String(n["level"] ?? "item")] ?? 0);
    out.push(toFlat(n, depth));
  }
  return out;
}

/* --------------------------------- Directory ------------------------------- */

/** Loads the company directory once and exposes an id → display-name lookup. */
export function useCompanyUsers() {
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    api
      .get<ListResponse<{ id?: string; userId?: string; name: string }>>(
        "/api/v1/company/users?pageSize=200",
      )
      .then((res) =>
        setUsers(res.items.map((u) => ({ id: u.id ?? u.userId ?? "", name: u.name }))),
      )
      .catch(() => setUsers([]));
  }, []);
  const byId = useMemo(() => new Map(users.map((u) => [u.id, u.name])), [users]);
  const nameOf = useCallback(
    (id: string | null | undefined) => (id ? (byId.get(id) ?? "Unknown user") : "—"),
    [byId],
  );
  return { users, nameOf };
}

/* ---------------------------------- Layout --------------------------------- */

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
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "emphasis";
}) {
  return (
    <Card>
      <CardBody className="py-3">
        <div className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</div>
        <div
          className={
            tone === "emphasis"
              ? "mt-0.5 text-xl font-semibold text-brand-700 tabular-nums"
              : "mt-0.5 text-xl font-semibold text-ink-900 tabular-nums"
          }
        >
          {value}
        </div>
        {hint ? <div className="mt-0.5 text-xs text-ink-400">{hint}</div> : null}
      </CardBody>
    </Card>
  );
}

/** Right-hand slide-over panel for record detail (BQ item, variation). */
export function Drawer({
  open,
  title,
  onClose,
  children,
  wide,
}: {
  open: boolean;
  title: string;
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
        <div className="mb-4 flex items-center justify-between gap-3">
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
