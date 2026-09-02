/**
 * BUDGET RECONCILIATION — the cost-side columns rebuilt from their sources.
 *
 * WHY THIS FILE EXISTS
 *
 * Three writers used to compete for the cost columns of a budget line:
 * commitments (committed / pending), invoicing (job-to-date, as invoices were
 * approved) and payments (direct cost AND job-to-date, as invoices were paid).
 * Two of those double-counted: the invoicing read summed CUMULATIVE invoice
 * lines across every period, so a commitment billed 100k then 250k showed
 * 350k spent; and a paid invoice landed in direct cost on top of the invoice
 * that had already landed in job-to-date, so 90k invoiced and paid showed as
 * 180k. Both are fixed here, structurally:
 *
 *   invoicedToDate  = the LATEST approved invoice line per commitment SOV
 *                     line (cumulative-to-date by construction) plus every
 *                     approved non-SOV line (period figures) — never a sum of
 *                     cumulative rows.
 *   paidToDate      = the payment allocations the payments module stamped
 *                     onto commitment_payments.detail.budgetAllocation.
 *   directCosts     = what other modules posted; the part of it that is
 *                     commitment payments is IDENTIFIED (paidToDate) and not
 *                     counted a second time.
 *   jobToDateCosts  = max(invoicedToDate, paidToDate) + (directCosts − paidToDate)⁺
 *
 * Every figure is recorded per source in `budget_postings` (idempotent on the
 * source coordinate) so a drawer can show the arithmetic, and every run is a
 * `budget_reconciliations` row plus a ledger entry. A stored figure that
 * disagrees with its rebuilt value is reported as DRIFT and corrected — never
 * silently overwritten without a record of what it was.
 *
 * Spec: #495 direct cost roll-up, #496 job-to-date, #497 variance, #500
 * drill-down to source transactions.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  budgetChanges,
  budgetForecasts,
  budgetLineItems,
  budgetPostings,
  budgetReconciliations,
  budgets,
  commitmentPayments,
  commitmentSovLines,
  commitments,
  invoiceLineItems,
  invoices,
  signals,
} from "@constructos/db";
import type { BudgetPostingComponent, BudgetPostingSourceType } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { computed, nearlyEqual, reconcile as reconcileTotals, rollUpTotals, round2, unavailable, type Component } from "./calc.js";
import { derivedColumns } from "./derive.js";

type BudgetRow = typeof budgets.$inferSelect;
type LineRow = typeof budgetLineItems.$inferSelect;

const nowIso = (): string => new Date().toISOString();
const pad3 = (n: number): string => String(n).padStart(3, "0");

/** Commitment statuses that count as committed cost vs. still-pending exposure. */
export const COMMITTED_STATUSES = ["approved", "complete"] as const;
export const PENDING_COMMITMENT_STATUSES = ["draft", "out_for_bid", "out_for_signature"] as const;
/** Subcontractor invoice statuses that represent cost actually incurred. */
export const INCURRED_INVOICE_STATUSES = ["approved", "approved_as_noted", "paid"] as const;
/** Payment statuses under which money has actually left. */
export const SETTLED_PAYMENT_STATUSES = ["issued", "cleared", "paid"] as const;

/* ------------------------------------------------------------------ */
/* Pure arithmetic                                                     */
/* ------------------------------------------------------------------ */

export interface InvoiceLineRead {
  invoiceId: string;
  invoiceNumber: number;
  invoiceReference: string;
  invoiceStatus: string;
  approvedAt: string | null;
  commitmentId: string | null;
  commitmentSovLineId: string | null;
  budgetLineItemId: string | null;
  totalCompletedAndStored: number;
  currency: string;
}

/**
 * The lines that represent cost incurred: for every commitment SOV line the
 * LATEST approved invoice line (cumulative to date), plus every approved line
 * that is not tied to an SOV line (a period figure). Summing cumulative rows
 * across periods is exactly the double count this exists to prevent.
 */
export function latestInvoiceLinePerSovLine(rows: readonly InvoiceLineRead[]): InvoiceLineRead[] {
  const bySov = new Map<string, InvoiceLineRead>();
  const loose: InvoiceLineRead[] = [];
  for (const row of rows) {
    if (!row.commitmentSovLineId) {
      loose.push(row);
      continue;
    }
    const current = bySov.get(row.commitmentSovLineId);
    if (
      !current ||
      row.invoiceNumber > current.invoiceNumber ||
      (row.invoiceNumber === current.invoiceNumber && (row.approvedAt ?? "") > (current.approvedAt ?? ""))
    ) {
      bySov.set(row.commitmentSovLineId, row);
    }
  }
  return [...bySov.values(), ...loose];
}

export interface PaymentRead {
  id: string;
  reference: string;
  status: string;
  currency: string;
  invoiceId: string | null;
  commitmentId: string;
  detail: unknown;
}

export interface PaidAllocation {
  paymentId: string;
  reference: string;
  budgetLineItemId: string;
  amount: number;
  currency: string;
  invoiceId: string | null;
  commitmentId: string;
}

/**
 * The commitment payments the payments module has already posted into the
 * budget (it stamps `detail.budgetPostedAt` + `detail.budgetAllocation`).
 * These are the rows inside `directCosts` that are ALSO inside invoiced
 * cost, and must be counted once.
 */
export function paidCommitmentAllocations(payments: readonly PaymentRead[]): PaidAllocation[] {
  const out: PaidAllocation[] = [];
  for (const p of payments) {
    if (p.status === "void" || p.status === "cancelled") continue;
    const detail = (p.detail && typeof p.detail === "object" ? p.detail : {}) as Record<string, unknown>;
    if (typeof detail["budgetPostedAt"] !== "string") continue;
    const allocations = detail["budgetAllocation"];
    if (!Array.isArray(allocations)) continue;
    for (const raw of allocations) {
      if (!raw || typeof raw !== "object") continue;
      const a = raw as Record<string, unknown>;
      const lineId = typeof a["budgetLineItemId"] === "string" ? a["budgetLineItemId"] : null;
      const amount = typeof a["amount"] === "number" && Number.isFinite(a["amount"]) ? a["amount"] : null;
      if (!lineId || amount === null) continue;
      out.push({ paymentId: p.id, reference: p.reference, budgetLineItemId: lineId, amount: round2(amount), currency: p.currency, invoiceId: p.invoiceId, commitmentId: p.commitmentId });
    }
  }
  return out;
}

export interface JobToDateInputs {
  invoicedToDate: number | null;
  paidToDate: number;
  directCosts: number;
}

export interface JobToDateResult {
  jobToDateCosts: number;
  /** direct cost that is NOT a commitment payment (labour, equipment, expenses) */
  nonCommitmentDirectCosts: number;
  /** the commitment cost recognised: invoiced when known, else paid */
  commitmentCost: number;
  basis: string;
}

/**
 * jobToDate = commitment cost recognised ONCE + direct cost from outside the
 * commitment chain. Invoiced is the stronger measure of cost incurred; paid
 * can only exceed it when a payment landed before its invoice was approved,
 * in which case the payment is the evidence.
 */
export function computeJobToDate(i: JobToDateInputs): JobToDateResult {
  const invoiced = i.invoicedToDate ?? 0;
  const paid = round2(i.paidToDate);
  const nonCommitmentDirect = round2(Math.max(0, i.directCosts - paid));
  const commitmentCost = round2(Math.max(invoiced, paid));
  return {
    jobToDateCosts: round2(commitmentCost + nonCommitmentDirect),
    nonCommitmentDirectCosts: nonCommitmentDirect,
    commitmentCost,
    basis:
      `max(invoiced ${invoiced.toFixed(2)}, paid ${paid.toFixed(2)}) + direct cost outside commitments ` +
      `${nonCommitmentDirect.toFixed(2)} (direct ${i.directCosts.toFixed(2)} less the ${paid.toFixed(2)} of it that is commitment payments)`,
  };
}

/* ------------------------------------------------------------------ */
/* Source reads                                                        */
/* ------------------------------------------------------------------ */

export interface SourceRowOut {
  sourceType: BudgetPostingSourceType;
  sourceId: string;
  reference: string;
  description: string;
  status: string | null;
  currency: string;
  amount: number;
  /** why this row is excluded from the total (currency), when it is */
  excluded: string | null;
  detail: Record<string, unknown>;
}

export interface SourceComponent {
  component: Component;
  /** budgetLineItemId -> amount, only rows in the budget currency with a line */
  byLine: Map<string, number>;
  /** every row read, mapped or not, for the drill-down */
  rowsByLine: Map<string, SourceRowOut[]>;
  unmapped: SourceRowOut[];
}

const emptyComponent = (reason: string): SourceComponent => ({
  component: unavailable([reason]),
  byLine: new Map(),
  rowsByLine: new Map(),
  unmapped: [],
});

function foldRows(
  rows: readonly (SourceRowOut & { budgetLineItemId: string | null })[],
  budgetCurrency: string,
  label: string,
  noneReason: string,
): SourceComponent {
  if (rows.length === 0) return emptyComponent(noneReason);
  const byLine = new Map<string, number>();
  const rowsByLine = new Map<string, SourceRowOut[]>();
  const unmapped: SourceRowOut[] = [];
  const foreign = new Set<string>();
  let counted = 0;
  let excluded = 0;
  let total = 0;
  let unmappedAmount = 0;
  for (const row of rows) {
    const cur = (row.currency ?? budgetCurrency).toUpperCase();
    const isForeign = cur !== budgetCurrency.toUpperCase();
    const out: SourceRowOut = {
      ...row,
      excluded: isForeign ? `Denominated in ${cur}; this budget is kept in ${budgetCurrency} and figures are never summed across currencies.` : null,
    };
    if (!row.budgetLineItemId) {
      unmapped.push(out);
      if (!isForeign) unmappedAmount += row.amount;
      continue;
    }
    const list = rowsByLine.get(row.budgetLineItemId) ?? [];
    list.push(out);
    rowsByLine.set(row.budgetLineItemId, list);
    if (isForeign) {
      excluded += 1;
      foreign.add(cur);
      continue;
    }
    counted += 1;
    total += row.amount;
    byLine.set(row.budgetLineItemId, round2((byLine.get(row.budgetLineItemId) ?? 0) + row.amount));
  }
  const reasons: string[] = [];
  if (excluded > 0) {
    reasons.push(`${excluded} ${label} row(s) denominated in ${[...foreign].sort().join(", ")} were excluded — this budget is kept in ${budgetCurrency} and figures are never summed across currencies.`);
  }
  if (unmapped.length > 0) {
    reasons.push(`${unmapped.length} ${label} row(s) worth ${round2(unmappedAmount).toFixed(2)} carry no budgetLineItemId and are outside every budget line — the project total and the budget total differ by that amount until they are coded.`);
  }
  if (counted === 0 && unmapped.length === 0) {
    return { component: unavailable([...reasons, `No ${label} in ${budgetCurrency} on this project — a total would be a fabrication.`]), byLine, rowsByLine, unmapped };
  }
  return {
    component: { ...computed(total + unmappedAmount, { rowsConsidered: rows.length, rowsCounted: counted, rowsExcluded: excluded, excludedCurrencies: [...foreign].sort(), unmappedLines: unmapped.length, unmappedAmount: round2(unmappedAmount) }), reasons },
    byLine,
    rowsByLine,
    unmapped,
  };
}

export async function readCommitmentSources(db: Db, budget: BudgetRow, which: "committed" | "pending"): Promise<SourceComponent> {
  const rows = await db
    .select({
      id: commitmentSovLines.id,
      lineNumber: commitmentSovLines.lineNumber,
      description: commitmentSovLines.description,
      budgetLineItemId: commitmentSovLines.budgetLineItemId,
      scheduledValue: commitmentSovLines.scheduledValue,
      changeOrderValue: commitmentSovLines.changeOrderValue,
      revisedScheduledValue: commitmentSovLines.revisedScheduledValue,
      commitmentId: commitments.id,
      commitmentReference: commitments.reference,
      commitmentTitle: commitments.title,
      status: commitments.status,
      currency: commitments.currency,
    })
    .from(commitmentSovLines)
    .innerJoin(commitments, eq(commitments.id, commitmentSovLines.commitmentId))
    .where(and(eq(commitmentSovLines.companyId, budget.companyId), eq(commitmentSovLines.projectId, budget.projectId)));
  const wanted: readonly string[] = which === "committed" ? COMMITTED_STATUSES : PENDING_COMMITMENT_STATUSES;
  const relevant = rows.filter((r) => wanted.includes(r.status));
  const label = which === "committed" ? "committed cost" : "pending commitment";
  return foldRows(
    relevant.map((r) => ({
      sourceType: "commitment_sov_line" as const,
      sourceId: r.id,
      reference: `${r.commitmentReference} / ${r.lineNumber}`,
      description: `${r.commitmentTitle} — ${r.description}`,
      status: r.status,
      currency: r.currency,
      // the column is NOT NULL default 0: a line reduced to 0 by a deductive
      // change order is 0 committed, not its original scheduled value
      amount: round2(r.revisedScheduledValue),
      budgetLineItemId: r.budgetLineItemId,
      excluded: null,
      detail: { commitmentId: r.commitmentId, scheduledValue: r.scheduledValue, changeOrderValue: r.changeOrderValue },
    })),
    budget.currency,
    label,
    rows.length === 0
      ? "No commitment schedule-of-values lines exist on this project yet, so committed cost is unknown rather than zero."
      : which === "committed"
        ? "No approved or complete commitments on this project — committed cost is unknown rather than zero."
        : "No draft or out-for-signature commitments on this project.",
  );
}

export async function readInvoicedSources(db: Db, budget: BudgetRow): Promise<SourceComponent> {
  const rows = await db
    .select({
      lineId: invoiceLineItems.id,
      lineNumber: invoiceLineItems.lineNumber,
      description: invoiceLineItems.description,
      budgetLineItemId: invoiceLineItems.budgetLineItemId,
      commitmentSovLineId: invoiceLineItems.commitmentSovLineId,
      totalCompletedAndStored: invoiceLineItems.totalCompletedAndStored,
      thisPeriodWork: invoiceLineItems.thisPeriodWork,
      previousBilled: invoiceLineItems.previousBilled,
      invoiceId: invoices.id,
      invoiceNumber: invoices.number,
      invoiceReference: invoices.reference,
      status: invoices.status,
      kind: invoices.kind,
      currency: invoices.currency,
      approvedAt: invoices.approvedAt,
      commitmentId: invoices.commitmentId,
    })
    .from(invoiceLineItems)
    .innerJoin(invoices, eq(invoices.id, invoiceLineItems.invoiceId))
    .where(and(eq(invoiceLineItems.companyId, budget.companyId), eq(invoiceLineItems.projectId, budget.projectId)));
  const relevant = rows.filter((r) => r.kind === "subcontractor_invoice" && (INCURRED_INVOICE_STATUSES as readonly string[]).includes(r.status));
  const chosen = latestInvoiceLinePerSovLine(
    relevant.map((r) => ({
      invoiceId: r.invoiceId,
      invoiceNumber: r.invoiceNumber,
      invoiceReference: r.invoiceReference,
      invoiceStatus: r.status,
      approvedAt: r.approvedAt,
      commitmentId: r.commitmentId,
      commitmentSovLineId: r.commitmentSovLineId,
      budgetLineItemId: r.budgetLineItemId,
      totalCompletedAndStored: r.totalCompletedAndStored,
      currency: r.currency,
    })),
  );
  const byInvoiceLine = new Map(relevant.map((r) => [`${r.invoiceId}:${r.commitmentSovLineId ?? r.lineId}`, r]));
  const supersededCount = relevant.length - chosen.length;
  const folded = foldRows(
    chosen.map((c) => {
      const raw = byInvoiceLine.get(`${c.invoiceId}:${c.commitmentSovLineId ?? ""}`) ?? relevant.find((r) => r.invoiceId === c.invoiceId && r.budgetLineItemId === c.budgetLineItemId);
      return {
        sourceType: "invoice_line" as const,
        sourceId: c.commitmentSovLineId ? `sov:${c.commitmentSovLineId}` : `line:${raw?.lineId ?? c.invoiceId}`,
        reference: c.invoiceReference,
        description: raw?.description ?? "Invoice line",
        status: c.invoiceStatus,
        currency: c.currency,
        amount: round2(c.totalCompletedAndStored),
        budgetLineItemId: c.budgetLineItemId,
        excluded: null,
        detail: {
          invoiceId: c.invoiceId,
          invoiceNumber: c.invoiceNumber,
          commitmentId: c.commitmentId,
          commitmentSovLineId: c.commitmentSovLineId,
          cumulative: c.commitmentSovLineId !== null,
          basis: c.commitmentSovLineId
            ? "Latest approved invoice for this commitment SOV line; its total completed and stored is cumulative to date."
            : "Approved invoice line not tied to a commitment SOV line; counted as a period figure.",
        },
      };
    }),
    budget.currency,
    "subcontractor invoice",
    rows.length === 0
      ? "No invoice lines exist on this project yet, so cost invoiced to date is unknown rather than zero."
      : "No approved or paid subcontractor invoices on this project — cost invoiced to date is unknown rather than zero.",
  );
  if (supersededCount > 0 && folded.component.value !== null) {
    folded.component.inputs["supersededInvoiceLines"] = supersededCount;
    folded.component.reasons.push(`${supersededCount} earlier invoice line(s) on the same commitment SOV lines were superseded by a later cumulative figure and are not added again.`);
  }
  return folded;
}

export async function readPaidSources(db: Db, budget: BudgetRow): Promise<SourceComponent> {
  const rows = await db
    .select({
      id: commitmentPayments.id,
      reference: commitmentPayments.reference,
      status: commitmentPayments.status,
      currency: commitmentPayments.currency,
      invoiceId: commitmentPayments.invoiceId,
      commitmentId: commitmentPayments.commitmentId,
      paymentDate: commitmentPayments.paymentDate,
      amount: commitmentPayments.amount,
      detail: commitmentPayments.detail,
    })
    .from(commitmentPayments)
    .where(and(eq(commitmentPayments.companyId, budget.companyId), eq(commitmentPayments.projectId, budget.projectId)));
  const allocations = paidCommitmentAllocations(rows.map((r) => ({ id: r.id, reference: r.reference, status: r.status, currency: r.currency, invoiceId: r.invoiceId, commitmentId: r.commitmentId, detail: r.detail })));
  if (rows.length === 0) return emptyComponent("No commitment payments exist on this project, so paid-to-date is unknown rather than zero.");
  const byPayment = new Map(rows.map((r) => [r.id, r]));
  return foldRows(
    allocations.map((a) => ({
      sourceType: "commitment_payment" as const,
      sourceId: `${a.paymentId}:${a.budgetLineItemId}`,
      reference: a.reference,
      description: `Payment ${a.reference} on ${a.commitmentId}`,
      status: byPayment.get(a.paymentId)?.status ?? null,
      currency: a.currency,
      amount: a.amount,
      budgetLineItemId: a.budgetLineItemId,
      excluded: null,
      detail: { paymentId: a.paymentId, invoiceId: a.invoiceId, commitmentId: a.commitmentId, paymentDate: byPayment.get(a.paymentId)?.paymentDate ?? null, basis: "Allocation the payments module stamped on the payment when it posted to the budget." },
    })),
    budget.currency,
    "commitment payment",
    "No commitment payment has been posted to this budget yet.",
  );
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

export interface DriftRow {
  lineItemId: string;
  costCode: string;
  costType: string;
  component: BudgetPostingComponent;
  stored: number;
  rebuilt: number;
  delta: number;
}

export interface ReconciliationResult {
  id: string;
  reference: string;
  budgetId: string;
  currency: string;
  trigger: "manual" | "scheduled";
  linesChecked: number;
  updatedLines: number;
  driftCount: number;
  driftAmount: number;
  drift: DriftRow[];
  totals: ReturnType<typeof rollUpTotals>;
  reconciliation: ReturnType<typeof reconcileTotals>;
  applied: { committedCost: boolean; pendingCommitments: boolean; jobToDateCosts: boolean; paidToDate: boolean };
  skipped: Array<{ component: string; reasons: string[] }>;
  components: { committed: Component; pendingCommitments: Component; invoicedToDate: Component; paidToDate: Component };
  postingsWritten: number;
  signalId: string | null;
}

interface PostingWrite {
  budgetLineItemId: string;
  component: BudgetPostingComponent;
  sourceType: BudgetPostingSourceType;
  sourceId: string;
  sourceReference: string | null;
  currency: string;
  amount: number;
  basis: string | null;
  detail: Record<string, unknown>;
}

/**
 * Rebuild the cost-side columns of every line on `budget` from the source
 * tables, record the drift, post each source row, and ledger the run. A
 * component whose source table holds nothing is SKIPPED, not zeroed —
 * overwriting a stored figure with a fabricated 0 because a sibling module
 * has not shipped yet would be the worst kind of quiet wrong answer.
 */
export async function runReconciliation(
  db: Db,
  budget: BudgetRow,
  opts: { trigger: "manual" | "scheduled"; actorId: string | null; raiseSignal?: boolean },
): Promise<ReconciliationResult> {
  const lines = await db.select().from(budgetLineItems).where(eq(budgetLineItems.budgetId, budget.id)).orderBy(asc(budgetLineItems.sortOrder), asc(budgetLineItems.costCode));
  const [committed, pending, invoiced, paid] = await Promise.all([
    readCommitmentSources(db, budget, "committed"),
    readCommitmentSources(db, budget, "pending"),
    readInvoicedSources(db, budget),
    readPaidSources(db, budget),
  ]);
  const applyCommitted = committed.component.value !== null;
  const applyPending = pending.component.value !== null;
  const applyInvoiced = invoiced.component.value !== null;
  const applyPaid = paid.component.value !== null;

  const drift: DriftRow[] = [];
  const postings: PostingWrite[] = [];
  let updatedLines = 0;
  const now = nowIso();

  await db.transaction(async (tx) => {
    for (const line of lines) {
      const committedCost = applyCommitted ? (committed.byLine.get(line.id) ?? 0) : line.committedCost;
      const pendingCommitments = applyPending ? (pending.byLine.get(line.id) ?? 0) : line.pendingCommitments;
      const paidToDate = applyPaid ? (paid.byLine.get(line.id) ?? 0) : 0;
      const jtd = applyInvoiced || applyPaid
        ? computeJobToDate({ invoicedToDate: applyInvoiced ? (invoiced.byLine.get(line.id) ?? 0) : null, paidToDate, directCosts: line.directCosts })
        : null;
      const jobToDateCosts = jtd ? jtd.jobToDateCosts : line.jobToDateCosts;

      const note = (component: BudgetPostingComponent, stored: number, rebuilt: number): void => {
        if (!nearlyEqual(stored, rebuilt)) {
          drift.push({ lineItemId: line.id, costCode: line.costCode, costType: line.costType, component, stored: round2(stored), rebuilt: round2(rebuilt), delta: round2(rebuilt - stored) });
        }
      };
      if (applyCommitted) note("committedCost", line.committedCost, committedCost);
      if (applyPending) note("pendingCommitments", line.pendingCommitments, pendingCommitments);
      if (jtd) note("jobToDateCosts", line.jobToDateCosts, jobToDateCosts);

      const next = { ...lineAmounts(line), committedCost, pendingCommitments, jobToDateCosts, forecastMethod: line.forecastMethod, forecastToComplete: line.forecastToComplete };
      const derived = derivedColumns(next);
      const changed =
        !nearlyEqual(committedCost, line.committedCost) ||
        !nearlyEqual(pendingCommitments, line.pendingCommitments) ||
        !nearlyEqual(jobToDateCosts, line.jobToDateCosts) ||
        !nearlyEqual(derived.set.forecastToComplete, line.forecastToComplete) ||
        !nearlyEqual(derived.set.revisedBudget, line.revisedBudget) ||
        !nearlyEqual(derived.set.forecastFinal, line.forecastFinal);
      if (changed) {
        updatedLines += 1;
        await tx.update(budgetLineItems).set({ committedCost, pendingCommitments, jobToDateCosts, updatedAt: now, ...derived.set }).where(eq(budgetLineItems.id, line.id));
      }

      // postings — one per source row, idempotent on the source coordinate
      const push = (component: BudgetPostingComponent, rows: SourceRowOut[] | undefined): void => {
        for (const r of rows ?? []) {
          if (r.excluded) continue;
          postings.push({ budgetLineItemId: line.id, component, sourceType: r.sourceType, sourceId: r.sourceId, sourceReference: r.reference, currency: r.currency, amount: r.amount, basis: typeof r.detail["basis"] === "string" ? (r.detail["basis"] as string) : null, detail: r.detail });
        }
      };
      if (applyCommitted) push("committedCost", committed.rowsByLine.get(line.id));
      if (applyPending) push("pendingCommitments", pending.rowsByLine.get(line.id));
      if (applyInvoiced) push("invoicedToDate", invoiced.rowsByLine.get(line.id));
      if (applyPaid) push("paidToDate", paid.rowsByLine.get(line.id));
      if (jtd) {
        postings.push({ budgetLineItemId: line.id, component: "jobToDateCosts", sourceType: "unattributed", sourceId: "jtd", sourceReference: null, currency: budget.currency, amount: jobToDateCosts, basis: jtd.basis, detail: { commitmentCost: jtd.commitmentCost, nonCommitmentDirectCosts: jtd.nonCommitmentDirectCosts, directCosts: line.directCosts, paidToDate } });
        if (jtd.nonCommitmentDirectCosts > 0) {
          postings.push({ budgetLineItemId: line.id, component: "directCosts", sourceType: "unattributed", sourceId: "direct-cost-remainder", sourceReference: null, currency: budget.currency, amount: jtd.nonCommitmentDirectCosts, basis: "Direct cost posted by another module without a source stamp (labour, equipment, expenses), net of commitment payments.", detail: { directCosts: line.directCosts, paidToDate } });
        }
      }
    }

    // drop stale postings for the components rebuilt, then upsert the fresh set
    const rebuilt: BudgetPostingComponent[] = [
      ...(applyCommitted ? (["committedCost"] as const) : []),
      ...(applyPending ? (["pendingCommitments"] as const) : []),
      ...(applyInvoiced ? (["invoicedToDate"] as const) : []),
      ...(applyPaid ? (["paidToDate"] as const) : []),
      ...(applyInvoiced || applyPaid ? (["jobToDateCosts", "directCosts"] as const) : []),
    ];
    if (rebuilt.length > 0) {
      const previous = await tx
        .select({ id: budgetPostings.id, budgetLineItemId: budgetPostings.budgetLineItemId, component: budgetPostings.component, sourceType: budgetPostings.sourceType, sourceId: budgetPostings.sourceId, amount: budgetPostings.amount })
        .from(budgetPostings)
        .where(and(eq(budgetPostings.budgetId, budget.id), inArray(budgetPostings.component, rebuilt)));
      const prevByKey = new Map(previous.map((p) => [`${p.budgetLineItemId}|${p.component}|${p.sourceType}|${p.sourceId}`, p]));
      const keep = new Set<string>();
      for (const p of postings) {
        const key = `${p.budgetLineItemId}|${p.component}|${p.sourceType}|${p.sourceId}`;
        keep.add(key);
        const prev = prevByKey.get(key);
        const previousAmount = prev?.amount ?? 0;
        await tx
          .insert(budgetPostings)
          .values({ id: newId("bpo"), companyId: budget.companyId, projectId: budget.projectId, budgetId: budget.id, budgetLineItemId: p.budgetLineItemId, component: p.component, sourceType: p.sourceType, sourceId: p.sourceId, sourceReference: p.sourceReference, currency: p.currency, amount: p.amount, previousAmount, delta: round2(p.amount - previousAmount), basis: p.basis, detail: p.detail, postedAt: now })
          .onConflictDoUpdate({
            target: [budgetPostings.budgetLineItemId, budgetPostings.component, budgetPostings.sourceType, budgetPostings.sourceId],
            set: { amount: p.amount, previousAmount, delta: round2(p.amount - previousAmount), sourceReference: p.sourceReference, currency: p.currency, basis: p.basis, detail: p.detail, postedAt: now },
          });
      }
      const stale = previous.filter((p) => !keep.has(`${p.budgetLineItemId}|${p.component}|${p.sourceType}|${p.sourceId}`)).map((p) => p.id);
      if (stale.length > 0) await tx.delete(budgetPostings).where(inArray(budgetPostings.id, stale));
    }
  });

  // totals + the reconciliation record
  const refreshed = await db.select().from(budgetLineItems).where(eq(budgetLineItems.budgetId, budget.id));
  const totals = rollUpTotals(refreshed.map((l) => ({ ...lineAmounts(l), revisedBudget: l.revisedBudget, forecastToComplete: l.forecastToComplete, forecastFinal: l.forecastFinal, projectedOverUnder: l.projectedOverUnder })));
  await db.update(budgets).set({ ...totals, totalsCalculatedAt: now, updatedAt: now }).where(eq(budgets.id, budget.id));

  const driftAmount = round2(drift.reduce((s, d) => s + Math.abs(d.delta), 0));
  const number = await nextRecordNumber(db, budget.id, "budget_reconciliation");
  const id = newId("brc");
  const reference = `RC-${pad3(number)}`;
  const skipped = [
    ...(applyCommitted ? [] : [{ component: "committedCost", reasons: committed.component.reasons }]),
    ...(applyPending ? [] : [{ component: "pendingCommitments", reasons: pending.component.reasons }]),
    ...(applyInvoiced ? [] : [{ component: "invoicedToDate", reasons: invoiced.component.reasons }]),
    ...(applyPaid ? [] : [{ component: "paidToDate", reasons: paid.component.reasons }]),
    ...(applyInvoiced || applyPaid ? [] : [{ component: "jobToDateCosts", reasons: [...invoiced.component.reasons, "With neither invoiced nor paid cost known, job-to-date was left as stored."] }]),
  ];
  const componentsRecord: Record<string, unknown> = {
    committedCost: { applied: applyCommitted, reasons: committed.component.reasons },
    pendingCommitments: { applied: applyPending, reasons: pending.component.reasons },
    invoicedToDate: { applied: applyInvoiced, reasons: invoiced.component.reasons },
    paidToDate: { applied: applyPaid, reasons: paid.component.reasons },
    jobToDateCosts: { applied: applyInvoiced || applyPaid, reasons: [] },
  };
  await db.insert(budgetReconciliations).values({
    id,
    companyId: budget.companyId,
    projectId: budget.projectId,
    budgetId: budget.id,
    number,
    reference,
    trigger: opts.trigger,
    runBy: opts.actorId,
    linesChecked: lines.length,
    linesUpdated: updatedLines,
    driftCount: drift.length,
    driftAmount,
    drift,
    components: componentsRecord,
    totals: totals as unknown as Record<string, number>,
    detail: { postingsWritten: postings.length },
  });
  await appendLedger(db, {
    companyId: budget.companyId,
    projectId: budget.projectId,
    actorId: opts.actorId,
    action: "update",
    objectType: "budget_reconciliation",
    objectId: id,
    payload: { budgetId: budget.id, projectId: budget.projectId, reference, trigger: opts.trigger, linesChecked: lines.length, linesUpdated: updatedLines, driftCount: drift.length, driftAmount, drift: drift.slice(0, 200), revisedBudgetTotal: totals.revisedBudgetTotal, jobToDateCostsTotal: totals.jobToDateCostsTotal },
    storePayload: true,
  });

  let signalId: string | null = null;
  if (opts.raiseSignal && drift.length > 0 && driftAmount > 0.5) {
    signalId = await raiseDriftSignal(db, budget, id, reference, drift, driftAmount, totals.revisedBudgetTotal);
  }

  return {
    id,
    reference,
    budgetId: budget.id,
    currency: budget.currency,
    trigger: opts.trigger,
    linesChecked: lines.length,
    updatedLines,
    driftCount: drift.length,
    driftAmount,
    drift,
    totals,
    reconciliation: reconcileTotals(totals),
    applied: { committedCost: applyCommitted, pendingCommitments: applyPending, jobToDateCosts: applyInvoiced || applyPaid, paidToDate: applyPaid },
    skipped,
    components: { committed: committed.component, pendingCommitments: pending.component, invoicedToDate: invoiced.component, paidToDate: paid.component },
    postingsWritten: postings.length,
    signalId,
  };
}

/** One open drift signal per budget — a second run with the same drift is not a second finding. */
async function raiseDriftSignal(
  db: Db,
  budget: BudgetRow,
  reconciliationId: string,
  reference: string,
  drift: DriftRow[],
  driftAmount: number,
  revisedTotal: number,
): Promise<string | null> {
  const open = await db
    .select({ id: signals.id, evidenceRefs: signals.evidenceRefs })
    .from(signals)
    .where(and(eq(signals.companyId, budget.companyId), eq(signals.detector, "budget.cost_drift"), inArray(signals.disposition, ["new", "under_review"])));
  const existing = open.find((s) => {
    const refs = s.evidenceRefs as Record<string, unknown> | null;
    return refs && refs["budgetId"] === budget.id;
  });
  if (existing) return existing.id;
  const share = revisedTotal > 0 ? driftAmount / revisedTotal : 1;
  const id = newId("sig");
  await db.insert(signals).values({
    id,
    companyId: budget.companyId,
    projectId: budget.projectId,
    detector: "budget.cost_drift",
    severity: share >= 0.1 ? "high" : share >= 0.02 ? "medium" : "low",
    confidence: 0.95,
    title: `Budget ${budget.reference}: ${drift.length} stored cost figure(s) drifted from source by ${driftAmount.toFixed(2)} ${budget.currency}`,
    explanation:
      `The scheduled reconciliation ${reference} rebuilt the cost-side columns of ${budget.reference} from the commitments, invoicing and payments tables and found ${drift.length} line/column pair(s) whose stored value disagreed with the rebuilt value (Σ|Δ| ${driftAmount.toFixed(2)} ${budget.currency}). The stored figures were corrected and the previous values recorded on the reconciliation. Drift on a reconciled budget means a writer bypassed the posting path — review who wrote those columns.`,
    evidenceRefs: { budgetId: budget.id, reconciliationId, reference, drift: drift.slice(0, 50) },
    disposition: "new",
  });
  return id;
}

function lineAmounts(l: LineRow) {
  return {
    originalBudget: l.originalBudget,
    budgetModifications: l.budgetModifications,
    approvedChanges: l.approvedChanges,
    pendingBudgetChanges: l.pendingBudgetChanges,
    committedCost: l.committedCost,
    pendingCommitments: l.pendingCommitments,
    directCosts: l.directCosts,
    jobToDateCosts: l.jobToDateCosts,
    percentComplete: l.percentComplete,
    quantity: l.quantity,
    unitRate: l.unitRate,
  };
}

/* ------------------------------------------------------------------ */
/* Drill-down: where a line's numbers come from                        */
/* ------------------------------------------------------------------ */

export interface ComponentExplanation {
  component: BudgetPostingComponent;
  stored: number;
  /** what the sources say right now; null when the sources are unknown */
  value: number | null;
  drift: number | null;
  rows: SourceRowOut[];
  reasons: string[];
  basis: string;
}

/**
 * Per stored column, the rows that compose it — read LIVE from the source
 * tables, so the drawer shows what the platform holds now and names the
 * exact rows that disagree with the stored figure.
 */
export async function explainLine(db: Db, budget: BudgetRow, line: LineRow): Promise<{ components: ComponentExplanation[]; lastReconciliation: { id: string; reference: string; createdAt: string; driftCount: number } | null }> {
  const [committed, pending, invoiced, paid, changes, forecasts, lastRun] = await Promise.all([
    readCommitmentSources(db, budget, "committed"),
    readCommitmentSources(db, budget, "pending"),
    readInvoicedSources(db, budget),
    readPaidSources(db, budget),
    db.select().from(budgetChanges).where(and(eq(budgetChanges.budgetId, budget.id), inArray(budgetChanges.status, ["approved", "pending_approval"]))),
    db.select().from(budgetForecasts).where(and(eq(budgetForecasts.lineItemId, line.id), inArray(budgetForecasts.status, ["approved", "submitted", "draft"]))),
    db.select({ id: budgetReconciliations.id, reference: budgetReconciliations.reference, createdAt: budgetReconciliations.createdAt, driftCount: budgetReconciliations.driftCount }).from(budgetReconciliations).where(eq(budgetReconciliations.budgetId, budget.id)).orderBy(sql`${budgetReconciliations.createdAt} desc`).limit(1),
  ]);
  const legRows = (status: "approved" | "pending_approval"): SourceRowOut[] =>
    changes
      .filter((c) => c.status === status)
      .flatMap((c) => {
        const legs = (c.lines as Array<Record<string, unknown>>).filter((leg) => leg["lineItemId"] === line.id && typeof leg["amount"] === "number");
        return legs.map((leg) => ({
          sourceType: "budget_change" as const,
          sourceId: c.id,
          reference: c.reference,
          description: `${c.title} (${c.kind})`,
          status: c.status,
          currency: budget.currency,
          amount: round2(leg["amount"] as number),
          excluded: null,
          detail: { kind: c.kind, effectiveDate: c.effectiveDate, approvedBy: c.approvedBy, requestedBy: c.requestedBy, sourceType: c.sourceType, sourceId: c.sourceId },
        }));
      });
  const sum = (rows: SourceRowOut[]): number => round2(rows.filter((r) => !r.excluded).reduce((s, r) => s + r.amount, 0));
  const from = (component: BudgetPostingComponent, stored: number, src: SourceComponent, basis: string): ComponentExplanation => {
    const rows = src.rowsByLine.get(line.id) ?? [];
    const value = src.component.value === null ? null : (src.byLine.get(line.id) ?? 0);
    return { component, stored: round2(stored), value, drift: value === null ? null : round2(value - stored), rows, reasons: src.component.value === null ? src.component.reasons : [], basis };
  };
  const invoicedC = from("invoicedToDate", 0, invoiced, "Latest approved subcontractor invoice per commitment SOV line (cumulative to date) plus approved non-SOV invoice lines.");
  const paidC = from("paidToDate", 0, paid, "Commitment payment allocations the payments module posted to this line.");
  const jtd = computeJobToDate({ invoicedToDate: invoiced.component.value === null ? null : (invoiced.byLine.get(line.id) ?? 0), paidToDate: paid.byLine.get(line.id) ?? 0, directCosts: line.directCosts });
  const modificationRows = legRows("approved").filter((r) => r.detail["kind"] !== "owner_change");
  const ownerRows = legRows("approved").filter((r) => r.detail["kind"] === "owner_change");
  const pendingLegRows = legRows("pending_approval");
  const forecastRows: SourceRowOut[] = forecasts.map((f) => ({ sourceType: "budget_forecast" as const, sourceId: f.id, reference: f.reference, description: `${f.method} forecast as at ${f.asOfDate}`, status: f.status, currency: budget.currency, amount: f.forecastToComplete, excluded: null, detail: { method: f.method, forecastFinal: f.forecastFinal, approvedBy: f.approvedBy, createdBy: f.createdBy } }));
  const approvedForecast = forecasts.find((f) => f.status === "approved");
  const components: ComponentExplanation[] = [
    from("committedCost", line.committedCost, committed, "Σ revised scheduled value of approved/complete commitment SOV lines bound to this line."),
    from("pendingCommitments", line.pendingCommitments, pending, "Σ revised scheduled value of draft / out-for-signature commitment SOV lines bound to this line."),
    invoicedC,
    paidC,
    {
      component: "directCosts",
      stored: round2(line.directCosts),
      value: round2(line.directCosts),
      drift: 0,
      rows: [
        ...(paid.rowsByLine.get(line.id) ?? []),
        ...(jtd.nonCommitmentDirectCosts > 0
          ? [{ sourceType: "unattributed" as const, sourceId: "direct-cost-remainder", reference: "—", description: "Direct cost posted without a source stamp (labour, equipment, expenses)", status: null, currency: budget.currency, amount: jtd.nonCommitmentDirectCosts, excluded: null, detail: {} }]
          : []),
      ],
      reasons: [],
      basis: "The stored direct-cost column. Commitment payments inside it are identified above; the remainder came from a writer with no source stamp.",
    },
    {
      component: "jobToDateCosts",
      stored: round2(line.jobToDateCosts),
      value: invoiced.component.value === null && paid.component.value === null ? null : jtd.jobToDateCosts,
      drift: invoiced.component.value === null && paid.component.value === null ? null : round2(jtd.jobToDateCosts - line.jobToDateCosts),
      rows: [],
      reasons: invoiced.component.value === null && paid.component.value === null ? [...invoiced.component.reasons, ...paid.component.reasons] : [],
      basis: jtd.basis,
    },
    { component: "budgetModifications", stored: round2(line.budgetModifications), value: sum(modificationRows), drift: round2(sum(modificationRows) - line.budgetModifications), rows: modificationRows, reasons: [], basis: "Σ approved transfer / draw / adjustment legs on this line." },
    { component: "approvedChanges", stored: round2(line.approvedChanges), value: sum(ownerRows), drift: round2(sum(ownerRows) - line.approvedChanges), rows: ownerRows, reasons: [], basis: "Σ approved owner_change legs on this line, each behind an executed prime contract change order." },
    { component: "pendingBudgetChanges", stored: round2(line.pendingBudgetChanges), value: sum(pendingLegRows), drift: round2(sum(pendingLegRows) - line.pendingBudgetChanges), rows: pendingLegRows, reasons: [], basis: "Σ legs of budget changes awaiting approval — exposure, deliberately outside the revised budget." },
    { component: "forecastToComplete", stored: round2(line.forecastToComplete), value: approvedForecast ? round2(approvedForecast.forecastToComplete) : null, drift: approvedForecast ? round2(approvedForecast.forecastToComplete - line.forecastToComplete) : null, rows: forecastRows, reasons: approvedForecast ? [] : [`No approved forecast record; the stored figure is derived by the line's own method (${line.forecastMethod}).`], basis: "The approved forecast record for this line, when one exists; otherwise the line's forecast method over its current inputs." },
  ];
  const last = lastRun[0];
  return { components, lastReconciliation: last ? { id: last.id, reference: last.reference, createdAt: last.createdAt, driftCount: last.driftCount } : null };
}
