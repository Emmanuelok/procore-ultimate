/**
 * Open-book cost verification arithmetic.
 * Spec Vol II Domain Z #1063 (open book cost verification and audit), #1064
 * (cost reimbursable audit rights execution), #1065 (defined cost
 * verification against the Schedule of Cost Components), #1066 (disallowed
 * cost register).
 *
 * Pure and deterministic. It aggregates the verifier's item-by-item verdicts
 * into the numbers that go on the verification header and into the register
 * views, and it computes the sampling extrapolation an auditor is entitled to
 * state — and no more.
 *
 * Two rules shape it:
 *  · An item in a currency other than the verification's is EXCLUDED and
 *    counted, never converted.
 *  · An extrapolation from a sample is only offered when the sample size and
 *    population are both recorded. Without them the answer is "not
 *    extrapolable", with the reason — an auditor's number that cannot be
 *    defended is worse than no number.
 *
 * What it deliberately does NOT do: decide whether a cost IS disallowable.
 * That is a contractual judgement a person makes and records with a ground.
 */

import type { DefinedCostComponent, DefinedCostVerdict } from "@constructos/shared";

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface DefinedCostItemRow {
  id: string;
  component: string;
  currency: string;
  claimedAmount: number;
  verifiedAmount: number;
  verdict: string;
  evidenceRef: string | null;
  evidenceId: string | null;
}

export interface ComponentAggregate {
  component: string;
  items: number;
  claimed: number;
  verified: number;
  queried: number;
  disallowed: number;
  pending: number;
  /** verified ÷ claimed, as a percentage; null when nothing was claimed */
  verificationRatePercent: number | null;
  itemsWithoutEvidence: number;
}

export interface VerificationTotals {
  currency: string;
  claimed: number;
  verified: number;
  queried: number;
  disallowed: number;
  pending: number;
  itemCount: number;
  itemsWithoutEvidence: number;
  currencyMismatches: number;
  /** verified ÷ claimed over every item tested */
  verificationRatePercent: number | null;
  /** disallowed ÷ claimed over every item tested */
  disallowanceRatePercent: number | null;
  byComponent: ComponentAggregate[];
  reasons: string[];
}

/**
 * The verdict decides where a claimed amount lands. `partially_disallowed`
 * splits: what was verified is verified, the balance is disallowed. That is
 * the only verdict that produces two numbers from one item, and it is why
 * `verifiedAmount` is a column rather than being inferred from the verdict.
 */
function classify(item: DefinedCostItemRow): {
  verified: number;
  queried: number;
  disallowed: number;
  pending: number;
} {
  const claimed = item.claimedAmount;
  const verified = item.verifiedAmount;
  switch (item.verdict as DefinedCostVerdict) {
    case "verified":
      return { verified: verified || claimed, queried: 0, disallowed: 0, pending: 0 };
    case "queried":
      return { verified: 0, queried: claimed, disallowed: 0, pending: 0 };
    case "disallowed":
      return { verified: 0, queried: 0, disallowed: claimed, pending: 0 };
    case "partially_disallowed":
      return {
        verified,
        queried: 0,
        disallowed: Math.max(0, round2(claimed - verified)),
        pending: 0,
      };
    case "pending":
    default:
      return { verified: 0, queried: 0, disallowed: 0, pending: claimed };
  }
}

/** Aggregate a verification's items into header totals and a per-component table. */
export function verificationTotals(
  items: DefinedCostItemRow[],
  currency: string,
): VerificationTotals {
  const reasons: string[] = [];
  const same = items.filter((i) => i.currency === currency);
  const mismatches = items.length - same.length;
  if (mismatches > 0) {
    reasons.push(
      `${mismatches} item(s) are in a currency other than the verification's (${currency}) and are excluded from every total.`,
    );
  }

  const byComponent = new Map<string, ComponentAggregate>();
  let claimed = 0;
  let verified = 0;
  let queried = 0;
  let disallowed = 0;
  let pending = 0;
  let withoutEvidence = 0;

  for (const item of same) {
    const split = classify(item);
    claimed += item.claimedAmount;
    verified += split.verified;
    queried += split.queried;
    disallowed += split.disallowed;
    pending += split.pending;
    const noEvidence = !item.evidenceRef && !item.evidenceId;
    if (noEvidence) withoutEvidence += 1;

    let acc = byComponent.get(item.component);
    if (!acc) {
      acc = {
        component: item.component,
        items: 0,
        claimed: 0,
        verified: 0,
        queried: 0,
        disallowed: 0,
        pending: 0,
        verificationRatePercent: null,
        itemsWithoutEvidence: 0,
      };
      byComponent.set(item.component, acc);
    }
    acc.items += 1;
    acc.claimed += item.claimedAmount;
    acc.verified += split.verified;
    acc.queried += split.queried;
    acc.disallowed += split.disallowed;
    acc.pending += split.pending;
    if (noEvidence) acc.itemsWithoutEvidence += 1;
  }

  if (withoutEvidence > 0) {
    reasons.push(
      `${withoutEvidence} item(s) carry no evidence reference; a verified cost with no evidence behind it is an assertion, not a verification.`,
    );
  }

  const components = [...byComponent.values()]
    .map((c) => ({
      ...c,
      claimed: round2(c.claimed),
      verified: round2(c.verified),
      queried: round2(c.queried),
      disallowed: round2(c.disallowed),
      pending: round2(c.pending),
      verificationRatePercent: c.claimed > 0 ? round2((c.verified / c.claimed) * 100) : null,
    }))
    .sort((a, b) => b.claimed - a.claimed || a.component.localeCompare(b.component));

  return {
    currency,
    claimed: round2(claimed),
    verified: round2(verified),
    queried: round2(queried),
    disallowed: round2(disallowed),
    pending: round2(pending),
    itemCount: same.length,
    itemsWithoutEvidence: withoutEvidence,
    currencyMismatches: mismatches,
    verificationRatePercent: claimed > 0 ? round2((verified / claimed) * 100) : null,
    disallowanceRatePercent: claimed > 0 ? round2((disallowed / claimed) * 100) : null,
    byComponent: components,
    reasons,
  };
}

/* ================================================================== */
/* Sampling extrapolation (#1063)                                      */
/* ================================================================== */

export interface SamplingInput {
  basis?: string;
  populationCount?: number;
  populationValue?: number;
  sampleCount?: number;
  confidence?: number;
}

export interface Extrapolation {
  extrapolable: boolean;
  /** disallowance rate observed in the sample, as a percentage */
  observedRatePercent: number | null;
  /** the rate applied to the untested population value */
  projectedDisallowance: number | null;
  /** population value that was not tested */
  untestedValue: number | null;
  coveragePercent: number | null;
  basis: string[];
  reasons: string[];
}

/**
 * Project a sample's disallowance rate onto the untested population. Every
 * assumption is printed: this is a projection, not a finding, and the
 * language must not let anyone forget it.
 */
export function extrapolate(totals: VerificationTotals, sampling: SamplingInput): Extrapolation {
  const reasons: string[] = [];
  const basis: string[] = [];
  const populationValue = sampling.populationValue;
  const populationCount = sampling.populationCount;
  const sampleCount = sampling.sampleCount;

  if (totals.claimed <= 0) {
    reasons.push("Nothing has been tested, so there is no rate to project.");
    return {
      extrapolable: false,
      observedRatePercent: null,
      projectedDisallowance: null,
      untestedValue: null,
      coveragePercent: null,
      basis,
      reasons,
    };
  }
  const observedRate = (totals.disallowed / totals.claimed) * 100;
  basis.push(
    `Observed disallowance rate = ${round2(totals.disallowed)} disallowed ÷ ${round2(totals.claimed)} tested = ${round2(observedRate)}%.`,
  );

  if (typeof populationValue !== "number" || !Number.isFinite(populationValue) || populationValue <= 0) {
    reasons.push(
      "The population value was not recorded on the sampling plan, so the rate cannot be projected beyond the items tested.",
    );
    return {
      extrapolable: false,
      observedRatePercent: round2(observedRate),
      projectedDisallowance: null,
      untestedValue: null,
      coveragePercent: null,
      basis,
      reasons,
    };
  }
  if (populationValue < totals.claimed) {
    reasons.push(
      `The tested value (${round2(totals.claimed)}) exceeds the recorded population value (${round2(populationValue)}); the sampling plan and the items disagree.`,
    );
    return {
      extrapolable: false,
      observedRatePercent: round2(observedRate),
      projectedDisallowance: null,
      untestedValue: null,
      coveragePercent: round2((totals.claimed / populationValue) * 100),
      basis,
      reasons,
    };
  }
  if (
    typeof populationCount === "number" &&
    typeof sampleCount === "number" &&
    populationCount > 0 &&
    sampleCount > 0
  ) {
    basis.push(`Sample covered ${sampleCount} of ${populationCount} item(s) by count.`);
  } else {
    reasons.push("Sample and population counts are not both recorded, so the projection rests on value coverage alone.");
  }

  const untested = round2(populationValue - totals.claimed);
  const projected = round2((observedRate / 100) * untested);
  basis.push(
    `Projection = ${round2(observedRate)}% × untested value ${untested} = ${projected}. This is a projection from a sample, not a finding on the untested items.`,
  );
  if (typeof sampling.confidence === "number" && Number.isFinite(sampling.confidence)) {
    basis.push(`Stated confidence: ${sampling.confidence}%.`);
  } else {
    reasons.push("No confidence level is recorded for the sample.");
  }

  return {
    extrapolable: true,
    observedRatePercent: round2(observedRate),
    projectedDisallowance: projected,
    untestedValue: untested,
    coveragePercent: round2((totals.claimed / populationValue) * 100),
    basis,
    reasons,
  };
}

/* ================================================================== */
/* Disallowed cost register summary (#1066)                            */
/* ================================================================== */

export interface DisallowedRow {
  id: string;
  category: string;
  status: string;
  currency: string;
  amount: number;
  deductedAmount: number;
  raisedAt: string;
  responseDueAt: string | null;
  groundClause: string | null;
}

export interface DisallowedBucket {
  currency: string;
  raised: number;
  accepted: number;
  disputed: number;
  withdrawn: number;
  deducted: number;
  outstanding: number;
  count: number;
}

export interface DisallowedSummary {
  byCurrency: DisallowedBucket[];
  byCategory: Array<{ category: string; count: number; currencies: string[] }>;
  unresolved: number;
  overdueResponses: number;
  withoutGround: number;
  /** age in days of the oldest unresolved disallowance */
  oldestUnresolvedDays: number | null;
  reasons: string[];
}

const RESOLVED_STATUSES = ["accepted", "withdrawn", "deducted"];

function daysBetween(fromISO: string, toISO: string): number {
  const from = Date.parse(`${fromISO.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${toISO.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / 86_400_000);
}

/** Summarise the register. Money is bucketed by currency and never summed across. */
export function disallowedSummary(rows: DisallowedRow[], today: string): DisallowedSummary {
  const reasons: string[] = [];
  const byCurrency = new Map<string, DisallowedBucket>();
  const byCategory = new Map<string, { category: string; count: number; currencies: Set<string> }>();
  let unresolved = 0;
  let overdue = 0;
  let withoutGround = 0;
  let oldest: number | null = null;

  for (const row of rows) {
    let acc = byCurrency.get(row.currency);
    if (!acc) {
      acc = {
        currency: row.currency,
        raised: 0,
        accepted: 0,
        disputed: 0,
        withdrawn: 0,
        deducted: 0,
        outstanding: 0,
        count: 0,
      };
      byCurrency.set(row.currency, acc);
    }
    acc.count += 1;
    acc.raised += row.amount;
    if (row.status === "accepted") acc.accepted += row.amount;
    else if (row.status === "disputed") acc.disputed += row.amount;
    else if (row.status === "withdrawn") acc.withdrawn += row.amount;
    else if (row.status === "deducted") acc.deducted += row.deductedAmount;
    if (!RESOLVED_STATUSES.includes(row.status)) {
      acc.outstanding += row.amount;
      unresolved += 1;
      const age = daysBetween(row.raisedAt, today);
      if (oldest === null || age > oldest) oldest = age;
      if (row.responseDueAt !== null && row.responseDueAt < today) overdue += 1;
    }
    if (!row.groundClause) withoutGround += 1;

    const cat = byCategory.get(row.category) ?? { category: row.category, count: 0, currencies: new Set<string>() };
    cat.count += 1;
    cat.currencies.add(row.currency);
    byCategory.set(row.category, cat);
  }

  if (withoutGround > 0) {
    reasons.push(
      `${withoutGround} disallowance(s) cite no contract clause. A disallowance without a ground is an opinion and will not survive adjudication.`,
    );
  }
  if (byCurrency.size > 1) {
    reasons.push(
      `The register spans ${byCurrency.size} currencies (${[...byCurrency.keys()].sort().join(", ")}); totals are shown per currency and never combined.`,
    );
  }

  return {
    byCurrency: [...byCurrency.values()]
      .map((b) => ({
        currency: b.currency,
        raised: round2(b.raised),
        accepted: round2(b.accepted),
        disputed: round2(b.disputed),
        withdrawn: round2(b.withdrawn),
        deducted: round2(b.deducted),
        outstanding: round2(b.outstanding),
        count: b.count,
      }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    byCategory: [...byCategory.values()]
      .map((c) => ({ category: c.category, count: c.count, currencies: [...c.currencies].sort() }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
    unresolved,
    overdueResponses: overdue,
    withoutGround,
    oldestUnresolvedDays: oldest,
    reasons,
  };
}

/** The SoCC headings, exported so the UI and the tests share one list. */
export function componentLabel(component: DefinedCostComponent | string): string {
  return String(component)
    .split("_")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}
