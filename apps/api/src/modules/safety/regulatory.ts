/**
 * SAFETY — STATUTORY FORM GENERATION (spec Vol I #652).
 *
 * The reportability engine already decides WHETHER an incident must be
 * reported and by when. This file does the other half: it lays the records
 * out in the shape the authority's own form asks for — the OSHA 300 log, the
 * 300A annual summary, the 301 incident report, and the RIDDOR F2508 /
 * F2508A prefill.
 *
 * THE RULE THAT GOVERNS EVERY FIELD HERE: a form field the platform cannot
 * establish is `null`, and the reason it is null is carried alongside it. An
 * OSHA 300 log is a legal document that an inspector reads and a client's
 * prequalification team relies on; a blank in column (K) that silently means
 * "we never recorded the days away" is indistinguishable, on paper, from a
 * genuine zero — and one of those is a false statement. So every generated
 * artefact carries a `missing` list per row and a `caveats` list per document,
 * and the UI prints them next to the form.
 *
 * The second rule: these functions are PURE. They take rows and a context and
 * return a document. The caller freezes the result, hashes it, stores it and
 * ledgers it, because a 300A is an assertion made on a date from the records
 * as they stood then, and regenerating it later from a corrected register
 * produces a different document with the same name.
 *
 * Deliberately NOT here: submission. Nothing in this platform transmits to
 * HSE or OSHA; it produces the artefact a competent person checks and files.
 */

import type { IncidentMechanism, InjuryNature, OshaCaseType } from "@constructos/shared";
import type { ReportabilityDetermination } from "./reportability.js";

/* ================================================================== */
/* Inputs                                                              */
/* ================================================================== */

/**
 * The incident columns the forms actually read. Structural, so the drizzle
 * row satisfies it without a mapping step and without this file importing the
 * schema.
 */
export interface FormIncident {
  id: string;
  reference: string;
  number: number;
  projectId: string;
  incidentType: string;
  severity: string;
  title: string;
  description: string;
  occurredAt: string;
  discoveredAt: string | null;
  reportedAt: string | null;
  hoursIntoShift: number | null;
  shift: string | null;
  locationText: string | null;
  locationId: string | null;
  workerId: string | null;
  injuredPersonName: string | null;
  injuredPersonType: string | null;
  injuredPersonTrade: string | null;
  injuredPersonAge: number | null;
  vendorId: string | null;
  treatmentLevel: string | null;
  bodyPart: string | null;
  additionalBodyParts: string[];
  injuryNature: string | null;
  mechanism: string | null;
  treatmentProvider: string | null;
  hospitalName: string | null;
  isLostTime: number;
  lostTimeDays: number | null;
  restrictedDutyDays: number | null;
  returnToWorkDate: string | null;
  isFatality: number;
  activityAtTime: string | null;
  immediateCause: string | null;
  oshaCaseType: string | null;
  riddorCategory: string | null;
  reportableRegimes: string[];
  isReportable: number;
  reportDueAt: string | null;
  regulatorReference: string | null;
  status: string;
  detail: Record<string, unknown>;
}

/** Names the generator cannot look up on its own. */
export interface FormContext {
  /** the establishment / project the log belongs to */
  projectName: string;
  projectId: string;
  companyName: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
  /** worker id → full name, from the workforce register */
  workerNames: Map<string, string>;
  /** worker id → trade / job title */
  workerTrades: Map<string, string | null>;
  /** vendor id → name, for the injured person's employer */
  vendorNames: Map<string, string>;
  /** location id → label */
  locationNames: Map<string, string>;
}

export function emptyFormContext(projectName: string, projectId: string): FormContext {
  return {
    projectName,
    projectId,
    companyName: null,
    street: null,
    city: null,
    state: null,
    postcode: null,
    country: null,
    workerNames: new Map(),
    workerTrades: new Map(),
    vendorNames: new Map(),
    locationNames: new Map(),
  };
}

/* ================================================================== */
/* Shared field helpers                                                */
/* ================================================================== */

const asBool = (n: number | null | undefined): boolean => n === 1;

export interface FormField<T> {
  value: T | null;
  /** why the value is null — empty when it is present */
  reason: string | null;
}

const present = <T>(value: T): FormField<T> => ({ value, reason: null });
const absent = <T>(reason: string): FormField<T> => ({ value: null, reason });

function field<T>(value: T | null | undefined, reason: string): FormField<T> {
  return value === null || value === undefined || value === ""
    ? absent<T>(reason)
    : present(value as T);
}

/** The injured person's name, from the worker register or the free-text field. */
export function injuredPersonName(inc: FormIncident, ctx: FormContext): FormField<string> {
  if (inc.workerId) {
    const name = ctx.workerNames.get(inc.workerId);
    if (name) return present(name);
    return absent(
      `The incident names worker ${inc.workerId}, but that worker is not in the register that was ` +
        `read for this document, so the name could not be resolved.`,
    );
  }
  if (inc.injuredPersonName) return present(inc.injuredPersonName);
  if (inc.incidentType !== "injury" && inc.incidentType !== "occupational_illness") {
    return absent("No person was injured in this event, so no name is asked for.");
  }
  return absent("No injured person is recorded on the incident — neither a worker nor a name.");
}

export function injuredPersonJobTitle(inc: FormIncident, ctx: FormContext): FormField<string> {
  if (inc.injuredPersonTrade) return present(inc.injuredPersonTrade);
  if (inc.workerId) {
    const trade = ctx.workerTrades.get(inc.workerId);
    if (trade) return present(trade);
  }
  return absent("No job title or trade is recorded for the injured person.");
}

export function whereOccurred(inc: FormIncident, ctx: FormContext): FormField<string> {
  if (inc.locationId) {
    const label = ctx.locationNames.get(inc.locationId);
    if (label) return present(inc.locationText ? `${label} — ${inc.locationText}` : label);
  }
  return field(inc.locationText, "No location is recorded on the incident.");
}

/**
 * Column (F): the injury, the body part and the object that caused it, in one
 * sentence. Assembled from the coded columns rather than the narrative,
 * because the narrative is written for the site and the column is read by an
 * inspector who is scanning for a pattern.
 */
export function describeInjury(inc: FormIncident): FormField<string> {
  const parts: string[] = [];
  if (inc.injuryNature) parts.push(labelise(inc.injuryNature));
  const bodyParts = [inc.bodyPart, ...(inc.additionalBodyParts ?? [])].filter(
    (b): b is string => typeof b === "string" && b !== "not_applicable",
  );
  if (bodyParts.length > 0) parts.push(`to the ${bodyParts.map(labelise).join(", ")}`);
  if (inc.mechanism) parts.push(`(${labelise(inc.mechanism)})`);
  if (parts.length === 0) {
    return absent(
      "Neither the nature of the injury nor the body part is coded on the incident, so column (F) " +
        "cannot be assembled from the record. The narrative is on the 301.",
    );
  }
  const activity = inc.activityAtTime ? ` while ${inc.activityAtTime}` : "";
  return present(`${parts.join(" ")}${activity}`.trim());
}

function labelise(value: string): string {
  return value.replace(/_/g, " ");
}

/* ================================================================== */
/* OSHA 300 — the log                                                  */
/* ================================================================== */

/** 29 CFR 1904.29 form 300 column (M): injury, or one of five illness classes. */
export const OSHA_ILLNESS_COLUMNS = [
  "injury",
  "skin_disorder",
  "respiratory_condition",
  "poisoning",
  "hearing_loss",
  "all_other_illness",
] as const;
export type OshaIllnessColumn = (typeof OSHA_ILLNESS_COLUMNS)[number];

/**
 * Column (M). An incident typed `injury` is column M(1); an occupational
 * illness is placed by its nature, and an illness whose nature is not coded
 * falls to M(6) "all other illnesses" with the reason recorded — M(6) is the
 * honest destination for an unclassified illness, and is what the form's own
 * instructions direct.
 */
export function oshaIllnessColumn(inc: FormIncident): {
  column: OshaIllnessColumn;
  reason: string | null;
} {
  if (inc.incidentType !== "occupational_illness") return { column: "injury", reason: null };
  const nature = inc.injuryNature as InjuryNature | null;
  switch (nature) {
    case "dermatitis":
      return { column: "skin_disorder", reason: null };
    case "respiratory":
      return { column: "respiratory_condition", reason: null };
    case "hearing_loss":
      return { column: "hearing_loss", reason: null };
    default:
      break;
  }
  const mechanism = inc.mechanism as IncidentMechanism | null;
  if (mechanism === "chemical_contact" || mechanism === "inhalation") {
    return {
      column: "poisoning",
      reason:
        "Placed in column M(4) poisoning on the recorded mechanism, not on a coded diagnosis. " +
        "Check it against the physician's classification before filing.",
    };
  }
  return {
    column: "all_other_illness",
    reason:
      "The illness has no coded nature that maps to columns M(2)-M(5), so it falls to M(6) " +
      "“all other illnesses”. That is where the form's instructions send an unclassified " +
      "illness, but it is worth checking the diagnosis before filing.",
  };
}

export interface Osha300Row {
  /** column (A) — the incident's own reference, which is what the 301 links on */
  caseNumber: string;
  incidentId: string;
  employeeName: FormField<string>;
  jobTitle: FormField<string>;
  dateOfInjury: string;
  whereOccurred: FormField<string>;
  description: FormField<string>;
  /** columns (G)-(J): exactly one is true on a recordable case */
  classification: {
    death: boolean;
    daysAwayFromWork: boolean;
    jobTransferOrRestriction: boolean;
    otherRecordable: boolean;
  };
  oshaCaseType: OshaCaseType;
  /** column (K) */
  daysAwayFromWork: FormField<number>;
  /** column (L) */
  daysOnJobTransferOrRestriction: FormField<number>;
  /** column (M) */
  illnessColumn: OshaIllnessColumn;
  /** everything this row could not establish */
  missing: string[];
  /** whether the days counts are still running (1904.7(b)(3)(viii)) */
  stillAccruing: boolean;
  privacyCase: boolean;
}

export interface Osha300Log {
  form: "osha_300";
  establishment: { name: string; projectId: string; city: string | null; state: string | null };
  year: number;
  from: string;
  to: string;
  rows: Osha300Row[];
  totals: {
    deaths: number;
    daysAwayCases: number;
    jobTransferOrRestrictionCases: number;
    otherRecordableCases: number;
    daysAway: number;
    daysRestricted: number;
    byIllnessColumn: Record<OshaIllnessColumn, number>;
  };
  /** incidents in the window that were NOT logged, and why */
  excluded: Array<{ incidentId: string; reference: string; reason: string }>;
  caveats: string[];
  generatedAt: string;
  disclaimer: string;
}

const OSHA_DISCLAIMER =
  "This log is assembled from the incident register's own classification columns. 29 CFR 1904 " +
  "places the recordability decision on the employer, not on a system: check every row, complete " +
  "every field marked missing, and treat the day counts as provisional while any case is still " +
  "accruing.";

/**
 * Cases that go on the 300 log: those whose OSHA case type is one of the four
 * recordable classifications. Everything else in the window is listed under
 * `excluded` with the reason — including, importantly, incidents on a project
 * where OSHA was never assessed, which would otherwise read as "not
 * recordable" when the truth is "never asked".
 */
export function buildOsha300(
  incidents: readonly FormIncident[],
  ctx: FormContext,
  year: number,
  generatedAt: string,
): Osha300Log {
  const rows: Osha300Row[] = [];
  const excluded: Osha300Log["excluded"] = [];
  const caveats: string[] = [];

  const recordable: OshaCaseType[] = [
    "death",
    "days_away_from_work",
    "job_transfer_or_restriction",
    "other_recordable",
  ];

  for (const inc of incidents) {
    if (inc.status === "void") {
      excluded.push({ incidentId: inc.id, reference: inc.reference, reason: "The incident is void." });
      continue;
    }
    const caseType = (inc.oshaCaseType ?? "under_assessment") as OshaCaseType;
    if (caseType === "under_assessment") {
      const assessed = (inc.reportableRegimes ?? []).includes("osha");
      excluded.push({
        incidentId: inc.id,
        reference: inc.reference,
        reason: assessed
          ? "The OSHA recordability test could not be decided on the facts held — the case is under " +
            "assessment. It is neither logged nor dismissed; settle the open questions on the incident."
          : "OSHA was never assessed for this incident, so it has no recordability classification. It " +
            "is NOT the same as `not recordable`: if this establishment is subject to Part 1904, " +
            "reassess the incident with `osha` in its regimes.",
      });
      continue;
    }
    if (!recordable.includes(caseType)) {
      excluded.push({
        incidentId: inc.id,
        reference: inc.reference,
        reason: `Classified \`${caseType}\` — not a recordable case under 1904.7.`,
      });
      continue;
    }

    const missing: string[] = [];
    const name = injuredPersonName(inc, ctx);
    if (name.reason) missing.push(`(B) employee name: ${name.reason}`);
    const title = injuredPersonJobTitle(inc, ctx);
    if (title.reason) missing.push(`(C) job title: ${title.reason}`);
    const where = whereOccurred(inc, ctx);
    if (where.reason) missing.push(`(E) where the event occurred: ${where.reason}`);
    const description = describeInjury(inc);
    if (description.reason) missing.push(`(F) description: ${description.reason}`);

    const daysAway =
      caseType === "days_away_from_work" || asBool(inc.isLostTime)
        ? field<number>(
            inc.lostTimeDays,
            "The case is classified days-away but no day count is recorded, so column (K) is blank " +
              "rather than zero — a zero here would state that the person lost no time.",
          )
        : present(0);
    if (daysAway.reason) missing.push(`(K) days away: ${daysAway.reason}`);

    const daysRestricted =
      caseType === "job_transfer_or_restriction"
        ? field<number>(
            inc.restrictedDutyDays,
            "The case is classified job transfer or restriction but no restricted-day count is " +
              "recorded, so column (L) is blank rather than zero.",
          )
        : present(inc.restrictedDutyDays ?? 0);
    if (daysRestricted.reason) missing.push(`(L) days restricted: ${daysRestricted.reason}`);

    const illness = oshaIllnessColumn(inc);
    if (illness.reason) missing.push(`(M) classification: ${illness.reason}`);

    const stillAccruing =
      (caseType === "days_away_from_work" || caseType === "job_transfer_or_restriction") &&
      inc.returnToWorkDate === null &&
      !asBool(inc.isFatality);

    rows.push({
      caseNumber: inc.reference,
      incidentId: inc.id,
      employeeName: name,
      jobTitle: title,
      dateOfInjury: inc.occurredAt.slice(0, 10),
      whereOccurred: where,
      description,
      classification: {
        death: caseType === "death",
        daysAwayFromWork: caseType === "days_away_from_work",
        jobTransferOrRestriction: caseType === "job_transfer_or_restriction",
        otherRecordable: caseType === "other_recordable",
      },
      oshaCaseType: caseType,
      daysAwayFromWork: daysAway,
      daysOnJobTransferOrRestriction: daysRestricted,
      illnessColumn: illness.column,
      missing,
      stillAccruing,
      privacyCase: isPrivacyCase(inc),
    });
  }

  const byIllnessColumn = Object.fromEntries(
    OSHA_ILLNESS_COLUMNS.map((c) => [c, 0]),
  ) as Record<OshaIllnessColumn, number>;
  for (const row of rows) byIllnessColumn[row.illnessColumn] += 1;

  const totals = {
    deaths: rows.filter((r) => r.classification.death).length,
    daysAwayCases: rows.filter((r) => r.classification.daysAwayFromWork).length,
    jobTransferOrRestrictionCases: rows.filter((r) => r.classification.jobTransferOrRestriction)
      .length,
    otherRecordableCases: rows.filter((r) => r.classification.otherRecordable).length,
    daysAway: rows.reduce((s, r) => s + (r.daysAwayFromWork.value ?? 0), 0),
    daysRestricted: rows.reduce((s, r) => s + (r.daysOnJobTransferOrRestriction.value ?? 0), 0),
    byIllnessColumn,
  };

  const underAssessment = excluded.filter((e) => e.reason.includes("under assessment")).length;
  if (underAssessment > 0) {
    caveats.push(
      `${underAssessment} incident(s) in this year are still under assessment for recordability and ` +
        `are therefore absent from the log. The log is a floor, not a final figure.`,
    );
  }
  const neverAssessed = excluded.filter((e) => e.reason.includes("never assessed")).length;
  if (neverAssessed > 0) {
    caveats.push(
      `${neverAssessed} incident(s) were never assessed under OSHA at all. If this establishment is ` +
        `subject to 29 CFR Part 1904 the log is incomplete — reassess them with \`osha\` in the regimes.`,
    );
  }
  const withMissing = rows.filter((r) => r.missing.length > 0).length;
  if (withMissing > 0) {
    caveats.push(
      `${withMissing} logged case(s) have at least one column the register could not fill. Each is ` +
        `listed on the row; a blank column on a filed 300 log is a finding in itself.`,
    );
  }
  const accruing = rows.filter((r) => r.stillAccruing).length;
  if (accruing > 0) {
    caveats.push(
      `${accruing} case(s) have no return-to-work date, so their day counts are still running. ` +
        `1904.7(b)(3)(viii) requires the count to be updated as the case develops and capped at 180 days.`,
    );
  }

  return {
    form: "osha_300",
    establishment: {
      name: ctx.projectName,
      projectId: ctx.projectId,
      city: ctx.city,
      state: ctx.state,
    },
    year,
    from: `${year}-01-01`,
    to: `${year}-12-31`,
    rows,
    totals,
    excluded,
    caveats,
    generatedAt,
    disclaimer: OSHA_DISCLAIMER,
  };
}

/** 1904.29(b)(7): a case involving certain injuries is entered without the name. */
function isPrivacyCase(inc: FormIncident): boolean {
  const nature = inc.injuryNature;
  if (nature === "psychological") return true;
  const detail = inc.detail as { privacyCase?: unknown };
  return detail?.privacyCase === true;
}

/* ================================================================== */
/* OSHA 300A — the annual summary                                      */
/* ================================================================== */

export interface Osha300ASummary {
  form: "osha_300a";
  establishment: {
    name: string;
    projectId: string;
    street: string | null;
    city: string | null;
    state: string | null;
    postcode: string | null;
  };
  year: number;
  totals: Osha300Log["totals"];
  /** the denominator OSHA asks for on the form itself */
  annualAverageEmployees: FormField<number>;
  totalHoursWorked: FormField<number>;
  /** how the hours figure was arrived at, quoted */
  hoursBasis: string | null;
  certification: {
    required: string;
    certifiedBy: string | null;
    title: string | null;
    certifiedAt: string | null;
  };
  postingPeriod: { from: string; to: string; note: string };
  caveats: string[];
  generatedAt: string;
  disclaimer: string;
}

export interface Osha300AInput {
  log: Osha300Log;
  totalHoursWorked: number | null;
  hoursReasons: readonly string[];
  hoursSource: string | null;
  annualAverageEmployees: number | null;
  employeeReasons: readonly string[];
  generatedAt: string;
}

/**
 * The 300A. Its two denominators — average employment and hours worked — are
 * the ones a client's prequalification team divides into the case counts, so
 * neither is ever estimated here: if the platform does not hold the hours,
 * the field is null and the reason names the record that is missing.
 */
export function buildOsha300A(input: Osha300AInput, ctx: FormContext): Osha300ASummary {
  const { log } = input;
  const caveats = [...log.caveats];

  const hours =
    input.totalHoursWorked != null && input.totalHoursWorked > 0
      ? present(input.totalHoursWorked)
      : absent<number>(
          input.hoursReasons.join(" ") ||
            "The platform holds no exposure hours for this year, so the total-hours box is blank. " +
              "An estimated denominator on a 300A is a misstatement, not an approximation.",
        );
  if (hours.reason) caveats.push(`Total hours worked: ${hours.reason}`);

  const employees =
    input.annualAverageEmployees != null && input.annualAverageEmployees > 0
      ? present(input.annualAverageEmployees)
      : absent<number>(
          input.employeeReasons.join(" ") ||
            "The workforce register holds no employment record covering this year, so the annual " +
              "average number of employees cannot be derived.",
        );
  if (employees.reason) caveats.push(`Annual average employees: ${employees.reason}`);

  return {
    form: "osha_300a",
    establishment: {
      name: ctx.projectName,
      projectId: ctx.projectId,
      street: ctx.street,
      city: ctx.city,
      state: ctx.state,
      postcode: ctx.postcode,
    },
    year: log.year,
    totals: log.totals,
    annualAverageEmployees: employees,
    totalHoursWorked: hours,
    hoursBasis: input.hoursSource
      ? `Hours taken from ${input.hoursSource.replace(/_/g, " ")} records for ${log.from} to ${log.to}.`
      : null,
    certification: {
      required:
        "1904.32(b)(3): a company executive must certify that they have examined the OSHA 300 log " +
        "and that they reasonably believe the summary is correct and complete. This platform does " +
        "not certify on anyone's behalf.",
      certifiedBy: null,
      title: null,
      certifiedAt: null,
    },
    postingPeriod: {
      from: `${log.year + 1}-02-01`,
      to: `${log.year + 1}-04-30`,
      note: "1904.32(b)(5): the summary is posted where notices to employees are customarily posted.",
    },
    caveats,
    generatedAt: input.generatedAt,
    disclaimer: OSHA_DISCLAIMER,
  };
}

/* ================================================================== */
/* OSHA 301 — the incident report                                      */
/* ================================================================== */

export interface Osha301Report {
  form: "osha_301";
  caseNumber: string;
  incidentId: string;
  employee: {
    name: FormField<string>;
    jobTitle: FormField<string>;
    dateOfBirth: FormField<string>;
    dateHired: FormField<string>;
    employmentRelationship: FormField<string>;
  };
  physician: {
    name: FormField<string>;
    facility: FormField<string>;
    treatedInEmergencyRoom: FormField<boolean>;
    hospitalisedOvernight: FormField<boolean>;
  };
  incident: {
    dateOfInjury: string;
    timeOfEvent: FormField<string>;
    timeEmployeeBeganWork: FormField<string>;
    whatWasEmployeeDoing: FormField<string>;
    whatHappened: string;
    whatWasTheInjury: FormField<string>;
    whatObjectHarmed: FormField<string>;
    dateOfDeath: FormField<string>;
  };
  missing: string[];
  caveats: string[];
  generatedAt: string;
  disclaimer: string;
}

/**
 * The 301 is due within seven calendar days of learning of the case, and it
 * is the form that asks the questions the log has no room for — what the
 * person was doing, what happened, what harmed them. The narrative is quoted
 * from the incident, never paraphrased.
 */
export function buildOsha301(
  inc: FormIncident,
  ctx: FormContext,
  generatedAt: string,
): Osha301Report {
  const missing: string[] = [];
  const record = <T>(label: string, f: FormField<T>): FormField<T> => {
    if (f.reason) missing.push(`${label}: ${f.reason}`);
    return f;
  };

  const detail = inc.detail as Record<string, unknown>;
  const dob = typeof detail["dateOfBirth"] === "string" ? (detail["dateOfBirth"] as string) : null;
  const hired = typeof detail["dateHired"] === "string" ? (detail["dateHired"] as string) : null;

  const timeOfEvent = present(inc.occurredAt.slice(11, 16));
  const beganWork =
    inc.hoursIntoShift != null
      ? present(shiftStartFrom(inc.occurredAt, inc.hoursIntoShift))
      : absent<string>(
          "Hours into shift is not recorded, so the time the employee began work cannot be derived.",
        );

  const bodyParts = [inc.bodyPart, ...(inc.additionalBodyParts ?? [])].filter(
    (b): b is string => typeof b === "string" && b !== "not_applicable",
  );

  return {
    form: "osha_301",
    caseNumber: inc.reference,
    incidentId: inc.id,
    employee: {
      name: record("employee name", injuredPersonName(inc, ctx)),
      jobTitle: record("job title", injuredPersonJobTitle(inc, ctx)),
      dateOfBirth: record(
        "date of birth",
        field(dob, "Date of birth is not held on the incident or the worker register."),
      ),
      dateHired: record(
        "date hired",
        field(hired, "Date hired is not held on the incident or the worker register."),
      ),
      employmentRelationship: record(
        "employment relationship",
        field(
          inc.injuredPersonType,
          "The injured person's employment relationship is not recorded. It determines whose 300 " +
            "log the case belongs on (1904.31), so it cannot be inferred.",
        ),
      ),
    },
    physician: {
      name: record(
        "physician",
        field(inc.treatmentProvider, "No treating physician or health-care professional is recorded."),
      ),
      facility: record(
        "facility",
        field(inc.hospitalName, "No treatment facility is recorded."),
      ),
      treatedInEmergencyRoom:
        inc.treatmentLevel === "emergency_department"
          ? present(true)
          : inc.treatmentLevel
            ? present(false)
            : record<boolean>(
                "treated in emergency room",
                absent("No treatment level is recorded, so this box cannot be answered."),
              ),
      hospitalisedOvernight:
        inc.treatmentLevel === "hospitalised"
          ? present(true)
          : inc.treatmentLevel
            ? present(false)
            : record<boolean>(
                "hospitalised overnight",
                absent("No treatment level is recorded, so this box cannot be answered."),
              ),
    },
    incident: {
      dateOfInjury: inc.occurredAt.slice(0, 10),
      timeOfEvent,
      timeEmployeeBeganWork: record("time employee began work", beganWork),
      whatWasEmployeeDoing: record(
        "what the employee was doing",
        field(
          inc.activityAtTime,
          "The activity at the time of the event is not recorded. It is the first question on the " +
            "form and the one an investigator reconstructs least reliably after the fact.",
        ),
      ),
      whatHappened: inc.description,
      whatWasTheInjury: record(
        "what the injury was",
        bodyParts.length > 0 || inc.injuryNature
          ? present(
              `${inc.injuryNature ? labelise(inc.injuryNature) : "injury"}${
                bodyParts.length > 0 ? ` to the ${bodyParts.map(labelise).join(", ")}` : ""
              }`,
            )
          : absent<string>("Neither the nature of the injury nor the body part is coded."),
      ),
      whatObjectHarmed: record(
        "what object or substance harmed the employee",
        field(
          inc.immediateCause ?? (inc.mechanism ? labelise(inc.mechanism) : null),
          "Neither an immediate cause nor a mechanism is recorded.",
        ),
      ),
      dateOfDeath: asBool(inc.isFatality)
        ? record(
            "date of death",
            field(
              typeof detail["fatalityOccurredAt"] === "string"
                ? (detail["fatalityOccurredAt"] as string).slice(0, 10)
                : null,
              "The case is a fatality but no date of death is recorded.",
            ),
          )
        : present(""),
    },
    missing,
    caveats:
      missing.length > 0
        ? [
            `${missing.length} field(s) on this 301 could not be filled from the register. The form is ` +
              `due within seven calendar days of learning of the case — complete them on the record, ` +
              `not on the paper, so the next document generated is right too.`,
          ]
        : [],
    generatedAt,
    disclaimer: OSHA_DISCLAIMER,
  };
}

function shiftStartFrom(occurredAt: string, hoursIntoShift: number): string {
  const start = new Date(Date.parse(occurredAt) - hoursIntoShift * 3_600_000);
  return start.toISOString().slice(11, 16);
}

/* ================================================================== */
/* RIDDOR F2508 / F2508A                                               */
/* ================================================================== */

export interface RiddorReport {
  form: "riddor_f2508" | "riddor_f2508a";
  caseNumber: string;
  incidentId: string;
  /** which RIDDOR regulation the report is made under */
  regulation: FormField<string>;
  category: FormField<string>;
  aboutTheIncident: {
    date: string;
    time: FormField<string>;
    location: FormField<string>;
    localAuthority: FormField<string>;
    whatHappened: string;
    kindOfAccident: FormField<string>;
  };
  aboutThePerson: {
    name: FormField<string>;
    age: FormField<number>;
    jobTitle: FormField<string>;
    status: FormField<string>;
    employer: FormField<string>;
  };
  theInjury: {
    nature: FormField<string>;
    bodyPart: FormField<string>;
    takenToHospital: FormField<boolean>;
    becameUnconscious: FormField<boolean>;
    hospitalStayOver24Hours: FormField<boolean>;
    daysUnableToWork: FormField<number>;
  };
  deadline: { dueAt: string | null; basis: string | null; notified: boolean };
  missing: string[];
  caveats: string[];
  generatedAt: string;
  disclaimer: string;
}

const RIDDOR_DISCLAIMER =
  "This is a prefill of the HSE's online report, assembled from the incident record and the stored " +
  "determination. RIDDOR places the duty on the responsible person: read every field, complete the " +
  "ones marked missing, and submit through the HSE's own service — nothing here is transmitted.";

const RIDDOR_REGULATION: Record<string, string> = {
  death: "reg. 6(1) — death of a worker (report by the quickest practicable means, then within 10 days)",
  specified_injury: "reg. 4 — specified injury to a worker (Schedule 1)",
  over_7_day_incapacitation: "reg. 4(3) — over-seven-day incapacitation (report within 15 days)",
  over_3_day_recordable: "reg. 12 — over-three-day incapacitation (record only; not reportable)",
  occupational_disease: "reg. 8/9 — reportable occupational disease on written diagnosis",
  dangerous_occurrence: "reg. 7 — dangerous occurrence (Schedule 2)",
  gas_incident: "reg. 11 — reportable gas incident",
  not_reportable: "no reporting regulation is engaged on the facts held",
  under_assessment: "the RIDDOR classification has not been settled",
};

/**
 * The F2508 prefill. Where the online form asks a yes/no question the record
 * cannot answer, the field is null with the question restated — a "no" that
 * was never asked is the answer most likely to be wrong, and on this form it
 * is the answer that decides whether the report was required at all.
 */
export function buildRiddorF2508(
  inc: FormIncident,
  ctx: FormContext,
  determination: ReportabilityDetermination | null,
  generatedAt: string,
): RiddorReport {
  const missing: string[] = [];
  const record = <T>(label: string, f: FormField<T>): FormField<T> => {
    if (f.reason) missing.push(`${label}: ${f.reason}`);
    return f;
  };

  const category = inc.riddorCategory;
  const isDisease = category === "occupational_disease";
  const inputs = (inc.detail as { reportabilityInputs?: Record<string, unknown> })
    .reportabilityInputs;

  const readBool = (key: string): boolean | null => {
    const value = inputs?.[key];
    return typeof value === "boolean" ? value : null;
  };

  const governing = determination?.rules.find((r) => r.ruleId === determination.governingRuleId);

  const hospital = readBool("hospitalAdmission")
    ? true
    : typeof inputs?.["hospitalAdmission"] === "string"
      ? inputs["hospitalAdmission"] !== "none"
      : inc.treatmentLevel === "hospitalised" || inc.treatmentLevel === "emergency_department"
        ? true
        : null;

  return {
    form: isDisease ? "riddor_f2508a" : "riddor_f2508",
    caseNumber: inc.reference,
    incidentId: inc.id,
    regulation: record(
      "regulation",
      field(
        category ? RIDDOR_REGULATION[category] : null,
        "The incident carries no RIDDOR classification, so the regulation the report is made under " +
          "cannot be stated. Assess reportability with `riddor` in the regimes first.",
      ),
    ),
    category: field(category, "No RIDDOR category is stored on the incident."),
    aboutTheIncident: {
      date: inc.occurredAt.slice(0, 10),
      time: present(inc.occurredAt.slice(11, 16)),
      location: record("location", whereOccurred(inc, ctx)),
      localAuthority: record(
        "local authority",
        field(
          ctx.city,
          "The project record holds no town or local authority, which the form asks for to route " +
            "the report to the right enforcing authority.",
        ),
      ),
      whatHappened: inc.description,
      kindOfAccident: record(
        "kind of accident",
        field(
          inc.mechanism ? labelise(inc.mechanism) : null,
          "No mechanism is coded on the incident; the form's “kind of accident” list is the " +
            "same taxonomy.",
        ),
      ),
    },
    aboutThePerson: {
      name: record("injured person", injuredPersonName(inc, ctx)),
      age: record(
        "age",
        field(inc.injuredPersonAge, "The injured person's age is not recorded."),
      ),
      jobTitle: record("job title", injuredPersonJobTitle(inc, ctx)),
      status: record(
        "employment status",
        field(
          inc.injuredPersonType,
          "The injured person's status is not recorded. RIDDOR asks it because the duty differs for " +
            "a worker, a self-employed person and a member of the public.",
        ),
      ),
      employer: field(
        inc.vendorId ? (ctx.vendorNames.get(inc.vendorId) ?? inc.vendorId) : null,
        "No employer is recorded against the injured person.",
      ),
    },
    theInjury: {
      nature: record(
        "nature of injury",
        field(inc.injuryNature ? labelise(inc.injuryNature) : null, "No injury nature is coded."),
      ),
      bodyPart: record(
        "part of body",
        field(inc.bodyPart ? labelise(inc.bodyPart) : null, "No body part is coded."),
      ),
      takenToHospital: record(
        "taken to hospital",
        hospital === null
          ? absent<boolean>(
              "Whether the person was taken to hospital is not recorded. On this form it is a " +
                "question the responsible person must answer, not one to leave blank.",
            )
          : present(hospital),
      ),
      becameUnconscious: record(
        "became unconscious",
        readBool("lossOfConsciousness") === null
          ? absent<boolean>("Loss of consciousness has not been assessed on this incident.")
          : present(readBool("lossOfConsciousness")!),
      ),
      hospitalStayOver24Hours: record(
        "stayed in hospital over 24 hours",
        typeof inputs?.["hospitalAdmission"] === "string"
          ? present(inputs["hospitalAdmission"] === "over_24h")
          : absent<boolean>(
              "The hospital-admission answer is not recorded. Over 24 hours as an in-patient is " +
                "itself a specified-injury test under Schedule 1.",
            ),
      ),
      daysUnableToWork: record(
        "days unable to work",
        field(
          inc.lostTimeDays,
          "No lost-time day count is recorded. It decides between the reg. 4(3) over-seven-day " +
            "report and the reg. 12 record-only duty.",
        ),
      ),
    },
    deadline: {
      dueAt: inc.reportDueAt,
      basis: governing ? `${governing.ruleId} — ${governing.citation}` : null,
      notified: (inc.reportableRegimes ?? []).length > 0 && inc.regulatorReference != null,
    },
    missing,
    caveats:
      missing.length > 0
        ? [
            `${missing.length} field(s) on this prefill could not be filled from the register. The HSE ` +
              `form will not accept several of them blank, and the ones it does accept are the ones an ` +
              `inspector asks about later.`,
          ]
        : [],
    generatedAt,
    disclaimer: RIDDOR_DISCLAIMER,
  };
}

/**
 * Canonical JSON for hashing: keys sorted at every level so two generations of
 * the same content hash identically regardless of property order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Map) return Object.fromEntries([...value.entries()].sort());
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}
