import type { FastifyPluginAsync } from "fastify";
import { backchargeRoutes } from "./backcharges.js";
import { changeRoutes } from "./changes.js";
import { closeoutRoutes } from "./closeout.js";
import { commitmentRoutes } from "./commitments.js";
import { complianceSweepRoutes } from "./compliance-sweep.js";
import { contractDocumentRoutes } from "./documents.js";
import { paymentRoutes } from "./payments.js";
import { paymentRunRoutes } from "./runs.js";
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
 *     ONE writer (allocation.ts) lands change value on the schedule, for both
 *     this module's CCOs and the change-management module's packages.
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
 *     payment hold refuses at every strictness. A daily sweep warns BEFORE
 *     cover runs out (#532).
 *
 * Every money move runs in one transaction with the row locked and every
 * money-moving POST honours `Idempotency-Key` (plan §6.2). Money in different
 * currencies is never summed — rollups bucket by currency and say so — and a
 * figure that cannot be derived is returned as `{ value: null, reasons }`.
 *
 * Upgrade wave additions (WP-FIN2): contract document generation + signature
 * routing (#525–527), backcharges (#538), closeout checklist + final release
 * (#539), payment runs + remittance advices (#586–594), compliance expiry
 * sweep (#532).
 *
 * Tables: commitments, commitment_sov_lines, commitment_changes,
 * commitment_payments, backcharges, contract_documents, commitment_closeouts,
 * payment_runs, compliance_sweep_state, idempotency_keys. Read-only across
 * the boundary: budgets, budget_line_items, invoices, invoice_line_items,
 * lien_waivers, insurance_certificates, bonds, vendors, prime_contracts.
 */
export const commitmentsModule: FastifyPluginAsync = async (app) => {
  await app.register(commitmentRoutes);
  await app.register(sovRoutes);
  await app.register(changeRoutes);
  await app.register(paymentRoutes);
  await app.register(reportRoutes);
  await app.register(backchargeRoutes);
  await app.register(closeoutRoutes);
  await app.register(contractDocumentRoutes);
  await app.register(paymentRunRoutes);
  await app.register(complianceSweepRoutes);
};
