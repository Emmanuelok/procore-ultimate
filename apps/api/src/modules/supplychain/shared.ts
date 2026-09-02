/**
 * Shared plumbing for the supply chain module: gates, wire formats, the
 * ledger wrapper, the signal helper and the cross-register reference checks.
 *
 * Two rules live here rather than being restated in six route files:
 *
 *  - LEDGER. Every consequential mutation appends. `ledger()` fixes the
 *    object-type vocabulary so the register reads as one chain.
 *  - IDEMPOTENT SIGNALS. A sweep that re-detects the same condition must
 *    produce nothing the second time. `alreadySignalled` reads the dedupe
 *    keys carried in `signals.evidenceRefs.key`, the platform convention.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  locations,
  materialItems,
  scheduleTasks,
  signals,
  supplyChainNodes,
  vendors,
} from "@constructos/db";
import type { SignalSeverity, SupplyChainDetector } from "@constructos/shared";
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
export const countryCodeSchema = z.string().trim().min(2).max(3).toUpperCase();

export const todayISO = (): string => new Date().toISOString().slice(0, 10);
export const nowISO = (): string => new Date().toISOString();
export const pad3 = (n: number): string => String(n).padStart(3, "0");
export const round1 = (n: number): number => Math.round(n * 10) / 10;
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ */
/* Gates                                                               */
/* ------------------------------------------------------------------ */

export function buildGates(app: FastifyInstance) {
  return {
    readGate: [app.authenticate, app.requireCompany, app.requireTool("supply_chain", "read")],
    standardGate: [
      app.authenticate,
      app.requireCompany,
      app.requireTool("supply_chain", "standard"),
    ],
    adminGate: [app.authenticate, app.requireCompany, app.requireTool("supply_chain", "admin")],
  };
}
export type SupplyGates = ReturnType<typeof buildGates>;

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

export type SupplyObjectType =
  | "supply_chain_node"
  | "supply_chain_link"
  | "long_lead_item"
  | "long_lead_expediting"
  | "offsite_unit"
  | "offsite_production_stage"
  | "factory_inspection"
  | "site_gate"
  | "delivery_slot"
  | "material_trace_record"
  | "supplier_risk_assessment"
  | "carbon_entry"
  | "signal";

export async function ledger(
  db: Db,
  input: {
    companyId: string;
    projectId?: string | null;
    actorId: string | null;
    action: "create" | "update" | "delete" | "state_change" | "access";
    objectType: SupplyObjectType;
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

export interface SupplySignalDraft {
  detector: SupplyChainDetector;
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
  detectors: readonly SupplyChainDetector[],
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
  draft: SupplySignalDraft,
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

export async function assertNode(db: Db, projectId: string, nodeId: string) {
  const rows = await db
    .select()
    .from(supplyChainNodes)
    .where(and(eq(supplyChainNodes.id, nodeId), eq(supplyChainNodes.projectId, projectId)))
    .limit(1);
  const node = rows[0];
  if (!node) throw badRequest(`Supply chain node ${nodeId} not found in this project.`);
  return node;
}

export async function assertLocation(db: Db, projectId: string, locationId: string): Promise<void> {
  const rows = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.id, locationId), eq(locations.projectId, projectId)))
    .limit(1);
  if (!rows[0]) throw badRequest(`Location ${locationId} not found in this project.`);
}

export async function assertMaterialItem(
  db: Db,
  companyId: string,
  materialItemId: string,
): Promise<void> {
  const rows = await db
    .select({ id: materialItems.id })
    .from(materialItems)
    .where(and(eq(materialItems.id, materialItemId), eq(materialItems.companyId, companyId)))
    .limit(1);
  if (!rows[0]) {
    throw badRequest(
      `Material item ${materialItemId} not found in this company's catalogue. Register it first (POST /projects/:projectId/materials) — traceability links INTO that register, it does not keep a second one.`,
    );
  }
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
      constraintDate: scheduleTasks.constraintDate,
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
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

/**
 * `.partial()` keeps every `.default()`, so a PATCH parsed through it would
 * silently reset untouched columns (tier → 1, lead time → 0, crane → off).
 * Strip the defaults first: a PATCH body is only what the caller sent.
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

/** The system actor for scheduler-driven writes whose column is NOT NULL. */
export const SYSTEM_ACTOR = "system";
