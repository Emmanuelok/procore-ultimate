/**
 * Permits to work, confined-space entries, exclusion zones, lone working and
 * the scheduler sweeps that watch all three.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  companyMemberships,
  notifications,
  projectMemberships,
  projects,
  signals,
  siteExclusionZones,
  siteLoneWorkerSessions,
  sitePermitEntries,
  sitePermits,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { siteModule } from "./index.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let approver: TestActor;
let viewerHeaders: Record<string, string>;
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

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const ahead = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

async function siteSignals(detector: string) {
  return app.db.select().from(signals).where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, detector)));
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  if (!app.scheduler.has("site.lone-worker")) await app.register(siteModule, { prefix: "/api/v1" });
  owner = await registerActor(app);

  approver = await registerActor(app);
  await app.db.insert(companyMemberships).values({ id: newId("cm"), companyId: owner.companyId, userId: approver.userId, role: "admin" });
  approver = { ...approver, companyId: owner.companyId, headers: { authorization: approver.headers["authorization"]!, "x-company-id": owner.companyId } };

  const viewer = await registerActor(app);
  await app.db.insert(companyMemberships).values({ id: newId("cm"), companyId: owner.companyId, userId: viewer.userId, role: "member" });
  viewerHeaders = { authorization: viewer.headers["authorization"]!, "x-company-id": owner.companyId };

  stranger = await registerActor(app);

  projectId = newId("prj");
  await app.db.insert(projects).values({ id: projectId, companyId: owner.companyId, name: "Site — permits", stage: "course_of_construction" });
  await app.db.insert(projectMemberships).values({ id: newId("pm"), companyId: owner.companyId, projectId, userId: viewer.userId, templateKey: "read_only" });
});

afterAll(async () => {
  await built.close();
});

const base = () => `/projects/${projectId}/site`;

describe("permit lifecycle and segregation of duties", () => {
  let permitId: string;

  it("creates a hot-work permit in draft with a reference", async () => {
    const res = await post(`${base()}/permits`, {
      permitType: "hot_work",
      title: "Welding to L3 steel",
      locationDescription: "Level 3, grid C4",
      validFrom: ago(30),
      validTo: ahead(240),
      precautions: [
        { item: "Extinguisher present", required: true, done: false },
        { item: "Combustibles removed", required: true, done: false },
      ],
      fireWatchMinutes: 60,
    });
    expect(res.statusCode).toBe(201);
    permitId = res.json().id;
    expect(res.json().status).toBe("draft");
    expect(res.json().reference).toMatch(/^PTW-\d{3}$/);
  });

  it("refuses a validity window that ends before it begins", async () => {
    const res = await post(`${base()}/permits`, {
      permitType: "hot_work",
      title: "Bad window",
      validFrom: ahead(240),
      validTo: ago(30),
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses self-approval", async () => {
    expect((await post(`${base()}/permits/${permitId}/request`, {})).json().status).toBe("requested");
    const res = await post(`${base()}/permits/${permitId}/approve`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("other than the person who requested it");
  });

  it("approves with a second person and warns about outstanding precautions", async () => {
    const res = await post(`${base()}/permits/${permitId}/approve`, {}, approver.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("approved");
    expect(res.json().warnings.join(" ")).toContain("Extinguisher present");
    const notified = await app.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.companyId, owner.companyId), eq(notifications.userId, owner.userId), eq(notifications.recordId, permitId)));
    expect(notified.length).toBeGreaterThan(0);
  });

  it("refuses activation while a required precaution is outstanding", async () => {
    const res = await post(`${base()}/permits/${permitId}/activate`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("outstanding");
  });

  it("activates once the precautions are ticked", async () => {
    const res = await post(`${base()}/permits/${permitId}/activate`, {
      precautions: [
        { item: "Extinguisher present", required: true, done: true },
        { item: "Combustibles removed", required: true, done: true },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("active");
  });

  it("refuses to edit the terms of an issued permit", async () => {
    const res = await patch(`${base()}/permits/${permitId}`, { title: "Something else" });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("not editable");
  });

  it("refuses to close hot work before the fire watch is recorded", async () => {
    const res = await post(`${base()}/permits/${permitId}/close`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("fire watch");
  });

  it("closes once the fire watch is recorded", async () => {
    expect((await post(`${base()}/permits/${permitId}/fire-watch`, {})).statusCode).toBe(200);
    const res = await post(`${base()}/permits/${permitId}/close`, { notes: "Area left clear" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("closed");
  });

  it("shows the allowed transitions with their reasons on the detail view", async () => {
    const res = await get(`${base()}/permits/${permitId}`);
    const activate = res.json().transitions.find((t: { action: string }) => t.action === "activate");
    expect(activate.allowed).toBe(false);
    expect(activate.reason).toContain("cannot be");
  });
});

describe("excavation permits require a utility survey", () => {
  it("refuses activation without one and allows it with one", async () => {
    const created = await post(`${base()}/permits`, {
      permitType: "excavation",
      title: "Trench for drainage",
      validFrom: ago(10),
      validTo: ahead(600),
    });
    const id = created.json().id;
    await post(`${base()}/permits/${id}/request`, {});
    await post(`${base()}/permits/${id}/approve`, {}, approver.headers);
    const refused = await post(`${base()}/permits/${id}/activate`, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toContain("utility survey");

    const scan = await post(`${base()}/scans`, { name: "GPR sweep", method: "gpr" });
    await patch(`${base()}/permits/${id}`, {});
    // the permit is approved so PATCH is refused; set the scan on a new permit
    const second = await post(`${base()}/permits`, {
      permitType: "excavation",
      title: "Trench 2",
      validFrom: ago(10),
      validTo: ahead(600),
      utilityScanId: scan.json().id,
    });
    const id2 = second.json().id;
    await post(`${base()}/permits/${id2}/request`, {});
    await post(`${base()}/permits/${id2}/approve`, {}, approver.headers);
    expect((await post(`${base()}/permits/${id2}/activate`, {})).statusCode).toBe(200);
  });
});

describe("confined-space entries", () => {
  let permitId: string;
  let entryId: string;

  it("refuses an entry under a permit that is not active", async () => {
    const created = await post(`${base()}/permits`, {
      permitType: "confined_space",
      title: "Tank inspection",
      validFrom: ago(10),
      validTo: ahead(600),
      maxOccupancy: 1,
    });
    permitId = created.json().id;
    const res = await post(`${base()}/permits/${permitId}/entries`, { personName: "Ivy Shaw", expectedDurationMinutes: 30 });
    expect(res.statusCode).toBe(409);
    await post(`${base()}/permits/${permitId}/request`, {});
    await post(`${base()}/permits/${permitId}/approve`, {}, approver.headers);
    await post(`${base()}/permits/${permitId}/activate`, {});
  });

  it("records an entry with an expected exit", async () => {
    const res = await post(`${base()}/permits/${permitId}/entries`, {
      personName: "Ivy Shaw",
      attendantName: "Jon Pike",
      enteredAt: ago(90),
      expectedDurationMinutes: 30,
    });
    expect(res.statusCode).toBe(201);
    entryId = res.json().id;
    expect(res.json().status).toBe("inside");
  });

  it("enforces the permitted occupancy", async () => {
    const res = await post(`${base()}/permits/${permitId}/entries`, { personName: "Kim Rowe", expectedDurationMinutes: 30 });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("allows 1 person");
  });

  it("refuses to close a permit with somebody still inside", async () => {
    const res = await post(`${base()}/permits/${permitId}/close`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("still recorded inside");
  });

  it("records gas readings against the entry", async () => {
    const res = await post(`${base()}/permits/${permitId}/entries/${entryId}/gas-reading`, {
      gas: "O2",
      value: 20.8,
      unit: "%",
      safe: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().gasReadings).toHaveLength(1);
  });

  it("the sweep marks an overdue entry, tells someone and raises exactly one signal", async () => {
    await app.scheduler.runNow("site.confined-space");
    const rows = await app.db.select().from(sitePermitEntries).where(eq(sitePermitEntries.id, entryId));
    expect(rows[0]?.status).toBe("overdue");
    const raised = await siteSignals("site_confined_space_overdue");
    expect(raised).toHaveLength(1);
    expect(raised[0]?.title).toContain("Ivy Shaw");

    await app.scheduler.runNow("site.confined-space");
    expect(await siteSignals("site_confined_space_overdue")).toHaveLength(1);
  });

  it("records the exit and then lets the permit close", async () => {
    const exit = await post(`${base()}/permits/${permitId}/entries/${entryId}/exit`, {});
    expect(exit.statusCode).toBe(200);
    expect(exit.json().status).toBe("exited");
    expect((await post(`${base()}/permits/${permitId}/entries/${entryId}/exit`, {})).statusCode).toBe(404);
    expect((await post(`${base()}/permits/${permitId}/close`, {})).statusCode).toBe(200);
  });
});

describe("permit expiry sweep", () => {
  it("expires an open permit whose window closed and raises one signal", async () => {
    const created = await post(`${base()}/permits`, {
      permitType: "working_at_height",
      title: "Edge protection",
      validFrom: ago(600),
      validTo: ahead(2),
    });
    const id = created.json().id;
    await post(`${base()}/permits/${id}/request`, {});
    await post(`${base()}/permits/${id}/approve`, {}, approver.headers);
    await post(`${base()}/permits/${id}/activate`, {});

    // Move the window into the past directly; the sweep reads the column.
    await app.db
      .update(sitePermits)
      .set({ validTo: ago(5) })
      .where(eq(sitePermits.id, id));

    await app.scheduler.runNow("site.permit-expiry");
    const rows = await app.db.select().from(sitePermits).where(eq(sitePermits.id, id));
    expect(rows[0]?.status).toBe("expired");
    expect(await siteSignals("site_permit_expired_open")).toHaveLength(1);

    await app.scheduler.runNow("site.permit-expiry");
    expect(await siteSignals("site_permit_expired_open")).toHaveLength(1);
  });
});

describe("exclusion zones", () => {
  let zoneId: string;

  it("refuses a zone with neither a ring nor a radius", async () => {
    const res = await post(`${base()}/zones`, { name: "Nothing", kind: "lifting" });
    expect(res.statusCode).toBe(400);
  });

  it("creates a ring zone and answers point-in-polygon", async () => {
    const created = await post(`${base()}/zones`, {
      name: "Crane lift zone",
      kind: "lifting",
      ring: [
        [0, 0],
        [0, 0.001],
        [0.001, 0.001],
        [0.001, 0],
      ],
      activeFrom: ago(5),
      activeTo: ahead(120),
    });
    expect(created.statusCode).toBe(201);
    zoneId = created.json().id;
    expect(created.json().status).toBe("active");

    const inside = await post(`${base()}/zones/check`, { lat: 0.0005, lon: 0.0005 });
    expect(inside.json().inside).toBe(true);
    expect(inside.json().hits[0].zoneName).toBe("Crane lift zone");
    expect(inside.json().hits[0].kind).toBe("lifting");

    const outside = await post(`${base()}/zones/check`, { lat: 5, lon: 5 });
    expect(outside.json().inside).toBe(false);
  });

  it("supports a radius zone", async () => {
    await post(`${base()}/zones`, {
      name: "Blast radius",
      kind: "blasting",
      centreLat: 10,
      centreLon: 10,
      radiusM: 500,
      activeFrom: ago(5),
    });
    const res = await post(`${base()}/zones/check`, { lat: 10.001, lon: 10 });
    expect(res.json().hits[0].test).toBe("radius");
    expect(res.json().hits[0].distanceM).toBeGreaterThan(0);
  });

  it("lifts a zone and stops matching it", async () => {
    expect((await post(`${base()}/zones/${zoneId}/lift`, {})).json().status).toBe("lifted");
    const after = await post(`${base()}/zones/check`, { lat: 0.0005, lon: 0.0005 });
    expect(after.json().inside).toBe(false);
    expect((await post(`${base()}/zones/${zoneId}/lift`, {})).statusCode).toBe(409);
  });

  it("the sweep lifts zones past their active window", async () => {
    const created = await post(`${base()}/zones`, {
      name: "Old zone",
      kind: "traffic",
      centreLat: 1,
      centreLon: 1,
      radiusM: 50,
      activeFrom: ago(600),
      activeTo: ago(30),
    });
    const id = created.json().id;
    await post(`${base()}/zones/${id}/activate`, {});
    // Activation stamps activeFrom = now and clears the past window, so put the
    // end of the window back into the past before sweeping.
    await app.db.update(siteExclusionZones).set({ activeTo: ago(10) }).where(eq(siteExclusionZones.id, id));
    await app.scheduler.runNow("site.exclusion-zones");
    const rows = await app.db.select().from(siteExclusionZones).where(eq(siteExclusionZones.id, id));
    expect(rows[0]?.status).toBe("lifted");
  });
});

describe("lone working", () => {
  let sessionId: string;

  it("starts a session with a next-due time", async () => {
    const res = await post(`${base()}/lone-workers`, {
      personName: "Mo Elias",
      activity: "Inspecting the roof plant",
      intervalMinutes: 15,
      startedAt: ago(60),
      contactName: "Control room",
      contactPhone: "555-0100",
    });
    expect(res.statusCode).toBe(201);
    sessionId = res.json().id;
    expect(res.json().status).toBe("active");
    expect(Date.parse(res.json().nextDueAt)).toBeLessThan(Date.now());
  });

  it("escalates a missed check-in exactly once and tells the watchers", async () => {
    await app.scheduler.runNow("site.lone-worker");
    const rows = await app.db.select().from(siteLoneWorkerSessions).where(eq(siteLoneWorkerSessions.id, sessionId));
    expect(rows[0]?.status).toBe("escalated");
    const raised = await siteSignals("site_lone_worker_overdue");
    expect(raised).toHaveLength(1);
    expect(raised[0]?.severity).toBe("critical");
    expect(raised[0]?.explanation).toContain("Control room");

    await app.scheduler.runNow("site.lone-worker");
    expect(await siteSignals("site_lone_worker_overdue")).toHaveLength(1);

    const notified = await app.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.companyId, owner.companyId), eq(notifications.recordId, sessionId)));
    expect(notified.length).toBeGreaterThan(0);
  });

  it("a check-in brings the session back and moves the clock forward", async () => {
    const res = await post(`${base()}/lone-workers/${sessionId}/check-in`, { method: "radio", note: "All well" });
    expect(res.statusCode).toBe(200);
    expect(res.json().session.status).toBe("active");
    expect(res.json().lateSeconds).toBeGreaterThan(0);
    expect(Date.parse(res.json().session.nextDueAt)).toBeGreaterThan(Date.now());
    const history = await get(`${base()}/lone-workers/${sessionId}/check-ins`);
    expect(history.json().total).toBe(1);
  });

  it("closes the session and refuses further check-ins", async () => {
    expect((await post(`${base()}/lone-workers/${sessionId}/close`, {})).json().status).toBe("completed");
    expect((await post(`${base()}/lone-workers/${sessionId}/check-in`, {})).statusCode).toBe(409);
    expect((await post(`${base()}/lone-workers/${sessionId}/close`, {})).statusCode).toBe(404);
  });
});

describe("tenant isolation", () => {
  it("refuses another company on every permit route", async () => {
    expect((await get(`${base()}/permits`, stranger.headers)).statusCode).toBe(403);
    expect((await post(`${base()}/permits`, { permitType: "hot_work", title: "x" }, stranger.headers)).statusCode).toBe(403);
    expect((await post(`${base()}/zones/check`, { lat: 0, lon: 0 }, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/lone-workers`, stranger.headers)).statusCode).toBe(403);
  });

  it("lets a read-only member read but not act", async () => {
    expect((await get(`${base()}/permits`, viewerHeaders)).statusCode).toBe(200);
    expect((await post(`${base()}/lone-workers`, { personName: "x", activity: "y" }, viewerHeaders)).statusCode).toBe(403);
  });

  it("keeps the sweeps inside their own tenant", async () => {
    const otherProject = newId("prj");
    await app.db.insert(projects).values({ id: otherProject, companyId: stranger.companyId, name: "Other co", stage: "course_of_construction" });
    const created = await post(
      `/projects/${otherProject}/site/lone-workers`,
      { personName: "Other person", activity: "Alone", intervalMinutes: 15, startedAt: ago(90) },
      stranger.headers,
    );
    expect(created.statusCode).toBe(201);
    await app.scheduler.runNow("site.lone-worker");
    const mine = await siteSignals("site_lone_worker_overdue");
    expect(mine).toHaveLength(1);
    const theirs = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.companyId, stranger.companyId), eq(signals.detector, "site_lone_worker_overdue")));
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.projectId).toBe(otherProject);
  });
});
