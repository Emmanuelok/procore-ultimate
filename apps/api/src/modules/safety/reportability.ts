/**
 * SAFETY — STATUTORY REPORTABILITY (M21, spec Vol I §2.11).
 *
 * A regulator asks two questions and only two: was it reportable, and was it
 * reported in time. This file answers the first and computes the clock for
 * the second. Nothing here touches a database or a clock — the whole engine
 * is `(facts, regimes) => determination`, which is what makes it testable
 * against a hand-worked scenario per rule.
 *
 * FOUR DESIGN COMMITMENTS, each of which cost something:
 *
 *  1. REPORTABILITY IS A CLASSIFICATION, NOT A BOOLEAN. A single event can be
 *     reportable under two regimes on two different clocks running from two
 *     different start events. So the output is a list of rule determinations,
 *     each carrying its own citation, its own clock and its own deadline; the
 *     stored `reportDueAt` is the EARLIEST of them, because that is the one
 *     that bites first.
 *
 *  2. THE CLOCK START DIFFERS BY REGIME, AND GETTING IT WRONG IS THE WHOLE
 *     ERROR. RIDDOR counts from the ACCIDENT (reg. 4(2): "within 15 days of
 *     the accident"). OSHA counts from the employer LEARNING of it (29 CFR
 *     1904.39(a): "within eight hours after the death ... is reported to you
 *     or ... you learn about it"). An incident notified 20 hours after a
 *     fatality is inside neither clock or inside one of them depending on
 *     which you counted, so both are computed and both are shown.
 *
 *  3. AN AMBIGUOUS RULE SAYS SO. Where the statutory test turns on a fact the
 *     platform does not hold — was the hospital admission for treatment or
 *     for observation; was the treatment beyond first aid; was the event
 *     within RIDDOR Schedule 2 — the rule returns `indeterminate` with
 *     `needsHumanReview: true` and the question stated in `basis`. It does
 *     NOT guess. A false "not reportable" is a prosecution; a false
 *     "reportable" is a wasted notification and a loss of credibility with
 *     the regulator. Neither is worth a coin flip.
 *
 *  4. NOTHING HERE IS LEGAL ADVICE AND THE PAYLOAD SAYS SO. The engine
 *     narrows the question and starts the clock. A duty-holder decides.
 *
 * SOURCES the rules are drawn from, quoted in `citation` on every rule:
 *   - RIDDOR 2013 (SI 2013/1471), regs. 4-9 and Schedules 1-2; HSE guidance
 *     L150 (3rd ed.).
 *   - 29 CFR Part 1904 (OSHA recording and reporting of occupational
 *     injuries and illnesses), §§ 1904.4, 1904.7, 1904.29, 1904.31, 1904.39.
 */

import type {
  IncidentMechanism,
  IncidentType,
  InjuredPersonType,
  InjuryNature,
  InjuryTreatmentLevel,
  OshaCaseType,
  ReportableRegime,
  RiddorCategory,
} from "@constructos/shared";

/* ================================================================== */
/* Inputs                                                              */
/* ================================================================== */

/** How a hospital attendance is classified — the fact OSHA turns on. */
export const HOSPITAL_ADMISSIONS = [
  "none",
  "outpatient_or_ed_only",
  "inpatient_treatment",
  "inpatient_observation_only",
  "unknown",
] as const;
export type HospitalAdmission = (typeof HOSPITAL_ADMISSIONS)[number];

/**
 * The facts the rules read. Most map straight off `safety_incidents`; the
 * handful that do not are the assessment answers a competent person supplies
 * (`detail.reportabilityInputs`), and each of them exists because a statutory
 * test turns on it and the narrative cannot supply it.
 */
export interface IncidentFacts {
  incidentType: IncidentType;
  occurredAt: string;
  /** when the responsible person first knew — OSHA's clock start */
  becameAwareAt: string | null;
  injuredPersonType: InjuredPersonType | null;
  treatmentLevel: InjuryTreatmentLevel | null;
  injuryNature: InjuryNature | null;
  mechanism: IncidentMechanism | null;
  bodyPart: string | null;
  additionalBodyParts: string[];
  isFatality: boolean;
  /** when death occurred — OSHA reports only deaths within 30 days (1904.39(b)(6)) */
  fatalityOccurredAt: string | null;
  isLostTime: boolean;
  lostTimeDays: number | null;
  restrictedDutyDays: number | null;
  /* --- assessment answers, supplied by a competent person --- */
  hospitalAdmission: HospitalAdmission;
  /** when the person was admitted — OSHA's 24-hour proximity test */
  hospitalAdmittedAt: string | null;
  /** true/false/unknown: was the treatment beyond the 1904.7(b)(5)(ii) first-aid list */
  medicalTreatmentBeyondFirstAid: boolean | null;
  lossOfConsciousness: boolean | null;
  /** a permanent loss or reduction of sight, as opposed to a treated eye injury */
  permanentSightLoss: boolean | null;
  /** enucleation or equivalent — OSHA reports "loss of an eye", not eye injury */
  lossOfAnEye: boolean | null;
  /** burns over 10% of the body, or to eyes / respiratory system / vital organs */
  seriousBurn: boolean | null;
  /** the person was working in an enclosed space (RIDDOR Sch.1 para. 8) */
  enclosedSpace: boolean | null;
  /** asserted RIDDOR Schedule 2 class, e.g. "sch2_para_1_lifting_equipment" */
  dangerousOccurrenceClass: string | null;
  /** a written diagnosis has been received (RIDDOR reg. 8 precondition) */
  occupationalDiseaseDiagnosed: boolean | null;
  diagnosisReceivedAt: string | null;
  /** a reportable gas incident under RIDDOR reg. 9 */
  gasIncident: boolean | null;
  /** the injured worker is under our day-to-day control (OSHA 1904.31(b)(2)) */
  underOurDayToDayControl: boolean | null;
  /** the days-off count is still running, so the current total is a floor */
  incapacityStillAccruing: boolean;
  /** the event arose out of or in connection with work (RIDDOR reg. 2; 1904.5) */
  workRelated: boolean | null;
}

export type RuleOutcome = "met" | "not_met" | "indeterminate";

export interface RuleDeadline {
  /** the instant the report is due, ISO-8601 UTC */
  dueAt: string;
  clockStartsAt: string;
  /** prose: what event started the clock */
  clockStartsFrom: string;
  withinHours: number;
  withinLabel: string;
  /** a telephone / quickest-practicable-means notification is due first */
  immediateNotificationRequired: boolean;
  notificationMethod: string;
}

export interface RuleDetermination {
  ruleId: string;
  regime: ReportableRegime;
  jurisdiction: string;
  /** the enforcing authority the notification goes to */
  authority: string;
  title: string;
  citation: string;
  outcome: RuleOutcome;
  /** every fact the rule read and what it concluded from it, in prose */
  basis: string[];
  needsHumanReview: boolean;
  /** the question a human must answer, when there is one */
  openQuestion: string | null;
  /** null unless the rule is met and a clock start is available */
  deadline: RuleDeadline | null;
  /** this rule is a RECORDING duty, not a notification to the authority */
  isRecordingDutyOnly: boolean;
  riddorCategory: RiddorCategory | null;
  oshaCaseType: OshaCaseType | null;
  consequenceIfMissed: string;
}

export interface ReportabilityDetermination {
  /** true only when at least one rule is `met` */
  isReportable: boolean;
  /** at least one rule could not be decided on the facts held */
  needsHumanReview: boolean;
  /** regimes with at least one met rule — what goes in `reportableRegimes` */
  regimes: ReportableRegime[];
  /** regimes actually assessed (a regime with no met rule is still assessed) */
  assessedRegimes: ReportableRegime[];
  riddorCategory: RiddorCategory;
  oshaCaseType: OshaCaseType;
  /** earliest notification deadline across met rules — the stored reportDueAt */
  reportDueAt: string | null;
  /** the rule that produced reportDueAt */
  governingRuleId: string | null;
  rules: RuleDetermination[];
  metRuleIds: string[];
  indeterminateRuleIds: string[];
  /** what a human must resolve before the classification can be relied on */
  openQuestions: string[];
  /** why reportDueAt is null, when it is */
  reasons: string[];
  disclaimer: string;
}

const DISCLAIMER =
  "This determination narrows the statutory question and starts the clock. It is not legal advice " +
  "and it does not discharge the duty-holder's own judgement: the responsible person under RIDDOR " +
  "and the employer under 29 CFR 1904 remain accountable for the classification and for the report.";

/* ================================================================== */
/* Jurisdiction → regime                                               */
/* ================================================================== */

const UK_COUNTRY_CODES = new Set([
  "GB",
  "UK",
  "GBR",
  "UNITED KINGDOM",
  "GREAT BRITAIN",
  "ENGLAND",
  "SCOTLAND",
  "WALES",
]);

const US_COUNTRY_CODES = new Set(["US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA"]);

export interface RegimeResolution {
  regimes: ReportableRegime[];
  basis: string[];
  reasons: string[];
}

/**
 * Which regimes apply. An explicit list on the request always wins — a UK
 * site with a US parent reports under both and only a human knows that.
 * Failing that, the project's country. Failing THAT, nothing is assessed and
 * the caller is told why, because a determination of "not reportable" made
 * without knowing the jurisdiction is worthless and dangerous.
 */
export function resolveRegimes(
  explicit: readonly string[] | null | undefined,
  projectCountry: string | null | undefined,
): RegimeResolution {
  const named = (explicit ?? []).filter((r) => r !== "none");
  if (named.length > 0) {
    return {
      regimes: named as ReportableRegime[],
      basis: [`Regimes supplied on the request: ${named.join(", ")}.`],
      reasons: [],
    };
  }
  const country = (projectCountry ?? "").trim().toUpperCase();
  if (UK_COUNTRY_CODES.has(country)) {
    return {
      regimes: ["riddor"],
      basis: [`Project country \`${projectCountry}\` resolves to the RIDDOR 2013 regime (GB).`],
      reasons: [],
    };
  }
  if (US_COUNTRY_CODES.has(country)) {
    return {
      regimes: ["osha"],
      basis: [`Project country \`${projectCountry}\` resolves to the 29 CFR Part 1904 regime (US).`],
      reasons: [],
    };
  }
  return {
    regimes: [],
    basis: [],
    reasons: [
      country
        ? `Project country \`${projectCountry}\` maps to no reporting regime this engine implements ` +
          `(RIDDOR and OSHA are implemented). Supply \`regimes\` explicitly, or record the ` +
          `classification by hand — a "not reportable" produced without a jurisdiction is not a finding.`
        : "The project has no country recorded and no regimes were supplied, so no reporting regime " +
          "could be selected. Reportability has NOT been assessed — this is not the same as " +
          "\"not reportable\".",
    ],
  };
}

/* ================================================================== */
/* Time                                                                */
/* ================================================================== */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function addHours(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * HOUR_MS).toISOString();
}

/**
 * A day-counted statutory deadline. RIDDOR's "within 10 days of the accident"
 * is counted in calendar days from the day of the accident and expires at the
 * end of the tenth day — not at the same clock time ten days later. Landing
 * the deadline at 23:59:59Z on the due date is the reading that matches the
 * HSE's own online form behaviour and is the one that gives the duty-holder
 * the whole of the final day.
 */
function endOfDayAfterDays(iso: string, days: number): string {
  const d = new Date(Date.parse(iso) + days * DAY_MS);
  return `${d.toISOString().slice(0, 10)}T23:59:59.000Z`;
}

function hoursBetween(a: string, b: string): number | null {
  const s = Date.parse(a);
  const e = Date.parse(b);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  return (e - s) / HOUR_MS;
}

/* ================================================================== */
/* Fact helpers                                                        */
/* ================================================================== */

/** Person types that are "workers" for RIDDOR regs. 4 and 6(1). */
const RIDDOR_WORKER_TYPES: ReadonlySet<string> = new Set([
  "employee",
  "subcontractor",
  "agency",
  "self_employed",
  "trainee",
]);

/** Person types that are non-workers for RIDDOR reg. 5. */
const RIDDOR_NON_WORKER_TYPES: ReadonlySet<string> = new Set([
  "visitor",
  "delivery_driver",
  "member_of_public",
  "client_representative",
]);

/** Person types OSHA recordkeeping covers (1904.31: payroll + supervised). */
const OSHA_COVERED_TYPES: ReadonlySet<string> = new Set([
  "employee",
  "agency",
  "trainee",
  "subcontractor",
]);

/** Fractures to these parts are excluded from RIDDOR Schedule 1 para. 1. */
const SCHEDULE_1_FRACTURE_EXCLUSIONS: ReadonlySet<string> = new Set(["finger", "toe"]);

/**
 * The RIDDOR Schedule 2 classes this engine can recognise by name. A class
 * asserted from this list is treated as established; anything else is an
 * assertion the engine records but does not vouch for.
 */
export const RIDDOR_SCHEDULE_2_CLASSES: Record<string, string> = {
  sch2_para_1_lifting_equipment:
    "Para. 1 — collapse, overturning or failure of load-bearing parts of lifting equipment",
  sch2_para_2_pressure_systems: "Para. 2 — failure of a pressure system releasing its contents",
  sch2_para_3_overhead_electric_lines:
    "Para. 3 — plant coming into contact with an overhead electric line above 200 volts",
  sch2_para_4_electrical_short_circuit:
    "Para. 4 — electrical short circuit or overload causing fire or explosion",
  sch2_para_5_explosives: "Para. 5 — explosives incidents",
  sch2_para_6_biological_agents: "Para. 6 — unintentional release of a biological agent",
  sch2_para_7_radiation_generators: "Para. 7 — malfunction of a radiation generator",
  sch2_para_8_breathing_apparatus: "Para. 8 — malfunction of breathing apparatus",
  sch2_para_9_diving: "Para. 9 — diving operations incidents",
  sch2_para_10_collapse_of_scaffolding:
    "Para. 10 — the complete or partial collapse of scaffolding over 5 metres high, or erected over water",
  sch2_para_11_train_collision: "Para. 11 — train collisions",
  sch2_para_12_wells: "Para. 12 — incidents at wells",
  sch2_para_13_pipelines: "Para. 13 — pipeline incidents",
  sch2_para_14_structural_collapse:
    "Para. 14 — the unintentional collapse of a structure, or of any floor or wall of a building under construction, alteration or demolition involving more than 5 tonnes of material",
  sch2_para_15_explosion_or_fire:
    "Para. 15 — an explosion or fire resulting in the suspension of normal work for more than 24 hours",
  sch2_para_16_release_of_flammable_substance:
    "Para. 16 — the sudden and uncontrolled release of a flammable liquid or gas",
  sch2_para_17_hazardous_escape:
    "Para. 17 — the accidental release of a substance that could damage health",
};

/**
 * Incident types that USUALLY sit inside Schedule 2 but cannot be confirmed
 * from the type alone — Schedule 2 is a closed list with thresholds (5 metres
 * of scaffold, 5 tonnes of structure, 24 hours of suspended work) and a
 * narrative does not carry them.
 */
const SCHEDULE_2_CANDIDATES: Partial<Record<IncidentType, string>> = {
  structural_failure: "sch2_para_14_structural_collapse",
  utility_strike: "sch2_para_3_overhead_electric_lines",
  fire: "sch2_para_15_explosion_or_fire",
};

/**
 * Whether the event involves an injured person at all. A near miss, a
 * property-damage event or a dangerous occurrence has none, and the rules
 * that turn on WHO was hurt must say "not applicable" rather than "establish
 * the relationship of the injured person" — noise in a determination is not
 * free, it trains the reader to skip the flags that matter.
 */
function hasInjuredPerson(f: IncidentFacts): boolean {
  return (
    f.injuredPersonType != null ||
    f.isFatality ||
    f.isLostTime ||
    f.treatmentLevel != null ||
    f.injuryNature != null ||
    f.bodyPart != null ||
    (f.lostTimeDays ?? 0) > 0 ||
    (f.restrictedDutyDays ?? 0) > 0 ||
    f.hospitalAdmission === "inpatient_treatment" ||
    f.hospitalAdmission === "inpatient_observation_only"
  );
}

/** Total days the person could not do their normal work. */
function incapacityDays(f: IncidentFacts): { days: number | null; inferredFromBoth: boolean } {
  const lost = f.lostTimeDays;
  const restricted = f.restrictedDutyDays;
  if (lost == null && restricted == null) return { days: null, inferredFromBoth: false };
  const total = (lost ?? 0) + (restricted ?? 0);
  return { days: total, inferredFromBoth: (lost ?? 0) > 0 && (restricted ?? 0) > 0 };
}

function awareAt(f: IncidentFacts): string {
  return f.becameAwareAt ?? f.occurredAt;
}

/* ================================================================== */
/* RIDDOR rules                                                        */
/* ================================================================== */

const HSE = "the Health and Safety Executive (or the local authority where it is the enforcing authority)";

function riddorRule(partial: Partial<RuleDetermination> & { ruleId: string; title: string; citation: string }): RuleDetermination {
  return {
    regime: "riddor",
    jurisdiction: "GB",
    authority: HSE,
    outcome: "not_met",
    basis: [],
    needsHumanReview: false,
    openQuestion: null,
    deadline: null,
    isRecordingDutyOnly: false,
    riddorCategory: null,
    oshaCaseType: null,
    consequenceIfMissed:
      "Failure to report is a criminal offence under s.33 of the Health and Safety at Work etc. Act 1974.",
    ...partial,
  } as RuleDetermination;
}

/** RIDDOR reg. 6 — the death of any person from a work-related accident. */
function ruleRiddorFatality(f: IncidentFacts): RuleDetermination {
  const r = riddorRule({
    ruleId: "riddor.fatality",
    title: "Work-related fatality",
    citation:
      "RIDDOR 2013 (SI 2013/1471) reg. 6 — reporting the death of any person; reg. 6(3) reporting procedure. Notify without delay by the quickest practicable means; report within 10 days.",
    riddorCategory: "death",
    consequenceIfMissed:
      "A fatality not notified without delay is the first thing an inspector establishes on arrival. " +
      "Late notification of a death is prosecuted as a matter of course under s.33(1)(c) HSWA 1974, " +
      "independently of any charge arising from the accident itself, and it removes any prospect of " +
      "the regulator accepting that the site's systems were under control.",
  });
  if (!f.isFatality && f.treatmentLevel !== "fatality") {
    r.basis.push("No fatality is recorded on the incident (isFatality is false, treatment level is not `fatality`).");
    return r;
  }
  r.outcome = "met";
  r.basis.push(
    f.isFatality
      ? "The incident records a fatality."
      : "The treatment level is recorded as `fatality`.",
    "RIDDOR reg. 6 applies to the death of ANY person — worker or not — where it arises from a work-related accident, so no worker/non-worker test is applied.",
  );
  if (f.workRelated === false) {
    r.outcome = "indeterminate";
    r.needsHumanReview = true;
    r.openQuestion =
      "The incident is flagged as not work-related. RIDDOR reg. 6 bites only on a death arising out of or in connection with work — confirm the work-relatedness before standing down the notification.";
    r.basis.push("Work-relatedness is recorded as false, which would take the death outside reg. 6.");
    return r;
  }
  r.deadline = {
    dueAt: endOfDayAfterDays(f.occurredAt, 10),
    clockStartsAt: f.occurredAt,
    clockStartsFrom: "the accident",
    withinHours: 240,
    withinLabel: "10 days",
    immediateNotificationRequired: true,
    notificationMethod:
      "Notify by the quickest practicable means without delay (HSE Incident Contact Centre, 0345 300 9923), then submit form F2508 within 10 days.",
  };
  return r;
}

/** RIDDOR reg. 4(1) + Schedule 1 — specified injuries to workers. */
function ruleRiddorSpecifiedInjury(f: IncidentFacts): RuleDetermination {
  const r = riddorRule({
    ruleId: "riddor.specified_injury",
    title: "Specified injury to a worker",
    citation:
      "RIDDOR 2013 reg. 4(1) and Schedule 1 (specified injuries). Notify without delay by the quickest practicable means; report within 10 days of the accident.",
    riddorCategory: "specified_injury",
  });
  if (!hasInjuredPerson(f)) {
    r.basis.push("No injured person is recorded — reg. 4 concerns injuries to workers.");
    return r;
  }
  const personType = f.injuredPersonType ?? "unknown";
  if (!RIDDOR_WORKER_TYPES.has(personType)) {
    r.basis.push(
      `The injured person is recorded as \`${personType}\`, which is not a worker for reg. 4 — reg. 5 (non-workers) is the relevant rule.`,
    );
    if (personType === "unknown") {
      r.outcome = "indeterminate";
      r.needsHumanReview = true;
      r.openQuestion =
        "The injured person's relationship to the works is `unknown`. Reg. 4 (workers) and reg. 5 (non-workers) impose different duties on different facts — establish the relationship.";
    }
    return r;
  }

  const matches: string[] = [];
  const open: string[] = [];

  if (f.injuryNature === "amputation") {
    matches.push("Schedule 1 para. 2 — amputation of an arm, hand, finger, thumb, leg, foot or toe.");
  }
  if (f.injuryNature === "fracture") {
    const part = (f.bodyPart ?? "").toLowerCase();
    if (SCHEDULE_1_FRACTURE_EXCLUSIONS.has(part)) {
      r.basis.push(
        `A fracture to the ${part} is expressly excluded from Schedule 1 para. 1 (fractures other than to fingers, thumbs or toes).`,
      );
    } else if (part === "" || part === "multiple" || part === "not_applicable") {
      open.push(
        "A fracture is recorded but the body part is not, and Schedule 1 para. 1 excludes fractures to fingers, thumbs and toes. Record the body part.",
      );
    } else {
      matches.push(`Schedule 1 para. 1 — a fracture (${part}), other than to fingers, thumbs or toes.`);
    }
  }
  if (f.injuryNature === "crush") {
    const part = (f.bodyPart ?? "").toLowerCase();
    if (["head", "chest", "abdomen", "internal", "multiple"].includes(part)) {
      matches.push(
        "Schedule 1 para. 5 — a crush injury to the head or torso causing damage to the brain or internal organs.",
      );
    } else {
      open.push(
        "A crush injury is recorded but Schedule 1 para. 5 is limited to crushing of the head or torso causing damage to the brain or internal organs — confirm the site and the organ damage.",
      );
    }
  }
  if (f.injuryNature === "burn_thermal" || f.injuryNature === "burn_chemical") {
    if (f.seriousBurn === true) {
      matches.push(
        "Schedule 1 para. 6 — a serious burn covering more than 10% of the body, or damaging the eyes, respiratory system or other vital organs.",
      );
    } else if (f.seriousBurn === null) {
      open.push(
        "A burn is recorded but Schedule 1 para. 6 turns on its extent (more than 10% of the body) or on damage to eyes, respiratory system or other vital organs. Neither is recorded — answer `seriousBurn`.",
      );
    } else {
      r.basis.push("The burn is recorded as not meeting the Schedule 1 para. 6 extent or site test.");
    }
  }
  if (f.permanentSightLoss === true) {
    matches.push("Schedule 1 para. 3 — any injury likely to lead to permanent blinding or reduction in sight.");
  } else if (
    f.permanentSightLoss === null &&
    ((f.bodyPart ?? "") === "eye" || f.additionalBodyParts.includes("eye"))
  ) {
    open.push(
      "An eye injury is recorded. Schedule 1 para. 3 covers injuries likely to lead to permanent blinding or a permanent reduction in sight, which a treated foreign body is not — answer `permanentSightLoss`.",
    );
  }
  if (f.lossOfConsciousness === true) {
    const byHeadOrAsphyxia =
      (f.bodyPart ?? "") === "head" ||
      f.injuryNature === "asphyxiation" ||
      f.injuryNature === "concussion";
    if (byHeadOrAsphyxia) {
      matches.push("Schedule 1 para. 7 — loss of consciousness caused by head injury or asphyxia.");
    } else {
      open.push(
        "Loss of consciousness is recorded, but Schedule 1 para. 7 is limited to loss of consciousness caused by head injury or asphyxia — establish the cause (a faint from pain is not within para. 7).",
      );
    }
  }
  if (f.enclosedSpace === true && (f.hospitalAdmission === "inpatient_treatment" || f.injuryNature === "asphyxiation" || f.injuryNature === "heat_illness" || f.injuryNature === "hypothermia")) {
    matches.push(
      "Schedule 1 para. 8 — an injury from working in an enclosed space leading to hypothermia or heat-induced illness, or requiring resuscitation or admittance to hospital for more than 24 hours.",
    );
  }
  if (f.injuryNature === "other" && f.treatmentLevel === "hospitalised" && matches.length === 0 && open.length === 0) {
    open.push(
      "The injury nature is `other` and the person was hospitalised. Schedule 1 is a closed list of eight paragraphs — check the injury against it directly rather than relying on the coded nature.",
    );
  }

  if (matches.length > 0) {
    r.outcome = "met";
    r.basis.push(...matches);
    r.deadline = {
      dueAt: endOfDayAfterDays(f.occurredAt, 10),
      clockStartsAt: f.occurredAt,
      clockStartsFrom: "the accident",
      withinHours: 240,
      withinLabel: "10 days",
      immediateNotificationRequired: true,
      notificationMethod:
        "Notify by the quickest practicable means without delay, then submit form F2508 within 10 days of the accident.",
    };
    if (open.length > 0) {
      r.needsHumanReview = true;
      r.openQuestion = open.join(" ");
      r.basis.push(...open);
    }
    return r;
  }
  if (open.length > 0) {
    r.outcome = "indeterminate";
    r.needsHumanReview = true;
    r.openQuestion = open.join(" ");
    r.basis.push(...open);
    return r;
  }
  r.basis.push(
    `The recorded injury (nature \`${f.injuryNature ?? "not recorded"}\`, body part \`${f.bodyPart ?? "not recorded"}\`) matches no paragraph of Schedule 1.`,
  );
  return r;
}

/** RIDDOR reg. 4(2) — over-seven-day incapacitation of a worker. */
function ruleRiddorOverSevenDay(f: IncidentFacts): RuleDetermination {
  const r = riddorRule({
    ruleId: "riddor.over_7_day",
    title: "Over-seven-day incapacitation of a worker",
    citation:
      "RIDDOR 2013 reg. 4(2) — a worker incapacitated for more than seven consecutive days (excluding the day of the accident but including rest days). Report within 15 days of the accident.",
    riddorCategory: "over_7_day_incapacitation",
    consequenceIfMissed:
      "The 15-day report is the one most often missed, because the seventh day falls a week after " +
      "everyone has moved on. It is nonetheless a criminal offence to omit, and the omission is " +
      "trivially provable from the payroll record the inspector will ask for.",
  });
  const personType = f.injuredPersonType ?? "unknown";
  if (!RIDDOR_WORKER_TYPES.has(personType)) {
    r.basis.push(`Reg. 4(2) applies to workers; the injured person is recorded as \`${personType}\`.`);
    return r;
  }
  const { days, inferredFromBoth } = incapacityDays(f);
  if (days == null) {
    if (f.isLostTime || f.treatmentLevel === "medical_treatment" || f.treatmentLevel === "hospitalised") {
      r.outcome = "indeterminate";
      r.needsHumanReview = true;
      r.openQuestion =
        "The injury took the worker off normal duties but no day count is recorded. Reg. 4(2) turns entirely on whether that ran to MORE than seven consecutive days — record the days lost and the days on restricted duty, and reassess.";
      r.basis.push("Lost-time and restricted-duty day counts are both absent.");
      return r;
    }
    r.basis.push("No incapacity is recorded (no lost time, no restricted duty).");
    return r;
  }
  r.basis.push(
    `Incapacity of ${days} day(s) — ${f.lostTimeDays ?? 0} day(s) lost plus ${f.restrictedDutyDays ?? 0} day(s) on restricted duty. ` +
      "Reg. 4(2) counts days on which the worker could not do the full range of their normal duties, so restricted duty counts.",
  );
  if (days > 7) {
    r.outcome = "met";
    r.deadline = {
      dueAt: endOfDayAfterDays(f.occurredAt, 15),
      clockStartsAt: f.occurredAt,
      clockStartsFrom: "the accident",
      withinHours: 360,
      withinLabel: "15 days",
      immediateNotificationRequired: false,
      notificationMethod: "Submit form F2508 within 15 days of the accident. No immediate telephone notification is required for a reg. 4(2) report.",
    };
    if (inferredFromBoth) {
      r.needsHumanReview = true;
      r.openQuestion =
        "The seven-day threshold was crossed by ADDING lost-time days to restricted-duty days. Reg. 4(2) requires the incapacity to be CONSECUTIVE — confirm the two periods ran back to back before relying on the classification.";
      r.basis.push(r.openQuestion);
    }
    return r;
  }
  if (f.incapacityStillAccruing) {
    r.outcome = "indeterminate";
    r.needsHumanReview = true;
    r.openQuestion =
      `Incapacity currently stands at ${days} day(s) and is still running. The reg. 4(2) threshold is more than seven consecutive days — reassess once the worker returns to full duties. The 15-day clock runs from the accident, not from the seventh day, so it is already running.`;
    r.basis.push("The day count is a floor, not a final figure — the worker has not returned to full duties.");
    return r;
  }
  r.basis.push(`${days} day(s) does not exceed the seven-day threshold in reg. 4(2).`);
  return r;
}

/** RIDDOR reg. 12 — the over-three-day RECORDING duty (not a report). */
function ruleRiddorOverThreeDayRecord(f: IncidentFacts): RuleDetermination {
  const r = riddorRule({
    ruleId: "riddor.over_3_day_record",
    title: "Over-three-day incapacitation — record only",
    citation:
      "RIDDOR 2013 reg. 12(1)(b) — an accident incapacitating a worker for more than three consecutive days must be RECORDED. It is not reportable unless it also runs past seven days (reg. 4(2)).",
    riddorCategory: "over_3_day_recordable",
    isRecordingDutyOnly: true,
    consequenceIfMissed:
      "No notification is due, but the record must exist and must be kept. Its absence is what turns " +
      "a late reg. 4(2) report into an allegation that the site was not counting at all.",
  });
  const personType = f.injuredPersonType ?? "unknown";
  if (!RIDDOR_WORKER_TYPES.has(personType)) {
    r.basis.push(`Reg. 12 applies to workers; the injured person is recorded as \`${personType}\`.`);
    return r;
  }
  const { days } = incapacityDays(f);
  if (days == null) {
    r.basis.push("No incapacity day count is recorded.");
    return r;
  }
  if (days > 3) {
    r.outcome = "met";
    r.basis.push(
      `Incapacity of ${days} day(s) exceeds three consecutive days, so the accident must be recorded under reg. 12. `,
      "This is a RECORDING duty. No statutory notification deadline attaches to it and none is raised.",
    );
    return r;
  }
  r.basis.push(`${days} day(s) does not exceed the three-day recording threshold.`);
  return r;
}

/** RIDDOR reg. 8 and Schedule 2 — dangerous occurrences. */
function ruleRiddorDangerousOccurrence(f: IncidentFacts): RuleDetermination {
  const r = riddorRule({
    ruleId: "riddor.dangerous_occurrence",
    title: "Dangerous occurrence",
    citation:
      "RIDDOR 2013 reg. 8 and Schedule 2 (27 classes of dangerous occurrence). Notify without delay by the quickest practicable means; report within 10 days.",
    riddorCategory: "dangerous_occurrence",
    consequenceIfMissed:
      "A dangerous occurrence is a near miss with the energy of a fatality behind it. Not reporting " +
      "one removes the single best argument a duty-holder has after the next event — that the " +
      "precursor was recognised and acted on.",
  });
  const asserted = f.dangerousOccurrenceClass;
  if (asserted && RIDDOR_SCHEDULE_2_CLASSES[asserted]) {
    r.outcome = "met";
    r.basis.push(
      `Schedule 2 class asserted: ${RIDDOR_SCHEDULE_2_CLASSES[asserted]}.`,
      "The class was matched against this engine's Schedule 2 catalogue, not inferred from the narrative.",
    );
    r.deadline = {
      dueAt: endOfDayAfterDays(f.occurredAt, 10),
      clockStartsAt: f.occurredAt,
      clockStartsFrom: "the dangerous occurrence",
      withinHours: 240,
      withinLabel: "10 days",
      immediateNotificationRequired: true,
      notificationMethod:
        "Notify by the quickest practicable means without delay, then submit form F2508 within 10 days.",
    };
    return r;
  }
  if (asserted) {
    r.outcome = "indeterminate";
    r.needsHumanReview = true;
    r.openQuestion = `The class \`${asserted}\` is not one this engine recognises. Confirm it against Schedule 2 directly; a class outside the closed list of 27 is not a dangerous occurrence however serious the event.`;
    r.basis.push(r.openQuestion);
    return r;
  }
  const candidate =
    f.incidentType === "dangerous_occurrence"
      ? null
      : (SCHEDULE_2_CANDIDATES[f.incidentType] ?? null);
  if (f.incidentType === "dangerous_occurrence" || candidate) {
    r.outcome = "indeterminate";
    r.needsHumanReview = true;
    r.openQuestion = candidate
      ? `An incident of type \`${f.incidentType}\` commonly falls within ${RIDDOR_SCHEDULE_2_CLASSES[candidate]}, but every Schedule 2 class carries a threshold (5 metres of scaffold, 5 tonnes of structure, 24 hours of suspended work) that a narrative does not carry. Confirm the class and assert it, or record that none applies.`
      : "The incident is typed as a dangerous occurrence but no Schedule 2 class has been asserted. Schedule 2 is a closed list of 27 classes with numeric thresholds; the engine will not infer one. Assert the class or record that none applies.";
    r.basis.push(r.openQuestion);
    return r;
  }
  r.basis.push(
    `Incident type \`${f.incidentType}\` is not typed as a dangerous occurrence and no Schedule 2 class has been asserted.`,
  );
  return r;
}

/** RIDDOR reg. 5 — a non-worker taken from the site to hospital for treatment. */
function ruleRiddorNonWorkerHospital(f: IncidentFacts): RuleDetermination {
  const r = riddorRule({
    ruleId: "riddor.non_worker_hospital",
    title: "Injury to a non-worker taken to hospital for treatment",
    citation:
      "RIDDOR 2013 reg. 5 — an accident in connection with work causing injury to a person who is not at work, where that person is taken from the site to hospital for treatment. Notify without delay; report within 10 days.",
    consequenceIfMissed:
      "Reg. 5 is the rule sites forget, because the injured person is not on the books and leaves in " +
      "an ambulance before anyone thinks of the register. It is the rule most often found breached " +
      "after a public-impact event.",
  });
  const personType = f.injuredPersonType ?? "unknown";
  if (!RIDDOR_NON_WORKER_TYPES.has(personType)) {
    r.basis.push(`Reg. 5 applies to persons not at work; the injured person is recorded as \`${personType}\`.`);
    return r;
  }
  const wentToHospital =
    f.treatmentLevel === "hospitalised" ||
    f.treatmentLevel === "emergency_department" ||
    f.hospitalAdmission === "inpatient_treatment" ||
    f.hospitalAdmission === "inpatient_observation_only" ||
    f.hospitalAdmission === "outpatient_or_ed_only";
  if (!wentToHospital) {
    r.basis.push(
      `The non-worker's treatment level is \`${f.treatmentLevel ?? "not recorded"}\` — reg. 5 bites only where the person is taken from the site to hospital for treatment.`,
    );
    if (f.treatmentLevel == null) {
      r.outcome = "indeterminate";
      r.needsHumanReview = true;
      r.openQuestion =
        "A non-worker was injured but no treatment level is recorded. Reg. 5 turns on whether they were taken from the site to hospital for treatment — establish it.";
    }
    return r;
  }
  r.outcome = "met";
  r.basis.push(
    `A \`${personType}\` was injured and taken to hospital (treatment level \`${f.treatmentLevel ?? "unrecorded"}\`, admission \`${f.hospitalAdmission}\`).`,
  );
  r.deadline = {
    dueAt: endOfDayAfterDays(f.occurredAt, 10),
    clockStartsAt: f.occurredAt,
    clockStartsFrom: "the accident",
    withinHours: 240,
    withinLabel: "10 days",
    immediateNotificationRequired: true,
    notificationMethod:
      "Notify by the quickest practicable means without delay, then submit form F2508 within 10 days.",
  };
  if (f.hospitalAdmission === "outpatient_or_ed_only" || f.treatmentLevel === "emergency_department") {
    r.needsHumanReview = true;
    r.openQuestion =
      "Reg. 5 requires the person to have been taken to hospital FOR TREATMENT. An attendance for examination or precautionary check with no treatment given is outside the rule — confirm treatment was given before or in place of relying on this determination.";
    r.basis.push(r.openQuestion);
  }
  return r;
}

/** RIDDOR reg. 8 — occupational disease on written diagnosis. */
function ruleRiddorOccupationalDisease(f: IncidentFacts): RuleDetermination {
  const r = riddorRule({
    ruleId: "riddor.occupational_disease",
    title: "Diagnosed occupational disease",
    citation:
      "RIDDOR 2013 reg. 8 — reportable on the responsible person receiving a written diagnosis of one of the listed diseases (carpal tunnel syndrome, cramp of the hand or forearm, occupational dermatitis, hand-arm vibration syndrome, occupational asthma, tendonitis of the hand or forearm, occupational cancer, and disease attributable to a biological agent) linked to the specified work activity. Report without delay.",
    riddorCategory: "occupational_disease",
  });
  if (f.incidentType !== "occupational_illness") {
    r.basis.push(`Incident type \`${f.incidentType}\` is not an occupational illness.`);
    return r;
  }
  if (f.occupationalDiseaseDiagnosed !== true) {
    r.outcome = "indeterminate";
    r.needsHumanReview = true;
    r.openQuestion =
      "An occupational illness is recorded but no WRITTEN diagnosis is recorded. Reg. 8 is triggered by the responsible person receiving a written diagnosis, and until then no duty to report has arisen — obtain and record the diagnosis.";
    r.basis.push(r.openQuestion);
    return r;
  }
  const clockStart = f.diagnosisReceivedAt ?? awareAt(f);
  r.outcome = "met";
  r.needsHumanReview = true;
  r.openQuestion =
    "Reg. 8 lists eight diseases and links each to a specified work activity. This engine cannot match a coded injury nature to that list — a competent person must confirm both the disease and the activity before the report is submitted.";
  r.basis.push(
    "A written diagnosis has been recorded, which is what starts the reg. 8 duty.",
    r.openQuestion,
  );
  r.deadline = {
    dueAt: clockStart,
    clockStartsAt: clockStart,
    clockStartsFrom: "receipt of the written diagnosis",
    withinHours: 0,
    withinLabel: "without delay",
    immediateNotificationRequired: true,
    notificationMethod: "Submit form F2508A without delay on receipt of the diagnosis.",
  };
  return r;
}

/** RIDDOR reg. 9 — gas incidents. */
function ruleRiddorGasIncident(f: IncidentFacts): RuleDetermination {
  const r = riddorRule({
    ruleId: "riddor.gas_incident",
    title: "Reportable gas incident",
    citation:
      "RIDDOR 2013 reg. 9 — death, loss of consciousness or hospital treatment arising from flammable gas distributed through a fixed pipe system or in a refillable container. Report within 14 days.",
    riddorCategory: "gas_incident",
  });
  if (f.gasIncident !== true) {
    r.basis.push("The incident is not flagged as a reg. 9 gas incident.");
    return r;
  }
  r.outcome = "met";
  r.basis.push("The incident is asserted to be a reg. 9 gas incident.");
  r.deadline = {
    dueAt: endOfDayAfterDays(f.occurredAt, 14),
    clockStartsAt: f.occurredAt,
    clockStartsFrom: "the incident",
    withinHours: 336,
    withinLabel: "14 days",
    immediateNotificationRequired: false,
    notificationMethod: "Submit form F2508G within 14 days.",
  };
  return r;
}

/* ================================================================== */
/* OSHA rules                                                          */
/* ================================================================== */

const OSHA_AUTHORITY =
  "the Occupational Safety and Health Administration (area office, 1-800-321-OSHA, or the online reporting application)";

function oshaRule(partial: Partial<RuleDetermination> & { ruleId: string; title: string; citation: string }): RuleDetermination {
  return {
    regime: "osha",
    jurisdiction: "US",
    authority: OSHA_AUTHORITY,
    outcome: "not_met",
    basis: [],
    needsHumanReview: false,
    openQuestion: null,
    deadline: null,
    isRecordingDutyOnly: false,
    riddorCategory: null,
    oshaCaseType: null,
    consequenceIfMissed:
      "Failure to report within the stated window is a citable violation of 29 CFR 1904.39 and is " +
      "routinely cited as other-than-serious or, where the omission is knowing, as wilful.",
    ...partial,
  } as RuleDetermination;
}

/**
 * Coverage gate shared by the OSHA rules. 1904.31 puts temporary workers on
 * the HOST employer's log where the host supervises them day to day, which is
 * exactly the construction case and exactly the fact a platform cannot infer.
 */
function oshaCoverage(f: IncidentFacts): { covered: boolean; basis: string; review: string | null } {
  if (!hasInjuredPerson(f)) {
    return {
      covered: false,
      basis:
        "No injured person is recorded. Part 1904 concerns injuries and illnesses to employees, so " +
        "nothing in it is engaged by an event with no casualty.",
      review: null,
    };
  }
  const personType = f.injuredPersonType ?? "unknown";
  if (personType === "member_of_public" || personType === "visitor" || personType === "client_representative") {
    return {
      covered: false,
      basis: `29 CFR 1904.31 covers employees on the payroll and workers supervised day to day; a \`${personType}\` is neither.`,
      review: null,
    };
  }
  if (personType === "unknown") {
    return {
      covered: false,
      basis: "The injured person's relationship to the works is `unknown`, so 1904.31 coverage cannot be established.",
      review:
        "Establish whether the injured person was on the payroll or supervised day to day — 1904.31 coverage turns on it.",
    };
  }
  if (!OSHA_COVERED_TYPES.has(personType)) {
    return {
      covered: false,
      basis: `A \`${personType}\` is not ordinarily on the host employer's OSHA log.`,
      review: null,
    };
  }
  if ((personType === "agency" || personType === "subcontractor") && f.underOurDayToDayControl == null) {
    return {
      covered: true,
      basis: `The injured person is recorded as \`${personType}\`.`,
      review:
        "29 CFR 1904.31(b)(2) puts a temporary or supplied worker on the log of whichever employer supervises them day to day. That fact is not recorded — establish it, because recording the case on the wrong log is itself a recordkeeping violation.",
    };
  }
  if ((personType === "agency" || personType === "subcontractor") && f.underOurDayToDayControl === false) {
    return {
      covered: false,
      basis: `The injured person is a \`${personType}\` recorded as NOT under our day-to-day supervision, so under 1904.31(b)(2) the case belongs on the supplying employer's log.`,
      review: null,
    };
  }
  return { covered: true, basis: `The injured person is recorded as \`${personType}\` and covered by 1904.31.`, review: null };
}

/** 29 CFR 1904.39(a)(1) — fatality, 8 hours. */
function ruleOshaFatality(f: IncidentFacts): RuleDetermination {
  const r = oshaRule({
    ruleId: "osha.fatality_8h",
    title: "Work-related fatality — report within 8 hours",
    citation:
      "29 CFR 1904.39(a)(1) — report within 8 hours after the death is reported to you or you learn of it. 29 CFR 1904.39(b)(6) — only a fatality occurring within 30 days of the work-related incident is reportable.",
    oshaCaseType: "death",
    consequenceIfMissed:
      "An unreported fatality is the clearest citable violation in Part 1904 and it converts an " +
      "inspection that was going to happen anyway into one that opens on the employer's candour. " +
      "The eight hours run from KNOWLEDGE, so an overnight discovery does not buy a working day.",
  });
  if (!f.isFatality && f.treatmentLevel !== "fatality") {
    r.basis.push("No fatality is recorded.");
    return r;
  }
  const cov = oshaCoverage(f);
  if (!cov.covered) {
    r.basis.push(cov.basis);
    if (cov.review) {
      r.outcome = "indeterminate";
      r.needsHumanReview = true;
      r.openQuestion = cov.review;
    }
    return r;
  }
  r.basis.push("A fatality is recorded.", cov.basis);
  if (f.fatalityOccurredAt) {
    const hrs = hoursBetween(f.occurredAt, f.fatalityOccurredAt);
    if (hrs != null && hrs > 30 * 24) {
      r.basis.push(
        `Death occurred ${Math.round(hrs / 24)} days after the incident. 1904.39(b)(6) limits the reporting duty to deaths within 30 days, so no 8-hour report is due — the case remains RECORDABLE on the 300 log under 1904.7(b)(2).`,
      );
      return r;
    }
    r.basis.push(`Death occurred ${Math.round(((hrs ?? 0) / 24) * 10) / 10} day(s) after the incident, within the 30-day window in 1904.39(b)(6).`);
  } else {
    r.needsHumanReview = true;
    r.openQuestion =
      "The date of death is not recorded. 1904.39(b)(6) limits the 8-hour report to deaths within 30 days of the incident; the report is being treated as due, which is the safe reading, but the date should be recorded.";
    r.basis.push(r.openQuestion);
  }
  const start = awareAt(f);
  r.outcome = "met";
  r.deadline = {
    dueAt: addHours(start, 8),
    clockStartsAt: start,
    clockStartsFrom: f.becameAwareAt
      ? "the employer learning of the death"
      : "the incident (no separate awareness time recorded — the engine has fallen back to the occurrence, which is the SHORTER, safer clock)",
    withinHours: 8,
    withinLabel: "8 hours",
    immediateNotificationRequired: true,
    notificationMethod:
      "Report by telephone to the OSHA area office or 1-800-321-OSHA (6742), or through the online reporting application.",
  };
  if (!f.becameAwareAt) {
    r.needsHumanReview = true;
    r.openQuestion =
      (r.openQuestion ? `${r.openQuestion} ` : "") +
      "No awareness timestamp is recorded, so the 8-hour clock has been started from the occurrence. That is the shorter clock and therefore safe, but the true trigger under 1904.39(a) is knowledge — record it.";
  }
  return r;
}

/** 29 CFR 1904.39(a)(2) — in-patient hospitalization, 24 hours. */
function ruleOshaHospitalization(f: IncidentFacts): RuleDetermination {
  const r = oshaRule({
    ruleId: "osha.inpatient_hospitalization_24h",
    title: "In-patient hospitalization — report within 24 hours",
    citation:
      "29 CFR 1904.39(a)(2) — report the in-patient hospitalization of an employee within 24 hours of learning of it. 1904.39(b)(6) — reportable only where the hospitalization occurs within 24 hours of the work-related incident. 1904.39(b)(9) — in-patient hospitalization means a formal admission to the in-patient service for CARE OR TREATMENT; admission for observation or diagnostic testing alone is not reportable.",
    consequenceIfMissed:
      "The 24-hour report is the one that turns on a distinction — admitted for treatment versus " +
      "held for observation — that the hospital, not the employer, controls. Not asking the question " +
      "is what produces the citation.",
  });
  const wentToHospital =
    f.hospitalAdmission === "inpatient_treatment" ||
    f.hospitalAdmission === "inpatient_observation_only" ||
    (f.hospitalAdmission === "unknown" &&
      (f.treatmentLevel === "hospitalised" || f.treatmentLevel === "emergency_department"));
  if (!wentToHospital) {
    r.basis.push(
      `No in-patient hospitalization is indicated (admission \`${f.hospitalAdmission}\`, treatment level ` +
        `\`${f.treatmentLevel ?? "not recorded"}\`).`,
    );
    return r;
  }
  const cov = oshaCoverage(f);
  if (!cov.covered) {
    r.basis.push(cov.basis);
    if (cov.review) {
      r.outcome = "indeterminate";
      r.needsHumanReview = true;
      r.openQuestion = cov.review;
    }
    return r;
  }
  if (f.hospitalAdmission === "none" || f.hospitalAdmission === "outpatient_or_ed_only") {
    r.basis.push(
      `Hospital admission recorded as \`${f.hospitalAdmission}\`. An emergency-department attendance without a formal in-patient admission is outside 1904.39(b)(9).`,
    );
    return r;
  }
  if (f.hospitalAdmission === "inpatient_observation_only") {
    r.basis.push(
      "The admission is recorded as observation or diagnostic testing only, which 1904.39(b)(9) expressly excludes from the reporting duty.",
    );
    return r;
  }
  if (f.hospitalAdmission === "unknown") {
    if (f.treatmentLevel === "hospitalised" || f.treatmentLevel === "emergency_department") {
      r.outcome = "indeterminate";
      r.needsHumanReview = true;
      r.openQuestion =
        "The person attended hospital but the admission is not classified. 1904.39(b)(9) reports only a FORMAL IN-PATIENT ADMISSION FOR CARE OR TREATMENT — observation or diagnostic testing alone is excluded. Ask the hospital and record the answer. The 24-hour clock is running while the question is open.";
      r.basis.push(
        `Treatment level \`${f.treatmentLevel}\` indicates a hospital attendance; the admission type is \`unknown\`.`,
        r.openQuestion,
      );
      return r;
    }
    r.basis.push("No hospital attendance is indicated by the treatment level and the admission is unknown.");
    return r;
  }
  // inpatient_treatment
  r.basis.push("A formal in-patient admission for care or treatment is recorded.", cov.basis);
  if (f.hospitalAdmittedAt) {
    const hrs = hoursBetween(f.occurredAt, f.hospitalAdmittedAt);
    if (hrs != null && hrs > 24) {
      r.basis.push(
        `Admission occurred ${Math.round(hrs)} hours after the incident. 1904.39(b)(6) limits the duty to hospitalizations occurring within 24 hours of the work-related incident, so no report is due — the case remains RECORDABLE on the 300 log.`,
      );
      return r;
    }
    r.basis.push(`Admission occurred ${Math.round((hrs ?? 0) * 10) / 10} hour(s) after the incident, inside the 24-hour proximity test.`);
  } else {
    r.needsHumanReview = true;
    r.openQuestion =
      "The admission time is not recorded, so the 1904.39(b)(6) proximity test (hospitalization within 24 hours of the incident) cannot be applied. The report is being treated as due, which is the safe reading.";
    r.basis.push(r.openQuestion);
  }
  const start = awareAt(f);
  r.outcome = "met";
  r.oshaCaseType = "other_recordable";
  r.deadline = {
    dueAt: addHours(start, 24),
    clockStartsAt: start,
    clockStartsFrom: f.becameAwareAt ? "the employer learning of the hospitalization" : "the incident (no awareness time recorded)",
    withinHours: 24,
    withinLabel: "24 hours",
    immediateNotificationRequired: true,
    notificationMethod:
      "Report by telephone to the OSHA area office or 1-800-321-OSHA (6742), or through the online reporting application.",
  };
  return r;
}

/** 29 CFR 1904.39(a)(2) — amputation, 24 hours. */
function ruleOshaAmputation(f: IncidentFacts): RuleDetermination {
  const r = oshaRule({
    ruleId: "osha.amputation_24h",
    title: "Amputation — report within 24 hours",
    citation:
      "29 CFR 1904.39(a)(2) — report an amputation within 24 hours of learning of it. 1904.39(b)(11) — amputation is the traumatic loss of a limb or other external body part, including a part later reattached, with or without bone loss; it does not include avulsions, enucleations, deglovings, scalpings, severed ears or broken teeth. 1904.39(b)(7) — reportable only where the amputation occurs within 24 hours of the work-related incident.",
    consequenceIfMissed:
      "Amputations are reported and inspected as a class because they cluster on the same unguarded " +
      "machines. A missed report is both a citation and the loss of the only mechanism that would " +
      "have caught the machine before the next hand.",
  });
  if (f.injuryNature !== "amputation") {
    r.basis.push(`Injury nature is \`${f.injuryNature ?? "not recorded"}\`, not an amputation.`);
    return r;
  }
  const cov = oshaCoverage(f);
  if (!cov.covered) {
    r.basis.push(cov.basis);
    if (cov.review) {
      r.outcome = "indeterminate";
      r.needsHumanReview = true;
      r.openQuestion = cov.review;
    }
    return r;
  }
  const start = awareAt(f);
  r.outcome = "met";
  r.oshaCaseType = "other_recordable";
  r.basis.push("An amputation is recorded.", cov.basis);
  r.needsHumanReview = true;
  r.openQuestion =
    "1904.39(b)(11) excludes avulsions, enucleations, deglovings, scalpings, severed ears and broken teeth from the definition of amputation. Confirm the injury is a traumatic loss of an external body part before submitting.";
  r.basis.push(r.openQuestion);
  r.deadline = {
    dueAt: addHours(start, 24),
    clockStartsAt: start,
    clockStartsFrom: f.becameAwareAt ? "the employer learning of the amputation" : "the incident (no awareness time recorded)",
    withinHours: 24,
    withinLabel: "24 hours",
    immediateNotificationRequired: true,
    notificationMethod:
      "Report by telephone to the OSHA area office or 1-800-321-OSHA (6742), or through the online reporting application.",
  };
  return r;
}

/** 29 CFR 1904.39(a)(2) — loss of an eye, 24 hours. */
function ruleOshaLossOfEye(f: IncidentFacts): RuleDetermination {
  const r = oshaRule({
    ruleId: "osha.loss_of_eye_24h",
    title: "Loss of an eye — report within 24 hours",
    citation:
      "29 CFR 1904.39(a)(2) — report the loss of an eye within 24 hours of learning of it. 1904.39(b)(8) — loss of an eye is the physical removal of the eye, including enucleation; loss of sight without removal is NOT a reportable loss of an eye (though it is recordable). 1904.39(b)(7) — reportable only where the loss occurs within 24 hours of the incident.",
    consequenceIfMissed:
      "The rule is narrow and it is routinely over- and under-applied in the same organisation. A " +
      "blinding without removal is recordable, not reportable; a removal is reportable in 24 hours.",
  });
  const eyeInvolved = (f.bodyPart ?? "") === "eye" || f.additionalBodyParts.includes("eye");
  if (f.lossOfAnEye === true) {
    const cov = oshaCoverage(f);
    if (!cov.covered) {
      r.basis.push(cov.basis);
      if (cov.review) {
        r.outcome = "indeterminate";
        r.needsHumanReview = true;
        r.openQuestion = cov.review;
      }
      return r;
    }
    const start = awareAt(f);
    r.outcome = "met";
    r.oshaCaseType = "other_recordable";
    r.basis.push("Physical loss of an eye is recorded.", cov.basis);
    r.deadline = {
      dueAt: addHours(start, 24),
      clockStartsAt: start,
      clockStartsFrom: f.becameAwareAt ? "the employer learning of the loss" : "the incident (no awareness time recorded)",
      withinHours: 24,
      withinLabel: "24 hours",
      immediateNotificationRequired: true,
      notificationMethod:
        "Report by telephone to the OSHA area office or 1-800-321-OSHA (6742), or through the online reporting application.",
    };
    return r;
  }
  if (f.lossOfAnEye === false) {
    r.basis.push("The eye was not physically lost. 1904.39(b)(8) reports removal of the eye, not loss of sight.");
    return r;
  }
  if (eyeInvolved && (f.treatmentLevel === "hospitalised" || f.treatmentLevel === "emergency_department" || f.injuryNature === "amputation")) {
    r.outcome = "indeterminate";
    r.needsHumanReview = true;
    r.openQuestion =
      "An eye injury serious enough for hospital is recorded but it is not stated whether the eye was physically lost. 1904.39(b)(8) reports the REMOVAL of an eye within 24 hours; loss of sight without removal is recordable but not reportable. Answer `lossOfAnEye`.";
    r.basis.push(r.openQuestion);
    return r;
  }
  r.basis.push("No loss of an eye is recorded.");
  return r;
}

/** 29 CFR 1904.4 / 1904.7 / 1904.29 — the 300 log recording duty. */
function ruleOshaRecordable(f: IncidentFacts): RuleDetermination {
  const r = oshaRule({
    ruleId: "osha.recordable_300_log",
    title: "Recordable case — enter on the OSHA 300 log",
    citation:
      "29 CFR 1904.4(a) and 1904.7(b)(1) — a work-related injury or illness is recordable if it results in death, days away from work, restricted work or transfer to another job, medical treatment beyond first aid, loss of consciousness, or a significant injury or illness diagnosed by a physician or other licensed health care professional. 29 CFR 1904.29(b)(3) — enter it on the 300 log and the 301 incident report within 7 calendar days of receiving the information.",
    isRecordingDutyOnly: true,
    consequenceIfMissed:
      "The 300 log is the denominator of every rate the company publishes and the first document " +
      "requested in an inspection. An unlogged recordable case understates the TRIR the business " +
      "reports to its clients and its insurer — which is a misrepresentation, not a clerical error.",
  });
  const cov = oshaCoverage(f);
  if (!cov.covered) {
    r.basis.push(cov.basis);
    if (cov.review) {
      r.outcome = "indeterminate";
      r.needsHumanReview = true;
      r.openQuestion = cov.review;
    }
    r.oshaCaseType = "not_recordable";
    return r;
  }
  if (f.workRelated === false) {
    r.basis.push("The incident is recorded as not work-related; 1904.5 is the gate on the whole of Part 1904.");
    r.oshaCaseType = "not_recordable";
    return r;
  }
  const criteria: string[] = [];
  if (f.isFatality || f.treatmentLevel === "fatality") criteria.push("death (1904.7(b)(2))");
  if ((f.lostTimeDays ?? 0) > 0 || f.isLostTime) criteria.push("days away from work (1904.7(b)(3))");
  if ((f.restrictedDutyDays ?? 0) > 0) criteria.push("restricted work or job transfer (1904.7(b)(4))");
  if (f.medicalTreatmentBeyondFirstAid === true) criteria.push("medical treatment beyond first aid (1904.7(b)(5))");
  if (f.lossOfConsciousness === true) criteria.push("loss of consciousness (1904.7(b)(6))");
  if (f.hospitalAdmission === "inpatient_treatment") criteria.push("in-patient admission for treatment (1904.7(b)(5))");
  if (f.injuryNature === "amputation") criteria.push("amputation — a significant injury (1904.7(b)(7))");

  let ambiguous: string | null = null;
  if (f.medicalTreatmentBeyondFirstAid == null && f.treatmentLevel === "medical_treatment") {
    ambiguous =
      "The treatment level is `medical_treatment` but it has not been confirmed against the closed first-aid list in 1904.7(b)(5)(ii). That list includes tetanus immunisations, wound cleaning, non-rigid supports, and non-prescription medication at non-prescription strength — all of which are FIRST AID and none of which make a case recordable. This is the single most audited judgement in the whole of incident recording and the engine will not make it. Answer `medicalTreatmentBeyondFirstAid`.";
  } else if (f.medicalTreatmentBeyondFirstAid == null && f.treatmentLevel === "first_aid" && criteria.length === 0) {
    r.basis.push("Treatment is recorded as first aid only and no other recording criterion is met.");
    r.oshaCaseType = "not_recordable";
    return r;
  }

  if (criteria.length === 0) {
    if (ambiguous) {
      r.outcome = "indeterminate";
      r.needsHumanReview = true;
      r.openQuestion = ambiguous;
      r.basis.push(ambiguous);
      r.oshaCaseType = "under_assessment";
      return r;
    }
    r.basis.push("No general recording criterion in 1904.7(b) is met on the facts recorded.");
    r.oshaCaseType = "not_recordable";
    return r;
  }

  r.outcome = "met";
  r.basis.push(`Recording criteria met: ${criteria.join("; ")}.`, cov.basis);
  if (ambiguous) {
    r.needsHumanReview = true;
    r.openQuestion = ambiguous;
    r.basis.push(ambiguous);
  }
  if (cov.review) {
    r.needsHumanReview = true;
    r.openQuestion = r.openQuestion ? `${r.openQuestion} ${cov.review}` : cov.review;
  }
  r.oshaCaseType = classifyOshaCase(f);
  const start = awareAt(f);
  r.deadline = {
    dueAt: endOfDayAfterDays(start, 7),
    clockStartsAt: start,
    clockStartsFrom: "receiving information that a recordable case occurred",
    withinHours: 168,
    withinLabel: "7 calendar days",
    immediateNotificationRequired: false,
    notificationMethod:
      "Enter the case on the OSHA 300 log and complete the 301 incident report. This is a RECORDING duty — nothing is sent to OSHA.",
  };
  return r;
}

/**
 * The 300 log case classification. Mutually exclusive and taken at the most
 * severe outcome reached during the case (1904.29(b)(4)) — a case that starts
 * as restricted duty and becomes days away is logged as days away.
 */
export function classifyOshaCase(f: IncidentFacts): OshaCaseType {
  if (f.isFatality || f.treatmentLevel === "fatality") return "death";
  if ((f.lostTimeDays ?? 0) > 0 || f.isLostTime) return "days_away_from_work";
  if ((f.restrictedDutyDays ?? 0) > 0) return "job_transfer_or_restriction";
  if (
    f.medicalTreatmentBeyondFirstAid === true ||
    f.lossOfConsciousness === true ||
    f.hospitalAdmission === "inpatient_treatment" ||
    f.injuryNature === "amputation"
  ) {
    return "other_recordable";
  }
  if (f.medicalTreatmentBeyondFirstAid == null && f.treatmentLevel === "medical_treatment") {
    return "under_assessment";
  }
  return "not_recordable";
}

/* ================================================================== */
/* The engine                                                          */
/* ================================================================== */

const RIDDOR_RULES = [
  ruleRiddorFatality,
  ruleRiddorSpecifiedInjury,
  ruleRiddorOverSevenDay,
  ruleRiddorOverThreeDayRecord,
  ruleRiddorDangerousOccurrence,
  ruleRiddorNonWorkerHospital,
  ruleRiddorOccupationalDisease,
  ruleRiddorGasIncident,
] as const;

const OSHA_RULES = [
  ruleOshaFatality,
  ruleOshaHospitalization,
  ruleOshaAmputation,
  ruleOshaLossOfEye,
  ruleOshaRecordable,
] as const;

/** Every rule this engine implements, for the catalogue endpoint. */
export function ruleCatalogue(): Array<{
  ruleId: string;
  regime: ReportableRegime;
  jurisdiction: string;
  title: string;
  citation: string;
  isRecordingDutyOnly: boolean;
}> {
  const blank = blankFacts();
  return [...RIDDOR_RULES, ...OSHA_RULES].map((fn) => {
    const d = fn(blank);
    return {
      ruleId: d.ruleId,
      regime: d.regime,
      jurisdiction: d.jurisdiction,
      title: d.title,
      citation: d.citation,
      isRecordingDutyOnly: d.isRecordingDutyOnly,
    };
  });
}

/** RIDDOR categories in descending seriousness — the stored one is the worst. */
const RIDDOR_PRECEDENCE: RiddorCategory[] = [
  "death",
  "specified_injury",
  "dangerous_occurrence",
  "gas_incident",
  "occupational_disease",
  "over_7_day_incapacitation",
  "over_3_day_recordable",
];

const OSHA_PRECEDENCE: OshaCaseType[] = [
  "death",
  "days_away_from_work",
  "job_transfer_or_restriction",
  "other_recordable",
];

/**
 * Assess an incident against every rule of every applicable regime.
 *
 * The output is deliberately verbose: a duty-holder reading this has to be
 * able to see WHICH rule bit, on WHICH fact, with WHICH citation, and what
 * they still have to decide. A boolean would be smaller and useless.
 */
export function assessReportability(
  facts: IncidentFacts,
  regimes: readonly ReportableRegime[],
): ReportabilityDetermination {
  const rules: RuleDetermination[] = [];
  const assessed: ReportableRegime[] = [];

  if (regimes.includes("riddor")) {
    assessed.push("riddor");
    for (const fn of RIDDOR_RULES) rules.push(fn(facts));
  }
  if (regimes.includes("osha")) {
    assessed.push("osha");
    for (const fn of OSHA_RULES) rules.push(fn(facts));
  }

  const met = rules.filter((r) => r.outcome === "met");
  const indeterminate = rules.filter((r) => r.outcome === "indeterminate");
  const notifiable = met.filter((r) => !r.isRecordingDutyOnly && r.deadline != null);

  const reasons: string[] = [];
  const openQuestions: string[] = [];
  for (const r of rules) {
    if (r.openQuestion) openQuestions.push(`${r.ruleId}: ${r.openQuestion}`);
  }

  const unimplemented = regimes.filter((r) => r !== "riddor" && r !== "osha" && r !== "none");
  for (const u of unimplemented) {
    reasons.push(
      `Regime \`${u}\` was requested but is not implemented by this engine (RIDDOR and OSHA are). ` +
        `It has NOT been assessed — treat its classification as outstanding.`,
    );
    openQuestions.push(`${u}: not implemented — classify by hand.`);
  }
  if (assessed.length === 0) {
    reasons.push(
      "No implemented regime applies to this incident, so reportability has not been assessed. " +
        "That is not a finding of `not reportable`.",
    );
  }

  let reportDueAt: string | null = null;
  let governingRuleId: string | null = null;
  for (const r of notifiable) {
    const due = r.deadline!.dueAt;
    if (reportDueAt === null || Date.parse(due) < Date.parse(reportDueAt)) {
      reportDueAt = due;
      governingRuleId = r.ruleId;
    }
  }
  if (reportDueAt === null && met.length > 0) {
    reasons.push(
      "Rules are met but none of them carries a notification deadline — they are recording duties. " +
        "Nothing is due to an authority.",
    );
  }

  const metRegimes = [...new Set(met.filter((r) => !r.isRecordingDutyOnly).map((r) => r.regime))];

  let riddorCategory: RiddorCategory = assessed.includes("riddor") ? "not_reportable" : "under_assessment";
  if (assessed.includes("riddor")) {
    const metCats = new Set(
      rules.filter((r) => r.regime === "riddor" && r.outcome === "met" && r.riddorCategory).map((r) => r.riddorCategory!),
    );
    const best = RIDDOR_PRECEDENCE.find((c) => metCats.has(c));
    if (best) riddorCategory = best;
    else if (rules.some((r) => r.regime === "riddor" && r.outcome === "indeterminate")) {
      riddorCategory = "under_assessment";
    }
    // reg. 5 has no member in RIDDOR_CATEGORIES; say so rather than mislabel.
    const reg5 = rules.find((r) => r.ruleId === "riddor.non_worker_hospital" && r.outcome === "met");
    if (reg5 && !best) {
      riddorCategory = "under_assessment";
      openQuestions.push(
        "riddor.non_worker_hospital: the incident IS reportable under reg. 5, but RIDDOR_CATEGORIES " +
          "carries no member for an injury to a non-worker taken to hospital. The stored category is " +
          "`under_assessment` so it is not silently mislabelled — record the category by hand on the F2508.",
      );
    }
  }

  let oshaCaseType: OshaCaseType = assessed.includes("osha") ? "not_recordable" : "under_assessment";
  if (assessed.includes("osha")) {
    const recordable = rules.find((r) => r.ruleId === "osha.recordable_300_log");
    if (recordable?.outcome === "met") {
      const metTypes = new Set(
        rules.filter((r) => r.regime === "osha" && r.outcome === "met" && r.oshaCaseType).map((r) => r.oshaCaseType!),
      );
      oshaCaseType = OSHA_PRECEDENCE.find((c) => metTypes.has(c)) ?? classifyOshaCase(facts);
    } else if (recordable?.outcome === "indeterminate") {
      oshaCaseType = "under_assessment";
    } else {
      oshaCaseType = recordable?.oshaCaseType ?? "not_recordable";
    }
  }

  return {
    isReportable: met.some((r) => !r.isRecordingDutyOnly),
    needsHumanReview: rules.some((r) => r.needsHumanReview) || unimplemented.length > 0 || assessed.length === 0,
    regimes: metRegimes,
    assessedRegimes: assessed,
    riddorCategory,
    oshaCaseType,
    reportDueAt,
    governingRuleId,
    rules,
    metRuleIds: met.map((r) => r.ruleId),
    indeterminateRuleIds: indeterminate.map((r) => r.ruleId),
    openQuestions,
    reasons,
    disclaimer: DISCLAIMER,
  };
}

/** A facts object with everything unknown — the base every caller spreads over. */
export function blankFacts(): IncidentFacts {
  return {
    incidentType: "near_miss",
    occurredAt: "1970-01-01T00:00:00.000Z",
    becameAwareAt: null,
    injuredPersonType: null,
    treatmentLevel: null,
    injuryNature: null,
    mechanism: null,
    bodyPart: null,
    additionalBodyParts: [],
    isFatality: false,
    fatalityOccurredAt: null,
    isLostTime: false,
    lostTimeDays: null,
    restrictedDutyDays: null,
    hospitalAdmission: "none",
    hospitalAdmittedAt: null,
    medicalTreatmentBeyondFirstAid: null,
    lossOfConsciousness: null,
    permanentSightLoss: null,
    lossOfAnEye: null,
    seriousBurn: null,
    enclosedSpace: null,
    dangerousOccurrenceClass: null,
    occupationalDiseaseDiagnosed: null,
    diagnosisReceivedAt: null,
    gasIncident: null,
    underOurDayToDayControl: null,
    incapacityStillAccruing: false,
    workRelated: null,
  };
}

/** Whether a met notification deadline has been missed at `asOfISO`. */
export function isNotificationMissed(
  dueAt: string | null,
  notifiedAt: string | null,
  asOfISO: string,
): boolean {
  if (!dueAt) return false;
  const due = Date.parse(dueAt);
  if (!Number.isFinite(due)) return false;
  if (notifiedAt) return Date.parse(notifiedAt) > due;
  return Date.parse(asOfISO) > due;
}
