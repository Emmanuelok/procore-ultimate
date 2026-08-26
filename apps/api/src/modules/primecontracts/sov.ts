/**
 * The schedule of values and the AIA G702/G703 arithmetic, as pure functions.
 *
 * Nothing in this file touches the database, Fastify or the clock. That is
 * deliberate: a payment application is a legal document, its arithmetic is
 * the part of the platform an auditor will actually re-perform, and it must
 * be re-performable from a table of numbers with no server running. The
 * routes in `index.ts` do exactly two things with this module — feed it rows
 * and persist what it returns.
 *
 * THE TWO INVARIANTS EVERYTHING ELSE HANGS OFF
 *
 *  1. The schedule of values totals the contract sum. Always. A G703 that
 *     does not add up to the G702's line 3 is not a continuation sheet, it is
 *     a spreadsheet. `checkSovAgainstContract` is the gate, and it names the
 *     discrepancy rather than reporting a boolean, because "off by 12,500.00
 *     on base scope" is actionable and "invalid" is not.
 *
 *  2. Executed change orders APPEND lines, they never edit originals
 *     (`isChangeOrderLine = 1`). So base-scope lines must total the original
 *     contract sum and change-order lines must total the approved change sum
 *     — two legs, checked separately, which is what makes an over-billing on
 *     a change order distinguishable from an over-billing on base scope.
 *
 * THE G702 LADDER, exactly as printed on the form:
 *
 *   1  Original contract sum
 *   2  Net change by change orders            (executed PCCOs only)
 *   3  Contract sum to date                   = 1 + 2
 *   4  Total completed and stored to date     = Σ G703 column G
 *   5a Retainage on completed work
 *   5b Retainage on stored material
 *   5  Total retainage                        = 5a + 5b
 *   6  Total earned less retainage            = 4 − 5
 *   7  Less previous certificates for payment
 *   8  Current payment due                    = 6 − 7
 *   9  Balance to finish plus retainage       = 3 − 6
 *
 * Line 7 is computed as the SUM OF AMOUNTS ACTUALLY CERTIFIED on prior
 * applications, not as "line 6 of the previous certificate". The two are
 * identical whenever every application was certified in full — and when a
 * certifier certified LESS than was applied for (which the form explicitly
 * permits, and which `paymentApplications.certifiedAmount` records), only the
 * sum-of-certified reading leaves the shortfall payable on the next
 * application instead of silently writing it off.
 *
 * MONEY DISCIPLINE. A figure whose inputs are absent comes back as
 * `{ value: null, reasons: [...] }` (`Component`, shaped identically to the
 * benchmarks module's `MetricComputation` so a client renders "—, because …"
 * the same way everywhere). Percent complete on a zero-value line is the
 * canonical case: 0/0 is undefined, and rendering it as 0% is a lie about a
 * line nobody has scheduled any money against.
 */

/* ------------------------------------------------------------------ */
/* Numeric primitives                                                  */
/* ------------------------------------------------------------------ */

/** Money to 2dp. Every value that leaves this file passes through it. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Percentages to 4dp (0.0001% = a basis point of a basis point). */
export const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * Half a cent. `doublePrecision` columns plus repeated 2dp rounding make
 * exact equality the wrong test for a balance check.
 */
export const MONEY_EPSILON = 0.005;

export const nearlyEqual = (a: number, b: number, tolerance = MONEY_EPSILON): boolean =>
  Math.abs(a - b) <= tolerance;

/**
 * Group-separated 2dp money for error prose. Hand-rolled rather than
 * `toLocaleString` so an error message reads identically on every runtime,
 * ICU build and locale — these strings end up quoted in disputes.
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

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

export interface Identity {
  identity: string;
  left: number;
  right: number;
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
/* Retainage terms                                                     */
/* ------------------------------------------------------------------ */

/**
 * A contract's retainage clause, reduced to the four numbers that actually
 * change what is withheld.
 *
 * The step-down (`reductionThresholdPercent` / `reducedPercent`) is the
 * common "10% until the work is 50% complete, 5% thereafter" clause. It is
 * evaluated on the WHOLE contract's percent complete, not line by line,
 * because that is how the clause is drafted — the milestone is a project
 * milestone. Once it trips, the reduced rate is applied to the retainage
 * held TO DATE, so the over-withheld balance from earlier applications is
 * returned through line 6 of the current one. That is the "reduce the held
 * balance" reading of the clause; the alternative reading (keep what was
 * withheld, reduce only future withholding) is a different contract, and a
 * platform that silently picked one would be guessing about money.
 */
export interface RetainageTerms {
  /** rate withheld on completed work, percent (0-100) */
  workPercent: number;
  /** rate withheld on stored material, percent (0-100) */
  materialsPercent: number;
  /** contract percent complete at which the rate steps down; null = never */
  reductionThresholdPercent: number | null;
  /** the rate it steps down TO; null = no step-down */
  reducedPercent: number | null;
}

export const DEFAULT_RETAINAGE_TERMS: RetainageTerms = {
  workPercent: 0,
  materialsPercent: 0,
  reductionThresholdPercent: null,
  reducedPercent: null,
};

export interface EffectiveRetainage {
  /** contract-default work rate after any step-down */
  workPercent: number;
  /** stored-material rate after any step-down */
  materialsPercent: number;
  stepDownApplied: boolean;
  thresholdPercent: number | null;
  reducedPercent: number | null;
  /** contract percent complete the decision was taken on */
  percentCompleteAtCalc: number | null;
  /** human sentence for the application's audit trail; null when not stepped */
  note: string | null;
}

/**
 * Decide the rates in force for one application, given how complete the
 * contract is once this period's work is included.
 */
export function effectiveRetainage(
  terms: RetainageTerms,
  percentComplete: number | null,
): EffectiveRetainage {
  const threshold = terms.reductionThresholdPercent;
  const reduced = terms.reducedPercent;
  const armed = threshold != null && reduced != null;
  const tripped =
    armed && percentComplete != null && percentComplete >= threshold - 1e-9;
  if (!tripped) {
    return {
      workPercent: round4(terms.workPercent),
      materialsPercent: round4(terms.materialsPercent),
      stepDownApplied: false,
      thresholdPercent: threshold,
      reducedPercent: reduced,
      percentCompleteAtCalc: percentComplete == null ? null : round4(percentComplete),
      note: null,
    };
  }
  const cap = reduced as number;
  return {
    workPercent: round4(Math.min(terms.workPercent, cap)),
    materialsPercent: round4(Math.min(terms.materialsPercent, cap)),
    stepDownApplied: true,
    thresholdPercent: threshold,
    reducedPercent: reduced,
    percentCompleteAtCalc: percentComplete == null ? null : round4(percentComplete),
    note:
      `Retainage stepped down to ${round4(cap)}%: the work is ` +
      `${round4(percentComplete as number)}% complete, at or past the ` +
      `${round4(threshold as number)}% reduction threshold. Retainage held to date is ` +
      "recomputed at the reduced rate, so retainage over-withheld under the original " +
      "rate is released through this application.",
  };
}

/** The rate in force for one line: its own rate, capped by any step-down. */
export const lineWorkRate = (lineRate: number, eff: EffectiveRetainage): number =>
  eff.stepDownApplied && eff.reducedPercent != null
    ? round4(Math.min(lineRate, eff.reducedPercent))
    : round4(lineRate);

/* ------------------------------------------------------------------ */
/* The schedule of values                                              */
/* ------------------------------------------------------------------ */

/**
 * The subset of `prime_contract_sov_lines` the arithmetic reads. A drizzle
 * row satisfies it structurally, so routes pass rows straight through.
 */
export interface BillableLine {
  id: string;
  lineNumber: string;
  description: string;
  sortOrder: number;
  billingMethod: string;
  costCode: string | null;
  costType: string | null;
  costCodeId: string | null;
  budgetLineItemId: string | null;
  unit: string | null;
  quantity: number | null;
  unitRate: number | null;
  scheduledValue: number;
  changeOrderValue: number;
  previousBilled: number;
  previousStoredMaterials: number;
  materialsPresentlyStored: number;
  thisPeriodWork: number;
  thisPeriodStoredMaterials: number;
  retainagePercent: number;
  retainageHeld: number;
  retainageReleased: number;
  isChangeOrderLine: number;
  changeOrderPackageId: string | null;
}

/** G703 column C: the scheduled value as amended by change orders. */
export const revisedScheduledValueOf = (l: {
  scheduledValue: number;
  changeOrderValue: number;
}): number => round2(l.scheduledValue + l.changeOrderValue);

export interface SovTotals {
  lineCount: number;
  scheduledValue: number;
  changeOrderValue: number;
  revisedScheduledValue: number;
  /** Σ revised scheduled value over lines that are NOT change-order lines */
  baseScope: number;
  /** Σ revised scheduled value over appended change-order lines */
  changeOrderScope: number;
}

export function sovTotals(lines: readonly BillableLine[]): SovTotals {
  let scheduledValue = 0;
  let changeOrderValue = 0;
  let baseScope = 0;
  let changeOrderScope = 0;
  for (const line of lines) {
    const revised = line.scheduledValue + line.changeOrderValue;
    scheduledValue += line.scheduledValue;
    changeOrderValue += line.changeOrderValue;
    if (line.isChangeOrderLine === 1) changeOrderScope += revised;
    else baseScope += revised;
  }
  return {
    lineCount: lines.length,
    scheduledValue: round2(scheduledValue),
    changeOrderValue: round2(changeOrderValue),
    revisedScheduledValue: round2(scheduledValue + changeOrderValue),
    baseScope: round2(baseScope),
    changeOrderScope: round2(changeOrderScope),
  };
}

export interface ContractSums {
  originalContractSum: number;
  approvedChangeSum: number;
  currency: string;
}

export interface SovIdentityCheck {
  ok: boolean;
  currency: string;
  totals: SovTotals;
  sovTotal: number;
  contractSum: number;
  /** sovTotal − contractSum: positive = the SOV over-states the contract */
  discrepancy: number;
  direction: "balanced" | "over" | "under";
  /** the per-leg failures, so a caller can say WHICH half is wrong */
  legs: Identity[];
  /** one sentence naming the discrepancy — goes straight into the refusal */
  message: string;
}

/**
 * The identity that makes a G703 a G703: Σ line values = the contract sum,
 * with base scope and change-order scope checked as separate legs.
 */
export function checkSovAgainstContract(
  lines: readonly BillableLine[],
  contract: ContractSums,
): SovIdentityCheck {
  const totals = sovTotals(lines);
  const contractSum = round2(contract.originalContractSum + contract.approvedChangeSum);
  const discrepancy = round2(totals.revisedScheduledValue - contractSum);
  const legs = [
    checkIdentity(
      "Σ base-scope SOV lines = originalContractSum",
      totals.baseScope,
      contract.originalContractSum,
    ),
    checkIdentity(
      "Σ change-order SOV lines = approvedChangeSum",
      totals.changeOrderScope,
      contract.approvedChangeSum,
    ),
    checkIdentity("Σ all SOV lines = revisedContractSum", totals.revisedScheduledValue, contractSum),
  ];
  const ok = legs.every((l) => l.ok);
  const direction: SovIdentityCheck["direction"] =
    nearlyEqual(discrepancy, 0) ? "balanced" : discrepancy > 0 ? "over" : "under";
  const cur = contract.currency;
  const legNote = (leg: Identity, label: string): string =>
    leg.ok
      ? `${label} reconcile`
      : `${label} total ${formatMoney(leg.left)} against ${formatMoney(leg.right)} ` +
        `(${leg.delta > 0 ? "over" : "under"} by ${formatMoney(Math.abs(leg.delta))})`;
  const message = ok
    ? `Schedule of values reconciles to the contract sum of ${formatMoney(contractSum)} ${cur} ` +
      `across ${totals.lineCount} line(s).`
    : `Schedule of values totals ${formatMoney(totals.revisedScheduledValue)} ${cur} against a ` +
      `contract sum of ${formatMoney(contractSum)} ${cur} — ${direction} by ` +
      `${formatMoney(Math.abs(discrepancy))} ${cur}. ` +
      `${legNote(legs[0] as Identity, "Base-scope lines")}; ` +
      `${legNote(legs[1] as Identity, "change-order lines")}.`;
  return {
    ok,
    currency: cur,
    totals,
    sovTotal: totals.revisedScheduledValue,
    contractSum,
    discrepancy,
    direction,
    legs,
    message,
  };
}

/* ------------------------------------------------------------------ */
/* Deriving this period's figures from what the biller typed            */
/* ------------------------------------------------------------------ */

/**
 * What a biller may enter against one line. At most ONE of the three work
 * inputs — the amount, the quantity (unit-price lines) or the percent
 * complete to date — may be present; they are three spellings of the same
 * number and accepting two invites them to disagree.
 */
export interface LineBillingInput {
  /** G703 column E, entered directly */
  thisPeriodWork?: number | null;
  /** unit-price lines: quantity delivered this period, extended at the rate */
  thisPeriodQuantity?: number | null;
  /** percent-complete lines: cumulative % of the revised scheduled value */
  percentComplete?: number | null;
  /** stored material added this period (delta) */
  thisPeriodStoredMaterials?: number | null;
  /** G703 column F: stored material on hand now (absolute) */
  materialsPresentlyStored?: number | null;
}

export interface DerivedPeriodValues {
  thisPeriodWork: number;
  thisPeriodStoredMaterials: number;
  materialsPresentlyStored: number;
  /** how thisPeriodWork was arrived at, for the line's audit trail */
  basis: "amount" | "quantity" | "percent" | "unchanged";
}

export type Derivation =
  | { ok: true; value: DerivedPeriodValues }
  | { ok: false; reasons: string[] };

/**
 * Turn one line's input into the three period figures, refusing rather than
 * guessing when the line cannot support the spelling that was used.
 */
export function derivePeriodValues(line: BillableLine, input: LineBillingInput): Derivation {
  const reasons: string[] = [];
  const has = (v: number | null | undefined): v is number => typeof v === "number";
  const spellings = [
    has(input.thisPeriodWork) ? "thisPeriodWork" : null,
    has(input.thisPeriodQuantity) ? "thisPeriodQuantity" : null,
    has(input.percentComplete) ? "percentComplete" : null,
  ].filter((s): s is string => s !== null);
  if (spellings.length > 1) {
    reasons.push(
      `Line ${line.lineNumber} was given ${spellings.join(" and ")} — these are the same ` +
        "figure spelled differently; send exactly one.",
    );
  }

  const revised = revisedScheduledValueOf(line);
  let thisPeriodWork = line.thisPeriodWork;
  let basis: DerivedPeriodValues["basis"] = "unchanged";

  if (has(input.thisPeriodWork)) {
    thisPeriodWork = round2(input.thisPeriodWork);
    basis = "amount";
  } else if (has(input.thisPeriodQuantity)) {
    if (line.unitRate == null) {
      reasons.push(
        `Line ${line.lineNumber} was billed by quantity but carries no unit rate — set a unit ` +
          "rate on the SOV line, or bill it as an amount.",
      );
    } else {
      thisPeriodWork = round2(input.thisPeriodQuantity * line.unitRate);
      basis = "quantity";
    }
  } else if (has(input.percentComplete)) {
    if (revised <= 0) {
      reasons.push(
        `Line ${line.lineNumber} has a revised scheduled value of ${formatMoney(revised)} — a ` +
          "percent complete cannot be converted into an amount against it; bill this line as " +
          "an amount.",
      );
    } else if (input.percentComplete < 0 || input.percentComplete > 100) {
      reasons.push(
        `Line ${line.lineNumber}: percent complete ${round4(input.percentComplete)} is outside ` +
          "0-100.",
      );
    } else {
      thisPeriodWork = round2((input.percentComplete / 100) * revised - line.previousBilled);
      basis = "percent";
    }
  }

  // stored material: absolute (column F) and delta must agree
  const hasAbs = has(input.materialsPresentlyStored);
  const hasDelta = has(input.thisPeriodStoredMaterials);
  let materialsPresentlyStored = line.materialsPresentlyStored;
  let thisPeriodStoredMaterials = line.thisPeriodStoredMaterials;
  if (hasAbs && hasDelta) {
    const implied = round2(line.previousStoredMaterials + (input.thisPeriodStoredMaterials as number));
    if (!nearlyEqual(implied, input.materialsPresentlyStored as number)) {
      reasons.push(
        `Line ${line.lineNumber}: stored material ${formatMoney(
          input.materialsPresentlyStored as number,
        )} on hand disagrees with ${formatMoney(
          line.previousStoredMaterials,
        )} carried forward plus ${formatMoney(
          input.thisPeriodStoredMaterials as number,
        )} added this period (= ${formatMoney(implied)}). Send one of the two.`,
      );
    } else {
      materialsPresentlyStored = round2(input.materialsPresentlyStored as number);
      thisPeriodStoredMaterials = round2(input.thisPeriodStoredMaterials as number);
    }
  } else if (hasAbs) {
    materialsPresentlyStored = round2(input.materialsPresentlyStored as number);
    thisPeriodStoredMaterials = round2(materialsPresentlyStored - line.previousStoredMaterials);
  } else if (hasDelta) {
    thisPeriodStoredMaterials = round2(input.thisPeriodStoredMaterials as number);
    materialsPresentlyStored = round2(line.previousStoredMaterials + thisPeriodStoredMaterials);
  }
  if (materialsPresentlyStored < -MONEY_EPSILON) {
    reasons.push(
      `Line ${line.lineNumber}: stored material on hand would be ` +
        `${formatMoney(materialsPresentlyStored)} — negative stored material is not a thing.`,
    );
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return {
    ok: true,
    value: {
      thisPeriodWork,
      thisPeriodStoredMaterials,
      materialsPresentlyStored,
      basis,
    },
  };
}

/**
 * Refusals that only the combination of line + period figures can see:
 * negative work to date, and billing past the scheduled value.
 */
export function validatePeriodValues(
  line: BillableLine,
  derived: DerivedPeriodValues,
): string[] {
  const reasons: string[] = [];
  const revised = revisedScheduledValueOf(line);
  const workToDate = round2(line.previousBilled + derived.thisPeriodWork);
  if (workToDate < -MONEY_EPSILON) {
    reasons.push(
      `Line ${line.lineNumber}: work completed to date would be ${formatMoney(workToDate)} — a ` +
        "credit cannot take a line below zero billed.",
    );
  }
  const total = round2(workToDate + derived.materialsPresentlyStored);
  if (total - revised > MONEY_EPSILON) {
    reasons.push(
      `Line ${line.lineNumber} would bill ${formatMoney(total)} against a revised scheduled ` +
        `value of ${formatMoney(revised)} — over-billed by ${formatMoney(total - revised)}. ` +
        "Raise the line with an executed change order before billing it.",
    );
  }
  return reasons;
}

/* ------------------------------------------------------------------ */
/* G703 — the continuation sheet                                       */
/* ------------------------------------------------------------------ */

/** One printed row of the continuation sheet, with its retainage split out. */
export interface G703Row {
  sovLineId: string;
  lineNumber: string;
  description: string;
  sortOrder: number;
  billingMethod: string;
  costCode: string | null;
  costType: string | null;
  costCodeId: string | null;
  budgetLineItemId: string | null;
  unit: string | null;
  quantity: number | null;
  unitRate: number | null;
  isChangeOrderLine: number;
  changeOrderPackageId: string | null;
  /** C */
  scheduledValue: number;
  changeOrderValue: number;
  revisedScheduledValue: number;
  /** D */
  previousBilled: number;
  /** E */
  thisPeriodWork: number;
  previousStoredMaterials: number;
  thisPeriodStoredMaterials: number;
  /** F */
  materialsPresentlyStored: number;
  /** D + E */
  workCompletedToDate: number;
  /** G = D + E + F */
  totalCompletedAndStored: number;
  /** G ÷ C — null on a zero-value line, never a fabricated 0 */
  percentComplete: number | null;
  /** H = C − G */
  balanceToFinish: number;
  /** the rate actually applied, after any step-down */
  retainagePercent: number;
  retainageWork: number;
  retainageMaterials: number;
  /** I = retainage held to date at the rates in force */
  retainageHeldToDate: number;
  /** movement in retainage this period; negative = retainage released */
  retainageThisPeriod: number;
  retainageReleased: number;
  /** net payable for this line this period */
  amount: number;
  /** why percentComplete is null; empty otherwise */
  reasons: string[];
}

/** Percent complete as a `Component` — null, with a reason, on 0 scheduled. */
export function percentCompleteOf(
  earned: number,
  scheduled: number,
  label: string,
): Component {
  if (!(scheduled > 0)) {
    return unavailable(
      [
        `${label} has a scheduled value of ${formatMoney(scheduled)} — percent complete is ` +
          "undefined against it, not 0.",
      ],
      { earned: round2(earned), scheduled: round2(scheduled) },
    );
  }
  return computed((earned / scheduled) * 100, { earned: round2(earned), scheduled: round2(scheduled) }, round4);
}

/** Build one continuation-sheet row at the rates in force. */
export function g703Row(
  line: BillableLine,
  derived: DerivedPeriodValues,
  eff: EffectiveRetainage,
): G703Row {
  const revised = revisedScheduledValueOf(line);
  const workCompletedToDate = round2(line.previousBilled + derived.thisPeriodWork);
  const materials = round2(derived.materialsPresentlyStored);
  const total = round2(workCompletedToDate + materials);
  const pc = percentCompleteOf(total, revised, `Line ${line.lineNumber}`);
  const workRate = lineWorkRate(line.retainagePercent, eff);
  const materialsRate = eff.materialsPercent;
  const retainageWork = round2((workRate / 100) * workCompletedToDate);
  const retainageMaterials = round2((materialsRate / 100) * materials);
  const retainageHeldToDate = round2(retainageWork + retainageMaterials - line.retainageReleased);
  const retainageThisPeriod = round2(retainageHeldToDate - line.retainageHeld);
  return {
    sovLineId: line.id,
    lineNumber: line.lineNumber,
    description: line.description,
    sortOrder: line.sortOrder,
    billingMethod: line.billingMethod,
    costCode: line.costCode,
    costType: line.costType,
    costCodeId: line.costCodeId,
    budgetLineItemId: line.budgetLineItemId,
    unit: line.unit,
    quantity: line.quantity,
    unitRate: line.unitRate,
    isChangeOrderLine: line.isChangeOrderLine,
    changeOrderPackageId: line.changeOrderPackageId,
    scheduledValue: round2(line.scheduledValue),
    changeOrderValue: round2(line.changeOrderValue),
    revisedScheduledValue: revised,
    previousBilled: round2(line.previousBilled),
    thisPeriodWork: round2(derived.thisPeriodWork),
    previousStoredMaterials: round2(line.previousStoredMaterials),
    thisPeriodStoredMaterials: round2(derived.thisPeriodStoredMaterials),
    materialsPresentlyStored: materials,
    workCompletedToDate,
    totalCompletedAndStored: total,
    percentComplete: pc.value,
    balanceToFinish: round2(revised - total),
    retainagePercent: workRate,
    retainageWork,
    retainageMaterials,
    retainageHeldToDate,
    retainageThisPeriod,
    retainageReleased: round2(line.retainageReleased),
    amount: round2(
      derived.thisPeriodWork + derived.thisPeriodStoredMaterials - retainageThisPeriod,
    ),
    reasons: pc.reasons,
  };
}

/* ------------------------------------------------------------------ */
/* G702 — the cover sheet                                              */
/* ------------------------------------------------------------------ */

export interface G702Summary {
  /** line 1 */
  originalContractSum: number;
  /** line 2 */
  netChangeOrders: number;
  /** line 3 */
  contractSumToDate: number;
  /** line 4, work half */
  completedToDate: number;
  /** line 4, stored half */
  storedMaterials: number;
  /** line 4 */
  totalCompletedAndStored: number;
  /** line 5a rate and amount */
  retainagePercentWork: number;
  retainageWork: number;
  /** line 5b rate and amount */
  retainagePercentMaterials: number;
  retainageMaterials: number;
  /** line 5 */
  totalRetainage: number;
  retainageReleased: number;
  /** line 6 */
  totalEarnedLessRetainage: number;
  /** line 7 */
  lessPreviousCertificates: number;
  /** line 8 */
  currentPaymentDue: number;
  /** line 9 */
  balanceToFinishPlusRetainage: number;
  /** line 4 ÷ line 3 — null when nothing is scheduled */
  percentComplete: number | null;
  currency: string;
}

export interface ApplicationInput {
  contract: ContractSums;
  lines: ReadonlyArray<{ line: BillableLine; derived: DerivedPeriodValues }>;
  terms: RetainageTerms;
  /** G702 line 7 — Σ amounts certified on prior applications */
  lessPreviousCertificates: number;
}

export interface ApplicationResult {
  rows: G703Row[];
  g702: G702Summary;
  retainage: EffectiveRetainage;
  identities: Identity[];
  /** why any figure came back null, plus the step-down note when it fired */
  reasons: string[];
}

/**
 * Compute a whole payment application: the continuation sheet, the cover
 * sheet and the identities that prove the two agree.
 *
 * Two passes, and the order matters. Pass one totals the work with no
 * retainage in sight, because the step-down threshold is measured on percent
 * complete and percent complete cannot depend on the rate it decides. Pass
 * two prices retainage at the rates pass one settled.
 */
export function computeApplication(input: ApplicationInput): ApplicationResult {
  const contractSumToDate = round2(
    input.contract.originalContractSum + input.contract.approvedChangeSum,
  );

  // pass 1 — progress, rate-free
  let completedToDate = 0;
  let storedMaterials = 0;
  for (const { line, derived } of input.lines) {
    completedToDate += line.previousBilled + derived.thisPeriodWork;
    storedMaterials += derived.materialsPresentlyStored;
  }
  completedToDate = round2(completedToDate);
  storedMaterials = round2(storedMaterials);
  const totalCompletedAndStored = round2(completedToDate + storedMaterials);
  const overall = percentCompleteOf(
    totalCompletedAndStored,
    contractSumToDate,
    "This contract",
  );
  const eff = effectiveRetainage(input.terms, overall.value);

  // pass 2 — retainage at the settled rates
  const rows = input.lines.map(({ line, derived }) => g703Row(line, derived, eff));
  let retainageWork = 0;
  let retainageMaterials = 0;
  let retainageReleased = 0;
  for (const row of rows) {
    retainageWork += row.retainageWork;
    retainageMaterials += row.retainageMaterials;
    retainageReleased += row.retainageReleased;
  }
  retainageWork = round2(retainageWork);
  retainageMaterials = round2(retainageMaterials);
  retainageReleased = round2(retainageReleased);
  const totalRetainage = round2(retainageWork + retainageMaterials - retainageReleased);
  const totalEarnedLessRetainage = round2(totalCompletedAndStored - totalRetainage);
  const lessPreviousCertificates = round2(input.lessPreviousCertificates);
  const currentPaymentDue = round2(totalEarnedLessRetainage - lessPreviousCertificates);
  const balanceToFinishPlusRetainage = round2(contractSumToDate - totalEarnedLessRetainage);

  /*
   * The printed rate on 5a is the rate actually achieved across the sheet,
   * not the contract default — per-line overrides and lines at 0% make the
   * two differ, and the form's reader is entitled to the number that
   * reconciles 5a to line 4.
   */
  const retainagePercentWork =
    completedToDate > 0 ? round4((retainageWork / completedToDate) * 100) : eff.workPercent;
  const retainagePercentMaterials =
    storedMaterials > 0
      ? round4((retainageMaterials / storedMaterials) * 100)
      : eff.materialsPercent;

  const g702: G702Summary = {
    originalContractSum: round2(input.contract.originalContractSum),
    netChangeOrders: round2(input.contract.approvedChangeSum),
    contractSumToDate,
    completedToDate,
    storedMaterials,
    totalCompletedAndStored,
    retainagePercentWork,
    retainageWork,
    retainagePercentMaterials,
    retainageMaterials,
    totalRetainage,
    retainageReleased,
    totalEarnedLessRetainage,
    lessPreviousCertificates,
    currentPaymentDue,
    balanceToFinishPlusRetainage,
    percentComplete: overall.value,
    currency: input.contract.currency,
  };

  const sheetTotal = round2(rows.reduce((s, r) => s + r.totalCompletedAndStored, 0));
  const identities = [
    checkIdentity(
      "line 1 + line 2 = line 3 (contract sum to date)",
      g702.originalContractSum + g702.netChangeOrders,
      g702.contractSumToDate,
    ),
    checkIdentity(
      "Σ G703 total completed and stored = line 4",
      sheetTotal,
      g702.totalCompletedAndStored,
    ),
    checkIdentity(
      "line 5a + line 5b − released = line 5 (total retainage)",
      g702.retainageWork + g702.retainageMaterials - g702.retainageReleased,
      g702.totalRetainage,
    ),
    checkIdentity(
      "line 4 − line 5 = line 6 (total earned less retainage)",
      g702.totalCompletedAndStored - g702.totalRetainage,
      g702.totalEarnedLessRetainage,
    ),
    checkIdentity(
      "line 6 − line 7 = line 8 (current payment due)",
      g702.totalEarnedLessRetainage - g702.lessPreviousCertificates,
      g702.currentPaymentDue,
    ),
    checkIdentity(
      "line 3 − line 6 = line 9 (balance to finish plus retainage)",
      g702.contractSumToDate - g702.totalEarnedLessRetainage,
      g702.balanceToFinishPlusRetainage,
    ),
  ];

  const reasons = [
    ...overall.reasons,
    ...(eff.note ? [eff.note] : []),
    ...rows.flatMap((r) => r.reasons),
  ];
  return { rows, g702, retainage: eff, identities, reasons };
}

/* ------------------------------------------------------------------ */
/* Rolling the schedule of values forward                              */
/* ------------------------------------------------------------------ */

/** The SOV columns after an application is certified. */
export interface RolledLine {
  previousBilled: number;
  previousStoredMaterials: number;
  thisPeriodWork: number;
  thisPeriodStoredMaterials: number;
  materialsPresentlyStored: number;
  totalCompletedAndStored: number;
  percentComplete: number;
  balanceToFinish: number;
  retainagePercent: number;
  retainageHeld: number;
}

/**
 * Certification is what moves "this period" into "previous". Nothing else
 * does — a draft application can be edited a hundred times without the SOV's
 * carried-forward columns moving, which is why an invoice line's
 * `previousBilled` snapshot can never drift.
 *
 * `percentComplete` lands on a NOT NULL column, so a zero-value line stores
 * 0 here while the API surface reports it as null with a reason attached.
 * Storing 0 is a column constraint; reporting 0 would be a claim.
 */
export function rollForward(row: G703Row): RolledLine {
  return {
    previousBilled: row.workCompletedToDate,
    previousStoredMaterials: row.materialsPresentlyStored,
    thisPeriodWork: 0,
    thisPeriodStoredMaterials: 0,
    materialsPresentlyStored: row.materialsPresentlyStored,
    totalCompletedAndStored: row.totalCompletedAndStored,
    percentComplete: row.percentComplete ?? 0,
    balanceToFinish: row.balanceToFinish,
    retainagePercent: row.retainagePercent,
    retainageHeld: row.retainageHeldToDate,
  };
}

/** The SOV columns while an application is still a draft (no roll-forward). */
export function mirrorLine(row: G703Row): {
  thisPeriodWork: number;
  thisPeriodStoredMaterials: number;
  materialsPresentlyStored: number;
  totalCompletedAndStored: number;
  percentComplete: number;
  balanceToFinish: number;
} {
  return {
    thisPeriodWork: row.thisPeriodWork,
    thisPeriodStoredMaterials: row.thisPeriodStoredMaterials,
    materialsPresentlyStored: row.materialsPresentlyStored,
    totalCompletedAndStored: row.totalCompletedAndStored,
    percentComplete: row.percentComplete ?? 0,
    balanceToFinish: row.balanceToFinish,
  };
}

/* ------------------------------------------------------------------ */
/* Contract-level reconciliation                                       */
/* ------------------------------------------------------------------ */

export interface ContractPosition {
  originalContractSum: number;
  approvedChangeSum: number;
  revisedContractSum: number;
  sovTotal: number;
  totalBilled: number;
  retainageHeld: number;
  balanceToFinish: number;
  lineRetainageHeld: number;
  lineBilledToDate: number;
}

/**
 * The identities a prime contract is required to satisfy at rest. A caller
 * returns these to the client and a test asserts them; when one is false the
 * contract says so out loud instead of presenting a plausible grid.
 */
export function reconcileContract(p: ContractPosition): Identity[] {
  return [
    checkIdentity(
      "originalContractSum + approvedChangeSum = revisedContractSum",
      p.originalContractSum + p.approvedChangeSum,
      p.revisedContractSum,
    ),
    checkIdentity("Σ SOV revised scheduled value = revisedContractSum", p.sovTotal, p.revisedContractSum),
    checkIdentity("Σ SOV completed and stored to date = totalBilled", p.lineBilledToDate, p.totalBilled),
    checkIdentity("Σ SOV retainage held = contract retainageHeld", p.lineRetainageHeld, p.retainageHeld),
    checkIdentity(
      "totalBilled + balanceToFinish = revisedContractSum",
      p.totalBilled + p.balanceToFinish,
      p.revisedContractSum,
    ),
  ];
}

/* ------------------------------------------------------------------ */
/* Dates and numbering                                                 */
/* ------------------------------------------------------------------ */

/**
 * Execution cannot precede award. `contractDate` is the award; `approvedAt`
 * is our own internal approval, which is also an event execution cannot come
 * before. Returns the refusal sentence, or null when the date is sound.
 */
export function executionDateProblem(opts: {
  executionDate: string;
  contractDate: string | null;
  approvedAt: string | null;
}): string | null {
  const exec = opts.executionDate.slice(0, 10);
  if (opts.contractDate && exec < opts.contractDate.slice(0, 10)) {
    return (
      `Execution date ${exec} precedes the contract date ${opts.contractDate.slice(0, 10)} — a ` +
      "contract cannot be executed before it is awarded."
    );
  }
  if (opts.approvedAt && exec < opts.approvedAt.slice(0, 10)) {
    return (
      `Execution date ${exec} precedes internal approval on ${opts.approvedAt.slice(0, 10)} — a ` +
      "contract cannot be executed before it is approved."
    );
  }
  return null;
}

export const pad3 = (n: number): string => String(n).padStart(3, "0");

/**
 * Line numbers for the lines an executed change order appends. Suffixed
 * per allocation so one change order that touches three cost codes appends
 * three reconcilable lines rather than one lump.
 */
export const changeOrderLineNumber = (changeNumber: number, seq: number): string =>
  `CO-${pad3(changeNumber)}.${seq}`;

/**
 * Statuses in which a prime contract change has ALREADY moved the contract
 * sum, versus the two forecast buckets that have not.
 */
export const EXECUTED_CHANGE_STATUSES = ["executed"] as const;
export const PENDING_CHANGE_STATUSES = [
  "pending_pricing",
  "pending_in_house_review",
  "pending_owner_approval",
  "revise_and_resubmit",
  "approved",
] as const;
export const DRAFT_CHANGE_STATUSES = ["draft"] as const;

export interface ChangeSums {
  approvedChangeSum: number;
  pendingChangeSum: number;
  draftChangeSum: number;
  revisedContractSum: number;
}

/**
 * Re-derive the four contract-sum columns from the change rows. Executed
 * changes and ONLY executed changes are in the contract sum; priced-but-
 * unexecuted work is what a forecast needs and what a contract sum must never
 * include.
 */
export function changeSums(
  originalContractSum: number,
  changes: ReadonlyArray<{ status: string; amount: number }>,
): ChangeSums {
  let approved = 0;
  let pending = 0;
  let draft = 0;
  for (const c of changes) {
    if ((EXECUTED_CHANGE_STATUSES as readonly string[]).includes(c.status)) approved += c.amount;
    else if ((PENDING_CHANGE_STATUSES as readonly string[]).includes(c.status)) pending += c.amount;
    else if ((DRAFT_CHANGE_STATUSES as readonly string[]).includes(c.status)) draft += c.amount;
  }
  return {
    approvedChangeSum: round2(approved),
    pendingChangeSum: round2(pending),
    draftChangeSum: round2(draft),
    revisedContractSum: round2(originalContractSum + approved),
  };
}
