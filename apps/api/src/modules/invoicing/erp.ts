import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import { commitmentPayments, commitments, invoiceLineItems, invoices, vendors } from "@constructos/db";
import { certifiedOf, isoDateSchema, outstandingOf, round2 } from "./shared.js";

/**
 * ERP EXPORT (spec #582) — accounts-payable and accounts-receivable batches
 * in the dialects the common finance systems import.
 *
 * Three formats, one dataset: approved/paid invoices with their continuation
 * sheet lines (cost code, cost type, budget line) and the payments issued
 * against them, filtered by date window and kind. `generic` is a flat CSV
 * with every column; `sage` (Sage 300 CRE AP import layout), `quickbooks`
 * (Bill import) and `viewpoint` (Vista AP unapproved invoice) rename and
 * order the columns to what those importers expect. The mapping is code —
 * every column is named, nothing is inferred — and a figure the register does
 * not hold is an empty cell, never a zero.
 *
 * Per currency: an export is one currency, because a batch that mixes them
 * is an import error in every one of those systems.
 */

export interface ErpInvoiceLine {
  invoiceReference: string;
  invoiceNumber: string | null;
  kind: string;
  status: string;
  vendorId: string | null;
  vendorName: string | null;
  vendorTaxId: string | null;
  commitmentReference: string | null;
  billingDate: string | null;
  dueDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  currency: string;
  lineNumber: string;
  description: string;
  costCode: string | null;
  costType: string | null;
  budgetLineItemId: string | null;
  lineAmount: number;
  lineRetainage: number;
  invoiceCertified: number;
  invoiceRetainage: number;
  invoicePaid: number;
  invoiceOutstanding: number;
}

export interface ErpPaymentRow {
  paymentReference: string;
  invoiceReference: string | null;
  vendorId: string | null;
  vendorName: string | null;
  commitmentReference: string | null;
  status: string;
  method: string;
  paymentDate: string | null;
  checkNumber: string | null;
  transactionReference: string | null;
  currency: string;
  amount: number;
  retainageReleased: number;
  discountTaken: number;
}

export type ErpFormat = "generic" | "sage" | "quickbooks" | "viewpoint";

/** Column maps per dialect: output header → source key. Order matters to importers. */
export const INVOICE_COLUMN_MAPS: Record<ErpFormat, Array<[string, keyof ErpInvoiceLine]>> = {
  generic: [
    ["invoice_reference", "invoiceReference"], ["invoice_number", "invoiceNumber"], ["kind", "kind"], ["status", "status"],
    ["vendor_id", "vendorId"], ["vendor_name", "vendorName"], ["vendor_tax_id", "vendorTaxId"], ["commitment", "commitmentReference"],
    ["billing_date", "billingDate"], ["due_date", "dueDate"], ["period_start", "periodStart"], ["period_end", "periodEnd"],
    ["currency", "currency"], ["line", "lineNumber"], ["description", "description"], ["cost_code", "costCode"], ["cost_type", "costType"],
    ["budget_line_id", "budgetLineItemId"], ["line_amount", "lineAmount"], ["line_retainage", "lineRetainage"],
    ["invoice_certified", "invoiceCertified"], ["invoice_retainage", "invoiceRetainage"], ["invoice_paid", "invoicePaid"], ["invoice_outstanding", "invoiceOutstanding"],
  ],
  sage: [
    ["Vendor", "vendorId"], ["Vendor Name", "vendorName"], ["Invoice", "invoiceNumber"], ["Invoice Date", "billingDate"], ["Due Date", "dueDate"],
    ["Job", "commitmentReference"], ["Cost Code", "costCode"], ["Category", "costType"], ["Description", "description"],
    ["Amount", "lineAmount"], ["Retainage", "lineRetainage"], ["Currency", "currency"], ["Reference", "invoiceReference"],
  ],
  quickbooks: [
    ["Vendor", "vendorName"], ["RefNumber", "invoiceNumber"], ["TxnDate", "billingDate"], ["DueDate", "dueDate"],
    ["Account", "costCode"], ["Class", "costType"], ["Memo", "description"], ["Amount", "lineAmount"], ["Currency", "currency"], ["Memo2", "invoiceReference"],
  ],
  viewpoint: [
    ["VendorGroup", "vendorId"], ["Vendor", "vendorName"], ["APRef", "invoiceNumber"], ["InvDate", "billingDate"], ["DueDate", "dueDate"],
    ["Job", "commitmentReference"], ["Phase", "costCode"], ["CostType", "costType"], ["Description", "description"],
    ["GrossAmt", "lineAmount"], ["Retainage", "lineRetainage"], ["Currency", "currency"], ["Source", "invoiceReference"],
  ],
};

export const PAYMENT_COLUMN_MAPS: Record<ErpFormat, Array<[string, keyof ErpPaymentRow]>> = {
  generic: [
    ["payment_reference", "paymentReference"], ["invoice_reference", "invoiceReference"], ["vendor_id", "vendorId"], ["vendor_name", "vendorName"],
    ["commitment", "commitmentReference"], ["status", "status"], ["method", "method"], ["payment_date", "paymentDate"], ["check_number", "checkNumber"],
    ["transaction_reference", "transactionReference"], ["currency", "currency"], ["amount", "amount"], ["retainage_released", "retainageReleased"], ["discount_taken", "discountTaken"],
  ],
  sage: [["Vendor", "vendorId"], ["Invoice", "invoiceReference"], ["Check", "checkNumber"], ["Check Date", "paymentDate"], ["Amount", "amount"], ["Discount", "discountTaken"], ["Currency", "currency"], ["Reference", "paymentReference"]],
  quickbooks: [["Vendor", "vendorName"], ["RefNumber", "checkNumber"], ["TxnDate", "paymentDate"], ["Amount", "amount"], ["Memo", "paymentReference"], ["Currency", "currency"]],
  viewpoint: [["Vendor", "vendorId"], ["APRef", "invoiceReference"], ["CheckNo", "checkNumber"], ["CheckDate", "paymentDate"], ["Amount", "amount"], ["Currency", "currency"], ["Source", "paymentReference"]],
};

const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? String(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Pure: rows → CSV through a column map. */
export function toCsv<T extends object>(rows: readonly T[], map: ReadonlyArray<[string, keyof T]>): string {
  const header = map.map(([h]) => csvCell(h)).join(",");
  const body = rows.map((r) => map.map(([, key]) => csvCell(r[key])).join(","));
  return [header, ...body].join("\n") + "\n";
}

const query = z.object({
  format: z.enum(["generic", "sage", "quickbooks", "viewpoint"]).default("generic"),
  output: z.enum(["json", "csv"]).default("json"),
  currency: z.string().min(3).max(8).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  kind: z.enum(["owner_billing", "subcontractor_invoice"]).optional(),
  /** include draft/submitted invoices too (default: approved and paid only) */
  includeUnapproved: z.coerce.boolean().optional(),
});

export const erpRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("invoicing", "read")];

  app.get("/projects/:projectId/invoicing/erp-export", { preHandler: readGate }, async (req, reply) => {
    const q = query.parse(req.query ?? {});
    const projectId = req.projectId!;
    const companyId = req.companyId!;
    const clauses = [eq(invoices.companyId, companyId), eq(invoices.projectId, projectId)];
    if (!q.includeUnapproved) clauses.push(inArray(invoices.status, ["approved", "approved_as_noted", "paid"]));
    if (q.kind) clauses.push(eq(invoices.kind, q.kind));
    if (q.from) clauses.push(gte(invoices.billingDate, q.from));
    if (q.to) clauses.push(lte(invoices.billingDate, q.to));
    const invoiceRows = await app.db.select().from(invoices).where(and(...clauses)).orderBy(asc(invoices.billingDate), asc(invoices.number));
    const currencies = [...new Set(invoiceRows.map((i) => i.currency.toUpperCase()))].sort();
    const currency = q.currency?.toUpperCase() ?? (currencies.length === 1 ? currencies[0] : null);
    if (!currency) {
      return {
        format: q.format,
        currency: null,
        currencies,
        invoices: [],
        payments: [],
        reasons: [
          currencies.length === 0
            ? "No invoices match the window, so there is nothing to export."
            : `The window holds invoices in ${currencies.join(", ")}; an ERP batch is one currency — pass ?currency=.`,
        ],
      };
    }
    const selected = invoiceRows.filter((i) => i.currency.toUpperCase() === currency);
    const invoiceIds = selected.map((i) => i.id);
    const [lines, payments, vendorRows, commitmentRows] = await Promise.all([
      invoiceIds.length ? app.db.select().from(invoiceLineItems).where(inArray(invoiceLineItems.invoiceId, invoiceIds)).orderBy(asc(invoiceLineItems.sortOrder)) : [],
      invoiceIds.length
        ? app.db
            .select()
            .from(commitmentPayments)
            .where(and(inArray(commitmentPayments.invoiceId, invoiceIds), inArray(commitmentPayments.status, ["issued", "cleared"])))
            .orderBy(asc(commitmentPayments.paymentDate))
        : [],
      app.db.select({ id: vendors.id, name: vendors.name, taxId: vendors.taxId }).from(vendors).where(eq(vendors.companyId, companyId)),
      app.db.select({ id: commitments.id, reference: commitments.reference }).from(commitments).where(eq(commitments.projectId, projectId)),
    ]);
    const vendorById = new Map(vendorRows.map((v) => [v.id, v]));
    const commitmentRef = new Map(commitmentRows.map((c) => [c.id, c.reference]));
    const invoiceById = new Map(selected.map((i) => [i.id, i]));

    const invoiceLines: ErpInvoiceLine[] = [];
    for (const l of lines) {
      const inv = invoiceById.get(l.invoiceId);
      if (!inv) continue;
      const vendor = inv.vendorId ? vendorById.get(inv.vendorId) : undefined;
      invoiceLines.push({
        invoiceReference: inv.reference,
        invoiceNumber: inv.invoiceNumber,
        kind: inv.kind,
        status: inv.status,
        vendorId: inv.vendorId,
        vendorName: vendor?.name ?? null,
        vendorTaxId: vendor?.taxId ?? null,
        commitmentReference: inv.commitmentId ? (commitmentRef.get(inv.commitmentId) ?? null) : null,
        billingDate: inv.billingDate,
        dueDate: inv.dueDate,
        periodStart: inv.periodStart,
        periodEnd: inv.periodEnd,
        currency: inv.currency,
        lineNumber: l.lineNumber,
        description: l.description,
        costCode: l.costCode,
        costType: l.costType,
        budgetLineItemId: l.budgetLineItemId,
        lineAmount: round2(l.amount),
        lineRetainage: round2(l.retainageThisPeriod),
        invoiceCertified: certifiedOf(inv),
        invoiceRetainage: round2(inv.totalRetainage),
        invoicePaid: round2(inv.amountPaid),
        invoiceOutstanding: outstandingOf(inv),
      });
    }
    const paymentRows: ErpPaymentRow[] = payments.map((p) => {
      const inv = p.invoiceId ? invoiceById.get(p.invoiceId) : undefined;
      const vendor = p.vendorId ? vendorById.get(p.vendorId) : undefined;
      return {
        paymentReference: p.reference,
        invoiceReference: inv?.reference ?? null,
        vendorId: p.vendorId,
        vendorName: vendor?.name ?? null,
        commitmentReference: commitmentRef.get(p.commitmentId) ?? null,
        status: p.status,
        method: p.method,
        paymentDate: p.paymentDate,
        checkNumber: p.checkNumber,
        transactionReference: p.transactionReference,
        currency: p.currency,
        amount: round2(p.amount),
        retainageReleased: round2(p.retainageReleasedAmount),
        discountTaken: round2(p.discountTaken),
      };
    });

    if (q.output === "csv") {
      const csv =
        `# invoices (${q.format}, ${currency})\n` +
        toCsv(invoiceLines, INVOICE_COLUMN_MAPS[q.format]) +
        `# payments (${q.format}, ${currency})\n` +
        toCsv(paymentRows, PAYMENT_COLUMN_MAPS[q.format]);
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="erp-${q.format}-${projectId}-${currency}.csv"`);
      return reply.send(csv);
    }
    return {
      format: q.format,
      currency,
      currencies,
      window: { from: q.from ?? null, to: q.to ?? null },
      invoiceCount: selected.length,
      lineCount: invoiceLines.length,
      paymentCount: paymentRows.length,
      totals: {
        certified: round2(selected.reduce((s, i) => s + certifiedOf(i), 0)),
        paid: round2(selected.reduce((s, i) => s + i.amountPaid, 0)),
        outstanding: round2(selected.reduce((s, i) => s + outstandingOf(i), 0)),
      },
      columns: { invoices: INVOICE_COLUMN_MAPS[q.format].map(([h]) => h), payments: PAYMENT_COLUMN_MAPS[q.format].map(([h]) => h) },
      invoices: invoiceLines,
      payments: paymentRows,
      reasons: currencies.length > 1 ? [`Other currencies in the window were excluded: ${currencies.filter((c) => c !== currency).join(", ")}.`] : [],
    };
  });
};
