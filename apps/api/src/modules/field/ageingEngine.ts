/**
 * Ageing and escalation arithmetic shared by every field register
 * (spec #321 RFI ageing, #347 submittal in-court ageing, #411 punch ageing,
 * #395 missing daily logs). Pure: dates in, buckets and rungs out.
 *
 * Deliberately does NOT decide who gets notified — that is the sweep's job
 * (escalations.ts), which owns the persistence that makes it idempotent.
 */
import { FIELD_AGEING_BUCKETS, type FieldAgeingBucket } from "@constructos/shared";

export type AgeingBuckets = Record<FieldAgeingBucket, number>;

export function emptyBuckets(): AgeingBuckets {
  return { "0-7": 0, "8-14": 0, "15-30": 0, "30+": 0 };
}

/** Whole days → the register bucket it belongs to. Negative ages count as 0-7. */
export function ageingBucket(days: number): FieldAgeingBucket {
  if (days <= 7) return "0-7";
  if (days <= 14) return "8-14";
  if (days <= 30) return "15-30";
  return "30+";
}

/** Whole calendar days from an ISO date or timestamp to `today` (ISO date). */
export function ageInDays(fromIso: string | null | undefined, todayIso: string): number {
  if (!fromIso) return 0;
  const from = Date.parse(fromIso.length > 10 ? fromIso : `${fromIso}T00:00:00Z`);
  const to = Date.parse(`${todayIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.floor((to - from) / 86_400_000));
}

/** Days past a due date; 0 when not yet due or no due date. */
export function daysOverdue(dueDateIso: string | null | undefined, todayIso: string): number {
  if (!dueDateIso) return 0;
  if (dueDateIso >= todayIso) return 0;
  return ageInDays(dueDateIso, todayIso);
}

export interface BucketisedGroup {
  key: string;
  total: number;
  buckets: AgeingBuckets;
}

export interface Bucketised {
  total: number;
  buckets: AgeingBuckets;
  groups: BucketisedGroup[];
}

/**
 * Bucket a list by age and, within that, by a grouping key (assignee,
 * vendor, priority…). Groups come back sorted by total descending so the
 * heaviest backlog is first.
 */
export function bucketise<T>(
  items: readonly T[],
  ageOf: (item: T) => number,
  groupOf: (item: T) => string,
): Bucketised {
  const buckets = emptyBuckets();
  const groups = new Map<string, BucketisedGroup>();
  for (const item of items) {
    const bucket = ageingBucket(ageOf(item));
    buckets[bucket] += 1;
    const key = groupOf(item);
    let g = groups.get(key);
    if (!g) {
      g = { key, total: 0, buckets: emptyBuckets() };
      groups.set(key, g);
    }
    g.total += 1;
    g.buckets[bucket] += 1;
  }
  return {
    total: items.length,
    buckets,
    groups: [...groups.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key)),
  };
}

/** The list of bucket labels in display order — exported for UI parity. */
export const AGEING_BUCKET_ORDER = FIELD_AGEING_BUCKETS;

/**
 * Escalation rung for a record that is `daysOverdue` late, on a ladder
 * with `stepDays` between rungs: 0 = not yet overdue, 1 = day it turned
 * overdue (responsible person), 2 = after `stepDays` (project managers),
 * 3 = after 2×`stepDays` (integrity signal).
 */
export function escalationLevelFor(overdueDays: number, stepDays: number): 0 | 1 | 2 | 3 {
  if (overdueDays <= 0) return 0;
  const step = Math.max(1, stepDays);
  if (overdueDays >= 2 * step) return 3;
  if (overdueDays >= step) return 2;
  return 1;
}

/** Rounds to one decimal place; null for an empty series. */
export function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return Math.round(value * 10) / 10;
}
