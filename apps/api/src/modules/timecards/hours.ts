/**
 * TIMECARD ARITHMETIC — pure, no I/O (module M24).
 *
 * Three calculations live here so they can be unit-tested against
 * hand-worked numbers without a database, and so the rule that produced a
 * figure travels WITH the figure rather than being reconstructed from the
 * route that wrote it:
 *
 *  1. HOUR CLASSIFICATION. Which of a day's hours are plain time, which are
 *     overtime and which are double time. The thresholds come from the CREW,
 *     and the two rules in common use — daily (California-style: over 8 in a
 *     day) and weekly (over 40 in a week, whatever the daily shape) — give
 *     materially different answers on the same timesheet. So the applied rule
 *     is returned alongside the split, in words, and a crew that does not say
 *     which rule it runs gets `null` and a reason rather than a plausible
 *     guess (ADR: never fabricate a figure when an input is missing).
 *
 *  2. CLAIMED vs PRESENT. The timecard's hours against the hours the
 *     INDEPENDENT site-access stream (workforce.ts) recorded for the same
 *     worker on the same day. A MISSING access record is a gap in the
 *     turnstile data, not a zero: it returns a null variance with a reason.
 *     Treating an absent record as "0 hours present" would manufacture a
 *     fraud finding out of a data-quality problem, which is the fastest way
 *     to make an honest workforce distrust the control.
 *
 *  3. ALLOCATION RECONCILIATION. The hours coded to cost codes must equal the
 *     hours claimed on the card, bucket by bucket. A card whose allocations
 *     do not add up is either hours nobody can code or hours coded twice, and
 *     both land on the cost report as a lie.
 *
 * HOUR MODEL (stated once, relied on everywhere):
 *
 *     totalHours = regularHours + overtimeHours + doubleTimeHours + premiumHours
 *
 *   `premiumHours` are hours paid at a premium KIND (night shift, public
 *   holiday, confined space) instead of the ordinary ladder — they are carved
 *   out of the worked hours BEFORE the overtime thresholds are applied, so
 *   the identity above always holds and the allocation check is exact.
 *
 *   `idleHours` are a MEMO on the card: how many of its `totalHours` were
 *   unproductive (weather, waiting on materials). They are inside the total,
 *   never added to it, because the worker was paid for them.
 */

import type { PremiumKind, Shift } from "@constructos/shared";

/* ------------------------------------------------------------------ */
/* Numeric primitives                                                  */
/* ------------------------------------------------------------------ */

/** Hours to 2dp. Every hour figure that leaves this file passes through it. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A hundredth of an hour (36 seconds) — the tolerance on every hour balance. */
export const HOURS_EPSILON = 0.005;

export const nearlyEqual = (a: number, b: number, tolerance = HOURS_EPSILON): boolean =>
  Math.abs(a - b) <= tolerance;

/** Signed hours for prose: "+2.5" / "-0.75". Difference messages get quoted. */
export function formatDelta(n: number): string {
  const v = round2(n);
  return `${v > 0 ? "+" : ""}${v}`;
}

/**
 * The overlap between the cumulative interval a day's hours occupy and a
 * threshold band. This one function is BOTH overtime rules: the daily rule
 * runs it with a cumulative start of 0, the weekly rule with the hours
 * already banked earlier in the week. Doing it once is what makes the two
 * rules provably consistent at their boundaries.
 */
function bandOverlap(from: number, to: number, bandStart: number, bandEnd: number): number {
  return Math.max(0, Math.min(to, bandEnd) - Math.max(from, bandStart));
}

/* ------------------------------------------------------------------ */
/* 1. Hour classification                                              */
/* ------------------------------------------------------------------ */

/**
 * `daily`  — thresholds measured against the hours worked THAT DAY.
 * `weekly` — thresholds measured against the hours banked so far that WEEK,
 *            so the same 10-hour Wednesday is plain time in a slow week and
 *            all overtime in a busy one.
 * `none`   — an explicit configuration (salaried staff, all-in day rates):
 *            every hour is plain time. Distinct from "not configured",
 *            which produces a refusal rather than a classification.
 */
export const OVERTIME_RULE_KINDS = ["daily", "weekly", "none"] as const;
export type OvertimeRuleKind = (typeof OVERTIME_RULE_KINDS)[number];

export interface OvertimeRule {
  kind: OvertimeRuleKind;
  /** hours beyond which overtime applies, on the rule's own basis */
  thresholdHours: number | null;
  /** hours beyond which double time applies; null = no double-time band */
  doubleTimeThresholdHours: number | null;
  /** where the numbers came from, for the audit trail */
  source: string;
}

export interface ClassifyHoursInput {
  /** hours actually worked on the day, net of unpaid breaks */
  workedHours: number;
  /** hours of the day paid at a premium kind — carved out before the ladder */
  premiumHours?: number;
  premiumKind?: PremiumKind;
  /**
   * Ladder hours already banked earlier in the same pay week, EXCLUDING
   * premium hours. Ignored by the daily rule; load-bearing for the weekly one.
   */
  priorWeekLadderHours?: number;
  rule: OvertimeRule;
}

export interface HourSplit {
  regularHours: number;
  overtimeHours: number;
  doubleTimeHours: number;
  premiumHours: number;
  totalHours: number;
}

/** The rule as applied, in numbers and in words — returned, never buried. */
export interface AppliedOvertimeRule {
  kind: OvertimeRuleKind;
  basis: "day" | "week" | "none";
  thresholdHours: number | null;
  doubleTimeThresholdHours: number | null;
  /** the cumulative window this day occupied on the rule's basis */
  cumulativeFrom: number;
  cumulativeTo: number;
  source: string;
  explanation: string;
}

export interface HourClassification {
  /** null when the crew's configuration does not say how to classify */
  value: HourSplit | null;
  /** the rule actually applied; null alongside a null value */
  rule: AppliedOvertimeRule | null;
  inputs: Record<string, unknown>;
  /** why `value` is null; empty when a split was produced */
  reasons: string[];
}

const unclassifiable = (
  reasons: string[],
  inputs: Record<string, unknown>,
): HourClassification => ({ value: null, rule: null, inputs, reasons });

/**
 * Split a day's worked hours into plain time, overtime, double time and
 * premium under the crew's configured rule.
 *
 * Boundary convention: a threshold is the FIRST hour at the higher rate, so
 * exactly 8.0 worked against an 8-hour threshold is 8 plain and 0 overtime.
 * The convention matters — half the arguments about a timesheet are about the
 * hour that sits exactly on the line.
 */
export function classifyHours(input: ClassifyHoursInput): HourClassification {
  const worked = round2(input.workedHours);
  const premium = round2(input.premiumHours ?? 0);
  const prior = round2(input.priorWeekLadderHours ?? 0);
  const rule = input.rule;
  const inputs: Record<string, unknown> = {
    workedHours: worked,
    premiumHours: premium,
    premiumKind: input.premiumKind ?? "none",
    priorWeekLadderHours: prior,
    ruleKind: rule.kind,
    thresholdHours: rule.thresholdHours,
    doubleTimeThresholdHours: rule.doubleTimeThresholdHours,
  };

  if (!Number.isFinite(worked) || worked < 0) {
    return unclassifiable([`workedHours must be a non-negative number, got ${input.workedHours}.`], inputs);
  }
  if (!Number.isFinite(premium) || premium < 0) {
    return unclassifiable([`premiumHours must be a non-negative number, got ${input.premiumHours}.`], inputs);
  }
  if (premium > worked + HOURS_EPSILON) {
    return unclassifiable(
      [
        `premiumHours ${premium} exceeds the ${worked} hour(s) worked. Premium hours are a slice ` +
          "of the day, not an addition to it.",
      ],
      inputs,
    );
  }
  if (premium > 0 && (input.premiumKind ?? "none") === "none") {
    return unclassifiable(
      [
        `${premium} premium hour(s) were claimed with premiumKind "none". The kind is the part a ` +
          "client disputes on a T&M ticket, so an unnamed premium is not recorded.",
      ],
      inputs,
    );
  }

  const ladder = round2(worked - premium);

  if (rule.kind === "none") {
    return {
      value: {
        regularHours: ladder,
        overtimeHours: 0,
        doubleTimeHours: 0,
        premiumHours: premium,
        totalHours: round2(ladder + premium),
      },
      rule: {
        kind: "none",
        basis: "none",
        thresholdHours: null,
        doubleTimeThresholdHours: null,
        cumulativeFrom: 0,
        cumulativeTo: ladder,
        source: rule.source,
        explanation:
          `${rule.source} runs no overtime rule, so all ${ladder} ladder hour(s) are plain time. ` +
          "This is a configuration, not a default — a crew with no rule recorded is refused instead.",
      },
      inputs,
      reasons: [],
    };
  }

  if (rule.thresholdHours === null || !Number.isFinite(rule.thresholdHours)) {
    return unclassifiable(
      [
        `${rule.source} runs the ${rule.kind} overtime rule but records no overtime threshold, so ` +
          `the platform cannot say which of these ${worked} hour(s) are overtime. Set the crew's ` +
          "overtimeThresholdHours, or set its overtime rule to \"none\" if every hour is plain time.",
      ],
      inputs,
    );
  }
  const threshold = round2(rule.thresholdHours);
  if (threshold < 0) {
    return unclassifiable([`The overtime threshold on ${rule.source} is negative (${threshold}).`], inputs);
  }
  const dtThreshold =
    rule.doubleTimeThresholdHours === null || !Number.isFinite(rule.doubleTimeThresholdHours)
      ? null
      : round2(rule.doubleTimeThresholdHours);
  if (dtThreshold !== null && dtThreshold < threshold) {
    return unclassifiable(
      [
        `The double-time threshold on ${rule.source} (${dtThreshold}) sits below its overtime ` +
          `threshold (${threshold}). Double time is the band ABOVE overtime, never below it.`,
      ],
      inputs,
    );
  }

  const from = rule.kind === "weekly" ? prior : 0;
  const to = round2(from + ladder);
  const dtStart = dtThreshold ?? Number.POSITIVE_INFINITY;

  const regularHours = round2(bandOverlap(from, to, 0, threshold));
  const overtimeHours = round2(bandOverlap(from, to, threshold, dtStart));
  const doubleTimeHours = round2(
    dtThreshold === null ? 0 : bandOverlap(from, to, dtStart, Number.POSITIVE_INFINITY),
  );

  const basis = rule.kind === "weekly" ? "week" : "day";
  const dtClause =
    dtThreshold === null
      ? "no double-time band is configured"
      : `hours beyond ${dtThreshold} per ${basis} are double time`;
  const weekClause =
    rule.kind === "weekly"
      ? ` ${prior} hour(s) were already banked this week, so this day occupies hours ${from}–${to} of the week.`
      : "";
  const premiumClause =
    premium > 0
      ? ` ${premium} hour(s) were carved out first as ${input.premiumKind} premium and did not enter the ladder.`
      : "";

  return {
    value: {
      regularHours,
      overtimeHours,
      doubleTimeHours,
      premiumHours: premium,
      totalHours: round2(regularHours + overtimeHours + doubleTimeHours + premium),
    },
    rule: {
      kind: rule.kind,
      basis,
      thresholdHours: threshold,
      doubleTimeThresholdHours: dtThreshold,
      cumulativeFrom: from,
      cumulativeTo: to,
      source: rule.source,
      explanation:
        `${rule.source} runs the ${rule.kind} overtime rule: hours beyond ${threshold} per ${basis} ` +
        `are overtime and ${dtClause}.${weekClause}${premiumClause} A threshold is the first hour at ` +
        `the higher rate, so exactly ${threshold} hour(s) on the basis is still plain time.`,
    },
    inputs,
    reasons: [],
  };
}

/* ------------------------------------------------------------------ */
/* Cost of a classified day                                            */
/* ------------------------------------------------------------------ */

export interface HourRates {
  hourlyRate: number | null;
  overtimeRate: number | null;
  doubleTimeRate: number | null;
  premiumRate: number | null;
  /** on-costs as a MULTIPLIER on the base pay (1.35 = 35% burden) */
  burdenRate: number | null;
  currency: string;
}

export interface CostComputation {
  /** null when a rate for a non-zero bucket is missing — never a fabricated 0 */
  value: number | null;
  currency: string;
  inputs: Record<string, unknown>;
  reasons: string[];
}

/**
 * Cost the split. A missing multiplier for a bucket that has hours in it is a
 * REFUSAL, not a zero: an overtime hour costed at nothing is the single
 * easiest way to under-report labour on a cost report.
 *
 * Where a bucket's own rate is absent but the base rate is present, the
 * conventional multipliers (1.5×, 2×) are NOT assumed — the collective
 * agreement decides them and the platform does not hold it.
 */
export function costHours(split: HourSplit, rates: HourRates): CostComputation {
  const reasons: string[] = [];
  const inputs: Record<string, unknown> = { ...split, ...rates };
  const buckets: Array<[keyof HourSplit, number, number | null, string]> = [
    ["regularHours", split.regularHours, rates.hourlyRate, "hourlyRate"],
    ["overtimeHours", split.overtimeHours, rates.overtimeRate, "overtimeRate"],
    ["doubleTimeHours", split.doubleTimeHours, rates.doubleTimeRate, "doubleTimeRate"],
    ["premiumHours", split.premiumHours, rates.premiumRate, "premiumRate"],
  ];
  let base = 0;
  for (const [bucket, hours, rate, rateName] of buckets) {
    if (hours <= 0) continue;
    if (rate === null || !Number.isFinite(rate)) {
      reasons.push(
        `${hours} ${String(bucket).replace(/Hours$/, "")} hour(s) were claimed but no ${rateName} ` +
          "is recorded for this worker, so the cost of those hours is unknown rather than zero.",
      );
      continue;
    }
    base += hours * rate;
  }
  if (reasons.length > 0) return { value: null, currency: rates.currency, inputs, reasons };
  const burden = rates.burdenRate === null || !Number.isFinite(rates.burdenRate) ? 1 : rates.burdenRate;
  return { value: round2(base * burden), currency: rates.currency, inputs, reasons: [] };
}

/* ------------------------------------------------------------------ */
/* Clock times                                                         */
/* ------------------------------------------------------------------ */

const HHMM = /^(\d{2}):(\d{2})$/;

/** Minutes past midnight, or null when the string is not HH:MM. */
export function minutesOfDay(hhmm: string): number | null {
  const m = HHMM.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Elapsed hours from `start` to `end`, net of `breakMinutes`. An `end` at or
 * before `start` is read as crossing midnight (+24h) rather than as a
 * negative day — night shifts are the normal case on a site, not an error.
 * Returns null when either time is unreadable or the break swallows the shift.
 */
export function elapsedHours(
  start: string,
  end: string,
  breakMinutes = 0,
): { value: number | null; reasons: string[] } {
  const s = minutesOfDay(start);
  const e = minutesOfDay(end);
  if (s === null) return { value: null, reasons: [`startTime "${start}" is not a readable HH:MM time.`] };
  if (e === null) return { value: null, reasons: [`endTime "${end}" is not a readable HH:MM time.`] };
  const span = e > s ? e - s : e + 24 * 60 - s;
  const net = span - Math.max(0, breakMinutes);
  if (net < 0) {
    return {
      value: null,
      reasons: [
        `A ${breakMinutes}-minute break is longer than the ${round2(span / 60)} hour(s) between ` +
          `${start} and ${end}, so the worked hours would be negative.`,
      ],
    };
  }
  return { value: round2(net / 60), reasons: [] };
}

/* ------------------------------------------------------------------ */
/* 2. Claimed vs present (the ghost-worker check applied to cost)      */
/* ------------------------------------------------------------------ */

/**
 * How far a day's claim may sit above recorded presence before an
 * explanation is required. Half an hour absorbs a walk from the turnstile to
 * the workface, a gate scanner that missed a swipe on the way out, and
 * rounding to the quarter hour. Beyond it, somebody says why in writing.
 */
export const VARIANCE_TOLERANCE_HOURS = 0.5;

/** Days of unexplained positive variance in a window before it is a pattern. */
export const OVERCLAIM_PATTERN_MIN_DAYS = 3;
/** Unexplained positive hours in a window before it is a pattern. */
export const OVERCLAIM_PATTERN_MIN_HOURS = 4;
/** Days with no access record at all before the DATA GAP itself is reported. */
export const ACCESS_GAP_MIN_DAYS = 3;

export interface AccessVarianceInput {
  claimedHours: number;
  /** true when a site_access_records row exists for this worker and date */
  hasAccessRecord: boolean;
  /** hours from that record; may be null even when the record exists */
  accessHoursOnSite?: number | null;
  firstIn?: string | null;
  lastOut?: string | null;
  explanation?: string | null;
  toleranceHours?: number;
}

export interface AccessVarianceResult {
  /** claimed − present. NULL when presence is unknown; never a fabricated 0 */
  value: number | null;
  /** hours present, as used; null when the evidence stream has nothing */
  accessHours: number | null;
  /** where accessHours came from: the record's own figure or its gate times */
  accessHoursSource: "recorded" | "derived_from_gate_times" | null;
  direction: "over" | "under" | "match" | null;
  withinTolerance: boolean | null;
  toleranceHours: number;
  /** true when an explanation is owed and has not been given */
  requiresExplanation: boolean;
  explained: boolean;
  inputs: Record<string, unknown>;
  /** why `value` is null; empty when a variance was computed */
  reasons: string[];
}

/**
 * Compare a claim against the independent access record.
 *
 * THE MISSING-RECORD RULE. No access record for that worker on that date
 * returns `value: null` with a reason. It is NOT zero hours present. A gate
 * log with a hole in it — a broken turnstile, a worker inducted at a second
 * entrance, a manual sign-in sheet nobody typed up — would otherwise turn
 * every honest card that week into a maximal overclaim, and a control that
 * cries fraud at a data gap gets switched off within a month.
 */
export function accessVariance(input: AccessVarianceInput): AccessVarianceResult {
  const tolerance = input.toleranceHours ?? VARIANCE_TOLERANCE_HOURS;
  const claimed = round2(input.claimedHours);
  const explanation = (input.explanation ?? "").trim();
  const explained = explanation.length > 0;
  const inputs: Record<string, unknown> = {
    claimedHours: claimed,
    hasAccessRecord: input.hasAccessRecord,
    accessHoursOnSite: input.accessHoursOnSite ?? null,
    firstIn: input.firstIn ?? null,
    lastOut: input.lastOut ?? null,
    toleranceHours: tolerance,
  };
  const abstain = (reasons: string[]): AccessVarianceResult => ({
    value: null,
    accessHours: null,
    accessHoursSource: null,
    direction: null,
    withinTolerance: null,
    toleranceHours: tolerance,
    requiresExplanation: false,
    explained,
    inputs,
    reasons,
  });

  if (!input.hasAccessRecord) {
    return abstain([
      "No site-access record exists for this worker on this date, so the hours actually present " +
        "are unknown. A missing turnstile record is a gap in the evidence stream, not zero hours " +
        "on site, and it is deliberately NOT reported as a variance — that would manufacture a " +
        "fraud finding out of a data-quality problem.",
    ]);
  }

  let accessHours: number | null = null;
  let source: AccessVarianceResult["accessHoursSource"] = null;
  if (input.accessHoursOnSite !== null && input.accessHoursOnSite !== undefined && Number.isFinite(input.accessHoursOnSite)) {
    accessHours = round2(input.accessHoursOnSite);
    source = "recorded";
  } else if (input.firstIn && input.lastOut) {
    const derived = elapsedHours(input.firstIn, input.lastOut, 0);
    if (derived.value !== null) {
      accessHours = derived.value;
      source = "derived_from_gate_times";
    }
  }
  if (accessHours === null) {
    return abstain([
      "A site-access record exists for this worker and date but carries neither an hours-on-site " +
        "figure nor a readable in/out pair, so hours present cannot be derived. The claim is " +
        "neither confirmed nor contradicted.",
    ]);
  }

  const variance = round2(claimed - accessHours);
  const withinTolerance = Math.abs(variance) <= tolerance + HOURS_EPSILON;
  const direction = nearlyEqual(variance, 0) ? "match" : variance > 0 ? "over" : "under";
  return {
    value: variance,
    accessHours,
    accessHoursSource: source,
    direction,
    withinTolerance,
    toleranceHours: tolerance,
    requiresExplanation: !withinTolerance && !explained,
    explained,
    inputs,
    reasons: [],
  };
}

/** One card as the pattern detector sees it. */
export interface VarianceRow {
  timecardId: string;
  reference: string;
  workerId: string;
  workerReference: string;
  workerName: string;
  vendorId: string | null;
  workDate: string;
  shift: Shift | string;
  claimedHours: number;
  accessHours: number | null;
  varianceHours: number | null;
  explained: boolean;
  explanation: string | null;
  /** present when the variance could not be computed */
  reasons: string[];
}

export interface WorkerVariancePattern {
  workerId: string;
  workerReference: string;
  workerName: string;
  vendorId: string | null;
  days: number;
  daysCompared: number;
  /** days with NO access record — a data gap, never counted as an overclaim */
  daysWithoutAccessRecord: number;
  claimedHours: number;
  accessHours: number;
  /** Σ positive variance that nobody explained */
  unexplainedOverHours: number;
  unexplainedOverDays: number;
  explainedOverDays: number;
  underHours: number;
  /** true when the unexplained positive variance is a pattern, not a day */
  isOverclaimPattern: boolean;
  /** true when the ACCESS DATA is too sparse to conclude anything */
  isAccessGap: boolean;
  reason: string;
}

export interface VariancePatternSummary {
  periodStart: string;
  periodEnd: string;
  timecards: number;
  compared: number;
  withoutAccessRecord: number;
  overclaimPatterns: number;
  accessGaps: number;
  totals: {
    claimedHours: number;
    accessHours: number;
    unexplainedOverHours: number;
    underHours: number;
  };
  workers: WorkerVariancePattern[];
}

/**
 * Aggregate day-level variances into per-worker findings, in the shape the
 * workforce module's ghost-worker reconciliation uses (`reconcileWorkforce`):
 * conditions evaluated independently, the worst label reported, every figure
 * that drove the conclusion returned with it.
 *
 * Two conditions, deliberately kept apart:
 *  - OVERCLAIM PATTERN — repeated unexplained positive variance against
 *    records that DO exist. That is a finding about the claim.
 *  - ACCESS GAP — repeated absence of any access record. That is a finding
 *    about the turnstile feed, and it is never dressed up as the first.
 */
export function detectVariancePatterns(
  rows: VarianceRow[],
  period: { periodStart: string; periodEnd: string },
  options: {
    minDays?: number;
    minHours?: number;
    gapMinDays?: number;
    toleranceHours?: number;
  } = {},
): VariancePatternSummary {
  const minDays = options.minDays ?? OVERCLAIM_PATTERN_MIN_DAYS;
  const minHours = options.minHours ?? OVERCLAIM_PATTERN_MIN_HOURS;
  const gapMinDays = options.gapMinDays ?? ACCESS_GAP_MIN_DAYS;
  const tolerance = options.toleranceHours ?? VARIANCE_TOLERANCE_HOURS;

  const byWorker = new Map<string, VarianceRow[]>();
  for (const row of rows) {
    const list = byWorker.get(row.workerId);
    if (list) list.push(row);
    else byWorker.set(row.workerId, [row]);
  }

  const workers: WorkerVariancePattern[] = [];
  for (const [workerId, list] of byWorker) {
    const head = list[0]!;
    const compared = list.filter((r) => r.varianceHours !== null);
    const missing = list.filter((r) => r.varianceHours === null);
    const overRows = compared.filter((r) => (r.varianceHours ?? 0) > tolerance + HOURS_EPSILON);
    const unexplainedOver = overRows.filter((r) => !r.explained);
    const unexplainedOverHours = round2(
      unexplainedOver.reduce((s, r) => s + (r.varianceHours ?? 0), 0),
    );
    const underHours = round2(
      compared
        .filter((r) => (r.varianceHours ?? 0) < -tolerance - HOURS_EPSILON)
        .reduce((s, r) => s + Math.abs(r.varianceHours ?? 0), 0),
    );
    const isOverclaimPattern =
      unexplainedOver.length >= minDays || unexplainedOverHours >= minHours;
    const isAccessGap = missing.length >= gapMinDays;

    const parts: string[] = [];
    if (isOverclaimPattern) {
      parts.push(
        `${unexplainedOver.length} of ${compared.length} compared day(s) claim more than the site-access ` +
          `record shows, by ${unexplainedOverHours} unexplained hour(s) in total (tolerance ` +
          `${tolerance} h/day). Positive variance on its own is not proof of anything; a repeated ` +
          "positive variance nobody has explained is where to look",
      );
    }
    if (isAccessGap) {
      parts.push(
        `${missing.length} of ${list.length} day(s) have no usable site-access record, so those ` +
          "claims could be neither confirmed nor contradicted. This is a gap in the access feed, " +
          "NOT a finding against the worker",
      );
    }
    if (parts.length === 0) {
      parts.push(
        `${compared.length} day(s) compared against the access record within tolerance; ` +
          `${missing.length} day(s) had no usable record`,
      );
    }

    workers.push({
      workerId,
      workerReference: head.workerReference,
      workerName: head.workerName,
      vendorId: head.vendorId,
      days: list.length,
      daysCompared: compared.length,
      daysWithoutAccessRecord: missing.length,
      claimedHours: round2(list.reduce((s, r) => s + r.claimedHours, 0)),
      accessHours: round2(compared.reduce((s, r) => s + (r.accessHours ?? 0), 0)),
      unexplainedOverHours,
      unexplainedOverDays: unexplainedOver.length,
      explainedOverDays: overRows.length - unexplainedOver.length,
      underHours,
      isOverclaimPattern,
      isAccessGap,
      reason: parts.join("; "),
    });
  }

  workers.sort(
    (a, b) =>
      Number(b.isOverclaimPattern) - Number(a.isOverclaimPattern) ||
      b.unexplainedOverHours - a.unexplainedOverHours ||
      a.workerReference.localeCompare(b.workerReference),
  );

  return {
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    timecards: rows.length,
    compared: rows.filter((r) => r.varianceHours !== null).length,
    withoutAccessRecord: rows.filter((r) => r.varianceHours === null).length,
    overclaimPatterns: workers.filter((w) => w.isOverclaimPattern).length,
    accessGaps: workers.filter((w) => w.isAccessGap).length,
    totals: {
      claimedHours: round2(workers.reduce((s, w) => s + w.claimedHours, 0)),
      accessHours: round2(workers.reduce((s, w) => s + w.accessHours, 0)),
      unexplainedOverHours: round2(workers.reduce((s, w) => s + w.unexplainedOverHours, 0)),
      underHours: round2(workers.reduce((s, w) => s + w.underHours, 0)),
    },
    workers,
  };
}

/* ------------------------------------------------------------------ */
/* 3. Allocation reconciliation                                        */
/* ------------------------------------------------------------------ */

export const HOUR_BUCKETS = [
  "regularHours",
  "overtimeHours",
  "doubleTimeHours",
  "premiumHours",
] as const;
export type HourBucket = (typeof HOUR_BUCKETS)[number];

export interface AllocationHours {
  regularHours: number;
  overtimeHours: number;
  doubleTimeHours: number;
  premiumHours: number;
}

export interface BucketDifference {
  bucket: HourBucket | "totalHours";
  claimed: number;
  allocated: number;
  /** allocated − claimed; positive means the coding invents hours */
  difference: number;
}

export interface AllocationReconciliation {
  ok: boolean;
  claimed: HourSplit;
  allocated: HourSplit;
  differences: BucketDifference[];
  /** a message naming the difference, ready to be returned to the caller */
  message: string | null;
}

/**
 * The allocations must equal the card, bucket by bucket.
 *
 * Checked per bucket rather than on the total alone because the buckets carry
 * different rates: eight plain hours coded as eight overtime hours reconciles
 * perfectly on the total and overstates the cost report by half a day's pay.
 *
 * The refusal NAMES the difference — which bucket, by how much, in which
 * direction — because "allocations do not reconcile" is not something a
 * foreman at a kiosk can act on.
 */
export function reconcileAllocations(
  claimed: HourSplit,
  allocations: readonly Partial<AllocationHours>[],
): AllocationReconciliation {
  const allocatedBuckets: AllocationHours = {
    regularHours: 0,
    overtimeHours: 0,
    doubleTimeHours: 0,
    premiumHours: 0,
  };
  for (const a of allocations) {
    for (const bucket of HOUR_BUCKETS) {
      allocatedBuckets[bucket] += a[bucket] ?? 0;
    }
  }
  const allocated: HourSplit = {
    regularHours: round2(allocatedBuckets.regularHours),
    overtimeHours: round2(allocatedBuckets.overtimeHours),
    doubleTimeHours: round2(allocatedBuckets.doubleTimeHours),
    premiumHours: round2(allocatedBuckets.premiumHours),
    totalHours: round2(
      allocatedBuckets.regularHours +
        allocatedBuckets.overtimeHours +
        allocatedBuckets.doubleTimeHours +
        allocatedBuckets.premiumHours,
    ),
  };

  const differences: BucketDifference[] = [];
  for (const bucket of [...HOUR_BUCKETS, "totalHours"] as const) {
    const c = round2(claimed[bucket]);
    const a = round2(allocated[bucket]);
    if (!nearlyEqual(c, a)) {
      differences.push({ bucket, claimed: c, allocated: a, difference: round2(a - c) });
    }
  }
  if (differences.length === 0) {
    return { ok: true, claimed, allocated, differences, message: null };
  }

  const total = differences.find((d) => d.bucket === "totalHours");
  const buckets = differences.filter((d) => d.bucket !== "totalHours");
  const headline = total
    ? `${allocated.totalHours} hour(s) allocated against ${round2(claimed.totalHours)} hour(s) ` +
      `claimed — ${total.difference > 0 ? "over" : "short"} by ${round2(Math.abs(total.difference))} hour(s)`
    : `the hours balance in total but not by pay treatment`;
  const detail = buckets
    .map(
      (d) =>
        `${d.bucket.replace(/Hours$/, "")}: ${d.allocated} allocated vs ${d.claimed} claimed ` +
        `(${formatDelta(d.difference)})`,
    )
    .join("; ");

  return {
    ok: false,
    claimed,
    allocated,
    differences,
    message:
      `Allocations do not reconcile with the timecard — ${headline}. ${detail}. ` +
      "Every claimed hour is coded to exactly one cost code, in the pay treatment it was claimed " +
      "in, or the cost report is wrong in a way month-end will not find.",
  };
}
