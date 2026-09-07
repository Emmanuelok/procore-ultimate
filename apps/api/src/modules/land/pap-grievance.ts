/**
 * Household ↔ grievance state coupling (#555-557, #569-574).
 *
 * `grievance_open` is a PAP status that the resettlement lifecycle cannot
 * produce: it describes something that happened in the grievance register.
 * The PAP status route therefore refuses it outright and points at "the
 * grievance register sets it" — but until this file existed nothing did, so
 * the status was documented, enumerated, refused by hand and never reachable.
 * A household under an open complaint looked identical to one that was not,
 * which is exactly the household a supervision mission is looking for.
 *
 * The coupling is deliberately reversible. A dust complaint must not erase
 * the fact that a household was compensated and resettled: the pre-grievance
 * status is stashed on the row and restored when the last open grievance
 * naming that household settles (resolved, verified or rejected). The restore
 * is EXACT — back to where the register had it — not a transition through
 * PAP_TRANSITIONS, because the household never actually left that state.
 *
 * Pure decision in `papGrievanceTransition`, so every branch is unit-tested
 * without a database; the I/O wrapper below is the thin part.
 */

import { and, eq, isNotNull, notInArray } from "drizzle-orm";
import { affectedPersons, grievances } from "@constructos/db";
import { appendLedger } from "../../lib/ledger.js";
import type { Db } from "../../lib/db.js";
import { GRIEVANCE_SETTLED_STATUSES } from "./reference.js";

export const GRIEVANCE_OPEN_STATUS = "grievance_open";

export interface PapGrievanceState {
  status: string;
  statusBeforeGrievance: string | null;
}

export interface PapGrievanceTransition {
  /** null when nothing should be written */
  next: PapGrievanceState | null;
  reason: string;
}

/**
 * Decide the household's status from (current row, number of open grievances
 * naming it).
 *
 *  · open > 0, not yet flagged  → stash the current status, flag it.
 *  · open > 0, already flagged  → nothing (idempotent; a second grievance on
 *    the same household must not re-stash `grievance_open` over the real
 *    prior status, which would lose it forever).
 *  · open = 0, flagged          → restore the stash. With no stash — a row
 *    flagged before this field existed — fall back to `registered`, the only
 *    status that asserts nothing that was not evidenced.
 *  · open = 0, not flagged      → nothing.
 */
export function papGrievanceTransition(
  current: PapGrievanceState,
  openGrievances: number,
): PapGrievanceTransition {
  const flagged = current.status === GRIEVANCE_OPEN_STATUS;
  if (openGrievances > 0) {
    if (flagged) return { next: null, reason: "already flagged" };
    return {
      next: { status: GRIEVANCE_OPEN_STATUS, statusBeforeGrievance: current.status },
      reason: `${openGrievances} open grievance${openGrievances === 1 ? "" : "s"} name this household`,
    };
  }
  if (!flagged) return { next: null, reason: "no open grievance and not flagged" };
  const restored = current.statusBeforeGrievance ?? "registered";
  return {
    next: { status: restored, statusBeforeGrievance: null },
    reason:
      current.statusBeforeGrievance === null
        ? "every grievance settled; no prior status was recorded, so the household returns to registered"
        : `every grievance settled; the household returns to ${restored}`,
  };
}

/**
 * The household's SUBSTANTIVE lifecycle status — what the resettlement
 * register actually knows about it, with the grievance overlay removed.
 *
 * This matters far more than it looks. `grievance_open` sits in the same
 * column as `resettled` and `livelihood_restored`, so every rule that reads
 * the column as a lifecycle fact would change its answer the moment somebody
 * logged a dust complaint: the PS5 "resettled before compensation" detector
 * would stop firing on a household that was moved without being paid, and the
 * "livelihood not restored" detector would start firing on a household whose
 * livelihood WAS restored. A complaint must never be able to clear or invent
 * a conformance finding. Compliance logic reads this; the register still
 * shows the flag.
 */
export function effectivePapStatus(pap: PapGrievanceState): string {
  return pap.status === GRIEVANCE_OPEN_STATUS
    ? (pap.statusBeforeGrievance ?? GRIEVANCE_OPEN_STATUS)
    : pap.status;
}

/**
 * Recompute and persist the flag for one household. Idempotent, safe to call
 * from every grievance write path AND from the scheduled sweep, and a no-op
 * when nothing changes (no write, no ledger entry).
 *
 * `actorId` is the person whose act caused it, or null when the scheduler is
 * healing drift — the ledger should never attribute a system correction to
 * whoever happened to be looking.
 */
export async function syncPapGrievanceStatus(
  db: Db,
  args: {
    companyId: string;
    projectId: string;
    papId: string;
    actorId: string | null;
    /** the grievance whose change triggered this, for the ledger trail */
    grievanceId?: string;
  },
): Promise<PapGrievanceState | null> {
  const [pap] = await db
    .select({
      id: affectedPersons.id,
      reference: affectedPersons.reference,
      status: affectedPersons.status,
      statusBeforeGrievance: affectedPersons.statusBeforeGrievance,
    })
    .from(affectedPersons)
    .where(
      and(
        eq(affectedPersons.id, args.papId),
        eq(affectedPersons.companyId, args.companyId),
        eq(affectedPersons.projectId, args.projectId),
      ),
    )
    .limit(1);
  // A grievance may name a household that was since deleted, or none at all.
  if (!pap) return null;

  const open = await db
    .select({ id: grievances.id })
    .from(grievances)
    .where(
      and(
        eq(grievances.companyId, args.companyId),
        eq(grievances.projectId, args.projectId),
        eq(grievances.papId, args.papId),
        notInArray(grievances.status, [...GRIEVANCE_SETTLED_STATUSES]),
      ),
    );

  const decision = papGrievanceTransition(
    { status: pap.status, statusBeforeGrievance: pap.statusBeforeGrievance },
    open.length,
  );
  if (!decision.next) return null;

  await db
    .update(affectedPersons)
    .set({
      status: decision.next.status,
      statusBeforeGrievance: decision.next.statusBeforeGrievance,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(affectedPersons.id, pap.id));

  await appendLedger(db, {
    companyId: args.companyId,
    actorId: args.actorId,
    action: "state_change",
    objectType: "affected_person",
    objectId: pap.id,
    projectId: args.projectId,
    payload: {
      event: "grievance_status_sync",
      reference: pap.reference,
      from: pap.status,
      to: decision.next.status,
      openGrievances: open.length,
      basis: decision.reason,
      grievanceId: args.grievanceId ?? null,
    },
    storePayload: true,
  });
  return decision.next;
}

/**
 * Heal every household in a project whose flag disagrees with its grievances.
 * Runs in the scheduled land detector pass as the SYSTEM actor: a write path
 * that failed halfway, a grievance deleted directly, or a row created before
 * the coupling existed all leave drift, and drift in this particular flag is
 * a household that looks settled while it is under complaint.
 */
export async function sweepPapGrievanceStatus(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<{ changed: number }> {
  // Bounded by design: only households that are either flagged or named by a
  // grievance can possibly need a change.
  const named = await db
    .selectDistinct({ papId: grievances.papId })
    .from(grievances)
    .where(
      and(
        eq(grievances.companyId, companyId),
        eq(grievances.projectId, projectId),
        isNotNull(grievances.papId),
      ),
    );
  const flagged = await db
    .select({ id: affectedPersons.id })
    .from(affectedPersons)
    .where(
      and(
        eq(affectedPersons.companyId, companyId),
        eq(affectedPersons.projectId, projectId),
        eq(affectedPersons.status, GRIEVANCE_OPEN_STATUS),
      ),
    );
  const ids = new Set<string>();
  for (const r of named) if (r.papId) ids.add(r.papId);
  for (const r of flagged) ids.add(r.id);

  let changed = 0;
  for (const papId of [...ids].sort()) {
    const res = await syncPapGrievanceStatus(db, {
      companyId,
      projectId,
      papId,
      actorId: null,
    });
    if (res) changed += 1;
  }
  return { changed };
}
