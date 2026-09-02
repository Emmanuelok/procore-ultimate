/**
 * Shared enums for the safety area (platform upgrade wave).
 *
 * The vocabularies here are the ones the *outside* of a safety programme uses
 * — a regulator's form, a device manufacturer's alarm, a client's
 * prequalification questionnaire — because those are the words that have to
 * survive leaving the platform. `enums.ts` already carries the site-facing
 * vocabulary (categories, severities, record kinds); everything added by this
 * wave lives here.
 *
 * Add new `as const` string unions and their types here; never edit enums.ts
 * from a parallel work package.
 */

import { SAFETY_PROGRAMME_RECORD_KINDS } from "./enums.js";

/* ------------------------------------------------------------------ */
/* Regulatory outputs (#652)                                           */
/* ------------------------------------------------------------------ */

/**
 * The statutory forms this platform can prefill from a determination. Each is
 * a RENDERING of records already held, never a new assertion: an OSHA 300 row
 * is the incident's own classification columns laid out the way 29 CFR
 * 1904.29 asks for them, and an F2508 prefill is the RIDDOR determination's
 * facts in the order the online form requests them.
 */
export const SAFETY_REGULATORY_FORMS = [
  /** 29 CFR 1904.29 — the annual log of work-related injuries and illnesses */
  "osha_300",
  /** 29 CFR 1904.32 — the annual summary, posted 1 Feb to 30 Apr */
  "osha_300a",
  /** 29 CFR 1904.29(b)(2) — the incident report behind one 300 log entry */
  "osha_301",
  /** RIDDOR 2013 — injury / dangerous occurrence report */
  "riddor_f2508",
  /** RIDDOR 2013 reg. 8/9 — occupational disease report */
  "riddor_f2508a",
] as const;
export type SafetyRegulatoryForm = (typeof SAFETY_REGULATORY_FORMS)[number];

/** Whether a generated artefact is a working draft or the thing that was filed. */
export const SAFETY_REGULATORY_REPORT_STATUSES = [
  "generated",
  "submitted",
  "superseded",
  "void",
] as const;
export type SafetyRegulatoryReportStatus =
  (typeof SAFETY_REGULATORY_REPORT_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Wearables and lone-worker devices (#1070–1073)                       */
/* ------------------------------------------------------------------ */

/**
 * What a device on a person or a gate actually reports. These are alarm
 * classes, not incidents: a man-down alarm is a fact about an accelerometer,
 * and whether it was an incident is a human's determination afterwards. The
 * distinction is the whole reason these land in their own register rather
 * than as incidents nobody can close.
 */
export const SAFETY_SENSOR_EVENT_KINDS = [
  "man_down",
  "no_motion",
  "fall_detected",
  "impact",
  "sos",
  "check_in_missed",
  "gas_alarm",
  "heat_stress",
  "noise_exposure",
  "proximity_alert",
  "exclusion_zone_breach",
  "device_offline",
  "panic_test",
] as const;
export type SafetySensorEventKind = (typeof SAFETY_SENSOR_EVENT_KINDS)[number];

/**
 * The lifecycle of one alarm. `auto_resolved` is the device telling us it
 * cancelled itself (the worker moved again); it is kept distinct from a human
 * dismissal because "the alarm stopped" and "somebody checked" are different
 * evidence in an enforcement interview.
 */
export const SAFETY_SENSOR_EVENT_STATUSES = [
  "open",
  "acknowledged",
  "auto_resolved",
  "resolved",
  "escalated",
  "false_alarm",
  "void",
] as const;
export type SafetySensorEventStatus = (typeof SAFETY_SENSOR_EVENT_STATUSES)[number];

/** How a device event reached the platform, so provenance is never guessed. */
export const SAFETY_SENSOR_SOURCES = [
  "wearable",
  "lone_worker_device",
  "gas_detector",
  "proximity_tag",
  "plant_telematics",
  "mobile_app",
  "manual",
] as const;
export type SafetySensorSource = (typeof SAFETY_SENSOR_SOURCES)[number];

/* ------------------------------------------------------------------ */
/* Predictive safety risk index                                        */
/* ------------------------------------------------------------------ */

/**
 * The band a project's leading-indicator index falls in. A band is published
 * only when enough of the index's components could be computed; the engine
 * returns `unrated` rather than inventing a middle value, because "we do not
 * know" and "average" are opposite instructions to a project director.
 */
export const SAFETY_RISK_BANDS = ["low", "elevated", "high", "severe", "unrated"] as const;
export type SafetyRiskBand = (typeof SAFETY_RISK_BANDS)[number];

/**
 * The leading indicators the index is built from. Each is a number a site can
 * change this week — which is what makes an index predictive rather than a
 * restatement of last quarter's accidents.
 */
export const SAFETY_RISK_COMPONENTS = [
  "action_overdue_load",
  "weak_control_share",
  "observation_reporting",
  "inspection_failure_rate",
  "briefing_coverage",
  "programme_expiry",
  "incident_recency",
  "statutory_discipline",
  "device_alarm_load",
] as const;
export type SafetyRiskComponent = (typeof SAFETY_RISK_COMPONENTS)[number];

/* ------------------------------------------------------------------ */
/* Programme record kinds added by this wave                           */
/* ------------------------------------------------------------------ */

/**
 * `safety_programme_records.record_kind` is a text column, so the register
 * can carry kinds beyond the frozen list in enums.ts. These are the ones the
 * safety programme actually needs and did not have: a task-level JHA/JSA is
 * not the same document as a project RAMS, a drug-and-alcohol test result is
 * a personal record with its own retention rules, and safety committee
 * minutes are the evidence that consultation happened at all.
 */
export const SAFETY_ADDITIONAL_RECORD_KINDS = [
  "jha",
  "safety_meeting_minutes",
  "drug_alcohol_policy",
  "drug_alcohol_test",
  "lone_worker_procedure",
  "fatigue_management_plan",
  "wellbeing_record",
  "contractor_safety_plan",
] as const;
export type SafetyAdditionalRecordKind = (typeof SAFETY_ADDITIONAL_RECORD_KINDS)[number];

/** Every kind the programme register accepts — frozen list plus this wave's. */
export const SAFETY_RECORD_KINDS_ALL = [
  ...SAFETY_PROGRAMME_RECORD_KINDS,
  ...SAFETY_ADDITIONAL_RECORD_KINDS,
] as const;
export type SafetyRecordKind = (typeof SAFETY_RECORD_KINDS_ALL)[number];

/** Outcome of a drug or alcohol test, recorded on the programme record. */
export const DRUG_ALCOHOL_TEST_RESULTS = [
  "negative",
  "non_negative_pending_confirmation",
  "positive",
  "refused",
  "invalid",
  "not_tested",
] as const;
export type DrugAlcoholTestResult = (typeof DRUG_ALCOHOL_TEST_RESULTS)[number];

/** Why a test was carried out — the fact an appeal turns on. */
export const DRUG_ALCOHOL_TEST_REASONS = [
  "pre_employment",
  "random",
  "for_cause",
  "post_incident",
  "return_to_duty",
  "periodic",
] as const;
export type DrugAlcoholTestReason = (typeof DRUG_ALCOHOL_TEST_REASONS)[number];

/* ------------------------------------------------------------------ */
/* Statutory notification state, per regime                            */
/* ------------------------------------------------------------------ */

/**
 * One duty's standing. An incident assessed under two regimes has two of
 * these, and collapsing them into a single "notified" flag is how a live
 * statutory duty disappears from a register (the bug this wave fixed).
 */
export const NOTIFICATION_DUTY_STATES = [
  "not_required",
  "outstanding",
  "notified",
  "notified_late",
  "missed",
] as const;
export type NotificationDutyState = (typeof NOTIFICATION_DUTY_STATES)[number];
