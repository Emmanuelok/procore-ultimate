import type { FastifyPluginAsync } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { invoiceLineApprovals, invoiceLineItems, invoices } from "@constructos/db";
import { INVOICE_LINE_APPROVAL_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import type { Db } from "../../lib/db.js";
import {
  CENT,
  assertSegregation,
  formatMoney,
  ledger,
  nonNegativeMoneySchema,
  nowIso,
  requireInvoicingLevel,
  round2,
} from "./shared.js";

/**
 * LINE-LEVEL INVOICE APPROVAL (spec #573).
 *
 * A reviewer decides each G703 row: approved as billed, reduced to a figure,
 * or rejected (certified at zero). The decisions are stored per line with
 * the reviewer's name and note, and the invoice's approval reads the
 * certified figure FROM them — so a reduction is recorded on the line it was
 * made on, with its reason, rather than as one number on the cover sheet
 * nobody can trace.
 *
 * Decisions are only taken on a submitted / under-review invoice, by someone
 * who is neither its author nor its submitter (ADR 0004), and are cleared
 * when the invoice goes back for revision (its lines may change).
 */

const decisionSchema = z.object({
  status: z.enum(INVOICE_LINE_APPROVAL_STATUSES),
  /** required for `reduced`; ignored for approved (= billed) and rejected (= 0) */
  approvedAmount: nonNegativeMoneySchema.optional(),
  note: z.string().max(4000).nullable().optional(),
});

const bulkSchema = z.object({
  decisions: z
    .array(decisionSchema.extend({ lineId: z.string().min(1).max(64) }))
    .min(1)
    .max(1000),
});

export async function lineApprovalSummary(db: Db, invoiceId: string) {
  const [lines, decisions] = await Promise.all([
    db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoiceId)),
    db.select().from(invoiceLineApprovals).where(eq(invoiceLineApprovals.invoiceId, invoiceId)),
  ]);
  const byLine = new Map(decisions.map((d) => [d.invoiceLineItemId, d]));
  const billed = round2(lines.reduce((s, l) => s + l.amount, 0));
  const certified = round2(
    lines.reduce((s, l) => {
      const d = byLine.get(l.id);
      return s + (d ? Math.min(l.amount, d.approvedAmount) : l.amount);
    }, 0),
  );
  return {
    lines: lines.length,
    reviewed: decisions.length,
    unreviewed: lines.length - decisions.length,
    approved: decisions.filter((d) => d.status === "approved").length,
    reduced: decisions.filter((d) => d.status === "reduced").length,
    rejected: decisions.filter((d) => d.status === "rejected").length,
    billed,
    certified,
    reduction: round2(billed - certified),
    decisions,
  };
}

export const lineApprovalRoutes: FastifyPluginAsync = async (app) => {
  const companyGate = [app.authenticate, app.requireCompany];

  async function loadInvoice(invoiceId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Invoice not found");
    return rows[0];
  }

  function resolveAmount(line: { amount: number; lineNumber: string }, d: z.infer<typeof decisionSchema>): number {
    if (d.status === "approved") return round2(line.amount);
    if (d.status === "rejected") return 0;
    if (d.approvedAmount === undefined) {
      throw badRequest(`Line ${line.lineNumber}: a reduced line needs approvedAmount.`);
    }
    if (d.approvedAmount - line.amount > CENT) {
      throw badRequest(
        `Line ${line.lineNumber}: approved ${formatMoney(d.approvedAmount)} exceeds the ${formatMoney(line.amount)} billed. ` +
          "A reviewer may certify less than was asked for, never more.",
      );
    }
    if (!(d.note ?? "").trim()) {
      throw badRequest(`Line ${line.lineNumber}: a reduction needs a note saying why.`);
    }
    return round2(d.approvedAmount);
  }

  app.get("/invoices/:invoiceId/line-approvals", { preHandler: companyGate }, async (req, reply) => {
    const { invoiceId } = req.params as { invoiceId: string };
    const inv = await loadInvoice(invoiceId, req.companyId!);
    await requireInvoicingLevel(app, req, reply, inv.projectId, "read");
    return { invoiceId, status: inv.status, currency: inv.currency, ...(await lineApprovalSummary(app.db, invoiceId)) };
  });

  /** Decide one or many lines. Re-deciding a line replaces the earlier decision. */
  app.put("/invoices/:invoiceId/line-approvals", { preHandler: companyGate }, async (req, reply) => {
    const { invoiceId } = req.params as { invoiceId: string };
    const body = bulkSchema.parse(req.body);
    const inv = await loadInvoice(invoiceId, req.companyId!);
    await requireInvoicingLevel(app, req, reply, inv.projectId, "standard");
    if (inv.status !== "submitted" && inv.status !== "under_review") {
      throw conflict(`Invoice ${inv.reference} is ${inv.status}; lines are reviewed on a submitted or under-review invoice.`);
    }
    assertSegregation(req.user!.id, { createdBy: inv.createdBy, submittedBy: inv.submittedBy }, "invoice");
    const lineIds = [...new Set(body.decisions.map((d) => d.lineId))];
    const lines = await app.db
      .select()
      .from(invoiceLineItems)
      .where(and(eq(invoiceLineItems.invoiceId, invoiceId), inArray(invoiceLineItems.id, lineIds)));
    const byId = new Map(lines.map((l) => [l.id, l]));
    const missing = lineIds.filter((id) => !byId.has(id));
    if (missing.length > 0) throw badRequest(`Lines not on ${inv.reference}: ${missing.join(", ")}`);
    const now = nowIso();
    await app.db.transaction(async (tx) => {
      for (const d of body.decisions) {
        const line = byId.get(d.lineId)!;
        const approvedAmount = resolveAmount(line, d);
        await tx.delete(invoiceLineApprovals).where(eq(invoiceLineApprovals.invoiceLineItemId, line.id));
        await tx.insert(invoiceLineApprovals).values({
          id: newId("ila"),
          companyId: inv.companyId,
          projectId: inv.projectId,
          invoiceId,
          invoiceLineItemId: line.id,
          status: d.status,
          approvedAmount,
          billedAmount: round2(line.amount),
          note: d.note ?? null,
          reviewedBy: req.user!.id,
          reviewedAt: now,
        });
      }
      if (inv.status === "submitted") {
        await tx
          .update(invoices)
          .set({ status: "under_review", reviewedBy: req.user!.id, reviewedAt: now, updatedAt: now })
          .where(and(eq(invoices.id, invoiceId), eq(invoices.status, "submitted")));
      }
    });
    const summary = await lineApprovalSummary(app.db, invoiceId);
    await ledger(app.db, req, "update", "invoice", invoiceId, {
      lineApprovals: body.decisions.map((d) => ({ lineId: d.lineId, status: d.status })),
      certified: summary.certified,
      reduction: summary.reduction,
    }, inv.projectId, true);
    return { invoiceId, ...summary };
  });

  app.delete("/invoices/:invoiceId/line-approvals/:lineId", { preHandler: companyGate }, async (req, reply) => {
    const { invoiceId, lineId } = req.params as { invoiceId: string; lineId: string };
    const inv = await loadInvoice(invoiceId, req.companyId!);
    await requireInvoicingLevel(app, req, reply, inv.projectId, "standard");
    if (inv.status !== "submitted" && inv.status !== "under_review") {
      throw conflict(`Invoice ${inv.reference} is ${inv.status}; its line decisions are fixed.`);
    }
    await app.db
      .delete(invoiceLineApprovals)
      .where(and(eq(invoiceLineApprovals.invoiceId, invoiceId), eq(invoiceLineApprovals.invoiceLineItemId, lineId)));
    await ledger(app.db, req, "update", "invoice", invoiceId, { lineApprovalCleared: lineId }, inv.projectId);
    return reply.status(204).send();
  });
};

/** Called when an invoice goes back for revision: its lines may change, so the decisions are void. */
export async function clearLineApprovals(db: Db, invoiceId: string): Promise<void> {
  await db.delete(invoiceLineApprovals).where(eq(invoiceLineApprovals.invoiceId, invoiceId));
}
