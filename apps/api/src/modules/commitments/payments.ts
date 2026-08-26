import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  commitmentPayments,
  commitmentSovLines,
  invoiceLineItems,
  invoices,
  lienWaivers,
} from "@constructos/db";
import { PAYMENT_METHODS, PAYMENT_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { deriveSovLine } from "./arithmetic.js";
import { assessCommitment, type ComplianceResult } from "./compliance.js";
import { commitmentPosition, recomputeCommitmentTotals } from "./rollups.js";
import {
  assertSameCurrency,
  assertSegregation,
  currencySchema,
  detailSchema,
  fetchCommitment,
  isoDateSchema,
  isPaidPayment,
  ledger,
  nonNegativeMoneySchema,
  paymentReference,
  requireCommitmentsLevel,
  round2,
  todayIso,
  type CommitmentRow,
} from "./shared.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const jointPayeeSchema = z.object({
  name: z.string().min(1).max(300),
  vendorId: z.string().min(1).max(64).nullable().optional(),
});

const paymentCreateSchema = z.object({
  invoiceId: z.string().min(1).max(64).nullable().optional(),
  amount: nonNegativeMoneySchema,
  method: z.enum(PAYMENT_METHODS).optional(),
  retainageReleasedAmount: nonNegativeMoneySchema.optional(),
  discountTaken: nonNegativeMoneySchema.optional(),
  currency: currencySchema.optional(),
  paymentDate: isoDateSchema.nullable().optional(),
  checkNumber: z.string().min(1).max(80).nullable().optional(),
  transactionReference: z.string().min(1).max(200).nullable().optional(),
  bankAccountRef: z.string().min(1).max(200).nullable().optional(),
  jointPayees: z.array(jointPayeeSchema).max(20).optional(),
  lienWaiverId: z.string().min(1).max(64).nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  detail: detailSchema.optional(),
});

const paymentPatchSchema = paymentCreateSchema.partial().omit({ currency: true });

const paymentListQuery = pageQuerySchema.extend({
  status: z.enum(PAYMENT_STATUSES).optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
});

const issueSchema = z.object({
  paymentDate: isoDateSchema.optional(),
  checkNumber: z.string().min(1).max(80).nullable().optional(),
  transactionReference: z.string().min(1).max(200).nullable().optional(),
  /**
   * Explicit acknowledgement of non-blocking compliance warnings. Warnings do
   * not stop a payment, but the acknowledgement is recorded on the payment and
   * in the ledger, so "we knew and paid anyway" is a fact rather than a guess.
   */
  acknowledgeWarnings: z.boolean().optional(),
});

const reasonSchema = z.object({ reason: z.string().min(1).max(4000) });

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/**
 * PAYMENTS AGAINST A COMMITMENT, and the read side of the invoices raised
 * against it.
 *
 * Three acts by three people on three days, and the schema keeps them apart
 * on purpose:
 *
 *   schedule   somebody says a payment is due          createdBy
 *   approve    somebody with authority releases it     approvedBy
 *   issue      somebody cuts the cheque / sends ACH    issuedBy
 *
 * The compliance gate fires hardest at ISSUE, because that is the moment the
 * money is irrecoverable. An expired insurance certificate, a missing bond or
 * an outstanding lien waiver either warns or refuses depending on the
 * strictness configured on the commitment; an explicit payment hold refuses at
 * every strictness, since somebody typed a reason on purpose.
 *
 * Subcontractor invoices themselves are written by the invoicing module. What
 * lives here is the READ side plus the committed / invoiced / paid rollup, so
 * the commitment page answers "where are we with this sub" without the two
 * modules disagreeing about the arithmetic.
 */
export const paymentRoutes: FastifyPluginAsync = async (app) => {
  const companyGate = [app.authenticate, app.requireCompany];

  async function fetchPayment(paymentId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(commitmentPayments)
      .where(
        and(eq(commitmentPayments.id, paymentId), eq(commitmentPayments.companyId, companyId)),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Payment not found");
    return row;
  }

  /**
   * Refuse a payment that would take total scheduled + paid past the revised
   * commitment sum. This is the one over-payment guard that is always safe:
   * it needs no invoice to exist and no currency conversion, and paying a sub
   * more than their subcontract is worth is never a rounding question.
   */
  async function assertWithinCommitment(
    commitment: CommitmentRow,
    amount: number,
    excludePaymentId?: string,
  ): Promise<{ warnings: string[] }> {
    const rows = await app.db
      .select({
        id: commitmentPayments.id,
        amount: commitmentPayments.amount,
        status: commitmentPayments.status,
      })
      .from(commitmentPayments)
      .where(eq(commitmentPayments.commitmentId, commitment.id));
    const live = rows.filter(
      (p) => p.id !== excludePaymentId && p.status !== "voided" && p.status !== "failed",
    );
    const committedOut = round2(live.reduce((s, p) => s + p.amount, 0) + amount);
    if (committedOut - commitment.revisedCommitmentSum > 0.005) {
      throw badRequest(
        `Payments against this commitment would total ${committedOut} ${commitment.currency}, ` +
          `above its revised commitment sum of ${commitment.revisedCommitmentSum} ` +
          `${commitment.currency}. Raise a change order before paying more than the ` +
          "subcontract is worth.",
      );
    }
    const warnings: string[] = [];
    if (committedOut - commitment.totalInvoiced > 0.005) {
      warnings.push(
        `Payments total ${committedOut} ${commitment.currency} against ` +
          `${commitment.totalInvoiced} ${commitment.currency} invoiced. Paying ahead of ` +
          "invoices is permitted but is an advance, not a progress payment.",
      );
    }
    return { warnings };
  }

  /** Refuse a retainage release larger than the retainage actually held. */
  async function assertRetainageAvailable(
    commitment: CommitmentRow,
    release: number,
    excludePaymentId?: string,
  ): Promise<void> {
    if (release === 0) return;
    const rows = await app.db
      .select({
        id: commitmentPayments.id,
        released: commitmentPayments.retainageReleasedAmount,
        status: commitmentPayments.status,
      })
      .from(commitmentPayments)
      .where(eq(commitmentPayments.commitmentId, commitment.id));
    /*
     * Only payments that have NOT yet been issued are counted as reservations.
     * An issued payment has already reduced `retainageHeld` on the schedule of
     * values, so counting it here as well would reserve the same money twice.
     */
    const alreadyScheduled = round2(
      rows
        .filter(
          (p) =>
            p.id !== excludePaymentId && (p.status === "scheduled" || p.status === "on_hold"),
        )
        .reduce((s, p) => s + p.released, 0),
    );
    const available = round2(commitment.retainageHeld - alreadyScheduled);
    if (commitment.retainageHeld <= 0) {
      throw badRequest(
        "No retainage is held on this commitment, so none can be released. Retainage is held " +
          "as the sub bills; check the schedule of values before releasing.",
      );
    }
    if (release - available > 0.005) {
      throw badRequest(
        `Releasing ${release} ${commitment.currency} would exceed the ${available} ` +
          `${commitment.currency} of retainage still available (held ` +
          `${commitment.retainageHeld}, already scheduled for release ${alreadyScheduled}).`,
      );
    }
  }

  /**
   * Spread a retainage release across the schedule of values in proportion to
   * the retainage each line is holding, so `retainageHeld` stays derivable
   * from the lines instead of becoming a header figure nobody can trace. A
   * rounding remainder lands on the largest holder rather than disappearing.
   */
  async function allocateRetainageRelease(
    commitment: CommitmentRow,
    release: number,
  ): Promise<void> {
    if (release === 0) return;
    const lines = await app.db
      .select()
      .from(commitmentSovLines)
      .where(eq(commitmentSovLines.commitmentId, commitment.id));
    /*
     * Releasing spreads over what each line still HOLDS; reversing a voided
     * payment spreads back over what each line has already had RELEASED. Using
     * the held figure for a reversal would push retainage back onto lines that
     * never gave any up.
     */
    const basisOf = (l: (typeof lines)[number]): number =>
      release > 0 ? l.retainageHeld : l.retainageReleased;
    const holders = lines.filter((l) => basisOf(l) > 0);
    const totalBasis = round2(holders.reduce((s, l) => s + basisOf(l), 0));
    if (totalBasis <= 0) {
      throw badRequest(
        release > 0
          ? "No schedule-of-values line is holding retainage on this commitment"
          : "No schedule-of-values line has released retainage to reverse",
      );
    }
    let allocated = 0;
    const shares = holders.map((line, i) => {
      const share =
        i === holders.length - 1
          ? round2(release - allocated)
          : round2((basisOf(line) / totalBasis) * release);
      allocated = round2(allocated + share);
      return { line, share };
    });
    for (const { line, share } of shares) {
      if (share === 0) continue;
      const retainageReleased = round2(line.retainageReleased + share);
      const derived = deriveSovLine({
        scheduledValue: line.scheduledValue,
        changeOrderValue: line.changeOrderValue,
        previousBilled: line.previousBilled,
        previousStoredMaterials: line.previousStoredMaterials,
        thisPeriodWork: line.thisPeriodWork,
        thisPeriodStoredMaterials: line.thisPeriodStoredMaterials,
        materialsPresentlyStored: line.materialsPresentlyStored,
        retainagePercent: line.retainagePercent,
        retainageReleased,
      });
      await app.db
        .update(commitmentSovLines)
        .set({
          retainageReleased,
          retainageHeld: derived.retainageHeld,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(commitmentSovLines.id, line.id));
    }
  }

  /** Throw a 409 carrying the full compliance result when anything blocks. */
  function assertCompliancePermits(
    commitment: CommitmentRow,
    compliance: ComplianceResult,
    act: string,
  ): void {
    if (compliance.blocking.length === 0) return;
    throw new AppError(
      409,
      `${act} is refused: ${compliance.blocking.map((f) => f.message).join(" ")}`,
      {
        control: "compliance_gate",
        strictness: compliance.strictness,
        commitmentId: commitment.id,
        commitmentReference: commitment.reference,
        blocking: compliance.blocking,
        warnings: compliance.warnings,
        remedy:
          compliance.strictness === "block"
            ? "Update the vendor's insurance or bonding records, or lower the commitment's " +
              "compliance strictness to warn if the exposure is knowingly accepted."
            : "Clear the payment hold on this commitment before issuing payment.",
      },
    );
  }

  /* ---------------------------------------------------------------- */
  /* Create + read                                                     */
  /* ---------------------------------------------------------------- */

  app.post(
    "/commitments/:commitmentId/payments",
    { preHandler: companyGate },
    async (req, reply) => {
      const { commitmentId } = req.params as { commitmentId: string };
      const body = paymentCreateSchema.parse(req.body);
      const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, commitment.projectId, "standard");
      if (commitment.status !== "approved" && commitment.status !== "complete") {
        throw conflict(
          `This commitment is ${commitment.status}. A payment can only be scheduled against an ` +
            "approved commitment — paying against an unapproved subcontract is uncontrolled cost.",
        );
      }
      if (body.currency) {
        assertSameCurrency(body.currency, commitment.currency, "Payment");
      }
      if (body.amount === 0 && (body.retainageReleasedAmount ?? 0) === 0) {
        throw badRequest("A payment of zero with no retainage release records nothing");
      }
      if (body.invoiceId) {
        const rows = await app.db
          .select({
            id: invoices.id,
            commitmentId: invoices.commitmentId,
            currency: invoices.currency,
            status: invoices.status,
          })
          .from(invoices)
          .where(and(eq(invoices.id, body.invoiceId), eq(invoices.companyId, req.companyId!)))
          .limit(1);
        const invoice = rows[0];
        if (!invoice || invoice.commitmentId !== commitmentId) {
          throw badRequest("invoiceId does not reference an invoice against this commitment");
        }
        assertSameCurrency(invoice.currency, commitment.currency, "Invoice");
      }
      if (body.lienWaiverId) {
        const rows = await app.db
          .select({ id: lienWaivers.id, commitmentId: lienWaivers.commitmentId })
          .from(lienWaivers)
          .where(
            and(eq(lienWaivers.id, body.lienWaiverId), eq(lienWaivers.companyId, req.companyId!)),
          )
          .limit(1);
        if (!rows[0] || rows[0].commitmentId !== commitmentId) {
          throw badRequest("lienWaiverId does not reference a lien waiver on this commitment");
        }
      }
      if (body.method === "joint_check" && (body.jointPayees ?? []).length === 0) {
        throw badRequest("A joint cheque needs at least one joint payee");
      }

      const overpay = await assertWithinCommitment(commitment, body.amount);
      const retainageRelease = body.retainageReleasedAmount ?? 0;
      await assertRetainageAvailable(commitment, retainageRelease);

      const compliance = await assessCommitment(app.db, commitment);
      const number = await nextRecordNumber(
        app.db,
        commitment.projectId,
        `commitment_payment:${commitmentId}`,
      );
      const id = newId("cpy");
      await app.db.insert(commitmentPayments).values({
        id,
        companyId: req.companyId!,
        projectId: commitment.projectId,
        commitmentId,
        invoiceId: body.invoiceId ?? null,
        vendorId: commitment.vendorId,
        number,
        reference: paymentReference(commitment.reference, number),
        method: body.method ?? "check",
        status: compliance.blocking.length > 0 ? "on_hold" : "scheduled",
        amount: round2(body.amount),
        retainageReleasedAmount: round2(retainageRelease),
        discountTaken: round2(body.discountTaken ?? 0),
        currency: commitment.currency,
        paymentDate: body.paymentDate ?? null,
        checkNumber: body.checkNumber ?? null,
        transactionReference: body.transactionReference ?? null,
        bankAccountRef: body.bankAccountRef ?? null,
        jointPayees: body.jointPayees ?? [],
        holdReason:
          compliance.blocking.length > 0
            ? compliance.blocking.map((f) => f.message).join(" ")
            : null,
        lienWaiverId: body.lienWaiverId ?? null,
        notes: body.notes ?? null,
        detail: {
          ...(body.detail ?? {}),
          complianceAtScheduling: {
            status: compliance.status,
            strictness: compliance.strictness,
            blocking: compliance.blocking.map((f) => f.code),
            warnings: compliance.warnings.map((f) => f.code),
          },
          ...(overpay.warnings.length > 0 ? { overpaymentWarnings: overpay.warnings } : {}),
        },
        createdBy: req.user!.id,
      });
      await ledger(app.db, req, "create", "commitment_payment", id, {
        commitmentId,
        number,
        amount: round2(body.amount),
        complianceStatus: compliance.status,
        blocked: compliance.blocking.length > 0,
      }, commitment.projectId);
      return reply.status(201).send({
        payment: await fetchPayment(id, req.companyId!),
        compliance,
        warnings: overpay.warnings,
      });
    },
  );

  app.get("/commitments/:commitmentId/payments", { preHandler: companyGate }, async (req, reply) => {
    const { commitmentId } = req.params as { commitmentId: string };
    const q = paymentListQuery.parse(req.query);
    const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "read");
    const clauses = [eq(commitmentPayments.commitmentId, commitmentId)];
    if (q.status) clauses.push(eq(commitmentPayments.status, q.status));
    if (q.method) clauses.push(eq(commitmentPayments.method, q.method));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(commitmentPayments).where(where);
    const items = await app.db
      .select()
      .from(commitmentPayments)
      .where(where)
      .orderBy(desc(commitmentPayments.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const all = await app.db
      .select({
        status: commitmentPayments.status,
        amount: commitmentPayments.amount,
        retainageReleasedAmount: commitmentPayments.retainageReleasedAmount,
      })
      .from(commitmentPayments)
      .where(eq(commitmentPayments.commitmentId, commitmentId));
    const sum = (predicate: (s: string) => boolean, pick: (r: (typeof all)[number]) => number) =>
      round2(all.filter((p) => predicate(p.status)).reduce((s, p) => s + pick(p), 0));
    return {
      ...paginate(items, Number(totalRow?.n ?? 0), q),
      currency: commitment.currency,
      register: {
        paid: sum(isPaidPayment, (p) => p.amount),
        scheduled: sum((s) => s === "scheduled", (p) => p.amount),
        onHold: sum((s) => s === "on_hold", (p) => p.amount),
        failed: sum((s) => s === "failed", (p) => p.amount),
        retainageReleasedPaid: sum(isPaidPayment, (p) => p.retainageReleasedAmount),
      },
    };
  });

  app.get("/commitment-payments/:paymentId", { preHandler: companyGate }, async (req, reply) => {
    const { paymentId } = req.params as { paymentId: string };
    const payment = await fetchPayment(paymentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, payment.projectId, "read");
    const commitment = await fetchCommitment(app.db, payment.commitmentId, req.companyId!);
    return { payment, compliance: await assessCommitment(app.db, commitment) };
  });

  /* ---------------------------------------------------------------- */
  /* Edit                                                              */
  /* ---------------------------------------------------------------- */

  app.patch("/commitment-payments/:paymentId", { preHandler: companyGate }, async (req, reply) => {
    const { paymentId } = req.params as { paymentId: string };
    const body = paymentPatchSchema.parse(req.body);
    const payment = await fetchPayment(paymentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, payment.projectId, "standard");
    if (payment.status !== "scheduled" && payment.status !== "on_hold") {
      throw conflict(
        `A payment in status "${payment.status}" cannot be edited. Money that has left the ` +
          "building is a fact, not a draft — void it and schedule a correction.",
      );
    }
    const commitment = await fetchCommitment(app.db, payment.commitmentId, req.companyId!);
    if (body.amount !== undefined) {
      await assertWithinCommitment(commitment, round2(body.amount), paymentId);
    }
    if (body.retainageReleasedAmount !== undefined) {
      await assertRetainageAvailable(commitment, round2(body.retainageReleasedAmount), paymentId);
    }
    await app.db
      .update(commitmentPayments)
      .set({
        ...(body.amount !== undefined ? { amount: round2(body.amount) } : {}),
        ...(body.retainageReleasedAmount !== undefined
          ? { retainageReleasedAmount: round2(body.retainageReleasedAmount) }
          : {}),
        ...(body.discountTaken !== undefined
          ? { discountTaken: round2(body.discountTaken) }
          : {}),
        ...(body.method !== undefined ? { method: body.method } : {}),
        ...(body.paymentDate !== undefined ? { paymentDate: body.paymentDate } : {}),
        ...(body.checkNumber !== undefined ? { checkNumber: body.checkNumber } : {}),
        ...(body.transactionReference !== undefined
          ? { transactionReference: body.transactionReference }
          : {}),
        ...(body.bankAccountRef !== undefined ? { bankAccountRef: body.bankAccountRef } : {}),
        ...(body.jointPayees !== undefined ? { jointPayees: body.jointPayees } : {}),
        ...(body.lienWaiverId !== undefined ? { lienWaiverId: body.lienWaiverId } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.detail !== undefined ? { detail: body.detail } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(commitmentPayments.id, paymentId));
    await ledger(app.db, req, "update", "commitment_payment", paymentId, {
      changed: Object.keys(body),
    }, payment.projectId);
    return fetchPayment(paymentId, req.companyId!);
  });

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  app.post(
    "/commitment-payments/:paymentId/approve",
    { preHandler: companyGate },
    async (req, reply) => {
      const { paymentId } = req.params as { paymentId: string };
      const payment = await fetchPayment(paymentId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, payment.projectId, "standard");
      if (payment.status !== "scheduled") {
        throw conflict(`A payment in status "${payment.status}" cannot be approved`);
      }
      assertSegregation(req.user!.id, { createdBy: payment.createdBy }, "payment");
      const commitment = await fetchCommitment(app.db, payment.commitmentId, req.companyId!);
      const compliance = await assessCommitment(app.db, commitment);
      assertCompliancePermits(commitment, compliance, "Approving this payment");
      const now = new Date().toISOString();
      await app.db
        .update(commitmentPayments)
        .set({ approvedBy: req.user!.id, approvedAt: now, updatedAt: now })
        .where(eq(commitmentPayments.id, paymentId));
      await ledger(app.db, req, "state_change", "commitment_payment", paymentId, {
        approvedBy: req.user!.id,
        complianceStatus: compliance.status,
      }, payment.projectId);
      return { payment: await fetchPayment(paymentId, req.companyId!), compliance };
    },
  );

  /**
   * ISSUE — the irreversible act.
   *
   * Everything the platform knows about the vendor's insurance, bonding and
   * lien waivers is consulted here, at the last moment it can still matter.
   * Blocking findings refuse with a 409 carrying the findings themselves, so
   * the caller is told exactly which certificate expired on which date rather
   * than "compliance failed".
   *
   * `issuedBy` must differ from `approvedBy`: releasing a payment and cutting
   * it are separate acts, and one person doing both is the control failure the
   * separate columns exist to prevent.
   */
  app.post(
    "/commitment-payments/:paymentId/issue",
    { preHandler: companyGate },
    async (req, reply) => {
      const { paymentId } = req.params as { paymentId: string };
      const body = issueSchema.parse(req.body ?? {});
      const payment = await fetchPayment(paymentId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, payment.projectId, "standard");
      if (payment.status !== "scheduled") {
        throw conflict(
          `A payment in status "${payment.status}" cannot be issued. Only a scheduled payment ` +
            "that has been approved can be issued.",
        );
      }
      if (!payment.approvedBy) {
        throw conflict(
          "This payment has not been approved. Approval releases the payment; issue cuts it — " +
            "and they are deliberately separate acts by separate people.",
        );
      }
      if (payment.approvedBy === req.user!.id) {
        throw new AppError(
          403,
          "Segregation of duties: the person who approved this payment may not also issue it.",
          { control: "no_self_issue", role: "approved_by" },
        );
      }
      const commitment = await fetchCommitment(app.db, payment.commitmentId, req.companyId!);
      const compliance = await assessCommitment(app.db, commitment);
      assertCompliancePermits(commitment, compliance, "Issuing this payment");

      await assertRetainageAvailable(commitment, payment.retainageReleasedAmount, paymentId);
      await allocateRetainageRelease(commitment, payment.retainageReleasedAmount);

      const now = new Date().toISOString();
      await app.db
        .update(commitmentPayments)
        .set({
          status: "issued",
          issuedBy: req.user!.id,
          issuedAt: now,
          paymentDate: body.paymentDate ?? payment.paymentDate ?? todayIso(),
          ...(body.checkNumber !== undefined ? { checkNumber: body.checkNumber } : {}),
          ...(body.transactionReference !== undefined
            ? { transactionReference: body.transactionReference }
            : {}),
          holdReason: null,
          detail: {
            ...(payment.detail ?? {}),
            complianceAtIssue: {
              status: compliance.status,
              strictness: compliance.strictness,
              warnings: compliance.warnings.map((f) => f.code),
              acknowledgedWarnings: body.acknowledgeWarnings === true,
              asOf: compliance.asOf,
            },
          },
          updatedAt: now,
        })
        .where(eq(commitmentPayments.id, paymentId));
      await recomputeCommitmentTotals(app.db, commitment.id);
      await ledger(app.db, req, "state_change", "commitment_payment", paymentId, {
        status: "issued",
        issuedBy: req.user!.id,
        approvedBy: payment.approvedBy,
        amount: payment.amount,
        retainageReleased: payment.retainageReleasedAmount,
        complianceStatus: compliance.status,
        complianceWarnings: compliance.warnings.map((f) => f.code),
      }, payment.projectId);
      return {
        payment: await fetchPayment(paymentId, req.companyId!),
        compliance,
        position: await commitmentPosition(app.db, commitment.id),
      };
    },
  );

  app.post(
    "/commitment-payments/:paymentId/clear",
    { preHandler: companyGate },
    async (req, reply) => {
      const { paymentId } = req.params as { paymentId: string };
      const body = z.object({ clearedDate: isoDateSchema.optional() }).parse(req.body ?? {});
      const payment = await fetchPayment(paymentId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, payment.projectId, "standard");
      if (payment.status !== "issued") {
        throw conflict(`A payment in status "${payment.status}" cannot be cleared`);
      }
      const now = new Date().toISOString();
      await app.db
        .update(commitmentPayments)
        .set({ status: "cleared", clearedDate: body.clearedDate ?? todayIso(), updatedAt: now })
        .where(eq(commitmentPayments.id, paymentId));
      await recomputeCommitmentTotals(app.db, payment.commitmentId);
      await ledger(app.db, req, "state_change", "commitment_payment", paymentId, {
        status: "cleared",
      }, payment.projectId);
      return fetchPayment(paymentId, req.companyId!);
    },
  );

  app.post(
    "/commitment-payments/:paymentId/hold",
    { preHandler: companyGate },
    async (req, reply) => {
      const { paymentId } = req.params as { paymentId: string };
      const body = reasonSchema.parse(req.body);
      const payment = await fetchPayment(paymentId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, payment.projectId, "standard");
      if (payment.status !== "scheduled") {
        throw conflict(`A payment in status "${payment.status}" cannot be put on hold`);
      }
      await app.db
        .update(commitmentPayments)
        .set({ status: "on_hold", holdReason: body.reason, updatedAt: new Date().toISOString() })
        .where(eq(commitmentPayments.id, paymentId));
      await ledger(app.db, req, "state_change", "commitment_payment", paymentId, {
        status: "on_hold",
        reason: body.reason,
      }, payment.projectId);
      return fetchPayment(paymentId, req.companyId!);
    },
  );

  app.post(
    "/commitment-payments/:paymentId/release",
    { preHandler: companyGate },
    async (req, reply) => {
      const { paymentId } = req.params as { paymentId: string };
      const payment = await fetchPayment(paymentId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, payment.projectId, "standard");
      if (payment.status !== "on_hold") {
        throw conflict(`A payment in status "${payment.status}" is not on hold`);
      }
      const commitment = await fetchCommitment(app.db, payment.commitmentId, req.companyId!);
      const compliance = await assessCommitment(app.db, commitment);
      assertCompliancePermits(commitment, compliance, "Releasing this payment from hold");
      await app.db
        .update(commitmentPayments)
        .set({ status: "scheduled", holdReason: null, updatedAt: new Date().toISOString() })
        .where(eq(commitmentPayments.id, paymentId));
      await ledger(app.db, req, "state_change", "commitment_payment", paymentId, {
        status: "scheduled",
        previousHoldReason: payment.holdReason,
      }, payment.projectId);
      return { payment: await fetchPayment(paymentId, req.companyId!), compliance };
    },
  );

  app.post(
    "/commitment-payments/:paymentId/fail",
    { preHandler: companyGate },
    async (req, reply) => {
      const { paymentId } = req.params as { paymentId: string };
      const body = reasonSchema.parse(req.body);
      const payment = await fetchPayment(paymentId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, payment.projectId, "standard");
      if (payment.status !== "issued") {
        throw conflict(`A payment in status "${payment.status}" cannot fail`);
      }
      await app.db
        .update(commitmentPayments)
        .set({ status: "failed", holdReason: body.reason, updatedAt: new Date().toISOString() })
        .where(eq(commitmentPayments.id, paymentId));
      await recomputeCommitmentTotals(app.db, payment.commitmentId);
      await ledger(app.db, req, "state_change", "commitment_payment", paymentId, {
        status: "failed",
        reason: body.reason,
      }, payment.projectId);
      return fetchPayment(paymentId, req.companyId!);
    },
  );

  /**
   * Voiding a payment that never left is bookkeeping. Voiding one that
   * CLEARED is refused: the bank has the record, and a platform whose product
   * is the trustworthiness of its record cannot let a cleared payment vanish.
   */
  app.post(
    "/commitment-payments/:paymentId/void",
    { preHandler: companyGate },
    async (req, reply) => {
      const { paymentId } = req.params as { paymentId: string };
      const body = reasonSchema.parse(req.body);
      const payment = await fetchPayment(paymentId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, payment.projectId, "standard");
      if (payment.status === "cleared") {
        throw conflict(
          "A cleared payment cannot be voided — the funds have settled. Record a reversal " +
            "payment instead so both movements stay on the record.",
        );
      }
      if (payment.status === "voided") throw conflict("This payment is already void");
      const wasIssued = payment.status === "issued";
      await app.db
        .update(commitmentPayments)
        .set({ status: "voided", holdReason: body.reason, updatedAt: new Date().toISOString() })
        .where(eq(commitmentPayments.id, paymentId));
      if (wasIssued && payment.retainageReleasedAmount !== 0) {
        await allocateRetainageRelease(
          await fetchCommitment(app.db, payment.commitmentId, req.companyId!),
          -payment.retainageReleasedAmount,
        );
      }
      await recomputeCommitmentTotals(app.db, payment.commitmentId);
      await ledger(app.db, req, "state_change", "commitment_payment", paymentId, {
        status: "voided",
        reason: body.reason,
        reversedIssuedPayment: wasIssued,
      }, payment.projectId);
      return fetchPayment(paymentId, req.companyId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Invoices — read side                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Subcontractor invoices raised against this commitment. The invoicing
   * module writes them; this route reads them alongside the commitment's own
   * figures so the sub's billing position is answerable in one call. Every
   * total here is a sum of stored invoice rows in the commitment's currency —
   * an invoice in another currency is listed and reported, never added.
   */
  app.get("/commitments/:commitmentId/invoices", { preHandler: companyGate }, async (req, reply) => {
    const { commitmentId } = req.params as { commitmentId: string };
    const q = pageQuerySchema.parse(req.query);
    const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "read");
    const where = and(
      eq(invoices.companyId, req.companyId!),
      eq(invoices.commitmentId, commitmentId),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(invoices).where(where);
    const items = await app.db
      .select()
      .from(invoices)
      .where(where)
      .orderBy(asc(invoices.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const all = await app.db
      .select({
        status: invoices.status,
        currency: invoices.currency,
        totalCompletedAndStored: invoices.totalCompletedAndStored,
        totalRetainage: invoices.totalRetainage,
        currentPaymentDue: invoices.currentPaymentDue,
        amountPaid: invoices.amountPaid,
      })
      .from(invoices)
      .where(where);
    const sameCurrency = all.filter(
      (i) => i.currency.toUpperCase() === commitment.currency.toUpperCase(),
    );
    const foreign = all.length - sameCurrency.length;
    const approved = sameCurrency.filter(
      (i) => i.status === "approved" || i.status === "approved_as_noted" || i.status === "paid",
    );
    return {
      ...paginate(items, Number(totalRow?.n ?? 0), q),
      currency: commitment.currency,
      billing: {
        invoiceCount: all.length,
        approvedCount: approved.length,
        completedAndStored: round2(
          approved.reduce((s, i) => s + i.totalCompletedAndStored, 0),
        ),
        retainageOnInvoices: round2(approved.reduce((s, i) => s + i.totalRetainage, 0)),
        currentPaymentDue: round2(approved.reduce((s, i) => s + i.currentPaymentDue, 0)),
        amountPaid: round2(approved.reduce((s, i) => s + i.amountPaid, 0)),
        foreignCurrencyInvoices: foreign,
        note:
          foreign > 0
            ? `${foreign} invoice(s) against this commitment are not in ${commitment.currency} ` +
              "and are excluded from these totals; figures in different currencies are never " +
              "summed."
            : null,
      },
    };
  });

  /** One invoice's lines, filtered to this commitment — the read side only. */
  app.get(
    "/commitments/:commitmentId/invoices/:invoiceId/lines",
    { preHandler: companyGate },
    async (req, reply) => {
      const { commitmentId, invoiceId } = req.params as {
        commitmentId: string;
        invoiceId: string;
      };
      const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, commitment.projectId, "read");
      const rows = await app.db
        .select({ id: invoices.id })
        .from(invoices)
        .where(
          and(
            eq(invoices.id, invoiceId),
            eq(invoices.companyId, req.companyId!),
            eq(invoices.commitmentId, commitmentId),
          ),
        )
        .limit(1);
      if (!rows[0]) throw notFound("Invoice not found against this commitment");
      const lines = await app.db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoiceId))
        .orderBy(asc(invoiceLineItems.sortOrder), asc(invoiceLineItems.lineNumber));
      return { invoiceId, currency: commitment.currency, lines };
    },
  );

  /** Committed / invoiced / paid, with every identity checked. */
  app.get("/commitments/:commitmentId/position", { preHandler: companyGate }, async (req, reply) => {
    const { commitmentId } = req.params as { commitmentId: string };
    const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "read");
    return commitmentPosition(app.db, commitmentId);
  });
};
