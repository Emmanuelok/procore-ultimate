/**
 * Model registry, version upload/ingestion, the ISO 19650 CDE state machine,
 * element browsing and the viewer's model stream.
 *
 * Spec: #231-236 (registry, versions, comparison), #247 (viewer stream),
 * #248 (spatial containment), Domain L #638-640 (quality gate, authorisation).
 *
 * Three rules this file enforces that the first implementation did not:
 *  1. every id-scoped route resolves the record's project and runs the bim
 *     tool gate against it (a `bim: none` member can no longer publish);
 *  2. the upload streams to storage and hands parsing to the ingestion
 *     pipeline instead of buffering and parsing on the event loop;
 *  3. shared -> published is an authorisation, not an edit: bim admin, a
 *     different actor from the uploader, extraction ready and the model
 *     quality gate passed (or an explicit, recorded override).
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  assetElementLinks,
  bimElementLinks,
  bimElements,
  bimModelVersions,
  bimModels,
  bimVersionDiffs,
  coordinationIssues,
  federationMembers,
  fileAccessLog,
  files,
  realityCaptures,
} from "@constructos/db";
import {
  CDE_STATES,
  DRAWING_DISCIPLINES,
  MODEL_FORMATS,
  SUITABILITY_CODES,
  type CdeState,
  type SuitabilityCode,
} from "@constructos/shared";
import { newId } from "../../../lib/ids.js";
import { badRequest, conflict, forbidden, notFound } from "../../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { diffVersions, issuesAffectedByDiff, type DiffElement } from "../diff.js";
import { INLINE_PARSE_MAX_BYTES, processVersion } from "../ingest.js";
import { buildBimGates, buildLoaders, ledger, nowISO } from "../shared.js";

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

const MODEL_FILE_RE = /\.(ifc|ifczip|ifcxml|gltf|glb|nwd|nwc|nwf|rvt|dwg|zip)$/i;

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
  note: z.string().max(2000).optional(),
  /** publish a version that failed the quality gate, with a recorded reason */
  overrideQualityReason: z.string().min(10).max(2000).optional(),
});

const elementListQuery = pageQuerySchema.extend({
  ifcType: z.string().max(100).optional(),
  search: z.string().max(200).optional(),
  storey: z.string().max(200).optional(),
  locationId: z.string().max(64).optional(),
  hasBounds: z.enum(["0", "1"]).optional(),
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const modelRoutes: FastifyPluginAsync = async (app) => {
  const gates = buildBimGates(app);
  const { getModel, getVersion } = buildLoaders(app);

  /* ---------------------------------------------------------------- */
  /* Models                                                            */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/bim/models",
    { preHandler: gates.readGate },
    async (req) => {
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

      const modelIds = models.map((m) => m.id);
      const versions = modelIds.length
        ? await app.db
            .select()
            .from(bimModelVersions)
            .where(inArray(bimModelVersions.modelId, modelIds))
            .orderBy(desc(bimModelVersions.version))
        : [];
      const byId = new Map(versions.map((v) => [v.id, v]));
      const latestByModel = new Map<string, (typeof versions)[number]>();
      for (const v of versions) if (!latestByModel.has(v.modelId)) latestByModel.set(v.modelId, v);

      const items = models.map((m) => ({
        ...m,
        currentVersion: m.currentVersionId ? (byId.get(m.currentVersionId) ?? null) : null,
        /** newest version even when it is still being extracted */
        latestVersion: latestByModel.get(m.id) ?? null,
        versionCount: versions.filter((v) => v.modelId === m.id).length,
      }));
      return paginate(items, Number(totalRow?.n ?? 0), q);
    },
  );

  app.post(
    "/projects/:projectId/bim/models",
    { preHandler: gates.standardGate },
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
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "bim_model",
        objectId: id,
        payload: created,
      });
      return reply.status(201).send(created);
    },
  );

  app.get("/bim/models/:modelId", { preHandler: gates.companyGate }, async (req, reply) => {
    const { modelId } = req.params as { modelId: string };
    const model = await getModel(modelId, req.companyId!);
    await gates.requireToolFor(req, reply, model.projectId, "read");
    const versions = await app.db
      .select()
      .from(bimModelVersions)
      .where(eq(bimModelVersions.modelId, modelId))
      .orderBy(desc(bimModelVersions.version));
    return { ...model, versions };
  });

  app.patch("/bim/models/:modelId", { preHandler: gates.companyGate }, async (req, reply) => {
    const { modelId } = req.params as { modelId: string };
    const model = await getModel(modelId, req.companyId!);
    await gates.requireToolFor(req, reply, model.projectId, "standard");
    const body = modelPatchSchema.parse(req.body);
    const patch: Record<string, unknown> = { updatedAt: nowISO() };
    if (body.name !== undefined) patch["name"] = body.name;
    if (body.discipline !== undefined) patch["discipline"] = body.discipline;
    if (Object.keys(patch).length === 1) throw badRequest("Nothing to update");
    const [updated] = await app.db
      .update(bimModels)
      .set(patch)
      .where(and(eq(bimModels.id, modelId), eq(bimModels.companyId, req.companyId!)))
      .returning();
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: model.projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "bim_model",
      objectId: modelId,
      payload: patch,
    });
    return updated;
  });

  /**
   * Delete a model. Everything derived from its versions goes with it in one
   * transaction, and the references other registers hold (issues, asset
   * links, reality captures, 4D/5D links) are cleared rather than left
   * dangling. Storage objects are removed after the commit.
   */
  app.delete("/bim/models/:modelId", { preHandler: gates.companyGate }, async (req, reply) => {
    const { modelId } = req.params as { modelId: string };
    const model = await getModel(modelId, req.companyId!);
    await gates.requireToolFor(req, reply, model.projectId, "admin");

    const storageKeys: string[] = [];
    await app.db.transaction(async (tx) => {
      const versions = await tx
        .select({ id: bimModelVersions.id, fileId: bimModelVersions.fileId })
        .from(bimModelVersions)
        .where(eq(bimModelVersions.modelId, modelId));
      const versionIds = versions.map((v) => v.id);
      const fileIds = versions.map((v) => v.fileId);

      if (versionIds.length > 0) {
        await tx.delete(bimElements).where(inArray(bimElements.modelVersionId, versionIds));
        await tx
          .delete(bimVersionDiffs)
          .where(
            or(
              inArray(bimVersionDiffs.baseVersionId, versionIds),
              inArray(bimVersionDiffs.targetVersionId, versionIds),
            ),
          );
        await tx
          .delete(federationMembers)
          .where(inArray(federationMembers.modelVersionId, versionIds));
        await tx
          .update(coordinationIssues)
          .set({ modelVersionId: null })
          .where(inArray(coordinationIssues.modelVersionId, versionIds));
        await tx
          .update(assetElementLinks)
          .set({ modelVersionId: null })
          .where(inArray(assetElementLinks.modelVersionId, versionIds));
        await tx
          .update(bimElementLinks)
          .set({ modelVersionId: null })
          .where(inArray(bimElementLinks.modelVersionId, versionIds));
        await tx
          .update(realityCaptures)
          .set({ modelVersionId: null })
          .where(inArray(realityCaptures.modelVersionId, versionIds));
        await tx.delete(bimModelVersions).where(eq(bimModelVersions.modelId, modelId));
      }
      await tx.delete(bimModels).where(eq(bimModels.id, modelId));

      if (fileIds.length > 0) {
        const fileRows = await tx
          .select({ id: files.id, storageKey: files.storageKey })
          .from(files)
          .where(and(inArray(files.id, fileIds), eq(files.companyId, req.companyId!)));
        for (const f of fileRows) storageKeys.push(f.storageKey);
        await tx.delete(files).where(
          and(
            inArray(
              files.id,
              fileRows.map((f) => f.id),
            ),
            eq(files.companyId, req.companyId!),
          ),
        );
      }
    });

    for (const key of storageKeys) {
      try {
        await app.storage.remove(key);
      } catch (err) {
        app.log.warn({ err, key }, "bim: failed to remove model storage object");
      }
    }

    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: model.projectId,
      actorId: req.user!.id,
      action: "delete",
      objectType: "bim_model",
      objectId: modelId,
      payload: { name: model.name, projectId: model.projectId, files: storageKeys.length },
      storePayload: true,
    });
    return { ok: true, filesRemoved: storageKeys.length };
  });

  /* ---------------------------------------------------------------- */
  /* Version upload + ingestion                                        */
  /* ---------------------------------------------------------------- */

  async function uploadVersion(req: FastifyRequest, modelId: string) {
    const model = await getModel(modelId, req.companyId!);
    const mp = await req.file();
    if (!mp) throw badRequest("A model file is required (multipart field 'file')");
    const filename = (mp.filename || `${model.name}.${model.format}`).replace(/[\r\n"]/g, "");
    if (!MODEL_FILE_RE.test(filename)) {
      mp.file.resume();
      throw badRequest(
        "Unsupported model file type. Accepted: .ifc, .ifczip, .ifcxml, .gltf, .glb, .nwd, .nwc, .nwf, .rvt, .dwg, .zip",
      );
    }

    const saved = await app.storage.saveStream(req.companyId!, mp.file);
    if (mp.file.truncated) {
      await app.storage.remove(saved.storageKey).catch(() => undefined);
      throw badRequest(
        `Model exceeds the upload limit of ${app.appConfig.UPLOAD_MAX_BYTES} bytes`,
      );
    }
    if (saved.sizeBytes === 0) {
      await app.storage.remove(saved.storageKey).catch(() => undefined);
      throw badRequest("Uploaded file is empty");
    }

    const fileId = newId("fil");
    const versionId = newId("bmv");
    const inline = saved.sizeBytes <= INLINE_PARSE_MAX_BYTES;

    let versionNumber = 0;
    try {
      versionNumber = await app.db.transaction(async (tx) => {
        // serialise number allocation per model: two concurrent uploads used
        // to compute the same number, and the loser got a 500 with an
        // orphaned file behind it
        await tx
          .select({ id: bimModels.id })
          .from(bimModels)
          .where(eq(bimModels.id, modelId))
          .for("update");
        const [maxRow] = await tx
          .select({ maxV: sql<number>`coalesce(max(${bimModelVersions.version}), 0)` })
          .from(bimModelVersions)
          .where(eq(bimModelVersions.modelId, modelId));
        const next = Number(maxRow?.maxV ?? 0) + 1;
        await tx.insert(files).values({
          id: fileId,
          companyId: req.companyId!,
          projectId: model.projectId,
          name: filename,
          contentType: mp.mimetype || "application/octet-stream",
          sizeBytes: saved.sizeBytes,
          sha256: saved.sha256,
          storageKey: saved.storageKey,
          metadata: { source: "bim_model_version", modelId },
          uploadedBy: req.user!.id,
        });
        await tx.insert(bimModelVersions).values({
          id: versionId,
          modelId,
          version: next,
          fileId,
          cdeState: "wip",
          suitability: "S0",
          processing: "queued",
          sizeBytes: saved.sizeBytes,
          uploadedBy: req.user!.id,
        });
        return next;
      });
    } catch (err) {
      await app.storage.remove(saved.storageKey).catch(() => undefined);
      const code = (err as { code?: string }).code;
      if (code === "23505") {
        throw conflict("Another upload for this model landed first — retry");
      }
      throw err;
    }

    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: model.projectId,
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
        ingestion: inline ? "inline" : "queued",
      },
      storePayload: true,
    });

    const outcome = inline ? await processVersion(app, versionId, req.user!.id) : null;
    const fresh = await app.db
      .select()
      .from(bimModelVersions)
      .where(eq(bimModelVersions.id, versionId))
      .limit(1);
    return {
      ...fresh[0]!,
      processingError: outcome?.processingError ?? fresh[0]?.processingError ?? null,
      queued: !inline,
      locationsCreated: outcome?.locationsCreated ?? 0,
    };
  }

  /** Project-scoped upload: tool-gated, so pipelines and machine clients can call it. */
  app.post(
    "/projects/:projectId/bim/models/:modelId/versions",
    { preHandler: gates.standardGate },
    async (req, reply) => {
      const { modelId } = req.params as { modelId: string };
      const model = await getModel(modelId, req.companyId!);
      if (model.projectId !== req.projectId) throw notFound("Model not found");
      return reply.status(201).send(await uploadVersion(req, modelId));
    },
  );

  /** Legacy id-scoped upload kept for the existing web client. */
  app.post("/bim/models/:modelId/versions", { preHandler: gates.companyGate }, async (req, reply) => {
    const { modelId } = req.params as { modelId: string };
    const model = await getModel(modelId, req.companyId!);
    await gates.requireToolFor(req, reply, model.projectId, "standard");
    return reply.status(201).send(await uploadVersion(req, modelId));
  });

  app.get("/bim/versions/:versionId", { preHandler: gates.companyGate }, async (req, reply) => {
    const { versionId } = req.params as { versionId: string };
    const { version, model } = await getVersion(versionId, req.companyId!);
    await gates.requireToolFor(req, reply, model.projectId, "read");
    return { ...version, model };
  });

  /** Re-run extraction (a failed parse, a fixed file, or a queued big model). */
  app.post(
    "/bim/versions/:versionId/process",
    { preHandler: gates.companyGate },
    async (req, reply) => {
      const { versionId } = req.params as { versionId: string };
      const { model } = await getVersion(versionId, req.companyId!);
      await gates.requireToolFor(req, reply, model.projectId, "standard");
      return processVersion(app, versionId, req.user!.id);
    },
  );

  /* ---------------------------------------------------------------- */
  /* CDE state machine + authorisation (#639-640, #638)                */
  /* ---------------------------------------------------------------- */

  app.patch(
    "/bim/versions/:versionId/state",
    { preHandler: gates.companyGate },
    async (req, reply) => {
      const { versionId } = req.params as { versionId: string };
      const body = stateChangeSchema.parse(req.body);
      const { version, model } = await getVersion(versionId, req.companyId!);

      const from = version.cdeState as CdeState;
      const to = body.cdeState;
      const publishing = to === "published" && from !== "published";
      await gates.requireToolFor(
        req,
        reply,
        model.projectId,
        publishing || to === "archived" ? "admin" : "standard",
      );

      if (!CDE_TRANSITIONS[from].includes(to)) {
        throw badRequest(
          `Illegal CDE transition ${from} -> ${to}. ISO 19650 flow is wip -> shared -> published -> archived (re-share from shared is allowed).`,
        );
      }
      if (!SUITABILITY_BY_STATE[to].includes(body.suitability)) {
        throw badRequest(
          `Suitability ${body.suitability} is not coherent with state "${to}" (allowed: ${SUITABILITY_BY_STATE[to].join(", ")})`,
        );
      }

      if (publishing) {
        // ISO 19650 authorisation is a second pair of eyes, not an edit
        if (version.uploadedBy === req.user!.id) {
          throw forbidden(
            "The person who uploaded a container cannot authorise its publication — ISO 19650 requires a separate authoriser",
          );
        }
        if (version.processing !== "ready") {
          throw conflict(
            `Cannot publish a version whose extraction is "${version.processing}" — process it first`,
          );
        }
        const quality = version.qualityReport as
          | { passed?: boolean; findings?: Array<{ check: string; severity: string }> }
          | null;
        if (quality && quality.passed === false && !body.overrideQualityReason) {
          throw conflict(
            `The model quality gate failed (${(quality.findings ?? [])
              .filter((f) => f.severity === "blocking")
              .map((f) => f.check)
              .join(", ")}). Publish again with overrideQualityReason to accept it on the record.`,
          );
        }
      }

      const patch: Record<string, unknown> = { cdeState: to, suitability: body.suitability };
      if (publishing) {
        patch["authorisedBy"] = req.user!.id;
        patch["authorisedAt"] = nowISO();
        patch["authorisationNote"] = body.overrideQualityReason ?? body.note ?? null;
      }
      const [updated] = await app.db
        .update(bimModelVersions)
        .set(patch)
        .where(eq(bimModelVersions.id, versionId))
        .returning();
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: model.projectId,
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
          authorisedBy: publishing ? req.user!.id : undefined,
          overrideQualityReason: body.overrideQualityReason,
          note: body.note,
        },
        storePayload: true,
      });
      return updated;
    },
  );

  /* ---------------------------------------------------------------- */
  /* Elements                                                          */
  /* ---------------------------------------------------------------- */

  app.get(
    "/bim/versions/:versionId/elements",
    { preHandler: gates.companyGate },
    async (req, reply) => {
      const { versionId } = req.params as { versionId: string };
      const { model } = await getVersion(versionId, req.companyId!);
      await gates.requireToolFor(req, reply, model.projectId, "read");
      const q = elementListQuery.parse(req.query);
      const conds = [eq(bimElements.modelVersionId, versionId)];
      if (q.ifcType) conds.push(eq(bimElements.ifcType, q.ifcType.toUpperCase()));
      if (q.storey) conds.push(eq(bimElements.storey, q.storey));
      if (q.locationId) conds.push(eq(bimElements.locationId, q.locationId));
      if (q.hasBounds === "1") conds.push(sql`${bimElements.minX} is not null`);
      if (q.hasBounds === "0") conds.push(sql`${bimElements.minX} is null`);
      if (q.search) {
        const term = `%${q.search}%`;
        conds.push(
          or(
            ilike(bimElements.name, term),
            ilike(bimElements.globalId, term),
            ilike(bimElements.typeName, term),
          )!,
        );
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
    },
  );

  app.get(
    "/bim/versions/:versionId/element-types",
    { preHandler: gates.companyGate },
    async (req, reply) => {
      const { versionId } = req.params as { versionId: string };
      const { model } = await getVersion(versionId, req.companyId!);
      await gates.requireToolFor(req, reply, model.projectId, "read");
      const rows = await app.db
        .select({ ifcType: bimElements.ifcType, count: count() })
        .from(bimElements)
        .where(eq(bimElements.modelVersionId, versionId))
        .groupBy(bimElements.ifcType)
        .orderBy(desc(count()), asc(bimElements.ifcType));
      const items = rows.map((r) => ({ ifcType: r.ifcType, count: Number(r.count) }));
      const storeys = await app.db
        .select({ storey: bimElements.storey, count: count() })
        .from(bimElements)
        .where(eq(bimElements.modelVersionId, versionId))
        .groupBy(bimElements.storey)
        .orderBy(asc(bimElements.storey));
      return {
        items,
        total: items.length,
        storeys: storeys
          .filter((s) => s.storey !== null)
          .map((s) => ({ storey: s.storey as string, count: Number(s.count) })),
      };
    },
  );

  app.get(
    "/projects/:projectId/bim/elements/by-guid/:globalId",
    { preHandler: gates.readGate },
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
  /* Version comparison (#236)                                         */
  /* ---------------------------------------------------------------- */

  async function diffElements(versionId: string): Promise<DiffElement[]> {
    const rows = await app.db
      .select({
        globalId: bimElements.globalId,
        ifcType: bimElements.ifcType,
        name: bimElements.name,
        propertyHash: bimElements.propertyHash,
        storey: bimElements.storey,
      })
      .from(bimElements)
      .where(eq(bimElements.modelVersionId, versionId))
      .limit(200_000);
    return rows;
  }

  app.get("/bim/versions/:versionId/diff", { preHandler: gates.companyGate }, async (req, reply) => {
    const { versionId } = req.params as { versionId: string };
    const q = z.object({ against: z.string().max(64).optional() }).parse(req.query);
    const { version, model } = await getVersion(versionId, req.companyId!);
    await gates.requireToolFor(req, reply, model.projectId, "read");

    let baseVersionId = q.against;
    if (!baseVersionId) {
      const previous = await app.db
        .select({ id: bimModelVersions.id })
        .from(bimModelVersions)
        .where(
          and(
            eq(bimModelVersions.modelId, version.modelId),
            sql`${bimModelVersions.version} < ${version.version}`,
          ),
        )
        .orderBy(desc(bimModelVersions.version))
        .limit(1);
      baseVersionId = previous[0]?.id;
    }
    if (!baseVersionId) {
      return {
        baseVersionId: null,
        targetVersionId: versionId,
        reason: "This is the first version of the model — there is nothing to compare it with",
        diff: null,
      };
    }
    const base = await getVersion(baseVersionId, req.companyId!);
    if (base.version.modelId !== version.modelId) {
      throw badRequest("Both versions must belong to the same model");
    }

    const cached = await app.db
      .select()
      .from(bimVersionDiffs)
      .where(
        and(
          eq(bimVersionDiffs.baseVersionId, baseVersionId),
          eq(bimVersionDiffs.targetVersionId, versionId),
        ),
      )
      .limit(1);

    if (cached[0]) {
      return {
        baseVersionId,
        targetVersionId: versionId,
        baseVersion: base.version.version,
        targetVersion: version.version,
        cached: true,
        diff: cached[0],
      };
    }

    const [baseElements, targetElements] = await Promise.all([
      diffElements(baseVersionId),
      diffElements(versionId),
    ]);
    const diff = diffVersions(baseElements, targetElements);

    const openIssues = await app.db
      .select({
        id: coordinationIssues.id,
        number: coordinationIssues.number,
        title: coordinationIssues.title,
        assigneeId: coordinationIssues.assigneeId,
        elementGlobalIds: coordinationIssues.elementGlobalIds,
      })
      .from(coordinationIssues)
      .where(
        and(
          eq(coordinationIssues.projectId, model.projectId),
          inArray(coordinationIssues.status, ["open", "assigned", "resolved"]),
        ),
      )
      .limit(1000);
    const affected = issuesAffectedByDiff(openIssues, diff);

    const id = newId("bvd");
    const [stored] = await app.db
      .insert(bimVersionDiffs)
      .values({
        id,
        companyId: req.companyId!,
        projectId: model.projectId,
        modelId: model.id,
        baseVersionId,
        targetVersionId: versionId,
        addedCount: diff.added.length,
        removedCount: diff.removed.length,
        modifiedCount: diff.modified.length,
        unchangedCount: diff.unchangedCount,
        byType: diff.byType,
        sampleAdded: diff.added.slice(0, 500),
        sampleRemoved: diff.removed.slice(0, 500),
        sampleModified: diff.modified.slice(0, 500),
        computedBy: req.user!.id,
      })
      .returning();

    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: model.projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "bim_version_diff",
      objectId: id,
      payload: {
        modelId: model.id,
        baseVersionId,
        targetVersionId: versionId,
        added: diff.added.length,
        removed: diff.removed.length,
        modified: diff.modified.length,
      },
      storePayload: true,
    });

    return {
      baseVersionId,
      targetVersionId: versionId,
      baseVersion: base.version.version,
      targetVersion: version.version,
      cached: false,
      diff: stored,
      duplicateGlobalIds: diff.duplicateGlobalIds.slice(0, 100),
      affectedIssues: affected.map((a) => ({
        id: a.issue.id,
        number: a.issue.number,
        title: a.issue.title,
        assigneeId: a.issue.assigneeId,
        removedElements: a.removed,
        modifiedElements: a.modified,
      })),
    };
  });

  /* ---------------------------------------------------------------- */
  /* Model stream for the viewer (#233, #247)                          */
  /* ---------------------------------------------------------------- */

  /**
   * Streams ONLY files that are a BIM model version's container, resolved
   * through `bim_model_versions` rather than by file id alone, and records
   * the access. The previous version of this route served any file in the
   * company — including private documents under legal hold — with no access
   * log and no ledger entry.
   */
  app.get("/bim/files/:fileId/model", { preHandler: gates.companyGate }, async (req, reply) => {
    const { fileId } = req.params as { fileId: string };
    const rows = await app.db
      .select({ file: files, model: bimModels, version: bimModelVersions })
      .from(files)
      .innerJoin(bimModelVersions, eq(bimModelVersions.fileId, files.id))
      .innerJoin(bimModels, eq(bimModels.id, bimModelVersions.modelId))
      .where(and(eq(files.id, fileId), eq(files.companyId, req.companyId!)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("File not found");
    if (row.file.deletedAt) throw notFound("File not found");
    await gates.requireToolFor(req, reply, row.model.projectId, "read");

    await app.db.insert(fileAccessLog).values({
      id: newId("fal"),
      fileId,
      userId: req.user!.id,
      action: "download",
      companyId: req.companyId!,
      projectId: row.model.projectId,
      context: "bim_viewer",
      version: row.file.version,
    });
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: row.model.projectId,
      actorId: req.user!.id,
      action: "access",
      objectType: "file",
      objectId: fileId,
      payload: { context: "bim_viewer", modelId: row.model.id, versionId: row.version.id },
    });

    reply.header("content-type", "application/octet-stream");
    reply.header("content-length", String(row.file.sizeBytes));
    reply.header(
      "content-disposition",
      `inline; filename="${row.file.name.replace(/["\r\n]/g, "")}"`,
    );
    return reply.send(app.storage.readStream(row.file.storageKey));
  });
};
