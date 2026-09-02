import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { billingPeriods, invoices, retainageReleases } from "@constructos/db";
import { BILLING_PERIOD_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import {
  DEAD_INVOICE_STATUSES,
  PERIOD_COUNTER,
  byCurrency,
  detailSchema,
  isoDateSchema,
  isReleasedRetainage,
  ledger,
  nowIso,
  periodReference,
  requireInvoicingLevel,
  round2,
} from "./shared.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const periodCreateSchema = z.object({
  name: z.string().min(1).max(200),
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  /** the date work is billed THROUGH; defaults to endDate */
  billingDate: isoDateSchema.optional(),
  subcontractorSubmitStart: isoDateSchema.nullable().optional(),
  subcontractorSubmitEnd: isoDateSchema.nullable().optional(),
  ownerBillingDate: isoDateSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  detail: detailSchema.optional(),
});

const periodPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  billingDate: isoDateSchema.optional(),
  subcontractorSubmitStart: isoDateSchema.nullable().optional(),
  subcontractorSubmitEnd: isoDateSchema.nullable().optional(),
  ownerBillingDate: isoDateSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  detail: detailSchema.optional(),
});

const periodListQuery = pageQuerySchema.extend({
  status: z.enum(BILLING_PERIOD_STATUSES).optional(),
});

const closeSchema = z.object({
  /** close even though invoices are still mid-flight; they are named first */
  force: z.boolean().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

export type PeriodRow = typeof billingPeriods.$inferSelect;

/* ------------------------------------------------------------------ */
/* Shared helpers used by the rest of the module                       */
/* ------------------------------------------------------------------ */

export async function fetchPeriod(
  db: Db,
  periodId: string,
  companyId: string,
): Promise<PeriodRow> {
  const rows = await db
    .select()
    .from(billingPeriods)
    .where(and(eq(billingPeriods.id, periodId), eq(billingPeriods.companyId, companyId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("Billing period not found");
  return row;
}

/**
 * A closed period takes no new billing and a locked one takes no writes at
 * all. This is the whole point of the record: once the month is closed, the
 * monthly cost report for that month is reproducible, and it is not
 * reproducible if invoices keep arriving into it afterwards.
 */
export async function assertPeriodAcceptsBilling(
  db: Db,
  periodId: string | null | undefined,
  projectId: string,
  companyId: string,
  act: string,
): Promise<PeriodRow | null> {
  if (!periodId) return null;
  const rows = await db
    .select()
    .from(billingPeriods)
    .where(
      and(
        eq(billingPeriods.id, periodId),
        eq(billingPeriods.projectId, projectId),
        eq(billingPeriods.companyId, companyId),
      ),
    )
    .limit(1);
  const period = rows[0];
  if (!period) throw badRequest("billingPeriodId does not reference a period on this project");
  if (period.status === "closed") {
    throw conflict(
      `Billing period ${period.reference} (${period.name}) is closed — ${act} into a closed ` +
        "period is refused. Reopen the period, or bill into the next one.",
    );
  }
  if (period.status === "locked") {
    throw conflict(
      `Billing period ${period.reference} (${period.name}) is locked — its figures are frozen ` +
        `for reporting and ${act} into it can never be permitted.`,
    );
  }
  return period;
}

/**
 * Re-derive a period's rollup columns from the invoices and releases that
 * point at it. Materialized because the period list is a hot read; DERIVED
 * here so there is one implementation and no drift.
 *
 * Currency: the rollup columns are single scalars, so they are summed only
 * over invoices sharing the project's dominant currency for the period, and
 * `detail.currencies` records every bucket in full. A period holding USD and
 * EUR invoices reports two buckets and a note, never one wrong number.
 */
export async function recomputePeriodRollups(db: Db, periodId: string): Promise<PeriodRow> {
  const [periodRows, invoiceRows, releaseRows] = await Promise.all([
    db.select().from(billingPeriods).where(eq(billingPeriods.id, periodId)).limit(1),
    db
      .select({
        kind: invoices.kind,
        status: invoices.status,
        currency: invoices.currency,
        totalCompletedAndStored: invoices.totalCompletedAndStored,
        totalRetainage: invoices.totalRetainage,
        currentPaymentDue: invoices.currentPaymentDue,
      })
      .from(invoices)
      .where(eq(invoices.billingPeriodId, periodId)),
    db
      .select({
        status: retainageReleases.status,
        amount: retainageReleases.amount,
      })
      .from(retainageReleases)
      .where(eq(retainageReleases.billingPeriodId, periodId)),
  ]);
  const period = periodRows[0];
  if (!period) throw notFound("Billing period not found");

  const live = invoiceRows.filter(
    (i) => !(DEAD_INVOICE_STATUSES as readonly string[]).includes(i.status) && i.status !== "draft",
  );
  const currencies = byCurrency(
    live,
    (i) => i.currency,
    (rows, currency) => ({
      currency,
      ownerBilledAmount: round2(
        rows.filter((r) => r.kind === "owner_billing").reduce((s, r) => s + r.currentPaymentDue, 0),
      ),
      subcontractorBilledAmount: round2(
        rows
          .filter((r) => r.kind === "subcontractor_invoice")
          .reduce((s, r) => s + r.currentPaymentDue, 0),
      ),
      retainageHeldAmount: round2(rows.reduce((s, r) => s + r.totalRetainage, 0)),
      invoiceCount: rows.length,
    }),
  );
  // The scalar columns describe the largest bucket; detail carries them all.
  const dominant =
    [...currencies].sort((a, b) => b.invoiceCount - a.invoiceCount)[0] ?? null;
  const retainageReleasedAmount = round2(
    releaseRows.filter((r) => isReleasedRetainage(r.status)).reduce((s, r) => s + r.amount, 0),
  );

  const now = nowIso();
  await db
    .update(billingPeriods)
    .set({
      ownerBilledAmount: dominant?.ownerBilledAmount ?? 0,
      subcontractorBilledAmount: dominant?.subcontractorBilledAmount ?? 0,
      retainageHeldAmount: dominant?.retainageHeldAmount ?? 0,
      retainageReleasedAmount,
      invoiceCount: live.length,
      detail: {
        ...(period.detail as Record<string, unknown>),
        rollupCurrency: dominant?.currency ?? null,
        currencies,
        rollupAt: now,
      },
      updatedAt: now,
    })
    .where(eq(billingPeriods.id, periodId));

  const refreshed = await db
    .select()
    .from(billingPeriods)
    .where(eq(billingPeriods.id, periodId))
    .limit(1);
  return refreshed[0]!;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/**
 * BILLING PERIODS — the month, as an object.
 *
 * A period fixes three things nobody should be free to reinterpret later:
 * the window subs may submit in, the date work is billed THROUGH, and when
 * the owner application goes out. Closing it stops new billing; locking it
 * freezes the numbers, which is what makes a monthly cost report reproducible
 * a year later in front of an auditor.
 *
 * Periods on a project may not overlap. Two open windows covering the same
 * day is how the same work gets billed twice.
 */
export const periodRoutes: FastifyPluginAsync = async (app) => {
  const companyGate = [app.authenticate, app.requireCompany];
  const readGate = [...companyGate, app.requireTool("invoicing", "read")];
  const standardGate = [...companyGate, app.requireTool("invoicing", "standard")];
  const adminGate = [...companyGate, app.requireTool("invoicing", "admin")];

  function assertDateWindow(
    startDate: string,
    endDate: string,
    billingDate: string,
    submitStart?: string | null,
    submitEnd?: string | null,
  ): void {
    if (startDate > endDate) {
      throw badRequest(
        `Billing period starts ${startDate} and ends ${endDate} — the window runs backwards.`,
      );
    }
    if (billingDate < startDate || billingDate > endDate) {
      throw badRequest(
        `billingDate ${billingDate} sits outside the period ${startDate}..${endDate}. The date ` +
          "work is billed through must fall inside the window it bills.",
      );
    }
    if (submitStart && submitEnd && submitStart > submitEnd) {
      throw badRequest(
        `The subcontractor submission window runs backwards (${submitStart}..${submitEnd}).`,
      );
    }
  }

  async function assertNoOverlap(
    projectId: string,
    startDate: string,
    endDate: string,
    excludeId?: string,
  ): Promise<void> {
    const rows = await app.db
      .select({
        id: billingPeriods.id,
        reference: billingPeriods.reference,
        name: billingPeriods.name,
        startDate: billingPeriods.startDate,
        endDate: billingPeriods.endDate,
      })
      .from(billingPeriods)
      .where(eq(billingPeriods.projectId, projectId));
    const clash = rows.find(
      (r) => r.id !== excludeId && r.startDate <= endDate && startDate <= r.endDate,
    );
    if (clash) {
      throw conflict(
        `Billing period ${clash.reference} (${clash.name}) already covers ` +
          `${clash.startDate}..${clash.endDate}, which overlaps ${startDate}..${endDate}. ` +
          "Overlapping periods let the same work be billed twice.",
      );
    }
  }

  app.post("/projects/:projectId/billing-periods", { preHandler: standardGate }, async (req, reply) => {
    const body = periodCreateSchema.parse(req.body);
    const projectId = req.projectId!;
    const billingDate = body.billingDate ?? body.endDate;
    assertDateWindow(
      body.startDate,
      body.endDate,
      billingDate,
      body.subcontractorSubmitStart,
      body.subcontractorSubmitEnd,
    );
    await assertNoOverlap(projectId, body.startDate, body.endDate);

    const number = await nextRecordNumber(app.db, projectId, PERIOD_COUNTER);
    const id = newId("bpd");
    await app.db.insert(billingPeriods).values({
      id,
      companyId: req.companyId!,
      projectId,
      number,
      reference: periodReference(number),
      name: body.name,
      status: "open",
      startDate: body.startDate,
      endDate: body.endDate,
      billingDate,
      subcontractorSubmitStart: body.subcontractorSubmitStart ?? null,
      subcontractorSubmitEnd: body.subcontractorSubmitEnd ?? null,
      ownerBillingDate: body.ownerBillingDate ?? null,
      dueDate: body.dueDate ?? null,
      notes: body.notes ?? null,
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });
    const row = await fetchPeriod(app.db, id, req.companyId!);
    await ledger(app.db, req, "create", "billing_period", id, {
      reference: row.reference,
      startDate: row.startDate,
      endDate: row.endDate,
      billingDate: row.billingDate,
    }, projectId);
    return reply.status(201).send(row);
  });

  app.get("/projects/:projectId/billing-periods", { preHandler: readGate }, async (req) => {
    const q = periodListQuery.parse(req.query);
    const where = q.status
      ? and(eq(billingPeriods.projectId, req.projectId!), eq(billingPeriods.status, q.status))
      : eq(billingPeriods.projectId, req.projectId!);
    const [totalRow] = await app.db.select({ n: count() }).from(billingPeriods).where(where);
    const items = await app.db
      .select()
      .from(billingPeriods)
      .where(where)
      .orderBy(desc(billingPeriods.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /** The period nothing has closed yet — what a "bill now" button needs. */
  app.get("/projects/:projectId/billing-periods/current", { preHandler: readGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(billingPeriods)
      .where(
        and(eq(billingPeriods.projectId, req.projectId!), eq(billingPeriods.status, "open")),
      )
      .orderBy(asc(billingPeriods.startDate));
    const today = new Date().toISOString().slice(0, 10);
    const covering = rows.find((r) => r.startDate <= today && today <= r.endDate);
    return {
      period: covering ?? rows[0] ?? null,
      openCount: rows.length,
      reasons:
        rows.length === 0
          ? ["No open billing period on this project — open one before billing."]
          : covering
            ? []
            : [`No open period covers today (${today}); the earliest open period is offered.`],
    };
  });

  app.get("/billing-periods/:periodId", { preHandler: companyGate }, async (req, reply) => {
    const { periodId } = req.params as { periodId: string };
    const period = await fetchPeriod(app.db, periodId, req.companyId!);
    await requireInvoicingLevel(app, req, reply, period.projectId, "read");
    const rows = await app.db
      .select({
        id: invoices.id,
        kind: invoices.kind,
        reference: invoices.reference,
        status: invoices.status,
        currency: invoices.currency,
        vendorId: invoices.vendorId,
        totalCompletedAndStored: invoices.totalCompletedAndStored,
        totalRetainage: invoices.totalRetainage,
        currentPaymentDue: invoices.currentPaymentDue,
        amountPaid: invoices.amountPaid,
      })
      .from(invoices)
      .where(eq(invoices.billingPeriodId, periodId))
      .orderBy(asc(invoices.kind), asc(invoices.number));
    return { ...period, invoices: rows };
  });

  app.patch("/billing-periods/:periodId", { preHandler: companyGate }, async (req, reply) => {
    const { periodId } = req.params as { periodId: string };
    const body = periodPatchSchema.parse(req.body);
    const period = await fetchPeriod(app.db, periodId, req.companyId!);
    await requireInvoicingLevel(app, req, reply, period.projectId, "standard");
    if (period.status === "locked") {
      throw conflict(
        `Billing period ${period.reference} is locked — its figures are frozen for reporting ` +
          "and cannot be edited.",
      );
    }
    const startDate = body.startDate ?? period.startDate;
    const endDate = body.endDate ?? period.endDate;
    const billingDate = body.billingDate ?? period.billingDate;
    const submitStart =
      body.subcontractorSubmitStart !== undefined
        ? body.subcontractorSubmitStart
        : period.subcontractorSubmitStart;
    const submitEnd =
      body.subcontractorSubmitEnd !== undefined
        ? body.subcontractorSubmitEnd
        : period.subcontractorSubmitEnd;
    assertDateWindow(startDate, endDate, billingDate, submitStart, submitEnd);
    if (startDate !== period.startDate || endDate !== period.endDate) {
      await assertNoOverlap(period.projectId, startDate, endDate, periodId);
    }
    await app.db
      .update(billingPeriods)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        startDate,
        endDate,
        billingDate,
        subcontractorSubmitStart: submitStart,
        subcontractorSubmitEnd: submitEnd,
        ...(body.ownerBillingDate !== undefined
          ? { ownerBillingDate: body.ownerBillingDate }
          : {}),
        ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.detail !== undefined ? { detail: body.detail } : {}),
        updatedAt: nowIso(),
      })
      .where(eq(billingPeriods.id, periodId));
    const row = await fetchPeriod(app.db, periodId, req.companyId!);
    await ledger(app.db, req, "update", "billing_period", periodId, {
      startDate: row.startDate,
      endDate: row.endDate,
      billingDate: row.billingDate,
    }, period.projectId);
    return row;
  });

  /**
   * Close the month. Invoices still mid-flight are named and the close is
   * refused, because closing over a submitted invoice strands it: it can
   * neither be approved into the closed period nor moved out of it silently.
   * `force: true` closes anyway, and says which invoices it stranded.
   */
  app.post("/billing-periods/:periodId/close", { preHandler: companyGate }, async (req, reply) => {
    const { periodId } = req.params as { periodId: string };
    const body = closeSchema.parse(req.body ?? {});
    const period = await fetchPeriod(app.db, periodId, req.companyId!);
    await requireInvoicingLevel(app, req, reply, period.projectId, "admin");
    if (period.status !== "open") {
      throw conflict(`Billing period ${period.reference} is already ${period.status}`);
    }
    const openInvoices = await app.db
      .select({
        id: invoices.id,
        reference: invoices.reference,
        status: invoices.status,
        kind: invoices.kind,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.billingPeriodId, periodId),
          inArray(invoices.status, ["draft", "submitted", "under_review", "revise_and_resubmit"]),
        ),
      );
    if (openInvoices.length > 0 && !body.force) {
      throw conflict(
        `Billing period ${period.reference} still holds ${openInvoices.length} invoice(s) that ` +
          `are neither approved nor rejected: ${openInvoices
            .map((i) => `${i.reference} (${i.status})`)
            .join(", ")}. Settle them, or close with force to strand them deliberately.`,
      );
    }
    const now = nowIso();
    await app.db
      .update(billingPeriods)
      .set({
        status: "closed",
        closedAt: now,
        closedBy: req.user!.id,
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        updatedAt: now,
      })
      .where(eq(billingPeriods.id, periodId));
    const row = await recomputePeriodRollups(app.db, periodId);
    await ledger(app.db, req, "state_change", "billing_period", periodId, {
      from: "open",
      to: "closed",
      forced: body.force === true,
      strandedInvoices: openInvoices.map((i) => i.reference),
      rollups: {
        ownerBilledAmount: row.ownerBilledAmount,
        subcontractorBilledAmount: row.subcontractorBilledAmount,
        retainageHeldAmount: row.retainageHeldAmount,
        invoiceCount: row.invoiceCount,
      },
    }, period.projectId, true);
    return { ...row, strandedInvoices: openInvoices };
  });

  app.post("/billing-periods/:periodId/reopen", { preHandler: companyGate }, async (req, reply) => {
    const { periodId } = req.params as { periodId: string };
    const body = z.object({ reason: z.string().min(1).max(4000) }).parse(req.body);
    const period = await fetchPeriod(app.db, periodId, req.companyId!);
    await requireInvoicingLevel(app, req, reply, period.projectId, "admin");
    if (period.status === "locked") {
      throw conflict(
        `Billing period ${period.reference} is locked. A locked period is the frozen basis of a ` +
          "published cost report and is never reopened — open a new period instead.",
      );
    }
    if (period.status !== "closed") {
      throw conflict(`Billing period ${period.reference} is ${period.status}, not closed`);
    }
    const now = nowIso();
    await app.db
      .update(billingPeriods)
      .set({ status: "open", closedAt: null, closedBy: null, updatedAt: now })
      .where(eq(billingPeriods.id, periodId));
    await ledger(app.db, req, "state_change", "billing_period", periodId, {
      from: "closed",
      to: "open",
      reason: body.reason,
    }, period.projectId, true);
    return fetchPeriod(app.db, periodId, req.companyId!);
  });

  /**
   * Lock. One-way, and only from closed: this is the act that makes the
   * month's numbers citable. Everything downstream — the cost report, the
   * budget snapshot, the owner's certified position — is allowed to assume a
   * locked period never moves again.
   */
  app.post("/billing-periods/:periodId/lock", { preHandler: companyGate }, async (req, reply) => {
    const { periodId } = req.params as { periodId: string };
    const period = await fetchPeriod(app.db, periodId, req.companyId!);
    await requireInvoicingLevel(app, req, reply, period.projectId, "admin");
    if (period.status === "locked") {
      throw conflict(`Billing period ${period.reference} is already locked`);
    }
    if (period.status !== "closed") {
      throw conflict(
        `Billing period ${period.reference} must be closed before it can be locked — locking an ` +
          "open period would freeze a month that is still being billed.",
      );
    }
    const row = await recomputePeriodRollups(app.db, periodId);
    const now = nowIso();
    await app.db
      .update(billingPeriods)
      .set({ status: "locked", lockedAt: now, lockedBy: req.user!.id, updatedAt: now })
      .where(eq(billingPeriods.id, periodId));
    await ledger(app.db, req, "state_change", "billing_period", periodId, {
      from: "closed",
      to: "locked",
      frozen: {
        ownerBilledAmount: row.ownerBilledAmount,
        subcontractorBilledAmount: row.subcontractorBilledAmount,
        retainageHeldAmount: row.retainageHeldAmount,
        retainageReleasedAmount: row.retainageReleasedAmount,
        invoiceCount: row.invoiceCount,
      },
    }, period.projectId, true);
    return fetchPeriod(app.db, periodId, req.companyId!);
  });

  /** Re-derive the rollup columns on demand — the reconciliation read. */
  app.post("/billing-periods/:periodId/recalculate", { preHandler: companyGate }, async (req, reply) => {
    const { periodId } = req.params as { periodId: string };
    const period = await fetchPeriod(app.db, periodId, req.companyId!);
    await requireInvoicingLevel(app, req, reply, period.projectId, "standard");
    if (period.status === "locked") {
      throw conflict(
        `Billing period ${period.reference} is locked — its rollups are frozen deliberately.`,
      );
    }
    return recomputePeriodRollups(app.db, periodId);
  });
};
