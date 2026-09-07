/**
 * Computed financial covenants (spec Vol II Domain O #743).
 *
 * WHY THIS EXISTS
 * A covenant reading typed in by the borrower's own finance team is an
 * assertion with no evidence behind it. A covenant reading DERIVED from
 * period cashflow inputs by a named formula is a calculation anybody can
 * check: the inputs are on the record, the formula is in code, and the
 * arithmetic is reproducible.
 *
 * There is no expression evaluator here and no `eval`. Each covenant names
 * one of a fixed library of ratios; unknown formulas fall back to `custom`,
 * which keeps the manual-reading path exactly as it was.
 *
 * DIVISION BY ZERO is not an error and not a zero: a DSCR with no debt
 * service is undefined, and the honest answer is "not computable, because
 * debtService is 0", which is what the caller gets.
 */
import type { CovenantFormula } from "@constructos/shared";

export interface CovenantInputs {
  [key: string]: number | undefined;
}

export interface FormulaSpec {
  formula: CovenantFormula;
  label: string;
  /** the named period inputs the formula reads */
  inputs: string[];
  /** plain-English statement of the arithmetic, shown next to the reading */
  definition: string;
  /** which direction complies — informational, the operator on the covenant governs */
  higherIsBetter: boolean;
}

export const COVENANT_FORMULA_LIBRARY: readonly FormulaSpec[] = [
  {
    formula: "dscr",
    label: "Debt service cover ratio",
    inputs: ["cfads", "debtService"],
    definition: "CFADS ÷ debt service for the period.",
    higherIsBetter: true,
  },
  {
    formula: "llcr",
    label: "Loan life cover ratio",
    inputs: ["npvOfCfads", "totalDebt"],
    definition: "NPV of CFADS over the remaining loan life ÷ debt outstanding.",
    higherIsBetter: true,
  },
  {
    formula: "gearing",
    label: "Gearing",
    inputs: ["totalDebt", "totalEquity"],
    definition: "Total debt ÷ (total debt + total equity), expressed as a ratio.",
    higherIsBetter: false,
  },
  {
    formula: "interest_cover",
    label: "Interest cover",
    inputs: ["ebitda", "interestPaid"],
    definition: "EBITDA ÷ interest paid for the period.",
    higherIsBetter: true,
  },
  {
    formula: "current_ratio",
    label: "Current ratio",
    inputs: ["currentAssets", "currentLiabilities"],
    definition: "Current assets ÷ current liabilities.",
    higherIsBetter: true,
  },
  {
    formula: "debt_to_ebitda",
    label: "Debt / EBITDA",
    inputs: ["totalDebt", "ebitda"],
    definition: "Total debt ÷ EBITDA for the period.",
    higherIsBetter: false,
  },
  {
    formula: "custom",
    label: "Manual reading",
    inputs: [],
    definition: "Entered by hand; no derivation is recorded.",
    higherIsBetter: true,
  },
] as const;

const BY_FORMULA = new Map(COVENANT_FORMULA_LIBRARY.map((f) => [f.formula, f]));

export function formulaSpec(formula: string): FormulaSpec | null {
  return BY_FORMULA.get(formula as CovenantFormula) ?? null;
}

export interface ComputedReading {
  value: number | null;
  formula: string;
  /** the inputs actually used, echoed onto the reading for audit */
  used: Record<string, number>;
  basis: string;
  /** present when the reading could not be computed */
  unavailableReason: string | null;
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * Compute one covenant reading from a period's inputs. Missing inputs and
 * zero denominators produce `value: null` with the reason — never a 0 that
 * would read as a catastrophic breach.
 */
export function computeCovenantReading(
  formula: string,
  inputs: CovenantInputs,
): ComputedReading {
  const spec = formulaSpec(formula);
  if (!spec) {
    return {
      value: null,
      formula,
      used: {},
      basis: "",
      unavailableReason: `Unknown covenant formula "${formula}".`,
    };
  }
  if (spec.formula === "custom") {
    return {
      value: null,
      formula,
      used: {},
      basis: spec.definition,
      unavailableReason: "This covenant is set to manual readings; nothing is derived.",
    };
  }
  const used: Record<string, number> = {};
  const missing: string[] = [];
  for (const key of spec.inputs) {
    const v = inputs[key];
    if (typeof v !== "number" || !Number.isFinite(v)) missing.push(key);
    else used[key] = v;
  }
  if (missing.length > 0) {
    return {
      value: null,
      formula,
      used,
      basis: spec.definition,
      unavailableReason: `Period inputs missing for ${spec.label}: ${missing.join(", ")}.`,
    };
  }

  const div = (num: number, den: number, denName: string): ComputedReading => {
    if (Math.abs(den) < 1e-12) {
      return {
        value: null,
        formula,
        used,
        basis: spec.definition,
        unavailableReason: `${spec.label} is undefined for this period because ${denName} is 0.`,
      };
    }
    return {
      value: round4(num / den),
      formula,
      used,
      basis: `${spec.definition} ${Object.entries(used)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")} → ${round4(num / den)}.`,
      unavailableReason: null,
    };
  };

  switch (spec.formula) {
    case "dscr":
      return div(used["cfads"]!, used["debtService"]!, "debt service");
    case "llcr":
      return div(used["npvOfCfads"]!, used["totalDebt"]!, "debt outstanding");
    case "gearing":
      return div(
        used["totalDebt"]!,
        used["totalDebt"]! + used["totalEquity"]!,
        "total capital (debt + equity)",
      );
    case "interest_cover":
      return div(used["ebitda"]!, used["interestPaid"]!, "interest paid");
    case "current_ratio":
      return div(used["currentAssets"]!, used["currentLiabilities"]!, "current liabilities");
    case "debt_to_ebitda":
      return div(used["totalDebt"]!, used["ebitda"]!, "EBITDA");
    default:
      return {
        value: null,
        formula,
        used,
        basis: spec.definition,
        unavailableReason: `No implementation for ${spec.label}.`,
      };
  }
}

/* ------------------------------------------------------------------ */
/* Draw-stop evaluation (#747)                                         */
/* ------------------------------------------------------------------ */

export interface CovenantStanding {
  covenantId: string;
  name: string;
  /** latest reading's compliance; null when the covenant has never been read */
  compliant: boolean | null;
  readingDate: string | null;
  headroom: number | null;
  /** a waiver in force at the assessment date, if any */
  waivedBy: { id: string; reference: string | null; effectiveTo: string | null } | null;
}

export interface DrawStop {
  /** true when money may NOT move */
  stopped: boolean;
  reasons: string[];
  /** covenant ids in breach without a waiver */
  breachedCovenantIds: string[];
  /** true when the availability period has ended */
  pastAvailability: boolean;
}

/**
 * The lender's draw-stop test (#741, #747): a facility whose availability
 * period has ended, or that is in covenant breach without a recorded lender
 * waiver, cannot pay out. Both conditions are reported, not just the first
 * one — an operator fixing one wants to know about the other.
 */
export function evaluateDrawStop(options: {
  availabilityEndDate: string | null;
  today: string;
  covenants: CovenantStanding[];
}): DrawStop {
  const reasons: string[] = [];
  const pastAvailability =
    options.availabilityEndDate !== null && options.today > options.availabilityEndDate;
  if (pastAvailability) {
    reasons.push(
      `The facility's availability period ended on ${options.availabilityEndDate}; no further ` +
        `drawings may be requested or paid without a lender extension.`,
    );
  }
  const breached = options.covenants.filter((c) => c.compliant === false && c.waivedBy === null);
  for (const c of breached) {
    reasons.push(
      `Covenant "${c.name}" is in breach as at its ${c.readingDate ?? "latest"} reading ` +
        `(headroom ${c.headroom ?? "n/a"}) and no lender waiver is on record — a breach is a ` +
        `draw-stop event under the facility agreement.`,
    );
  }
  return {
    stopped: pastAvailability || breached.length > 0,
    reasons,
    breachedCovenantIds: breached.map((c) => c.covenantId),
    pastAvailability,
  };
}

/** Is a waiver in force on a given date? */
export function waiverInForce(
  waiver: { effectiveFrom: string; effectiveTo: string | null },
  today: string,
): boolean {
  if (today < waiver.effectiveFrom) return false;
  if (waiver.effectiveTo !== null && today > waiver.effectiveTo) return false;
  return true;
}
