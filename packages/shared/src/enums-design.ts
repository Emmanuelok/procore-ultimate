/**
 * Shared enums for DESIGN MANAGEMENT & UPSTREAM CHANGE CONTROL
 * (spec Vol I §1.5 #249–255; Vol II Domain T #886–912).
 *
 * Add new `as const` string unions and their types here; never edit
 * enums.ts from a parallel work package.
 */

/* ------------------------------------------------------------------ */
/* Stages (#888 RIBA / AIA / ISO 19650 mapping)                        */
/* ------------------------------------------------------------------ */

/** The stage vocabulary a project chooses to speak. The canonical key is
 *  always a RIBA 2020 stage; the library maps AIA phases and ISO 19650
 *  information stages onto it so a package is comparable across frameworks. */
export const DESIGN_STAGE_FRAMEWORKS = ["riba_2020", "aia", "iso_19650"] as const;
export type DesignStageFramework = (typeof DESIGN_STAGE_FRAMEWORKS)[number];

/** Canonical stage keys — RIBA Plan of Work 2020 stages 0–7. */
export const DESIGN_STAGE_KEYS = [
  "stage_0",
  "stage_1",
  "stage_2",
  "stage_3",
  "stage_4",
  "stage_5",
  "stage_6",
  "stage_7",
] as const;
export type DesignStageKey = (typeof DESIGN_STAGE_KEYS)[number];

export const DESIGN_DISCIPLINES = [
  "architectural",
  "structural",
  "civil",
  "mechanical",
  "electrical",
  "public_health",
  "fire",
  "facade",
  "landscape",
  "interiors",
  "geotechnical",
  "acoustic",
  "sustainability",
  "bim_coordination",
  "multi_discipline",
  "other",
] as const;
export type DesignDiscipline = (typeof DESIGN_DISCIPLINES)[number];

/* ------------------------------------------------------------------ */
/* Packages and stage gates (#253, #886, #889)                         */
/* ------------------------------------------------------------------ */

export const DESIGN_PACKAGE_STATUSES = [
  "planned",
  "in_progress",
  "in_review",
  "approved",
  "frozen",
  "superseded",
  "cancelled",
] as const;
export type DesignPackageStatus = (typeof DESIGN_PACKAGE_STATUSES)[number];

export const DESIGN_GATE_STATUSES = ["planned", "open", "signed_off", "rejected"] as const;
export type DesignGateStatus = (typeof DESIGN_GATE_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Review cycles (#249)                                                */
/* ------------------------------------------------------------------ */

export const DESIGN_REVIEW_STATUSES = [
  "open",
  "in_review",
  "consolidating",
  "closed",
  "cancelled",
] as const;
export type DesignReviewStatus = (typeof DESIGN_REVIEW_STATUSES)[number];

/** Status codes in the BS 1192 / ISO 19650 tradition:
 *  A accepted · B accepted with comments · C revise and resubmit · D rejected. */
export const DESIGN_REVIEW_CODES = ["A", "B", "C", "D"] as const;
export type DesignReviewCode = (typeof DESIGN_REVIEW_CODES)[number];

export const DESIGN_REVIEWER_STATUSES = ["pending", "in_progress", "returned", "declined"] as const;
export type DesignReviewerStatus = (typeof DESIGN_REVIEWER_STATUSES)[number];

export const DESIGN_COMMENT_CATEGORIES = [
  "compliance",
  "coordination",
  "buildability",
  "cost",
  "programme",
  "safety",
  "quality",
  "brief",
  "other",
] as const;
export type DesignCommentCategory = (typeof DESIGN_COMMENT_CATEGORIES)[number];

export const DESIGN_COMMENT_STATUSES = ["open", "responded", "closed", "withdrawn"] as const;
export type DesignCommentStatus = (typeof DESIGN_COMMENT_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Issues and decisions (#250–252)                                     */
/* ------------------------------------------------------------------ */

export const DESIGN_ISSUE_TYPES = [
  "clash",
  "coordination",
  "compliance",
  "buildability",
  "brief_gap",
  "missing_information",
  "error",
  "omission",
  "risk",
  "other",
] as const;
export type DesignIssueType = (typeof DESIGN_ISSUE_TYPES)[number];

export const DESIGN_ISSUE_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type DesignIssuePriority = (typeof DESIGN_ISSUE_PRIORITIES)[number];

export const DESIGN_ISSUE_STATUSES = [
  "open",
  "assigned",
  "in_progress",
  "resolved",
  "closed",
  "void",
] as const;
export type DesignIssueStatus = (typeof DESIGN_ISSUE_STATUSES)[number];

export const DESIGN_DECISION_STATUSES = ["proposed", "decided", "superseded", "reversed"] as const;
export type DesignDecisionStatus = (typeof DESIGN_DECISION_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Consultant deliverables (#254, #887, #909–#911)                     */
/* ------------------------------------------------------------------ */

export const DESIGN_DELIVERABLE_TYPES = [
  "drawing",
  "model",
  "specification",
  "report",
  "calculation",
  "schedule",
  "survey",
  "other",
] as const;
export type DesignDeliverableType = (typeof DESIGN_DELIVERABLE_TYPES)[number];

export const DESIGN_DELIVERABLE_STATUSES = [
  "planned",
  "in_progress",
  "issued",
  "accepted",
  "rejected",
  "cancelled",
] as const;
export type DesignDeliverableStatus = (typeof DESIGN_DELIVERABLE_STATUSES)[number];

/** The engine's verdict on a deliverable against its planned date. */
export const DESIGN_SLIPPAGE_LEVELS = ["on_track", "at_risk", "late", "delivered", "not_assessable"] as const;
export type DesignSlippageLevel = (typeof DESIGN_SLIPPAGE_LEVELS)[number];

export const DESIGN_CONSULTANT_STATUSES = ["appointed", "active", "novated", "terminated", "completed"] as const;
export type DesignConsultantStatus = (typeof DESIGN_CONSULTANT_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Design change notices (#255, #890–#896)                             */
/* ------------------------------------------------------------------ */

export const DCN_STATUSES = [
  "draft",
  "submitted",
  "assessing",
  "approved",
  "rejected",
  "implemented",
  "withdrawn",
] as const;
export type DcnStatus = (typeof DCN_STATUSES)[number];

/** #894 — design development is the normal maturing of a design inside its
 *  stage; a design change alters something already fixed. Only the latter
 *  carries entitlement. */
export const DCN_CLASSIFICATIONS = ["design_development", "design_change"] as const;
export type DcnClassification = (typeof DCN_CLASSIFICATIONS)[number];

/** #895 — who drove the change. Cost is attributed to the originator (#893). */
export const DCN_ORIGINATORS = [
  "client",
  "designer",
  "contractor",
  "statutory",
  "site_condition",
  "other",
] as const;
export type DcnOriginator = (typeof DCN_ORIGINATORS)[number];

/** #892 — the level that may authorise a change, lowest to highest. */
export const DCN_AUTHORISATION_LEVELS = ["design_lead", "project_manager", "client", "board"] as const;
export type DcnAuthorisationLevel = (typeof DCN_AUTHORISATION_LEVELS)[number];

export const DESIGN_FREEZE_STATUSES = ["active", "lifted"] as const;
export type DesignFreezeStatus = (typeof DESIGN_FREEZE_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Information requirements (ISO 19650: EIR, BEP, TIDP/MIDP)           */
/* ------------------------------------------------------------------ */

export const DESIGN_INFO_REQUIREMENT_KINDS = [
  "eir",
  "bep",
  "oir",
  "air",
  "pir",
  "tidp",
  "midp",
  "cde_setup",
  "other",
] as const;
export type DesignInfoRequirementKind = (typeof DESIGN_INFO_REQUIREMENT_KINDS)[number];

export const DESIGN_INFO_REQUIREMENT_STATUSES = [
  "planned",
  "in_progress",
  "delivered",
  "verified",
  "overdue",
  "waived",
] as const;
export type DesignInfoRequirementStatus = (typeof DESIGN_INFO_REQUIREMENT_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Handover readiness                                                  */
/* ------------------------------------------------------------------ */

export const DESIGN_READINESS_LEVELS = ["ready", "nearly_ready", "not_ready", "not_assessable"] as const;
export type DesignReadinessLevel = (typeof DESIGN_READINESS_LEVELS)[number];

/* ------------------------------------------------------------------ */
/* Signals raised by this module                                       */
/* ------------------------------------------------------------------ */

export const DESIGN_DETECTORS = [
  "design_deliverable_late",
  "design_review_overdue",
  "design_post_freeze_change",
  "design_issue_stale",
  "design_change_frequency",
  "design_info_requirement_overdue",
  "design_pi_inadequate",
] as const;
export type DesignDetector = (typeof DESIGN_DETECTORS)[number];

/** Record types this module links to through record_links. */
export const DESIGN_LINK_TARGET_TYPES = [
  "drawing_sheet",
  "bim_model",
  "spec_section",
  "document",
  "change_event",
  "schedule_task",
  "rfi",
  "submittal",
] as const;
export type DesignLinkTargetType = (typeof DESIGN_LINK_TARGET_TYPES)[number];
