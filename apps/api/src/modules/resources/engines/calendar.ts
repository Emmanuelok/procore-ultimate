/**
 * WORKING-TIME ARITHMETIC — pure, no I/O.
 *
 * Every figure in this module is bucketed by WEEK and spread by WORKING DAY,
 * so the two conversions have to live in one place. A resource histogram that
 * spreads 400 hours over calendar days puts 28% of a crew's effort on
 * weekends nobody worked, and the peak week it then reports is the wrong week.
 *
 * The work pattern mirrors `schedule_calendars` (schedule.ts): `workdays` is
 * a 7-slot array indexed by JS `getUTCDay()` — index 0 is Sunday — holding 1
 * for a working day, plus explicit holiday and exception date lists. Dates
 * are ISO `YYYY-MM-DD` and every computation is in UTC: a local-time date
 * boundary shifts a Sunday's hours into the previous week for half the world.
 */

/** Hard ceiling on any enumerated range, so a typo cannot allocate forever. */
export const MAX_RANGE_DAYS = 3660; // ~10 years

export interface WorkPattern {
  /** 7 slots indexed by getUTCDay(); 1 = working day */
  workdays: number[];
  /** ISO dates that are non-working regardless of weekday */
  holidays: string[];
  /** ISO dates that ARE working despite the weekday pattern */
  exceptions: string[];
  hoursPerDay: number;
}

/** Monday–Friday, 8 hours. Named so a caller can see it is a default. */
export const DEFAULT_WORK_PATTERN: WorkPattern = {
  workdays: [0, 1, 1, 1, 1, 1, 0],
  holidays: [],
  exceptions: [],
  hoursPerDay: 8,
};

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  return ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole calendar days from `a` to `b` (b − a). */
export function daysBetween(a: string, b: string): number {
  const start = Date.parse(`${a}T00:00:00Z`);
  const end = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The first day of the week containing `iso`. `weekStartsOn` is 0 = Sunday …
 * 6 = Saturday, and it is a project setting rather than a constant because a
 * Sunday-start week and a Monday-start week put a Saturday's hours in
 * different weeks — which changes which week the histogram calls the peak.
 */
export function weekStartOf(iso: string, weekStartsOn = 1): string {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  const back = (dow - weekStartsOn + 7) % 7;
  return addDays(iso, -back);
}

/** Every week start from the week containing `from` to the week containing `to`. */
export function enumerateWeeks(from: string, to: string, weekStartsOn = 1): string[] {
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) return [];
  const first = weekStartOf(from, weekStartsOn);
  const last = weekStartOf(to, weekStartsOn);
  const out: string[] = [];
  let cursor = first;
  let guard = 0;
  while (cursor <= last && guard <= MAX_RANGE_DAYS / 7) {
    out.push(cursor);
    cursor = addDays(cursor, 7);
    guard += 1;
  }
  return out;
}

export function isWorkday(iso: string, pattern: WorkPattern): boolean {
  if (pattern.exceptions.includes(iso)) return true;
  if (pattern.holidays.includes(iso)) return false;
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return (pattern.workdays[dow] ?? 0) === 1;
}

/**
 * Working days in the INCLUSIVE range [from, to]. Returns 0 for an inverted
 * range rather than a negative count: a negative day count silently flips the
 * sign of every hour spread through it.
 */
export function workingDaysBetween(from: string, to: string, pattern: WorkPattern): number {
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) return 0;
  const span = daysBetween(from, to);
  if (span > MAX_RANGE_DAYS) return 0;
  let count = 0;
  for (let i = 0; i <= span; i += 1) {
    if (isWorkday(addDays(from, i), pattern)) count += 1;
  }
  return count;
}

/** Calendar days in the inclusive overlap of two ranges; 0 when they miss. */
export function overlapDays(
  aFrom: string,
  aTo: string,
  bFrom: string,
  bTo: string,
): number {
  const start = aFrom > bFrom ? aFrom : bFrom;
  const end = aTo < bTo ? aTo : bTo;
  if (end < start) return 0;
  return daysBetween(start, end) + 1;
}

/** The inclusive overlap window of two ranges, or null when they miss. */
export function overlapWindow(
  aFrom: string,
  aTo: string,
  bFrom: string,
  bTo: string,
): { from: string; to: string } | null {
  const from = aFrom > bFrom ? aFrom : bFrom;
  const to = aTo < bTo ? aTo : bTo;
  if (to < from) return null;
  return { from, to };
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;
export const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Working days of [from, to] that fall inside the week beginning `weekStart`.
 * The primitive the demand spread is built on.
 */
export function workingDaysInWeek(
  weekStart: string,
  from: string,
  to: string,
  pattern: WorkPattern,
): number {
  const window = overlapWindow(weekStart, addDays(weekStart, 6), from, to);
  if (!window) return 0;
  return workingDaysBetween(window.from, window.to, pattern);
}
