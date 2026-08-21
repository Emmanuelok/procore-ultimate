import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();

/**
 * AI agent audit trail (spec Vol I #774, Domain X #1021): every model
 * invocation with its inputs' provenance, outputs, and token usage.
 */
export const aiRuns = pgTable(
  "ai_runs",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    agentKind: text("agent_kind").notNull(), // AiAgentKind
    model: text("model").notNull(),
    requestedBy: text("requested_by").notNull(),
    /** input record references, e.g. [{type:"submittal", id:"..."}] */
    inputRefs: jsonb("input_refs").$type<unknown[]>().default([]).notNull(),
    prompt: text("prompt"),
    output: text("output"),
    /** structured output when the agent returns JSON */
    outputJson: jsonb("output_json").$type<unknown>(),
    /** source citations for every assertion (Domain X #1019) */
    citations: jsonb("citations").$type<unknown[]>().default([]).notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms"),
    status: text("status").default("succeeded").notNull(), // succeeded | failed | refused
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    index("ai_runs_company_idx").on(t.companyId),
    index("ai_runs_project_idx").on(t.projectId),
  ],
);

/**
 * Human-in-the-loop review queue for consequential AI outputs
 * (spec Domain X #1020). Nothing an agent proposes takes effect on an
 * operational record until a human approves the queue item.
 */
export const aiReviewQueue = pgTable(
  "ai_review_queue",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    runId: text("run_id").notNull(),
    targetType: text("target_type").notNull(), // record type the proposal affects
    targetId: text("target_id"),
    proposal: jsonb("proposal").$type<unknown>().notNull(),
    summary: text("summary").notNull(),
    confidence: doublePrecision("confidence"),
    status: text("status").default("pending").notNull(), // AiReviewStatus
    reviewerId: text("reviewer_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
  },
  (t) => [index("ai_review_queue_status_idx").on(t.companyId, t.status)],
);
