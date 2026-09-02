/**
 * Reality capture overlay register (spec #246; Vol II Z #1076-1080).
 *
 * What was actually captured on site, registered against the model version it
 * is compared with: point clouds, drone flights, 360 tours, total-station
 * setting-out records. A capture can carry a scan-vs-model deviation summary
 * (sample count, mean and max deviation against a stated tolerance), which is
 * the number a claim or a handover argument later depends on - so it is
 * recorded with its tolerance and its sample size, never as a bare "accurate".
 *
 * Deliberately not here: point-cloud processing. The platform records the
 * artefact, its registration metadata and the surveyor's deviation statistics;
 * it does not pretend to compute them from the raw scan.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  bimModelVersions,
  bimModels,
  files,
  locations,
  realityCaptures,
} from "@constructos/db";
import { REALITY_CAPTURE_KINDS, REALITY_CAPTURE_STATUSES } from "@constructos/shared";
import { newId } from "../../../lib/ids.js";
import { badRequest, notFound } from "../../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { buildBimGates, isoDateSchema, ledger, nowISO } from "../shared.js";

const deviationSchema = z.object({
  sampleCount: z.number().int().min(1).max(100_000_000),
  meanMm: z.number().finite(),
  maxMm: z.number().finite(),
  toleranceMm: z.number().finite().positive(),
  withinTolerance: z.number().int().min(0),
});

const captureCreateSchema = z.object({
  kind: z.enum(REALITY_CAPTURE_KINDS),
  name: z.string().min(1).max(200),
  description: z.string().max(5000).nullable().optional(),
  status: z.enum(REALITY_CAPTURE_STATUSES).optional(),
  capturedAt: isoDateSchema.nullable().optional(),
  fileId: z.string().max(64).nullable().optional(),
  modelVersionId: z.string().max(64).nullable().optional(),
  locationId: z.string().max(64).nullable().optional(),
  alignment: z.record(z.string(), z.unknown()).nullable().optional(),
  coveragePercent: z.number().min(0).max(100).nullable().optional(),
  deviation: deviationSchema.nullable().optional(),
  viewerUrl: z.string().max(2000).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
});

const capturePatchSchema = captureCreateSchema.partial();

const captureListQuery = pageQuerySchema.extend({
  kind: z.enum(REALITY_CAPTURE_KINDS).optional(),
  status: z.enum(REALITY_CAPTURE_STATUSES).optional(),
  modelVersionId: z.string().max(64).optional(),
});

export const captureRoutes: FastifyPluginAsync = async (app) => {
  const gates = buildBimGates(app);

  async function assertRefs(
    companyId: string,
    projectId: string,
    body: { fileId?: string | null; modelVersionId?: string | null; locationId?: string | null },
  ) {
    if (body.fileId) {
      const rows = await app.db
        .select({ id: files.id })
        .from(files)
        .where(and(eq(files.id, body.fileId), eq(files.companyId, companyId)))
        .limit(1);
      if (!rows[0]) throw badRequest("File not found in this company");
    }
    if (body.modelVersionId) {
      const rows = await app.db
        .select({ id: bimModelVersions.id })
        .from(bimModelVersions)
        .innerJoin(bimModels, eq(bimModels.id, bimModelVersions.modelId))
        .where(
          and(
            eq(bimModelVersions.id, body.modelVersionId),
            eq(bimModels.companyId, companyId),
            eq(bimModels.projectId, projectId),
          ),
        )
        .limit(1);
      if (!rows[0]) throw badRequest("Model version not found in this project");
    }
    if (body.locationId) {
      const rows = await app.db
        .select({ id: locations.id })
        .from(locations)
        .where(and(eq(locations.id, body.locationId), eq(locations.projectId, projectId)))
        .limit(1);
      if (!rows[0]) throw badRequest("Location not found in this project");
    }
  }

  app.get(
    "/projects/:projectId/bim/reality-captures",
    { preHandler: gates.readGate },
    async (req) => {
      const q = captureListQuery.parse(req.query);
      const conds = [
        eq(realityCaptures.companyId, req.companyId!),
        eq(realityCaptures.projectId, req.projectId!),
      ];
      if (q.kind) conds.push(eq(realityCaptures.kind, q.kind));
      if (q.status) conds.push(eq(realityCaptures.status, q.status));
      if (q.modelVersionId) conds.push(eq(realityCaptures.modelVersionId, q.modelVersionId));
      const where = and(...conds);
      const [totalRow] = await app.db.select({ n: count() }).from(realityCaptures).where(where);
      const items = await app.db
        .select()
        .from(realityCaptures)
        .where(where)
        .orderBy(desc(realityCaptures.capturedAt), desc(realityCaptures.createdAt))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(
        items.map((c) => ({
          ...c,
          withinTolerancePercent:
            c.deviation && c.deviation.sampleCount > 0
              ? Math.round((c.deviation.withinTolerance / c.deviation.sampleCount) * 1000) / 10
              : null,
        })),
        Number(totalRow?.n ?? 0),
        q,
      );
    },
  );

  app.post(
    "/projects/:projectId/bim/reality-captures",
    { preHandler: gates.standardGate },
    async (req, reply) => {
      const body = captureCreateSchema.parse(req.body);
      await assertRefs(req.companyId!, req.projectId!, body);
      if (body.deviation && body.deviation.withinTolerance > body.deviation.sampleCount) {
        throw badRequest("withinTolerance cannot exceed sampleCount");
      }
      const id = newId("rcp");
      const [created] = await app.db
        .insert(realityCaptures)
        .values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          kind: body.kind,
          name: body.name,
          description: body.description ?? null,
          status: body.status ?? "captured",
          capturedAt: body.capturedAt ?? null,
          fileId: body.fileId ?? null,
          modelVersionId: body.modelVersionId ?? null,
          locationId: body.locationId ?? null,
          alignment: body.alignment ?? null,
          coveragePercent: body.coveragePercent ?? null,
          deviation: body.deviation ?? null,
          viewerUrl: body.viewerUrl ?? null,
          latitude: body.latitude ?? null,
          longitude: body.longitude ?? null,
          createdBy: req.user!.id,
        })
        .returning();
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "reality_capture",
        objectId: id,
        payload: created,
        storePayload: true,
      });
      return reply.status(201).send(created);
    },
  );

  app.patch(
    "/projects/:projectId/bim/reality-captures/:captureId",
    { preHandler: gates.standardGate },
    async (req) => {
      const { captureId } = req.params as { captureId: string };
      const body = capturePatchSchema.parse(req.body);
      const rows = await app.db
        .select()
        .from(realityCaptures)
        .where(
          and(
            eq(realityCaptures.id, captureId),
            eq(realityCaptures.companyId, req.companyId!),
            eq(realityCaptures.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const existing = rows[0];
      if (!existing) throw notFound("Reality capture not found");
      await assertRefs(req.companyId!, req.projectId!, body);
      if (body.deviation && body.deviation.withinTolerance > body.deviation.sampleCount) {
        throw badRequest("withinTolerance cannot exceed sampleCount");
      }
      const patch: Record<string, unknown> = { updatedAt: nowISO() };
      for (const key of [
        "kind",
        "name",
        "description",
        "status",
        "capturedAt",
        "fileId",
        "modelVersionId",
        "locationId",
        "alignment",
        "coveragePercent",
        "deviation",
        "viewerUrl",
        "latitude",
        "longitude",
      ] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (Object.keys(patch).length === 1) throw badRequest("Nothing to update");
      const [updated] = await app.db
        .update(realityCaptures)
        .set(patch)
        .where(eq(realityCaptures.id, captureId))
        .returning();
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "reality_capture",
        objectId: captureId,
        payload: patch,
      });
      return updated;
    },
  );

  app.delete(
    "/projects/:projectId/bim/reality-captures/:captureId",
    { preHandler: gates.adminGate },
    async (req) => {
      const { captureId } = req.params as { captureId: string };
      const deleted = await app.db
        .delete(realityCaptures)
        .where(
          and(
            eq(realityCaptures.id, captureId),
            eq(realityCaptures.companyId, req.companyId!),
            eq(realityCaptures.projectId, req.projectId!),
          ),
        )
        .returning({ id: realityCaptures.id, name: realityCaptures.name });
      if (!deleted[0]) throw notFound("Reality capture not found");
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "reality_capture",
        objectId: captureId,
        payload: { name: deleted[0].name },
        storePayload: true,
      });
      return { ok: true };
    },
  );
};
