/**
 * Shared plumbing for the design management module: gates, wire formats,
 * numbering, the ledger wrapper, idempotent signals and the cross-register
 * reference checks.
 *
 * Three rules live here rather than being restated in eight route files:
 *
 *  - LEDGER. Every consequential mutation appends. `ledger()` fixes the
 *    object-type vocabulary so the design chain reads as one record.
 *  - IDEMPOTENT SIGNALS. A sweep that re-detects the same condition must
 *    produce nothing the second time. `alreadySignalled` reads the dedupe
 *    keys carried in `signals.evidenceRefs.key`, the platform convention.
 *  - HONEST FIGURES. A number the platform cannot derive is
 *    `{ value: null, reasons }`, never a fabricated zero.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  bimModels,
  designConsultants,
  designPackages,
  drawingSheets,
  recordLinks,
  scheduleTasks,
  signals,
  specSections,
  users,
  vendors,
} from "@constructos/db";
import type { DesignDetector, SignalSeverity } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { nextRecordNumber } from "../../lib/numbering.js";

/* ------------------------------------------------------------------ */
/* Wire formats                                                        */
/* ------------------------------------------------------------------ */

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");

export const isoTimestampSchema = z
  .string()
  .min(4)
  .refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO timestamp");

export const idSchema = z.string().min(1).max(64);
export const fileIdsSchema = z.array(idSchema).max(200);
export const currencySchema = z.string().length(3).toUpperCase();

export const todayISO = (): string => new Date().toISOString().slice(0, 10);
export const nowISO = (): string => new Date().toISOString();
export const pad3 = (n: number): string => String(n).padStart(3, "0");
export const round1 = (n: number): number => Math.round(n * 10) / 10;
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Whole days from `a` to `b`, both ISO dates; negative when b precedes a. */
export function daysBetweenISO(a: string, b: string): number | null {
  const from = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

export function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Gates                                                               */
/* ------------------------------------------------------------------ */

export function buildGates(app: FastifyInstance) {
  return {
    readGate: [app.authenticate, app.requireCompany, app.requireTool("design", "read")],
    standardGate: [app.authenticate, app.requireCompany, app.requireTool("design", "standard")],
    adminGate: [app.authenticate, app.requireCompany, app.requireTool("design", "admin")],
  };
}
export type DesignGates = ReturnType<typeof buildGates>;

/* ------------------------------------------------------------------ */
/* Numbering                                                           */
/* ------------------------------------------------------------------ */

export async function allocateReference(
  db: Db,
  projectId: string,
  counterKey: string,
  prefix: string,
): Promise<{ number: number; reference: string }> {
  const number = await nextRecordNumber(db, projectId, counterKey);
  return { number, reference: `${prefix}-${pad3(number)}` };
}

/* ------------------------------------------------------------------ */
/* Ledger                                                              */
/* ------------------------------------------------------------------ */

export type DesignObjectType =
  | "design_stage_gate"
  | "design_package"
  | "design_review"
  | "design_review_participant"
  | "design_comment"
  | "design_issue"
  | "design_decision"
  | "design_consultant"
  | "design_deliverable"
  | "design_freeze"
  | "design_change_notice"
  | "design_change_impact"
  | "design_info_requirement"
  | "design_readiness"
  | "design_link"
  | "obligation"
  | "signal";

export async function ledger(
  db: Db,
  input: {
    companyId: string;
    projectId?: string | null;
    actorId: string | null;
    action: "create" | "update" | "delete" | "state_change" | "access";
    objectType: DesignObjectType;
    objectId: string;
    payload?: unknown;
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
  });
}

/* ------------------------------------------------------------------ */
/* Signals                                                             */
/* ------------------------------------------------------------------ */

export interface DesignSignalDraft {
  detector: DesignDetector;
  severity: SignalSeverity;
  confidence: number;
  title: string;
  explanation: string;
  /** dedupe key: the same condition must never be raised twice */
  key: string;
  evidence: Record<string, unknown>;
}

/**
 * Dedupe keys already raised for these detectors. Every key this module mints
 * names a record inside one project, so a per-project sweep passes
 * `projectId` and reads only that project's signals rather than the whole
 * company's history on every pass.
 */
export async function alreadySignalled(
  db: Db,
  companyId: string,
  detectors: readonly DesignDetector[],
  projectId?: string | null,
): Promise<Set<string>> {
  const rows = await db
    .select({ refs: signals.evidenceRefs })
    .from(signals)
    .where(
      and(
        eq(signals.companyId, companyId),
        projectId ? eq(signals.projectId, projectId) : undefined,
        inArray(signals.detector, [...detectors]),
      ),
    )
    .limit(20_000);
  const keys = new Set<string>();
  for (const row of rows) {
    const refs = row.refs as { key?: unknown } | null;
    if (typeof refs?.key === "string") keys.add(refs.key);
  }
  return keys;
}

export async function raiseSignal(
  db: Db,
  companyId: string,
  projectId: string | null,
  actorId: string | null,
  draft: DesignSignalDraft,
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
  await ledger(db, {
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
/* Cross-register reference checks                                     */
/* ------------------------------------------------------------------ */

export async function assertVendor(db: Db, companyId: string, vendorId: string): Promise<void> {
  const rows = await db
    .select({ id: vendors.id })
    .from(vendors)
    .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)))
    .limit(1);
  if (!rows[0]) throw badRequest(`Vendor ${vendorId} not found in this company.`);
}

export async function assertUser(db: Db, userId: string): Promise<void> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!rows[0]) throw badRequest(`User ${userId} not found.`);
}

export async function assertPackage(db: Db, companyId: string, projectId: string, packageId: string) {
  const rows = await db
    .select()
    .from(designPackages)
    .where(
      and(
        eq(designPackages.id, packageId),
        eq(designPackages.companyId, companyId),
        eq(designPackages.projectId, projectId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw badRequest(`Design package ${packageId} not found in this project.`);
  return row;
}

export async function assertConsultant(
  db: Db,
  companyId: string,
  projectId: string,
  consultantId: string,
) {
  const rows = await db
    .select()
    .from(designConsultants)
    .where(
      and(
        eq(designConsultants.id, consultantId),
        eq(designConsultants.companyId, companyId),
        eq(designConsultants.projectId, projectId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw badRequest(`Design consultant ${consultantId} not found in this project.`);
  return row;
}

export async function assertDrawingSheet(db: Db, projectId: string, sheetId: string): Promise<void> {
  const rows = await db
    .select({ id: drawingSheets.id })
    .from(drawingSheets)
    .where(and(eq(drawingSheets.id, sheetId), eq(drawingSheets.projectId, projectId)))
    .limit(1);
  if (!rows[0]) throw badRequest(`Drawing sheet ${sheetId} not found in this project.`);
}

export async function assertSpecSection(db: Db, projectId: string, sectionId: string): Promise<void> {
  const rows = await db
    .select({ id: specSections.id })
    .from(specSections)
    .where(and(eq(specSections.id, sectionId), eq(specSections.projectId, projectId)))
    .limit(1);
  if (!rows[0]) throw badRequest(`Specification section ${sectionId} not found in this project.`);
}

export async function assertBimModel(db: Db, projectId: string, modelId: string): Promise<void> {
  const rows = await db
    .select({ id: bimModels.id })
    .from(bimModels)
    .where(and(eq(bimModels.id, modelId), eq(bimModels.projectId, projectId)))
    .limit(1);
  if (!rows[0]) throw badRequest(`BIM model ${modelId} not found in this project.`);
}

/** The schedule task a record is tied to, or a 400 when it is not in this project. */
export async function loadTask(db: Db, projectId: string, taskId: string) {
  const rows = await db
    .select({
      id: scheduleTasks.id,
      name: scheduleTasks.name,
      startDate: scheduleTasks.startDate,
      finishDate: scheduleTasks.finishDate,
      actualStart: scheduleTasks.actualStart,
      isCritical: scheduleTasks.isCritical,
      totalFloat: scheduleTasks.totalFloat,
    })
    .from(scheduleTasks)
    .where(and(eq(scheduleTasks.id, taskId), eq(scheduleTasks.projectId, projectId)))
    .limit(1);
  const task = rows[0];
  if (!task) throw badRequest(`Schedule task ${taskId} not found in this project.`);
  return task;
}

export function notFoundIfMissing<T>(row: T | undefined, what: string): T {
  if (!row) throw notFound(`${what} not found`);
  return row;
}

/* ------------------------------------------------------------------ */
/* Cross-tool links (record_links)                                     */
/* ------------------------------------------------------------------ */

export async function linkRecord(
  db: Db,
  input: {
    companyId: string;
    projectId: string;
    fromType: string;
    fromId: string;
    toType: string;
    toId: string;
    linkKind?: string;
    createdBy: string;
  },
): Promise<string | null> {
  const existing = await db
    .select({ id: recordLinks.id })
    .from(recordLinks)
    .where(
      and(
        eq(recordLinks.projectId, input.projectId),
        eq(recordLinks.fromType, input.fromType),
        eq(recordLinks.fromId, input.fromId),
        eq(recordLinks.toType, input.toType),
        eq(recordLinks.toId, input.toId),
      ),
    )
    .limit(1);
  if (existing[0]) return null;
  const id = newId("lnk");
  await db.insert(recordLinks).values({
    id,
    companyId: input.companyId,
    projectId: input.projectId,
    fromType: input.fromType,
    fromId: input.fromId,
    toType: input.toType,
    toId: input.toId,
    linkKind: input.linkKind ?? "reference",
    createdBy: input.createdBy,
  });
  return id;
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

/**
 * `.partial()` keeps every `.default()`, so a PATCH parsed through it would
 * silently reset untouched columns. Strip the defaults first: a PATCH body is
 * only what the caller actually sent.
 */
type WithoutDefaults<T extends z.ZodRawShape> = {
  [K in keyof T]: T[K] extends z.ZodDefault<infer Inner extends z.ZodTypeAny> ? Inner : T[K];
};
export function patchSchemaOf<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    shape[key] = (field instanceof z.ZodDefault ? field.removeDefault() : field) as z.ZodTypeAny;
  }
  return z.object(shape as unknown as WithoutDefaults<T>).partial();
}

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

/**
 * A figure the platform declines to invent: `value` is null and `reasons`
 * says why, never a fabricated zero.
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

/** Count occurrences of a string field across rows. */
export function tally<T>(rows: readonly T[], key: (row: T) => string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const k = key(row);
    if (!k) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** Mean of the finite values, or null when there are none. */
export function mean(values: readonly (number | null | undefined)[]): number | null {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

/** The system actor for scheduler-driven writes whose column is NOT NULL. */
export const SYSTEM_ACTOR = "system";
