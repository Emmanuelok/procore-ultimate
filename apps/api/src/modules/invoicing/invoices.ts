import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import {
  commitmentSovLines,
  commitments,
  invoiceLineItems,
  invoices,
  paymentApplications,
  primeContractSovLines,
  primeContracts,
} from "@constructos/db";
import {
  INVOICE_KINDS,
  INVOICE_LINE_SOURCES,
  INVOICE_STATUSES,
  SOV_BILLING_METHODS,
  type InvoiceKind,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import {
  computeCoverSheet,
  computeLine,
  reconcileInvoice,
  type CoverSheetLine,
  type LineBasis,
  type LineInput,
  type LineIssue,
} from "./arithmetic.js";
import { assertPeriodAcceptsBilling } from "./periods.js";
import {
  APPROVED_INVOICE_STATUSES,
  CENT,
  DEAD_INVOICE_STATUSES,
  addDays,
  assertSegregation,
  detailSchema,
  formatMoney,
  invoiceCounterKey,
  invoiceReference,
  isApprovedInvoice,
  isOpenInvoice,
  isoDateSchema,
  ledger,
  moneySchema,
  nonNegativeMoneySchema,
  nowIso,
  percentSchema,
  reasonSchema,
  requireInvoicingLevel,
  round2,
  todayIso,
} from "./shared.js";

export type InvoiceRow = typeof invoices.$inferSelect;
export type InvoiceLineRow = typeof invoiceLineItems.$inferSelect;

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const invoiceCreateSchema = z
  .object({
    kind: z.enum(INVOICE_KINDS),
    primeContractId: z.string().min(1).max(64).optional(),
    commitmentId: z.string().min(1).max(64).optional(),
    billingPeriodId: z.string().min(1).max(64).nullable().optional(),
    /** the VENDOR's own printed number; `reference` is ours */
    invoiceNumber: z.string().max(100).nullable().optional(),
    title: z.string().max(300).nullable().optional(),
    billingDate: isoDateSchema.optional(),
    periodStart: isoDateSchema.nullable().optional(),
    periodEnd: isoDateSchema.nullable().optional(),
    dueDate: isoDateSchema.nullable().optional(),
    receivedDate: isoDateSchema.nullable().optional(),
    /** overrides the SOV line rates on the generated lines */
    retainagePercent: percentSchema.optional(),
    requiresLienWaiver: z.boolean().optional(),
    /** false leaves the continuation sheet empty for a hand-built invoice */
    generateLines: z.boolean().optional(),
    detail: detailSchema.optional(),
  })
  .strict();

const invoicePatchSchema = z.object({
  title: z.string().max(300).nullable().optional(),
  invoiceNumber: z.string().max(100).nullable().optional(),
  billingDate: isoDateSchema.optional(),
  periodStart: isoDateSchema.nullable().optional(),
  periodEnd: isoDateSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  receivedDate: isoDateSchema.nullable().optional(),
  requiresLienWaiver: z.boolean().optional(),
  detail: detailSchema.optional(),
});

const invoiceListQuery = pageQuerySchema.extend({
  kind: z.enum(INVOICE_KINDS).optional(),
  status: z.enum(INVOICE_STATUSES).optional(),
  billingPeriodId: z.string().optional(),
  commitmentId: z.string().optional(),
  primeContractId: z.string().optional(),
  vendorId: z.string().optional(),
  unpaidOnly: z.coerce.boolean().optional(),
});

const billingLineSchema = z
  .object({
    lineId: z.string().min(1).max(64).optional(),
    sovLineId: z.string().min(1).max(64).optional(),
    lineNumber: z.string().min(1).max(50).optional(),
    thisPeriodWork: moneySchema.optional(),
    percentComplete: percentSchema.optional(),
    completedToDate: moneySchema.optional(),
    thisPeriodStoredMaterials: moneySchema.optional(),
    materialsPresentlyStored: nonNegativeMoneySchema.optional(),
    retainageReleased: nonNegativeMoneySchema.optional(),
    creditReason: z.string().max(2000).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .refine(
    (l) => Boolean(l.lineId ?? l.sovLineId ?? l.lineNumber),
    "Identify the line by lineId, sovLineId or lineNumber",
  );

const putLinesSchema = z.object({
  lines: z.array(billingLineSchema).min(1).max(1000),
});

const manualLineSchema = z.object({
  lineNumber: z.string().min(1).max(50),
  description: z.string().min(1).max(1000),
  source: z.enum(INVOICE_LINE_SOURCES).default("other"),
  billingMethod: z.enum(SOV_BILLING_METHODS).default("lump_sum"),
  costCode: z.string().max(100).nullable().optional(),
  costType: z.string().max(50).nullable().optional(),
  budgetLineItemId: z.string().max(64).nullable().optional(),
  unit: z.string().max(20).nullable().optional(),
  quantity: moneySchema.nullable().optional(),
  unitRate: moneySchema.nullable().optional(),
  scheduledValue: moneySchema,
  thisPeriodWork: moneySchema.optional(),
  retainagePercent: percentSchema.optional(),
  taxPercent: percentSchema.nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const submitSchema = z.object({
  invoiceNumber: z.string().max(100).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

const reviewSchema = z.object({ reviewNotes: z.string().max(4000).nullable().optional() });

const approveSchema = z.object({
  /** certified for less than applied for — requires reviewNotes saying why */
  asNoted: z.boolean().optional(),
  approvedAmount: nonNegativeMoneySchema.optional(),
  reviewNotes: z.string().max(4000).nullable().optional(),
});

/* ------------------------------------------------------------------ */
/* Contract-side context                                               */
/* ------------------------------------------------------------------ */

/**
 * Everything the two invoice kinds share, resolved from whichever table
 * actually holds it. Owner billing reads the prime contract; a subcontractor
 * invoice reads the commitment. The arithmetic below is identical for both
 * because it IS identical — only the counterparty changes.
 */
export interface ContractContext {
  kind: InvoiceKind;
  id: string;
  reference: string;
  projectId: string;
  currency: string;
  executed: number;
  originalSum: number;
  approvedChangeSum: number;
  revisedSum: number;
  defaultRetainagePercent: number;
  vendorId: string | null;
  paymentTermsDays: number | null;
  requiresLienWaiver: boolean;
  paymentHold: boolean;
  complianceHoldReason: string | null;
  /** what a contract of this kind is called in a refusal message */
  noun: string;
}

export async function loadContext(
  db: Db,
  kind: InvoiceKind,
  contractId: string,
  companyId: string,
  projectId: string,
): Promise<ContractContext> {
  if (kind === "owner_billing") {
    const rows = await db
      .select()
      .from(primeContracts)
      .where(
        and(
          eq(primeContracts.id, contractId),
          eq(primeContracts.companyId, companyId),
          eq(primeContracts.projectId, projectId),
        ),
      )
      .limit(1);
    const c = rows[0];
    if (!c) throw badRequest("primeContractId does not reference a prime contract on this project");
    return {
      kind,
      id: c.id,
      reference: c.reference,
      projectId: c.projectId,
      currency: c.currency,
      executed: c.executed,
      originalSum: c.originalContractSum,
      approvedChangeSum: c.approvedChangeSum,
      revisedSum: c.revisedContractSum,
      defaultRetainagePercent: c.defaultRetainagePercent,
      vendorId: c.ownerVendorId,
      paymentTermsDays: c.paymentTermsDays,
      requiresLienWaiver: false,
      paymentHold: false,
      complianceHoldReason: null,
      noun: "prime contract",
    };
  }
  const rows = await db
    .select()
    .from(commitments)
    .where(
      and(
        eq(commitments.id, contractId),
        eq(commitments.companyId, companyId),
        eq(commitments.projectId, projectId),
      ),
    )
    .limit(1);
  const c = rows[0];
  if (!c) throw badRequest("commitmentId does not reference a commitment on this project");
  return {
    kind,
    id: c.id,
    reference: c.reference,
    projectId: c.projectId,
    currency: c.currency,
    executed: c.executed,
    originalSum: c.originalCommitmentSum,
    approvedChangeSum: c.approvedChangeSum,
    revisedSum: c.revisedCommitmentSum,
    defaultRetainagePercent: c.defaultRetainagePercent,
    vendorId: c.vendorId,
    paymentTermsDays: c.paymentTermsDays,
    requiresLienWaiver: c.requiresLienWaiver === 1,
    paymentHold: c.paymentHold === 1,
    complianceHoldReason: c.complianceHoldReason,
    noun: c.kind === "purchase_order" ? "purchase order" : "subcontract",
  };
}

export function contractIdOf(inv: InvoiceRow): string {
  const id = inv.kind === "owner_billing" ? inv.primeContractId : inv.commitmentId;
  if (!id) {
    throw new Error(`invoice ${inv.id} of kind ${inv.kind} has no contract reference`);
  }
  return id;
}

export async function fetchInvoice(
  db: Db,
  invoiceId: string,
  companyId: string,
): Promise<InvoiceRow> {
  const rows = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.companyId, companyId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("Invoice not found");
  return row;
}

export async function invoiceLines(db: Db, invoiceId: string): Promise<InvoiceLineRow[]> {
  return db
    .select()
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, invoiceId))
    .orderBy(asc(invoiceLineItems.sortOrder), asc(invoiceLineItems.lineNumber));
}

/**
 * "Less previous certificates for payment" — Σ of what earlier live invoices
 * on this same contract already asked for. Derived from stored rows, and
 * SNAPSHOTTED onto the invoice at creation so a later correction upstream
 * cannot rewrite what this application said on the day it was sworn.
 *
 * Only invoices in the same currency are summed; a foreign-currency sibling
 * is counted in `excluded` and reported, never converted.
 */
export async function previousPaymentsFor(
  db: Db,
  kind: InvoiceKind,
  contractId: string,
  currency: string,
  excludeInvoiceId?: string,
): Promise<{ amount: number; excluded: number }> {
  const where =
    kind === "owner_billing"
      ? eq(invoices.primeContractId, contractId)
      : eq(invoices.commitmentId, contractId);
  const rows = await db
    .select({
      id: invoices.id,
      kind: invoices.kind,
      status: invoices.status,
      currency: invoices.currency,
      currentPaymentDue: invoices.currentPaymentDue,
    })
    .from(invoices)
    .where(and(where, eq(invoices.kind, kind)));
  const live = rows.filter(
    (r) =>
      r.id !== excludeInvoiceId &&
      r.status !== "draft" &&
      !(DEAD_INVOICE_STATUSES as readonly string[]).includes(r.status),
  );
  const same = live.filter((r) => r.currency.toUpperCase() === currency.toUpperCase());
  return {
    amount: round2(same.reduce((s, r) => s + r.currentPaymentDue, 0)),
    excluded: live.length - same.length,
  };
}

/* ------------------------------------------------------------------ */
/* Recompute                                                           */
/* ------------------------------------------------------------------ */

/** Re-derive the G702 cover sheet from the invoice's stored lines. */
export async function recomputeInvoice(db: Db, invoiceId: string): Promise<InvoiceRow> {
  const rows = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  const inv = rows[0];
  if (!inv) throw notFound("Invoice not found");
  const lines = await invoiceLines(db, invoiceId);
  const cover = computeCoverSheet(lines as unknown as CoverSheetLine[], {
    originalContractSum: inv.originalContractSum,
    netChangeOrders: inv.netChangeOrders,
    previousPaymentsAmount: inv.previousPaymentsAmount,
  });
  await db
    .update(invoices)
    .set({ ...cover, updatedAt: nowIso() })
    .where(eq(invoices.id, invoiceId));
  const refreshed = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  return refreshed[0]!;
}

/* ------------------------------------------------------------------ */
/* SOV roll-forward                                                    */
/* ------------------------------------------------------------------ */

/**
 * APPROVAL IS WHAT MOVES THE SCHEDULE OF VALUES. This period becomes
 * previous, stored materials carry over, retainage held moves, and the
 * contract's billed position is re-derived from the lines afterwards.
 *
 * Idempotent by stamp: `detail.sovPostedAt` on the invoice records that this
 * invoice has already rolled the SOV forward, so a retry — or the same
 * invoice reaching approval down two different routes — cannot bill the same
 * work twice. An increment that runs twice is undetectable afterwards; a
 * stamp that has already been set is not.
 */
export async function postInvoiceToSov(db: Db, inv: InvoiceRow): Promise<{ posted: boolean }> {
  const detail = (inv.detail ?? {}) as Record<string, unknown>;
  if (typeof detail["sovPostedAt"] === "string") return { posted: false };
  const lines = await invoiceLines(db, inv.id);
  const contractId = contractIdOf(inv);
  const now = nowIso();

  if (inv.kind === "owner_billing") {
    const sov = await db
      .select()
      .from(primeContractSovLines)
      .where(eq(primeContractSovLines.primeContractId, contractId));
    const byId = new Map(sov.map((s) => [s.id, s]));
    for (const line of lines) {
      const s = line.primeContractSovLineId ? byId.get(line.primeContractSovLineId) : undefined;
      if (!s) continue;
      const released = round2(s.retainageReleased + line.retainageReleased);
      await db
        .update(primeContractSovLines)
        .set({
          previousBilled: round2(line.previousBilled + line.thisPeriodWork),
          previousStoredMaterials: line.materialsPresentlyStored,
          thisPeriodWork: line.thisPeriodWork,
          thisPeriodStoredMaterials: line.thisPeriodStoredMaterials,
          materialsPresentlyStored: line.materialsPresentlyStored,
          totalCompletedAndStored: line.totalCompletedAndStored,
          percentComplete: line.percentComplete,
          balanceToFinish: line.balanceToFinish,
          retainageHeld: round2(
            (line.retainagePercent / 100) * line.totalCompletedAndStored - released,
          ),
          retainageReleased: released,
          updatedAt: now,
        })
        .where(eq(primeContractSovLines.id, s.id));
    }
    await recomputePrimeBilling(db, contractId);
  } else {
    const sov = await db
      .select()
      .from(commitmentSovLines)
      .where(eq(commitmentSovLines.commitmentId, contractId));
    const byId = new Map(sov.map((s) => [s.id, s]));
    for (const line of lines) {
      const s = line.commitmentSovLineId ? byId.get(line.commitmentSovLineId) : undefined;
      if (!s) continue;
      const released = round2(s.retainageReleased + line.retainageReleased);
      await db
        .update(commitmentSovLines)
        .set({
          previousBilled: round2(line.previousBilled + line.thisPeriodWork),
          previousStoredMaterials: line.materialsPresentlyStored,
          thisPeriodWork: line.thisPeriodWork,
          thisPeriodStoredMaterials: line.thisPeriodStoredMaterials,
          materialsPresentlyStored: line.materialsPresentlyStored,
          totalCompletedAndStored: line.totalCompletedAndStored,
          percentComplete: line.percentComplete,
          balanceToFinish: line.balanceToFinish,
          retainageHeld: round2(
            (line.retainagePercent / 100) * line.totalCompletedAndStored - released,
          ),
          retainageReleased: released,
          updatedAt: now,
        })
        .where(eq(commitmentSovLines.id, s.id));
    }
    await recomputeCommitmentBilling(db, contractId);
  }

  await db
    .update(invoices)
    .set({ detail: { ...detail, sovPostedAt: now }, updatedAt: now })
    .where(eq(invoices.id, inv.id));
  return { posted: true };
}

/**
 * `commitments.totalInvoiced` and the retainage columns, DERIVED from the
 * schedule of values rather than incremented. The commitments module
 * deliberately leaves `totalInvoiced` alone — invoices are this module's
 * write — so this is the one place it is set.
 */
export async function recomputeCommitmentBilling(db: Db, commitmentId: string): Promise<void> {
  const [sov, rows] = await Promise.all([
    db
      .select({
        totalCompletedAndStored: commitmentSovLines.totalCompletedAndStored,
        retainageHeld: commitmentSovLines.retainageHeld,
        retainageReleased: commitmentSovLines.retainageReleased,
      })
      .from(commitmentSovLines)
      .where(eq(commitmentSovLines.commitmentId, commitmentId)),
    db.select().from(commitments).where(eq(commitments.id, commitmentId)).limit(1),
  ]);
  const c = rows[0];
  if (!c) return;
  const totalInvoiced = round2(sov.reduce((s, l) => s + l.totalCompletedAndStored, 0));
  await db
    .update(commitments)
    .set({
      totalInvoiced,
      retainageHeld: round2(sov.reduce((s, l) => s + l.retainageHeld, 0)),
      retainageReleased: round2(sov.reduce((s, l) => s + l.retainageReleased, 0)),
      balanceToFinish: round2(c.revisedCommitmentSum - totalInvoiced),
      totalsCalculatedAt: nowIso(),
      updatedAt: nowIso(),
    })
    .where(eq(commitments.id, commitmentId));
}

/** The same, for the sell side: `prime_contracts.total_billed`. */
export async function recomputePrimeBilling(db: Db, primeContractId: string): Promise<void> {
  const [sov, rows] = await Promise.all([
    db
      .select({
        totalCompletedAndStored: primeContractSovLines.totalCompletedAndStored,
        retainageHeld: primeContractSovLines.retainageHeld,
        retainageReleased: primeContractSovLines.retainageReleased,
      })
      .from(primeContractSovLines)
      .where(eq(primeContractSovLines.primeContractId, primeContractId)),
    db.select().from(primeContracts).where(eq(primeContracts.id, primeContractId)).limit(1),
  ]);
  const c = rows[0];
  if (!c) return;
  const totalBilled = round2(sov.reduce((s, l) => s + l.totalCompletedAndStored, 0));
  await db
    .update(primeContracts)
    .set({
      totalBilled,
      retainageHeld: round2(sov.reduce((s, l) => s + l.retainageHeld, 0)),
      retainageReleased: round2(sov.reduce((s, l) => s + l.retainageReleased, 0)),
      balanceToFinish: round2(c.revisedContractSum - totalBilled),
      totalsCalculatedAt: nowIso(),
      updatedAt: nowIso(),
    })
    .where(eq(primeContracts.id, primeContractId));
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/**
 * INVOICES — billing in both directions off the same schedule of values.
 *
 * `kind = "owner_billing"` is our application to the owner against a prime
 * contract; `kind = "subcontractor_invoice"` is a sub billing us against a
 * commitment. One table, one arithmetic (the AIA G702/G703 identities in
 * ./arithmetic.ts), two workflows that differ only in who signs.
 *
 * Three refusals define this file, and each names the exact figure:
 *   - billing past a line's scheduled value, over by X
 *   - a line whose percent complete regresses without a stated credit reason
 *   - billing into a closed or locked billing period
 */
export const invoiceRoutes: FastifyPluginAsync = async (app) => {
  const companyGate = [app.authenticate, app.requireCompany];
  const readGate = [...companyGate, app.requireTool("invoicing", "read")];
  const standardGate = [...companyGate, app.requireTool("invoicing", "standard")];

  async function loadForWrite(
    req: FastifyRequest,
    reply: Parameters<typeof requireInvoicingLevel>[2],
    invoiceId: string,
    level: "read" | "standard" | "admin",
  ): Promise<InvoiceRow> {
    const inv = await fetchInvoice(app.db, invoiceId, req.companyId!);
    await requireInvoicingLevel(app, req, reply, inv.projectId, level);
    return inv;
  }

  function assertEditable(inv: InvoiceRow): void {
    if (!isOpenInvoice(inv.status)) {
      throw conflict(
        `Invoice ${inv.reference} is ${inv.status} — its figures are frozen. An approved ` +
          "invoice is a legal document and must say tomorrow what it said today; correct it " +
          "with a credit on the next application.",
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Create                                                            */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/invoices", { preHandler: standardGate }, async (req, reply) => {
    const body = invoiceCreateSchema.parse(req.body);
    const projectId = req.projectId!;
    const companyId = req.companyId!;

    // Point the wrong contract at a kind and the mismatch is named first — it
    // is a more useful refusal than "you forgot a field" when the caller has
    // in fact supplied one, just the wrong one.
    if (body.kind === "owner_billing" && body.commitmentId) {
      throw badRequest(
        "An owner billing bills a prime contract, not a commitment. Raise a subcontractor " +
          "invoice against the commitment instead.",
      );
    }
    if (body.kind === "subcontractor_invoice" && body.primeContractId) {
      throw badRequest(
        "A subcontractor invoice bills a commitment. The prime contract it ultimately rolls up " +
          "to is taken from the commitment itself.",
      );
    }
    const contractId =
      body.kind === "owner_billing" ? body.primeContractId : body.commitmentId;
    if (!contractId) {
      throw badRequest(
        body.kind === "owner_billing"
          ? "An owner billing needs a primeContractId — it bills the prime contract's SOV."
          : "A subcontractor invoice needs a commitmentId — it bills the commitment's SOV.",
      );
    }

    const ctx = await loadContext(app.db, body.kind, contractId, companyId, projectId);
    if (ctx.executed !== 1) {
      throw conflict(
        `${ctx.reference} is not executed. Nothing may be billed against an unsigned ` +
          `${ctx.noun} — execute it first.`,
      );
    }

    const period = await assertPeriodAcceptsBilling(
      app.db,
      body.billingPeriodId,
      projectId,
      companyId,
      "raising an invoice",
    );

    // One live invoice per contract per period. Two open applications for the
    // same month against the same contract is how the same work gets paid
    // twice, and no accounts payable clerk can be expected to catch it.
    const where =
      body.kind === "owner_billing"
        ? eq(invoices.primeContractId, contractId)
        : eq(invoices.commitmentId, contractId);
    if (body.billingPeriodId) {
      const dupe = await app.db
        .select({ reference: invoices.reference, status: invoices.status })
        .from(invoices)
        .where(
          and(
            where,
            eq(invoices.kind, body.kind),
            eq(invoices.billingPeriodId, body.billingPeriodId),
            ne(invoices.status, "void"),
            ne(invoices.status, "rejected"),
          ),
        )
        .limit(1);
      if (dupe[0]) {
        throw conflict(
          `${dupe[0].reference} already bills ${ctx.reference} for that billing period ` +
            `(status ${dupe[0].status}) — one invoice per contract per period.`,
        );
      }
    }
    const open = await app.db
      .select({ reference: invoices.reference, status: invoices.status })
      .from(invoices)
      .where(
        and(
          where,
          eq(invoices.kind, body.kind),
          inArray(invoices.status, ["draft", "submitted", "under_review", "revise_and_resubmit"]),
        ),
      )
      .limit(1);
    if (open[0]) {
      throw conflict(
        `${open[0].reference} is still open against ${ctx.reference} (status ` +
          `${open[0].status}). Settle it before starting the next invoice — a schedule of ` +
          "values cannot be billed twice concurrently without double-billing the same work.",
      );
    }

    const billingDate = body.billingDate ?? period?.billingDate ?? todayIso();
    // Payment terms on the contract are the more specific fact and win over
    // the period's own due date; the period is the fallback for a contract
    // that names no terms at all.
    const dueDate =
      body.dueDate ??
      (ctx.paymentTermsDays != null ? addDays(billingDate, ctx.paymentTermsDays) : null) ??
      period?.dueDate ??
      null;
    const previous = await previousPaymentsFor(app.db, body.kind, contractId, ctx.currency);

    const number = await nextRecordNumber(app.db, projectId, invoiceCounterKey(body.kind));
    const id = newId("inv");
    const now = nowIso();
    await app.db.insert(invoices).values({
      id,
      companyId,
      projectId,
      kind: body.kind,
      number,
      reference: invoiceReference(body.kind, number),
      title: body.title ?? `${ctx.reference} — ${period?.name ?? billingDate}`,
      status: "draft",
      primeContractId: body.kind === "owner_billing" ? contractId : null,
      commitmentId: body.kind === "subcontractor_invoice" ? contractId : null,
      vendorId: ctx.vendorId,
      billingPeriodId: body.billingPeriodId ?? null,
      invoiceNumber: body.invoiceNumber ?? null,
      currency: ctx.currency,
      billingDate,
      periodStart: body.periodStart ?? period?.startDate ?? null,
      periodEnd: body.periodEnd ?? period?.endDate ?? null,
      dueDate,
      receivedDate: body.receivedDate ?? null,
      originalContractSum: ctx.originalSum,
      netChangeOrders: ctx.approvedChangeSum,
      revisedContractSum: ctx.revisedSum,
      previousPaymentsAmount: previous.amount,
      requiresLienWaiver: (body.requiresLienWaiver ?? ctx.requiresLienWaiver) ? 1 : 0,
      lienWaiverStatus: null,
      detail: {
        ...(body.detail ?? {}),
        previousPaymentsExcludedForeignInvoices: previous.excluded,
      },
      createdBy: req.user!.id,
      updatedAt: now,
    });

    let generated = 0;
    if (body.generateLines !== false) {
      generated = await generateLinesFromSov(id, ctx, body.retainagePercent);
    }
    const inv = await recomputeInvoice(app.db, id);
    await ledger(app.db, req, "create", "invoice", id, {
      kind: inv.kind,
      reference: inv.reference,
      contract: ctx.reference,
      currency: inv.currency,
      billingPeriodId: inv.billingPeriodId,
      lineCount: generated,
      previousPaymentsAmount: inv.previousPaymentsAmount,
    }, projectId);
    return reply.status(201).send({ ...inv, lines: await invoiceLines(app.db, id) });
  });

  /**
   * Seed the continuation sheet from the schedule of values, snapshotting
   * each line's previously-billed position. Lines are copied, not joined:
   * an executed change order landing next week must not retroactively change
   * what this invoice's G703 says.
   */
  async function generateLinesFromSov(
    invoiceId: string,
    ctx: ContractContext,
    retainageOverride?: number,
  ): Promise<number> {
    const now = nowIso();
    if (ctx.kind === "owner_billing") {
      const sov = await app.db
        .select()
        .from(primeContractSovLines)
        .where(eq(primeContractSovLines.primeContractId, ctx.id))
        .orderBy(asc(primeContractSovLines.sortOrder), asc(primeContractSovLines.lineNumber));
      for (const [i, s] of sov.entries()) {
        await app.db.insert(invoiceLineItems).values({
          id: newId("ivl"),
          companyId: s.companyId,
          projectId: s.projectId,
          invoiceId,
          lineNumber: s.lineNumber,
          sortOrder: s.sortOrder || i,
          primeContractSovLineId: s.id,
          costCodeId: s.costCodeId,
          costCode: s.costCode,
          costType: s.costType,
          budgetLineItemId: s.budgetLineItemId,
          description: s.description,
          source: s.isChangeOrderLine === 1 ? "change_order" : "contract_sov",
          billingMethod: s.billingMethod,
          unit: s.unit,
          quantity: s.quantity,
          unitRate: s.unitRate,
          changeOrderPackageId: s.changeOrderPackageId,
          scheduledValue: round2(s.scheduledValue + s.changeOrderValue),
          previousBilled: s.previousBilled,
          previousStoredMaterials: s.previousStoredMaterials,
          materialsPresentlyStored: s.previousStoredMaterials,
          totalCompletedAndStored: round2(s.previousBilled + s.previousStoredMaterials),
          percentComplete: s.percentComplete,
          balanceToFinish: round2(
            s.scheduledValue + s.changeOrderValue - s.previousBilled - s.previousStoredMaterials,
          ),
          retainagePercent: retainageOverride ?? s.retainagePercent,
          retainageHeldToDate: round2(
            ((retainageOverride ?? s.retainagePercent) / 100) *
              (s.previousBilled + s.previousStoredMaterials),
          ),
          updatedAt: now,
        });
      }
      return sov.length;
    }
    const sov = await app.db
      .select()
      .from(commitmentSovLines)
      .where(eq(commitmentSovLines.commitmentId, ctx.id))
      .orderBy(asc(commitmentSovLines.sortOrder), asc(commitmentSovLines.lineNumber));
    for (const [i, s] of sov.entries()) {
      await app.db.insert(invoiceLineItems).values({
        id: newId("ivl"),
        companyId: s.companyId,
        projectId: s.projectId,
        invoiceId,
        lineNumber: s.lineNumber,
        sortOrder: s.sortOrder || i,
        commitmentSovLineId: s.id,
        costCodeId: s.costCodeId,
        costCode: s.costCode,
        costType: s.costType,
        budgetLineItemId: s.budgetLineItemId,
        description: s.description,
        source: s.isChangeOrderLine === 1 ? "change_order" : "contract_sov",
        billingMethod: s.billingMethod,
        unit: s.unit,
        quantity: s.quantity,
        unitRate: s.unitRate,
        changeOrderPackageId: s.changeOrderPackageId,
        scheduledValue: round2(s.scheduledValue + s.changeOrderValue),
        previousBilled: s.previousBilled,
        previousStoredMaterials: s.previousStoredMaterials,
        materialsPresentlyStored: s.previousStoredMaterials,
        totalCompletedAndStored: round2(s.previousBilled + s.previousStoredMaterials),
        percentComplete: s.percentComplete,
        balanceToFinish: round2(
          s.scheduledValue + s.changeOrderValue - s.previousBilled - s.previousStoredMaterials,
        ),
        retainagePercent: retainageOverride ?? s.retainagePercent,
        retainageHeldToDate: round2(
          ((retainageOverride ?? s.retainagePercent) / 100) *
            (s.previousBilled + s.previousStoredMaterials),
        ),
        taxPercent: s.taxable === 1 ? s.taxPercent : null,
        updatedAt: now,
      });
    }
    return sov.length;
  }

  /* ---------------------------------------------------------------- */
  /* Read                                                              */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/invoices", { preHandler: readGate }, async (req) => {
    const q = invoiceListQuery.parse(req.query);
    const clauses = [eq(invoices.projectId, req.projectId!)];
    if (q.kind) clauses.push(eq(invoices.kind, q.kind));
    if (q.status) clauses.push(eq(invoices.status, q.status));
    if (q.billingPeriodId) clauses.push(eq(invoices.billingPeriodId, q.billingPeriodId));
    if (q.commitmentId) clauses.push(eq(invoices.commitmentId, q.commitmentId));
    if (q.primeContractId) clauses.push(eq(invoices.primeContractId, q.primeContractId));
    if (q.vendorId) clauses.push(eq(invoices.vendorId, q.vendorId));
    if (q.unpaidOnly) {
      clauses.push(inArray(invoices.status, [...APPROVED_INVOICE_STATUSES]));
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(invoices).where(where);
    const items = await app.db
      .select()
      .from(invoices)
      .where(where)
      .orderBy(desc(invoices.billingDate), desc(invoices.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const filtered = q.unpaidOnly
      ? items.filter((i) => i.currentPaymentDue - i.amountPaid > CENT)
      : items;
    return paginate(filtered, Number(totalRow?.n ?? 0), q);
  });

  app.get("/invoices/:invoiceId", { preHandler: companyGate }, async (req, reply) => {
    const { invoiceId } = req.params as { invoiceId: string };
    const inv = await loadForWrite(req, reply, invoiceId, "read");
    const lines = await invoiceLines(app.db, invoiceId);
    return {
      ...inv,
      lines,
      reconciliation: reconcileInvoice(inv),
      outstanding: round2(inv.currentPaymentDue - inv.amountPaid),
    };
  });

  /** Every G702 identity checked against the stored columns of this invoice. */
  app.get("/invoices/:invoiceId/reconciliation", { preHandler: companyGate }, async (req, reply) => {
    const { invoiceId } = req.params as { invoiceId: string };
    const inv = await loadForWrite(req, reply, invoiceId, "read");
    const lines = await invoiceLines(app.db, invoiceId);
    const lineChecks = lines.map((l) => ({
      lineNumber: l.lineNumber,
      totalCompletedAndStored: l.totalCompletedAndStored,
      derived: round2(l.previousBilled + l.thisPeriodWork + l.materialsPresentlyStored),
      ok:
        Math.abs(
          l.totalCompletedAndStored -
            round2(l.previousBilled + l.thisPeriodWork + l.materialsPresentlyStored),
        ) <= CENT,
    }));
    const cover = reconcileInvoice(inv);
    return {
      invoiceId,
      reference: inv.reference,
      currency: inv.currency,
      ...cover,
      lines: lineChecks,
      reconciles: cover.reconciles && lineChecks.every((l) => l.ok),
    };
  });

  app.patch("/invoices/:invoiceId", { preHandler: companyGate }, async (req, reply) => {
    const { invoiceId } = req.params as { invoiceId: string };
    const body = invoicePatchSchema.parse(req.body);
    const inv = await loadForWrite(req, reply, invoiceId, "standard");
    assertEditable(inv);
    await app.db
      .update(invoices)
      .set({
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.invoiceNumber !== undefined ? { invoiceNumber: body.invoiceNumber } : {}),
        ...(body.billingDate !== undefined ? { billingDate: body.billingDate } : {}),
        ...(body.periodStart !== undefined ? { periodStart: body.periodStart } : {}),
        ...(body.periodEnd !== undefined ? { periodEnd: body.periodEnd } : {}),
        ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
        ...(body.receivedDate !== undefined ? { receivedDate: body.receivedDate } : {}),
        ...(body.requiresLienWaiver !== undefined
          ? { requiresLienWaiver: body.requiresLienWaiver ? 1 : 0 }
          : {}),
        ...(body.detail !== undefined
          ? { detail: { ...(inv.detail as Record<string, unknown>), ...body.detail } }
          : {}),
        updatedAt: nowIso(),
      })
      .where(eq(invoices.id, invoiceId));
    const row = await fetchInvoice(app.db, invoiceId, req.companyId!);
    await ledger(app.db, req, "update", "invoice", invoiceId, body, inv.projectId);
    return row;
  });

  /* ---------------------------------------------------------------- */
  /* Continuation sheet                                                */
  /* ---------------------------------------------------------------- */

  app.get("/invoices/:invoiceId/lines", { preHandler: companyGate }, async (req, reply) => {
    const { invoiceId } = req.params as { invoiceId: string };
    const inv = await loadForWrite(req, reply, invoiceId, "read");
    return { invoiceId, currency: inv.currency, lines: await invoiceLines(app.db, invoiceId) };
  });

  /**
   * BILLING ENTRY. The one write that decides what a period is worth.
   *
   * Every line is computed by ./arithmetic.ts and every refusal it earns is
   * collected before anything is written, so one request names ALL the
   * problems — a biller fixing a 40-line G703 one refusal per round trip is
   * a biller who stops using the system.
   */
  app.put("/invoices/:invoiceId/lines", { preHandler: companyGate }, async (req, reply) => {
    const { invoiceId } = req.params as { invoiceId: string };
    const body = putLinesSchema.parse(req.body);
    const inv = await loadForWrite(req, reply, invoiceId, "standard");
    assertEditable(inv);
    await assertPeriodAcceptsBilling(
      app.db,
      inv.billingPeriodId,
      inv.projectId,
      req.companyId!,
      "billing",
    );

    const existing = await invoiceLines(app.db, invoiceId);
    const byLineId = new Map(existing.map((l) => [l.id, l]));
    const bySovId = new Map(
      existing.map((l) => [l.primeContractSovLineId ?? l.commitmentSovLineId ?? "", l]),
    );
    const byNumber = new Map(existing.map((l) => [l.lineNumber, l]));

    const issues: LineIssue[] = [];
    const updates: Array<{ row: InvoiceLineRow; computed: ReturnType<typeof computeLine> }> = [];
    const seen = new Set<string>();

    for (const input of body.lines) {
      const row =
        (input.lineId ? byLineId.get(input.lineId) : undefined) ??
        (input.sovLineId ? bySovId.get(input.sovLineId) : undefined) ??
        (input.lineNumber ? byNumber.get(input.lineNumber) : undefined);
      if (!row) {
        throw badRequest(
          `No line on invoice ${inv.reference} matches ` +
            `${input.lineId ?? input.sovLineId ?? input.lineNumber}`,
        );
      }
      if (seen.has(row.id)) {
        throw badRequest(
          `Line ${row.lineNumber} appears twice in this request — send one entry per line.`,
        );
      }
      seen.add(row.id);
      const basis: LineBasis = {
        lineNumber: row.lineNumber,
        description: row.description,
        scheduledValue: row.scheduledValue,
        previousBilled: row.previousBilled,
        previousStoredMaterials: row.previousStoredMaterials,
        retainagePercent: row.retainagePercent,
        taxPercent: row.taxPercent,
      };
      const lineInput: LineInput = {
        thisPeriodWork: input.thisPeriodWork,
        percentComplete: input.percentComplete,
        completedToDate: input.completedToDate,
        thisPeriodStoredMaterials: input.thisPeriodStoredMaterials,
        materialsPresentlyStored: input.materialsPresentlyStored,
        retainageReleased: input.retainageReleased,
        creditReason: input.creditReason,
      };
      const result = computeLine(basis, lineInput);
      issues.push(...result.issues);
      updates.push({ row, computed: result });
    }

    if (issues.length > 0) {
      throw badRequest(
        issues.length === 1
          ? issues[0]!.message
          : `${issues.length} lines were refused: ${issues.map((i) => i.message).join(" ")}`,
        { issues },
      );
    }

    // Contract-level over-billing: a G703 whose lines each fit but whose total
    // exceeds the revised contract sum is still an over-billing.
    const untouched = existing.filter((l) => !seen.has(l.id));
    const projectedTotal = round2(
      updates.reduce((s, u) => s + u.computed.computed.totalCompletedAndStored, 0) +
        untouched.reduce((s, l) => s + l.totalCompletedAndStored, 0),
    );
    if (projectedTotal - inv.revisedContractSum > CENT) {
      throw badRequest(
        `This billing totals ${formatMoney(projectedTotal)} ${inv.currency} against a revised ` +
          `contract sum of ${formatMoney(inv.revisedContractSum)} ${inv.currency} — over by ` +
          `${formatMoney(round2(projectedTotal - inv.revisedContractSum))}.`,
        {
          issues: [
            {
              lineNumber: "*",
              code: "over_billed",
              message: "Invoice total exceeds the revised contract sum",
              detail: {
                revisedContractSum: inv.revisedContractSum,
                totalCompletedAndStored: projectedTotal,
                overage: round2(projectedTotal - inv.revisedContractSum),
              },
            },
          ],
        },
      );
    }

    const now = nowIso();
    for (const [i, u] of updates.entries()) {
      const c = u.computed.computed;
      const input = body.lines[i]!;
      await app.db
        .update(invoiceLineItems)
        .set({
          thisPeriodWork: c.thisPeriodWork,
          thisPeriodStoredMaterials: c.thisPeriodStoredMaterials,
          materialsPresentlyStored: c.materialsPresentlyStored,
          totalCompletedAndStored: c.totalCompletedAndStored,
          percentComplete: c.percentComplete,
          balanceToFinish: c.balanceToFinish,
          retainageThisPeriod: c.retainageThisPeriod,
          retainageHeldToDate: c.retainageHeldToDate,
          retainageReleased: c.retainageReleased,
          amount: c.amount,
          taxAmount: c.taxAmount,
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.creditReason
            ? {
                detail: {
                  ...(u.row.detail as Record<string, unknown>),
                  creditReason: input.creditReason,
                },
              }
            : {}),
          updatedAt: now,
        })
        .where(eq(invoiceLineItems.id, u.row.id));
    }

    const updated = await recomputeInvoice(app.db, invoiceId);
    await ledger(app.db, req, "update", "invoice", invoiceId, {
      action: "billing_entry",
      lines: updates.length,
      totalCompletedAndStored: updated.totalCompletedAndStored,
      totalRetainage: updated.totalRetainage,
      currentPaymentDue: updated.currentPaymentDue,
    }, inv.projectId);
    return { ...updated, lines: await invoiceLines(app.db, invoiceId) };
  });

  /**
   * A line with no SOV behind it — a tax line, a credit, a retainage release
   * shown on the face of the invoice. `source` must NOT be one of the
   * SOV-backed sources, because those must point at the line they bill.
   */
  app.post("/invoices/:invoiceId/lines", { preHandler: companyGate }, async (req, reply) => {
    const { invoiceId } = req.params as { invoiceId: string };
    const body = manualLineSchema.parse(req.body);
    const inv = await loadForWrite(req, reply, invoiceId, "standard");
    assertEditable(inv);
    if (body.source === "contract_sov" || body.source === "change_order") {
      throw badRequest(
        `A "${body.source}" line must bill a schedule-of-values line. Generate the continuation ` +
          "sheet from the SOV instead of typing this line by hand.",
      );
    }
    const clash = await app.db
      .select({ id: invoiceLineItems.id })
      .from(invoiceLineItems)
      .where(
        and(
          eq(invoiceLineItems.invoiceId, invoiceId),
          eq(invoiceLineItems.lineNumber, body.lineNumber),
        ),
      )
      .limit(1);
    if (clash[0]) throw conflict(`Line ${body.lineNumber} already exists on ${inv.reference}`);

    const basis: LineBasis = {
      lineNumber: body.lineNumber,
      description: body.description,
      scheduledValue: body.scheduledValue,
      previousBilled: 0,
      previousStoredMaterials: 0,
      retainagePercent: body.retainagePercent ?? 0,
      taxPercent: body.taxPercent ?? null,
    };
    const result = computeLine(basis, { thisPeriodWork: body.thisPeriodWork ?? 0 });
    if (result.issues.length > 0) {
      throw badRequest(result.issues[0]!.message, { issues: result.issues });
    }
    const c = result.computed;
    const [maxSort] = await app.db
      .select({ n: count() })
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoiceId));
    const id = newId("ivl");
    await app.db.insert(invoiceLineItems).values({
      id,
      companyId: inv.companyId,
      projectId: inv.projectId,
      invoiceId,
      lineNumber: body.lineNumber,
      sortOrder: Number(maxSort?.n ?? 0) + 1000,
      costCode: body.costCode ?? null,
      costType: body.costType ?? null,
      budgetLineItemId: body.budgetLineItemId ?? null,
      description: body.description,
      source: body.source,
      billingMethod: body.billingMethod,
      unit: body.unit ?? null,
      quantity: body.quantity ?? null,
      unitRate: body.unitRate ?? null,
      scheduledValue: round2(body.scheduledValue),
      retainagePercent: body.retainagePercent ?? 0,
      taxPercent: body.taxPercent ?? null,
      thisPeriodWork: c.thisPeriodWork,
      materialsPresentlyStored: c.materialsPresentlyStored,
      totalCompletedAndStored: c.totalCompletedAndStored,
      percentComplete: c.percentComplete,
      balanceToFinish: c.balanceToFinish,
      retainageThisPeriod: c.retainageThisPeriod,
      retainageHeldToDate: c.retainageHeldToDate,
      amount: c.amount,
      taxAmount: c.taxAmount,
      notes: body.notes ?? null,
      updatedAt: nowIso(),
    });
    const updated = await recomputeInvoice(app.db, invoiceId);
    await ledger(app.db, req, "create", "invoice_line_item", id, {
      invoiceId,
      lineNumber: body.lineNumber,
      source: body.source,
      amount: c.amount,
    }, inv.projectId);
    return reply.status(201).send({ ...updated, lines: await invoiceLines(app.db, invoiceId) });
  });

  app.delete("/invoices/:invoiceId/lines/:lineId", { preHandler: companyGate }, async (req, reply) => {
    const { invoiceId, lineId } = req.params as { invoiceId: string; lineId: string };
    const inv = await loadForWrite(req, reply, invoiceId, "standard");
    assertEditable(inv);
    const rows = await app.db
      .select()
      .from(invoiceLineItems)
      .where(and(eq(invoiceLineItems.id, lineId), eq(invoiceLineItems.invoiceId, invoiceId)))
      .limit(1);
    if (!rows[0]) throw notFound("Invoice line not found");
    await app.db.delete(invoiceLineItems).where(eq(invoiceLineItems.id, lineId));
    const updated = await recomputeInvoice(app.db, invoiceId);
    await ledger(app.db, req, "delete", "invoice_line_item", lineId, {
      invoiceId,
      lineNumber: rows[0].lineNumber,
    }, inv.projectId);
    return updated;
  });

  /* ---------------------------------------------------------------- */
  /* Workflow                                                          */
  /* ---------------------------------------------------------------- */

  app.post("/invoices/:invoiceId/submit", { preHandler: companyGate }, async (req, reply) => {
    const { invoiceId } = req.params as { invoiceId: string };
    const body = submitSchema.parse(req.body ?? {});
    const inv = await loadForWrite(req, reply, invoiceId, "standard");
    if (!isOpenInvoice(inv.status)) {
      throw conflict(`Invoice ${inv.reference} is ${inv.status} and cannot be submitted`);
    }
    await assertPeriodAcceptsBilling(
      app.db,
      inv.billingPeriodId,
      inv.projectId,
      req.companyId!,
      "submitting an invoice",
    );
    const lines = await invoiceLines(app.db, invoiceId);
    if (lines.length === 0) {
      throw badRequest(
        `Invoice ${inv.reference} has no lines. An invoice with no continuation sheet asks for ` +
          "money without saying what for.",
      );
    }
    const refreshed = await recomputeInvoice(app.db, invoiceId);
    if (refreshed.currentPaymentDue < -CENT) {
      throw conflict(
        `Invoice ${inv.reference} computes a current payment due of ` +
          `${formatMoney(refreshed.currentPaymentDue)} ${inv.currency} — a negative application ` +
          "is a credit note, not an invoice. Raise it as one.",
      );
    }
    const now = nowIso();
    await app.db
      .update(invoices)
      .set({
        status: "submitted",
        submittedBy: req.user!.id,
        submittedAt: now,
        ...(body.invoiceNumber !== undefined ? { invoiceNumber: body.invoiceNumber } : {}),
        ...(body.notes !== undefined ? { reviewNotes: body.notes } : {}),
        rejectionReason: null,
        updatedAt: now,
      })
      .where(eq(invoices.id, invoiceId));
    await ledger(app.db, req, "state_change", "invoice", invoiceId, {
      from: inv.status,
      to: "submitted",
      totalCompletedAndStored: refreshed.totalCompletedAndStored,
      totalRetainage: refreshed.totalRetainage,
      currentPaymentDue: refreshed.currentPaymentDue,
    }, inv.projectId, true);
    return fetchInvoice(app.db, invoiceId, req.companyId!);
  });

  /**
   * Review is a THIRD act, distinct from submitting and from approving. The
   * reviewer may not be the submitter: the point of a review step is that a
   * second pair of eyes has seen the numbers before the money is released.
   */
  app.post("/invoices/:invoiceId/review", { preHandler: companyGate }, async (req, reply) => {
    const { invoiceId } = req.params as { invoiceId: string };
    const body = reviewSchema.parse(req.body ?? {});
    const inv = await loadForWrite(req, reply, invoiceId, "standard");
    if (inv.status !== "submitted") {
      throw conflict(
        `Invoice ${inv.reference} is ${inv.status} — only a submitted invoice enters review`,
      );
    }
    assertSegregation(req.user!.id, { submittedBy: inv.submittedBy }, "invoice");
    const now = nowIso();
    await app.db
      .update(invoices)
      .set({
        status: "under_review",
        reviewedBy: req.user!.id,
        reviewedAt: now,
        ...(body.reviewNotes !== undefined ? { reviewNotes: body.reviewNotes } : {}),
        updatedAt: now,
      })
      .where(eq(invoices.id, invoiceId));
    await ledger(app.db, req, "state_change", "invoice", invoiceId, {
      from: "submitted",
      to: "under_review",
      reviewNotes: body.reviewNotes ?? null,
    }, inv.projectId);
    return fetchInvoice(app.db, invoiceId, req.companyId!);
  });

  /**
   * APPROVAL. The approver may be neither the author nor the submitter
   * (ADR 0004), the billing period must still accept billing, and approval is
   * what rolls the schedule of values forward.
   */
  app.post("/invoices/:invoiceId/approve", { preHandler: companyGate }, async (req, reply) => {
    const { invoiceId } = req.params as { invoiceId: string };
    const body = approveSchema.parse(req.body ?? {});
    const inv = await loadForWrite(req, reply, invoiceId, "admin");
    if (inv.status !== "submitted" && inv.status !== "under_review") {
      throw conflict(
        `Invoice ${inv.reference} is ${inv.status} — only a submitted or reviewed invoice is ` +
          "approved",
      );
    }
    assertSegregation(
      req.user!.id,
      { createdBy: inv.createdBy, submittedBy: inv.submittedBy },
      "invoice",
    );
    // An owner application whose certification lives on a payment_applications
    // row is certified there, by the certifier named on it. Approving it here
    // would put the same money through two certification paths.
    if (inv.kind === "owner_billing") {
      const appRows = await app.db
        .select({ reference: paymentApplications.reference, status: paymentApplications.status })
        .from(paymentApplications)
        .where(
          and(eq(paymentApplications.invoiceId, invoiceId), ne(paymentApplications.status, "void")),
        )
        .limit(1);
      if (appRows[0]) {
        throw conflict(
          `Owner application ${inv.reference} is certified through payment application ` +
            `${appRows[0].reference} (status ${appRows[0].status}), not approved here. ` +
            "Certification of an application for payment is the certifier's act.",
        );
      }
    }
    await assertPeriodAcceptsBilling(
      app.db,
      inv.billingPeriodId,
      inv.projectId,
      req.companyId!,
      "approving an invoice",
    );
    const asNoted = body.asNoted === true || body.approvedAmount !== undefined;
    if (asNoted && !(body.reviewNotes ?? "").trim()) {
      throw badRequest(
        "Approving as noted certifies a different figure from the one applied for. Say why in " +
          "reviewNotes — an unexplained reduction is a dispute waiting to happen.",
      );
    }
    const refreshed = await recomputeInvoice(app.db, invoiceId);
    if (body.approvedAmount !== undefined && body.approvedAmount - refreshed.currentPaymentDue > CENT) {
      throw badRequest(
        `Approved amount ${formatMoney(body.approvedAmount)} ${inv.currency} exceeds the ` +
          `${formatMoney(refreshed.currentPaymentDue)} ${inv.currency} applied for. An approver ` +
          "may certify less than was asked for, never more.",
      );
    }
    const now = nowIso();
    await app.db
      .update(invoices)
      .set({
        status: asNoted ? "approved_as_noted" : "approved",
        approvedBy: req.user!.id,
        approvedAt: now,
        ...(body.reviewNotes !== undefined ? { reviewNotes: body.reviewNotes } : {}),
        detail: {
          ...(refreshed.detail as Record<string, unknown>),
          ...(body.approvedAmount !== undefined ? { approvedAmount: body.approvedAmount } : {}),
        },
        updatedAt: now,
      })
      .where(eq(invoices.id, invoiceId));
    const approved = await fetchInvoice(app.db, invoiceId, req.companyId!);
    const posted = await postInvoiceToSov(app.db, approved);
    await ledger(app.db, req, "state_change", "invoice", invoiceId, {
      from: inv.status,
      to: approved.status,
      approvedAmount: body.approvedAmount ?? approved.currentPaymentDue,
      totalCompletedAndStored: approved.totalCompletedAndStored,
      totalRetainage: approved.totalRetainage,
      currentPaymentDue: approved.currentPaymentDue,
      sovRolledForward: posted.posted,
    }, inv.projectId, true);
    return { ...(await fetchInvoice(app.db, invoiceId, req.companyId!)), sovRolledForward: posted.posted };
  });

  app.post("/invoices/:invoiceId/reject", { preHandler: companyGate }, async (req, reply) => {
    const { invoiceId } = req.params as { invoiceId: string };
    const body = reasonSchema.parse(req.body);
    const inv = await loadForWrite(req, reply, invoiceId, "standard");
    if (inv.status !== "submitted" && inv.status !== "under_review") {
      throw conflict(
        `Invoice ${inv.reference} is ${inv.status} — only a submitted or reviewed invoice is ` +
          "rejected",
      );
    }
    const now = nowIso();
    await app.db
      .update(invoices)
      .set({ status: "rejected", rejectionReason: body.reason, updatedAt: now })
      .where(eq(invoices.id, invoiceId));
    await ledger(app.db, req, "state_change", "invoice", invoiceId, {
      from: inv.status,
      to: "rejected",
      reason: body.reason,
    }, inv.projectId, true);
    return fetchInvoice(app.db, invoiceId, req.companyId!);
  });

  /** Send it back to be fixed rather than killing it — the common case. */
  app.post("/invoices/:invoiceId/revise", { preHandler: companyGate }, async (req, reply) => {
    const { invoiceId } = req.params as { invoiceId: string };
    const body = reasonSchema.parse(req.body);
    const inv = await loadForWrite(req, reply, invoiceId, "standard");
    if (inv.status !== "submitted" && inv.status !== "under_review") {
      throw conflict(
        `Invoice ${inv.reference} is ${inv.status} — only a submitted or reviewed invoice is ` +
          "sent back for revision",
      );
    }
    const now = nowIso();
    await app.db
      .update(invoices)
      .set({ status: "revise_and_resubmit", reviewNotes: body.reason, updatedAt: now })
      .where(eq(invoices.id, invoiceId));
    await ledger(app.db, req, "state_change", "invoice", invoiceId, {
      from: inv.status,
      to: "revise_and_resubmit",
      reason: body.reason,
    }, inv.projectId, true);
    return fetchInvoice(app.db, invoiceId, req.companyId!);
  });

  app.post("/invoices/:invoiceId/void", { preHandler: companyGate }, async (req, reply) => {
    const { invoiceId } = req.params as { invoiceId: string };
    const body = reasonSchema.parse(req.body);
    const inv = await loadForWrite(req, reply, invoiceId, "admin");
    if (inv.status === "paid" || inv.amountPaid > CENT) {
      throw conflict(
        `Invoice ${inv.reference} has ${formatMoney(inv.amountPaid)} ${inv.currency} paid ` +
          "against it and cannot be voided. Record a credit or a reversal so both movements " +
          "stay on the record.",
      );
    }
    if (isApprovedInvoice(inv.status)) {
      throw conflict(
        `Invoice ${inv.reference} is approved and has rolled the schedule of values forward. ` +
          "Void is not a way out of an approval — raise a credit on the next application.",
      );
    }
    const now = nowIso();
    await app.db
      .update(invoices)
      .set({ status: "void", rejectionReason: body.reason, updatedAt: now })
      .where(eq(invoices.id, invoiceId));
    await ledger(app.db, req, "state_change", "invoice", invoiceId, {
      from: inv.status,
      to: "void",
      reason: body.reason,
    }, inv.projectId, true);
    return fetchInvoice(app.db, invoiceId, req.companyId!);
  });
};
