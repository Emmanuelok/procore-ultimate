/**
 * ENVIRONMENTAL, SEISMIC AND TIDAL EVENT LOG (spec Vol II Z #1084).
 *
 * One register for everything that happened TO the site rather than on it: a
 * tremor, a tide, a flood, a lightning strike, a dust or noise exceedance, a
 * spill. Two behaviours make it worth keeping:
 *
 *  • An event whose magnitude passes a stated threshold is marked as an
 *    exceedance and raises a signal — a vibration limit breached beside a
 *    listed building is a notifiable fact, not a diary entry.
 *  • Every event is also written to the platform-wide `events` table, so the
 *    forensics and assurance layers see occurrences from this module in the
 *    same chronology as everything else.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import { events as platformEvents, siteEnvironmentalEvents } from "@constructos/db";
import {
  SITE_ENVIRONMENTAL_CATEGORIES,
  SITE_ENVIRONMENTAL_DETECTIONS,
  SITE_ENVIRONMENTAL_STATUSES,
  SIGNAL_SEVERITIES,
} from "@constructos/shared";
import { badRequest } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import {
  allocateReference,
  alreadySignalled,
  assertLocation,
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
  raiseSignal,
} from "../shared.js";

const eventBody = z.object({
  category: z.enum(SITE_ENVIRONMENTAL_CATEGORIES),
  detectedVia: z.enum(SITE_ENVIRONMENTAL_DETECTIONS).default("observation"),
  occurredAt: isoTimestampSchema,
  durationMinutes: z.number().min(0).max(100_000).nullish(),
  magnitude: z.number().nullish(),
  magnitudeUnit: z.string().max(40).nullish(),
  thresholdValue: z.number().nullish(),
  thresholdUnit: z.string().max(40).nullish(),
  severity: z.enum(SIGNAL_SEVERITIES).default("low"),
  locationId: idSchema.nullish(),
  zoneId: idSchema.nullish(),
  lat: latSchema.nullish(),
  lon: lonSchema.nullish(),
  sensorRef: z.string().max(120).nullish(),
  impact: z.string().max(2000).nullish(),
  workStopped: z.boolean().default(false),
  stoppageMinutes: z.number().min(0).max(100_000).nullish(),
  actionsTaken: z.string().max(2000).nullish(),
  weatherObservationId: idSchema.nullish(),
  reportedByName: z.string().max(200).nullish(),
  fileIds: fileIdsSchema.default([]),
  notes: z.string().max(4000).nullish(),
});

export const environmentalRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);
  const base = "/projects/:projectId/site/environmental-events";

  app.get(base, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({
        category: z.enum(SITE_ENVIRONMENTAL_CATEGORIES).optional(),
        status: z.enum(SITE_ENVIRONMENTAL_STATUSES).optional(),
        exceededOnly: z.coerce.boolean().optional(),
        from: isoTimestampSchema.optional(),
        to: isoTimestampSchema.optional(),
      })
      .parse(req.query);
    const where = and(
      eq(siteEnvironmentalEvents.companyId, req.companyId!),
      eq(siteEnvironmentalEvents.projectId, projectId),
      q.category ? eq(siteEnvironmentalEvents.category, q.category) : undefined,
      q.status ? eq(siteEnvironmentalEvents.status, q.status) : undefined,
      q.exceededOnly ? eq(siteEnvironmentalEvents.exceededThreshold, 1) : undefined,
      q.from ? gte(siteEnvironmentalEvents.occurredAt, q.from) : undefined,
      q.to ? lte(siteEnvironmentalEvents.occurredAt, q.to) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(siteEnvironmentalEvents).where(where).orderBy(desc(siteEnvironmentalEvents.occurredAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(siteEnvironmentalEvents).where(where),
    ]);
    const byCategory: Record<string, number> = {};
    for (const row of rows) byCategory[row.category] = (byCategory[row.category] ?? 0) + 1;
    return { ...paginate(rows, total?.n ?? 0, q), byCategory };
  });

  app.post(base, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = eventBody.parse(req.body);
    const companyId = req.companyId!;
    if (body.locationId) await assertLocation(app.db, projectId, body.locationId);
    if (body.thresholdValue !== null && body.thresholdValue !== undefined && (body.magnitude === null || body.magnitude === undefined)) {
      throw badRequest(
        "A threshold was given with no magnitude to test against it. Record the measured value, or leave the threshold off.",
      );
    }
    if (
      body.magnitude !== null &&
      body.magnitude !== undefined &&
      body.thresholdValue !== null &&
      body.thresholdValue !== undefined &&
      body.magnitudeUnit &&
      body.thresholdUnit &&
      body.magnitudeUnit !== body.thresholdUnit
    ) {
      throw badRequest(
        `The magnitude is in ${body.magnitudeUnit} and the threshold in ${body.thresholdUnit}. The platform will not compare two different units.`,
      );
    }

    const exceeded =
      body.magnitude !== null &&
      body.magnitude !== undefined &&
      body.thresholdValue !== null &&
      body.thresholdValue !== undefined &&
      body.magnitude > body.thresholdValue;

    const { number, reference } = await allocateReference(app.db, projectId, "site_environmental_event", "ENV");
    const id = newId("sev");

    let signalId: string | null = null;
    if (exceeded) {
      const raised = await alreadySignalled(app.db, companyId, ["site_environmental_threshold"], projectId);
      const key = `env:${id}`;
      if (!raised.has(key)) {
        signalId = await raiseSignal(app.db, companyId, projectId, req.user!.id, {
          detector: "site_environmental_threshold",
          severity: body.severity === "info" ? "medium" : body.severity,
          confidence: 0.9,
          title: `${body.category.replace(/_/g, " ")} threshold exceeded (${reference})`,
          explanation: `A measured ${body.magnitude}${body.magnitudeUnit ?? ""} exceeds the ${body.thresholdValue}${body.thresholdUnit ?? ""} limit at ${body.occurredAt}. ${body.impact ?? ""}`.trim(),
          key,
          subjectType: "site_environmental_event",
          subjectId: id,
          evidence: {
            eventId: id,
            reference,
            category: body.category,
            magnitude: body.magnitude,
            threshold: body.thresholdValue,
            unit: body.magnitudeUnit ?? body.thresholdUnit ?? null,
          },
        });
      }
    }

    // Mirror into the platform-wide occurrence log so forensics and assurance
    // see this in the same chronology as every other event.
    const assuranceEventId = newId("evt");
    await app.db.insert(platformEvents).values({
      id: assuranceEventId,
      companyId,
      projectId,
      type: `site_${body.category}`,
      occurredAt: body.occurredAt,
      location: body.locationId ?? body.sensorRef ?? null,
      detectedOrReported: body.detectedVia === "sensor" ? "detected" : "reported",
      payload: {
        reference,
        category: body.category,
        magnitude: body.magnitude ?? null,
        magnitudeUnit: body.magnitudeUnit ?? null,
        thresholdValue: body.thresholdValue ?? null,
        exceeded,
        workStopped: body.workStopped,
        stoppageMinutes: body.stoppageMinutes ?? null,
      },
      createdBy: req.user!.id,
    });

    const [row] = await app.db
      .insert(siteEnvironmentalEvents)
      .values({
        id,
        companyId,
        projectId,
        number,
        reference,
        category: body.category,
        detectedVia: body.detectedVia,
        occurredAt: body.occurredAt,
        durationMinutes: body.durationMinutes ?? null,
        magnitude: body.magnitude ?? null,
        magnitudeUnit: body.magnitudeUnit ?? null,
        thresholdValue: body.thresholdValue ?? null,
        thresholdUnit: body.thresholdUnit ?? null,
        exceededThreshold: exceeded ? 1 : 0,
        severity: body.severity,
        status: "open",
        locationId: body.locationId ?? null,
        zoneId: body.zoneId ?? null,
        lat: body.lat ?? null,
        lon: body.lon ?? null,
        sensorRef: body.sensorRef ?? null,
        impact: body.impact ?? null,
        workStopped: body.workStopped ? 1 : 0,
        stoppageMinutes: body.stoppageMinutes ?? null,
        actionsTaken: body.actionsTaken ?? null,
        weatherObservationId: body.weatherObservationId ?? null,
        assuranceEventId,
        signalId,
        fileIds: body.fileIds,
        notes: body.notes ?? null,
        reportedByName: body.reportedByName ?? null,
        createdBy: req.user!.id,
      })
      .returning();

    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "site_environmental_event",
      objectId: id,
      payload: { reference, category: body.category, exceeded, assuranceEventId },
    });
    return reply.code(201).send({
      ...row,
      exceeded,
      thresholdVerdict:
        body.thresholdValue === null || body.thresholdValue === undefined
          ? "No threshold was given, so this event is logged without a verdict."
          : exceeded
            ? `Measured ${body.magnitude}${body.magnitudeUnit ?? ""} against a limit of ${body.thresholdValue}${body.thresholdUnit ?? ""}: exceeded.`
            : `Measured ${body.magnitude}${body.magnitudeUnit ?? ""} against a limit of ${body.thresholdValue}${body.thresholdUnit ?? ""}: within the limit.`,
    });
  });

  app.patch(`${base}/:id`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const body = patchSchemaOf(eventBody.omit({ category: true, occurredAt: true })).parse(req.body);
    notFoundIfMissing(
      (
        await app.db
          .select({ id: siteEnvironmentalEvents.id })
          .from(siteEnvironmentalEvents)
          .where(
            and(
              eq(siteEnvironmentalEvents.id, id),
              eq(siteEnvironmentalEvents.companyId, companyId),
              eq(siteEnvironmentalEvents.projectId, projectId),
            ),
          )
          .limit(1)
      )[0],
      "Environmental event",
    );
    const set = patchSet(body as Record<string, unknown>, [
      "detectedVia",
      "durationMinutes",
      "magnitudeUnit",
      "thresholdUnit",
      "severity",
      "locationId",
      "zoneId",
      "lat",
      "lon",
      "sensorRef",
      "impact",
      "stoppageMinutes",
      "actionsTaken",
      "weatherObservationId",
      "reportedByName",
      "fileIds",
      "notes",
    ]);
    if (body.workStopped !== undefined) set["workStopped"] = body.workStopped ? 1 : 0;
    const [row] = await app.db
      .update(siteEnvironmentalEvents)
      .set(set)
      .where(and(eq(siteEnvironmentalEvents.id, id), eq(siteEnvironmentalEvents.companyId, companyId)))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "site_environmental_event",
      objectId: id,
      payload: set,
    });
    return row;
  });

  app.post(`${base}/:id/close`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const { actionsTaken } = z.object({ actionsTaken: z.string().trim().min(1).max(2000) }).parse(req.body);
    const [row] = await app.db
      .update(siteEnvironmentalEvents)
      .set({ status: "closed", actionsTaken, closedAt: nowISO(), closedBy: req.user!.id, updatedAt: nowISO() })
      .where(
        and(
          eq(siteEnvironmentalEvents.id, id),
          eq(siteEnvironmentalEvents.companyId, companyId),
          eq(siteEnvironmentalEvents.projectId, projectId),
        ),
      )
      .returning();
    if (!row) throw badRequest("Environmental event not found in this project.");
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "site_environmental_event",
      objectId: id,
      payload: { to: "closed", actionsTaken },
    });
    return row;
  });
};
