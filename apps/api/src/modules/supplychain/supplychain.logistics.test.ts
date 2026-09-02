/**
 * Supply chain — logistics (gates, slot booking, arrival lifecycle, carbon
 * hook, chain effects, no-show sweep), traceability and the analytics
 * surface (summary, health inputs).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  carbonEntries,
  companyMemberships,
  locations,
  materialDeliveries,
  materialDeliveryLines,
  materialItems,
  projectMemberships,
  projects,
  signals,
  vendors,
} from "@constructos/db";
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
let vendorId: string;
let materialItemId: string;

const today = todayISO();
const day = addDaysISO(today, 2);
const at = (d: string, hhmm: string) => `${d}T${hhmm}:00.000Z`;

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
  await app.db.insert(projects).values({ id: projectId, companyId: owner.companyId, name: "Supply chain — logistics", stage: "course_of_construction" });
  await app.db.insert(projectMemberships).values({ id: newId("pm"), companyId: owner.companyId, projectId, userId: viewer.userId, templateKey: "read_only" });
  locationId = newId("loc");
  await app.db.insert(locations).values({ id: locationId, companyId: owner.companyId, projectId, name: "Core A / L2", path: locationId });
  vendorId = newId("ven");
  await app.db.insert(vendors).values({ id: vendorId, companyId: owner.companyId, name: "Steel Supplies Ltd" });
  materialItemId = newId("mat");
  await app.db.insert(materialItems).values({ id: materialItemId, companyId: owner.companyId, projectId, number: 1, reference: "MAT-001", name: "UB 305x165x40", unit: "t", createdBy: owner.userId });
});

afterAll(async () => {
  await built.close();
});

const lg = () => `/projects/${projectId}/supply-chain/logistics`;
const tr = () => `/projects/${projectId}/supply-chain/trace`;

let gateId: string;
let craneGateId: string;
let slotId: string;
let lateSlotId: string;

describe("site gates and slot booking", () => {
  it("creates gates and refuses impossible windows", async () => {
    const gate = await post(`${lg()}/gates`, { name: "Gate 1 — North", code: "G1", opensAt: "07:00", closesAt: "18:00", concurrentSlots: 1, slotMinutes: 30, maxVehicleType: "rigid_18t", craneAvailable: true, laydownAreas: ["A", "B"] });
    expect(gate.statusCode).toBe(201);
    gateId = gate.json().id;
    expect((await post(`${lg()}/gates`, { name: "Bad", opensAt: "18:00", closesAt: "07:00" })).statusCode).toBe(400);
    const crane = await post(`${lg()}/gates`, { name: "Gate 2 — Crane", concurrentSlots: 2, craneAvailable: true });
    craneGateId = crane.json().id;
    const list = await get(`${lg()}/gates`);
    expect(list.json().total).toBe(2);
  });

  it("books a slot, then refuses clashes, out-of-hours, oversize vehicles, crane double-booking and unknown laydown areas", async () => {
    const ok = await post(`${lg()}/slots`, { gateId, startsAt: at(day, "08:00"), endsAt: at(day, "08:30"), description: "Steel beams L3", vehicleType: "rigid_18t", craneRequired: true, laydownArea: "A", transportKm: 120, vendorId });
    expect(ok.statusCode).toBe(201);
    slotId = ok.json().id;
    expect(ok.json().reference).toBe("DEL-001");
    expect(ok.json().gateName).toBe("Gate 1 — North");
    expect(ok.json().carbonKgCo2e).toBeCloseTo(81.6, 1);
    expect(ok.json().carbonBasis).toMatch(/estimate/);

    const clash = await post(`${lg()}/slots`, { gateId, startsAt: at(day, "08:15"), endsAt: at(day, "08:45"), description: "Clash" });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().message).toMatch(/DEL-001/);
    const early = await post(`${lg()}/slots`, { gateId, startsAt: at(day, "06:00"), endsAt: at(day, "06:30"), description: "Too early" });
    expect(early.statusCode).toBe(409);
    expect(early.json().message).toMatch(/07:00/);
    const big = await post(`${lg()}/slots`, { gateId, startsAt: at(day, "10:00"), endsAt: at(day, "10:30"), description: "Artic", vehicleType: "articulated" });
    expect(big.statusCode).toBe(409);
    const laydown = await post(`${lg()}/slots`, { gateId, startsAt: at(day, "10:00"), endsAt: at(day, "10:30"), description: "Where", laydownArea: "Z" });
    expect(laydown.statusCode).toBe(409);
    const inverted = await post(`${lg()}/slots`, { gateId, startsAt: at(day, "10:30"), endsAt: at(day, "10:00"), description: "Backwards" });
    expect(inverted.statusCode).toBe(409);

    const craneA = await post(`${lg()}/slots`, { gateId: craneGateId, startsAt: at(day, "09:00"), endsAt: at(day, "10:00"), description: "Precast stairs", craneRequired: true, vehicleType: "crane_lorry" });
    expect(craneA.statusCode).toBe(201);
    const craneB = await post(`${lg()}/slots`, { gateId: craneGateId, startsAt: at(day, "09:30"), endsAt: at(day, "10:30"), description: "Roof cassettes", craneRequired: true });
    expect(craneB.statusCode).toBe(409);
    expect(craneB.json().message).toMatch(/crane/i);
    const secondBay = await post(`${lg()}/slots`, { gateId: craneGateId, startsAt: at(day, "09:30"), endsAt: at(day, "10:30"), description: "Plasterboard", craneRequired: false });
    expect(secondBay.statusCode).toBe(201);

    const availability = await get(`${lg()}/gates/${gateId}/availability?date=${day}`);
    expect(availability.statusCode).toBe(200);
    const windows = availability.json().windows as Array<{ startsAt: string; endsAt: string }>;
    expect(windows[0]?.startsAt).toBe(at(day, "07:00"));
    expect(windows[0]?.endsAt).toBe(at(day, "08:00"));
    expect(windows[1]?.startsAt).toBe(at(day, "08:30"));
    expect(availability.json().booked).toHaveLength(1);

    expect((await post(`${lg()}/slots`, { gateId, startsAt: at(day, "11:00"), endsAt: at(day, "11:30"), description: "x", longLeadItemId: "lli_nope" })).statusCode).toBe(400);
    expect((await post(`${lg()}/slots`, { gateId: "gat_nope", startsAt: at(day, "11:00"), endsAt: at(day, "11:30"), description: "x" })).statusCode).toBe(404);
  });

  it("re-validates on reschedule and refuses to move a completed booking", async () => {
    const move = await patch(`${lg()}/slots/${slotId}`, { startsAt: at(day, "08:30"), endsAt: at(day, "09:00") });
    expect(move.statusCode).toBe(200);
    expect(move.json().startsAt).toBe(at(day, "08:30"));
    const back = await patch(`${lg()}/slots/${slotId}`, { startsAt: at(day, "08:00"), endsAt: at(day, "08:30") });
    expect(back.statusCode).toBe(200);
    const list = await get(`${lg()}/slots?from=${day}&to=${day}&gateId=${gateId}`);
    expect(list.json().total).toBe(1);
  });
});

describe("delivery lifecycle, on-time analytics and the carbon hook", () => {
  it("walks confirm → arrive → unloading → complete, writing the A4 carbon entry", async () => {
    expect((await post(`${lg()}/slots/${slotId}/complete`, {})).statusCode).toBe(400);
    expect((await post(`${lg()}/slots/${slotId}/confirm`, {})).json().status).toBe("confirmed");
    const arrived = await post(`${lg()}/slots/${slotId}/arrive`, { arrivedAt: at(day, "08:10"), vehicleRegistration: "AB12 CDE" });
    expect(arrived.statusCode).toBe(200);
    expect(arrived.json().wasOnTime).toBe(1);
    expect(arrived.json().lateMinutes).toBe(10);
    const unloading = await post(`${lg()}/slots/${slotId}/unloading`, { at: at(day, "08:30") });
    expect(unloading.json().waitingMinutes).toBe(20);
    const noNotes = await post(`${lg()}/slots/${slotId}/complete`, { completedAt: at(day, "08:55"), issueKind: "damage" });
    expect(noNotes.statusCode).toBe(400);
    const done = await post(`${lg()}/slots/${slotId}/complete`, { completedAt: at(day, "08:55"), issueKind: "damage", issueNotes: "Two beams with bent flanges — photos attached" });
    expect(done.statusCode).toBe(200);
    expect(done.json().status).toBe("completed");
    expect(done.json().carbon.kgCo2e).toBeCloseTo(81.6, 1);
    expect(done.json().carbonEntryId).toBeTruthy();
    const [entry] = await app.db.select().from(carbonEntries).where(eq(carbonEntries.id, done.json().carbonEntryId));
    expect(entry?.lifecycleModule).toBe("A4");
    expect(entry?.scope).toBe("scope_3");
    expect(entry?.tco2e).toBeCloseTo(0.0816, 4);
    expect(entry?.quantity).toBe(120);
    expect(entry?.projectId).toBe(projectId);

    // Changing the distance afterwards updates the same entry rather than adding one.
    const more = await patch(`${lg()}/slots/${slotId}`, { transportKm: 200 });
    expect(more.statusCode).toBe(200);
    expect(more.json().carbonKgCo2e).toBeCloseTo(136, 1);
    expect(more.json().carbonEntryId).toBe(done.json().carbonEntryId);
    expect(more.json().craneRequired).toBe(1);
    expect(more.json().laydownArea).toBe("A");
    const entries = await app.db.select().from(carbonEntries).where(eq(carbonEntries.projectId, projectId));
    expect(entries).toHaveLength(1);
    expect((await patch(`${lg()}/slots/${slotId}`, { startsAt: at(day, "12:00"), endsAt: at(day, "12:30") })).statusCode).toBe(400);
  });

  it("records a late arrival and reports on-time delivery per supplier with the method stated", async () => {
    const late = await post(`${lg()}/slots`, { gateId, startsAt: at(day, "14:00"), endsAt: at(day, "14:30"), description: "Rebar", vehicleType: "rigid_7_5t", vendorId, transportMode: "sea", transportKm: 8000 });
    lateSlotId = late.json().id;
    expect(late.json().carbonKgCo2e).toBeNull();
    expect(late.json().carbonBasis).toMatch(/load weight/);
    const arrived = await post(`${lg()}/slots/${lateSlotId}/arrive`, { arrivedAt: at(day, "14:40") });
    expect(arrived.json().wasOnTime).toBe(0);
    expect(arrived.json().lateMinutes).toBe(40);
    const done = await post(`${lg()}/slots/${lateSlotId}/complete`, { completedAt: at(day, "15:00") });
    expect(done.json().carbon.kgCo2e).toBeNull();
    expect(done.json().carbon.reasons[0]).toMatch(/load weight/);

    const stats = await get(`${lg()}/on-time?from=${day}&to=${day}`);
    expect(stats.statusCode).toBe(200);
    expect(stats.json().overall.completed).toBe(2);
    expect(stats.json().overall.onTime).toBe(1);
    expect(stats.json().overall.late).toBe(1);
    expect(stats.json().overall.onTimePercent).toBe(50);
    expect(stats.json().overall.averageLateMinutes).toBe(40);
    expect(stats.json().issues.damage).toBe(1);
    expect(stats.json().carbon.deliveriesWithoutDistance).toBe(1);
    expect(stats.json().method).toMatch(/15 minutes/);
    // Every gate with a booking in the window gets a bucket — including the
    // crane gate, whose two bookings are still open. Its percentage is null
    // with the reason rather than a flattering (or damning) zero.
    const byGate = stats.json().byGate as Array<{ key: string; completed: number; onTimePercent: number | null; reasons: string[] }>;
    expect(byGate).toHaveLength(2);
    const main = byGate.find((g) => g.key === gateId);
    expect(main?.completed).toBe(2);
    expect(main?.onTimePercent).toBe(50);
    const crane = byGate.find((g) => g.key === craneGateId);
    expect(crane?.completed).toBe(0);
    expect(crane?.onTimePercent).toBeNull();
    expect(crane?.reasons[0]).toMatch(/No completed deliveries/);
  });

  it("marks bookings that never arrived as no-shows through the scheduler, once", async () => {
    const past = addDaysISO(today, -3);
    const ghost = await post(`${lg()}/slots`, { gateId, startsAt: at(past, "09:00"), endsAt: at(past, "09:30"), description: "Never came" });
    expect(ghost.statusCode).toBe(201);
    const job = await app.scheduler.runNow("supplychain.delivery-no-show");
    expect(job.state).toBe("succeeded");
    const after = await get(`${lg()}/slots/${ghost.json().id}`);
    expect(after.json().status).toBe("no_show");
    const sigs = await app.db.select().from(signals).where(and(eq(signals.projectId, projectId), eq(signals.detector, "supply_delivery_no_show")));
    expect(sigs).toHaveLength(1);
    await app.scheduler.runNow("supplychain.delivery-no-show");
    expect((await app.db.select().from(signals).where(and(eq(signals.projectId, projectId), eq(signals.detector, "supply_delivery_no_show")))).length).toBe(1);
    // The record can still be corrected: it did arrive, late, after all.
    const corrected = await post(`${lg()}/slots/${ghost.json().id}/arrive`, { arrivedAt: at(past, "11:00") });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json().status).toBe("arrived");
    expect((await post(`${lg()}/slots/${ghost.json().id}/cancel`, { reason: "x" })).statusCode).toBe(400);
  });

  it("moves the chain it carries: a long-lead item arrives and an offsite unit is delivered on completion", async () => {
    const item = await post(`/projects/${projectId}/supply-chain/long-lead`, { name: "Curtain wall units", leadTimeDays: 30, requiredOnSite: addDaysISO(today, 40) });
    for (const milestone of ["ordered", "production_started", "shipped"]) {
      expect((await post(`/projects/${projectId}/supply-chain/long-lead/${item.json().id}/milestones`, { milestone, at: today })).statusCode).toBe(200);
    }
    const unit = await post(`/projects/${projectId}/supply-chain/offsite/units`, { name: "Plant room module", unitType: "mep_module", stages: [{ name: "Assemble" }] });
    const stageId = (await get(`/projects/${projectId}/supply-chain/offsite/units/${unit.json().id}`)).json().stages[0].id as string;
    await post(`/projects/${projectId}/supply-chain/offsite/units/${unit.json().id}/stages/${stageId}/complete`, {});
    expect((await post(`/projects/${projectId}/supply-chain/offsite/units/${unit.json().id}/transition`, { status: "ready_to_ship" })).statusCode).toBe(200);

    const slot = await post(`${lg()}/slots`, { gateId: craneGateId, startsAt: at(day, "13:00"), endsAt: at(day, "14:00"), description: "Module + CW units", craneRequired: true, longLeadItemId: item.json().id, offsiteUnitId: unit.json().id, transportKm: 60, vehicleType: "low_loader" });
    expect(slot.statusCode).toBe(201);
    const unitLinked = await get(`/projects/${projectId}/supply-chain/offsite/units/${unit.json().id}`);
    expect(unitLinked.json().deliverySlotId).toBe(slot.json().id);
    await post(`${lg()}/slots/${slot.json().id}/arrive`, { arrivedAt: at(day, "13:05") });
    const done = await post(`${lg()}/slots/${slot.json().id}/complete`, { completedAt: at(day, "13:50") });
    expect(done.statusCode).toBe(200);
    expect(done.json().effects.longLeadItem.to).toBe("arrived");
    expect(done.json().effects.offsiteUnit.to).toBe("delivered");
    const itemAfter = await get(`/projects/${projectId}/supply-chain/long-lead/${item.json().id}`);
    expect(itemAfter.json().status).toBe("arrived");
    expect(itemAfter.json().actualArrivalDate).toBe(day);
    const unitAfter = await get(`/projects/${projectId}/supply-chain/offsite/units/${unit.json().id}`);
    expect(unitAfter.json().status).toBe("delivered");
    const detail = await get(`${lg()}/slots/${slot.json().id}`);
    expect(detail.json().longLeadItem.status).toBe("arrived");
    expect(detail.json().offsiteUnit.status).toBe("delivered");
  });

  it("cancels, refuses gate deletion with live bookings, and isolates tenants", async () => {
    const toCancel = await post(`${lg()}/slots`, { gateId, startsAt: at(day, "16:00"), endsAt: at(day, "16:30"), description: "Cancelled later" });
    const cancelled = await post(`${lg()}/slots/${toCancel.json().id}/cancel`, { reason: "Supplier rescheduled" });
    expect(cancelled.json().status).toBe("cancelled");
    expect((await patch(`${lg()}/slots/${toCancel.json().id}`, { description: "x" })).statusCode).toBe(400);
    const live = await post(`${lg()}/slots`, { gateId, startsAt: at(day, "16:00"), endsAt: at(day, "16:30"), description: "Live" });
    expect(live.statusCode).toBe(201);
    expect((await del(`${lg()}/gates/${gateId}`)).statusCode).toBe(400);
    expect((await del(`${lg()}/gates/${gateId}`, viewerHeaders)).statusCode).toBe(403);
    expect((await get(`${lg()}/slots`, viewerHeaders)).statusCode).toBe(200);
    expect((await post(`${lg()}/slots`, { gateId, startsAt: at(day, "17:00"), endsAt: at(day, "17:30"), description: "x" }, viewerHeaders)).statusCode).toBe(403);
    expect((await get(`${lg()}/slots/${slotId}`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${lg()}/gates`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${lg()}/on-time`, stranger.headers)).statusCode).toBe(403);
  });
});

/* ================================================================== */
/* Traceability                                                        */
/* ================================================================== */

let traceId: string;

describe("material traceability", () => {
  it("creates a lot, names the gaps, and closes the chain through a second-person verification and installation", async () => {
    expect((await post(`${tr()}/records`, { description: "no identifier" })).statusCode).toBe(400);
    const res = await post(`${tr()}/records`, { description: "UB 305x165x40 — 12 lengths", materialType: "structural_steel", heatNumber: "H-4471", manufacturer: "Steelworks AG", originCountry: "de", materialItemId, vendorId, requiresConformityMarking: true, quantity: 4.8, unit: "t" });
    expect(res.statusCode).toBe(201);
    traceId = res.json().id;
    expect(res.json().reference).toBe("TRC-001");
    expect(res.json().status).toBe("received");
    expect(res.json().originCountry).toBe("DE");
    expect(res.json().chain.complete).toBe(false);
    expect(res.json().chain.gaps.some((g: string) => /No mill\/test certificate/.test(g))).toBe(true);
    expect(res.json().chain.gaps.some((g: string) => /CE\/UKCA/.test(g))).toBe(true);

    const cert = await post(`${tr()}/records/${traceId}/certificates`, { kind: "mill_certificate", reference: "MC-2026-118", fileId: "file_mc", issuedBy: "Steelworks AG" });
    expect(cert.statusCode).toBe(201);
    expect(cert.json().status).toBe("certified");
    expect(cert.json().certificateCount).toBe(1);
    const certId = cert.json().certificate.id as string;
    expect((await post(`${tr()}/records/${traceId}/certificates/${certId}/verify`, {})).statusCode).toBe(403);
    const verified = await post(`${tr()}/records/${traceId}/certificates/${certId}/verify`, { note: "Checked against the EN 10204 3.1 original" }, verifier.headers);
    expect(verified.statusCode).toBe(200);
    expect(verified.json().chain.links.certificateVerified).toBe(true);
    expect((await post(`${tr()}/records/${traceId}/certificates/${certId}/verify`, {}, verifier.headers)).statusCode).toBe(400);

    const marked = await patch(`${tr()}/records/${traceId}`, { conformityMarking: "CE 0038-CPR-2026" });
    expect(marked.json().chain.links.conformityMarking).toBe(true);
    expect((await post(`${tr()}/records/${traceId}/install`, { installedLocationId: "loc_nope" })).statusCode).toBe(400);
    const installed = await post(`${tr()}/records/${traceId}/install`, { installedLocationId: locationId, installedRef: "Beam B3-07" });
    expect(installed.statusCode).toBe(200);
    expect(installed.json().status).toBe("installed");
    expect(installed.json().chain.complete).toBe(true);
    expect(installed.json().chain.score).toBe(100);
    expect(installed.json().warnings).toEqual([]);
    expect((await patch(`${tr()}/records/${traceId}`, { description: "x" })).statusCode).toBe(400);
    expect((await post(`${tr()}/records/${traceId}/reject`, { reason: "x" })).statusCode).toBe(400);

    const lookup = await get(`${tr()}/lookup?heat=h-4471`);
    expect(lookup.json().total).toBe(1);
    expect(lookup.json().items[0].installedLocationId).toBe(locationId);
    expect((await get(`${tr()}/lookup`)).statusCode).toBe(400);
  });

  it("quarantines, releases and rejects lots, and warns on installing without a certificate", async () => {
    const lot = await post(`${tr()}/records`, { description: "Rebar B500B", batchNumber: "B-77", vendorId });
    const id = lot.json().id;
    expect((await post(`${tr()}/records/${id}/release`, { note: "x" })).statusCode).toBe(400);
    const q = await post(`${tr()}/records/${id}/quarantine`, { reason: "Certificate mismatch" });
    expect(q.json().status).toBe("quarantined");
    expect((await post(`${tr()}/records/${id}/install`, { installedLocationId: locationId })).statusCode).toBe(400);
    const rel = await post(`${tr()}/records/${id}/release`, { note: "Corrected cert received" });
    expect(rel.json().status).toBe("received");
    const installed = await post(`${tr()}/records/${id}/install`, { installedLocationId: locationId });
    expect(installed.json().warnings[0]).toMatch(/without a vouching certificate/);
    expect(installed.json().chain.complete).toBe(false);

    const bad = await post(`${tr()}/records`, { description: "Bolts", lotNumber: "L-1" });
    const rejected = await post(`${tr()}/records/${bad.json().id}/reject`, { reason: "Wrong grade" });
    expect(rejected.json().status).toBe("rejected");
    expect((await post(`${tr()}/records/${bad.json().id}/certificates`, { kind: "test_certificate", reference: "x" })).statusCode).toBe(400);
  });

  it("lifts heat and batch numbers from a material delivery into trace records once", async () => {
    const deliveryId = newId("mdl");
    await app.db.insert(materialDeliveries).values({ id: deliveryId, companyId: owner.companyId, projectId, number: 1, reference: "DLV-001", supplierVendorId: vendorId, status: "received", receivedAt: new Date().toISOString(), createdBy: owner.userId });
    await app.db.insert(materialDeliveryLines).values([
      { id: newId("mdln"), companyId: owner.companyId, projectId, deliveryId, materialItemId, position: 0, description: "UB 305x165x40", unit: "t", quantityReceived: 4, quantityAccepted: 4, heatNumber: "H-9001", certificateFileIds: ["file_mc9001"] },
      { id: newId("mdln"), companyId: owner.companyId, projectId, deliveryId, position: 1, description: "Shims", unit: "ea", quantityReceived: 40, quantityAccepted: 40 },
    ]);
    const lifted = await post(`${tr()}/from-delivery/${deliveryId}`, { materialType: "structural_steel" });
    expect(lifted.statusCode).toBe(201);
    expect(lifted.json().created).toHaveLength(1);
    expect(lifted.json().skipped).toHaveLength(1);
    expect(lifted.json().skipped[0].reason).toMatch(/no heat, batch or serial/);
    const record = await get(`${tr()}/records/${lifted.json().created[0].id}`);
    expect(record.json().heatNumber).toBe("H-9001");
    expect(record.json().status).toBe("certified");
    expect(record.json().materialItemId).toBe(materialItemId);
    expect(record.json().vendorId).toBe(vendorId);
    const again = await post(`${tr()}/from-delivery/${deliveryId}`, {});
    expect(again.json().created).toHaveLength(0);
    expect(again.json().skipped.some((s: { reason: string }) => s.reason === "already traced")).toBe(true);
    expect((await post(`${tr()}/from-delivery/mdl_nope`, {})).statusCode).toBe(404);
  });

  it("reports coverage and enforces gates and tenancy", async () => {
    const coverage = await get(`${tr()}/coverage`);
    expect(coverage.statusCode).toBe(200);
    expect(coverage.json().records).toBe(4);
    expect(coverage.json().complete).toBe(1);
    expect(coverage.json().installed).toBe(2);
    expect(coverage.json().installedWithoutCertificate).toBe(1);
    expect(coverage.json().byMaterialType.some((b: { materialType: string }) => b.materialType === "structural_steel")).toBe(true);
    const list = await get(`${tr()}/records?chainComplete=1`);
    expect(list.json().total).toBe(1);
    expect((await get(`${tr()}/records`, viewerHeaders)).statusCode).toBe(200);
    expect((await post(`${tr()}/records`, { description: "x", heatNumber: "H" }, viewerHeaders)).statusCode).toBe(403);
    expect((await get(`${tr()}/records/${traceId}`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${tr()}/coverage`, stranger.headers)).statusCode).toBe(403);
  });
});

/* ================================================================== */
/* Analytics                                                           */
/* ================================================================== */

describe("summary and health inputs", () => {
  it("returns figures with their basis and nulls with reasons", async () => {
    const summary = await get(`/projects/${projectId}/supply-chain/summary`);
    expect(summary.statusCode).toBe(200);
    const s = summary.json();
    expect(s.deliveries.completed).toBe(3);
    expect(s.deliveries.onTimePercent.value).toBeCloseTo(66.7, 1);
    expect(s.deliveries.transportCarbonKgCo2e.value).toBeGreaterThan(100);
    expect(s.deliveries.transportCarbonKgCo2e.reasons[0]).toMatch(/no distance/);
    expect(s.longLead.open).toBe(0);
    expect(s.offsite.units).toBe(1);
    expect(s.offsite.averagePercentComplete.value).toBeNull();
    expect(s.traceability.records).toBe(4);
    expect(s.map.nodes).toBe(0);
    expect(s.signals.open).toBeGreaterThanOrEqual(1);
    // The roll-up reads every register under a ceiling and says so when it hits one.
    expect(s.truncated).toEqual([]);

    const health = await get(`/projects/${projectId}/supply-chain/health-inputs`);
    expect(health.statusCode).toBe(200);
    expect(health.json().metrics.onTimeDeliveryPercent).toBeCloseTo(66.7, 1);
    expect(health.json().metrics.longLeadLate).toBeNull();
    expect(health.json().metrics.supplierRiskCritical).toBeNull();
    expect(health.json().metrics.traceChainCompletePercent).toBe(25);
    expect(health.json().reasons.some((r: string) => /No open long-lead/.test(r))).toBe(true);

    const open = await get(`/projects/${projectId}/supply-chain/signals`);
    expect(open.json().items.some((x: { detector: string }) => x.detector === "supply_delivery_no_show")).toBe(true);
    expect((await get(`/projects/${projectId}/supply-chain/summary`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`/projects/${projectId}/supply-chain/health-inputs`, stranger.headers)).statusCode).toBe(403);
  });
});
