/**
 * Calendar arithmetic for the correspondence module. ISO dates only
 * (YYYY-MM-DD), UTC, no timezone drift: a response deadline that moves by a
 * day because the server is in Auckland is a defect, not a rounding error.
 */

const MS_PER_DAY = 86_400_000;

export function toUtcMs(date: string): number {
  return Date.parse(date.length > 10 ? date : `${date}T00:00:00.000Z`);
}

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(toUtcMs(value));
}

export function addDaysISO(date: string, days: number): string {
  const ms = toUtcMs(date);
  if (Number.isNaN(ms)) return date;
  return new Date(ms + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = toUtcMs(from);
  const b = toUtcMs(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / MS_PER_DAY);
}

/** Positive when `date` is in the past relative to `today`. */
export function daysOverdue(date: string | null, today: string): number | null {
  const d = daysBetween(date, today);
  return d === null ? null : d;
}

/**
 * Add working days (Mon–Fri), which is what a contract that says "within 5
 * working days" means. Public holidays are jurisdictional and this module
 * does not hold a calendar, so they are deliberately not modelled — the
 * caller records the basis alongside the date.
 */
export function addWorkingDaysISO(date: string, days: number): string {
  if (days <= 0) return date;
  let cursor = date;
  let remaining = days;
  while (remaining > 0) {
    cursor = addDaysISO(cursor, 1);
    const dow = new Date(toUtcMs(cursor)).getUTCDay();
    if (dow !== 0 && dow !== 6) remaining -= 1;
  }
  return cursor;
}
