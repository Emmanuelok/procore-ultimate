/**
 * Action plans — the template library, instances anchored to a location or a
 * schedule task, evidence before sign-off, multi-party sign-off, quality
 * checkpoint gating, the completion report, the overdue sweep and tenant
 * isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  actionPlans,
  companyMemberships,
  files,
  locations,
  projectMemberships,
  projects,
  scheduleTasks,
  schedules,
  signals,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO } from "./engines/dates.js";
import { correspondenceModule } from "./index.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let engineer: TestActor;
let inspector: TestActor;
let stranger: TestActor;
let projectId: string;
let locationId: string;
let taskId: string;
let fileId: string;
let templateId: string;

const today = new Date().toISOString().slice(0, 10);

const post = (url: string, payload?: unknown, headers = owner.headers) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload: payload ?? {} });
const patch = (url: string, payload: unknown, headers = owner.headers) =>
  app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload });
const get = (url: string, headers = owner.headers) =>
  app.inject({ method: "GET", url: `/api/v1${url}`, headers });

async function member(role: "admin" | "member"): Promise<TestActor> {
  const actor = await registerActor(app);
  await app.db
    .insert(companyMemberships)
    .values({ id: newId("cm"), companyId: owner.companyId, userId: actor.userId, role });
  return {
    ...actor,
    companyId: owner.companyId,
    headers: { authorization: actor.headers["authorization"]!, "x-company-id": owner.companyId },
  };
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  if (!app.scheduler.has("correspondence.plan-due")) {
    await app.register(correspondenceModule, { prefix: "/api/v1" });
  }
  owner = await registerActor(app);
  engineer = await member("admin");
  inspector = await member("admin");
  stranger = await registerActor(app);

  projectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "Correspondence — action plans",
    stage: "course_of_construction",
  });
  await app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId,
    userId: engineer.userId,
    templateKey: "project_manager",
  });

  locationId = newId("loc");
  await app.db.insert(locations).values({
    id: locationId,
    companyId: owner.companyId,
    projectId,
    name: "Level 3 — east wing",
    path: locationId,
  });

  const scheduleId = newId("sch");
  await app.db.insert(schedules).values({
    id: scheduleId,
    companyId: owner.companyId,
    projectId,
    name: "Baseline",
    projectStart: today,
    createdBy: owner.userId,
  });
  taskId = newId("tsk");
  await app.db.insert(scheduleTasks).values({
    id: taskId,
    scheduleId,
    projectId,
    name: "Pour L3 slab",
    durationDays: 5,
    startDate: addDaysISO(today, 10),
    finishDate: addDaysISO(today, 15),
  });

  fileId = newId("fil");
  await app.db.insert(files).values({
    id: fileId,
    companyId: owner.companyId,
    projectId,
    name: "pour-card.pdf",
    contentType: "application/pdf",
    sizeBytes: 30,
    sha256: "c".repeat(64),
    storageKey: "test/pour-card.pdf",
    metadata: {},
    uploadedBy: owner.userId,
  });
}, 180_000);

afterAll(async () => {
  await built.close();
}, 60_000);

/* ================================================================== */
/* Templates (#447–#451)                                               */
/* ================================================================== */

describe("action plan templates", () => {
  it("creates a template with required activities, evidence and sign-off parties", async () => {
    const res = await post("/correspondence/action-plan-templates", {
      key: "concrete_pour",
      name: "Concrete pour readiness",
      category: "quality",
      activities: [
        {
          title: "Formwork and reinforcement check",
          evidenceRequired: true,
          evidenceRequirement: "Photographs of the cage and the signed rebar check sheet.",
          referenceFileIds: [],
          signoffParties: [{ partyType: "user", label: "Site engineer" }],
          dueOffsetDays: 1,
        },
        {
          title: "Pre-pour hold point",
          isQualityCheckpoint: true,
          evidenceRequired: true,
          evidenceRequirement: "The consultant's release note.",
          signoffParties: [
            { partyType: "user", label: "Site engineer" },
            { partyType: "external", label: "Consulting engineer" },
          ],
          dueOffsetDays: 2,
        },
        {
          title: "Pour and record cube samples",
          signoffParties: [{ partyType: "user", label: "Site engineer" }],
          dueOffsetDays: 3,
        },
      ],
    });
    expect(res.statusCode).toBe(201);
    templateId = res.json().id;
    expect(res.json().activities).toHaveLength(3);

    const list = await get(`/correspondence/action-plan-templates?projectId=${projectId}`);
    expect(list.json().items.find((t: { id: string }) => t.id === templateId).activityCount).toBe(3);
  });

  it("rejects a duplicate key and refuses an ordinary member the write", async () => {
    const dup = await post("/correspondence/action-plan-templates", {
      key: "concrete_pour",
      name: "Again",
    });
    expect(dup.statusCode).toBe(409);
    const viewer = await registerActor(app);
    await app.db
      .insert(companyMemberships)
      .values({ id: newId("cm"), companyId: owner.companyId, userId: viewer.userId, role: "member" });
    const res = await post(
      "/correspondence/action-plan-templates",
      { key: "nope", name: "Nope" },
      { authorization: viewer.headers["authorization"]!, "x-company-id": owner.companyId },
    );
    expect(res.statusCode).toBe(403);
  });

  it("bumps the version when the activity list is replaced", async () => {
    const created = await post("/correspondence/action-plan-templates", {
      key: "versioned",
      name: "Versioned",
      activities: [{ title: "One" }],
    });
    const id = created.json().id as string;
    const updated = await patch(`/correspondence/action-plan-templates/${id}`, {
      activities: [{ title: "One" }, { title: "Two" }],
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().version).toBe(2);
    const detail = await get(`/correspondence/action-plan-templates/${id}`);
    expect(detail.json().activities).toHaveLength(2);
  });

  it("is invisible to another tenant", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/correspondence/action-plan-templates",
      headers: stranger.headers,
    });
    expect(res.json().items).toEqual([]);
  });
});

/* ================================================================== */
/* Plans                                                               */
/* ================================================================== */

let planId: string;
let activityIds: string[] = [];

describe("action plans (#452–#456)", () => {
  it("instantiates from a template, anchored to a location, with dated activities", async () => {
    const res = await post(`/projects/${projectId}/correspondence/action-plans`, {
      templateId,
      anchor: "location",
      locationId,
      ownerId: engineer.userId,
      startDate: today,
      dueDate: addDaysISO(today, 5),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    planId = body.id;
    activityIds = body.activities.map((a: { id: string }) => a.id);
    expect(body.reference).toMatch(/^AP-\d{3}$/);
    expect(body.title).toBe("Concrete pour readiness");
    expect(body.templateVersion).toBe(1);
    expect(body.activities).toHaveLength(3);
    expect(body.activities[0].dueDate).toBe(addDaysISO(today, 1));
    expect(body.activities[1].signoffRequiredCount).toBe(2);
    expect(body.signoffs).toHaveLength(4);
  });

  it("refuses an anchor to another project's location or task", async () => {
    const res = await post(`/projects/${projectId}/correspondence/action-plans`, {
      templateId,
      anchor: "location",
      locationId: "loc_nope",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("not found in this project");
  });

  it("refuses to activate a plan with no activities", async () => {
    const empty = await post(`/projects/${projectId}/correspondence/action-plans`, {
      title: "Nothing to do",
    });
    const res = await post(
      `/projects/${projectId}/correspondence/action-plans/${empty.json().id}/activate`,
      {},
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("no activities");
  });

  it("activates and reports progress as null-free but honest", async () => {
    const res = await post(
      `/projects/${projectId}/correspondence/action-plans/${planId}/activate`,
      {},
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("active");
    expect(res.json().progress.percent).toBe(0);
    expect(res.json().progress.nextActivity.seq).toBe(1);
  });

  it("refuses a sign-off before the required evidence exists (#449)", async () => {
    const detail = await get(`/projects/${projectId}/correspondence/action-plans/${planId}`);
    const first = detail.json().activities[0];
    expect(first.readiness.ready).toBe(false);
    const res = await post(
      `/projects/${projectId}/correspondence/activities/${first.id}/signoffs/${first.signoffs[0].id}/sign`,
      {},
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("requires evidence");
  });

  it("refuses evidence submission with no files when the activity demands them", async () => {
    const res = await post(
      `/projects/${projectId}/correspondence/activities/${activityIds[0]}/evidence`,
      { fileIds: [] },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("requires evidence");
  });

  it("accepts evidence and then a sign-off, closing the first activity", async () => {
    const evidence = await post(
      `/projects/${projectId}/correspondence/activities/${activityIds[0]}/evidence`,
      { fileIds: [fileId], note: "Cage checked against drawing A-201." },
      engineer.headers,
    );
    expect(evidence.statusCode).toBe(200);
    expect(evidence.json().status).toBe("evidence_submitted");

    const detail = await get(`/projects/${projectId}/correspondence/action-plans/${planId}`);
    const first = detail.json().activities[0];
    expect(first.readiness.ready).toBe(true);
    const signed = await post(
      `/projects/${projectId}/correspondence/activities/${first.id}/signoffs/${first.signoffs[0].id}/sign`,
      { signerName: "A. Engineer" },
      inspector.headers,
    );
    expect(signed.statusCode).toBe(200);
    expect(signed.json().activity.status).toBe("signed_off");
    expect(signed.json().progress.percent).toBeCloseTo(33.3, 1);
  });

  it("blocks every activity behind an unsigned quality checkpoint (#456)", async () => {
    // Activity 3 sits behind the checkpoint at seq 2.
    const res = await post(
      `/projects/${projectId}/correspondence/activities/${activityIds[2]}/evidence`,
      { fileIds: [] },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("quality checkpoint 2");

    const detail = await get(`/projects/${projectId}/correspondence/action-plans/${planId}`);
    const third = detail.json().activities[2];
    expect(third.readiness.ready).toBe(false);
    const signAttempt = await post(
      `/projects/${projectId}/correspondence/activities/${third.id}/signoffs/${third.signoffs[0].id}/sign`,
      {},
      inspector.headers,
    );
    expect(signAttempt.statusCode).toBe(409);
  });

  it("needs every required signature on a multi-party checkpoint (#452)", async () => {
    await post(
      `/projects/${projectId}/correspondence/activities/${activityIds[1]}/evidence`,
      { fileIds: [fileId] },
      engineer.headers,
    );
    const detail = await get(`/projects/${projectId}/correspondence/action-plans/${planId}`);
    const checkpoint = detail.json().activities[1];
    expect(checkpoint.signoffs).toHaveLength(2);

    const first = await post(
      `/projects/${projectId}/correspondence/activities/${checkpoint.id}/signoffs/${checkpoint.signoffs[0].id}/sign`,
      {},
      inspector.headers,
    );
    expect(first.statusCode).toBe(200);
    expect(first.json().activity.status).toBe("evidence_submitted");
    expect(first.json().planStatus).toBe("active");

    const second = await post(
      `/projects/${projectId}/correspondence/activities/${checkpoint.id}/signoffs/${checkpoint.signoffs[1].id}/sign`,
      { signerName: "Consulting engineer" },
      owner.headers,
    );
    expect(second.statusCode).toBe(200);
    expect(second.json().activity.status).toBe("signed_off");
  });

  it("opens the gate once the checkpoint is signed", async () => {
    const detail = await get(`/projects/${projectId}/correspondence/action-plans/${planId}`);
    const third = detail.json().activities[2];
    expect(third.readiness.ready).toBe(true);
    const signed = await post(
      `/projects/${projectId}/correspondence/activities/${third.id}/signoffs/${third.signoffs[0].id}/sign`,
      {},
      inspector.headers,
    );
    expect(signed.statusCode).toBe(200);
    expect(signed.json().progress.percent).toBe(100);
    expect(signed.json().planStatus).toBe("completed");
  });

  it("produces a completion report with no gaps once everything is closed (#455)", async () => {
    const res = await get(
      `/projects/${projectId}/correspondence/action-plans/${planId}/report`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().complete).toBe(true);
    expect(res.json().gaps).toEqual([]);
    expect(res.json().rows).toHaveLength(3);
  });

  it("refuses to edit an activity that has been signed off", async () => {
    const res = await patch(
      `/projects/${projectId}/correspondence/activities/${activityIds[0]}`,
      { title: "Rewritten after the fact" },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("signed off");
  });
});

describe("waivers and segregation of duties", () => {
  let waiverPlanId: string;
  let waiverActivityId: string;

  beforeAll(async () => {
    const plan = await post(`/projects/${projectId}/correspondence/action-plans`, {
      title: "Ad-hoc readiness plan",
      anchor: "schedule_task",
      scheduleTaskId: taskId,
      activities: [
        {
          title: "Confirm the temporary works design",
          evidenceRequired: true,
          evidenceRequirement: "The TWC's signed design check.",
          signoffParties: [
            { partyType: "user", label: "Temporary works coordinator" },
            { partyType: "user", label: "Project manager" },
          ],
        },
      ],
    });
    waiverPlanId = plan.json().id;
    waiverActivityId = plan.json().activities[0].id;
    await post(`/projects/${projectId}/correspondence/action-plans/${waiverPlanId}/activate`, {});
  }, 180_000);

  it("does not let the person who submitted the evidence be the only signatory", async () => {
    await post(
      `/projects/${projectId}/correspondence/activities/${waiverActivityId}/evidence`,
      { fileIds: [fileId] },
      engineer.headers,
    );
    const detail = await get(
      `/projects/${projectId}/correspondence/action-plans/${waiverPlanId}`,
    );
    const activity = detail.json().activities[0];
    const first = await post(
      `/projects/${projectId}/correspondence/activities/${waiverActivityId}/signoffs/${activity.signoffs[0].id}/sign`,
      {},
      engineer.headers,
    );
    expect(first.statusCode).toBe(200);
    const second = await post(
      `/projects/${projectId}/correspondence/activities/${waiverActivityId}/signoffs/${activity.signoffs[1].id}/sign`,
      {},
      engineer.headers,
    );
    expect(second.statusCode).toBe(403);
    expect(second.json().message).toContain("only signatory");
  });

  it("does not let the evidence submitter waive their own activity", async () => {
    const res = await post(
      `/projects/${projectId}/correspondence/activities/${waiverActivityId}/waive`,
      { reason: "Not needed after all" },
      engineer.headers,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("cannot waive");
  });

  it("lets someone else waive it and counts the waiver as closed, not done", async () => {
    const res = await post(
      `/projects/${projectId}/correspondence/activities/${waiverActivityId}/waive`,
      { reason: "Design superseded; the temporary works are no longer required." },
      inspector.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("waived");
    expect(res.json().progress.percent).toBe(100);
    expect(res.json().progress.reasons.some((r: string) => r.includes("waived rather than performed"))).toBe(
      true,
    );
  });

  it("blocks the activity when a signatory rejects", async () => {
    const plan = await post(`/projects/${projectId}/correspondence/action-plans`, {
      title: "Rejection path",
      activities: [{ title: "Do the thing", signoffParties: [{ partyType: "user", label: "PM" }] }],
    });
    const id = plan.json().id as string;
    const activityId = plan.json().activities[0].id as string;
    const signoffId = plan.json().signoffs[0].id as string;
    await post(`/projects/${projectId}/correspondence/action-plans/${id}/activate`, {});
    const rejected = await post(
      `/projects/${projectId}/correspondence/activities/${activityId}/signoffs/${signoffId}/sign`,
      { decision: "rejected", note: "Not to the standard required." },
      inspector.headers,
    );
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().activity.status).toBe("blocked");
    expect(rejected.json().planStatus).toBe("blocked");
  });
});

describe("overdue plan sweep (#454)", () => {
  it("raises exactly one signal for a plan with overdue activities", async () => {
    const plan = await post(`/projects/${projectId}/correspondence/action-plans`, {
      title: "Late readiness plan",
      startDate: addDaysISO(today, -20),
      activities: [
        { title: "Overdue check", dueOffsetDays: 1, signoffParties: [{ partyType: "user", label: "PM" }] },
        {
          title: "Overdue hold point",
          isQualityCheckpoint: true,
          dueOffsetDays: 2,
          signoffParties: [{ partyType: "user", label: "PM" }],
        },
      ],
    });
    const id = plan.json().id as string;
    await post(`/projects/${projectId}/correspondence/action-plans/${id}/activate`, {});

    const first = await post(`/projects/${projectId}/correspondence/sweeps/run`, {});
    expect(first.json().plans.raised).toBe(1);
    const second = await post(`/projects/${projectId}/correspondence/sweeps/run`, {});
    expect(second.json().plans.raised).toBe(0);

    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "correspondence_plan_overdue"),
        ),
      );
    expect(raised).toHaveLength(1);
    expect(raised[0]?.severity).toBe("high");
    expect(raised[0]?.explanation).toContain("quality checkpoint");

    const stored = (await app.db.select().from(actionPlans).where(eq(actionPlans.id, id)))[0];
    expect(stored?.progressPercent).toBe(0);
  });

  it("runs from the scheduler", async () => {
    const status = await app.scheduler.runNow("correspondence.plan-due");
    expect(status.state).toBe("succeeded");
  });

  it("counts overdue activities in the summary", async () => {
    const summary = await get(`/projects/${projectId}/correspondence/summary`);
    expect(summary.json().plans.overdueActivities).toBeGreaterThanOrEqual(2);
    expect(summary.json().plans.averageProgress.value).not.toBeNull();
  });
});

describe("tenant isolation", () => {
  it("refuses a stranger every plan route", async () => {
    const list = await get(`/projects/${projectId}/correspondence/action-plans`, stranger.headers);
    expect(list.statusCode).toBe(403);
    const detail = await get(
      `/projects/${projectId}/correspondence/action-plans/${planId}`,
      stranger.headers,
    );
    expect(detail.statusCode).toBe(403);
    const write = await post(
      `/projects/${projectId}/correspondence/action-plans`,
      { title: "Not yours" },
      stranger.headers,
    );
    expect(write.statusCode).toBe(403);
    const sign = await post(
      `/projects/${projectId}/correspondence/activities/${activityIds[0]}/waive`,
      { reason: "not yours" },
      stranger.headers,
    );
    expect(sign.statusCode).toBe(403);
  });

  it("hides a plan from a stranger's own project route", async () => {
    const otherProject = newId("prj");
    await app.db
      .insert(projects)
      .values({ id: otherProject, companyId: stranger.companyId, name: "Theirs", stage: "planning" });
    const res = await get(
      `/projects/${otherProject}/correspondence/action-plans/${planId}`,
      stranger.headers,
    );
    expect(res.statusCode).toBe(404);
  });
});
