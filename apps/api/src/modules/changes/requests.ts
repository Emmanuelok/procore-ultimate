import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  changeLineItems,
  changeOrderRequests,
  commitments,
  delayEvents,
  potentialChangeOrders,
  primeContracts,
  projects,
} from "@constructos/db";
import { CHANGE_REASONS, COR_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import {
  applyMarkupStack,
  markupIdentities,
  ratio,
  round2,
  stackTotal,
  validateMarkupStack,
  type MarkupRule,
  type MarkupStackResult,
} from "./arithmetic.js";
import { assessCorTimeImpact, type DelayEventRow } from "./reconcile.js";
import { registerLineRoutes } from "./lines.js";
import {
  actorOf,
  assertSameCurrency,
  assertSegregation,
  assertTransition,
  buildLineRow,
  changeGates,
  changeLineSchema,
  companyOf,
  detailSchema,
  fetchCor,
  fetchEvent,
  idSchema,
  isoDateSchema,
  ledgerChange,
  loadLines,
  markupRuleSchema,
  moneySchema,
  nowIso,
  pad3,
  projectOf,
  readMarkups,
  todayIso,
} from "./shared.js";

const corCreateSchema = z.object({
  primeContractId: idSchema,
  changeEventId: idSchema.nullable().optional(),
  title: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  reason: z.enum(CHANGE_REASONS).nullable().optional(),
  pcoIds: z.array(idSchema).max(200).optional(),
  markups: z.array(markupRuleSchema).max(20).optional(),
  lines: z.array(changeLineSchema).max(500).optional(),
  scheduleImpactDays: z.number().int().min(0).max(3650).optional(),
  dueDate: isoDateSchema.nullable().optional(),
  documentIds: z.array(idSchema).max(200).optional(),
  detail: detailSchema.optional(),
});

const corPatchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(20000).nullable().optional(),
  reason: z.enum(CHANGE_REASONS).nullable().optional(),
  markups: z.array(markupRuleSchema).max(20).optional(),
  scheduleImpactDays: z.number().int().min(0).max(3650).optional(),
  dueDate: isoDateSchema.nullable().optional(),
  documentIds: z.array(idSchema).max(200).optional(),
  detail: detailSchema.optional(),
});

const corListQuery = pageQuerySchema.extend({
  status: z.enum(COR_STATUSES).optional(),
  primeContractId: idSchema.optional(),
  changeEventId: idSchema.optional(),
});

const submitSchema = z.object({
  submittedDate: isoDateSchema.optional(),
  dueDate: isoDateSchema.nullable().optional(),
});

const negotiateSchema = z.object({
  position: z.enum(["owner", "contractor"]),
  amount: moneySchema.nullable().optional(),
  scheduleImpactDays: z.number().int().min(0).max(3650).nullable().optional(),
  note: z.string().min(1).max(8000),
  at: z.string().min(4).optional(),
});

const approveSchema = z.object({
  approvedAmount: moneySchema,
  scheduleImpactApprovedDays: z.number().int().min(0).max(3650).optional(),
  ownerResponseDate: isoDateSchema.optional(),
  notes: z.string().max(8000).nullable().optional(),
});

const rejectSchema = z.object({
  rejectionReason: z.string().min(1).max(8000),
  ownerResponseDate: isoDateSchema.optional(),
});

const delayLinkSchema = z.object({
  delayEventIds: z.array(idSchema).max(50),
});

const COR_EDITABLE = ["draft", "revise_and_resubmit"] as const;
const COR_FROZEN = COR_STATUSES.filter((s) => !(COR_EDITABLE as readonly string[]).includes(s));

/* ------------------------------------------------------------------ */
/* Totals                                                              */
/* ------------------------------------------------------------------ */

export interface CorTotals extends MarkupStackResult {
  subtotal: number;
  amount: number;
}

/**
 * Re-derive the COR's four money columns from its lines and its markup stack.
 * Nothing is incremented in place and nothing is stored that the stack could
 * not compute: a stack resting on an absent input (a per-unit markup over
 * lines with no quantity) REFUSES the write rather than storing a plausible
 * total nobody can reproduce.
 */
export async function recomputeCorTotals(db: Db, corId: string): Promise<CorTotals> {
  const [cor] = await db
    .select()
    .from(changeOrderRequests)
    .where(eq(changeOrderRequests.id, corId))
    .limit(1);
  if (!cor) throw notFound("Change order request not found");
  const lines = await loadLines(db, "change_order_request", corId);
  const markups = readMarkups(cor.markups);
  const stack = applyMarkupStack(
    lines.map((l) => ({
      costAmount: l.costAmount,
      costType: l.costType,
      quantity: l.quantity,
      taxAmount: l.taxAmount,
    })),
    markups,
  );
  if (stack.reasons.length > 0) {
    throw badRequest(
      `The markup stack on ${cor.reference} cannot be computed from these lines: ` +
        `${stack.reasons.join(" ")} Nothing was stored — a total the inputs do not support is ` +
        "worse than no total.",
      { reasons: stack.reasons },
    );
  }
  const totals: CorTotals = {
    ...stack,
    subtotal: stack.costSubtotal,
    amount: stack.total,
  };
  await db
    .update(changeOrderRequests)
    .set({
      subtotal: totals.subtotal,
      markupTotal: totals.markupTotal,
      taxTotal: totals.taxTotal,
      amount: totals.amount,
      markups: stack.applied as unknown[],
      updatedAt: nowIso(),
    })
    .where(eq(changeOrderRequests.id, corId));
  return totals;
}

/** The stored markup rules, re-read from what was persisted on the row. */
function rulesOf(cor: { markups: unknown[] }): MarkupRule[] {
  return readMarkups(cor.markups);
}

export const corRoutes: FastifyPluginAsync = async (app) => {
  const gates = changeGates(app);

  async function loadContract(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(primeContracts)
      .where(
        and(
          eq(primeContracts.id, id),
          eq(primeContracts.companyId, companyId),
          eq(primeContracts.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) {
      throw badRequest(
        `primeContractId ${id} is not a prime contract on this project. A change order request is ` +
          "an ask against a specific contract, never against a project in general.",
      );
    }
    if (rows[0].status === "void" || rows[0].status === "terminated") {
      throw conflict(
        `Prime contract ${rows[0].reference} is ${rows[0].status} — no further change can be ` +
          "requested under it.",
      );
    }
    return rows[0];
  }

  /** The contract's standard markup stack, when the project carries one. */
  async function defaultMarkups(projectId: string): Promise<MarkupRule[]> {
    const rows = await app.db
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return readMarkups((rows[0]?.settings ?? {})["changeMarkups"]);
  }

  async function loadMemberPcos(
    pcoIds: readonly string[],
    companyId: string,
    projectId: string,
    corId: string | null,
  ) {
    if (pcoIds.length === 0) return [];
    const rows = await app.db
      .select()
      .from(potentialChangeOrders)
      .where(
        and(
          inArray(potentialChangeOrders.id, [...pcoIds]),
          eq(potentialChangeOrders.companyId, companyId),
          eq(potentialChangeOrders.projectId, projectId),
        ),
      );
    const found = new Set(rows.map((r) => r.id));
    const missing = pcoIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw badRequest(
        `These potential change orders are not on this project: ${missing.join(", ")}.`,
      );
    }
    const unpriced = rows.filter(
      (r) => !["priced", "submitted", "approved"].includes(r.status) && r.noCharge === 0,
    );
    if (unpriced.length > 0) {
      throw conflict(
        `These PCOs carry no priced position yet: ${unpriced
          .map((r) => `${r.reference} (${r.status})`)
          .join(", ")}. Price them before asking the owner for money.`,
      );
    }
    const taken = rows.filter(
      (r) => r.changeOrderRequestId && r.changeOrderRequestId !== corId,
    );
    if (taken.length > 0) {
      throw conflict(
        `These PCOs are already inside another change order request: ${taken
          .map((r) => r.reference)
          .join(", ")}. Billing one cost to the owner twice is the failure this refusal exists for.`,
      );
    }
    return rows;
  }

  app.post(
    "/projects/:projectId/change-order-requests",
    { preHandler: gates.standard },
    async (req, reply) => {
      const body = corCreateSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const actorId = actorOf(req);

      const contract = await loadContract(body.primeContractId, companyId, projectId);
      const event = body.changeEventId
        ? await fetchEvent(app.db, body.changeEventId, companyId, projectId)
        : null;
      const pcos = await loadMemberPcos(body.pcoIds ?? [], companyId, projectId, null);
      if (pcos.length === 0 && (body.lines ?? []).length === 0) {
        throw badRequest(
          "A change order request needs at least one PCO or one cost line. An ask with nothing " +
            "underneath it cannot be defended when the owner asks what it is for.",
        );
      }

      // Currency: the ask is denominated in the prime contract's currency, and
      // every commitment feeding it has to agree. There is no FX here.
      const commitmentIds = [...new Set(pcos.map((p) => p.commitmentId).filter((x): x is string => !!x))];
      const commitmentRows =
        commitmentIds.length > 0
          ? await app.db
              .select({
                id: commitments.id,
                reference: commitments.reference,
                currency: commitments.currency,
              })
              .from(commitments)
              .where(inArray(commitments.id, commitmentIds))
          : [];
      assertSameCurrency([
        { label: contract.reference, currency: contract.currency },
        ...commitmentRows.map((c) => ({ label: c.reference, currency: c.currency })),
      ]);

      const markups = body.markups ?? (await defaultMarkups(projectId));
      const problems = validateMarkupStack(markups);
      if (problems.length > 0) throw badRequest(problems.join(" "), { problems });

      const number = await nextRecordNumber(app.db, projectId, "change_order_request");
      const id = newId("cor");
      const reference = `COR-${pad3(number)}`;

      /*
       * Cost coding is inherited from each PCO's own breakdown when that
       * breakdown agrees on one code. It matters: an owner-funded increase has
       * to land on a budget cost code at execution, and a COR line that
       * arrived uncoded is a change order nobody can post.
       */
      const pcoLineMap = new Map<string, Awaited<ReturnType<typeof loadLines>>>();
      for (const pco of pcos) {
        pcoLineMap.set(pco.id, await loadLines(app.db, "potential_change_order", pco.id));
      }
      const soleValue = <T>(values: Array<T | null>): T | null => {
        const distinct = new Set(values.filter((v): v is T => v !== null && v !== undefined));
        return distinct.size === 1 ? ([...distinct][0] as T) : null;
      };

      await app.db.transaction(async (tx) => {
        await tx.insert(changeOrderRequests).values({
          id,
          companyId,
          projectId,
          primeContractId: contract.id,
          changeEventId: event?.id ?? null,
          number,
          reference,
          title: body.title,
          description: body.description ?? null,
          reason: body.reason ?? event?.reason ?? null,
          status: "draft",
          pcoIds: pcos.map((p) => p.id),
          markups: markups as unknown[],
          scheduleImpactDays:
            body.scheduleImpactDays ??
            pcos.reduce((max, p) => Math.max(max, p.scheduleImpactDays), 0),
          dueDate: body.dueDate ?? null,
          documentIds: body.documentIds ?? [],
          detail: { ...(body.detail ?? {}), negotiationHistory: [], delayEventIds: [] },
          createdBy: actorId,
        });

        const ctx = { companyId, projectId, changeEventId: event?.id ?? null, createdBy: actorId };
        let sort = 0;
        /*
         * A COR line per member PCO, carrying the POSITION the PCO is taking
         * forward — not a copy of the PCO's own breakdown. That is how a real
         * change order reads ("Mechanical sub change 12,400; self-performed
         * labour 4,000; then OH&P over the lot"), and it keeps the ask exactly
         * equal to the sum of the positions behind it.
         */
        for (const pco of pcos) {
          sort += 10;
          const own = pcoLineMap.get(pco.id) ?? [];
          const costCode = soleValue(own.map((l) => l.costCode));
          const costType = soleValue(own.map((l) => l.costType));
          const budgetLineItemId = soleValue(own.map((l) => l.budgetLineItemId));
          const costCodeId = soleValue(own.map((l) => l.costCodeId));
          await tx.insert(changeLineItems).values(
            buildLineRow(
              { ...ctx, changeEventId: pco.changeEventId ?? ctx.changeEventId },
              "change_order_request",
              id,
              {
                description: `${pco.reference} — ${pco.title}`,
                sortOrder: sort,
                costCode,
                costCodeId,
                budgetLineItemId,
                costType: (costType ?? (pco.commitmentId ? "subcontract" : "other")) as never,
                costAmount: pco.amount,
                revenueAmount: pco.amount,
                vendorId: pco.vendorId,
                detail: {
                  sourcePcoId: pco.id,
                  sourcePcoReference: pco.reference,
                  inheritedCoding: costCode !== null || budgetLineItemId !== null,
                },
              },
              sort,
            ),
          );
        }
        for (const line of body.lines ?? []) {
          sort += 10;
          await tx
            .insert(changeLineItems)
            .values(buildLineRow(ctx, "change_order_request", id, line, sort));
        }
        if (pcos.length > 0) {
          await tx
            .update(potentialChangeOrders)
            .set({ changeOrderRequestId: id, updatedAt: nowIso() })
            .where(
              inArray(
                potentialChangeOrders.id,
                pcos.map((p) => p.id),
              ),
            );
        }
      });

      const totals = await recomputeCorTotals(app.db, id);
      await ledgerChange(app.db, req, "create", "change_order_request", id, {
        reference,
        primeContractId: contract.id,
        changeEventId: event?.id ?? null,
        pcoIds: pcos.map((p) => p.id),
        subtotal: totals.subtotal,
        markupTotal: totals.markupTotal,
        amount: totals.amount,
      });
      const created = await fetchCor(app.db, id, companyId, projectId);
      return reply.status(201).send({ changeOrderRequest: created, totals });
    },
  );

  app.get("/projects/:projectId/change-order-requests", { preHandler: gates.read }, async (req) => {
    const q = corListQuery.parse(req.query);
    const clauses = [
      eq(changeOrderRequests.companyId, companyOf(req)),
      eq(changeOrderRequests.projectId, projectOf(req)),
    ];
    if (q.status) clauses.push(eq(changeOrderRequests.status, q.status));
    if (q.primeContractId) clauses.push(eq(changeOrderRequests.primeContractId, q.primeContractId));
    if (q.changeEventId) clauses.push(eq(changeOrderRequests.changeEventId, q.changeEventId));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(changeOrderRequests).where(where);
    const items = await app.db
      .select()
      .from(changeOrderRequests)
      .where(where)
      .orderBy(desc(changeOrderRequests.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get(
    "/projects/:projectId/change-order-requests/:corId",
    { preHandler: gates.read },
    async (req) => {
      const { corId } = req.params as { corId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const cor = await fetchCor(app.db, corId, companyId, projectId);
      const lines = await loadLines(app.db, "change_order_request", corId);
      const stack = applyMarkupStack(
        lines.map((l) => ({
          costAmount: l.costAmount,
          costType: l.costType,
          quantity: l.quantity,
          taxAmount: l.taxAmount,
        })),
        rulesOf(cor),
      );
      const members =
        cor.pcoIds.length > 0
          ? await app.db
              .select()
              .from(potentialChangeOrders)
              .where(inArray(potentialChangeOrders.id, cor.pcoIds))
              .orderBy(asc(potentialChangeOrders.number))
          : [];
      return {
        changeOrderRequest: cor,
        lines,
        members,
        markupStack: stack,
        total: stackTotal(stack),
        identities: [
          ...markupIdentities(stack),
          {
            identity: "Σ member PCO positions = COR cost subtotal",
            left: round2(members.reduce((s, m) => s + m.amount, 0)),
            right: stack.costSubtotal,
            delta: round2(members.reduce((s, m) => s + m.amount, 0) - stack.costSubtotal),
            ok:
              Math.abs(members.reduce((s, m) => s + m.amount, 0) - stack.costSubtotal) <=
              round2(
                lines
                  .filter((l) => !(l.detail as Record<string, unknown>)["sourcePcoId"])
                  .reduce((s, l) => s + l.costAmount, 0),
              ) +
                0.005,
          },
        ],
        negotiation: negotiationHistory(cor),
        commercial: {
          asked: round2(cor.amount),
          granted: round2(cor.approvedAmount),
          gap: round2(cor.amount - cor.approvedAmount),
          gapPercent:
            cor.amount === 0
              ? { value: null, inputs: {}, reasons: ["Nothing was asked for."] }
              : ratio(cor.amount - cor.approvedAmount, cor.amount, "Negotiation gap"),
        },
      };
    },
  );

  app.patch(
    "/projects/:projectId/change-order-requests/:corId",
    { preHandler: gates.standard },
    async (req) => {
      const { corId } = req.params as { corId: string };
      const body = corPatchSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const cor = await fetchCor(app.db, corId, companyId, projectId);
      assertTransition(cor.status, COR_EDITABLE, "change order request", "edit");
      if (body.markups) {
        const problems = validateMarkupStack(body.markups);
        if (problems.length > 0) throw badRequest(problems.join(" "), { problems });
      }
      const set: Record<string, unknown> = { updatedAt: nowIso() };
      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined) set[key] = value;
      }
      await app.db.update(changeOrderRequests).set(set).where(eq(changeOrderRequests.id, corId));
      const totals = await recomputeCorTotals(app.db, corId);
      await ledgerChange(app.db, req, "update", "change_order_request", corId, {
        reference: cor.reference,
        changed: Object.keys(body),
        amount: totals.amount,
      });
      return {
        changeOrderRequest: await fetchCor(app.db, corId, companyId, projectId),
        totals,
      };
    },
  );

  app.post(
    "/projects/:projectId/change-order-requests/:corId/recalculate",
    { preHandler: gates.standard },
    async (req) => {
      const { corId } = req.params as { corId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const cor = await fetchCor(app.db, corId, companyId, projectId);
      assertTransition(cor.status, COR_EDITABLE, "change order request", "recalculate");
      const totals = await recomputeCorTotals(app.db, corId);
      return { changeOrderRequest: await fetchCor(app.db, corId, companyId, projectId), totals };
    },
  );

  app.post(
    "/projects/:projectId/change-order-requests/:corId/submit",
    { preHandler: gates.standard },
    async (req) => {
      const { corId } = req.params as { corId: string };
      const body = submitSchema.parse(req.body ?? {});
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const cor = await fetchCor(app.db, corId, companyId, projectId);
      assertTransition(cor.status, COR_EDITABLE, "change order request", "submit");
      const lines = await loadLines(app.db, "change_order_request", corId);
      if (lines.length === 0) {
        throw badRequest(`${cor.reference} has no cost lines and cannot be put to the owner.`);
      }
      const totals = await recomputeCorTotals(app.db, corId);
      const now = nowIso();
      await app.db
        .update(changeOrderRequests)
        .set({
          status: "submitted",
          submittedBy: actorOf(req),
          submittedAt: now,
          submittedDate: body.submittedDate ?? todayIso(),
          dueDate: body.dueDate ?? cor.dueDate,
          updatedAt: now,
        })
        .where(eq(changeOrderRequests.id, corId));
      await ledgerChange(
        app.db,
        req,
        "state_change",
        "change_order_request",
        corId,
        {
          reference: cor.reference,
          from: cor.status,
          to: "submitted",
          amount: totals.amount,
          subtotal: totals.subtotal,
          markupTotal: totals.markupTotal,
          markups: totals.applied,
          scheduleImpactDays: cor.scheduleImpactDays,
        },
        { storePayload: true },
      );
      return { changeOrderRequest: await fetchCor(app.db, corId, companyId, projectId), totals };
    },
  );

  app.post(
    "/projects/:projectId/change-order-requests/:corId/review",
    { preHandler: gates.standard },
    async (req) => {
      const { corId } = req.params as { corId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const cor = await fetchCor(app.db, corId, companyId, projectId);
      assertTransition(cor.status, ["submitted"], "change order request", "mark under review");
      await app.db
        .update(changeOrderRequests)
        .set({ status: "under_review", updatedAt: nowIso() })
        .where(eq(changeOrderRequests.id, corId));
      await ledgerChange(app.db, req, "state_change", "change_order_request", corId, {
        reference: cor.reference,
        from: cor.status,
        to: "under_review",
      });
      return fetchCor(app.db, corId, companyId, projectId);
    },
  );

  /**
   * Negotiation is a SEQUENCE of positions, not a final number. Each round is
   * appended with its author, its side of the table and its date, because the
   * question that decides a claim two years later is "what did they offer, and
   * when" — and a single `negotiationNotes` textarea cannot answer it.
   */
  app.post(
    "/projects/:projectId/change-order-requests/:corId/negotiate",
    { preHandler: gates.standard },
    async (req) => {
      const { corId } = req.params as { corId: string };
      const body = negotiateSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const cor = await fetchCor(app.db, corId, companyId, projectId);
      assertTransition(
        cor.status,
        ["submitted", "under_review", "negotiating"],
        "change order request",
        "record a negotiation round on",
      );
      const history = negotiationHistory(cor);
      const entry = {
        seq: history.length + 1,
        at: body.at ?? nowIso(),
        by: actorOf(req),
        position: body.position,
        amount: body.amount === undefined || body.amount === null ? null : round2(body.amount),
        scheduleImpactDays: body.scheduleImpactDays ?? null,
        note: body.note,
      };
      const detail = { ...(cor.detail ?? {}), negotiationHistory: [...history, entry] };
      await app.db
        .update(changeOrderRequests)
        .set({
          status: "negotiating",
          detail,
          negotiationNotes: body.note,
          updatedAt: nowIso(),
        })
        .where(eq(changeOrderRequests.id, corId));
      await ledgerChange(
        app.db,
        req,
        "state_change",
        "change_order_request",
        corId,
        { reference: cor.reference, from: cor.status, to: "negotiating", round: entry },
        { storePayload: true },
      );
      return {
        changeOrderRequest: await fetchCor(app.db, corId, companyId, projectId),
        negotiation: [...history, entry],
      };
    },
  );

  app.post(
    "/projects/:projectId/change-order-requests/:corId/approve",
    { preHandler: gates.standard },
    async (req) => {
      const { corId } = req.params as { corId: string };
      const body = approveSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const actorId = actorOf(req);
      const cor = await fetchCor(app.db, corId, companyId, projectId);
      assertTransition(
        cor.status,
        ["submitted", "under_review", "negotiating"],
        "change order request",
        "approve",
      );
      assertSegregation(
        actorId,
        { createdBy: cor.createdBy, submittedBy: cor.submittedBy },
        "change order request",
      );
      const approvedAmount = round2(body.approvedAmount);
      if (Math.abs(approvedAmount) > Math.abs(cor.amount) + 0.005) {
        throw badRequest(
          `The owner cannot approve ${approvedAmount.toFixed(2)} against an ask of ` +
            `${cor.amount.toFixed(2)}. If the scope grew, revise the request and resubmit it — a ` +
            "change order that grants more than was asked for cannot be reconciled to its lines.",
        );
      }
      if (approvedAmount * cor.amount < 0) {
        throw badRequest(
          "The approved amount has the opposite sign to the ask. A credit cannot be approved as an " +
            "addition, or the other way round.",
        );
      }
      const days = body.scheduleImpactApprovedDays ?? 0;
      if (days > cor.scheduleImpactDays) {
        throw badRequest(
          `${days} days approved against ${cor.scheduleImpactDays} days claimed. An owner may grant ` +
            "less time than was claimed, never more.",
        );
      }
      const partial = Math.abs(approvedAmount - cor.amount) > 0.005 || days < cor.scheduleImpactDays;
      const status = partial ? "partially_approved" : "approved";
      const now = nowIso();
      await app.db
        .update(changeOrderRequests)
        .set({
          status,
          approvedAmount,
          scheduleImpactApprovedDays: days,
          ownerResponseDate: body.ownerResponseDate ?? todayIso(),
          negotiationNotes: body.notes ?? cor.negotiationNotes,
          approvedBy: actorId,
          approvedAt: now,
          updatedAt: now,
        })
        .where(eq(changeOrderRequests.id, corId));
      await ledgerChange(
        app.db,
        req,
        "state_change",
        "change_order_request",
        corId,
        {
          reference: cor.reference,
          from: cor.status,
          to: status,
          asked: round2(cor.amount),
          granted: approvedAmount,
          gap: round2(cor.amount - approvedAmount),
          daysClaimed: cor.scheduleImpactDays,
          daysApproved: days,
          submittedBy: cor.submittedBy,
          approvedBy: actorId,
        },
        { storePayload: true },
      );
      return fetchCor(app.db, corId, companyId, projectId);
    },
  );

  app.post(
    "/projects/:projectId/change-order-requests/:corId/reject",
    { preHandler: gates.standard },
    async (req) => {
      const { corId } = req.params as { corId: string };
      const body = rejectSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const actorId = actorOf(req);
      const cor = await fetchCor(app.db, corId, companyId, projectId);
      assertTransition(
        cor.status,
        ["submitted", "under_review", "negotiating"],
        "change order request",
        "reject",
      );
      assertSegregation(
        actorId,
        { createdBy: cor.createdBy, submittedBy: cor.submittedBy },
        "change order request",
      );
      const now = nowIso();
      await app.db
        .update(changeOrderRequests)
        .set({
          status: "rejected",
          rejectedBy: actorId,
          rejectedAt: now,
          rejectionReason: body.rejectionReason,
          ownerResponseDate: body.ownerResponseDate ?? todayIso(),
          approvedAmount: 0,
          updatedAt: now,
        })
        .where(eq(changeOrderRequests.id, corId));
      await ledgerChange(app.db, req, "state_change", "change_order_request", corId, {
        reference: cor.reference,
        from: cor.status,
        to: "rejected",
        asked: round2(cor.amount),
        rejectionReason: body.rejectionReason,
      });
      return fetchCor(app.db, corId, companyId, projectId);
    },
  );

  app.post(
    "/projects/:projectId/change-order-requests/:corId/revise",
    { preHandler: gates.standard },
    async (req) => {
      const { corId } = req.params as { corId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const cor = await fetchCor(app.db, corId, companyId, projectId);
      assertTransition(
        cor.status,
        ["submitted", "under_review", "negotiating"],
        "change order request",
        "send back for revision",
      );
      await app.db
        .update(changeOrderRequests)
        .set({ status: "revise_and_resubmit", updatedAt: nowIso() })
        .where(eq(changeOrderRequests.id, corId));
      await ledgerChange(app.db, req, "state_change", "change_order_request", corId, {
        reference: cor.reference,
        from: cor.status,
        to: "revise_and_resubmit",
      });
      return fetchCor(app.db, corId, companyId, projectId);
    },
  );

  app.post(
    "/projects/:projectId/change-order-requests/:corId/withdraw",
    { preHandler: gates.standard },
    async (req) => {
      const { corId } = req.params as { corId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const cor = await fetchCor(app.db, corId, companyId, projectId);
      if (cor.changeOrderPackageId) {
        throw conflict(
          `${cor.reference} is inside a change order package and cannot be withdrawn. Void the ` +
            "package first.",
        );
      }
      assertTransition(
        cor.status,
        ["draft", "submitted", "under_review", "negotiating", "revise_and_resubmit"],
        "change order request",
        "withdraw",
      );
      await app.db.transaction(async (tx) => {
        await tx
          .update(changeOrderRequests)
          .set({ status: "withdrawn", updatedAt: nowIso() })
          .where(eq(changeOrderRequests.id, corId));
        if (cor.pcoIds.length > 0) {
          await tx
            .update(potentialChangeOrders)
            .set({ changeOrderRequestId: null, updatedAt: nowIso() })
            .where(inArray(potentialChangeOrders.id, cor.pcoIds));
        }
      });
      await ledgerChange(app.db, req, "state_change", "change_order_request", corId, {
        reference: cor.reference,
        from: cor.status,
        to: "withdrawn",
        releasedPcoIds: cor.pcoIds,
      });
      return fetchCor(app.db, corId, companyId, projectId);
    },
  );

  /* ---------------- time impact ---------------- */

  app.post(
    "/projects/:projectId/change-order-requests/:corId/delay-events",
    { preHandler: gates.standard },
    async (req) => {
      const { corId } = req.params as { corId: string };
      const body = delayLinkSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const cor = await fetchCor(app.db, corId, companyId, projectId);
      const rows =
        body.delayEventIds.length > 0
          ? await app.db
              .select()
              .from(delayEvents)
              .where(
                and(
                  inArray(delayEvents.id, body.delayEventIds),
                  eq(delayEvents.companyId, companyId),
                  eq(delayEvents.projectId, projectId),
                ),
              )
          : [];
      const found = new Set(rows.map((r) => r.id));
      const missing = body.delayEventIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw badRequest(
          `These delay events are not on this project: ${missing.join(", ")}. Time impact is the ` +
            "forensics module's concept; a change order points at it rather than inventing a " +
            "second one.",
        );
      }
      const detail = { ...(cor.detail ?? {}), delayEventIds: body.delayEventIds };
      await app.db
        .update(changeOrderRequests)
        .set({ detail, updatedAt: nowIso() })
        .where(eq(changeOrderRequests.id, corId));
      await ledgerChange(app.db, req, "update", "change_order_request", corId, {
        reference: cor.reference,
        delayEventIds: body.delayEventIds,
      });
      return corTimeImpact(app.db, await fetchCor(app.db, corId, companyId, projectId));
    },
  );

  app.get(
    "/projects/:projectId/change-order-requests/:corId/time-impact",
    { preHandler: gates.read },
    async (req) => {
      const { corId } = req.params as { corId: string };
      const cor = await fetchCor(app.db, corId, companyOf(req), projectOf(req));
      return corTimeImpact(app.db, cor);
    },
  );

  registerLineRoutes(app, gates, {
    parentType: "change_order_request",
    objectType: "change_order_request",
    basePath: "/projects/:projectId/change-order-requests/:corId",
    paramName: "corId",
    label: "Change order request",
    frozenStatuses: COR_FROZEN,
    fetch: async (db, id, companyId, projectId) => {
      const row = await fetchCor(db, id, companyId, projectId);
      return {
        id: row.id,
        reference: row.reference,
        status: row.status,
        changeEventId: row.changeEventId,
      };
    },
    afterChange: async (db, corId) => {
      await recomputeCorTotals(db, corId);
    },
  });
};

/* ------------------------------------------------------------------ */
/* Helpers reused by the change log                                    */
/* ------------------------------------------------------------------ */

export interface NegotiationEntry {
  seq: number;
  at: string;
  by: string;
  position: string;
  amount: number | null;
  scheduleImpactDays: number | null;
  note: string;
}

export function negotiationHistory(cor: {
  detail: Record<string, unknown>;
}): NegotiationEntry[] {
  const raw = cor.detail["negotiationHistory"];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is NegotiationEntry =>
      !!e && typeof e === "object" && typeof (e as NegotiationEntry).note === "string",
  );
}

export function delayEventIdsOf(cor: { detail: Record<string, unknown> }): string[] {
  const raw = cor.detail["delayEventIds"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

export async function corTimeImpact(
  db: Db,
  cor: {
    id: string;
    reference: string;
    title: string;
    status: string;
    scheduleImpactDays: number;
    scheduleImpactApprovedDays: number;
    detail: Record<string, unknown>;
  },
) {
  const ids = delayEventIdsOf(cor);
  const rows =
    ids.length > 0
      ? await db.select().from(delayEvents).where(inArray(delayEvents.id, ids))
      : [];
  const linked: DelayEventRow[] = rows.map((r) => {
    const tia = (r.tiaResult ?? {}) as Record<string, unknown>;
    const delta = tia["completionDeltaDays"];
    return {
      id: r.id,
      number: r.number,
      title: r.title,
      cause: r.cause,
      excusable: r.excusable,
      compensable: r.compensable,
      status: r.status,
      startDate: r.startDate,
      durationDays: r.durationDays,
      completionDeltaDays: typeof delta === "number" && Number.isFinite(delta) ? delta : null,
    };
  });
  return assessCorTimeImpact(cor, ids, linked);
}

