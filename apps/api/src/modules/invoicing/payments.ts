import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  commitmentPayments,
  commitments,
  invoices,
  paymentApplications,
  primeContracts,
} from "@constructos/db";
import { PAYMENT_METHODS, PAYMENT_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import { assessCommitment } from "../commitments/compliance.js";
import { rememberIdempotent, replayIdempotent } from "../commitments/idempotency.js";
import { assertCompliancePermits } from "../commitments/payments.js";
import { fetchInvoice, type InvoiceRow } from "./invoices.js";
import {
  allocateToBudgetLines,
  payableOf as payableOfInvoice,
  postDirectCosts,
  settleAfterTransition,
  type DirectCostAllocation,
} from "./register.js";
import { requestWaiverForPayment, waiverGateFor } from "./waivers.js";
import {
  CENT,
  assertSegregation,
  byCurrency,
  detailSchema,
  formatMoney,
  isApprovedInvoice,
  isoDateSchema,
  ledger,
  nonNegativeMoneySchema,
  nowIso,
  pad3,
  paymentCounterKey,
  requireInvoicingLevel,
  round2,
  todayIso,
} from "./shared.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const paymentCreateSchema = z.object({
  amount: nonNegativeMoneySchema,
  method: z.enum(PAYMENT_METHODS).optional(),
  /** "scheduled" queues it; "issued" records money that has actually left */
  status: z.enum(["scheduled", "issued"]).optional(),
  paymentDate: isoDateSchema.optional(),
  checkNumber: z.string().max(100).nullable().optional(),
  transactionReference: z.string().max(200).nullable().optional(),
  bankAccountRef: z.string().max(200).nullable().optional(),
  jointPayees: z
    .array(z.object({ name: z.string().min(1).max(300), vendorId: z.string().max(64).nullable().optional() }))
    .max(10)
    .optional(),
  retainageReleasedAmount: nonNegativeMoneySchema.optional(),
  discountTaken: nonNegativeMoneySchema.optional(),
  lienWaiverId: z.string().min(1).max(64).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  /** pay anyway, on the record, with the missing waiver named */
  overrideMissingWaiver: z.boolean().optional(),
  overrideReason: z.string().max(4000).optional(),
  detail: detailSchema.optional(),
});

const paymentListQuery = pageQuerySchema.extend({
  status: z.enum(PAYMENT_STATUSES).optional(),
  vendorId: z.string().optional(),
  commitmentId: z.string().optional(),
});

/* ------------------------------------------------------------------ */
/* Direct-cost posting — owned by register.ts, re-exported for callers  */
/* ------------------------------------------------------------------ */

export { allocateToBudgetLines, postDirectCosts, type DirectCostAllocation } from "./register.js";

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/**
 * PAYMENTS AGAINST AN INVOICE — the money actually moving.
 *
 * Two refusals stand between an approved invoice and a cheque, and both are
 * here rather than in a checklist somebody can skip:
 *
 *   1. A payment larger than what the invoice is owed, named to the cent.
 *   2. A REQUIRED LIEN WAIVER THAT IS NOT ON FILE. Paying unwaived work is
 *      how a project that has paid every sub in full still gets liened, so
 *      the default is refusal. It can be overridden — deliberately, with a
 *      reason — and the payment is then recorded ON HOLD, not as money out,
 *      so the exposure stays visible until the waiver arrives.
 *
 * A subcontractor invoice writes a `commitment_payments` row: a real payment
 * register the bank statement reconciles to. An owner application records
 * receipt against the invoice and its certified payment application.
 */
export const paymentRoutes: FastifyPluginAsync = async (app) => {
  const companyGate = [app.authenticate, app.requireCompany];
  const readGate = [...companyGate, app.requireTool("invoicing", "read")];

  /** What is still payable on this invoice, honouring an "as noted" cut. */
  const payableOf = (inv: InvoiceRow): number => payableOfInvoice(inv);

  /*
   * Recording a payment is the irreversible act, so it honours
   * `Idempotency-Key` (plan §6.2): a client that times out and retries gets
   * the FIRST response back rather than cutting a second cheque. Without the
   * header the invoice row lock and the payable re-check inside the
   * transaction still refuse the second payment; the key makes the refusal a
   * replay instead of a 400.
   */
  app.post("/invoices/:invoiceId/payments", { preHandler: companyGate }, async (req, reply) => {
    const replayed = await replayIdempotent<unknown>(app.db, req, reply);
    if (replayed) return replayed.body;
    const { invoiceId } = req.params as { invoiceId: string };
    const body = paymentCreateSchema.parse(req.body);
    const inv = await fetchInvoice(app.db, invoiceId, req.companyId!);
    await requireInvoicingLevel(app, req, reply, inv.projectId, "admin");

    if (!isApprovedInvoice(inv.status)) {
      throw conflict(
        `Invoice ${inv.reference} is ${inv.status}. Money is only ever paid against an approved ` +
          "invoice — approve it first, by someone who neither raised nor submitted it.",
      );
    }
    // Neither the author, the submitter NOR THE APPROVER of the invoice gets to
    // pay it: certifying and disbursing are the two acts the separate
    // approvedBy / issuedBy columns exist to keep apart.
    assertSegregation(
      req.user!.id,
      { createdBy: inv.createdBy, submittedBy: inv.submittedBy },
      "invoice",
    );
    if (inv.approvedBy && inv.approvedBy === req.user!.id) {
      throw new AppError(
        403,
        "Segregation of duties: the person who approved this invoice may not also pay it.",
        { control: "no_self_issue", role: "approved_by" },
      );
    }

    const payable = payableOf(inv);
    const amount = round2(body.amount);
    if (amount <= CENT) throw badRequest("A payment must move money.");
    if (amount - payable > CENT) {
      throw badRequest(
        `Payment of ${formatMoney(amount)} ${inv.currency} exceeds the ` +
          `${formatMoney(payable)} ${inv.currency} still payable on ${inv.reference} — over by ` +
          `${formatMoney(round2(amount - payable))}.`,
        {
          currentPaymentDue: inv.currentPaymentDue,
          amountPaid: inv.amountPaid,
          payable,
          requested: amount,
          overage: round2(amount - payable),
          currency: inv.currency,
        },
      );
    }

    const gate = await waiverGateFor(app.db, inv);
    const waiverBlocked = !gate.satisfied;
    if (waiverBlocked && body.overrideMissingWaiver !== true) {
      throw new AppError(409, gate.reasons.join(" "), {
        control: "lien_waiver_required",
        invoiceId: inv.id,
        reference: inv.reference,
        amount,
        currency: inv.currency,
        waivers: gate.waivers,
        remedy:
          "Record the signed waiver against this invoice, or pay with overrideMissingWaiver " +
          "and an overrideReason — the payment is then held and the exposure stays visible.",
      });
    }
    if (waiverBlocked && !(body.overrideReason ?? "").trim()) {
      throw badRequest(
        "Overriding a missing lien waiver needs an overrideReason. An unexplained override is " +
          "indistinguishable from an oversight.",
      );
    }

    /* ---- owner billing: receipt against the application, no register row --- */
    if (inv.kind === "owner_billing") {
      const now = nowIso();
      const amountPaid = round2(inv.amountPaid + amount);
      await app.db
        .update(invoices)
        .set({
          amountPaid,
          paidDate: body.paymentDate ?? todayIso(),
          status: payable - amount <= CENT ? "paid" : inv.status,
          updatedAt: now,
        })
        .where(eq(invoices.id, invoiceId));
      const apps = await app.db
        .select()
        .from(paymentApplications)
        .where(eq(paymentApplications.invoiceId, invoiceId))
        .limit(1);
      if (apps[0]) {
        await app.db
          .update(paymentApplications)
          .set({
            paidAmount: round2(apps[0].paidAmount + amount),
            paidAt: now,
            status: payable - amount <= CENT ? "paid" : apps[0].status,
            paymentReference: body.transactionReference ?? body.checkNumber ?? apps[0].paymentReference,
            updatedAt: now,
          })
          .where(eq(paymentApplications.id, apps[0].id));
      }
      if (inv.primeContractId) {
        const rows = await app.db
          .select({ totalPaid: primeContracts.totalPaid })
          .from(primeContracts)
          .where(eq(primeContracts.id, inv.primeContractId))
          .limit(1);
        if (rows[0]) {
          await app.db
            .update(primeContracts)
            .set({ totalPaid: round2(rows[0].totalPaid + amount), updatedAt: now })
            .where(eq(primeContracts.id, inv.primeContractId));
        }
      }
      await ledger(app.db, req, "state_change", "invoice", invoiceId, {
        action: "owner_payment_received",
        amount,
        currency: inv.currency,
        amountPaid,
        paymentReference: body.transactionReference ?? body.checkNumber ?? null,
      }, inv.projectId, true);
      return reply.status(201).send({
        kind: "owner_receipt",
        invoice: await fetchInvoice(app.db, invoiceId, req.companyId!),
        amount,
        currency: inv.currency,
      });
    }

    /* ---- subcontractor invoice: a real entry in the payment register ---- */
    if (!inv.commitmentId) {
      throw badRequest(`Invoice ${inv.reference} has no commitment behind it`);
    }
    const commitmentRows = await app.db
      .select()
      .from(commitments)
      .where(eq(commitments.id, inv.commitmentId))
      .limit(1);
    const commitment = commitmentRows[0];
    if (!commitment) throw badRequest("The commitment behind this invoice is gone");
    if (commitment.paymentHold === 1) {
      throw new AppError(
        409,
        `${commitment.reference} is on payment hold: ` +
          `${commitment.complianceHoldReason ?? "no reason recorded"}. Release the hold before ` +
          "paying — somebody typed that reason on purpose.",
        { control: "payment_hold", commitmentId: commitment.id },
      );
    }
    if (body.method === "joint_check" && (body.jointPayees ?? []).length === 0) {
      throw badRequest("A joint cheque needs at least one joint payee");
    }

    /*
     * THE COMPLIANCE GATE (spec #575/#590) — the same one the commitments
     * register runs. An expired certificate or bond with strictness `block`
     * refuses to issue; the payment is recorded ON HOLD with the findings on
     * it, so the exposure is a record rather than a cheque. A warning-level
     * finding is stamped on the payment and returned.
     */
    const compliance = await assessCommitment(app.db, commitment);
    const complianceBlocked = compliance.blocking.length > 0;
    if (complianceBlocked && (body.status ?? "issued") === "issued" && body.overrideMissingWaiver !== true) {
      assertCompliancePermits(commitment, compliance, `Paying ${inv.reference}`);
    }

    const held = waiverBlocked || complianceBlocked;
    const status = held ? "on_hold" : (body.status ?? "issued");
    const number = await nextRecordNumber(
      app.db,
      inv.projectId,
      paymentCounterKey(inv.commitmentId),
    );
    const id = newId("cpy");
    const now = nowIso();
    const holdReasons: string[] = [];
    if (waiverBlocked) holdReasons.push(`Lien waiver not on file. Override: ${body.overrideReason}`);
    if (complianceBlocked) holdReasons.push(compliance.blocking.map((f) => f.message).join(" "));

    /*
     * One transaction with the INVOICE ROW LOCKED: the payable check, the
     * register row and the settlement land together, and a second concurrent
     * post for the same payable waits, re-reads, and is refused.
     */
    let settled: Awaited<ReturnType<typeof settleAfterTransition>> | null = null;
    await app.db.transaction(async (tx) => {
      const locked = await tx
        .select({ amountPaid: invoices.amountPaid, status: invoices.status, detail: invoices.detail, currentPaymentDue: invoices.currentPaymentDue })
        .from(invoices)
        .where(eq(invoices.id, invoiceId))
        .for("update");
      const live = locked[0];
      if (!live || !isApprovedInvoice(live.status)) {
        throw conflict(`Invoice ${inv.reference} is no longer payable (${live?.status ?? "gone"}).`);
      }
      const livePayable = payableOfInvoice({ detail: live.detail, currentPaymentDue: live.currentPaymentDue, amountPaid: live.amountPaid });
      if (status !== "on_hold" && amount - livePayable > CENT) {
        throw badRequest(
          `Payment of ${formatMoney(amount)} ${inv.currency} exceeds the ${formatMoney(livePayable)} ` +
            `${inv.currency} still payable on ${inv.reference} — another payment landed first.`,
          { payable: livePayable, requested: amount, currency: inv.currency },
        );
      }
      await tx.insert(commitmentPayments).values({
        id,
        companyId: req.companyId!,
        projectId: inv.projectId,
        commitmentId: inv.commitmentId!,
        invoiceId,
        vendorId: inv.vendorId ?? commitment.vendorId,
        number,
        reference: `${commitment.reference}-PAY-${pad3(number)}`,
        method: body.method ?? "check",
        status,
        amount,
        retainageReleasedAmount: round2(body.retainageReleasedAmount ?? 0),
        discountTaken: round2(body.discountTaken ?? 0),
        currency: inv.currency,
        paymentDate: body.paymentDate ?? todayIso(),
        checkNumber: body.checkNumber ?? null,
        transactionReference: body.transactionReference ?? null,
        bankAccountRef: body.bankAccountRef ?? null,
        jointPayees: body.jointPayees ?? [],
        holdReason: held ? holdReasons.join(" ") : null,
        lienWaiverId: body.lienWaiverId ?? null,
        notes: body.notes ?? null,
        detail: {
          ...(body.detail ?? {}),
          ...(waiverBlocked
            ? {
                waiverOverriddenBy: req.user!.id,
                waiverOverriddenAt: now,
                waiverOverrideReason: body.overrideReason,
                waiversAtOverride: gate.waivers,
              }
            : {}),
          complianceAtIssue: {
            status: compliance.status,
            strictness: compliance.strictness,
            blocking: compliance.blocking.map((f) => f.code),
            warnings: compliance.warnings.map((f) => f.code),
            asOf: compliance.asOf,
          },
        },
        createdBy: req.user!.id,
        ...(status === "issued" ? { issuedBy: req.user!.id, issuedAt: now } : {}),
        ...(status === "issued" ? { approvedBy: inv.approvedBy, approvedAt: inv.approvedAt } : {}),
        updatedAt: now,
      });
      /* the register service re-derives amountPaid, status, commitment totals and direct costs */
      settled = await settleAfterTransition(tx, id);
    });
    const waiverRequested = status === "issued" ? await requestWaiverForPayment(app.db, id, req.user!.id) : null;
    const budgetPosting = status === "issued" ? await postDirectCosts(app.db, id) : null;

    await ledger(app.db, req, "create", "commitment_payment", id, {
      invoiceId,
      invoiceReference: inv.reference,
      commitmentId: inv.commitmentId,
      amount,
      currency: inv.currency,
      status,
      method: body.method ?? "check",
      lienWaiverSatisfied: gate.satisfied,
      waiverOverridden: waiverBlocked,
      complianceStatus: compliance.status,
      complianceBlocking: compliance.blocking.map((f) => f.code),
      budgetAllocation: budgetPosting?.allocations ?? [],
      waiverRequested: waiverRequested?.id ?? null,
    }, inv.projectId, true);

    const payment = await app.db
      .select()
      .from(commitmentPayments)
      .where(eq(commitmentPayments.id, id))
      .limit(1);
    const settledInvoice = settled as Awaited<ReturnType<typeof settleAfterTransition>> | null;
    const warnings: string[] = [];
    if (waiverBlocked) {
      warnings.push(
        `Recorded ON HOLD, not paid: ${inv.reference} still has no lien waiver on file. ` +
          "The money has not moved and the exposure remains on the outstanding-waiver report.",
      );
    }
    if (complianceBlocked) {
      warnings.push(
        `Recorded ON HOLD, not paid: ${commitment.reference} is payment-blocked — ` +
          compliance.blocking.map((f) => f.message).join(" "),
      );
    }
    for (const w of compliance.warnings) warnings.push(w.message);
    const response = {
      payment: payment[0],
      invoice: await fetchInvoice(app.db, invoiceId, req.companyId!),
      lienWaiver: gate,
      compliance,
      budgetPosting,
      settlement: settledInvoice?.invoice ?? null,
      waiverRequested,
      warnings,
    };
    await rememberIdempotent(app.db, req, "invoice.payment", 201, response);
    return reply.status(201).send(response);
  });

  app.get("/invoices/:invoiceId/payments", { preHandler: companyGate }, async (req, reply) => {
    const { invoiceId } = req.params as { invoiceId: string };
    const inv = await fetchInvoice(app.db, invoiceId, req.companyId!);
    await requireInvoicingLevel(app, req, reply, inv.projectId, "read");
    const rows = await app.db
      .select()
      .from(commitmentPayments)
      .where(eq(commitmentPayments.invoiceId, invoiceId))
      .orderBy(asc(commitmentPayments.number));
    return {
      invoiceId,
      currency: inv.currency,
      currentPaymentDue: inv.currentPaymentDue,
      amountPaid: inv.amountPaid,
      payable: payableOf(inv),
      payments: rows,
    };
  });

  app.get("/projects/:projectId/invoice-payments", { preHandler: readGate }, async (req) => {
    const q = paymentListQuery.parse(req.query);
    const clauses = [
      eq(commitmentPayments.companyId, req.companyId!),
      eq(commitmentPayments.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(commitmentPayments.status, q.status));
    if (q.vendorId) clauses.push(eq(commitmentPayments.vendorId, q.vendorId));
    if (q.commitmentId) clauses.push(eq(commitmentPayments.commitmentId, q.commitmentId));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(commitmentPayments).where(where);
    const items = await app.db
      .select()
      .from(commitmentPayments)
      .where(where)
      .orderBy(desc(commitmentPayments.paymentDate), desc(commitmentPayments.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /**
   * PAID-TO-DATE BY COST CODE — the direct-cost feed.
   *
   * Read-only and always available, so the budget can consume actual cost
   * without this module writing into it. `posted` says which payments have
   * already landed in `budget_line_items.direct_costs`; the rest are what
   * `/post-to-budget` would move.
   */
  app.get("/projects/:projectId/invoicing/direct-costs", { preHandler: readGate }, async (req) => {
    const projectId = req.projectId!;
    const payments = await app.db
      .select()
      .from(commitmentPayments)
      .where(
        and(
          eq(commitmentPayments.projectId, projectId),
          inArray(commitmentPayments.status, ["issued", "cleared"]),
        ),
      );
    const byCode = new Map<
      string,
      { costCode: string | null; costType: string | null; budgetLineItemId: string; currency: string; amount: number }
    >();
    const unposted: string[] = [];
    const reasons: string[] = [];
    for (const p of payments) {
      const detail = (p.detail ?? {}) as Record<string, unknown>;
      const posted = typeof detail["budgetPostedAt"] === "string";
      if (!posted) unposted.push(p.reference);
      const stored = detail["budgetAllocation"] as DirectCostAllocation[] | undefined;
      const allocation =
        stored ??
        (await allocateToBudgetLines(app.db, {
          amount: p.amount,
          invoiceId: p.invoiceId,
          commitmentId: p.commitmentId,
        })).allocations;
      for (const a of allocation) {
        const key = `${p.currency}:${a.budgetLineItemId}`;
        const existing = byCode.get(key);
        if (existing) existing.amount = round2(existing.amount + a.amount);
        else
          byCode.set(key, {
            costCode: a.costCode,
            costType: a.costType,
            budgetLineItemId: a.budgetLineItemId,
            currency: p.currency,
            amount: round2(a.amount),
          });
      }
    }
    if (unposted.length > 0) {
      reasons.push(
        `${unposted.length} issued payment(s) have not been posted to the budget: ` +
          `${unposted.slice(0, 10).join(", ")}${unposted.length > 10 ? ", …" : ""}.`,
      );
    }
    const lines = [...byCode.values()];
    return {
      projectId,
      byCurrency: byCurrency(
        lines,
        (l) => l.currency,
        (rows, currency) => ({
          currency,
          paidToDate: round2(rows.reduce((s, r) => s + r.amount, 0)),
          lines: rows.sort((a, b) => b.amount - a.amount),
        }),
      ),
      unpostedPayments: unposted,
      reasons,
    };
  });

  /**
   * Post every issued-but-unposted payment into the budget's direct-cost
   * column. Explicit rather than automatic on the read path, and idempotent
   * per payment, so running it twice is a no-op rather than a double count.
   */
  app.post("/projects/:projectId/invoicing/direct-costs/post-to-budget", {
    preHandler: [...companyGate, app.requireTool("invoicing", "admin")],
  }, async (req) => {
    const projectId = req.projectId!;
    const payments = await app.db
      .select({ id: commitmentPayments.id, reference: commitmentPayments.reference, detail: commitmentPayments.detail })
      .from(commitmentPayments)
      .where(
        and(
          eq(commitmentPayments.projectId, projectId),
          inArray(commitmentPayments.status, ["issued", "cleared"]),
        ),
      );
    const results: Array<{ reference: string; posted: boolean; allocations: DirectCostAllocation[]; reasons: string[] }> = [];
    for (const p of payments) {
      const detail = (p.detail ?? {}) as Record<string, unknown>;
      if (typeof detail["budgetPostedAt"] === "string") continue;
      const outcome = await postDirectCosts(app.db, p.id);
      results.push({ reference: p.reference, ...outcome });
    }
    await ledger(app.db, req, "update", "project", projectId, {
      action: "direct_costs_posted_to_budget",
      payments: results.length,
      posted: results.filter((r) => r.posted).length,
    }, projectId);
    return { projectId, postedPayments: results.length, results };
  });
};
