/**
 * agents — schema for the AI agent fleet (platform upgrade wave, WP-AGENTS).
 *
 * Spec: Vol I §6.4 #759–775 (assistant, agents, transparency), Vol II X
 * #995–1027 (agent governance: authorisation limits #1022, reversibility
 * #1023, adversarial testing #1024, bias assessment #1025, explainability
 * #1026, model validation #1027).
 *
 * `ai_runs` and `ai_review_queue` already exist in ./ai.ts and are NOT
 * modified here — this wave adds the governance layer around them:
 *
 *   agent_policies     per-company, per-kind authorisation and budget ceiling
 *   agent_usage_daily  the counter the ceiling is checked against
 *   agent_run_meta     provenance ai_runs has no column for (prompt version,
 *                      evidence score, dropped citations, who/what asked)
 *   agent_actions      every operational change an agent's proposal caused,
 *                      with the before-image that makes it reversible
 *   agent_schedules    time-driven monitor runs (drained by the tick job)
 *   agent_reports      adversarial / bias / model-validation reports
 *
 * Every table is company-scoped; `projectId` is null for company-wide rows.
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
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();

/**
 * Per-kind authorisation limit and cost ceiling (#1022).
 *
 * A missing row means "the code-resident default for this kind" — a tenant
 * never has to author policy before the fleet works, and a new agent kind
 * ships with its default already in force.
 */
export const agentPolicies = pgTable(
  "agent_policies",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    agentKind: text("agent_kind").notNull(),
    /** 0 disables the kind entirely for this tenant. */
    enabled: integer("enabled").default(1).notNull(),
    /** propose_only | auto_apply_below_threshold | auto_apply */
    authorisation: text("authorisation").default("propose_only").notNull(),
    /** auto-apply only at or above this confidence (null = never auto-apply) */
    autoApplyMinConfidence: doublePrecision("auto_apply_min_confidence"),
    /** target types this kind may write at all, e.g. ["drawing_sheet"] */
    allowedTargetTypes: jsonb("allowed_target_types").$type<string[]>().default([]).notNull(),
    /** company roles allowed to run this kind by hand ([] = any member with ai:standard) */
    allowedRoles: jsonb("allowed_roles").$type<string[]>().default([]).notNull(),
    maxRunsPerDay: integer("max_runs_per_day"),
    maxInputTokensPerDay: integer("max_input_tokens_per_day"),
    maxOutputTokensPerDay: integer("max_output_tokens_per_day"),
    /** proposals below this confidence are recorded but never queued for review */
    minConfidence: doublePrecision("min_confidence"),
    notes: text("notes"),
    updatedBy: text("updated_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("agent_policies_kind_idx").on(t.companyId, t.agentKind),
    index("agent_policies_company_idx").on(t.companyId),
  ],
);

/** Rolling daily usage per company per kind — the budget check reads this. */
export const agentUsageDaily = pgTable(
  "agent_usage_daily",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** YYYY-MM-DD (UTC) */
    usageDate: text("usage_date").notNull(),
    agentKind: text("agent_kind").notNull(),
    runs: integer("runs").default(0).notNull(),
    failures: integer("failures").default(0).notNull(),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    /** micro-units of the platform's accounting currency; never displayed as money */
    estimatedCostMicros: integer("estimated_cost_micros").default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("agent_usage_daily_key_idx").on(t.companyId, t.usageDate, t.agentKind),
    index("agent_usage_daily_company_idx").on(t.companyId, t.usageDate),
  ],
);

/**
 * Provenance for one `ai_runs` row that the frozen table has no column for
 * (#1017/#1018 evidence sufficiency, #775/#1027 model transparency).
 */
export const agentRunMeta = pgTable(
  "agent_run_meta",
  {
    runId: text("run_id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    agentKind: text("agent_kind").notNull(),
    /** sha256(12) of the system prompt template actually sent */
    promptVersion: text("prompt_version").notNull(),
    agentVersion: text("agent_version").notNull(),
    /** user | system | schedule | trigger | automation | review */
    source: text("source").default("user").notNull(),
    /** schedule id, rule id or trigger id that caused the run */
    sourceRef: text("source_ref"),
    /** deterministic 0..1 sufficiency of the evidence the run was given */
    evidenceScore: doublePrecision("evidence_score"),
    evidenceBasis: jsonb("evidence_basis").$type<Record<string, unknown>>().default({}).notNull(),
    /** citations the model returned that were NOT in inputRefs */
    droppedCitations: integer("dropped_citations").default(0).notNull(),
    citationCount: integer("citation_count").default(0).notNull(),
    inputRefCount: integer("input_ref_count").default(0).notNull(),
    /** the record types transmitted to the model (transparency report) */
    dataCategories: jsonb("data_categories").$type<string[]>().default([]).notNull(),
    proposalCount: integer("proposal_count").default(0).notNull(),
    actionCount: integer("action_count").default(0).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("agent_run_meta_company_idx").on(t.companyId, t.agentKind),
    index("agent_run_meta_project_idx").on(t.projectId),
  ],
);

/**
 * Every operational change an agent caused, with the before-image that makes
 * it reversible (#1023). An action is written inside the same transaction as
 * the change itself, so "applied" and "the record moved" are one fact.
 */
export const agentActions = pgTable(
  "agent_actions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    agentKind: text("agent_kind").notNull(),
    runId: text("run_id"),
    reviewId: text("review_id"),
    /** what was done, e.g. "answer_rfi", "rename_sheet", "upsert_daily_log" */
    actionType: text("action_type").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    /** the exact fields, before the change — the inverse operation's payload */
    beforeImage: jsonb("before_image").$type<Record<string, unknown> | null>(),
    afterImage: jsonb("after_image").$type<Record<string, unknown> | null>(),
    /** applied | rolled_back | failed | not_reversible */
    status: text("status").default("applied").notNull(),
    reversible: integer("reversible").default(1).notNull(),
    /** why an action cannot be reversed, when reversible = 0 */
    irreversibleReason: text("irreversible_reason"),
    appliedBy: text("applied_by"),
    appliedAt: timestamp("applied_at", { withTimezone: true, mode: "string" }),
    rolledBackBy: text("rolled_back_by"),
    rolledBackAt: timestamp("rolled_back_at", { withTimezone: true, mode: "string" }),
    rollbackReason: text("rollback_reason"),
    /** whether a human approved it or a policy auto-applied it */
    authorisation: text("authorisation").default("propose_only").notNull(),
    policyId: text("policy_id"),
    confidence: doublePrecision("confidence"),
    summary: text("summary"),
    createdAt: createdAt(),
  },
  (t) => [
    index("agent_actions_company_idx").on(t.companyId, t.status),
    index("agent_actions_project_idx").on(t.projectId),
    index("agent_actions_target_idx").on(t.targetType, t.targetId),
    index("agent_actions_review_idx").on(t.reviewId),
  ],
);

/** A monitor that runs on a clock. The tick job drains what is due. */
export const agentSchedules = pgTable(
  "agent_schedules",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    agentKind: text("agent_kind").notNull(),
    name: text("name"),
    enabled: integer("enabled").default(1).notNull(),
    everyMinutes: integer("every_minutes").default(1440).notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().default({}).notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: "string" }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true, mode: "string" }),
    /** queued | running | done | failed | skipped */
    lastStatus: text("last_status"),
    lastError: text("last_error"),
    lastRunId: text("last_run_id"),
    runCount: integer("run_count").default(0).notNull(),
    failureCount: integer("failure_count").default(0).notNull(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("agent_schedules_due_idx").on(t.enabled, t.nextRunAt),
    index("agent_schedules_company_idx").on(t.companyId, t.agentKind),
  ],
);

/**
 * Governance reports over the fleet: adversarial detector testing (#1024),
 * bias assessment over vendor/worker-affecting outputs (#1025) and model
 * validation (#1027). Deterministic — computed from stored rows, not the
 * model, so a report is reproducible and available with no API key.
 */
export const agentReports = pgTable(
  "agent_reports",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    /** adversarial | bias | validation */
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    /** the full computed report, including every basis figure */
    data: jsonb("data").$type<Record<string, unknown>>().default({}).notNull(),
    windowFrom: text("window_from"),
    windowTo: text("window_to"),
    generatedBy: text("generated_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("agent_reports_company_idx").on(t.companyId, t.kind),
    index("agent_reports_project_idx").on(t.projectId),
  ],
);
