/**
 * Shared types and helpers for the Automation workspace (Vol I #79–92
 * workflow automation, #85–86 escalation; Vol II X #1005–1009 automation
 * hooks).
 *
 * The view-models mirror `apps/api/src/modules/automation` exactly. The page
 * renders at two scopes with one component tree:
 *
 *   · /automation                     — company-wide: every rule the caller
 *     may see, the template library, the run log, and (owner/admin) the
 *     engine's own health.
 *   · /projects/:projectId/automation — the same workspace filtered to one
 *     project, through the project routes and the `automation` tool gate.
 *
 * `useScope()` is the only thing that knows which one it is.
 */
import { useParams } from "react-router-dom";
import { ApiClientError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import type { Tone } from "../../ui";

/* ================================ Lists ================================== */

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Accept the paginate() envelope or a bare array so drift degrades gracefully. */
export function asList<T>(res: unknown): { items: T[]; total: number } {
  if (Array.isArray(res)) return { items: res as T[], total: res.length };
  if (res && typeof res === "object" && Array.isArray((res as { items?: unknown }).items)) {
    const r = res as { items: T[]; total?: number };
    return { items: r.items, total: typeof r.total === "number" ? r.total : r.items.length };
  }
  return { items: [], total: 0 };
}

/* ================================ Types ================================== */

export interface TriggerJson {
  kind: "event" | "schedule";
  objectType: string;
  action?: string;
  everyMinutes?: number;
  cooldownHours?: number;
}

export interface ConditionLeaf {
  field: string;
  op: string;
  value?: unknown;
}
export type ConditionJson =
  | ConditionLeaf
  | { all: ConditionJson[] }
  | { any: ConditionJson[] }
  | { not: ConditionJson };

export interface ActionJson {
  type: string;
  params: Record<string, unknown>;
}

export interface RuleView {
  id: string;
  companyId: string;
  projectId: string | null;
  name: string;
  description: string | null;
  status: string; // draft | active | paused | archived
  templateKey: string | null;
  trigger: TriggerJson;
  triggerKind: string;
  triggerObjectType: string;
  triggerAction: string;
  conditions: ConditionJson | null;
  actions: ActionJson[];
  immediate: boolean;
  priority: number;
  runCount: number;
  failureCount: number;
  lastRunAt: string | null;
  lastScanAt: string | null;
  lastError: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  scope: "company" | "project";
}

export interface ConditionEvaluation {
  field: string;
  op: string;
  expected: unknown;
  actual: unknown;
  result: boolean;
}

export interface ConditionResult {
  matched: boolean;
  evaluations: ConditionEvaluation[] | null;
  reason: string;
}

export interface ActionResult {
  index: number;
  type: string;
  outcome: "done" | "failed" | "skipped";
  detail: Record<string, unknown>;
  error: string | null;
  durationMs: number;
}

export interface RunContext {
  event: {
    seq: number | null;
    action: string;
    objectType: string;
    objectId: string;
    actorId: string | null;
    at: string;
  } | null;
  record: Record<string, unknown> | null;
  recordKnown: boolean;
}

export interface RunView {
  id: string;
  companyId: string;
  projectId: string | null;
  ruleId: string;
  ruleName: string;
  triggerKind: string;
  eventSeq: number | null;
  objectType: string;
  objectId: string;
  action: string;
  status: string; // queued | running | succeeded | failed | skipped | throttled | dry_run
  dryRun: number;
  causedByRunId: string | null;
  depth: number;
  context: RunContext | null;
  conditionResult: ConditionResult | null;
  actionResults: ActionResult[];
  actionCount: number;
  attempts: number;
  error: string | null;
  actorId: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface CatalogueField {
  path: string;
  type: "text" | "number" | "date" | "datetime" | "boolean" | "enum" | "user" | "vendor" | "list";
  label: string;
  options?: readonly string[];
}

export interface CatalogueObjectType {
  objectType: string;
  label: string;
  projectScoped: boolean;
  openStatuses: readonly string[] | null;
  assignField: string | null;
  dueField: string | null;
  titleField: string;
  fields: CatalogueField[];
}

export interface CatalogueAction {
  type: string;
  label: string;
  description: string;
  params: string[];
}

export interface Catalogue {
  objectTypes: CatalogueObjectType[];
  triggerKinds: readonly string[];
  ledgerActions: readonly string[];
  operators: readonly string[];
  actions: CatalogueAction[];
  notifyTargetKinds: readonly string[];
  notificationKinds: readonly string[];
  signalSeverities: readonly string[];
  derivedFields: Array<{ path: string; type: string; label: string; appliesTo: string[] }>;
  contextRoots: readonly string[];
  limits: { maxActionsPerMinute: number; maxChainDepth: number; maxActionsPerRule: number };
}

export interface TemplateView {
  key: string;
  name: string;
  description: string;
  category: string;
  spec: string[];
  trigger: TriggerJson;
  conditions: ConditionJson | null;
  actions: ActionJson[];
  immediate: boolean;
  tunables: string[];
}

export interface SummaryView {
  generatedAt: string;
  rulesByStatus: Record<string, number>;
  runs24h: Record<string, number>;
  actions24h: number;
  queued: number;
}

export interface EngineHealth {
  eventsSeen: number;
  eventsMatched: number;
  runsEnqueued: number;
  runsExecuted: number;
  runsFailed: number;
  runsThrottled: number;
  hookFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface SchedulerJobView {
  name: string;
  description: string;
  everyMs: number;
  state: string;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastResult: unknown;
  runCount: number;
  failureCount: number;
  nextDueAt: string | null;
}

export interface StatusView {
  engine: EngineHealth;
  options: {
    maxActionsPerMinute: number;
    maxChainDepth: number;
    maxAttempts: number;
    drainBatch: number;
    requestTimeoutMs: number;
    webhookSigning: string;
  };
  jobs: SchedulerJobView[];
  scheduler: { enabled: boolean };
}

export interface CycleResult {
  at: string;
  scan: { rulesScanned: number; candidates: number; matched: number; deduped: number; executed: number } | null;
  drain: { executed: number; succeeded: number; failed: number; skipped: number; deferred: number; throttled: number } | null;
  health: EngineHealth;
}

export interface DryRunResult {
  matched: boolean;
  conditionResult: ConditionResult;
  plannedActions: Array<{ index: number; type: string; description: string; wouldRun: boolean }>;
  context: {
    event: RunContext["event"];
    record: Record<string, unknown> | null;
    derived: Record<string, unknown>;
    recordSource: "loaded" | "sample" | "none";
  };
  warnings: string[];
  runId: string | null;
}

export interface ProjectPick {
  id: string;
  name: string;
  number?: string | null;
}

/* ================================ Scope ================================== */

export interface Scope {
  projectId: string | null;
  /** `/api/v1/automation` or `/api/v1/projects/:id/automation` */
  base: string;
  isProject: boolean;
}

export function useScope(): Scope {
  const { projectId } = useParams<{ projectId: string }>();
  if (projectId) {
    return { projectId, base: `/api/v1/projects/${projectId}/automation`, isProject: true };
  }
  return { projectId: null, base: "/api/v1/automation", isProject: false };
}

/** Owner/admin gates every company-level mutation and the engine status. */
export function useIsCompanyAdmin(): boolean {
  const { company } = useAuth();
  return company?.role === "owner" || company?.role === "admin";
}

/* =============================== Helpers ================================= */

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function errorStatus(err: unknown): number | null {
  return err instanceof ApiClientError ? err.status : null;
}

export function num(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace(/[_.]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export const RULE_STATUS_TONE: Record<string, Tone> = {
  draft: "neutral",
  active: "success",
  paused: "warning",
  archived: "neutral",
};

export const RUN_STATUS_TONE: Record<string, Tone> = {
  queued: "info",
  running: "info",
  succeeded: "success",
  failed: "danger",
  skipped: "neutral",
  throttled: "warning",
  dry_run: "accent",
};

export const OUTCOME_TONE: Record<string, Tone> = {
  done: "success",
  failed: "danger",
  skipped: "neutral",
};

export const RULE_STATUSES = ["draft", "active", "paused", "archived"] as const;
export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "skipped", "throttled", "dry_run"] as const;

export const OPERATOR_LABELS: Record<string, string> = {
  eq: "equals",
  neq: "does not equal",
  gt: "greater than",
  gte: "at least",
  lt: "less than",
  lte: "at most",
  in: "is one of",
  not_in: "is not one of",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  exists: "is set",
  not_exists: "is not set",
  is_true: "is true",
  is_false: "is false",
  matches: "matches pattern",
  before: "is before",
  after: "is after",
  within_days: "is within N days of now",
  older_than_days: "is older than N days",
  due_within_days: "is due within N days",
  overdue_by_days: "is overdue by N days",
};

export const VALUELESS_OPERATORS = new Set(["exists", "not_exists", "is_true", "is_false"]);
export const DAY_OPERATORS = new Set(["within_days", "older_than_days", "due_within_days", "overdue_by_days"]);
export const LIST_OPERATORS = new Set(["in", "not_in"]);
export const NUMERIC_OPERATORS = new Set(["gt", "gte", "lt", "lte"]);

export function operatorLabel(op: string): string {
  return OPERATOR_LABELS[op] ?? op;
}

export function describeTrigger(t: TriggerJson): string {
  const type = t.objectType === "*" ? "any record" : humanize(t.objectType);
  if (t.kind === "schedule") {
    return `Every ${t.everyMinutes ?? 60} min, scan ${type} (once per ${t.cooldownHours ?? 24} h per record)`;
  }
  const action = !t.action || t.action === "*" ? "any change to" : `${humanize(t.action).toLowerCase()} of`;
  return `On ${action} ${type}`;
}

export function isLeaf(node: ConditionJson): node is ConditionLeaf {
  return typeof (node as ConditionLeaf).field === "string";
}

export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** One line per leaf, with indentation for groups. */
export function describeCondition(node: ConditionJson | null | undefined, depth = 0): string[] {
  if (!node) return ["No conditions — every trigger fires."];
  const pad = "  ".repeat(depth);
  if (isLeaf(node)) {
    const value = VALUELESS_OPERATORS.has(node.op) ? "" : ` ${formatValue(node.value)}`;
    return [`${pad}${node.field} ${operatorLabel(node.op)}${value}`];
  }
  if ("all" in node) return [`${pad}ALL of:`, ...node.all.flatMap((c) => describeCondition(c, depth + 1))];
  if ("any" in node) return [`${pad}ANY of:`, ...node.any.flatMap((c) => describeCondition(c, depth + 1))];
  if ("not" in node) return [`${pad}NOT:`, ...describeCondition(node.not, depth + 1)];
  return [`${pad}(unrecognised condition)`];
}

export function countLeaves(node: ConditionJson | null | undefined): number {
  if (!node) return 0;
  if (isLeaf(node)) return 1;
  if ("all" in node) return node.all.reduce((n, c) => n + countLeaves(c), 0);
  if ("any" in node) return node.any.reduce((n, c) => n + countLeaves(c), 0);
  if ("not" in node) return countLeaves(node.not);
  return 0;
}

export const ACTION_LABELS: Record<string, string> = {
  notify: "Notify",
  escalate: "Escalate",
  create_obligation: "Create obligation",
  create_signal: "Raise signal",
  webhook: "Call webhook",
  run_agent: "Request agent run",
  assign: "Assign",
  tag: "Tag",
  create_task: "Create task",
};

export function actionLabel(type: string): string {
  return ACTION_LABELS[type] ?? humanize(type);
}

export interface NotifyTargetJson {
  kind: "users" | "roles" | "distribution_groups" | "project_members" | "record_field";
  userIds?: string[];
  roles?: string[];
  groupIds?: string[];
  field?: string;
}

export function describeTargets(to: unknown): string {
  if (!Array.isArray(to) || to.length === 0) return "";
  return (to as NotifyTargetJson[])
    .map((t) => {
      switch (t.kind) {
        case "roles":
          return `roles ${(t.roles ?? []).join("/")}`;
        case "users":
          return `${(t.userIds ?? []).length} user(s)`;
        case "distribution_groups":
          return `${(t.groupIds ?? []).length} group(s)`;
        case "project_members":
          return "project members";
        case "record_field":
          return `record.${t.field ?? "?"}`;
        default:
          return "?";
      }
    })
    .join(", ");
}

/** A one-line description of an action, from its params. */
export function describeAction(a: ActionJson): string {
  const p = a.params ?? {};
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  switch (a.type) {
    case "notify":
      return `Notify ${describeTargets(p["to"]) || "(no recipients)"}${s("title") ? `: "${s("title")}"` : ""}`;
    case "escalate":
      return `Escalate to ${describeTargets(p["to"]) || "company owners and admins"}${p["raiseSignal"] ? ", raise a signal" : ""}${s("reassignTo") ? `, reassign to ${s("reassignTo")}` : ""}`;
    case "create_obligation":
      return `Obligation "${s("trigger") || "(untitled)"}"${s("deadlineField") ? ` due from record.${s("deadlineField")}` : p["dueInDays"] !== undefined ? ` due in ${String(p["dueInDays"])} days` : s("deadline") ? ` due ${s("deadline")}` : ""}`;
    case "create_signal":
      return `${humanize(s("severity") || "medium")} signal "${s("title") || "(untitled)"}" (${s("detector") || "automation.rule"})`;
    case "webhook":
      return `POST signed envelope to ${s("url") || "(no url)"}`;
    case "run_agent":
      return `Queue agent ${s("agentKind") || "?"} for human review`;
    case "assign":
      return `Assign to ${s("userId") || `record.${s("userField") || "?"}`}`;
    case "tag":
      return `Tag "${s("name") || "?"}"`;
    case "create_task":
      return `Task "${s("title") || "(untitled)"}"${p["dueInDays"] !== undefined ? ` due in ${String(p["dueInDays"])} days` : ""}`;
    default:
      return humanize(a.type);
  }
}

export const TEMPLATE_CATEGORY_LABELS: Record<string, string> = {
  field: "Field",
  financial: "Financial",
  contract: "Contract",
  assurance: "Assurance",
  safety: "Safety",
  quality: "Quality",
  compliance: "Compliance",
};

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function msDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s % 1 === 0 ? s : s.toFixed(1)} s`;
  const m = s / 60;
  if (m < 60) return `${m % 1 === 0 ? m : m.toFixed(1)} min`;
  return `${(m / 60).toFixed(1)} h`;
}

/** The record types the API can snapshot whose fields point at a user. */
export function userFields(entry: CatalogueObjectType | undefined): CatalogueField[] {
  return entry?.fields.filter((f) => f.type === "user") ?? [];
}

export function dateFields(entry: CatalogueObjectType | undefined): CatalogueField[] {
  return entry?.fields.filter((f) => f.type === "date" || f.type === "datetime") ?? [];
}

/** Ids are stable across renders of a list editor; the counter never collides within a session. */
let idCounter = 0;
export function localId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}
