/**
 * Measured detector precision and integrity exposure scoring
 * (spec Vol II Domain A #93-99, Vol III §6).
 *
 * TWO NUMBERS, BOTH ARGUABLE.
 *
 * PRECISION is what the reviewers said. Every disposition a human puts on a
 * signal is a labelled example: `confirmed`/`escalated` says the detector was
 * right, `false_positive` says it was wrong. Precision is confirmed ÷
 * (confirmed + false_positive) over a rolling window, and a detector that
 * falls below its configured floor is SUPPRESSED rather than argued with —
 * a detector nobody believes any more is worse than no detector, because it
 * trains people to dismiss the register.
 *
 * INTEGRITY EXPOSURE is 0..100, higher is worse. It is a weighted, decayed sum
 * of open findings about one subject — a project, a supplier, an approver —
 * where the weight of each finding is its severity × how far a reviewer has
 * taken it × how much that detector has earned the right to be believed. Every
 * component is returned with the score so it can be disagreed with line by
 * line. A number nobody can decompose is an accusation, not a measurement.
 *
 * PURE: rows in, numbers out, `now` always passed.
 */
import type { IntegrityBand } from "@constructos/shared";

/* ------------------------------------------------------------------ */
/* Precision                                                           */
/* ------------------------------------------------------------------ */

export interface ReviewedSignal {
  detector: string;
  disposition: string;
  createdAt: string;
}

export interface DetectorPrecision {
  detector: string;
  confirmed: number;
  falsePositive: number;
  reviewed: number;
  /** null when too few reviewed signals to say anything honest */
  precision: number | null;
  reason: string;
}

const TRUE_DISPOSITIONS = new Set(["confirmed", "escalated"]);
const FALSE_DISPOSITIONS = new Set(["false_positive"]);

/**
 * Precision per detector over the trailing `windowDays`.
 *
 * `minReviewed` is the honesty guard: two reviewed signals cannot produce a
 * precision figure worth suppressing a detector over, so below it the answer
 * is `null` with the reason, never a number that looks measured.
 */
export function detectorPrecision(
  rows: ReviewedSignal[],
  opts: { now: Date; windowDays?: number; minReviewed?: number } = { now: new Date() },
): DetectorPrecision[] {
  const windowDays = opts.windowDays ?? 180;
  const minReviewed = opts.minReviewed ?? 10;
  const cutoff = opts.now.getTime() - windowDays * 86_400_000;
  const byDetector = new Map<string, { confirmed: number; falsePositive: number }>();
  for (const row of rows) {
    const t = Date.parse(row.createdAt);
    if (!Number.isNaN(t) && t < cutoff) continue;
    const bucket = byDetector.get(row.detector) ?? { confirmed: 0, falsePositive: 0 };
    if (TRUE_DISPOSITIONS.has(row.disposition)) bucket.confirmed += 1;
    else if (FALSE_DISPOSITIONS.has(row.disposition)) bucket.falsePositive += 1;
    byDetector.set(row.detector, bucket);
  }
  const out: DetectorPrecision[] = [];
  for (const [detector, b] of byDetector) {
    const reviewed = b.confirmed + b.falsePositive;
    if (reviewed < minReviewed) {
      out.push({
        detector,
        confirmed: b.confirmed,
        falsePositive: b.falsePositive,
        reviewed,
        precision: null,
        reason:
          `${reviewed} reviewed signal(s) in the last ${windowDays} days — fewer than the ` +
          `${minReviewed} needed before a precision figure means anything.`,
      });
      continue;
    }
    const precision = b.confirmed / reviewed;
    out.push({
      detector,
      confirmed: b.confirmed,
      falsePositive: b.falsePositive,
      reviewed,
      precision,
      reason:
        `${b.confirmed} confirmed / ${reviewed} reviewed over ${windowDays} days ` +
        `= ${(precision * 100).toFixed(1)}%.`,
    });
  }
  return out.sort((a, b) => a.detector.localeCompare(b.detector));
}

/** Is this detector suppressed by its measured precision? */
export function belowPrecisionFloor(
  measured: DetectorPrecision | undefined,
  floor: number | null | undefined,
): { suppressed: boolean; reason: string | null } {
  if (floor === null || floor === undefined) return { suppressed: false, reason: null };
  if (!measured || measured.precision === null) return { suppressed: false, reason: null };
  if (measured.precision >= floor) return { suppressed: false, reason: null };
  return {
    suppressed: true,
    reason:
      `measured precision ${(measured.precision * 100).toFixed(1)}% is below the configured ` +
      `floor of ${(floor * 100).toFixed(0)}% (${measured.confirmed}/${measured.reviewed} confirmed)`,
  };
}

/* ------------------------------------------------------------------ */
/* Integrity exposure                                                  */
/* ------------------------------------------------------------------ */

export interface ScorableSignal {
  id: string;
  detector: string;
  severity: string;
  disposition: string;
  createdAt: string;
}

export interface ScoreComponent {
  key: string;
  weight: number;
  contribution: number;
  basis: string;
}

export interface IntegrityScoreResult {
  score: number;
  band: IntegrityBand;
  openSignals: number;
  confirmedSignals: number;
  components: ScoreComponent[];
  /** null-safe explanation for a subject with no findings at all */
  basis: string;
}

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 40,
  high: 25,
  medium: 12,
  low: 5,
  info: 1,
};

/** How much a reviewer's disposition amplifies or discounts a finding. */
const DISPOSITION_FACTOR: Record<string, number> = {
  confirmed: 1,
  escalated: 1.2,
  under_review: 0.7,
  new: 0.6,
  closed: 0.15,
  false_positive: 0,
};

/** Half-life of a finding's weight, in days. Old findings fade; they do not vanish. */
export const SCORE_HALF_LIFE_DAYS = 90;

export function bandFor(score: number): IntegrityBand {
  if (score < 10) return "clear";
  if (score < 30) return "watch";
  if (score < 60) return "elevated";
  return "severe";
}

/**
 * Exposure score for one subject.
 *
 * `precisionByDetector` lets a detector nobody trusts contribute less than one
 * everybody does; an unmeasured detector is given 0.6, deliberately below 1,
 * so an unproven detector cannot drive a subject into "severe" on its own.
 */
export function integrityScore(
  signals: ScorableSignal[],
  opts: {
    now: Date;
    precisionByDetector?: Map<string, number | null>;
    unmeasuredPrecision?: number;
  },
): IntegrityScoreResult {
  const unmeasured = opts.unmeasuredPrecision ?? 0.6;
  const components: ScoreComponent[] = [];
  let raw = 0;
  let openSignals = 0;
  let confirmedSignals = 0;

  for (const s of signals) {
    const sev = SEVERITY_WEIGHT[s.severity] ?? 1;
    const disp = DISPOSITION_FACTOR[s.disposition] ?? 0.5;
    if (s.disposition !== "false_positive" && s.disposition !== "closed") openSignals += 1;
    if (s.disposition === "confirmed" || s.disposition === "escalated") confirmedSignals += 1;
    if (disp === 0) continue;
    const measured = opts.precisionByDetector?.get(s.detector);
    const trust = measured === null || measured === undefined ? unmeasured : measured;
    const t = Date.parse(s.createdAt);
    const ageDays = Number.isNaN(t) ? 0 : Math.max(0, (opts.now.getTime() - t) / 86_400_000);
    const decay = Math.pow(0.5, ageDays / SCORE_HALF_LIFE_DAYS);
    const contribution = sev * disp * trust * decay;
    if (contribution <= 0) continue;
    raw += contribution;
    components.push({
      key: `${s.detector}:${s.id}`,
      weight: sev,
      contribution,
      basis:
        `${s.severity} ${s.detector} (${s.disposition}) raised ${ageDays.toFixed(0)} days ago: ` +
        `severity ${sev} × disposition ${disp} × detector trust ${trust.toFixed(2)} × ` +
        `age decay ${decay.toFixed(2)} = ${contribution.toFixed(2)}`,
    });
  }

  // Saturating transform: the 30th medium finding should not read the same as
  // a nuclear event, and no finite number of findings can exceed 100.
  const score = Math.round(100 * (1 - Math.exp(-raw / 50)) * 10) / 10;
  components.sort((a, b) => b.contribution - a.contribution);
  return {
    score,
    band: bandFor(score),
    openSignals,
    confirmedSignals,
    components: components.slice(0, 25),
    basis:
      signals.length === 0
        ? "No integrity findings recorded for this subject. A score of 0 means nothing has been " +
          "raised — it is not a statement that nothing is wrong."
        : `Raw weighted exposure ${raw.toFixed(2)} over ${signals.length} finding(s), ` +
          `saturated to ${score} on 0..100 (100 × (1 − e^(−raw/50))). Half-life ` +
          `${SCORE_HALF_LIFE_DAYS} days.`,
  };
}
