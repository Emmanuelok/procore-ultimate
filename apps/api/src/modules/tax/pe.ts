import type { PeExposureStatus } from "@constructos/shared";
import { addDaysISO } from "../field/dates.js";

/**
 * Permanent-establishment day-count engine — spec Vol II Domain Q #806
 * (PE risk monitoring by day count) and #807 (expatriate day-count tracking).
 *
 * Presence is a set of inclusive date ranges. The engine merges overlaps so
 * a day is never counted twice, counts the days that fall inside a rolling
 * window ending on `asOf`, classifies the exposure against a threshold and
 * projects — at the observed run-rate — when the threshold would be crossed.
 *
 * Deliberate simplification: run-rate projection is linear over the days
 * elapsed since the first presence inside the window (minimum 30 days of
 * history), and is null when there is no history to project from. It is a
 * warning device, not a forecast.
 */

export interface PresenceRange {
  startDate: string; // ISO, inclusive
  endDate: string; // ISO, inclusive
}

export interface PresenceSummary {
  daysInWindow: number;
  daysTotal: number;
  firstPresenceDate: string | null;
  lastPresenceDate: string | null;
  windowStart: string | null;
  windowEnd: string;
}

const MS_PER_DAY = 86_400_000;

function toMs(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

/** Inclusive day count of a range; 0 for an inverted range. */
export function daysInclusive(startDate: string, endDate: string): number {
  const a = toMs(startDate);
  const b = toMs(endDate);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0;
  return Math.round((b - a) / MS_PER_DAY) + 1;
}

/** Merge overlapping / adjacent inclusive ranges into disjoint ranges. */
export function mergeRanges(ranges: PresenceRange[]): PresenceRange[] {
  const sorted = ranges
    .filter((r) => daysInclusive(r.startDate, r.endDate) > 0)
    .map((r) => ({ startDate: r.startDate, endDate: r.endDate }))
    .sort((x, y) => (x.startDate < y.startDate ? -1 : x.startDate > y.startDate ? 1 : 0));
  const out: PresenceRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && toMs(r.startDate) <= toMs(last.endDate) + MS_PER_DAY) {
      if (r.endDate > last.endDate) last.endDate = r.endDate;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** Months back from an ISO date, clamped to the month's last day. */
export function subtractMonthsISO(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

/**
 * Count presence days. `windowMonths` 0 means the whole history (a
 * construction-site PE test runs over the life of the site, not a rolling
 * year); otherwise the window is (asOf − windowMonths, asOf], both ends
 * inclusive of the day after the subtracted date.
 */
export function summarisePresence(
  ranges: PresenceRange[],
  asOf: string,
  windowMonths: number,
): PresenceSummary {
  const merged = mergeRanges(ranges);
  const windowStart = windowMonths > 0 ? addDaysISO(subtractMonthsISO(asOf, windowMonths), 1) : null;
  let daysTotal = 0;
  let daysInWindow = 0;
  for (const r of merged) {
    daysTotal += daysInclusive(r.startDate, r.endDate);
    const s = windowStart && r.startDate < windowStart ? windowStart : r.startDate;
    const e = r.endDate > asOf ? asOf : r.endDate;
    daysInWindow += daysInclusive(s, e);
  }
  return {
    daysInWindow,
    daysTotal,
    firstPresenceDate: merged[0]?.startDate ?? null,
    lastPresenceDate: merged.length > 0 ? merged[merged.length - 1]!.endDate : null,
    windowStart,
    windowEnd: asOf,
  };
}

/**
 * Status against the threshold. Human dispositions (`mitigated`, `closed`)
 * are sticky: the engine reports the numbers but does not overrule the
 * person who recorded the mitigation — except that a mitigated exposure
 * which actually breaches is surfaced as breached again, because a
 * mitigation that did not work is exactly what the register must show.
 */
export function classifyExposure(
  daysInWindow: number,
  thresholdDays: number,
  warnFraction: number,
  current: PeExposureStatus,
): PeExposureStatus {
  if (current === "closed") return "closed";
  if (daysInWindow >= thresholdDays) return "breached";
  if (current === "mitigated") return "mitigated";
  if (thresholdDays > 0 && daysInWindow >= Math.ceil(thresholdDays * warnFraction)) return "approaching";
  return "monitoring";
}

/**
 * Projected breach date at the observed run-rate inside the window. Null
 * when already breached, when there is under 30 days of history, or when
 * the run-rate is zero.
 */
export function projectBreachDate(
  summary: PresenceSummary,
  thresholdDays: number,
  asOf: string,
): string | null {
  if (summary.daysInWindow >= thresholdDays) return null;
  if (!summary.firstPresenceDate) return null;
  const historyStart =
    summary.windowStart && summary.firstPresenceDate < summary.windowStart
      ? summary.windowStart
      : summary.firstPresenceDate;
  const elapsed = daysInclusive(historyStart, asOf);
  if (elapsed < 30 || summary.daysInWindow <= 0) return null;
  const rate = summary.daysInWindow / elapsed; // presence days per calendar day
  if (rate <= 0) return null;
  const remaining = thresholdDays - summary.daysInWindow;
  const calendarDays = Math.ceil(remaining / rate);
  return addDaysISO(asOf, calendarDays);
}
