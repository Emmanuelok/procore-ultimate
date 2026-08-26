import type { FastifyPluginAsync } from "fastify";

/**
 * MEETINGS (M20, spec Vol I §2.9) — tool key `meetings`.
 *
 * Series and occurrences, attendance (present / absent / apologies), agenda
 * items that carry forward with a visible carry count, minuted decisions with
 * independent ratification, and ACTION ITEMS — which carry the full
 * Obligation shape so an action that discharges a contractual duty can be
 * promoted into an `obligations` row (assurance.ts, ADR 0012) rather than
 * re-keyed.
 *
 * Schema: packages/db/src/schema/meetings.ts —
 *   meeting_series, meetings, meeting_attendees, meeting_agenda_items,
 *   meeting_decisions, meeting_action_items.
 *
 * Planned route surface, all under `/api/v1`:
 *   /projects/:projectId/meeting-series
 *   /projects/:projectId/meetings          (+ /:id/attendees, /agenda-items,
 *                                             /decisions, /minutes)
 *   /projects/:projectId/action-items       (+ /:id/promote → obligation)
 *
 * Routes land in a follow-up; registering the empty plugin now fixes the
 * mount point and the tool key so nothing has to be renamed later.
 */
export const meetingsModule: FastifyPluginAsync = async () => {
  // Routes to follow.
};
