/**
 * Shared enums for the schedule & forensics area (platform upgrade wave).
 *
 * Covers: schedule provenance and revisioning (#349-350, #357), resource
 * loading (#370), the lookahead constraints log (#359), the forensic method
 * suite (Vol II Domain D #270-281), float ownership / concurrency doctrine
 * (#278-281), quantum formulae (#300-303) and disruption methods (#290-293).
 *
 * Deliberately NOT here: anything already in enums.ts (DELAY_CAUSES,
 * DELAY_EVENT_STATUSES, CLAIM_KINDS, CLAIM_STATUSES, DEPENDENCY_TYPES,
 * TASK_CONSTRAINT_TYPES) — that file is frozen for parallel work packages.
 */

/* ------------------------------------------------------------------ */
/* Schedule provenance & structure                                     */
/* ------------------------------------------------------------------ */

/** Where a schedule's data came from (#349-350). */
export const SCHEDULE_SOURCES = ["native", "xer", "mspdi"] as const;
export type ScheduleSource = (typeof SCHEDULE_SOURCES)[number];

/** File formats the importer/exporter understands. */
export const SCHEDULE_FILE_FORMATS = ["xer", "mspdi"] as const;
export type ScheduleFileFormat = (typeof SCHEDULE_FILE_FORMATS)[number];

/**
 * Activity type. `level_of_effort` and `wbs_summary` activities are excluded
 * from the DCMA duration/float population checks the way P6 excludes them.
 */
export const SCHEDULE_TASK_TYPES = [
  "task",
  "start_milestone",
  "finish_milestone",
  "level_of_effort",
  "wbs_summary",
] as const;
export type ScheduleTaskType = (typeof SCHEDULE_TASK_TYPES)[number];

/** Resource classes for resource-loaded activities (#370). */
export const SCHEDULE_RESOURCE_TYPES = [
  "labour",
  "equipment",
  "material",
  "subcontract",
  "other",
] as const;
export type ScheduleResourceType = (typeof SCHEDULE_RESOURCE_TYPES)[number];

/* ------------------------------------------------------------------ */
/* Lookahead constraints log (#359)                                    */
/* ------------------------------------------------------------------ */

export const CONSTRAINT_LOG_CATEGORIES = [
  "design_information",
  "procurement",
  "site_access",
  "labour",
  "permit_or_approval",
  "material",
  "equipment",
  "predecessor_work",
  "weather",
  "other",
] as const;
export type ConstraintLogCategory = (typeof CONSTRAINT_LOG_CATEGORIES)[number];

export const CONSTRAINT_LOG_STATUSES = [
  "open",
  "in_progress",
  "cleared",
  "escalated",
  "void",
] as const;
export type ConstraintLogStatus = (typeof CONSTRAINT_LOG_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Forensic method suite (Vol II D #270-277)                           */
/* ------------------------------------------------------------------ */

/**
 * Analysis methods the forensics module can actually run, each mapped to its
 * AACE 29R-03 Method Implementation Protocol below.
 */
export const FORENSIC_METHODS = [
  "as_planned_vs_as_built",
  "impacted_as_planned",
  "time_impact_analysis",
  "windows",
  "collapsed_as_built",
  "longest_path",
  "concurrency",
] as const;
export type ForensicMethod = (typeof FORENSIC_METHODS)[number];

/** AACE 29R-03 MIP codes (3.1-3.9). */
export const AACE_MIP_CODES = [
  "3.1",
  "3.2",
  "3.3",
  "3.4",
  "3.5",
  "3.6",
  "3.7",
  "3.8",
  "3.9",
] as const;
export type AaceMipCode = (typeof AACE_MIP_CODES)[number];

/** Whether the analysis looks forward from a point or back over the record. */
export const ANALYSIS_PERSPECTIVES = ["prospective", "retrospective"] as const;
export type AnalysisPerspective = (typeof ANALYSIS_PERSPECTIVES)[number];

/** Additive methods insert delay; subtractive methods remove it. */
export const ANALYSIS_MODELS = ["additive", "subtractive", "observational"] as const;
export type AnalysisModel = (typeof ANALYSIS_MODELS)[number];

/* ------------------------------------------------------------------ */
/* Float ownership, concurrency & pacing (#278-281)                    */
/* ------------------------------------------------------------------ */

export const FLOAT_OWNERSHIP_RULES = [
  "project",
  "contractor",
  "owner",
  "first_come",
] as const;
export type FloatOwnershipRule = (typeof FLOAT_OWNERSHIP_RULES)[number];

export const CONCURRENCY_RULES = ["sca_protocol", "malmaison", "apportionment"] as const;
export type ConcurrencyRule = (typeof CONCURRENCY_RULES)[number];

/** Who the delay is culpable to — drives entitlement, not just reporting. */
export const CULPABLE_PARTIES = ["owner", "contractor", "third_party", "neither"] as const;
export type CulpableParty = (typeof CULPABLE_PARTIES)[number];

/** Classification produced by the concurrency engine for a pair of events. */
export const CONCURRENCY_CLASSES = [
  "true_concurrency",
  "sequential",
  "pacing",
  "independent",
] as const;
export type ConcurrencyClass = (typeof CONCURRENCY_CLASSES)[number];

/* ------------------------------------------------------------------ */
/* Quantum & disruption (#290-293, #300-303, #312-313)                 */
/* ------------------------------------------------------------------ */

export const QUANTUM_METHODS = [
  "hudson",
  "emden",
  "eichleay",
  "site_overhead",
  "finance_charge",
  "loss_of_profit",
] as const;
export type QuantumMethod = (typeof QUANTUM_METHODS)[number];

export const DISRUPTION_METHODS = [
  "measured_mile",
  "earned_value",
  "industry_curve_mcaa",
  "industry_curve_leonard",
  "industry_curve_ibbs",
] as const;
export type DisruptionMethod = (typeof DISRUPTION_METHODS)[number];

/** Simple vs compound interest on a finance-charge claim. */
export const INTEREST_BASES = ["simple", "compound"] as const;
export type InterestBasis = (typeof INTEREST_BASES)[number];
