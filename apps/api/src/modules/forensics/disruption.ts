/**
 * Disruption quantification (spec Vol II Domain D #290-293) — pure.
 *
 * Three families, in the order a tribunal prefers them:
 *
 *  MEASURED MILE (the gold standard). Take a period on the SAME project with
 *  the SAME trade doing the SAME work unimpacted, measure productivity there,
 *  and apply it to the impacted period's quantities. The difference between
 *  the hours that should have been needed and the hours actually booked is
 *  the lost hours. Nothing here is a factor from a book: every number comes
 *  from this project's records, and each weekly point carries the ids of the
 *  timecards and daily logs it was built from.
 *
 *  EARNED VALUE. Planned hours × percent complete = earned hours; actual
 *  hours − earned hours = lost hours. Weaker, because it inherits every error
 *  in the estimate, but it needs no unimpacted period.
 *
 *  INDUSTRY CURVES (MCAA, Leonard, Ibbs). Published inefficiency factors.
 *  These are assertions about OTHER projects, so this module REFUSES to
 *  produce a number without a written justification, and stamps the factor's
 *  source on the result.
 *
 * The baseline-window suggester finds the best-productivity contiguous run of
 * at least N weeks; it suggests, it does not choose — the analyst records the
 * window they relied on.
 */

import type { DisruptionMethod } from "@constructos/shared";

export interface ProductivityPoint {
  /** ISO date of the week start */
  weekStart: string;
  /** units of work installed that week (the BoQ measure) */
  quantity: number;
  /** labour hours booked that week */
  hours: number;
  /** ids of the records this point was built from */
  sourceIds: string[];
  /** true when the week falls inside a period the claimant says was impacted */
  impacted?: boolean;
}

export interface MeasuredMileInput {
  trade: string;
  unit: string;
  series: ProductivityPoint[];
  baselineFrom: string;
  baselineTo: string;
  impactedFrom: string;
  impactedTo: string;
  /** all-in labour rate per hour for the money conversion */
  hourlyRate?: number | null;
  currency?: string;
}

export interface DisruptionSeriesPoint extends ProductivityPoint {
  productivity: number | null;
  window: "baseline" | "impacted" | "outside";
}

export interface MeasuredMileResult {
  ok: boolean;
  method: "measured_mile";
  trade: string;
  unit: string;
  baselineProductivity: number | null;
  impactedProductivity: number | null;
  productivityLossPercent: number | null;
  baselineHours: number;
  baselineQuantity: number;
  impactedHours: number;
  impactedQuantity: number;
  expectedHours: number | null;
  lostHours: number | null;
  amount: number | null;
  currency: string;
  series: DisruptionSeriesPoint[];
  sourceIds: string[];
  reasons: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

function inWindow(week: string, from: string, to: string): boolean {
  return week >= from && week <= to;
}

export function measuredMile(input: MeasuredMileInput): MeasuredMileResult {
  const reasons: string[] = [];
  const series: DisruptionSeriesPoint[] = input.series
    .slice()
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    .map((p) => ({
      ...p,
      productivity: p.hours > 0 ? round4(p.quantity / p.hours) : null,
      window: inWindow(p.weekStart, input.baselineFrom, input.baselineTo)
        ? ("baseline" as const)
        : inWindow(p.weekStart, input.impactedFrom, input.impactedTo)
          ? ("impacted" as const)
          : ("outside" as const),
    }));

  const baseline = series.filter((p) => p.window === "baseline");
  const impacted = series.filter((p) => p.window === "impacted");
  const baselineHours = baseline.reduce((s, p) => s + p.hours, 0);
  const baselineQuantity = baseline.reduce((s, p) => s + p.quantity, 0);
  const impactedHours = impacted.reduce((s, p) => s + p.hours, 0);
  const impactedQuantity = impacted.reduce((s, p) => s + p.quantity, 0);

  if (baseline.length === 0) reasons.push("No weeks fall inside the chosen baseline window");
  if (impacted.length === 0) reasons.push("No weeks fall inside the chosen impacted window");
  if (baselineHours <= 0) reasons.push("The baseline window contains no booked hours");
  if (baseline.length > 0 && baseline.length < 3) {
    reasons.push(
      `The baseline window is only ${baseline.length} week(s) long — a measured mile drawn from fewer than three weeks is easily attacked as unrepresentative`,
    );
  }
  if (baseline.some((p) => p.impacted)) {
    reasons.push("At least one baseline week is flagged as impacted — the 'mile' is not unimpacted");
  }

  const baselineProductivity = baselineHours > 0 ? round4(baselineQuantity / baselineHours) : null;
  const impactedProductivity = impactedHours > 0 ? round4(impactedQuantity / impactedHours) : null;
  const expectedHours =
    baselineProductivity !== null && baselineProductivity > 0
      ? round2(impactedQuantity / baselineProductivity)
      : null;
  const lostHours = expectedHours !== null ? round2(impactedHours - expectedHours) : null;
  const amount =
    lostHours !== null && input.hourlyRate != null && input.hourlyRate > 0
      ? round2(lostHours * input.hourlyRate)
      : null;
  if (amount === null && lostHours !== null) {
    reasons.push("No labour rate was supplied — lost hours are reported without a money conversion");
  }
  if (lostHours !== null && lostHours < 0) {
    reasons.push("The impacted period was MORE productive than the baseline — this is not a disruption claim");
  }

  return {
    ok: lostHours !== null && baseline.length > 0 && impacted.length > 0,
    method: "measured_mile",
    trade: input.trade,
    unit: input.unit,
    baselineProductivity,
    impactedProductivity,
    productivityLossPercent:
      baselineProductivity !== null && impactedProductivity !== null && baselineProductivity > 0
        ? round2(((baselineProductivity - impactedProductivity) / baselineProductivity) * 100)
        : null,
    baselineHours: round2(baselineHours),
    baselineQuantity: round2(baselineQuantity),
    impactedHours: round2(impactedHours),
    impactedQuantity: round2(impactedQuantity),
    expectedHours,
    lostHours,
    amount,
    currency: input.currency ?? "USD",
    series,
    sourceIds: [...new Set([...baseline, ...impacted].flatMap((p) => p.sourceIds))],
    reasons,
  };
}

/**
 * Suggest the best contiguous unimpacted window of at least `minWeeks` weeks —
 * the one with the highest productivity, since a measured mile is supposed to
 * be the contractor at its unimpeded best.
 */
export function suggestBaselineWindow(
  series: ProductivityPoint[],
  minWeeks = 3,
): { from: string; to: string; productivity: number; weeks: number } | null {
  const sorted = series
    .slice()
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    .filter((p) => p.hours > 0 && !p.impacted);
  if (sorted.length < minWeeks) return null;
  let best: { from: string; to: string; productivity: number; weeks: number } | null = null;
  for (let i = 0; i + minWeeks <= sorted.length; i += 1) {
    for (let len = minWeeks; i + len <= sorted.length; len += 1) {
      const slice = sorted.slice(i, i + len);
      const hours = slice.reduce((s, p) => s + p.hours, 0);
      const qty = slice.reduce((s, p) => s + p.quantity, 0);
      if (hours <= 0) continue;
      const productivity = round4(qty / hours);
      if (best === null || productivity > best.productivity) {
        best = {
          from: slice[0]!.weekStart,
          to: slice[slice.length - 1]!.weekStart,
          productivity,
          weeks: slice.length,
        };
      }
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Earned-value disruption                                            */
/* ------------------------------------------------------------------ */

export interface EvDisruptionActivity {
  id: string;
  name: string;
  budgetedHours: number | null;
  actualHours: number | null;
  percentComplete: number;
}

export interface EvDisruptionResult {
  ok: boolean;
  method: "earned_value";
  plannedHours: number;
  earnedHours: number;
  actualHours: number;
  lostHours: number | null;
  productivityFactor: number | null;
  amount: number | null;
  currency: string;
  activities: {
    id: string;
    name: string;
    budgetedHours: number;
    earnedHours: number;
    actualHours: number;
    lostHours: number;
  }[];
  excluded: number;
  reasons: string[];
}

export function earnedValueDisruption(input: {
  activities: EvDisruptionActivity[];
  hourlyRate?: number | null;
  currency?: string;
}): EvDisruptionResult {
  const reasons: string[] = [];
  const rows: EvDisruptionResult["activities"] = [];
  let excluded = 0;
  for (const a of input.activities) {
    if (a.budgetedHours === null || a.budgetedHours <= 0 || a.actualHours === null) {
      excluded += 1;
      continue;
    }
    const earned = (a.budgetedHours * Math.min(100, Math.max(0, a.percentComplete))) / 100;
    rows.push({
      id: a.id,
      name: a.name,
      budgetedHours: round2(a.budgetedHours),
      earnedHours: round2(earned),
      actualHours: round2(a.actualHours),
      lostHours: round2(a.actualHours - earned),
    });
  }
  if (excluded > 0) {
    reasons.push(`${excluded} activit${excluded === 1 ? "y is" : "ies are"} excluded — no budgeted or actual hours are recorded against them`);
  }
  if (rows.length === 0) {
    reasons.push("No activity carries both budgeted and actual hours — earned-value disruption cannot be computed");
  }
  const plannedHours = rows.reduce((s, r) => s + r.budgetedHours, 0);
  const earnedHours = rows.reduce((s, r) => s + r.earnedHours, 0);
  const actualHours = rows.reduce((s, r) => s + r.actualHours, 0);
  const lostHours = rows.length > 0 ? round2(actualHours - earnedHours) : null;
  const amount =
    lostHours !== null && input.hourlyRate != null && input.hourlyRate > 0
      ? round2(lostHours * input.hourlyRate)
      : null;
  if (amount === null && lostHours !== null) {
    reasons.push("No labour rate was supplied — lost hours are reported without a money conversion");
  }
  return {
    ok: rows.length > 0,
    method: "earned_value",
    plannedHours: round2(plannedHours),
    earnedHours: round2(earnedHours),
    actualHours: round2(actualHours),
    lostHours,
    productivityFactor: actualHours > 0 ? round4(earnedHours / actualHours) : null,
    amount,
    currency: input.currency ?? "USD",
    activities: rows,
    excluded,
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* Industry curves                                                     */
/* ------------------------------------------------------------------ */

export interface CurveFactor {
  key: string;
  label: string;
  /** productivity loss as a fraction, e.g. 0.1 = 10% */
  minor: number;
  average: number;
  severe: number;
}

/**
 * MCAA (Mechanical Contractors Association of America) Bulletin 58 factors.
 * Reproduced as a lookup because that is exactly what they are: an assertion
 * about other people's projects, admissible only with justification.
 */
export const MCAA_FACTORS: CurveFactor[] = [
  { key: "stacking_of_trades", label: "Stacking of trades", minor: 0.1, average: 0.2, severe: 0.3 },
  { key: "morale_and_attitude", label: "Morale and attitude", minor: 0.05, average: 0.15, severe: 0.3 },
  { key: "reassignment_of_manpower", label: "Reassignment of manpower", minor: 0.05, average: 0.1, severe: 0.15 },
  { key: "crew_size_inefficiency", label: "Crew size inefficiency", minor: 0.1, average: 0.2, severe: 0.3 },
  { key: "concurrent_operations", label: "Concurrent operations", minor: 0.05, average: 0.15, severe: 0.25 },
  { key: "dilution_of_supervision", label: "Dilution of supervision", minor: 0.1, average: 0.15, severe: 0.25 },
  { key: "learning_curve", label: "Learning curve", minor: 0.05, average: 0.15, severe: 0.3 },
  { key: "errors_and_omissions", label: "Errors and omissions", minor: 0.05, average: 0.15, severe: 0.3 },
  { key: "beneficial_occupancy", label: "Beneficial occupancy", minor: 0.15, average: 0.25, severe: 0.4 },
  { key: "joint_occupancy", label: "Joint occupancy", minor: 0.05, average: 0.12, severe: 0.2 },
  { key: "site_access", label: "Site access", minor: 0.05, average: 0.12, severe: 0.3 },
  { key: "logistics", label: "Logistics", minor: 0.05, average: 0.1, severe: 0.25 },
  { key: "fatigue", label: "Fatigue", minor: 0.08, average: 0.1, severe: 0.2 },
  { key: "ripple", label: "Ripple effect", minor: 0.1, average: 0.15, severe: 0.2 },
  { key: "overtime", label: "Overtime", minor: 0.1, average: 0.15, severe: 0.2 },
  { key: "season_and_weather", label: "Season and weather change", minor: 0.1, average: 0.2, severe: 0.3 },
];

/**
 * Leonard's study: productivity loss against the number of change orders as a
 * percentage of base contract value, for electrical/mechanical work with
 * other causes of impact present.
 */
export const LEONARD_CURVE: { changePercent: number; loss: number }[] = [
  { changePercent: 0, loss: 0 },
  { changePercent: 10, loss: 0.12 },
  { changePercent: 20, loss: 0.19 },
  { changePercent: 30, loss: 0.25 },
  { changePercent: 40, loss: 0.3 },
  { changePercent: 50, loss: 0.33 },
];

/** Ibbs' cumulative-impact curve: change percentage to productivity index. */
export const IBBS_CURVE: { changePercent: number; loss: number }[] = [
  { changePercent: 0, loss: 0 },
  { changePercent: 5, loss: 0.05 },
  { changePercent: 10, loss: 0.1 },
  { changePercent: 20, loss: 0.18 },
  { changePercent: 30, loss: 0.24 },
  { changePercent: 40, loss: 0.29 },
  { changePercent: 50, loss: 0.33 },
];

/** Linear interpolation on a published curve, clamped at both ends. */
export function interpolateCurve(curve: { changePercent: number; loss: number }[], changePercent: number): number {
  if (curve.length === 0) return 0;
  const x = Math.max(0, changePercent);
  const first = curve[0]!;
  const last = curve[curve.length - 1]!;
  if (x <= first.changePercent) return first.loss;
  if (x >= last.changePercent) return last.loss;
  for (let i = 1; i < curve.length; i += 1) {
    const lo = curve[i - 1]!;
    const hi = curve[i]!;
    if (x <= hi.changePercent) {
      const t = (x - lo.changePercent) / (hi.changePercent - lo.changePercent);
      return round4(lo.loss + t * (hi.loss - lo.loss));
    }
  }
  return last.loss;
}

export interface IndustryCurveInput {
  method: Extract<DisruptionMethod, "industry_curve_mcaa" | "industry_curve_leonard" | "industry_curve_ibbs">;
  /** hours the impacted work would have taken unimpacted */
  baseHours: number | null;
  /** MCAA: the factors claimed, each with a severity */
  factors?: { key: string; severity: "minor" | "average" | "severe" }[];
  /** Leonard/Ibbs: change orders as a percentage of the base contract */
  changePercent?: number | null;
  hourlyRate?: number | null;
  currency?: string;
  /** mandatory — a curve without a reason is a number without a basis */
  justification: string;
}

export interface IndustryCurveResult {
  ok: boolean;
  method: string;
  source: string;
  lossFactor: number | null;
  baseHours: number | null;
  lostHours: number | null;
  amount: number | null;
  currency: string;
  applied: { key: string; label: string; severity: string; loss: number }[];
  justification: string;
  reasons: string[];
}

export function industryCurve(input: IndustryCurveInput): IndustryCurveResult {
  const reasons: string[] = [];
  const currency = input.currency ?? "USD";
  if (!input.justification || input.justification.trim().length < 20) {
    reasons.push(
      "An industry-curve claim needs a written justification of at least 20 characters explaining why the published factors apply to this project",
    );
  }
  if (input.baseHours === null || input.baseHours <= 0) reasons.push("No base hours were supplied");

  const applied: IndustryCurveResult["applied"] = [];
  let lossFactor: number | null = null;
  let source: string;

  if (input.method === "industry_curve_mcaa") {
    source = "MCAA Bulletin 58 factors";
    const factors = input.factors ?? [];
    if (factors.length === 0) reasons.push("No MCAA factors were selected");
    let total = 0;
    for (const f of factors) {
      const def = MCAA_FACTORS.find((x) => x.key === f.key);
      if (!def) {
        reasons.push(`Unknown MCAA factor "${f.key}"`);
        continue;
      }
      const loss = def[f.severity];
      total += loss;
      applied.push({ key: def.key, label: def.label, severity: f.severity, loss });
    }
    if (applied.length > 0) {
      // MCAA factors are additive but summing many of them quickly produces an
      // indefensible number; cap at 100% and say so.
      lossFactor = round4(Math.min(1, total));
      if (total > 1) reasons.push(`The selected factors sum to ${round2(total * 100)}% — capped at 100%`);
      if (applied.length > 4) {
        reasons.push(
          `${applied.length} factors were applied; tribunals discount stacked MCAA factors heavily — expect each to be challenged separately`,
        );
      }
    }
  } else {
    const curve = input.method === "industry_curve_leonard" ? LEONARD_CURVE : IBBS_CURVE;
    source = input.method === "industry_curve_leonard" ? "Leonard (1988) change-order impact study" : "Ibbs cumulative-impact curve";
    if (input.changePercent === null || input.changePercent === undefined) {
      reasons.push("No change-order percentage was supplied");
    } else {
      lossFactor = interpolateCurve(curve, input.changePercent);
      applied.push({
        key: input.method,
        label: `${source} at ${input.changePercent}% change`,
        severity: "curve",
        loss: lossFactor,
      });
    }
  }

  const lostHours =
    lossFactor !== null && input.baseHours !== null && input.baseHours > 0
      ? round2(input.baseHours * lossFactor)
      : null;
  const amount =
    lostHours !== null && input.hourlyRate != null && input.hourlyRate > 0
      ? round2(lostHours * input.hourlyRate)
      : null;
  if (amount === null && lostHours !== null) {
    reasons.push("No labour rate was supplied — lost hours are reported without a money conversion");
  }

  return {
    ok: lostHours !== null && reasons.every((r) => !r.startsWith("An industry-curve claim needs")),
    method: input.method,
    source,
    lossFactor,
    baseHours: input.baseHours,
    lostHours,
    amount,
    currency,
    applied,
    justification: input.justification,
    reasons,
  };
}
