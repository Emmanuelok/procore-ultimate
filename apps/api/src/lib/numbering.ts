import { and, eq, sql } from "drizzle-orm";
import { recordCounters } from "@constructos/db";
import { newId } from "./ids.js";
import type { Db } from "./db.js";

/**
 * Atomically allocate the next record number for (project, recordType)
 * (RFI-0042 style auto-increment, spec Vol I #72).
 */
export async function nextRecordNumber(
  db: Db,
  projectId: string,
  recordType: string,
): Promise<number> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(recordCounters)
      .where(
        and(eq(recordCounters.projectId, projectId), eq(recordCounters.recordType, recordType)),
      )
      .limit(1);
    if (!existing[0]) {
      await tx.insert(recordCounters).values({
        id: newId("ctr"),
        projectId,
        recordType,
        nextNumber: 2,
      });
      return 1;
    }
    const allocated = existing[0].nextNumber;
    await tx
      .update(recordCounters)
      .set({ nextNumber: sql`${recordCounters.nextNumber} + 1` })
      .where(eq(recordCounters.id, existing[0].id));
    return allocated;
  });
}
