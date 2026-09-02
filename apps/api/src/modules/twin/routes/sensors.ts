/**
 * Sensor channels, telemetry ingestion and the alert register (spec Domain L
 * #659-661).
 *
 * Ingestion is the machine-facing surface of the platform, so it is
 * deliberately boring and defensive:
 *  - the project-scoped route carries a real tool gate, which is what lets an
 *    OAuth2 gateway client call it at all (machine callers are refused on any
 *    route without one);
 *  - a reading is unique per (sensor, instant), so a gateway that retries a
 *    timed-out batch inserts nothing the second time and the response says how
 *    many were duplicates;
 *  - a deactivated sensor refuses data instead of quietly accepting it;
 *  - a batch produces at most one alert per breached bound, under a per-sensor
 *    cool-down (see alerts.ts).
 *
 * The demo "simulate" path writes readings tagged `source: simulation`, is
 * refused outside development, and never raises alerts, events or signals:
 * synthetic telemetry must never contaminate the assurance record.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, gte, ilike, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  assets,
  companyMemberships,
  locations,
  sensorAlerts,
  sensorReadings,
  sensors,
} from "@constructos/db";
import { SENSOR_ALERT_STATUSES, SENSOR_KINDS } from "@constructos/shared";
import { newId } from "../../../lib/ids.js";
import { badRequest, conflict, forbidden, notFound } from "../../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { applyBreaches, evaluateBreaches } from "../alerts.js";
import {
  buildTwinGates,
  buildTwinLoaders,
  isoTimestampSchema,
  ledger,
  nowISO,
} from "../shared.js";

const sensorCreateSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(SENSOR_KINDS),
  unit: z.string().min(1).max(30),
  assetId: z.string().max(64).nullable().optional(),
  locationId: z.string().max(64).nullable().optional(),
  ownerId: z.string().max(64).nullable().optional(),
  externalId: z.string().max(200).nullable().optional(),
  minValue: z.number().finite().nullable().optional(),
  maxValue: z.number().finite().nullable().optional(),
  designSetpoint: z.number().finite().nullable().optional(),
  staleAfterMinutes: z.number().min(1).max(1_000_000).nullable().optional(),
  cooldownMinutes: z.number().min(0).max(10_080).optional(),
});

const sensorPatchSchema = sensorCreateSchema.partial().extend({
  isActive: z.boolean().optional(),
});

const sensorListQuery = pageQuerySchema.extend({
  kind: z.enum(SENSOR_KINDS).optional(),
  assetId: z.string().max(64).optional(),
  search: z.string().max(200).optional(),
  active: z.enum(["0", "1"]).optional(),
});

const readingsIngestSchema = z.object({
  readings: z
    .array(z.object({ value: z.number().finite(), at: isoTimestampSchema }))
    .min(1)
    .max(5000),
});

const readingsQuerySchema = z.object({
  from: isoTimestampSchema.optional(),
  to: isoTimestampSchema.optional(),
  bucketMinutes: z.coerce.number().int().min(1).max(10080).optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});

const alertPatchSchema = z.object({
  status: z.enum(SENSOR_ALERT_STATUSES),
  notes: z.string().max(2000).optional(),
});

const RAW_READING_LIMIT = 2000;

export const sensorRoutes: FastifyPluginAsync = async (app) => {
  const gates = buildTwinGates(app);
  const { getSensor } = buildTwinLoaders(app);

  async function assertRefs(
    companyId: string,
    projectId: string,
    body: { assetId?: string | null; locationId?: string | null; ownerId?: string | null },
  ) {
    if (body.assetId) {
      const rows = await app.db
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(
            eq(assets.id, body.assetId),
            eq(assets.projectId, projectId),
            eq(assets.companyId, companyId),
          ),
        )
        .limit(1);
      if (!rows[0]) throw badRequest("Asset not found in this project");
    }
    if (body.locationId) {
      const rows = await app.db
        .select({ id: locations.id })
        .from(locations)
        .where(and(eq(locations.id, body.locationId), eq(locations.projectId, projectId)))
        .limit(1);
      if (!rows[0]) throw badRequest("Location not found in this project");
    }
    if (body.ownerId) {
      const rows = await app.db
        .select({ userId: companyMemberships.userId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.userId, body.ownerId),
          ),
        )
        .limit(1);
      if (!rows[0]) throw badRequest("Owner must be a member of this company");
    }
  }

  function assertBounds(min: number | null | undefined, max: number | null | undefined) {
    if (min !== null && min !== undefined && max !== null && max !== undefined && min > max) {
      throw badRequest("minValue cannot exceed maxValue");
    }
  }

  /* ---------------------------------------------------------------- */
  /* Register                                                          */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/sensors", { preHandler: gates.readGate }, async (req) => {
    const q = sensorListQuery.parse(req.query);
    const conds = [eq(sensors.companyId, req.companyId!), eq(sensors.projectId, req.projectId!)];
    if (q.kind) conds.push(eq(sensors.kind, q.kind));
    if (q.assetId) conds.push(eq(sensors.assetId, q.assetId));
    if (q.active) conds.push(eq(sensors.isActive, q.active === "1" ? "true" : "false"));
    if (q.search) conds.push(ilike(sensors.name, `%${q.search}%`));
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(sensors).where(where);
    const items = await app.db
      .select()
      .from(sensors)
      .where(where)
      .orderBy(asc(sensors.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /**
   * One request for the whole sensor tab (#661): last value, 24-hour
   * statistics and open alerts for every sensor, in three queries instead of
   * one readings request per sensor.
   */
  app.get("/projects/:projectId/sensors/overview", { preHandler: gates.readGate }, async (req) => {
    const q = z
      .object({ hours: z.coerce.number().int().min(1).max(720).default(24) })
      .parse(req.query);
    const since = new Date(Date.now() - q.hours * 3600_000).toISOString();
    const rows = await app.db
      .select()
      .from(sensors)
      .where(and(eq(sensors.companyId, req.companyId!), eq(sensors.projectId, req.projectId!)))
      .orderBy(asc(sensors.name))
      .limit(500);
    const ids = rows.map((s) => s.id);
    const [stats, alerts] = ids.length
      ? await Promise.all([
          app.db
            .select({
              sensorId: sensorReadings.sensorId,
              readings: count(),
              avg: sql<number>`avg(${sensorReadings.value})`,
              min: sql<number>`min(${sensorReadings.value})`,
              max: sql<number>`max(${sensorReadings.value})`,
            })
            .from(sensorReadings)
            .where(
              and(
                inArray(sensorReadings.sensorId, ids),
                gte(sensorReadings.at, since),
                eq(sensorReadings.source, "ingest"),
              ),
            )
            .groupBy(sensorReadings.sensorId),
          app.db
            .select({ sensorId: sensorAlerts.sensorId, kind: sensorAlerts.kind, n: count() })
            .from(sensorAlerts)
            .where(
              and(
                inArray(sensorAlerts.sensorId, ids),
                inArray(sensorAlerts.status, ["open", "acknowledged"]),
              ),
            )
            .groupBy(sensorAlerts.sensorId, sensorAlerts.kind),
        ])
      : [[], []];

    return {
      items: rows.map((sensor) => {
        const stat = stats.find((s) => s.sensorId === sensor.id);
        const own = alerts.filter((a) => a.sensorId === sensor.id);
        return {
          ...sensor,
          window: {
            hours: q.hours,
            readings: Number(stat?.readings ?? 0),
            avg: stat ? Number(stat.avg) : null,
            min: stat ? Number(stat.min) : null,
            max: stat ? Number(stat.max) : null,
            basis:
              stat && Number(stat.readings) > 0
                ? `${Number(stat.readings)} ingested readings in the last ${q.hours}h`
                : `no ingested readings in the last ${q.hours}h`,
          },
          openAlerts: own.reduce((sum, a) => sum + Number(a.n), 0),
          alertKinds: own.map((a) => a.kind),
        };
      }),
      total: rows.length,
      windowHours: q.hours,
    };
  });

  app.post("/projects/:projectId/sensors", { preHandler: gates.standardGate }, async (req, reply) => {
    const body = sensorCreateSchema.parse(req.body);
    assertBounds(body.minValue, body.maxValue);
    await assertRefs(req.companyId!, req.projectId!, body);
    const id = newId("sns");
    const [created] = await app.db
      .insert(sensors)
      .values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        assetId: body.assetId ?? null,
        locationId: body.locationId ?? null,
        ownerId: body.ownerId ?? null,
        externalId: body.externalId ?? null,
        name: body.name,
        kind: body.kind,
        unit: body.unit,
        minValue: body.minValue ?? null,
        maxValue: body.maxValue ?? null,
        designSetpoint: body.designSetpoint ?? null,
        staleAfterMinutes: body.staleAfterMinutes ?? null,
        cooldownMinutes: body.cooldownMinutes ?? 60,
      })
      .returning();
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "sensor",
      objectId: id,
      payload: created,
    });
    return reply.status(201).send(created);
  });

  app.get("/sensors/:sensorId", { preHandler: gates.companyGate }, async (req, reply) => {
    const { sensorId } = req.params as { sensorId: string };
    const sensor = await getSensor(sensorId, req.companyId!);
    await gates.requireToolFor(req, reply, sensor.projectId, "read");
    const alerts = await app.db
      .select()
      .from(sensorAlerts)
      .where(eq(sensorAlerts.sensorId, sensorId))
      .orderBy(desc(sensorAlerts.createdAt))
      .limit(50);
    return { ...sensor, alerts };
  });

  app.patch("/sensors/:sensorId", { preHandler: gates.companyGate }, async (req, reply) => {
    const { sensorId } = req.params as { sensorId: string };
    const body = sensorPatchSchema.parse(req.body);
    const existing = await getSensor(sensorId, req.companyId!);
    await gates.requireToolFor(req, reply, existing.projectId, "standard");
    // references are validated against THIS sensor's project — a sensor must
    // never end up pointing at another tenant's asset
    await assertRefs(req.companyId!, existing.projectId, body);
    assertBounds(
      body.minValue !== undefined ? body.minValue : existing.minValue,
      body.maxValue !== undefined ? body.maxValue : existing.maxValue,
    );

    const patch: Record<string, unknown> = {};
    for (const key of [
      "name",
      "kind",
      "unit",
      "assetId",
      "locationId",
      "ownerId",
      "externalId",
      "minValue",
      "maxValue",
      "designSetpoint",
      "staleAfterMinutes",
      "cooldownMinutes",
    ] as const) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (body.isActive !== undefined) patch["isActive"] = body.isActive ? "true" : "false";
    if (Object.keys(patch).length === 0) throw badRequest("Nothing to update");
    const [updated] = await app.db
      .update(sensors)
      .set(patch)
      .where(eq(sensors.id, sensorId))
      .returning();
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: existing.projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "sensor",
      objectId: sensorId,
      payload: patch,
    });
    return updated;
  });

  app.delete("/sensors/:sensorId", { preHandler: gates.companyGate }, async (req, reply) => {
    const { sensorId } = req.params as { sensorId: string };
    const sensor = await getSensor(sensorId, req.companyId!);
    await gates.requireToolFor(req, reply, sensor.projectId, "admin");
    await app.db.transaction(async (tx) => {
      await tx.delete(sensorReadings).where(eq(sensorReadings.sensorId, sensorId));
      await tx.delete(sensorAlerts).where(eq(sensorAlerts.sensorId, sensorId));
      await tx.delete(sensors).where(eq(sensors.id, sensorId));
    });
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: sensor.projectId,
      actorId: req.user!.id,
      action: "delete",
      objectType: "sensor",
      objectId: sensorId,
      payload: { name: sensor.name, projectId: sensor.projectId },
      storePayload: true,
    });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* Ingestion                                                         */
  /* ---------------------------------------------------------------- */

  async function ingest(
    sensor: typeof sensors.$inferSelect,
    readings: Array<{ value: number; at: string }>,
    actorId: string | null,
    source: "ingest" | "simulation",
  ) {
    if (sensor.isActive !== "true") {
      throw conflict("This sensor is deactivated and is not accepting readings");
    }
    // dedupe within the batch as well as against what is stored
    const byInstant = new Map<string, { value: number; at: string }>();
    for (const r of readings) byInstant.set(new Date(r.at).toISOString(), r);
    const rows = [...byInstant.entries()].map(([at, r]) => ({
      id: newId("srd"),
      sensorId: sensor.id,
      value: r.value,
      at,
      source,
    }));

    let inserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const done = await app.db
        .insert(sensorReadings)
        .values(chunk)
        .onConflictDoNothing({ target: [sensorReadings.sensorId, sensorReadings.at] })
        .returning({ id: sensorReadings.id });
      inserted += done.length;
    }
    const duplicates = rows.length - inserted;

    const latest = rows.reduce((acc, r) => (Date.parse(r.at) > Date.parse(acc.at) ? r : acc), rows[0]!);
    if (source === "ingest") {
      await app.db
        .update(sensors)
        .set({ lastReadingAt: latest.at, lastValue: latest.value })
        .where(eq(sensors.id, sensor.id));
    }

    const alerts =
      source === "ingest"
        ? await applyBreaches(
            app,
            sensor,
            evaluateBreaches(rows, { minValue: sensor.minValue, maxValue: sensor.maxValue }),
            actorId,
          )
        : { raised: 0, refreshed: 0, suppressed: 0, cleared: 0 };

    await ledger(app.db, {
      companyId: sensor.companyId,
      projectId: sensor.projectId,
      actorId,
      action: "create",
      objectType: "sensor_reading_batch",
      objectId: sensor.id,
      payload: { inserted, duplicates, source, alerts },
    });

    return { inserted, duplicates, source, alerts };
  }

  /** Machine-callable ingest: tool-gated, so OAuth2 gateway clients pass. */
  app.post(
    "/projects/:projectId/sensors/:sensorId/readings",
    { preHandler: gates.standardGate },
    async (req, reply) => {
      const { sensorId } = req.params as { sensorId: string };
      const body = readingsIngestSchema.parse(req.body);
      const sensor = await getSensor(sensorId, req.companyId!);
      if (sensor.projectId !== req.projectId) throw notFound("Sensor not found");
      return reply.status(201).send(await ingest(sensor, body.readings, req.user?.id ?? null, "ingest"));
    },
  );

  /** Legacy id-scoped ingest kept for the existing web client. */
  app.post("/sensors/:sensorId/readings", { preHandler: gates.companyGate }, async (req, reply) => {
    const { sensorId } = req.params as { sensorId: string };
    const body = readingsIngestSchema.parse(req.body);
    const sensor = await getSensor(sensorId, req.companyId!);
    await gates.requireToolFor(req, reply, sensor.projectId, "standard");
    return reply.status(201).send(await ingest(sensor, body.readings, req.user!.id, "ingest"));
  });

  /**
   * Development-only synthetic telemetry. Refused when NODE_ENV is
   * production, tagged `simulation`, excluded from every statistic, and it
   * raises no alerts: a demo button must not be able to write into the
   * assurance record.
   */
  app.post(
    "/projects/:projectId/sensors/:sensorId/simulate",
    { preHandler: gates.adminGate },
    async (req, reply) => {
      if (app.appConfig.NODE_ENV === "production") {
        throw forbidden("Synthetic telemetry is disabled in production");
      }
      const { sensorId } = req.params as { sensorId: string };
      const q = z
        .object({
          hours: z.number().int().min(1).max(168).default(24),
          base: z.number().finite().optional(),
          amplitude: z.number().finite().min(0).optional(),
        })
        .parse(req.body ?? {});
      const sensor = await getSensor(sensorId, req.companyId!);
      if (sensor.projectId !== req.projectId) throw notFound("Sensor not found");
      const base = q.base ?? sensor.designSetpoint ?? ((sensor.minValue ?? 0) + (sensor.maxValue ?? 20)) / 2;
      const amplitude = q.amplitude ?? Math.max(1, Math.abs(base) * 0.05);
      const now = Date.now();
      const readings = Array.from({ length: q.hours }, (_, i) => ({
        value: Math.round((base + Math.sin(i / 3) * amplitude) * 100) / 100,
        at: new Date(now - (q.hours - i) * 3600_000).toISOString(),
      }));
      const result = await ingest(sensor, readings, req.user!.id, "simulation");
      return reply.status(201).send({ ...result, note: "Simulated readings are excluded from statistics and raise no alerts" });
    },
  );

  /* ---------------------------------------------------------------- */
  /* Readings                                                          */
  /* ---------------------------------------------------------------- */

  app.get("/sensors/:sensorId/readings", { preHandler: gates.companyGate }, async (req, reply) => {
    const { sensorId } = req.params as { sensorId: string };
    const sensor = await getSensor(sensorId, req.companyId!);
    await gates.requireToolFor(req, reply, sensor.projectId, "read");
    const q = readingsQuerySchema.parse(req.query);
    const conds = [eq(sensorReadings.sensorId, sensorId)];
    if (q.from) conds.push(gte(sensorReadings.at, new Date(q.from).toISOString()));
    if (q.to) conds.push(lte(sensorReadings.at, new Date(q.to).toISOString()));
    const where = and(...conds);

    if (q.bucketMinutes) {
      const bucketSeconds = q.bucketMinutes * 60;
      const bucket = sql<number>`floor(extract(epoch from ${sensorReadings.at}) / ${sql.raw(
        String(bucketSeconds),
      )})`;
      const rows = await app.db
        .select({
          bucket,
          avg: sql<number>`avg(${sensorReadings.value})`,
          min: sql<number>`min(${sensorReadings.value})`,
          max: sql<number>`max(${sensorReadings.value})`,
          count: count(),
        })
        .from(sensorReadings)
        .where(where)
        .groupBy(bucket)
        .orderBy(bucket);
      const items = rows.map((r) => ({
        bucketStart: new Date(Number(r.bucket) * bucketSeconds * 1000).toISOString(),
        avg: Number(r.avg),
        min: Number(r.min),
        max: Number(r.max),
        count: Number(r.count),
      }));
      return { items, total: items.length, bucketMinutes: q.bucketMinutes, truncated: false };
    }

    // raw readings: report the real total and say plainly when the window was
    // truncated, instead of claiming `total` is the number of rows returned
    const [totalRow] = await app.db.select({ n: count() }).from(sensorReadings).where(where);
    const total = Number(totalRow?.n ?? 0);
    const limit = q.limit ?? RAW_READING_LIMIT;
    const items = await app.db
      .select()
      .from(sensorReadings)
      .where(where)
      .orderBy(desc(sensorReadings.at))
      .limit(limit);
    const truncated = total > items.length;
    return {
      items,
      total,
      returned: items.length,
      truncated,
      nextBefore: truncated ? (items[items.length - 1]?.at ?? null) : null,
      hint: truncated
        ? `Only the newest ${items.length} of ${total} readings are returned - pass bucketMinutes for an aggregate, or set "to" to nextBefore to page back`
        : null,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Alerts                                                            */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/sensor-alerts", { preHandler: gates.readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ status: z.enum(SENSOR_ALERT_STATUSES).optional() })
      .parse(req.query);
    const conds = [
      eq(sensorAlerts.companyId, req.companyId!),
      eq(sensorAlerts.projectId, req.projectId!),
    ];
    if (q.status) conds.push(eq(sensorAlerts.status, q.status));
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(sensorAlerts).where(where);
    const items = await app.db
      .select({
        alert: sensorAlerts,
        sensorName: sensors.name,
        unit: sensors.unit,
        assetName: assets.name,
        assetTag: assets.tagCode,
      })
      .from(sensorAlerts)
      .innerJoin(sensors, eq(sensors.id, sensorAlerts.sensorId))
      .leftJoin(assets, eq(assets.id, sensorAlerts.assetId))
      .where(where)
      .orderBy(desc(sensorAlerts.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      items.map((r) => ({
        ...r.alert,
        sensorName: r.sensorName,
        unit: r.unit,
        assetName: r.assetName,
        assetTag: r.assetTag,
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.patch("/sensor-alerts/:alertId", { preHandler: gates.companyGate }, async (req, reply) => {
    const { alertId } = req.params as { alertId: string };
    const body = alertPatchSchema.parse(req.body);
    const rows = await app.db
      .select()
      .from(sensorAlerts)
      .where(and(eq(sensorAlerts.id, alertId), eq(sensorAlerts.companyId, req.companyId!)))
      .limit(1);
    const alert = rows[0];
    if (!alert) throw notFound("Alert not found");
    await gates.requireToolFor(req, reply, alert.projectId, "standard");
    const now = nowISO();
    const [updated] = await app.db
      .update(sensorAlerts)
      .set({
        status: body.status,
        notes: body.notes ?? alert.notes,
        acknowledgedBy: body.status === "acknowledged" ? req.user!.id : alert.acknowledgedBy,
        acknowledgedAt: body.status === "acknowledged" ? now : alert.acknowledgedAt,
        clearedAt: body.status === "cleared" ? now : alert.clearedAt,
        updatedAt: now,
      })
      .where(eq(sensorAlerts.id, alertId))
      .returning();
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: alert.projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "sensor_alert",
      objectId: alertId,
      payload: { from: alert.status, to: body.status, notes: body.notes },
      storePayload: true,
    });
    return updated;
  });
};
