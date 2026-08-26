import type { FastifyPluginAsync } from "fastify";

/**
 * TIMECARDS, CREWS & T&M TICKETS (M24) — tool key `timecards`.
 *
 * Crews and dated membership over the EXISTING worker register
 * (`workers`, workforce.ts — no second person table), timecards per worker
 * per day reconciled against `site_access_records`, cost-code allocations
 * that land labour on `budget_line_items` (financials.ts), a segregated
 * approval trail that records attempted self-approval rather than merely
 * refusing it, and time-and-materials tickets signed on site by the client's
 * representative.
 *
 * Schema: packages/db/src/schema/timecards.ts —
 *   crews, crew_members, timecard_batches, timecards, timecard_allocations,
 *   timecard_approvals, tm_tickets, tm_ticket_lines.
 *
 * Planned route surface, all under `/api/v1`:
 *   /projects/:projectId/crews             (+ /:id/members)
 *   /projects/:projectId/timecards         (+ /:id/allocations, /:id/approve)
 *   /projects/:projectId/timecard-batches  (+ /:id/submit, /:id/approve)
 *   /projects/:projectId/tm-tickets        (+ /:id/lines, /:id/sign)
 *
 * Routes land in a follow-up; registering the empty plugin now fixes the
 * mount point and the tool key so nothing has to be renamed later.
 */
export const timecardsModule: FastifyPluginAsync = async () => {
  // Routes to follow.
};
