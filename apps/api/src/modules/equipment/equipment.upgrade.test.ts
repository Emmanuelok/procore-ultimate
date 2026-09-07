/**
 * WP-EQUIP regressions and new capability — plant, materials and telematics.
 *
 * Every `it` in the "regressions" describe corresponds to a reported defect and
 * fails on the code as it was.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  assertions,
  budgetLineItems,
  budgets,
  companyMemberships,
  equipment,
  equipmentCertificates,
  equipmentMaintenanceSchedules,
  equipmentReadings,
  equipmentTelematicsReadings,
  evidence,
  materialItems,
  projectMemberships,
  projects,
  reconciliations,
  signals,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let verifier: TestActor;
/** company MEMBER with no project membership at all — the guest case */
let guestHeaders: Record<string, string>;
/** read-only member of one project — may read the fleet, may not write it */
let readerHeaders: Record<string, string>;
/** project_manager on projectA ONLY — the transfer-destination case */
let moverHeaders: Record<string, string>;
let stranger: TestActor;
let projectA: string;
let projectB: string;
let vendorId: string;

const today = () => todayISO();
const daysAgo = (n: number) => addDaysISO(todayISO(), -n);
const daysAhead = (n: number) => addDaysISO(todayISO(), n);

function post(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload });
}
function get(url: string, headers = owner.headers) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers });
}
function patch(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload });
}

async function makeProject(name: string): Promise<string> {
  const id = newId("prj");
  await app.db
    .insert(projects)
    .values({ id, companyId: owner.companyId, name, stage: "course_of_construction" });
  return id;
}

async function makeMachine(over: Record<string, unknown> = {}): Promise<string> {
  const res = await post("/companies/current/equipment", {
    name: "Upgrade excavator",
    category: "earthmoving",
    ownership: "hired",
    currency: "GBP",
    hireRateAmount: 700,
    hireRateUnit: "day",
    meterType: "hours",
    ...over,
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function assign(projectId: string, equipmentId: string): Promise<string> {
  const created = await post(`/projects/${projectId}/equipment/assignments`, {
    equipmentId,
    assignedFrom: daysAgo(5),
  });
  expect(created.statusCode).toBe(201);
  return created.json().id as string;
}

async function mobilise(projectId: string, equipmentId: string): Promise<string> {
  const assignmentId = await assign(projectId, equipmentId);
  const approved = await post(
    `/projects/${projectId}/equipment/assignments/${assignmentId}/approve`,
    {},
    verifier.headers,
  );
  expect(approved.statusCode).toBe(200);
  const mob = await post(
    `/projects/${projectId}/equipment/assignments/${assignmentId}/mobilise`,
    { conditionOnArrival: "good" },
  );
  expect(mob.statusCode).toBe(200);
  return assignmentId;
}

async function sweep() {
  const res = await post("/companies/current/equipment/sweep", {});
  expect(res.statusCode).toBe(200);
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);

  verifier = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: verifier.userId,
    role: "admin",
  });
  verifier = {
    ...verifier,
    companyId: owner.companyId,
    headers: {
      authorization: verifier.headers["authorization"]!,
      "x-company-id": owner.companyId,
    },
  };

  const guest = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: guest.userId,
    role: "guest",
  });
  guestHeaders = {
    authorization: guest.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  const reader = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: reader.userId,
    role: "member",
  });
  readerHeaders = {
    authorization: reader.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  const mover = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: mover.userId,
    role: "member",
  });
  moverHeaders = {
    authorization: mover.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  stranger = await registerActor(app);

  projectA = await makeProject("Upgrade A");
  projectB = await makeProject("Upgrade B");
  await app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId: projectA,
    userId: reader.userId,
    templateKey: "read_only",
  });
  await app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId: projectA,
    userId: mover.userId,
    templateKey: "project_manager",
  });

  vendorId = newId("ven");
  await app.db
    .insert(vendors)
    .values({ id: vendorId, companyId: owner.companyId, name: "Upgrade Plant Hire" });
});

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* Regressions                                                         */
/* ================================================================== */

describe("regressions", () => {
  it("refuses the company fleet to a guest who holds equipment on no project", async () => {
    const res = await get("/companies/current/equipment", guestHeaders);
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("at least one project");
  });

  it("refuses the raw telematics feed and the certificate register to that guest too", async () => {
    for (const url of [
      "/companies/current/telematics/readings",
      "/companies/current/equipment-certificates",
      "/companies/current/equipment-maintenance",
    ]) {
      const res = await get(url, guestHeaders);
      expect(res.statusCode).toBe(403);
    }
  });

  it("lets a read-only project member read the fleet but not register plant on it", async () => {
    const read = await get("/companies/current/equipment", readerHeaders);
    expect(read.statusCode).toBe(200);

    const write = await post(
      "/companies/current/equipment",
      { name: "Sneaky excavator", category: "earthmoving" },
      readerHeaders,
    );
    expect(write.statusCode).toBe(403);
    expect(write.json().message).toContain("standard");
  });

  /*
   * "companies/current" is the CALLER's company, so a stranger asking for it
   * gets their own (empty) fleet, not a refusal — the tenancy boundary is
   * that they cannot reach OURS. Both halves are asserted: presenting our
   * company id is refused outright, and their own register is empty rather
   * than a window onto ours.
   */
  it("never shows a stranger from another company our fleet", async () => {
    const own = await get("/companies/current/equipment", stranger.headers);
    expect(own.statusCode).toBe(200);
    expect(own.json().items).toHaveLength(0);

    const ours = await get("/companies/current/equipment", {
      authorization: stranger.headers["authorization"]!,
      "x-company-id": owner.companyId,
    });
    expect([401, 403]).toContain(ours.statusCode);
  });

  /*
   * Plan §6.3: a company-level list over project data is narrowed to the
   * projects the caller can see. The gate admitted the read-only member
   * because they hold `equipment` on project A; that is not permission to
   * enumerate project B's plant, nor to reach it by guessing its id.
   */
  it("shows a member the plant on their own job and the yard, not another job's", async () => {
    const onB = await makeMachine({ name: "Machine on B" });
    await mobilise(projectB, onB);
    const inTheYard = await makeMachine({ name: "Machine in the yard" });

    const list = await get("/companies/current/equipment", readerHeaders);
    expect(list.statusCode).toBe(200);
    const names = (list.json().items as Array<{ id: string }>).map((m) => m.id);
    expect(names).toContain(inTheYard);
    expect(names).not.toContain(onB);

    // and not by naming it directly either
    const direct = await get(`/companies/current/equipment/${onB}`, readerHeaders);
    expect(direct.statusCode).toBe(404);

    // the owner still sees the whole fleet
    const all = await get("/companies/current/equipment?pageSize=200");
    expect((all.json().items as Array<{ id: string }>).map((m) => m.id)).toContain(onB);
  });

  it("does not flag a machine out of certificate when this year's renewal exists", async () => {
    const machineId = await makeMachine({ name: "Renewed crane", isCritical: true });
    await mobilise(projectA, machineId);

    // last year's examination, already expired
    const old = await post(`/companies/current/equipment/${machineId}/certificates`, {
      certificateType: "thorough_examination",
      validFrom: daysAgo(400),
      validTo: daysAgo(35),
      result: "pass",
    });
    expect(old.statusCode).toBe(201);
    await sweep();
    const flagged = await get(`/companies/current/equipment/${machineId}`);
    expect(flagged.json().derived.outOfCertificate).toBe(true);

    // this year's, added with NO supersedesId — the case that used to raise a
    // critical "stop the machine" signal against in-date plant
    const renewal = await post(`/companies/current/equipment/${machineId}/certificates`, {
      certificateType: "thorough_examination",
      validFrom: daysAgo(30),
      validTo: daysAhead(300),
      result: "pass",
    });
    expect(renewal.statusCode).toBe(201);
    await sweep();

    const after = await get(`/companies/current/equipment/${machineId}`);
    expect(after.json().derived.outOfCertificate).toBe(false);
    expect(after.json().nextCertificateExpiry).toBe(daysAhead(300));

    const rows = await app.db
      .select()
      .from(equipmentCertificates)
      .where(eq(equipmentCertificates.equipmentId, machineId));
    expect(rows.filter((r) => r.status === "superseded")).toHaveLength(1);
  });

  it("cancels an approved assignment that never arrived, freeing the machine", async () => {
    const machineId = await makeMachine({ name: "Never arrived" });
    const assignmentId = await assign(projectA, machineId);
    const approved = await post(
      `/projects/${projectA}/equipment/assignments/${assignmentId}/approve`,
      {},
      verifier.headers,
    );
    expect(approved.statusCode).toBe(200);

    // Blocked from every other project until it is cancelled.
    const blocked = await post(`/projects/${projectB}/equipment/assignments`, {
      equipmentId: machineId,
      assignedFrom: today(),
    });
    expect(blocked.statusCode).toBe(409);

    const cancelled = await post(
      `/projects/${projectA}/equipment/assignments/${assignmentId}/cancel`,
      { reason: "machine_unavailable", note: "never turned up" },
    );
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe("cancelled");

    const free = await post(`/projects/${projectB}/equipment/assignments`, {
      equipmentId: machineId,
      assignedFrom: today(),
    });
    expect(free.statusCode).toBe(201);
  });

  it("closes the live assignment when an off-hire is confirmed", async () => {
    const machineId = await makeMachine({ name: "Off-hired machine" });
    const assignmentId = await mobilise(projectA, machineId);
    await post(`/companies/current/equipment/${machineId}/off-hire`, { action: "request" });
    const confirmed = await post(
      `/companies/current/equipment/${machineId}/off-hire`,
      { action: "confirm" },
      verifier.headers,
    );
    expect(confirmed.statusCode).toBe(200);

    const detail = await get(`/companies/current/equipment/${machineId}`);
    const assignment = (detail.json().assignments as Array<{ id: string; status: string }>).find(
      (a) => a.id === assignmentId,
    );
    expect(assignment?.status).toBe("returned");
  });

  it("never moves the machine meter backwards from a back-filled plant sheet", async () => {
    const machineId = await makeMachine({ name: "Meter machine", currentMeterReading: 1200 });
    await mobilise(projectA, machineId);
    const backfill = await post(`/projects/${projectA}/equipment-utilisation`, {
      equipmentId: machineId,
      utilisationDate: daysAgo(7),
      availableHours: 10,
      workingHours: 8,
      meterEnd: 1000,
    });
    expect(backfill.statusCode).toBe(201);
    expect(backfill.json().meter.advanced).toBe(false);
    expect(backfill.json().meter.note).toContain("NOT been moved backwards");

    const [machine] = await app.db.select().from(equipment).where(eq(equipment.id, machineId));
    expect(machine?.currentMeterReading).toBe(1200);
  });

  it("refuses a stock movement against a company catalogue item", async () => {
    const itemId = newId("mat");
    await app.db.insert(materialItems).values({
      id: itemId,
      companyId: owner.companyId,
      projectId: null,
      number: 990001,
      reference: "MAT-CATALOGUE",
      name: "Catalogue rebar",
      unit: "t",
      quantityOnHand: 100,
      createdBy: owner.userId,
    });
    const res = await post(`/projects/${projectA}/material-stock-movements`, {
      materialItemId: itemId,
      movementType: "issue",
      quantity: 5,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("CATALOGUE");
  });

  it("books no stock at all when a later delivery line is invalid", async () => {
    const itemA = await post(`/projects/${projectA}/materials`, {
      name: "Atomic line A",
      unit: "no",
      quantityRequired: 100,
      isTracked: true,
    });
    expect(itemA.statusCode).toBe(201);
    const itemAId = itemA.json().id as string;
    const itemB = await post(`/projects/${projectA}/materials`, {
      name: "Atomic line B",
      unit: "no",
      quantityRequired: 100,
      isTracked: true,
    });
    const itemBId = itemB.json().id as string;

    const delivery = await post(`/projects/${projectA}/material-deliveries`, {
      supplierVendorId: vendorId,
      lines: [
        { materialItemId: itemAId, description: "Line A", quantityExpected: 10, unit: "no" },
        { materialItemId: itemBId, description: "Line B", quantityExpected: 10, unit: "no" },
      ],
    });
    expect(delivery.statusCode).toBe(201);
    const deliveryId = delivery.json().id as string;
    const lines = delivery.json().lines as Array<{ id: string; materialItemId: string }>;
    const lineA = lines.find((l) => l.materialItemId === itemAId)!;
    const lineB = lines.find((l) => l.materialItemId === itemBId)!;

    // Line B is rejected with no reason: the receipt must fail WHOLE.
    const bad = await post(`/projects/${projectA}/material-deliveries/${deliveryId}/receive`, {
      createStockMovements: true,
      lines: [
        { lineId: lineA.id, quantityReceived: 10, quantityAccepted: 10, quantityRejected: 0 },
        { lineId: lineB.id, quantityReceived: 10, quantityAccepted: 8, quantityRejected: 2 },
      ],
    });
    expect(bad.statusCode).toBe(400);

    const [a] = await app.db.select().from(materialItems).where(eq(materialItems.id, itemAId));
    expect(a?.quantityOnHand).toBe(0);
    expect(a?.quantityDelivered).toBe(0);

    // Corrected, it books once.
    const good = await post(`/projects/${projectA}/material-deliveries/${deliveryId}/receive`, {
      createStockMovements: true,
      lines: [
        { lineId: lineA.id, quantityReceived: 10, quantityAccepted: 10, quantityRejected: 0 },
        {
          lineId: lineB.id,
          quantityReceived: 10,
          quantityAccepted: 8,
          quantityRejected: 2,
          rejectionReason: "damaged in transit",
        },
      ],
    });
    expect(good.statusCode).toBe(200);
    const [a2] = await app.db.select().from(materialItems).where(eq(materialItems.id, itemAId));
    expect(a2?.quantityOnHand).toBe(10);
  });

  it("refuses a receipt that names the same delivery line twice", async () => {
    const item = await post(`/projects/${projectA}/materials`, {
      name: "Duplicate-entry blocks",
      unit: "no",
      quantityRequired: 100,
      isTracked: true,
    });
    expect(item.statusCode).toBe(201);
    const itemId = item.json().id as string;

    // Deliberately no supplierVendorId: this delivery exists to test the
    // receipt, and attributing it to a vendor would move that vendor's
    // scorecard sample size under the supplier-scorecard test below.
    const delivery = await post(`/projects/${projectA}/material-deliveries`, {
      lines: [
        { materialItemId: itemId, description: "One pallet", quantityExpected: 10, unit: "no" },
      ],
    });
    expect(delivery.statusCode).toBe(201);
    const deliveryId = delivery.json().id as string;
    const lineId = (delivery.json().lines as Array<{ id: string }>)[0]!.id;

    const res = await post(`/projects/${projectA}/material-deliveries/${deliveryId}/receive`, {
      createStockMovements: true,
      lines: [
        { lineId, quantityReceived: 10, quantityAccepted: 10, quantityRejected: 0 },
        { lineId, quantityReceived: 10, quantityAccepted: 10, quantityRejected: 0 },
      ],
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().message).toContain("more than");

    // Nothing was booked: one pallet cannot enter the compound twice.
    const [after] = await app.db.select().from(materialItems).where(eq(materialItems.id, itemId));
    expect(after?.quantityOnHand).toBe(0);
    expect(after?.quantityDelivered).toBe(0);
  });

  it("adds up two lines of the same material rather than losing one", async () => {
    const item = await post(`/projects/${projectA}/materials`, {
      name: "Two-pallet rebar",
      unit: "t",
      quantityRequired: 40,
      isTracked: true,
    });
    expect(item.statusCode).toBe(201);
    const itemId = item.json().id as string;

    // One delivery note, two lines of the SAME material — two pallets with
    // different heat numbers, which is how steel actually arrives.
    const delivery = await post(`/projects/${projectA}/material-deliveries`, {
      supplierVendorId: vendorId,
      lines: [
        {
          materialItemId: itemId,
          description: "Pallet 1",
          quantityExpected: 10,
          unit: "t",
          heatNumber: "H-1",
        },
        {
          materialItemId: itemId,
          description: "Pallet 2",
          quantityExpected: 12,
          unit: "t",
          heatNumber: "H-2",
        },
      ],
    });
    expect(delivery.statusCode).toBe(201);
    const deliveryId = delivery.json().id as string;
    const lines = delivery.json().lines as Array<{ id: string; description: string }>;
    const one = lines.find((l) => l.description === "Pallet 1")!;
    const two = lines.find((l) => l.description === "Pallet 2")!;

    const received = await post(
      `/projects/${projectA}/material-deliveries/${deliveryId}/receive`,
      {
        createStockMovements: true,
        lines: [
          { lineId: one.id, quantityReceived: 10, quantityAccepted: 10, quantityRejected: 0 },
          {
            lineId: two.id,
            quantityReceived: 12,
            quantityAccepted: 11,
            quantityRejected: 1,
            rejectionReason: "one bundle out of tolerance",
          },
        ],
      },
    );
    expect(received.statusCode).toBe(200);

    const [row] = await app.db.select().from(materialItems).where(eq(materialItems.id, itemId));
    // 10 + 12 delivered, 10 + 11 accepted, 0 + 1 rejected — the roll-up is the
    // sum of the lines, not whichever line happened to be written last.
    expect(row?.quantityDelivered).toBe(22);
    expect(row?.quantityAccepted).toBe(21);
    expect(row?.quantityRejected).toBe(1);
    // Both receipts reached the compound, and the balance is their sum.
    expect(row?.quantityOnHand).toBe(21);

    const movements = received.json().stockMovements as Array<{ balanceAfter: number | null }>;
    expect(movements).toHaveLength(2);
    expect(movements.map((m) => m.balanceAfter)).toEqual([10, 21]);
  });

  it("costs owned plant at its internal charge-out rate", async () => {
    const machineId = await makeMachine({
      name: "Owned dumper",
      ownership: "owned",
      hireRateAmount: null,
      hireRateUnit: null,
      internalRateAmount: 40,
      currency: "GBP",
    });
    await mobilise(projectB, machineId);
    const day = await post(`/projects/${projectB}/equipment-utilisation`, {
      equipmentId: machineId,
      utilisationDate: today(),
      availableHours: 10,
      workingHours: 8,
      idleHours: 2,
      idleReason: "awaiting_materials",
    });
    expect(day.statusCode, day.body).toBe(201);
    expect(day.json().cost.hireCost).toBe(400);
    expect(day.json().cost.basis.hire).toContain("internal charge-out rate");
  });

  it("keeps a closed meter-based schedule closed after the next sweep", async () => {
    const machineId = await makeMachine({
      name: "Serviced machine",
      currentMeterReading: 500,
      isCritical: true,
    });
    const schedule = await post(
      `/companies/current/equipment/${machineId}/maintenance-schedules`,
      {
        name: "500 hour service",
        maintenanceType: "preventive",
        intervalKind: "operating_hours",
        intervalValue: 250,
        lastPerformedMeter: 100,
      },
    );
    expect(schedule.statusCode).toBe(201);
    const scheduleId = schedule.json().id as string;
    await sweep();
    const overdue = await app.db
      .select()
      .from(equipmentMaintenanceSchedules)
      .where(eq(equipmentMaintenanceSchedules.id, scheduleId));
    expect(overdue[0]?.status).toBe("overdue");

    // Close it WITHOUT a meter reading — the case that used to store the old
    // baseline and flip straight back to overdue.
    const record = await post(`/companies/current/equipment/${machineId}/maintenance-records`, {
      scheduleId,
      maintenanceType: "preventive",
      description: "500 hour service done",
      performedAt: new Date().toISOString(),
      result: "completed",
    });
    expect(record.statusCode).toBe(201);
    await sweep();
    const after = await app.db
      .select()
      .from(equipmentMaintenanceSchedules)
      .where(eq(equipmentMaintenanceSchedules.id, scheduleId));
    expect(after[0]?.status).not.toBe("overdue");
    expect(after[0]?.lastPerformedMeter).toBe(500);
  });
});

/* ================================================================== */
/* New capability                                                      */
/* ================================================================== */

describe("plant lifecycle and availability", () => {
  it("transfers a machine between projects, carrying the approval with it", async () => {
    const machineId = await makeMachine({ name: "Transferred machine" });
    const assignmentId = await mobilise(projectA, machineId);
    const res = await post(
      `/projects/${projectA}/equipment/assignments/${assignmentId}/transfer`,
      { toProjectId: projectB, mobilisationCost: 450 },
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().from.status).toBe("returned");
    expect(res.json().to.projectId).toBe(projectB);
    expect(res.json().to.status).toBe("approved");
    expect(res.json().to.fromProjectId).toBe(projectA);
  });

  it("refuses a transfer onto a project the caller holds no equipment permission on", async () => {
    const machineId = await makeMachine({ name: "Cross-project push" });
    const assignmentId = await mobilise(projectA, machineId);
    // `mover` is project_manager on projectA (equipment standard) and holds
    // nothing at all on projectB. The gate on :projectId is satisfied; the
    // destination is where the hire cost lands.
    const res = await post(
      `/projects/${projectA}/equipment/assignments/${assignmentId}/transfer`,
      { toProjectId: projectB },
      moverHeaders,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("equipment on project");
    // and nothing moved
    const [row] = await app.db
      .select({ projectId: equipment.projectId })
      .from(equipment)
      .where(eq(equipment.id, machineId));
    expect(row!.projectId).toBe(projectA);
  });

  it("allows the same transfer once the caller holds the tool on the destination", async () => {
    const machineId = await makeMachine({ name: "Cross-project allowed" });
    const assignmentId = await mobilise(projectA, machineId);
    const res = await post(
      `/projects/${projectA}/equipment/assignments/${assignmentId}/transfer`,
      { toProjectId: projectB },
      owner.headers,
    );
    expect(res.statusCode).toBe(201);
  });

  it("refuses a transfer to the project the machine is already on", async () => {
    const machineId = await makeMachine({ name: "Same project transfer" });
    const assignmentId = await mobilise(projectA, machineId);
    const res = await post(
      `/projects/${projectA}/equipment/assignments/${assignmentId}/transfer`,
      { toProjectId: projectA },
    );
    expect(res.statusCode).toBe(400);
  });

  it("answers what is free between two dates, with the caveats", async () => {
    const machineId = await makeMachine({
      name: "Availability machine",
      hireEndDate: daysAhead(3),
    });
    const res = await get(
      `/companies/current/equipment-availability?from=${today()}&to=${daysAhead(10)}`,
    );
    expect(res.statusCode).toBe(200);
    const row = (res.json().available as Array<{ id: string; caveats: string[] }>).find(
      (r) => r.id === machineId,
    );
    expect(row).toBeDefined();
    expect(row!.caveats.join(" ")).toContain("hire agreement ends");
  });
});

describe("materials supply", () => {
  it("computes the order-by date and flags one that has passed", async () => {
    const item = await post(`/projects/${projectB}/materials`, {
      name: "Long lead switchgear",
      unit: "no",
      quantityRequired: 4,
      leadTimeDays: 90,
      requiredOnSiteDate: daysAhead(30),
      unitCost: 25000,
      currency: "GBP",
    });
    expect(item.statusCode).toBe(201);

    const supply = await get(`/projects/${projectB}/materials/supply`);
    expect(supply.statusCode).toBe(200);
    const row = (
      supply.json().items as Array<{ name: string; risk: string; orderByDate: string | null }>
    ).find((i) => i.name === "Long lead switchgear");
    expect(row?.risk).toBe("order_by_date_missed");
    expect(row?.orderByDate).toBe(addDaysISO(daysAhead(30), -95));

    const run = await post(`/projects/${projectB}/materials/supply/run`, {});
    expect(run.statusCode).toBe(200);
    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "material_order_by_date_missed"),
        ),
      );
    expect(raised.length).toBeGreaterThanOrEqual(1);

    // Idempotent: a second run raises nothing new.
    const again = await post(`/projects/${projectB}/materials/supply/run`, {});
    expect(again.json().raised).toBe(0);
  });

  it("returns from a forced-negative movement instead of deadlocking on the signal write", async () => {
    // The signal that records a knowingly forced negative used to be read and
    // written on the OUTER database handle from inside the open transaction
    // that locks the material row. PGlite is one connection behind an
    // exclusive mutex, so the write waited for the transaction and the
    // transaction waited for the write: the request never returned, and every
    // later request in the process hung behind it.
    const created = await post(`/projects/${projectB}/materials`, {
      name: "Deadlock ballast",
      unit: "t",
      quantityRequired: 10,
      unitCost: 40,
      currency: "GBP",
      isTracked: true,
    });
    expect(created.statusCode).toBe(201);
    const materialItemId = created.json().id as string;

    const forced = await post(`/projects/${projectB}/material-stock-movements`, {
      materialItemId,
      movementType: "issue",
      quantity: 6,
      reason: "Poured before the delivery was booked in",
      allowNegative: true,
    });
    expect(forced.statusCode).toBe(201);
    expect(forced.json().forcedNegative).toBe(true);
    expect(forced.json().balance.after).toBe(-6);
    expect(forced.json().signalId).toBeTruthy();

    // The signal landed, and it landed inside the movement's transaction.
    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "material_stock_negative"),
          eq(signals.id, forced.json().signalId as string),
        ),
      );
    expect(raised).toHaveLength(1);

    // And the connection is free: the next request answers rather than hanging.
    const after = await get(`/projects/${projectB}/materials`);
    expect(after.statusCode).toBe(200);
  });

  it("says an item with no lead time has no order-by date, rather than guessing one", async () => {
    const item = await post(`/projects/${projectB}/materials`, {
      name: "Unknown lead item",
      unit: "no",
      quantityRequired: 1,
      requiredOnSiteDate: daysAhead(10),
    });
    expect(item.statusCode).toBe(201);
    const supply = await get(`/projects/${projectB}/materials/supply`);
    const row = (
      supply.json().items as Array<{ name: string; risk: string; reasons: string[] }>
    ).find((i) => i.name === "Unknown lead item");
    expect(row?.risk).toBe("unknown");
    expect(row?.reasons.join(" ")).toContain("lead time of zero is a claim");
  });

  it("scores suppliers on deliveries and refuses to score too few", async () => {
    const res = await get("/companies/current/materials/supplier-scorecard");
    expect(res.statusCode).toBe(200);
    const row = (
      res.json().items as Array<{ vendorId: string; score: number | null; reasons: string[] }>
    ).find((r) => r.vendorId === vendorId);
    if (row) {
      expect(row.score).toBeNull();
      expect(row.reasons.join(" ")).toContain("fewer than the 3");
    }
  });
});

describe("telematics day hours", () => {
  it("states a once-a-day device's hours instead of calling the plant sheet unsupported", async () => {
    const machineId = await makeMachine({
      name: "Once-a-day feed",
      telematicsProvider: "generic_aemp",
      telematicsDeviceId: "DEV-DAILY-1",
      hireRateAmount: 40,
      hireRateUnit: "hour",
      operatorRateAmount: 30,
      currency: "GBP",
    });
    await mobilise(projectA, machineId);

    /*
     * A device that reports ONCE a day. Within-day last-minus-first has
     * nothing to subtract, so before the carry-in fix every day came back
     * null: the machine looked as if it had never reported, the plant sheet
     * had no corroboration, and the operator's honest 8 and 9 hours sat in
     * `daysWithoutTelematics` for ever.
     */
    const counters: Array<[string, number]> = [
      [daysAgo(3), 1000],
      [daysAgo(2), 1008],
      [daysAgo(1), 1017],
    ];
    for (const [date, engineHours] of counters) {
      await app.db.insert(equipmentTelematicsReadings).values({
        id: newId("etr"),
        companyId: owner.companyId,
        projectId: projectA,
        equipmentId: machineId,
        providerKey: "generic_aemp",
        deviceId: "DEV-DAILY-1",
        recordedAt: `${date}T17:00:00.000Z`,
        engineHours,
      });
    }
    for (const [date, hours] of [
      [daysAgo(2), 8],
      [daysAgo(1), 9],
    ] as const) {
      const res = await post(`/projects/${projectA}/equipment-utilisation`, {
        equipmentId: machineId,
        utilisationDate: date,
        availableHours: 10,
        workingHours: hours,
      });
      expect(res.statusCode).toBe(201);
    }

    const res = await get(
      `/projects/${projectA}/equipment-telematics/reconciliation?from=${daysAgo(2)}&to=${daysAgo(1)}`,
    );
    expect(res.statusCode).toBe(200);
    const row = res
      .json()
      .rows.find((r: { equipmentId: string }) => r.equipmentId === machineId);
    expect(row).toBeDefined();
    expect(row.daysCompared).toBe(2);
    expect(row.daysWithoutTelematics).toBe(0);
    // 1008 − 1000 = 8 on the first day, 1017 − 1008 = 9 on the second
    expect(row.telematicsHours).toBe(17);
    expect(row.varianceHours).toBe(0);
    expect(row.daysUnsupported).toBe(0);
    expect(res.json().method).toContain("BEFORE it began");
  });

  it("does not turn a day the feed never reached into zero hours", async () => {
    const machineId = await makeMachine({
      name: "Silent day feed",
      telematicsProvider: "generic_aemp",
      telematicsDeviceId: "DEV-DAILY-2",
      hireRateAmount: 40,
      hireRateUnit: "hour",
      currency: "GBP",
    });
    await mobilise(projectA, machineId);
    await app.db.insert(equipmentTelematicsReadings).values({
      id: newId("etr"),
      companyId: owner.companyId,
      projectId: projectA,
      equipmentId: machineId,
      providerKey: "generic_aemp",
      deviceId: "DEV-DAILY-2",
      recordedAt: `${daysAgo(3)}T17:00:00.000Z`,
      engineHours: 500,
    });
    const created = await post(`/projects/${projectA}/equipment-utilisation`, {
      equipmentId: machineId,
      utilisationDate: daysAgo(1),
      availableHours: 10,
      workingHours: 9,
    });
    expect(created.statusCode).toBe(201);

    const res = await get(
      `/projects/${projectA}/equipment-telematics/reconciliation?from=${daysAgo(1)}&to=${daysAgo(1)}`,
    );
    const row = res
      .json()
      .rows.find((r: { equipmentId: string }) => r.equipmentId === machineId);
    expect(row.daysCompared).toBe(0);
    expect(row.daysWithoutTelematics).toBe(1);
    expect(row.days[0].telematicsEngineHours).toBeNull();
    expect(row.days[0].classification).toBe("no_telematics");
  });
});

describe("health inputs", () => {
  it("returns null rather than zero where no plant is assigned", async () => {
    const empty = await makeProject("No plant here");
    const res = await get(`/projects/${empty}/equipment/health-inputs`);
    expect(res.statusCode).toBe(200);
    expect(res.json().metrics.machinesOutOfCertificate).toBeNull();
    expect(res.json().reasons.join(" ")).toContain("null rather than zero");
  });
});

describe("scheduler", () => {
  it("registers the sweep and the supply job", async () => {
    const jobs = app.scheduler.list().map((j) => j.name);
    expect(jobs).toContain("equipment.sweep");
    expect(jobs).toContain("equipment.materials-supply");
  });

  it("runs the sweep as the system, not as whoever read the page", async () => {
    const machineId = await makeMachine({ name: "System sweep machine", isCritical: true });
    await mobilise(projectA, machineId);
    const cert = await post(`/companies/current/equipment/${machineId}/certificates`, {
      certificateType: "thorough_examination",
      validFrom: daysAgo(400),
      validTo: daysAgo(2),
      result: "pass",
    });
    expect(cert.statusCode).toBe(201);
    await app.scheduler.runNow("equipment.sweep");
    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "equipment_certificate_expired_in_service"),
        ),
      );
    expect(raised.length).toBeGreaterThanOrEqual(1);
  });
});

describe("patching a machine", () => {
  it("keeps the internal rate the caller sent", async () => {
    const machineId = await makeMachine({ name: "Rate patch machine" });
    const res = await patch(`/companies/current/equipment/${machineId}`, {
      internalRateAmount: 55,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().internalRateAmount).toBe(55);
  });
});

/* ================================================================== */
/* Plant cost onto the cost report (#715)                              */
/* ================================================================== */

describe("plant cost onto the budget", () => {
  it("posts verified plant days as direct cost and replaces on a re-post", async () => {
    const budgetId = newId("bud");
    await app.db.insert(budgets).values({
      id: budgetId,
      companyId: owner.companyId,
      projectId: projectB,
      number: 1,
      reference: "BUD-001",
      name: "Plant budget",
      createdBy: owner.userId,
    });
    const lineId = newId("bli");
    await app.db.insert(budgetLineItems).values({
      id: lineId,
      companyId: owner.companyId,
      projectId: projectB,
      budgetId,
      costCode: "01-5000",
      costType: "equipment",
      description: "Plant hire",
      originalBudget: 50_000,
      revisedBudget: 50_000,
      createdBy: owner.userId,
    });

    const machineId = await makeMachine({
      name: "Costed excavator",
      hireRateAmount: 100,
      hireRateUnit: "hour",
      currency: "GBP",
    });
    await mobilise(projectB, machineId);
    const day = await post(`/projects/${projectB}/equipment-utilisation`, {
      equipmentId: machineId,
      utilisationDate: daysAgo(1),
      availableHours: 10,
      workingHours: 8,
      idleHours: 2,
      idleReason: "awaiting_operator",
      budgetLineItemId: lineId,
    });
    expect(day.statusCode).toBe(201);
    const utilisationId = day.json().id as string;

    // Unverified days are reported as skipped, not posted at a guess.
    const first = await post(`/projects/${projectB}/equipment-utilisation/post-to-budget`, {
      from: daysAgo(3),
      to: today(),
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().posted).toBe(0);
    expect(first.json().reasons.join(" ")).toContain("not been verified");

    const verified = await post(
      `/projects/${projectB}/equipment-utilisation/${utilisationId}/verify`,
      {},
      verifier.headers,
    );
    expect(verified.statusCode).toBe(200);

    const posted = await post(`/projects/${projectB}/equipment-utilisation/post-to-budget`, {
      from: daysAgo(3),
      to: today(),
    });
    expect(posted.statusCode).toBe(201);
    expect(posted.json().posted).toBe(1);
    const [line] = await app.db
      .select()
      .from(budgetLineItems)
      .where(eq(budgetLineItems.id, lineId));
    const firstCost = line?.directCosts ?? 0;
    expect(firstCost).toBeGreaterThan(0);

    // Re-posting the same window REPLACES rather than doubles.
    const again = await post(`/projects/${projectB}/equipment-utilisation/post-to-budget`, {
      from: daysAgo(3),
      to: today(),
    });
    expect(again.statusCode).toBe(201);
    const [after] = await app.db
      .select()
      .from(budgetLineItems)
      .where(eq(budgetLineItems.id, lineId));
    expect(after?.directCosts).toBe(firstCost);
    expect(after?.jobToDateCosts).toBe(firstCost);
  });

  it("says why nothing was posted rather than reporting a zero cost", async () => {
    const res = await post(`/projects/${projectA}/equipment-utilisation/post-to-budget`, {
      from: daysAhead(60),
      to: daysAhead(70),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().posted).toBe(0);
    expect(res.json().reasons.join(" ")).toContain("nothing to post");
  });

  it("refuses another company's project", async () => {
    const res = await post(
      `/projects/${projectA}/equipment-utilisation/post-to-budget`,
      {},
      stranger.headers,
    );
    expect([403, 404]).toContain(res.statusCode);
  });
});

/* ================================================================== */
/* Maintenance schedule lifecycle                                      */
/* ================================================================== */

describe("maintenance schedule lifecycle", () => {
  async function makeSchedule(over: Record<string, unknown> = {}) {
    const machineId = await makeMachine({ name: "Suspendable machine" });
    const created = await post(
      `/companies/current/equipment/${machineId}/maintenance-schedules`,
      {
        name: "Annual service",
        maintenanceType: "preventive",
        intervalKind: "calendar_months",
        intervalValue: 12,
        lastPerformedAt: daysAgo(400),
        ...over,
      },
    );
    expect(created.statusCode).toBe(201);
    return { machineId, scheduleId: created.json().id as string };
  }

  it("suspends a schedule so the sweep stops raising it, and reinstates it", async () => {
    const { machineId, scheduleId } = await makeSchedule();
    await sweep();
    const before = await app.db
      .select()
      .from(equipmentMaintenanceSchedules)
      .where(eq(equipmentMaintenanceSchedules.id, scheduleId));
    expect(before[0]?.status).toBe("overdue");

    const suspended = await patch(
      `/companies/current/equipment/${machineId}/maintenance-schedules/${scheduleId}`,
      { status: "suspended", reason: "machine off hire" },
    );
    expect(suspended.statusCode).toBe(200);
    await sweep();
    const still = await app.db
      .select()
      .from(equipmentMaintenanceSchedules)
      .where(eq(equipmentMaintenanceSchedules.id, scheduleId));
    expect(still[0]?.status).toBe("suspended");

    const back = await patch(
      `/companies/current/equipment/${machineId}/maintenance-schedules/${scheduleId}`,
      { status: "active" },
    );
    expect(back.statusCode).toBe(200);
    expect(back.json().status).toBe("overdue");
  });

  it("will not suspend a statutory schedule without a reason", async () => {
    const { machineId, scheduleId } = await makeSchedule({ isStatutory: true });
    const res = await patch(
      `/companies/current/equipment/${machineId}/maintenance-schedules/${scheduleId}`,
      { status: "suspended" },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("STATUTORY");
  });

  it("refuses to edit a retired schedule until it is reinstated", async () => {
    const { machineId, scheduleId } = await makeSchedule();
    const retired = await patch(
      `/companies/current/equipment/${machineId}/maintenance-schedules/${scheduleId}`,
      { status: "retired", reason: "regime withdrawn" },
    );
    expect(retired.statusCode).toBe(200);
    const edit = await patch(
      `/companies/current/equipment/${machineId}/maintenance-schedules/${scheduleId}`,
      { intervalValue: 6 },
    );
    expect(edit.statusCode).toBe(409);
  });

  it("refuses the schedule edit to a read-only member", async () => {
    const { machineId, scheduleId } = await makeSchedule();
    const res = await patch(
      `/companies/current/equipment/${machineId}/maintenance-schedules/${scheduleId}`,
      { status: "suspended" },
      readerHeaders,
    );
    expect(res.statusCode).toBe(403);
  });
});

/* ================================================================== */
/* Rental against owned                                                */
/* ================================================================== */

describe("rental against owned", () => {
  it("says why it cannot compare rather than inventing a ratio", async () => {
    const res = await get(
      `/companies/current/equipment-ownership-comparison?from=${daysAgo(3)}&to=${today()}&category=lifting`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().totals.bucketsCompared).toBe(0);
    expect(res.json().reasons.join(" ")).toContain("capital appraisal");
  });

  it("compares hired against owned per productive hour once there is enough evidence", async () => {
    const hired = await makeMachine({
      name: "Comparison hired dumper",
      category: "haulage",
      ownership: "hired",
      hireRateAmount: 100,
      hireRateUnit: "hour",
      currency: "GBP",
    });
    const owned = await makeMachine({
      name: "Comparison owned dumper",
      category: "haulage",
      ownership: "owned",
      hireRateAmount: null,
      hireRateUnit: null,
      internalRateAmount: 40,
      currency: "GBP",
    });
    await mobilise(projectB, hired);
    await mobilise(projectB, owned);
    for (let i = 1; i <= 6; i += 1) {
      for (const machineId of [hired, owned]) {
        const res = await post(`/projects/${projectB}/equipment-utilisation`, {
          equipmentId: machineId,
          utilisationDate: daysAgo(i + 10),
          availableHours: 10,
          workingHours: 8,
          idleHours: 2,
          idleReason: "awaiting_instruction",
        });
        expect(res.statusCode).toBe(201);
      }
    }
    const res = await get(
      `/companies/current/equipment-ownership-comparison?from=${daysAgo(30)}&to=${today()}&category=haulage`,
    );
    expect(res.statusCode).toBe(200);
    const bucket = (
      res.json().buckets as Array<{
        category: string;
        currency: string;
        verdict: string;
        ratio: number | null;
        hired: { costPerWorkingHour: number | null };
        owned: { costPerWorkingHour: number | null };
      }>
    ).find((b) => b.category === "haulage" && b.currency === "GBP");
    expect(bucket).toBeDefined();
    expect(bucket!.verdict).toBe("hired_dearer");
    expect(bucket!.hired.costPerWorkingHour).toBeGreaterThan(
      bucket!.owned.costPerWorkingHour ?? 0,
    );
  });

  it("refuses the fleet comparison to a company guest", async () => {
    const res = await get("/companies/current/equipment-ownership-comparison", guestHeaders);
    expect(res.statusCode).toBe(403);
  });

  it("refuses a project the caller does not hold equipment on", async () => {
    const res = await get(
      `/companies/current/equipment-ownership-comparison?projectId=${projectB}`,
      readerHeaders,
    );
    expect(res.statusCode).toBe(403);
  });
});


/* ================================================================== */
/* Adding lines to an open delivery                                    */
/* ================================================================== */

/**
 * A delivery note is often typed before the wagon is unloaded and the pallet
 * nobody expected is added at the gate. The route that adds those lines had
 * no test, and it is the route that decides whether "what arrived" can still
 * be changed after the receipt is closed.
 */
describe("delivery lines", () => {
  let deliveryId = "";
  let itemId = "";

  it("appends a line to an open delivery, in position order", async () => {
    const item = await post(`/projects/${projectA}/materials`, {
      name: "Late-added rebar",
      unit: "t",
      quantityRequired: 50,
      isTracked: true,
    });
    expect(item.statusCode, item.body).toBe(201);
    itemId = item.json().id as string;

    const delivery = await post(`/projects/${projectA}/material-deliveries`, {
      supplierVendorId: vendorId,
      deliveryNoteNumber: "DN-LINES-1",
      lines: [{ description: "First line", quantityExpected: 5, unit: "t" }],
    });
    expect(delivery.statusCode, delivery.body).toBe(201);
    deliveryId = delivery.json().id as string;

    const added = await post(
      `/projects/${projectA}/material-deliveries/${deliveryId}/lines`,
      {
        lines: [
          {
            materialItemId: itemId,
            description: "Pallet nobody expected",
            quantityExpected: 3,
            unit: "t",
            heatNumber: "H-99213",
          },
        ],
      },
    );
    expect(added.statusCode, added.body).toBe(201);
    const lines = added.json().lines as Array<{
      description: string;
      position: number;
      heatNumber: string | null;
    }>;
    expect(lines).toHaveLength(2);
    const appended = lines.find((l) => l.description === "Pallet nobody expected")!;
    expect(appended.position).toBe(1);
    // Traceability travels with the line, not with the delivery.
    expect(appended.heatNumber).toBe("H-99213");
  });

  it("refuses a line naming a material that is not on this project", async () => {
    const elsewhere = await post(`/projects/${projectB}/materials`, {
      name: "Somebody else's block",
      unit: "no",
      quantityRequired: 10,
    });
    expect(elsewhere.statusCode).toBe(201);
    const res = await post(
      `/projects/${projectA}/material-deliveries/${deliveryId}/lines`,
      { lines: [{ materialItemId: elsewhere.json().id, description: "Wrong project" }] },
    );
    expect(res.statusCode).toBe(404);
  });

  it("refuses lines once the receipt is closed", async () => {
    const lines = (
      await get(`/projects/${projectA}/material-deliveries/${deliveryId}`)
    ).json().lines as Array<{ id: string; quantityExpected: number | null }>;
    // Received IN FULL, so the delivery closes. A partially received delivery
    // deliberately stays open: the rest of the load may still turn up.
    const received = await post(
      `/projects/${projectA}/material-deliveries/${deliveryId}/receive`,
      {
        createStockMovements: false,
        lines: lines.map((l) => ({
          lineId: l.id,
          quantityReceived: l.quantityExpected ?? 1,
          quantityAccepted: l.quantityExpected ?? 1,
          quantityRejected: 0,
        })),
      },
    );
    expect(received.statusCode, received.body).toBe(200);
    expect(received.json().status).toBe("received");

    const late = await post(
      `/projects/${projectA}/material-deliveries/${deliveryId}/lines`,
      { lines: [{ description: "Remembered afterwards", quantityExpected: 1 }] },
    );
    expect(late.statusCode).toBe(400);
    expect(late.json().message).toContain("What arrived is what arrived");
  });

  it("refuses a stranger from another company", async () => {
    const res = await post(
      `/projects/${projectA}/material-deliveries/${deliveryId}/lines`,
      { lines: [{ description: "Not yours" }] },
      stranger.headers,
    );
    expect(res.statusCode).toBe(403);
  });
});

/* ================================================================== */
/* Telematics intelligence over the route                              */
/* ================================================================== */

/**
 * The geofence, fuel and fault engines are unit-tested in telematics.test.ts;
 * this is the route that assembles them, and its contract is that a missing
 * input is REPORTED rather than guessed — a project with no coordinates has
 * no fence and therefore no off-site verdict.
 */
describe("telematics intelligence route", () => {
  it("states plainly that it cannot fence a project with no coordinates", async () => {
    const machineId = await makeMachine({ name: "Unfenced roller" });
    await mobilise(projectA, machineId);
    const res = await get(`/projects/${projectA}/equipment-telematics/intelligence?days=7`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      site: unknown;
      reasons: string[];
      machines: Array<{ equipmentId: string; geofence: { breaches: unknown[]; reasons: string[] } }>;
    };
    expect(body.site).toBeNull();
    expect(body.reasons.join(" ")).toContain("records no location");
    const mine = body.machines.find((m) => m.equipmentId === machineId);
    expect(mine).toBeDefined();
    // No fence means no verdict — never a verdict of "inside".
    expect(mine!.geofence.breaches).toHaveLength(0);
    expect(mine!.geofence.reasons.join(" ")).toContain("no fence");
  });

  it("finds a machine running outside the fence once the project has a location", async () => {
    const fenced = await makeProject("Fenced site");
    await app.db
      .update(projects)
      .set({ latitude: 51.5007, longitude: -0.1246 })
      .where(eq(projects.id, fenced));

    const machineId = await makeMachine({
      name: "Wandering excavator",
      telematicsProvider: "custom",
      telematicsDeviceId: "DEV-WANDER-1",
    });
    await mobilise(fenced, machineId);

    // Two readings: on site, then ninety kilometres away with the engine on.
    for (const [i, point] of [
      { latitude: 51.5007, longitude: -0.1246 },
      { latitude: 52.2053, longitude: 0.1218 },
    ].entries()) {
      await app.db.insert(equipmentTelematicsReadings).values({
        id: newId("etr"),
        companyId: owner.companyId,
        projectId: fenced,
        equipmentId: machineId,
        providerKey: "custom",
        deviceId: "DEV-WANDER-1",
        recordedAt: `${daysAgo(1)}T0${8 + i}:00:00.000Z`,
        latitude: point.latitude,
        longitude: point.longitude,
        engineRunning: 1,
        engineHours: 100 + i,
      });
    }

    const res = await get(
      `/projects/${fenced}/equipment-telematics/intelligence?days=3&radiusMetres=2000`,
    );
    expect(res.statusCode, res.body).toBe(200);
    const machines = res.json().machines as Array<{
      equipmentId: string;
      readings: number;
      geofence: {
        breaches: Array<{ recordedAt: string; distanceMetres: number }>;
        maxDistanceMetres: number | null;
        reasons: string[];
      };
    }>;
    const mine = machines.find((m) => m.equipmentId === machineId);
    expect(mine).toBeDefined();
    expect(mine!.readings).toBe(2);
    expect(mine!.geofence.breaches).toHaveLength(1);
    expect(mine!.geofence.maxDistanceMetres).toBeGreaterThan(2000);
    // One reading is where, not how long — and the route says so.
    expect(mine!.geofence.reasons.join(" ")).toContain("one reading only");
  });

  it("is refused to a company the project does not belong to", async () => {
    const res = await get(
      `/projects/${projectA}/equipment-telematics/intelligence`,
      stranger.headers,
    );
    expect(res.statusCode).toBe(403);
  });
});


/* ================================================================== */
/* Scope narrowing on the child routes                                 */
/* ================================================================== */

/**
 * `companyToolGate` admits a plant admin who holds `equipment` on ONE job;
 * the register is then narrowed to the plant that job can see. A narrowing
 * you can step around by naming the certificate instead of the excavator is
 * not a narrowing, so the two verify routes that take a child id resolve the
 * machine and answer 404 for plant outside the caller's scope.
 */
describe("certificate and maintenance verification respect the caller's scope", () => {
  let scopedHeaders: Record<string, string> = {};
  let outOfScopeMachine = "";
  let outOfScopeCertificate = "";
  let outOfScopeRecord = "";

  beforeAll(async () => {
    const scoped = await registerActor(app);
    await app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: scoped.userId,
      role: "member",
    });
    // Full control of every tool — but only on project A.
    await app.db.insert(projectMemberships).values({
      id: newId("pm"),
      companyId: owner.companyId,
      projectId: projectA,
      userId: scoped.userId,
      templateKey: "project_admin",
    });
    scopedHeaders = {
      authorization: scoped.headers["authorization"]!,
      "x-company-id": owner.companyId,
    };

    outOfScopeMachine = await makeMachine({ name: "Project B crane" });
    await mobilise(projectB, outOfScopeMachine);

    const cert = await post(
      `/companies/current/equipment/${outOfScopeMachine}/certificates`,
      {
        certificateType: "thorough_examination",
        issuedByName: "LOLER Inspections Ltd",
        certificateNumber: "TE-B-1",
        validFrom: daysAgo(10),
        validTo: daysAhead(180),
      },
    );
    expect(cert.statusCode, cert.body).toBe(201);
    outOfScopeCertificate = cert.json().id as string;

    const record = await post(
      `/companies/current/equipment/${outOfScopeMachine}/maintenance-records`,
      {
        maintenanceType: "servicing",
        performedAt: `${daysAgo(2)}T09:00:00.000Z`,
        result: "completed",
        description: "500-hour service",
      },
    );
    expect(record.statusCode, record.body).toBe(201);
    outOfScopeRecord = record.json().id as string;
  });

  it("admits the scoped plant admin to the register", async () => {
    const res = await get("/companies/current/equipment", scopedHeaders);
    expect(res.statusCode, res.body).toBe(200);
    const ids = (res.json().items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).not.toContain(outOfScopeMachine);
  });

  /*
   * The idle list says which of a job's machines are earning nothing, which
   * is commercially sensitive on somebody else's job. Scoping the fleet
   * register while leaving the idle list company-wide would have handed it
   * over anyway.
   */
  it("narrows the company idle list to the plant the caller may see", async () => {
    // Nine days of near-total standing on the out-of-scope machine, so it
    // qualifies for the idle list at all.
    for (let i = 1; i <= 9; i += 1) {
      const res = await post(`/projects/${projectB}/equipment-utilisation`, {
        equipmentId: outOfScopeMachine,
        utilisationDate: daysAgo(i),
        availableHours: 10,
        workingHours: 0,
        standbyHours: 10,
        idleReason: "no_work_available",
      });
      expect(res.statusCode, res.body).toBe(201);
    }
    const mine = await get(
      `/companies/current/equipment-idle?from=${daysAgo(10)}&to=${today()}`,
    );
    expect(mine.statusCode, mine.body).toBe(200);
    expect(
      (mine.json().items as Array<{ equipmentId: string }>).some(
        (i) => i.equipmentId === outOfScopeMachine,
      ),
    ).toBe(true);

    const theirs = await get(
      `/companies/current/equipment-idle?from=${daysAgo(10)}&to=${today()}`,
      scopedHeaders,
    );
    expect(theirs.statusCode, theirs.body).toBe(200);
    expect(
      (theirs.json().items as Array<{ equipmentId: string }>).some(
        (i) => i.equipmentId === outOfScopeMachine,
      ),
    ).toBe(false);
  });

  it("refuses the company idle list to a guest who holds equipment nowhere", async () => {
    const res = await get("/companies/current/equipment-idle", guestHeaders);
    expect(res.statusCode).toBe(403);
  });

  it("404s a certificate verification on plant outside that scope", async () => {
    const res = await post(
      `/companies/current/equipment-certificates/${outOfScopeCertificate}/verify`,
      { verificationMethod: "issuer_confirmation" },
      scopedHeaders,
    );
    expect(res.statusCode, res.body).toBe(404);
  });

  it("404s a maintenance verification on plant outside that scope", async () => {
    const res = await post(
      `/companies/current/equipment-maintenance-records/${outOfScopeRecord}/verify`,
      { note: "looks fine to me" },
      scopedHeaders,
    );
    expect(res.statusCode, res.body).toBe(404);
  });

  it("still lets an independent company admin verify them", async () => {
    const cert = await post(
      `/companies/current/equipment-certificates/${outOfScopeCertificate}/verify`,
      { verificationMethod: "issuer_confirmation" },
      verifier.headers,
    );
    expect(cert.statusCode, cert.body).toBe(200);
    const record = await post(
      `/companies/current/equipment-maintenance-records/${outOfScopeRecord}/verify`,
      { note: "service sheet and parts invoice seen" },
      verifier.headers,
    );
    expect(record.statusCode, record.body).toBe(200);
  });
});


/* ================================================================== */
/* The reconciliation as an assurance fact                             */
/* ================================================================== */

/**
 * The read computes the comparison; the RUN route records it as the
 * platform's three primitives. What is being tested here is the discipline,
 * not the arithmetic: the plant sheet is the Assertion, the machine's own
 * counter is the Evidence, and a pack assembled by one of the people who
 * claimed the hours is marked self-certified and downgraded rather than
 * presented as verified.
 */
describe("telematics reconciliation recorded as assertion, evidence and reconciliation", () => {
  let projectC = "";
  let machineId = "";

  beforeAll(async () => {
    projectC = await makeProject("Assurance plant");
    machineId = await makeMachine({
      name: "Assurance excavator",
      telematicsProvider: "generic_aemp",
      telematicsDeviceId: "DEV-ASSURE-1",
      hireRateAmount: 40,
      hireRateUnit: "hour",
      operatorRateAmount: 30,
      currency: "GBP",
    });
    await mobilise(projectC, machineId);

    // The machine reports 6 engine hours a day for four days; the plant
    // sheet claims 9. Carry-in reading first, so day one is measurable.
    const counters: Array<[string, number]> = [
      [daysAgo(5), 2000],
      [daysAgo(4), 2006],
      [daysAgo(3), 2012],
      [daysAgo(2), 2018],
      [daysAgo(1), 2024],
    ];
    for (const [date, engineHours] of counters) {
      await app.db.insert(equipmentTelematicsReadings).values({
        id: newId("etr"),
        companyId: owner.companyId,
        projectId: projectC,
        equipmentId: machineId,
        providerKey: "generic_aemp",
        deviceId: "DEV-ASSURE-1",
        recordedAt: `${date}T18:00:00.000Z`,
        engineHours,
      });
    }
    for (const date of [daysAgo(4), daysAgo(3), daysAgo(2), daysAgo(1)]) {
      const res = await post(`/projects/${projectC}/equipment-utilisation`, {
        equipmentId: machineId,
        utilisationDate: date,
        availableHours: 10,
        workingHours: 9,
      });
      expect(res.statusCode, res.body).toBe(201);
    }
  });

  it("records the triple when an independent party assembles it", async () => {
    const res = await post(
      `/projects/${projectC}/equipment-telematics/reconciliation/run`,
      { from: daysAgo(4), to: daysAgo(1) },
      // The plant sheets were filled in by `owner`; `verifier` is somebody
      // else, so the pack is independent of the claim.
      verifier.headers,
    );
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      recorded: number;
      replaced: number;
      rows: Array<{
        equipmentId: string;
        assertionId: string;
        evidenceId: string | null;
        result: string;
        selfCertified: boolean;
      }>;
    };
    expect(body.recorded).toBe(1);
    expect(body.replaced).toBe(0);
    const row = body.rows.find((r) => r.equipmentId === machineId)!;
    expect(row.selfCertified).toBe(false);
    expect(row.result).toBe("unsupported");
    expect(row.evidenceId).toBeTruthy();

    const [assertion] = await app.db
      .select()
      .from(assertions)
      .where(eq(assertions.id, row.assertionId));
    expect(assertion?.kind).toBe("duration");
    expect(assertion?.unit).toBe("hours");
    expect(assertion?.value).toBe(36);
    // The claim is attributed to whoever filled in the plant sheet, NOT to
    // whoever ran the reconciliation.
    expect(assertion?.claimantId).toBe(owner.userId);
    expect(assertion?.sourceType).toBe("equipment_utilisation_window");

    const [evd] = await app.db
      .select()
      .from(evidence)
      .where(eq(evidence.id, row.evidenceId!));
    expect(evd?.kind).toBe("telematics");
    expect(evd?.independenceScore).toBeGreaterThan(0.5);
    expect(evd?.independenceScore).toBeLessThan(1);

    const recs = await app.db
      .select()
      .from(reconciliations)
      .where(eq(reconciliations.assertionId, row.assertionId));
    expect(recs).toHaveLength(1);
    expect(recs[0]?.method).toBe("equipment_hours_vs_telematics");
    expect(recs[0]?.result).toBe("unsupported");
    expect(recs[0]?.selfCertified).toBe(false);
    expect(recs[0]?.variance).toBe(12);
    expect(recs[0]?.notes ?? "").toContain("GBP");
  });

  it("replaces the triple on a re-run rather than stacking a second copy", async () => {
    const again = await post(
      `/projects/${projectC}/equipment-telematics/reconciliation/run`,
      { from: daysAgo(4), to: daysAgo(1) },
      verifier.headers,
    );
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().replaced).toBe(1);
    const assertionId = (again.json().rows as Array<{ assertionId: string }>)[0]!.assertionId;
    const recs = await app.db
      .select()
      .from(reconciliations)
      .where(eq(reconciliations.assertionId, assertionId));
    expect(recs).toHaveLength(1);

    // And the superseded evidence pack goes with it: one re-run must not leave
    // a dead pack behind in the evidence register.
    const packs = await app.db
      .select()
      .from(evidence)
      .where(
        and(
          eq(evidence.projectId, projectC),
          eq(evidence.kind, "telematics"),
        ),
      );
    expect(packs).toHaveLength(1);
  });

  it("marks a pack assembled by one of the claimants self-certified and downgrades it", async () => {
    // `owner` filled in every plant sheet in this window.
    const res = await post(
      `/projects/${projectC}/equipment-telematics/reconciliation/run`,
      { from: daysAgo(4), to: daysAgo(1) },
    );
    expect(res.statusCode, res.body).toBe(200);
    const row = (
      res.json().rows as Array<{
        assertionId: string;
        result: string;
        selfCertified: boolean;
      }>
    )[0]!;
    expect(row.selfCertified).toBe(true);
    // The comparison still happened — it is simply not offered as verified.
    expect(row.result).toBe("partially_supported");
    const [rec] = await app.db
      .select()
      .from(reconciliations)
      .where(eq(reconciliations.assertionId, row.assertionId));
    expect(rec?.selfCertified).toBe(true);
    expect(rec?.notes ?? "").toContain("not independent");
  });

  it("records nothing, and says so, for a window with no plant and no hours", async () => {
    const empty = await makeProject("No plant at all");
    const res = await post(
      `/projects/${empty}/equipment-telematics/reconciliation/run`,
      {},
      verifier.headers,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().recorded).toBe(0);
    expect(res.json().reasons.join(" ")).toContain("nothing to reconcile");
  });

  it("refuses the run to another company", async () => {
    const res = await post(
      `/projects/${projectC}/equipment-telematics/reconciliation/run`,
      {},
      stranger.headers,
    );
    expect(res.statusCode).toBe(403);
  });
});

/* ================================================================== */
/* The telematics detectors ACT — signals, and a machine off the fleet */
/* ================================================================== */

/**
 * The intelligence ROUTE reports; these detectors leave a Signal and, for a
 * fault the manufacturer grades critical, take the machine out of service.
 * The three things worth testing are that it fires, that it fires ONCE, and
 * that it never restates the status of a machine that is already off the job.
 */
describe("telematics detectors act on what the feed says", () => {
  let fenced: string;
  let wanderer: string;
  let thirsty: string;
  let broken: string;
  let offHired: string;

  beforeAll(async () => {
    fenced = await makeProject("Detector site");
    await app.db
      .update(projects)
      .set({ latitude: 51.5007, longitude: -0.1246 })
      .where(eq(projects.id, fenced));

    /* 1. worked ninety kilometres from the job, engine running */
    wanderer = await makeMachine({ name: "Detector wanderer" });
    await mobilise(fenced, wanderer);
    for (const [i, point] of [
      { latitude: 52.2053, longitude: 0.1218 },
      { latitude: 52.2054, longitude: 0.1219 },
    ].entries()) {
      await app.db.insert(equipmentTelematicsReadings).values({
        id: newId("etr"),
        companyId: owner.companyId,
        projectId: fenced,
        equipmentId: wanderer,
        providerKey: "custom",
        deviceId: `DEV-DET-W${i}`,
        recordedAt: `${daysAgo(1)}T0${8 + i}:00:00.000Z`,
        latitude: point.latitude,
        longitude: point.longitude,
        engineRunning: 1,
      });
    }

    /* 2. 400 litres booked in against 60 the machine says it burned */
    thirsty = await makeMachine({ name: "Detector thirsty" });
    await mobilise(fenced, thirsty);
    await app.db.insert(equipmentTelematicsReadings).values({
      id: newId("etr"),
      companyId: owner.companyId,
      projectId: fenced,
      equipmentId: thirsty,
      providerKey: "custom",
      deviceId: "DEV-DET-F",
      recordedAt: `${daysAgo(1)}T09:00:00.000Z`,
      latitude: 51.5007,
      longitude: -0.1246,
      engineRunning: 1,
      fuelUsedLitres: 60,
    });
    for (const litres of [200, 200]) {
      await app.db.insert(equipmentReadings).values({
        id: newId("erd"),
        companyId: owner.companyId,
        projectId: fenced,
        equipmentId: thirsty,
        readingType: "fuel_fill",
        readAt: `${daysAgo(1)}T17:00:00.000Z`,
        value: litres,
        createdBy: owner.userId,
      });
    }

    /* 3. a critical fault code — the manufacturer saying stop */
    broken = await makeMachine({ name: "Detector broken" });
    await mobilise(fenced, broken);
    await app.db.insert(equipmentTelematicsReadings).values({
      id: newId("etr"),
      companyId: owner.companyId,
      projectId: fenced,
      equipmentId: broken,
      providerKey: "custom",
      deviceId: "DEV-DET-B",
      recordedAt: `${daysAgo(1)}T10:00:00.000Z`,
      latitude: 51.5007,
      longitude: -0.1246,
      engineRunning: 1,
      faultCodes: [
        { code: "SPN-100-FMI-1", description: "Oil pressure critical", severity: "critical" },
      ],
    });

    /* 4. the same critical fault on a machine already off hire */
    offHired = await makeMachine({ name: "Detector off-hired" });
    await mobilise(fenced, offHired);
    await app.db
      .update(equipment)
      .set({ status: "off_hired" })
      .where(eq(equipment.id, offHired));
    await app.db.insert(equipmentTelematicsReadings).values({
      id: newId("etr"),
      companyId: owner.companyId,
      projectId: fenced,
      equipmentId: offHired,
      providerKey: "custom",
      deviceId: "DEV-DET-O",
      recordedAt: `${daysAgo(1)}T10:00:00.000Z`,
      engineRunning: 1,
      faultCodes: [
        { code: "SPN-110-FMI-0", description: "Coolant over temperature", severity: "critical" },
      ],
    });
  });

  it("raises each detector once and takes the critically faulted machine off the fleet", async () => {
    const res = await post(`/projects/${fenced}/equipment-telematics/intelligence/run`, {});
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      machinesAssessed: number;
      signalsRaised: number;
      takenOutOfService: string[];
    };
    expect(body.machinesAssessed).toBe(4);
    // one off-site, one fuel, two faults
    expect(body.signalsRaised).toBe(4);

    const offSite = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "equipment_off_site_use"),
        ),
      );
    expect(offSite).toHaveLength(1);
    expect(offSite[0]!.severity).toBe("high");
    expect(offSite[0]!.explanation).toContain("engine RUNNING");

    const fuel = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "equipment_fuel_unaccounted"),
        ),
      );
    expect(fuel).toHaveLength(1);
    expect(fuel[0]!.explanation).toContain("340");

    const faults = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "equipment_fault_active")),
      );
    expect(faults).toHaveLength(2);
    expect(faults.every((f) => f.severity === "critical")).toBe(true);

    // The working machine is stopped; the off-hired one is left alone, and the
    // signal says which of the two happened.
    const [brokenRow] = await app.db.select().from(equipment).where(eq(equipment.id, broken));
    expect(brokenRow?.status).toBe("breakdown");
    const [offRow] = await app.db.select().from(equipment).where(eq(equipment.id, offHired));
    expect(offRow?.status).toBe("off_hired");
    expect(body.takenOutOfService).toEqual([brokenRow!.reference]);
    const leftAlone = faults.find(
      (f) => (f.evidenceRefs as { equipmentId?: string }).equipmentId === offHired,
    );
    expect(leftAlone!.explanation).toContain('was left at "off_hired"');
  });

  it("says nothing new on a second run over the same window", async () => {
    const again = await post(`/projects/${fenced}/equipment-telematics/intelligence/run`, {});
    expect(again.statusCode).toBe(200);
    expect(again.json().signalsRaised).toBe(0);
    expect(again.json().takenOutOfService).toEqual([]);
    const all = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "equipment_fault_active")),
      );
    expect(all).toHaveLength(2);
  });

  it("registers the detector sweep as a job", async () => {
    const names = app.scheduler.list().map((j) => j.name);
    expect(names).toContain("equipment.telematics-intelligence");
  });

  it("refuses the run to another company", async () => {
    const res = await post(
      `/projects/${fenced}/equipment-telematics/intelligence/run`,
      {},
      stranger.headers,
    );
    expect(res.statusCode).toBe(403);
  });

  it("refuses the run to a read-only member", async () => {
    const res = await post(
      `/projects/${projectA}/equipment-telematics/intelligence/run`,
      {},
      readerHeaders,
    );
    expect(res.statusCode).toBe(403);
  });
});
