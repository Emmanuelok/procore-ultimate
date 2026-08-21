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
