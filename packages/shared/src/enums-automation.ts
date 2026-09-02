/**
 * Shared enums for the automation area (platform upgrade wave).
 *
 * The rules engine (Vol I #79–92 workflow automation, #85–86 escalation,
 * Vol II X #1005–1009 automation hooks) reacts to ledger events and to time.
 * Everything a rule is made of — how it fires, what it checks, what it does,
 * and what came of it — is named here so the API, the web builder and the
 * tests speak one vocabulary.
 */

/** Lifecycle of a rule. Only `active` rules fire. */
export const AUTOMATION_RULE_STATUSES = ["draft", "active", "paused", "archived"] as const;
export type AutomationRuleStatus = (typeof AUTOMATION_RULE_STATUSES)[number];

/**
 * `event` fires when a matching ledger entry is appended; `schedule` scans
 * records of one type on an interval and fires for each one whose conditions
 * hold (overdue RFIs, expiring certificates, approaching time bars).
 */
export const AUTOMATION_TRIGGER_KINDS = ["event", "schedule"] as const;
export type AutomationTriggerKind = (typeof AUTOMATION_TRIGGER_KINDS)[number];

/** What one evaluation of a rule came to. */
export const AUTOMATION_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "throttled",
  "dry_run",
] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

/** The executors a rule may chain. */
export const AUTOMATION_ACTION_TYPES = [
  "notify",
  "create_obligation",
  "create_signal",
  "webhook",
  "run_agent",
  "assign",
  "escalate",
  "tag",
  "create_task",
] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

/** Outcome of one action inside a run. */
export const AUTOMATION_ACTION_OUTCOMES = ["done", "failed", "skipped"] as const;
export type AutomationActionOutcome = (typeof AUTOMATION_ACTION_OUTCOMES)[number];

/**
 * Operators the safe predicate evaluator understands. There is no expression
 * language and no eval: a condition is `{ field, op, value }` over the event
 * and the record snapshot, composed with all / any / not.
 */
export const AUTOMATION_CONDITION_OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "not_in",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "exists",
  "not_exists",
  "is_true",
  "is_false",
  "matches",
  "before",
  "after",
  "within_days",
  "older_than_days",
  "due_within_days",
  "overdue_by_days",
] as const;
export type AutomationConditionOperator = (typeof AUTOMATION_CONDITION_OPERATORS)[number];

/** Who a `notify` / `escalate` action reaches. */
export const AUTOMATION_NOTIFY_TARGET_KINDS = [
  "users",
  "roles",
  "distribution_groups",
  "project_members",
  "record_field",
] as const;
export type AutomationNotifyTargetKind = (typeof AUTOMATION_NOTIFY_TARGET_KINDS)[number];

/** Template gallery grouping. */
export const AUTOMATION_TEMPLATE_CATEGORIES = [
  "field",
  "financial",
  "contract",
  "assurance",
  "safety",
  "quality",
  "compliance",
] as const;
export type AutomationTemplateCategory = (typeof AUTOMATION_TEMPLATE_CATEGORIES)[number];
