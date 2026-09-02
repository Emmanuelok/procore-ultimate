import {
  bigint,
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
 * DOCUMENTS (spec Vol I §2.2, #287–#301).
 *
 * Folder tree with unlimited nesting and folder-level permissions. A folder's
 * `path` is materialised ("/Design/Structural") so private-folder containment
 * and ACL inheritance are a prefix test rather than a recursive walk: a
 * private folder hides every descendant and every file under them, and an
 * ACL set on a folder applies down the path until a deeper folder overrides
 * it (WP-DOCS, #291, #297).
 */
export const folders = pgTable(
  "folders",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    parentId: text("parent_id"),
    name: text("name").notNull(),
    path: text("path").notNull(),
    isPrivate: integer("is_private").default(0).notNull(),
    /** per-folder permission overrides: { userId: "none"|"read"|"standard"|"admin" } */
    permissions: jsonb("permissions").$type<Record<string, string>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("folders_project_idx").on(t.projectId),
    index("folders_parent_idx").on(t.parentId),
    index("folders_company_idx").on(t.companyId),
    /** sibling names are unique because the path embeds the parent's path */
    uniqueIndex("folders_path_uq").on(t.projectId, t.path),
  ],
);

/**
 * Stored binary object. Files are content-addressed: `sha256` is computed at
 * ingest (evidentiary integrity, spec Domain S #862) and `storageKey` locates
 * the payload in the storage backend.
 *
 * Metadata for search (#287) is explicit — `documentType`, `tags`,
 * `description`, `revisionLabel` — rather than buried in the free-form
 * `metadata` jsonb, which stays for pipeline provenance (`kind:
 * "drawing_set" | "spec_book"` marks a file the drawings/spec pipelines own).
 * Deletion is soft (`deletedAt`) so a recycle bin can restore (#78) and the
 * access log keeps pointing at a real row.
 */
export const files = pgTable(
  "files",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    folderId: text("folder_id"),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    /** current version number; history in fileVersions */
    version: integer("version").default(1).notNull(),
    isPrivate: integer("is_private").default(0).notNull(),
    checkedOutBy: text("checked_out_by"),
    checkedOutAt: ts("checked_out_at"),
    /** stamped by the stale-checkout sweep so the holder is nagged once */
    staleCheckoutNotifiedAt: ts("stale_checkout_notified_at"),
    /* --- searchable metadata (#287) --- */
    documentType: text("document_type"), // DocumentType
    tags: jsonb("tags").$type<string[]>().default([]).notNull(),
    description: text("description"),
    /** the issuer's own revision/issue label ("P02", "Rev C") */
    revisionLabel: text("revision_label"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    /* --- soft delete / recycle bin --- */
    deletedAt: ts("deleted_at"),
    deletedBy: text("deleted_by"),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("files_project_idx").on(t.projectId),
    index("files_folder_idx").on(t.folderId),
    index("files_sha_idx").on(t.sha256),
    index("files_company_idx").on(t.companyId),
    index("files_type_idx").on(t.projectId, t.documentType),
    index("files_deleted_idx").on(t.projectId, t.deletedAt),
    index("files_checkout_idx").on(t.checkedOutBy),
  ],
);

export const fileVersions = pgTable(
  "file_versions",
  {
    id: text("id").primaryKey(),
    fileId: text("file_id").notNull(),
    version: integer("version").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    /** free-text change note for the version history drawer */
    note: text("note"),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("file_versions_uq").on(t.fileId, t.version)],
);

/**
 * Download/access tracking (#299; also feeds bidder document access
 * analytics, Vol II #78–79). `companyId`/`projectId` are denormalised so the
 * report is one indexed query per project rather than a join through files.
 */
export const fileAccessLog = pgTable(
  "file_access_log",
  {
    id: text("id").primaryKey(),
    fileId: text("file_id").notNull(),
    userId: text("user_id").notNull(),
    action: text("action").notNull(), // FileAccessAction
    companyId: text("company_id"),
    projectId: text("project_id"),
    /** FileAccessContext — which surface served the bytes */
    context: text("context"),
    version: integer("version"),
    at: createdAt(),
  },
  (t) => [
    index("file_access_log_file_idx").on(t.fileId),
    index("file_access_log_project_idx").on(t.projectId, t.at),
    index("file_access_log_user_idx").on(t.userId, t.at),
  ],
);

/**
 * E-mail-to-folder ingestion log (#300). One row per delivered message:
 * what arrived, where it was filed, which files it produced, or why it was
 * refused. The message itself is stored as an .eml file so the audit trail
 * holds the bytes that were received, not a summary of them.
 */
export const documentInboundEmails = pgTable(
  "document_inbound_emails",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    folderId: text("folder_id"),
    messageId: text("message_id"),
    fromAddress: text("from_address"),
    toAddress: text("to_address"),
    subject: text("subject"),
    receivedAt: ts("received_at"),
    status: text("status").default("stored").notNull(), // InboundEmailStatus
    rejectReason: text("reject_reason"),
    attachmentCount: integer("attachment_count").default(0).notNull(),
    /** files created from the attachments (+ the .eml itself first) */
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    /** attachments refused (MIME/size) with the reason each */
    rejected: jsonb("rejected").$type<Array<{ filename: string; reason: string }>>().default([]).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("document_inbound_emails_project_idx").on(t.projectId, t.createdAt),
    index("document_inbound_emails_message_idx").on(t.projectId, t.messageId),
  ],
);
