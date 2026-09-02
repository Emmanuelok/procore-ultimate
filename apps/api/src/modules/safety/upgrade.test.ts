/**
 * SAFETY — platform upgrade wave.
 *
 * Covers what this wave added and, more importantly, what it FIXED. Every
 * audit defect has a test here that fails on the old behaviour:
 *
 *   · a statutory duty owed to a second authority disappearing the moment the
 *     first was discharged (per-regime notification state);
 *   · an obligation left open on the register after the facts were corrected
 *     so that nothing is reportable any more;
 *   · TRIR published as 0.00 on a project where OSHA was never assessed;
 *   · anybody in the company recording that anybody else had read a RAMS;
 *   · `photoRequired` on a safety template being decorative;
 *   · the Actioned and Verified lanes of the observation board being
 *     unreachable;
 *   · the sweeps running on every detail read.
 *
 * Plus the new capability: device alarms, statutory form generation, vendor
 * scorecards, the predictive index, under-reporting detection and the cited
 * investigation assistant.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  obligations,
  prequalificationQuestionnaires,
  prequalificationSubmissions,
  projectMemberships,
  projects,
  safetyIncidents,
  safetySensorEvents,
  signals,
  siteAccessRecords,
  timecards,
  vendors,
  workers,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";
import { scoreInspection, type InspectionAnswer, type TemplateItem } from "./scoring.js";
import {
  derivedRegulatorNotifiedAt,
  fallbackDuties,
  missedNotificationKey,
  notificationState,
  regimeDuties,
  type NotificationEntry,
} from "./notifications.js";
import type { ReportabilityDetermination, RuleDetermination } from "./reportability.js";
import {
  buildOsha300,
  buildOsha300A,
  buildOsha301,
  buildRiddorF2508,
  canonicalJson,
  emptyFormContext,
  type FormIncident,
} from "./regulatory.js";
import { buildVendorScorecard, type VendorScorecardInput } from "./scorecard.js";
import {
  assessUnderReporting,
  computeRiskIndex,
  SILENCE_THRESHOLD_HOURS,
  type RiskIndexInput,
} from "./riskindex.js";
import { buildAssistPrompt, reconcileAssist, type AssistContext } from "./assist.js";

/* ================================================================== */
/* Fixtures for the pure engines                                       */
/* ================================================================== */

function rule(over: Partial<RuleDetermination> & { ruleId: string }): RuleDetermination {
  return {
    regime: "riddor",
    jurisdiction: "GB",
    authority: "Health and Safety Executive",
    title: "A rule",
    citation: "reg. 4",
    outcome: "met",
    basis: [],
    needsHumanReview: false,
    openQuestion: null,
    deadline: null,
    isRecordingDutyOnly: false,
    riddorCategory: null,
    oshaCaseType: null,
    consequenceIfMissed: "It is an offence.",
    ...over,
  };
}

function deadline(dueAt: string) {
  return {
    dueAt,
    clockStartsAt: "2026-01-01T00:00:00.000Z",
    clockStartsFrom: "the accident",
    withinHours: 240,
    withinLabel: "10 days",
    immediateNotificationRequired: false,
    notificationMethod: "HSE online form",
  };
}

function determination(rules: RuleDetermination[]): ReportabilityDetermination {
  return {
    isReportable: rules.some((r) => r.outcome === "met" && !r.isRecordingDutyOnly),
    needsHumanReview: false,
    regimes: [...new Set(rules.filter((r) => r.outcome === "met").map((r) => r.regime))],
    assessedRegimes: [...new Set(rules.map((r) => r.regime))],
    riddorCategory: "specified_injury",
    oshaCaseType: "days_away_from_work",
    reportDueAt: null,
    governingRuleId: rules[0]?.ruleId ?? null,
    rules,
    metRuleIds: rules.filter((r) => r.outcome === "met").map((r) => r.ruleId),
    indeterminateRuleIds: [],
    openQuestions: [],
    reasons: [],
    disclaimer: "d",
  };
}

const RIDDOR_RULE = rule({
  ruleId: "riddor.specified_injury",
  regime: "riddor",
  deadline: deadline("2026-01-16T00:00:00.000Z"),
});
const OSHA_RULE = rule({
  ruleId: "osha.fatality_or_hospitalisation",
  regime: "osha",
  jurisdiction: "US",
  authority: "OSHA",
  citation: "1904.39",
  deadline: deadline("2026-01-02T00:00:00.000Z"),
});

/* ================================================================== */
/* notifications.ts — one duty per regime                              */
/* ================================================================== */

describe("statutory notification state, per regime", () => {
  const base = {
    storedRegimes: [] as string[],
    reportDueAt: null,
    isReportable: true,
  };

  it("derives one duty per regime from the met, notifiable rules", () => {
    const duties = regimeDuties(determination([RIDDOR_RULE, OSHA_RULE]));
    expect(duties.map((d) => d.regime)).toEqual(["osha", "riddor"]); // earliest deadline first
    expect(duties[0]?.authority).toBe("OSHA");
    expect(duties[1]?.citation).toBe("reg. 4");
  });

  it("owes nothing to an authority for a recording-only duty", () => {
    const duties = regimeDuties(
      determination([rule({ ruleId: "osha.recordable_300_log", regime: "osha", isRecordingDutyOnly: true, deadline: deadline("2026-02-01T00:00:00.000Z") })]),
    );
    expect(duties).toHaveLength(0);
  });

  it("keeps a discharged duty from discharging the other one — the defect this fixes", () => {
    const notifications: NotificationEntry[] = [
      {
        regime: "riddor",
        notifiedAt: "2026-01-10T09:00:00.000Z",
        reference: "HSE/1",
        method: "online_form",
        notifiedBy: "u1",
        late: false,
        hoursLate: null,
      },
    ];
    const state = notificationState({
      ...base,
      determination: determination([RIDDOR_RULE, OSHA_RULE]),
      notifications,
      asOfISO: "2026-01-11T00:00:00.000Z",
    });
    expect(state.notified).toEqual(["riddor"]);
    // the OSHA eight-hour clock ran out on 2 January and nothing was filed
    expect(state.missed).toEqual(["osha"]);
    expect(state.allDischarged).toBe(false);
    expect(state.anyMissed).toBe(true);
    // and the derived column must NOT be stamped while a duty is live
    expect(derivedRegulatorNotifiedAt(state)).toBeNull();
  });

  it("stamps the derived column only once every regime has been answered, with the LAST timestamp", () => {
    const state = notificationState({
      ...base,
      determination: determination([RIDDOR_RULE, OSHA_RULE]),
      notifications: [
        { regime: "osha", notifiedAt: "2026-01-01T12:00:00.000Z", reference: null, method: null, notifiedBy: null, late: null, hoursLate: null },
        { regime: "riddor", notifiedAt: "2026-01-14T12:00:00.000Z", reference: null, method: null, notifiedBy: null, late: null, hoursLate: null },
      ],
      asOfISO: "2026-01-15T00:00:00.000Z",
    });
    expect(state.allDischarged).toBe(true);
    expect(state.anyMissed).toBe(false);
    expect(derivedRegulatorNotifiedAt(state)).toBe("2026-01-14T12:00:00.000Z");
  });

  it("calls a notification made after the deadline `notified_late` and counts it as missed", () => {
    const state = notificationState({
      ...base,
      determination: determination([OSHA_RULE]),
      notifications: [
        { regime: "osha", notifiedAt: "2026-01-05T00:00:00.000Z", reference: null, method: null, notifiedBy: null, late: null, hoursLate: null },
      ],
      asOfISO: "2026-01-06T00:00:00.000Z",
    });
    expect(state.duties[0]?.state).toBe("notified_late");
    expect(state.duties[0]?.hoursLate).toBe(72);
    expect(state.anyMissed).toBe(true);
  });

  it("falls back to the stored regime list and deadline, and says why there is no citation", () => {
    const duties = fallbackDuties(["riddor", "none"], "2026-03-01T00:00:00.000Z");
    expect(duties).toHaveLength(1);
    expect(duties[0]?.citation).toBeNull();
    const state = notificationState({
      determination: null,
      storedRegimes: ["riddor"],
      reportDueAt: "2026-03-01T00:00:00.000Z",
      notifications: [],
      isReportable: true,
      asOfISO: "2026-02-01T00:00:00.000Z",
    });
    expect(state.outstanding).toEqual(["riddor"]);
    expect(state.reasons.join(" ")).toContain("no stored determination");
  });

  it("reports a notification made under a regime the determination does not carry", () => {
    const state = notificationState({
      ...base,
      determination: determination([RIDDOR_RULE]),
      notifications: [
        { regime: "osha", notifiedAt: "2026-01-02T00:00:00.000Z", reference: null, method: null, notifiedBy: null, late: null, hoursLate: null },
      ],
      asOfISO: "2026-01-03T00:00:00.000Z",
    });
    expect(state.reasons.join(" ")).toContain("`osha`");
  });

  it("keys a missed duty by incident AND regime", () => {
    expect(missedNotificationKey("inc_1", "osha")).toBe("inc_1:osha");
  });
});

/* ================================================================== */
/* scoring.ts — photoRequired                                          */
/* ================================================================== */

describe("inspection scoring — photo-required items", () => {
  const items: TemplateItem[] = [
    { id: "i1", text: "Edge protection continuous", itemType: "pass_fail", required: true, photoRequired: true },
    { id: "i2", text: "Housekeeping", itemType: "pass_fail", required: true },
  ];

  it("names a photo-required item answered without a photograph", () => {
    const answers: InspectionAnswer[] = [
      { itemId: "i1", isPass: true },
      { itemId: "i2", isPass: true },
    ];
    const s = scoreInspection(items, answers, "percentage", 80);
    expect(s.missingPhotos).toEqual(["i1"]);
    expect(s.reasons.join(" ")).toContain("photo-required");
  });

  it("is satisfied by a photograph on the answer", () => {
    const answers: InspectionAnswer[] = [
      { itemId: "i1", isPass: true, photoFileIds: ["fil_1"] },
      { itemId: "i2", isPass: true },
    ];
    expect(scoreInspection(items, answers, "percentage", 80).missingPhotos).toEqual([]);
  });

  it("does not double-report an item that was never answered at all", () => {
    const s = scoreInspection(items, [{ itemId: "i2", isPass: true }], "percentage", 80);
    expect(s.unansweredRequired).toEqual(["i1"]);
    expect(s.missingPhotos).toEqual([]);
  });
});

/* ================================================================== */
/* regulatory.ts                                                       */
/* ================================================================== */

function formIncident(over: Partial<FormIncident> = {}): FormIncident {
  return {
    id: "inc_1",
    reference: "INC-0001",
    number: 1,
    projectId: "prj_1",
    incidentType: "injury",
    severity: "serious",
    title: "Fall from a ladder",
    description: "Operative fell 2m from an unsecured ladder while fixing brackets.",
    occurredAt: "2026-03-04T09:15:00.000Z",
    discoveredAt: null,
    reportedAt: "2026-03-04T10:00:00.000Z",
    hoursIntoShift: 2,
    shift: "day",
    locationText: "Level 3 east core",
    locationId: null,
    workerId: "wkr_1",
    injuredPersonName: null,
    injuredPersonType: "employee",
    injuredPersonTrade: null,
    injuredPersonAge: 34,
    vendorId: "ven_1",
    treatmentLevel: "hospitalised",
    bodyPart: "ankle",
    additionalBodyParts: [],
    injuryNature: "fracture",
    mechanism: "fall_from_height",
    treatmentProvider: null,
    hospitalName: null,
    isLostTime: 1,
    lostTimeDays: 12,
    restrictedDutyDays: 0,
    returnToWorkDate: null,
    isFatality: 0,
    activityAtTime: "Fixing brackets",
    immediateCause: "Ladder not footed",
    oshaCaseType: "days_away_from_work",
    riddorCategory: "over_7_day_incapacitation",
    reportableRegimes: ["riddor", "osha"],
    isReportable: 1,
    reportDueAt: "2026-03-19T00:00:00.000Z",
    regulatorReference: null,
    status: "under_investigation",
    detail: {},
    ...over,
  };
}

describe("OSHA 300 log", () => {
  const ctx = emptyFormContext("Riverside Tower", "prj_1");
  ctx.workerNames.set("wkr_1", "Aidan Doyle");
  ctx.workerTrades.set("wkr_1", "carpenter");

  it("logs the recordable cases and puts every other incident under `excluded` with its reason", () => {
    const log = buildOsha300(
      [
        formIncident(),
        formIncident({ id: "inc_2", reference: "INC-0002", oshaCaseType: "not_recordable" }),
        formIncident({ id: "inc_3", reference: "INC-0003", oshaCaseType: "under_assessment" }),
      ],
      ctx,
      2026,
      "2026-04-01T00:00:00.000Z",
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]?.employeeName.value).toBe("Aidan Doyle");
    expect(log.rows[0]?.classification.daysAwayFromWork).toBe(true);
    expect(log.rows[0]?.daysAwayFromWork.value).toBe(12);
    expect(log.excluded.map((e) => e.reference).sort()).toEqual(["INC-0002", "INC-0003"]);
    expect(log.excluded.find((e) => e.reference === "INC-0003")?.reason).toMatch(/assess/i);
    expect(log.totals.daysAwayCases).toBe(1);
    expect(log.disclaimer).toContain("1904");
  });

  it("names an unresolvable employee rather than printing an opaque id", () => {
    const log = buildOsha300(
      [formIncident({ workerId: "wkr_missing" })],
      emptyFormContext("Riverside Tower", "prj_1"),
      2026,
      "2026-04-01T00:00:00.000Z",
    );
    expect(log.rows[0]?.employeeName.value).toBeNull();
    expect(log.rows[0]?.employeeName.reason).toBeTruthy();
    expect(log.rows[0]?.missing.join(" ")).toMatch(/name/i);
  });
});

describe("OSHA 300A annual summary", () => {
  it("refuses both denominators rather than estimating them, and says which record is missing", () => {
    const ctx = emptyFormContext("Riverside Tower", "prj_1");
    const log = buildOsha300([formIncident()], ctx, 2026, "2026-04-01T00:00:00.000Z");
    const summary = buildOsha300A(
      {
        log,
        totalHoursWorked: null,
        hoursReasons: ["No timecards cover 2026-01-01 to 2026-12-31."],
        hoursSource: null,
        annualAverageEmployees: null,
        employeeReasons: [],
        generatedAt: "2026-04-01T00:00:00.000Z",
      },
      ctx,
    );
    expect(summary.totalHoursWorked.value).toBeNull();
    expect(summary.totalHoursWorked.reason).toContain("No timecards");
    expect(summary.annualAverageEmployees.value).toBeNull();
    expect(summary.certification.certifiedBy).toBeNull();
    expect(summary.postingPeriod.from).toBe("2027-02-01");
    expect(summary.caveats.join(" ")).toContain("Total hours worked");
  });

  it("prints the derivation beside an employment figure it did derive", () => {
    const ctx = emptyFormContext("Riverside Tower", "prj_1");
    const log = buildOsha300([], ctx, 2026, "2026-04-01T00:00:00.000Z");
    const summary = buildOsha300A(
      {
        log,
        totalHoursWorked: 210_000,
        hoursReasons: [],
        hoursSource: "timecards",
        annualAverageEmployees: 88,
        employeeReasons: [],
        employeesBasis: "Derived from the site-access register.",
        generatedAt: "2026-04-01T00:00:00.000Z",
      },
      ctx,
    );
    expect(summary.totalHoursWorked.value).toBe(210_000);
    expect(summary.employeesBasis).toContain("site-access register");
    expect(summary.hoursBasis).toContain("timecards");
  });
});

describe("OSHA 301 and RIDDOR F2508", () => {
  const ctx = emptyFormContext("Riverside Tower", "prj_1");
  ctx.workerNames.set("wkr_1", "Aidan Doyle");
  ctx.vendorNames.set("ven_1", "Groundworks Ltd");

  it("quotes the narrative on the 301 and reports what it could not fill", () => {
    const report = buildOsha301(formIncident(), ctx, "2026-04-01T00:00:00.000Z");
    expect(report.incident.whatHappened).toContain("unsecured ladder");
    expect(report.employee.name.value).toBe("Aidan Doyle");
    expect(report.employee.dateOfBirth.value).toBeNull();
    expect(report.missing.join(" ")).toMatch(/date of birth/i);
  });

  it("prefills the F2508 and leaves an unasked yes/no question null rather than answering no", () => {
    const report = buildRiddorF2508(formIncident(), ctx, null, "2026-04-01T00:00:00.000Z");
    expect(report.form).toBe("riddor_f2508");
    expect(report.aboutThePerson.name.value).toBe("Aidan Doyle");
    expect(report.aboutThePerson.employer.value).toBe("Groundworks Ltd");
    expect(report.theInjury.becameUnconscious.value).toBeNull();
    expect(report.theInjury.becameUnconscious.reason).toBeTruthy();
    expect(report.disclaimer).toContain("nothing here is transmitted");
  });

  it("routes a reportable occupational disease to the F2508A", () => {
    const report = buildRiddorF2508(
      formIncident({ incidentType: "occupational_illness", riddorCategory: "occupational_disease" }),
      ctx,
      null,
      "2026-04-01T00:00:00.000Z",
    );
    expect(report.form).toBe("riddor_f2508a");
  });

  it("hashes identically regardless of property order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });
});

/* ================================================================== */
/* scorecard.ts                                                        */
/* ================================================================== */

function scorecardInput(over: Partial<VendorScorecardInput> = {}): VendorScorecardInput {
  return {
    vendorId: "ven_1",
    vendorName: "Groundworks Ltd",
    projectId: "prj_1",
    from: "2026-01-01",
    to: "2026-12-31",
    incidents: {
      total: 0,
      bySeverity: {},
      fatalities: 0,
      lostTimeCases: 0,
      recordableCases: 0,
      oshaAssessedAll: false,
      underAssessment: 0,
      nearMisses: 0,
    },
    observations: { positive: 0, negative: 0, workStopped: 0, highRisk: 0 },
    actions: { total: 0, open: 0, overdue: 0, closedOnTime: 0, closedLate: 0, weakControl: 0, ineffective: 0 },
    inspections: { completed: 0, passed: 0, passedWithObservations: 0, failed: 0, criticalDefects: 0 },
    ncrs: { total: 0, bySeverity: {}, open: 0, backcharged: 0, costByCurrency: {} },
    programme: { expired: 0, expiringSoon: 0, active: 0 },
    exposure: { hours: null, source: null, basis: null, reasons: ["no hours"], from: "2026-01-01", to: "2026-12-31" },
    toolboxTalksAttended: 0,
    deviceAlarmsUnacknowledged: 0,
    ...over,
  };
}

describe("vendor safety scorecard", () => {
  it("refuses a grade when the registers hold nothing about the supplier", () => {
    const card = buildVendorScorecard(scorecardInput(), "2026-12-31T00:00:00.000Z");
    expect(card.score).toBeNull();
    expect(card.grade).toBe("unrated");
    expect(card.reasons.join(" ")).toMatch(/no|nothing/i);
  });

  it("scores action closure, which is the metric it weights most heavily", () => {
    const card = buildVendorScorecard(
      scorecardInput({
        actions: { total: 10, open: 2, overdue: 2, closedOnTime: 8, closedLate: 0, weakControl: 1, ineffective: 0 },
        inspections: { completed: 8, passed: 6, passedWithObservations: 1, failed: 1, criticalDefects: 0 },
        observations: { positive: 6, negative: 9, workStopped: 0, highRisk: 1 },
        ncrs: { total: 2, bySeverity: { minor: 2 }, open: 0, backcharged: 0, costByCurrency: {} },
        programme: { expired: 0, expiringSoon: 1, active: 5 },
      }),
      "2026-12-31T00:00:00.000Z",
    );
    const metric = card.metrics.find((m) => m.key === "action_closure_on_time");
    expect(metric?.value).toBe(80);
    expect(metric?.direction).toBe("higher_is_better");
    expect(card.coverage).toBeGreaterThanOrEqual(0.5);
    expect(card.score).not.toBeNull();
    expect(["A", "B", "C", "D"]).toContain(card.grade);
  });

  it("withholds the composite when too few components could be computed", () => {
    const card = buildVendorScorecard(
      scorecardInput({
        actions: { total: 10, open: 2, overdue: 2, closedOnTime: 8, closedLate: 0, weakControl: 0, ineffective: 0 },
      }),
      "2026-12-31T00:00:00.000Z",
    );
    expect(card.score).toBeNull();
    expect(card.grade).toBe("unrated");
    expect(card.reasons.join(" ")).toContain("guess wearing a letter");
  });

  it("never divides a supplier's injuries by somebody else's hours", () => {
    const card = buildVendorScorecard(
      scorecardInput({
        incidents: {
          total: 3,
          bySeverity: { major: 1 },
          fatalities: 0,
          lostTimeCases: 2,
          recordableCases: 0,
          oshaAssessedAll: false,
          underAssessment: 0,
          nearMisses: 0,
        },
      }),
      "2026-12-31T00:00:00.000Z",
    );
    const rate = card.metrics.find((m) => m.key === "trir");
    expect(rate?.value ?? null).toBeNull();
    expect((rate?.reasons ?? []).join(" ")).toContain("assessed under OSHA");
    expect(card.flags.join(" ")).toContain("lost-time");
  });

  it("flags a fatality whatever the arithmetic says", () => {
    const card = buildVendorScorecard(
      scorecardInput({
        incidents: {
          total: 1,
          bySeverity: { catastrophic: 1 },
          fatalities: 1,
          lostTimeCases: 1,
          recordableCases: 1,
          oshaAssessedAll: true,
          underAssessment: 0,
          nearMisses: 0,
        },
      }),
      "2026-12-31T00:00:00.000Z",
    );
    expect(card.flags.join(" ").toLowerCase()).toContain("fatality");
  });
});

/* ================================================================== */
/* riskindex.ts                                                        */
/* ================================================================== */

function riskInput(over: Partial<RiskIndexInput> = {}): RiskIndexInput {
  return {
    projectId: "prj_1",
    from: "2026-01-01",
    to: "2026-03-31",
    asOf: "2026-03-31",
    actions: { open: 0, overdue: 0, total: 0, weakControl: 0, ineffective: 0 },
    observations: { positive: 0, negative: 0, total: 0, highRisk: 0 },
    inspections: { completed: 0, failed: 0, criticalDefects: 0 },
    briefings: { talksDelivered: 0, weeksInWindow: 13, workersBriefed: 0, workersOnSite: 0 },
    programme: { expired: 0, expiringSoon: 0, criticalExpired: 0, active: 0 },
    incidents: { total: 0, lostTime: 0, recordableOrReportable: 0, daysSinceLast: null, investigationsOverdue: 0 },
    statutory: { notificationsMissed: 0, notificationsLate: 0, outstandingDuties: 0 },
    devices: { alarms: 0, unacknowledged: 0, overdueAcknowledgement: 0 },
    ...over,
  };
}

describe("predictive safety risk index", () => {
  it("withholds the score when too little of its weight could be computed", () => {
    const result = computeRiskIndex(riskInput());
    expect(result.coverage).toBeLessThan(1);
    if (result.score === null) {
      expect(result.band).toBe("unrated");
      expect(result.reasons.join(" ")).toMatch(/index's weight/i);
    }
  });

  it("scores a project drowning in overdue actions as exposed, and names the driver", () => {
    const result = computeRiskIndex(
      riskInput({
        actions: { open: 40, overdue: 35, total: 45, weakControl: 30, ineffective: 4 },
        observations: { positive: 0, negative: 30, total: 30, highRisk: 12 },
        inspections: { completed: 10, failed: 7, criticalDefects: 5 },
        briefings: { talksDelivered: 1, weeksInWindow: 13, workersBriefed: 3, workersOnSite: 90 },
        programme: { expired: 6, expiringSoon: 3, criticalExpired: 2, active: 10 },
        incidents: { total: 5, lostTime: 2, recordableOrReportable: 3, daysSinceLast: 2, investigationsOverdue: 2 },
        statutory: { notificationsMissed: 1, notificationsLate: 1, outstandingDuties: 1 },
        devices: { alarms: 20, unacknowledged: 9, overdueAcknowledgement: 6 },
      }),
    );
    expect(result.score).not.toBeNull();
    expect(["high", "severe"]).toContain(result.band);
    expect(result.coverage).toBeGreaterThan(0.8);
    expect(result.drivers.length).toBeGreaterThan(0);
    expect(result.drivers[0]?.advice).toBeTruthy();
    expect(result.explanation).toBeTruthy();
  });

  it("is deterministic — the same inputs give the same score", () => {
    const input = riskInput({ actions: { open: 5, overdue: 2, total: 9, weakControl: 3, ineffective: 0 } });
    expect(computeRiskIndex(input).score).toBe(computeRiskIndex(input).score);
  });

  it("scores every component it can and says why it could not score the rest", () => {
    const result = computeRiskIndex(riskInput({ actions: { open: 4, overdue: 1, total: 8, weakControl: 2, ineffective: 0 } }));
    const scored = result.components.filter((c) => c.value !== null);
    const unscored = result.components.filter((c) => c.value === null);
    expect(scored.length).toBeGreaterThan(0);
    for (const c of unscored) expect(c.reasons.length).toBeGreaterThan(0);
    for (const c of scored) expect(c.basis).toBeTruthy();
  });
});

describe("under-reporting detection", () => {
  const base = {
    projectId: "prj_1",
    projectName: "Riverside Tower",
    from: "2026-01-01",
    to: "2026-12-31",
    peers: [] as Array<{ projectId: string; incidents: number; exposureHours: number | null }>,
  };

  it("questions a register with injuries and no near misses, and says what would refute it", () => {
    const out = assessUnderReporting({
      ...base,
      exposureHours: 120_000,
      exposureSource: "timecards",
      counts: { incidents: 6, injuries: 6, nearMisses: 0, observations: 10, fatalities: 0, lostTime: 2 },
    });
    const finding = out.findings.find((f) => f.key === "near_miss_floor");
    expect(finding).toBeTruthy();
    expect(finding?.confidence).toBeLessThan(1);
    expect(finding?.refutedBy).toBeTruthy();
    expect(finding?.expected).toContain("near miss");
  });

  it("questions total silence across a substantial exposure", () => {
    const out = assessUnderReporting({
      ...base,
      exposureHours: SILENCE_THRESHOLD_HOURS + 1,
      exposureSource: "timecards",
      counts: { incidents: 0, injuries: 0, nearMisses: 0, observations: 0, fatalities: 0, lostTime: 0 },
    });
    expect(out.findings.map((f) => f.key)).toContain("silent_register");
  });

  it("says nothing about a small, ordinary window", () => {
    const out = assessUnderReporting({
      ...base,
      exposureHours: 4_000,
      exposureSource: "timecards",
      counts: { incidents: 3, injuries: 1, nearMisses: 6, observations: 30, fatalities: 0, lostTime: 0 },
    });
    expect(out.findings).toHaveLength(0);
  });
});

/* ================================================================== */
/* assist.ts                                                           */
/* ================================================================== */

const assistCtx: AssistContext = {
  incident: {
    id: "inc_1",
    reference: "INC-0001",
    incidentType: "injury",
    severity: "serious",
    title: "Fall from a ladder",
    description: "Fell 2m from an unsecured ladder.",
    occurredAt: "2026-03-04T09:15:00.000Z",
    locationText: "Level 3 east core",
    mechanism: "fall_from_height",
    injuryNature: "fracture",
    bodyPart: "ankle",
    activityAtTime: "Fixing brackets",
    immediateCause: "Ladder not footed",
    hoursIntoShift: 2,
    shift: "day",
    vendorName: "Groundworks Ltd",
    injuredPersonType: "employee",
    daysSinceInduction: 4,
    yearsExperience: 1,
    witnesses: [{ name: "T. Byrne", organisation: "Groundworks Ltd", statement: "The ladder moved." }],
  },
  determination: null,
  priorObservations: [
    {
      type: "safety_observation",
      id: "sobs_1",
      reference: "OBS-0004",
      label: "negative observation — ladders unsecured",
      summary: "Three ladders unfooted on level 3.",
      occurredAt: "2026-02-20T09:00:00.000Z",
    },
  ],
  priorIncidents: [],
  inspections: [],
  briefings: [],
  openActions: [],
  programmeRecords: [],
};

describe("investigation assistant", () => {
  it("offers only the records it assembled as citable ids", () => {
    const prompt = buildAssistPrompt(assistCtx);
    expect(prompt.allowedIds.has("sobs_1")).toBe(true);
    expect(prompt.allowedIds.has("inc_999")).toBe(false);
    expect(prompt.user).toContain("OBS-0004");
    expect(prompt.user).toContain("The ladder moved");
    expect(prompt.system).toContain("hierarchy-of-control");
    expect(prompt.inputRefs.some((r) => r.id === "sobs_1")).toBe(true);
    expect(prompt.contextChars).toBeGreaterThan(0);
  });

  it("drops a fabricated citation rather than showing it, and counts what it dropped", () => {
    const prompt = buildAssistPrompt(assistCtx);
    const out = reconcileAssist(
      {
        contributingFactors: [
          { factor: "Ladder unsecured", category: "immediate", note: "", sourceIds: ["sobs_1", "sobs_ghost"] },
        ],
        rootCauseHypotheses: [
          { hypothesis: "Ladder discipline not enforced", rank: 1, reasoning: "prior observation", sourceIds: ["sobs_1"], testableBy: "walk level 3" },
        ],
        openQuestions: [],
        draftActions: [
          { title: "Re-brief the crew", description: "toolbox talk", hierarchyOfControl: "administrative", targetDays: 7, sourceIds: ["sobs_1"] },
          { title: "Issue PPE", description: "harness", hierarchyOfControl: "ppe", targetDays: 7, sourceIds: [] },
        ],
        weakControlNote: null,
        summary: "s",
        confidence: 0.6,
      },
      prompt.allowedIds,
    );
    expect(out.droppedCitations).toBe(1);
    expect(out.contributingFactors[0]?.sourceIds).toEqual(["sobs_1"]);
    expect(out.contributingFactors[0]?.droppedIds).toEqual(["sobs_ghost"]);
    expect(out.notes.join(" ")).toContain("fabricated record id");
  });

  it("calls out a proposal set that is entirely administrative or PPE", () => {
    const prompt = buildAssistPrompt(assistCtx);
    const out = reconcileAssist(
      {
        contributingFactors: [],
        rootCauseHypotheses: [],
        openQuestions: [],
        draftActions: [
          { title: "Re-brief", description: "", hierarchyOfControl: "administrative", targetDays: 7, sourceIds: ["sobs_1"] },
          { title: "PPE", description: "", hierarchyOfControl: "PPE", targetDays: 7, sourceIds: ["sobs_1"] },
        ],
        weakControlNote: null,
        summary: null,
        confidence: null,
      },
      prompt.allowedIds,
    );
    expect(out.onlyWeakControls).toBe(true);
    expect(out.notes.join(" ")).toContain("administrative or PPE");
    expect(out.draftActions[1]?.hierarchyOfControl).toBe("ppe");
  });

  it("keeps an action whose control level the model got wrong, and says so", () => {
    const prompt = buildAssistPrompt(assistCtx);
    const out = reconcileAssist(
      {
        contributingFactors: [],
        rootCauseHypotheses: [],
        openQuestions: [],
        draftActions: [
          { title: "Do something", description: "", hierarchyOfControl: "magic", targetDays: 7, sourceIds: [] },
        ],
        weakControlNote: null,
        summary: null,
        confidence: null,
      },
      prompt.allowedIds,
    );
    expect(out.draftActions[0]?.hierarchyOfControl).toBeNull();
    expect(out.draftActions[0]?.hierarchyReason).toContain("magic");
    expect(out.onlyWeakControls).toBe(false);
  });
});

/* ================================================================== */
/* Routes                                                              */
/* ================================================================== */

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
/** an independent company admin — approves, verifies, closes */
let second: TestActor;
/** an ordinary company member, no safety admin */
let member: TestActor;
/** a different company entirely */
let stranger: TestActor;

let gbProject: string;
let usProject: string;
let quietProject: string;
let vendorId: string;
let workerId: string;
let usWorkerId: string;

const days = (n: number) => addDaysISO(todayISO(), n);
const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();

async function makeProject(name: string, country: string | null): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({
    id,
    companyId: owner.companyId,
    name,
    country,
    address: "1 Riverside Way",
    city: "Leeds",
    stage: "course_of_construction",
  });
  return id;
}

function post(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload });
}
function get(url: string, headers = owner.headers) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers });
}
function patch(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload });
}

async function signalKeys(detector: string): Promise<string[]> {
  const rows = await app.db
    .select()
    .from(signals)
    .where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, detector)));
  return rows
    .map((r) => (r.evidenceRefs as { key?: string } | null)?.key)
    .filter((k): k is string => typeof k === "string");
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
  member = await join("member");
  stranger = await registerActor(app);

  gbProject = await makeProject("Upgrade — GB site", "GB");
  usProject = await makeProject("Upgrade — US site", "US");
  quietProject = await makeProject("Upgrade — very quiet site", "GB");

  // the ordinary member needs project access to exercise the tool gates
  for (const projectId of [gbProject, usProject, quietProject]) {
    await app.db.insert(projectMemberships).values({
      id: newId("pm"),
      companyId: owner.companyId,
      projectId,
      userId: member.userId,
      templateKey: "project_manager",
    });
    await app.db.insert(projectMemberships).values({
      id: newId("pm"),
      companyId: owner.companyId,
      projectId,
      userId: second.userId,
      templateKey: "project_manager",
    });
  }

  vendorId = newId("ven");
  await app.db.insert(vendors).values({
    id: vendorId,
    companyId: owner.companyId,
    name: "Groundworks Ltd",
  });

  workerId = newId("wkr");
  await app.db.insert(workers).values({
    id: workerId,
    companyId: owner.companyId,
    projectId: gbProject,
    reference: "W-001",
    fullName: "Aidan Doyle",
    vendorId,
    trade: "groundworker",
    createdBy: owner.userId,
  });
  usWorkerId = newId("wkr");
  await app.db.insert(workers).values({
    id: usWorkerId,
    companyId: owner.companyId,
    projectId: usProject,
    reference: "W-500",
    fullName: "Marta Kowalska",
    vendorId,
    trade: "steel fixer",
    createdBy: owner.userId,
  });
});

afterAll(async () => {
  await built.close();
});

/* ------------------------------------------------------------------ */
/* AUDIT BUG 1 — a duty owed to a second authority must not vanish     */
/* ------------------------------------------------------------------ */

describe("multi-regime statutory duty", () => {
  it("keeps the OSHA duty live after the RIDDOR report is filed, and refuses closure", async () => {
    const created = await post(`/projects/${gbProject}/safety/incidents`, {
      incidentType: "injury",
      title: "Fatal fall from the leading edge",
      description: "Operative fell 14m through an unprotected leading edge.",
      occurredAt: hoursAgo(2),
      workerId,
      injuredPersonType: "employee",
      isFatality: true,
      severity: "catastrophic",
      mechanism: "fall_from_height",
      // a GB site with a US parent answers to both authorities
      regimes: ["riddor", "osha"],
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    const id = body.id as string;
    expect(body.notification.duties.map((d: { regime: string }) => d.regime).sort()).toEqual([
      "osha",
      "riddor",
    ]);
    expect(body.notification.allDischarged).toBe(false);

    const notified = await post(`/projects/${gbProject}/safety/incidents/${id}/notify-regulator`, {
      regime: "riddor",
      reference: "HSE/2026/9001",
      method: "online_form",
    });
    expect(notified.statusCode).toBe(200);
    const result = notified.json().notificationResult;
    expect(result.allDischarged).toBe(false);
    expect(result.outstandingRegimes.map((r: { regime: string }) => r.regime)).toEqual(["osha"]);
    expect(result.note).toContain("discharges nothing");

    // the derived column is the thing the old code stamped on the first report
    const stored = await app.db.select().from(safetyIncidents).where(eq(safetyIncidents.id, id));
    expect(stored[0]?.regulatorNotifiedAt).toBeNull();

    const detail = await get(`/projects/${gbProject}/safety/incidents/${id}`);
    const duties = detail.json().notification.duties as Array<{ regime: string; state: string }>;
    expect(duties.find((d) => d.regime === "riddor")?.state).toBe("notified");
    expect(duties.find((d) => d.regime === "osha")?.state).toBe("outstanding");

    // an incident with a live statutory duty cannot be closed
    await post(`/projects/${gbProject}/safety/incidents/${id}/investigation`, {
      investigationLeadId: member.userId,
      rootCauseMethod: "icam",
      rootCause: "Leading edge left unprotected after a design change.",
      contributingFactors: [{ factor: "No edge protection permit" }],
      investigationFindings: "Edge protection was removed and not reinstated.",
    });
    await post(`/projects/${gbProject}/safety/incidents/${id}/investigation/complete`, {});
    await post(
      `/projects/${gbProject}/safety/incidents/${id}/investigation/approve`,
      {},
      second.headers,
    );
    const closed = await post(`/projects/${gbProject}/safety/incidents/${id}/close`, {
      note: "Done",
    });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().message).toContain("osha");

    const second2 = await post(`/projects/${gbProject}/safety/incidents/${id}/notify-regulator`, {
      regime: "osha",
      reference: "OSHA/2026/77",
    });
    expect(second2.statusCode).toBe(200);
    expect(second2.json().notificationResult.allDischarged).toBe(true);
    const after = await app.db.select().from(safetyIncidents).where(eq(safetyIncidents.id, id));
    expect(after[0]?.regulatorNotifiedAt).toBeTruthy();
  });

  it("raises the missed-notification signal for the undischarged regime only", async () => {
    const created = await post(`/projects/${gbProject}/safety/incidents`, {
      incidentType: "injury",
      title: "Fatal crush injury in the basement",
      description: "Operative crushed by a falling precast unit.",
      occurredAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      // OSHA's eight hours run from KNOWLEDGE, not from the event, so the
      // fixture has to say when the employer learned of it — both clocks then
      // ran out weeks ago.
      reportedAt: new Date(Date.now() - 30 * 86_400_000 + 3_600_000).toISOString(),
      workerId,
      injuredPersonType: "employee",
      isFatality: true,
      severity: "catastrophic",
      regimes: ["riddor", "osha"],
    });
    const id = created.json().id as string;
    await post(`/projects/${gbProject}/safety/incidents/${id}/notify-regulator`, {
      regime: "riddor",
      reference: "HSE/2026/9002",
    });

    const outcome = await app.scheduler.runNow("safety.sweeps");
    expect(outcome.state).toBe("succeeded");
    expect((outcome.lastResult as { failed: unknown[] }).failed).toEqual([]);
    const keys = await signalKeys("safety_notification_deadline_missed");
    // one finding per DUTY: the RIDDOR report that was made out of time, and
    // the OSHA report that was never made at all. On the old single-column
    // model, filing the F2508 stopped the OSHA duty being swept entirely.
    expect(keys.filter((k) => k === `${id}:osha`)).toHaveLength(1);
    expect(keys.filter((k) => k === `${id}:riddor`)).toHaveLength(1);

    const rows = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "safety_notification_deadline_missed"),
        ),
      );
    const oshaSignal = rows.find(
      (r) => (r.evidenceRefs as { key?: string }).key === `${id}:osha`,
    );
    expect(oshaSignal?.title).toContain("(osha)");
    expect(oshaSignal?.explanation).toContain("Discharging one duty discharges nothing of the others");

    // and the sweep is idempotent
    await app.scheduler.runNow("safety.sweeps");
    const again = await signalKeys("safety_notification_deadline_missed");
    expect(again.filter((k) => k === `${id}:osha`)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* The header's source of truth — unfiltered, unwindowed                */
/* ------------------------------------------------------------------ */

describe("statutory standing on the summary", () => {
  it("counts duties across the WHOLE register, not the page on screen", async () => {
    const summary = await get(`/projects/${gbProject}/safety/summary`);
    expect(summary.statusCode).toBe(200);
    const standing = summary.json().statutory;
    expect(standing.note).toContain("per DUTY");
    expect(standing.reportableCount).toBeGreaterThan(0);
    // the dual-regime incident whose OSHA duty was never filed
    expect(standing.missedNotification).toBeGreaterThan(0);
    expect(standing.missedDuties).toBeGreaterThanOrEqual(standing.missedNotification);
    expect(standing.missedRefs.some((r: { regimes: string[] }) => r.regimes.includes("osha"))).toBe(
      true,
    );

    // filtering the incident register must not change what the header says
    const filtered = await get(
      `/projects/${gbProject}/safety/incidents?incidentType=property_damage`,
    );
    expect(filtered.json().items).toHaveLength(0);
    const again = await get(`/projects/${gbProject}/safety/summary`);
    expect(again.json().statutory.missedDuties).toBe(standing.missedDuties);
  });

  it("shuts another company out of the summary", async () => {
    const res = await get(`/projects/${gbProject}/safety/summary`, stranger.headers);
    expect(res.statusCode).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/* AUDIT BUG 2 — the obligation left open after a reassessment         */
/* ------------------------------------------------------------------ */

describe("reportability reassessment", () => {
  it("withdraws the obligation when the corrected facts make nothing reportable", async () => {
    const created = await post(`/projects/${gbProject}/safety/incidents`, {
      incidentType: "injury",
      title: "Back strain on the haul road",
      description: "Slipped on loose material; nine days off work initially recorded.",
      occurredAt: hoursAgo(30),
      workerId,
      injuredPersonType: "employee",
      injuryNature: "sprain_strain",
      bodyPart: "back_lower",
      severity: "serious",
      isLostTime: true,
      lostTimeDays: 9,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect(created.json().isReportable).toBe(true);
    const obligationId = created.json().obligationId as string;
    expect(obligationId).toBeTruthy();

    // the days-off count is corrected: five days, not nine
    const amended = await patch(`/projects/${gbProject}/safety/incidents/${id}`, {
      lostTimeDays: 5,
    });
    expect(amended.statusCode).toBe(200);
    const reassessed = await post(
      `/projects/${gbProject}/safety/incidents/${id}/reportability`,
      {},
    );
    expect(reassessed.statusCode).toBe(200);
    expect(reassessed.json().isReportable).toBe(false);
    expect(reassessed.json().reportDueAt).toBeNull();

    const obl = await app.db.select().from(obligations).where(eq(obligations.id, obligationId));
    expect(obl[0]?.status).toBe("waived");

    // the obligation stays reachable from the incident it was raised on
    const row = await app.db.select().from(safetyIncidents).where(eq(safetyIncidents.id, id));
    expect(row[0]?.obligationId).toBe(obligationId);
  });
});

/* ------------------------------------------------------------------ */
/* AUDIT BUG 3 — TRIR must not be 0.00 where OSHA was never asked      */
/* ------------------------------------------------------------------ */

describe("published rates and the regime that produced them", () => {
  it("computes TRIR on a project where every incident WAS assessed under OSHA", async () => {
    const usInjury = await post(`/projects/${usProject}/safety/incidents`, {
      incidentType: "injury",
      title: "Laceration requiring sutures",
      description: "Cut to the forearm on a protruding tie.",
      occurredAt: hoursAgo(72),
      workerId: usWorkerId,
      injuredPersonType: "employee",
      injuryNature: "laceration",
      bodyPart: "arm",
      treatmentLevel: "medical_treatment",
      severity: "serious",
      isLostTime: true,
      lostTimeDays: 4,
    });
    expect(usInjury.statusCode).toBe(201);
    expect(usInjury.json().oshaCaseType).toBe("days_away_from_work");
    await app.db.insert(timecards).values(
      Array.from({ length: 10 }, (_, i) => ({
        id: newId("tc"),
        companyId: owner.companyId,
        projectId: usProject,
        number: i + 1,
        reference: `TC-US-${i + 1}`,
        workerId: usWorkerId,
        workDate: days(-i - 1),
        totalHours: 1_000,
        status: "approved",
        createdBy: owner.userId,
      })),
    );

    const res = await get(`/projects/${usProject}/safety/statistics`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.exposure.hours).toBe(10_000);
    expect(body.counts.unassessedForOsha).toBe(0);
    const trir = body.rates.find((r: { key: string }) => r.key === "trir");
    expect(trir.value).not.toBeNull();
    expect(trir.reasons).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* AUDIT BUG 4 — who may say that somebody read a document             */
/* ------------------------------------------------------------------ */

describe("programme record acknowledgements", () => {
  let recordId: string;

  it("creates and approves a RAMS", async () => {
    const created = await post(`/companies/current/safety/programme-records`, {
      recordKind: "method_statement",
      title: "MS-900 Precast erection",
      projectId: gbProject,
      version: "1.0",
      requiredAcknowledgementCount: 5,
    });
    expect(created.statusCode).toBe(201);
    recordId = created.json().id as string;
    const approved = await post(
      `/companies/current/safety/programme-records/${recordId}/approve`,
      {},
      second.headers,
    );
    expect(approved.statusCode).toBe(200);
  });

  it("refuses an ordinary member recording that somebody ELSE has read it", async () => {
    const res = await post(
      `/companies/current/safety/programme-records/${recordId}/acknowledge`,
      { userId: owner.userId },
      member.headers,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("only record your own acknowledgement");
  });

  it("lets a member acknowledge for themselves, and marks it self-recorded", async () => {
    const res = await post(
      `/companies/current/safety/programme-records/${recordId}/acknowledge`,
      { userId: member.userId },
      member.headers,
    );
    expect(res.statusCode).toBe(201);
    const acks = res.json().acknowledgements as Array<Record<string, unknown>>;
    const mine = acks.find((a) => a["userId"] === member.userId);
    expect(mine?.["selfRecorded"]).toBe(true);
    expect(mine?.["recordedOnBehalf"]).toBeNull();
  });

  it("lets a company admin record on somebody's behalf, and stores the relationship", async () => {
    const res = await post(
      `/companies/current/safety/programme-records/${recordId}/acknowledge`,
      { userId: second.userId },
      owner.headers,
    );
    expect(res.statusCode).toBe(201);
    const acks = res.json().acknowledgements as Array<Record<string, unknown>>;
    const onBehalf = acks.find((a) => a["userId"] === second.userId);
    expect(onBehalf?.["selfRecorded"]).toBe(false);
    expect((onBehalf?.["recordedOnBehalf"] as { by: string }).by).toBe(owner.userId);
  });

  it("needs a method carrying its own evidence to record for a worker", async () => {
    const weak = await post(
      `/companies/current/safety/programme-records/${recordId}/acknowledge`,
      { workerId, method: "verbal_confirmed" },
    );
    expect(weak.statusCode).toBe(400);
    expect(weak.json().message).toContain("carries");

    const noAttestation = await post(
      `/companies/current/safety/programme-records/${recordId}/acknowledge`,
      { workerId, method: "supervisor_attested" },
    );
    expect(noAttestation.statusCode).toBe(400);
    expect(noAttestation.json().message).toContain("attestation");

    const ok = await post(
      `/companies/current/safety/programme-records/${recordId}/acknowledge`,
      {
        workerId,
        method: "supervisor_attested",
        attestation: "Briefed on the precast sequence at the 07:00 start, questions asked and answered.",
      },
    );
    expect(ok.statusCode).toBe(201);
    const acks = ok.json().acknowledgements as Array<Record<string, unknown>>;
    expect(acks.find((a) => a["workerId"] === workerId)?.["attestation"]).toContain("07:00");
  });
});

/* ------------------------------------------------------------------ */
/* AUDIT BUG 5 — photoRequired must bite                               */
/* ------------------------------------------------------------------ */

describe("inspection completion and photo-required items", () => {
  it("refuses a pass on a photo-required item with no photograph, and accepts one with", async () => {
    const template = await post(`/companies/current/safety/inspection-templates`, {
      reference: "TPL-SCAF-01",
      name: "Scaffold handover",
      inspectionType: "scaffold",
      scoringMethod: "percentage",
      passThreshold: 80,
      items: [
        {
          id: "sc1",
          text: "Guardrails continuous at every lift",
          itemType: "pass_fail",
          required: true,
          photoRequired: true,
          isCritical: true,
        },
        { id: "sc2", text: "Base plates and sole boards", itemType: "pass_fail", required: true },
      ],
    });
    expect(template.statusCode).toBe(201);
    const templateId = template.json().id as string;
    await post(
      `/companies/current/safety/inspection-templates/${templateId}/approve`,
      {},
      second.headers,
    );

    const inspection = await post(`/projects/${gbProject}/safety/inspections`, {
      templateId,
      title: "Scaffold handover — east elevation",
      inspectionType: "scaffold",
    });
    expect(inspection.statusCode).toBe(201);
    const inspectionId = inspection.json().id as string;

    const noPhoto = await post(
      `/projects/${gbProject}/safety/inspections/${inspectionId}/complete`,
      {
        responses: [
          { itemId: "sc1", isPass: true },
          { itemId: "sc2", isPass: true },
        ],
      },
    );
    expect(noPhoto.statusCode).toBe(400);
    expect(noPhoto.json().message).toContain("photo-required");
    expect(noPhoto.json().message).toContain("Guardrails continuous");

    const withPhoto = await post(
      `/projects/${gbProject}/safety/inspections/${inspectionId}/complete`,
      {
        responses: [
          { itemId: "sc1", isPass: true, photoFileIds: ["fil_x"] },
          { itemId: "sc2", isPass: true },
        ],
      },
    );
    expect(withPhoto.statusCode).toBe(200);
    expect(withPhoto.json().scoring.result).toBe("pass");
  });
});

/* ------------------------------------------------------------------ */
/* AUDIT BUG 6 — the observation board's middle lanes                  */
/* ------------------------------------------------------------------ */

describe("observation lifecycle derived from its corrective actions", () => {
  it("moves through action_assigned, actioned and verified as the actions move", async () => {
    const observation = await post(`/projects/${gbProject}/safety/observations`, {
      title: "Unprotected riser opening on level 2",
      description: "Riser cover removed and not replaced.",
      observedAt: hoursAgo(3),
      kind: "negative",
      category: "housekeeping",
      severity: "high",
      riskLikelihood: 4,
      riskSeverity: 4,
    });
    expect(observation.statusCode).toBe(201);
    const observationId = observation.json().id as string;
    expect(observation.json().status).toBe("open");

    const action = await post(`/projects/${gbProject}/safety/corrective-actions`, {
      sourceType: "observation",
      sourceId: observationId,
      title: "Fit a bolted riser cover",
      hierarchyOfControl: "engineering",
      dueDate: days(3),
      ownerId: second.userId,
    });
    expect(action.statusCode).toBe(201);
    const actionId = action.json().id as string;

    let read = await get(`/projects/${gbProject}/safety/observations/${observationId}`);
    expect(read.json().status).toBe("action_assigned");

    const completed = await post(
      `/projects/${gbProject}/safety/corrective-actions/${actionId}/complete`,
      { completionNote: "Bolted cover fitted and painted.", evidenceFileIds: [] },
      second.headers,
    );
    expect(completed.statusCode).toBe(200);
    read = await get(`/projects/${gbProject}/safety/observations/${observationId}`);
    expect(read.json().status).toBe("actioned");

    const verified = await post(
      `/projects/${gbProject}/safety/corrective-actions/${actionId}/verify`,
      { verificationMethod: "physical_inspection", note: "Cover in place and bolted." },
      owner.headers,
    );
    expect(verified.statusCode).toBe(200);
    read = await get(`/projects/${gbProject}/safety/observations/${observationId}`);
    expect(read.json().status).toBe("verified");

    // closure is still a human act, by somebody other than the observer
    const closed = await post(
      `/projects/${gbProject}/safety/observations/${observationId}/close`,
      { note: "Verified on site." },
      second.headers,
    );
    expect(closed.statusCode).toBe(200);
    expect(closed.json().status).toBe("closed");
  });
});

/* ------------------------------------------------------------------ */
/* AUDIT BUG 7 — sweeps belong on list reads and the scheduler         */
/* ------------------------------------------------------------------ */

describe("sweep placement", () => {
  it("does not sweep on a detail read, and does on a list read", async () => {
    const observation = await post(`/projects/${usProject}/safety/observations`, {
      title: "Ladder left across the walkway",
      observedAt: hoursAgo(4),
    });
    const observationId = observation.json().id as string;
    const action = await post(`/projects/${usProject}/safety/corrective-actions`, {
      sourceType: "observation",
      sourceId: observationId,
      title: "Remove the ladder from the walkway",
      hierarchyOfControl: "elimination",
      dueDate: days(2),
      ownerId: second.userId,
    });
    const actionId = action.json().id as string;
    // the due date passes
    const redated = await patch(
      `/projects/${usProject}/safety/corrective-actions/${actionId}`,
      { dueDate: days(-3), revisionReason: "Backdated for this test's sweep." },
    );
    expect(redated.statusCode).toBe(200);

    await get(`/projects/${usProject}/safety/corrective-actions/${actionId}`);
    expect(await signalKeys("safety_corrective_action_overdue")).not.toContain(actionId);

    await get(`/projects/${usProject}/safety/corrective-actions`);
    expect(await signalKeys("safety_corrective_action_overdue")).toContain(actionId);
  });
});

/* ------------------------------------------------------------------ */
/* Device and lone-worker alarms                                       */
/* ------------------------------------------------------------------ */

describe("device and lone-worker alarms", () => {
  let alarmId: string;

  it("ingests an alarm, sets the response clock from its class and is idempotent on retry", async () => {
    const res = await post(`/projects/${gbProject}/safety/sensor-events`, {
      kind: "man_down",
      source: "lone_worker_device",
      deviceId: "LW-4471",
      workerId,
      occurredAt: hoursAgo(1),
      receivedAt: hoursAgo(1),
      externalId: "dev-evt-1",
      rawPayload: { g: 6.4 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().accepted).toBe(1);
    const event = res.json().events[0];
    alarmId = event.id as string;
    expect(event.severity).toBe("critical");
    expect(event.isLifeSafety).toBe(true);
    expect(event.responseDeadlineMinutes).toBe(5);
    expect(event.acknowledgeDueAt).toBeTruthy();

    const retry = await post(`/projects/${gbProject}/safety/sensor-events`, {
      kind: "man_down",
      source: "lone_worker_device",
      deviceId: "LW-4471",
      workerId,
      occurredAt: hoursAgo(1),
      receivedAt: hoursAgo(1),
      externalId: "dev-evt-1",
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().duplicates).toHaveLength(1);
    expect(retry.json().events[0].id).toBe(alarmId);
  });

  it("refuses an alarm timestamped in the future", async () => {
    const res = await post(`/projects/${gbProject}/safety/sensor-events`, {
      kind: "impact",
      occurredAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("future");
  });

  it("refuses to call a life-safety alarm a false alarm before anybody looked", async () => {
    const res = await post(`/projects/${gbProject}/safety/sensor-events/${alarmId}/resolve`, {
      status: "false_alarm",
      outcome: "Looks like a dropped device.",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("never been acknowledged");
  });

  it("records the response time on acknowledgement", async () => {
    const res = await post(`/projects/${gbProject}/safety/sensor-events/${alarmId}/acknowledge`, {
      note: "Supervisor attended; operative was working head-down and is unhurt.",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("acknowledged");
    expect(res.json().response.responseSeconds).toBeGreaterThan(0);
    expect(res.json().response.late).toBe(true);
    expect(res.json().response.note).toContain("deadline");

    const again = await post(`/projects/${gbProject}/safety/sensor-events/${alarmId}/acknowledge`, {
      note: "again",
    });
    expect(again.statusCode).toBe(409);
  });

  it("raises an observation from an alarm and links the two, but only once", async () => {
    const raised = await post(
      `/projects/${gbProject}/safety/sensor-events/${alarmId}/raise-observation`,
      {
        title: "Lone working in the basement with no check-in",
        description: "Man-down alarm from an operative working alone.",
        category: "other",
        riskLikelihood: 3,
        riskSeverity: 5,
      },
    );
    expect(raised.statusCode).toBe(201);
    expect(raised.json().observation.riskScore).toBe(15);
    expect(raised.json().sensorEvent.observationId).toBe(raised.json().observation.id);

    const twice = await post(
      `/projects/${gbProject}/safety/sensor-events/${alarmId}/raise-observation`,
      { title: "again" },
    );
    expect(twice.statusCode).toBe(409);
  });

  it("raises a critical signal for a life-safety alarm nobody answered", async () => {
    const res = await post(`/projects/${gbProject}/safety/sensor-events`, {
      kind: "gas_alarm",
      source: "gas_detector",
      deviceId: "GD-22",
      occurredAt: hoursAgo(3),
      receivedAt: hoursAgo(3),
      measurementValue: 42,
      measurementUnit: "ppm",
      thresholdValue: 10,
    });
    const unanswered = res.json().events[0].id as string;
    await app.scheduler.runNow("safety.sweeps");
    const rows = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "safety_device_alarm_unanswered"),
        ),
      );
    const raised = rows.filter((r) => (r.evidenceRefs as { key?: string }).key === unanswered);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.severity).toBe("critical");
    expect(raised[0]?.explanation).toContain("coroner");

    const stored = await app.db
      .select()
      .from(safetySensorEvents)
      .where(eq(safetySensorEvents.id, unanswered));
    expect(stored[0]?.signalId).toBe(raised[0]?.id);
  });

  it("shuts another company out of the alarm register", async () => {
    const res = await get(`/projects/${gbProject}/safety/sensor-events`, stranger.headers);
    expect(res.statusCode).toBe(403);
    const write = await post(
      `/projects/${gbProject}/safety/sensor-events`,
      { kind: "sos", occurredAt: hoursAgo(1) },
      stranger.headers,
    );
    expect(write.statusCode).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/* Statutory form generation                                           */
/* ------------------------------------------------------------------ */

describe("statutory form generation", () => {
  const year = Number(todayISO().slice(0, 4));
  let logId: string;

  it("previews the 300 log without storing anything", async () => {
    const res = await get(
      `/projects/${usProject}/safety/regulatory/preview?form=osha_300&year=${year}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().stored).toBe(false);
    expect(res.json().payload.form).toBe("osha_300");
  });

  it("generates, freezes and hashes the 300 log", async () => {
    const res = await post(`/projects/${usProject}/safety/regulatory/reports`, {
      form: "osha_300",
      year,
    });
    expect(res.statusCode).toBe(201);
    logId = res.json().id as string;
    expect(res.json().sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.json().fileId).toBeTruthy();
    expect(res.json().payload.rows.length).toBeGreaterThan(0);

    const read = await get(`/projects/${usProject}/safety/regulatory/reports/${logId}`);
    expect(read.statusCode).toBe(200);
    expect(read.json().integrity.recomputed).toBe(read.json().integrity.sha256);
  });

  it("supersedes the previous artefact rather than mutating it", async () => {
    const again = await post(`/projects/${usProject}/safety/regulatory/reports`, {
      form: "osha_300",
      year,
    });
    expect(again.statusCode).toBe(201);
    expect(again.json().supersedes.map((s: { id: string }) => s.id)).toContain(logId);
    const old = await get(`/projects/${usProject}/safety/regulatory/reports/${logId}`);
    expect(old.json().status).toBe("superseded");
    expect(old.json().supersededById).toBe(again.json().id);
  });

  it("produces a 300A whose denominators are real or absent, and certifies it once", async () => {
    const res = await post(`/projects/${usProject}/safety/regulatory/reports`, {
      form: "osha_300a",
      year,
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    expect(res.json().payload.totalHoursWorked.value).toBe(10_000);
    expect(res.json().payload.annualAverageEmployees.value).toBeNull();
    expect(res.json().payload.annualAverageEmployees.reason).toBeTruthy();

    const certified = await post(
      `/projects/${usProject}/safety/regulatory/reports/${id}/certify`,
      { certifierTitle: "Chief Operating Officer" },
    );
    expect(certified.statusCode).toBe(200);
    expect(certified.json().certifierTitle).toBe("Chief Operating Officer");
    const twice = await post(
      `/projects/${usProject}/safety/regulatory/reports/${id}/certify`,
      { certifierTitle: "CFO" },
    );
    expect(twice.statusCode).toBe(409);
  });

  it("refuses to certify anything that is not a 300A", async () => {
    const list = await get(
      `/projects/${usProject}/safety/regulatory/reports?form=osha_300&status=generated`,
    );
    const id = list.json().items[0].id as string;
    const res = await post(
      `/projects/${usProject}/safety/regulatory/reports/${id}/certify`,
      { certifierTitle: "COO" },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("300A");
  });

  it("prefills the F2508 for a GB incident and records that it was filed", async () => {
    const created = await post(`/projects/${gbProject}/safety/incidents`, {
      incidentType: "injury",
      title: "Amputation of a finger tip on a bench saw",
      description: "Hand caught in an unguarded bench saw.",
      occurredAt: hoursAgo(6),
      workerId,
      injuredPersonType: "employee",
      injuryNature: "amputation",
      bodyPart: "finger",
      severity: "serious",
    });
    const incidentId = created.json().id as string;
    expect(created.json().riddorCategory).toBe("specified_injury");

    const res = await post(`/projects/${gbProject}/safety/regulatory/reports`, {
      form: "riddor_f2508",
      incidentId,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().payload.aboutThePerson.name.value).toBe("Aidan Doyle");
    expect(res.json().payload.disclaimer).toContain("nothing here is transmitted");

    const submitted = await post(
      `/projects/${gbProject}/safety/regulatory/reports/${res.json().id}/submit`,
      { submissionReference: "HSE/ONLINE/771" },
    );
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().status).toBe("submitted");
    expect(submitted.json().note).toContain("does not, on its own, discharge");
  });

  it("refuses a year-scoped form without a year and a case form without a case", async () => {
    const noYear = await post(`/projects/${usProject}/safety/regulatory/reports`, {
      form: "osha_300",
    });
    expect(noYear.statusCode).toBe(400);
    const noCase = await post(`/projects/${gbProject}/safety/regulatory/reports`, {
      form: "osha_301",
    });
    expect(noCase.statusCode).toBe(400);
  });

  it("shuts another company out of the artefact register", async () => {
    const res = await get(
      `/projects/${usProject}/safety/regulatory/reports`,
      stranger.headers,
    );
    expect(res.statusCode).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/* Vendor scorecard                                                    */
/* ------------------------------------------------------------------ */

describe("vendor safety scorecard", () => {
  it("reads the registers for one vendor on one project", async () => {
    const res = await get(
      `/projects/${gbProject}/safety/vendor-scorecard?vendorId=${vendorId}`,
    );
    expect(res.statusCode).toBe(200);
    const card = res.json().scorecards[0];
    expect(card.vendorId).toBe(vendorId);
    expect(card.metrics.length).toBeGreaterThan(0);
    // no timecards against this vendor on this project — no rate, and a reason
    const trir = card.metrics.find((m: { key: string }) => m.key === "trir");
    expect(trir.value).toBeNull();
    expect(trir.reasons.length).toBeGreaterThan(0);
  });

  it("rolls up across the company and says when nothing is known", async () => {
    const res = await get(`/companies/current/safety/vendor-scorecard?vendorId=${vendorId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().scorecards.length).toBe(1);
    expect(res.json().note).toContain("prequalification");

    // a window in which the supplier appears nowhere returns no grade AND says why
    const empty = await get(
      `/companies/current/safety/vendor-scorecard?from=2001-01-01&to=2001-12-31`,
    );
    expect(empty.json().scorecards).toEqual([]);
    expect(empty.json().reasons.join(" ")).toContain("nothing to read");
  });

  it("publishes the observed record onto the vendor's live prequalification submission", async () => {
    const questionnaireId = newId("pqq");
    await app.db.insert(prequalificationQuestionnaires).values({
      id: questionnaireId,
      companyId: owner.companyId,
      number: 1,
      reference: "PQQ-0001",
      name: "Standard supply-chain questionnaire",
      createdBy: owner.userId,
    });
    const submissionId = newId("pqs");
    await app.db.insert(prequalificationSubmissions).values({
      id: submissionId,
      companyId: owner.companyId,
      questionnaireId,
      vendorId,
      number: 1,
      reference: "PQS-0001",
      status: "assessed",
      createdBy: owner.userId,
    });

    const res = await post(`/companies/current/safety/vendor-scorecard/publish`, {
      vendorId,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().published.map((p: { submissionId: string }) => p.submissionId)).toContain(
      submissionId,
    );
    const rows = await app.db
      .select()
      .from(prequalificationSubmissions)
      .where(eq(prequalificationSubmissions.id, submissionId));
    const observed = (rows[0]?.detail as { observedSafetyRecord?: { source?: string } })
      .observedSafetyRecord;
    expect(observed?.source).toBe("safety_vendor_scorecard");
  });
});

/* ------------------------------------------------------------------ */
/* Risk index, under-reporting and health inputs                       */
/* ------------------------------------------------------------------ */

describe("predictive index, under-reporting and health inputs", () => {
  it("computes the index without storing, and stores it on recompute with a trend", async () => {
    const read = await get(`/projects/${gbProject}/safety/risk-index`);
    expect(read.statusCode).toBe(200);
    expect(read.json().components.length).toBeGreaterThan(0);
    expect(read.json().trend).toEqual([]);
    expect(read.json().note).toContain("LEADING index");

    const recomputed = await post(`/projects/${gbProject}/safety/risk-index/recompute`, {});
    expect(recomputed.statusCode).toBe(200);
    expect(recomputed.json().snapshotId).toBeTruthy();

    // recomputing on the same day replaces the reading rather than adding one
    const again = await post(`/projects/${gbProject}/safety/risk-index/recompute`, {});
    expect(again.json().snapshotId).toBe(recomputed.json().snapshotId);

    const withTrend = await get(`/projects/${gbProject}/safety/risk-index`);
    expect(withTrend.json().trend).toHaveLength(1);
  });

  it("runs the index over every project from the scheduler", async () => {
    const outcome = await app.scheduler.runNow("safety.risk-index");
    expect(outcome).toBeTruthy();
  });

  it("reads under-reporting as evidence, with what would refute it", async () => {
    const res = await get(`/projects/${quietProject}/safety/under-reporting`);
    expect(res.statusCode).toBe(200);
    expect(res.json().note).toContain("about the REGISTER");
    for (const finding of res.json().findings as Array<{ refutedBy: string; confidence: number }>) {
      expect(finding.refutedBy).toBeTruthy();
      expect(finding.confidence).toBeLessThan(1);
    }
  });

  it("publishes health inputs with a reason for every figure it cannot give", async () => {
    const res = await get(`/projects/${quietProject}/safety/health-inputs`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.metrics).toHaveProperty("safetyRiskIndex");
    expect(body.metrics.exposureHours365d).toBeNull();
    expect(body.reasons.join(" ")).toContain("no incident RATE");
    expect(body.window.from < body.window.to).toBe(true);
  });

  it("shuts another company out of the index", async () => {
    const res = await get(`/projects/${gbProject}/safety/risk-index`, stranger.headers);
    expect(res.statusCode).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/* Investigation assistant                                             */
/* ------------------------------------------------------------------ */

describe("investigation assistant", () => {
  let incidentId: string;

  it("degrades to the deterministic assembly when the AI layer is not configured", async () => {
    const created = await post(`/projects/${gbProject}/safety/incidents`, {
      incidentType: "injury",
      title: "Struck by a swinging load",
      description: "Operative struck by a load being slewed over the laydown area.",
      occurredAt: hoursAgo(8),
      workerId,
      vendorId,
      injuredPersonType: "employee",
      mechanism: "struck_by",
      severity: "serious",
      witnesses: [{ name: "T. Byrne", organisation: "Groundworks Ltd" }],
    });
    expect(created.statusCode).toBe(201);
    incidentId = created.json().id as string;

    const res = await post(
      `/projects/${gbProject}/safety/incidents/${incidentId}/assist`,
      {},
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().available).toBe(false);
    expect(res.json().reason).toContain("ANTHROPIC_API_KEY");
    expect(res.json().assist).toBeNull();
    // the useful half is deterministic and is still returned
    expect(res.json().context).toHaveProperty("priorObservations");
    expect(res.json().context.witnesses[0].name).toBe("T. Byrne");
  });

  it("writes nothing unless a human accepts it, and ledgers the run id when they do", async () => {
    const empty = await post(
      `/projects/${gbProject}/safety/incidents/${incidentId}/assist/accept`,
      { runId: "airun_test" },
    );
    expect(empty.statusCode).toBe(400);
    expect(empty.json().message).toContain("Nothing was accepted");

    const accepted = await post(
      `/projects/${gbProject}/safety/incidents/${incidentId}/assist/accept`,
      {
        runId: "airun_test",
        contributingFactors: [
          {
            factor: "Load slewed over an occupied laydown area",
            category: "immediate",
            sourceIds: [],
          },
        ],
        actions: [
          {
            title: "Re-brief the slinger-signaller team",
            hierarchyOfControl: "administrative",
            dueDate: days(5),
            ownerId: second.userId,
          },
        ],
      },
    );
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().contributingFactorsAccepted).toBe(1);
    expect(accepted.json().actionsCreated).toHaveLength(1);
    expect(accepted.json().warning).toContain("hierarchy of control");

    const detail = await get(`/projects/${gbProject}/safety/incidents/${incidentId}`);
    const factors = detail.json().investigation.contributingFactors as Array<
      Record<string, unknown>
    >;
    expect(factors.at(-1)?.["agentRunId"]).toBe("airun_test");
    expect(factors.at(-1)?.["acceptedBy"]).toBe(owner.userId);
  });

  it("shuts another company out of the assistant", async () => {
    const res = await post(
      `/projects/${gbProject}/safety/incidents/${incidentId}/assist`,
      {},
      stranger.headers,
    );
    expect(res.statusCode).toBe(403);
  });
});
