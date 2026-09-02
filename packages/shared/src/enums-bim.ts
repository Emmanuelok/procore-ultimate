/**
 * Shared enums for the BIM / digital-twin / coordination / maps area
 * (platform upgrade wave, WP-BIM). Covers spec Vol I §1.4–1.5, §2.14–2.15
 * and Vol II Domain L.
 *
 * Only `as const` string unions live here; enums.ts is frozen for parallel
 * work packages, so every vocabulary this area added is defined below and
 * re-exported from the package index.
 */

/* ------------------------------------------------------------------ */
/* Model ingestion                                                     */
/* ------------------------------------------------------------------ */

/** Lifecycle of a model version's element-extraction pipeline (#234–236). */
export const MODEL_PROCESSING_STATES = [
  "pending",
  "queued",
  "processing",
  "ready",
  "failed",
] as const;
export type ModelProcessingState = (typeof MODEL_PROCESSING_STATES)[number];

/** IFC spatial-structure levels used for model-based location assignment (#248). */
export const IFC_SPATIAL_TYPES = [
  "IFCPROJECT",
  "IFCSITE",
  "IFCBUILDING",
  "IFCBUILDINGSTOREY",
  "IFCSPACE",
] as const;
export type IfcSpatialType = (typeof IFC_SPATIAL_TYPES)[number];

/** Findings a model quality gate can report before publication (#638). */
export const MODEL_QUALITY_CHECKS = [
  "duplicate_global_ids",
  "missing_names",
  "missing_spatial_container",
  "missing_classification",
  "no_elements",
  "extraction_failed",
] as const;
export type ModelQualityCheck = (typeof MODEL_QUALITY_CHECKS)[number];

/* ------------------------------------------------------------------ */
/* Clash detection (#240)                                              */
/* ------------------------------------------------------------------ */

/** How a clash test pairs elements. */
export const CLASH_RULE_KINDS = ["discipline_pair", "type_pair", "all_pairs"] as const;
export type ClashRuleKind = (typeof CLASH_RULE_KINDS)[number];

/** Interference class produced by the engine. */
export const CLASH_KINDS = ["hard", "clearance", "duplicate"] as const;
export type ClashKind = (typeof CLASH_KINDS)[number];

/** Register lifecycle of one clash between two elements. */
export const CLASH_STATUSES = ["new", "active", "resolved", "approved", "ignored"] as const;
export type ClashStatus = (typeof CLASH_STATUSES)[number];

/** State of the last run of a clash test. */
export const CLASH_TEST_STATES = ["never_run", "ready", "failed"] as const;
export type ClashTestState = (typeof CLASH_TEST_STATES)[number];

/* ------------------------------------------------------------------ */
/* 4D / 5D links (#238–239)                                            */
/* ------------------------------------------------------------------ */

export const ELEMENT_LINK_TYPES = ["schedule_task", "budget_line"] as const;
export type ElementLinkType = (typeof ELEMENT_LINK_TYPES)[number];

/** What the linked element contributes to the target record. */
export const ELEMENT_LINK_ROLES = ["construct", "demolish", "temporary", "install"] as const;
export type ElementLinkRole = (typeof ELEMENT_LINK_ROLES)[number];

/* ------------------------------------------------------------------ */
/* Reality capture (#246, #1076–1080)                                  */
/* ------------------------------------------------------------------ */

export const REALITY_CAPTURE_KINDS = [
  "point_cloud",
  "photogrammetry",
  "panorama_360",
  "drone_flight",
  "total_station",
  "thermal",
  "other",
] as const;
export type RealityCaptureKind = (typeof REALITY_CAPTURE_KINDS)[number];

export const REALITY_CAPTURE_STATUSES = [
  "planned",
  "captured",
  "registered",
  "compared",
  "archived",
] as const;
export type RealityCaptureStatus = (typeof REALITY_CAPTURE_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Maps & geofences (#471–478)                                         */
/* ------------------------------------------------------------------ */

export const GEOFENCE_PURPOSES = [
  "site_boundary",
  "work_zone",
  "exclusion",
  "laydown",
  "access_route",
  "welfare",
  "environmental",
  "other",
] as const;
export type GeofencePurpose = (typeof GEOFENCE_PURPOSES)[number];

/** Record families the project map can plot. */
export const MAP_LAYER_KINDS = [
  "project",
  "equipment",
  "photo",
  "geofence",
  "asset",
  "capture",
] as const;
export type MapLayerKind = (typeof MAP_LAYER_KINDS)[number];

/* ------------------------------------------------------------------ */
/* Digital twin operations                                             */
/* ------------------------------------------------------------------ */

/** Why a sensor alert was raised (#659–661). */
export const SENSOR_ALERT_KINDS = ["min_breach", "max_breach", "stale"] as const;
export type SensorAlertKind = (typeof SENSOR_ALERT_KINDS)[number];

export const SENSOR_ALERT_STATUSES = ["open", "acknowledged", "cleared"] as const;
export type SensorAlertStatus = (typeof SENSOR_ALERT_STATUSES)[number];

export const WARRANTY_STATUSES = ["active", "expired", "claimed", "void"] as const;
export type WarrantyStatus = (typeof WARRANTY_STATUSES)[number];

/** Warranty claim lifecycle (#643). */
export const WARRANTY_CLAIM_STATUSES = [
  "lodged",
  "acknowledged",
  "in_repair",
  "closed",
  "rejected",
] as const;
export type WarrantyClaimStatus = (typeof WARRANTY_CLAIM_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Detectors raised by this area into `signals`                        */
/* ------------------------------------------------------------------ */

export const BIM_DETECTORS = [
  "bim_clash_unresolved",
  "bim_issue_overdue",
  "bim_ingest_failed",
  "twin_sensor_threshold",
  "twin_sensor_stale",
  "twin_warranty_expiring",
] as const;
export type BimDetector = (typeof BIM_DETECTORS)[number];
