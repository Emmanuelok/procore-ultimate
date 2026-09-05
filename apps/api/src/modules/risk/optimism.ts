/**
 * Optimism bias and reference class forecasting (spec Vol II Domain H
 * #402-405).
 *
 * WHAT THIS IS
 * Two ways of answering "by how much will this estimate be wrong?".
 *
 *  - The INSIDE view asks the team. It is systematically optimistic, which
 *    is why HM Treasury publishes an uplift table: for each project
 *    category, an upper bound (apply this if you have done nothing to
 *    address the drivers of bias) and a lower bound (apply this if you have
 *    demonstrably addressed all of them). The Green Book's Supplementary
 *    Guidance on Optimism Bias is the source of the numbers below.
 *
 *  - The OUTSIDE view ignores the team entirely and asks what projects LIKE
 *    this one actually cost. Given a reference class of completed projects
 *    with both an estimate and an outturn, the empirical distribution of
 *    outturn/estimate ratios gives a required uplift at any confidence
 *    level. Five references is not a distribution, so the engine reports
 *    the sample size and refuses to pretend otherwise.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * It does not pick for you. Both views are returned side by side with their
 * basis, and choosing between them (or challenging the table, see
 * upliftChallenges) is a recorded human decision.
 */
import type { OptimismBiasCategory } from "@constructos/shared";

/* ------------------------------------------------------------------ */
/* HM Treasury Green Book optimism bias table (#402)                   */
/* ------------------------------------------------------------------ */

export interface OptimismBiasBand {
  category: OptimismBiasCategory;
  label: string;
  /** Uplift % to apply when NONE of the bias drivers have been addressed. */
  upperPercent: number;
  /** Uplift % to apply when ALL of them demonstrably have been. */
  lowerPercent: number;
  /** What the category covers, in the guidance's own terms. */
  description: string;
}

/**
 * Capital expenditure uplift bounds, HM Treasury Green Book Supplementary
 * Guidance (Mott MacDonald 2002 review, carried into current guidance).
 * These are works-cost uplifts applied to capex.
 */
export const OPTIMISM_BIAS_TABLE: readonly OptimismBiasBand[] = [
  {
    category: "standard_building",
    label: "Standard buildings",
    upperPercent: 24,
    lowerPercent: 2,
    description:
      "Buildings of a type the organisation has delivered before to a settled brief — offices, schools, housing.",
  },
  {
    category: "non_standard_building",
    label: "Non-standard buildings",
    upperPercent: 51,
    lowerPercent: 4,
    description:
      "Buildings with novel form, a complex brief or heavy services — hospitals, laboratories, cultural buildings.",
  },
  {
    category: "standard_civil_engineering",
    label: "Standard civil engineering",
    upperPercent: 44,
    lowerPercent: 3,
    description: "Roads, drainage and comparable works using established techniques.",
  },
  {
    category: "non_standard_civil_engineering",
    label: "Non-standard civil engineering",
    upperPercent: 66,
    lowerPercent: 6,
    description:
      "Works with significant novelty or ground risk — tunnels, major bridges, marine and rail infrastructure.",
  },
  {
    category: "equipment_development",
    label: "Equipment / development",
    upperPercent: 200,
    lowerPercent: 10,
    description: "Bespoke equipment and development programmes where the product is not yet defined.",
  },
  {
    category: "outsourcing",
    label: "Outsourcing",
    upperPercent: 41,
    lowerPercent: 0,
    description: "Service transfer and outsourcing programmes.",
  },
] as const;

const BY_CATEGORY = new Map<string, OptimismBiasBand>(
  OPTIMISM_BIAS_TABLE.map((b) => [b.category, b]),
);

export function optimismBand(category: string): OptimismBiasBand | null {
  return BY_CATEGORY.get(category) ?? null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

export interface UpliftPosition {
  category: OptimismBiasCategory;
  upperPercent: number;
  lowerPercent: number;
  /**
   * Where on the range the case sits, 0..1. 0 = the upper bound (nothing
   * mitigated), 1 = the lower bound (everything mitigated). This is the
   * direction the guidance uses: mitigation moves you DOWN the range.
   */
  position: number;
  /** The uplift the table yields at that position, % of capex. */
  upliftPercent: number;
  basis: string;
}

/**
 * Interpolate the table between its bounds at a mitigation position.
 * Linear interpolation is the guidance's own presentation of the range —
 * there is no published curve, and inventing one would be false precision.
 */
export function upliftFor(category: string, position: number): UpliftPosition | null {
  const band = optimismBand(category);
  if (!band) return null;
  const p = Math.min(1, Math.max(0, position));
  const uplift = band.upperPercent - p * (band.upperPercent - band.lowerPercent);
  return {
    category: band.category,
    upperPercent: band.upperPercent,
    lowerPercent: band.lowerPercent,
    position: round4(p),
    upliftPercent: round2(uplift),
    basis:
      `HM Treasury Green Book optimism bias, ${band.label}: upper ${band.upperPercent}% ` +
      `(no bias drivers addressed) to lower ${band.lowerPercent}% (all addressed); ` +
      `mitigation position ${round4(p)} interpolates to ${round2(uplift)}%.`,
  };
}

/* ------------------------------------------------------------------ */
/* Reference class forecasting (#403-404)                              */
/* ------------------------------------------------------------------ */

export interface ReferenceProjectInput {
  id: string;
  name: string;
  category: string;
  estimatedCost: number | null;
  outturnCost: number | null;
  estimatedDurationDays: number | null;
  outturnDurationDays: number | null;
}

export interface ReferenceClassForecast {
  /** "cost" | "duration" — which pair of fields was used. */
  basis: "cost" | "duration";
  category: string;
  /** How many reference projects had BOTH numbers and a positive estimate. */
  sampleSize: number;
  /** Ratios outturn/estimate, ascending — the empirical distribution. */
  ratios: number[];
  /** Uplift % (ratio − 1) × 100 at each confidence level; null when no sample. */
  p50UpliftPercent: number | null;
  p80UpliftPercent: number | null;
  p90UpliftPercent: number | null;
  meanUpliftPercent: number | null;
  /** True when the sample is too small for the percentiles to mean much. */
  thin: boolean;
  /** Human-readable statement of what was computed and from what. */
  basisNote: string;
  /** Present when nothing could be computed. */
  unavailableReason: string | null;
}

/** Below this many references the outside view is reported but flagged thin. */
export const RCF_THIN_SAMPLE = 8;

/**
 * Nearest-rank percentile on an ascending array (no interpolation): the
 * value at ceil(p × n). With small samples interpolation invents precision
 * the data does not carry, so the empirical order statistic is used.
 */
export function percentileOf(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil(p * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx] ?? null;
}

/**
 * Outside-view uplift from a reference class (#403-404). Projects missing
 * either number, or with a non-positive estimate, are excluded rather than
 * defaulted — a fabricated ratio would poison the whole forecast.
 */
export function referenceClassForecast(
  references: ReferenceProjectInput[],
  options: { category: string; basis?: "cost" | "duration" },
): ReferenceClassForecast {
  const basis = options.basis ?? "cost";
  const inClass = references.filter((r) => r.category === options.category);
  const ratios: number[] = [];
  for (const r of inClass) {
    const est = basis === "cost" ? r.estimatedCost : r.estimatedDurationDays;
    const out = basis === "cost" ? r.outturnCost : r.outturnDurationDays;
    if (est == null || out == null) continue;
    if (!(est > 0) || !Number.isFinite(out) || out < 0) continue;
    ratios.push(out / est);
  }
  ratios.sort((a, b) => a - b);
  const sampleSize = ratios.length;
  if (sampleSize === 0) {
    return {
      basis,
      category: options.category,
      sampleSize: 0,
      ratios: [],
      p50UpliftPercent: null,
      p80UpliftPercent: null,
      p90UpliftPercent: null,
      meanUpliftPercent: null,
      thin: true,
      basisNote: "",
      unavailableReason:
        inClass.length === 0
          ? `No completed reference projects recorded in class "${options.category}".`
          : `Reference projects exist in class "${options.category}" but none carry both an estimated and an outturn ${basis === "cost" ? "cost" : "duration"}.`,
    };
  }
  const asUplift = (ratio: number | null): number | null =>
    ratio === null ? null : round2((ratio - 1) * 100);
  const mean = ratios.reduce((s, r) => s + r, 0) / sampleSize;
  return {
    basis,
    category: options.category,
    sampleSize,
    ratios: ratios.map((r) => round4(r)),
    p50UpliftPercent: asUplift(percentileOf(ratios, 0.5)),
    p80UpliftPercent: asUplift(percentileOf(ratios, 0.8)),
    p90UpliftPercent: asUplift(percentileOf(ratios, 0.9)),
    meanUpliftPercent: round2((mean - 1) * 100),
    thin: sampleSize < RCF_THIN_SAMPLE,
    basisNote:
      `Empirical outturn/${basis === "cost" ? "estimate" : "planned duration"} ratios of ` +
      `${sampleSize} completed project(s) in class "${options.category}", nearest-rank percentiles. ` +
      (sampleSize < RCF_THIN_SAMPLE
        ? `Fewer than ${RCF_THIN_SAMPLE} references — treat the percentiles as indicative only.`
        : "Sample is large enough for the percentiles to be read as a distribution."),
    unavailableReason: null,
  };
}
