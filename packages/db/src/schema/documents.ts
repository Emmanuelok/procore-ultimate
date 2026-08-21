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

/** Folder tree with unlimited nesting and folder-level permissions. */
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
    /** per-folder permission overrides: { userId: "read"|"standard"|"admin" } */
    permissions: jsonb("permissions").$type<Record<string, string>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("folders_project_idx").on(t.projectId),
    index("folders_parent_idx").on(t.parentId),
  ],
);

/**
 * Stored binary object. Files are content-addressed: `sha256` is computed at
 * ingest (evidentiary integrity, spec Domain S #862) and `storageKey` locates
 * the payload in the storage backend.
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
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("files_project_idx").on(t.projectId),
    index("files_folder_idx").on(t.folderId),
    index("files_sha_idx").on(t.sha256),
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
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("file_versions_uq").on(t.fileId, t.version)],
);

/** Download/access tracking (also feeds bidder document access analytics). */
export const fileAccessLog = pgTable(
  "file_access_log",
  {
    id: text("id").primaryKey(),
    fileId: text("file_id").notNull(),
    userId: text("user_id").notNull(),
    action: text("action").notNull(), // view | download
    at: createdAt(),
  },
  (t) => [index("file_access_log_file_idx").on(t.fileId)],
);
