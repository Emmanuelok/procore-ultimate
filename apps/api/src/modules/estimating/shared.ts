/**
 * Helpers shared by the estimating routes and the scheduler sweeps: tenant
 * scoped fetchers, the roll-up writer, the mutability guard, and the
 * fingerprinted signal helpers.
 *
 * One definition each, so a guard in the route layer and a guard in a sweep
 * can never disagree about what "locked" means or raise the same finding
 * twice under two different keys.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  estimateLineItems,
  estimateMarkups,
  estimateSections,
  estimates,
  signals,
} from "@constructos/db";
import type { EstimatingDetector } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { conflict, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { estimateTotals, round2, type MarkupSpec, type RollupLine } from "./pricing.js";

export type EstimateRow = typeof estimates.$inferSelect;
export type EstimateLineRow = typeof estimateLineItems.$inferSelect;
export type EstimateMarkupRow = typeof estimateMarkups.$inferSelect;
export type EstimateSectionRow = typeof estimateSections.$inferSelect;

export const nowIso = (): string => new Date().toISOString();
export const todayIso = (): string => new Date().toISOString().slice(0, 10);
export const pad3 = (n: number): string => String(n).padStart(3, "0");

/** Add `days` to an ISO date, returning an ISO date. */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days between two ISO dates (b − a). */
export function daysBetween(a: string, b: string): number {
  const start = Date.parse(`${a}T00:00:00.000Z`);
  const end = Date.parse(`${b}T00:00:00.000Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

/* ------------------------------------------------------------------ */
/* Fetchers — every one filters by company, and by project when given   */
/* ------------------------------------------------------------------ */

export async function fetchEstimate(
  db: Db,
  estimateId: string,
  companyId: string,
  projectId?: string,
): Promise<EstimateRow> {
  const clauses = [eq(estimates.id, estimateId), eq(estimates.companyId, companyId)];
  if (projectId) clauses.push(eq(estimates.projectId, projectId));
  const rows = await db
    .select()
    .from(estimates)
    .where(and(...clauses))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("Estimate not found");
  return row;
}

export const linesOfEstimate = (db: Db, estimateId: string): Promise<EstimateLineRow[]> =>
  db
    .select()
    .from(estimateLineItems)
    .where(eq(estimateLineItems.estimateId, estimateId))
    .orderBy(asc(estimateLineItems.position), asc(estimateLineItems.createdAt));

export const markupsOfEstimate = (db: Db, estimateId: string): Promise<EstimateMarkupRow[]> =>
  db
    .select()
    .from(estimateMarkups)
    .where(eq(estimateMarkups.estimateId, estimateId))
    .orderBy(asc(estimateMarkups.sequence));

export const sectionsOfEstimate = (db: Db, estimateId: string): Promise<EstimateSectionRow[]> =>
  db
    .select()
    .from(estimateSections)
    .where(eq(estimateSections.estimateId, estimateId))
    .orderBy(asc(estimateSections.sortOrder));

/* ------------------------------------------------------------------ */
/* Mutability                                                          */
/* ------------------------------------------------------------------ */

/** Statuses whose lines may still be edited. */
export const EDITABLE_STATUSES = ["draft", "in_review"] as const;

/**
 * Refuse a content change the estimate's state does not allow.
 *
 * `in_review` is editable, but editing it REVERTS it to draft and clears any
 * approval — an approval attaches to a set of numbers, and the moment the
 * numbers move the approval is a lie. The caller applies the revert; this
 * function reports whether one is needed.
 */
export function assertEditable(estimate: EstimateRow): { revertToDraft: boolean } {
  if (estimate.lockedAt) {
    throw conflict(
      `Estimate ${estimate.reference} is locked. Cut a new version to keep working on it.`,
    );
  }
  if (!(EDITABLE_STATUSES as readonly string[]).includes(estimate.status)) {
    throw conflict(
      `Estimate ${estimate.reference} is ${estimate.status} and its content can no longer be changed. Cut a new version instead.`,
    );
  }
  return { revertToDraft: estimate.status === "in_review" };
}

/* ------------------------------------------------------------------ */
/* Roll-up                                                             */
/* ------------------------------------------------------------------ */

const toRollupLine = (l: EstimateLineRow): RollupLine => ({
  sectionId: l.sectionId,
  costType: l.costType,
  status: l.status,
  labourAmount: l.labourAmount,
  materialAmount: l.materialAmount,
  equipmentAmount: l.equipmentAmount,
  subcontractAmount: l.subcontractAmount,
  otherAmount: l.otherAmount,
  amount: l.amount,
  labourHours: l.labourHours,
});

export const toMarkupSpec = (m: EstimateMarkupRow): MarkupSpec => ({
  id: m.id,
  sequence: m.sequence,
  kind: m.kind,
  name: m.name,
  method: m.method,
  basis: m.basis,
  rate: m.rate,
  costTypes: m.costTypes,
  sectionIds: m.sectionIds,
  quantity: m.quantity,
  enabled: m.enabled === 1,
});

export interface RecomputedTotals {
  directCostTotal: number;
  markupTotal: number;
  total: number;
  labourHours: number;
  lineCount: number;
  warnings: string[];
}

/**
 * Recompute the estimate header, the applied markup amounts and the section
 * subtotals from the lines. Called after EVERY write that can move a number;
 * `totalsCalculatedAt` is stamped so a stale header is detectable.
 */
export async function recomputeEstimate(
  db: Db,
  estimateId: string,
): Promise<RecomputedTotals> {
  const [lineRows, markupRows, sectionRows] = await Promise.all([
    linesOfEstimate(db, estimateId),
    markupsOfEstimate(db, estimateId),
    sectionsOfEstimate(db, estimateId),
  ]);
  const totals = estimateTotals(lineRows.map(toRollupLine), markupRows.map(toMarkupSpec));

  await db
    .update(estimates)
    .set({
      directCostTotal: totals.directCostTotal,
      labourTotal: totals.labourTotal,
      materialTotal: totals.materialTotal,
      equipmentTotal: totals.equipmentTotal,
      subcontractTotal: totals.subcontractTotal,
      otherTotal: totals.otherTotal,
      markupTotal: totals.markupTotal,
      total: totals.total,
      labourHours: totals.labourHours,
      lineCount: totals.lineCount,
      excludedTotal: totals.excludedTotal,
      alternateTotal: totals.alternateTotal,
      totalsCalculatedAt: nowIso(),
      updatedAt: nowIso(),
    })
    .where(eq(estimates.id, estimateId));

  const appliedById = new Map(totals.appliedMarkups.map((m) => [m.id, m]));
  for (const markup of markupRows) {
    const applied = appliedById.get(markup.id);
    const baseAmount = applied?.baseAmount ?? 0;
    const amount = applied?.amount ?? 0;
    if (markup.baseAmount !== baseAmount || markup.amount !== amount) {
      await db
        .update(estimateMarkups)
        .set({ baseAmount, amount, updatedAt: nowIso() })
        .where(eq(estimateMarkups.id, markup.id));
    }
  }

  for (const section of sectionRows) {
    const subtotal = round2(totals.bySection[section.id] ?? 0);
    if (section.directCostTotal !== subtotal) {
      await db
        .update(estimateSections)
        .set({ directCostTotal: subtotal, updatedAt: nowIso() })
        .where(eq(estimateSections.id, section.id));
    }
  }

  return {
    directCostTotal: totals.directCostTotal,
    markupTotal: totals.markupTotal,
    total: totals.total,
    labourHours: totals.labourHours,
    lineCount: totals.lineCount,
    warnings: totals.warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Signals                                                             */
/* ------------------------------------------------------------------ */

export const OPEN_DISPOSITIONS = ["new", "under_review", "confirmed", "escalated"] as const;

const fingerprintFor = (detector: string, key: string): string => `${detector}:${key}`;

export interface RaiseSignalArgs {
  companyId: string;
  projectId: string | null;
  detector: EstimatingDetector;
  /** deterministic identity of the FINDING, not of the run */
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

/**
 * Raise a signal unless one with the same fingerprint already exists. Re-
 * running a sweep over unchanged data must not manufacture a second finding:
 * that is the false-positive fatigue the assurance layer exists to avoid, and
 * it corrupts every precision figure derived from the register.
 */
export async function raiseSignalOnce(
  db: Db,
  a: RaiseSignalArgs,
): Promise<{ raised: boolean; signalId: string }> {
  const existing = await existingSignal(db, a.companyId, a.detector, a.key);
  if (existing) return { raised: false, signalId: existing.id };
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
  detector: EstimatingDetector,
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

/** Ids of estimates whose lines reference any of these takeoff items. */
export async function takeoffIdsInUse(
  db: Db,
  takeoffItemIds: readonly string[],
): Promise<Set<string>> {
  if (takeoffItemIds.length === 0) return new Set();
  const rows = await db
    .select({ takeoffItemId: estimateLineItems.takeoffItemId })
    .from(estimateLineItems)
    .where(inArray(estimateLineItems.takeoffItemId, [...takeoffItemIds]));
  const used = new Set<string>();
  for (const r of rows) if (r.takeoffItemId) used.add(r.takeoffItemId);
  return used;
}

/**
 * Close every open signal of a detector whose finding is no longer current.
 *
 * A sweep knows which conditions hold NOW; anything the register still holds
 * open for that detector and is not in that set has cleared, and leaving it
 * open is how a signal register becomes noise nobody reads.
 */
export async function reconcileSignals(
  db: Db,
  companyId: string,
  detector: EstimatingDetector,
  currentKeys: ReadonlySet<string>,
  note: string,
): Promise<number> {
  const rows = await db
    .select({ id: signals.id, fingerprint: signals.fingerprint })
    .from(signals)
    .where(
      and(
        eq(signals.companyId, companyId),
        eq(signals.detector, detector),
        inArray(signals.disposition, [...OPEN_DISPOSITIONS]),
      ),
    );
  let closed = 0;
  for (const row of rows) {
    const key = row.fingerprint?.startsWith(`${detector}:`)
      ? row.fingerprint.slice(detector.length + 1)
      : null;
    if (key !== null && currentKeys.has(key)) continue;
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
