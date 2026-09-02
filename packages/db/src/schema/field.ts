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
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

/**
 * Field tools — RFIs (§2.4), submittals (§2.5), daily logs (§2.7), punch
 * list (§2.8), photos (§2.10) and observations (§4.2). Platform-upgrade wave
 * additions are marked WP-FIELD inline; every hot filter carries an index.
 */

export const rfis = pgTable(
  "rfis",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    subject: text("subject").notNull(),
    question: text("question").notNull(),
    proposedSolution: text("proposed_solution"),
    status: text("status").default("draft").notNull(), // RfiStatus
    assigneeId: text("assignee_id"),
    ballInCourtId: text("ball_in_court_id"),
    distribution: jsonb("distribution").$type<string[]>().default([]).notNull(),
    dueDate: text("due_date"),
    officialResponse: text("official_response"),
    respondedBy: text("responded_by"),
    respondedAt: ts("responded_at"),
    costImpact: text("cost_impact").default("tbd").notNull(), // yes | no | tbd
    scheduleImpact: text("schedule_impact").default("tbd").notNull(), // yes | no | tbd
    scheduleImpactDays: integer("schedule_impact_days"),
    locationId: text("location_id"),
    /* WP-FIELD */
    /** when the RFI left draft — cycle time is measured from here (#322) */
    issuedAt: ts("issued_at"),
    /** private drafts are visible to the creator, the distribution and admins only (#325) */
    isPrivate: integer("is_private").default(0).notNull(),
    visibleTo: jsonb("visible_to").$type<string[]>().default([]).notNull(),
    /** prior RFIs this one references (#316) */
    relatedRfiIds: jsonb("related_rfi_ids").$type<string[]>().default([]).notNull(),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    /** manual | email | mcp | observation — RfiSource */
    source: text("source").default("manual").notNull(),
    /** for email ingestion: from, messageId, receivedAt (#324) */
    sourceMeta: jsonb("source_meta").$type<Record<string, unknown>>(),
    /** how many draft responses were adopted (audit convenience) */
    responseRevision: integer("response_revision").default(0).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("rfis_number_uq").on(t.projectId, t.number),
    index("rfis_project_idx").on(t.projectId),
    index("rfis_status_idx").on(t.projectId, t.status),
    index("rfis_company_project_idx").on(t.companyId, t.projectId),
    index("rfis_due_idx").on(t.projectId, t.status, t.dueDate),
    index("rfis_bic_idx").on(t.projectId, t.ballInCourtId),
  ],
);

/** Draft responses awaiting adoption as the official answer (spec #311). WP-FIELD */
export const rfiResponses = pgTable(
  "rfi_responses",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    rfiId: text("rfi_id").notNull(),
    body: text("body").notNull(),
    costImpact: text("cost_impact"),
    scheduleImpact: text("schedule_impact"),
    scheduleImpactDays: integer("schedule_impact_days"),
    status: text("status").default("draft").notNull(), // RfiResponseDraftStatus
    authorId: text("author_id").notNull(),
    adoptedBy: text("adopted_by"),
    adoptedAt: ts("adopted_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("rfi_responses_rfi_idx").on(t.rfiId, t.status),
    index("rfi_responses_project_idx").on(t.companyId, t.projectId),
  ],
);

export const submittals = pgTable(
  "submittals",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    revision: integer("revision").default(0).notNull(),
    title: text("title").notNull(),
    specSection: text("spec_section"),
    submittalType: text("submittal_type").default("other").notNull(), // SubmittalType
    status: text("status").default("draft").notNull(), // SubmittalStatusExtended
    ballInCourtId: text("ball_in_court_id"),
    requiredOnSite: text("required_on_site"),
    leadTimeDays: integer("lead_time_days"),
    /** computed: requiredOnSite - leadTime - review allowance */
    submitByDate: text("submit_by_date"),
    responseCode: text("response_code"), // SubmittalResponse
    respondedBy: text("responded_by"),
    respondedAt: ts("responded_at"),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    /** previous revision in the resubmittal chain */
    previousId: text("previous_id"),
    /* WP-FIELD */
    /** the revision that replaced this one; set atomically on resubmit (#340) */
    supersededById: text("superseded_by_id"),
    /** review allowance used for submitBy so it can be recomputed honestly (#337) */
    reviewAllowanceDays: integer("review_allowance_days"),
    /** when the submittal entered review — turnaround measures from here (#347) */
    submittedAt: ts("submitted_at"),
    closedAt: ts("closed_at"),
    /** user ids notified on the final response and on close (#345) */
    distribution: jsonb("distribution").$type<string[]>().default([]).notNull(),
    /** 1 when the type belongs to the closeout package (#348) */
    isCloseout: integer("is_closeout").default(0).notNull(),
    /** subcontractor/vendor responsible for producing the submittal */
    vendorId: text("vendor_id"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("submittals_uq").on(t.projectId, t.number, t.revision),
    index("submittals_project_idx").on(t.projectId),
    index("submittals_status_idx").on(t.projectId, t.status),
    index("submittals_submit_by_idx").on(t.projectId, t.status, t.submitByDate),
    index("submittals_bic_idx").on(t.projectId, t.ballInCourtId),
    index("submittals_previous_idx").on(t.previousId),
    index("submittals_spec_idx").on(t.projectId, t.specSection),
  ],
);

/** Sequential/parallel review chain per submittal. */
export const submittalReviewSteps = pgTable(
  "submittal_review_steps",
  {
    id: text("id").primaryKey(),
    submittalId: text("submittal_id").notNull(),
    position: integer("position").notNull(),
    reviewerId: text("reviewer_id").notNull(),
    isParallel: integer("is_parallel").default(0).notNull(),
    responseCode: text("response_code"),
    comments: text("comments"),
    respondedAt: ts("responded_at"),
    /* WP-FIELD */
    /** when this step's group became current — in-court ageing per reviewer (#347) */
    activatedAt: ts("activated_at"),
  },
  (t) => [
    index("submittal_review_steps_idx").on(t.submittalId, t.position),
    index("submittal_review_steps_reviewer_idx").on(t.reviewerId, t.responseCode),
  ],
);

/** Per-company configurable submittal response-code set (#334). WP-FIELD */
export const submittalResponseCodes = pgTable(
  "submittal_response_codes",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    code: text("code").notNull(),
    label: text("label").notNull(),
    isApproval: integer("is_approval").default(0).notNull(),
    isResubmit: integer("is_resubmit").default(0).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    isActive: integer("is_active").default(1).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("submittal_response_codes_uq").on(t.companyId, t.code)],
);

export const dailyLogs = pgTable(
  "daily_logs",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    logDate: text("log_date").notNull(), // ISO date
    status: text("status").default("draft").notNull(), // DailyLogStatus
    weather: jsonb("weather").$type<Record<string, unknown>>(),
    /** structured sections: manpower[], equipment[], deliveries[], visitors[], delays[], quantities[], inspections[], safetyViolations[], incidents[], waste[], calls[] */
    sections: jsonb("sections").$type<Record<string, unknown>>().default({}).notNull(),
    notes: text("notes"),
    photoFileIds: jsonb("photo_file_ids").$type<string[]>().default([]).notNull(),
    /** true when the draft was produced by the AI daily-log agent */
    aiDrafted: integer("ai_drafted").default(0).notNull(),
    /* WP-FIELD */
    /** internal | subcontractor — DailyLogKind (#396) */
    logKind: text("log_kind").default("internal").notNull(),
    /** the reporting subcontractor for a self-reported log */
    vendorId: text("vendor_id"),
    /** manual | auto — WeatherSource (#373) */
    weatherSource: text("weather_source"),
    weatherProvider: text("weather_provider"),
    weatherFetchedAt: ts("weather_fetched_at"),
    templateId: text("template_id"),
    submittedAt: ts("submitted_at"),
    approvedAt: ts("approved_at"),
    /** user ids the approved log was distributed to (#393) */
    distributedTo: jsonb("distributed_to").$type<string[]>().default([]).notNull(),
    createdBy: text("created_by").notNull(),
    approvedBy: text("approved_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("daily_logs_uq").on(t.projectId, t.logDate, t.createdBy),
    index("daily_logs_project_idx").on(t.projectId),
    index("daily_logs_date_idx").on(t.projectId, t.logDate),
    index("daily_logs_status_idx").on(t.projectId, t.status, t.logDate),
    index("daily_logs_company_idx").on(t.companyId, t.status),
  ],
);

/** Daily-log templates: default manpower/equipment rows applied on first save (#397). WP-FIELD */
export const dailyLogTemplates = pgTable(
  "daily_log_templates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    sections: jsonb("sections").$type<Record<string, unknown>>().default({}).notNull(),
    isDefault: integer("is_default").default(0).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("daily_log_templates_project_idx").on(t.companyId, t.projectId)],
);

export const punchItems = pgTable(
  "punch_items",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").default("open").notNull(), // PunchStatus
    itemType: text("item_type"),
    assigneeId: text("assignee_id"),
    verifierId: text("verifier_id"),
    vendorId: text("vendor_id"),
    locationId: text("location_id"),
    dueDate: text("due_date"),
    priority: text("priority").default("medium").notNull(), // FieldPriority
    beforePhotoIds: jsonb("before_photo_ids").$type<string[]>().default([]).notNull(),
    afterPhotoIds: jsonb("after_photo_ids").$type<string[]>().default([]).notNull(),
    /* WP-FIELD */
    trade: text("trade"),
    templateId: text("template_id"),
    /** user ids notified on create/assign/close (#409) */
    distribution: jsonb("distribution").$type<string[]>().default([]).notNull(),
    /** who moved it to ready_for_review — the verifier must differ (#408) */
    readyForReviewBy: text("ready_for_review_by"),
    readyForReviewAt: ts("ready_for_review_at"),
    closedBy: text("closed_by"),
    closedAt: ts("closed_at"),
    /** observation this item was converted from, when applicable */
    observationId: text("observation_id"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("punch_items_uq").on(t.projectId, t.number),
    index("punch_items_project_idx").on(t.projectId),
    index("punch_items_status_idx").on(t.projectId, t.status),
    index("punch_items_location_idx").on(t.projectId, t.locationId),
    index("punch_items_due_idx").on(t.projectId, t.status, t.dueDate),
    index("punch_items_assignee_idx").on(t.projectId, t.assigneeId),
    index("punch_items_vendor_idx").on(t.projectId, t.vendorId),
  ],
);

/** Punch templates — trade, type, title, priority and default verifier (#399). WP-FIELD */
export const punchTemplates = pgTable(
  "punch_templates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = company-wide library; set = project-specific */
    projectId: text("project_id"),
    trade: text("trade"),
    itemType: text("item_type"),
    title: text("title").notNull(),
    description: text("description"),
    priority: text("priority").default("medium").notNull(),
    defaultVerifierId: text("default_verifier_id"),
    defaultDueDays: integer("default_due_days"),
    isActive: integer("is_active").default(1).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("punch_templates_company_idx").on(t.companyId, t.projectId)],
);

/** Photos & media with GPS + location tagging (spec Vol I §2.10). */
export const photos = pgTable(
  "photos",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    fileId: text("file_id").notNull(),
    album: text("album"),
    caption: text("caption"),
    takenAt: ts("taken_at"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    locationId: text("location_id"),
    /** AI photo intelligence output: tags, detected safety signals */
    aiTags: jsonb("ai_tags").$type<string[]>().default([]).notNull(),
    aiSummary: text("ai_summary"),
    /* WP-FIELD */
    /** manual tags (#434) */
    tags: jsonb("tags").$type<string[]>().default([]).notNull(),
    /** 360° / panoramic capture flag (#431) */
    is360: integer("is_360").default(0).notNull(),
    /** drawing pin: { sheetId, x, y } in 0..1 sheet coordinates (#433) */
    pin: jsonb("pin").$type<{ sheetId: string; x: number; y: number } | null>(),
    /** EXIF extracted server-side at upload: orientation, make, model, gps source (#428) */
    exif: jsonb("exif").$type<Record<string, unknown>>(),
    /** pending | done | failed | skipped — PhotoAiStatus; null when AI is not configured */
    aiStatus: text("ai_status"),
    aiError: text("ai_error"),
    contentType: text("content_type"),
    sizeBytes: integer("size_bytes"),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("photos_project_idx").on(t.projectId),
    index("photos_album_idx").on(t.projectId, t.album),
    index("photos_taken_idx").on(t.projectId, t.takenAt),
    index("photos_location_idx").on(t.projectId, t.locationId),
    index("photos_file_idx").on(t.fileId),
    index("photos_uploader_idx").on(t.projectId, t.uploadedBy),
    /** tag search uses jsonb containment (`tags @> '["x"]'`) — GIN serves it (#434) */
    index("photos_tags_gin_idx").using("gin", t.tags),
    index("photos_ai_tags_gin_idx").using("gin", t.aiTags),
  ],
);

/** Albums with privacy — a private album is visible to its allow-list and admins (#429). WP-FIELD */
export const photoAlbums = pgTable(
  "photo_albums",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    isPrivate: integer("is_private").default(0).notNull(),
    allowedUserIds: jsonb("allowed_user_ids").$type<string[]>().default([]).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("photo_albums_uq").on(t.projectId, t.name),
    index("photo_albums_project_idx").on(t.companyId, t.projectId),
  ],
);

/**
 * Observations — first-class field findings (spec Vol I §4.2 #634–646):
 * typed, assigned, pinned to a drawing, and convertible into a punch item,
 * a safety incident or a change event. WP-FIELD
 */
export const fieldObservations = pgTable(
  "field_observations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    observationType: text("observation_type").default("other").notNull(), // ObservationType
    status: text("status").default("open").notNull(), // ObservationStatus
    priority: text("priority").default("medium").notNull(), // FieldPriority
    assigneeId: text("assignee_id"),
    verifierId: text("verifier_id"),
    vendorId: text("vendor_id"),
    distribution: jsonb("distribution").$type<string[]>().default([]).notNull(),
    dueDate: text("due_date"),
    locationId: text("location_id"),
    /** drawing pin (#640) */
    sheetId: text("sheet_id"),
    pinX: doublePrecision("pin_x"),
    pinY: doublePrecision("pin_y"),
    photoIds: jsonb("photo_ids").$type<string[]>().default([]).notNull(),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    /** punch_item | incident | change_event once converted (#644) */
    convertedToType: text("converted_to_type"),
    convertedToId: text("converted_to_id"),
    convertedAt: ts("converted_at"),
    readyForReviewBy: text("ready_for_review_by"),
    closedBy: text("closed_by"),
    closedAt: ts("closed_at"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("field_observations_uq").on(t.projectId, t.number),
    index("field_observations_project_idx").on(t.companyId, t.projectId),
    index("field_observations_status_idx").on(t.projectId, t.status),
    index("field_observations_assignee_idx").on(t.projectId, t.assigneeId),
    index("field_observations_due_idx").on(t.projectId, t.status, t.dueDate),
    index("field_observations_type_idx").on(t.projectId, t.observationType),
  ],
);

/**
 * Escalation ladder state — one row per (record, level) so the daily sweep
 * is idempotent: a rung that has been notified is never notified twice. WP-FIELD
 */
export const fieldEscalations = pgTable(
  "field_escalations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    recordType: text("record_type").notNull(), // FieldEscalationRecordType
    recordId: text("record_id").notNull(),
    level: integer("level").notNull(), // FieldEscalationLevel
    daysOverdue: integer("days_overdue").notNull(),
    notifiedUserIds: jsonb("notified_user_ids").$type<string[]>().default([]).notNull(),
    signalId: text("signal_id"),
    notifiedAt: createdAt(),
  },
  (t) => [
    uniqueIndex("field_escalations_uq").on(t.recordType, t.recordId, t.level),
    index("field_escalations_project_idx").on(t.companyId, t.projectId, t.notifiedAt),
  ],
);

/**
 * Per-project field settings: escalation ladder, punch closure gates,
 * submittal allowances and daily-log distribution. One row per project. WP-FIELD
 */
export const fieldSettings = pgTable(
  "field_settings",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
    updatedBy: text("updated_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("field_settings_uq").on(t.projectId)],
);
