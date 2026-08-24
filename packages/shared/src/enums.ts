/**
 * Platform-wide enumerations. These are the single source of truth for
 * lifecycle states and classifications used by the database schema, the API
 * and the web client. Values are stored as text in the database, so renaming
 * a member is a data migration, not a refactor.
 */

export const PROJECT_STAGES = [
  "bidding",
  "pre_construction",
  "course_of_construction",
  "warranty",
  "closed",
] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];

export const COST_TYPES = [
  "labour",
  "material",
  "equipment",
  "subcontract",
  "other",
] as const;
export type CostType = (typeof COST_TYPES)[number];

export const RECORD_STATUSES = ["draft", "open", "closed", "void"] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

/** RFI lifecycle */
export const RFI_STATUSES = ["draft", "open", "answered", "closed", "void"] as const;
export type RfiStatus = (typeof RFI_STATUSES)[number];

/** Submittal reviewer response codes (configurable sets layer on top of these) */
export const SUBMITTAL_RESPONSES = [
  "approved",
  "approved_as_noted",
  "revise_and_resubmit",
  "rejected",
  "for_record",
] as const;
export type SubmittalResponse = (typeof SUBMITTAL_RESPONSES)[number];

export const SUBMITTAL_STATUSES = [
  "draft",
  "open",
  "in_review",
  "responded",
  "closed",
  "void",
] as const;
export type SubmittalStatus = (typeof SUBMITTAL_STATUSES)[number];

export const SUBMITTAL_TYPES = [
  "shop_drawing",
  "product_data",
  "sample",
  "mock_up",
  "o_and_m",
  "warranty",
  "certificate",
  "other",
] as const;
export type SubmittalType = (typeof SUBMITTAL_TYPES)[number];

export const PUNCH_STATUSES = [
  "open",
  "in_progress",
  "ready_for_review",
  "closed",
  "void",
] as const;
export type PunchStatus = (typeof PUNCH_STATUSES)[number];

export const WORKFLOW_STEP_TYPES = ["approval", "review", "acknowledge"] as const;
export type WorkflowStepType = (typeof WORKFLOW_STEP_TYPES)[number];

export const WORKFLOW_INSTANCE_STATUSES = [
  "running",
  "approved",
  "rejected",
  "cancelled",
] as const;
export type WorkflowInstanceStatus = (typeof WORKFLOW_INSTANCE_STATUSES)[number];

export const WORKFLOW_STEP_DECISIONS = ["pending", "approved", "rejected", "skipped"] as const;
export type WorkflowStepDecision = (typeof WORKFLOW_STEP_DECISIONS)[number];

/** Drawing disciplines (standard sheet prefixes) */
export const DRAWING_DISCIPLINES = [
  "general",
  "civil",
  "architectural",
  "structural",
  "mechanical",
  "electrical",
  "plumbing",
  "fire_protection",
  "landscape",
  "interiors",
  "telecom",
  "other",
] as const;
export type DrawingDiscipline = (typeof DRAWING_DISCIPLINES)[number];

/** ISO 19650 Common Data Environment container states */
export const CDE_STATES = ["wip", "shared", "published", "archived"] as const;
export type CdeState = (typeof CDE_STATES)[number];

/** ISO 19650 suitability codes (subset, extensible per tenant) */
export const SUITABILITY_CODES = [
  "S0", // WIP
  "S1", // shared for coordination
  "S2", // shared for information
  "S3", // shared for review & comment
  "S4", // shared for stage approval
  "A1", // published / authorized
  "B1", // partial sign-off
  "CR", // as constructed record
] as const;
export type SuitabilityCode = (typeof SUITABILITY_CODES)[number];

/** BIM model source formats accepted by the ingestion pipeline */
export const MODEL_FORMATS = ["ifc", "gltf", "glb", "nwd", "rvt", "other"] as const;
export type ModelFormat = (typeof MODEL_FORMATS)[number];

export const COORDINATION_ISSUE_STATUSES = [
  "open",
  "assigned",
  "resolved",
  "verified",
  "void",
] as const;
export type CoordinationIssueStatus = (typeof COORDINATION_ISSUE_STATUSES)[number];

/** Digital twin sensor channel kinds */
export const SENSOR_KINDS = [
  "temperature",
  "humidity",
  "co2",
  "energy",
  "water",
  "vibration",
  "occupancy",
  "pressure",
  "flow",
  "level",
  "power",
  "custom",
] as const;
export type SensorKind = (typeof SENSOR_KINDS)[number];

export const ASSET_CRITICALITY = ["low", "medium", "high", "critical"] as const;
export type AssetCriticality = (typeof ASSET_CRITICALITY)[number];

/* ------------------------------------------------------------------ */
/* Assurance layer (Volume III data primitives)                        */
/* ------------------------------------------------------------------ */

export const ASSERTION_KINDS = [
  "quantity",
  "rate",
  "progress_percent",
  "headcount",
  "entitlement",
  "cost",
  "duration",
  "other",
] as const;
export type AssertionKind = (typeof ASSERTION_KINDS)[number];

export const EVIDENCE_KINDS = [
  "photograph",
  "video",
  "document",
  "telematics",
  "biometric_log",
  "delivery_note",
  "survey",
  "inspection",
  "bank_transaction",
  "sensor_reading",
  "reality_capture",
  "access_control_log",
  "corporate_registry",
  "other",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const RECONCILIATION_RESULTS = [
  "supported",
  "partially_supported",
  "unsupported",
  "contradicted",
  "insufficient_evidence",
] as const;
export type ReconciliationResult = (typeof RECONCILIATION_RESULTS)[number];

export const OBLIGATION_STATUSES = [
  "open",
  "satisfied",
  "breached",
  "waived",
  "disputed",
] as const;
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];

export const SIGNAL_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type SignalSeverity = (typeof SIGNAL_SEVERITIES)[number];

export const SIGNAL_DISPOSITIONS = [
  "new",
  "under_review",
  "confirmed",
  "false_positive",
  "escalated",
  "closed",
] as const;
export type SignalDisposition = (typeof SIGNAL_DISPOSITIONS)[number];

export const ENTITY_KINDS = ["person", "company", "government_body", "other"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const ENTITY_RELATIONSHIP_KINDS = [
  "director_of",
  "beneficial_owner_of",
  "shareholder_of",
  "employee_of",
  "shares_address_with",
  "shares_bank_account_with",
  "shares_contact_with",
  "related_party",
  "subsidiary_of",
] as const;
export type EntityRelationshipKind = (typeof ENTITY_RELATIONSHIP_KINDS)[number];

/** Every mutation appended to the evidentiary ledger carries one of these. */
export const LEDGER_ACTIONS = ["create", "update", "delete", "state_change", "access"] as const;
export type LedgerAction = (typeof LEDGER_ACTIONS)[number];

/* ------------------------------------------------------------------ */
/* AI layer                                                            */
/* ------------------------------------------------------------------ */

export const AI_AGENT_KINDS = [
  "document_search",
  "submittal_review",
  "daily_log_draft",
  "rfi_evaluation",
  "contract_risk",
  "sheet_naming",
  "photo_intelligence",
  "assistant",
] as const;
export type AiAgentKind = (typeof AI_AGENT_KINDS)[number];

export const AI_REVIEW_STATUSES = ["pending", "approved", "rejected", "superseded"] as const;
export type AiReviewStatus = (typeof AI_REVIEW_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Commercial — measurement & valuation (spec Vol II Domain B / M7)    */
/* ------------------------------------------------------------------ */

export const BOQ_METHODS = ["nrm2", "smm7", "cesmm4", "pomi", "custom"] as const;
export type BoqMethod = (typeof BOQ_METHODS)[number];

export const BOQ_LEVELS = ["bill", "section", "item"] as const;
export type BoqLevel = (typeof BOQ_LEVELS)[number];

export const BOQ_ITEM_TYPES = [
  "measured",
  "provisional_defined",
  "provisional_undefined",
  "prime_cost",
  "prelims_fixed",
  "prelims_time",
  "daywork",
  "contingency",
  "spot",
] as const;
export type BoqItemType = (typeof BOQ_ITEM_TYPES)[number];

export const BOQ_STATUSES = ["draft", "issued", "agreed"] as const;
export type BoqStatus = (typeof BOQ_STATUSES)[number];

export const VALUATION_BASES = ["remeasure", "percent", "milestone"] as const;
export type ValuationBasis = (typeof VALUATION_BASES)[number];

export const VALUATION_STATUSES = ["draft", "submitted", "certified", "paid"] as const;
export type ValuationStatus = (typeof VALUATION_STATUSES)[number];

export const CERTIFICATE_STATUSES = ["issued", "paid", "withdrawn"] as const;
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

export const VARIATION_STATUSES = [
  "proposed",
  "instructed",
  "valued",
  "agreed",
  "rejected",
  "withdrawn",
] as const;
export type VariationStatus = (typeof VARIATION_STATUSES)[number];

/** Variation valuation bases (spec Domain B #168-171). */
export const VARIATION_BASES = ["bq_rates", "pro_rata", "star_rate", "daywork"] as const;
export type VariationBasis = (typeof VARIATION_BASES)[number];

/* ------------------------------------------------------------------ */
/* Contract intelligence (spec Vol II Domain C / M8)                   */
/* ------------------------------------------------------------------ */

export const CONTRACT_FORMS = [
  "fidic_red_1999",
  "fidic_red_2017",
  "fidic_yellow_2017",
  "fidic_silver_2017",
  "nec3_ecc",
  "nec4_ecc",
  "jct_sbc_2016",
  "jct_db_2016",
  "bespoke",
] as const;
export type ContractForm = (typeof CONTRACT_FORMS)[number];

export const NEC_OPTIONS = ["A", "B", "C", "D", "E", "F"] as const;
export type NecOption = (typeof NEC_OPTIONS)[number];

export const CONTRACT_STATUSES = ["draft", "executed", "completed", "terminated"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const CONTRACT_EVENT_KINDS = [
  "early_warning",
  "claim_notice",
  "compensation_event",
  "variation_instruction",
  "eot_claim",
  "payment_notice",
  "pay_less_notice",
  "delay_event",
  "other",
] as const;
export type ContractEventKind = (typeof CONTRACT_EVENT_KINDS)[number];

export const CONTRACT_EVENT_STATUSES = [
  "open",
  "notice_served",
  "time_barred",
  "resolved",
  "withdrawn",
] as const;
export type ContractEventStatus = (typeof CONTRACT_EVENT_STATUSES)[number];

export const EOT_STATUSES = [
  "notified",
  "submitted",
  "assessed",
  "agreed",
  "rejected",
  "referred",
] as const;
export type EotStatus = (typeof EOT_STATUSES)[number];

export const CLAUSE_CATEGORIES = [
  "notice",
  "payment",
  "time",
  "variation",
  "risk",
  "termination",
  "dispute",
  "general",
] as const;
export type ClauseCategory = (typeof CLAUSE_CATEGORIES)[number];

/* ------------------------------------------------------------------ */
/* Schedule & delay forensics (spec Vol I §2.6, Vol II Domain D / M9)  */
/* ------------------------------------------------------------------ */

export const DEPENDENCY_TYPES = ["FS", "SS", "FF", "SF"] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

export const TASK_CONSTRAINT_TYPES = [
  "asap",
  "start_no_earlier_than",
  "finish_no_later_than",
  "must_start_on",
] as const;
export type TaskConstraintType = (typeof TASK_CONSTRAINT_TYPES)[number];

/** Delay cause classification (spec Domain D #265). */
export const DELAY_CAUSES = [
  "client_change",
  "late_design_information",
  "exceptional_weather",
  "unforeseen_ground_conditions",
  "authority_or_statutory",
  "contractor_performance",
  "subcontractor_default",
  "supply_chain",
  "force_majeure",
  "other",
] as const;
export type DelayCause = (typeof DELAY_CAUSES)[number];

export const DELAY_EVENT_STATUSES = ["open", "assessed", "withdrawn", "closed"] as const;
export type DelayEventStatus = (typeof DELAY_EVENT_STATUSES)[number];

export const CLAIM_KINDS = ["delay", "disruption", "prolongation", "acceleration"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const CLAIM_STATUSES = [
  "draft",
  "submitted",
  "assessed",
  "agreed",
  "rejected",
  "withdrawn",
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Statutory payment security (spec Vol II Domain F / M10)             */
/* ------------------------------------------------------------------ */

/** Security-of-payment statutory regimes modelled in code. */
export const PAYMENT_REGIMES = [
  "uk_hgcra",
  "sg_sopa",
  "au_nsw_sopa",
  "my_cipaa",
  "nz_cca",
] as const;
export type PaymentRegime = (typeof PAYMENT_REGIMES)[number];

export const PAYMENT_CLAIM_STATUSES = [
  "draft",
  "served",
  "responded",
  "deemed", // no valid response in time — deemed liability
  "paid",
  "suspended", // right-to-suspend exercised
  "referred", // referred to adjudication
] as const;
export type PaymentClaimStatus = (typeof PAYMENT_CLAIM_STATUSES)[number];

export const PAYMENT_RESPONSE_KINDS = ["payment_notice", "pay_less_notice"] as const;
export type PaymentResponseKind = (typeof PAYMENT_RESPONSE_KINDS)[number];

/* ------------------------------------------------------------------ */
/* Quantitative risk (spec Vol II Domain H / M13)                      */
/* ------------------------------------------------------------------ */

export const RISK_CATEGORIES = [
  "technical",
  "commercial",
  "external",
  "organisational",
  "environmental",
  "political",
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export const RISK_STATUSES = ["open", "mitigating", "closed", "realised"] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];

export const DISTRIBUTION_KINDS = [
  "triangular",
  "pert",
  "uniform",
  "normal",
  "lognormal",
  "discrete",
] as const;
export type DistributionKind = (typeof DISTRIBUTION_KINDS)[number];

export const SIMULATION_KINDS = ["qcra", "qsra"] as const;
export type SimulationKind = (typeof SIMULATION_KINDS)[number];

/* ------------------------------------------------------------------ */
/* Capital governance (spec Vol II Domain G / M12)                     */
/* ------------------------------------------------------------------ */

export const BUSINESS_CASE_STAGES = ["strategic_outline", "outline", "full"] as const;
export type BusinessCaseStage = (typeof BUSINESS_CASE_STAGES)[number];

export const BUSINESS_CASE_STATUSES = ["draft", "submitted", "approved", "rejected"] as const;
export type BusinessCaseStatus = (typeof BUSINESS_CASE_STATUSES)[number];

export const GATE_DECISIONS = [
  "proceed",
  "proceed_with_conditions",
  "hold",
  "stop",
] as const;
export type GateDecision = (typeof GATE_DECISIONS)[number];

export const RAG_RATINGS = ["green", "amber_green", "amber", "amber_red", "red"] as const;
export type RagRating = (typeof RAG_RATINGS)[number];

export const BENEFIT_STATUSES = ["planned", "tracking", "realised", "at_risk", "missed"] as const;
export type BenefitStatus = (typeof BENEFIT_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Project finance & disbursement (spec Vol II Domain O / M14)         */
/* ------------------------------------------------------------------ */

export const FACILITY_INSTRUMENTS = [
  "loan",
  "grant",
  "equity",
  "guarantee",
  "blended",
] as const;
export type FacilityInstrument = (typeof FACILITY_INSTRUMENTS)[number];

export const FACILITY_CONDITION_KINDS = ["precedent", "subsequent"] as const;
export type FacilityConditionKind = (typeof FACILITY_CONDITION_KINDS)[number];

export const FACILITY_CONDITION_STATUSES = ["open", "satisfied", "waived", "breached"] as const;
export type FacilityConditionStatus = (typeof FACILITY_CONDITION_STATUSES)[number];

export const DISBURSEMENT_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "disbursed",
  "rejected",
] as const;
export type DisbursementStatus = (typeof DISBURSEMENT_STATUSES)[number];

export const COVENANT_OPERATORS = ["gte", "lte"] as const;
export type CovenantOperator = (typeof COVENANT_OPERATORS)[number];

/* ------------------------------------------------------------------ */
/* Dispute support (spec Vol II Domain E / M15)                        */
/* ------------------------------------------------------------------ */

export const DISPUTE_KINDS = [
  "adjudication",
  "daab",
  "mediation",
  "arbitration",
  "expert_determination",
  "litigation",
] as const;
export type DisputeKind = (typeof DISPUTE_KINDS)[number];

export const DISPUTE_STATUSES = [
  "notified",
  "referred",
  "submissions",
  "hearing",
  "decided",
  "settled",
  "withdrawn",
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const SUBMISSION_KINDS = [
  "referral",
  "response",
  "reply",
  "rejoinder",
  "witness_statement",
  "expert_report",
  "decision",
  "award",
  "other",
] as const;
export type SubmissionKind = (typeof SUBMISSION_KINDS)[number];

export const BUNDLE_STATUSES = ["draft", "generated", "issued"] as const;
export type BundleStatus = (typeof BUNDLE_STATUSES)[number];

export const SETTLEMENT_OFFER_BASES = [
  "without_prejudice",
  "without_prejudice_save_as_to_costs",
  "open",
] as const;
export type SettlementOfferBasis = (typeof SETTLEMENT_OFFER_BASES)[number];

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

export const NOTIFICATION_KINDS = [
  "assignment",
  "mention",
  "status_change",
  "due_soon",
  "overdue",
  "workflow_step",
  "ai_review",
  "signal",
  "system",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
