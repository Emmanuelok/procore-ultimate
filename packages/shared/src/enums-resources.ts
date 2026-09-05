/**
 * RESOURCE PLANNING & PRODUCTIVITY — shared vocabulary (spec Vol I §5.1–5.2,
 * #676–699).
 *
 * The words here decide whether two numbers may be compared. A "labour" type
 * measured in hours and an "equipment" type measured in hours are not the
 * same supply and are never levelled against one another; a "baseline" plan
 * and a "scenario" plan are never blended into one histogram; a certification
 * that is `expired` is not a weaker form of `valid`.
 *
 * Every union is closed on purpose: a free-text status is a status nobody can
 * filter, roll up or reason about a year later.
 */

/** What kind of supply a resource type describes. Hours of one kind never
 *  satisfy demand of another — a crane hour does not cover a joiner hour. */
export const RESOURCE_KINDS = ["labour", "equipment", "subcontract"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export const RESOURCE_TYPE_STATUSES = ["active", "archived"] as const;
export type ResourceTypeStatus = (typeof RESOURCE_TYPE_STATUSES)[number];

/**
 * Why a plan exists. `baseline` is the resourcing the project was sanctioned
 * on and never moves; `current` is what we intend to do now; `scenario` is a
 * what-if that must never be mistaken for either. Exactly one `current` plan
 * is `active` at a time.
 */
export const RESOURCE_PLAN_KINDS = ["baseline", "current", "scenario"] as const;
export type ResourcePlanKind = (typeof RESOURCE_PLAN_KINDS)[number];

export const RESOURCE_PLAN_STATUSES = ["draft", "active", "superseded", "archived"] as const;
export type ResourcePlanStatus = (typeof RESOURCE_PLAN_STATUSES)[number];

/** Where a demand row came from. A row derived from the schedule carries the
 *  task it came from; a hand-typed row does not, and the two are never
 *  silently merged. */
export const RESOURCE_DEMAND_SOURCES = ["manual", "schedule", "import"] as const;
export type ResourceDemandSource = (typeof RESOURCE_DEMAND_SOURCES)[number];

/**
 * How firm a week's supply is. `assumed` is the honest label for "we think we
 * can get them" and is reported distinctly, because a histogram that shows
 * assumed supply as though it were a signed vendor commitment is the reason
 * resourcing plans fail quietly.
 */
export const RESOURCE_AVAILABILITY_SOURCES = [
  "roster",
  "vendor_commitment",
  "assumed",
  "manual",
] as const;
export type ResourceAvailabilitySource = (typeof RESOURCE_AVAILABILITY_SOURCES)[number];

/** What an assignment assigns. Exactly one id column is set to match. */
export const RESOURCE_SUBJECT_KINDS = ["crew", "worker", "equipment"] as const;
export type ResourceSubjectKind = (typeof RESOURCE_SUBJECT_KINDS)[number];

export const RESOURCE_ASSIGNMENT_STATUSES = [
  "planned",
  "confirmed",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type ResourceAssignmentStatus = (typeof RESOURCE_ASSIGNMENT_STATUSES)[number];

/** Statuses that still occupy the resource's calendar. A cancelled or
 *  completed assignment cannot conflict with anything. */
export const ACTIVE_ASSIGNMENT_STATUSES = ["planned", "confirmed", "in_progress"] as const;

/** What a productivity snapshot is about. */
export const PRODUCTIVITY_SCOPES = ["project", "resource_type", "crew", "budget_line"] as const;
export type ProductivityScope = (typeof PRODUCTIVITY_SCOPES)[number];

/**
 * How hours-at-completion was forecast.
 *  · `productivity_factor` — budget hours ÷ PF achieved to date.
 *  · `remaining_quantity`  — spent + remaining quantity × achieved unit rate.
 *  · `planned_burn`        — spent + planned hours still unspent (PF = 1.0,
 *                            i.e. "we will do the rest exactly to plan").
 *  · `manual`              — a human overrode it and said why.
 */
export const HOURS_FORECAST_METHODS = [
  "productivity_factor",
  "remaining_quantity",
  "planned_burn",
  "manual",
] as const;
export type HoursForecastMethod = (typeof HOURS_FORECAST_METHODS)[number];

export const FORECAST_CONFIDENCES = ["low", "medium", "high"] as const;
export type ForecastConfidence = (typeof FORECAST_CONFIDENCES)[number];

/** A skill is a capability; a certification/licence is a capability someone
 *  external attested to and which EXPIRES. The distinction drives the
 *  expiry sweep — a skill without a `validityMonths` never goes stale. */
export const SKILL_CATEGORIES = ["skill", "certification", "licence", "training"] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export const SKILL_LEVELS = ["none", "trainee", "competent", "advanced", "trainer"] as const;
export type SkillLevel = (typeof SKILL_LEVELS)[number];

/** The evidence state of a matrix cell — NOT its expiry state. A verified
 *  certificate can still be expired; an unverified one is a claim. */
export const WORKER_SKILL_STATUSES = ["claimed", "verified", "rejected", "revoked"] as const;
export type WorkerSkillStatus = (typeof WORKER_SKILL_STATUSES)[number];

/** Derived at read time from `expiresAt`. `unknown` means no expiry date is
 *  recorded — which is not the same as "does not expire". */
export const SKILL_VALIDITY_STATES = ["valid", "expiring", "expired", "unknown"] as const;
export type SkillValidityState = (typeof SKILL_VALIDITY_STATES)[number];

/** What a levelling suggestion proposes. Suggestions are never applied
 *  automatically: moving a task changes the programme, which is the schedule
 *  module's record to change. */
export const RESOURCE_LEVELLING_ACTIONS = [
  "defer_task",
  "extend_duration",
  "add_supply",
  "reduce_scope",
  "accept_peak",
] as const;
export type ResourceLevellingAction = (typeof RESOURCE_LEVELLING_ACTIONS)[number];

/** Detector ids raised into `signals` by this module's sweeps. */
export const RESOURCE_DETECTORS = [
  "resource_over_allocation",
  "resource_assignment_conflict",
  "resource_certification_expiry",
  "resource_productivity_deviation",
  "resource_unresourced_work",
] as const;
export type ResourceDetector = (typeof RESOURCE_DETECTORS)[number];
