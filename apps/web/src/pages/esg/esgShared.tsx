/**
 * Shared types, labels and presentational primitives for the ESG & carbon
 * workspace (spec Vol II Domain I / module M18).
 *
 * The view-models mirror the API exactly: carbon budgets carry their own
 * drawdown aggregates, entries carry the resolved factor, and the summary
 * carries the EN 15978 module split (#491-492), the GHG-Protocol scope split
 * (#505-508) and the product-specific share (#498) that says how much of the
 * reported footprint stands on a real EPD rather than a library average.
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

/** Carbon factor library row (#496-498). */
export interface FactorRow {
  id: string;
  companyId: string;
  name: string;
  materialCategory: string | null;
  unit: string;
  factorKgCo2ePerUnit: number;
  /** epd | ice_database | generic | supplier | custom */
  source: string;
  /** 0/1 — product-specific declarations beat generic library figures (#497-498) */
  isProductSpecific: number;
  epdReference: string | null;
  validUntil: string | null;
  createdAt: string;
}

export type BudgetStatus = "on_track" | "at_risk" | "exceeded";

/** Carbon budget with drawdown (#494-495). */
export interface BudgetRow {
  id: string;
  companyId: string;
  projectId: string;
  name: string;
  element: string | null;
  baselineTco2e: number;
  targetTco2e: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** aggregates computed by the API from the entries booked against it */
  actualTco2e: number;
  drawdownPercent: number;
  remaining: number;
  status: BudgetStatus;
  reductionFromBaselinePercent: number;
}

/** A quantity × factor calculation attributed to a life-cycle module (#491-492). */
export interface EntryRow {
  id: string;
  companyId: string;
  projectId: string;
  budgetId: string | null;
  description: string;
  lifecycleModule: string;
  scope: string | null;
  factorId: string | null;
  quantity: number;
  unit: string;
  tco2e: number;
  boqItemId: string | null;
  sourceNote: string | null;
  entryDate: string;
  createdBy: string;
  createdAt: string;
  /** resolved factor view — `manual` source when no library row backs it */
  factorName: string | null;
  factorKgCo2ePerUnit: number;
  factorSource: string;
  isProductSpecific: boolean;
}

export interface SummaryBudgetItem {
  id: string;
  name: string;
  element: string | null;
  baselineTco2e: number;
  targetTco2e: number;
  actualTco2e: number;
  drawdownPercent: number;
  remaining: number;
  status: BudgetStatus;
}

export interface CarbonSummary {
  totalTco2e: number;
  entryCount: number;
  byModule: Record<string, number>;
  byScope: Record<string, number>;
  productSpecificSharePercent: number;
  productSpecificTco2e: number;
  budgets: {
    count: number;
    baselineTco2e: number;
    targetTco2e: number;
    actualTco2e: number;
    remaining: number;
    drawdownPercent: number;
    byStatus: { on_track: number; at_risk: number; exceeded: number };
    items: SummaryBudgetItem[];
  };
  /** gross internal area in m², from project settings — null until set */
  gia: number | null;
  /** kgCO2e per m² GIA, the RICS reporting unit */
  intensityPerSqm: number | null;
  unbudgetedTco2e: number;
}

export interface BoqImportSkip {
  boqItemId: string;
  code: string;
  reason: string;
  detail: string;
}

export interface BoqImportResult {
  boqId: string;
  created: number;
  createdIds: string[];
  skipped: BoqImportSkip[];
  totalTco2e: number;
}

export interface SeedResult {
  created: number;
  skipped: number;
  total: number;
  warning: string;
}

/** Waste movement with destination (#513-514). */
export interface WasteRow {
  id: string;
  companyId: string;
  projectId: string;
  recordDate: string;
  stream: string;
  destination: string;
  tonnes: number;
  carrier: string | null;
  consignmentNote: string | null;
  cost: number | null;
  recordedBy: string;
  createdAt: string;
}

export interface WasteSummary {
  recordCount: number;
  totalTonnes: number;
  byStream: Record<string, number>;
  byDestination: Record<string, number>;
  diversionFromLandfillPercent: number;
  recycledPercent: number;
  hazardousTonnes: number;
  costTotal: number;
}

/** Social value commitment made at tender (#527-540). */
export interface CommitmentRow {
  id: string;
  companyId: string;
  projectId: string;
  number: number;
  theme: string;
  measureRef: string | null;
  description: string;
  unit: string;
  targetValue: number;
  deliveredValue: number;
  proxyValuePerUnit: number | null;
  dueDate: string | null;
  status: string;
  vendorId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  progressPercent: number;
  remainingValue: number;
  proxyValueCommitted: number | null;
  proxyValueDelivered: number | null;
}

export interface DeliveryRow {
  id: string;
  commitmentId: string;
  companyId: string;
  deliveryDate: string;
  value: number;
  note: string | null;
  evidenceIds: string[];
  recordedBy: string;
  createdAt: string;
}

export interface CommitmentDetail extends CommitmentRow {
  deliveries: DeliveryRow[];
}

export interface ThemeStats {
  commitments: number;
  committed: number;
  delivered: number;
  progressPercent: number;
  proxyValueCommitted: number;
  proxyValueDelivered: number;
}

export interface ShortfallRow {
  id: string;
  number: number;
  theme: string;
  measureRef: string | null;
  description: string;
  unit: string;
  targetValue: number;
  deliveredValue: number;
  shortfallValue: number;
  progressPercent: number;
  dueDate: string | null;
  status: string;
  proxyValueShortfall: number | null;
}

export interface SocialValueSummary {
  byTheme: Record<string, ThemeStats>;
  overall: {
    commitments: number;
    delivered: number;
    onTrack: number;
    atRisk: number;
    shortfall: number;
    proxyValueCommitted: number;
    proxyValueDelivered: number;
    proxyValueShortfall: number;
  };
  shortfalls: ShortfallRow[];
}

/** Pickers. */
export interface BoqPickRow {
  id: string;
  name: string;
  status: string;
  version: number;
  itemCount?: number;
}

export interface EvidencePickRow {
  id: string;
  kind: string;
  source: string;
  contentHash: string;
  capturedAt: string | null;
  ingestedAt: string;
}

/* =============================== Labels ================================== */

/** EN 15978 life-cycle modules, in assessment order (#492). */
export const MODULE_LABELS: Record<string, string> = {
  "A1-A3": "Product stage",
  A4: "Transport to site",
  A5: "Construction process",
  "B1-B7": "Use stage",
  "C1-C4": "End of life",
  D: "Beyond the boundary",
};

export const MODULE_DESCRIPTIONS: Record<string, string> = {
  "A1-A3": "A1-A3 Product stage — raw material supply, transport to factory and manufacturing (cradle to gate).",
  A4: "A4 Transport — delivery of products from the factory gate to the site.",
  A5: "A5 Construction & installation — site energy, plant, temporary works and construction waste.",
  "B1-B7": "B1-B7 Use stage — in-use emissions, maintenance, repair, replacement, refurbishment, operational energy and water.",
  "C1-C4": "C1-C4 End of life — deconstruction, transport, waste processing and final disposal.",
  D: "Module D — benefits and loads beyond the system boundary (reuse, recovery, recycling potential). Reported separately and never netted off the A-C total.",
};

export const SCOPE_LABELS: Record<string, string> = {
  scope_1: "Scope 1 — direct",
  scope_2: "Scope 2 — energy",
  scope_3: "Scope 3 — value chain",
  unscoped: "Unscoped",
};

export const SCOPE_DESCRIPTIONS: Record<string, string> = {
  scope_1: "Scope 1 — direct emissions from sources the business owns or controls: site plant, generators, company vehicles.",
  scope_2: "Scope 2 — indirect emissions from purchased electricity, heat and steam consumed on the project.",
  scope_3: "Scope 3 — all other value-chain emissions, including purchased goods and services. On construction this is where the embodied carbon of materials lands, and it dominates.",
  unscoped: "Entries with no GHG-Protocol scope assigned. They still count towards the total but cannot be reported under the Protocol until they are classified.",
};

/** UK Social Value Model themes, PPN 06/20 (#528). */
export const THEME_LABELS: Record<string, string> = {
  covid_recovery: "COVID-19 recovery",
  economic_inequality: "Tackling economic inequality",
  fighting_climate_change: "Fighting climate change",
  equal_opportunity: "Equal opportunity",
  wellbeing: "Wellbeing",
};

export const THEME_NUMBERS: Record<string, string> = {
  covid_recovery: "Theme 1",
  economic_inequality: "Theme 2",
  fighting_climate_change: "Theme 3",
  equal_opportunity: "Theme 4",
  wellbeing: "Theme 5",
};

export const FACTOR_SOURCE_LABELS: Record<string, string> = {
  epd: "EPD",
  ice_database: "ICE database",
  generic: "Generic",
  supplier: "Supplier",
  custom: "Custom",
  manual: "Manual",
};

/* =============================== Formats ================================= */

export function fmtNum(value: number | null | undefined, dp = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: dp,
  }).format(value);
}

/** tCO2e, the register's reporting unit. */
export function fmtT(value: number | null | undefined, dp = 2): string {
  return fmtNum(value, dp);
}

export function fmtPct(value: number | null | undefined, dp = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: dp }).format(value)}%`;
}

/**
 * Social value proxy money. The UK Social Value Model and the TOMs proxy
 * values are published in sterling, so that is the unit of the proxy column.
 */
export function fmtProxy(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "GBP",
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return fmtNum(value, 0);
  }
}

export function svNumber(n: number): string {
  return `SV-${String(n).padStart(4, "0")}`;
}

/* ================================ Tones ================================== */

export function budgetTone(status: BudgetStatus): "green" | "amber" | "red" {
  return status === "exceeded" ? "red" : status === "at_risk" ? "amber" : "green";
}

export function commitmentTone(status: string): string {
  switch (status) {
    case "delivered":
      return "green";
    case "on_track":
      return "blue";
    case "at_risk":
      return "amber";
    case "shortfall":
      return "red";
    default:
      return "gray"; // committed
  }
}

export function factorSourceTone(source: string): string {
  switch (source) {
    case "epd":
      return "green";
    case "supplier":
      return "blue";
    case "ice_database":
      return "violet";
    case "custom":
      return "amber";
    default:
      return "gray"; // generic | manual
  }
}

export function destinationTone(destination: string): string {
  switch (destination) {
    case "reused":
    case "recycled":
      return "green";
    case "recovered":
      return "blue";
    case "incinerated":
      return "amber";
    case "landfill":
      return "red";
    default:
      return "gray";
  }
}

export function streamTone(stream: string): string {
  return stream === "hazardous" ? "red" : "gray";
}

/* ============================ Chart palette ============================== */

/**
 * One palette for every chart on the page so the workspace reads as a single
 * system. Brand carries quantity; red is reserved for the genuinely bad
 * outcome (landfill, an exceeded budget, an unremediated shortfall).
 */
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

/** Life-cycle stage colours: A stages solid brand, B/C lighter, D set apart. */
export const MODULE_FILL: Record<string, string> = {
  "A1-A3": CHART.brand600,
  A4: CHART.brand600,
  A5: CHART.brand600,
  "B1-B7": CHART.brand400,
  "C1-C4": CHART.brand200,
  D: CHART.ink300,
};

export const SCOPE_FILL: Record<string, string> = {
  scope_1: CHART.brand900,
  scope_2: CHART.brand600,
  scope_3: CHART.brand400,
  unscoped: CHART.ink200,
};

export const DESTINATION_FILL: Record<string, string> = {
  reused: CHART.brand900,
  recycled: CHART.brand600,
  recovered: CHART.brand400,
  incinerated: CHART.amber,
  landfill: CHART.red,
};

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

/** Progress / drawdown meter. Tone is the caller's judgement, not the value's. */
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
      title={title ?? `${fmtPct(percent)}`}
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

/** Small chart legend row. */
export function Legend({
  items,
}: {
  items: { color: string; label: string; title?: string }[];
}) {
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

/** An EPD / product-specific marker. Reused everywhere a factor is shown. */
export function EpdBadge({
  isProductSpecific,
  reference,
}: {
  isProductSpecific: boolean;
  reference?: string | null;
}) {
  if (!isProductSpecific) return null;
  return (
    <span
      className="inline-flex items-center rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800"
      title={
        reference
          ? `Product-specific EPD — ${reference}. A declared value for this actual product, not a library average.`
          : "Product-specific EPD — a declared value for this actual product, not a library average."
      }
    >
      EPD
    </span>
  );
}

/** A quiet caveat strip for figures that must not be mistaken for verified data. */
export function Caveat({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
      {children}
    </div>
  );
}
