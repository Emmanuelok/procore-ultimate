/**
 * Shared plumbing for the BIM module: gates, record loaders, the ledger
 * wrapper, the signal helper and the small pure helpers every route file
 * needs.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 *   An id-scoped route (`/bim/models/:modelId`, `/bim/issues/:issueId`, ...)
 *   used to be gated on company membership alone, so a user on a template
 *   with `bim: none` - or one who is not a member of the project at all -
 *   could rename a model, publish a version (the ISO 19650 authorisation
 *   step), or void a coordination issue by guessing an id. `requireToolFor`
 *   resolves the record's project first and then runs the SAME `requireTool`
 *   gate the project-scoped routes carry, so both paths enforce one rule.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bimModelVersions,
  bimModels,
  clashTests,
  companyMemberships,
  coordinationIssues,
  federationGroups,
  projectMemberships,
  realityCaptures,
  signals,
  users,
} from "@constructos/db";
import type { BimDetector, PermissionLevel, SignalSeverity } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, notFound } from "../../lib/errors.js";

/* ------------------------------------------------------------------ */
/* Wire formats                                                        */
/* ------------------------------------------------------------------ */

export const idSchema = z.string().min(1).max(64);

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");

export const isoTimestampSchema = z
  .string()
  .min(4)
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid timestamp");

export const nowISO = (): string => new Date().toISOString();
export const todayISO = (): string => new Date().toISOString().slice(0, 10);

/** Deterministic content hash of an element's data - drives version diffs. */
export function propertyHash(input: {
  name: string | null;
  ifcType: string;
  typeName?: string | null;
  classification?: string | null;
  storey?: string | null;
  properties: Record<string, unknown>;
  bounds?: unknown;
}): string {
  const keys = Object.keys(input.properties).sort();
  const flat = keys.map((k) => `${k}=${JSON.stringify(input.properties[k] ?? null)}`).join("|");
  const payload = [
    input.ifcType,
    input.name ?? "",
    input.typeName ?? "",
    input.classification ?? "",
    input.storey ?? "",
    JSON.stringify(input.bounds ?? null),
    flat,
  ].join("|");
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

/* ------------------------------------------------------------------ */
/* Gates                                                               */
/* ------------------------------------------------------------------ */

export function buildBimGates(app: FastifyInstance) {
  const tool = (level: PermissionLevel) => [
    app.authenticate,
    app.requireCompany,
    app.requireTool("bim", level),
  ];
  return {
    readGate: tool("read"),
    standardGate: tool("standard"),
    adminGate: tool("admin"),
    /** company-level routes with no project in the path */
    companyGate: [app.authenticate, app.requireCompany],
    /**
     * Enforce the bim tool level against a project resolved from a record.
     * The project id is written into req.params so the same requireTool
     * closure (project membership, template level, assurance read grants,
     * owner/admin bypass) runs exactly as it does on a project-scoped route.
     */
    async requireToolFor(
      req: FastifyRequest,
      reply: FastifyReply,
      projectId: string,
      level: PermissionLevel,
      toolKey: "bim" | "twin" = "bim",
    ): Promise<void> {
      (req.params as Record<string, string>)["projectId"] = projectId;
      await app.requireTool(toolKey, level)(req, reply);
    },
  };
}

export type BimGates = ReturnType<typeof buildBimGates>;

/* ------------------------------------------------------------------ */
/* Record loaders (tenant-scoped)                                      */
/* ------------------------------------------------------------------ */

export function buildLoaders(app: FastifyInstance) {
  async function getModel(modelId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(bimModels)
      .where(and(eq(bimModels.id, modelId), eq(bimModels.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Model not found");
    return rows[0];
  }

  async function getVersion(versionId: string, companyId: string) {
    const rows = await app.db
      .select({ version: bimModelVersions, model: bimModels })
      .from(bimModelVersions)
      .innerJoin(bimModels, eq(bimModels.id, bimModelVersions.modelId))
      .where(and(eq(bimModelVersions.id, versionId), eq(bimModels.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Model version not found");
    return rows[0];
  }

  async function getIssue(issueId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(coordinationIssues)
      .where(and(eq(coordinationIssues.id, issueId), eq(coordinationIssues.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Coordination issue not found");
    return rows[0];
  }

  async function getFederation(groupId: string, companyId: string, projectId?: string) {
    const conds = [eq(federationGroups.id, groupId), eq(federationGroups.companyId, companyId)];
    if (projectId) conds.push(eq(federationGroups.projectId, projectId));
    const rows = await app.db
      .select()
      .from(federationGroups)
      .where(and(...conds))
      .limit(1);
    if (!rows[0]) throw notFound("Federation group not found");
    return rows[0];
  }

  async function getClashTest(testId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(clashTests)
      .where(and(eq(clashTests.id, testId), eq(clashTests.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Clash test not found");
    return rows[0];
  }

  async function getCapture(captureId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(realityCaptures)
      .where(and(eq(realityCaptures.id, captureId), eq(realityCaptures.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Reality capture not found");
    return rows[0];
  }

  return { getModel, getVersion, getIssue, getFederation, getClashTest, getCapture };
}

export type BimLoaders = ReturnType<typeof buildLoaders>;

/* ------------------------------------------------------------------ */
/* People referenced by coordination records                           */
/* ------------------------------------------------------------------ */

/**
 * Every user id written onto a coordination record must be someone who can
 * actually act on that record: a member of the tenant AND a member of the
 * project (company owners and admins see every project, so they pass on the
 * company role alone).
 *
 * The company half closes the cross-tenant leak — an assignee id resolves to
 * a name and an email in the register, so a foreign id would surface another
 * tenant's user. The project half closes the intra-tenant half: assignment
 * sends a notification carrying the issue number and title, and a colleague
 * with no access to the project should not receive it, let alone be recorded
 * as responsible for a record they cannot open.
 */
export async function assertAssignable(
  db: Db,
  companyId: string,
  projectId: string,
  ids: Array<string | null | undefined>,
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
  if (missing) throw badRequest(`User "${missing}" is not a member of this company`);

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
    throw badRequest(`User "${notOnProject}" is not a member of this project`);
  }
}

/**
 * Resolve display names for user ids held on records — tenant-scoped, so an
 * id that somehow got past validation still cannot surface another company's
 * user. Unknown ids are simply absent from the map and render as the raw id.
 */
export async function resolvePeople(
  db: Db,
  companyId: string,
  ids: Array<string | null | undefined>,
): Promise<Record<string, { id: string; name: string; email: string }>> {
  const wanted = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  if (wanted.length === 0) return {};
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .innerJoin(companyMemberships, eq(companyMemberships.userId, users.id))
    .where(
      and(eq(companyMemberships.companyId, companyId), inArray(users.id, wanted)),
    );
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

/* ------------------------------------------------------------------ */
/* Ledger + signals                                                    */
/* ------------------------------------------------------------------ */

export type BimObjectType =
  | "bim_model"
  | "bim_model_version"
  | "bim_element_link"
  | "bim_version_diff"
  | "clash_test"
  | "clash_result"
  | "coordination_issue"
  | "coordination_issue_comment"
  | "federation_group"
  | "federation_member"
  | "reality_capture"
  | "geofence"
  | "signal"
  | "rfi"
  | "file";

export async function ledger(
  db: Db,
  entry: {
    companyId: string;
    projectId?: string | null;
    actorId: string | null;
    action: "create" | "update" | "delete" | "state_change" | "access";
    objectType: BimObjectType;
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
 * Close a signal whose condition no longer holds, so a resolved clash set or
 * a fixed ingestion does not leave a permanent red mark on the register.
 * Returns how many signals were closed.
 */
export async function closeSignal(
  db: Db,
  companyId: string,
  detector: BimDetector,
  key: string,
  reason: string,
): Promise<number> {
  const at = nowISO();
  const closed = await db
    .update(signals)
    .set({
      disposition: "closed",
      closedAt: at,
      autoClosedAt: at,
      reviewerNotes: reason,
    })
    .where(
      and(
        eq(signals.companyId, companyId),
        eq(signals.detector, detector),
        eq(signals.fingerprint, key),
        ne(signals.disposition, "closed"),
      ),
    )
    .returning({ id: signals.id });
  return closed.length;
}

export interface SignalDraft {
  detector: BimDetector;
  severity: SignalSeverity;
  confidence: number;
  title: string;
  explanation: string;
  /** dedupe key - the same condition never raises a second signal */
  key: string;
  evidence?: Record<string, unknown>;
  subjectType?: string;
  subjectId?: string;
}

/**
 * Raise a signal for a condition, or refresh the one already on the register.
 *
 * Three cases, and the difference between them is the whole point:
 *   - no row yet            -> insert, ledger the discovery, return the id.
 *   - row still open        -> bump lastSeenAt/occurrences, return null (this
 *                              is not a new discovery, so no second ledger
 *                              entry and no second notification).
 *   - row AUTO-closed       -> the detector previously observed the condition
 *                              clearing and closed its own signal. The
 *                              condition is back, so re-open the same row
 *                              (disposition 'new', closedAt/autoClosedAt
 *                              cleared) and ledger it. Without this the
 *                              close/raise cycle only ever runs once and the
 *                              detector goes permanently silent for that key.
 *   - row closed BY A HUMAN -> leave it closed. A reviewer dismissing a
 *                              finding must not be overruled by the next
 *                              sweep, or the register becomes noise again.
 */
export async function raiseSignal(
  db: Db,
  companyId: string,
  projectId: string | null,
  actorId: string | null,
  draft: SignalDraft,
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
