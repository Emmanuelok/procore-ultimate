import type { FastifyPluginAsync } from "fastify";

/**
 * BIDDING, TENDERING & PREQUALIFICATION (M25) — tool key `bidding`.
 *
 * Packages scoped by spec section, invitations with response tracking,
 * submissions with line items, and the module's real product: LEVELLING — a
 * neutral scope row per package, every bidder mapped onto it, and each
 * adjustment carrying a stated reason so the comparison survives a challenge.
 * Award records why the lowest bid was not taken and hands off into
 * `commitments` (financials.ts). Prequalification is company-level and
 * expires.
 *
 * Schema: packages/db/src/schema/bidding.ts —
 *   bid_packages, bid_invitations, bid_submissions, bid_submission_lines,
 *   bid_levelling_items, bid_levelling_entries, bid_awards,
 *   prequalification_questionnaires, prequalification_questions,
 *   prequalification_submissions, prequalification_responses,
 *   prequalification_financials.
 *
 * Planned route surface, all under `/api/v1`:
 *   /projects/:projectId/bid-packages      (+ /:id/invitations, /submissions,
 *                                             /levelling, /award)
 *   /companies/current/prequalification/questionnaires
 *   /companies/current/prequalification/submissions
 *   /companies/current/prequalification/financials
 *
 * Routes land in a follow-up; registering the empty plugin now fixes the
 * mount point and the tool key so nothing has to be renamed later.
 */
export const biddingModule: FastifyPluginAsync = async () => {
  // Routes to follow.
};
