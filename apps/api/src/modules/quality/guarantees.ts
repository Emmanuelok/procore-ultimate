/**
 * Performance guarantees and the liquidated damages a shortfall triggers.
 *
 * A guarantee is a number in a contract: "the chiller shall deliver 1,200 kW
 * at 0.58 kW/tonR", "the lifts shall achieve a 30-second interval", "the
 * envelope shall not leak more than 3 m³/h·m² at 50 Pa". The commissioning
 * test measures it. Where the measurement falls short the contract usually
 * prices the shortfall — per kW, per percentage point, per unit — and the
 * exposure is arithmetic once the rate is known.
 *
 * The refusal that matters: where the RATE is not held, the exposure is null
 * with a reason. A zero would read as "no exposure" when the truth is "nobody
 * has told the platform what a shortfall costs", and those are opposite
 * statements to a commercial manager reading a handover report.
 *
 * Pure and deterministic.
 */

import type { GuaranteeStatus } from "@constructos/shared";

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const EPSILON = 1e-9;

export interface GuaranteeLike {
  id: string;
  reference: string;
  parameter: string;
  operator: string;
  guaranteedValue: number | null;
  guaranteedMin: number | null;
  guaranteedMax: number | null;
  unit: string | null;
  tolerancePercent: number | null;
  measuredValue: number | null;
  ldRatePerUnit: number | null;
  ldCapAmount: number | null;
  currency: string;
  status: string;
}

export interface GuaranteeAssessment {
  status: GuaranteeStatus;
  met: boolean | null;
  /** shortfall in the parameter's own unit; 0 when met, null when unknowable */
  shortfall: number | null;
  shortfallPercent: number | null;
  /** liquidated damages exposure, or null with a reason */
  ldAmount: number | null;
  ldCapped: boolean;
  basis: string;
  reasons: string[];
}

/** The value the guarantee has to beat, and the direction, in words. */
function requirementText(g: GuaranteeLike): string {
  const unit = g.unit ? ` ${g.unit}` : "";
  switch (g.operator) {
    case "at_least":
      return `at least ${g.guaranteedValue ?? "—"}${unit}`;
    case "at_most":
      return `no more than ${g.guaranteedValue ?? "—"}${unit}`;
    case "equals":
      return `${g.guaranteedValue ?? "—"}${unit}${g.tolerancePercent ? ` ±${g.tolerancePercent}%` : ""}`;
    case "between":
      return `between ${g.guaranteedMin ?? "—"} and ${g.guaranteedMax ?? "—"}${unit}`;
    default:
      return `${g.guaranteedValue ?? "—"}${unit}`;
  }
}

/**
 * Assess one guarantee against its measurement.
 *
 * `not_assessable` conditions are returned as `met: null` with the reason,
 * and the status stays wherever the register put it: an unmeasured guarantee
 * is not a failed one.
 */
export function assessGuarantee(g: GuaranteeLike): GuaranteeAssessment {
  const reasons: string[] = [];
  const unit = g.unit ? ` ${g.unit}` : "";
  const requirement = requirementText(g);

  if (g.status === "waived") {
    return {
      status: "waived",
      met: null,
      shortfall: null,
      shortfallPercent: null,
      ldAmount: null,
      ldCapped: false,
      basis: `Waived: the guarantee of ${requirement} is not being enforced.`,
      reasons: ["The guarantee is waived; no shortfall is computed and no damages arise from it."],
    };
  }
  if (g.measuredValue === null || !Number.isFinite(g.measuredValue)) {
    return {
      status: g.status === "under_test" ? "under_test" : "declared",
      met: null,
      shortfall: null,
      shortfallPercent: null,
      ldAmount: null,
      ldCapped: false,
      basis: `Not yet measured against ${requirement}.`,
      reasons: [
        `No measurement is recorded for ${g.parameter}, so whether the guarantee of ${requirement} was met is unknown. It is unmeasured, not failed.`,
      ],
    };
  }

  const measured = g.measuredValue;
  let met: boolean | null = null;
  let shortfall: number | null = null;
  let reference: number | null = null;

  if (g.operator === "at_least") {
    if (g.guaranteedValue === null) {
      reasons.push("No guaranteed value is recorded, so the measurement cannot be judged.");
    } else {
      reference = g.guaranteedValue;
      met = measured >= g.guaranteedValue - EPSILON;
      shortfall = met ? 0 : round4(g.guaranteedValue - measured);
    }
  } else if (g.operator === "at_most") {
    if (g.guaranteedValue === null) {
      reasons.push("No guaranteed value is recorded, so the measurement cannot be judged.");
    } else {
      reference = g.guaranteedValue;
      met = measured <= g.guaranteedValue + EPSILON;
      shortfall = met ? 0 : round4(measured - g.guaranteedValue);
    }
  } else if (g.operator === "equals") {
    if (g.guaranteedValue === null) {
      reasons.push("No guaranteed value is recorded, so the measurement cannot be judged.");
    } else {
      reference = g.guaranteedValue;
      const band = g.tolerancePercent
        ? Math.abs(g.guaranteedValue) * (g.tolerancePercent / 100)
        : 0;
      const deviation = Math.abs(measured - g.guaranteedValue);
      met = deviation <= band + EPSILON;
      shortfall = met ? 0 : round4(deviation - band);
    }
  } else if (g.operator === "between") {
    if (g.guaranteedMin === null || g.guaranteedMax === null) {
      reasons.push("The guaranteed band is incomplete, so the measurement cannot be judged.");
    } else {
      reference = g.guaranteedMin;
      if (measured < g.guaranteedMin - EPSILON) {
        met = false;
        shortfall = round4(g.guaranteedMin - measured);
      } else if (measured > g.guaranteedMax + EPSILON) {
        met = false;
        reference = g.guaranteedMax;
        shortfall = round4(measured - g.guaranteedMax);
      } else {
        met = true;
        shortfall = 0;
      }
    }
  } else {
    reasons.push(`Unknown comparison "${g.operator}"; the measurement cannot be judged.`);
  }

  if (met === null) {
    return {
      status: g.status === "under_test" ? "under_test" : "declared",
      met: null,
      shortfall: null,
      shortfallPercent: null,
      ldAmount: null,
      ldCapped: false,
      basis: `Could not be judged against ${requirement}.`,
      reasons,
    };
  }

  const shortfallPercent =
    shortfall !== null && reference !== null && Math.abs(reference) > EPSILON
      ? round2((shortfall / Math.abs(reference)) * 100)
      : null;

  if (met) {
    return {
      status: "met",
      met: true,
      shortfall: 0,
      shortfallPercent: 0,
      ldAmount: 0,
      ldCapped: false,
      basis: `Measured ${measured}${unit} against a requirement of ${requirement} — met.`,
      reasons,
    };
  }

  let ldAmount: number | null = null;
  let ldCapped = false;
  let basis = `Measured ${measured}${unit} against a requirement of ${requirement} — short by ${shortfall}${unit}${shortfallPercent !== null ? ` (${shortfallPercent}%)` : ""}.`;
  if (g.ldRatePerUnit === null || !Number.isFinite(g.ldRatePerUnit)) {
    reasons.push(
      `No liquidated-damages rate is recorded for ${g.parameter}, so the exposure cannot be computed. It is unknown, not nil — read the contract clause and record the rate before this figure is relied on.`,
    );
  } else {
    const raw = round2((shortfall ?? 0) * g.ldRatePerUnit);
    if (g.ldCapAmount !== null && raw > g.ldCapAmount) {
      ldAmount = round2(g.ldCapAmount);
      ldCapped = true;
      basis += ` Damages at ${g.ldRatePerUnit} ${g.currency} per unit would be ${raw} ${g.currency}, capped at ${ldAmount} ${g.currency}.`;
    } else {
      ldAmount = raw;
      basis += ` Damages at ${g.ldRatePerUnit} ${g.currency} per unit of shortfall: ${ldAmount} ${g.currency}.`;
    }
  }

  return {
    status: "not_met",
    met: false,
    shortfall,
    shortfallPercent,
    ldAmount,
    ldCapped,
    basis,
    reasons,
  };
}

export interface GuaranteeExposure {
  byCurrency: Array<{ currency: string; amount: number; guarantees: number; capped: number }>;
  unpricedShortfalls: Array<{ id: string; reference: string; parameter: string; shortfall: number }>;
  unmeasured: Array<{ id: string; reference: string; parameter: string }>;
  reasons: string[];
}

/** Roll up the exposure, never summing across currencies. */
export function guaranteeExposure(
  assessed: Array<{ guarantee: GuaranteeLike; assessment: GuaranteeAssessment }>,
): GuaranteeExposure {
  const byCurrency = new Map<string, { amount: number; guarantees: number; capped: number }>();
  const unpricedShortfalls: GuaranteeExposure["unpricedShortfalls"] = [];
  const unmeasured: GuaranteeExposure["unmeasured"] = [];
  for (const { guarantee, assessment } of assessed) {
    if (assessment.met === null) {
      if (assessment.status !== "waived") {
        unmeasured.push({
          id: guarantee.id,
          reference: guarantee.reference,
          parameter: guarantee.parameter,
        });
      }
      continue;
    }
    if (assessment.met) continue;
    if (assessment.ldAmount === null) {
      unpricedShortfalls.push({
        id: guarantee.id,
        reference: guarantee.reference,
        parameter: guarantee.parameter,
        shortfall: assessment.shortfall ?? 0,
      });
      continue;
    }
    const key = guarantee.currency || "USD";
    const bucket = byCurrency.get(key) ?? { amount: 0, guarantees: 0, capped: 0 };
    bucket.amount += assessment.ldAmount;
    bucket.guarantees += 1;
    if (assessment.ldCapped) bucket.capped += 1;
    byCurrency.set(key, bucket);
  }
  const reasons: string[] = [];
  if (unpricedShortfalls.length > 0) {
    reasons.push(
      `${unpricedShortfalls.length} guarantee(s) are short of their requirement with no damages rate recorded, so the exposure below is a floor: ${unpricedShortfalls
        .map((u) => `${u.reference} (${u.parameter}, short ${u.shortfall})`)
        .join(", ")}.`,
    );
  }
  if (unmeasured.length > 0) {
    reasons.push(
      `${unmeasured.length} guarantee(s) have not been measured at all, so nothing is known about them either way.`,
    );
  }
  if (byCurrency.size > 1) {
    reasons.push(
      "Exposure is held in more than one currency and is reported per currency; a combined total would be invented.",
    );
  }
  return {
    byCurrency: [...byCurrency.entries()]
      .map(([currency, v]) => ({
        currency,
        amount: round2(v.amount),
        guarantees: v.guarantees,
        capped: v.capped,
      }))
      .sort((a, b) => (a.currency < b.currency ? -1 : 1)),
    unpricedShortfalls,
    unmeasured,
    reasons,
  };
}
