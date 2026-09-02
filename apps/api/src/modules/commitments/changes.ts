import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  backcharges,
  changeOrderPackages,
  commitmentChanges,
  potentialChangeOrders,
} from "@constructos/db";
import { CHANGE_ORDER_STATUSES, CHANGE_REASONS, COST_TYPES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { applyChangeAllocation, missingSovLineIds } from "./allocation.js";
import { assertAllocationSums, type ChangeLineAllocation } from "./arithmetic.js";
import { commitmentDetail } from "./commitments.js";
import { withIdempotency } from "./idempotency.js";
import { budgetLineIdsFor, recomputeCommitmentTotals, syncBudgetCommitted } from "./rollups.js";
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

/**
 * Optimistic concurrency on the transitions that move money: the client sends
 * back the `updatedAt` it read, and a change order that moved since is refused
 * rather than approved on stale figures.
 */
const concurrencySchema = z.object({
  expectedUpdatedAt: z.string().min(4).optional(),
});

const executeChangeSchema = concurrencySchema.extend({
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
 * Every write that touches more than one row runs inside ONE transaction
 * (plan §6.2): the allocation, the status flip and the budget sync land
 * together or not at all, and a retry cannot re-apply an allocation that
 * already landed because the status check inside the transaction refuses it.
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

  function assertFresh(change: { updatedAt: string }, expected: string | undefined): void {
    if (expected !== undefined && expected !== change.updatedAt) {
      throw conflict(
        "This change order has changed since you read it. Reload it and look at the current " +
          "figures before approving — an approval on stale numbers is not an approval.",
      );
    }
  }

  /**
   * The chain ids a CCO may carry must belong to THIS project (and tenant).
   * They were stored unvalidated before, and the change log joins on them —
   * a cross-tenant package id created a dangling reference in reconciliation.
   */
  async function assertChainLinks(
    commitment: CommitmentRow,
    body: { potentialChangeOrderId?: string | null; changeOrderPackageId?: string | null },
  ): Promise<void> {
    if (body.potentialChangeOrderId) {
      const rows = await app.db
        .select({ id: potentialChangeOrders.id })
        .from(potentialChangeOrders)
        .where(
          and(
            eq(potentialChangeOrders.id, body.potentialChangeOrderId),
            eq(potentialChangeOrders.companyId, commitment.companyId),
            eq(potentialChangeOrders.projectId, commitment.projectId),
          ),
        )
        .limit(1);
      if (!rows[0]) {
        throw badRequest("potentialChangeOrderId does not reference a PCO on this project");
      }
    }
    if (body.changeOrderPackageId) {
      const rows = await app.db
        .select({ id: changeOrderPackages.id, commitmentId: changeOrderPackages.commitmentId })
        .from(changeOrderPackages)
        .where(
          and(
            eq(changeOrderPackages.id, body.changeOrderPackageId),
            eq(changeOrderPackages.companyId, commitment.companyId),
            eq(changeOrderPackages.projectId, commitment.projectId),
          ),
        )
        .limit(1);
      if (!rows[0]) {
        throw badRequest("changeOrderPackageId does not reference a change order package on this project");
      }
      if (rows[0].commitmentId && rows[0].commitmentId !== commitment.id) {
        throw badRequest("changeOrderPackageId references a package against a different commitment");
      }
    }
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
    const missing = await missingSovLineIds(app.db, commitment.id, allocation);
    if (missing.length > 0) {
      throw badRequest(
        `sovLineId ${missing.join(", ")} does not belong to this commitment's schedule of values`,
      );
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
    await assertChainLinks(commitment, body);
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
    await assertChainLinks(commitment, body);
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
   * allocation is re-resolved against the schedule of values AS IT IS NOW —
   * a line deleted since the change order was drafted is a refusal, not a
   * silently dropped share — and then written onto the schedule, which is
   * what makes the new commitment sum derivable rather than asserted. The
   * budget lines the schedule points at are re-synced in the same
   * transaction, so committed cost on the budget moves the same instant.
   */
  app.post(
    "/commitment-changes/:changeId/approve",
    { preHandler: companyGate },
    async (req, reply) => {
      const { changeId } = req.params as { changeId: string };
      const body = concurrencySchema.parse(req.body ?? {});
      const change = await fetchChange(changeId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, change.projectId, "standard");
      return withIdempotency(app.db, req, reply, "commitment-change.approve", async () => {
        if (change.status !== "pending_in_house_review" && change.status !== "pending_owner_approval") {
          throw conflict(
            `A change order in status "${change.status}" cannot be approved. Submit it for ` +
              "review first — approval without review is not an approval.",
          );
        }
        assertFresh(change, body.expectedUpdatedAt);
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
        const missing = await missingSovLineIds(app.db, commitment.id, allocation);
        if (missing.length > 0) {
          throw badRequest(
            `This change order allocates value to schedule line(s) ${missing.join(", ")} that no ` +
              "longer exist. Re-allocate it before approving — otherwise that share of the " +
              "amount would never reach the schedule of values and the register would disagree " +
              "with the sum.",
            { missingSovLineIds: missing },
          );
        }

        const backchargeId =
          typeof (change.detail as Record<string, unknown>)["backchargeId"] === "string"
            ? ((change.detail as Record<string, unknown>)["backchargeId"] as string)
            : null;
        const now = new Date().toISOString();
        const outcome = await app.db.transaction(async (tx) => {
          /*
           * The status is re-checked INSIDE the transaction with the row locked:
           * two approvers clicking at once must not both apply the allocation.
           */
          const locked = await tx
            .select({ status: commitmentChanges.status })
            .from(commitmentChanges)
            .where(eq(commitmentChanges.id, changeId))
            .for("update");
          const current = locked[0]?.status;
          if (current !== "pending_in_house_review" && current !== "pending_owner_approval") {
            throw conflict(
              `This change order is now "${current}" — somebody else moved it first. Nothing ` +
                "was applied twice.",
            );
          }
          const budgetLinesBefore = await budgetLineIdsFor(tx, commitment.id);
          const applied = await applyChangeAllocation(
            tx,
            commitment,
            change.number,
            allocation,
            { changeOrderPackageId: change.changeOrderPackageId },
          );
          await tx
            .update(commitmentChanges)
            .set({
              status: "approved",
              approvedBy: req.user!.id,
              approvedAt: now,
              updatedAt: now,
            })
            .where(eq(commitmentChanges.id, changeId));
          const totals = await recomputeCommitmentTotals(tx, commitment.id);
          await tx
            .update(commitmentChanges)
            .set({ revisedCommitmentSum: totals.revisedCommitmentSum })
            .where(eq(commitmentChanges.id, changeId));
          const budgetLinesAfter = await budgetLineIdsFor(tx, commitment.id);
          const touched = [...new Set([...budgetLinesBefore, ...budgetLinesAfter])];
          if (touched.length > 0) {
            await syncBudgetCommitted(tx, req.companyId!, commitment.projectId, touched);
          }
          if (backchargeId) {
            /* the recovery is now inside the commitment sum — the backcharge is settled */
            await tx
              .update(backcharges)
              .set({ status: "settled", settledAt: now, settledBy: req.user!.id, updatedAt: now })
              .where(and(eq(backcharges.id, backchargeId), eq(backcharges.status, "issued")));
          }
          return { totals, applied };
        });

        await ledger(app.db, req, "state_change", "commitment_change", changeId, {
          status: "approved",
          approvedBy: req.user!.id,
          amount: change.amount,
          revisedCommitmentSum: outcome.totals.revisedCommitmentSum,
          appendedSovLineIds: outcome.applied.appendedSovLineIds,
          updatedSovLineIds: outcome.applied.updatedSovLineIds,
          backchargeId,
        }, change.projectId);
        return fetchChange(changeId, req.companyId!);
      });
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
      return withIdempotency(app.db, req, reply, "commitment-change.execute", async () => {
        if (change.status !== "approved") {
          throw conflict(
            `A change order in status "${change.status}" cannot be executed. Only an approved ` +
              "change order can be executed.",
          );
        }
        assertFresh(change, body.expectedUpdatedAt);
        const now = new Date().toISOString();
        const updated = await app.db
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
          .where(and(eq(commitmentChanges.id, changeId), eq(commitmentChanges.status, "approved")))
          .returning({ id: commitmentChanges.id });
        if (updated.length === 0) {
          throw conflict("This change order was executed by somebody else a moment ago.");
        }
        await recomputeCommitmentTotals(app.db, change.commitmentId);
        await ledger(app.db, req, "state_change", "commitment_change", changeId, {
          status: "executed",
          executedBy: req.user!.id,
        }, change.projectId);
        return fetchChange(changeId, req.companyId!);
      });
    },
  );

  app.post("/commitment-changes/:changeId/void", { preHandler: companyGate }, async (req, reply) => {
    const { changeId } = req.params as { changeId: string };
    const body = rejectSchema.merge(concurrencySchema).parse(req.body);
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
    assertFresh(change, body.expectedUpdatedAt);
    const now = new Date().toISOString();
    const backchargeId =
      typeof (change.detail as Record<string, unknown>)["backchargeId"] === "string"
        ? ((change.detail as Record<string, unknown>)["backchargeId"] as string)
        : null;
    await app.db.transaction(async (tx) => {
      await tx
        .update(commitmentChanges)
        .set({ status: "void", rejectionReason: body.reason, updatedAt: now })
        .where(eq(commitmentChanges.id, changeId));
      await recomputeCommitmentTotals(tx, change.commitmentId);
      if (backchargeId) {
        /* the negative change order is gone; the backcharge goes back to draft */
        await tx
          .update(backcharges)
          .set({ status: "draft", commitmentChangeId: null, updatedAt: now })
          .where(and(eq(backcharges.id, backchargeId), eq(backcharges.status, "issued")));
      }
    });
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
};
