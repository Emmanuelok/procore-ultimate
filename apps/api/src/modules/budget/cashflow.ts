/**
 * CASH-FLOW FORECAST — the S-curve by period, as pure arithmetic.
 *
 * Four curves share one period axis:
 *   planned    the revised budget spread over each line's schedule window
 *              (or the project window when no line window exists)
 *   committed  commitment schedules of values spread over each commitment's
 *              start → estimated completion
 *   actual     cost incurred by the date it was billed (subcontractor
 *              invoices) and owner billings by application date
 *   forecast   actual to date, then the forecast-to-complete spread over the
 *              months left in the window
 *
 * Spreading is linear by days-in-month — the honest default when no
 * resource-loaded curve exists. Every input row states its own window; rows
 * with no window are reported in `unphased`, never silently pushed into the
 * first or last month.
 *
 * Money is never summed across currencies: the caller filters to one
 * currency before spreading, and this file only ever sees one.
 */
import { round2 } from "./calc.js";

export interface Phaseable {
  id: string;
  reference: string;
  amount: number;
  /** ISO dates; null = cannot be phased */
  start: string | null;
  finish: string | null;
}

export interface DatedAmount {
  id: string;
  reference: string;
  amount: number;
  /** ISO date the money was recognised */
  date: string | null;
}

export interface CashFlowPeriod {
  /** YYYY-MM */
  month: string;
  planned: number;
  committed: number;
  actual: number;
  forecast: number;
  cumulativePlanned: number;
  cumulativeCommitted: number;
  cumulativeActual: number;
  cumulativeForecast: number;
}

export interface CashFlow {
  currency: string;
  from: string;
  to: string;
  asOf: string;
  periods: CashFlowPeriod[];
  totals: { planned: number; committed: number; actual: number; forecast: number };
  /** rows that carried no usable window/date and were left out, with the amount */
  unphased: { planned: Array<{ id: string; reference: string; amount: number }>; committed: Array<{ id: string; reference: string; amount: number }>; actual: Array<{ id: string; reference: string; amount: number }> };
  reasons: string[];
}

const DAY = 86_400_000;

const parseIso = (d: string | null | undefined): number | null => {
  if (!d) return null;
  const ms = Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
};

export const monthKey = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

const monthStart = (key: string): number => Date.parse(`${key}-01T00:00:00Z`);
const nextMonth = (key: string): string => {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/** Every month key from `from` to `to` inclusive. */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from.slice(0, 7);
  const end = to.slice(0, 7);
  let guard = 0;
  while (cur <= end && guard < 600) {
    out.push(cur);
    cur = nextMonth(cur);
    guard += 1;
  }
  return out;
}

/**
 * Spread an amount linearly by day across [start, finish]. A same-day window
 * lands entirely in that month. The last month absorbs rounding so the
 * spread sums to the amount exactly.
 */
export function spreadLinear(amount: number, start: string, finish: string): Map<string, number> {
  const s = parseIso(start);
  const f = parseIso(finish);
  const out = new Map<string, number>();
  if (s === null || f === null) return out;
  const lo = Math.min(s, f);
  const hi = Math.max(s, f);
  const totalDays = Math.max(1, Math.round((hi - lo) / DAY) + 1);
  let allocated = 0;
  const months = monthRange(monthKey(lo), monthKey(hi));
  for (const [i, key] of months.entries()) {
    const mStart = monthStart(key);
    const mEnd = monthStart(nextMonth(key)) - DAY;
    const overlapStart = Math.max(lo, mStart);
    const overlapEnd = Math.min(hi, mEnd);
    const days = Math.max(0, Math.round((overlapEnd - overlapStart) / DAY) + 1);
    const share = i === months.length - 1 ? round2(amount - allocated) : round2((amount * days) / totalDays);
    allocated = round2(allocated + share);
    out.set(key, share);
  }
  return out;
}

export function buildCashFlow(input: {
  currency: string;
  asOf: string;
  /** the window when a row has none of its own */
  defaultWindow: { start: string | null; finish: string | null };
  planned: readonly Phaseable[];
  committed: readonly Phaseable[];
  actual: readonly DatedAmount[];
  /** forecast to complete, spread from asOf to the end of the window */
  forecastToComplete: number;
  from?: string;
  to?: string;
}): CashFlow {
  const reasons: string[] = [];
  const buckets = { planned: new Map<string, number>(), committed: new Map<string, number>(), actual: new Map<string, number>(), forecast: new Map<string, number>() };
  const unphased: CashFlow["unphased"] = { planned: [], committed: [], actual: [] };
  const add = (m: Map<string, number>, key: string, v: number): void => {
    m.set(key, round2((m.get(key) ?? 0) + v));
  };

  const phase = (rows: readonly Phaseable[], target: Map<string, number>, bucket: Array<{ id: string; reference: string; amount: number }>): void => {
    for (const row of rows) {
      const start = row.start ?? input.defaultWindow.start;
      const finish = row.finish ?? input.defaultWindow.finish;
      if (!start || !finish || row.amount === 0) {
        if (row.amount !== 0) bucket.push({ id: row.id, reference: row.reference, amount: round2(row.amount) });
        continue;
      }
      for (const [k, v] of spreadLinear(row.amount, start, finish)) add(target, k, v);
    }
  };
  phase(input.planned, buckets.planned, unphased.planned);
  phase(input.committed, buckets.committed, unphased.committed);
  for (const row of input.actual) {
    const ms = parseIso(row.date);
    if (ms === null) {
      if (row.amount !== 0) unphased.actual.push({ id: row.id, reference: row.reference, amount: round2(row.amount) });
      continue;
    }
    add(buckets.actual, monthKey(ms), row.amount);
  }

  // forecast = actual to date, then FTC spread over the remaining window
  const asOfMs = parseIso(input.asOf) ?? Date.now();
  const asOfKey = monthKey(asOfMs);
  for (const [k, v] of buckets.actual) if (k <= asOfKey) add(buckets.forecast, k, v);
  const finish = input.defaultWindow.finish ?? null;
  if (input.forecastToComplete > 0) {
    const finishMs = parseIso(finish);
    const end = finishMs !== null && finishMs > asOfMs ? finish! : input.asOf;
    if (end === input.asOf) {
      reasons.push("The project window has ended (or is unknown), so the forecast to complete is placed in the current month rather than spread.");
    }
    for (const [k, v] of spreadLinear(input.forecastToComplete, input.asOf, end)) add(buckets.forecast, k, v);
  }

  const keys = new Set<string>();
  for (const m of Object.values(buckets)) for (const k of m.keys()) keys.add(k);
  if (input.from) keys.add(input.from.slice(0, 7));
  if (input.to) keys.add(input.to.slice(0, 7));
  const sorted = [...keys].sort();
  const from = input.from?.slice(0, 7) ?? sorted[0] ?? asOfKey;
  const to = input.to?.slice(0, 7) ?? sorted[sorted.length - 1] ?? asOfKey;
  const months = monthRange(from, to);
  let cp = 0;
  let cc = 0;
  let ca = 0;
  let cf = 0;
  const periods: CashFlowPeriod[] = months.map((month) => {
    const planned = buckets.planned.get(month) ?? 0;
    const committed = buckets.committed.get(month) ?? 0;
    const actual = buckets.actual.get(month) ?? 0;
    const forecast = buckets.forecast.get(month) ?? 0;
    cp = round2(cp + planned);
    cc = round2(cc + committed);
    ca = round2(ca + actual);
    cf = round2(cf + forecast);
    return { month, planned, committed, actual, forecast, cumulativePlanned: cp, cumulativeCommitted: cc, cumulativeActual: ca, cumulativeForecast: cf };
  });
  const sum = (m: Map<string, number>): number => round2([...m.values()].reduce((s, v) => s + v, 0));
  if (unphased.planned.length > 0) reasons.push(`${unphased.planned.length} planned row(s) carry no schedule window and are excluded from the planned curve.`);
  if (unphased.committed.length > 0) reasons.push(`${unphased.committed.length} commitment(s) carry no start/completion dates and are excluded from the committed curve.`);
  if (unphased.actual.length > 0) reasons.push(`${unphased.actual.length} cost row(s) carry no billing date and are excluded from the actual curve.`);
  return {
    currency: input.currency,
    from,
    to,
    asOf: input.asOf,
    periods,
    totals: { planned: sum(buckets.planned), committed: sum(buckets.committed), actual: sum(buckets.actual), forecast: sum(buckets.forecast) },
    unphased,
    reasons,
  };
}
