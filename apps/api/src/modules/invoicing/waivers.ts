import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { commitments, invoices, lienWaivers, vendors } from "@constructos/db";
import { LIEN_WAIVER_STATUSES, LIEN_WAIVER_TYPES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import { appendLedger } from "../../lib/ledger.js";
import {
  APPROVED_INVOICE_STATUSES,
  CENT,
  WAIVER_COUNTER,
  assertSegregation,
  byCurrency,
  daysBetween,
  detailSchema,
  formatMoney,
  isSatisfyingWaiver,
  isoDateSchema,
  ledger,
  nonNegativeMoneySchema,
  nowIso,
  outstandingOf,
  reasonSchema,
  requireInvoicingLevel,
  round2,
  todayIso,
  waiverReference,
} from "./shared.js";

export type WaiverRow = typeof lienWaivers.$inferSelect;

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const SIGNATURE_METHODS = ["wet_ink", "e_signature", "notarized"] as const;

const waiverCreateSchema = z.object({
  waiverType: z.enum(LIEN_WAIVER_TYPES),
  vendorId: z.string().min(1).max(64).nullable().optional(),
  vendorContactId: z.string().min(1).max(64).nullable().optional(),
  commitmentId: z.string().min(1).max(64).nullable().optional(),
  invoiceId: z.string().min(1).max(64).nullable().optional(),
  paymentId: z.string().min(1).max(64).nullable().optional(),
  billingPeriodId: z.string().min(1).max(64).nullable().optional(),
  /** 1 = direct sub, 2 = their supplier, and so on down the chain */
  tier: z.number().int().min(1).max(9).optional(),
  claimantName: z.string().max(300).nullable().optional(),
  claimantAddress: z.string().max(1000).nullable().optional(),
  amount: nonNegativeMoneySchema.optional(),
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  /** work performed THROUGH this date is waived — legally decisive */
  throughDate: isoDateSchema,
  exceptionsNoted: z.string().max(4000).nullable().optional(),
  jurisdiction: z.string().max(200).nullable().optional(),
  statutoryForm: z.string().max(200).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  detail: detailSchema.optional(),
});

const waiverPatchSchema = z.object({
  claimantName: z.string().max(300).nullable().optional(),
  claimantAddress: z.string().max(1000).nullable().optional(),
  amount: nonNegativeMoneySchema.optional(),
  throughDate: isoDateSchema.optional(),
  exceptionsNoted: z.string().max(4000).nullable().optional(),
  jurisdiction: z.string().max(200).nullable().optional(),
  statutoryForm: z.string().max(200).nullable().optional(),
  tier: z.number().int().min(1).max(9).optional(),
  notes: z.string().max(4000).nullable().optional(),
  documentId: z.string().max(64).nullable().optional(),
  detail: detailSchema.optional(),
});

const waiverListQuery = pageQuerySchema.extend({
  status: z.enum(LIEN_WAIVER_STATUSES).optional(),
  waiverType: z.enum(LIEN_WAIVER_TYPES).optional(),
  vendorId: z.string().optional(),
  commitmentId: z.string().optional(),
  invoiceId: z.string().optional(),
  tier: z.coerce.number().int().min(1).max(9).optional(),
});

const signSchema = z.object({
  signedByName: z.string().min(1).max(300),
  signatureMethod: z.enum(SIGNATURE_METHODS),
  signatureReference: z.string().max(300).nullable().optional(),
  signedAt: z.string().min(4).optional(),
});

/* ------------------------------------------------------------------ */
/* The payment gate                                                    */
/* ------------------------------------------------------------------ */

export interface WaiverGate {
  required: boolean;
  satisfied: boolean;
  /** waivers on file for this invoice, whatever their state */
  waivers: Array<{
    id: string;
    reference: string;
    waiverType: string;
    status: string;
    throughDate: string | null;
    amount: number;
    tier: number;
  }>;
  /** why payment is blocked; empty when it is not */
  reasons: string[];
}

/**
 * Is this invoice's lien waiver on file?
 *
 * A waiver counts only in `received`, `verified` or `not_required`. Anything
 * earlier — requested, sent, even signed — means the document is not in our
 * hands, and "the sub says they posted it" has never defeated a mechanic's
 * lien. `not_required` is included because a deliberate, recorded exemption
 * is a decision; silence is not.
 */
export async function waiverGateFor(
  db: Db,
  invoice: {
    id: string;
    reference: string;
    requiresLienWaiver: number;
    commitmentId: string | null;
    vendorId: string | null;
    currentPaymentDue: number;
    currency: string;
    amountPaid?: number;
    detail?: unknown;
    periodEnd?: string | null;
    billingDate?: string | null;
  },
): Promise<WaiverGate> {
  const rows = await db
    .select({
      id: lienWaivers.id,
      reference: lienWaivers.reference,
      waiverType: lienWaivers.waiverType,
      status: lienWaivers.status,
      throughDate: lienWaivers.throughDate,
      amount: lienWaivers.amount,
      currency: lienWaivers.currency,
      tier: lienWaivers.tier,
    })
    .from(lienWaivers)
    .where(eq(lienWaivers.invoiceId, invoice.id));
  const required = invoice.requiresLienWaiver === 1;
  const reasons: string[] = [];
  /*
   * A waiver on file must actually COVER the payment (audit: a 1.00 USD
   * conditional waiver through last year must not unblock a 500,000 payment
   * this month). Through date, amount and currency are each checked, and
   * every shortfall is named so the register can fix the right one.
   */
  const detail = (invoice.detail ?? {}) as Record<string, unknown>;
  const approved = detail["approvedAmount"];
  const certified =
    typeof approved === "number" && Number.isFinite(approved)
      ? Math.min(approved, invoice.currentPaymentDue)
      : invoice.currentPaymentDue;
  const payable = round2(Math.max(0, certified - (invoice.amountPaid ?? 0)));
  const coverThrough = invoice.periodEnd ?? invoice.billingDate ?? null;
  const isFinal = detail["isFinal"] === true;
  const shortfalls: string[] = [];
  const onFile = rows.filter((w) => {
    if (!isSatisfyingWaiver(w.status)) return false;
    if (w.status === "not_required") return true;
    const problems: string[] = [];
    if (w.currency.toUpperCase() !== invoice.currency.toUpperCase()) {
      problems.push(`is in ${w.currency}, the invoice is in ${invoice.currency}`);
    }
    if (coverThrough && w.throughDate && w.throughDate < coverThrough) {
      problems.push(`waives work only through ${w.throughDate}, before the billing period end ${coverThrough}`);
    }
    if (w.amount > CENT && payable - w.amount > CENT) {
      problems.push(`covers ${formatMoney(w.amount)}, less than the ${formatMoney(payable)} payable`);
    }
    if (isFinal && !w.waiverType.endsWith("_final")) {
      problems.push(`is a ${w.waiverType} waiver on a final invoice — a final waiver is required`);
    }
    if (problems.length > 0) {
      shortfalls.push(`${w.reference} (${w.status}) ${problems.join("; ")}.`);
      return false;
    }
    return true;
  });
  if (required && onFile.length === 0) {
    reasons.push(
      rows.length === 0
        ? `Invoice ${invoice.reference} requires a lien waiver and none has been raised. ` +
          `Paying ${formatMoney(invoice.currentPaymentDue)} ${invoice.currency} without one ` +
          "leaves the project exposed to a lien for work already paid for."
        : `Invoice ${invoice.reference} requires a lien waiver. ${rows.length} waiver(s) exist ` +
          `but none covers this payment: ${rows
            .map((w) => `${w.reference} (${w.status})`)
            .join(", ")}.`,
    );
    reasons.push(...shortfalls);
  }
  return {
    required,
    satisfied: !required || onFile.length > 0,
    waivers: rows,
    reasons,
  };
}

/**
 * Lien-waiver automation tied to payment release (#576–578, #589). When a
 * payment against an invoice that REQUIRES a waiver is issued and no waiver is
 * on file or in flight, a conditional progress waiver request is raised
 * against the invoice, addressed to the vendor, for the amount paid and
 * through the billing period end. The request is a record with the payment's
 * id on it, so the outstanding-waiver report can chase it and the vendor
 * portal can return it. Returns null when nothing needed raising.
 */
export async function requestWaiverForPayment(
  db: Db,
  paymentId: string,
  actorId: string,
): Promise<{ id: string; reference: string; waiverType: string } | null> {
  const { commitmentPayments } = await import("@constructos/db");
  const payRows = await db
    .select()
    .from(commitmentPayments)
    .where(eq(commitmentPayments.id, paymentId))
    .limit(1);
  const payment = payRows[0];
  if (!payment?.invoiceId) return null;
  const invRows = await db.select().from(invoices).where(eq(invoices.id, payment.invoiceId)).limit(1);
  const inv = invRows[0];
  if (!inv || inv.requiresLienWaiver !== 1) return null;
  const existing = await db
    .select({ id: lienWaivers.id, status: lienWaivers.status })
    .from(lienWaivers)
    .where(eq(lienWaivers.invoiceId, inv.id));
  const inFlight = existing.filter((w) => !["void", "rejected"].includes(w.status));
  if (inFlight.length > 0) return null;
  const detail = (inv.detail ?? {}) as Record<string, unknown>;
  const waiverType = detail["isFinal"] === true ? "conditional_final" : "conditional_progress";
  const number = await nextRecordNumber(db, inv.projectId, WAIVER_COUNTER);
  const id = newId("lwv");
  const now = nowIso();
  await db.insert(lienWaivers).values({
    id,
    companyId: inv.companyId,
    projectId: inv.projectId,
    number,
    reference: waiverReference(number),
    waiverType,
    status: "requested",
    commitmentId: inv.commitmentId,
    invoiceId: inv.id,
    paymentId,
    billingPeriodId: inv.billingPeriodId,
    vendorId: inv.vendorId ?? payment.vendorId,
    tier: 1,
    amount: round2(payment.amount),
    currency: inv.currency,
    throughDate: inv.periodEnd ?? inv.billingDate ?? todayIso(),
    notes: `Raised automatically when payment ${payment.reference} was issued (#576).`,
    detail: { autoRequestedForPaymentId: paymentId },
    requestedBy: actorId,
    requestedAt: now,
    createdBy: actorId,
    updatedAt: now,
  });
  await db
    .update(invoices)
    .set({ lienWaiverStatus: "requested", updatedAt: now })
    .where(eq(invoices.id, inv.id));
  await appendLedger(db, {
    companyId: inv.companyId,
    actorId,
    action: "create",
    objectType: "lien_waiver",
    objectId: id,
    projectId: inv.projectId,
    payload: { automatic: true, paymentId, invoiceId: inv.id, waiverType, amount: payment.amount },
    storePayload: true,
  });
  return { id, reference: waiverReference(number), waiverType };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/**
 * LIEN WAIVERS — the chain of custody, because "we have it somewhere" is not
 * a defence.
 *
 * Two fields on the document are legally decisive and neither is ever
 * inferred here. `waiverType` says whether the waiver bites on signature
 * (unconditional) or only on payment clearing (conditional), and whether it
 * covers this progress payment or the whole job (final). `throughDate` fixes
 * exactly which work is waived. Getting either wrong costs a subcontractor
 * their lien rights, so both are required on creation.
 *
 * The lifecycle is a custody chain — requested -> sent -> signed -> received
 * -> verified — with its own actor and timestamp at each step, and the
 * verifier may not be the person who received it.
 */
export const waiverRoutes: FastifyPluginAsync = async (app) => {
  const companyGate = [app.authenticate, app.requireCompany];
  const readGate = [...companyGate, app.requireTool("invoicing", "read")];
  const standardGate = [...companyGate, app.requireTool("invoicing", "standard")];

  async function fetchWaiver(waiverId: string, companyId: string): Promise<WaiverRow> {
    const rows = await app.db
      .select()
      .from(lienWaivers)
      .where(and(eq(lienWaivers.id, waiverId), eq(lienWaivers.companyId, companyId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Lien waiver not found");
    return row;
  }

  /** One custody step: assert the state it must come from, stamp the actor. */
  async function transition(
    req: Parameters<typeof requireInvoicingLevel>[1],
    reply: Parameters<typeof requireInvoicingLevel>[2],
    waiverId: string,
    from: readonly string[],
    to: string,
    patch: Record<string, unknown>,
    payload: Record<string, unknown> = {},
    level: "standard" | "admin" = "standard",
  ): Promise<WaiverRow> {
    const waiver = await fetchWaiver(waiverId, req.companyId!);
    await requireInvoicingLevel(app, req, reply, waiver.projectId, level);
    if (!from.includes(waiver.status)) {
      throw conflict(
        `Lien waiver ${waiver.reference} is ${waiver.status}; ${to} requires it to be ` +
          `${from.join(" or ")}. The custody chain is not skippable — a waiver cannot be ` +
          "received before it was sent.",
      );
    }
    const now = nowIso();
    await app.db
      .update(lienWaivers)
      .set({ status: to, ...patch, updatedAt: now })
      .where(eq(lienWaivers.id, waiverId));
    const updated = await fetchWaiver(waiverId, req.companyId!);
    await syncInvoiceWaiverStatus(app.db, updated.invoiceId);
    await ledger(app.db, req, "state_change", "lien_waiver", waiverId, {
      from: waiver.status,
      to,
      waiverType: waiver.waiverType,
      throughDate: waiver.throughDate,
      amount: waiver.amount,
      ...payload,
    }, waiver.projectId, true);
    return updated;
  }

  /** Mirror the best waiver state onto the invoice so one read answers both. */
  async function syncInvoiceWaiverStatus(db: Db, invoiceId: string | null): Promise<void> {
    if (!invoiceId) return;
    const rows = await db
      .select({ status: lienWaivers.status })
      .from(lienWaivers)
      .where(eq(lienWaivers.invoiceId, invoiceId));
    if (rows.length === 0) return;
    const rank = ["void", "rejected", "draft", "requested", "sent", "signed", "received", "verified", "not_required"];
    const best = rows
      .map((r) => r.status)
      .sort((a, b) => rank.indexOf(b) - rank.indexOf(a))[0]!;
    await db
      .update(invoices)
      .set({ lienWaiverStatus: best, updatedAt: nowIso() })
      .where(eq(invoices.id, invoiceId));
  }

  app.post("/projects/:projectId/lien-waivers", { preHandler: standardGate }, async (req, reply) => {
    const body = waiverCreateSchema.parse(req.body);
    const projectId = req.projectId!;
    const companyId = req.companyId!;

    let vendorId = body.vendorId ?? null;
    let commitmentId = body.commitmentId ?? null;
    let amount = body.amount ?? 0;
    let currency = (body.currency ?? "USD").toUpperCase();

    if (body.invoiceId) {
      const rows = await app.db
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.id, body.invoiceId),
            eq(invoices.companyId, companyId),
            eq(invoices.projectId, projectId),
          ),
        )
        .limit(1);
      const inv = rows[0];
      if (!inv) throw badRequest("invoiceId does not reference an invoice on this project");
      vendorId = vendorId ?? inv.vendorId;
      commitmentId = commitmentId ?? inv.commitmentId;
      currency = body.currency ? currency : inv.currency;
      // Default the waived amount to what is actually being paid, not the
      // gross billed: a waiver for more than the payment waives rights the
      // sub has not been paid for.
      if (body.amount === undefined) amount = round2(inv.currentPaymentDue);
    }
    if (commitmentId) {
      const rows = await app.db
        .select({
          id: commitments.id,
          vendorId: commitments.vendorId,
          currency: commitments.currency,
        })
        .from(commitments)
        .where(
          and(
            eq(commitments.id, commitmentId),
            eq(commitments.companyId, companyId),
            eq(commitments.projectId, projectId),
          ),
        )
        .limit(1);
      if (!rows[0]) {
        throw badRequest("commitmentId does not reference a commitment on this project");
      }
      vendorId = vendorId ?? rows[0].vendorId;
      if (!body.currency && !body.invoiceId) currency = rows[0].currency;
    }

    let claimantName = body.claimantName ?? null;
    if (!claimantName && vendorId) {
      const v = await app.db
        .select({ name: vendors.name })
        .from(vendors)
        .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)))
        .limit(1);
      claimantName = v[0]?.name ?? null;
    }
    if (!claimantName) {
      throw badRequest(
        "A lien waiver needs a claimant. Give a claimantName, or a vendorId / commitmentId / " +
          "invoiceId the claimant can be resolved from — an unnamed waiver waives nothing.",
      );
    }

    const number = await nextRecordNumber(app.db, projectId, WAIVER_COUNTER);
    const id = newId("lwv");
    await app.db.insert(lienWaivers).values({
      id,
      companyId,
      projectId,
      number,
      reference: waiverReference(number),
      waiverType: body.waiverType,
      status: "draft",
      commitmentId,
      invoiceId: body.invoiceId ?? null,
      paymentId: body.paymentId ?? null,
      billingPeriodId: body.billingPeriodId ?? null,
      vendorId,
      vendorContactId: body.vendorContactId ?? null,
      tier: body.tier ?? 1,
      claimantName,
      claimantAddress: body.claimantAddress ?? null,
      amount: round2(amount),
      currency,
      throughDate: body.throughDate,
      exceptionsNoted: body.exceptionsNoted ?? null,
      jurisdiction: body.jurisdiction ?? null,
      statutoryForm: body.statutoryForm ?? null,
      notes: body.notes ?? null,
      detail: body.detail ?? {},
      createdBy: req.user!.id,
      updatedAt: nowIso(),
    });
    const row = await fetchWaiver(id, companyId);
    await syncInvoiceWaiverStatus(app.db, row.invoiceId);
    await ledger(app.db, req, "create", "lien_waiver", id, {
      reference: row.reference,
      waiverType: row.waiverType,
      throughDate: row.throughDate,
      amount: row.amount,
      currency: row.currency,
      tier: row.tier,
      invoiceId: row.invoiceId,
    }, projectId);
    return reply.status(201).send(row);
  });

  app.get("/projects/:projectId/lien-waivers", { preHandler: readGate }, async (req) => {
    const q = waiverListQuery.parse(req.query);
    const clauses = [eq(lienWaivers.projectId, req.projectId!)];
    if (q.status) clauses.push(eq(lienWaivers.status, q.status));
    if (q.waiverType) clauses.push(eq(lienWaivers.waiverType, q.waiverType));
    if (q.vendorId) clauses.push(eq(lienWaivers.vendorId, q.vendorId));
    if (q.commitmentId) clauses.push(eq(lienWaivers.commitmentId, q.commitmentId));
    if (q.invoiceId) clauses.push(eq(lienWaivers.invoiceId, q.invoiceId));
    if (q.tier !== undefined) clauses.push(eq(lienWaivers.tier, q.tier));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(lienWaivers).where(where);
    const items = await app.db
      .select()
      .from(lienWaivers)
      .where(where)
      .orderBy(desc(lienWaivers.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /**
   * THE OUTSTANDING-WAIVER REPORT. Every approved or paid invoice that
   * requires a waiver and has not got one on file, plus every waiver stuck
   * mid-custody, aged by how long it has been outstanding.
   *
   * This is the report that stops a project paying itself into a lien: money
   * that has already gone out against unwaived work is listed first, because
   * that exposure cannot be withdrawn — only chased.
   */
  app.get("/projects/:projectId/lien-waivers/outstanding", { preHandler: readGate }, async (req) => {
    const q = z
      .object({ asOf: isoDateSchema.optional(), includePaid: z.coerce.boolean().optional() })
      .parse(req.query ?? {});
    const asOf = q.asOf ?? todayIso();
    const projectId = req.projectId!;

    const [invoiceRows, waiverRows, vendorRows] = await Promise.all([
      app.db
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.projectId, projectId),
            eq(invoices.requiresLienWaiver, 1),
            inArray(invoices.status, [...APPROVED_INVOICE_STATUSES]),
          ),
        ),
      app.db.select().from(lienWaivers).where(eq(lienWaivers.projectId, projectId)),
      app.db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(eq(vendors.companyId, req.companyId!)),
    ]);
    const vendorName = new Map(vendorRows.map((v) => [v.id, v.name]));
    const waiversByInvoice = new Map<string, WaiverRow[]>();
    for (const w of waiverRows) {
      if (!w.invoiceId) continue;
      const list = waiversByInvoice.get(w.invoiceId);
      if (list) list.push(w);
      else waiversByInvoice.set(w.invoiceId, [w]);
    }

    /* a recorded exemption is a decision — reported in its own bucket, never hidden */
    const excused = invoiceRows
      .filter((inv) => (waiversByInvoice.get(inv.id) ?? []).some((w) => w.status === "not_required"))
      .map((inv) => {
        const w = (waiversByInvoice.get(inv.id) ?? []).find((x) => x.status === "not_required")!;
        const d = (w.detail ?? {}) as Record<string, unknown>;
        return {
          invoiceId: inv.id,
          reference: inv.reference,
          vendorId: inv.vendorId,
          vendorName: inv.vendorId ? (vendorName.get(inv.vendorId) ?? null) : null,
          currency: inv.currency,
          currentPaymentDue: round2(inv.currentPaymentDue),
          amountPaid: round2(inv.amountPaid),
          waiverId: w.id,
          waiverReference: w.reference,
          excusedBy: typeof d["notRequiredBy"] === "string" ? (d["notRequiredBy"] as string) : null,
          excusedAt: typeof d["notRequiredAt"] === "string" ? (d["notRequiredAt"] as string) : null,
          reason: typeof d["notRequiredReason"] === "string" ? (d["notRequiredReason"] as string) : w.notes,
        };
      });

    const exposures = invoiceRows
      .map((inv) => {
        const mine = waiversByInvoice.get(inv.id) ?? [];
        const onFile = mine.filter((w) => isSatisfyingWaiver(w.status));
        if (onFile.length > 0) return null;
        const paidAmount = round2(inv.amountPaid);
        const daysOutstanding = inv.billingDate ? daysBetween(inv.billingDate, asOf) : null;
        return {
          invoiceId: inv.id,
          reference: inv.reference,
          invoiceNumber: inv.invoiceNumber,
          kind: inv.kind,
          status: inv.status,
          vendorId: inv.vendorId,
          vendorName: inv.vendorId ? (vendorName.get(inv.vendorId) ?? null) : null,
          commitmentId: inv.commitmentId,
          currency: inv.currency,
          currentPaymentDue: round2(inv.currentPaymentDue),
          amountPaid: paidAmount,
          /** certified less paid — honours an approved-as-noted reduction */
          outstanding: outstandingOf(inv),
          /** money already out of the door against unwaived work */
          paidUnwaived: paidAmount,
          billingDate: inv.billingDate,
          daysOutstanding,
          waivers: mine.map((w) => ({
            id: w.id,
            reference: w.reference,
            status: w.status,
            waiverType: w.waiverType,
            throughDate: w.throughDate,
          })),
          blocking: paidAmount > CENT ? "paid_without_waiver" : "payment_blocked",
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .filter((x) => (q.includePaid === false ? x.paidUnwaived <= CENT : true))
      .sort((a, b) => b.paidUnwaived - a.paidUnwaived || (b.daysOutstanding ?? 0) - (a.daysOutstanding ?? 0));

    const inFlight = waiverRows
      .filter((w) => ["requested", "sent", "signed"].includes(w.status))
      .map((w) => ({
        id: w.id,
        reference: w.reference,
        status: w.status,
        waiverType: w.waiverType,
        vendorId: w.vendorId,
        vendorName: w.vendorId ? (vendorName.get(w.vendorId) ?? null) : null,
        amount: w.amount,
        currency: w.currency,
        throughDate: w.throughDate,
        tier: w.tier,
        daysSinceRequested: w.requestedAt
          ? daysBetween(w.requestedAt.slice(0, 10), asOf)
          : null,
      }))
      .sort((a, b) => (b.daysSinceRequested ?? 0) - (a.daysSinceRequested ?? 0));

    return {
      asOf,
      projectId,
      // Never one number across currencies — two buckets and a note instead.
      exposureByCurrency: byCurrency(
        exposures,
        (e) => e.currency,
        (rows, currency) => ({
          currency,
          invoices: rows.length,
          paidWithoutWaiver: round2(rows.reduce((s, r) => s + r.paidUnwaived, 0)),
          blockedFromPayment: round2(
            rows
              .filter((r) => r.blocking === "payment_blocked")
              .reduce((s, r) => s + r.outstanding, 0),
          ),
        }),
      ),
      outstanding: exposures,
      inFlight,
      /** invoices whose waiver was excused on the record — a decision, listed as one */
      excused,
      /** second-tier claimants are the classic route to a lien on a paid job */
      untieredWarning:
        waiverRows.length > 0 && waiverRows.every((w) => w.tier === 1)
          ? "Every waiver on this project is tier 1 (direct subcontractors). Second-tier " +
            "suppliers can lien a project that has paid its subs in full."
          : null,
    };
  });

  app.get("/lien-waivers/:waiverId", { preHandler: companyGate }, async (req, reply) => {
    const { waiverId } = req.params as { waiverId: string };
    const waiver = await fetchWaiver(waiverId, req.companyId!);
    await requireInvoicingLevel(app, req, reply, waiver.projectId, "read");
    return waiver;
  });

  app.patch("/lien-waivers/:waiverId", { preHandler: companyGate }, async (req, reply) => {
    const { waiverId } = req.params as { waiverId: string };
    const body = waiverPatchSchema.parse(req.body);
    const waiver = await fetchWaiver(waiverId, req.companyId!);
    await requireInvoicingLevel(app, req, reply, waiver.projectId, "standard");
    if (["signed", "received", "verified"].includes(waiver.status)) {
      throw conflict(
        `Lien waiver ${waiver.reference} is ${waiver.status} — a signed document's terms are ` +
          "fixed. Reject it and raise a corrected waiver if the amount or through date is wrong.",
      );
    }
    await app.db
      .update(lienWaivers)
      .set({
        ...(body.claimantName !== undefined ? { claimantName: body.claimantName } : {}),
        ...(body.claimantAddress !== undefined ? { claimantAddress: body.claimantAddress } : {}),
        ...(body.amount !== undefined ? { amount: round2(body.amount) } : {}),
        ...(body.throughDate !== undefined ? { throughDate: body.throughDate } : {}),
        ...(body.exceptionsNoted !== undefined ? { exceptionsNoted: body.exceptionsNoted } : {}),
        ...(body.jurisdiction !== undefined ? { jurisdiction: body.jurisdiction } : {}),
        ...(body.statutoryForm !== undefined ? { statutoryForm: body.statutoryForm } : {}),
        ...(body.tier !== undefined ? { tier: body.tier } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.documentId !== undefined ? { documentId: body.documentId } : {}),
        ...(body.detail !== undefined
          ? { detail: { ...(waiver.detail as Record<string, unknown>), ...body.detail } }
          : {}),
        updatedAt: nowIso(),
      })
      .where(eq(lienWaivers.id, waiverId));
    const row = await fetchWaiver(waiverId, req.companyId!);
    await ledger(app.db, req, "update", "lien_waiver", waiverId, body, waiver.projectId);
    return row;
  });

  /* ---- the custody chain ---- */

  app.post("/lien-waivers/:waiverId/request", { preHandler: companyGate }, async (req, reply) => {
    const { waiverId } = req.params as { waiverId: string };
    return transition(req, reply, waiverId, ["draft"], "requested", {
      requestedBy: req.user!.id,
      requestedAt: nowIso(),
    });
  });

  app.post("/lien-waivers/:waiverId/send", { preHandler: companyGate }, async (req, reply) => {
    const { waiverId } = req.params as { waiverId: string };
    return transition(req, reply, waiverId, ["draft", "requested"], "sent", { sentAt: nowIso() });
  });

  app.post("/lien-waivers/:waiverId/sign", { preHandler: companyGate }, async (req, reply) => {
    const { waiverId } = req.params as { waiverId: string };
    const body = signSchema.parse(req.body);
    return transition(
      req,
      reply,
      waiverId,
      ["requested", "sent"],
      "signed",
      {
        signedAt: body.signedAt ?? nowIso(),
        signedByName: body.signedByName,
        signatureMethod: body.signatureMethod,
        signatureReference: body.signatureReference ?? null,
      },
      { signedByName: body.signedByName, signatureMethod: body.signatureMethod },
    );
  });

  app.post("/lien-waivers/:waiverId/receive", { preHandler: companyGate }, async (req, reply) => {
    const { waiverId } = req.params as { waiverId: string };
    const body = z
      .object({ documentId: z.string().max(64).nullable().optional() })
      .parse(req.body ?? {});
    return transition(req, reply, waiverId, ["signed"], "received", {
      receivedAt: nowIso(),
      receivedBy: req.user!.id,
      ...(body.documentId !== undefined ? { documentId: body.documentId } : {}),
    });
  });

  /**
   * Verification is a second pair of eyes on the document itself — the right
   * form for the jurisdiction, the right through date, the exceptions read.
   * The verifier may not be the person who received it.
   */
  app.post("/lien-waivers/:waiverId/verify", { preHandler: companyGate }, async (req, reply) => {
    const { waiverId } = req.params as { waiverId: string };
    const waiver = await fetchWaiver(waiverId, req.companyId!);
    assertSegregation(req.user!.id, { receivedBy: waiver.receivedBy }, "lien waiver");
    if (!waiver.throughDate) {
      throw badRequest(
        `Lien waiver ${waiver.reference} has no through date. The date work is waived through ` +
          "is legally decisive and cannot be verified as blank.",
      );
    }
    return transition(req, reply, waiverId, ["received"], "verified", {
      verifiedAt: nowIso(),
      verifiedBy: req.user!.id,
    });
  });

  app.post("/lien-waivers/:waiverId/reject", { preHandler: companyGate }, async (req, reply) => {
    const { waiverId } = req.params as { waiverId: string };
    const body = reasonSchema.parse(req.body);
    return transition(
      req,
      reply,
      waiverId,
      ["requested", "sent", "signed", "received", "verified"],
      "rejected",
      { rejectionReason: body.reason },
      { reason: body.reason },
    );
  });

  /**
   * A recorded, reasoned exemption. Distinct from silence: `not_required`
   * satisfies the payment gate precisely because somebody decided it, on the
   * record, with their name on it.
   */
  app.post("/lien-waivers/:waiverId/not-required", { preHandler: companyGate }, async (req, reply) => {
    const { waiverId } = req.params as { waiverId: string };
    const body = reasonSchema.parse(req.body);
    /*
     * Excusing a waiver satisfies the payment gate, so it is an ADMIN act by
     * somebody other than the person who raised the waiver or the invoice —
     * otherwise the biller could neutralise the control on their own invoice.
     */
    const waiver = await fetchWaiver(waiverId, req.companyId!);
    const parties: { createdBy?: string | null; submittedBy?: string | null; requestedBy?: string | null } = {
      createdBy: waiver.createdBy,
      requestedBy: waiver.requestedBy,
    };
    if (waiver.invoiceId) {
      const inv = (
        await app.db
          .select({ createdBy: invoices.createdBy, submittedBy: invoices.submittedBy })
          .from(invoices)
          .where(eq(invoices.id, waiver.invoiceId))
          .limit(1)
      )[0];
      if (inv) {
        if (inv.createdBy === req.user!.id) {
          throw new AppError(403, "Segregation of duties: the person who raised the invoice may not excuse its lien waiver.", {
            control: "no_self_approval",
            role: "invoice_created_by",
          });
        }
        if (inv.submittedBy) parties.submittedBy = inv.submittedBy;
      }
    }
    assertSegregation(req.user!.id, parties, "lien waiver");
    const now = nowIso();
    return transition(
      req,
      reply,
      waiverId,
      ["draft", "requested", "sent"],
      "not_required",
      {
        notes: body.reason,
        detail: {
          ...(waiver.detail as Record<string, unknown>),
          notRequiredBy: req.user!.id,
          notRequiredAt: now,
          notRequiredReason: body.reason,
        },
      },
      { reason: body.reason, notRequiredBy: req.user!.id },
      "admin",
    );
  });

  app.post("/lien-waivers/:waiverId/void", { preHandler: companyGate }, async (req, reply) => {
    const { waiverId } = req.params as { waiverId: string };
    const body = reasonSchema.parse(req.body);
    const waiver = await fetchWaiver(waiverId, req.companyId!);
    if (waiver.status === "verified") {
      throw conflict(
        `Lien waiver ${waiver.reference} is verified — a verified waiver is evidence and is ` +
          "never voided. Record the superseding document instead.",
      );
    }
    return transition(
      req,
      reply,
      waiverId,
      ["draft", "requested", "sent", "signed", "received", "rejected", "not_required"],
      "void",
      { rejectionReason: body.reason },
      { reason: body.reason },
    );
  });

  /** Waivers on one invoice, plus whether payment is unblocked. */
  app.get("/invoices/:invoiceId/lien-waivers", { preHandler: companyGate }, async (req, reply) => {
    const { invoiceId } = req.params as { invoiceId: string };
    const rows = await app.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.companyId, req.companyId!)))
      .limit(1);
    const inv = rows[0];
    if (!inv) throw notFound("Invoice not found");
    await requireInvoicingLevel(app, req, reply, inv.projectId, "read");
    const waivers = await app.db
      .select()
      .from(lienWaivers)
      .where(eq(lienWaivers.invoiceId, invoiceId))
      .orderBy(asc(lienWaivers.number));
    return { invoiceId, gate: await waiverGateFor(app.db, inv), waivers };
  });
};
