/**
 * Shared enums for the documents area (platform upgrade wave, WP-DOCS):
 * documents, drawings and specifications. Add new `as const` string unions
 * and their types here; never edit enums.ts from a parallel work package.
 */

/* ------------------------------------------------------------------ */
/* Documents (spec Vol I §2.2 #287–#301)                               */
/* ------------------------------------------------------------------ */

/** What a stored file IS, for metadata search (#287). Free text lives in tags. */
export const DOCUMENT_TYPES = [
  "drawing",
  "specification",
  "contract",
  "correspondence",
  "report",
  "photo",
  "schedule",
  "submittal",
  "rfi",
  "permit",
  "certificate",
  "invoice",
  "meeting",
  "safety",
  "quality",
  "email",
  "other",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Per-folder permission override levels (folders.permissions, #291). */
export const FOLDER_PERMISSION_LEVELS = ["none", "read", "standard", "admin"] as const;
export type FolderPermissionLevel = (typeof FOLDER_PERMISSION_LEVELS)[number];

/** Every event the download-tracking report can show (#299). */
export const FILE_ACCESS_ACTIONS = [
  "view",
  "download",
  "preview",
  "copy",
  "checkout",
  "checkin",
] as const;
export type FileAccessAction = (typeof FILE_ACCESS_ACTIONS)[number];

/** Where a file access came from — the report groups on it. */
export const FILE_ACCESS_CONTEXTS = [
  "documents",
  "drawing_viewer",
  "spec_book",
  "inbound_email",
  "api",
] as const;
export type FileAccessContext = (typeof FILE_ACCESS_CONTEXTS)[number];

/** Outcome of one inbound e-mail delivered to a project folder (#300). */
export const INBOUND_EMAIL_STATUSES = ["stored", "rejected", "partial"] as const;
export type InboundEmailStatus = (typeof INBOUND_EMAIL_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Drawings (spec Vol I §2.1 #256–#286)                                */
/* ------------------------------------------------------------------ */

/** Split/extract pipeline state shared by drawing sets and spec books. */
export const PDF_PROCESSING_STATES = ["pending", "processing", "ready", "failed"] as const;
export type PdfProcessingState = (typeof PDF_PROCESSING_STATES)[number];

/** How a page's sheet number/title was read. */
export const SHEET_DETECTION_METHODS = ["title_block", "text_stream", "placeholder"] as const;
export type SheetDetectionMethod = (typeof SHEET_DETECTION_METHODS)[number];

/** Verdict of the revision-vs-revision diff (#262). */
export const DRAWING_CHANGE_VERDICTS = ["changed", "unchanged", "unknown"] as const;
export type DrawingChangeVerdict = (typeof DRAWING_CHANGE_VERDICTS)[number];

/** Lifecycle of an automatic or manual hyperlink (#263). */
export const DRAWING_HYPERLINK_STATUSES = ["active", "unresolved", "rejected"] as const;
export type DrawingHyperlinkStatus = (typeof DRAWING_HYPERLINK_STATUSES)[number];

/** What a detected callout is referring to. */
export const DRAWING_CALLOUT_KINDS = ["detail", "section", "elevation", "sheet", "typical"] as const;
export type DrawingCalloutKind = (typeof DRAWING_CALLOUT_KINDS)[number];

/** Sheet-level segregation (#265, #282): what a rule is scoped to. */
export const SHEET_PERMISSION_SCOPES = ["discipline", "area", "sheet"] as const;
export type SheetPermissionScope = (typeof SHEET_PERMISSION_SCOPES)[number];

export const SHEET_PERMISSION_SUBJECTS = ["user", "template"] as const;
export type SheetPermissionSubject = (typeof SHEET_PERMISSION_SUBJECTS)[number];

/** A subject listed on a restricted scope gets this level; unlisted → none. */
export const SHEET_PERMISSION_LEVELS = ["read", "standard"] as const;
export type SheetPermissionLevel = (typeof SHEET_PERMISSION_LEVELS)[number];

/** Drawing issue (distribution / transmittal-lite, #280–#281). */
export const DRAWING_ISSUE_PURPOSES = [
  "for_construction",
  "for_information",
  "for_approval",
  "for_tender",
  "for_coordination",
  "as_built",
] as const;
export type DrawingIssuePurpose = (typeof DRAWING_ISSUE_PURPOSES)[number];

export const DRAWING_ISSUE_STATUSES = ["draft", "issued", "cancelled"] as const;
export type DrawingIssueStatus = (typeof DRAWING_ISSUE_STATUSES)[number];

/** Records that can be pinned on a sheet (#272–#276). */
export const DRAWING_PIN_RECORD_TYPES = [
  "rfi",
  "punch",
  "observation",
  "photo",
  "inspection",
  "submittal",
] as const;
export type DrawingPinRecordType = (typeof DRAWING_PIN_RECORD_TYPES)[number];

/** How a sheet under review is resolved (#258). */
export const SHEET_REVIEW_ACTIONS = ["confirm", "merge_into", "discard"] as const;
export type SheetReviewAction = (typeof SHEET_REVIEW_ACTIONS)[number];

/* ------------------------------------------------------------------ */
/* Specifications (spec Vol I §2.3 #287–#288, #326)                    */
/* ------------------------------------------------------------------ */

/** What a reissue did to a requirement already on the register (#288). */
export const SPEC_REISSUE_EFFECTS = [
  "superseded",
  "reconfirm",
  "unchanged",
  "new",
  "registered_changed",
] as const;
export type SpecReissueEffect = (typeof SPEC_REISSUE_EFFECTS)[number];
