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
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  companyMemberships,
  dailyLogs,
  entities,
  invoices,
  locations,
  paymentApplications,
  scheduleTasks,
  signals,
  users,
  valuations,
  vendors,
  workers,
} from "@constructos/db";
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
 * Which of these dedupe keys have already been raised for these detectors.
 *
 * `raiseSignal` writes the key to `signals.fingerprint` as well as into
 * `evidenceRefs.key`, and (companyId, detector, fingerprint) is indexed — so
 * when the caller knows the keys it is asking about (a sweep does: it has the
 * rows in hand before it decides to raise anything) this is a point lookup
 * over a handful of keys rather than a read of the company's whole signal
 * history on every five-minute tick. Callers that cannot know the keys in
 * advance fall back to the bounded scan.
 */
export async function alreadySignalled(
  db: Db,
  companyId: string,
  detectors: readonly SiteDetector[],
  options: { projectId?: string | null; keys?: readonly string[] } = {},
): Promise<Set<string>> {
  const wanted = options.keys ? [...new Set(options.keys)] : null;
  if (wanted && wanted.length === 0) return new Set();
  const rows = await db
    .select({ refs: signals.evidenceRefs, fingerprint: signals.fingerprint })
    .from(signals)
    .where(
      and(
        eq(signals.companyId, companyId),
        options.projectId ? eq(signals.projectId, options.projectId) : undefined,
        inArray(signals.detector, [...detectors]),
        wanted ? inArray(signals.fingerprint, wanted) : undefined,
      ),
    )
    .limit(wanted ? wanted.length * 4 + 50 : 20_000);
  const keys = new Set<string>();
  for (const row of rows) {
    // `fingerprint` is the fast path; `evidenceRefs.key` is what older rows
    // carry, and reading both means a signal is never raised twice because
    // the shape of the row changed.
    if (typeof row.fingerprint === "string" && row.fingerprint.length > 0) keys.add(row.fingerprint);
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

/**
 * Resolve the party a progress claim is attributed to.
 *
 * The different-actor rule is only a control if the OTHER actor exists: a
 * free-text claimant id makes "somebody else claimed this" unfalsifiable, so
 * every claimant is resolved against the register its kind names before an
 * Assertion is written in their name.
 */
export type ClaimantKind = "user" | "entity" | "vendor";

export interface ResolvedClaimant {
  kind: ClaimantKind;
  id: string;
  name: string;
}

export async function assertClaimant(
  db: Db,
  companyId: string,
  kind: ClaimantKind,
  claimantId: string,
): Promise<ResolvedClaimant> {
  if (kind === "user") {
    const row = (
      await db
        .select({ id: users.id, name: users.name })
        .from(companyMemberships)
        .innerJoin(users, eq(users.id, companyMemberships.userId))
        .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.userId, claimantId)))
        .limit(1)
    )[0];
    if (!row) {
      throw badRequest(
        `Claimant ${claimantId} is not a user of this company. A progress claim is attributed to a real party — pick the person who made it, or record the claim against their vendor or entity instead.`,
      );
    }
    return { kind, id: row.id, name: row.name };
  }
  if (kind === "vendor") {
    const row = (
      await db
        .select({ id: vendors.id, name: vendors.name })
        .from(vendors)
        .where(and(eq(vendors.id, claimantId), eq(vendors.companyId, companyId)))
        .limit(1)
    )[0];
    if (!row) throw badRequest(`Claimant vendor ${claimantId} is not in this company's directory.`);
    return { kind, id: row.id, name: row.name };
  }
  const row = (
    await db
      .select({ id: entities.id, name: entities.name })
      .from(entities)
      .where(and(eq(entities.id, claimantId), eq(entities.companyId, companyId), isNull(entities.deletedAt)))
      .limit(1)
  )[0];
  if (!row) throw badRequest(`Claimant entity ${claimantId} is not in this company's entity register.`);
  return { kind, id: row.id, name: row.name };
}

/**
 * The record a claim came from. An id stored on an Assertion as its source
 * must point at something: a valuation, an application, a daily log or a
 * schedule task in THIS project. A `manual` claim has no record, so an id
 * given with it is refused rather than kept as decoration.
 */
export async function assertClaimSource(
  db: Db,
  companyId: string,
  projectId: string,
  sourceType: string,
  sourceId: string,
): Promise<void> {
  type SourceTable = typeof valuations | typeof paymentApplications | typeof dailyLogs | typeof invoices;
  const exists = async (table: SourceTable): Promise<boolean> => {
    const rows = await db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, sourceId), eq(table.companyId, companyId), eq(table.projectId, projectId)))
      .limit(1);
    return Boolean(rows[0]);
  };
  const found = async (tables: readonly SourceTable[], label: string) => {
    for (const table of tables) {
      if (await exists(table)) return;
    }
    throw badRequest(`${label} ${sourceId} was not found in this project, so it cannot be the source of the claim.`);
  };
  switch (sourceType) {
    case "valuation":
      return found([valuations], "Valuation");
    case "progress_claim":
      // A progress claim reaches the platform as a payment application, a
      // subcontractor invoice or a valuation depending on the contract form.
      return found([paymentApplications, invoices, valuations], "Progress claim");
    case "application":
      return found([paymentApplications, invoices], "Payment application");
    case "daily_log":
      return found([dailyLogs], "Daily log");
    case "schedule_update": {
      await assertTask(db, projectId, sourceId);
      return;
    }
    default:
      throw badRequest(
        `A ${sourceType.replace(/_/g, " ")} claim has no record to point at, so a claim source id cannot be stored against it. Choose the source type that names the record, or leave the id off.`,
      );
  }
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
