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

/** A BIM model (discipline model). Versions hang off it. */
export const bimModels = pgTable(
  "bim_models",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    discipline: text("discipline").default("other").notNull(),
    format: text("format").notNull(), // ModelFormat
    currentVersionId: text("current_version_id"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("bim_models_project_idx").on(t.projectId)],
);

export const bimModelVersions = pgTable(
  "bim_model_versions",
  {
    id: text("id").primaryKey(),
    modelId: text("model_id").notNull(),
    version: integer("version").notNull(),
    fileId: text("file_id").notNull(),
    /** ISO 19650 CDE state + suitability code */
    cdeState: text("cde_state").default("wip").notNull(), // CdeState
    suitability: text("suitability").default("S0").notNull(), // SuitabilityCode
    /** element extraction status */
    processing: text("processing").default("pending").notNull(), // pending | processing | ready | failed
    elementCount: integer("element_count").default(0).notNull(),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("bim_model_versions_uq").on(t.modelId, t.version)],
);

/**
 * Extracted model elements (from IFC). `globalId` is the IFC GUID — the
 * persistent identifier that survives re-export and lets assets, issues and
 * sensors bind to geometry.
 */
export const bimElements = pgTable(
  "bim_elements",
  {
    id: text("id").primaryKey(),
    modelVersionId: text("model_version_id").notNull(),
    projectId: text("project_id").notNull(),
    globalId: text("global_id").notNull(),
    ifcType: text("ifc_type").notNull(), // e.g. IfcWall, IfcDoor
    name: text("name"),
    /** flattened property sets */
    properties: jsonb("properties").$type<Record<string, unknown>>().default({}).notNull(),
    /** classification code (Uniclass / Omniclass / MasterFormat) if mapped */
    classification: text("classification"),
    locationId: text("location_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("bim_elements_version_idx").on(t.modelVersionId),
    index("bim_elements_global_idx").on(t.projectId, t.globalId),
    index("bim_elements_type_idx").on(t.modelVersionId, t.ifcType),
  ],
);

/** Federation: a named group of model versions viewed together. */
export const federationGroups = pgTable(
  "federation_groups",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("federation_groups_project_idx").on(t.projectId)],
);

export const federationMembers = pgTable(
  "federation_members",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id").notNull(),
    modelVersionId: text("model_version_id").notNull(),
    /** transform applied when federating (translation/rotation), optional */
    transform: jsonb("transform"),
  },
  (t) => [uniqueIndex("federation_members_uq").on(t.groupId, t.modelVersionId)],
);

/** Coordination / clash issues raised against model elements or drawings. */
export const coordinationIssues = pgTable(
  "coordination_issues",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").default("open").notNull(), // CoordinationIssueStatus
    discipline: text("discipline"),
    assigneeId: text("assignee_id"),
    dueDate: text("due_date"),
    /** IFC GUIDs of involved elements */
    elementGlobalIds: jsonb("element_global_ids").$type<string[]>().default([]).notNull(),
    modelVersionId: text("model_version_id"),
    /** camera viewpoint for restoring the view (BCF-style) */
    viewpoint: jsonb("viewpoint"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("coordination_issues_uq").on(t.projectId, t.number),
    index("coordination_issues_project_idx").on(t.projectId),
  ],
);
