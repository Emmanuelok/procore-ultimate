/**
 * Replacement-cost verification engine (#550, IFC PS5 para 27 + footnote 22;
 * World Bank ESS5 para 12).
 *
 * WHAT "FULL REPLACEMENT COST" MEANS, AND WHY IT NEEDS AN ENGINE
 *
 * The most common adverse finding on a lender supervision mission is not
 * fraud — it is that the project paid the *government compensation schedule*
 * rate. Those schedules are almost always depreciated (a 20-year-old house is
 * valued as a 20-year-old house) and almost always exclude the transaction
 * costs the household has to bear to actually replace the asset: transfer
 * duty, registration, surveying, moving. Full replacement cost is defined the
 * other way round:
 *
 *     replacement cost = market value of an EQUIVALENT NEW asset
 *                      + transaction costs
 *                      (with NO deduction for depreciation)
 *
 * So a study records the market survey figure, records separately what
 * depreciation a schedule would have deducted (which is the size of the
 * finding, not an input to the answer), adds the transaction costs, and
 * compares the result with what was actually offered.
 *
 * Everything here is pure arithmetic over numbers the caller has already
 * validated. It does NOT decide whether a household is entitled — that is the
 * entitlement matrix — and it does not convert currencies: a study and the
 * compensation it tests must be struck in the same currency, and the route
 * refuses the comparison when they are not.
 */

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export type ReplacementVerdictValue = "adequate" | "shortfall" | "unverified";

export interface ReplacementInput {
  /** surveyed market value of an equivalent asset, undepreciated */
  marketValue: number;
  /** what a depreciated government schedule would have knocked off */
  depreciationDeducted?: number | null;
  /** duty, registration, survey, moving — costs the household must bear */
  transactionCosts?: number | null;
  /** what the project offered or paid; null when not yet determined */
  compensationOffered?: number | null;
}

export interface ReplacementResult {
  replacementCost: number;
  /** replacementCost − compensationOffered; positive = under-compensated */
  shortfall: number | null;
  shortfallPercent: number | null;
  verdict: ReplacementVerdictValue;
  /** the sentence that goes on the finding */
  basis: string;
}

/**
 * Tolerance for "adequate". A shortfall of a currency unit or two is rounding
 * in the valuer's spreadsheet, not under-compensation; anything above it is a
 * real gap the household bears.
 */
export const REPLACEMENT_TOLERANCE = 1;

export function computeReplacementCost(input: ReplacementInput): ReplacementResult {
  const market = input.marketValue;
  const depreciation = input.depreciationDeducted ?? 0;
  const transaction = input.transactionCosts ?? 0;
  // Deliberately NOT `market - depreciation`: the whole point of PS5 para 27
  // is that depreciation is not deducted. The field is carried so the gap
  // against a schedule rate is visible, not so it is applied.
  const replacementCost = round2(market + transaction);

  if (input.compensationOffered == null) {
    return {
      replacementCost,
      shortfall: null,
      shortfallPercent: null,
      verdict: "unverified",
      basis:
        `Full replacement cost ${replacementCost} = market value ${round2(market)} ` +
        `+ transaction costs ${round2(transaction)}, with no deduction for depreciation ` +
        `(IFC PS5 para 27). No compensation figure has been recorded against it yet, so ` +
        `adequacy is unverified.`,
    };
  }

  const offered = input.compensationOffered;
  const shortfall = round2(replacementCost - offered);
  const shortfallPercent = replacementCost > 0 ? round2((shortfall / replacementCost) * 100) : null;
  const adequate = shortfall <= REPLACEMENT_TOLERANCE;
  return {
    replacementCost,
    shortfall,
    shortfallPercent,
    verdict: adequate ? "adequate" : "shortfall",
    basis: adequate
      ? `Compensation ${round2(offered)} meets full replacement cost ${replacementCost} ` +
        `(market value ${round2(market)} + transaction costs ${round2(transaction)}, no ` +
        `depreciation deducted).`
      : `Compensation ${round2(offered)} is ${shortfall} below full replacement cost ` +
        `${replacementCost} (${shortfallPercent}%). Replacement cost is market value ` +
        `${round2(market)} plus transaction costs ${round2(transaction)} with NO deduction for ` +
        `depreciation` +
        (depreciation > 0
          ? `; a depreciated schedule would have deducted ${round2(depreciation)}, which is ` +
            `precisely the deduction IFC PS5 para 27 does not permit.`
          : `.`),
  };
}

/** Portfolio view over a set of studies, for the RAP dashboard. */
export interface ReplacementPortfolio {
  studies: number;
  verified: number;
  adequate: number;
  shortfall: number;
  unverified: number;
  /** summed only within one currency — never across */
  totalReplacementCost: number;
  totalCompensationOffered: number;
  totalShortfall: number;
  /** null when nothing has been verified: an unknowable, not zero */
  adequateSharePercent: number | null;
}

export function summariseReplacement(
  rows: readonly {
    verdict: string;
    replacementCost: number;
    compensationOffered: number | null;
    shortfall: number | null;
  }[],
): ReplacementPortfolio {
  const adequate = rows.filter((r) => r.verdict === "adequate").length;
  const shortfall = rows.filter((r) => r.verdict === "shortfall").length;
  const unverified = rows.filter((r) => r.verdict === "unverified").length;
  const verified = adequate + shortfall;
  return {
    studies: rows.length,
    verified,
    adequate,
    shortfall,
    unverified,
    totalReplacementCost: round2(rows.reduce((s, r) => s + r.replacementCost, 0)),
    totalCompensationOffered: round2(
      rows.reduce((s, r) => s + (r.compensationOffered ?? 0), 0),
    ),
    totalShortfall: round2(
      rows.reduce((s, r) => s + Math.max(0, r.shortfall ?? 0), 0),
    ),
    adequateSharePercent: verified > 0 ? round2((adequate / verified) * 100) : null,
  };
}
