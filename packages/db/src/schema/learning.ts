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

/**
 * Domain W — Organisational learning (spec #976-994).
 *
 * Lessons-learned registers fail for one reason everywhere: capture is
 * voluntary and retrieval is nobody's job. This module inverts both. Capture
 * is triggered by events the platform already records (a dispute closing, a
 * variation crossing a threshold, a confirmed signal) and the trigger raises
 * an Obligation that only a lesson discharges (#977). Retrieval is bound to
 * the record being created rather than to a search box someone must remember
 * to visit.
 */
export const lessons = pgTable(
  "lessons",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null once a lesson is published company-wide */
    projectId: text("project_id"),
    /** the project it was learned on, retained after publication */
    originProjectId: text("origin_project_id"),
    number: text("number").notNull(),
    title: text("title").notNull(),
    category: text("category").notNull(), // LessonCategory
    /** the project phase it belongs to, for retrieval at the right moment */
    phase: text("phase"),
    context: text("context"),
    whatHappened: text("what_happened").notNull(),
    rootCause: text("root_cause"),
    recommendation: text("recommendation").notNull(),
    /** what it cost — the number that makes a lesson land */
    impactValue: doublePrecision("impact_value"),
    impactCurrency: text("impact_currency"),
    impactDays: integer("impact_days"),
    tags: jsonb("tags").$type<string[]>().default([]).notNull(),
    /** platform records evidencing the lesson */
    evidenceRefs: jsonb("evidence_refs").$type<unknown[]>().default([]).notNull(),
    status: text("status").default("draft").notNull(), // LessonStatus
    /** validation is a second pair of eyes, and may not be the author */
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    validatedBy: text("validated_by"),
    validatedAt: timestamp("validated_at", { withTimezone: true, mode: "string" }),
    rejectionReason: text("rejection_reason"),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "string" }),
    supersededById: text("superseded_by_id"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("lessons_company_idx").on(t.companyId),
    index("lessons_category_idx").on(t.companyId, t.category),
    index("lessons_status_idx").on(t.companyId, t.status),
    index("lessons_origin_idx").on(t.companyId, t.originProjectId),
  ],
);

/**
 * The half every lessons register omits: was the lesson ever acted on?
 * An application binds a published lesson to a later record on another
 * project, which is the only evidence that learning crossed a project boundary.
 */
export const lessonApplications = pgTable(
  "lesson_applications",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    lessonId: text("lesson_id").notNull(),
    projectId: text("project_id").notNull(),
    /** the record the lesson was applied to: { tool, recordId, label } */
    appliedTo: jsonb("applied_to").$type<Record<string, unknown>>().default({}).notNull(),
    action: text("action").notNull(),
    outcomeNote: text("outcome_note"),
    /*
     * OUTCOME MEASUREMENT (#984). An application with no measured outcome is
     * `unknown` and stays `unknown` — counting it as a success is exactly how
     * a lessons register comes to report impact it never had. The measurement
     * is a separate act by a separate person and carries its own date.
     */
    outcome: text("outcome").default("unknown").notNull(), // LessonOutcome
    outcomeValue: doublePrecision("outcome_value"),
    outcomeCurrency: text("outcome_currency"),
    outcomeDays: integer("outcome_days"),
    measuredAt: timestamp("measured_at", { withTimezone: true, mode: "string" }),
    measuredBy: text("measured_by"),
    appliedBy: text("applied_by").notNull(),
    appliedAt: createdAt(),
  },
  (t) => [
    index("lesson_applications_lesson_idx").on(t.lessonId),
    index("lesson_applications_project_idx").on(t.projectId),
    index("lesson_applications_outcome_idx").on(t.companyId, t.outcome),
  ],
);

/**
 * CROSS-PROJECT RELEVANCE PUSH (#985–986).
 *
 * Retrieval that waits to be searched for is retrieval that does not happen.
 * When a lesson is published, the projects it plausibly applies to are
 * computed from the deterministic ranker and the lesson is PUSHED to their
 * teams — and the push itself is a record, so "we told them" is checkable and
 * the rate at which pushes become applications is measurable.
 */
export const lessonPushes = pgTable(
  "lesson_pushes",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    lessonId: text("lesson_id").notNull(),
    /** the project the lesson was pushed TO (never its origin) */
    projectId: text("project_id").notNull(),
    /** the ranker's score and the reasons it gave, kept for honesty */
    score: doublePrecision("score"),
    reasons: jsonb("reasons").$type<unknown[]>().default([]).notNull(),
    status: text("status").default("pushed").notNull(), // LessonPushStatus
    notifiedUserIds: jsonb("notified_user_ids").$type<string[]>().default([]).notNull(),
    acknowledgedBy: text("acknowledged_by"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true, mode: "string" }),
    /** set when the push turned into a real application */
    applicationId: text("application_id"),
    dismissedReason: text("dismissed_reason"),
    pushedAt: createdAt(),
  },
  (t) => [
    uniqueIndex("lesson_pushes_uq").on(t.lessonId, t.projectId),
    index("lesson_pushes_project_idx").on(t.projectId, t.status),
    index("lesson_pushes_company_idx").on(t.companyId, t.status),
  ],
);

/**
 * A mandatory-capture trigger raised by another module. Open triggers are the
 * learning backlog; the obligation is what makes them unignorable.
 */
export const lessonTriggers = pgTable(
  "lesson_triggers",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    kind: text("kind").notNull(), // LessonTriggerKind
    /** the record that fired the trigger: { tool, recordId, label } */
    sourceRef: jsonb("source_ref").$type<Record<string, unknown>>().default({}).notNull(),
    /**
     * `sourceRef.recordId`, denormalised so the database — not a Set held in
     * one request's memory — enforces one trigger per (project, kind, record).
     * The in-memory check let two people opening the Triggers tab at the same
     * moment create two obligations for the same dispute, doubling the
     * capture-rate denominator with no way to tell which was real.
     */
    sourceKey: text("source_key"),
    /** why this crossed the mandatory threshold, in words */
    rationale: text("rationale").notNull(),
    dueAt: text("due_at"),
    obligationId: text("obligation_id"),
    /** the lesson that discharged it, once captured */
    lessonId: text("lesson_id"),
    status: text("status").default("open").notNull(),
    dismissedReason: text("dismissed_reason"),
    dismissedBy: text("dismissed_by"),
    raisedAt: createdAt(),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    index("lesson_triggers_company_idx").on(t.companyId),
    index("lesson_triggers_project_idx").on(t.projectId, t.status),
    /* DB-level sweep idempotency. NULLs do not collide, so legacy rows with no
       sourceKey are tolerated while every new row is unique by construction. */
    uniqueIndex("lesson_triggers_source_uq").on(t.projectId, t.kind, t.sourceKey),
  ],
);

/** Post-project review (#990-994), held against the project's own record. */
export const postProjectReviews = pgTable(
  "post_project_reviews",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    title: text("title").notNull(),
    status: text("status").default("scheduled").notNull(), // ReviewStatus
    scheduledFor: text("scheduled_for"),
    heldAt: text("held_at"),
    facilitator: text("facilitator"),
    participants: jsonb("participants").$type<unknown[]>().default([]).notNull(),
    /**
     * Outturn against intent, computed from platform records rather than
     * recalled: budget vs outturn, baseline vs actual finish, variation count,
     * signals raised, obligations missed.
     */
    metrics: jsonb("metrics").$type<Record<string, unknown>>().default({}).notNull(),
    findings: jsonb("findings").$type<unknown[]>().default([]).notNull(),
    whatWentWell: text("what_went_well"),
    whatDidNot: text("what_did_not"),
    signedOffBy: text("signed_off_by"),
    signedOffAt: timestamp("signed_off_at", { withTimezone: true, mode: "string" }),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("post_project_reviews_project_idx").on(t.projectId)],
);

/* ------------------------------------------------------------------ */
/* KNOWLEDGE GRAPH (#992)                                              */
/* ------------------------------------------------------------------ */

/**
 * A lesson's edges, materialised.
 *
 * `lessons.evidenceRefs` is free-form JSON: it says a lesson came out of
 * dispute D-004 but nothing can verify that D-004 exists, nothing can ask the
 * reverse question ("which lessons cite this dispute?"), and nothing notices
 * when the record is deleted. This table is the verified half: every edge was
 * checked against a real row in the same company at the moment it was written,
 * carries WHY it exists, and is indexed in both directions.
 *
 * Four edge kinds, because four different questions get asked:
 *   record  → the dispute/variation/NCR the lesson came out of (also mirrored
 *             into `record_links` so the rest of the platform sees it)
 *   person  → author, validator, applier — who carries this knowledge
 *   tag     → the vocabulary the register is actually organised by
 *   lesson  → supersession and "see also", so a superseded lesson still leads
 *             somewhere rather than dead-ending
 *
 * Deliberately NOT a general graph store: no arbitrary node table, no path
 * queries. Two hops answer every question the product asks, and a schema that
 * cannot express nonsense is worth more than one that can express anything.
 */
export const lessonEdges = pgTable(
  "lesson_edges",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    lessonId: text("lesson_id").notNull(),
    /** LessonEdgeKind: record | person | tag | lesson */
    edgeKind: text("edge_kind").notNull(),
    /** the target's record type ("dispute", "user", "tag", "lesson", …) */
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    /** display label captured at write time, so a deleted target still reads */
    targetLabel: text("target_label"),
    /** the project the target lives on, when it lives on one */
    targetProjectId: text("target_project_id"),
    /** LessonEdgeRole: origin | evidence | author | validator | applier | … */
    role: text("role").notNull(),
    /** true when the target row was confirmed present at write time */
    verified: integer("verified").default(0).notNull(),
    /** the record_links row this edge was mirrored into, when it was */
    recordLinkId: text("record_link_id"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("lesson_edges_uq").on(t.lessonId, t.edgeKind, t.targetType, t.targetId, t.role),
    index("lesson_edges_lesson_idx").on(t.lessonId),
    index("lesson_edges_target_idx").on(t.companyId, t.targetType, t.targetId),
    index("lesson_edges_kind_idx").on(t.companyId, t.edgeKind),
  ],
);

/* ------------------------------------------------------------------ */
/* FEEDBACK INTO THE LIBRARIES (#981-984)                              */
/* ------------------------------------------------------------------ */

/**
 * What a thing actually cost, and how long it actually took, computed from
 * finished work rather than remembered.
 *
 * An estimating rate library that is never fed by outturn is a library of
 * opinions. These two tables hold the OBSERVED distribution per element
 * (rates) and per activity (durations), with the sample it was computed from
 * named — project ids, n, the estimate it is being compared against — so a
 * planner can see that "p80 = 14 days" rests on four jobs, not four hundred,
 * and discount it accordingly.
 *
 * Nothing is applied automatically. A proposal is computed by the sweep and an
 * admin accepts it; the accepted row becomes the library entry and the one it
 * replaced is kept, superseded, so the library has a history.
 */
export const rateLibraryEntries = pgTable(
  "rate_library_entries",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** cost code / BoQ element code the rate belongs to */
    elementCode: text("element_code").notNull(),
    description: text("description"),
    unit: text("unit").notNull(),
    currency: text("currency").notNull(),
    /* observed distribution */
    sampleSize: integer("sample_size").notNull(),
    medianRate: doublePrecision("median_rate"),
    p80Rate: doublePrecision("p80_rate"),
    meanRate: doublePrecision("mean_rate"),
    minRate: doublePrecision("min_rate"),
    maxRate: doublePrecision("max_rate"),
    /* what the estimate said, where an estimate was recorded */
    estimatedRate: doublePrecision("estimated_rate"),
    /** median actual ÷ estimate − 1, as a fraction; null when no estimate */
    accuracyRatio: doublePrecision("accuracy_ratio"),
    sourceProjectIds: jsonb("source_project_ids").$type<string[]>().default([]).notNull(),
    /** the individual observations, bounded, so the number can be argued with */
    samples: jsonb("samples").$type<unknown[]>().default([]).notNull(),
    /** LibraryEntryStatus: proposed | accepted | rejected | superseded */
    status: text("status").default("proposed").notNull(),
    /** why this proposal exists / why it was rejected */
    note: text("note"),
    supersedesId: text("supersedes_id"),
    acceptedBy: text("accepted_by"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" }),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("rate_library_company_idx").on(t.companyId, t.status),
    index("rate_library_element_idx").on(t.companyId, t.elementCode, t.status),
  ],
);

export const durationLibraryEntries = pgTable(
  "duration_library_entries",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** the activity code the duration belongs to (WBS code, task code) */
    activityCode: text("activity_code").notNull(),
    description: text("description"),
    /** what one unit of the sample is — always "days" today, named anyway */
    unit: text("unit").default("days").notNull(),
    sampleSize: integer("sample_size").notNull(),
    medianDays: doublePrecision("median_days"),
    p80Days: doublePrecision("p80_days"),
    meanDays: doublePrecision("mean_days"),
    minDays: doublePrecision("min_days"),
    maxDays: doublePrecision("max_days"),
    plannedDays: doublePrecision("planned_days"),
    /** median actual ÷ planned − 1; the optimism bias, measured */
    accuracyRatio: doublePrecision("accuracy_ratio"),
    sourceProjectIds: jsonb("source_project_ids").$type<string[]>().default([]).notNull(),
    samples: jsonb("samples").$type<unknown[]>().default([]).notNull(),
    status: text("status").default("proposed").notNull(),
    note: text("note"),
    supersedesId: text("supersedes_id"),
    acceptedBy: text("accepted_by"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" }),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("duration_library_company_idx").on(t.companyId, t.status),
    index("duration_library_activity_idx").on(t.companyId, t.activityCode, t.status),
  ],
);

/**
 * RISK REALISATION (#984).
 *
 * A risk register is a set of predictions. Nobody ever goes back to see which
 * ones came true, so the next project's register repeats the same optimistic
 * probabilities. One row per realised risk records what was predicted and what
 * actually happened, so the company template can be told.
 */
export const riskRealisations = pgTable(
  "risk_realisations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    riskId: text("risk_id").notNull(),
    riskReference: text("risk_reference"),
    category: text("category"),
    title: text("title"),
    /* what the register predicted, at the moment it was realised */
    predictedProbability: doublePrecision("predicted_probability"),
    predictedImpact: doublePrecision("predicted_impact"),
    predictedCurrency: text("predicted_currency"),
    /* what happened */
    realisedAt: text("realised_at"),
    realisedImpact: doublePrecision("realised_impact"),
    realisedCurrency: text("realised_currency"),
    realisedDays: integer("realised_days"),
    /** the record that proves it materialised: variation, delay event, dispute */
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("risk_realisations_uq").on(t.riskId, t.sourceType, t.sourceId),
    index("risk_realisations_company_idx").on(t.companyId, t.category),
    index("risk_realisations_project_idx").on(t.projectId),
  ],
);
