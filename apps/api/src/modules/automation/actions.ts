/**
 * Action executors for the automation engine (Vol I #79–92, #85–86 escalation,
 * Vol II X #1005–1009).
 *
 * Each executor takes the run's context and one action's params, does exactly
 * one kind of thing, and returns a structured outcome. They never throw past
 * the engine: a failing action is recorded as `failed` on the run, the next
 * action still runs, and the run as a whole is `failed` so the operator sees it.
 *
 * Text parameters are rendered with `{{path}}` placeholders resolved against
 * the evaluation context (`{{record.subject}}`, `{{event.action}}`). Rendering
 * is a path lookup, never an expression — the same discipline as predicates.
 *
 * Consequential writes append to the ledger with `actorId: null` (the system
 * actor) and register the object with the engine's origin map FIRST, so the
 * ledger hook can refuse to fire the same rule on its own output.
 *
 * What the executors deliberately do NOT do: change any record's lifecycle
 * status (those have dedicated transition routes with segregation of duties),
 * move money, or apply an AI proposal — `run_agent` enqueues a review item
 * for a human, it does not call a model.
 */
import { createHmac } from "node:crypto";
import { and, eq, gte, inArray, isNull, or } from "drizzle-orm";
import {
  aiReviewQueue,
  assuranceGrants,
  companyMemberships,
  distributionGroupMembers,
  distributionGroups,
  meetingActionItems,
  obligations,
  projectMemberships,
  signals,
  tagAssignments,
  tags,
  type AutomationActionResult,
} from "@constructos/db";
import {
  NOTIFICATION_KINDS,
  SIGNAL_SEVERITIES,
  type NotificationKind,
  type SignalSeverity,
} from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { pushNotifications } from "../notifications/service.js";
import { getPath, type EvaluationContext } from "./predicates.js";
import { assignRecord } from "./snapshots.js";

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/** `{{record.subject}}` → the value at that path, or "—" when absent. */
export function renderTemplate(template: unknown, ctx: EvaluationContext): string {
  if (typeof template !== "string") return "";
  return template.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_m, path: string) => {
    const v = getPath(ctx, path);
    if (v === null || v === undefined || v === "") return "—";
    if (typeof v === "object") return JSON.stringify(v).slice(0, 200);
    return String(v);
  });
}

/* ------------------------------------------------------------------ */
/* Injectable HTTP transport for webhooks                              */
/* ------------------------------------------------------------------ */

export interface AutomationHttpResponse {
  status: number;
  body: string;
}

export interface AutomationHttpClient {
  post(url: string, body: string, headers: Record<string, string>): Promise<AutomationHttpResponse>;
}

export function createFetchClient(timeoutMs: number, bodyLimit: number): AutomationHttpClient {
  return {
    async post(url, body, headers) {
      const res = await fetch(url, {
        method: "POST",
        body,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      let text = "";
      try {
        text = (await res.text()).slice(0, bodyLimit);
      } catch {
        text = "";
      }
      return { status: res.status, body: text };
    },
  };
}

export interface RecordedWebhookCall {
  url: string;
  body: string;
  headers: Record<string, string>;
}

/** Test transport: scripted responses plus a call log. `respond` may throw. */
export function createRecordingClient(
  respond: (call: RecordedWebhookCall, index: number) => AutomationHttpResponse | Promise<AutomationHttpResponse>,
): AutomationHttpClient & { calls: RecordedWebhookCall[] } {
  const calls: RecordedWebhookCall[] = [];
  return {
    calls,
    async post(url, body, headers) {
      const call = { url, body, headers };
      calls.push(call);
      return respond(call, calls.length - 1);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Executor plumbing                                                   */
/* ------------------------------------------------------------------ */

export interface RunFacts {
  runId: string;
  ruleId: string;
  ruleName: string;
  companyId: string;
  projectId: string | null;
  objectType: string;
  objectId: string;
  /** who caused the triggering event; null for schedule/system */
  actorId: string | null;
  /** a human label for the record, for notification titles */
  recordTitle: string;
}

export interface ExecutorDeps {
  db: Db;
  http: AutomationHttpClient;
  /** register a record the engine just wrote so the ledger hook can attribute it */
  markOrigin: (objectType: string, objectId: string) => void;
  now: () => Date;
  webhookSigningSecret: string;
}

export type ActionOutcome = Omit<AutomationActionResult, "index" | "type" | "durationMs">;

const done = (detail: Record<string, unknown>): ActionOutcome => ({ outcome: "done", detail, error: null });
const skipped = (reason: string, detail: Record<string, unknown> = {}): ActionOutcome => ({
  outcome: "skipped",
  detail: { reason, ...detail },
  error: null,
});
const failed = (error: string, detail: Record<string, unknown> = {}): ActionOutcome => ({
  outcome: "failed",
  detail,
  error,
});

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/* ------------------------------------------------------------------ */
/* Recipients                                                          */
/* ------------------------------------------------------------------ */

export interface NotifyTarget {
  kind: "users" | "roles" | "distribution_groups" | "project_members" | "record_field";
  userIds?: string[];
  roles?: string[];
  groupIds?: string[];
  field?: string;
}

const COMPANY_ROLES = new Set(["owner", "admin", "member", "guest"]);
const ASSURANCE_ROLES = new Set(["integrity_reviewer", "auditor", "regulator"]);

/**
 * Resolve notify targets to user ids that are MEMBERS OF THIS COMPANY. A rule
 * cannot be used to push notifications at a user outside the tenant, whatever
 * id it names.
 */
export async function resolveRecipients(
  db: Db,
  facts: RunFacts,
  ctx: EvaluationContext,
  targets: NotifyTarget[],
): Promise<{ userIds: string[]; unresolved: string[] }> {
  const wanted = new Set<string>();
  const unresolved: string[] = [];
  for (const t of targets) {
    switch (t.kind) {
      case "users":
        for (const id of t.userIds ?? []) if (typeof id === "string" && id) wanted.add(id);
        break;
      case "record_field": {
        const v = getPath(ctx, t.field?.includes(".") ? t.field : `record.${t.field ?? ""}`);
        if (typeof v === "string" && v) wanted.add(v);
        else if (Array.isArray(v)) for (const x of v) if (typeof x === "string" && x) wanted.add(x);
        else unresolved.push(`record field ${t.field ?? "?"} is empty`);
        break;
      }
      case "roles": {
        const companyRoles = (t.roles ?? []).filter((r) => COMPANY_ROLES.has(r));
        const assuranceRoles = (t.roles ?? []).filter((r) => ASSURANCE_ROLES.has(r));
        if (companyRoles.length > 0) {
          const rows = await db
            .select({ userId: companyMemberships.userId })
            .from(companyMemberships)
            .where(
              and(
                eq(companyMemberships.companyId, facts.companyId),
                inArray(companyMemberships.role, companyRoles),
              ),
            );
          for (const r of rows) wanted.add(r.userId);
        }
        if (assuranceRoles.length > 0) {
          const nowIso = new Date().toISOString();
          const rows = await db
            .select({ userId: assuranceGrants.userId })
            .from(assuranceGrants)
            .where(
              and(
                eq(assuranceGrants.companyId, facts.companyId),
                inArray(assuranceGrants.role, assuranceRoles),
                or(isNull(assuranceGrants.expiresAt), gte(assuranceGrants.expiresAt, nowIso)),
                facts.projectId
                  ? or(isNull(assuranceGrants.projectId), eq(assuranceGrants.projectId, facts.projectId))
                  : isNull(assuranceGrants.projectId),
              ),
            );
          for (const r of rows) wanted.add(r.userId);
        }
        const unknown = (t.roles ?? []).filter((r) => !COMPANY_ROLES.has(r) && !ASSURANCE_ROLES.has(r));
        for (const r of unknown) unresolved.push(`unknown role ${r}`);
        break;
      }
      case "distribution_groups": {
        const ids = (t.groupIds ?? []).filter((g) => typeof g === "string" && g);
        if (ids.length === 0) break;
        const rows = await db
          .select({ userId: distributionGroupMembers.userId })
          .from(distributionGroupMembers)
          .innerJoin(distributionGroups, eq(distributionGroups.id, distributionGroupMembers.groupId))
          .where(
            and(eq(distributionGroups.companyId, facts.companyId), inArray(distributionGroups.id, ids)),
          );
        for (const r of rows) if (r.userId) wanted.add(r.userId);
        break;
      }
      case "project_members": {
        if (!facts.projectId) {
          unresolved.push("project_members: the run has no project");
          break;
        }
        const rows = await db
          .select({ userId: projectMemberships.userId })
          .from(projectMemberships)
          .where(
            and(
              eq(projectMemberships.companyId, facts.companyId),
              eq(projectMemberships.projectId, facts.projectId),
            ),
          );
        for (const r of rows) wanted.add(r.userId);
        break;
      }
      default:
        unresolved.push(`unknown target kind ${String((t as { kind?: unknown }).kind)}`);
    }
  }
  if (wanted.size === 0) return { userIds: [], unresolved };
  // Tenant filter: only members of this company survive.
  const members = await db
    .select({ userId: companyMemberships.userId })
    .from(companyMemberships)
    .where(
      and(eq(companyMemberships.companyId, facts.companyId), inArray(companyMemberships.userId, [...wanted])),
    );
  const allowed = new Set(members.map((m) => m.userId));
  for (const id of wanted) if (!allowed.has(id)) unresolved.push(`user ${id} is not a member of this company`);
  return { userIds: [...allowed], unresolved };
}

function notificationKind(v: unknown, fallback: NotificationKind): NotificationKind {
  return typeof v === "string" && (NOTIFICATION_KINDS as readonly string[]).includes(v)
    ? (v as NotificationKind)
    : fallback;
}

/* ------------------------------------------------------------------ */
/* Executors                                                           */
/* ------------------------------------------------------------------ */

export async function executeNotify(
  deps: ExecutorDeps,
  facts: RunFacts,
  ctx: EvaluationContext,
  params: Record<string, unknown>,
  defaults: { kind: NotificationKind; targets?: NotifyTarget[] } = { kind: "automation" },
): Promise<ActionOutcome> {
  const targets = Array.isArray(params["to"]) && params["to"].length > 0
    ? (params["to"] as NotifyTarget[])
    : (defaults.targets ?? []);
  if (targets.length === 0) return skipped("no recipients configured");
  const { userIds, unresolved } = await resolveRecipients(deps.db, facts, ctx, targets);
  if (userIds.length === 0) return skipped("no recipients resolved", { unresolved });
  const title = renderTemplate(params["title"], ctx) || `${facts.ruleName}: ${facts.recordTitle}`;
  const body = renderTemplate(params["body"], ctx) || null;
  const kind = notificationKind(params["kind"], defaults.kind);
  await pushNotifications(
    deps.db,
    userIds.map((userId) => ({
      companyId: facts.companyId,
      userId,
      projectId: facts.projectId,
      kind,
      title: title.slice(0, 300),
      body,
      recordType: facts.objectType,
      recordId: facts.objectId,
    })),
  );
  return done({ kind, recipients: userIds.length, unresolved });
}

export async function executeEscalate(
  deps: ExecutorDeps,
  facts: RunFacts,
  ctx: EvaluationContext,
  params: Record<string, unknown>,
): Promise<ActionOutcome> {
  const notify = await executeNotify(deps, facts, ctx, params, {
    kind: "escalation",
    targets: [{ kind: "roles", roles: ["owner", "admin"] }],
  });
  const detail: Record<string, unknown> = { notify: notify.detail, notifyOutcome: notify.outcome };
  if (bool(params["raiseSignal"])) {
    const sig = await executeCreateSignal(deps, facts, ctx, {
      detector: "automation.escalation",
      severity: str(params["severity"], "medium"),
      confidence: 0.8,
      title: str(params["title"]) || `Escalation: ${facts.recordTitle}`,
      explanation: str(params["body"]) || `Escalated by rule "${facts.ruleName}".`,
    });
    detail["signal"] = sig.detail;
    detail["signalOutcome"] = sig.outcome;
    if (sig.outcome === "failed") return failed(sig.error ?? "signal failed", detail);
  }
  const reassignTo = str(params["reassignTo"]);
  if (reassignTo) {
    const a = await executeAssign(deps, facts, ctx, { userId: reassignTo });
    detail["reassign"] = a.detail;
    detail["reassignOutcome"] = a.outcome;
    if (a.outcome === "failed") return failed(a.error ?? "reassign failed", detail);
  }
  if (notify.outcome === "failed") return failed(notify.error ?? "notify failed", detail);
  return done(detail);
}

function resolveDeadline(
  ctx: EvaluationContext,
  params: Record<string, unknown>,
  now: Date,
): string | null {
  const explicit = str(params["deadline"]);
  if (explicit) {
    const t = Date.parse(explicit.length === 10 ? `${explicit}T00:00:00Z` : explicit);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  const field = str(params["deadlineField"]);
  if (field) {
    const v = getPath(ctx, field.includes(".") ? field : `record.${field}`);
    if (typeof v === "string" && v) {
      const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
      return Number.isNaN(t) ? null : new Date(t).toISOString();
    }
  }
  const days = num(params["dueInDays"]);
  if (days !== null) return new Date(now.getTime() + days * 86_400_000).toISOString();
  return null;
}

export async function executeCreateObligation(
  deps: ExecutorDeps,
  facts: RunFacts,
  ctx: EvaluationContext,
  params: Record<string, unknown>,
): Promise<ActionOutcome> {
  if (!facts.projectId) return skipped("obligations belong to a project; this run has none");
  const trigger = renderTemplate(params["trigger"], ctx) || `Obligation from rule "${facts.ruleName}" on ${facts.recordTitle}`;
  const deadline = resolveDeadline(ctx, params, deps.now());
  // Idempotent per (project, trigger text, open): a scan that fires daily
  // must not stack ten identical obligations on the same record.
  const existing = await deps.db
    .select({ id: obligations.id })
    .from(obligations)
    .where(
      and(
        eq(obligations.companyId, facts.companyId),
        eq(obligations.projectId, facts.projectId),
        eq(obligations.trigger, trigger),
        eq(obligations.status, "open"),
      ),
    )
    .limit(1);
  if (existing[0]) return skipped("an open obligation with this trigger already exists", { obligationId: existing[0].id });
  const id = newId("obl");
  await deps.db.insert(obligations).values({
    id,
    companyId: facts.companyId,
    projectId: facts.projectId,
    sourceClause: renderTemplate(params["sourceClause"], ctx) || `automation:${facts.ruleId}`,
    obligorId: str(params["obligorId"]) || null,
    obligeeId: str(params["obligeeId"]) || null,
    trigger,
    deadline,
    warnDaysBefore: num(params["warnDaysBefore"]),
    evidenceRequirement: renderTemplate(params["evidenceRequirement"], ctx) || null,
    status: "open",
    createdBy: facts.actorId ?? "automation",
  });
  deps.markOrigin("obligation", id);
  await appendLedger(deps.db, {
    companyId: facts.companyId,
    projectId: facts.projectId,
    actorId: null,
    action: "create",
    objectType: "obligation",
    objectId: id,
    payload: { trigger, deadline, ruleId: facts.ruleId, runId: facts.runId, source: { type: facts.objectType, id: facts.objectId } },
  });
  return done({ obligationId: id, deadline, trigger });
}

export async function executeCreateSignal(
  deps: ExecutorDeps,
  facts: RunFacts,
  ctx: EvaluationContext,
  params: Record<string, unknown>,
): Promise<ActionOutcome> {
  const rawDetector = str(params["detector"], "automation.rule");
  const detector = rawDetector.startsWith("automation.") ? rawDetector : `automation.${rawDetector}`;
  const severity: SignalSeverity = (SIGNAL_SEVERITIES as readonly string[]).includes(str(params["severity"]))
    ? (params["severity"] as SignalSeverity)
    : "medium";
  const confidence = Math.min(1, Math.max(0, num(params["confidence"]) ?? 0.7));
  const key = `${facts.ruleId}:${facts.objectType}:${facts.objectId}`;
  // Idempotent while a signal for this rule+record is still open.
  const open = await deps.db
    .select({ id: signals.id, refs: signals.evidenceRefs })
    .from(signals)
    .where(
      and(
        eq(signals.companyId, facts.companyId),
        eq(signals.detector, detector),
        inArray(signals.disposition, ["new", "under_review", "confirmed", "escalated"]),
      ),
    );
  const dup = open.find((s) => (s.refs as { key?: unknown } | null)?.key === key);
  if (dup) return skipped("an open signal for this rule and record already exists", { signalId: dup.id });
  const id = newId("sig");
  const title = renderTemplate(params["title"], ctx) || `${facts.ruleName}: ${facts.recordTitle}`;
  const explanation = renderTemplate(params["explanation"], ctx) || `Raised by automation rule "${facts.ruleName}".`;
  await deps.db.insert(signals).values({
    id,
    companyId: facts.companyId,
    projectId: facts.projectId,
    detector,
    severity,
    confidence,
    title: title.slice(0, 300),
    explanation,
    evidenceRefs: {
      key,
      ruleId: facts.ruleId,
      runId: facts.runId,
      source: { type: facts.objectType, id: facts.objectId },
    },
  });
  deps.markOrigin("signal", id);
  await appendLedger(deps.db, {
    companyId: facts.companyId,
    projectId: facts.projectId,
    actorId: null,
    action: "create",
    objectType: "signal",
    objectId: id,
    payload: { detector, severity, key, ruleId: facts.ruleId, runId: facts.runId },
  });
  return done({ signalId: id, detector, severity });
}

function isDeliverableUrl(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    // A trailing dot is the DNS root and resolves identically ("localhost."
    // reaches loopback), so it is stripped before every test below — without
    // this, "http://localhost./" walked straight past the name checks.
    const host = u.hostname.toLowerCase().replace(/\.+$/, "");
    // Refuse the obvious ways to turn a rule into an internal port scanner.
    if (host === "localhost" || host === "0.0.0.0" || host.endsWith(".localhost")) return false;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    // Any IPv6 literal is refused outright. The WHATWG parser normalises
    // "[::ffff:127.0.0.1]" to "[::ffff:7f00:1]", so a per-range test on the
    // text would miss the v4-mapped form that still reaches loopback — and
    // fc00::/7 and fe80::/10 are just as internal. A public receiver is
    // always reachable by name or by IPv4.
    if (host.startsWith("[")) return false;
    return true;
  } catch {
    return false;
  }
}

export function signWebhookBody(secret: string, timestamp: number, runId: string, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`v1:${timestamp}:${runId}:${body}`).digest("hex")}`;
}

export async function executeWebhook(
  deps: ExecutorDeps,
  facts: RunFacts,
  ctx: EvaluationContext,
  params: Record<string, unknown>,
): Promise<ActionOutcome> {
  const url = str(params["url"]);
  if (!url) return failed("webhook url is not set");
  if (!isDeliverableUrl(url)) return failed("webhook url must be an absolute http(s) URL to a public host");
  const at = deps.now();
  const envelope = {
    id: facts.runId,
    type: "automation.rule_fired",
    rule: { id: facts.ruleId, name: facts.ruleName },
    companyId: facts.companyId,
    projectId: facts.projectId,
    object: { type: facts.objectType, id: facts.objectId, title: facts.recordTitle },
    event: ctx.event,
    record: bool(params["includeRecord"], true) ? ctx.record : undefined,
    occurredAt: at.toISOString(),
  };
  const body = JSON.stringify(envelope);
  const ts = Math.floor(at.getTime() / 1000);
  const secret = str(params["secret"]) || deps.webhookSigningSecret;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "ConstructOS-Automation/1",
    "x-constructos-event": "automation.rule_fired",
    "x-constructos-run": facts.runId,
    "x-constructos-rule": facts.ruleId,
    "x-constructos-company": facts.companyId,
    "x-constructos-timestamp": String(ts),
    "x-constructos-signature": signWebhookBody(secret, ts, facts.runId, body),
  };
  const extra = params["headers"];
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
      if (typeof v === "string" && /^[a-z0-9-]+$/i.test(k) && !k.toLowerCase().startsWith("x-constructos-")) {
        headers[k.toLowerCase()] = v.slice(0, 500);
      }
    }
  }
  try {
    const res = await deps.http.post(url, body, headers);
    const ok = res.status >= 200 && res.status < 300;
    const detail = { url, status: res.status, responseBody: res.body.slice(0, 500), signed: true };
    return ok ? done(detail) : failed(`receiver responded ${res.status}`, detail);
  } catch (err) {
    return failed(`transport error: ${err instanceof Error ? err.message : String(err)}`, { url });
  }
}

export async function executeRunAgent(
  deps: ExecutorDeps,
  facts: RunFacts,
  ctx: EvaluationContext,
  params: Record<string, unknown>,
): Promise<ActionOutcome> {
  const agentKind = str(params["agentKind"]);
  if (!agentKind || !/^[a-z0-9_]+$/.test(agentKind)) return failed("agentKind must be a snake_case agent kind");
  const summary = (renderTemplate(params["summary"], ctx) || `Run agent ${agentKind} for ${facts.recordTitle}`).slice(0, 500);
  // One pending request per (rule, record, agent) at a time.
  const pending = await deps.db
    .select({ id: aiReviewQueue.id, proposal: aiReviewQueue.proposal })
    .from(aiReviewQueue)
    .where(
      and(
        eq(aiReviewQueue.companyId, facts.companyId),
        eq(aiReviewQueue.targetType, "agent_run"),
        eq(aiReviewQueue.status, "pending"),
        eq(aiReviewQueue.targetId, facts.objectId),
      ),
    );
  const dup = pending.find((p) => {
    const pr = p.proposal as { ruleId?: unknown; agentKind?: unknown } | null;
    return pr?.ruleId === facts.ruleId && pr?.agentKind === agentKind;
  });
  if (dup) return skipped("an identical agent run is already pending review", { reviewId: dup.id });
  const id = newId("airev");
  const proposal = {
    kind: "run_agent",
    agentKind,
    params: params["params"] && typeof params["params"] === "object" ? params["params"] : {},
    objectType: facts.objectType,
    objectId: facts.objectId,
    projectId: facts.projectId,
    ruleId: facts.ruleId,
    ruleName: facts.ruleName,
    automationRunId: facts.runId,
    requestedAt: deps.now().toISOString(),
  };
  await deps.db.insert(aiReviewQueue).values({
    id,
    companyId: facts.companyId,
    projectId: facts.projectId,
    runId: facts.runId,
    targetType: "agent_run",
    targetId: facts.objectId,
    proposal,
    summary,
    confidence: null,
    status: "pending",
  });
  deps.markOrigin("ai_review", id);
  await appendLedger(deps.db, {
    companyId: facts.companyId,
    projectId: facts.projectId,
    actorId: null,
    action: "create",
    objectType: "ai_review",
    objectId: id,
    payload: { targetType: "agent_run", agentKind, ruleId: facts.ruleId, runId: facts.runId },
  });
  return done({ reviewId: id, agentKind, queued: "ai_review_queue" });
}

export async function executeAssign(
  deps: ExecutorDeps,
  facts: RunFacts,
  ctx: EvaluationContext,
  params: Record<string, unknown>,
): Promise<ActionOutcome> {
  let userId = str(params["userId"]);
  const field = str(params["userField"]);
  if (!userId && field) {
    const v = getPath(ctx, field.includes(".") ? field : `record.${field}`);
    if (typeof v === "string") userId = v;
  }
  if (!userId) return failed("assign needs userId or a userField that resolves to a user");
  const member = await deps.db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(and(eq(companyMemberships.companyId, facts.companyId), eq(companyMemberships.userId, userId)))
    .limit(1);
  if (!member[0]) return failed(`user ${userId} is not a member of this company`);
  const result = await assignRecord(deps.db, facts.companyId, facts.objectType, facts.objectId, userId);
  if (!result.ok) return skipped(result.reason ?? "not assignable", { field: result.field });
  deps.markOrigin(facts.objectType, facts.objectId);
  await appendLedger(deps.db, {
    companyId: facts.companyId,
    projectId: facts.projectId,
    actorId: null,
    action: "update",
    objectType: facts.objectType,
    objectId: facts.objectId,
    payload: { [result.field ?? "assignee"]: userId, by: "automation", ruleId: facts.ruleId, runId: facts.runId },
  });
  if (bool(params["notify"], true)) {
    await pushNotifications(deps.db, [
      {
        companyId: facts.companyId,
        userId,
        projectId: facts.projectId,
        kind: "assignment",
        title: `${facts.recordTitle} assigned to you by rule "${facts.ruleName}"`,
        recordType: facts.objectType,
        recordId: facts.objectId,
      },
    ]);
  }
  return done({ userId, field: result.field });
}

export async function executeTag(
  deps: ExecutorDeps,
  facts: RunFacts,
  ctx: EvaluationContext,
  params: Record<string, unknown>,
): Promise<ActionOutcome> {
  const name = renderTemplate(params["name"], ctx).trim().slice(0, 80);
  if (!name || name === "—") return failed("tag name is not set");
  let tagRow = (
    await deps.db
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.companyId, facts.companyId), eq(tags.name, name)))
      .limit(1)
  )[0];
  if (!tagRow) {
    const id = newId("tag");
    await deps.db
      .insert(tags)
      .values({ id, companyId: facts.companyId, name, color: str(params["color"]) || null })
      .onConflictDoNothing();
    tagRow =
      (
        await deps.db
          .select({ id: tags.id })
          .from(tags)
          .where(and(eq(tags.companyId, facts.companyId), eq(tags.name, name)))
          .limit(1)
      )[0] ?? { id };
  }
  const existing = await deps.db
    .select({ id: tagAssignments.id })
    .from(tagAssignments)
    .where(
      and(
        eq(tagAssignments.tagId, tagRow.id),
        eq(tagAssignments.recordType, facts.objectType),
        eq(tagAssignments.recordId, facts.objectId),
      ),
    )
    .limit(1);
  if (existing[0]) return skipped("record already carries this tag", { tagId: tagRow.id, name });
  const assignmentId = newId("tga");
  await deps.db
    .insert(tagAssignments)
    .values({ id: assignmentId, tagId: tagRow.id, recordType: facts.objectType, recordId: facts.objectId })
    .onConflictDoNothing();
  deps.markOrigin("tag_assignment", assignmentId);
  await appendLedger(deps.db, {
    companyId: facts.companyId,
    projectId: facts.projectId,
    actorId: null,
    action: "create",
    objectType: "tag_assignment",
    objectId: assignmentId,
    payload: { tag: name, recordType: facts.objectType, recordId: facts.objectId, ruleId: facts.ruleId },
  });
  return done({ tagId: tagRow.id, name, assignmentId });
}

export async function executeCreateTask(
  deps: ExecutorDeps,
  facts: RunFacts,
  ctx: EvaluationContext,
  params: Record<string, unknown>,
): Promise<ActionOutcome> {
  if (!facts.projectId) return skipped("tasks belong to a project; this run has none");
  const title = (renderTemplate(params["title"], ctx) || `Follow up: ${facts.recordTitle}`).slice(0, 300);
  let ownerId = str(params["ownerId"]);
  const ownerField = str(params["ownerField"]);
  if (!ownerId && ownerField) {
    const v = getPath(ctx, ownerField.includes(".") ? ownerField : `record.${ownerField}`);
    if (typeof v === "string") ownerId = v;
  }
  if (ownerId) {
    const member = await deps.db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, facts.companyId), eq(companyMemberships.userId, ownerId)))
      .limit(1);
    if (!member[0]) ownerId = "";
  }
  // Idempotent: one open follow-up per (rule, record).
  const open = await deps.db
    .select({ id: meetingActionItems.id })
    .from(meetingActionItems)
    .where(
      and(
        eq(meetingActionItems.companyId, facts.companyId),
        eq(meetingActionItems.projectId, facts.projectId),
        eq(meetingActionItems.linkedRecordType, facts.objectType),
        eq(meetingActionItems.linkedRecordId, facts.objectId),
        eq(meetingActionItems.sourceClause, `automation:${facts.ruleId}`),
        inArray(meetingActionItems.status, ["open", "in_progress", "blocked"]),
      ),
    )
    .limit(1);
  if (open[0]) return skipped("an open follow-up task for this rule and record already exists", { taskId: open[0].id });
  const days = num(params["dueInDays"]);
  const dueDate = days === null ? null : new Date(deps.now().getTime() + days * 86_400_000).toISOString().slice(0, 10);
  const number = await nextRecordNumber(deps.db, facts.projectId, "meeting_action_item");
  const id = newId("act");
  const priority = ["low", "medium", "high", "critical"].includes(str(params["priority"])) ? str(params["priority"]) : "medium";
  await deps.db.insert(meetingActionItems).values({
    id,
    companyId: facts.companyId,
    projectId: facts.projectId,
    meetingId: null,
    number,
    reference: `ACT-${String(number).padStart(3, "0")}`,
    title,
    description: renderTemplate(params["description"], ctx) || null,
    category: "other",
    status: "open",
    priority,
    ownerId: ownerId || null,
    dueDate,
    sourceClause: `automation:${facts.ruleId}`,
    linkedRecordType: facts.objectType,
    linkedRecordId: facts.objectId,
    createdBy: facts.actorId ?? "automation",
  });
  deps.markOrigin("meeting_action_item", id);
  await appendLedger(deps.db, {
    companyId: facts.companyId,
    projectId: facts.projectId,
    actorId: null,
    action: "create",
    objectType: "meeting_action_item",
    objectId: id,
    payload: { title, dueDate, ownerId: ownerId || null, ruleId: facts.ruleId, runId: facts.runId },
  });
  if (ownerId) {
    await pushNotifications(deps.db, [
      {
        companyId: facts.companyId,
        userId: ownerId,
        projectId: facts.projectId,
        kind: "assignment",
        title: `Task ACT-${String(number).padStart(3, "0")} assigned to you: ${title}`,
        recordType: "meeting_action_item",
        recordId: id,
      },
    ]);
  }
  return done({ taskId: id, reference: `ACT-${String(number).padStart(3, "0")}`, ownerId: ownerId || null, dueDate });
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

export async function executeAction(
  deps: ExecutorDeps,
  facts: RunFacts,
  ctx: EvaluationContext,
  type: string,
  params: Record<string, unknown>,
): Promise<ActionOutcome> {
  switch (type) {
    case "notify":
      return executeNotify(deps, facts, ctx, params);
    case "escalate":
      return executeEscalate(deps, facts, ctx, params);
    case "create_obligation":
      return executeCreateObligation(deps, facts, ctx, params);
    case "create_signal":
      return executeCreateSignal(deps, facts, ctx, params);
    case "webhook":
      return executeWebhook(deps, facts, ctx, params);
    case "run_agent":
      return executeRunAgent(deps, facts, ctx, params);
    case "assign":
      return executeAssign(deps, facts, ctx, params);
    case "tag":
      return executeTag(deps, facts, ctx, params);
    case "create_task":
      return executeCreateTask(deps, facts, ctx, params);
    default:
      return failed(`unknown action type "${type}"`);
  }
}

/** A human sentence per action for the dry-run and the builder preview. */
export function describeAction(type: string, params: Record<string, unknown>, ctx: EvaluationContext): string {
  const to = Array.isArray(params["to"])
    ? (params["to"] as NotifyTarget[])
        .map((t) =>
          t.kind === "roles"
            ? `roles ${(t.roles ?? []).join("/")}`
            : t.kind === "users"
              ? `${(t.userIds ?? []).length} user(s)`
              : t.kind === "record_field"
                ? `record.${t.field ?? "?"}`
                : t.kind === "distribution_groups"
                  ? `${(t.groupIds ?? []).length} group(s)`
                  : "project members",
        )
        .join(", ")
    : "";
  switch (type) {
    case "notify":
      return `Notify ${to || "(no recipients)"}: "${renderTemplate(params["title"], ctx) || "(untitled)"}"`;
    case "escalate":
      return `Escalate to ${to || "company owners and admins"}${params["raiseSignal"] ? " and raise a signal" : ""}${
        params["reassignTo"] ? ` and reassign to ${String(params["reassignTo"])}` : ""
      }`;
    case "create_obligation":
      return `Create obligation "${renderTemplate(params["trigger"], ctx) || "(untitled)"}"${
        params["deadlineField"] ? ` due from record.${String(params["deadlineField"])}` : params["dueInDays"] ? ` due in ${String(params["dueInDays"])} days` : ""
      }`;
    case "create_signal":
      return `Raise ${String(params["severity"] ?? "medium")} signal "${renderTemplate(params["title"], ctx) || "(untitled)"}"`;
    case "webhook":
      return `POST signed envelope to ${String(params["url"] ?? "(no url)")}`;
    case "run_agent":
      return `Queue agent ${String(params["agentKind"] ?? "?")} for human review`;
    case "assign":
      return `Assign to ${String(params["userId"] ?? `record.${String(params["userField"] ?? "?")}`)}`;
    case "tag":
      return `Tag with "${renderTemplate(params["name"], ctx)}"`;
    case "create_task":
      return `Create task "${renderTemplate(params["title"], ctx) || "(untitled)"}"${
        params["dueInDays"] ? ` due in ${String(params["dueInDays"])} days` : ""
      }`;
    default:
      return `Unknown action ${type}`;
  }
}

/** Bounded window helper used by the engine's rate limiter. */
export function windowStart(now: Date, ms: number): string {
  return new Date(now.getTime() - ms).toISOString();
}
