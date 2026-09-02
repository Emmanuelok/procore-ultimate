/**
 * Concrete acceptance arithmetic (#1085–1086).
 *
 * A cube result is not a verdict. Every concrete code judges a POUR against a
 * RUN of results, and the run rules differ enough to matter: EN 206 asks for
 * a mean over fck + 4 (or fck + 1.48σ once production is established) with no
 * individual result more than 4 MPa below fck; ACI 318 asks that every average
 * of three consecutive tests reach f'c and that no single test fall more than
 * 3.45 MPa below it (or below 0.90 f'c for high strengths). Applying the wrong
 * one is how a compliant pour gets broken out and a non-compliant one gets
 * left in.
 *
 * Pure and deterministic: no clock, no database. Every verdict carries the
 * checks it ran and the reason each one passed or failed, and a pour with no
 * tested specimens returns `not_assessable` — never a pass, and never a fail.
 * A 28-day result nobody has yet is not a failure.
 *
 * Deliberately NOT here: mix design, maturity-method conversions and
 * temperature-matched curing. Those need data the platform does not hold, and
 * a fabricated conversion factor is worse than an honest refusal.
 */

import type { ConcreteAcceptanceCode } from "@constructos/shared";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Comparison slack so 34.999999999 does not fail a 35.0 limit. */
const EPSILON = 1e-9;

const gte = (a: number, b: number): boolean => a - b >= -EPSILON;

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

export interface SpecimenLike {
  id: string;
  specimenRef: string;
  specimenType: string;
  testAgeDays: number;
  testDate: string | null;
  strengthMpa: number | null;
  result: string;
}

export interface PourSpecLike {
  specifiedStrengthMpa: number | null;
  testAgeDays: number;
  acceptanceCode: string;
  /**
   * Earlier results for the same mix on the same project, used where the code
   * allows a standard deviation from established production. Omitted or short
   * runs fall back to the initial-production rule, which is stricter.
   */
  priorResults?: number[];
}

export interface StrengthStatistics {
  testedCount: number;
  pendingCount: number;
  voidCount: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  /** sample standard deviation (n-1); null below two results */
  standardDeviation: number | null;
  /** the values used, in test order, so a reviewer can re-run the arithmetic */
  values: number[];
  reasons: string[];
}

export interface AcceptanceCheck {
  name: string;
  /** null when the check could not be run at all */
  passed: boolean | null;
  requirement: string;
  observed: string;
}

export type AcceptanceVerdict = "accepted" | "rejected" | "inconclusive" | "not_assessable";

export interface PourAssessment {
  code: ConcreteAcceptanceCode;
  verdict: AcceptanceVerdict;
  statistics: StrengthStatistics;
  checks: AcceptanceCheck[];
  reasons: string[];
}

/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

/** Specimens that count towards a verdict: tested, with a strength, not void. */
export function assessableSpecimens(specimens: SpecimenLike[], atAgeDays?: number): SpecimenLike[] {
  return specimens.filter(
    (s) =>
      s.result !== "void" &&
      typeof s.strengthMpa === "number" &&
      Number.isFinite(s.strengthMpa) &&
      (atAgeDays === undefined || s.testAgeDays === atAgeDays),
  );
}

function sortSpecimens(specimens: SpecimenLike[]): SpecimenLike[] {
  return [...specimens].sort((a, b) => {
    const da = a.testDate ?? "";
    const db = b.testDate ?? "";
    if (da !== db) return da < db ? -1 : 1;
    return a.specimenRef < b.specimenRef ? -1 : a.specimenRef > b.specimenRef ? 1 : 0;
  });
}

export function strengthStatistics(
  specimens: SpecimenLike[],
  atAgeDays?: number,
): StrengthStatistics {
  const reasons: string[] = [];
  const inScope = atAgeDays === undefined ? specimens : specimens.filter((s) => s.testAgeDays === atAgeDays);
  const voidCount = inScope.filter((s) => s.result === "void").length;
  const tested = sortSpecimens(assessableSpecimens(inScope, atAgeDays));
  const pendingCount = inScope.filter(
    (s) => s.result !== "void" && (s.strengthMpa === null || !Number.isFinite(s.strengthMpa ?? NaN)),
  ).length;
  const values = tested.map((s) => s.strengthMpa as number);
  if (values.length === 0) {
    reasons.push(
      atAgeDays === undefined
        ? "No specimen on this pour has a recorded strength, so no statistics can be computed. That is not a strength of zero — it is an untested pour."
        : `No specimen on this pour has a recorded strength at ${atAgeDays} days, so no statistics can be computed at the specified test age.`,
    );
    return {
      testedCount: 0,
      pendingCount,
      voidCount,
      mean: null,
      min: null,
      max: null,
      standardDeviation: null,
      values: [],
      reasons,
    };
  }
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / values.length;
  let standardDeviation: number | null = null;
  if (values.length >= 2) {
    const variance =
      values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / (values.length - 1);
    standardDeviation = round2(Math.sqrt(variance));
  } else {
    reasons.push(
      "One result cannot produce a standard deviation; the run is judged against the initial-production rule instead.",
    );
  }
  if (pendingCount > 0) {
    reasons.push(
      `${pendingCount} specimen(s) on this pour are cast but not yet tested, so the verdict is provisional on them.`,
    );
  }
  if (voidCount > 0) {
    reasons.push(
      `${voidCount} specimen(s) are voided and excluded — a voided specimen is not a failed one, and the reason it was voided is recorded on the row.`,
    );
  }
  return {
    testedCount: values.length,
    pendingCount,
    voidCount,
    mean: round2(mean),
    min: round2(Math.min(...values)),
    max: round2(Math.max(...values)),
    standardDeviation,
    values: values.map(round2),
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* Code rules                                                          */
/* ------------------------------------------------------------------ */

/** Consecutive groups of `size`, non-overlapping, in test order. */
export function consecutiveGroups(values: number[], size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i + size <= values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

/** Every rolling window of `size` (ACI's "any three consecutive tests"). */
export function rollingGroups(values: number[], size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i + size <= values.length; i += 1) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * EN 206 / BS 8500 conformity for compressive strength.
 *
 * Initial production (fewer than 35 results in the run): mean of any three
 * consecutive results ≥ fck + 4, and every individual result ≥ fck − 4.
 * Continuous production (35+ results and a standard deviation to hand):
 * mean ≥ fck + 1.48σ, and every individual result ≥ fck − 4.
 */
function assessEn206(fck: number, values: number[], priorResults: number[]): AcceptanceCheck[] {
  const checks: AcceptanceCheck[] = [];
  const run = [...priorResults, ...values];
  const continuous = run.length >= 35;
  const sigma =
    continuous && run.length >= 2
      ? Math.sqrt(
          run.reduce((acc, v) => acc + (v - mean(run)) * (v - mean(run)), 0) / (run.length - 1),
        )
      : null;

  const individualLimit = fck - 4;
  const belowIndividual = values.filter((v) => !gte(v, individualLimit));
  checks.push({
    name: "individual result",
    passed: belowIndividual.length === 0,
    requirement: `every result ≥ fck − 4 = ${round2(individualLimit)} MPa`,
    observed:
      belowIndividual.length === 0
        ? `lowest result ${round2(Math.min(...values))} MPa`
        : `${belowIndividual.length} result(s) below the limit: ${belowIndividual.map(round2).join(", ")} MPa`,
  });

  if (continuous && sigma !== null) {
    const meanLimit = fck + 1.48 * sigma;
    const observedMean = mean(values);
    checks.push({
      name: "mean (continuous production)",
      passed: gte(observedMean, meanLimit),
      requirement: `mean ≥ fck + 1.48σ = ${round2(meanLimit)} MPa (σ = ${round2(sigma)} over ${run.length} results)`,
      observed: `mean ${round2(observedMean)} MPa`,
    });
    return checks;
  }

  const meanLimit = fck + 4;
  const groups = rollingGroups(values, 3);
  if (groups.length === 0) {
    const observedMean = mean(values);
    checks.push({
      name: "mean of three consecutive results",
      passed: null,
      requirement: `mean of any three consecutive results ≥ fck + 4 = ${round2(meanLimit)} MPa`,
      observed: `only ${values.length} result(s) available (mean ${round2(observedMean)} MPa) — the three-result rule cannot be applied yet`,
    });
    return checks;
  }
  const failing = groups.filter((g) => !gte(mean(g), meanLimit));
  checks.push({
    name: "mean of three consecutive results",
    passed: failing.length === 0,
    requirement: `mean of any three consecutive results ≥ fck + 4 = ${round2(meanLimit)} MPa`,
    observed:
      failing.length === 0
        ? `${groups.length} group(s) checked, lowest group mean ${round2(Math.min(...groups.map(mean)))} MPa`
        : `${failing.length} group(s) below the limit, lowest ${round2(Math.min(...failing.map(mean)))} MPa`,
  });
  return checks;
}

/**
 * ACI 318 §26.12.3.1: every average of three consecutive strength tests ≥ f'c,
 * and no individual test below f'c − 3.45 MPa (f'c ≤ 35 MPa) or below 0.90 f'c
 * (f'c > 35 MPa).
 */
function assessAci318(fc: number, values: number[]): AcceptanceCheck[] {
  const checks: AcceptanceCheck[] = [];
  const individualLimit = fc <= 35 ? fc - 3.45 : 0.9 * fc;
  const below = values.filter((v) => !gte(v, individualLimit));
  checks.push({
    name: "individual test",
    passed: below.length === 0,
    requirement:
      fc <= 35
        ? `no test below f'c − 3.45 = ${round2(individualLimit)} MPa`
        : `no test below 0.90 f'c = ${round2(individualLimit)} MPa`,
    observed:
      below.length === 0
        ? `lowest test ${round2(Math.min(...values))} MPa`
        : `${below.length} test(s) below the limit: ${below.map(round2).join(", ")} MPa`,
  });
  const groups = rollingGroups(values, 3);
  if (groups.length === 0) {
    checks.push({
      name: "average of three consecutive tests",
      passed: null,
      requirement: `every average of three consecutive tests ≥ f'c = ${round2(fc)} MPa`,
      observed: `only ${values.length} test(s) available — the three-test average cannot be formed yet`,
    });
    return checks;
  }
  const failing = groups.filter((g) => !gte(mean(g), fc));
  checks.push({
    name: "average of three consecutive tests",
    passed: failing.length === 0,
    requirement: `every average of three consecutive tests ≥ f'c = ${round2(fc)} MPa`,
    observed:
      failing.length === 0
        ? `${groups.length} average(s) checked, lowest ${round2(Math.min(...groups.map(mean)))} MPa`
        : `${failing.length} average(s) below f'c, lowest ${round2(Math.min(...failing.map(mean)))} MPa`,
  });
  return checks;
}

/**
 * IS 456 Table 11: mean of four non-overlapping consecutive results ≥
 * fck + 0.825σ (or fck + 3 for grades below M20, fck + 4 at M20 and above,
 * whichever is greater), and every individual result ≥ fck − 4 (M20 and above)
 * or ≥ fck − 3 below M20.
 */
function assessIs456(fck: number, values: number[]): AcceptanceCheck[] {
  const checks: AcceptanceCheck[] = [];
  const individualMargin = fck >= 20 ? 4 : 3;
  const individualLimit = fck - individualMargin;
  const below = values.filter((v) => !gte(v, individualLimit));
  checks.push({
    name: "individual result",
    passed: below.length === 0,
    requirement: `every result ≥ fck − ${individualMargin} = ${round2(individualLimit)} MPa`,
    observed:
      below.length === 0
        ? `lowest result ${round2(Math.min(...values))} MPa`
        : `${below.length} result(s) below the limit: ${below.map(round2).join(", ")} MPa`,
  });
  const groups = consecutiveGroups(values, 4);
  if (groups.length === 0) {
    checks.push({
      name: "mean of four non-overlapping results",
      passed: null,
      requirement: `mean of four consecutive results ≥ fck + ${fck >= 20 ? 4 : 3} MPa`,
      observed: `only ${values.length} result(s) available — the four-result group cannot be formed yet`,
    });
    return checks;
  }
  const sigma =
    values.length >= 2
      ? Math.sqrt(
          values.reduce((acc, v) => acc + (v - mean(values)) * (v - mean(values)), 0) /
            (values.length - 1),
        )
      : 0;
  const limit = Math.max(fck + 0.825 * sigma, fck + (fck >= 20 ? 4 : 3));
  const failing = groups.filter((g) => !gte(mean(g), limit));
  checks.push({
    name: "mean of four non-overlapping results",
    passed: failing.length === 0,
    requirement: `mean of each group of four ≥ max(fck + 0.825σ, fck + ${fck >= 20 ? 4 : 3}) = ${round2(limit)} MPa`,
    observed:
      failing.length === 0
        ? `${groups.length} group(s) checked, lowest group mean ${round2(Math.min(...groups.map(mean)))} MPa`
        : `${failing.length} group(s) below the limit, lowest ${round2(Math.min(...failing.map(mean)))} MPa`,
  });
  return checks;
}

/** The fallback when the project has told the platform only the grade. */
function assessSpecifiedOnly(fck: number, values: number[]): AcceptanceCheck[] {
  const below = values.filter((v) => !gte(v, fck));
  return [
    {
      name: "every result at or above the specified strength",
      passed: below.length === 0,
      requirement: `every result ≥ specified ${round2(fck)} MPa (no statistical allowance applied, because no code was selected)`,
      observed:
        below.length === 0
          ? `lowest result ${round2(Math.min(...values))} MPa`
          : `${below.length} result(s) below the specified strength: ${below.map(round2).join(", ")} MPa`,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

const CODE_LABEL: Record<string, string> = {
  en_206: "EN 206",
  bs_8500: "BS 8500 (EN 206 conformity rules)",
  aci_318: "ACI 318",
  is_456: "IS 456",
  specified_only: "specified strength only",
};

/**
 * Judge a pour. `not_assessable` when there is nothing to judge (no specified
 * strength, or no tested specimen); `inconclusive` when the code's group rule
 * needs more results than the run holds and nothing has failed yet.
 */
export function assessPour(spec: PourSpecLike, specimens: SpecimenLike[]): PourAssessment {
  const code = ((CODE_LABEL[spec.acceptanceCode] ? spec.acceptanceCode : "specified_only") ??
    "specified_only") as ConcreteAcceptanceCode;
  const statistics = strengthStatistics(specimens, spec.testAgeDays);
  const reasons: string[] = [...statistics.reasons];

  if (spec.specifiedStrengthMpa === null || !Number.isFinite(spec.specifiedStrengthMpa)) {
    reasons.push(
      "No specified characteristic strength is recorded on this pour, so no acceptance rule can be applied. The grade is what the results are judged against; without it the numbers are just numbers.",
    );
    return { code, verdict: "not_assessable", statistics, checks: [], reasons };
  }
  if (statistics.testedCount === 0) {
    return { code, verdict: "not_assessable", statistics, checks: [], reasons };
  }

  const fck = spec.specifiedStrengthMpa;
  const values = statistics.values;
  const checks =
    code === "aci_318"
      ? assessAci318(fck, values)
      : code === "is_456"
        ? assessIs456(fck, values)
        : code === "specified_only"
          ? assessSpecifiedOnly(fck, values)
          : assessEn206(fck, values, spec.priorResults ?? []);

  const failed = checks.filter((c) => c.passed === false);
  const unrun = checks.filter((c) => c.passed === null);
  let verdict: AcceptanceVerdict;
  if (failed.length > 0) {
    verdict = "rejected";
    reasons.push(
      `${CODE_LABEL[code]} is not satisfied: ${failed.map((c) => `${c.name} — ${c.observed} against ${c.requirement}`).join("; ")}. ` +
        `A pour that fails its acceptance criteria is a non-conformance: raise it, and let the designer decide between assessment, strengthening and removal.`,
    );
  } else if (unrun.length > 0) {
    verdict = "inconclusive";
    reasons.push(
      `${CODE_LABEL[code]} needs more results before a verdict stands: ${unrun.map((c) => `${c.name} — ${c.observed}`).join("; ")}.`,
    );
  } else {
    verdict = "accepted";
    reasons.push(`${CODE_LABEL[code]} is satisfied on every applicable check.`);
  }
  if (statistics.pendingCount > 0 && verdict === "accepted") {
    verdict = "inconclusive";
    reasons.push(
      "Specimens are still to be tested, so the pour is not finally accepted on the results held today.",
    );
  }
  return { code, verdict, statistics, checks, reasons };
}

/**
 * Fresh-concrete conformance: slump against the specified window. Returned
 * separately from strength because it fails at the truck, hours before any
 * cube is crushed, and the decision it drives (reject the load) is different.
 */
export function slumpVerdict(
  slumpMm: number | null,
  specMin: number | null,
  specMax: number | null,
): { passed: boolean | null; reason: string } {
  if (slumpMm === null) {
    return { passed: null, reason: "No slump was recorded for this pour." };
  }
  if (specMin === null && specMax === null) {
    return {
      passed: null,
      reason: `Slump ${slumpMm} mm was recorded but no specified window is held, so it cannot be judged.`,
    };
  }
  if (specMin !== null && slumpMm < specMin - EPSILON) {
    return { passed: false, reason: `Slump ${slumpMm} mm is below the specified minimum ${specMin} mm.` };
  }
  if (specMax !== null && slumpMm > specMax + EPSILON) {
    return { passed: false, reason: `Slump ${slumpMm} mm is above the specified maximum ${specMax} mm.` };
  }
  return {
    passed: true,
    reason: `Slump ${slumpMm} mm is within the specified window [${specMin ?? "-"}, ${specMax ?? "-"}] mm.`,
  };
}
