/**
 * Integration tests for the intelligence module: health, attention, Pulse,
 * briefing (AI disabled path), jobs, the ledger hook, tenant isolation and
 * visibility. The module is registered here because app.ts wiring is the
 * orchestrator's step; buildApp() never calls ready(), so a late register
 * is legal until the first inject.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import {
  aiReviewQueue,
  attentionItems,
  budgets,
  companyMemberships,
  contractEvents,
  ledgerEntries,
  nonConformanceReports,
  notifications,
  obligations,
  projectHealthSnapshots,
  projectMemberships,
  projects,
  rfis,
  risks,
  safetyIncidents,
  scheduleTasks,
  schedules,
  signals,
} from "@constructos/db";
import { HEALTH_DIMENSIONS } from "@constructos/shared";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { intelligenceModule } from "./index.js";
import { dirtyProjects } from "./service.js";
import type { AttentionItem, ProjectHealth, PulseResponse } from "./types.js";

const DAY_MS = 86_400_000;
const isoDate = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY_MS).toISOString().slice(0, 10);
const isoTs = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY_MS).toISOString();

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor; // company A owner
let outsider: TestActor; // company B owner — must never see A
let member: TestActor; // company A plain member, project membership on P2 only
let memberHeaders: Record<string, string>;
let p1: string; // the troubled project
let p2: string; // the quiet project
let rfiId: string;

interface HealthWire extends ProjectHealth {
  computedOnRead: boolean;
  basis: string;
  projectName: string | null;
  levelChanged?: boolean;
  previousLevel?: string | null;
}

interface AttentionList {
  items: AttentionItem[];
  total: number;
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  // Until app.ts wires the module the test registers it; once wired, registering again would duplicate routes and jobs.
  if (!app.scheduler.has("intelligence.health")) await app.register(intelligenceModule, { prefix: "/api/v1" });
  owner = await registerActor(app);
  outsider = await registerActor(app);
  member = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: member.userId,
    role: "member",
  });
  memberHeaders = {
    authorization: member.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  p1 = newId("prj");
  p2 = newId("prj");
  await app.db.insert(projects).values([
    { id: p1, companyId: owner.companyId, name: "Bridge", stage: "course_of_construction", currency: "GBP", finishDate: isoDate(60) },
    { id: p2, companyId: owner.companyId, name: "Depot", stage: "pre_construction", currency: "GBP" },
  ]);
  await app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId: p2,
    userId: member.userId,
    templateKey: "project_manager",
  });

  /* ---- P1: a project with trouble in most dimensions ---- */
  const budgetId = newId("bgt");
  await app.db.insert(budgets).values({
    id: budgetId,
    companyId: owner.companyId,
    projectId: p1,
    number: 1,
    reference: "B-001",
    name: "Master budget",
    status: "approved",
    isActive: 1,
    currency: "GBP",
    revisedBudgetTotal: 1_000_000,
    forecastFinalTotal: 1_080_000,
    varianceTotal: -80_000,
    pendingChangesTotal: 20_000,
    jobToDateCostsTotal: 400_000,
    createdBy: owner.userId,
  });
  const scheduleId = newId("sch");
  await app.db.insert(schedules).values({
    id: scheduleId,
    companyId: owner.companyId,
    projectId: p1,
    name: "Master programme",
    projectStart: isoDate(-100),
    isActive: 1,
    computedFinish: isoDate(80), // 20 days past the project finish
    createdBy: owner.userId,
  });
  await app.db.insert(scheduleTasks).values([
    { id: newId("tsk"), scheduleId, projectId: p1, name: "Piling", durationDays: 10, finishDate: isoDate(-5), percentComplete: 60, isCritical: 1 },
    { id: newId("tsk"), scheduleId, projectId: p1, name: "Deck", durationDays: 20, finishDate: isoDate(30), percentComplete: 0, isCritical: 1 },
    { id: newId("tsk"), scheduleId, projectId: p1, name: "Handover", durationDays: 0, finishDate: isoDate(-2), percentComplete: 0 },
    { id: newId("tsk"), scheduleId, projectId: p1, name: "Fit-out", durationDays: 5, finishDate: isoDate(10), percentComplete: 0 },
  ]);
  await app.db.insert(obligations).values([
    { id: newId("obl"), companyId: owner.companyId, projectId: p1, sourceClause: "cl. 20.1", trigger: "Serve notice of claim", deadline: isoTs(2), createdBy: owner.userId },
    { id: newId("obl"), companyId: owner.companyId, projectId: p1, sourceClause: "cl. 8.3", trigger: "Submit revised programme", deadline: isoTs(-3), status: "breached", createdBy: owner.userId },
  ]);
  await app.db.insert(contractEvents).values({
    id: newId("cev"),
    companyId: owner.companyId,
    projectId: p1,
    contractId: newId("ctr"),
    number: 1,
    kind: "delay",
    clauseRef: "20.1",
    title: "Delay to piling",
    eventDate: isoDate(-10),
    noticeDeadline: isoDate(3),
    costImpactEstimate: 250_000,
    raisedBy: owner.userId,
  });
  await app.db.insert(signals).values({
    id: newId("sig"),
    companyId: owner.companyId,
    projectId: p1,
    detector: "duplicate_assertions",
    severity: "critical",
    confidence: 0.9,
    title: "Duplicate quantity assertions",
    explanation: "Two identical claims within 30 days",
    evidenceRefs: [],
  });
  rfiId = newId("rfi");
  await app.db.insert(rfis).values({
    id: rfiId,
    companyId: owner.companyId,
    projectId: p1,
    number: 4,
    subject: "Rebar detail at pier 3",
    question: "Which bar size?",
    status: "open",
    dueDate: isoDate(-20),
    createdBy: owner.userId,
  });
  await app.db.insert(risks).values({
    id: newId("rsk"),
    companyId: owner.companyId,
    projectId: p1,
    number: 1,
    title: "Ground conditions",
    category: "technical",
    probabilityScore: 4,
    impactScore: 4,
    createdBy: owner.userId,
  });
  await app.db.insert(safetyIncidents).values({
    id: newId("inc"),
    companyId: owner.companyId,
    projectId: p1,
    number: 1,
    reference: "INC-001",
    incidentType: "injury",
    severity: "serious",
    title: "Fall from scaffold",
    description: "Worker fell 2m",
    occurredAt: isoTs(-4),
    status: "open",
    createdBy: owner.userId,
  });
  await app.db.insert(nonConformanceReports).values({
    id: newId("ncr"),
    companyId: owner.companyId,
    projectId: p1,
    number: 1,
    reference: "NCR-001",
    title: "Honeycombing in pier",
    description: "Voids in concrete",
    severity: "major",
    status: "open",
    responseDueDate: isoDate(5),
    createdBy: owner.userId,
  });
  await app.db.insert(aiReviewQueue).values({
    id: newId("airev"),
    companyId: owner.companyId,
    projectId: p1,
    runId: newId("airun"),
    targetType: "signal",
    proposal: { note: "explain the signal" },
    summary: "Explain the duplicate assertion signal",
    status: "pending",
  });
}, 120_000);

afterAll(async () => {
  await built.close();
}, 60_000);

/* ------------------------------------------------------------------ */
/* Project health                                                      */
/* ------------------------------------------------------------------ */

describe("project health", () => {
  it("computes on first read, scores every dimension in order and explains the unrated ones", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/projects/${p1}/health`, headers: owner.headers });
    expect(res.statusCode).toBe(200);
    const h = res.json() as HealthWire;
    expect(h.computedOnRead).toBe(true);
    expect(h.projectId).toBe(p1);
    expect(h.dimensions.map((d) => d.key)).toEqual([...HEALTH_DIMENSIONS]);
    expect(h.score).not.toBeNull();
    expect(["watch", "off_track"]).toContain(h.level);

    const cost = h.dimensions.find((d) => d.key === "cost")!;
    expect(cost.score).not.toBeNull();
    expect(cost.inputs["variancePercent"]).toBe(-8);
    expect(cost.inputs["currency"]).toBe("GBP");
    expect(cost.basis).toContain("exceeds the revised budget by 8%");

    const schedule = h.dimensions.find((d) => d.key === "schedule")!;
    expect(schedule.inputs["tasks"]).toBe(4);
    expect(schedule.inputs["overdueTasks"]).toBe(1);
    expect(schedule.inputs["criticalOverdue"]).toBe(1);
    expect(schedule.inputs["milestonesSlipped"]).toBe(1);
    expect(schedule.inputs["slipDays"]).toBe(20);

    const contract = h.dimensions.find((d) => d.key === "contract")!;
    expect(contract.inputs["obligationsBreached"]).toBe(1);
    expect(contract.inputs["deadlinesWithin7d"]).toBe(1);

    const field = h.dimensions.find((d) => d.key === "field")!;
    expect(field.inputs["rfisOverdue"]).toBe(1);

    const assurance = h.dimensions.find((d) => d.key === "assurance")!;
    expect((assurance.inputs["openSignals"] as { critical: number }).critical).toBe(1);

    const safety = h.dimensions.find((d) => d.key === "safety")!;
    expect(safety.inputs["serious"]).toBe(1);

    const quality = h.dimensions.find((d) => d.key === "quality")!;
    expect((quality.inputs["ncrsOpen"] as { major: number }).major).toBe(1);

    // nothing recorded → unrated with a reason, never zero
    const finance = h.dimensions.find((d) => d.key === "finance")!;
    expect(finance.score).toBeNull();
    expect(finance.level).toBe("unrated");
    expect(finance.basis).toMatch(/No covenants/);
    const commercial = h.dimensions.find((d) => d.key === "commercial")!;
    expect(commercial.level).toBe("unrated");
  });

  it("a project with no records is unrated overall, not zero", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/projects/${p2}/health`, headers: owner.headers });
    expect(res.statusCode).toBe(200);
    const h = res.json() as HealthWire;
    expect(h.level).toBe("unrated");
    expect(h.score).toBeNull();
    expect(h.dimensions.every((d) => d.score === null)).toBe(true);
    expect(h.basis).toContain("will not invent");
  });

  it("manual recompute always writes a snapshot, ledgers it and reports the previous level", async () => {
    const before = await app.db
      .select()
      .from(projectHealthSnapshots)
      .where(eq(projectHealthSnapshots.projectId, p1));
    const res = await app.inject({ method: "POST", url: `/api/v1/projects/${p1}/health/recompute`, headers: owner.headers });
    expect(res.statusCode).toBe(200);
    const h = res.json() as HealthWire;
    expect(h.computedOnRead).toBe(false);
    expect(h.levelChanged).toBe(false);
    expect(h.previousLevel).toBe(h.level);
    const after = await app.db
      .select()
      .from(projectHealthSnapshots)
      .where(eq(projectHealthSnapshots.projectId, p1));
    expect(after.length).toBe(before.length + 1);
    expect(after.some((s) => s.trigger === "manual")).toBe(true);

    const [entry] = await app.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.companyId, owner.companyId), eq(ledgerEntries.objectType, "project_health"), eq(ledgerEntries.objectId, p1)))
      .orderBy(desc(ledgerEntries.seq))
      .limit(1);
    expect(entry?.action).toBe("update");
    expect(entry?.actorId).toBe(owner.userId);
    expect((entry?.payload as { trigger: string }).trigger).toBe("manual");
  });

  it("automatic recompute dedupes an identical snapshot inside the window", async () => {
    const before = await app.db.select().from(projectHealthSnapshots).where(eq(projectHealthSnapshots.projectId, p1));
    const status = await app.scheduler.runNow("intelligence.health", "interval");
    expect(status.state).toBe("succeeded");
    const after = await app.db.select().from(projectHealthSnapshots).where(eq(projectHealthSnapshots.projectId, p1));
    expect(after.length).toBe(before.length);
  });

  it("exposes the raw health inputs with reasons for every unrated dimension (plan §3.5)", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/projects/${p1}/health/inputs`, headers: owner.headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { asOf: string; metrics: Record<string, number | null>; reasons: string[]; unrated: string[]; inputs: Record<string, unknown> };
    expect(body.metrics["cost.revisedBudget"]).toBe(1_000_000);
    expect(body.metrics["schedule.overdueTasks"]).toBe(1);
    expect(body.metrics["assurance.openSignals.critical"]).toBe(1);
    expect(body.metrics["field.rfisOverdue"]).toBe(1);
    expect(body.unrated).toContain("finance");
    expect(body.unrated).toContain("commercial");
    expect(body.reasons.some((r) => r.includes("covenants"))).toBe(true);
    expect(body.inputs["finance"]).toBeNull();
    const denied = await app.inject({ method: "GET", url: `/api/v1/projects/${p1}/health/inputs`, headers: outsider.headers });
    expect(denied.statusCode).toBe(403);
  });

  it("lists the history and the trend", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/projects/${p1}/health/history?days=7`, headers: owner.headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ trigger: string; level: string; score: number | null }>; days: number };
    expect(body.days).toBe(7);
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    expect(body.items.map((i) => i.trigger)).toContain("manual");
    const health = (await app.inject({ method: "GET", url: `/api/v1/projects/${p1}/health`, headers: owner.headers })).json() as HealthWire;
    expect(health.trend.length).toBeGreaterThanOrEqual(1);
    expect(health.computedOnRead).toBe(false);
  });

  it("ledgers a level change once and notifies project members when a project goes off track", async () => {
    // the member is on P2; make P2 off track with a fatality and recompute
    await app.db.insert(safetyIncidents).values({
      id: newId("inc"),
      companyId: owner.companyId,
      projectId: p2,
      number: 1,
      reference: "INC-DEPOT-1",
      incidentType: "injury",
      severity: "catastrophic",
      isFatality: 1,
      title: "Fatality",
      description: "Crush injury",
      occurredAt: isoTs(-1),
      status: "open",
      createdBy: owner.userId,
    });
    const res = await app.inject({ method: "POST", url: `/api/v1/projects/${p2}/health/recompute`, headers: owner.headers });
    const h = res.json() as HealthWire;
    expect(h.level).toBe("off_track");
    expect(h.levelChanged).toBe(true);
    expect(h.previousLevel).toBe("unrated");
    const changes = await app.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.objectType, "project_health"), eq(ledgerEntries.objectId, p2), eq(ledgerEntries.action, "state_change")));
    expect(changes).toHaveLength(1);
    expect((changes[0]!.payload as { to: string; from: string }).to).toBe("off_track");
    const notes = await app.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, member.userId), eq(notifications.kind, "attention")));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toContain("Depot is off track");
    expect(notes[0]!.body).toContain("safety");
    // a second recompute at the same level ledgers nothing more
    await app.inject({ method: "POST", url: `/api/v1/projects/${p2}/health/recompute`, headers: owner.headers });
    const again = await app.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.objectType, "project_health"), eq(ledgerEntries.objectId, p2), eq(ledgerEntries.action, "state_change")));
    expect(again).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Attention feed                                                      */
/* ------------------------------------------------------------------ */

describe("attention feed", () => {
  it("collects every source, ranks by severity × urgency × money and is idempotent", async () => {
    await app.scheduler.runNow("intelligence.attention");
    const res = await app.inject({ method: "GET", url: "/api/v1/attention?limit=100", headers: owner.headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AttentionList;
    const kinds = new Set(body.items.map((i) => i.kind));
    for (const k of ["obligation_due", "time_bar", "signal", "overdue_rfi", "budget_overrun", "schedule_slip", "safety_incident", "ncr_open", "agent_proposal"]) {
      expect(kinds.has(k), `missing kind ${k}`).toBe(true);
    }
    // sorted by score desc
    for (let i = 1; i < body.items.length; i += 1) {
      expect(body.items[i - 1]!.score).toBeGreaterThanOrEqual(body.items[i]!.score);
    }
    // the breached obligation is critical and overdue — top of the feed
    expect(body.items[0]!.kind === "obligation_due" || body.items[0]!.kind === "safety_incident" || body.items[0]!.kind === "signal").toBe(true);
    const timeBar = body.items.find((i) => i.kind === "time_bar")!;
    expect(timeBar.money).toBe(250_000);
    expect(timeBar.href).toMatch(/^\/projects\/.+\/contracts\//);
    expect(timeBar.projectName).toBe("Bridge");
    expect(timeBar.dueAt).not.toBeNull();
    const total = body.total;
    // a second refresh upserts the same rows
    await app.scheduler.runNow("intelligence.attention");
    const again = (await app.inject({ method: "GET", url: "/api/v1/attention?limit=100", headers: owner.headers })).json() as AttentionList;
    expect(again.total).toBe(total);
    expect(new Set(again.items.map((i) => i.id)).size).toBe(again.items.length);
  });

  it("filters by kind, severity and project", async () => {
    const byKind = (await app.inject({ method: "GET", url: "/api/v1/attention?kind=overdue_rfi", headers: owner.headers })).json() as AttentionList;
    expect(byKind.total).toBe(1);
    expect(byKind.items[0]!.sourceId).toBe(rfiId);
    expect(byKind.items[0]!.title).toContain("RFI #4 overdue");
    const bySeverity = (await app.inject({ method: "GET", url: "/api/v1/attention?severity=critical", headers: owner.headers })).json() as AttentionList;
    expect(bySeverity.items.every((i) => i.severity === "critical")).toBe(true);
    expect(bySeverity.total).toBeGreaterThanOrEqual(2);
    const byProject = (await app.inject({ method: "GET", url: `/api/v1/attention?projectId=${p2}`, headers: owner.headers })).json() as AttentionList;
    expect(byProject.items.every((i) => i.projectId === p2)).toBe(true);
    expect(byProject.items.some((i) => i.kind === "safety_incident")).toBe(true);
    const projectRoute = (await app.inject({ method: "GET", url: `/api/v1/projects/${p1}/attention`, headers: owner.headers })).json() as AttentionList;
    expect(projectRoute.items.every((i) => i.projectId === p1)).toBe(true);
    expect(projectRoute.total).toBeGreaterThanOrEqual(8);
    const bad = await app.inject({ method: "GET", url: "/api/v1/attention?severity=bogus", headers: owner.headers });
    expect(bad.statusCode).toBe(400);
  });

  it("dismisses with a reason, ledgers it, survives a refresh and can be reopened", async () => {
    const list = (await app.inject({ method: "GET", url: "/api/v1/attention?kind=overdue_rfi", headers: owner.headers })).json() as AttentionList;
    const item = list.items[0]!;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/attention/${item.id}/dismiss`,
      headers: owner.headers,
      payload: { reason: "Answered by phone, closing tomorrow" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as AttentionItem).status).toBe("dismissed");
    const [entry] = await app.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.objectType, "attention_item"), eq(ledgerEntries.objectId, item.id)))
      .orderBy(desc(ledgerEntries.seq))
      .limit(1);
    expect(entry?.action).toBe("state_change");
    expect((entry?.payload as { reason: string }).reason).toContain("Answered by phone");

    // gone from the open feed, present in the dismissed view
    const open = (await app.inject({ method: "GET", url: "/api/v1/attention?kind=overdue_rfi", headers: owner.headers })).json() as AttentionList;
    expect(open.total).toBe(0);
    const dismissed = (await app.inject({ method: "GET", url: "/api/v1/attention?kind=overdue_rfi&status=dismissed", headers: owner.headers })).json() as AttentionList;
    expect(dismissed.total).toBe(1);

    // the refresh keeps the dismissal (deterministic ids)
    await app.scheduler.runNow("intelligence.attention");
    const [row] = await app.db.select().from(attentionItems).where(eq(attentionItems.id, item.id));
    expect(row?.status).toBe("dismissed");
    expect(row?.dismissedBy).toBe(owner.userId);

    // reopen through the project-scoped route
    const reopen = await app.inject({ method: "POST", url: `/api/v1/projects/${p1}/attention/${item.id}/reopen`, headers: owner.headers });
    expect(reopen.statusCode).toBe(200);
    expect((reopen.json() as AttentionItem).status).toBe("open");
    const wrongProject = await app.inject({ method: "POST", url: `/api/v1/projects/${p2}/attention/${item.id}/dismiss`, headers: owner.headers });
    expect(wrongProject.statusCode).toBe(404);
  });

  it("resolves an item whose source condition is gone and drops it from the feed", async () => {
    await app.db.update(rfis).set({ status: "closed" }).where(eq(rfis.id, rfiId));
    const status = await app.scheduler.runNow("intelligence.attention");
    expect(status.state).toBe("succeeded");
    const open = (await app.inject({ method: "GET", url: "/api/v1/attention?kind=overdue_rfi", headers: owner.headers })).json() as AttentionList;
    expect(open.total).toBe(0);
    const resolved = (await app.inject({ method: "GET", url: "/api/v1/attention?kind=overdue_rfi&status=resolved", headers: owner.headers })).json() as AttentionList;
    expect(resolved.total).toBe(1);
    expect(resolved.items[0]!.sourceId).toBe(rfiId);
    // and it comes back when the condition returns — still the same row
    await app.db.update(rfis).set({ status: "open" }).where(eq(rfis.id, rfiId));
    await app.scheduler.runNow("intelligence.attention");
    const back = (await app.inject({ method: "GET", url: "/api/v1/attention?kind=overdue_rfi", headers: owner.headers })).json() as AttentionList;
    expect(back.total).toBe(1);
    expect(back.items[0]!.id).toBe(resolved.items[0]!.id);
  });
});

/* ------------------------------------------------------------------ */
/* Pulse                                                               */
/* ------------------------------------------------------------------ */

describe("company pulse", () => {
  it("is one read: portfolio, scores with trend, ranked attention, changes and the briefing state", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/pulse?attentionLimit=5", headers: owner.headers });
    expect(res.statusCode).toBe(200);
    const pulse = res.json() as PulseResponse;
    expect(pulse.portfolio.projects).toBe(2);
    expect(pulse.portfolio.byHealth.off_track).toBeGreaterThanOrEqual(1);
    expect(pulse.portfolio.byStage["course_of_construction"]).toBe(1);
    expect(pulse.scores.map((s) => s.projectId).sort()).toEqual([p1, p2].sort());
    expect(pulse.attention.length).toBe(5);
    expect(pulse.openAttention).toBeGreaterThan(5);
    expect(pulse.attentionBySeverity["critical"]).toBeGreaterThanOrEqual(1);
    expect(pulse.briefing.text).toBeNull();
    expect(pulse.briefing.reason).toBe("ai_disabled");
    expect(pulse.changes.openAttentionTo).toBe(pulse.openAttention);
    expect(typeof pulse.generatedAt).toBe("string");
    expect(pulse.computedOnRead).toBe(false);
  });

  it("admin refresh recomputes everything, ledgers the snapshot and records level changes since the last pulse", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/pulse/refresh", headers: owner.headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { projects: number; recomputed: number; attention: { open: number }; pulseId: string };
    expect(body.projects).toBe(2);
    expect(body.pulseId).toMatch(/^pls_/);
    const [entry] = await app.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.objectType, "pulse_snapshot"), eq(ledgerEntries.objectId, body.pulseId)));
    expect(entry?.action).toBe("update");
    // a member cannot run the company refresh
    const denied = await app.inject({ method: "POST", url: "/api/v1/pulse/refresh", headers: memberHeaders });
    expect(denied.statusCode).toBe(403);
  });

  it("serves history and activity", async () => {
    const history = await app.inject({ method: "GET", url: "/api/v1/pulse/history?days=14", headers: owner.headers });
    expect(history.statusCode).toBe(200);
    const h = history.json() as { items: Array<{ generatedAt: string; byHealth: Record<string, number>; openAttention: number }>; days: number };
    expect(h.days).toBe(14);
    expect(h.items.length).toBeGreaterThanOrEqual(1);
    expect(h.items[0]!.byHealth).toHaveProperty("off_track");

    const activity = await app.inject({ method: "GET", url: "/api/v1/pulse/activity", headers: owner.headers });
    expect(activity.statusCode).toBe(200);
    const a = activity.json() as { runs: unknown[]; pendingProposals: number; aiEnabled: boolean };
    expect(a.runs).toEqual([]);
    expect(a.pendingProposals).toBe(1);
    expect(a.aiEnabled).toBe(false);

    const projectActivity = await app.inject({ method: "GET", url: `/api/v1/projects/${p1}/intelligence/activity`, headers: owner.headers });
    expect(projectActivity.statusCode).toBe(200);
    const pa = projectActivity.json() as { runs: unknown[]; pendingProposals: number; briefings: unknown[] };
    expect(pa.pendingProposals).toBe(1);
    expect(pa.briefings).toEqual([]);
  });

  it("briefing endpoints degrade honestly without an API key", async () => {
    const latest = await app.inject({ method: "GET", url: "/api/v1/pulse/briefing", headers: owner.headers });
    expect(latest.statusCode).toBe(200);
    expect(latest.json()).toMatchObject({ briefing: null, reason: "ai_disabled", aiEnabled: false });
    const gen = await app.inject({ method: "POST", url: "/api/v1/pulse/briefing", headers: owner.headers });
    expect(gen.statusCode).toBe(503);
    expect((gen.json() as { error: string }).error).toBe("AiDisabled");
    const projGen = await app.inject({ method: "POST", url: `/api/v1/projects/${p1}/intelligence/briefing`, headers: owner.headers });
    expect(projGen.statusCode).toBe(503);
    const projLatest = await app.inject({ method: "GET", url: `/api/v1/projects/${p1}/intelligence/briefing`, headers: owner.headers });
    expect(projLatest.json()).toMatchObject({ briefing: null, reason: "ai_disabled" });
    const list = await app.inject({ method: "GET", url: "/api/v1/pulse/briefings", headers: owner.headers });
    expect(list.json()).toMatchObject({ items: [], reason: null });
  });
});

/* ------------------------------------------------------------------ */
/* Jobs and the ledger hook                                            */
/* ------------------------------------------------------------------ */

describe("jobs and ledger-driven recompute", () => {
  it("registers its three sweeps with the scheduler", () => {
    expect(app.scheduler.has("intelligence.health")).toBe(true);
    expect(app.scheduler.has("intelligence.attention")).toBe(true);
    expect(app.scheduler.has("intelligence.event-recompute")).toBe(true);
  });

  it("marks a project dirty on a ledger event and recomputes it on the next drain, ignoring its own writes", async () => {
    // drain whatever earlier tests left behind
    await app.scheduler.runNow("intelligence.event-recompute");
    expect(dirtyProjects(app.db)).toHaveLength(0);
    await appendLedger(app.db, {
      companyId: owner.companyId,
      actorId: owner.userId,
      action: "update",
      objectType: "rfi",
      objectId: rfiId,
      projectId: p1,
      payload: { status: "closed" },
    });
    // the layer's own ledger writes never re-trigger it
    await appendLedger(app.db, {
      companyId: owner.companyId,
      actorId: owner.userId,
      action: "update",
      objectType: "project_health",
      objectId: p2,
      projectId: p2,
      payload: {},
    });
    const dirty = dirtyProjects(app.db);
    expect(dirty.map((d) => d.projectId)).toEqual([p1]);
    const status = await app.scheduler.runNow("intelligence.event-recompute");
    expect(status.state).toBe("succeeded");
    expect(status.lastResult).toMatchObject({ projects: 1, companies: 1 });
    expect(dirtyProjects(app.db)).toHaveLength(0);
    const [latest] = await app.db
      .select()
      .from(projectHealthSnapshots)
      .where(eq(projectHealthSnapshots.projectId, p1))
      .orderBy(desc(projectHealthSnapshots.computedAt), desc(projectHealthSnapshots.createdAt))
      .limit(1);
    expect(["event", "manual", "read", "interval", "boot"]).toContain(latest?.trigger);
  });
});

/* ------------------------------------------------------------------ */
/* Tenant isolation and visibility                                     */
/* ------------------------------------------------------------------ */

describe("tenant isolation", () => {
  it("another company sees none of it and cannot act on it", async () => {
    const health = await app.inject({ method: "GET", url: `/api/v1/projects/${p1}/health`, headers: outsider.headers });
    expect(health.statusCode).toBe(403);
    const recompute = await app.inject({ method: "POST", url: `/api/v1/projects/${p1}/health/recompute`, headers: outsider.headers });
    expect(recompute.statusCode).toBe(403);
    const feed = (await app.inject({ method: "GET", url: "/api/v1/attention", headers: outsider.headers })).json() as AttentionList;
    expect(feed.total).toBe(0);
    const pulse = (await app.inject({ method: "GET", url: "/api/v1/pulse", headers: outsider.headers })).json() as PulseResponse;
    expect(pulse.portfolio.projects).toBe(0);
    expect(pulse.scores).toEqual([]);
    expect(pulse.attention).toEqual([]);
    const mine = (await app.inject({ method: "GET", url: "/api/v1/attention?limit=1", headers: owner.headers })).json() as AttentionList;
    const dismiss = await app.inject({ method: "POST", url: `/api/v1/attention/${mine.items[0]!.id}/dismiss`, headers: outsider.headers, payload: {} });
    expect(dismiss.statusCode).toBe(404);
    const [row] = await app.db.select().from(attentionItems).where(eq(attentionItems.id, mine.items[0]!.id));
    expect(row?.status).toBe("open");
    const projFeed = await app.inject({ method: "GET", url: `/api/v1/projects/${p1}/attention`, headers: outsider.headers });
    expect(projFeed.statusCode).toBe(403);
  });

  it("a plain member sees only the projects they belong to, and the company briefing is withheld", async () => {
    const pulse = (await app.inject({ method: "GET", url: "/api/v1/pulse", headers: memberHeaders })).json() as PulseResponse;
    expect(pulse.portfolio.projects).toBe(1);
    expect(pulse.scores.map((s) => s.projectId)).toEqual([p2]);
    expect(pulse.attention.every((i) => i.projectId === p2 || i.projectId === null)).toBe(true);
    const feed = (await app.inject({ method: "GET", url: "/api/v1/attention?limit=100", headers: memberHeaders })).json() as AttentionList;
    expect(feed.items.every((i) => i.projectId === p2 || i.projectId === null)).toBe(true);
    expect(feed.items.some((i) => i.projectId === p1)).toBe(false);
    const forbidden = await app.inject({ method: "GET", url: `/api/v1/attention?projectId=${p1}`, headers: memberHeaders });
    expect(forbidden.statusCode).toBe(403);
    const p1Health = await app.inject({ method: "GET", url: `/api/v1/projects/${p1}/health`, headers: memberHeaders });
    expect(p1Health.statusCode).toBe(403);
    const p2Health = await app.inject({ method: "GET", url: `/api/v1/projects/${p2}/health`, headers: memberHeaders });
    expect(p2Health.statusCode).toBe(200);
    const briefing = await app.inject({ method: "GET", url: "/api/v1/pulse/briefing", headers: memberHeaders });
    expect(briefing.json()).toMatchObject({ briefing: null, reason: "restricted_scope" });
    // an item on P1 is invisible to them even by id
    const mine = (await app.inject({ method: "GET", url: `/api/v1/attention?projectId=${p1}&limit=1`, headers: owner.headers })).json() as AttentionList;
    const dismiss = await app.inject({ method: "POST", url: `/api/v1/attention/${mine.items[0]!.id}/dismiss`, headers: memberHeaders, payload: {} });
    expect(dismiss.statusCode).toBe(404);
    // a project manager on P2 may dismiss a P2 item (standard on intelligence)
    const p2Items = (await app.inject({ method: "GET", url: `/api/v1/attention?projectId=${p2}&limit=1`, headers: memberHeaders })).json() as AttentionList;
    expect(p2Items.items.length).toBe(1);
    const ok = await app.inject({ method: "POST", url: `/api/v1/attention/${p2Items.items[0]!.id}/dismiss`, headers: memberHeaders, payload: { reason: "handled" } });
    expect(ok.statusCode).toBe(200);
    await app.inject({ method: "POST", url: `/api/v1/attention/${p2Items.items[0]!.id}/reopen`, headers: memberHeaders });
  });

  it("a read-only project member can see but not dismiss", async () => {
    const viewer = await registerActor(app);
    await app.db.insert(companyMemberships).values({ id: newId("cm"), companyId: owner.companyId, userId: viewer.userId, role: "member" });
    await app.db.insert(projectMemberships).values({ id: newId("pm"), companyId: owner.companyId, projectId: p1, userId: viewer.userId, templateKey: "read_only" });
    const headers = { authorization: viewer.headers["authorization"]!, "x-company-id": owner.companyId };
    const health = await app.inject({ method: "GET", url: `/api/v1/projects/${p1}/health`, headers });
    expect(health.statusCode).toBe(200);
    const recompute = await app.inject({ method: "POST", url: `/api/v1/projects/${p1}/health/recompute`, headers });
    expect(recompute.statusCode).toBe(403);
    const items = (await app.inject({ method: "GET", url: `/api/v1/attention?projectId=${p1}&limit=1`, headers })).json() as AttentionList;
    expect(items.items.length).toBe(1);
    const dismiss = await app.inject({ method: "POST", url: `/api/v1/attention/${items.items[0]!.id}/dismiss`, headers, payload: {} });
    expect(dismiss.statusCode).toBe(403);
    const projDismiss = await app.inject({ method: "POST", url: `/api/v1/projects/${p1}/attention/${items.items[0]!.id}/dismiss`, headers, payload: {} });
    expect(projDismiss.statusCode).toBe(403);
  });
});
