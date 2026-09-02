/**
 * Shared enums for the commercial area (platform upgrade wave) — WP-COMM.
 *
 * Covers BOTH halves of the package: measurement & valuation (Vol II Domain B)
 * and contract intelligence (Vol II Domain C). `enums.ts` already owns the
 * first-generation vocabulary (BOQ_*, VALUATION_*, VARIATION_*, CONTRACT_*);
 * everything the upgrade adds lives here so the two files never collide.
 */

/* ------------------------------------------------------------------ */
/* Measurement standards (#117-134)                                    */
/* ------------------------------------------------------------------ */

/** Rule severities returned by the method-of-measurement validator. */
export const MOM_SEVERITIES = ["error", "warning", "info"] as const;
export type MomSeverity = (typeof MOM_SEVERITIES)[number];

/** Which part of an item a measurement rule is about. */
export const MOM_RULE_SCOPES = [
  "unit",
  "description",
  "code",
  "quantity",
  "structure",
  "item_type",
] as const;
export type MomRuleScope = (typeof MOM_RULE_SCOPES)[number];

/* ------------------------------------------------------------------ */
/* Valuation build-up (#132, #150-167)                                 */
/* ------------------------------------------------------------------ */

/**
 * A valuation is BQ lines PLUS typed sections. Each section rolls into the
 * gross application with its own provenance, so "what is in this
 * application" is answerable line by line rather than as one number.
 */
export const VALUATION_SECTION_KINDS = [
  "variation",
  "daywork",
  "claim",
  "fluctuation",
  "materials_on_site",
  "materials_off_site",
  "contra_charge",
  "provisional_sum",
  "other",
] as const;
export type ValuationSectionKind = (typeof VALUATION_SECTION_KINDS)[number];

/** Daywork sheet lifecycle (#150-161). Verification is a different actor. */
export const DAYWORK_STATUSES = [
  "draft",
  "submitted",
  "verified",
  "rejected",
  "valued",
] as const;
export type DayworkStatus = (typeof DAYWORK_STATUSES)[number];

/** Resource class on a daywork sheet — the three columns of a daywork schedule. */
export const DAYWORK_RESOURCE_KINDS = ["labour", "material", "plant"] as const;
export type DayworkResourceKind = (typeof DAYWORK_RESOURCE_KINDS)[number];

/** Whether daywork is priced from the contract daywork schedule or actual cost. */
export const DAYWORK_BASES = ["schedule_rates", "actual_cost"] as const;
export type DayworkBasis = (typeof DAYWORK_BASES)[number];

/* ------------------------------------------------------------------ */
/* Remeasurement (#141-144)                                            */
/* ------------------------------------------------------------------ */

export const REMEASUREMENT_STATUSES = [
  "proposed",
  "agreed",
  "disputed",
  "applied",
] as const;
export type RemeasurementStatus = (typeof REMEASUREMENT_STATUSES)[number];

export const REMEASUREMENT_METHODS = [
  "site_measure",
  "drawing_measure",
  "model_quantity",
  "survey",
  "agreed_record",
] as const;
export type RemeasurementMethod = (typeof REMEASUREMENT_METHODS)[number];

/* ------------------------------------------------------------------ */
/* Provisional sums & prime cost (#125-127)                            */
/* ------------------------------------------------------------------ */

export const PROVISIONAL_SUM_KINDS = [
  "defined",
  "undefined",
  "prime_cost",
  "contingency",
] as const;
export type ProvisionalSumKind = (typeof PROVISIONAL_SUM_KINDS)[number];

export const PROVISIONAL_SUM_STATUSES = [
  "open",
  "instructed",
  "expended",
  "omitted",
  "closed",
] as const;
export type ProvisionalSumStatus = (typeof PROVISIONAL_SUM_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Fluctuations / price adjustment (#178, FIDIC 13.8)                  */
/* ------------------------------------------------------------------ */

export const FLUCTUATION_FORMULAE = [
  "fidic_13_8",
  "nec_option_x1",
  "jct_formula",
  "simple_cpi",
] as const;
export type FluctuationFormula = (typeof FLUCTUATION_FORMULAE)[number];

/* ------------------------------------------------------------------ */
/* Rate analysis & benchmarking (#145-149)                             */
/* ------------------------------------------------------------------ */

export const RATE_BENCHMARK_SOURCES = [
  "internal_history",
  "published",
  "subcontract_quote",
  "estimate",
  "manual",
] as const;
export type RateBenchmarkSource = (typeof RATE_BENCHMARK_SOURCES)[number];

/** Verdict of the rate build-up analyser for one BQ item. */
export const RATE_VERDICTS = ["in_range", "high", "low", "no_benchmark"] as const;
export type RateVerdict = (typeof RATE_VERDICTS)[number];

/* ------------------------------------------------------------------ */
/* CVR / WIP (#184-189)                                                */
/* ------------------------------------------------------------------ */

export const CVR_STATUSES = ["draft", "final"] as const;
export type CvrStatus = (typeof CVR_STATUSES)[number];

export const CVR_SCOPES = ["project", "package"] as const;
export type CvrScope = (typeof CVR_SCOPES)[number];

/* ------------------------------------------------------------------ */
/* Final account (#181-183, #187)                                      */
/* ------------------------------------------------------------------ */

export const FINAL_ACCOUNT_STATUSES = [
  "draft",
  "issued",
  "agreed",
  "disputed",
] as const;
export type FinalAccountStatus = (typeof FINAL_ACCOUNT_STATUSES)[number];

/**
 * Adjustment-schedule categories, in statement order. The final contract sum
 * is Σ(amount) across the categories with the signs the engine applies.
 */
export const FINAL_ACCOUNT_CATEGORIES = [
  "contract_sum",
  "omission",
  "provisional_sum_omitted",
  "remeasurement",
  "variation",
  "provisional_sum_expenditure",
  "daywork",
  "fluctuation",
  "claim",
  "liquidated_damages",
  "contra_charge",
  "other",
] as const;
export type FinalAccountCategory = (typeof FINAL_ACCOUNT_CATEGORIES)[number];

/* ------------------------------------------------------------------ */
/* Retention (#254)                                                    */
/* ------------------------------------------------------------------ */

export const RETENTION_RELEASE_KINDS = [
  "taking_over",
  "dnp_end",
  "bond_substitution",
  "partial",
] as const;
export type RetentionReleaseKind = (typeof RETENTION_RELEASE_KINDS)[number];

/* ------------------------------------------------------------------ */
/* Contract intelligence upgrade (Domain C)                            */
/* ------------------------------------------------------------------ */

/** Where an event's notice deadline actually came from — shown in the UI. */
export const DEADLINE_SOURCES = [
  "library",
  "particular_condition",
  "manual",
  "chain",
] as const;
export type DeadlineSource = (typeof DEADLINE_SOURCES)[number];

/** Calendar vs working days for time-bar arithmetic. */
export const CALENDAR_BASES = ["calendar", "working"] as const;
export type CalendarBasis = (typeof CALENDAR_BASES)[number];

/**
 * NEC compensation-event sub-state machine (#206-211). Sits alongside the
 * generic contract-event status, which stays the notice/time-bar axis.
 */
export const CE_STATES = [
  "notified",
  "quotation_requested",
  "quotation_submitted",
  "pm_replied",
  "pm_assessment",
  "implemented",
  "rejected",
] as const;
export type CeState = (typeof CE_STATES)[number];

export const CE_QUOTATION_STATUSES = [
  "submitted",
  "accepted",
  "rejected",
  "revision_requested",
  "pm_assessment",
  "deemed_accepted",
] as const;
export type CeQuotationStatus = (typeof CE_QUOTATION_STATUSES)[number];

/** Short Schedule of Cost Components heads (#207-208). */
export const SCC_COMPONENTS = [
  "people",
  "equipment",
  "plant_and_materials",
  "subcontractors",
  "charges",
  "manufacture_and_fabrication",
  "design",
  "insurance",
] as const;
export type SccComponent = (typeof SCC_COMPONENTS)[number];

/** Accepted-programme register (#209-210). */
export const PROGRAMME_STATUSES = [
  "submitted",
  "accepted",
  "rejected",
  "superseded",
] as const;
export type ProgrammeStatus = (typeof PROGRAMME_STATUSES)[number];

/** NEC 31.3 reasons for not accepting a programme. */
export const PROGRAMME_REJECTION_REASONS = [
  "plans_not_practicable",
  "does_not_show_information_required",
  "does_not_represent_plans_realistically",
  "does_not_comply_with_scope",
] as const;
export type ProgrammeRejectionReason = (typeof PROGRAMME_REJECTION_REASONS)[number];

/** Which valuation basis an NEC main option implies (#211). */
export const NEC_VALUATION_BASES = [
  "activity_schedule",
  "bill_of_quantities",
  "target_cost",
  "cost_reimbursable",
  "management",
] as const;
export type NecValuationBasis = (typeof NEC_VALUATION_BASES)[number];

/** Contract compliance checks over insurance / bond clauses (#251-253). */
export const CONTRACT_COMPLIANCE_KINDS = [
  "insurance",
  "bond",
  "guarantee",
  "warranty",
  "other",
] as const;
export type ContractComplianceKind = (typeof CONTRACT_COMPLIANCE_KINDS)[number];

export const CONTRACT_COMPLIANCE_STATUSES = [
  "compliant",
  "expiring",
  "non_compliant",
  "unknown",
] as const;
export type ContractComplianceStatus = (typeof CONTRACT_COMPLIANCE_STATUSES)[number];

/** Detector ids this package raises into `signals`. */
export const COMMERCIAL_DETECTORS = [
  "time_bar_missed",
  "time_bar_warning",
  "time_bar_breach_risk",
  "ce_deemed_acceptance",
  "contract_compliance_lapse",
  "rate_outlier",
  "over_certification",
  "retention_cap_exceeded",
  "provisional_sum_overspend",
] as const;
export type CommercialDetector = (typeof COMMERCIAL_DETECTORS)[number];
