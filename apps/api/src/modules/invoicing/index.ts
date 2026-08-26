import type { FastifyPluginAsync } from "fastify";
import { periodRoutes } from "./periods.js";
import { invoiceRoutes } from "./invoices.js";
import { retainageRoutes } from "./retainage.js";
import { waiverRoutes } from "./waivers.js";
import { paymentRoutes } from "./payments.js";
import { reportRoutes } from "./reports.js";

/**
 * INVOICING (M6, spec Vol I §3.5) — the money actually moving.
 *
 * Billing in both directions off the same schedule of values: owner
 * applications for payment against a prime contract, and subcontractor
 * invoices against a commitment. One `invoices` table with a `kind`
 * discriminator, one implementation of the AIA G702/G703 arithmetic
 * (./arithmetic.ts), and two workflows that differ only in who signs.
 *
 * THE FIVE CONTROLS THIS MODULE EXISTS TO ENFORCE
 *
 *   1. A closed billing period takes no new billing, and a locked one takes
 *      no writes at all. That is what makes a monthly cost report
 *      reproducible a year later.
 *
 *   2. Billing past a schedule-of-values line is refused, with the overage
 *      named to the cent. Percent complete cannot regress without a stated
 *      credit reason.
 *
 *   3. Retainage moves only through an approved release, approved by someone
 *      who is neither its author nor its requester, and the held position is
 *      re-derived from the SOV at approval rather than trusted from the
 *      draft.
 *
 *   4. Paying an invoice whose required lien waiver is not on file is
 *      refused. It can be overridden with a reason, and the payment is then
 *      recorded ON HOLD — the money does not move and the exposure stays on
 *      the outstanding-waiver report.
 *
 *   5. The approver is never the author or the submitter (ADR 0004), a
 *      rejection always carries a reason, and every transition is ledgered.
 *
 * MONEY DISCIPLINE. Figures in different currencies are never summed: every
 * report returns per-currency buckets. A figure the platform cannot derive
 * comes back as null with reasons, never as a fabricated zero.
 *
 * Tables: billing_periods, invoices, invoice_line_items, payment_applications,
 * retainage_releases, lien_waivers (plus commitment_payments on the pay side).
 * Tool key: `invoicing`.
 */
export const invoicingModule: FastifyPluginAsync = async (app) => {
  await app.register(periodRoutes);
  await app.register(invoiceRoutes);
  await app.register(retainageRoutes);
  await app.register(waiverRoutes);
  await app.register(paymentRoutes);
  await app.register(reportRoutes);
};
