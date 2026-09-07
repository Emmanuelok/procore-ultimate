/**
 * Supply chain — offsite / modular production: units, stages, independent QA
 * gates, lifecycle, factory inspections and verified-for-payment.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { companyMemberships, locations, offsiteUnits, projectMemberships, projects, signals } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";
import { supplychainModule } from "./index.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let verifier: TestActor;
let viewerHeaders: Record<string, string>;
let stranger: TestActor;
let projectId: string;
let locationId: string;

const today = todayISO();

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

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  // Until the orchestrator wires the module in app.ts, mount it here; the
  // scheduler job name doubles as the "already registered" probe.
  if (!app.scheduler.has("supplychain.long-lead")) await app.register(supplychainModule, { prefix: "/api/v1" });
  owner = await registerActor(app);
  verifier = await registerActor(app);
  await app.db.insert(companyMemberships).values({ id: newId("cm"), companyId: owner.companyId, userId: verifier.userId, role: "admin" });
  verifier = { ...verifier, companyId: owner.companyId, headers: { authorization: verifier.headers["authorization"]!, "x-company-id": owner.companyId } };
  const viewer = await registerActor(app);
  await app.db.insert(companyMemberships).values({ id: newId("cm"), companyId: owner.companyId, userId: viewer.userId, role: "member" });
  viewerHeaders = { authorization: viewer.headers["authorization"]!, "x-company-id": owner.companyId };
  stranger = await registerActor(app);
  projectId = newId("prj");
  await app.db.insert(projects).values({ id: projectId, companyId: owner.companyId, name: "Supply chain — offsite", stage: "course_of_construction" });
  await app.db.insert(projectMemberships).values({ id: newId("pm"), companyId: owner.companyId, projectId, userId: viewer.userId, templateKey: "read_only" });
  locationId = newId("loc");
  await app.db.insert(locations).values({ id: locationId, companyId: owner.companyId, projectId, name: "Level 3 / Apt 3.04", path: locationId });
});

afterAll(async () => {
  await built.close();
});

const base = () => `/projects/${projectId}/supply-chain/offsite`;

let unitId: string;
let stageIds: string[];

describe("offsite units and stages", () => {
  it("creates a unit with its production stages and an honest empty rollup", async () => {
    const res = await post(`${base()}/units`, {
      name: "Bathroom pod 3.04",
      unitType: "pod",
      serialNumber: "POD-3-04",
      plannedDeliveryDate: addDaysISO(today, 30),
      value: 18_000,
      currency: "GBP",
      transportKm: 240,
      stages: [
        { name: "Frame", isQaGate: false },
        { name: "Services first fix", isQaGate: true },
        { name: "Finishes", isQaGate: false },
      ],
    });
    expect(res.statusCode).toBe(201);
    const unit = res.json();
    unitId = unit.id;
    expect(unit.reference).toBe("MOD-001");
    expect(unit.status).toBe("planned");
    expect(unit.rollup.stagesTotal).toBe(3);
    expect(unit.rollup.qaGatesTotal).toBe(1);
    expect(unit.rollup.readyToShip).toBe(false);

    const detail = await get(`${base()}/units/${unitId}`);
    expect(detail.statusCode).toBe(200);
    stageIds = detail.json().stages.map((s: { id: string }) => s.id);
    expect(stageIds).toHaveLength(3);
    expect(detail.json().verifiedForPayment.percent).toBeNull();
    expect(detail.json().verifiedForPayment.reasons[0]).toMatch(/No factory inspection/);
    expect(detail.json().allowedTransitions).toEqual(expect.arrayContaining(["in_design", "in_production"]));
    expect(detail.json().allowedTransitions).not.toContain("passed_qa");

    const empty = await post(`${base()}/units`, { name: "Kit of parts", unitType: "kit" });
    expect(empty.json().rollup.reasons[0]).toMatch(/No production stages/);
  });

  it("derives the unit status from stage progress and holds it on a failed QA gate", async () => {
    const started = await post(`${base()}/units/${unitId}/stages/${stageIds[0]}/start`, {});
    expect(started.statusCode).toBe(200);
    expect(started.json().status).toBe("in_progress");
    const done = await post(`${base()}/units/${unitId}/stages/${stageIds[0]}/complete`, { evidenceFileIds: ["file_frame"] });
    expect(done.json().status).toBe("complete");
    expect(done.json().completedBy).toBe(owner.userId);
    expect(done.json().unitStatus).toBe("in_production");
    expect(done.json().rollup.percentComplete).toBeCloseTo(33.3, 1);

    // The QA gate: completed by the owner, so the owner may not verify it.
    await post(`${base()}/units/${unitId}/stages/${stageIds[1]}/complete`, {});
    const self = await post(`${base()}/units/${unitId}/stages/${stageIds[1]}/qa`, { result: "passed" });
    expect(self.statusCode).toBe(403);
    const notGate = await post(`${base()}/units/${unitId}/stages/${stageIds[0]}/qa`, { result: "passed" }, verifier.headers);
    expect(notGate.statusCode).toBe(400);
    const waiveNoReason = await post(`${base()}/units/${unitId}/stages/${stageIds[1]}/qa`, { result: "waived" }, verifier.headers);
    expect(waiveNoReason.statusCode).toBe(400);

    const failed = await post(`${base()}/units/${unitId}/stages/${stageIds[1]}/qa`, { result: "failed", notes: "Pipework not pressure tested" }, verifier.headers);
    expect(failed.statusCode).toBe(200);
    expect(failed.json().qaResult).toBe("failed");
    expect(failed.json().qaVerifiedBy).toBe(verifier.userId);
    expect(failed.json().unitStatus).toBe("qa_hold");
    const sig = await app.db.select().from(signals).where(and(eq(signals.projectId, projectId), eq(signals.detector, "supply_offsite_qa_failed")));
    expect(sig).toHaveLength(1);

    const blocked = await post(`${base()}/units/${unitId}/transition`, { status: "passed_qa" });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().message).toMatch(/QA gate/);
  });

  it("clears the hold when the gate passes and derives passed_qa once every stage is done", async () => {
    // Re-run the failed stage, complete it again, and have the verifier pass it.
    expect((await post(`${base()}/units/${unitId}/stages/${stageIds[1]}/start`, {})).statusCode).toBe(200);
    expect((await post(`${base()}/units/${unitId}/stages/${stageIds[1]}/complete`, {})).statusCode).toBe(200);
    const passed = await post(`${base()}/units/${unitId}/stages/${stageIds[1]}/qa`, { result: "passed", notes: "Pressure test witnessed 6 bar/30 min" }, verifier.headers);
    expect(passed.statusCode).toBe(200);
    expect(passed.json().unitStatus).toBe("in_production");
    const last = await post(`${base()}/units/${unitId}/stages/${stageIds[2]}/complete`, {});
    expect(last.json().unitStatus).toBe("passed_qa");
    expect(last.json().rollup.readyToShip).toBe(true);
    expect(last.json().rollup.percentComplete).toBe(100);
  });

  it("verifies progress for payment only through an inspector who completed no stage", async () => {
    const scheduled = await post(`${base()}/inspections`, { unitId, kind: "factory_acceptance_test", title: "FAT pod 3.04", scheduledFor: today });
    expect(scheduled.statusCode).toBe(201);
    const inspectionId = scheduled.json().id;
    expect((await post(`${base()}/inspections`, { kind: "witness", title: "nothing to inspect" })).statusCode).toBe(400);

    const byCompleter = await post(`${base()}/inspections/${inspectionId}/record`, { result: "passed", percentVerified: 95 });
    expect(byCompleter.statusCode).toBe(403);

    const recorded = await post(`${base()}/inspections/${inspectionId}/record`, { result: "conditional", percentVerified: 80, findings: "Sealant to complete" }, verifier.headers);
    expect(recorded.statusCode).toBe(200);
    expect(recorded.json().inspectorId).toBe(verifier.userId);
    expect(recorded.json().unit.percentVerifiedForPayment).toBe(80);
    expect(recorded.json().unit.verifiedForPaymentBy).toBe(verifier.userId);
    expect(recorded.json().unit.percentComplete).toBe(100);
    expect((await post(`${base()}/inspections/${inspectionId}/record`, { result: "passed" }, verifier.headers)).statusCode).toBe(400);

    const list = await get(`${base()}/inspections?unitId=${unitId}`);
    expect(list.json().total).toBe(1);

    const storage = await post(`${base()}/inspections`, { unitId, kind: "storage_inspection", title: "Storage check", scheduledFor: today });
    const stored = await post(`${base()}/inspections/${storage.json().id}/record`, { result: "passed" }, verifier.headers);
    expect(stored.json().unit.storageInspectedAt).toBe(today);

    const toCancel = await post(`${base()}/inspections`, { unitId, kind: "witness", title: "Witness", scheduledFor: addDaysISO(today, 5) });
    const cancelled = await post(`${base()}/inspections/${toCancel.json().id}/cancel`, { reason: "Factory closed" });
    expect(cancelled.json().result).toBe("cancelled");
  });

  it("records vesting and storage and walks the unit to installation", async () => {
    const vest = await post(`${base()}/units/${unitId}/vesting`, { vestingCertificateFileId: "file_vc", vestingCertifiedAt: today, storageInsuredUntil: addDaysISO(today, 60), storageLocationText: "Bay 4, factory yard" });
    expect(vest.statusCode).toBe(200);
    expect(vest.json().vestingCertifiedAt).toBe(today);

    for (const status of ["ready_to_ship", "in_transit", "delivered"]) {
      const r = await post(`${base()}/units/${unitId}/transition`, { status });
      expect(r.statusCode).toBe(200);
      expect(r.json().status).toBe(status);
    }
    const unit = await get(`${base()}/units/${unitId}`);
    expect(unit.json().actualDeliveryDate).toBe(today);

    expect((await post(`${base()}/units/${unitId}/transition`, { status: "rejected" })).statusCode).toBe(400);
    expect((await post(`${base()}/units/${unitId}/transition`, { status: "installed" })).statusCode).toBe(400);
    const installed = await post(`${base()}/units/${unitId}/transition`, { status: "installed", locationId });
    expect(installed.statusCode).toBe(200);
    expect(installed.json().installedAt).toBe(today);
    expect(installed.json().locationId).toBe(locationId);
    expect((await patch(`${base()}/units/${unitId}`, { name: "x" })).statusCode).toBe(400);
    expect((await del(`${base()}/units/${unitId}`)).statusCode).toBe(400);
  });

  it("adds, edits and removes stages while the unit is open", async () => {
    const unit = await post(`${base()}/units`, { name: "Panel P1", unitType: "panel", stages: [{ name: "Cut" }] });
    const id = unit.json().id;
    const added = await post(`${base()}/units/${id}/stages`, { name: "Insulate", isQaGate: true });
    expect(added.statusCode).toBe(201);
    expect(added.json().position).toBe(1);
    expect(added.json().rollup.qaGatesTotal).toBe(1);
    const renamed = await patch(`${base()}/units/${id}/stages/${added.json().id}`, { name: "Insulate + vapour barrier" });
    expect(renamed.json().name).toBe("Insulate + vapour barrier");
    expect((await del(`${base()}/units/${id}/stages/${added.json().id}`)).statusCode).toBe(204);
    const detail = await get(`${base()}/units/${id}`);
    expect(detail.json().stagesTotal).toBe(1);
    expect((await del(`${base()}/units/${id}`)).statusCode).toBe(204);
  });

  it("lists with filters and enforces gates and tenancy", async () => {
    const list = await get(`${base()}/units?status=installed`);
    expect(list.json().total).toBe(1);
    expect((await get(`${base()}/units`, viewerHeaders)).statusCode).toBe(200);
    expect((await post(`${base()}/units`, { name: "x" }, viewerHeaders)).statusCode).toBe(403);
    expect((await get(`${base()}/units/${unitId}`, stranger.headers)).statusCode).toBe(403);
    expect((await post(`${base()}/units/${unitId}/transition`, { status: "rejected", note: "x" }, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/inspections`, stranger.headers)).statusCode).toBe(403);
  });
});

/* ================================================================== */
/* Correcting what an inspector recorded                               */
/* ================================================================== */

describe("verified-for-payment is correctable", () => {
  let correctableId: string;

  it("lets a later, lower inspection correct an over-stated one", async () => {
    const unit = await post(`${base()}/units`, { name: "Riser module R1", unitType: "mep_module", value: 1_000_000, currency: "GBP" });
    expect(unit.statusCode).toBe(201);
    correctableId = unit.json().id;

    const first = await post(`${base()}/inspections`, { unitId: correctableId, kind: "witness", title: "Witness 1", scheduledFor: addDaysISO(today, -2) });
    const over = await post(`${base()}/inspections/${first.json().id}/record`, { result: "passed", percentVerified: 90, performedAt: addDaysISO(today, -2) }, verifier.headers);
    expect(over.statusCode).toBe(200);
    expect(over.json().unit.percentVerifiedForPayment).toBe(90);
    expect(over.json().unit.verifiedForPaymentBy).toBe(verifier.userId);

    // A second inspector finds the true figure. Under a max() rule this was
    // accepted with 200 and then silently ignored — the unit still said 90.
    const second = await post(`${base()}/inspections`, { unitId: correctableId, kind: "surveillance", title: "Corrective survey", scheduledFor: today });
    const corrected = await post(`${base()}/inspections/${second.json().id}/record`, { result: "passed", percentVerified: 40, performedAt: today, findings: "Earlier 90% was a typo; 40% of the module is built." });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json().unit.percentVerifiedForPayment).toBe(40);
    expect(corrected.json().unit.verifiedForPaymentBy).toBe(owner.userId);
    expect(corrected.json().unit.verifiedForPayment.reasons.join(" ")).toMatch(/superseded/);

    const detail = await get(`${base()}/units/${correctableId}`);
    expect(detail.json().percentVerifiedForPayment).toBe(40);
    expect(detail.json().verifiedForPayment.source.inspectorId).toBe(owner.userId);
  });

  it("voids a mis-recorded inspection only through a second person, and falls back to what still stands", async () => {
    const list = await get(`${base()}/inspections?unitId=${correctableId}`);
    const corrective = list.json().items.find((i: { title: string }) => i.title === "Corrective survey");
    expect(corrective.inspectorId).toBe(owner.userId);

    // The inspector of record may not withdraw their own inspection.
    const self = await post(`${base()}/inspections/${corrective.id}/void`, { reason: "I made a mistake recording this" });
    expect(self.statusCode).toBe(403);
    expect((await post(`${base()}/inspections/${corrective.id}/void`, { reason: "short" }, verifier.headers)).statusCode).toBe(400);

    const voided = await post(`${base()}/inspections/${corrective.id}/void`, { reason: "Recorded against the wrong unit reference." }, verifier.headers);
    expect(voided.statusCode).toBe(200);
    expect(voided.json().result).toBe("voided");
    expect(voided.json().findings).toMatch(/VOIDED by a second person/);
    // With the corrective inspection withdrawn, the earlier one stands again.
    expect(voided.json().unit.percentVerifiedForPayment).toBe(90);
    expect(voided.json().unit.verifiedForPaymentBy).toBe(verifier.userId);
    expect((await post(`${base()}/inspections/${corrective.id}/void`, { reason: "Trying to void it twice." }, verifier.headers)).statusCode).toBe(400);

    const scheduled = await post(`${base()}/inspections`, { unitId: correctableId, kind: "witness", title: "Not yet held", scheduledFor: addDaysISO(today, 7) });
    expect((await post(`${base()}/inspections/${scheduled.json().id}/void`, { reason: "Nothing recorded yet at all." }, verifier.headers)).statusCode).toBe(400);
    expect((await post(`${base()}/inspections/${corrective.id}/void`, { reason: "Another tenant cannot reach this." }, stranger.headers)).statusCode).toBe(403);
  });

  it("does not write to the unit on a read", async () => {
    const before = await get(`${base()}/units/${correctableId}`);
    expect(before.statusCode).toBe(200);
    const stamp = before.json().updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 15));
    const after = await get(`${base()}/units/${correctableId}`);
    // A GET behind the read gate must not mutate the row: `updatedAt` still
    // means "last modified", not "last looked at".
    expect(after.json().updatedAt).toBe(stamp);
    expect((await get(`${base()}/units/${correctableId}`, viewerHeaders)).statusCode).toBe(200);
    const [row] = await app.db.select().from(offsiteUnits).where(eq(offsiteUnits.id, correctableId));
    expect(row!.updatedAt).toBe(stamp);
  });

  it("refuses a hand-set QA hold instead of accepting it and reverting it", async () => {
    const detail = await get(`${base()}/units/${correctableId}`);
    expect(detail.json().allowedTransitions).not.toContain("qa_hold");
    const held = await post(`${base()}/units/${correctableId}/transition`, { status: "qa_hold" });
    expect(held.statusCode).toBe(400);
    expect(held.json().message).toMatch(/not set by hand/);
  });
});
