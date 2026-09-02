/**
 * Shared types, vocabulary and small presentational helpers for the
 * Estimating & Takeoff workspace (spec Vol I §1.2, #184–208).
 *
 * The view-models mirror the API exactly. Every computed figure the API
 * returns comes with its basis — the arithmetic, the rate's provenance, the
 * warnings — and this workspace prints those verbatim next to the number,
 * because an estimate without its build-up is a rumour.
 *
 * Honesty rules applied here:
 *  · a value the API did not return renders "—" with the reason, never 0;
 *  · money always carries its currency and is never summed across currencies
 *    (the API buckets; the page shows the buckets);
 *  · every panel loads, fails and empties on its own.
 */
import { useCallback, useState, type ReactNode } from "react";
import { api, ApiClientError } from "../../lib/api";
import { Alert, Badge, cx } from "../../ui";
import type { Tone } from "../../ui/tokens";
import { useResource, type Loadable, type Paginated } from "../../layouts/project/lib";

export { useResource };
export type { Loadable, Paginated };

/* ================================= Types ================================== */

export interface RateSplit {
  labourRate: number;
  materialRate: number;
  equipmentRate: number;
  subcontractRate: number;
  otherRate: number;
}

export interface CatalogueItem extends RateSplit {
  id: string;
  projectId: string | null;
  code: string;
  description: string;
  longDescription: string | null;
  unit: string;
  costType: string;
  category: string | null;
  trade: string | null;
  currency: string;
  unitRate: number;
  crewId: string | null;
  productionRate: number | null;
  productionRateBasis: string | null;
  wastePercent: number;
  costCode: string | null;
  source: string;
  sourceReference: string | null;
  region: string | null;
  rateAsAt: string | null;
  status: string;
  tags: string[];
  updatedAt: string;
}

export interface CatalogueDetail extends CatalogueItem {
  crew: Crew | null;
  staleness: { ageDays: number | null; stale: boolean; reason: string };
}

export interface AssemblyComponent extends RateSplit {
  id: string;
  assemblyId: string;
  position: number;
  catalogueItemId: string | null;
  description: string;
  unit: string | null;
  costType: string;
  quantityPer: number;
  wastePercent: number;
  unitRate: number;
  amountPer: number;
  costCode: string | null;
}

export interface Assembly extends RateSplit {
  id: string;
  code: string;
  name: string;
  description: string | null;
  unit: string;
  category: string | null;
  trade: string | null;
  currency: string;
  costCode: string | null;
  unitRate: number;
  componentCount: number;
  status: string;
}

export interface AssemblyDetail extends Assembly {
  components: AssemblyComponent[];
  refresh?: {
    unitRateBefore: number;
    unitRateAfter: number;
    componentsRefreshed: number;
    notRefreshed: string[];
    reason: string;
  };
}

export interface CrewMember {
  trade: string;
  count: number;
  hourlyRate: number;
}

export interface CrewEquipment {
  description: string;
  count: number;
  hourlyRate: number;
}

export interface Crew {
  id: string;
  code: string;
  name: string;
  description: string | null;
  trade: string | null;
  currency: string;
  members: CrewMember[];
  equipment: CrewEquipment[];
  hourlyCost: number;
  labourHourlyCost: number;
  equipmentHourlyCost: number;
  headcount: number;
  status: string;
}

export interface ProductionRate {
  id: string;
  code: string;
  description: string;
  unit: string;
  trade: string | null;
  crewId: string | null;
  basis: string;
  value: number;
  conditions: string | null;
  source: string;
  region: string | null;
  rateAsAt: string | null;
  status: string;
}

export interface Estimate {
  id: string;
  projectId: string;
  number: number;
  reference: string;
  name: string;
  description: string | null;
  status: string;
  estimateType: string;
  currency: string;
  rootId: string;
  version: number;
  parentEstimateId: string | null;
  sourceType: string | null;
  sourceId: string | null;
  basis: string | null;
  accuracyRange: number | null;
  quantityBasis: number | null;
  quantityBasisUnit: string | null;
  directCostTotal: number;
  labourTotal: number;
  materialTotal: number;
  equipmentTotal: number;
  subcontractTotal: number;
  otherTotal: number;
  markupTotal: number;
  total: number;
  labourHours: number;
  lineCount: number;
  excludedTotal: number;
  alternateTotal: number;
  totalsCalculatedAt: string | null;
  lockedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  convertedBudgetId: string | null;
  supersededById: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface EstimateSection {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  sortOrder: number;
  directCostTotal: number;
}

export interface EstimateMarkup {
  id: string;
  sequence: number;
  kind: string;
  name: string;
  method: string;
  basis: string;
  rate: number;
  costTypes: string[];
  sectionIds: string[];
  quantity: number | null;
  baseAmount: number;
  amount: number;
  rationale: string | null;
  enabled: number;
}

export interface EstimateVersionRef {
  id: string;
  version: number;
  status: string;
  total: number;
  createdAt: string;
}

export interface EstimateDetail extends Estimate {
  sections: EstimateSection[];
  markups: EstimateMarkup[];
  versions: EstimateVersionRef[];
  warnings: string[];
}

export interface EstimateLine {
  id: string;
  sectionId: string | null;
  lineageId: string;
  position: number;
  itemCode: string | null;
  description: string;
  costCode: string | null;
  costType: string;
  status: string;
  source: string;
  unit: string | null;
  takeoffQuantity: number | null;
  wastePercent: number;
  quantity: number;
  unitRate: number;
  labourRate: number;
  materialRate: number;
  equipmentRate: number;
  subcontractRate: number;
  otherRate: number;
  amount: number;
  labourHours: number;
  takeoffItemId: string | null;
  catalogueItemId: string | null;
  assemblyId: string | null;
  assemblyParentLineId: string | null;
  subQuoteId: string | null;
  rateAsAt: string | null;
  notes: string | null;
}

export interface LineWriteResult extends EstimateLine {
  basis: string[];
  estimateTotals: { directCostTotal: number; markupTotal: number; total: number; lineCount: number };
}

export interface ComparisonRow {
  key: string;
  matchedOn: string;
  description: string;
  costCode: string | null;
  costType: string;
  unit: string | null;
  change: string;
  before: { quantity: number; unitRate: number; amount: number } | null;
  after: { quantity: number; unitRate: number; amount: number } | null;
  quantityDelta: number;
  rateDelta: number;
  amountDelta: number;
  quantityEffect: number;
  rateEffect: number;
}

export interface Comparison {
  before: { id: string; reference: string; version: number; currency: string };
  after: { id: string; reference: string; version: number; currency: string };
  rows: ComparisonRow[];
  totals: {
    beforeDirectCost: number;
    afterDirectCost: number;
    directCostDelta: number;
    beforeTotal: number;
    afterTotal: number;
    totalDelta: number;
    addedTotal: number;
    removedTotal: number;
    quantityEffectTotal: number;
    rateEffectTotal: number;
  };
  byCostType: Array<{ costType: string; before: number; after: number; delta: number }>;
  counts: Record<string, number>;
  warnings: string[];
}

export interface TakeoffLayer {
  id: string;
  name: string;
  colour: string;
  description: string | null;
  costCode: string | null;
  measurementType: string | null;
  unit: string | null;
  visible: number;
  sortOrder: number;
}

export interface TakeoffItem {
  id: string;
  estimateId: string | null;
  layerId: string | null;
  name: string;
  description: string | null;
  measurementType: string;
  status: string;
  sheetNumber: string | null;
  pageNumber: number;
  pixelsPerUnit: number | null;
  scaleUnit: string | null;
  scaleLabel: string | null;
  geometry: { kind: string; points: Array<{ x: number; y: number }>; radius?: number } | null;
  rawValue: number;
  depth: number | null;
  height: number | null;
  deduction: number;
  multiplier: number;
  quantity: number;
  unit: string;
  perimeter: number | null;
  costCode: string | null;
  colour: string | null;
  notes: string | null;
  createdAt: string;
  detail?: { basis?: string[]; warnings?: string[] };
}

export interface Measurement {
  rawValue: number;
  quantity: number;
  perimeter: number | null;
  unit: string;
  basis: string[];
  warnings: string[];
}

export interface SubQuoteLine {
  id: string;
  position: number;
  itemCode: string | null;
  description: string;
  scopeKey: string | null;
  unit: string | null;
  quantity: number | null;
  unitRate: number | null;
  amount: number;
  costCode: string | null;
  costType: string;
  excluded: number;
  note: string | null;
  estimateLineItemId: string | null;
}

export interface SubQuote {
  id: string;
  number: number;
  reference: string;
  estimateId: string | null;
  vendorId: string | null;
  vendorName: string;
  tradePackage: string;
  status: string;
  source: string;
  currency: string;
  quotedTotal: number;
  adjustmentAmount: number;
  levelledTotal: number;
  quoteDate: string | null;
  validUntil: string | null;
  inclusions: string | null;
  exclusions: string | null;
  qualifications: string | null;
  lineCount: number;
  notes: string | null;
  acceptedAt: string | null;
  createdAt: string;
}

export interface SubQuoteDetail extends SubQuote {
  lines: SubQuoteLine[];
  warnings?: string[];
}

export interface LevellingRow {
  scopeKey: string;
  description: string;
  unit: string | null;
  quantity: number | null;
  entries: Array<{
    quoteId: string;
    vendorName: string;
    amount: number;
    unitRate: number | null;
    excluded: boolean;
    deviation: number | null;
    outlier: boolean;
  }>;
  pricedCount: number;
  excludedCount: number;
  missingVendors: string[];
  low: number | null;
  high: number | null;
  median: number | null;
  mean: number | null;
  spread: number | null;
  verdict: string;
}

export interface Levelling {
  tradePackage: string | null;
  currency: string | null;
  currencies: string[];
  rows: LevellingRow[];
  totals: Array<{
    quoteId: string;
    vendorName: string;
    status: string;
    currency: string;
    quotedTotal: number;
    adjustmentAmount: number;
    levelledTotal: number;
    coverage: number;
    pricedRows: number;
    excludedRows: number;
    missingRows: number;
    comparableTotal: number | null;
    comparableBasis: string;
  }>;
  scopeGaps: Array<{ scopeKey: string; description: string; missingVendors: string[] }>;
  outliers: Array<{
    scopeKey: string;
    description: string;
    vendorName: string;
    amount: number;
    median: number;
    deviation: number;
    direction: string;
  }>;
  warnings: string[];
}

export interface Proposal {
  id: string;
  reference: string;
  title: string;
  clientName: string | null;
  status: string;
  currency: string;
  total: number;
  detailLevel: string;
  validUntil: string | null;
  estimateId: string;
  issuedAt: string | null;
  createdAt: string;
}

export interface ProposalDocument {
  reference: string;
  title: string;
  clientName: string | null;
  projectName: string;
  currency: string;
  detailLevel: string;
  generatedAt: string;
  validUntil: string | null;
  sections: Array<{
    id: string;
    code: string | null;
    name: string;
    amount: number;
    lines: Array<{
      itemCode: string | null;
      description: string;
      unit: string | null;
      quantity: number;
      unitRate: number;
      amount: number;
    }>;
  }>;
  markupLines: Array<{ name: string; kind: string; amount: number }>;
  alternates: Array<{ description: string; amount: number }>;
  totals: { directCost: number; markupTotal: number; total: number };
  notes: string[];
}

export interface ConversionPlanLine {
  costCode: string;
  costType: string;
  description: string;
  lineKind: string;
  unit: string | null;
  quantity: number | null;
  unitRate: number | null;
  originalBudget: number;
  sourceLineIds: string[];
  sourceMarkupIds: string[];
}

export interface ConversionPreview {
  dryRun: true;
  plan: ConversionPlanLine[];
  totals: {
    estimateTotal: number;
    budgetTotal: number;
    directCostTotal: number;
    markupTotal: number;
    reconciles: boolean;
  };
  currency: string;
  warnings: string[];
}

export interface ConversionResult {
  budgetId: string;
  budgetReference: string;
  lines: number;
  totals: ConversionPreview["totals"];
  currency: string;
  warnings: string[];
}

export interface HistoricalRates {
  query: { costCode: string | null; search: string | null; unit: string | null };
  distributions: Array<{
    currency: string;
    unit: string;
    n: number;
    projects: number;
    low: number | null;
    high: number | null;
    median: number | null;
    mean: number | null;
    basis: string;
  }>;
  samples: Array<{
    description: string;
    costCode: string | null;
    unit: string | null;
    unitRate: number;
    currency: string;
    estimateReference: string;
    rateAsAt: string | null;
  }>;
  reasons: string[];
}

export interface EstimatingSummary {
  estimates: {
    total: number;
    live: number;
    byStatus: Record<string, number>;
    approvedUnconverted: number;
    converted: number;
  };
  byCurrency: Array<{ currency: string; estimates: number; total: number; directCost: number; markup: number }>;
  crossCurrency: { value: number | null; reasons: string[] };
  takeoff: { byStatus: Record<string, number>; total: number; unpriced: number; layers: number };
  subQuotes: { byStatus: Record<string, number>; total: number };
  proposals: { byStatus: Record<string, number>; total: number };
  staleRateLines: number;
  openSignals: { byDetector: Record<string, number>; total: number };
  latestEstimate: {
    id: string;
    reference: string;
    name: string;
    version: number;
    status: string;
    total: number;
    currency: string;
    lineCount: number;
    labourHours: number;
  } | null;
  staleThresholdDays: number;
  generatedAt: string;
}

export interface EstimatingSignal {
  id: string;
  detector: string;
  severity: string;
  confidence: number;
  title: string;
  explanation: string;
  disposition: string;
  evidenceRefs: unknown;
  createdAt: string;
}

export interface SweepResult {
  quotes: { expired: number; expiring: number; signalsRaised: number; signalsClosed: number; ranAt: string };
  hygiene: {
    catalogueFlagged: number;
    staleRateEstimates: number;
    unconvertedEstimates: number;
    unpricedTakeoffProjects: number;
    unpricedTakeoffItems: number;
    signalsRaised: number;
    signalsClosed: number;
    ranAt: string;
  };
}

/* ============================== Vocabulary ================================ */

export const ESTIMATE_STATUS_TONE: Record<string, Tone> = {
  draft: "neutral",
  in_review: "info",
  approved: "success",
  converted: "accent",
  superseded: "neutral",
  archived: "neutral",
  void: "danger",
};

export const LINE_STATUS_TONE: Record<string, Tone> = {
  active: "success",
  provisional: "warning",
  alternate: "info",
  excluded: "neutral",
};

export const QUOTE_STATUS_TONE: Record<string, Tone> = {
  received: "info",
  under_review: "info",
  levelled: "accent",
  accepted: "success",
  rejected: "neutral",
  expired: "danger",
  withdrawn: "neutral",
};

export const DETECTOR_LABEL: Record<string, string> = {
  estimate_stale_rates: "Stale rates",
  estimate_unconverted: "Never converted",
  sub_quote_expiring: "Quote expiring",
  sub_quote_expired: "Quote expired",
  takeoff_unpriced: "Takeoff unpriced",
  quote_outlier: "Quote outlier",
};

export const COST_TYPES = ["labour", "material", "equipment", "subcontract", "other"] as const;

export const MARKUP_KINDS = [
  "overhead",
  "profit",
  "contingency",
  "escalation",
  "general_conditions",
  "bond",
  "insurance",
  "fee",
  "tax",
  "other",
] as const;

export const MARKUP_BASIS_LABEL: Record<string, string> = {
  direct_cost: "of the direct cost",
  cost_type: "of the selected cost types",
  running_total: "of the running total",
  estimate_total: "of the estimate as it stands",
};

export const ESTIMATE_TYPES = [
  "conceptual",
  "schematic",
  "design_development",
  "construction_document",
  "gmp",
  "bid",
  "change_order",
  "budget_check",
  "other",
] as const;

export const MEASUREMENT_TYPES = ["linear", "area", "volume", "count"] as const;
export const GEOMETRY_KINDS = ["polyline", "polygon", "rectangle", "circle", "points"] as const;
export const LENGTH_UNITS = ["mm", "cm", "m", "km", "in", "ft", "yd"] as const;

export function severityTone(severity: string): Tone {
  if (severity === "critical" || severity === "high") return "danger";
  if (severity === "medium") return "warning";
  if (severity === "low") return "info";
  return "neutral";
}

/* ============================== Formatting ================================ */

export const DASH = "—";

export function money(value: number | null | undefined, currency: string, dp = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${currency} ${value.toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`;
}

export const money0 = (value: number | null | undefined, currency: string): string =>
  money(value, currency, 0);

export function num(value: number | null | undefined, dp = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return value.toLocaleString(undefined, { maximumFractionDigits: dp });
}

export function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return value.toLocaleString();
}

export function pct(value: number | null | undefined, dp = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${(value * 100).toFixed(dp)}%`;
}

export function titleCase(value: string | null | undefined): string {
  if (!value) return DASH;
  return value
    .split(/[_\s]+/)
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

export function dateOnly(value: string | null | undefined): string {
  if (!value) return DASH;
  return value.slice(0, 10);
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return DASH;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? DASH : d.toLocaleString();
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
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

export function Row({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
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

/** The engine's own words, verbatim — the arithmetic behind a number. */
export function BasisList({
  lines,
  warnings,
  className,
}: {
  lines?: string[];
  warnings?: string[];
  className?: string;
}) {
  const hasBasis = (lines?.length ?? 0) > 0;
  const hasWarnings = (warnings?.length ?? 0) > 0;
  if (!hasBasis && !hasWarnings) return null;
  return (
    <div className={cx("space-y-2", className)}>
      {hasBasis ? (
        <div>
          <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
            How this number was reached
          </div>
          <ul className="space-y-0.5 text-2xs text-content-subtle">
            {lines!.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {hasWarnings ? (
        <Alert tone="warning" size="sm" title="What this figure rests on">
          <ul className="list-disc space-y-0.5 pl-4">
            {warnings!.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
    </div>
  );
}

/** Reasons a figure is not available — printed instead of a zero. */
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

export function StatusPill({ status, map }: { status: string; map: Record<string, Tone> }) {
  return (
    <Badge tone={map[status] ?? "neutral"} size="xs" dot>
      {titleCase(status)}
    </Badge>
  );
}

/* ============================== Hooks ===================================== */

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

export function useSummary(projectId: string): Loadable<EstimatingSummary> {
  return useResource<EstimatingSummary>(
    projectId ? `/api/v1/projects/${projectId}/estimating/summary` : null,
  );
}

/* ============================== API surface =============================== */

const p = (projectId: string) => `/api/v1/projects/${projectId}`;

export const estimatingApi = {
  /* library */
  catalogue: (params: string) => api.get<Paginated<CatalogueItem>>(`/api/v1/estimating/catalogue?${params}`),
  catalogueItem: (id: string) => api.get<CatalogueDetail>(`/api/v1/estimating/catalogue/${id}`),
  createCatalogue: (body: unknown) => api.post<CatalogueItem>("/api/v1/estimating/catalogue", body),
  patchCatalogue: (id: string, body: unknown) =>
    api.patch<CatalogueItem>(`/api/v1/estimating/catalogue/${id}`, body),
  retireCatalogue: (id: string) => api.del<{ id: string }>(`/api/v1/estimating/catalogue/${id}`),
  assemblies: (params: string) => api.get<Paginated<Assembly>>(`/api/v1/estimating/assemblies?${params}`),
  assembly: (id: string) => api.get<AssemblyDetail>(`/api/v1/estimating/assemblies/${id}`),
  createAssembly: (body: unknown) => api.post<AssemblyDetail>("/api/v1/estimating/assemblies", body),
  setComponents: (id: string, body: unknown) =>
    api.put<AssemblyDetail>(`/api/v1/estimating/assemblies/${id}/components`, body),
  refreshAssembly: (id: string) =>
    api.post<AssemblyDetail>(`/api/v1/estimating/assemblies/${id}/refresh-rates`, {}),
  crews: (params: string) => api.get<Paginated<Crew>>(`/api/v1/estimating/crews?${params}`),
  createCrew: (body: unknown) => api.post<Crew>("/api/v1/estimating/crews", body),
  patchCrew: (id: string, body: unknown) => api.patch<Crew>(`/api/v1/estimating/crews/${id}`, body),
  productionRates: (params: string) =>
    api.get<Paginated<ProductionRate>>(`/api/v1/estimating/production-rates?${params}`),
  createProductionRate: (body: unknown) =>
    api.post<ProductionRate>("/api/v1/estimating/production-rates", body),

  /* estimates */
  createEstimate: (projectId: string, body: unknown) =>
    api.post<EstimateDetail>(`${p(projectId)}/estimates`, body),
  estimate: (projectId: string, id: string) =>
    api.get<EstimateDetail>(`${p(projectId)}/estimates/${id}`),
  patchEstimate: (projectId: string, id: string, body: unknown) =>
    api.patch<EstimateDetail>(`${p(projectId)}/estimates/${id}`, body),
  voidEstimate: (projectId: string, id: string) =>
    api.del<{ id: string }>(`${p(projectId)}/estimates/${id}`),
  transition: (projectId: string, id: string, action: string, body?: unknown) =>
    api.post<EstimateDetail>(`${p(projectId)}/estimates/${id}/${action}`, body ?? {}),
  recalculate: (projectId: string, id: string) =>
    api.post<EstimateDetail>(`${p(projectId)}/estimates/${id}/recalculate`, {}),
  newVersion: (projectId: string, id: string, body: unknown) =>
    api.post<EstimateDetail>(`${p(projectId)}/estimates/${id}/versions`, body),
  compare: (projectId: string, id: string, against: string) =>
    api.get<Comparison>(`${p(projectId)}/estimates/${id}/compare?against=${against}`),
  createSection: (projectId: string, id: string, body: unknown) =>
    api.post<EstimateSection>(`${p(projectId)}/estimates/${id}/sections`, body),
  deleteSection: (projectId: string, id: string, sectionId: string) =>
    api.del<{ id: string }>(`${p(projectId)}/estimates/${id}/sections/${sectionId}`),
  createLine: (projectId: string, id: string, body: unknown) =>
    api.post<LineWriteResult>(`${p(projectId)}/estimates/${id}/lines`, body),
  patchLine: (projectId: string, id: string, lineId: string, body: unknown) =>
    api.patch<LineWriteResult>(`${p(projectId)}/estimates/${id}/lines/${lineId}`, body),
  deleteLine: (projectId: string, id: string, lineId: string) =>
    api.del<{ id: string }>(`${p(projectId)}/estimates/${id}/lines/${lineId}`),
  fromAssembly: (projectId: string, id: string, body: unknown) =>
    api.post<{ created: number; warnings: string[] }>(
      `${p(projectId)}/estimates/${id}/lines/from-assembly`,
      body,
    ),
  fromTakeoff: (projectId: string, id: string, body: unknown) =>
    api.post<{ created: number; warnings: string[] }>(
      `${p(projectId)}/estimates/${id}/lines/from-takeoff`,
      body,
    ),
  createMarkup: (projectId: string, id: string, body: unknown) =>
    api.post<EstimateMarkup>(`${p(projectId)}/estimates/${id}/markups`, body),
  patchMarkup: (projectId: string, id: string, markupId: string, body: unknown) =>
    api.patch<EstimateMarkup>(`${p(projectId)}/estimates/${id}/markups/${markupId}`, body),
  deleteMarkup: (projectId: string, id: string, markupId: string) =>
    api.del<{ id: string }>(`${p(projectId)}/estimates/${id}/markups/${markupId}`),
  convert: (projectId: string, id: string, body: unknown) =>
    api.post<ConversionPreview | ConversionResult>(
      `${p(projectId)}/estimates/${id}/convert-to-budget`,
      body,
    ),
  createProposal: (projectId: string, id: string, body: unknown) =>
    api.post<Proposal>(`${p(projectId)}/estimates/${id}/proposals`, body),

  /* takeoff */
  createLayer: (projectId: string, body: unknown) =>
    api.post<TakeoffLayer>(`${p(projectId)}/takeoff/layers`, body),
  patchLayer: (projectId: string, id: string, body: unknown) =>
    api.patch<TakeoffLayer>(`${p(projectId)}/takeoff/layers/${id}`, body),
  deleteLayer: (projectId: string, id: string) =>
    api.del<{ id: string }>(`${p(projectId)}/takeoff/layers/${id}`),
  measure: (projectId: string, body: unknown) =>
    api.post<Measurement>(`${p(projectId)}/takeoff/measure`, body),
  calibrate: (projectId: string, body: unknown) =>
    api.post<{ pixelsPerUnit: number; scaleUnit: string; label: string; explanation: string }>(
      `${p(projectId)}/takeoff/calibrate`,
      body,
    ),
  createTakeoff: (projectId: string, body: unknown) =>
    api.post<TakeoffItem & { measurement: Measurement }>(`${p(projectId)}/takeoff/items`, body),
  patchTakeoff: (projectId: string, id: string, body: unknown) =>
    api.patch<TakeoffItem & { measurement: Measurement; warnings: string[] }>(
      `${p(projectId)}/takeoff/items/${id}`,
      body,
    ),
  voidTakeoff: (projectId: string, id: string) =>
    api.del<{ id: string }>(`${p(projectId)}/takeoff/items/${id}`),

  /* quotes */
  createQuote: (projectId: string, body: unknown) =>
    api.post<SubQuoteDetail>(`${p(projectId)}/estimating/sub-quotes`, body),
  patchQuote: (projectId: string, id: string, body: unknown) =>
    api.patch<SubQuoteDetail>(`${p(projectId)}/estimating/sub-quotes/${id}`, body),
  quote: (projectId: string, id: string) =>
    api.get<SubQuoteDetail>(`${p(projectId)}/estimating/sub-quotes/${id}`),
  setQuoteLines: (projectId: string, id: string, body: unknown) =>
    api.put<SubQuoteDetail>(`${p(projectId)}/estimating/sub-quotes/${id}/lines`, body),
  acceptQuote: (projectId: string, id: string, body: unknown) =>
    api.post<{ created: number; warnings: string[] }>(
      `${p(projectId)}/estimating/sub-quotes/${id}/accept`,
      body,
    ),
  withdrawQuote: (projectId: string, id: string) =>
    api.del<{ id: string }>(`${p(projectId)}/estimating/sub-quotes/${id}`),
  importBid: (projectId: string, body: unknown) =>
    api.post<SubQuoteDetail>(`${p(projectId)}/estimating/sub-quotes/import-bid`, body),

  /* proposals */
  proposalStatus: (projectId: string, id: string, body: unknown) =>
    api.post<Proposal>(`${p(projectId)}/estimating/proposals/${id}/status`, body),

  /* sweeps */
  sweep: (projectId: string) => api.post<SweepResult>(`${p(projectId)}/estimating/sweep`, {}),
};
