import type { BenefitStatus } from "@constructos/shared";
import { addDaysISO } from "../field/dates.js";

/**
 * Pure appraisal mathematics for owner-side capital governance (spec Vol II
 * Domain G / M12): HM Treasury Green Book style cost-benefit analysis with
 * discounting (#398), NPV and BCR (#399), optimism bias uplift (#402) and
 * benefits-realisation progress (#416-421). No I/O — unit-tested in
 * isolation; the API routes only orchestrate persistence around these.
 */

export interface AppraisalConfig {
  /**
   * Real discount rate, % p.a. The API defaults this to 3.5 — the HM
   * Treasury Green Book social time preference rate (#401); other
   * jurisdictions configure their own rate here.
   */
  discountRatePercent: number;
  /** Appraisal horizon in whole years (1-60). */
  appraisalYears: number;
  /**
   * Optimism bias uplift, % (#402). MODELLING CHOICE: the uplift is applied
   * to CAPEX ONLY (capexAdjusted = capex x (1 + OB%)), the dominant HM
   * Treasury guidance case for capital programmes. Operating-cost and
   * works-duration optimism bias are NOT modelled.
   */
  optimismBiasPercent: number;
}

export interface OptionCashflows {
  /** Up-front capital cost at year 0 (not discounted). */
  capex: number;
  /** Benefits per appraisal year, year 1 first. */
  annualBenefits: number[];
  /** Recurring (non-capex) costs per appraisal year, year 1 first. */
  annualCosts: number[];
}

export interface OptionAppraisal {
  /** capex x (1 + optimismBiasPercent/100), 2 dp. */
  capexAdjusted: number;
  /** Sum of annualBenefits_t / (1+r)^t over t = 1..appraisalYears, 2 dp. */
  pvBenefits: number;
  /** Sum of annualCosts_t / (1+r)^t over t = 1..appraisalYears, 2 dp. */
  pvCosts: number;
  /** -capexAdjusted + pvBenefits - pvCosts, 2 dp (#399). */
  npv: number;
  /** pvBenefits / (capexAdjusted + pvCosts), 4 dp; null when the denominator is 0. */
  bcr: number | null;
  /**
   * First year t (1-based) at which the UNDISCOUNTED cumulative net cashflow
   * -capexAdjusted + sum_{1..t}(benefits - costs) reaches >= 0; null if the
   * horizon ends first. Simple (undiscounted) payback by design — the
   * discounted view is what NPV/BCR are for. 0 when there is no adjusted
   * capex to recover.
   */
  paybackYear: number | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const EPS = 1e-9;

/**
 * Normalise an annual series to exactly `years` entries: missing years count
 * as 0, surplus years beyond the appraisal horizon are ignored (truncated).
 */
export function padToYears(series: number[], years: number): number[] {
  const out = series.slice(0, years);
  while (out.length < years) out.push(0);
  return out;
}

/**
 * Appraise one option under a config: optimism-bias-adjusted capex, present
 * values, NPV, BCR and simple payback (#398-399, #402).
 */
export function appraiseOption(option: OptionCashflows, config: AppraisalConfig): OptionAppraisal {
  const years = Math.max(1, Math.floor(config.appraisalYears));
  const r = config.discountRatePercent / 100;
  const benefits = padToYears(option.annualBenefits, years);
  const costs = padToYears(option.annualCosts, years);
  const capexAdjusted = option.capex * (1 + config.optimismBiasPercent / 100);

  let pvBenefits = 0;
  let pvCosts = 0;
  for (let t = 1; t <= years; t += 1) {
    const df = (1 + r) ** -t;
    pvBenefits += benefits[t - 1]! * df;
    pvCosts += costs[t - 1]! * df;
  }
  const npv = -capexAdjusted + pvBenefits - pvCosts;
  const bcrDenominator = capexAdjusted + pvCosts;
  const bcr = Math.abs(bcrDenominator) < EPS ? null : pvBenefits / bcrDenominator;

  let paybackYear: number | null = null;
  if (capexAdjusted <= EPS) {
    paybackYear = 0;
  } else {
    let cumulative = -capexAdjusted;
    for (let t = 1; t <= years; t += 1) {
      cumulative += benefits[t - 1]! - costs[t - 1]!;
      if (cumulative >= -EPS) {
        paybackYear = t;
        break;
      }
    }
  }

  return {
    capexAdjusted: round2(capexAdjusted),
    pvBenefits: round2(pvBenefits),
    pvCosts: round2(pvCosts),
    npv: round2(npv),
    bcr: bcr === null ? null : round4(bcr),
    paybackYear,
  };
}

/* ------------------------------------------------------------------ */
/* Benefits realisation (#416-421)                                     */
/* ------------------------------------------------------------------ */

/**
 * Progress from baseline toward target, % clamped to [0, 100].
 *
 * progress = (latest - baseline) / (target - baseline) x 100
 *
 * The SIGNED denominator makes the formula direction-aware: it works whether
 * the target sits above the baseline (a growing benefit) or below it (a
 * reduction target — the modelled shape for disbenefits, #420, where success
 * means driving the measure DOWN from its baseline). Movement away from the
 * target clamps to 0; overshoot beyond the target clamps to 100. The
 * degenerate target == baseline case reports 100 only when the latest
 * reading sits exactly on the target.
 */
export function benefitProgressPercent(
  baseline: number,
  target: number,
  latest: number,
): number {
  const denominator = target - baseline;
  if (Math.abs(denominator) < EPS) {
    return Math.abs(latest - target) < EPS ? 100 : 0;
  }
  const raw = ((latest - baseline) / denominator) * 100;
  return Math.min(100, Math.max(0, round2(raw)));
}

/** Grace period after the target date before a shortfall counts as missed. */
export const MISSED_GRACE_DAYS = 90;
/** Below this progress after the target date, a benefit is at risk. */
export const AT_RISK_PROGRESS_THRESHOLD = 70;
/** Progress at or above this is realised. */
export const REALISED_PROGRESS_THRESHOLD = 100;

/**
 * Benefit lifecycle status from latest progress (#418). Documented
 * thresholds:
 *  - planned   — no readings recorded yet (progressPercent null)
 *  - realised  — progress >= 100%
 *  - missed    — more than 90 days past the target date with progress < 100%
 *  - at_risk   — past the target date with progress < 70%
 *  - tracking  — everything else
 * Status is recomputed from the latest reading on every write, so a benefit
 * can move back out of at_risk/realised if later readings change the picture.
 */
export function benefitStatusFor(
  progressPercent: number | null,
  targetDate: string | null,
  todayIso: string,
): BenefitStatus {
  if (progressPercent === null) return "planned";
  if (progressPercent >= REALISED_PROGRESS_THRESHOLD) return "realised";
  if (targetDate) {
    if (todayIso > addDaysISO(targetDate, MISSED_GRACE_DAYS)) return "missed";
    if (todayIso > targetDate && progressPercent < AT_RISK_PROGRESS_THRESHOLD) return "at_risk";
  }
  return "tracking";
}
