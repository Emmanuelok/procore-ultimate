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
