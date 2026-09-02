import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    name: text("name").notNull(),
    number: text("number"),
    stage: text("stage").default("pre_construction").notNull(), // ProjectStage
    type: text("type"),
    department: text("department"),
    address: text("address"),
    city: text("city"),
    country: text("country"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    startDate: text("start_date"), // ISO date
    finishDate: text("finish_date"),
    currency: text("currency").default("USD").notNull(),
    value: doublePrecision("value"),
    description: text("description"),
    settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
    /** Portfolio / programme grouping */
    portfolioId: text("portfolio_id"),
    isTemplate: integer("is_template").default(0).notNull(),
    /**
     * Vol I #6 — a sandbox project is a real project in a real tenant that is
     * excluded from portfolio roll-ups and marked in the shell, so a team can
     * rehearse a process without polluting the company's numbers.
     */
    isSandbox: integer("is_sandbox").default(0).notNull(),
    /** set when this project was cloned from another (template or live) */
    clonedFromId: text("cloned_from_id"),
    /**
     * Vol I #78 — soft delete. DELETE /projects/:id sets these; the project
     * disappears from every list and gate in this module and can be restored
     * from the recycle bin. A hard purge is a separate, explicit route that
     * refuses while a legal hold covers the project.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" }),
    deletedBy: text("deleted_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("projects_company_idx").on(t.companyId),
    index("projects_company_deleted_idx").on(t.companyId, t.deletedAt),
    index("projects_company_stage_idx").on(t.companyId, t.stage),
  ],
);

export const portfolios = pgTable(
  "portfolios",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    name: text("name").notNull(),
    /** programme grouping above portfolio */
    programme: text("programme"),
    createdAt: createdAt(),
  },
  (t) => [index("portfolios_company_idx").on(t.companyId)],
);

/** Hierarchical, multi-tier locations (building > level > zone > room). */
export const locations = pgTable(
  "locations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    parentId: text("parent_id"),
    name: text("name").notNull(),
    /** materialized path of ids for fast subtree queries, e.g. "a/b/c" */
    path: text("path").notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("locations_project_idx").on(t.projectId),
    index("locations_parent_idx").on(t.parentId),
  ],
);

/** Company-standard cost code list with project overrides. */
export const costCodes = pgTable(
  "cost_codes",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = company standard list; set = project-specific override/addition */
    projectId: text("project_id"),
    code: text("code").notNull(),
    title: text("title").notNull(),
    division: text("division"),
    costType: text("cost_type"), // CostType
    parentId: text("parent_id"),
    isActive: integer("is_active").default(1).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // NULLS NOT DISTINCT: `project_id` is null for the company-standard list,
    // and Postgres treats NULLs in a unique index as distinct — so before
    // this, two company-standard cost codes with the same code were accepted
    // by the database and only a racy check-then-insert stood in the way.
    unique("cost_codes_uq").on(t.companyId, t.projectId, t.code).nullsNotDistinct(),
    index("cost_codes_company_idx").on(t.companyId),
    index("cost_codes_parent_idx").on(t.parentId),
  ],
);

/** WBS segments (cost code, cost type, sub-job, custom) per project. */
export const wbsSegments = pgTable(
  "wbs_segments",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    segmentType: text("segment_type").notNull(), // cost_code | cost_type | sub_job | custom
    position: integer("position").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("wbs_segments_project_idx").on(t.projectId)],
);

/** Auto-increment record numbering per project + record type (e.g. RFI-0042). */
export const recordCounters = pgTable(
  "record_counters",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    recordType: text("record_type").notNull(),
    nextNumber: integer("next_number").default(1).notNull(),
  },
  (t) => [uniqueIndex("record_counters_uq").on(t.projectId, t.recordType)],
);

/** Cross-tool linking (RFI ↔ drawing ↔ submittal ↔ change event …). */
export const recordLinks = pgTable(
  "record_links",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    fromType: text("from_type").notNull(),
    fromId: text("from_id").notNull(),
    toType: text("to_type").notNull(),
    toId: text("to_id").notNull(),
    linkKind: text("link_kind").default("reference").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("record_links_from_idx").on(t.fromType, t.fromId),
    index("record_links_to_idx").on(t.toType, t.toId),
    index("record_links_project_idx").on(t.companyId, t.projectId),
  ],
);

/** Custom field definitions per tool (custom fieldsets). */
export const customFieldDefs = pgTable(
  "custom_field_defs",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"), // null = company-wide
    tool: text("tool").notNull(), // ToolKey
    key: text("key").notNull(),
    label: text("label").notNull(),
    fieldType: text("field_type").notNull(), // text|number|date|dropdown|multi_select|checkbox|currency|lookup
    options: jsonb("options").$type<string[]>().default([]).notNull(),
    required: integer("required").default(0).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("custom_field_defs_uq")
      .on(t.companyId, t.projectId, t.tool, t.key)
      .nullsNotDistinct(),
    index("custom_field_defs_company_idx").on(t.companyId, t.tool),
  ],
);

/** Custom field values, attached to any record by (type, id). */
export const customFieldValues = pgTable(
  "custom_field_values",
  {
    id: text("id").primaryKey(),
    /**
     * Tenant columns. Without them a value row was addressable by
     * (recordType, recordId) alone, so a caller holding a record id from
     * another tenant could read or write against it through a project they
     * DO have access to. Populated from the request on every write and
     * filtered on every read.
     */
    companyId: text("company_id").notNull().default(""),
    projectId: text("project_id"),
    fieldDefId: text("field_def_id").notNull(),
    recordType: text("record_type").notNull(),
    recordId: text("record_id").notNull(),
    value: jsonb("value"),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("custom_field_values_uq").on(t.fieldDefId, t.recordType, t.recordId),
    index("custom_field_values_record_idx").on(t.recordType, t.recordId),
    index("custom_field_values_scope_idx").on(t.companyId, t.projectId),
  ],
);

/** Comment/discussion threads on any record, with @mentions. */
export const comments = pgTable(
  "comments",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    recordType: text("record_type").notNull(),
    recordId: text("record_id").notNull(),
    authorId: text("author_id").notNull(),
    body: text("body").notNull(),
    mentions: jsonb("mentions").$type<string[]>().default([]).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("comments_record_idx").on(t.recordType, t.recordId),
    index("comments_project_idx").on(t.companyId, t.projectId),
  ],
);

/** Watchers / followers on records. */
export const watchers = pgTable(
  "watchers",
  {
    id: text("id").primaryKey(),
    /** see customFieldValues: (recordType, recordId) is not a tenant key. */
    companyId: text("company_id").notNull().default(""),
    projectId: text("project_id"),
    recordType: text("record_type").notNull(),
    recordId: text("record_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("watchers_uq").on(t.recordType, t.recordId, t.userId),
    index("watchers_user_idx").on(t.userId),
    index("watchers_scope_idx").on(t.companyId, t.projectId),
  ],
);

/** Tags, attachable to any record type. */
export const tags = pgTable(
  "tags",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    name: text("name").notNull(),
    color: text("color"),
  },
  (t) => [uniqueIndex("tags_uq").on(t.companyId, t.name)],
);

export const tagAssignments = pgTable(
  "tag_assignments",
  {
    id: text("id").primaryKey(),
    tagId: text("tag_id").notNull(),
    recordType: text("record_type").notNull(),
    recordId: text("record_id").notNull(),
  },
  (t) => [
    uniqueIndex("tag_assignments_uq").on(t.tagId, t.recordType, t.recordId),
    index("tag_assignments_record_idx").on(t.recordType, t.recordId),
  ],
);

/* ================================================================== */
/* Platform upgrade wave — WP-SUBSTRATE additions                      */
/* ================================================================== */

/**
 * Saved filter sets / views (Vol I #75, #148).
 *
 * A view is an opaque `state` blob owned by the page that produced it
 * (columns, filters, sort, grouping) plus the addressing that lets it be
 * found again: which table, whose it is, and whether it is shared. Server
 * side rather than localStorage so a filter survives a new device and can be
 * handed to a colleague.
 */
export const savedViews = pgTable(
  "saved_views",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = applies wherever the table appears; set = one project's table */
    projectId: text("project_id"),
    /** stable identifier of the table/register this view belongs to */
    tableId: text("table_id").notNull(),
    name: text("name").notNull(),
    scope: text("scope").default("private").notNull(), // SavedViewScope
    ownerId: text("owner_id").notNull(),
    /** true = the owner's default view for this table */
    isDefault: integer("is_default").default(0).notNull(),
    state: jsonb("state").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("saved_views_lookup_idx").on(t.companyId, t.tableId),
    index("saved_views_owner_idx").on(t.ownerId, t.tableId),
    uniqueIndex("saved_views_name_uq").on(t.companyId, t.tableId, t.ownerId, t.name),
  ],
);

/**
 * Bulk CSV import jobs (Vol I #77).
 *
 * Every import is a two-step: a PREVIEW that parses, validates and reports
 * row-level errors without writing anything, and a COMMIT that replays the
 * stored rows. The parsed rows and the report both live on the job so the
 * commit cannot silently act on a different file than the one reviewed.
 */
export const importJobs = pgTable(
  "import_jobs",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    dataset: text("dataset").notNull(), // ImportDataset
    status: text("status").default("preview").notNull(), // ImportJobStatus
    fileName: text("file_name"),
    rowCount: integer("row_count").default(0).notNull(),
    validCount: integer("valid_count").default(0).notNull(),
    errorCount: integer("error_count").default(0).notNull(),
    createdCount: integer("created_count").default(0).notNull(),
    updatedCount: integer("updated_count").default(0).notNull(),
    /** row-level findings: [{ row, field, message, severity }] */
    report: jsonb("report").$type<unknown[]>().default([]).notNull(),
    /** the parsed rows the commit will replay */
    rows: jsonb("rows").$type<unknown[]>().default([]).notNull(),
    createdBy: text("created_by").notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("import_jobs_company_idx").on(t.companyId, t.dataset),
    index("import_jobs_status_idx").on(t.companyId, t.status),
  ],
);
