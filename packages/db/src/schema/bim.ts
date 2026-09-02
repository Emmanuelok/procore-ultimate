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
    processing: text("processing").default("pending").notNull(), // ModelProcessingState
    elementCount: integer("element_count").default(0).notNull(),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: createdAt(),
    /* WP-BIM: asynchronous ingestion + ISO 19650 authorisation */
    /** why extraction failed, surfaced on the version row instead of a log */
    processingError: text("processing_error"),
    /** set when the ingestion worker finished (successfully or not) */
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "string" }),
    /** stored file size, so the UI can explain why a big model was queued */
    sizeBytes: doublePrecision("size_bytes"),
    /** number of spatial-structure entities (site/building/storey/space) */
    spatialCount: integer("spatial_count").default(0).notNull(),
    /** who authorised shared -> published; never the uploader (#639-640) */
    authorisedBy: text("authorised_by"),
    authorisedAt: timestamp("authorised_at", { withTimezone: true, mode: "string" }),
    authorisationNote: text("authorisation_note"),
    /** model quality gate result computed at ingestion (#638) */
    qualityReport: jsonb("quality_report").$type<Record<string, unknown> | null>(),
  },
  (t) => [
    uniqueIndex("bim_model_versions_uq").on(t.modelId, t.version),
    index("bim_model_versions_processing_idx").on(t.processing),
  ],
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
    /* WP-BIM: property sets, spatial containment and placement extents */
    /** IfcRelDefinesByType type name, e.g. "Basic Wall:Interior - 100mm" */
    typeName: text("type_name"),
    /** the IfcBuildingStorey (or IfcSpace) name the element sits in (#248) */
    storey: text("storey"),
    /** GlobalId of the spatial container, kept for re-linking after re-import */
    spatialGlobalId: text("spatial_global_id"),
    /** sha of name + type + classification + properties: drives version diffs */
    propertyHash: text("property_hash"),
    /** axis-aligned bounding box in project units (metres); null when unknown */
    minX: doublePrecision("min_x"),
    minY: doublePrecision("min_y"),
    minZ: doublePrecision("min_z"),
    maxX: doublePrecision("max_x"),
    maxY: doublePrecision("max_y"),
    maxZ: doublePrecision("max_z"),
  },
  (t) => [
    index("bim_elements_version_idx").on(t.modelVersionId),
    index("bim_elements_location_idx").on(t.locationId),
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
    /* WP-BIM: escalation, provenance and SLA tracking */
    /** the RFI this issue was escalated into (#469) */
    rfiId: text("rfi_id"),
    /** the clash result the issue was raised from, when auto-created (#240) */
    clashResultId: text("clash_result_id"),
    /** manual | clash | viewer | design_review */
    source: text("source").default("manual").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    /** set by the overdue sweep so an SLA breach notifies once, not hourly */
    overdueNotifiedAt: timestamp("overdue_notified_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    uniqueIndex("coordination_issues_uq").on(t.projectId, t.number),
    index("coordination_issues_project_idx").on(t.projectId),
    index("coordination_issues_status_idx").on(t.projectId, t.status, t.dueDate),
    index("coordination_issues_assignee_idx").on(t.projectId, t.assigneeId),
  ],
);

/* ==================================================================== */
/* WP-BIM — platform upgrade wave                                       */
/*                                                                      */
/* Version comparison (#236), clash detection (#240), 4D/5D element     */
/* links (#238-239), coordination comments and RFI escalation (#469),   */
/* reality capture overlays (#246) and project geofences (#471-478).    */
/* ==================================================================== */

/**
 * Stored diff between two versions of the same model (#236). Recomputing a
 * diff is deterministic, so the row is a cache keyed on the ordered pair;
 * `sample*` columns hold a bounded preview so the register renders without
 * re-reading both element tables.
 */
export const bimVersionDiffs = pgTable(
  "bim_version_diffs",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    modelId: text("model_id").notNull(),
    baseVersionId: text("base_version_id").notNull(),
    targetVersionId: text("target_version_id").notNull(),
    addedCount: integer("added_count").default(0).notNull(),
    removedCount: integer("removed_count").default(0).notNull(),
    modifiedCount: integer("modified_count").default(0).notNull(),
    unchangedCount: integer("unchanged_count").default(0).notNull(),
    /** per IfcType counts: { IFCWALL: { added, removed, modified } } */
    byType: jsonb("by_type")
      .$type<Record<string, { added: number; removed: number; modified: number }>>()
      .default({})
      .notNull(),
    /** bounded previews (max 500 each) so the UI never loads the full sets */
    sampleAdded: jsonb("sample_added").$type<unknown[]>().default([]).notNull(),
    sampleRemoved: jsonb("sample_removed").$type<unknown[]>().default([]).notNull(),
    sampleModified: jsonb("sample_modified").$type<unknown[]>().default([]).notNull(),
    computedBy: text("computed_by"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("bim_version_diffs_uq").on(t.baseVersionId, t.targetVersionId),
    index("bim_version_diffs_model_idx").on(t.projectId, t.modelId),
  ],
);

/**
 * A named clash test over a federation (#240): which elements are paired,
 * with what tolerance and clearance. Re-running the test refreshes
 * `clash_results` in place so resolution is tracked over time.
 */
export const clashTests = pgTable(
  "clash_tests",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    federationId: text("federation_id"),
    name: text("name").notNull(),
    ruleKind: text("rule_kind").default("discipline_pair").notNull(), // ClashRuleKind
    /** left/right selectors: disciplines and/or IfcType prefixes */
    leftFilter: jsonb("left_filter")
      .$type<{ disciplines?: string[]; ifcTypes?: string[]; modelVersionIds?: string[] }>()
      .default({})
      .notNull(),
    rightFilter: jsonb("right_filter")
      .$type<{ disciplines?: string[]; ifcTypes?: string[]; modelVersionIds?: string[] }>()
      .default({})
      .notNull(),
    /** hard-clash tolerance in millimetres — overlaps smaller than this are ignored */
    toleranceMm: doublePrecision("tolerance_mm").default(10).notNull(),
    /** required clear space in millimetres; 0 disables clearance checking */
    clearanceMm: doublePrecision("clearance_mm").default(0).notNull(),
    state: text("state").default("never_run").notNull(), // ClashTestState
    lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: "string" }),
    lastRunBy: text("last_run_by"),
    lastError: text("last_error"),
    /** { new, active, resolved, approved, ignored, comparedPairs, elementsLeft, elementsRight } */
    lastResult: jsonb("last_result").$type<Record<string, number>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("clash_tests_project_idx").on(t.projectId),
    index("clash_tests_federation_idx").on(t.federationId),
  ],
);

/** One interference between two elements, tracked across runs by fingerprint. */
export const clashResults = pgTable(
  "clash_results",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    testId: text("test_id").notNull(),
    /** sha of the ordered GlobalId pair — stable identity of the clash */
    fingerprint: text("fingerprint").notNull(),
    kind: text("kind").default("hard").notNull(), // ClashKind
    status: text("status").default("new").notNull(), // ClashStatus
    globalIdA: text("global_id_a").notNull(),
    nameA: text("name_a"),
    ifcTypeA: text("ifc_type_a"),
    modelVersionIdA: text("model_version_id_a"),
    disciplineA: text("discipline_a"),
    globalIdB: text("global_id_b").notNull(),
    nameB: text("name_b"),
    ifcTypeB: text("ifc_type_b"),
    modelVersionIdB: text("model_version_id_b"),
    disciplineB: text("discipline_b"),
    /** overlap extent of the two AABBs, millimetres */
    penetrationMm: doublePrecision("penetration_mm"),
    /** gap between the boxes when the clash is a clearance failure */
    distanceMm: doublePrecision("distance_mm"),
    overlapVolume: doublePrecision("overlap_volume"),
    centroid: jsonb("centroid").$type<{ x: number; y: number; z: number } | null>(),
    storey: text("storey"),
    issueId: text("issue_id"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: "string" }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "string" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
    reviewedBy: text("reviewed_by"),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("clash_results_uq").on(t.testId, t.fingerprint),
    index("clash_results_test_status_idx").on(t.testId, t.status),
    index("clash_results_project_idx").on(t.projectId, t.status),
  ],
);

/**
 * 4D (element → schedule task) and 5D (element → budget line) links
 * (#238-239). One row per element/target pair; `quantity` carries the
 * measured contribution when the link is used for progress or valuation.
 */
export const bimElementLinks = pgTable(
  "bim_element_links",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    linkType: text("link_type").notNull(), // ElementLinkType
    /** IFC GlobalId — survives re-export, unlike the element row id */
    globalId: text("global_id").notNull(),
    modelVersionId: text("model_version_id"),
    /** schedule_tasks.id or budget_line_items.id */
    targetId: text("target_id").notNull(),
    role: text("role").default("construct").notNull(), // ElementLinkRole
    quantity: doublePrecision("quantity"),
    unit: text("unit"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("bim_element_links_uq").on(t.projectId, t.linkType, t.targetId, t.globalId),
    index("bim_element_links_global_idx").on(t.projectId, t.globalId),
    index("bim_element_links_target_idx").on(t.projectId, t.linkType, t.targetId),
  ],
);

/** Threaded comments on a coordination issue (#241, #466). */
export const coordinationIssueComments = pgTable(
  "coordination_issue_comments",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    issueId: text("issue_id").notNull(),
    body: text("body").notNull(),
    mentions: jsonb("mentions").$type<string[]>().default([]).notNull(),
    authorId: text("author_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("coordination_issue_comments_issue_idx").on(t.issueId)],
);

/**
 * Reality capture records overlaid on the model (#246, Vol II Z #1076-1080):
 * scans, drone flights, 360 tours and their scan-vs-model deviation summary.
 */
export const realityCaptures = pgTable(
  "reality_captures",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    kind: text("kind").notNull(), // RealityCaptureKind
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").default("captured").notNull(), // RealityCaptureStatus
    capturedAt: text("captured_at"), // ISO date
    fileId: text("file_id"),
    /** the model version the capture is registered against */
    modelVersionId: text("model_version_id"),
    locationId: text("location_id"),
    /** registration transform / alignment metadata from the survey */
    alignment: jsonb("alignment").$type<Record<string, unknown> | null>(),
    coveragePercent: doublePrecision("coverage_percent"),
    /** scan-vs-model deviation summary: sampled points and tolerance */
    deviation: jsonb("deviation")
      .$type<{
        sampleCount: number;
        meanMm: number;
        maxMm: number;
        toleranceMm: number;
        withinTolerance: number;
      } | null>(),
    viewerUrl: text("viewer_url"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("reality_captures_project_idx").on(t.projectId, t.status),
    index("reality_captures_version_idx").on(t.modelVersionId),
  ],
);

/**
 * Project geofences (#471-475). `ring` is a closed GeoJSON-style polygon ring
 * of [longitude, latitude] pairs; containment is evaluated in process with a
 * ray-cast so no PostGIS dependency is introduced.
 */
export const geofences = pgTable(
  "geofences",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    purpose: text("purpose").default("work_zone").notNull(), // GeofencePurpose
    description: text("description"),
    ring: jsonb("ring").$type<Array<[number, number]>>().default([]).notNull(),
    colour: text("colour"),
    isActive: integer("is_active").default(1).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("geofences_project_idx").on(t.projectId, t.isActive)],
);
