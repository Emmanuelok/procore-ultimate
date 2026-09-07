/**
 * Safeguards detector plumbing — shared by the three safeguards modules
 * (land, ESG, jurisdiction). It lives under `land/` because that is where the
 * first detector family was written; nothing here is land-specific.
 *
 * WHAT THIS FIXES
 *
 * Every safeguards detector used to run lazily on a read: read the existing
 * signals, compute, insert. With no lock and no unique key, two parallel
 * requests from the same page (the workspaces fire summary + list together)
 * both saw "no signal yet" and both inserted one, plus two ledger rows. On a
 * product whose deliverable is a trustworthy integrity record, duplicated
 * findings are not cosmetic: they inflate every downstream count and they
 * make a read-only assurance grant the ledger actor for a write.
 *
 * The replacement has three parts:
 *
 *  1. `withDetectorLock` — every detector run happens inside one transaction
 *     holding `pg_advisory_xact_lock(hashtext(company|project|detector))`, so
 *     two runners serialise instead of racing.
 *  2. `raiseSignalOnce` — the finding's identity is a deterministic
 *     fingerprint (`detector:key`), checked inside that transaction. Re-
 *     running over unchanged data returns `raised: false` and appends no
 *     ledger entry.
 *  3. `reconcileSignals` — a condition that has cleared (parcel acquired,
 *     permit granted, grievance closed, budget target revised upward) closes
 *     its own signal with `autoClosedAt` set, so the register stops being a
 *     graveyard nobody reads.
 *
 * Detectors run as the SYSTEM actor (`actorId: null`), because the person who
 * happened to open a page did not make the finding.
 *
 * The lock and the fingerprint are also what make it safe for a REGISTER READ
 * to be a second trigger of the same sweep the scheduler runs (the grievance,
 * land schedule-risk and permit list reads do this, scoped to their project):
 * the two triggers claim each finding once, and a deployment whose scheduler
 * is off is still policed.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { signals } from "@constructos/db";
import type { SafeguardDetector } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import type { Db } from "../../lib/db.js";

/** Dispositions in which a signal is still an open finding. */
export const OPEN_DISPOSITIONS = ["new", "under_review", "confirmed", "escalated"] as const;

export type SignalSeverity = "critical" | "high" | "medium" | "low" | "info";

const nowIso = (): string => new Date().toISOString();

/** `detector:key` — stable across runs, unique per finding. */
export const fingerprintFor = (detector: string, key: string): string => `${detector}:${key}`;

/**
 * Run `fn` inside a transaction that holds a per-(company, project, detector)
 * advisory lock. Under PGlite there is one connection, so the lock is a
 * formality; under Postgres it is what stops two API replicas (or two
 * parallel requests) from both raising the same finding.
 */
export async function withDetectorLock<T>(
  db: Db,
  companyId: string,
  projectId: string | null,
  detector: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`safeguards:${companyId}:${projectId ?? "-"}:${detector}`}))`,
    );
    return fn(tx as unknown as Db);
  });
}

export interface RaiseSignalArgs {
  companyId: string;
  projectId: string | null;
  detector: SafeguardDetector;
  /** deterministic identity of the FINDING, not of the run that produced it */
  key: string;
  severity: SignalSeverity;
  confidence: number;
  title: string;
  explanation: string;
  subjectType?: string;
  subjectId?: string;
  evidenceRefs?: Record<string, unknown>;
  /** ledger object the finding is about, so the trail points somewhere real */
  ledger?: { objectType: string; objectId: string; payload?: Record<string, unknown> };
}

async function existingSignal(
  db: Db,
  companyId: string,
  detector: string,
  key: string,
): Promise<{ id: string; disposition: string } | null> {
  const rows = await db
    .select({ id: signals.id, disposition: signals.disposition })
    .from(signals)
    .where(
      and(
        eq(signals.companyId, companyId),
        eq(signals.detector, detector),
        eq(signals.fingerprint, fingerprintFor(detector, key)),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Raise a signal unless one with the same fingerprint already exists.
 *
 * A repeat observation bumps `lastSeenAt` and `occurrences` rather than
 * inserting a second row — the register answers "is this still true?" without
 * pretending it is a new discovery. Only a genuine first raise appends to the
 * ledger.
 */
export async function raiseSignalOnce(
  db: Db,
  a: RaiseSignalArgs,
): Promise<{ raised: boolean; signalId: string }> {
  const existing = await existingSignal(db, a.companyId, a.detector, a.key);
  if (existing) {
    await db
      .update(signals)
      .set({ lastSeenAt: nowIso(), occurrences: sql`${signals.occurrences} + 1` })
      .where(eq(signals.id, existing.id));
    return { raised: false, signalId: existing.id };
  }
  const id = newId("sig");
  await db.insert(signals).values({
    id,
    companyId: a.companyId,
    projectId: a.projectId,
    detector: a.detector,
    severity: a.severity,
    confidence: a.confidence,
    title: a.title.slice(0, 500),
    explanation: a.explanation,
    evidenceRefs: { key: a.key, ...(a.evidenceRefs ?? {}) },
    fingerprint: fingerprintFor(a.detector, a.key),
    subjectType: a.subjectType ?? null,
    subjectId: a.subjectId ?? null,
    firstSeenAt: nowIso(),
    lastSeenAt: nowIso(),
  });
  if (a.ledger) {
    await appendLedger(db, {
      companyId: a.companyId,
      // the system raised this, not whoever opened a page
      actorId: null,
      action: "create",
      objectType: "signal",
      objectId: id,
      projectId: a.projectId,
      payload: {
        detector: a.detector,
        key: a.key,
        severity: a.severity,
        about: { objectType: a.ledger.objectType, objectId: a.ledger.objectId },
        ...(a.ledger.payload ?? {}),
      },
      storePayload: true,
    });
  }
  return { raised: true, signalId: id };
}

/** Close one open signal because the condition it described has cleared. */
export async function closeSignalByKey(
  db: Db,
  companyId: string,
  detector: SafeguardDetector,
  key: string,
  note: string,
): Promise<boolean> {
  const existing = await existingSignal(db, companyId, detector, key);
  if (!existing) return false;
  if (!(OPEN_DISPOSITIONS as readonly string[]).includes(existing.disposition)) return false;
  await db
    .update(signals)
    .set({
      disposition: "closed",
      reviewerNotes: note,
      autoClosedAt: nowIso(),
      closedAt: nowIso(),
    })
    .where(eq(signals.id, existing.id));
  return true;
}

/**
 * Close every open signal of `detector` in `projectId` whose finding is no
 * longer current.
 *
 * A sweep knows which conditions hold NOW; anything the register still holds
 * open for that detector and is not in `currentKeys` has cleared. The project
 * narrowing is load-bearing: a project-scoped run must not close another
 * project's findings on the grounds that it did not look at them.
 */
export async function reconcileSignals(
  db: Db,
  companyId: string,
  projectId: string | null,
  detector: SafeguardDetector,
  currentKeys: ReadonlySet<string>,
  note: string,
): Promise<number> {
  const clauses = [
    eq(signals.companyId, companyId),
    eq(signals.detector, detector),
    inArray(signals.disposition, [...OPEN_DISPOSITIONS]),
  ];
  if (projectId) clauses.push(eq(signals.projectId, projectId));
  const rows = await db
    .select({ id: signals.id, fingerprint: signals.fingerprint })
    .from(signals)
    .where(and(...clauses));
  let closed = 0;
  for (const row of rows) {
    const prefix = `${detector}:`;
    const key = row.fingerprint?.startsWith(prefix) ? row.fingerprint.slice(prefix.length) : null;
    // A signal raised before this detector stamped a fingerprint carries no
    // key; leaving it open is the safe reading — it was never reconciled by a
    // key, so nothing here can prove it has cleared.
    if (key === null || currentKeys.has(key)) continue;
    await db
      .update(signals)
      .set({
        disposition: "closed",
        reviewerNotes: note,
        autoClosedAt: nowIso(),
        closedAt: nowIso(),
      })
      .where(eq(signals.id, row.id));
    closed += 1;
  }
  return closed;
}

/** Tally of what one detector pass did, returned by every sweep. */
export interface SweepResult {
  raised: number;
  repeat: number;
  closed: number;
}

export const emptySweep = (): SweepResult => ({ raised: 0, repeat: 0, closed: 0 });

export function mergeSweeps(...results: SweepResult[]): SweepResult {
  return results.reduce(
    (acc, r) => ({
      raised: acc.raised + r.raised,
      repeat: acc.repeat + r.repeat,
      closed: acc.closed + r.closed,
    }),
    emptySweep(),
  );
}
