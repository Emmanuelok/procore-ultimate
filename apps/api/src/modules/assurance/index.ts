import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, gte, ilike, inArray, lt, lte, or } from "drizzle-orm";
import { z } from "zod";
import {
  assertions,
  assuranceGrants,
  entities,
  entityRelationships,
  events,
  evidence,
  files,
  ledgerEntries,
  obligations,
  reconciliations,
  signals,
  workflowInstances,
  workflowStepInstances,
} from "@constructos/db";
import {
  ASSERTION_KINDS,
  ENTITY_KINDS,
  ENTITY_RELATIONSHIP_KINDS,
  EVIDENCE_KINDS,
  RECONCILIATION_RESULTS,
  SIGNAL_DISPOSITIONS,
  type AssuranceRole,
  type ReconciliationResult,
} from "@constructos/shared";
import {
  hashPayload,
  merkleProof,
  merkleRoot,
  verifyChain,
  type ChainedEntry,
} from "@constructos/ledger";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import type { Db } from "../../lib/db.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isExpired } from "../../lib/time.js";
import {
  DETECTOR_NAMES,
  approvalVelocity,
  benfordFirstDigit,
  contradictedClaimant,
  duplicateAssertions,
  roundNumberClustering,
  segregationOfDuties,
  type DetectorName,
  type SignalDraft,
} from "./detectors.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

/** Lenient ISO timestamp (avoids zod version drift on .datetime()). */
const isoTimestamp = z
  .string()
  .min(4)
  .refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO timestamp");

const assertionCreateSchema = z.object({
  kind: z.enum(ASSERTION_KINDS),
  value: z.number().finite().nullable().optional(),
  unit: z.string().max(50).nullable().optional(),
  basis: z.string().min(1).max(2000),
  contractRef: z.string().max(500).nullable().optional(),
  sourceType: z.string().max(100).nullable().optional(),
  sourceId: z.string().max(64).nullable().optional(),
  assertedAt: isoTimestamp.optional(),
  claimantId: z.string().max(64).optional(),
  claimantKind: z.enum(["user", "entity"]).optional(),
});

const assertionListSchema = pageQuerySchema.extend({
  kind: z.enum(ASSERTION_KINDS).optional(),
  claimantId: z.string().optional(),
  sourceType: z.string().optional(),
  sourceId: z.string().optional(),
});

const evidenceJsonSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  source: z.string().min(1).max(500),
  capturedAt: isoTimestamp.optional(),
  independenceScore: z.number().min(0).max(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const evidenceMultipartSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  source: z.string().min(1).max(500),
  capturedAt: isoTimestamp.optional(),
  independenceScore: z.coerce.number().min(0).max(1).optional(),
});

const reconciliationCreateSchema = z.object({
  assertionId: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)).min(1).max(200),
  method: z.string().min(1).max(200),
  notes: z.string().max(4000).optional(),
  /** required only when method is "manual" and no numeric evidence exists */
  result: z.enum(RECONCILIATION_RESULTS).optional(),
});

const dispositionSchema = z.object({
  disposition: z.string().min(1).max(100),
  notes: z.string().max(4000).optional(),
});

const obligationCreateSchema = z.object({
  sourceClause: z.string().min(1).max(1000),
  trigger: z.string().min(1).max(1000),
  obligorId: z.string().max(64).nullable().optional(),
  obligeeId: z.string().max(64).nullable().optional(),
  deadline: isoTimestamp.nullable().optional(),
  warnDaysBefore: z.number().min(0).max(365).nullable().optional(),
  evidenceRequirement: z.string().max(2000).nullable().optional(),
});

const obligationPatchSchema = obligationCreateSchema.partial();

const eventCreateSchema = z.object({
  type: z.string().min(1).max(200),
  occurredAt: isoTimestamp,
  location: z.string().max(500).nullable().optional(),
  detectedOrReported: z.enum(["detected", "reported"]).optional(),
  causalLinks: z.array(z.string()).max(100).optional(),
  payload: z.unknown().optional(),
});

const entityCreateSchema = z.object({
  kind: z.enum(ENTITY_KINDS),
  name: z.string().min(1).max(300),
  identifiers: z.record(z.string(), z.string()).optional(),
  jurisdiction: z.string().max(100).nullable().optional(),
  screeningStatus: z.string().max(50).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

const entityPatchSchema = entityCreateSchema.partial();

const relationshipCreateSchema = z.object({
  toEntityId: z.string().min(1),
  kind: z.enum(ENTITY_RELATIONSHIP_KINDS),
  since: z.string().max(50).nullable().optional(),
  source: z.string().max(500).nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
});

const signalDispositionSchema = z.object({
  disposition: z.enum(SIGNAL_DISPOSITIONS),
  reviewerNotes: z.string().max(4000).optional(),
});

const signalListSchema = pageQuerySchema.extend({
  projectId: z.string().optional(),
  severity: z.string().optional(),
  disposition: z.string().optional(),
});

const detectorsRunSchema = z.object({
  detectors: z.array(z.string()).max(20).optional(),
});

const evidencePackSchema = z.object({
  evidenceIds: z.array(z.string().min(1)).min(1).max(500),
});

const ledgerListSchema = pageQuerySchema.extend({
  objectType: z.string().optional(),
  objectId: z.string().optional(),
});

/**
 * Verify a company's hash chain.
 *
 * The `at` timestamp is normalised back to the exact ISO-8601 form it was
 * hashed in: Postgres/PGlite round-trip "2026-01-01T00:00:00.000Z" as
 * "2026-01-01 00:00:00+00", and hashing the round-tripped spelling reports a
 * false chain break on the first entry. `lib/ledger.ts verifyCompanyLedger`
 * now normalises identically; this stays because the route also wants the
 * count, and the two must not drift.
 */
async function verifyLedgerNormalized(db: Db, companyId: string) {
  const rows = await db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.companyId, companyId))
    .orderBy(asc(ledgerEntries.seq));
  const entries: ChainedEntry[] = rows.map((r) => ({
    companyId: r.companyId,
    actorId: r.actorId,
    action: r.action,
    objectType: r.objectType,
    objectId: r.objectId,
    payloadHash: r.payloadHash,
    at: new Date(r.at).toISOString(),
    prevHash: r.prevHash,
    entryHash: r.entryHash,
  }));
  return { count: entries.length, ...verifyChain(entries) };
}

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

export const assuranceModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("assurance", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("assurance", "standard"),
  ];
  const companyGate = [app.authenticate, app.requireCompany];

  /** Does the caller hold one of these assurance roles (unexpired, tenant- or project-scoped)? */
  async function holdsAssuranceRole(
    req: FastifyRequest,
    roles: AssuranceRole[],
    projectId?: string | null,
  ): Promise<boolean> {
    const rows = await app.db
      .select()
      .from(assuranceGrants)
      .where(
        and(
          eq(assuranceGrants.companyId, req.companyId!),
          eq(assuranceGrants.userId, req.user!.id),
        ),
      );
    // Instant comparison, not string comparison: Postgres returns
    // "2026-08-25 23:00:00+00" and toISOString() produces
    // "2026-08-25T10:00:00.000Z", and a space sorts before "T" — so a grant
    // live until 23:00 read as expired at 10:00 on its own expiry day.
    const nowMs = Date.now();
    return rows.some(
      (g) =>
        roles.includes(g.role as AssuranceRole) &&
        !isExpired(g.expiresAt, nowMs) &&
        (!g.projectId || !projectId || g.projectId === projectId),
    );
  }

  async function insertSignal(
    companyId: string,
    projectId: string | null,
    actorId: string,
    draft: SignalDraft,
  ): Promise<string> {
    const id = newId("sig");
    await app.db.insert(signals).values({
      id,
      companyId,
      projectId,
      detector: draft.detector,
      severity: draft.severity,
      confidence: draft.confidence,
      title: draft.title,
      explanation: draft.explanation,
      evidenceRefs: draft.evidenceRefs,
    });
    await appendLedger(app.db, {
      companyId,
      actorId,
      action: "create",
      objectType: "signal",
      objectId: id,
      payload: { detector: draft.detector, severity: draft.severity, title: draft.title },
    });
    return id;
  }

  /* ---------------------------------------------------------------- */
  /* 1. Assertions                                                     */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/assertions", { preHandler: standardGate }, async (req, reply) => {
    const body = assertionCreateSchema.parse(req.body);
    if (body.claimantKind === "entity" && !body.claimantId) {
      throw badRequest("claimantId is required when claimantKind is entity");
    }
    const id = newId("asr");
    const row = {
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      kind: body.kind,
      claimantId: body.claimantId ?? req.user!.id,
      claimantKind: body.claimantKind ?? "user",
      value: body.value ?? null,
      unit: body.unit ?? null,
      basis: body.basis,
      contractRef: body.contractRef ?? null,
      sourceType: body.sourceType ?? null,
      sourceId: body.sourceId ?? null,
      assertedAt: body.assertedAt ?? new Date().toISOString(),
    };
    await app.db.insert(assertions).values(row);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "assertion",
      objectId: id,
      payload: row,
      storePayload: true,
    });
    return reply.status(201).send(row);
  });

  app.get("/projects/:projectId/assertions", { preHandler: readGate }, async (req) => {
    const q = assertionListSchema.parse(req.query);
    const where = and(
      eq(assertions.companyId, req.companyId!),
      eq(assertions.projectId, req.projectId!),
      q.kind ? eq(assertions.kind, q.kind) : undefined,
      q.claimantId ? eq(assertions.claimantId, q.claimantId) : undefined,
      q.sourceType ? eq(assertions.sourceType, q.sourceType) : undefined,
      q.sourceId ? eq(assertions.sourceId, q.sourceId) : undefined,
    );
    const items = await app.db
      .select()
      .from(assertions)
      .where(where)
      .orderBy(desc(assertions.assertedAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(assertions).where(where);
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/assertions/:assertionId", { preHandler: readGate }, async (req) => {
    const { assertionId } = req.params as { assertionId: string };
    const rows = await app.db
      .select()
      .from(assertions)
      .where(
        and(
          eq(assertions.id, assertionId),
          eq(assertions.companyId, req.companyId!),
          eq(assertions.projectId, req.projectId!),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Assertion not found");
    return rows[0];
  });

  /* ---------------------------------------------------------------- */
  /* 2. Evidence (immutable — create + read only)                      */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/evidence", { preHandler: standardGate }, async (req, reply) => {
    const id = newId("evd");
    const now = new Date().toISOString();

    let row;
    if (req.isMultipart()) {
      const mp = await req.file();
      if (!mp) throw badRequest("Expected a multipart file upload");
      const buf = await mp.toBuffer();
      const fieldVal = (name: string): string | undefined => {
        const raw = (mp.fields as Record<string, unknown>)[name];
        const f = Array.isArray(raw) ? raw[0] : raw;
        const v = (f as { value?: unknown } | undefined)?.value;
        return typeof v === "string" ? v : undefined;
      };
      const fields = evidenceMultipartSchema.parse({
        kind: fieldVal("kind"),
        source: fieldVal("source"),
        capturedAt: fieldVal("capturedAt"),
        independenceScore: fieldVal("independenceScore"),
      });
      let metadata: Record<string, unknown> = {};
      const metaRaw = fieldVal("metadata");
      if (metaRaw) {
        try {
          const parsed: unknown = JSON.parse(metaRaw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            metadata = parsed as Record<string, unknown>;
          } else throw new Error("not an object");
        } catch {
          throw badRequest("metadata must be a JSON object string");
        }
      }
      const saved = await app.storage.saveBuffer(req.companyId!, buf);
      const fileId = newId("fil");
      await app.db.insert(files).values({
        id: fileId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        folderId: null,
        name: mp.filename || "evidence",
        contentType: mp.mimetype || "application/octet-stream",
        sizeBytes: saved.sizeBytes,
        sha256: saved.sha256,
        storageKey: saved.storageKey,
        metadata: { evidence: true },
        uploadedBy: req.user!.id,
      });
      row = {
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        kind: fields.kind,
        source: fields.source,
        contentHash: saved.sha256,
        fileId,
        capturedAt: fields.capturedAt ?? null,
        independenceScore: fields.independenceScore ?? 0,
        provenance: {
          submittedBy: req.user!.id,
          via: "multipart_upload",
          filename: mp.filename ?? null,
          at: now,
        },
        metadata,
        submittedBy: req.user!.id,
      };
    } else {
      const body = evidenceJsonSchema.parse(req.body);
      const metadata = body.metadata ?? {};
      row = {
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        kind: body.kind,
        source: body.source,
        contentHash: hashPayload(metadata),
        fileId: null,
        capturedAt: body.capturedAt ?? null,
        independenceScore: body.independenceScore ?? 0,
        provenance: { submittedBy: req.user!.id, via: "api_json", at: now },
        metadata,
        submittedBy: req.user!.id,
      };
    }

    await app.db.insert(evidence).values(row);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "evidence",
      objectId: id,
      payload: { kind: row.kind, source: row.source, contentHash: row.contentHash },
      storePayload: true,
    });
    return reply.status(201).send(row);
  });

  app.get("/projects/:projectId/evidence", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.extend({ kind: z.enum(EVIDENCE_KINDS).optional() }).parse(req.query);
    const where = and(
      eq(evidence.companyId, req.companyId!),
      eq(evidence.projectId, req.projectId!),
      q.kind ? eq(evidence.kind, q.kind) : undefined,
    );
    const items = await app.db
      .select()
      .from(evidence)
      .where(where)
      .orderBy(desc(evidence.ingestedAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(evidence).where(where);
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/evidence/:evidenceId", { preHandler: readGate }, async (req) => {
    const { evidenceId } = req.params as { evidenceId: string };
    const rows = await app.db
      .select()
      .from(evidence)
      .where(
        and(
          eq(evidence.id, evidenceId),
          eq(evidence.companyId, req.companyId!),
          eq(evidence.projectId, req.projectId!),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Evidence not found");
    return rows[0];
  });

  /* ---------------------------------------------------------------- */
  /* 3. Reconciliations — THE product table                            */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/reconciliations",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = reconciliationCreateSchema.parse(req.body);

      const assertionRows = await app.db
        .select()
        .from(assertions)
        .where(
          and(
            eq(assertions.id, body.assertionId),
            eq(assertions.companyId, req.companyId!),
            eq(assertions.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const assertion = assertionRows[0];
      if (!assertion) throw notFound("Assertion not found in this project");

      const uniqueEvidenceIds = [...new Set(body.evidenceIds)];
      const evidenceRows = await app.db
        .select()
        .from(evidence)
        .where(
          and(
            inArray(evidence.id, uniqueEvidenceIds),
            eq(evidence.companyId, req.companyId!),
            eq(evidence.projectId, req.projectId!),
          ),
        );
      if (evidenceRows.length !== uniqueEvidenceIds.length) {
        throw notFound("One or more evidence records not found in this project");
      }

      // SEPARATION RULE (spec Vol III §4 design rule): an assertion and the
      // evidence testing it must not come from the same actor. Only an
      // integrity reviewer may knowingly reconcile self-certified evidence.
      if (
        assertion.claimantKind === "user" &&
        evidenceRows.every((e) => e.submittedBy === assertion.claimantId)
      ) {
        const override = await holdsAssuranceRole(req, ["integrity_reviewer"], req.projectId);
        if (!override) throw forbidden("evidence not independent of claimant");
      }

      const numerics = evidenceRows
        .map((e) => (e.metadata as Record<string, unknown>)["value"])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

      let result: ReconciliationResult;
      let variance: number | null = null;
      let variancePercent: number | null = null;
      if (assertion.value !== null && assertion.value !== undefined && numerics.length > 0) {
        const evidenceMean = numerics.reduce((a, b) => a + b, 0) / numerics.length;
        variance = evidenceMean - assertion.value;
        if (assertion.value === 0) {
          variancePercent = variance === 0 ? 0 : null; // undefined %, treated as gross deviation
          result = variance === 0 ? "supported" : "contradicted";
        } else {
          variancePercent = (variance / assertion.value) * 100;
          const vp = Math.abs(variancePercent);
          result = vp <= 5 ? "supported" : vp <= 15 ? "partially_supported" : "contradicted";
        }
      } else if (body.method === "manual") {
        if (!body.result) {
          throw badRequest("manual reconciliation requires an explicit result");
        }
        result = body.result;
      } else {
        result = "insufficient_evidence";
      }

      const confidence =
        evidenceRows.reduce((a, e) => a + (e.independenceScore ?? 0), 0) / evidenceRows.length;

      const id = newId("rec");
      const row = {
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        assertionId: assertion.id,
        evidenceIds: uniqueEvidenceIds,
        method: body.method,
        result,
        variance,
        variancePercent,
        confidence,
        reviewerId: null,
        disposition: null,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      };
      await app.db.insert(reconciliations).values(row);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "reconciliation",
        objectId: id,
        payload: row,
        storePayload: true,
      });
      return reply.status(201).send(row);
    },
  );

  app.get("/projects/:projectId/reconciliations", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ result: z.enum(RECONCILIATION_RESULTS).optional() })
      .parse(req.query);
    const where = and(
      eq(reconciliations.companyId, req.companyId!),
      eq(reconciliations.projectId, req.projectId!),
      q.result ? eq(reconciliations.result, q.result) : undefined,
    );
    const items = await app.db
      .select()
      .from(reconciliations)
      .where(where)
      .orderBy(desc(reconciliations.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(reconciliations).where(where);
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get(
    "/projects/:projectId/reconciliations/:reconciliationId",
    { preHandler: readGate },
    async (req) => {
      const { reconciliationId } = req.params as { reconciliationId: string };
      const rows = await app.db
        .select()
        .from(reconciliations)
        .where(
          and(
            eq(reconciliations.id, reconciliationId),
            eq(reconciliations.companyId, req.companyId!),
            eq(reconciliations.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const rec = rows[0];
      if (!rec) throw notFound("Reconciliation not found");
      const assertionRows = await app.db
        .select()
        .from(assertions)
        .where(and(eq(assertions.id, rec.assertionId), eq(assertions.companyId, req.companyId!)))
        .limit(1);
      const evidenceRows =
        rec.evidenceIds.length > 0
          ? await app.db
              .select()
              .from(evidence)
              .where(
                and(
                  inArray(evidence.id, rec.evidenceIds),
                  eq(evidence.companyId, req.companyId!),
                ),
              )
          : [];
      return { ...rec, assertion: assertionRows[0] ?? null, evidence: evidenceRows };
    },
  );

  app.patch(
    "/reconciliations/:reconciliationId/disposition",
    {
      preHandler: [
        app.authenticate,
        app.requireCompany,
        app.requireAssuranceRole(["integrity_reviewer", "auditor"]),
      ],
    },
    async (req) => {
      const { reconciliationId } = req.params as { reconciliationId: string };
      const body = dispositionSchema.parse(req.body);
      const rows = await app.db
        .select()
        .from(reconciliations)
        .where(
          and(
            eq(reconciliations.id, reconciliationId),
            eq(reconciliations.companyId, req.companyId!),
          ),
        )
        .limit(1);
      if (!rows[0]) throw notFound("Reconciliation not found");
      const updated = {
        disposition: body.disposition,
        notes: body.notes ?? rows[0].notes,
        reviewerId: req.user!.id,
      };
      await app.db
        .update(reconciliations)
        .set(updated)
        .where(eq(reconciliations.id, reconciliationId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "reconciliation",
        objectId: reconciliationId,
        payload: { disposition: body.disposition, notes: body.notes ?? null },
        storePayload: true,
      });
      return { ...rows[0], ...updated };
    },
  );

  /* ---------------------------------------------------------------- */
  /* 4. Obligations                                                    */
  /* ---------------------------------------------------------------- */

  async function loadObligation(req: FastifyRequest, obligationId: string) {
    const rows = await app.db
      .select()
      .from(obligations)
      .where(
        and(
          eq(obligations.id, obligationId),
          eq(obligations.companyId, req.companyId!),
          eq(obligations.projectId, req.projectId!),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Obligation not found");
    return rows[0];
  }

  app.post("/projects/:projectId/obligations", { preHandler: standardGate }, async (req, reply) => {
    const body = obligationCreateSchema.parse(req.body);
    const id = newId("obl");
    const row = {
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      sourceClause: body.sourceClause,
      obligorId: body.obligorId ?? null,
      obligeeId: body.obligeeId ?? null,
      trigger: body.trigger,
      deadline: body.deadline ?? null,
      warnDaysBefore: body.warnDaysBefore ?? null,
      evidenceRequirement: body.evidenceRequirement ?? null,
      status: "open",
      createdBy: req.user!.id,
    };
    await app.db.insert(obligations).values(row);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "obligation",
      objectId: id,
      payload: row,
      storePayload: true,
    });
    return reply.status(201).send(row);
  });

  app.get("/projects/:projectId/obligations", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.extend({ status: z.string().optional() }).parse(req.query);
    const where = and(
      eq(obligations.companyId, req.companyId!),
      eq(obligations.projectId, req.projectId!),
      q.status ? eq(obligations.status, q.status) : undefined,
    );
    const items = await app.db
      .select()
      .from(obligations)
      .where(where)
      .orderBy(desc(obligations.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(obligations).where(where);
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  // NOTE: registered before /:obligationId so the static segment wins.
  app.get("/projects/:projectId/obligations/upcoming", { preHandler: readGate }, async (req) => {
    const q = z
      .object({ days: z.coerce.number().int().min(1).max(730).default(30) })
      .parse(req.query);
    const nowIso = new Date().toISOString();
    const untilIso = new Date(Date.now() + q.days * 24 * 3600 * 1000).toISOString();

    // Lazy breach pass: open obligations already past deadline become breached.
    const overdue = await app.db
      .select()
      .from(obligations)
      .where(
        and(
          eq(obligations.companyId, req.companyId!),
          eq(obligations.projectId, req.projectId!),
          eq(obligations.status, "open"),
          lt(obligations.deadline, nowIso),
        ),
      );
    for (const o of overdue) {
      await app.db.update(obligations).set({ status: "breached" }).where(eq(obligations.id, o.id));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "obligation",
        objectId: o.id,
        payload: { status: "breached", deadline: o.deadline, detectedAt: nowIso },
      });
    }

    const items = await app.db
      .select()
      .from(obligations)
      .where(
        and(
          eq(obligations.companyId, req.companyId!),
          eq(obligations.projectId, req.projectId!),
          eq(obligations.status, "open"),
          gte(obligations.deadline, nowIso),
          lte(obligations.deadline, untilIso),
        ),
      )
      .orderBy(asc(obligations.deadline));
    return { items, breached: overdue.length, windowDays: q.days };
  });

  app.get(
    "/projects/:projectId/obligations/:obligationId",
    { preHandler: readGate },
    async (req) => {
      const { obligationId } = req.params as { obligationId: string };
      return loadObligation(req, obligationId);
    },
  );

  app.patch(
    "/projects/:projectId/obligations/:obligationId",
    { preHandler: standardGate },
    async (req) => {
      const { obligationId } = req.params as { obligationId: string };
      const body = obligationPatchSchema.parse(req.body);
      const existing = await loadObligation(req, obligationId);
      const patch: Record<string, unknown> = {};
      if (body.sourceClause !== undefined) patch["sourceClause"] = body.sourceClause;
      if (body.trigger !== undefined) patch["trigger"] = body.trigger;
      if (body.obligorId !== undefined) patch["obligorId"] = body.obligorId;
      if (body.obligeeId !== undefined) patch["obligeeId"] = body.obligeeId;
      if (body.deadline !== undefined) patch["deadline"] = body.deadline;
      if (body.warnDaysBefore !== undefined) patch["warnDaysBefore"] = body.warnDaysBefore;
      if (body.evidenceRequirement !== undefined) {
        patch["evidenceRequirement"] = body.evidenceRequirement;
      }
      if (Object.keys(patch).length === 0) return existing;
      await app.db.update(obligations).set(patch).where(eq(obligations.id, obligationId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "obligation",
        objectId: obligationId,
        payload: patch,
        storePayload: true,
      });
      return { ...existing, ...patch };
    },
  );

  app.delete(
    "/projects/:projectId/obligations/:obligationId",
    { preHandler: standardGate },
    async (req) => {
      const { obligationId } = req.params as { obligationId: string };
      await loadObligation(req, obligationId);
      await app.db.delete(obligations).where(eq(obligations.id, obligationId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "obligation",
        objectId: obligationId,
      });
      return { ok: true };
    },
  );

  app.post(
    "/projects/:projectId/obligations/:obligationId/satisfy",
    { preHandler: standardGate },
    async (req) => {
      const { obligationId } = req.params as { obligationId: string };
      const body = z.object({ evidenceId: z.string().min(1) }).parse(req.body);
      const existing = await loadObligation(req, obligationId);
      const evidenceRows = await app.db
        .select()
        .from(evidence)
        .where(
          and(
            eq(evidence.id, body.evidenceId),
            eq(evidence.companyId, req.companyId!),
            eq(evidence.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const ev = evidenceRows[0];
      if (!ev) throw notFound("Evidence not found in this project");
      await app.db
        .update(obligations)
        .set({ status: "satisfied", satisfiedEvidenceId: ev.id })
        .where(eq(obligations.id, obligationId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "obligation",
        objectId: obligationId,
        // Separation rule does not gate satisfaction, but self-certification
        // is recorded so a reviewer can weigh it later.
        payload: {
          status: "satisfied",
          evidenceId: ev.id,
          evidenceSubmittedBy: ev.submittedBy,
          selfCertified: ev.submittedBy === req.user!.id,
        },
        storePayload: true,
      });
      return { ...existing, status: "satisfied", satisfiedEvidenceId: ev.id };
    },
  );

  app.post(
    "/projects/:projectId/obligations/:obligationId/waive",
    { preHandler: standardGate },
    async (req) => {
      const { obligationId } = req.params as { obligationId: string };
      const body = z.object({ reason: z.string().min(1).max(2000) }).parse(req.body);
      const existing = await loadObligation(req, obligationId);
      await app.db
        .update(obligations)
        .set({ status: "waived" })
        .where(eq(obligations.id, obligationId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "obligation",
        objectId: obligationId,
        // obligations has no notes column; the waive reason lives in the ledger
        payload: { status: "waived", reason: body.reason },
        storePayload: true,
      });
      return { ...existing, status: "waived" };
    },
  );

  /* ---------------------------------------------------------------- */
  /* 5. Events                                                         */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/events", { preHandler: standardGate }, async (req, reply) => {
    const body = eventCreateSchema.parse(req.body);
    const id = newId("evt");
    const row = {
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      type: body.type,
      occurredAt: body.occurredAt,
      location: body.location ?? null,
      detectedOrReported: body.detectedOrReported ?? "reported",
      causalLinks: body.causalLinks ?? [],
      payload: body.payload ?? null,
      createdBy: req.user!.id,
    };
    await app.db.insert(events).values(row);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "event",
      objectId: id,
      payload: row,
      storePayload: true,
    });
    return reply.status(201).send(row);
  });

  app.get("/projects/:projectId/events", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.extend({ type: z.string().optional() }).parse(req.query);
    const where = and(
      eq(events.companyId, req.companyId!),
      eq(events.projectId, req.projectId!),
      q.type ? eq(events.type, q.type) : undefined,
    );
    const items = await app.db
      .select()
      .from(events)
      .where(where)
      .orderBy(desc(events.occurredAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(events).where(where);
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /* ---------------------------------------------------------------- */
  /* 6. Entities + relationship graph                                  */
  /* ---------------------------------------------------------------- */

  async function loadEntity(req: FastifyRequest, entityId: string) {
    const rows = await app.db
      .select()
      .from(entities)
      .where(and(eq(entities.id, entityId), eq(entities.companyId, req.companyId!)))
      .limit(1);
    if (!rows[0]) throw notFound("Entity not found");
    return rows[0];
  }

  app.post("/entities", { preHandler: companyGate }, async (req, reply) => {
    const body = entityCreateSchema.parse(req.body);
    const id = newId("ent");
    const row = {
      id,
      companyId: req.companyId!,
      kind: body.kind,
      name: body.name,
      identifiers: body.identifiers ?? {},
      jurisdiction: body.jurisdiction ?? null,
      screeningStatus: body.screeningStatus ?? null,
      notes: body.notes ?? null,
    };
    await app.db.insert(entities).values(row);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "entity",
      objectId: id,
      payload: row,
      storePayload: true,
    });
    return reply.status(201).send(row);
  });

  app.get("/entities", { preHandler: companyGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ kind: z.enum(ENTITY_KINDS).optional(), search: z.string().max(200).optional() })
      .parse(req.query);
    const where = and(
      eq(entities.companyId, req.companyId!),
      q.kind ? eq(entities.kind, q.kind) : undefined,
      q.search ? ilike(entities.name, `%${q.search}%`) : undefined,
    );
    const items = await app.db
      .select()
      .from(entities)
      .where(where)
      .orderBy(asc(entities.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(entities).where(where);
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /* -------- entity scan (must precede /entities/:entityId GETs) ----- */

  app.post("/entities/scan", { preHandler: companyGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(entities)
      .where(eq(entities.companyId, req.companyId!));

    const norm = (s: string | undefined): string | null => {
      const t = (s ?? "").trim().toLowerCase();
      return t.length > 0 ? t : null;
    };
    const identifierOf = (row: (typeof rows)[number], key: string): string | null => {
      const ids = row.identifiers as Record<string, string>;
      if (key === "email_domain") {
        const explicit = norm(ids["email_domain"]);
        if (explicit) return explicit;
        const email = norm(ids["email"]);
        return email && email.includes("@") ? email.split("@")[1]! : null;
      }
      return norm(ids[key]);
    };

    const checks: {
      identifier: string;
      relationshipKind: string;
      confidence: number;
      severity: "high" | "medium";
    }[] = [
      {
        identifier: "bank_account",
        relationshipKind: "shares_bank_account_with",
        confidence: 0.9,
        severity: "high",
      },
      {
        identifier: "address",
        relationshipKind: "shares_address_with",
        confidence: 0.6,
        severity: "medium",
      },
      {
        identifier: "email_domain",
        relationshipKind: "shares_contact_with",
        confidence: 0.6,
        severity: "medium",
      },
      {
        identifier: "phone",
        relationshipKind: "shares_contact_with",
        confidence: 0.6,
        severity: "medium",
      },
    ];

    const existing = await app.db
      .select()
      .from(entityRelationships)
      .where(eq(entityRelationships.companyId, req.companyId!));
    const seen = new Set<string>();
    for (const r of existing) {
      seen.add(`${r.fromEntityId}|${r.toEntityId}|${r.kind}`);
      seen.add(`${r.toEntityId}|${r.fromEntityId}|${r.kind}`);
    }

    let relationshipsCreated = 0;
    let signalsCreated = 0;
    const findings: {
      fromEntityId: string;
      toEntityId: string;
      kind: string;
      identifier: string;
      value: string;
    }[] = [];

    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i]!;
        const b = rows[j]!;
        for (const check of checks) {
          const va = identifierOf(a, check.identifier);
          const vb = identifierOf(b, check.identifier);
          if (!va || va !== vb) continue;
          const key = `${a.id}|${b.id}|${check.relationshipKind}`;
          if (seen.has(key)) continue;
          seen.add(key);
          seen.add(`${b.id}|${a.id}|${check.relationshipKind}`);

          const relId = newId("erel");
          await app.db.insert(entityRelationships).values({
            id: relId,
            companyId: req.companyId!,
            fromEntityId: a.id,
            toEntityId: b.id,
            kind: check.relationshipKind,
            source: `scan:shared_identifier:${check.identifier}`,
            confidence: check.confidence,
          });
          await appendLedger(app.db, {
            companyId: req.companyId!,
            actorId: req.user!.id,
            action: "create",
            objectType: "entity_relationship",
            objectId: relId,
            payload: { fromEntityId: a.id, toEntityId: b.id, kind: check.relationshipKind },
          });
          relationshipsCreated += 1;

          await insertSignal(req.companyId!, null, req.user!.id, {
            detector: "shared_identifier",
            severity: check.severity,
            confidence: check.confidence,
            title: `Entities share ${check.identifier.replace(/_/g, " ")}: ${a.name} / ${b.name}`,
            explanation:
              `"${a.name}" (${a.id}) and "${b.name}" (${b.id}) share the same ` +
              `${check.identifier.replace(/_/g, " ")} ("${va}"). Shared identifiers across ` +
              `nominally independent parties are a collusion / related-party indicator.`,
            evidenceRefs: {
              entityIds: [a.id, b.id],
              identifier: check.identifier,
              value: va,
              relationshipId: relId,
            },
          });
          signalsCreated += 1;
          findings.push({
            fromEntityId: a.id,
            toEntityId: b.id,
            kind: check.relationshipKind,
            identifier: check.identifier,
            value: va,
          });
        }
      }
    }

    return { entitiesScanned: rows.length, relationshipsCreated, signalsCreated, findings };
  });

  app.get("/entities/:entityId", { preHandler: companyGate }, async (req) => {
    const { entityId } = req.params as { entityId: string };
    return loadEntity(req, entityId);
  });

  app.patch("/entities/:entityId", { preHandler: companyGate }, async (req) => {
    const { entityId } = req.params as { entityId: string };
    const body = entityPatchSchema.parse(req.body);
    const existing = await loadEntity(req, entityId);
    const patch: Record<string, unknown> = {};
    if (body.kind !== undefined) patch["kind"] = body.kind;
    if (body.name !== undefined) patch["name"] = body.name;
    if (body.identifiers !== undefined) patch["identifiers"] = body.identifiers;
    if (body.jurisdiction !== undefined) patch["jurisdiction"] = body.jurisdiction;
    if (body.screeningStatus !== undefined) patch["screeningStatus"] = body.screeningStatus;
    if (body.notes !== undefined) patch["notes"] = body.notes;
    if (Object.keys(patch).length === 0) return existing;
    await app.db.update(entities).set(patch).where(eq(entities.id, entityId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "entity",
      objectId: entityId,
      payload: patch,
      storePayload: true,
    });
    return { ...existing, ...patch };
  });

  app.delete("/entities/:entityId", { preHandler: companyGate }, async (req) => {
    const { entityId } = req.params as { entityId: string };
    await loadEntity(req, entityId);
    await app.db
      .delete(entityRelationships)
      .where(
        and(
          eq(entityRelationships.companyId, req.companyId!),
          or(
            eq(entityRelationships.fromEntityId, entityId),
            eq(entityRelationships.toEntityId, entityId),
          ),
        ),
      );
    await app.db.delete(entities).where(eq(entities.id, entityId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "entity",
      objectId: entityId,
    });
    return { ok: true };
  });

  app.post("/entities/:entityId/relationships", { preHandler: companyGate }, async (req, reply) => {
    const { entityId } = req.params as { entityId: string };
    const body = relationshipCreateSchema.parse(req.body);
    if (body.toEntityId === entityId) throw badRequest("An entity cannot relate to itself");
    await loadEntity(req, entityId);
    await loadEntity(req, body.toEntityId);
    const dupes = await app.db
      .select({ id: entityRelationships.id })
      .from(entityRelationships)
      .where(
        and(
          eq(entityRelationships.companyId, req.companyId!),
          eq(entityRelationships.fromEntityId, entityId),
          eq(entityRelationships.toEntityId, body.toEntityId),
          eq(entityRelationships.kind, body.kind),
        ),
      )
      .limit(1);
    if (dupes[0]) throw badRequest("Relationship already exists");
    const id = newId("erel");
    const row = {
      id,
      companyId: req.companyId!,
      fromEntityId: entityId,
      toEntityId: body.toEntityId,
      kind: body.kind,
      since: body.since ?? null,
      source: body.source ?? null,
      confidence: body.confidence ?? null,
    };
    await app.db.insert(entityRelationships).values(row);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "entity_relationship",
      objectId: id,
      payload: row,
      storePayload: true,
    });
    return reply.status(201).send(row);
  });

  app.get("/entities/:entityId/relationships", { preHandler: companyGate }, async (req) => {
    const { entityId } = req.params as { entityId: string };
    await loadEntity(req, entityId);
    const items = await app.db
      .select()
      .from(entityRelationships)
      .where(
        and(
          eq(entityRelationships.companyId, req.companyId!),
          or(
            eq(entityRelationships.fromEntityId, entityId),
            eq(entityRelationships.toEntityId, entityId),
          ),
        ),
      )
      .orderBy(desc(entityRelationships.createdAt));
    return { items, total: items.length };
  });

  app.delete(
    "/entities/:entityId/relationships/:relationshipId",
    { preHandler: companyGate },
    async (req) => {
      const { entityId, relationshipId } = req.params as {
        entityId: string;
        relationshipId: string;
      };
      const rows = await app.db
        .select()
        .from(entityRelationships)
        .where(
          and(
            eq(entityRelationships.id, relationshipId),
            eq(entityRelationships.companyId, req.companyId!),
            or(
              eq(entityRelationships.fromEntityId, entityId),
              eq(entityRelationships.toEntityId, entityId),
            ),
          ),
        )
        .limit(1);
      if (!rows[0]) throw notFound("Relationship not found");
      await app.db.delete(entityRelationships).where(eq(entityRelationships.id, relationshipId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "entity_relationship",
        objectId: relationshipId,
      });
      return { ok: true };
    },
  );

  app.get("/entities/:entityId/graph", { preHandler: companyGate }, async (req) => {
    const { entityId } = req.params as { entityId: string };
    const q = z
      .object({ depth: z.coerce.number().int().min(1).max(6).default(2) })
      .parse(req.query);
    await loadEntity(req, entityId);

    const allRels = await app.db
      .select()
      .from(entityRelationships)
      .where(eq(entityRelationships.companyId, req.companyId!));

    const adjacency = new Map<string, typeof allRels>();
    for (const rel of allRels) {
      for (const end of [rel.fromEntityId, rel.toEntityId]) {
        const list = adjacency.get(end) ?? [];
        list.push(rel);
        adjacency.set(end, list);
      }
    }

    const visited = new Map<string, number>([[entityId, 0]]);
    const edgeIds = new Set<string>();
    let frontier = [entityId];
    for (let d = 1; d <= q.depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        for (const rel of adjacency.get(nodeId) ?? []) {
          edgeIds.add(rel.id);
          const other = rel.fromEntityId === nodeId ? rel.toEntityId : rel.fromEntityId;
          if (!visited.has(other)) {
            visited.set(other, d);
            next.push(other);
          }
        }
      }
      frontier = next;
    }

    const nodeIds = [...visited.keys()];
    const nodeRows =
      nodeIds.length > 0
        ? await app.db
            .select()
            .from(entities)
            .where(and(eq(entities.companyId, req.companyId!), inArray(entities.id, nodeIds)))
        : [];
    const edges = allRels.filter(
      (r) => edgeIds.has(r.id) && visited.has(r.fromEntityId) && visited.has(r.toEntityId),
    );
    return {
      root: entityId,
      depth: q.depth,
      nodes: nodeRows.map((n) => ({ ...n, distance: visited.get(n.id) ?? null })),
      edges,
    };
  });

  /* ---------------------------------------------------------------- */
  /* 7. Signals                                                        */
  /* ---------------------------------------------------------------- */

  app.get("/signals", { preHandler: companyGate }, async (req) => {
    const q = signalListSchema.parse(req.query);
    const where = and(
      eq(signals.companyId, req.companyId!),
      q.projectId ? eq(signals.projectId, q.projectId) : undefined,
      q.severity ? eq(signals.severity, q.severity) : undefined,
      q.disposition ? eq(signals.disposition, q.disposition) : undefined,
    );
    const items = await app.db
      .select()
      .from(signals)
      .where(where)
      .orderBy(desc(signals.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(signals).where(where);
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/signals/stats", { preHandler: companyGate }, async (req) => {
    const rows = await app.db
      .select({ severity: signals.severity, disposition: signals.disposition, n: count() })
      .from(signals)
      .where(eq(signals.companyId, req.companyId!))
      .groupBy(signals.severity, signals.disposition);
    const matrix = rows.map((r) => ({
      severity: r.severity,
      disposition: r.disposition,
      count: Number(r.n),
    }));
    const bySeverity: Record<string, number> = {};
    const byDisposition: Record<string, number> = {};
    let total = 0;
    for (const cell of matrix) {
      bySeverity[cell.severity] = (bySeverity[cell.severity] ?? 0) + cell.count;
      byDisposition[cell.disposition] = (byDisposition[cell.disposition] ?? 0) + cell.count;
      total += cell.count;
    }
    return { total, bySeverity, byDisposition, matrix };
  });

  app.get("/projects/:projectId/signals", { preHandler: readGate }, async (req) => {
    const q = signalListSchema.parse(req.query);
    const where = and(
      eq(signals.companyId, req.companyId!),
      eq(signals.projectId, req.projectId!),
      q.severity ? eq(signals.severity, q.severity) : undefined,
      q.disposition ? eq(signals.disposition, q.disposition) : undefined,
    );
    const items = await app.db
      .select()
      .from(signals)
      .where(where)
      .orderBy(desc(signals.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(signals).where(where);
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  // Segregation of duties: ONLY integrity reviewers disposition signals —
  // operational owners/admins must not clear signals about their own records.
  app.patch(
    "/signals/:signalId/disposition",
    {
      preHandler: [
        app.authenticate,
        app.requireCompany,
        app.requireAssuranceRole(["integrity_reviewer"]),
      ],
    },
    async (req) => {
      const { signalId } = req.params as { signalId: string };
      const body = signalDispositionSchema.parse(req.body);
      const rows = await app.db
        .select()
        .from(signals)
        .where(and(eq(signals.id, signalId), eq(signals.companyId, req.companyId!)))
        .limit(1);
      if (!rows[0]) throw notFound("Signal not found");
      const patch = {
        disposition: body.disposition,
        reviewerNotes: body.reviewerNotes ?? rows[0].reviewerNotes,
        reviewerId: req.user!.id,
      };
      await app.db.update(signals).set(patch).where(eq(signals.id, signalId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "signal",
        objectId: signalId,
        payload: { disposition: body.disposition, reviewerNotes: body.reviewerNotes ?? null },
        storePayload: true,
      });
      return { ...rows[0], ...patch };
    },
  );

  /* ---------------------------------------------------------------- */
  /* 8. Detector runs                                                  */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/detectors/run", { preHandler: readGate }, async (req) => {
    // Runs are for assurance-role holders or operational owners/admins.
    const privileged =
      req.companyRole === "owner" ||
      req.companyRole === "admin" ||
      req.assuranceRole !== undefined ||
      (await holdsAssuranceRole(
        req,
        ["integrity_reviewer", "auditor", "regulator"],
        req.projectId,
      ));
    if (!privileged) {
      throw forbidden("Requires an assurance role or company owner/admin");
    }

    const body = detectorsRunSchema.parse(req.body ?? {});
    const requested = (body.detectors ?? [...DETECTOR_NAMES]) as string[];
    const unknown = requested.filter((d) => !(DETECTOR_NAMES as readonly string[]).includes(d));
    if (unknown.length > 0) throw badRequest(`Unknown detectors: ${unknown.join(", ")}`);
    const active = new Set(requested as DetectorName[]);

    const perDetector: Record<string, number> = {};
    const skipped: string[] = [];
    const drafts: SignalDraft[] = [];

    const needsAssertions =
      active.has("benford_first_digit") ||
      active.has("duplicate_assertions") ||
      active.has("round_number_clustering");
    const assertionRows = needsAssertions
      ? await app.db
          .select()
          .from(assertions)
          .where(
            and(
              eq(assertions.companyId, req.companyId!),
              eq(assertions.projectId, req.projectId!),
            ),
          )
      : [];
    const numericCostQty = assertionRows
      .filter((a) => (a.kind === "cost" || a.kind === "quantity") && a.value !== null)
      .map((a) => a.value as number);

    if (active.has("benford_first_digit")) {
      const res = benfordFirstDigit(numericCostQty);
      if (res.skipped) skipped.push("benford_first_digit");
      else {
        const created = res.draft ? 1 : 0;
        perDetector["benford_first_digit"] = created;
        if (res.draft) drafts.push(res.draft);
      }
    }
    if (active.has("duplicate_assertions")) {
      const found = duplicateAssertions(
        assertionRows.map((a) => ({
          id: a.id,
          kind: a.kind,
          value: a.value,
          unit: a.unit,
          claimantId: a.claimantId,
          assertedAt: a.assertedAt,
        })),
      );
      perDetector["duplicate_assertions"] = found.length;
      drafts.push(...found);
    }
    if (active.has("round_number_clustering")) {
      const draft = roundNumberClustering(numericCostQty);
      if (numericCostQty.length < 10) skipped.push("round_number_clustering");
      else {
        perDetector["round_number_clustering"] = draft ? 1 : 0;
        if (draft) drafts.push(draft);
      }
    }

    if (active.has("approval_velocity") || active.has("segregation_of_duties")) {
      const instances = await app.db
        .select()
        .from(workflowInstances)
        .where(
          and(
            eq(workflowInstances.companyId, req.companyId!),
            eq(workflowInstances.projectId, req.projectId!),
          ),
        );
      const instanceIds = instances.map((i) => i.id);
      const steps =
        instanceIds.length > 0
          ? await app.db
              .select()
              .from(workflowStepInstances)
              .where(inArray(workflowStepInstances.instanceId, instanceIds))
          : [];
      const stepRows = steps.map((s) => ({
        id: s.id,
        instanceId: s.instanceId,
        assigneeId: s.assigneeId,
        delegatedToId: s.delegatedToId,
        decision: s.decision,
        createdAt: s.createdAt,
        decidedAt: s.decidedAt,
      }));
      if (active.has("approval_velocity")) {
        const found = approvalVelocity(stepRows);
        perDetector["approval_velocity"] = found.length;
        drafts.push(...found);
      }
      if (active.has("segregation_of_duties")) {
        const found = segregationOfDuties(
          instances.map((i) => ({
            id: i.id,
            startedBy: i.startedBy,
            recordType: i.recordType,
            recordId: i.recordId,
          })),
          stepRows,
        );
        perDetector["segregation_of_duties"] = found.length;
        drafts.push(...found);
      }
    }

    if (active.has("contradicted_claimant")) {
      const recRows = await app.db
        .select({
          reconciliationId: reconciliations.id,
          result: reconciliations.result,
          claimantId: assertions.claimantId,
        })
        .from(reconciliations)
        .innerJoin(assertions, eq(assertions.id, reconciliations.assertionId))
        .where(
          and(
            eq(reconciliations.companyId, req.companyId!),
            eq(reconciliations.projectId, req.projectId!),
          ),
        );
      const found = contradictedClaimant(recRows);
      perDetector["contradicted_claimant"] = found.length;
      drafts.push(...found);
    }

    for (const draft of drafts) {
      await insertSignal(req.companyId!, req.projectId!, req.user!.id, draft);
    }

    return { created: drafts.length, skipped, perDetector };
  });

  /* ---------------------------------------------------------------- */
  /* 9. Ledger                                                         */
  /* ---------------------------------------------------------------- */

  app.get("/ledger/verify", { preHandler: companyGate }, async (req) => {
    const result = await verifyLedgerNormalized(app.db, req.companyId!);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "access",
      objectType: "ledger",
      objectId: req.companyId!,
      payload: { verify: true, valid: result.valid, count: result.count },
    });
    return result;
  });

  app.get("/ledger", { preHandler: companyGate }, async (req) => {
    const q = ledgerListSchema.parse(req.query);
    const where = and(
      eq(ledgerEntries.companyId, req.companyId!),
      q.objectType ? eq(ledgerEntries.objectType, q.objectType) : undefined,
      q.objectId ? eq(ledgerEntries.objectId, q.objectId) : undefined,
    );
    const items = await app.db
      .select()
      .from(ledgerEntries)
      .where(where)
      .orderBy(desc(ledgerEntries.seq))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(ledgerEntries).where(where);
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/ledger/recent", { preHandler: readGate }, async (req) => {
    // ledger_entries has no projectId column: collect the ids of this
    // project's assurance objects and filter the chain by objectId.
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    const idSets = await Promise.all([
      app.db
        .select({ id: assertions.id })
        .from(assertions)
        .where(and(eq(assertions.companyId, companyId), eq(assertions.projectId, projectId))),
      app.db
        .select({ id: evidence.id })
        .from(evidence)
        .where(and(eq(evidence.companyId, companyId), eq(evidence.projectId, projectId))),
      app.db
        .select({ id: reconciliations.id })
        .from(reconciliations)
        .where(
          and(eq(reconciliations.companyId, companyId), eq(reconciliations.projectId, projectId)),
        ),
      app.db
        .select({ id: obligations.id })
        .from(obligations)
        .where(and(eq(obligations.companyId, companyId), eq(obligations.projectId, projectId))),
      app.db
        .select({ id: events.id })
        .from(events)
        .where(and(eq(events.companyId, companyId), eq(events.projectId, projectId))),
      app.db
        .select({ id: signals.id })
        .from(signals)
        .where(and(eq(signals.companyId, companyId), eq(signals.projectId, projectId))),
    ]);
    const objectIds = idSets.flat().map((r) => r.id);
    if (objectIds.length === 0) return { items: [] };
    const items = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, req.companyId!),
          inArray(ledgerEntries.objectId, objectIds),
        ),
      )
      .orderBy(desc(ledgerEntries.seq))
      .limit(100);
    return { items };
  });

  /* ---------------------------------------------------------------- */
  /* 10. Evidence packs (Merkle-notarised bundles)                     */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/evidence-packs",
    { preHandler: readGate },
    async (req, reply) => {
      const body = evidencePackSchema.parse(req.body);
      const uniqueIds = [...new Set(body.evidenceIds)];
      const rows = await app.db
        .select()
        .from(evidence)
        .where(
          and(
            inArray(evidence.id, uniqueIds),
            eq(evidence.companyId, req.companyId!),
            eq(evidence.projectId, req.projectId!),
          ),
        );
      if (rows.length !== uniqueIds.length) {
        throw notFound("One or more evidence records not found in this project");
      }
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ordered = uniqueIds.map((id) => byId.get(id)!);
      const leaves = ordered.map((r) => r.contentHash);
      const root = merkleRoot(leaves);
      const items = ordered.map((r, i) => ({
        evidenceId: r.id,
        contentHash: r.contentHash,
        kind: r.kind,
        source: r.source,
        proof: merkleProof(leaves, i),
      }));
      const packId = newId("epk");
      const generatedAt = new Date().toISOString();
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "access",
        objectType: "evidence_pack",
        objectId: packId,
        payload: { root, evidenceIds: uniqueIds, generatedAt },
        storePayload: true,
      });
      return reply.status(201).send({ id: packId, root, generatedAt, items });
    },
  );
};
