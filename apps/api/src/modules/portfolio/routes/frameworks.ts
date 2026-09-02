/**
 * BUYING STRUCTURES — framework agreements, lots, appointed suppliers,
 * mini-competitions, term contracts and their schedules of rates.
 * Spec Vol II Domain Z #1053 (framework and call-off management), #1054
 * (mini-competition), #1055 (term contract / schedule of rates), #1056
 * (measured term orders — the call-off side lives in calloffs.ts).
 *
 * These are company-level records: a framework is bought once and called off
 * by many projects, so it belongs to the company gate, and creating or
 * amending one is an owner/admin act.
 *
 * Rules enforced here:
 *  · A lot inherits the framework's currency; a ceiling in another currency
 *    could never be measured against the call-offs that consume it.
 *  · A mini-competition is awarded to a supplier that was actually invited,
 *    and the award is a decision a person records — the engine only ever
 *    "indicates" a winner.
 *  · The person who issued a mini-competition may not award it: the request
 *    and the decision are not authored through the same pathway.
 *  · An award is refused while the framework is not live, and the refusal
 *    names the rule.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  callOffOrders,
  frameworkAgreements,
  frameworkLots,
  frameworkMiniCompetitions,
  frameworkSuppliers,
  scheduleOfRatesItems,
  termContracts,
  vendors,
} from "@constructos/db";
import {
  FRAMEWORK_AWARD_MODES,
  FRAMEWORK_STATUSES,
  FRAMEWORK_SUPPLIER_STATUSES,
  MINI_COMPETITION_STATUSES,
  TERM_CONTRACT_ADJUSTMENT_BASES,
  TERM_CONTRACT_STATUSES,
} from "@constructos/shared";
import { badRequest, conflict, forbidden, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import {
  checkDirectAward,
  evaluateMiniCompetition,
  frameworkUtilisation,
  priceCallOffLines,
  type CallOffLineInput,
  type FrameworkRow,
  type LotRow,
  type MiniCompetitionResponse,
  type SorItem,
} from "../frameworks.js";
import { loadCallOffs, termContractConsumption } from "../service.js";
import {
  assertPortfolio,
  assertProject,
  buildGates,
  currencySchema,
  idSchema,
  isoDateSchema,
  ledger,
  nonNegativeMoneySchema,
  nowISO,
  patchSchemaOf,
  patchSet,
  todayISO,
} from "../shared.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const frameworkCreate = z.object({
  reference: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  description: z.string().max(8000).nullable().optional(),
  contractingAuthority: z.string().max(200).nullable().optional(),
  portfolioId: idSchema.nullable().optional(),
  startDate: isoDateSchema.nullable().optional(),
  endDate: isoDateSchema.nullable().optional(),
  extensionToDate: isoDateSchema.nullable().optional(),
  currency: currencySchema,
  maximumValue: nonNegativeMoneySchema.nullable().optional(),
  awardMode: z.enum(FRAMEWORK_AWARD_MODES).default("mini_competition"),
  directAwardThreshold: nonNegativeMoneySchema.nullable().optional(),
  rulesReference: z.string().max(500).nullable().optional(),
  notes: z.string().max(8000).nullable().optional(),
});

const frameworkPatch = patchSchemaOf(frameworkCreate.omit({ currency: true, reference: true }));

const frameworkList = pageQuerySchema.extend({
  status: z.enum(FRAMEWORK_STATUSES).optional(),
  currency: currencySchema.optional(),
  portfolioId: idSchema.optional(),
  q: z.string().max(120).optional(),
});

const lotCreate = z.object({
  lotNumber: z.string().min(1).max(40),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).nullable().optional(),
  ceilingValue: nonNegativeMoneySchema.nullable().optional(),
  awardMode: z.enum(FRAMEWORK_AWARD_MODES).nullable().optional(),
});

const lotPatch = patchSchemaOf(lotCreate.omit({ lotNumber: true })).extend({
  status: z.enum(FRAMEWORK_STATUSES).optional(),
});

const supplierCreate = z.object({
  supplierName: z.string().min(1).max(200),
  vendorId: idSchema.nullable().optional(),
  lotId: idSchema.nullable().optional(),
  rank: z.number().int().min(1).max(999).nullable().optional(),
  appointedAt: isoDateSchema.nullable().optional(),
});

const supplierPatch = z.object({
  supplierName: z.string().min(1).max(200).optional(),
  rank: z.number().int().min(1).max(999).nullable().optional(),
  status: z.enum(FRAMEWORK_SUPPLIER_STATUSES).optional(),
  suspendedReason: z.string().max(2000).nullable().optional(),
});

const evaluationCriterionSchema = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(200),
  weight: z.number().finite().min(0).max(1000),
  isPrice: z.boolean().optional(),
});

const miniCompetitionCreate = z.object({
  reference: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  scope: z.string().max(8000).nullable().optional(),
  frameworkId: idSchema,
  lotId: idSchema.nullable().optional(),
  projectId: idSchema.nullable().optional(),
  currency: currencySchema,
  estimatedValue: nonNegativeMoneySchema.nullable().optional(),
  invitedSupplierIds: z.array(idSchema).max(200).default([]),
  evaluationCriteria: z.array(evaluationCriterionSchema).max(30).default([]),
  responsesDueAt: isoDateSchema.nullable().optional(),
});

const miniCompetitionPatch = patchSchemaOf(
  miniCompetitionCreate.omit({ frameworkId: true, currency: true, reference: true }),
);

const responseSchema = z.object({
  supplierId: idSchema,
  price: z.number().finite().nonnegative().nullable().optional(),
  scores: z.record(z.string().min(1).max(60), z.number().finite()).optional(),
  withdrawn: z.boolean().optional(),
  submittedAt: z.string().max(40).nullable().optional(),
  note: z.string().max(4000).nullable().optional(),
});

const awardSchema = z.object({
  supplierId: idSchema,
  awardValue: nonNegativeMoneySchema,
  decisionNote: z.string().min(1).max(4000),
});

const termContractCreate = z.object({
  reference: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  supplierName: z.string().min(1).max(200),
  vendorId: idSchema.nullable().optional(),
  portfolioId: idSchema.nullable().optional(),
  currency: currencySchema,
  startDate: isoDateSchema.nullable().optional(),
  endDate: isoDateSchema.nullable().optional(),
  maximumValue: nonNegativeMoneySchema.nullable().optional(),
  adjustmentPercent: z.number().finite().min(-100).max(500).default(0),
  adjustmentBasis: z.enum(TERM_CONTRACT_ADJUSTMENT_BASES).default("none"),
  indexReference: z.string().max(200).nullable().optional(),
  priceBaseDate: isoDateSchema.nullable().optional(),
  notes: z.string().max(8000).nullable().optional(),
});

const termContractPatch = patchSchemaOf(
  termContractCreate.omit({ currency: true, reference: true }),
).extend({ status: z.enum(TERM_CONTRACT_STATUSES).optional() });

const sorItemCreate = z.object({
  code: z.string().min(1).max(60),
  description: z.string().min(1).max(500),
  category: z.string().max(120).nullable().optional(),
  unit: z.string().min(1).max(40),
  rate: z.number().finite().nonnegative(),
});

const sorItemPatch = z.object({
  description: z.string().min(1).max(500).optional(),
  category: z.string().max(120).nullable().optional(),
  unit: z.string().min(1).max(40).optional(),
  rate: z.number().finite().nonnegative().optional(),
  active: z.boolean().optional(),
});

const priceSchema = z.object({
  lines: z
    .array(
      z.object({
        sorItemId: idSchema.nullable().optional(),
        code: z.string().max(60).nullable().optional(),
        description: z.string().max(500).nullable().optional(),
        unit: z.string().max(40).nullable().optional(),
        quantity: z.number().finite(),
        rate: z.number().finite().nonnegative().nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});

/* ------------------------------------------------------------------ */
/* Wire helpers                                                        */
/* ------------------------------------------------------------------ */

const toFrameworkRow = (fw: typeof frameworkAgreements.$inferSelect): FrameworkRow => ({
  id: fw.id,
  reference: fw.reference,
  title: fw.title,
  currency: fw.currency,
  maximumValue: fw.maximumValue,
  startDate: fw.startDate,
  endDate: fw.endDate,
  extensionToDate: fw.extensionToDate,
  awardMode: fw.awardMode,
  directAwardThreshold: fw.directAwardThreshold,
  status: fw.status,
});

const toLotRow = (l: typeof frameworkLots.$inferSelect): LotRow => ({
  id: l.id,
  frameworkId: l.frameworkId,
  lotNumber: l.lotNumber,
  title: l.title,
  currency: l.currency,
  ceilingValue: l.ceilingValue,
  awardMode: l.awardMode,
  status: l.status,
});

interface StoredResponse extends MiniCompetitionResponse {
  note?: string | null;
}

function parseResponses(raw: unknown): StoredResponse[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredResponse[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    const supplierId = typeof r["supplierId"] === "string" ? r["supplierId"] : null;
    if (!supplierId) continue;
    out.push({
      supplierId,
      supplierName: typeof r["supplierName"] === "string" ? r["supplierName"] : supplierId,
      price: typeof r["price"] === "number" && Number.isFinite(r["price"]) ? r["price"] : null,
      scores:
        typeof r["scores"] === "object" && r["scores"] !== null
          ? (r["scores"] as Record<string, number>)
          : undefined,
      withdrawn: r["withdrawn"] === true,
      submittedAt: typeof r["submittedAt"] === "string" ? r["submittedAt"] : null,
      note: typeof r["note"] === "string" ? r["note"] : null,
    });
  }
  return out;
}

function parseCriteria(raw: unknown): Array<{ key: string; label: string; weight: number; isPrice?: boolean }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ key: string; label: string; weight: number; isPrice?: boolean }> = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const c = entry as Record<string, unknown>;
    const key = typeof c["key"] === "string" ? c["key"] : null;
    if (!key) continue;
    out.push({
      key,
      label: typeof c["label"] === "string" ? c["label"] : key,
      weight: typeof c["weight"] === "number" && Number.isFinite(c["weight"]) ? c["weight"] : 0,
      isPrice: c["isPrice"] === true,
    });
  }
  return out;
}

export const frameworkRoutes: FastifyPluginAsync = async (app) => {
  const { companyGate, companyAdminGate } = buildGates(app);

  async function fetchFramework(id: string, companyId: string) {
    const [row] = await app.db
      .select()
      .from(frameworkAgreements)
      .where(and(eq(frameworkAgreements.id, id), eq(frameworkAgreements.companyId, companyId)))
      .limit(1);
    if (!row) throw notFound("Framework agreement not found");
    return row;
  }

  async function assertVendor(companyId: string, vendorId: string): Promise<string> {
    const [row] = await app.db
      .select({ id: vendors.id, name: vendors.name })
      .from(vendors)
      .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)))
      .limit(1);
    if (!row) throw badRequest("vendorId does not name a vendor in this company");
    return row.name;
  }

  /* ================================================================ */
  /* Framework agreements (#1053)                                      */
  /* ================================================================ */

  app.get("/portfolio/frameworks", { preHandler: companyGate }, async (req) => {
    const q = frameworkList.parse(req.query);
    const clauses: SQL[] = [eq(frameworkAgreements.companyId, req.companyId!)];
    if (q.status) clauses.push(eq(frameworkAgreements.status, q.status));
    if (q.currency) clauses.push(eq(frameworkAgreements.currency, q.currency));
    if (q.portfolioId) clauses.push(eq(frameworkAgreements.portfolioId, q.portfolioId));
    if (q.q) clauses.push(ilike(frameworkAgreements.title, `%${q.q}%`));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(frameworkAgreements).where(where);
    const rows = await app.db
      .select()
      .from(frameworkAgreements)
      .where(where)
      .orderBy(asc(frameworkAgreements.reference))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    if (rows.length === 0) return paginate([], Number(totalRow?.n ?? 0), q);

    const ids = rows.map((r) => r.id);
    const lots = await app.db
      .select()
      .from(frameworkLots)
      .where(
        and(eq(frameworkLots.companyId, req.companyId!), inArray(frameworkLots.frameworkId, ids)),
      );
    const callOffs = await loadCallOffs(app.db, req.companyId!);
    const today = todayISO();
    const items = rows.map((fw) => ({
      ...fw,
      utilisation: frameworkUtilisation(
        toFrameworkRow(fw),
        lots.filter((l) => l.frameworkId === fw.id).map(toLotRow),
        callOffs,
        today,
      ),
      lotCount: lots.filter((l) => l.frameworkId === fw.id).length,
    }));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/portfolio/frameworks", { preHandler: companyAdminGate }, async (req, reply) => {
    const body = frameworkCreate.parse(req.body);
    if (body.portfolioId) await assertPortfolio(app.db, req.companyId!, body.portfolioId);
    if (body.startDate && body.endDate && body.endDate < body.startDate) {
      throw badRequest("endDate must not precede startDate");
    }
    if (body.extensionToDate && body.endDate && body.extensionToDate < body.endDate) {
      throw badRequest("extensionToDate must not precede endDate");
    }
    const [clash] = await app.db
      .select({ id: frameworkAgreements.id })
      .from(frameworkAgreements)
      .where(
        and(
          eq(frameworkAgreements.companyId, req.companyId!),
          eq(frameworkAgreements.reference, body.reference),
        ),
      )
      .limit(1);
    if (clash) throw conflict(`A framework with reference "${body.reference}" already exists`);
    const id = newId("fwk");
    await app.db.insert(frameworkAgreements).values({
      id,
      companyId: req.companyId!,
      portfolioId: body.portfolioId ?? null,
      reference: body.reference,
      title: body.title,
      description: body.description ?? null,
      contractingAuthority: body.contractingAuthority ?? null,
      startDate: body.startDate ?? null,
      endDate: body.endDate ?? null,
      extensionToDate: body.extensionToDate ?? null,
      currency: body.currency,
      maximumValue: body.maximumValue ?? null,
      awardMode: body.awardMode,
      directAwardThreshold: body.directAwardThreshold ?? null,
      rulesReference: body.rulesReference ?? null,
      notes: body.notes ?? null,
      createdBy: req.user!.id,
    });
    await ledger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "framework_agreement",
      objectId: id,
      payload: {
        reference: body.reference,
        currency: body.currency,
        maximumValue: body.maximumValue ?? null,
        awardMode: body.awardMode,
        endDate: body.endDate ?? null,
      },
      storePayload: true,
    });
    return reply.status(201).send(await fetchFramework(id, req.companyId!));
  });

  app.get("/portfolio/frameworks/:frameworkId", { preHandler: companyGate }, async (req) => {
    const { frameworkId } = req.params as { frameworkId: string };
    const fw = await fetchFramework(frameworkId, req.companyId!);
    const lots = await app.db
      .select()
      .from(frameworkLots)
      .where(
        and(
          eq(frameworkLots.companyId, req.companyId!),
          eq(frameworkLots.frameworkId, frameworkId),
        ),
      )
      .orderBy(asc(frameworkLots.lotNumber));
    const suppliers = await app.db
      .select()
      .from(frameworkSuppliers)
      .where(
        and(
          eq(frameworkSuppliers.companyId, req.companyId!),
          eq(frameworkSuppliers.frameworkId, frameworkId),
        ),
      )
      .orderBy(asc(frameworkSuppliers.rank), asc(frameworkSuppliers.supplierName));
    const callOffs = await loadCallOffs(app.db, req.companyId!, { frameworkId });
    const competitions = await app.db
      .select()
      .from(frameworkMiniCompetitions)
      .where(
        and(
          eq(frameworkMiniCompetitions.companyId, req.companyId!),
          eq(frameworkMiniCompetitions.frameworkId, frameworkId),
        ),
      )
      .orderBy(desc(frameworkMiniCompetitions.createdAt));
    return {
      ...fw,
      lots,
      suppliers,
      miniCompetitions: competitions,
      callOffs,
      utilisation: frameworkUtilisation(
        toFrameworkRow(fw),
        lots.map(toLotRow),
        callOffs,
        todayISO(),
      ),
    };
  });

  app.patch("/portfolio/frameworks/:frameworkId", { preHandler: companyAdminGate }, async (req) => {
    const { frameworkId } = req.params as { frameworkId: string };
    const body = frameworkPatch.parse(req.body);
    const fw = await fetchFramework(frameworkId, req.companyId!);
    if (body.portfolioId) await assertPortfolio(app.db, req.companyId!, body.portfolioId);
    if (body.maximumValue !== undefined && body.maximumValue !== null) {
      const lots = await app.db
        .select()
        .from(frameworkLots)
        .where(
          and(
            eq(frameworkLots.companyId, req.companyId!),
            eq(frameworkLots.frameworkId, frameworkId),
          ),
        );
      const callOffs = await loadCallOffs(app.db, req.companyId!, { frameworkId });
      const after = frameworkUtilisation(
        { ...toFrameworkRow(fw), maximumValue: body.maximumValue },
        lots.map(toLotRow),
        callOffs,
        todayISO(),
      );
      if (after.breached) {
        throw conflict(
          `Setting the maximum to ${body.maximumValue} ${fw.currency} would put the framework ${after.breachedBy} ${fw.currency} over its ceiling on call-offs already placed.`,
        );
      }
    }
    await app.db
      .update(frameworkAgreements)
      .set(patchSet(body as Record<string, unknown>))
      .where(eq(frameworkAgreements.id, frameworkId));
    await ledger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "framework_agreement",
      objectId: frameworkId,
      payload: { changed: Object.keys(body) },
    });
    return fetchFramework(frameworkId, req.companyId!);
  });

  const frameworkStatusSchema = z.object({
    status: z.enum(FRAMEWORK_STATUSES),
    reason: z.string().max(2000).nullable().optional(),
  });

  app.post(
    "/portfolio/frameworks/:frameworkId/status",
    { preHandler: companyAdminGate },
    async (req) => {
      const { frameworkId } = req.params as { frameworkId: string };
      const body = frameworkStatusSchema.parse(req.body);
      const fw = await fetchFramework(frameworkId, req.companyId!);
      if (fw.status === body.status) return fw;
      if ((body.status === "terminated" || body.status === "suspended") && !body.reason) {
        throw badRequest(`A reason is required to ${body.status === "terminated" ? "terminate" : "suspend"} a framework`);
      }
      await app.db
        .update(frameworkAgreements)
        .set({ status: body.status, updatedAt: nowISO() })
        .where(eq(frameworkAgreements.id, frameworkId));
      await ledger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "framework_agreement",
        objectId: frameworkId,
        payload: { from: fw.status, to: body.status, reason: body.reason ?? null },
        storePayload: true,
      });
      return fetchFramework(frameworkId, req.companyId!);
    },
  );

  /** Utilisation on its own, for a dashboard tile that must not fetch everything. */
  app.get(
    "/portfolio/frameworks/:frameworkId/utilisation",
    { preHandler: companyGate },
    async (req) => {
      const { frameworkId } = req.params as { frameworkId: string };
      const fw = await fetchFramework(frameworkId, req.companyId!);
      const lots = await app.db
        .select()
        .from(frameworkLots)
        .where(
          and(
            eq(frameworkLots.companyId, req.companyId!),
            eq(frameworkLots.frameworkId, frameworkId),
          ),
        );
      const callOffs = await loadCallOffs(app.db, req.companyId!, { frameworkId });
      return frameworkUtilisation(toFrameworkRow(fw), lots.map(toLotRow), callOffs, todayISO());
    },
  );

  /** Would a direct award of this value be permissible? (#1053 framework rules) */
  app.post(
    "/portfolio/frameworks/:frameworkId/direct-award-check",
    { preHandler: companyGate },
    async (req) => {
      const { frameworkId } = req.params as { frameworkId: string };
      const body = z
        .object({
          value: nonNegativeMoneySchema,
          currency: currencySchema,
          lotId: idSchema.nullable().optional(),
        })
        .parse(req.body);
      const fw = await fetchFramework(frameworkId, req.companyId!);
      let lot: LotRow | null = null;
      if (body.lotId) {
        const [row] = await app.db
          .select()
          .from(frameworkLots)
          .where(
            and(
              eq(frameworkLots.id, body.lotId),
              eq(frameworkLots.companyId, req.companyId!),
              eq(frameworkLots.frameworkId, frameworkId),
            ),
          )
          .limit(1);
        if (!row) throw badRequest("lotId does not name a lot of this framework");
        lot = toLotRow(row);
      }
      return checkDirectAward(toFrameworkRow(fw), lot, body.value, body.currency);
    },
  );

  /* ================================================================ */
  /* Lots                                                              */
  /* ================================================================ */

  app.post(
    "/portfolio/frameworks/:frameworkId/lots",
    { preHandler: companyAdminGate },
    async (req, reply) => {
      const { frameworkId } = req.params as { frameworkId: string };
      const body = lotCreate.parse(req.body);
      const fw = await fetchFramework(frameworkId, req.companyId!);
      const [clash] = await app.db
        .select({ id: frameworkLots.id })
        .from(frameworkLots)
        .where(
          and(
            eq(frameworkLots.frameworkId, frameworkId),
            eq(frameworkLots.lotNumber, body.lotNumber),
          ),
        )
        .limit(1);
      if (clash) throw conflict(`Lot ${body.lotNumber} already exists on this framework`);
      const id = newId("flt");
      await app.db.insert(frameworkLots).values({
        id,
        companyId: req.companyId!,
        frameworkId,
        lotNumber: body.lotNumber,
        title: body.title,
        description: body.description ?? null,
        /* the lot always carries the framework's currency: a ceiling in
           another currency could never be measured against its call-offs */
        currency: fw.currency,
        ceilingValue: body.ceilingValue ?? null,
        awardMode: body.awardMode ?? null,
      });
      await ledger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "framework_lot",
        objectId: id,
        payload: {
          frameworkId,
          lotNumber: body.lotNumber,
          ceilingValue: body.ceilingValue ?? null,
          currency: fw.currency,
        },
        storePayload: true,
      });
      const [row] = await app.db.select().from(frameworkLots).where(eq(frameworkLots.id, id)).limit(1);
      return reply.status(201).send(row);
    },
  );

  app.patch(
    "/portfolio/frameworks/:frameworkId/lots/:lotId",
    { preHandler: companyAdminGate },
    async (req) => {
      const { frameworkId, lotId } = req.params as { frameworkId: string; lotId: string };
      const body = lotPatch.parse(req.body);
      await fetchFramework(frameworkId, req.companyId!);
      const [lot] = await app.db
        .select()
        .from(frameworkLots)
        .where(
          and(
            eq(frameworkLots.id, lotId),
            eq(frameworkLots.companyId, req.companyId!),
            eq(frameworkLots.frameworkId, frameworkId),
          ),
        )
        .limit(1);
      if (!lot) throw notFound("Lot not found on this framework");
      await app.db
        .update(frameworkLots)
        .set(patchSet(body as Record<string, unknown>))
        .where(eq(frameworkLots.id, lotId));
      await ledger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "framework_lot",
        objectId: lotId,
        payload: { changed: Object.keys(body) },
      });
      const [row] = await app.db.select().from(frameworkLots).where(eq(frameworkLots.id, lotId)).limit(1);
      return row;
    },
  );

  /* ================================================================ */
  /* Appointed suppliers                                               */
  /* ================================================================ */

  app.post(
    "/portfolio/frameworks/:frameworkId/suppliers",
    { preHandler: companyAdminGate },
    async (req, reply) => {
      const { frameworkId } = req.params as { frameworkId: string };
      const body = supplierCreate.parse(req.body);
      await fetchFramework(frameworkId, req.companyId!);
      if (body.vendorId) await assertVendor(req.companyId!, body.vendorId);
      if (body.lotId) {
        const [lot] = await app.db
          .select({ id: frameworkLots.id })
          .from(frameworkLots)
          .where(
            and(eq(frameworkLots.id, body.lotId), eq(frameworkLots.frameworkId, frameworkId)),
          )
          .limit(1);
        if (!lot) throw badRequest("lotId does not name a lot of this framework");
      }
      const id = newId("fsp");
      await app.db.insert(frameworkSuppliers).values({
        id,
        companyId: req.companyId!,
        frameworkId,
        lotId: body.lotId ?? null,
        vendorId: body.vendorId ?? null,
        supplierName: body.supplierName,
        rank: body.rank ?? null,
        appointedAt: body.appointedAt ?? todayISO(),
      });
      await ledger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "framework_supplier",
        objectId: id,
        payload: { frameworkId, lotId: body.lotId ?? null, supplierName: body.supplierName, rank: body.rank ?? null },
        storePayload: true,
      });
      const [row] = await app.db
        .select()
        .from(frameworkSuppliers)
        .where(eq(frameworkSuppliers.id, id))
        .limit(1);
      return reply.status(201).send(row);
    },
  );

  app.patch(
    "/portfolio/frameworks/:frameworkId/suppliers/:supplierId",
    { preHandler: companyAdminGate },
    async (req) => {
      const { frameworkId, supplierId } = req.params as { frameworkId: string; supplierId: string };
      const body = supplierPatch.parse(req.body);
      const [supplier] = await app.db
        .select()
        .from(frameworkSuppliers)
        .where(
          and(
            eq(frameworkSuppliers.id, supplierId),
            eq(frameworkSuppliers.companyId, req.companyId!),
            eq(frameworkSuppliers.frameworkId, frameworkId),
          ),
        )
        .limit(1);
      if (!supplier) throw notFound("Supplier not found on this framework");
      if (
        (body.status === "suspended" || body.status === "removed") &&
        !body.suspendedReason &&
        !supplier.suspendedReason
      ) {
        throw badRequest(
          "Suspending or removing an appointed supplier requires a reason; the appointment is a contractual position.",
        );
      }
      await app.db
        .update(frameworkSuppliers)
        .set(patchSet(body as Record<string, unknown>))
        .where(eq(frameworkSuppliers.id, supplierId));
      await ledger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: body.status ? "state_change" : "update",
        objectType: "framework_supplier",
        objectId: supplierId,
        payload: {
          changed: Object.keys(body),
          status: body.status ? { from: supplier.status, to: body.status } : undefined,
          reason: body.suspendedReason ?? null,
        },
        storePayload: Boolean(body.status),
      });
      const [row] = await app.db
        .select()
        .from(frameworkSuppliers)
        .where(eq(frameworkSuppliers.id, supplierId))
        .limit(1);
      return row;
    },
  );

  /* ================================================================ */
  /* Mini-competitions (#1054)                                         */
  /* ================================================================ */

  async function fetchCompetition(id: string, companyId: string) {
    const [row] = await app.db
      .select()
      .from(frameworkMiniCompetitions)
      .where(
        and(
          eq(frameworkMiniCompetitions.id, id),
          eq(frameworkMiniCompetitions.companyId, companyId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Mini-competition not found");
    return row;
  }

  async function evaluationFor(row: typeof frameworkMiniCompetitions.$inferSelect) {
    return evaluateMiniCompetition(parseCriteria(row.evaluationCriteria), parseResponses(row.responses));
  }

  app.get("/portfolio/mini-competitions", { preHandler: companyGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        frameworkId: idSchema.optional(),
        projectId: idSchema.optional(),
        status: z.enum(MINI_COMPETITION_STATUSES).optional(),
      })
      .parse(req.query);
    const clauses: SQL[] = [eq(frameworkMiniCompetitions.companyId, req.companyId!)];
    if (q.frameworkId) clauses.push(eq(frameworkMiniCompetitions.frameworkId, q.frameworkId));
    if (q.projectId) clauses.push(eq(frameworkMiniCompetitions.projectId, q.projectId));
    if (q.status) clauses.push(eq(frameworkMiniCompetitions.status, q.status));
    const where = and(...clauses);
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(frameworkMiniCompetitions)
      .where(where);
    const items = await app.db
      .select()
      .from(frameworkMiniCompetitions)
      .where(where)
      .orderBy(desc(frameworkMiniCompetitions.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/portfolio/mini-competitions", { preHandler: companyAdminGate }, async (req, reply) => {
    const body = miniCompetitionCreate.parse(req.body);
    const fw = await fetchFramework(body.frameworkId, req.companyId!);
    if (fw.currency !== body.currency) {
      throw badRequest(
        `The competition is in ${body.currency} but framework ${fw.reference} is in ${fw.currency}; a call-off cannot be priced across currencies.`,
      );
    }
    if (body.projectId) await assertProject(app.db, req.companyId!, body.projectId);
    if (body.lotId) {
      const [lot] = await app.db
        .select({ id: frameworkLots.id })
        .from(frameworkLots)
        .where(and(eq(frameworkLots.id, body.lotId), eq(frameworkLots.frameworkId, fw.id)))
        .limit(1);
      if (!lot) throw badRequest("lotId does not name a lot of this framework");
    }
    if (body.invitedSupplierIds.length > 0) {
      const found = await app.db
        .select({ id: frameworkSuppliers.id })
        .from(frameworkSuppliers)
        .where(
          and(
            eq(frameworkSuppliers.companyId, req.companyId!),
            eq(frameworkSuppliers.frameworkId, fw.id),
            inArray(frameworkSuppliers.id, body.invitedSupplierIds),
          ),
        );
      if (found.length !== body.invitedSupplierIds.length) {
        throw badRequest("Every invited supplier must be appointed to this framework");
      }
    }
    const [clash] = await app.db
      .select({ id: frameworkMiniCompetitions.id })
      .from(frameworkMiniCompetitions)
      .where(
        and(
          eq(frameworkMiniCompetitions.companyId, req.companyId!),
          eq(frameworkMiniCompetitions.reference, body.reference),
        ),
      )
      .limit(1);
    if (clash) throw conflict(`A mini-competition with reference "${body.reference}" already exists`);

    const id = newId("fmc");
    await app.db.insert(frameworkMiniCompetitions).values({
      id,
      companyId: req.companyId!,
      frameworkId: fw.id,
      lotId: body.lotId ?? null,
      projectId: body.projectId ?? null,
      reference: body.reference,
      title: body.title,
      scope: body.scope ?? null,
      currency: body.currency,
      estimatedValue: body.estimatedValue ?? null,
      invitedSupplierIds: body.invitedSupplierIds,
      evaluationCriteria: body.evaluationCriteria,
      responsesDueAt: body.responsesDueAt ?? null,
      createdBy: req.user!.id,
    });
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: body.projectId ?? null,
      actorId: req.user!.id,
      action: "create",
      objectType: "framework_mini_competition",
      objectId: id,
      payload: {
        frameworkId: fw.id,
        reference: body.reference,
        invited: body.invitedSupplierIds.length,
        estimatedValue: body.estimatedValue ?? null,
        currency: body.currency,
      },
      storePayload: true,
    });
    return reply.status(201).send(await fetchCompetition(id, req.companyId!));
  });

  app.get("/portfolio/mini-competitions/:competitionId", { preHandler: companyGate }, async (req) => {
    const { competitionId } = req.params as { competitionId: string };
    const row = await fetchCompetition(competitionId, req.companyId!);
    const suppliers =
      row.invitedSupplierIds.length > 0
        ? await app.db
            .select()
            .from(frameworkSuppliers)
            .where(
              and(
                eq(frameworkSuppliers.companyId, req.companyId!),
                inArray(frameworkSuppliers.id, row.invitedSupplierIds),
              ),
            )
        : [];
    return { ...row, invitedSuppliers: suppliers, evaluation: await evaluationFor(row) };
  });

  app.patch(
    "/portfolio/mini-competitions/:competitionId",
    { preHandler: companyAdminGate },
    async (req) => {
      const { competitionId } = req.params as { competitionId: string };
      const body = miniCompetitionPatch.parse(req.body);
      const row = await fetchCompetition(competitionId, req.companyId!);
      if (row.status === "awarded" || row.status === "cancelled") {
        throw conflict(
          `This competition is ${row.status}; its terms are the record of what was competed and cannot be edited.`,
        );
      }
      if (body.projectId) await assertProject(app.db, req.companyId!, body.projectId);
      await app.db
        .update(frameworkMiniCompetitions)
        .set(patchSet(body as Record<string, unknown>))
        .where(eq(frameworkMiniCompetitions.id, competitionId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: row.projectId,
        actorId: req.user!.id,
        action: "update",
        objectType: "framework_mini_competition",
        objectId: competitionId,
        payload: { changed: Object.keys(body) },
      });
      return fetchCompetition(competitionId, req.companyId!);
    },
  );

  app.post(
    "/portfolio/mini-competitions/:competitionId/issue",
    { preHandler: companyAdminGate },
    async (req) => {
      const { competitionId } = req.params as { competitionId: string };
      const row = await fetchCompetition(competitionId, req.companyId!);
      if (row.status !== "draft") {
        throw conflict(`Only a draft competition can be issued; this one is ${row.status}.`);
      }
      if (row.invitedSupplierIds.length < 1) {
        throw badRequest("A mini-competition must invite at least one appointed supplier before it is issued");
      }
      const fw = await fetchFramework(row.frameworkId, req.companyId!);
      if (fw.status !== "live") {
        throw conflict(`Framework ${fw.reference} is ${fw.status}; work cannot be competed under it.`);
      }
      const at = nowISO();
      await app.db
        .update(frameworkMiniCompetitions)
        .set({ status: "issued", issuedAt: todayISO(), updatedAt: at })
        .where(eq(frameworkMiniCompetitions.id, competitionId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: row.projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "framework_mini_competition",
        objectId: competitionId,
        payload: { from: "draft", to: "issued", invited: row.invitedSupplierIds.length },
        storePayload: true,
      });
      return fetchCompetition(competitionId, req.companyId!);
    },
  );

  /** Record or replace one supplier's response. */
  app.post(
    "/portfolio/mini-competitions/:competitionId/responses",
    { preHandler: companyAdminGate },
    async (req) => {
      const { competitionId } = req.params as { competitionId: string };
      const body = responseSchema.parse(req.body);
      const row = await fetchCompetition(competitionId, req.companyId!);
      if (row.status !== "issued" && row.status !== "evaluating") {
        throw conflict(
          `Responses can only be recorded while a competition is issued or under evaluation; this one is ${row.status}.`,
        );
      }
      if (!row.invitedSupplierIds.includes(body.supplierId)) {
        throw badRequest(
          "That supplier was not invited to this competition. Recording a response from an uninvited supplier would misstate the competition that took place.",
        );
      }
      const [supplier] = await app.db
        .select()
        .from(frameworkSuppliers)
        .where(
          and(
            eq(frameworkSuppliers.id, body.supplierId),
            eq(frameworkSuppliers.companyId, req.companyId!),
          ),
        )
        .limit(1);
      if (!supplier) throw badRequest("supplierId does not name an appointed supplier");

      const responses = parseResponses(row.responses).filter((r) => r.supplierId !== body.supplierId);
      responses.push({
        supplierId: body.supplierId,
        supplierName: supplier.supplierName,
        price: body.price ?? null,
        scores: body.scores,
        withdrawn: body.withdrawn ?? false,
        submittedAt: body.submittedAt ?? nowISO(),
        note: body.note ?? null,
      });
      await app.db
        .update(frameworkMiniCompetitions)
        .set({
          responses,
          status: row.status === "issued" ? "evaluating" : row.status,
          updatedAt: nowISO(),
        })
        .where(eq(frameworkMiniCompetitions.id, competitionId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: row.projectId,
        actorId: req.user!.id,
        action: "update",
        objectType: "framework_mini_competition",
        objectId: competitionId,
        payload: {
          responseFrom: supplier.supplierName,
          price: body.price ?? null,
          withdrawn: body.withdrawn ?? false,
        },
        storePayload: true,
      });
      const updated = await fetchCompetition(competitionId, req.companyId!);
      return { competition: updated, evaluation: await evaluationFor(updated) };
    },
  );

  /** The arithmetic, on demand. Nothing is decided by calling this. */
  app.get(
    "/portfolio/mini-competitions/:competitionId/evaluation",
    { preHandler: companyGate },
    async (req) => {
      const { competitionId } = req.params as { competitionId: string };
      const row = await fetchCompetition(competitionId, req.companyId!);
      return {
        competitionId,
        currency: row.currency,
        evaluation: await evaluationFor(row),
        note: "The evaluation indicates the supplier the arithmetic favours. The award is a decision a person records, with a reason.",
      };
    },
  );

  /**
   * Award (#1054). The issuer may not award: the request and the decision
   * must not be authored through the same pathway.
   */
  app.post(
    "/portfolio/mini-competitions/:competitionId/award",
    { preHandler: companyAdminGate },
    async (req) => {
      const { competitionId } = req.params as { competitionId: string };
      const body = awardSchema.parse(req.body);
      const row = await fetchCompetition(competitionId, req.companyId!);
      if (row.status !== "evaluating" && row.status !== "issued") {
        throw conflict(`Only a live competition can be awarded; this one is ${row.status}.`);
      }
      if (row.createdBy === req.user!.id) {
        throw forbidden(
          "The person who ran a mini-competition cannot award it; the competition and the decision need different hands.",
        );
      }
      if (!row.invitedSupplierIds.includes(body.supplierId)) {
        throw badRequest("The award must go to a supplier that was invited to this competition");
      }
      const responses = parseResponses(row.responses);
      const response = responses.find((r) => r.supplierId === body.supplierId);
      if (!response) {
        throw badRequest("That supplier submitted no response; an award without a response is not a competition outcome");
      }
      if (response.withdrawn) throw badRequest("That supplier withdrew from the competition");
      const fw = await fetchFramework(row.frameworkId, req.companyId!);
      if (fw.status !== "live") {
        throw conflict(`Framework ${fw.reference} is ${fw.status}; an award cannot be made under it.`);
      }
      const evaluation = evaluateMiniCompetition(parseCriteria(row.evaluationCriteria), responses);
      const at = nowISO();
      await app.db
        .update(frameworkMiniCompetitions)
        .set({
          status: "awarded",
          awardedSupplierId: body.supplierId,
          awardedSupplierName: response.supplierName,
          awardValue: body.awardValue,
          awardedAt: at,
          awardedBy: req.user!.id,
          decisionNote: body.decisionNote,
          updatedAt: at,
        })
        .where(eq(frameworkMiniCompetitions.id, competitionId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: row.projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "framework_mini_competition",
        objectId: competitionId,
        payload: {
          from: row.status,
          to: "awarded",
          supplierId: body.supplierId,
          supplierName: response.supplierName,
          awardValue: body.awardValue,
          currency: row.currency,
          indicatedWinnerId: evaluation.indicatedWinnerId,
          /* Awarding away from the arithmetic is legitimate and common; what
             is not legitimate is doing it without saying so. */
          awardedAgainstIndication: evaluation.indicatedWinnerId !== body.supplierId,
          decisionNote: body.decisionNote,
        },
        storePayload: true,
      });
      return {
        competition: await fetchCompetition(competitionId, req.companyId!),
        evaluation,
        awardedAgainstIndication: evaluation.indicatedWinnerId !== body.supplierId,
      };
    },
  );

  app.post(
    "/portfolio/mini-competitions/:competitionId/cancel",
    { preHandler: companyAdminGate },
    async (req) => {
      const { competitionId } = req.params as { competitionId: string };
      const body = z
        .object({
          reason: z.string().min(1).max(4000),
          outcome: z.enum(["cancelled", "abandoned"]).default("cancelled"),
        })
        .parse(req.body);
      const row = await fetchCompetition(competitionId, req.companyId!);
      if (row.status === "awarded") throw conflict("An awarded competition cannot be cancelled.");
      if (row.status === "cancelled" || row.status === "abandoned") return row;
      await app.db
        .update(frameworkMiniCompetitions)
        .set({ status: body.outcome, decisionNote: body.reason, updatedAt: nowISO() })
        .where(eq(frameworkMiniCompetitions.id, competitionId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: row.projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "framework_mini_competition",
        objectId: competitionId,
        payload: { from: row.status, to: body.outcome, reason: body.reason },
        storePayload: true,
      });
      return fetchCompetition(competitionId, req.companyId!);
    },
  );

  /* ================================================================ */
  /* Term contracts and schedules of rates (#1055)                     */
  /* ================================================================ */

  async function fetchTermContract(id: string, companyId: string) {
    const [row] = await app.db
      .select()
      .from(termContracts)
      .where(and(eq(termContracts.id, id), eq(termContracts.companyId, companyId)))
      .limit(1);
    if (!row) throw notFound("Term contract not found");
    return row;
  }

  app.get("/portfolio/term-contracts", { preHandler: companyGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        status: z.enum(TERM_CONTRACT_STATUSES).optional(),
        vendorId: idSchema.optional(),
        q: z.string().max(120).optional(),
      })
      .parse(req.query);
    const clauses: SQL[] = [eq(termContracts.companyId, req.companyId!)];
    if (q.status) clauses.push(eq(termContracts.status, q.status));
    if (q.vendorId) clauses.push(eq(termContracts.vendorId, q.vendorId));
    if (q.q) clauses.push(ilike(termContracts.title, `%${q.q}%`));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(termContracts).where(where);
    const rows = await app.db
      .select()
      .from(termContracts)
      .where(where)
      .orderBy(asc(termContracts.reference))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const items = await Promise.all(
      rows.map(async (r) => ({
        ...r,
        consumption: await termContractConsumption(app.db, req.companyId!, r.id, r.currency),
      })),
    );
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/portfolio/term-contracts", { preHandler: companyAdminGate }, async (req, reply) => {
    const body = termContractCreate.parse(req.body);
    if (body.portfolioId) await assertPortfolio(app.db, req.companyId!, body.portfolioId);
    if (body.vendorId) await assertVendor(req.companyId!, body.vendorId);
    if (body.startDate && body.endDate && body.endDate < body.startDate) {
      throw badRequest("endDate must not precede startDate");
    }
    if (body.adjustmentBasis === "index_linked" && !body.indexReference) {
      throw badRequest("An index-linked term contract must name the index it is linked to");
    }
    const [clash] = await app.db
      .select({ id: termContracts.id })
      .from(termContracts)
      .where(
        and(eq(termContracts.companyId, req.companyId!), eq(termContracts.reference, body.reference)),
      )
      .limit(1);
    if (clash) throw conflict(`A term contract with reference "${body.reference}" already exists`);
    const id = newId("trm");
    await app.db.insert(termContracts).values({
      id,
      companyId: req.companyId!,
      portfolioId: body.portfolioId ?? null,
      reference: body.reference,
      title: body.title,
      vendorId: body.vendorId ?? null,
      supplierName: body.supplierName,
      currency: body.currency,
      startDate: body.startDate ?? null,
      endDate: body.endDate ?? null,
      maximumValue: body.maximumValue ?? null,
      adjustmentPercent: body.adjustmentPercent,
      adjustmentBasis: body.adjustmentBasis,
      indexReference: body.indexReference ?? null,
      priceBaseDate: body.priceBaseDate ?? null,
      notes: body.notes ?? null,
      createdBy: req.user!.id,
    });
    await ledger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "term_contract",
      objectId: id,
      payload: {
        reference: body.reference,
        supplierName: body.supplierName,
        currency: body.currency,
        adjustmentPercent: body.adjustmentPercent,
        adjustmentBasis: body.adjustmentBasis,
      },
      storePayload: true,
    });
    return reply.status(201).send(await fetchTermContract(id, req.companyId!));
  });

  app.get("/portfolio/term-contracts/:contractId", { preHandler: companyGate }, async (req) => {
    const { contractId } = req.params as { contractId: string };
    const row = await fetchTermContract(contractId, req.companyId!);
    const rates = await app.db
      .select()
      .from(scheduleOfRatesItems)
      .where(
        and(
          eq(scheduleOfRatesItems.companyId, req.companyId!),
          eq(scheduleOfRatesItems.termContractId, contractId),
        ),
      )
      .orderBy(asc(scheduleOfRatesItems.code));
    const orders = await loadCallOffs(app.db, req.companyId!, { termContractId: contractId });
    return {
      ...row,
      rates,
      callOffs: orders,
      consumption: await termContractConsumption(app.db, req.companyId!, contractId, row.currency),
    };
  });

  app.patch("/portfolio/term-contracts/:contractId", { preHandler: companyAdminGate }, async (req) => {
    const { contractId } = req.params as { contractId: string };
    const body = termContractPatch.parse(req.body);
    const row = await fetchTermContract(contractId, req.companyId!);
    if (body.vendorId) await assertVendor(req.companyId!, body.vendorId);
    await app.db
      .update(termContracts)
      .set(patchSet(body as Record<string, unknown>))
      .where(eq(termContracts.id, contractId));
    await ledger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: body.status ? "state_change" : "update",
      objectType: "term_contract",
      objectId: contractId,
      payload: {
        changed: Object.keys(body),
        status: body.status ? { from: row.status, to: body.status } : undefined,
      },
      storePayload: Boolean(body.status),
    });
    return fetchTermContract(contractId, req.companyId!);
  });

  app.post(
    "/portfolio/term-contracts/:contractId/rates",
    { preHandler: companyAdminGate },
    async (req, reply) => {
      const { contractId } = req.params as { contractId: string };
      const body = z
        .union([sorItemCreate, z.object({ items: z.array(sorItemCreate).min(1).max(1000) })])
        .parse(req.body);
      const contract = await fetchTermContract(contractId, req.companyId!);
      const items = "items" in body ? body.items : [body];
      const existing = await app.db
        .select({ code: scheduleOfRatesItems.code })
        .from(scheduleOfRatesItems)
        .where(eq(scheduleOfRatesItems.termContractId, contractId));
      const taken = new Set(existing.map((e) => e.code));
      const clashes = items.filter((i) => taken.has(i.code)).map((i) => i.code);
      if (clashes.length > 0) {
        throw conflict(`These codes already exist in the schedule: ${clashes.join(", ")}`);
      }
      const inserted: string[] = [];
      for (const item of items) {
        const id = newId("sor");
        inserted.push(id);
        await app.db.insert(scheduleOfRatesItems).values({
          id,
          companyId: req.companyId!,
          termContractId: contractId,
          code: item.code,
          description: item.description,
          category: item.category ?? null,
          unit: item.unit,
          currency: contract.currency,
          rate: item.rate,
        });
      }
      await ledger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "schedule_of_rates_item",
        objectId: inserted[0] ?? contractId,
        payload: { termContractId: contractId, count: inserted.length, codes: items.map((i) => i.code) },
        storePayload: true,
      });
      const rows = await app.db
        .select()
        .from(scheduleOfRatesItems)
        .where(inArray(scheduleOfRatesItems.id, inserted));
      return reply.status(201).send({ items: rows, total: rows.length });
    },
  );

  app.patch(
    "/portfolio/term-contracts/:contractId/rates/:itemId",
    { preHandler: companyAdminGate },
    async (req) => {
      const { contractId, itemId } = req.params as { contractId: string; itemId: string };
      const body = sorItemPatch.parse(req.body);
      await fetchTermContract(contractId, req.companyId!);
      const [item] = await app.db
        .select()
        .from(scheduleOfRatesItems)
        .where(
          and(
            eq(scheduleOfRatesItems.id, itemId),
            eq(scheduleOfRatesItems.companyId, req.companyId!),
            eq(scheduleOfRatesItems.termContractId, contractId),
          ),
        )
        .limit(1);
      if (!item) throw notFound("Schedule of rates item not found on this contract");
      const set = patchSet(body as Record<string, unknown>);
      if (body.active !== undefined) set["active"] = body.active ? 1 : 0;
      await app.db
        .update(scheduleOfRatesItems)
        .set(set)
        .where(eq(scheduleOfRatesItems.id, itemId));
      await ledger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "schedule_of_rates_item",
        objectId: itemId,
        payload: {
          termContractId: contractId,
          code: item.code,
          changed: Object.keys(body),
          rate: body.rate !== undefined ? { from: item.rate, to: body.rate } : undefined,
        },
        storePayload: body.rate !== undefined,
      });
      const [row] = await app.db
        .select()
        .from(scheduleOfRatesItems)
        .where(eq(scheduleOfRatesItems.id, itemId))
        .limit(1);
      return row;
    },
  );

  /** Price a set of lines against the schedule, without creating anything. */
  app.post(
    "/portfolio/term-contracts/:contractId/price",
    { preHandler: companyGate },
    async (req) => {
      const { contractId } = req.params as { contractId: string };
      const body = priceSchema.parse(req.body);
      const contract = await fetchTermContract(contractId, req.companyId!);
      const rates = await app.db
        .select()
        .from(scheduleOfRatesItems)
        .where(
          and(
            eq(scheduleOfRatesItems.companyId, req.companyId!),
            eq(scheduleOfRatesItems.termContractId, contractId),
          ),
        );
      const sor: SorItem[] = rates.map((r) => ({
        id: r.id,
        code: r.code,
        description: r.description,
        unit: r.unit,
        currency: r.currency,
        rate: r.rate,
        active: r.active === 1,
      }));
      const lines: CallOffLineInput[] = body.lines.map((l) => ({
        sorItemId: l.sorItemId ?? null,
        code: l.code ?? null,
        description: l.description ?? null,
        unit: l.unit ?? null,
        quantity: l.quantity,
        rate: l.rate ?? null,
      }));
      return priceCallOffLines(lines, sor, {
        currency: contract.currency,
        adjustmentPercent: contract.adjustmentPercent,
      });
    },
  );

  /* A framework may not be deleted once anything has been called off it. */
  app.delete(
    "/portfolio/frameworks/:frameworkId",
    { preHandler: companyAdminGate },
    async (req, reply) => {
      const { frameworkId } = req.params as { frameworkId: string };
      const fw = await fetchFramework(frameworkId, req.companyId!);
      const [used] = await app.db
        .select({ n: count() })
        .from(callOffOrders)
        .where(
          and(
            eq(callOffOrders.companyId, req.companyId!),
            eq(callOffOrders.frameworkId, frameworkId),
          ),
        );
      if (Number(used?.n ?? 0) > 0) {
        throw conflict(
          `${used?.n} call-off(s) were placed under this framework. Terminate or expire it instead; deleting it would erase the authority those orders rest on.`,
        );
      }
      await app.db.delete(frameworkLots).where(eq(frameworkLots.frameworkId, frameworkId));
      await app.db
        .delete(frameworkSuppliers)
        .where(eq(frameworkSuppliers.frameworkId, frameworkId));
      await app.db.delete(frameworkAgreements).where(eq(frameworkAgreements.id, frameworkId));
      await ledger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "framework_agreement",
        objectId: frameworkId,
        payload: { reference: fw.reference, title: fw.title },
        storePayload: true,
      });
      return reply.status(204).send();
    },
  );
};
