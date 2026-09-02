/**
 * Small shared helpers for the land / resettlement / community module.
 * Everything here is either pure arithmetic or a cross-module referential
 * check; the routes themselves live in the sibling route files.
 */

import { and, eq, inArray } from "drizzle-orm";
import { entities, evidence, files, locations, scheduleTasks } from "@constructos/db";
import { badRequest } from "../../lib/errors.js";
import { todayISO } from "../field/dates.js";
import type { Db } from "../../lib/db.js";

export const round1 = (n: number): number => Math.round(n * 10) / 10;
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Whole days from today (UTC) to an ISO date; negative = already past. */
export function daysUntil(isoDate: string): number {
  return Math.round(
    (Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${todayISO()}T00:00:00Z`)) / 86_400_000,
  );
}

/** Whole days from ISO date `a` to ISO date `b` (date-only, UTC). */
export function wholeDaysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Fractional days between an ISO date (start of day, UTC) and a timestamp. */
export function daysFromDateToInstant(isoDate: string, instant: string): number {
  return (Date.parse(instant) - Date.parse(`${isoDate}T00:00:00Z`)) / 86_400_000;
}

/** Zero-filled tally over a closed value set, so charts never see holes. */
export function tallyBy<T>(rows: readonly T[], pick: (row: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = pick(row);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export function zeroFilled(
  keys: readonly string[],
  counts: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = counts[k] ?? 0;
  for (const [k, v] of Object.entries(counts)) if (!(k in out)) out[k] = v;
  return out;
}

/** Median of a numeric sample; null on an empty sample. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Percentage of `part` in `whole`, or null when the denominator is zero. */
export function percentOf(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return round1((part / whole) * 100);
}

/** Ratio of `part` in `whole` (0..1), or null when the denominator is zero. */
export function shareOf(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 10_000) / 10_000;
}

/* ------------------------------------------------------------------ */
/* Referential checks                                                  */
/* ------------------------------------------------------------------ */

/** Every evidence id must reference evidence captured in THIS project. */
export async function validateEvidence(
  db: Db,
  companyId: string,
  projectId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const unique = [...new Set(ids)];
  const rows = await db
    .select({ id: evidence.id })
    .from(evidence)
    .where(
      and(
        inArray(evidence.id, unique),
        eq(evidence.companyId, companyId),
        eq(evidence.projectId, projectId),
      ),
    );
  if (rows.length !== unique.length) {
    throw badRequest("evidenceIds must reference evidence records in this project");
  }
}

/** Every file id must reference a file in THIS project. */
export async function validateFiles(
  db: Db,
  companyId: string,
  projectId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const unique = [...new Set(ids)];
  const rows = await db
    .select({ id: files.id })
    .from(files)
    .where(
      and(inArray(files.id, unique), eq(files.companyId, companyId), eq(files.projectId, projectId)),
    );
  if (rows.length !== unique.length) {
    throw badRequest("fileIds must reference files in this project");
  }
}

/**
 * Resolve blocking schedule tasks, verifying every id belongs to this
 * project. Returns id → name/start so callers can render the dependency
 * without a second round trip (#591).
 */
export async function resolveTasks(
  db: Db,
  projectId: string,
  ids: readonly string[],
): Promise<Map<string, { id: string; name: string; startDate: string | null }>> {
  const map = new Map<string, { id: string; name: string; startDate: string | null }>();
  if (ids.length === 0) return map;
  const unique = [...new Set(ids)];
  const rows = await db
    .select({
      id: scheduleTasks.id,
      name: scheduleTasks.name,
      startDate: scheduleTasks.startDate,
      actualStart: scheduleTasks.actualStart,
      constraintDate: scheduleTasks.constraintDate,
    })
    .from(scheduleTasks)
    .where(and(inArray(scheduleTasks.id, unique), eq(scheduleTasks.projectId, projectId)));
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      name: r.name,
      // planned start is the CPM-computed date; fall back to an actual start
      // (a task already underway on un-acquired land) then to a constraint.
      startDate: r.startDate ?? r.actualStart ?? r.constraintDate ?? null,
    });
  }
  return map;
}

export async function validateTasksInProject(
  db: Db,
  projectId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const unique = [...new Set(ids)];
  const found = await resolveTasks(db, projectId, unique);
  if (found.size !== unique.length) {
    throw badRequest("blockingTaskIds must reference schedule tasks in this project");
  }
}

/** The owner entity, when named, must exist in this tenant's entity graph. */
export async function validateEntity(
  db: Db,
  companyId: string,
  entityId: string,
): Promise<void> {
  const rows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.id, entityId), eq(entities.companyId, companyId)))
    .limit(1);
  if (!rows[0]) throw badRequest("ownerEntityId does not belong to this company");
}

export async function validateLocation(
  db: Db,
  companyId: string,
  projectId: string,
  locationId: string,
): Promise<void> {
  const rows = await db
    .select({ id: locations.id })
    .from(locations)
    .where(
      and(
        eq(locations.id, locationId),
        eq(locations.companyId, companyId),
        eq(locations.projectId, projectId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw badRequest("locationId does not belong to this project");
}
