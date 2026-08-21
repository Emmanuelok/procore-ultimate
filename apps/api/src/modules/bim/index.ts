import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bimElements,
  bimModels,
  bimModelVersions,
  coordinationIssues,
  federationGroups,
  federationMembers,
  files,
} from "@constructos/db";
import {
  CDE_STATES,
  COORDINATION_ISSUE_STATUSES,
  DRAWING_DISCIPLINES,
  MODEL_FORMATS,
  SUITABILITY_CODES,
  type CdeState,
  type CoordinationIssueStatus,
  type SuitabilityCode,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { extractIfcElements } from "./ifc-extract.js";

/* ------------------------------------------------------------------ */
/* ISO 19650 CDE state machine (spec Domain L #639-640)                */
/* ------------------------------------------------------------------ */

/** forward-only flow; re-share from shared is allowed (suitability re-issue) */
const CDE_TRANSITIONS: Record<CdeState, CdeState[]> = {
  wip: ["shared"],
  shared: ["shared", "published"],
  published: ["archived"],
  archived: [],
};

/** suitability codes coherent with each CDE state */
const SUITABILITY_BY_STATE: Record<CdeState, SuitabilityCode[]> = {
  wip: ["S0"],
  shared: ["S1", "S2", "S3", "S4"],
  published: ["A1", "B1", "CR"],
  archived: ["CR"],
};

/** coordination issue lifecycle: open→assigned→resolved→verified, void anywhere */
const ISSUE_TRANSITIONS: Record<CoordinationIssueStatus, CoordinationIssueStatus[]> = {
  open: ["assigned", "void"],
  assigned: ["resolved", "void"],
  resolved: ["verified", "void"],
  verified: ["void"],
  void: [],
};

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const modelCreateSchema = z.object({
  name: z.string().min(1).max(200),
  discipline: z.enum(DRAWING_DISCIPLINES).optional(),
  format: z.enum(MODEL_FORMATS),
});

const modelPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  discipline: z.enum(DRAWING_DISCIPLINES).optional(),
});

const modelListQuery = pageQuerySchema.extend({
  discipline: z.enum(DRAWING_DISCIPLINES).optional(),
  search: z.string().max(200).optional(),
});

const stateChangeSchema = z.object({
  cdeState: z.enum(CDE_STATES),
  suitability: z.enum(SUITABILITY_CODES),
});

const elementListQuery = pageQuerySchema.extend({
  ifcType: z.string().max(100).optional(),
  search: z.string().max(200).optional(),
});

const federationCreateSchema = z.object({ name: z.string().min(1).max(200) });

const federationMemberSchema = z.object({
  modelVersionId: z.string().min(1),
  transform: z.unknown().optional(),
});

const issueCreateSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(10000).nullable().optional(),
  discipline: z.enum(DRAWING_DISCIPLINES).nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  dueDate: z.string().max(30).nullable().optional(),
  elementGlobalIds: z.array(z.string().max(64)).max(500).optional(),
  modelVersionId: z.string().nullable().optional(),
  viewpoint: z.unknown().optional(),
});

const issuePatchSchema = issueCreateSchema.partial().extend({
  title: z.string().min(1).max(300).optional(),
  status: z.enum(COORDINATION_ISSUE_STATUSES).optional(),
});

const issueListQuery = pageQuerySchema.extend({
  status: z.enum(COORDINATION_ISSUE_STATUSES).optional(),
  search: z.string().max(200).optional(),
  assigneeId: z.string().optional(),
});

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

export const bimModule: FastifyPluginAsync = async (app) => {
  const memberGate = [app.authenticate, app.requireCompany];
  const adminGate = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin"]),
  ];
  const tool = (level: "read" | "standard" | "admin") => [
    app.authenticate,
    app.requireCompany,
    app.requireTool("bim", level),
  ];

  /** fetch a model scoped to the tenant, or 404 */
  async function getModel(modelId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(bimModels)
      .where(and(eq(bimModels.id, modelId), eq(bimModels.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Model not found");
    return rows[0];
  }

  /** fetch a model version + its parent model scoped to the tenant, or 404 */
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

  /* ---------------------------------------------------------------- */
  /* Models (spec #231, #236)                                          */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/bim/models", { preHandler: tool("read") }, async (req) => {
    const q = modelListQuery.parse(req.query);
    const conds = [
      eq(bimModels.companyId, req.companyId!),
      eq(bimModels.projectId, req.projectId!),
    ];
    if (q.discipline) conds.push(eq(bimModels.discipline, q.discipline));
    if (q.search) conds.push(ilike(bimModels.name, `%${q.search}%`));
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(bimModels).where(where);
    const models = await app.db
      .select()
      .from(bimModels)
      .where(where)
      .orderBy(desc(bimModels.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));

    const currentIds = models
      .map((m) => m.currentVersionId)
      .filter((v): v is string => v !== null);
    const versions = currentIds.length
      ? await app.db
          .select()
          .from(bimModelVersions)
          .where(inArray(bimModelVersions.id, currentIds))
      : [];
    const byId = new Map(versions.map((v) => [v.id, v]));
    const items = models.map((m) => ({
      ...m,
      currentVersion: m.currentVersionId ? (byId.get(m.currentVersionId) ?? null) : null,
    }));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post(
    "/projects/:projectId/bim/models",
    { preHandler: tool("standard") },
    async (req, reply) => {
      const body = modelCreateSchema.parse(req.body);
      const id = newId("bmm");
      const [created] = await app.db
        .insert(bimModels)
        .values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          name: body.name,
          discipline: body.discipline ?? "other",
          format: body.format,
          createdBy: req.user!.id,
        })
        .returning();
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "bim_model",
        objectId: id,
        payload: created,
      });
      return reply.status(201).send(created);
    },
  );

  app.get("/bim/models/:modelId", { preHandler: memberGate }, async (req) => {
    const { modelId } = req.params as { modelId: string };
    const model = await getModel(modelId, req.companyId!);
    const versions = await app.db
      .select()
      .from(bimModelVersions)
      .where(eq(bimModelVersions.modelId, modelId))
      .orderBy(desc(bimModelVersions.version));
    return { ...model, versions };
  });

  app.patch("/bim/models/:modelId", { preHandler: memberGate }, async (req) => {
    const { modelId } = req.params as { modelId: string };
    await getModel(modelId, req.companyId!);
    const body = modelPatchSchema.parse(req.body);
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.name !== undefined) patch["name"] = body.name;
    if (body.discipline !== undefined) patch["discipline"] = body.discipline;
    if (Object.keys(patch).length === 1) throw badRequest("Nothing to update");
    const [updated] = await app.db
      .update(bimModels)
      .set(patch)
      .where(and(eq(bimModels.id, modelId), eq(bimModels.companyId, req.companyId!)))
      .returning();
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "bim_model",
      objectId: modelId,
      payload: patch,
    });
    return updated;
  });

  app.delete("/bim/models/:modelId", { preHandler: adminGate }, async (req) => {
    const { modelId } = req.params as { modelId: string };
    const model = await getModel(modelId, req.companyId!);
    await app.db.transaction(async (tx) => {
      const versions = await tx
        .select({ id: bimModelVersions.id })
        .from(bimModelVersions)
        .where(eq(bimModelVersions.modelId, modelId));
      const versionIds = versions.map((v) => v.id);
      if (versionIds.length > 0) {
        await tx.delete(bimElements).where(inArray(bimElements.modelVersionId, versionIds));
        await tx
          .delete(federationMembers)
          .where(inArray(federationMembers.modelVersionId, versionIds));
        await tx.delete(bimModelVersions).where(eq(bimModelVersions.modelId, modelId));
      }
      await tx.delete(bimModels).where(eq(bimModels.id, modelId));
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "bim_model",
      objectId: modelId,
      payload: { name: model.name, projectId: model.projectId },
      storePayload: true,
    });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* Versions — upload + inline IFC element extraction (#231, #235-236)*/
  /* ---------------------------------------------------------------- */

  app.post(
    "/bim/models/:modelId/versions",
    { preHandler: memberGate },
    async (req, reply) => {
      const { modelId } = req.params as { modelId: string };
      const model = await getModel(modelId, req.companyId!);

      const mp = await req.file();
      if (!mp) throw badRequest("A model file is required (multipart field 'file')");
      const buf = await mp.toBuffer();
      if (buf.length === 0) throw badRequest("Uploaded file is empty");

      const saved = await app.storage.saveBuffer(req.companyId!, buf);
      const fileId = newId("fil");
      await app.db.insert(files).values({
        id: fileId,
        companyId: req.companyId!,
        projectId: model.projectId,
        name: mp.filename || `${model.name}.${model.format}`,
        contentType: mp.mimetype || "application/octet-stream",
        sizeBytes: saved.sizeBytes,
        sha256: saved.sha256,
        storageKey: saved.storageKey,
        metadata: { source: "bim_model_version", modelId },
        uploadedBy: req.user!.id,
      });

      const [maxRow] = await app.db
        .select({ maxV: sql<number>`coalesce(max(${bimModelVersions.version}), 0)` })
        .from(bimModelVersions)
        .where(eq(bimModelVersions.modelId, modelId));
      const versionNumber = Number(maxRow?.maxV ?? 0) + 1;

      const versionId = newId("bmv");
      await app.db.insert(bimModelVersions).values({
        id: versionId,
        modelId,
        version: versionNumber,
        fileId,
        cdeState: "wip",
        suitability: "S0",
        processing: "processing",
        uploadedBy: req.user!.id,
      });
      await app.db
        .update(bimModels)
        .set({ currentVersionId: versionId, updatedAt: new Date().toISOString() })
        .where(eq(bimModels.id, modelId));

      // inline element extraction for IFC uploads — parse failures mark the
      // version failed instead of failing the request
      let elementCount = 0;
      let processing = "ready";
      let processingError: string | null = null;
      if (model.format === "ifc") {
        try {
          const result = extractIfcElements(buf.toString("utf8"));
          if (result.entityCount === 0) {
            throw new Error("No IFC entity instances found — not a STEP file?");
          }
          for (let i = 0; i < result.elements.length; i += 500) {
            const chunk = result.elements.slice(i, i + 500).map((el) => ({
              id: newId("bel"),
              modelVersionId: versionId,
              projectId: model.projectId,
              globalId: el.globalId,
              ifcType: el.ifcType,
              name: el.name,
              properties: {},
            }));
            if (chunk.length > 0) await app.db.insert(bimElements).values(chunk);
          }
          elementCount = result.elements.length;
        } catch (err) {
          processing = "failed";
          processingError = err instanceof Error ? err.message : String(err);
        }
      }
      await app.db
        .update(bimModelVersions)
        .set({ processing, elementCount })
        .where(eq(bimModelVersions.id, versionId));

      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "bim_model_version",
        objectId: versionId,
        payload: {
          modelId,
          version: versionNumber,
          fileId,
          sha256: saved.sha256,
          sizeBytes: saved.sizeBytes,
          processing,
          elementCount,
        },
        storePayload: true,
      });

      const fresh = await app.db
        .select()
        .from(bimModelVersions)
        .where(eq(bimModelVersions.id, versionId))
        .limit(1);
      return reply.status(201).send({ ...fresh[0], processingError });
    },
  );

  /* ---------------------------------------------------------------- */
  /* CDE state machine (spec Domain L #639-640)                        */
  /* ---------------------------------------------------------------- */

  app.patch("/bim/versions/:versionId/state", { preHandler: memberGate }, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const body = stateChangeSchema.parse(req.body);
    const { version, model } = await getVersion(versionId, req.companyId!);

    const from = version.cdeState as CdeState;
    const to = body.cdeState;
    if (!CDE_TRANSITIONS[from].includes(to)) {
      throw badRequest(
        `Illegal CDE transition ${from} → ${to}. ISO 19650 flow is wip → shared → published → archived (re-share from shared is allowed).`,
      );
    }
    if (!SUITABILITY_BY_STATE[to].includes(body.suitability)) {
      throw badRequest(
        `Suitability ${body.suitability} is not coherent with state "${to}" (allowed: ${SUITABILITY_BY_STATE[to].join(", ")})`,
      );
    }

    const [updated] = await app.db
      .update(bimModelVersions)
      .set({ cdeState: to, suitability: body.suitability })
      .where(eq(bimModelVersions.id, versionId))
      .returning();
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "bim_model_version",
      objectId: versionId,
      payload: {
        modelId: model.id,
        from,
        to,
        fromSuitability: version.suitability,
        suitability: body.suitability,
      },
      storePayload: true,
    });
    return updated;
  });

  /* ---------------------------------------------------------------- */
  /* Elements (spec #235)                                              */
  /* ---------------------------------------------------------------- */

  app.get("/bim/versions/:versionId/elements", { preHandler: memberGate }, async (req) => {
    const { versionId } = req.params as { versionId: string };
    await getVersion(versionId, req.companyId!);
    const q = elementListQuery.parse(req.query);
    const conds = [eq(bimElements.modelVersionId, versionId)];
    if (q.ifcType) conds.push(eq(bimElements.ifcType, q.ifcType.toUpperCase()));
    if (q.search) {
      const term = `%${q.search}%`;
      conds.push(or(ilike(bimElements.name, term), ilike(bimElements.globalId, term))!);
    }
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(bimElements).where(where);
    const items = await app.db
      .select()
      .from(bimElements)
      .where(where)
      .orderBy(asc(bimElements.ifcType), asc(bimElements.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get(
    "/bim/versions/:versionId/element-types",
    { preHandler: memberGate },
    async (req) => {
      const { versionId } = req.params as { versionId: string };
      await getVersion(versionId, req.companyId!);
      const rows = await app.db
        .select({ ifcType: bimElements.ifcType, count: count() })
        .from(bimElements)
        .where(eq(bimElements.modelVersionId, versionId))
        .groupBy(bimElements.ifcType)
        .orderBy(desc(count()), asc(bimElements.ifcType));
      const items = rows.map((r) => ({ ifcType: r.ifcType, count: Number(r.count) }));
      return { items, total: items.length };
    },
  );

  app.get(
    "/projects/:projectId/bim/elements/by-guid/:globalId",
    { preHandler: tool("read") },
    async (req) => {
      const { globalId } = req.params as { globalId: string };
      const rows = await app.db
        .select({
          element: bimElements,
          modelId: bimModels.id,
          modelName: bimModels.name,
          version: bimModelVersions.version,
        })
        .from(bimElements)
        .innerJoin(bimModelVersions, eq(bimModelVersions.id, bimElements.modelVersionId))
        .innerJoin(bimModels, eq(bimModels.id, bimModelVersions.modelId))
        .where(
          and(
            eq(bimElements.projectId, req.projectId!),
            eq(bimElements.globalId, globalId),
            eq(bimModels.companyId, req.companyId!),
          ),
        )
        .orderBy(desc(bimModelVersions.version), desc(bimElements.createdAt));
      const newest = rows[0];
      if (!newest) throw notFound("No element with this GlobalId in the project");
      return {
        ...newest.element,
        modelId: newest.modelId,
        modelName: newest.modelName,
        modelVersion: newest.version,
        occurrences: rows.map((r) => ({
          modelVersionId: r.element.modelVersionId,
          modelId: r.modelId,
          modelName: r.modelName,
          version: r.version,
        })),
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Federation (spec #232, #247)                                      */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/bim/federations", { preHandler: tool("read") }, async (req) => {
    const groups = await app.db
      .select()
      .from(federationGroups)
      .where(
        and(
          eq(federationGroups.companyId, req.companyId!),
          eq(federationGroups.projectId, req.projectId!),
        ),
      )
      .orderBy(asc(federationGroups.name));
    const groupIds = groups.map((g) => g.id);
    const members = groupIds.length
      ? await app.db
          .select({
            member: federationMembers,
            version: bimModelVersions.version,
            modelId: bimModels.id,
            modelName: bimModels.name,
            discipline: bimModels.discipline,
          })
          .from(federationMembers)
          .innerJoin(bimModelVersions, eq(bimModelVersions.id, federationMembers.modelVersionId))
          .innerJoin(bimModels, eq(bimModels.id, bimModelVersions.modelId))
          .where(inArray(federationMembers.groupId, groupIds))
      : [];
    const items = groups.map((g) => ({
      ...g,
      members: members
        .filter((m) => m.member.groupId === g.id)
        .map((m) => ({
          ...m.member,
          modelId: m.modelId,
          modelName: m.modelName,
          discipline: m.discipline,
          version: m.version,
        })),
    }));
    return { items, total: items.length };
  });

  app.post(
    "/projects/:projectId/bim/federations",
    { preHandler: tool("standard") },
    async (req, reply) => {
      const body = federationCreateSchema.parse(req.body);
      const id = newId("fed");
      const [created] = await app.db
        .insert(federationGroups)
        .values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          name: body.name,
          createdBy: req.user!.id,
        })
        .returning();
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "federation_group",
        objectId: id,
        payload: created,
      });
      return reply.status(201).send(created);
    },
  );

  async function getFederation(groupId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(federationGroups)
      .where(
        and(
          eq(federationGroups.id, groupId),
          eq(federationGroups.companyId, companyId),
          eq(federationGroups.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Federation group not found");
    return rows[0];
  }

  app.patch(
    "/projects/:projectId/bim/federations/:groupId",
    { preHandler: tool("standard") },
    async (req) => {
      const { groupId } = req.params as { groupId: string };
      await getFederation(groupId, req.companyId!, req.projectId!);
      const body = federationCreateSchema.parse(req.body);
      const [updated] = await app.db
        .update(federationGroups)
        .set({ name: body.name })
        .where(eq(federationGroups.id, groupId))
        .returning();
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "federation_group",
        objectId: groupId,
        payload: { name: body.name },
      });
      return updated;
    },
  );

  app.delete(
    "/projects/:projectId/bim/federations/:groupId",
    { preHandler: tool("standard") },
    async (req) => {
      await getFederation(
        (req.params as { groupId: string }).groupId,
        req.companyId!,
        req.projectId!,
      );
      const { groupId } = req.params as { groupId: string };
      await app.db.transaction(async (tx) => {
        await tx.delete(federationMembers).where(eq(federationMembers.groupId, groupId));
        await tx.delete(federationGroups).where(eq(federationGroups.id, groupId));
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "federation_group",
        objectId: groupId,
      });
      return { ok: true };
    },
  );

  app.post(
    "/projects/:projectId/bim/federations/:groupId/members",
    { preHandler: tool("standard") },
    async (req, reply) => {
      const { groupId } = req.params as { groupId: string };
      await getFederation(groupId, req.companyId!, req.projectId!);
      const body = federationMemberSchema.parse(req.body);

      const versionRows = await app.db
        .select({ id: bimModelVersions.id })
        .from(bimModelVersions)
        .innerJoin(bimModels, eq(bimModels.id, bimModelVersions.modelId))
        .where(
          and(
            eq(bimModelVersions.id, body.modelVersionId),
            eq(bimModels.companyId, req.companyId!),
            eq(bimModels.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!versionRows[0]) throw badRequest("Model version not found in this project");

      const existing = await app.db
        .select({ id: federationMembers.id })
        .from(federationMembers)
        .where(
          and(
            eq(federationMembers.groupId, groupId),
            eq(federationMembers.modelVersionId, body.modelVersionId),
          ),
        )
        .limit(1);
      if (existing[0]) throw conflict("Model version is already in this federation");

      const id = newId("fdm");
      const [created] = await app.db
        .insert(federationMembers)
        .values({
          id,
          groupId,
          modelVersionId: body.modelVersionId,
          transform: body.transform ?? null,
        })
        .returning();
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "federation_member",
        objectId: id,
        payload: { groupId, modelVersionId: body.modelVersionId },
      });
      return reply.status(201).send(created);
    },
  );

  app.delete(
    "/projects/:projectId/bim/federations/:groupId/members/:memberId",
    { preHandler: tool("standard") },
    async (req) => {
      const { groupId, memberId } = req.params as { groupId: string; memberId: string };
      await getFederation(groupId, req.companyId!, req.projectId!);
      const deleted = await app.db
        .delete(federationMembers)
        .where(and(eq(federationMembers.id, memberId), eq(federationMembers.groupId, groupId)))
        .returning({ id: federationMembers.id });
      if (!deleted[0]) throw notFound("Federation member not found");
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "federation_member",
        objectId: memberId,
        payload: { groupId },
      });
      return { ok: true };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Coordination issues (spec #240-241, #245; 2.14)                   */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/bim/issues", { preHandler: tool("read") }, async (req) => {
    const q = issueListQuery.parse(req.query);
    const conds = [
      eq(coordinationIssues.companyId, req.companyId!),
      eq(coordinationIssues.projectId, req.projectId!),
    ];
    if (q.status) conds.push(eq(coordinationIssues.status, q.status));
    if (q.assigneeId) conds.push(eq(coordinationIssues.assigneeId, q.assigneeId));
    if (q.search) {
      const term = `%${q.search}%`;
      conds.push(
        or(ilike(coordinationIssues.title, term), ilike(coordinationIssues.description, term))!,
      );
    }
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(coordinationIssues).where(where);
    const items = await app.db
      .select()
      .from(coordinationIssues)
      .where(where)
      .orderBy(desc(coordinationIssues.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post(
    "/projects/:projectId/bim/issues",
    { preHandler: tool("standard") },
    async (req, reply) => {
      const body = issueCreateSchema.parse(req.body);
      const number = await nextRecordNumber(app.db, req.projectId!, "coordination_issue");
      const id = newId("cis");
      const [created] = await app.db
        .insert(coordinationIssues)
        .values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          number,
          title: body.title,
          description: body.description ?? null,
          status: body.assigneeId ? "assigned" : "open",
          discipline: body.discipline ?? null,
          assigneeId: body.assigneeId ?? null,
          dueDate: body.dueDate ?? null,
          elementGlobalIds: body.elementGlobalIds ?? [],
          modelVersionId: body.modelVersionId ?? null,
          viewpoint: body.viewpoint ?? null,
          createdBy: req.user!.id,
        })
        .returning();
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "coordination_issue",
        objectId: id,
        payload: created,
        storePayload: true,
      });
      return reply.status(201).send(created);
    },
  );

  app.get("/bim/issues/:issueId", { preHandler: memberGate }, async (req) => {
    const { issueId } = req.params as { issueId: string };
    const rows = await app.db
      .select()
      .from(coordinationIssues)
      .where(
        and(eq(coordinationIssues.id, issueId), eq(coordinationIssues.companyId, req.companyId!)),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Coordination issue not found");
    return rows[0];
  });

  app.patch("/bim/issues/:issueId", { preHandler: memberGate }, async (req) => {
    const { issueId } = req.params as { issueId: string };
    const body = issuePatchSchema.parse(req.body);
    const rows = await app.db
      .select()
      .from(coordinationIssues)
      .where(
        and(eq(coordinationIssues.id, issueId), eq(coordinationIssues.companyId, req.companyId!)),
      )
      .limit(1);
    const existing = rows[0];
    if (!existing) throw notFound("Coordination issue not found");

    const statusChanged = body.status !== undefined && body.status !== existing.status;
    if (statusChanged) {
      const from = existing.status as CoordinationIssueStatus;
      if (!ISSUE_TRANSITIONS[from].includes(body.status!)) {
        throw badRequest(
          `Illegal status transition ${from} → ${body.status}. Flow: open → assigned → resolved → verified (void from anywhere).`,
        );
      }
      if (body.status === "assigned" && !(body.assigneeId ?? existing.assigneeId)) {
        throw badRequest("An assignee is required to move an issue to assigned");
      }
    }

    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.title !== undefined) patch["title"] = body.title;
    if (body.description !== undefined) patch["description"] = body.description;
    if (body.discipline !== undefined) patch["discipline"] = body.discipline;
    if (body.assigneeId !== undefined) patch["assigneeId"] = body.assigneeId;
    if (body.dueDate !== undefined) patch["dueDate"] = body.dueDate;
    if (body.elementGlobalIds !== undefined) patch["elementGlobalIds"] = body.elementGlobalIds;
    if (body.modelVersionId !== undefined) patch["modelVersionId"] = body.modelVersionId;
    if (body.viewpoint !== undefined) patch["viewpoint"] = body.viewpoint;
    if (statusChanged) patch["status"] = body.status;

    const [updated] = await app.db
      .update(coordinationIssues)
      .set(patch)
      .where(eq(coordinationIssues.id, issueId))
      .returning();

    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: statusChanged ? "state_change" : "update",
      objectType: "coordination_issue",
      objectId: issueId,
      payload: statusChanged ? { from: existing.status, to: body.status, patch } : patch,
      storePayload: statusChanged,
    });
    return updated;
  });

  /* ---------------------------------------------------------------- */
  /* Model file streaming for the viewer (spec #233, #247)             */
  /* ---------------------------------------------------------------- */

  app.get("/bim/files/:fileId/model", { preHandler: memberGate }, async (req, reply) => {
    const { fileId } = req.params as { fileId: string };
    const rows = await app.db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.companyId, req.companyId!)))
      .limit(1);
    const file = rows[0];
    if (!file) throw notFound("File not found");
    reply.header("content-type", "application/octet-stream");
    reply.header("content-length", String(file.sizeBytes));
    reply.header(
      "content-disposition",
      `inline; filename="${file.name.replace(/["\r\n]/g, "")}"`,
    );
    return reply.send(app.storage.readStream(file.storageKey));
  });
};
