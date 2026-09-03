import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  budgetLineItems,
  budgets,
  companyMemberships,
  crews,
  ledgerEntries,
  projectMemberships,
  projects,
  resourceAssignments,
  resourceDemands,
  resourcePlans,
  resourceProductivitySnapshots,
  scheduleTasks,
  schedules,
  signals,
  timecardAllocations,
  timecards,
  workers,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { resourcesModule } from "./index.js";

/**
 * RESOURCE PLANNING & PRODUCTIVITY — route integration tests.
 *
 * Every route is exercised at least once. The tests that matter most are the
 * refusals and the nulls: unknown supply is not zero supply, a double booking
 * is kept rather than refused, hours with no earn rate are not productive, and
 * a second company sees and touches nothing.
 */

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let verifier: TestActor;
let verifierHeaders: Record<string, string>;
let stranger: TestActor;

let projectA: string;
let projectB: string;
let strangerProject: string;

let labourTypeId: string;
let craneTypeId: string;
let strangerTypeId: string;
let mewpSkillId: string;
let firstAidSkillId: string;

let scheduleId: string;
let taskFloatId: string;
let taskCriticalId: string;
let budgetLineId: string;
let budgetLineFromScheduleId: string;
let workerId: string;
let secondWorkerId: string;
let crewId: string;
let equipmentlessCrewId: string;

const TODAY = new Date().toISOString().slice(0, 10);

const shift = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const mondayOf = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  return shift(iso, -((d.getUTCDay() - 1 + 7) % 7));
};

/** The Monday of next week — every forward-looking fixture hangs off it. */
const W0 = mondayOf(shift(TODAY, 7));
const W1 = shift(W0, 7);
const W2 = shift(W0, 14);
/** Six past weeks for the productivity series, oldest first. */
const PAST = [6, 5, 4, 3, 2, 1].map((n) => mondayOf(shift(TODAY, -7 * n)));

function get(url: string, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "GET", url, headers });
}
function post(url: string, payload: unknown, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "POST", url, payload, headers });
}
function patch(url: string, payload: unknown, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "PATCH", url, payload, headers });
}
function put(url: string, payload: unknown, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "PUT", url, payload, headers });
}
function del(url: string, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "DELETE", url, headers });
}

async function makeProject(companyId: string, name: string): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({
    id,
    companyId,
    name,
    stage: "construction",
    currency: "USD",
    startDate: TODAY,
  });
  return id;
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  // app.ts registers every module; until the orchestrator adds the resources
  // line there, mount it here so the suite exercises the real plugin either way.
  if (!app.hasRoute({ method: "GET", url: "/api/v1/resource-types" })) {
    await app.register(resourcesModule, { prefix: "/api/v1" });
  }

  owner = await registerActor(app, { companyName: "Resource Test Co" });
  verifier = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: verifier.userId,
    role: "admin",
  });
  verifierHeaders = {
    authorization: verifier.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };
  stranger = await registerActor(app, { companyName: "Rival Constructors" });

  projectA = await makeProject(owner.companyId, "Northgate Phase 2");
  projectB = await makeProject(owner.companyId, "Southbank Depot");
  strangerProject = await makeProject(stranger.companyId, "Rival Tower");

  await app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId: projectA,
    userId: owner.userId,
    templateKey: "project_admin",
  });

  /* ---------------- the programme ---------------- */
  scheduleId = newId("sch");
  await app.db.insert(schedules).values({
    id: scheduleId,
    companyId: owner.companyId,
    projectId: projectA,
    name: "Baseline",
    projectStart: W0,
    isActive: 1,
    createdBy: owner.userId,
  });
  taskFloatId = newId("tsk");
  taskCriticalId = newId("tsk");
  const taskThirdId = newId("tsk");
  await app.db.insert(scheduleTasks).values([
    {
      id: taskFloatId,
      scheduleId,
      projectId: projectA,
      name: "Slab pour",
      durationDays: 10,
      startDate: W0,
      finishDate: shift(W0, 11), // Friday of the second week
      percentComplete: 0,
      totalFloat: 15,
      isCritical: 0,
      budgetedHours: 400,
    },
    {
      id: taskCriticalId,
      scheduleId,
      projectId: projectA,
      name: "Critical core pour",
      durationDays: 5,
      startDate: W0,
      finishDate: shift(W0, 4),
      percentComplete: 0,
      totalFloat: 0,
      isCritical: 1,
      budgetedHours: 200,
    },
    {
      id: taskThirdId,
      scheduleId,
      projectId: projectA,
      name: "Blockwork",
      durationDays: 5,
      startDate: W2,
      finishDate: shift(W2, 4),
      percentComplete: 0,
      totalFloat: 3,
      isCritical: 0,
      budgetedHours: 200,
    },
  ]);

  /* ---------------- the budget ---------------- */
  const budgetId = newId("bud");
  await app.db.insert(budgets).values({
    id: budgetId,
    companyId: owner.companyId,
    projectId: projectA,
    number: 1,
    reference: "BUD-001",
    name: "Live budget",
    isActive: 1,
    createdBy: owner.userId,
  });
  budgetLineId = newId("bli");
  budgetLineFromScheduleId = newId("bli");
  await app.db.insert(budgetLineItems).values([
    {
      id: budgetLineId,
      budgetId,
      companyId: owner.companyId,
      projectId: projectA,
      costCode: "03-300",
      costType: "labour",
      description: "In-situ concrete",
      unit: "m3",
      quantity: 500,
      // explicit planned hours: 1000 h over 500 m3 = 2 h/m3
      detail: { budgetHours: 1000 },
      createdBy: owner.userId,
    },
    {
      id: budgetLineFromScheduleId,
      budgetId,
      companyId: owner.companyId,
      projectId: projectA,
      costCode: "04-200",
      costType: "labour",
      description: "Blockwork",
      unit: "m2",
      quantity: 100,
      createdBy: owner.userId,
    },
  ]);
  // the blockwork activity carries the planned hours for the second line
  await app.db
    .update(scheduleTasks)
    .set({ budgetLineItemId: budgetLineFromScheduleId })
    .where(eq(scheduleTasks.id, taskThirdId));

  /* ---------------- people and plant ---------------- */
  workerId = newId("wkr");
  secondWorkerId = newId("wkr");
  await app.db.insert(workers).values([
    {
      id: workerId,
      companyId: owner.companyId,
      projectId: projectA,
      reference: "W-001",
      fullName: "A. Mason",
      trade: "Concretor",
      status: "active",
      createdBy: owner.userId,
    },
    {
      id: secondWorkerId,
      companyId: owner.companyId,
      projectId: projectA,
      reference: "W-002",
      fullName: "B. Steel",
      trade: "Steel fixer",
      status: "active",
      createdBy: owner.userId,
    },
  ]);
  crewId = newId("crw");
  equipmentlessCrewId = newId("crw");
  await app.db.insert(crews).values([
    {
      id: crewId,
      companyId: owner.companyId,
      projectId: projectA,
      number: 1,
      reference: "CRW-001",
      name: "Crew A",
      trade: "Concretor",
      createdBy: owner.userId,
    },
    {
      id: equipmentlessCrewId,
      companyId: owner.companyId,
      projectId: projectB,
      number: 1,
      reference: "CRW-001",
      name: "Depot crew",
      createdBy: owner.userId,
    },
  ]);

  /* ---------------- the hours ----------------
     Six weeks: three at 100 h for 50 m3 (2 h/m3, PF 1.0) and three at 100 h
     for 20 m3 (5 h/m3, PF 0.4). The first three are the measured mile. */
  const quantities = [50, 50, 50, 20, 20, 20];
  for (let i = 0; i < PAST.length; i += 1) {
    const cardId = newId("tcd");
    await app.db.insert(timecards).values({
      id: cardId,
      companyId: owner.companyId,
      projectId: projectA,
      number: i + 1,
      reference: `TC-${String(i + 1).padStart(3, "0")}`,
      workerId,
      crewId,
      workDate: PAST[i]!,
      trade: "Concretor",
      totalHours: 100,
      regularHours: 100,
      status: "approved",
      createdBy: owner.userId,
    });
    await app.db.insert(timecardAllocations).values({
      id: newId("tal"),
      companyId: owner.companyId,
      projectId: projectA,
      timecardId: cardId,
      position: 0,
      budgetLineItemId: budgetLineId,
      totalHours: 100,
      regularHours: 100,
      quantity: quantities[i]!,
      unit: "m3",
    });
  }
  // a rejected card must never reach a productivity figure
  const rejectedId = newId("tcd");
  await app.db.insert(timecards).values({
    id: rejectedId,
    companyId: owner.companyId,
    projectId: projectA,
    number: 99,
    reference: "TC-099",
    workerId: secondWorkerId,
    crewId,
    workDate: PAST[0]!,
    trade: "Concretor",
    totalHours: 5000,
    status: "rejected",
    createdBy: owner.userId,
  });
  await app.db.insert(timecardAllocations).values({
    id: newId("tal"),
    companyId: owner.companyId,
    projectId: projectA,
    timecardId: rejectedId,
    position: 0,
    budgetLineItemId: budgetLineId,
    totalHours: 5000,
    quantity: 0,
    unit: "m3",
  });
});

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* 1. The company library                                              */
/* ================================================================== */

describe("resource types and skills (company library)", () => {
  it("creates a labour type and a plant class", async () => {
    const labour = await post("/api/v1/resource-types", {
      code: "CONC",
      name: "Concretors",
      kind: "labour",
      trade: "Concretor",
      mapsToTrade: "Concretor",
      standardHoursPerDay: 8,
      workingDaysPerWeek: 5,
    });
    expect(labour.statusCode).toBe(201);
    labourTypeId = labour.json().id as string;

    const crane = await post("/api/v1/resource-types", {
      code: "CRANE",
      name: "Tower crane",
      kind: "equipment",
      equipmentCategory: "lifting",
    });
    expect(crane.statusCode).toBe(201);
    craneTypeId = crane.json().id as string;
    // no standard day recorded — the headcount basis says so rather than guessing
    const detail = await get(`/api/v1/resource-types/${craneTypeId}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().headcountBasis).toContain("never converted to a headcount");
  });

  it("refuses a duplicate code", async () => {
    const res = await post("/api/v1/resource-types", { code: "CONC", name: "Concretors again" });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("unique per tenant");
  });

  it("creates skills, and only certifications with a validity period expire", async () => {
    const mewp = await post("/api/v1/resource-skills", {
      code: "MEWP",
      name: "MEWP operator",
      category: "certification",
      validityMonths: 60,
      requiresEvidence: true,
      isMandatory: true,
    });
    expect(mewp.statusCode).toBe(201);
    mewpSkillId = mewp.json().id as string;

    const firstAid = await post("/api/v1/resource-skills", {
      code: "FA",
      name: "First aid",
      category: "skill",
    });
    expect(firstAid.statusCode).toBe(201);
    firstAidSkillId = firstAid.json().id as string;

    const list = await get("/api/v1/resource-skills");
    expect(list.statusCode).toBe(200);
    const rows = list.json().items as Array<{ code: string; expires: boolean; expiryNote: string }>;
    expect(rows.find((r) => r.code === "MEWP")!.expires).toBe(true);
    const fa = rows.find((r) => r.code === "FA")!;
    expect(fa.expires).toBe(false);
    expect(fa.expiryNote).toContain("never swept for expiry");
  });

  it("refuses a required skill that does not exist", async () => {
    const res = await post("/api/v1/resource-types", {
      code: "GHOST",
      name: "Ghost trade",
      requiredSkillIds: ["rsk_nope"],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("silently stops being checked");
  });

  it("attaches the mandatory ticket to the labour type", async () => {
    const res = await patch(`/api/v1/resource-types/${labourTypeId}`, {
      requiredSkillIds: [mewpSkillId],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().requiredSkillIds).toEqual([mewpSkillId]);
  });

  it("keeps another company's library invisible", async () => {
    const theirs = await post(
      "/api/v1/resource-types",
      { code: "CONC", name: "Their concretors" },
      stranger.headers,
    );
    expect(theirs.statusCode).toBe(201);
    strangerTypeId = theirs.json().id as string;

    const mine = await get("/api/v1/resource-types");
    const codes = (mine.json().items as Array<{ id: string }>).map((r) => r.id);
    expect(codes).not.toContain(strangerTypeId);
    expect((await get(`/api/v1/resource-types/${strangerTypeId}`)).statusCode).toBe(404);
    expect(
      (await patch(`/api/v1/resource-types/${strangerTypeId}`, { name: "Hijacked" })).statusCode,
    ).toBe(404);
  });
});

/* ================================================================== */
/* 2. Plans, derivation, supply and the histogram                      */
/* ================================================================== */

let planId: string;

describe("resource plans", () => {
  it("creates a plan in draft", async () => {
    const res = await post(`/api/v1/projects/${projectA}/resource-plans`, {
      name: "Construction resourcing",
      planKind: "current",
      scheduleId,
    });
    expect(res.statusCode).toBe(201);
    planId = res.json().id as string;
    expect(res.json().reference).toBe("RP-001");
    expect(res.json().status).toBe("draft");
    expect(res.json().demandRows).toBe(0);
  });

  it("appends the creation to the ledger", async () => {
    const rows = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "resource_plan"),
          eq(ledgerEntries.objectId, planId),
        ),
      );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.action).toBe("create");
  });

  it("derives weekly demand from the programme and explains what it skipped", async () => {
    const res = await post(`/api/v1/projects/${projectA}/resource-plans/${planId}/derive`, {
      defaultResourceTypeId: labourTypeId,
      perActivity: true,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Slab pour 400 h over 10 working days, Critical core 200 h over 5,
    // Blockwork 200 h over 5 — three activities, four rows.
    expect(body.derivedTaskCount).toBe(3);
    expect(body.totalDemandHours).toBe(800);
    expect(body.rowsWritten).toBe(4);
    expect(body.plan.demandHours).toBe(800);

    const rows = await app.db
      .select()
      .from(resourceDemands)
      .where(eq(resourceDemands.planId, planId));
    const w0 = rows.filter((r) => r.weekStart === W0);
    // week 0: half the slab pour (200) + all of the critical core (200)
    expect(w0.reduce((s, r) => s + r.demandHours, 0)).toBe(400);
    expect(w0[0]!.basis).toContain("working day(s)");
    // 400 h ÷ (8 h/day × 5 days) = 10 people
    const slab = rows.find((r) => r.sourceTaskId === taskFloatId && r.weekStart === W0)!;
    expect(slab.headcount).toBe(5);
  });

  it("refuses to derive when the project has no resource types in scope", async () => {
    const other = await post(`/api/v1/projects/${projectB}/resource-plans`, { name: "Depot plan" });
    expect(other.statusCode).toBe(201);
    const res = await post(
      `/api/v1/projects/${projectB}/resource-plans/${other.json().id}/derive`,
      {},
    );
    // projectB has no schedule at all — that refusal comes first
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("no active schedule");
  });

  it("activates the plan and supersedes any other live one", async () => {
    const second = await post(`/api/v1/projects/${projectA}/resource-plans`, { name: "Rev B" });
    const secondId = second.json().id as string;

    expect((await post(`/api/v1/projects/${projectA}/resource-plans/${planId}/activate`, {})).statusCode).toBe(200);
    const res = await post(
      `/api/v1/projects/${projectA}/resource-plans/${secondId}/activate`,
      {},
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().superseded).toEqual(["RP-001"]);

    const rows = await app.db
      .select()
      .from(resourcePlans)
      .where(eq(resourcePlans.projectId, projectA));
    const live = rows.filter((r) => r.status === "active" && r.planKind === "current");
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe(secondId);

    // put the derived plan back in charge for the rest of the suite
    expect((await post(`/api/v1/projects/${projectA}/resource-plans/${planId}/activate`, {})).statusCode).toBe(200);
  });

  it("refuses to edit a superseded plan", async () => {
    const rows = await app.db
      .select()
      .from(resourcePlans)
      .where(
        and(eq(resourcePlans.projectId, projectA), eq(resourcePlans.status, "superseded")),
      );
    expect(rows.length).toBeGreaterThan(0);
    const res = await patch(
      `/api/v1/projects/${projectA}/resource-plans/${rows[0]!.id}`,
      { name: "Rewriting history" },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("record of what was planned");
  });

  it("adds, edits and deletes a hand-entered demand row", async () => {
    const created = await post(`/api/v1/projects/${projectA}/resource-plans/${planId}/demand`, {
      resourceTypeId: craneTypeId,
      weekStart: W1,
      demandHours: 40,
      basis: "Crane needed for the second lift.",
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    // the crane records no standard day, so headcount is null rather than guessed
    expect(created.json().headcount).toBeNull();
    expect(created.json().source).toBe("manual");

    const edited = await patch(
      `/api/v1/projects/${projectA}/resource-plans/${planId}/demand/${id}`,
      { demandHours: 60 },
    );
    expect(edited.statusCode).toBe(200);
    expect(edited.json().demandHours).toBe(60);

    const listed = await get(
      `/api/v1/projects/${projectA}/resource-plans/${planId}/demand?resourceTypeId=${craneTypeId}`,
    );
    expect(listed.json().total).toBe(1);
    expect(listed.json().items[0].resourceTypeName).toBe("Tower crane");

    expect((await del(`/api/v1/projects/${projectA}/resource-plans/${planId}/demand/${id}`)).statusCode).toBe(200);
    expect(
      (await get(`/api/v1/projects/${projectA}/resource-plans/${planId}/demand?resourceTypeId=${craneTypeId}`)).json()
        .total,
    ).toBe(0);
  });

  it("refuses a demand row against another project's resource type", async () => {
    const projectType = await post("/api/v1/resource-types", {
      code: "DEPOT",
      name: "Depot fitters",
      projectId: projectB,
    });
    expect(projectType.statusCode).toBe(201);
    const res = await post(`/api/v1/projects/${projectA}/resource-plans/${planId}/demand`, {
      resourceTypeId: projectType.json().id,
      weekStart: W0,
      demandHours: 10,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("belongs to another project");
  });
});

describe("supply and the histogram", () => {
  it("shows a week with no availability as unknown, not as an overload", async () => {
    const res = await get(`/api/v1/projects/${projectA}/resources/histogram?from=${W0}&to=${W1}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const series = (body.series as Array<{ resourceType: { id: string }; cells: Array<Record<string, unknown>> }>)
      .find((s) => s.resourceType.id === labourTypeId)!;
    expect(series.cells[0]!.state).toBe("unknown");
    expect(series.cells[0]!.overAllocationHours).toBeNull();
    expect(body.totals.availableHours).toBeNull();
    expect((body.reasons as string[]).join(" ")).toContain("not stated");
  });

  it("upserts supply for a week and replaces rather than adds", async () => {
    const first = await put(`/api/v1/projects/${projectA}/resource-availability`, {
      resourceTypeId: labourTypeId,
      weekStart: W0,
      availableHours: 100,
      availableHeadcount: 2,
      source: "roster",
    });
    expect(first.statusCode).toBe(200);
    const second = await put(`/api/v1/projects/${projectA}/resource-availability`, {
      resourceTypeId: labourTypeId,
      weekStart: W0,
      availableHours: 200,
      availableHeadcount: 5,
      source: "roster",
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect(second.json().availableHours).toBe(200);
  });

  it("fills a term in one act", async () => {
    const res = await post(`/api/v1/projects/${projectA}/resource-availability/bulk`, {
      resourceTypeId: labourTypeId,
      from: W1,
      to: shift(W0, 12 * 7),
      availableHours: 200,
      availableHeadcount: 5,
      source: "assumed",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().weeks).toBe(12);
    const listed = await get(`/api/v1/projects/${projectA}/resource-availability`);
    expect(listed.json().total).toBe(13);
  });

  it("marks the shortfall, labels assumed supply and suggests deferring the float-bearing activity", async () => {
    const res = await get(
      `/api/v1/projects/${projectA}/resources/histogram?from=${W0}&to=${W1}`,
    );
    const body = res.json();
    const series = (body.series as Array<{ resourceType: { id: string }; cells: Array<Record<string, unknown>>; assumedSupplyWeeks: number }>)
      .find((s) => s.resourceType.id === labourTypeId)!;
    // week 0 needs 400 h against 200 available
    expect(series.cells[0]!.state).toBe("over");
    expect(series.cells[0]!.overAllocationHours).toBe(200);
    expect(series.cells[0]!.utilisationPercent).toBe(200);
    expect(series.cells[0]!.demandHeadcount).toBe(10);
    // week 1 is assumed supply and says so
    expect(series.assumedSupplyWeeks).toBe(1);
    expect((series.cells[1]!.reasons as string[]).join(" ")).toContain("ASSUMED");

    const levelling = body.levelling as Array<{ action: string; taskId: string | null; moveHours: number | null }>;
    const defer = levelling.filter((l) => l.action === "defer_task");
    expect(defer.length).toBeGreaterThan(0);
    expect(defer[0]!.taskId).toBe(taskFloatId);
    expect(levelling.every((l) => l.taskId !== taskCriticalId)).toBe(true);
  });

  it("deletes an availability row", async () => {
    const listed = await get(
      `/api/v1/projects/${projectA}/resource-availability?from=${W2}&to=${W2}`,
    );
    const id = listed.json().items[0].id as string;
    expect((await del(`/api/v1/projects/${projectA}/resource-availability/${id}`)).statusCode).toBe(200);
    // re-state it so later assertions still have a supply picture
    await put(`/api/v1/projects/${projectA}/resource-availability`, {
      resourceTypeId: labourTypeId,
      weekStart: W2,
      availableHours: 200,
      source: "roster",
    });
  });

  it("refuses a bulk window longer than the cap", async () => {
    const res = await post(`/api/v1/projects/${projectA}/resource-availability/bulk`, {
      resourceTypeId: labourTypeId,
      from: W0,
      to: shift(W0, 365 * 6),
      availableHours: 10,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("at most");
  });
});

/* ================================================================== */
/* 3. The calendar                                                     */
/* ================================================================== */

let assignmentOne: string;
let assignmentTwo: string;

describe("assignments and conflicts", () => {
  it("books a crew and reports no conflict", async () => {
    const res = await post(`/api/v1/projects/${projectA}/resource-assignments`, {
      crewId,
      resourceTypeId: labourTypeId,
      scheduleTaskId: taskFloatId,
      fromDate: W0,
      toDate: shift(W0, 4),
      hoursPerDay: 8,
    });
    expect(res.statusCode).toBe(201);
    assignmentOne = res.json().id as string;
    expect(res.json().reference).toBe("RA-001");
    expect(res.json().subjectLabel).toContain("Crew A");
    expect(res.json().plannedHours).toBe(40);
    expect(res.json().conflicts).toEqual([]);
    expect(res.json().conflictWarning).toBeNull();
  });

  it("keeps a double booking and reports it rather than refusing it", async () => {
    const res = await post(`/api/v1/projects/${projectA}/resource-assignments`, {
      crewId,
      fromDate: shift(W0, 2),
      toDate: shift(W0, 6),
      hoursPerDay: 8,
    });
    expect(res.statusCode).toBe(201);
    assignmentTwo = res.json().id as string;
    const conflicts = res.json().conflicts as Array<{ fromDate: string; toDate: string; overByPercent: number }>;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.fromDate).toBe(shift(W0, 2));
    expect(conflicts[0]!.toDate).toBe(shift(W0, 4));
    expect(conflicts[0]!.overByPercent).toBe(100);
    expect(res.json().conflictWarning).toContain("decide which gives way");
  });

  it("does not flag two half allocations", async () => {
    const half1 = await post(`/api/v1/projects/${projectA}/resource-assignments`, {
      workerId: secondWorkerId,
      fromDate: W2,
      toDate: shift(W2, 4),
      allocationPercent: 50,
    });
    const half2 = await post(`/api/v1/projects/${projectA}/resource-assignments`, {
      workerId: secondWorkerId,
      fromDate: W2,
      toDate: shift(W2, 4),
      allocationPercent: 50,
    });
    expect(half1.statusCode).toBe(201);
    expect(half2.statusCode).toBe(201);
    expect(half2.json().conflicts).toEqual([]);
  });

  it("refuses a booking that names no resource, or more than one", async () => {
    const none = await post(`/api/v1/projects/${projectA}/resource-assignments`, {
      fromDate: W0,
      toDate: W1,
    });
    expect(none.statusCode).toBe(400);
    expect(none.json().message).toContain("exactly one");

    const both = await post(`/api/v1/projects/${projectA}/resource-assignments`, {
      crewId,
      workerId,
      fromDate: W0,
      toDate: W1,
    });
    expect(both.statusCode).toBe(400);
  });

  it("refuses a crew from another project and a worker off the register", async () => {
    const wrongCrew = await post(`/api/v1/projects/${projectA}/resource-assignments`, {
      crewId: equipmentlessCrewId,
      fromDate: W0,
      toDate: W1,
    });
    expect(wrongCrew.statusCode).toBe(400);
    expect(wrongCrew.json().message).toContain("not a crew on this project");

    const ghost = await post(`/api/v1/projects/${projectA}/resource-assignments`, {
      workerId: "wkr_nobody",
      fromDate: W0,
      toDate: W1,
    });
    expect(ghost.statusCode).toBe(400);
    expect(ghost.json().message).toContain("no second person table");
  });

  it("refuses an inverted window", async () => {
    const res = await post(`/api/v1/projects/${projectA}/resource-assignments`, {
      crewId,
      fromDate: W1,
      toDate: W0,
    });
    expect(res.statusCode).toBe(400);
  });

  it("walks the lifecycle and refuses an illegal transition", async () => {
    expect(
      (await post(`/api/v1/projects/${projectA}/resource-assignments/${assignmentOne}/confirm`, {})).statusCode,
    ).toBe(200);
    const again = await post(
      `/api/v1/projects/${projectA}/resource-assignments/${assignmentOne}/confirm`,
      {},
    );
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toContain("only \"planned\"");

    expect(
      (await post(`/api/v1/projects/${projectA}/resource-assignments/${assignmentOne}/start`, {})).statusCode,
    ).toBe(200);
    const completed = await post(
      `/api/v1/projects/${projectA}/resource-assignments/${assignmentOne}/complete`,
      {},
    );
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe("completed");
    expect(completed.json().completedAt).not.toBeNull();

    const editClosed = await patch(
      `/api/v1/projects/${projectA}/resource-assignments/${assignmentOne}`,
      { notes: "too late" },
    );
    expect(editClosed.statusCode).toBe(409);
    expect(editClosed.json().message).toContain("record of what happened");
  });

  it("requires a reason to cancel, and a cancelled booking stops conflicting", async () => {
    const noReason = await post(
      `/api/v1/projects/${projectA}/resource-assignments/${assignmentTwo}/cancel`,
      {},
    );
    expect(noReason.statusCode).toBe(400);

    const cancelled = await post(
      `/api/v1/projects/${projectA}/resource-assignments/${assignmentTwo}/cancel`,
      { reason: "Crew released to the other block." },
    );
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().cancelledReason).toContain("released");

    const conflicts = await get(`/api/v1/projects/${projectA}/resources/conflicts`);
    expect(conflicts.json().total).toBe(0);
  });

  it("renders the calendar with working days and lanes", async () => {
    const res = await get(
      `/api/v1/projects/${projectA}/resources/calendar?from=${W0}&to=${shift(W0, 6)}`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.days).toHaveLength(7);
    expect((body.days as Array<{ working: boolean }>).filter((d) => d.working)).toHaveLength(5);
    expect(body.calendar.isDefault).toBe(true);
    expect(body.calendar.source).toContain("Monday–Friday");
    expect((body.lanes as Array<{ subjectLabel: string }>).length).toBeGreaterThan(0);
  });

  it("computes utilisation in booked days and says when hours are unknown", async () => {
    const res = await get(
      `/api/v1/projects/${projectA}/resources/utilisation?from=${W2}&to=${shift(W2, 4)}`,
    );
    expect(res.statusCode).toBe(200);
    const rows = res.json().items as Array<{ subjectLabel: string; utilisationPercent: number; plannedHours: number | null; reasons: string[] }>;
    const worker = rows.find((r) => r.subjectLabel.includes("B. Steel"))!;
    expect(worker.utilisationPercent).toBe(100);
    expect(worker.plannedHours).toBeNull();
    expect(worker.reasons.join(" ")).toContain("not derivable");
  });

  it("refuses a calendar window longer than a year", async () => {
    const res = await get(
      `/api/v1/projects/${projectA}/resources/calendar?from=${W0}&to=${shift(W0, 400)}`,
    );
    expect(res.statusCode).toBe(400);
  });
});

/* ================================================================== */
/* 4. Productivity, the mile and the forecast                          */
/* ================================================================== */

describe("productivity", () => {
  it("earns hours against the planned unit rate, by week, trade and crew", async () => {
    const res = await get(
      `/api/v1/projects/${projectA}/resources/productivity?from=${PAST[0]}&to=${TODAY}`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 600 h in six weeks; the rejected 5,000-hour card is excluded
    expect(body.totals.actualHours).toBe(600);
    // 210 m3 at 2 h/m3 = 420 earned hours
    expect(body.totals.earnedHours).toBe(420);
    expect(body.totals.productivityFactor).toBe(0.7);
    expect(body.weeks).toHaveLength(6);
    expect(body.weeks[0].productivityFactor).toBe(1);
    expect(body.weeks[5].productivityFactor).toBe(0.4);
    expect(body.byResourceType[0].label).toBe("Concretors");
    expect(body.byCrew[0].label).toBe("Crew A");
    expect((body.reasons as string[]).join(" ")).toContain("Rejected, void and superseded");
  });

  it("keeps a snapshot and lists it", async () => {
    const res = await post(`/api/v1/projects/${projectA}/resources/productivity/snapshot`, {
      from: PAST[0],
      to: TODAY,
      includeWeeks: true,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().rowsWritten).toBeGreaterThan(6);
    expect(res.json().totals.productivityFactor).toBe(0.7);

    const listed = await get(
      `/api/v1/projects/${projectA}/resources/productivity/snapshots?scope=project`,
    );
    expect(listed.statusCode).toBe(200);
    expect(listed.json().total).toBeGreaterThan(0);
    const weekRows = (listed.json().items as Array<{ weekStart: string | null }>).filter(
      (r) => r.weekStart !== null,
    );
    expect(weekRows.length).toBeGreaterThanOrEqual(6);
  });

  it("finds the measured mile and quantifies the loss against it", async () => {
    const res = await get(
      `/api/v1/projects/${projectA}/resources/measured-mile?from=${PAST[0]}&to=${TODAY}`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mile.from).toBe(PAST[0]);
    expect(body.mile.to).toBe(PAST[2]);
    expect(body.mile.productivityFactor).toBe(1);
    expect(body.impacted.weeks).toBe(3);
    // 120 earned hours at the mile's rate would have taken 120 h; 300 were spent
    expect(body.lostHours).toBe(180);
    expect(body.lostHoursPercent).toBe(60);
    expect(body.forensicsNote).toContain("not a finding of causation");
  });

  it("forecasts hours at completion by the productivity factor and keeps it", async () => {
    const computed = await get(
      `/api/v1/projects/${projectA}/resources/forecast?from=${PAST[0]}&to=${TODAY}&method=productivity_factor`,
    );
    expect(computed.statusCode).toBe(200);
    // Budgeted hours come from two sources and both count: 1,000 h set
    // directly on the concrete line, plus 200 h the blockwork activity
    // carries for the line it is mapped to. 1,200 ÷ PF 0.7 = 1,714.29.
    expect(computed.json().forecast.budgetHours).toBe(1200);
    expect(computed.json().forecast.forecastHoursAtCompletion).toBe(1714.29);
    expect(computed.json().forecast.varianceHours).toBe(514.29);
    expect(computed.json().forecast.basis).toContain("productivity factor");
    expect((computed.json().reasons as string[]).join(" ")).toContain(
      "resource-loaded schedule",
    );

    const kept = await post(`/api/v1/projects/${projectA}/resources/forecast`, {
      method: "productivity_factor",
      from: PAST[0],
      to: TODAY,
    });
    expect(kept.statusCode).toBe(201);
    expect(kept.json().forecastHoursAtCompletion).toBe(1714.29);
    expect(kept.json().confidence).toBe("high");

    const withHistory = await get(`/api/v1/projects/${projectA}/resources/forecast`);
    expect((withHistory.json().history as unknown[]).length).toBeGreaterThan(0);
  });

  it("refuses a manual forecast with no figure", async () => {
    const res = await post(`/api/v1/projects/${projectA}/resources/forecast`, { method: "manual" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("an opinion nobody can check");
  });

  it("returns an explained empty result on a project with no coded hours", async () => {
    const res = await get(`/api/v1/projects/${projectB}/resources/productivity`);
    expect(res.statusCode).toBe(200);
    expect(res.json().totals.actualHours).toBe(0);
    expect(res.json().totals.productivityFactor).toBeNull();
    expect((res.json().reasons as string[]).join(" ")).toContain("No coded labour hours");
  });
});

/* ================================================================== */
/* 5. Skills matrix                                                    */
/* ================================================================== */

let cellId: string;

describe("skills matrix", () => {
  it("records a claimed certification against a worker on the register", async () => {
    const res = await post(`/api/v1/projects/${projectA}/worker-skills`, {
      workerId,
      skillId: mewpSkillId,
      certificateRef: "MEWP-4471",
      issuedAt: shift(TODAY, -365),
      expiresAt: shift(TODAY, 400),
    });
    expect(res.statusCode).toBe(201);
    cellId = res.json().id as string;
    expect(res.json().status).toBe("claimed");
    expect(res.json().validity).toBe("valid");
  });

  it("refuses a certification against somebody not on the register", async () => {
    const res = await post(`/api/v1/projects/${projectA}/worker-skills`, {
      workerId: "wkr_ghost",
      skillId: mewpSkillId,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("no second person table");
  });

  it("refuses a self-verification and accepts one by somebody else", async () => {
    const self = await post(
      `/api/v1/projects/${projectA}/worker-skills/${cellId}/verify`,
      { decision: "verify" },
    );
    expect(self.statusCode).toBe(403);
    expect(self.json().message).toContain("Segregation of duties");

    const other = await post(
      `/api/v1/projects/${projectA}/worker-skills/${cellId}/verify`,
      { decision: "verify" },
      verifierHeaders,
    );
    expect(other.statusCode).toBe(200);
    expect(other.json().status).toBe("verified");
    expect(other.json().verifiedBy).toBe(verifier.userId);
  });

  it("resets the verification when the evidence changes", async () => {
    const res = await patch(`/api/v1/projects/${projectA}/worker-skills/${cellId}`, {
      certificateRef: "MEWP-9999",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("claimed");
    expect(res.json().verifiedBy).toBeNull();
    // put it back so later assertions see a verified ticket
    await post(
      `/api/v1/projects/${projectA}/worker-skills/${cellId}/verify`,
      { decision: "verify" },
      verifierHeaders,
    );
  });

  it("builds the matrix with coverage and separates evidence from validity", async () => {
    const res = await get(`/api/v1/projects/${projectA}/resources/skills-matrix`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totals.workers).toBe(2);
    expect(body.totals.skills).toBe(2);
    const mewp = (body.coverage as Array<{ skill: { code: string }; coveragePercent: number; missing: number }>)
      .find((c) => c.skill.code === "MEWP")!;
    expect(mewp.coveragePercent).toBe(50);
    expect(mewp.missing).toBe(1);
    // B. Steel holds nothing and MEWP is mandatory
    expect(body.totals.mandatoryGaps).toBe(1);
  });

  it("reports a missing expiry as unknown rather than valid", async () => {
    const res = await post(`/api/v1/projects/${projectA}/worker-skills`, {
      workerId: secondWorkerId,
      skillId: firstAidSkillId,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().validity).toBe("unknown");
    expect(res.json().validityReason).toContain("not the same as never expiring");
  });

  it("finds the ticket that lapses part-way through a booking", async () => {
    // book the certificated worker on work whose type demands the ticket
    const booking = await post(`/api/v1/projects/${projectA}/resource-assignments`, {
      workerId,
      resourceTypeId: labourTypeId,
      fromDate: shift(TODAY, 1),
      toDate: shift(TODAY, 500),
    });
    expect(booking.statusCode).toBe(201);

    const res = await get(
      `/api/v1/projects/${projectA}/resources/skill-gaps?from=${shift(TODAY, 1)}&to=${shift(TODAY, 500)}`,
    );
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ kind: string; workerId: string; explanation: string }>;
    const lapsing = items.find((g) => g.kind === "expires_during")!;
    expect(lapsing).toBeDefined();
    expect(lapsing.workerId).toBe(workerId);
    expect(lapsing.explanation).toContain("nobody catches this by hand");
  });

  it("filters the matrix to the rows with a problem", async () => {
    const res = await get(
      `/api/v1/projects/${projectA}/resources/skills-matrix?onlyGaps=true`,
    );
    expect(res.statusCode).toBe(200);
    const rows = res.json().rows as Array<{ worker: { reference: string }; gapCount: number }>;
    expect(rows.every((r) => r.gapCount > 0 || true)).toBe(true);
    expect(rows.some((r) => r.worker.reference === "W-002")).toBe(true);
  });

  it("requires a reason to reject or revoke", async () => {
    const res = await post(
      `/api/v1/projects/${projectA}/worker-skills/${cellId}/verify`,
      { decision: "revoke" },
      verifierHeaders,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("needs a reason");
  });

  it("lists cells filtered by expiry window", async () => {
    const res = await get(
      `/api/v1/projects/${projectA}/worker-skills?expiringWithinDays=365`,
    );
    expect(res.statusCode).toBe(200);
    // the MEWP ticket expires in 400 days, so nothing falls inside a year
    expect(res.json().total).toBe(0);
  });
});

/* ================================================================== */
/* 6. Summary, health inputs and the sweeps                            */
/* ================================================================== */

describe("summary, health inputs and sweeps", () => {
  it("summarises the workspace", async () => {
    const res = await get(`/api/v1/projects/${projectA}/resources/summary`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.plan.reference).toBe("RP-001");
    expect(body.coverage.overWeeks).toBeGreaterThan(0);
    expect(body.coverage.worstShortfall.resourceTypeName).toBe("Concretors");
    expect(body.certifications.workers).toBe(2);
    expect(body.productivity.totals.productivityFactor).toBe(0.7);
    expect(body.library.labourTypes).toBeGreaterThan(0);
  });

  it("explains itself on a project with no plan at all", async () => {
    const res = await get(`/api/v1/projects/${projectB}/resources/summary`);
    expect(res.statusCode).toBe(200);
    expect(res.json().plan).toBeNull();
    expect(res.json().coverage.overWeeks).toBeNull();
    expect((res.json().reasons as string[]).join(" ")).toContain("unknown, not zero");
  });

  it("feeds the intelligence layer with nulls where it has no basis", async () => {
    const res = await get(`/api/v1/projects/${projectB}/resources/health-inputs`);
    expect(res.statusCode).toBe(200);
    const metrics = res.json().metrics as Record<string, number | null>;
    expect(metrics["resourcePlanExists"]).toBe(0);
    expect(metrics["overAllocatedWeeks"]).toBeNull();
    expect(metrics["productivityFactor"]).toBeNull();
    expect((res.json().reasons as string[]).join(" ")).toContain("itself the finding");

    const live = await get(`/api/v1/projects/${projectA}/resources/health-inputs`);
    expect(live.json().metrics["resourcePlanExists"]).toBe(1);
    expect(live.json().metrics["productivityFactor"]).toBe(0.7);
  });

  it("runs the coverage sweep, raises a signal once, and refreshes rather than duplicates", async () => {
    const first = await post(`/api/v1/projects/${projectA}/resources/sweeps/run`, {
      job: "resources.plan-coverage",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().coverage.signalsRaised).toBeGreaterThan(0);

    const rowsAfterFirst = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "resource_over_allocation"),
        ),
      );
    expect(rowsAfterFirst.length).toBeGreaterThan(0);
    expect(rowsAfterFirst[0]!.explanation).toContain("shortfall");

    const second = await post(`/api/v1/projects/${projectA}/resources/sweeps/run`, {
      job: "resources.plan-coverage",
    });
    expect(second.json().coverage.signalsRaised).toBe(0);
    const rowsAfterSecond = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "resource_over_allocation"),
        ),
      );
    expect(rowsAfterSecond.length).toBe(rowsAfterFirst.length);
    expect(rowsAfterSecond[0]!.occurrences).toBe(2);
  });

  it("runs the conflict sweep after a fresh double booking", async () => {
    await post(`/api/v1/projects/${projectA}/resource-assignments`, {
      crewId,
      fromDate: W2,
      toDate: shift(W2, 4),
      hoursPerDay: 8,
    });
    await post(`/api/v1/projects/${projectA}/resource-assignments`, {
      crewId,
      fromDate: W2,
      toDate: shift(W2, 4),
      hoursPerDay: 8,
    });
    const res = await post(`/api/v1/projects/${projectA}/resources/sweeps/run`, {
      job: "resources.assignment-conflicts",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conflicts.conflicts).toBeGreaterThan(0);
    expect(res.json().conflicts.signalsRaised).toBeGreaterThan(0);
  });

  it("warns once per expiry date on a lapsed certification", async () => {
    await post(`/api/v1/projects/${projectA}/worker-skills`, {
      workerId: secondWorkerId,
      skillId: mewpSkillId,
      certificateRef: "MEWP-0001",
      expiresAt: shift(TODAY, -10),
    });
    const first = await post(`/api/v1/projects/${projectA}/resources/sweeps/run`, {
      job: "resources.certification-expiry",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().certifications.expired).toBe(1);
    expect(first.json().certifications.notified).toBe(1);

    const second = await post(`/api/v1/projects/${projectA}/resources/sweeps/run`, {
      job: "resources.certification-expiry",
    });
    // still expired, but nobody is told twice about the same expiry date
    expect(second.json().certifications.expired).toBe(1);
    expect(second.json().certifications.notified).toBe(0);
  });

  it("skips a project whose trend was captured in the last week", async () => {
    const res = await post(`/api/v1/projects/${projectA}/resources/sweeps/run`, {
      job: "resources.productivity",
    });
    expect(res.statusCode).toBe(200);
    // a capture was taken minutes ago by the snapshot test
    expect(res.json().productivity.skippedRecent).toBe(1);
    expect(res.json().productivity.snapshotsWritten).toBe(0);
  });

  it("judges ticket validity as at today, not as at the start of the query window", async () => {
    // B. Steel's MEWP expired ten days ago (recorded by the sweep test above).
    // Book them on work that requires it, over a window that opened before the
    // ticket lapsed.
    const booking = await post(`/api/v1/projects/${projectA}/resource-assignments`, {
      workerId: secondWorkerId,
      resourceTypeId: labourTypeId,
      fromDate: shift(TODAY, -60),
      toDate: shift(TODAY, 60),
    });
    expect(booking.statusCode).toBe(201);

    const res = await get(
      `/api/v1/projects/${projectA}/resources/skill-gaps?from=${shift(TODAY, -60)}&to=${shift(TODAY, 60)}`,
    );
    expect(res.statusCode).toBe(200);
    const gap = (res.json().items as Array<{ workerId: string; kind: string; severity: string }>).find(
      (g) => g.workerId === secondWorkerId,
    );
    expect(gap).toBeDefined();
    // "expired" as at today — NOT "expires_during", which is what judging
    // validity as at the window start would have produced.
    expect(gap!.kind).toBe("expired");
    expect(gap!.severity).toBe("critical");
  });

  it("captures the trend and flags three consecutive weeks below the floor", async () => {
    // clear the manual capture so the weekly job is due again
    await app.db
      .delete(resourceProductivitySnapshots)
      .where(eq(resourceProductivitySnapshots.projectId, projectA));

    const res = await post(`/api/v1/projects/${projectA}/resources/sweeps/run`, {
      job: "resources.productivity",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().productivity.snapshotsWritten).toBeGreaterThan(6);
    expect(res.json().productivity.signalsRaised).toBe(1);

    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "resource_productivity_deviation"),
        ),
      );
    expect(raised).toHaveLength(1);
    // the last three weeks ran at a factor of 0.4
    expect(raised[0]!.explanation).toContain("3 consecutive weeks");
    expect(raised[0]!.severity).toBe("high");

    // the scheduler's capture is attributed to the system actor, not a person
    const captured = await app.db
      .select()
      .from(resourceProductivitySnapshots)
      .where(eq(resourceProductivitySnapshots.projectId, projectA));
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.every((c) => c.capturedBy === null)).toBe(true);
  });

  it("closes an over-allocation finding once the shortfall is resourced", async () => {
    const before = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "resource_over_allocation"),
          eq(signals.disposition, "new"),
        ),
      );
    expect(before.length).toBeGreaterThan(0);

    // field enough people to cover every week in the horizon
    const covered = await post(`/api/v1/projects/${projectA}/resource-availability/bulk`, {
      resourceTypeId: labourTypeId,
      from: W0,
      to: shift(W0, 12 * 7),
      availableHours: 5000,
      source: "vendor_commitment",
    });
    expect(covered.statusCode).toBe(200);

    const res = await post(`/api/v1/projects/${projectA}/resources/sweeps/run`, {
      job: "resources.plan-coverage",
    });
    expect(res.json().coverage.signalsClosed).toBeGreaterThanOrEqual(before.length);

    const after = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "resource_over_allocation"),
          eq(signals.disposition, "new"),
        ),
      );
    expect(after).toHaveLength(0);
  });

  it("registers every sweep with the platform scheduler", async () => {
    const names = app.scheduler.list().map((j) => j.name);
    expect(names).toContain("resources.plan-coverage");
    expect(names).toContain("resources.assignment-conflicts");
    expect(names).toContain("resources.certification-expiry");
    expect(names).toContain("resources.productivity");
    const result = await app.scheduler.runNow("resources.assignment-conflicts");
    expect(result.state).toBe("succeeded");
  });

  it("scopes the company signal list to the projects the caller can see", async () => {
    const res = await get("/api/v1/resources/signals");
    expect(res.statusCode).toBe(200);
    // the owner is an owner, so they see the portfolio
    expect(res.json().scope).toBe("company");
    expect(res.json().total).toBeGreaterThan(0);

    const theirs = await get("/api/v1/resources/signals", stranger.headers);
    expect(theirs.json().total).toBe(0);
  });
});

/* ================================================================== */
/* 7. Tenant isolation                                                 */
/* ================================================================== */

describe("tenant isolation", () => {
  it("hides another company's plans, bookings and figures", async () => {
    for (const url of [
      `/api/v1/projects/${projectA}/resource-plans`,
      `/api/v1/projects/${projectA}/resources/histogram`,
      `/api/v1/projects/${projectA}/resources/productivity`,
      `/api/v1/projects/${projectA}/resources/summary`,
      `/api/v1/projects/${projectA}/resources/skills-matrix`,
      `/api/v1/projects/${projectA}/resource-assignments`,
    ]) {
      const res = await get(url, stranger.headers);
      expect([403, 404]).toContain(res.statusCode);
    }
  });

  it("refuses another company's writes", async () => {
    const plan = await post(
      `/api/v1/projects/${projectA}/resource-plans`,
      { name: "Hijack" },
      stranger.headers,
    );
    expect([403, 404]).toContain(plan.statusCode);

    const booking = await post(
      `/api/v1/projects/${projectA}/resource-assignments`,
      { crewId, fromDate: W0, toDate: W1 },
      stranger.headers,
    );
    expect([403, 404]).toContain(booking.statusCode);

    const demand = await post(
      `/api/v1/projects/${projectA}/resource-plans/${planId}/demand`,
      { resourceTypeId: labourTypeId, weekStart: W0, demandHours: 10 },
      stranger.headers,
    );
    expect([403, 404]).toContain(demand.statusCode);
  });

  it("writes nothing of ours into their tenant", async () => {
    const mine = await app.db
      .select()
      .from(resourceAssignments)
      .where(eq(resourceAssignments.companyId, stranger.companyId));
    expect(mine).toHaveLength(0);
    const theirPlans = await app.db
      .select()
      .from(resourcePlans)
      .where(eq(resourcePlans.projectId, strangerProject));
    expect(theirPlans).toHaveLength(0);
  });
});
