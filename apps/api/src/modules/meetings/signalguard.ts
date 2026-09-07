/**
 * Signal idempotency for the meetings / learning / insurance detectors.
 *
 * WHAT THIS FIXES
 *
 * Every sweep in these three modules deduped its findings with an IN-MEMORY
 * set: load the fingerprints already in the register, compute this run's
 * candidates, insert the ones not in the set. Between the load and the insert
 * there is no lock and `signals` carries no unique constraint, so two runners
 * that overlap — an operator pressing "sweep now" while the scheduler tick is
 * mid-flight, or two API replicas booting together — both read "not raised
 * yet" and both insert. The duplicate is not cosmetic: signal counts feed
 * project health, the attention feed and every precision figure derived from
 * the register, and a finding that appears twice is indistinguishable from a
 * condition that occurred twice.
 *
 * `lesson_triggers` was given a real database guarantee (a unique index plus
 * `onConflictDoNothing`). `signals` could not be: its schema belongs to
 * another work package, so this module cannot add the unique index the same
 * fix would need. What it CAN do is make the check and the insert atomic:
 *
 *   • one transaction per raise, holding
 *     `pg_advisory_xact_lock(hashtext('signal:<company>:<detector>'))`, so two
 *     runners of the same detector serialise instead of racing;
 *   • the existence check is re-done INSIDE that transaction against
 *     `signals.fingerprint` (which is indexed on company+detector+fingerprint),
 *     so the second runner sees the first one's row and stands down.
 *
 * A repeat observation bumps `lastSeenAt` and `occurrences` rather than
 * inserting a second row, which is also what makes "is this still true?"
 * answerable without pretending it is a new discovery.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it does not close signals whose condition
 * has cleared. Each sweep owns that decision, because only the sweep knows
 * whether it looked at the whole population or one project's slice.
 *
 * If `signals` later gains `uniqueIndex(companyId, detector, fingerprint)`,
 * nothing here changes except that the lock becomes a formality.
 */
import { and, eq, sql } from "drizzle-orm";
import { signals } from "@constructos/db";
import { newId } from "../../lib/ids.js";
import type { Db } from "../../lib/db.js";

/** Everything a detector supplies for one finding. `fingerprint` is required. */
export type SignalInsert = Omit<typeof signals.$inferInsert, "id"> & { fingerprint: string };

export interface RaiseOutcome {
  /** true when this call created the row, false when one already existed */
  raised: boolean;
  signalId: string;
}

/**
 * Insert one signal unless its fingerprint is already in the register.
 *
 * Serialised per (company, detector) so concurrent sweeps cannot both raise
 * the same finding. Returns `raised: false` for a repeat, having refreshed
 * `lastSeenAt` and incremented `occurrences` on the row that already exists.
 */
export async function raiseSignalOnce(db: Db, values: SignalInsert): Promise<RaiseOutcome> {
  const lockKey = `signal:${values.companyId}:${values.detector}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const existing = await tx
      .select({ id: signals.id })
      .from(signals)
      .where(
        and(
          eq(signals.companyId, values.companyId),
          eq(signals.detector, values.detector),
          eq(signals.fingerprint, values.fingerprint),
        ),
      )
      .limit(1);
    const found = existing[0];
    if (found) {
      await tx
        .update(signals)
        .set({
          lastSeenAt: new Date().toISOString(),
          occurrences: sql`${signals.occurrences} + 1`,
        })
        .where(eq(signals.id, found.id));
      return { raised: false, signalId: found.id };
    }
    const id = newId("sig");
    const now = new Date().toISOString();
    await tx.insert(signals).values({
      ...values,
      id,
      firstSeenAt: values.firstSeenAt ?? now,
      lastSeenAt: values.lastSeenAt ?? now,
    });
    return { raised: true, signalId: id };
  });
}
