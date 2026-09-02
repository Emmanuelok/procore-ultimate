/**
 * NEC compensation-event cycle (spec Vol II Domain C #206-211).
 *
 * NEC does not have "a variation"; it has a governed cycle with its own
 * clocks, and the clocks are the product:
 *
 *   61.3  Contractor notifies             (8 weeks / 56 days, condition precedent)
 *   61.4  PM replies to the notification  (1 week / 7 days)
 *   62.1  PM instructs a quotation
 *   62.3  Contractor submits the quotation (3 weeks / 21 days)
 *   62.3  PM replies to the quotation      (2 weeks / 14 days)
 *   62.6  Deemed acceptance after a reminder that goes unanswered (NEC4)
 *   64.1  PM assesses when the Contractor has not
 *   65.1  The event is implemented
 *
 * This file holds the state machine, the clocks and the Defined Cost + Fee
 * arithmetic; the routes hold the persistence. Everything is pure so a period
 * can be reasoned about without a clock.
 */
import type { CeState, NecOption, NecValuationBasis, SccComponent } from "@constructos/shared";

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Default NEC clocks in days, overridable by the Contract Data. */
export const NEC_CLOCKS = {
  notification: 56,
  pmReplyToNotification: 7,
  quotationSubmission: 21,
  pmReplyToQuotation: 14,
  /** NEC4 62.6: after the reminder, silence for this long is acceptance */
  deemedAcceptanceReminder: 14,
} as const;

/** Legal transitions of the compensation-event sub-state machine. */
export const CE_TRANSITIONS: Record<CeState, CeState[]> = {
  notified: ["quotation_requested", "pm_assessment", "rejected"],
  quotation_requested: ["quotation_submitted", "pm_assessment", "rejected"],
  quotation_submitted: ["pm_replied", "pm_assessment", "implemented", "rejected"],
  pm_replied: ["quotation_requested", "quotation_submitted", "implemented", "pm_assessment"],
  pm_assessment: ["implemented", "rejected"],
  implemented: [],
  rejected: [],
};

export function canTransition(from: CeState, to: CeState): boolean {
  return (CE_TRANSITIONS[from] ?? []).includes(to);
}

/** Which valuation basis an NEC main option implies (#211). */
export function necValuationBasis(option: NecOption | null | undefined): {
  basis: NecValuationBasis;
  painGainShare: boolean;
  explanation: string;
} {
  switch (option) {
    case "A":
      return {
        basis: "activity_schedule",
        painGainShare: false,
        explanation:
          "Option A is a priced contract with an activity schedule: the Prices are lump sums per activity and payment follows completed activities, not measured quantities.",
      };
    case "B":
      return {
        basis: "bill_of_quantities",
        painGainShare: false,
        explanation:
          "Option B is a priced contract with bill of quantities: the Prices are rates and lump sums in the BoQ and the work is remeasured.",
      };
    case "C":
      return {
        basis: "target_cost",
        painGainShare: true,
        explanation:
          "Option C is target contract with activity schedule: the Contractor is paid Defined Cost plus Fee, reconciled against the target with the share ranges in the Contract Data (pain/gain).",
      };
    case "D":
      return {
        basis: "target_cost",
        painGainShare: true,
        explanation:
          "Option D is target contract with bill of quantities: Defined Cost plus Fee, reconciled against a remeasured target with the share ranges in the Contract Data.",
      };
    case "E":
      return {
        basis: "cost_reimbursable",
        painGainShare: false,
        explanation:
          "Option E is cost reimbursable: the Contractor is paid Defined Cost plus Fee with no target.",
      };
    case "F":
      return {
        basis: "management",
        painGainShare: false,
        explanation:
          "Option F is a management contract: the Contractor is paid the Price for Work Done to Date of its subcontracts plus Fee.",
      };
    default:
      return {
        basis: "bill_of_quantities",
        painGainShare: false,
        explanation: "No NEC main option recorded; the bill of quantities basis is assumed.",
      };
  }
}

/* ------------------------------------------------------------------ */
/* Quotation arithmetic (#207-208)                                     */
/* ------------------------------------------------------------------ */

export interface QuotationComponentInput {
  component: SccComponent;
  description: string;
  qty: number;
  unit?: string | null;
  rate: number;
}

export interface QuotationComputed {
  components: Array<QuotationComponentInput & { amount: number }>;
  byComponent: Record<string, number>;
  definedCost: number;
  fee: number;
  feePercent: number;
  riskAllowance: number;
  total: number;
}

/**
 * Defined Cost + Fee, by Schedule of Cost Components head. The Fee is a
 * percentage of Defined Cost (NEC 52.1); the risk allowance is added after
 * the Fee because it is an allowance for matters that have a significant
 * chance of occurring, not a cost the Fee is earned on.
 */
export function computeQuotation(
  components: QuotationComponentInput[],
  feePercent: number,
  riskAllowance = 0,
): QuotationComputed {
  const extended = components.map((c) => ({ ...c, amount: round2(c.qty * c.rate) }));
  const byComponent: Record<string, number> = {};
  let definedCost = 0;
  for (const c of extended) {
    definedCost += c.amount;
    byComponent[c.component] = round2((byComponent[c.component] ?? 0) + c.amount);
  }
  definedCost = round2(definedCost);
  const fee = round2(definedCost * (feePercent / 100));
  const risk = round2(riskAllowance);
  return {
    components: extended,
    byComponent,
    definedCost,
    fee,
    feePercent,
    riskAllowance: risk,
    total: round2(definedCost + fee + risk),
  };
}

/* ------------------------------------------------------------------ */
/* Pain / gain share (Options C and D)                                 */
/* ------------------------------------------------------------------ */

export interface ShareRange {
  /** upper bound of the range as a fraction of the target (1.05 = 105%) */
  upTo: number | null;
  /** contractor's share percentage in this band */
  sharePercent: number;
}

export interface PainGainResult {
  target: number;
  actual: number;
  difference: number;
  /** positive = gain to the Contractor, negative = pain */
  contractorShare: number;
  bands: Array<{ from: number; to: number | null; amount: number; sharePercent: number; share: number }>;
  explanation: string;
}

/**
 * Apply the share ranges band by band. Under-spend is gain, over-spend is
 * pain; both are apportioned through the same table, which is what makes the
 * mechanism symmetric and auditable.
 */
export function computePainGain(
  target: number,
  actualCost: number,
  ranges: ShareRange[],
): PainGainResult {
  const difference = round2(target - actualCost);
  const sorted = [...ranges].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
  const bands: PainGainResult["bands"] = [];
  let remaining = Math.abs(difference);
  let cursor = 0;
  let contractorShare = 0;
  const sign = difference >= 0 ? 1 : -1;

  for (const range of sorted) {
    if (remaining <= 0) break;
    const bandLimit =
      range.upTo == null ? Infinity : Math.max(0, round2(Math.abs(range.upTo - 1) * target));
    const bandAmount = Math.min(remaining, bandLimit === Infinity ? remaining : Math.max(0, bandLimit - cursor));
    if (bandAmount <= 0 && bandLimit !== Infinity) continue;
    const share = round2(bandAmount * (range.sharePercent / 100) * sign);
    contractorShare += share;
    bands.push({
      from: round2(cursor),
      to: bandLimit === Infinity ? null : round2(bandLimit),
      amount: round2(bandAmount * sign),
      sharePercent: range.sharePercent,
      share,
    });
    cursor += bandAmount;
    remaining -= bandAmount;
  }

  return {
    target: round2(target),
    actual: round2(actualCost),
    difference,
    contractorShare: round2(contractorShare),
    bands,
    explanation:
      difference === 0
        ? "Actual Defined Cost equals the target; no share applies."
        : `${difference > 0 ? "Gain" : "Pain"} of ${Math.abs(difference)} against a target of ${round2(target)}, apportioned through ${bands.length} share range${bands.length === 1 ? "" : "s"} to a Contractor share of ${round2(contractorShare)}.`,
  };
}

/* ------------------------------------------------------------------ */
/* Deemed acceptance clock (62.6 / 64.4)                               */
/* ------------------------------------------------------------------ */

export interface DeemedAcceptanceInput {
  quotationStatus: string;
  replyDueDate: string | null;
  repliedAt: string | null;
  today: string;
  /** NEC3 has no deemed-acceptance backstop; NEC4 does */
  form: string;
}

export interface DeemedAcceptanceVerdict {
  deemed: boolean;
  overdue: boolean;
  daysOverdue: number;
  reason: string;
}

export function deemedAcceptance(input: DeemedAcceptanceInput): DeemedAcceptanceVerdict {
  if (input.quotationStatus !== "submitted" || input.repliedAt) {
    return { deemed: false, overdue: false, daysOverdue: 0, reason: "The quotation has been replied to." };
  }
  if (!input.replyDueDate) {
    return {
      deemed: false,
      overdue: false,
      daysOverdue: 0,
      reason: "No reply date is recorded for the quotation.",
    };
  }
  if (input.today <= input.replyDueDate) {
    return {
      deemed: false,
      overdue: false,
      daysOverdue: 0,
      reason: `The Project Manager's reply is due by ${input.replyDueDate}.`,
    };
  }
  const daysOverdue = Math.round(
    (Date.parse(`${input.today}T00:00:00Z`) - Date.parse(`${input.replyDueDate}T00:00:00Z`)) /
      86_400_000,
  );
  const nec4 = input.form === "nec4_ecc";
  const deemed = nec4 && daysOverdue >= NEC_CLOCKS.deemedAcceptanceReminder;
  return {
    deemed,
    overdue: true,
    daysOverdue,
    reason: deemed
      ? `The Project Manager did not reply by ${input.replyDueDate} and the further period under 62.6 has elapsed (${daysOverdue} days overdue); the quotation is treated as accepted.`
      : nec4
        ? `The Project Manager's reply was due on ${input.replyDueDate}, ${daysOverdue} days ago. Notify the Project Manager under 62.6 to start the deemed-acceptance period.`
        : `The Project Manager's reply was due on ${input.replyDueDate}, ${daysOverdue} days ago. NEC3 has no deemed-acceptance backstop; the failure must be pursued.`,
  };
}
