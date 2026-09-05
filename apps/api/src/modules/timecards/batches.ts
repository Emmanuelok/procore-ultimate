import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import {
  crews,
  signals,
  timecardAllocations,
  timecardApprovals,
  timecardBatches,
  timecards,
  workers,
} from "@constructos/db";
import { TIMECARD_BATCH_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { badRequest, conflict } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import { reconcileAllocations, round2, VARIANCE_TOLERANCE_HOURS } from "./hours.js";
import { splitOf } from "./cards.js";
import {
  actorOf,
  assertBatchEditable,
  assertSameCurrency,
  assertTransition,
  checkSelfApproval,
  companyOf,
  crewConfig,
  detailSchema,
  fetchBatch,
  fetchCrew,
  idSchema,
  isoDateSchema,
  ledgerTimecards,
  nowIso,
  pad3,
  projectOf,
  requireVendor,
  selfApprovalRefusal,
  timecardGates,
} from "./shared.js";

const batchCreateSchema = z
  .object({
    crewId: idSchema.nullable().optional(),
    vendorId: idSchema.nullable().optional(),
    periodStart: isoDateSchema,
    periodEnd: isoDateSchema,
    weekEnding: isoDateSchema.nullable().optional(),
    detail: detailSchema.optional(),
    /** pull the period's cards in as the batch is created */
    collect: z.boolean().optional(),
  })
  .refine((b) => b.periodEnd >= b.periodStart, {
    message: "periodEnd must not precede periodStart",
  });

const batchListQuery = pageQuerySchema.extend({
  status: z.enum(TIMECARD_BATCH_STATUSES).optional(),
  crewId: idSchema.optional(),
  vendorId: idSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

const collectSchema = z.object({
  /** explicit cards; omitted means "everything this crew booked in the period" */
  timecardIds: z.array(idSchema).max(500).optional(),
});

const submitSchema = z.object({ comment: z.string().max(4000).nullable().optional() });

const approveSchema = z.object({
  decision: z.enum(["approved", "rejected", "returned_for_revision"]).default("approved"),
  level: z.number().int().min(1).max(3).optional(),
  approverRole: z.string().max(120).nullable().optional(),
  comment: z.string().max(4000).nullable().optional(),
  signatureFileId: idSchema.nullable().optional(),
});

const exportSchema = z.object({
  payrollBatchRef: z.string().min(1).max(200),
  note: z.string().max(2000).nullable().optional(),
});

export interface BatchRollup {
  timecardCount: number;
  workerCount: number;
  regularHours: number;
  overtimeHours: number;
  doubleTimeHours: number;
  premiumHours: number;
  totalHours: number;
  /** null when a card in the batch could not be costed — never a partial sum */
  totalCost: number | null;
  currency: string;
  varianceHours: number | null;
  exceptionCount: number;
  uncostedCards: string[];
  unallocatedCards: string[];
  /** coded, but the coding no longer reconciles with the card's hours */
  misallocatedCards: string[];
  unexplainedVarianceCards: string[];
  cardsWithoutAccessRecord: string[];
  reasons: string[];
}

/**
 * Re-derive a batch's totals from its cards. Nothing is incremented in place:
 * a rollup that drifts from the rows underneath it is the number a payroll
 * export is built on, and nobody checks it twice.
 *
 * `totalCost` is null when ANY card in the batch could not be costed. A batch
 * total that silently omits the three cards with no overtime rate is worse
 * than no total: it is a smaller, plausible, wrong number.
 */
export async function computeBatchRollup(db: Db, batchId: string): Promise<BatchRollup> {
  const cards = await db.select().from(timecards).where(eq(timecards.batchId, batchId));
  const reasons: string[] = [];
  if (cards.length === 0) {
    return {
      timecardCount: 0,
      workerCount: 0,
      regularHours: 0,
      overtimeHours: 0,
      doubleTimeHours: 0,
      premiumHours: 0,
      totalHours: 0,
      totalCost: null,
      currency: "USD",
      varianceHours: null,
      exceptionCount: 0,
      uncostedCards: [],
      unallocatedCards: [],
      misallocatedCards: [],
      unexplainedVarianceCards: [],
      cardsWithoutAccessRecord: [],
      reasons: ["This batch holds no timecards yet, so it has no totals to state."],
    };
  }

  const currency = assertSameCurrency(
    cards.map((c) => ({ label: c.reference, currency: c.currency })),
    `Batch rollup`,
  );

  const allocated = await db
    .selectDistinct({ timecardId: timecardAllocations.timecardId })
    .from(timecardAllocations)
    .where(inArray(timecardAllocations.timecardId, cards.map((c) => c.id)));
  const allocatedIds = new Set(allocated.map((a) => a.timecardId));

  const uncosted = cards.filter((c) => c.totalCost === null).map((c) => c.reference);
  const unallocated = cards.filter((c) => !allocatedIds.has(c.id)).map((c) => c.reference);

  /*
   * ALLOCATIONS MUST STILL RECONCILE AT BATCH LEVEL.
   *
   * PATCH is allowed on a submitted card and rewrites the hour split without
   * touching its allocations, so a card can be submitted with 8h coded, edited
   * to 10h, and approved through the batch — exported to payroll at 10h with
   * 8h on the cost report. The single-card approve route refuses exactly this;
   * the batch path, which is where approval actually happens, did not check it
   * at all.
   */
  const allocationRows =
    cards.length > 0
      ? await db
          .select()
          .from(timecardAllocations)
          .where(
            inArray(
              timecardAllocations.timecardId,
              cards.map((c) => c.id),
            ),
          )
      : [];
  const misallocated: string[] = [];
  for (const card of cards) {
    if (!allocatedIds.has(card.id)) continue;
    const check = reconcileAllocations(
      splitOf(card),
      allocationRows.filter((a) => a.timecardId === card.id),
    );
    if (!check.ok) misallocated.push(card.reference);
  }
  if (misallocated.length > 0) {
    reasons.push(
      `${misallocated.length} card(s) carry cost coding that no longer adds up to the hours on ` +
        `the card (${misallocated.slice(0, 5).join(", ")}${misallocated.length > 5 ? ", …" : ""}). ` +
        "Hours coded twice, or hours nobody can code — both reach the cost report looking like fact.",
    );
  }
  const unexplained = cards
    .filter(
      (c) =>
        c.varianceHours !== null &&
        Math.abs(c.varianceHours) > VARIANCE_TOLERANCE_HOURS &&
        !(c.varianceExplanation ?? "").trim(),
    )
    .map((c) => c.reference);
  const noAccess = cards.filter((c) => c.varianceHours === null).map((c) => c.reference);

  if (uncosted.length > 0) {
    reasons.push(
      `${uncosted.length} card(s) in this batch carry hours the platform holds no rate for ` +
        `(${uncosted.slice(0, 5).join(", ")}${uncosted.length > 5 ? ", …" : ""}), so the batch cost ` +
        "is unknown rather than the sum of the rest.",
    );
  }
  const compared = cards.filter((c) => c.varianceHours !== null);

  return {
    timecardCount: cards.length,
    workerCount: new Set(cards.map((c) => c.workerId)).size,
    regularHours: round2(cards.reduce((s, c) => s + c.regularHours, 0)),
    overtimeHours: round2(cards.reduce((s, c) => s + c.overtimeHours, 0)),
    doubleTimeHours: round2(cards.reduce((s, c) => s + c.doubleTimeHours, 0)),
    premiumHours: round2(cards.reduce((s, c) => s + c.premiumHours, 0)),
    totalHours: round2(cards.reduce((s, c) => s + c.totalHours, 0)),
    totalCost:
      uncosted.length > 0 ? null : round2(cards.reduce((s, c) => s + (c.totalCost ?? 0), 0)),
    currency,
    varianceHours:
      compared.length === 0 ? null : round2(compared.reduce((s, c) => s + (c.varianceHours ?? 0), 0)),
    exceptionCount: unexplained.length,
    uncostedCards: uncosted,
    unallocatedCards: unallocated,
    misallocatedCards: misallocated,
    unexplainedVarianceCards: unexplained,
    cardsWithoutAccessRecord: noAccess,
    reasons,
  };
}

/** Compute AND persist. Called after every write that moves a batch. */
export async function recomputeBatch(db: Db, batchId: string): Promise<BatchRollup> {
  const rollup = await computeBatchRollup(db, batchId);
  await db
    .update(timecardBatches)
    .set({
      timecardCount: rollup.timecardCount,
      workerCount: rollup.workerCount,
      regularHours: rollup.regularHours,
      overtimeHours: rollup.overtimeHours,
      doubleTimeHours: rollup.doubleTimeHours,
      premiumHours: rollup.premiumHours,
      totalHours: rollup.totalHours,
      // NULL, not 0. `timecard_batches.total_cost` is nullable on purpose:
      // a week with one unpriced overtime rate showed $0.00 in the register
      // and in the CSV export while the detail view — which recomputes —
      // said the cost was unknown. The list and the detail must not disagree
      // about whether a number exists.
      totalCost: rollup.totalCost,
      currency: rollup.currency,
      varianceHours: rollup.varianceHours,
      exceptionCount: rollup.exceptionCount,
      updatedAt: nowIso(),
    })
    .where(eq(timecardBatches.id, batchId));
  return rollup;
}

export const batchRoutes: FastifyPluginAsync = async (app) => {
  const gates = timecardGates(app);

  async function batchView(batchId: string, companyId: string, projectId: string) {
    const batch = await fetchBatch(app.db, batchId, companyId, projectId);
    const rollup = await computeBatchRollup(app.db, batchId);
    const cards = await app.db
      .select({
        card: timecards,
        workerReference: workers.reference,
        workerName: workers.fullName,
      })
      .from(timecards)
      .innerJoin(workers, eq(workers.id, timecards.workerId))
      .where(eq(timecards.batchId, batchId))
      .orderBy(asc(timecards.workDate), asc(timecards.number));
    const approvals = await app.db
      .select()
      .from(timecardApprovals)
      .where(eq(timecardApprovals.batchId, batchId))
      .orderBy(asc(timecardApprovals.level), asc(timecardApprovals.decidedAt));
    const crew = batch.crewId
      ? ((await app.db.select().from(crews).where(eq(crews.id, batch.crewId)))[0] ?? null)
      : null;
    return {
      ...batch,
      crewReference: crew?.reference ?? null,
      crewName: crew?.name ?? null,
      rollup,
      timecards: cards.map((c) => ({
        ...c.card,
        workerReference: c.workerReference,
        workerName: c.workerName,
      })),
      approvals,
    };
  }

  app.post(
    "/projects/:projectId/timecard-batches",
    { preHandler: gates.standard },
    async (req, reply) => {
      const body = batchCreateSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      if (body.crewId) await fetchCrew(app.db, body.crewId, companyId, projectId);
      if (body.vendorId) await requireVendor(app.db, body.vendorId, companyId);
      if (!body.crewId && !body.vendorId) {
        throw badRequest(
          "A batch is a crew's week or a subcontractor's week — name a crewId or a vendorId, so " +
            "there is somebody to send it back to when the hours are wrong.",
        );
      }
      const number = await nextRecordNumber(app.db, projectId, "timecard_batch");
      const id = newId("tbt");
      const reference = `TB-${pad3(number)}`;
      await app.db.insert(timecardBatches).values({
        id,
        companyId,
        projectId,
        number,
        reference,
        crewId: body.crewId ?? null,
        vendorId: body.vendorId ?? null,
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
        weekEnding: body.weekEnding ?? body.periodEnd,
        status: "draft",
        detail: body.detail ?? {},
        createdBy: actorOf(req),
      });
      if (body.collect) await collectInto(id, companyId, projectId, undefined);
      await recomputeBatch(app.db, id);
      await ledgerTimecards(app.db, req, "create", "timecard_batch", id, {
        reference,
        crewId: body.crewId ?? null,
        vendorId: body.vendorId ?? null,
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
      });
      return reply.status(201).send(await batchView(id, companyId, projectId));
    },
  );

  app.get("/projects/:projectId/timecard-batches", { preHandler: gates.read }, async (req) => {
    const q = batchListQuery.parse(req.query);
    const clauses = [
      eq(timecardBatches.companyId, companyOf(req)),
      eq(timecardBatches.projectId, projectOf(req)),
    ];
    if (q.status) clauses.push(eq(timecardBatches.status, q.status));
    if (q.crewId) clauses.push(eq(timecardBatches.crewId, q.crewId));
    if (q.vendorId) clauses.push(eq(timecardBatches.vendorId, q.vendorId));
    if (q.from) clauses.push(gte(timecardBatches.periodEnd, q.from));
    if (q.to) clauses.push(lte(timecardBatches.periodStart, q.to));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(timecardBatches).where(where);
    const rows = await app.db
      .select()
      .from(timecardBatches)
      .where(where)
      .orderBy(desc(timecardBatches.periodEnd), desc(timecardBatches.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));

    // Why the cost is unknown, on the LIST — the register and the detail view
    // used to disagree, because the detail recomputed and the list showed a
    // materialised 0.
    const uncosted =
      rows.length > 0
        ? await app.db
            .select({ batchId: timecards.batchId, n: count() })
            .from(timecards)
            .where(
              and(
                inArray(
                  timecards.batchId,
                  rows.map((r) => r.id),
                ),
                isNull(timecards.totalCost),
              ),
            )
            .groupBy(timecards.batchId)
        : [];
    const uncostedByBatch = new Map(uncosted.map((u) => [u.batchId, Number(u.n)]));
    return paginate(
      rows.map((r) => ({
        ...r,
        uncostedCardCount: uncostedByBatch.get(r.id) ?? 0,
        totalCostIsKnown: r.totalCost !== null,
        costNote:
          r.totalCost === null
            ? `${uncostedByBatch.get(r.id) ?? 0} card(s) in this week carry hours the platform ` +
              "holds no rate for, so the week's cost is unknown rather than the sum of the rest"
            : null,
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.get(
    "/projects/:projectId/timecard-batches/:batchId",
    { preHandler: gates.read },
    async (req) => {
      const { batchId } = req.params as { batchId: string };
      return batchView(batchId, companyOf(req), projectOf(req));
    },
  );

  /**
   * Pull cards into the batch. With no explicit ids this collects every card
   * the batch's crew (or vendor) booked inside the period that is not already
   * in another batch — the foreman's actual workflow, which is "Friday, send
   * the week", not "tick forty boxes".
   */
  app.post(
    "/projects/:projectId/timecard-batches/:batchId/collect",
    { preHandler: gates.standard },
    async (req) => {
      const { batchId } = req.params as { batchId: string };
      const body = collectSchema.parse(req.body ?? {});
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const batch = await fetchBatch(app.db, batchId, companyId, projectId);
      assertBatchEditable(batch, "collect cards into");
      assertTransition(batch.status, ["draft", "rejected"], "batch", "collect cards into");
      const result = await collectInto(batchId, companyId, projectId, body.timecardIds);
      const rollup = await recomputeBatch(app.db, batchId);
      await ledgerTimecards(app.db, req, "update", "timecard_batch", batchId, {
        reference: batch.reference,
        collected: result.collected.length,
        skipped: result.skipped.length,
        totalHours: rollup.totalHours,
      });
      return { ...(await batchView(batchId, companyId, projectId)), collected: result };
    },
  );

  app.post(
    "/projects/:projectId/timecard-batches/:batchId/submit",
    { preHandler: gates.standard },
    async (req) => {
      const { batchId } = req.params as { batchId: string };
      const body = submitSchema.parse(req.body ?? {});
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const batch = await fetchBatch(app.db, batchId, companyId, projectId);
      assertBatchEditable(batch, "submit");
      assertTransition(batch.status, ["draft", "rejected"], "batch", "submit");
      const rollup = await recomputeBatch(app.db, batchId);
      if (rollup.timecardCount === 0) {
        throw conflict(`Batch ${batch.reference} holds no timecards. There is nothing to submit.`);
      }
      if (rollup.unallocatedCards.length > 0) {
        throw conflict(
          `Batch ${batch.reference} cannot be submitted: ${rollup.unallocatedCards.length} card(s) ` +
            `carry no cost coding — ${rollup.unallocatedCards.slice(0, 8).join(", ")}` +
            `${rollup.unallocatedCards.length > 8 ? ", …" : ""}. Uncoded hours never reach the cost ` +
            "report, so they are refused here rather than discovered at month end.",
        );
      }
      if (rollup.misallocatedCards.length > 0) {
        throw conflict(
          `Batch ${batch.reference} cannot be submitted: ${rollup.misallocatedCards.length} card(s) ` +
            `carry cost coding that no longer adds up to the hours on the card — ` +
            `${rollup.misallocatedCards.slice(0, 8).join(", ")}` +
            `${rollup.misallocatedCards.length > 8 ? ", …" : ""}. A card edited after it was coded ` +
            "goes to payroll at the new hours and to the cost report at the old ones. Re-code them.",
        );
      }
      const cards = await app.db.select().from(timecards).where(eq(timecards.batchId, batchId));
      const now = nowIso();
      await app.db
        .update(timecards)
        .set({ status: "submitted", submittedBy: actorOf(req), submittedAt: now, updatedAt: now })
        .where(and(eq(timecards.batchId, batchId), inArray(timecards.status, ["draft", "rejected"])));
      await app.db
        .update(timecardBatches)
        .set({
          status: "submitted",
          submittedBy: actorOf(req),
          submittedAt: now,
          rejectedReason: null,
          detail: { ...(batch.detail ?? {}), submitComment: body.comment ?? null },
          updatedAt: now,
        })
        .where(eq(timecardBatches.id, batchId));
      await ledgerTimecards(app.db, req, "state_change", "timecard_batch", batchId, {
        reference: batch.reference,
        from: batch.status,
        to: "submitted",
        timecards: cards.length,
        totalHours: rollup.totalHours,
        totalCost: rollup.totalCost,
        currency: rollup.currency,
      });
      return batchView(batchId, companyId, projectId);
    },
  );

  /**
   * Approve the week. Nobody signs off forty individual day cards, so this is
   * where approval actually happens — and therefore where the segregation
   * control has to bite hardest. The attempt is recorded before it is
   * refused, exactly as on a single card.
   */
  app.post(
    "/projects/:projectId/timecard-batches/:batchId/approve",
    { preHandler: gates.standard },
    async (req) => {
      const { batchId } = req.params as { batchId: string };
      const body = approveSchema.parse(req.body ?? {});
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const actorId = actorOf(req);
      const batch = await fetchBatch(app.db, batchId, companyId, projectId);
      assertBatchEditable(batch, "approve");
      assertTransition(batch.status, ["submitted", "partially_approved"], "batch", "approve");

      /*
       * THE LEVEL IS DERIVED, not defaulted to 1.
       *
       * The UI never sent one, so on a crew configured for two approval tiers
       * two different approvers both landed on level 1, `approvedLevels.size`
       * stayed at 1, and the batch sat in partially_approved for ever with
       * nothing on screen explaining why. The next required tier is one above
       * the highest already approved.
       */
      const priorApprovals = await app.db
        .select()
        .from(timecardApprovals)
        .where(eq(timecardApprovals.batchId, batchId));
      const priorLevels = priorApprovals
        .filter((a) => a.decision === "approved" && a.isSelfApproval === 0)
        .map((a) => a.level);
      const level = body.level ?? Math.min(3, Math.max(0, ...priorLevels, 0) + 1);

      /*
       * SEGREGATION IS CHECKED AT CARD LEVEL TOO.
       *
       * The batch check only looked at who submitted and who created the
       * BATCH. A foreman who raised forty cards, had a colleague batch and
       * submit them, and then approved the batch, approved forty of his own
       * timecards — every one of which the card-level route would have refused
       * and recorded as an attempted self-approval.
       */
      const batchCards = await app.db
        .select({
          id: timecards.id,
          reference: timecards.reference,
          createdBy: timecards.createdBy,
          submittedBy: timecards.submittedBy,
        })
        .from(timecards)
        .where(eq(timecards.batchId, batchId));
      const ownCards = batchCards.filter(
        (c) => c.createdBy === actorId || c.submittedBy === actorId,
      );

      const self = checkSelfApproval(
        actorId,
        { submittedBy: batch.submittedBy, createdBy: batch.createdBy },
        "timecard batch",
      );
      if (!self.isSelfApproval && ownCards.length > 0 && body.decision === "approved") {
        const approvalId = newId("tap");
        await app.db.insert(timecardApprovals).values({
          id: approvalId,
          companyId,
          projectId,
          timecardId: null,
          batchId,
          level,
          approverId: actorId,
          approverRole: body.approverRole ?? null,
          decision: body.decision,
          decidedAt: nowIso(),
          comment: body.comment ?? null,
          subjectWorkerId: null,
          isSelfApproval: 1,
          delegatedFromId: null,
          escalatedToId: null,
          signatureFileId: body.signatureFileId ?? null,
          detail: {
            outcome: "refused",
            control: "no_self_approval",
            breachedRelationship: "raised_cards_in_batch",
            attemptedDecision: body.decision,
            batchReference: batch.reference,
            ownCards: ownCards.map((c) => c.reference).slice(0, 40),
          },
        });
        await app.db.insert(signals).values({
          id: newId("sig"),
          companyId,
          projectId,
          detector: "timecard_self_approval",
          severity: "high",
          confidence: 1,
          title: `Self-approval refused on timecard batch ${batch.reference} (own cards)`,
          explanation:
            `A user attempted to approve timecard batch ${batch.reference}, which contains ` +
            `${ownCards.length} card(s) they raised or submitted themselves ` +
            `(${ownCards.map((c) => c.reference).slice(0, 8).join(", ")}). Approving the batch ` +
            "would have flipped every one of those cards to approved with this user recorded as " +
            "the approver — which the card-level route refuses. Batching hours is not a way round " +
            "segregation of duties.",
          evidenceRefs: {
            batchId,
            reference: batch.reference,
            approvalId,
            approverId: actorId,
            breachedRelationship: "raised_cards_in_batch",
            ownCardCount: ownCards.length,
            ownCards: ownCards.map((c) => c.reference).slice(0, 40),
          },
        });
        await ledgerTimecards(app.db, req, "state_change", "timecard_approval", approvalId, {
          control: "no_self_approval",
          outcome: "refused",
          batchId,
          reference: batch.reference,
          breachedRelationship: "raised_cards_in_batch",
          ownCardCount: ownCards.length,
        });
        throw selfApprovalRefusal(
          "timecard batch",
          batch.reference,
          {
            isSelfApproval: true,
            role: "created_by",
            message:
              `${ownCards.length} card(s) in this batch were raised or submitted by the approver ` +
              `(${ownCards.map((c) => c.reference).slice(0, 8).join(", ")}). Approving the batch ` +
              "would approve the approver's own claimed hours.",
          },
          approvalId,
        );
      }
      if (self.isSelfApproval) {
        const approvalId = newId("tap");
        await app.db.insert(timecardApprovals).values({
          id: approvalId,
          companyId,
          projectId,
          timecardId: null,
          batchId,
          level,
          approverId: actorId,
          approverRole: body.approverRole ?? null,
          decision: body.decision,
          decidedAt: nowIso(),
          comment: body.comment ?? null,
          subjectWorkerId: null,
          isSelfApproval: 1,
          delegatedFromId: null,
          escalatedToId: null,
          signatureFileId: body.signatureFileId ?? null,
          detail: {
            outcome: "refused",
            control: "no_self_approval",
            breachedRelationship: self.role,
            attemptedDecision: body.decision,
            batchReference: batch.reference,
          },
        });
        await app.db.insert(signals).values({
          id: newId("sig"),
          companyId,
          projectId,
          detector: "timecard_self_approval",
          severity: "high",
          confidence: 1,
          title: `Self-approval refused on timecard batch ${batch.reference}`,
          explanation:
            `A user attempted to approve timecard batch ${batch.reference} ` +
            `(${batch.periodStart} → ${batch.periodEnd}, ${batch.timecardCount} card(s), ` +
            `${batch.totalHours} h) which they themselves ` +
            `${self.role === "submitted_by" ? "submitted" : "raised"}. The approval was refused and ` +
            `the attempt recorded as approval ${approvalId} with isSelfApproval set. A whole week ` +
            "of a crew's hours approved by the person who claimed them is the single largest " +
            "labour-fraud exposure on a construction project.",
          evidenceRefs: {
            batchId,
            reference: batch.reference,
            approvalId,
            approverId: actorId,
            breachedRelationship: self.role,
            timecardCount: batch.timecardCount,
            totalHours: batch.totalHours,
          },
        });
        await ledgerTimecards(app.db, req, "state_change", "timecard_approval", approvalId, {
          control: "no_self_approval",
          outcome: "refused",
          batchId,
          reference: batch.reference,
          breachedRelationship: self.role,
        });
        throw selfApprovalRefusal("timecard batch", batch.reference, self, approvalId);
      }

      const rollup = await recomputeBatch(app.db, batchId);
      if (body.decision === "approved" && rollup.misallocatedCards.length > 0) {
        throw conflict(
          `Batch ${batch.reference} carries ${rollup.misallocatedCards.length} card(s) whose cost ` +
            `coding no longer reconciles with the hours on the card — ` +
            `${rollup.misallocatedCards.slice(0, 8).join(", ")}. Approving would send those hours ` +
            "to payroll at one figure and to the cost report at another.",
        );
      }
      if (body.decision === "approved" && rollup.unallocatedCards.length > 0) {
        throw conflict(
          `Batch ${batch.reference} carries ${rollup.unallocatedCards.length} card(s) with no cost ` +
            `coding at all — ${rollup.unallocatedCards.slice(0, 8).join(", ")}.`,
        );
      }
      if (body.decision === "approved" && rollup.exceptionCount > 0) {
        throw conflict(
          `Batch ${batch.reference} carries ${rollup.exceptionCount} card(s) whose claimed hours ` +
            "exceed recorded site presence beyond tolerance with no explanation — " +
            `${rollup.unexplainedVarianceCards.slice(0, 8).join(", ")}. Explain or correct them ` +
            "before approving the week.",
        );
      }
      if (body.decision === "rejected" && !(body.comment ?? "").trim()) {
        throw badRequest("A rejection needs a reason — the crew has to know what to fix.");
      }

      const approvalId = newId("tap");
      await app.db.insert(timecardApprovals).values({
        id: approvalId,
        companyId,
        projectId,
        timecardId: null,
        batchId,
        level,
        approverId: actorId,
        approverRole: body.approverRole ?? null,
        decision: body.decision,
        decidedAt: nowIso(),
        comment: body.comment ?? null,
        subjectWorkerId: null,
        isSelfApproval: 0,
        delegatedFromId: null,
        escalatedToId: null,
        signatureFileId: body.signatureFileId ?? null,
        detail: { outcome: "recorded", batchReference: batch.reference },
      });

      const crew = batch.crewId
        ? ((await app.db.select().from(crews).where(eq(crews.id, batch.crewId)))[0] ?? null)
        : null;
      const required = crewConfig(crew).approvalLevels;
      const approvals = await app.db
        .select()
        .from(timecardApprovals)
        .where(eq(timecardApprovals.batchId, batchId));
      const approvedLevels = new Set(
        approvals
          .filter((a) => a.decision === "approved" && a.isSelfApproval === 0)
          .map((a) => a.level),
      );

      const now = nowIso();
      const set: Record<string, unknown> = { updatedAt: now };
      if (body.decision === "approved") {
        if (approvedLevels.size >= required) {
          set["status"] = "approved";
          set["approvedBy"] = actorId;
          set["approvedAt"] = now;
          await app.db
            .update(timecards)
            .set({ status: "approved", approvedBy: actorId, approvedAt: now, updatedAt: now })
            .where(and(eq(timecards.batchId, batchId), eq(timecards.status, "submitted")));
        } else {
          set["status"] = "partially_approved";
        }
      } else if (body.decision === "rejected") {
        set["status"] = "rejected";
        set["rejectedReason"] = body.comment ?? null;
        await app.db
          .update(timecards)
          .set({ status: "rejected", rejectedReason: body.comment ?? null, updatedAt: now })
          .where(and(eq(timecards.batchId, batchId), eq(timecards.status, "submitted")));
      } else {
        set["status"] = "draft";
        set["rejectedReason"] = body.comment ?? null;
        await app.db
          .update(timecards)
          .set({ status: "draft", updatedAt: now })
          .where(and(eq(timecards.batchId, batchId), eq(timecards.status, "submitted")));
      }
      await app.db.update(timecardBatches).set(set).where(eq(timecardBatches.id, batchId));
      await ledgerTimecards(app.db, req, "state_change", "timecard_batch", batchId, {
        reference: batch.reference,
        from: batch.status,
        to: set["status"] ?? batch.status,
        decision: body.decision,
        level,
        approvalId,
        approvedLevels: [...approvedLevels],
        requiredLevels: required,
        totalHours: rollup.totalHours,
        totalCost: rollup.totalCost,
      });
      return {
        ...(await batchView(batchId, companyId, projectId)),
        approvalId,
        level,
        approvedLevels: [...approvedLevels].sort(),
        requiredLevels: required,
        approvalProgress:
          body.decision === "approved"
            ? `approved ${approvedLevels.size} of ${required} tier(s)` +
              (approvedLevels.size < required
                ? ` — tier ${Math.min(3, approvedLevels.size + 1)} still has to sign`
                : "")
            : null,
      };
    },
  );

  app.post(
    "/projects/:projectId/timecard-batches/:batchId/lock",
    { preHandler: gates.admin },
    async (req) => {
      const { batchId } = req.params as { batchId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const batch = await fetchBatch(app.db, batchId, companyId, projectId);
      assertTransition(batch.status, ["approved"], "batch", "lock");
      const now = nowIso();
      await app.db
        .update(timecardBatches)
        .set({ status: "locked", lockedAt: now, updatedAt: now })
        .where(eq(timecardBatches.id, batchId));
      await app.db
        .update(timecards)
        .set({ status: "locked", lockedAt: now, updatedAt: now })
        .where(and(eq(timecards.batchId, batchId), eq(timecards.status, "approved")));
      await ledgerTimecards(app.db, req, "state_change", "timecard_batch", batchId, {
        reference: batch.reference,
        from: batch.status,
        to: "locked",
      });
      return batchView(batchId, companyId, projectId);
    },
  );

  /**
   * Hand the week to payroll. `payrollBatchRef` is the external system's own
   * identifier, and it is the only thread that ties a payment made outside
   * this platform back to the hours that justified it — so it is required,
   * stamped on every card, and after it the cards are frozen.
   */
  app.post(
    "/projects/:projectId/timecard-batches/:batchId/export",
    { preHandler: gates.admin },
    async (req) => {
      const { batchId } = req.params as { batchId: string };
      const body = exportSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const batch = await fetchBatch(app.db, batchId, companyId, projectId);
      assertTransition(batch.status, ["approved", "locked"], "batch", "export");
      const rollup = await computeBatchRollup(app.db, batchId);
      if (rollup.totalCost === null) {
        throw conflict(
          `Batch ${batch.reference} cannot be exported to payroll: ${rollup.reasons.join(" ")} ` +
            "Payroll is paid from this figure, so it is refused rather than approximated.",
        );
      }
      const now = nowIso();
      await app.db
        .update(timecardBatches)
        .set({
          status: "exported",
          exportedAt: now,
          payrollBatchRef: body.payrollBatchRef,
          lockedAt: batch.lockedAt ?? now,
          detail: { ...(batch.detail ?? {}), exportNote: body.note ?? null },
          updatedAt: now,
        })
        .where(eq(timecardBatches.id, batchId));
      await app.db
        .update(timecards)
        .set({
          status: "exported",
          exportedAt: now,
          payrollBatchRef: body.payrollBatchRef,
          lockedAt: now,
          updatedAt: now,
        })
        .where(
          and(eq(timecards.batchId, batchId), inArray(timecards.status, ["approved", "locked"])),
        );
      await ledgerTimecards(app.db, req, "state_change", "timecard_batch", batchId, {
        reference: batch.reference,
        from: batch.status,
        to: "exported",
        payrollBatchRef: body.payrollBatchRef,
        timecardCount: rollup.timecardCount,
        totalHours: rollup.totalHours,
        totalCost: rollup.totalCost,
        currency: rollup.currency,
      });
      return batchView(batchId, companyId, projectId);
    },
  );

  /* --------------------------- helpers ----------------------------- */

  async function collectInto(
    batchId: string,
    companyId: string,
    projectId: string,
    timecardIds: string[] | undefined,
  ): Promise<{
    collected: string[];
    skipped: Array<{ reference: string; reason: string }>;
  }> {
    const batch = await fetchBatch(app.db, batchId, companyId, projectId);
    const clauses = [
      eq(timecards.companyId, companyId),
      eq(timecards.projectId, projectId),
      gte(timecards.workDate, batch.periodStart),
      lte(timecards.workDate, batch.periodEnd),
    ];
    if (timecardIds && timecardIds.length > 0) {
      clauses.push(inArray(timecards.id, timecardIds));
    } else if (batch.crewId) {
      clauses.push(eq(timecards.crewId, batch.crewId));
    } else if (batch.vendorId) {
      clauses.push(eq(timecards.vendorId, batch.vendorId));
    }
    const candidates = await app.db.select().from(timecards).where(and(...clauses));

    const collected: string[] = [];
    const skipped: Array<{ reference: string; reason: string }> = [];
    for (const card of candidates) {
      if (card.batchId === batchId) continue;
      if (card.batchId) {
        skipped.push({
          reference: card.reference,
          reason: `already in another batch (${card.batchId}) — a card belongs to one submission`,
        });
        continue;
      }
      if (!["draft", "rejected"].includes(card.status)) {
        skipped.push({
          reference: card.reference,
          reason: `is "${card.status}" and has moved past collection`,
        });
        continue;
      }
      collected.push(card.id);
    }
    if (collected.length > 0) {
      const currencies = new Set(
        candidates.filter((c) => collected.includes(c.id)).map((c) => c.currency),
      );
      const existing = await app.db
        .select({ currency: timecards.currency })
        .from(timecards)
        .where(eq(timecards.batchId, batchId));
      for (const e of existing) currencies.add(e.currency);
      if (currencies.size > 1) {
        throw badRequest(
          `Collecting these cards would put ${[...currencies].join(" and ")} in one batch. Money ` +
            "is never summed across currencies here — run one batch per currency.",
        );
      }
      await app.db
        .update(timecards)
        .set({ batchId, updatedAt: nowIso() })
        .where(inArray(timecards.id, collected));
    }
    return { collected, skipped };
  }
};

/** Cards in a period that no batch has picked up — the hours that go missing. */
export async function orphanCards(
  db: Db,
  companyId: string,
  projectId: string,
  from: string,
  to: string,
) {
  return db
    .select()
    .from(timecards)
    .where(
      and(
        eq(timecards.companyId, companyId),
        eq(timecards.projectId, projectId),
        gte(timecards.workDate, from),
        lte(timecards.workDate, to),
        isNull(timecards.batchId),
      ),
    );
}
