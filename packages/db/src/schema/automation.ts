/**
 * automation — schema for the rules engine (platform upgrade wave).
 *
 * Spec: Vol I #79–92 (workflow automation), #85–86 (escalation), Vol II X
 * #1005–1009 (automation hooks on the assurance layer).
 *
 * Two tables. A RULE is trigger + conditions + actions, authored by a tenant
 * (or instantiated from the code-resident template library). A RUN is one
 * evaluation of one rule against one event or one scanned record: what the
 * conditions came to, what each action did, and what went wrong. Runs are the
 * operator's evidence and the loop guard's memory.
 *
 * The trigger is stored twice on purpose: as the full JSON the builder edits,
 * and as three denormalised text columns (`triggerKind`, `triggerObjectType`,
 * `triggerAction`) that the ledger hook can select on with one index. The
 * hook runs after EVERY ledger append on the platform, so it must cost one
 * indexed lookup and nothing more for the tenants that have no rules.
 *
 * Both tables are company-scoped; `projectId` is null for a company-wide rule
 * and set when the rule (or the run's record) belongs to one project.
 */
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

/** The builder's trigger JSON. Kept loose here; the API validates it with zod. */
export interface AutomationTriggerJson {
  kind: "event" | "schedule";
  /** ledger objectType (e.g. "rfi") or "*" for any */
  objectType: string;
  /** ledger action for `event` triggers, or "*" */
  action?: string;
  /** `schedule` only: how often the scan runs */
  everyMinutes?: number;
  /** `schedule` only: do not fire twice for the same record inside this window */
  cooldownHours?: number;
}

export interface AutomationConditionLeaf {
  field: string;
  op: string;
  value?: unknown;
}
export type AutomationConditionJson =
  | AutomationConditionLeaf
  | { all: AutomationConditionJson[] }
  | { any: AutomationConditionJson[] }
  | { not: AutomationConditionJson };

export interface AutomationActionJson {
  type: string;
  /** executor-specific parameters, validated per type by the API */
  params: Record<string, unknown>;
}

export const automationRules = pgTable(
  "automation_rules",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = company-wide (fires for every project and for company-level records) */
    projectId: text("project_id"),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").default("draft").notNull(), // AutomationRuleStatus
    /** template this rule was instantiated from, if any */
    templateKey: text("template_key"),
    trigger: jsonb("trigger").$type<AutomationTriggerJson>().notNull(),
    triggerKind: text("trigger_kind").notNull(), // AutomationTriggerKind
    triggerObjectType: text("trigger_object_type").notNull(),
    /** "*" for any action; always "*" for schedule triggers */
    triggerAction: text("trigger_action").default("*").notNull(),
    /** null = no conditions: every matching trigger fires */
    conditions: jsonb("conditions").$type<AutomationConditionJson | null>(),
    actions: jsonb("actions").$type<AutomationActionJson[]>().default([]).notNull(),
    /**
     * 1 = execute synchronously on the ledger hook (bounded, guarded);
     * 0 = enqueue and let the drain job execute. Schedule rules ignore it.
     */
    immediate: integer("immediate").default(0).notNull(),
    /** lower runs first when several rules match one event */
    priority: integer("priority").default(100).notNull(),
    runCount: integer("run_count").default(0).notNull(),
    failureCount: integer("failure_count").default(0).notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: "string" }),
    /** schedule triggers: when the scan last ran for this rule */
    lastScanAt: timestamp("last_scan_at", { withTimezone: true, mode: "string" }),
    lastError: text("last_error"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("automation_rules_company_idx").on(t.companyId, t.status),
    index("automation_rules_trigger_idx").on(
      t.companyId,
      t.status,
      t.triggerKind,
      t.triggerObjectType,
      t.triggerAction,
    ),
    index("automation_rules_project_idx").on(t.projectId),
  ],
);

export interface AutomationConditionEvaluation {
  field: string;
  op: string;
  expected: unknown;
  actual: unknown;
  result: boolean;
}

export interface AutomationConditionResult {
  matched: boolean;
  /** null when the rule has no conditions */
  evaluations: AutomationConditionEvaluation[] | null;
  reason: string;
}

export interface AutomationActionResult {
  index: number;
  type: string;
  outcome: "done" | "failed" | "skipped";
  detail: Record<string, unknown>;
  error: string | null;
  durationMs: number;
}

export interface AutomationRunContext {
  event: {
    seq: number | null;
    action: string;
    objectType: string;
    objectId: string;
    actorId: string | null;
    at: string;
  } | null;
  /** record snapshot when the object type is known to the registry */
  record: Record<string, unknown> | null;
  recordKnown: boolean;
}

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    ruleId: text("rule_id").notNull(),
    /** rule name at the time — a renamed or deleted rule keeps its history legible */
    ruleName: text("rule_name").notNull(),
    triggerKind: text("trigger_kind").notNull(),
    /** ledger seq that fired an event rule; null for schedule scans and dry runs */
    eventSeq: integer("event_seq"),
    objectType: text("object_type").notNull(),
    objectId: text("object_id").notNull(),
    action: text("action").notNull(),
    status: text("status").default("queued").notNull(), // AutomationRunStatus
    /** 1 = evaluated only, nothing executed */
    dryRun: integer("dry_run").default(0).notNull(),
    /** the run whose action caused the event that fired this run (loop guard depth) */
    causedByRunId: text("caused_by_run_id"),
    depth: integer("depth").default(0).notNull(),
    context: jsonb("context").$type<AutomationRunContext>(),
    conditionResult: jsonb("condition_result").$type<AutomationConditionResult | null>(),
    actionResults: jsonb("action_results").$type<AutomationActionResult[]>().default([]).notNull(),
    /** number of actions that executed (done or failed) — the per-minute rate limit counts these */
    actionCount: integer("action_count").default(0).notNull(),
    /** execution attempts; a run deferred by the rate limit re-queues until MAX_ATTEMPTS */
    attempts: integer("attempts").default(0).notNull(),
    error: text("error"),
    /** who caused the triggering event; null for system/schedule */
    actorId: text("actor_id"),
    queuedAt: timestamp("queued_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("automation_runs_company_idx").on(t.companyId, t.createdAt),
    index("automation_runs_status_idx").on(t.companyId, t.status),
    index("automation_runs_rule_idx").on(t.ruleId, t.createdAt),
    index("automation_runs_object_idx").on(t.ruleId, t.objectType, t.objectId, t.createdAt),
    index("automation_runs_project_idx").on(t.projectId),
  ],
);
