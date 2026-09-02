/**
 * Exceptional weather (spec Vol II Z #1074–1076).
 *
 * An extension-of-time claim for weather is arithmetic on two things: what the
 * contract calls adverse, and how many adverse days a normal period holds.
 * This engine does that arithmetic and nothing else — it never decides
 * entitlement, and it never fills a gap in the record with a zero.
 *
 * The rules:
 *   • A day is ADVERSE when at least one threshold is breached. Each breach
 *     is recorded with the metric, the observed value and the limit, so the
 *     report can quote the clause next to the reading.
 *   • A threshold whose metric was NOT observed that day cannot be breached
 *     and cannot be "not breached": the day is UNDETERMINED for that metric
 *     and the reason is carried through to the report.
 *   • A day with NO usable readings at all is a gap in the record. Gaps are
 *     counted and reported as coverage; they are never counted as fair
 *     weather, which is the single most common way a weather claim is
 *     silently understated.
 *   • EXCEPTIONAL days = observed adverse days − baseline expected adverse
 *     days, per month, floored at zero per month (a mild January does not
 *     pay for a wet February) and only for months where a baseline exists.
 */

export interface WeatherReading {
  observedOn: string; // ISO date
  precipitationMm: number | null;
  snowfallMm: number | null;
  tempMinC: number | null;
  tempMaxC: number | null;
  windMeanKph: number | null;
  windGustKph: number | null;
  humidityPct: number | null;
  visibilityM: number | null;
  seaStateM: number | null;
  workStopped: number;
  hoursLost: number | null;
}

export interface Threshold {
  metric: string;
  comparator: string; // gte | lte | gt | lt
  value: number;
  label?: string;
}

export interface DayVerdict {
  date: string;
  adverse: boolean;
  /** true when no threshold could be evaluated for lack of readings */
  undetermined: boolean;
  reasons: string[];
  undeterminedMetrics: string[];
  workStopped: boolean;
  hoursLost: number | null;
}

const METRIC_FIELD: Record<string, keyof WeatherReading> = {
  precipitation_mm: "precipitationMm",
  snowfall_mm: "snowfallMm",
  temp_min_c: "tempMinC",
  temp_max_c: "tempMaxC",
  wind_mean_kph: "windMeanKph",
  wind_gust_kph: "windGustKph",
  humidity_pct: "humidityPct",
  visibility_m: "visibilityM",
  sea_state_m: "seaStateM",
};

const METRIC_UNIT: Record<string, string> = {
  precipitation_mm: "mm",
  snowfall_mm: "mm",
  temp_min_c: "°C",
  temp_max_c: "°C",
  wind_mean_kph: "km/h",
  wind_gust_kph: "km/h",
  humidity_pct: "%",
  visibility_m: "m",
  sea_state_m: "m",
};

function breaches(value: number, comparator: string, limit: number): boolean {
  switch (comparator) {
    case "gte":
      return value >= limit;
    case "gt":
      return value > limit;
    case "lte":
      return value <= limit;
    case "lt":
      return value < limit;
    default:
      return false;
  }
}

const COMPARATOR_WORD: Record<string, string> = {
  gte: "at or above",
  gt: "above",
  lte: "at or below",
  lt: "below",
};

/** Classify one day against the contract thresholds. */
export function classifyDay(reading: WeatherReading, thresholds: readonly Threshold[]): DayVerdict {
  const reasons: string[] = [];
  const undeterminedMetrics: string[] = [];
  let evaluated = 0;

  for (const threshold of thresholds) {
    const field = METRIC_FIELD[threshold.metric];
    if (!field) {
      undeterminedMetrics.push(threshold.metric);
      continue;
    }
    const raw = reading[field];
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      undeterminedMetrics.push(threshold.metric);
      continue;
    }
    evaluated += 1;
    if (breaches(raw, threshold.comparator, threshold.value)) {
      const unit = METRIC_UNIT[threshold.metric] ?? "";
      const word = COMPARATOR_WORD[threshold.comparator] ?? threshold.comparator;
      reasons.push(
        `${threshold.label ?? threshold.metric}: ${raw}${unit} is ${word} the limit of ${threshold.value}${unit}.`,
      );
    }
  }

  const adverse = reasons.length > 0;
  if (!adverse && reading.workStopped === 1) {
    // The site says it stopped; the readings do not support it. That is a
    // finding, not an adverse day — and it is stated, not hidden.
    reasons.push(
      "Work was reported stopped for weather but no contract threshold was breached on the readings held. This day is not counted as adverse.",
    );
  }

  return {
    date: reading.observedOn,
    adverse,
    undetermined: evaluated === 0,
    reasons,
    undeterminedMetrics: [...new Set(undeterminedMetrics)],
    workStopped: reading.workStopped === 1,
    hoursLost: typeof reading.hoursLost === "number" ? reading.hoursLost : null,
  };
}

export interface MonthRollup {
  month: string; // YYYY-MM
  days: number;
  observed: number;
  expected: number | null;
  exceptional: number | null;
  reasons: string[];
}

export interface WeatherAnalysis {
  periodStart: string;
  periodEnd: string;
  daysInPeriod: number;
  daysObserved: number;
  coveragePercent: number | null;
  observedAdverseDays: number;
  baselineAdverseDays: number | null;
  exceptionalDays: number | null;
  hoursLost: number | null;
  byMonth: MonthRollup[];
  adverseDayDetail: Array<{ date: string; reasons: string[]; hoursLost: number | null; workStopped: boolean }>;
  gapDates: string[];
  reasons: string[];
}

export function daysInclusive(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

function calendarDaysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * Compare an observation window against a baseline.
 *
 * `monthlyExpectedAdverseDays` is keyed "1".."12" and is pro-rated when the
 * window covers only part of a month: a claim over 10 days of a 31-day
 * January is compared with 10/31 of January's expected adverse days.
 */
export function analyseWeather(
  readings: readonly WeatherReading[],
  thresholds: readonly Threshold[],
  options: {
    periodStart: string;
    periodEnd: string;
    monthlyExpectedAdverseDays?: Record<string, number>;
  },
): WeatherAnalysis {
  const reasons: string[] = [];
  const daysInPeriod = daysInclusive(options.periodStart, options.periodEnd);

  const inWindow = readings
    .filter((r) => r.observedOn >= options.periodStart && r.observedOn <= options.periodEnd)
    .sort((a, b) => a.observedOn.localeCompare(b.observedOn));

  // One verdict per DAY: several sources may report the same date and the
  // strongest evidence of adversity wins, with every reason kept.
  const byDate = new Map<string, DayVerdict>();
  for (const reading of inWindow) {
    const verdict = classifyDay(reading, thresholds);
    const existing = byDate.get(verdict.date);
    if (!existing) {
      byDate.set(verdict.date, verdict);
      continue;
    }
    byDate.set(verdict.date, {
      date: verdict.date,
      adverse: existing.adverse || verdict.adverse,
      undetermined: existing.undetermined && verdict.undetermined,
      reasons: [...new Set([...existing.reasons, ...verdict.reasons])],
      undeterminedMetrics: [...new Set([...existing.undeterminedMetrics, ...verdict.undeterminedMetrics])],
      workStopped: existing.workStopped || verdict.workStopped,
      hoursLost:
        existing.hoursLost === null && verdict.hoursLost === null
          ? null
          : Math.max(existing.hoursLost ?? 0, verdict.hoursLost ?? 0),
    });
  }

  const verdicts = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const usable = verdicts.filter((v) => !v.undetermined);
  const daysObserved = usable.length;

  if (thresholds.length === 0) {
    reasons.push(
      "The baseline holds no thresholds, so no day can be tested against it. Add at least one threshold (for example precipitation ≥ 10 mm) before running the comparison.",
    );
  }
  if (daysObserved < daysInPeriod) {
    reasons.push(
      `${daysInPeriod - daysObserved} of ${daysInPeriod} day(s) in the period have no usable observation. Missing days are NOT counted as fair weather; the coverage figure states the gap.`,
    );
  }

  const gapDates: string[] = [];
  {
    const have = new Set(usable.map((v) => v.date));
    for (let i = 0; i < daysInPeriod; i += 1) {
      const d = new Date(Date.parse(`${options.periodStart}T00:00:00.000Z`) + i * 86_400_000)
        .toISOString()
        .slice(0, 10);
      if (!have.has(d)) gapDates.push(d);
    }
  }

  const adverse = usable.filter((v) => v.adverse);
  const observedAdverseDays = adverse.length;

  // Month buckets over the WINDOW (not the readings), so a month with no
  // readings still appears with its coverage gap visible.
  const monthKeys: string[] = [];
  {
    const cursor = new Date(Date.parse(`${options.periodStart}T00:00:00.000Z`));
    const endKey = options.periodEnd.slice(0, 7);
    while (cursor.toISOString().slice(0, 7) <= endKey) {
      monthKeys.push(cursor.toISOString().slice(0, 7));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
      if (monthKeys.length > 600) break;
    }
  }

  const expected = options.monthlyExpectedAdverseDays ?? {};
  const hasBaselineExpectation = Object.keys(expected).length > 0;
  const byMonth: MonthRollup[] = [];
  let baselineTotal = 0;
  let exceptionalTotal = 0;
  let anyExpectation = false;

  for (const monthKey of monthKeys) {
    const [yearText, monthText] = monthKey.split("-");
    const year = Number(yearText);
    const month1 = Number(monthText);
    const monthDays = calendarDaysInMonth(year, month1);
    const firstOfMonth = `${monthKey}-01`;
    const lastOfMonth = `${monthKey}-${String(monthDays).padStart(2, "0")}`;
    const windowStart = firstOfMonth > options.periodStart ? firstOfMonth : options.periodStart;
    const windowEnd = lastOfMonth < options.periodEnd ? lastOfMonth : options.periodEnd;
    const daysInWindow = daysInclusive(windowStart, windowEnd);
    const observedThisMonth = adverse.filter((v) => v.date.slice(0, 7) === monthKey).length;
    const monthReasons: string[] = [];

    const rawExpected = expected[String(month1)];
    let expectedThisMonth: number | null = null;
    if (typeof rawExpected === "number" && Number.isFinite(rawExpected)) {
      anyExpectation = true;
      expectedThisMonth = Math.round(((rawExpected * daysInWindow) / monthDays) * 100) / 100;
      if (daysInWindow < monthDays) {
        monthReasons.push(
          `Baseline pro-rated: ${daysInWindow} of ${monthDays} days of month ${month1} are inside the period, so ${rawExpected} expected adverse day(s) becomes ${expectedThisMonth}.`,
        );
      }
    } else {
      monthReasons.push(
        `The baseline holds no expected adverse-day figure for month ${month1}; exceptional days cannot be computed for this month.`,
      );
    }

    const exceptionalThisMonth =
      expectedThisMonth === null ? null : Math.round(Math.max(0, observedThisMonth - expectedThisMonth) * 100) / 100;
    if (expectedThisMonth !== null) baselineTotal += expectedThisMonth;
    if (exceptionalThisMonth !== null) exceptionalTotal += exceptionalThisMonth;

    const observedDaysThisMonth = usable.filter((v) => v.date.slice(0, 7) === monthKey).length;
    if (observedDaysThisMonth < daysInWindow) {
      monthReasons.push(
        `${daysInWindow - observedDaysThisMonth} day(s) of this month have no usable observation.`,
      );
    }

    byMonth.push({
      month: monthKey,
      days: daysInWindow,
      observed: observedThisMonth,
      expected: expectedThisMonth,
      exceptional: exceptionalThisMonth,
      reasons: monthReasons,
    });
  }

  if (!hasBaselineExpectation) {
    reasons.push(
      "The baseline holds no monthly expected adverse-day figures, so the number of EXCEPTIONAL days cannot be derived. The observed adverse-day count stands on its own.",
    );
  }

  const hoursLostValues = adverse.map((v) => v.hoursLost).filter((h): h is number => typeof h === "number");
  const hoursLost = hoursLostValues.length > 0 ? Math.round(hoursLostValues.reduce((a, b) => a + b, 0) * 100) / 100 : null;
  if (hoursLostValues.length === 0 && observedAdverseDays > 0) {
    reasons.push("No lost-hours figure was recorded against any adverse day, so lost time is not available.");
  }

  return {
    periodStart: options.periodStart,
    periodEnd: options.periodEnd,
    daysInPeriod,
    daysObserved,
    coveragePercent: daysInPeriod > 0 ? Math.round((daysObserved / daysInPeriod) * 1000) / 10 : null,
    observedAdverseDays,
    baselineAdverseDays: anyExpectation ? Math.round(baselineTotal * 100) / 100 : null,
    exceptionalDays: anyExpectation ? Math.round(exceptionalTotal * 100) / 100 : null,
    hoursLost,
    byMonth,
    adverseDayDetail: adverse.map((v) => ({
      date: v.date,
      reasons: v.reasons,
      hoursLost: v.hoursLost,
      workStopped: v.workStopped,
    })),
    gapDates,
    reasons,
  };
}
