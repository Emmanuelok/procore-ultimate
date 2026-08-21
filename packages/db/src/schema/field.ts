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
    respondedAt: timestamp("responded_at", { withTimezone: true, mode: "string" }),
    costImpact: text("cost_impact").default("tbd").notNull(), // yes | no | tbd
    scheduleImpact: text("schedule_impact").default("tbd").notNull(), // yes | no | tbd
    scheduleImpactDays: integer("schedule_impact_days"),
    locationId: text("location_id"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("rfis_number_uq").on(t.projectId, t.number),
    index("rfis_project_idx").on(t.projectId),
    index("rfis_status_idx").on(t.projectId, t.status),
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
    status: text("status").default("draft").notNull(), // SubmittalStatus
    ballInCourtId: text("ball_in_court_id"),
    requiredOnSite: text("required_on_site"),
    leadTimeDays: integer("lead_time_days"),
    /** computed: requiredOnSite - leadTime - review allowance */
    submitByDate: text("submit_by_date"),
    responseCode: text("response_code"), // SubmittalResponse
    respondedBy: text("responded_by"),
    respondedAt: timestamp("responded_at", { withTimezone: true, mode: "string" }),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    /** previous revision in the resubmittal chain */
    previousId: text("previous_id"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("submittals_uq").on(t.projectId, t.number, t.revision),
    index("submittals_project_idx").on(t.projectId),
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
    respondedAt: timestamp("responded_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [index("submittal_review_steps_idx").on(t.submittalId, t.position)],
);

export const dailyLogs = pgTable(
  "daily_logs",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    logDate: text("log_date").notNull(), // ISO date
    status: text("status").default("draft").notNull(), // draft | submitted | approved
    weather: jsonb("weather").$type<Record<string, unknown>>(),
    /** structured sections: manpower[], equipment[], deliveries[], visitors[], delays[], notes */
    sections: jsonb("sections").$type<Record<string, unknown>>().default({}).notNull(),
    notes: text("notes"),
    photoFileIds: jsonb("photo_file_ids").$type<string[]>().default([]).notNull(),
    /** true when the draft was produced by the AI daily-log agent */
    aiDrafted: integer("ai_drafted").default(0).notNull(),
    createdBy: text("created_by").notNull(),
    approvedBy: text("approved_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("daily_logs_uq").on(t.projectId, t.logDate, t.createdBy),
    index("daily_logs_project_idx").on(t.projectId),
  ],
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
    priority: text("priority").default("medium").notNull(), // low | medium | high
    beforePhotoIds: jsonb("before_photo_ids").$type<string[]>().default([]).notNull(),
    afterPhotoIds: jsonb("after_photo_ids").$type<string[]>().default([]).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("punch_items_uq").on(t.projectId, t.number),
    index("punch_items_project_idx").on(t.projectId),
  ],
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
    takenAt: timestamp("taken_at", { withTimezone: true, mode: "string" }),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    locationId: text("location_id"),
    /** AI photo intelligence output: tags, detected safety signals */
    aiTags: jsonb("ai_tags").$type<string[]>().default([]).notNull(),
    aiSummary: text("ai_summary"),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("photos_project_idx").on(t.projectId)],
);
