/**
 * Fluctuations / price adjustment (spec Vol II Domain B #178; FIDIC 13.8).
 *
 * The classic indexed formula:
 *
 *     Pn = a + b·(Ln/Lo) + c·(En/Eo) + d·(Mn/Mo) + …
 *
 * where `a` is the fixed, non-adjustable element and b, c, d… are the
 * weightings of each cost element, each with a base index (Lo, at the Base
 * Date) and a current index (Ln, at the payment period). The adjustment on a
 * period's work is `workDone × (Pn − 1)`.
 *
 * The engine is pure and total: every index it used, with its period, is
 * returned alongside the factor, so a fluctuation claim can be recomputed
 * from its own record. A missing index is a refusal with a reason — never a
 * silent substitution of 1.0, which would understate or overstate the claim.
 */
import type { FluctuationFormula } from "@constructos/shared";

export interface IndexPoint {
  period: string;
  value: number;
}

export interface FluctuationComponentInput {
  seriesCode: string;
  label: string;
  /** weighting as a fraction of 1 (0.25 = 25%) */
  weighting: number;
  points: IndexPoint[];
}

export interface FluctuationInput {
  formula: FluctuationFormula;
  /** ISO period (YYYY-MM) of the Base Date */
  basePeriod: string;
  /** ISO period (YYYY-MM) of the valuation */
  currentPeriod: string;
  /** the fixed element `a`, as a fraction of 1 */
  nonAdjustable: number;
  components: FluctuationComponentInput[];
  workDoneAmount: number;
}

export interface FluctuationComponentResult {
  seriesCode: string;
  label: string;
  weighting: number;
  basePeriod: string;
  baseIndex: number | null;
  currentPeriod: string;
  currentIndex: number | null;
  ratio: number | null;
  contribution: number | null;
  reason: string | null;
}

export interface FluctuationResult {
  ok: boolean;
  formula: FluctuationFormula;
  factor: number | null;
  adjustment: number | null;
  workDoneAmount: number;
  nonAdjustable: number;
  weightingTotal: number;
  components: FluctuationComponentResult[];
  reasons: string[];
  /** the arithmetic written out, for the "why" panel */
  explanation: string;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const r6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

/**
 * Index value at a period: an exact match, else the latest published value
 * strictly before it (indices are published in arrears). Returns null when
 * nothing on or before the period exists — the caller must then refuse.
 */
export function indexAt(points: IndexPoint[], period: string): { value: number; period: string } | null {
  let best: { value: number; period: string } | null = null;
  for (const p of points) {
    if (p.period > period) continue;
    if (!best || p.period > best.period) best = { value: p.value, period: p.period };
  }
  return best;
}

export function computeFluctuation(input: FluctuationInput): FluctuationResult {
  const reasons: string[] = [];
  const components: FluctuationComponentResult[] = [];
  let weightingTotal = 0;
  let sum = 0;
  let ok = true;

  for (const c of input.components) {
    weightingTotal += c.weighting;
    const base = indexAt(c.points, input.basePeriod);
    const current = indexAt(c.points, input.currentPeriod);
    if (!base || !current || base.value === 0) {
      ok = false;
      const reason = !base
        ? `No published value for ${c.seriesCode} on or before the base period ${input.basePeriod}.`
        : !current
          ? `No published value for ${c.seriesCode} on or before ${input.currentPeriod}.`
          : `Base index for ${c.seriesCode} is zero.`;
      reasons.push(reason);
      components.push({
        seriesCode: c.seriesCode,
        label: c.label,
        weighting: c.weighting,
        basePeriod: base?.period ?? input.basePeriod,
        baseIndex: base?.value ?? null,
        currentPeriod: current?.period ?? input.currentPeriod,
        currentIndex: current?.value ?? null,
        ratio: null,
        contribution: null,
        reason,
      });
      continue;
    }
    const ratio = r6(current.value / base.value);
    const contribution = r6(c.weighting * ratio);
    sum += contribution;
    components.push({
      seriesCode: c.seriesCode,
      label: c.label,
      weighting: c.weighting,
      basePeriod: base.period,
      baseIndex: base.value,
      currentPeriod: current.period,
      currentIndex: current.value,
      ratio,
      contribution,
      reason: null,
    });
  }

  const total = r6(input.nonAdjustable + weightingTotal);
  if (Math.abs(total - 1) > 0.005) {
    ok = false;
    reasons.push(
      `The non-adjustable element (${input.nonAdjustable}) and the weightings (${r6(weightingTotal)}) total ${total}; they must total 1.`,
    );
  }
  if (input.components.length === 0) {
    ok = false;
    reasons.push("No cost elements were supplied, so no adjustment can be computed.");
  }

  const factor = ok ? r6(input.nonAdjustable + sum) : null;
  const adjustment = factor == null ? null : r2(input.workDoneAmount * (factor - 1));
  const explanation = ok
    ? `Pn = ${input.nonAdjustable} + ` +
      components
        .map((c) => `${c.weighting}×(${c.currentIndex}/${c.baseIndex})`)
        .join(" + ") +
      ` = ${factor}. Adjustment = ${input.workDoneAmount} × (${factor} − 1) = ${adjustment}.`
    : `Not computed: ${reasons.join(" ")}`;

  return {
    ok,
    formula: input.formula,
    factor,
    adjustment,
    workDoneAmount: r2(input.workDoneAmount),
    nonAdjustable: input.nonAdjustable,
    weightingTotal: r6(weightingTotal),
    components,
    reasons,
    explanation,
  };
}

/** Human description of each supported formula, for the reference panel. */
export function fluctuationFormulaLibrary(): Array<{
  formula: FluctuationFormula;
  name: string;
  description: string;
  reference: string;
}> {
  return [
    {
      formula: "fidic_13_8",
      name: "FIDIC 13.8 — Adjustments for Changes in Cost",
      description:
        "Indexed formula Pn = a + b(Ln/Lo) + c(En/Eo) + …, applied to the amounts in the currency of payment. The weightings and the fixed element a come from the Table of Adjustment Data.",
      reference: "FIDIC Red/Yellow/Silver 2017 Sub-Clause 13.8",
    },
    {
      formula: "nec_option_x1",
      name: "NEC Option X1 — Price adjustment for inflation",
      description:
        "Price Adjustment Factor from the proportions and indices in the Contract Data, applied to the amount due excluding amounts already adjusted.",
      reference: "NEC4 ECC Secondary Option X1",
    },
    {
      formula: "jct_formula",
      name: "JCT Formula Rules (Fluctuations Option C)",
      description:
        "Work categories are adjusted by the monthly bulletin index movement between the Base Month and the month of the valuation period.",
      reference: "JCT SBC 2016 Schedule 7, Fluctuations Option C",
    },
    {
      formula: "simple_cpi",
      name: "Single-index adjustment",
      description:
        "One index and one weighting — the simplest defensible adjustment where a contract names a single published index.",
      reference: "Contract particulars",
    },
  ];
}
