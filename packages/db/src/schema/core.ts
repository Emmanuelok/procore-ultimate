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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("projects_company_idx").on(t.companyId)],
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
    uniqueIndex("cost_codes_uq").on(t.companyId, t.projectId, t.code),
    index("cost_codes_company_idx").on(t.companyId),
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
  (t) => [uniqueIndex("custom_field_defs_uq").on(t.companyId, t.projectId, t.tool, t.key)],
);

/** Custom field values, attached to any record by (type, id). */
export const customFieldValues = pgTable(
  "custom_field_values",
  {
    id: text("id").primaryKey(),
    fieldDefId: text("field_def_id").notNull(),
    recordType: text("record_type").notNull(),
    recordId: text("record_id").notNull(),
    value: jsonb("value"),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("custom_field_values_uq").on(t.fieldDefId, t.recordType, t.recordId),
    index("custom_field_values_record_idx").on(t.recordType, t.recordId),
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
  (t) => [index("comments_record_idx").on(t.recordType, t.recordId)],
);

/** Watchers / followers on records. */
export const watchers = pgTable(
  "watchers",
  {
    id: text("id").primaryKey(),
    recordType: text("record_type").notNull(),
    recordId: text("record_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("watchers_uq").on(t.recordType, t.recordId, t.userId),
    index("watchers_user_idx").on(t.userId),
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
