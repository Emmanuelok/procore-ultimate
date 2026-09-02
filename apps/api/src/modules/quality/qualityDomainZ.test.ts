/**
 * Domain Z quality registers, end to end (#1085–1100).
 *
 * Concrete, welding and NDT, material test certificates, concessions,
 * calibration, rework and audits — plus the sweeps that keep them honest when
 * nobody is looking, run here through the platform scheduler exactly as they
 * run in production.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  companyMemberships,
  nonConformanceReports,
  projects,
  qualityConcessions,
  signals,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;

/** the contractor's QA lead */
let owner: TestActor;
/** the engineer: approves, verifies, releases */
let engineer: TestActor;
/** somebody from another company entirely */
let stranger: TestActor;
let engineerHeaders: Record<string, string>;
let projectId: string;
let vendorId: string;

const api = (path: string) => `/api/v1${path}`;
const base = () => `/projects/${projectId}`;

const post = (path: string, payload: unknown, headers = owner.headers) =>
  app.inject({ method: "POST", url: api(path), payload: payload as object, headers });
const get = (path: string, headers = owner.headers) =>
  app.inject({ method: "GET", url: api(path), headers });
const patch = (path: string, payload: unknown, headers = owner.headers) =>
  app.inject({ method: "PATCH", url: api(path), payload: payload as object, headers });

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  engineer = await registerActor(app);
  stranger = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: engineer.userId,
    role: "admin",
  });
  engineerHeaders = {
    authorization: engineer.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };
  projectId = newId("prj");
  await app.db
    .insert(projects)
    .values({ id: projectId, companyId: owner.companyId, name: "Domain Z" });
  vendorId = newId("ven");
  await app.db
    .insert(vendors)
    .values({ id: vendorId, companyId: owner.companyId, name: "Steel Sub Ltd" });
}, 180_000);

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* Concessions (#1091)                                                 */
/* ================================================================== */

describe("concessions", () => {
  let concessionId: string;

  it("refuses to submit a concession that does not say what it departs from", async () => {
    const created = await post(`${base()}/concessions`, {
      title: "Reduced cover to slab soffit",
      description: "Cover measured at 30mm against 40mm specified over a 4m² area.",
      quantityLimit: 4,
      unit: "m2",
      vendorId,
    });
    expect(created.statusCode).toBe(201);
    concessionId = created.json().id;
    expect(created.json().reference).toBe("CON-001");
    expect(created.json().standing.live).toBe(false);

    const submitted = await post(`${base()}/concessions/${concessionId}/submit`, {});
    expect(submitted.statusCode).toBe(400);
    expect(submitted.json().message).toContain("does not state the departure");
  });

  it("refuses the decision from the person who asked for the departure", async () => {
    await patch(`${base()}/concessions/${concessionId}`, {
      departureFromRequirement: "Spec 03 30 00 cl.3.4 requires 40mm nominal cover.",
      justification: "Structural check shows adequate durability at 30mm in this exposure class.",
    });
    const submitted = await post(`${base()}/concessions/${concessionId}/submit`, {});
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().status).toBe("submitted");

    const selfApproved = await post(`${base()}/concessions/${concessionId}/approve`, {
      decision: "approve",
      approvalAuthority: "Structural engineer",
    });
    expect(selfApproved.statusCode).toBe(403);
    expect(selfApproved.json().message).toContain("someone other than");
  });

  it("demands the conditions when the approval is conditional, then grants it", async () => {
    const noConditions = await post(
      `${base()}/concessions/${concessionId}/approve`,
      { decision: "approve_with_conditions", approvalAuthority: "Structural engineer" },
      engineerHeaders,
    );
    expect(noConditions.statusCode).toBe(400);
    expect(noConditions.json().message).toContain("state the conditions");

    const approved = await post(
      `${base()}/concessions/${concessionId}/approve`,
      {
        decision: "approve_with_conditions",
        approvalAuthority: "Structural engineer",
        conditions: "Apply an additional protective coating within 28 days.",
        expiryDate: "2020-06-30",
      },
      engineerHeaders,
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe("approved_with_conditions");
    expect(approved.json().approvedBy).toBe(engineer.userId);
  });

  it("expires what has run out and raises exactly one signal, however often the sweep runs", async () => {
    const status = await app.scheduler.runNow("quality.concessions");
    expect(status.state).toBe("succeeded");
    await app.scheduler.runNow("quality.concessions");

    const [row] = await app.db
      .select()
      .from(qualityConcessions)
      .where(eq(qualityConcessions.id, concessionId));
    expect(row!.status).toBe("expired");

    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "quality_concession_expiring"),
        ),
      );
    expect(raised).toHaveLength(1);
    expect(raised[0]!.explanation).toContain("non-conforming again");
  });

  it("summarises the register, naming the concessions that never expire", async () => {
    const forever = await post(`${base()}/concessions`, {
      title: "Permanent deviation to handrail detail",
      description: "Detail differs from the drawing; designer accepts it as built.",
      departureFromRequirement: "Drawing A-410 rev C handrail detail.",
    });
    await post(`${base()}/concessions/${forever.json().id}/submit`, {});
    await post(
      `${base()}/concessions/${forever.json().id}/approve`,
      { decision: "approve", approvalAuthority: "Architect" },
      engineerHeaders,
    );
    const summary = await get(`${base()}/concessions-summary`);
    expect(summary.statusCode).toBe(200);
    expect(summary.json().total).toBe(2);
    expect(summary.json().live).toBe(1);
    expect(summary.json().expired).toBe(1);
    expect(summary.json().withoutExpiry).toBe(1);
  });

  it("refuses the whole register to another company", async () => {
    expect((await get(`${base()}/concessions`, stranger.headers)).statusCode).toBe(403);
    expect(
      (await post(`${base()}/concessions`, { title: "x", description: "y" }, stranger.headers))
        .statusCode,
    ).toBe(403);
    expect(
      (await get(`${base()}/concessions/${concessionId}`, stranger.headers)).statusCode,
    ).toBe(403);
  });
});

/* ================================================================== */
/* Concrete (#1085–1086)                                               */
/* ================================================================== */

describe("concrete pours", () => {
  let itpId: string;
  let activityId: string;
  let pourId: string;

  beforeAll(async () => {
    const itp = await post(`${base()}/itps`, { title: "Slab ITP" });
    itpId = itp.json().id;
    const activity = await post(`${base()}/itps/${itpId}/activities`, {
      activity: "Pre-pour inspection",
      interventionPoint: "hold_point",
      verifyingParties: [{ party: "engineer", userId: engineer.userId }],
    });
    activityId = activity.json().id;
  }, 60_000);

  it("refuses to record a pour over an unreleased pre-pour hold point", async () => {
    const created = await post(`${base()}/concrete-pours`, {
      pourName: "Level 3 slab bay 2",
      elementType: "slab",
      specifiedGrade: "C32/40",
      specifiedStrengthMpa: 40,
      acceptanceCode: "en_206",
      mixReference: "MIX-C3240",
      supplierVendorId: vendorId,
      itpActivityId: activityId,
      slumpSpecMin: 100,
      slumpSpecMax: 150,
      volumeM3: 48,
    });
    expect(created.statusCode).toBe(201);
    pourId = created.json().id;

    const blocked = await post(`${base()}/concrete-pours/${pourId}/pour`, { slumpMm: 120 });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().message).toContain("pre-pour hold point");

    const noReason = await post(`${base()}/concrete-pours/${pourId}/pour`, {
      slumpMm: 120,
      proceedWithoutRelease: true,
    });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().message).toContain("must state why");
  });

  it("records the pour once the hold point is released, and judges the slump", async () => {
    const released = await post(
      `${base()}/itps/${itpId}/activities/${activityId}/release`,
      { note: "Reinforcement checked." },
      engineerHeaders,
    );
    expect(released.statusCode).toBe(200);

    const poured = await post(`${base()}/concrete-pours/${pourId}/pour`, {
      slumpMm: 165,
      concreteTempC: 22,
      deliveryTickets: [
        { ticketNumber: "T-1001", volumeM3: 24, batchNumber: "B-77" },
        { ticketNumber: "T-1002", volumeM3: 24, batchNumber: "B-78" },
      ],
      batchNumbers: ["B-77", "B-78"],
    });
    expect(poured.statusCode).toBe(200);
    expect(poured.json().status).toBe("poured");
    expect(poured.json().volumeM3).toBe(48);
    expect(poured.json().slump.passed).toBe(false);
    expect(poured.json().holdPointReleasedBy).toBe(engineer.userId);

    const second = await post(`${base()}/concrete-pours/${pourId}/pour`, {});
    expect(second.statusCode).toBe(409);
  });

  it("cannot judge a pour with no specimens, and says so rather than passing it", async () => {
    const detail = await get(`${base()}/concrete-pours/${pourId}`);
    expect(detail.json().assessment.verdict).toBe("not_assessable");
    expect(detail.json().assessment.statistics.mean).toBeNull();
  });

  it("judges the run against EN 206 and raises an NCR when it fails", async () => {
    const specimens = await post(`${base()}/concrete-pours/${pourId}/specimens`, {
      specimens: [
        { specimenRef: "C1", testAgeDays: 28 },
        { specimenRef: "C2", testAgeDays: 28 },
        { specimenRef: "C3", testAgeDays: 28 },
      ],
    });
    expect(specimens.statusCode).toBe(201);
    const ids = (specimens.json().specimens as Array<{ id: string; specimenRef: string }>).sort(
      (a, b) => (a.specimenRef < b.specimenRef ? -1 : 1),
    );

    // Two healthy results: still inconclusive, because the third is outstanding.
    for (const [index, strength] of [46, 47].entries()) {
      const res = await post(
        `${base()}/concrete-pours/${pourId}/specimens/${ids[index]!.id}/result`,
        { strengthMpa: strength, testDate: `2030-01-0${index + 1}` },
      );
      expect(res.statusCode).toBe(200);
    }
    const midway = await get(`${base()}/concrete-pours/${pourId}`);
    expect(midway.json().assessment.verdict).toBe("inconclusive");

    // The third comes back 8 MPa below the characteristic strength.
    const failing = await post(
      `${base()}/concrete-pours/${pourId}/specimens/${ids[2]!.id}/result`,
      { strengthMpa: 32, testDate: "2030-01-03" },
    );
    expect(failing.statusCode).toBe(200);
    expect(failing.json().assessment.verdict).toBe("rejected");
    expect(failing.json().raised.ncr).not.toBeNull();
    expect(failing.json().status).toBe("rejected");

    const ncrs = await app.db
      .select()
      .from(nonConformanceReports)
      .where(
        and(
          eq(nonConformanceReports.projectId, projectId),
          eq(nonConformanceReports.category, "material"),
        ),
      );
    expect(ncrs).toHaveLength(1);
    expect(ncrs[0]!.severity).toBe("critical");
  });

  it("demands a reason before a specimen can be voided", async () => {
    const detail = await get(`${base()}/concrete-pours/${pourId}`);
    const specimenId = detail.json().specimens[0].id as string;
    const voided = await post(
      `${base()}/concrete-pours/${pourId}/specimens/${specimenId}/result`,
      { result: "void" },
    );
    expect(voided.statusCode).toBe(400);
    expect(voided.json().message).toContain("indistinguishable from a result");
  });

  it("summarises by mix, and refuses to report an untested mix as passing", async () => {
    await post(`${base()}/concrete-pours`, {
      pourName: "Untested bay",
      mixReference: "MIX-UNTESTED",
      specifiedStrengthMpa: 30,
    });
    const summary = await get(`${base()}/concrete-summary`);
    expect(summary.statusCode).toBe(200);
    expect(summary.json().pours).toBe(2);
    expect(summary.json().failing).toBe(1);
    const untested = (summary.json().mixes as Array<{ mixReference: string; reasons: string[] }>).find(
      (m) => m.mixReference === "MIX-UNTESTED",
    );
    expect(untested!.reasons.join(" ")).toContain("untested, not passing");
  });
});

/* ================================================================== */
/* Welding and NDT (#1087–1088)                                        */
/* ================================================================== */

describe("welding", () => {
  let wpsId: string;
  let lapsedQualId: string;
  let currentQualId: string;
  let weldId: string;

  it("refuses to approve a procedure with no PQR, or by its own author", async () => {
    const created = await post(`${base()}/welding-procedures`, {
      wpsNumber: "WPS-001",
      title: "Butt welds, P1 material, GTAW root",
      process: "gtaw",
      positions: ["6G"],
      baseMaterialGroup: "P1",
      thicknessMinMm: 3,
      thicknessMaxMm: 20,
      vendorId,
    });
    expect(created.statusCode).toBe(201);
    wpsId = created.json().id;

    const noPqr = await post(`${base()}/welding-procedures/${wpsId}/approve`, {}, engineerHeaders);
    expect(noPqr.statusCode).toBe(400);
    expect(noPqr.json().message).toContain("procedure qualification record");

    await patch(`${base()}/welding-procedures/${wpsId}`, { pqrReference: "PQR-014" });
    const selfApproved = await post(`${base()}/welding-procedures/${wpsId}/approve`, {});
    expect(selfApproved.statusCode).toBe(403);

    const approved = await post(
      `${base()}/welding-procedures/${wpsId}/approve`,
      {},
      engineerHeaders,
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe("approved");

    const duplicate = await post(`${base()}/welding-procedures`, {
      wpsNumber: "WPS-001",
      title: "A second document under the same number",
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it("lapses a welder on continuity, not just on the certificate date", async () => {
    const lapsed = await post(`${base()}/welder-qualifications`, {
      welderName: "J. Lapsed",
      welderStamp: "W-01",
      processes: ["gtaw"],
      positions: ["6G"],
      thicknessMinMm: 3,
      thicknessMaxMm: 20,
      expiryDate: "2099-01-01",
      continuityConfirmedAt: "2020-01-01",
      continuityMonths: 6,
      vendorId,
    });
    expect(lapsed.statusCode).toBe(201);
    lapsedQualId = lapsed.json().id;
    expect(lapsed.json().status).toBe("expired");
    expect(lapsed.json().standing.reasons.join(" ")).toContain("continuity");

    const current = await post(`${base()}/welder-qualifications`, {
      welderName: "K. Current",
      welderStamp: "W-02",
      processes: ["gtaw"],
      positions: ["6G"],
      thicknessMinMm: 3,
      thicknessMaxMm: 20,
      expiryDate: "2099-01-01",
      continuityConfirmedAt: new Date().toISOString().slice(0, 10),
      vendorId,
    });
    currentQualId = current.json().id;
    expect(current.json().status).toBe("valid");
  });

  it("refuses a joint welded by a lapsed welder, and raises the NCR when it is recorded anyway", async () => {
    const created = await post(`${base()}/welds`, {
      jointReference: "SP-101-W12",
      jointType: "butt",
      thicknessMm: 12,
      diameterMm: 168,
      wpsId,
      ndtRequiredPercent: 100,
      ndtMethodsRequired: ["rt"],
      heatNumbers: ["H-4471"],
      vendorId,
    });
    expect(created.statusCode).toBe(201);
    weldId = created.json().id;
    expect(created.json().reference).toBe("W-0001");

    const refused = await post(`${base()}/welds/${weldId}/weld`, {
      welderQualificationId: lapsedQualId,
      weldedAt: "2030-02-01",
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toContain("qualification was expired");

    const forced = await post(`${base()}/welds/${weldId}/weld`, {
      welderQualificationId: lapsedQualId,
      weldedAt: "2030-02-01",
      recordNonCompliant: true,
      nonComplianceReason: "Historic joint being recorded during a records audit.",
    });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().compliance.compliant).toBe(false);
    expect(forced.json().raised.ncr).not.toBeNull();
  });

  it("rejects a joint on NDT, raises the NCR and lets a repair be recorded", async () => {
    const good = await post(`${base()}/welds`, {
      jointReference: "SP-101-W13",
      thicknessMm: 10,
      wpsId,
      ndtRequiredPercent: 100,
      ndtMethodsRequired: ["rt"],
      vendorId,
    });
    const secondWeldId = good.json().id as string;
    const welded = await post(`${base()}/welds/${secondWeldId}/weld`, {
      welderQualificationId: currentQualId,
    });
    expect(welded.statusCode).toBe(200);
    expect(welded.json().compliance.compliant).toBe(true);

    const ndt = await post(`${base()}/welds/${secondWeldId}/ndt`, {
      method: "rt",
      acceptanceStandard: "ISO 5817 level B",
      performedByOrganisation: "Independent NDT Ltd",
      technicianName: "R. Tech",
      technicianLevel: "II",
    });
    expect(ndt.statusCode).toBe(201);

    const rejected = await post(
      `${base()}/welds/${secondWeldId}/ndt/${ndt.json().id}/result`,
      { result: "reject", defectType: "lack of fusion", defectLengthMm: 18, reportNumber: "RT-889" },
    );
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().weld.status).toBe("rejected");
    expect(rejected.json().weld.repairCount).toBe(1);
    expect(rejected.json().raised.ncr).not.toBeNull();

    const twice = await post(
      `${base()}/welds/${secondWeldId}/ndt/${ndt.json().id}/result`,
      { result: "accept" },
    );
    expect(twice.statusCode).toBe(400);

    const repaired = await post(`${base()}/welds/${secondWeldId}/repair`, {
      repairProcedureRef: "WPS-R-002",
      note: "Ground out and re-run.",
    });
    expect(repaired.statusCode).toBe(200);
    expect(repaired.json().status).toBe("repaired");
  });

  it("reports coverage and repair rate, and flags the joints nobody examined", async () => {
    const summary = await get(`${base()}/welding-summary`);
    expect(summary.statusCode).toBe(200);
    expect(summary.json().programme.weldedCount).toBe(2);
    expect(summary.json().programme.repairRate.value).toBe(100);
    expect(summary.json().programme.coverageShortfalls).toHaveLength(1);
    expect(summary.json().qualifications.expired).toBe(1);
    expect(summary.json().nonCompliantWelds).toHaveLength(1);

    const sweep = await app.scheduler.runNow("quality.welding");
    expect(sweep.state).toBe("succeeded");
    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "quality_ndt_coverage_short")),
      );
    expect(raised.length).toBeGreaterThanOrEqual(1);
  });
});

/* ================================================================== */
/* Material test certificates (#1089)                                  */
/* ================================================================== */

describe("material test certificates", () => {
  let certificateId: string;

  it("records a certificate and refuses verification by the person who filed it", async () => {
    const created = await post(`${base()}/material-certificates`, {
      certificateNumber: "MC-99814",
      certificateType: "en_10204_3_1",
      materialDescription: "S355J2 plate, 20mm",
      heatNumber: "H-4471",
      supplierVendorId: vendorId,
      requiredProperties: [
        { property: "Yield strength", min: 355, unit: "MPa" },
        { property: "Carbon equivalent", max: 0.45 },
      ],
      measuredProperties: [
        { property: "Yield strength", value: 402, unit: "MPa" },
        { property: "Carbon equivalent", value: 0.41 },
      ],
      documentFileId: newId("file"),
    });
    expect(created.statusCode).toBe(201);
    certificateId = created.json().id;
    expect(created.json().check.lotTraceable).toBe(true);

    const selfVerified = await post(`${base()}/material-certificates/${certificateId}/verify`, {});
    expect(selfVerified.statusCode).toBe(403);

    const verified = await post(
      `${base()}/material-certificates/${certificateId}/verify`,
      { notes: "Checked against spec 05 12 00." },
      engineerHeaders,
    );
    expect(verified.statusCode).toBe(200);
    expect(verified.json().verificationStatus).toBe("verified");
  });

  it("fails a certificate that misses the specification and raises the NCR", async () => {
    const created = await post(`${base()}/material-certificates`, {
      certificateNumber: "MC-99815",
      materialDescription: "S355J2 plate, 25mm",
      heatNumber: "H-5000",
      supplierVendorId: vendorId,
      requiredProperties: [{ property: "Yield strength", min: 355, unit: "MPa" }],
      measuredProperties: [{ property: "Yield strength", value: 310, unit: "MPa" }],
      documentFileId: newId("file"),
    });
    const verified = await post(
      `${base()}/material-certificates/${created.json().id}/verify`,
      {},
      engineerHeaders,
    );
    expect(verified.statusCode).toBe(200);
    expect(verified.json().verificationStatus).toBe("failed");
    expect(verified.json().raised.ncr).not.toBeNull();
  });

  it("refuses to verify a certificate with nothing specified to verify against", async () => {
    const created = await post(`${base()}/material-certificates`, {
      certificateNumber: "MC-99816",
      materialDescription: "Bolts, grade 8.8",
      heatNumber: "H-6000",
    });
    const verified = await post(
      `${base()}/material-certificates/${created.json().id}/verify`,
      {},
      engineerHeaders,
    );
    expect(verified.statusCode).toBe(400);
    expect(verified.json().message).toContain("nothing to verify it against");
  });

  it("traces a heat number across the company and admits when it holds nothing", async () => {
    const found = await get("/companies/current/material-certificates/trace?heatNumber=H-4471");
    expect(found.statusCode).toBe(200);
    expect(found.json().total).toBe(1);

    const missing = await get("/companies/current/material-certificates/trace?heatNumber=H-NOPE");
    expect(missing.json().total).toBe(0);
    expect(missing.json().reasons.join(" ")).toContain("No certificate in this company records");
  });

  it("summarises the register with the certificates nobody has read", async () => {
    const summary = await get(`${base()}/material-certificates-summary`);
    expect(summary.json().total).toBe(3);
    expect(summary.json().failed).toBe(1);
    expect(summary.json().unverified).toBe(1);
  });
});

/* ================================================================== */
/* Calibration (#1097)                                                 */
/* ================================================================== */

describe("calibration register", () => {
  let instrumentId: string;

  it("derives the due date and refuses a duplicate serial", async () => {
    const created = await post(`${base()}/instruments`, {
      name: "Torque wrench 0–300 Nm",
      serialNumber: "TW-3391",
      instrumentType: "torque_wrench",
      calibrationIntervalMonths: 12,
      lastCalibratedAt: "2029-01-15",
      certificateNumber: "CAL-1",
    });
    expect(created.statusCode).toBe(201);
    instrumentId = created.json().id;
    expect(created.json().calibrationDueDate).toBe("2030-01-15");

    const duplicate = await post(`${base()}/instruments`, {
      name: "Another wrench",
      serialNumber: "TW-3391",
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it("marks an out-of-date instrument overdue on the sweep, once", async () => {
    await post(`${base()}/instruments`, {
      name: "Pressure gauge",
      serialNumber: "PG-1",
      lastCalibratedAt: "2019-01-01",
      calibrationIntervalMonths: 12,
    });
    const status = await app.scheduler.runNow("quality.calibration");
    expect(status.state).toBe("succeeded");
    await app.scheduler.runNow("quality.calibration");
    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "quality_calibration_overdue")),
      );
    expect(raised).toHaveLength(1);
    expect(raised[0]!.explanation).toContain("not a reading");
  });

  it("names the readings put in doubt when an instrument fails calibration", async () => {
    await post(`${base()}/instruments/${instrumentId}/calibrate`, {
      calibratedAt: "2029-01-15",
      result: "pass",
      certificateNumber: "CAL-2029",
    });
    const failed = await post(`${base()}/instruments/${instrumentId}/calibrate`, {
      calibratedAt: "2030-01-20",
      result: "fail",
      asFoundCondition: "Reading 6% high across the range",
    });
    expect(failed.statusCode).toBe(201);
    expect(failed.json().readingsInDoubt.from).toBe("2029-01-15");
    expect(failed.json().status).toBe("out_of_service");
    expect(failed.json().standing.usable).toBe(false);
  });

  it("summarises what can and cannot be used", async () => {
    const summary = await get(`${base()}/instruments-summary`);
    expect(summary.json().total).toBe(2);
    expect(summary.json().unusable).toBeGreaterThanOrEqual(1);
  });
});

/* ================================================================== */
/* Rework and the cost of quality (#1098–1100)                         */
/* ================================================================== */

describe("rework register", () => {
  it("totals only the cost lines it was given, and segregates the verification", async () => {
    const created = await post(`${base()}/rework-items`, {
      title: "Recast slab bay 2",
      causeCategory: "material_defect",
      discoveryPhase: "at_inspection",
      trade: "Concrete",
      responsibleVendorId: vendorId,
      labourCost: 4200,
      materialCost: 1800,
      currency: "GBP",
      costBasis: "quoted",
      labourHours: 96,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().totalCost).toBe(6000);
    const reworkId = created.json().id as string;

    const verifyTooEarly = await post(
      `${base()}/rework-items/${reworkId}/verify`,
      {},
      engineerHeaders,
    );
    expect(verifyTooEarly.statusCode).toBe(400);

    await post(`${base()}/rework-items/${reworkId}/status`, { status: "complete" });
    const selfVerified = await post(`${base()}/rework-items/${reworkId}/verify`, {});
    expect(selfVerified.statusCode).toBe(403);

    const verified = await post(`${base()}/rework-items/${reworkId}/verify`, {}, engineerHeaders);
    expect(verified.statusCode).toBe(200);
    expect(verified.json().status).toBe("verified");
  });

  it("reports uncosted rework as unmeasured rather than free", async () => {
    await post(`${base()}/rework-items`, {
      title: "Re-run conduit drops",
      causeCategory: "coordination",
      discoveryPhase: "post_handover",
      trade: "Electrical",
    });
    const summary = await get(`${base()}/rework-summary`);
    expect(summary.statusCode).toBe(200);
    expect(summary.json().total).toBe(2);
    expect(summary.json().uncostedItems).toBe(1);
    const byPhase = summary.json().byPhase as Array<{ key: string; reasons: string[] }>;
    const post_ = byPhase.find((b) => b.key === "post_handover")!;
    expect(post_.reasons.join(" ")).toContain("unmeasured — not zero");
  });

  it("splits the cost of quality into what it cost to look and what it cost to fail", async () => {
    const coq = await get(`${base()}/quality/cost-of-quality`);
    expect(coq.statusCode).toBe(200);
    const internal = (coq.json().buckets as Array<{ bucket: string; money: Array<{ currency: string; amount: number }> }>).find(
      (b) => b.bucket === "internal_failure",
    )!;
    expect(internal.money.find((m) => m.currency === "GBP")!.amount).toBe(6000);
    const prevention = (coq.json().buckets as Array<{ bucket: string; reasons: string[] }>).find(
      (b) => b.bucket === "prevention",
    )!;
    expect(prevention.reasons.join(" ")).toContain("flattering and false");
  });

  it("reports first-time right per trade, and nulls a trade with nothing judged", async () => {
    const ftr = await get(`${base()}/quality/first-time-right`);
    expect(ftr.statusCode).toBe(200);
    expect(ftr.json().overall.rate).toBeNull();
    expect(ftr.json().overall.reasons.join(" ")).toContain("unmeasured rather than perfect");
  });
});

/* ================================================================== */
/* Quality audits and ISO 9001 evidence (#1095–1096)                   */
/* ================================================================== */

describe("quality audits", () => {
  let auditId: string;
  let findingId: string;

  it("demands the requirement and the evidence behind a non-conformity", async () => {
    const created = await post(`${base()}/quality-audits`, {
      title: "Internal audit — concrete works",
      auditType: "internal",
      standard: "ISO 9001:2015",
      scope: "Reinforced concrete frame, levels 1–4",
      leadAuditorId: engineer.userId,
      plannedDate: "2030-03-01",
      responseDueDate: "2030-03-21",
    });
    expect(created.statusCode).toBe(201);
    auditId = created.json().id;

    const thin = await post(`${base()}/quality-audits/${auditId}/findings`, {
      findingType: "major_nonconformity",
      description: "Cover meter records are missing.",
    });
    expect(thin.statusCode).toBe(400);
    expect(thin.json().message).toContain("quote the requirement");

    const proper = await post(`${base()}/quality-audits/${auditId}/findings`, {
      findingType: "major_nonconformity",
      description: "Cover meter records were not retained for pours 12–18.",
      clauseReference: "8.5.1",
      requirement: "ISO 9001:2015 cl.8.5.1 c) — the availability and use of suitable monitoring resources.",
      evidence: "Six pour records reviewed; none carried a cover survey.",
      responsibleUserId: owner.userId,
      dueDate: "2030-04-01",
    });
    expect(proper.statusCode).toBe(201);
    findingId = proper.json().id;
    expect(proper.json().reference).toContain("-F01");
  });

  it("refuses a report with no findings at all", async () => {
    const empty = await post(`${base()}/quality-audits`, { title: "An audit nobody carried out" });
    const issued = await post(`${base()}/quality-audits/${empty.json().id}/status`, {
      status: "report_issued",
    });
    expect(issued.statusCode).toBe(400);
    expect(issued.json().message).toContain("nobody looked");
  });

  it("wants the root cause before an action is agreed, and segregates the verification", async () => {
    const noCause = await post(`${base()}/audit-findings/${findingId}/respond`, {
      response: "We will keep the records in future.",
      agreed: true,
    });
    expect(noCause.statusCode).toBe(400);
    expect(noCause.json().message).toContain("root cause");

    const responded = await post(`${base()}/audit-findings/${findingId}/respond`, {
      response: "Cover surveys will be attached to the pour record before sign-off.",
      rootCause: "The pour checklist did not require the survey to be attached.",
      agreed: true,
      dueDate: "2030-04-01",
    });
    expect(responded.statusCode).toBe(200);
    expect(responded.json().status).toBe("action_agreed");

    const selfVerified = await post(`${base()}/audit-findings/${findingId}/verify`, {
      verificationEvidence: "Checked ourselves.",
    });
    expect(selfVerified.statusCode).toBe(403);

    const verified = await post(
      `${base()}/audit-findings/${findingId}/verify`,
      { verificationEvidence: "Pours 19–24 all carry a cover survey." },
      engineerHeaders,
    );
    expect(verified.statusCode).toBe(200);
    expect(verified.json().status).toBe("closed");
  });

  it("raises a signal for a finding past its close-out date, once", async () => {
    const overdue = await post(`${base()}/quality-audits/${auditId}/findings`, {
      findingType: "minor_nonconformity",
      description: "Calibration certificates not filed for two instruments.",
      requirement: "ISO 9001:2015 cl.7.1.5.2 — measurement traceability.",
      evidence: "Two instruments on site with no certificate in the register.",
      dueDate: "2020-01-01",
    });
    expect(overdue.statusCode).toBe(201);
    await app.scheduler.runNow("quality.audit-findings");
    await app.scheduler.runNow("quality.audit-findings");
    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "quality_audit_finding_overdue")),
      );
    expect(raised).toHaveLength(1);
  });

  it("refuses to close an audit over open findings unless it is forced deliberately", async () => {
    const blocked = await post(`${base()}/quality-audits/${auditId}/close`, {});
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().message).toContain("stop being tracked");

    const forced = await post(`${base()}/quality-audits/${auditId}/close`, {
      force: true,
      note: "Carried forward to the next surveillance visit.",
    });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().status).toBe("closed");
  });

  it("assembles the ISO 9001 evidence pack without claiming an unevidenced clause", async () => {
    const pack = await get(`${base()}/iso9001-evidence`);
    expect(pack.statusCode).toBe(200);
    const clauses = pack.json().clauses as Array<{ clause: string; evidenced: boolean; reasons: string[] }>;
    const nonconforming = clauses.find((c) => c.clause === "8_7_nonconforming_output")!;
    expect(nonconforming.evidenced).toBe(true);
    const unevidenced = clauses.filter((c) => !c.evidenced);
    for (const clause of unevidenced) {
      expect(clause.reasons.join(" ")).toContain("unevidenced here");
    }
    expect(pack.json().reasons.join(" ")).toContain("index of evidence, not a compliance assessment");
  });
});

/* ================================================================== */
/* The registers on the module summary                                 */
/* ================================================================== */

describe("quality summary", () => {
  it("carries the Domain Z registers, and the health inputs another module scores", async () => {
    const summary = await get(`${base()}/quality/summary`);
    expect(summary.statusCode).toBe(200);
    const registers = summary.json().registers;
    expect(registers.concessions.total).toBe(2);
    expect(registers.concrete.failing).toBe(1);
    expect(registers.welding.welds).toBe(2);
    expect(registers.certificates.failed).toBe(1);
    expect(registers.calibration.unusable).toBeGreaterThanOrEqual(1);
    expect(registers.audits.majorNonConformities).toBe(1);

    const health = await get(`${base()}/quality/health-inputs`);
    expect(health.statusCode).toBe(200);
    expect(health.json().metrics.failedConcretePours).toBe(1);
    expect(health.json().metrics.rejectedWelds).toBeGreaterThanOrEqual(0);
    expect(health.json().metrics.firstTimeRightPercent).toBeNull();
    expect(health.json().reasons.join(" ")).toContain("unmeasured rather than perfect");
  });
});
