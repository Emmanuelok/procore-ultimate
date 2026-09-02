import { z } from "zod";
import type { Distribution } from "../../lib/montecarlo.js";

/**
 * Wire-format validation for probability distributions (spec Vol II Domain H
 * #451, #459). The schema mirrors lib/montecarlo.ts `Distribution` exactly —
 * a distribution that parses here is guaranteed to be sampleable by the
 * engine — and enforces the numeric sanity the sampler itself does not
 * (min ≤ mode ≤ max, non-negative spreads, positive discrete weights).
 */

const finite = z.number().finite();

const threePoint = {
  min: finite,
  mode: finite,
  max: finite,
};

const distributionUnion = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("triangular"), ...threePoint }),
  z.object({ kind: z.literal("pert"), ...threePoint }),
  z.object({ kind: z.literal("uniform"), min: finite, max: finite }),
  z.object({ kind: z.literal("normal"), mean: finite, stdDev: finite.nonnegative() }),
  z.object({ kind: z.literal("lognormal"), logMean: finite, logStdDev: finite.nonnegative() }),
  z.object({
    kind: z.literal("discrete"),
    values: z
      .array(z.object({ value: finite, weight: finite.positive() }))
      .min(1)
      .max(200),
  }),
]);

export const distributionSchema = distributionUnion.superRefine((d, ctx) => {
  if (d.kind === "triangular" || d.kind === "pert") {
    if (!(d.min <= d.mode && d.mode <= d.max)) {
      ctx.addIssue({
        code: "custom",
        message: `${d.kind} distribution requires min <= mode <= max (got min=${d.min}, mode=${d.mode}, max=${d.max})`,
      });
    }
  }
  if (d.kind === "uniform" && d.min > d.max) {
    ctx.addIssue({
      code: "custom",
      message: `uniform distribution requires min <= max (got min=${d.min}, max=${d.max})`,
    });
  }
});

export type ValidatedDistribution = z.infer<typeof distributionSchema>;

/**
 * Analytic mean per distribution kind (#454) — no sampling involved, so the
 * mitigation-value arithmetic is exact and instant:
 *   triangular (a+m+b)/3 · PERT (a+4m+b)/6 · uniform (a+b)/2 · normal μ ·
 *   lognormal exp(μ+σ²/2) · discrete weighted average.
 * NOTE: QCRA clamps sampled impacts at 0 (montecarlo.ts), so for
 * distributions with mass below zero the simulated mean can sit slightly
 * above this analytic value. Documented, accepted.
 */
export function analyticMean(d: Distribution): number {
  switch (d.kind) {
    case "triangular":
      return (d.min + d.mode + d.max) / 3;
    case "pert":
      return (d.min + 4 * d.mode + d.max) / 6;
    case "uniform":
      return (d.min + d.max) / 2;
    case "normal":
      return d.mean;
    case "lognormal":
      return Math.exp(d.logMean + (d.logStdDev * d.logStdDev) / 2);
    case "discrete": {
      const totalWeight = d.values.reduce((s, v) => s + v.weight, 0);
      if (totalWeight <= 0) return 0;
      return d.values.reduce((s, v) => s + v.value * v.weight, 0) / totalWeight;
    }
  }
}
