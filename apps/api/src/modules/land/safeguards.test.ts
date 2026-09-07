/**
 * Integration tests for the resettlement depth routes and every land audit
 * bug this package fixed:
 *
 *  - state/donated land reaching `acquired` without a fictitious dispute
 *  - compensation amount frozen after payment, with before/after in the ledger
 *  - the PAP state machine (no regressive or unevidenced transitions)
 *  - grievance rejection reachable, and excluded from the SLA rate
 *  - the detector runner replacing read-time sweeps (no duplicate signals)
 *  - stakeholder engagement filtering in SQL rather than a capped scan
 *
 * Every route also gets a cross-tenant negative.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  affectedPersons,
  evidence,
  grievances,
  landParcels,
  ledgerEntries,
  locations,
  obligations,
  projects,
  scheduleTasks,
  schedules,
  signals,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let stranger: TestActor;
let scheduleId: string;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  stranger = await registerActor(app);
  scheduleId = newId("sch");
  const holder = newId("prj");
  await app.db
    .insert(projects)
    .values({ id: holder, companyId: owner.companyId, name: "Schedule holder" });
  await app.db.insert(schedules).values({
    id: scheduleId,
    companyId: owner.companyId,
    projectId: holder,
    name: "Baseline",
    projectStart: todayISO(),
    createdBy: owner.userId,
  });
});

afterAll(async () => {
  await built.close();
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

async function makeProject(name: string, actor: TestActor = owner): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({ id, companyId: actor.companyId, name });
  return id;
}

async function makeEvidence(pid: string, actor: TestActor = owner): Promise<string> {
  const id = newId("evd");
  await app.db.insert(evidence).values({
    id,
    companyId: actor.companyId,
    projectId: pid,
    kind: "bank_transaction",
    source: "compensation account",
    contentHash: `hash-${id}`,
    submittedBy: actor.userId,
  });
  return id;
}

async function makeLocation(pid: string): Promise<string> {
  const id = newId("loc");
  await app.db.insert(locations).values({
    id,
    companyId: owner.companyId,
    projectId: pid,
    name: `Zone ${id.slice(-4)}`,
    path: `/zone-${id.slice(-4)}`,
  });
  return id;
}

async function makeTask(pid: string, name: string, startDate: string | null, extra: Record<string, unknown> = {}) {
  const id = newId("tsk");
  await app.db.insert(scheduleTasks).values({
    id,
    scheduleId,
    projectId: pid,
    name,
    durationDays: 10,
    startDate,
    ...extra,
  });
  return id;
}

async function makeParcel(pid: string, reference: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/parcels`,
    headers: owner.headers,
    payload: { reference, tenureType: "state", ...extra },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; status: string };
}

async function makePap(pid: string, reference: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/affected-persons`,
    headers: owner.headers,
    payload: {
      reference,
      householdHead: `Head of ${reference}`,
      householdSize: 4,
      displacementType: "physical",
      censusDate: todayISO(),
      ...extra,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; status: string };
}

/* ================================================================== */
/* AUDIT BUG: state / donated land forced through `disputed`           */
/* ================================================================== */

describe("parcel acquisition basis (#551-554)", () => {
  it("acquires a state parcel from `agreed` without manufacturing a dispute", async () => {
    const pid = await makeProject("State land scheme");
    const parcel = await makeParcel(pid, "P-STATE-1");
    for (const status of ["surveyed", "under_negotiation", "agreed"]) {
      const step = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/parcels/${parcel.id}/status`,
        headers: owner.headers,
        payload: { status },
      });
      expect(step.statusCode, status).toBe(200);
    }
    const evidenceId = await makeEvidence(pid);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/parcels/${parcel.id}/acquire`,
      headers: owner.headers,
      payload: {
        acquisitionBasis: "state_allocation",
        evidenceIds: [evidenceId],
        note: "Government allocation letter GA/2026/114",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      acquisitionBasis: string;
      acquiredAt: string;
      evidenceIds: string[];
    };
    expect(body.status).toBe("acquired");
    expect(body.acquisitionBasis).toBe("state_allocation");
    expect(body.acquiredAt).toBe(todayISO());
    expect(body.evidenceIds).toContain(evidenceId);

    // and the register records ZERO disputes on the way there
    const rows = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectId, parcel.id),
        ),
      );
    const states = rows
      .map((r) => (r.payload as { to?: string } | null)?.to)
      .filter((v): v is string => Boolean(v));
    expect(states).not.toContain("disputed");
    expect(states).toContain("acquired");
  });

  it("refuses `acquired` through the generic status route", async () => {
    const pid = await makeProject("Status route guard");
    const parcel = await makeParcel(pid, "P-GUARD-1");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/parcels/${parcel.id}/status`,
      headers: owner.headers,
      payload: { status: "acquired" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("/acquire");
  });

  it("refuses a purchase acquisition with no compensation paid (PS5 para 20)", async () => {
    const pid = await makeProject("Purchase without payment");
    const parcel = await makeParcel(pid, "P-BUY-1", { tenureType: "freehold" });
    for (const status of ["surveyed", "under_negotiation", "agreed"]) {
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/parcels/${parcel.id}/status`,
        headers: owner.headers,
        payload: { status },
      });
    }
    const evidenceId = await makeEvidence(pid);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/parcels/${parcel.id}/acquire`,
      headers: owner.headers,
      payload: { acquisitionBasis: "purchase", evidenceIds: [evidenceId] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("para 20");
  });

  it("requires evidence and refuses acquisition from an early status", async () => {
    const pid = await makeProject("Acquire guards");
    const parcel = await makeParcel(pid, "P-EARLY-1");
    const noEvidence = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/parcels/${parcel.id}/acquire`,
      headers: owner.headers,
      payload: { acquisitionBasis: "donation", evidenceIds: [] },
    });
    expect(noEvidence.statusCode).toBe(400);

    const evidenceId = await makeEvidence(pid);
    const tooEarly = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/parcels/${parcel.id}/acquire`,
      headers: owner.headers,
      payload: { acquisitionBasis: "donation", evidenceIds: [evidenceId] },
    });
    expect(tooEarly.statusCode).toBe(400);
    expect(tooEarly.json().message).toContain("cannot be acquired");
  });

  it("is not reachable from another tenant", async () => {
    const pid = await makeProject("Tenant isolation — acquire");
    const parcel = await makeParcel(pid, "P-ISO-1");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/parcels/${parcel.id}/acquire`,
      headers: stranger.headers,
      payload: { acquisitionBasis: "donation", evidenceIds: ["x"] },
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

/* ================================================================== */
/* AUDIT BUG: compensationAmount editable after payment                */
/* ================================================================== */

describe("compensation is frozen once paid", () => {
  async function compensatedParcel() {
    const pid = await makeProject(`Compensated ${newId("x")}`);
    const parcel = await makeParcel(pid, "P-PAY-1", {
      tenureType: "freehold",
      valuationAmount: 10_000,
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/parcels/${parcel.id}/status`,
      headers: owner.headers,
      payload: { status: "surveyed" },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/parcels/${parcel.id}/status`,
      headers: owner.headers,
      payload: { status: "under_negotiation" },
    });
    const evidenceId = await makeEvidence(pid);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/parcels/${parcel.id}/compensate`,
      headers: owner.headers,
      payload: { amount: 10_000, paidAt: todayISO(), evidenceIds: [evidenceId] },
    });
    expect(res.statusCode).toBe(200);
    return { pid, parcelId: parcel.id };
  }

  it("refuses a PATCH that moves the paid amount", async () => {
    const { pid, parcelId } = await compensatedParcel();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/parcels/${parcelId}`,
      headers: owner.headers,
      payload: { compensationAmount: 50_000 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("compensationAmount");
    const [row] = await app.db
      .select()
      .from(landParcels)
      .where(eq(landParcels.id, parcelId));
    expect(row!.compensationAmount).toBe(10_000);
  });

  it("still allows non-monetary edits, and ledgers before/after values", async () => {
    const { pid, parcelId } = await compensatedParcel();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/parcels/${parcelId}`,
      headers: owner.headers,
      payload: { ownerName: "Ministry of Works" },
    });
    expect(res.statusCode).toBe(200);
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(eq(ledgerEntries.objectId, parcelId), eq(ledgerEntries.action, "update")),
      );
    const payload = entries.at(-1)!.payload as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(payload.after["ownerName"]).toBe("Ministry of Works");
    expect(payload.before).toHaveProperty("ownerName");
  });
});

/* ================================================================== */
/* AUDIT BUG: PAP status route had no state machine                    */
/* ================================================================== */

describe("PAP state machine", () => {
  it("refuses a regressive transition", async () => {
    const pid = await makeProject("PAP ladder");
    const pap = await makePap(pid, "PAP-LADDER-1");
    const forward = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/affected-persons/${pap.id}/status`,
      headers: owner.headers,
      payload: { status: "surveyed" },
    });
    expect(forward.statusCode).toBe(200);
    const back = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/affected-persons/${pap.id}/status`,
      headers: owner.headers,
      payload: { status: "registered" },
    });
    expect(back.statusCode).toBe(400);
    expect(back.json().message).toContain("cannot move to registered");
  });

  it("refuses `resettled` on a household that has not been paid", async () => {
    const pid = await makeProject("Resettle without payment");
    const pap = await makePap(pid, "PAP-NOPAY-1");
    for (const status of ["surveyed"]) {
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/affected-persons/${pap.id}/status`,
        headers: owner.headers,
        payload: { status },
      });
    }
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/affected-persons/${pap.id}/status`,
      headers: owner.headers,
      payload: { status: "resettled" },
    });
    expect(res.statusCode).toBe(400);
    // entitlement_agreed → resettled is not on the ladder at all
    expect(res.json().message).toMatch(/cannot move to resettled|para 20/);
  });

  it("refuses `resettled` on an economically-displaced household", async () => {
    const pid = await makeProject("Economic displacement");
    const pap = await makePap(pid, "PAP-ECON-1", { displacementType: "economic" });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/affected-persons/${pap.id}/status`,
      headers: owner.headers,
      payload: { status: "surveyed" },
    });
    await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/affected-persons/${pap.id}/entitlements`,
      headers: owner.headers,
      payload: {
        entitlements: [{ item: "Livelihood grant", basis: "matrix", amount: 500 }],
      },
    });
    const evidenceId = await makeEvidence(pid);
    const paid = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/affected-persons/${pap.id}/compensate`,
      headers: owner.headers,
      payload: { paidAt: todayISO(), evidenceIds: [evidenceId] },
    });
    expect(paid.statusCode).toBe(200);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/affected-persons/${pap.id}/status`,
      headers: owner.headers,
      payload: { status: "resettled" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("physical move");
  });

  it("allows the real path and exposes allowedTransitions", async () => {
    const pid = await makeProject("PAP happy path");
    const pap = await makePap(pid, "PAP-OK-1");
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/affected-persons/${pap.id}/status`,
      headers: owner.headers,
      payload: { status: "surveyed" },
    });
    await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/affected-persons/${pap.id}/entitlements`,
      headers: owner.headers,
      payload: { entitlements: [{ item: "Replacement dwelling", basis: "matrix", amount: 15000 }] },
    });
    const evidenceId = await makeEvidence(pid);
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/affected-persons/${pap.id}/compensate`,
      headers: owner.headers,
      payload: { paidAt: todayISO(), evidenceIds: [evidenceId] },
    });
    const resettle = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/affected-persons/${pap.id}/status`,
      headers: owner.headers,
      payload: { status: "resettled" },
    });
    expect(resettle.statusCode).toBe(200);
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/affected-persons/${pap.id}`,
      headers: owner.headers,
    });
    const body = detail.json() as { allowedTransitions: string[] };
    expect(body.allowedTransitions).toEqual(["livelihood_restored"]);
  });

  it("refuses grievance_open by hand", async () => {
    const pid = await makeProject("Grievance status by hand");
    const pap = await makePap(pid, "PAP-GRV-1");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/affected-persons/${pap.id}/status`,
      headers: owner.headers,
      payload: { status: "grievance_open" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("grievance register");
  });
});

/* ================================================================== */
/* AUDIT BUG: no route could reject a grievance                        */
/* ================================================================== */

describe("grievance rejection (#571-573)", () => {
  async function makeGrievance(pid: string, extra: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances`,
      headers: owner.headers,
      payload: {
        channel: "in_person",
        category: "dust",
        severity: "medium",
        description: "Dust from haul road",
        receivedAt: todayISO(),
        ...extra,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; number: number; obligationId: string };
  }

  it("rejects with a reason, waives the obligation and ledgers the payload", async () => {
    const pid = await makeProject("Grievance rejection");
    const g = await makeGrievance(pid);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${g.id}/reject`,
      headers: owner.headers,
      payload: { reason: "Complaint relates to a neighbouring scheme", complainantNotified: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; resolution: string; resolvedAt: string };
    expect(body.status).toBe("rejected");
    expect(body.resolution).toContain("neighbouring scheme");
    expect(body.resolvedAt).toBeTruthy();

    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, g.obligationId));
    // waived, NOT satisfied: nothing was delivered to the complainant
    expect(obl!.status).toBe("waived");

    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.objectId, g.id), eq(ledgerEntries.action, "state_change")));
    const payload = entries.at(-1)!.payload as { reason: string; complainantNotified: boolean };
    expect(payload.reason).toContain("neighbouring scheme");
    expect(payload.complainantNotified).toBe(true);
  });

  it("records a withdrawal distinctly", async () => {
    const pid = await makeProject("Grievance withdrawal");
    const g = await makeGrievance(pid);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${g.id}/reject`,
      headers: owner.headers,
      payload: { reason: "Complainant asked to withdraw", outcome: "withdrawn" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { resolution: string }).resolution).toContain("Withdrawn");
  });

  it("refuses to reject an already-settled grievance", async () => {
    const pid = await makeProject("Double rejection");
    const g = await makeGrievance(pid);
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${g.id}/reject`,
      headers: owner.headers,
      payload: { reason: "Out of scope" },
    });
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${g.id}/reject`,
      headers: owner.headers,
      payload: { reason: "Out of scope" },
    });
    expect(again.statusCode).toBe(400);
  });

  it("excludes a rejected grievance from the SLA compliance rate", async () => {
    const pid = await makeProject("SLA denominator");
    const rejected = await makeGrievance(pid);
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${rejected.id}/reject`,
      headers: owner.headers,
      payload: { reason: "Vexatious" },
    });
    const resolved = await makeGrievance(pid);
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${resolved.id}/resolve`,
      headers: owner.headers,
      payload: { resolution: "Haul road watered twice daily" },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/grievances/analytics`,
      headers: owner.headers,
    });
    const body = res.json() as {
      slaComplianceRate: number | null;
      slaDenominator: number;
      rejected: number;
    };
    expect(body.rejected).toBe(1);
    // one resolved case, on time → 100%, with the rejection in NEITHER side
    expect(body.slaDenominator).toBe(1);
    expect(body.slaComplianceRate).toBe(1);
  });

  it("is not reachable from another tenant", async () => {
    const pid = await makeProject("Reject isolation");
    const g = await makeGrievance(pid);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${g.id}/reject`,
      headers: stranger.headers,
      payload: { reason: "no" },
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

/* ================================================================== */
/* AUDIT BUG: read-time sweeps duplicated signals                      */
/* ================================================================== */

describe("detectors raise once — from the scheduler and from the register reads alike", () => {
  it("raises exactly one signal, as the system, when the register is read in parallel", async () => {
    const pid = await makeProject("Parallel reads");
    const task = await makeTask(pid, "Earthworks", addDaysISO(todayISO(), 10));
    const parcel = await makeParcel(pid, "P-RACE-1", { blockingTaskIds: [task] });

    // TRIGGER CONTRACT: the schedule-risk read runs the same consent sweep
    // the scheduled job runs (the grievance read runs the grievance sweep;
    // the parcel list is a plain read). The workspace fires these together,
    // and before the lock and the fingerprint each read inserted its own copy
    // of the finding — so the same read is fired twice here, on purpose.
    const responses = await Promise.all([
      app.inject({
        method: "GET",
        url: `/api/v1/projects/${pid}/land/schedule-risk`,
        headers: owner.headers,
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/projects/${pid}/parcels`,
        headers: owner.headers,
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/projects/${pid}/grievances`,
        headers: owner.headers,
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/projects/${pid}/land/schedule-risk`,
        headers: owner.headers,
      }),
    ]);
    for (const res of responses) expect(res.statusCode).toBe(200);
    const afterReads = await app.db
      .select()
      .from(signals)
      .where(eq(signals.projectId, pid));
    expect(afterReads).toHaveLength(1);
    expect(afterReads[0]!.detector).toBe("land_blocks_programme");
    expect(afterReads[0]!.subjectId).toBe(parcel.id);
    // the SYSTEM raised it, not whoever opened the page
    const created = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.objectType, "signal"),
          eq(ledgerEntries.objectId, afterReads[0]!.id),
        ),
      );
    expect(created).toHaveLength(1);
    expect(created[0]!.actorId).toBeNull();

    // the scheduled job afterwards has nothing left to claim
    const job = await app.scheduler.runNow("land.detectors");
    expect(job.state).toBe("succeeded");
    const afterJob = await app.db
      .select()
      .from(signals)
      .where(eq(signals.projectId, pid));
    expect(afterJob).toHaveLength(1);
    expect(afterJob[0]!.id).toBe(afterReads[0]!.id);
  });

  it("raises exactly one signal per finding however many times the job runs", async () => {
    const pid = await makeProject("Idempotent detector");
    const task = await makeTask(pid, "Piling", addDaysISO(todayISO(), 10));
    await makeParcel(pid, "P-ONCE-1", { blockingTaskIds: [task] });

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/land/detectors/run`,
      headers: owner.headers,
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { raised: number }).raised).toBeGreaterThan(0);

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/land/detectors/run`,
      headers: owner.headers,
    });
    expect((second.json() as { raised: number; repeat: number }).raised).toBe(0);
    expect((second.json() as { repeat: number }).repeat).toBeGreaterThan(0);

    const rows = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.projectId, pid), eq(signals.detector, "land_blocks_programme")),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrences).toBeGreaterThan(1);
    // the SYSTEM raised it, not whoever ran the job. The trail is checked for
    // THIS finding: the register is shared across this file's projects, and
    // the read-side trigger raises the same detector for other projects.
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "signal"),
          eq(ledgerEntries.objectId, rows[0]!.id),
        ),
      );
    const created = entries.filter(
      (e) => (e.payload as { detector?: string } | null)?.detector === "land_blocks_programme",
    );
    expect(created.length).toBe(1);
    expect(created[0]!.actorId).toBeNull();
    expect((created[0]!.payload as { about: { objectId: string } }).about.objectId).toBeTruthy();
  });

  it("auto-closes the finding once the parcel is acquired", async () => {
    const pid = await makeProject("Auto-close");
    const task = await makeTask(pid, "Access road", addDaysISO(todayISO(), 10));
    const parcel = await makeParcel(pid, "P-CLOSE-1", { blockingTaskIds: [task] });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/land/detectors/run`,
      headers: owner.headers,
    });
    for (const status of ["surveyed", "under_negotiation", "agreed"]) {
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/parcels/${parcel.id}/status`,
        headers: owner.headers,
        payload: { status },
      });
    }
    const evidenceId = await makeEvidence(pid);
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/parcels/${parcel.id}/acquire`,
      headers: owner.headers,
      payload: { acquisitionBasis: "state_allocation", evidenceIds: [evidenceId] },
    });
    const run = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/land/detectors/run`,
      headers: owner.headers,
    });
    expect((run.json() as { closed: number }).closed).toBeGreaterThan(0);
    const rows = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.projectId, pid), eq(signals.detector, "land_blocks_programme")),
      );
    expect(rows[0]!.disposition).toBe("closed");
    expect(rows[0]!.autoClosedAt).toBeTruthy();
  });

  it("escalates a breached grievance up the published ladder, once", async () => {
    const pid = await makeProject("Escalation ladder");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances`,
      headers: owner.headers,
      payload: {
        channel: "phone",
        category: "access",
        severity: "high",
        description: "Access track blocked",
        receivedAt: addDaysISO(todayISO(), -40),
      },
    });
    expect(res.statusCode).toBe(201);
    const g = res.json() as { id: string };

    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/land/detectors/run`,
      headers: owner.headers,
    });
    const [row] = await app.db.select().from(grievances).where(eq(grievances.id, g.id));
    // 40 days past receipt on a 14-day resolve clock: resolution missed
    expect(row!.escalationTier).toBeGreaterThanOrEqual(2);
    expect(row!.status).toBe("escalated");
    expect((row!.escalationHistory as unknown[]).length).toBeGreaterThan(0);

    const before = row!.escalationTier;
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/land/detectors/run`,
      headers: owner.headers,
    });
    const [after] = await app.db.select().from(grievances).where(eq(grievances.id, g.id));
    // the ladder does not climb twice for the same breach
    expect(after!.escalationTier).toBe(before);
  });

  it("raises a hotspot for a cluster at one location", async () => {
    const pid = await makeProject("Hotspot");
    const locationId = await makeLocation(pid);
    for (const offset of [0, 3, 6]) {
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/grievances`,
        headers: owner.headers,
        payload: {
          channel: "in_person",
          category: "noise",
          severity: "low",
          description: "Night piling noise",
          receivedAt: addDaysISO(todayISO(), -offset),
          locationId,
        },
      });
    }
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/land/detectors/run`,
      headers: owner.headers,
    });
    const rows = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.projectId, pid), eq(signals.detector, "grievance_hotspot")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subjectId).toBe(locationId);
  });

  it("refuses a detector run from another tenant", async () => {
    const pid = await makeProject("Detector isolation");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/land/detectors/run`,
      headers: stranger.headers,
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it("is registered with the platform scheduler", () => {
    expect(app.scheduler.has("land.detectors")).toBe(true);
  });
});

/* ================================================================== */
/* Replacement cost verification (#550)                                */
/* ================================================================== */

describe("replacement-cost studies", () => {
  it("computes replacement cost without deducting depreciation and flags a shortfall", async () => {
    const pid = await makeProject("Replacement cost");
    const parcel = await makeParcel(pid, "P-RC-1");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/replacement-studies`,
      headers: owner.headers,
      payload: {
        parcelId: parcel.id,
        assetType: "structure",
        description: "Three-room brick dwelling",
        method: "independent_valuer",
        marketValue: 12_000,
        depreciationDeducted: 5_000,
        transactionCosts: 800,
        compensationOffered: 7_000,
        currency: "USD",
        surveyDate: todayISO(),
        valuerName: "Independent Valuers Ltd",
        valuerIndependent: true,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      replacementCost: number;
      shortfall: number;
      verdict: string;
      basis: string;
    };
    expect(body.replacementCost).toBe(12_800);
    expect(body.shortfall).toBe(5_800);
    expect(body.verdict).toBe("shortfall");
    expect(body.basis).toContain("does not permit");

    const run = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/land/detectors/run`,
      headers: owner.headers,
    });
    expect(run.statusCode).toBe(200);
    const rows = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.projectId, pid),
          eq(signals.detector, "replacement_cost_shortfall"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.severity).toBe("high");
  });

  it("recomputes the verdict on PATCH and closes the finding when it clears", async () => {
    const pid = await makeProject("Replacement recompute");
    const parcel = await makeParcel(pid, "P-RC-2");
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/replacement-studies`,
      headers: owner.headers,
      payload: {
        parcelId: parcel.id,
        assetType: "crops",
        description: "Maize, 0.4 ha",
        method: "market_survey",
        marketValue: 1_000,
        compensationOffered: 400,
        surveyDate: todayISO(),
      },
    });
    const study = created.json() as { id: string };
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/land/detectors/run`,
      headers: owner.headers,
    });
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/replacement-studies/${study.id}`,
      headers: owner.headers,
      payload: { compensationOffered: 1_000 },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { verdict: string }).verdict).toBe("adequate");
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/land/detectors/run`,
      headers: owner.headers,
    });
    const rows = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.projectId, pid), eq(signals.detector, "replacement_cost_shortfall")),
      );
    expect(rows[0]!.disposition).toBe("closed");
  });

  it("buckets the summary by currency and never sums across them", async () => {
    const pid = await makeProject("Replacement currencies");
    const parcel = await makeParcel(pid, "P-RC-3");
    for (const [currency, marketValue] of [
      ["USD", 1_000],
      ["EUR", 2_000],
    ] as const) {
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/replacement-studies`,
        headers: owner.headers,
        payload: {
          parcelId: parcel.id,
          assetType: "land",
          description: `Plot in ${currency}`,
          method: "market_survey",
          marketValue,
          currency,
          surveyDate: todayISO(),
        },
      });
    }
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/replacement-studies/summary`,
      headers: owner.headers,
    });
    const body = res.json() as {
      currencies: string[];
      byCurrency: { currency: string; totalReplacementCost: number }[];
    };
    expect(body.currencies).toEqual(["EUR", "USD"]);
    expect(body.byCurrency).toHaveLength(2);
    expect(body.byCurrency.find((b) => b.currency === "USD")!.totalReplacementCost).toBe(1_000);
  });

  it("refuses a study that names neither a parcel nor a household", async () => {
    const pid = await makeProject("Replacement subject");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/replacement-studies`,
      headers: owner.headers,
      payload: {
        assetType: "land",
        description: "Nothing in particular",
        method: "market_survey",
        marketValue: 100,
        surveyDate: todayISO(),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("is not readable from another tenant", async () => {
    const pid = await makeProject("Replacement isolation");
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/replacement-studies`,
      headers: stranger.headers,
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

/* ================================================================== */
/* Heritage plans & chance finds (PS7 / PS8)                           */
/* ================================================================== */

describe("heritage plans and chance finds", () => {
  it("tracks plan commitments and refuses to close a plan with open ones", async () => {
    const pid = await makeProject("Heritage plan");
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/heritage-plans`,
      headers: owner.headers,
      payload: {
        kind: "indigenous_peoples_plan",
        title: "IPP — Upper Valley communities",
        subject: "Upper Valley",
        consentStatus: "pending",
        commitments: [
          { text: "Hold FPIC round 2", dueDate: addDaysISO(todayISO(), 30) },
          { text: "Publish plan in local language" },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const plan = created.json() as { id: string; commitments: { id: string }[] };
    expect(plan.commitments).toHaveLength(2);

    const blocked = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/heritage-plans/${plan.id}`,
      headers: owner.headers,
      payload: { status: "implemented" },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toContain("open commitment");

    for (const c of plan.commitments) {
      const close = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/heritage-plans/${plan.id}/commitments/${c.id}/close`,
        headers: owner.headers,
        payload: { note: "Done" },
      });
      expect(close.statusCode).toBe(200);
    }
    const ok = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/heritage-plans/${plan.id}`,
      headers: owner.headers,
      payload: { status: "implemented" },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("stops the works on a chance find and refuses release before notification", async () => {
    const pid = await makeProject("Chance find");
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/chance-finds`,
      headers: owner.headers,
      payload: {
        discoveredAt: todayISO(),
        description: "Pottery sherds and a possible burial cist",
        locationDescription: "Ch 3+120, cutting face",
      },
    });
    expect(created.statusCode).toBe(201);
    const find = created.json() as { id: string; status: string; workStoppedAt: string };
    expect(find.status).toBe("work_stopped");
    expect(find.workStoppedAt).toBeTruthy();

    const skip = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/chance-finds/${find.id}/status`,
      headers: owner.headers,
      payload: { status: "released" },
    });
    expect(skip.statusCode).toBe(400);
    expect(skip.json().message).toContain("PS8 para 16");

    const unnamed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/chance-finds/${find.id}/status`,
      headers: owner.headers,
      payload: { status: "authority_notified" },
    });
    expect(unnamed.statusCode).toBe(400);

    const notified = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/chance-finds/${find.id}/status`,
      headers: owner.headers,
      payload: { status: "authority_notified", authority: "National Museums Service" },
    });
    expect(notified.statusCode).toBe(200);
    expect((notified.json() as { authorityNotifiedAt: string }).authorityNotifiedAt).toBeTruthy();
  });

  it("raises and then clears the unnotified chance-find finding", async () => {
    const pid = await makeProject("Chance find detector");
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/chance-finds`,
      headers: owner.headers,
      payload: { discoveredAt: todayISO(), description: "Worked flint scatter" },
    });
    const find = created.json() as { id: string };
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/land/detectors/run`,
      headers: owner.headers,
    });
    let rows = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.projectId, pid), eq(signals.detector, "chance_find_unreleased")));
    expect(rows).toHaveLength(1);

    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/chance-finds/${find.id}/status`,
      headers: owner.headers,
      payload: { status: "authority_notified", authority: "Heritage Agency" },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/land/detectors/run`,
      headers: owner.headers,
    });
    rows = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.projectId, pid), eq(signals.detector, "chance_find_unreleased")));
    expect(rows[0]!.disposition).toBe("closed");
  });

  it("is not reachable from another tenant", async () => {
    const pid = await makeProject("Heritage isolation");
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/heritage-plans`,
      headers: stranger.headers,
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

/* ================================================================== */
/* Livelihood restoration (#561)                                       */
/* ================================================================== */

describe("livelihood activities", () => {
  async function paidHousehold(pid: string, reference: string) {
    const pap = await makePap(pid, reference, {
      displacementType: "economic",
      baseline: { monthlyIncome: 400 },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/affected-persons/${pap.id}/status`,
      headers: owner.headers,
      payload: { status: "surveyed" },
    });
    await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/affected-persons/${pap.id}/entitlements`,
      headers: owner.headers,
      payload: { entitlements: [{ item: "Livelihood grant", basis: "matrix", amount: 1000 }] },
    });
    const evidenceId = await makeEvidence(pid);
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/affected-persons/${pap.id}/compensate`,
      headers: owner.headers,
      payload: { paidAt: todayISO(), evidenceIds: [evidenceId] },
    });
    return pap;
  }

  it("carries the census baseline income and measures restoration against it", async () => {
    const pid = await makeProject("Livelihood");
    const pap = await paidHousehold(pid, "PAP-LIV-1");
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/livelihood-activities`,
      headers: owner.headers,
      payload: {
        papId: pap.id,
        kind: "business_grant",
        description: "Grant + market stall licence",
        cost: 800,
      },
    });
    expect(created.statusCode).toBe(201);
    const activity = created.json() as { id: string; incomeBaseline: number };
    expect(activity.incomeBaseline).toBe(400);

    const evidenceId = await makeEvidence(pid);
    const verified = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/livelihood-activities/${activity.id}/status`,
      headers: owner.headers,
      payload: { status: "delivered" },
    });
    expect(verified.statusCode).toBe(200);
    const done = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/livelihood-activities/${activity.id}/status`,
      headers: owner.headers,
      payload: { status: "verified", incomeCurrent: 520, evidenceIds: [evidenceId] },
    });
    expect(done.statusCode).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/livelihood-activities?papId=${pap.id}`,
      headers: owner.headers,
    });
    const items = (list.json() as { items: { restored: boolean; incomeRatioPercent: number }[] })
      .items;
    expect(items[0]!.restored).toBe(true);
    expect(items[0]!.incomeRatioPercent).toBe(130);
  });

  it("refuses verification without a measured income and evidence", async () => {
    const pid = await makeProject("Livelihood verification");
    const pap = await paidHousehold(pid, "PAP-LIV-2");
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/livelihood-activities`,
      headers: owner.headers,
      payload: { papId: pap.id, kind: "skills_training", description: "Welding course" },
    });
    const activity = created.json() as { id: string };
    const noIncome = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/livelihood-activities/${activity.id}/status`,
      headers: owner.headers,
      payload: { status: "verified" },
    });
    expect(noIncome.statusCode).toBe(400);
    expect(noIncome.json().message).toContain("incomeCurrent");

    const noEvidence = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/livelihood-activities/${activity.id}/status`,
      headers: owner.headers,
      payload: { status: "verified", incomeCurrent: 500 },
    });
    expect(noEvidence.statusCode).toBe(400);
    expect(noEvidence.json().message).toContain("evidence");
  });

  it("refuses an activity for a household in another project", async () => {
    const pid = await makeProject("Livelihood scoping A");
    const other = await makeProject("Livelihood scoping B");
    const pap = await makePap(other, "PAP-OTHER-1");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/livelihood-activities`,
      headers: owner.headers,
      payload: { papId: pap.id, kind: "employment", description: "Job" },
    });
    expect(res.statusCode).toBe(400);
  });
});

/* ================================================================== */
/* RAP audit & supervision pack (#558-560, #568)                       */
/* ================================================================== */

describe("RAP indicators and completion audit", () => {
  it("computes indicators from the register and freezes them in the audit", async () => {
    const pid = await makeProject("RAP audit");
    const parcel = await makeParcel(pid, "P-RAP-1");
    await makePap(pid, "PAP-RAP-1", { vulnerabilities: ["female_headed"] });
    void parcel;

    const live = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/land/rap-indicators`,
      headers: owner.headers,
    });
    expect(live.statusCode).toBe(200);
    const indicators = live.json() as {
      parcels: { total: number };
      households: { total: number; vulnerable: number; compensatedPercent: number | null };
    };
    expect(indicators.parcels.total).toBe(1);
    expect(indicators.households.vulnerable).toBe(1);
    expect(indicators.households.compensatedPercent).toBe(0);

    const audit = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/rap-audits`,
      headers: owner.headers,
      payload: {
        auditor: "Independent Monitor Ltd",
        auditorIndependent: true,
        conclusion: "incomplete",
        findings: [
          {
            ref: "F-01",
            severity: "high",
            finding: "No replacement-cost study for the vulnerable household",
            recommendation: "Commission an independent valuation",
          },
        ],
      },
    });
    expect(audit.statusCode).toBe(201);
    const body = audit.json() as {
      id: string;
      number: number;
      ledgerSeqTo: number;
      indicators: { households: { total: number } };
      findings: unknown[];
    };
    expect(body.number).toBe(1);
    expect(body.ledgerSeqTo).toBeGreaterThan(0);
    expect(body.indicators.households.total).toBe(1);
    expect(body.findings).toHaveLength(1);

    const csv = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/rap-audits/${body.id}/pack.csv`,
      headers: owner.headers,
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body).toContain("households.total");
    expect(csv.body).toContain(String(body.ledgerSeqTo));
  });

  it("exposes health inputs with reasons", async () => {
    const pid = await makeProject("Land health inputs");
    const task = await makeTask(pid, "Started early", addDaysISO(todayISO(), 5), {
      actualStart: addDaysISO(todayISO(), -2),
    });
    await makeParcel(pid, "P-HEALTH-1", { blockingTaskIds: [task] });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/land/health-inputs`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      metrics: Record<string, number | null>;
      reasons: string[];
    };
    expect(body.metrics["parcels"]).toBe(1);
    expect(body.metrics["startedUnconsented"]).toBe(1);
    expect(body.reasons.join(" ")).toContain("unresolved land");
  });

  it("is not readable from another tenant", async () => {
    const pid = await makeProject("RAP isolation");
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/land/rap-indicators`,
      headers: stranger.headers,
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

/* ================================================================== */
/* Consent view (#591)                                                 */
/* ================================================================== */

describe("unified consent-to-programme view", () => {
  it("quantifies days-at-risk and the projected slip across parcels and permits", async () => {
    const pid = await makeProject("Consent view");
    const critical = await makeTask(pid, "Critical piling", addDaysISO(todayISO(), 5), {
      isCritical: 1,
    });
    await makeParcel(pid, "P-CONSENT-1", { blockingTaskIds: [critical] });
    const permit = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/permits`,
      headers: owner.headers,
      payload: {
        kind: "environmental_consent",
        title: "Discharge consent",
        authority: "Environment Agency",
        blockingTaskIds: [critical],
      },
    });
    expect(permit.statusCode).toBe(201);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/land/consent`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      tasks: { dependencies: { kind: string }[]; slipContribution: number | null }[];
      summary: {
        blockedTasks: number;
        blockingParcels: number;
        blockingPermits: number;
        projectedSlipDays: number | null;
      };
      dependencies: { kind: string }[];
    };
    expect(body.summary.blockedTasks).toBe(1);
    expect(body.summary.blockingParcels).toBe(1);
    expect(body.summary.blockingPermits).toBe(1);
    expect(body.summary.projectedSlipDays).toBeGreaterThan(0);
    expect(body.tasks[0]!.dependencies.map((d) => d.kind).sort()).toEqual(["parcel", "permit"]);
  });

  it("keeps the legacy schedule-risk shape working and raises the finding once, as the system", async () => {
    const pid = await makeProject("Legacy schedule risk");
    const task = await makeTask(pid, "Earthworks", addDaysISO(todayISO(), 10));
    const parcel = await makeParcel(pid, "P-LEGACY-1", { blockingTaskIds: [task] });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/land/schedule-risk`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      blockedTasks: number;
      blockedParcels: number;
      items: { parcelId: string | null; reference: string; daysAtRisk: number }[];
    };
    expect(body.blockedTasks).toBe(1);
    expect(body.blockedParcels).toBe(1);
    expect(body.items[0]!.reference).toBe("P-LEGACY-1");
    // the read is the second trigger of the consent sweep: the finding is on
    // the register once, keyed to the parcel, raised by the system
    const raised = await app.db.select().from(signals).where(eq(signals.projectId, pid));
    expect(raised).toHaveLength(1);
    expect(raised[0]!.detector).toBe("land_blocks_programme");
    expect(raised[0]!.subjectId).toBe(parcel.id);
    // a second read repeats the observation without a second row
    await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/land/schedule-risk`,
      headers: owner.headers,
    });
    const again = await app.db.select().from(signals).where(eq(signals.projectId, pid));
    expect(again).toHaveLength(1);
    expect(again[0]!.occurrences).toBeGreaterThan(1);
  });
});

/* ================================================================== */
/* AUDIT BUG: engagement filtering capped at 1000 and done in JS       */
/* ================================================================== */

describe("stakeholder engagement filtering", () => {
  it("filters engagements by stakeholder in SQL, with an honest total", async () => {
    const pid = await makeProject("Engagement filtering");
    const mk = async (name: string) => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/stakeholders`,
        headers: owner.headers,
        payload: { name, category: "community", influence: 4, interest: 5 },
      });
      expect(res.statusCode).toBe(201);
      return (res.json() as { id: string }).id;
    };
    const a = await mk("Village committee A");
    const b = await mk("Village committee B");
    for (const [i, holder] of [a, a, a, b].entries()) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/engagements`,
        headers: owner.headers,
        payload: {
          title: `Consultation ${i}`,
          kind: "consultation",
          engagementDate: addDaysISO(todayISO(), -i),
          stakeholderIds: [holder],
        },
      });
      expect(res.statusCode).toBe(201);
    }

    const filtered = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/engagements?stakeholderId=${a}&pageSize=2`,
      headers: owner.headers,
    });
    const body = filtered.json() as { items: unknown[]; total: number };
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(2);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/stakeholders/${a}`,
      headers: owner.headers,
    });
    const d = detail.json() as { engagementCount: number; engagements: unknown[] };
    expect(d.engagementCount).toBe(3);
    expect(d.engagements).toHaveLength(3);
  });

  it("still refuses to delete a stakeholder named on an engagement", async () => {
    const pid = await makeProject("Engagement delete guard");
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/stakeholders`,
      headers: owner.headers,
      payload: { name: "Chief", category: "community", influence: 5, interest: 5 },
    });
    const s = created.json() as { id: string };
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/engagements`,
      headers: owner.headers,
      payload: {
        title: "Meeting",
        kind: "meeting",
        engagementDate: todayISO(),
        stakeholderIds: [s.id],
      },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${pid}/stakeholders/${s.id}`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(409);
  });
});

/* ================================================================== */
/* IFC PS5 conformance detectors, end to end                           */
/* ================================================================== */

describe("PS5 conformance detectors", () => {
  it("flags a vulnerable household given only the standard matrix", async () => {
    const pid = await makeProject("PS5 vulnerable");
    const pap = await makePap(pid, "PAP-VULN-1", { vulnerabilities: ["disabled"] });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/affected-persons/${pap.id}/status`,
      headers: owner.headers,
      payload: { status: "surveyed" },
    });
    await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/affected-persons/${pap.id}/entitlements`,
      headers: owner.headers,
      payload: {
        entitlements: [{ item: "Crop compensation", basis: "district schedule", amount: 200 }],
      },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/land/detectors/run`,
      headers: owner.headers,
    });
    const rows = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.projectId, pid),
          eq(signals.detector, "vulnerable_household_without_enhanced_entitlement"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subjectId).toBe(pap.id);
  });

  it("flags an undisclosed cut-off date", async () => {
    const pid = await makeProject("PS5 cut-off");
    const declare = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/land/cut-off`,
      headers: owner.headers,
      payload: { date: todayISO() },
    });
    expect(declare.statusCode).toBe(200);
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/land/detectors/run`,
      headers: owner.headers,
    });
    let rows = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.projectId, pid), eq(signals.detector, "cut_off_not_disclosed")));
    expect(rows).toHaveLength(1);

    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/engagements`,
      headers: owner.headers,
      payload: {
        title: "Cut-off disclosure meeting",
        kind: "disclosure",
        engagementDate: todayISO(),
      },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/land/detectors/run`,
      headers: owner.headers,
    });
    rows = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.projectId, pid), eq(signals.detector, "cut_off_not_disclosed")));
    expect(rows[0]!.disposition).toBe("closed");
  });

  it("flags works started on a parcel with no payment", async () => {
    const pid = await makeProject("PS5 possession");
    const task = await makeTask(pid, "Clearance", addDaysISO(todayISO(), 3), {
      actualStart: addDaysISO(todayISO(), -1),
    });
    await makeParcel(pid, "P-PS5-1", {
      tenureType: "freehold",
      blockingTaskIds: [task],
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/land/detectors/run`,
      headers: owner.headers,
    });
    const displacement = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.projectId, pid),
          eq(signals.detector, "displacement_before_compensation"),
        ),
      );
    expect(displacement).toHaveLength(1);
    expect(displacement[0]!.severity).toBe("critical");
    const started = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.projectId, pid),
          eq(signals.detector, "works_started_on_unconsented_land"),
        ),
      );
    expect(started).toHaveLength(1);
    expect(started[0]!.severity).toBe("critical");
  });
});

/* ================================================================== */
/* Cross-tenant negatives for every new route                          */
/* ================================================================== */

describe("cross-tenant isolation across the new safeguards routes", () => {
  it("refuses every route to a foreign tenant", async () => {
    const pid = await makeProject("Isolation sweep");
    const routes: [string, string][] = [
      ["GET", `/api/v1/projects/${pid}/replacement-studies`],
      ["GET", `/api/v1/projects/${pid}/replacement-studies/summary`],
      ["GET", `/api/v1/projects/${pid}/heritage-plans`],
      ["GET", `/api/v1/projects/${pid}/chance-finds`],
      ["GET", `/api/v1/projects/${pid}/livelihood-activities`],
      ["GET", `/api/v1/projects/${pid}/rap-audits`],
      ["GET", `/api/v1/projects/${pid}/land/consent`],
      ["GET", `/api/v1/projects/${pid}/land/rap-indicators`],
      ["GET", `/api/v1/projects/${pid}/land/health-inputs`],
    ];
    for (const [method, url] of routes) {
      const res = await app.inject({ method: method as "GET", url, headers: stranger.headers });
      expect([403, 404], `${method} ${url}`).toContain(res.statusCode);
    }
  });

  it("refuses unauthenticated access", async () => {
    const pid = await makeProject("Unauthenticated");
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/replacement-studies`,
    });
    expect(res.statusCode).toBe(401);
  });
});

/* ================================================================== */
/* The affected-persons register still behaves                         */
/* ================================================================== */

describe("regression: existing land behaviour is unchanged", () => {
  it("keeps the parcel status ladder and the compensated route", async () => {
    const pid = await makeProject("Existing behaviour");
    const parcel = await makeParcel(pid, "P-EXIST-1");
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/parcels/${parcel.id}`,
      headers: owner.headers,
    });
    const body = detail.json() as { allowedTransitions: string[] };
    expect(body.allowedTransitions).toEqual(["surveyed", "disputed"]);
    const compensated = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/parcels/${parcel.id}/status`,
      headers: owner.headers,
      payload: { status: "compensated" },
    });
    expect(compensated.statusCode).toBe(400);
  });

  it("keeps affected_persons scoped to their project", async () => {
    const pid = await makeProject("PAP scope");
    const other = await makeProject("PAP scope other");
    await makePap(pid, "PAP-SCOPE-1");
    const rows = await app.db
      .select()
      .from(affectedPersons)
      .where(eq(affectedPersons.projectId, other));
    expect(rows).toHaveLength(0);
  });
});
