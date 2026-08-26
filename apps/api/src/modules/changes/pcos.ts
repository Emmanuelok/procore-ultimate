import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike } from "drizzle-orm";
import { z } from "zod";
import {
  changeLineItems,
  changeQuoteRequests,
  commitments,
  potentialChangeOrders,
  primeContracts,
  vendors,
} from "@constructos/db";
import { CHANGE_EVENT_SCOPES, CHANGE_REASONS, PCO_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { badRequest, conflict } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import { computed, ratio, round2, unavailable, type Component } from "./arithmetic.js";
import { recomputeEventRollup } from "./events.js";
import { lineTotals, registerLineRoutes } from "./lines.js";
import {
  actorOf,
  assertSegregation,
  assertTransition,
  buildLineRow,
  changeGates,
  changeLineSchema,
  companyOf,
  copyLineRow,
  detailSchema,
  fetchEvent,
  fetchPco,
  idSchema,
  isoDateSchema,
  ledgerChange,
  loadLines,
  moneySchema,
  nowIso,
  pad3,
  projectOf,
} from "./shared.js";

const pcoCreateSchema = z.object({
  changeEventId: idSchema.nullable().optional(),
  title: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  reason: z.enum(CHANGE_REASONS).nullable().optional(),
  scope: z.enum(CHANGE_EVENT_SCOPES).optional(),
  commitmentId: idSchema.nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  primeContractId: idSchema.nullable().optional(),
  estimatedAmount: moneySchema.optional(),
  scheduleImpactDays: z.number().int().min(0).max(3650).optional(),
  dueDate: isoDateSchema.nullable().optional(),
  detail: detailSchema.optional(),
  lines: z.array(changeLineSchema).max(500).optional(),
  /** copy the change event's cost lines forward instead of retyping them */
  copyEventLines: z.boolean().optional(),
});

const pcoPatchSchema = pcoCreateSchema
  .omit({ lines: true, copyEventLines: true, changeEventId: true })
  .partial();

const pcoListQuery = pageQuerySchema.extend({
  status: z.enum(PCO_STATUSES).optional(),
  changeEventId: idSchema.optional(),
  commitmentId: idSchema.optional(),
  vendorId: idSchema.optional(),
  search: z.string().max(200).optional(),
});

const priceSchema = z.object({
  /** state the figure you expect; refused when it disagrees with the lines */
  estimatedAmount: moneySchema.optional(),
  scheduleImpactDays: z.number().int().min(0).max(3650).optional(),
});

const rejectSchema = z.object({ rejectionReason: z.string().min(1).max(4000) });
const noChargeSchema = z.object({ reason: z.string().max(4000).nullable().optional() });

/** Statuses in which a PCO's cost lines may still move. */
const PCO_EDITABLE = ["draft", "pending_quote", "priced"] as const;
const PCO_FROZEN = PCO_STATUSES.filter((s) => !(PCO_EDITABLE as readonly string[]).includes(s));

/**
 * Recompute the PCO's own estimate from its lines. `amount` — the position
 * carried forward — is deliberately NOT touched here: it moves only when
 * somebody prices the PCO or accepts a subcontractor's quote, because the
 * number a COR is built on must have been chosen by a person.
 */
export async function recomputePcoEstimate(db: Db, pcoId: string): Promise<number> {
  const lines = await loadLines(db, "potential_change_order", pcoId);
  const estimatedAmount = round2(lines.reduce((s, l) => s + l.costAmount + l.taxAmount, 0));
  await db
    .update(potentialChangeOrders)
    .set({ estimatedAmount, updatedAt: nowIso() })
    .where(eq(potentialChangeOrders.id, pcoId));
  return estimatedAmount;
}

export const pcoRoutes: FastifyPluginAsync = async (app) => {
  const gates = changeGates(app);

  async function loadCommitment(commitmentId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(commitments)
      .where(
        and(
          eq(commitments.id, commitmentId),
          eq(commitments.companyId, companyId),
          eq(commitments.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) {
      throw badRequest(
        `commitmentId ${commitmentId} is not a commitment on this project. A PCO prices a change ` +
          "to a scope we have actually bought.",
      );
    }
    if (rows[0].status === "void" || rows[0].status === "terminated") {
      throw conflict(
        `Commitment ${rows[0].reference} is ${rows[0].status} — it cannot take a change order. ` +
          "Price this scope against a live commitment or as self-performed work.",
      );
    }
    return rows[0];
  }

  async function assertVendor(vendorId: string, companyId: string) {
    const rows = await app.db
      .select({ id: vendors.id, name: vendors.name, status: vendors.status })
      .from(vendors)
      .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw badRequest(`vendorId ${vendorId} is not in this company's directory.`);
    return rows[0];
  }

  async function assertPrimeContract(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select({ id: primeContracts.id, reference: primeContracts.reference })
      .from(primeContracts)
      .where(
        and(
          eq(primeContracts.id, id),
          eq(primeContracts.companyId, companyId),
          eq(primeContracts.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw badRequest(`primeContractId ${id} is not a prime contract on this project.`);
    return rows[0];
  }

  app.post(
    "/projects/:projectId/potential-change-orders",
    { preHandler: gates.standard },
    async (req, reply) => {
      const body = pcoCreateSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const actorId = actorOf(req);

      let vendorId = body.vendorId ?? null;
      let commitmentRef: string | null = null;
      if (body.commitmentId) {
        const commitment = await loadCommitment(body.commitmentId, companyId, projectId);
        commitmentRef = commitment.reference;
        // A PCO against a commitment inherits that commitment's vendor: two
        // spellings of "who is doing the work" is one too many.
        if (vendorId && commitment.vendorId && vendorId !== commitment.vendorId) {
          throw badRequest(
            `vendorId does not match commitment ${commitment.reference}, which is with a different ` +
              "vendor. A PCO prices one subcontractor's change to one subcontract.",
          );
        }
        vendorId = commitment.vendorId ?? vendorId;
      }
      if (vendorId) await assertVendor(vendorId, companyId);
      if (body.primeContractId) await assertPrimeContract(body.primeContractId, companyId, projectId);

      let event = null;
      if (body.changeEventId) {
        event = await fetchEvent(app.db, body.changeEventId, companyId, projectId);
        if (event.status === "void") {
          throw conflict(`Change event ${event.reference} is void — nothing to price.`);
        }
      }

      const number = await nextRecordNumber(app.db, projectId, "potential_change_order");
      const id = newId("pco");
      const reference = `PCO-${pad3(number)}`;

      const sourceLines =
        body.copyEventLines && event ? await loadLines(app.db, "change_event", event.id) : [];

      await app.db.transaction(async (tx) => {
        await tx.insert(potentialChangeOrders).values({
          id,
          companyId,
          projectId,
          changeEventId: event?.id ?? null,
          number,
          reference,
          title: body.title,
          description: body.description ?? null,
          status: "draft",
          reason: body.reason ?? event?.reason ?? null,
          scope: body.scope ?? event?.scope ?? "tbd",
          commitmentId: body.commitmentId ?? null,
          vendorId,
          primeContractId: body.primeContractId ?? event?.primeContractId ?? null,
          estimatedAmount: round2(body.estimatedAmount ?? 0),
          quotedAmount: 0,
          amount: 0,
          scheduleImpactDays: body.scheduleImpactDays ?? 0,
          noCharge: 0,
          dueDate: body.dueDate ?? null,
          detail: { ...(body.detail ?? {}), commitmentReference: commitmentRef },
          createdBy: actorId,
        });
        const ctx = {
          companyId,
          projectId,
          changeEventId: event?.id ?? null,
          createdBy: actorId,
        };
        let sort = 0;
        for (const source of sourceLines) {
          sort += 10;
          await tx.insert(changeLineItems).values(
            copyLineRow(source, ctx, "potential_change_order", id, sort),
          );
        }
        for (const line of body.lines ?? []) {
          sort += 10;
          await tx
            .insert(changeLineItems)
            .values(buildLineRow(ctx, "potential_change_order", id, line, sort));
        }
      });

      if (sourceLines.length > 0 || (body.lines ?? []).length > 0) {
        await recomputePcoEstimate(app.db, id);
      }
      if (event) await recomputeEventRollup(app.db, event.id);

      await ledgerChange(app.db, req, "create", "potential_change_order", id, {
        reference,
        title: body.title,
        changeEventId: event?.id ?? null,
        commitmentId: body.commitmentId ?? null,
        vendorId,
      });
      const created = await fetchPco(app.db, id, companyId, projectId);
      return reply.status(201).send(created);
    },
  );

  app.get(
    "/projects/:projectId/potential-change-orders",
    { preHandler: gates.read },
    async (req) => {
      const q = pcoListQuery.parse(req.query);
      const clauses = [
        eq(potentialChangeOrders.companyId, companyOf(req)),
        eq(potentialChangeOrders.projectId, projectOf(req)),
      ];
      if (q.status) clauses.push(eq(potentialChangeOrders.status, q.status));
      if (q.changeEventId) clauses.push(eq(potentialChangeOrders.changeEventId, q.changeEventId));
      if (q.commitmentId) clauses.push(eq(potentialChangeOrders.commitmentId, q.commitmentId));
      if (q.vendorId) clauses.push(eq(potentialChangeOrders.vendorId, q.vendorId));
      if (q.search) clauses.push(ilike(potentialChangeOrders.title, `%${q.search}%`));
      const where = and(...clauses);
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(potentialChangeOrders)
        .where(where);
      const items = await app.db
        .select()
        .from(potentialChangeOrders)
        .where(where)
        .orderBy(desc(potentialChangeOrders.number))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(items, Number(totalRow?.n ?? 0), q);
    },
  );

  app.get(
    "/projects/:projectId/potential-change-orders/:pcoId",
    { preHandler: gates.read },
    async (req) => {
      const { pcoId } = req.params as { pcoId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const pco = await fetchPco(app.db, pcoId, companyId, projectId);
      const [lines, quotes] = await Promise.all([
        loadLines(app.db, "potential_change_order", pcoId),
        app.db
          .select()
          .from(changeQuoteRequests)
          .where(eq(changeQuoteRequests.potentialChangeOrderId, pcoId))
          .orderBy(asc(changeQuoteRequests.number)),
      ]);
      return {
        pco,
        lines,
        totals: lineTotals(lines),
        quoteRequests: quotes,
        positions: pcoPositions(pco),
      };
    },
  );

  app.patch(
    "/projects/:projectId/potential-change-orders/:pcoId",
    { preHandler: gates.standard },
    async (req) => {
      const { pcoId } = req.params as { pcoId: string };
      const body = pcoPatchSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const pco = await fetchPco(app.db, pcoId, companyId, projectId);
      assertTransition(pco.status, PCO_EDITABLE, "potential change order", "edit");
      if (body.commitmentId) await loadCommitment(body.commitmentId, companyId, projectId);
      if (body.vendorId) await assertVendor(body.vendorId, companyId);
      if (body.primeContractId) {
        await assertPrimeContract(body.primeContractId, companyId, projectId);
      }
      const set: Record<string, unknown> = { updatedAt: nowIso() };
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined) continue;
        set[key] = key === "estimatedAmount" ? round2(value as number) : value;
      }
      await app.db
        .update(potentialChangeOrders)
        .set(set)
        .where(eq(potentialChangeOrders.id, pcoId));
      await ledgerChange(app.db, req, "update", "potential_change_order", pcoId, {
        reference: pco.reference,
        changed: Object.keys(body),
      });
      return fetchPco(app.db, pcoId, companyId, projectId);
    },
  );

  app.post(
    "/projects/:projectId/potential-change-orders/:pcoId/price",
    { preHandler: gates.standard },
    async (req) => {
      const { pcoId } = req.params as { pcoId: string };
      const body = priceSchema.parse(req.body ?? {});
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const pco = await fetchPco(app.db, pcoId, companyId, projectId);
      assertTransition(pco.status, ["draft", "pending_quote", "priced"], "potential change order", "price");

      const lines = await loadLines(app.db, "potential_change_order", pcoId);
      if (lines.length === 0) {
        throw badRequest(
          `${pco.reference} has no cost lines. A priced position with nothing underneath it is a ` +
            "guess wearing a number.",
        );
      }
      const totals = lineTotals(lines);
      const estimatedAmount = round2(totals.costSubtotal + totals.taxTotal);
      if (body.estimatedAmount !== undefined && Math.abs(body.estimatedAmount - estimatedAmount) > 0.005) {
        throw badRequest(
          `Stated estimate ${body.estimatedAmount.toFixed(2)} does not agree with the cost lines ` +
            `(${estimatedAmount.toFixed(2)}). Fix the lines, or send no figure and let them speak.`,
        );
      }
      /*
       * The position taken forward starts as our own estimate. Once a
       * subcontractor's quote has been ACCEPTED the accepted figure stands:
       * re-pricing the breakdown afterwards refreshes what we think it costs
       * without silently rewriting what we agreed to pay.
       */
      const amount = pco.quotedAmount !== 0 ? pco.amount : estimatedAmount;
      const now = nowIso();
      await app.db
        .update(potentialChangeOrders)
        .set({
          estimatedAmount,
          amount: amount === 0 ? estimatedAmount : amount,
          status: "priced",
          scheduleImpactDays: body.scheduleImpactDays ?? pco.scheduleImpactDays,
          updatedAt: now,
        })
        .where(eq(potentialChangeOrders.id, pcoId));
      if (pco.changeEventId) await recomputeEventRollup(app.db, pco.changeEventId);
      await ledgerChange(app.db, req, "state_change", "potential_change_order", pcoId, {
        reference: pco.reference,
        from: pco.status,
        to: "priced",
        estimatedAmount,
        lineCount: lines.length,
      });
      const after = await fetchPco(app.db, pcoId, companyId, projectId);
      return { pco: after, totals, positions: pcoPositions(after) };
    },
  );

  app.post(
    "/projects/:projectId/potential-change-orders/:pcoId/submit",
    { preHandler: gates.standard },
    async (req) => {
      const { pcoId } = req.params as { pcoId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const pco = await fetchPco(app.db, pcoId, companyId, projectId);
      assertTransition(pco.status, ["priced"], "potential change order", "submit");
      if (pco.amount === 0 && pco.noCharge === 0) {
        throw badRequest(
          `${pco.reference} carries no amount. Submit it as a no-charge change if the sub is ` +
            "absorbing it — a zero that means 'not yet priced' is not a position.",
        );
      }
      const now = nowIso();
      await app.db
        .update(potentialChangeOrders)
        .set({ status: "submitted", submittedBy: actorOf(req), submittedAt: now, updatedAt: now })
        .where(eq(potentialChangeOrders.id, pcoId));
      await ledgerChange(app.db, req, "state_change", "potential_change_order", pcoId, {
        reference: pco.reference,
        from: pco.status,
        to: "submitted",
        amount: pco.amount,
      });
      return fetchPco(app.db, pcoId, companyId, projectId);
    },
  );

  app.post(
    "/projects/:projectId/potential-change-orders/:pcoId/approve",
    { preHandler: gates.standard },
    async (req) => {
      const { pcoId } = req.params as { pcoId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const actorId = actorOf(req);
      const pco = await fetchPco(app.db, pcoId, companyId, projectId);
      assertTransition(pco.status, ["submitted"], "potential change order", "approve");
      assertSegregation(
        actorId,
        { createdBy: pco.createdBy, submittedBy: pco.submittedBy },
        "potential change order",
      );
      const now = nowIso();
      await app.db
        .update(potentialChangeOrders)
        .set({ status: "approved", approvedBy: actorId, approvedAt: now, updatedAt: now })
        .where(eq(potentialChangeOrders.id, pcoId));
      if (pco.changeEventId) await recomputeEventRollup(app.db, pco.changeEventId);
      await ledgerChange(app.db, req, "state_change", "potential_change_order", pcoId, {
        reference: pco.reference,
        from: pco.status,
        to: "approved",
        amount: pco.amount,
        submittedBy: pco.submittedBy,
        approvedBy: actorId,
      });
      return fetchPco(app.db, pcoId, companyId, projectId);
    },
  );

  app.post(
    "/projects/:projectId/potential-change-orders/:pcoId/reject",
    { preHandler: gates.standard },
    async (req) => {
      const { pcoId } = req.params as { pcoId: string };
      const body = rejectSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const actorId = actorOf(req);
      const pco = await fetchPco(app.db, pcoId, companyId, projectId);
      assertTransition(pco.status, ["submitted", "priced"], "potential change order", "reject");
      assertSegregation(
        actorId,
        { createdBy: pco.createdBy, submittedBy: pco.submittedBy },
        "potential change order",
      );
      const now = nowIso();
      await app.db
        .update(potentialChangeOrders)
        .set({
          status: "rejected",
          rejectedBy: actorId,
          rejectedAt: now,
          rejectionReason: body.rejectionReason,
          updatedAt: now,
        })
        .where(eq(potentialChangeOrders.id, pcoId));
      if (pco.changeEventId) await recomputeEventRollup(app.db, pco.changeEventId);
      await ledgerChange(app.db, req, "state_change", "potential_change_order", pcoId, {
        reference: pco.reference,
        from: pco.status,
        to: "rejected",
        rejectionReason: body.rejectionReason,
      });
      return fetchPco(app.db, pcoId, companyId, projectId);
    },
  );

  app.post(
    "/projects/:projectId/potential-change-orders/:pcoId/no-charge",
    { preHandler: gates.standard },
    async (req) => {
      const { pcoId } = req.params as { pcoId: string };
      const body = noChargeSchema.parse(req.body ?? {});
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const pco = await fetchPco(app.db, pcoId, companyId, projectId);
      assertTransition(
        pco.status,
        ["draft", "pending_quote", "priced", "submitted"],
        "potential change order",
        "mark no-charge",
      );
      const now = nowIso();
      await app.db
        .update(potentialChangeOrders)
        .set({
          status: "no_charge",
          noCharge: 1,
          amount: 0,
          detail: { ...(pco.detail ?? {}), noChargeReason: body.reason ?? null },
          updatedAt: now,
        })
        .where(eq(potentialChangeOrders.id, pcoId));
      if (pco.changeEventId) await recomputeEventRollup(app.db, pco.changeEventId);
      await ledgerChange(app.db, req, "state_change", "potential_change_order", pcoId, {
        reference: pco.reference,
        from: pco.status,
        to: "no_charge",
        // A no-charge change is RECORDED rather than deleted: "how many
        // changes did this subcontractor absorb" is a real commercial question.
        previousAmount: pco.amount,
      });
      return fetchPco(app.db, pcoId, companyId, projectId);
    },
  );

  app.post(
    "/projects/:projectId/potential-change-orders/:pcoId/void",
    { preHandler: gates.standard },
    async (req) => {
      const { pcoId } = req.params as { pcoId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const pco = await fetchPco(app.db, pcoId, companyId, projectId);
      if (pco.changeOrderPackageId) {
        throw conflict(
          `${pco.reference} is inside change order package and cannot be voided. Void the package ` +
            "instead, or raise a reversing change.",
        );
      }
      assertTransition(
        pco.status,
        ["draft", "pending_quote", "priced", "submitted", "rejected"],
        "potential change order",
        "void",
      );
      await app.db
        .update(potentialChangeOrders)
        .set({ status: "void", updatedAt: nowIso() })
        .where(eq(potentialChangeOrders.id, pcoId));
      if (pco.changeEventId) await recomputeEventRollup(app.db, pco.changeEventId);
      await ledgerChange(app.db, req, "state_change", "potential_change_order", pcoId, {
        reference: pco.reference,
        from: pco.status,
        to: "void",
      });
      return fetchPco(app.db, pcoId, companyId, projectId);
    },
  );

  registerLineRoutes(app, gates, {
    parentType: "potential_change_order",
    objectType: "potential_change_order",
    basePath: "/projects/:projectId/potential-change-orders/:pcoId",
    paramName: "pcoId",
    label: "Potential change order",
    frozenStatuses: PCO_FROZEN,
    fetch: async (db, id, companyId, projectId) => {
      const row = await fetchPco(db, id, companyId, projectId);
      return {
        id: row.id,
        reference: row.reference,
        status: row.status,
        changeEventId: row.changeEventId,
      };
    },
    afterChange: async (db, pcoId) => {
      await recomputePcoEstimate(db, pcoId);
    },
  });
};

/* ------------------------------------------------------------------ */
/* The three positions                                                 */
/* ------------------------------------------------------------------ */

export interface PcoPositions {
  estimatedAmount: number;
  quotedAmount: number;
  amount: number;
  /** quoted − estimated: the number a PM needs before it reaches a COR */
  quoteVariance: Component;
  quoteVariancePercent: Component;
}

/**
 * Our estimate, the sub's quote and the position we are taking forward are
 * three different numbers and the module never collapses them. The variance
 * between the first two is the single most useful early warning in change
 * management: a sub quoting 40% over estimate is a negotiation, not a
 * data-entry step.
 */
export function pcoPositions(pco: {
  estimatedAmount: number;
  quotedAmount: number;
  amount: number;
}): PcoPositions {
  const hasBoth = pco.quotedAmount !== 0 && pco.estimatedAmount !== 0;
  return {
    estimatedAmount: round2(pco.estimatedAmount),
    quotedAmount: round2(pco.quotedAmount),
    amount: round2(pco.amount),
    quoteVariance: hasBoth
      ? computed(pco.quotedAmount - pco.estimatedAmount, {
          quoted: round2(pco.quotedAmount),
          estimated: round2(pco.estimatedAmount),
        })
      : unavailable(
          [
            "A quote variance needs both our estimate and the subcontractor's quote; this PCO " +
              "holds only one of them.",
          ],
          { quoted: round2(pco.quotedAmount), estimated: round2(pco.estimatedAmount) },
        ),
    quoteVariancePercent: hasBoth
      ? ratio(pco.quotedAmount - pco.estimatedAmount, pco.estimatedAmount, "Quote variance")
      : unavailable(["No estimate to measure the quote against."], {}),
  };
}
