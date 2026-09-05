/**
 * Shared plumbing for the site operations module: gates, wire formats, the
 * ledger wrapper, idempotent signals, notifications and the cross-register
 * reference checks.
 *
 * Three rules live here rather than being restated in nine route files:
 *
 *  - LEDGER. Every consequential mutation appends. `ledger()` fixes the
 *    object-type vocabulary so the site register reads as one chain.
 *  - IDEMPOTENT SIGNALS. A sweep that re-detects the same condition must
 *    produce nothing the second time. `alreadySignalled` reads the dedupe
 *    keys carried in `signals.evidenceRefs.key`, the platform convention.
 *  - HONEST FIGURES. A number the module cannot derive is `{ value: null,
 *    reasons }`, never a zero.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { locations, scheduleTasks, signals, vendors, workers } from "@constructos/db";
import type { NotificationKind, SignalSeverity, SiteDetector } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { pushNotifications } from "../notifications/service.js";

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
export const latSchema = z.number().min(-90).max(90);
export const lonSchema = z.number().min(-180).max(180);
export const percentSchema = z.number().min(0).max(100);

/** A closed-or-open ring of [lon, lat] pairs. Three points is the minimum. */
export const ringSchema = z.array(z.tuple([lonSchema, latSchema])).min(3).max(2000);

export const todayISO = (): string => new Date().toISOString().slice(0, 10);
export const nowISO = (): string => new Date().toISOString();
export const pad3 = (n: number): string => String(n).padStart(3, "0");
export const round1 = (n: number): number => Math.round(n * 10) / 10;
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** ISO date arithmetic that never drifts on a DST boundary (UTC only). */
export function addDaysISO(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetweenISO(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

export const minutesBetween = (fromIso: string, toIso: string): number =>
  (Date.parse(toIso) - Date.parse(fromIso)) / 60_000;

export function addMinutesISO(at: string, minutes: number): string {
  return new Date(Date.parse(at) + minutes * 60_000).toISOString();
}

/* ------------------------------------------------------------------ */
/* Gates                                                               */
/* ------------------------------------------------------------------ */

export function buildGates(app: FastifyInstance) {
  return {
    readGate: [app.authenticate, app.requireCompany, app.requireTool("site_ops", "read")],
    standardGate: [app.authenticate, app.requireCompany, app.requireTool("site_ops", "standard")],
    adminGate: [app.authenticate, app.requireCompany, app.requireTool("site_ops", "admin")],
  };
}
export type SiteGates = ReturnType<typeof buildGates>;

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

export type SiteObjectType =
  | "site_induction"
  | "site_access_pass"
  | "site_gate_event"
  | "site_muster"
  | "site_muster_checkin"
  | "site_permit"
  | "site_permit_entry"
  | "site_exclusion_zone"
  | "site_lone_worker_session"
  | "site_weather_observation"
  | "site_weather_baseline"
  | "site_weather_analysis"
  | "site_drone_flight"
  | "site_scan"
  | "site_scan_deviation"
  | "site_photo_tour"
  | "site_photo_tour_station"
  | "site_survey_point"
  | "site_setting_out_record"
  | "site_geotech_investigation"
  | "site_ground_finding"
  | "site_utility_service"
  | "site_utility_strike"
  | "site_environmental_event"
  | "site_progress_observation"
  | "assertion"
  | "evidence"
  | "reconciliation"
  | "signal";

export async function ledger(
  db: Db,
  input: {
    companyId: string;
    projectId?: string | null;
    actorId: string | null;
    action: "create" | "update" | "delete" | "state_change" | "access";
    objectType: SiteObjectType;
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

export interface SiteSignalDraft {
  detector: SiteDetector;
  severity: SignalSeverity;
  confidence: number;
  title: string;
  explanation: string;
  /** dedupe key: the same condition must never be raised twice */
  key: string;
  subjectType?: string;
  subjectId?: string;
  evidence?: Record<string, unknown>;
}

/**
 * Dedupe keys already raised for these detectors in this project. Every key
 * this module mints names a record inside one project, so a per-project sweep
 * reads only that project's signals rather than the company's whole history.
 */
export async function alreadySignalled(
  db: Db,
  companyId: string,
  detectors: readonly SiteDetector[],
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
  draft: SiteSignalDraft,
): Promise<string> {
  const id = newId("sig");
  const at = nowISO();
  await db.insert(signals).values({
    id,
    companyId,
    projectId,
    detector: draft.detector,
    severity: draft.severity,
    confidence: draft.confidence,
    title: draft.title,
    explanation: draft.explanation,
    evidenceRefs: { key: draft.key, ...(draft.evidence ?? {}) },
    fingerprint: draft.key,
    subjectType: draft.subjectType ?? null,
    subjectId: draft.subjectId ?? null,
    firstSeenAt: at,
    lastSeenAt: at,
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
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

/**
 * Tell named users. A site alert with nobody to tell is not an error — the
 * sweep still records the signal — so an empty list is a silent no-op.
 */
export async function notifyUsers(
  db: Db,
  input: {
    companyId: string;
    projectId: string;
    userIds: readonly (string | null | undefined)[];
    kind?: NotificationKind;
    title: string;
    body: string;
    recordType: string;
    recordId: string;
  },
): Promise<void> {
  const unique = [...new Set(input.userIds.filter((u): u is string => Boolean(u)))];
  if (unique.length === 0) return;
  await pushNotifications(
    db,
    unique.map((userId) => ({
      companyId: input.companyId,
      userId,
      projectId: input.projectId,
      kind: input.kind ?? ("site" as NotificationKind),
      title: input.title,
      body: input.body,
      recordType: input.recordType,
      recordId: input.recordId,
    })),
  );
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

export async function assertLocation(db: Db, projectId: string, locationId: string): Promise<void> {
  const rows = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.id, locationId), eq(locations.projectId, projectId)))
    .limit(1);
  if (!rows[0]) throw badRequest(`Location ${locationId} not found in this project.`);
}

export async function assertWorker(db: Db, projectId: string, workerId: string) {
  const rows = await db
    .select({ id: workers.id, fullName: workers.fullName, vendorId: workers.vendorId })
    .from(workers)
    .where(and(eq(workers.id, workerId), eq(workers.projectId, projectId)))
    .limit(1);
  const worker = rows[0];
  if (!worker) {
    throw badRequest(
      `Worker ${workerId} is not on this project's labour register. Register the worker first (POST /projects/:projectId/workers) — the site register links INTO the workforce module, it does not keep a second one.`,
    );
  }
  return worker;
}

export async function assertTask(db: Db, projectId: string, taskId: string) {
  const rows = await db
    .select({
      id: scheduleTasks.id,
      name: scheduleTasks.name,
      startDate: scheduleTasks.startDate,
      finishDate: scheduleTasks.finishDate,
      percentComplete: scheduleTasks.percentComplete,
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
/* PATCH helpers                                                       */
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

/* ------------------------------------------------------------------ */
/* Honest figures                                                      */
/* ------------------------------------------------------------------ */

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
  inputs: Record<string, unknown> = {},
  reasons: string[] = [],
): Figure => ({ value, unit, inputs, reasons });

/** The system actor for scheduler-driven writes whose column is NOT NULL. */
export const SYSTEM_ACTOR = "system";
