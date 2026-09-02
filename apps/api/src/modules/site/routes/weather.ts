/**
 * WEATHER ARCHIVE AND EXCEPTIONAL-WEATHER ANALYSIS (spec Vol II Z #1074–1076).
 *
 * Three registers and one report: daily observations (manual, provider or
 * imported), the contract baseline that defines "adverse", and the analysis
 * that compares them and produces the figure a claim is built on.
 *
 * The provider adapter is a graceful no-op: with no coordinates, no network
 * or a bad response, `POST .../weather/capture` returns what it could not do
 * and why, and the manual archive keeps working exactly as before.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import { siteWeatherAnalyses, siteWeatherBaselines, siteWeatherObservations } from "@constructos/db";
import {
  SITE_WEATHER_BASELINE_SOURCES,
  SITE_WEATHER_COMPARATORS,
  SITE_WEATHER_METRICS,
  SITE_WEATHER_SOURCES,
} from "@constructos/shared";
import { badRequest, conflict } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { classifyDay, daysInclusive, type Threshold } from "../engines/weather.js";
import { captureWeather, runWeatherAnalysis, toWeatherReading } from "../service.js";
import {
  buildGates,
  idSchema,
  isoDateSchema,
  ledger,
  nowISO,
  notFoundIfMissing,
  patchSchemaOf,
  patchSet,
} from "../shared.js";

const observationBody = z.object({
  observedOn: isoDateSchema,
  source: z.enum(SITE_WEATHER_SOURCES).default("manual"),
  provider: z.string().max(80).nullish(),
  stationRef: z.string().max(80).nullish(),
  tempMinC: z.number().min(-90).max(70).nullish(),
  tempMaxC: z.number().min(-90).max(70).nullish(),
  tempMeanC: z.number().min(-90).max(70).nullish(),
  precipitationMm: z.number().min(0).max(2000).nullish(),
  snowfallMm: z.number().min(0).max(5000).nullish(),
  windMeanKph: z.number().min(0).max(500).nullish(),
  windGustKph: z.number().min(0).max(600).nullish(),
  humidityPct: z.number().min(0).max(100).nullish(),
  visibilityM: z.number().min(0).max(100_000).nullish(),
  seaStateM: z.number().min(0).max(50).nullish(),
  conditions: z.string().max(200).nullish(),
  workStopped: z.boolean().default(false),
  hoursLost: z.number().min(0).max(24).nullish(),
  affectedActivities: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  notes: z.string().max(2000).nullish(),
});

const baselineBody = z.object({
  name: z.string().trim().min(1).max(200),
  source: z.enum(SITE_WEATHER_BASELINE_SOURCES).default("contract"),
  contractRef: z.string().max(200).nullish(),
  method: z.string().max(500).nullish(),
  periodStart: isoDateSchema.nullish(),
  periodEnd: isoDateSchema.nullish(),
  thresholds: z
    .array(
      z.object({
        metric: z.enum(SITE_WEATHER_METRICS),
        comparator: z.enum(SITE_WEATHER_COMPARATORS),
        value: z.number(),
        label: z.string().max(120).optional(),
      }),
    )
    .max(50)
    .default([]),
  monthlyExpectedAdverseDays: z.record(z.string(), z.number().min(0).max(31)).default({}),
  notes: z.string().max(2000).nullish(),
});

export const weatherRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);
  const base = "/projects/:projectId/site/weather";

  /* Observations --------------------------------------------------- */

  app.get(`${base}/observations`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({
        from: isoDateSchema.optional(),
        to: isoDateSchema.optional(),
        source: z.enum(SITE_WEATHER_SOURCES).optional(),
        adverseOnly: z.coerce.boolean().optional(),
      })
      .parse(req.query);
    const where = and(
      eq(siteWeatherObservations.companyId, req.companyId!),
      eq(siteWeatherObservations.projectId, projectId),
      q.from ? gte(siteWeatherObservations.observedOn, q.from) : undefined,
      q.to ? lte(siteWeatherObservations.observedOn, q.to) : undefined,
      q.source ? eq(siteWeatherObservations.source, q.source) : undefined,
      q.adverseOnly ? eq(siteWeatherObservations.adverse, 1) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(siteWeatherObservations).where(where).orderBy(desc(siteWeatherObservations.observedOn)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(siteWeatherObservations).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post(`${base}/observations`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const companyId = req.companyId!;
    const payload = z
      .union([observationBody, z.object({ observations: z.array(observationBody).min(1).max(400) })])
      .parse(req.body);
    const list = "observations" in payload ? payload.observations : [payload];
    const saved: Array<typeof siteWeatherObservations.$inferSelect> = [];
    for (const body of list) {
      if (body.tempMinC !== null && body.tempMinC !== undefined && body.tempMaxC !== null && body.tempMaxC !== undefined && body.tempMinC > body.tempMaxC) {
        throw badRequest(`Minimum temperature is above maximum on ${body.observedOn}.`);
      }
      const id = newId("wxo");
      const [row] = await app.db
        .insert(siteWeatherObservations)
        .values({
          id,
          companyId,
          projectId,
          observedOn: body.observedOn,
          source: body.source,
          provider: body.provider ?? null,
          stationRef: body.stationRef ?? null,
          tempMinC: body.tempMinC ?? null,
          tempMaxC: body.tempMaxC ?? null,
          tempMeanC: body.tempMeanC ?? null,
          precipitationMm: body.precipitationMm ?? null,
          snowfallMm: body.snowfallMm ?? null,
          windMeanKph: body.windMeanKph ?? null,
          windGustKph: body.windGustKph ?? null,
          humidityPct: body.humidityPct ?? null,
          visibilityM: body.visibilityM ?? null,
          seaStateM: body.seaStateM ?? null,
          conditions: body.conditions ?? null,
          workStopped: body.workStopped ? 1 : 0,
          hoursLost: body.hoursLost ?? null,
          affectedActivities: body.affectedActivities,
          notes: body.notes ?? null,
          recordedBy: req.user!.id,
        })
        .onConflictDoUpdate({
          target: [siteWeatherObservations.projectId, siteWeatherObservations.observedOn, siteWeatherObservations.source],
          set: {
            provider: body.provider ?? null,
            stationRef: body.stationRef ?? null,
            tempMinC: body.tempMinC ?? null,
            tempMaxC: body.tempMaxC ?? null,
            tempMeanC: body.tempMeanC ?? null,
            precipitationMm: body.precipitationMm ?? null,
            snowfallMm: body.snowfallMm ?? null,
            windMeanKph: body.windMeanKph ?? null,
            windGustKph: body.windGustKph ?? null,
            humidityPct: body.humidityPct ?? null,
            visibilityM: body.visibilityM ?? null,
            seaStateM: body.seaStateM ?? null,
            conditions: body.conditions ?? null,
            workStopped: body.workStopped ? 1 : 0,
            hoursLost: body.hoursLost ?? null,
            affectedActivities: body.affectedActivities,
            notes: body.notes ?? null,
            recordedBy: req.user!.id,
            updatedAt: nowISO(),
          },
        })
        .returning();
      if (row) saved.push(row);
    }
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "site_weather_observation",
      objectId: saved[0]?.id ?? `${projectId}:batch`,
      payload: { count: saved.length, dates: saved.map((r) => r.observedOn) },
    });
    return reply.code(201).send({ items: saved, total: saved.length });
  });

  app.post(`${base}/capture`, { preHandler: standardGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = z.object({ from: isoDateSchema, to: isoDateSchema }).parse(req.body ?? {});
    if (q.to < q.from) throw badRequest("`to` must not be before `from`.");
    if (daysInclusive(q.from, q.to) > 370) throw badRequest("Capture a year at a time at most.");
    const result = await captureWeather(app.db, req.companyId!, projectId, req.user!.id, q, {
      enabled: process.env["NODE_ENV"] !== "test",
    });
    return { ...result, from: q.from, to: q.to };
  });

  /* Baselines ------------------------------------------------------ */

  app.get(`${base}/baselines`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema.parse(req.query);
    const where = and(eq(siteWeatherBaselines.companyId, req.companyId!), eq(siteWeatherBaselines.projectId, projectId));
    const [rows, [total]] = await Promise.all([
      app.db.select().from(siteWeatherBaselines).where(where).orderBy(desc(siteWeatherBaselines.createdAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(siteWeatherBaselines).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post(`${base}/baselines`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = baselineBody.parse(req.body);
    const companyId = req.companyId!;
    for (const key of Object.keys(body.monthlyExpectedAdverseDays)) {
      const month = Number(key);
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        throw badRequest(`Monthly expected adverse days must be keyed "1" to "12"; got "${key}".`);
      }
    }
    const id = newId("wxb");
    const [row] = await app.db
      .insert(siteWeatherBaselines)
      .values({
        id,
        companyId,
        projectId,
        name: body.name,
        source: body.source,
        contractRef: body.contractRef ?? null,
        method: body.method ?? null,
        periodStart: body.periodStart ?? null,
        periodEnd: body.periodEnd ?? null,
        thresholds: body.thresholds,
        monthlyExpectedAdverseDays: body.monthlyExpectedAdverseDays,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "site_weather_baseline",
      objectId: id,
      payload: { name: body.name, thresholds: body.thresholds.length, source: body.source },
    });
    return reply.code(201).send(row);
  });

  app.patch(`${base}/baselines/:id`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const body = patchSchemaOf(baselineBody).extend({ isActive: z.boolean().optional() }).parse(req.body);
    notFoundIfMissing(
      (
        await app.db
          .select({ id: siteWeatherBaselines.id })
          .from(siteWeatherBaselines)
          .where(and(eq(siteWeatherBaselines.id, id), eq(siteWeatherBaselines.companyId, companyId), eq(siteWeatherBaselines.projectId, projectId)))
          .limit(1)
      )[0],
      "Weather baseline",
    );
    const set = patchSet(body as Record<string, unknown>, [
      "name",
      "source",
      "contractRef",
      "method",
      "periodStart",
      "periodEnd",
      "thresholds",
      "monthlyExpectedAdverseDays",
      "notes",
    ]);
    if (body.isActive !== undefined) set["isActive"] = body.isActive ? 1 : 0;
    const [row] = await app.db
      .update(siteWeatherBaselines)
      .set(set)
      .where(and(eq(siteWeatherBaselines.id, id), eq(siteWeatherBaselines.companyId, companyId)))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "site_weather_baseline",
      objectId: id,
      payload: set,
    });
    return row;
  });

  /* Analyses ------------------------------------------------------- */

  app.get(`${base}/analyses`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema.extend({ status: z.string().max(20).optional() }).parse(req.query);
    const where = and(
      eq(siteWeatherAnalyses.companyId, req.companyId!),
      eq(siteWeatherAnalyses.projectId, projectId),
      q.status ? eq(siteWeatherAnalyses.status, q.status) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(siteWeatherAnalyses).where(where).orderBy(desc(siteWeatherAnalyses.generatedAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(siteWeatherAnalyses).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post(`${base}/analyses`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = z
      .object({
        baselineId: idSchema,
        periodStart: isoDateSchema,
        periodEnd: isoDateSchema,
        notes: z.string().max(4000).nullish(),
      })
      .parse(req.body);
    if (body.periodEnd < body.periodStart) throw badRequest("The period must end on or after it starts.");
    if (daysInclusive(body.periodStart, body.periodEnd) > 1100) {
      throw badRequest("An exceptional-weather analysis covers at most three years in one run.");
    }
    const baseline = notFoundIfMissing(
      (
        await app.db
          .select({ id: siteWeatherBaselines.id })
          .from(siteWeatherBaselines)
          .where(
            and(
              eq(siteWeatherBaselines.id, body.baselineId),
              eq(siteWeatherBaselines.companyId, req.companyId!),
              eq(siteWeatherBaselines.projectId, projectId),
            ),
          )
          .limit(1)
      )[0],
      "Weather baseline",
    );
    const outcome = await runWeatherAnalysis(app.db, req.companyId!, projectId, req.user!.id, {
      baselineId: baseline.id,
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      notes: body.notes ?? null,
    });
    return reply.code(201).send({ ...outcome.analysis, gapDates: outcome.engine.gapDates, baselineName: outcome.baseline.name });
  });

  app.get(`${base}/analyses/:id`, { preHandler: readGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const analysis = notFoundIfMissing(
      (
        await app.db
          .select()
          .from(siteWeatherAnalyses)
          .where(and(eq(siteWeatherAnalyses.id, id), eq(siteWeatherAnalyses.companyId, companyId), eq(siteWeatherAnalyses.projectId, projectId)))
          .limit(1)
      )[0],
      "Weather analysis",
    );
    const baseline =
      (
        await app.db
          .select()
          .from(siteWeatherBaselines)
          .where(and(eq(siteWeatherBaselines.id, analysis.baselineId), eq(siteWeatherBaselines.companyId, companyId)))
          .limit(1)
      )[0] ?? null;
    const observations = await app.db
      .select()
      .from(siteWeatherObservations)
      .where(
        and(
          eq(siteWeatherObservations.companyId, companyId),
          eq(siteWeatherObservations.projectId, projectId),
          gte(siteWeatherObservations.observedOn, analysis.periodStart),
          lte(siteWeatherObservations.observedOn, analysis.periodEnd),
        ),
      )
      .orderBy(asc(siteWeatherObservations.observedOn))
      .limit(2000);
    const thresholds = (baseline?.thresholds ?? []) as Threshold[];
    return {
      ...analysis,
      baseline,
      observations: observations.map((row) => ({
        ...row,
        verdict: classifyDay(toWeatherReading(row), thresholds),
      })),
    };
  });

  app.post(`${base}/analyses/:id/issue`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const { delayEventId } = z.object({ delayEventId: idSchema.nullish() }).parse(req.body ?? {});
    const at = nowISO();
    const [row] = await app.db
      .update(siteWeatherAnalyses)
      .set({ status: "issued", issuedAt: at, issuedBy: req.user!.id, delayEventId: delayEventId ?? null })
      .where(
        and(
          eq(siteWeatherAnalyses.id, id),
          eq(siteWeatherAnalyses.companyId, companyId),
          eq(siteWeatherAnalyses.projectId, projectId),
          eq(siteWeatherAnalyses.status, "draft"),
        ),
      )
      .returning();
    if (!row) throw conflict("Only a draft analysis can be issued. Re-run the comparison to produce a new draft.");
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "site_weather_analysis",
      objectId: id,
      payload: { to: "issued", delayEventId: delayEventId ?? null, exceptionalDays: row.exceptionalDays },
    });
    return row;
  });
};
