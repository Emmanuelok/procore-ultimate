import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  backcharges,
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
import type { Db } from "../../lib/db.js";
import { settleAfterTransition } from "../invoicing/register.js";
import { requestWaiverForPayment } from "../invoicing/waivers.js";
import { deriveSovLine } from "./arithmetic.js";
import { assessCommitment, type ComplianceResult } from "./compliance.js";
import { withIdempotency } from "./idempotency.js";
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

const concurrencySchema = z.object({ expectedUpdatedAt: z.string().min(4).optional() });

const issueSchema = concurrencySchema.extend({
  paymentDate: isoDateSchema.optional(),
  checkNumber: z.string().min(1).max(80).nullable().optional(),
  transactionReference: z.string().min(1).max(200).nullable().optional(),
  /**
   * Explicit acknowledgement of non-blocking compliance warnings. Warnings do
   * not stop a payment, but the acknowledgement is recorded on the payment and
   * in the ledger, so "we knew and paid anyway" is a fact rather than a guess.
   * The client must have SHOWN the warnings to set this — the issue response
   * carries them, and the web confirm dialog lists them before the checkbox.
   */
  acknowledgeWarnings: z.boolean().optional(),
});

const reasonSchema = z.object({ reason: z.string().min(1).max(4000) });

/** Fields whose change invalidates an approval already given (SoD). */
const APPROVAL_SENSITIVE = [
  "amount",
  "retainageReleasedAmount",
  "discountTaken",
  "method",
  "jointPayees",
  "bankAccountRef",
  "invoiceId",
] as const;

/* ------------------------------------------------------------------ */
/* Retainage allocation (shared with closeout's final release)         */
/* ------------------------------------------------------------------ */

/**
 * Spread a retainage release across the schedule of values in proportion to
 * the retainage each line is holding, so `retainageHeld` stays derivable
 * from the lines instead of becoming a header figure nobody can trace. A
 * rounding remainder lands on the largest holder rather than disappearing.
 * A NEGATIVE release reverses a previous one, spread over what each line has
 * already had released — the only basis that puts the money back where it
 * came from.
 */
export async function allocateRetainageRelease(
  db: Db,
  commitment: CommitmentRow,
  release: number,
): Promise<void> {
  if (release === 0) return;
  const lines = await db
    .select()
    .from(commitmentSovLines)
    .where(eq(commitmentSovLines.commitmentId, commitment.id));
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
    await db
      .update(commitmentSovLines)
      .set({
        retainageReleased,
        retainageHeld: derived.retainageHeld,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(commitmentSovLines.id, line.id));
  }
}

/** Open backcharges reserve money against the next payment (#538). */
export async function openBackchargeTotal(db: Db, commitmentId: string): Promise<number> {
  const rows = await db
    .select({ amount: backcharges.amount })
    .from(backcharges)
    .where(
      and(
        eq(backcharges.commitmentId, commitmentId),
        inArray(backcharges.status, ["issued", "disputed"]),
      ),
    );
  return round2(rows.reduce((s, r) => s + r.amount, 0));
}

/** Throw a 409 carrying the full compliance result when anything blocks. */
export function assertCompliancePermits(
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

/** Refuse a retainage release larger than the retainage actually held. */
export async function assertRetainageAvailable(
  db: Db,
  commitment: CommitmentRow,
  release: number,
  excludePaymentId?: string,
): Promise<void> {
  if (release === 0) return;
  const rows = await db
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
 * THE ISSUE CORE — shared by the single-payment route and payment runs
 * (#586–594). Runs in one transaction with the payment row locked: the
 * retainage allocation, the status flip, the register settlement (invoice
 * paid position, budget direct costs, commitment totals) land together or
 * not at all, and a concurrent second issue finds the row already moved.
 */
export async function performIssue(
  db: Db,
  payment: typeof commitmentPayments.$inferSelect,
  commitment: CommitmentRow,
  compliance: ComplianceResult,
  input: {
    actorId: string;
    paymentDate?: string | undefined;
    checkNumber?: string | null | undefined;
    transactionReference?: string | null | undefined;
    acknowledgeWarnings: boolean;
    paymentRunId?: string | null;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    const locked = await tx
      .select({ status: commitmentPayments.status, approvedBy: commitmentPayments.approvedBy })
      .from(commitmentPayments)
      .where(eq(commitmentPayments.id, payment.id))
      .for("update");
    if (locked[0]?.status !== "scheduled" || !locked[0].approvedBy) {
      throw conflict("This payment moved before it could be issued. Nothing was issued twice.");
    }
    await assertRetainageAvailable(tx, commitment, payment.retainageReleasedAmount, payment.id);
    await allocateRetainageRelease(tx, commitment, payment.retainageReleasedAmount);
    await tx
      .update(commitmentPayments)
      .set({
        status: "issued",
        issuedBy: input.actorId,
        issuedAt: now,
        paymentDate: input.paymentDate ?? payment.paymentDate ?? todayIso(),
        ...(input.checkNumber !== undefined ? { checkNumber: input.checkNumber } : {}),
        ...(input.transactionReference !== undefined
          ? { transactionReference: input.transactionReference }
          : {}),
        holdReason: null,
        detail: {
          ...(payment.detail ?? {}),
          ...(payment.retainageReleasedAmount !== 0 ? { retainageAppliedAt: now } : {}),
          ...(input.paymentRunId ? { paymentRunId: input.paymentRunId } : {}),
          complianceAtIssue: {
            status: compliance.status,
            strictness: compliance.strictness,
            warnings: compliance.warnings.map((f) => f.code),
            acknowledgedWarnings: input.acknowledgeWarnings,
            asOf: compliance.asOf,
          },
        },
        updatedAt: now,
      })
      .where(eq(commitmentPayments.id, payment.id));
    await settleAfterTransition(tx, payment.id);
  });
}

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
 * An approval covers ONE payment: the amount, the payee, the method. Editing
 * any of those afterwards clears the approval and ledgers why, so an issuer
 * who sees `approvedBy` set is seeing an approval of the figures in front of
 * them, never of an earlier draft.
 *
 * The compliance gate fires hardest at ISSUE, because that is the moment the
 * money is irrecoverable. Every money-moving transition runs in one
 * transaction with the payment row locked, and every one ends in the
 * invoicing module's register service, which re-derives the invoice's paid
 * position and the budget's direct costs from the register rows — so the two
 * writers of `commitment_payments` can no longer disagree about what a
 * payment did.
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

  function assertFresh(payment: { updatedAt: string }, expected: string | undefined): void {
    if (expected !== undefined && expected !== payment.updatedAt) {
      throw conflict(
        "This payment has changed since you read it. Reload it before acting — the figures " +
          "you approved may no longer be the figures on the record.",
      );
    }
  }

  /**
   * Refuse a payment that would take total scheduled + paid past the revised
   * commitment sum, LESS any backcharge still open against the sub: an issued
   * backcharge is money we are recovering, and it is reserved against the next
   * payment until it settles into the sum as a negative change order.
   */
  async function assertWithinCommitment(
    commitment: CommitmentRow,
    amount: number,
    excludePaymentId?: string,
  ): Promise<{ warnings: string[]; reservedForBackcharges: number }> {
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
    const reserved = await openBackchargeTotal(app.db, commitment.id);
    const committedOut = round2(live.reduce((s, p) => s + p.amount, 0) + amount);
    const ceiling = round2(commitment.revisedCommitmentSum - reserved);
    if (committedOut - ceiling > 0.005) {
      throw badRequest(
        `Payments against this commitment would total ${committedOut} ${commitment.currency}, ` +
          `above its revised commitment sum of ${commitment.revisedCommitmentSum} ` +
          `${commitment.currency}` +
          (reserved > 0
            ? ` less ${reserved} ${commitment.currency} reserved for open backcharges`
            : "") +
          ". Raise a change order before paying more than the subcontract is worth.",
        { reservedForBackcharges: reserved, ceiling, committedOut },
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
    if (reserved > 0) {
      warnings.push(
        `${reserved} ${commitment.currency} of backcharges are open against this vendor and are ` +
          "reserved against payment until they settle.",
      );
    }
    return { warnings, reservedForBackcharges: reserved };
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
      await assertRetainageAvailable(app.db, commitment, retainageRelease);

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
    const compliance = await assessCommitment(app.db, commitment);
    return {
      ...paginate(items, Number(totalRow?.n ?? 0), q),
      currency: commitment.currency,
      register: {
        paid: sum(isPaidPayment, (p) => p.amount),
        scheduled: sum((s) => s === "scheduled", (p) => p.amount),
        onHold: sum((s) => s === "on_hold", (p) => p.amount),
        failed: sum((s) => s === "failed", (p) => p.amount),
        retainageReleasedPaid: sum(isPaidPayment, (p) => p.retainageReleasedAmount),
        reservedForBackcharges: await openBackchargeTotal(app.db, commitmentId),
      },
      /** the position an issuer must acknowledge before issuing anything */
      compliance,
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
      await assertRetainageAvailable(app.db, commitment, round2(body.retainageReleasedAmount), paymentId);
    }
    /*
     * An approval covers the figures that were approved. Change any of them and
     * the approval is gone — recorded, not silently — so the issuer never acts
     * on somebody else's approval of a different payment.
     */
    const sensitiveChanged = APPROVAL_SENSITIVE.filter((k) => {
      const next = (body as Record<string, unknown>)[k];
      if (next === undefined) return false;
      const current = (payment as unknown as Record<string, unknown>)[k];
      return JSON.stringify(next) !== JSON.stringify(current);
    });
    const invalidates = payment.approvedBy !== null && sensitiveChanged.length > 0;
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
        ...(invalidates ? { approvedBy: null, approvedAt: null } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(commitmentPayments.id, paymentId));
    await ledger(app.db, req, "update", "commitment_payment", paymentId, {
      changed: Object.keys(body),
      ...(invalidates
        ? {
            approvalInvalidated: true,
            previousApprovedBy: payment.approvedBy,
            fieldsThatInvalidated: sensitiveChanged,
          }
        : {}),
    }, payment.projectId);
    return {
      ...(await fetchPayment(paymentId, req.companyId!)),
      approvalInvalidated: invalidates,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  app.post(
    "/commitment-payments/:paymentId/approve",
    { preHandler: companyGate },
    async (req, reply) => {
      const { paymentId } = req.params as { paymentId: string };
      const body = concurrencySchema.parse(req.body ?? {});
      const payment = await fetchPayment(paymentId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, payment.projectId, "standard");
      return withIdempotency(app.db, req, reply, "commitment-payment.approve", async () => {
        if (payment.status !== "scheduled") {
          throw conflict(`A payment in status "${payment.status}" cannot be approved`);
        }
        assertFresh(payment, body.expectedUpdatedAt);
        assertSegregation(req.user!.id, { createdBy: payment.createdBy }, "payment");
        const commitment = await fetchCommitment(app.db, payment.commitmentId, req.companyId!);
        const compliance = await assessCommitment(app.db, commitment);
        assertCompliancePermits(commitment, compliance, "Approving this payment");
        const now = new Date().toISOString();
        const updated = await app.db
          .update(commitmentPayments)
          .set({ approvedBy: req.user!.id, approvedAt: now, updatedAt: now })
          .where(and(eq(commitmentPayments.id, paymentId), eq(commitmentPayments.status, "scheduled")))
          .returning({ id: commitmentPayments.id });
        if (updated.length === 0) throw conflict("This payment moved before it could be approved.");
        await ledger(app.db, req, "state_change", "commitment_payment", paymentId, {
          approvedBy: req.user!.id,
          approvedAmount: payment.amount,
          complianceStatus: compliance.status,
        }, payment.projectId);
        return { payment: await fetchPayment(paymentId, req.companyId!), compliance };
      });
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
   * separate columns exist to prevent. The row is locked for the duration of
   * the transaction, and the retainage allocation is stamped on the payment so
   * a later fail or void can put it back exactly.
   */
  app.post(
    "/commitment-payments/:paymentId/issue",
    { preHandler: companyGate },
    async (req, reply) => {
      const { paymentId } = req.params as { paymentId: string };
      const body = issueSchema.parse(req.body ?? {});
      const payment = await fetchPayment(paymentId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, payment.projectId, "standard");
      return withIdempotency(app.db, req, reply, "commitment-payment.issue", async () => {
        if (payment.status !== "scheduled") {
          throw conflict(
            `A payment in status "${payment.status}" cannot be issued. Only a scheduled payment ` +
              "that has been approved can be issued.",
          );
        }
        assertFresh(payment, body.expectedUpdatedAt);
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
        if (compliance.warnings.length > 0 && body.acknowledgeWarnings !== true) {
          throw new AppError(
            409,
            `Issuing this payment needs the compliance warnings acknowledged first: ${compliance.warnings
              .map((f) => f.message)
              .join(" ")}`,
            {
              control: "acknowledge_warnings",
              warnings: compliance.warnings,
              remedy: "Read the warnings and resend with acknowledgeWarnings: true.",
            },
          );
        }

        await performIssue(app.db, payment, commitment, compliance, {
          actorId: req.user!.id,
          paymentDate: body.paymentDate,
          checkNumber: body.checkNumber,
          transactionReference: body.transactionReference,
          acknowledgeWarnings: body.acknowledgeWarnings === true,
        });
        /* lien-waiver automation (#576–578): a paid invoice that still needs its waiver asks for it now */
        const waiver = await requestWaiverForPayment(app.db, paymentId, req.user!.id);
        await ledger(app.db, req, "state_change", "commitment_payment", paymentId, {
          status: "issued",
          issuedBy: req.user!.id,
          approvedBy: payment.approvedBy,
          amount: payment.amount,
          retainageReleased: payment.retainageReleasedAmount,
          complianceStatus: compliance.status,
          complianceWarnings: compliance.warnings.map((f) => f.code),
          acknowledgedWarnings: body.acknowledgeWarnings === true,
          waiverRequested: waiver?.id ?? null,
        }, payment.projectId);
        return {
          payment: await fetchPayment(paymentId, req.companyId!),
          compliance,
          position: await commitmentPosition(app.db, commitment.id),
          waiverRequested: waiver,
        };
      });
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
      await app.db.transaction(async (tx) => {
        await tx
          .update(commitmentPayments)
          .set({ status: "cleared", clearedDate: body.clearedDate ?? todayIso(), updatedAt: now })
          .where(and(eq(commitmentPayments.id, paymentId), eq(commitmentPayments.status, "issued")));
        await settleAfterTransition(tx, paymentId);
      });
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
      /*
       * A payment held for a missing lien waiver stays held until the waiver
       * is on file — releasing the hold is not a way around the gate.
       */
      const detail = (payment.detail ?? {}) as Record<string, unknown>;
      if (payment.invoiceId && typeof detail["waiverOverriddenBy"] === "string") {
        const rows = await app.db
          .select({ status: lienWaivers.status })
          .from(lienWaivers)
          .where(eq(lienWaivers.invoiceId, payment.invoiceId));
        const onFile = rows.some((w) => ["received", "verified", "not_required"].includes(w.status));
        if (!onFile) {
          throw new AppError(
            409,
            "This payment was held because the invoice's lien waiver was not on file, and it still " +
              "is not. Record the waiver as received or verified, then release the hold.",
            { control: "lien_waiver_required", invoiceId: payment.invoiceId },
          );
        }
      }
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

  /**
   * A failed payment (a bounced cheque, a rejected transfer) never left, so
   * whatever it released comes back: the retainage allocation is reversed
   * line by line, the invoice's paid position is re-derived without it, and
   * the direct cost it posted is taken out of the budget.
   */
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
      const reversed = await reverseAndSettle(paymentId, payment, "failed", body.reason);
      await ledger(app.db, req, "state_change", "commitment_payment", paymentId, {
        status: "failed",
        reason: body.reason,
        retainageReversed: reversed,
      }, payment.projectId);
      return fetchPayment(paymentId, req.companyId!);
    },
  );

  /**
   * Voiding a payment that never left is bookkeeping. Voiding one that
   * CLEARED is refused: the bank has the record, and a platform whose product
   * is the trustworthiness of its record cannot let a cleared payment vanish.
   * Voiding a failed or issued payment reverses whatever it applied.
   */
  app.post(
    "/commitment-payments/:paymentId/void",
    { preHandler: companyGate },
    async (req, reply) => {
      const { paymentId } = req.params as { paymentId: string };
      const body = reasonSchema.merge(concurrencySchema).parse(req.body);
      const payment = await fetchPayment(paymentId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, payment.projectId, "standard");
      if (payment.status === "cleared") {
        throw conflict(
          "A cleared payment cannot be voided — the funds have settled. Record a reversal " +
            "payment instead so both movements stay on the record.",
        );
      }
      if (payment.status === "voided") throw conflict("This payment is already void");
      assertFresh(payment, body.expectedUpdatedAt);
      const reversed = await reverseAndSettle(paymentId, payment, "voided", body.reason);
      await ledger(app.db, req, "state_change", "commitment_payment", paymentId, {
        status: "voided",
        reason: body.reason,
        reversedIssuedPayment: payment.status === "issued",
        retainageReversed: reversed,
      }, payment.projectId);
      return fetchPayment(paymentId, req.companyId!);
    },
  );

  /**
   * Fail and void share one reversal: whether the retainage allocation was
   * applied is a fact stamped on the payment (`detail.retainageAppliedAt`),
   * not an inference from its current status — a failed payment that is
   * later voided must not reverse twice, and a failed payment must reverse
   * even though its status is no longer "issued".
   */
  async function reverseAndSettle(
    paymentId: string,
    payment: typeof commitmentPayments.$inferSelect,
    to: "failed" | "voided",
    reason: string,
  ): Promise<number> {
    const detail = (payment.detail ?? {}) as Record<string, unknown>;
    const applied = typeof detail["retainageAppliedAt"] === "string";
    const now = new Date().toISOString();
    let reversed = 0;
    await app.db.transaction(async (tx) => {
      const locked = await tx
        .select({ status: commitmentPayments.status, detail: commitmentPayments.detail })
        .from(commitmentPayments)
        .where(eq(commitmentPayments.id, paymentId))
        .for("update");
      const current = locked[0];
      if (!current || current.status === "voided" || current.status === "cleared") {
        throw conflict(`This payment is now ${current?.status ?? "gone"}; nothing was reversed twice.`);
      }
      const liveDetail = (current.detail ?? {}) as Record<string, unknown>;
      const stillApplied = applied && typeof liveDetail["retainageAppliedAt"] === "string";
      if (stillApplied && payment.retainageReleasedAmount !== 0) {
        const commitment = await fetchCommitment(tx, payment.commitmentId, payment.companyId);
        await allocateRetainageRelease(tx, commitment, -payment.retainageReleasedAmount);
        reversed = payment.retainageReleasedAmount;
      }
      const { retainageAppliedAt: _a, ...rest } = liveDetail;
      await tx
        .update(commitmentPayments)
        .set({
          status: to,
          holdReason: reason,
          detail: { ...rest, ...(reversed ? { retainageReversedAt: now, retainageReversed: reversed } : {}) },
          updatedAt: now,
        })
        .where(eq(commitmentPayments.id, paymentId));
      await settleAfterTransition(tx, paymentId);
    });
    return reversed;
  }

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

  /** A remittance advice for one payment — what the vendor receives with the money (#592). */
  app.get(
    "/commitment-payments/:paymentId/remittance",
    { preHandler: companyGate },
    async (req, reply) => {
      const { paymentId } = req.params as { paymentId: string };
      const payment = await fetchPayment(paymentId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, payment.projectId, "read");
      const commitment = await fetchCommitment(app.db, payment.commitmentId, req.companyId!);
      const invoice = payment.invoiceId
        ? (await app.db.select().from(invoices).where(eq(invoices.id, payment.invoiceId)).limit(1))[0] ?? null
        : null;
      const advice = {
        paymentId: payment.id,
        reference: payment.reference,
        status: payment.status,
        commitment: { id: commitment.id, reference: commitment.reference, title: commitment.title },
        vendorId: payment.vendorId,
        invoice: invoice
          ? {
              id: invoice.id,
              reference: invoice.reference,
              invoiceNumber: invoice.invoiceNumber,
              billingDate: invoice.billingDate,
              currentPaymentDue: invoice.currentPaymentDue,
              amountPaid: invoice.amountPaid,
            }
          : null,
        currency: payment.currency,
        gross: round2(payment.amount + payment.discountTaken),
        discountTaken: payment.discountTaken,
        retainageReleased: payment.retainageReleasedAmount,
        net: payment.amount,
        method: payment.method,
        paymentDate: payment.paymentDate,
        checkNumber: payment.checkNumber,
        transactionReference: payment.transactionReference,
        jointPayees: payment.jointPayees,
        issuedAt: payment.issuedAt,
        note:
          payment.status === "issued" || payment.status === "cleared"
            ? null
            : "This payment has not been issued; the advice is a preview, not a remittance.",
      };
      const html = renderRemittanceHtml(advice);
      return { advice, html };
    },
  );
};

/** Plain HTML remittance advice; printed or emailed by the client. */
export function renderRemittanceHtml(advice: Record<string, unknown>): string {
  const esc = (v: unknown): string =>
    String(v ?? "—").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
  const commitment = advice["commitment"] as { reference: string; title: string };
  const invoice = advice["invoice"] as { reference: string; invoiceNumber: string | null } | null;
  const row = (label: string, value: unknown) =>
    `<tr><th style="text-align:left;padding:4px 12px 4px 0">${esc(label)}</th><td style="padding:4px 0">${esc(value)}</td></tr>`;
  return (
    `<div style="font-family:system-ui,sans-serif;max-width:640px">` +
    `<h2 style="margin:0 0 4px">Remittance advice — ${esc(advice["reference"])}</h2>` +
    `<p style="margin:0 0 12px;color:#555">${esc(commitment.reference)} · ${esc(commitment.title)}</p>` +
    `<table style="border-collapse:collapse">` +
    row("Invoice", invoice ? `${invoice.reference}${invoice.invoiceNumber ? ` (${invoice.invoiceNumber})` : ""}` : "Advance / standalone") +
    row("Payment date", advice["paymentDate"]) +
    row("Method", advice["method"]) +
    row("Reference", advice["transactionReference"] ?? advice["checkNumber"]) +
    row("Gross", `${advice["gross"]} ${advice["currency"]}`) +
    row("Discount taken", `${advice["discountTaken"]} ${advice["currency"]}`) +
    row("Retainage released", `${advice["retainageReleased"]} ${advice["currency"]}`) +
    row("Net paid", `${advice["net"]} ${advice["currency"]}`) +
    `</table>` +
    (advice["note"] ? `<p style="color:#a00">${esc(advice["note"])}</p>` : "") +
    `</div>`
  );
}
