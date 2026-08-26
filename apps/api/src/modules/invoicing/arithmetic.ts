import { CENT, formatMoney, round2, round4 } from "./shared.js";

/**
 * THE G702/G703 ARITHMETIC, as pure functions.
 *
 * Everything the invoicing module stores is computed here and nowhere else,
 * so there is exactly one implementation of the money on the write path and
 * a reviewer can read the whole of it without a database.
 *
 * THE CONTINUATION SHEET (G703), one row per schedule-of-values line:
 *
 *   scheduledValue          the SOV line's revised value (base + change orders)
 *   previousBilled          work completed in PREVIOUS applications  (column D)
 *   thisPeriodWork          work completed THIS period               (column E)
 *   materialsPresentlyStored  stored but not yet incorporated        (column F)
 *                             = previousStoredMaterials + thisPeriodStoredMaterials
 *   totalCompletedAndStored = previousBilled + thisPeriodWork
 *                           + materialsPresentlyStored               (column G)
 *   percentComplete         = G / scheduledValue                     (column H)
 *   balanceToFinish         = scheduledValue - G                     (column I)
 *   retainageThisPeriod     = rate% x (thisPeriodWork + thisPeriodStoredMaterials)
 *   retainageHeldToDate     = rate% x G - retainageReleased          (column K)
 *   amount                  = (thisPeriodWork + thisPeriodStoredMaterials)
 *                           - retainageThisPeriod + retainageReleased
 *
 * `previousBilled` and `previousStoredMaterials` are SNAPSHOTTED onto the
 * invoice line when it is created and never recomputed from sibling invoices.
 * An invoice is a legal document: a correction upstream next month must not
 * silently change what last month's application said.
 *
 * THE COVER SHEET (G702), summed over the lines above:
 *
 *   originalContractSum + netChangeOrders     = revisedContractSum
 *   completedToDate + storedMaterials         = totalCompletedAndStored
 *   retainageWork + retainageMaterials        = totalRetainage
 *   totalCompletedAndStored - totalRetainage  = totalEarnedLessRetainage
 *   totalEarnedLessRetainage - previousPaymentsAmount = currentPaymentDue
 *   revisedContractSum - totalEarnedLessRetainage = balanceToFinishPlusRetainage
 *
 * Released retainage is applied against the WORK half of the retainage split
 * (`retainageWork`), which is where retainage is withheld from in the first
 * place. That keeps `retainageWork + retainageMaterials = totalRetainage` and
 * `G - totalRetainage = totalEarnedLessRetainage` exactly true as stored,
 * while a release still visibly reduces what is being held.
 */

/* ------------------------------------------------------------------ */
/* Line                                                                */
/* ------------------------------------------------------------------ */

/** What the SOV fixes about a line and the invoice snapshots at creation. */
export interface LineBasis {
  lineNumber: string;
  description: string;
  /** revised scheduled value: base + executed change-order value */
  scheduledValue: number;
  previousBilled: number;
  previousStoredMaterials: number;
  retainagePercent: number;
  taxPercent: number | null;
}

/**
 * What the biller types. Three mutually-consistent ways to say the same
 * thing about work, and two about materials — the resolver below turns
 * whichever arrived into the full set, or refuses if two disagree.
 */
export interface LineInput {
  /** absolute value of work completed this period */
  thisPeriodWork?: number | undefined;
  /** target cumulative percent complete; drives thisPeriodWork when given */
  percentComplete?: number | undefined;
  /** absolute cumulative work completed to date (D + E) */
  completedToDate?: number | undefined;
  /** change in stored materials this period (may be negative as they install) */
  thisPeriodStoredMaterials?: number | undefined;
  /** absolute stored-materials balance on site (column F) */
  materialsPresentlyStored?: number | undefined;
  /** retainage let go of on this line this period */
  retainageReleased?: number | undefined;
  /** required when the line's completed-and-stored position REGRESSES */
  creditReason?: string | null | undefined;
}

export interface ComputedLine {
  thisPeriodWork: number;
  thisPeriodStoredMaterials: number;
  materialsPresentlyStored: number;
  totalCompletedAndStored: number;
  percentComplete: number;
  balanceToFinish: number;
  retainageThisPeriod: number;
  retainageHeldToDate: number;
  retainageReleased: number;
  amount: number;
  taxAmount: number;
}

export interface LineIssue {
  lineNumber: string;
  code:
    | "over_billed"
    | "regression_without_credit_reason"
    | "inconsistent_work_input"
    | "inconsistent_materials_input"
    | "negative_materials"
    | "release_exceeds_held";
  message: string;
  /** the figures behind the message, so a UI can render them in a table */
  detail: Record<string, number | string>;
}

export interface LineResult {
  computed: ComputedLine;
  issues: LineIssue[];
}

/**
 * Resolve the biller's input into the full G703 row and report every refusal
 * the row earns. Nothing throws here: the caller collects issues across all
 * lines so one request names every problem rather than the first.
 */
export function computeLine(basis: LineBasis, input: LineInput): LineResult {
  const issues: LineIssue[] = [];
  const fail = (code: LineIssue["code"], message: string, detail: LineIssue["detail"]): void => {
    issues.push({ lineNumber: basis.lineNumber, code, message, detail });
  };

  /* ---- work this period: typed, or derived from a percent / a to-date ---- */
  const candidates: Array<{ label: string; value: number }> = [];
  if (input.thisPeriodWork !== undefined) {
    candidates.push({ label: "thisPeriodWork", value: round2(input.thisPeriodWork) });
  }
  if (input.percentComplete !== undefined) {
    // A percent-complete target is cumulative over work AND stored materials
    // on the G703, but only work is billed through column E; stored materials
    // carry their own column. Percent here therefore drives work-to-date.
    const target = round2((input.percentComplete / 100) * basis.scheduledValue);
    candidates.push({ label: "percentComplete", value: round2(target - basis.previousBilled) });
  }
  if (input.completedToDate !== undefined) {
    candidates.push({
      label: "completedToDate",
      value: round2(input.completedToDate - basis.previousBilled),
    });
  }
  for (const other of candidates.slice(1)) {
    if (Math.abs(other.value - candidates[0]!.value) > CENT) {
      fail(
        "inconsistent_work_input",
        `Line ${basis.lineNumber}: ${candidates[0]!.label} and ${other.label} disagree about ` +
          `this period's work (${formatMoney(candidates[0]!.value)} vs ` +
          `${formatMoney(other.value)}). Send one of them, not both.`,
        { [candidates[0]!.label]: candidates[0]!.value, [other.label]: other.value },
      );
    }
  }
  const thisPeriodWork = candidates[0]?.value ?? 0;

  /* ---- stored materials: a delta, or an absolute balance ---- */
  let thisPeriodStoredMaterials = 0;
  if (input.materialsPresentlyStored !== undefined && input.thisPeriodStoredMaterials !== undefined) {
    const implied = round2(input.materialsPresentlyStored - basis.previousStoredMaterials);
    if (Math.abs(implied - round2(input.thisPeriodStoredMaterials)) > CENT) {
      fail(
        "inconsistent_materials_input",
        `Line ${basis.lineNumber}: materialsPresentlyStored implies a movement of ` +
          `${formatMoney(implied)} this period but thisPeriodStoredMaterials says ` +
          `${formatMoney(input.thisPeriodStoredMaterials)}. Send one of them, not both.`,
        { implied, given: round2(input.thisPeriodStoredMaterials) },
      );
    }
    thisPeriodStoredMaterials = implied;
  } else if (input.materialsPresentlyStored !== undefined) {
    thisPeriodStoredMaterials = round2(
      input.materialsPresentlyStored - basis.previousStoredMaterials,
    );
  } else if (input.thisPeriodStoredMaterials !== undefined) {
    thisPeriodStoredMaterials = round2(input.thisPeriodStoredMaterials);
  }
  const materialsPresentlyStored = round2(
    basis.previousStoredMaterials + thisPeriodStoredMaterials,
  );
  if (materialsPresentlyStored < -CENT) {
    fail(
      "negative_materials",
      `Line ${basis.lineNumber}: stored materials would fall to ` +
        `${formatMoney(materialsPresentlyStored)}. Materials on site cannot be negative.`,
      { materialsPresentlyStored, previousStoredMaterials: basis.previousStoredMaterials },
    );
  }

  /* ---- the G703 row ---- */
  const totalCompletedAndStored = round2(
    basis.previousBilled + thisPeriodWork + materialsPresentlyStored,
  );
  const previousTotal = round2(basis.previousBilled + basis.previousStoredMaterials);

  const overage = round2(totalCompletedAndStored - basis.scheduledValue);
  if (overage > CENT) {
    fail(
      "over_billed",
      `Line ${basis.lineNumber} (${basis.description}) bills ` +
        `${formatMoney(totalCompletedAndStored)} against a scheduled value of ` +
        `${formatMoney(basis.scheduledValue)} — over by ${formatMoney(overage)}. ` +
        "Raise a change order before billing past the schedule of values.",
      {
        scheduledValue: basis.scheduledValue,
        totalCompletedAndStored,
        overage,
        previousBilled: basis.previousBilled,
        thisPeriodWork,
        materialsPresentlyStored,
      },
    );
  }

  const regression = round2(previousTotal - totalCompletedAndStored);
  if (regression > CENT && !(input.creditReason ?? "").trim()) {
    fail(
      "regression_without_credit_reason",
      `Line ${basis.lineNumber} (${basis.description}) moves backwards from ` +
        `${formatMoney(previousTotal)} to ${formatMoney(totalCompletedAndStored)} — a ` +
        `credit of ${formatMoney(regression)}. Percent complete cannot regress without a ` +
        "stated credit reason.",
      { previousTotal, totalCompletedAndStored, credit: regression },
    );
  }

  const percentComplete =
    Math.abs(basis.scheduledValue) < CENT
      ? 0
      : round4((totalCompletedAndStored / basis.scheduledValue) * 100);
  const balanceToFinish = round2(basis.scheduledValue - totalCompletedAndStored);

  const rate = basis.retainagePercent / 100;
  const retainageReleased = round2(input.retainageReleased ?? 0);
  const retainageThisPeriod = round2(rate * (thisPeriodWork + thisPeriodStoredMaterials));
  const grossRetainage = round2(rate * totalCompletedAndStored);
  if (retainageReleased - grossRetainage > CENT) {
    fail(
      "release_exceeds_held",
      `Line ${basis.lineNumber}: a release of ${formatMoney(retainageReleased)} exceeds the ` +
        `${formatMoney(grossRetainage)} of retainage this line has accrued — over by ` +
        `${formatMoney(round2(retainageReleased - grossRetainage))}.`,
      { retainageReleased, accrued: grossRetainage },
    );
  }
  const retainageHeldToDate = round2(grossRetainage - retainageReleased);
  const billedThisPeriod = round2(thisPeriodWork + thisPeriodStoredMaterials);
  const amount = round2(billedThisPeriod - retainageThisPeriod + retainageReleased);
  const taxAmount =
    basis.taxPercent === null ? 0 : round2((basis.taxPercent / 100) * billedThisPeriod);

  return {
    computed: {
      thisPeriodWork,
      thisPeriodStoredMaterials,
      materialsPresentlyStored,
      totalCompletedAndStored,
      percentComplete,
      balanceToFinish,
      retainageThisPeriod,
      retainageHeldToDate,
      retainageReleased,
      amount,
      taxAmount,
    },
    issues,
  };
}

/* ------------------------------------------------------------------ */
/* Cover sheet                                                         */
/* ------------------------------------------------------------------ */

/** The subset of a stored invoice line the cover sheet reads. */
export interface CoverSheetLine {
  previousBilled: number;
  thisPeriodWork: number;
  materialsPresentlyStored: number;
  retainagePercent: number;
  retainageReleased: number;
  amount: number;
  taxAmount: number;
}

export interface CoverSheetContext {
  originalContractSum: number;
  netChangeOrders: number;
  previousPaymentsAmount: number;
}

export interface CoverSheet {
  originalContractSum: number;
  netChangeOrders: number;
  revisedContractSum: number;
  completedToDate: number;
  storedMaterials: number;
  totalCompletedAndStored: number;
  retainagePercentWork: number;
  retainageWork: number;
  retainagePercentMaterials: number;
  retainageMaterials: number;
  totalRetainage: number;
  retainageReleased: number;
  totalEarnedLessRetainage: number;
  previousPaymentsAmount: number;
  currentPaymentDue: number;
  balanceToFinishPlusRetainage: number;
  subtotal: number;
  taxAmount: number;
  total: number;
}

export function computeCoverSheet(
  lines: readonly CoverSheetLine[],
  ctx: CoverSheetContext,
): CoverSheet {
  let completedToDate = 0;
  let storedMaterials = 0;
  let grossRetainageWork = 0;
  let retainageMaterials = 0;
  let retainageReleased = 0;
  let subtotal = 0;
  let taxAmount = 0;
  let workBase = 0;
  let materialsBase = 0;
  let workRateWeighted = 0;
  let materialsRateWeighted = 0;

  for (const l of lines) {
    const work = round2(l.previousBilled + l.thisPeriodWork);
    completedToDate += work;
    storedMaterials += l.materialsPresentlyStored;
    grossRetainageWork += (l.retainagePercent / 100) * work;
    retainageMaterials += (l.retainagePercent / 100) * l.materialsPresentlyStored;
    retainageReleased += l.retainageReleased;
    subtotal += l.amount;
    taxAmount += l.taxAmount;
    workBase += work;
    materialsBase += l.materialsPresentlyStored;
    workRateWeighted += l.retainagePercent * work;
    materialsRateWeighted += l.retainagePercent * l.materialsPresentlyStored;
  }

  completedToDate = round2(completedToDate);
  storedMaterials = round2(storedMaterials);
  retainageReleased = round2(retainageReleased);
  // Releases come off the WORK half — that is what was withheld from — which
  // keeps retainageWork + retainageMaterials = totalRetainage exactly true.
  const retainageWork = round2(round2(grossRetainageWork) - retainageReleased);
  retainageMaterials = round2(retainageMaterials);

  const revisedContractSum = round2(ctx.originalContractSum + ctx.netChangeOrders);
  const totalCompletedAndStored = round2(completedToDate + storedMaterials);
  const totalRetainage = round2(retainageWork + retainageMaterials);
  const totalEarnedLessRetainage = round2(totalCompletedAndStored - totalRetainage);
  const currentPaymentDue = round2(totalEarnedLessRetainage - ctx.previousPaymentsAmount);
  const balanceToFinishPlusRetainage = round2(revisedContractSum - totalEarnedLessRetainage);

  return {
    originalContractSum: round2(ctx.originalContractSum),
    netChangeOrders: round2(ctx.netChangeOrders),
    revisedContractSum,
    completedToDate,
    storedMaterials,
    totalCompletedAndStored,
    // The effective blended rate actually applied, not a typed default: with
    // per-line rates the cover sheet's single percentage is only meaningful
    // as the weighted average, and stating it that way is honest.
    retainagePercentWork: workBase < CENT ? 0 : round4(workRateWeighted / workBase),
    retainageWork,
    retainagePercentMaterials:
      materialsBase < CENT ? 0 : round4(materialsRateWeighted / materialsBase),
    retainageMaterials,
    totalRetainage,
    retainageReleased,
    totalEarnedLessRetainage,
    previousPaymentsAmount: round2(ctx.previousPaymentsAmount),
    currentPaymentDue,
    balanceToFinishPlusRetainage,
    subtotal: round2(subtotal),
    taxAmount: round2(taxAmount),
    total: round2(round2(subtotal) + round2(taxAmount)),
  };
}

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

export interface ReconciliationCheck {
  identity: string;
  left: number;
  right: number;
  delta: number;
  ok: boolean;
}

const check = (identity: string, left: number, right: number): ReconciliationCheck => ({
  identity,
  left: round2(left),
  right: round2(right),
  delta: round2(left - right),
  ok: Math.abs(left - right) <= CENT,
});

/**
 * Every G702 identity, checked against the STORED columns of one invoice.
 * This is what makes "the totals are derivable from stored rows" testable
 * rather than aspirational: the endpoint returns the checks, and a failing
 * one names the identity that broke.
 */
export function reconcileInvoice(inv: {
  originalContractSum: number;
  netChangeOrders: number;
  revisedContractSum: number;
  completedToDate: number;
  storedMaterials: number;
  totalCompletedAndStored: number;
  retainageWork: number;
  retainageMaterials: number;
  totalRetainage: number;
  totalEarnedLessRetainage: number;
  previousPaymentsAmount: number;
  currentPaymentDue: number;
  balanceToFinishPlusRetainage: number;
  subtotal: number;
  taxAmount: number;
  total: number;
}): { checks: ReconciliationCheck[]; reconciles: boolean } {
  const checks = [
    check(
      "originalContractSum + netChangeOrders = revisedContractSum",
      inv.originalContractSum + inv.netChangeOrders,
      inv.revisedContractSum,
    ),
    check(
      "completedToDate + storedMaterials = totalCompletedAndStored",
      inv.completedToDate + inv.storedMaterials,
      inv.totalCompletedAndStored,
    ),
    check(
      "retainageWork + retainageMaterials = totalRetainage",
      inv.retainageWork + inv.retainageMaterials,
      inv.totalRetainage,
    ),
    check(
      "totalCompletedAndStored - totalRetainage = totalEarnedLessRetainage",
      inv.totalCompletedAndStored - inv.totalRetainage,
      inv.totalEarnedLessRetainage,
    ),
    check(
      "totalEarnedLessRetainage - previousPaymentsAmount = currentPaymentDue",
      inv.totalEarnedLessRetainage - inv.previousPaymentsAmount,
      inv.currentPaymentDue,
    ),
    check(
      "revisedContractSum - totalEarnedLessRetainage = balanceToFinishPlusRetainage",
      inv.revisedContractSum - inv.totalEarnedLessRetainage,
      inv.balanceToFinishPlusRetainage,
    ),
    check("subtotal + taxAmount = total", inv.subtotal + inv.taxAmount, inv.total),
  ];
  return { checks, reconciles: checks.every((c) => c.ok) };
}

/* ------------------------------------------------------------------ */
/* Aging                                                               */
/* ------------------------------------------------------------------ */

export const AGING_BUCKETS = ["d0_30", "d31_60", "d61_90", "d90_plus"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export const AGING_BUCKET_LABELS: Record<AgingBucket, string> = {
  d0_30: "0-30 days",
  d31_60: "31-60 days",
  d61_90: "61-90 days",
  d90_plus: "90+ days",
};

/**
 * Which bucket a number of days outstanding falls in. The boundaries are
 * INCLUSIVE at the top of each band — 30 is 0-30, 31 is 31-60, 60 is 31-60,
 * 61 is 61-90, 90 is 61-90, 91 is 90+ — and anything not yet due (a negative
 * day count) sits in the first bucket, which is what every AR aging report
 * in the industry means by "current".
 */
export function agingBucketFor(daysOutstanding: number): AgingBucket {
  if (daysOutstanding <= 30) return "d0_30";
  if (daysOutstanding <= 60) return "d31_60";
  if (daysOutstanding <= 90) return "d61_90";
  return "d90_plus";
}

export const emptyBuckets = (): Record<AgingBucket, number> => ({
  d0_30: 0,
  d31_60: 0,
  d61_90: 0,
  d90_plus: 0,
});
