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
    /* ------------------ WP-ANALYTICS: the upgrade wave ----------------- */
    /**
     * insert  — reject a row whose externalId was already committed
     * reconcile — diff it against the committed record and offer an update
     */
    mode: text("mode").default("insert").notNull(),
    /** rows whose committed record was UPDATED (reconcile mode) */
    updatedCount: integer("updated_count").default(0).notNull(),
    /** connector pulls run in the background; this is what they report */
    pagesFetched: integer("pages_fetched").default(0).notNull(),
    progressNote: text("progress_note"),
    /** opaque connector cursor so a pull can resume where it stopped */
    connectorCursor: text("connector_cursor"),
    /** parser that produced the staged rows: csv | p6_xer | msp_xml | connector | push */
    parser: text("parser").default("csv").notNull(),
    startedBy: text("started_by").notNull(),
    committedBy: text("committed_by"),
    committedAt: timestamp("committed_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("ingestion_runs_company_idx").on(t.companyId),
    index("ingestion_runs_source_idx").on(t.sourceId),
    index("ingestion_runs_status_idx").on(t.companyId, t.status),
    index("ingestion_runs_project_idx").on(t.projectId),
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
    /**
     * RECONCILE MODE. When an externalId matches a record an earlier run
     * committed, the row is not a duplicate to reject but a restatement to
     * consider: `matchedRecordId` names what it matches and `diff` holds the
     * field-by-field difference an operator approves or skips.
     */
    matchedRecordId: text("matched_record_id"),
    diff: jsonb("diff").$type<Record<string, unknown>>(),
    /** insert | update | skip — the operator's decision in reconcile mode */
    resolution: text("resolution"),
    createdAt: createdAt(),
  },
  (t) => [
    index("ingested_records_run_idx").on(t.runId),
    index("ingested_records_external_idx").on(t.externalId),
    index("ingested_records_run_status_idx").on(t.runId, t.status),
  ],
);

/**
 * A saved column map. The mapping step is the slow part of every migration and
 * it is identical every month; a template makes the second import of the same
 * export a two-click operation and keeps the mapping auditable.
 */
export const ingestionMappingTemplates = pgTable(
  "ingestion_mapping_templates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = usable with any source of this dataset */
    sourceId: text("source_id"),
    dataset: text("dataset").notNull(),
    name: text("name").notNull(),
    /** { targetField: sourceColumn } */
    columnMap: jsonb("column_map").$type<Record<string, string>>().default({}).notNull(),
    /** how many runs adopted it — the honest measure of whether it is right */
    useCount: integer("use_count").default(0).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("ingestion_mapping_templates_company_idx").on(t.companyId, t.dataset),
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
