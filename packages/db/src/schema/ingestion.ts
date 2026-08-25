import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();

/**
 * M6 — Data ingestion & migration (spec Vol III module map; Domain N).
 *
 * Everything that enters the platform from outside — CSV migrations, connector
 * pulls (Procore/Aconex), machine pushes via API token — lands in a STAGING
 * area first (ingestedRecords), is validated against the target dataset's
 * schema, and only then committed to real records in an explicit, ledgered
 * commit step. Raw upload files are hashed at ingest (ADR 0014: an ingested
 * evidence stream must be independent of the assertions it will later test),
 * and every committed record keeps `sourceRunId` provenance back to the run
 * and the file hash it came from.
 */
export const ingestionSources = pgTable(
  "ingestion_sources",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = company-level source usable across projects */
    projectId: text("project_id"),
    name: text("name").notNull(),
    kind: text("kind").notNull(), // IngestionSourceKind: csv | procore | aconex | api_token
    /**
     * Connector configuration — base URL, remote company/project ids, default
     * column maps. NEVER credentials: secrets are held in env / api_tokens,
     * not in this row.
     */
    config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
    isActive: integer("is_active").default(1).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("ingestion_sources_company_idx").on(t.companyId)],
);

/** One staged batch: an uploaded file or connector pull, validated then committed. */
export const ingestionRuns = pgTable(
  "ingestion_runs",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    sourceId: text("source_id").notNull(),
    /** IngestionDataset — which staging schema the rows are validated against */
    dataset: text("dataset").notNull(),
    status: text("status").default("staging").notNull(), // IngestionRunStatus
    /** raw upload retained as evidence, content-addressed */
    fileId: text("file_id"),
    fileName: text("file_name"),
    fileSha256: text("file_sha256"),
    /** { targetField: sourceColumn } chosen in the mapping step */
    columnMap: jsonb("column_map").$type<Record<string, string>>().default({}).notNull(),
    totalRows: integer("total_rows").default(0).notNull(),
    stagedCount: integer("staged_count").default(0).notNull(),
    committedCount: integer("committed_count").default(0).notNull(),
    rejectedCount: integer("rejected_count").default(0).notNull(),
    skippedCount: integer("skipped_count").default(0).notNull(),
    /** validation report: [{ row, field, code, message }] capped server-side */
    report: jsonb("report").$type<unknown[]>().default([]).notNull(),
    error: text("error"),
    startedBy: text("started_by").notNull(),
    committedBy: text("committed_by"),
    committedAt: timestamp("committed_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("ingestion_runs_company_idx").on(t.companyId),
    index("ingestion_runs_source_idx").on(t.sourceId),
  ],
);

/** A single staged row awaiting (or after) commit. Payload is the raw mapped row. */
export const ingestedRecords = pgTable(
  "ingested_records",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    companyId: text("company_id").notNull(),
    rowNumber: integer("row_number").notNull(),
    /** source-system identifier for idempotent re-runs / dedupe */
    externalId: text("external_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    status: text("status").default("staged").notNull(), // StagedRecordStatus
    /** why rejected/skipped (validation code + message) */
    reason: text("reason"),
    /** id of the real record created at commit time — provenance forward-link */
    committedRecordId: text("committed_record_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("ingested_records_run_idx").on(t.runId),
    index("ingested_records_external_idx").on(t.externalId),
  ],
);

/**
 * Machine credentials for evidence-stream pushes (site-access logs, payroll
 * exports, sensor feeds). Only the SHA-256 of the token is stored; the token
 * itself is shown once at creation. Scopes name ingestion datasets the token
 * may push to — nothing else on the platform.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** first 8 chars kept for display ("cok_ab12…") */
    tokenPrefix: text("token_prefix").notNull(),
    /** IngestionDataset[] this token may push to */
    scopes: jsonb("scopes").$type<string[]>().default([]).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "string" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("api_tokens_company_idx").on(t.companyId),
    index("api_tokens_hash_idx").on(t.tokenHash),
  ],
);
