import type { FastifyPluginAsync } from "fastify";
import { analyticsRoutes } from "./analytics.js";
import { awardRoutes } from "./awards.js";
import { engagementRoutes } from "./engagement.js";
import { integrityRoutes } from "./integrity-routes.js";
import { invitationRoutes } from "./invitations.js";
import { registerBiddingJobs } from "./jobs.js";
import { levellingRoutes } from "./levelling.js";
import { opportunityRoutes } from "./opportunities.js";
import { packageRoutes } from "./packages.js";
import { prequalificationRoutes } from "./prequalification.js";
import { scoringRoutes } from "./scoring.js";
import { submissionRoutes } from "./submissions.js";

/**
 * BIDDING, TENDERING & PREQUALIFICATION (M25) — tool key `bidding`.
 *
 * SIX CONTROLS CARRY THIS MODULE. Everything else is bookkeeping around them.
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
 *  5. THE PATTERN IS THE FINDING (integrity.ts). A rigged tender does not look
 *     wrong from inside one package: every bid is signed, every envelope is
 *     sealed and every price differs. The signature of collusion is
 *     STATISTICAL — three totals inside 1.5% of each other, two bidders
 *     quoting the identical unit rate on the same scope row, one bidder's
 *     whole bill a constant multiple of another's, bids arriving within ten
 *     minutes of each other after a month-long tender period — and across
 *     packages it is one company always losing to the same winner in one
 *     trade, and winners rotating with the evenness of a rota. The detectors
 *     are pure functions over facts; each finding carries the statistic it was
 *     computed from, is raised once (fingerprinted) on the `signals` register,
 *     and must be ACKNOWLEDGED IN WRITING before a bidder can be recommended.
 *     A finding is a question, not an accusation, and the ordinary answer is
 *     an innocent explanation recorded next to it.
 *
 *  6. THE DECISION THAT COSTS MOST IS TAKEN BEFORE THE PACKAGE EXISTS
 *     (opportunities.ts). Whether to chase a job at all is normally decided in
 *     a meeting and defended afterwards from memory. It is modelled here as a
 *     gate with three separate parts kept apart: the scored judgement, a win
 *     probability FITTED from this company's own outcomes (and refused, with
 *     reasons, where the history is too thin to fit anything), and the
 *     decision itself with its written basis — recorded whether or not it
 *     agreed with either. The disagreements are the interesting ones. Tender
 *     costs are captured against the pursuit so "what does a win cost" is a
 *     figure rather than a feeling.
 *
 * Money discipline throughout: figures in different currencies are never
 * summed and never ranked against each other, and anything the platform
 * cannot derive is `{ value: null, reasons: [...] }` rather than a zero that
 * reads like an answer.
 *
 * Route surface, all under `/api/v1`:
 *   /projects/:projectId/bid-packages ... (+ invitations, submissions,
 *     levelling, scoring, awards, addenda, tabulation, questions, meetings,
 *     bonds, integrity, scope-gaps, document-access, publish, health-inputs)
 *   /bid-invitations/:invitationId/...      /bid-portal/...   (hashed token)
 *   /bid-submissions/:submissionId/...      /bid-levelling-*  /bid-awards/...
 *   /bid-bonds/:bondId/status
 *   /companies/current/prequalification/... (questionnaires, submissions,
 *     financials, vendors)
 *   /companies/current/opportunities/...    (pipeline, bid/no-bid, outcomes)
 *   /companies/current/{bid-board, bid-coverage, bid-pricing, bid-integrity,
 *     win-rate, cost-of-sale, tender-costs, award-delegations,
 *     vendors/:vendorId/bid-history}
 *
 * Scheduled sweeps (jobs.ts): prequalification expiry, bid bond expiry,
 * tender deadlines and bid validity, the integrity detectors, and pursuits
 * whose submission date passed with no outcome.
 */
export const biddingModule: FastifyPluginAsync = async (app) => {
  await app.register(packageRoutes);
  await app.register(invitationRoutes);
  await app.register(submissionRoutes);
  await app.register(levellingRoutes);
  await app.register(scoringRoutes);
  await app.register(awardRoutes);
  await app.register(prequalificationRoutes);
  /* platform upgrade wave */
  await app.register(engagementRoutes);
  await app.register(integrityRoutes);
  await app.register(opportunityRoutes);
  await app.register(analyticsRoutes);
  registerBiddingJobs(app);
};
