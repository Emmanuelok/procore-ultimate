import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  boqItems,
  boqs,
  contracts,
  fluctuationCalculations,
  fluctuationSeries,
  rateBenchmarks,
  valuations,
  variationBuildUpLines,
  variations,
} from "@constructos/db";
import { FLUCTUATION_FORMULAE, RATE_BENCHMARK_SOURCES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import {
  computeFluctuation,
  fluctuationFormulaLibrary,
  type FluctuationComponentInput,
} from "./fluctuations.js";
import {
  analyseBuildUp,
  analyseRateAgainstBenchmarks,
  descriptionTokens,
  tokenOverlap,
  type BuildUpComponentInput,
  type RateSampleInput,
} from "./rates.js";
import {
  isoDateSchema,
  isoMonthSchema,
  requireCommercialLevel,
  round2,
  subResourceGate,
} from "./shared.js";

const benchmarkCreateSchema = z.object({
  code: z.string().max(50).nullable().optional(),
  description: z.string().min(1).max(500),
  unit: z.string().min(1).max(20),
  rate: z.number().positive(),
  currency: z.string().min(3).max(8).optional(),
  region: z.string().max(100).nullable().optional(),
  source: z.enum(RATE_BENCHMARK_SOURCES).optional(),
  asOfDate: isoDateSchema.nullable().optional(),
  projectId: z.string().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const seriesCreateSchema = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
  source: z.string().max(200).nullable().optional(),
  country: z.string().max(60).nullable().optional(),
  values: z
    .array(z.object({ period: isoMonthSchema, value: z.number().positive() }))
    .max(600)
    .optional(),
});

const seriesValuesSchema = z.object({
  values: z.array(z.object({ period: isoMonthSchema, value: z.number().positive() })).min(1).max(600),
});

const fluctuationComputeSchema = z.object({
  formula: z.enum(FLUCTUATION_FORMULAE),
  basePeriod: isoMonthSchema,
  currentPeriod: isoMonthSchema,
  nonAdjustable: z.number().min(0).max(1),
  components: z
    .array(z.object({ seriesCode: z.string().min(1).max(40), weighting: z.number().min(0).max(1) }))
    .min(1)
    .max(20),
  workDoneAmount: z.number().finite(),
  contractId: z.string().nullable().optional(),
  valuationId: z.string().nullable().optional(),
  /** persist the calculation as the audit record for a claim */
  persist: z.boolean().optional(),
});

/**
 * Rate analysis, benchmarking and price adjustment
 * (spec Vol II Domain B #145-149, #178).
 *
 * The benchmark comparison set is the tenant's own data: recorded benchmark
 * rows plus every priced BQ item on the company's other bills with the same
 * unit and comparable wording. Where there is nothing to compare against, the
 * verdict is `no_benchmark` with the reason — the platform never invents a
 * market rate.
 */
export const analysisRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("commercial", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("commercial", "standard"),
  ];
  const companyRead = [app.authenticate, app.requireCompany];
  const subRead = subResourceGate(app, "read");
  const subWrite = subResourceGate(app, "standard");

  /* ---------------------------------------------------------------- */
  /* Rate benchmarks                                                   */
  /* ---------------------------------------------------------------- */

  app.get("/commercial/rate-benchmarks", { preHandler: companyRead }, async (req) => {
    const q = pageQuerySchema
      .extend({ unit: z.string().max(20).optional(), search: z.string().max(200).optional() })
      .parse(req.query);
    const clauses = [eq(rateBenchmarks.companyId, req.companyId!)];
    if (q.unit) clauses.push(eq(rateBenchmarks.unit, q.unit));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(rateBenchmarks).where(where);
    let items = await app.db
      .select()
      .from(rateBenchmarks)
      .where(where)
      .orderBy(desc(rateBenchmarks.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    if (q.search) {
      const needle = q.search.toLowerCase();
      items = items.filter(
        (b) =>
          b.description.toLowerCase().includes(needle) ||
          (b.code ?? "").toLowerCase().includes(needle),
      );
    }
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/commercial/rate-benchmarks", { preHandler: companyRead }, async (req, reply) => {
    const body = benchmarkCreateSchema.parse(req.body);
    if (req.companyRole !== "owner" && req.companyRole !== "admin") {
      throw badRequest("Only a company owner or admin can maintain the benchmark library");
    }
    const id = newId("rbm");
    await app.db.insert(rateBenchmarks).values({
      id,
      companyId: req.companyId!,
      projectId: body.projectId ?? null,
      code: body.code ?? null,
      description: body.description,
      unit: body.unit,
      rate: body.rate,
      currency: body.currency ?? "USD",
      region: body.region ?? null,
      source: body.source ?? "manual",
      asOfDate: body.asOfDate ?? null,
      notes: body.notes ?? null,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "rate_benchmark",
      objectId: id,
      payload: { description: body.description, unit: body.unit, rate: body.rate },
    });
    const created = await app.db
      .select()
      .from(rateBenchmarks)
      .where(eq(rateBenchmarks.id, id))
      .limit(1);
    return reply.status(201).send(created[0]);
  });

  /**
   * Rate analysis for one BQ item: build-up composition + benchmark verdict.
   * The comparison set names each sample, so the user can see exactly which
   * rates the verdict is drawn from.
   */
  app.get("/boq-items/:itemId/rate-analysis", { preHandler: subRead }, async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const rows = await app.db
      .select({ item: boqItems, boq: boqs })
      .from(boqItems)
      .innerJoin(boqs, eq(boqs.id, boqItems.boqId))
      .where(and(eq(boqItems.id, itemId), eq(boqs.companyId, req.companyId!)))
      .limit(1);
    if (!rows[0]) throw notFound("BQ item not found");
    const { item, boq } = rows[0];
    await requireCommercialLevel(app, req, reply, boq.projectId, "read");

    const buildUp = analyseBuildUp(
      item.rate,
      ((item.rateBuildUp ?? []) as BuildUpComponentInput[]) ?? [],
    );

    const samples: RateSampleInput[] = [];
    if (item.unit) {
      const benchmarks = await app.db
        .select()
        .from(rateBenchmarks)
        .where(
          and(
            eq(rateBenchmarks.companyId, req.companyId!),
            eq(rateBenchmarks.unit, item.unit),
            eq(rateBenchmarks.currency, boq.currency),
            or(isNull(rateBenchmarks.projectId), eq(rateBenchmarks.projectId, boq.projectId)),
          ),
        );
      const tokens = descriptionTokens(item.description);
      for (const b of benchmarks) {
        if (tokens.length > 0 && tokenOverlap(tokens, descriptionTokens(b.description)) < 1) continue;
        samples.push({
          rate: b.rate,
          source: b.source,
          label: `${b.description}${b.region ? ` (${b.region})` : ""}`,
          currency: b.currency,
        });
      }
      // the company's own priced history for the same unit and wording
      const sameCurrencyBoqs = await app.db
        .select({ id: boqs.id, name: boqs.name })
        .from(boqs)
        .where(and(eq(boqs.companyId, req.companyId!), eq(boqs.currency, boq.currency)));
      const boqNames = new Map(sameCurrencyBoqs.map((b) => [b.id, b.name]));
      if (sameCurrencyBoqs.length > 0) {
        const peers = await app.db
          .select({
            id: boqItems.id,
            boqId: boqItems.boqId,
            code: boqItems.code,
            description: boqItems.description,
            rate: boqItems.rate,
            unit: boqItems.unit,
          })
          .from(boqItems)
          .where(
            and(
              inArray(
                boqItems.boqId,
                sameCurrencyBoqs.map((b) => b.id),
              ),
              eq(boqItems.unit, item.unit),
              eq(boqItems.level, "item"),
            ),
          )
          .limit(2000);
        for (const p of peers) {
          if (p.id === itemId || p.rate == null || p.rate <= 0) continue;
          if (tokenOverlap(tokens, descriptionTokens(p.description)) < 2) continue;
          samples.push({
            rate: p.rate,
            source: "internal_history",
            label: `${boqNames.get(p.boqId) ?? "Bill"} · ${p.code} ${p.description.slice(0, 60)}`,
            currency: boq.currency,
          });
        }
      }
    }

    const benchmark = analyseRateAgainstBenchmarks(item.rate, samples);
    return {
      itemId,
      code: item.code,
      description: item.description,
      unit: item.unit,
      rate: item.rate,
      currency: boq.currency,
      buildUp,
      benchmark,
    };
  });

  /**
   * The star-rate register (#171): every variation build-up line priced on a
   * basis other than the BQ rates, with its derivation. These are the rates a
   * quantity surveyor has to defend, so they are listed rather than buried.
   */
  app.get("/projects/:projectId/commercial/star-rates", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const projectVariations = await app.db
      .select({ id: variations.id, number: variations.number, title: variations.title, currency: variations.currency })
      .from(variations)
      .where(
        and(eq(variations.companyId, req.companyId!), eq(variations.projectId, req.projectId!)),
      );
    if (projectVariations.length === 0) return paginate([], 0, q);
    const byId = new Map(projectVariations.map((v) => [v.id, v]));
    const lines = await app.db
      .select()
      .from(variationBuildUpLines)
      .where(
        and(
          eq(variationBuildUpLines.companyId, req.companyId!),
          inArray(
            variationBuildUpLines.variationId,
            projectVariations.map((v) => v.id),
          ),
          inArray(variationBuildUpLines.basis, ["star_rate", "daywork", "pro_rata"]),
        ),
      )
      .orderBy(desc(variationBuildUpLines.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const items = lines.map((l) => {
      const v = byId.get(l.variationId);
      return {
        ...l,
        variationNumber: v?.number ?? null,
        variationTitle: v?.title ?? null,
        currency: v?.currency ?? "USD",
      };
    });
    return paginate(items, items.length, q);
  });

  /* ---------------------------------------------------------------- */
  /* Fluctuations (#178)                                               */
  /* ---------------------------------------------------------------- */

  app.get("/commercial/fluctuation-formulae", { preHandler: [app.authenticate] }, async () => ({
    items: fluctuationFormulaLibrary(),
  }));

  app.get("/commercial/index-series", { preHandler: companyRead }, async (req) => {
    const items = await app.db
      .select()
      .from(fluctuationSeries)
      .where(eq(fluctuationSeries.companyId, req.companyId!))
      .orderBy(asc(fluctuationSeries.code));
    return { items, total: items.length };
  });

  app.post("/commercial/index-series", { preHandler: companyRead }, async (req, reply) => {
    const body = seriesCreateSchema.parse(req.body);
    if (req.companyRole !== "owner" && req.companyRole !== "admin") {
      throw badRequest("Only a company owner or admin can maintain index series");
    }
    const existing = await app.db
      .select({ id: fluctuationSeries.id })
      .from(fluctuationSeries)
      .where(
        and(
          eq(fluctuationSeries.companyId, req.companyId!),
          eq(fluctuationSeries.code, body.code),
        ),
      )
      .limit(1);
    if (existing[0]) throw badRequest(`An index series with code ${body.code} already exists`);
    const id = newId("fxs");
    await app.db.insert(fluctuationSeries).values({
      id,
      companyId: req.companyId!,
      code: body.code,
      name: body.name,
      source: body.source ?? null,
      country: body.country ?? null,
      values: (body.values ?? []).sort((a, b) => a.period.localeCompare(b.period)),
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "fluctuation_series",
      objectId: id,
      payload: { code: body.code, points: body.values?.length ?? 0 },
    });
    const created = await app.db
      .select()
      .from(fluctuationSeries)
      .where(eq(fluctuationSeries.id, id))
      .limit(1);
    return reply.status(201).send(created[0]);
  });

  app.put("/commercial/index-series/:seriesId/values", { preHandler: companyRead }, async (req) => {
    const { seriesId } = req.params as { seriesId: string };
    const body = seriesValuesSchema.parse(req.body);
    if (req.companyRole !== "owner" && req.companyRole !== "admin") {
      throw badRequest("Only a company owner or admin can maintain index series");
    }
    const rows = await app.db
      .select()
      .from(fluctuationSeries)
      .where(
        and(eq(fluctuationSeries.id, seriesId), eq(fluctuationSeries.companyId, req.companyId!)),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Index series not found");
    const merged = new Map(rows[0].values.map((v) => [v.period, v.value]));
    for (const v of body.values) merged.set(v.period, v.value);
    const values = [...merged.entries()]
      .map(([period, value]) => ({ period, value }))
      .sort((a, b) => a.period.localeCompare(b.period));
    await app.db
      .update(fluctuationSeries)
      .set({ values, updatedAt: new Date().toISOString() })
      .where(eq(fluctuationSeries.id, seriesId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "fluctuation_series",
      objectId: seriesId,
      payload: { added: body.values.length, total: values.length },
    });
    const updated = await app.db
      .select()
      .from(fluctuationSeries)
      .where(eq(fluctuationSeries.id, seriesId))
      .limit(1);
    return updated[0];
  });

  app.post(
    "/projects/:projectId/commercial/fluctuations",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = fluctuationComputeSchema.parse(req.body);
      const codes = body.components.map((c) => c.seriesCode);
      const series = await app.db
        .select()
        .from(fluctuationSeries)
        .where(
          and(
            eq(fluctuationSeries.companyId, req.companyId!),
            inArray(fluctuationSeries.code, codes),
          ),
        );
      const byCode = new Map(series.map((s) => [s.code, s]));
      const missing = codes.filter((c) => !byCode.has(c));
      if (missing.length > 0) {
        throw badRequest(`Unknown index series: ${missing.join(", ")}`);
      }

      let currency = "USD";
      if (body.contractId) {
        const c = await app.db
          .select({ id: contracts.id, currency: contracts.currency })
          .from(contracts)
          .where(
            and(
              eq(contracts.id, body.contractId),
              eq(contracts.companyId, req.companyId!),
              eq(contracts.projectId, req.projectId!),
            ),
          )
          .limit(1);
        if (!c[0]) throw badRequest("contractId does not reference a contract on this project");
        currency = c[0].currency;
      }
      if (body.valuationId) {
        const v = await app.db
          .select({ id: valuations.id, currency: valuations.currency })
          .from(valuations)
          .where(
            and(
              eq(valuations.id, body.valuationId),
              eq(valuations.companyId, req.companyId!),
              eq(valuations.projectId, req.projectId!),
            ),
          )
          .limit(1);
        if (!v[0]) throw badRequest("valuationId does not reference a valuation on this project");
        currency = v[0].currency;
      }

      const components: FluctuationComponentInput[] = body.components.map((c) => {
        const s = byCode.get(c.seriesCode)!;
        return {
          seriesCode: c.seriesCode,
          label: s.name,
          weighting: c.weighting,
          points: s.values,
        };
      });
      const result = computeFluctuation({
        formula: body.formula,
        basePeriod: body.basePeriod,
        currentPeriod: body.currentPeriod,
        nonAdjustable: body.nonAdjustable,
        components,
        workDoneAmount: body.workDoneAmount,
      });

      let calculationId: string | null = null;
      if (body.persist) {
        if (!result.ok) {
          throw badRequest(
            `The adjustment could not be computed, so there is nothing to record: ${result.reasons.join(" ")}`,
          );
        }
        calculationId = newId("fxc");
        await app.db.insert(fluctuationCalculations).values({
          id: calculationId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          contractId: body.contractId ?? null,
          valuationId: body.valuationId ?? null,
          formula: body.formula,
          baseDate: body.basePeriod,
          currentPeriod: body.currentPeriod,
          nonAdjustable: body.nonAdjustable,
          components: result.components,
          workDoneAmount: round2(body.workDoneAmount),
          factor: result.factor ?? 1,
          adjustment: result.adjustment ?? 0,
          currency,
          computedBy: req.user!.id,
        });
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "create",
          objectType: "fluctuation_calculation",
          objectId: calculationId,
          projectId: req.projectId!,
          payload: {
            formula: body.formula,
            factor: result.factor,
            adjustment: result.adjustment,
            currency,
          },
          storePayload: true,
        });
      }
      return reply.status(body.persist ? 201 : 200).send({ ...result, currency, calculationId });
    },
  );

  app.get("/projects/:projectId/commercial/fluctuations", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = and(
      eq(fluctuationCalculations.companyId, req.companyId!),
      eq(fluctuationCalculations.projectId, req.projectId!),
    );
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(fluctuationCalculations)
      .where(where);
    const items = await app.db
      .select()
      .from(fluctuationCalculations)
      .where(where)
      .orderBy(desc(fluctuationCalculations.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /** Attach a computed fluctuation to a draft valuation as a typed section. */
  app.post(
    "/valuations/:valuationId/fluctuations/:calculationId",
    { preHandler: subWrite },
    async (req, reply) => {
      const { valuationId, calculationId } = req.params as {
        valuationId: string;
        calculationId: string;
      };
      const valRows = await app.db
        .select()
        .from(valuations)
        .where(and(eq(valuations.id, valuationId), eq(valuations.companyId, req.companyId!)))
        .limit(1);
      const val = valRows[0];
      if (!val) throw notFound("Valuation not found");
      await requireCommercialLevel(app, req, reply, val.projectId, "standard");
      const calcRows = await app.db
        .select()
        .from(fluctuationCalculations)
        .where(
          and(
            eq(fluctuationCalculations.id, calculationId),
            eq(fluctuationCalculations.companyId, req.companyId!),
            eq(fluctuationCalculations.projectId, val.projectId),
          ),
        )
        .limit(1);
      const calc = calcRows[0];
      if (!calc) throw notFound("Fluctuation calculation not found");
      if (calc.currency !== val.currency) {
        throw badRequest(
          `The calculation is in ${calc.currency} and the valuation in ${val.currency}; they cannot be combined.`,
        );
      }
      await app.db
        .update(fluctuationCalculations)
        .set({ valuationId })
        .where(eq(fluctuationCalculations.id, calculationId));
      return reply.status(200).send({
        ok: true,
        calculationId,
        valuationId,
        adjustment: calc.adjustment,
        hint: "Add the adjustment to the application as a `fluctuation` section citing this calculation id.",
      });
    },
  );
};
