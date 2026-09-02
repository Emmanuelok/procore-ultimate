/**
 * SAFETY — CONTRACTOR SCORECARD (spec Vol I #646, #661; Vol II owner-side
 * assurance).
 *
 * A prequalification questionnaire asks a subcontractor for their TRIR and
 * their accident history, and the subcontractor answers it. This file answers
 * the same questions from the records the site itself made: the observations
 * raised against that vendor, the corrective actions they were given and
 * whether they closed them on time, the inspections of their work, the NCRs
 * raised against them and whether the cost was backcharged, and — only where
 * the vendor's own hours exist on this project — their incident rate.
 *
 * THE HONESTY RULE IS SHARPER HERE THAN ANYWHERE ELSE IN THE MODULE. This
 * scorecard decides whether a firm is invited to tender. A metric computed on
 * a denominator we do not hold is not a slightly-wrong metric, it is a
 * defamation risk and a procurement challenge. So:
 *
 *   · TRIR appears only when the vendor's OWN timecard hours cover the window,
 *     and only when every incident counted was assessed under OSHA.
 *   · A vendor with no records is `unrated`, never "clean". Absence of a
 *     finding against a firm you never inspected is not a good safety record.
 *   · Money is bucketed by currency and never summed across them.
 *   · The composite grade is published only when enough components exist to
 *     carry it, and it always states what it was computed from.
 *
 * Pure: rows in, scorecard out. The caller aggregates; this file judges.
 */

import type { ExposureHours } from "./rates.js";

/* ================================================================== */
/* Inputs                                                              */
/* ================================================================== */

export interface VendorIncidentCounts {
  total: number;
  bySeverity: Record<string, number>;
  fatalities: number;
  lostTimeCases: number;
  /** OSHA-recordable cases, only meaningful when `oshaAssessedAll` is true */
  recordableCases: number;
  /** every counted incident was assessed under OSHA */
  oshaAssessedAll: boolean;
  /** incidents whose classification is still open */
  underAssessment: number;
  nearMisses: number;
}

export interface VendorObservationCounts {
  positive: number;
  negative: number;
  workStopped: number;
  highRisk: number;
}

export interface VendorActionCounts {
  total: number;
  open: number;
  overdue: number;
  closedOnTime: number;
  closedLate: number;
  weakControl: number;
  /** actions closed with an effectiveness verdict of ineffective */
  ineffective: number;
}

export interface VendorInspectionCounts {
  completed: number;
  passed: number;
  passedWithObservations: number;
  failed: number;
  criticalDefects: number;
}

export interface VendorNcrCounts {
  total: number;
  bySeverity: Record<string, number>;
  open: number;
  backcharged: number;
  /** cost impact bucketed by currency — never summed across them */
  costByCurrency: Record<string, number>;
}

export interface VendorProgrammeCounts {
  /** records belonging to this vendor that have expired and not been replaced */
  expired: number;
  /** records within 30 days of expiry */
  expiringSoon: number;
  active: number;
}

export interface VendorScorecardInput {
  vendorId: string;
  vendorName: string | null;
  projectId: string | null;
  from: string;
  to: string;
  incidents: VendorIncidentCounts;
  observations: VendorObservationCounts;
  actions: VendorActionCounts;
  inspections: VendorInspectionCounts;
  ncrs: VendorNcrCounts;
  programme: VendorProgrammeCounts;
  /** the vendor's OWN exposure hours on this project, when they exist */
  exposure: ExposureHours;
  /** briefings the vendor's crews attended in the window */
  toolboxTalksAttended: number;
  /** unacknowledged life-safety device alarms against this vendor's people */
  deviceAlarmsUnacknowledged: number;
}

/* ================================================================== */
/* Output                                                              */
/* ================================================================== */

export interface ScorecardMetric {
  key: string;
  name: string;
  /** null when the platform does not hold what the metric divides by */
  value: number | null;
  unit: string;
  /** higher is better (closure rate) or worse (incident rate) */
  direction: "higher_is_better" | "lower_is_better";
  basis: string;
  inputs: Record<string, number | string | null>;
  reasons: string[];
  /** 0-100 contribution to the composite, null when the metric is null */
  points: number | null;
  weight: number;
}

export interface VendorScorecard {
  vendorId: string;
  vendorName: string | null;
  projectId: string | null;
  from: string;
  to: string;
  metrics: ScorecardMetric[];
  /** 0-100, higher is better; null when too little is known */
  score: number | null;
  grade: "A" | "B" | "C" | "D" | "unrated";
  /** the share of the composite's weight that could actually be computed */
  coverage: number;
  recordCount: number;
  reasons: string[];
  flags: string[];
  computedAt: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const clamp = (n: number, lo = 0, hi = 100): number => Math.min(hi, Math.max(lo, n));

/**
 * Turn a rate into points: `best` scores 100, `worst` scores 0, linear in
 * between. Stated as data on each metric so a supplier challenging their grade
 * can be shown the scale rather than a black box.
 */
function pointsFor(value: number, best: number, worst: number): number {
  if (best === worst) return 100;
  const t = (value - worst) / (best - worst);
  return round2(clamp(t * 100));
}

/**
 * The composite. Weights are stated here rather than tuned, and the reason
 * each one is what it is fits in a sentence:
 *   · action closure (25) — the single most predictive behaviour a
 *     subcontractor exhibits; a firm that closes what it is given is a firm
 *     that will close the next thing;
 *   · incidents (20) — the outcome, weighted below the leading indicators
 *     because it is lagging and small-sample;
 *   · inspection pass rate (15) — the state of the work as somebody else found it;
 *   · NCR load (10), programme currency (10), observation reporting (10),
 *     weak-control share (10) — the texture.
 */
const WEIGHTS = {
  action_closure: 25,
  incidents: 20,
  inspection_pass: 15,
  ncr_load: 10,
  programme_currency: 10,
  observation_reporting: 10,
  weak_control: 10,
} as const;

export function buildVendorScorecard(
  input: VendorScorecardInput,
  computedAt: string,
): VendorScorecard {
  const metrics: ScorecardMetric[] = [];
  const flags: string[] = [];
  const reasons: string[] = [];

  /* ---- 1. corrective action closure ---- */
  const closedTotal = input.actions.closedOnTime + input.actions.closedLate;
  const closureDenominator = closedTotal + input.actions.overdue;
  if (closureDenominator > 0) {
    const rate = round2((input.actions.closedOnTime / closureDenominator) * 100);
    metrics.push({
      key: "action_closure_on_time",
      name: "Corrective actions closed by their due date",
      value: rate,
      unit: "%",
      direction: "higher_is_better",
      basis:
        "Actions owned by this vendor that were closed on or before their due date, over those " +
        "closed plus those still overdue. Actions not yet due are excluded — they are not evidence " +
        "either way.",
      inputs: {
        closedOnTime: input.actions.closedOnTime,
        closedLate: input.actions.closedLate,
        overdue: input.actions.overdue,
        open: input.actions.open,
      },
      reasons: [],
      points: pointsFor(rate, 100, 40),
      weight: WEIGHTS.action_closure,
    });
    if (input.actions.overdue >= 3) {
      flags.push(
        `${input.actions.overdue} corrective actions against this vendor are overdue. A hazard ` +
          `identified, owned and left is the worst evidential position after an event.`,
      );
    }
  } else {
    metrics.push({
      key: "action_closure_on_time",
      name: "Corrective actions closed by their due date",
      value: null,
      unit: "%",
      direction: "higher_is_better",
      basis: "No action owned by this vendor has fallen due in the window.",
      inputs: { closedOnTime: 0, closedLate: 0, overdue: 0, open: input.actions.open },
      reasons: [
        "No corrective action owned by this vendor has been closed or become overdue in the window, " +
          "so there is nothing to rate. This is not a good closure record; it is no record.",
      ],
      points: null,
      weight: WEIGHTS.action_closure,
    });
  }

  /* ---- 2. incident rate, only on the vendor's own hours ---- */
  const canRate =
    input.exposure.hours != null &&
    input.exposure.hours > 0 &&
    input.incidents.oshaAssessedAll &&
    input.incidents.underAssessment === 0;
  if (canRate) {
    const trir = round2((input.incidents.recordableCases * 200_000) / input.exposure.hours!);
    metrics.push({
      key: "trir",
      name: "Total recordable incident rate (this vendor, this project)",
      value: trir,
      unit: "per 200,000 hours",
      direction: "lower_is_better",
      basis:
        `Recordable cases against this vendor over their own recorded hours ` +
        `(${input.exposure.source ?? "unknown source"}). Computed only because every counted ` +
        `incident was assessed under OSHA and no classification is open.`,
      inputs: {
        recordableCases: input.incidents.recordableCases,
        exposureHours: input.exposure.hours!,
        exposureSource: input.exposure.source,
      },
      reasons: [],
      points: pointsFor(trir, 0, 6),
      weight: WEIGHTS.incidents,
    });
  } else {
    const why: string[] = [];
    if (input.exposure.hours == null || input.exposure.hours <= 0) {
      why.push(...input.exposure.reasons);
    }
    if (!input.incidents.oshaAssessedAll && input.incidents.total > 0) {
      why.push(
        "Not every incident against this vendor was assessed under OSHA, so a recordable-case count " +
          "would be a count of the ones that happened to be assessed. The case counts below are " +
          "real; the rate is not computed.",
      );
    }
    if (input.incidents.underAssessment > 0) {
      why.push(
        `${input.incidents.underAssessment} incident(s) against this vendor are still under ` +
          `assessment for recordability.`,
      );
    }
    metrics.push({
      key: "trir",
      name: "Total recordable incident rate (this vendor, this project)",
      value: null,
      unit: "per 200,000 hours",
      direction: "lower_is_better",
      basis: "Not computed — the denominator or the classification is missing.",
      inputs: {
        recordableCases: input.incidents.recordableCases,
        exposureHours: input.exposure.hours,
        exposureSource: input.exposure.source,
      },
      reasons: why,
      points: null,
      weight: WEIGHTS.incidents,
    });
  }

  if (input.incidents.fatalities > 0) {
    flags.push(
      `${input.incidents.fatalities} fatality/fatalities are recorded against this vendor in the ` +
        `window. No composite grade can carry that; read the incidents.`,
    );
  }
  if (input.incidents.lostTimeCases > 0) {
    flags.push(`${input.incidents.lostTimeCases} lost-time case(s) recorded against this vendor.`);
  }

  /* ---- 3. inspection pass rate ---- */
  if (input.inspections.completed > 0) {
    const passRate = round2(
      ((input.inspections.passed + input.inspections.passedWithObservations) /
        input.inspections.completed) *
        100,
    );
    metrics.push({
      key: "inspection_pass_rate",
      name: "Inspections of this vendor's work that passed",
      value: passRate,
      unit: "%",
      direction: "higher_is_better",
      basis:
        "Completed inspections naming this vendor, counting pass and pass-with-observations as a " +
        "pass. A critical defect fails the whole inspection whatever the score.",
      inputs: {
        completed: input.inspections.completed,
        passed: input.inspections.passed,
        passedWithObservations: input.inspections.passedWithObservations,
        failed: input.inspections.failed,
        criticalDefects: input.inspections.criticalDefects,
      },
      reasons: [],
      points: pointsFor(passRate, 100, 50),
      weight: WEIGHTS.inspection_pass,
    });
    if (input.inspections.criticalDefects > 0) {
      flags.push(
        `${input.inspections.criticalDefects} critical defect(s) were found on this vendor's work.`,
      );
    }
  } else {
    metrics.push({
      key: "inspection_pass_rate",
      name: "Inspections of this vendor's work that passed",
      value: null,
      unit: "%",
      direction: "higher_is_better",
      basis: "No completed inspection names this vendor in the window.",
      inputs: { completed: 0 },
      reasons: [
        "This vendor's work was not inspected in the window, or the inspections did not name them. " +
          "An uninspected vendor has no pass rate — not a perfect one.",
      ],
      points: null,
      weight: WEIGHTS.inspection_pass,
    });
  }

  /* ---- 4. NCR load ---- */
  const ncrDenominator = input.inspections.completed + input.observations.negative;
  if (input.ncrs.total > 0 || ncrDenominator > 0) {
    const ratio = ncrDenominator > 0 ? round2(input.ncrs.total / ncrDenominator) : null;
    metrics.push({
      key: "ncr_load",
      name: "Non-conformances raised against this vendor",
      value: ratio,
      unit: "NCRs per inspection/negative observation",
      direction: "lower_is_better",
      basis:
        "Quality NCRs naming this vendor as the responsible party, over the volume of scrutiny they " +
        "received. A raw NCR count punishes the most-inspected subcontractor.",
      inputs: {
        ncrs: input.ncrs.total,
        open: input.ncrs.open,
        backcharged: input.ncrs.backcharged,
        scrutiny: ncrDenominator,
      },
      reasons:
        ratio === null
          ? [
              "Neither an inspection nor a negative observation names this vendor in the window, so " +
                "there is no denominator for an NCR load.",
            ]
          : [],
      points: ratio === null ? null : pointsFor(ratio, 0, 1),
      weight: WEIGHTS.ncr_load,
    });
    const currencies = Object.keys(input.ncrs.costByCurrency);
    if (currencies.length > 1) {
      reasons.push(
        `NCR cost impact against this vendor is recorded in ${currencies.length} currencies ` +
          `(${currencies.join(", ")}). They are reported separately and never summed.`,
      );
    }
  } else {
    metrics.push({
      key: "ncr_load",
      name: "Non-conformances raised against this vendor",
      value: null,
      unit: "NCRs per inspection/negative observation",
      direction: "lower_is_better",
      basis: "No quality record names this vendor in the window.",
      inputs: { ncrs: 0, scrutiny: 0 },
      reasons: ["No NCR, inspection or negative observation names this vendor in the window."],
      points: null,
      weight: WEIGHTS.ncr_load,
    });
  }

  /* ---- 5. programme currency ---- */
  const programmeTotal =
    input.programme.active + input.programme.expired + input.programme.expiringSoon;
  if (programmeTotal > 0) {
    const current = round2((input.programme.active / programmeTotal) * 100);
    metrics.push({
      key: "programme_currency",
      name: "Safety documents in date",
      value: current,
      unit: "%",
      direction: "higher_is_better",
      basis:
        "This vendor's RAMS, competency cards, permits and plans that are active, over all of them. " +
        "An expired RAMS is not a paperwork lapse: the method being worked to has not been shown to " +
        "reflect the works as they are now.",
      inputs: {
        active: input.programme.active,
        expired: input.programme.expired,
        expiringSoon: input.programme.expiringSoon,
      },
      reasons: [],
      points: pointsFor(current, 100, 60),
      weight: WEIGHTS.programme_currency,
    });
    if (input.programme.expired > 0) {
      flags.push(
        `${input.programme.expired} of this vendor's safety documents have expired and not been ` +
          `superseded.`,
      );
    }
  } else {
    metrics.push({
      key: "programme_currency",
      name: "Safety documents in date",
      value: null,
      unit: "%",
      direction: "higher_is_better",
      basis: "This vendor has no safety programme records on the platform.",
      inputs: { active: 0, expired: 0, expiringSoon: 0 },
      reasons: [
        "No RAMS, competency card or plan is held for this vendor at all. That is a gap in the " +
          "evidence, not a clean sheet — a subcontractor working without a method statement on file " +
          "is the finding.",
      ],
      points: null,
      weight: WEIGHTS.programme_currency,
    });
  }

  /* ---- 6. observation reporting culture ---- */
  const observationTotal = input.observations.positive + input.observations.negative;
  if (observationTotal >= 3) {
    const positiveShare = round2((input.observations.positive / observationTotal) * 100);
    metrics.push({
      key: "observation_reporting",
      name: "Positive share of observations about this vendor",
      value: positiveShare,
      unit: "%",
      direction: "higher_is_better",
      basis:
        "Positive observations over all observations naming this vendor. A crew that is only ever " +
        "written up when something is wrong stops reporting; the ratio is the point of recording " +
        "positives at all.",
      inputs: {
        positive: input.observations.positive,
        negative: input.observations.negative,
        workStopped: input.observations.workStopped,
      },
      reasons: [],
      points: pointsFor(positiveShare, 40, 0),
      weight: WEIGHTS.observation_reporting,
    });
  } else {
    metrics.push({
      key: "observation_reporting",
      name: "Positive share of observations about this vendor",
      value: null,
      unit: "%",
      direction: "higher_is_better",
      basis: "Fewer than three observations name this vendor in the window.",
      inputs: {
        positive: input.observations.positive,
        negative: input.observations.negative,
      },
      reasons: [
        `${observationTotal} observation(s) name this vendor in the window — too few to read a ` +
          `ratio from without over-reading noise.`,
      ],
      points: null,
      weight: WEIGHTS.observation_reporting,
    });
  }
  if (input.observations.workStopped > 0) {
    flags.push(
      `Work was stopped ${input.observations.workStopped} time(s) on this vendor's activities.`,
    );
  }

  /* ---- 7. weak-control share ---- */
  if (input.actions.total >= 3) {
    const weakShare = round2((input.actions.weakControl / input.actions.total) * 100);
    metrics.push({
      key: "weak_control_share",
      name: "Actions answered with a briefing or PPE",
      value: weakShare,
      unit: "%",
      direction: "lower_is_better",
      basis:
        "Actions against this vendor whose control sits at the administrative or PPE end of the " +
        "hierarchy. A register full of “re-brief the operatives” is a register that will see the " +
        "same event again.",
      inputs: { weakControl: input.actions.weakControl, total: input.actions.total },
      reasons: [],
      points: pointsFor(weakShare, 20, 80),
      weight: WEIGHTS.weak_control,
    });
  } else {
    metrics.push({
      key: "weak_control_share",
      name: "Actions answered with a briefing or PPE",
      value: null,
      unit: "%",
      direction: "lower_is_better",
      basis: "Fewer than three actions are recorded against this vendor.",
      inputs: { weakControl: input.actions.weakControl, total: input.actions.total },
      reasons: [`${input.actions.total} action(s) recorded — too few to read a hierarchy profile.`],
      points: null,
      weight: WEIGHTS.weak_control,
    });
  }

  if (input.deviceAlarmsUnacknowledged > 0) {
    flags.push(
      `${input.deviceAlarmsUnacknowledged} device alarm(s) raised on this vendor's people were never ` +
        `acknowledged.`,
    );
  }

  /* ---- composite ---- */
  const available = metrics.filter((m) => m.points !== null);
  const totalWeight = metrics.reduce((s, m) => s + m.weight, 0);
  const availableWeight = available.reduce((s, m) => s + m.weight, 0);
  const coverage = totalWeight > 0 ? round2(availableWeight / totalWeight) : 0;

  const recordCount =
    input.incidents.total +
    input.observations.positive +
    input.observations.negative +
    input.actions.total +
    input.inspections.completed +
    input.ncrs.total;

  let score: number | null = null;
  let grade: VendorScorecard["grade"] = "unrated";
  if (coverage >= 0.5 && recordCount >= 3) {
    score = round2(
      available.reduce((s, m) => s + m.points! * m.weight, 0) / availableWeight,
    );
    grade = score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : "D";
  } else {
    reasons.push(
      coverage < 0.5
        ? `Only ${Math.round(coverage * 100)}% of the scorecard's weight could be computed from the ` +
          `records held, so no composite grade is published. A grade carried by two of seven ` +
          `components is a guess wearing a letter.`
        : `Only ${recordCount} safety or quality record names this vendor in the window — too few to ` +
          `grade. An unrated vendor is one you have not measured, not a safe one.`,
    );
  }
  if (input.incidents.fatalities > 0 && score !== null) {
    reasons.push(
      "A fatality is recorded in this window. The composite is published for completeness, but no " +
        "grade should be read across it — go to the incident.",
    );
  }

  return {
    vendorId: input.vendorId,
    vendorName: input.vendorName,
    projectId: input.projectId,
    from: input.from,
    to: input.to,
    metrics,
    score,
    grade,
    coverage,
    recordCount,
    reasons,
    flags,
    computedAt,
  };
}
