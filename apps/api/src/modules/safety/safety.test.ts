import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  obligations,
  projectMemberships,
  projects,
  safetyIncidents,
  safetyProgrammeRecords,
  signals,
  siteAccessRecords,
  timecards,
  vendors,
  workers,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";
import {
  computeReportingDelay,
  computeRiskScore,
  nextStatutoryDueDate,
  optionalRiskScore,
  riskBand,
  scoreInspection,
  type InspectionAnswer,
  type TemplateItem,
} from "./scoring.js";
import { computeSafetyRates, resolveExposureHours, type RateCounts } from "./rates.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
/** raises records */
let owner: TestActor;
/** the independent second actor: closes, verifies, approves, reviews */
let second: TestActor;
/** the independent third actor: the effectiveness checker */
let third: TestActor;
/** read-only project member — permission counterparty */
let viewer: TestActor;
let viewerHeaders: Record<string, string>;
/** a different company entirely */
let stranger: TestActor;

let ukProject: string;
let usProject: string;
let noCountryProject: string;
let permProject: string;
let statsProject: string;
let vendorId: string;
let workerId: string;
let statsWorkerId: string;

const today = () => todayISO();
const days = (n: number) => addDaysISO(todayISO(), n);

async function makeProject(name: string, country: string | null): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({
    id,
    companyId: owner.companyId,
    name,
    country,
    stage: "course_of_construction",
  });
  return id;
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);

  const join = async (role: "admin" | "member"): Promise<TestActor> => {
    const a = await registerActor(app);
    await app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: a.userId,
      role,
    });
    return {
      ...a,
      companyId: owner.companyId,
      headers: {
        authorization: a.headers["authorization"]!,
        "x-company-id": owner.companyId,
      },
    };
  };

  second = await join("admin");
  third = await join("admin");
  viewer = await join("member");
  viewerHeaders = viewer.headers;
  stranger = await registerActor(app);

  ukProject = await makeProject("Safety — GB site", "GB");
  usProject = await makeProject("Safety — US site", "US");
  noCountryProject = await makeProject("Safety — jurisdiction unknown", null);
  permProject = await makeProject("Safety — permissions", "GB");
  statsProject = await makeProject("Safety — statistics", "GB");

  await app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId: permProject,
    userId: viewer.userId,
    templateKey: "read_only",
  });

  vendorId = newId("ven");
  await app.db.insert(vendors).values({ id: vendorId, companyId: owner.companyId, name: "Groundworks Ltd" });

  workerId = newId("wkr");
  await app.db.insert(workers).values({
    id: workerId,
    companyId: owner.companyId,
    projectId: ukProject,
    reference: "W-001",
    fullName: "Aidan Doyle",
    vendorId,
    trade: "groundworker",
    createdBy: owner.userId,
  });
  statsWorkerId = newId("wkr");
  await app.db.insert(workers).values({
    id: statsWorkerId,
    companyId: owner.companyId,
    projectId: statsProject,
    reference: "W-100",
    fullName: "Marta Kowalska",
    createdBy: owner.userId,
  });
});

afterAll(async () => {
  await built.close();
});

function post(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload });
}
function get(url: string, headers = owner.headers) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers });
}
function patch(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload });
}

async function signalsWithKey(detector: string, key: string) {
  const rows = await app.db
    .select()
    .from(signals)
    .where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, detector)));
  return rows.filter((r) => (r.evidenceRefs as { key?: string } | null)?.key === key);
}

/* ================================================================== */
/* Pure functions                                                      */
/* ================================================================== */

describe("risk score (likelihood × severity)", () => {
  it("multiplies the axes and bands the product on the conventional 5×5 matrix", () => {
    expect(computeRiskScore(1, 1)).toMatchObject({ score: 1, band: "low" });
    expect(computeRiskScore(3, 3)).toMatchObject({ score: 9, band: "medium" });
    expect(computeRiskScore(5, 2)).toMatchObject({ score: 10, band: "high" });
    expect(computeRiskScore(4, 4)).toMatchObject({ score: 16, band: "critical" });
    expect(computeRiskScore(5, 5).score).toBe(25);
    expect(computeRiskScore(4, 1).label).toContain("likely × negligible (4)");
    expect(computeRiskScore(5, 5).guidance).toContain("Stop the activity");
  });

  it("bands on the documented boundaries", () => {
    expect(riskBand(4)).toBe("low");
    expect(riskBand(5)).toBe("medium");
    expect(riskBand(9)).toBe("medium");
    expect(riskBand(10)).toBe("high");
    expect(riskBand(14)).toBe("high");
    expect(riskBand(15)).toBe("critical");
  });

  it("throws on an out-of-range axis rather than clamping it into a plausible number", () => {
    expect(() => computeRiskScore(7, 3)).toThrow(RangeError);
    expect(() => computeRiskScore(0, 3)).toThrow(/1-5/);
    expect(() => computeRiskScore(2.5, 3)).toThrow(/whole number/);
  });

  it("returns null with a reason when an axis was never scored — never a zero", () => {
    const r = optionalRiskScore(null, 4);
    expect(r.score).toBeNull();
    expect(r.reasons).toEqual(["Risk likelihood was not scored."]);
    expect(optionalRiskScore(null, null).reasons).toHaveLength(2);
    expect(optionalRiskScore(3, 4).score?.score).toBe(12);
  });
});

describe("inspection scoring", () => {
  const items: TemplateItem[] = [
    { id: "i1", text: "Edge protection in place", itemType: "pass_fail", isCritical: true, required: true },
    { id: "i2", text: "Housekeeping", itemType: "pass_fail", required: true },
    { id: "i3", text: "Ladder tagged", itemType: "pass_fail_na" },
    { id: "i4", text: "Notes", itemType: "long_text" },
  ];

  it("excludes not-applicable answers from BOTH numerator and denominator", () => {
    const answers: InspectionAnswer[] = [
      { itemId: "i1", isPass: true },
      { itemId: "i2", isPass: true },
      { itemId: "i3", isPass: null },
    ];
    const s = scoreInspection(items, answers, "percentage", 80);
    expect(s.score).toBe(2);
    expect(s.maxScore).toBe(2);
    expect(s.scorePercent).toBe(100);
    expect(s.notApplicableCount).toBe(1);
    expect(s.result).toBe("pass");
  });

  it("fails the whole inspection on a critical defect whatever the arithmetic says", () => {
    const answers: InspectionAnswer[] = [
      { itemId: "i1", isPass: false, note: "no guardrail to the east edge" },
      { itemId: "i2", isPass: true },
      { itemId: "i3", isPass: true },
    ];
    const s = scoreInspection(items, answers, "percentage", 50);
    expect(s.scorePercent).toBeCloseTo(66.67, 1);
    expect(s.result).toBe("fail");
    expect(s.criticalDefectCount).toBe(1);
    expect(s.defects[0]?.itemId).toBe("i1");
  });

  it("reports null percent with a reason rather than 100% when nothing scorable was answered", () => {
    const s = scoreInspection(items, [{ itemId: "i4", response: "all fine" }], "percentage", 80);
    expect(s.scorePercent).toBeNull();
    expect(s.score).toBeNull();
    expect(s.result).toBe("not_applicable");
    expect(s.reasons.join(" ")).toContain("no denominator");
  });

  it("names unanswered required items and answers to items the template does not contain", () => {
    const s = scoreInspection(items, [{ itemId: "i1", isPass: true }, { itemId: "ghost", isPass: true }], "percentage", 80);
    expect(s.unansweredRequired).toEqual(["i2"]);
    expect(s.unknownItemIds).toEqual(["ghost"]);
  });

  it("weights items under the weighted method", () => {
    const weighted: TemplateItem[] = [
      { id: "a", text: "A", itemType: "pass_fail", weight: 3 },
      { id: "b", text: "B", itemType: "pass_fail", weight: 1 },
    ];
    const s = scoreInspection(weighted, [{ itemId: "a", isPass: true }, { itemId: "b", isPass: false }], "weighted", 70);
    expect(s.score).toBe(3);
    expect(s.maxScore).toBe(4);
    expect(s.scorePercent).toBe(75);
    expect(s.result).toBe("pass_with_observations");
  });
});

describe("statutory intervals and reporting delay", () => {
  it("adds the interval, and refuses to invent one for ad_hoc", () => {
    expect(nextStatutoryDueDate("2026-03-02", "weekly").nextDueDate).toBe("2026-03-09");
    expect(nextStatutoryDueDate("2026-01-31", "monthly").nextDueDate).toBe("2026-02-28");
    expect(nextStatutoryDueDate("2026-03-02", "six_monthly").nextDueDate).toBe("2026-09-02");
    const adhoc = nextStatutoryDueDate("2026-03-02", "ad_hoc");
    expect(adhoc.nextDueDate).toBeNull();
    expect(adhoc.reasons.join(" ")).toContain("never be swept as overdue");
  });

  it("measures the gap between the event and the report of it", () => {
    const d = computeReportingDelay("2026-03-02T09:00:00Z", "2026-03-04T09:00:00Z");
    expect(d.hours).toBe(48);
    expect(d.isLate).toBe(true);
    expect(d.note).toContain("statutory clock");
    expect(computeReportingDelay("2026-03-02T09:00:00Z", null).hours).toBeNull();
  });
});

describe("safety rates", () => {
  const counts: RateCounts = {
    recordableCases: 4,
    lostTimeCases: 2,
    dartCases: 3,
    fatalities: 0,
    daysLost: 40,
    allInjuries: 5,
    nearMisses: 30,
    underAssessment: 1,
  };

  it("returns every rate as null with reasons when exposure hours are absent", () => {
    const exposure = resolveExposureHours({
      timecardHours: null,
      timecardCount: 0,
      siteAccessHours: null,
      siteAccessCount: 0,
      from: "2026-01-01",
      to: "2026-03-31",
    });
    expect(exposure.hours).toBeNull();
    expect(exposure.source).toBeNull();
    const r = computeSafetyRates("2026-01-01", "2026-03-31", counts, exposure);
    expect(r.rates.every((x) => x.value === null)).toBe(true);
    expect(r.incomputable.sort()).toEqual(["dart", "fatality_rate", "ltifr", "severity_rate", "trir"]);
    for (const rate of r.rates) {
      expect(rate.reasons.length).toBeGreaterThan(0);
      expect(rate.reasons.join(" ")).toContain("misrepresentation");
      expect(rate.numerator).toBeGreaterThanOrEqual(0);
    }
  });

  it("computes TRIR and LTIFR on their stated bases when the hours are real", () => {
    const exposure = resolveExposureHours({
      timecardHours: 200_000,
      timecardCount: 5_000,
      siteAccessHours: null,
      siteAccessCount: 0,
      from: "2026-01-01",
      to: "2026-03-31",
    });
    expect(exposure.source).toBe("timecards");
    const r = computeSafetyRates("2026-01-01", "2026-03-31", counts, exposure);
    expect(r.rates.find((x) => x.key === "trir")?.value).toBe(4);
    expect(r.rates.find((x) => x.key === "dart")?.value).toBe(3);
    expect(r.rates.find((x) => x.key === "ltifr")?.value).toBe(10);
    expect(r.rates.find((x) => x.key === "severity_rate")?.value).toBe(200);
    expect(r.ratios.nearMissToInjury).toBe(6);
    expect(r.caveats.join(" ")).toContain("still under assessment");
  });

  it("falls back to site-access hours and discloses that the denominator is presence, not work", () => {
    const exposure = resolveExposureHours({
      timecardHours: null,
      timecardCount: 0,
      siteAccessHours: 100_000,
      siteAccessCount: 900,
      from: "2026-01-01",
      to: "2026-03-31",
    });
    expect(exposure.source).toBe("site_access");
    expect(exposure.reasons.join(" ")).toContain("not time worked");
    const r = computeSafetyRates("2026-01-01", "2026-03-31", counts, exposure);
    expect(r.rates.find((x) => x.key === "trir")?.value).toBe(8);
    expect(r.caveats.join(" ")).toContain("turnstile presence");
  });
});

/* ================================================================== */
/* Observations                                                        */
/* ================================================================== */

describe("observations", () => {
  it("auto-numbers, computes the risk score, and returns the band", async () => {
    const res = await post(`/projects/${ukProject}/safety/observations`, {
      title: "Unprotected leading edge on level 3",
      category: "working_at_height",
      severity: "high",
      observedAt: new Date().toISOString(),
      riskLikelihood: 4,
      riskSeverity: 4,
      vendorId,
      workerId,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.reference).toBe("OBS-0001");
    expect(body.riskScore).toBe(16);
    expect(body.risk.band).toBe("critical");
    expect(body.status).toBe("open");
    expect(body.workStopped).toBe(false);
  });

  it("refuses a stoppage with no account of what was done, and on a positive observation", async () => {
    const noAction = await post(`/projects/${ukProject}/safety/observations`, {
      title: "Excavation unsupported",
      observedAt: new Date().toISOString(),
      workStopped: true,
    });
    expect(noAction.statusCode).toBe(400);
    expect(noAction.json().message).toContain("immediateActionTaken");

    const positive = await post(`/projects/${ukProject}/safety/observations`, {
      title: "Excellent edge protection",
      kind: "positive",
      observedAt: new Date().toISOString(),
      workStopped: true,
      immediateActionTaken: "n/a",
    });
    expect(positive.statusCode).toBe(400);
  });

  it("makes work-stopped a first-class state: the stopper cannot lift it, and closure needs it resolved", async () => {
    const created = await post(`/projects/${ukProject}/safety/observations`, {
      title: "Excavation battered incorrectly, operative in trench",
      category: "excavation",
      severity: "critical",
      observedAt: new Date().toISOString(),
      riskLikelihood: 4,
      riskSeverity: 5,
      workStopped: true,
      immediateActionTaken: "Operative withdrawn, exclusion zone established, trench box ordered",
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect(created.json().workStoppedAndNotResumed).toBe(true);
    expect(created.json().risk.band).toBe("critical");

    const selfResume = await post(`/projects/${ukProject}/safety/observations/${id}/resume-work`, {
      controlsInPlace: "Trench box installed",
    });
    expect(selfResume.statusCode).toBe(403);
    expect(selfResume.json().message).toContain("declares it safe to resume");

    const closeWithLiveStoppage = await post(
      `/projects/${ukProject}/safety/observations/${id}/close`,
      { note: "Sorted" },
      second.headers,
    );
    expect(closeWithLiveStoppage.statusCode).toBe(400);
    expect(closeWithLiveStoppage.json().message).toContain("never been lifted");

    const resumed = await post(
      `/projects/${ukProject}/safety/observations/${id}/resume-work`,
      { controlsInPlace: "Trench box installed and inspected" },
      second.headers,
    );
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().workResumedAt).not.toBeNull();
    expect(resumed.json().workStoppedAndNotResumed).toBe(false);

    const closed = await post(
      `/projects/${ukProject}/safety/observations/${id}/close`,
      { note: "Trench box in, re-inspected, work resumed under supervision" },
      second.headers,
    );
    expect(closed.statusCode).toBe(200);
    expect(closed.json().status).toBe("closed");
    expect(closed.json().closedBy).toBe(second.userId);
  });

  it("refuses closure by the person who raised it", async () => {
    const created = await post(`/projects/${ukProject}/safety/observations`, {
      title: "Housekeeping in the stair core",
      observedAt: new Date().toISOString(),
    });
    const id = created.json().id as string;
    const res = await post(`/projects/${ukProject}/safety/observations/${id}/close`, {
      note: "Cleared it myself",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("cannot test their own");
  });

  it("refuses closure while a corrective action raised from it is still open", async () => {
    const created = await post(`/projects/${ukProject}/safety/observations`, {
      title: "Abrasive wheel guard missing",
      observedAt: new Date().toISOString(),
    });
    const obsId = created.json().id as string;
    const action = await post(`/projects/${ukProject}/safety/corrective-actions`, {
      sourceType: "observation",
      sourceId: obsId,
      title: "Fit the guard",
      hierarchyOfControl: "engineering",
      ownerName: "Site foreman",
      dueDate: days(3),
    });
    expect(action.statusCode).toBe(201);
    const res = await post(
      `/projects/${ukProject}/safety/observations/${obsId}/close`,
      { note: "Done" },
      second.headers,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("open corrective action");
  });
});

/* ================================================================== */
/* Incidents and reportability                                         */
/* ================================================================== */

describe("incidents — reportability and the obligation it creates", () => {
  it("classifies a GB fatality, stores the deadline, and binds it to the obligations register", async () => {
    const occurredAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const res = await post(`/projects/${ukProject}/safety/incidents`, {
      incidentType: "injury",
      title: "Fall from scaffold, level 4",
      description: "Operative fell approximately 8m through an unboarded gap.",
      occurredAt,
      workerId,
      injuredPersonType: "employee",
      isFatality: true,
      mechanism: "fall_from_height",
      severity: "catastrophic",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.reference).toBe("INC-0001");
    expect(body.isReportable).toBe(true);
    expect(body.riddorCategory).toBe("death");
    expect(body.reportableRegimes).toEqual(["riddor"]);
    expect(body.reportability.governingRuleId).toBe("riddor.fatality");
    expect(body.reportability.rules.find((r: { ruleId: string }) => r.ruleId === "riddor.fatality").citation)
      .toContain("reg. 6");
    // The per-regime duty carries the governing RULE's deadline; the column carries
    // the driver's rendering of the same instant. Compare instants, not spellings.
    expect(Date.parse(body.notification.dueAt as string)).toBe(
      Date.parse(body.reportDueAt as string),
    );
    expect(body.notification.duties).toHaveLength(1);
    expect(body.notification.duties[0].regime).toBe("riddor");
    expect(body.notification.duties[0].state).toBe("outstanding");
    expect(body.notification.allDischarged).toBe(false);
    expect(body.obligationId).toBeTruthy();

    const obl = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, body.obligationId as string));
    expect(obl[0]?.status).toBe("open");
    // compare instants, not spellings — the driver returns its own timestamp form
    expect(Date.parse(obl[0]!.deadline!)).toBe(Date.parse(body.reportDueAt as string));
    expect(obl[0]?.sourceClause).toContain("riddor.fatality");
    expect(obl[0]?.trigger).toContain("INC-0001");
  });

  it("records the reporting delay and calls a late internal report a finding", async () => {
    const occurredAt = new Date(Date.now() - 50 * 3_600_000).toISOString();
    const res = await post(`/projects/${ukProject}/safety/incidents`, {
      incidentType: "near_miss",
      title: "Load swung over the walkway",
      description: "Crane load tracked over an open pedestrian route.",
      occurredAt,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.reportingDelay.hours).toBeGreaterThan(48);
    expect(body.reportingDelay.isLate).toBe(true);
    expect(body.reportingDelay.note).toContain("preservation of the scene");
    expect(body.reportingDelayHours).toBeGreaterThan(48);
  });

  it("refuses a report timestamped before the event", async () => {
    const res = await post(`/projects/${ukProject}/safety/incidents`, {
      incidentType: "near_miss",
      title: "Impossible",
      description: "x",
      occurredAt: new Date().toISOString(),
      reportedAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("cannot be reported before it happens");
  });

  it("says reportability was NOT ASSESSED when the project has no jurisdiction", async () => {
    const res = await post(`/projects/${noCountryProject}/safety/incidents`, {
      incidentType: "injury",
      title: "Fractured wrist",
      description: "Slipped on a wet ramp.",
      occurredAt: new Date().toISOString(),
      injuredPersonName: "Unknown contractor",
      injuredPersonType: "subcontractor",
      injuryNature: "fracture",
      bodyPart: "wrist",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.isReportable).toBe(false);
    expect(body.reportability.needsHumanReview).toBe(true);
    expect(body.reportability.assessedRegimes).toEqual([]);
    expect(body.reportability.reasons.join(" ")).toContain("has not been assessed");
    expect(body.reportDueAt).toBeNull();
    expect(body.obligationId).toBeNull();
    expect(body.riddorCategory).toBe("under_assessment");
  });

  it("recomputes the classification when the facts move across a threshold", async () => {
    const occurredAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const created = await post(`/projects/${ukProject}/safety/incidents`, {
      incidentType: "injury",
      title: "Strained back lifting kerbs",
      description: "Manual handling injury.",
      occurredAt,
      workerId,
      injuredPersonType: "employee",
      injuryNature: "sprain_strain",
      bodyPart: "back_lower",
      isLostTime: true,
      lostTimeDays: 4,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect(created.json().isReportable).toBe(false);
    expect(created.json().riddorCategory).toBe("over_3_day_recordable");

    const updated = await patch(`/projects/${ukProject}/safety/incidents/${id}`, {
      lostTimeDays: 9,
    });
    expect(updated.statusCode).toBe(200);
    const body = updated.json();
    expect(body.isReportable).toBe(true);
    expect(body.riddorCategory).toBe("over_7_day_incapacitation");
    expect(body.reportability.governingRuleId).toBe("riddor.over_7_day");
    const rule = body.reportability.rules.find((r: { ruleId: string }) => r.ruleId === "riddor.over_7_day");
    expect(rule.deadline.withinLabel).toBe("15 days");
    expect(rule.deadline.clockStartsFrom).toBe("the accident");
    expect(body.obligationId).toBeTruthy();
  });

  it("returns the determination with its basis and needsHumanReview instead of a bare boolean", async () => {
    const created = await post(`/projects/${usProject}/safety/incidents`, {
      incidentType: "injury",
      title: "Taken to hospital after a fall",
      description: "Fell from a stepladder.",
      occurredAt: new Date().toISOString(),
      injuredPersonName: "J. Rivera",
      injuredPersonType: "employee",
      treatmentLevel: "hospitalised",
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const det = created.json().reportability;
    expect(det.needsHumanReview).toBe(true);
    expect(det.openQuestions.join(" ")).toContain("FORMAL IN-PATIENT ADMISSION");
    expect(created.json().isReportable).toBe(false);

    const answered = await post(`/projects/${usProject}/safety/incidents/${id}/reportability`, {
      reportabilityInputs: {
        hospitalAdmission: "inpatient_treatment",
        hospitalAdmittedAt: new Date().toISOString(),
        medicalTreatmentBeyondFirstAid: true,
      },
    });
    expect(answered.statusCode).toBe(200);
    expect(answered.json().isReportable).toBe(true);
    expect(answered.json().reportability.governingRuleId).toBe("osha.inpatient_hospitalization_24h");
    const rule = answered
      .json()
      .reportability.rules.find((r: { ruleId: string }) => r.ruleId === "osha.inpatient_hospitalization_24h");
    expect(rule.deadline.withinHours).toBe(24);
    expect(rule.citation).toContain("1904.39");
  });

  it("publishes the rule catalogue with citations so a duty-holder can see what is implemented", async () => {
    const res = await get(`/safety/reportability/rules`);
    expect(res.statusCode).toBe(200);
    expect(res.json().rules.length).toBeGreaterThanOrEqual(13);
    expect(res.json().note).toContain("No other regime is");
    expect(res.json().riddorSchedule2Classes.length).toBeGreaterThan(10);
  });
});

describe("the missed-notification signal", () => {
  it("fires exactly once across repeated reads, breaches the obligation, and explains the consequence", async () => {
    const occurredAt = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const created = await post(`/projects/${ukProject}/safety/incidents`, {
      incidentType: "injury",
      title: "Crush injury to the torso",
      description: "Operative crushed between a reversing dumper and a wall.",
      occurredAt,
      workerId,
      injuredPersonType: "employee",
      injuryNature: "crush",
      bodyPart: "chest",
      severity: "major",
      isLostTime: true,
      lostTimeDays: 20,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect(created.json().isReportable).toBe(true);
    const obligationId = created.json().obligationId as string;
    expect(Date.parse(created.json().reportDueAt as string)).toBeLessThan(Date.now());

    // Three separate reads — a list, a detail, and another list.
    await get(`/projects/${ukProject}/safety/incidents`);
    await get(`/projects/${ukProject}/safety/incidents/${id}`);
    await get(`/projects/${ukProject}/safety/incidents?pageSize=5`);

    // The key carries the REGIME: an incident answerable to two authorities owes two
    // duties, and one missed duty must be able to raise a finding while the other stands.
    const raised = await signalsWithKey("safety_notification_deadline_missed", `${id}:riddor`);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.severity).toBe("critical");
    expect(raised[0]?.explanation).toContain("separate from anything the investigation finds");
    expect(raised[0]?.explanation).toContain("Notify now");
    expect((raised[0]?.evidenceRefs as { citation?: string }).citation).toContain("RIDDOR");

    const obl = await app.db.select().from(obligations).where(eq(obligations.id, obligationId));
    expect(obl[0]?.status).toBe("breached");
  });

  it("raises the same single signal when a late notification is finally recorded", async () => {
    const occurredAt = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const created = await post(`/projects/${ukProject}/safety/incidents`, {
      incidentType: "dangerous_occurrence",
      title: "Mobile crane overturned",
      description: "Crane overturned while slewing with the outriggers partially extended.",
      occurredAt,
      severity: "major",
      reportabilityInputs: { dangerousOccurrenceClass: "sch2_para_1_lifting_equipment" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect(created.json().riddorCategory).toBe("dangerous_occurrence");

    const notified = await post(`/projects/${ukProject}/safety/incidents/${id}/notify-regulator`, {
      regime: "riddor",
      reference: "HSE/2026/33412",
      method: "online_form",
    });
    expect(notified.statusCode).toBe(200);
    expect(notified.json().notificationResult.late).toBe(true);
    expect(notified.json().notificationResult.obligationStatus).toBe("breached");

    // The sweep must not add a second signal for the same incident.
    await get(`/projects/${ukProject}/safety/incidents`);
    await get(`/projects/${ukProject}/safety/incidents/${id}`);
    const raised = await signalsWithKey("safety_notification_deadline_missed", `${id}:riddor`);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.title).toContain("out of time");

    const second = await post(`/projects/${ukProject}/safety/incidents/${id}/notify-regulator`, {
      regime: "riddor",
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().message).toContain("when the regulator was actually told");
  });

  it("satisfies the obligation and raises nothing when the notification is in time", async () => {
    const created = await post(`/projects/${ukProject}/safety/incidents`, {
      incidentType: "injury",
      title: "Amputation of a finger tip",
      description: "Hand caught in an unguarded bench saw.",
      occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
      workerId,
      injuredPersonType: "employee",
      injuryNature: "amputation",
      bodyPart: "finger",
      severity: "serious",
    });
    const id = created.json().id as string;
    expect(created.json().riddorCategory).toBe("specified_injury");
    const notified = await post(`/projects/${ukProject}/safety/incidents/${id}/notify-regulator`, {
      regime: "riddor",
      reference: "HSE/2026/33999",
    });
    expect(notified.statusCode).toBe(200);
    expect(notified.json().notificationResult.late).toBe(false);
    expect(notified.json().notificationResult.obligationStatus).toBe("satisfied");
    expect(
      await signalsWithKey("safety_notification_deadline_missed", `${id}:riddor`),
    ).toHaveLength(0);
  });
});

describe("investigation lifecycle and segregation of duties", () => {
  let incidentId: string;

  it("refuses to complete an investigation with no method, no factors and no findings", async () => {
    const created = await post(`/projects/${ukProject}/safety/incidents`, {
      incidentType: "near_miss",
      title: "Scaffold tie missing over the pavement",
      description: "Tie removed by a following trade without authorisation.",
      occurredAt: new Date(Date.now() - 86_400_000).toISOString(),
      severity: "serious",
    });
    incidentId = created.json().id as string;

    const started = await post(
      `/projects/${ukProject}/safety/incidents/${incidentId}/investigation`,
      { investigationLeadId: owner.userId, rootCauseMethod: "five_whys" },
    );
    expect(started.statusCode).toBe(200);
    expect(started.json().investigation.status).toBe("in_progress");
    expect(started.json().segregationNote).toContain("sign-off is refused to the investigation lead");

    const early = await post(
      `/projects/${ukProject}/safety/incidents/${incidentId}/investigation/complete`,
      {},
    );
    expect(early.statusCode).toBe(400);
    expect(early.json().message).toContain("contributing factor");
  });

  it("refuses sign-off by the investigation lead and by the reporter, and accepts a third person", async () => {
    await post(`/projects/${ukProject}/safety/incidents/${incidentId}/investigation`, {
      rootCause: "Tie removed to allow a delivery; no permit governed alteration of the scaffold.",
      contributingFactors: [
        { factor: "No scaffold alteration permit in force", category: "organisational" },
        { factor: "Handover between trades not briefed", category: "communication" },
      ],
      investigationFindings: "Scaffold alteration was uncontrolled across the trade interface.",
    });
    const done = await post(
      `/projects/${ukProject}/safety/incidents/${incidentId}/investigation/complete`,
      {},
    );
    expect(done.statusCode).toBe(200);
    expect(done.json().investigation.status).toBe("under_review");

    const byLead = await post(
      `/projects/${ukProject}/safety/incidents/${incidentId}/investigation/approve`,
      {},
    );
    expect(byLead.statusCode).toBe(403);
    expect(byLead.json().message).toContain("may not sign off their own investigation");

    const approved = await post(
      `/projects/${ukProject}/safety/incidents/${incidentId}/investigation/approve`,
      { note: "Root cause supported by the evidence." },
      second.headers,
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.json().investigation.approvedBy).toBe(second.userId);
    expect(approved.json().status).toBe("pending_closure");
  });

  it("closes only after the investigation is signed off, and never with a live statutory duty", async () => {
    const closed = await post(`/projects/${ukProject}/safety/incidents/${incidentId}/close`, {
      note: "Permit regime extended to scaffold alteration; briefed to all trades.",
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().status).toBe("closed");

    const uninvestigated = await post(`/projects/${ukProject}/safety/incidents`, {
      incidentType: "property_damage",
      title: "Reversing damage to a site cabin",
      description: "Dumper reversed into the welfare cabin.",
      occurredAt: new Date().toISOString(),
    });
    const otherId = uninvestigated.json().id as string;
    const early = await post(`/projects/${ukProject}/safety/incidents/${otherId}/close`, {
      note: "Nothing to see",
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().message).toContain("nothing was learned");
  });

  it("refuses closure of a reportable incident that has never been notified", async () => {
    const created = await post(`/projects/${ukProject}/safety/incidents`, {
      incidentType: "injury",
      title: "Fractured ankle in an excavation",
      description: "Slipped entering an excavation on an unsecured ladder.",
      occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
      workerId,
      injuredPersonType: "employee",
      injuryNature: "fracture",
      bodyPart: "ankle",
      severity: "serious",
    });
    const id = created.json().id as string;
    expect(created.json().isReportable).toBe(true);
    await post(`/projects/${ukProject}/safety/incidents/${id}/investigation`, {
      investigationLeadId: second.userId,
      rootCauseMethod: "icam",
      rootCause: "Ladder not secured and not inspected.",
      contributingFactors: [{ factor: "No ladder register on site" }],
      investigationFindings: "Access to excavations was not controlled.",
    });
    await post(`/projects/${ukProject}/safety/incidents/${id}/investigation/complete`, {});
    await post(
      `/projects/${ukProject}/safety/incidents/${id}/investigation/approve`,
      {},
      third.headers,
    );
    const res = await post(`/projects/${ukProject}/safety/incidents/${id}/close`, { note: "Done" });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("statutory");
    expect(res.json().message).toContain("undischarged");
    expect(res.json().message).toContain("riddor");
  });
});

describe("the investigation-overdue sweep", () => {
  it("raises one signal for an incident left uninvestigated past its due date", async () => {
    const created = await post(`/projects/${usProject}/safety/incidents`, {
      incidentType: "near_miss",
      title: "Dropped object from level 6",
      description: "A scaffold clip fell into a live walkway.",
      occurredAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      investigationDueDate: days(-10),
      severity: "serious",
    });
    const id = created.json().id as string;
    await get(`/projects/${usProject}/safety/incidents`);
    await get(`/projects/${usProject}/safety/incidents/${id}`);
    await get(`/projects/${usProject}/safety/incidents`);
    const raised = await signalsWithKey("safety_investigation_overdue", id);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.explanation).toContain("Evidence decays");
    expect((raised[0]?.evidenceRefs as { daysLate?: number }).daysLate).toBeGreaterThanOrEqual(10);
  });
});

/* ================================================================== */
/* Corrective actions                                                  */
/* ================================================================== */

describe("corrective actions", () => {
  let actionId: string;
  let sourceIncidentId: string;

  it("requires an owner and records the hierarchy of control", async () => {
    const inc = await post(`/projects/${ukProject}/safety/incidents`, {
      incidentType: "near_miss",
      title: "Reversing dumper near miss",
      description: "Dumper reversed towards a pedestrian route.",
      occurredAt: new Date().toISOString(),
    });
    sourceIncidentId = inc.json().id as string;

    const ownerless = await post(`/projects/${ukProject}/safety/corrective-actions`, {
      sourceType: "incident",
      sourceId: sourceIncidentId,
      title: "Do something",
      hierarchyOfControl: "administrative",
      dueDate: days(5),
    });
    expect(ownerless.statusCode).toBe(400);
    expect(ownerless.json().message).toContain("a wish");

    const weak = await post(`/projects/${ukProject}/safety/corrective-actions`, {
      sourceType: "incident",
      sourceId: sourceIncidentId,
      title: "Retrain the operatives on reversing",
      hierarchyOfControl: "administrative",
      ownerId: owner.userId,
      dueDate: days(5),
    });
    expect(weak.statusCode).toBe(201);
    expect(weak.json().controlNote).toContain("not equivalent");
    expect(weak.json().isWeakControl).toBe(true);
    expect(weak.json().sourceReference).toBe(inc.json().reference);

    const strong = await post(`/projects/${ukProject}/safety/corrective-actions`, {
      sourceType: "incident",
      sourceId: sourceIncidentId,
      title: "Physically segregate the pedestrian route with barriers",
      hierarchyOfControl: "elimination",
      actionKind: "preventive",
      ownerId: owner.userId,
      dueDate: days(5),
    });
    expect(strong.statusCode).toBe(201);
    expect(strong.json().controlNote).toBeNull();
    actionId = strong.json().id as string;
  });

  it("refuses a due-date move with no reason, and records the revision when there is one", async () => {
    const noReason = await patch(`/projects/${ukProject}/safety/corrective-actions/${actionId}`, {
      dueDate: days(20),
    });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().message).toContain("record of nothing having been late");

    const withReason = await patch(`/projects/${ukProject}/safety/corrective-actions/${actionId}`, {
      dueDate: days(20),
      revisionReason: "Barriers on a 3-week lead time; interim banksman in place.",
    });
    expect(withReason.statusCode).toBe(200);
    expect(withReason.json().revisedCount).toBe(1);
    expect(withReason.json().originalDueDate).not.toBe(withReason.json().dueDate);
  });

  it("gates verification and the effectiveness check on being a different person", async () => {
    const completed = await post(
      `/projects/${ukProject}/safety/corrective-actions/${actionId}/complete`,
      { completionNote: "Barriers installed to the full length of the route." },
    );
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe("completed");
    expect(completed.json().effectivenessOutstanding).toBe(true);

    const selfVerify = await post(
      `/projects/${ukProject}/safety/corrective-actions/${actionId}/verify`,
      { verificationMethod: "site walk" },
    );
    expect(selfVerify.statusCode).toBe(403);
    expect(selfVerify.json().message).toContain("may not verify it");

    const verified = await post(
      `/projects/${ukProject}/safety/corrective-actions/${actionId}/verify`,
      { verificationMethod: "site walk with photographs" },
      second.headers,
    );
    expect(verified.statusCode).toBe(200);
    expect(verified.json().status).toBe("verified");
    expect(verified.json().nextStep).toContain("does not confirm it WORKED");

    const selfCheck = await post(
      `/projects/${ukProject}/safety/corrective-actions/${actionId}/effectiveness-check`,
      { verdict: "effective", note: "Looks fine to me" },
    );
    expect(selfCheck.statusCode).toBe(403);
    expect(selfCheck.json().message).toContain("self-assessment");
  });

  it("refuses to close an action that has never been checked for effectiveness", async () => {
    const res = await post(
      `/projects/${ukProject}/safety/corrective-actions/${actionId}/close`,
      {},
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("it WORKED");
    expect(res.json().message).toContain("effectiveness-check");
  });

  it("reopens an action found not effective and still refuses to close it", async () => {
    const notEffective = await post(
      `/projects/${ukProject}/safety/corrective-actions/${actionId}/effectiveness-check`,
      { verdict: "not_effective", note: "Barriers moved by deliveries within a week." },
      third.headers,
    );
    expect(notEffective.statusCode).toBe(200);
    expect(notEffective.json().status).toBe("open");
    expect(notEffective.json().verdictNote).toContain("look up the hierarchy");

    const close = await post(`/projects/${ukProject}/safety/corrective-actions/${actionId}/close`, {});
    expect(close.statusCode).toBe(409);
    expect(close.json().message).toContain("still present");
  });

  it("closes once the fix has been shown to work", async () => {
    await post(`/projects/${ukProject}/safety/corrective-actions/${actionId}/complete`, {
      completionNote: "Barriers replaced with a fixed pedestrian walkway.",
    });
    await post(
      `/projects/${ukProject}/safety/corrective-actions/${actionId}/verify`,
      { verificationMethod: "site walk" },
      second.headers,
    );
    const effective = await post(
      `/projects/${ukProject}/safety/corrective-actions/${actionId}/effectiveness-check`,
      { verdict: "effective", note: "Route intact after four weeks and two deliveries." },
      third.headers,
    );
    expect(effective.statusCode).toBe(200);
    const closed = await post(
      `/projects/${ukProject}/safety/corrective-actions/${actionId}/close`,
      {},
    );
    expect(closed.statusCode).toBe(200);
    expect(closed.json().status).toBe("closed");
    expect(closed.json().canClose).toBe(true);
  });

  it("accepts a quality NCR into the same register and reports the hierarchy profile", async () => {
    const ncr = await post(`/projects/${ukProject}/safety/corrective-actions`, {
      sourceType: "ncr",
      sourceId: newId("ncr"),
      sourceReference: "NCR-0007",
      title: "Rework the non-conforming pour",
      hierarchyOfControl: "engineering",
      ownerName: "Concrete subcontractor",
      dueDate: days(10),
    });
    expect(ncr.statusCode).toBe(201);
    const list = await get(`/projects/${ukProject}/safety/corrective-actions?sourceType=ncr`);
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().hierarchyProfile.total).toBeGreaterThan(1);
    expect(list.json().hierarchyProfile.weakControlShare).toBeGreaterThan(0);
  });

  it("raises the overdue-action signal exactly once across repeated reads", async () => {
    const created = await post(`/projects/${usProject}/safety/corrective-actions`, {
      sourceType: "audit",
      sourceId: newId("aud"),
      sourceReference: "AUD-0002",
      title: "Replace the damaged edge protection",
      hierarchyOfControl: "engineering",
      priority: "high",
      ownerName: "Site manager",
      dueDate: days(-6),
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect(created.json().isOverdue).toBe(true);

    await get(`/projects/${usProject}/safety/corrective-actions`);
    await get(`/projects/${usProject}/safety/corrective-actions/${id}`);
    await get(`/projects/${usProject}/safety/corrective-actions?overdue=true`);
    const raised = await signalsWithKey("safety_corrective_action_overdue", id);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.severity).toBe("high");
    expect(raised[0]?.explanation).toContain("knowledge without action");
  });
});

/* ================================================================== */
/* Inspections                                                         */
/* ================================================================== */

describe("inspection templates and inspections", () => {
  let templateId: string;

  it("refuses a statutory template with no interval and no regulation named", async () => {
    const noFreq = await post(`/companies/current/safety/inspection-templates`, {
      reference: "SCAF-01",
      name: "Scaffold inspection",
      items: [{ text: "Ties present", itemType: "pass_fail" }],
      isStatutory: true,
      regulatoryBasis: "Work at Height Regulations 2005 reg. 12(3)",
    });
    expect(noFreq.statusCode).toBe(400);
    expect(noFreq.json().message).toContain("ever be swept as overdue");

    const noBasis = await post(`/companies/current/safety/inspection-templates`, {
      reference: "SCAF-01",
      name: "Scaffold inspection",
      items: [{ text: "Ties present", itemType: "pass_fail" }],
      isStatutory: true,
      frequency: "weekly",
    });
    expect(noBasis.statusCode).toBe(400);
    expect(noBasis.json().message).toContain("regulatoryBasis");
  });

  it("is approved only by someone other than its author, and cannot be used until it is", async () => {
    const created = await post(`/companies/current/safety/inspection-templates`, {
      reference: "SCAF-01",
      name: "Scaffold inspection (statutory, weekly)",
      inspectionType: "scaffold",
      items: [
        { id: "ties", text: "Ties present and correct", itemType: "pass_fail", isCritical: true, required: true },
        { id: "boards", text: "Boards fully decked", itemType: "pass_fail", required: true },
        { id: "guard", text: "Double guardrail and toeboard", itemType: "pass_fail", required: true },
        { id: "tag", text: "Scafftag current", itemType: "pass_fail_na" },
      ],
      scoringMethod: "percentage",
      passThreshold: 90,
      frequency: "weekly",
      isStatutory: true,
      regulatoryBasis: "Work at Height Regulations 2005 reg. 12(3)",
    });
    expect(created.statusCode).toBe(201);
    templateId = created.json().id as string;
    expect(created.json().status).toBe("draft");
    expect(created.json().criticalItemCount).toBe(1);

    const draftUse = await post(`/projects/${ukProject}/safety/inspections`, {
      templateId,
      title: "Weekly scaffold inspection — block A",
    });
    expect(draftUse.statusCode).toBe(400);
    expect(draftUse.json().message).toContain("reviewed by anyone but its author");

    const selfApprove = await post(
      `/companies/current/safety/inspection-templates/${templateId}/approve`,
      {},
    );
    expect(selfApprove.statusCode).toBe(403);
    expect(selfApprove.json().message).toContain("may not be approved by its author");

    const approved = await post(
      `/companies/current/safety/inspection-templates/${templateId}/approve`,
      {},
      second.headers,
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe("active");
  });

  it("scores an inspection, fails it on a critical defect, raises actions and sets the next due date", async () => {
    const created = await post(`/projects/${ukProject}/safety/inspections`, {
      templateId,
      title: "Weekly scaffold inspection — block A",
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect(created.json().templateVersion).toBe(1);
    expect(created.json().isStatutory).toBe(true);

    const missingRequired = await post(
      `/projects/${ukProject}/safety/inspections/${id}/complete`,
      { responses: [{ itemId: "ties", isPass: true }] },
    );
    expect(missingRequired.statusCode).toBe(400);
    expect(missingRequired.json().message).toContain("Required items");

    const completed = await post(`/projects/${ukProject}/safety/inspections/${id}/complete`, {
      responses: [
        { itemId: "ties", isPass: false, note: "Two ties removed at level 3" },
        { itemId: "boards", isPass: true },
        { itemId: "guard", isPass: true },
        { itemId: "tag", isPass: null },
      ],
      defectActionOwnerId: owner.userId,
    });
    expect(completed.statusCode).toBe(200);
    const body = completed.json();
    expect(body.result).toBe("fail");
    expect(body.scoring.scorePercent).toBeCloseTo(66.67, 1);
    expect(body.criticalDefectCount).toBe(1);
    expect(body.actionsRaised).toHaveLength(1);
    expect(body.actionsRaised[0].isCritical).toBe(true);
    expect(body.nextDue.nextDueDate).toBe(addDaysISO(todayISO(), 7));

    const selfReview = await post(`/projects/${ukProject}/safety/inspections/${id}/review`, {});
    expect(selfReview.statusCode).toBe(403);
    expect(selfReview.json().message).toContain("may not review their own inspection");

    const reviewed = await post(
      `/projects/${ukProject}/safety/inspections/${id}/review`,
      { note: "Agreed — ties reinstated and re-inspected." },
      second.headers,
    );
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().status).toBe("reviewed");
  });

  it("raises the statutory-re-inspection signal exactly once", async () => {
    const created = await post(`/projects/${usProject}/safety/inspections`, {
      templateId,
      title: "Scaffold inspection — overdue re-inspection",
    });
    const id = created.json().id as string;
    const completed = await post(`/projects/${usProject}/safety/inspections/${id}/complete`, {
      responses: [
        { itemId: "ties", isPass: true },
        { itemId: "boards", isPass: true },
        { itemId: "guard", isPass: true },
      ],
      nextDueDate: days(-4),
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().result).toBe("pass");

    await get(`/projects/${usProject}/safety/inspections`);
    await get(`/projects/${usProject}/safety/inspections/${id}`);
    await get(`/projects/${usProject}/safety/inspections?statutory=true`);
    const raised = await signalsWithKey("safety_statutory_inspection_overdue", id);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.explanation).toContain("lawfully continue in use");
  });
});

/* ================================================================== */
/* Toolbox talks                                                       */
/* ================================================================== */

describe("toolbox talks", () => {
  let talkId: string;

  it("references the workforce worker register and refuses an unknown worker", async () => {
    const created = await post(`/projects/${ukProject}/safety/toolbox-talks`, {
      title: "Excavation collapse — lessons from INC-0001",
      category: "excavation",
      talkDate: today(),
      language: "en",
      expectedAttendeeCount: 3,
    });
    expect(created.statusCode).toBe(201);
    talkId = created.json().id as string;
    expect(created.json().reference).toBe("TBT-0001");

    const ghost = await post(`/projects/${ukProject}/safety/toolbox-talks/${talkId}/attendees`, {
      attendees: [{ workerId: newId("wkr") }],
    });
    expect(ghost.statusCode).toBe(400);
    expect(ghost.json().message).toContain("worker register");
  });

  it("records attendance, the acknowledgement method and the comprehension check", async () => {
    const added = await post(`/projects/${ukProject}/safety/toolbox-talks/${talkId}/attendees`, {
      attendees: [
        { workerId, acknowledgementMethod: "biometric", comprehensionChecked: true, comprehensionNote: "Recalled the exclusion zone" },
        { name: "Delivery driver (visitor)", acknowledgementMethod: "wet_signature" },
      ],
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().attendeeCount).toBe(2);
    expect(added.json().comprehensionNote).toContain("proves attendance, not understanding");

    const dup = await post(`/projects/${ukProject}/safety/toolbox-talks/${talkId}/attendees`, {
      attendees: [{ workerId }],
    });
    expect(dup.statusCode).toBe(409);

    const detail = await get(`/projects/${ukProject}/safety/toolbox-talks/${talkId}`);
    expect(detail.json().attendees).toHaveLength(2);
    expect(detail.json().comprehensionCheckedCount).toBe(1);
    expect(detail.json().registeredWorkerCount).toBe(1);
    expect(detail.json().attendanceShortfall).toBe(1);
  });

  it("refuses verification by the presenter and answers the inverse question about a worker", async () => {
    const delivered = await post(`/projects/${ukProject}/safety/toolbox-talks/${talkId}/deliver`, {});
    expect(delivered.statusCode).toBe(200);

    const selfVerify = await post(`/projects/${ukProject}/safety/toolbox-talks/${talkId}/verify`, {});
    expect(selfVerify.statusCode).toBe(403);
    expect(selfVerify.json().message).toContain("may not verify their own talk");

    const verified = await post(
      `/projects/${ukProject}/safety/toolbox-talks/${talkId}/verify`,
      {},
      second.headers,
    );
    expect(verified.statusCode).toBe(200);
    expect(verified.json().status).toBe("verified");

    const briefings = await get(
      `/projects/${ukProject}/safety/workers/${workerId}/briefings?category=excavation`,
    );
    expect(briefings.statusCode).toBe(200);
    expect(briefings.json().count).toBe(1);
    expect(briefings.json().briefings[0].comprehensionChecked).toBe(true);
    expect(briefings.json().categoriesCovered).toEqual(["excavation"]);

    const none = await get(`/projects/${ukProject}/safety/workers/${workerId}/briefings?category=fire`);
    expect(none.json().count).toBe(0);
    expect(none.json().reasons.join(" ")).toContain("statement about the");
  });
});

/* ================================================================== */
/* Programme records                                                   */
/* ================================================================== */

describe("safety programme records", () => {
  it("insists a permit or competency card carries an expiry date", async () => {
    const res = await post(`/companies/current/safety/programme-records`, {
      recordKind: "permit_to_work",
      title: "Hot works permit — level 2 core",
      projectId: ukProject,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("invisible to the sweep");
  });

  it("refuses approval by the author of the record", async () => {
    const created = await post(`/companies/current/safety/programme-records`, {
      recordKind: "risk_assessment",
      title: "RA-014 Working at height — facade",
      projectId: ukProject,
      version: "1.0",
      effectiveFrom: days(-10),
      expiresAt: days(180),
      reviewIntervalMonths: 6,
      requiredAcknowledgementCount: 8,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect(created.json().reviewDueDate).toBeTruthy();
    expect(created.json().acknowledgementShortfall).toBe(8);

    const selfApprove = await post(
      `/companies/current/safety/programme-records/${id}/approve`,
      {},
    );
    expect(selfApprove.statusCode).toBe(403);
    expect(selfApprove.json().message).toContain("reviewed by nobody");

    const approved = await post(
      `/companies/current/safety/programme-records/${id}/approve`,
      {},
      second.headers,
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe("active");

    // A worker is not a platform user and cannot have pressed anything, so an
    // unqualified method is refused (see the acknowledgement gate).
    const weak = await post(`/companies/current/safety/programme-records/${id}/acknowledge`, {
      workerId,
      method: "on_device_signature",
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().message).toContain("carries");

    const ack = await post(`/companies/current/safety/programme-records/${id}/acknowledge`, {
      workerId,
      method: "wet_signature",
    });
    expect(ack.statusCode).toBe(201);
    expect(ack.json().acknowledgementCount).toBe(1);
    expect(ack.json().acknowledgementShortfall).toBe(7);
  });

  it("expires a permit on the sweep, flips its status, and raises one critical signal", async () => {
    const created = await post(`/companies/current/safety/programme-records`, {
      recordKind: "permit_to_work",
      title: "Confined space permit — attenuation tank",
      projectId: ukProject,
      expiresAt: days(5),
    });
    const id = created.json().id as string;
    await post(`/companies/current/safety/programme-records/${id}/approve`, {}, second.headers);
    // the permit's validity lapses
    await app.db
      .update(safetyProgrammeRecords)
      .set({ expiresAt: days(-2) })
      .where(eq(safetyProgrammeRecords.id, id));

    await get(`/companies/current/safety/programme-records`);
    await get(`/companies/current/safety/programme-records/${id}`);
    await get(`/projects/${ukProject}/safety/programme-records`);
    const raised = await signalsWithKey("safety_programme_record_expired", id);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.severity).toBe("critical");
    expect(raised[0]?.explanation).toContain("the activity it authorised is now");

    const after = await get(`/companies/current/safety/programme-records/${id}`);
    expect(after.json().status).toBe("expired");
    expect(after.json().isExpired).toBe(true);
  });

  it("supersedes a record and says the old acknowledgements do not carry forward", async () => {
    const created = await post(`/companies/current/safety/programme-records`, {
      recordKind: "method_statement",
      title: "MS-021 Facade panel installation",
      projectId: ukProject,
      version: "1.0",
    });
    const id = created.json().id as string;
    await post(`/companies/current/safety/programme-records/${id}/approve`, {}, second.headers);
    await post(`/companies/current/safety/programme-records/${id}/acknowledge`, {
      workerId,
      method: "wet_signature",
    });

    const superseded = await post(
      `/companies/current/safety/programme-records/${id}/supersede`,
      { title: "MS-021 Facade panel installation", version: "2.0", reason: "Crane position changed" },
    );
    expect(superseded.statusCode).toBe(201);
    expect(superseded.json().supersedesId).toBe(id);
    expect(superseded.json().note).toContain("do NOT carry forward");
    expect(superseded.json().acknowledgementCount).toBe(0);

    const old = await get(`/companies/current/safety/programme-records/${id}`);
    expect(old.json().status).toBe("superseded");
    expect(old.json().supersededById).toBe(superseded.json().id);
  });
});

/* ================================================================== */
/* Statistics                                                          */
/* ================================================================== */

describe("statistics", () => {
  it("returns every rate as null with reasons when the platform holds no exposure hours", async () => {
    await post(`/projects/${statsProject}/safety/incidents`, {
      incidentType: "injury",
      title: "Laceration to the forearm",
      description: "Cut on a protruding tie wire.",
      occurredAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
      injuredPersonName: "A. Smith",
      injuredPersonType: "employee",
      isLostTime: true,
      lostTimeDays: 3,
    });
    const res = await get(`/projects/${statsProject}/safety/statistics`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.exposure.hours).toBeNull();
    expect(body.exposure.source).toBeNull();
    expect(body.rates.every((r: { value: number | null }) => r.value === null)).toBe(true);
    const anyRate = body.rates.find((r: { key: string }) => r.key === "ltifr");
    expect(anyRate.reasons.join(" ")).toContain("No timecards cover");
    expect(body.honesty).toContain("misrepresentation");
    // the counts are real and are still reported
    expect(body.counts.lostTimeCases).toBe(1);
    expect(body.counts.daysLost).toBe(3);
  });

  it("computes the rates once real hours exist, and names the source of the denominator", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: newId("tc"),
      companyId: owner.companyId,
      projectId: statsProject,
      number: i + 1,
      reference: `TC-${i + 1}`,
      workerId: statsWorkerId,
      workDate: addDaysISO(todayISO(), -i - 1),
      totalHours: 500,
      status: "approved",
      createdBy: owner.userId,
    }));
    await app.db.insert(timecards).values(rows);
    await app.db.insert(siteAccessRecords).values({
      id: newId("sar"),
      companyId: owner.companyId,
      projectId: statsProject,
      workerId: statsWorkerId,
      accessDate: addDaysISO(todayISO(), -1),
      hoursOnSite: 9,
    });

    const res = await get(`/projects/${statsProject}/safety/statistics`);
    const body = res.json();
    expect(body.exposure.hours).toBe(10_000);
    expect(body.exposure.source).toBe("timecards");
    const ltifr = body.rates.find((r: { key: string }) => r.key === "ltifr");
    expect(ltifr.value).toBe(100);
    expect(ltifr.basis).toContain("1,000,000");
    // TRIR and DART are OSHA constructions. This is a GB project assessed only under
    // RIDDOR, so no incident on it carries a 29 CFR 1904 classification at all — and a
    // TRIR of 0.00 read off an unasked question is a false statement on a
    // prequalification questionnaire, not a low rate.
    const trir = body.rates.find((r: { key: string }) => r.key === "trir");
    expect(trir.basis).toContain("200,000");
    expect(trir.value).toBeNull();
    expect(trir.reasons.join(" ")).toContain("never assessed under 29 CFR 1904");
    const dart = body.rates.find((r: { key: string }) => r.key === "dart");
    expect(dart.value).toBeNull();
    expect(body.counts.unassessedForOsha).toBeGreaterThan(0);
    expect([...(body.incomputable as string[])].sort()).toEqual(["dart", "trir"]);
  });

  it("summarises the registers, the obligations and the signals this module owns", async () => {
    const res = await get(`/projects/${ukProject}/safety/summary`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.incidents.total).toBeGreaterThan(0);
    expect(body.observations.total).toBeGreaterThan(0);
    expect(body.obligations.total).toBeGreaterThan(0);
    expect(body.obligations.note).toContain("ADR 0012");
    expect(Object.keys(body.signals.byDetector).sort()).toEqual([
      "safety_corrective_action_overdue",
      "safety_device_alarm_unanswered",
      "safety_investigation_overdue",
      "safety_notification_deadline_missed",
      "safety_programme_record_expired",
      "safety_risk_index_elevated",
      "safety_statutory_inspection_overdue",
      "safety_under_reporting_suspected",
    ]);
    expect(body.correctiveActions.awaitingEffectivenessCheck).toBeGreaterThanOrEqual(0);
  });
});

/* ================================================================== */
/* Permissions and the ledger                                          */
/* ================================================================== */

describe("permissions and the evidentiary ledger", () => {
  it("lets a read-only member read but not write, and shuts another company out entirely", async () => {
    const read = await get(`/projects/${permProject}/safety/observations`, viewerHeaders);
    expect(read.statusCode).toBe(200);

    const write = await post(
      `/projects/${permProject}/safety/observations`,
      { title: "Nope", observedAt: new Date().toISOString() },
      viewerHeaders,
    );
    expect(write.statusCode).toBe(403);

    const outsider = await get(`/projects/${ukProject}/safety/incidents`, stranger.headers);
    expect(outsider.statusCode).toBe(403);
  });

  it("ledgers the incident, its reportability assessment and the obligation it created", async () => {
    const created = await post(`/projects/${ukProject}/safety/incidents`, {
      incidentType: "utility_strike",
      title: "Struck a live 11kV cable",
      description: "Excavator bucket struck an unmarked cable.",
      occurredAt: new Date().toISOString(),
      severity: "major",
      reportabilityInputs: { dangerousOccurrenceClass: "sch2_para_3_overhead_electric_lines" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const verify = await app.db
      .select()
      .from(safetyIncidents)
      .where(eq(safetyIncidents.id, id));
    expect(verify[0]?.obligationId).toBeTruthy();

    const chain = await app.inject({
      method: "GET",
      url: "/api/v1/assurance/ledger/verify",
      headers: owner.headers,
    });
    if (chain.statusCode === 200) {
      expect(chain.json().valid).toBe(true);
    }
  });
});
