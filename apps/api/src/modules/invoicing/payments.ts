import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  budgetLineItems,
  budgets,
  commitmentPayments,
  commitments,
  invoiceLineItems,
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
import { fetchInvoice, type InvoiceRow } from "./invoices.js";
import { waiverGateFor } from "./waivers.js";
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
/* Direct-cost posting                                                 */
/* ------------------------------------------------------------------ */

export interface DirectCostAllocation {
  budgetLineItemId: string;
  costCode: string | null;
  costType: string | null;
  amount: number;
}

/**
 * Split a payment across the budget lines it actually landed on.
 *
 * The allocation follows the invoice's continuation sheet, pro-rata by the
 * net amount each line billed, because that is the only evidence on the
 * record of what the money bought. A payment with no invoice behind it (an
 * advance) falls back to the commitment's schedule of values by scheduled
 * value. The last line absorbs the rounding so the allocation sums to the
 * payment exactly — an allocation that loses a cent never reconciles.
 */
export async function allocateToBudgetLines(
  db: Db,
  payment: { amount: number; invoiceId: string | null; commitmentId: string },
): Promise<{ allocations: DirectCostAllocation[]; unallocated: number; reasons: string[] }> {
  const reasons: string[] = [];
  let rows: Array<{ budgetLineItemId: string | null; costCode: string | null; costType: string | null; weight: number }> = [];

  if (payment.invoiceId) {
    const lines = await db
      .select({
        budgetLineItemId: invoiceLineItems.budgetLineItemId,
        costCode: invoiceLineItems.costCode,
        costType: invoiceLineItems.costType,
        weight: invoiceLineItems.amount,
      })
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, payment.invoiceId));
    rows = lines;
  }
  if (rows.length === 0) {
    reasons.push(
      "No invoice continuation sheet behind this payment — it was allocated across the " +
        "commitment's schedule of values instead.",
    );
    const { commitmentSovLines } = await import("@constructos/db");
    rows = await db
      .select({
        budgetLineItemId: commitmentSovLines.budgetLineItemId,
        costCode: commitmentSovLines.costCode,
        costType: commitmentSovLines.costType,
        weight: commitmentSovLines.revisedScheduledValue,
      })
      .from(commitmentSovLines)
      .where(eq(commitmentSovLines.commitmentId, payment.commitmentId));
  }

  const linked = rows.filter((r) => r.budgetLineItemId && r.weight > CENT);
  const totalWeight = round2(linked.reduce((s, r) => s + r.weight, 0));
  if (linked.length === 0 || totalWeight <= CENT) {
    return {
      allocations: [],
      unallocated: round2(payment.amount),
      reasons: [
        ...reasons,
        "None of the billed lines carry a budgetLineItemId, so this payment cannot be posted " +
          "to a budget cost code. Link the schedule of values to the budget first.",
      ],
    };
  }

  const allocations: DirectCostAllocation[] = [];
  let allocated = 0;
  for (const [i, r] of linked.entries()) {
    const share =
      i === linked.length - 1
        ? round2(payment.amount - allocated)
        : round2((r.weight / totalWeight) * payment.amount);
    allocated = round2(allocated + share);
    allocations.push({
      budgetLineItemId: r.budgetLineItemId!,
      costCode: r.costCode,
      costType: r.costType,
      amount: share,
    });
  }
  const unlinked = rows.length - linked.length;
  if (unlinked > 0) {
    reasons.push(
      `${unlinked} billed line(s) carry no budgetLineItemId and were excluded from the ` +
        "allocation; the payment was spread across the lines that are linked.",
    );
  }
  return { allocations, unallocated: 0, reasons };
}

/**
 * Post a payment's allocation into `budget_line_items.direct_costs` and
 * `job_to_date_costs`, and re-derive the forecast columns that depend on
 * them. This is the invoicing module's one write into the budget: paid-to-
 * date IS the direct-cost column, and a budget that shows committed cost
 * without actual cost cannot forecast anything.
 *
 * Additive rather than recomputed, because direct costs also arrive from
 * sources this module cannot see (payroll, equipment, expenses). Idempotent
 * by stamp: `detail.budgetPostedAt` on the payment means it has already
 * landed, and a second call is a no-op rather than a double count.
 */
export async function postDirectCosts(
  db: Db,
  paymentId: string,
): Promise<{ posted: boolean; allocations: DirectCostAllocation[]; reasons: string[] }> {
  const rows = await db
    .select()
    .from(commitmentPayments)
    .where(eq(commitmentPayments.id, paymentId))
    .limit(1);
  const payment = rows[0];
  if (!payment) throw notFound("Payment not found");
  const detail = (payment.detail ?? {}) as Record<string, unknown>;
  if (typeof detail["budgetPostedAt"] === "string") {
    return {
      posted: false,
      allocations: (detail["budgetAllocation"] as DirectCostAllocation[]) ?? [],
      reasons: ["Already posted to the budget."],
    };
  }

  const { allocations, reasons } = await allocateToBudgetLines(db, {
    amount: payment.amount,
    invoiceId: payment.invoiceId,
    commitmentId: payment.commitmentId,
  });
  const applied: DirectCostAllocation[] = [];
  const now = nowIso();
  for (const alloc of allocations) {
    const lineRows = await db
      .select()
      .from(budgetLineItems)
      .where(eq(budgetLineItems.id, alloc.budgetLineItemId))
      .limit(1);
    const line = lineRows[0];
    if (!line) continue;
    // Never post across currencies. A USD payment must not land on a budget
    // kept in EUR — there is no rate on the record and inventing one would
    // corrupt the one column a cost report is judged on.
    const budgetRows = await db
      .select({ currency: budgets.currency })
      .from(budgets)
      .where(eq(budgets.id, line.budgetId))
      .limit(1);
    const budgetCurrency = budgetRows[0]?.currency ?? payment.currency;
    if (budgetCurrency.toUpperCase() !== payment.currency.toUpperCase()) {
      reasons.push(
        `Budget line ${line.costCode} is kept in ${budgetCurrency} but the payment is in ` +
          `${payment.currency}; it was not posted. Figures in different currencies are never ` +
          "summed on this platform.",
      );
      continue;
    }
    const directCosts = round2(line.directCosts + alloc.amount);
    const jobToDateCosts = round2(line.jobToDateCosts + alloc.amount);
    const forecastFinal = round2(jobToDateCosts + line.forecastToComplete);
    await db
      .update(budgetLineItems)
      .set({
        directCosts,
        jobToDateCosts,
        forecastFinal,
        projectedOverUnder: round2(line.revisedBudget - forecastFinal),
        updatedAt: now,
      })
      .where(eq(budgetLineItems.id, line.id));
    applied.push(alloc);
  }

  await db
    .update(commitmentPayments)
    .set({
      detail: {
        ...detail,
        budgetPostedAt: now,
        budgetAllocation: applied,
        budgetPostingReasons: reasons,
      },
      updatedAt: now,
    })
    .where(eq(commitmentPayments.id, paymentId));
  return { posted: applied.length > 0, allocations: applied, reasons };
}

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
  function payableOf(inv: InvoiceRow): number {
    const detail = (inv.detail ?? {}) as Record<string, unknown>;
    const approved = detail["approvedAmount"];
    const ceiling =
      typeof approved === "number" ? Math.min(approved, inv.currentPaymentDue) : inv.currentPaymentDue;
    return round2(ceiling - inv.amountPaid);
  }

  app.post("/invoices/:invoiceId/payments", { preHandler: companyGate }, async (req, reply) => {
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
    // The person who approved the invoice does not also get to pay it.
    assertSegregation(req.user!.id, { submittedBy: inv.submittedBy }, "invoice");

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

    const held = waiverBlocked;
    const status = held ? "on_hold" : (body.status ?? "issued");
    const number = await nextRecordNumber(
      app.db,
      inv.projectId,
      paymentCounterKey(inv.commitmentId),
    );
    const id = newId("cpy");
    const now = nowIso();
    await app.db.insert(commitmentPayments).values({
      id,
      companyId: req.companyId!,
      projectId: inv.projectId,
      commitmentId: inv.commitmentId,
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
      holdReason: held
        ? `Lien waiver not on file. Override: ${body.overrideReason}`
        : null,
      lienWaiverId: body.lienWaiverId ?? null,
      notes: body.notes ?? null,
      detail: {
        ...(body.detail ?? {}),
        ...(held
          ? {
              waiverOverriddenBy: req.user!.id,
              waiverOverriddenAt: now,
              waiverOverrideReason: body.overrideReason,
              waiversAtOverride: gate.waivers,
            }
          : {}),
      },
      createdBy: req.user!.id,
      ...(status === "issued" ? { issuedBy: req.user!.id, issuedAt: now } : {}),
      updatedAt: now,
    });

    let budgetPosting: Awaited<ReturnType<typeof postDirectCosts>> | null = null;
    if (status === "issued") {
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
      await recomputeCommitmentPaid(app.db, inv.commitmentId);
      budgetPosting = await postDirectCosts(app.db, id);
    }

    await ledger(app.db, req, "create", "commitment_payment", id, {
      invoiceId,
      invoiceReference: inv.reference,
      commitmentId: inv.commitmentId,
      amount,
      currency: inv.currency,
      status,
      method: body.method ?? "check",
      lienWaiverSatisfied: gate.satisfied,
      waiverOverridden: held,
      budgetAllocation: budgetPosting?.allocations ?? [],
    }, inv.projectId, true);

    const payment = await app.db
      .select()
      .from(commitmentPayments)
      .where(eq(commitmentPayments.id, id))
      .limit(1);
    return reply.status(201).send({
      payment: payment[0],
      invoice: await fetchInvoice(app.db, invoiceId, req.companyId!),
      lienWaiver: gate,
      budgetPosting,
      warnings: held
        ? [
            `Recorded ON HOLD, not paid: ${inv.reference} still has no lien waiver on file. ` +
              "The money has not moved and the exposure remains on the outstanding-waiver report.",
          ]
        : [],
    });
  });

  /** `commitments.total_paid`, derived from the register rather than incremented. */
  async function recomputeCommitmentPaid(db: Db, commitmentId: string): Promise<void> {
    const rows = await db
      .select({ status: commitmentPayments.status, amount: commitmentPayments.amount })
      .from(commitmentPayments)
      .where(eq(commitmentPayments.commitmentId, commitmentId));
    const totalPaid = round2(
      rows.filter((p) => p.status === "issued" || p.status === "cleared").reduce((s, p) => s + p.amount, 0),
    );
    await db
      .update(commitments)
      .set({ totalPaid, updatedAt: nowIso() })
      .where(eq(commitments.id, commitmentId));
  }

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
    const clauses = [eq(commitmentPayments.projectId, req.projectId!)];
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
