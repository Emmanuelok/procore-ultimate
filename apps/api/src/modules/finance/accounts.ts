/**
 * Designated (special) account arithmetic — spec Vol II Domain O (#735,
 * #745), the control the whole advance mechanism rests on.
 *
 * A designated account is an advance a financier places at the borrower's
 * disposal and replenishes on evidence of eligible expenditure. Two numbers
 * decide whether it is being run honestly:
 *
 *  - the LEDGER balance: opening balance plus everything paid in, less
 *    everything paid out, from this account's own entries;
 *  - the STATEMENT balance: what the bank says on the same date.
 *
 * A difference between them is either explained or it is a finding. This
 * module computes both sides and the difference; it does not decide what to
 * do about it, and it never "adjusts" one to match the other.
 *
 * Deliberately not modelled: foreign-exchange revaluation of an account held
 * in a currency other than the facility's, and interest accrual on the
 * balance (recorded as an entry when it happens, never imputed).
 */
import type { DesignatedAccountEntryKind } from "@constructos/shared";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The sign each movement carries. Amounts are always stored positive: the
 * kind is what makes a withdrawal a withdrawal, so a mistyped sign cannot
 * silently turn expenditure into a deposit.
 */
export function entrySign(kind: string): 1 | -1 {
  switch (kind as DesignatedAccountEntryKind) {
    case "advance":
    case "replenishment":
    case "interest_earned":
      return 1;
    case "eligible_expenditure":
    case "ineligible_expenditure":
    case "bank_charge":
    case "refund_to_lender":
    case "transfer_out":
      return -1;
    default:
      // An unknown kind must not quietly count as money in.
      return -1;
  }
}

export interface AccountEntryInput {
  entryDate: string; // ISO date
  kind: string;
  /** always >= 0; `entrySign` decides the direction */
  amount: number;
}

export interface AccountPosition {
  /** balance implied by the account's own ledger at `asAt` */
  balance: number;
  openingBalance: number;
  advances: number;
  replenishments: number;
  eligibleExpenditure: number;
  ineligibleExpenditure: number;
  bankCharges: number;
  interestEarned: number;
  refunds: number;
  transfersOut: number;
  entryCount: number;
  /**
   * Advance still to be justified: everything advanced less everything
   * documented as eligible expenditure. This is the figure a financier
   * calls "outstanding advance".
   */
  outstandingAdvance: number;
  /** eligible expenditure as a % of everything advanced; null when nothing advanced */
  documentedPercent: number | null;
  /** headroom against the authorised ceiling; null when no ceiling is set */
  ceilingHeadroom: number | null;
  /** true when the ledger balance exceeds the authorised ceiling */
  overCeiling: boolean;
  basis: string;
}

/**
 * Roll the account's own ledger forward to a date.
 *
 * Entries dated AFTER `asAt` are excluded rather than netted — a
 * reconciliation as at 30 June must not be moved by a payment made in July.
 */
export function computeAccountPosition(
  opening: { openingBalance: number; authorisedCeiling: number | null },
  entries: AccountEntryInput[],
  asAt: string,
): AccountPosition {
  const inScope = entries.filter((e) => e.entryDate <= asAt);
  const sumOf = (kind: DesignatedAccountEntryKind): number =>
    round2(inScope.filter((e) => e.kind === kind).reduce((s, e) => s + Math.abs(e.amount), 0));

  const advances = sumOf("advance");
  const replenishments = sumOf("replenishment");
  const eligibleExpenditure = sumOf("eligible_expenditure");
  const ineligibleExpenditure = sumOf("ineligible_expenditure");
  const bankCharges = sumOf("bank_charge");
  const interestEarned = sumOf("interest_earned");
  const refunds = sumOf("refund_to_lender");
  const transfersOut = sumOf("transfer_out");

  const movement = inScope.reduce((s, e) => s + entrySign(e.kind) * Math.abs(e.amount), 0);
  const balance = round2(opening.openingBalance + movement);

  const advancedTotal = round2(advances + replenishments);
  const outstandingAdvance = round2(advancedTotal - eligibleExpenditure);
  const documentedPercent =
    advancedTotal <= 0 ? null : round2((eligibleExpenditure / advancedTotal) * 100);
  const ceilingHeadroom =
    opening.authorisedCeiling === null ? null : round2(opening.authorisedCeiling - balance);

  return {
    balance,
    openingBalance: round2(opening.openingBalance),
    advances,
    replenishments,
    eligibleExpenditure,
    ineligibleExpenditure,
    bankCharges,
    interestEarned,
    refunds,
    transfersOut,
    entryCount: inScope.length,
    outstandingAdvance,
    documentedPercent,
    ceilingHeadroom,
    overCeiling: opening.authorisedCeiling !== null && balance > opening.authorisedCeiling,
    basis:
      `Opening balance ${round2(opening.openingBalance)} plus advances and replenishments ` +
      `(${advancedTotal}) and interest earned (${interestEarned}), less expenditure ` +
      `(${round2(eligibleExpenditure + ineligibleExpenditure)}), bank charges (${bankCharges}), ` +
      `refunds (${refunds}) and transfers out (${transfersOut}), over ${inScope.length} entr` +
      `${inScope.length === 1 ? "y" : "ies"} dated on or before ${asAt}. Entries after that date ` +
      `are excluded, not netted. No FX revaluation and no imputed interest.`,
  };
}

export interface AccountReconciliation {
  statementBalance: number;
  computedBalance: number;
  /** statement − ledger; positive = the bank holds more than the ledger explains */
  difference: number;
  outcome: "reconciled" | "unreconciled";
  /** absolute tolerance applied, in account currency */
  tolerance: number;
  explanation: string;
}

/**
 * Compare the bank against the ledger.
 *
 * The tolerance exists for rounding and cross-border charges, not for
 * "close enough": anything outside it is reported unreconciled, and the
 * caller is expected to raise it rather than absorb it.
 */
export function reconcileAccount(input: {
  statementBalance: number;
  computedBalance: number;
  tolerance?: number;
}): AccountReconciliation {
  const tolerance = Math.abs(input.tolerance ?? 0.01);
  const difference = round2(input.statementBalance - input.computedBalance);
  const reconciled = Math.abs(difference) <= tolerance;
  return {
    statementBalance: round2(input.statementBalance),
    computedBalance: round2(input.computedBalance),
    difference,
    outcome: reconciled ? "reconciled" : "unreconciled",
    tolerance,
    explanation: reconciled
      ? `The statement balance and the account ledger agree to within ${tolerance}.`
      : `The bank statement is ${difference > 0 ? "higher" : "lower"} than the account ledger by ` +
        `${Math.abs(difference)}, outside the ${tolerance} tolerance. Until that is explained, the ` +
        `advance outstanding on this account is not evidenced.`,
  };
}
