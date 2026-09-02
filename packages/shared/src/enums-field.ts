/**
 * Shared enums for the field area (platform upgrade wave): observations,
 * RFI response drafts, submittal extensions, daily-log kinds, punch, photos
 * and the overdue-escalation ladder. Add new `as const` string unions and
 * their types here; never edit enums.ts from a parallel work package.
 */

/* ------------------------------------------------------------------ */
/* Observations — spec Vol I §4.2 #634–646                             */
/* ------------------------------------------------------------------ */

export const OBSERVATION_TYPES = [
  "safety",
  "quality",
  "commissioning",
  "warranty",
  "work_to_complete",
  "deficiency",
  "other",
] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

export const OBSERVATION_STATUSES = [
  "open",
  "in_progress",
  "ready_for_review",
  "closed",
  "void",
] as const;
export type ObservationStatus = (typeof OBSERVATION_STATUSES)[number];

/** Records an observation can be converted into (#644). */
export const OBSERVATION_CONVERSION_TARGETS = ["punch_item", "incident", "change_event"] as const;
export type ObservationConversionTarget = (typeof OBSERVATION_CONVERSION_TARGETS)[number];

/* ------------------------------------------------------------------ */
/* Shared field vocabularies                                           */
/* ------------------------------------------------------------------ */

export const FIELD_PRIORITIES = ["low", "medium", "high"] as const;
export type FieldPriority = (typeof FIELD_PRIORITIES)[number];

/** RFI draft-response lifecycle (spec #311 response approval workflow). */
export const RFI_RESPONSE_DRAFT_STATUSES = ["draft", "adopted", "discarded"] as const;
export type RfiResponseDraftStatus = (typeof RFI_RESPONSE_DRAFT_STATUSES)[number];

/** Where an RFI came from (#324 email ingestion). */
export const RFI_SOURCES = ["manual", "email", "mcp", "observation"] as const;
export type RfiSource = (typeof RFI_SOURCES)[number];

/**
 * Submittal statuses including `superseded` — the state of a revision whose
 * resubmittal has been created (#340). `SUBMITTAL_STATUSES` in enums.ts is
 * frozen, so the widened set lives here and the column stays text.
 */
export const SUBMITTAL_STATUSES_EXTENDED = [
  "draft",
  "open",
  "in_review",
  "responded",
  "closed",
  "void",
  "superseded",
] as const;
export type SubmittalStatusExtended = (typeof SUBMITTAL_STATUSES_EXTENDED)[number];

/** Submittal types that belong to the closeout package (#348). */
export const CLOSEOUT_SUBMITTAL_TYPES = ["o_and_m", "warranty", "certificate"] as const;

export const DAILY_LOG_STATUSES = ["draft", "submitted", "approved"] as const;
export type DailyLogStatus = (typeof DAILY_LOG_STATUSES)[number];

/** Who authored the log: the GC's own diary or a subcontractor's self-report (#396). */
export const DAILY_LOG_KINDS = ["internal", "subcontractor"] as const;
export type DailyLogKind = (typeof DAILY_LOG_KINDS)[number];

/** Provenance of the weather block on a daily log (#373). */
export const WEATHER_SOURCES = ["manual", "auto"] as const;
export type WeatherSource = (typeof WEATHER_SOURCES)[number];

/** AI photo-intelligence pipeline state on a photo (#437–439). */
export const PHOTO_AI_STATUSES = ["pending", "done", "failed", "skipped"] as const;
export type PhotoAiStatus = (typeof PHOTO_AI_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Overdue escalation ladder — #308, #321, #395, #411                  */
/* ------------------------------------------------------------------ */

/** Record types the field escalation sweep watches. */
export const FIELD_ESCALATION_RECORD_TYPES = [
  "rfi",
  "submittal",
  "punch_item",
  "daily_log",
  "observation",
] as const;
export type FieldEscalationRecordType = (typeof FIELD_ESCALATION_RECORD_TYPES)[number];

/**
 * Ladder rungs: 1 = notify the responsible person on the day it turns
 * overdue, 2 = notify the project managers after N days, 3 = raise an
 * integrity signal after 2N days.
 */
export const FIELD_ESCALATION_LEVELS = [1, 2, 3] as const;
export type FieldEscalationLevel = (typeof FIELD_ESCALATION_LEVELS)[number];

/** Ageing buckets used by every field ageing report (#321, #411). */
export const FIELD_AGEING_BUCKETS = ["0-7", "8-14", "15-30", "30+"] as const;
export type FieldAgeingBucket = (typeof FIELD_AGEING_BUCKETS)[number];
