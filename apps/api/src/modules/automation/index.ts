/**
 * Automation — the rules engine's HTTP surface (Vol I #79–92 workflow
 * automation, #85–86 escalation, Vol II X #1005–1009 automation hooks on the
 * assurance layer).
 *
 * WHAT IT COVERS
 *  · rules: trigger (ledger event or schedule) + safe conditions + actions;
 *    company-wide or per project; draft/active/paused/archived lifecycle
 *  · the ledger subscription (`addLedgerEmitHook`) that fires event rules,
 *    and the two scheduler jobs (`automation.drain`, `automation.schedules`)
 *  · a run log with condition evaluations and per-action outcomes
 *  · a code-resident template library and one-call instantiation
 *  · dry runs against a real record, a sample, or nothing
 *  · a manual cycle endpoint so operators and tests can drive the engine
 *  · a project health-inputs endpoint for the intelligence layer
 *
 * AUTHORISATION
 * Company routes: any member reads; owner/admin mutates. Rules and runs
 * scoped to a project are filtered to the projects the caller can see
 * (member of, or owner/admin, or an assurance grant covering them). Project
 * routes go through `requireTool("automation", …)`.
 *
 * WHAT IT DOES NOT DO
 * No route changes another record's lifecycle status or moves money; the
 * executors that touch records are limited to assignment, tagging, and
 * creating obligations/signals/tasks/review items (actions.ts).
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  assuranceGrants,
  automationRules,
  automationRuns,
  projectMemberships,
  projects,
  type AutomationActionJson,
  type AutomationConditionJson,
  type AutomationTriggerJson,
} from "@constructos/db";
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_CONDITION_OPERATORS,
  AUTOMATION_NOTIFY_TARGET_KINDS,
  AUTOMATION_RULE_STATUSES,
  AUTOMATION_RUN_STATUSES,
  AUTOMATION_TRIGGER_KINDS,
  LEDGER_ACTIONS,
  NOTIFICATION_KINDS,
  SIGNAL_SEVERITIES,
} from "@constructos/shared";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { addLedgerEmitHook, appendLedger } from "../../lib/ledger.js";
import { pageOffset, paginate } from "../../lib/pagination.js";
import { forEachCompany } from "../../lib/scheduler.js";
import { isExpired } from "../../lib/time.js";
import {
  AutomationEngine,
  defaultEngineOptions,
  getEngine,
  registerEngine,
  type RuleRow,
} from "./engine.js";
import {
  instantiateBodySchema,
  ruleBodySchema,
  rulePatchSchema,
  rulesQuerySchema,
  runCycleBodySchema,
  runsQuerySchema,
  testBodySchema,
  unsavedTestBodySchema,
} from "./schemas.js";
import { loadSnapshot, snapshotCatalogue } from "./snapshots.js";
import { RULE_TEMPLATES, ruleTemplate } from "./templates.js";

const ACTION_HINTS: Record<(typeof AUTOMATION_ACTION_TYPES)[number], { label: string; description: string; params: string[] }> = {
  notify: {
    label: "Notify",
    description: "In-app notification to users, roles, distribution groups, project members or a user named on the record.",
    params: ["to[]", "kind", "title", "body"],
  },
  escalate: {
    label: "Escalate",
    description: "Notify company owners/admins (or chosen targets) with the escalation kind; optionally raise a signal and reassign.",
    params: ["to[]", "title", "body", "raiseSignal", "severity", "reassignTo"],
  },
  create_obligation: {
    label: "Create obligation",
    description: "Record an obligation against a deadline taken from the record, a date, or N days from now. Idempotent while open.",
    params: ["trigger", "sourceClause", "deadlineField | deadline | dueInDays", "warnDaysBefore", "evidenceRequirement"],
  },
  create_signal: {
    label: "Raise signal",
    description: "Raise an assurance signal (detector prefixed automation.). One open signal per rule and record.",
    params: ["detector", "severity", "confidence", "title", "explanation"],
  },
  webhook: {
    label: "Call webhook",
    description: "POST a signed JSON envelope (HMAC-SHA256, header x-constructos-signature) to a public http(s) URL.",
    params: ["url", "includeRecord", "secret", "headers"],
  },
  run_agent: {
    label: "Request agent run",
    description: "Queue an AI agent run as a pending review item (targetType agent_run); a human approves before anything runs.",
    params: ["agentKind", "summary", "params"],
  },
  assign: {
    label: "Assign",
    description: "Write a company member into the record's assignable field (assignee, ball-in-court, owner…).",
    params: ["userId | userField", "notify"],
  },
  tag: { label: "Tag", description: "Attach a company tag to the record (created if missing).", params: ["name", "color"] },
  create_task: {
    label: "Create task",
    description: "Create a follow-up action item linked to the record. One open task per rule and record.",
    params: ["title", "description", "ownerId | ownerField", "dueInDays", "priority"],
  },
};

type RunRow = typeof automationRuns.$inferSelect;

export const automationModule: FastifyPluginAsync = async (app) => {
  const memberGate = [app.authenticate, app.requireCompany];
  const adminGate = [app.authenticate, app.requireCompany, app.requireCompanyRole(["owner", "admin"])];
  const projectRead = [app.authenticate, app.requireCompany, app.requireTool("automation", "read")];
  const projectStandard = [app.authenticate, app.requireCompany, app.requireTool("automation", "standard")];
  const projectAdmin = [app.authenticate, app.requireCompany, app.requireTool("automation", "admin")];

  /* ---------------------------------------------------------------- */
  /* Engine wiring: ledger subscription + scheduler jobs               */
  /* ---------------------------------------------------------------- */

  const engine =
    getEngine(app.db) ??
    new AutomationEngine(app.db, defaultEngineOptions(process.env, app.appConfig.AUTH_SECRET), app.log);
  registerEngine(app.db, engine);
  const unsubscribe = addLedgerEmitHook(app.db, async (event) => {
    await engine.onLedgerEvent(event);
  });
  app.addHook("onClose", async () => {
    unsubscribe();
  });

  app.scheduler.register({
    name: "automation.drain",
    description: "Execute queued automation runs (non-immediate event rules, deferred runs)",
    everyMs: 60_000,
    runOnBoot: true,
    run: async () => engine.drain(),
  });
  app.scheduler.register({
    name: "automation.schedules",
    description: "Scan records for schedule-triggered automation rules that are due",
    everyMs: 5 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => {
      const totals = { rulesScanned: 0, candidates: 0, matched: 0, deduped: 0, executed: 0 };
      const outcome = await forEachCompany(db, async (companyId) => {
        const s = await engine.scanSchedules(companyId, now);
        totals.rulesScanned += s.rulesScanned;
        totals.candidates += s.candidates;
        totals.matched += s.matched;
        totals.deduped += s.deduped;
        totals.executed += s.executed;
      });
      return { ...totals, companies: outcome.companies, failed: outcome.failed };
    },
  });

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Plan §6.3: company-level lists over project data are limited to the
   * projects the caller can see. `null` means every project (owner/admin or
   * a company-wide assurance grant).
   */
  async function visibleProjectIds(req: FastifyRequest): Promise<string[] | null> {
    if (req.companyRole === "owner" || req.companyRole === "admin") return null;
    const nowMs = Date.now();
    const grants = await app.db
      .select({ projectId: assuranceGrants.projectId, expiresAt: assuranceGrants.expiresAt })
      .from(assuranceGrants)
      .where(and(eq(assuranceGrants.companyId, req.companyId!), eq(assuranceGrants.userId, req.user!.id)));
    const live = grants.filter((g) => !isExpired(g.expiresAt, nowMs));
    if (live.some((g) => g.projectId === null)) return null;
    const ids = new Set<string>(live.map((g) => g.projectId).filter((p): p is string => typeof p === "string"));
    const memberships = await app.db
      .select({ projectId: projectMemberships.projectId })
      .from(projectMemberships)
      .where(and(eq(projectMemberships.companyId, req.companyId!), eq(projectMemberships.userId, req.user!.id)));
    for (const m of memberships) ids.add(m.projectId);
    return [...ids];
  }

  function projectScope(column: AnyPgColumn, visible: string[] | null): SQL | undefined {
    if (visible === null) return undefined;
    if (visible.length === 0) return isNull(column);
    return or(isNull(column), inArray(column, visible));
  }

  async function assertProjectInCompany(projectId: string, companyId: string): Promise<void> {
    const rows = await app.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw badRequest(`Project ${projectId} not found in this company.`);
  }

  async function loadRule(req: FastifyRequest, id: string): Promise<RuleRow> {
    const [row] = await app.db
      .select()
      .from(automationRules)
      .where(and(eq(automationRules.id, id), eq(automationRules.companyId, req.companyId!)))
      .limit(1);
    if (!row) throw notFound("Automation rule not found");
    return row;
  }

  async function assertRuleVisible(req: FastifyRequest, rule: RuleRow): Promise<void> {
    if (!rule.projectId) return;
    const visible = await visibleProjectIds(req);
    if (visible !== null && !visible.includes(rule.projectId)) throw notFound("Automation rule not found");
  }

  async function loadRun(req: FastifyRequest, id: string): Promise<RunRow> {
    const [row] = await app.db
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.id, id), eq(automationRuns.companyId, req.companyId!)))
      .limit(1);
    if (!row) throw notFound("Automation run not found");
    if (row.projectId) {
      const visible = await visibleProjectIds(req);
      if (visible !== null && !visible.includes(row.projectId)) throw notFound("Automation run not found");
    }
    return row;
  }

  function triggerColumns(trigger: AutomationTriggerJson) {
    return {
      triggerKind: trigger.kind,
      triggerObjectType: trigger.objectType,
      triggerAction: trigger.kind === "event" ? (trigger.action ?? "*") : "*",
    };
  }

  async function ledgerRule(
    req: FastifyRequest,
    action: "create" | "update" | "delete" | "state_change",
    rule: Pick<RuleRow, "id" | "projectId">,
    payload: unknown,
  ) {
    await appendLedger(app.db, {
      companyId: req.companyId!,
      projectId: rule.projectId,
      actorId: req.user!.id,
      action,
      objectType: "automation_rule",
      objectId: rule.id,
      payload,
    });
  }

  async function createRule(
    req: FastifyRequest,
    body: z.infer<typeof ruleBodySchema>,
    forcedProjectId: string | null | undefined,
    templateKey: string | null,
  ): Promise<RuleRow> {
    const projectId = forcedProjectId !== undefined ? forcedProjectId : (body.projectId ?? null);
    if (projectId) await assertProjectInCompany(projectId, req.companyId!);
    const id = newId("arule");
    const conditions = (body.conditions ?? null) as AutomationConditionJson | null;
    const actions = body.actions as AutomationActionJson[];
    const [row] = await app.db
      .insert(automationRules)
      .values({
        id,
        companyId: req.companyId!,
        projectId,
        name: body.name,
        description: body.description ?? null,
        status: body.status ?? "draft",
        templateKey,
        trigger: body.trigger,
        ...triggerColumns(body.trigger),
        conditions,
        actions,
        immediate: body.immediate ? 1 : 0,
        priority: body.priority ?? 100,
        createdBy: req.user!.id,
      })
      .returning();
    await ledgerRule(req, "create", row!, {
      name: row!.name,
      status: row!.status,
      trigger: row!.trigger,
      actions: actions.map((a) => a.type),
      templateKey,
    });
    return row!;
  }

  function serializeRule(rule: RuleRow) {
    return {
      ...rule,
      immediate: rule.immediate === 1,
      scope: rule.projectId ? "project" : "company",
    };
  }

  async function transition(req: FastifyRequest, rule: RuleRow, status: "active" | "paused" | "archived") {
    if (rule.status === status) throw conflict(`Rule is already ${status}`);
    if (rule.status === "archived") throw conflict("An archived rule cannot change state; create a new one");
    const [row] = await app.db
      .update(automationRules)
      .set({ status, updatedAt: new Date().toISOString(), ...(status === "active" ? { lastError: null } : {}) })
      .where(eq(automationRules.id, rule.id))
      .returning();
    await ledgerRule(req, "state_change", rule, { from: rule.status, to: status });
    return serializeRule(row!);
  }

  async function patchRule(req: FastifyRequest, rule: RuleRow, body: z.infer<typeof rulePatchSchema>) {
    const set: Partial<typeof automationRules.$inferInsert> = { updatedAt: new Date().toISOString() };
    if (body.name !== undefined) set.name = body.name;
    if (body.description !== undefined) set.description = body.description;
    if (body.trigger !== undefined) {
      set.trigger = body.trigger;
      Object.assign(set, triggerColumns(body.trigger));
    }
    if (body.conditions !== undefined) set.conditions = (body.conditions ?? null) as AutomationConditionJson | null;
    if (body.actions !== undefined) set.actions = body.actions as AutomationActionJson[];
    if (body.immediate !== undefined) set.immediate = body.immediate ? 1 : 0;
    if (body.priority !== undefined) set.priority = body.priority;
    const [row] = await app.db.update(automationRules).set(set).where(eq(automationRules.id, rule.id)).returning();
    await ledgerRule(req, "update", rule, { fields: Object.keys(body) });
    return serializeRule(row!);
  }

  /**
   * Rule and run counts for the caller's view. `visible` is the project list
   * the caller may see (null = every project); company-wide rules and runs
   * (projectId null) are always included.
   */
  async function summaryFor(companyId: string, visible: string[] | null, now: Date) {
    const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
    const ruleScope = projectScope(automationRules.projectId, visible);
    const runScope = projectScope(automationRuns.projectId, visible);
    const ruleRows = await app.db
      .select({ status: automationRules.status, n: count() })
      .from(automationRules)
      .where(and(eq(automationRules.companyId, companyId), ruleScope))
      .groupBy(automationRules.status);
    const rulesByStatus: Record<string, number> = {};
    for (const s of AUTOMATION_RULE_STATUSES) rulesByStatus[s] = 0;
    for (const r of ruleRows) rulesByStatus[r.status] = Number(r.n);
    const runRows = await app.db
      .select({ status: automationRuns.status, n: count(), actions: sql<number>`coalesce(sum(${automationRuns.actionCount}), 0)` })
      .from(automationRuns)
      .where(and(eq(automationRuns.companyId, companyId), gte(automationRuns.createdAt, dayAgo), runScope))
      .groupBy(automationRuns.status);
    const runs24h: Record<string, number> = {};
    for (const s of AUTOMATION_RUN_STATUSES) runs24h[s] = 0;
    let actions24h = 0;
    for (const r of runRows) {
      runs24h[r.status] = Number(r.n);
      actions24h += Number(r.actions ?? 0);
    }
    const [queuedRow] = await app.db
      .select({ n: count() })
      .from(automationRuns)
      .where(and(eq(automationRuns.companyId, companyId), eq(automationRuns.status, "queued"), runScope));
    return {
      generatedAt: now.toISOString(),
      rulesByStatus,
      runs24h,
      actions24h,
      /** every run still waiting, whatever its age */
      queued: Number(queuedRow?.n ?? 0),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Catalogue & templates                                             */
  /* ---------------------------------------------------------------- */

  app.get("/automation/catalogue", { preHandler: memberGate }, async () => ({
    objectTypes: snapshotCatalogue(),
    triggerKinds: AUTOMATION_TRIGGER_KINDS,
    ledgerActions: [...LEDGER_ACTIONS, "*"],
    operators: AUTOMATION_CONDITION_OPERATORS,
    actions: AUTOMATION_ACTION_TYPES.map((type) => ({ type, ...ACTION_HINTS[type] })),
    notifyTargetKinds: AUTOMATION_NOTIFY_TARGET_KINDS,
    notificationKinds: NOTIFICATION_KINDS,
    signalSeverities: SIGNAL_SEVERITIES,
    derivedFields: [
      {
        path: "derived.vendorInsuranceValid",
        type: "boolean",
        label: "Vendor has a valid insurance certificate today",
        appliesTo: ["invoice", "commitment", "punch_item", "non_conformance_report", "safety_incident", "insurance_certificate"],
      },
    ],
    contextRoots: ["record", "event", "derived", "now"],
    limits: {
      maxActionsPerMinute: engine.options.maxActionsPerMinute,
      maxChainDepth: engine.options.maxChainDepth,
      maxActionsPerRule: 10,
    },
  }));

  app.get("/automation/templates", { preHandler: memberGate }, async () => ({
    items: RULE_TEMPLATES,
    total: RULE_TEMPLATES.length,
  }));

  app.post("/automation/templates/:key/instantiate", { preHandler: adminGate }, async (req, reply) => {
    const { key } = req.params as { key: string };
    const template = ruleTemplate(key);
    if (!template) throw notFound(`Unknown template "${key}"`);
    const body = instantiateBodySchema.parse(req.body ?? {});
    const actions = template.actions.map((a, i) => ({
      type: a.type,
      params: { ...a.params, ...(body.actionOverrides?.[String(i)] ?? {}) },
    }));
    const parsed = ruleBodySchema.parse({
      name: body.name ?? template.name,
      description: template.description,
      projectId: body.projectId ?? null,
      status: body.status ?? "draft",
      trigger: template.trigger,
      conditions: template.conditions,
      actions,
      immediate: body.immediate ?? template.immediate,
    });
    const rule = await createRule(req, parsed, undefined, template.key);
    return reply.status(201).send(serializeRule(rule));
  });

  /* ---------------------------------------------------------------- */
  /* Rules — company level                                             */
  /* ---------------------------------------------------------------- */

  app.get("/automation/rules", { preHandler: memberGate }, async (req) => {
    const q = rulesQuerySchema.parse(req.query);
    const visible = await visibleProjectIds(req);
    const conds: (SQL | undefined)[] = [eq(automationRules.companyId, req.companyId!), projectScope(automationRules.projectId, visible)];
    if (q.status) conds.push(eq(automationRules.status, q.status));
    else conds.push(inArray(automationRules.status, ["draft", "active", "paused"]));
    if (q.projectId) conds.push(eq(automationRules.projectId, q.projectId));
    if (q.objectType) conds.push(eq(automationRules.triggerObjectType, q.objectType));
    if (q.triggerKind) conds.push(eq(automationRules.triggerKind, q.triggerKind));
    if (q.search) conds.push(ilike(automationRules.name, `%${q.search}%`));
    const where = and(...conds);
    const items = await app.db
      .select()
      .from(automationRules)
      .where(where)
      .orderBy(asc(automationRules.priority), desc(automationRules.updatedAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [total] = await app.db.select({ n: count() }).from(automationRules).where(where);
    return paginate(items.map(serializeRule), Number(total?.n ?? 0), q);
  });

  app.post("/automation/rules", { preHandler: adminGate }, async (req, reply) => {
    const body = ruleBodySchema.parse(req.body);
    const rule = await createRule(req, body, undefined, null);
    return reply.status(201).send(serializeRule(rule));
  });

  app.get("/automation/rules/:id", { preHandler: memberGate }, async (req) => {
    const { id } = req.params as { id: string };
    const rule = await loadRule(req, id);
    await assertRuleVisible(req, rule);
    const recent = await engine.recentRuns(rule.id, 10);
    return { rule: serializeRule(rule), recentRuns: recent };
  });

  app.patch("/automation/rules/:id", { preHandler: adminGate }, async (req) => {
    const { id } = req.params as { id: string };
    const rule = await loadRule(req, id);
    if (rule.status === "archived") throw conflict("An archived rule cannot be edited");
    return patchRule(req, rule, rulePatchSchema.parse(req.body));
  });

  app.delete("/automation/rules/:id", { preHandler: adminGate }, async (req) => {
    const { id } = req.params as { id: string };
    const rule = await loadRule(req, id);
    if (rule.status === "archived") throw conflict("Rule is already archived");
    return transition(req, rule, "archived");
  });

  app.post("/automation/rules/:id/activate", { preHandler: adminGate }, async (req) => {
    const { id } = req.params as { id: string };
    return transition(req, await loadRule(req, id), "active");
  });

  app.post("/automation/rules/:id/pause", { preHandler: adminGate }, async (req) => {
    const { id } = req.params as { id: string };
    return transition(req, await loadRule(req, id), "paused");
  });

  app.post("/automation/rules/:id/test", { preHandler: adminGate }, async (req) => {
    const { id } = req.params as { id: string };
    const rule = await loadRule(req, id);
    const body = testBodySchema.parse(req.body ?? {});
    return engine.dryRun(rule, body);
  });

  /** Dry-run a rule that has not been saved — what the builder's "Test" button calls. */
  app.post("/automation/rules/test", { preHandler: adminGate }, async (req) => {
    const body = unsavedTestBodySchema.parse(req.body);
    if (body.rule.projectId) await assertProjectInCompany(body.rule.projectId, req.companyId!);
    const trigger = body.rule.trigger;
    return engine.dryRun(
      {
        id: "",
        companyId: req.companyId!,
        name: body.rule.name,
        projectId: body.rule.projectId ?? null,
        conditions: (body.rule.conditions ?? null) as AutomationConditionJson | null,
        actions: body.rule.actions as AutomationActionJson[],
        triggerKind: trigger.kind,
        triggerObjectType: trigger.objectType,
        triggerAction: trigger.kind === "event" ? (trigger.action ?? "*") : "*",
      },
      { objectId: body.objectId, record: body.record, event: body.event },
    );
  });

  /* ---------------------------------------------------------------- */
  /* Runs — company level                                              */
  /* ---------------------------------------------------------------- */

  app.get("/automation/runs", { preHandler: memberGate }, async (req) => {
    const q = runsQuerySchema.parse(req.query);
    const visible = await visibleProjectIds(req);
    const conds: (SQL | undefined)[] = [eq(automationRuns.companyId, req.companyId!), projectScope(automationRuns.projectId, visible)];
    if (q.ruleId) conds.push(eq(automationRuns.ruleId, q.ruleId));
    if (q.status) conds.push(eq(automationRuns.status, q.status));
    if (q.projectId) conds.push(eq(automationRuns.projectId, q.projectId));
    if (q.objectType) conds.push(eq(automationRuns.objectType, q.objectType));
    if (q.objectId) conds.push(eq(automationRuns.objectId, q.objectId));
    const where = and(...conds);
    const items = await app.db
      .select()
      .from(automationRuns)
      .where(where)
      .orderBy(desc(automationRuns.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [total] = await app.db.select({ n: count() }).from(automationRuns).where(where);
    return paginate(items, Number(total?.n ?? 0), q);
  });

  app.get("/automation/runs/:id", { preHandler: memberGate }, async (req) => {
    const { id } = req.params as { id: string };
    return loadRun(req, id);
  });

  app.post("/automation/runs/:id/retry", { preHandler: adminGate }, async (req) => {
    const { id } = req.params as { id: string };
    const run = await loadRun(req, id);
    if (!["failed", "throttled", "queued"].includes(run.status)) {
      throw conflict(`Only failed, throttled or queued runs can be retried (this one is ${run.status})`);
    }
    await app.db
      .update(automationRuns)
      .set({ status: "queued", queuedAt: new Date().toISOString(), attempts: 0, error: null, finishedAt: null })
      .where(eq(automationRuns.id, run.id));
    const result = await engine.executeRun(run.id);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      projectId: run.projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "automation_run",
      objectId: run.id,
      payload: { retry: true, from: run.status, to: result.status },
    });
    return result;
  });

  /* ---------------------------------------------------------------- */
  /* Engine operations                                                 */
  /* ---------------------------------------------------------------- */

  app.get("/automation/summary", { preHandler: memberGate }, async (req) => {
    const visible = await visibleProjectIds(req);
    return summaryFor(req.companyId!, visible, new Date());
  });

  app.get("/automation/status", { preHandler: adminGate }, async () => ({
    engine: engine.getHealth(),
    options: {
      maxActionsPerMinute: engine.options.maxActionsPerMinute,
      maxChainDepth: engine.options.maxChainDepth,
      maxAttempts: engine.options.maxAttempts,
      drainBatch: engine.options.drainBatch,
      requestTimeoutMs: engine.options.requestTimeoutMs,
      webhookSigning: process.env["AUTOMATION_WEBHOOK_SECRET"] ? "AUTOMATION_WEBHOOK_SECRET" : "AUTH_SECRET_FALLBACK",
    },
    jobs: app.scheduler.list().filter((j) => j.name.startsWith("automation.")),
    scheduler: { enabled: app.scheduler.enabled },
  }));

  /** Manual cycle for this company: scan schedule rules, then drain queued runs. */
  app.post("/automation/run", { preHandler: adminGate }, async (req) => {
    const body = runCycleBodySchema.parse(req.body ?? {});
    const now = new Date();
    const scan = body.scan === false ? null : await engine.scanSchedules(req.companyId!, now, body.force === true);
    const drain = body.drain === false ? null : await engine.drain(undefined, req.companyId!);
    return { at: now.toISOString(), scan, drain, health: engine.getHealth() };
  });

  /* ---------------------------------------------------------------- */
  /* Project-scoped routes                                             */
  /* ---------------------------------------------------------------- */

  async function loadProjectRule(req: FastifyRequest, id: string, ownOnly: boolean): Promise<RuleRow> {
    const rule = await loadRule(req, id);
    if (rule.projectId === req.projectId!) return rule;
    if (!ownOnly && rule.projectId === null) return rule;
    throw notFound("Automation rule not found in this project");
  }

  app.get("/projects/:projectId/automation/rules", { preHandler: projectRead }, async (req) => {
    const q = rulesQuerySchema.parse(req.query);
    const conds: (SQL | undefined)[] = [
      eq(automationRules.companyId, req.companyId!),
      or(eq(automationRules.projectId, req.projectId!), isNull(automationRules.projectId)),
    ];
    if (q.status) conds.push(eq(automationRules.status, q.status));
    else conds.push(inArray(automationRules.status, ["draft", "active", "paused"]));
    if (q.objectType) conds.push(eq(automationRules.triggerObjectType, q.objectType));
    if (q.triggerKind) conds.push(eq(automationRules.triggerKind, q.triggerKind));
    if (q.search) conds.push(ilike(automationRules.name, `%${q.search}%`));
    const where = and(...conds);
    const items = await app.db
      .select()
      .from(automationRules)
      .where(where)
      .orderBy(asc(automationRules.priority), desc(automationRules.updatedAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [total] = await app.db.select({ n: count() }).from(automationRules).where(where);
    return paginate(items.map(serializeRule), Number(total?.n ?? 0), q);
  });

  app.post("/projects/:projectId/automation/rules", { preHandler: projectAdmin }, async (req, reply) => {
    const body = ruleBodySchema.parse(req.body);
    const rule = await createRule(req, body, req.projectId!, null);
    return reply.status(201).send(serializeRule(rule));
  });

  app.post("/projects/:projectId/automation/templates/:key/instantiate", { preHandler: projectAdmin }, async (req, reply) => {
    const { key } = req.params as { key: string };
    const template = ruleTemplate(key);
    if (!template) throw notFound(`Unknown template "${key}"`);
    const body = instantiateBodySchema.parse(req.body ?? {});
    const actions = template.actions.map((a, i) => ({
      type: a.type,
      params: { ...a.params, ...(body.actionOverrides?.[String(i)] ?? {}) },
    }));
    const parsed = ruleBodySchema.parse({
      name: body.name ?? template.name,
      description: template.description,
      status: body.status ?? "draft",
      trigger: template.trigger,
      conditions: template.conditions,
      actions,
      immediate: body.immediate ?? template.immediate,
    });
    const rule = await createRule(req, parsed, req.projectId!, template.key);
    return reply.status(201).send(serializeRule(rule));
  });

  app.get("/projects/:projectId/automation/rules/:id", { preHandler: projectRead }, async (req) => {
    const { id } = req.params as { id: string };
    const rule = await loadProjectRule(req, id, false);
    const recent = await engine.recentRuns(rule.id, 10);
    return { rule: serializeRule(rule), recentRuns: recent.filter((r) => r.projectId === req.projectId || r.projectId === null) };
  });

  app.patch("/projects/:projectId/automation/rules/:id", { preHandler: projectAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    const rule = await loadProjectRule(req, id, true);
    if (rule.status === "archived") throw conflict("An archived rule cannot be edited");
    return patchRule(req, rule, rulePatchSchema.parse(req.body));
  });

  app.delete("/projects/:projectId/automation/rules/:id", { preHandler: projectAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    const rule = await loadProjectRule(req, id, true);
    if (rule.status === "archived") throw conflict("Rule is already archived");
    return transition(req, rule, "archived");
  });

  app.post("/projects/:projectId/automation/rules/:id/activate", { preHandler: projectAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    return transition(req, await loadProjectRule(req, id, true), "active");
  });

  app.post("/projects/:projectId/automation/rules/:id/pause", { preHandler: projectAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    return transition(req, await loadProjectRule(req, id, true), "paused");
  });

  app.post("/projects/:projectId/automation/rules/:id/test", { preHandler: projectStandard }, async (req) => {
    const { id } = req.params as { id: string };
    const rule = await loadProjectRule(req, id, false);
    const body = testBodySchema.parse(req.body ?? {});
    // A project-level tester may only dry-run against this project's records.
    // The project comes from the snapshot registry, never from a `projectId`
    // key on the row: a project record IS its own project and carries no such
    // column, so reading the field would let this route return another
    // project's row. Company-level records (no project at all) stay allowed.
    if (body.objectId) {
      const snapshot = await loadSnapshot(app.db, req.companyId!, rule.triggerObjectType, body.objectId);
      if (snapshot && snapshot.projectId !== null && snapshot.projectId !== req.projectId) {
        throw forbidden("That record belongs to a different project");
      }
    }
    return engine.dryRun(rule, { ...body, persist: false });
  });

  app.get("/projects/:projectId/automation/runs", { preHandler: projectRead }, async (req) => {
    const q = runsQuerySchema.parse(req.query);
    const conds: (SQL | undefined)[] = [eq(automationRuns.companyId, req.companyId!), eq(automationRuns.projectId, req.projectId!)];
    if (q.ruleId) conds.push(eq(automationRuns.ruleId, q.ruleId));
    if (q.status) conds.push(eq(automationRuns.status, q.status));
    if (q.objectType) conds.push(eq(automationRuns.objectType, q.objectType));
    if (q.objectId) conds.push(eq(automationRuns.objectId, q.objectId));
    const where = and(...conds);
    const items = await app.db
      .select()
      .from(automationRuns)
      .where(where)
      .orderBy(desc(automationRuns.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [total] = await app.db.select({ n: count() }).from(automationRuns).where(where);
    return paginate(items, Number(total?.n ?? 0), q);
  });

  app.get("/projects/:projectId/automation/runs/:id", { preHandler: projectRead }, async (req) => {
    const { id } = req.params as { id: string };
    const [row] = await app.db
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.id, id), eq(automationRuns.companyId, req.companyId!), eq(automationRuns.projectId, req.projectId!)))
      .limit(1);
    if (!row) throw notFound("Automation run not found in this project");
    return row;
  });

  app.get("/projects/:projectId/automation/summary", { preHandler: projectRead }, async (req) => {
    return summaryFor(req.companyId!, [req.projectId!], new Date());
  });

  /** Plan §3.5 — what the intelligence layer reads about this project's automation. */
  app.get("/projects/:projectId/automation/health-inputs", { preHandler: projectRead }, async (req) => {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
    const reasons: string[] = [];
    const [rules] = await app.db
      .select({ n: count() })
      .from(automationRules)
      .where(
        and(
          eq(automationRules.companyId, req.companyId!),
          eq(automationRules.status, "active"),
          or(eq(automationRules.projectId, req.projectId!), isNull(automationRules.projectId)),
        ),
      );
    const runRows = await app.db
      .select({ status: automationRuns.status, n: count() })
      .from(automationRuns)
      .where(and(eq(automationRuns.companyId, req.companyId!), eq(automationRuns.projectId, req.projectId!), gte(automationRuns.createdAt, dayAgo)))
      .groupBy(automationRuns.status);
    const byStatus: Record<string, number> = {};
    for (const r of runRows) byStatus[r.status] = Number(r.n);
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const activeRules = Number(rules?.n ?? 0);
    if (activeRules === 0) reasons.push("No active automation rules cover this project; failure metrics are null because nothing could have failed.");
    return {
      metrics: {
        activeRules,
        runs24h: activeRules === 0 ? null : total,
        failedRuns24h: activeRules === 0 ? null : (byStatus["failed"] ?? 0),
        throttledRuns24h: activeRules === 0 ? null : (byStatus["throttled"] ?? 0),
        queuedRuns: activeRules === 0 ? null : (byStatus["queued"] ?? 0),
      },
      reasons,
    };
  });
};
