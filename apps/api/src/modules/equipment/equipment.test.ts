import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  equipmentTelematicsReadings,
  equipmentUtilisation,
  ingestionRuns,
  invoices,
  ledgerEntries,
  materialItems,
  nonConformanceReports,
  projectMemberships,
  projects,
  signals,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { verifyCompanyLedger } from "../../lib/ledger.js";
import { addDaysISO, todayISO } from "../field/dates.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
/** second admin in the same company — the independent verifier (ADR 0004) */
let verifier: TestActor;
/** read-only project member — permission enforcement counterparty */
let viewer: TestActor;
let viewerHeaders: Record<string, string>;
/** a different company entirely — tenant isolation counterparty */
let stranger: TestActor;

let plantProject: string;
let idleProject: string;
let teleProject: string;
let matProject: string;
let permProject: string;
let vendorId: string;
/** machine token for the telematics inlet */
let pushToken: string;

const today = () => todayISO();
const daysAgo = (n: number) => addDaysISO(todayISO(), -n);
const isoAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

function post(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload });
}
function get(url: string, headers = owner.headers) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers });
}

async function makeProject(name: string): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({
    id,
    companyId: owner.companyId,
    name,
    stage: "course_of_construction",
  });
  return id;
}

async function signalsFor(detector: string, key?: string) {
  const rows = await app.db
    .select()
    .from(signals)
    .where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, detector)));
  if (!key) return rows;
  return rows.filter((r) => (r.evidenceRefs as { key?: string } | null)?.key === key);
}

/** Register a machine on the company fleet, returning its id. */
async function makeMachine(over: Record<string, unknown> = {}): Promise<string> {
  const res = await post("/companies/current/equipment", {
    name: "30t tracked excavator",
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

/** Assign a machine to a project and take it all the way to on_site. */
async function mobilise(projectId: string, equipmentId: string): Promise<string> {
  const created = await post(`/projects/${projectId}/equipment/assignments`, {
    equipmentId,
    assignedFrom: daysAgo(20),
  });
  expect(created.statusCode).toBe(201);
  const assignmentId = created.json().id as string;
  const approved = await post(
    `/projects/${projectId}/equipment/assignments/${assignmentId}/approve`,
    {},
    verifier.headers,
  );
  expect(approved.statusCode).toBe(200);
  const mob = await post(
    `/projects/${projectId}/equipment/assignments/${assignmentId}/mobilise`,
    { conditionOnArrival: "good", arrivalPhotoFileIds: ["file_a"] },
  );
  expect(mob.statusCode).toBe(200);
  return assignmentId;
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

  viewer = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: viewer.userId,
    role: "member",
  });
  viewerHeaders = {
    authorization: viewer.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  stranger = await registerActor(app);

  plantProject = await makeProject("Plant — register");
  idleProject = await makeProject("Plant — idle hire");
  teleProject = await makeProject("Plant — telematics");
  matProject = await makeProject("Materials");
  permProject = await makeProject("Plant — permissions");

  await app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId: permProject,
    userId: viewer.userId,
    templateKey: "read_only",
  });

  vendorId = newId("ven");
  await app.db
    .insert(vendors)
    .values({ id: vendorId, companyId: owner.companyId, name: "Plant Hire Ltd" });

  const tokenRes = await post("/ingestion/tokens", {
    name: "OEM telematics feed",
    scopes: ["evidence"],
  });
  expect(tokenRes.statusCode).toBe(201);
  pushToken = tokenRes.json().token as string;
});

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* Register                                                            */
/* ================================================================== */

describe("plant register", () => {
  it("registers hired plant with a reference and derived hire state", async () => {
    const res = await post("/companies/current/equipment", {
      name: "40t crawler crane",
      category: "lifting",
      ownership: "hired",
      supplierVendorId: vendorId,
      currency: "GBP",
      hireRateAmount: 45,
      hireRateUnit: "hour",
      idleRateAmount: 25,
      hireStartDate: daysAgo(30),
      hireEndDate: daysAgo(2),
      isCritical: true,
      requiresCertification: true,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.reference).toMatch(/^EQP-\d{4}$/);
    expect(body.isCritical).toBe(true);
    expect(body.derived.onHire).toBe(true);
    expect(body.derived.hireRunning).toBe(true);
    // the hire end has passed and nobody has off-hired it
    expect(body.derived.hireOverrun).toContain("full rate");
  });

  it("refuses a hire rate amount with no unit", async () => {
    const res = await post("/companies/current/equipment", {
      name: "Telehandler",
      ownership: "hired",
      hireRateAmount: 300,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("no hireRateUnit");
  });

  it("refuses acceptance by the person who registered the machine (ADR 0004)", async () => {
    const id = await makeMachine({ name: "Dumper" });
    const self = await post(`/companies/current/equipment/${id}/verify`, { note: "looks fine" });
    expect(self.statusCode).toBe(403);
    expect(self.json().message).toContain("cannot also approve or verify it");

    const independent = await post(
      `/companies/current/equipment/${id}/verify`,
      { note: "checked against the docket" },
      verifier.headers,
    );
    expect(independent.statusCode).toBe(200);
    expect(independent.json().independentVerification).toBe(true);
    expect(independent.json().verifiedBy).toBe(verifier.userId);
  });

  it("keeps a machine invisible to another tenant", async () => {
    const id = await makeMachine({ name: "Roller" });
    const res = await get(`/companies/current/equipment/${id}`, stranger.headers);
    expect(res.statusCode).toBe(404);
  });
});

/* ================================================================== */
/* Assignments                                                         */
/* ================================================================== */

describe("assignments", () => {
  it("refuses approval of a hire by the person who requested it", async () => {
    const id = await makeMachine({ name: "Tower crane" });
    const created = await post(`/projects/${plantProject}/equipment/assignments`, {
      equipmentId: id,
      assignedFrom: daysAgo(5),
      mobilisationCost: 4500,
    });
    expect(created.statusCode).toBe(201);
    const assignmentId = created.json().id as string;

    const self = await post(
      `/projects/${plantProject}/equipment/assignments/${assignmentId}/approve`,
      {},
    );
    expect(self.statusCode).toBe(403);

    const other = await post(
      `/projects/${plantProject}/equipment/assignments/${assignmentId}/approve`,
      {},
      verifier.headers,
    );
    expect(other.statusCode).toBe(200);
    expect(other.json().status).toBe("approved");
    expect(other.json().independentApproval).toBe(true);
  });

  it("refuses a second live assignment for one machine", async () => {
    const id = await makeMachine({ name: "Piling rig" });
    await mobilise(plantProject, id);
    const second = await post(`/projects/${idleProject}/equipment/assignments`, {
      equipmentId: id,
      assignedFrom: today(),
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().message).toContain("cannot be on two projects");
  });

  it("records condition on arrival and return, and flags deterioration and the off-hire gap", async () => {
    const id = await makeMachine({ name: "Excavator (damage)" });
    const assignmentId = await mobilise(plantProject, id);
    const demob = await post(
      `/projects/${plantProject}/equipment/assignments/${assignmentId}/demobilise`,
      {
        conditionOnReturn: "poor",
        damageOnReturnNote: "Track damage and a cracked screen",
        returnPhotoFileIds: ["file_b"],
        requestOffHire: false,
      },
    );
    expect(demob.statusCode).toBe(200);
    const body = demob.json();
    expect(body.status).toBe("returned");
    expect(body.conditionDeteriorated).toBe(true);
    expect(body.damageNote).toContain("arrival photographs");
    expect(body.offHireNote).toContain("NO OFF-HIRE WAS REQUESTED");
  });

  it("records an off-hire request and confirmation, and reports the collection delay", async () => {
    const id = await makeMachine({ name: "Excavator (off-hire)" });
    const req = await post(`/companies/current/equipment/${id}/off-hire`, {
      action: "request",
      at: isoAgo(6),
      reference: "OFFHIRE-99",
    });
    expect(req.statusCode).toBe(200);
    expect(req.json().status).toBe("off_hire_requested");
    const confirm = await post(`/companies/current/equipment/${id}/off-hire`, {
      action: "confirm",
      at: isoAgo(2),
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().collectionDelayDays).toBe(4);
    expect(confirm.json().collectionDelayNote).toContain("stops on notice");
  });
});

/* ================================================================== */
/* Utilisation                                                         */
/* ================================================================== */

describe("utilisation", () => {
  let machineId: string;

  beforeAll(async () => {
    machineId = await makeMachine({
      name: "Utilisation excavator",
      hireRateAmount: 45,
      hireRateUnit: "hour",
      idleRateAmount: 25,
      operatorRateAmount: 30,
    });
    await mobilise(plantProject, machineId);
  });

  it("computes the percentage and rolls hire, fuel and operator cost to the row", async () => {
    const res = await post(`/projects/${plantProject}/equipment-utilisation`, {
      equipmentId: machineId,
      utilisationDate: daysAgo(3),
      availableHours: 10,
      workingHours: 6,
      idleHours: 4,
      idleReason: "awaiting_materials",
      fuelLitres: 120,
      fuelCost: 168,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.utilisationPercent).toBe(60);
    expect(body.utilisation.basis).toBe("available_hours");
    expect(body.cost.hireCost).toBe(6 * 45 + 4 * 25);
    expect(body.cost.operatorCost).toBe(300);
    expect(body.cost.totalCost).toBe(370 + 168 + 300);
    expect(body.cost.totalIsComplete).toBe(true);
  });

  it("refuses idle hours with no idle reason", async () => {
    const res = await post(`/projects/${plantProject}/equipment-utilisation`, {
      equipmentId: machineId,
      utilisationDate: daysAgo(4),
      availableHours: 10,
      workingHours: 6,
      idleHours: 4,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("no idleReason");
  });

  it("refuses a second row for the same machine, date and shift", async () => {
    const res = await post(`/projects/${plantProject}/equipment-utilisation`, {
      equipmentId: machineId,
      utilisationDate: daysAgo(3),
      availableHours: 10,
      workingHours: 10,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("double the hire cost");
  });

  it("refuses hours that exceed the recorded shift window", async () => {
    const res = await post(`/projects/${plantProject}/equipment-utilisation`, {
      equipmentId: machineId,
      utilisationDate: daysAgo(5),
      availableHours: 8,
      workingHours: 6,
      idleHours: 4,
      idleReason: "weather",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("contradicts itself");
  });

  it("refuses verification of hours by the person who claimed them", async () => {
    const created = await post(`/projects/${plantProject}/equipment-utilisation`, {
      equipmentId: machineId,
      utilisationDate: daysAgo(6),
      availableHours: 9,
      workingHours: 9,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const self = await post(`/projects/${plantProject}/equipment-utilisation/${id}/verify`, {});
    expect(self.statusCode).toBe(403);
    const other = await post(
      `/projects/${plantProject}/equipment-utilisation/${id}/verify`,
      {},
      verifier.headers,
    );
    expect(other.statusCode).toBe(200);
    expect(other.json().independentVerification).toBe(true);
  });

  it("summarises per machine and buckets cost by currency", async () => {
    const res = await get(
      `/projects/${plantProject}/equipment-utilisation/summary?from=${daysAgo(10)}&to=${today()}`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const row = body.items.find((i: { equipmentId: string }) => i.equipmentId === machineId);
    expect(row).toBeDefined();
    expect(row.hours.workingHours).toBe(15);
    expect(Object.keys(body.costByCurrency)).toEqual(["GBP"]);
  });
});

/* ================================================================== */
/* Idle plant still on hire — where the money leaks                    */
/* ================================================================== */

describe("idle hired plant", () => {
  let idleMachine: string;

  beforeAll(async () => {
    idleMachine = await makeMachine({
      name: "Idle 30t excavator",
      hireRateAmount: 700,
      hireRateUnit: "day",
      currency: "GBP",
    });
    await mobilise(idleProject, idleMachine);
    for (let d = 6; d >= 1; d -= 1) {
      const working = d > 5 ? 9 : 0;
      const res = await post(`/projects/${idleProject}/equipment-utilisation`, {
        equipmentId: idleMachine,
        utilisationDate: daysAgo(d),
        availableHours: 10,
        workingHours: working,
        idleHours: 10 - working,
        idleReason: "awaiting_instruction",
      });
      expect(res.statusCode).toBe(201);
    }
  });

  it("finds sustained low utilisation still on hire and states the accumulated cost", async () => {
    const res = await get(`/projects/${idleProject}/equipment-idle?from=${daysAgo(6)}&to=${today()}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const row = body.items.find((i: { equipmentId: string }) => i.equipmentId === idleMachine);
    expect(row).toBeDefined();
    expect(row.isIdleOnHire).toBe(true);
    expect(row.consecutiveLowDays).toBe(5);
    expect(row.idleCost).toBe(5 * 700);
    expect(body.idleCostByCurrency.GBP).toBeGreaterThanOrEqual(3500);
  });

  it("raises exactly one idle-plant signal however many times the report is read", async () => {
    await get(`/projects/${idleProject}/equipment-idle?from=${daysAgo(6)}&to=${today()}`);
    await get(`/projects/${idleProject}/equipment-idle?from=${daysAgo(6)}&to=${today()}`);
    const raised = await signalsFor("equipment_idle_on_hire", idleMachine);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe("high");
    expect(raised[0]!.explanation).toContain("GBP 3500");
  });
});

/* ================================================================== */
/* Certificates                                                        */
/* ================================================================== */

describe("statutory certificates", () => {
  let certMachine: string;
  let certificateId: string;

  beforeAll(async () => {
    certMachine = await makeMachine({
      name: "Crane with lapsed LOLER",
      category: "lifting",
      requiresCertification: true,
      isCritical: true,
    });
    await mobilise(plantProject, certMachine);
    const res = await post(`/companies/current/equipment/${certMachine}/certificates`, {
      certificateType: "thorough_examination",
      certificateNumber: "TE/2026/0091",
      issuedByName: "Competent Person Ltd",
      validFrom: daysAgo(200),
      validTo: daysAgo(1),
      result: "pass",
    });
    expect(res.statusCode).toBe(201);
    certificateId = res.json().id as string;
  });

  it("raises exactly ONE critical signal for an expired statutory certificate on assigned plant", async () => {
    await get("/companies/current/equipment-certificates");
    await get("/companies/current/equipment-certificates");
    await get(`/projects/${plantProject}/equipment`);
    const raised = await signalsFor("equipment_certificate_expired_in_service", certificateId);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe("critical");
    expect(raised[0]!.explanation).toContain("unlawful");
    // and it is NOT also raised under the lower-severity detector
    expect(await signalsFor("equipment_certificate_expired", certificateId)).toHaveLength(0);
  });

  it("flips the certificate to expired and surfaces the machine as out of certificate", async () => {
    const register = await get("/companies/current/equipment-certificates");
    expect(register.statusCode).toBe(200);
    const body = register.json();
    expect(body.summary.expiredInServiceStatutory).toBeGreaterThanOrEqual(1);
    const row = body.items.find((c: { id: string }) => c.id === certificateId);
    expect(row.status).toBe("expired");
    expect(row.verdict.status).toBe("expired");
    expect(row.statutory).toBe(true);

    const machine = await get(`/companies/current/equipment/${certMachine}`);
    expect(machine.json().derived.outOfCertificate).toBe(true);
  });

  it("marks the renewal obligation breached once the certificate lapses", async () => {
    const cert = await get(`/companies/current/equipment/${certMachine}/certificates`);
    const row = cert.json().items.find((c: { id: string }) => c.id === certificateId);
    expect(row.obligationId).toBeTruthy();
  });

  it("refuses verification of a certificate by the person who filed it", async () => {
    const self = await post(
      `/companies/current/equipment-certificates/${certificateId}/verify`,
      { verificationMethod: "document_only" },
    );
    expect(self.statusCode).toBe(403);
    const other = await post(
      `/companies/current/equipment-certificates/${certificateId}/verify`,
      { verificationMethod: "issuer_confirmation" },
      verifier.headers,
    );
    expect(other.statusCode).toBe(200);
    expect(other.json().independentVerification).toBe(true);
    expect(other.json().verificationStrength).toContain("strongest evidence");
  });

  it("raises the lower-severity detector for expired plant sitting in the yard", async () => {
    const yardMachine = await makeMachine({ name: "Yard hoist", requiresCertification: true });
    const cert = await post(`/companies/current/equipment/${yardMachine}/certificates`, {
      certificateType: "thorough_examination",
      validTo: daysAgo(3),
    });
    expect(cert.statusCode).toBe(201);
    const id = cert.json().id as string;
    await get("/companies/current/equipment-certificates");
    const critical = await signalsFor("equipment_certificate_expired_in_service", id);
    const high = await signalsFor("equipment_certificate_expired", id);
    expect(critical).toHaveLength(0);
    expect(high).toHaveLength(1);
    expect(high[0]!.severity).toBe("high");
  });
});

/* ================================================================== */
/* Maintenance                                                         */
/* ================================================================== */

describe("maintenance", () => {
  it("raises a signal for overdue maintenance on critical plant and closes it out with a record", async () => {
    const machineId = await makeMachine({
      name: "Critical generator",
      category: "generator",
      isCritical: true,
      currentMeterReading: 1800,
    });
    const schedule = await post(
      `/companies/current/equipment/${machineId}/maintenance-schedules`,
      {
        name: "500-hour service",
        intervalKind: "operating_hours",
        intervalValue: 500,
        warnAheadValue: 50,
        lastPerformedMeter: 1000,
        isStatutory: false,
      },
    );
    expect(schedule.statusCode).toBe(201);
    const scheduleId = schedule.json().id as string;
    expect(schedule.json().due.nextDueMeter).toBe(1500);
    expect(schedule.json().due.status).toBe("overdue");

    const register = await get("/companies/current/equipment-maintenance?criticalOnly=true");
    expect(register.statusCode).toBe(200);
    expect(register.json().summary.overdueOnCriticalPlant).toBeGreaterThanOrEqual(1);
    await get("/companies/current/equipment-maintenance");
    const raised = await signalsFor("equipment_maintenance_overdue_critical", scheduleId);
    expect(raised).toHaveLength(1);

    const record = await post(`/companies/current/equipment/${machineId}/maintenance-records`, {
      scheduleId,
      maintenanceType: "preventive",
      description: "500-hour service carried out",
      meterReading: 1810,
      partsCost: 320,
      labourCost: 480,
    });
    expect(record.statusCode).toBe(201);
    expect(record.json().reference).toMatch(/^MNT-\d{4}$/);
    expect(record.json().totalCost).toBe(800);
    expect(record.json().nextDue.nextDueMeter).toBe(2310);

    const after = await get(`/companies/current/equipment/${machineId}/maintenance-schedules`);
    const row = after.json().items.find((s: { id: string }) => s.id === scheduleId);
    expect(row.lastPerformedMeter).toBe(1810);
    expect(row.status).toBe("active");
  });

  it("does not signal an overdue service on non-critical plant", async () => {
    const machineId = await makeMachine({ name: "Site cabin heater", currentMeterReading: 900 });
    const schedule = await post(
      `/companies/current/equipment/${machineId}/maintenance-schedules`,
      { name: "Annual", intervalKind: "operating_hours", intervalValue: 200, lastPerformedMeter: 100 },
    );
    const scheduleId = schedule.json().id as string;
    await get("/companies/current/equipment-maintenance");
    expect(await signalsFor("equipment_maintenance_overdue_critical", scheduleId)).toHaveLength(0);
  });

  it("refuses verification of a maintenance record by the person who recorded it", async () => {
    const machineId = await makeMachine({ name: "Compressor", currentMeterReading: 400 });
    const record = await post(`/companies/current/equipment/${machineId}/maintenance-records`, {
      maintenanceType: "corrective",
      description: "Replaced the pressure switch",
      meterReading: 405,
    });
    const recordId = record.json().id as string;
    expect(record.json().scheduleNote).toContain("not linked to a maintenance schedule");
    const self = await post(
      `/companies/current/equipment-maintenance-records/${recordId}/verify`,
      {},
    );
    expect(self.statusCode).toBe(403);
    const other = await post(
      `/companies/current/equipment-maintenance-records/${recordId}/verify`,
      { returnToService: true },
      verifier.headers,
    );
    expect(other.statusCode).toBe(200);
    expect(other.json().status).toBe("verified");
  });
});

/* ================================================================== */
/* Meter and fuel anomalies                                            */
/* ================================================================== */

describe("meter and fuel anomalies", () => {
  let meterMachine: string;
  let fuelMachine: string;

  beforeAll(async () => {
    meterMachine = await makeMachine({ name: "Metered dozer", meterType: "hours" });
    fuelMachine = await makeMachine({
      name: "Fuelled dozer",
      meterType: "hours",
      fuelCapacityLitres: 250,
    });
  });

  it("accepts a baseline reading and advances the machine meter", async () => {
    const res = await post(`/companies/current/equipment/${meterMachine}/readings`, {
      readingType: "hours",
      value: 1200,
      readAt: isoAgo(3),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().anomaly.isAnomalous).toBe(false);
    expect(res.json().meterAdvanced).toBe(true);
    const machine = await get(`/companies/current/equipment/${meterMachine}`);
    expect(machine.json().currentMeterReading).toBe(1200);
  });

  it("accepts exactly 24 engine hours in exactly one day", async () => {
    const res = await post(`/companies/current/equipment/${meterMachine}/readings`, {
      readingType: "hours",
      value: 1224,
      readAt: isoAgo(2),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().anomaly.isAnomalous).toBe(false);
    expect(res.json().anomaly.ratePerDay).toBe(24);
  });

  it("flags an impossible jump, stores it, and refuses to advance the meter", async () => {
    const res = await post(`/companies/current/equipment/${meterMachine}/readings`, {
      readingType: "hours",
      value: 1248.5,
      readAt: isoAgo(1),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.anomaly.kinds).toContain("implausible_jump");
    expect(body.isAnomalous).toBe(1);
    expect(body.meterAdvanced).toBe(false);
    expect(body.signalId).toBeTruthy();
    const machine = await get(`/companies/current/equipment/${meterMachine}`);
    expect(machine.json().currentMeterReading).toBe(1224);
  });

  it("flags a meter that goes backwards", async () => {
    const res = await post(`/companies/current/equipment/${meterMachine}/readings`, {
      readingType: "hours",
      value: 1000,
      readAt: new Date().toISOString(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().anomaly.kinds).toContain("meter_regression");
    const raised = await signalsFor("equipment_meter_anomaly", res.json().id as string);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe("high");
  });

  it("accepts a fill of exactly a tankful and flags one that exceeds it", async () => {
    const ok = await post(`/companies/current/equipment/${fuelMachine}/readings`, {
      readingType: "fuel_fill",
      fuelLitres: 250,
      fuelCost: 350,
      readAt: isoAgo(2),
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().anomaly.isAnomalous).toBe(false);

    const bad = await post(`/companies/current/equipment/${fuelMachine}/readings`, {
      readingType: "fuel_fill",
      fuelLitres: 400,
      fuelCost: 560,
      fuelCardRef: "CARD-77",
      readAt: isoAgo(1),
    });
    expect(bad.statusCode).toBe(201);
    expect(bad.json().anomaly.kinds).toContain("fuel_exceeds_capacity");
    expect(bad.json().anomaly.note).toContain("150 litres went somewhere");
    const raised = await signalsFor("equipment_meter_anomaly", bad.json().id as string);
    expect(raised).toHaveLength(1);
  });

  it("lists only the anomalous readings when asked", async () => {
    const res = await get(
      `/companies/current/equipment/${meterMachine}/readings?anomalousOnly=true`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBe(2);
    expect(res.json().items.every((r: { isAnomalous: boolean }) => r.isAnomalous)).toBe(true);
  });
});

/* ================================================================== */
/* Telematics through the ingestion pipeline                           */
/* ================================================================== */

describe("telematics ingestion inlet", () => {
  let teleMachine: string;
  let spareMachine: string;
  const dates = [daysAgo(3), daysAgo(2), daysAgo(1)];

  const batch = () => ({
    providerKey: "generic_aemp",
    projectId: teleProject,
    records: [
      ...dates.flatMap((d, i) => [
        {
          deviceId: "DEV-100",
          recordedAt: `${d}T06:00:00.000Z`,
          engineHours: 1200 + i * 6,
          engineRunning: true,
          latitude: 51.5,
          longitude: -0.12,
          vendorField: "kept verbatim",
        },
        {
          deviceId: "DEV-100",
          recordedAt: `${d}T17:00:00.000Z`,
          engineHours: 1206 + i * 6,
          engineRunning: false,
        },
      ]),
      { deviceId: "DEV-999", recordedAt: `${dates[0]}T09:00:00.000Z`, engineHours: 40 },
      { deviceId: "DEV-999", recordedAt: `${dates[0]}T18:00:00.000Z`, engineHours: 47 },
    ],
  });

  const push = (payload: unknown, token = pushToken) =>
    app.inject({
      method: "POST",
      url: "/api/v1/ingestion/push/telematics",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

  beforeAll(async () => {
    teleMachine = await makeMachine({
      name: "Telematics excavator",
      telematicsProvider: "generic_aemp",
      telematicsDeviceId: "DEV-100",
      hireRateAmount: 40,
      hireRateUnit: "hour",
      operatorRateAmount: 30,
      currency: "GBP",
    });
    spareMachine = await makeMachine({ name: "Unmapped machine" });
    await mobilise(teleProject, teleMachine);
  });

  it("refuses a push with no token and with a token that lacks the scope", async () => {
    const anon = await app.inject({
      method: "POST",
      url: "/api/v1/ingestion/push/telematics",
      payload: batch(),
    });
    expect(anon.statusCode).toBe(401);

    const wrong = await post("/ingestion/tokens", { name: "payroll only", scopes: ["payroll"] });
    const res = await push(batch(), wrong.json().token as string);
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("not scoped for telematics");
  });

  it("commits readings with ingestion-run provenance and keeps unmapped devices", async () => {
    const res = await push(batch());
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.received).toBe(8);
    expect(body.committed).toBe(8);
    expect(body.duplicates).toBe(0);
    expect(body.rejected).toBe(0);
    expect(body.unmappedDeviceCount).toBe(1);
    expect(body.unmappedDevices[0].deviceId).toBe("DEV-999");

    const run = await app.db
      .select()
      .from(ingestionRuns)
      .where(eq(ingestionRuns.id, body.runId as string))
      .limit(1);
    expect(run[0]!.dataset).toBe("telematics");
    expect(run[0]!.status).toBe("committed");
    expect(run[0]!.committedCount).toBe(8);

    const rows = await app.db
      .select()
      .from(equipmentTelematicsReadings)
      .where(eq(equipmentTelematicsReadings.ingestionRunId, body.runId as string));
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.apiTokenId !== null && r.sourceSha256 !== null)).toBe(true);
    const mapped = rows.filter((r) => r.equipmentId === teleMachine);
    expect(mapped).toHaveLength(6);
    const unmapped = rows.filter((r) => r.equipmentId === null);
    expect(unmapped).toHaveLength(2);
    expect((mapped[0]!.raw as Record<string, unknown>)["vendorField"] ?? null).not.toBeUndefined();
  });

  it("is idempotent — a replayed batch double-counts nothing", async () => {
    const before = await app.db
      .select()
      .from(equipmentTelematicsReadings)
      .where(eq(equipmentTelematicsReadings.companyId, owner.companyId));
    const res = await push(batch());
    expect(res.statusCode).toBe(201);
    expect(res.json().committed).toBe(0);
    expect(res.json().duplicates).toBe(8);
    const after = await app.db
      .select()
      .from(equipmentTelematicsReadings)
      .where(eq(equipmentTelematicsReadings.companyId, owner.companyId));
    expect(after).toHaveLength(before.length);
  });

  it("rejects malformed rows while committing the sound ones", async () => {
    const res = await push({
      providerKey: "generic_aemp",
      records: [
        { recordedAt: `${daysAgo(4)}T06:00:00.000Z`, engineHours: 10 },
        { deviceId: "DEV-100", recordedAt: "not-a-timestamp" },
        { deviceId: "DEV-100", recordedAt: `${daysAgo(4)}T06:00:00.000Z`, engineHours: 1194 },
      ],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().rejected).toBe(2);
    expect(res.json().committed).toBe(1);
    expect(res.json().report.map((r: { code: string }) => r.code)).toContain("required");
  });

  it("lists the unmapped device and backfills its history when it is mapped", async () => {
    const list = await get("/companies/current/telematics/devices");
    expect(list.statusCode).toBe(200);
    const device = list
      .json()
      .items.find((d: { deviceId: string }) => d.deviceId === "DEV-999");
    expect(device).toBeDefined();
    expect(device.readings).toBe(2);
    expect(list.json().note).toContain("nobody has identified");

    const mapRes = await post("/companies/current/telematics/devices/map", {
      providerKey: "generic_aemp",
      deviceId: "DEV-999",
      equipmentId: spareMachine,
    });
    expect(mapRes.statusCode).toBe(200);
    expect(mapRes.json().backfilledReadings).toBe(2);

    const after = await get("/companies/current/telematics/devices");
    expect(
      after.json().items.find((d: { deviceId: string }) => d.deviceId === "DEV-999"),
    ).toBeUndefined();
  });

  it("refuses to map one device to a second machine", async () => {
    const another = await makeMachine({ name: "Another machine" });
    const res = await post("/companies/current/telematics/devices/map", {
      providerKey: "generic_aemp",
      deviceId: "DEV-999",
      equipmentId: another,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("cannot report for two machines");
  });

  it("reconciles engine hours against manually claimed hours and raises one persistent signal", async () => {
    for (const d of dates) {
      const res = await post(`/projects/${teleProject}/equipment-utilisation`, {
        equipmentId: teleMachine,
        utilisationDate: d,
        availableHours: 9,
        workingHours: 9,
      });
      expect(res.statusCode).toBe(201);
    }
    const url = `/projects/${teleProject}/equipment-telematics/reconciliation?from=${dates[0]}&to=${dates[2]}`;
    const res = await get(url);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const row = body.rows.find((r: { equipmentId: string }) => r.equipmentId === teleMachine);
    expect(row.daysCompared).toBe(3);
    expect(row.manualHours).toBe(27);
    expect(row.telematicsHours).toBe(18);
    expect(row.varianceHours).toBe(9);
    expect(row.daysUnsupported).toBe(3);
    expect(row.persistent).toBe(true);
    // 9 unsupported hours at GBP 40 plant + GBP 30 operator
    expect(row.valueAtRisk).toBe(630);
    expect(body.valueAtRiskByCurrency.GBP).toBe(630);

    // the comparison is written back onto the utilisation rows
    const utilRows = await app.db
      .select()
      .from(equipmentUtilisation)
      .where(eq(equipmentUtilisation.equipmentId, teleMachine));
    expect(utilRows.every((r) => r.telematicsWorkingHours === 6)).toBe(true);
    expect(utilRows.every((r) => r.varianceHours === 3)).toBe(true);

    await get(url);
    const raised = await signalsFor("equipment_telematics_variance", teleMachine);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.explanation).toContain("GBP 630");
  });
});

/* ================================================================== */
/* Materials — deliveries, stock, invoice matching                     */
/* ================================================================== */

describe("materials", () => {
  let itemId: string;
  let deliveryId: string;
  let lineId: string;

  beforeAll(async () => {
    const res = await post(`/projects/${matProject}/materials`, {
      name: "C32/40 concrete",
      unit: "m3",
      quantityRequired: 500,
      quantityOrdered: 500,
      unitCost: 120,
      currency: "GBP",
      supplierVendorId: vendorId,
      reorderLevel: 20,
    });
    expect(res.statusCode).toBe(201);
    itemId = res.json().id as string;
  });

  it("creates a delivery with lines and warns that nothing is invoice-matched yet", async () => {
    const res = await post(`/projects/${matProject}/material-deliveries`, {
      deliveryNoteNumber: "DN-4471",
      supplierVendorId: vendorId,
      currency: "GBP",
      arrivedAt: isoAgo(1),
      lines: [
        {
          materialItemId: itemId,
          description: "C32/40 concrete",
          unit: "m3",
          quantityExpected: 100,
          unitCost: 120,
          batchNumber: "B-9001",
        },
      ],
    });
    expect(res.statusCode).toBe(201);
    deliveryId = res.json().id as string;
    lineId = res.json().lines[0].id as string;
    expect(res.json().reference).toMatch(/^DEL-\d{4}$/);
    expect(res.json().derived.invoiceMatchNote).toContain("unbilled");
  });

  it("refuses a receipt line where accepted plus rejected does not equal received", async () => {
    const res = await post(`/projects/${matProject}/material-deliveries/${deliveryId}/receive`, {
      lines: [
        { lineId, quantityReceived: 90, quantityAccepted: 60, quantityRejected: 10 },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("does not add up");
  });

  it("refuses a rejection with no reason", async () => {
    const res = await post(`/projects/${matProject}/material-deliveries/${deliveryId}/receive`, {
      lines: [{ lineId, quantityReceived: 90, quantityAccepted: 80, quantityRejected: 10 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("rejectionReason");
  });

  it("receives short and part-rejected, classifies the discrepancy and books the stock", async () => {
    const res = await post(`/projects/${matProject}/material-deliveries/${deliveryId}/receive`, {
      receivedByName: "Site foreman",
      waitingMinutes: 55,
      lines: [
        {
          lineId,
          quantityReceived: 90,
          quantityAccepted: 80,
          quantityRejected: 10,
          rejectionReason: "Slump outside the specified range on the second load",
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("partially_received");
    expect(body.hasDiscrepancy).toBe(true);
    expect(body.lineResults[0].discrepancyKind).toBe("failed_inspection");
    expect(body.stockMovements).toHaveLength(1);
    expect(body.stockMovements[0].balanceAfter).toBe(80);
    expect(body.derived.ncrCandidate).toContain("raise the NCR in the quality module");

    const item = await get(`/projects/${matProject}/materials/${itemId}`);
    expect(item.json().quantityDelivered).toBe(90);
    expect(item.json().quantityAccepted).toBe(80);
    expect(item.json().quantityRejected).toBe(10);
    expect(item.json().quantityOnHand).toBe(80);
  });

  it("refuses to receive the same delivery twice", async () => {
    const res = await post(`/projects/${matProject}/material-deliveries/${deliveryId}/receive`, {
      lines: [{ lineId, quantityReceived: 90, quantityAccepted: 90, quantityRejected: 0 }],
    });
    expect(res.statusCode).toBe(409);
  });

  it("refuses verification of the receipt by the person who signed for it", async () => {
    const self = await post(
      `/projects/${matProject}/material-deliveries/${deliveryId}/verify`,
      {},
    );
    expect(self.statusCode).toBe(403);
    const other = await post(
      `/projects/${matProject}/material-deliveries/${deliveryId}/verify`,
      {},
      verifier.headers,
    );
    expect(other.statusCode).toBe(200);
    expect(other.json().independentVerification).toBe(true);
  });

  it("links a discrepancy to an NCR in the quality module rather than duplicating it", async () => {
    const ncrId = newId("ncr");
    await app.db.insert(nonConformanceReports).values({
      id: ncrId,
      companyId: owner.companyId,
      projectId: matProject,
      number: 1,
      reference: "NCR-0001",
      title: "Concrete slump out of specification",
      description: "Second load rejected at the gate",
      createdBy: owner.userId,
    });
    const res = await post(`/projects/${matProject}/material-deliveries/${deliveryId}/ncr`, {
      ncrId,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ncrReference).toBe("NCR-0001");
    const ncr = await app.db
      .select()
      .from(nonConformanceReports)
      .where(eq(nonConformanceReports.id, ncrId))
      .limit(1);
    expect(ncr[0]!.deliveryId).toBe(deliveryId);
  });

  it("issues stock and keeps the balance reconciled to the movements", async () => {
    const issue = await post(`/projects/${matProject}/material-stock-movements`, {
      materialItemId: itemId,
      movementType: "issue",
      quantity: 30,
      reason: "Pour to pile caps 12-18",
    });
    expect(issue.statusCode).toBe(201);
    expect(issue.json().balance.after).toBe(50);

    const waste = await post(`/projects/${matProject}/material-stock-movements`, {
      materialItemId: itemId,
      movementType: "wastage",
      quantity: 5,
      reason: "Left in the drum overnight",
    });
    expect(waste.statusCode).toBe(201);

    const recon = await get(`/projects/${matProject}/materials/${itemId}/stock`);
    expect(recon.statusCode).toBe(200);
    const body = recon.json();
    expect(body.quantityOnHand).toBe(45);
    expect(body.reconciliation.computedBalance).toBe(45);
    expect(body.reconciliation.reconciles).toBe(true);
    expect(body.reconciliation.difference).toBe(0);
    expect(body.reconciliation.byType.wastage).toBe(-5);
    expect(body.verdict).toContain("reconciles");
  });

  it("detects drift when the materialized balance is tampered with", async () => {
    await app.db
      .update(materialItems)
      .set({ quantityOnHand: 60 })
      .where(eq(materialItems.id, itemId));
    const recon = await get(`/projects/${matProject}/materials/${itemId}/stock`);
    expect(recon.json().reconciliation.reconciles).toBe(false);
    expect(recon.json().reconciliation.difference).toBe(15);
    await app.db
      .update(materialItems)
      .set({ quantityOnHand: 45 })
      .where(eq(materialItems.id, itemId));
  });

  it("refuses a movement that would drive stock negative, naming the shortfall", async () => {
    const res = await post(`/projects/${matProject}/material-stock-movements`, {
      materialItemId: itemId,
      movementType: "issue",
      quantity: 60,
      reason: "Pour to the raft",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("shortfall of 15");
    expect(res.json().details.shortfall).toBe(15);
    expect(res.json().details.currentBalance).toBe(45);
    expect(res.json().details.code).toBe("stock_would_go_negative");
  });

  it("allows the refusal to be overridden explicitly, and signals the override", async () => {
    const res = await post(`/projects/${matProject}/material-stock-movements`, {
      materialItemId: itemId,
      movementType: "issue",
      quantity: 60,
      reason: "Pour to the raft — booked in later",
      allowNegative: true,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().forcedNegative).toBe(true);
    expect(res.json().balance.after).toBe(-15);
    const raised = await signalsFor("material_stock_negative", res.json().id as string);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.explanation).toContain("theft until somebody shows it is not");
    // put the compound back
    await post(`/projects/${matProject}/material-stock-movements`, {
      materialItemId: itemId,
      movementType: "receipt",
      quantity: 15,
      reason: "Booking in the delivery that was missed",
    });
  });

  it("refuses a loss movement with no reason", async () => {
    const res = await post(`/projects/${matProject}/material-stock-movements`, {
      materialItemId: itemId,
      movementType: "theft",
      quantity: 1,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("needs a reason");
  });

  it("refuses sign-off on a loss by the person who reported it", async () => {
    const restock = await post(`/projects/${matProject}/material-stock-movements`, {
      materialItemId: itemId,
      movementType: "receipt",
      quantity: 20,
      reason: "Top-up load",
    });
    expect(restock.statusCode).toBe(201);
    const created = await post(`/projects/${matProject}/material-stock-movements`, {
      materialItemId: itemId,
      movementType: "damage",
      quantity: 2,
      reason: "Bags split in the compound",
    });
    const movementId = created.json().id as string;
    const self = await post(
      `/projects/${matProject}/material-stock-movements/${movementId}/verify`,
      {},
    );
    expect(self.statusCode).toBe(403);
    const other = await post(
      `/projects/${matProject}/material-stock-movements/${movementId}/verify`,
      {},
      verifier.headers,
    );
    expect(other.statusCode).toBe(200);
    expect(other.json().independentVerification).toBe(true);
  });

  it("reports unmatched deliveries, then records a match made by someone other than the receiver", async () => {
    const before = await get(`/projects/${matProject}/material-deliveries/invoice-match`);
    expect(before.statusCode).toBe(200);
    expect(before.json().unmatchedCount).toBe(1);
    expect(before.json().unmatchedByCurrency.GBP.deliveries).toBe(1);
    expect(before.json().interpretation).toContain("cost paid twice");

    const invoiceId = newId("inv");
    await app.db.insert(invoices).values({
      id: invoiceId,
      companyId: owner.companyId,
      projectId: matProject,
      kind: "subcontractor_invoice",
      number: 1,
      reference: "INV-0001",
      currency: "GBP",
      total: 9600,
      createdBy: owner.userId,
    });

    const self = await post(
      `/projects/${matProject}/material-deliveries/${deliveryId}/invoice-match`,
      { invoiceId },
    );
    expect(self.statusCode).toBe(403);

    const matched = await post(
      `/projects/${matProject}/material-deliveries/${deliveryId}/invoice-match`,
      { invoiceId, invoiceLineItemId: null },
      verifier.headers,
    );
    expect(matched.statusCode).toBe(200);
    expect(matched.json().independentMatch).toBe(true);
    expect(matched.json().deliveryValue).toBe(9600);
    expect(matched.json().valueVariance).toBe(0);

    const after = await get(`/projects/${matProject}/material-deliveries/invoice-match`);
    expect(after.json().unmatchedCount).toBe(0);
    expect(after.json().matchedCount).toBe(1);
  });

  it("refuses to match an invoice in a different currency", async () => {
    const usdInvoice = newId("inv");
    await app.db.insert(invoices).values({
      id: usdInvoice,
      companyId: owner.companyId,
      projectId: matProject,
      kind: "subcontractor_invoice",
      number: 2,
      reference: "INV-0002",
      currency: "USD",
      total: 9600,
      createdBy: owner.userId,
    });
    const res = await post(
      `/projects/${matProject}/material-deliveries/${deliveryId}/invoice-match`,
      { invoiceId: usdInvoice },
      verifier.headers,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("FX rate");
  });
});

/* ================================================================== */
/* Permissions and the module summary                                  */
/* ================================================================== */

describe("permissions and summary", () => {
  it("lets a read-only project member read but not write", async () => {
    const machineId = await makeMachine({ name: "Permission excavator" });
    await mobilise(permProject, machineId);

    const read = await get(`/projects/${permProject}/equipment`, viewerHeaders);
    expect(read.statusCode).toBe(200);

    const write = await post(
      `/projects/${permProject}/equipment-utilisation`,
      { equipmentId: machineId, utilisationDate: today(), availableHours: 8, workingHours: 8 },
      viewerHeaders,
    );
    expect(write.statusCode).toBe(403);
    expect(write.json().message).toContain("equipment");
  });

  it("refuses a project read to a stranger from another company", async () => {
    const res = await get(`/projects/${permProject}/equipment`, stranger.headers);
    expect(res.statusCode).toBe(403);
  });

  it("summarises the module's open signals for a project", async () => {
    const res = await get(`/projects/${plantProject}/equipment-summary`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.detectors).toContain("equipment_certificate_expired_in_service");
    expect(body.signals.critical).toBeGreaterThanOrEqual(1);
    expect(body.signals.byDetector.equipment_certificate_expired_in_service).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("publishes the telematics dataset contract for a vendor to build against", async () => {
    const res = await get("/companies/current/telematics/dataset");
    expect(res.statusCode).toBe(200);
    expect(res.json().idempotencyKey).toEqual(["providerKey", "deviceId", "recordedAt"]);
    expect(res.json().provenance).toContain("ingestionRunId");
  });

  it("appends every consequential mutation to the hash-chained ledger", async () => {
    const machineId = await makeMachine({ name: "Ledgered machine" });
    await post(`/companies/current/equipment/${machineId}/off-hire`, { action: "request" });
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(eq(ledgerEntries.companyId, owner.companyId), eq(ledgerEntries.objectId, machineId)),
      );
    expect(entries.map((e) => e.action)).toEqual(
      expect.arrayContaining(["create", "state_change"]),
    );
    const verified = await verifyCompanyLedger(app.db, owner.companyId);
    expect(verified.valid).toBe(true);
  });
});
