import type { FastifyPluginAsync } from "fastify";
import { changeRoutes } from "./changes.js";
import { commitmentRoutes } from "./commitments.js";
import { paymentRoutes } from "./payments.js";
import { reportRoutes } from "./reports.js";
import { sovRoutes } from "./sov.js";

/**
 * COMMITMENTS (M4, spec Vol I §3.3) — the buy side of the project.
 *
 * Subcontracts and purchase orders live in one table behind a `kind`
 * discriminator, with their schedules of values, their change orders and the
 * payments issued against them. Tool key: `commitments`.
 *
 * THE FOUR RULES THIS MODULE IS BUILT ON
 *
 *  1. THE SCHEDULE OF VALUES IS THE COMMITMENT SUM. `originalCommitmentSum`
 *     is never typed; it is SIGMA `scheduledValue` over the schedule, and
 *     `approvedChangeSum` is SIGMA `changeOrderValue`. There is no second
 *     place for the number to live, so the identity cannot drift — and the
 *     original subcontract figure stays legible however many change orders
 *     land on it, because a change-order line carries scheduledValue = 0.
 *
 *  2. AFTER APPROVAL THE SUM MOVES ONLY THROUGH CHANGE ORDERS, and a change
 *     order moves it exactly once, at approval. Execution records the signed
 *     paperwork and moves nothing — counting a change order twice is the
 *     classic way a commitment sum and its schedule stop agreeing.
 *
 *  3. EVERY COMMITMENT CONSUMES BUDGET. Each schedule line carries
 *     `budgetLineItemId`, and `budget_line_items.committed_cost` /
 *     `.pending_commitments` are re-derived from those lines on every
 *     consequential write. That join is what makes the buyout log — budget
 *     versus committed versus projected savings, per line — a fact rather
 *     than a spreadsheet somebody maintains by hand.
 *
 *  4. COMPLIANCE GATES PAYMENT. The insurance module's certificate and bond
 *     records are READ (never duplicated, never re-implemented) at the moment
 *     a payment is approved or issued. An expired certificate warns or
 *     refuses per the strictness configured on that commitment; an explicit
 *     payment hold refuses at every strictness.
 *
 * Money discipline throughout: figures in different currencies are never
 * summed — rollups bucket by currency and say so — and a figure that cannot
 * be derived is returned as `{ value: null, reasons: [...] }` rather than as
 * a zero that reads like an answer.
 *
 * Tables: commitments, commitment_sov_lines, commitment_changes,
 * commitment_payments. Read-only across the boundary: budgets,
 * budget_line_items, invoices, invoice_line_items, lien_waivers,
 * insurance_certificates, bonds, vendors, prime_contracts.
 */
export const commitmentsModule: FastifyPluginAsync = async (app) => {
  await app.register(commitmentRoutes);
  await app.register(sovRoutes);
  await app.register(changeRoutes);
  await app.register(paymentRoutes);
  await app.register(reportRoutes);
};
