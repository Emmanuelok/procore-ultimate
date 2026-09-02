import type { CostType, MarkupKind } from "@constructos/shared";

/**
 * CHANGE MANAGEMENT ARITHMETIC — pure, dependency-free, and the only place in
 * the module where money is multiplied.
 *
 * Two things in here are worth more than the rest of the module put together.
 *
 * 1. THE MARKUP STACK. Overhead, profit, bond and insurance are not four
 *    independent percentages: each one names a BASIS, and whether profit is
 *    taken on cost or on cost-plus-overhead changes the number. Applied in the
 *    wrong order, a 10% overhead + 5% profit + 1% bond stack on 100,000 pays
 *    either 116,655 or 116,000 depending on how you read the contract, and
 *    which of those two figures a contractor invoices is a dispute that gets
 *    litigated. So the stack is ORDERED, every step records the basis it
 *    multiplied and the running total it produced, and the result is
 *    reproducible from the stored rule set alone.
 *
 * 2. THE REFUSAL TO INVENT. A per-unit markup over lines that carry no
 *    quantity is not zero, it is unknown; a compounding markup placed first in
 *    the stack has nothing to compound onto. Both come back as a `reason`
 *    rather than as a quietly-plausible number, and the routes refuse to
 *    persist a total that carries reasons. `Component` is shaped identically
 *    to the benchmarks module's `MetricComputation` so a client renders
 *    "—, because …" the same way everywhere.
 *
 * ROUNDING. Every markup step rounds to cents BEFORE it enters the running
 * total, because a markup is charged in cents and a compounding stack that
 * carries full float precision forward produces a total no one can reproduce
 * on paper. The consequence is that the stack total is exactly the sum of its
 * printed parts — which is the property a quantity surveyor checks first.
 */

/* ------------------------------------------------------------------ */
/* Numeric primitives                                                  */
/* ------------------------------------------------------------------ */

/** Money to 2dp. Every value that leaves this file passes through it. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Percentages / ratios to 4dp. */
export const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/** Half a cent — the tolerance for every balance check in the module. */
export const MONEY_EPSILON = 0.005;

export const nearlyEqual = (a: number, b: number, tolerance = MONEY_EPSILON): boolean =>
  Math.abs(a - b) <= tolerance;

export const isFiniteNumber = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);

/**
 * Group-separated 2dp money for error prose. Hand-rolled rather than
 * `toLocaleString` so an error message reads identically on every runtime and
 * locale — these strings end up quoted in disputes.
 */
export function formatMoney(n: number): string {
  const value = round2(n);
  const negative = value < 0;
  const fixed = Math.abs(value).toFixed(2);
  const dot = fixed.indexOf(".");
  const whole = fixed.slice(0, dot);
  const frac = fixed.slice(dot + 1);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}.${frac}`;
}

/* ------------------------------------------------------------------ */
/* The "no fabricated number" contract                                 */
/* ------------------------------------------------------------------ */

/** A figure the platform either holds the inputs for, or does not. */
export interface Component {
  /** null when the inputs are absent — never a fabricated 0 */
  value: number | null;
  /** the exact figures the computation read */
  inputs: Record<string, unknown>;
  /** why `value` is null; empty when a value was computed */
  reasons: string[];
}

export const computed = (
  value: number,
  inputs: Record<string, unknown> = {},
  round: (n: number) => number = round2,
): Component => ({ value: round(value), inputs, reasons: [] });

export const unavailable = (
  reasons: string[],
  inputs: Record<string, unknown> = {},
): Component => ({ value: null, inputs, reasons });

/** A ratio that is undefined on a zero denominator rather than 0. */
export function ratio(
  numerator: number,
  denominator: number,
  what: string,
): Component {
  const inputs = { numerator: round2(numerator), denominator: round2(denominator) };
  if (!isFiniteNumber(numerator) || !isFiniteNumber(denominator)) {
    return unavailable([`${what} needs two finite figures.`], inputs);
  }
  if (denominator === 0) {
    return unavailable(
      [`${what} is undefined against a zero base — 0/0 is not 0%.`],
      inputs,
    );
  }
  return computed((numerator / denominator) * 100, inputs, round4);
}

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

export interface Identity {
  identity: string;
  left: number;
  right: number;
  /** left − right; the sign says which side is heavy */
  delta: number;
  ok: boolean;
}

export const checkIdentity = (identity: string, left: number, right: number): Identity => ({
  identity,
  left: round2(left),
  right: round2(right),
  delta: round2(left - right),
  ok: nearlyEqual(left, right),
});

/* ------------------------------------------------------------------ */
/* Change lines                                                        */
/* ------------------------------------------------------------------ */

export const COST_TYPE_KEYS: readonly CostType[] = [
  "labour",
  "material",
  "equipment",
  "subcontract",
  "other",
];

/** The figures a caller may type on a change line. */
export interface ChangeLineInput {
  quantity?: number | null;
  unitRate?: number | null;
  costAmount?: number | null;
  revenueAmount?: number | null;
  markupKind?: MarkupKind | null;
  markupPercent?: number | null;
  markupAmount?: number | null;
  taxPercent?: number | null;
  taxAmount?: number | null;
}

export interface DerivedChangeLine {
  costAmount: number;
  markupAmount: number;
  revenueAmount: number;
  taxAmount: number;
  /** revenueAmount − costAmount; the margin the change carries */
  margin: number;
}

export type LineDerivation =
  | { ok: true; line: DerivedChangeLine }
  | { ok: false; error: string };

/**
 * Turn what a caller typed into the four stored figures, refusing every
 * ambiguity rather than picking a winner.
 *
 * The important refusal is the third one: a measured line's cost IS quantity ×
 * rate, so a typed cost amount that disagrees with the typed quantity and rate
 * is not a rounding difference to be smoothed over — the disagreement is the
 * interesting fact and it goes back to the caller with all three figures.
 *
 * Tax is taken on the REVENUE amount, not on cost: what is billed is what is
 * taxed, and on a marked-up change those are different numbers.
 */
export function deriveChangeLine(input: ChangeLineInput): LineDerivation {
  const qty = isFiniteNumber(input.quantity) ? input.quantity : null;
  const rate = isFiniteNumber(input.unitRate) ? input.unitRate : null;
  const typedCost = isFiniteNumber(input.costAmount) ? input.costAmount : null;

  let costAmount: number;
  if (typedCost !== null && qty !== null && rate !== null) {
    const measured = round2(qty * rate);
    if (!nearlyEqual(measured, round2(typedCost))) {
      return {
        ok: false,
        error:
          `Cost amount ${formatMoney(typedCost)} disagrees with quantity ${qty} × unit rate ` +
          `${formatMoney(rate)} = ${formatMoney(measured)}. Send the quantity and the rate, or ` +
          "send the amount — not two figures that contradict each other.",
      };
    }
    costAmount = measured;
  } else if (typedCost !== null) {
    costAmount = round2(typedCost);
  } else if (qty !== null && rate !== null) {
    costAmount = round2(qty * rate);
  } else {
    return {
      ok: false,
      error:
        "A change line needs either a cost amount, or a quantity and a unit rate. A line with " +
        "no priced basis is a note, not a cost.",
    };
  }

  const markupKind = input.markupKind ?? null;
  const markupPercent = isFiniteNumber(input.markupPercent) ? input.markupPercent : null;
  const typedMarkup = isFiniteNumber(input.markupAmount) ? input.markupAmount : null;

  let markupAmount: number;
  if (markupKind === null) {
    markupAmount = typedMarkup ?? 0;
  } else if (markupKind === "percent") {
    if (markupPercent === null) {
      return { ok: false, error: "A percent markup on a line needs markupPercent." };
    }
    if (markupPercent < 0 || markupPercent > 100) {
      return {
        ok: false,
        error: `A line markup of ${markupPercent}% is outside 0–100% — check the figure.`,
      };
    }
    markupAmount = round2(costAmount * (markupPercent / 100));
  } else if (markupKind === "fixed_amount") {
    if (typedMarkup === null) {
      return { ok: false, error: "A fixed-amount line markup needs markupAmount." };
    }
    markupAmount = round2(typedMarkup);
  } else {
    // per_unit
    if (markupPercent === null) {
      return {
        ok: false,
        error: "A per-unit line markup carries its rate in markupPercent (amount per unit).",
      };
    }
    if (qty === null) {
      return {
        ok: false,
        error:
          "A per-unit line markup needs a quantity to multiply. Without one the markup is " +
          "unknown, not zero.",
      };
    }
    markupAmount = round2(qty * markupPercent);
  }

  const revenueAmount = isFiniteNumber(input.revenueAmount)
    ? round2(input.revenueAmount)
    : round2(costAmount + markupAmount);

  const taxPercent = isFiniteNumber(input.taxPercent) ? input.taxPercent : null;
  const typedTax = isFiniteNumber(input.taxAmount) ? input.taxAmount : null;
  let taxAmount: number;
  if (taxPercent !== null) {
    if (taxPercent < 0 || taxPercent > 100) {
      return { ok: false, error: `A tax rate of ${taxPercent}% is outside 0–100%.` };
    }
    taxAmount = round2(revenueAmount * (taxPercent / 100));
  } else {
    taxAmount = typedTax ?? 0;
  }

  return {
    ok: true,
    line: {
      costAmount,
      markupAmount,
      revenueAmount,
      taxAmount,
      margin: round2(revenueAmount - costAmount),
    },
  };
}

/* ------------------------------------------------------------------ */
/* The markup stack                                                    */
/* ------------------------------------------------------------------ */

/**
 * What a markup rate multiplies. This — not the rate — is what contracts
 * argue about.
 *
 *  cost             Σ cost of the lines, optionally narrowed to cost types.
 *                   "10% overhead on labour and material only" is this.
 *  running_total    Cost subtotal PLUS every markup applied before it. This
 *                   is the compounding basis: profit-on-cost-plus-overhead,
 *                   bond-on-the-whole-change.
 *  markups_to_date  The markups alone. Rare, and always a deliberate clause
 *                   ("insurance is charged on the fee, not on the work").
 *  quantity         Σ quantity over the lines — for per-unit markups.
 *  none             A fixed amount that multiplies nothing.
 */
export const MARKUP_BASES = [
  "cost",
  "running_total",
  "markups_to_date",
  "quantity",
  "none",
] as const;
export type MarkupBasis = (typeof MARKUP_BASES)[number];

export interface MarkupRule {
  kind: MarkupKind;
  label: string;
  basis: MarkupBasis;
  /** percent for `percent`, cash for `fixed_amount`, per-unit rate for `per_unit` */
  rate: number;
  /** narrow a `cost` basis to these cost types; null = all lines */
  costTypes?: readonly CostType[] | null;
  /** contractual cap on the MAGNITUDE of this markup ("OH&P not to exceed …") */
  maxAmount?: number | null;
  /** explicit application order; array order when absent */
  sequence?: number | null;
}

export interface AppliedMarkup {
  sequence: number;
  kind: MarkupKind;
  label: string;
  basis: MarkupBasis;
  rate: number;
  costTypes: CostType[] | null;
  /**
   * The contractual cap, carried through so the STORED stack is a complete
   * restatement of the rule that produced it. Without it a recalculation would
   * quietly drop the cap and pay the uncapped markup.
   */
  maxAmount: number | null;
  /** the figure the rate multiplied — the audit trail of the stack */
  basisAmount: number;
  /** before the contractual cap */
  computedAmount: number;
  /** what is actually charged */
  amount: number;
  /** the cap that bit, when one did */
  cappedBy: number | null;
  /** cost subtotal + markups charged up to and including this one */
  runningTotalAfter: number;
  /** why this step could not be computed from the inputs given */
  reasons: string[];
}

export interface MarkupLine {
  costAmount: number;
  costType?: CostType | string | null;
  quantity?: number | null;
  taxAmount?: number | null;
}

export interface MarkupStackResult {
  costSubtotal: number;
  costByType: Record<string, number>;
  quantityTotal: number;
  applied: AppliedMarkup[];
  markupTotal: number;
  taxTotal: number;
  /** costSubtotal + markupTotal + taxTotal */
  total: number;
  /** the change's own margin over cost: markupTotal (tax is not margin) */
  margin: number;
  /** non-empty when `total` rests on a figure the inputs do not support */
  reasons: string[];
}

/** Validate a stack before it is stored. Returns the problems, in order. */
export function validateMarkupStack(rules: readonly MarkupRule[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  rules.forEach((rule, i) => {
    const at = `markup ${i + 1} ("${rule.label}")`;
    const label = rule.label.trim().toLowerCase();
    if (label === "") problems.push(`${at}: a markup needs a label — it is printed on the COR.`);
    if (seen.has(label)) {
      problems.push(
        `${at}: two markups share the label "${rule.label.trim()}". A duplicated markup line is ` +
          "how a change gets charged twice; rename or remove one.",
      );
    }
    seen.add(label);

    if (!isFiniteNumber(rule.rate)) {
      problems.push(`${at}: rate must be a finite number.`);
      return;
    }
    if (rule.kind === "percent") {
      if (rule.basis !== "cost" && rule.basis !== "running_total" && rule.basis !== "markups_to_date") {
        problems.push(
          `${at}: a percent markup must apply to "cost", "running_total" or "markups_to_date" — ` +
            `"${rule.basis}" is not a percentage basis.`,
        );
      }
      if (rule.rate < 0 || rule.rate > 100) {
        problems.push(
          `${at}: ${rule.rate}% is outside 0–100%. A credit is a negative COST line, never a ` +
            "negative markup rate.",
        );
      }
      if (rule.basis !== "cost" && rule.costTypes && rule.costTypes.length > 0) {
        problems.push(
          `${at}: cost types narrow a "cost" basis only. A compounding markup cannot be ` +
            "narrowed to a cost type without ambiguity about what it compounds onto.",
        );
      }
      if (rule.basis === "markups_to_date" && i === 0) {
        problems.push(
          `${at}: it is first in the stack, so there are no prior markups to charge against.`,
        );
      }
    } else if (rule.kind === "fixed_amount") {
      if (rule.basis !== "none") {
        problems.push(`${at}: a fixed amount multiplies nothing — its basis must be "none".`);
      }
    } else {
      if (rule.basis !== "quantity") {
        problems.push(`${at}: a per-unit markup must apply to the "quantity" basis.`);
      }
    }
    if (rule.maxAmount !== undefined && rule.maxAmount !== null) {
      if (!isFiniteNumber(rule.maxAmount) || rule.maxAmount < 0) {
        problems.push(`${at}: maxAmount is a cap on magnitude and cannot be negative.`);
      }
    }
  });
  return problems;
}

/**
 * Apply the stack, in order, recording every intermediate figure.
 *
 * A negative cost subtotal (a value-engineering credit) flows through
 * unchanged: the owner gets the credit net of the same overhead and profit
 * that would have been charged on an addition, which is what the standard
 * forms say and what contractors routinely forget to do.
 */
export function applyMarkupStack(
  lines: readonly MarkupLine[],
  rules: readonly MarkupRule[],
): MarkupStackResult {
  let costSubtotal = 0;
  let quantityTotal = 0;
  let taxTotal = 0;
  let quantityLines = 0;
  const costByType: Record<string, number> = {};
  for (const key of COST_TYPE_KEYS) costByType[key] = 0;

  for (const line of lines) {
    const cost = isFiniteNumber(line.costAmount) ? line.costAmount : 0;
    costSubtotal += cost;
    const type = typeof line.costType === "string" && line.costType !== "" ? line.costType : "other";
    costByType[type] = round2((costByType[type] ?? 0) + cost);
    if (isFiniteNumber(line.quantity)) {
      quantityTotal += line.quantity;
      quantityLines += 1;
    }
    if (isFiniteNumber(line.taxAmount)) taxTotal += line.taxAmount;
  }
  costSubtotal = round2(costSubtotal);
  quantityTotal = round4(quantityTotal);
  taxTotal = round2(taxTotal);

  const ordered = rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => {
      const sa = isFiniteNumber(a.rule.sequence) ? a.rule.sequence : a.index;
      const sb = isFiniteNumber(b.rule.sequence) ? b.rule.sequence : b.index;
      return sa === sb ? a.index - b.index : sa - sb;
    });

  const applied: AppliedMarkup[] = [];
  const reasons: string[] = [];
  let running = costSubtotal;
  let markupsToDate = 0;

  ordered.forEach(({ rule }, position) => {
    const stepReasons: string[] = [];
    const costTypes = rule.costTypes && rule.costTypes.length > 0 ? [...rule.costTypes] : null;

    let basisAmount = 0;
    if (rule.kind === "fixed_amount") {
      basisAmount = 0;
    } else if (rule.basis === "cost") {
      basisAmount = costTypes
        ? round2(costTypes.reduce((s, t) => s + (costByType[t] ?? 0), 0))
        : costSubtotal;
    } else if (rule.basis === "running_total") {
      basisAmount = running;
    } else if (rule.basis === "markups_to_date") {
      basisAmount = markupsToDate;
      if (position === 0) {
        stepReasons.push(
          `"${rule.label}" charges against prior markups but is first in the stack — there are ` +
            "none, so the figure is unknown rather than zero.",
        );
      }
    } else {
      basisAmount = quantityTotal;
      if (quantityLines === 0) {
        stepReasons.push(
          `"${rule.label}" is a per-unit markup but no line carries a quantity — the figure is ` +
            "unknown, not zero.",
        );
      }
    }

    let computedAmount: number;
    if (rule.kind === "percent") computedAmount = round2(basisAmount * (rule.rate / 100));
    else if (rule.kind === "fixed_amount") computedAmount = round2(rule.rate);
    else computedAmount = round2(basisAmount * rule.rate);

    let amount = computedAmount;
    let cappedBy: number | null = null;
    const cap = rule.maxAmount;
    if (isFiniteNumber(cap) && Math.abs(computedAmount) > cap + MONEY_EPSILON) {
      amount = round2(Math.sign(computedAmount) * cap);
      cappedBy = round2(cap);
    }
    if (stepReasons.length > 0) amount = 0;

    markupsToDate = round2(markupsToDate + amount);
    running = round2(running + amount);
    applied.push({
      sequence: position + 1,
      kind: rule.kind,
      label: rule.label,
      basis: rule.basis,
      rate: rule.rate,
      costTypes,
      maxAmount: isFiniteNumber(cap) ? round2(cap) : null,
      basisAmount: round2(basisAmount),
      computedAmount,
      amount,
      cappedBy,
      runningTotalAfter: running,
      reasons: stepReasons,
    });
    reasons.push(...stepReasons);
  });

  const markupTotal = round2(markupsToDate);
  return {
    costSubtotal,
    costByType,
    quantityTotal,
    applied,
    markupTotal,
    taxTotal,
    total: round2(costSubtotal + markupTotal + taxTotal),
    margin: markupTotal,
    reasons,
  };
}

/** The stack total as a Component — null when any step rests on absent inputs. */
export function stackTotal(result: MarkupStackResult): Component {
  const inputs = {
    costSubtotal: result.costSubtotal,
    markupTotal: result.markupTotal,
    taxTotal: result.taxTotal,
  };
  if (result.reasons.length > 0) return unavailable(result.reasons, inputs);
  return computed(result.total, inputs);
}

/**
 * The identities a priced change must satisfy. Returned on every read so a
 * client can show the arithmetic rather than assert it.
 */
export function markupIdentities(result: MarkupStackResult): Identity[] {
  const stepSum = result.applied.reduce((s, a) => s + a.amount, 0);
  const last = result.applied[result.applied.length - 1];
  return [
    checkIdentity("Σ markup steps = markupTotal", stepSum, result.markupTotal),
    checkIdentity(
      "costSubtotal + markupTotal + taxTotal = total",
      result.costSubtotal + result.markupTotal + result.taxTotal,
      result.total,
    ),
    checkIdentity(
      "last running total = costSubtotal + markupTotal",
      last ? last.runningTotalAfter : result.costSubtotal,
      result.costSubtotal + result.markupTotal,
    ),
  ];
}

/* ------------------------------------------------------------------ */
/* Pro-rata allocation                                                 */
/* ------------------------------------------------------------------ */

export interface AllocationLeg {
  key: string;
  weight: number;
}

export interface AllocatedLeg {
  key: string;
  weight: number;
  amount: number;
  /** the cent(s) of rounding residual parked on this leg */
  residual: number;
}

export type Allocation =
  | { ok: true; legs: AllocatedLeg[]; scale: number; total: number }
  | { ok: false; error: string };

/**
 * Spread `target` across weighted legs so the parts sum to the target EXACTLY.
 *
 * Rounding is not a detail here. Three legs sharing 10,000.00 in thirds round
 * to 3,333.33 each and lose a cent; a change order whose SOV lines are a cent
 * short of its own amount will not reconcile on a G703, and somebody will spend
 * an afternoon finding out why. So the residual is computed and parked on the
 * heaviest leg — deterministically, and reported rather than hidden.
 *
 * The scale factor is returned because it is the audit trail of a PARTIAL
 * approval: an owner who grants 90,000 against a 100,000 ask has moved every
 * cost code by 0.9, and that number belongs in the record.
 */
export function allocateProRata(legs: readonly AllocationLeg[], target: number): Allocation {
  if (legs.length === 0) {
    return { ok: false, error: "Nothing to allocate to — there are no lines." };
  }
  const totalWeight = round2(legs.reduce((s, l) => s + l.weight, 0));
  if (totalWeight === 0) {
    return {
      ok: false,
      error:
        "The lines underneath this change sum to zero, so there is no basis to spread the amount " +
        "across them. Price the lines, or send an explicit allocation.",
    };
  }
  const scale = target / totalWeight;
  const allocated: AllocatedLeg[] = legs.map((l) => ({
    key: l.key,
    weight: round2(l.weight),
    amount: round2(l.weight * scale),
    residual: 0,
  }));
  const rounded = round2(allocated.reduce((s, l) => s + l.amount, 0));
  const residual = round2(target - rounded);
  if (residual !== 0) {
    let heaviest = 0;
    for (let i = 1; i < allocated.length; i += 1) {
      if (Math.abs(allocated[i]!.weight) > Math.abs(allocated[heaviest]!.weight)) heaviest = i;
    }
    const leg = allocated[heaviest]!;
    leg.amount = round2(leg.amount + residual);
    leg.residual = residual;
  }
  return {
    ok: true,
    legs: allocated,
    scale: round4(scale),
    total: round2(allocated.reduce((s, l) => s + l.amount, 0)),
  };
}

/* ------------------------------------------------------------------ */
/* Budget line derivation                                              */
/* ------------------------------------------------------------------ */

export interface BudgetLineAmounts {
  originalBudget: number;
  budgetModifications: number;
  approvedChanges: number;
  jobToDateCosts: number;
  forecastMethod: string;
  forecastToComplete: number;
  percentComplete: number;
}

export interface DerivedBudgetLine {
  revisedBudget: number;
  forecastToComplete: number;
  forecastFinal: number;
  projectedOverUnder: number;
  /** why the forecast to complete was left as it stood */
  reasons: string[];
}

/**
 * What an owner-funded budget increase does to a budget line.
 *
 * Only two forecast methods derive FROM the revised budget, so only those two
 * are re-settled when funding moves. A percent-complete or productivity
 * forecast rests on progress the change order says nothing about; re-deriving
 * it here would silently republish a forecast nobody made. The stored figure is
 * kept and the reason is handed back — stale beats fabricated.
 */
export function deriveBudgetLine(line: BudgetLineAmounts): DerivedBudgetLine {
  const revisedBudget = round2(
    line.originalBudget + line.budgetModifications + line.approvedChanges,
  );
  const reasons: string[] = [];
  let ftc = line.forecastToComplete;
  if (line.forecastMethod === "remaining_budget") {
    if (revisedBudget === 0 && line.jobToDateCosts === 0) {
      reasons.push(
        "Forecast method 'remaining_budget' needs a revised budget or costs to date; this line " +
          "has neither, so the stored forecast to complete stands.",
      );
    } else {
      ftc = round2(Math.max(0, revisedBudget - line.jobToDateCosts));
    }
  } else if (line.forecastMethod === "percent_complete") {
    if (line.percentComplete <= 0 || line.percentComplete > 1 || revisedBudget === 0) {
      reasons.push(
        "Forecast method 'percent_complete' needs a percent complete in (0, 1] and a revised " +
          "budget; the stored forecast to complete stands.",
      );
    } else {
      ftc = round2(Math.max(0, revisedBudget * (1 - line.percentComplete)));
    }
  } else {
    reasons.push(
      `Forecast method '${line.forecastMethod}' does not derive from the revised budget, so the ` +
        "stored forecast to complete is unchanged by this change order.",
    );
  }
  const forecastToComplete = round2(Math.max(0, ftc));
  const forecastFinal = round2(line.jobToDateCosts + forecastToComplete);
  return {
    revisedBudget,
    forecastToComplete,
    forecastFinal,
    projectedOverUnder: round2(revisedBudget - forecastFinal),
    reasons,
  };
}
