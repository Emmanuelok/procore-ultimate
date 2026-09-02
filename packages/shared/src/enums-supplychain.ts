/**
 * Shared enums for the supply chain, logistics & offsite manufacture area
 * (spec Vol II Domain U #913–947, Vol I §5.4 #719–730).
 *
 * Add new `as const` string unions and their types here; never edit
 * enums.ts from a parallel work package.
 */

/* ------------------------------------------------------------------ */
/* Supply chain map (#913–916)                                         */
/* ------------------------------------------------------------------ */

/** What a node on the supply chain map IS. A vendor is the directory record;
 *  a manufacturer two tiers down is usually only known by name. */
export const SUPPLY_NODE_KINDS = [
  "vendor",
  "manufacturer",
  "distributor",
  "fabricator",
  "logistics_provider",
  "consolidation_centre",
  "port",
  "site",
  "other",
] as const;
export type SupplyNodeKind = (typeof SUPPLY_NODE_KINDS)[number];

/** How much the programme depends on the node. `critical` = a single-source
 *  component on the critical path; its failure stops the job. */
export const SUPPLY_CRITICALITIES = ["critical", "high", "medium", "low"] as const;
export type SupplyCriticality = (typeof SUPPLY_CRITICALITIES)[number];

export const SUPPLY_NODE_STATUSES = ["active", "inactive", "suspended"] as const;
export type SupplyNodeStatus = (typeof SUPPLY_NODE_STATUSES)[number];

/** The edge on the map: FROM the upstream party TO the downstream one. */
export const SUPPLY_LINK_KINDS = [
  "supplies",
  "subcontracts",
  "manufactures_for",
  "ships_for",
  "stores_for",
  "consolidates_for",
] as const;
export type SupplyLinkKind = (typeof SUPPLY_LINK_KINDS)[number];

/* ------------------------------------------------------------------ */
/* Long-lead procurement (#918–921, #727–728)                          */
/* ------------------------------------------------------------------ */

export const LONG_LEAD_STATUSES = [
  "identified",
  "requisitioned",
  "ordered",
  "in_production",
  "shipped",
  "in_customs",
  "arrived",
  "installed",
  "cancelled",
] as const;
export type LongLeadStatus = (typeof LONG_LEAD_STATUSES)[number];

/** Milestones that advance a long-lead item. Each stamps its actual date. */
export const LONG_LEAD_MILESTONES = [
  "requisitioned",
  "ordered",
  "production_started",
  "shipped",
  "customs_cleared",
  "arrived",
  "installed",
] as const;
export type LongLeadMilestone = (typeof LONG_LEAD_MILESTONES)[number];

/** Risk of late arrival against the required-on-site date, computed by the
 *  long-lead engine from float, milestone slippage and expediting history. */
export const LONG_LEAD_RISK_LEVELS = ["on_track", "watch", "at_risk", "late", "not_assessable"] as const;
export type LongLeadRiskLevel = (typeof LONG_LEAD_RISK_LEVELS)[number];

export const EXPEDITING_ACTIONS = [
  "call",
  "email",
  "factory_visit",
  "escalation",
  "promise_received",
  "note",
] as const;
export type ExpeditingAction = (typeof EXPEDITING_ACTIONS)[number];

export const INCOTERMS = [
  "EXW",
  "FCA",
  "FAS",
  "FOB",
  "CFR",
  "CIF",
  "CPT",
  "CIP",
  "DAP",
  "DPU",
  "DDP",
] as const;
export type Incoterm = (typeof INCOTERMS)[number];

/* ------------------------------------------------------------------ */
/* Offsite / modular production (#922–929)                             */
/* ------------------------------------------------------------------ */

export const OFFSITE_UNIT_TYPES = [
  "volumetric_module",
  "panel",
  "pod",
  "cassette",
  "precast_element",
  "steel_assembly",
  "mep_module",
  "kit",
  "other",
] as const;
export type OffsiteUnitType = (typeof OFFSITE_UNIT_TYPES)[number];

/** The DfMA lifecycle: design → factory → QA → transport → site → installed. */
export const OFFSITE_UNIT_STATUSES = [
  "planned",
  "in_design",
  "in_production",
  "qa_hold",
  "passed_qa",
  "ready_to_ship",
  "in_transit",
  "delivered",
  "installed",
  "rejected",
] as const;
export type OffsiteUnitStatus = (typeof OFFSITE_UNIT_STATUSES)[number];

export const PRODUCTION_STAGE_STATUSES = ["not_started", "in_progress", "complete", "failed"] as const;
export type ProductionStageStatus = (typeof PRODUCTION_STAGE_STATUSES)[number];

/** Result of a QA gate on a production stage. A gate is `pending` until a
 *  verifier who is NOT the person who completed the stage records it. */
export const QA_GATE_RESULTS = ["pending", "passed", "failed", "waived"] as const;
export type QaGateResult = (typeof QA_GATE_RESULTS)[number];

export const FACTORY_INSPECTION_KINDS = [
  "factory_acceptance_test",
  "witness",
  "surveillance",
  "storage_inspection",
  "insurance_inspection",
  "vesting",
  "pre_dispatch",
] as const;
export type FactoryInspectionKind = (typeof FACTORY_INSPECTION_KINDS)[number];

export const FACTORY_INSPECTION_RESULTS = [
  "scheduled",
  "passed",
  "conditional",
  "failed",
  "cancelled",
] as const;
export type FactoryInspectionResult = (typeof FACTORY_INSPECTION_RESULTS)[number];

/* ------------------------------------------------------------------ */
/* Logistics: gates, slots, vehicles (#930–939)                        */
/* ------------------------------------------------------------------ */

export const SITE_GATE_STATUSES = ["open", "closed"] as const;
export type SiteGateStatus = (typeof SITE_GATE_STATUSES)[number];

export const DELIVERY_SLOT_STATUSES = [
  "requested",
  "confirmed",
  "arrived",
  "unloading",
  "completed",
  "no_show",
  "cancelled",
] as const;
export type DeliverySlotStatus = (typeof DELIVERY_SLOT_STATUSES)[number];

export const VEHICLE_TYPES = [
  "van",
  "rigid_7_5t",
  "rigid_18t",
  "rigid_26t",
  "articulated",
  "low_loader",
  "concrete_mixer",
  "tipper",
  "crane_lorry",
  "abnormal_load",
  "other",
] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const TRANSPORT_MODES = ["road", "rail", "sea", "air", "inland_waterway", "multimodal"] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];

/** What went wrong on arrival (#939). */
export const DELIVERY_ISSUE_KINDS = ["none", "damage", "shortage", "wrong_item", "late", "documentation"] as const;
export type DeliveryIssueKind = (typeof DELIVERY_ISSUE_KINDS)[number];

/* ------------------------------------------------------------------ */
/* Traceability (#945–947, #721–725)                                   */
/* ------------------------------------------------------------------ */

export const TRACE_CERTIFICATE_KINDS = [
  "mill_certificate",
  "test_certificate",
  "declaration_of_conformity",
  "ce_ukca_marking",
  "epd",
  "chain_of_custody",
  "responsible_sourcing",
  "conflict_minerals_declaration",
  "vesting_certificate",
  "other",
] as const;
export type TraceCertificateKind = (typeof TRACE_CERTIFICATE_KINDS)[number];

export const TRACE_STATUSES = ["received", "certified", "quarantined", "installed", "rejected"] as const;
export type TraceStatus = (typeof TRACE_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Supplier risk (#915–917, #946)                                      */
/* ------------------------------------------------------------------ */

export const SUPPLIER_RISK_LEVELS = ["low", "medium", "high", "critical", "not_assessable"] as const;
export type SupplierRiskLevel = (typeof SUPPLIER_RISK_LEVELS)[number];

/** The flags the supplier risk engine can raise. Each carries its own basis. */
export const SUPPLY_RISK_FLAGS = [
  "single_source",
  "country_concentration",
  "financial_distress",
  "going_concern",
  "sanctions_hit",
  "sanctions_unscreened",
  "prequal_rejected",
  "prequal_missing",
  "tier_visibility_gap",
  "critical_path_exposure",
  "expediting_backlog",
] as const;
export type SupplyRiskFlag = (typeof SUPPLY_RISK_FLAGS)[number];

/** Detectors this module raises into `signals`. */
export const SUPPLY_CHAIN_DETECTORS = [
  "supply_long_lead_late",
  "supply_long_lead_at_risk",
  "supply_jit_conflict",
  "supply_single_source_critical",
  "supply_country_concentration",
  "supply_financial_distress",
  "supply_sanctions",
  "supply_offsite_qa_failed",
  "supply_delivery_no_show",
] as const;
export type SupplyChainDetector = (typeof SUPPLY_CHAIN_DETECTORS)[number];

/** Kinds of just-in-time conflict between a delivery and the task it feeds. */
export const JIT_CONFLICT_KINDS = [
  "arrives_after_task_start",
  "forecast_after_task_start",
  "arrives_too_early",
  "unit_not_ready_for_install",
  "no_delivery_booked",
] as const;
export type JitConflictKind = (typeof JIT_CONFLICT_KINDS)[number];
