/**
 * CALL-OFF ORDERS — the project-scoped instrument that buys work off a
 * framework, a lot or a term contract.
 * Spec Vol II Domain Z #1053 (call-off management and value tracking) and
 * #1056 (measured term contract orders).
 *
 * A call-off belongs to a project — that is what it buys work for — so these
 * routes are `/projects/:projectId/portfolio/call-offs/...` and gated by the
 * `portfolio` tool.
 *
 * Rules enforced here:
 *  · The route the order travelled must be true. A `direct_award` is checked
 *    against the framework's own rules and refused with the rule that bites;
 *    a `mini_competition` order must name a competition that was awarded to
 *    the supplier named on the order; a `measured_term` order must name a
 *    term contract and is priced from its schedule of rates.
 *  · Issuing an order consumes a ceiling. The check runs inside a transaction
 *    against the framework's and the lot's headroom, so two concurrent
 *    issues cannot both slip under the same remaining capacity.
 *  · An issued order's value is not editable in place: the supplier has been
 *    told what was ordered. Cancel and re-issue, or certify against it.
 *  · Certification never exceeds the order value, and never crosses currency.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  callOffOrders,
  frameworkAgreements,
  frameworkLots,
  frameworkMiniCompetitions,
  scheduleOfRatesItems,
  termContracts,
  vendors,
} from "@constructos/db";
import { CALL_OFF_ROUTES, CALL_OFF_STATUSES } from "@constructos/shared";
import { badRequest, conflict, notFound } from "../../../lib/errors.js";
import type { Db } from "../../../lib/db.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import {
  CONSUMING_CALL_OFF_STATUSES,
  checkDirectAward,
  frameworkUtilisation,
  priceCallOffLines,
  type CallOffLineInput,
  type CallOffRow,
  type FrameworkRow,
  type LotRow,
  type SorItem,
} from "../frameworks.js";
import { loadCallOffs } from "../service.js";
import {
  allocateReference,
  buildGates,
  currencySchema,
  idSchema,
  isoDateSchema,
  ledger,
  nonNegativeMoneySchema,
  nowISO,
  round2,
  todayISO,
} from "../shared.js";

const lineSchema = z.object({
  sorItemId: idSchema.nullable().optional(),
  code: z.string().max(60).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  unit: z.string().max(40).nullable().optional(),
  quantity: z.number().finite(),
  rate: z.number().finite().nonnegative().nullable().optional(),
});

const callOffCreate = z.object({
  title: z.string().min(1).max(200),
  scope: z.string().max(8000).nullable().optional(),
  route: z.enum(CALL_OFF_ROUTES),
  frameworkId: idSchema.nullable().optional(),
  lotId: idSchema.nullable().optional(),
  miniCompetitionId: idSchema.nullable().optional(),
  termContractId: idSchema.nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  supplierName: z.string().min(1).max(200),
  currency: currencySchema,
  orderValue: nonNegativeMoneySchema.optional(),
  lines: z.array(lineSchema).max(500).optional(),
  requiredBy: isoDateSchema.nullable().optional(),
  justification: z.string().max(4000).nullable().optional(),
  notes: z.string().max(8000).nullable().optional(),
});

const callOffPatch = z.object({
  title: z.string().min(1).max(200).optional(),
  scope: z.string().max(8000).nullable().optional(),
  supplierName: z.string().min(1).max(200).optional(),
  vendorId: idSchema.nullable().optional(),
  orderValue: nonNegativeMoneySchema.optional(),
  lines: z.array(lineSchema).max(500).optional(),
  requiredBy: isoDateSchema.nullable().optional(),
  justification: z.string().max(4000).nullable().optional(),
  notes: z.string().max(8000).nullable().optional(),
});

const listQuery = pageQuerySchema.extend({
  status: z.enum(CALL_OFF_STATUSES).optional(),
  route: z.enum(CALL_OFF_ROUTES).optional(),
  frameworkId: idSchema.optional(),
  termContractId: idSchema.optional(),
  vendorId: idSchema.optional(),
});

const certifySchema = z.object({
  amount: z.number().finite().positive(),
  currency: currencySchema.optional(),
  note: z.string().max(2000).nullable().optional(),
});

export const callOffRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate, adminGate } = buildGates(app);

  async function fetchOrder(id: string, companyId: string, projectId: string) {
    const [row] = await app.db
      .select()
      .from(callOffOrders)
      .where(
        and(
          eq(callOffOrders.id, id),
          eq(callOffOrders.companyId, companyId),
          eq(callOffOrders.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Call-off order not found");
    return row;
  }

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

  /**
   * Price a measured term order's lines and settle the order value.
   * Returns the priced order so the caller can store the lines and report the
   * gaps; unpriced lines are excluded from the total and named, never zeroed.
   */
  async function priceLines(
    companyId: string,
    termContractId: string,
    currency: string,
    lines: CallOffLineInput[],
  ) {
    const [contract] = await app.db
      .select()
      .from(termContracts)
      .where(and(eq(termContracts.id, termContractId), eq(termContracts.companyId, companyId)))
      .limit(1);
    if (!contract) throw badRequest("termContractId does not name a term contract in this company");
    if (contract.currency !== currency) {
      throw badRequest(
        `The order is in ${currency} but term contract ${contract.reference} is in ${contract.currency}; its rates cannot price this order.`,
      );
    }
    const rates = await app.db
      .select()
      .from(scheduleOfRatesItems)
      .where(
        and(
          eq(scheduleOfRatesItems.companyId, companyId),
          eq(scheduleOfRatesItems.termContractId, termContractId),
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
    return {
      contract,
      priced: priceCallOffLines(lines, sor, {
        currency,
        adjustmentPercent: contract.adjustmentPercent,
      }),
    };
  }

  /**
   * The framework/lot ceiling check for an order about to be issued.
   * `excludeOrderId` measures the order out of the position it is replacing.
   */
  async function assertCeiling(
    db: Db,
    companyId: string,
    order: { id: string; frameworkId: string | null; lotId: string | null; currency: string; orderValue: number },
  ): Promise<void> {
    if (!order.frameworkId) return;
    const [fw] = await db
      .select()
      .from(frameworkAgreements)
      .where(
        and(eq(frameworkAgreements.id, order.frameworkId), eq(frameworkAgreements.companyId, companyId)),
      )
      .limit(1);
    if (!fw) throw badRequest("frameworkId does not name a framework in this company");
    if (fw.status !== "live") {
      throw conflict(
        `Framework ${fw.reference} is ${fw.status}; work cannot be called off a framework that is not live.`,
      );
    }
    const lots = await db
      .select()
      .from(frameworkLots)
      .where(
        and(eq(frameworkLots.companyId, companyId), eq(frameworkLots.frameworkId, order.frameworkId)),
      );
    const existing = (await loadCallOffs(db, companyId, { frameworkId: order.frameworkId })).filter(
      (c) => c.id !== order.id,
    );
    const probe: CallOffRow = {
      id: order.id,
      projectId: "__probe__",
      reference: "__probe__",
      frameworkId: order.frameworkId,
      lotId: order.lotId,
      termContractId: null,
      route: "direct_award",
      currency: order.currency,
      orderValue: order.orderValue,
      certifiedValue: 0,
      status: "issued",
    };
    const utilisation = frameworkUtilisation(
      toFrameworkRow(fw),
      lots.map(toLotRow),
      [...existing, probe],
      todayISO(),
    );
    if (utilisation.breached) {
      throw conflict(
        `Issuing this order would take framework ${fw.reference} ${utilisation.breachedBy} ${utilisation.currency} beyond its ${utilisation.ceiling} ${utilisation.currency} maximum.`,
      );
    }
    if (order.lotId) {
      const lot = utilisation.lots.find((l) => l.lotId === order.lotId);
      if (lot?.breached) {
        throw conflict(
          `Issuing this order would take lot ${lot.lotNumber} ${lot.breachedBy} ${lot.currency} beyond its ${lot.ceiling} ${lot.currency} ceiling.`,
        );
      }
    }
  }

  /* ================================================================ */
  /* Register                                                          */
  /* ================================================================ */

  app.get(
    "/projects/:projectId/portfolio/call-offs",
    { preHandler: readGate },
    async (req) => {
      const q = listQuery.parse(req.query);
      const clauses: SQL[] = [
        eq(callOffOrders.companyId, req.companyId!),
        eq(callOffOrders.projectId, req.projectId!),
      ];
      if (q.status) clauses.push(eq(callOffOrders.status, q.status));
      if (q.route) clauses.push(eq(callOffOrders.route, q.route));
      if (q.frameworkId) clauses.push(eq(callOffOrders.frameworkId, q.frameworkId));
      if (q.termContractId) clauses.push(eq(callOffOrders.termContractId, q.termContractId));
      if (q.vendorId) clauses.push(eq(callOffOrders.vendorId, q.vendorId));
      const where = and(...clauses);
      const [totalRow] = await app.db.select({ n: count() }).from(callOffOrders).where(where);
      const items = await app.db
        .select()
        .from(callOffOrders)
        .where(where)
        .orderBy(desc(callOffOrders.number))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      /* Bucketed by currency because a project may call off in more than one
         and this platform never adds those together. */
      const all = await app.db
        .select({
          currency: callOffOrders.currency,
          status: callOffOrders.status,
          orderValue: callOffOrders.orderValue,
          certifiedValue: callOffOrders.certifiedValue,
        })
        .from(callOffOrders)
        .where(
          and(
            eq(callOffOrders.companyId, req.companyId!),
            eq(callOffOrders.projectId, req.projectId!),
          ),
        );
      const buckets = new Map<string, { currency: string; ordered: number; certified: number; count: number }>();
      for (const row of all) {
        const acc = buckets.get(row.currency) ?? {
          currency: row.currency,
          ordered: 0,
          certified: 0,
          count: 0,
        };
        if (CONSUMING_CALL_OFF_STATUSES.includes(row.status)) {
          acc.ordered = round2(acc.ordered + row.orderValue);
          acc.count += 1;
        }
        acc.certified = round2(acc.certified + row.certifiedValue);
        buckets.set(row.currency, acc);
      }
      return {
        ...paginate(items, Number(totalRow?.n ?? 0), q),
        byCurrency: [...buckets.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
      };
    },
  );

  app.post(
    "/projects/:projectId/portfolio/call-offs",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = callOffCreate.parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;

      if (body.vendorId) {
        const [vendor] = await app.db
          .select({ id: vendors.id })
          .from(vendors)
          .where(and(eq(vendors.id, body.vendorId), eq(vendors.companyId, companyId)))
          .limit(1);
        if (!vendor) throw badRequest("vendorId does not name a vendor in this company");
      }

      let frameworkId = body.frameworkId ?? null;
      let lotId = body.lotId ?? null;
      let orderValue = body.orderValue ?? 0;
      let storedLines: unknown[] = [];
      const directAwardReasons: string[] = [];
      let pricingReasons: string[] = [];

      if (body.route === "measured_term" || body.route === "term_contract") {
        if (!body.termContractId) {
          throw badRequest(`A ${body.route.replace("_", " ")} order must name the term contract it is placed under`);
        }
      }

      if (body.route === "measured_term") {
        if (!body.lines || body.lines.length === 0) {
          throw badRequest(
            "A measured term order is priced from its lines; an order with no lines has nothing to measure.",
          );
        }
        const { priced } = await priceLines(
          companyId,
          body.termContractId!,
          body.currency,
          body.lines.map((l) => ({
            sorItemId: l.sorItemId ?? null,
            code: l.code ?? null,
            description: l.description ?? null,
            unit: l.unit ?? null,
            quantity: l.quantity,
            rate: l.rate ?? null,
          })),
        );
        storedLines = priced.lines;
        pricingReasons = priced.reasons;
        orderValue = priced.total;
      } else if (body.lines && body.lines.length > 0) {
        storedLines = body.lines;
      }

      if (body.route === "term_contract" && body.termContractId) {
        const [contract] = await app.db
          .select()
          .from(termContracts)
          .where(
            and(eq(termContracts.id, body.termContractId), eq(termContracts.companyId, companyId)),
          )
          .limit(1);
        if (!contract) throw badRequest("termContractId does not name a term contract in this company");
        if (contract.currency !== body.currency) {
          throw badRequest(
            `The order is in ${body.currency} but term contract ${contract.reference} is in ${contract.currency}.`,
          );
        }
      }

      if (body.route === "mini_competition") {
        if (!body.miniCompetitionId) {
          throw badRequest("A mini-competition order must name the competition it came from");
        }
        const [comp] = await app.db
          .select()
          .from(frameworkMiniCompetitions)
          .where(
            and(
              eq(frameworkMiniCompetitions.id, body.miniCompetitionId),
              eq(frameworkMiniCompetitions.companyId, companyId),
            ),
          )
          .limit(1);
        if (!comp) throw badRequest("miniCompetitionId does not name a competition in this company");
        if (comp.status !== "awarded") {
          throw conflict(
            `Competition ${comp.reference} is ${comp.status}; an order cannot be placed off a competition that has not been awarded.`,
          );
        }
        if (comp.awardedSupplierName && comp.awardedSupplierName !== body.supplierName) {
          throw badRequest(
            `Competition ${comp.reference} was awarded to ${comp.awardedSupplierName}, not ${body.supplierName}. An order to a different supplier is not the outcome of that competition.`,
          );
        }
        frameworkId = comp.frameworkId;
        lotId = comp.lotId;
        if (body.orderValue === undefined && comp.awardValue !== null) orderValue = comp.awardValue;
      }

      if (body.route === "direct_award") {
        if (!frameworkId) {
          throw badRequest("A direct award must name the framework it is called off");
        }
        if (!body.justification) {
          throw badRequest(
            "A direct award requires a justification; calling off without competing is a decision that has to be defensible.",
          );
        }
        const [fw] = await app.db
          .select()
          .from(frameworkAgreements)
          .where(
            and(eq(frameworkAgreements.id, frameworkId), eq(frameworkAgreements.companyId, companyId)),
          )
          .limit(1);
        if (!fw) throw badRequest("frameworkId does not name a framework in this company");
        let lot: LotRow | null = null;
        if (lotId) {
          const [row] = await app.db
            .select()
            .from(frameworkLots)
            .where(and(eq(frameworkLots.id, lotId), eq(frameworkLots.frameworkId, frameworkId)))
            .limit(1);
          if (!row) throw badRequest("lotId does not name a lot of this framework");
          lot = toLotRow(row);
        }
        const check = checkDirectAward(toFrameworkRow(fw), lot, orderValue, body.currency);
        if (!check.permitted) {
          throw conflict(
            `A direct award is not permissible here: ${check.reasons.join(" ")}`,
          );
        }
        directAwardReasons.push(
          `Direct award permitted: value ${orderValue} ${body.currency} within the framework's rules.`,
        );
      }

      if (frameworkId) {
        const [fw] = await app.db
          .select({ currency: frameworkAgreements.currency, reference: frameworkAgreements.reference })
          .from(frameworkAgreements)
          .where(
            and(eq(frameworkAgreements.id, frameworkId), eq(frameworkAgreements.companyId, companyId)),
          )
          .limit(1);
        if (!fw) throw badRequest("frameworkId does not name a framework in this company");
        if (fw.currency !== body.currency) {
          throw badRequest(
            `The order is in ${body.currency} but framework ${fw.reference} is in ${fw.currency}; it cannot consume that framework's ceiling.`,
          );
        }
      }

      const { number, reference } = await allocateReference(app.db, projectId, "call_off", "CO");
      const id = newId("cof");
      await app.db.insert(callOffOrders).values({
        id,
        companyId,
        projectId,
        number,
        reference,
        title: body.title,
        scope: body.scope ?? null,
        route: body.route,
        frameworkId,
        lotId,
        miniCompetitionId: body.miniCompetitionId ?? null,
        termContractId: body.termContractId ?? null,
        vendorId: body.vendorId ?? null,
        supplierName: body.supplierName,
        currency: body.currency,
        orderValue,
        lines: storedLines,
        requiredBy: body.requiredBy ?? null,
        justification: body.justification ?? null,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      });
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "create",
        objectType: "call_off_order",
        objectId: id,
        payload: {
          reference,
          route: body.route,
          frameworkId,
          lotId,
          termContractId: body.termContractId ?? null,
          supplierName: body.supplierName,
          orderValue,
          currency: body.currency,
          justification: body.justification ?? null,
        },
        storePayload: true,
      });
      const row = await fetchOrder(id, companyId, projectId);
      return reply
        .status(201)
        .send({ ...row, pricingReasons, directAwardReasons });
    },
  );

  app.get(
    "/projects/:projectId/portfolio/call-offs/:callOffId",
    { preHandler: readGate },
    async (req) => {
      const { callOffId } = req.params as { callOffId: string };
      const row = await fetchOrder(callOffId, req.companyId!, req.projectId!);
      const framework = row.frameworkId
        ? ((
            await app.db
              .select()
              .from(frameworkAgreements)
              .where(
                and(
                  eq(frameworkAgreements.id, row.frameworkId),
                  eq(frameworkAgreements.companyId, req.companyId!),
                ),
              )
              .limit(1)
          )[0] ?? null)
        : null;
      const contract = row.termContractId
        ? ((
            await app.db
              .select()
              .from(termContracts)
              .where(
                and(
                  eq(termContracts.id, row.termContractId),
                  eq(termContracts.companyId, req.companyId!),
                ),
              )
              .limit(1)
          )[0] ?? null)
        : null;
      return {
        ...row,
        framework,
        termContract: contract,
        remainingToCertify: round2(row.orderValue - row.certifiedValue),
      };
    },
  );

  app.patch(
    "/projects/:projectId/portfolio/call-offs/:callOffId",
    { preHandler: standardGate },
    async (req) => {
      const { callOffId } = req.params as { callOffId: string };
      const body = callOffPatch.parse(req.body);
      const row = await fetchOrder(callOffId, req.companyId!, req.projectId!);
      if (row.status !== "draft") {
        const touchesValue = body.orderValue !== undefined || body.lines !== undefined;
        if (touchesValue) {
          throw conflict(
            `Order ${row.reference} has been issued; the supplier has been told what was ordered. Its value cannot be edited in place — cancel and re-issue, or certify against it.`,
          );
        }
      }
      const set: Record<string, unknown> = { updatedAt: nowISO() };
      let pricingReasons: string[] = [];
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined || k === "lines" || k === "orderValue") continue;
        set[k] = v;
      }
      if (body.lines !== undefined && row.route === "measured_term" && row.termContractId) {
        const { priced } = await priceLines(
          req.companyId!,
          row.termContractId,
          row.currency,
          body.lines.map((l) => ({
            sorItemId: l.sorItemId ?? null,
            code: l.code ?? null,
            description: l.description ?? null,
            unit: l.unit ?? null,
            quantity: l.quantity,
            rate: l.rate ?? null,
          })),
        );
        set["lines"] = priced.lines;
        set["orderValue"] = priced.total;
        pricingReasons = priced.reasons;
      } else {
        if (body.lines !== undefined) set["lines"] = body.lines;
        if (body.orderValue !== undefined) set["orderValue"] = body.orderValue;
      }
      await app.db.update(callOffOrders).set(set).where(eq(callOffOrders.id, callOffId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "call_off_order",
        objectId: callOffId,
        payload: { changed: Object.keys(body), orderValue: set["orderValue"] },
        storePayload: set["orderValue"] !== undefined,
      });
      const updated = await fetchOrder(callOffId, req.companyId!, req.projectId!);
      return { ...updated, pricingReasons };
    },
  );

  /** Issue the order. This is what consumes the framework's ceiling. */
  app.post(
    "/projects/:projectId/portfolio/call-offs/:callOffId/issue",
    { preHandler: standardGate },
    async (req) => {
      const { callOffId } = req.params as { callOffId: string };
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const row = await fetchOrder(callOffId, companyId, projectId);
      if (row.status !== "draft") {
        throw conflict(`Order ${row.reference} is already ${row.status.replace(/_/g, " ")}.`);
      }
      if (row.orderValue <= 0) {
        throw badRequest("An order with no value cannot be issued; price it first.");
      }
      await app.db.transaction(async (tx) => {
        await assertCeiling(tx, companyId, {
          id: row.id,
          frameworkId: row.frameworkId,
          lotId: row.lotId,
          currency: row.currency,
          orderValue: row.orderValue,
        });
        await tx
          .update(callOffOrders)
          .set({ status: "issued", issuedAt: todayISO(), updatedAt: nowISO() })
          .where(and(eq(callOffOrders.id, callOffId), eq(callOffOrders.status, "draft")));
      });
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "call_off_order",
        objectId: callOffId,
        payload: {
          from: "draft",
          to: "issued",
          orderValue: row.orderValue,
          currency: row.currency,
          frameworkId: row.frameworkId,
          lotId: row.lotId,
          route: row.route,
        },
        storePayload: true,
      });
      return fetchOrder(callOffId, companyId, projectId);
    },
  );

  /** Record value certified against the order. A money move: locked and checked. */
  app.post(
    "/projects/:projectId/portfolio/call-offs/:callOffId/certify",
    { preHandler: standardGate },
    async (req) => {
      const { callOffId } = req.params as { callOffId: string };
      const body = certifySchema.parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;

      const result = await app.db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(callOffOrders)
          .where(
            and(
              eq(callOffOrders.id, callOffId),
              eq(callOffOrders.companyId, companyId),
              eq(callOffOrders.projectId, projectId),
            ),
          )
          .for("update");
        if (!locked) throw notFound("Call-off order not found");
        if (body.currency && body.currency !== locked.currency) {
          throw badRequest(
            `The certification is in ${body.currency} but order ${locked.reference} is in ${locked.currency}; this platform does not convert.`,
          );
        }
        if (!["issued", "in_progress"].includes(locked.status)) {
          throw conflict(
            `Only an issued or in-progress order can be certified against; ${locked.reference} is ${locked.status.replace(/_/g, " ")}.`,
          );
        }
        const certified = round2(locked.certifiedValue + body.amount);
        if (certified > locked.orderValue + 0.005) {
          throw conflict(
            `Certifying ${body.amount} ${locked.currency} would take the total certified to ${certified} ${locked.currency}, beyond the ${locked.orderValue} ${locked.currency} ordered. Vary the order first.`,
          );
        }
        await tx
          .update(callOffOrders)
          .set({ certifiedValue: certified, status: "in_progress", updatedAt: nowISO() })
          .where(eq(callOffOrders.id, callOffId));
        return { before: locked.certifiedValue, certified, currency: locked.currency, reference: locked.reference };
      });

      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "call_off_order",
        objectId: callOffId,
        payload: {
          certifiedValue: { from: result.before, to: result.certified },
          amount: body.amount,
          currency: result.currency,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      return fetchOrder(callOffId, companyId, projectId);
    },
  );

  const transitionSchema = z.object({
    reason: z.string().max(4000).nullable().optional(),
    completedAt: isoDateSchema.optional(),
  });

  app.post(
    "/projects/:projectId/portfolio/call-offs/:callOffId/complete",
    { preHandler: standardGate },
    async (req) => {
      const { callOffId } = req.params as { callOffId: string };
      const body = transitionSchema.parse(req.body ?? {});
      const row = await fetchOrder(callOffId, req.companyId!, req.projectId!);
      if (!["issued", "in_progress"].includes(row.status)) {
        throw conflict(`Order ${row.reference} is ${row.status.replace(/_/g, " ")} and cannot be completed.`);
      }
      const at = body.completedAt ?? todayISO();
      await app.db
        .update(callOffOrders)
        .set({ status: "completed", completedAt: at, updatedAt: nowISO() })
        .where(eq(callOffOrders.id, callOffId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "call_off_order",
        objectId: callOffId,
        payload: {
          from: row.status,
          to: "completed",
          completedAt: at,
          certifiedValue: row.certifiedValue,
          orderValue: row.orderValue,
          currency: row.currency,
          /* An order completed below its value releases the balance back to
             the framework ceiling; saying so keeps the headroom honest. */
          uncertifiedBalance: round2(row.orderValue - row.certifiedValue),
        },
        storePayload: true,
      });
      return fetchOrder(callOffId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/portfolio/call-offs/:callOffId/cancel",
    { preHandler: standardGate },
    async (req) => {
      const { callOffId } = req.params as { callOffId: string };
      const body = z.object({ reason: z.string().min(1).max(4000) }).parse(req.body);
      const row = await fetchOrder(callOffId, req.companyId!, req.projectId!);
      if (row.status === "cancelled") return row;
      if (row.status === "completed") throw conflict("A completed order cannot be cancelled.");
      if (row.certifiedValue > 0.005) {
        throw conflict(
          `${row.certifiedValue} ${row.currency} has been certified against ${row.reference}; it can be completed or disputed, but not cancelled.`,
        );
      }
      await app.db
        .update(callOffOrders)
        .set({ status: "cancelled", notes: body.reason, updatedAt: nowISO() })
        .where(eq(callOffOrders.id, callOffId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "call_off_order",
        objectId: callOffId,
        payload: {
          from: row.status,
          to: "cancelled",
          reason: body.reason,
          releasedFromCeiling: row.orderValue,
          currency: row.currency,
        },
        storePayload: true,
      });
      return fetchOrder(callOffId, req.companyId!, req.projectId!);
    },
  );

  app.delete(
    "/projects/:projectId/portfolio/call-offs/:callOffId",
    { preHandler: adminGate },
    async (req, reply) => {
      const { callOffId } = req.params as { callOffId: string };
      const row = await fetchOrder(callOffId, req.companyId!, req.projectId!);
      if (row.status !== "draft") {
        throw conflict(
          `Order ${row.reference} has been issued and is part of the commercial record; cancel it rather than deleting it.`,
        );
      }
      await app.db.delete(callOffOrders).where(eq(callOffOrders.id, callOffId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "call_off_order",
        objectId: callOffId,
        payload: { reference: row.reference, orderValue: row.orderValue, currency: row.currency },
        storePayload: true,
      });
      return reply.status(204).send();
    },
  );

  /** Every framework this project may call off, with live headroom. */
  app.get(
    "/projects/:projectId/portfolio/available-frameworks",
    { preHandler: readGate },
    async (req) => {
      const frameworks = await app.db
        .select()
        .from(frameworkAgreements)
        .where(
          and(
            eq(frameworkAgreements.companyId, req.companyId!),
            eq(frameworkAgreements.status, "live"),
          ),
        )
        .orderBy(asc(frameworkAgreements.reference));
      const lots = await app.db
        .select()
        .from(frameworkLots)
        .where(eq(frameworkLots.companyId, req.companyId!));
      const callOffs = await loadCallOffs(app.db, req.companyId!);
      const today = todayISO();
      const contracts = await app.db
        .select()
        .from(termContracts)
        .where(and(eq(termContracts.companyId, req.companyId!), eq(termContracts.status, "live")))
        .orderBy(asc(termContracts.reference));
      return {
        frameworks: frameworks.map((fw) => ({
          id: fw.id,
          reference: fw.reference,
          title: fw.title,
          currency: fw.currency,
          awardMode: fw.awardMode,
          directAwardThreshold: fw.directAwardThreshold,
          endDate: fw.endDate,
          extensionToDate: fw.extensionToDate,
          lots: lots.filter((l) => l.frameworkId === fw.id),
          utilisation: frameworkUtilisation(
            toFrameworkRow(fw),
            lots.filter((l) => l.frameworkId === fw.id).map(toLotRow),
            callOffs,
            today,
          ),
        })),
        termContracts: contracts.map((c) => ({
          id: c.id,
          reference: c.reference,
          title: c.title,
          supplierName: c.supplierName,
          currency: c.currency,
          adjustmentPercent: c.adjustmentPercent,
          endDate: c.endDate,
        })),
      };
    },
  );
};
