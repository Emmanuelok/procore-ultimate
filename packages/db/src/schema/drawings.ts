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
    processing: text("processing").default("pending").notNull(), // pending | processing | ready | failed
    sourceFileId: text("source_file_id"),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("drawing_sets_project_idx").on(t.projectId)],
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
  ],
);

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
    /** OCR-extracted full text of the sheet, for search + AI */
    extractedText: text("extracted_text"),
    /** sheet calibration for measurement (SheetCalibration JSON) */
    calibration: jsonb("calibration"),
    isSuperseded: integer("is_superseded").default(0).notNull(),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("drawing_revisions_sheet_idx").on(t.sheetId),
    index("drawing_revisions_set_idx").on(t.setId),
  ],
);

/**
 * Markup layers. `layer` = personal (visible to author) or published.
 * Shapes are MarkupShape[] in normalized sheet coordinates so they persist
 * across revisions (spec Vol I #269).
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("drawing_markups_revision_idx").on(t.revisionId)],
);

/** Hyperlinks between sheets (detail callouts), auto or manual. */
export const drawingHyperlinks = pgTable(
  "drawing_hyperlinks",
  {
    id: text("id").primaryKey(),
    fromRevisionId: text("from_revision_id").notNull(),
    toSheetId: text("to_sheet_id").notNull(),
    /** normalized rectangle on the source sheet */
    x: doublePrecision("x").notNull(),
    y: doublePrecision("y").notNull(),
    w: doublePrecision("w").notNull(),
    h: doublePrecision("h").notNull(),
    label: text("label"),
    source: text("source").default("manual").notNull(), // manual | auto
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("drawing_hyperlinks_from_idx").on(t.fromRevisionId)],
);

/**
 * Pins: RFIs, punch items, observations, photos placed on a sheet at a
 * normalized coordinate. The generic (recordType, recordId) pair keeps the
 * drawing tool decoupled from every other tool.
 */
export const drawingPins = pgTable(
  "drawing_pins",
  {
    id: text("id").primaryKey(),
    sheetId: text("sheet_id").notNull(),
    recordType: text("record_type").notNull(), // rfi | punch | observation | photo | inspection
    recordId: text("record_id").notNull(),
    x: doublePrecision("x").notNull(),
    y: doublePrecision("y").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("drawing_pins_sheet_idx").on(t.sheetId),
    index("drawing_pins_record_idx").on(t.recordType, t.recordId),
  ],
);
