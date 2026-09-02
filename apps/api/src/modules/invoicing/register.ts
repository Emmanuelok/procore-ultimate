import { and, eq, inArray } from "drizzle-orm";
import {
  budgetLineItems,
  budgets,
  commitmentPayments,
  commitmentSovLines,
  invoiceLineItems,
  invoices,
} from "@constructos/db";
import { notFound } from "../../lib/errors.js";
import type { Db } from "../../lib/db.js";
import { recomputeCommitmentTotals } from "../commitments/rollups.js";
import { CENT, certifiedOf, isPaidStatus, nowIso, round2, todayIso } from "./shared.js";

/**
 * THE PAYMENT REGISTER SERVICE — one owner for what a payment's status means.
 *
 * `commitment_payments` has two writers: the invoicing module (paying an
 * invoice) and the commitments module (scheduling, approving, issuing,
 * clearing, failing, voiding). Before this file each writer kept its own
 * idea of the consequences, and the invoice's `amountPaid` was only ever
 * updated by one of them — so a payment recorded on hold through the
 * invoice drawer and later released through the commitments page cut the
 * cheque without the invoice noticing, and the invoice could be paid again.
 *
 * Now every transition ends here. `settleAfterTransition` re-derives, from
 * the register rows in `issued`/`cleared`:
 *
 *   invoices.amountPaid   Σ issued/cleared payments against the invoice
 *   invoices.status       "paid" once the certified amount is covered,
 *                         back to its approved status if a payment is voided
 *   commitments.totalPaid via the commitments module's own recompute
 *   budget direct costs   posted on issue, REVERSED on fail/void
 *
 * It is idempotent: re-deriving from rows twice yields the same rows.
 */

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
  let rows: Array<{
    budgetLineItemId: string | null;
    costCode: string | null;
    costType: string | null;
    weight: number;
  }> = [];

  if (payment.invoiceId) {
    rows = await db
      .select({
        budgetLineItemId: invoiceLineItems.budgetLineItemId,
        costCode: invoiceLineItems.costCode,
        costType: invoiceLineItems.costType,
        weight: invoiceLineItems.amount,
      })
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, payment.invoiceId));
  }
  if (rows.length === 0) {
    reasons.push(
      "No invoice continuation sheet behind this payment — it was allocated across the " +
        "commitment's schedule of values instead.",
    );
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

async function applyDirectCosts(
  db: Db,
  allocations: readonly DirectCostAllocation[],
  currency: string,
  sign: 1 | -1,
  reasons: string[],
): Promise<DirectCostAllocation[]> {
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
    const budgetRows = await db
      .select({ currency: budgets.currency })
      .from(budgets)
      .where(eq(budgets.id, line.budgetId))
      .limit(1);
    const budgetCurrency = budgetRows[0]?.currency ?? currency;
    if (budgetCurrency.toUpperCase() !== currency.toUpperCase()) {
      reasons.push(
        `Budget line ${line.costCode} is kept in ${budgetCurrency} but the payment is in ` +
          `${currency}; it was not posted. Figures in different currencies are never summed on this platform.`,
      );
      continue;
    }
    const directCosts = round2(line.directCosts + sign * alloc.amount);
    const jobToDateCosts = round2(line.jobToDateCosts + sign * alloc.amount);
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
  return applied;
}

/**
 * Post a payment's allocation into `budget_line_items.direct_costs` and
 * `job_to_date_costs`. Idempotent by stamp: `detail.budgetPostedAt` on the
 * payment means it has already landed, and a second call is a no-op rather
 * than a double count.
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
  const applied = await applyDirectCosts(db, allocations, payment.currency, 1, reasons);
  const now = nowIso();
  const { budgetReversedAt: _r, ...rest } = detail;
  await db
    .update(commitmentPayments)
    .set({
      detail: { ...rest, budgetPostedAt: now, budgetAllocation: applied, budgetPostingReasons: reasons },
      updatedAt: now,
    })
    .where(eq(commitmentPayments.id, paymentId));
  return { posted: applied.length > 0, allocations: applied, reasons };
}

/**
 * The inverse of `postDirectCosts`: a payment that failed or was voided after
 * it posted takes its direct cost back out of the budget, line by line, using
 * the allocation that was stored when it went in. Idempotent by the same
 * stamp discipline — `budgetReversedAt` marks it done.
 */
export async function reverseDirectCosts(
  db: Db,
  paymentId: string,
): Promise<{ reversed: boolean; allocations: DirectCostAllocation[] }> {
  const rows = await db
    .select()
    .from(commitmentPayments)
    .where(eq(commitmentPayments.id, paymentId))
    .limit(1);
  const payment = rows[0];
  if (!payment) throw notFound("Payment not found");
  const detail = (payment.detail ?? {}) as Record<string, unknown>;
  if (typeof detail["budgetPostedAt"] !== "string" || typeof detail["budgetReversedAt"] === "string") {
    return { reversed: false, allocations: [] };
  }
  const stored = (detail["budgetAllocation"] as DirectCostAllocation[] | undefined) ?? [];
  const reasons: string[] = [];
  const applied = await applyDirectCosts(db, stored, payment.currency, -1, reasons);
  const now = nowIso();
  const { budgetPostedAt: _p, ...rest } = detail;
  await db
    .update(commitmentPayments)
    .set({
      detail: {
        ...rest,
        budgetReversedAt: now,
        budgetReversal: applied,
        budgetPostingReasons: reasons,
      },
      updatedAt: now,
    })
    .where(eq(commitmentPayments.id, paymentId));
  return { reversed: applied.length > 0, allocations: applied };
}

/**
 * Re-derive an invoice's paid position from the register rows against it.
 * `amountPaid` is Σ issued/cleared payments; the status becomes `paid` when
 * the CERTIFIED amount (approved-as-noted honoured) is covered, and reverts to
 * the approved status when a payment is voided or fails. Nothing is
 * incremented; a second run is a no-op.
 */
export async function reconcileInvoiceFromRegister(
  db: Db,
  invoiceId: string,
): Promise<{ amountPaid: number; status: string } | null> {
  const invRows = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  const inv = invRows[0];
  if (!inv) return null;
  const rows = await db
    .select({ status: commitmentPayments.status, amount: commitmentPayments.amount })
    .from(commitmentPayments)
    .where(eq(commitmentPayments.invoiceId, invoiceId));
  const amountPaid = round2(
    rows.filter((r) => isPaidStatus(r.status)).reduce((s, r) => s + r.amount, 0),
  );
  const certified = certifiedOf(inv);
  const detail = (inv.detail ?? {}) as Record<string, unknown>;
  const approvedStatus =
    typeof detail["statusBeforePaid"] === "string"
      ? (detail["statusBeforePaid"] as string)
      : inv.status === "paid"
        ? "approved"
        : inv.status;
  let status = inv.status;
  if (["approved", "approved_as_noted", "paid"].includes(inv.status)) {
    status = certified - amountPaid <= CENT && amountPaid > CENT ? "paid" : approvedStatus;
  }
  if (Math.abs(amountPaid - inv.amountPaid) > CENT || status !== inv.status) {
    await db
      .update(invoices)
      .set({
        amountPaid,
        status,
        paidDate: status === "paid" ? (inv.paidDate ?? todayIso()) : null,
        detail:
          status === "paid" && inv.status !== "paid"
            ? { ...detail, statusBeforePaid: inv.status }
            : detail,
        updatedAt: nowIso(),
      })
      .where(eq(invoices.id, invoiceId));
  }
  return { amountPaid, status };
}

/**
 * What every payment transition calls once its own row has been written.
 * Runs on the `db` it is handed so it can sit inside the caller's transaction.
 */
export async function settleAfterTransition(
  db: Db,
  paymentId: string,
): Promise<{ invoice: { amountPaid: number; status: string } | null }> {
  const rows = await db
    .select()
    .from(commitmentPayments)
    .where(eq(commitmentPayments.id, paymentId))
    .limit(1);
  const payment = rows[0];
  if (!payment) throw notFound("Payment not found");
  if (isPaidStatus(payment.status)) {
    await postDirectCosts(db, paymentId);
  } else if (payment.status === "failed" || payment.status === "voided") {
    await reverseDirectCosts(db, paymentId);
  }
  await recomputeCommitmentTotals(db, payment.commitmentId);
  const invoice = payment.invoiceId
    ? await reconcileInvoiceFromRegister(db, payment.invoiceId)
    : null;
  return { invoice };
}

/** Every invoice touched by a set of payments, re-derived — for batch runs. */
export async function reconcileInvoicesFor(db: Db, paymentIds: readonly string[]): Promise<void> {
  if (paymentIds.length === 0) return;
  const rows = await db
    .select({ invoiceId: commitmentPayments.invoiceId })
    .from(commitmentPayments)
    .where(inArray(commitmentPayments.id, [...paymentIds]));
  const ids = [...new Set(rows.map((r) => r.invoiceId).filter((x): x is string => !!x))];
  for (const id of ids) await reconcileInvoiceFromRegister(db, id);
}

/** Payable now on an invoice: the certified figure less what the register has paid. */
export function payableOf(inv: { detail: unknown; currentPaymentDue: number; amountPaid: number }): number {
  return round2(certifiedOf(inv) - inv.amountPaid);
}

export const _internal = { and };
