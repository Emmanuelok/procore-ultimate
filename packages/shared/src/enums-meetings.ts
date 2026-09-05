/**
 * Shared enums for WP-MEET — meetings, organisational learning and the
 * insurance/bonding programme (platform upgrade wave).
 *
 * Add new `as const` string unions and their types here; never edit
 * enums.ts from a parallel work package.
 */

/* ------------------------------------------------------------------ */
/* Meetings — minutes as a real document (#422, #425)                   */
/* ------------------------------------------------------------------ */

/**
 * How an issued set of minutes reached a recipient. The channel matters
 * because the objection period runs from DELIVERY, not from the moment the
 * minute taker pressed a button: "issued" is an act of the sender, "delivered"
 * is a fact about the recipient, and only the second can start a clock that
 * binds them.
 */
export const MINUTE_DELIVERY_CHANNELS = ["platform", "email", "manual"] as const;
export type MinuteDeliveryChannel = (typeof MINUTE_DELIVERY_CHANNELS)[number];

export const MINUTE_DELIVERY_STATUSES = ["pending", "delivered", "failed", "acknowledged"] as const;
export type MinuteDeliveryStatus = (typeof MINUTE_DELIVERY_STATUSES)[number];

/** What a rendered meeting document is: the pack before, the record after. */
export const MEETING_DOCUMENT_KINDS = ["agenda_pack", "minutes"] as const;
export type MeetingDocumentKind = (typeof MEETING_DOCUMENT_KINDS)[number];

/**
 * Records an agenda item may be raised into (#424). Deliberately a closed
 * list: a free-text `originType` is not a link, it is a note that looks like
 * one, and nothing downstream can verify it.
 */
export const MEETING_RAISE_TARGETS = ["rfi", "change_event", "risk"] as const;
export type MeetingRaiseTarget = (typeof MEETING_RAISE_TARGETS)[number];

/* ------------------------------------------------------------------ */
/* Learning — the loop that is normally left open (#979, #981–984)      */
/* ------------------------------------------------------------------ */

/**
 * What actually happened after a lesson was applied. `unknown` is a real
 * answer and the default: an application whose outcome nobody measured must
 * not be counted as a success, which is precisely how lessons registers come
 * to report impact they never had.
 */
export const LESSON_OUTCOMES = [
  "unknown",
  "avoided",
  "partially_avoided",
  "no_effect",
  "counterproductive",
] as const;
export type LessonOutcome = (typeof LESSON_OUTCOMES)[number];

/** The state of a cross-project relevance push (#985–986). */
export const LESSON_PUSH_STATUSES = ["pushed", "acknowledged", "applied", "dismissed"] as const;
export type LessonPushStatus = (typeof LESSON_PUSH_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Insurance — renewal pipeline, facilities, requirements (#771–797)    */
/* ------------------------------------------------------------------ */

/**
 * Where a policy sits in the renewal pipeline. Distinct from `status`:
 * a policy can be in force (`active`) and unstarted in its renewal
 * (`not_started`) at the same time, and the whole point of the pipeline is
 * seeing the second while the first is still comfortable.
 */
export const POLICY_RENEWAL_STATUSES = [
  "not_started",
  "instructed",
  "quotes_requested",
  "quotes_received",
  "bound",
  "not_renewing",
] as const;
export type PolicyRenewalStatus = (typeof POLICY_RENEWAL_STATUSES)[number];

/** A bonding line facility's own lifecycle (#796). */
export const BOND_FACILITY_STATUSES = ["draft", "active", "suspended", "expired", "closed"] as const;
export type BondFacilityStatus = (typeof BOND_FACILITY_STATUSES)[number];

/** Whether a required cover has actually been evidenced. */
export const INSURANCE_REQUIREMENT_STATUSES = ["required", "waived", "superseded"] as const;
export type InsuranceRequirementStatus = (typeof INSURANCE_REQUIREMENT_STATUSES)[number];

/** What a premium row records — the numbers claims experience is measured against. */
export const INSURANCE_PREMIUM_KINDS = [
  "premium",
  "adjustment",
  "return_premium",
  "broker_fee",
  "levy",
] as const;
export type InsurancePremiumKind = (typeof INSURANCE_PREMIUM_KINDS)[number];

/**
 * Why an invoice may be held on insurance grounds. Returned by the hold hook
 * WP-FIN2 calls before releasing a payment; every reason names a record.
 */
export const INSURANCE_HOLD_REASONS = [
  "no_certificate",
  "certificate_expired",
  "certificate_unverified",
  "limit_below_requirement",
  "policy_lapsed",
] as const;
export type InsuranceHoldReason = (typeof INSURANCE_HOLD_REASONS)[number];

/**
 * What the adjuster's task list holds (#785). Information requests dominate,
 * but a site visit and an interim report are the same shape — a dated thing
 * the claim's progress depends on — and splitting them across registers only
 * makes the diary harder to read.
 */
export const CLAIM_REQUEST_KINDS = [
  "information_request",
  "site_visit",
  "interim_report",
  "expert_appointment",
] as const;
export type ClaimRequestKind = (typeof CLAIM_REQUEST_KINDS)[number];

/**
 * `overdue` is deliberately NOT a stored state: it is derived from the due
 * date, so it can never disagree with the calendar. What is stored is what
 * somebody did.
 */
export const CLAIM_REQUEST_STATUSES = ["open", "responded", "closed", "withdrawn"] as const;
export type ClaimRequestStatus = (typeof CLAIM_REQUEST_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Learning — the knowledge graph (#992)                                */
/* ------------------------------------------------------------------ */

/**
 * The four kinds of edge a lesson has. A closed list because each kind
 * answers a different question and each is stored with a different guarantee:
 * a `record` edge was checked against a real row, a `tag` edge is vocabulary,
 * a `person` edge is provenance, a `lesson` edge is supersession.
 */
export const LESSON_EDGE_KINDS = ["record", "person", "tag", "lesson"] as const;
export type LessonEdgeKind = (typeof LESSON_EDGE_KINDS)[number];

/** Why an edge exists — the label on the arrow, not just its direction. */
export const LESSON_EDGE_ROLES = [
  "origin", // the record the lesson came out of
  "evidence", // a record cited as evidence for it
  "applied_to", // a record the lesson was applied to on a later project
  "author",
  "validator",
  "applier",
  "tag",
  "supersedes",
  "superseded_by",
  "see_also",
] as const;
export type LessonEdgeRole = (typeof LESSON_EDGE_ROLES)[number];

/* ------------------------------------------------------------------ */
/* Learning — feedback into the libraries (#981–984)                    */
/* ------------------------------------------------------------------ */

/**
 * A library entry's life. `proposed` is where the sweep leaves everything:
 * outturn data is a proposal about what a rate should be, never an
 * instruction, and an admin who has not looked at the sample has not agreed
 * to anything.
 */
export const LIBRARY_ENTRY_STATUSES = ["proposed", "accepted", "rejected", "superseded"] as const;
export type LibraryEntryStatus = (typeof LIBRARY_ENTRY_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Insurance — certificate authenticity (#772, #781)                    */
/* ------------------------------------------------------------------ */

/** Who is being asked to confirm a certificate. */
export const CONFIRMATION_CHANNELS = ["broker", "insurer"] as const;
export type ConfirmationChannel = (typeof CONFIRMATION_CHANNELS)[number];

/**
 * `sent` is the honest resting state of an unanswered request: silence is not
 * confirmation, and a certificate whose confirmation was never answered has
 * not been verified by anybody.
 */
export const CONFIRMATION_STATUSES = ["sent", "responded", "expired", "withdrawn"] as const;
export type ConfirmationStatus = (typeof CONFIRMATION_STATUSES)[number];

/** What the broker or insurer said when asked. */
export const CONFIRMATION_OUTCOMES = ["confirmed", "corrected", "not_on_risk", "unknown"] as const;
export type ConfirmationOutcome = (typeof CONFIRMATION_OUTCOMES)[number];
