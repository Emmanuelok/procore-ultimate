/**
 * Fingerprinted signal helpers shared by risk, governance, finance and
 * disputes.
 *
 * A sweep that runs every six hours must not manufacture a new signal every
 * six hours for the same unchanged condition. `signals.fingerprint` is the
 * deterministic identity of the FINDING (detector + what it is about), so a
 * re-run over unchanged data raises nothing and the register stays readable.
 * When the condition clears, the signal is closed rather than left to rot —
 * an integrity feed full of stale findings is one nobody reads.
 *
 * Mirrors modules/estimating/shared.ts so the two never disagree about what
 * "already raised" means.
 */
import { and, eq } from "drizzle-orm";
import { signals } from "@constructos/db";
import type { Db } from "../../lib/db.js";
import { newId } from "../../lib/ids.js";

/** Dispositions that mean the finding is still live. */
export const OPEN_DISPOSITIONS = ["new", "under_review", "confirmed", "escalated"] as const;

const nowIso = (): string => new Date().toISOString();
const fingerprintFor = (detector: string, key: string): string => `${detector}:${key}`;

export interface RaiseSignalArgs {
  companyId: string;
  projectId: string | null;
  detector: string;
  /** deterministic identity of the FINDING, not of the run that found it */
  key: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  confidence: number;
  title: string;
  explanation: string;
  subjectType?: string;
  subjectId?: string;
  evidenceRefs?: Record<string, unknown>;
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

/** Raise a signal unless one with the same fingerprint already exists. */
export async function raiseSignalOnce(
  db: Db,
  a: RaiseSignalArgs,
): Promise<{ raised: boolean; signalId: string }> {
  const existing = await existingSignal(db, a.companyId, a.detector, a.key);
  if (existing) {
    await db.update(signals).set({ lastSeenAt: nowIso() }).where(eq(signals.id, existing.id));
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
    title: a.title,
    explanation: a.explanation,
    evidenceRefs: { key: a.key, ...(a.evidenceRefs ?? {}) },
    fingerprint: fingerprintFor(a.detector, a.key),
    subjectType: a.subjectType ?? null,
    subjectId: a.subjectId ?? null,
    firstSeenAt: nowIso(),
    lastSeenAt: nowIso(),
  });
  return { raised: true, signalId: id };
}

/** Close an open signal when the condition it described has cleared. */
export async function closeSignalByKey(
  db: Db,
  companyId: string,
  detector: string,
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
