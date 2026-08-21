import {
  bigserial,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();

/**
 * Assurance layer — the eight data primitives of Volume III §4.
 *
 * Design rule enforced at the API layer: an Assertion and the Evidence used
 * to test it must never be created by the same actor through the same
 * pathway (spec §4 "Design rule").
 */

export const assertions = pgTable(
  "assertions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    kind: text("kind").notNull(), // AssertionKind
    claimantId: text("claimant_id").notNull(),
    claimantKind: text("claimant_kind").default("user").notNull(), // user | entity
    value: doublePrecision("value"),
    unit: text("unit"),
    basis: text("basis").notNull(),
    contractRef: text("contract_ref"),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    assertedAt: timestamp("asserted_at", { withTimezone: true, mode: "string" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("assertions_project_idx").on(t.projectId),
    index("assertions_source_idx").on(t.sourceType, t.sourceId),
  ],
);

export const evidence = pgTable(
  "evidence",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    kind: text("kind").notNull(), // EvidenceKind
    source: text("source").notNull(),
    contentHash: text("content_hash").notNull(),
    fileId: text("file_id"),
    capturedAt: timestamp("captured_at", { withTimezone: true, mode: "string" }),
    ingestedAt: createdAt(),
    /** 0..1 — independence of the source from the claimant population */
    independenceScore: doublePrecision("independence_score").default(0).notNull(),
    /** who/what captured it and every hand it passed through */
    provenance: jsonb("provenance").$type<unknown>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    submittedBy: text("submitted_by").notNull(),
  },
  (t) => [
    index("evidence_project_idx").on(t.projectId),
    index("evidence_hash_idx").on(t.contentHash),
  ],
);

/** THE product table (spec: "everything else is scaffolding around this"). */
export const reconciliations = pgTable(
  "reconciliations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    assertionId: text("assertion_id").notNull(),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().default([]).notNull(),
    method: text("method").notNull(),
    result: text("result").notNull(), // ReconciliationResult
    variance: doublePrecision("variance"),
    variancePercent: doublePrecision("variance_percent"),
    confidence: doublePrecision("confidence"),
    reviewerId: text("reviewer_id"),
    disposition: text("disposition"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("reconciliations_assertion_idx").on(t.assertionId),
    index("reconciliations_project_idx").on(t.projectId),
  ],
);

export const obligations = pgTable(
  "obligations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    sourceClause: text("source_clause").notNull(),
    obligorId: text("obligor_id"),
    obligeeId: text("obligee_id"),
    trigger: text("trigger").notNull(),
    deadline: timestamp("deadline", { withTimezone: true, mode: "string" }),
    /** for time bars: how many days before deadline to warn */
    warnDaysBefore: doublePrecision("warn_days_before"),
    evidenceRequirement: text("evidence_requirement"),
    status: text("status").default("open").notNull(), // ObligationStatus
    satisfiedEvidenceId: text("satisfied_evidence_id"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("obligations_project_idx").on(t.projectId),
    index("obligations_deadline_idx").on(t.status, t.deadline),
  ],
);

export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    type: text("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
    location: text("location"),
    detectedOrReported: text("detected_or_reported").default("reported").notNull(),
    causalLinks: jsonb("causal_links").$type<string[]>().default([]).notNull(),
    payload: jsonb("payload").$type<unknown>(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("events_project_idx").on(t.projectId, t.occurredAt)],
);

export const entities = pgTable(
  "entities",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    kind: text("kind").notNull(), // EntityKind
    name: text("name").notNull(),
    identifiers: jsonb("identifiers").$type<Record<string, string>>().default({}).notNull(),
    jurisdiction: text("jurisdiction"),
    screeningStatus: text("screening_status"), // clear | pep | sanctions_hit | debarred | pending
    screenedAt: timestamp("screened_at", { withTimezone: true, mode: "string" }),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [index("entities_company_idx").on(t.companyId)],
);

export const entityRelationships = pgTable(
  "entity_relationships",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    fromEntityId: text("from_entity_id").notNull(),
    toEntityId: text("to_entity_id").notNull(),
    kind: text("kind").notNull(), // EntityRelationshipKind
    since: text("since"),
    source: text("source"),
    confidence: doublePrecision("confidence"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("entity_relationships_uq").on(t.fromEntityId, t.toEntityId, t.kind),
    index("entity_relationships_from_idx").on(t.fromEntityId),
    index("entity_relationships_to_idx").on(t.toEntityId),
  ],
);

export const signals = pgTable(
  "signals",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    detector: text("detector").notNull(),
    severity: text("severity").notNull(), // SignalSeverity
    confidence: doublePrecision("confidence").default(0).notNull(),
    title: text("title").notNull(),
    explanation: text("explanation").notNull(),
    evidenceRefs: jsonb("evidence_refs").$type<unknown>(),
    disposition: text("disposition").default("new").notNull(), // SignalDisposition
    reviewerId: text("reviewer_id"),
    reviewerNotes: text("reviewer_notes"),
    createdAt: createdAt(),
  },
  (t) => [
    index("signals_company_idx").on(t.companyId, t.disposition),
    index("signals_project_idx").on(t.projectId),
  ],
);

/**
 * Append-only, hash-chained ledger (spec Domain S #859). Rows are NEVER
 * updated or deleted; `entryHash` covers the row content plus `prevHash`.
 * One chain per company, ordered by `seq`.
 */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    companyId: text("company_id").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(), // LedgerAction
    objectType: text("object_type").notNull(),
    objectId: text("object_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    /** optional canonical payload snapshot for high-value objects */
    payload: jsonb("payload").$type<unknown>(),
    prevHash: text("prev_hash").notNull(),
    entryHash: text("entry_hash").notNull(),
    at: timestamp("at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  },
  (t) => [
    index("ledger_company_seq_idx").on(t.companyId, t.seq),
    index("ledger_object_idx").on(t.objectType, t.objectId),
  ],
);
