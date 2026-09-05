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
 * Native schedule core (spec Vol I §2.6 subset) — the substrate for the
 * delay-forensics module. Dates are computed by the CPM engine
 * (apps/api/src/lib/cpm.ts) from durations, dependencies, constraints and
 * actuals; computed fields are persisted after each recompute so lists and
 * forensic comparisons never need a live CPM pass.
 */
export const schedules = pgTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    projectStart: text("project_start").notNull(), // ISO date, CPM day 0
    isActive: integer("is_active").default(1).notNull(),
    /**
     * Progress data date (P6 "data date" / MSP status date): work before it is
     * actual, work after it is forecast. Null = the schedule has never been
     * statused and every date is planned.
     */
    dataDate: text("data_date"),
    /** provenance: native | xer | mspdi (ScheduleSource) */
    source: text("source").default("native").notNull(),
    /** monotonic revision number within a revision family (#357) */
    revision: integer("revision").default(1).notNull(),
    /** the schedule this one is a revision of — the family root has null */
    parentScheduleId: text("parent_schedule_id"),
    /** default work calendar for tasks that name none */
    defaultCalendarId: text("default_calendar_id"),
    /** identity in the source file (P6 proj_short_name / MSPDI Project/UID) */
    externalRef: text("external_ref"),
    /** stamped on every recompute */
    computedFinish: text("computed_finish"),
    computedDurationDays: integer("computed_duration_days"),
    lastComputedAt: timestamp("last_computed_at", { withTimezone: true, mode: "string" }),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("schedules_project_idx").on(t.projectId),
    index("schedules_company_idx").on(t.companyId),
    index("schedules_parent_idx").on(t.parentScheduleId),
  ],
);

export const scheduleTasks = pgTable(
  "schedule_tasks",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    wbsCode: text("wbs_code"),
    /** materialised WBS path from the source file, e.g. "1.2.3" */
    wbsPath: text("wbs_path"),
    durationDays: integer("duration_days").default(1).notNull(), // 0 = milestone
    /**
     * Work left after the data date. Null = not statused; the engine then
     * derives it from duration and percentComplete.
     */
    remainingDurationDays: integer("remaining_duration_days"),
    /** ScheduleTaskType — milestones and LOE are excluded from DCMA duration checks */
    taskType: text("task_type").default("task").notNull(),
    /** work calendar; null falls back to the schedule default */
    calendarId: text("calendar_id"),
    /** identity in the source file (P6 task_code / MSPDI Task/UID) */
    externalId: text("external_id"),
    /** contractual/target date for a key milestone (#362 slip tracking) */
    contractualDate: text("contractual_date"),
    isKeyMilestone: integer("is_key_milestone").default(0).notNull(),
    /** slip already notified at this many days — keeps the sweep idempotent */
    slipAlertedDays: integer("slip_alerted_days"),
    slipAlertedAt: timestamp("slip_alerted_at", { withTimezone: true, mode: "string" }),
    /** budget line this activity earns against (earned value) */
    budgetLineItemId: text("budget_line_item_id"),
    /** planned cost of the activity when no budget line is mapped */
    budgetedCost: doublePrecision("budgeted_cost"),
    /** planned labour hours (measured-mile / EV disruption input) */
    budgetedHours: doublePrecision("budgeted_hours"),
    notes: text("notes"),
    constraintType: text("constraint_type"), // TaskConstraintType
    constraintDate: text("constraint_date"),
    actualStart: text("actual_start"),
    actualFinish: text("actual_finish"),
    percentComplete: doublePrecision("percent_complete").default(0).notNull(),
    responsibleId: text("responsible_id"),
    locationId: text("location_id"),
    sortOrder: integer("sort_order").default(0).notNull(),
    /* computed by CPM, persisted */
    startDate: text("start_date"),
    finishDate: text("finish_date"),
    totalFloat: integer("total_float"),
    isCritical: integer("is_critical").default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("schedule_tasks_schedule_idx").on(t.scheduleId, t.sortOrder),
    index("schedule_tasks_project_idx").on(t.projectId),
    index("schedule_tasks_external_idx").on(t.scheduleId, t.externalId),
    index("schedule_tasks_milestone_idx").on(t.projectId, t.isKeyMilestone),
    index("schedule_tasks_budget_line_idx").on(t.budgetLineItemId),
  ],
);

export const scheduleDependencies = pgTable(
  "schedule_dependencies",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id").notNull(),
    predecessorId: text("predecessor_id").notNull(),
    successorId: text("successor_id").notNull(),
    depType: text("dep_type").default("FS").notNull(), // DependencyType
    lagDays: integer("lag_days").default(0).notNull(),
  },
  (t) => [
    uniqueIndex("schedule_deps_uq").on(t.predecessorId, t.successorId, t.depType),
    index("schedule_deps_schedule_idx").on(t.scheduleId),
  ],
);

/**
 * Baseline: an immutable snapshot of every task's computed dates at capture
 * time (spec Vol I #355-357) — the as-planned record that forensic
 * comparisons run against. `snapshot` rows:
 * { taskId, name, wbsCode, durationDays, startDate, finishDate, totalFloat,
 *   isCritical }.
 */
export const scheduleBaselines = pgTable(
  "schedule_baselines",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    projectStart: text("project_start").notNull(),
    computedFinish: text("computed_finish"),
    snapshot: jsonb("snapshot").$type<unknown[]>().notNull(),
    capturedBy: text("captured_by").notNull(),
    capturedAt: createdAt(),
  },
  (t) => [index("schedule_baselines_schedule_idx").on(t.scheduleId)],
);

/* ================================================================== */
/* WP-SCHED — platform upgrade wave                                    */
/*                                                                     */
/* Adds the substrate the upgraded schedule module needs: work         */
/* calendars (imported from P6/MSP or authored natively), resource     */
/* loading (#370), a lookahead constraints log (#359), update          */
/* narratives, and an import/revision record so a P6 XER or MSPDI      */
/* file lands as a diffable revision rather than an opaque overwrite   */
/* (#349-350, #357).                                                   */
/* ================================================================== */

/**
 * A work calendar: which weekdays are workdays, which dates are holidays,
 * and how many hours a workday holds (used to convert P6 hour durations to
 * days). `workdays` is a 7-slot array indexed by JS getUTCDay() — index 0 is
 * Sunday — holding 1 for a workday and 0 for a non-workday.
 */
export const scheduleCalendars = pgTable(
  "schedule_calendars",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    /** null = a company/project-level calendar available to every schedule */
    scheduleId: text("schedule_id"),
    name: text("name").notNull(),
    /** identity in the source file (P6 clndr_id, MSPDI Calendar/UID) */
    externalId: text("external_id"),
    workdays: jsonb("workdays").$type<number[]>().default([0, 1, 1, 1, 1, 1, 0]).notNull(),
    /** ISO dates that are non-working regardless of weekday */
    holidays: jsonb("holidays").$type<string[]>().default([]).notNull(),
    /** exceptions that ADD a working day (e.g. a worked Saturday) */
    exceptions: jsonb("exceptions").$type<string[]>().default([]).notNull(),
    hoursPerDay: doublePrecision("hours_per_day").default(8).notNull(),
    isDefault: integer("is_default").default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("schedule_calendars_project_idx").on(t.projectId),
    index("schedule_calendars_schedule_idx").on(t.scheduleId),
    index("schedule_calendars_company_idx").on(t.companyId),
  ],
);

/**
 * Resource assignment on an activity (#370). Budgeted units are the planned
 * quantity (labour hours, plant hours, material quantity); actual units are
 * what has been booked. Cost columns let the earned-value engine work from
 * the schedule alone when no budget line is mapped.
 */
export const scheduleTaskResources = pgTable(
  "schedule_task_resources",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    scheduleId: text("schedule_id").notNull(),
    taskId: text("task_id").notNull(),
    name: text("name").notNull(),
    resourceType: text("resource_type").default("labour").notNull(), // ScheduleResourceType
    /** identity in the source file (P6 rsrc_id) */
    externalId: text("external_id"),
    unit: text("unit"),
    budgetedUnits: doublePrecision("budgeted_units").default(0).notNull(),
    actualUnits: doublePrecision("actual_units").default(0).notNull(),
    remainingUnits: doublePrecision("remaining_units"),
    unitRate: doublePrecision("unit_rate"),
    budgetedCost: doublePrecision("budgeted_cost").default(0).notNull(),
    actualCost: doublePrecision("actual_cost").default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("schedule_task_resources_task_idx").on(t.taskId),
    index("schedule_task_resources_schedule_idx").on(t.scheduleId),
    index("schedule_task_resources_project_idx").on(t.projectId),
  ],
);

/**
 * Lookahead constraints log (#359) — the make-ready register. A constraint is
 * a reason a task in the lookahead window cannot start, owned by someone,
 * needed by a date. Overdue open constraints are what the sweep escalates.
 */
export const scheduleConstraints = pgTable(
  "schedule_constraints",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    scheduleId: text("schedule_id").notNull(),
    taskId: text("task_id"),
    number: integer("number").notNull(),
    description: text("description").notNull(),
    category: text("category").default("other").notNull(), // ConstraintLogCategory
    status: text("status").default("open").notNull(), // ConstraintLogStatus
    ownerId: text("owner_id"),
    needByDate: text("need_by_date"), // ISO date
    clearedAt: timestamp("cleared_at", { withTimezone: true, mode: "string" }),
    clearedBy: text("cleared_by"),
    resolution: text("resolution"),
    /** stamped by the sweep so an escalation is raised once, not per tick */
    escalatedAt: timestamp("escalated_at", { withTimezone: true, mode: "string" }),
    raisedBy: text("raised_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("schedule_constraints_uq").on(t.projectId, t.number),
    index("schedule_constraints_schedule_idx").on(t.scheduleId, t.status),
    index("schedule_constraints_need_by_idx").on(t.status, t.needByDate),
    index("schedule_constraints_task_idx").on(t.taskId),
  ],
);

/**
 * Schedule update narrative — the written explanation that accompanies a
 * progress update or a revision. Kept as rows (not a column) because a
 * programme accumulates one per update period and each must stay attributable.
 */
export const scheduleNarratives = pgTable(
  "schedule_narratives",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    scheduleId: text("schedule_id").notNull(),
    title: text("title").notNull(),
    /** the update period this narrative describes */
    periodStart: text("period_start"),
    periodEnd: text("period_end"),
    dataDate: text("data_date"),
    body: text("body").notNull(),
    /** computed figures quoted in the narrative, for later audit */
    metrics: jsonb("metrics").$type<Record<string, unknown>>(),
    authorId: text("author_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("schedule_narratives_schedule_idx").on(t.scheduleId, t.createdAt)],
);

/**
 * An import run (#349-350). Records provenance (format, file name, byte size,
 * digest), what was created, and the revision diff against the target
 * schedule so "what changed between revision 4 and 5" survives the import.
 */
export const scheduleImports = pgTable(
  "schedule_imports",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    /** the schedule the import created (or updated) */
    scheduleId: text("schedule_id"),
    /** the schedule the import was diffed against, when a revision */
    targetScheduleId: text("target_schedule_id"),
    format: text("format").notNull(), // ScheduleFileFormat
    fileName: text("file_name").notNull(),
    byteSize: integer("byte_size").default(0).notNull(),
    sha256: text("sha256"),
    /** { tasks, dependencies, calendars, resources, warnings } */
    stats: jsonb("stats").$type<Record<string, unknown>>().default({}).notNull(),
    /** revision diff: added/removed/duration/logic/date changes */
    diff: jsonb("diff").$type<Record<string, unknown>>(),
    warnings: jsonb("warnings").$type<string[]>().default([]).notNull(),
    importedBy: text("imported_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("schedule_imports_project_idx").on(t.projectId, t.createdAt),
    index("schedule_imports_schedule_idx").on(t.scheduleId),
  ],
);
