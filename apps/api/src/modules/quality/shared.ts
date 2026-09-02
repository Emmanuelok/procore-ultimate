/**
 * Shared plumbing for the quality module: gates, references, segregation
 * checks and the signal helper the lazy sweeps use.
 *
 * Two rules live here rather than being restated in five route files:
 *
 *  - SEGREGATION. Wherever this module records an approval, a verification or
 *    an acceptance, the actor must differ from the person who created,
 *    proposed or performed the thing being approved. `assertDistinctActor`
 *    is the single implementation, so a new route cannot quietly omit it.
 *  - LEDGER. Every consequential mutation appends. `ledger()` is a thin
 *    wrapper that fixes the object-type prefix so the ledger reads as one
 *    register rather than five.
 */

import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { assets, commissioningSystems, locations, signals, vendors } from "@constructos/db";
import type { SignalSeverity } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import type { Db } from "../../lib/db.js";

/* ------------------------------------------------------------------ */
/* Wire formats                                                        */
/* ------------------------------------------------------------------ */

/** ISO calendar date (YYYY-MM-DD) — the wire format for every date column. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");

/** Lenient ISO timestamp (avoids zod version drift on .datetime()). */
export const isoTimestampSchema = z
  .string()
  .min(4)
  .refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO timestamp");

export const idSchema = z.string().min(1).max(64);
export const fileIdsSchema = z.array(z.string().min(1).max(64)).max(200);

export const todayISO = (): string => new Date().toISOString().slice(0, 10);
export const nowISO = (): string => new Date().toISOString();

export const pad3 = (n: number): string => String(n).padStart(3, "0");
export const pad4 = (n: number): string => String(n).padStart(4, "0");
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ */
/* Gates                                                               */
/* ------------------------------------------------------------------ */

export interface QualityGates {
  /** company membership only — for company-scoped template routes */
  memberGate: ReturnType<typeof buildGates>["memberGate"];
  readGate: ReturnType<typeof buildGates>["readGate"];
  standardGate: ReturnType<typeof buildGates>["standardGate"];
  adminGate: ReturnType<typeof buildGates>["adminGate"];
}

export function buildGates(app: FastifyInstance) {
  return {
    memberGate: [app.authenticate, app.requireCompany],
    readGate: [app.authenticate, app.requireCompany, app.requireTool("quality", "read")],
    standardGate: [app.authenticate, app.requireCompany, app.requireTool("quality", "standard")],
    adminGate: [app.authenticate, app.requireCompany, app.requireTool("quality", "admin")],
  };
}

/* ------------------------------------------------------------------ */
/* Numbering                                                           */
/* ------------------------------------------------------------------ */

export interface AllocatedNumber {
  number: number;
  reference: string;
}

/**
 * Allocate the project-scoped record number and its human reference in one
 * step. `counterKey` is namespaced per register so an NCR and an ITP never
 * share a sequence.
 */
export async function allocateReference(
  db: Db,
  projectId: string,
  counterKey: string,
  prefix: string,
  width: 3 | 4 = 3,
): Promise<AllocatedNumber> {
  const number = await nextRecordNumber(db, projectId, counterKey);
  return { number, reference: `${prefix}-${width === 4 ? pad4(number) : pad3(number)}` };
}

/* ------------------------------------------------------------------ */
/* Segregation of duties                                               */
/* ------------------------------------------------------------------ */

/**
 * Refuse when the approver IS the creator/proposer/performer.
 *
 * This is the control the whole quality register exists to carry: an NCR
 * whose `use_as_is` disposition was approved by the person who proposed it is
 * a decision nobody independent ever made, and the platform must not be the
 * place that record was created. `subject` names the act in the refusal so
 * the reader knows which of the several segregated acts they tripped.
 */
export function assertDistinctActor(
  actorId: string,
  originatorId: string | null | undefined,
  subject: string,
  originatorRole = "raised",
): void {
  if (originatorId && originatorId === actorId) {
    throw forbidden(
      `${subject} must be done by someone other than the person who ${originatorRole} it. ` +
        `User ${actorId} ${originatorRole} this record; a second pair of eyes is the whole point of the step.`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Ledger                                                              */
/* ------------------------------------------------------------------ */

export type QualityObjectType =
  | "inspection_test_plan"
  | "itp_activity"
  | "checklist_template"
  | "checklist_template_item"
  | "checklist"
  | "checklist_response"
  | "non_conformance_report"
  | "commissioning_system"
  | "commissioning_test_record"
  | "turnover_package"
  /* Domain Z and closeout registers (WP-QUAL upgrade) */
  | "quality_concession"
  | "concrete_pour"
  | "concrete_test_specimen"
  | "welding_procedure"
  | "welder_qualification"
  | "weld"
  | "ndt_record"
  | "material_test_certificate"
  | "calibrated_instrument"
  | "calibration_record"
  | "rework_item"
  | "quality_audit"
  | "quality_audit_finding"
  | "defects_liability_period"
  | "dlp_defect"
  | "performance_guarantee"
  | "operator_training_record"
  | "spare_part"
  | "post_occupancy_evaluation"
  /* registers quality writes INTO rather than duplicating */
  | "punch_item"
  | "safety_corrective_action"
  | "change_event"
  | "asset"
  | "asset_element_link"
  | "warranty";

export async function ledger(
  db: Db,
  input: {
    companyId: string;
    projectId?: string | null;
    actorId: string | null;
    action: "create" | "update" | "delete" | "state_change" | "access";
    objectType: QualityObjectType;
    objectId: string;
    payload?: unknown;
    storePayload?: boolean;
  },
): Promise<void> {
  await appendLedger(db, {
    companyId: input.companyId,
    projectId: input.projectId ?? null,
    actorId: input.actorId,
    action: input.action,
    objectType: input.objectType,
    objectId: input.objectId,
    payload: input.payload,
    storePayload: input.storePayload,
  });
}

/* ------------------------------------------------------------------ */
/* Signals                                                             */
/* ------------------------------------------------------------------ */

/**
 * The detectors the quality sweeps raise. Each one is keyed in
 * `signals.evidenceRefs.key` so a second pass over the same condition raises
 * nothing — the sweeps run on a scheduler and on list reads, and both must be
 * safe to repeat.
 */
export const QUALITY_DETECTORS = {
  holdPointUnreleased: "quality_hold_point_unreleased",
  ncrResponseOverdue: "quality_ncr_response_overdue",
  turnoverArtefactsMissing: "quality_turnover_artefacts_missing",
  systemDeficienciesOverdue: "quality_system_deficiencies_overdue",
  /* Domain Z and closeout registers */
  concessionExpiring: "quality_concession_expiring",
  calibrationOverdue: "quality_calibration_overdue",
  welderQualificationLapsed: "quality_welder_qualification_lapsed",
  concreteAcceptanceFailed: "quality_concrete_acceptance_failed",
  ndtCoverageShort: "quality_ndt_coverage_short",
  certificateUnverified: "quality_certificate_unverified",
  auditFindingOverdue: "quality_audit_finding_overdue",
  dlpExpiring: "quality_dlp_expiring",
  seasonalTestDue: "quality_seasonal_test_due",
} as const;

export type QualityDetector = (typeof QUALITY_DETECTORS)[keyof typeof QUALITY_DETECTORS];

/**
 * The dedupe keys already raised for a detector in this company.
 *
 * Idempotency is carried in `signals.evidenceRefs.key` rather than a unique
 * index, matching the platform's other lazy sweeps (insurance expiry, payment
 * deemed liability, contract time bars): a repeated read re-detects the same
 * condition and must produce nothing the second time.
 */
export async function alreadySignalled(
  db: Db,
  companyId: string,
  detector: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ refs: signals.evidenceRefs })
    .from(signals)
    .where(and(eq(signals.companyId, companyId), eq(signals.detector, detector)));
  const keys = new Set<string>();
  for (const row of rows) {
    const refs = row.refs as { key?: unknown } | null;
    if (typeof refs?.key === "string") keys.add(refs.key);
  }
  return keys;
}

export interface QualitySignal {
  detector: QualityDetector;
  severity: SignalSeverity;
  confidence: number;
  title: string;
  explanation: string;
  key: string;
  evidence: Record<string, unknown>;
}

export async function raiseSignal(
  db: Db,
  companyId: string,
  projectId: string | null,
  actorId: string | null,
  draft: QualitySignal,
): Promise<string> {
  const id = newId("sig");
  await db.insert(signals).values({
    id,
    companyId,
    projectId,
    detector: draft.detector,
    severity: draft.severity,
    confidence: draft.confidence,
    title: draft.title,
    explanation: draft.explanation,
    evidenceRefs: { key: draft.key, ...draft.evidence },
  });
  await appendLedger(db, {
    companyId,
    projectId,
    actorId,
    action: "create",
    objectType: "signal",
    objectId: id,
    payload: { detector: draft.detector, severity: draft.severity, key: draft.key },
  });
  return id;
}

/* ------------------------------------------------------------------ */
/* Cross-module reference checks                                       */
/* ------------------------------------------------------------------ */

/**
 * A link that names a record the platform HOLDS and cannot resolve is
 * refused. Quality records are evidence; a dangling assetId on a turnover
 * package would hand over into nothing.
 */
export async function assertVendor(db: Db, companyId: string, vendorId: string): Promise<void> {
  const rows = await db
    .select({ id: vendors.id })
    .from(vendors)
    .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)))
    .limit(1);
  if (!rows[0]) throw badRequest(`Vendor ${vendorId} not found in this company.`);
}

export async function assertLocation(
  db: Db,
  projectId: string,
  locationId: string,
): Promise<void> {
  const rows = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.id, locationId), eq(locations.projectId, projectId)))
    .limit(1);
  if (!rows[0]) throw badRequest(`Location ${locationId} not found in this project.`);
}

export async function assertAsset(db: Db, projectId: string, assetId: string): Promise<void> {
  const rows = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.projectId, projectId)))
    .limit(1);
  if (!rows[0]) {
    throw badRequest(
      `Asset ${assetId} not found in this project's twin register. Register the asset first (POST /projects/:projectId/assets) — commissioning hands over INTO that register, it does not keep a second one.`,
    );
  }
}

export async function loadSystemOr404(db: Db, companyId: string, projectId: string, id: string) {
  const rows = await db
    .select()
    .from(commissioningSystems)
    .where(
      and(
        eq(commissioningSystems.id, id),
        eq(commissioningSystems.companyId, companyId),
        eq(commissioningSystems.projectId, projectId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound("Commissioning system not found");
  return rows[0];
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

/** Apply only the keys the caller actually sent, mapped to columns. */
export function patchSet(
  body: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, unknown> {
  const set: Record<string, unknown> = { updatedAt: nowISO() };
  for (const key of allowed) {
    if (body[key] !== undefined) set[key] = body[key];
  }
  return set;
}

export const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

/** Median of a sample, or null when the sample is empty. */
export function medianOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 1
    ? sorted[Math.floor(mid)]!
    : round2((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * A figure the platform declines to invent. Mirrors
 * modules/benchmarks/metrics.ts: `value` is null and `reasons` says why,
 * never a fabricated zero.
 */
export interface Figure {
  value: number | null;
  unit: string;
  inputs: Record<string, unknown>;
  reasons: string[];
}

export const figure = (
  value: number | null,
  unit: string,
  inputs: Record<string, unknown>,
  reasons: string[] = [],
): Figure => ({ value, unit, inputs, reasons });

/* ------------------------------------------------------------------ */
/* Money                                                               */
/* ------------------------------------------------------------------ */

export interface CurrencyTotal {
  currency: string;
  amount: number;
  recordCount: number;
}

/**
 * Money, bucketed by currency, never summed across them.
 *
 * A project with GBP and USD non-conformances has two totals and no third
 * one; reporting their arithmetic sum under whichever currency happened to be
 * on the first row is how a cost report becomes fiction. Rows with no amount
 * are counted separately so the caller can say the total is a floor.
 */
export function totalsByCurrency(
  rows: Array<{ amount: number | null | undefined; currency: string | null | undefined }>,
): { totals: CurrencyTotal[]; withAmount: number; withoutAmount: number } {
  const byCurrency = new Map<string, { amount: number; recordCount: number }>();
  let withAmount = 0;
  let withoutAmount = 0;
  for (const row of rows) {
    if (typeof row.amount !== "number" || !Number.isFinite(row.amount)) {
      withoutAmount += 1;
      continue;
    }
    withAmount += 1;
    const key = row.currency || "USD";
    const bucket = byCurrency.get(key) ?? { amount: 0, recordCount: 0 };
    bucket.amount += row.amount;
    bucket.recordCount += 1;
    byCurrency.set(key, bucket);
  }
  return {
    totals: [...byCurrency.entries()]
      .map(([currency, v]) => ({ currency, amount: round2(v.amount), recordCount: v.recordCount }))
      .sort((a, b) => (a.currency < b.currency ? -1 : 1)),
    withAmount,
    withoutAmount,
  };
}

/* ------------------------------------------------------------------ */
/* Registers                                                           */
/* ------------------------------------------------------------------ */

/** Days between two ISO dates, or null when either is unreadable. */
export function daysUntil(fromIso: string, toIso: string): number | null {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}
