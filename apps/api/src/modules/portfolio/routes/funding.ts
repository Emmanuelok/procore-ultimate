/**
 * MONEY AUTHORITY — funding sources, multi-year appropriations, virements,
 * per-project allocations and the affordability envelope.
 * Spec Vol I §7 #779–#780, #783–#784; Vol II Domain G #426–#434.
 *
 * The chain is deliberately explicit and auditable end to end:
 *
 *     funding source (a facility)                                   #427
 *       → appropriation (authority for one fiscal year)             #428–#429
 *           ↔ virement (authority moved between appropriations)     #433
 *           → allocation (authority attached to one project)        #427, #430
 *     envelope (the affordability ceiling demand is measured against) #426
 *
 * Rules enforced here:
 *  · An allocation may not be created or increased beyond the headroom of the
 *    appropriation or the facility it draws on. The check is a read-then-
 *    check-then-write inside a transaction with `select … for update` on the
 *    parent row, so two concurrent allocations cannot both pass.
 *  · Nothing is ever compared across currencies. An allocation in a currency
 *    other than its parent's is refused with the reason, never converted.
 *  · An approved allocation's amount cannot be edited in place — the approval
 *    was given on a number, and keeping it on a different one is a lie. The
 *    edit reverts the row to `planned` and clears the approval.
 *  · Carry-forward is an act, not arithmetic: closing a year writes the
 *    balance onto the closing row AND onto the successor it names, so the
 *    chain across years is readable without inference.
 *
 * What this file deliberately does NOT do: pay anything. An allocation is
 * authority to spend; the spending itself lives in budgets, commitments and
 * invoices, and `drawnAmount` is the owner's own record of what has been
 * drawn against the authority.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  portfolioAllocations,
  portfolioAppropriations,
  portfolioEnvelopes,
  portfolioFundingSources,
  portfolioVirements,
  projects,
} from "@constructos/db";
import {
  PORTFOLIO_ALLOCATION_STATUSES,
  PORTFOLIO_APPROPRIATION_STATUSES,
  PORTFOLIO_CARRY_FORWARD_POLICIES,
  PORTFOLIO_ENVELOPE_STATUSES,
  PORTFOLIO_EXPENDITURE_CLASSES,
  PORTFOLIO_FUNDING_SOURCE_KINDS,
  PORTFOLIO_FUNDING_SOURCE_STATUSES,
} from "@constructos/shared";
import { badRequest, conflict, forbidden, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import {
  affordability,
  appropriationPosition,
  classificationSplit,
  fundingSourcePosition,
  type AllocationRow,
  type AppropriationRow,
  type EnvelopeRow,
} from "../rollup.js";
import { loadAllocations, visibleProjectIds } from "../service.js";
import {
  assertPortfolio,
  assertProject,
  buildGates,
  currencySchema,
  fiscalYearSchema,
  idSchema,
  isoDateSchema,
  ledger,
  nonNegativeMoneySchema,
  nowISO,
  patchSchemaOf,
  patchSet,
  round2,
} from "../shared.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const fundingSourceCreate = z.object({
  name: z.string().min(1).max(200),
  reference: z.string().max(80).nullable().optional(),
  kind: z.enum(PORTFOLIO_FUNDING_SOURCE_KINDS),
  provider: z.string().max(200).nullable().optional(),
  portfolioId: idSchema.nullable().optional(),
  currency: currencySchema,
  amount: nonNegativeMoneySchema.default(0),
  availableFrom: isoDateSchema.nullable().optional(),
  availableTo: isoDateSchema.nullable().optional(),
  expenditureClass: z.enum(PORTFOLIO_EXPENDITURE_CLASSES).default("capital"),
  conditions: z
    .array(
      z.object({
        id: z.string().max(64).optional(),
        text: z.string().min(1).max(2000),
        dueDate: isoDateSchema.nullable().optional(),
        met: z.boolean().default(false),
      }),
    )
    .max(200)
    .optional(),
  notes: z.string().max(8000).nullable().optional(),
});

/** `currency` is absent: re-denominating a facility that has allocations is not an edit. */
const fundingSourcePatch = patchSchemaOf(fundingSourceCreate.omit({ currency: true }));

const fundingSourceList = pageQuerySchema.extend({
  status: z.enum(PORTFOLIO_FUNDING_SOURCE_STATUSES).optional(),
  kind: z.enum(PORTFOLIO_FUNDING_SOURCE_KINDS).optional(),
  currency: currencySchema.optional(),
  portfolioId: idSchema.optional(),
  q: z.string().max(120).optional(),
});

const appropriationCreate = z.object({
  name: z.string().min(1).max(200),
  fiscalYear: fiscalYearSchema,
  portfolioId: idSchema.nullable().optional(),
  fundingSourceId: idSchema.nullable().optional(),
  periodStart: isoDateSchema.nullable().optional(),
  periodEnd: isoDateSchema.nullable().optional(),
  currency: currencySchema,
  appropriatedAmount: nonNegativeMoneySchema.default(0),
  expenditureClass: z.enum(PORTFOLIO_EXPENDITURE_CLASSES).default("capital"),
  carryForwardPolicy: z.enum(PORTFOLIO_CARRY_FORWARD_POLICIES).default("request"),
  notes: z.string().max(8000).nullable().optional(),
});

const appropriationPatch = patchSchemaOf(appropriationCreate.omit({ currency: true }));

const appropriationList = pageQuerySchema.extend({
  fiscalYear: fiscalYearSchema.optional(),
  status: z.enum(PORTFOLIO_APPROPRIATION_STATUSES).optional(),
  fundingSourceId: idSchema.optional(),
  portfolioId: idSchema.optional(),
  currency: currencySchema.optional(),
});

const closeYearSchema = z.object({
  /** the successor appropriation to carry the balance into; required to carry */
  successorAppropriationId: idSchema.nullable().optional(),
  /** an explicit carry amount; defaults to the eligible balance */
  carryAmount: nonNegativeMoneySchema.optional(),
  note: z.string().max(2000).nullable().optional(),
});

const virementCreate = z.object({
  fromAppropriationId: idSchema,
  toAppropriationId: idSchema,
  amount: z.number().finite().positive(),
  reason: z.string().min(1).max(2000),
});

const virementDecide = z.object({
  outcome: z.enum(["approved", "rejected"]),
  decisionNote: z.string().max(2000).nullable().optional(),
});

const allocationCreate = z.object({
  projectId: idSchema,
  fundingSourceId: idSchema.nullable().optional(),
  appropriationId: idSchema.nullable().optional(),
  fiscalYear: fiscalYearSchema.nullable().optional(),
  currency: currencySchema,
  amount: nonNegativeMoneySchema,
  expenditureClass: z.enum(PORTFOLIO_EXPENDITURE_CLASSES).default("capital"),
  wholeLifeCost: nonNegativeMoneySchema.nullable().optional(),
  notes: z.string().max(8000).nullable().optional(),
});

const allocationPatch = patchSchemaOf(
  allocationCreate.omit({ projectId: true, currency: true }),
);

const allocationList = pageQuerySchema.extend({
  projectId: idSchema.optional(),
  fiscalYear: fiscalYearSchema.optional(),
  status: z.enum(PORTFOLIO_ALLOCATION_STATUSES).optional(),
  fundingSourceId: idSchema.optional(),
  appropriationId: idSchema.optional(),
  expenditureClass: z.enum(PORTFOLIO_EXPENDITURE_CLASSES).optional(),
  currency: currencySchema.optional(),
});

const drawSchema = z.object({
  amount: z.number().finite().positive(),
  note: z.string().max(2000).nullable().optional(),
});

const envelopeCreate = z.object({
  name: z.string().min(1).max(200),
  fiscalYear: fiscalYearSchema,
  portfolioId: idSchema.nullable().optional(),
  currency: currencySchema,
  envelopeAmount: nonNegativeMoneySchema,
  expenditureClass: z.enum(PORTFOLIO_EXPENDITURE_CLASSES).default("capital"),
  basis: z.string().max(4000).nullable().optional(),
  notes: z.string().max(8000).nullable().optional(),
});

const envelopePatch = patchSchemaOf(envelopeCreate.omit({ currency: true }));

const envelopeList = pageQuerySchema.extend({
  fiscalYear: fiscalYearSchema.optional(),
  status: z.enum(PORTFOLIO_ENVELOPE_STATUSES).optional(),
  portfolioId: idSchema.optional(),
});

/** Statuses whose numbers an ordinary edit may not touch. */
const ALLOCATION_LOCKED = ["approved", "drawn", "released"];

export const fundingRoutes: FastifyPluginAsync = async (app) => {
  const { companyGate, companyAdminGate } = buildGates(app);

  /* ================================================================ */
  /* Funding sources (#427, #432)                                      */
  /* ================================================================ */

  async function fetchSource(id: string, companyId: string) {
    const [row] = await app.db
      .select()
      .from(portfolioFundingSources)
      .where(
        and(eq(portfolioFundingSources.id, id), eq(portfolioFundingSources.companyId, companyId)),
      )
      .limit(1);
    if (!row) throw notFound("Funding source not found");
    return row;
  }

  app.get("/portfolio/funding-sources", { preHandler: companyGate }, async (req) => {
    const q = fundingSourceList.parse(req.query);
    const clauses: SQL[] = [eq(portfolioFundingSources.companyId, req.companyId!)];
    if (q.status) clauses.push(eq(portfolioFundingSources.status, q.status));
    if (q.kind) clauses.push(eq(portfolioFundingSources.kind, q.kind));
    if (q.currency) clauses.push(eq(portfolioFundingSources.currency, q.currency));
    if (q.portfolioId) clauses.push(eq(portfolioFundingSources.portfolioId, q.portfolioId));
    if (q.q) clauses.push(ilike(portfolioFundingSources.name, `%${q.q}%`));
    const where = and(...clauses);
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(portfolioFundingSources)
      .where(where);
    const rows = await app.db
      .select()
      .from(portfolioFundingSources)
      .where(where)
      .orderBy(asc(portfolioFundingSources.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const allocations = await loadAllocations(app.db, req.companyId!);
    const items = rows.map((r) => ({
      ...r,
      position: fundingSourcePosition(
        {
          id: r.id,
          currency: r.currency,
          amount: r.amount,
          status: r.status,
          expenditureClass: r.expenditureClass,
        },
        allocations,
      ),
    }));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/portfolio/funding-sources", { preHandler: companyAdminGate }, async (req, reply) => {
    const body = fundingSourceCreate.parse(req.body);
    if (body.portfolioId) await assertPortfolio(app.db, req.companyId!, body.portfolioId);
    if (body.availableFrom && body.availableTo && body.availableTo < body.availableFrom) {
      throw badRequest("availableTo must not precede availableFrom");
    }
    const id = newId("pfs");
    await app.db.insert(portfolioFundingSources).values({
      id,
      companyId: req.companyId!,
      portfolioId: body.portfolioId ?? null,
      reference: body.reference ?? null,
      name: body.name,
      kind: body.kind,
      provider: body.provider ?? null,
      currency: body.currency,
      amount: body.amount,
      availableFrom: body.availableFrom ?? null,
      availableTo: body.availableTo ?? null,
      expenditureClass: body.expenditureClass,
      conditions: (body.conditions ?? []).map((c, i) => ({ id: c.id ?? `c${i + 1}`, ...c })),
      notes: body.notes ?? null,
      createdBy: req.user!.id,
    });
    await ledger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "portfolio_funding_source",
      objectId: id,
      payload: { name: body.name, kind: body.kind, currency: body.currency, amount: body.amount },
      storePayload: true,
    });
    return reply.status(201).send(await fetchSource(id, req.companyId!));
  });

  app.get("/portfolio/funding-sources/:sourceId", { preHandler: companyGate }, async (req) => {
    const { sourceId } = req.params as { sourceId: string };
    const row = await fetchSource(sourceId, req.companyId!);
    const allocations = await loadAllocations(app.db, req.companyId!);
    const mine = allocations.filter((a) => a.fundingSourceId === sourceId);
    return {
      ...row,
      position: fundingSourcePosition(
        {
          id: row.id,
          currency: row.currency,
          amount: row.amount,
          status: row.status,
          expenditureClass: row.expenditureClass,
        },
        allocations,
      ),
      allocations: mine,
      classificationSplit: classificationSplit(mine),
    };
  });

  app.patch("/portfolio/funding-sources/:sourceId", { preHandler: companyAdminGate }, async (req) => {
    const { sourceId } = req.params as { sourceId: string };
    const body = fundingSourcePatch.parse(req.body);
    const row = await fetchSource(sourceId, req.companyId!);
    if (body.portfolioId) await assertPortfolio(app.db, req.companyId!, body.portfolioId);
    /* Shrinking a facility below what is already allocated would make the
       register report headroom that does not exist. Refuse and say by how much. */
    if (body.amount !== undefined && body.amount < row.amount) {
      const allocations = await loadAllocations(app.db, req.companyId!);
      const position = fundingSourcePosition(
        {
          id: row.id,
          currency: row.currency,
          amount: body.amount,
          status: row.status,
          expenditureClass: row.expenditureClass,
        },
        allocations,
      );
      if (position.overdrawn) {
        throw conflict(
          `Reducing the facility to ${body.amount} ${row.currency} would leave ${position.allocated} ${row.currency} allocated against it — ${position.overdrawnBy} ${row.currency} more than the facility. Release allocations first.`,
        );
      }
    }
    const set = patchSet(body as Record<string, unknown>);
    if (body.conditions !== undefined) {
      set["conditions"] = (body.conditions ?? []).map((c, i) => ({ id: c.id ?? `c${i + 1}`, ...c }));
    }
    await app.db
      .update(portfolioFundingSources)
      .set(set)
      .where(eq(portfolioFundingSources.id, sourceId));
    await ledger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "portfolio_funding_source",
      objectId: sourceId,
      payload: { changed: Object.keys(body) },
    });
    return fetchSource(sourceId, req.companyId!);
  });

  const sourceStatusSchema = z.object({
    status: z.enum(PORTFOLIO_FUNDING_SOURCE_STATUSES),
    reason: z.string().max(2000).nullable().optional(),
  });

  app.post(
    "/portfolio/funding-sources/:sourceId/status",
    { preHandler: companyAdminGate },
    async (req) => {
      const { sourceId } = req.params as { sourceId: string };
      const body = sourceStatusSchema.parse(req.body);
      const row = await fetchSource(sourceId, req.companyId!);
      if (row.status === body.status) return row;
      await app.db
        .update(portfolioFundingSources)
        .set({ status: body.status, updatedAt: nowISO() })
        .where(eq(portfolioFundingSources.id, sourceId));
      await ledger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "portfolio_funding_source",
        objectId: sourceId,
        payload: { from: row.status, to: body.status, reason: body.reason ?? null },
        storePayload: true,
      });
      return fetchSource(sourceId, req.companyId!);
    },
  );

  app.delete(
    "/portfolio/funding-sources/:sourceId",
    { preHandler: companyAdminGate },
    async (req, reply) => {
      const { sourceId } = req.params as { sourceId: string };
      const row = await fetchSource(sourceId, req.companyId!);
      const [used] = await app.db
        .select({ n: count() })
        .from(portfolioAllocations)
        .where(
          and(
            eq(portfolioAllocations.companyId, req.companyId!),
            eq(portfolioAllocations.fundingSourceId, sourceId),
          ),
        );
      if (Number(used?.n ?? 0) > 0) {
        throw conflict(
          `${used?.n} allocation(s) draw on this facility. Deleting it would orphan them; withdraw or close the source instead.`,
        );
      }
      await app.db
        .delete(portfolioFundingSources)
        .where(eq(portfolioFundingSources.id, sourceId));
      await ledger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "portfolio_funding_source",
        objectId: sourceId,
        payload: { name: row.name, kind: row.kind, amount: row.amount, currency: row.currency },
        storePayload: true,
      });
      return reply.status(204).send();
    },
  );

  /* ================================================================ */
  /* Appropriations (#428–#429, #433)                                  */
  /* ================================================================ */

  async function fetchAppropriation(id: string, companyId: string) {
    const [row] = await app.db
      .select()
      .from(portfolioAppropriations)
      .where(
        and(eq(portfolioAppropriations.id, id), eq(portfolioAppropriations.companyId, companyId)),
      )
      .limit(1);
    if (!row) throw notFound("Appropriation not found");
    return row;
  }

  const toAppropriationRow = (r: typeof portfolioAppropriations.$inferSelect): AppropriationRow => ({
    id: r.id,
    fiscalYear: r.fiscalYear,
    currency: r.currency,
    appropriatedAmount: r.appropriatedAmount,
    carriedForwardIn: r.carriedForwardIn,
    carriedForwardOut: r.carriedForwardOut,
    virementNet: r.virementNet,
    status: r.status,
    carryForwardPolicy: r.carryForwardPolicy,
    expenditureClass: r.expenditureClass,
  });

  app.get("/portfolio/appropriations", { preHandler: companyGate }, async (req) => {
    const q = appropriationList.parse(req.query);
    const clauses: SQL[] = [eq(portfolioAppropriations.companyId, req.companyId!)];
    if (q.fiscalYear) clauses.push(eq(portfolioAppropriations.fiscalYear, q.fiscalYear));
    if (q.status) clauses.push(eq(portfolioAppropriations.status, q.status));
    if (q.fundingSourceId) {
      clauses.push(eq(portfolioAppropriations.fundingSourceId, q.fundingSourceId));
    }
    if (q.portfolioId) clauses.push(eq(portfolioAppropriations.portfolioId, q.portfolioId));
    if (q.currency) clauses.push(eq(portfolioAppropriations.currency, q.currency));
    const where = and(...clauses);
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(portfolioAppropriations)
      .where(where);
    const rows = await app.db
      .select()
      .from(portfolioAppropriations)
      .where(where)
      .orderBy(desc(portfolioAppropriations.fiscalYear), asc(portfolioAppropriations.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const allocations = await loadAllocations(app.db, req.companyId!);
    const items = rows.map((r) => ({
      ...r,
      position: appropriationPosition(toAppropriationRow(r), allocations),
    }));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/portfolio/appropriations", { preHandler: companyAdminGate }, async (req, reply) => {
    const body = appropriationCreate.parse(req.body);
    if (body.portfolioId) await assertPortfolio(app.db, req.companyId!, body.portfolioId);
    if (body.fundingSourceId) {
      const source = await fetchSource(body.fundingSourceId, req.companyId!);
      if (source.currency !== body.currency) {
        throw badRequest(
          `The appropriation is in ${body.currency} but the funding source is in ${source.currency}; authority cannot be drawn across currencies.`,
        );
      }
    }
    if (body.periodStart && body.periodEnd && body.periodEnd < body.periodStart) {
      throw badRequest("periodEnd must not precede periodStart");
    }
    const id = newId("pap");
    await app.db.insert(portfolioAppropriations).values({
      id,
      companyId: req.companyId!,
      portfolioId: body.portfolioId ?? null,
      fundingSourceId: body.fundingSourceId ?? null,
      fiscalYear: body.fiscalYear,
      periodStart: body.periodStart ?? null,
      periodEnd: body.periodEnd ?? null,
      name: body.name,
      currency: body.currency,
      appropriatedAmount: body.appropriatedAmount,
      expenditureClass: body.expenditureClass,
      carryForwardPolicy: body.carryForwardPolicy,
      notes: body.notes ?? null,
      createdBy: req.user!.id,
    });
    await ledger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "portfolio_appropriation",
      objectId: id,
      payload: {
        fiscalYear: body.fiscalYear,
        currency: body.currency,
        appropriatedAmount: body.appropriatedAmount,
        carryForwardPolicy: body.carryForwardPolicy,
      },
      storePayload: true,
    });
    return reply.status(201).send(await fetchAppropriation(id, req.companyId!));
  });

  app.get(
    "/portfolio/appropriations/:appropriationId",
    { preHandler: companyGate },
    async (req) => {
      const { appropriationId } = req.params as { appropriationId: string };
      const row = await fetchAppropriation(appropriationId, req.companyId!);
      const allocations = await loadAllocations(app.db, req.companyId!);
      const virements = await app.db
        .select()
        .from(portfolioVirements)
        .where(
          and(
            eq(portfolioVirements.companyId, req.companyId!),
            or(
              eq(portfolioVirements.fromAppropriationId, appropriationId),
              eq(portfolioVirements.toAppropriationId, appropriationId),
            ),
          ),
        )
        .orderBy(desc(portfolioVirements.createdAt));
      const carriedFrom = row.carriedForwardFromId
        ? ((
            await app.db
              .select()
              .from(portfolioAppropriations)
              .where(
                and(
                  eq(portfolioAppropriations.id, row.carriedForwardFromId),
                  eq(portfolioAppropriations.companyId, req.companyId!),
                ),
              )
              .limit(1)
          )[0] ?? null)
        : null;
      return {
        ...row,
        position: appropriationPosition(toAppropriationRow(row), allocations),
        allocations: allocations.filter((a) => a.appropriationId === appropriationId),
        virements,
        carriedForwardFrom: carriedFrom,
      };
    },
  );

  app.patch(
    "/portfolio/appropriations/:appropriationId",
    { preHandler: companyAdminGate },
    async (req) => {
      const { appropriationId } = req.params as { appropriationId: string };
      const body = appropriationPatch.parse(req.body);
      const row = await fetchAppropriation(appropriationId, req.companyId!);
      if (row.status === "closed" || row.status === "lapsed" || row.status === "carried_forward") {
        throw conflict(
          `This appropriation is ${row.status.replace(/_/g, " ")}; a closed year cannot be edited. Open a fresh appropriation instead.`,
        );
      }
      if (body.portfolioId) await assertPortfolio(app.db, req.companyId!, body.portfolioId);
      if (body.appropriatedAmount !== undefined && body.appropriatedAmount < row.appropriatedAmount) {
        const allocations = await loadAllocations(app.db, req.companyId!);
        const position = appropriationPosition(
          { ...toAppropriationRow(row), appropriatedAmount: body.appropriatedAmount },
          allocations,
        );
        if (position.overcommitted) {
          throw conflict(
            `Reducing the appropriation to ${body.appropriatedAmount} ${row.currency} would leave it overcommitted by ${position.overcommittedBy} ${row.currency}.`,
          );
        }
      }
      await app.db
        .update(portfolioAppropriations)
        .set(patchSet(body as Record<string, unknown>))
        .where(eq(portfolioAppropriations.id, appropriationId));
      await ledger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "portfolio_appropriation",
        objectId: appropriationId,
        payload: { changed: Object.keys(body) },
      });
      return fetchAppropriation(appropriationId, req.companyId!);
    },
  );

  /**
   * Approval (#428). The approver may not be the person who drafted the
   * appropriation: authorising your own spending authority is exactly the
   * segregation the assurance layer exists to enforce.
   */
  app.post(
    "/portfolio/appropriations/:appropriationId/approve",
    { preHandler: companyAdminGate },
    async (req) => {
      const { appropriationId } = req.params as { appropriationId: string };
      const row = await fetchAppropriation(appropriationId, req.companyId!);
      if (row.status !== "draft") {
        throw conflict(`Only a draft appropriation can be approved; this one is ${row.status}.`);
      }
      if (row.createdBy === req.user!.id) {
        throw forbidden(
          "The person who drafted an appropriation cannot approve it; a different owner or admin must authorise the spending.",
        );
      }
      const at = nowISO();
      await app.db
        .update(portfolioAppropriations)
        .set({ status: "approved", approvedBy: req.user!.id, approvedAt: at, updatedAt: at })
        .where(
          and(
            eq(portfolioAppropriations.id, appropriationId),
            eq(portfolioAppropriations.status, "draft"),
          ),
        );
      await ledger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "portfolio_appropriation",
        objectId: appropriationId,
        payload: {
          from: "draft",
          to: "approved",
          approvedAt: at,
          amount: row.appropriatedAmount,
          currency: row.currency,
        },
        storePayload: true,
      });
      return fetchAppropriation(appropriationId, req.companyId!);
    },
  );

  /**
   * Close a fiscal year (#429, #433). What happens to the unspent balance is
   * the appropriation's declared policy, not a guess:
   *   lapse          → the balance is lost; status `lapsed`
   *   carry_forward  → the balance moves to the named successor
   *   request        → the balance moves only if a successor is named here,
   *                    which is the approval the policy demands
   */
  app.post(
    "/portfolio/appropriations/:appropriationId/close",
    { preHandler: companyAdminGate },
    async (req) => {
      const { appropriationId } = req.params as { appropriationId: string };
      const body = closeYearSchema.parse(req.body ?? {});
      const companyId = req.companyId!;
      const actorId = req.user!.id;

      const result = await app.db.transaction(async (tx) => {
        const locked = (
          await tx
            .select()
            .from(portfolioAppropriations)
            .where(
              and(
                eq(portfolioAppropriations.id, appropriationId),
                eq(portfolioAppropriations.companyId, companyId),
              ),
            )
            .for("update")
        )[0];
        if (!locked) throw notFound("Appropriation not found");
        if (["closed", "lapsed", "carried_forward"].includes(locked.status)) {
          throw conflict(`This appropriation is already ${locked.status.replace(/_/g, " ")}.`);
        }
        if (locked.status === "draft") {
          throw conflict("A draft appropriation has no authority to close; approve it first.");
        }

        const allocations = await loadAllocations(tx, companyId);
        const position = appropriationPosition(toAppropriationRow(locked), allocations);
        /* `carryForwardEligible` is 0 under a lapse policy — nothing is
           eligible to carry. The UNSPENT balance is a different number and is
           what lapses, so both are computed and reported separately. */
        const unspent = Math.max(0, round2(position.authorised - position.drawn));
        const eligible = position.carryForwardEligible;
        const requested = body.carryAmount ?? eligible;
        if (requested > eligible + 0.005) {
          throw badRequest(
            `Only ${eligible} ${locked.currency} is eligible to carry forward (authorised ${position.authorised} less drawn ${position.drawn}); ${requested} was requested.`,
          );
        }

        let successorId: string | null = null;
        let carried = 0;
        let nextStatus = "closed";

        if (locked.carryForwardPolicy === "lapse") {
          nextStatus = unspent > 0.005 ? "lapsed" : "closed";
        } else if (body.successorAppropriationId) {
          const successor = (
            await tx
              .select()
              .from(portfolioAppropriations)
              .where(
                and(
                  eq(portfolioAppropriations.id, body.successorAppropriationId),
                  eq(portfolioAppropriations.companyId, companyId),
                ),
              )
              .for("update")
          )[0];
          if (!successor) throw badRequest("successorAppropriationId does not name an appropriation in this company");
          if (successor.id === locked.id) throw badRequest("An appropriation cannot carry forward into itself");
          if (successor.currency !== locked.currency) {
            throw badRequest(
              `The successor is in ${successor.currency} but this appropriation is in ${locked.currency}; a balance cannot be carried across currencies.`,
            );
          }
          if (["closed", "lapsed", "carried_forward"].includes(successor.status)) {
            throw conflict("The successor appropriation is already closed and cannot receive a carry-forward.");
          }
          successorId = successor.id;
          carried = round2(requested);
          nextStatus = "carried_forward";
          await tx
            .update(portfolioAppropriations)
            .set({
              carriedForwardIn: round2(successor.carriedForwardIn + carried),
              carriedForwardFromId: locked.id,
              updatedAt: nowISO(),
            })
            .where(eq(portfolioAppropriations.id, successor.id));
        } else if (locked.carryForwardPolicy === "carry_forward" && eligible > 0.005) {
          throw badRequest(
            "This appropriation's policy is to carry forward, so a successorAppropriationId is required — a balance must land somewhere to remain authority.",
          );
        }

        await tx
          .update(portfolioAppropriations)
          .set({
            status: nextStatus,
            carriedForwardOut: carried,
            closedAt: nowISO(),
            updatedAt: nowISO(),
          })
          .where(eq(portfolioAppropriations.id, locked.id));

        return { locked, position, carried, successorId, nextStatus, eligible, unspent };
      });

      await ledger(app.db, {
        companyId,
        actorId,
        action: "state_change",
        objectType: "portfolio_appropriation",
        objectId: appropriationId,
        payload: {
          from: result.locked.status,
          to: result.nextStatus,
          policy: result.locked.carryForwardPolicy,
          eligible: result.eligible,
          unspent: result.unspent,
          carriedForwardOut: result.carried,
          successorAppropriationId: result.successorId,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      return {
        appropriation: await fetchAppropriation(appropriationId, companyId),
        carriedForward: result.carried,
        successorAppropriationId: result.successorId,
        lapsed: result.nextStatus === "lapsed" ? result.unspent : 0,
        unspent: result.unspent,
      };
    },
  );

  /* ================================================================ */
  /* Virements (#433)                                                  */
  /* ================================================================ */

  app.get("/portfolio/virements", { preHandler: companyGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ status: z.enum(["proposed", "approved", "rejected"]).optional() })
      .parse(req.query);
    const clauses: SQL[] = [eq(portfolioVirements.companyId, req.companyId!)];
    if (q.status) clauses.push(eq(portfolioVirements.status, q.status));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(portfolioVirements).where(where);
    const items = await app.db
      .select()
      .from(portfolioVirements)
      .where(where)
      .orderBy(desc(portfolioVirements.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/portfolio/virements", { preHandler: companyAdminGate }, async (req, reply) => {
    const body = virementCreate.parse(req.body);
    if (body.fromAppropriationId === body.toAppropriationId) {
      throw badRequest("A virement must move authority between two different appropriations");
    }
    const from = await fetchAppropriation(body.fromAppropriationId, req.companyId!);
    const to = await fetchAppropriation(body.toAppropriationId, req.companyId!);
    if (from.currency !== to.currency) {
      throw badRequest(
        `The source is in ${from.currency} and the target in ${to.currency}; authority cannot be moved across currencies.`,
      );
    }
    const id = newId("pvr");
    await app.db.insert(portfolioVirements).values({
      id,
      companyId: req.companyId!,
      fromAppropriationId: from.id,
      toAppropriationId: to.id,
      currency: from.currency,
      amount: body.amount,
      reason: body.reason,
      requestedBy: req.user!.id,
    });
    await ledger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "portfolio_virement",
      objectId: id,
      payload: { from: from.id, to: to.id, amount: body.amount, currency: from.currency, reason: body.reason },
      storePayload: true,
    });
    const [row] = await app.db
      .select()
      .from(portfolioVirements)
      .where(eq(portfolioVirements.id, id))
      .limit(1);
    return reply.status(201).send(row);
  });

  /**
   * Decide a virement. Approving it moves authority for real: both
   * appropriations are locked, the source is checked for headroom after the
   * move, and `virementNet` on each row is the audited result.
   */
  app.post(
    "/portfolio/virements/:virementId/decide",
    { preHandler: companyAdminGate },
    async (req) => {
      const { virementId } = req.params as { virementId: string };
      const body = virementDecide.parse(req.body);
      const companyId = req.companyId!;
      const actorId = req.user!.id;

      const outcome = await app.db.transaction(async (tx) => {
        const virement = (
          await tx
            .select()
            .from(portfolioVirements)
            .where(
              and(eq(portfolioVirements.id, virementId), eq(portfolioVirements.companyId, companyId)),
            )
            .for("update")
        )[0];
        if (!virement) throw notFound("Virement not found");
        if (virement.status !== "proposed") {
          throw conflict(`This virement has already been ${virement.status}.`);
        }
        if (virement.requestedBy === actorId) {
          throw forbidden(
            "The person who requested a virement cannot decide it; moving spending authority needs a second pair of eyes.",
          );
        }

        if (body.outcome === "approved") {
          const [from] = await tx
            .select()
            .from(portfolioAppropriations)
            .where(
              and(
                eq(portfolioAppropriations.id, virement.fromAppropriationId),
                eq(portfolioAppropriations.companyId, companyId),
              ),
            )
            .for("update");
          const [to] = await tx
            .select()
            .from(portfolioAppropriations)
            .where(
              and(
                eq(portfolioAppropriations.id, virement.toAppropriationId),
                eq(portfolioAppropriations.companyId, companyId),
              ),
            )
            .for("update");
          if (!from || !to) throw notFound("A named appropriation no longer exists");
          const allocations = await loadAllocations(tx, companyId);
          const afterFrom = appropriationPosition(
            { ...toAppropriationRow(from), virementNet: round2(from.virementNet - virement.amount) },
            allocations,
          );
          if (afterFrom.overcommitted) {
            throw conflict(
              `Moving ${virement.amount} ${virement.currency} out of "${from.name}" would leave it overcommitted by ${afterFrom.overcommittedBy} ${virement.currency}.`,
            );
          }
          await tx
            .update(portfolioAppropriations)
            .set({ virementNet: round2(from.virementNet - virement.amount), updatedAt: nowISO() })
            .where(eq(portfolioAppropriations.id, from.id));
          await tx
            .update(portfolioAppropriations)
            .set({ virementNet: round2(to.virementNet + virement.amount), updatedAt: nowISO() })
            .where(eq(portfolioAppropriations.id, to.id));
        }

        await tx
          .update(portfolioVirements)
          .set({
            status: body.outcome,
            decidedBy: actorId,
            decidedAt: nowISO(),
            decisionNote: body.decisionNote ?? null,
          })
          .where(eq(portfolioVirements.id, virementId));
        return virement;
      });

      await ledger(app.db, {
        companyId,
        actorId,
        action: "state_change",
        objectType: "portfolio_virement",
        objectId: virementId,
        payload: {
          from: "proposed",
          to: body.outcome,
          amount: outcome.amount,
          currency: outcome.currency,
          fromAppropriationId: outcome.fromAppropriationId,
          toAppropriationId: outcome.toAppropriationId,
          note: body.decisionNote ?? null,
        },
        storePayload: true,
      });
      const [row] = await app.db
        .select()
        .from(portfolioVirements)
        .where(eq(portfolioVirements.id, virementId))
        .limit(1);
      return row;
    },
  );

  /* ================================================================ */
  /* Allocations (#427, #430, #434)                                    */
  /* ================================================================ */

  async function fetchAllocation(id: string, companyId: string) {
    const [row] = await app.db
      .select()
      .from(portfolioAllocations)
      .where(and(eq(portfolioAllocations.id, id), eq(portfolioAllocations.companyId, companyId)))
      .limit(1);
    if (!row) throw notFound("Allocation not found");
    return row;
  }

  /**
   * Headroom check, run inside the caller's transaction with the parents
   * locked. `excludeAllocationId` lets an edit measure itself out of the
   * position it is about to replace.
   */
  async function assertHeadroom(
    tx: Parameters<Parameters<typeof app.db.transaction>[0]>[0],
    companyId: string,
    input: {
      fundingSourceId: string | null;
      appropriationId: string | null;
      currency: string;
      amount: number;
      excludeAllocationId?: string;
    },
  ): Promise<void> {
    const allocations = (await loadAllocations(tx, companyId)).filter(
      (a) => a.id !== input.excludeAllocationId,
    );
    const probe: AllocationRow = {
      id: "__probe__",
      appropriationId: input.appropriationId,
      fundingSourceId: input.fundingSourceId,
      projectId: "__probe__",
      currency: input.currency,
      amount: input.amount,
      drawnAmount: 0,
      status: "planned",
      expenditureClass: "capital",
      fiscalYear: null,
    };
    const withProbe = [...allocations, probe];

    if (input.appropriationId) {
      const [appropriation] = await tx
        .select()
        .from(portfolioAppropriations)
        .where(
          and(
            eq(portfolioAppropriations.id, input.appropriationId),
            eq(portfolioAppropriations.companyId, companyId),
          ),
        )
        .for("update");
      if (!appropriation) {
        throw badRequest("appropriationId does not name an appropriation in this company");
      }
      if (appropriation.currency !== input.currency) {
        throw badRequest(
          `The allocation is in ${input.currency} but the appropriation is in ${appropriation.currency}; it cannot consume that authority.`,
        );
      }
      if (["draft", "closed", "lapsed", "carried_forward"].includes(appropriation.status)) {
        throw conflict(
          `The appropriation is ${appropriation.status.replace(/_/g, " ")}; only approved or committed authority can be allocated.`,
        );
      }
      const position = appropriationPosition(toAppropriationRow(appropriation), withProbe);
      if (position.overcommitted) {
        throw conflict(
          `This allocation would take "${appropriation.name}" ${position.overcommittedBy} ${input.currency} beyond the ${position.authorised} ${input.currency} authorised for ${appropriation.fiscalYear}.`,
        );
      }
    }

    if (input.fundingSourceId) {
      const [source] = await tx
        .select()
        .from(portfolioFundingSources)
        .where(
          and(
            eq(portfolioFundingSources.id, input.fundingSourceId),
            eq(portfolioFundingSources.companyId, companyId),
          ),
        )
        .for("update");
      if (!source) throw badRequest("fundingSourceId does not name a funding source in this company");
      if (source.currency !== input.currency) {
        throw badRequest(
          `The allocation is in ${input.currency} but the facility is in ${source.currency}; it cannot draw on it.`,
        );
      }
      if (["proposed", "withdrawn", "closed"].includes(source.status)) {
        throw conflict(
          `The funding source is ${source.status}; only a committed or available facility can be allocated from.`,
        );
      }
      const position = fundingSourcePosition(
        {
          id: source.id,
          currency: source.currency,
          amount: source.amount,
          status: source.status,
          expenditureClass: source.expenditureClass,
        },
        withProbe,
      );
      if (position.overdrawn) {
        throw conflict(
          `This allocation would take "${source.name}" ${position.overdrawnBy} ${input.currency} beyond its ${position.facility} ${input.currency} facility.`,
        );
      }
    }
  }

  app.get("/portfolio/allocations", { preHandler: companyGate }, async (req) => {
    const q = allocationList.parse(req.query);
    const visible = await visibleProjectIds(
      app.db,
      req.companyId!,
      req.user!.id,
      req.companyRole,
    );
    if (visible !== null && visible.length === 0) return paginate([], 0, q);
    const clauses: SQL[] = [eq(portfolioAllocations.companyId, req.companyId!)];
    if (visible !== null) clauses.push(inArray(portfolioAllocations.projectId, visible));
    if (q.projectId) clauses.push(eq(portfolioAllocations.projectId, q.projectId));
    if (q.fiscalYear) clauses.push(eq(portfolioAllocations.fiscalYear, q.fiscalYear));
    if (q.status) clauses.push(eq(portfolioAllocations.status, q.status));
    if (q.fundingSourceId) clauses.push(eq(portfolioAllocations.fundingSourceId, q.fundingSourceId));
    if (q.appropriationId) clauses.push(eq(portfolioAllocations.appropriationId, q.appropriationId));
    if (q.expenditureClass) {
      clauses.push(eq(portfolioAllocations.expenditureClass, q.expenditureClass));
    }
    if (q.currency) clauses.push(eq(portfolioAllocations.currency, q.currency));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(portfolioAllocations).where(where);
    const rows = await app.db
      .select()
      .from(portfolioAllocations)
      .where(where)
      .orderBy(desc(portfolioAllocations.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const projectRows = rows.length
      ? await app.db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(
            and(
              eq(projects.companyId, req.companyId!),
              inArray(projects.id, [...new Set(rows.map((r) => r.projectId))]),
            ),
          )
      : [];
    const nameOf = new Map(projectRows.map((p) => [p.id, p.name]));
    const items = rows.map((r) => ({
      ...r,
      projectName: nameOf.get(r.projectId) ?? null,
      remaining: round2(r.amount - r.drawnAmount),
    }));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/portfolio/allocations", { preHandler: companyAdminGate }, async (req, reply) => {
    const body = allocationCreate.parse(req.body);
    const companyId = req.companyId!;
    await assertProject(app.db, companyId, body.projectId);
    if (!body.fundingSourceId && !body.appropriationId) {
      throw badRequest(
        "An allocation must name the appropriation or the funding source it draws on; money with no stated source is not authority.",
      );
    }
    const id = newId("pal");
    await app.db.transaction(async (tx) => {
      await assertHeadroom(tx, companyId, {
        fundingSourceId: body.fundingSourceId ?? null,
        appropriationId: body.appropriationId ?? null,
        currency: body.currency,
        amount: body.amount,
      });
      await tx.insert(portfolioAllocations).values({
        id,
        companyId,
        projectId: body.projectId,
        fundingSourceId: body.fundingSourceId ?? null,
        appropriationId: body.appropriationId ?? null,
        fiscalYear: body.fiscalYear ?? null,
        currency: body.currency,
        amount: body.amount,
        expenditureClass: body.expenditureClass,
        wholeLifeCost: body.wholeLifeCost ?? null,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      });
    });
    await ledger(app.db, {
      companyId,
      projectId: body.projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "portfolio_allocation",
      objectId: id,
      payload: {
        projectId: body.projectId,
        amount: body.amount,
        currency: body.currency,
        expenditureClass: body.expenditureClass,
        appropriationId: body.appropriationId ?? null,
        fundingSourceId: body.fundingSourceId ?? null,
      },
      storePayload: true,
    });
    return reply.status(201).send(await fetchAllocation(id, companyId));
  });

  app.get("/portfolio/allocations/:allocationId", { preHandler: companyGate }, async (req) => {
    const { allocationId } = req.params as { allocationId: string };
    const row = await fetchAllocation(allocationId, req.companyId!);
    const visible = await visibleProjectIds(app.db, req.companyId!, req.user!.id, req.companyRole);
    if (visible !== null && !visible.includes(row.projectId)) {
      throw forbidden("This allocation belongs to a project you are not a member of");
    }
    return { ...row, remaining: round2(row.amount - row.drawnAmount) };
  });

  /**
   * Editing an allocation. An approved allocation's numbers may not be edited
   * in place — the approval was given on a figure, so changing it reverts the
   * row to `planned` and clears the approval rather than carrying it over.
   */
  app.patch("/portfolio/allocations/:allocationId", { preHandler: companyAdminGate }, async (req) => {
    const { allocationId } = req.params as { allocationId: string };
    const body = allocationPatch.parse(req.body);
    const companyId = req.companyId!;
    const row = await fetchAllocation(allocationId, companyId);
    if (row.status === "cancelled") throw conflict("A cancelled allocation cannot be edited.");
    const changesMoney =
      (body.amount !== undefined && body.amount !== row.amount) ||
      (body.appropriationId !== undefined && body.appropriationId !== row.appropriationId) ||
      (body.fundingSourceId !== undefined && body.fundingSourceId !== row.fundingSourceId);
    if (changesMoney && row.drawnAmount > 0.005) {
      throw conflict(
        `${row.drawnAmount} ${row.currency} has already been drawn against this allocation; its source and amount can no longer be changed.`,
      );
    }
    if (body.amount !== undefined && body.amount < row.drawnAmount) {
      throw badRequest(
        `The allocation cannot be reduced below the ${row.drawnAmount} ${row.currency} already drawn against it.`,
      );
    }

    const revertsApproval = changesMoney && ALLOCATION_LOCKED.includes(row.status);
    await app.db.transaction(async (tx) => {
      if (changesMoney) {
        await assertHeadroom(tx, companyId, {
          fundingSourceId:
            body.fundingSourceId !== undefined ? (body.fundingSourceId ?? null) : row.fundingSourceId,
          appropriationId:
            body.appropriationId !== undefined ? (body.appropriationId ?? null) : row.appropriationId,
          currency: row.currency,
          amount: body.amount ?? row.amount,
          excludeAllocationId: row.id,
        });
      }
      const set = patchSet(body as Record<string, unknown>);
      if (revertsApproval) {
        set["status"] = "planned";
        set["approvedBy"] = null;
        set["approvedAt"] = null;
      }
      await tx.update(portfolioAllocations).set(set).where(eq(portfolioAllocations.id, allocationId));
    });
    await ledger(app.db, {
      companyId,
      projectId: row.projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "portfolio_allocation",
      objectId: allocationId,
      payload: { changed: Object.keys(body), approvalCleared: revertsApproval },
      storePayload: revertsApproval,
    });
    return fetchAllocation(allocationId, companyId);
  });

  app.post(
    "/portfolio/allocations/:allocationId/approve",
    { preHandler: companyAdminGate },
    async (req) => {
      const { allocationId } = req.params as { allocationId: string };
      const row = await fetchAllocation(allocationId, req.companyId!);
      if (row.status !== "planned") {
        throw conflict(`Only a planned allocation can be approved; this one is ${row.status}.`);
      }
      if (row.createdBy === req.user!.id) {
        throw forbidden(
          "The person who proposed an allocation cannot approve it; a different owner or admin must authorise it.",
        );
      }
      const at = nowISO();
      await app.db
        .update(portfolioAllocations)
        .set({ status: "approved", approvedBy: req.user!.id, approvedAt: at, updatedAt: at })
        .where(
          and(eq(portfolioAllocations.id, allocationId), eq(portfolioAllocations.status, "planned")),
        );
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: row.projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "portfolio_allocation",
        objectId: allocationId,
        payload: { from: "planned", to: "approved", amount: row.amount, currency: row.currency },
        storePayload: true,
      });
      return fetchAllocation(allocationId, req.companyId!);
    },
  );

  /** Record a draw against approved authority. A money move: locked and checked. */
  app.post(
    "/portfolio/allocations/:allocationId/draw",
    { preHandler: companyAdminGate },
    async (req) => {
      const { allocationId } = req.params as { allocationId: string };
      const body = drawSchema.parse(req.body);
      const companyId = req.companyId!;
      const projectId = (await fetchAllocation(allocationId, companyId)).projectId;

      const after = await app.db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(portfolioAllocations)
          .where(
            and(
              eq(portfolioAllocations.id, allocationId),
              eq(portfolioAllocations.companyId, companyId),
            ),
          )
          .for("update");
        if (!locked) throw notFound("Allocation not found");
        if (locked.status !== "approved" && locked.status !== "drawn") {
          throw conflict(
            `Only an approved allocation can be drawn against; this one is ${locked.status}.`,
          );
        }
        const drawn = round2(locked.drawnAmount + body.amount);
        if (drawn > locked.amount + 0.005) {
          throw conflict(
            `Drawing ${body.amount} ${locked.currency} would take the total drawn to ${drawn} ${locked.currency}, beyond the ${locked.amount} ${locked.currency} allocated.`,
          );
        }
        await tx
          .update(portfolioAllocations)
          .set({
            drawnAmount: drawn,
            status: drawn >= locked.amount - 0.005 ? "drawn" : "approved",
            updatedAt: nowISO(),
          })
          .where(eq(portfolioAllocations.id, allocationId));
        return { before: locked.drawnAmount, drawn, currency: locked.currency };
      });

      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "portfolio_allocation",
        objectId: allocationId,
        payload: {
          drawnAmount: { from: after.before, to: after.drawn },
          amount: body.amount,
          currency: after.currency,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      return fetchAllocation(allocationId, companyId);
    },
  );

  app.post(
    "/portfolio/allocations/:allocationId/cancel",
    { preHandler: companyAdminGate },
    async (req) => {
      const { allocationId } = req.params as { allocationId: string };
      const body = z
        .object({ reason: z.string().min(1).max(2000) })
        .parse(req.body);
      const row = await fetchAllocation(allocationId, req.companyId!);
      if (row.status === "cancelled") return row;
      if (row.drawnAmount > 0.005) {
        throw conflict(
          `${row.drawnAmount} ${row.currency} has been drawn against this allocation; it can be released but not cancelled.`,
        );
      }
      await app.db
        .update(portfolioAllocations)
        .set({ status: "cancelled", notes: body.reason, updatedAt: nowISO() })
        .where(eq(portfolioAllocations.id, allocationId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: row.projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "portfolio_allocation",
        objectId: allocationId,
        payload: { from: row.status, to: "cancelled", reason: body.reason, released: row.amount },
        storePayload: true,
      });
      return fetchAllocation(allocationId, req.companyId!);
    },
  );

  /* ================================================================ */
  /* Affordability envelopes (#426)                                    */
  /* ================================================================ */

  async function fetchEnvelope(id: string, companyId: string) {
    const [row] = await app.db
      .select()
      .from(portfolioEnvelopes)
      .where(and(eq(portfolioEnvelopes.id, id), eq(portfolioEnvelopes.companyId, companyId)))
      .limit(1);
    if (!row) throw notFound("Envelope not found");
    return row;
  }

  app.get("/portfolio/envelopes", { preHandler: companyGate }, async (req) => {
    const q = envelopeList.parse(req.query);
    const clauses: SQL[] = [eq(portfolioEnvelopes.companyId, req.companyId!)];
    if (q.fiscalYear) clauses.push(eq(portfolioEnvelopes.fiscalYear, q.fiscalYear));
    if (q.status) clauses.push(eq(portfolioEnvelopes.status, q.status));
    if (q.portfolioId) clauses.push(eq(portfolioEnvelopes.portfolioId, q.portfolioId));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(portfolioEnvelopes).where(where);
    const items = await app.db
      .select()
      .from(portfolioEnvelopes)
      .where(where)
      .orderBy(desc(portfolioEnvelopes.fiscalYear), asc(portfolioEnvelopes.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/portfolio/envelopes", { preHandler: companyAdminGate }, async (req, reply) => {
    const body = envelopeCreate.parse(req.body);
    if (body.portfolioId) await assertPortfolio(app.db, req.companyId!, body.portfolioId);
    const id = newId("pev");
    await app.db.insert(portfolioEnvelopes).values({
      id,
      companyId: req.companyId!,
      portfolioId: body.portfolioId ?? null,
      name: body.name,
      fiscalYear: body.fiscalYear,
      currency: body.currency,
      envelopeAmount: body.envelopeAmount,
      basis: body.basis ?? null,
      expenditureClass: body.expenditureClass,
      notes: body.notes ?? null,
      createdBy: req.user!.id,
    });
    await ledger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "portfolio_envelope",
      objectId: id,
      payload: {
        fiscalYear: body.fiscalYear,
        currency: body.currency,
        envelopeAmount: body.envelopeAmount,
        basis: body.basis ?? null,
      },
      storePayload: true,
    });
    return reply.status(201).send(await fetchEnvelope(id, req.companyId!));
  });

  app.patch("/portfolio/envelopes/:envelopeId", { preHandler: companyAdminGate }, async (req) => {
    const { envelopeId } = req.params as { envelopeId: string };
    const body = envelopePatch.parse(req.body);
    const row = await fetchEnvelope(envelopeId, req.companyId!);
    if (row.status !== "draft") {
      throw conflict(
        "An active or superseded envelope is the ceiling a past decision was taken against and is not editable. Supersede it with a new one instead.",
      );
    }
    if (body.portfolioId) await assertPortfolio(app.db, req.companyId!, body.portfolioId);
    await app.db
      .update(portfolioEnvelopes)
      .set(patchSet(body as Record<string, unknown>))
      .where(eq(portfolioEnvelopes.id, envelopeId));
    await ledger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "portfolio_envelope",
      objectId: envelopeId,
      payload: { changed: Object.keys(body) },
    });
    return fetchEnvelope(envelopeId, req.companyId!);
  });

  /**
   * Activate an envelope. Only one envelope may be active per (portfolio,
   * fiscal year, currency, expenditure class) — two live ceilings over the
   * same money is not a control, it is a choice of answers.
   */
  app.post(
    "/portfolio/envelopes/:envelopeId/activate",
    { preHandler: companyAdminGate },
    async (req) => {
      const { envelopeId } = req.params as { envelopeId: string };
      const row = await fetchEnvelope(envelopeId, req.companyId!);
      if (row.status === "superseded") {
        throw conflict("A superseded envelope cannot be reactivated; create a new one.");
      }
      if (row.status === "active") return row;
      const clashes = await app.db
        .select()
        .from(portfolioEnvelopes)
        .where(
          and(
            eq(portfolioEnvelopes.companyId, req.companyId!),
            eq(portfolioEnvelopes.status, "active"),
            eq(portfolioEnvelopes.fiscalYear, row.fiscalYear),
            eq(portfolioEnvelopes.currency, row.currency),
            eq(portfolioEnvelopes.expenditureClass, row.expenditureClass),
          ),
        );
      const same = clashes.filter((c) => (c.portfolioId ?? null) === (row.portfolioId ?? null));
      const at = nowISO();
      for (const c of same) {
        await app.db
          .update(portfolioEnvelopes)
          .set({ status: "superseded", supersededById: row.id, updatedAt: at })
          .where(eq(portfolioEnvelopes.id, c.id));
        await ledger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "portfolio_envelope",
          objectId: c.id,
          payload: { from: "active", to: "superseded", supersededById: row.id },
          storePayload: true,
        });
      }
      await app.db
        .update(portfolioEnvelopes)
        .set({ status: "active", updatedAt: at })
        .where(eq(portfolioEnvelopes.id, envelopeId));
      await ledger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "portfolio_envelope",
        objectId: envelopeId,
        payload: {
          from: row.status,
          to: "active",
          superseded: same.map((c) => c.id),
          envelopeAmount: row.envelopeAmount,
          currency: row.currency,
        },
        storePayload: true,
      });
      return fetchEnvelope(envelopeId, req.companyId!);
    },
  );

  /** Envelope versus demand, with the allocations that make up the demand. */
  app.get("/portfolio/affordability", { preHandler: companyGate }, async (req) => {
    const q = z
      .object({ portfolioId: idSchema.optional(), fiscalYear: fiscalYearSchema.optional() })
      .parse(req.query);
    const envelopeClauses: SQL[] = [eq(portfolioEnvelopes.companyId, req.companyId!)];
    if (q.fiscalYear) envelopeClauses.push(eq(portfolioEnvelopes.fiscalYear, q.fiscalYear));
    if (q.portfolioId) envelopeClauses.push(eq(portfolioEnvelopes.portfolioId, q.portfolioId));
    const envelopeRows = await app.db
      .select()
      .from(portfolioEnvelopes)
      .where(and(...envelopeClauses));
    const envelopes: EnvelopeRow[] = envelopeRows.map((e) => ({
      id: e.id,
      name: e.name,
      portfolioId: e.portfolioId,
      fiscalYear: e.fiscalYear,
      currency: e.currency,
      envelopeAmount: e.envelopeAmount,
      expenditureClass: e.expenditureClass,
      status: e.status,
      basis: e.basis,
    }));

    let projectIds: string[] | null = null;
    if (q.portfolioId) {
      const rows = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(eq(projects.companyId, req.companyId!), eq(projects.portfolioId, q.portfolioId)),
        );
      projectIds = rows.map((r) => r.id);
    }
    const allocations = await loadAllocations(app.db, req.companyId!, { projectIds });
    const scoped = q.fiscalYear
      ? allocations.filter((a) => a.fiscalYear === q.fiscalYear)
      : allocations;
    const result = affordability(envelopes, scoped, { portfolioId: q.portfolioId ?? null });
    return {
      ...result,
      classificationSplit: classificationSplit(scoped),
      allocationCount: scoped.length,
      generatedAt: nowISO(),
    };
  });
};
