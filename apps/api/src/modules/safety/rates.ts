/**
 * SAFETY — INCIDENT RATES (M21).
 *
 * A safety rate is a fraction, and the fraction is worthless without its
 * denominator. TRIR, LTIFR, DART and the severity rate all divide a count of
 * cases by HOURS ACTUALLY WORKED, and the single most common lie in
 * construction reporting is a denominator that was estimated, annualised, or
 * quietly taken from headcount because the hours were not to hand.
 *
 * So this file will not produce a rate it cannot support. When exposure hours
 * are missing the rate is `null` with a `reasons` array naming exactly what is
 * absent — the same shape `modules/benchmarks/metrics.ts` uses, because the
 * honesty rule is platform-wide and the UI renders one "not computable"
 * treatment for all of it. A published TRIR with an invented denominator is
 * worse than no TRIR: it goes into a prequalification questionnaire, it is
 * relied on by a client, and it is a misrepresentation.
 *
 * Exposure hours are read, in order of preference:
 *   1. `timecards.totalHours` — hours claimed and, where the module is in
 *      use, approved. The best available record of hours worked.
 *   2. `site_access_records.hoursOnSite` — turnstile / biometric presence.
 *      An independent stream, used when no timecards exist for the window.
 * Both are recorded on the result so a reader can see which one was used;
 * they are never summed, because the same hour appears in both.
 */

/** The multiplier convention a rate is expressed on. */
export interface RateBasis {
  /** 200_000 = per 100 full-time equivalent workers per year (OSHA) */
  multiplier: number;
  label: string;
}

export const OSHA_BASIS: RateBasis = {
  multiplier: 200_000,
  label: "per 100 full-time-equivalent workers per year (200,000 hours)",
};

export const MILLION_HOUR_BASIS: RateBasis = {
  multiplier: 1_000_000,
  label: "per 1,000,000 hours worked",
};

export interface ExposureHours {
  /** null when neither source holds hours for the window */
  hours: number | null;
  source: "timecards" | "site_access" | null;
  /** every candidate source and what it held, for auditability */
  inputs: {
    timecardHours: number | null;
    timecardCount: number;
    siteAccessHours: number | null;
    siteAccessCount: number;
    from: string;
    to: string;
  };
  reasons: string[];
}

export interface ExposureInput {
  timecardHours: number | null;
  timecardCount: number;
  siteAccessHours: number | null;
  siteAccessCount: number;
  from: string;
  to: string;
}

/**
 * Choose the exposure denominator. Preference, not summation: timecards and
 * turnstile records describe the same hours from two directions, and adding
 * them halves every rate on the site.
 */
export function resolveExposureHours(input: ExposureInput): ExposureHours {
  const reasons: string[] = [];
  if (input.timecardHours != null && input.timecardHours > 0) {
    return { hours: input.timecardHours, source: "timecards", inputs: input, reasons: [] };
  }
  if (input.timecardCount === 0) {
    reasons.push(
      `No timecards cover ${input.from} to ${input.to}, so no claimed-hours denominator exists.`,
    );
  } else if (input.timecardHours != null && input.timecardHours <= 0) {
    reasons.push(
      `${input.timecardCount} timecard(s) cover the window but they total ${input.timecardHours} hours — a zero denominator cannot produce a rate.`,
    );
  }
  if (input.siteAccessHours != null && input.siteAccessHours > 0) {
    return {
      hours: input.siteAccessHours,
      source: "site_access",
      inputs: input,
      reasons: [
        ...reasons,
        "Exposure hours were taken from site-access records rather than timecards. Turnstile presence " +
          "includes time on site that is not time worked, so the denominator is generous and the rates " +
          "are correspondingly conservative (lower than they would be on claimed hours).",
      ],
    };
  }
  if (input.siteAccessCount === 0) {
    reasons.push(
      `No site-access records cover ${input.from} to ${input.to} either, so there is no independent presence denominator.`,
    );
  } else {
    reasons.push(
      `${input.siteAccessCount} site-access record(s) cover the window but none carries an hours-on-site figure.`,
    );
  }
  reasons.push(
    "No rate is reported. A rate published against an estimated or annualised denominator is a " +
      "misrepresentation, not an approximation — record hours on timecards or capture site access, then reassess.",
  );
  return { hours: null, source: null, inputs: input, reasons };
}

export interface RateCounts {
  /** cases meeting the 300-log recording criteria (1904.7) */
  recordableCases: number;
  /** cases with one or more days away from work */
  lostTimeCases: number;
  /** days away + restricted/transfer cases (the DART numerator) */
  dartCases: number;
  fatalities: number;
  /** calendar days lost across all cases in the window */
  daysLost: number;
  /** all injury incidents, recordable or not */
  allInjuries: number;
  /** near misses — the leading indicator, reported for the ratio not a rate */
  nearMisses: number;
  /** cases whose classification is still open — they distort every rate */
  underAssessment: number;
  /**
   * Non-void incidents in the window that were never assessed under OSHA at
   * all. This is NOT the same as `underAssessment`, and conflating them was a
   * real defect: a GB project assessed only under RIDDOR carries
   * `oshaCaseType: "under_assessment"` on every incident because the question
   * was never asked, so counting recordable cases by OSHA case type returns
   * zero — and TRIR 0.00 published from a register holding specified injuries
   * reads, on a prequalification questionnaire, as a clean record.
   */
  unassessedForOsha: number;
}

export interface SafetyRate {
  key: string;
  name: string;
  /** null when the denominator is unavailable — never fabricated */
  value: number | null;
  unit: string;
  basis: string;
  formula: string;
  numerator: number;
  denominatorHours: number | null;
  inputs: Record<string, unknown>;
  reasons: string[];
  note: string | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function rate(
  key: string,
  name: string,
  numerator: number,
  exposure: ExposureHours,
  basis: RateBasis,
  formula: string,
  note: string | null,
  extraReasons: string[] = [],
  /** when set, the rate is refused whatever the denominator says */
  suppressedReason: string | null = null,
): SafetyRate {
  const common = {
    key,
    name,
    unit: basis.label,
    basis: basis.label,
    formula,
    numerator,
    denominatorHours: exposure.hours,
    inputs: {
      numerator,
      exposureHours: exposure.hours,
      exposureSource: exposure.source,
      multiplier: basis.multiplier,
      ...exposure.inputs,
    },
    note,
  };
  if (suppressedReason) {
    return { ...common, value: null, reasons: [suppressedReason, ...extraReasons] };
  }
  if (exposure.hours == null || exposure.hours <= 0) {
    return { ...common, value: null, reasons: [...exposure.reasons, ...extraReasons] };
  }
  return {
    ...common,
    value: round2((numerator * basis.multiplier) / exposure.hours),
    reasons: extraReasons,
  };
}

export interface SafetyRates {
  from: string;
  to: string;
  exposure: ExposureHours;
  counts: RateCounts;
  rates: SafetyRate[];
  /** any rate that could not be computed, for a one-line UI treatment */
  incomputable: string[];
  /** ratios that need no denominator in hours */
  ratios: {
    nearMissToInjury: number | null;
    reasons: string[];
  };
  caveats: string[];
}

/**
 * Compute the published rates for a window.
 *
 * TRIR and DART are on the OSHA 200,000-hour basis; LTIFR and the severity
 * rate on the 1,000,000-hour basis used in the UK and Australia. Both bases
 * are stated on every figure, because "LTIFR 2.1" means two different things
 * either side of the Atlantic and the number is routinely compared across the
 * boundary without anyone checking.
 */
export function computeSafetyRates(
  from: string,
  to: string,
  counts: RateCounts,
  exposure: ExposureHours,
): SafetyRates {
  const caveats: string[] = [];
  if (counts.underAssessment > 0) {
    caveats.push(
      `${counts.underAssessment} incident(s) in this window are still under assessment for ` +
        `recordability. They are EXCLUDED from every numerator here, so each rate is a floor, not ` +
        `a final figure — close the classifications and reassess.`,
    );
  }
  if (exposure.source === "site_access") {
    caveats.push(
      "The denominator is turnstile presence, not worked hours. Compare these rates with others " +
        "computed the same way only.",
    );
  }

  /**
   * TRIR and DART are OSHA constructions: their numerators are the 300 log's
   * own case classifications. On a project where OSHA was never assessed those
   * classifications do not exist, and counting them yields zero — a zero that
   * reads as "no recordable cases" when the truth is "nobody asked". So both
   * rates are refused with the reason, and the regime-neutral rates (lost-time
   * frequency, severity, fatality) are published as normal because their
   * numerators are facts about the injury rather than about a classification.
   */
  const oshaGap =
    counts.unassessedForOsha > 0
      ? `TRIR and DART are refused for this window. ${counts.unassessedForOsha} incident(s) here were ` +
        `never assessed under 29 CFR 1904 — the project's regimes do not include \`osha\` — so they ` +
        `carry no recordability classification at all. Counting recordable cases by OSHA case type ` +
        `would return a figure derived only from the incidents that happened to be assessed, and a ` +
        `TRIR of 0.00 on a register holding real injuries is not a low rate, it is a false statement ` +
        `on a prequalification questionnaire. Assess the incidents under OSHA if the establishment is ` +
        `subject to Part 1904; otherwise read the lost-time frequency rate below, which is ` +
        `regime-neutral.`
      : null;
  if (oshaGap) caveats.push(oshaGap);

  const rates: SafetyRate[] = [
    rate(
      "trir",
      "Total recordable incident rate (TRIR)",
      counts.recordableCases,
      exposure,
      OSHA_BASIS,
      "recordable cases × 200,000 ÷ hours worked",
      "The rate a client's prequalification questionnaire asks for. Its numerator is the 300 log, " +
        "so it is only as honest as the recordability classification behind it.",
      [],
      oshaGap,
    ),
    rate(
      "dart",
      "Days away, restricted or transferred rate (DART)",
      counts.dartCases,
      exposure,
      OSHA_BASIS,
      "(days-away + restricted/transfer cases) × 200,000 ÷ hours worked",
      "DART is the rate that resists the temptation TRIR creates — a case moved from days-away to " +
        "restricted duty leaves TRIR unchanged and leaves DART unchanged too.",
      [],
      oshaGap,
    ),
    rate(
      "ltifr",
      "Lost-time injury frequency rate (LTIFR)",
      counts.lostTimeCases,
      exposure,
      MILLION_HOUR_BASIS,
      "lost-time injuries × 1,000,000 ÷ hours worked",
      "Stated on the million-hour basis. The same figure on the OSHA 200,000-hour basis is five " +
        "times smaller; check the basis before comparing with anyone else's number.",
    ),
    rate(
      "severity_rate",
      "Severity rate",
      counts.daysLost,
      exposure,
      MILLION_HOUR_BASIS,
      "calendar days lost × 1,000,000 ÷ hours worked",
      "Days lost, not cases. A site with one serious injury and a low LTIFR has a high severity rate, " +
        "which is the pair of numbers worth reading together.",
    ),
    rate(
      "fatality_rate",
      "Fatality rate",
      counts.fatalities,
      exposure,
      MILLION_HOUR_BASIS,
      "fatalities × 1,000,000 ÷ hours worked",
      "Reported for completeness. On any single project the denominator is far too small for this " +
        "to be a rate in any statistical sense — read the count, not the rate.",
    ),
  ];

  const ratioReasons: string[] = [];
  let nearMissToInjury: number | null = null;
  if (counts.allInjuries > 0) {
    nearMissToInjury = round2(counts.nearMisses / counts.allInjuries);
  } else if (counts.nearMisses > 0) {
    ratioReasons.push(
      "No injuries were recorded in the window, so the near-miss-to-injury ratio has no denominator. " +
        `${counts.nearMisses} near miss(es) were reported — report the count.`,
    );
  } else {
    ratioReasons.push("No near misses and no injuries were recorded in the window.");
  }

  return {
    from,
    to,
    exposure,
    counts,
    rates,
    incomputable: rates.filter((r) => r.value === null).map((r) => r.key),
    ratios: { nearMissToInjury, reasons: ratioReasons },
    caveats,
  };
}
