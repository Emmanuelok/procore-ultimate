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
  budgetLineItems,
  budgets,
  companyMemberships,
  equipment,
  equipmentCertificates,
  equipmentMaintenanceSchedules,
  equipmentTelematicsReadings,
  materialItems,
  projectMemberships,
  projects,
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

  it("refuses the fleet to a stranger from another company", async () => {
    const res = await get("/companies/current/equipment", stranger.headers);
    expect(res.statusCode).toBe(403);
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
    });
    expect(day.statusCode).toBe(201);
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
    expect(res.json().method).toContain("before it began");
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
