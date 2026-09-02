import type { FinancialDataSource } from "@constructos/shared";
import { known, round2, round4, unknowable, type Unknowable } from "./shared.js";

/**
 * FINANCIAL SCREENING AND THE SINGLE-PROJECT LIMIT.
 *
 * Most prequalification approvals are not binary. They are capped: "yes, up
 * to £2.5m on any one job". That cap is the module's real output, and a cap
 * produced as a bare number is worthless — the vendor cannot argue with it,
 * the buyer cannot defend it, and nobody can tell a year later whether the
 * figures behind it were audited accounts or something typed into a form.
 *
 * So the rule is STATED, and every figure it produces carries its basis:
 *
 *   TEST 1  turnover        limit <= turnover x 25%
 *           A contractor carrying one job worth more than a quarter of its
 *           annual turnover has its whole year riding on that job.
 *   TEST 2  net assets      limit <= net assets x 5
 *           A loss on a contract is absorbed by the balance sheet or it is
 *           absorbed by you.
 *   TEST 3  track record    limit <= largest contract completed x 2
 *           A step change of more than double the biggest job they have ever
 *           delivered is a capability risk, not a commercial one.
 *
 * The recommendation is the LOWEST applicable test, and the response names
 * which test bound it. Two haircuts then apply, each stated:
 *
 *   liquidity   current ratio below 1.0  -> x0.5 (they cannot pay this year's
 *               bills from this year's assets; a retention-heavy contract will
 *               finish the job)
 *   gearing     debt above 100% of net assets -> x0.5
 *   provenance  self-declared figures -> x0.75 (ADR 0004: audited accounts and
 *               a number typed into a form are not the same evidence)
 *
 * HARD STOP: an auditor's going-concern qualification, or an insolvency event,
 * is not a score. It sets the recommendation to zero and says so.
 *
 * AND WHERE TURNOVER IS UNKNOWN THERE IS NO NUMBER. `value: null` with a
 * reason — never a default, never a zero that reads like a decision.
 */

export interface FinancialLimitRule {
  /** share of annual turnover one contract may represent */
  turnoverShare: number;
  /** multiple of net assets a contract may represent */
  netAssetsMultiple: number;
  /** multiple of the largest contract delivered to date */
  trackRecordMultiple: number;
  /** current ratio below this triggers the liquidity haircut */
  minCurrentRatio: number;
  lowLiquidityFactor: number;
  /** gearing above this percent triggers the gearing haircut */
  maxGearingPercent: number;
  highGearingFactor: number;
  /** haircut applied to figures that were not independently evidenced */
  unverifiedSourceFactor: number;
  /** sources treated as independently evidenced */
  verifiedSources: readonly FinancialDataSource[];
}

export const DEFAULT_FINANCIAL_LIMIT_RULE: FinancialLimitRule = {
  turnoverShare: 0.25,
  netAssetsMultiple: 5,
  trackRecordMultiple: 2,
  minCurrentRatio: 1,
  lowLiquidityFactor: 0.5,
  maxGearingPercent: 100,
  highGearingFactor: 0.5,
  unverifiedSourceFactor: 0.75,
  verifiedSources: ["audited_accounts", "filed_accounts", "credit_agency", "bank_reference"],
};

export interface FinancialFigures {
  currency: string;
  source: FinancialDataSource;
  financialYearEnd?: string | null;
  turnover?: number | null;
  grossProfit?: number | null;
  operatingProfit?: number | null;
  profitBeforeTax?: number | null;
  netAssets?: number | null;
  currentAssets?: number | null;
  currentLiabilities?: number | null;
  cashAtBank?: number | null;
  totalDebt?: number | null;
  /** stock/work in progress, if the vendor supplied it — needed for acid test */
  inventory?: number | null;
  largestContractValue?: number | null;
  orderBookValue?: number | null;
  isGoingConcernQualified?: boolean;
  insolvencyEventCount?: number;
  ccjCount?: number | null;
}

export interface DerivedRatios {
  workingCapital: Unknowable;
  currentRatio: Unknowable;
  acidTestRatio: Unknowable;
  gearingPercent: Unknowable;
  profitMarginPercent: Unknowable;
  returnOnCapitalPercent: Unknowable;
}

const num = (v: number | null | undefined): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : v;

/**
 * The ratios a screening decision actually turns on. Every one of them is an
 * `Unknowable`: a missing input produces null and a sentence, because a
 * current ratio of 0 and a current ratio nobody supplied are different facts
 * and only one of them is a reason to refuse a vendor.
 */
export function deriveRatios(f: FinancialFigures): DerivedRatios {
  const currentAssets = num(f.currentAssets);
  const currentLiabilities = num(f.currentLiabilities);
  const netAssets = num(f.netAssets);
  const totalDebt = num(f.totalDebt);
  const turnover = num(f.turnover);
  const pbt = num(f.profitBeforeTax);
  const operating = num(f.operatingProfit);
  const inventory = num(f.inventory);

  const workingCapital =
    currentAssets === null || currentLiabilities === null
      ? unknowable<number>(
          "Working capital is current assets less current liabilities; " +
            `${currentAssets === null ? "current assets" : "current liabilities"} was not supplied.`,
        )
      : known(round2(currentAssets - currentLiabilities));

  const currentRatio =
    currentAssets === null || currentLiabilities === null
      ? unknowable<number>(
          `The current ratio needs both current assets and current liabilities; ` +
            `${currentAssets === null ? "current assets" : "current liabilities"} was not supplied.`,
        )
      : currentLiabilities <= 0
        ? unknowable<number>(
            "Current liabilities are zero or negative, so the current ratio is undefined. " +
              "Check the figures before relying on them.",
          )
        : known(round4(currentAssets / currentLiabilities));

  const acidTestRatio =
    currentAssets === null || currentLiabilities === null || inventory === null
      ? unknowable<number>(
          "The acid-test ratio excludes stock and work in progress from current assets, and " +
            "that figure is not held on this record. Supply inventory to derive it, or read " +
            "the current ratio instead.",
        )
      : currentLiabilities <= 0
        ? unknowable<number>("Current liabilities are zero or negative, so the acid test is undefined.")
        : known(round4((currentAssets - inventory) / currentLiabilities));

  const gearingPercent =
    totalDebt === null || netAssets === null
      ? unknowable<number>(
          "Gearing is total debt as a percentage of net assets; " +
            `${totalDebt === null ? "total debt" : "net assets"} was not supplied.`,
        )
      : netAssets <= 0
        ? unknowable<number>(
            "Net assets are zero or negative, so gearing is undefined — and the balance sheet " +
              "is itself the finding, not the ratio derived from it.",
          )
        : known(round2((totalDebt / netAssets) * 100));

  const profitMarginPercent =
    pbt === null || turnover === null
      ? unknowable<number>(
          "The profit margin needs profit before tax and turnover; " +
            `${pbt === null ? "profit before tax" : "turnover"} was not supplied.`,
        )
      : turnover <= 0
        ? unknowable<number>("Turnover is zero or negative, so a profit margin cannot be formed.")
        : known(round2((pbt / turnover) * 100));

  const returnOnCapitalPercent =
    operating === null || netAssets === null
      ? unknowable<number>(
          "Return on capital needs operating profit and net assets; " +
            `${operating === null ? "operating profit" : "net assets"} was not supplied.`,
        )
      : netAssets <= 0
        ? unknowable<number>("Net assets are zero or negative, so return on capital is undefined.")
        : known(round2((operating / netAssets) * 100));

  return {
    workingCapital,
    currentRatio,
    acidTestRatio,
    gearingPercent,
    profitMarginPercent,
    returnOnCapitalPercent,
  };
}

export interface LimitTest {
  key: "turnover" | "net_assets" | "track_record";
  label: string;
  /** the ceiling this test puts on a single contract, or null if not applicable */
  value: number | null;
  detail: string;
}

export interface LimitFactor {
  key: "liquidity" | "gearing" | "provenance";
  factor: number;
  why: string;
}

export interface RecommendedLimit {
  /** the recommended cap on any ONE contract, or null with reasons */
  value: number | null;
  currency: string;
  /** the sentence a buyer can put in front of the vendor and an auditor */
  basis: string;
  bindingTest: LimitTest["key"] | "hard_stop" | null;
  tests: LimitTest[];
  factors: LimitFactor[];
  /** the un-haircut figure, before the factors below were applied */
  headroomBeforeFactors: number | null;
  reasons: string[];
  rule: FinancialLimitRule;
}

/**
 * Derive the recommended single-project limit. See the file header for the
 * rule; the returned `basis` states it in the same words to whoever reads the
 * record.
 */
export function recommendSingleProjectLimit(
  f: FinancialFigures,
  ratios: DerivedRatios = deriveRatios(f),
  rule: FinancialLimitRule = DEFAULT_FINANCIAL_LIMIT_RULE,
): RecommendedLimit {
  const currency = f.currency.toUpperCase();
  const insolvencyEvents = f.insolvencyEventCount ?? 0;

  if (f.isGoingConcernQualified || insolvencyEvents > 0) {
    const why = f.isGoingConcernQualified
      ? "the auditor has qualified the accounts on going concern"
      : `${insolvencyEvents} insolvency event(s) are recorded against this company`;
    return {
      value: 0,
      currency,
      basis:
        `No single-project limit is recommended: ${why}. This is a hard stop, not a score — a ` +
        "contractor whose ability to continue trading is in doubt cannot be given work on the " +
        "strength of a ratio, and a limit of any size would imply an assurance nobody can give.",
      bindingTest: "hard_stop",
      tests: [],
      factors: [],
      headroomBeforeFactors: null,
      reasons: [],
      rule,
    };
  }

  const turnover = num(f.turnover);
  const netAssets = num(f.netAssets);
  const largest = num(f.largestContractValue);

  const tests: LimitTest[] = [];
  if (turnover !== null && turnover > 0) {
    tests.push({
      key: "turnover",
      label: `Turnover x ${round2(rule.turnoverShare * 100)}%`,
      value: round2(turnover * rule.turnoverShare),
      detail:
        `Annual turnover of ${currency} ${round2(turnover)} x ${round2(rule.turnoverShare * 100)}% ` +
        `= ${currency} ${round2(turnover * rule.turnoverShare)}. One contract worth more than ` +
        "that puts a disproportionate share of the year's workload on a single job.",
    });
  }
  if (netAssets !== null && netAssets > 0) {
    tests.push({
      key: "net_assets",
      label: `Net assets x ${rule.netAssetsMultiple}`,
      value: round2(netAssets * rule.netAssetsMultiple),
      detail:
        `Net assets of ${currency} ${round2(netAssets)} x ${rule.netAssetsMultiple} = ` +
        `${currency} ${round2(netAssets * rule.netAssetsMultiple)}. A loss on the contract is ` +
        "absorbed by that balance sheet or it is absorbed by the buyer.",
    });
  }
  if (largest !== null && largest > 0) {
    tests.push({
      key: "track_record",
      label: `Largest contract delivered x ${rule.trackRecordMultiple}`,
      value: round2(largest * rule.trackRecordMultiple),
      detail:
        `The largest contract delivered to date is ${currency} ${round2(largest)}; x ` +
        `${rule.trackRecordMultiple} = ${currency} ${round2(largest * rule.trackRecordMultiple)}. ` +
        "A step change beyond that is a delivery risk however healthy the balance sheet is.",
    });
  }

  if (turnover === null || turnover <= 0) {
    return {
      value: null,
      currency,
      basis:
        "No single-project limit can be recommended: annual turnover is not recorded for this " +
        "period, and every limit on this platform is derived from turnover first. Collect the " +
        "accounts — a limit invented without them would be a number with no argument behind it.",
      bindingTest: null,
      tests,
      factors: [],
      headroomBeforeFactors: null,
      reasons: [
        turnover === null
          ? "Turnover was not supplied for this financial period."
          : "Turnover is zero or negative for this financial period.",
      ],
      rule,
    };
  }

  const applicable = tests.filter(
    (t): t is LimitTest & { value: number } => t.value !== null && Number.isFinite(t.value),
  );
  const binding = applicable.reduce((lowest, t) => (t.value < lowest.value ? t : lowest));
  const headroom = binding.value;

  const factors: LimitFactor[] = [];
  if (
    ratios.currentRatio.value !== null &&
    ratios.currentRatio.value < rule.minCurrentRatio
  ) {
    factors.push({
      key: "liquidity",
      factor: rule.lowLiquidityFactor,
      why:
        `Current ratio is ${ratios.currentRatio.value}, below ${rule.minCurrentRatio}: current ` +
        "liabilities exceed current assets, so this year's bills are not covered by this " +
        `year's assets. The limit is reduced to ${round2(rule.lowLiquidityFactor * 100)}% — a ` +
        "retention-heavy contract is exactly the wrong thing to give a contractor with no headroom.",
    });
  }
  if (
    ratios.gearingPercent.value !== null &&
    ratios.gearingPercent.value > rule.maxGearingPercent
  ) {
    factors.push({
      key: "gearing",
      factor: rule.highGearingFactor,
      why:
        `Gearing is ${ratios.gearingPercent.value}% of net assets, above ${rule.maxGearingPercent}%: ` +
        "the business is financed by debt rather than by its owners, and the lender's view of it " +
        `can change faster than the works can. The limit is reduced to ` +
        `${round2(rule.highGearingFactor * 100)}%.`,
    });
  }
  if (!rule.verifiedSources.includes(f.source)) {
    factors.push({
      key: "provenance",
      factor: rule.unverifiedSourceFactor,
      why:
        `These figures are "${f.source}" rather than independently evidenced accounts. Audited ` +
        "accounts and a number typed into a form are not the same evidence, so the limit is " +
        `reduced to ${round2(rule.unverifiedSourceFactor * 100)}% until evidence is collected.`,
    });
  }

  const combined = factors.reduce((acc, fac) => acc * fac.factor, 1);
  const value = round2(headroom * combined);

  const basisParts = [
    `Recommended single-project limit ${currency} ${value}.`,
    `Bound by: ${binding.label}. ${binding.detail}`,
  ];
  const otherTests = applicable.filter((t) => t.key !== binding.key);
  if (otherTests.length > 0) {
    basisParts.push(
      `Other tests allowed more and did not bind: ${otherTests
        .map((t) => `${t.label} = ${currency} ${t.value}`)
        .join("; ")}.`,
    );
  }
  for (const fac of factors) basisParts.push(fac.why);
  if (factors.length > 0) {
    basisParts.push(
      `Before those reductions the tests allowed ${currency} ${round2(headroom)}.`,
    );
  }

  const reasons: string[] = [];
  if (netAssets === null) {
    reasons.push(
      "Net assets were not supplied, so the balance-sheet test could not be applied — the " +
        "recommendation rests on turnover and track record alone.",
    );
  }
  if (largest === null) {
    reasons.push(
      "The largest contract delivered to date was not supplied, so the track-record test could " +
        "not be applied.",
    );
  }

  return {
    value,
    currency,
    basis: basisParts.join(" "),
    bindingTest: binding.key,
    tests,
    factors,
    headroomBeforeFactors: round2(headroom),
    reasons,
    rule,
  };
}

export interface LimitCheck {
  /** true / false, or null when the question could not be answered */
  exceeds: boolean | null;
  contractValue: number;
  contractCurrency: string;
  limit: number | null;
  limitCurrency: string | null;
  /** contractValue / limit */
  ratio: number | null;
  severity: "none" | "info" | "warning" | "critical";
  message: string;
}

/**
 * Flag a contract value against a vendor's recommended limit. Called wherever
 * a vendor is being CONSIDERED — invited, submitted, recommended for award —
 * because the moment to notice that a job is three times the size of anything
 * they have done is before the contract, not during it.
 */
export function checkContractAgainstLimit(input: {
  contractValue: number | null;
  contractCurrency: string;
  limit: number | null;
  limitCurrency: string | null;
  vendorName: string;
  basis?: string | null;
}): LimitCheck {
  const contractCurrency = input.contractCurrency.toUpperCase();
  const limitCurrency = input.limitCurrency ? input.limitCurrency.toUpperCase() : null;
  const contractValue = input.contractValue ?? 0;

  if (input.contractValue === null || !Number.isFinite(input.contractValue)) {
    return {
      exceeds: null,
      contractValue,
      contractCurrency,
      limit: input.limit,
      limitCurrency,
      ratio: null,
      severity: "info",
      message:
        `No value is recorded for this contract, so it cannot be tested against ${input.vendorName}'s ` +
        "prequalification limit.",
    };
  }
  if (input.limit === null) {
    return {
      exceeds: null,
      contractValue,
      contractCurrency,
      limit: null,
      limitCurrency,
      ratio: null,
      severity: "warning",
      message:
        `${input.vendorName} has no recommended single-project limit on the record, so this ` +
        `${contractCurrency} ${round2(contractValue)} contract cannot be tested against one. ` +
        "Collect the financial screening before relying on their capacity.",
    };
  }
  if (limitCurrency && limitCurrency !== contractCurrency) {
    return {
      exceeds: null,
      contractValue,
      contractCurrency,
      limit: input.limit,
      limitCurrency,
      ratio: null,
      severity: "warning",
      message:
        `${input.vendorName}'s limit is stated in ${limitCurrency} and this contract in ` +
        `${contractCurrency}. Figures in different currencies are never compared here — no rate ` +
        "is on the record. Restate the screening in the contract currency.",
    };
  }
  if (input.limit <= 0) {
    return {
      exceeds: true,
      contractValue,
      contractCurrency,
      limit: input.limit,
      limitCurrency,
      ratio: null,
      severity: "critical",
      message:
        `${input.vendorName} carries a recommended limit of zero — the screening found a hard ` +
        "stop (going concern or insolvency). No contract value is within that limit.",
    };
  }
  const ratio = round4(contractValue / input.limit);
  const exceeds = contractValue > input.limit;
  return {
    exceeds,
    contractValue,
    contractCurrency,
    limit: input.limit,
    limitCurrency,
    ratio,
    severity: exceeds ? (ratio >= 1.5 ? "critical" : "warning") : "none",
    message: exceeds
      ? `${contractCurrency} ${round2(contractValue)} exceeds ${input.vendorName}'s recommended ` +
        `single-project limit of ${contractCurrency} ${round2(input.limit)} (${round2(ratio * 100)}% ` +
        `of it).${input.basis ? ` Basis: ${input.basis}` : ""} Either reduce the exposure, take ` +
        "security for it, or record the decision to exceed the limit and who took it."
      : `${contractCurrency} ${round2(contractValue)} is within ${input.vendorName}'s recommended ` +
        `single-project limit of ${contractCurrency} ${round2(input.limit)} ` +
        `(${round2(ratio * 100)}% of it).`,
  };
}

/**
 * Contract value as a share of annual turnover — the figure the
 * `contract_to_turnover_ratio` column exists for, and the one a credit
 * insurer asks about first.
 */
export function contractToTurnoverRatio(
  contractValue: number | null,
  turnover: number | null,
): Unknowable {
  if (contractValue === null || !Number.isFinite(contractValue)) {
    return unknowable("No contract value supplied.");
  }
  if (turnover === null || !Number.isFinite(turnover) || turnover <= 0) {
    return unknowable(
      "Annual turnover is not recorded for this vendor, so the contract cannot be expressed as " +
        "a share of it.",
    );
  }
  return known(round4(contractValue / turnover));
}
