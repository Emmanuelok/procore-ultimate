import type { FastifyPluginAsync } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  billingPeriods,
  commitmentSovLines,
  commitments,
  invoices,
  lienWaivers,
  primeContractSovLines,
  primeContracts,
  projects,
  vendors,
} from "@constructos/db";
import { INVOICE_KINDS } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import {
  AGING_BUCKET_LABELS,
  AGING_BUCKETS,
  agingBucketFor,
  emptyBuckets,
  type AgingBucket,
} from "./arithmetic.js";
import {
  outstandingOf,
  CENT,
  LIVE_INVOICE_STATUSES,
  byCurrency,
  daysBetween,
  isoDateSchema,
  round2,
  todayIso,
} from "./shared.js";

/* ------------------------------------------------------------------ */
/* Aging                                                               */
/* ------------------------------------------------------------------ */

interface AgedInvoice {
  invoiceId: string;
  projectId: string;
  reference: string;
  invoiceNumber: string | null;
  kind: string;
  status: string;
  vendorId: string | null;
  vendorName: string | null;
  currency: string;
  outstanding: number;
  dueDate: string | null;
  daysOutstanding: number;
  bucket: AgingBucket;
  agedFrom: "due_date" | "billing_date";
}

interface UnagedInvoice {
  invoiceId: string;
  reference: string;
  currency: string;
  outstanding: number;
  reasons: string[];
}

type InvoiceForAging = typeof invoices.$inferSelect;

/**
 * Age one invoice, or refuse to.
 *
 * An invoice with neither a due date nor a billing date has no age. It is
 * NOT zero days old and it does not belong in the 0-30 bucket: it comes back
 * with `value: null` and a reason, exactly like a benchmark metric that
 * cannot be computed. A fabricated bucket here is how a 120-day-overdue
 * payable hides in "current".
 */
function ageInvoice(
  inv: InvoiceForAging,
  asOf: string,
  vendorName: Map<string, string>,
): AgedInvoice | UnagedInvoice {
  const outstanding = outstandingOf(inv);
  const anchor = inv.dueDate ?? inv.billingDate;
  if (!anchor) {
    return {
      invoiceId: inv.id,
      reference: inv.reference,
      currency: inv.currency,
      outstanding,
      reasons: [
        `Invoice ${inv.reference} carries neither a due date nor a billing date, so it cannot ` +
          "be aged. It is excluded from every bucket rather than assumed current.",
      ],
    };
  }
  const daysOutstanding = daysBetween(anchor, asOf);
  return {
    invoiceId: inv.id,
    projectId: inv.projectId,
    reference: inv.reference,
    invoiceNumber: inv.invoiceNumber,
    kind: inv.kind,
    status: inv.status,
    vendorId: inv.vendorId,
    vendorName: inv.vendorId ? (vendorName.get(inv.vendorId) ?? null) : null,
    currency: inv.currency,
    outstanding,
    dueDate: inv.dueDate,
    daysOutstanding,
    bucket: agingBucketFor(daysOutstanding),
    agedFrom: inv.dueDate ? "due_date" : "billing_date",
  };
}

const isAged = (x: AgedInvoice | UnagedInvoice): x is AgedInvoice => "bucket" in x;

function bucketTotals(rows: AgedInvoice[]): Record<AgingBucket, number> {
  const buckets = emptyBuckets();
  for (const r of rows) buckets[r.bucket] = round2(buckets[r.bucket] + r.outstanding);
  return buckets;
}

/** Aged rows folded per currency, then per vendor inside each currency. */
function agingByCurrency(rows: AgedInvoice[]) {
  return byCurrency(
    rows,
    (r) => r.currency,
    (list, currency) => {
      const vendorMap = new Map<string, AgedInvoice[]>();
      for (const r of list) {
        const key = r.vendorId ?? "__unassigned__";
        const existing = vendorMap.get(key);
        if (existing) existing.push(r);
        else vendorMap.set(key, [r]);
      }
      return {
        currency,
        buckets: bucketTotals(list),
        total: round2(list.reduce((s, r) => s + r.outstanding, 0)),
        invoiceCount: list.length,
        vendors: [...vendorMap.entries()]
          .map(([vendorId, invs]) => ({
            vendorId: vendorId === "__unassigned__" ? null : vendorId,
            vendorName: invs[0]?.vendorName ?? null,
            buckets: bucketTotals(invs),
            total: round2(invs.reduce((s, r) => s + r.outstanding, 0)),
            oldestDays: Math.max(...invs.map((r) => r.daysOutstanding)),
            invoices: invs
              .map((r) => ({
                invoiceId: r.invoiceId,
                reference: r.reference,
                invoiceNumber: r.invoiceNumber,
                status: r.status,
                dueDate: r.dueDate,
                daysOutstanding: r.daysOutstanding,
                bucket: r.bucket,
                outstanding: r.outstanding,
              }))
              .sort((a, b) => b.daysOutstanding - a.daysOutstanding),
          }))
          .sort((a, b) => b.total - a.total),
      };
    },
  );
}

async function loadVendorNames(db: Db, companyId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: vendors.id, name: vendors.name })
    .from(vendors)
    .where(eq(vendors.companyId, companyId));
  return new Map(rows.map((v) => [v.id, v.name]));
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/**
 * REPORTS — where the money is, and how late.
 *
 * Two rules govern every figure in this file and neither bends:
 *
 *   CURRENCY. Totals are bucketed by currency and never summed across them.
 *   A project running a USD subcontract and a EUR equipment PO gets two
 *   buckets, not one wrong number, because there is no FX rate on the record
 *   and inventing one is fabrication.
 *
 *   MISSING INPUTS. A figure that cannot be derived comes back as null with
 *   a reason, the same contract the benchmark metrics use. An invoice with
 *   no date is unaged, not current.
 */
export const reportRoutes: FastifyPluginAsync = async (app) => {
  const companyGate = [app.authenticate, app.requireCompany];
  const readGate = [...companyGate, app.requireTool("invoicing", "read")];

  const agingQuery = z.object({
    asOf: isoDateSchema.optional(),
    kind: z.enum(INVOICE_KINDS).optional(),
    vendorId: z.string().optional(),
  });

  async function liveInvoices(
    where: ReturnType<typeof and>,
  ): Promise<InvoiceForAging[]> {
    const rows = await app.db.select().from(invoices).where(where);
    return rows.filter(
      (i) =>
        (LIVE_INVOICE_STATUSES as readonly string[]).includes(i.status) &&
        outstandingOf(i) > CENT,
    );
  }

  /**
   * AGING, 0-30 / 31-60 / 61-90 / 90+, per vendor and per project.
   *
   * Age runs from the due date where there is one and from the billing date
   * where there is not — `agedFrom` says which, per invoice, because an
   * aging report whose basis is invisible is an aging report nobody trusts.
   * Boundaries are inclusive at the top of each band: 30 days is 0-30, 31 is
   * 31-60, 60 is 31-60, 61 is 61-90, 90 is 61-90, 91 is 90+.
   */
  /**
   * HEALTH INPUTS (plan §3.5) for the intelligence layer's `finance`
   * dimension. Counts and day-counts only: the money on this project may be
   * in several currencies and adding them would produce a health score that
   * is arithmetically wrong. Nothing here is invented — where a figure has no
   * basis it is null and the reason says so.
   */
  app.get("/projects/:projectId/invoicing/health-inputs", { preHandler: readGate }, async (req) => {
    const projectId = req.projectId!;
    const asOf = todayIso();
    const [live, waiverRows] = await Promise.all([
      app.db.select().from(invoices).where(eq(invoices.projectId, projectId)),
      app.db
        .select({ invoiceId: lienWaivers.invoiceId, status: lienWaivers.status })
        .from(lienWaivers)
        .where(eq(lienWaivers.projectId, projectId)),
    ]);
    const satisfying = new Set(
      waiverRows
        .filter((w) => ["received", "verified", "not_required"].includes(w.status))
        .map((w) => w.invoiceId)
        .filter((id): id is string => !!id),
    );
    const outstanding = live.filter(
      (i) => (LIVE_INVOICE_STATUSES as readonly string[]).includes(i.status) && outstandingOf(i) > CENT,
    );
    const overdue = outstanding.filter((i) => {
      const basis = i.dueDate ?? i.billingDate;
      return basis !== null && basis < asOf;
    });
    const undateable = outstanding.filter((i) => i.dueDate === null && i.billingDate === null);
    const awaitingApproval = live.filter((i) =>
      ["submitted", "under_review"].includes(i.status),
    ).length;
    const unwaived = live.filter(
      (i) =>
        i.requiresLienWaiver === 1 &&
        ["approved", "approved_as_noted", "paid"].includes(i.status) &&
        !satisfying.has(i.id),
    ).length;
    const ages = overdue
      .map((i) => daysBetween(i.dueDate ?? i.billingDate!, asOf))
      .sort((a, b) => b - a);
    const reasons: string[] = [];
    if (live.length === 0) reasons.push("Nothing has been billed on this project yet.");
    if (undateable.length > 0) {
      reasons.push(
        `${undateable.length} outstanding invoice(s) carry neither a due date nor a billing date and cannot be aged.`,
      );
    }
    return {
      projectId,
      asOf,
      metrics: {
        invoices: live.length,
        outstandingInvoices: outstanding.length,
        overdueInvoices: overdue.length,
        oldestOverdueDays: ages.length > 0 ? ages[0]! : null,
        invoicesAwaitingApproval: awaitingApproval,
        paidWithoutWaiverOnFile: unwaived,
        undateableInvoices: undateable.length,
      },
      reasons,
    };
  });

  app.get("/projects/:projectId/invoicing/aging", { preHandler: readGate }, async (req) => {
    const q = agingQuery.parse(req.query ?? {});
    const asOf = q.asOf ?? todayIso();
    const clauses = [eq(invoices.projectId, req.projectId!)];
    if (q.kind) clauses.push(eq(invoices.kind, q.kind));
    if (q.vendorId) clauses.push(eq(invoices.vendorId, q.vendorId));
    const rows = await liveInvoices(and(...clauses));
    const vendorName = await loadVendorNames(app.db, req.companyId!);
    const scored = rows.map((r) => ageInvoice(r, asOf, vendorName));
    const aged = scored.filter(isAged);
    const unaged = scored.filter((x): x is UnagedInvoice => !isAged(x));

    return {
      asOf,
      projectId: req.projectId!,
      bucketLabels: AGING_BUCKET_LABELS,
      bucketDefinition:
        "Days outstanding are measured to the due date where one exists, otherwise the billing " +
        "date. Bands are inclusive at the top: 0-30, 31-60, 61-90, 90+.",
      /** money owed TO us on owner applications */
      receivable: { byCurrency: agingByCurrency(aged.filter((r) => r.kind === "owner_billing")) },
      /** money we owe on subcontractor invoices */
      payable: {
        byCurrency: agingByCurrency(aged.filter((r) => r.kind === "subcontractor_invoice")),
      },
      unaged,
      reasons: unaged.flatMap((u) => u.reasons),
    };
  });

  /**
   * Company-wide aging, rolled up per project and per vendor. Same buckets,
   * same currency discipline; a company-level total across projects is only
   * ever produced inside one currency.
   */
  app.get("/invoicing/aging", { preHandler: companyGate }, async (req) => {
    const q = agingQuery.parse(req.query ?? {});
    const asOf = q.asOf ?? todayIso();
    const clauses = [eq(invoices.companyId, req.companyId!)];
    if (q.kind) clauses.push(eq(invoices.kind, q.kind));
    if (q.vendorId) clauses.push(eq(invoices.vendorId, q.vendorId));
    const rows = await liveInvoices(and(...clauses));
    const [vendorName, projectRows] = await Promise.all([
      loadVendorNames(app.db, req.companyId!),
      app.db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(eq(projects.companyId, req.companyId!)),
    ]);
    const projectName = new Map(projectRows.map((p) => [p.id, p.name]));
    const scored = rows.map((r) => ageInvoice(r, asOf, vendorName));
    const aged = scored.filter(isAged);
    const unaged = scored.filter((x): x is UnagedInvoice => !isAged(x));

    const projectBuckets = new Map<string, AgedInvoice[]>();
    for (const r of aged) {
      const list = projectBuckets.get(r.projectId);
      if (list) list.push(r);
      else projectBuckets.set(r.projectId, [r]);
    }

    return {
      asOf,
      companyId: req.companyId!,
      bucketLabels: AGING_BUCKET_LABELS,
      receivable: { byCurrency: agingByCurrency(aged.filter((r) => r.kind === "owner_billing")) },
      payable: {
        byCurrency: agingByCurrency(aged.filter((r) => r.kind === "subcontractor_invoice")),
      },
      byProject: [...projectBuckets.entries()]
        .map(([projectId, list]) => ({
          projectId,
          projectName: projectName.get(projectId) ?? null,
          byCurrency: byCurrency(
            list,
            (r) => r.currency,
            (rowsIn, currency) => ({
              currency,
              buckets: bucketTotals(rowsIn),
              receivable: round2(
                rowsIn.filter((r) => r.kind === "owner_billing").reduce((s, r) => s + r.outstanding, 0),
              ),
              payable: round2(
                rowsIn
                  .filter((r) => r.kind === "subcontractor_invoice")
                  .reduce((s, r) => s + r.outstanding, 0),
              ),
            }),
          ),
        }))
        .sort((a, b) => (a.projectName ?? "").localeCompare(b.projectName ?? "")),
      unaged,
      reasons: unaged.flatMap((u) => u.reasons),
    };
  });

  /**
   * CASH POSITION — what is coming in, what is going out, and what is being
   * held back, per currency.
   *
   * Receivable and payable are reported side by side and netted ONLY inside
   * one currency. Retainage is shown separately from billed-unpaid because
   * it is not late — it is withheld by agreement, and a cash forecast that
   * treats retainage as overdue receivables is a cash forecast that lies.
   */
  app.get("/projects/:projectId/invoicing/cash-position", { preHandler: readGate }, async (req) => {
    const q = z.object({ asOf: isoDateSchema.optional() }).parse(req.query ?? {});
    const asOf = q.asOf ?? todayIso();
    const projectId = req.projectId!;
    const companyId = req.companyId!;

    const [invoiceRows, primes, subs, primeSov, subSov, periods] = await Promise.all([
      app.db.select().from(invoices).where(eq(invoices.projectId, projectId)),
      app.db
        .select()
        .from(primeContracts)
        .where(and(eq(primeContracts.projectId, projectId), eq(primeContracts.companyId, companyId))),
      app.db
        .select()
        .from(commitments)
        .where(and(eq(commitments.projectId, projectId), eq(commitments.companyId, companyId))),
      app.db
        .select({
          primeContractId: primeContractSovLines.primeContractId,
          retainageHeld: primeContractSovLines.retainageHeld,
        })
        .from(primeContractSovLines)
        .where(eq(primeContractSovLines.projectId, projectId)),
      app.db
        .select({
          commitmentId: commitmentSovLines.commitmentId,
          retainageHeld: commitmentSovLines.retainageHeld,
        })
        .from(commitmentSovLines)
        .where(eq(commitmentSovLines.projectId, projectId)),
      app.db
        .select()
        .from(billingPeriods)
        .where(and(eq(billingPeriods.projectId, projectId), eq(billingPeriods.status, "open"))),
    ]);

    const live = invoiceRows.filter((i) =>
      (LIVE_INVOICE_STATUSES as readonly string[]).includes(i.status),
    );
    const reasons: string[] = [];
    if (primes.length === 0) {
      reasons.push("No prime contract on this project — there is no revenue position to report.");
    }
    if (live.length === 0) {
      reasons.push("No live invoices on this project — the billed position is zero by evidence.");
    }

    const primeRetainage = new Map<string, number>();
    for (const l of primeSov) {
      primeRetainage.set(
        l.primeContractId,
        round2((primeRetainage.get(l.primeContractId) ?? 0) + l.retainageHeld),
      );
    }
    const subRetainage = new Map<string, number>();
    for (const l of subSov) {
      subRetainage.set(
        l.commitmentId,
        round2((subRetainage.get(l.commitmentId) ?? 0) + l.retainageHeld),
      );
    }

    interface Slice {
      currency: string;
      receivableBilledUnpaid: number;
      receivableRetainageHeldByOwner: number;
      payableInvoicedUnpaid: number;
      payableRetainageWeHold: number;
      receivableOverdue: number;
      payableOverdue: number;
    }
    const slices = new Map<string, Slice>();
    const slice = (currency: string): Slice => {
      const cur = currency.toUpperCase();
      let s = slices.get(cur);
      if (!s) {
        s = {
          currency: cur,
          receivableBilledUnpaid: 0,
          receivableRetainageHeldByOwner: 0,
          payableInvoicedUnpaid: 0,
          payableRetainageWeHold: 0,
          receivableOverdue: 0,
          payableOverdue: 0,
        };
        slices.set(cur, s);
      }
      return s;
    };

    for (const inv of live) {
      const outstanding = outstandingOf(inv);
      if (outstanding <= CENT) continue;
      const s = slice(inv.currency);
      const anchor = inv.dueDate ?? inv.billingDate;
      const overdue = anchor ? daysBetween(anchor, asOf) > 0 : false;
      if (inv.kind === "owner_billing") {
        s.receivableBilledUnpaid = round2(s.receivableBilledUnpaid + outstanding);
        if (overdue) s.receivableOverdue = round2(s.receivableOverdue + outstanding);
      } else {
        s.payableInvoicedUnpaid = round2(s.payableInvoicedUnpaid + outstanding);
        if (overdue) s.payableOverdue = round2(s.payableOverdue + outstanding);
      }
    }
    for (const c of primes) {
      const s = slice(c.currency);
      s.receivableRetainageHeldByOwner = round2(
        s.receivableRetainageHeldByOwner + (primeRetainage.get(c.id) ?? 0),
      );
    }
    for (const c of subs) {
      const s = slice(c.currency);
      s.payableRetainageWeHold = round2(
        s.payableRetainageWeHold + (subRetainage.get(c.id) ?? 0),
      );
    }

    const buckets = [...slices.values()]
      .sort((a, b) => a.currency.localeCompare(b.currency))
      .map((s) => ({
        ...s,
        /** billed-unpaid in minus billed-unpaid out; retainage excluded */
        netWorkingPosition: round2(s.receivableBilledUnpaid - s.payableInvoicedUnpaid),
        /** the same, with retainage on both sides — the end-of-job picture */
        netPositionIncludingRetainage: round2(
          s.receivableBilledUnpaid +
            s.receivableRetainageHeldByOwner -
            s.payableInvoicedUnpaid -
            s.payableRetainageWeHold,
        ),
      }));

    return {
      asOf,
      projectId,
      byCurrency: buckets,
      openBillingPeriods: periods.map((p) => ({
        id: p.id,
        reference: p.reference,
        name: p.name,
        startDate: p.startDate,
        endDate: p.endDate,
        billingDate: p.billingDate,
        dueDate: p.dueDate,
      })),
      currencyNote:
        buckets.length > 1
          ? `This project bills in ${buckets.length} currencies (${buckets
              .map((b) => b.currency)
              .join(", ")}). They are reported separately and are never summed — there is no ` +
            "exchange rate on the record."
          : null,
      reasons,
    };
  });

  /** Buckets as data, so a client can render the report without hard-coding. */
  app.get("/invoicing/aging-buckets", { preHandler: companyGate }, async () => ({
    buckets: AGING_BUCKETS.map((key) => ({ key, label: AGING_BUCKET_LABELS[key] })),
    definition:
      "Inclusive at the top of each band. 0-30 also holds invoices not yet due; an invoice " +
      "with no due date and no billing date is unaged and excluded.",
  }));
};
