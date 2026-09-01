import { sql } from "drizzle-orm";
import { recordCounters } from "@constructos/db";
import { newId } from "./ids.js";
import type { Db } from "./db.js";

/**
 * Atomically allocate the next record number for (project, recordType)
 * (RFI-0042 style auto-increment, spec Vol I #72).
 *
 * One statement, not read-then-update: an INSERT … ON CONFLICT DO UPDATE on
 * the (project, record_type) unique index is atomic per row in Postgres, so
 * two concurrent creates can never be handed the same number and never race
 * into a unique-violation 500 — the failure mode the previous transaction
 * (which read the counter, then updated it) had under ordinary concurrent use.
 * The returned value is the counter BEFORE the increment.
 */
export async function nextRecordNumber(
  db: Db,
  projectId: string,
  recordType: string,
): Promise<number> {
  const rows = await db
    .insert(recordCounters)
    .values({ id: newId("ctr"), projectId, recordType, nextNumber: 2 })
    .onConflictDoUpdate({
      target: [recordCounters.projectId, recordCounters.recordType],
      set: { nextNumber: sql`${recordCounters.nextNumber} + 1` },
    })
    .returning({ nextNumber: recordCounters.nextNumber });
  const next = rows[0]?.nextNumber;
  if (typeof next !== "number") {
    throw new Error(`Record counter allocation failed for ${projectId}/${recordType}`);
  }
  return next - 1;
}
