/**
 * Final account engine (spec Vol II Domain B #181-183, #187).
 *
 * The adjustment schedule, in statement order:
 *
 *   contract sum
 *     − omissions and omitted provisional sums
 *     ± remeasured quantities
 *     + agreed variations
 *     + provisional sum / prime cost expenditure
 *     + dayworks
 *     ± fluctuations
 *     ± claims and loss & expense
 *     − liquidated damages
 *     − contra charges
 *   = final contract sum
 *
 * Every line names the record it came from, so the statement is traceable
 * rather than typed. Anything unresolved at compute time (an open variation,
 * an unagreed remeasurement, a submitted daywork sheet) is reported as a gap
 * and left OUT of the total — a final account that quietly includes disputed
 * money is not a final account.
 */
import type { FinalAccountCategory } from "@constructos/shared";

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface FinalAccountLineInput {
  category: FinalAccountCategory;
  description: string;
  amount: number;
  sourceType?: string | null;
  sourceId?: string | null;
  sourceHash?: string | null;
  manual?: boolean;
  note?: string | null;
}

export interface FinalAccountInput {
  contractSum: number;
  lines: FinalAccountLineInput[];
  certifiedToDate: number;
  gaps: string[];
}

export interface FinalAccountStatement {
  contractSum: number;
  categories: Array<{
    category: FinalAccountCategory;
    label: string;
    amount: number;
    lineCount: number;
  }>;
  finalContractSum: number;
  certifiedToDate: number;
  /** positive = still owed to the contractor; negative = over-certified */
  balanceDue: number;
  overCertified: boolean;
  gaps: string[];
}

/** Presentation order and label of each adjustment category. */
const CATEGORY_ORDER: Array<{ category: FinalAccountCategory; label: string }> = [
  { category: "contract_sum", label: "Contract sum" },
  { category: "omission", label: "Less omissions" },
  { category: "provisional_sum_omitted", label: "Less provisional sums omitted" },
  { category: "remeasurement", label: "Remeasurement adjustment" },
  { category: "variation", label: "Agreed variations" },
  { category: "provisional_sum_expenditure", label: "Provisional sum / prime cost expenditure" },
  { category: "daywork", label: "Dayworks" },
  { category: "fluctuation", label: "Fluctuations" },
  { category: "claim", label: "Claims and loss & expense" },
  { category: "liquidated_damages", label: "Less liquidated damages" },
  { category: "contra_charge", label: "Less contra charges" },
  { category: "other", label: "Other adjustments" },
];

const CATEGORY_LABEL = new Map(CATEGORY_ORDER.map((c) => [c.category, c.label]));

/**
 * Build the statement. Line amounts are signed by the caller (an omission is
 * negative), so the engine never guesses the direction of an adjustment; it
 * only orders, totals and reconciles.
 */
export function buildFinalAccount(input: FinalAccountInput): FinalAccountStatement {
  const byCategory = new Map<FinalAccountCategory, { amount: number; lineCount: number }>();
  for (const line of input.lines) {
    const bucket = byCategory.get(line.category) ?? { amount: 0, lineCount: 0 };
    bucket.amount += line.amount;
    bucket.lineCount += 1;
    byCategory.set(line.category, bucket);
  }

  const categories = CATEGORY_ORDER.filter((c) => c.category !== "contract_sum")
    .filter((c) => byCategory.has(c.category))
    .map((c) => {
      const bucket = byCategory.get(c.category)!;
      return {
        category: c.category,
        label: c.label,
        amount: round2(bucket.amount),
        lineCount: bucket.lineCount,
      };
    });

  const adjustments = categories.reduce((s, c) => s + c.amount, 0);
  const finalContractSum = round2(input.contractSum + adjustments);
  const certifiedToDate = round2(input.certifiedToDate);
  const balanceDue = round2(finalContractSum - certifiedToDate);

  return {
    contractSum: round2(input.contractSum),
    categories,
    finalContractSum,
    certifiedToDate,
    balanceDue,
    overCertified: balanceDue < 0,
    gaps: input.gaps,
  };
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABEL.get(category as FinalAccountCategory) ?? category;
}
