import type { FastifyPluginAsync } from "fastify";
import { crewRoutes } from "./crews.js";
import { timecardRoutes } from "./cards.js";
import { batchRoutes } from "./batches.js";
import { reconcileRoutes } from "./reconcile.js";
import { tmTicketRoutes } from "./tickets.js";
import { timecardReportRoutes } from "./reports.js";

/**
 * TIMECARDS, CREWS & T&M TICKETS (M24) — tool key `timecards`.
 *
 * Labour is the only major cost on a construction project that is claimed,
 * approved and paid before anybody independently checks it. So this module is
 * not a timesheet screen with a total at the bottom; it is three
 * reconciliations with a timesheet attached:
 *
 *   1. CLAIMED vs PRESENT.  Every card's hours against `site_access_records`
 *      (workforce.ts) — the turnstile stream, which is independent evidence,
 *      as opposed to a foreman's crew sheet, which is the claimant's own
 *      assertion. Where no access record exists the variance is NULL with a
 *      reason, never zero: manufacturing a fraud finding out of a broken gate
 *      log is how a control gets switched off, and then the real overclaims
 *      go unseen too. A PATTERN of unexplained positive variance raises a
 *      signal, using the same detector idiom as the workforce ghost-worker
 *      reconciliation.
 *
 *   2. HOURS vs BUDGET.  `timecard_allocations` must reconcile with the card
 *      bucket by bucket — plain, overtime, double time, premium — or the set
 *      is refused with the difference named. That link is what puts labour on
 *      the cost report; a card with no allocation is hours nobody can code,
 *      which is how a labour overrun stays invisible until month end.
 *
 *   3. OUR HOURS vs THEIR SIGNATURE.  A `tm_ticket` is the hours the CLIENT's
 *      representative signed for, on site, on the day — or signed UNDER
 *      PROTEST, or REFUSED to sign. All three are recorded distinctly and an
 *      unsigned ticket never presents as signed. A ticket with a client-side
 *      response is promotable into the change-management module, which keeps
 *      the pricing; nothing here restates it.
 *
 * WORKERS ARE NOT DUPLICATED. Every `workerId` references `workers`
 * (workforce.ts) — the register that already carries identity verification,
 * induction, employer and agreed rate. This module adds crews, hours and cost
 * coding on top of it and creates no second person table.
 *
 * APPROVAL IS SEGREGATED AND PROVABLE. `timecard_approvals.isSelfApproval` is
 * a stored column on purpose: an attempted self-approval is WRITTEN — an
 * approval row, a `timecard_self_approval` signal, a ledger entry — and only
 * then refused. A control that silently blocks a breach leaves no evidence
 * the breach was attempted.
 *
 * Schema: packages/db/src/schema/timecards.ts —
 *   crews, crew_members, timecard_batches, timecards, timecard_allocations,
 *   timecard_approvals, tm_tickets, tm_ticket_lines.
 *
 * Route surface, all under `/api/v1`:
 *   /projects/:projectId/crews                (+ /:id/members, /:id/members/:memberId/end)
 *   /projects/:projectId/crew-membership      who was in which crew on a date
 *   /projects/:projectId/timecards            (+ /:id/allocations, /submit, /approve,
 *                                                /explain-variance, /lock, /revise)
 *   /projects/:projectId/timecards/reconcile  claimed vs present, persisted
 *   /projects/:projectId/timecards/reconciliation   the same engine, replayed
 *   /projects/:projectId/labour-cost-report   allocated labour by budget line
 *   /projects/:projectId/timecard-batches     (+ /collect, /submit, /approve, /lock, /export)
 *   /projects/:projectId/tm-tickets           (+ /lines, /lines/source, /sign,
 *                                                /submit, /promote)
 *
 * `read` sees everything; `standard` raises, codes, submits and approves; and
 * exactly three routes are `admin` — locking a card, locking a batch, and
 * exporting a batch to payroll — because after any of them a correction is a
 * new dated adjustment rather than an edit.
 */
export const timecardsModule: FastifyPluginAsync = async (app) => {
  await app.register(crewRoutes);
  await app.register(timecardRoutes);
  await app.register(batchRoutes);
  await app.register(reconcileRoutes);
  await app.register(tmTicketRoutes);
  await app.register(timecardReportRoutes);
};
