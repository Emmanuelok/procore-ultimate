/**
 * Settlement scenario modelling (spec Vol II Domain E #352): pure
 * expected-value arithmetic so the recommendation is unit-testable without a
 * database. The model is deliberately simple — a single win probability over
 * a single expected award, less irrecoverable legal costs — and does not
 * attempt costs-shifting (Part 36 consequences, #351) or discounting.
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
}

export interface SettlementAnalysis {
  winProbability: number;
  expectedAward: number;
  legalCosts: number;
  /** winProbability × expectedAward − legalCosts */
  expectedValueOfProceeding: number;
  /** highest-value open offer RECEIVED from the counterparty, if any */
  bestOpenOffer: OfferForAnalysis | null;
  recommendation: "settle" | "proceed";
  rationale: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Expected value of proceeding vs the best open received offer. A rational
 * claimant settles when a bird in the hand is worth at least the
 * probability-weighted bird in the bush net of costs.
 */
export function analyseSettlement(
  inputs: SettlementInputs,
  offers: OfferForAnalysis[],
): SettlementAnalysis {
  const expectedValueOfProceeding = round2(
    inputs.winProbability * inputs.expectedAward - inputs.legalCosts,
  );
  const openReceived = offers.filter((o) => o.direction === "received" && o.status === "open");
  const bestOpenOffer =
    openReceived.length === 0
      ? null
      : openReceived.reduce((best, o) => (o.amount > best.amount ? o : best));

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
      `No open received offer is on the table; expected value of proceeding is ` +
      `${expectedValueOfProceeding} (= ${inputs.winProbability} × ${inputs.expectedAward} − ` +
      `${inputs.legalCosts}).`;
  }
  return {
    winProbability: inputs.winProbability,
    expectedAward: inputs.expectedAward,
    legalCosts: inputs.legalCosts,
    expectedValueOfProceeding,
    bestOpenOffer,
    recommendation,
    rationale,
  };
}
