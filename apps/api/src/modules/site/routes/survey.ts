/**
 * SURVEY CONTROL AND SETTING OUT (spec Vol II Z #1081).
 *
 * Control points are the project's spatial truth; setting-out records are what
 * was built from them. The rule that makes the second worth anything: the
 * person who CHECKS a setting-out record may not be the person who set the
 * work out. The route refuses it, in the same way the progress reconciliation
 * refuses a self-verified claim.
 *
 * A control point that has been disturbed is not deleted — it is marked
 * disturbed, so every setting-out record that used it can still be found.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { siteSettingOutRecords, siteSurveyPoints } from "@constructos/db";
import { SITE_SURVEY_METHODS, SITE_SURVEY_POINT_KINDS, SITE_SURVEY_POINT_STATUSES } from "@constructos/shared";
import { badRequest, conflict } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import {
  allocateReference,
  assertLocation,
  assertTask,
  buildGates,
  fileIdsSchema,
  idSchema,
  isoTimestampSchema,
  latSchema,
  ledger,
  lonSchema,
  notFoundIfMissing,
  nowISO,
  patchSchemaOf,
  patchSet,
} from "../shared.js";

const pointBody = z.object({
  pointRef: z.string().trim().min(1).max(60),
  kind: z.enum(SITE_SURVEY_POINT_KINDS).default("control"),
  easting: z.number().nullish(),
  northing: z.number().nullish(),
  elevation: z.number().nullish(),
  lat: latSchema.nullish(),
  lon: lonSchema.nullish(),
  coordinateSystem: z.string().max(120).nullish(),
  datum: z.string().max(120).nullish(),
  method: z.enum(SITE_SURVEY_METHODS).default("gnss"),
  accuracyMm: z.number().min(0).max(100_000).nullish(),
  establishedByName: z.string().trim().max(200).nullish(),
  establishedAt: isoTimestampSchema.nullish(),
  description: z.string().max(1000).nullish(),
  notes: z.string().max(2000).nullish(),
});

const settingOutBody = z.object({
  description: z.string().trim().min(1).max(500),
  elementRef: z.string().max(200).nullish(),
  locationId: idSchema.nullish(),
  scheduleTaskId: idSchema.nullish(),
  drawingId: idSchema.nullish(),
  drawingRevision: z.string().max(60).nullish(),
  method: z.enum(SITE_SURVEY_METHODS).default("total_station"),
  controlPointRefs: z.array(z.string().trim().min(1).max(60)).max(200).default([]),
  toleranceMm: z.number().min(0).max(100_000).nullish(),
  maxDeviationMm: z.number().min(0).max(100_000).nullish(),
  setOutByName: z.string().trim().max(200).nullish(),
  setOutAt: isoTimestampSchema.nullish(),
  fileIds: fileIdsSchema.default([]),
  notes: z.string().max(4000).nullish(),
});

export const surveyRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);
  const base = "/projects/:projectId/site";

  /* Control points ------------------------------------------------- */

  app.get(`${base}/survey-points`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({ status: z.enum(SITE_SURVEY_POINT_STATUSES).optional(), kind: z.enum(SITE_SURVEY_POINT_KINDS).optional() })
      .parse(req.query);
    const where = and(
      eq(siteSurveyPoints.companyId, req.companyId!),
      eq(siteSurveyPoints.projectId, projectId),
      q.status ? eq(siteSurveyPoints.status, q.status) : undefined,
      q.kind ? eq(siteSurveyPoints.kind, q.kind) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(siteSurveyPoints).where(where).orderBy(desc(siteSurveyPoints.createdAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(siteSurveyPoints).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post(`${base}/survey-points`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = pointBody.parse(req.body);
    const companyId = req.companyId!;
    const hasGrid = typeof body.easting === "number" && typeof body.northing === "number";
    const hasGeo = typeof body.lat === "number" && typeof body.lon === "number";
    if (!hasGrid && !hasGeo) {
      throw badRequest(
        "A survey point needs a position: either easting/northing on the project grid or latitude/longitude. A point with no coordinates cannot be set out from.",
      );
    }
    const clash = (
      await app.db
        .select({ id: siteSurveyPoints.id })
        .from(siteSurveyPoints)
        .where(and(eq(siteSurveyPoints.projectId, projectId), eq(siteSurveyPoints.pointRef, body.pointRef)))
        .limit(1)
    )[0];
    if (clash) {
      throw conflict(
        `Point reference ${body.pointRef} already exists on this project. Two points with one reference make every setting-out record that quotes it ambiguous.`,
      );
    }
    const id = newId("svp");
    const [row] = await app.db
      .insert(siteSurveyPoints)
      .values({
        id,
        companyId,
        projectId,
        pointRef: body.pointRef,
        kind: body.kind,
        easting: body.easting ?? null,
        northing: body.northing ?? null,
        elevation: body.elevation ?? null,
        lat: body.lat ?? null,
        lon: body.lon ?? null,
        coordinateSystem: body.coordinateSystem ?? null,
        datum: body.datum ?? null,
        method: body.method,
        accuracyMm: body.accuracyMm ?? null,
        establishedByName: body.establishedByName ?? null,
        establishedAt: body.establishedAt ?? nowISO(),
        status: "active",
        description: body.description ?? null,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "site_survey_point",
      objectId: id,
      payload: { pointRef: body.pointRef, kind: body.kind, method: body.method },
    });
    return reply.code(201).send(row);
  });

  app.patch(`${base}/survey-points/:id`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const body = patchSchemaOf(pointBody.omit({ pointRef: true })).parse(req.body);
    notFoundIfMissing(
      (
        await app.db
          .select({ id: siteSurveyPoints.id })
          .from(siteSurveyPoints)
          .where(and(eq(siteSurveyPoints.id, id), eq(siteSurveyPoints.companyId, companyId), eq(siteSurveyPoints.projectId, projectId)))
          .limit(1)
      )[0],
      "Survey point",
    );
    const set = patchSet(body as Record<string, unknown>, [
      "kind",
      "easting",
      "northing",
      "elevation",
      "lat",
      "lon",
      "coordinateSystem",
      "datum",
      "method",
      "accuracyMm",
      "establishedByName",
      "establishedAt",
      "description",
      "notes",
    ]);
    const [row] = await app.db
      .update(siteSurveyPoints)
      .set(set)
      .where(and(eq(siteSurveyPoints.id, id), eq(siteSurveyPoints.companyId, companyId)))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "site_survey_point",
      objectId: id,
      payload: set,
    });
    return row;
  });

  app.post(`${base}/survey-points/:id/check`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const body = z
      .object({
        deltaMm: z.number().min(0).max(1_000_000),
        status: z.enum(SITE_SURVEY_POINT_STATUSES).optional(),
        checkedAt: isoTimestampSchema.optional(),
        notes: z.string().max(1000).optional(),
      })
      .parse(req.body);
    const point = notFoundIfMissing(
      (
        await app.db
          .select()
          .from(siteSurveyPoints)
          .where(and(eq(siteSurveyPoints.id, id), eq(siteSurveyPoints.companyId, companyId), eq(siteSurveyPoints.projectId, projectId)))
          .limit(1)
      )[0],
      "Survey point",
    );
    // A point whose check exceeds its own stated accuracy has moved.
    const status =
      body.status ??
      (point.accuracyMm !== null && body.deltaMm > point.accuracyMm ? "disturbed" : point.status);
    const at = body.checkedAt ?? nowISO();
    const [row] = await app.db
      .update(siteSurveyPoints)
      .set({
        lastCheckedAt: at,
        lastCheckedBy: req.user!.id,
        lastDeltaMm: body.deltaMm,
        status,
        notes: body.notes ?? point.notes,
        updatedAt: nowISO(),
      })
      .where(and(eq(siteSurveyPoints.id, id), eq(siteSurveyPoints.companyId, companyId)))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "site_survey_point",
      objectId: id,
      payload: { deltaMm: body.deltaMm, accuracyMm: point.accuracyMm, from: point.status, to: status },
    });
    return {
      ...row,
      verdict:
        point.accuracyMm === null
          ? "The point carries no stated accuracy, so the platform cannot say whether this delta means it has moved."
          : body.deltaMm > point.accuracyMm
            ? `The check is ${body.deltaMm} mm from the record against a stated accuracy of ${point.accuracyMm} mm: the point is treated as disturbed.`
            : `The check is ${body.deltaMm} mm, within the stated accuracy of ${point.accuracyMm} mm.`,
    };
  });

  /* Setting out ---------------------------------------------------- */

  app.get(`${base}/setting-out`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema.extend({ status: z.string().max(20).optional(), scheduleTaskId: idSchema.optional() }).parse(req.query);
    const where = and(
      eq(siteSettingOutRecords.companyId, req.companyId!),
      eq(siteSettingOutRecords.projectId, projectId),
      q.status ? eq(siteSettingOutRecords.status, q.status) : undefined,
      q.scheduleTaskId ? eq(siteSettingOutRecords.scheduleTaskId, q.scheduleTaskId) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(siteSettingOutRecords).where(where).orderBy(desc(siteSettingOutRecords.createdAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(siteSettingOutRecords).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post(`${base}/setting-out`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = settingOutBody.parse(req.body);
    const companyId = req.companyId!;
    if (body.locationId) await assertLocation(app.db, projectId, body.locationId);
    if (body.scheduleTaskId) await assertTask(app.db, projectId, body.scheduleTaskId);

    if (body.controlPointRefs.length > 0) {
      const known = await app.db
        .select({ pointRef: siteSurveyPoints.pointRef, status: siteSurveyPoints.status })
        .from(siteSurveyPoints)
        .where(and(eq(siteSurveyPoints.projectId, projectId), inArray(siteSurveyPoints.pointRef, body.controlPointRefs)));
      const byRef = new Map(known.map((k) => [k.pointRef, k.status]));
      const missing = body.controlPointRefs.filter((r) => !byRef.has(r));
      if (missing.length > 0) {
        throw badRequest(
          `Control point(s) ${missing.join(", ")} are not on this project's survey register. Setting out from a point the platform does not hold cannot be checked by anyone.`,
        );
      }
      const disturbed = body.controlPointRefs.filter((r) => byRef.get(r) === "disturbed" || byRef.get(r) === "destroyed");
      if (disturbed.length > 0) {
        throw badRequest(
          `Control point(s) ${disturbed.join(", ")} are recorded as disturbed or destroyed. Re-establish them before setting out from them.`,
        );
      }
    }

    const { number, reference } = await allocateReference(app.db, projectId, "site_setting_out", "SO");
    const id = newId("sor");
    const [row] = await app.db
      .insert(siteSettingOutRecords)
      .values({
        id,
        companyId,
        projectId,
        number,
        reference,
        description: body.description,
        elementRef: body.elementRef ?? null,
        locationId: body.locationId ?? null,
        scheduleTaskId: body.scheduleTaskId ?? null,
        drawingId: body.drawingId ?? null,
        drawingRevision: body.drawingRevision ?? null,
        method: body.method,
        controlPointRefs: body.controlPointRefs,
        toleranceMm: body.toleranceMm ?? null,
        maxDeviationMm: body.maxDeviationMm ?? null,
        setOutBy: req.user!.id,
        setOutByName: body.setOutByName ?? null,
        setOutAt: body.setOutAt ?? nowISO(),
        status: "set_out",
        fileIds: body.fileIds,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "site_setting_out_record",
      objectId: id,
      payload: { reference, description: body.description, controlPointRefs: body.controlPointRefs },
    });
    return reply.code(201).send(row);
  });

  app.post(`${base}/setting-out/:id/check`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const body = z
      .object({
        outcome: z.enum(["checked", "rejected"]).default("checked"),
        maxDeviationMm: z.number().min(0).max(1_000_000).nullish(),
        checkedByName: z.string().trim().max(200).nullish(),
        checkedAt: isoTimestampSchema.optional(),
        rejectionReason: z.string().max(2000).nullish(),
      })
      .parse(req.body ?? {});
    const record = notFoundIfMissing(
      (
        await app.db
          .select()
          .from(siteSettingOutRecords)
          .where(
            and(
              eq(siteSettingOutRecords.id, id),
              eq(siteSettingOutRecords.companyId, companyId),
              eq(siteSettingOutRecords.projectId, projectId),
            ),
          )
          .limit(1)
      )[0],
      "Setting-out record",
    );
    if (record.status !== "set_out") {
      throw conflict(`This record is ${record.status}; only a record awaiting a check can be checked.`);
    }
    if (record.setOutBy === req.user!.id) {
      throw conflict(
        "You set this work out. The check on a setting-out record must be carried out by someone else — a person checking their own setting out is not a check.",
      );
    }
    if (body.outcome === "rejected" && !body.rejectionReason) {
      throw badRequest("A rejected check must say what was wrong.");
    }
    const deviation = body.maxDeviationMm ?? record.maxDeviationMm;
    if (
      body.outcome === "checked" &&
      record.toleranceMm !== null &&
      deviation !== null &&
      deviation > record.toleranceMm
    ) {
      throw badRequest(
        `The measured deviation of ${deviation} mm exceeds the stated tolerance of ${record.toleranceMm} mm. This check cannot be recorded as passed — reject it, or correct the setting out and re-measure.`,
      );
    }
    const at = body.checkedAt ?? nowISO();
    const [row] = await app.db
      .update(siteSettingOutRecords)
      .set({
        status: body.outcome,
        checkedBy: req.user!.id,
        checkedByName: body.checkedByName ?? null,
        checkedAt: at,
        maxDeviationMm: deviation,
        rejectionReason: body.outcome === "rejected" ? (body.rejectionReason ?? null) : null,
        updatedAt: nowISO(),
      })
      .where(and(eq(siteSettingOutRecords.id, id), eq(siteSettingOutRecords.companyId, companyId), eq(siteSettingOutRecords.status, "set_out")))
      .returning();
    if (!row) throw conflict("The record changed while the check was being applied. Reload and try again.");
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "site_setting_out_record",
      objectId: id,
      payload: { to: body.outcome, checkedBy: req.user!.id, setOutBy: record.setOutBy, maxDeviationMm: deviation },
    });
    return row;
  });

  app.post(`${base}/setting-out/:id/approve`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const [row] = await app.db
      .update(siteSettingOutRecords)
      .set({ status: "approved", approvedBy: req.user!.id, approvedAt: nowISO(), updatedAt: nowISO() })
      .where(
        and(
          eq(siteSettingOutRecords.id, id),
          eq(siteSettingOutRecords.companyId, companyId),
          eq(siteSettingOutRecords.projectId, projectId),
          eq(siteSettingOutRecords.status, "checked"),
          sql`${siteSettingOutRecords.checkedBy} is distinct from ${req.user!.id}`,
        ),
      )
      .returning();
    if (!row) {
      throw conflict(
        "Only a record that has been checked by someone other than you, and not yet approved, can be approved here.",
      );
    }
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "site_setting_out_record",
      objectId: id,
      payload: { to: "approved" },
    });
    return row;
  });
};
