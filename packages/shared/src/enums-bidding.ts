/**
 * Shared enums for the bidding area (platform upgrade wave).
 *
 * The pre-existing bidding vocabularies (package status, invitation status,
 * submission status, decline reason, evaluation method, prequalification
 * outcome…) live in `enums.ts` and are frozen. Everything the upgrade wave
 * adds — the opportunity pipeline, tender Q&A, pre-bid meetings, bid bonds,
 * cost of sale, document access logging, delegated award authority and the
 * bid-integrity detector family — is declared here.
 */

/* ------------------------------------------------------------------ */
/* Opportunity pipeline (#1052) and bid/no-bid (#1048)                 */
/* ------------------------------------------------------------------ */

/**
 * Where an opportunity stands. `bid_no_bid` is a stage of its own because
 * the decision to chase a job is the decision that costs the most money to
 * get wrong — it is not a status transition, it is a gate with a record.
 */
export const OPPORTUNITY_STAGES = [
  "identified",
  "qualifying",
  "bid_no_bid",
  "bidding",
  "submitted",
  "shortlisted",
  "won",
  "lost",
  "no_bid",
  "abandoned",
] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

/** Stages where the pursuit is still live and still consuming capacity. */
export const LIVE_OPPORTUNITY_STAGES = [
  "identified",
  "qualifying",
  "bid_no_bid",
  "bidding",
  "submitted",
  "shortlisted",
] as const;

export const OPPORTUNITY_SOURCES = [
  "public_notice",
  "framework_call_off",
  "direct_approach",
  "repeat_client",
  "referral",
  "portal",
  "competition",
  "other",
] as const;
export type OpportunitySource = (typeof OPPORTUNITY_SOURCES)[number];

export const BID_NO_BID_DECISIONS = ["pending", "bid", "no_bid", "conditional"] as const;
export type BidNoBidDecision = (typeof BID_NO_BID_DECISIONS)[number];

/**
 * The factors a bid/no-bid decision is actually taken on. Fixed vocabulary
 * so the pattern is visible in aggregate: a company that loses every job it
 * scored badly on `client_relationship` has learned something.
 */
export const BID_NO_BID_FACTORS = [
  "client_relationship",
  "sector_experience",
  "geography",
  "capacity",
  "competition",
  "margin_potential",
  "risk_profile",
  "contract_terms",
  "programme",
  "strategic_value",
  "financial_standing",
  "resource_availability",
] as const;
export type BidNoBidFactor = (typeof BID_NO_BID_FACTORS)[number];

/* ------------------------------------------------------------------ */
/* Tender Q&A (#182), meetings (#181), bonds (#183), cost of sale       */
/* ------------------------------------------------------------------ */

export const BID_QUESTION_STATUSES = [
  "submitted",
  "under_review",
  "answered",
  "published",
  "withdrawn",
  "rejected",
] as const;
export type BidQuestionStatus = (typeof BID_QUESTION_STATUSES)[number];

export const BID_QUESTION_CATEGORIES = [
  "scope",
  "drawings",
  "specification",
  "commercial",
  "programme",
  "contract_terms",
  "site_conditions",
  "process",
  "other",
] as const;
export type BidQuestionCategory = (typeof BID_QUESTION_CATEGORIES)[number];

export const BID_MEETING_KINDS = [
  "pre_bid",
  "site_visit",
  "mid_tender_interview",
  "clarification",
  "post_tender_negotiation",
  "debrief",
] as const;
export type BidMeetingKind = (typeof BID_MEETING_KINDS)[number];

export const BID_MEETING_ATTENDANCE = ["invited", "attended", "apologies", "absent"] as const;
export type BidMeetingAttendance = (typeof BID_MEETING_ATTENDANCE)[number];

/**
 * A bid bond's life. `called` is included because the whole point of the
 * security is that it can be drawn on when a winning bidder walks away.
 */
export const BID_BOND_STATUSES = [
  "required",
  "requested",
  "received",
  "verified",
  "rejected",
  "expired",
  "released",
  "called",
] as const;
export type BidBondStatus = (typeof BID_BOND_STATUSES)[number];

export const TENDER_COST_KINDS = [
  "estimating_labour",
  "management_labour",
  "design_fee",
  "survey",
  "specialist_advice",
  "legal",
  "printing",
  "travel",
  "bond_fee",
  "portal_fee",
  "other",
] as const;
export type TenderCostKind = (typeof TENDER_COST_KINDS)[number];

export const BID_DOCUMENT_ACCESS_KINDS = ["view", "download", "denied"] as const;
export type BidDocumentAccessKind = (typeof BID_DOCUMENT_ACCESS_KINDS)[number];

/* ------------------------------------------------------------------ */
/* Delegated award authority (Domain A #41)                            */
/* ------------------------------------------------------------------ */

export const AWARD_DELEGATION_SUBJECTS = ["user", "company_role"] as const;
export type AwardDelegationSubject = (typeof AWARD_DELEGATION_SUBJECTS)[number];

/* ------------------------------------------------------------------ */
/* Bid-integrity detectors (Domain A #1–35)                            */
/* ------------------------------------------------------------------ */

/**
 * The detector family. Every finding this module raises names one of these
 * as its `detector` on the signals table, so precision can be measured per
 * detector rather than for "bidding" as a lump.
 */
export const BID_INTEGRITY_DETECTORS = [
  /** contender totals clustered impossibly tightly — the complementary-bid signature */
  "bid_integrity_price_clustering",
  /** contender totals dispersed impossibly widely — somebody priced a different job */
  "bid_integrity_price_dispersion",
  /** two bidders quoting the same unit rate on the same scope row */
  "bid_integrity_identical_rates",
  /** one bidder's rates are a constant multiple of another's across the bill */
  "bid_integrity_constant_ratio",
  /** submissions arriving within minutes of each other */
  "bid_integrity_submission_clustering",
  /** the same vendor losing to the same winner again and again in one trade */
  "bid_integrity_cover_bidding",
  /** winners alternating with suspiciously low entropy in one trade */
  "bid_integrity_winner_rotation",
  /** the same invitation set appearing package after package */
  "bid_integrity_repeat_invitation_set",
  /** a bid far below the market and the estimate */
  "bid_integrity_abnormally_low",
  /** a bid far above the market and the estimate */
  "bid_integrity_abnormally_high",
  /** rates front-loaded into early items and starved in later ones */
  "bid_integrity_unbalanced_bid",
  /** the interval between recommendation and approval is not a review */
  "bid_integrity_approval_velocity",
  /** an award approved outside working hours */
  "bid_integrity_out_of_hours_approval",
  /** a bidder who withdraws after seeing who else is in the room */
  "bid_integrity_withdrawal_pattern",
  /** a late bid that won */
  "bid_integrity_late_submission_win",
] as const;
export type BidIntegrityDetector = (typeof BID_INTEGRITY_DETECTORS)[number];

/** How hard a finding bites. Mirrors the platform's signal severities. */
export const BID_INTEGRITY_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type BidIntegritySeverity = (typeof BID_INTEGRITY_SEVERITIES)[number];

/* ------------------------------------------------------------------ */
/* Prequalification depth: capture registers and automatic tiering      */
/* ------------------------------------------------------------------ */

/**
 * The tier a vendor is admitted at. A buyer does not ask "what did they
 * score", they ask "what size of package may this vendor be considered for" —
 * so the score, the financial limit and the safety record collapse into one
 * letter, and the letter carries its basis.
 *
 * `unrated` is a real answer, and the honest one wherever the inputs are
 * missing. It is never dressed up as tier C.
 */
export const PREQUAL_TIERS = ["a", "b", "c", "unrated"] as const;
export type PrequalTier = (typeof PREQUAL_TIERS)[number];

export const PREQUAL_RISK_RATINGS = ["low", "medium", "high", "unrated"] as const;
export type PrequalRiskRating = (typeof PREQUAL_RISK_RATINGS)[number];

/** Where a safety figure came from. Provenance is not a footnote here. */
export const PREQUAL_SAFETY_SOURCES = ["self_declared", "audited", "regulator"] as const;
export type PrequalSafetySource = (typeof PREQUAL_SAFETY_SOURCES)[number];

/**
 * A licence's standing. `claimed` is the default because a vendor typing a
 * licence number is a claim, and it stays a claim until somebody checks it.
 */
export const PREQUAL_LICENCE_STATUSES = [
  "claimed",
  "verified",
  "expired",
  "suspended",
  "revoked",
  "not_applicable",
] as const;
export type PrequalLicenceStatus = (typeof PREQUAL_LICENCE_STATUSES)[number];

/** How a past contract ended, from the reference's point of view. */
export const PREQUAL_REFERENCE_OUTCOMES = [
  "delivered",
  "delivered_late",
  "terminated",
  "disputed",
  "unknown",
] as const;
export type PrequalReferenceOutcome = (typeof PREQUAL_REFERENCE_OUTCOMES)[number];
