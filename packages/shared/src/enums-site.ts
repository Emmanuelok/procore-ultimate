/**
 * SITE OPERATIONS & REALITY CAPTURE — shared enums (spec Vol II Z #1067–1084,
 * X #995–1003; Vol I §2.15 #471–478).
 *
 * The vocabulary the site tables, the API and the workspace all speak. Every
 * union is `as const` so a status string means the same thing in the gate
 * feed, the permit board and the exceptional-weather report.
 *
 * These are additions only: `enums.ts` is frozen for parallel work packages.
 */

/* ------------------------------------------------------------------ */
/* Site access, induction and the on-site register (#1067–1069)        */
/* ------------------------------------------------------------------ */

/** Who the person on site is. The register is not a staff list: a delivery
 *  driver and a regulator are on site and count at a muster. */
export const SITE_PERSON_KINDS = [
  "worker",
  "staff",
  "visitor",
  "subcontractor",
  "delivery_driver",
  "inspector",
  "client",
  "other",
] as const;
export type SitePersonKind = (typeof SITE_PERSON_KINDS)[number];

export const SITE_INDUCTION_TYPES = [
  "general",
  "task_specific",
  "visitor",
  "refresher",
  "contractor",
  "plant_operator",
] as const;
export type SiteInductionType = (typeof SITE_INDUCTION_TYPES)[number];

/** `expired` is computed by the sweep, never asserted by a person. */
export const SITE_INDUCTION_STATUSES = [
  "pending",
  "valid",
  "expired",
  "revoked",
  "failed",
] as const;
export type SiteInductionStatus = (typeof SITE_INDUCTION_STATUSES)[number];

export const SITE_CREDENTIAL_TYPES = ["badge", "biometric", "qr", "vehicle_plate", "mobile"] as const;
export type SiteCredentialType = (typeof SITE_CREDENTIAL_TYPES)[number];

export const SITE_PASS_STATUSES = [
  "active",
  "suspended",
  "expired",
  "revoked",
  "lost",
] as const;
export type SitePassStatus = (typeof SITE_PASS_STATUSES)[number];

export const SITE_GATE_DIRECTIONS = ["in", "out"] as const;
export type SiteGateDirection = (typeof SITE_GATE_DIRECTIONS)[number];

/** Where a gate event came from. `manual` is the weakest evidence and the
 *  independence score of anything derived from it says so. */
export const SITE_GATE_SOURCES = [
  "turnstile",
  "biometric",
  "anpr",
  "mobile",
  "manual",
  "api",
  "import",
] as const;
export type SiteGateSource = (typeof SITE_GATE_SOURCES)[number];

/** Why a gate event was refused at the reader (recorded, not invented). */
export const SITE_GATE_REFUSALS = [
  "no_pass",
  "pass_expired",
  "pass_revoked",
  "pass_suspended",
  "induction_expired",
  "zone_not_permitted",
  "already_inside",
  "not_inside",
  "unknown_credential",
  "other",
] as const;
export type SiteGateRefusal = (typeof SITE_GATE_REFUSALS)[number];

export const SITE_MUSTER_KINDS = ["drill", "emergency", "roll_call"] as const;
export type SiteMusterKind = (typeof SITE_MUSTER_KINDS)[number];

export const SITE_MUSTER_STATUSES = ["open", "reconciled", "closed"] as const;
export type SiteMusterStatus = (typeof SITE_MUSTER_STATUSES)[number];

/** The outcome for one person at a muster. `unaccounted` is the only one that
 *  matters and it is what the reconciliation counts. */
export const SITE_MUSTER_PERSON_STATUSES = [
  "present",
  "accounted_offsite",
  "unaccounted",
] as const;
export type SiteMusterPersonStatus = (typeof SITE_MUSTER_PERSON_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Permits to work, exclusion zones, lone working (#1070–1073)         */
/* ------------------------------------------------------------------ */

export const SITE_PERMIT_TYPES = [
  "hot_work",
  "confined_space",
  "working_at_height",
  "excavation",
  "electrical_isolation",
  "lifting_operation",
  "live_services",
  "road_closure",
  "night_work",
  "demolition",
  "diving",
  "radiography",
  "other",
] as const;
export type SitePermitType = (typeof SITE_PERMIT_TYPES)[number];

/**
 * A permit's life. `active` means work may proceed NOW; `expired` is set by
 * the sweep when the validity window closes without a closure, which is the
 * condition a hot-work fire watch exists to catch.
 */
export const SITE_PERMIT_STATUSES = [
  "draft",
  "requested",
  "approved",
  "active",
  "suspended",
  "closed",
  "expired",
  "cancelled",
  "rejected",
] as const;
export type SitePermitStatus = (typeof SITE_PERMIT_STATUSES)[number];

export const SITE_PERMIT_ENTRY_STATUSES = ["inside", "exited", "overdue"] as const;
export type SitePermitEntryStatus = (typeof SITE_PERMIT_ENTRY_STATUSES)[number];

export const SITE_EXCLUSION_ZONE_KINDS = [
  "lifting",
  "hot_work",
  "confined_space",
  "excavation",
  "blasting",
  "hazardous_material",
  "traffic",
  "drone",
  "overhead_line",
  "other",
] as const;
export type SiteExclusionZoneKind = (typeof SITE_EXCLUSION_ZONE_KINDS)[number];

export const SITE_EXCLUSION_ZONE_STATUSES = ["planned", "active", "lifted", "cancelled"] as const;
export type SiteExclusionZoneStatus = (typeof SITE_EXCLUSION_ZONE_STATUSES)[number];

/** A lone-worker session. `overdue` is a missed check-in; `escalated` means the
 *  platform has raised it and told someone. */
export const SITE_LONE_WORKER_STATUSES = [
  "active",
  "completed",
  "overdue",
  "escalated",
  "cancelled",
] as const;
export type SiteLoneWorkerStatus = (typeof SITE_LONE_WORKER_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Weather archive and exceptional-weather analysis (#1074–1076)       */
/* ------------------------------------------------------------------ */

export const SITE_WEATHER_SOURCES = [
  "manual",
  "provider",
  "daily_log",
  "import",
  "station",
] as const;
export type SiteWeatherSource = (typeof SITE_WEATHER_SOURCES)[number];

/** The measurable a contract threshold is written against. */
export const SITE_WEATHER_METRICS = [
  "precipitation_mm",
  "temp_min_c",
  "temp_max_c",
  "wind_mean_kph",
  "wind_gust_kph",
  "snowfall_mm",
  "visibility_m",
  "sea_state_m",
  "humidity_pct",
] as const;
export type SiteWeatherMetric = (typeof SITE_WEATHER_METRICS)[number];

export const SITE_WEATHER_COMPARATORS = ["gte", "lte", "gt", "lt"] as const;
export type SiteWeatherComparator = (typeof SITE_WEATHER_COMPARATORS)[number];

export const SITE_WEATHER_BASELINE_SOURCES = [
  "contract",
  "met_records",
  "manual",
  "provider",
] as const;
export type SiteWeatherBaselineSource = (typeof SITE_WEATHER_BASELINE_SOURCES)[number];

export const SITE_WEATHER_ANALYSIS_STATUSES = ["draft", "issued", "superseded"] as const;
export type SiteWeatherAnalysisStatus = (typeof SITE_WEATHER_ANALYSIS_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Reality capture (#1077–1080, Vol I §2.15)                           */
/* ------------------------------------------------------------------ */

export const SITE_FLIGHT_PURPOSES = [
  "progress",
  "survey",
  "inspection",
  "thermal",
  "volumetrics",
  "safety",
  "marketing",
  "other",
] as const;
export type SiteFlightPurpose = (typeof SITE_FLIGHT_PURPOSES)[number];

export const SITE_FLIGHT_STATUSES = [
  "planned",
  "permitted",
  "flown",
  "processed",
  "grounded",
  "cancelled",
] as const;
export type SiteFlightStatus = (typeof SITE_FLIGHT_STATUSES)[number];

/** Airspace/landowner permission. `not_required` is a recorded decision, not
 *  an absence — a flight with `pending` permission may not be flown. */
export const SITE_FLIGHT_PERMISSIONS = [
  "not_required",
  "pending",
  "granted",
  "refused",
] as const;
export type SiteFlightPermission = (typeof SITE_FLIGHT_PERMISSIONS)[number];

export const SITE_SCAN_METHODS = [
  "terrestrial_laser",
  "slam",
  "photogrammetry",
  "mobile_mapping",
  "drone_lidar",
  "total_station",
  "gpr",
] as const;
export type SiteScanMethod = (typeof SITE_SCAN_METHODS)[number];

export const SITE_SCAN_STATUSES = [
  "planned",
  "captured",
  "processed",
  "published",
  "failed",
  "archived",
] as const;
export type SiteScanStatus = (typeof SITE_SCAN_STATUSES)[number];

export const SITE_SCAN_REGISTRATION_STATUSES = [
  "unregistered",
  "registered",
  "failed",
] as const;
export type SiteScanRegistrationStatus = (typeof SITE_SCAN_REGISTRATION_STATUSES)[number];

/** The verdict a scan-vs-model comparison reaches. `not_assessable` is what an
 *  unregistered scan or a report with no tolerance produces — never "within". */
export const SITE_DEVIATION_VERDICTS = [
  "within_tolerance",
  "marginal",
  "out_of_tolerance",
  "not_assessable",
] as const;
export type SiteDeviationVerdict = (typeof SITE_DEVIATION_VERDICTS)[number];

export const SITE_DEVIATION_STATUSES = ["draft", "issued", "accepted", "rejected"] as const;
export type SiteDeviationStatus = (typeof SITE_DEVIATION_STATUSES)[number];

export const SITE_TOUR_STATUSES = ["draft", "published", "archived"] as const;
export type SiteTourStatus = (typeof SITE_TOUR_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Survey control and setting out (#1081)                              */
/* ------------------------------------------------------------------ */

export const SITE_SURVEY_POINT_KINDS = [
  "control",
  "benchmark",
  "setting_out",
  "as_built",
  "monitoring",
] as const;
export type SiteSurveyPointKind = (typeof SITE_SURVEY_POINT_KINDS)[number];

export const SITE_SURVEY_METHODS = ["gnss", "total_station", "level", "scan", "tape"] as const;
export type SiteSurveyMethod = (typeof SITE_SURVEY_METHODS)[number];

export const SITE_SURVEY_POINT_STATUSES = [
  "active",
  "disturbed",
  "destroyed",
  "superseded",
] as const;
export type SiteSurveyPointStatus = (typeof SITE_SURVEY_POINT_STATUSES)[number];

/** Setting out is a two-person record by design: the checker may not be the
 *  person who set the work out. */
export const SITE_SETTING_OUT_STATUSES = [
  "draft",
  "set_out",
  "checked",
  "approved",
  "rejected",
] as const;
export type SiteSettingOutStatus = (typeof SITE_SETTING_OUT_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Ground conditions and utilities (#1082–1083)                        */
/* ------------------------------------------------------------------ */

export const SITE_GEOTECH_KINDS = [
  "borehole",
  "trial_pit",
  "cpt",
  "window_sample",
  "probe",
  "monitoring_well",
  "geophysics",
] as const;
export type SiteGeotechKind = (typeof SITE_GEOTECH_KINDS)[number];

export const SITE_GEOTECH_STATUSES = [
  "planned",
  "in_progress",
  "complete",
  "abandoned",
] as const;
export type SiteGeotechStatus = (typeof SITE_GEOTECH_STATUSES)[number];

/** What differs between the baseline ground model and what was found. */
export const SITE_GROUND_FINDING_CATEGORIES = [
  "strata_change",
  "water_table",
  "obstruction",
  "contamination",
  "rock_level",
  "bearing_capacity",
  "archaeology",
  "voids",
] as const;
export type SiteGroundFindingCategory = (typeof SITE_GROUND_FINDING_CATEGORIES)[number];

export const SITE_GROUND_FINDING_STATUSES = [
  "open",
  "assessed",
  "accepted",
  "claimed",
  "closed",
] as const;
export type SiteGroundFindingStatus = (typeof SITE_GROUND_FINDING_STATUSES)[number];

export const SITE_UTILITY_TYPES = [
  "electricity",
  "gas",
  "water",
  "telecom",
  "sewer",
  "fuel",
  "district_heating",
  "signalling",
  "unknown",
] as const;
export type SiteUtilityType = (typeof SITE_UTILITY_TYPES)[number];

export const SITE_UTILITY_DETECTION_METHODS = [
  "gpr",
  "electromagnetic",
  "records",
  "trial_hole",
  "as_built",
  "vacuum_excavation",
] as const;
export type SiteUtilityDetectionMethod = (typeof SITE_UTILITY_DETECTION_METHODS)[number];

/** How much the recorded position can be relied on. `unknown` is the honest
 *  default and is what makes a permit refuse to go active without a scan. */
export const SITE_UTILITY_CONFIDENCES = [
  "verified",
  "probable",
  "indicative",
  "unknown",
] as const;
export type SiteUtilityConfidence = (typeof SITE_UTILITY_CONFIDENCES)[number];

export const SITE_UTILITY_STATUSES = [
  "live",
  "isolated",
  "abandoned",
  "diverted",
  "unknown",
] as const;
export type SiteUtilityStatus = (typeof SITE_UTILITY_STATUSES)[number];

export const SITE_STRIKE_SEVERITIES = ["near_miss", "minor", "significant", "major"] as const;
export type SiteStrikeSeverity = (typeof SITE_STRIKE_SEVERITIES)[number];

export const SITE_STRIKE_STATUSES = ["reported", "investigating", "closed"] as const;
export type SiteStrikeStatus = (typeof SITE_STRIKE_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Environmental / seismic / tidal event log (#1084)                   */
/* ------------------------------------------------------------------ */

export const SITE_ENVIRONMENTAL_CATEGORIES = [
  "seismic",
  "tidal",
  "flood",
  "storm",
  "wind",
  "lightning",
  "dust",
  "noise",
  "vibration",
  "spill",
  "wildlife",
  "air_quality",
  "ground_movement",
  "other",
] as const;
export type SiteEnvironmentalCategory = (typeof SITE_ENVIRONMENTAL_CATEGORIES)[number];

export const SITE_ENVIRONMENTAL_DETECTIONS = [
  "sensor",
  "observation",
  "provider",
  "third_party_report",
] as const;
export type SiteEnvironmentalDetection = (typeof SITE_ENVIRONMENTAL_DETECTIONS)[number];

export const SITE_ENVIRONMENTAL_STATUSES = ["open", "monitoring", "closed"] as const;
export type SiteEnvironmentalStatus = (typeof SITE_ENVIRONMENTAL_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Progress determination (#995–1003)                                  */
/* ------------------------------------------------------------------ */

/** How the observed percentage was arrived at. The method decides the
 *  independence score of the evidence it produces. */
export const SITE_PROGRESS_METHODS = [
  "visual",
  "photo",
  "drone",
  "scan",
  "survey",
  "measurement",
] as const;
export type SiteProgressMethod = (typeof SITE_PROGRESS_METHODS)[number];

/** Where the CLAIM came from — the assertion side of the pair. */
export const SITE_PROGRESS_CLAIM_SOURCES = [
  "valuation",
  "progress_claim",
  "daily_log",
  "schedule_update",
  "application",
  "manual",
] as const;
export type SiteProgressClaimSource = (typeof SITE_PROGRESS_CLAIM_SOURCES)[number];

/* ------------------------------------------------------------------ */
/* Detectors (signals raised by this module)                           */
/* ------------------------------------------------------------------ */

export const SITE_DETECTORS = [
  "site_muster_unaccounted",
  "site_permit_expired_open",
  "site_confined_space_overdue",
  "site_lone_worker_overdue",
  "site_pass_without_induction",
  "site_overstay",
  "site_exceptional_weather",
  "site_scan_out_of_tolerance",
  "site_ground_condition_change",
  "site_utility_strike",
  "site_excavation_without_scan",
  "site_environmental_threshold",
  "site_progress_overclaim",
] as const;
export type SiteDetector = (typeof SITE_DETECTORS)[number];
