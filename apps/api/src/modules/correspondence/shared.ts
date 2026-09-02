/**
 * Shared plumbing for the correspondence module: gates, wire formats,
 * numbering, the ledger wrapper, idempotent signals, obligations and the
 * cross-register reference checks.
 *
 * Four rules live here rather than being restated in six route files:
 *
 *  - LEDGER. Every consequential mutation appends. `ledger()` fixes the
 *    object-type vocabulary so the correspondence chain reads as one record.
 *  - IDEMPOTENT SIGNALS. A sweep that re-detects the same condition must
 *    produce nothing the second time. `alreadySignalled` reads the dedupe
 *    keys carried in `signals.evidenceRefs.key`, the platform convention.
 *  - DEADLINES ARE OBLIGATIONS. A response due date and an acknowledgement
 *    due date are promises someone made; `openObligation` puts them in the
 *    assurance register rather than inventing a second deadline store.
 *  - HONEST FIGURES. A number the platform cannot derive is
 *    `{ value: null, reasons }`, never a fabricated zero.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  companyMemberships,
  contacts,
  correspondenceTypes,
  files,
  locations,
  obligations,
  scheduleTasks,
  signals,
  users,
  vendors,
} from "@constructos/db";
import type { CorrespondenceDetector, SignalSeverity } from "@constructos/shared";
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
export const emailSchema = z.string().trim().min(3).max(320).toLowerCase();
export const keySchema = z
  .string()
  .trim()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lower-case letters, digits, - and _");

export const todayISO = (): string => new Date().toISOString().slice(0, 10);
export const nowISO = (): string => new Date().toISOString();
export const pad3 = (n: number): string => String(n).padStart(3, "0");
export const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The system actor for scheduler-driven writes whose column is NOT NULL. */
export const SYSTEM_ACTOR = "system";

/* ------------------------------------------------------------------ */
/* Gates                                                               */
/* ------------------------------------------------------------------ */

export function buildGates(app: FastifyInstance) {
  return {
    readGate: [app.authenticate, app.requireCompany, app.requireTool("correspondence", "read")],
    standardGate: [
      app.authenticate,
      app.requireCompany,
      app.requireTool("correspondence", "standard"),
    ],
    adminGate: [app.authenticate, app.requireCompany, app.requireTool("correspondence", "admin")],
    /** company-level library routes: any member reads */
    companyGate: [app.authenticate, app.requireCompany],
    /** company-level library writes: configuration is an administrative act */
    companyAdminGate: [
      app.authenticate,
      app.requireCompany,
      app.requireCompanyRole(["owner", "admin"]),
    ],
  };
}
export type CorrGates = ReturnType<typeof buildGates>;

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

export type CorrObjectType =
  | "correspondence_type"
  | "correspondence_letter"
  | "correspondence_recipient"
  | "correspondence_approval"
  | "correspondence_inbound"
  | "transmittal"
  | "transmittal_item"
  | "action_plan_template"
  | "action_plan"
  | "action_plan_activity"
  | "action_plan_signoff"
  | "form_template"
  | "form_assignment"
  | "form_response"
  | "obligation"
  | "signal";

export async function ledger(
  db: Db,
  input: {
    companyId: string;
    projectId?: string | null;
    actorId: string | null;
    action: "create" | "update" | "delete" | "state_change" | "access";
    objectType: CorrObjectType;
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

export interface CorrSignalDraft {
  detector: CorrespondenceDetector;
  severity: SignalSeverity;
  confidence: number;
  title: string;
  explanation: string;
  /** dedupe key: the same condition must never be raised twice */
  key: string;
  evidence: Record<string, unknown>;
}

/**
 * Dedupe keys already raised for a detector (open or closed). Every key this
 * module mints names a record inside one project, so a per-project sweep
 * passes `projectId` and reads only that project's signals rather than the
 * whole company's history on every pass.
 */
export async function alreadySignalled(
  db: Db,
  companyId: string,
  detectors: readonly CorrespondenceDetector[],
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
  draft: CorrSignalDraft,
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
/* Obligations                                                         */
/* ------------------------------------------------------------------ */

/**
 * Open an obligation for a deadline this module owns. Callers store the
 * returned id on their row; re-opening is the caller's decision (a re-planned
 * date waives the old obligation and opens a new one) so this helper never
 * reuses a deterministic id that could collide.
 */
export async function openObligation(
  db: Db,
  input: {
    companyId: string;
    projectId: string;
    actorId: string | null;
    sourceClause: string;
    trigger: string;
    /** ISO date (YYYY-MM-DD); stored as midnight UTC */
    deadlineDate: string;
    warnDaysBefore?: number;
    evidenceRequirement: string;
    objectType: CorrObjectType;
    objectId: string;
  },
): Promise<string> {
  const id = newId("obl");
  await db.insert(obligations).values({
    id,
    companyId: input.companyId,
    projectId: input.projectId,
    sourceClause: input.sourceClause,
    trigger: input.trigger,
    deadline: `${input.deadlineDate}T00:00:00.000Z`,
    warnDaysBefore: input.warnDaysBefore ?? 3,
    evidenceRequirement: input.evidenceRequirement,
    status: "open",
    createdBy: input.actorId ?? SYSTEM_ACTOR,
  });
  await ledger(db, {
    companyId: input.companyId,
    projectId: input.projectId,
    actorId: input.actorId,
    action: "create",
    objectType: "obligation",
    objectId: id,
    payload: { for: input.objectType, recordId: input.objectId, deadline: input.deadlineDate },
  });
  return id;
}

/** Close an obligation that this module opened, recording why. */
export async function settleObligation(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  obligationId: string | null,
  status: "satisfied" | "waived",
  why: string,
): Promise<void> {
  if (!obligationId) return;
  const rows = await db
    .update(obligations)
    .set({ status })
    .where(
      and(
        eq(obligations.id, obligationId),
        eq(obligations.companyId, companyId),
        eq(obligations.status, "open"),
      ),
    )
    .returning({ id: obligations.id });
  if (rows.length === 0) return;
  await ledger(db, {
    companyId,
    projectId,
    actorId,
    action: "state_change",
    objectType: "obligation",
    objectId: obligationId,
    payload: { status, why },
  });
}

/* ------------------------------------------------------------------ */
/* Cross-register reference checks                                     */
/* ------------------------------------------------------------------ */

export async function assertLocation(db: Db, projectId: string, locationId: string): Promise<void> {
  const rows = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.id, locationId), eq(locations.projectId, projectId)))
    .limit(1);
  if (!rows[0]) throw badRequest(`Location ${locationId} not found in this project.`);
}

export async function assertScheduleTask(
  db: Db,
  projectId: string,
  taskId: string,
): Promise<{ id: string; name: string; startDate: string | null; finishDate: string | null }> {
  const rows = await db
    .select({
      id: scheduleTasks.id,
      name: scheduleTasks.name,
      startDate: scheduleTasks.startDate,
      finishDate: scheduleTasks.finishDate,
    })
    .from(scheduleTasks)
    .where(and(eq(scheduleTasks.id, taskId), eq(scheduleTasks.projectId, projectId)))
    .limit(1);
  const task = rows[0];
  if (!task) throw badRequest(`Schedule task ${taskId} not found in this project.`);
  return task;
}

export async function assertVendor(db: Db, companyId: string, vendorId: string): Promise<void> {
  const rows = await db
    .select({ id: vendors.id })
    .from(vendors)
    .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)))
    .limit(1);
  if (!rows[0]) throw badRequest(`Vendor ${vendorId} not found in this company.`);
}

export async function assertContact(db: Db, companyId: string, contactId: string): Promise<void> {
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.companyId, companyId)))
    .limit(1);
  if (!rows[0]) throw badRequest(`Contact ${contactId} not found in this company.`);
}

/** A user who is a member of this tenant — never any user id the caller sends. */
export async function assertCompanyUser(
  db: Db,
  companyId: string,
  userId: string,
): Promise<{ id: string; name: string; email: string }> {
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .innerJoin(companyMemberships, eq(companyMemberships.userId, users.id))
    .where(and(eq(companyMemberships.companyId, companyId), eq(users.id, userId)))
    .limit(1);
  const user = rows[0];
  if (!user) throw badRequest(`User ${userId} is not a member of this company.`);
  return user;
}

/**
 * Every file id must belong to this tenant (and to this project when the file
 * is project-scoped). Attachments are the evidence a dispute turns on; a
 * dangling or foreign id in the list is a silent hole.
 */
export async function assertFiles(
  db: Db,
  companyId: string,
  projectId: string,
  fileIds: readonly string[],
): Promise<void> {
  if (fileIds.length === 0) return;
  const unique = [...new Set(fileIds)];
  const rows = await db
    .select({ id: files.id, projectId: files.projectId })
    .from(files)
    .where(and(eq(files.companyId, companyId), inArray(files.id, unique)));
  const found = new Map(rows.map((r) => [r.id, r.projectId]));
  for (const id of unique) {
    if (!found.has(id)) throw badRequest(`File ${id} not found in this company.`);
    const owner = found.get(id);
    if (owner !== null && owner !== projectId) {
      throw badRequest(`File ${id} belongs to another project.`);
    }
  }
}

/**
 * Resolve a correspondence type by id, restricted to the tenant and to types
 * available on this project (company-wide, or this project's own).
 */
export async function loadType(
  db: Db,
  companyId: string,
  projectId: string,
  typeId: string,
) {
  const rows = await db
    .select()
    .from(correspondenceTypes)
    .where(and(eq(correspondenceTypes.id, typeId), eq(correspondenceTypes.companyId, companyId)))
    .limit(1);
  const type = rows[0];
  if (!type) throw badRequest(`Correspondence type ${typeId} not found in this company.`);
  if (type.projectId !== null && type.projectId !== projectId) {
    throw badRequest(`Correspondence type ${type.key} belongs to another project.`);
  }
  if (type.isActive !== 1) throw badRequest(`Correspondence type ${type.key} is not active.`);
  return type;
}

export function notFoundIfMissing<T>(row: T | undefined, what: string): T {
  if (!row) throw notFound(`${what} not found`);
  return row;
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

/**
 * `.partial()` keeps every `.default()`, so a PATCH parsed through it would
 * silently reset untouched columns. Strip the defaults first: a PATCH body is
 * only what the caller sent.
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

export function tally(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
