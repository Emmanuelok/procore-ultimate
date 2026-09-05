/**
 * Engine behaviour end to end: the ledger hook, immediate vs queued execution,
 * the loop guard and chain depth, the per-company rate limit, schedule scans
 * with cooldown, dry runs, derived facts, and every executor against the real
 * tables. Each scenario creates its own rule; events are produced either
 * through the platform's own routes (RFIs) or by writing a row and appending
 * to the ledger the way a detector would.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  aiReviewQueue,
  automationRules,
  automationRuns,
  distributionGroupMembers,
  distributionGroups,
  insuranceCertificates,
  ledgerEntries,
  meetingActionItems,
  notifications,
  obligations,
  rfis,
  signals,
  tagAssignments,
  tags,
  vendors,
} from "@constructos/db";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import {
  createRecordingClient,
  executeAction,
  resolveRecipients,
  signWebhookBody,
  type ExecutorDeps,
  type RunFacts,
} from "./actions.js";
import type { EvaluationContext } from "./predicates.js";
import {
  addCompanyMember,
  buildAutomationApp,
  createProject,
  createRfi,
  dayOffset,
  registerActor,
  url,
  type AutomationTestApp,
  type TestActor,
} from "./test-utils.js";

let t: AutomationTestApp;
let owner: TestActor;
let outsider: TestActor;
let projectId: string;

async function createRule(actor: TestActor, payload: Record<string, unknown>): Promise<{ id: string }> {
  const res = await t.app.inject({
    method: "POST",
    url: url("/automation/rules"),
    headers: actor.headers,
    payload: { status: "active", ...payload },
  });
  if (res.statusCode !== 201) throw new Error(`createRule failed: ${res.statusCode} ${res.body}`);
  return res.json() as { id: string };
}

async function runsFor(ruleId: string) {
  return t.app.db.select().from(automationRuns).where(eq(automationRuns.ruleId, ruleId)).orderBy(desc(automationRuns.createdAt));
}

async function raiseSignal(companyId: string, detector: string, severity = "medium", actorId: string | null = null) {
  const id = newId("sig");
  await t.app.db.insert(signals).values({
    id,
    companyId,
    projectId,
    detector,
    severity,
    confidence: 0.9,
    title: `Signal ${detector}`,
    explanation: "test",
  });
  await appendLedger(t.app.db, { companyId, projectId, actorId, action: "create", objectType: "signal", objectId: id });
  return id;
}

beforeAll(async () => {
  t = await buildAutomationApp();
  owner = await registerActor(t.app);
  outsider = await registerActor(t.app);
  projectId = await createProject(t.app, owner, "Engine project");
}, 600_000);

afterAll(async () => {
  await t.close();
});

/* ================================================================== */
/* Event path                                                          */
/* ================================================================== */

describe("event rules", () => {
  it("an immediate rule fires on a ledger event, evaluates conditions and acts", async () => {
    const rule = await createRule(owner, {
      name: "Rebar RFIs",
      trigger: { kind: "event", objectType: "rfi", action: "create" },
      conditions: { all: [{ field: "record.subject", op: "contains", value: "rebar" }] },
      actions: [
        {
          type: "notify",
          params: { to: [{ kind: "roles", roles: ["owner"] }], title: "RFI {{record.number}}: {{record.subject}}", body: "{{event.action}}" },
        },
      ],
      immediate: true,
    });
    const rfi = await createRfi(t.app, owner, projectId, { subject: "Rebar spacing" });
    const [run] = await runsFor(rule.id);
    expect(run?.status).toBe("succeeded");
    expect(run?.eventSeq).not.toBeNull();
    expect(run?.projectId).toBe(projectId);
    expect(run?.objectId).toBe(rfi.id);
    expect(run?.actorId).toBe(owner.userId);
    expect(run?.context?.recordKnown).toBe(true);
    expect(run?.conditionResult?.matched).toBe(true);
    expect(run?.conditionResult?.evaluations?.[0]).toMatchObject({ field: "record.subject", op: "contains", result: true });
    expect(run?.actionResults[0]).toMatchObject({ type: "notify", outcome: "done", detail: { recipients: 1 } });
    expect(run?.actionCount).toBe(1);

    const notes = await t.app.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, owner.userId), eq(notifications.recordId, rfi.id)));
    expect(notes.map((n) => n.title)).toContain(`RFI ${rfi.number}: Rebar spacing`);
    expect(notes[0]?.kind).toBe("automation");
    expect(notes[0]?.body).toBe("create");

    // a non-matching event leaves a skipped run and does not count against the rule
    await createRfi(t.app, owner, projectId, { subject: "Formwork" });
    const runs = await runsFor(rule.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.status).toBe("skipped");
    expect(runs[0]?.conditionResult?.reason).toContain("record.subject contains");
    const [row] = await t.app.db.select().from(automationRules).where(eq(automationRules.id, rule.id));
    expect(row?.runCount).toBe(1);
    expect(row?.failureCount).toBe(0);
    expect(row?.lastRunAt).not.toBeNull();

    // the run is ledgered with the system actor and did not re-trigger anything
    const entries = await t.app.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.companyId, owner.companyId), eq(ledgerEntries.objectType, "automation_run")));
    expect(entries.some((e) => e.objectId === run!.id && e.actorId === null)).toBe(true);
    expect(t.engine.getHealth().eventsMatched).toBeGreaterThan(0);
    await t.app.inject({ method: "POST", url: url(`/automation/rules/${rule.id}/pause`), headers: owner.headers });
  });

  it("a queued rule waits for the drain job", async () => {
    const rule = await createRule(owner, {
      name: "Tag every RFI",
      trigger: { kind: "event", objectType: "rfi", action: "create" },
      actions: [{ type: "tag", params: { name: "auto-{{event.action}}" } }],
      immediate: false,
    });
    const rfi = await createRfi(t.app, owner, projectId, { subject: "Queued" });
    let [run] = await runsFor(rule.id);
    expect(run?.status).toBe("queued");
    const job = await t.app.scheduler.runNow("automation.drain");
    expect(job.state).toBe("succeeded");
    expect((job.lastResult as { executed: number }).executed).toBeGreaterThanOrEqual(1);
    [run] = await runsFor(rule.id);
    expect(run?.status).toBe("succeeded");
    const [tag] = await t.app.db.select().from(tags).where(and(eq(tags.companyId, owner.companyId), eq(tags.name, "auto-create")));
    expect(tag).toBeDefined();
    const assignments = await t.app.db.select().from(tagAssignments).where(and(eq(tagAssignments.tagId, tag!.id), eq(tagAssignments.recordId, rfi.id)));
    expect(assignments).toHaveLength(1);
    // idempotent: draining again does nothing
    expect((await t.engine.drain()).executed).toBe(0);
    await t.app.inject({ method: "POST", url: url(`/automation/rules/${rule.id}/pause`), headers: owner.headers });
  });

  it("a project-scoped rule ignores events from other projects and a paused rule skips its queued runs", async () => {
    const other = await createProject(t.app, owner, "Other engine project");
    const rule = await createRule(owner, {
      name: "Only the other project",
      projectId: other,
      trigger: { kind: "event", objectType: "rfi", action: "*" },
      actions: [{ type: "tag", params: { name: "scoped" } }],
      immediate: false,
    });
    await createRfi(t.app, owner, projectId, { subject: "Wrong project" });
    expect(await runsFor(rule.id)).toHaveLength(0);
    await createRfi(t.app, owner, other, { subject: "Right project" });
    expect(await runsFor(rule.id)).toHaveLength(1);
    await t.app.inject({ method: "POST", url: url(`/automation/rules/${rule.id}/pause`), headers: owner.headers });
    await t.engine.drain();
    const [run] = await runsFor(rule.id);
    expect(run?.status).toBe("skipped");
    expect(run?.error).toContain("paused");
  });

  it("unknown object types get an event-only context", async () => {
    const rule = await createRule(owner, {
      name: "Widgets",
      trigger: { kind: "event", objectType: "widget", action: "create" },
      conditions: { all: [{ field: "event.action", op: "eq", value: "create" }] },
      actions: [{ type: "tag", params: { name: "widget-seen" } }],
      immediate: true,
    });
    await appendLedger(t.app.db, { companyId: owner.companyId, projectId, actorId: owner.userId, action: "create", objectType: "widget", objectId: "wid_1" });
    const [run] = await runsFor(rule.id);
    expect(run?.status).toBe("succeeded");
    expect(run?.context?.recordKnown).toBe(false);
    expect(run?.context?.record).toBeNull();
    await t.app.inject({ method: "POST", url: url(`/automation/rules/${rule.id}/pause`), headers: owner.headers });
  });
});

/* ================================================================== */
/* Loop guard                                                          */
/* ================================================================== */

describe("loop guard", () => {
  it("a rule may not trigger itself", async () => {
    const rule = await createRule(owner, {
      name: "Echo signals",
      trigger: { kind: "event", objectType: "signal", action: "create" },
      actions: [{ type: "create_signal", params: { detector: "echo", severity: "low", title: "Echo of {{record.title}}" } }],
      immediate: true,
    });
    const before = (await t.app.db.select().from(signals).where(eq(signals.companyId, owner.companyId))).length;
    await raiseSignal(owner.companyId, "detector.x");
    const runs = await runsFor(rule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("succeeded");
    expect(runs[0]?.depth).toBe(0);
    const after = await t.app.db.select().from(signals).where(eq(signals.companyId, owner.companyId));
    expect(after.length).toBe(before + 2); // the original and one echo — not an infinite chain
    expect(after.some((s) => s.detector === "automation.echo")).toBe(true);
    await t.app.inject({ method: "POST", url: url(`/automation/rules/${rule.id}/pause`), headers: owner.headers });
  });

  it("chains between rules are attributed and bounded by max depth", async () => {
    const a = await createRule(owner, {
      name: "Obligation → signal",
      trigger: { kind: "event", objectType: "obligation", action: "create" },
      actions: [{ type: "create_signal", params: { detector: "chain_a", severity: "medium" } }],
      immediate: true,
    });
    const b = await createRule(owner, {
      name: "chain_a signal → tag",
      trigger: { kind: "event", objectType: "signal", action: "create" },
      conditions: { all: [{ field: "record.detector", op: "eq", value: "automation.chain_a" }] },
      actions: [{ type: "tag", params: { name: "chained" } }],
      immediate: true,
    });
    const insertObligation = async () => {
      const id = newId("obl");
      await t.app.db.insert(obligations).values({
        id,
        companyId: owner.companyId,
        projectId,
        sourceClause: "cl.1",
        trigger: `Obligation ${id}`,
        createdBy: owner.userId,
      });
      await appendLedger(t.app.db, { companyId: owner.companyId, projectId, actorId: owner.userId, action: "create", objectType: "obligation", objectId: id });
    };

    t.engine.configure({ maxChainDepth: 0 });
    await insertObligation();
    expect((await runsFor(a.id)).length).toBe(1);
    expect((await runsFor(b.id)).length).toBe(0);

    t.engine.configure({ maxChainDepth: 3 });
    await insertObligation();
    const aRuns = await runsFor(a.id);
    expect(aRuns).toHaveLength(2);
    const bRuns = await runsFor(b.id);
    expect(bRuns).toHaveLength(1);
    expect(bRuns[0]?.status).toBe("succeeded");
    expect(bRuns[0]?.depth).toBe(1);
    expect(bRuns[0]?.causedByRunId).toBe(aRuns[0]?.id);
    for (const id of [a.id, b.id]) {
      await t.app.inject({ method: "POST", url: url(`/automation/rules/${id}/pause`), headers: owner.headers });
    }
  });

  it("automation's own ledger entries never fire rules", async () => {
    const rule = await createRule(owner, {
      name: "Everything",
      trigger: { kind: "event", objectType: "*", action: "*" },
      actions: [{ type: "tag", params: { name: "everything" } }],
      immediate: false,
    });
    const seen = t.engine.getHealth().eventsSeen;
    await appendLedger(t.app.db, { companyId: owner.companyId, actorId: null, action: "create", objectType: "automation_run", objectId: "arun_fake" });
    await appendLedger(t.app.db, { companyId: owner.companyId, actorId: owner.userId, action: "update", objectType: "automation_rule", objectId: rule.id });
    expect(t.engine.getHealth().eventsSeen).toBe(seen + 2);
    expect(await runsFor(rule.id)).toHaveLength(0);
    await t.app.inject({ method: "POST", url: url(`/automation/rules/${rule.id}/pause`), headers: owner.headers });
  });
});

/* ================================================================== */
/* Rate limit                                                          */
/* ================================================================== */

describe("rate limit", () => {
  it("defers a run past the per-company budget, then throttles it after max attempts", async () => {
    const co = await registerActor(t.app); // a fresh company: its minute budget is untouched
    const p = await createProject(t.app, co, "Rate limited");
    const rule = await createRule(co, {
      name: "Notify on RFI",
      trigger: { kind: "event", objectType: "rfi", action: "create" },
      actions: [{ type: "notify", params: { to: [{ kind: "roles", roles: ["owner"] }] } }],
      immediate: false,
    });
    const saved = { ...t.engine.options };
    t.engine.configure({ maxActionsPerMinute: 1, maxAttempts: 2 });
    try {
      await createRfi(t.app, co, p, { subject: "one" });
      await createRfi(t.app, co, p, { subject: "two" });
      const first = await t.engine.drain();
      expect(first.succeeded).toBe(1);
      expect(first.deferred).toBe(1);
      const runs = await runsFor(rule.id);
      const deferred = runs.find((r) => r.status === "queued")!;
      expect(deferred.attempts).toBe(1);
      expect(deferred.error).toContain("deferred");
      expect(Date.parse(deferred.queuedAt)).toBeGreaterThan(Date.now() + 30_000);
      // a drain does not pick it up before its new queuedAt
      expect((await t.engine.drain()).executed).toBe(0);
      const throttled = await t.engine.executeRun(deferred.id);
      expect(throttled.status).toBe("throttled");
      expect(throttled.attempts).toBe(2);
      expect(t.engine.getHealth().runsThrottled).toBeGreaterThanOrEqual(1);
    } finally {
      t.engine.configure({ maxActionsPerMinute: saved.maxActionsPerMinute, maxAttempts: saved.maxAttempts });
    }
    // an operator retry with the budget restored succeeds
    const throttledRun = (await runsFor(rule.id)).find((r) => r.status === "throttled")!;
    const retry = await t.app.inject({ method: "POST", url: url(`/automation/runs/${throttledRun.id}/retry`), headers: co.headers });
    expect(retry.statusCode).toBe(200);
    expect((retry.json() as { status: string }).status).toBe("succeeded");
  });
});

/* ================================================================== */
/* Schedule path                                                       */
/* ================================================================== */

describe("schedule rules", () => {
  it("scans live records, fires once per cooldown window, and respects everyMinutes", async () => {
    const rule = await createRule(owner, {
      name: "Overdue drafts",
      trigger: { kind: "schedule", objectType: "rfi", everyMinutes: 60, cooldownHours: 24 },
      conditions: {
        all: [
          { field: "record.status", op: "eq", value: "draft" },
          { field: "record.dueDate", op: "overdue_by_days", value: 3 },
        ],
      },
      actions: [{ type: "tag", params: { name: "overdue" } }],
    });
    const overdue = await createRfi(t.app, owner, projectId, { subject: "Late", dueDate: dayOffset(-5) });
    await createRfi(t.app, owner, projectId, { subject: "Not yet", dueDate: dayOffset(5) });
    const closedLate = await createRfi(t.app, owner, projectId, { subject: "Closed late", dueDate: dayOffset(-9) });
    await t.app.db.update(rfis).set({ status: "closed" }).where(eq(rfis.id, closedLate.id));

    const first = await t.engine.scanSchedules(owner.companyId);
    expect(first.rulesScanned).toBe(1);
    expect(first.matched).toBe(1);
    expect(first.executed).toBe(1);
    expect(first.deduped).toBe(0);
    const runs = await runsFor(rule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ objectId: overdue.id, action: "scan", eventSeq: null, status: "succeeded", triggerKind: "schedule" });

    // not due again for an hour
    expect((await t.engine.scanSchedules(owner.companyId)).rulesScanned).toBe(0);
    // forced: still inside the cooldown for that record
    const forced = await t.engine.scanSchedules(owner.companyId, new Date(), true);
    expect(forced).toMatchObject({ rulesScanned: 1, matched: 1, deduped: 1, executed: 0 });
    expect(await runsFor(rule.id)).toHaveLength(1);
    // past the cooldown it fires again
    const later = new Date(Date.now() + 25 * 3_600_000);
    const again = await t.engine.scanSchedules(owner.companyId, later);
    expect(again.executed).toBe(1);
    expect(await runsFor(rule.id)).toHaveLength(2);

    const [row] = await t.app.db.select().from(automationRules).where(eq(automationRules.id, rule.id));
    expect(row?.lastScanAt).not.toBeNull();
    await t.app.inject({ method: "POST", url: url(`/automation/rules/${rule.id}/pause`), headers: owner.headers });
  });

  it("the scheduler job scans every company", async () => {
    const job = await t.app.scheduler.runNow("automation.schedules");
    expect(job.state).toBe("succeeded");
    expect((job.lastResult as { companies: number }).companies).toBeGreaterThanOrEqual(2);
  });
});

/* ================================================================== */
/* Dry run and derived facts                                           */
/* ================================================================== */

describe("dry run", () => {
  it("evaluates a saved rule against a real record and describes the plan without executing", async () => {
    const rule = await createRule(owner, {
      name: "Dry",
      status: "draft",
      trigger: { kind: "event", objectType: "rfi", action: "update" },
      conditions: { all: [{ field: "record.subject", op: "starts_with", value: "dry" }] },
      actions: [{ type: "tag", params: { name: "dry-{{record.number}}" } }],
    });
    const rfi = await createRfi(t.app, owner, projectId, { subject: "Dry run target" });
    const [row] = await t.app.db.select().from(automationRules).where(eq(automationRules.id, rule.id));
    const result = await t.engine.dryRun(row!, { objectId: rfi.id, persist: true });
    expect(result.matched).toBe(true);
    expect(result.context.recordSource).toBe("loaded");
    expect(result.plannedActions[0]).toMatchObject({ type: "tag", wouldRun: true, description: `Tag with "dry-${rfi.number}"` });
    expect(result.warnings).toEqual([]);
    expect(result.runId).not.toBeNull();
    const [run] = await t.app.db.select().from(automationRuns).where(eq(automationRuns.id, result.runId!));
    expect(run).toMatchObject({ status: "dry_run", dryRun: 1 });
    expect(run?.actionResults[0]?.outcome).toBe("skipped");
    // nothing was tagged
    expect(await t.app.db.select().from(tags).where(and(eq(tags.companyId, owner.companyId), eq(tags.name, `dry-${rfi.number}`)))).toHaveLength(0);

    const missing = await t.engine.dryRun(row!, { objectId: "rfi_nope" });
    expect(missing.warnings.some((w) => w.includes("not found"))).toBe(true);
    expect(missing.matched).toBe(false);
  });

  it("warns about unknown types and missing records for unsaved rules", async () => {
    const result = await t.engine.dryRun(
      {
        id: "",
        companyId: owner.companyId,
        name: "Unsaved",
        projectId: null,
        conditions: { all: [{ field: "record.total", op: "gte", value: 100 }] },
        actions: [{ type: "webhook", params: { url: "https://x.example/h" } }],
        triggerKind: "event",
        triggerObjectType: "widget",
        triggerAction: "*",
      },
      { record: { total: 250 } },
    );
    expect(result.matched).toBe(true);
    expect(result.context.recordSource).toBe("sample");
    expect(result.warnings.some((w) => w.includes("snapshot registry"))).toBe(true);
    const none = await t.engine.dryRun(
      { id: "", companyId: owner.companyId, name: "U", projectId: null, conditions: { all: [{ field: "record.x", op: "exists" }] }, actions: [], triggerKind: "schedule", triggerObjectType: "rfi", triggerAction: "*" },
      {},
    );
    expect(none.context.event).toBeNull();
    expect(none.warnings.some((w) => w.includes("No record supplied"))).toBe(true);
  });

  it("derived.vendorInsuranceValid reads the vendor's certificates for this company", async () => {
    const vendorId = newId("vnd");
    await t.app.db.insert(vendors).values({ id: vendorId, companyId: owner.companyId, name: "Uninsured Ltd" });
    const rule = {
      id: "",
      companyId: owner.companyId,
      name: "Insurance",
      projectId: null,
      conditions: { all: [{ field: "derived.vendorInsuranceValid", op: "is_false" }] },
      actions: [],
      triggerKind: "event" as const,
      triggerObjectType: "invoice",
      triggerAction: "*",
    };
    expect((await t.engine.dryRun(rule, { record: { vendorId } })).matched).toBe(true);
    await t.app.db.insert(insuranceCertificates).values({
      id: newId("cert"),
      companyId: owner.companyId,
      vendorId,
      subjectName: "Uninsured Ltd",
      policyType: "public_liability",
      validFrom: dayOffset(-30),
      validTo: dayOffset(30),
      createdBy: owner.userId,
    });
    const covered = await t.engine.dryRun(rule, { record: { vendorId } });
    expect(covered.matched).toBe(false);
    expect(covered.context.derived).toEqual({ vendorInsuranceValid: true });
    // a certificate held by another company does not count, and no vendor means unknowable (not false)
    expect((await t.engine.dryRun({ ...rule, companyId: outsider.companyId }, { record: { vendorId } })).matched).toBe(true);
    const noVendor = await t.engine.dryRun(rule, { record: {} });
    expect(noVendor.matched).toBe(false);
    expect(noVendor.context.derived).toEqual({ vendorInsuranceValid: null });
  });
});

/* ================================================================== */
/* Executors                                                           */
/* ================================================================== */

describe("executors", () => {
  let facts: RunFacts;
  let ctx: EvaluationContext;
  let rfiId: string;
  const http = createRecordingClient((call) => {
    if (call.url.includes("boom")) throw new Error("socket hang up");
    return { status: call.url.includes("fail") ? 500 : 200, body: "ok" };
  });
  const origins: string[] = [];
  let deps: ExecutorDeps;

  beforeAll(async () => {
    const rfi = await createRfi(t.app, owner, projectId, { subject: "Executor target", ballInCourtId: owner.userId, dueDate: dayOffset(10) });
    rfiId = rfi.id;
    facts = {
      runId: "arun_test",
      ruleId: "arule_test",
      ruleName: "Executor rule",
      companyId: owner.companyId,
      projectId,
      objectType: "rfi",
      objectId: rfi.id,
      actorId: owner.userId,
      recordTitle: "Executor target",
    };
    const [row] = await t.app.db.select().from(rfis).where(eq(rfis.id, rfi.id));
    ctx = { event: { action: "update", objectType: "rfi", objectId: rfi.id }, record: row as Record<string, unknown>, now: new Date().toISOString() };
    deps = {
      db: t.app.db,
      http,
      markOrigin: (type, id) => origins.push(`${type}:${id}`),
      now: () => new Date(),
      webhookSigningSecret: "engine-secret",
    };
  }, 600_000);

  it("create_obligation is idempotent while open and takes its deadline from the record", async () => {
    const params = { trigger: "Answer RFI {{record.number}}", deadlineField: "dueDate", warnDaysBefore: 2, sourceClause: "cl.9" };
    const first = await executeAction(deps, facts, ctx, "create_obligation", params);
    expect(first.outcome).toBe("done");
    const id = first.detail["obligationId"] as string;
    const [row] = await t.app.db.select().from(obligations).where(eq(obligations.id, id));
    expect(row).toMatchObject({ projectId, sourceClause: "cl.9", status: "open", warnDaysBefore: 2, createdBy: owner.userId });
    expect(row?.deadline?.slice(0, 10)).toBe(dayOffset(10));
    expect(origins).toContain(`obligation:${id}`);
    const second = await executeAction(deps, facts, ctx, "create_obligation", params);
    expect(second.outcome).toBe("skipped");
    expect(second.detail["obligationId"]).toBe(id);
    expect((await executeAction(deps, { ...facts, projectId: null }, ctx, "create_obligation", params)).outcome).toBe("skipped");
  });

  it("create_signal prefixes the detector and keeps one open signal per rule and record", async () => {
    const first = await executeAction(deps, facts, ctx, "create_signal", { detector: "rfi_watch", severity: "high", confidence: 2, title: "Watch {{record.subject}}" });
    expect(first.outcome).toBe("done");
    expect(first.detail["detector"]).toBe("automation.rfi_watch");
    const [row] = await t.app.db.select().from(signals).where(eq(signals.id, first.detail["signalId"] as string));
    expect(row).toMatchObject({ severity: "high", confidence: 1, title: "Watch Executor target" });
    expect((row?.evidenceRefs as { key: string }).key).toBe(`arule_test:rfi:${rfiId}`);
    expect((await executeAction(deps, facts, ctx, "create_signal", { detector: "rfi_watch" })).outcome).toBe("skipped");
  });

  it("webhook posts a signed envelope and refuses non-public hosts", async () => {
    const before = http.calls.length;
    const ok = await executeAction(deps, facts, ctx, "webhook", { url: "https://receiver.example/hook", headers: { "x-custom": "1", "x-constructos-run": "forged" } });
    expect(ok.outcome).toBe("done");
    expect(ok.detail).toMatchObject({ status: 200, signed: true });
    const call = http.calls[before]!;
    expect(call.headers["x-custom"]).toBe("1");
    expect(call.headers["x-constructos-run"]).toBe("arun_test");
    const ts = Number(call.headers["x-constructos-timestamp"]);
    expect(call.headers["x-constructos-signature"]).toBe(signWebhookBody("engine-secret", ts, "arun_test", call.body));
    const envelope = JSON.parse(call.body) as { type: string; object: { id: string }; record: { subject: string } };
    expect(envelope.type).toBe("automation.rule_fired");
    expect(envelope.object.id).toBe(rfiId);
    expect(envelope.record.subject).toBe("Executor target");

    const custom = await executeAction(deps, facts, ctx, "webhook", { url: "https://receiver.example/hook", secret: "per-endpoint-secret", includeRecord: false });
    const call2 = http.calls[http.calls.length - 1]!;
    expect(custom.outcome).toBe("done");
    expect(call2.headers["x-constructos-signature"]).toBe(signWebhookBody("per-endpoint-secret", Number(call2.headers["x-constructos-timestamp"]), "arun_test", call2.body));
    expect((JSON.parse(call2.body) as { record?: unknown }).record).toBeUndefined();

    for (const bad of [
      "http://localhost:3000/x",
      // the DNS root dot resolves to the same host
      "http://localhost./x",
      "http://LOCALHOST.:3000/x",
      "http://api.localhost./x",
      "http://127.0.0.1/x",
      "http://10.0.0.5/x",
      "http://192.168.1.1/x",
      "http://169.254.169.254/latest",
      "ftp://x.example/y",
      // IPv6 literals, including the v4-mapped form the URL parser rewrites
      // to "[::ffff:7f00:1]" — it still reaches loopback.
      "http://[::1]:3000/x",
      "http://[::ffff:127.0.0.1]:3000/x",
      "http://[::ffff:169.254.169.254]/latest",
      "http://[fd00::1]/x",
    ]) {
      const r = await executeAction(deps, facts, ctx, "webhook", { url: bad });
      expect(r.outcome, bad).toBe("failed");
    }
    expect((await executeAction(deps, facts, ctx, "webhook", { url: "https://fail.example/h" })).error).toContain("responded 500");
    expect((await executeAction(deps, facts, ctx, "webhook", { url: "https://boom.example/h" })).error).toContain("transport error");
  });

  it("run_agent queues one pending review item per rule, record and agent", async () => {
    const first = await executeAction(deps, facts, ctx, "run_agent", { agentKind: "time_bar_notice_drafter", summary: "Draft for {{record.subject}}", params: { tone: "formal" } });
    expect(first.outcome).toBe("done");
    const [row] = await t.app.db.select().from(aiReviewQueue).where(eq(aiReviewQueue.id, first.detail["reviewId"] as string));
    expect(row).toMatchObject({ targetType: "agent_run", targetId: rfiId, status: "pending", summary: "Draft for Executor target", projectId });
    expect(row?.proposal).toMatchObject({ kind: "run_agent", agentKind: "time_bar_notice_drafter", params: { tone: "formal" }, ruleId: "arule_test" });
    expect((await executeAction(deps, facts, ctx, "run_agent", { agentKind: "time_bar_notice_drafter" })).outcome).toBe("skipped");
    expect((await executeAction(deps, facts, ctx, "run_agent", { agentKind: "Bad Kind" })).outcome).toBe("failed");
  });

  it("assign writes only company members into assignable fields", async () => {
    const byField = await executeAction(deps, facts, ctx, "assign", { userField: "ballInCourtId" });
    expect(byField).toMatchObject({ outcome: "done", detail: { userId: owner.userId, field: "assigneeId" } });
    const [row] = await t.app.db.select({ assigneeId: rfis.assigneeId }).from(rfis).where(eq(rfis.id, rfiId));
    expect(row?.assigneeId).toBe(owner.userId);
    const notes = await t.app.db.select().from(notifications).where(and(eq(notifications.userId, owner.userId), eq(notifications.kind, "assignment"), eq(notifications.recordId, rfiId)));
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect((await executeAction(deps, facts, ctx, "assign", { userId: outsider.userId })).outcome).toBe("failed");
    expect((await executeAction(deps, facts, ctx, "assign", { userField: "nothingHere" })).outcome).toBe("failed");
    expect((await executeAction(deps, { ...facts, objectType: "file" }, ctx, "assign", { userId: owner.userId })).outcome).toBe("skipped");
  });

  it("tag and create_task are idempotent per rule and record", async () => {
    const tag = await executeAction(deps, facts, ctx, "tag", { name: "Needs {{record.status}} review", color: "amber" });
    expect(tag.outcome).toBe("done");
    expect(tag.detail["name"]).toBe("Needs draft review");
    expect((await executeAction(deps, facts, ctx, "tag", { name: "Needs draft review" })).outcome).toBe("skipped");
    expect((await executeAction(deps, facts, ctx, "tag", { name: "{{record.nothing}}" })).outcome).toBe("failed");

    const task = await executeAction(deps, facts, ctx, "create_task", { title: "Chase {{record.subject}}", ownerField: "ballInCourtId", dueInDays: 3, priority: "high" });
    expect(task.outcome).toBe("done");
    const [row] = await t.app.db.select().from(meetingActionItems).where(eq(meetingActionItems.id, task.detail["taskId"] as string));
    expect(row).toMatchObject({ title: "Chase Executor target", ownerId: owner.userId, priority: "high", status: "open", linkedRecordId: rfiId, sourceClause: "automation:arule_test" });
    expect(row?.dueDate).toBe(dayOffset(3));
    expect((await executeAction(deps, facts, ctx, "create_task", { title: "Again" })).outcome).toBe("skipped");
    // an owner outside the company is dropped rather than written
    const orphan = await executeAction(deps, { ...facts, ruleId: "arule_other" }, ctx, "create_task", { ownerId: outsider.userId });
    expect(orphan.outcome).toBe("done");
    expect(orphan.detail["ownerId"]).toBeNull();
  });

  it("recipients resolve to company members only, across every target kind", async () => {
    const member = await addCompanyMember(t.app, owner, "member", { projectId, automationLevel: "read" });
    const groupId = newId("dg");
    await t.app.db.insert(distributionGroups).values({ id: groupId, companyId: owner.companyId, projectId: null, name: "Site team" });
    await t.app.db.insert(distributionGroupMembers).values([
      { id: newId("dgm"), groupId, userId: member.userId, memberKey: `u:${member.userId}` },
      { id: newId("dgm"), groupId, userId: outsider.userId, memberKey: `u:${outsider.userId}` },
    ]);
    const r = await resolveRecipients(t.app.db, facts, ctx, [
      { kind: "users", userIds: [outsider.userId] },
      { kind: "roles", roles: ["owner", "bogus"] },
      { kind: "distribution_groups", groupIds: [groupId] },
      { kind: "project_members" },
      { kind: "record_field", field: "ballInCourtId" },
      { kind: "record_field", field: "assigneeId" },
    ]);
    expect(r.userIds.sort()).toEqual([member.userId, owner.userId].sort());
    expect(r.unresolved).toEqual(expect.arrayContaining(["unknown role bogus", `user ${outsider.userId} is not a member of this company`]));
    const none = await executeAction(deps, facts, ctx, "notify", { to: [{ kind: "users", userIds: [outsider.userId] }] });
    expect(none.outcome).toBe("skipped");
    const noProject = await resolveRecipients(t.app.db, { ...facts, projectId: null }, ctx, [{ kind: "project_members" }]);
    expect(noProject.unresolved[0]).toContain("no project");
  });

  it("escalate notifies admins by default, and can raise a signal and reassign", async () => {
    const r = await executeAction(deps, { ...facts, ruleId: "arule_escalate" }, ctx, "escalate", {
      title: "Escalated {{record.subject}}",
      raiseSignal: true,
      severity: "critical",
      reassignTo: owner.userId,
    });
    expect(r.outcome).toBe("done");
    expect(r.detail).toMatchObject({ notifyOutcome: "done", signalOutcome: "done", reassignOutcome: "done" });
    const notes = await t.app.db.select().from(notifications).where(and(eq(notifications.userId, owner.userId), eq(notifications.kind, "escalation")));
    expect(notes.some((n) => n.title === "Escalated Executor target")).toBe(true);
    const sigs = await t.app.db.select().from(signals).where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, "automation.escalation")));
    expect(sigs[0]?.severity).toBe("critical");
    expect((await executeAction(deps, facts, ctx, "nonsense", {})).outcome).toBe("failed");
    // sanity: every executor write in this block registered an origin for the loop guard
    expect(origins.some((o) => o.startsWith("signal:"))).toBe(true);
    expect(origins.some((o) => o.startsWith("ai_review:"))).toBe(true);
    expect(origins.some((o) => o.startsWith("tag_assignment:"))).toBe(true);
    expect(origins.some((o) => o.startsWith("meeting_action_item:"))).toBe(true);
    const openRuns = await t.app.db.select().from(automationRuns).where(and(eq(automationRuns.companyId, owner.companyId), inArray(automationRuns.status, ["running"])));
    expect(openRuns).toHaveLength(0);
  });
});
