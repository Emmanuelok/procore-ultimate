import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  changeLineItems,
  changeQuoteRequests,
  potentialChangeOrders,
  vendors,
} from "@constructos/db";
import { QUOTE_REQUEST_STATUSES } from "@constructos/shared";
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
  assertTransition,
  buildLineRow,
  changeGates,
  changeLineSchema,
  companyOf,
  detailSchema,
  fetchPco,
  fetchQuote,
  idSchema,
  isoDateSchema,
  ledgerChange,
  loadLines,
  moneySchema,
  nowIso,
  pad3,
  projectOf,
  todayIso,
} from "./shared.js";

const quoteCreateSchema = z.object({
  vendorId: idSchema,
  vendorContactId: idSchema.nullable().optional(),
  title: z.string().min(1).max(300).optional(),
  scopeDescription: z.string().max(20000).nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  detail: detailSchema.optional(),
  lines: z.array(changeLineSchema).max(500).optional(),
  /** send the PCO's own cost breakdown out with the request */
  copyPcoLines: z.boolean().optional(),
});

const quotePatchSchema = quoteCreateSchema.omit({ lines: true, copyPcoLines: true }).partial();

const quoteListQuery = pageQuerySchema.extend({
  status: z.enum(QUOTE_REQUEST_STATUSES).optional(),
  potentialChangeOrderId: idSchema.optional(),
  vendorId: idSchema.optional(),
});

const recordQuoteSchema = z.object({
  quotedAmount: moneySchema,
  quotedScheduleImpactDays: z.number().int().min(0).max(3650).optional(),
  quoteNotes: z.string().max(20000).nullable().optional(),
  quoteValidUntil: isoDateSchema.nullable().optional(),
  quoteDocumentIds: z.array(idSchema).max(200).optional(),
  respondedAt: z.string().min(4).optional(),
});

const declineSchema = z.object({ declineReason: z.string().min(1).max(4000) });

const acceptSchema = z.object({
  /** accept a figure other than the one quoted — negotiated down, in writing */
  amount: moneySchema.optional(),
  notes: z.string().max(4000).nullable().optional(),
});

/** The RFQ itself is editable only before it goes out. */
const QUOTE_EDITABLE = ["draft"] as const;
/**
 * Its LINES stay open a little longer, through "quoted": the scope we sent is
 * one thing, the breakdown the subcontractor sent back is another, and the
 * second belongs on the same record. Acceptance freezes both.
 */
const QUOTE_FROZEN = QUOTE_REQUEST_STATUSES.filter(
  (s) => !["draft", "quoted"].includes(s),
);

const isExpiredQuote = (validUntil: string | null, today = todayIso()): boolean =>
  validUntil !== null && validUntil < today;

const daysBetweenIso = (from: string, to: string): number =>
  Math.round(((Date.parse(to) - Date.parse(from)) / 86_400_000) * 10) / 10;

export const quoteRoutes: FastifyPluginAsync = async (app) => {
  const gates = changeGates(app);

  app.post(
    "/projects/:projectId/potential-change-orders/:pcoId/quote-requests",
    { preHandler: gates.standard },
    async (req, reply) => {
      const { pcoId } = req.params as { pcoId: string };
      const body = quoteCreateSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const actorId = actorOf(req);
      const pco = await fetchPco(app.db, pcoId, companyId, projectId);
      assertTransition(
        pco.status,
        ["draft", "pending_quote", "priced"],
        "potential change order",
        "request a quote against",
      );

      const vendor = await app.db
        .select({ id: vendors.id, name: vendors.name })
        .from(vendors)
        .where(and(eq(vendors.id, body.vendorId), eq(vendors.companyId, companyId)))
        .limit(1);
      if (!vendor[0]) throw badRequest(`vendorId ${body.vendorId} is not in this company's directory.`);

      const existing = await app.db
        .select({ id: changeQuoteRequests.id, status: changeQuoteRequests.status })
        .from(changeQuoteRequests)
        .where(
          and(
            eq(changeQuoteRequests.potentialChangeOrderId, pcoId),
            eq(changeQuoteRequests.vendorId, body.vendorId),
          ),
        );
      if (existing.some((q) => q.status !== "void" && q.status !== "declined")) {
        throw conflict(
          `${vendor[0].name} already has a live quote request against ${pco.reference}. Two open ` +
            "RFQs to one subcontractor for one change is how you end up with two prices for it.",
        );
      }

      const number = await nextRecordNumber(app.db, projectId, "change_quote_request");
      const id = newId("rfq");
      const reference = `RFQ-${pad3(number)}`;
      const sourceLines = body.copyPcoLines
        ? await loadLines(app.db, "potential_change_order", pcoId)
        : [];

      await app.db.transaction(async (tx) => {
        await tx.insert(changeQuoteRequests).values({
          id,
          companyId,
          projectId,
          changeEventId: pco.changeEventId,
          potentialChangeOrderId: pcoId,
          commitmentId: pco.commitmentId,
          vendorId: body.vendorId,
          vendorContactId: body.vendorContactId ?? null,
          number,
          reference,
          title: body.title ?? pco.title,
          scopeDescription: body.scopeDescription ?? pco.description ?? null,
          status: "draft",
          dueDate: body.dueDate ?? pco.dueDate ?? null,
          quoteDocumentIds: [],
          detail: { ...(body.detail ?? {}), vendorName: vendor[0]!.name },
          createdBy: actorId,
        });
        const ctx = {
          companyId,
          projectId,
          changeEventId: pco.changeEventId,
          createdBy: actorId,
        };
        let sort = 0;
        for (const source of sourceLines) {
          sort += 10;
          await tx.insert(changeLineItems).values({
            ...buildLineRow(
              ctx,
              "change_quote_request",
              id,
              {
                description: source.description,
                lineNumber: source.lineNumber,
                sortOrder: sort,
                costCode: source.costCode,
                costCodeId: source.costCodeId,
                costType: (source.costType ?? "other") as never,
                budgetLineItemId: source.budgetLineItemId,
                unit: source.unit,
                quantity: source.quantity,
                unitRate: source.unitRate,
                costAmount: source.costAmount,
                vendorId: body.vendorId,
              },
              sort,
            ),
          });
        }
        for (const line of body.lines ?? []) {
          sort += 10;
          await tx
            .insert(changeLineItems)
            .values(buildLineRow(ctx, "change_quote_request", id, line, sort));
        }
      });

      await ledgerChange(app.db, req, "create", "change_quote_request", id, {
        reference,
        potentialChangeOrderId: pcoId,
        vendorId: body.vendorId,
        dueDate: body.dueDate ?? null,
      });
      const created = await fetchQuote(app.db, id, companyId, projectId);
      return reply.status(201).send(created);
    },
  );

  app.get("/projects/:projectId/quote-requests", { preHandler: gates.read }, async (req) => {
    const q = quoteListQuery.parse(req.query);
    const clauses = [
      eq(changeQuoteRequests.companyId, companyOf(req)),
      eq(changeQuoteRequests.projectId, projectOf(req)),
    ];
    if (q.status) clauses.push(eq(changeQuoteRequests.status, q.status));
    if (q.potentialChangeOrderId) {
      clauses.push(eq(changeQuoteRequests.potentialChangeOrderId, q.potentialChangeOrderId));
    }
    if (q.vendorId) clauses.push(eq(changeQuoteRequests.vendorId, q.vendorId));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(changeQuoteRequests).where(where);
    const items = await app.db
      .select()
      .from(changeQuoteRequests)
      .where(where)
      .orderBy(desc(changeQuoteRequests.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      items.map((row) => ({ ...row, expired: isExpiredQuote(row.quoteValidUntil) })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.get(
    "/projects/:projectId/quote-requests/:quoteId",
    { preHandler: gates.read },
    async (req) => {
      const { quoteId } = req.params as { quoteId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const quote = await fetchQuote(app.db, quoteId, companyId, projectId);
      const lines = await loadLines(app.db, "change_quote_request", quoteId);
      return {
        quoteRequest: { ...quote, expired: isExpiredQuote(quote.quoteValidUntil) },
        lines,
        totals: lineTotals(lines),
        turnaroundDays:
          quote.sentAt && quote.respondedAt
            ? daysBetweenIso(quote.sentAt, quote.respondedAt)
            : null,
      };
    },
  );

  app.patch(
    "/projects/:projectId/quote-requests/:quoteId",
    { preHandler: gates.standard },
    async (req) => {
      const { quoteId } = req.params as { quoteId: string };
      const body = quotePatchSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const quote = await fetchQuote(app.db, quoteId, companyId, projectId);
      assertTransition(quote.status, QUOTE_EDITABLE, "quote request", "edit");
      const set: Record<string, unknown> = { updatedAt: nowIso() };
      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined) set[key] = value;
      }
      await app.db.update(changeQuoteRequests).set(set).where(eq(changeQuoteRequests.id, quoteId));
      await ledgerChange(app.db, req, "update", "change_quote_request", quoteId, {
        reference: quote.reference,
        changed: Object.keys(body),
      });
      return fetchQuote(app.db, quoteId, companyId, projectId);
    },
  );

  app.post(
    "/projects/:projectId/quote-requests/:quoteId/send",
    { preHandler: gates.standard },
    async (req) => {
      const { quoteId } = req.params as { quoteId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const quote = await fetchQuote(app.db, quoteId, companyId, projectId);
      assertTransition(quote.status, ["draft"], "quote request", "send");
      if (!quote.vendorId) throw badRequest("A quote request needs a vendor before it can be sent.");
      if (!quote.dueDate) {
        throw badRequest(
          "A quote request needs a due date. The commonest cause of a change order stalling is a " +
            "subcontractor who never answered, and that has to be measurable in days.",
        );
      }
      const now = nowIso();
      await app.db.transaction(async (tx) => {
        await tx
          .update(changeQuoteRequests)
          .set({ status: "sent", sentAt: now, sentBy: actorOf(req), updatedAt: now })
          .where(eq(changeQuoteRequests.id, quoteId));
        if (quote.potentialChangeOrderId) {
          const [pco] = await tx
            .select()
            .from(potentialChangeOrders)
            .where(eq(potentialChangeOrders.id, quote.potentialChangeOrderId))
            .limit(1);
          if (pco && pco.status === "draft") {
            await tx
              .update(potentialChangeOrders)
              .set({ status: "pending_quote", updatedAt: now })
              .where(eq(potentialChangeOrders.id, pco.id));
          }
        }
      });
      await ledgerChange(app.db, req, "state_change", "change_quote_request", quoteId, {
        reference: quote.reference,
        from: quote.status,
        to: "sent",
        vendorId: quote.vendorId,
        dueDate: quote.dueDate,
      });
      return fetchQuote(app.db, quoteId, companyId, projectId);
    },
  );

  app.post(
    "/projects/:projectId/quote-requests/:quoteId/view",
    { preHandler: gates.standard },
    async (req) => {
      const { quoteId } = req.params as { quoteId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const quote = await fetchQuote(app.db, quoteId, companyId, projectId);
      assertTransition(quote.status, ["sent"], "quote request", "mark viewed on");
      const now = nowIso();
      await app.db
        .update(changeQuoteRequests)
        .set({ status: "viewed", viewedAt: quote.viewedAt ?? now, updatedAt: now })
        .where(eq(changeQuoteRequests.id, quoteId));
      return fetchQuote(app.db, quoteId, companyId, projectId);
    },
  );

  app.post(
    "/projects/:projectId/quote-requests/:quoteId/quote",
    { preHandler: gates.standard },
    async (req) => {
      const { quoteId } = req.params as { quoteId: string };
      const body = recordQuoteSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const quote = await fetchQuote(app.db, quoteId, companyId, projectId);
      assertTransition(quote.status, ["sent", "viewed", "quoted"], "quote request", "record a quote against");
      const now = nowIso();
      await app.db
        .update(changeQuoteRequests)
        .set({
          status: "quoted",
          quotedAmount: round2(body.quotedAmount),
          quotedScheduleImpactDays: body.quotedScheduleImpactDays ?? null,
          quoteNotes: body.quoteNotes ?? null,
          quoteValidUntil: body.quoteValidUntil ?? null,
          quoteDocumentIds: body.quoteDocumentIds ?? quote.quoteDocumentIds,
          respondedAt: body.respondedAt ?? now,
          updatedAt: now,
        })
        .where(eq(changeQuoteRequests.id, quoteId));
      await ledgerChange(app.db, req, "state_change", "change_quote_request", quoteId, {
        reference: quote.reference,
        from: quote.status,
        to: "quoted",
        quotedAmount: round2(body.quotedAmount),
        quotedScheduleImpactDays: body.quotedScheduleImpactDays ?? null,
      });
      return fetchQuote(app.db, quoteId, companyId, projectId);
    },
  );

  app.post(
    "/projects/:projectId/quote-requests/:quoteId/decline",
    { preHandler: gates.standard },
    async (req) => {
      const { quoteId } = req.params as { quoteId: string };
      const body = declineSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const quote = await fetchQuote(app.db, quoteId, companyId, projectId);
      assertTransition(quote.status, ["sent", "viewed", "quoted"], "quote request", "decline");
      const now = nowIso();
      await app.db
        .update(changeQuoteRequests)
        .set({
          status: "declined",
          declinedAt: now,
          declineReason: body.declineReason,
          updatedAt: now,
        })
        .where(eq(changeQuoteRequests.id, quoteId));
      await ledgerChange(app.db, req, "state_change", "change_quote_request", quoteId, {
        reference: quote.reference,
        from: quote.status,
        to: "declined",
        declineReason: body.declineReason,
      });
      return fetchQuote(app.db, quoteId, companyId, projectId);
    },
  );

  /**
   * Accepting a quote is the moment a subcontractor's number becomes OUR
   * position. It writes the PCO's `quotedAmount` and `amount` together, so the
   * estimate the PCO started with survives beside them and the variance stays
   * visible after the fact.
   */
  app.post(
    "/projects/:projectId/quote-requests/:quoteId/accept",
    { preHandler: gates.standard },
    async (req) => {
      const { quoteId } = req.params as { quoteId: string };
      const body = acceptSchema.parse(req.body ?? {});
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const quote = await fetchQuote(app.db, quoteId, companyId, projectId);
      assertTransition(quote.status, ["quoted"], "quote request", "accept");
      if (quote.quotedAmount === null) {
        throw badRequest(`${quote.reference} carries no quoted amount to accept.`);
      }
      if (isExpiredQuote(quote.quoteValidUntil)) {
        throw conflict(
          `${quote.reference} expired on ${quote.quoteValidUntil}. Ask the subcontractor to ` +
            "re-quote rather than binding them to a lapsed price.",
        );
      }
      if (!quote.potentialChangeOrderId) {
        throw badRequest(
          `${quote.reference} is not attached to a potential change order, so there is nothing for ` +
            "an accepted price to become.",
        );
      }
      const pco = await fetchPco(app.db, quote.potentialChangeOrderId, companyId, projectId);
      const siblings = await app.db
        .select()
        .from(changeQuoteRequests)
        .where(eq(changeQuoteRequests.potentialChangeOrderId, pco.id));
      const alreadyAccepted = siblings.find((s) => s.id !== quoteId && s.status === "accepted");
      if (alreadyAccepted) {
        throw conflict(
          `${alreadyAccepted.reference} has already been accepted against ${pco.reference}. One ` +
            "PCO carries one price; raise a second PCO if a second subcontractor is doing part of it.",
        );
      }

      const accepted = round2(body.amount ?? quote.quotedAmount);
      if (body.amount !== undefined && Math.abs(accepted) > Math.abs(quote.quotedAmount) + 0.005) {
        throw badRequest(
          `Accepting ${accepted.toFixed(2)} against a quote of ${quote.quotedAmount.toFixed(2)} ` +
            "would pay more than was quoted. Ask for a revised quote instead.",
        );
      }

      const now = nowIso();
      await app.db.transaction(async (tx) => {
        await tx
          .update(changeQuoteRequests)
          .set({ status: "accepted", acceptedAt: now, acceptedBy: actorOf(req), updatedAt: now })
          .where(eq(changeQuoteRequests.id, quoteId));
        await tx
          .update(potentialChangeOrders)
          .set({
            quotedAmount: round2(quote.quotedAmount!),
            amount: accepted,
            scheduleImpactDays: quote.quotedScheduleImpactDays ?? pco.scheduleImpactDays,
            status: pco.status === "submitted" || pco.status === "approved" ? pco.status : "priced",
            detail: {
              ...(pco.detail ?? {}),
              acceptedQuoteId: quoteId,
              acceptedQuoteReference: quote.reference,
              acceptedAmount: accepted,
              acceptanceNotes: body.notes ?? null,
            },
            updatedAt: now,
          })
          .where(eq(potentialChangeOrders.id, pco.id));
      });

      if (pco.changeEventId) await recomputeEventRollup(app.db, pco.changeEventId);
      await ledgerChange(app.db, req, "state_change", "change_quote_request", quoteId, {
        reference: quote.reference,
        from: quote.status,
        to: "accepted",
        potentialChangeOrderId: pco.id,
        quotedAmount: round2(quote.quotedAmount),
        acceptedAmount: accepted,
        estimatedAmount: pco.estimatedAmount,
      });
      return {
        quoteRequest: await fetchQuote(app.db, quoteId, companyId, projectId),
        pco: await fetchPco(app.db, pco.id, companyId, projectId),
        supersededQuotes: siblings
          .filter((s) => s.id !== quoteId && s.status === "quoted")
          .map((s) => ({ id: s.id, reference: s.reference, quotedAmount: s.quotedAmount })),
      };
    },
  );

  app.post(
    "/projects/:projectId/quote-requests/:quoteId/void",
    { preHandler: gates.standard },
    async (req) => {
      const { quoteId } = req.params as { quoteId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const quote = await fetchQuote(app.db, quoteId, companyId, projectId);
      assertTransition(
        quote.status,
        ["draft", "sent", "viewed", "quoted", "declined", "expired"],
        "quote request",
        "void",
      );
      await app.db
        .update(changeQuoteRequests)
        .set({ status: "void", updatedAt: nowIso() })
        .where(eq(changeQuoteRequests.id, quoteId));
      await ledgerChange(app.db, req, "state_change", "change_quote_request", quoteId, {
        reference: quote.reference,
        from: quote.status,
        to: "void",
      });
      return fetchQuote(app.db, quoteId, companyId, projectId);
    },
  );

  /* ---------------- comparison ---------------- */

  app.get(
    "/projects/:projectId/potential-change-orders/:pcoId/quote-comparison",
    { preHandler: gates.read },
    async (req) => {
      const { pcoId } = req.params as { pcoId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const pco = await fetchPco(app.db, pcoId, companyId, projectId);
      const quotes = await app.db
        .select()
        .from(changeQuoteRequests)
        .where(eq(changeQuoteRequests.potentialChangeOrderId, pcoId))
        .orderBy(asc(changeQuoteRequests.number));
      const vendorIds = [...new Set(quotes.map((q) => q.vendorId).filter((v): v is string => !!v))];
      const vendorRows =
        vendorIds.length > 0
          ? await app.db
              .select({ id: vendors.id, name: vendors.name })
              .from(vendors)
              .where(inArray(vendors.id, vendorIds))
          : [];
      const vendorName = new Map(vendorRows.map((v) => [v.id, v.name]));
      return compareQuotes(pco, quotes, vendorName);
    },
  );

  registerLineRoutes(app, gates, {
    parentType: "change_quote_request",
    objectType: "change_quote_request",
    basePath: "/projects/:projectId/quote-requests/:quoteId",
    paramName: "quoteId",
    label: "Quote request",
    frozenStatuses: QUOTE_FROZEN,
    fetch: async (db: Db, id, companyId, projectId) => {
      const row = await fetchQuote(db, id, companyId, projectId);
      return {
        id: row.id,
        reference: row.reference,
        status: row.status,
        changeEventId: row.changeEventId,
      };
    },
  });
};

/* ------------------------------------------------------------------ */
/* Bid comparison                                                      */
/* ------------------------------------------------------------------ */

export interface QuoteComparisonRow {
  id: string;
  reference: string;
  vendorId: string | null;
  vendorName: string | null;
  status: string;
  quotedAmount: number | null;
  quotedScheduleImpactDays: number | null;
  quoteValidUntil: string | null;
  expired: boolean;
  respondedAt: string | null;
  turnaroundDays: number | null;
  varianceAgainstEstimate: Component;
  varianceAgainstLowest: Component;
  /** 1 = cheapest responding quote */
  rank: number | null;
}

export interface QuoteComparison {
  potentialChangeOrderId: string;
  reference: string;
  estimatedAmount: number;
  quotes: QuoteComparisonRow[];
  coverage: {
    requested: number;
    responded: number;
    outstanding: number;
    declined: number;
    accepted: number;
  };
  lowest: Component;
  highest: Component;
  spread: Component;
  recommendation: string;
}

/**
 * Compare what came back. The comparison is deliberately blunt about what it
 * does NOT know: with no returned quote, "lowest" is null with a reason rather
 * than 0, because a screen that renders 0.00 for "nobody has answered" is how
 * a PM signs a change order believing it was competitively priced.
 */
export function compareQuotes(
  pco: { id: string; reference: string; estimatedAmount: number; amount: number },
  quotes: ReadonlyArray<{
    id: string;
    reference: string;
    vendorId: string | null;
    status: string;
    quotedAmount: number | null;
    quotedScheduleImpactDays: number | null;
    quoteValidUntil: string | null;
    sentAt: string | null;
    respondedAt: string | null;
  }>,
  vendorName: Map<string, string>,
  today = todayIso(),
): QuoteComparison {
  const live = quotes.filter((q) => q.status !== "void");
  const responded = live.filter(
    (q) => (q.status === "quoted" || q.status === "accepted") && q.quotedAmount !== null,
  );
  const amounts = responded
    .map((q) => q.quotedAmount)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  const lowestValue = amounts[0] ?? null;
  const highestValue = amounts[amounts.length - 1] ?? null;

  const rankOf = new Map<string, number>();
  [...responded]
    .sort((a, b) => (a.quotedAmount ?? 0) - (b.quotedAmount ?? 0))
    .forEach((q, i) => rankOf.set(q.id, i + 1));

  const rows: QuoteComparisonRow[] = live.map((q) => {
    const has = q.quotedAmount !== null;
    return {
      id: q.id,
      reference: q.reference,
      vendorId: q.vendorId,
      vendorName: q.vendorId ? (vendorName.get(q.vendorId) ?? null) : null,
      status: q.status,
      quotedAmount: has ? round2(q.quotedAmount!) : null,
      quotedScheduleImpactDays: q.quotedScheduleImpactDays,
      quoteValidUntil: q.quoteValidUntil,
      expired: isExpiredQuote(q.quoteValidUntil, today),
      respondedAt: q.respondedAt,
      turnaroundDays: q.sentAt && q.respondedAt ? daysBetweenIso(q.sentAt, q.respondedAt) : null,
      varianceAgainstEstimate:
        has && pco.estimatedAmount !== 0
          ? computed(q.quotedAmount! - pco.estimatedAmount, {
              quoted: round2(q.quotedAmount!),
              estimated: round2(pco.estimatedAmount),
            })
          : unavailable(
              has
                ? ["The PCO carries no estimate to measure this quote against."]
                : ["This subcontractor has not returned a price."],
              { quoted: has ? round2(q.quotedAmount!) : null, estimated: round2(pco.estimatedAmount) },
            ),
      varianceAgainstLowest:
        has && lowestValue !== null
          ? computed(q.quotedAmount! - lowestValue, { lowest: round2(lowestValue) })
          : unavailable(["No returned quote to compare against."], {}),
      rank: rankOf.get(q.id) ?? null,
    };
  });

  const outstanding = live.filter((q) => q.status === "sent" || q.status === "viewed").length;
  const declined = live.filter((q) => q.status === "declined" || q.status === "expired").length;
  const accepted = live.filter((q) => q.status === "accepted").length;

  const noResponses = ["No subcontractor has returned a price against this PCO yet."];
  const lowest = lowestValue !== null ? computed(lowestValue) : unavailable(noResponses);
  const highest = highestValue !== null ? computed(highestValue) : unavailable(noResponses);
  const spread =
    amounts.length >= 2
      ? computed(highestValue! - lowestValue!, { quotes: amounts.length })
      : unavailable(
          [
            amounts.length === 1
              ? "Only one price has come back — there is no spread to report, and no competitive tension either."
              : noResponses[0]!,
          ],
          { quotes: amounts.length },
        );

  let recommendation: string;
  if (accepted > 0) {
    const won = live.find((q) => q.status === "accepted");
    recommendation = `${won?.reference} accepted at ${round2(pco.amount).toFixed(2)}.`;
  } else if (responded.length === 0) {
    recommendation =
      outstanding > 0
        ? `${outstanding} request(s) outstanding and no price back. Chase before pricing the COR.`
        : "No quote requests have been sent — this PCO rests on our own estimate alone.";
  } else if (responded.length === 1) {
    const only = responded[0]!;
    recommendation =
      `Single price from ${only.vendorId ? (vendorName.get(only.vendorId) ?? "one subcontractor") : "one subcontractor"} ` +
      `at ${round2(only.quotedAmount!).toFixed(2)}. Competitive tension is absent — say so to the owner rather than implying it existed.`;
  } else {
    const cheapest = responded.reduce((a, b) => ((a.quotedAmount ?? 0) <= (b.quotedAmount ?? 0) ? a : b));
    recommendation =
      `${responded.length} prices back, low ${round2(lowestValue!).toFixed(2)} (${cheapest.reference}), ` +
      `high ${round2(highestValue!).toFixed(2)} — a spread of ${round2(highestValue! - lowestValue!).toFixed(2)}.`;
  }

  return {
    potentialChangeOrderId: pco.id,
    reference: pco.reference,
    estimatedAmount: round2(pco.estimatedAmount),
    quotes: rows,
    coverage: {
      requested: live.length,
      responded: responded.length,
      outstanding,
      declined,
      accepted,
    },
    lowest,
    highest,
    spread,
    recommendation,
  };
}

export { isExpiredQuote, daysBetweenIso };
