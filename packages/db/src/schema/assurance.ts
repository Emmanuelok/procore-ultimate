import {
  bigserial,
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
    /**
     * The authenticated user who authored the row, which is NOT the same fact
     * as `claimantId` (a claim may be recorded on behalf of an entity). The
     * separation rule is enforced against both: evidence authored by the
     * assertion's author is not independent of it, whatever the claimant says.
     */
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("assertions_project_idx").on(t.projectId),
    index("assertions_source_idx").on(t.sourceType, t.sourceId),
    index("assertions_claimant_idx").on(t.companyId, t.claimantId),
    index("assertions_kind_idx").on(t.projectId, t.kind),
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
    /**
     * Soft delete (Domain S #867 content retention). An entity under
     * investigation is exactly the row an interested party wants gone, so a
     * delete tombstones the row and keeps every identifier; the ledger entry
     * carries the full prior snapshot.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" }),
    deletedBy: text("deleted_by"),
    deleteReason: text("delete_reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("entities_company_idx").on(t.companyId),
    index("entities_company_deleted_idx").on(t.companyId, t.deletedAt),
  ],
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
    /**
     * Deterministic identity of the FINDING (detector + what it is about),
     * not of the run that produced it. Re-running a detector over unchanged
     * data must not manufacture a second signal — that is the false-positive
     * fatigue Vol III §6 warns about, and it corrupts every precision figure
     * derived from the register.
     */
    fingerprint: text("fingerprint"),
    /** what the finding is about — a vendor, an approver, a claimant, a seal */
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    /** the detector run that most recently raised or refreshed this signal */
    runId: text("run_id"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: "string" }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "string" }),
    /** how many runs have observed this same condition */
    occurrences: integer("occurrences").default(1).notNull(),
    /** set when a later, higher-severity signal replaced this one */
    supersededById: text("superseded_by_id"),
    /** set when the underlying condition cleared on a later run */
    autoClosedAt: timestamp("auto_closed_at", { withTimezone: true, mode: "string" }),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("signals_company_idx").on(t.companyId, t.disposition),
    index("signals_project_idx").on(t.projectId),
    index("signals_fingerprint_idx").on(t.companyId, t.detector, t.fingerprint),
    index("signals_subject_idx").on(t.companyId, t.subjectType, t.subjectId),
    index("signals_detector_idx").on(t.companyId, t.detector, t.disposition),
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

/* ================================================================== */
/* Platform upgrade wave — the Domain A detector programme            */
/* ================================================================== */

/**
 * One execution of the detector suite. Persisted so per-detector precision
 * can be measured over a rolling window and so an operator can answer "when
 * did we last look, and what did we look at" without inferring it from the
 * signals a run happened to raise.
 */
export const detectorRuns = pgTable(
  "detector_runs",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null for tenant-wide runs (entity network, ghost-vendor payables) */
    projectId: text("project_id"),
    scope: text("scope").default("project").notNull(), // DetectorRunScope
    /** null when the scheduler ran it — the system is not a user */
    actorId: text("actor_id"),
    trigger: text("trigger").default("manual").notNull(), // manual | scheduled | retrodetect
    detectors: jsonb("detectors").$type<string[]>().default([]).notNull(),
    /** detectors skipped, with the reason (too little data, below precision floor) */
    skipped: jsonb("skipped").$type<Array<{ detector: string; reason: string }>>()
      .default([])
      .notNull(),
    signalsCreated: integer("signals_created").default(0).notNull(),
    /** conditions that were already open — deduped rather than re-raised */
    signalsRefreshed: integer("signals_refreshed").default(0).notNull(),
    /** open signals whose condition no longer holds, closed by this run */
    signalsAutoClosed: integer("signals_auto_closed").default(0).notNull(),
    /** signals a lower-severity predecessor was superseded by */
    signalsSuperseded: integer("signals_superseded").default(0).notNull(),
    perDetector: jsonb("per_detector").$type<Record<string, number>>().default({}).notNull(),
    durationMs: integer("duration_ms"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("detector_runs_company_idx").on(t.companyId, t.startedAt),
    index("detector_runs_project_idx").on(t.projectId, t.startedAt),
  ],
);

/**
 * Typed evidence links for a signal. `signals.evidenceRefs` stays as the
 * detector's own statistical exhibit (counts, chi-square, thresholds); this
 * table is what the UI deep-links from and what an evidence pack includes.
 */
export const signalEvidence = pgTable(
  "signal_evidence",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    signalId: text("signal_id").notNull(),
    objectType: text("object_type").notNull(),
    objectId: text("object_id").notNull(),
    role: text("role").default("supporting").notNull(), // supporting | subject | contradicting
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("signal_evidence_uq").on(t.signalId, t.objectType, t.objectId),
    index("signal_evidence_signal_idx").on(t.signalId),
    index("signal_evidence_object_idx").on(t.companyId, t.objectType, t.objectId),
  ],
);

/**
 * Per-company detector configuration: whether it runs at all, the thresholds
 * it runs with, and the measured-precision floor below which it is suppressed
 * (A#97-99). Absent row = registry defaults.
 */
export const detectorPolicies = pgTable(
  "detector_policies",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    detector: text("detector").notNull(),
    enabled: integer("enabled").default(1).notNull(),
    /** 0..1 — suppress when measured precision falls below this over the window */
    precisionFloor: doublePrecision("precision_floor"),
    /** how many reviewed signals are needed before the floor is applied */
    minReviewedForFloor: integer("min_reviewed_for_floor").default(10).notNull(),
    thresholds: jsonb("thresholds").$type<Record<string, number>>().default({}).notNull(),
    notes: text("notes"),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("detector_policies_uq").on(t.companyId, t.detector)],
);

/**
 * Per-project tolerance bands for the typed reconcilers. Defaults come from
 * the reconciler library; a project can tighten or loosen them, and the
 * reconciliation records the band that was in force.
 */
export const reconciliationPolicies = pgTable(
  "reconciliation_policies",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = company default for this assertion kind */
    projectId: text("project_id"),
    assertionKind: text("assertion_kind").notNull(), // AssertionKind
    /** |variance%| at or below this is "supported" */
    supportedWithinPercent: doublePrecision("supported_within_percent").default(5).notNull(),
    /** …and at or below this is "partially_supported"; beyond it, contradicted */
    partialWithinPercent: doublePrecision("partial_within_percent").default(15).notNull(),
    /** evidence below this independence score does not count towards the test */
    minIndependence: doublePrecision("min_independence").default(0).notNull(),
    /** evidence captured further than this from the claim window is discounted */
    maxCaptureGapDays: doublePrecision("max_capture_gap_days"),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("reconciliation_policies_uq").on(t.companyId, t.projectId, t.assertionKind),
    index("reconciliation_policies_project_idx").on(t.projectId),
  ],
);

/* ------------------------------------------------------------------ */
/* Entity screening, conflicts and authority (Domain A #10, #42-52)    */
/* ------------------------------------------------------------------ */

export const screeningResults = pgTable(
  "screening_results",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    entityId: text("entity_id").notNull(),
    list: text("list").notNull(), // ScreeningList
    /** 0..1 name-match score; 1 = exact normalised match */
    matchScore: doublePrecision("match_score").default(0).notNull(),
    matchedName: text("matched_name"),
    matchedRef: text("matched_ref"),
    /**
     * sha256 of the list snapshot the match was made against. Without it a
     * screening result is unreproducible: "we screened and found nothing" is
     * only meaningful against a stated version of the list.
     */
    listSnapshotHash: text("list_snapshot_hash").notNull(),
    listSource: text("list_source").notNull(),
    disposition: text("disposition").default("pending").notNull(), // ScreeningDisposition
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "string" }),
    reviewNotes: text("review_notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    screenedAt: timestamp("screened_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("screening_results_entity_idx").on(t.entityId, t.screenedAt),
    index("screening_results_company_idx").on(t.companyId, t.disposition),
  ],
);

/** Declared interests, so an UNDECLARED one is a finding rather than a guess. */
export const conflictDeclarations = pgTable(
  "conflict_declarations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    userId: text("user_id").notNull(),
    entityId: text("entity_id").notNull(),
    nature: text("nature").notNull(),
    declaredAt: timestamp("declared_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    /** null = still current */
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "string" }),
    notes: text("notes"),
    recordedBy: text("recorded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("conflict_declarations_uq").on(t.companyId, t.userId, t.entityId, t.nature),
    index("conflict_declarations_user_idx").on(t.companyId, t.userId),
    index("conflict_declarations_entity_idx").on(t.entityId),
  ],
);

/** Delegation-of-authority limits, so an over-limit approval is measurable. */
export const authorityLimits = pgTable(
  "authority_limits",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = applies on every project */
    projectId: text("project_id"),
    userId: text("user_id").notNull(),
    /** what the limit governs: commitment, invoice, change_order, any */
    objectType: text("object_type").default("any").notNull(),
    maxAmount: doublePrecision("max_amount").notNull(),
    currency: text("currency").default("USD").notNull(),
    effectiveFrom: text("effective_from"),
    effectiveTo: text("effective_to"),
    grantedBy: text("granted_by").notNull(),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [
    index("authority_limits_user_idx").on(t.companyId, t.userId),
    index("authority_limits_project_idx").on(t.projectId),
  ],
);

/* ------------------------------------------------------------------ */
/* Integrity scores, cases and evidence packs                          */
/* ------------------------------------------------------------------ */

/**
 * A weighted, decayed exposure score per subject, snapshotted so a trend can
 * be drawn. Higher is worse. Every score carries its components so the number
 * can be argued with — an integrity score nobody can decompose is an
 * accusation, not a measurement.
 */
export const integrityScores = pgTable(
  "integrity_scores",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    scope: text("scope").notNull(), // IntegrityScoreScope
    subjectId: text("subject_id").notNull(),
    subjectLabel: text("subject_label"),
    /** 0..100 exposure */
    score: doublePrecision("score").notNull(),
    band: text("band").notNull(), // IntegrityBand
    openSignals: integer("open_signals").default(0).notNull(),
    confirmedSignals: integer("confirmed_signals").default(0).notNull(),
    components: jsonb("components")
      .$type<Array<{ key: string; weight: number; contribution: number; basis: string }>>()
      .default([])
      .notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("integrity_scores_subject_idx").on(t.companyId, t.scope, t.subjectId, t.computedAt),
    index("integrity_scores_company_idx").on(t.companyId, t.computedAt),
  ],
);

export const integrityCases = pgTable(
  "integrity_cases",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    status: text("status").default("open").notNull(), // IntegrityCaseStatus
    severity: text("severity").default("medium").notNull(), // SignalSeverity
    assignedTo: text("assigned_to"),
    referralTarget: text("referral_target"),
    referredAt: timestamp("referred_at", { withTimezone: true, mode: "string" }),
    openedBy: text("opened_by").notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    closureReason: text("closure_reason"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("integrity_cases_reference_uq").on(t.companyId, t.reference),
    index("integrity_cases_company_idx").on(t.companyId, t.status),
    index("integrity_cases_project_idx").on(t.projectId),
  ],
);

export const integrityCaseItems = pgTable(
  "integrity_case_items",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    caseId: text("case_id").notNull(),
    itemType: text("item_type").notNull(), // IntegrityCaseItemType
    /** null for ledger_range and note items */
    itemId: text("item_id"),
    fromSeq: integer("from_seq"),
    toSeq: integer("to_seq"),
    note: text("note"),
    addedBy: text("added_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("integrity_case_items_case_idx").on(t.caseId),
    index("integrity_case_items_item_idx").on(t.companyId, t.itemType, t.itemId),
  ],
);

/**
 * A persisted evidence pack: the Merkle root, the items and their proofs, the
 * seal sequence in force when it was generated, and — the part that makes it
 * honest — a completeness statement naming what was NOT included and why.
 */
export const evidencePacks = pgTable(
  "evidence_packs",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    title: text("title").notNull(),
    purpose: text("purpose").default("audit").notNull(), // EvidencePackPurpose
    /** merkle root over the item content hashes, in pack order */
    root: text("root").notNull(),
    itemCount: integer("item_count").default(0).notNull(),
    items: jsonb("items")
      .$type<
        Array<{
          objectType: string;
          objectId: string;
          contentHash: string;
          label: string;
          proof: Array<{ hash: string; position: "left" | "right" }>;
        }>
      >()
      .default([])
      .notNull(),
    /** what was linked but left out, and the reason — never silently dropped */
    exclusions: jsonb("exclusions")
      .$type<Array<{ objectType: string; objectId: string; reason: string }>>()
      .default([])
      .notNull(),
    /** the case this pack was assembled for, when it was */
    caseId: text("case_id"),
    /** the seal in force at generation — the pack is anchored into the chain */
    sealId: text("seal_id"),
    sealSequence: integer("seal_sequence"),
    ledgerHeadHash: text("ledger_head_hash"),
    anchorSubmissionId: text("anchor_submission_id"),
    statement: text("statement"),
    generatedBy: text("generated_by").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("evidence_packs_company_idx").on(t.companyId, t.generatedAt),
    index("evidence_packs_project_idx").on(t.projectId),
    index("evidence_packs_case_idx").on(t.caseId),
  ],
);

/** Chain of custody: every hand a pack passed through. */
export const evidencePackAccess = pgTable(
  "evidence_pack_access",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    packId: text("pack_id").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(), // EvidencePackAccessAction
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    at: timestamp("at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  },
  (t) => [index("evidence_pack_access_pack_idx").on(t.packId, t.at)],
);
