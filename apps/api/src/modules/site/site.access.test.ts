/**
 * Site access — inductions, passes, the gate feed, the on-site register and
 * muster reconciliation, including tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  ledgerEntries,
  projectMemberships,
  projects,
  signals,
  siteAccessPasses,
  siteAccessRecords,
  vendors,
  workers,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { siteModule } from "./index.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let viewerHeaders: Record<string, string>;
let stranger: TestActor;
let projectId: string;
let vendorId: string;
let workerId: string;

function post(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload });
}
function patch(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload });
}
function get(url: string, headers = owner.headers) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers });
}

const T = (hhmm: string, day = "2026-05-04") => `${day}T${hhmm}:00.000Z`;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  // Until the orchestrator wires the module in app.ts, mount it here; the
  // scheduler job name doubles as the "already registered" probe.
  if (!app.scheduler.has("site.lone-worker")) await app.register(siteModule, { prefix: "/api/v1" });
  owner = await registerActor(app);

  const viewer = await registerActor(app);
  await app.db.insert(companyMemberships).values({ id: newId("cm"), companyId: owner.companyId, userId: viewer.userId, role: "member" });
  viewerHeaders = { authorization: viewer.headers["authorization"]!, "x-company-id": owner.companyId };

  stranger = await registerActor(app);

  projectId = newId("prj");
  await app.db.insert(projects).values({ id: projectId, companyId: owner.companyId, name: "Site — access", stage: "course_of_construction" });
  await app.db.insert(projectMemberships).values({ id: newId("pm"), companyId: owner.companyId, projectId, userId: viewer.userId, templateKey: "read_only" });

  vendorId = newId("ven");
  await app.db.insert(vendors).values({ id: vendorId, companyId: owner.companyId, name: "Groundworks Ltd", country: "GB" });
  workerId = newId("wkr");
  await app.db.insert(workers).values({
    id: workerId,
    companyId: owner.companyId,
    projectId,
    reference: "W-001",
    fullName: "Ada Mason",
    vendorId,
    createdBy: owner.userId,
  });
});

afterAll(async () => {
  await built.close();
});

let inductionId: string;
let passId: string;

describe("inductions", () => {
  it("records an induction and puts it in force", async () => {
    const res = await post(`/projects/${projectId}/site/inductions`, {
      workerId,
      personName: "Ada Mason",
      personKind: "worker",
      vendorId,
      inductionType: "general",
      topics: ["fire", "traffic", "permits"],
      scorePercent: 90,
      passMark: 80,
      validUntil: "2027-05-04",
    });
    expect(res.statusCode).toBe(201);
    inductionId = res.json().id;
    expect(res.json().status).toBe("valid");
  });

  it("marks a failed induction failed rather than valid", async () => {
    const res = await post(`/projects/${projectId}/site/inductions`, {
      personName: "Ben Coles",
      scorePercent: 40,
      passMark: 80,
    });
    expect(res.json().status).toBe("failed");
  });

  it("refuses a worker who is not on this project's labour register", async () => {
    const res = await post(`/projects/${projectId}/site/inductions`, { personName: "Ghost", workerId: "wkr_nope" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("labour register");
  });

  it("refuses an expiry before the start", async () => {
    const res = await post(`/projects/${projectId}/site/inductions`, {
      personName: "Cal Reid",
      validFrom: "2026-06-01",
      validUntil: "2026-05-01",
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a PATCH that would invert the validity window a POST would refuse", async () => {
    const created = await post(`/projects/${projectId}/site/inductions`, {
      personName: "Gus Payne",
      validFrom: "2026-06-01",
      validUntil: "2026-12-01",
    });
    expect(created.statusCode).toBe(201);
    // one call at a time must not reach a state one call is refused for
    const inverted = await patch(`/projects/${projectId}/site/inductions/${created.json().id}`, { validUntil: "2026-01-01" });
    expect(inverted.statusCode).toBe(400);
    expect(inverted.json().message).toContain("expire before it becomes valid");
    const moved = await patch(`/projects/${projectId}/site/inductions/${created.json().id}`, {
      validFrom: "2026-01-01",
      validUntil: "2026-02-01",
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().validUntil).toBe("2026-02-01");
  });

  it("moves the verdict with the marks, and suspends the pass standing on an induction that becomes a failure", async () => {
    const created = await post(`/projects/${projectId}/site/inductions`, {
      personName: "Nia Frost",
      scorePercent: 88,
      passMark: 80,
      validUntil: "2027-05-04",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().status).toBe("valid");
    const pass = await post(`/projects/${projectId}/site/passes`, {
      inductionId: created.json().id,
      personName: "Nia Frost",
      badgeCode: "NF-9001",
    });
    expect(pass.statusCode).toBe(201);
    expect(pass.json().status).toBe("active");

    // Correcting the mark downwards must not leave the record saying "valid":
    // a POST with these numbers is recorded as failed, so a PATCH to them is.
    const corrected = await patch(`/projects/${projectId}/site/inductions/${created.json().id}`, { scorePercent: 41 });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json().status).toBe("failed");
    expect(corrected.json().passesSuspended).toBe(1);
    const afterFail = await get(`/projects/${projectId}/site/passes?pageSize=200`);
    expect(afterFail.json().items.find((p: { id: string }) => p.id === pass.json().id).status).toBe("suspended");

    // And back again when the mark was mis-keyed the first time.
    const restored = await patch(`/projects/${projectId}/site/inductions/${created.json().id}`, { scorePercent: 91 });
    expect(restored.json().status).toBe("valid");
    expect(restored.json().passesSuspended).toBe(0);
  });

  it("lists and filters", async () => {
    const res = await get(`/projects/${projectId}/site/inductions?status=valid`);
    expect(res.statusCode).toBe(200);
    expect(res.json().items.every((i: { status: string }) => i.status === "valid")).toBe(true);
  });
});

describe("passes", () => {
  it("issues a pass on a valid induction", async () => {
    const res = await post(`/projects/${projectId}/site/passes`, {
      inductionId,
      workerId,
      personName: "Ada Mason",
      vendorId,
      badgeCode: "B-1001",
      validFrom: "2026-01-01",
      validUntil: "2027-05-04",
    });
    expect(res.statusCode).toBe(201);
    passId = res.json().id;
    expect(res.json().status).toBe("active");
  });

  it("refuses a duplicate badge on the same project", async () => {
    const res = await post(`/projects/${projectId}/site/passes`, { personName: "Someone Else", badgeCode: "B-1001" });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("already issued");
  });

  it("refuses a pass on an induction that is not valid", async () => {
    const failed = await post(`/projects/${projectId}/site/inductions`, { personName: "Dee Blake", scorePercent: 10, passMark: 80 });
    const res = await post(`/projects/${projectId}/site/passes`, {
      inductionId: failed.json().id,
      personName: "Dee Blake",
      badgeCode: "B-9999",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("not in force");
  });

  it("suspends and reinstates, and refuses a revoke with no reason", async () => {
    expect((await post(`/projects/${projectId}/site/passes/${passId}/suspend`, {})).json().status).toBe("suspended");
    expect((await post(`/projects/${projectId}/site/passes/${passId}/suspend`, {})).statusCode).toBe(409);
    expect((await post(`/projects/${projectId}/site/passes/${passId}/reinstate`, {})).json().status).toBe("active");
    expect((await post(`/projects/${projectId}/site/passes/${passId}/revoke`, {})).statusCode).toBe(400);
  });

  it("suspends every live pass when the induction behind it is revoked", async () => {
    const induction = await post(`/projects/${projectId}/site/inductions`, { personName: "Eve Nolan" });
    const pass = await post(`/projects/${projectId}/site/passes`, {
      inductionId: induction.json().id,
      personName: "Eve Nolan",
      badgeCode: "B-2002",
      validFrom: "2026-01-01",
    });
    const revoked = await post(`/projects/${projectId}/site/inductions/${induction.json().id}/revoke`, { reason: "Falsified test result" });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().passesSuspended).toBe(1);
    const after = await app.db.select().from(siteAccessPasses).where(eq(siteAccessPasses.id, pass.json().id));
    expect(after[0]?.status).toBe("suspended");
  });

  it("refuses a pass PATCH that would invert the validity window, and corrects one that would not", async () => {
    const inverted = await patch(`/projects/${projectId}/site/passes/${passId}`, { validUntil: "2025-01-01" });
    expect(inverted.statusCode).toBe(400);
    expect(inverted.json().message).toContain("expire before it becomes valid");
    const corrected = await patch(`/projects/${projectId}/site/passes/${passId}`, { validUntil: "2027-09-30", notes: "Extended" });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json().validUntil).toBe("2027-09-30");
    // the badge code is not editable — one badge, one person, for the life of the register
    expect(corrected.json().badgeCode).toBe("B-1001");
  });

  it("refuses to move an active pass onto an induction that is not in force", async () => {
    const failed = await post(`/projects/${projectId}/site/inductions`, { personName: "Hal Vine", scorePercent: 10, passMark: 80 });
    const res = await patch(`/projects/${projectId}/site/passes/${passId}`, { inductionId: failed.json().id });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("not valid");
  });

  it("refuses to edit a revoked induction", async () => {
    const induction = await post(`/projects/${projectId}/site/inductions`, { personName: "Fay Doyle" });
    await post(`/projects/${projectId}/site/inductions/${induction.json().id}/revoke`, { reason: "Left the project" });
    const res = await patch(`/projects/${projectId}/site/inductions/${induction.json().id}`, { notes: "x" });
    expect(res.statusCode).toBe(409);
  });
});

describe("the gate feed", () => {
  it("accepts a batch, resolves the badge to a pass and appends one ledger entry", async () => {
    const before = await app.db.select({ seq: ledgerEntries.seq }).from(ledgerEntries).where(eq(ledgerEntries.companyId, owner.companyId));
    const res = await post(`/projects/${projectId}/site/gate-events`, {
      events: [
        { badgeCode: "B-1001", direction: "in", occurredAt: T("07:00"), externalRef: "dev1-1" },
        { badgeCode: "B-1001", direction: "out", occurredAt: T("16:00"), externalRef: "dev1-2" },
      ],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().accepted).toBe(2);
    expect(res.json().duplicates).toBe(0);
    const after = await app.db.select({ seq: ledgerEntries.seq }).from(ledgerEntries).where(eq(ledgerEntries.companyId, owner.companyId));
    expect(after.length).toBe(before.length + 1);
    const stored = await get(`/projects/${projectId}/site/gate-events?badgeCode=B-1001`);
    expect(stored.json().total).toBe(2);
    expect(stored.json().items[0].passId).toBe(passId);
  });

  it("counts only the reads that actually landed when a batch is partly replayed", async () => {
    // A person of their own so the presence assertions below stay exact.
    const induction = await post(`/projects/${projectId}/site/inductions`, { personName: "Ivy Shaw" });
    await post(`/projects/${projectId}/site/passes`, {
      inductionId: induction.json().id,
      personName: "Ivy Shaw",
      badgeCode: "B-4004",
      validFrom: "2026-01-01",
    });
    const first = await post(`/projects/${projectId}/site/gate-events`, {
      badgeCode: "B-4004",
      direction: "in",
      occurredAt: T("06:00"),
      externalRef: "dev2-1",
    });
    expect(first.json().accepted).toBe(1);

    const second = await post(`/projects/${projectId}/site/gate-events`, {
      events: [
        { badgeCode: "B-4004", direction: "in", occurredAt: T("06:00"), externalRef: "dev2-1" },
        { badgeCode: "B-4004", direction: "out", occurredAt: T("14:00"), externalRef: "dev2-2" },
      ],
    });
    expect(second.json().accepted).toBe(1);
    expect(second.json().duplicates).toBe(1);
    expect(second.json().eventIds).toHaveLength(1);
  });

  it("ignores a replayed batch rather than doubling the headcount", async () => {
    const res = await post(`/projects/${projectId}/site/gate-events`, {
      events: [{ badgeCode: "B-1001", direction: "in", occurredAt: T("07:00"), externalRef: "dev1-1" }],
    });
    expect(res.json().duplicates).toBe(1);
    expect(res.json().accepted).toBe(0);
    expect(res.json().notes.join(" ")).toContain("replayed batch");
  });

  it("stores an unknown credential as a refused read rather than dropping it", async () => {
    const res = await post(`/projects/${projectId}/site/gate-events`, {
      badgeCode: "B-UNKNOWN",
      direction: "in",
      occurredAt: T("03:00"),
      externalRef: "dev1-3",
    });
    expect(res.json().refused).toBe(1);
    expect(res.json().unmatched).toBe(1);
    const refused = await get(`/projects/${projectId}/site/gate-events?accepted=0&badgeCode=B-UNKNOWN`);
    expect(refused.json().items[0].refusalReason).toBe("unknown_credential");
  });

  it("refuses a read on a revoked pass", async () => {
    const induction = await post(`/projects/${projectId}/site/inductions`, { personName: "Gus Bell" });
    await post(`/projects/${projectId}/site/passes`, { inductionId: induction.json().id, personName: "Gus Bell", badgeCode: "B-3003", validFrom: "2026-01-01" });
    const pass = (await get(`/projects/${projectId}/site/passes?badgeCode=B-3003`)).json().items[0];
    await post(`/projects/${projectId}/site/passes/${pass.id}/revoke`, { reason: "Dismissed" });
    const res = await post(`/projects/${projectId}/site/gate-events`, {
      badgeCode: "B-3003",
      direction: "in",
      occurredAt: T("08:00"),
      externalRef: "dev1-4",
    });
    expect(res.json().refused).toBe(1);
    const refused = await get(`/projects/${projectId}/site/gate-events?badgeCode=B-3003`);
    expect(refused.json().items[0].refusalReason).toBe("pass_revoked");
  });
});

describe("the on-site register", () => {
  it("says why it is empty rather than implying nobody is on site", async () => {
    const empty = newId("prj");
    await app.db.insert(projects).values({ id: empty, companyId: owner.companyId, name: "No feed", stage: "course_of_construction" });
    const res = await get(`/projects/${empty}/site/register`);
    expect(res.json().headcount).toBe(0);
    expect(res.json().reasons[0]).toContain("gate feed is not connected");
  });

  it("folds the feed as at a moment in time", async () => {
    const midday = await get(`/projects/${projectId}/site/register?asOf=${encodeURIComponent(T("12:00"))}`);
    expect(midday.json().headcount).toBe(2);
    expect(midday.json().onSite.map((p: { personName: string }) => p.personName)).toEqual(["Ada Mason", "Ivy Shaw"]);
    const evening = await get(`/projects/${projectId}/site/register?asOf=${encodeURIComponent(T("18:00"))}`);
    expect(evening.json().headcount).toBe(0);
    expect(evening.json().refusedEvents).toBeGreaterThan(0);
  });

  it("reports hours on site per day", async () => {
    const res = await get(`/projects/${projectId}/site/presence?from=2026-05-04&to=2026-05-04`);
    expect(res.statusCode).toBe(200);
    const ada = res.json().items.find((r: { personName: string }) => r.personName === "Ada Mason");
    expect(ada.hours).toBe(9);
    const ivy = res.json().items.find((r: { personName: string }) => r.personName === "Ivy Shaw");
    expect(ivy.hours).toBe(8);
  });

  it("refuses a presence window longer than a quarter", async () => {
    const res = await get(`/projects/${projectId}/site/presence?from=2020-01-01&to=2026-01-01`);
    expect(res.statusCode).toBe(400);
  });
});

describe("musters", () => {
  let musterId: string;

  it("snapshots the register at declaration", async () => {
    // Two people inside at 10:00 on a later day.
    await post(`/projects/${projectId}/site/gate-events`, {
      events: [
        { badgeCode: "B-1001", direction: "in", occurredAt: T("07:00", "2026-05-05"), externalRef: "d2-1" },
        { badgeCode: "B-2002", direction: "in", occurredAt: T("07:10", "2026-05-05"), externalRef: "d2-2" },
      ],
    });
    // B-2002's pass was suspended by the induction revocation, so its read is
    // refused and only one person is on the register — which is the point.
    const res = await post(`/projects/${projectId}/site/musters`, {
      kind: "emergency",
      musterPoint: "Gate 2",
      declaredAt: T("10:00", "2026-05-05"),
    });
    expect(res.statusCode).toBe(201);
    musterId = res.json().id;
    expect(res.json().reference).toMatch(/^MUS-\d{3}$/);
    expect(res.json().expectedCount).toBe(1);
    expect(res.json().unaccountedCount).toBe(1);
  });

  it("leaves a person unaccounted for and raises a signal", async () => {
    const res = await post(`/projects/${projectId}/site/musters/${musterId}/reconcile`, {});
    expect(res.json().reconciliation.unaccountedCount).toBe(1);
    expect(res.json().reconciliation.unaccounted[0].name).toBe("Ada Mason");
    expect(res.json().signalId).toBeTruthy();
    const raised = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, "site_muster_unaccounted")));
    expect(raised).toHaveLength(1);
  });

  it("does not raise the same muster signal twice", async () => {
    await post(`/projects/${projectId}/site/musters/${musterId}/reconcile`, {});
    const raised = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, "site_muster_unaccounted")));
    expect(raised).toHaveLength(1);
  });

  it("refuses to close a muster with people missing and no account of them", async () => {
    const res = await post(`/projects/${projectId}/site/musters/${musterId}/close`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("Ada Mason");
  });

  it("clears once everybody is checked in, and flags an unexpected arrival", async () => {
    const res = await post(`/projects/${projectId}/site/musters/${musterId}/checkins`, {
      checkins: [
        { personKey: `pass:${passId}`, personName: "Ada Mason", status: "present" },
        { personName: "Unbadged visitor", status: "present" },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reconciliation.clear).toBe(true);
    expect(res.json().reconciliation.unexpectedCount).toBe(1);
    expect(res.json().muster.status).toBe("reconciled");
  });

  it("is idempotent on a repeated check-in for the same person", async () => {
    const res = await post(`/projects/${projectId}/site/musters/${musterId}/checkins`, {
      checkins: [{ personKey: `pass:${passId}`, personName: "Ada Mason", status: "present" }],
    });
    expect(res.json().reconciliation.expectedCount).toBe(1);
    expect(res.json().reconciliation.accountedCount).toBe(1);
  });

  it("closes once the muster is clear, and a closed muster stays closed", async () => {
    const res = await post(`/projects/${projectId}/site/musters/${musterId}/close`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("closed");
    expect((await post(`/projects/${projectId}/site/musters/${musterId}/checkins`, { checkins: [{ personName: "Late", status: "present" }] })).statusCode).toBe(409);
    // Re-running the reconciliation must not reopen a closed record.
    const again = await post(`/projects/${projectId}/site/musters/${musterId}/reconcile`, {});
    expect(again.json().muster.status).toBe("closed");
  });

  it("answers 404 rather than failing when the muster does not exist", async () => {
    expect((await post(`/projects/${projectId}/site/musters/mus_nope/close`, {})).statusCode).toBe(404);
    expect((await post(`/projects/${projectId}/site/musters/mus_nope/reconcile`, {})).statusCode).toBe(404);
  });
});

describe("the gate feed against the labour register", () => {
  const day = "2026-05-09";
  const quiet = "2026-05-10";
  let mateId: string;

  it("agrees, names a claim with no read behind it, and refuses to judge a day the feed never ran", async () => {
    mateId = newId("wkr");
    await app.db.insert(workers).values({
      id: mateId,
      companyId: owner.companyId,
      projectId,
      reference: "W-002",
      fullName: "Ken Ellis",
      vendorId,
      createdBy: owner.userId,
    });
    // Ada badges a full shift on the 9th; the gate feed records it.
    const reads = await post(`/projects/${projectId}/site/gate-events`, {
      events: [
        { badgeCode: "B-1001", direction: "in", occurredAt: `${day}T07:00:00.000Z`, externalRef: "att-1" },
        { badgeCode: "B-1001", direction: "out", occurredAt: `${day}T16:00:00.000Z`, externalRef: "att-2" },
      ],
    });
    expect(reads.json().accepted).toBe(2);

    // The workforce module's own record of the same day, plus one for a mate
    // who never walked through a gate, plus one on a day with no feed at all.
    await app.db.insert(siteAccessRecords).values([
      {
        id: newId("sar"),
        companyId: owner.companyId,
        projectId,
        workerId,
        accessDate: day,
        firstIn: "07:00",
        lastOut: "16:00",
        hoursOnSite: 9,
        source: "turnstile",
      },
      {
        id: newId("sar"),
        companyId: owner.companyId,
        projectId,
        workerId: mateId,
        accessDate: day,
        firstIn: "07:00",
        lastOut: "15:00",
        hoursOnSite: 8,
        source: "manual",
      },
      {
        id: newId("sar"),
        companyId: owner.companyId,
        projectId,
        workerId,
        accessDate: quiet,
        firstIn: "07:00",
        lastOut: "15:00",
        hoursOnSite: 8,
        source: "manual",
      },
    ]);

    const res = await get(`/projects/${projectId}/site/attendance-reconciliation?from=${day}&to=${quiet}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const lines = body.lines as Array<{ date: string; workerId: string; result: string; varianceHours: number | null }>;
    const ada = lines.find((l) => l.workerId === workerId && l.date === day);
    expect(ada?.result).toBe("agreed");
    expect(ada?.varianceHours).toBe(0);
    const ken = lines.find((l) => l.workerId === mateId);
    expect(ken?.result).toBe("no_gate_record");
    const untested = lines.find((l) => l.date === quiet);
    expect(untested?.result).toBe("not_comparable");
    expect(body.daysWithGateReads).toBe(1);
    expect(body.reasons.join(" ")).toContain("covers 1 of the 2 day(s)");
    expect(body.attendanceRecords).toBe(3);
  });

  it("filters by result and refuses a window longer than a quarter", async () => {
    const filtered = await get(`/projects/${projectId}/site/attendance-reconciliation?from=${day}&to=${quiet}&result=no_gate_record`);
    expect(filtered.json().lines.every((l: { result: string }) => l.result === "no_gate_record")).toBe(true);
    expect(filtered.json().total).toBe(1);
    const tooLong = await get(`/projects/${projectId}/site/attendance-reconciliation?from=2026-01-01&to=2026-12-31`);
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().message).toContain("quarter at a time");
  });

  it("counts a night shift on the site's own day boundary when it is given one", async () => {
    // 22:00–06:00 UTC: two calendar days in UTC, one working day on a site at
    // UTC+2, where the shift starts at midnight local.
    const reads = await post(`/projects/${projectId}/site/gate-events`, {
      events: [
        { badgeCode: "B-1001", direction: "in", occurredAt: "2026-05-11T22:00:00.000Z", externalRef: "att-3" },
        { badgeCode: "B-1001", direction: "out", occurredAt: "2026-05-12T06:00:00.000Z", externalRef: "att-4" },
      ],
    });
    expect(reads.json().accepted).toBe(2);
    await app.db.insert(siteAccessRecords).values({
      id: newId("sar"),
      companyId: owner.companyId,
      projectId,
      workerId,
      accessDate: "2026-05-12",
      firstIn: "00:00",
      lastOut: "08:00",
      hoursOnSite: 8,
      source: "manual",
    });

    // On UTC days the shift is split, and the eight claimed hours look overclaimed.
    const utc = await get(`/projects/${projectId}/site/attendance-reconciliation?from=2026-05-11&to=2026-05-12`);
    const utcLine = (utc.json().lines as Array<{ date: string; result: string; observedHours: number | null }>).find(
      (l) => l.date === "2026-05-12",
    );
    expect(utcLine?.result).toBe("over_claimed");
    expect(utcLine?.observedHours).toBe(6);
    expect((utc.json().reasons as string[]).join(" ")).toContain("UTC midnight boundaries");

    // Told what a day is on this site, the two streams agree.
    const local = await get(
      `/projects/${projectId}/site/attendance-reconciliation?from=2026-05-11&to=2026-05-12&utcOffsetMinutes=120`,
    );
    const localLine = (local.json().lines as Array<{ date: string; result: string; observedHours: number | null }>).find(
      (l) => l.date === "2026-05-12",
    );
    expect(localLine?.result).toBe("agreed");
    expect(localLine?.observedHours).toBe(8);
    expect(local.json().utcOffsetMinutes).toBe(120);
  });

  it("is closed to another company", async () => {
    const res = await get(`/projects/${projectId}/site/attendance-reconciliation?from=${day}&to=${quiet}`, stranger.headers);
    expect(res.statusCode).toBe(403);
  });
});

describe("credential expiry sweep", () => {
  it("treats `validUntil` as inclusive: the last valid day is still a valid day", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    const lastDay = await post(`/projects/${projectId}/site/passes`, {
      personName: "Last Day Larsen",
      badgeCode: "B-LASTDAY",
      validUntil: today,
    });
    expect(lastDay.statusCode).toBe(201);
    const overdue = await post(`/projects/${projectId}/site/passes`, {
      personName: "Ran Out Rowe",
      badgeCode: "B-RANOUT",
      validUntil: yesterday,
    });
    expect(overdue.statusCode).toBe(201);

    await app.scheduler.runNow("site.access-credentials");

    const rows = await app.db
      .select()
      .from(siteAccessPasses)
      .where(and(eq(siteAccessPasses.companyId, owner.companyId), eq(siteAccessPasses.projectId, projectId)));
    const still = rows.find((r) => r.badgeCode === "B-LASTDAY");
    const gone = rows.find((r) => r.badgeCode === "B-RANOUT");
    expect(still?.status).toBe("active");
    expect(gone?.status).toBe("expired");

    // ...and the gate agrees with the sweep on the same day.
    const read = await post(`/projects/${projectId}/site/gate-events`, {
      badgeCode: "B-LASTDAY",
      direction: "in",
      occurredAt: `${today}T08:00:00.000Z`,
      externalRef: "lastday-1",
    });
    expect(read.statusCode).toBe(201);
    expect(read.json().accepted).toBe(1);
  });
});

describe("tenant isolation and gating", () => {
  it("refuses another company outright", async () => {
    expect((await get(`/projects/${projectId}/site/register`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`/projects/${projectId}/site/passes`, stranger.headers)).statusCode).toBe(403);
    expect(
      (await post(`/projects/${projectId}/site/gate-events`, { badgeCode: "B-1001", direction: "in", occurredAt: T("09:00") }, stranger.headers)).statusCode,
    ).toBe(403);
  });

  it("lets a read-only member read but not write", async () => {
    expect((await get(`/projects/${projectId}/site/passes`, viewerHeaders)).statusCode).toBe(200);
    expect((await post(`/projects/${projectId}/site/passes`, { personName: "X", badgeCode: "B-X" }, viewerHeaders)).statusCode).toBe(403);
    expect((await post(`/projects/${projectId}/site/musters`, {}, viewerHeaders)).statusCode).toBe(403);
  });

  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/site/register` });
    expect(res.statusCode).toBe(401);
  });
});
