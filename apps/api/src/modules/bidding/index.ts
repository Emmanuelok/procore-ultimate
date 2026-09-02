import type { FastifyPluginAsync } from "fastify";
import { awardRoutes } from "./awards.js";
import { invitationRoutes } from "./invitations.js";
import { levellingRoutes } from "./levelling.js";
import { packageRoutes } from "./packages.js";
import { prequalificationRoutes } from "./prequalification.js";
import { scoringRoutes } from "./scoring.js";
import { submissionRoutes } from "./submissions.js";

/**
 * BIDDING, TENDERING & PREQUALIFICATION (M25) — tool key `bidding`.
 *
 * FOUR CONTROLS CARRY THIS MODULE. Everything else is bookkeeping around them.
 *
 *  1. SEALED BIDDING IS A CONTROL, NOT A FLAG (sealing.ts). While a package is
 *     sealed and unopened, NO endpoint returns a submitted amount — not the
 *     submission detail, not the list, not the priced lines, not the levelling
 *     grid, not the scoring, not the tabulation report, and not the package's
 *     own rollups. The withholding happens in one function on the way out of
 *     every read path, because a control implemented in nine places is a
 *     control missing from the tenth. The seal lifts only when the published
 *     time has passed AND an opening is recorded by a named opener with a
 *     named witness who is not the opener. Opening early is refused; opening
 *     unwitnessed where a witness is required is refused; the opening itself
 *     is a ledgered event carrying both people, the hashes of the envelopes
 *     and the number of bids in the room.
 *
 *  2. LEVELLING IS THE ANALYTICAL CORE (levelling-math.ts). The buyer defines
 *     neutral scope rows; every bidder's price is mapped onto them with an
 *     inclusion status and an adjustment that STATES ITS REASON; the levelled
 *     amount, never the as-bid amount, is what gets compared. The arithmetic
 *     is a pure, separately tested function whose hardest job is refusing to
 *     produce a number: an exclusion with no adjustment, a partial inclusion
 *     left at face value, an unclear answer and an unexplained adjustment all
 *     yield null with a sentence rather than a figure. `POST
 *     /levelling/complete` refuses while any bidder still in contention has
 *     left a mandatory row unanswered, and names every one.
 *
 *  3. THE AWARD RECORDS WHY THE LOWEST BID WAS NOT TAKEN (awards.ts).
 *     `isLowestBid` and `notLowestJustification` are the two columns every
 *     procurement audit asks for, and the lowest bid amount is recorded
 *     alongside whether or not it was taken. A recommendation that is not the
 *     lowest comparable bid is REFUSED without a written justification.
 *     Approval is by someone who is neither the author nor the recommender,
 *     and on approval the award creates the COMMITMENT — in the commitments
 *     module, through its own reference builder, schedule-of-values insert,
 *     totals recompute and budget sync — with `bid_awards.commitmentId` as the
 *     seam. Unsuccessful bidders are told, and a standstill period blocks
 *     contract issue until it expires.
 *
 *  4. PREQUALIFICATION IS COMPANY-LEVEL AND IT EXPIRES (prequalification.ts,
 *     prequal-status.ts). Questionnaires reuse the shared ChecklistItemType
 *     vocabulary and its validator; a KNOCKOUT failure fails the submission
 *     outright regardless of score and the reason NAMES the question.
 *     Financial screening derives working capital, ratios and a recommended
 *     single-project limit from a stated, tested rule with its basis exposed —
 *     never a bare number, and never a number at all where turnover is
 *     unknown. Approvals expire; an approval inside its renewal window raises
 *     an obligation, and a lapsed one raises a Signal, through exactly the
 *     lazy-sweep machinery insurance certificate expiry uses. An invitation to
 *     a lapsed vendor is flagged; awarding to one is refused or warned per the
 *     package's configured strictness, naming the lapse either way.
 *
 * Money discipline throughout: figures in different currencies are never
 * summed and never ranked against each other, and anything the platform
 * cannot derive is `{ value: null, reasons: [...] }` rather than a zero that
 * reads like an answer.
 *
 * Route surface, all under `/api/v1`:
 *   /projects/:projectId/bid-packages ... (+ invitations, submissions,
 *     levelling, scoring, awards, addenda, tabulation)
 *   /bid-invitations/:invitationId/...      /bid-portal/...   (hashed token)
 *   /bid-submissions/:submissionId/...      /bid-levelling-*  /bid-awards/...
 *   /companies/current/prequalification/... (questionnaires, submissions,
 *     financials, vendors)
 */
export const biddingModule: FastifyPluginAsync = async (app) => {
  await app.register(packageRoutes);
  await app.register(invitationRoutes);
  await app.register(submissionRoutes);
  await app.register(levellingRoutes);
  await app.register(scoringRoutes);
  await app.register(awardRoutes);
  await app.register(prequalificationRoutes);
};
