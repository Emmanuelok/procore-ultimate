import { describe, expect, it } from "vitest";
import {
  assessReportability,
  blankFacts,
  classifyOshaCase,
  isNotificationMissed,
  resolveRegimes,
  ruleCatalogue,
  type IncidentFacts,
  type ReportabilityDetermination,
  type RuleDetermination,
} from "./reportability.js";

/**
 * The reportability rules, each against a hand-worked scenario with its
 * deadline computed by hand from the citation.
 *
 * Every deadline in this file was worked out from the regulation, not from
 * the implementation: RIDDOR counts calendar days from the ACCIDENT and the
 * deadline expires at the end of the due day; OSHA counts hours from the
 * employer LEARNING of the event. Where the two regimes both apply, the
 * earliest deadline governs — which on a fatality means the OSHA 8-hour
 * telephone report, eleven and a half days before the RIDDOR form.
 */

const facts = (over: Partial<IncidentFacts>): IncidentFacts => ({ ...blankFacts(), ...over });

const rule = (d: ReportabilityDetermination, ruleId: string): RuleDetermination => {
  const r = d.rules.find((x) => x.ruleId === ruleId);
  if (!r) throw new Error(`rule ${ruleId} was not assessed; assessed: ${d.rules.map((x) => x.ruleId).join(", ")}`);
  return r;
};

const RIDDOR = ["riddor"] as const;
const OSHA = ["osha"] as const;

/* ================================================================== */
/* RIDDOR 2013                                                         */
/* ================================================================== */

describe("RIDDOR reg. 6 — work-related fatality", () => {
  it("is reportable, notifiable without delay, and due 10 days after the accident", () => {
    const d = assessReportability(
      facts({
        incidentType: "injury",
        occurredAt: "2026-03-02T09:00:00.000Z",
        injuredPersonType: "employee",
        isFatality: true,
        treatmentLevel: "fatality",
      }),
      RIDDOR,
    );
    const r = rule(d, "riddor.fatality");
    expect(r.outcome).toBe("met");
    expect(r.citation).toContain("reg. 6");
    expect(r.deadline?.dueAt).toBe("2026-03-12T23:59:59.000Z");
    expect(r.deadline?.clockStartsFrom).toBe("the accident");
    expect(r.deadline?.withinLabel).toBe("10 days");
    expect(r.deadline?.immediateNotificationRequired).toBe(true);
    expect(d.isReportable).toBe(true);
    expect(d.riddorCategory).toBe("death");
    expect(d.reportDueAt).toBe("2026-03-12T23:59:59.000Z");
    expect(d.governingRuleId).toBe("riddor.fatality");
    expect(d.needsHumanReview).toBe(false);
  });

  it("applies to a member of the public, not only to workers", () => {
    const d = assessReportability(
      facts({
        incidentType: "public_impact",
        occurredAt: "2026-03-02T09:00:00.000Z",
        injuredPersonType: "member_of_public",
        isFatality: true,
      }),
      RIDDOR,
    );
    expect(rule(d, "riddor.fatality").outcome).toBe("met");
    expect(d.riddorCategory).toBe("death");
  });

  it("refuses to stand the report down on a not-work-related flag without a human", () => {
    const d = assessReportability(
      facts({
        occurredAt: "2026-03-02T09:00:00.000Z",
        injuredPersonType: "employee",
        isFatality: true,
        workRelated: false,
      }),
      RIDDOR,
    );
    const r = rule(d, "riddor.fatality");
    expect(r.outcome).toBe("indeterminate");
    expect(r.needsHumanReview).toBe(true);
    expect(d.needsHumanReview).toBe(true);
    expect(d.isReportable).toBe(false);
    expect(d.openQuestions.join(" ")).toContain("reg. 6");
  });
});

describe("RIDDOR reg. 4(1) + Schedule 1 — specified injuries", () => {
  const base = {
    incidentType: "injury" as const,
    occurredAt: "2026-03-02T09:00:00.000Z",
    injuredPersonType: "subcontractor" as const,
    lostTimeDays: 2,
  };

  it("a fractured leg is a specified injury, due 10 days after the accident", () => {
    const d = assessReportability(
      facts({ ...base, injuryNature: "fracture", bodyPart: "leg" }),
      RIDDOR,
    );
    const r = rule(d, "riddor.specified_injury");
    expect(r.outcome).toBe("met");
    expect(r.deadline?.dueAt).toBe("2026-03-12T23:59:59.000Z");
    expect(r.basis.join(" ")).toContain("Schedule 1 para. 1");
    expect(d.riddorCategory).toBe("specified_injury");
    expect(d.needsHumanReview).toBe(false);
  });

  it("a fractured finger is expressly excluded", () => {
    const d = assessReportability(
      facts({ ...base, injuryNature: "fracture", bodyPart: "finger" }),
      RIDDOR,
    );
    const r = rule(d, "riddor.specified_injury");
    expect(r.outcome).toBe("not_met");
    expect(r.basis.join(" ")).toContain("expressly excluded");
    expect(d.isReportable).toBe(false);
    expect(d.riddorCategory).toBe("not_reportable");
  });

  it("an amputation is a specified injury", () => {
    const d = assessReportability(
      facts({ ...base, injuryNature: "amputation", bodyPart: "hand" }),
      RIDDOR,
    );
    expect(rule(d, "riddor.specified_injury").outcome).toBe("met");
    expect(rule(d, "riddor.specified_injury").basis.join(" ")).toContain("para. 2");
  });

  it("a burn is indeterminate until its extent is answered, and says which fact is missing", () => {
    const d = assessReportability(
      facts({ ...base, injuryNature: "burn_chemical", bodyPart: "arm" }),
      RIDDOR,
    );
    const r = rule(d, "riddor.specified_injury");
    expect(r.outcome).toBe("indeterminate");
    expect(r.needsHumanReview).toBe(true);
    expect(r.openQuestion).toContain("10%");
    expect(r.openQuestion).toContain("seriousBurn");
    expect(d.isReportable).toBe(false);
    expect(d.riddorCategory).toBe("under_assessment");
  });

  it("the same burn answered `seriousBurn: true` becomes reportable with a deadline", () => {
    const d = assessReportability(
      facts({ ...base, injuryNature: "burn_chemical", bodyPart: "arm", seriousBurn: true }),
      RIDDOR,
    );
    const r = rule(d, "riddor.specified_injury");
    expect(r.outcome).toBe("met");
    expect(r.deadline?.dueAt).toBe("2026-03-12T23:59:59.000Z");
  });

  it("an eye injury is indeterminate until permanence of sight loss is answered", () => {
    const d = assessReportability(
      facts({ ...base, injuryNature: "foreign_body", bodyPart: "eye" }),
      RIDDOR,
    );
    const r = rule(d, "riddor.specified_injury");
    expect(r.outcome).toBe("indeterminate");
    expect(r.openQuestion).toContain("permanent");
  });
});

describe("RIDDOR reg. 4(2) — over-seven-day incapacitation", () => {
  const base = {
    incidentType: "injury" as const,
    occurredAt: "2026-03-02T09:00:00.000Z",
    injuredPersonType: "employee" as const,
    isLostTime: true,
  };

  it("nine days off is reportable, and the report is due 15 days after the ACCIDENT", () => {
    const d = assessReportability(facts({ ...base, lostTimeDays: 9 }), RIDDOR);
    const r = rule(d, "riddor.over_7_day");
    expect(r.outcome).toBe("met");
    expect(r.deadline?.dueAt).toBe("2026-03-17T23:59:59.000Z");
    expect(r.deadline?.withinLabel).toBe("15 days");
    expect(r.deadline?.clockStartsFrom).toBe("the accident");
    expect(r.deadline?.immediateNotificationRequired).toBe(false);
    expect(d.riddorCategory).toBe("over_7_day_incapacitation");
    expect(d.reportDueAt).toBe("2026-03-17T23:59:59.000Z");
  });

  it("exactly seven days is NOT reportable — the test is MORE than seven", () => {
    const d = assessReportability(facts({ ...base, lostTimeDays: 7 }), RIDDOR);
    expect(rule(d, "riddor.over_7_day").outcome).toBe("not_met");
    expect(d.isReportable).toBe(false);
    // but it still crosses the reg. 12 recording threshold
    expect(rule(d, "riddor.over_3_day_record").outcome).toBe("met");
  });

  it("crossing the threshold by adding restricted duty to lost time is flagged for a human", () => {
    const d = assessReportability(
      facts({ ...base, lostTimeDays: 5, restrictedDutyDays: 4 }),
      RIDDOR,
    );
    const r = rule(d, "riddor.over_7_day");
    expect(r.outcome).toBe("met");
    expect(r.needsHumanReview).toBe(true);
    expect(r.openQuestion).toContain("CONSECUTIVE");
    expect(d.needsHumanReview).toBe(true);
  });

  it("is indeterminate — not `not reportable` — when the days are still running", () => {
    const d = assessReportability(
      facts({ ...base, lostTimeDays: 4, incapacityStillAccruing: true }),
      RIDDOR,
    );
    const r = rule(d, "riddor.over_7_day");
    expect(r.outcome).toBe("indeterminate");
    expect(r.needsHumanReview).toBe(true);
    expect(r.openQuestion).toContain("already running");
  });

  it("is indeterminate when the worker is off but nobody has recorded a day count", () => {
    const d = assessReportability(
      facts({ ...base, lostTimeDays: null, treatmentLevel: "hospitalised" }),
      RIDDOR,
    );
    expect(rule(d, "riddor.over_7_day").outcome).toBe("indeterminate");
    expect(d.riddorCategory).toBe("under_assessment");
  });
});

describe("RIDDOR reg. 12 — the over-three-day RECORDING duty", () => {
  it("is met at five days but carries no notification deadline", () => {
    const d = assessReportability(
      facts({
        incidentType: "injury",
        occurredAt: "2026-03-02T09:00:00.000Z",
        injuredPersonType: "employee",
        isLostTime: true,
        lostTimeDays: 5,
      }),
      RIDDOR,
    );
    const r = rule(d, "riddor.over_3_day_record");
    expect(r.outcome).toBe("met");
    expect(r.isRecordingDutyOnly).toBe(true);
    expect(r.deadline).toBeNull();
    // A recording duty does not make the incident "reportable" to an authority.
    expect(d.isReportable).toBe(false);
    expect(d.reportDueAt).toBeNull();
    expect(d.riddorCategory).toBe("over_3_day_recordable");
    expect(d.reasons.join(" ")).toContain("recording duties");
  });
});

describe("RIDDOR reg. 8 + Schedule 2 — dangerous occurrences", () => {
  it("an asserted Schedule 2 class is reportable, due 10 days after the occurrence", () => {
    const d = assessReportability(
      facts({
        incidentType: "dangerous_occurrence",
        occurredAt: "2026-03-02T09:00:00.000Z",
        dangerousOccurrenceClass: "sch2_para_10_collapse_of_scaffolding",
      }),
      RIDDOR,
    );
    const r = rule(d, "riddor.dangerous_occurrence");
    expect(r.outcome).toBe("met");
    expect(r.deadline?.dueAt).toBe("2026-03-12T23:59:59.000Z");
    expect(r.deadline?.immediateNotificationRequired).toBe(true);
    expect(r.basis.join(" ")).toContain("scaffolding over 5 metres");
    expect(d.riddorCategory).toBe("dangerous_occurrence");
  });

  it("refuses to infer a Schedule 2 class from the incident type alone", () => {
    const d = assessReportability(
      facts({ incidentType: "dangerous_occurrence", occurredAt: "2026-03-02T09:00:00.000Z" }),
      RIDDOR,
    );
    const r = rule(d, "riddor.dangerous_occurrence");
    expect(r.outcome).toBe("indeterminate");
    expect(r.needsHumanReview).toBe(true);
    expect(r.openQuestion).toContain("closed list of 27");
    expect(d.isReportable).toBe(false);
    expect(d.riddorCategory).toBe("under_assessment");
  });

  it("names the likely class for a structural failure but still asks a human", () => {
    const d = assessReportability(
      facts({ incidentType: "structural_failure", occurredAt: "2026-03-02T09:00:00.000Z" }),
      RIDDOR,
    );
    const r = rule(d, "riddor.dangerous_occurrence");
    expect(r.outcome).toBe("indeterminate");
    expect(r.openQuestion).toContain("5 tonnes");
  });

  it("rejects a class it does not recognise rather than accepting the assertion", () => {
    const d = assessReportability(
      facts({
        incidentType: "dangerous_occurrence",
        occurredAt: "2026-03-02T09:00:00.000Z",
        dangerousOccurrenceClass: "sch2_para_99_invented",
      }),
      RIDDOR,
    );
    const r = rule(d, "riddor.dangerous_occurrence");
    expect(r.outcome).toBe("indeterminate");
    expect(r.openQuestion).toContain("not one this engine recognises");
  });
});

describe("RIDDOR reg. 5 — a non-worker taken to hospital", () => {
  it("is reportable within 10 days, and says the category enum has no member for it", () => {
    const d = assessReportability(
      facts({
        incidentType: "injury",
        occurredAt: "2026-03-02T09:00:00.000Z",
        injuredPersonType: "member_of_public",
        treatmentLevel: "hospitalised",
        hospitalAdmission: "inpatient_treatment",
      }),
      RIDDOR,
    );
    const r = rule(d, "riddor.non_worker_hospital");
    expect(r.outcome).toBe("met");
    expect(r.deadline?.dueAt).toBe("2026-03-12T23:59:59.000Z");
    expect(d.isReportable).toBe(true);
    expect(d.riddorCategory).toBe("under_assessment");
    expect(d.openQuestions.join(" ")).toContain("no member for an injury to a non-worker");
  });

  it("flags an emergency-department attendance because reg. 5 requires TREATMENT", () => {
    const d = assessReportability(
      facts({
        incidentType: "injury",
        occurredAt: "2026-03-02T09:00:00.000Z",
        injuredPersonType: "visitor",
        treatmentLevel: "emergency_department",
      }),
      RIDDOR,
    );
    const r = rule(d, "riddor.non_worker_hospital");
    expect(r.outcome).toBe("met");
    expect(r.needsHumanReview).toBe(true);
    expect(r.openQuestion).toContain("FOR TREATMENT");
  });
});

describe("RIDDOR regs. 7 and 9 — disease and gas", () => {
  it("an occupational illness with no written diagnosis has not yet triggered the duty", () => {
    const d = assessReportability(
      facts({ incidentType: "occupational_illness", occurredAt: "2026-03-02T09:00:00.000Z" }),
      RIDDOR,
    );
    const r = rule(d, "riddor.occupational_disease");
    expect(r.outcome).toBe("indeterminate");
    expect(r.openQuestion).toContain("written diagnosis");
    expect(d.isReportable).toBe(false);
  });

  it("a diagnosed disease is reportable without delay, from the diagnosis date, and needs a human", () => {
    const d = assessReportability(
      facts({
        incidentType: "occupational_illness",
        occurredAt: "2026-01-05T09:00:00.000Z",
        occupationalDiseaseDiagnosed: true,
        diagnosisReceivedAt: "2026-03-02T11:00:00.000Z",
      }),
      RIDDOR,
    );
    const r = rule(d, "riddor.occupational_disease");
    expect(r.outcome).toBe("met");
    expect(r.deadline?.dueAt).toBe("2026-03-02T11:00:00.000Z");
    expect(r.deadline?.withinLabel).toBe("without delay");
    expect(r.deadline?.clockStartsFrom).toBe("receipt of the written diagnosis");
    expect(r.needsHumanReview).toBe(true);
  });

  it("a gas incident is reportable within 14 days", () => {
    const d = assessReportability(
      facts({ incidentType: "fire", occurredAt: "2026-03-02T09:00:00.000Z", gasIncident: true }),
      RIDDOR,
    );
    const r = rule(d, "riddor.gas_incident");
    expect(r.outcome).toBe("met");
    expect(r.deadline?.dueAt).toBe("2026-03-16T23:59:59.000Z");
    expect(d.riddorCategory).toBe("gas_incident");
  });
});

/* ================================================================== */
/* 29 CFR Part 1904                                                    */
/* ================================================================== */

describe("29 CFR 1904.39(a)(1) — fatality, 8 hours from knowledge", () => {
  it("runs the clock from the employer learning of the death, not from the accident", () => {
    const d = assessReportability(
      facts({
        incidentType: "injury",
        occurredAt: "2026-03-02T09:00:00.000Z",
        becameAwareAt: "2026-03-02T14:30:00.000Z",
        injuredPersonType: "employee",
        isFatality: true,
        fatalityOccurredAt: "2026-03-02T13:00:00.000Z",
      }),
      OSHA,
    );
    const r = rule(d, "osha.fatality_8h");
    expect(r.outcome).toBe("met");
    expect(r.deadline?.dueAt).toBe("2026-03-02T22:30:00.000Z");
    expect(r.deadline?.withinLabel).toBe("8 hours");
    expect(r.deadline?.clockStartsAt).toBe("2026-03-02T14:30:00.000Z");
    expect(d.oshaCaseType).toBe("death");
    expect(d.reportDueAt).toBe("2026-03-02T22:30:00.000Z");
    expect(d.governingRuleId).toBe("osha.fatality_8h");
  });

  it("does not report a death occurring more than 30 days after the incident, but keeps it recordable", () => {
    const d = assessReportability(
      facts({
        incidentType: "injury",
        occurredAt: "2026-01-05T09:00:00.000Z",
        becameAwareAt: "2026-02-20T09:00:00.000Z",
        injuredPersonType: "employee",
        isFatality: true,
        fatalityOccurredAt: "2026-02-20T08:00:00.000Z",
      }),
      OSHA,
    );
    const r = rule(d, "osha.fatality_8h");
    expect(r.outcome).toBe("not_met");
    expect(r.basis.join(" ")).toContain("30 days");
    expect(rule(d, "osha.recordable_300_log").outcome).toBe("met");
    expect(d.oshaCaseType).toBe("death");
  });

  it("falls back to the occurrence when awareness is unrecorded, and says the clock is the safer one", () => {
    const d = assessReportability(
      facts({
        occurredAt: "2026-03-02T09:00:00.000Z",
        injuredPersonType: "employee",
        isFatality: true,
        fatalityOccurredAt: "2026-03-02T09:30:00.000Z",
      }),
      OSHA,
    );
    const r = rule(d, "osha.fatality_8h");
    expect(r.outcome).toBe("met");
    expect(r.deadline?.dueAt).toBe("2026-03-02T17:00:00.000Z");
    expect(r.needsHumanReview).toBe(true);
    expect(r.openQuestion).toContain("knowledge");
  });
});

describe("29 CFR 1904.39(a)(2) — in-patient hospitalization, 24 hours", () => {
  const base = {
    incidentType: "injury" as const,
    occurredAt: "2026-03-02T09:00:00.000Z",
    becameAwareAt: "2026-03-02T14:30:00.000Z",
    injuredPersonType: "employee" as const,
    treatmentLevel: "hospitalised" as const,
  };

  it("reports a formal admission for treatment within 24 hours of learning of it", () => {
    const d = assessReportability(
      facts({
        ...base,
        hospitalAdmission: "inpatient_treatment",
        hospitalAdmittedAt: "2026-03-02T13:30:00.000Z",
      }),
      OSHA,
    );
    const r = rule(d, "osha.inpatient_hospitalization_24h");
    expect(r.outcome).toBe("met");
    expect(r.deadline?.dueAt).toBe("2026-03-03T14:30:00.000Z");
    expect(r.deadline?.withinLabel).toBe("24 hours");
    expect(d.isReportable).toBe(true);
  });

  it("does not report an admission for observation or diagnostic testing only", () => {
    const d = assessReportability(
      facts({ ...base, hospitalAdmission: "inpatient_observation_only" }),
      OSHA,
    );
    const r = rule(d, "osha.inpatient_hospitalization_24h");
    expect(r.outcome).toBe("not_met");
    expect(r.basis.join(" ")).toContain("expressly excludes");
  });

  it("is indeterminate when nobody has asked the hospital which kind of admission it was", () => {
    const d = assessReportability(facts({ ...base, hospitalAdmission: "unknown" }), OSHA);
    const r = rule(d, "osha.inpatient_hospitalization_24h");
    expect(r.outcome).toBe("indeterminate");
    expect(r.needsHumanReview).toBe(true);
    expect(r.openQuestion).toContain("FORMAL IN-PATIENT ADMISSION");
    expect(d.needsHumanReview).toBe(true);
  });

  it("does not report an admission more than 24 hours after the incident", () => {
    const d = assessReportability(
      facts({
        ...base,
        hospitalAdmission: "inpatient_treatment",
        hospitalAdmittedAt: "2026-03-03T20:00:00.000Z",
      }),
      OSHA,
    );
    const r = rule(d, "osha.inpatient_hospitalization_24h");
    expect(r.outcome).toBe("not_met");
    expect(r.basis.join(" ")).toContain("1904.39(b)(6)");
    expect(rule(d, "osha.recordable_300_log").outcome).toBe("met");
  });
});

describe("29 CFR 1904.39(a)(2) — amputation and loss of an eye, 24 hours", () => {
  it("reports an amputation within 24 hours and flags the definitional exclusions", () => {
    const d = assessReportability(
      facts({
        incidentType: "injury",
        occurredAt: "2026-03-02T09:00:00.000Z",
        becameAwareAt: "2026-03-02T09:15:00.000Z",
        injuredPersonType: "employee",
        injuryNature: "amputation",
        bodyPart: "finger",
      }),
      OSHA,
    );
    const r = rule(d, "osha.amputation_24h");
    expect(r.outcome).toBe("met");
    expect(r.deadline?.dueAt).toBe("2026-03-03T09:15:00.000Z");
    expect(r.needsHumanReview).toBe(true);
    expect(r.openQuestion).toContain("degloving");
  });

  it("reports the physical loss of an eye within 24 hours", () => {
    const d = assessReportability(
      facts({
        incidentType: "injury",
        occurredAt: "2026-03-02T09:00:00.000Z",
        becameAwareAt: "2026-03-02T10:00:00.000Z",
        injuredPersonType: "employee",
        bodyPart: "eye",
        lossOfAnEye: true,
      }),
      OSHA,
    );
    const r = rule(d, "osha.loss_of_eye_24h");
    expect(r.outcome).toBe("met");
    expect(r.deadline?.dueAt).toBe("2026-03-03T10:00:00.000Z");
  });

  it("distinguishes loss of sight from loss of an eye and asks rather than guesses", () => {
    const d = assessReportability(
      facts({
        incidentType: "injury",
        occurredAt: "2026-03-02T09:00:00.000Z",
        injuredPersonType: "employee",
        bodyPart: "eye",
        treatmentLevel: "hospitalised",
      }),
      OSHA,
    );
    const r = rule(d, "osha.loss_of_eye_24h");
    expect(r.outcome).toBe("indeterminate");
    expect(r.openQuestion).toContain("REMOVAL");
    expect(r.citation).toContain("1904.39(b)(8)");
  });
});

describe("29 CFR 1904.4 / 1904.7 — the 300 log", () => {
  it("logs a days-away case within 7 calendar days of learning of it", () => {
    const d = assessReportability(
      facts({
        incidentType: "injury",
        occurredAt: "2026-03-02T09:00:00.000Z",
        becameAwareAt: "2026-03-02T14:30:00.000Z",
        injuredPersonType: "employee",
        isLostTime: true,
        lostTimeDays: 3,
      }),
      OSHA,
    );
    const r = rule(d, "osha.recordable_300_log");
    expect(r.outcome).toBe("met");
    expect(r.isRecordingDutyOnly).toBe(true);
    expect(r.deadline?.dueAt).toBe("2026-03-09T23:59:59.000Z");
    expect(r.deadline?.withinLabel).toBe("7 calendar days");
    expect(d.oshaCaseType).toBe("days_away_from_work");
    // A recording duty is not a notification, so nothing is due to OSHA.
    expect(d.isReportable).toBe(false);
    expect(d.reportDueAt).toBeNull();
  });

  it("will not decide the medical-treatment-versus-first-aid boundary itself", () => {
    const d = assessReportability(
      facts({
        incidentType: "injury",
        occurredAt: "2026-03-02T09:00:00.000Z",
        injuredPersonType: "employee",
        treatmentLevel: "medical_treatment",
      }),
      OSHA,
    );
    const r = rule(d, "osha.recordable_300_log");
    expect(r.outcome).toBe("indeterminate");
    expect(r.needsHumanReview).toBe(true);
    expect(r.openQuestion).toContain("1904.7(b)(5)(ii)");
    expect(r.openQuestion).toContain("tetanus");
    expect(d.oshaCaseType).toBe("under_assessment");
  });

  it("a first-aid-only case is not recordable", () => {
    const d = assessReportability(
      facts({
        incidentType: "injury",
        occurredAt: "2026-03-02T09:00:00.000Z",
        injuredPersonType: "employee",
        treatmentLevel: "first_aid",
      }),
      OSHA,
    );
    expect(rule(d, "osha.recordable_300_log").outcome).toBe("not_met");
    expect(d.oshaCaseType).toBe("not_recordable");
    expect(d.needsHumanReview).toBe(false);
  });

  it("puts a supplied worker's case on nobody's log until day-to-day control is established", () => {
    const d = assessReportability(
      facts({
        incidentType: "injury",
        occurredAt: "2026-03-02T09:00:00.000Z",
        injuredPersonType: "agency",
        isLostTime: true,
        lostTimeDays: 4,
      }),
      OSHA,
    );
    const r = rule(d, "osha.recordable_300_log");
    expect(r.outcome).toBe("met");
    expect(r.needsHumanReview).toBe(true);
    expect(r.openQuestion).toContain("1904.31(b)(2)");
  });

  it("does not put a member of the public on the log at all", () => {
    const d = assessReportability(
      facts({
        incidentType: "public_impact",
        occurredAt: "2026-03-02T09:00:00.000Z",
        injuredPersonType: "member_of_public",
        treatmentLevel: "hospitalised",
        hospitalAdmission: "inpatient_treatment",
      }),
      OSHA,
    );
    expect(rule(d, "osha.recordable_300_log").outcome).toBe("not_met");
    expect(rule(d, "osha.inpatient_hospitalization_24h").outcome).toBe("not_met");
    expect(d.oshaCaseType).toBe("not_recordable");
  });
});

/* ================================================================== */
/* The engine                                                          */
/* ================================================================== */

describe("multi-regime events", () => {
  it("takes the EARLIEST deadline across regimes as the governing one", () => {
    const d = assessReportability(
      facts({
        incidentType: "injury",
        occurredAt: "2026-03-02T09:00:00.000Z",
        becameAwareAt: "2026-03-02T14:30:00.000Z",
        injuredPersonType: "employee",
        isFatality: true,
        fatalityOccurredAt: "2026-03-02T12:00:00.000Z",
      }),
      ["riddor", "osha"],
    );
    expect(rule(d, "riddor.fatality").deadline?.dueAt).toBe("2026-03-12T23:59:59.000Z");
    expect(rule(d, "osha.fatality_8h").deadline?.dueAt).toBe("2026-03-02T22:30:00.000Z");
    expect(d.reportDueAt).toBe("2026-03-02T22:30:00.000Z");
    expect(d.governingRuleId).toBe("osha.fatality_8h");
    expect(d.regimes.sort()).toEqual(["osha", "riddor"]);
    expect(d.riddorCategory).toBe("death");
    expect(d.oshaCaseType).toBe("death");
  });

  it("says a requested regime is not implemented rather than silently ignoring it", () => {
    const d = assessReportability(
      facts({ occurredAt: "2026-03-02T09:00:00.000Z", isFatality: true }),
      ["riddor", "eu_framework"],
    );
    expect(d.needsHumanReview).toBe(true);
    expect(d.reasons.join(" ")).toContain("eu_framework");
    expect(d.openQuestions.join(" ")).toContain("not implemented");
  });
});

describe("regime resolution", () => {
  it("maps GB to RIDDOR and US to OSHA", () => {
    expect(resolveRegimes(null, "GB").regimes).toEqual(["riddor"]);
    expect(resolveRegimes(null, "United Kingdom").regimes).toEqual(["riddor"]);
    expect(resolveRegimes(null, "US").regimes).toEqual(["osha"]);
  });

  it("lets an explicit list win over the project's country", () => {
    const r = resolveRegimes(["riddor", "osha"], "US");
    expect(r.regimes).toEqual(["riddor", "osha"]);
    expect(r.basis.join(" ")).toContain("supplied on the request");
  });

  it("assesses NOTHING when the jurisdiction is unknown, and says so in terms", () => {
    const r = resolveRegimes(null, null);
    expect(r.regimes).toEqual([]);
    expect(r.reasons.join(" ")).toContain("not the same as");
    const d = assessReportability(
      facts({ occurredAt: "2026-03-02T09:00:00.000Z", isFatality: true }),
      r.regimes,
    );
    expect(d.isReportable).toBe(false);
    expect(d.needsHumanReview).toBe(true);
    expect(d.assessedRegimes).toEqual([]);
    expect(d.riddorCategory).toBe("under_assessment");
    expect(d.oshaCaseType).toBe("under_assessment");
    expect(d.reasons.join(" ")).toContain("has not been assessed");
  });

  it("maps an unhandled country to no regime with a reason", () => {
    const r = resolveRegimes(null, "FR");
    expect(r.regimes).toEqual([]);
    expect(r.reasons.join(" ")).toContain("FR");
  });
});

describe("case classification and clock helpers", () => {
  it("classifies the 300 log case at its most severe outcome", () => {
    expect(classifyOshaCase(facts({ isFatality: true, isLostTime: true }))).toBe("death");
    expect(classifyOshaCase(facts({ lostTimeDays: 2, restrictedDutyDays: 5 }))).toBe(
      "days_away_from_work",
    );
    expect(classifyOshaCase(facts({ restrictedDutyDays: 5 }))).toBe("job_transfer_or_restriction");
    expect(classifyOshaCase(facts({ medicalTreatmentBeyondFirstAid: true }))).toBe("other_recordable");
    expect(classifyOshaCase(facts({ treatmentLevel: "first_aid" }))).toBe("not_recordable");
  });

  it("knows a deadline is missed only when it is actually passed", () => {
    const due = "2026-03-12T23:59:59.000Z";
    expect(isNotificationMissed(due, null, "2026-03-12T10:00:00.000Z")).toBe(false);
    expect(isNotificationMissed(due, null, "2026-03-13T00:00:01.000Z")).toBe(true);
    expect(isNotificationMissed(due, "2026-03-12T09:00:00.000Z", "2026-04-01T00:00:00.000Z")).toBe(false);
    expect(isNotificationMissed(due, "2026-03-13T09:00:00.000Z", "2026-04-01T00:00:00.000Z")).toBe(true);
    expect(isNotificationMissed(null, null, "2026-04-01T00:00:00.000Z")).toBe(false);
  });

  it("publishes a rule catalogue in which every rule carries a citation", () => {
    const cat = ruleCatalogue();
    const ids = cat.map((c) => c.ruleId);
    expect(ids).toContain("riddor.fatality");
    expect(ids).toContain("riddor.specified_injury");
    expect(ids).toContain("riddor.over_7_day");
    expect(ids).toContain("riddor.dangerous_occurrence");
    expect(ids).toContain("osha.fatality_8h");
    expect(ids).toContain("osha.inpatient_hospitalization_24h");
    expect(ids).toContain("osha.amputation_24h");
    expect(ids).toContain("osha.loss_of_eye_24h");
    expect(ids).toContain("osha.recordable_300_log");
    for (const c of cat) {
      expect(c.citation.length).toBeGreaterThan(30);
      expect(c.jurisdiction).toMatch(/^(GB|US)$/);
    }
  });

  it("carries a disclaimer on every determination", () => {
    const d = assessReportability(facts({ occurredAt: "2026-03-02T09:00:00.000Z" }), RIDDOR);
    expect(d.disclaimer).toContain("not legal advice");
  });
});
