import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();

/**
 * Cross-tool reporting & dashboards (spec Vol I §6.1-6.2).
 * Report definitions are declarative and executed by a whitelisted query
 * builder (apps/api/src/modules/analytics/) — never raw SQL from user input.
 * A definition names a dataset, the columns to project, filters, grouping and
 * aggregation; execution enforces company/project scope regardless of what
 * the definition asks for.
 */
export const reportDefinitions = pgTable(
  "report_definitions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = company-wide report across projects */
    projectId: text("project_id"),
    name: text("name").notNull(),
    description: text("description"),
    dataset: text("dataset").notNull(), // ReportDataset
    /** column keys to project, in order */
    columns: jsonb("columns").$type<string[]>().default([]).notNull(),
    /** [{ field, operator: ReportFilterOperator, value }] */
    filters: jsonb("filters").$type<unknown[]>().default([]).notNull(),
    groupBy: text("group_by"),
    /** [{ field, fn: ReportAggregation, alias }] */
    aggregations: jsonb("aggregations").$type<unknown[]>().default([]).notNull(),
    sortBy: text("sort_by"),
    sortDir: text("sort_dir").default("desc").notNull(),
    limitRows: integer("limit_rows").default(500).notNull(),
    isShared: integer("is_shared").default(0).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("report_definitions_company_idx").on(t.companyId)],
);

/** Saved dashboards composed of widgets bound to report definitions. */
export const dashboards = pgTable(
  "dashboards",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    name: text("name").notNull(),
    /** role this dashboard is prebuilt for (#741): pm | commercial | owner | assurance */
    audience: text("audience"),
    /** [{ id, kind: WidgetKind, title, reportId?, metric?, span }] */
    widgets: jsonb("widgets").$type<unknown[]>().default([]).notNull(),
    isDefault: integer("is_default").default(0).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("dashboards_company_idx").on(t.companyId)],
);

/** Scheduled report delivery (#736). */
export const reportSchedules = pgTable(
  "report_schedules",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id").notNull(),
    companyId: text("company_id").notNull(),
    /** daily | weekly | monthly */
    cadence: text("cadence").notNull(),
    /** 0-6 for weekly, 1-28 for monthly */
    dayOfPeriod: integer("day_of_period"),
    recipients: jsonb("recipients").$type<string[]>().default([]).notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: "string" }),
    nextRunAt: text("next_run_at"),
    isActive: integer("is_active").default(1).notNull(),
    /* --- WP-ANALYTICS: delivery is real now, so its state is recorded --- */
    /** csv | json — what the delivery worker renders and attaches */
    format: text("format").default("csv").notNull(),
    /** outcome of the last delivery attempt: succeeded | failed | recorded */
    lastStatus: text("last_status"),
    lastError: text("last_error"),
    runCount: integer("run_count").default(0).notNull(),
    createdAt: createdAt(),
    createdBy: text("created_by").notNull(),
  },
  (t) => [
    index("report_schedules_report_idx").on(t.reportId),
    /** the delivery worker's only query: active schedules whose time has come */
    index("report_schedules_due_idx").on(t.isActive, t.nextRunAt),
  ],
);

/* ------------------------------------------------------------------ */
/* WP-ANALYTICS — platform upgrade wave                                */
/* ------------------------------------------------------------------ */

/**
 * One execution of a report, whether a person pressed "run", a schedule fell
 * due or the delivery worker rendered it (#736, #752).
 *
 * It exists for three reasons and each is load-bearing:
 *  1. A schedule that claims to deliver must leave evidence of what it sent,
 *     to whom, and whether the transport accepted it — `deliveryDispatched`
 *     is false whenever nothing left the building, mirroring lib/email.ts.
 *  2. `resultSummary` freezes the aggregate rows of the run, so a line widget
 *     can chart the same figure over time and "compare with last month" has
 *     something to compare against instead of re-running history.
 *  3. `scope` records the effective row-level-security scope the run executed
 *     under — the projects and the sensitivity classes the caller could see —
 *     so an export can be audited after the fact.
 */
export const reportRuns = pgTable(
  "report_runs",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    reportId: text("report_id").notNull(),
    /** null for a manual run */
    scheduleId: text("schedule_id"),
    /** manual | scheduled | dashboard */
    trigger: text("trigger").notNull(),
    /** succeeded | failed */
    status: text("status").notNull(),
    projectId: text("project_id"),
    rowCount: integer("row_count").default(0).notNull(),
    truncated: integer("truncated").default(0).notNull(),
    durationMs: integer("duration_ms").default(0).notNull(),
    /** aggregate rows (capped) frozen for trend and historical comparison */
    resultSummary: jsonb("result_summary").$type<unknown[]>().default([]).notNull(),
    /** { projectIds: string[]|null, hiddenColumns: string[], tool, format } */
    scope: jsonb("scope").$type<Record<string, unknown>>().default({}).notNull(),
    /** csv | json */
    format: text("format").default("csv").notNull(),
    /** recipients the delivery was attempted to */
    recipients: jsonb("recipients").$type<string[]>().default([]).notNull(),
    /** false whenever no transport accepted the message — never assumed true */
    deliveryDispatched: integer("delivery_dispatched").default(0).notNull(),
    deliveryReasons: jsonb("delivery_reasons").$type<string[]>().default([]).notNull(),
    error: text("error"),
    runBy: text("run_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("report_runs_company_idx").on(t.companyId, t.createdAt),
    index("report_runs_report_idx").on(t.reportId, t.createdAt),
    index("report_runs_schedule_idx").on(t.scheduleId),
  ],
);

/**
 * A stored predictive insight (#753-758): the probability that a project
 * overruns its cost or its programme, derived from benchmark distributions and
 * the project's own growth-to-date. Stored rather than computed on read so the
 * figure a decision was taken against can be produced later, with its basis.
 */
export const analyticsForecasts = pgTable(
  "analytics_forecasts",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    /** cost_overrun | schedule_overrun */
    kind: text("kind").notNull(),
    /** 0..1, or null when the platform does not hold the inputs */
    probability: doublePrecision("probability"),
    /** expected growth at P50 / P80 in %, null when not computable */
    p50Uplift: doublePrecision("p50_uplift"),
    p80Uplift: doublePrecision("p80_uplift"),
    /** the reference class the empirical distribution came from */
    referenceClass: text("reference_class"),
    sampleSize: integer("sample_size").default(0).notNull(),
    /** prose statement of what was read and what was assumed */
    basis: text("basis").notNull(),
    /** every figure the computation used, for audit */
    inputs: jsonb("inputs").$type<Record<string, unknown>>().default({}).notNull(),
    /** why probability is null; empty when a value was computed */
    reasons: jsonb("reasons").$type<string[]>().default([]).notNull(),
    computedBy: text("computed_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("analytics_forecasts_project_idx").on(t.projectId, t.kind, t.createdAt),
    index("analytics_forecasts_company_idx").on(t.companyId, t.kind),
  ],
);
