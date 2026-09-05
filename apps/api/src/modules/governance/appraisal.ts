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

/* ================================================================== */
/* Platform upgrade wave — EIRR, sensitivity and switching values      */
/* (#400, #406)                                                        */
/* ================================================================== */

/**
 * The undiscounted net cashflow series an option produces:
 * year 0 = −capexAdjusted, years 1..n = benefits − costs.
 * Exported because the EIRR and switching-value routines both need exactly
 * this series and a second construction of it would be a second definition.
 */
export function netCashflows(option: OptionCashflows, config: AppraisalConfig): number[] {
  const years = Math.max(1, Math.floor(config.appraisalYears));
  const benefits = padToYears(option.annualBenefits, years);
  const costs = padToYears(option.annualCosts, years);
  const capexAdjusted = option.capex * (1 + config.optimismBiasPercent / 100);
  const out = [-capexAdjusted];
  for (let t = 0; t < years; t += 1) out.push(benefits[t]! - costs[t]!);
  return out;
}

/** NPV of a cashflow series at rate r (fraction), year 0 undiscounted. */
export function npvOf(cashflows: number[], r: number): number {
  let npv = 0;
  for (let t = 0; t < cashflows.length; t += 1) npv += cashflows[t]! / (1 + r) ** t;
  return npv;
}

/**
 * Economic internal rate of return (#400): the discount rate at which NPV
 * is zero, found by bisection on [-0.99, 10].
 *
 * Returns null — never 0 — when the series has no sign change (an option
 * that never pays back has no IRR, and reporting one would be a lie) or
 * when the bracket does not contain a root. Bisection rather than
 * Newton–Raphson because it cannot diverge and the precision needed here is
 * four decimal places, not fifteen.
 */
export function economicIrr(
  cashflows: number[],
  options: { lower?: number; upper?: number; tolerance?: number; maxIterations?: number } = {},
): number | null {
  const hasPositive = cashflows.some((c) => c > EPS);
  const hasNegative = cashflows.some((c) => c < -EPS);
  if (!hasPositive || !hasNegative) return null;

  let lo = options.lower ?? -0.9999;
  let hi = options.upper ?? 10;
  const tol = options.tolerance ?? 1e-7;
  const maxIter = options.maxIterations ?? 200;
  let fLo = npvOf(cashflows, lo);
  let fHi = npvOf(cashflows, hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi)) return null;
  if (fLo * fHi > 0) return null; // no root inside the bracket

  for (let i = 0; i < maxIter; i += 1) {
    const mid = (lo + hi) / 2;
    const fMid = npvOf(cashflows, mid);
    if (!Number.isFinite(fMid)) return null;
    if (Math.abs(fMid) < tol || hi - lo < tol) {
      return round4(mid * 100);
    }
    if (fLo * fMid <= 0) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return round4(((lo + hi) / 2) * 100);
}

export interface SensitivityCell {
  /** which input was flexed */
  variable: "capex" | "benefits" | "costs" | "discountRate";
  /** the % change applied (e.g. −20, +10) */
  changePercent: number;
  npv: number;
  bcr: number | null;
}

export interface SwitchingValue {
  variable: "capex" | "benefits" | "costs" | "discountRate";
  /**
   * The % change in that variable that drives NPV to zero. null when no
   * change within ±1000% does so (an option that is viable at any plausible
   * capex has no switching value, and inventing one would mislead).
   */
  changePercent: number | null;
  /** the resulting absolute level of the variable at the switching point */
  switchesAt: number | null;
  note: string;
}

export interface SensitivityAnalysis {
  /**
   * NPV/BCR with one variable flexed at a time by ±10/20/30% (a RELATIVE
   * change, including for the discount rate: −20% of a 3.5% rate is 2.8%).
   */
  grid: SensitivityCell[];
  switching: SwitchingValue[];
  /** ranked |ΔNPV| per variable at ±20% — the tornado ordering */
  tornado: { variable: string; low: number; high: number; swing: number }[];
  basis: string;
}

const SENSITIVITY_STEPS = [-30, -20, -10, 10, 20, 30] as const;

function flex(
  option: OptionCashflows,
  config: AppraisalConfig,
  variable: SensitivityCell["variable"],
  changePercent: number,
): { option: OptionCashflows; config: AppraisalConfig } {
  const factor = 1 + changePercent / 100;
  switch (variable) {
    case "capex":
      return { option: { ...option, capex: option.capex * factor }, config };
    case "benefits":
      return {
        option: { ...option, annualBenefits: option.annualBenefits.map((v) => v * factor) },
        config,
      };
    case "costs":
      return {
        option: { ...option, annualCosts: option.annualCosts.map((v) => v * factor) },
        config,
      };
    case "discountRate":
      return {
        option,
        config: { ...config, discountRatePercent: config.discountRatePercent * factor },
      };
  }
}

/**
 * Bisect the % change in one variable that drives NPV to zero (#406). The
 * search runs over [-99%, +1000%]; outside that range the answer is "no
 * plausible change switches this decision", which is reported as null.
 */
export function switchingValue(
  option: OptionCashflows,
  config: AppraisalConfig,
  variable: SensitivityCell["variable"],
): SwitchingValue {
  const npvAt = (change: number): number => {
    const flexed = flex(option, config, variable, change);
    return appraiseOption(flexed.option, flexed.config).npv;
  };

  const base = npvAt(0);
  const lowBound = -99;
  const highBound = 1000;
  // NPV moves monotonically in each of these variables, so the sign of the
  // base value tells us which direction to search.
  const fLow = npvAt(lowBound);
  const fHigh = npvAt(highBound);
  let lo: number;
  let hi: number;
  if (base === 0) {
    return {
      variable,
      changePercent: 0,
      switchesAt: absoluteLevel(option, config, variable, 0),
      note: "NPV is already zero at the base case.",
    };
  }
  if (fLow * base < 0) {
    lo = lowBound;
    hi = 0;
  } else if (fHigh * base < 0) {
    lo = 0;
    hi = highBound;
  } else {
    return {
      variable,
      changePercent: null,
      switchesAt: null,
      note:
        `No change to ${variable} between ${lowBound}% and +${highBound}% drives NPV to zero — ` +
        `the decision does not switch on this variable within any plausible range.`,
    };
  }

  let fLoCurrent = npvAt(lo);
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    const fMid = npvAt(mid);
    if (Math.abs(fMid) < 0.005 || hi - lo < 1e-6) {
      return {
        variable,
        changePercent: round2(mid),
        switchesAt: absoluteLevel(option, config, variable, mid),
        note:
          `NPV reaches zero when ${variable} changes by ${round2(mid)}% from the base case ` +
          `(base NPV ${round2(base)}).`,
      };
    }
    if (fLoCurrent * fMid <= 0) {
      hi = mid;
    } else {
      lo = mid;
      fLoCurrent = fMid;
    }
  }
  const mid = (lo + hi) / 2;
  return {
    variable,
    changePercent: round2(mid),
    switchesAt: absoluteLevel(option, config, variable, mid),
    note: `NPV reaches zero at approximately a ${round2(mid)}% change in ${variable}.`,
  };
}

function absoluteLevel(
  option: OptionCashflows,
  config: AppraisalConfig,
  variable: SensitivityCell["variable"],
  changePercent: number,
): number {
  const factor = 1 + changePercent / 100;
  switch (variable) {
    case "capex":
      return round2(option.capex * factor);
    case "benefits":
      return round2(option.annualBenefits.reduce((s, v) => s + v, 0) * factor);
    case "costs":
      return round2(option.annualCosts.reduce((s, v) => s + v, 0) * factor);
    case "discountRate":
      return round4(config.discountRatePercent * factor);
  }
}

/**
 * The full sensitivity block persisted on each option (#406): a ±10/20/30%
 * grid on the three money inputs and the discount rate, switching values for
 * each, and a tornado ordering by NPV swing at ±20%.
 */
export function sensitivityAnalysis(
  option: OptionCashflows,
  config: AppraisalConfig,
): SensitivityAnalysis {
  const variables: SensitivityCell["variable"][] = ["capex", "benefits", "costs", "discountRate"];
  const grid: SensitivityCell[] = [];
  for (const variable of variables) {
    for (const changePercent of SENSITIVITY_STEPS) {
      const flexed = flex(option, config, variable, changePercent);
      const computed = appraiseOption(flexed.option, flexed.config);
      grid.push({ variable, changePercent, npv: computed.npv, bcr: computed.bcr });
    }
  }
  const tornado = variables
    .map((variable) => {
      const low = grid.find((c) => c.variable === variable && c.changePercent === -20)!.npv;
      const high = grid.find((c) => c.variable === variable && c.changePercent === 20)!.npv;
      return { variable, low, high, swing: round2(Math.abs(high - low)) };
    })
    .sort((a, b) => b.swing - a.swing);
  return {
    grid,
    switching: variables.map((v) => switchingValue(option, config, v)),
    tornado,
    basis:
      "NPV and BCR recomputed with one input flexed at a time (±10/20/30%), holding the rest at " +
      "the base case. Switching values are the change in each input that drives NPV to zero, " +
      "found by bisection over −99%…+1000%. Correlated movement between inputs is not modelled.",
  };
}
