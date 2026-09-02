/**
 * Shared enums for the quality area (platform upgrade wave).
 *
 * Domain V depth (commissioning through to the defects liability period) and
 * Domain Z quality items (#1085–1100): concrete, welding and NDT, material
 * test certificates, concessions, third-party surveillance, audits,
 * calibration, rework and the cost of quality.
 *
 * Vocabularies here are deliberately the ones a certifying body uses, not the
 * ones a form designer invents: an EN 10204 3.2 certificate and a 2.2
 * certificate are different evidence, a `use_as_is` concession and a repair
 * concession are different admissions, and a weld that was cut out is a
 * different fact from one that was ground and re-run.
 *
 * Add new `as const` string unions and their types here; never edit enums.ts
 * from a parallel work package.
 */

/* ------------------------------------------------------------------ */
/* Sequential sign-off chain on an ITP activity (#1092–1094)           */
/* ------------------------------------------------------------------ */

/**
 * One nominated party's standing on a hold or witness point. `attended` is
 * distinct from `released`: a third-party surveyor who came to site and has
 * not yet signed is a different fact from one who released the point, and the
 * distinction is what a surveillance report is for.
 */
export const RELEASE_PARTY_STATUSES = [
  "pending",
  "notified",
  "attended",
  "released",
  "rejected",
  "waived",
  "not_required",
] as const;
export type ReleasePartyStatus = (typeof RELEASE_PARTY_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Concessions and waivers (#1091)                                     */
/* ------------------------------------------------------------------ */

/**
 * What is being asked for. A CONCESSION accepts work already built that does
 * not conform; a DEVIATION PERMIT authorises a departure BEFORE the work is
 * done; a WAIVER releases a verification that the plan required. They are
 * different admissions and are never merged into one register entry.
 */
export const CONCESSION_KINDS = [
  "concession",
  "deviation_permit",
  "waiver",
  "production_permit",
] as const;
export type ConcessionKind = (typeof CONCESSION_KINDS)[number];

export const CONCESSION_STATUSES = [
  "draft",
  "submitted",
  "under_review",
  "approved",
  "approved_with_conditions",
  "rejected",
  "withdrawn",
  "expired",
  "closed",
] as const;
export type ConcessionStatus = (typeof CONCESSION_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Concrete (#1085–1086)                                               */
/* ------------------------------------------------------------------ */

export const POUR_STATUSES = [
  "planned",
  "approved_to_pour",
  "poured",
  "curing",
  "testing",
  "accepted",
  "rejected",
] as const;
export type PourStatus = (typeof POUR_STATUSES)[number];

export const SPECIMEN_TYPES = ["cube", "cylinder", "core", "beam", "prism"] as const;
export type SpecimenType = (typeof SPECIMEN_TYPES)[number];

export const SPECIMEN_RESULTS = ["pending", "pass", "fail", "void"] as const;
export type SpecimenResult = (typeof SPECIMEN_RESULTS)[number];

/**
 * Which code's acceptance arithmetic is applied to a pour's specimen set.
 * The code is recorded per pour because the answer differs: EN 206 judges a
 * running set against fck + 4 (initial production) or the sample standard
 * deviation, ACI 318 against fc' + 3.45 MPa averages of three, and the
 * `specified_only` rule is the honest fallback when the project has told the
 * platform nothing but the grade.
 */
export const CONCRETE_ACCEPTANCE_CODES = [
  "en_206",
  "aci_318",
  "bs_8500",
  "is_456",
  "specified_only",
] as const;
export type ConcreteAcceptanceCode = (typeof CONCRETE_ACCEPTANCE_CODES)[number];

/* ------------------------------------------------------------------ */
/* Welding and NDT (#1087–1088)                                        */
/* ------------------------------------------------------------------ */

export const WELD_PROCESSES = [
  "smaw",
  "gmaw",
  "fcaw",
  "gtaw",
  "saw",
  "esw",
  "stud",
  "resistance",
  "other",
] as const;
export type WeldProcess = (typeof WELD_PROCESSES)[number];

export const WPS_STATUSES = ["draft", "approved", "superseded", "withdrawn"] as const;
export type WpsStatus = (typeof WPS_STATUSES)[number];

/** A welder qualification lapses on continuity as well as on date. */
export const WELDER_QUALIFICATION_STATUSES = [
  "valid",
  "expiring",
  "expired",
  "suspended",
  "revoked",
] as const;
export type WelderQualificationStatus = (typeof WELDER_QUALIFICATION_STATUSES)[number];

/** `cut_out` is not a repair: the joint was removed and re-made. */
export const WELD_STATUSES = [
  "planned",
  "fit_up",
  "welded",
  "visual_inspected",
  "ndt_requested",
  "accepted",
  "rejected",
  "repaired",
  "cut_out",
] as const;
export type WeldStatus = (typeof WELD_STATUSES)[number];

export const NDT_METHODS = [
  "vt",
  "pt",
  "mt",
  "rt",
  "ut",
  "paut",
  "tofd",
  "et",
  "hardness",
  "ferrite",
  "leak",
] as const;
export type NdtMethod = (typeof NDT_METHODS)[number];

export const NDT_RESULTS = ["accept", "reject", "inconclusive", "pending"] as const;
export type NdtResult = (typeof NDT_RESULTS)[number];

/* ------------------------------------------------------------------ */
/* Material test certificates (#1089)                                  */
/* ------------------------------------------------------------------ */

/**
 * EN 10204 inspection document types. 3.2 is countersigned by an independent
 * inspector; 3.1 is the manufacturer's own; 2.2 is a non-specific test report
 * and is NOT traceable to the delivered lot. Recording which one was received
 * is the whole point of the register — "we have a certificate" is not an
 * answer to "is this steel the steel that was tested".
 */
export const CERTIFICATE_TYPES = [
  "en_10204_2_1",
  "en_10204_2_2",
  "en_10204_3_1",
  "en_10204_3_2",
  "mill_certificate",
  "conformity_declaration",
  "test_report",
  "other",
] as const;
export type CertificateType = (typeof CERTIFICATE_TYPES)[number];

export const CERTIFICATE_VERIFICATION_STATUSES = [
  "unverified",
  "verified",
  "failed",
  "superseded",
  "rejected",
] as const;
export type CertificateVerificationStatus = (typeof CERTIFICATE_VERIFICATION_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Calibration (#1097)                                                 */
/* ------------------------------------------------------------------ */

export const INSTRUMENT_STATUSES = [
  "in_service",
  "due_soon",
  "overdue",
  "out_of_service",
  "under_calibration",
  "lost",
  "retired",
] as const;
export type InstrumentStatus = (typeof INSTRUMENT_STATUSES)[number];

export const CALIBRATION_RESULTS = ["pass", "adjusted", "fail", "limited_use"] as const;
export type CalibrationResult = (typeof CALIBRATION_RESULTS)[number];

/* ------------------------------------------------------------------ */
/* Rework and the cost of quality (#1098–#1100)                        */
/* ------------------------------------------------------------------ */

export const REWORK_CAUSES = [
  "design_error",
  "design_change",
  "late_information",
  "workmanship",
  "material_defect",
  "supervision",
  "coordination",
  "damage_by_others",
  "site_conditions",
  "client_change",
  "other",
] as const;
export type ReworkCause = (typeof REWORK_CAUSES)[number];

export const REWORK_STATUSES = [
  "identified",
  "approved",
  "in_progress",
  "complete",
  "verified",
  "cancelled",
] as const;
export type ReworkStatus = (typeof REWORK_STATUSES)[number];

/** Where the failure was caught. External failure costs more, always. */
export const REWORK_DISCOVERY_PHASES = [
  "during_works",
  "at_inspection",
  "at_commissioning",
  "at_handover",
  "post_handover",
] as const;
export type ReworkDiscoveryPhase = (typeof REWORK_DISCOVERY_PHASES)[number];

export const REWORK_COST_BASES = ["estimated", "quoted", "actual"] as const;
export type ReworkCostBasis = (typeof REWORK_COST_BASES)[number];

/**
 * The PAF model. Prevention and appraisal are what a quality system costs;
 * internal and external failure are what NOT having one costs. Splitting the
 * failure bucket by where it was caught is the only way the ratio means
 * anything.
 */
export const COST_OF_QUALITY_BUCKETS = [
  "prevention",
  "appraisal",
  "internal_failure",
  "external_failure",
] as const;
export type CostOfQualityBucket = (typeof COST_OF_QUALITY_BUCKETS)[number];

/* ------------------------------------------------------------------ */
/* Quality audits and ISO 9001 evidence (#1095–#1096)                  */
/* ------------------------------------------------------------------ */

export const AUDIT_TYPES = [
  "internal",
  "external",
  "supplier",
  "process",
  "product",
  "system",
  "surveillance",
  "certification",
  "regulatory",
] as const;
export type QualityAuditType = (typeof AUDIT_TYPES)[number];

export const AUDIT_STATUSES = [
  "planned",
  "in_progress",
  "fieldwork_complete",
  "report_issued",
  "responses_received",
  "closed",
  "cancelled",
] as const;
export type QualityAuditStatus = (typeof AUDIT_STATUSES)[number];

export const AUDIT_FINDING_TYPES = [
  "major_nonconformity",
  "minor_nonconformity",
  "observation",
  "opportunity_for_improvement",
  "conformity",
] as const;
export type AuditFindingType = (typeof AUDIT_FINDING_TYPES)[number];

export const AUDIT_FINDING_STATUSES = [
  "open",
  "response_received",
  "action_agreed",
  "action_complete",
  "verified",
  "closed",
  "rejected",
] as const;
export type AuditFindingStatus = (typeof AUDIT_FINDING_STATUSES)[number];

/**
 * ISO 9001:2015 clauses that a construction QMS is audited against. Used to
 * assemble the evidence pack (#1096): each clause is answered from records the
 * platform already holds, and a clause with no records is reported as
 * unevidenced rather than assumed compliant.
 */
export const ISO_9001_CLAUSES = [
  "4_context",
  "5_leadership",
  "6_planning",
  "7_support",
  "7_1_5_monitoring_resources",
  "8_1_operational_planning",
  "8_2_requirements",
  "8_3_design",
  "8_4_external_providers",
  "8_5_production",
  "8_5_2_identification_traceability",
  "8_6_release",
  "8_7_nonconforming_output",
  "9_1_monitoring",
  "9_2_internal_audit",
  "9_3_management_review",
  "10_2_nonconformity_corrective_action",
  "10_3_continual_improvement",
] as const;
export type Iso9001Clause = (typeof ISO_9001_CLAUSES)[number];

/* ------------------------------------------------------------------ */
/* Domain V: closeout — DLP, guarantees, training, spares, POE         */
/* ------------------------------------------------------------------ */

export const DLP_STATUSES = [
  "not_started",
  "active",
  "expiring",
  "expired",
  "extended",
  "closed",
] as const;
export type DlpStatus = (typeof DLP_STATUSES)[number];

export const DLP_DEFECT_STATUSES = [
  "reported",
  "accepted",
  "disputed",
  "in_progress",
  "rectified",
  "verified",
  "rejected",
] as const;
export type DlpDefectStatus = (typeof DLP_DEFECT_STATUSES)[number];

/** How a guaranteed parameter is compared with what was measured. */
export const GUARANTEE_OPERATORS = ["at_least", "at_most", "equals", "between"] as const;
export type GuaranteeOperator = (typeof GUARANTEE_OPERATORS)[number];

export const GUARANTEE_STATUSES = [
  "declared",
  "under_test",
  "met",
  "not_met",
  "waived",
  "superseded",
] as const;
export type GuaranteeStatus = (typeof GUARANTEE_STATUSES)[number];

export const TRAINING_KINDS = [
  "classroom",
  "hands_on",
  "handover_walkthrough",
  "video",
  "refresher",
  "vendor_delivered",
] as const;
export type TrainingKind = (typeof TRAINING_KINDS)[number];

export const TRAINING_STATUSES = [
  "planned",
  "scheduled",
  "delivered",
  "accepted",
  "cancelled",
] as const;
export type TrainingStatus = (typeof TRAINING_STATUSES)[number];

export const SPARE_PART_CATEGORIES = [
  "commissioning_spare",
  "operational_spare",
  "consumable",
  "special_tool",
  "strategic_spare",
  "test_equipment",
] as const;
export type SparePartCategory = (typeof SPARE_PART_CATEGORIES)[number];

export const SPARE_PART_STATUSES = [
  "specified",
  "ordered",
  "delivered",
  "handed_over",
  "outstanding",
  "waived",
] as const;
export type SparePartStatus = (typeof SPARE_PART_STATUSES)[number];

/** Soft landings and post-occupancy evaluation (#973–975). */
export const POE_KINDS = [
  "soft_landings_review",
  "occupant_survey",
  "energy_review",
  "defects_review",
  "seasonal_review",
  "performance_review",
] as const;
export type PoeKind = (typeof POE_KINDS)[number];

export const POE_STATUSES = ["planned", "in_progress", "complete", "cancelled"] as const;
export type PoeStatus = (typeof POE_STATUSES)[number];
