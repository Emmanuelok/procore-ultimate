/**
 * Quantum engines for prolongation and related heads of claim
 * (spec Vol II Domain D #300-303, #312-313, #320) — pure.
 *
 * Five families, each stating its formula and its assumptions rather than
 * producing a bare number:
 *
 *  HUDSON     (HO&P% / 100) × (contract sum / contract period) × delay days.
 *             Criticised because the percentage comes from the tender, so the
 *             claim recovers what was priced rather than what was lost — the
 *             engine says so in `assumptions`.
 *  EMDEN      Same shape, but the percentage is the contractor's ACTUAL head
 *             office overhead and profit rate from its audited accounts.
 *  EICHLEAY   (contract billings / total billings) × total HO overhead for the
 *             period = allocable overhead; ÷ days of performance = daily rate;
 *             × compensable delay days. The US federal approach; it requires
 *             the contractor to have been on standby and unable to take on
 *             replacement work, which is recorded as a required assumption.
 *  SITE       Time-related preliminaries at a daily rate × delay days, plus
 *  OVERHEAD   any fixed preliminaries attributable to the extended period.
 *  FINANCE    amount × rate × days / 365, simple or compound.
 *  PROFIT     tendered margin × the turnover the delay displaced.
 *
 * Every function returns `missing` when an input it needs is absent, and
 * NEVER substitutes a default for a figure that has to come from a record.
 * A quantum number without its inputs is not a number, it is a guess with a
 * currency symbol.
 */

import type { InterestBasis, QuantumMethod } from "@constructos/shared";

export interface QuantumResult {
  ok: boolean;
  method: QuantumMethod;
  amount: number | null;
  formula: string;
  workings: string;
  assumptions: string[];
  missing: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => round2(n).toLocaleString("en-US", { maximumFractionDigits: 2 });

function fail(method: QuantumMethod, formula: string, missing: string[]): QuantumResult {
  return {
    ok: false,
    method,
    amount: null,
    formula,
    workings: "",
    assumptions: [],
    missing,
  };
}

/* ------------------------------------------------------------------ */
/* Head-office overhead                                                */
/* ------------------------------------------------------------------ */

export interface HudsonInput {
  contractSum: number | null;
  contractPeriodDays: number | null;
  /** head office overhead and profit percentage from the tender */
  hoProfitPercent: number | null;
  delayDays: number;
}

export function hudson(input: HudsonInput): QuantumResult {
  const formula = "(HO&P% ÷ 100) × (contract sum ÷ contract period in days) × delay days";
  const missing: string[] = [];
  if (input.contractSum === null || input.contractSum <= 0) missing.push("contractSum");
  if (input.contractPeriodDays === null || input.contractPeriodDays <= 0) missing.push("contractPeriodDays");
  if (input.hoProfitPercent === null || input.hoProfitPercent <= 0) missing.push("hoProfitPercent");
  if (!(input.delayDays > 0)) missing.push("delayDays");
  if (missing.length > 0) return fail("hudson", formula, missing);

  const daily = (input.hoProfitPercent! / 100) * (input.contractSum! / input.contractPeriodDays!);
  const amount = daily * input.delayDays;
  return {
    ok: true,
    method: "hudson",
    amount: round2(amount),
    formula,
    workings:
      `(${input.hoProfitPercent}% ÷ 100) × (${money(input.contractSum!)} ÷ ${input.contractPeriodDays} days) = ` +
      `${money(daily)}/day × ${input.delayDays} days = ${money(amount)}`,
    assumptions: [
      "The tendered head-office overhead and profit percentage is taken as the rate of loss.",
      "The contractor's head office was kept from earning elsewhere during the delay (the 'lost opportunity' premise).",
      "The Hudson formula recovers what was PRICED, not what was proven lost — respondents routinely attack it on that ground.",
    ],
    missing: [],
  };
}

export interface EmdenInput {
  contractSum: number | null;
  contractPeriodDays: number | null;
  /** actual head office overhead % derived from audited accounts */
  actualOverheadPercent: number | null;
  delayDays: number;
  accountsPeriod?: string | null;
}

export function emden(input: EmdenInput): QuantumResult {
  const formula = "(actual HO% ÷ 100) × (contract sum ÷ contract period in days) × delay days";
  const missing: string[] = [];
  if (input.contractSum === null || input.contractSum <= 0) missing.push("contractSum");
  if (input.contractPeriodDays === null || input.contractPeriodDays <= 0) missing.push("contractPeriodDays");
  if (input.actualOverheadPercent === null || input.actualOverheadPercent <= 0) missing.push("actualOverheadPercent");
  if (!(input.delayDays > 0)) missing.push("delayDays");
  if (missing.length > 0) return fail("emden", formula, missing);

  const daily = (input.actualOverheadPercent! / 100) * (input.contractSum! / input.contractPeriodDays!);
  const amount = daily * input.delayDays;
  return {
    ok: true,
    method: "emden",
    amount: round2(amount),
    formula,
    workings:
      `(${input.actualOverheadPercent}% ÷ 100) × (${money(input.contractSum!)} ÷ ${input.contractPeriodDays} days) = ` +
      `${money(daily)}/day × ${input.delayDays} days = ${money(amount)}`,
    assumptions: [
      `The overhead percentage is the contractor's actual rate${input.accountsPeriod ? ` from the ${input.accountsPeriod} accounts` : " from its audited accounts"}.`,
      "The contractor's head office resources were unavailable for other work during the delay.",
    ],
    missing: [],
  };
}

export interface EichleayInput {
  /** billings on THIS contract over the performance period */
  contractBillings: number | null;
  /** the contractor's total billings over the same period */
  totalBillings: number | null;
  /** total head-office overhead over the same period */
  totalOverhead: number | null;
  /** days of actual contract performance */
  performanceDays: number | null;
  delayDays: number;
}

export function eichleay(input: EichleayInput): QuantumResult {
  const formula =
    "allocable overhead = (contract billings ÷ total billings) × total overhead; " +
    "daily rate = allocable overhead ÷ days of performance; amount = daily rate × delay days";
  const missing: string[] = [];
  if (input.contractBillings === null || input.contractBillings <= 0) missing.push("contractBillings");
  if (input.totalBillings === null || input.totalBillings <= 0) missing.push("totalBillings");
  if (input.totalOverhead === null || input.totalOverhead <= 0) missing.push("totalOverhead");
  if (input.performanceDays === null || input.performanceDays <= 0) missing.push("performanceDays");
  if (!(input.delayDays > 0)) missing.push("delayDays");
  if (missing.length > 0) return fail("eichleay", formula, missing);
  if (input.contractBillings! > input.totalBillings!) {
    return fail("eichleay", formula, ["contractBillings exceeds totalBillings — one of the two is wrong"]);
  }

  const allocable = (input.contractBillings! / input.totalBillings!) * input.totalOverhead!;
  const daily = allocable / input.performanceDays!;
  const amount = daily * input.delayDays;
  return {
    ok: true,
    method: "eichleay",
    amount: round2(amount),
    formula,
    workings:
      `(${money(input.contractBillings!)} ÷ ${money(input.totalBillings!)}) × ${money(input.totalOverhead!)} = ` +
      `${money(allocable)} allocable; ÷ ${input.performanceDays} days = ${money(daily)}/day × ${input.delayDays} days = ${money(amount)}`,
    assumptions: [
      "There was a government/employer-caused suspension or delay of uncertain duration.",
      "The contractor was on standby and unable to take on replacement work during the delay.",
      "Overhead is absorbed evenly across the performance period.",
    ],
    missing: [],
  };
}

/* ------------------------------------------------------------------ */
/* Site overhead (time-related preliminaries)                          */
/* ------------------------------------------------------------------ */

export interface SiteOverheadInput {
  /** total value of time-related preliminaries */
  prelimsTimeTotal: number | null;
  /** programme days the time-related prelims were priced over */
  programmeDays: number | null;
  /** explicit daily rate, which wins over the derivation */
  ratePerDay?: number | null;
  /** fixed prelims attributable to the extended period, if any */
  fixedPrelimsAttributable?: number | null;
  delayDays: number;
}

export function siteOverhead(input: SiteOverheadInput): QuantumResult {
  const formula = "time-related preliminaries ÷ programme days × delay days (+ attributable fixed preliminaries)";
  if (!(input.delayDays > 0)) return fail("site_overhead", formula, ["delayDays"]);
  let rate = input.ratePerDay ?? null;
  let derivation = "";
  if (rate === null) {
    const missing: string[] = [];
    if (input.prelimsTimeTotal === null || input.prelimsTimeTotal <= 0) missing.push("prelimsTimeTotal");
    if (input.programmeDays === null || input.programmeDays <= 0) missing.push("programmeDays");
    if (missing.length > 0) return fail("site_overhead", formula, missing);
    rate = input.prelimsTimeTotal! / input.programmeDays!;
    derivation = `${money(input.prelimsTimeTotal!)} ÷ ${input.programmeDays} days = ${money(rate)}/day; `;
  } else {
    derivation = `rate supplied: ${money(rate)}/day; `;
  }
  const fixed = input.fixedPrelimsAttributable ?? 0;
  const amount = rate * input.delayDays + fixed;
  return {
    ok: true,
    method: "site_overhead",
    amount: round2(amount),
    formula,
    workings:
      `${derivation}${money(rate)} × ${input.delayDays} days${fixed > 0 ? ` + ${money(fixed)} fixed` : ""} = ${money(amount)}`,
    assumptions: [
      "Time-related preliminaries are absorbed evenly over the programme.",
      "The delay extended the period over which those resources were held on site.",
      ...(fixed > 0 ? ["The fixed preliminaries included were shown to be attributable to the extended period."] : []),
    ],
    missing: [],
  };
}

/* ------------------------------------------------------------------ */
/* Finance charges                                                     */
/* ------------------------------------------------------------------ */

export interface FinanceChargeInput {
  principal: number | null;
  /** annual rate as a percentage, e.g. 8.5 */
  annualRatePercent: number | null;
  days: number;
  basis: InterestBasis;
  rateSource?: string | null;
}

export function financeCharge(input: FinanceChargeInput): QuantumResult {
  const formula =
    input.basis === "compound"
      ? "principal × ((1 + rate/365)^days − 1)"
      : "principal × rate × days ÷ 365";
  const missing: string[] = [];
  if (input.principal === null || input.principal <= 0) missing.push("principal");
  if (input.annualRatePercent === null || input.annualRatePercent <= 0) missing.push("annualRatePercent");
  if (!(input.days > 0)) missing.push("days");
  if (missing.length > 0) return fail("finance_charge", formula, missing);

  const r = input.annualRatePercent! / 100;
  const amount =
    input.basis === "compound"
      ? input.principal! * ((1 + r / 365) ** input.days - 1)
      : (input.principal! * r * input.days) / 365;
  return {
    ok: true,
    method: "finance_charge",
    amount: round2(amount),
    formula,
    workings:
      input.basis === "compound"
        ? `${money(input.principal!)} × ((1 + ${r}/365)^${input.days} − 1) = ${money(amount)}`
        : `${money(input.principal!)} × ${r} × ${input.days} ÷ 365 = ${money(amount)}`,
    assumptions: [
      `Interest is calculated on a ${input.basis} basis at ${input.annualRatePercent}% per annum${input.rateSource ? ` (${input.rateSource})` : ""}.`,
      "The principal was actually financed for the whole period claimed.",
    ],
    missing: [],
  };
}

/* ------------------------------------------------------------------ */
/* Loss of profit                                                      */
/* ------------------------------------------------------------------ */

export interface LossOfProfitInput {
  /** tendered margin as a percentage */
  marginPercent: number | null;
  /** turnover the delay displaced; or derive from contract sum × delay/period */
  displacedTurnover?: number | null;
  contractSum?: number | null;
  contractPeriodDays?: number | null;
  delayDays: number;
  evidenceOfLostOpportunity?: string | null;
}

export function lossOfProfit(input: LossOfProfitInput): QuantumResult {
  const formula = "tendered margin % × displaced turnover (turnover derived from contract sum × delay ÷ period when not supplied)";
  const missing: string[] = [];
  if (input.marginPercent === null || input.marginPercent <= 0) missing.push("marginPercent");
  if (!(input.delayDays > 0)) missing.push("delayDays");
  let turnover = input.displacedTurnover ?? null;
  let derivation = "";
  if (turnover === null) {
    if (!input.contractSum || input.contractSum <= 0) missing.push("displacedTurnover or contractSum");
    if (!input.contractPeriodDays || input.contractPeriodDays <= 0) missing.push("contractPeriodDays");
    if (missing.length === 0) {
      turnover = (input.contractSum! * input.delayDays) / input.contractPeriodDays!;
      derivation = `${money(input.contractSum!)} × ${input.delayDays} ÷ ${input.contractPeriodDays} = ${money(turnover)} displaced turnover; `;
    }
  } else {
    derivation = `displaced turnover supplied: ${money(turnover)}; `;
  }
  if (missing.length > 0) return fail("loss_of_profit", formula, missing);

  const amount = (input.marginPercent! / 100) * turnover!;
  return {
    ok: true,
    method: "loss_of_profit",
    amount: round2(amount),
    formula,
    workings: `${derivation}${input.marginPercent}% × ${money(turnover!)} = ${money(amount)}`,
    assumptions: [
      "The contractor could and would have earned the displaced turnover elsewhere but for the delay.",
      input.evidenceOfLostOpportunity
        ? `Lost opportunity evidenced by: ${input.evidenceOfLostOpportunity}`
        : "No specific lost-opportunity evidence was supplied — this head of claim usually fails without it.",
    ],
    missing: [],
  };
}

/* ------------------------------------------------------------------ */
/* Claim valuation range and provision (#312-313, #320)                */
/* ------------------------------------------------------------------ */

export interface ProvisionInput {
  best: number | null;
  likely: number | null;
  worst: number | null;
  /** 0..1 */
  successProbability: number | null;
}

export interface ProvisionResult {
  ok: boolean;
  provision: number | null;
  /** expected value across the three-point range, when all three are present */
  expectedValue: number | null;
  reasons: string[];
}

/**
 * Provision = likely × probability of success. A three-point range also gives
 * a PERT-style expected value (best + 4×likely + worst) ÷ 6, reported
 * separately so nobody confuses the accounting provision with the valuation.
 */
export function computeProvision(input: ProvisionInput): ProvisionResult {
  const reasons: string[] = [];
  if (input.likely === null) reasons.push("No likely valuation has been recorded — no provision can be computed");
  if (input.successProbability === null) {
    reasons.push("No probability of success has been recorded — no provision can be computed");
  }
  if (
    input.best !== null &&
    input.worst !== null &&
    input.likely !== null &&
    (input.likely < input.best || input.likely > input.worst)
  ) {
    reasons.push("The likely valuation lies outside the best-worst range");
  }
  const expectedValue =
    input.best !== null && input.likely !== null && input.worst !== null
      ? round2((input.best + 4 * input.likely + input.worst) / 6)
      : null;
  if (expectedValue === null) reasons.push("A three-point range is needed for an expected value");
  const provision =
    input.likely !== null && input.successProbability !== null
      ? round2(input.likely * Math.min(1, Math.max(0, input.successProbability)))
      : null;
  return { ok: provision !== null, provision, expectedValue, reasons };
}
