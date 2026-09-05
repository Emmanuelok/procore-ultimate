/**
 * Shared enums for the safeguards area — land & resettlement (Domain J),
 * ESG & carbon (Domain I) and jurisdiction (Domain K).
 *
 * The vocabularies here are the ones a lender's environmental & social
 * supervision mission, an independent RAP monitor or a group auditor uses.
 * That matters: "compensated at full replacement cost" and "compensated at
 * depreciated market value" are different facts under IFC Performance
 * Standard 5, an ESRS E1 datapoint is not a made-up KPI, and a functional
 * currency is not the currency the invoice happened to be written in.
 *
 * Add new `as const` string unions and their types here; never edit enums.ts
 * from a parallel work package.
 */

/* ================================================================== */
/* Land, resettlement & community (Domain J)                           */
/* ================================================================== */

/**
 * How title actually passed (#551–554). The audit bug this fixes: a
 * state-owned, donated or court-ordered parcel used to reach `acquired`
 * only by first being marked `disputed`, which manufactured fictitious
 * disputes on every road scheme dominated by state land.
 */
export const ACQUISITION_BASES = [
  "purchase",
  "donation",
  "state_allocation",
  "lease",
  "court_order",
  "expropriation",
] as const;
export type AcquisitionBasis = (typeof ACQUISITION_BASES)[number];

/**
 * Asset classes valued in a replacement-cost study. PS5 para 27 requires
 * compensation at FULL replacement cost — market value of the asset with no
 * deduction for depreciation, plus transaction costs — so the study has to
 * name the asset it prices.
 */
export const REPLACEMENT_ASSET_TYPES = [
  "land",
  "structure",
  "crops",
  "trees",
  "business",
  "fixture",
  "cultural_asset",
  "other",
] as const;
export type ReplacementAssetType = (typeof REPLACEMENT_ASSET_TYPES)[number];

/** Who produced the valuation — independence is the point (#550). */
export const VALUATION_METHODS = [
  "market_survey",
  "government_schedule",
  "independent_valuer",
  "negotiated",
  "court_determined",
] as const;
export type ValuationMethod = (typeof VALUATION_METHODS)[number];

/** Verdict of a replacement-cost adequacy test. */
export const REPLACEMENT_VERDICTS = ["adequate", "shortfall", "unverified"] as const;
export type ReplacementVerdict = (typeof REPLACEMENT_VERDICTS)[number];

/**
 * Instruments that discharge PS7 (Indigenous Peoples) and PS8 (Cultural
 * Heritage) where they are triggered.
 */
export const HERITAGE_PLAN_KINDS = [
  "indigenous_peoples_plan",
  "cultural_heritage_management_plan",
  "chance_find_procedure",
  "fpic_process",
  "community_development_plan",
] as const;
export type HeritagePlanKind = (typeof HERITAGE_PLAN_KINDS)[number];

export const HERITAGE_PLAN_STATUSES = [
  "draft",
  "consulted",
  "disclosed",
  "approved",
  "implemented",
  "closed",
] as const;
export type HeritagePlanStatus = (typeof HERITAGE_PLAN_STATUSES)[number];

/** A chance find stops the work until the authority has spoken (PS8 para 16). */
export const CHANCE_FIND_STATUSES = [
  "reported",
  "work_stopped",
  "authority_notified",
  "assessed",
  "released",
] as const;
export type ChanceFindStatus = (typeof CHANCE_FIND_STATUSES)[number];

/** Livelihood restoration measures (#561, PS5 paras 27–29). */
export const LIVELIHOOD_ACTIVITY_KINDS = [
  "land_for_land",
  "skills_training",
  "business_grant",
  "employment",
  "transitional_allowance",
  "agricultural_input",
  "microfinance",
  "market_access",
  "other",
] as const;
export type LivelihoodActivityKind = (typeof LIVELIHOOD_ACTIVITY_KINDS)[number];

export const LIVELIHOOD_ACTIVITY_STATUSES = [
  "planned",
  "in_progress",
  "delivered",
  "verified",
  "failed",
] as const;
export type LivelihoodActivityStatus = (typeof LIVELIHOOD_ACTIVITY_STATUSES)[number];

/** What a RAP completion audit concluded (#568). */
export const RAP_AUDIT_CONCLUSIONS = [
  "complete",
  "substantially_complete",
  "incomplete",
  "not_assessed",
] as const;
export type RapAuditConclusion = (typeof RAP_AUDIT_CONCLUSIONS)[number];

/**
 * Grievance escalation ladder (#572). Tier 0 is the site officer; a breach
 * of the acknowledgement clock raises to tier 1 (community liaison manager),
 * a breach of the resolution clock to tier 2 (project director), and tier 3
 * is the external / judicial route the GRM must never obstruct.
 */
export const GRIEVANCE_TIERS = [0, 1, 2, 3] as const;
export type GrievanceTier = (typeof GRIEVANCE_TIERS)[number];

/* ================================================================== */
/* ESG, carbon & environment (Domain I)                                */
/* ================================================================== */

/** Environmental media a consent condition sets a limit in. */
export const ENVIRONMENTAL_MEDIA = [
  "air",
  "noise",
  "vibration",
  "water",
  "groundwater",
  "soil",
  "dust",
  "odour",
  "light",
] as const;
export type EnvironmentalMedium = (typeof ENVIRONMENTAL_MEDIA)[number];

/**
 * A limit is only meaningful with the direction it bites in: a dust limit is
 * a ceiling, a dissolved-oxygen limit is a floor.
 */
export const LIMIT_DIRECTIONS = ["max", "min"] as const;
export type LimitDirection = (typeof LIMIT_DIRECTIONS)[number];

export const ENVIRONMENTAL_INCIDENT_KINDS = [
  "spill",
  "discharge",
  "emission",
  "habitat_damage",
  "protected_species",
  "waste_misrouting",
  "noise_complaint",
  "dust_complaint",
  "contamination",
  "other",
] as const;
export type EnvironmentalIncidentKind = (typeof ENVIRONMENTAL_INCIDENT_KINDS)[number];

export const ENVIRONMENTAL_INCIDENT_STATUSES = [
  "open",
  "contained",
  "remediated",
  "closed",
] as const;
export type EnvironmentalIncidentStatus = (typeof ENVIRONMENTAL_INCIDENT_STATUSES)[number];

/** Biodiversity net gain accounting stages (Defra metric shape). */
export const BIODIVERSITY_STAGES = ["baseline", "post_intervention", "target"] as const;
export type BiodiversityStage = (typeof BIODIVERSITY_STAGES)[number];

export const HABITAT_CONDITIONS = ["poor", "moderate", "good", "n_a"] as const;
export type HabitatCondition = (typeof HABITAT_CONDITIONS)[number];

/** Where a design-option carbon comparison got to (#502–504). */
export const CARBON_OPTION_DECISIONS = [
  "under_review",
  "adopted",
  "rejected",
  "deferred",
] as const;
export type CarbonOptionDecision = (typeof CARBON_OPTION_DECISIONS)[number];

/** Transport modes for A4 / A5 transport carbon, with a code-resident factor. */
export const CARBON_TRANSPORT_MODES = [
  "rigid_truck",
  "articulated_truck",
  "van",
  "rail",
  "sea_container",
  "sea_bulk",
  "inland_barge",
  "air_freight",
] as const;
export type CarbonTransportMode = (typeof CARBON_TRANSPORT_MODES)[number];

/** ISO 14001:2015 clause set an EMS evidence record can be filed against. */
export const ISO14001_CLAUSES = [
  "4.1_context",
  "4.2_interested_parties",
  "4.3_scope",
  "5.1_leadership",
  "5.2_policy",
  "6.1.2_environmental_aspects",
  "6.1.3_compliance_obligations",
  "6.2_objectives",
  "7.2_competence",
  "7.4_communication",
  "7.5_documented_information",
  "8.1_operational_control",
  "8.2_emergency_preparedness",
  "9.1_monitoring",
  "9.2_internal_audit",
  "9.3_management_review",
  "10.2_nonconformity",
  "10.3_continual_improvement",
] as const;
export type Iso14001Clause = (typeof ISO14001_CLAUSES)[number];

export const EMS_EVIDENCE_STATUSES = [
  "not_started",
  "in_progress",
  "evidenced",
  "verified",
  "nonconforming",
] as const;
export type EmsEvidenceStatus = (typeof EMS_EVIDENCE_STATUSES)[number];

/**
 * Disclosure frameworks the platform can assemble a period return for.
 * Each figure carries the ledger entries and evidence hashes behind it —
 * an unciteable number is reported as unavailable, never as zero.
 */
export const DISCLOSURE_FRAMEWORKS = [
  "esrs_e1_climate",
  "esrs_e5_circular",
  "esrs_s1_workforce",
  "ifrs_s2_climate",
  "tcfd",
  "modern_slavery_statement",
  "ghg_protocol",
] as const;
export type DisclosureFramework = (typeof DISCLOSURE_FRAMEWORKS)[number];

/* ================================================================== */
/* Jurisdiction, entities & currency (Domain K)                        */
/* ================================================================== */

/** Statutory permit lifecycle transitions are enumerated in code, not free. */
export const PERMIT_REAPPLICATION_STATUSES = ["refused", "expired"] as const;

/** IAS 21 translation methods for a consolidation run. */
export const TRANSLATION_METHODS = ["closing_rate", "average_rate", "historical_rate"] as const;
export type TranslationMethod = (typeof TRANSLATION_METHODS)[number];

/** What a reporting entity is, for group consolidation. */
export const ENTITY_ROLES = [
  "parent",
  "subsidiary",
  "branch",
  "joint_venture",
  "associate",
  "permanent_establishment",
] as const;
export type EntityRole = (typeof ENTITY_ROLES)[number];

/** ICV / local-content certificate lifecycle (#612–615). */
export const ICV_CERTIFICATE_STATUSES = [
  "issued",
  "expiring",
  "expired",
  "withdrawn",
  "superseded",
] as const;
export type IcvCertificateStatus = (typeof ICV_CERTIFICATE_STATUSES)[number];

/** How a local-content reading was arrived at — the honesty column. */
export const LOCAL_CONTENT_SOURCES = ["manual", "computed", "certified"] as const;
export type LocalContentSource = (typeof LOCAL_CONTENT_SOURCES)[number];

/* ================================================================== */
/* Detectors                                                           */
/* ================================================================== */

/**
 * Every safeguards detector, named once. These strings are the `detector`
 * column on `signals` and the prefix of the signal fingerprint, so a rename
 * orphans open findings — treat them as data, not labels.
 */
export const SAFEGUARD_DETECTORS = [
  // land / resettlement
  "land_blocks_programme",
  "works_started_on_unconsented_land",
  "displacement_before_compensation",
  "vulnerable_household_without_enhanced_entitlement",
  "cut_off_not_disclosed",
  "livelihood_not_restored",
  "replacement_cost_shortfall",
  "grievance_sla_breach",
  "grievance_hotspot",
  "chance_find_unreleased",
  // esg
  "carbon_budget_exceeded",
  "social_value_shortfall",
  "environmental_limit_exceeded",
  "environmental_incident_unreported",
  "biodiversity_net_loss",
  // jurisdiction
  "permit_determination_overdue",
  "permit_expired",
  "permit_blocks_programme",
  "local_content_shortfall",
  "icv_certificate_expiring",
] as const;
export type SafeguardDetector = (typeof SAFEGUARD_DETECTORS)[number];
