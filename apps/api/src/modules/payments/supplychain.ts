import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import { commitmentPayments, invoices, supplyChainPaymentReports } from "@constructos/db";
import { SUPPLY_CHAIN_REPORT_REGIMES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import type { Db } from "../../lib/db.js";
import { isoDateSchema } from "../field/dates.js";

/**
 * SUPPLY-CHAIN PAYMENT PRACTICE REPORTING (spec Vol II F #391–393).
 *
 * The UK Reporting on Payment Practices and Performance Regulations 2017 (and
 * the Australian Payment Times Reporting Scheme it resembles) make a large
 * payer publish, per half-year, how quickly it paid its suppliers: the
 * average days to pay, the share paid within 30 / 31–60 / 61+ days, and the
 * share not paid within agreed terms. Here those figures are COMPUTED from
 * the invoice and payment registers rather than typed, per currency, and
 * published as a fact with the rows that made it.
 */

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const DAY = 86_400_000;

export interface PaidInvoiceSample {
  invoiceId: string;
  reference: string;
  currency: string;
  /** invoice received / billing date */
  receivedAt: string;
  paidAt: string;
  dueAt: string | null;
  amount: number;
  daysToPay: number;
  withinTerms: boolean | null;
}

export interface SupplyChainMetrics {
  currency: string;
  invoicesPaid: number;
  invoicesOutstandingAtPeriodEnd: number;
  averageDaysToPay: number | null;
  medianDaysToPay: number | null;
  paidWithin30Pct: number | null;
  paid31To60Pct: number | null;
  paid61PlusPct: number | null;
  /** UK regulation: % of invoices NOT paid within the agreed terms */
  notPaidWithinTermsPct: number | null;
  /** invoices with no due date cannot answer the terms question */
  termsUnknownCount: number;
  amountPaid: number;
  reasons: string[];
}

/** Pure: the regulation's metrics over a sample of paid invoices. */
export function computeMetrics(currency: string, sample: readonly PaidInvoiceSample[], outstanding: number): SupplyChainMetrics {
  const n = sample.length;
  const reasons: string[] = [];
  if (n === 0) reasons.push(`No invoices in ${currency} were paid in the period, so the averages cannot be stated.`);
  const days = sample.map((s) => s.daysToPay).sort((a, b) => a - b);
  const pct = (count: number) => (n === 0 ? null : round1((count / n) * 100));
  const withTerms = sample.filter((s) => s.withinTerms !== null);
  const notWithin = withTerms.filter((s) => s.withinTerms === false).length;
  if (n > 0 && withTerms.length === 0) reasons.push("No paid invoice carried a due date, so 'not paid within agreed terms' cannot be stated.");
  return {
    currency,
    invoicesPaid: n,
    invoicesOutstandingAtPeriodEnd: outstanding,
    averageDaysToPay: n === 0 ? null : round1(days.reduce((s, d) => s + d, 0) / n),
    medianDaysToPay: n === 0 ? null : n % 2 === 1 ? days[(n - 1) / 2]! : round1(((days[n / 2 - 1] ?? 0) + (days[n / 2] ?? 0)) / 2),
    paidWithin30Pct: pct(days.filter((d) => d <= 30).length),
    paid31To60Pct: pct(days.filter((d) => d > 30 && d <= 60).length),
    paid61PlusPct: pct(days.filter((d) => d > 60).length),
    notPaidWithinTermsPct: withTerms.length === 0 ? null : round1((notWithin / withTerms.length) * 100),
    termsUnknownCount: n - withTerms.length,
    amountPaid: round2(sample.reduce((s, x) => s + x.amount, 0)),
    reasons,
  };
}

/** Company-wide sample: subcontractor invoices whose FIRST issued payment falls in the window. */
export async function buildSample(db: Db, companyId: string, periodStart: string, periodEnd: string) {
  const payments = await db
    .select({
      invoiceId: commitmentPayments.invoiceId,
      paymentDate: commitmentPayments.paymentDate,
      issuedAt: commitmentPayments.issuedAt,
      amount: commitmentPayments.amount,
      status: commitmentPayments.status,
    })
    .from(commitmentPayments)
    .where(and(eq(commitmentPayments.companyId, companyId), inArray(commitmentPayments.status, ["issued", "cleared"])));
  const firstPaid = new Map<string, { paidAt: string; amount: number }>();
  for (const p of payments) {
    if (!p.invoiceId) continue;
    const paidAt = p.paymentDate ?? p.issuedAt?.slice(0, 10) ?? null;
    if (!paidAt) continue;
    const prev = firstPaid.get(p.invoiceId);
    if (!prev || paidAt < prev.paidAt) firstPaid.set(p.invoiceId, { paidAt, amount: round2((prev?.amount ?? 0) + p.amount) });
    else prev.amount = round2(prev.amount + p.amount);
  }
  const ids = [...firstPaid.keys()].filter((id) => {
    const f = firstPaid.get(id)!;
    return f.paidAt >= periodStart && f.paidAt <= periodEnd;
  });
  const invRows = ids.length
    ? await db.select().from(invoices).where(and(inArray(invoices.id, ids), eq(invoices.kind, "subcontractor_invoice")))
    : [];
  const sample: PaidInvoiceSample[] = [];
  for (const inv of invRows) {
    const f = firstPaid.get(inv.id)!;
    const receivedAt = inv.receivedDate ?? inv.submittedAt?.slice(0, 10) ?? inv.billingDate;
    if (!receivedAt) continue;
    const daysToPay = Math.max(0, Math.round((Date.parse(`${f.paidAt}T00:00:00Z`) - Date.parse(`${receivedAt}T00:00:00Z`)) / DAY));
    sample.push({
      invoiceId: inv.id,
      reference: inv.reference,
      currency: inv.currency.toUpperCase(),
      receivedAt,
      paidAt: f.paidAt,
      dueAt: inv.dueDate,
      amount: f.amount,
      daysToPay,
      withinTerms: inv.dueDate ? f.paidAt <= inv.dueDate : null,
    });
  }
  /* outstanding at period end: approved subcontractor invoices billed on/before the end and not paid by it */
  const outstandingRows = await db
    .select({ id: invoices.id, currency: invoices.currency, status: invoices.status, billingDate: invoices.billingDate, paidDate: invoices.paidDate })
    .from(invoices)
    .where(and(eq(invoices.companyId, companyId), eq(invoices.kind, "subcontractor_invoice"), inArray(invoices.status, ["approved", "approved_as_noted", "paid"]), lte(invoices.billingDate, periodEnd), gte(invoices.billingDate, "0000-01-01")));
  const outstandingBy = new Map<string, number>();
  for (const r of outstandingRows) {
    const paidBefore = r.status === "paid" && r.paidDate !== null && r.paidDate <= periodEnd;
    if (paidBefore) continue;
    outstandingBy.set(r.currency.toUpperCase(), (outstandingBy.get(r.currency.toUpperCase()) ?? 0) + 1);
  }
  const currencies = [...new Set([...sample.map((s) => s.currency), ...outstandingBy.keys()])].sort();
  const metrics = currencies.map((c) => computeMetrics(c, sample.filter((s) => s.currency === c), outstandingBy.get(c) ?? 0));
  return { sample, metrics };
}

const createSchema = z.object({
  regime: z.enum(SUPPLY_CHAIN_REPORT_REGIMES).optional(),
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
  notes: z.string().max(4000).nullable().optional(),
});

export const supplyChainRoutes: FastifyPluginAsync = async (app) => {
  const companyGate = [app.authenticate, app.requireCompany];
  const adminGate = [app.authenticate, app.requireCompany, app.requireCompanyRole(["owner", "admin"])];

  async function fetchReport(id: string, companyId: string) {
    const rows = await app.db.select().from(supplyChainPaymentReports).where(and(eq(supplyChainPaymentReports.id, id), eq(supplyChainPaymentReports.companyId, companyId))).limit(1);
    if (!rows[0]) throw notFound("Report not found");
    return rows[0];
  }

  /** Preview the metrics for a window without saving anything. */
  app.get("/supply-chain-payment-reports/preview", { preHandler: companyGate }, async (req) => {
    const q = z.object({ periodStart: isoDateSchema, periodEnd: isoDateSchema }).parse(req.query);
    if (q.periodEnd < q.periodStart) throw badRequest("periodEnd is before periodStart");
    const { metrics, sample } = await buildSample(app.db, req.companyId!, q.periodStart, q.periodEnd);
    return { periodStart: q.periodStart, periodEnd: q.periodEnd, metrics, sampleSize: sample.length, sample: sample.slice(0, 200) };
  });

  app.post("/supply-chain-payment-reports", { preHandler: adminGate }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    if (body.periodEnd < body.periodStart) throw badRequest("periodEnd is before periodStart");
    const { metrics, sample } = await buildSample(app.db, req.companyId!, body.periodStart, body.periodEnd);
    const id = newId("scr");
    const now = new Date().toISOString();
    await app.db.insert(supplyChainPaymentReports).values({
      id,
      companyId: req.companyId!,
      regime: body.regime ?? "generic",
      status: "draft",
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      metrics: { byCurrency: metrics, sampleSize: sample.length, sampleInvoiceIds: sample.map((s) => s.invoiceId) },
      generatedAt: now,
      generatedBy: req.user!.id,
      notes: body.notes ?? null,
    });
    await appendLedger(app.db, { companyId: req.companyId!, actorId: req.user!.id, action: "create", objectType: "supply_chain_payment_report", objectId: id, payload: { periodStart: body.periodStart, periodEnd: body.periodEnd, metrics }, storePayload: true });
    return reply.status(201).send(await fetchReport(id, req.companyId!));
  });

  app.get("/supply-chain-payment-reports", { preHandler: companyGate }, async (req) => {
    const items = await app.db.select().from(supplyChainPaymentReports).where(eq(supplyChainPaymentReports.companyId, req.companyId!)).orderBy(desc(supplyChainPaymentReports.periodStart));
    return { items, total: items.length };
  });

  app.get("/supply-chain-payment-reports/:reportId", { preHandler: companyGate }, async (req) => {
    const { reportId } = req.params as { reportId: string };
    return fetchReport(reportId, req.companyId!);
  });

  /** Regenerate a draft's metrics from the registers as they are now. */
  app.post("/supply-chain-payment-reports/:reportId/regenerate", { preHandler: adminGate }, async (req) => {
    const { reportId } = req.params as { reportId: string };
    const r = await fetchReport(reportId, req.companyId!);
    if (r.status !== "draft") throw conflict("A published report is a fact on the record; create a new report for a corrected period");
    const { metrics, sample } = await buildSample(app.db, req.companyId!, r.periodStart, r.periodEnd);
    const now = new Date().toISOString();
    await app.db.update(supplyChainPaymentReports).set({ metrics: { byCurrency: metrics, sampleSize: sample.length, sampleInvoiceIds: sample.map((s) => s.invoiceId) }, generatedAt: now, generatedBy: req.user!.id, updatedAt: now }).where(eq(supplyChainPaymentReports.id, reportId));
    return fetchReport(reportId, req.companyId!);
  });

  app.post("/supply-chain-payment-reports/:reportId/publish", { preHandler: adminGate }, async (req) => {
    const { reportId } = req.params as { reportId: string };
    const r = await fetchReport(reportId, req.companyId!);
    if (r.status === "published") throw conflict("Already published");
    const now = new Date().toISOString();
    await app.db.update(supplyChainPaymentReports).set({ status: "published", publishedAt: now, publishedBy: req.user!.id, updatedAt: now }).where(eq(supplyChainPaymentReports.id, reportId));
    await appendLedger(app.db, { companyId: req.companyId!, actorId: req.user!.id, action: "state_change", objectType: "supply_chain_payment_report", objectId: reportId, payload: { status: "published", metrics: r.metrics }, storePayload: true });
    return fetchReport(reportId, req.companyId!);
  });
};
