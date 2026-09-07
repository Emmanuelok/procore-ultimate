/**
 * Settlement modelling (spec Vol II Domain E #351-355).
 *
 * TWO MODELS, DELIBERATELY
 *
 *  1. `analyseSettlement` — the single-probability view. One win
 *     probability over one expected award, less irrecoverable costs,
 *     compared with the best open offer received. Fast, understandable, and
 *     what a commercial manager wants on a Tuesday.
 *
 *  2. `evaluateDecisionTree` — the real model (#351-353). Multiple outcome
 *     branches each with its own probability and award, per-stage
 *     irrecoverable costs, discounting to present value, and Part 36 /
 *     Calderbank costs consequences when an offer is beaten. This is what
 *     you take to a board.
 *
 * OFFER HYGIENE
 * An offer that has expired is not on the table. Both models exclude offers
 * past their expiry date, and the route refuses to accept one — an offer
 * received six months ago that lapsed after 21 days is not a price the
 * counterparty is still willing to pay.
 *
 * CURRENCY
 * A USD 400,000 offer does not beat a GBP 350,000 expected value. Offers in
 * a currency other than the dispute's are excluded from the comparison and
 * reported separately, never converted — there is no exchange rate on this
 * platform.
 */

export interface SettlementInputs {
  /** probability of prevailing, 0..1 */
  winProbability: number;
  /** award expected if the claim succeeds */
  expectedAward: number;
  /** irrecoverable legal costs of proceeding */
  legalCosts: number;
}

export interface OfferForAnalysis {
  id: string;
  direction: string; // made | received
  status: string; // open | accepted | rejected | lapsed | withdrawn
  amount: number;
  currency: string;
  basis: string;
  offeredAt: string;
  /** ISO date after which the offer is no longer on the table */
  expiresAt?: string | null;
}

export interface AnalysisOptions {
  /** ISO date the analysis is performed as at; defaults to the caller's today */
  today?: string;
  /** the dispute's currency — offers in another currency are excluded */
  disputeCurrency?: string;
}

export interface SettlementAnalysis {
  winProbability: number;
  expectedAward: number;
  legalCosts: number;
  /** winProbability × expectedAward − legalCosts */
  expectedValueOfProceeding: number;
  /** highest-value LIVE offer received from the counterparty, if any */
  bestOpenOffer: OfferForAnalysis | null;
  /** offers excluded because they had expired by the analysis date */
  expiredOffers: OfferForAnalysis[];
  /** offers excluded because they are denominated in another currency */
  otherCurrencyOffers: OfferForAnalysis[];
  recommendation: "settle" | "proceed";
  rationale: string;
  /** warnings the UI must surface next to the recommendation */
  caveats: string[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Is an offer still capable of being accepted on the given date? */
export function isOfferLive(offer: OfferForAnalysis, today: string): boolean {
  if (offer.status !== "open") return false;
  if (offer.expiresAt && offer.expiresAt < today) return false;
  return true;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Expected value of proceeding vs the best LIVE offer received. A rational
 * claimant settles when a bird in the hand is worth at least the
 * probability-weighted bird in the bush net of costs.
 */
export function analyseSettlement(
  inputs: SettlementInputs,
  offers: OfferForAnalysis[],
  options: AnalysisOptions = {},
): SettlementAnalysis {
  const today = options.today ?? todayIso();
  const expectedValueOfProceeding = round2(
    inputs.winProbability * inputs.expectedAward - inputs.legalCosts,
  );
  const received = offers.filter((o) => o.direction === "received" && o.status === "open");
  const expiredOffers = received.filter((o) => Boolean(o.expiresAt) && o.expiresAt! < today);
  const unexpired = received.filter((o) => !expiredOffers.includes(o));
  const otherCurrencyOffers = options.disputeCurrency
    ? unexpired.filter((o) => o.currency !== options.disputeCurrency)
    : [];
  const comparable = unexpired.filter((o) => !otherCurrencyOffers.includes(o));

  const bestOpenOffer =
    comparable.length === 0
      ? null
      : comparable.reduce((best, o) => (o.amount > best.amount ? o : best));

  const caveats: string[] = [];
  if (expiredOffers.length > 0) {
    caveats.push(
      `${expiredOffers.length} received offer(s) had expired by ${today} and are excluded — an ` +
        `expired offer is not a price the counterparty is still willing to pay.`,
    );
  }
  if (otherCurrencyOffers.length > 0) {
    caveats.push(
      `${otherCurrencyOffers.length} received offer(s) are denominated in ` +
        `${[...new Set(otherCurrencyOffers.map((o) => o.currency))].join(", ")}, not the dispute's ` +
        `${options.disputeCurrency}. They are excluded rather than converted — there is no exchange ` +
        `rate on this platform.`,
    );
  }

  let recommendation: "settle" | "proceed";
  let rationale: string;
  if (bestOpenOffer && bestOpenOffer.amount >= expectedValueOfProceeding) {
    recommendation = "settle";
    rationale =
      `Best open offer ${bestOpenOffer.currency} ${bestOpenOffer.amount} meets or beats the ` +
      `expected value of proceeding (${expectedValueOfProceeding} = ` +
      `${inputs.winProbability} × ${inputs.expectedAward} − ${inputs.legalCosts}).`;
  } else if (bestOpenOffer) {
    recommendation = "proceed";
    rationale =
      `Expected value of proceeding (${expectedValueOfProceeding} = ` +
      `${inputs.winProbability} × ${inputs.expectedAward} − ${inputs.legalCosts}) exceeds the ` +
      `best open offer ${bestOpenOffer.currency} ${bestOpenOffer.amount}.`;
  } else {
    recommendation = "proceed";
    rationale =
      `No live received offer is on the table; expected value of proceeding is ` +
      `${expectedValueOfProceeding} (= ${inputs.winProbability} × ${inputs.expectedAward} − ` +
      `${inputs.legalCosts}).`;
  }
  return {
    winProbability: inputs.winProbability,
    expectedAward: inputs.expectedAward,
    legalCosts: inputs.legalCosts,
    expectedValueOfProceeding,
    bestOpenOffer,
    expiredOffers,
    otherCurrencyOffers,
    recommendation,
    rationale,
    caveats,
  };
}

/* ================================================================== */
/* Decision tree (#351-353)                                            */
/* ================================================================== */

export interface TreeBranch {
  id: string;
  kind: string; // SettlementBranchKind
  label: string;
  /** 0..1; the branch set must sum to 1 within tolerance */
  probability: number;
  /** amount recovered (positive) or paid away (negative) on this branch */
  award: number;
}

export interface TreeStage {
  id: string;
  name: string;
  /** own irrecoverable costs incurred to get through this stage */
  ownCosts: number;
  /** the other side's costs, exposure to which arises only if you lose */
  opponentCosts: number;
}

export interface CostsRules {
  /** Part 36 / Calderbank consequences apply */
  enabled: boolean;
  /**
   * Uplift applied to own costs recovered when a claimant beats its own
   * offer — indemnity-basis costs. Expressed as a % ON TOP of standard.
   */
  indemnityCostsPercent: number;
  /** Enhanced interest on the award, % p.a. */
  enhancedInterestPercent: number;
  /** the claimant's own offer that the outcome is measured against */
  ownOfferAmount: number | null;
}

export interface DecisionTreeInputs {
  branches: TreeBranch[];
  stages: TreeStage[];
  discountRatePercent: number;
  yearsToResolution: number;
  costsRules?: CostsRules | null;
  currency: string;
}

export interface BranchOutcome {
  id: string;
  kind: string;
  label: string;
  probability: number;
  award: number;
  ownCosts: number;
  /** opponent costs payable on this branch (loss branches only) */
  opponentCostsPayable: number;
  /** Part 36 uplift earned on this branch, if any */
  costsUplift: number;
  enhancedInterest: number;
  /** award − ownCosts − opponentCostsPayable + uplift + interest */
  netOutcome: number;
  /** netOutcome discounted to present value */
  presentValue: number;
  weightedPresentValue: number;
}

export interface DecisionTreeResult {
  currency: string;
  branches: BranchOutcome[];
  /** Σ probability × present value */
  expectedValue: number;
  totalOwnCosts: number;
  totalOpponentCosts: number;
  probabilitySum: number;
  valid: boolean;
  /** best live offer received, when one was supplied for comparison */
  bestOffer: OfferForAnalysis | null;
  recommendation: "settle" | "proceed" | "insufficient_model";
  rationale: string;
  caveats: string[];
  basis: string;
}

const PROBABILITY_TOLERANCE = 1e-6;

/**
 * Evaluate a decision tree to a probability-weighted present value, and
 * compare it with the best live offer.
 *
 * Costs treatment: own costs are incurred on every branch (you pay your
 * lawyers whether you win or lose). Opponent costs land only on losing
 * branches — the loser pays. Part 36 consequences apply on branches where
 * the award beats the claimant's own offer: indemnity uplift on own costs
 * plus enhanced interest on the award.
 *
 * A branch set whose probabilities do not sum to 1 is reported as invalid
 * with the sum, and no recommendation is made — a tree that does not close
 * is not a model.
 */
export function evaluateDecisionTree(
  inputs: DecisionTreeInputs,
  offers: OfferForAnalysis[] = [],
  options: AnalysisOptions = {},
): DecisionTreeResult {
  const today = options.today ?? todayIso();
  const totalOwnCosts = round2(inputs.stages.reduce((s, st) => s + st.ownCosts, 0));
  const totalOpponentCosts = round2(inputs.stages.reduce((s, st) => s + st.opponentCosts, 0));
  const probabilitySum = round2(inputs.branches.reduce((s, b) => s + b.probability, 0) * 100) / 100;
  const valid =
    inputs.branches.length > 0 && Math.abs(probabilitySum - 1) <= 0.005 + PROBABILITY_TOLERANCE;

  const rules = inputs.costsRules;
  const discount = (1 + inputs.discountRatePercent / 100) ** -Math.max(0, inputs.yearsToResolution);

  const branches: BranchOutcome[] = inputs.branches.map((b) => {
    const isLoss = b.kind === "lose" || b.award <= 0;
    const opponentCostsPayable = isLoss ? totalOpponentCosts : 0;
    let costsUplift = 0;
    let enhancedInterest = 0;
    if (rules?.enabled && rules.ownOfferAmount !== null && b.award > rules.ownOfferAmount) {
      costsUplift = round2(totalOwnCosts * (rules.indemnityCostsPercent / 100));
      enhancedInterest = round2(
        b.award * (rules.enhancedInterestPercent / 100) * Math.max(0, inputs.yearsToResolution),
      );
    }
    const netOutcome = round2(
      b.award - totalOwnCosts - opponentCostsPayable + costsUplift + enhancedInterest,
    );
    const presentValue = round2(netOutcome * discount);
    return {
      id: b.id,
      kind: b.kind,
      label: b.label,
      probability: b.probability,
      award: round2(b.award),
      ownCosts: totalOwnCosts,
      opponentCostsPayable,
      costsUplift,
      enhancedInterest,
      netOutcome,
      presentValue,
      weightedPresentValue: round2(presentValue * b.probability),
    };
  });

  const expectedValue = round2(branches.reduce((s, b) => s + b.weightedPresentValue, 0));

  const received = offers.filter((o) => o.direction === "received" && isOfferLive(o, today));
  const comparable = options.disputeCurrency
    ? received.filter((o) => o.currency === options.disputeCurrency)
    : received;
  const bestOffer =
    comparable.length === 0 ? null : comparable.reduce((best, o) => (o.amount > best.amount ? o : best));

  const caveats: string[] = [];
  if (!valid) {
    caveats.push(
      `Branch probabilities sum to ${probabilitySum}, not 1. The tree does not close, so no ` +
        `expected value can be relied on.`,
    );
  }
  const expired = offers.filter(
    (o) => o.direction === "received" && o.status === "open" && !isOfferLive(o, today),
  );
  if (expired.length > 0) {
    caveats.push(`${expired.length} received offer(s) had expired by ${today} and are excluded.`);
  }
  if (options.disputeCurrency && received.length !== comparable.length) {
    caveats.push(
      `${received.length - comparable.length} live offer(s) are in another currency and are ` +
        `excluded rather than converted.`,
    );
  }

  let recommendation: DecisionTreeResult["recommendation"];
  let rationale: string;
  if (!valid) {
    recommendation = "insufficient_model";
    rationale = "The branch probabilities do not sum to 1; complete the tree before relying on it.";
  } else if (bestOffer && bestOffer.amount >= expectedValue) {
    recommendation = "settle";
    rationale =
      `The best live offer of ${bestOffer.currency} ${bestOffer.amount} beats the tree's ` +
      `probability-weighted present value of ${inputs.currency} ${expectedValue}.`;
  } else if (bestOffer) {
    recommendation = "proceed";
    rationale =
      `The tree's probability-weighted present value of ${inputs.currency} ${expectedValue} exceeds ` +
      `the best live offer of ${bestOffer.currency} ${bestOffer.amount}.`;
  } else {
    recommendation = "proceed";
    rationale =
      `No live received offer is on the table. The tree's probability-weighted present value is ` +
      `${inputs.currency} ${expectedValue}.`;
  }

  return {
    currency: inputs.currency,
    branches,
    expectedValue,
    totalOwnCosts,
    totalOpponentCosts,
    probabilitySum,
    valid,
    bestOffer,
    recommendation,
    rationale,
    caveats,
    basis:
      `Own costs (${totalOwnCosts}) are incurred on every branch; opponent costs ` +
      `(${totalOpponentCosts}) land only on losing branches. ` +
      (rules?.enabled
        ? `Part 36 / Calderbank consequences apply where the award beats the claimant's own offer of ` +
          `${rules.ownOfferAmount}: ${rules.indemnityCostsPercent}% indemnity uplift on own costs and ` +
          `${rules.enhancedInterestPercent}% p.a. enhanced interest. `
        : "No costs-shifting consequences are modelled. ") +
      `Outcomes are discounted to present value at ${inputs.discountRatePercent}% over ` +
      `${inputs.yearsToResolution} year(s). Correlation between branches and the timing of costs ` +
      `within the case are not modelled.`,
  };
}

/* ================================================================== */
/* Litigation provision (#355)                                         */
/* ================================================================== */

export interface LitigationProvision {
  /** probability-weighted NEGATIVE outcome — what to hold on the balance sheet */
  provision: number | null;
  currency: string;
  /** probability-weighted positive outcome — a contingent asset, not a provision */
  contingentAsset: number | null;
  basis: string;
  unavailableReason: string | null;
}

/**
 * The provision figure a finance function needs (#355): the
 * probability-weighted value of the branches on which money goes OUT.
 * Positive outcomes are reported separately as a contingent asset because
 * accounting standards do not permit netting one against the other.
 */
export function litigationProvision(tree: DecisionTreeResult): LitigationProvision {
  if (!tree.valid) {
    return {
      provision: null,
      currency: tree.currency,
      contingentAsset: null,
      basis: "",
      unavailableReason:
        "The decision tree does not close (branch probabilities do not sum to 1), so no provision can be derived from it.",
    };
  }
  const outflow = tree.branches
    .filter((b) => b.presentValue < 0)
    .reduce((s, b) => s + b.weightedPresentValue, 0);
  const inflow = tree.branches
    .filter((b) => b.presentValue > 0)
    .reduce((s, b) => s + b.weightedPresentValue, 0);
  return {
    provision: round2(Math.abs(outflow)),
    currency: tree.currency,
    contingentAsset: round2(inflow),
    basis:
      `Probability-weighted present value of the branches on which money leaves the business ` +
      `(${tree.branches.filter((b) => b.presentValue < 0).length} of ${tree.branches.length} branches). ` +
      `Favourable branches are reported separately as a contingent asset and are NOT netted off — ` +
      `a provision and a contingent asset are different things.`,
    unavailableReason: null,
  };
}
