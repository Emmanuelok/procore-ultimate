/**
 * Route tests for the automation module: gating and tenancy on every route,
 * the rule lifecycle, project visibility, the template library, dry runs, the
 * run log, engine operations, health inputs and the scheduler registrations.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ledgerEntries } from "@constructos/db";
import { RULE_TEMPLATES } from "./templates.js";
import {
  addCompanyMember,
  buildAutomationApp,
  createProject,
  createRfi,
  registerActor,
  url,
  type AutomationTestApp,
  type TestActor,
} from "./test-utils.js";

let t: AutomationTestApp;
let owner: TestActor;
let outsider: TestActor;
/** company member who administers the project */
let projectAdmin: TestActor;
/** company member who can only read the project */
let projectReader: TestActor;
/** company member with no project at all */
let noProject: TestActor;
let projectId: string;
let otherProjectId: string;

const baseRule = (extra: Record<string, unknown> = {}) => ({
  name: "Test rule",
  trigger: { kind: "event", objectType: "rfi", action: "create" },
  conditions: { all: [{ field: "record.status", op: "eq", value: "draft" }] },
  actions: [{ type: "tag", params: { name: "tested" } }],
  ...extra,
});

async function post(actor: TestActor, path: string, payload?: unknown) {
  return t.app.inject({ method: "POST", url: url(path), headers: actor.headers, payload: payload ?? {} });
}
async function get(actor: TestActor, path: string) {
  return t.app.inject({ method: "GET", url: url(path), headers: actor.headers });
}

beforeAll(async () => {
  t = await buildAutomationApp();
  owner = await registerActor(t.app);
  outsider = await registerActor(t.app);
  projectId = await createProject(t.app, owner, "Route project");
  otherProjectId = await createProject(t.app, owner, "Other route project");
  projectAdmin = await addCompanyMember(t.app, owner, "member", { projectId, automationLevel: "admin" });
  projectReader = await addCompanyMember(t.app, owner, "member", { projectId, automationLevel: "read" });
  noProject = await addCompanyMember(t.app, owner, "member");
}, 600_000);

afterAll(async () => {
  await t.close();
});

describe("catalogue and templates", () => {
  it("any member reads the builder catalogue", async () => {
    const res = await get(noProject, "/automation/catalogue");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { objectTypes: Array<{ objectType: string }>; operators: string[]; actions: Array<{ type: string; label: string }>; limits: { maxActionsPerMinute: number } };
    expect(body.objectTypes.map((o) => o.objectType)).toContain("rfi");
    expect(body.operators).toContain("overdue_by_days");
    expect(body.actions.map((a) => a.type)).toContain("webhook");
    expect(body.limits.maxActionsPerMinute).toBeGreaterThan(0);
    expect((await t.app.inject({ method: "GET", url: url("/automation/catalogue") })).statusCode).toBe(401);
  });

  it("lists the template library", async () => {
    const res = await get(projectReader, "/automation/templates");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ key: string }>; total: number };
    expect(body.total).toBe(RULE_TEMPLATES.length);
    expect(body.items.map((i) => i.key)).toContain("rfi_overdue_escalate");
  });
});

describe("rule creation and validation", () => {
  it("only owners and admins create company rules", async () => {
    expect((await post(noProject, "/automation/rules", baseRule())).statusCode).toBe(403);
    expect((await post(projectAdmin, "/automation/rules", baseRule())).statusCode).toBe(403);
  });

  it("rejects malformed conditions, action params and unscannable schedule types", async () => {
    const badOp = await post(owner, "/automation/rules", baseRule({ conditions: { all: [{ field: "record.x", op: "eval", value: 1 }] } }));
    expect(badOp.statusCode).toBe(400);
    expect(JSON.stringify(badOp.json())).toContain("unknown operator");

    const badParams = await post(owner, "/automation/rules", baseRule({ actions: [{ type: "notify", params: {} }] }));
    expect(badParams.statusCode).toBe(400);
    const issues = (badParams.json() as { details: Array<{ path: unknown[] }> }).details;
    expect(issues.some((i) => i.path.join(".").includes("actions.0.params.to"))).toBe(true);

    const badSchedule = await post(owner, "/automation/rules", baseRule({ trigger: { kind: "schedule", objectType: "widget" } }));
    expect(badSchedule.statusCode).toBe(400);
    expect(JSON.stringify(badSchedule.json())).toContain("record type the platform can scan");

    const badWebhook = await post(owner, "/automation/rules", baseRule({ actions: [{ type: "webhook", params: { url: "not a url" } }] }));
    expect(badWebhook.statusCode).toBe(400);

    const badType = await post(owner, "/automation/rules", baseRule({ actions: [{ type: "delete_everything", params: {} }] }));
    expect(badType.statusCode).toBe(400);

    const noActions = await post(owner, "/automation/rules", baseRule({ actions: [] }));
    expect(noActions.statusCode).toBe(400);

    const foreignProject = await post(owner, "/automation/rules", baseRule({ projectId: "prj_nope" }));
    expect(foreignProject.statusCode).toBe(400);
  });

  it("creates a draft rule with denormalised trigger columns and a ledger entry", async () => {
    const res = await post(owner, "/automation/rules", baseRule({ name: "Draft one", immediate: true, priority: 5 }));
    expect(res.statusCode).toBe(201);
    const rule = res.json() as Record<string, unknown>;
    expect(rule).toMatchObject({
      status: "draft",
      scope: "company",
      projectId: null,
      triggerKind: "event",
      triggerObjectType: "rfi",
      triggerAction: "create",
      immediate: true,
      priority: 5,
      createdBy: owner.userId,
    });
    const entries = await t.app.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.companyId, owner.companyId), eq(ledgerEntries.objectType, "automation_rule"), eq(ledgerEntries.objectId, rule["id"] as string)));
    expect(entries.map((e) => e.action)).toEqual(["create"]);
    expect(entries[0]?.actorId).toBe(owner.userId);
    // an event trigger on an unknown type is allowed: it gets event-only context
    const widget = await post(owner, "/automation/rules", baseRule({ trigger: { kind: "event", objectType: "widget" }, conditions: null }));
    expect(widget.statusCode).toBe(201);
    expect((widget.json() as { triggerAction: string }).triggerAction).toBe("*");
  });
});

describe("rule lifecycle", () => {
  let ruleId: string;

  beforeAll(async () => {
    ruleId = ((await post(owner, "/automation/rules", baseRule({ name: "Lifecycle" }))).json() as { id: string }).id;
  }, 600_000);

  it("activates, pauses, edits and archives with the right conflicts", async () => {
    const activate = await post(owner, `/automation/rules/${ruleId}/activate`);
    expect(activate.statusCode).toBe(200);
    expect((activate.json() as { status: string }).status).toBe("active");
    expect((await post(owner, `/automation/rules/${ruleId}/activate`)).statusCode).toBe(409);

    const patch = await t.app.inject({
      method: "PATCH",
      url: url(`/automation/rules/${ruleId}`),
      headers: owner.headers,
      payload: { name: "Lifecycle v2", trigger: { kind: "schedule", objectType: "rfi", everyMinutes: 30 }, priority: 1 },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ name: "Lifecycle v2", triggerKind: "schedule", triggerAction: "*", priority: 1 });
    expect((await t.app.inject({ method: "PATCH", url: url(`/automation/rules/${ruleId}`), headers: owner.headers, payload: {} })).statusCode).toBe(400);
    expect((await t.app.inject({ method: "PATCH", url: url(`/automation/rules/${ruleId}`), headers: noProject.headers, payload: { name: "x" } })).statusCode).toBe(403);

    const pause = await post(owner, `/automation/rules/${ruleId}/pause`);
    expect((pause.json() as { status: string }).status).toBe("paused");

    const detail = await get(owner, `/automation/rules/${ruleId}`);
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { rule: { status: string }; recentRuns: unknown[] }).recentRuns).toEqual([]);

    const archive = await t.app.inject({ method: "DELETE", url: url(`/automation/rules/${ruleId}`), headers: owner.headers });
    expect(archive.statusCode).toBe(200);
    expect((archive.json() as { status: string }).status).toBe("archived");
    expect((await t.app.inject({ method: "DELETE", url: url(`/automation/rules/${ruleId}`), headers: owner.headers })).statusCode).toBe(409);
    expect((await post(owner, `/automation/rules/${ruleId}/activate`)).statusCode).toBe(409);
    expect((await t.app.inject({ method: "PATCH", url: url(`/automation/rules/${ruleId}`), headers: owner.headers, payload: { name: "z" } })).statusCode).toBe(409);

    const entries = await t.app.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.objectType, "automation_rule"), eq(ledgerEntries.objectId, ruleId)));
    expect(entries.map((e) => e.action)).toEqual(["create", "state_change", "update", "state_change", "state_change"]);

    // archived rules are hidden from the default list but reachable by status filter
    const list = await get(owner, "/automation/rules");
    expect((list.json() as { items: Array<{ id: string }> }).items.some((r) => r.id === ruleId)).toBe(false);
    const archived = await get(owner, "/automation/rules?status=archived");
    expect((archived.json() as { items: Array<{ id: string }> }).items.some((r) => r.id === ruleId)).toBe(true);
  });
});

describe("tenancy and project visibility", () => {
  let companyRuleId: string;
  let projectRuleId: string;

  beforeAll(async () => {
    companyRuleId = ((await post(owner, "/automation/rules", baseRule({ name: "Company-wide" }))).json() as { id: string }).id;
    const res = await post(projectAdmin, `/projects/${projectId}/automation/rules`, baseRule({ name: "Project only" }));
    expect(res.statusCode).toBe(201);
    projectRuleId = (res.json() as { id: string }).id;
  }, 600_000);

  it("a project admin creates project rules that carry the project", async () => {
    const detail = await get(projectAdmin, `/projects/${projectId}/automation/rules/${projectRuleId}`);
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { rule: { projectId: string; scope: string } }).rule).toMatchObject({ projectId, scope: "project" });
    // a projectId in the body cannot redirect a project route elsewhere
    const redirected = await post(projectAdmin, `/projects/${projectId}/automation/rules`, baseRule({ projectId: otherProjectId }));
    expect((redirected.json() as { projectId: string }).projectId).toBe(projectId);
  });

  it("company lists are filtered to the projects the caller can see", async () => {
    const asNoProject = (await get(noProject, "/automation/rules")).json() as { items: Array<{ id: string }> };
    expect(asNoProject.items.some((r) => r.id === companyRuleId)).toBe(true);
    expect(asNoProject.items.some((r) => r.id === projectRuleId)).toBe(false);
    expect((await get(noProject, `/automation/rules/${projectRuleId}`)).statusCode).toBe(404);
    expect((await get(projectReader, `/automation/rules/${projectRuleId}`)).statusCode).toBe(200);
    const asOwner = (await get(owner, "/automation/rules?search=only")).json() as { items: Array<{ id: string }>; total: number };
    expect(asOwner.items.map((r) => r.id)).toEqual([projectRuleId]);
    const filtered = (await get(owner, `/automation/rules?projectId=${projectId}`)).json() as { items: Array<{ id: string; projectId: string | null }> };
    expect(filtered.items.map((r) => r.id)).toContain(projectRuleId);
    expect(filtered.items.every((r) => r.projectId === projectId)).toBe(true);
    expect(filtered.items.some((r) => r.id === companyRuleId)).toBe(false);
  });

  it("another company sees nothing and changes nothing", async () => {
    expect((await get(outsider, `/automation/rules/${companyRuleId}`)).statusCode).toBe(404);
    expect((await get(outsider, `/automation/rules/${projectRuleId}`)).statusCode).toBe(404);
    expect((await post(outsider, `/automation/rules/${companyRuleId}/activate`)).statusCode).toBe(404);
    expect((await t.app.inject({ method: "PATCH", url: url(`/automation/rules/${companyRuleId}`), headers: outsider.headers, payload: { name: "hijack" } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: "DELETE", url: url(`/automation/rules/${companyRuleId}`), headers: outsider.headers })).statusCode).toBe(404);
    expect((await get(outsider, `/projects/${projectId}/automation/rules`)).statusCode).toBe(403);
    expect((await post(outsider, `/automation/rules/${companyRuleId}/test`, {})).statusCode).toBe(404);
    const list = (await get(outsider, "/automation/rules")).json() as { total: number };
    expect(list.total).toBe(0);
  });

  it("project routes enforce the tool level and only mutate the project's own rules", async () => {
    const asReader = await get(projectReader, `/projects/${projectId}/automation/rules`);
    expect(asReader.statusCode).toBe(200);
    const ids = (asReader.json() as { items: Array<{ id: string }> }).items.map((r) => r.id);
    expect(ids).toContain(projectRuleId);
    expect(ids).toContain(companyRuleId); // company-wide rules apply here too, and are shown
    expect((await get(noProject, `/projects/${projectId}/automation/rules`)).statusCode).toBe(403);
    expect((await post(projectReader, `/projects/${projectId}/automation/rules`, baseRule())).statusCode).toBe(403);
    expect((await post(projectReader, `/projects/${projectId}/automation/rules/${projectRuleId}/activate`)).statusCode).toBe(403);
    // company-wide rule: readable through the project, not editable there
    expect((await get(projectAdmin, `/projects/${projectId}/automation/rules/${companyRuleId}`)).statusCode).toBe(200);
    expect((await t.app.inject({ method: "PATCH", url: url(`/projects/${projectId}/automation/rules/${companyRuleId}`), headers: projectAdmin.headers, payload: { name: "x" } })).statusCode).toBe(404);
    expect((await post(projectAdmin, `/projects/${projectId}/automation/rules/${companyRuleId}/activate`)).statusCode).toBe(404);
    // the project's own rule is
    const patched = await t.app.inject({ method: "PATCH", url: url(`/projects/${projectId}/automation/rules/${projectRuleId}`), headers: projectAdmin.headers, payload: { name: "Project only v2" } });
    expect(patched.statusCode).toBe(200);
    expect((await post(projectAdmin, `/projects/${projectId}/automation/rules/${projectRuleId}/activate`)).statusCode).toBe(200);
    expect((await post(projectAdmin, `/projects/${projectId}/automation/rules/${projectRuleId}/pause`)).statusCode).toBe(200);
    // and not reachable from a different project
    expect((await get(owner, `/projects/${otherProjectId}/automation/rules/${projectRuleId}`)).statusCode).toBe(404);
    expect((await t.app.inject({ method: "DELETE", url: url(`/projects/${otherProjectId}/automation/rules/${projectRuleId}`), headers: owner.headers })).statusCode).toBe(404);
  });
});

describe("template instantiation", () => {
  it("every template instantiates as a draft the tenant owns", async () => {
    for (const template of RULE_TEMPLATES) {
      const res = await post(owner, `/automation/templates/${template.key}/instantiate`, {});
      expect(res.statusCode, `${template.key}: ${res.body}`).toBe(201);
      const rule = res.json() as { templateKey: string; status: string; name: string; actions: Array<{ type: string }> };
      expect(rule.templateKey).toBe(template.key);
      expect(rule.status).toBe("draft");
      expect(rule.actions.map((a) => a.type)).toEqual(template.actions.map((a) => a.type));
    }
  });

  it("applies overrides, honours the project route, and refuses unknown keys and non-admins", async () => {
    const res = await post(owner, "/automation/templates/high_value_invoice_webhook/instantiate", {
      name: "ERP push",
      status: "active",
      actionOverrides: { "0": { url: "https://erp.example/hooks/constructos" } },
    });
    expect(res.statusCode).toBe(201);
    const rule = res.json() as { name: string; status: string; actions: Array<{ params: { url: string } }> };
    expect(rule.name).toBe("ERP push");
    expect(rule.status).toBe("active");
    expect(rule.actions[0]?.params.url).toBe("https://erp.example/hooks/constructos");
    const badOverride = await post(owner, "/automation/templates/high_value_invoice_webhook/instantiate", { actionOverrides: { "0": { url: "nope" } } });
    expect(badOverride.statusCode).toBe(400);

    const project = await post(projectAdmin, `/projects/${projectId}/automation/templates/rfi_overdue_escalate/instantiate`, { immediate: true });
    expect(project.statusCode).toBe(201);
    expect(project.json()).toMatchObject({ projectId, templateKey: "rfi_overdue_escalate", immediate: true });
    expect((await post(projectReader, `/projects/${projectId}/automation/templates/rfi_overdue_escalate/instantiate`, {})).statusCode).toBe(403);
    expect((await post(owner, "/automation/templates/nope/instantiate", {})).statusCode).toBe(404);
    expect((await post(noProject, "/automation/templates/rfi_overdue_escalate/instantiate", {})).statusCode).toBe(403);
  });
});

describe("dry runs", () => {
  it("tests saved and unsaved rules against real records, samples or nothing", async () => {
    const ruleId = ((await post(owner, "/automation/rules", baseRule({ name: "Testable", conditions: { all: [{ field: "record.subject", op: "contains", value: "crane" }] } }))).json() as { id: string }).id;
    const rfi = await createRfi(t.app, owner, projectId, { subject: "Crane lift plan" });
    const saved = await post(owner, `/automation/rules/${ruleId}/test`, { objectId: rfi.id });
    expect(saved.statusCode).toBe(200);
    const body = saved.json() as { matched: boolean; context: { recordSource: string }; plannedActions: Array<{ description: string }> };
    expect(body.matched).toBe(true);
    expect(body.context.recordSource).toBe("loaded");
    expect(body.plannedActions[0]?.description).toContain("tested");

    const sample = await post(owner, `/automation/rules/${ruleId}/test`, { record: { subject: "nothing" } });
    expect((sample.json() as { matched: boolean }).matched).toBe(false);

    const unsaved = await post(owner, "/automation/rules/test", { rule: baseRule({ name: "Unsaved" }), record: { status: "draft" } });
    expect(unsaved.statusCode).toBe(200);
    expect((unsaved.json() as { matched: boolean; runId: string | null }).matched).toBe(true);
    expect((unsaved.json() as { runId: string | null }).runId).toBeNull();
    expect((await post(owner, "/automation/rules/test", { rule: { name: "broken" } })).statusCode).toBe(400);
    expect((await post(noProject, "/automation/rules/test", { rule: baseRule() })).statusCode).toBe(403);
  });

  it("project testers need standard access and stay inside their project", async () => {
    const ruleId = ((await post(owner, "/automation/rules", baseRule({ name: "Project testable" }))).json() as { id: string }).id;
    const mine = await createRfi(t.app, owner, projectId, { subject: "Mine" });
    const theirs = await createRfi(t.app, owner, otherProjectId, { subject: "Theirs" });
    expect((await post(projectReader, `/projects/${projectId}/automation/rules/${ruleId}/test`, { objectId: mine.id })).statusCode).toBe(403);
    const ok = await post(projectAdmin, `/projects/${projectId}/automation/rules/${ruleId}/test`, { objectId: mine.id });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { matched: boolean }).matched).toBe(true);
    expect((await post(projectAdmin, `/projects/${projectId}/automation/rules/${ruleId}/test`, { objectId: theirs.id })).statusCode).toBe(403);
  });

  it("a project tester cannot read another project's record through a type that carries no projectId column", async () => {
    // A `project` record IS its own project: the guard must resolve the
    // record's project from the registry, not from a projectId field.
    const created = await post(projectAdmin, `/projects/${projectId}/automation/rules`, {
      name: "Project trigger",
      trigger: { kind: "event", objectType: "project", action: "*" },
      actions: [{ type: "tag", params: { name: "probe" } }],
    });
    expect(created.statusCode).toBe(201);
    const probeRuleId = (created.json() as { id: string }).id;
    const own = await post(projectAdmin, `/projects/${projectId}/automation/rules/${probeRuleId}/test`, { objectId: projectId });
    expect(own.statusCode).toBe(200);
    const other = await post(projectAdmin, `/projects/${projectId}/automation/rules/${probeRuleId}/test`, { objectId: otherProjectId });
    expect(other.statusCode).toBe(403);
    expect(JSON.stringify(other.json())).not.toContain("Other route project");
  });
});

describe("runs, summary, engine operations and health inputs", () => {
  let ruleId: string;
  let runId: string;

  beforeAll(async () => {
    ruleId = ((await post(owner, "/automation/rules", baseRule({ name: "Live", status: "active", immediate: true, conditions: null }))).json() as { id: string }).id;
    await createRfi(t.app, owner, projectId, { subject: "Fires the live rule" });
    const runs = (await get(owner, `/automation/runs?ruleId=${ruleId}`)).json() as { items: Array<{ id: string; status: string }> };
    runId = runs.items[0]!.id;
  }, 600_000);

  it("lists and reads runs with tenancy and project visibility", async () => {
    const list = (await get(owner, `/automation/runs?ruleId=${ruleId}`)).json() as { items: Array<{ status: string; objectType: string; projectId: string }>; total: number };
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ status: "succeeded", objectType: "rfi", projectId });
    const one = await get(owner, `/automation/runs/${runId}`);
    expect(one.statusCode).toBe(200);
    expect((one.json() as { actionResults: Array<{ outcome: string }> }).actionResults[0]?.outcome).toBe("done");
    expect((await get(outsider, `/automation/runs/${runId}`)).statusCode).toBe(404);
    expect((await get(noProject, `/automation/runs/${runId}`)).statusCode).toBe(404);
    expect((await get(projectReader, `/automation/runs/${runId}`)).statusCode).toBe(200);
    const asNoProject = (await get(noProject, `/automation/runs?ruleId=${ruleId}`)).json() as { total: number };
    expect(asNoProject.total).toBe(0);
    const viaProject = await get(projectReader, `/projects/${projectId}/automation/runs?ruleId=${ruleId}`);
    expect(viaProject.statusCode).toBe(200);
    expect((viaProject.json() as { total: number }).total).toBe(1);
    expect((await get(projectReader, `/projects/${projectId}/automation/runs/${runId}`)).statusCode).toBe(200);
    expect((await get(owner, `/projects/${otherProjectId}/automation/runs/${runId}`)).statusCode).toBe(404);
    expect((await get(owner, "/automation/runs?status=nonsense")).statusCode).toBe(400);
    const detail = (await get(owner, `/automation/rules/${ruleId}`)).json() as { recentRuns: Array<{ id: string }> };
    expect(detail.recentRuns.map((r) => r.id)).toContain(runId);
    // A company-wide rule is readable by every member, but its recent runs are
    // project data: a member with no project must not read them through it.
    const asNoProjectDetail = await get(noProject, `/automation/rules/${ruleId}`);
    expect(asNoProjectDetail.statusCode).toBe(200);
    expect((asNoProjectDetail.json() as { recentRuns: Array<{ id: string }> }).recentRuns).toEqual([]);
    const asReaderDetail = (await get(projectReader, `/automation/rules/${ruleId}`)).json() as { recentRuns: Array<{ id: string }> };
    expect(asReaderDetail.recentRuns.map((r) => r.id)).toContain(runId);
  });

  it("retries only failed, throttled or queued runs, and only for admins", async () => {
    expect((await post(owner, `/automation/runs/${runId}/retry`)).statusCode).toBe(409);
    expect((await post(noProject, `/automation/runs/${runId}/retry`)).statusCode).toBe(403);
    expect((await post(outsider, `/automation/runs/${runId}/retry`)).statusCode).toBe(404);
    // a rule whose webhook target is refused produces a failed run that can be retried
    const failing = ((await post(owner, "/automation/rules", baseRule({ name: "Failing", status: "active", immediate: true, conditions: null, actions: [{ type: "webhook", params: { url: "http://localhost:9/never" } }] }))).json() as { id: string }).id;
    await createRfi(t.app, owner, projectId, { subject: "Fails the webhook" });
    const failed = ((await get(owner, `/automation/runs?ruleId=${failing}`)).json() as { items: Array<{ id: string; status: string; error: string }> }).items[0]!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("public host");
    const retry = await post(owner, `/automation/runs/${failed.id}/retry`);
    expect(retry.statusCode).toBe(200);
    expect((retry.json() as { status: string; attempts: number }).status).toBe("failed");
    const rule = (await get(owner, `/automation/rules/${failing}`)).json() as { rule: { failureCount: number; lastError: string } };
    expect(rule.rule.failureCount).toBe(2);
    expect(rule.rule.lastError).toContain("webhook");
    await post(owner, `/automation/rules/${failing}/pause`);
  });

  it("summary, status and the manual cycle are scoped by role", async () => {
    const summary = await get(owner, "/automation/summary");
    expect(summary.statusCode).toBe(200);
    const body = summary.json() as { rulesByStatus: Record<string, number>; runs24h: Record<string, number>; actions24h: number; queued: number };
    expect(body.rulesByStatus["active"]).toBeGreaterThanOrEqual(1);
    expect(body.runs24h["succeeded"]).toBeGreaterThanOrEqual(1);
    expect(body.actions24h).toBeGreaterThanOrEqual(1);
    expect(body.queued).toBe(0);
    const projectSummary = await get(projectReader, `/projects/${projectId}/automation/summary`);
    expect(projectSummary.statusCode).toBe(200);
    expect((projectSummary.json() as { runs24h: Record<string, number> }).runs24h["succeeded"]).toBeGreaterThanOrEqual(1);
    expect((await get(noProject, "/automation/summary")).statusCode).toBe(200);

    expect((await get(noProject, "/automation/status")).statusCode).toBe(403);
    const status = await get(owner, "/automation/status");
    expect(status.statusCode).toBe(200);
    const s = status.json() as { engine: { eventsSeen: number }; jobs: Array<{ name: string }>; scheduler: { enabled: boolean } };
    expect(s.engine.eventsSeen).toBeGreaterThan(0);
    expect(s.jobs.map((j) => j.name).sort()).toEqual(["automation.drain", "automation.schedules"]);
    expect(s.scheduler.enabled).toBe(false);

    expect((await post(noProject, "/automation/run", {})).statusCode).toBe(403);
    const cycle = await post(owner, "/automation/run", { force: true });
    expect(cycle.statusCode).toBe(200);
    const c = cycle.json() as { scan: { rulesScanned: number } | null; drain: { executed: number } | null };
    expect(c.scan).not.toBeNull();
    expect(c.drain).not.toBeNull();
    const scanOnly = (await post(owner, "/automation/run", { drain: false })).json() as { drain: unknown };
    expect(scanOnly.drain).toBeNull();
  });

  it("health inputs are honest about projects nothing covers", async () => {
    const fresh = await createProject(t.app, outsider, "Nothing here");
    const none = (await get(outsider, `/projects/${fresh}/automation/health-inputs`)).json() as { metrics: Record<string, number | null>; reasons: string[] };
    expect(none.metrics["activeRules"]).toBe(0);
    expect(none.metrics["runs24h"]).toBeNull();
    expect(none.reasons).toHaveLength(1);
    const covered = (await get(projectReader, `/projects/${projectId}/automation/health-inputs`)).json() as { metrics: Record<string, number | null>; reasons: string[] };
    expect(covered.metrics["activeRules"]).toBeGreaterThanOrEqual(1);
    expect(covered.metrics["runs24h"]).toBeGreaterThanOrEqual(1);
    expect(covered.metrics["failedRuns24h"]).toBeGreaterThanOrEqual(1);
    expect(covered.reasons).toEqual([]);
    expect((await get(noProject, `/projects/${projectId}/automation/health-inputs`)).statusCode).toBe(403);
  });

  it("registers both sweeps with the platform scheduler", async () => {
    expect(t.app.scheduler.has("automation.drain")).toBe(true);
    expect(t.app.scheduler.has("automation.schedules")).toBe(true);
    const drain = await t.app.scheduler.runNow("automation.drain");
    expect(drain.state).toBe("succeeded");
    expect(drain.lastResult).toMatchObject({ executed: 0 });
  });

  it("the manual cycle never drains another company's queued runs", async () => {
    const theirProject = await createProject(t.app, outsider, "Their drain project");
    await post(outsider, "/automation/rules", baseRule({ name: "Theirs", status: "active", conditions: null }));
    await createRfi(t.app, outsider, theirProject, { subject: "Queued for them" });
    const queuedBefore = (await get(outsider, "/automation/runs?status=queued")).json() as { items: Array<{ id: string }> };
    expect(queuedBefore.items.length).toBeGreaterThanOrEqual(1);
    const cycle = await post(owner, "/automation/run", { scan: false });
    expect(cycle.statusCode).toBe(200);
    expect((cycle.json() as { drain: { executed: number } }).drain.executed).toBe(0);
    const queuedAfter = (await get(outsider, "/automation/runs?status=queued")).json() as { items: Array<{ id: string }> };
    expect(queuedAfter.items.map((r) => r.id)).toEqual(queuedBefore.items.map((r) => r.id));
  });
});
