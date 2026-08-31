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
/* Land, resettlement & community (spec Vol II Domain J / M16)         */
/* ------------------------------------------------------------------ */

export const TENURE_TYPES = [
  "freehold",
  "leasehold",
  "customary",
  "communal",
  "informal",
  "state",
] as const;
export type TenureType = (typeof TENURE_TYPES)[number];

export const PARCEL_STATUSES = [
  "identified",
  "surveyed",
  "under_negotiation",
  "agreed",
  "compensated",
  "acquired",
  "disputed",
] as const;
export type ParcelStatus = (typeof PARCEL_STATUSES)[number];

/** Physical vs economic displacement (spec #565). */
export const DISPLACEMENT_TYPES = ["physical", "economic", "both", "none"] as const;
export type DisplacementType = (typeof DISPLACEMENT_TYPES)[number];

export const PAP_STATUSES = [
  "registered",
  "surveyed",
  "entitlement_agreed",
  "compensated",
  "resettled",
  "livelihood_restored",
  "grievance_open",
] as const;
export type PapStatus = (typeof PAP_STATUSES)[number];

export const GRIEVANCE_CHANNELS = [
  "in_person",
  "phone",
  "sms",
  "email",
  "suggestion_box",
  "community_meeting",
  "anonymous",
  "third_party",
] as const;
export type GrievanceChannel = (typeof GRIEVANCE_CHANNELS)[number];

export const GRIEVANCE_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type GrievanceSeverity = (typeof GRIEVANCE_SEVERITIES)[number];

export const GRIEVANCE_STATUSES = [
  "received",
  "acknowledged",
  "investigating",
  "resolved",
  "closed_verified",
  "escalated",
  "rejected",
] as const;
export type GrievanceStatus = (typeof GRIEVANCE_STATUSES)[number];

export const CONSENT_STATUSES = ["pending", "granted", "conditional", "refused"] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Workforce rights & welfare (spec Vol II Domain M / M17)             */
/* ------------------------------------------------------------------ */

export const WORKER_STATUSES = ["active", "inactive", "demobilised", "blocked"] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

/** Modern-slavery / forced-labour indicators (spec #671-675, #694). */
export const LABOUR_RISK_INDICATORS = [
  "recruitment_fee_paid",
  "passport_retained",
  "contract_substituted",
  "wage_withheld",
  "excessive_overtime",
  "no_rest_day",
  "underage",
  "no_contract_in_language",
  "movement_restricted",
  "debt_bondage",
] as const;
export type LabourRiskIndicator = (typeof LABOUR_RISK_INDICATORS)[number];

export const WELFARE_INSPECTION_AREAS = [
  "accommodation",
  "sanitation",
  "catering",
  "potable_water",
  "transport",
  "heat_stress",
  "ppe",
  "medical",
] as const;
export type WelfareInspectionArea = (typeof WELFARE_INSPECTION_AREAS)[number];

export const LABOUR_AUDIT_STATUSES = ["scheduled", "in_progress", "reported", "closed"] as const;
export type LabourAuditStatus = (typeof LABOUR_AUDIT_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Carbon, ESG & social value (spec Vol II Domain I / M18)             */
/* ------------------------------------------------------------------ */

/** EN 15978 life-cycle modules (spec #492). */
export const CARBON_MODULES = [
  "A1-A3",
  "A4",
  "A5",
  "B1-B7",
  "C1-C4",
  "D",
] as const;
export type CarbonModule = (typeof CARBON_MODULES)[number];

export const CARBON_SCOPES = ["scope_1", "scope_2", "scope_3"] as const;
export type CarbonScope = (typeof CARBON_SCOPES)[number];

export const CARBON_FACTOR_SOURCES = ["epd", "ice_database", "generic", "supplier", "custom"] as const;
export type CarbonFactorSource = (typeof CARBON_FACTOR_SOURCES)[number];

export const WASTE_STREAMS = [
  "inert",
  "non_hazardous",
  "hazardous",
  "metal",
  "timber",
  "plasterboard",
  "packaging",
  "mixed",
] as const;
export type WasteStream = (typeof WASTE_STREAMS)[number];

export const WASTE_DESTINATIONS = [
  "reused",
  "recycled",
  "recovered",
  "incinerated",
  "landfill",
] as const;
export type WasteDestination = (typeof WASTE_DESTINATIONS)[number];

/** UK Social Value Model themes (PPN 06/20, spec #528). */
export const SOCIAL_VALUE_THEMES = [
  "covid_recovery",
  "economic_inequality",
  "fighting_climate_change",
  "equal_opportunity",
  "wellbeing",
] as const;
export type SocialValueTheme = (typeof SOCIAL_VALUE_THEMES)[number];

export const COMMITMENT_STATUSES = ["committed", "on_track", "at_risk", "delivered", "shortfall"] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Multi-jurisdiction operations (spec Vol II Domain K / M19)          */
/* ------------------------------------------------------------------ */

export const FX_RATE_SOURCES = ["contractual", "central_bank", "market", "manual"] as const;
export type FxRateSource = (typeof FX_RATE_SOURCES)[number];

export const PERMIT_KINDS = [
  "work_permit",
  "visa",
  "import_licence",
  "customs_clearance",
  "road_closure",
  "environmental_consent",
  "planning_condition",
  "utility_wayleave",
  "other",
] as const;
export type PermitKind = (typeof PERMIT_KINDS)[number];

export const PERMIT_STATUSES = [
  "not_started",
  "applied",
  "in_review",
  "granted",
  "refused",
  "expired",
] as const;
export type PermitStatus = (typeof PERMIT_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Analytics & reporting (spec Vol I §6)                               */
/* ------------------------------------------------------------------ */

/** Datasets a custom report can be built over. */
export const REPORT_DATASETS = [
  "rfis",
  "submittals",
  "punch_items",
  "daily_logs",
  "delay_events",
  "risks",
  "signals",
  "payment_claims",
  "variations",
  "disbursements",
  "grievances",
  "workers",
] as const;
export type ReportDataset = (typeof REPORT_DATASETS)[number];

export const REPORT_FILTER_OPERATORS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "in",
  "is_null",
  "not_null",
] as const;
export type ReportFilterOperator = (typeof REPORT_FILTER_OPERATORS)[number];

export const REPORT_AGGREGATIONS = ["count", "sum", "avg", "min", "max"] as const;
export type ReportAggregation = (typeof REPORT_AGGREGATIONS)[number];

export const WIDGET_KINDS = ["stat", "bar", "line", "donut", "table"] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

/* ------------------------------------------------------------------ */
/* Ingestion layer (spec Vol III M6 / Domain N, Domain Y #1045-1047)   */
/* ------------------------------------------------------------------ */

export const INGESTION_SOURCE_KINDS = ["csv", "procore", "aconex", "api_token"] as const;
export type IngestionSourceKind = (typeof INGESTION_SOURCE_KINDS)[number];

export const INGESTION_RUN_STATUSES = [
  "staging",
  "validated",
  "committing",
  "committed",
  "failed",
  "discarded",
] as const;
export type IngestionRunStatus = (typeof INGESTION_RUN_STATUSES)[number];

export const STAGED_RECORD_STATUSES = ["staged", "committed", "rejected", "skipped"] as const;
export type StagedRecordStatus = (typeof STAGED_RECORD_STATUSES)[number];

/** Datasets external data can be ingested into, with full provenance. */
export const INGESTION_DATASETS = [
  "vendors",
  "cost_assertions",
  "site_access",
  "payroll",
  "rfis",
  "schedule_tasks",
  "evidence",
  "fx_rates",
  /**
   * Plant telematics. Unlike the others this dataset is COMMITTED BY THE
   * EQUIPMENT MODULE, not by the ingestion module's own writers: readings land
   * in equipment_telematics_readings, idempotent on provider + device +
   * timestamp. It is a member here so a machine token can actually be minted
   * with the right scope and so its runs can be filtered like any other.
   */
  "telematics",
] as const;
export type IngestionDataset = (typeof INGESTION_DATASETS)[number];

/* ------------------------------------------------------------------ */
/* Independent benchmarking (spec Vol II Domain R / M11)               */
/* ------------------------------------------------------------------ */

export const ASSET_CLASSES = [
  "hospital",
  "school",
  "road",
  "rail",
  "water",
  "power",
  "commercial",
  "residential",
  "industrial",
  "other",
] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const BENCHMARK_SAMPLE_SOURCES = ["contributed", "seed"] as const;
export type BenchmarkSampleSource = (typeof BENCHMARK_SAMPLE_SOURCES)[number];

/* ------------------------------------------------------------------ */
/* Ledger anchoring & escrow (spec Vol II Domain S / M1)               */
/* ------------------------------------------------------------------ */

/**
 * How a sealed chain head is witnessed outside the application database.
 * `local_signed` is the always-available provider: an Ed25519 signature made
 * with a key whose private half never enters the database. The remaining
 * providers require external infrastructure and report themselves unavailable
 * rather than pretending — see docs/adr/0017.
 */
export const ANCHOR_PROVIDERS = [
  "local_signed",
  "rfc3161",
  "opentimestamps",
  "counterparty",
] as const;
export type AnchorProvider = (typeof ANCHOR_PROVIDERS)[number];

export const ANCHOR_STATUSES = [
  "pending",
  "anchored",
  "unavailable",
  "failed",
] as const;
export type AnchorStatus = (typeof ANCHOR_STATUSES)[number];

/** Outcome of verifying a chain against its seals. */
export const CHAIN_VERDICTS = [
  "intact",
  "tail_truncated",
  "entry_altered",
  "seal_forged",
  "seal_broken",
  "no_seals",
] as const;
export type ChainVerdict = (typeof CHAIN_VERDICTS)[number];

/* ------------------------------------------------------------------ */
/* Insurance & bonding (spec Vol II Domain P)                          */
/* ------------------------------------------------------------------ */

export const POLICY_TYPES = [
  "contractors_all_risks",
  "erection_all_risks",
  "third_party_liability",
  "professional_indemnity",
  "employers_liability",
  "marine_cargo",
  "delay_in_startup",
  "contractors_plant",
  "environmental_impairment",
  "decennial",
  "other",
] as const;
export type PolicyType = (typeof POLICY_TYPES)[number];

export const POLICY_STATUSES = [
  "draft",
  "active",
  "expired",
  "lapsed",
  "cancelled",
] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

export const BOND_TYPES = [
  "performance",
  "advance_payment",
  "retention",
  "bid",
  "warranty",
  "payment",
  "customs",
  "parent_company_guarantee",
] as const;
export type BondType = (typeof BOND_TYPES)[number];

export const BOND_STATUSES = [
  "draft",
  "issued",
  "active",
  "called",
  "released",
  "expired",
] as const;
export type BondStatus = (typeof BOND_STATUSES)[number];

export const INSURANCE_CLAIM_STATUSES = [
  "notified",
  "acknowledged",
  "under_assessment",
  "accepted",
  "repudiated",
  "settled",
  "withdrawn",
] as const;
export type InsuranceClaimStatus = (typeof INSURANCE_CLAIM_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Organisational learning (spec Vol II Domain W)                      */
/* ------------------------------------------------------------------ */

export const LESSON_CATEGORIES = [
  "design",
  "procurement",
  "commercial",
  "programme",
  "construction",
  "safety",
  "quality",
  "stakeholder",
  "environmental",
  "governance",
  "contractual",
] as const;
export type LessonCategory = (typeof LESSON_CATEGORIES)[number];

/**
 * Events that make lesson capture MANDATORY (#977). A trigger raises an
 * obligation; the lesson is the only thing that discharges it.
 */
export const LESSON_TRIGGER_KINDS = [
  "dispute_closed",
  "variation_threshold",
  "signal_confirmed",
  "delay_event_closed",
  "claim_settled",
  "gate_review",
  "project_closeout",
  "manual",
] as const;
export type LessonTriggerKind = (typeof LESSON_TRIGGER_KINDS)[number];

export const LESSON_STATUSES = [
  "draft",
  "submitted",
  "validated",
  "published",
  "superseded",
  "rejected",
] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];

export const REVIEW_STATUSES = [
  "scheduled",
  "in_progress",
  "completed",
  "signed_off",
  "cancelled",
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Integration surface (spec Vol I §0.7)                               */
/* ------------------------------------------------------------------ */

export const WEBHOOK_DELIVERY_STATUSES = [
  "pending",
  "delivered",
  "failed",
  "exhausted",
  "skipped",
] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/** OAuth2 grants the platform issues to machine callers (#120). */
export const OAUTH_GRANT_TYPES = ["client_credentials"] as const;
export type OauthGrantType = (typeof OAUTH_GRANT_TYPES)[number];

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

/* ------------------------------------------------------------------ */
/* Financial suite — budget, prime contracts, commitments, change      */
/* management, invoicing (spec Vol I §3 / modules M2-M6).              */
/*                                                                     */
/* This is the money spine: every dollar on a project enters through a */
/* budget line, is obligated by a commitment, is moved by a change     */
/* order and leaves through an invoice. The enums below are the        */
/* lifecycle vocabulary those five tools share, so a status string     */
/* means the same thing in the budget view, the change log and the     */
/* billing period.                                                     */
/* ------------------------------------------------------------------ */

/** Budget header lifecycle. A `locked` budget is the baseline: its line
 *  amounts may then only move through an approved `budget_changes` row, which
 *  is what makes original-vs-revised a defensible number rather than an edit
 *  history. `revised` means at least one change has landed since the lock. */
export const BUDGET_STATUSES = ["draft", "locked", "revised", "closed"] as const;
export type BudgetStatus = (typeof BUDGET_STATUSES)[number];

/** Per-line state. `locked` freezes a single line while the rest of the
 *  budget stays editable (used when one cost code is under audit). */
export const BUDGET_LINE_STATUSES = [
  "draft",
  "active",
  "locked",
  "closed",
  "void",
] as const;
export type BudgetLineStatus = (typeof BUDGET_LINE_STATUSES)[number];

/** What a budget line *is*, which decides how forecasting treats it: a
 *  contingency line is drawn down rather than spent, an allowance is
 *  reconciled against actual scope, an alternate is not in the revised total
 *  until it is accepted. */
export const BUDGET_LINE_KINDS = [
  "standard",
  "allowance",
  "contingency",
  "alternate",
  "owner_reserve",
  "escalation",
  "markup",
] as const;
export type BudgetLineKind = (typeof BUDGET_LINE_KINDS)[number];

/** Budget change (transfer / draw) lifecycle. Approval is a distinct actor
 *  from the requester — see `budget_changes.requestedBy` vs `approvedBy`. */
export const BUDGET_CHANGE_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "void",
] as const;
export type BudgetChangeStatus = (typeof BUDGET_CHANGE_STATUSES)[number];

/** Why the budget moved. `transfer` must net to zero across its legs;
 *  `contingency_draw` nets to zero but always sources a contingency line;
 *  `owner_change` is the only kind that changes the budget total, and it
 *  exists only as the downstream effect of an executed prime contract CO. */
export const BUDGET_CHANGE_KINDS = [
  "transfer",
  "contingency_draw",
  "owner_change",
  "adjustment",
  "reallocation",
] as const;
export type BudgetChangeKind = (typeof BUDGET_CHANGE_KINDS)[number];

/** Why a snapshot was taken. Snapshots are immutable period captures: the
 *  monthly close, a gate milestone, or a manual freeze before a big change. */
export const BUDGET_SNAPSHOT_KINDS = [
  "monthly_close",
  "milestone",
  "manual",
  "forecast_lock",
  "closeout",
] as const;
export type BudgetSnapshotKind = (typeof BUDGET_SNAPSHOT_KINDS)[number];

/** How forecast-to-complete was derived. Persisted per forecast row so a
 *  reviewer can see whether a number was typed or computed. */
export const FORECAST_METHODS = [
  "manual",
  "remaining_budget",
  "percent_complete",
  "committed_plus_pending",
  "unit_rate_trend",
  "productivity_trend",
] as const;
export type ForecastMethod = (typeof FORECAST_METHODS)[number];

export const BUDGET_FORECAST_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "superseded",
] as const;
export type BudgetForecastStatus = (typeof BUDGET_FORECAST_STATUSES)[number];

/** Prime contract lifecycle (owner-facing agreement). `approved` means
 *  internally approved; `executed` (a flag, not a status) means signed by
 *  both parties — only then may it be billed against. */
export const PRIME_CONTRACT_STATUSES = [
  "draft",
  "out_for_bid",
  "out_for_signature",
  "approved",
  "complete",
  "terminated",
  "void",
] as const;
export type PrimeContractStatus = (typeof PRIME_CONTRACT_STATUSES)[number];

/** How the contract sum is priced. Drives which SOV billing methods are
 *  legal on the schedule of values and how forecasts roll up. */
export const CONTRACT_PRICING_TYPES = [
  "lump_sum",
  "cost_plus",
  "cost_plus_gmp",
  "unit_price",
  "time_and_materials",
  "design_build",
] as const;
export type ContractPricingType = (typeof CONTRACT_PRICING_TYPES)[number];

/** How a schedule-of-values line earns value in a billing period. */
export const SOV_BILLING_METHODS = [
  "lump_sum",
  "percent_complete",
  "unit_price",
  "milestone",
  "stored_materials",
  "cost_plus",
  "allowance",
] as const;
export type SovBillingMethod = (typeof SOV_BILLING_METHODS)[number];

/** A commitment is either a subcontract (labour + material, retainage,
 *  lien waivers, change orders) or a purchase order (material, tax,
 *  delivery). One table, one discriminator — they share 90% of their shape
 *  and every rollup treats them identically. */
export const COMMITMENT_KINDS = ["subcontract", "purchase_order"] as const;
export type CommitmentKind = (typeof COMMITMENT_KINDS)[number];

/**
 * Commitment lifecycle. NAMED `FINANCIAL_` because `COMMITMENT_STATUSES`
 * above is already taken by ESG social-value commitments (Domain M) and
 * renaming a shipped enum is a data migration, not a refactor.
 */
export const FINANCIAL_COMMITMENT_STATUSES = [
  "draft",
  "out_for_bid",
  "out_for_signature",
  "approved",
  "complete",
  "terminated",
  "void",
] as const;
export type FinancialCommitmentStatus = (typeof FINANCIAL_COMMITMENT_STATUSES)[number];

/** Executed-change lifecycle, shared by prime contract changes (PCCO),
 *  commitment changes (CCO) and the packages that produce them. */
export const CHANGE_ORDER_STATUSES = [
  "draft",
  "pending_pricing",
  "pending_in_house_review",
  "pending_owner_approval",
  "revise_and_resubmit",
  "approved",
  "executed",
  "rejected",
  "no_charge",
  "void",
] as const;
export type ChangeOrderStatus = (typeof CHANGE_ORDER_STATUSES)[number];

/** Change event lifecycle — the origin record for the whole change chain.
 *  `open` = identified, not yet priced; `pending` = priced and moving
 *  through PCO/COR; `closed` = resolved (executed, absorbed or dropped). */
export const CHANGE_EVENT_STATUSES = ["open", "pending", "closed", "void"] as const;
export type ChangeEventStatus = (typeof CHANGE_EVENT_STATUSES)[number];

/** What kind of change this is, commercially. Drives entitlement: an
 *  `errors_omissions` event is a candidate backcharge, a `design_change`
 *  is owner-billable, a `scope_gap` usually is not. */
export const CHANGE_EVENT_TYPES = [
  "design_change",
  "field_condition",
  "owner_request",
  "allowance_reconciliation",
  "value_engineering",
  "backcharge",
  "weather",
  "errors_omissions",
  "regulatory",
  "scope_gap",
  "other",
] as const;
export type ChangeEventType = (typeof CHANGE_EVENT_TYPES)[number];

/** Whether the work is inside the existing contract scope. `tbd` is the
 *  honest default and is what keeps unpriced exposure visible. */
export const CHANGE_EVENT_SCOPES = ["in_scope", "out_of_scope", "tbd"] as const;
export type ChangeEventScope = (typeof CHANGE_EVENT_SCOPES)[number];

/** The record type a change event was raised FROM — an answered RFI, an
 *  observation, a drawing revision. This is the provenance link that lets a
 *  claim be traced back to the document that caused it. */
export const CHANGE_EVENT_ORIGIN_KINDS = [
  "rfi",
  "submittal",
  "observation",
  "daily_log",
  "drawing_revision",
  "specification",
  "meeting",
  "inspection",
  "punch_item",
  "contract_event",
  "schedule_task",
  "document",
  "manual",
] as const;
export type ChangeEventOriginKind = (typeof CHANGE_EVENT_ORIGIN_KINDS)[number];

/** Contractual reason cited on a change order. Reported on the change log
 *  and is the first thing an owner's auditor filters by. */
export const CHANGE_REASONS = [
  "client_request",
  "design_development",
  "design_error",
  "design_omission",
  "unforeseen_condition",
  "existing_condition",
  "code_compliance",
  "coordination_conflict",
  "allowance_reconciliation",
  "value_engineering",
  "weather",
  "owner_directed_acceleration",
  "other",
] as const;
export type ChangeReason = (typeof CHANGE_REASONS)[number];

/** Potential change order — the internal cost position, usually one per
 *  affected commitment. */
export const PCO_STATUSES = [
  "draft",
  "pending_quote",
  "priced",
  "submitted",
  "approved",
  "rejected",
  "no_charge",
  "void",
] as const;
export type PcoStatus = (typeof PCO_STATUSES)[number];

/** Change order request — the priced ask sent to the owner. */
export const COR_STATUSES = [
  "draft",
  "submitted",
  "under_review",
  "negotiating",
  "approved",
  "partially_approved",
  "rejected",
  "withdrawn",
  "void",
] as const;
export type CorStatus = (typeof COR_STATUSES)[number];

/** A change order package executes against exactly one side of the ledger:
 *  the prime contract (PCCO — revenue up) or a commitment (CCO — cost up). */
export const CHANGE_ORDER_PACKAGE_KINDS = ["prime_contract", "commitment"] as const;
export type ChangeOrderPackageKind = (typeof CHANGE_ORDER_PACKAGE_KINDS)[number];

/** RFQ to a subcontractor for change pricing. */
export const QUOTE_REQUEST_STATUSES = [
  "draft",
  "sent",
  "viewed",
  "quoted",
  "accepted",
  "declined",
  "expired",
  "void",
] as const;
export type QuoteRequestStatus = (typeof QUOTE_REQUEST_STATUSES)[number];

/** How a markup line (overhead, profit, bond, insurance) is computed. */
export const MARKUP_KINDS = ["percent", "fixed_amount", "per_unit"] as const;
export type MarkupKind = (typeof MARKUP_KINDS)[number];

/** Procore-style change configuration: how many approval tiers stand
 *  between a change event and an executed change order. Stored per project
 *  in `projects.settings.changeManagementTier`. */
export const CHANGE_MANAGEMENT_TIERS = ["one_tier", "two_tier", "three_tier"] as const;
export type ChangeManagementTier = (typeof CHANGE_MANAGEMENT_TIERS)[number];

/** Invoicing runs in both directions: we bill the owner (an AIA-style
 *  application for payment) and our subs bill us. Same document shape,
 *  opposite sign — one table, one discriminator. */
export const INVOICE_KINDS = ["owner_billing", "subcontractor_invoice"] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

/** Invoice lifecycle. `approved_as_noted` is deliberately distinct from
 *  `approved`: it records that the reviewer cut the amount, which is the
 *  number a later dispute turns on. */
export const INVOICE_STATUSES = [
  "draft",
  "submitted",
  "under_review",
  "revise_and_resubmit",
  "approved",
  "approved_as_noted",
  "rejected",
  "paid",
  "void",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** What an invoice line is billing, so the G703 can group correctly and the
 *  budget knows which bucket the cost lands in. */
export const INVOICE_LINE_SOURCES = [
  "contract_sov",
  "change_order",
  "stored_materials",
  "retainage_release",
  "allowance",
  "tax",
  "credit",
  "other",
] as const;
export type InvoiceLineSource = (typeof INVOICE_LINE_SOURCES)[number];

/** Billing periods gate the whole month: subs submit inside the window,
 *  the owner application is assembled from what was approved, and `locked`
 *  means the period's numbers are frozen for reporting. */
export const BILLING_PERIOD_STATUSES = ["open", "closed", "locked"] as const;
export type BillingPeriodStatus = (typeof BILLING_PERIOD_STATUSES)[number];

/** AIA G702 application lifecycle. `certified` is the architect's act and
 *  is separate from our submission — the certified amount may be lower. */
export const PAYMENT_APPLICATION_STATUSES = [
  "draft",
  "submitted",
  "certified",
  "partially_certified",
  "rejected",
  "paid",
  "void",
] as const;
export type PaymentApplicationStatus = (typeof PAYMENT_APPLICATION_STATUSES)[number];

export const PAYMENT_METHODS = [
  "check",
  "ach",
  "wire",
  "credit_card",
  "cash",
  "joint_check",
  "other",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = [
  "scheduled",
  "on_hold",
  "issued",
  "cleared",
  "failed",
  "voided",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** The four statutory lien waiver forms. Conditional waivers take effect
 *  only on payment clearing; unconditional waivers take effect on signature
 *  — signing an unconditional waiver before the money lands is how
 *  subcontractors lose their lien rights, so the type is never inferred. */
export const LIEN_WAIVER_TYPES = [
  "conditional_progress",
  "unconditional_progress",
  "conditional_final",
  "unconditional_final",
] as const;
export type LienWaiverType = (typeof LIEN_WAIVER_TYPES)[number];

export const LIEN_WAIVER_STATUSES = [
  "draft",
  "requested",
  "sent",
  "signed",
  "received",
  "verified",
  "rejected",
  "not_required",
  "void",
] as const;
export type LienWaiverStatus = (typeof LIEN_WAIVER_STATUSES)[number];

/** Which side of the ledger a retainage release sits on: the owner
 *  releasing to us, or us releasing to a sub. */
export const RETAINAGE_SCOPES = ["prime_contract", "commitment"] as const;
export type RetainageScope = (typeof RETAINAGE_SCOPES)[number];

/** How retainage was calculated on the amount being released. */
export const RETAINAGE_BASES = [
  "percent_work_completed",
  "percent_stored_materials",
  "fixed_amount",
  "milestone_reduction",
  "none",
] as const;
export type RetainageBasis = (typeof RETAINAGE_BASES)[number];

export const RETAINAGE_RELEASE_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "released",
  "void",
] as const;
export type RetainageReleaseStatus = (typeof RETAINAGE_RELEASE_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Specifications (spec Vol I §2.3 / module M19)                       */
/*                                                                     */
/* A spec book is not a PDF in a folder. It is the SOURCE the          */
/* submittal register is built from, the thing a revision supersedes,  */
/* and the clause an NCR is raised against. These enums carry that     */
/* lifecycle so a section reference means the same thing in the        */
/* submittal log, the ITP and the bid package.                         */
/* ------------------------------------------------------------------ */

/** Which sectioning standard the book's codes belong to. Stored because
 *  "03 30 00" and "03300" are the same section under different editions and
 *  a cross-project search has to know which it is looking at. */
export const SPEC_CLASSIFICATION_SYSTEMS = [
  "masterformat_2020",
  "masterformat_1995",
  "uniclass_2015",
  "nbs_chapters",
  "custom",
] as const;
export type SpecClassificationSystem = (typeof SPEC_CLASSIFICATION_SYSTEMS)[number];

/** Spec book lifecycle. `processing` is the split-and-extract pipeline (the
 *  same shape as a drawing set); `current` is the one the register is built
 *  from; `superseded` books stay queryable because a submittal approved two
 *  years ago was approved against THAT text. */
export const SPEC_BOOK_STATUSES = [
  "draft",
  "processing",
  "current",
  "superseded",
  "archived",
  "failed",
] as const;
export type SpecBookStatus = (typeof SPEC_BOOK_STATUSES)[number];

export const SPEC_SECTION_STATUSES = [
  "draft",
  "current",
  "superseded",
  "withdrawn",
] as const;
export type SpecSectionStatus = (typeof SPEC_SECTION_STATUSES)[number];

/** A submittal requirement read out of a section. `identified` is what the
 *  extractor found, `confirmed` is what a human agreed with, `registered`
 *  means a real submittals row now exists for it — the three states are the
 *  whole audit trail of "the register was built from the spec". */
export const SPEC_REQUIREMENT_STATUSES = [
  "identified",
  "confirmed",
  "registered",
  "not_required",
  "superseded",
] as const;
export type SpecRequirementStatus = (typeof SPEC_REQUIREMENT_STATUSES)[number];

/** How a requirement or a cross-reference got into the platform. Kept
 *  because an AI-extracted requirement and a human-typed one carry very
 *  different weight when a submittal is later claimed to have been missed. */
export const SPEC_EXTRACTION_METHODS = ["manual", "ai_extracted", "imported"] as const;
export type SpecExtractionMethod = (typeof SPEC_EXTRACTION_METHODS)[number];

export const SPEC_REFERENCE_TARGETS = [
  "drawing_sheet",
  "drawing_revision",
  "rfi",
  "submittal",
  "document",
  "spec_section",
  "change_event",
  "bid_package",
] as const;
export type SpecReferenceTarget = (typeof SPEC_REFERENCE_TARGETS)[number];

/** What the reference asserts. `conflicts_with` is the valuable one: a spec
 *  clause that contradicts a drawing is the origin of a change order, and
 *  recording the conflict at the paragraph is what makes the claim provable. */
export const SPEC_REFERENCE_KINDS = [
  "detailed_on",
  "clarified_by",
  "coordinates_with",
  "conflicts_with",
  "procured_under",
  "superseded_by",
  "referenced_by",
] as const;
export type SpecReferenceKind = (typeof SPEC_REFERENCE_KINDS)[number];

/* ------------------------------------------------------------------ */
/* Meetings (spec Vol I §2.9 / module M20)                             */
/*                                                                     */
/* The point of the module is not the minutes. It is the ACTION ITEM:  */
/* an owner, a date and a state that survives across occurrences, and  */
/* that can be promoted into an Obligation (ADR 0012) when what was    */
/* agreed in a meeting is something a contract actually requires.      */
/* ------------------------------------------------------------------ */

export const MEETING_TYPES = [
  "owner_architect_contractor",
  "progress",
  "coordination",
  "subcontractor",
  "design",
  "safety",
  "commercial",
  "pre_construction",
  "kick_off",
  "pre_installation",
  "commissioning",
  "handover",
  "closeout",
  "board",
  "other",
] as const;
export type MeetingType = (typeof MEETING_TYPES)[number];

export const MEETING_RECURRENCES = [
  "none",
  "daily",
  "weekly",
  "fortnightly",
  "monthly",
  "quarterly",
  "custom",
] as const;
export type MeetingRecurrence = (typeof MEETING_RECURRENCES)[number];

export const MEETING_SERIES_STATUSES = ["active", "paused", "closed"] as const;
export type MeetingSeriesStatus = (typeof MEETING_SERIES_STATUSES)[number];

/** Occurrence lifecycle. `minutes_draft` and `minutes_issued` are distinct
 *  states because the issued minutes are the record a party is deemed to have
 *  accepted if they do not object within the stated period. */
export const MEETING_STATUSES = [
  "scheduled",
  "in_progress",
  "held",
  "minutes_draft",
  "minutes_issued",
  "minutes_accepted",
  "cancelled",
] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const MEETING_ATTENDEE_ROLES = [
  "chair",
  "minute_taker",
  "required",
  "optional",
  "presenter",
  "observer",
  "distribution_only",
] as const;
export type MeetingAttendeeRole = (typeof MEETING_ATTENDEE_ROLES)[number];

/** Attendance as actually recorded. `apologies` is separate from `absent`:
 *  a party who sent apologies was still notified, which is what matters when
 *  a decision taken in their absence is later challenged. */
export const MEETING_ATTENDANCE_STATES = [
  "present",
  "absent",
  "apologies",
  "late",
  "left_early",
  "delegate_attended",
  "remote",
] as const;
export type MeetingAttendanceState = (typeof MEETING_ATTENDANCE_STATES)[number];

export const MEETING_ITEM_CATEGORIES = [
  "safety",
  "quality",
  "progress",
  "programme",
  "design",
  "commercial",
  "procurement",
  "risk",
  "environmental",
  "logistics",
  "information",
  "other",
] as const;
export type MeetingItemCategory = (typeof MEETING_ITEM_CATEGORIES)[number];

/** Agenda item state. `carried_forward` is the state that makes an agenda a
 *  management tool rather than a list: an item that has been carried five
 *  times is a project problem, and the count is queryable because the state
 *  exists. */
export const MEETING_AGENDA_ITEM_STATUSES = [
  "open",
  "in_progress",
  "carried_forward",
  "deferred",
  "noted",
  "closed",
] as const;
export type MeetingAgendaItemStatus = (typeof MEETING_AGENDA_ITEM_STATUSES)[number];

/** A decision minuted in a meeting. `ratified` is a second act by someone who
 *  was not in the room — the segregation that stops a decision with cost
 *  consequences from being self-authorised in the minutes. */
export const MEETING_DECISION_STATUSES = [
  "recorded",
  "ratified",
  "superseded",
  "rescinded",
  "disputed",
] as const;
export type MeetingDecisionStatus = (typeof MEETING_DECISION_STATUSES)[number];

export const ACTION_ITEM_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "completed",
  "verified",
  "cancelled",
] as const;
export type ActionItemStatus = (typeof ACTION_ITEM_STATUSES)[number];

export const ACTION_ITEM_PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type ActionItemPriority = (typeof ACTION_ITEM_PRIORITIES)[number];

/* ------------------------------------------------------------------ */
/* Safety (spec Vol I §2.11 / module M21)                              */
/*                                                                     */
/* Two audiences read these records and neither is the site team: an   */
/* INSURER, who prices the loss, and a REGULATOR, who decides whether  */
/* the event was reportable and whether it was reported in time. The   */
/* vocabulary below is theirs — treatment level, body part, mechanism, */
/* reportability regime — because a free-text incident note is worth   */
/* nothing to either of them.                                          */
/* ------------------------------------------------------------------ */

/** An observation is either a good practice worth repeating or a hazard
 *  worth fixing. Recording both is what makes the ratio meaningful: a site
 *  reporting only negatives has a reporting culture problem, not a safe one. */
export const SAFETY_OBSERVATION_KINDS = ["positive", "negative"] as const;
export type SafetyObservationKind = (typeof SAFETY_OBSERVATION_KINDS)[number];

export const SAFETY_CATEGORIES = [
  "ppe",
  "working_at_height",
  "housekeeping",
  "electrical",
  "excavation",
  "lifting_operations",
  "hot_works",
  "confined_space",
  "plant_and_equipment",
  "manual_handling",
  "hazardous_substances",
  "fire",
  "traffic_management",
  "temporary_works",
  "permit_compliance",
  "environmental",
  "welfare",
  "behaviour",
  "emergency_preparedness",
  "other",
] as const;
export type SafetyCategory = (typeof SAFETY_CATEGORIES)[number];

/** Severity of an observation — how bad the outcome COULD have been, which
 *  is the only useful ranking for something that has not yet hurt anyone. */
export const SAFETY_SEVERITIES = [
  "informational",
  "low",
  "medium",
  "high",
  "critical",
] as const;
export type SafetySeverity = (typeof SAFETY_SEVERITIES)[number];

export const SAFETY_OBSERVATION_STATUSES = [
  "open",
  "action_assigned",
  "actioned",
  "verified",
  "closed",
  "void",
] as const;
export type SafetyObservationStatus = (typeof SAFETY_OBSERVATION_STATUSES)[number];

export const INCIDENT_TYPES = [
  "injury",
  "occupational_illness",
  "near_miss",
  "property_damage",
  "environmental",
  "fire",
  "dangerous_occurrence",
  "security",
  "road_traffic",
  "utility_strike",
  "structural_failure",
  "public_impact",
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

/** Actual outcome severity, as an insurer bands it. */
export const INCIDENT_SEVERITIES = [
  "negligible",
  "minor",
  "serious",
  "major",
  "catastrophic",
] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

/** Treatment level drives recordability under every regime that exists:
 *  first aid alone is not recordable, medical treatment beyond first aid is,
 *  and the boundary between them is the single most audited judgement in the
 *  whole of incident reporting. */
export const INJURY_TREATMENT_LEVELS = [
  "none",
  "first_aid",
  "medical_treatment",
  "emergency_department",
  "hospitalised",
  "fatality",
] as const;
export type InjuryTreatmentLevel = (typeof INJURY_TREATMENT_LEVELS)[number];

export const BODY_PARTS = [
  "head",
  "eye",
  "face",
  "neck",
  "shoulder",
  "arm",
  "elbow",
  "wrist",
  "hand",
  "finger",
  "chest",
  "abdomen",
  "back_upper",
  "back_lower",
  "hip",
  "leg",
  "knee",
  "ankle",
  "foot",
  "toe",
  "internal",
  "multiple",
  "not_applicable",
] as const;
export type BodyPart = (typeof BODY_PARTS)[number];

export const INJURY_NATURES = [
  "laceration",
  "contusion",
  "fracture",
  "sprain_strain",
  "burn_thermal",
  "burn_chemical",
  "amputation",
  "crush",
  "puncture",
  "foreign_body",
  "dislocation",
  "concussion",
  "electric_shock",
  "asphyxiation",
  "hearing_loss",
  "respiratory",
  "dermatitis",
  "heat_illness",
  "hypothermia",
  "psychological",
  "multiple",
  "other",
] as const;
export type InjuryNature = (typeof INJURY_NATURES)[number];

/** The mechanism — how energy reached the person. Statutory forms all ask
 *  for it and it is the field root-cause analytics actually cluster on. */
export const INCIDENT_MECHANISMS = [
  "struck_by",
  "struck_against",
  "caught_in_or_between",
  "fall_from_height",
  "fall_same_level",
  "slip_trip",
  "manual_handling",
  "repetitive_motion",
  "electrical_contact",
  "chemical_contact",
  "thermal_contact",
  "inhalation",
  "vehicle_collision",
  "collapse",
  "explosion",
  "drowning",
  "animal_insect",
  "violence",
  "other",
] as const;
export type IncidentMechanism = (typeof INCIDENT_MECHANISMS)[number];

/** Who was hurt determines which register the event belongs in and whose
 *  insurer pays: a member of the public is public liability, an agency worker
 *  is a different employer's RIDDOR duty, our own employee is ours. */
export const INJURED_PERSON_TYPES = [
  "employee",
  "subcontractor",
  "agency",
  "self_employed",
  "visitor",
  "delivery_driver",
  "member_of_public",
  "client_representative",
  "trainee",
  "unknown",
] as const;
export type InjuredPersonType = (typeof INJURED_PERSON_TYPES)[number];

export const ROOT_CAUSE_METHODS = [
  "five_whys",
  "fishbone",
  "taproot",
  "bowtie",
  "fault_tree",
  "icam",
  "none",
] as const;
export type RootCauseMethod = (typeof ROOT_CAUSE_METHODS)[number];

export const INCIDENT_INVESTIGATION_STATUSES = [
  "not_started",
  "in_progress",
  "under_review",
  "complete",
  "reopened",
] as const;
export type IncidentInvestigationStatus = (typeof INCIDENT_INVESTIGATION_STATUSES)[number];

export const INCIDENT_STATUSES = [
  "reported",
  "under_investigation",
  "actions_open",
  "pending_closure",
  "closed",
  "reopened",
  "void",
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** Reporting regimes an incident may fall under. Several may apply at once
 *  (a UK site with a US parent reports under both), so this is stored as a
 *  list on the incident, not a single value. */
export const REPORTABLE_REGIMES = [
  "riddor",
  "osha",
  "eu_framework",
  "ilo",
  "environment_agency",
  "local_authority",
  "client_specific",
  "insurer",
  "none",
] as const;
export type ReportableRegime = (typeof REPORTABLE_REGIMES)[number];

/** RIDDOR 2013 categories (UK). `over_7_day` starts a 15-day reporting clock
 *  from the day of the accident, which is why it is a stored classification
 *  and not a derived one. */
export const RIDDOR_CATEGORIES = [
  "death",
  "specified_injury",
  "over_7_day_incapacitation",
  "over_3_day_recordable",
  "occupational_disease",
  "dangerous_occurrence",
  "gas_incident",
  "not_reportable",
  "under_assessment",
] as const;
export type RiddorCategory = (typeof RIDDOR_CATEGORIES)[number];

/** OSHA 300 log case classification (US). Mutually exclusive and ordered:
 *  a case is logged at its most severe outcome reached during the case. */
export const OSHA_CASE_TYPES = [
  "death",
  "days_away_from_work",
  "job_transfer_or_restriction",
  "other_recordable",
  "not_recordable",
  "under_assessment",
] as const;
export type OshaCaseType = (typeof OSHA_CASE_TYPES)[number];

/** Every register that can raise a corrective action feeds ONE action table
 *  (`safety_corrective_actions`) — including quality NCRs, so a site has a
 *  single overdue-actions list rather than one per module. */
export const CORRECTIVE_ACTION_SOURCES = [
  "incident",
  "observation",
  "inspection",
  "toolbox_talk",
  "audit",
  "ncr",
  "risk_assessment",
  "meeting_action",
  "regulator_notice",
  "insurer_recommendation",
] as const;
export type CorrectiveActionSource = (typeof CORRECTIVE_ACTION_SOURCES)[number];

/** The hierarchy of control, in descending order of durability. Recording it
 *  is how a programme proves it is engineering hazards out rather than
 *  issuing another briefing: a register full of `administrative` and `ppe`
 *  actions is a register that will see the same incident again. */
export const HIERARCHY_OF_CONTROLS = [
  "elimination",
  "substitution",
  "engineering",
  "isolation",
  "administrative",
  "ppe",
] as const;
export type HierarchyOfControl = (typeof HIERARCHY_OF_CONTROLS)[number];

/** Containment stops the bleeding now; corrective fixes this occurrence;
 *  preventive stops the class of occurrence. Auditors check all three exist. */
export const CORRECTIVE_ACTION_KINDS = ["containment", "corrective", "preventive"] as const;
export type CorrectiveActionKind = (typeof CORRECTIVE_ACTION_KINDS)[number];

export const CORRECTIVE_ACTION_STATUSES = [
  "open",
  "in_progress",
  "completed",
  "verified",
  "closed",
  "cancelled",
] as const;
export type CorrectiveActionStatus = (typeof CORRECTIVE_ACTION_STATUSES)[number];

/** Verified-effective is a separate judgement made LATER than closure. An
 *  action closed on evidence of completion has not yet been shown to work. */
export const ACTION_EFFECTIVENESS_VERDICTS = [
  "pending",
  "effective",
  "partially_effective",
  "not_effective",
] as const;
export type ActionEffectivenessVerdict = (typeof ACTION_EFFECTIVENESS_VERDICTS)[number];

export const SAFETY_INSPECTION_TYPES = [
  "general_site",
  "scaffold",
  "excavation",
  "lifting_equipment",
  "lifting_operation",
  "electrical",
  "fire",
  "ppe",
  "welfare",
  "plant",
  "temporary_works",
  "permit_audit",
  "environmental",
  "statutory",
  "executive_walk",
  "client_walk",
  "third_party",
] as const;
export type SafetyInspectionType = (typeof SAFETY_INSPECTION_TYPES)[number];

export const INSPECTION_FREQUENCIES = [
  "ad_hoc",
  "per_shift",
  "daily",
  "weekly",
  "fortnightly",
  "monthly",
  "quarterly",
  "six_monthly",
  "annual",
] as const;
export type InspectionFrequency = (typeof INSPECTION_FREQUENCIES)[number];

/** How a completed inspection or checklist is turned into a number.
 *  `pass_fail` scores nothing: any critical item failing fails the whole. */
export const INSPECTION_SCORING_METHODS = [
  "percentage",
  "weighted",
  "points",
  "pass_fail",
  "none",
] as const;
export type InspectionScoringMethod = (typeof INSPECTION_SCORING_METHODS)[number];

/** Shared by safety inspections and quality checklists — the same four
 *  verdicts mean the same thing in both, and a site dashboard mixes them. */
export const INSPECTION_RESULTS = [
  "pass",
  "pass_with_observations",
  "fail",
  "not_applicable",
] as const;
export type InspectionResult = (typeof INSPECTION_RESULTS)[number];

export const SAFETY_INSPECTION_STATUSES = [
  "scheduled",
  "in_progress",
  "complete",
  "overdue",
  "reviewed",
  "closed",
  "void",
] as const;
export type SafetyInspectionStatus = (typeof SAFETY_INSPECTION_STATUSES)[number];

export const TEMPLATE_STATUSES = ["draft", "active", "retired"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export const TOOLBOX_TALK_STATUSES = [
  "planned",
  "delivered",
  "verified",
  "cancelled",
] as const;
export type ToolboxTalkStatus = (typeof TOOLBOX_TALK_STATUSES)[number];

/** How a worker's attendance at a briefing was captured. A talk evidenced by
 *  a biometric scan and one evidenced by a supervisor's tick are the same
 *  record with very different weight in an enforcement interview. */
export const ACKNOWLEDGEMENT_METHODS = [
  "wet_signature",
  "on_device_signature",
  "biometric",
  "qr_scan",
  "badge_scan",
  "verbal_confirmed",
  "supervisor_attested",
] as const;
export type AcknowledgementMethod = (typeof ACKNOWLEDGEMENT_METHODS)[number];

/** The documentary spine of a safety programme. Each of these expires or
 *  falls due for review, which is why they share one table with dates rather
 *  than living as files in a folder. */
export const SAFETY_PROGRAMME_RECORD_KINDS = [
  "policy",
  "risk_assessment",
  "method_statement",
  "rams",
  "safe_system_of_work",
  "permit_to_work",
  "emergency_plan",
  "traffic_management_plan",
  "training_matrix",
  "competency_card",
  "orientation_record",
  "drill_record",
  "audit_record",
  "statutory_register",
  "coshh_assessment",
  "temporary_works_design",
] as const;
export type SafetyProgrammeRecordKind = (typeof SAFETY_PROGRAMME_RECORD_KINDS)[number];

export const SAFETY_PROGRAMME_RECORD_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "active",
  "expired",
  "superseded",
  "withdrawn",
] as const;
export type SafetyProgrammeRecordStatus = (typeof SAFETY_PROGRAMME_RECORD_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Quality — ITPs, checklists, NCRs, commissioning (module M22)        */
/*                                                                     */
/* Quality is a chain that ends OUTSIDE this module: an ITP hold point */
/* releases work, a checklist records the test, a failure becomes an   */
/* NCR with a disposition, and commissioning hands the finished system */
/* into the twin asset register (twin.ts) bound to its IFC GUIDs. The  */
/* enums are named for the acts, not the screens.                      */
/* ------------------------------------------------------------------ */

export const ITP_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "approved_as_noted",
  "rejected",
  "active",
  "superseded",
  "closed",
] as const;
export type ItpStatus = (typeof ITP_STATUSES)[number];

/**
 * The point of an ITP. A HOLD POINT stops the work until the named party
 * releases it — proceeding through an unreleased hold point is a contractual
 * breach and a covering-up allegation. A WITNESS POINT invites the party but
 * work may proceed if they do not attend within the notice period, which is
 * exactly why `noticePeriodHours` is stored on the activity: the dispute is
 * always about whether notice was given, not about whether they turned up.
 */
export const INTERVENTION_POINTS = [
  "hold_point",
  "witness_point",
  "surveillance_point",
  "review_point",
  "notification_point",
] as const;
export type InterventionPoint = (typeof INTERVENTION_POINTS)[number];

export const ITP_RESPONSIBLE_PARTIES = [
  "contractor",
  "subcontractor",
  "engineer",
  "client",
  "third_party",
  "manufacturer",
  "regulator",
  "certifying_authority",
] as const;
export type ItpResponsibleParty = (typeof ITP_RESPONSIBLE_PARTIES)[number];

/** `waived` is deliberately distinct from `released`: a hold point that the
 *  client chose not to attend and waived in writing is a different fact from
 *  one they attended and passed, and only one of them survives a challenge. */
export const ITP_ACTIVITY_STATUSES = [
  "pending",
  "notified",
  "released",
  "waived",
  "failed",
  "closed",
  "not_applicable",
] as const;
export type ItpActivityStatus = (typeof ITP_ACTIVITY_STATUSES)[number];

export const CHECKLIST_CATEGORIES = [
  "quality",
  "safety",
  "commissioning",
  "pre_pour",
  "pre_task",
  "environmental",
  "handover",
  "snagging",
  "closeout",
  "delivery_receipt",
  "prequalification",
] as const;
export type ChecklistCategory = (typeof CHECKLIST_CATEGORIES)[number];

/**
 * Typed checklist items. The type is what makes a checklist evidence rather
 * than a form: a `measurement` with a target and a tolerance can be judged
 * pass/fail arithmetically, while a `text` answer can only be read. Reused by
 * safety inspection templates and by prequalification questionnaires so one
 * response renderer serves all three.
 */
export const CHECKLIST_ITEM_TYPES = [
  "pass_fail",
  "pass_fail_na",
  "yes_no",
  "numeric",
  "measurement",
  "instrument_reading",
  "temperature",
  "text",
  "long_text",
  "single_select",
  "multi_select",
  "date",
  "signature",
  "photo",
  "file_upload",
  "section_header",
] as const;
export type ChecklistItemType = (typeof CHECKLIST_ITEM_TYPES)[number];

export const CHECKLIST_STATUSES = [
  "draft",
  "scheduled",
  "in_progress",
  "complete",
  "failed",
  "reviewed",
  "closed",
  "void",
] as const;
export type ChecklistStatus = (typeof CHECKLIST_STATUSES)[number];

export const NCR_CATEGORIES = [
  "workmanship",
  "material",
  "design",
  "documentation",
  "process",
  "testing",
  "dimensional",
  "calibration",
  "environmental",
  "supplier",
  "other",
] as const;
export type NcrCategory = (typeof NCR_CATEGORIES)[number];

/** `critical` means the non-conformance affects structural integrity, life
 *  safety or a statutory approval — the band that cannot be closed by the
 *  party that caused it. */
export const NCR_SEVERITIES = ["minor", "major", "critical"] as const;
export type NcrSeverity = (typeof NCR_SEVERITIES)[number];

export const NCR_SOURCES = [
  "checklist",
  "itp_activity",
  "inspection",
  "test_record",
  "audit",
  "observation",
  "submittal_review",
  "delivery",
  "client",
  "third_party",
  "self_identified",
] as const;
export type NcrSource = (typeof NCR_SOURCES)[number];

/**
 * The four dispositions every quality system in construction recognises,
 * plus the two the supply chain adds. The distinction that matters:
 * `use_as_is` and `repair` both leave non-conforming work in the building, so
 * both require the designer's acceptance (a concession) and both must be
 * approved by someone other than the party who raised or caused the NCR.
 */
export const NCR_DISPOSITIONS = [
  "pending",
  "rework",
  "repair",
  "use_as_is",
  "reject",
  "return_to_supplier",
  "regrade",
] as const;
export type NcrDisposition = (typeof NCR_DISPOSITIONS)[number];

export const NCR_STATUSES = [
  "open",
  "under_review",
  "disposition_proposed",
  "disposition_approved",
  "action_in_progress",
  "verification_pending",
  "closed",
  "rejected",
  "void",
] as const;
export type NcrStatus = (typeof NCR_STATUSES)[number];

/** Systems decompose; the level says how far down a row sits so a turnover
 *  package can be assembled at the right granularity. */
export const COMMISSIONING_LEVELS = ["system", "subsystem", "equipment"] as const;
export type CommissioningLevel = (typeof COMMISSIONING_LEVELS)[number];

/** The commissioning ladder in order. Nothing may be functionally tested
 *  before its pre-functional checks are complete, and nothing is turned over
 *  before it is accepted — the state IS the gate. */
export const COMMISSIONING_STATUSES = [
  "not_started",
  "construction_complete",
  "prefunctional_in_progress",
  "prefunctional_complete",
  "energised",
  "functional_in_progress",
  "functional_complete",
  "seasonal_pending",
  "accepted",
  "turned_over",
  "on_hold",
] as const;
export type CommissioningStatus = (typeof COMMISSIONING_STATUSES)[number];

export const COMMISSIONING_TEST_KINDS = [
  "prefunctional_checklist",
  "static_completion",
  "energisation",
  "functional_performance",
  "integrated_systems",
  "seasonal",
  "retest",
  "loop_check",
  "pressure_test",
  "leak_test",
  "air_balance",
  "water_balance",
  "insulation_resistance",
  "earth_continuity",
  "flushing_and_chlorination",
  "fire_alarm_verification",
  "energy_verification",
  "acoustic",
] as const;
export type CommissioningTestKind = (typeof COMMISSIONING_TEST_KINDS)[number];

/** `pass_with_deficiencies` is the honest state most functional tests end in:
 *  the system works, a snag list exists, and turnover is conditional on it. */
export const TEST_RESULTS = [
  "pass",
  "pass_with_deficiencies",
  "fail",
  "aborted",
  "not_applicable",
] as const;
export type TestResult = (typeof TEST_RESULTS)[number];

export const COMMISSIONING_TEST_STATUSES = [
  "scheduled",
  "in_progress",
  "complete",
  "failed",
  "retest_required",
  "accepted",
  "void",
] as const;
export type CommissioningTestStatus = (typeof COMMISSIONING_TEST_STATUSES)[number];

export const TURNOVER_PACKAGE_TYPES = [
  "system",
  "area",
  "building",
  "phase",
  "whole_project",
] as const;
export type TurnoverPackageType = (typeof TURNOVER_PACKAGE_TYPES)[number];

/** What a turnover package must contain before an owner will accept it. Held
 *  as a checklist of artefact kinds so "the O&Ms are missing" is a query, not
 *  a conversation. */
export const TURNOVER_ARTEFACT_KINDS = [
  "as_built_drawings",
  "o_and_m_manual",
  "test_records",
  "commissioning_certificates",
  "statutory_certificates",
  "warranties",
  "spare_parts_list",
  "training_records",
  "asset_register",
  "cobie_export",
  "software_licences",
  "keys_and_access",
  "punch_list_closeout",
  "operating_permits",
] as const;
export type TurnoverArtefactKind = (typeof TURNOVER_ARTEFACT_KINDS)[number];

export const TURNOVER_STATUSES = [
  "draft",
  "assembling",
  "submitted",
  "under_review",
  "comments_issued",
  "resubmitted",
  "accepted",
  "rejected",
  "handed_over",
] as const;
export type TurnoverStatus = (typeof TURNOVER_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Equipment, plant & materials (module M23)                           */
/*                                                                     */
/* Plant costs money whether or not it is working, so the register is  */
/* built around UTILISATION and IDLE TIME rather than around a list of */
/* machines: an excavator standing for three weeks on full hire is a   */
/* commercial fact, and idle reasons are enumerated so the fact has a  */
/* cause attached to it. Certificates expire; expiry is an obligation. */
/* ------------------------------------------------------------------ */

export const EQUIPMENT_CATEGORIES = [
  "earthmoving",
  "lifting",
  "access",
  "concrete",
  "compaction",
  "drilling_piling",
  "generator",
  "compressor",
  "pump",
  "welding",
  "vehicle",
  "haulage",
  "small_tool",
  "formwork",
  "temporary_works",
  "scaffold",
  "survey",
  "testing_instrument",
  "site_accommodation",
  "safety_equipment",
  "other",
] as const;
export type EquipmentCategory = (typeof EQUIPMENT_CATEGORIES)[number];

/** How the plant is held. Drives who carries the cost, who insures it and
 *  who is liable for its certification: on `subcontractor` plant we neither
 *  pay hire nor hold the LOLER certificate, but we still must verify it. */
export const EQUIPMENT_OWNERSHIPS = [
  "owned",
  "hired",
  "leased",
  "operator_hired",
  "subcontractor",
  "client_supplied",
] as const;
export type EquipmentOwnership = (typeof EQUIPMENT_OWNERSHIPS)[number];

export const EQUIPMENT_STATUSES = [
  "available",
  "in_use",
  "idle",
  "in_transit",
  "under_maintenance",
  "breakdown",
  "quarantined",
  "off_hire_requested",
  "off_hired",
  "disposed",
  "lost_or_stolen",
] as const;
export type EquipmentStatus = (typeof EQUIPMENT_STATUSES)[number];

export const EQUIPMENT_CONDITIONS = [
  "new",
  "good",
  "fair",
  "poor",
  "unserviceable",
] as const;
export type EquipmentCondition = (typeof EQUIPMENT_CONDITIONS)[number];

export const HIRE_RATE_UNITS = [
  "hour",
  "shift",
  "day",
  "week",
  "month",
  "cycle",
  "lump_sum",
] as const;
export type HireRateUnit = (typeof HIRE_RATE_UNITS)[number];

/** What the machine's meter counts — the basis every maintenance interval,
 *  utilisation figure and telematics reading is expressed against. */
export const METER_TYPES = ["hours", "kilometres", "miles", "cycles", "none"] as const;
export type MeterType = (typeof METER_TYPES)[number];

export const FUEL_TYPES = [
  "diesel",
  "hvo",
  "petrol",
  "electric",
  "hybrid",
  "hydrogen",
  "lpg",
  "none",
] as const;
export type FuelType = (typeof FUEL_TYPES)[number];

export const EQUIPMENT_ASSIGNMENT_STATUSES = [
  "requested",
  "approved",
  "mobilising",
  "on_site",
  "demobilising",
  "returned",
  "cancelled",
] as const;
export type EquipmentAssignmentStatus = (typeof EQUIPMENT_ASSIGNMENT_STATUSES)[number];

/** Why the machine stood. This is the enum that turns idle hours from a cost
 *  into a management action — "awaiting materials" and "weather" produce
 *  entirely different conversations, and one of them is recoverable. */
export const IDLE_REASONS = [
  "no_work_available",
  "awaiting_materials",
  "awaiting_operator",
  "awaiting_permit",
  "awaiting_instruction",
  "access_blocked",
  "weather",
  "breakdown",
  "planned_maintenance",
  "shift_end",
  "standby_contractual",
  "other",
] as const;
export type IdleReason = (typeof IDLE_REASONS)[number];

/** Where a plant or stock figure came from. A telematics-sourced hour count
 *  is independent evidence of a hire claim; a manually typed one is not
 *  (ADR 0014), and reconciliation depends on knowing which is which. */
export const EQUIPMENT_DATA_SOURCES = [
  "manual",
  "telematics",
  "timecard",
  "daily_log",
  "ingestion",
  "barcode_scan",
  "supplier_feed",
] as const;
export type EquipmentDataSource = (typeof EQUIPMENT_DATA_SOURCES)[number];

export const MAINTENANCE_TYPES = [
  "preventive",
  "corrective",
  "predictive",
  "statutory",
  "calibration",
  "servicing",
  "overhaul",
  "warranty_repair",
] as const;
export type MaintenanceType = (typeof MAINTENANCE_TYPES)[number];

/** What makes the next service fall due. Calendar and meter intervals race
 *  each other — whichever arrives first is the due date. */
export const MAINTENANCE_INTERVAL_KINDS = [
  "calendar_days",
  "calendar_months",
  "operating_hours",
  "distance",
  "cycles",
  "condition_based",
] as const;
export type MaintenanceIntervalKind = (typeof MAINTENANCE_INTERVAL_KINDS)[number];

export const MAINTENANCE_SCHEDULE_STATUSES = [
  "active",
  "due",
  "overdue",
  "suspended",
  "retired",
] as const;
export type MaintenanceScheduleStatus = (typeof MAINTENANCE_SCHEDULE_STATUSES)[number];

/** `condemned` takes the machine off the site permanently and is the only
 *  outcome that must be reported to the hirer's insurer. */
export const MAINTENANCE_RESULTS = [
  "completed",
  "partial",
  "deferred",
  "failed",
  "condemned",
] as const;
export type MaintenanceResult = (typeof MAINTENANCE_RESULTS)[number];

export const MAINTENANCE_RECORD_STATUSES = [
  "draft",
  "in_progress",
  "completed",
  "verified",
  "void",
] as const;
export type MaintenanceRecordStatus = (typeof MAINTENANCE_RECORD_STATUSES)[number];

/** Statutory and contractual certificates plant carries. Naming them is what
 *  lets the platform answer "which machines on site are out of certificate
 *  today" — the question an inspector asks first. */
export const EQUIPMENT_CERTIFICATE_TYPES = [
  "thorough_examination",
  "statutory_inspection",
  "puwer_inspection",
  "crane_test_certificate",
  "pressure_vessel",
  "electrical_pat",
  "calibration",
  "emissions",
  "road_worthiness",
  "insurance",
  "conformity_declaration",
  "operator_licence",
  "lifting_plan_approval",
  "other",
] as const;
export type EquipmentCertificateType = (typeof EQUIPMENT_CERTIFICATE_TYPES)[number];

export const CERTIFICATE_RESULTS = [
  "pass",
  "pass_with_conditions",
  "fail",
  "not_applicable",
] as const;
export type CertificateResult = (typeof CERTIFICATE_RESULTS)[number];

/** NAMED `EQUIPMENT_` because `CERTIFICATE_STATUSES` above already belongs to
 *  payment certificates (Domain commercial) and renaming a shipped enum is a
 *  data migration, not a refactor. */
export const EQUIPMENT_CERTIFICATE_STATUSES = [
  "pending",
  "valid",
  "expiring",
  "expired",
  "revoked",
  "superseded",
] as const;
export type EquipmentCertificateStatus = (typeof EQUIPMENT_CERTIFICATE_STATUSES)[number];

export const EQUIPMENT_READING_TYPES = [
  "hours",
  "odometer",
  "cycles",
  "fuel_fill",
  "fuel_level",
  "def_fill",
  "idle_hours",
  "engine_load",
  "coolant_temperature",
  "hydraulic_pressure",
  "battery_voltage",
  "payload",
] as const;
export type EquipmentReadingType = (typeof EQUIPMENT_READING_TYPES)[number];

/** Telematics feeds the platform accepts through the ingestion module.
 *  `generic_aemp` is the ISO 15143-3 (AEMP 2.0) standard every major OEM
 *  publishes, which is why it is the fallback rather than a bespoke map. */
export const TELEMATICS_PROVIDERS = [
  "generic_aemp",
  "cat_visionlink",
  "komatsu_komtrax",
  "jcb_livelink",
  "volvo_caretrack",
  "trackunit",
  "hitachi_global_eservice",
  "custom",
] as const;
export type TelematicsProvider = (typeof TELEMATICS_PROVIDERS)[number];

export const MATERIAL_ITEM_STATUSES = [
  "planned",
  "ordered",
  "partially_delivered",
  "delivered",
  "in_stock",
  "installed",
  "depleted",
  "cancelled",
] as const;
export type MaterialItemStatus = (typeof MATERIAL_ITEM_STATUSES)[number];

export const DELIVERY_STATUSES = [
  "scheduled",
  "in_transit",
  "arrived",
  "receiving",
  "received",
  "partially_received",
  "rejected",
  "returned",
  "cancelled",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** What went wrong with a delivery. Recorded per line, because a delivery is
 *  short on one item and damaged on another, and the supplier's invoice will
 *  claim all of it. This enum is the difference between a credit note and an
 *  argument. */
export const DELIVERY_DISCREPANCY_KINDS = [
  "none",
  "short_delivery",
  "over_delivery",
  "damaged",
  "wrong_item",
  "wrong_specification",
  "missing_documentation",
  "expired",
  "contaminated",
  "late",
  "failed_inspection",
] as const;
export type DeliveryDiscrepancyKind = (typeof DELIVERY_DISCREPANCY_KINDS)[number];

/** Stock movements are signed by kind: receipts and returns add, issues and
 *  wastage subtract. Splitting `wastage`, `damage` and `theft` out of a
 *  generic adjustment is what makes material loss measurable at all. */
export const STOCK_MOVEMENT_TYPES = [
  "receipt",
  "issue",
  "return",
  "transfer_in",
  "transfer_out",
  "adjustment",
  "wastage",
  "damage",
  "theft",
  "consumption",
  "reservation",
  "reservation_release",
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

/* ------------------------------------------------------------------ */
/* Timecards, crews & T&M tickets (module M24)                         */
/*                                                                     */
/* Labour is the only cost that is claimed and paid before anyone      */
/* checks it, so the module is built around two reconciliations: the   */
/* claimed hours against the site-access record (workforce.ts, the     */
/* ghost-worker check) and the allocated hours against the budget line */
/* (financials.ts). A T&M ticket is the third: hours the CLIENT signed */
/* for, on site, on the day.                                           */
/* ------------------------------------------------------------------ */

export const SHIFTS = ["day", "night", "swing", "weekend", "split"] as const;
export type Shift = (typeof SHIFTS)[number];

export const CREW_ROLES = [
  "foreman",
  "leading_hand",
  "operative",
  "apprentice",
  "operator",
  "banksman",
  "supervisor",
  "specialist",
  "labourer",
] as const;
export type CrewRole = (typeof CREW_ROLES)[number];

export const CREW_STATUSES = ["forming", "active", "inactive", "disbanded"] as const;
export type CrewStatus = (typeof CREW_STATUSES)[number];

/** Premium pay above the overtime multiplier, e.g. night working or a
 *  confined-space allowance. Named because the premium is usually the part a
 *  client disputes on a T&M ticket. */
export const PREMIUM_KINDS = [
  "none",
  "night_shift",
  "weekend",
  "public_holiday",
  "hazard",
  "confined_space",
  "working_at_height",
  "travel",
  "standby",
  "call_out",
  "shift_allowance",
  "other",
] as const;
export type PremiumKind = (typeof PREMIUM_KINDS)[number];

/** How the hours reached the platform. A biometric or turnstile source is an
 *  independent evidence stream; a manually keyed crew sheet is the claimant's
 *  own assertion (ADR 0004), and the reconciliation is only meaningful when
 *  the two differ in origin. */
export const TIMECARD_SOURCES = [
  "manual",
  "crew_sheet",
  "mobile",
  "kiosk",
  "biometric",
  "turnstile",
  "ingestion",
  "api",
] as const;
export type TimecardSource = (typeof TIMECARD_SOURCES)[number];

/** `locked` freezes a card once payroll has drawn from it; `exported` records
 *  that it left for an external payroll system, after which a correction is a
 *  new card and never an edit. */
export const TIMECARD_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "revised",
  "locked",
  "exported",
  "void",
] as const;
export type TimecardStatus = (typeof TIMECARD_STATUSES)[number];

export const TIMECARD_BATCH_STATUSES = [
  "draft",
  "submitted",
  "partially_approved",
  "approved",
  "rejected",
  "locked",
  "exported",
] as const;
export type TimecardBatchStatus = (typeof TIMECARD_BATCH_STATUSES)[number];

/** A single act in the approval trail. `returned_for_revision` is not a
 *  rejection: the hours stand, the coding does not. */
export const TIMECARD_APPROVAL_DECISIONS = [
  "approved",
  "rejected",
  "returned_for_revision",
  "escalated",
  "delegated",
] as const;
export type TimecardApprovalDecision = (typeof TIMECARD_APPROVAL_DECISIONS)[number];

/** The basis a T&M ticket is priced on, agreed BEFORE the work where
 *  possible. `star_rate` is a rate invented for work with no comparable in
 *  the contract, and is the one that ends up in adjudication. */
export const TM_RATE_BASES = [
  "contract_daywork_rates",
  "schedule_of_rates",
  "actual_cost_plus",
  "agreed_lump_sum",
  "star_rate",
  "to_be_agreed",
] as const;
export type TmRateBasis = (typeof TM_RATE_BASES)[number];

export const TM_LINE_KINDS = [
  "labour",
  "equipment",
  "material",
  "subcontract",
  "markup",
  "other",
] as const;
export type TmLineKind = (typeof TM_LINE_KINDS)[number];

/** `signed` means the client's representative signed on site; `incorporated`
 *  means the ticket has been rolled into a change order and is no longer a
 *  loose claim. Between those two states is where unrecovered cost lives. */
export const TM_TICKET_STATUSES = [
  "draft",
  "submitted",
  "signed",
  "signed_under_protest",
  "disputed",
  "rejected",
  "approved",
  "incorporated",
  "void",
] as const;
export type TmTicketStatus = (typeof TM_TICKET_STATUSES)[number];

/** How a site signature was captured. Recorded because a scanned wet-ink
 *  signature, an on-device capture with GPS, and a typed name are three very
 *  different exhibits. */
export const SIGNATURE_METHODS = [
  "wet_ink_scanned",
  "on_device",
  "typed",
  "biometric",
  "email_confirmation",
  "none",
] as const;
export type SignatureMethod = (typeof SIGNATURE_METHODS)[number];

/* ------------------------------------------------------------------ */
/* Bidding, tendering & prequalification (module M25)                  */
/*                                                                     */
/* Two bids are never comparable as submitted: one excludes the        */
/* scaffold, the other prices a provisional sum, a third corrects the  */
/* quantity. LEVELLING is the module's real product — a neutral scope  */
/* row per package, every bidder's price mapped onto it, and each      */
/* adjustment carrying a stated reason. Award records why the lowest   */
/* bid was NOT taken, which is the question an auditor always asks.    */
/* ------------------------------------------------------------------ */

export const BID_PACKAGE_KINDS = [
  "subcontract",
  "supply_only",
  "supply_and_install",
  "design_and_build",
  "professional_services",
  "plant_hire",
  "labour_only",
  "framework_call_off",
] as const;
export type BidPackageKind = (typeof BID_PACKAGE_KINDS)[number];

export const PROCUREMENT_ROUTES = [
  "open_tender",
  "selective_tender",
  "negotiated",
  "framework",
  "single_source",
  "two_stage",
  "competitive_dialogue",
] as const;
export type ProcurementRoute = (typeof PROCUREMENT_ROUTES)[number];

export const BID_PACKAGE_STATUSES = [
  "draft",
  "prequalification",
  "invitations_sent",
  "open",
  "closed",
  "under_evaluation",
  "levelled",
  "awarded",
  "partially_awarded",
  "on_hold",
  "cancelled",
] as const;
export type BidPackageStatus = (typeof BID_PACKAGE_STATUSES)[number];

/** How the winner is chosen, declared before bids open. Stored because
 *  changing the basis after the prices are visible is the classic
 *  procurement-integrity failure. */
export const BID_EVALUATION_METHODS = [
  "lowest_price",
  "most_economically_advantageous",
  "quality_price_ratio",
  "best_value",
  "quality_only",
] as const;
export type BidEvaluationMethod = (typeof BID_EVALUATION_METHODS)[number];

/** Invitation lifecycle, including the engagement states a tender manager
 *  chases on: viewed but not downloaded, downloaded but silent. */
export const BID_INVITATION_STATUSES = [
  "draft",
  "sent",
  "delivered",
  "bounced",
  "viewed",
  "downloaded",
  "intent_to_bid",
  "declined",
  "no_response",
  "submitted",
  "withdrawn",
  "disqualified",
] as const;
export type BidInvitationStatus = (typeof BID_INVITATION_STATUSES)[number];

/** Why a bidder walked away. Kept as an enum because the pattern across a
 *  package — everyone citing `insufficient_time` — is a procurement failure
 *  on our side, not theirs. */
export const BID_DECLINE_REASONS = [
  "capacity",
  "scope_mismatch",
  "programme",
  "commercial_terms",
  "risk_allocation",
  "insufficient_time",
  "geography",
  "prequalification_lapsed",
  "no_reason_given",
  "other",
] as const;
export type BidDeclineReason = (typeof BID_DECLINE_REASONS)[number];

export const BID_SUBMISSION_STATUSES = [
  "draft",
  "submitted",
  "received",
  "opened",
  "under_review",
  "clarification_requested",
  "clarified",
  "shortlisted",
  "unsuccessful",
  "awarded",
  "withdrawn",
] as const;
export type BidSubmissionStatus = (typeof BID_SUBMISSION_STATUSES)[number];

/** Whether the bid answers the question that was asked. `qualified` is the
 *  dangerous one: a compliant-looking price with conditions attached that
 *  move risk back to us. */
export const BID_COMPLIANCE_STATUSES = [
  "pending_review",
  "compliant",
  "qualified",
  "conditional",
  "non_compliant",
] as const;
export type BidComplianceStatus = (typeof BID_COMPLIANCE_STATUSES)[number];

/** What a levelling row represents. `exclusion_check` rows carry no price:
 *  they exist purely to force every bidder to answer "is this in or out". */
export const LEVELLING_ITEM_CATEGORIES = [
  "base_scope",
  "alternate",
  "provisional_sum",
  "allowance",
  "rate_only",
  "exclusion_check",
  "commercial_term",
  "qualification",
] as const;
export type LevellingItemCategory = (typeof LEVELLING_ITEM_CATEGORIES)[number];

export const LEVELLING_INCLUSIONS = [
  "included",
  "excluded",
  "partially_included",
  "unclear",
  "not_priced",
] as const;
export type LevellingInclusion = (typeof LEVELLING_INCLUSIONS)[number];

/** Every levelling adjustment must say WHY the comparable number differs from
 *  the number the bidder wrote. Without the reason, levelling is an opinion
 *  and the losing bidder's challenge succeeds. */
export const LEVELLING_ADJUSTMENT_REASONS = [
  "scope_gap",
  "scope_overlap",
  "quantity_correction",
  "arithmetic_error",
  "exclusion_priced_elsewhere",
  "alternate_substitution",
  "commercial_term",
  "programme_impact",
  "tax_treatment",
  "currency",
  "risk_allowance",
  "prelims_normalisation",
  "other",
] as const;
export type LevellingAdjustmentReason = (typeof LEVELLING_ADJUSTMENT_REASONS)[number];

export const BID_AWARD_STATUSES = [
  "recommended",
  "pending_approval",
  "approved",
  "rejected",
  "letter_of_intent",
  "contract_issued",
  "executed",
  "withdrawn",
  "cancelled",
] as const;
export type BidAwardStatus = (typeof BID_AWARD_STATUSES)[number];

export const PREQUAL_QUESTIONNAIRE_STATUSES = ["draft", "active", "retired"] as const;
export type PrequalQuestionnaireStatus = (typeof PREQUAL_QUESTIONNAIRE_STATUSES)[number];

export const PREQUAL_CATEGORIES = [
  "financial",
  "health_safety",
  "quality",
  "environmental",
  "technical_capability",
  "insurance",
  "references",
  "legal_and_compliance",
  "modern_slavery",
  "cyber_security",
  "equality_and_diversity",
  "capacity",
  "social_value",
] as const;
export type PrequalCategory = (typeof PREQUAL_CATEGORIES)[number];

export const PREQUAL_SUBMISSION_STATUSES = [
  "invited",
  "in_progress",
  "submitted",
  "under_review",
  "clarification_requested",
  "assessed",
  "expired",
  "withdrawn",
  "suspended",
] as const;
export type PrequalSubmissionStatus = (typeof PREQUAL_SUBMISSION_STATUSES)[number];

/** The assessment outcome, separate from the workflow status. A supply chain
 *  is rarely a binary: most approvals carry a single-project financial limit,
 *  which is the number the screening figures exist to set. */
export const PREQUAL_OUTCOMES = [
  "pending",
  "approved",
  "approved_with_conditions",
  "approved_with_limit",
  "rejected",
] as const;
export type PrequalOutcome = (typeof PREQUAL_OUTCOMES)[number];

/** Provenance of a bidder's financial figures. Audited accounts and a
 *  self-declared turnover are not the same evidence, and a screening decision
 *  that does not record which it relied on cannot be defended. */
export const FINANCIAL_DATA_SOURCES = [
  "audited_accounts",
  "filed_accounts",
  "management_accounts",
  "credit_agency",
  "self_declared",
  "bank_reference",
] as const;
export type FinancialDataSource = (typeof FINANCIAL_DATA_SOURCES)[number];

/* ------------------------------------------------------------------ */
/* Authentication, SSO, MFA and account security (Phase 8)             */
/*                                                                     */
/* These back packages/db/src/schema/auth.ts. Read that file's header  */
/* for the two decisions that shape them: a secret an identity         */
/* provider must REPLAY (an OIDC client secret, a TOTP seed) cannot be */
/* hashed, so it is envelope-encrypted with a key held outside the     */
/* database; a secret the platform only ever CHECKS (a reset token, a  */
/* recovery code) is stored as a hash and never in usable form.        */
/* ------------------------------------------------------------------ */

/**
 * The shape of a company's SSO connection. `google` and `microsoft` are OIDC
 * with a fixed, known issuer — the operator supplies only a client id and
 * secret; `oidc` is any other compliant provider (Okta, Auth0, Keycloak,
 * PingFederate) where the issuer or discovery URL is supplied too; `saml` is
 * the assertion-based protocol still mandated by many public-sector and
 * enterprise IT departments, and shares no code path with the OIDC three.
 *
 * NOT to be confused with OAUTH_GRANT_TYPES above: that is a MACHINE caller
 * authenticating as itself with a client-credentials grant. This is a PERSON
 * authenticating at their own employer's identity provider and arriving here
 * with an assertion about who they are.
 */
export const IDENTITY_PROVIDER_KINDS = ["google", "microsoft", "oidc", "saml"] as const;
export type IdentityProviderKind = (typeof IDENTITY_PROVIDER_KINDS)[number];

/**
 * How an identity provider's client secret is held. The platform must be able
 * to present that secret to the IdP's token endpoint, so — unlike every other
 * credential on this platform — it cannot be a one-way hash.
 *
 * `encrypted`  AES-256-GCM ciphertext in `client_secret_ciphertext`, the key
 *              derived from SSO_ENCRYPTION_KEY (or AUTH_SECRET as a documented
 *              fallback). A database dump alone does not yield the secret.
 * `reference`  Nothing secret is stored at all: `client_secret_ref` names an
 *              external holder (`env:OKTA_CLIENT_SECRET`, `aws-sm:<arn>`,
 *              `vault:<path>`) resolved at request time. The strongest option
 *              and the one large deployments should take.
 * `none`       A public client using PKCE, which has no secret to hold. Only
 *              legitimate where the IdP supports it; recorded explicitly so
 *              "no secret" is never confused with "secret not yet configured".
 */
export const SSO_SECRET_STORAGE_MODES = ["encrypted", "reference", "none"] as const;
export type SsoSecretStorageMode = (typeof SSO_SECRET_STORAGE_MODES)[number];

/** SAML binding used to reach the IdP's SSO endpoint. */
export const SAML_BINDINGS = ["http_post", "http_redirect"] as const;
export type SamlBinding = (typeof SAML_BINDINGS)[number];

/**
 * How the credential presented at the start of a session was verified. Stored
 * on the session so a device list can say "signed in with Microsoft" rather
 * than implying everyone typed a password, and so revoking password login for
 * a company can be checked against sessions already in flight.
 */
export const AUTH_METHODS = ["password", "sso", "invitation", "recovery_code"] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/**
 * Why a session stopped being usable. An auditor's first question after an
 * incident is "who ended that session and on what basis" — a bare revoked_at
 * cannot answer it. `token_reuse_detected` is the serious one: a refresh token
 * presented twice means a copy exists somewhere it should not, and the whole
 * session family is destroyed rather than rotated.
 */
export const SESSION_REVOKE_REASONS = [
  "user_signed_out",
  "user_signed_out_everywhere",
  "admin_revoked",
  "password_changed",
  "mfa_reset",
  "token_reuse_detected",
  "membership_removed",
  "account_deactivated",
  "sso_policy_changed",
  "expired",
] as const;
export type SessionRevokeReason = (typeof SESSION_REVOKE_REASONS)[number];

/**
 * Second factors the platform can actually verify today. WebAuthn/passkeys and
 * SMS are deliberately ABSENT: a value here is a promise that enrolment and
 * challenge both work, and offering a factor the platform cannot check is the
 * security equivalent of fabricating a figure. Add the value with the code.
 */
export const MFA_METHODS = ["totp", "recovery_code"] as const;
export type MfaMethod = (typeof MFA_METHODS)[number];

/**
 * Enrolment lifecycle. `pending` matters: a TOTP secret exists and has been
 * shown as a QR code, but no code has been verified against it yet — that
 * enrolment must NOT be treated as a second factor, or a user who scanned
 * nothing gets locked out of their own account.
 */
export const MFA_STATUSES = ["pending", "active", "disabled"] as const;
export type MfaStatus = (typeof MFA_STATUSES)[number];

/** Why a single-use token was issued, so consuming one cannot serve another purpose. */
export const EMAIL_VERIFICATION_PURPOSES = ["signup", "email_change", "reverify"] as const;
export type EmailVerificationPurpose = (typeof EMAIL_VERIFICATION_PURPOSES)[number];

/** Invitation lifecycle. `expired` is derived on read (a lazy, idempotent
 *  sweep on list — never a cron) and then written back, so the register and
 *  the reader never disagree. */
export const INVITATION_STATUSES = ["pending", "accepted", "revoked", "expired"] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/**
 * The messages the platform sends. Every one is a security-relevant event in
 * its own right, which is why they are enumerated rather than free text: an
 * auditor asks "was this user told their MFA changed", and the answer has to
 * be a row, not a grep of application logs.
 */
export const EMAIL_TEMPLATE_KEYS = [
  "verify_email",
  "password_reset",
  "invitation",
  "mfa_enrolled",
  "new_device_sign_in",
] as const;
export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

/**
 * What became of a message. `recorded` is the honest state this platform needs
 * most: no transport is configured, so the message was composed and written
 * down and NOT delivered. Reporting that as `sent` would make an invitation
 * that nobody receives look successful — which is exactly the failure this
 * whole subsystem exists to end.
 */
export const EMAIL_DISPATCH_STATUSES = ["recorded", "sent", "failed", "suppressed"] as const;
export type EmailDispatchStatus = (typeof EMAIL_DISPATCH_STATUSES)[number];

/**
 * Which transport handled (or declined) a message. `noop` records and does not
 * send; `http` is a provider REST API (Resend/Postmark shape) reached with
 * fetch and no npm dependency; `smtp` is the documented adapter slot — it is
 * accepted as configuration and reports itself unavailable rather than
 * pretending, because implementing SMTP requires a dependency this repo has
 * not taken.
 */
export const EMAIL_TRANSPORT_KINDS = ["noop", "http", "smtp"] as const;
export type EmailTransportKind = (typeof EMAIL_TRANSPORT_KINDS)[number];

/** The HTTP email providers with an adapter in apps/api/src/lib/email.ts. */
export const EMAIL_PROVIDERS = ["none", "resend", "postmark", "smtp"] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

/**
 * The account-security trail (`auth_security_events`). This is deliberately
 * separate from the assurance ledger: the ledger records what was done to
 * PROJECT records and is anchored for dispute use; this records what happened
 * to ACCOUNTS and is what an ISO 27001 or SOC 2 auditor asks to see. A failed
 * login against an address that does not exist has no company and no user, so
 * it could never be a ledger entry, yet it is precisely the row an intrusion
 * investigation needs.
 */
export const AUTH_EVENT_KINDS = [
  "register",
  "login_success",
  "login_failure",
  "login_blocked_locked",
  "login_blocked_password_disabled",
  "login_blocked_inactive",
  "logout",
  "refresh_success",
  "refresh_reuse_detected",
  "session_revoked",
  "sessions_revoked_all",
  "account_locked",
  "account_unlocked",
  "password_changed",
  "password_reset_requested",
  "password_reset_completed",
  "email_verification_sent",
  "email_verified",
  "email_change_requested",
  "mfa_enrol_started",
  "mfa_enrolled",
  "mfa_challenge_success",
  "mfa_challenge_failure",
  "mfa_disabled",
  "mfa_recovery_code_used",
  "mfa_recovery_codes_regenerated",
  "sso_login_success",
  "sso_login_failure",
  "sso_identity_linked",
  "sso_identity_unlinked",
  "sso_user_provisioned",
  "identity_provider_created",
  "identity_provider_updated",
  "identity_provider_disabled",
  "invitation_sent",
  "invitation_accepted",
  "invitation_revoked",
  "new_device_sign_in",
  "email_dispatch_recorded",
  "email_dispatch_failed",
] as const;
export type AuthEventKind = (typeof AUTH_EVENT_KINDS)[number];

/**
 * The outcome of a security event, kept separate from its kind so a query can
 * ask "every failure in the last hour" across every kind. `blocked` is not
 * `failure`: the credential may have been correct and the attempt refused by
 * policy (lockout, password login disabled for the tenant), and conflating the
 * two turns a policy report into a false brute-force alarm.
 */
export const AUTH_EVENT_OUTCOMES = ["success", "failure", "blocked", "pending"] as const;
export type AuthEventOutcome = (typeof AUTH_EVENT_OUTCOMES)[number];
