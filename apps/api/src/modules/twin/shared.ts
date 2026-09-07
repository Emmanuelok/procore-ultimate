/**
 * Shared plumbing for the digital twin module: gates, loaders, the ledger
 * wrapper, the signal helper and the date/CSV rules the whole module obeys.
 *
 * Two rules live here rather than being restated in six route files:
 *
 *  - AUTHORISATION. Every id-scoped route (`/assets/:id`, `/sensors/:id`,
 *    `/warranties/:id`) resolves the record's project and runs the same
 *    `requireTool("twin", level)` gate the project-scoped routes carry.
 *    Before this, any company member could delete an asset or unbind a
 *    sensor; a `twin: read` user had full destructive access by id.
 *  - DATES ARE DATES. Free-text dates were compared lexically, so
 *    "01/06/2026" sorted before "2026-01-01" and warranties silently vanished
 *    from the expiry report. Every date field in this module is a strict
 *    YYYY-MM-DD and orderings are re-checked on patch as well as on create.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  assets,
  companyMemberships,
  projectMemberships,
  sensors,
  signals,
  users,
  warranties,
} from "@constructos/db";
import type { BimDetector, PermissionLevel, SignalSeverity } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, notFound } from "../../lib/errors.js";

/* ------------------------------------------------------------------ */
/* Wire formats                                                        */
/* ------------------------------------------------------------------ */

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)")
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "Not a real calendar date");

export const isoTimestampSchema = z
  .string()
  .min(4)
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid timestamp");

export const nowISO = (): string => new Date().toISOString();
export const todayISO = (): string => new Date().toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  return Math.round((b - a) / 86_400_000);
}

/**
 * CSV cell with spreadsheet-formula neutralisation. A COBie export is opened
 * by the FM team in Excel; a value beginning `=`, `+`, `-`, `@`, tab or CR is
 * a formula there, so it is prefixed and quoted rather than emitted raw.
 */
export function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  const neutralised = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(neutralised) ? `"${neutralised.replace(/"/g, '""')}"` : neutralised;
}

/* ------------------------------------------------------------------ */
/* Gates                                                               */
/* ------------------------------------------------------------------ */

export function buildTwinGates(app: FastifyInstance) {
  const tool = (level: PermissionLevel) => [
    app.authenticate,
    app.requireCompany,
    app.requireTool("twin", level),
  ];
  return {
    readGate: tool("read"),
    standardGate: tool("standard"),
    adminGate: tool("admin"),
    companyGate: [app.authenticate, app.requireCompany],
    async requireToolFor(
      req: FastifyRequest,
      reply: FastifyReply,
      projectId: string,
      level: PermissionLevel,
    ): Promise<void> {
      (req.params as Record<string, string>)["projectId"] = projectId;
      await app.requireTool("twin", level)(req, reply);
    },
  };
}

export type TwinGates = ReturnType<typeof buildTwinGates>;

/* ------------------------------------------------------------------ */
/* Loaders                                                             */
/* ------------------------------------------------------------------ */

export function buildTwinLoaders(app: FastifyInstance) {
  async function getAsset(assetId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Asset not found");
    return rows[0];
  }

  async function getSensor(sensorId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(sensors)
      .where(and(eq(sensors.id, sensorId), eq(sensors.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Sensor not found");
    return rows[0];
  }

  async function getWarranty(warrantyId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(warranties)
      .where(and(eq(warranties.id, warrantyId), eq(warranties.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Warranty not found");
    return rows[0];
  }

  return { getAsset, getSensor, getWarranty };
}

export type TwinLoaders = ReturnType<typeof buildTwinLoaders>;

/* ------------------------------------------------------------------ */
/* People named on twin records                                        */
/* ------------------------------------------------------------------ */

/**
 * An asset or sensor owner is not a label: threshold breaches, staleness and
 * warranty expiry all notify that person, and the alert names the project.
 * So the owner must be a member of the tenant AND able to open the project —
 * company membership alone let a colleague with no access to the project be
 * recorded as responsible for equipment they cannot see, and then paged about
 * it at 3am.
 *
 * Company owners and admins pass on their company role, exactly as
 * `requireTool` lets them into every project.
 */
export async function assertAssignable(
  db: Db,
  companyId: string,
  projectId: string,
  ids: Array<string | null | undefined>,
  label = "Owner",
): Promise<void> {
  const wanted = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  if (wanted.length === 0) return;
  const company = await db
    .select({ userId: companyMemberships.userId, role: companyMemberships.role })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        inArray(companyMemberships.userId, wanted),
      ),
    );
  const roleByUser = new Map(company.map((r) => [r.userId, r.role]));
  const missing = wanted.find((id) => !roleByUser.has(id));
  if (missing) throw badRequest(`${label} must be a member of this company`);

  const needProject = wanted.filter((id) => {
    const role = roleByUser.get(id);
    return role !== "owner" && role !== "admin";
  });
  if (needProject.length === 0) return;
  const onProject = await db
    .select({ userId: projectMemberships.userId })
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.projectId, projectId),
        eq(projectMemberships.companyId, companyId),
        inArray(projectMemberships.userId, needProject),
      ),
    );
  const found = new Set(onProject.map((r) => r.userId));
  const notOnProject = needProject.find((id) => !found.has(id));
  if (notOnProject) {
    throw badRequest(`${label} must be a member of this project`);
  }
}

/**
 * The read side of `assertAssignable` — the owner picker reads this so it can
 * only offer people the writer will accept.
 */
export async function listAssignable(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<
  Array<{ id: string; name: string; email: string; basis: "project_member" | "company_admin" }>
> {
  const companyRows = await db
    .select({
      userId: companyMemberships.userId,
      role: companyMemberships.role,
      name: users.name,
      email: users.email,
    })
    .from(companyMemberships)
    .innerJoin(users, eq(users.id, companyMemberships.userId))
    .where(eq(companyMemberships.companyId, companyId))
    .limit(1000);
  const onProject = new Set(
    (
      await db
        .select({ userId: projectMemberships.userId })
        .from(projectMemberships)
        .where(
          and(
            eq(projectMemberships.projectId, projectId),
            eq(projectMemberships.companyId, companyId),
          ),
        )
        .limit(1000)
    ).map((r) => r.userId),
  );
  return companyRows
    .filter((r) => onProject.has(r.userId) || r.role === "owner" || r.role === "admin")
    .map((r) => ({
      id: r.userId,
      name: r.name,
      email: r.email,
      basis: onProject.has(r.userId)
        ? ("project_member" as const)
        : ("company_admin" as const),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ */
/* Ledger + signals                                                    */
/* ------------------------------------------------------------------ */

export type TwinObjectType =
  | "asset"
  | "asset_element_link"
  | "sensor"
  | "sensor_reading_batch"
  | "sensor_alert"
  | "warranty"
  | "warranty_claim"
  | "delivery_milestone"
  | "milestone_container"
  | "obligation"
  | "signal";

export async function ledger(
  db: Db,
  entry: {
    companyId: string;
    projectId?: string | null;
    actorId: string | null;
    action: "create" | "update" | "delete" | "state_change" | "access";
    objectType: TwinObjectType;
    objectId: string;
    payload?: unknown;
    storePayload?: boolean;
  },
): Promise<void> {
  await appendLedger(db, {
    companyId: entry.companyId,
    actorId: entry.actorId,
    action: entry.action,
    objectType: entry.objectType,
    objectId: entry.objectId,
    payload: entry.payload,
    projectId: entry.projectId ?? undefined,
    storePayload: entry.storePayload,
  });
}

/**
 * Close a signal whose condition the detector has observed clearing.
 *
 * `autoClosedAt` is what separates this from a human dismissal: a signal the
 * platform closed itself may be re-opened by `raiseTwinSignal` when the
 * condition returns, while one a reviewer dismissed stays dismissed.
 */
export async function closeTwinSignalById(
  db: Db,
  signalId: string,
  companyId: string,
  reason: string,
): Promise<number> {
  const at = nowISO();
  const closed = await db
    .update(signals)
    .set({ disposition: "closed", closedAt: at, autoClosedAt: at, reviewerNotes: reason })
    .where(
      and(
        eq(signals.id, signalId),
        eq(signals.companyId, companyId),
        ne(signals.disposition, "closed"),
      ),
    )
    .returning({ id: signals.id });
  return closed.length;
}

export interface TwinSignalDraft {
  detector: BimDetector;
  severity: SignalSeverity;
  confidence: number;
  title: string;
  explanation: string;
  key: string;
  evidence?: Record<string, unknown>;
  subjectType?: string;
  subjectId?: string;
}

/**
 * Raise a signal for a condition, refresh the one already open, or re-open the
 * one this detector auto-closed when the condition returns.
 *
 * The auto-close branch is why this is not a plain "insert if absent": a
 * sensor that recovers auto-closes its stale/threshold signal, and without a
 * re-open path the very next breach of the SAME sensor and bound would raise
 * nothing at all — the detector would go silent forever. A signal a human
 * dismissed stays dismissed; that is a judgement, not a cleared condition.
 */
export async function raiseTwinSignal(
  db: Db,
  companyId: string,
  projectId: string | null,
  actorId: string | null,
  draft: TwinSignalDraft,
): Promise<string | null> {
  const at = nowISO();
  const existing = await db
    .select({
      id: signals.id,
      disposition: signals.disposition,
      autoClosedAt: signals.autoClosedAt,
    })
    .from(signals)
    .where(
      and(
        eq(signals.companyId, companyId),
        eq(signals.detector, draft.detector),
        eq(signals.fingerprint, draft.key),
      ),
    )
    .limit(1);
  const prior = existing[0];
  if (prior) {
    const humanDismissed = prior.disposition === "closed" && !prior.autoClosedAt;
    if (humanDismissed) return null;
    const reopening = prior.disposition === "closed";
    await db
      .update(signals)
      .set({
        lastSeenAt: at,
        occurrences: sql`${signals.occurrences} + 1`,
        severity: draft.severity,
        title: draft.title,
        explanation: draft.explanation,
        evidenceRefs: { key: draft.key, ...(draft.evidence ?? {}) },
        ...(reopening
          ? {
              disposition: "new" as const,
              closedAt: null,
              autoClosedAt: null,
              reviewerNotes: null,
              reviewerId: null,
            }
          : {}),
      })
      .where(eq(signals.id, prior.id));
    if (!reopening) return null;
    await ledger(db, {
      companyId,
      projectId,
      actorId,
      action: "state_change",
      objectType: "signal",
      objectId: prior.id,
      payload: {
        detector: draft.detector,
        severity: draft.severity,
        key: draft.key,
        reopened: true,
      },
    });
    return prior.id;
  }
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
