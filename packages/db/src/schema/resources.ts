import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();

/**
 * RESOURCE PLANNING & PRODUCTIVITY (spec Vol I §5.1–5.2, #676–699).
 *
 * A project fails on resources long before it fails on money, and the failure
 * is always visible weeks earlier in one of three places:
 *
 *   1. DEMAND vs SUPPLY, BY WEEK. `resource_demands` is what the programme
 *      needs; `resource_availability` is what we can actually field. The gap,
 *      per week per trade, is the thing nobody looks at until the week it
 *      bites. Demand rows derived from the schedule keep `sourceTaskId` so a
 *      histogram can always answer "which activities made this week's peak".
 *
 *   2. WHO IS ACTUALLY BOOKED. `resource_assignments` is the calendar — a
 *      crew, a worker or a machine, on a task, between two dates. Two active
 *      assignments overlapping on the same subject is a CONFLICT, and it is
 *      detected rather than prevented, because the double-booking is usually
 *      real and the argument is about which one gives way.
 *
 *   3. HOURS BOUGHT vs HOURS EARNED. `resource_productivity_snapshots` and
 *      `resource_forecasts` persist what the live engine computed at a point
 *      in time. Snapshots exist because productivity is a TREND: the live
 *      figure recomputes from current timecards and therefore silently
 *      rewrites history every time a card is corrected, and a measured-mile
 *      argument that rests on a number nobody kept is not an argument.
 *
 * NOTHING HERE IS DUPLICATED FROM ELSEWHERE. Workers live in `workers`
 * (workforce.ts), crews and hours in `crews`/`timecards` (timecards.ts),
 * machines in `equipment` (equipment.ts), activities in `schedule_tasks`
 * (schedule.ts). This module holds the PLAN, the BOOKING and the MEASUREMENT
 * that sit on top of them, and creates no second register of people or plant.
 *
 * NULL IS A FIRST-CLASS ANSWER. Every derived column — headcount, earned
 * hours, productivity factor, forecast hours — is nullable, and the API
 * returns the reason alongside. A week with no recorded availability has
 * UNKNOWN supply, not zero supply, and the difference is the whole point:
 * zero supply manufactures a crisis, unknown supply asks a question.
 */

/* ================================================================== */
/* The library: what kinds of resource exist                           */
/* ================================================================== */

/**
 * A trade, craft or plant class that demand and supply are both stated in.
 * Company-level by default (`projectId` null) so a business plans against one
 * vocabulary; a project may add its own for one-off scopes.
 *
 * `standardHoursPerDay` is NOT defaulted to 8. A histogram converts hours to
 * headcount by dividing by it, and inventing 8 for a crew on a 10-hour
 * rotating shift produces a headcount that is 25% wrong on every chart it
 * appears on. With no value recorded, headcount is reported as unknown.
 */
export const resourceTypes = pgTable(
  "resource_types",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = company library, available to every project */
    projectId: text("project_id"),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    kind: text("kind").default("labour").notNull(), // ResourceKind
    /** labour: the trade/craft; equipment: null */
    trade: text("trade"),
    /** equipment: the plant class (matches equipment.category where it maps) */
    equipmentCategory: text("equipment_category"),
    /** the unit demand and supply are stated in — hours unless stated */
    unit: text("unit").default("hours").notNull(),
    /** never defaulted — see the doc comment above */
    standardHoursPerDay: doublePrecision("standard_hours_per_day"),
    /** working days in a standard week, for the headcount conversion */
    workingDaysPerWeek: doublePrecision("working_days_per_week"),
    defaultHourlyCost: doublePrecision("default_hourly_cost"),
    currency: text("currency").default("USD").notNull(),
    /** resource_skills.id[] a person or machine must hold to count as this type */
    requiredSkillIds: jsonb("required_skill_ids").$type<string[]>().default([]).notNull(),
    /** timecards.crews trade string this type maps onto, for productivity joins */
    mapsToTrade: text("maps_to_trade"),
    status: text("status").default("active").notNull(), // ResourceTypeStatus
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("resource_types_uq").on(t.companyId, t.code),
    index("resource_types_company_idx").on(t.companyId, t.kind, t.status),
    index("resource_types_project_idx").on(t.projectId, t.status),
  ],
);

/* ================================================================== */
/* Demand: what the programme needs                                    */
/* ================================================================== */

/**
 * A resource demand plan. Versioned rather than edited: the baseline the job
 * was sanctioned on has to stay readable next to what we are doing now, or
 * "we were always going to need forty joiners in March" becomes unfalsifiable.
 */
export const resourcePlans = pgTable(
  "resource_plans",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    planKind: text("plan_kind").default("current").notNull(), // ResourcePlanKind
    status: text("status").default("draft").notNull(), // ResourcePlanStatus
    /** the schedule the demand was derived from, when it was */
    scheduleId: text("schedule_id"),
    periodStart: text("period_start"), // ISO date, the first week
    periodEnd: text("period_end"),
    /** 0 = Sunday … 6 = Saturday; the week boundary every figure is bucketed on */
    weekStartsOn: integer("week_starts_on").default(1).notNull(),
    source: text("source").default("manual").notNull(), // ResourceDemandSource
    version: integer("version").default(1).notNull(),
    supersedesPlanId: text("supersedes_plan_id"),
    derivedAt: timestamp("derived_at", { withTimezone: true, mode: "string" }),
    /** how many schedule tasks contributed, and how many could not */
    derivedTaskCount: integer("derived_task_count").default(0).notNull(),
    skippedTaskCount: integer("skipped_task_count").default(0).notNull(),
    /* materialised rollups so a register list needs no aggregate query */
    demandRowCount: integer("demand_row_count").default(0).notNull(),
    totalDemandHours: doublePrecision("total_demand_hours").default(0).notNull(),
    /** null when any contributing type has no standardHoursPerDay */
    peakHeadcount: doublePrecision("peak_headcount"),
    peakWeekStart: text("peak_week_start"),
    activatedBy: text("activated_by"),
    activatedAt: timestamp("activated_at", { withTimezone: true, mode: "string" }),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("resource_plans_uq").on(t.projectId, t.number),
    index("resource_plans_project_idx").on(t.projectId, t.status),
    index("resource_plans_company_idx").on(t.companyId, t.status),
    index("resource_plans_kind_idx").on(t.projectId, t.planKind, t.status),
  ],
);

/**
 * One week of demand for one resource type. Derived rows keep the activity
 * that produced them, so a peak is always traceable back to the programme
 * rather than being an unexplained bar on a chart.
 */
export const resourceDemands = pgTable(
  "resource_demands",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    planId: text("plan_id").notNull(),
    resourceTypeId: text("resource_type_id").notNull(),
    /** ISO date of the Monday (or configured week start) this row is bucketed to */
    weekStart: text("week_start").notNull(),
    demandHours: doublePrecision("demand_hours").default(0).notNull(),
    /** hours ÷ (standardHoursPerDay × working days); null when either is unknown */
    headcount: doublePrecision("headcount"),
    source: text("source").default("manual").notNull(), // ResourceDemandSource
    /** schedule_tasks.id when derived */
    sourceTaskId: text("source_task_id"),
    sourceScheduleId: text("source_schedule_id"),
    /** the arithmetic, in words, for the row's tooltip */
    basis: text("basis"),
    locationId: text("location_id"),
    crewId: text("crew_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("resource_demands_plan_idx").on(t.planId, t.weekStart),
    index("resource_demands_type_idx").on(t.planId, t.resourceTypeId, t.weekStart),
    index("resource_demands_project_idx").on(t.projectId, t.weekStart),
    index("resource_demands_task_idx").on(t.sourceTaskId),
  ],
);

/* ================================================================== */
/* Supply: what we can actually field                                  */
/* ================================================================== */

/**
 * One week of stated supply for one resource type. One row per
 * (project, type, week) — a second statement replaces the first rather than
 * adding to it, because two half-remembered availability figures for the same
 * week silently double the supply on the histogram.
 */
export const resourceAvailability = pgTable(
  "resource_availability",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    resourceTypeId: text("resource_type_id").notNull(),
    weekStart: text("week_start").notNull(),
    availableHours: doublePrecision("available_hours").default(0).notNull(),
    availableHeadcount: doublePrecision("available_headcount"),
    source: text("source").default("manual").notNull(), // ResourceAvailabilitySource
    /** the sub who committed the people, when the source is a commitment */
    vendorId: text("vendor_id"),
    commitmentId: text("commitment_id"),
    note: text("note"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("resource_availability_uq").on(t.projectId, t.resourceTypeId, t.weekStart),
    index("resource_availability_project_idx").on(t.projectId, t.weekStart),
    index("resource_availability_type_idx").on(t.resourceTypeId, t.weekStart),
  ],
);

/* ================================================================== */
/* The calendar: who is booked, on what, when                          */
/* ================================================================== */

/**
 * A crew, a worker or a machine booked to a task or a location between two
 * dates. `subjectKind` says which of the three id columns is set; the API
 * refuses a row where that does not hold, because a booking nobody can
 * attribute to a resource cannot conflict with anything and is therefore
 * invisible exactly when it matters.
 */
export const resourceAssignments = pgTable(
  "resource_assignments",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    resourceTypeId: text("resource_type_id"),
    subjectKind: text("subject_kind").notNull(), // ResourceSubjectKind
    /** exactly one of the three is set, matching subjectKind */
    crewId: text("crew_id"),
    workerId: text("worker_id"),
    equipmentId: text("equipment_id"),
    /** denormalised name so a calendar renders without three joins */
    subjectLabel: text("subject_label").notNull(),
    scheduleTaskId: text("schedule_task_id"),
    scheduleId: text("schedule_id"),
    locationId: text("location_id"),
    /** inclusive ISO dates */
    fromDate: text("from_date").notNull(),
    toDate: text("to_date").notNull(),
    shift: text("shift").default("day").notNull(), // Shift
    hoursPerDay: doublePrecision("hours_per_day"),
    /** how much of the resource this booking takes; two 50% bookings do not conflict */
    allocationPercent: doublePrecision("allocation_percent").default(100).notNull(),
    /** hoursPerDay × working days in the window; null when hoursPerDay is unknown */
    plannedHours: doublePrecision("planned_hours"),
    status: text("status").default("planned").notNull(), // ResourceAssignmentStatus
    confirmedBy: text("confirmed_by"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "string" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    cancelledReason: text("cancelled_reason"),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("resource_assignments_uq").on(t.projectId, t.number),
    index("resource_assignments_project_idx").on(t.projectId, t.status, t.fromDate),
    index("resource_assignments_window_idx").on(t.projectId, t.fromDate, t.toDate),
    index("resource_assignments_crew_idx").on(t.crewId, t.fromDate),
    index("resource_assignments_worker_idx").on(t.workerId, t.fromDate),
    index("resource_assignments_equipment_idx").on(t.equipmentId, t.fromDate),
    index("resource_assignments_task_idx").on(t.scheduleTaskId),
  ],
);

/* ================================================================== */
/* Measurement: hours bought against hours earned                      */
/* ================================================================== */

/**
 * A productivity figure as it stood on the day it was taken. See the file
 * header: the live engine recomputes from current timecards, so without a
 * snapshot the trend rewrites itself every time an old card is corrected, and
 * the measured-mile window a claim rests on cannot be evidenced.
 */
export const resourceProductivitySnapshots = pgTable(
  "resource_productivity_snapshots",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    periodStart: text("period_start").notNull(), // ISO date
    periodEnd: text("period_end").notNull(),
    /** set when the row is one week of a series rather than a whole window */
    weekStart: text("week_start"),
    scope: text("scope").default("project").notNull(), // ProductivityScope
    /** resourceTypeId / crewId / budgetLineItemId, null for scope=project */
    scopeId: text("scope_id"),
    scopeLabel: text("scope_label"),
    actualHours: doublePrecision("actual_hours").default(0).notNull(),
    /** null when any contributing line could not be earned — never a partial sum */
    earnedHours: doublePrecision("earned_hours"),
    productivityFactor: doublePrecision("productivity_factor"),
    installedQuantity: doublePrecision("installed_quantity"),
    unit: text("unit"),
    achievedUnitRate: doublePrecision("achieved_unit_rate"),
    plannedUnitRate: doublePrecision("planned_unit_rate"),
    linesMeasured: integer("lines_measured").default(0).notNull(),
    linesUnmeasurable: integer("lines_unmeasurable").default(0).notNull(),
    reasons: jsonb("reasons").$type<string[]>().default([]).notNull(),
    basis: text("basis"),
    /** null when the scheduler took it (system actor) */
    capturedBy: text("captured_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("resource_prod_snapshots_project_idx").on(t.projectId, t.periodEnd),
    index("resource_prod_snapshots_scope_idx").on(t.projectId, t.scope, t.scopeId, t.periodEnd),
    index("resource_prod_snapshots_week_idx").on(t.projectId, t.weekStart),
  ],
);

/**
 * Forecast hours at completion, with the method and every input that produced
 * it. Kept rather than recomputed on demand so "what did we think in March"
 * survives, which is the only way a forecast can ever be shown to have been
 * optimistic.
 */
export const resourceForecasts = pgTable(
  "resource_forecasts",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    /** null = the whole project's labour */
    resourceTypeId: text("resource_type_id"),
    asOfDate: text("as_of_date").notNull(), // ISO date
    method: text("method").default("productivity_factor").notNull(), // HoursForecastMethod
    budgetHours: doublePrecision("budget_hours"),
    actualHours: doublePrecision("actual_hours").default(0).notNull(),
    earnedHours: doublePrecision("earned_hours"),
    productivityFactor: doublePrecision("productivity_factor"),
    percentComplete: doublePrecision("percent_complete"),
    remainingHours: doublePrecision("remaining_hours"),
    forecastHoursAtCompletion: doublePrecision("forecast_hours_at_completion"),
    /** forecast − budget; positive is an overrun */
    varianceHours: doublePrecision("variance_hours"),
    confidence: text("confidence"), // ForecastConfidence
    basis: text("basis"),
    reasons: jsonb("reasons").$type<string[]>().default([]).notNull(),
    inputs: jsonb("inputs").$type<Record<string, unknown>>().default({}).notNull(),
    /** null when the scheduler took it */
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("resource_forecasts_project_idx").on(t.projectId, t.asOfDate),
    index("resource_forecasts_type_idx").on(t.projectId, t.resourceTypeId, t.asOfDate),
  ],
);

/* ================================================================== */
/* Skills and certifications                                           */
/* ================================================================== */

/**
 * A company-level skill, certification, licence or training course. Only
 * categories with a `validityMonths` participate in the expiry sweep — a
 * skill somebody simply has does not lapse, and treating it as though it did
 * fills the register with noise that trains people to ignore real expiries.
 */
export const resourceSkills = pgTable(
  "resource_skills",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category").default("skill").notNull(), // SkillCategory
    trade: text("trade"),
    issuingBody: text("issuing_body"),
    /** null = does not expire */
    validityMonths: integer("validity_months"),
    /** 1 = a certificate reference is required before the cell can be verified */
    requiresEvidence: integer("requires_evidence").default(0).notNull(),
    /** 1 = work cannot proceed without it; drives the assignment gap check */
    isMandatory: integer("is_mandatory").default(0).notNull(),
    status: text("status").default("active").notNull(), // ResourceTypeStatus
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("resource_skills_uq").on(t.companyId, t.code),
    index("resource_skills_company_idx").on(t.companyId, t.category, t.status),
  ],
);

/**
 * One cell of the skills matrix: this worker holds this skill. `status` is
 * the EVIDENCE state (did anybody check?) and `expiresAt` is the VALIDITY
 * state (is it still good?). They are independent — a verified certificate
 * expires like any other — and conflating them is how an expired ticket keeps
 * a green tick on a matrix.
 */
export const workerSkills = pgTable(
  "worker_skills",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    /** workforce.workers.id — the register, never a second person table */
    workerId: text("worker_id").notNull(),
    skillId: text("skill_id").notNull(),
    level: text("level").default("competent").notNull(), // SkillLevel
    status: text("status").default("claimed").notNull(), // WorkerSkillStatus
    certificateRef: text("certificate_ref"),
    issuingBody: text("issuing_body"),
    issuedAt: text("issued_at"), // ISO date
    expiresAt: text("expires_at"), // ISO date; null = no expiry recorded
    /** verification is a separate act by a separate person from the claim */
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    rejectedReason: text("rejected_reason"),
    evidenceFileIds: jsonb("evidence_file_ids").$type<string[]>().default([]).notNull(),
    source: text("source").default("manual").notNull(),
    /** the last expiry warning already sent, so the sweep stays idempotent */
    expiryNotifiedAt: timestamp("expiry_notified_at", { withTimezone: true, mode: "string" }),
    expiryNotifiedForDate: text("expiry_notified_for_date"),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("worker_skills_uq").on(t.workerId, t.skillId),
    index("worker_skills_project_idx").on(t.projectId, t.skillId),
    index("worker_skills_expiry_idx").on(t.companyId, t.expiresAt),
    index("worker_skills_worker_idx").on(t.projectId, t.workerId),
  ],
);
