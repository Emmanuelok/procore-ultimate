/**
 * Closeout and the sequential sign-off chain.
 *
 * Defects liability periods (as Obligations in the assurance register),
 * performance guarantees and their liquidated-damages exposure, operator
 * training, spares, post-occupancy evaluation — and the per-party release
 * chain on an intervention point, including third-party surveillance.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  commissioningSystems,
  commissioningTestRecords,
  companyMemberships,
  obligations,
  projects,
  signals,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;

let owner: TestActor;
let engineer: TestActor;
let client: TestActor;
let stranger: TestActor;
let engineerHeaders: Record<string, string>;
let clientHeaders: Record<string, string>;
let projectId: string;
let vendorId: string;

const api = (path: string) => `/api/v1${path}`;
const base = () => `/projects/${projectId}`;
const post = (path: string, payload: unknown, headers = owner.headers) =>
  app.inject({ method: "POST", url: api(path), payload: payload as object, headers });
const put = (path: string, payload: unknown, headers = owner.headers) =>
  app.inject({ method: "PUT", url: api(path), payload: payload as object, headers });
const get = (path: string, headers = owner.headers) =>
  app.inject({ method: "GET", url: api(path), headers });

async function join(actor: TestActor): Promise<Record<string, string>> {
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: actor.userId,
    role: "admin",
  });
  return {
    authorization: actor.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  engineer = await registerActor(app);
  client = await registerActor(app);
  stranger = await registerActor(app);
  engineerHeaders = await join(engineer);
  clientHeaders = await join(client);
  projectId = newId("prj");
  await app.db
    .insert(projects)
    .values({ id: projectId, companyId: owner.companyId, name: "Closeout" });
  vendorId = newId("ven");
  await app.db.insert(vendors).values({ id: vendorId, companyId: owner.companyId, name: "M&E Ltd" });
}, 180_000);

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* The sign-off chain (#1092–1094)                                     */
/* ================================================================== */

describe("sequential sign-off on a hold point", () => {
  let itpId: string;
  let activityId: string;
  let legs: Array<{ id: string; party: string }>;

  beforeAll(async () => {
    const itp = await post(`${base()}/itps`, { title: "Structural steel ITP" });
    itpId = itp.json().id;
    const activity = await post(`${base()}/itps/${itpId}/activities`, {
      activity: "Weld visual and NDT release",
      interventionPoint: "hold_point",
      noticePeriodHours: 48,
      plannedDate: "2030-05-01",
      verifyingParties: [{ party: "engineer", userId: engineer.userId }],
    });
    activityId = activity.json().id;
  }, 60_000);

  it("records a chain in order, and refuses to sign out of sequence", async () => {
    const chain = await put(`${base()}/itps/${itpId}/activities/${activityId}/parties`, {
      parties: [
        { party: "contractor", userId: owner.userId },
        { party: "engineer", userId: engineer.userId },
        { party: "third_party", organisation: "Notified Body Ltd", accreditation: "UKAS 0086" },
      ],
    });
    expect(chain.statusCode).toBe(200);
    legs = chain.json().items as Array<{ id: string; party: string }>;
    expect(chain.json().summary.requiredCount).toBe(3);
    expect(chain.json().summary.nextLegId).toBe(legs[0]!.id);

    const outOfSequence = await post(
      `${base()}/itps/${itpId}/activities/${activityId}/parties/${legs[1]!.id}/release`,
      {},
      engineerHeaders,
    );
    expect(outOfSequence.statusCode).toBe(400);
    expect(outOfSequence.json().message).toContain("ahead of it in the chain");
  });

  it("refuses a user who is not the nominated party", async () => {
    const wrongParty = await post(
      `${base()}/itps/${itpId}/activities/${activityId}/parties/${legs[0]!.id}/release`,
      {},
      engineerHeaders,
    );
    expect(wrongParty.statusCode).toBe(403);
    expect(wrongParty.json().message).toContain("nominated to user");
  });

  it("releases each leg in turn and releases the activity when the chain completes", async () => {
    const first = await post(
      `${base()}/itps/${itpId}/activities/${activityId}/parties/${legs[0]!.id}/release`,
      { note: "Contractor QC complete." },
    );
    expect(first.statusCode).toBe(200);
    expect(first.json().activityReleased).toBe(false);

    const second = await post(
      `${base()}/itps/${itpId}/activities/${activityId}/parties/${legs[1]!.id}/release`,
      { note: "Engineer satisfied." },
      engineerHeaders,
    );
    expect(second.statusCode).toBe(200);
    expect(second.json().activityReleased).toBe(false);

    // The third party attends before it signs — a separate fact.
    const attended = await post(
      `${base()}/itps/${itpId}/activities/${activityId}/parties/${legs[2]!.id}/attend`,
      { attendedByName: "N. Body" },
      clientHeaders,
    );
    expect(attended.statusCode).toBe(200);
    expect(attended.json().items[2].status).toBe("attended");

    const third = await post(
      `${base()}/itps/${itpId}/activities/${activityId}/parties/${legs[2]!.id}/release`,
      { releasedByName: "N. Body", reportFileId: newId("file") },
      clientHeaders,
    );
    expect(third.statusCode).toBe(200);
    expect(third.json().activityReleased).toBe(true);
    expect(third.json().summary.complete).toBe(true);

    const activity = await get(`${base()}/itps/${itpId}/activities`);
    const row = (activity.json().items as Array<{ id: string; status: string; releaseNote: string }>).find(
      (a) => a.id === activityId,
    )!;
    expect(row.status).toBe("released");
    expect(row.releaseNote).toContain("sign-off chain");
  });

  it("refuses to rewrite a chain that has been signed", async () => {
    const rewritten = await put(`${base()}/itps/${itpId}/activities/${activityId}/parties`, {
      parties: [{ party: "contractor", userId: owner.userId }],
    });
    expect(rewritten.statusCode).toBe(400);
    expect(rewritten.json().message).toContain("cannot be rewritten under a signature");
  });

  it("refuses one person standing in for two independent parties", async () => {
    const second = await post(`${base()}/itps/${itpId}/activities`, {
      activity: "Second hold point",
      interventionPoint: "hold_point",
      verifyingParties: [{ party: "engineer", userId: engineer.userId }],
    });
    const secondId = second.json().id as string;
    const chain = await put(`${base()}/itps/${itpId}/activities/${secondId}/parties`, {
      parties: [
        { party: "contractor", userId: engineer.userId },
        { party: "engineer", userId: engineer.userId },
      ],
    });
    const chainLegs = chain.json().items as Array<{ id: string }>;
    const first = await post(
      `${base()}/itps/${itpId}/activities/${secondId}/parties/${chainLegs[0]!.id}/release`,
      {},
      engineerHeaders,
    );
    expect(first.statusCode).toBe(200);
    const same = await post(
      `${base()}/itps/${itpId}/activities/${secondId}/parties/${chainLegs[1]!.id}/release`,
      {},
      engineerHeaders,
    );
    expect(same.statusCode).toBe(403);
    expect(same.json().message).toContain("two independent parties");
  });

  it("fails the activity when a party rejects, whatever the sequence says", async () => {
    const third = await post(`${base()}/itps/${itpId}/activities`, {
      activity: "Third hold point",
      interventionPoint: "hold_point",
      verifyingParties: [{ party: "engineer", userId: engineer.userId }],
    });
    const thirdId = third.json().id as string;
    const chain = await put(`${base()}/itps/${itpId}/activities/${thirdId}/parties`, {
      parties: [
        { party: "contractor", userId: owner.userId },
        { party: "engineer", userId: engineer.userId },
      ],
    });
    const chainLegs = chain.json().items as Array<{ id: string }>;
    const rejected = await post(
      `${base()}/itps/${itpId}/activities/${thirdId}/parties/${chainLegs[1]!.id}/reject`,
      { reason: "Weld profile not acceptable." },
      engineerHeaders,
    );
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().summary.rejected).toBe(true);
    const activities = await get(`${base()}/itps/${itpId}/activities`);
    const row = (activities.json().items as Array<{ id: string; status: string }>).find(
      (a) => a.id === thirdId,
    )!;
    expect(row.status).toBe("failed");
  });

  it("lists what is waiting on a third party, and refuses the register to another company", async () => {
    const register = await get(`${base()}/surveillance`);
    expect(register.statusCode).toBe(200);
    expect(register.json().total).toBeGreaterThanOrEqual(1);
    expect((await get(`${base()}/surveillance`, stranger.headers)).statusCode).toBe(403);
  });
});

/* ================================================================== */
/* Defects liability periods                                           */
/* ================================================================== */

describe("defects liability periods", () => {
  let dlpId: string;

  it("needs an end date or a duration, and opens an obligation for the one it gets", async () => {
    const noEnd = await post(`${base()}/dlps`, { name: "Open-ended", startDate: "2030-01-01" });
    expect(noEnd.statusCode).toBe(400);
    expect(noEnd.json().message).toContain("end date or a duration");

    const created = await post(`${base()}/dlps`, {
      name: "M&E installation",
      startDate: "2030-01-01",
      durationMonths: 12,
      vendorId,
      retentionAmount: 25_000,
      currency: "GBP",
      contractClause: "JCT DB 2016 cl.2.35",
    });
    expect(created.statusCode).toBe(201);
    dlpId = created.json().id;
    expect(created.json().endDate).toBe("2031-01-01");
    expect(created.json().makeGoodObligationId).not.toBeNull();

    const [obligation] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, created.json().makeGoodObligationId as string));
    expect(obligation!.deadline).toContain("2031-01-01");
    expect(obligation!.trigger).toContain("moves to the owner");
  });

  it("records defects inside and outside the period, and says which is which", async () => {
    const inside = await post(`${base()}/dlps/${dlpId}/defects`, {
      title: "AHU-02 belt slipping",
      reportedAt: "2030-06-01",
      severity: "minor",
    });
    expect(inside.statusCode).toBe(201);
    expect(inside.json().outsidePeriod).toBe(false);
    expect(inside.json().reference).toContain("-D001");

    const outside = await post(`${base()}/dlps/${dlpId}/defects`, {
      title: "Reported after the period ended",
      reportedAt: "2031-06-01",
    });
    expect(outside.json().outsidePeriod).toBe(true);

    const verifiedBySelf = await post(`${base()}/dlp-defects/${inside.json().id}/status`, {
      status: "verified",
    });
    expect(verifiedBySelf.statusCode).toBe(403);

    const verified = await post(
      `${base()}/dlp-defects/${inside.json().id}/status`,
      { status: "verified", cost: 350 },
      engineerHeaders,
    );
    expect(verified.statusCode).toBe(200);
    expect(verified.json().status).toBe("verified");
  });

  it("refuses to close the period over an open defect unless it is forced", async () => {
    const blocked = await post(`${base()}/dlps/${dlpId}/close`, {});
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().message).toContain("releases the retention");

    const forced = await post(`${base()}/dlps/${dlpId}/close`, {
      force: true,
      note: "Outstanding item carried to the warranty claim.",
      finalCertificateDate: "2031-02-01",
    });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().status).toBe("closed");
    const [obligation] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.companyId, owner.companyId));
    expect(obligation!.status).toBe("satisfied");
  });

  it("warns before a live period ends, once", async () => {
    const soon = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    await post(`${base()}/dlps`, {
      name: "Roofing",
      startDate: "2020-01-01",
      endDate: soon,
      vendorId,
    });
    await app.scheduler.runNow("quality.defects-liability");
    await app.scheduler.runNow("quality.defects-liability");
    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "quality_dlp_expiring")),
      );
    expect(raised).toHaveLength(1);
    expect(raised[0]!.explanation).toContain("retention");
  });
});

/* ================================================================== */
/* Performance guarantees                                              */
/* ================================================================== */

describe("performance guarantees", () => {
  let systemId: string;
  let guaranteeId: string;

  beforeAll(async () => {
    const system = await post(`${base()}/commissioning/systems`, {
      systemCode: "CHW-01",
      name: "Chilled water plant",
      seasonalTestDueDate: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10),
    });
    systemId = system.json().id;
  }, 60_000);

  it("needs the value it promises", async () => {
    const vague = await post(`${base()}/performance-guarantees`, {
      title: "Chiller capacity",
      parameter: "Cooling capacity",
      unit: "kW",
    });
    expect(vague.statusCode).toBe(400);
    expect(vague.json().message).toContain("intention rather than a guarantee");
  });

  it("computes the shortfall and the damages, and refuses to invent a rate", async () => {
    const unpriced = await post(`${base()}/performance-guarantees`, {
      title: "Lift interval",
      parameter: "Average interval",
      operator: "at_most",
      guaranteedValue: 30,
      unit: "s",
      systemId,
    });
    const measuredUnpriced = await post(
      `${base()}/performance-guarantees/${unpriced.json().id}/measure`,
      { measuredValue: 36 },
    );
    expect(measuredUnpriced.statusCode).toBe(200);
    expect(measuredUnpriced.json().assessment.met).toBe(false);
    expect(measuredUnpriced.json().assessment.ldAmount).toBeNull();
    expect(measuredUnpriced.json().assessment.reasons.join(" ")).toContain("unknown, not nil");

    const created = await post(`${base()}/performance-guarantees`, {
      title: "Chiller capacity",
      parameter: "Cooling capacity",
      operator: "at_least",
      guaranteedValue: 1200,
      unit: "kW",
      systemId,
      vendorId,
      ldRatePerUnit: 100,
      ldRateUnit: "per kW",
      currency: "GBP",
      contractClause: "Schedule 4 cl.6",
    });
    guaranteeId = created.json().id;
    const measured = await post(`${base()}/performance-guarantees/${guaranteeId}/measure`, {
      measuredValue: 1150,
    });
    expect(measured.statusCode).toBe(200);
    expect(measured.json().shortfall).toBe(50);
    expect(measured.json().ldAmount).toBe(5000);
    expect(measured.json().ldBasis).toContain("Damages at 100 GBP");
  });

  it("segregates the verification of a measurement", async () => {
    const self = await post(`${base()}/performance-guarantees/${guaranteeId}/verify`, {});
    expect(self.statusCode).toBe(403);
    const verified = await post(
      `${base()}/performance-guarantees/${guaranteeId}/verify`,
      {},
      engineerHeaders,
    );
    expect(verified.statusCode).toBe(200);
    expect(verified.json().verifiedBy).toBe(engineer.userId);
  });

  it("raises the deferred seasonal test as a scheduled record, once", async () => {
    await app.scheduler.runNow("quality.seasonal-commissioning");
    await app.scheduler.runNow("quality.seasonal-commissioning");
    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "quality_seasonal_test_due")),
      );
    expect(raised).toHaveLength(1);
    const tests = await app.db
      .select()
      .from(commissioningTestRecords)
      .where(
        and(
          eq(commissioningTestRecords.systemId, systemId),
          eq(commissioningTestRecords.testKind, "seasonal"),
        ),
      );
    expect(tests).toHaveLength(1);
    expect(tests[0]!.status).toBe("scheduled");
    const [system] = await app.db
      .select()
      .from(commissioningSystems)
      .where(eq(commissioningSystems.id, systemId));
    expect(system!.seasonalTestDueDate).not.toBeNull();
  });
});

/* ================================================================== */
/* Training, spares and post-occupancy evaluation                      */
/* ================================================================== */

describe("training, spares and POE", () => {
  it("will not record a training session nobody attended, and segregates its acceptance", async () => {
    const created = await post(`${base()}/training-records`, {
      title: "AHU operation and maintenance",
      trainingKind: "hands_on",
      vendorId,
      scheduledFor: "2030-02-01",
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const empty = await post(`${base()}/training-records/${id}/deliver`, { attendees: [] });
    expect(empty.statusCode).toBe(400);

    const delivered = await post(`${base()}/training-records/${id}/deliver`, {
      deliveredAt: "2030-02-01",
      durationHours: 3,
      attendees: [
        { name: "A. Operator", organisation: "FM Co", role: "Technician" },
        { name: "B. Operator", organisation: "FM Co" },
      ],
      competencyAssessed: true,
    });
    expect(delivered.statusCode).toBe(200);
    expect(delivered.json().attendeeCount).toBe(2);

    const selfAccepted = await post(`${base()}/training-records/${id}/accept`, {});
    expect(selfAccepted.statusCode).toBe(403);
    const accepted = await post(`${base()}/training-records/${id}/accept`, {}, clientHeaders);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe("accepted");
  });

  it("will not hand over a spare that has not arrived", async () => {
    const created = await post(`${base()}/spare-parts`, {
      description: "AHU filter set, 12 months",
      category: "operational_spare",
      quantityRequired: 4,
      unit: "set",
      supplierVendorId: vendorId,
    });
    const id = created.json().id as string;
    const early = await post(`${base()}/spare-parts/${id}/handover`, {});
    expect(early.statusCode).toBe(400);
    expect(early.json().message).toContain("actually been delivered");

    const partial = await post(`${base()}/spare-parts/${id}/receive`, { quantityDelivered: 2 });
    expect(partial.json().status).toBe("outstanding");
    const rest = await post(`${base()}/spare-parts/${id}/receive`, { quantityDelivered: 2 });
    expect(rest.json().status).toBe("delivered");
    const handedOver = await post(`${base()}/spare-parts/${id}/handover`, {
      note: "Signed for by FM.",
    });
    expect(handedOver.json().status).toBe("handed_over");
  });

  it("reports the energy performance gap only when it holds both numbers", async () => {
    const created = await post(`${base()}/poe`, {
      title: "Year-one energy review",
      poeKind: "energy_review",
      periodStart: "2031-01-01",
      periodEnd: "2031-12-31",
      energyDesignValue: 95,
      energyUnit: "kWh/m2/yr",
    });
    expect(created.statusCode).toBe(201);
    const listedBefore = await get(`${base()}/poe`);
    expect(listedBefore.json().items[0].energyVariance.value).toBeNull();
    expect(listedBefore.json().items[0].energyVariance.reasons.join(" ")).toContain(
      "No metered actual",
    );

    const noFindings = await post(`${base()}/poe/${created.json().id}/complete`, {
      energyActualValue: 133,
    });
    expect(noFindings.statusCode).toBe(400);

    const completed = await post(`${base()}/poe/${created.json().id}/complete`, {
      energyActualValue: 133,
      satisfactionScore: 6.4,
      surveyInviteCount: 120,
      surveyResponseCount: 48,
      findings: "Consumption 40% above design, driven by simultaneous heating and cooling on level 2.",
      recommendations: "Re-commission the level 2 VAV boxes and review the BMS deadbands.",
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().energyVariance.value).toBe(40);
    expect(completed.json().surveyResponseRate).toBe(40);
  });

  it("draws the whole closeout picture, including packages with no liability period", async () => {
    const summary = await get(`${base()}/closeout-summary`);
    expect(summary.statusCode).toBe(200);
    expect(summary.json().dlps.total).toBe(2);
    expect(summary.json().guarantees.notMet).toBe(2);
    expect(summary.json().guarantees.exposure.byCurrency[0].currency).toBe("GBP");
    expect(summary.json().guarantees.exposure.unpricedShortfalls).toHaveLength(1);
    expect(summary.json().training.accepted).toBe(1);
    expect(summary.json().spares.handedOver).toBe(1);
    expect(summary.json().poe.complete).toBe(1);
  });

  it("refuses every closeout register to another company", async () => {
    expect((await get(`${base()}/dlps`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/performance-guarantees`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/training-records`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/spare-parts`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/poe`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/closeout-summary`, stranger.headers)).statusCode).toBe(403);
  });
});
