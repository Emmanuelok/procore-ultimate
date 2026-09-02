/**
 * Shared enums for the assurance area (platform upgrade wave).
 *
 * Covers the Domain A detector programme (families, run scopes, lifecycle),
 * the typed reconciliation library, entity screening, integrity scoring,
 * integrity cases and evidence packs. `enums.ts` already owns the eight
 * primitives' own unions (ASSERTION_KINDS, EVIDENCE_KINDS, SIGNAL_SEVERITIES,
 * SIGNAL_DISPOSITIONS, …) and is frozen for this wave; everything added here
 * is new vocabulary, never a redefinition.
 */

/* ------------------------------------------------------------------ */
/* Detectors                                                           */
/* ------------------------------------------------------------------ */

/** Families group detectors by the control they test, for the registry UI. */
export const DETECTOR_FAMILIES = [
  "value_integrity", // Benford, round numbers, duplicate claims
  "approval_controls", // segregation of duties, velocity, out-of-hours, limits
  "entity_network", // shared identifiers, ownership chains, conflicts
  "certification", // certified vs evidenced, contradicted claimants
  "ghost_vendor", // Domain A #53-71 payables family
  "chain_integrity", // seal/ledger verdict findings
  "backdating", // post-hoc edits and antedated records
] as const;
export type DetectorFamily = (typeof DETECTOR_FAMILIES)[number];

/** A detector run is scoped to one project or to the whole tenant. */
export const DETECTOR_RUN_SCOPES = ["project", "company"] as const;
export type DetectorRunScope = (typeof DETECTOR_RUN_SCOPES)[number];

/**
 * Legal signal lifecycle transitions (Vol III §6). `new` is the state a
 * detector writes; everything else is a reviewer's act. A terminal state is
 * one with no outgoing transitions except re-opening to `under_review`.
 */
export const SIGNAL_LIFECYCLE: Record<string, readonly string[]> = {
  new: ["under_review", "confirmed", "false_positive", "escalated", "closed"],
  under_review: ["confirmed", "false_positive", "escalated", "closed"],
  confirmed: ["escalated", "closed", "under_review"],
  escalated: ["confirmed", "closed", "under_review"],
  false_positive: ["under_review"],
  closed: ["under_review"],
};

/** Dispositions that count as a reviewer having judged the signal true/false. */
export const SIGNAL_PRECISION_TRUE = ["confirmed", "escalated"] as const;
export const SIGNAL_PRECISION_FALSE = ["false_positive"] as const;

/* ------------------------------------------------------------------ */
/* Reconciliation library                                              */
/* ------------------------------------------------------------------ */

/**
 * Named reconcilers. Each declares the assertion kind it tests and the
 * evidence kinds it will accept — a claimant cannot satisfy a headcount
 * reconciler with a photograph.
 */
export const RECONCILER_KINDS = [
  "progress_vs_capture",
  "quantity_vs_delivery",
  "headcount_vs_access",
  "hours_vs_telematics",
  "cost_vs_bank",
  "numeric_mean", // the generic fallback: any numeric evidence value
] as const;
export type ReconcilerKind = (typeof RECONCILER_KINDS)[number];

/* ------------------------------------------------------------------ */
/* Entity screening (Domain A #10, #42-52)                             */
/* ------------------------------------------------------------------ */

export const SCREENING_LISTS = [
  "ofac_sdn",
  "un_consolidated",
  "eu_consolidated",
  "uk_hmt",
  "world_bank_debarred",
  "pep",
] as const;
export type ScreeningList = (typeof SCREENING_LISTS)[number];

export const SCREENING_DISPOSITIONS = [
  "pending",
  "false_match",
  "true_match",
  "cleared",
  "escalated",
] as const;
export type ScreeningDisposition = (typeof SCREENING_DISPOSITIONS)[number];

/* ------------------------------------------------------------------ */
/* Integrity scoring (Domain A #93-99)                                 */
/* ------------------------------------------------------------------ */

export const INTEGRITY_SCORE_SCOPES = ["project", "entity", "approver"] as const;
export type IntegrityScoreScope = (typeof INTEGRITY_SCORE_SCOPES)[number];

/** 0..100, higher is worse: this is an EXPOSURE score, not a health score. */
export const INTEGRITY_BANDS = ["clear", "watch", "elevated", "severe"] as const;
export type IntegrityBand = (typeof INTEGRITY_BANDS)[number];

/* ------------------------------------------------------------------ */
/* Integrity cases (Domain A #98, #100-101)                            */
/* ------------------------------------------------------------------ */

export const INTEGRITY_CASE_STATUSES = [
  "open",
  "investigating",
  "referred",
  "substantiated",
  "unsubstantiated",
  "closed",
] as const;
export type IntegrityCaseStatus = (typeof INTEGRITY_CASE_STATUSES)[number];

export const INTEGRITY_CASE_ITEM_TYPES = [
  "signal",
  "reconciliation",
  "assertion",
  "evidence",
  "entity",
  "ledger_range",
  "note",
] as const;
export type IntegrityCaseItemType = (typeof INTEGRITY_CASE_ITEM_TYPES)[number];

/* ------------------------------------------------------------------ */
/* Evidence packs                                                      */
/* ------------------------------------------------------------------ */

export const EVIDENCE_PACK_PURPOSES = [
  "audit",
  "referral",
  "claim",
  "regulator",
  "internal_review",
] as const;
export type EvidencePackPurpose = (typeof EVIDENCE_PACK_PURPOSES)[number];

export const EVIDENCE_PACK_ACCESS_ACTIONS = ["create", "view", "download", "verify"] as const;
export type EvidencePackAccessAction = (typeof EVIDENCE_PACK_ACCESS_ACTIONS)[number];
