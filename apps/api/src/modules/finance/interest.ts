/**
 * Cost of finance: interest during construction and commitment fees
 * (spec Vol II Domain O #748-751).
 *
 * WHY THIS EXISTS
 * On a DFI-financed project the interest accruing on drawn balances and the
 * commitment fee accruing on the UNDRAWN balance are real project costs
 * that never appear on any invoice. They are the reason a facility that
 * "cost nothing to arrange" quietly adds several percent to the outturn.
 *
 * MODEL
 * The schedule walks the disbursement ledger period by period:
 *   drawn(t)      = cumulative disbursed at the period end
 *   undrawn(t)    = committed − drawn(t)
 *   interest(t)   = averageDrawn(t) × (base + margin) × dayFraction
 *   fee(t)        = averageUndrawn(t) × feeRate × dayFraction
 * Average balances, not closing balances: a draw on the last day of a
 * quarter does not accrue a quarter of interest.
 *
 * When `capitalise` is set, accrued interest is added to the drawn balance
 * and itself accrues from the following period — which is what "interest
 * during construction" means on a project-finance facility.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * No compounding within a period, no rate curves, no cash-sweep, and no
 * currency conversion. Rates are inputs, not forecasts.
 */
import type { DayCountConvention } from "@constructos/shared";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Days in the year for a convention; 30/360 uses 360 with 30-day months. */
export function dayCountBasis(convention: DayCountConvention): number {
  switch (convention) {
    case "actual_360":
      return 360;
    case "thirty_360":
      return 360;
    case "actual_365":
    default:
      return 365;
  }
}

export function daysInPeriod(
  from: string,
  to: string,
  convention: DayCountConvention,
): number {
  if (convention === "thirty_360") {
    const [y1, m1, d1] = from.split("-").map(Number) as [number, number, number];
    const [y2, m2, d2] = to.split("-").map(Number) as [number, number, number];
    const dd1 = Math.min(d1, 30);
    const dd2 = dd1 === 30 ? Math.min(d2, 30) : d2;
    return (y2 - y1) * 360 + (m2 - m1) * 30 + (dd2 - dd1);
  }
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

export interface DrawEvent {
  /** ISO date the money moved */
  date: string;
  amount: number;
}

export interface AccrualPeriod {
  periodStart: string;
  periodEnd: string;
  days: number;
  openingDrawn: number;
  drawnInPeriod: number;
  closingDrawn: number;
  averageDrawn: number;
  averageUndrawn: number;
  interest: number;
  commitmentFee: number;
  /** interest added to the balance this period when capitalising */
  capitalised: number;
  cumulativeInterest: number;
  cumulativeFees: number;
}

export interface AccrualSchedule {
  periods: AccrualPeriod[];
  totalInterest: number;
  totalCommitmentFees: number;
  totalCostOfFinance: number;
  currency: string;
  basis: string;
  /** set when rates are not configured — the schedule is then empty, not zero */
  unavailableReason: string | null;
}

export interface AccrualOptions {
  committedAmount: number;
  currency: string;
  baseRatePercent: number | null;
  marginPercent: number | null;
  commitmentFeePercent: number | null;
  convention: DayCountConvention;
  capitalise: boolean;
  /** period boundaries, ascending; the first is the schedule start */
  periodEnds: string[];
  periodStart: string;
  draws: DrawEvent[];
}

/**
 * Build the accrual schedule. A facility with no rates configured returns
 * an empty schedule and a reason — reporting 0 interest on a loan that
 * plainly bears interest would be a fabricated number.
 */
export function buildAccrualSchedule(options: AccrualOptions): AccrualSchedule {
  const allInterestRate =
    options.baseRatePercent === null && options.marginPercent === null
      ? null
      : (options.baseRatePercent ?? 0) + (options.marginPercent ?? 0);
  const feeRate = options.commitmentFeePercent;
  if (allInterestRate === null && feeRate === null) {
    return {
      periods: [],
      totalInterest: 0,
      totalCommitmentFees: 0,
      totalCostOfFinance: 0,
      currency: options.currency,
      basis: "",
      unavailableReason:
        "No base rate, margin or commitment fee is configured on this facility, so the cost of finance cannot be derived.",
    };
  }
  const basisDays = dayCountBasis(options.convention);
  const periods: AccrualPeriod[] = [];
  const draws = [...options.draws].sort((a, b) => (a.date < b.date ? -1 : 1));

  // Anything drawn on or before the schedule start is an opening balance,
  // not a movement inside the first period — otherwise a draw dated exactly
  // on the start date would accrue nothing at all.
  let drawn = draws
    .filter((d) => d.date <= options.periodStart)
    .reduce((s, d) => s + d.amount, 0);
  let cumulativeInterest = 0;
  let cumulativeFees = 0;
  let cursor = options.periodStart;

  for (const periodEnd of options.periodEnds) {
    if (periodEnd <= cursor) continue;
    const days = daysInPeriod(cursor, periodEnd, options.convention);
    const inPeriod = draws.filter((d) => d.date > cursor && d.date <= periodEnd);
    const drawnInPeriod = inPeriod.reduce((s, d) => s + d.amount, 0);
    const openingDrawn = drawn;

    // Time-weighted average drawn balance across the period.
    let weighted = openingDrawn * days;
    for (const d of inPeriod) {
      const remaining = daysInPeriod(d.date, periodEnd, options.convention);
      weighted += d.amount * Math.max(0, remaining);
    }
    const averageDrawn = days > 0 ? weighted / days : openingDrawn;
    const averageUndrawn = Math.max(0, options.committedAmount - averageDrawn);
    const fraction = days / basisDays;
    const interest =
      allInterestRate === null ? 0 : averageDrawn * (allInterestRate / 100) * fraction;
    const commitmentFee = feeRate === null ? 0 : averageUndrawn * (feeRate / 100) * fraction;

    drawn = openingDrawn + drawnInPeriod;
    const capitalised = options.capitalise ? interest : 0;
    drawn += capitalised;
    cumulativeInterest += interest;
    cumulativeFees += commitmentFee;

    periods.push({
      periodStart: cursor,
      periodEnd,
      days,
      openingDrawn: round2(openingDrawn),
      drawnInPeriod: round2(drawnInPeriod),
      closingDrawn: round2(drawn),
      averageDrawn: round2(averageDrawn),
      averageUndrawn: round2(averageUndrawn),
      interest: round2(interest),
      commitmentFee: round2(commitmentFee),
      capitalised: round2(capitalised),
      cumulativeInterest: round2(cumulativeInterest),
      cumulativeFees: round2(cumulativeFees),
    });
    cursor = periodEnd;
  }

  return {
    periods,
    totalInterest: round2(cumulativeInterest),
    totalCommitmentFees: round2(cumulativeFees),
    totalCostOfFinance: round2(cumulativeInterest + cumulativeFees),
    currency: options.currency,
    basis:
      `Interest on the time-weighted average drawn balance at ` +
      `${allInterestRate === null ? "no configured rate" : `${allInterestRate}% p.a. (base ${options.baseRatePercent ?? 0}% + margin ${options.marginPercent ?? 0}%)`}` +
      `; commitment fee on the average undrawn balance at ${feeRate === null ? "no configured rate" : `${feeRate}% p.a.`}` +
      `; ${options.convention} day count over a ${basisDays}-day year` +
      `${options.capitalise ? "; accrued interest capitalised into the drawn balance each period" : "; interest paid in cash, not capitalised"}. ` +
      `No compounding within a period and no rate curve is modelled.`,
    unavailableReason: null,
  };
}

/** Quarter-end boundaries between two dates, inclusive of the final end. */
export function quarterEnds(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  let year = start.getUTCFullYear();
  let quarter = Math.floor(start.getUTCMonth() / 3);
  for (let guard = 0; guard < 400; guard += 1) {
    const month = quarter * 3 + 3; // first month AFTER the quarter
    const boundary = new Date(Date.UTC(year, month, 0));
    if (boundary > end) break;
    const iso = boundary.toISOString().slice(0, 10);
    if (iso > from) out.push(iso);
    quarter += 1;
    if (quarter > 3) {
      quarter = 0;
      year += 1;
    }
  }
  const last = out[out.length - 1];
  if (to > from && last !== to) out.push(to);
  return out;
}
