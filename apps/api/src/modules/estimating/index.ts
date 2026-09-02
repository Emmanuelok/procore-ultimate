/**
 * ESTIMATING & TAKEOFF — routes (spec Vol I §1.2, #184–208).
 *
 * WHAT THIS MODULE IS. The first number on a project and everything that
 * makes it defensible: measured takeoff with its geometry and scale (#184–189),
 * a company rate library with assemblies, crews and production rates
 * (#191–197), estimates with versions, tiered markups and comparison
 * (#198–201), sub-quote import and levelling (#202–203), conversion into the
 * budget the project is then measured against (#204), proposal generation
 * (#205) and export (#206), a historical cost reference drawn from the
 * tenant's own past estimates (#207), and change-order estimating (#208).
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not rasterise or parse PDFs:
 * geometry arrives already drawn, from the sheet viewer, an import, or an API
 * caller. It does not convert currencies — an estimate has one currency and a
 * quote in another is levelled by hand with the rate recorded. It does not
 * own the budget: conversion writes `budgets`/`budget_line_items` in one
 * transaction and then leaves them alone.
 *
 * GATES. Every project route is `/projects/:projectId/...` so `requireTool`
 * resolves the project and enforces the `estimating` tool level. The rate
 * library is a COMPANY asset and sits behind the company gate, because an
 * estimator without a project still has to be able to maintain it.
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import {
  bidSubmissionLines,
  bidSubmissions,
  budgetLineItems,
  budgets,
  changeEvents,
  costAssemblies,
  costAssemblyComponents,
  costCatalogueItems,
  estimateLineItems,
  estimateMarkups,
  estimateProposals,
  estimateSections,
  estimateSubQuoteLines,
  estimateSubQuotes,
  estimates,
  estimatingCrews,
  estimatingProductionRates,
  projects,
  signals,
  takeoffItems,
  takeoffLayers,
  vendors,
} from "@constructos/db";
import type { CostType, LengthUnit, ProductionRateBasis } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, paginate } from "../../lib/pagination.js";
import { pushNotifications } from "../notifications/service.js";
import { planBudgetLines } from "./budgetize.js";
import { compareEstimates, type ComparableLine } from "./compare.js";
import { calibrateFromRatio, calibrateScale, computeTakeoff, type Geometry } from "./measure.js";
import {
  assemblyUnitRate,
  crewCost,
  dominantCostType,
  expandAssembly,
  makeSplit,
  priceLine,
  round2,
  round4,
  splitTotal,
  type AppliedMarkup,
  type CrewCost,
  type RateSplit,
} from "./pricing.js";
import { buildProposalDocument, renderProposalHtml, type ProposalDetailLevel } from "./proposal.js";
import { levelQuotes, normaliseScopeKey, type QuoteInput } from "./quotes.js";
import * as S from "./schemas.js";
import {
  addDays,
  assertEditable,
  closeSignalByKey,
  fetchEstimate,
  linesOfEstimate,
  markupsOfEstimate,
  nowIso,
  OPEN_DISPOSITIONS,
  pad3,
  recomputeEstimate,
  sectionsOfEstimate,
  todayIso,
  toMarkupSpec,
  type EstimateLineRow,
  type EstimateRow,
} from "./shared.js";
import {
  registerEstimatingJobs,
  runEstimatingSweeps,
  RATE_STALENESS_DAYS,
} from "./sweeps.js";

type CatalogueRow = typeof costCatalogueItems.$inferSelect;
type CrewRow = typeof estimatingCrews.$inferSelect;

const csvCell = (value: unknown): string => {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const ratesOf = (row: {
  labourRate: number;
  materialRate: number;
  equipmentRate: number;
  subcontractRate: number;
  otherRate: number;
}): RateSplit => ({
  labour: row.labourRate,
  material: row.materialRate,
  equipment: row.equipmentRate,
  subcontract: row.subcontractRate,
  other: row.otherRate,
});

const crewCostOf = (crew: CrewRow): CrewCost => ({
  labourHourlyCost: crew.labourHourlyCost,
  equipmentHourlyCost: crew.equipmentHourlyCost,
  hourlyCost: crew.hourlyCost,
  headcount: crew.headcount,
});

export const estimatingModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("estimating", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("estimating", "standard"),
  ];
  const adminGate = [app.authenticate, app.requireCompany, app.requireTool("estimating", "admin")];
  const companyGate = [app.authenticate, app.requireCompany];

  registerEstimatingJobs(app);

  async function ledger(
    req: FastifyRequest,
    action: "create" | "update" | "delete" | "state_change",
    objectType: string,
    objectId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action,
      objectType,
      objectId,
      payload,
      projectId: (payload["projectId"] as string | undefined) ?? req.projectId ?? null,
    });
  }

  /* ================================================================== */
  /* Cost catalogue (#192, #195–196)                                     */
  /* ================================================================== */

  async function fetchCatalogueItem(id: string, companyId: string): Promise<CatalogueRow> {
    const rows = await app.db
      .select()
      .from(costCatalogueItems)
      .where(and(eq(costCatalogueItems.id, id), eq(costCatalogueItems.companyId, companyId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Catalogue item not found");
    return row;
  }

  async function fetchCrew(id: string, companyId: string): Promise<CrewRow> {
    const rows = await app.db
      .select()
      .from(estimatingCrews)
      .where(and(eq(estimatingCrews.id, id), eq(estimatingCrews.companyId, companyId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Crew not found");
    return row;
  }

  /** A project id the caller named on a company-library route must be ours. */
  async function assertProjectInCompany(projectId: string, companyId: string): Promise<void> {
    const rows = await app.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Project not found in this company");
  }

  function catalogueValues(
    body: ReturnType<typeof S.catalogueCreateSchema.parse>,
    companyId: string,
    userId: string,
  ) {
    const rates = makeSplit(body.rates);
    return {
      companyId,
      projectId: body.projectId ?? null,
      code: body.code,
      description: body.description,
      longDescription: body.longDescription ?? null,
      unit: body.unit,
      costType: body.costType ?? dominantCostType(rates),
      category: body.category ?? null,
      trade: body.trade ?? null,
      currency: body.currency ?? "USD",
      labourRate: rates.labour,
      materialRate: rates.material,
      equipmentRate: rates.equipment,
      subcontractRate: rates.subcontract,
      otherRate: rates.other,
      unitRate: round4(splitTotal(rates)),
      crewId: body.crewId ?? null,
      productionRate: body.productionRate ?? null,
      productionRateBasis: body.productionRateBasis ?? null,
      wastePercent: body.wastePercent ?? 0,
      costCodeId: body.costCodeId ?? null,
      costCode: body.costCode ?? null,
      source: body.source ?? "manual",
      sourceReference: body.sourceReference ?? null,
      region: body.region ?? null,
      rateAsAt: body.rateAsAt ?? todayIso(),
      tags: body.tags ?? [],
      detail: body.detail ?? {},
      createdBy: userId,
    };
  }

  app.get("/estimating/catalogue", { preHandler: companyGate }, async (req) => {
    const q = S.catalogueListQuery.parse(req.query);
    const clauses = [eq(costCatalogueItems.companyId, req.companyId!)];
    if (q.projectId) {
      await assertProjectInCompany(q.projectId, req.companyId!);
      clauses.push(
        q.includeCompany === "false"
          ? eq(costCatalogueItems.projectId, q.projectId)
          : (or(
              eq(costCatalogueItems.projectId, q.projectId),
              isNull(costCatalogueItems.projectId),
            ) ?? sql`true`),
      );
    }
    if (q.status) clauses.push(eq(costCatalogueItems.status, q.status));
    if (q.costType) clauses.push(eq(costCatalogueItems.costType, q.costType));
    if (q.source) clauses.push(eq(costCatalogueItems.source, q.source));
    if (q.category) clauses.push(eq(costCatalogueItems.category, q.category));
    if (q.trade) clauses.push(eq(costCatalogueItems.trade, q.trade));
    if (q.search) {
      clauses.push(
        or(
          ilike(costCatalogueItems.code, `%${q.search}%`),
          ilike(costCatalogueItems.description, `%${q.search}%`),
        ) ?? sql`true`,
      );
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(costCatalogueItems).where(where);
    const items = await app.db
      .select()
      .from(costCatalogueItems)
      .where(where)
      .orderBy(asc(costCatalogueItems.code))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/estimating/catalogue", { preHandler: companyGate }, async (req, reply) => {
    const body = S.catalogueCreateSchema.parse(req.body);
    if (body.projectId) await assertProjectInCompany(body.projectId, req.companyId!);
    if (body.crewId) await fetchCrew(body.crewId, req.companyId!);
    const existing = await app.db
      .select({ id: costCatalogueItems.id })
      .from(costCatalogueItems)
      .where(
        and(
          eq(costCatalogueItems.companyId, req.companyId!),
          body.projectId
            ? eq(costCatalogueItems.projectId, body.projectId)
            : isNull(costCatalogueItems.projectId),
          eq(costCatalogueItems.code, body.code),
        ),
      )
      .limit(1);
    if (existing[0]) throw conflict(`A catalogue item with code ${body.code} already exists`);
    const id = newId("cat");
    await app.db
      .insert(costCatalogueItems)
      .values({ id, ...catalogueValues(body, req.companyId!, req.user!.id) });
    await ledger(req, "create", "cost_catalogue_item", id, {
      code: body.code,
      description: body.description,
      unit: body.unit,
    });
    return reply.status(201).send(await fetchCatalogueItem(id, req.companyId!));
  });

  app.post("/estimating/catalogue/bulk", { preHandler: companyGate }, async (req, reply) => {
    const body = S.catalogueBulkSchema.parse(req.body);
    const created: string[] = [];
    const updated: string[] = [];
    const skipped: Array<{ code: string; reason: string }> = [];
    for (const item of body.items) {
      if (item.projectId) await assertProjectInCompany(item.projectId, req.companyId!);
      const existing = await app.db
        .select({ id: costCatalogueItems.id })
        .from(costCatalogueItems)
        .where(
          and(
            eq(costCatalogueItems.companyId, req.companyId!),
            item.projectId
              ? eq(costCatalogueItems.projectId, item.projectId)
              : isNull(costCatalogueItems.projectId),
            eq(costCatalogueItems.code, item.code),
          ),
        )
        .limit(1);
      const values = catalogueValues(item, req.companyId!, req.user!.id);
      if (existing[0]) {
        if (!body.upsert) {
          skipped.push({ code: item.code, reason: "a catalogue item with this code already exists" });
          continue;
        }
        const { createdBy: _ignored, ...updatable } = values;
        await app.db
          .update(costCatalogueItems)
          .set({ ...updatable, status: "active", updatedAt: nowIso() })
          .where(eq(costCatalogueItems.id, existing[0].id));
        updated.push(existing[0].id);
      } else {
        const id = newId("cat");
        await app.db.insert(costCatalogueItems).values({ id, ...values });
        created.push(id);
      }
    }
    await ledger(req, "create", "cost_catalogue_import", newId("imp"), {
      created: created.length,
      updated: updated.length,
      skipped: skipped.length,
    });
    return reply
      .status(201)
      .send({ created: created.length, updated: updated.length, skipped, ids: [...created, ...updated] });
  });

  app.get("/estimating/catalogue/:itemId", { preHandler: companyGate }, async (req) => {
    const { itemId } = req.params as { itemId: string };
    const item = await fetchCatalogueItem(itemId, req.companyId!);
    const crew = item.crewId ? await fetchCrew(item.crewId, req.companyId!).catch(() => null) : null;
    const ageDays = item.rateAsAt ? Math.max(0, -1 * (Date.parse(`${item.rateAsAt}T00:00:00Z`) - Date.now()) / 86_400_000) : null;
    return {
      ...item,
      crew,
      staleness:
        ageDays === null
          ? { ageDays: null, stale: false, reason: "No currency date was recorded for this rate." }
          : {
              ageDays: Math.round(ageDays),
              stale: ageDays > RATE_STALENESS_DAYS,
              reason: `The rate was current at ${item.rateAsAt}; the staleness threshold is ${RATE_STALENESS_DAYS} days.`,
            },
    };
  });

  app.patch("/estimating/catalogue/:itemId", { preHandler: companyGate }, async (req) => {
    const { itemId } = req.params as { itemId: string };
    const body = S.cataloguePatchSchema.parse(req.body);
    const item = await fetchCatalogueItem(itemId, req.companyId!);
    const patch: Record<string, unknown> = { updatedAt: nowIso() };
    if (body.rates !== undefined) {
      const rates = makeSplit({ ...ratesOf(item), ...body.rates });
      patch["labourRate"] = rates.labour;
      patch["materialRate"] = rates.material;
      patch["equipmentRate"] = rates.equipment;
      patch["subcontractRate"] = rates.subcontract;
      patch["otherRate"] = rates.other;
      patch["unitRate"] = round4(splitTotal(rates));
      // A price change resets the staleness clock unless the caller dates it.
      patch["rateAsAt"] = body.rateAsAt ?? todayIso();
      patch["status"] = body.status ?? (item.status === "review" ? "active" : item.status);
    }
    for (const key of [
      "description",
      "longDescription",
      "unit",
      "costType",
      "category",
      "trade",
      "currency",
      "crewId",
      "productionRate",
      "productionRateBasis",
      "wastePercent",
      "costCodeId",
      "costCode",
      "source",
      "sourceReference",
      "region",
      "rateAsAt",
      "tags",
      "detail",
      "status",
    ] as const) {
      const value = (body as Record<string, unknown>)[key];
      if (value !== undefined) patch[key] = value;
    }
    await app.db
      .update(costCatalogueItems)
      .set(patch)
      .where(eq(costCatalogueItems.id, itemId));
    await ledger(req, "update", "cost_catalogue_item", itemId, {
      code: item.code,
      changed: Object.keys(patch).filter((k) => k !== "updatedAt"),
    });
    return fetchCatalogueItem(itemId, req.companyId!);
  });

  app.delete("/estimating/catalogue/:itemId", { preHandler: companyGate }, async (req) => {
    const { itemId } = req.params as { itemId: string };
    const item = await fetchCatalogueItem(itemId, req.companyId!);
    // Retired, never deleted: estimate lines cite the item, and an estimate
    // whose rate provenance evaporates is an estimate nobody can defend.
    await app.db
      .update(costCatalogueItems)
      .set({ status: "retired", updatedAt: nowIso() })
      .where(eq(costCatalogueItems.id, itemId));
    await ledger(req, "state_change", "cost_catalogue_item", itemId, {
      code: item.code,
      from: item.status,
      to: "retired",
    });
    return { id: itemId, status: "retired" };
  });

  /* ================================================================== */
  /* Assemblies (#191, #193)                                             */
  /* ================================================================== */

  type AssemblyRow = typeof costAssemblies.$inferSelect;
  type ComponentRow = typeof costAssemblyComponents.$inferSelect;

  async function fetchAssembly(id: string, companyId: string): Promise<AssemblyRow> {
    const rows = await app.db
      .select()
      .from(costAssemblies)
      .where(and(eq(costAssemblies.id, id), eq(costAssemblies.companyId, companyId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Assembly not found");
    return row;
  }

  const componentsOf = (assemblyId: string): Promise<ComponentRow[]> =>
    app.db
      .select()
      .from(costAssemblyComponents)
      .where(eq(costAssemblyComponents.assemblyId, assemblyId))
      .orderBy(asc(costAssemblyComponents.position));

  /**
   * Replace an assembly's component set and re-materialize its unit rate.
   * A component naming a catalogue item takes that item's rate unless the
   * caller states one — copied at write time, so refreshing the assembly is a
   * deliberate act rather than a side effect of somebody editing the library.
   */
  async function writeComponents(
    assembly: AssemblyRow,
    specs: ReadonlyArray<ReturnType<typeof S.assemblyComponentSchema.parse>>,
  ): Promise<{ rates: RateSplit; unitRate: number; count: number }> {
    const resolved: Array<{
      values: typeof costAssemblyComponents.$inferInsert;
      rates: RateSplit;
      quantityPer: number;
      wastePercent: number;
    }> = [];
    let position = 0;
    for (const spec of specs) {
      let rates = makeSplit(spec.rates);
      let unit = spec.unit ?? null;
      let costCodeId = spec.costCodeId ?? null;
      let costCode = spec.costCode ?? null;
      let costType: string = spec.costType ?? "other";
      if (spec.catalogueItemId) {
        const item = await fetchCatalogueItem(spec.catalogueItemId, assembly.companyId);
        if (spec.rates === undefined) rates = ratesOf(item);
        unit = unit ?? item.unit;
        costCodeId = costCodeId ?? item.costCodeId;
        costCode = costCode ?? item.costCode;
        costType = spec.costType ?? item.costType;
      } else if (spec.costType === undefined) {
        costType = dominantCostType(rates);
      }
      const waste = spec.wastePercent ?? 0;
      const perUnitFactor = spec.quantityPer * (1 + waste / 100);
      resolved.push({
        rates,
        quantityPer: spec.quantityPer,
        wastePercent: waste,
        values: {
          id: newId("asc"),
          companyId: assembly.companyId,
          assemblyId: assembly.id,
          position,
          catalogueItemId: spec.catalogueItemId ?? null,
          description: spec.description,
          unit,
          costType,
          quantityPer: spec.quantityPer,
          wastePercent: waste,
          labourRate: rates.labour,
          materialRate: rates.material,
          equipmentRate: rates.equipment,
          subcontractRate: rates.subcontract,
          otherRate: rates.other,
          unitRate: round4(splitTotal(rates)),
          amountPer: round4(splitTotal(rates) * perUnitFactor),
          costCodeId,
          costCode,
          detail: {},
        },
      });
      position += 1;
    }

    await app.db
      .delete(costAssemblyComponents)
      .where(eq(costAssemblyComponents.assemblyId, assembly.id));
    if (resolved.length > 0) {
      await app.db.insert(costAssemblyComponents).values(resolved.map((r) => r.values));
    }

    const pricing = assemblyUnitRate(
      resolved.map((r) => ({
        description: r.values.description,
        quantityPer: r.quantityPer,
        wastePercent: r.wastePercent,
        rates: r.rates,
      })),
    );
    await app.db
      .update(costAssemblies)
      .set({
        labourRate: pricing.rates.labour,
        materialRate: pricing.rates.material,
        equipmentRate: pricing.rates.equipment,
        subcontractRate: pricing.rates.subcontract,
        otherRate: pricing.rates.other,
        unitRate: pricing.unitRate,
        componentCount: pricing.componentCount,
        updatedAt: nowIso(),
      })
      .where(eq(costAssemblies.id, assembly.id));
    return { rates: pricing.rates, unitRate: pricing.unitRate, count: pricing.componentCount };
  }

  app.get("/estimating/assemblies", { preHandler: companyGate }, async (req) => {
    const q = S.assemblyListQuery.parse(req.query);
    const clauses = [eq(costAssemblies.companyId, req.companyId!)];
    if (q.projectId) {
      await assertProjectInCompany(q.projectId, req.companyId!);
      clauses.push(
        or(eq(costAssemblies.projectId, q.projectId), isNull(costAssemblies.projectId)) ?? sql`true`,
      );
    }
    if (q.status) clauses.push(eq(costAssemblies.status, q.status));
    if (q.trade) clauses.push(eq(costAssemblies.trade, q.trade));
    if (q.search) {
      clauses.push(
        or(ilike(costAssemblies.code, `%${q.search}%`), ilike(costAssemblies.name, `%${q.search}%`)) ??
          sql`true`,
      );
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(costAssemblies).where(where);
    const items = await app.db
      .select()
      .from(costAssemblies)
      .where(where)
      .orderBy(asc(costAssemblies.code))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/estimating/assemblies", { preHandler: companyGate }, async (req, reply) => {
    const body = S.assemblyCreateSchema.parse(req.body);
    if (body.projectId) await assertProjectInCompany(body.projectId, req.companyId!);
    const existing = await app.db
      .select({ id: costAssemblies.id })
      .from(costAssemblies)
      .where(
        and(
          eq(costAssemblies.companyId, req.companyId!),
          body.projectId
            ? eq(costAssemblies.projectId, body.projectId)
            : isNull(costAssemblies.projectId),
          eq(costAssemblies.code, body.code),
        ),
      )
      .limit(1);
    if (existing[0]) throw conflict(`An assembly with code ${body.code} already exists`);
    const id = newId("asm");
    await app.db.insert(costAssemblies).values({
      id,
      companyId: req.companyId!,
      projectId: body.projectId ?? null,
      code: body.code,
      name: body.name,
      description: body.description ?? null,
      unit: body.unit,
      category: body.category ?? null,
      trade: body.trade ?? null,
      currency: body.currency ?? "USD",
      costCodeId: body.costCodeId ?? null,
      costCode: body.costCode ?? null,
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });
    const assembly = await fetchAssembly(id, req.companyId!);
    if (body.components && body.components.length > 0) {
      await writeComponents(assembly, body.components);
    }
    await ledger(req, "create", "cost_assembly", id, {
      code: body.code,
      name: body.name,
      components: body.components?.length ?? 0,
    });
    return reply.status(201).send({
      ...(await fetchAssembly(id, req.companyId!)),
      components: await componentsOf(id),
    });
  });

  app.get("/estimating/assemblies/:assemblyId", { preHandler: companyGate }, async (req) => {
    const { assemblyId } = req.params as { assemblyId: string };
    const assembly = await fetchAssembly(assemblyId, req.companyId!);
    return { ...assembly, components: await componentsOf(assemblyId) };
  });

  app.patch("/estimating/assemblies/:assemblyId", { preHandler: companyGate }, async (req) => {
    const { assemblyId } = req.params as { assemblyId: string };
    const body = S.assemblyPatchSchema.parse(req.body);
    const assembly = await fetchAssembly(assemblyId, req.companyId!);
    const patch: Record<string, unknown> = { updatedAt: nowIso() };
    for (const key of [
      "name",
      "description",
      "unit",
      "category",
      "trade",
      "currency",
      "costCodeId",
      "costCode",
      "status",
      "detail",
    ] as const) {
      const value = (body as Record<string, unknown>)[key];
      if (value !== undefined) patch[key] = value;
    }
    await app.db.update(costAssemblies).set(patch).where(eq(costAssemblies.id, assemblyId));
    await ledger(req, "update", "cost_assembly", assemblyId, {
      code: assembly.code,
      changed: Object.keys(patch).filter((k) => k !== "updatedAt"),
    });
    return { ...(await fetchAssembly(assemblyId, req.companyId!)), components: await componentsOf(assemblyId) };
  });

  app.put("/estimating/assemblies/:assemblyId/components", { preHandler: companyGate }, async (req) => {
    const { assemblyId } = req.params as { assemblyId: string };
    const body = S.assemblyComponentsSchema.parse(req.body);
    const assembly = await fetchAssembly(assemblyId, req.companyId!);
    const result = await writeComponents(assembly, body.components);
    await ledger(req, "update", "cost_assembly", assemblyId, {
      code: assembly.code,
      components: result.count,
      unitRate: result.unitRate,
    });
    return { ...(await fetchAssembly(assemblyId, req.companyId!)), components: await componentsOf(assemblyId) };
  });

  app.post(
    "/estimating/assemblies/:assemblyId/refresh-rates",
    { preHandler: companyGate },
    async (req) => {
      const { assemblyId } = req.params as { assemblyId: string };
      const assembly = await fetchAssembly(assemblyId, req.companyId!);
      const existing = await componentsOf(assemblyId);
      const refreshed: Array<ReturnType<typeof S.assemblyComponentSchema.parse>> = [];
      const unresolved: string[] = [];
      for (const c of existing) {
        if (!c.catalogueItemId) {
          unresolved.push(c.description);
          refreshed.push({
            catalogueItemId: null,
            description: c.description,
            unit: c.unit,
            costType: c.costType as CostType,
            quantityPer: c.quantityPer,
            wastePercent: c.wastePercent,
            rates: ratesOf(c),
            costCodeId: c.costCodeId,
            costCode: c.costCode,
          });
          continue;
        }
        refreshed.push({
          catalogueItemId: c.catalogueItemId,
          description: c.description,
          unit: c.unit,
          costType: c.costType as CostType,
          quantityPer: c.quantityPer,
          wastePercent: c.wastePercent,
          costCodeId: c.costCodeId,
          costCode: c.costCode,
        });
      }
      const before = assembly.unitRate;
      const result = await writeComponents(assembly, refreshed);
      await ledger(req, "update", "cost_assembly", assemblyId, {
        code: assembly.code,
        action: "refresh_rates",
        before,
        after: result.unitRate,
      });
      return {
        ...(await fetchAssembly(assemblyId, req.companyId!)),
        components: await componentsOf(assemblyId),
        refresh: {
          unitRateBefore: before,
          unitRateAfter: result.unitRate,
          componentsRefreshed: refreshed.length - unresolved.length,
          notRefreshed: unresolved,
          reason:
            unresolved.length === 0
              ? "Every component names a catalogue item, so every rate was refreshed."
              : `${unresolved.length} component${unresolved.length === 1 ? "" : "s"} carry a typed rate with no catalogue item; those were left exactly as they were.`,
        },
      };
    },
  );

  app.delete("/estimating/assemblies/:assemblyId", { preHandler: companyGate }, async (req) => {
    const { assemblyId } = req.params as { assemblyId: string };
    const assembly = await fetchAssembly(assemblyId, req.companyId!);
    await app.db
      .update(costAssemblies)
      .set({ status: "retired", updatedAt: nowIso() })
      .where(eq(costAssemblies.id, assemblyId));
    await ledger(req, "state_change", "cost_assembly", assemblyId, {
      code: assembly.code,
      from: assembly.status,
      to: "retired",
    });
    return { id: assemblyId, status: "retired" };
  });

  /* ================================================================== */
  /* Crews (#197) and production rates (#194)                            */
  /* ================================================================== */

  app.get("/estimating/crews", { preHandler: companyGate }, async (req) => {
    const q = S.libraryListQuery.parse(req.query);
    const clauses = [eq(estimatingCrews.companyId, req.companyId!)];
    if (q.projectId) {
      await assertProjectInCompany(q.projectId, req.companyId!);
      clauses.push(
        or(eq(estimatingCrews.projectId, q.projectId), isNull(estimatingCrews.projectId)) ?? sql`true`,
      );
    }
    if (q.status) clauses.push(eq(estimatingCrews.status, q.status));
    if (q.trade) clauses.push(eq(estimatingCrews.trade, q.trade));
    if (q.search) {
      clauses.push(
        or(ilike(estimatingCrews.code, `%${q.search}%`), ilike(estimatingCrews.name, `%${q.search}%`)) ??
          sql`true`,
      );
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(estimatingCrews).where(where);
    const items = await app.db
      .select()
      .from(estimatingCrews)
      .where(where)
      .orderBy(asc(estimatingCrews.code))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/estimating/crews", { preHandler: companyGate }, async (req, reply) => {
    const body = S.crewCreateSchema.parse(req.body);
    if (body.projectId) await assertProjectInCompany(body.projectId, req.companyId!);
    const existing = await app.db
      .select({ id: estimatingCrews.id })
      .from(estimatingCrews)
      .where(
        and(
          eq(estimatingCrews.companyId, req.companyId!),
          body.projectId
            ? eq(estimatingCrews.projectId, body.projectId)
            : isNull(estimatingCrews.projectId),
          eq(estimatingCrews.code, body.code),
        ),
      )
      .limit(1);
    if (existing[0]) throw conflict(`A crew with code ${body.code} already exists`);
    const members = body.members ?? [];
    const equipment = body.equipment ?? [];
    const cost = crewCost(members, equipment);
    const id = newId("crw");
    await app.db.insert(estimatingCrews).values({
      id,
      companyId: req.companyId!,
      projectId: body.projectId ?? null,
      code: body.code,
      name: body.name,
      description: body.description ?? null,
      trade: body.trade ?? null,
      currency: body.currency ?? "USD",
      members,
      equipment,
      hourlyCost: cost.hourlyCost,
      labourHourlyCost: cost.labourHourlyCost,
      equipmentHourlyCost: cost.equipmentHourlyCost,
      headcount: cost.headcount,
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });
    await ledger(req, "create", "estimating_crew", id, {
      code: body.code,
      name: body.name,
      hourlyCost: cost.hourlyCost,
    });
    return reply.status(201).send(await fetchCrew(id, req.companyId!));
  });

  app.get("/estimating/crews/:crewId", { preHandler: companyGate }, async (req) => {
    const { crewId } = req.params as { crewId: string };
    return fetchCrew(crewId, req.companyId!);
  });

  app.patch("/estimating/crews/:crewId", { preHandler: companyGate }, async (req) => {
    const { crewId } = req.params as { crewId: string };
    const body = S.crewPatchSchema.parse(req.body);
    const crew = await fetchCrew(crewId, req.companyId!);
    const members = body.members ?? crew.members;
    const equipment = body.equipment ?? crew.equipment;
    const cost = crewCost(members, equipment);
    const patch: Record<string, unknown> = {
      members,
      equipment,
      hourlyCost: cost.hourlyCost,
      labourHourlyCost: cost.labourHourlyCost,
      equipmentHourlyCost: cost.equipmentHourlyCost,
      headcount: cost.headcount,
      updatedAt: nowIso(),
    };
    for (const key of ["name", "description", "trade", "currency", "status", "detail"] as const) {
      const value = (body as Record<string, unknown>)[key];
      if (value !== undefined) patch[key] = value;
    }
    await app.db.update(estimatingCrews).set(patch).where(eq(estimatingCrews.id, crewId));
    await ledger(req, "update", "estimating_crew", crewId, {
      code: crew.code,
      hourlyCostBefore: crew.hourlyCost,
      hourlyCostAfter: cost.hourlyCost,
    });
    return fetchCrew(crewId, req.companyId!);
  });

  app.delete("/estimating/crews/:crewId", { preHandler: companyGate }, async (req) => {
    const { crewId } = req.params as { crewId: string };
    const crew = await fetchCrew(crewId, req.companyId!);
    await app.db
      .update(estimatingCrews)
      .set({ status: "retired", updatedAt: nowIso() })
      .where(eq(estimatingCrews.id, crewId));
    await ledger(req, "state_change", "estimating_crew", crewId, {
      code: crew.code,
      from: crew.status,
      to: "retired",
    });
    return { id: crewId, status: "retired" };
  });

  app.get("/estimating/production-rates", { preHandler: companyGate }, async (req) => {
    const q = S.libraryListQuery.parse(req.query);
    const clauses = [eq(estimatingProductionRates.companyId, req.companyId!)];
    if (q.projectId) {
      await assertProjectInCompany(q.projectId, req.companyId!);
      clauses.push(
        or(
          eq(estimatingProductionRates.projectId, q.projectId),
          isNull(estimatingProductionRates.projectId),
        ) ?? sql`true`,
      );
    }
    if (q.status) clauses.push(eq(estimatingProductionRates.status, q.status));
    if (q.trade) clauses.push(eq(estimatingProductionRates.trade, q.trade));
    if (q.search) {
      clauses.push(
        or(
          ilike(estimatingProductionRates.code, `%${q.search}%`),
          ilike(estimatingProductionRates.description, `%${q.search}%`),
        ) ?? sql`true`,
      );
    }
    const where = and(...clauses);
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(estimatingProductionRates)
      .where(where);
    const items = await app.db
      .select()
      .from(estimatingProductionRates)
      .where(where)
      .orderBy(asc(estimatingProductionRates.code))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/estimating/production-rates", { preHandler: companyGate }, async (req, reply) => {
    const body = S.productionRateCreateSchema.parse(req.body);
    if (body.projectId) await assertProjectInCompany(body.projectId, req.companyId!);
    if (body.crewId) await fetchCrew(body.crewId, req.companyId!);
    const existing = await app.db
      .select({ id: estimatingProductionRates.id })
      .from(estimatingProductionRates)
      .where(
        and(
          eq(estimatingProductionRates.companyId, req.companyId!),
          body.projectId
            ? eq(estimatingProductionRates.projectId, body.projectId)
            : isNull(estimatingProductionRates.projectId),
          eq(estimatingProductionRates.code, body.code),
        ),
      )
      .limit(1);
    if (existing[0]) throw conflict(`A production rate with code ${body.code} already exists`);
    const id = newId("prd");
    await app.db.insert(estimatingProductionRates).values({
      id,
      companyId: req.companyId!,
      projectId: body.projectId ?? null,
      code: body.code,
      description: body.description,
      unit: body.unit,
      trade: body.trade ?? null,
      crewId: body.crewId ?? null,
      basis: body.basis ?? "output_per_hour",
      value: body.value,
      conditions: body.conditions ?? null,
      source: body.source ?? "manual",
      sourceReference: body.sourceReference ?? null,
      region: body.region ?? null,
      rateAsAt: body.rateAsAt ?? todayIso(),
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });
    await ledger(req, "create", "estimating_production_rate", id, {
      code: body.code,
      basis: body.basis ?? "output_per_hour",
      value: body.value,
    });
    const rows = await app.db
      .select()
      .from(estimatingProductionRates)
      .where(eq(estimatingProductionRates.id, id))
      .limit(1);
    return reply.status(201).send(rows[0]);
  });

  app.patch("/estimating/production-rates/:rateId", { preHandler: companyGate }, async (req) => {
    const { rateId } = req.params as { rateId: string };
    const body = S.productionRatePatchSchema.parse(req.body);
    const rows = await app.db
      .select()
      .from(estimatingProductionRates)
      .where(
        and(
          eq(estimatingProductionRates.id, rateId),
          eq(estimatingProductionRates.companyId, req.companyId!),
        ),
      )
      .limit(1);
    const rate = rows[0];
    if (!rate) throw notFound("Production rate not found");
    const patch: Record<string, unknown> = { updatedAt: nowIso() };
    for (const key of [
      "description",
      "unit",
      "trade",
      "crewId",
      "basis",
      "value",
      "conditions",
      "source",
      "sourceReference",
      "region",
      "rateAsAt",
      "status",
      "detail",
    ] as const) {
      const value = (body as Record<string, unknown>)[key];
      if (value !== undefined) patch[key] = value;
    }
    await app.db
      .update(estimatingProductionRates)
      .set(patch)
      .where(eq(estimatingProductionRates.id, rateId));
    await ledger(req, "update", "estimating_production_rate", rateId, {
      code: rate.code,
      changed: Object.keys(patch).filter((k) => k !== "updatedAt"),
    });
    const after = await app.db
      .select()
      .from(estimatingProductionRates)
      .where(eq(estimatingProductionRates.id, rateId))
      .limit(1);
    return after[0];
  });

  app.delete("/estimating/production-rates/:rateId", { preHandler: companyGate }, async (req) => {
    const { rateId } = req.params as { rateId: string };
    const rows = await app.db
      .select()
      .from(estimatingProductionRates)
      .where(
        and(
          eq(estimatingProductionRates.id, rateId),
          eq(estimatingProductionRates.companyId, req.companyId!),
        ),
      )
      .limit(1);
    const rate = rows[0];
    if (!rate) throw notFound("Production rate not found");
    await app.db
      .update(estimatingProductionRates)
      .set({ status: "retired", updatedAt: nowIso() })
      .where(eq(estimatingProductionRates.id, rateId));
    await ledger(req, "state_change", "estimating_production_rate", rateId, {
      code: rate.code,
      from: rate.status,
      to: "retired",
    });
    return { id: rateId, status: "retired" };
  });

  /* ================================================================== */
  /* Estimates (#200)                                                    */
  /* ================================================================== */

  /**
   * Guard a content change and, when the estimate was sitting in review,
   * push it back to draft — an approval belongs to a set of numbers, so the
   * moment the numbers move the approval has to go with them (§6.2).
   */
  async function guardEditable(req: FastifyRequest, estimate: EstimateRow): Promise<void> {
    const { revertToDraft } = assertEditable(estimate);
    if (!revertToDraft) return;
    await app.db
      .update(estimates)
      .set({ status: "draft", approvedBy: null, approvedAt: null, updatedAt: nowIso() })
      .where(eq(estimates.id, estimate.id));
    await ledger(req, "state_change", "estimate", estimate.id, {
      projectId: estimate.projectId,
      reference: estimate.reference,
      from: "in_review",
      to: "draft",
      reason: "content changed while under review; any approval was cleared",
    });
    estimate.status = "draft";
  }

  interface ResolvedLine {
    values: typeof estimateLineItems.$inferInsert;
    basis: string[];
  }

  /**
   * Turn a line body into a row: resolve the catalogue item, the takeoff and
   * the crew, build the labour rate where one can be built, extend the line,
   * and record where every part of it came from.
   */
  async function resolveLine(
    estimate: EstimateRow,
    body: ReturnType<typeof S.lineCreateSchema.parse>,
    userId: string,
    existing?: EstimateLineRow,
  ): Promise<ResolvedLine> {
    const companyId = estimate.companyId;
    let rates: RateSplit = existing ? ratesOf(existing) : makeSplit(undefined);
    let unit = body.unit ?? existing?.unit ?? null;
    let costCode = body.costCode ?? existing?.costCode ?? null;
    let costCodeId = body.costCodeId ?? existing?.costCodeId ?? null;
    let costType: string = body.costType ?? existing?.costType ?? "other";
    let rateAsAt = body.rateAsAt ?? existing?.rateAsAt ?? null;
    let source = body.source ?? existing?.source ?? "manual";
    let productionRate = body.productionRate ?? existing?.productionRate ?? null;
    let productionRateBasis: ProductionRateBasis | string | null =
      body.productionRateBasis ?? existing?.productionRateBasis ?? null;
    let crewId = body.crewId ?? existing?.crewId ?? null;
    let baseQuantity = body.quantity ?? null;
    let takeoffQuantity = existing?.takeoffQuantity ?? null;
    let description = body.description ?? existing?.description ?? "";
    const basis: string[] = [];

    const catalogueItemId = body.catalogueItemId ?? existing?.catalogueItemId ?? null;
    if (body.catalogueItemId) {
      const item = await fetchCatalogueItem(body.catalogueItemId, companyId);
      if (body.rates === undefined) rates = ratesOf(item);
      unit = body.unit ?? item.unit;
      costCode = body.costCode ?? item.costCode;
      costCodeId = body.costCodeId ?? item.costCodeId;
      costType = body.costType ?? item.costType;
      rateAsAt = body.rateAsAt ?? item.rateAsAt;
      crewId = body.crewId ?? item.crewId;
      productionRate = body.productionRate ?? item.productionRate;
      productionRateBasis = body.productionRateBasis ?? item.productionRateBasis;
      if (!body.description && !existing) description = item.description;
      if (source === "manual") source = "catalogue";
      basis.push(
        `Rate from catalogue item ${item.code} (${item.unitRate} ${item.currency}/${item.unit}, current at ${item.rateAsAt ?? "an unrecorded date"}).`,
      );
      if (item.currency !== estimate.currency) {
        basis.push(
          `WARNING: the catalogue rate is in ${item.currency} and the estimate is in ${estimate.currency}. The figure was copied ACROSS, not converted — level it by hand.`,
        );
      }
    }

    const takeoffItemId = body.takeoffItemId ?? existing?.takeoffItemId ?? null;
    if (body.takeoffItemId) {
      const rows = await app.db
        .select()
        .from(takeoffItems)
        .where(
          and(
            eq(takeoffItems.id, body.takeoffItemId),
            eq(takeoffItems.companyId, companyId),
            eq(takeoffItems.projectId, estimate.projectId),
          ),
        )
        .limit(1);
      const takeoff = rows[0];
      if (!takeoff) throw notFound("Takeoff item not found on this project");
      takeoffQuantity = takeoff.quantity;
      baseQuantity = body.quantity ?? takeoff.quantity;
      unit = body.unit ?? takeoff.unit;
      costCode = body.costCode ?? takeoff.costCode ?? costCode;
      costCodeId = body.costCodeId ?? takeoff.costCodeId ?? costCodeId;
      if (!body.description && !existing) description = takeoff.name;
      source = "takeoff";
      basis.push(
        `Quantity measured on takeoff "${takeoff.name}" (${takeoff.quantity} ${takeoff.unit}${takeoff.sheetNumber ? ` on sheet ${takeoff.sheetNumber}` : ""}).`,
      );
    }

    if (body.rates !== undefined) {
      rates = makeSplit({ ...(existing ? ratesOf(existing) : {}), ...body.rates });
    }

    let crew: CrewCost | null = null;
    if (crewId) {
      const crewRow = await fetchCrew(crewId, companyId);
      crew = crewCostOf(crewRow);
    }

    if (baseQuantity === null) {
      baseQuantity = existing
        ? // the stored quantity already has waste in it; strip it back off so a
          // patch that only moves the rate does not compound the allowance
          round4(existing.quantity / (1 + existing.wastePercent / 100))
        : 0;
    }
    const wastePercent = body.wastePercent ?? existing?.wastePercent ?? 0;
    const priced = priceLine({
      baseQuantity,
      wastePercent,
      rates,
      crew,
      productionRate,
      productionRateBasis,
    });
    basis.push(...priced.basis);

    if (description.length === 0) throw badRequest("A line needs a description");

    return {
      basis,
      values: {
        id: existing?.id ?? newId("eli"),
        companyId,
        projectId: estimate.projectId,
        estimateId: estimate.id,
        sectionId: body.sectionId !== undefined ? body.sectionId : (existing?.sectionId ?? null),
        lineageId: existing?.lineageId ?? newId("lng"),
        position: body.position ?? existing?.position ?? 0,
        itemCode: body.itemCode !== undefined ? body.itemCode : (existing?.itemCode ?? null),
        description,
        longDescription:
          body.longDescription !== undefined ? body.longDescription : (existing?.longDescription ?? null),
        costCodeId,
        costCode,
        costType,
        status: body.status ?? existing?.status ?? "active",
        source,
        unit,
        takeoffQuantity,
        wastePercent,
        quantity: priced.quantity,
        unitRate: priced.unitRate,
        labourRate: priced.rates.labour,
        materialRate: priced.rates.material,
        equipmentRate: priced.rates.equipment,
        subcontractRate: priced.rates.subcontract,
        otherRate: priced.rates.other,
        labourAmount: priced.amounts.labour,
        materialAmount: priced.amounts.material,
        equipmentAmount: priced.amounts.equipment,
        subcontractAmount: priced.amounts.subcontract,
        otherAmount: priced.amounts.other,
        amount: priced.amount,
        crewId,
        productionRate,
        productionRateBasis: productionRateBasis === null ? null : String(productionRateBasis),
        labourHours: priced.labourHours,
        takeoffItemId,
        catalogueItemId,
        assemblyId: existing?.assemblyId ?? null,
        assemblyParentLineId: existing?.assemblyParentLineId ?? null,
        subQuoteId: existing?.subQuoteId ?? null,
        subQuoteLineId:
          body.subQuoteLineId !== undefined ? body.subQuoteLineId : (existing?.subQuoteLineId ?? null),
        rateAsAt,
        notes: body.notes !== undefined ? body.notes : (existing?.notes ?? null),
        detail: body.detail ?? existing?.detail ?? {},
        createdBy: existing?.createdBy ?? userId,
        updatedAt: nowIso(),
      },
    };
  }

  /** The estimate header plus everything the workspace needs to render it. */
  async function estimateView(estimate: EstimateRow) {
    const [sections, markups, chain] = await Promise.all([
      sectionsOfEstimate(app.db, estimate.id),
      markupsOfEstimate(app.db, estimate.id),
      app.db
        .select({
          id: estimates.id,
          version: estimates.version,
          status: estimates.status,
          total: estimates.total,
          createdAt: estimates.createdAt,
        })
        .from(estimates)
        .where(and(eq(estimates.rootId, estimate.rootId), eq(estimates.companyId, estimate.companyId)))
        .orderBy(asc(estimates.version)),
    ]);
    const staleLines = estimate.totalsCalculatedAt === null;
    return {
      ...estimate,
      sections,
      markups,
      versions: chain,
      warnings: staleLines
        ? ["The header totals have not been computed yet. Add a line, or run recalculate."]
        : [],
    };
  }

  app.get("/projects/:projectId/estimates", { preHandler: readGate }, async (req) => {
    const q = S.estimateListQuery.parse(req.query);
    const clauses = [
      eq(estimates.companyId, req.companyId!),
      eq(estimates.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(estimates.status, q.status));
    if (q.estimateType) clauses.push(eq(estimates.estimateType, q.estimateType));
    if (q.rootId) clauses.push(eq(estimates.rootId, q.rootId));
    if (q.sourceType) clauses.push(eq(estimates.sourceType, q.sourceType));
    if (q.sourceId) clauses.push(eq(estimates.sourceId, q.sourceId));
    if (q.headsOnly === "true") clauses.push(isNull(estimates.supersededById));
    if (q.search) {
      clauses.push(
        or(ilike(estimates.name, `%${q.search}%`), ilike(estimates.reference, `%${q.search}%`)) ??
          sql`true`,
      );
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(estimates).where(where);
    const items = await app.db
      .select()
      .from(estimates)
      .where(where)
      .orderBy(desc(estimates.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/projects/:projectId/estimates", { preHandler: standardGate }, async (req, reply) => {
    const body = S.estimateCreateSchema.parse(req.body);
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    if (body.sourceType === "change_event" && body.sourceId) {
      const rows = await app.db
        .select({ id: changeEvents.id })
        .from(changeEvents)
        .where(
          and(
            eq(changeEvents.id, body.sourceId),
            eq(changeEvents.companyId, companyId),
            eq(changeEvents.projectId, projectId),
          ),
        )
        .limit(1);
      if (!rows[0]) throw notFound("Change event not found on this project");
    }
    const number = await nextRecordNumber(app.db, projectId, "estimate");
    const id = newId("est");
    const reference = `EST-${pad3(number)}`;
    const projectRows = await app.db
      .select({ currency: projects.currency })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    await app.db.insert(estimates).values({
      id,
      companyId,
      projectId,
      number,
      reference,
      name: body.name,
      description: body.description ?? null,
      estimateType: body.estimateType ?? "conceptual",
      currency: body.currency ?? projectRows[0]?.currency ?? "USD",
      rootId: id,
      version: 1,
      basis: body.basis ?? null,
      accuracyRange: body.accuracyRange ?? null,
      quantityBasis: body.quantityBasis ?? null,
      quantityBasisUnit: body.quantityBasisUnit ?? null,
      sourceType: body.sourceType ?? null,
      sourceId: body.sourceId ?? null,
      notes: body.notes ?? null,
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });
    await ledger(req, "create", "estimate", id, {
      projectId,
      reference,
      name: body.name,
      estimateType: body.estimateType ?? "conceptual",
    });
    return reply.status(201).send(await estimateView(await fetchEstimate(app.db, id, companyId, projectId)));
  });

  app.get("/projects/:projectId/estimates/:estimateId", { preHandler: readGate }, async (req) => {
    const { estimateId } = req.params as { estimateId: string };
    return estimateView(await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!));
  });

  app.patch("/projects/:projectId/estimates/:estimateId", { preHandler: standardGate }, async (req) => {
    const { estimateId } = req.params as { estimateId: string };
    const body = S.estimatePatchSchema.parse(req.body);
    const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
    if (["superseded", "void", "archived"].includes(estimate.status)) {
      throw conflict(`Estimate ${estimate.reference} is ${estimate.status} and cannot be edited`);
    }
    // Currency is the one field that would silently reinterpret every number
    // on the estimate, so it moves only while the estimate has no lines.
    if (body.currency && body.currency !== estimate.currency && estimate.lineCount > 0) {
      throw conflict(
        `Estimate ${estimate.reference} already has ${estimate.lineCount} priced lines in ${estimate.currency}. Changing the currency would reinterpret every one of them; cut a new estimate instead.`,
      );
    }
    const patch: Record<string, unknown> = { updatedAt: nowIso() };
    for (const key of [
      "name",
      "description",
      "estimateType",
      "currency",
      "basis",
      "accuracyRange",
      "quantityBasis",
      "quantityBasisUnit",
      "notes",
      "detail",
    ] as const) {
      const value = (body as Record<string, unknown>)[key];
      if (value !== undefined) patch[key] = value;
    }
    await app.db.update(estimates).set(patch).where(eq(estimates.id, estimateId));
    await ledger(req, "update", "estimate", estimateId, {
      projectId: estimate.projectId,
      reference: estimate.reference,
      changed: Object.keys(patch).filter((k) => k !== "updatedAt"),
    });
    return estimateView(await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!));
  });

  app.delete("/projects/:projectId/estimates/:estimateId", { preHandler: standardGate }, async (req) => {
    const { estimateId } = req.params as { estimateId: string };
    const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
    if (estimate.status !== "draft") {
      throw conflict(
        `Only a draft estimate can be voided; ${estimate.reference} is ${estimate.status}.`,
      );
    }
    await app.db
      .update(estimates)
      .set({ status: "void", updatedAt: nowIso() })
      .where(eq(estimates.id, estimateId));
    await ledger(req, "state_change", "estimate", estimateId, {
      projectId: estimate.projectId,
      reference: estimate.reference,
      from: estimate.status,
      to: "void",
    });
    return { id: estimateId, status: "void" };
  });

  app.post("/projects/:projectId/estimates/:estimateId/recalculate", { preHandler: standardGate }, async (req) => {
    const { estimateId } = req.params as { estimateId: string };
    const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
    const totals = await recomputeEstimate(app.db, estimate.id);
    return { ...(await estimateView(await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!))), recompute: totals };
  });

  /* ---------------- lifecycle transitions ---------------------------- */

  app.post("/projects/:projectId/estimates/:estimateId/submit", { preHandler: standardGate }, async (req) => {
    const { estimateId } = req.params as { estimateId: string };
    const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
    if (estimate.status !== "draft") {
      throw conflict(`Only a draft estimate can be submitted; ${estimate.reference} is ${estimate.status}.`);
    }
    if (estimate.lineCount === 0) {
      throw badRequest(`Estimate ${estimate.reference} has no priced lines to review.`);
    }
    await recomputeEstimate(app.db, estimate.id);
    await app.db
      .update(estimates)
      .set({ status: "in_review", updatedAt: nowIso() })
      .where(eq(estimates.id, estimateId));
    await ledger(req, "state_change", "estimate", estimateId, {
      projectId: estimate.projectId,
      reference: estimate.reference,
      from: "draft",
      to: "in_review",
      total: estimate.total,
      currency: estimate.currency,
    });
    return estimateView(await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!));
  });

  app.post("/projects/:projectId/estimates/:estimateId/approve", { preHandler: standardGate }, async (req) => {
    const { estimateId } = req.params as { estimateId: string };
    const body = S.approveSchema.parse(req.body ?? {});
    const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
    if (estimate.status !== "in_review") {
      throw conflict(
        `Estimate ${estimate.reference} is ${estimate.status}; only an estimate under review can be approved.`,
      );
    }
    // Segregation of duties: the estimator cannot approve his own number.
    if (estimate.createdBy === req.user!.id) {
      throw forbidden(
        "An estimate cannot be approved by the person who prepared it. A second person must approve it.",
      );
    }
    const totals = await recomputeEstimate(app.db, estimate.id);
    await app.db
      .update(estimates)
      .set({
        status: "approved",
        approvedBy: req.user!.id,
        approvedAt: nowIso(),
        lockedAt: nowIso(),
        lockedBy: req.user!.id,
        notes: body.note ?? estimate.notes,
        updatedAt: nowIso(),
      })
      .where(eq(estimates.id, estimateId));
    await ledger(req, "state_change", "estimate", estimateId, {
      projectId: estimate.projectId,
      reference: estimate.reference,
      from: "in_review",
      to: "approved",
      approvedBy: req.user!.id,
      preparedBy: estimate.createdBy,
      total: totals.total,
      currency: estimate.currency,
    });
    if (estimate.createdBy !== req.user!.id) {
      await pushNotifications(app.db, [
        {
          companyId: req.companyId!,
          userId: estimate.createdBy,
          projectId: estimate.projectId,
          kind: "estimate",
          title: `Estimate ${estimate.reference} approved`,
          body: `${estimate.name} — ${totals.total} ${estimate.currency}.`,
          recordType: "estimate",
          recordId: estimateId,
        },
      ]);
    }
    return estimateView(await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!));
  });

  app.post("/projects/:projectId/estimates/:estimateId/reject", { preHandler: standardGate }, async (req) => {
    const { estimateId } = req.params as { estimateId: string };
    const body = S.rejectSchema.parse(req.body);
    const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
    if (estimate.status !== "in_review") {
      throw conflict(`Estimate ${estimate.reference} is ${estimate.status}; nothing is under review.`);
    }
    if (estimate.createdBy === req.user!.id) {
      throw forbidden(
        "An estimate cannot be rejected by the person who prepared it; withdraw it instead.",
      );
    }
    await app.db
      .update(estimates)
      .set({ status: "draft", approvedBy: null, approvedAt: null, updatedAt: nowIso() })
      .where(eq(estimates.id, estimateId));
    await ledger(req, "state_change", "estimate", estimateId, {
      projectId: estimate.projectId,
      reference: estimate.reference,
      from: "in_review",
      to: "draft",
      rejectedBy: req.user!.id,
      reason: body.reason,
    });
    await pushNotifications(app.db, [
      {
        companyId: req.companyId!,
        userId: estimate.createdBy,
        projectId: estimate.projectId,
        kind: "estimate",
        title: `Estimate ${estimate.reference} sent back`,
        body: body.reason,
        recordType: "estimate",
        recordId: estimateId,
      },
    ]);
    return estimateView(await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!));
  });

  app.post("/projects/:projectId/estimates/:estimateId/withdraw", { preHandler: standardGate }, async (req) => {
    const { estimateId } = req.params as { estimateId: string };
    const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
    if (estimate.status !== "in_review") {
      throw conflict(`Estimate ${estimate.reference} is ${estimate.status}; nothing to withdraw.`);
    }
    await app.db
      .update(estimates)
      .set({ status: "draft", approvedBy: null, approvedAt: null, updatedAt: nowIso() })
      .where(eq(estimates.id, estimateId));
    await ledger(req, "state_change", "estimate", estimateId, {
      projectId: estimate.projectId,
      reference: estimate.reference,
      from: "in_review",
      to: "draft",
      reason: "withdrawn from review",
    });
    return estimateView(await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!));
  });

  app.post("/projects/:projectId/estimates/:estimateId/lock", { preHandler: standardGate }, async (req) => {
    const { estimateId } = req.params as { estimateId: string };
    const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
    if (estimate.lockedAt) throw conflict(`Estimate ${estimate.reference} is already locked`);
    await recomputeEstimate(app.db, estimate.id);
    await app.db
      .update(estimates)
      .set({ lockedAt: nowIso(), lockedBy: req.user!.id, updatedAt: nowIso() })
      .where(eq(estimates.id, estimateId));
    await ledger(req, "state_change", "estimate", estimateId, {
      projectId: estimate.projectId,
      reference: estimate.reference,
      action: "lock",
    });
    return estimateView(await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!));
  });

  app.post("/projects/:projectId/estimates/:estimateId/unlock", { preHandler: adminGate }, async (req) => {
    const { estimateId } = req.params as { estimateId: string };
    const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
    if (!estimate.lockedAt) throw conflict(`Estimate ${estimate.reference} is not locked`);
    if (estimate.status === "converted") {
      throw conflict(
        `Estimate ${estimate.reference} has already been converted into a budget; unlocking it would let the budget and the estimate diverge silently. Cut a new version instead.`,
      );
    }
    await app.db
      .update(estimates)
      .set({
        lockedAt: null,
        lockedBy: null,
        status: estimate.status === "approved" ? "draft" : estimate.status,
        approvedBy: null,
        approvedAt: null,
        updatedAt: nowIso(),
      })
      .where(eq(estimates.id, estimateId));
    await ledger(req, "state_change", "estimate", estimateId, {
      projectId: estimate.projectId,
      reference: estimate.reference,
      action: "unlock",
      previousStatus: estimate.status,
      approvalCleared: estimate.approvedBy !== null,
    });
    return estimateView(await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!));
  });

  /* ---------------- versions (#200) and comparison (#201) ------------- */

  app.get("/projects/:projectId/estimates/:estimateId/versions", { preHandler: readGate }, async (req) => {
    const { estimateId } = req.params as { estimateId: string };
    const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
    const items = await app.db
      .select()
      .from(estimates)
      .where(and(eq(estimates.rootId, estimate.rootId), eq(estimates.companyId, req.companyId!)))
      .orderBy(asc(estimates.version));
    return { rootId: estimate.rootId, items, total: items.length };
  });

  app.post("/projects/:projectId/estimates/:estimateId/versions", { preHandler: standardGate }, async (req, reply) => {
    const { estimateId } = req.params as { estimateId: string };
    const body = S.versionCreateSchema.parse(req.body ?? {});
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    const parent = await fetchEstimate(app.db, estimateId, companyId, projectId);
    if (parent.status === "void") {
      throw conflict(`Estimate ${parent.reference} is void; there is nothing to carry forward.`);
    }
    if (parent.supersededById) {
      throw conflict(
        `Estimate ${parent.reference} has already been superseded by a later version; branch from the head instead.`,
      );
    }
    const [sections, lines, markups] = await Promise.all([
      sectionsOfEstimate(app.db, parent.id),
      linesOfEstimate(app.db, parent.id),
      markupsOfEstimate(app.db, parent.id),
    ]);
    const number = await nextRecordNumber(app.db, projectId, "estimate");
    const newEstimateId = newId("est");
    const reference = `EST-${pad3(number)}`;
    const sectionMap = new Map<string, string>();
    for (const s of sections) sectionMap.set(s.id, newId("esec"));

    await app.db.transaction(async (tx) => {
      await tx.insert(estimates).values({
        id: newEstimateId,
        companyId,
        projectId,
        number,
        reference,
        name: body.name ?? parent.name,
        description: parent.description,
        status: "draft",
        estimateType: body.estimateType ?? parent.estimateType,
        currency: parent.currency,
        rootId: parent.rootId,
        version: parent.version + 1,
        parentEstimateId: parent.id,
        sourceType: parent.sourceType,
        sourceId: parent.sourceId,
        basis: body.basis ?? parent.basis,
        accuracyRange: parent.accuracyRange,
        quantityBasis: parent.quantityBasis,
        quantityBasisUnit: parent.quantityBasisUnit,
        notes: body.notes ?? parent.notes,
        detail: parent.detail,
        createdBy: req.user!.id,
      });
      if (sections.length > 0) {
        await tx.insert(estimateSections).values(
          sections.map((s) => ({
            id: sectionMap.get(s.id)!,
            companyId,
            projectId,
            estimateId: newEstimateId,
            parentId: s.parentId ? (sectionMap.get(s.parentId) ?? null) : null,
            code: s.code,
            name: s.name,
            description: s.description,
            sortOrder: s.sortOrder,
            directCostTotal: s.directCostTotal,
            detail: s.detail,
          })),
        );
      }
      if (lines.length > 0) {
        const lineMap = new Map<string, string>();
        for (const l of lines) lineMap.set(l.id, newId("eli"));
        await tx.insert(estimateLineItems).values(
          lines.map((l) => ({
            ...l,
            id: lineMap.get(l.id)!,
            estimateId: newEstimateId,
            sectionId: l.sectionId ? (sectionMap.get(l.sectionId) ?? null) : null,
            assemblyParentLineId: l.assemblyParentLineId
              ? (lineMap.get(l.assemblyParentLineId) ?? null)
              : null,
            // lineageId is deliberately CARRIED, not regenerated: it is what
            // pairs this line with its ancestor when the versions are compared.
            createdAt: nowIso(),
            updatedAt: nowIso(),
          })),
        );
      }
      if (markups.length > 0) {
        await tx.insert(estimateMarkups).values(
          markups.map((m) => ({
            ...m,
            id: newId("emk"),
            estimateId: newEstimateId,
            sectionIds: m.sectionIds
              .map((sid) => sectionMap.get(sid))
              .filter((sid): sid is string => typeof sid === "string"),
            createdAt: nowIso(),
            updatedAt: nowIso(),
          })),
        );
      }
      await tx
        .update(estimates)
        .set({ status: "superseded", supersededById: newEstimateId, updatedAt: nowIso() })
        .where(eq(estimates.id, parent.id));
    });

    await recomputeEstimate(app.db, newEstimateId);
    await ledger(req, "create", "estimate", newEstimateId, {
      projectId,
      reference,
      rootId: parent.rootId,
      version: parent.version + 1,
      supersedes: parent.reference,
      linesCopied: lines.length,
    });
    await ledger(req, "state_change", "estimate", parent.id, {
      projectId,
      reference: parent.reference,
      from: parent.status,
      to: "superseded",
      supersededBy: reference,
    });
    return reply
      .status(201)
      .send(await estimateView(await fetchEstimate(app.db, newEstimateId, companyId, projectId)));
  });

  const comparableOf = (l: EstimateLineRow): ComparableLine => ({
    id: l.id,
    lineageId: l.lineageId,
    itemCode: l.itemCode,
    description: l.description,
    costCode: l.costCode,
    costType: l.costType,
    unit: l.unit,
    quantity: l.quantity,
    unitRate: l.unitRate,
    amount: l.amount,
    status: l.status,
    sectionId: l.sectionId,
  });

  app.get("/projects/:projectId/estimates/:estimateId/compare", { preHandler: readGate }, async (req) => {
    const { estimateId } = req.params as { estimateId: string };
    const q = S.compareQuery.parse(req.query);
    const after = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
    const before = await fetchEstimate(app.db, q.against, req.companyId!, req.projectId!);
    const [beforeLines, afterLines] = await Promise.all([
      linesOfEstimate(app.db, before.id),
      linesOfEstimate(app.db, after.id),
    ]);
    const comparison = compareEstimates({
      before: beforeLines.map(comparableOf),
      after: afterLines.map(comparableOf),
      beforeMarkupTotal: before.markupTotal,
      afterMarkupTotal: after.markupTotal,
      includeUnchanged: q.includeUnchanged === "true",
    });
    const warnings = [...comparison.warnings];
    if (before.currency !== after.currency) {
      warnings.unshift(
        `${before.reference} is in ${before.currency} and ${after.reference} is in ${after.currency}. The deltas below are arithmetic on two different currencies and mean nothing; they are shown so the mismatch is visible, not so it can be used.`,
      );
    }
    if (before.rootId !== after.rootId) {
      warnings.push(
        "These two estimates are not versions of one another, so lines were paired on cost code and description rather than on lineage.",
      );
    }
    return {
      before: { id: before.id, reference: before.reference, version: before.version, name: before.name, currency: before.currency, status: before.status },
      after: { id: after.id, reference: after.reference, version: after.version, name: after.name, currency: after.currency, status: after.status },
      ...comparison,
      warnings,
    };
  });

  /* ---------------- sections ------------------------------------------ */

  app.get("/projects/:projectId/estimates/:estimateId/sections", { preHandler: readGate }, async (req) => {
    const { estimateId } = req.params as { estimateId: string };
    const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
    const items = await sectionsOfEstimate(app.db, estimate.id);
    return { items, total: items.length };
  });

  app.post("/projects/:projectId/estimates/:estimateId/sections", { preHandler: standardGate }, async (req, reply) => {
    const { estimateId } = req.params as { estimateId: string };
    const body = S.sectionCreateSchema.parse(req.body);
    const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
    await guardEditable(req, estimate);
    const id = newId("esec");
    await app.db.insert(estimateSections).values({
      id,
      companyId: estimate.companyId,
      projectId: estimate.projectId,
      estimateId: estimate.id,
      parentId: body.parentId ?? null,
      code: body.code ?? null,
      name: body.name,
      description: body.description ?? null,
      sortOrder: body.sortOrder ?? 0,
      detail: body.detail ?? {},
    });
    await ledger(req, "create", "estimate_section", id, {
      projectId: estimate.projectId,
      estimateId: estimate.id,
      name: body.name,
    });
    const rows = await app.db.select().from(estimateSections).where(eq(estimateSections.id, id)).limit(1);
    return reply.status(201).send(rows[0]);
  });

  app.patch(
    "/projects/:projectId/estimates/:estimateId/sections/:sectionId",
    { preHandler: standardGate },
    async (req) => {
      const { estimateId, sectionId } = req.params as { estimateId: string; sectionId: string };
      const body = S.sectionPatchSchema.parse(req.body);
      const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
      await guardEditable(req, estimate);
      const rows = await app.db
        .select()
        .from(estimateSections)
        .where(and(eq(estimateSections.id, sectionId), eq(estimateSections.estimateId, estimate.id)))
        .limit(1);
      if (!rows[0]) throw notFound("Section not found on this estimate");
      const patch: Record<string, unknown> = { updatedAt: nowIso() };
      for (const key of ["name", "code", "description", "parentId", "sortOrder", "detail"] as const) {
        const value = (body as Record<string, unknown>)[key];
        if (value !== undefined) patch[key] = value;
      }
      await app.db.update(estimateSections).set(patch).where(eq(estimateSections.id, sectionId));
      await ledger(req, "update", "estimate_section", sectionId, {
        projectId: estimate.projectId,
        estimateId: estimate.id,
        changed: Object.keys(patch).filter((k) => k !== "updatedAt"),
      });
      const after = await app.db
        .select()
        .from(estimateSections)
        .where(eq(estimateSections.id, sectionId))
        .limit(1);
      return after[0];
    },
  );

  app.delete(
    "/projects/:projectId/estimates/:estimateId/sections/:sectionId",
    { preHandler: standardGate },
    async (req) => {
      const { estimateId, sectionId } = req.params as { estimateId: string; sectionId: string };
      const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
      await guardEditable(req, estimate);
      const rows = await app.db
        .select()
        .from(estimateSections)
        .where(and(eq(estimateSections.id, sectionId), eq(estimateSections.estimateId, estimate.id)))
        .limit(1);
      const section = rows[0];
      if (!section) throw notFound("Section not found on this estimate");
      // Lines are unparented rather than deleted: a section is a heading, and
      // deleting a heading must never delete money.
      const [{ n } = { n: 0 }] = await app.db
        .select({ n: count() })
        .from(estimateLineItems)
        .where(eq(estimateLineItems.sectionId, sectionId));
      await app.db
        .update(estimateLineItems)
        .set({ sectionId: null, updatedAt: nowIso() })
        .where(eq(estimateLineItems.sectionId, sectionId));
      await app.db.delete(estimateSections).where(eq(estimateSections.id, sectionId));
      await recomputeEstimate(app.db, estimate.id);
      await ledger(req, "delete", "estimate_section", sectionId, {
        projectId: estimate.projectId,
        estimateId: estimate.id,
        name: section.name,
        linesUnparented: Number(n),
      });
      return { id: sectionId, deleted: true, linesUnparented: Number(n) };
    },
  );

  /* ---------------- lines --------------------------------------------- */

  app.get("/projects/:projectId/estimates/:estimateId/lines", { preHandler: readGate }, async (req) => {
    const { estimateId } = req.params as { estimateId: string };
    const q = S.lineListQuery.parse(req.query);
    const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
    const clauses = [eq(estimateLineItems.estimateId, estimate.id)];
    if (q.sectionId) clauses.push(eq(estimateLineItems.sectionId, q.sectionId));
    if (q.costType) clauses.push(eq(estimateLineItems.costType, q.costType));
    if (q.status) clauses.push(eq(estimateLineItems.status, q.status));
    if (q.source) clauses.push(eq(estimateLineItems.source, q.source));
    if (q.search) {
      clauses.push(
        or(
          ilike(estimateLineItems.description, `%${q.search}%`),
          ilike(estimateLineItems.costCode, `%${q.search}%`),
        ) ?? sql`true`,
      );
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(estimateLineItems).where(where);
    const items = await app.db
      .select()
      .from(estimateLineItems)
      .where(where)
      .orderBy(asc(estimateLineItems.position), asc(estimateLineItems.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/projects/:projectId/estimates/:estimateId/lines", { preHandler: standardGate }, async (req, reply) => {
    const { estimateId } = req.params as { estimateId: string };
    const body = S.lineCreateSchema.parse(req.body);
    const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
    await guardEditable(req, estimate);
    const resolved = await resolveLine(estimate, body, req.user!.id);
    await app.db.insert(estimateLineItems).values(resolved.values);
    if (resolved.values.takeoffItemId) {
      await app.db
        .update(takeoffItems)
        .set({ status: "priced", updatedAt: nowIso() })
        .where(eq(takeoffItems.id, resolved.values.takeoffItemId));
    }
    const totals = await recomputeEstimate(app.db, estimate.id);
    await ledger(req, "create", "estimate_line_item", String(resolved.values.id), {
      projectId: estimate.projectId,
      estimateId: estimate.id,
      description: resolved.values.description,
      amount: resolved.values.amount,
      currency: estimate.currency,
      estimateTotal: totals.total,
    });
    const rows = await app.db
      .select()
      .from(estimateLineItems)
      .where(eq(estimateLineItems.id, String(resolved.values.id)))
      .limit(1);
    return reply.status(201).send({ ...rows[0], basis: resolved.basis, estimateTotals: totals });
  });

  app.post("/projects/:projectId/estimates/:estimateId/lines/bulk", { preHandler: standardGate }, async (req, reply) => {
    const { estimateId } = req.params as { estimateId: string };
    const body = S.lineBulkSchema.parse(req.body);
    const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
    await guardEditable(req, estimate);
    const values: Array<typeof estimateLineItems.$inferInsert> = [];
    let position = estimate.lineCount;
    for (const line of body.lines) {
      const resolved = await resolveLine(estimate, { ...line, position: line.position ?? position }, req.user!.id);
      values.push(resolved.values);
      position += 1;
    }
    await app.db.insert(estimateLineItems).values(values);
    const totals = await recomputeEstimate(app.db, estimate.id);
    await ledger(req, "create", "estimate_line_batch", newId("bat"), {
      projectId: estimate.projectId,
      estimateId: estimate.id,
      lines: values.length,
      estimateTotal: totals.total,
      currency: estimate.currency,
    });
    return reply.status(201).send({ created: values.length, ids: values.map((v) => v.id), estimateTotals: totals });
  });

  app.patch(
    "/projects/:projectId/estimates/:estimateId/lines/:lineId",
    { preHandler: standardGate },
    async (req) => {
      const { estimateId, lineId } = req.params as { estimateId: string; lineId: string };
      const body = S.linePatchSchema.parse(req.body);
      const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
      await guardEditable(req, estimate);
      const rows = await app.db
        .select()
        .from(estimateLineItems)
        .where(and(eq(estimateLineItems.id, lineId), eq(estimateLineItems.estimateId, estimate.id)))
        .limit(1);
      const existing = rows[0];
      if (!existing) throw notFound("Estimate line not found on this estimate");
      const resolved = await resolveLine(
        estimate,
        { ...body, description: body.description ?? existing.description },
        req.user!.id,
        existing,
      );
      const { id: _id, createdAt: _createdAt, ...updatable } = resolved.values;
      await app.db.update(estimateLineItems).set(updatable).where(eq(estimateLineItems.id, lineId));
      const totals = await recomputeEstimate(app.db, estimate.id);
      await ledger(req, "update", "estimate_line_item", lineId, {
        projectId: estimate.projectId,
        estimateId: estimate.id,
        amountBefore: existing.amount,
        amountAfter: resolved.values.amount,
        currency: estimate.currency,
        estimateTotal: totals.total,
      });
      const after = await app.db
        .select()
        .from(estimateLineItems)
        .where(eq(estimateLineItems.id, lineId))
        .limit(1);
      return { ...after[0], basis: resolved.basis, estimateTotals: totals };
    },
  );

  app.delete(
    "/projects/:projectId/estimates/:estimateId/lines/:lineId",
    { preHandler: standardGate },
    async (req) => {
      const { estimateId, lineId } = req.params as { estimateId: string; lineId: string };
      const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
      await guardEditable(req, estimate);
      const rows = await app.db
        .select()
        .from(estimateLineItems)
        .where(and(eq(estimateLineItems.id, lineId), eq(estimateLineItems.estimateId, estimate.id)))
        .limit(1);
      const line = rows[0];
      if (!line) throw notFound("Estimate line not found on this estimate");
      await app.db
        .delete(estimateLineItems)
        .where(
          or(
            eq(estimateLineItems.id, lineId),
            eq(estimateLineItems.assemblyParentLineId, lineId),
          ) ?? eq(estimateLineItems.id, lineId),
        );
      if (line.takeoffItemId) {
        await app.db
          .update(takeoffItems)
          .set({ status: "assigned", updatedAt: nowIso() })
          .where(eq(takeoffItems.id, line.takeoffItemId));
      }
      const totals = await recomputeEstimate(app.db, estimate.id);
      await ledger(req, "delete", "estimate_line_item", lineId, {
        projectId: estimate.projectId,
        estimateId: estimate.id,
        description: line.description,
        amount: line.amount,
        currency: estimate.currency,
        estimateTotal: totals.total,
      });
      return { id: lineId, deleted: true, estimateTotals: totals };
    },
  );

  app.post(
    "/projects/:projectId/estimates/:estimateId/lines/from-takeoff",
    { preHandler: standardGate },
    async (req, reply) => {
      const { estimateId } = req.params as { estimateId: string };
      const body = S.fromTakeoffSchema.parse(req.body);
      const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
      await guardEditable(req, estimate);
      const takeoffs = await app.db
        .select()
        .from(takeoffItems)
        .where(
          and(
            inArray(takeoffItems.id, body.takeoffItemIds),
            eq(takeoffItems.companyId, req.companyId!),
            eq(takeoffItems.projectId, req.projectId!),
          ),
        );
      if (takeoffs.length === 0) throw notFound("No takeoff items found on this project");
      const missing = body.takeoffItemIds.filter((id) => !takeoffs.some((t) => t.id === id));
      const values: Array<typeof estimateLineItems.$inferInsert> = [];
      let position = estimate.lineCount;
      for (const takeoff of takeoffs) {
        const resolved = await resolveLine(
          estimate,
          {
            description: takeoff.name,
            takeoffItemId: takeoff.id,
            sectionId: body.sectionId ?? null,
            catalogueItemId: body.catalogueItemId ?? null,
            rates: body.rates,
            wastePercent: body.wastePercent,
            costType: body.costType,
            position,
          },
          req.user!.id,
        );
        values.push(resolved.values);
        position += 1;
      }
      await app.db.insert(estimateLineItems).values(values);
      await app.db
        .update(takeoffItems)
        .set({ status: "priced", updatedAt: nowIso() })
        .where(inArray(takeoffItems.id, takeoffs.map((t) => t.id)));
      const totals = await recomputeEstimate(app.db, estimate.id);
      await ledger(req, "create", "estimate_line_batch", newId("bat"), {
        projectId: estimate.projectId,
        estimateId: estimate.id,
        source: "takeoff",
        lines: values.length,
        estimateTotal: totals.total,
      });
      return reply.status(201).send({
        created: values.length,
        ids: values.map((v) => v.id),
        estimateTotals: totals,
        warnings:
          missing.length > 0
            ? [`${missing.length} takeoff id${missing.length === 1 ? "" : "s"} were not found on this project and were skipped.`]
            : [],
      });
    },
  );

  app.post(
    "/projects/:projectId/estimates/:estimateId/lines/from-assembly",
    { preHandler: standardGate },
    async (req, reply) => {
      const { estimateId } = req.params as { estimateId: string };
      const body = S.fromAssemblySchema.parse(req.body);
      const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
      await guardEditable(req, estimate);
      const assembly = await fetchAssembly(body.assemblyId, req.companyId!);
      const components = await componentsOf(assembly.id);
      if (components.length === 0) {
        throw badRequest(`Assembly ${assembly.code} has no components, so there is nothing to price.`);
      }
      const warnings: string[] = [];
      if (assembly.currency !== estimate.currency) {
        warnings.push(
          `The assembly is priced in ${assembly.currency} and the estimate is in ${estimate.currency}. The rates were copied across, NOT converted.`,
        );
      }
      const expandComponents = body.expandComponents !== false;
      const values: Array<typeof estimateLineItems.$inferInsert> = [];
      let position = estimate.lineCount;

      const parentId = newId("eli");
      const parentPriced = priceLine({
        baseQuantity: body.quantity,
        rates: {
          labour: assembly.labourRate,
          material: assembly.materialRate,
          equipment: assembly.equipmentRate,
          subcontract: assembly.subcontractRate,
          other: assembly.otherRate,
        },
      });
      const baseLine = {
        companyId: estimate.companyId,
        projectId: estimate.projectId,
        estimateId: estimate.id,
        sectionId: body.sectionId ?? null,
        assemblyId: assembly.id,
        source: "assembly" as const,
        createdBy: req.user!.id,
        updatedAt: nowIso(),
      };
      values.push({
        ...baseLine,
        id: parentId,
        lineageId: newId("lng"),
        position,
        description: body.description ?? `${assembly.name} (${assembly.code})`,
        costCodeId: assembly.costCodeId,
        costCode: assembly.costCode,
        costType: dominantCostType({
          labour: assembly.labourRate,
          material: assembly.materialRate,
          equipment: assembly.equipmentRate,
          subcontract: assembly.subcontractRate,
          other: assembly.otherRate,
        }),
        // When the components are expanded onto their own lines the parent is
        // a heading, not money: it is marked `excluded` so the assembly is not
        // counted twice.
        status: expandComponents ? "excluded" : "active",
        unit: assembly.unit,
        quantity: parentPriced.quantity,
        unitRate: parentPriced.unitRate,
        labourRate: parentPriced.rates.labour,
        materialRate: parentPriced.rates.material,
        equipmentRate: parentPriced.rates.equipment,
        subcontractRate: parentPriced.rates.subcontract,
        otherRate: parentPriced.rates.other,
        labourAmount: parentPriced.amounts.labour,
        materialAmount: parentPriced.amounts.material,
        equipmentAmount: parentPriced.amounts.equipment,
        subcontractAmount: parentPriced.amounts.subcontract,
        otherAmount: parentPriced.amounts.other,
        amount: parentPriced.amount,
        notes: expandComponents
          ? "Assembly header — the money is on the component lines below."
          : null,
      });
      position += 1;

      if (expandComponents) {
        const expanded = expandAssembly(
          components.map((c) => ({
            description: c.description,
            unit: c.unit,
            costType: c.costType,
            quantityPer: c.quantityPer,
            wastePercent: c.wastePercent,
            rates: ratesOf(c),
            catalogueItemId: c.catalogueItemId,
            costCodeId: c.costCodeId,
            costCode: c.costCode,
          })),
          body.quantity,
        );
        for (const line of expanded) {
          values.push({
            ...baseLine,
            id: newId("eli"),
            lineageId: newId("lng"),
            assemblyParentLineId: parentId,
            position,
            description: line.description,
            costCodeId: line.costCodeId ?? assembly.costCodeId,
            costCode: line.costCode ?? assembly.costCode,
            costType: line.costType,
            status: "active",
            unit: line.unit,
            catalogueItemId: line.catalogueItemId,
            wastePercent: line.wastePercent,
            takeoffQuantity: line.baseQuantity,
            quantity: line.priced.quantity,
            unitRate: line.priced.unitRate,
            labourRate: line.priced.rates.labour,
            materialRate: line.priced.rates.material,
            equipmentRate: line.priced.rates.equipment,
            subcontractRate: line.priced.rates.subcontract,
            otherRate: line.priced.rates.other,
            labourAmount: line.priced.amounts.labour,
            materialAmount: line.priced.amounts.material,
            equipmentAmount: line.priced.amounts.equipment,
            subcontractAmount: line.priced.amounts.subcontract,
            otherAmount: line.priced.amounts.other,
            amount: line.priced.amount,
          });
          position += 1;
        }
      }

      await app.db.insert(estimateLineItems).values(values);
      const totals = await recomputeEstimate(app.db, estimate.id);
      await ledger(req, "create", "estimate_line_batch", newId("bat"), {
        projectId: estimate.projectId,
        estimateId: estimate.id,
        source: "assembly",
        assembly: assembly.code,
        quantity: body.quantity,
        lines: values.length,
        estimateTotal: totals.total,
      });
      return reply
        .status(201)
        .send({ created: values.length, parentLineId: parentId, estimateTotals: totals, warnings });
    },
  );

  /* ---------------- markups (#198–199) -------------------------------- */

  app.get("/projects/:projectId/estimates/:estimateId/markups", { preHandler: readGate }, async (req) => {
    const { estimateId } = req.params as { estimateId: string };
    const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
    const items = await markupsOfEstimate(app.db, estimate.id);
    return { items, total: items.length, directCostTotal: estimate.directCostTotal, currency: estimate.currency };
  });

  app.post("/projects/:projectId/estimates/:estimateId/markups", { preHandler: standardGate }, async (req, reply) => {
    const { estimateId } = req.params as { estimateId: string };
    const body = S.markupCreateSchema.parse(req.body);
    const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
    await guardEditable(req, estimate);
    const existing = await markupsOfEstimate(app.db, estimate.id);
    const id = newId("emk");
    await app.db.insert(estimateMarkups).values({
      id,
      companyId: estimate.companyId,
      projectId: estimate.projectId,
      estimateId: estimate.id,
      sequence: body.sequence ?? existing.length + 1,
      kind: body.kind ?? "overhead",
      name: body.name,
      method: body.method ?? "percent",
      basis: body.basis ?? "direct_cost",
      rate: body.rate,
      costTypes: body.costTypes ?? [],
      sectionIds: body.sectionIds ?? [],
      quantity: body.quantity ?? null,
      rationale: body.rationale ?? null,
      enabled: body.enabled === false ? 0 : 1,
      detail: body.detail ?? {},
    });
    const totals = await recomputeEstimate(app.db, estimate.id);
    await ledger(req, "create", "estimate_markup", id, {
      projectId: estimate.projectId,
      estimateId: estimate.id,
      name: body.name,
      kind: body.kind ?? "overhead",
      rate: body.rate,
      estimateTotal: totals.total,
    });
    const rows = await app.db.select().from(estimateMarkups).where(eq(estimateMarkups.id, id)).limit(1);
    return reply.status(201).send({ ...rows[0], estimateTotals: totals });
  });

  app.patch(
    "/projects/:projectId/estimates/:estimateId/markups/:markupId",
    { preHandler: standardGate },
    async (req) => {
      const { estimateId, markupId } = req.params as { estimateId: string; markupId: string };
      const body = S.markupPatchSchema.parse(req.body);
      const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
      await guardEditable(req, estimate);
      const rows = await app.db
        .select()
        .from(estimateMarkups)
        .where(and(eq(estimateMarkups.id, markupId), eq(estimateMarkups.estimateId, estimate.id)))
        .limit(1);
      const markup = rows[0];
      if (!markup) throw notFound("Markup not found on this estimate");
      const patch: Record<string, unknown> = { updatedAt: nowIso() };
      for (const key of [
        "kind",
        "name",
        "method",
        "basis",
        "rate",
        "costTypes",
        "sectionIds",
        "quantity",
        "sequence",
        "rationale",
        "detail",
      ] as const) {
        const value = (body as Record<string, unknown>)[key];
        if (value !== undefined) patch[key] = value;
      }
      if (body.enabled !== undefined) patch["enabled"] = body.enabled ? 1 : 0;
      await app.db.update(estimateMarkups).set(patch).where(eq(estimateMarkups.id, markupId));
      const totals = await recomputeEstimate(app.db, estimate.id);
      await ledger(req, "update", "estimate_markup", markupId, {
        projectId: estimate.projectId,
        estimateId: estimate.id,
        name: markup.name,
        changed: Object.keys(patch).filter((k) => k !== "updatedAt"),
        estimateTotal: totals.total,
      });
      const after = await app.db
        .select()
        .from(estimateMarkups)
        .where(eq(estimateMarkups.id, markupId))
        .limit(1);
      return { ...after[0], estimateTotals: totals };
    },
  );

  app.delete(
    "/projects/:projectId/estimates/:estimateId/markups/:markupId",
    { preHandler: standardGate },
    async (req) => {
      const { estimateId, markupId } = req.params as { estimateId: string; markupId: string };
      const estimate = await fetchEstimate(app.db, estimateId, req.companyId!, req.projectId!);
      await guardEditable(req, estimate);
      const rows = await app.db
        .select()
        .from(estimateMarkups)
        .where(and(eq(estimateMarkups.id, markupId), eq(estimateMarkups.estimateId, estimate.id)))
        .limit(1);
      const markup = rows[0];
      if (!markup) throw notFound("Markup not found on this estimate");
      await app.db.delete(estimateMarkups).where(eq(estimateMarkups.id, markupId));
      const totals = await recomputeEstimate(app.db, estimate.id);
      await ledger(req, "delete", "estimate_markup", markupId, {
        projectId: estimate.projectId,
        estimateId: estimate.id,
        name: markup.name,
        amount: markup.amount,
        estimateTotal: totals.total,
      });
      return { id: markupId, deleted: true, estimateTotals: totals };
    },
  );
