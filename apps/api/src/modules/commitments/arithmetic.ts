import { CENT, round2, round4 } from "./shared.js";

/**
 * The commitment arithmetic, isolated from Fastify and from drizzle.
 *
 * Everything here is a pure function of its arguments. That matters more on
 * this file than anywhere else in the module: the identities below are the
 * ones a quantity surveyor will check by hand against a G703 continuation
 * sheet, and they have to be testable without a database.
 *
 * THE IDENTITIES, in the order they are relied on:
 *
 *   per SOV line
 *     revisedScheduledValue   = scheduledValue + changeOrderValue
 *     totalCompletedAndStored = previousBilled + thisPeriodWork
 *                                              + materialsPresentlyStored
 *     percentComplete         = totalCompletedAndStored / revisedScheduledValue
 *     balanceToFinish         = revisedScheduledValue - totalCompletedAndStored
 *     retainageHeld           = retainagePercent% x totalCompletedAndStored
 *                               - retainageReleased
 *
 *   per commitment
 *     originalCommitmentSum   = SIGMA scheduledValue          (over ALL lines)
 *     approvedChangeSum       = SIGMA changeOrderValue        (over ALL lines)
 *     revisedCommitmentSum    = originalCommitmentSum + approvedChangeSum
 *                             = SIGMA revisedScheduledValue
 *     balanceToFinish         = revisedCommitmentSum - totalInvoiced
 *
 * The commitment sum is DERIVED from the schedule of values and is never
 * settable on its own. A commitment with no SOV has no sum — which is the
 * honest answer, and the reason `approve` refuses an empty schedule. It is
 * also what makes the SOV identity unbreakable rather than merely checked:
 * there is no second place for the number to live and disagree.
 *
 * `scheduledValue` is what the line was worth when it was first scheduled, so
 * a line appended by an executed change order carries scheduledValue = 0 and
 * the whole of its value in `changeOrderValue`. That is what keeps
 * originalCommitmentSum equal to the sum of the ORIGINAL subcontract however
 * many change orders land on it afterwards.
 */

/* ------------------------------------------------------------------ */
/* SOV lines                                                           */
/* ------------------------------------------------------------------ */

/** The stored inputs a line's derived columns are computed from. */
export interface SovLineInputs {
  scheduledValue: number;
  changeOrderValue: number;
  previousBilled: number;
  previousStoredMaterials: number;
  thisPeriodWork: number;
  thisPeriodStoredMaterials: number;
  materialsPresentlyStored: number;
  retainagePercent: number;
  retainageReleased: number;
}

/** The derived columns, all of them materialized onto the row. */
export interface SovLineDerived {
  revisedScheduledValue: number;
  totalCompletedAndStored: number;
  percentComplete: number;
  balanceToFinish: number;
  retainageHeld: number;
}

/**
 * Derive a line's computed columns. `percentComplete` on a zero-value line is
 * 0, not NaN and not 100: a line worth nothing is not complete, and dividing
 * by zero to say otherwise is exactly the fabrication the money rules forbid.
 */
export function deriveSovLine(input: SovLineInputs): SovLineDerived {
  const revisedScheduledValue = round2(input.scheduledValue + input.changeOrderValue);
  const totalCompletedAndStored = round2(
    input.previousBilled + input.thisPeriodWork + input.materialsPresentlyStored,
  );
  const percentComplete =
    revisedScheduledValue === 0
      ? 0
      : round4((totalCompletedAndStored / revisedScheduledValue) * 100);
  const retainageHeld = round2(
    (input.retainagePercent / 100) * totalCompletedAndStored - input.retainageReleased,
  );
  return {
    revisedScheduledValue,
    totalCompletedAndStored,
    percentComplete,
    balanceToFinish: round2(revisedScheduledValue - totalCompletedAndStored),
    retainageHeld,
  };
}

/**
 * A unit-price line's scheduled value must equal quantity x unit rate. When
 * both are supplied the extension is computed; an explicit scheduledValue that
 * disagrees by more than a cent is refused rather than silently overwritten,
 * because the disagreement is the interesting fact.
 */
export function resolveScheduledValue(
  explicit: number | null | undefined,
  quantity: number | null | undefined,
  unitRate: number | null | undefined,
): { value: number; extended: boolean; error: string | null } {
  const measurable = quantity != null && unitRate != null;
  if (!measurable) {
    return { value: round2(explicit ?? 0), extended: false, error: null };
  }
  const extended = round2(quantity * unitRate);
  if (explicit != null && Math.abs(explicit - extended) > CENT) {
    return {
      value: extended,
      extended: true,
      error:
        `scheduledValue ${explicit} does not equal quantity x unitRate ` +
        `(${quantity} x ${unitRate} = ${extended}). Send one or the other, not a third figure.`,
    };
  }
  return { value: extended, extended: true, error: null };
}

/* ------------------------------------------------------------------ */
/* Commitment totals                                                   */
/* ------------------------------------------------------------------ */

export interface SovLineTotalsInput {
  scheduledValue: number;
  changeOrderValue: number;
  revisedScheduledValue: number;
  totalCompletedAndStored: number;
  retainageHeld: number;
  retainageReleased: number;
}

export interface ChangeTotalsInput {
  status: string;
  amount: number;
}

export interface CommitmentTotals {
  originalCommitmentSum: number;
  approvedChangeSum: number;
  pendingChangeSum: number;
  draftChangeSum: number;
  revisedCommitmentSum: number;
  retainageHeld: number;
  retainageReleased: number;
  lineCount: number;
}

/**
 * Roll a commitment's SOV and change-order register into the materialized
 * totals. Invoiced and paid are NOT computed here — they are driven by the
 * invoicing and payment writes and are only ever incremented from a real row.
 */
export function computeCommitmentTotals(
  lines: readonly SovLineTotalsInput[],
  changes: readonly ChangeTotalsInput[],
): CommitmentTotals {
  let originalCommitmentSum = 0;
  let approvedChangeSum = 0;
  let retainageHeld = 0;
  let retainageReleased = 0;
  for (const l of lines) {
    originalCommitmentSum += l.scheduledValue;
    approvedChangeSum += l.changeOrderValue;
    retainageHeld += l.retainageHeld;
    retainageReleased += l.retainageReleased;
  }
  let pendingChangeSum = 0;
  let draftChangeSum = 0;
  for (const c of changes) {
    if (c.status === "draft") draftChangeSum += c.amount;
    else if (
      c.status === "pending_pricing" ||
      c.status === "pending_in_house_review" ||
      c.status === "pending_owner_approval" ||
      c.status === "revise_and_resubmit"
    ) {
      pendingChangeSum += c.amount;
    }
  }
  const original = round2(originalCommitmentSum);
  const approved = round2(approvedChangeSum);
  return {
    originalCommitmentSum: original,
    approvedChangeSum: approved,
    pendingChangeSum: round2(pendingChangeSum),
    draftChangeSum: round2(draftChangeSum),
    revisedCommitmentSum: round2(original + approved),
    retainageHeld: round2(retainageHeld),
    retainageReleased: round2(retainageReleased),
    lineCount: lines.length,
  };
}

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

export interface ReconciliationCheck {
  name: string;
  left: number;
  right: number;
  variance: number;
  reconciles: boolean;
  statement: string;
}

const check = (
  name: string,
  statement: string,
  left: number,
  right: number,
): ReconciliationCheck => {
  const variance = round2(left - right);
  return { name, left: round2(left), right: round2(right), variance, reconciles: Math.abs(variance) <= CENT, statement };
};

/**
 * Every identity this module claims, checked against the stored rows and
 * reported whether it holds or not. This is deliberately a READ: a rollup
 * that quietly repaired itself would destroy the evidence that it drifted.
 */
export function reconcileCommitment(input: {
  originalCommitmentSum: number;
  approvedChangeSum: number;
  revisedCommitmentSum: number;
  lines: readonly SovLineTotalsInput[];
  committedChangeAmount: number;
  totalInvoiced: number;
  totalPaid: number;
  balanceToFinish: number;
}): { checks: ReconciliationCheck[]; reconciles: boolean } {
  const sumScheduled = input.lines.reduce((s, l) => s + l.scheduledValue, 0);
  const sumChangeOrder = input.lines.reduce((s, l) => s + l.changeOrderValue, 0);
  const sumRevised = input.lines.reduce((s, l) => s + l.revisedScheduledValue, 0);
  const checks: ReconciliationCheck[] = [
    check(
      "sov_original",
      "SIGMA sovLine.scheduledValue = commitment.originalCommitmentSum",
      sumScheduled,
      input.originalCommitmentSum,
    ),
    check(
      "sov_changes",
      "SIGMA sovLine.changeOrderValue = commitment.approvedChangeSum",
      sumChangeOrder,
      input.approvedChangeSum,
    ),
    check(
      "sov_revised",
      "SIGMA sovLine.revisedScheduledValue = commitment.revisedCommitmentSum",
      sumRevised,
      input.revisedCommitmentSum,
    ),
    check(
      "contract_sum",
      "originalCommitmentSum + approvedChangeSum = revisedCommitmentSum",
      input.originalCommitmentSum + input.approvedChangeSum,
      input.revisedCommitmentSum,
    ),
    check(
      "change_register",
      "SIGMA approved/executed change.amount = commitment.approvedChangeSum",
      input.committedChangeAmount,
      input.approvedChangeSum,
    ),
    check(
      "balance_to_finish",
      "revisedCommitmentSum - totalInvoiced = balanceToFinish",
      input.revisedCommitmentSum - input.totalInvoiced,
      input.balanceToFinish,
    ),
  ];
  return { checks, reconciles: checks.every((c) => c.reconciles) };
}

/* ------------------------------------------------------------------ */
/* Change-order allocation                                             */
/* ------------------------------------------------------------------ */

export interface ChangeLineAllocation {
  /** existing SOV line to load the change onto; null appends a new CO line */
  sovLineId: string | null;
  costCode: string | null;
  costType: string | null;
  description: string;
  amount: number;
  budgetLineItemId: string | null;
}

/**
 * A change order's line allocation must add up to its headline amount. A
 * change order whose lines do not sum to its amount cannot be posted to cost
 * codes, and a change order that cannot be posted to cost codes is not a
 * change order — it is a number in an email.
 */
export function assertAllocationSums(
  amount: number,
  lines: readonly ChangeLineAllocation[],
): { ok: true } | { ok: false; message: string } {
  if (lines.length === 0) return { ok: true };
  const total = round2(lines.reduce((s, l) => s + l.amount, 0));
  if (Math.abs(total - amount) > CENT) {
    return {
      ok: false,
      message:
        `Change order lines total ${total} but the change order amount is ${amount}. ` +
        "The allocation must equal the amount to the cent.",
    };
  }
  return { ok: true };
}
