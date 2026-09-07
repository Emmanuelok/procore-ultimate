/**
 * Contingency planning arithmetic (spec Vol II Domain H #451, #471-472).
 *
 * Three pure pieces, all unit-tested without a database:
 *  1. planned drawdown curve generation from a named shape,
 *  2. drift detection — actual remaining vs planned remaining, which is the
 *     earliest honest signal that a project is spending its cover faster
 *     than it is retiring risk,
 *  3. risk appetite evaluation — is the register (or the simulation) beyond
 *     what the board said it would accept.
 *
 * None of these block a write. Exceeding appetite or running ahead of plan
 * is a fact somebody is entitled to be told, not an error to refuse.
 */
import type { ContingencyCurveShape } from "@constructos/shared";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ */
/* Planned curve (#451)                                                */
/* ------------------------------------------------------------------ */

export interface PlanPoint {
  /** ISO date */
  date: string;
  /** planned REMAINING balance at this date */
  plannedRemaining: number;
}

/** Whole days between two ISO dates (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function addDays(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Fraction of the contingency CONSUMED by progress fraction t ∈ [0,1].
 *  - linear:       t                     (steady burn)
 *  - s_curve:      3t² − 2t³             (smoothstep: slow, fast, slow — the
 *                                         shape a construction spend profile
 *                                         actually takes)
 *  - front_loaded: √t                    (design/ground risk retires early)
 *  - back_loaded:  t²                    (commissioning/handover risk)
 */
export function consumedFraction(shape: ContingencyCurveShape, t: number): number {
  const x = Math.min(1, Math.max(0, t));
  switch (shape) {
    case "linear":
      return x;
    case "s_curve":
      return 3 * x * x - 2 * x * x * x;
    case "front_loaded":
      return Math.sqrt(x);
    case "back_loaded":
      return x * x;
  }
}

/**
 * Generate a planned remaining-balance series between two dates.
 * `points` is the number of intervals; the series therefore has points + 1
 * entries, starting at the full amount and ending at `endRemaining`
 * (default 0 — the plan is to consume the whole pot by the end).
 */
export function generatePlanCurve(options: {
  amount: number;
  startDate: string;
  endDate: string;
  shape: ContingencyCurveShape;
  points?: number;
  endRemaining?: number;
}): PlanPoint[] {
  const span = daysBetween(options.startDate, options.endDate);
  if (span <= 0) return [{ date: options.startDate, plannedRemaining: round2(options.amount) }];
  const n = Math.max(1, Math.min(240, Math.floor(options.points ?? 12)));
  const endRemaining = options.endRemaining ?? 0;
  const consumable = options.amount - endRemaining;
  const out: PlanPoint[] = [];
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    const date = addDays(options.startDate, Math.round(span * t));
    const consumed = consumedFraction(options.shape, t) * consumable;
    out.push({ date, plannedRemaining: round2(options.amount - consumed) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Drift (#471)                                                        */
/* ------------------------------------------------------------------ */

export interface DriftAssessment {
  /** planned remaining interpolated at `asOf`; null when there is no plan */
  plannedRemaining: number | null;
  actualRemaining: number;
  /** actual − planned. Negative = drawn down FASTER than planned. */
  variance: number | null;
  /** variance as a % of the contingency budget; null without a plan */
  variancePercent: number | null;
  aheadOfPlan: boolean;
  breached: boolean;
  tolerancePercent: number;
  basis: string;
}

/** Default tolerance before drift is worth raising a signal for. */
export const DEFAULT_DRIFT_TOLERANCE_PERCENT = 10;

/**
 * Linear interpolation of the planned series at a date. Before the first
 * point the plan is the first value; after the last it is the last value.
 */
export function plannedAt(points: PlanPoint[], isoDate: string): number | null {
  if (points.length === 0) return null;
  const sorted = [...points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (isoDate <= first.date) return first.plannedRemaining;
  if (isoDate >= last.date) return last.plannedRemaining;
  for (let i = 1; i < sorted.length; i += 1) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (isoDate <= b.date) {
      const span = daysBetween(a.date, b.date);
      if (span <= 0) return b.plannedRemaining;
      const t = daysBetween(a.date, isoDate) / span;
      return round2(a.plannedRemaining + t * (b.plannedRemaining - a.plannedRemaining));
    }
  }
  return last.plannedRemaining;
}

export function assessDrift(options: {
  amount: number;
  actualRemaining: number;
  plan: PlanPoint[];
  asOf: string;
  tolerancePercent?: number;
}): DriftAssessment {
  const tolerancePercent = options.tolerancePercent ?? DEFAULT_DRIFT_TOLERANCE_PERCENT;
  const planned = plannedAt(options.plan, options.asOf);
  if (planned === null) {
    return {
      plannedRemaining: null,
      actualRemaining: round2(options.actualRemaining),
      variance: null,
      variancePercent: null,
      aheadOfPlan: false,
      breached: false,
      tolerancePercent,
      basis: "No planned drawdown curve has been set for this contingency.",
    };
  }
  const variance = round2(options.actualRemaining - planned);
  const variancePercent =
    Math.abs(options.amount) < 1e-9 ? null : round2((variance / options.amount) * 100);
  const aheadOfPlan = variance < 0;
  const breached =
    variancePercent !== null && aheadOfPlan && Math.abs(variancePercent) > tolerancePercent;
  return {
    plannedRemaining: round2(planned),
    actualRemaining: round2(options.actualRemaining),
    variance,
    variancePercent,
    aheadOfPlan,
    breached,
    tolerancePercent,
    basis:
      `At ${options.asOf} the plan expected ${round2(planned)} remaining; ${round2(options.actualRemaining)} ` +
      `is actually left — ${aheadOfPlan ? "drawn down faster" : "drawn down slower"} than planned by ` +
      `${Math.abs(variance)} (${variancePercent === null ? "n/a" : Math.abs(variancePercent)}% of the budget), ` +
      `against a tolerance of ${tolerancePercent}%.`,
  };
}

/* ------------------------------------------------------------------ */
/* Risk appetite (#472)                                                */
/* ------------------------------------------------------------------ */

export interface AppetiteRule {
  id: string;
  scope: "project" | "category";
  category: string | null;
  maxScore: number | null;
  maxExpectedValue: number | null;
  currency: string;
}

export interface AppetiteRiskInput {
  id: string;
  number: number;
  title: string;
  category: string;
  status: string;
  /** post-mitigation score when available, otherwise pre-mitigation */
  effectiveScore: number;
  /** analytic expected value, null when the risk is not quantified */
  expectedValue: number | null;
}

export interface AppetiteBreach {
  ruleId: string;
  scope: "project" | "category";
  category: string | null;
  kind: "score" | "expected_value" | "portfolio_expected_value";
  limit: number;
  actual: number;
  riskId: string | null;
  riskNumber: number | null;
  detail: string;
}

/**
 * Evaluate appetite rules against the live register. A `category` rule only
 * looks at risks in that category; the `project` rule additionally checks
 * the AGGREGATE quantified exposure, which is the number a board actually
 * sets a limit on. Only live risks (open / mitigating) count — a closed
 * risk is not exposure.
 */
export function evaluateAppetite(
  rules: AppetiteRule[],
  risks: AppetiteRiskInput[],
): AppetiteBreach[] {
  const live = risks.filter((r) => r.status === "open" || r.status === "mitigating");
  const breaches: AppetiteBreach[] = [];
  for (const rule of rules) {
    const scoped =
      rule.scope === "category" && rule.category
        ? live.filter((r) => r.category === rule.category)
        : live;
    if (rule.maxScore !== null) {
      for (const r of scoped) {
        if (r.effectiveScore > rule.maxScore) {
          breaches.push({
            ruleId: rule.id,
            scope: rule.scope,
            category: rule.category,
            kind: "score",
            limit: rule.maxScore,
            actual: r.effectiveScore,
            riskId: r.id,
            riskNumber: r.number,
            detail:
              `Risk #${r.number} "${r.title}" scores ${r.effectiveScore} (probability × impact) ` +
              `against an appetite limit of ${rule.maxScore}` +
              (rule.category ? ` for ${rule.category} risks.` : " for this project."),
          });
        }
      }
    }
    if (rule.maxExpectedValue !== null) {
      for (const r of scoped) {
        if (r.expectedValue !== null && r.expectedValue > rule.maxExpectedValue) {
          breaches.push({
            ruleId: rule.id,
            scope: rule.scope,
            category: rule.category,
            kind: "expected_value",
            limit: rule.maxExpectedValue,
            actual: round2(r.expectedValue),
            riskId: r.id,
            riskNumber: r.number,
            detail:
              `Risk #${r.number} "${r.title}" carries an expected value of ${rule.currency} ` +
              `${round2(r.expectedValue)} against an appetite limit of ${rule.currency} ${rule.maxExpectedValue}.`,
          });
        }
      }
      if (rule.scope === "project") {
        const quantified = scoped.filter((r) => r.expectedValue !== null);
        if (quantified.length > 0) {
          const total = round2(quantified.reduce((s, r) => s + (r.expectedValue ?? 0), 0));
          if (total > rule.maxExpectedValue) {
            breaches.push({
              ruleId: rule.id,
              scope: "project",
              category: null,
              kind: "portfolio_expected_value",
              limit: rule.maxExpectedValue,
              actual: total,
              riskId: null,
              riskNumber: null,
              detail:
                `The live register's total quantified expected value is ${rule.currency} ${total} ` +
                `across ${quantified.length} quantified risk(s), against a project appetite limit of ` +
                `${rule.currency} ${rule.maxExpectedValue}.`,
            });
          }
        }
      }
    }
  }
  return breaches;
}
