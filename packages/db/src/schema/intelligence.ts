/**
 * intelligence — schema for the platform upgrade wave (Vol I §6.1–6.3, §7;
 * Vol II X #1010–1012, #1017–1018).
 *
 * Four tables, all company-scoped, project-scoped where the record belongs
 * to a project:
 *
 *   project_health_snapshots  one row per health computation; the latest row
 *                             is "the" health, the series is the trend.
 *   attention_items           the ranked attention feed, materialised by the
 *                             refresh job so the Pulse read is one indexed
 *                             query. Ids are deterministic (company + source +
 *                             kind) so a dismissal survives every refresh.
 *   pulse_snapshots           the company roll-up the Pulse page reads — one
 *                             row per refresh, kept for "since yesterday".
 *   pulse_briefings           the audited daily briefing (ai_runs.id link,
 *                             citations, proposals routed to the review queue).
 */
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

export const projectHealthSnapshots = pgTable(
  "project_health_snapshots",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    /** HealthLevel */
    level: text("level").notNull(),
    /** 0..100, null when unrated */
    score: doublePrecision("score"),
    /** how many dimensions carried a score */
    ratedDimensions: integer("rated_dimensions").default(0).notNull(),
    /** Array<{ key, score, level, basis, inputs }> — the explainable breakdown */
    dimensions: jsonb("dimensions").$type<unknown[]>().default([]).notNull(),
    /** HealthRecomputeTrigger */
    trigger: text("trigger").default("interval").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "string" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("project_health_snapshots_project_idx").on(t.projectId, t.computedAt),
    index("project_health_snapshots_company_idx").on(t.companyId, t.computedAt),
  ],
);

export const attentionItems = pgTable(
  "attention_items",
  {
    /** deterministic: att_<sha256(company|sourceType|sourceId|kind)> */
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    projectName: text("project_name"),
    /** AttentionKind (open vocabulary) */
    kind: text("kind").notNull(),
    /** AttentionSeverity */
    severity: text("severity").notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true, mode: "string" }),
    /** SPA path the item links to */
    href: text("href").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    /** severity × urgency × money — the feed's sort key */
    score: doublePrecision("score").default(0).notNull(),
    /** money at stake in `currency`, when the source carries one */
    money: doublePrecision("money"),
    currency: text("currency"),
    /** AttentionStatus */
    status: text("status").default("open").notNull(),
    dismissedBy: text("dismissed_by"),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true, mode: "string" }),
    dismissReason: text("dismiss_reason"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: "string" }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "string" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("attention_items_source_uq").on(t.companyId, t.sourceType, t.sourceId, t.kind),
    index("attention_items_company_idx").on(t.companyId, t.status, t.score),
    index("attention_items_project_idx").on(t.projectId, t.status),
    index("attention_items_due_idx").on(t.companyId, t.dueAt),
  ],
);

export const pulseSnapshots = pgTable(
  "pulse_snapshots",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true, mode: "string" }).notNull(),
    /** { projects, byStage, byHealth } */
    portfolio: jsonb("portfolio").$type<Record<string, unknown>>().default({}).notNull(),
    /** ProjectHealth[] (latest per project, trend trimmed) */
    scores: jsonb("scores").$type<unknown[]>().default([]).notNull(),
    /** counts of open attention by severity */
    attentionBySeverity: jsonb("attention_by_severity")
      .$type<Record<string, number>>()
      .default({})
      .notNull(),
    openAttention: integer("open_attention").default(0).notNull(),
    /** what changed vs the snapshot ~a day earlier: { since, ... } */
    changes: jsonb("changes").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("pulse_snapshots_company_idx").on(t.companyId, t.generatedAt)],
);

export const pulseBriefings = pgTable(
  "pulse_briefings",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = company-wide briefing */
    projectId: text("project_id"),
    /** ai_runs.id — every briefing is an audited model invocation */
    runId: text("run_id").notNull(),
    headline: text("headline").notNull(),
    summary: text("summary").notNull(),
    /** Array<{ text, citations: number[] }> */
    highlights: jsonb("highlights").$type<unknown[]>().default([]).notNull(),
    /** Array<{ ref, sourceType, sourceId, label }> — the numbered evidence list */
    citations: jsonb("citations").$type<unknown[]>().default([]).notNull(),
    /** Array<{ title, rationale, kind, attentionId, citations, reviewId }> */
    proposals: jsonb("proposals").$type<unknown[]>().default([]).notNull(),
    /** ai_review_queue ids created for the proposals */
    reviewIds: jsonb("review_ids").$type<string[]>().default([]).notNull(),
    requestedBy: text("requested_by").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true, mode: "string" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("pulse_briefings_company_idx").on(t.companyId, t.generatedAt),
    index("pulse_briefings_project_idx").on(t.projectId, t.generatedAt),
  ],
);
