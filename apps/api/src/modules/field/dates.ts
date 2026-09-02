import { z } from "zod";

/** ISO calendar date (YYYY-MM-DD) — the wire format for all date-only columns. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Date arithmetic in UTC on ISO date strings (negative days subtract). */
export function addDaysISO(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days between two ISO timestamps (b - a), fractional. */
export function daysBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000;
}

/** Monday-Friday check for an ISO date. */
export function isBusinessDay(isoDate: string): boolean {
  const dow = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
}
