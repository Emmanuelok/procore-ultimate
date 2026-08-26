import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { commitmentChanges, commitmentSovLines } from "@constructos/db";
import { CHANGE_ORDER_STATUSES, CHANGE_REASONS, COST_TYPES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { assertAllocationSums, deriveSovLine, type ChangeLineAllocation } from "./arithmetic.js";
import { commitmentDetail } from "./commitments.js";
import {
  budgetLineIdsFor,
  recomputeCommitmentTotals,
  syncBudgetCommitted,
} from "./rollups.js";
import { insertSovLine, sovContext } from "./sov.js";
import {
  assertSegregation,
  changeReference,
  detailSchema,
  fetchCommitment,
  isCommittedChange,
  isDeadChange,
  isPendingChange,
  isoDateSchema,
  ledger,
  moneySchema,
  requireCommitmentsLevel,
  round2,
  todayIso,
  type CommitmentRow,
} from "./shared.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

/**
 * One line of a change order's cost allocation.
 *
 * `sovLineId` loads the change onto an EXISTING schedule line — the right
 * answer when a sub is doing more of something already in the schedule.
 * Omitting it appends a new schedule line flagged `isChangeOrderLine = 1`,
 * which is the right answer for genuinely new scope, and is what keeps the
 * original schedule of values readable as the original schedule of values.
 */
const changeLineSchema = z.object({
  sovLineId: z.string().min(1).max(64).nullable().optional(),
  costCode: z.string().min(1).max(50).nullable().optional(),
  costType: z.enum(COST_TYPES).optional(),
  budgetLineItemId: z.string().min(1).max(64).nullable().optional(),
  description: z.string().min(1).max(2000),
  amount: moneySchema,
  unit: z.string().min(1).max(20).nullable().optional(),
  quantity: z.number().finite().nullable().optional(),
  unitRate: z.number().finite().nullable().optional(),
});

const changeCreateSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  reason: z.enum(CHANGE_REASONS).nullable().optional(),
  /** omit to derive from the line allocation */
  amount: moneySchema.optional(),
  scheduleImpactDays: z.number().int().min(-3650).max(3650).optional(),
  lines: z.array(changeLineSchema).max(500).optional(),
  requestedDate: isoDateSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  /** the PCO this settles, and the package that will execute it */
  potentialChangeOrderId: z.string().min(1).max(64).nullable().optional(),
  changeOrderPackageId: z.string().min(1).max(64).nullable().optional(),
  detail: detailSchema.optional(),
});

const changePatchSchema = changeCreateSchema.partial();

const changeListQuery = pageQuerySchema.extend({
  status: z.enum(CHANGE_ORDER_STATUSES).optional(),
  reason: z.enum(CHANGE_REASONS).optional(),
});

const rejectSchema = z.object({
  reason: z.string().min(1).max(4000),
});

const executeChangeSchema = z.object({
  executedDate: isoDateSchema.optional(),
  signedChangeOrderReceivedDate: isoDateSchema.nullable().optional(),
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/**
 * COMMITMENT CHANGE ORDERS — draft -> pending -> approved -> executed.
 *
 * Where the money actually moves is APPROVAL. Approving a change order writes
 * its allocation onto the schedule of values (bumping `changeOrderValue` on
 * existing lines, appending flagged lines for new scope) and the commitment's
 * `approvedChangeSum` follows from the schedule, exactly as the original sum
 * does. Executing it afterwards records the signed paperwork; it does not
 * move a number a second time, because a change order counted twice is the
 * classic way a commitment sum and a schedule of values stop agreeing.
 *
 * Draft change orders sit in `draftChangeSum` and pending ones in
 * `pendingChangeSum` — both outside the commitment sum, both visible, because
 * exposure that only appears once it is approved is exposure nobody managed.
 *
 * An approved change order is never voided. It is reversed by a negative one,
 * so the register stays a history rather than a current opinion.
 */
export const changeRoutes: FastifyPluginAsync = async (app) => {
  const companyGate = [app.authenticate, app.requireCompany];

  async function fetchChange(changeId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(commitmentChanges)
      .where(and(eq(commitmentChanges.id, changeId), eq(commitmentChanges.companyId, companyId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Commitment change order not found");
    return row;
  }

  /** Validate the allocation against the commitment's own schedule of values. */
  async function resolveAllocation(
    commitment: CommitmentRow,
    amount: number | undefined,
    lines: readonly z.infer<typeof changeLineSchema>[] | undefined,
  ): Promise<{ amount: number; allocation: ChangeLineAllocation[] }> {
    const allocation: ChangeLineAllocation[] = (lines ?? []).map((l) => ({
      sovLineId: l.sovLineId ?? null,
      costCode: l.costCode ?? null,
      costType: l.costType ?? null,
      description: l.description,
      amount: round2(l.amount),
      budgetLineItemId: l.budgetLineItemId ?? null,
    }));
    const sovIds = allocation
      .map((l) => l.sovLineId)
      .filter((id): id is string => typeof id === "string");
    if (sovIds.length > 0) {
      const rows = await app.db
        .select({ id: commitmentSovLines.id })
        .from(commitmentSovLines)
        .where(
          and(
            eq(commitmentSovLines.commitmentId, commitment.id),
            inArray(commitmentSovLines.id, sovIds),
          ),
        );
      const found = new Set(rows.map((r) => r.id));
      const missing = sovIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw badRequest(
          `sovLineId ${missing.join(", ")} does not belong to this commitment's schedule of values`,
        );
      }
    }
    /* amount omitted means "the allocation is the amount" */
    const resolvedAmount =
      amount === undefined
        ? round2(allocation.reduce((s, l) => s + l.amount, 0))
        : round2(amount);
    const sums = assertAllocationSums(resolvedAmount, allocation);
    if (!sums.ok) throw badRequest(sums.message);
    return { amount: resolvedAmount, allocation };
  }

  /* ---------------------------------------------------------------- */
  /* Create + read                                                     */
  /* ---------------------------------------------------------------- */

  app.post("/commitments/:commitmentId/changes", { preHandler: companyGate }, async (req, reply) => {
    const { commitmentId } = req.params as { commitmentId: string };
    const body = changeCreateSchema.parse(req.body);
    const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "standard");
    if (commitment.status === "void" || commitment.status === "terminated") {
      throw conflict(
        `This commitment is ${commitment.status}; no further change orders can be raised on it`,
      );
    }
    if (body.amount === undefined && (!body.lines || body.lines.length === 0)) {
      throw badRequest("A change order needs either an amount or a line allocation");
    }
    const { amount, allocation } = await resolveAllocation(commitment, body.amount, body.lines);

    const number = await nextRecordNumber(
      app.db,
      commitment.projectId,
      `commitment_change:${commitmentId}`,
    );
    const id = newId("cco");
    await app.db.insert(commitmentChanges).values({
      id,
      companyId: req.companyId!,
      projectId: commitment.projectId,
      commitmentId,
      number,
      reference: changeReference(commitment.reference, number),
      changeOrderPackageId: body.changeOrderPackageId ?? null,
      potentialChangeOrderId: body.potentialChangeOrderId ?? null,
      title: body.title,
      description: body.description ?? null,
      reason: body.reason ?? null,
      status: "draft",
      amount,
      scheduleImpactDays: body.scheduleImpactDays ?? 0,
      lines: allocation,
      /* stamped for real at approval — a draft has not moved the sum */
      revisedCommitmentSum: commitment.revisedCommitmentSum,
      requestedDate: body.requestedDate ?? todayIso(),
      dueDate: body.dueDate ?? null,
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });
    await recomputeCommitmentTotals(app.db, commitmentId);
    await ledger(app.db, req, "create", "commitment_change", id, {
      commitmentId,
      number,
      amount,
      lineCount: allocation.length,
    }, commitment.projectId);
    return reply.status(201).send(await fetchChange(id, req.companyId!));
  });

  app.get("/commitments/:commitmentId/changes", { preHandler: companyGate }, async (req, reply) => {
    const { commitmentId } = req.params as { commitmentId: string };
    const q = changeListQuery.parse(req.query);
    const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "read");
    const clauses = [eq(commitmentChanges.commitmentId, commitmentId)];
    if (q.status) clauses.push(eq(commitmentChanges.status, q.status));
    if (q.reason) clauses.push(eq(commitmentChanges.reason, q.reason));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(commitmentChanges).where(where);
    const items = await app.db
      .select()
      .from(commitmentChanges)
      .where(where)
      .orderBy(desc(commitmentChanges.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const all = await app.db
      .select({ status: commitmentChanges.status, amount: commitmentChanges.amount })
      .from(commitmentChanges)
      .where(eq(commitmentChanges.commitmentId, commitmentId));
    return {
      ...paginate(items, Number(totalRow?.n ?? 0), q),
      currency: commitment.currency,
      register: {
        committed: round2(
          all.filter((c) => isCommittedChange(c.status)).reduce((s, c) => s + c.amount, 0),
        ),
        pending: round2(
          all.filter((c) => isPendingChange(c.status)).reduce((s, c) => s + c.amount, 0),
        ),
        draft: round2(
          all.filter((c) => c.status === "draft").reduce((s, c) => s + c.amount, 0),
        ),
        dead: round2(all.filter((c) => isDeadChange(c.status)).reduce((s, c) => s + c.amount, 0)),
      },
    };
  });

  app.get("/commitment-changes/:changeId", { preHandler: companyGate }, async (req, reply) => {
    const { changeId } = req.params as { changeId: string };
    const change = await fetchChange(changeId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, change.projectId, "read");
    return change;
  });

  /* ---------------------------------------------------------------- */
  /* Edit                                                              */
  /* ---------------------------------------------------------------- */

  app.patch("/commitment-changes/:changeId", { preHandler: companyGate }, async (req, reply) => {
    const { changeId } = req.params as { changeId: string };
    const body = changePatchSchema.parse(req.body);
    const change = await fetchChange(changeId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, change.projectId, "standard");
    if (change.status !== "draft" && change.status !== "revise_and_resubmit") {
      throw conflict(
        `A change order in status "${change.status}" cannot be edited. Only draft and ` +
          "revise_and_resubmit change orders are editable — an approved one is reversed by a " +
          "negative change order, never rewritten.",
      );
    }
    const commitment = await fetchCommitment(app.db, change.commitmentId, req.companyId!);
    const wantsAllocation = body.lines !== undefined || body.amount !== undefined;
    let amount = change.amount;
    let allocation = (change.lines ?? []) as ChangeLineAllocation[];
    if (wantsAllocation) {
      const lines =
        body.lines !== undefined
          ? body.lines
          : allocation.map((l) => ({
              sovLineId: l.sovLineId,
              costCode: l.costCode,
              costType: (l.costType ?? undefined) as z.infer<typeof changeLineSchema>["costType"],
              budgetLineItemId: l.budgetLineItemId,
              description: l.description,
              amount: l.amount,
            }));
      const resolved = await resolveAllocation(
        commitment,
        body.amount ?? (body.lines !== undefined ? undefined : change.amount),
        lines,
      );
      amount = resolved.amount;
      allocation = resolved.allocation;
    }
    await app.db
      .update(commitmentChanges)
      .set({
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        ...(body.scheduleImpactDays !== undefined
          ? { scheduleImpactDays: body.scheduleImpactDays }
          : {}),
        ...(body.requestedDate !== undefined ? { requestedDate: body.requestedDate } : {}),
        ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
        ...(body.potentialChangeOrderId !== undefined
          ? { potentialChangeOrderId: body.potentialChangeOrderId }
          : {}),
        ...(body.changeOrderPackageId !== undefined
          ? { changeOrderPackageId: body.changeOrderPackageId }
          : {}),
        ...(body.detail !== undefined ? { detail: body.detail } : {}),
        ...(wantsAllocation ? { amount, lines: allocation } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(commitmentChanges.id, changeId));
    await recomputeCommitmentTotals(app.db, change.commitmentId);
    await ledger(app.db, req, "update", "commitment_change", changeId, {
      changed: Object.keys(body),
      amount,
    }, change.projectId);
    return fetchChange(changeId, req.companyId!);
  });

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  app.post(
    "/commitment-changes/:changeId/submit",
    { preHandler: companyGate },
    async (req, reply) => {
      const { changeId } = req.params as { changeId: string };
      const change = await fetchChange(changeId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, change.projectId, "standard");
      if (change.status !== "draft" && change.status !== "revise_and_resubmit") {
        throw conflict(`A change order in status "${change.status}" cannot be submitted`);
      }
      const now = new Date().toISOString();
      await app.db
        .update(commitmentChanges)
        .set({
          status: "pending_in_house_review",
          submittedBy: req.user!.id,
          submittedAt: now,
          updatedAt: now,
        })
        .where(eq(commitmentChanges.id, changeId));
      await recomputeCommitmentTotals(app.db, change.commitmentId);
      await ledger(app.db, req, "state_change", "commitment_change", changeId, {
        status: "pending_in_house_review",
        submittedBy: req.user!.id,
      }, change.projectId);
      return fetchChange(changeId, req.companyId!);
    },
  );

  /**
   * APPROVAL — the transition that moves money.
   *
   * The approver may be neither the author nor the submitter (ADR 0004). The
   * allocation is then written onto the schedule of values, which is what
   * makes the new commitment sum derivable rather than asserted, and the
   * budget lines the schedule points at are re-synced so committed cost on
   * the budget follows the same second.
   */
  app.post(
    "/commitment-changes/:changeId/approve",
    { preHandler: companyGate },
    async (req, reply) => {
      const { changeId } = req.params as { changeId: string };
      const change = await fetchChange(changeId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, change.projectId, "standard");
      if (change.status !== "pending_in_house_review" && change.status !== "pending_owner_approval") {
        throw conflict(
          `A change order in status "${change.status}" cannot be approved. Submit it for ` +
            "review first — approval without review is not an approval.",
        );
      }
      assertSegregation(
        req.user!.id,
        { createdBy: change.createdBy, submittedBy: change.submittedBy },
        "change order",
      );
      const commitment = await fetchCommitment(app.db, change.commitmentId, req.companyId!);
      if (commitment.status === "void" || commitment.status === "terminated") {
        throw conflict(
          `This commitment is ${commitment.status}; its change orders can no longer be approved`,
        );
      }
      const allocation = (change.lines ?? []) as ChangeLineAllocation[];
      if (allocation.length === 0) {
        throw badRequest(
          "This change order has no line allocation, so approving it could not post the value " +
            "to a cost code or to the schedule of values. Allocate it before approving it.",
        );
      }
      const sums = assertAllocationSums(change.amount, allocation);
      if (!sums.ok) throw badRequest(sums.message);

      const budgetLinesBefore = await budgetLineIdsFor(app.db, commitment.id);
      await applyAllocation(commitment, change.number, allocation, change.changeOrderPackageId);
      const totals = await recomputeCommitmentTotals(app.db, commitment.id);

      const now = new Date().toISOString();
      await app.db
        .update(commitmentChanges)
        .set({
          status: "approved",
          approvedBy: req.user!.id,
          approvedAt: now,
          revisedCommitmentSum: totals.revisedCommitmentSum,
          updatedAt: now,
        })
        .where(eq(commitmentChanges.id, changeId));
      /* recompute again: the change has moved from pending into approved */
      await recomputeCommitmentTotals(app.db, commitment.id);

      const budgetLinesAfter = await budgetLineIdsFor(app.db, commitment.id);
      const touched = [...new Set([...budgetLinesBefore, ...budgetLinesAfter])];
      if (touched.length > 0) {
        await syncBudgetCommitted(app.db, req.companyId!, commitment.projectId, touched);
      }
      await ledger(app.db, req, "state_change", "commitment_change", changeId, {
        status: "approved",
        approvedBy: req.user!.id,
        amount: change.amount,
        revisedCommitmentSum: totals.revisedCommitmentSum,
      }, change.projectId);
      return fetchChange(changeId, req.companyId!);
    },
  );

  app.post(
    "/commitment-changes/:changeId/reject",
    { preHandler: companyGate },
    async (req, reply) => {
      const { changeId } = req.params as { changeId: string };
      const body = rejectSchema.parse(req.body);
      const change = await fetchChange(changeId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, change.projectId, "standard");
      if (!isPendingChange(change.status)) {
        throw conflict(`A change order in status "${change.status}" cannot be rejected`);
      }
      assertSegregation(
        req.user!.id,
        { createdBy: change.createdBy, submittedBy: change.submittedBy },
        "change order",
      );
      const now = new Date().toISOString();
      await app.db
        .update(commitmentChanges)
        .set({
          status: "rejected",
          rejectedBy: req.user!.id,
          rejectedAt: now,
          rejectionReason: body.reason,
          updatedAt: now,
        })
        .where(eq(commitmentChanges.id, changeId));
      await recomputeCommitmentTotals(app.db, change.commitmentId);
      await ledger(app.db, req, "state_change", "commitment_change", changeId, {
        status: "rejected",
        reason: body.reason,
      }, change.projectId);
      return fetchChange(changeId, req.companyId!);
    },
  );

  /** Send it back for repricing without killing it. */
  app.post(
    "/commitment-changes/:changeId/revise",
    { preHandler: companyGate },
    async (req, reply) => {
      const { changeId } = req.params as { changeId: string };
      const body = rejectSchema.parse(req.body);
      const change = await fetchChange(changeId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, change.projectId, "standard");
      if (!isPendingChange(change.status)) {
        throw conflict(`A change order in status "${change.status}" cannot be sent back`);
      }
      const now = new Date().toISOString();
      await app.db
        .update(commitmentChanges)
        .set({ status: "revise_and_resubmit", rejectionReason: body.reason, updatedAt: now })
        .where(eq(commitmentChanges.id, changeId));
      await recomputeCommitmentTotals(app.db, change.commitmentId);
      await ledger(app.db, req, "state_change", "commitment_change", changeId, {
        status: "revise_and_resubmit",
        reason: body.reason,
      }, change.projectId);
      return fetchChange(changeId, req.companyId!);
    },
  );

  /**
   * Execution records the signed change order. It deliberately moves no money:
   * the value went into the schedule of values at approval, and adding it
   * again here is precisely how a commitment sum and its schedule stop
   * agreeing.
   */
  app.post(
    "/commitment-changes/:changeId/execute",
    { preHandler: companyGate },
    async (req, reply) => {
      const { changeId } = req.params as { changeId: string };
      const body = executeChangeSchema.parse(req.body ?? {});
      const change = await fetchChange(changeId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, change.projectId, "standard");
      if (change.status !== "approved") {
        throw conflict(
          `A change order in status "${change.status}" cannot be executed. Only an approved ` +
            "change order can be executed.",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(commitmentChanges)
        .set({
          status: "executed",
          executedBy: req.user!.id,
          executedDate: body.executedDate ?? todayIso(),
          ...(body.signedChangeOrderReceivedDate !== undefined
            ? { signedChangeOrderReceivedDate: body.signedChangeOrderReceivedDate }
            : {}),
          updatedAt: now,
        })
        .where(eq(commitmentChanges.id, changeId));
      await recomputeCommitmentTotals(app.db, change.commitmentId);
      await ledger(app.db, req, "state_change", "commitment_change", changeId, {
        status: "executed",
        executedBy: req.user!.id,
      }, change.projectId);
      return fetchChange(changeId, req.companyId!);
    },
  );

  app.post("/commitment-changes/:changeId/void", { preHandler: companyGate }, async (req, reply) => {
    const { changeId } = req.params as { changeId: string };
    const body = rejectSchema.parse(req.body);
    const change = await fetchChange(changeId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, change.projectId, "standard");
    if (isCommittedChange(change.status)) {
      throw conflict(
        `This change order is ${change.status} and its value is already inside the commitment ` +
          "sum. Reverse it with a negative change order rather than voiding it — voiding would " +
          "silently move the commitment sum with no record of why.",
      );
    }
    if (change.status === "void") throw conflict("This change order is already void");
    const now = new Date().toISOString();
    await app.db
      .update(commitmentChanges)
      .set({ status: "void", rejectionReason: body.reason, updatedAt: now })
      .where(eq(commitmentChanges.id, changeId));
    await recomputeCommitmentTotals(app.db, change.commitmentId);
    await ledger(app.db, req, "state_change", "commitment_change", changeId, {
      status: "void",
      reason: body.reason,
    }, change.projectId);
    return fetchChange(changeId, req.companyId!);
  });

  app.delete("/commitment-changes/:changeId", { preHandler: companyGate }, async (req, reply) => {
    const { changeId } = req.params as { changeId: string };
    const change = await fetchChange(changeId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, change.projectId, "admin");
    if (change.status !== "draft") {
      throw conflict(
        `Only a draft change order can be deleted; this one is ${change.status}. Void it instead.`,
      );
    }
    await app.db.delete(commitmentChanges).where(eq(commitmentChanges.id, changeId));
    await recomputeCommitmentTotals(app.db, change.commitmentId);
    await ledger(app.db, req, "delete", "commitment_change", changeId, {
      reference: change.reference,
    }, change.projectId);
    return reply.status(204).send();
  });

  /** The commitment view after a change-order transition, for the client. */
  app.get(
    "/commitment-changes/:changeId/commitment",
    { preHandler: companyGate },
    async (req, reply) => {
      const { changeId } = req.params as { changeId: string };
      const change = await fetchChange(changeId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, change.projectId, "read");
      return commitmentDetail(app.db, change.commitmentId, req.companyId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Allocation                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Write an approved change order's allocation onto the schedule of values.
   *
   * Existing lines take the value on `changeOrderValue`, leaving
   * `scheduledValue` — the original contract figure — untouched forever. New
   * scope appends a line carrying `isChangeOrderLine = 1` and the package id,
   * numbered `CO-<change number>.<n>` so the continuation sheet reads in the
   * order the change orders landed.
   */
  async function applyAllocation(
    commitment: CommitmentRow,
    changeNumber: number,
    allocation: readonly ChangeLineAllocation[],
    changeOrderPackageId: string | null,
  ): Promise<void> {
    const byExisting = new Map<string, number>();
    const appended: ChangeLineAllocation[] = [];
    for (const line of allocation) {
      if (line.sovLineId) {
        byExisting.set(line.sovLineId, (byExisting.get(line.sovLineId) ?? 0) + line.amount);
      } else {
        appended.push(line);
      }
    }

    if (byExisting.size > 0) {
      const rows = await app.db
        .select()
        .from(commitmentSovLines)
        .where(inArray(commitmentSovLines.id, [...byExisting.keys()]));
      for (const row of rows) {
        const delta = byExisting.get(row.id) ?? 0;
        const changeOrderValue = round2(row.changeOrderValue + delta);
        const derived = deriveSovLine({
          scheduledValue: row.scheduledValue,
          changeOrderValue,
          previousBilled: row.previousBilled,
          previousStoredMaterials: row.previousStoredMaterials,
          thisPeriodWork: row.thisPeriodWork,
          thisPeriodStoredMaterials: row.thisPeriodStoredMaterials,
          materialsPresentlyStored: row.materialsPresentlyStored,
          retainagePercent: row.retainagePercent,
          retainageReleased: row.retainageReleased,
        });
        await app.db
          .update(commitmentSovLines)
          .set({
            changeOrderValue,
            revisedScheduledValue: derived.revisedScheduledValue,
            totalCompletedAndStored: derived.totalCompletedAndStored,
            percentComplete: derived.percentComplete,
            balanceToFinish: derived.balanceToFinish,
            retainageHeld: derived.retainageHeld,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(commitmentSovLines.id, row.id));
      }
    }

    if (appended.length > 0) {
      const ctx = await sovContext(
        app.db,
        commitment.companyId,
        commitment.projectId,
        commitment,
      );
      let n = 0;
      for (const line of appended) {
        n += 1;
        const id = await insertSovLine(
          ctx,
          {
            lineNumber: `CO-${String(changeNumber).padStart(3, "0")}.${n}`,
            description: line.description,
            costCode: line.costCode,
            ...(line.costType
              ? { costType: line.costType as (typeof COST_TYPES)[number] }
              : {}),
            budgetLineItemId: line.budgetLineItemId,
            scheduledValue: 0,
            retainagePercent: commitment.defaultRetainagePercent,
          },
          { isChangeOrderLine: true, changeOrderPackageId },
        );
        /*
         * A change-order line's whole value is change-order value; its
         * scheduled value stays 0, which is what keeps originalCommitmentSum
         * equal to the original subcontract however many changes land.
         */
        const derived = deriveSovLine({
          scheduledValue: 0,
          changeOrderValue: line.amount,
          previousBilled: 0,
          previousStoredMaterials: 0,
          thisPeriodWork: 0,
          thisPeriodStoredMaterials: 0,
          materialsPresentlyStored: 0,
          retainagePercent: commitment.defaultRetainagePercent,
          retainageReleased: 0,
        });
        await app.db
          .update(commitmentSovLines)
          .set({
            changeOrderValue: line.amount,
            revisedScheduledValue: derived.revisedScheduledValue,
            balanceToFinish: derived.balanceToFinish,
            percentComplete: derived.percentComplete,
            retainageHeld: derived.retainageHeld,
          })
          .where(eq(commitmentSovLines.id, id));
      }
    }
  }
};
