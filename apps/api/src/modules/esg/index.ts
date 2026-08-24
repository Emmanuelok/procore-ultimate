import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, gte, ilike, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import {
  boqItems,
  boqs,
  carbonBudgets,
  carbonEntries,
  carbonFactors,
  evidence,
  projects,
  signals,
  socialValueCommitments,
  socialValueDeliveries,
  vendors,
  wasteRecords,
} from "@constructos/db";
import {
  CARBON_FACTOR_SOURCES,
  CARBON_MODULES,
  CARBON_SCOPES,
  SOCIAL_VALUE_THEMES,
  WASTE_DESTINATIONS,
  WASTE_STREAMS,
  type CarbonModule,
  type CarbonScope,
  type SocialValueTheme,
  type WasteDestination,
  type WasteStream,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isoDateSchema, todayISO } from "../field/dates.js";
import {
  DEFAULT_CARBON_FACTORS,
  SEED_FACTOR_SOURCE,
  budgetDrawdown,
  commitmentStatus,
  computeTco2e,
  csvEscape,
  factorFromEntry,
  percent,
  round2,
  round6,
  unitsMatch,
  wasteDiversion,
} from "./carbon.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const factorCreateSchema = z.object({
  name: z.string().min(1).max(300),
  materialCategory: z.string().max(200).nullable().optional(),
  unit: z.string().min(1).max(50),
  factorKgCo2ePerUnit: z.number().positive(),
  source: z.enum(CARBON_FACTOR_SOURCES),
  isProductSpecific: z.boolean().optional(),
  epdReference: z.string().max(300).nullable().optional(),
  validUntil: isoDateSchema.nullable().optional(),
});

const factorPatchSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  materialCategory: z.string().max(200).nullable().optional(),
  unit: z.string().min(1).max(50).optional(),
  factorKgCo2ePerUnit: z.number().positive().optional(),
  source: z.enum(CARBON_FACTOR_SOURCES).optional(),
  isProductSpecific: z.boolean().optional(),
  epdReference: z.string().max(300).nullable().optional(),
  validUntil: isoDateSchema.nullable().optional(),
});

const factorListQuery = pageQuerySchema.extend({
  search: z.string().max(200).optional(),
  source: z.enum(CARBON_FACTOR_SOURCES).optional(),
});

const budgetCreateSchema = z.object({
  name: z.string().min(1).max(300),
  element: z.string().max(200).nullable().optional(),
  baselineTco2e: z.number().nonnegative(),
  targetTco2e: z.number().positive(),
});

const budgetPatchSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  element: z.string().max(200).nullable().optional(),
  baselineTco2e: z.number().nonnegative().optional(),
  targetTco2e: z.number().positive().optional(),
});

const entryBase = {
  description: z.string().min(1).max(2000),
  lifecycleModule: z.enum(CARBON_MODULES),
  scope: z.enum(CARBON_SCOPES).nullable().optional(),
  factorId: z.string().min(1).nullable().optional(),
  /** kgCO2e per unit, used when nothing in the library fits */
  manualFactor: z.number().positive().optional(),
  quantity: z.number().positive(),
  unit: z.string().min(1).max(50),
  budgetId: z.string().min(1).nullable().optional(),
  boqItemId: z.string().min(1).nullable().optional(),
  sourceNote: z.string().max(2000).nullable().optional(),
  entryDate: isoDateSchema,
};

const entryCreateSchema = z
  .object(entryBase)
  .refine((b) => (b.factorId != null) !== (b.manualFactor != null), {
    message: "Provide exactly one of factorId or manualFactor",
    path: ["factorId"],
  });

const entryPatchSchema = z
  .object({
    description: entryBase.description.optional(),
    lifecycleModule: entryBase.lifecycleModule.optional(),
    scope: entryBase.scope,
    factorId: entryBase.factorId,
    manualFactor: entryBase.manualFactor,
    quantity: entryBase.quantity.optional(),
    unit: entryBase.unit.optional(),
    budgetId: entryBase.budgetId,
    boqItemId: entryBase.boqItemId,
    sourceNote: entryBase.sourceNote,
    entryDate: entryBase.entryDate.optional(),
  })
  .refine((b) => !(b.factorId != null && b.manualFactor != null), {
    message: "Provide at most one of factorId or manualFactor",
    path: ["factorId"],
  });

const entryListQuery = pageQuerySchema.extend({
  lifecycleModule: z.enum(CARBON_MODULES).optional(),
  scope: z.enum(CARBON_SCOPES).optional(),
  budgetId: z.string().min(1).optional(),
});

const fromBoqSchema = z.object({
  boqId: z.string().min(1),
  budgetId: z.string().min(1).nullable().optional(),
  mappings: z
    .array(
      z
        .object({
          boqItemId: z.string().min(1).optional(),
          boqItemCodePrefix: z.string().min(1).max(100).optional(),
          factorId: z.string().min(1),
        })
        .refine((m) => (m.boqItemId != null) !== (m.boqItemCodePrefix != null), {
          message: "Each mapping needs exactly one of boqItemId or boqItemCodePrefix",
        }),
    )
    .min(1)
    .max(500),
});

const wasteCreateSchema = z.object({
  recordDate: isoDateSchema,
  stream: z.enum(WASTE_STREAMS),
  destination: z.enum(WASTE_DESTINATIONS),
  tonnes: z.number().positive(),
  carrier: z.string().max(300).nullable().optional(),
  consignmentNote: z.string().max(200).nullable().optional(),
  cost: z.number().nonnegative().nullable().optional(),
});

const wasteListQuery = pageQuerySchema.extend({
  stream: z.enum(WASTE_STREAMS).optional(),
  destination: z.enum(WASTE_DESTINATIONS).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

const commitmentCreateSchema = z.object({
  theme: z.enum(SOCIAL_VALUE_THEMES),
  measureRef: z.string().max(100).nullable().optional(),
  description: z.string().min(1).max(5000),
  unit: z.string().min(1).max(50),
  targetValue: z.number().positive(),
  proxyValuePerUnit: z.number().nonnegative().nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  vendorId: z.string().min(1).nullable().optional(),
});

const deliveryCreateSchema = z.object({
  deliveryDate: isoDateSchema,
  value: z.number().positive(),
  note: z.string().max(5000).nullable().optional(),
  evidenceIds: z.array(z.string().min(1)).max(100).optional(),
});

const commitmentListQuery = pageQuerySchema.extend({
  theme: z.enum(SOCIAL_VALUE_THEMES).optional(),
});

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

type FactorRow = typeof carbonFactors.$inferSelect;
type EntryRow = typeof carbonEntries.$inferSelect;

/**
 * Carbon, ESG & social value — spec Vol II Domain I / module M18
 * (#491-498, #501, #505-508, #513-514, #527-540 subset).
 *
 * Embodied carbon to the EN 15978 life-cycle module split (#491-492) over a
 * tenant carbon factor library with product-specific/generic flagging
 * (#496-498), carbon budgets with drawdown and an exceedance signal
 * (#494-495), bulk entry generation straight off the BoQ so the carbon model
 * rides the commercial model (#501), GHG-Protocol scope reporting (#505-508),
 * waste by stream with diversion-from-landfill (#513-514), and UK Social
 * Value Model commitments reconciled tender-promise against delivery, with
 * proxy financial valuation and a shortfall signal (#527-540).
 */
export const esgModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("esg", "read")];
  const standardGate = [app.authenticate, app.requireCompany, app.requireTool("esg", "standard")];
  const adminGate = [app.authenticate, app.requireCompany, app.requireTool("esg", "admin")];
  /* The factor library is tenant reference data, not project data — it is
     gated on company membership rather than a project tool level. */
  const companyRead = [app.authenticate, app.requireCompany];
  const companyWrite = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin", "member"]),
  ];

  /* ---------------------------- Fetchers --------------------------- */

  async function fetchFactor(factorId: string, companyId: string): Promise<FactorRow> {
    const rows = await app.db
      .select()
      .from(carbonFactors)
      .where(and(eq(carbonFactors.id, factorId), eq(carbonFactors.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Carbon factor not found");
    return rows[0];
  }

  async function fetchBudget(budgetId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(carbonBudgets)
      .where(
        and(
          eq(carbonBudgets.id, budgetId),
          eq(carbonBudgets.companyId, companyId),
          eq(carbonBudgets.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Carbon budget not found");
    return rows[0];
  }

  async function fetchEntry(entryId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(carbonEntries)
      .where(
        and(
          eq(carbonEntries.id, entryId),
          eq(carbonEntries.companyId, companyId),
          eq(carbonEntries.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Carbon entry not found");
    return rows[0];
  }

  async function fetchCommitment(commitmentId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(socialValueCommitments)
      .where(
        and(
          eq(socialValueCommitments.id, commitmentId),
          eq(socialValueCommitments.companyId, companyId),
          eq(socialValueCommitments.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Social value commitment not found");
    return rows[0];
  }

  /* ---------------------------- Validators ------------------------- */

  async function validateEvidence(companyId: string, projectId: string, ids: string[]) {
    if (ids.length === 0) return;
    const unique = [...new Set(ids)];
    const rows = await app.db
      .select({ id: evidence.id })
      .from(evidence)
      .where(
        and(
          inArray(evidence.id, unique),
          eq(evidence.companyId, companyId),
          eq(evidence.projectId, projectId),
        ),
      );
    if (rows.length !== unique.length) {
      throw badRequest("evidenceIds must reference evidence records in this project");
    }
  }

  async function validateVendor(companyId: string, vendorId: string) {
    const rows = await app.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw badRequest("vendorId must reference a vendor in this company");
  }

  /** A BoQ item is in-project only via its bill — boq_items carry no tenant columns. */
  async function validateBoqItem(companyId: string, projectId: string, boqItemId: string) {
    const rows = await app.db
      .select({ id: boqItems.id })
      .from(boqItems)
      .innerJoin(boqs, eq(boqItems.boqId, boqs.id))
      .where(
        and(
          eq(boqItems.id, boqItemId),
          eq(boqs.companyId, companyId),
          eq(boqs.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw badRequest("boqItemId must reference a BoQ item in this project");
  }

  /* ---------------------------- Views ------------------------------ */

  async function factorMapFor(entries: EntryRow[]): Promise<Map<string, FactorRow>> {
    const ids = [...new Set(entries.map((e) => e.factorId).filter((v): v is string => !!v))];
    if (ids.length === 0) return new Map();
    const rows = await app.db
      .select()
      .from(carbonFactors)
      .where(inArray(carbonFactors.id, ids));
    return new Map(rows.map((f) => [f.id, f]));
  }

  function entryView(entry: EntryRow, factors: Map<string, FactorRow>) {
    const factor = entry.factorId ? factors.get(entry.factorId) : undefined;
    return {
      ...entry,
      factorName: factor?.name ?? null,
      factorKgCo2ePerUnit: factor
        ? factor.factorKgCo2ePerUnit
        : factorFromEntry(entry.quantity, entry.tco2e),
      factorSource: factor?.source ?? "manual",
      isProductSpecific: factor ? factor.isProductSpecific === 1 : false,
    };
  }

  /** Σ tCO2e per budget id for a project (entries with no budget are excluded). */
  async function budgetActuals(
    companyId: string,
    projectId: string,
  ): Promise<Map<string, number>> {
    const rows = await app.db
      .select({ budgetId: carbonEntries.budgetId, tco2e: carbonEntries.tco2e })
      .from(carbonEntries)
      .where(
        and(eq(carbonEntries.companyId, companyId), eq(carbonEntries.projectId, projectId)),
      );
    const out = new Map<string, number>();
    for (const r of rows) {
      if (!r.budgetId) continue;
      out.set(r.budgetId, (out.get(r.budgetId) ?? 0) + r.tco2e);
    }
    for (const [k, v] of out) out.set(k, round6(v));
    return out;
  }

  /* ---------------------------- Sweeps ------------------------------ */

  /**
   * Lazy carbon-budget exceedance sweep (#495). A budget has no status
   * column — its state is derived from the entries booked against it — so
   * the once-only guard is a lookup of the existing signal by budget id in
   * `evidenceRefs` rather than a status flip. Runs on every budget read and
   * after every entry mutation, exactly like the finance overdue sweep.
   */
  async function sweepBudgets(companyId: string, projectId: string, actorId: string) {
    const budgets = await app.db
      .select()
      .from(carbonBudgets)
      .where(and(eq(carbonBudgets.companyId, companyId), eq(carbonBudgets.projectId, projectId)));
    if (budgets.length === 0) return;
    const actuals = await budgetActuals(companyId, projectId);
    const exceeded = budgets.filter(
      (b) => budgetDrawdown(actuals.get(b.id) ?? 0, b.targetTco2e).status === "exceeded",
    );
    if (exceeded.length === 0) return;
    const raised = await app.db
      .select({ evidenceRefs: signals.evidenceRefs })
      .from(signals)
      .where(
        and(
          eq(signals.companyId, companyId),
          eq(signals.projectId, projectId),
          eq(signals.detector, "carbon_budget_exceeded"),
        ),
      );
    const already = new Set(
      raised
        .map((r) => (r.evidenceRefs as { budgetId?: string } | null)?.budgetId)
        .filter((v): v is string => !!v),
    );
    for (const b of exceeded) {
      if (already.has(b.id)) continue;
      const actual = actuals.get(b.id) ?? 0;
      const { drawdownPercent, remaining } = budgetDrawdown(actual, b.targetTco2e);
      await app.db.insert(signals).values({
        id: newId("sig"),
        companyId,
        projectId,
        detector: "carbon_budget_exceeded",
        severity: "medium",
        confidence: 1,
        title: `Carbon budget exceeded — ${b.name} (${drawdownPercent}% of target)`,
        explanation:
          `Entries booked against carbon budget "${b.name}"${b.element ? ` (${b.element})` : ""} ` +
          `total ${round6(actual)} tCO2e against a target of ${b.targetTco2e} tCO2e — an overrun ` +
          `of ${round6(-remaining)} tCO2e (${drawdownPercent}% drawdown). The baseline for this ` +
          `element was ${b.baselineTco2e} tCO2e. Reduction against the target is no longer ` +
          `achievable by omission alone; a design or specification change is required, or the ` +
          `target must be formally revised and the revision recorded.`,
        evidenceRefs: { budgetId: b.id, targetTco2e: b.targetTco2e, actualTco2e: round6(actual) },
      });
      await appendLedger(app.db, {
        companyId,
        actorId,
        action: "state_change",
        objectType: "carbon_budget",
        objectId: b.id,
        payload: { status: "exceeded", actualTco2e: round6(actual), targetTco2e: b.targetTco2e },
      });
    }
  }

  /**
   * Lazy social-value status sweep (#539-540). Commitment status is partly a
   * function of the calendar, so it cannot only be recomputed on delivery:
   * a commitment nobody ever delivered against must still fall into
   * `at_risk` and then `shortfall` on its own. The shortfall signal is
   * guarded on the status flip itself, so it fires exactly once.
   */
  async function sweepCommitments(companyId: string, projectId: string, actorId: string) {
    const rows = await app.db
      .select()
      .from(socialValueCommitments)
      .where(
        and(
          eq(socialValueCommitments.companyId, companyId),
          eq(socialValueCommitments.projectId, projectId),
        ),
      );
    const today = todayISO();
    for (const c of rows) {
      const next = commitmentStatus(c.deliveredValue, c.targetValue, c.dueDate, today);
      if (next === c.status) continue;
      await app.db
        .update(socialValueCommitments)
        .set({ status: next, updatedAt: new Date().toISOString() })
        .where(
          and(eq(socialValueCommitments.id, c.id), eq(socialValueCommitments.status, c.status)),
        );
      if (next === "shortfall") {
        const shortfall = round2(c.targetValue - c.deliveredValue);
        const proxyGap =
          c.proxyValuePerUnit != null ? round2(shortfall * c.proxyValuePerUnit) : null;
        await app.db.insert(signals).values({
          id: newId("sig"),
          companyId,
          projectId,
          detector: "social_value_shortfall",
          severity: "medium",
          confidence: 1,
          title: `Social value shortfall — SV-${String(c.number).padStart(4, "0")}: ${c.description.slice(0, 90)}`,
          explanation:
            `Commitment SV-${String(c.number).padStart(4, "0")} ("${c.description}") promised ` +
            `${c.targetValue} ${c.unit} by ${c.dueDate}. ${c.deliveredValue} ${c.unit} have been ` +
            `evidenced — a shortfall of ${shortfall} ${c.unit} ` +
            `(${percent(c.deliveredValue, c.targetValue)}% delivered), now more than 30 days past ` +
            `the due date.` +
            (proxyGap != null ? ` Proxy financial value not delivered: ${proxyGap}.` : "") +
            ` Tender commitments are scored obligations: an unremediated shortfall is a ` +
            `contract-performance issue and, on UK public work, a disclosable one.`,
          evidenceRefs: { commitmentId: c.id, shortfall, dueDate: c.dueDate },
        });
      }
      await appendLedger(app.db, {
        companyId,
        actorId,
        action: "state_change",
        objectType: "social_value_commitment",
        objectId: c.id,
        payload: { from: c.status, to: next, deliveredValue: c.deliveredValue },
      });
    }
  }

  function commitmentView(c: typeof socialValueCommitments.$inferSelect) {
    const progressPercent = percent(c.deliveredValue, c.targetValue);
    return {
      ...c,
      progressPercent,
      remainingValue: round2(Math.max(0, c.targetValue - c.deliveredValue)),
      proxyValueCommitted:
        c.proxyValuePerUnit != null ? round2(c.targetValue * c.proxyValuePerUnit) : null,
      proxyValueDelivered:
        c.proxyValuePerUnit != null ? round2(c.deliveredValue * c.proxyValuePerUnit) : null,
    };
  }

  /* ================================================================== */
  /* Carbon factor library (#496-498)                                   */
  /* ================================================================== */

  app.post("/carbon-factors", { preHandler: companyWrite }, async (req, reply) => {
    const body = factorCreateSchema.parse(req.body);
    const id = newId("cfa");
    await app.db.insert(carbonFactors).values({
      id,
      companyId: req.companyId!,
      name: body.name,
      materialCategory: body.materialCategory ?? null,
      unit: body.unit,
      factorKgCo2ePerUnit: body.factorKgCo2ePerUnit,
      source: body.source,
      isProductSpecific: body.isProductSpecific ? 1 : 0,
      epdReference: body.epdReference ?? null,
      validUntil: body.validUntil ?? null,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "carbon_factor",
      objectId: id,
      payload: {
        name: body.name,
        unit: body.unit,
        factorKgCo2ePerUnit: body.factorKgCo2ePerUnit,
        source: body.source,
        isProductSpecific: body.isProductSpecific ? 1 : 0,
      },
      storePayload: true,
    });
    return reply.status(201).send(await fetchFactor(id, req.companyId!));
  });

  /**
   * Seed the starter factor set (#496). Idempotent by name: re-running adds
   * only what is missing, so it is safe to call on every project kickoff.
   * See DEFAULT_CARBON_FACTORS for the health warning that goes with them.
   */
  app.post("/carbon-factors/seed-defaults", { preHandler: companyWrite }, async (req, reply) => {
    const existing = await app.db
      .select({ name: carbonFactors.name })
      .from(carbonFactors)
      .where(eq(carbonFactors.companyId, req.companyId!));
    const have = new Set(existing.map((f) => f.name));
    const created: string[] = [];
    const skipped: string[] = [];
    for (const f of DEFAULT_CARBON_FACTORS) {
      if (have.has(f.name)) {
        skipped.push(f.name);
        continue;
      }
      const id = newId("cfa");
      await app.db.insert(carbonFactors).values({
        id,
        companyId: req.companyId!,
        name: f.name,
        materialCategory: f.materialCategory,
        unit: f.unit,
        factorKgCo2ePerUnit: f.factorKgCo2ePerUnit,
        source: SEED_FACTOR_SOURCE,
        isProductSpecific: 0,
        epdReference: null,
        validUntil: null,
      });
      created.push(id);
    }
    if (created.length > 0) {
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "carbon_factor_seed",
        objectId: req.companyId!,
        payload: { created: created.length, skipped: skipped.length },
        storePayload: true,
      });
    }
    return reply.status(201).send({
      created: created.length,
      skipped: skipped.length,
      total: DEFAULT_CARBON_FACTORS.length,
      warning:
        "Seeded factors are indicative published-order values, not a licensed dataset. " +
        "Replace them with a verified dataset or product EPDs before contractual reporting.",
    });
  });

  app.get("/carbon-factors", { preHandler: companyRead }, async (req) => {
    const q = factorListQuery.parse(req.query);
    const conds = [eq(carbonFactors.companyId, req.companyId!)];
    if (q.search) conds.push(ilike(carbonFactors.name, `%${q.search}%`));
    if (q.source) conds.push(eq(carbonFactors.source, q.source));
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(carbonFactors).where(where);
    const rows = await app.db
      .select()
      .from(carbonFactors)
      .where(where)
      .orderBy(asc(carbonFactors.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, Number(totalRow?.n ?? 0), q);
  });

  app.get("/carbon-factors/:factorId", { preHandler: companyRead }, async (req) => {
    const { factorId } = req.params as { factorId: string };
    const factor = await fetchFactor(factorId, req.companyId!);
    const [usage] = await app.db
      .select({ n: count() })
      .from(carbonEntries)
      .where(eq(carbonEntries.factorId, factorId));
    return { ...factor, usageCount: Number(usage?.n ?? 0) };
  });

  /** How many entries pin this factor — a factor in use is immutable. */
  async function factorUsage(factorId: string): Promise<number> {
    const [row] = await app.db
      .select({ n: count() })
      .from(carbonEntries)
      .where(eq(carbonEntries.factorId, factorId));
    return Number(row?.n ?? 0);
  }

  app.patch("/carbon-factors/:factorId", { preHandler: companyWrite }, async (req) => {
    const { factorId } = req.params as { factorId: string };
    const body = factorPatchSchema.parse(req.body);
    await fetchFactor(factorId, req.companyId!);
    // Editing a factor already used would silently restate published tCO2e
    // figures. Supersede it with a new factor instead.
    const used = await factorUsage(factorId);
    if (used > 0) {
      throw conflict(
        `This factor is referenced by ${used} carbon entr${used === 1 ? "y" : "ies"} and cannot be edited — create a superseding factor instead`,
      );
    }
    const set: Record<string, unknown> = {};
    if (body.name !== undefined) set["name"] = body.name;
    if (body.materialCategory !== undefined) set["materialCategory"] = body.materialCategory;
    if (body.unit !== undefined) set["unit"] = body.unit;
    if (body.factorKgCo2ePerUnit !== undefined) {
      set["factorKgCo2ePerUnit"] = body.factorKgCo2ePerUnit;
    }
    if (body.source !== undefined) set["source"] = body.source;
    if (body.isProductSpecific !== undefined) {
      set["isProductSpecific"] = body.isProductSpecific ? 1 : 0;
    }
    if (body.epdReference !== undefined) set["epdReference"] = body.epdReference;
    if (body.validUntil !== undefined) set["validUntil"] = body.validUntil;
    if (Object.keys(set).length > 0) {
      await app.db.update(carbonFactors).set(set).where(eq(carbonFactors.id, factorId));
    }
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "carbon_factor",
      objectId: factorId,
      payload: { changed: Object.keys(body) },
    });
    return fetchFactor(factorId, req.companyId!);
  });

  app.delete("/carbon-factors/:factorId", { preHandler: companyWrite }, async (req, reply) => {
    const { factorId } = req.params as { factorId: string };
    await fetchFactor(factorId, req.companyId!);
    const used = await factorUsage(factorId);
    if (used > 0) {
      throw conflict(
        `This factor is referenced by ${used} carbon entr${used === 1 ? "y" : "ies"} and cannot be deleted`,
      );
    }
    await app.db.delete(carbonFactors).where(eq(carbonFactors.id, factorId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "carbon_factor",
      objectId: factorId,
    });
    return reply.status(204).send();
  });

  /* ================================================================== */
  /* Carbon budgets (#494-495)                                          */
  /* ================================================================== */

  app.post("/projects/:projectId/carbon-budgets", { preHandler: standardGate }, async (req, reply) => {
    const body = budgetCreateSchema.parse(req.body);
    const id = newId("cbd");
    await app.db.insert(carbonBudgets).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      name: body.name,
      element: body.element ?? null,
      baselineTco2e: body.baselineTco2e,
      targetTco2e: body.targetTco2e,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "carbon_budget",
      objectId: id,
      payload: {
        name: body.name,
        element: body.element ?? null,
        baselineTco2e: body.baselineTco2e,
        targetTco2e: body.targetTco2e,
      },
      storePayload: true,
    });
    const created = await fetchBudget(id, req.companyId!, req.projectId!);
    return reply.status(201).send({
      ...created,
      actualTco2e: 0,
      ...budgetDrawdown(0, created.targetTco2e),
      reductionFromBaselinePercent: percent(
        created.baselineTco2e - created.targetTco2e,
        created.baselineTco2e,
      ),
    });
  });

  app.get("/projects/:projectId/carbon-budgets", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    await sweepBudgets(req.companyId!, req.projectId!, req.user!.id);
    const where = and(
      eq(carbonBudgets.companyId, req.companyId!),
      eq(carbonBudgets.projectId, req.projectId!),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(carbonBudgets).where(where);
    const rows = await app.db
      .select()
      .from(carbonBudgets)
      .where(where)
      .orderBy(asc(carbonBudgets.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const actuals = await budgetActuals(req.companyId!, req.projectId!);
    const items = rows.map((b) => {
      const actualTco2e = actuals.get(b.id) ?? 0;
      return {
        ...b,
        actualTco2e,
        ...budgetDrawdown(actualTco2e, b.targetTco2e),
        reductionFromBaselinePercent: percent(b.baselineTco2e - b.targetTco2e, b.baselineTco2e),
      };
    });
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get(
    "/projects/:projectId/carbon-budgets/:budgetId",
    { preHandler: readGate },
    async (req) => {
      const { budgetId } = req.params as { budgetId: string };
      const budget = await fetchBudget(budgetId, req.companyId!, req.projectId!);
      await sweepBudgets(req.companyId!, req.projectId!, req.user!.id);
      const actuals = await budgetActuals(req.companyId!, req.projectId!);
      const actualTco2e = actuals.get(budgetId) ?? 0;
      const entries = await app.db
        .select()
        .from(carbonEntries)
        .where(eq(carbonEntries.budgetId, budgetId))
        .orderBy(desc(carbonEntries.entryDate));
      const factors = await factorMapFor(entries);
      return {
        ...budget,
        actualTco2e,
        ...budgetDrawdown(actualTco2e, budget.targetTco2e),
        reductionFromBaselinePercent: percent(
          budget.baselineTco2e - budget.targetTco2e,
          budget.baselineTco2e,
        ),
        entries: entries.map((e) => entryView(e, factors)),
      };
    },
  );

  app.patch(
    "/projects/:projectId/carbon-budgets/:budgetId",
    { preHandler: standardGate },
    async (req) => {
      const { budgetId } = req.params as { budgetId: string };
      const body = budgetPatchSchema.parse(req.body);
      const budget = await fetchBudget(budgetId, req.companyId!, req.projectId!);
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      if (body.name !== undefined) set["name"] = body.name;
      if (body.element !== undefined) set["element"] = body.element;
      if (body.baselineTco2e !== undefined) set["baselineTco2e"] = body.baselineTco2e;
      if (body.targetTco2e !== undefined) set["targetTco2e"] = body.targetTco2e;
      await app.db.update(carbonBudgets).set(set).where(eq(carbonBudgets.id, budgetId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "carbon_budget",
        objectId: budgetId,
        payload: {
          changed: Object.keys(body),
          targetFrom: budget.targetTco2e,
          targetTo: body.targetTco2e ?? budget.targetTco2e,
        },
        storePayload: true,
      });
      await sweepBudgets(req.companyId!, req.projectId!, req.user!.id);
      const updated = await fetchBudget(budgetId, req.companyId!, req.projectId!);
      const actuals = await budgetActuals(req.companyId!, req.projectId!);
      const actualTco2e = actuals.get(budgetId) ?? 0;
      return {
        ...updated,
        actualTco2e,
        ...budgetDrawdown(actualTco2e, updated.targetTco2e),
        reductionFromBaselinePercent: percent(
          updated.baselineTco2e - updated.targetTco2e,
          updated.baselineTco2e,
        ),
      };
    },
  );

  app.delete(
    "/projects/:projectId/carbon-budgets/:budgetId",
    { preHandler: adminGate },
    async (req, reply) => {
      const { budgetId } = req.params as { budgetId: string };
      await fetchBudget(budgetId, req.companyId!, req.projectId!);
      const [row] = await app.db
        .select({ n: count() })
        .from(carbonEntries)
        .where(eq(carbonEntries.budgetId, budgetId));
      const used = Number(row?.n ?? 0);
      if (used > 0) {
        throw conflict(
          `This budget has ${used} carbon entr${used === 1 ? "y" : "ies"} booked against it and cannot be deleted`,
        );
      }
      await app.db.delete(carbonBudgets).where(eq(carbonBudgets.id, budgetId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "carbon_budget",
        objectId: budgetId,
      });
      return reply.status(204).send();
    },
  );

  /* ================================================================== */
  /* Carbon entries (#491-492, #501)                                    */
  /* ================================================================== */

  /**
   * Resolve the kgCO2e-per-unit figure an entry should be written with, and
   * enforce the unit contract: a factor published per kilogram cannot be
   * applied to a quantity measured in cubic metres. The 400 names both units
   * and the factor, because "unit mismatch" alone is useless at 2am.
   */
  async function resolveFactor(
    companyId: string,
    opts: { factorId?: string | null; manualFactor?: number; unit: string },
  ): Promise<{ value: number; factorId: string | null }> {
    if (opts.factorId) {
      const factor = await fetchFactor(opts.factorId, companyId);
      if (!unitsMatch(factor.unit, opts.unit)) {
        throw badRequest(
          `Unit mismatch: the entry is measured in "${opts.unit}" but factor "${factor.name}" is published per "${factor.unit}". Convert the quantity or pick a factor in "${opts.unit}".`,
        );
      }
      return { value: factor.factorKgCo2ePerUnit, factorId: factor.id };
    }
    return { value: opts.manualFactor!, factorId: null };
  }

  app.post(
    "/projects/:projectId/carbon-entries",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = entryCreateSchema.parse(req.body);
      if (body.budgetId) await fetchBudget(body.budgetId, req.companyId!, req.projectId!);
      if (body.boqItemId) {
        await validateBoqItem(req.companyId!, req.projectId!, body.boqItemId);
      }
      const factor = await resolveFactor(req.companyId!, {
        factorId: body.factorId,
        manualFactor: body.manualFactor,
        unit: body.unit,
      });
      const tco2e = computeTco2e(body.quantity, factor.value);
      const id = newId("cen");
      await app.db.insert(carbonEntries).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        budgetId: body.budgetId ?? null,
        description: body.description,
        lifecycleModule: body.lifecycleModule,
        scope: body.scope ?? null,
        factorId: factor.factorId,
        quantity: body.quantity,
        unit: body.unit,
        tco2e,
        boqItemId: body.boqItemId ?? null,
        sourceNote: body.sourceNote ?? null,
        entryDate: body.entryDate,
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "carbon_entry",
        objectId: id,
        payload: {
          description: body.description,
          lifecycleModule: body.lifecycleModule,
          scope: body.scope ?? null,
          factorId: factor.factorId,
          factorKgCo2ePerUnit: factor.value,
          quantity: body.quantity,
          unit: body.unit,
          tco2e,
          budgetId: body.budgetId ?? null,
          boqItemId: body.boqItemId ?? null,
        },
        storePayload: true,
      });
      await sweepBudgets(req.companyId!, req.projectId!, req.user!.id);
      const created = await fetchEntry(id, req.companyId!, req.projectId!);
      return reply.status(201).send(entryView(created, await factorMapFor([created])));
    },
  );

  /**
   * Bulk generation from the Bill of Quantities (#501). Each mapping names a
   * factor and either an exact BoQ item or a code prefix; measured items
   * carrying a quantity are turned into A1-A3 / scope 3 entries with the BoQ
   * item recorded as provenance. Items that cannot be converted are SKIPPED
   * AND REPORTED, never silently guessed — a carbon figure with no quantity
   * behind it is worse than a missing one.
   */
  app.post(
    "/projects/:projectId/carbon-entries/from-boq",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = fromBoqSchema.parse(req.body);
      const boqRows = await app.db
        .select()
        .from(boqs)
        .where(
          and(
            eq(boqs.id, body.boqId),
            eq(boqs.companyId, req.companyId!),
            eq(boqs.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const boq = boqRows[0];
      if (!boq) throw notFound("BoQ not found");
      if (body.budgetId) await fetchBudget(body.budgetId, req.companyId!, req.projectId!);

      const factorIds = [...new Set(body.mappings.map((m) => m.factorId))];
      const factorRows = await app.db
        .select()
        .from(carbonFactors)
        .where(
          and(
            inArray(carbonFactors.id, factorIds),
            eq(carbonFactors.companyId, req.companyId!),
          ),
        );
      const factorById = new Map(factorRows.map((f) => [f.id, f]));
      const missing = factorIds.filter((id) => !factorById.has(id));
      if (missing.length > 0) {
        throw badRequest(`Unknown carbon factor(s): ${missing.join(", ")}`);
      }

      const items = await app.db
        .select()
        .from(boqItems)
        .where(eq(boqItems.boqId, boq.id))
        .orderBy(asc(boqItems.path), asc(boqItems.sortOrder));

      const created: string[] = [];
      const skipped: { boqItemId: string; code: string; reason: string; detail: string }[] = [];
      let totalTco2e = 0;

      for (const item of items) {
        const mapping =
          body.mappings.find((m) => m.boqItemId === item.id) ??
          body.mappings.find(
            (m) => m.boqItemCodePrefix != null && item.code.startsWith(m.boqItemCodePrefix),
          );
        if (!mapping) continue; // out of scope for this run — not a skip
        const factor = factorById.get(mapping.factorId)!;
        if (item.quantity == null || item.quantity <= 0) {
          skipped.push({
            boqItemId: item.id,
            code: item.code,
            reason: "no_quantity",
            detail: "The BoQ item carries no measured quantity",
          });
          continue;
        }
        if (item.unit == null) {
          skipped.push({
            boqItemId: item.id,
            code: item.code,
            reason: "no_unit",
            detail: "The BoQ item carries no unit of measurement",
          });
          continue;
        }
        if (!unitsMatch(item.unit, factor.unit)) {
          skipped.push({
            boqItemId: item.id,
            code: item.code,
            reason: "unit_mismatch",
            detail: `BoQ item is measured in "${item.unit}" but factor "${factor.name}" is published per "${factor.unit}"`,
          });
          continue;
        }
        const tco2e = computeTco2e(item.quantity, factor.factorKgCo2ePerUnit);
        const id = newId("cen");
        await app.db.insert(carbonEntries).values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          budgetId: body.budgetId ?? null,
          description: item.description,
          // Material quantities taken off the bill are cradle-to-gate product
          // stage, and purchased goods and services in GHG-Protocol terms.
          lifecycleModule: "A1-A3",
          scope: "scope_3",
          factorId: factor.id,
          quantity: item.quantity,
          unit: item.unit,
          tco2e,
          boqItemId: item.id,
          sourceNote: `BoQ ${boq.name} item ${item.code}`,
          entryDate: todayISO(),
          createdBy: req.user!.id,
        });
        created.push(id);
        totalTco2e += tco2e;
      }

      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "carbon_entry_bulk",
        objectId: boq.id,
        payload: {
          boqId: boq.id,
          budgetId: body.budgetId ?? null,
          created: created.length,
          skipped: skipped.map((s) => ({ code: s.code, reason: s.reason })),
          totalTco2e: round6(totalTco2e),
        },
        storePayload: true,
      });
      await sweepBudgets(req.companyId!, req.projectId!, req.user!.id);
      return reply.status(201).send({
        boqId: boq.id,
        created: created.length,
        createdIds: created,
        skipped,
        totalTco2e: round6(totalTco2e),
      });
    },
  );

  app.get("/projects/:projectId/carbon-entries", { preHandler: readGate }, async (req) => {
    const q = entryListQuery.parse(req.query);
    const conds = [
      eq(carbonEntries.companyId, req.companyId!),
      eq(carbonEntries.projectId, req.projectId!),
    ];
    if (q.lifecycleModule) conds.push(eq(carbonEntries.lifecycleModule, q.lifecycleModule));
    if (q.scope) conds.push(eq(carbonEntries.scope, q.scope));
    if (q.budgetId) conds.push(eq(carbonEntries.budgetId, q.budgetId));
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(carbonEntries).where(where);
    const rows = await app.db
      .select()
      .from(carbonEntries)
      .where(where)
      .orderBy(desc(carbonEntries.entryDate), desc(carbonEntries.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const factors = await factorMapFor(rows);
    return paginate(
      rows.map((e) => entryView(e, factors)),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.patch(
    "/projects/:projectId/carbon-entries/:entryId",
    { preHandler: standardGate },
    async (req) => {
      const { entryId } = req.params as { entryId: string };
      const body = entryPatchSchema.parse(req.body);
      const entry = await fetchEntry(entryId, req.companyId!, req.projectId!);
      if (body.budgetId) await fetchBudget(body.budgetId, req.companyId!, req.projectId!);
      if (body.boqItemId) {
        await validateBoqItem(req.companyId!, req.projectId!, body.boqItemId);
      }
      const quantity = body.quantity ?? entry.quantity;
      const unit = body.unit ?? entry.unit;
      // Factor resolution order: an explicit new factor, an explicit manual
      // figure, the factor already on the entry (re-checked against the unit
      // in case the unit changed), else the manual figure recovered from the
      // stored tCO2e.
      let resolved: { value: number; factorId: string | null };
      if (body.factorId) {
        resolved = await resolveFactor(req.companyId!, { factorId: body.factorId, unit });
      } else if (body.manualFactor != null) {
        resolved = { value: body.manualFactor, factorId: null };
      } else if (body.factorId === null) {
        resolved = { value: factorFromEntry(entry.quantity, entry.tco2e), factorId: null };
      } else if (entry.factorId) {
        resolved = await resolveFactor(req.companyId!, { factorId: entry.factorId, unit });
      } else {
        resolved = { value: factorFromEntry(entry.quantity, entry.tco2e), factorId: null };
      }
      const tco2e = computeTco2e(quantity, resolved.value);
      const set: Record<string, unknown> = {
        quantity,
        unit,
        tco2e,
        factorId: resolved.factorId,
      };
      if (body.description !== undefined) set["description"] = body.description;
      if (body.lifecycleModule !== undefined) set["lifecycleModule"] = body.lifecycleModule;
      if (body.scope !== undefined) set["scope"] = body.scope;
      if (body.budgetId !== undefined) set["budgetId"] = body.budgetId;
      if (body.boqItemId !== undefined) set["boqItemId"] = body.boqItemId;
      if (body.sourceNote !== undefined) set["sourceNote"] = body.sourceNote;
      if (body.entryDate !== undefined) set["entryDate"] = body.entryDate;
      await app.db.update(carbonEntries).set(set).where(eq(carbonEntries.id, entryId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "carbon_entry",
        objectId: entryId,
        payload: {
          changed: Object.keys(body),
          tco2eFrom: entry.tco2e,
          tco2eTo: tco2e,
          factorKgCo2ePerUnit: resolved.value,
        },
        storePayload: true,
      });
      await sweepBudgets(req.companyId!, req.projectId!, req.user!.id);
      const updated = await fetchEntry(entryId, req.companyId!, req.projectId!);
      return entryView(updated, await factorMapFor([updated]));
    },
  );

  app.delete(
    "/projects/:projectId/carbon-entries/:entryId",
    { preHandler: standardGate },
    async (req, reply) => {
      const { entryId } = req.params as { entryId: string };
      const entry = await fetchEntry(entryId, req.companyId!, req.projectId!);
      await app.db.delete(carbonEntries).where(eq(carbonEntries.id, entryId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "carbon_entry",
        objectId: entryId,
        payload: { tco2e: entry.tco2e, budgetId: entry.budgetId },
        storePayload: true,
      });
      return reply.status(204).send();
    },
  );

  /* ================================================================== */
  /* Carbon reporting (#491-492, #498, #505-508)                        */
  /* ================================================================== */

  /** Everything the summary and the CSV both need, computed once. */
  async function carbonRollup(companyId: string, projectId: string) {
    const entries = await app.db
      .select()
      .from(carbonEntries)
      .where(and(eq(carbonEntries.companyId, companyId), eq(carbonEntries.projectId, projectId)))
      .orderBy(asc(carbonEntries.lifecycleModule), asc(carbonEntries.entryDate));
    const factors = await factorMapFor(entries);
    const total = entries.reduce((s, e) => s + e.tco2e, 0);

    const byModule = Object.fromEntries(CARBON_MODULES.map((m) => [m, 0])) as Record<
      CarbonModule,
      number
    >;
    const byScope = Object.fromEntries(CARBON_SCOPES.map((s) => [s, 0])) as Record<
      CarbonScope | "unscoped",
      number
    >;
    byScope["unscoped"] = 0;
    let productSpecific = 0;
    for (const e of entries) {
      byModule[e.lifecycleModule as CarbonModule] =
        (byModule[e.lifecycleModule as CarbonModule] ?? 0) + e.tco2e;
      const key = (e.scope ?? "unscoped") as CarbonScope | "unscoped";
      byScope[key] = (byScope[key] ?? 0) + e.tco2e;
      const f = e.factorId ? factors.get(e.factorId) : undefined;
      if (f && f.isProductSpecific === 1) productSpecific += e.tco2e;
    }
    for (const k of Object.keys(byModule) as CarbonModule[]) byModule[k] = round6(byModule[k]);
    for (const k of Object.keys(byScope) as (CarbonScope | "unscoped")[]) {
      byScope[k] = round6(byScope[k]);
    }
    return { entries, factors, total: round6(total), byModule, byScope, productSpecific };
  }

  app.get("/projects/:projectId/carbon/summary", { preHandler: readGate }, async (req) => {
    await sweepBudgets(req.companyId!, req.projectId!, req.user!.id);
    const roll = await carbonRollup(req.companyId!, req.projectId!);
    const budgets = await app.db
      .select()
      .from(carbonBudgets)
      .where(
        and(
          eq(carbonBudgets.companyId, req.companyId!),
          eq(carbonBudgets.projectId, req.projectId!),
        ),
      )
      .orderBy(asc(carbonBudgets.name));
    const actuals = await budgetActuals(req.companyId!, req.projectId!);
    const budgetItems = budgets.map((b) => {
      const actualTco2e = actuals.get(b.id) ?? 0;
      return {
        id: b.id,
        name: b.name,
        element: b.element,
        baselineTco2e: b.baselineTco2e,
        targetTco2e: b.targetTco2e,
        actualTco2e,
        ...budgetDrawdown(actualTco2e, b.targetTco2e),
      };
    });
    const budgetTarget = round6(budgets.reduce((s, b) => s + b.targetTco2e, 0));
    const budgetActual = round6(budgetItems.reduce((s, b) => s + b.actualTco2e, 0));

    const projectRows = await app.db
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, req.projectId!))
      .limit(1);
    const giaRaw = (projectRows[0]?.settings as Record<string, unknown> | undefined)?.["gia"];
    const gia = typeof giaRaw === "number" && giaRaw > 0 ? giaRaw : null;

    return {
      totalTco2e: roll.total,
      entryCount: roll.entries.length,
      byModule: roll.byModule,
      byScope: roll.byScope,
      /**
       * #498 — the share of the reported footprint standing on a
       * product-specific EPD rather than a generic library figure. A low
       * number is not an error; it is the honest maturity of the assessment.
       */
      productSpecificSharePercent: percent(roll.productSpecific, roll.total),
      productSpecificTco2e: round6(roll.productSpecific),
      budgets: {
        count: budgets.length,
        baselineTco2e: round6(budgets.reduce((s, b) => s + b.baselineTco2e, 0)),
        targetTco2e: budgetTarget,
        actualTco2e: budgetActual,
        remaining: round6(budgetTarget - budgetActual),
        drawdownPercent: percent(budgetActual, budgetTarget),
        byStatus: {
          on_track: budgetItems.filter((b) => b.status === "on_track").length,
          at_risk: budgetItems.filter((b) => b.status === "at_risk").length,
          exceeded: budgetItems.filter((b) => b.status === "exceeded").length,
        },
        items: budgetItems,
      },
      /** kgCO2e per m² GIA — the RICS reporting unit. Null until GIA is set. */
      gia,
      intensityPerSqm: gia ? round2((roll.total * 1000) / gia) : null,
      /** Unattributed emissions are as material as attributed ones. */
      unbudgetedTco2e: round6(
        roll.entries.filter((e) => !e.budgetId).reduce((s, e) => s + e.tco2e, 0),
      ),
    };
  });

  app.get("/projects/:projectId/carbon/report.csv", { preHandler: readGate }, async (req, reply) => {
    const roll = await carbonRollup(req.companyId!, req.projectId!);
    const lines = [
      "module,scope,description,quantity,unit,factor_kgco2e_per_unit,tco2e",
      ...roll.entries.map((e) => {
        const view = entryView(e, roll.factors);
        return [
          e.lifecycleModule,
          e.scope ?? "",
          e.description,
          e.quantity,
          e.unit,
          view.factorKgCo2ePerUnit,
          e.tco2e,
        ]
          .map(csvEscape)
          .join(",");
      }),
      `TOTAL,,,,,,${roll.total}`,
    ];
    return reply
      .type("text/csv; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="carbon-report-${req.projectId}.csv"`,
      )
      .send(lines.join("\n") + "\n");
  });

  /* ================================================================== */
  /* Waste (#513-514)                                                   */
  /* ================================================================== */

  app.post("/projects/:projectId/waste-records", { preHandler: standardGate }, async (req, reply) => {
    const body = wasteCreateSchema.parse(req.body);
    const id = newId("wst");
    await app.db.insert(wasteRecords).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      recordDate: body.recordDate,
      stream: body.stream,
      destination: body.destination,
      tonnes: body.tonnes,
      carrier: body.carrier ?? null,
      consignmentNote: body.consignmentNote ?? null,
      cost: body.cost ?? null,
      recordedBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "waste_record",
      objectId: id,
      payload: {
        recordDate: body.recordDate,
        stream: body.stream,
        destination: body.destination,
        tonnes: body.tonnes,
        consignmentNote: body.consignmentNote ?? null,
      },
      storePayload: true,
    });
    const created = await app.db
      .select()
      .from(wasteRecords)
      .where(eq(wasteRecords.id, id))
      .limit(1);
    return reply.status(201).send(created[0]);
  });

  app.get("/projects/:projectId/waste-records", { preHandler: readGate }, async (req) => {
    const q = wasteListQuery.parse(req.query);
    const conds = [
      eq(wasteRecords.companyId, req.companyId!),
      eq(wasteRecords.projectId, req.projectId!),
    ];
    if (q.stream) conds.push(eq(wasteRecords.stream, q.stream));
    if (q.destination) conds.push(eq(wasteRecords.destination, q.destination));
    if (q.from) conds.push(gte(wasteRecords.recordDate, q.from));
    if (q.to) conds.push(lte(wasteRecords.recordDate, q.to));
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(wasteRecords).where(where);
    const rows = await app.db
      .select()
      .from(wasteRecords)
      .where(where)
      .orderBy(desc(wasteRecords.recordDate), desc(wasteRecords.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/waste/summary", { preHandler: readGate }, async (req) => {
    const q = z
      .object({ from: isoDateSchema.optional(), to: isoDateSchema.optional() })
      .parse(req.query);
    const conds = [
      eq(wasteRecords.companyId, req.companyId!),
      eq(wasteRecords.projectId, req.projectId!),
    ];
    if (q.from) conds.push(gte(wasteRecords.recordDate, q.from));
    if (q.to) conds.push(lte(wasteRecords.recordDate, q.to));
    const rows = await app.db
      .select()
      .from(wasteRecords)
      .where(and(...conds));
    const byStream = Object.fromEntries(WASTE_STREAMS.map((s) => [s, 0])) as Record<
      WasteStream,
      number
    >;
    const byDestination = Object.fromEntries(WASTE_DESTINATIONS.map((d) => [d, 0])) as Record<
      WasteDestination,
      number
    >;
    let total = 0;
    let costTotal = 0;
    for (const r of rows) {
      total += r.tonnes;
      costTotal += r.cost ?? 0;
      byStream[r.stream as WasteStream] = (byStream[r.stream as WasteStream] ?? 0) + r.tonnes;
      byDestination[r.destination as WasteDestination] =
        (byDestination[r.destination as WasteDestination] ?? 0) + r.tonnes;
    }
    for (const k of Object.keys(byStream) as WasteStream[]) byStream[k] = round2(byStream[k]);
    for (const k of Object.keys(byDestination) as WasteDestination[]) {
      byDestination[k] = round2(byDestination[k]);
    }
    return {
      recordCount: rows.length,
      totalTonnes: round2(total),
      byStream,
      byDestination,
      ...wasteDiversion(total, byDestination["landfill"], byDestination["recycled"]),
      hazardousTonnes: byStream["hazardous"],
      costTotal: round2(costTotal),
    };
  });

  /* ================================================================== */
  /* Social value (#527-540)                                            */
  /* ================================================================== */

  app.post("/projects/:projectId/social-value", { preHandler: standardGate }, async (req, reply) => {
    const body = commitmentCreateSchema.parse(req.body);
    if (body.vendorId) await validateVendor(req.companyId!, body.vendorId);
    const number = await nextRecordNumber(app.db, req.projectId!, "social_value");
    const id = newId("svc");
    await app.db.insert(socialValueCommitments).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      number,
      theme: body.theme,
      measureRef: body.measureRef ?? null,
      description: body.description,
      unit: body.unit,
      targetValue: body.targetValue,
      deliveredValue: 0,
      proxyValuePerUnit: body.proxyValuePerUnit ?? null,
      dueDate: body.dueDate ?? null,
      status: "committed",
      vendorId: body.vendorId ?? null,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "social_value_commitment",
      objectId: id,
      payload: {
        number,
        theme: body.theme,
        measureRef: body.measureRef ?? null,
        targetValue: body.targetValue,
        unit: body.unit,
        dueDate: body.dueDate ?? null,
      },
      storePayload: true,
    });
    const created = await fetchCommitment(id, req.companyId!, req.projectId!);
    return reply.status(201).send(commitmentView(created));
  });

  app.get("/projects/:projectId/social-value", { preHandler: readGate }, async (req) => {
    const q = commitmentListQuery.parse(req.query);
    await sweepCommitments(req.companyId!, req.projectId!, req.user!.id);
    const conds = [
      eq(socialValueCommitments.companyId, req.companyId!),
      eq(socialValueCommitments.projectId, req.projectId!),
    ];
    if (q.theme) conds.push(eq(socialValueCommitments.theme, q.theme));
    const where = and(...conds);
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(socialValueCommitments)
      .where(where);
    const rows = await app.db
      .select()
      .from(socialValueCommitments)
      .where(where)
      .orderBy(asc(socialValueCommitments.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows.map(commitmentView), Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/social-value/summary", { preHandler: readGate }, async (req) => {
    await sweepCommitments(req.companyId!, req.projectId!, req.user!.id);
    const rows = await app.db
      .select()
      .from(socialValueCommitments)
      .where(
        and(
          eq(socialValueCommitments.companyId, req.companyId!),
          eq(socialValueCommitments.projectId, req.projectId!),
        ),
      )
      .orderBy(asc(socialValueCommitments.number));

    const byTheme = Object.fromEntries(
      SOCIAL_VALUE_THEMES.map((t) => [
        t,
        {
          commitments: 0,
          committed: 0,
          delivered: 0,
          progressPercent: 0,
          proxyValueCommitted: 0,
          proxyValueDelivered: 0,
        },
      ]),
    ) as Record<
      SocialValueTheme,
      {
        commitments: number;
        committed: number;
        delivered: number;
        progressPercent: number;
        proxyValueCommitted: number;
        proxyValueDelivered: number;
      }
    >;

    let proxyCommitted = 0;
    let proxyDelivered = 0;
    for (const c of rows) {
      const t = byTheme[c.theme as SocialValueTheme];
      if (!t) continue;
      t.commitments += 1;
      // Units differ across measures within a theme (weeks, jobs, £); the
      // unit-bearing totals are only meaningful per measure, so the theme
      // roll-up leans on the proxy financial value for comparability (#538).
      t.committed += c.targetValue;
      t.delivered += c.deliveredValue;
      if (c.proxyValuePerUnit != null) {
        t.proxyValueCommitted += c.targetValue * c.proxyValuePerUnit;
        t.proxyValueDelivered += c.deliveredValue * c.proxyValuePerUnit;
        proxyCommitted += c.targetValue * c.proxyValuePerUnit;
        proxyDelivered += c.deliveredValue * c.proxyValuePerUnit;
      }
    }
    for (const t of SOCIAL_VALUE_THEMES) {
      const v = byTheme[t];
      v.progressPercent = percent(v.delivered, v.committed);
      v.committed = round2(v.committed);
      v.delivered = round2(v.delivered);
      v.proxyValueCommitted = round2(v.proxyValueCommitted);
      v.proxyValueDelivered = round2(v.proxyValueDelivered);
    }

    /** #539 — the tender-promise vs delivered reconciliation, per measure. */
    const shortfalls = rows
      .filter((c) => c.status === "shortfall" || c.status === "at_risk")
      .map((c) => ({
        id: c.id,
        number: c.number,
        theme: c.theme,
        measureRef: c.measureRef,
        description: c.description,
        unit: c.unit,
        targetValue: c.targetValue,
        deliveredValue: c.deliveredValue,
        shortfallValue: round2(Math.max(0, c.targetValue - c.deliveredValue)),
        progressPercent: percent(c.deliveredValue, c.targetValue),
        dueDate: c.dueDate,
        status: c.status,
        proxyValueShortfall:
          c.proxyValuePerUnit != null
            ? round2(Math.max(0, c.targetValue - c.deliveredValue) * c.proxyValuePerUnit)
            : null,
      }));

    return {
      byTheme,
      overall: {
        commitments: rows.length,
        delivered: rows.filter((c) => c.status === "delivered").length,
        onTrack: rows.filter((c) => c.status === "on_track" || c.status === "committed").length,
        atRisk: rows.filter((c) => c.status === "at_risk").length,
        shortfall: rows.filter((c) => c.status === "shortfall").length,
        proxyValueCommitted: round2(proxyCommitted),
        proxyValueDelivered: round2(proxyDelivered),
        proxyValueShortfall: round2(Math.max(0, proxyCommitted - proxyDelivered)),
      },
      shortfalls,
    };
  });

  app.get(
    "/projects/:projectId/social-value/:commitmentId",
    { preHandler: readGate },
    async (req) => {
      const { commitmentId } = req.params as { commitmentId: string };
      await fetchCommitment(commitmentId, req.companyId!, req.projectId!);
      await sweepCommitments(req.companyId!, req.projectId!, req.user!.id);
      const commitment = await fetchCommitment(commitmentId, req.companyId!, req.projectId!);
      const deliveries = await app.db
        .select()
        .from(socialValueDeliveries)
        .where(eq(socialValueDeliveries.commitmentId, commitmentId))
        .orderBy(asc(socialValueDeliveries.deliveryDate), asc(socialValueDeliveries.createdAt));
      return { ...commitmentView(commitment), deliveries };
    },
  );

  app.post(
    "/projects/:projectId/social-value/:commitmentId/deliveries",
    { preHandler: standardGate },
    async (req, reply) => {
      const { commitmentId } = req.params as { commitmentId: string };
      const body = deliveryCreateSchema.parse(req.body);
      const commitment = await fetchCommitment(commitmentId, req.companyId!, req.projectId!);
      await validateEvidence(req.companyId!, req.projectId!, body.evidenceIds ?? []);
      const id = newId("svd");
      await app.db.insert(socialValueDeliveries).values({
        id,
        commitmentId,
        companyId: req.companyId!,
        deliveryDate: body.deliveryDate,
        value: body.value,
        note: body.note ?? null,
        evidenceIds: body.evidenceIds ?? [],
        recordedBy: req.user!.id,
      });
      const deliveredValue = round2(commitment.deliveredValue + body.value);
      await app.db
        .update(socialValueCommitments)
        .set({ deliveredValue, updatedAt: new Date().toISOString() })
        .where(eq(socialValueCommitments.id, commitmentId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "social_value_delivery",
        objectId: id,
        payload: {
          commitmentId,
          deliveryDate: body.deliveryDate,
          value: body.value,
          deliveredValue,
          evidenceIds: body.evidenceIds ?? [],
        },
        storePayload: true,
      });
      // Recompute status (and raise the shortfall signal) through the same
      // sweep that the read paths use, so there is exactly one status rule.
      await sweepCommitments(req.companyId!, req.projectId!, req.user!.id);
      const updated = await fetchCommitment(commitmentId, req.companyId!, req.projectId!);
      const delivery = await app.db
        .select()
        .from(socialValueDeliveries)
        .where(eq(socialValueDeliveries.id, id))
        .limit(1);
      return reply
        .status(201)
        .send({ delivery: delivery[0], commitment: commitmentView(updated) });
    },
  );
};
