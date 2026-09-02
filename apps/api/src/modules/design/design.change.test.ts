/**
 * Upstream change control — design change notices, per-discipline impact
 * assessment, computed authorisation, the freeze position stamped at
 * submission, entitlement attribution and the change event that follows (or
 * deliberately does not).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { changeEvents, companyMemberships, projects, signals } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { designModule } from "./index.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let approver: TestActor;
let stranger: TestActor;
let projectId: string;

function post(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload });
}
function patch(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload });
}
function get(url: string, headers = owner.headers) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers });
}
function del(url: string, headers = owner.headers) {
  return app.inject({ method: "DELETE", url: `/api/v1${url}`, headers });
}

const base = () => `/projects/${projectId}/design`;

async function makePackage(name: string) {
  const res = await post(`${base()}/packages`, { name, discipline: "multi_discipline", stageKey: "stage_4" });
  return res.json() as { id: string; reference: string };
}

async function makeNotice(over: Record<string, unknown> = {}) {
  const res = await post(`${base()}/change-notices`, {
    title: "Move the plant room to level 3",
    classification: "design_change",
    originator: "client",
    ...over,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; reference: string; status: string; requiredAuthorisation: string };
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  if (!app.scheduler.has("design.deliverables")) await app.register(designModule, { prefix: "/api/v1" });
  owner = await registerActor(app);

  const second = await registerActor(app);
  await app.db
    .insert(companyMemberships)
    .values({ id: newId("cm"), companyId: owner.companyId, userId: second.userId, role: "admin" });
  approver = {
    ...second,
    companyId: owner.companyId,
    headers: { authorization: second.headers["authorization"]!, "x-company-id": owner.companyId },
  };

  stranger = await registerActor(app);

  projectId = newId("prj");
  await app.db
    .insert(projects)
    .values({ id: projectId, companyId: owner.companyId, name: "Design — change control", stage: "design" });
});

afterAll(async () => {
  await built.close();
});

/* ================================================================== */

describe("impact assessment", () => {
  let noticeId: string;

  it("registers a notice in draft with no assessed position", async () => {
    const notice = await makeNotice();
    noticeId = notice.id;
    expect(notice.reference).toMatch(/^DCN-\d{3}$/);
    expect(notice.status).toBe("draft");
    const detail = (await get(`${base()}/change-notices/${noticeId}`)).json() as {
      rollup: { cost: number | null; costReasons: string[]; timeDays: number | null };
      authorisation: { level: string };
    };
    expect(detail.rollup.cost).toBeNull();
    expect(detail.rollup.costReasons.join(" ")).toContain("No discipline has assessed");
    expect(detail.authorisation.level).toBe("project_manager");
  });

  it("rolls up per-discipline impacts, taking the longest time not the sum", async () => {
    const a = await post(`${base()}/change-notices/${noticeId}/impacts`, {
      discipline: "mechanical",
      summary: "Plant re-layout and duct rerouting",
      costImpact: 40_000,
      currency: "GBP",
      timeImpactDays: 8,
      reworkHours: 120,
    });
    expect(a.statusCode).toBe(201);
    const b = await post(`${base()}/change-notices/${noticeId}/impacts`, {
      discipline: "structural",
      summary: "Slab openings and additional steel",
      costImpact: 25_000,
      currency: "GBP",
      timeImpactDays: 5,
      reworkHours: 60,
    });
    expect(b.statusCode).toBe(201);
    const body = b.json() as { rollup: { cost: number; timeDays: number; reworkHours: number } };
    expect(body.rollup.cost).toBe(65_000);
    expect(body.rollup.timeDays).toBe(8);
    expect(body.rollup.reworkHours).toBe(180);
  });

  it("refuses a second assessment from the same discipline", async () => {
    const res = await post(`${base()}/change-notices/${noticeId}/impacts`, {
      discipline: "mechanical",
      summary: "Second thoughts",
      costImpact: 1,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("already assessed");
  });

  it("escalates the required authorisation with the assessed money", async () => {
    const detail = (await get(`${base()}/change-notices/${noticeId}`)).json() as {
      authorisation: { level: string; reasons: string[] };
    };
    expect(detail.authorisation.level).toBe("project_manager");
    await post(`${base()}/change-notices/${noticeId}/impacts`, {
      discipline: "facade",
      summary: "Curtain wall penetrations",
      costImpact: 200_000,
      currency: "GBP",
      timeImpactDays: 5,
    });
    const after = (await get(`${base()}/change-notices/${noticeId}`)).json() as {
      authorisation: { level: string };
      rollup: { cost: number };
    };
    expect(after.rollup.cost).toBe(265_000);
    expect(after.authorisation.level).toBe("client");
  });

  it("removes an assessment and recomputes the position", async () => {
    const detail = (await get(`${base()}/change-notices/${noticeId}`)).json() as {
      impacts: Array<{ id: string; discipline: string }>;
    };
    const facade = detail.impacts.find((i) => i.discipline === "facade")!;
    const res = await del(`${base()}/change-notices/${noticeId}/impacts/${facade.id}`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { rollup: { cost: number } }).rollup.cost).toBe(65_000);
  });
});

/* ================================================================== */

describe("currency honesty", () => {
  it("never adds cost across currencies and says so", async () => {
    const notice = await makeNotice({ title: "Multi-currency change" });
    await post(`${base()}/change-notices/${notice.id}/impacts`, {
      discipline: "structural",
      summary: "UK steelwork",
      costImpact: 30_000,
      currency: "GBP",
    });
    await post(`${base()}/change-notices/${notice.id}/impacts`, {
      discipline: "mechanical",
      summary: "Imported plant",
      costImpact: 50_000,
      currency: "EUR",
    });
    const detail = (await get(`${base()}/change-notices/${notice.id}`)).json() as {
      rollup: { cost: number | null; costByCurrency: Record<string, number>; costReasons: string[] };
    };
    expect(detail.rollup.cost).toBeNull();
    expect(detail.rollup.costByCurrency).toEqual({ GBP: 30_000, EUR: 50_000 });
    expect(detail.rollup.costReasons.join(" ")).toContain("never added");
  });
});

/* ================================================================== */

describe("freeze position and post-freeze signal", () => {
  it("stamps the freeze position at submission and raises one signal", async () => {
    const pkg = await makePackage("Frozen for change control");
    await post(`${base()}/freezes`, {
      scope: "package",
      packageId: pkg.id,
      title: "Stage 4 freeze",
      requiredAuthorisation: "board",
    });
    const notice = await makeNotice({ title: "Post-freeze change", packageId: pkg.id });
    await post(`${base()}/change-notices/${notice.id}/impacts`, {
      discipline: "architectural",
      summary: "Re-plan level 3",
      costImpact: 5_000,
      currency: "GBP",
      timeImpactDays: 2,
    });
    const submitted = await post(`${base()}/change-notices/${notice.id}/submit`, {});
    expect(submitted.statusCode).toBe(200);
    const body = submitted.json() as {
      isPostFreeze: number;
      requiredAuthorisation: string;
      freeze: { isPostFreeze: boolean; basis: string };
      signalId: string | null;
    };
    expect(body.isPostFreeze).toBe(1);
    expect(body.requiredAuthorisation).toBe("board");
    expect(body.freeze.basis).toContain("package freeze");
    expect(body.signalId).toBeTruthy();

    const raised = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, "design_post_freeze_change")));
    expect(raised).toHaveLength(1);
    expect(raised[0]?.title).toContain("Post-freeze");
  });

  it("keeps the stamped position after the freeze is lifted", async () => {
    const listed = (await get(`${base()}/change-notices?postFreeze=true`)).json() as {
      items: Array<{ id: string; isPostFreeze: number; packageId: string | null }>;
    };
    const notice = listed.items[0]!;
    const freezes = (await get(`${base()}/freezes?status=active`)).json() as { items: Array<{ id: string }> };
    for (const freeze of freezes.items) {
      await post(`${base()}/freezes/${freeze.id}/lift`, { reason: "Change accepted" });
    }
    const detail = (await get(`${base()}/change-notices/${notice.id}`)).json() as {
      isPostFreeze: number;
      freeze: { isPostFreeze: boolean };
    };
    expect(detail.isPostFreeze).toBe(1);
    expect(detail.freeze.isPostFreeze).toBe(true);
  });

  it("does not treat a change outside any freeze as post-freeze", async () => {
    const notice = await makeNotice({ title: "Unfrozen change" });
    await post(`${base()}/change-notices/${notice.id}/impacts`, {
      discipline: "electrical",
      summary: "Containment change",
      costImpact: 1_000,
      currency: "GBP",
    });
    const submitted = await post(`${base()}/change-notices/${notice.id}/submit`, {});
    expect((submitted.json() as { isPostFreeze: number }).isPostFreeze).toBe(0);
    expect((submitted.json() as { signalId: string | null }).signalId).toBeNull();
  });
});

/* ================================================================== */

describe("approval", () => {
  let noticeId: string;

  beforeAll(async () => {
    const notice = await makeNotice({ title: "For approval" });
    noticeId = notice.id;
    await post(`${base()}/change-notices/${noticeId}/impacts`, {
      discipline: "architectural",
      summary: "Re-plan",
      costImpact: 15_000,
      currency: "GBP",
      timeImpactDays: 3,
    });
    await post(`${base()}/change-notices/${noticeId}/submit`, {});
  });

  it("refuses approval by the requester", async () => {
    const res = await post(`${base()}/change-notices/${noticeId}/approve`, { authorisationLevel: "client" });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("other than the person who raised it");
  });

  it("refuses approval below the computed level and quotes the basis", async () => {
    const res = await post(
      `${base()}/change-notices/${noticeId}/approve`,
      { authorisationLevel: "design_lead" },
      approver.headers,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("project manager authorisation");
  });

  it("approves at or above the computed level", async () => {
    const res = await post(
      `${base()}/change-notices/${noticeId}/approve`,
      { authorisationLevel: "project_manager", note: "Within the risk allowance" },
      approver.headers,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; approvedBy: string };
    expect(body.status).toBe("approved");
    expect(body.approvedBy).toBe(approver.userId);
  });

  it("refuses to approve a change nobody has assessed", async () => {
    const notice = await makeNotice({ title: "Unassessed" });
    await post(`${base()}/change-notices/${notice.id}/submit`, {});
    const res = await post(
      `${base()}/change-notices/${notice.id}/approve`,
      { authorisationLevel: "board" },
      approver.headers,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("No discipline has assessed");
  });

  it("refuses to edit a submitted notice in place", async () => {
    const res = await patch(`${base()}/change-notices/${noticeId}`, { title: "renamed" });
    expect(res.statusCode).toBe(409);
  });

  it("refuses a rejection by the requester", async () => {
    const notice = await makeNotice({ title: "Self reject" });
    await post(`${base()}/change-notices/${notice.id}/impacts`, {
      discipline: "civil",
      summary: "Drainage",
      costImpact: 100,
      currency: "GBP",
    });
    await post(`${base()}/change-notices/${notice.id}/submit`, {});
    const res = await post(`${base()}/change-notices/${notice.id}/reject`, { reason: "no" });
    expect(res.statusCode).toBe(403);
    const proper = await post(
      `${base()}/change-notices/${notice.id}/reject`,
      { reason: "Not supported by the brief" },
      approver.headers,
    );
    expect(proper.statusCode).toBe(200);
    expect((proper.json() as { status: string }).status).toBe("rejected");
  });
});

/* ================================================================== */

describe("implementation and entitlement", () => {
  async function approvedNotice(over: Record<string, unknown>, impacts: Array<Record<string, unknown>>) {
    const notice = await makeNotice(over);
    for (const impact of impacts) {
      const res = await post(`${base()}/change-notices/${notice.id}/impacts`, impact);
      expect(res.statusCode).toBe(201);
    }
    await post(`${base()}/change-notices/${notice.id}/submit`, {});
    const detail = (await get(`${base()}/change-notices/${notice.id}`)).json() as {
      requiredAuthorisation: string;
    };
    const approved = await post(
      `${base()}/change-notices/${notice.id}/approve`,
      { authorisationLevel: detail.requiredAuthorisation },
      approver.headers,
    );
    expect(approved.statusCode).toBe(200);
    return notice;
  }

  it("raises a change event for a client-originated design change", async () => {
    const notice = await approvedNotice({ title: "Client betterment", originator: "client" }, [
      { discipline: "architectural", summary: "New finishes", costImpact: 60_000, currency: "GBP", timeImpactDays: 6 },
    ]);
    const res = await post(`${base()}/change-notices/${notice.id}/implement`, { raiseChangeEvent: true });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; changeEventId: string | null; entitlement: { carriesEntitlement: boolean } };
    expect(body.status).toBe("implemented");
    expect(body.changeEventId).toBeTruthy();
    expect(body.entitlement.carriesEntitlement).toBe(true);

    const [event] = await app.db
      .select()
      .from(changeEvents)
      .where(and(eq(changeEvents.id, body.changeEventId!), eq(changeEvents.projectId, projectId)));
    expect(event?.estimatedCost).toBe(60_000);
    expect(event?.scheduleImpactDays).toBe(6);
    expect(event?.eventType).toBe("design_change");
    expect(event?.reason).toBe("client_request");
    expect(event?.originId).toBe(notice.id);
  });

  it("refuses to turn a designer's own change into an owner change event", async () => {
    const notice = await approvedNotice({ title: "Coordination error", originator: "designer" }, [
      { discipline: "structural", summary: "Rework", costImpact: 20_000, currency: "GBP" },
    ]);
    const res = await post(`${base()}/change-notices/${notice.id}/implement`, { raiseChangeEvent: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("carries no entitlement");
    const without = await post(`${base()}/change-notices/${notice.id}/implement`, { raiseChangeEvent: false });
    expect(without.statusCode).toBe(200);
    expect((without.json() as { changeEventId: string | null }).changeEventId).toBeNull();
  });

  it("refuses a change event when the impact spans currencies", async () => {
    const notice = await approvedNotice({ title: "Cross-currency implementation", originator: "client" }, [
      { discipline: "structural", summary: "UK", costImpact: 10_000, currency: "GBP" },
      { discipline: "mechanical", summary: "Imported", costImpact: 10_000, currency: "EUR" },
    ]);
    const res = await post(`${base()}/change-notices/${notice.id}/implement`, { raiseChangeEvent: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("currencies");
  });

  it("refuses implementation of an unapproved notice", async () => {
    const notice = await makeNotice({ title: "Not approved" });
    const res = await post(`${base()}/change-notices/${notice.id}/implement`, {});
    expect(res.statusCode).toBe(409);
  });

  it("withdraws a notice and refuses to withdraw an implemented one", async () => {
    const notice = await makeNotice({ title: "Withdrawn" });
    const res = await post(`${base()}/change-notices/${notice.id}/withdraw`, { reason: "Superseded by DCN-002" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("withdrawn");
    const again = await post(`${base()}/change-notices/${notice.id}/withdraw`, { reason: "again" });
    expect(again.statusCode).toBe(409);
  });
});

/* ================================================================== */

describe("change frequency", () => {
  it("flags a churning package once per month and not twice", async () => {
    const pkg = await makePackage("Churning package");
    for (let i = 0; i < 12; i += 1) {
      const notice = await makeNotice({ title: `Churn ${i}`, packageId: pkg.id });
      await post(`${base()}/change-notices/${notice.id}/impacts`, {
        discipline: "architectural",
        summary: "Small change",
        costImpact: 100,
        currency: "GBP",
      });
      await post(`${base()}/change-notices/${notice.id}/submit`, {});
    }
    const first = await post(`${base()}/change-notices/frequency`, {});
    expect(first.statusCode).toBe(200);
    const body = first.json() as { flagged: number; signalsRaised: number };
    expect(body.flagged).toBeGreaterThanOrEqual(1);
    expect(body.signalsRaised).toBeGreaterThanOrEqual(1);

    const second = await post(`${base()}/change-notices/frequency`, {});
    expect((second.json() as { signalsRaised: number }).signalsRaised).toBe(0);
  });

  it("runs the same work from the scheduler job", async () => {
    const result = await app.scheduler.runNow("design.change-control");
    expect(result.state).toBe("succeeded");
  });
});

/* ================================================================== */

describe("tenant isolation", () => {
  it("refuses every change-control route to another company", async () => {
    expect((await get(`${base()}/change-notices`, stranger.headers)).statusCode).toBe(403);
    expect((await post(`${base()}/change-notices`, { title: "x" }, stranger.headers)).statusCode).toBe(403);
    const listed = (await get(`${base()}/change-notices`)).json() as { items: Array<{ id: string }> };
    const id = listed.items[0]!.id;
    expect((await get(`${base()}/change-notices/${id}`, stranger.headers)).statusCode).toBe(403);
    expect((await post(`${base()}/change-notices/${id}/submit`, {}, stranger.headers)).statusCode).toBe(403);
  });

  it("does not find a notice from another project of the same company", async () => {
    const otherProject = newId("prj");
    await app.db
      .insert(projects)
      .values({ id: otherProject, companyId: owner.companyId, name: "Other design project", stage: "design" });
    const listed = (await get(`${base()}/change-notices`)).json() as { items: Array<{ id: string }> };
    const id = listed.items[0]!.id;
    const res = await get(`/projects/${otherProject}/design/change-notices/${id}`);
    expect(res.statusCode).toBe(404);
  });
});
