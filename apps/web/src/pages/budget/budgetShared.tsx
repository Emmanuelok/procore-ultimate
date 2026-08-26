/**
 * Shared vocabulary for the BUDGET workspace — spec Vol I §3.1 / module M2.
 *
 * Every type below mirrors a response shape produced by
 * apps/api/src/modules/budget (index.ts + calc.ts). Nothing here invents a
 * field, and nothing here does arithmetic the API already did: the budget's
 * whole point is that the figure on the grid, the figure in the month-end
 * capture and the figure in the summary are provably the same figure, and a
 * client that re-derives them quietly breaks that.
 *
 * THREE HONESTY RULES, ENFORCED BY THE COMPONENTS AT THE BOTTOM OF THIS FILE
 *
 *  1. A figure with no source renders its empty state WITH THE REASON. The API
 *     returns `{ value: null, reasons: [...] }` for anything it cannot compute
 *     (`Figure` below, `Component` in calc.ts). `<FigureValue>` renders "Not
 *     available" plus those reasons verbatim — never a 0, which a reader
 *     cannot tell apart from "genuinely zero cost".
 *  2. REASONS ARE QUOTED, NOT PARAPHRASED. They name the exact platform
 *     records that are absent; rewriting them blurs that.
 *  3. MONEY IS NEVER SUMMED ACROSS CURRENCIES. Every money formatter here
 *     takes an explicit currency, and `groupByCurrency` exists so a project
 *     holding budgets in two currencies is shown as two totals, never one.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  BudgetChangeKind,
  BudgetChangeStatus,
  BudgetForecastStatus,
  BudgetLineKind,
  BudgetLineStatus,
  BudgetSnapshotKind,
  BudgetStatus,
  CostType,
  ForecastMethod,
} from "@constructos/shared";
import { ApiClientError, api } from "../../lib/api";
import { Alert, Badge, Tooltip, cx } from "../../ui";
import type { Tone } from "../../ui/tokens";

/* ========================================================================== */
/* Wire types                                                                  */
/* ========================================================================== */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** calc.ts `Identity` — a reconciliation the cost report must satisfy. */
export interface Identity {
  identity: string;
  left: number;
  right: number;
  delta: number;
  ok: boolean;
}

/**
 * calc.ts `Component` — a figure the platform either holds the inputs for, or
 * does not. `value: null` is never a zero; `reasons` says what was absent.
 */
export interface Figure {
  value: number | null;
  inputs: Record<string, unknown>;
  reasons: string[];
}

export interface BudgetTotals {
  originalBudgetTotal: number;
  budgetModificationsTotal: number;
  approvedChangesTotal: number;
  pendingChangesTotal: number;
  revisedBudgetTotal: number;
  committedTotal: number;
  pendingCommitmentsTotal: number;
  directCostsTotal: number;
  jobToDateCostsTotal: number;
  forecastToCompleteTotal: number;
  forecastFinalTotal: number;
  varianceTotal: number;
}

export interface BudgetRecord extends BudgetTotals {
  id: string;
  companyId: string;
  projectId: string;
  number: number;
  reference: string;
  name: string;
  description: string | null;
  status: BudgetStatus;
  version: number;
  /** 0 / 1 — exactly one active budget per project drives every rollup */
  isActive: number;
  currency: string;
  wbsSegmentIds: string[];
  lockedAt: string | null;
  lockedBy: string | null;
  totalsCalculatedAt: string | null;
  settings: Record<string, unknown>;
  detail: Record<string, unknown>;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotRef {
  id: string;
  reference: string;
  name: string;
  asOfDate: string;
  capturedAt: string;
}

export interface BudgetDetail extends BudgetRecord {
  lineCount: number;
  reconciliation: Identity[];
  lastSnapshot: SnapshotRef | null;
  /** false once the budget is locked, closed, or a period has been captured */
  planEditable: boolean;
}

export interface BudgetLine {
  id: string;
  budgetId: string;
  companyId: string;
  projectId: string;
  costCodeId: string | null;
  costCode: string;
  costType: CostType;
  wbsPath: string | null;
  subJob: string | null;
  description: string;
  lineKind: BudgetLineKind;
  status: BudgetLineStatus;
  unit: string | null;
  quantity: number | null;
  unitRate: number | null;
  originalBudget: number;
  budgetModifications: number;
  approvedChanges: number;
  pendingBudgetChanges: number;
  revisedBudget: number;
  committedCost: number;
  pendingCommitments: number;
  directCosts: number;
  jobToDateCosts: number;
  forecastMethod: ForecastMethod;
  forecastToComplete: number;
  forecastFinal: number;
  /** revisedBudget − forecastFinal. NEGATIVE IS AN OVERRUN. */
  projectedOverUnder: number;
  percentComplete: number;
  notes: string | null;
  sortOrder: number;
  detail: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** present when the line's own forecast method could not be applied */
  forecastNotice?: string[];
}

export interface DerivedLine {
  revisedBudget: number;
  obligated: number;
  uncommittedBudget: number;
  forecastToComplete: number;
  forecastFinal: number;
  projectedOverUnder: number;
  costPercentComplete: number | null;
  exposure: number;
}

export interface BudgetLineDetail extends BudgetLine {
  currency: string;
  derived: DerivedLine;
  forecastHistory: ForecastRecord[];
}

export interface LinesResponse extends ListResponse<BudgetLine> {
  pageTotals: BudgetTotals;
  filteredTotals: BudgetTotals;
  currency: string;
}

export interface ChangeLeg {
  lineItemId: string;
  costCode: string;
  costType: CostType;
  amount: number;
}

export interface BudgetChange {
  id: string;
  companyId: string;
  projectId: string;
  budgetId: string;
  number: number;
  reference: string;
  kind: BudgetChangeKind;
  title: string;
  description: string | null;
  reason: string | null;
  status: BudgetChangeStatus;
  lines: ChangeLeg[];
  fromLineItemId: string | null;
  toLineItemId: string | null;
  amount: number;
  netEffect: number;
  effectiveDate: string | null;
  sourceType: string | null;
  sourceId: string | null;
  requestedBy: string;
  requestedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  detail: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetChangeDetail extends BudgetChange {
  currency: string;
  balance: { net: number; amount: number; balances: boolean; error: string | null };
}

export interface Movement {
  changeId: string;
  reference: string;
  kind: BudgetChangeKind;
  title: string;
  reason: string | null;
  effectiveDate: string | null;
  requestedBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  sourceType: string | null;
  sourceId: string | null;
  lineItemId: string;
  costCode: string;
  costType: CostType;
  amount: number;
  lineBalanceAfter: number;
  budgetTotalAfter: number;
}

export interface MovementsResponse {
  budgetId: string;
  currency: string;
  openingTotal: number;
  closingTotal: number;
  movementCount: number;
  /** proves the ledger reconstructs the stored revised total */
  reconcilesToRevisedTotal: boolean;
  storedRevisedTotal: number;
  movements: Movement[];
}

export interface SnapshotSummary {
  id: string;
  number: number;
  reference: string;
  name: string;
  kind: BudgetSnapshotKind;
  asOfDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  billingPeriodId: string | null;
  totals: Partial<BudgetTotals>;
  contentHash: string;
  lineCount: number;
  notes: string | null;
  capturedBy: string;
  capturedAt: string;
}

export interface SnapshotLine {
  lineItemId: string;
  costCode: string;
  costType: string;
  description: string;
  wbsPath: string | null;
  lineKind: string;
  originalBudget: number;
  budgetModifications: number;
  approvedChanges: number;
  revisedBudget: number;
  committedCost: number;
  pendingCommitments: number;
  directCosts: number;
  jobToDateCosts: number;
  forecastMethod: string;
  forecastToComplete: number;
  forecastFinal: number;
  projectedOverUnder: number;
  percentComplete: number;
}

export interface SnapshotDetail extends SnapshotSummary {
  lines: SnapshotLine[];
  /** false means the stored capture no longer hashes to its recorded value */
  hashVerified: boolean;
  recomputedContentHash: string;
  immutable: boolean;
}

export interface FieldDelta {
  field: string;
  from: number;
  to: number;
  delta: number;
}

export interface SnapshotLineDiff {
  lineItemId: string;
  costCode: string;
  costType: string;
  description: string;
  fields: FieldDelta[];
}

export interface SnapshotDiffResponse {
  budgetId: string;
  currency: string;
  from: { id: string; reference: string; name: string; asOfDate: string; lineCount: number; contentHash: string };
  to: { id: string; reference: string; name: string; asOfDate: string; lineCount: number; contentHash: string };
  added: SnapshotLine[];
  removed: SnapshotLine[];
  changed: SnapshotLineDiff[];
  unchangedCount: number;
  totals: FieldDelta[];
  addedCount: number;
  removedCount: number;
  changedCount: number;
}

export interface CurvePoint {
  month: string;
  amount: number;
}

export interface ForecastRecord {
  id: string;
  companyId: string;
  projectId: string;
  budgetId: string;
  lineItemId: string | null;
  billingPeriodId: string | null;
  number: number;
  reference: string;
  asOfDate: string;
  method: ForecastMethod;
  status: BudgetForecastStatus;
  forecastToComplete: number;
  forecastFinal: number;
  previousForecastFinal: number;
  deltaFromPrevious: number;
  percentComplete: number;
  curve: CurvePoint[];
  assumptions: string | null;
  notes: string | null;
  detail: Record<string, unknown>;
  createdBy: string;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ForecastPreviewLine {
  lineItemId: string;
  costCode: string;
  costType: CostType;
  description: string;
  revisedBudget: number;
  jobToDateCosts: number;
  storedMethod: ForecastMethod;
  storedForecastToComplete: number;
  storedForecastFinal: number;
  /** null when the method's inputs are absent — never a fabricated figure */
  proposedForecastToComplete: number | null;
  proposedForecastFinal: number | null;
  proposedProjectedOverUnder: number | null;
  delta: number | null;
  reasons: string[];
}

export interface ForecastPreview {
  budgetId: string;
  currency: string;
  method: ForecastMethod;
  lineCount: number;
  computableCount: number;
  /** null when NO line supports the method — a total would be a fiction */
  proposedForecastFinalTotal: number | null;
  uncomputableCount: number;
  lines: ForecastPreviewLine[];
}

export interface BudgetSummary {
  budgetId: string;
  projectId: string;
  reference: string;
  name: string;
  status: BudgetStatus;
  currency: string;
  asOf: string;
  lineCount: number;
  plan: {
    originalBudget: number;
    budgetModifications: number;
    approvedChanges: number;
    pendingChanges: number;
    revisedBudget: number;
    forecastToComplete: number;
    forecastFinal: number;
    variance: number;
  };
  components: {
    committed: Figure;
    pendingCommitments: Figure;
    invoicedToDate: Figure;
    directCosts: Figure;
    jobToDateCosts: Figure;
    contingencyRemaining: Figure;
  };
  drift: {
    committed: number | null;
    jobToDateCosts: number | null;
    totalsCalculatedAt: string | null;
  };
  reconciliation: Identity[];
  overrunLines: Array<{
    lineItemId: string;
    costCode: string;
    costType: CostType;
    description: string;
    revisedBudget: number;
    forecastFinal: number;
    projectedOverUnder: number;
  }>;
}

export interface RecalculateResult {
  budgetId: string;
  currency: string;
  updatedLines: number;
  totals: BudgetTotals;
  reconciliation: Identity[];
  applied: { committedCost: boolean; pendingCommitments: boolean; jobToDateCosts: boolean };
  /** why a component was left alone — never silently zeroed */
  skipped: Array<{ component: string; reasons: string[] }>;
}

export interface ImportIssue {
  row: number;
  field: string | null;
  message: string;
}

export interface ImportPreviewRow {
  row: number;
  costCode: string;
  costType: CostType;
  description: string;
  originalBudget: number;
}

export interface ImportDryRun {
  dryRun: true;
  budgetId: string;
  parsedRows: number;
  readyRows: number;
  unknownColumns: string[];
  issues: ImportIssue[];
  preview: ImportPreviewRow[];
  totalOriginalBudget: number;
}

export interface ImportResult {
  dryRun: false;
  budgetId: string;
  parsedRows: number;
  unknownColumns: string[];
  created: number;
  updated: number;
  issues: ImportIssue[];
}

export interface CostCodeOption {
  id: string;
  code: string;
  title: string;
  division: string | null;
  costType: CostType | null;
  parentId: string | null;
  source: "standard" | "project";
}

export interface CompanyUser {
  id: string;
  name: string;
  email: string;
}

export interface ChangeOrderPackageRef {
  id: string;
  reference: string;
  title: string;
  status: string;
  amount: number;
  kind: string;
}

/* ========================================================================== */
/* Errors                                                                      */
/* ========================================================================== */

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) return err.message;
  return err instanceof Error ? err.message : fallback;
}

interface ErrorBody {
  statusCode?: number;
  error?: string;
  message?: string;
  details?: unknown;
}

/** The `details` payload the API attaches to a refusal, defensively read. */
export function errorDetails(err: unknown): Record<string, unknown> | null {
  if (!(err instanceof ApiClientError)) return null;
  const body = err.details as ErrorBody | undefined;
  const details = body?.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    return details as Record<string, unknown>;
  }
  return null;
}

/** `details.reasons`, verbatim. Empty when the refusal carried none. */
export function errorReasons(err: unknown): string[] {
  const raw = errorDetails(err)?.["reasons"];
  return Array.isArray(raw) ? raw.map((r) => String(r)) : [];
}

/** `details.issues` from a rejected bulk/CSV import. */
export function errorIssues(err: unknown): ImportIssue[] {
  const raw = errorDetails(err)?.["issues"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const issue = entry as Record<string, unknown>;
    return [
      {
        row: typeof issue["row"] === "number" ? issue["row"] : 0,
        field: typeof issue["field"] === "string" ? issue["field"] : null,
        message: String(issue["message"] ?? "Rejected"),
      },
    ];
  });
}

export const isForbidden = (err: unknown): boolean =>
  err instanceof ApiClientError && err.status === 403;

/* ========================================================================== */
/* Formatting                                                                  */
/* ========================================================================== */

const currencyFormats = new Map<string, Intl.NumberFormat>();

function currencyFormat(currency: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${currency}|${JSON.stringify(options)}`;
  let format = currencyFormats.get(key);
  if (!format) {
    try {
      format = new Intl.NumberFormat(undefined, { style: "currency", currency, ...options });
    } catch {
      format = new Intl.NumberFormat(undefined, options);
    }
    currencyFormats.set(key, format);
  }
  return format;
}

export interface MoneyOptions {
  compact?: boolean;
  signed?: boolean;
  precision?: number;
}

/**
 * Money in ONE currency. There is deliberately no overload that takes a list
 * of differently denominated amounts: this platform does not convert, and a
 * formatter that accepted a mixed list would invite a caller to add them.
 */
export function money(
  value: number | null | undefined,
  currency: string,
  options: MoneyOptions = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_AVAILABLE;
  const { compact = false, signed = false, precision } = options;
  const intl: Intl.NumberFormatOptions = compact
    ? { notation: "compact", maximumFractionDigits: precision ?? 1, minimumFractionDigits: 0 }
    : {
        minimumFractionDigits: precision ?? 0,
        maximumFractionDigits: precision ?? 0,
        currencyDisplay: "narrowSymbol",
      };
  if (signed) intl.signDisplay = "exceptZero";
  return currencyFormat(currency, intl).format(value);
}

export const NOT_AVAILABLE = "Not available";
export const EM_DASH = "—";

export function percent(fraction: number | null | undefined, precision = 1): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return EM_DASH;
  return `${(fraction * 100).toFixed(precision)}%`;
}

export function count(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function labelize(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  return value
    .split(/[_\s]+/)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

export function isoDate(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  return value.slice(0, 10);
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const today = (): string => new Date().toISOString().slice(0, 10);

/* ========================================================================== */
/* Domain labels + tones                                                       */
/* ========================================================================== */

export const BUDGET_STATUS_TONE: Record<BudgetStatus, Tone> = {
  draft: "neutral",
  locked: "info",
  revised: "accent",
  closed: "neutral",
};

export const CHANGE_STATUS_TONE: Record<BudgetChangeStatus, Tone> = {
  draft: "neutral",
  pending_approval: "warning",
  approved: "success",
  rejected: "danger",
  void: "neutral",
};

export const LINE_STATUS_TONE: Record<BudgetLineStatus, Tone> = {
  draft: "neutral",
  active: "success",
  locked: "info",
  closed: "neutral",
  void: "danger",
};

export const FORECAST_STATUS_TONE: Record<BudgetForecastStatus, Tone> = {
  draft: "neutral",
  submitted: "warning",
  approved: "success",
  superseded: "neutral",
};

export const CHANGE_KIND_LABEL: Record<BudgetChangeKind, string> = {
  transfer: "Transfer",
  contingency_draw: "Contingency draw",
  owner_change: "Owner change",
  adjustment: "Adjustment",
  reallocation: "Reallocation",
};

export const CHANGE_KIND_RULE: Record<BudgetChangeKind, string> = {
  transfer: "Must balance to zero across its legs — money out of one line lands in another.",
  contingency_draw:
    "Must balance to zero AND every source leg must be a line of kind 'contingency'.",
  owner_change:
    "The only kind that changes the budget total, and only as the downstream effect of an executed prime contract change order (sourceType 'change_order_package').",
  adjustment: "Must balance to zero across its legs.",
  reallocation: "Must balance to zero across its legs.",
};

/**
 * The method is recorded alongside every forecast precisely so a reader knows
 * whether they are looking at an estimator's judgement or a formula. These
 * descriptions are the ones calc.ts documents, and they are shown wherever a
 * method is shown.
 */
export const FORECAST_METHOD_LABEL: Record<ForecastMethod, string> = {
  manual: "Manual",
  remaining_budget: "Remaining budget",
  percent_complete: "Percent complete",
  committed_plus_pending: "Committed + pending",
  unit_rate_trend: "Unit-rate trend",
  productivity_trend: "Productivity trend",
};

export const FORECAST_METHOD_HINT: Record<ForecastMethod, string> = {
  manual: "The estimator typed it. Nothing is derived; the figure is refused if absent.",
  remaining_budget:
    "FTC = revised − job-to-date. Assumes the remaining work costs exactly what was budgeted for it.",
  percent_complete:
    "FTC = revised × (1 − % complete). Remaining work at the budgeted rate; treats the overrun to date as a one-off.",
  committed_plus_pending:
    "FAC = max(revised, committed + pending + direct). The commitment-led view: you will spend at least what you have signed for.",
  unit_rate_trend:
    "Actual unit rate achieved to date × remaining quantity. Only meaningful on a measured line.",
  productivity_trend:
    "FAC = job-to-date ÷ % complete. Assumes the rate achieved so far continues — the pessimistic sibling of percent complete.",
};

export const SNAPSHOT_KIND_LABEL: Record<BudgetSnapshotKind, string> = {
  monthly_close: "Monthly close",
  milestone: "Milestone",
  manual: "Manual",
  forecast_lock: "Forecast lock",
  closeout: "Closeout",
};

export const LINE_KIND_LABEL: Record<BudgetLineKind, string> = {
  standard: "Standard",
  allowance: "Allowance",
  contingency: "Contingency",
  alternate: "Alternate",
  owner_reserve: "Owner reserve",
  escalation: "Escalation",
  markup: "Markup",
};

/**
 * `projectedOverUnder` is revised − forecast: POSITIVE is favourable (under
 * budget), NEGATIVE is an overrun. Naming that here once stops the sign being
 * re-guessed at every call site.
 */
export function varianceTone(variance: number): Tone {
  if (variance > 0) return "success";
  if (variance < 0) return "danger";
  return "neutral";
}

export function varianceWord(variance: number): string {
  if (variance > 0) return "favourable";
  if (variance < 0) return "adverse";
  return "on budget";
}

/**
 * Overrun severity as a share of the line's revised budget. Drives the
 * magnitude treatment on the grid's variance column: a £900 overrun on a
 * £1,000 line is a different fact from a £900 overrun on £4m.
 */
export type VarianceBand = "favourable" | "on_budget" | "slight" | "material" | "severe";

export function varianceBand(variance: number, revisedBudget: number): VarianceBand {
  if (variance > 0) return "favourable";
  if (variance === 0) return "on_budget";
  const base = Math.abs(revisedBudget);
  if (base === 0) return "severe";
  const share = Math.abs(variance) / base;
  if (share <= 0.02) return "slight";
  if (share <= 0.1) return "material";
  return "severe";
}

export const VARIANCE_BAND_CLASS: Record<VarianceBand, string> = {
  favourable: "text-success-fg",
  on_budget: "text-content-muted",
  slight: "text-warning-fg",
  material: "text-danger-fg bg-danger-subtle/60",
  severe: "text-danger-fg bg-danger-subtle font-semibold",
};

/** Human sentence for a variance band — used in tooltips, never invented. */
export const VARIANCE_BAND_NOTE: Record<VarianceBand, string> = {
  favourable: "Forecast at completion is below the revised budget.",
  on_budget: "Forecast at completion equals the revised budget.",
  slight: "Overrun within 2% of this line's revised budget.",
  material: "Overrun between 2% and 10% of this line's revised budget.",
  severe: "Overrun beyond 10% of this line's revised budget.",
};

/* ========================================================================== */
/* Currency discipline                                                         */
/* ========================================================================== */

export interface CurrencyGroup<T> {
  currency: string;
  items: T[];
}

/**
 * Split a list of budgets (or anything carrying a `currency`) into one bucket
 * per currency. Callers total INSIDE a bucket and never across buckets — the
 * platform holds no rate and inventing one would be a fabrication.
 */
export function groupByCurrency<T extends { currency: string }>(rows: readonly T[]): CurrencyGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = buckets.get(row.currency);
    if (bucket) bucket.push(row);
    else buckets.set(row.currency, [row]);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([currency, items]) => ({ currency, items }));
}

/* ========================================================================== */
/* Data loading                                                                */
/* ========================================================================== */

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  setData: (next: T | null) => void;
}

/**
 * One loader for the whole workspace. A failed load is NEVER rendered as an
 * empty result — `error` is surfaced with a retry, because "nothing here" and
 * "we could not ask" are different statements about a project's money.
 */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  enabled = true,
): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadRef.current(controller.signal).then(
      (next) => {
        if (cancelled) return;
        setData(next);
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setError(errorMessage(err, "This view could not be loaded"));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, nonce]);

  return {
    data,
    error,
    loading,
    reload: () => setNonce((n) => n + 1),
    setData,
  };
}

/** The API pages at 200 rows; a budget grid wants the whole cost report. */
export async function loadAllLines(
  budgetId: string,
  signal: AbortSignal,
): Promise<{ lines: BudgetLine[]; totals: BudgetTotals; currency: string; total: number }> {
  const first = await api.get<LinesResponse>(
    `/api/v1/budgets/${budgetId}/lines?page=1&pageSize=200&sort=sortOrder`,
    { signal },
  );
  const lines = [...first.items];
  const pages = Math.min(Math.ceil(first.total / Math.max(1, first.pageSize)), 25);
  for (let page = 2; page <= pages; page += 1) {
    const next = await api.get<LinesResponse>(
      `/api/v1/budgets/${budgetId}/lines?page=${page}&pageSize=200&sort=sortOrder`,
      { signal },
    );
    lines.push(...next.items);
  }
  return {
    lines,
    totals: first.filteredTotals,
    currency: first.currency,
    total: first.total,
  };
}

export function useCompanyUsers(): Map<string, string> {
  const [byId, setById] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    api
      .get<ListResponse<CompanyUser>>("/api/v1/company/users?page=1&pageSize=200")
      .then((res) => {
        if (cancelled) return;
        setById(new Map(res.items.map((u) => [u.id, u.name || u.email])));
      })
      .catch(() => {
        /* names are a courtesy; ids still render */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return byId;
}

/** Actor id → name, falling back to the id so a row is never blank. */
export function actorName(users: Map<string, string>, id: string | null | undefined): string {
  if (!id) return EM_DASH;
  return users.get(id) ?? id;
}

/* ========================================================================== */
/* Honesty components                                                          */
/* ========================================================================== */

/**
 * The server's reasons, quoted. These name the exact platform records that are
 * absent ("No commitment schedule-of-values lines exist on this project yet,
 * so committed cost is unknown rather than zero"), and paraphrasing them would
 * cost the reader the only thing that makes the gap actionable.
 */
export function ReasonList({
  reasons,
  className,
}: {
  reasons: readonly string[];
  className?: string;
}) {
  if (reasons.length === 0) return null;
  return (
    <ul className={cx("space-y-1", className)}>
      {reasons.map((reason, index) => (
        <li key={index} className="flex items-start gap-1.5 text-meta text-content-muted">
          <span aria-hidden className="mt-0.5 shrink-0 text-content-disabled">
            ▪
          </span>
          <span>{reason}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A `Figure` rendered honestly: the amount when the platform holds the inputs,
 * "Not available" plus the reasons when it does not. Never a zero standing in
 * for an unknown.
 */
export function FigureValue({
  figure,
  currency,
  compact = false,
  className,
  reasonsBelow = false,
}: {
  figure: Figure | null | undefined;
  currency: string;
  compact?: boolean;
  className?: string;
  reasonsBelow?: boolean;
}) {
  if (!figure) {
    return <span className="text-content-disabled">{EM_DASH}</span>;
  }
  if (figure.value === null) {
    const label = (
      <span className={cx("inline-flex items-center gap-1 text-content-muted", className)}>
        <span className="text-body font-medium">{NOT_AVAILABLE}</span>
        <Badge tone="warning" size="xs">
          why
        </Badge>
      </span>
    );
    if (reasonsBelow) {
      return (
        <span className="block">
          {label}
          <ReasonList reasons={figure.reasons} className="mt-1.5" />
        </span>
      );
    }
    return (
      <Tooltip
        content={
          figure.reasons.length > 0 ? (
            <span className="block max-w-xs space-y-1">
              {figure.reasons.map((reason, index) => (
                <span key={index} className="block">
                  {reason}
                </span>
              ))}
            </span>
          ) : (
            "The platform holds no inputs for this figure."
          )
        }
      >
        {label}
      </Tooltip>
    );
  }
  return (
    <span className={cx("tabular-nums", className)}>{money(figure.value, currency, { compact })}</span>
  );
}

/** A failed load, named and retryable. Never rendered as "no data". */
export function LoadError({
  message,
  onRetry,
  title = "This view could not be loaded",
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

/**
 * A refusal the platform is SUPPOSED to make — segregation of duties, an
 * unbalanced transfer, a back-dated movement into a captured period. It is the
 * control working, so it is presented as a rule, not as a failure, with the
 * server's own wording kept intact.
 */
export function RefusalNotice({
  title,
  message,
  reasons = [],
  onDismiss,
}: {
  title: string;
  message: string;
  reasons?: readonly string[];
  onDismiss?: () => void;
}) {
  return (
    <Alert tone="warning" title={title} onDismiss={onDismiss}>
      <p>{message}</p>
      <ReasonList reasons={reasons} className="mt-2" />
    </Alert>
  );
}

/** Reconciliation identities, stated out loud rather than trusted silently. */
export function ReconciliationBadge({
  identities,
  currency,
}: {
  identities: readonly Identity[];
  currency: string;
}) {
  if (identities.length === 0) return null;
  const failing = identities.filter((identity) => !identity.ok);
  const content = (
    <span className="block max-w-md space-y-1">
      {identities.map((identity) => (
        <span key={identity.identity} className="block">
          {identity.ok ? "✓" : "✗"} {identity.identity} — {money(identity.left, currency)} vs{" "}
          {money(identity.right, currency)}
          {identity.ok ? "" : ` (out by ${money(identity.delta, currency)})`}
        </span>
      ))}
    </span>
  );
  return (
    <Tooltip content={content}>
      <span>
        <Badge tone={failing.length === 0 ? "success" : "danger"} size="sm" dot>
          {failing.length === 0
            ? "Reconciled"
            : `${failing.length} identity ${failing.length === 1 ? "fails" : "fail"}`}
        </Badge>
      </span>
    </Tooltip>
  );
}

/** The forecast method, always shown beside the figure it produced. */
export function MethodBadge({
  method,
  size = "xs",
}: {
  method: ForecastMethod;
  size?: "xs" | "sm";
}) {
  return (
    <Tooltip content={FORECAST_METHOD_HINT[method]}>
      <span>
        <Badge tone={method === "manual" ? "highlight" : "info"} size={size} variant="outline">
          {FORECAST_METHOD_LABEL[method]}
        </Badge>
      </span>
    </Tooltip>
  );
}

/** Section heading used by every tab, so the workspace reads as one screen. */
export function SectionHeading({
  title,
  hint,
  actions,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("mb-3 flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h2 className="text-body font-semibold text-content">{title}</h2>
        {hint ? <p className="mt-0.5 max-w-3xl text-meta text-content-muted">{hint}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
