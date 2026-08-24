import {
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
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("report_schedules_report_idx").on(t.reportId)],
);
