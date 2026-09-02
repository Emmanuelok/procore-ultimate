import { sql } from "drizzle-orm";
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
 * DRAWINGS (spec Vol I §2.1, #256–#286).
 *
 * The pipeline: a drawing SET is uploaded as one PDF → each page becomes a
 * SHEET (a stable logical identity, "A-101") with a REVISION (this issue's
 * page). Processing is resumable: `processedPages` lets the scheduler job
 * continue a large set across ticks and lets a failed set be retried without
 * re-registering the pages it already handled.
 */

/** An uploaded drawing set (bulk PDF upload, split into sheets). */
export const drawingSets = pgTable(
  "drawing_sets",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    issuedDate: text("issued_date"),
    /** processing status of the OCR / sheet-split pipeline */
    processing: text("processing").default("pending").notNull(), // PdfProcessingState
    processingError: text("processing_error"),
    processingStartedAt: ts("processing_started_at"),
    processingFinishedAt: ts("processing_finished_at"),
    pageCount: integer("page_count"),
    /** pages already turned into sheets — the resume cursor */
    processedPages: integer("processed_pages").default(0).notNull(),
    sheetsCreated: integer("sheets_created").default(0).notNull(),
    revisionsAdded: integer("revisions_added").default(0).notNull(),
    autoLinksCreated: integer("auto_links_created").default(0).notNull(),
    unresolvedCallouts: integer("unresolved_callouts").default(0).notNull(),
    /** default area applied to every sheet in the set (segregation, #265) */
    area: text("area"),
    sourceFileId: text("source_file_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("drawing_sets_project_idx").on(t.projectId),
    index("drawing_sets_processing_idx").on(t.companyId, t.processing),
  ],
);

/**
 * A logical sheet (e.g. "A-101 Floor Plan Level 1"). Revisions hang off the
 * sheet; the sheet always points at its current revision.
 */
export const drawingSheets = pgTable(
  "drawing_sheets",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: text("number").notNull(),
    title: text("title").notNull(),
    discipline: text("discipline").default("other").notNull(), // DrawingDiscipline
    area: text("area"),
    currentRevisionId: text("current_revision_id"),
    /** OCR-extracted number/title pending human confirmation */
    needsReview: integer("needs_review").default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("drawing_sheets_uq").on(t.projectId, t.number),
    index("drawing_sheets_project_idx").on(t.projectId),
    index("drawing_sheets_review_idx").on(t.projectId, t.needsReview),
    index("drawing_sheets_discipline_idx").on(t.projectId, t.discipline),
    index("drawing_sheets_area_idx").on(t.projectId, t.area),
  ],
);

/** A positioned text item as extracted from the page (normalised 0..1 coordinates). */
export interface DrawingTextItem {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A normalised rectangle on the sheet with what changed inside it. */
export interface DrawingChangedRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "added" | "removed" | "moved";
  items: number;
  sample: string;
}

export const drawingRevisions = pgTable(
  "drawing_revisions",
  {
    id: text("id").primaryKey(),
    sheetId: text("sheet_id").notNull(),
    setId: text("set_id").notNull(),
    revision: text("revision").notNull(), // e.g. "0", "A", "C1"
    fileId: text("file_id").notNull(),
    /** page index within the source set PDF */
    pageIndex: integer("page_index").default(0).notNull(),
    /** extracted full text of the sheet, for search + AI */
    extractedText: text("extracted_text"),
    /** positioned text items (capped) for callout detection and the vector diff */
    textItems: jsonb("text_items").$type<DrawingTextItem[]>(),
    hasTextLayer: integer("has_text_layer").default(1).notNull(),
    /** how the sheet number/title were read: { method, confidence, candidates[] } */
    detection: jsonb("detection").$type<Record<string, unknown>>(),
    /** extraction provenance: { engine, version, items, truncated } */
    extraction: jsonb("extraction").$type<Record<string, unknown>>(),
    /** sheet calibration for measurement (SheetCalibration JSON) */
    calibration: jsonb("calibration"),
    /* --- change detection against the revision this one superseded (#262) --- */
    supersedesRevisionId: text("supersedes_revision_id"),
    changedRegions: jsonb("changed_regions").$type<DrawingChangedRegion[]>(),
    changeVerdict: text("change_verdict"), // DrawingChangeVerdict
    diffComputedAt: ts("diff_computed_at"),
    isSuperseded: integer("is_superseded").default(0).notNull(),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("drawing_revisions_sheet_idx").on(t.sheetId),
    index("drawing_revisions_set_idx").on(t.setId, t.pageIndex),
    index("drawing_revisions_file_idx").on(t.fileId),
    /** full-text search over the current issue's sheets (#287) */
    index("drawing_revisions_fts_idx").using(
      "gin",
      sql`to_tsvector('english', left(coalesce(${t.extractedText}, ''), 400000))`,
    ),
  ],
);

/**
 * Markup layers. `layer` = personal (visible to author) or published.
 * Shapes are MarkupShape[] in normalized sheet coordinates so they persist
 * across revisions (spec Vol I #269): a published layer can be carried
 * forward onto the superseding revision (`carriedFromRevisionId`), and the
 * shapes that land inside a changed region are flagged for review.
 */
export const drawingMarkups = pgTable(
  "drawing_markups",
  {
    id: text("id").primaryKey(),
    sheetId: text("sheet_id").notNull(),
    revisionId: text("revision_id").notNull(),
    authorId: text("author_id").notNull(),
    layer: text("layer").default("personal").notNull(), // personal | published
    shapes: jsonb("shapes").$type<unknown[]>().default([]).notNull(),
    carriedFromRevisionId: text("carried_from_revision_id"),
    /** indexes into `shapes` that overlap a changed region on the new revision */
    reviewFlags: jsonb("review_flags").$type<number[]>().default([]).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("drawing_markups_revision_idx").on(t.revisionId),
    index("drawing_markups_sheet_idx").on(t.sheetId, t.layer),
  ],
);

/**
 * Hyperlinks between sheets (detail callouts), auto or manual (#263, #264).
 * An automatic callout whose target sheet does not exist is kept as
 * `unresolved` with `targetNumber` so the QA report can list it and a later
 * upload or rename can resolve it.
 */
export const drawingHyperlinks = pgTable(
  "drawing_hyperlinks",
  {
    id: text("id").primaryKey(),
    fromRevisionId: text("from_revision_id").notNull(),
    toSheetId: text("to_sheet_id"),
    /** the sheet number the callout names, verbatim */
    targetNumber: text("target_number"),
    /** normalized rectangle on the source sheet */
    x: doublePrecision("x").notNull(),
    y: doublePrecision("y").notNull(),
    w: doublePrecision("w").notNull(),
    h: doublePrecision("h").notNull(),
    label: text("label"),
    source: text("source").default("manual").notNull(), // manual | auto
    /** 0..1 for auto links; null when a person drew it */
    confidence: doublePrecision("confidence"),
    status: text("status").default("active").notNull(), // DrawingHyperlinkStatus
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("drawing_hyperlinks_from_idx").on(t.fromRevisionId),
    index("drawing_hyperlinks_to_idx").on(t.toSheetId),
    index("drawing_hyperlinks_status_idx").on(t.status),
  ],
);

/**
 * Pins: RFIs, punch items, observations, photos placed on a sheet at a
 * normalized coordinate. The generic (recordType, recordId) pair keeps the
 * drawing tool decoupled from every other tool; the API validates the record
 * exists in the sheet's project before a pin is stored.
 */
export const drawingPins = pgTable(
  "drawing_pins",
  {
    id: text("id").primaryKey(),
    sheetId: text("sheet_id").notNull(),
    recordType: text("record_type").notNull(), // DrawingPinRecordType
    recordId: text("record_id").notNull(),
    x: doublePrecision("x").notNull(),
    y: doublePrecision("y").notNull(),
    /** denormalised record label ("RFI-012 Beam clash") so pins render without a join */
    label: text("label"),
    locationId: text("location_id"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("drawing_pins_sheet_idx").on(t.sheetId),
    index("drawing_pins_record_idx").on(t.recordType, t.recordId),
  ],
);

/**
 * Sheet-level segregation (#265, #282). A rule RESTRICTS a scope: once any
 * rule exists for (scope, scopeValue) on a project, only the subjects listed
 * for it — users, or everyone on a permission template — can see those
 * sheets; company owners/admins and drawings admins always can. Projects
 * with no rules behave exactly as before.
 */
export const drawingSheetPermissions = pgTable(
  "drawing_sheet_permissions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    scope: text("scope").notNull(), // SheetPermissionScope
    /** discipline key, area label or sheet id */
    scopeValue: text("scope_value").notNull(),
    subjectType: text("subject_type").notNull(), // SheetPermissionSubject
    /** user id or permission template key */
    subjectId: text("subject_id").notNull(),
    level: text("level").default("read").notNull(), // SheetPermissionLevel
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("drawing_sheet_permissions_uq").on(
      t.projectId,
      t.scope,
      t.scopeValue,
      t.subjectType,
      t.subjectId,
    ),
    index("drawing_sheet_permissions_project_idx").on(t.projectId, t.scope),
  ],
);

/**
 * A drawing issue: a named distribution of sheet revisions to named people
 * (#280–#281) — the transmittal-lite that makes "who was sent revision C
 * and when did they acknowledge it" answerable from the record.
 */
export const drawingIssues = pgTable(
  "drawing_issues",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(), // "DI-003"
    title: text("title").notNull(),
    purpose: text("purpose").default("for_information").notNull(), // DrawingIssuePurpose
    status: text("status").default("draft").notNull(), // DrawingIssueStatus
    setId: text("set_id"),
    /** the exact revisions issued — a later reissue never rewrites this list */
    revisionIds: jsonb("revision_ids").$type<string[]>().default([]).notNull(),
    notes: text("notes"),
    /** optional link to a correspondence transmittal record */
    transmittalId: text("transmittal_id"),
    issuedAt: ts("issued_at"),
    issuedBy: text("issued_by"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("drawing_issues_uq").on(t.projectId, t.number),
    index("drawing_issues_project_idx").on(t.projectId, t.status),
  ],
);

/** One recipient of a drawing issue and their acknowledgement. */
export const drawingIssueRecipients = pgTable(
  "drawing_issue_recipients",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id").notNull(),
    userId: text("user_id").notNull(),
    notifiedAt: ts("notified_at"),
    remindedAt: ts("reminded_at"),
    acknowledgedAt: ts("acknowledged_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("drawing_issue_recipients_uq").on(t.issueId, t.userId),
    index("drawing_issue_recipients_user_idx").on(t.userId, t.acknowledgedAt),
  ],
);
