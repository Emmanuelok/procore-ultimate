/**
 * Per-currency money aggregation and expenditure eligibility
 * (spec Vol II Domain O #736-737, #739-741).
 *
 * WHY THIS EXISTS
 * The finance summary used to add every facility's committed amount
 * together and label the result with the FIRST facility's currency. A
 * project with a USD 100m loan and a EUR 50m grant reported
 * "GBP 150,000,000 committed" on its headline dashboard. Money in different
 * currencies is not one number, and there is no exchange rate on this
 * platform to make it one.
 *
 * The rule the whole platform follows: bucket by currency, and where a
 * single figure is genuinely required, return an Unknowable — a null with
 * the reason attached — rather than a wrong total.
 */

export interface CurrencyBucket {
  currency: string;
  amount: number;
  /** how many source records contributed */
  recordCount: number;
}

export interface Unknowable {
  value: null;
  reasons: string[];
}

export type MaybeTotal = { value: number; currency: string } | Unknowable;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Bucket amounts by currency. Non-finite amounts are skipped, never zeroed. */
export function bucketByCurrency(
  rows: Array<{ amount: number | null | undefined; currency: string | null | undefined }>,
  fallbackCurrency = "GBP",
): CurrencyBucket[] {
  const map = new Map<string, { amount: number; recordCount: number }>();
  for (const row of rows) {
    if (typeof row.amount !== "number" || !Number.isFinite(row.amount)) continue;
    const currency = row.currency || fallbackCurrency;
    const bucket = map.get(currency) ?? { amount: 0, recordCount: 0 };
    bucket.amount += row.amount;
    bucket.recordCount += 1;
    map.set(currency, bucket);
  }
  return [...map.entries()]
    .map(([currency, v]) => ({ currency, amount: round2(v.amount), recordCount: v.recordCount }))
    .sort((a, b) => (a.currency < b.currency ? -1 : 1));
}

/**
 * A single headline figure only when every contributor shares one currency.
 * Otherwise the reason is stated and the per-currency buckets are what the
 * caller must render.
 */
export function singleCurrencyTotal(buckets: CurrencyBucket[], label: string): MaybeTotal {
  if (buckets.length === 0) {
    return { value: null, reasons: [`No ${label} has been recorded.`] };
  }
  if (buckets.length === 1) {
    const only = buckets[0]!;
    return { value: only.amount, currency: only.currency };
  }
  return {
    value: null,
    reasons: [
      `${label} spans ${buckets.length} currencies (${buckets.map((b) => b.currency).join(", ")}). ` +
        `There is no exchange rate on this platform, so a single total would be a fabricated number — ` +
        `the per-currency figures are shown instead.`,
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Expenditure eligibility (#736-737)                                  */
/* ------------------------------------------------------------------ */

export interface EligibilityEntry {
  evidenceId: string;
  eligibility: string;
  reason?: string | null;
  amount?: number | null;
  note?: string | null;
}

export interface EligibilityAssessment {
  total: number;
  eligible: number;
  ineligible: number;
  unassessed: number;
  /** entries classified ineligible — a submission carrying any of these is refused */
  ineligibleEntries: EligibilityEntry[];
  unassessedEvidenceIds: string[];
  /** money attributable to ineligible items, when amounts were stated */
  ineligibleAmount: number | null;
  submittable: boolean;
  reasons: string[];
}

/**
 * Classify a withdrawal application's evidence. Every attached evidence id
 * must carry a classification; an unassessed item is not a pass — a lender
 * does not accept "we didn't look".
 */
export function assessEligibility(
  evidenceIds: string[],
  entries: EligibilityEntry[],
): EligibilityAssessment {
  const byId = new Map(entries.map((e) => [e.evidenceId, e]));
  const ineligibleEntries: EligibilityEntry[] = [];
  const unassessedEvidenceIds: string[] = [];
  let eligible = 0;
  let ineligibleAmountSum = 0;
  let anyAmount = false;

  for (const id of evidenceIds) {
    const entry = byId.get(id);
    if (!entry || entry.eligibility === "unassessed") {
      unassessedEvidenceIds.push(id);
      continue;
    }
    if (entry.eligibility === "ineligible") {
      ineligibleEntries.push(entry);
      if (typeof entry.amount === "number" && Number.isFinite(entry.amount)) {
        ineligibleAmountSum += entry.amount;
        anyAmount = true;
      }
      continue;
    }
    eligible += 1;
  }

  const reasons: string[] = [];
  if (ineligibleEntries.length > 0) {
    reasons.push(
      `${ineligibleEntries.length} attached item(s) are classified ineligible ` +
        `(${ineligibleEntries.map((e) => e.reason ?? "no reason given").join("; ")}). ` +
        `Ineligible expenditure cannot be financed — remove it from the application or record a recovery.`,
    );
  }
  if (unassessedEvidenceIds.length > 0) {
    reasons.push(
      `${unassessedEvidenceIds.length} attached item(s) have not been assessed for eligibility. ` +
        `Every item on a withdrawal application must be classified before it is submitted.`,
    );
  }
  return {
    total: evidenceIds.length,
    eligible,
    ineligible: ineligibleEntries.length,
    unassessed: unassessedEvidenceIds.length,
    ineligibleEntries,
    unassessedEvidenceIds,
    ineligibleAmount: anyAmount ? round2(ineligibleAmountSum) : null,
    submittable: ineligibleEntries.length === 0 && unassessedEvidenceIds.length === 0,
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* Forecast vs actual (#745-746)                                       */
/* ------------------------------------------------------------------ */

export interface ForecastPeriod {
  periodStart: string;
  periodEnd: string;
  plannedAmount: number;
  milestoneTaskId: string | null;
  milestoneComplete: boolean | null;
}

export interface ActualDraw {
  date: string;
  amount: number;
}

export interface ForecastComparisonPoint {
  periodStart: string;
  periodEnd: string;
  planned: number;
  actual: number;
  cumulativePlanned: number;
  cumulativeActual: number;
  variance: number;
  variancePercent: number | null;
  /** true when a milestone-triggered tranche's milestone is not complete */
  milestoneOutstanding: boolean;
}

export interface ForecastComparison {
  points: ForecastComparisonPoint[];
  totalPlanned: number;
  totalActual: number;
  /** cumulative shortfall at the last elapsed period; positive = behind plan */
  lagAmount: number;
  lagPercent: number | null;
  behindPlan: boolean;
  milestoneBreaches: string[];
  basis: string;
}

/** Threshold beyond which lagging drawdown is worth a signal. */
export const FORECAST_LAG_TOLERANCE_PERCENT = 20;

/**
 * Compare the planned drawdown profile with what actually moved. Only
 * periods that have ELAPSED count toward the lag — a future tranche not yet
 * drawn is not a lag, it is a plan.
 */
export function compareForecast(
  forecasts: ForecastPeriod[],
  actuals: ActualDraw[],
  today: string,
  tolerancePercent = FORECAST_LAG_TOLERANCE_PERCENT,
): ForecastComparison {
  const sorted = [...forecasts].sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : 1));
  let cumulativePlanned = 0;
  let cumulativeActual = 0;
  const points: ForecastComparisonPoint[] = [];
  const milestoneBreaches: string[] = [];

  for (const f of sorted) {
    const actual = actuals
      .filter((a) => a.date > f.periodStart && a.date <= f.periodEnd)
      .reduce((s, a) => s + a.amount, 0);
    cumulativePlanned += f.plannedAmount;
    cumulativeActual += actual;
    const variance = round2(actual - f.plannedAmount);
    const milestoneOutstanding =
      f.milestoneTaskId !== null && f.milestoneComplete === false && f.periodEnd <= today;
    if (milestoneOutstanding) {
      milestoneBreaches.push(
        `The tranche of ${f.plannedAmount} planned for the period ending ${f.periodEnd} is tied to ` +
          `a schedule milestone that is not complete.`,
      );
    }
    points.push({
      periodStart: f.periodStart,
      periodEnd: f.periodEnd,
      planned: round2(f.plannedAmount),
      actual: round2(actual),
      cumulativePlanned: round2(cumulativePlanned),
      cumulativeActual: round2(cumulativeActual),
      variance,
      variancePercent:
        Math.abs(f.plannedAmount) < 1e-9 ? null : round2((variance / f.plannedAmount) * 100),
      milestoneOutstanding,
    });
  }

  const elapsed = points.filter((p) => p.periodEnd <= today);
  const last = elapsed[elapsed.length - 1];
  const lagAmount = last ? round2(last.cumulativePlanned - last.cumulativeActual) : 0;
  const lagPercent =
    last && Math.abs(last.cumulativePlanned) > 1e-9
      ? round2((lagAmount / last.cumulativePlanned) * 100)
      : null;
  return {
    points,
    totalPlanned: round2(cumulativePlanned),
    totalActual: round2(cumulativeActual),
    lagAmount,
    lagPercent,
    behindPlan: lagPercent !== null && lagPercent > tolerancePercent,
    milestoneBreaches,
    basis:
      `Planned tranches compared with disbursements dated inside each period. Only periods that ` +
      `had elapsed by ${today} count toward the lag; a tolerance of ${tolerancePercent}% of the ` +
      `cumulative plan applies before it is reported as behind plan.`,
  };
}
