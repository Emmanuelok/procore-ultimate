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
    /** stamped on every recompute */
    computedFinish: text("computed_finish"),
    computedDurationDays: integer("computed_duration_days"),
    lastComputedAt: timestamp("last_computed_at", { withTimezone: true, mode: "string" }),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("schedules_project_idx").on(t.projectId)],
);

export const scheduleTasks = pgTable(
  "schedule_tasks",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    wbsCode: text("wbs_code"),
    durationDays: integer("duration_days").default(1).notNull(), // 0 = milestone
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
