import type { BidNoBidFactor } from "@constructos/shared";
import { known, round2, round4, unknowable, type Unknowable } from "./shared.js";

/**
 * THE ARITHMETIC OF WINNING WORK.
 *
 * Four questions this file answers, all of them pure, deterministic and
 * separately testable:
 *
 *  1. SHOULD WE BID? (#1048) A weighted factor score, and — separately — a
 *     win probability fitted from what actually happened last time. The two
 *     are deliberately different things: the score is a judgement the bid
 *     team records, the probability is an inference from history. Where
 *     history is too thin to infer anything, the probability is
 *     `{ value: null, reasons }` and NOT the base rate dressed up as a
 *     prediction.
 *
 *  2. WHAT IS OUR WIN RATE, AND AGAINST WHOM? (#1049) By count and by value,
 *     bucketed per currency, because a 60% win rate on £40k jobs and a 10%
 *     win rate on £4m jobs are not one number.
 *
 *  3. WHERE DOES THE MARKET PRICE US? (#1050) Our position in the field, the
 *     spread of the field itself, and how each competitor prices relative to
 *     the median — the only competitor intelligence that is both lawful and
 *     useful.
 *
 *  4. WHAT DID IT COST US TO FIND OUT? (#1051) Cost of sale by outcome, and
 *     the cost of each win.
 *
 * THE HONESTY RULE APPLIES THROUGHOUT. A rate computed from two data points
 * is not a rate. Every function here refuses to produce a figure it cannot
 * support and says what was missing, because a fabricated win probability is
 * worse than no win probability: somebody will bid on it.
 */

/* ================================================================== */
/* 1. Bid / no-bid scoring                                             */
/* ================================================================== */

export interface FactorScore {
  factor: BidNoBidFactor | string;
  /** 0..10, where 10 is "this factor argues strongly for bidding" */
  score: number;
  /** relative importance; zero-weighted factors cannot decide anything */
  weight: number;
  note?: string | null;
}

export interface BidNoBidAssessment {
  /** 0..100 */
  score: Unknowable;
  /** what the score suggests — never what it decides */
  suggested: "bid" | "no_bid" | "marginal" | null;
  weightedFactors: Array<FactorScore & { contribution: number | null; sharePercent: number | null }>;
  strongest: string | null;
  weakest: string | null;
  basis: string;
}

/**
 * A bid/no-bid score. The important property is that it REFUSES to produce a
 * number where the factors carry no weight, and that it names the factor
 * pulling hardest in each direction — because the decision that gets
 * defended six months later is "we bid despite scoring 2/10 on capacity",
 * and that sentence has to exist somewhere.
 */
export function scoreBidNoBid(
  factors: readonly FactorScore[],
  thresholds: { bidAbove: number; noBidBelow: number } = { bidAbove: 65, noBidBelow: 40 },
): BidNoBidAssessment {
  const usable = factors.filter((f) => Number.isFinite(f.score) && Number.isFinite(f.weight));
  const totalWeight = usable.reduce((s, f) => s + Math.max(0, f.weight), 0);
  if (usable.length === 0 || totalWeight <= 0) {
    return {
      score: unknowable<number>(
        factors.length === 0
          ? "No factors were scored, so there is nothing to weigh. A bid/no-bid decision with no " +
            "recorded factors is a hunch, and a hunch cannot be reviewed after the job goes wrong."
          : "Every scored factor carries a weight of zero, so none of them can affect the " +
            "outcome. Weight them, or drop them.",
      ),
      suggested: null,
      weightedFactors: factors.map((f) => ({ ...f, contribution: null, sharePercent: null })),
      strongest: null,
      weakest: null,
      basis:
        "No weighted factors were supplied, so no score was produced. The platform does not " +
        "invent one: a bid/no-bid number with nothing behind it is the most expensive kind of " +
        "false precision there is.",
    };
  }
  const weighted = usable.map((f) => {
    const w = Math.max(0, f.weight);
    return {
      ...f,
      contribution: round4((Math.min(10, Math.max(0, f.score)) / 10) * (w / totalWeight) * 100),
      sharePercent: round2((w / totalWeight) * 100),
    };
  });
  const score = round2(weighted.reduce((s, f) => s + (f.contribution ?? 0), 0));
  const sorted = [...weighted].sort((a, b) => (b.contribution ?? 0) - (a.contribution ?? 0));
  const strongest = sorted[0]?.factor ?? null;
  const weakest = sorted[sorted.length - 1]?.factor ?? null;
  const suggested =
    score >= thresholds.bidAbove ? "bid" : score < thresholds.noBidBelow ? "no_bid" : "marginal";
  return {
    score: known(score),
    suggested,
    weightedFactors: weighted,
    strongest: strongest === undefined ? null : String(strongest),
    weakest: weakest === undefined ? null : String(weakest),
    basis:
      `Weighted score ${score}/100 across ${usable.length} factor(s). ` +
      `The strongest argument for bidding is "${String(strongest)}"; the weakest is ` +
      `"${String(weakest)}". A score at or above ${thresholds.bidAbove} suggests bidding and ` +
      `below ${thresholds.noBidBelow} suggests declining, but the score suggests and the bid ` +
      "team decides — record the decision and its reason either way, especially when it goes " +
      "against the score.",
  };
}

/* ================================================================== */
/* 2. Win probability — fitted, not asserted (#1048)                   */
/* ================================================================== */

export const WIN_MODEL_VERSION = "logistic-v1";

/** The features the model is fitted on. Order is part of the contract. */
export const WIN_MODEL_FEATURES = [
  "priorWinRateWithClient",
  "priorWinRateInWorkType",
  "logRelativeValue",
  "competitorPressure",
  "leadTimeAdequacy",
  "isRepeatClient",
] as const;
export type WinModelFeature = (typeof WIN_MODEL_FEATURES)[number];

export type FeatureVector = Record<WinModelFeature, number>;

export interface TrainingRow {
  features: FeatureVector;
  /** 1 = won, 0 = lost. Opportunities we declined to bid teach nothing here. */
  label: 0 | 1;
}

export interface LogisticModel {
  version: string;
  weights: Record<WinModelFeature, number>;
  bias: number;
  sampleSize: number;
  positives: number;
  iterations: number;
  logLoss: number;
  /** in-sample accuracy at a 0.5 cut — reported so nobody over-reads the model */
  accuracy: number;
  baseRate: number;
}

const asVector = (f: FeatureVector): number[] => WIN_MODEL_FEATURES.map((k) => f[k]);

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/**
 * Fit a logistic regression by batch gradient descent.
 *
 * DETERMINISTIC BY CONSTRUCTION: weights start at zero, the learning rate and
 * the iteration count are fixed, and the data is consumed in the order given.
 * There is no randomness to seed. L2 regularisation keeps a feature that
 * happens to separate six historical rows perfectly from acquiring an
 * infinite coefficient — which is exactly what would otherwise happen on the
 * sample sizes a contractor's tender history actually provides.
 */
export function fitLogistic(
  rows: readonly TrainingRow[],
  opts: { iterations?: number; learningRate?: number; l2?: number } = {},
): LogisticModel {
  const iterations = opts.iterations ?? 400;
  const learningRate = opts.learningRate ?? 0.3;
  const l2 = opts.l2 ?? 0.05;
  const n = rows.length;
  const dim = WIN_MODEL_FEATURES.length;
  const w = new Array<number>(dim).fill(0);
  let bias = 0;
  const positives = rows.filter((r) => r.label === 1).length;
  const baseRate = n === 0 ? 0 : positives / n;

  const xs = rows.map((r) => asVector(r.features));
  const ys = rows.map((r) => r.label);

  for (let iter = 0; iter < iterations && n > 0; iter += 1) {
    const grad = new Array<number>(dim).fill(0);
    let gradBias = 0;
    for (let i = 0; i < n; i += 1) {
      const x = xs[i];
      const y = ys[i];
      if (!x || y === undefined) continue;
      let z = bias;
      for (let d = 0; d < dim; d += 1) z += (w[d] ?? 0) * (x[d] ?? 0);
      const p = sigmoid(z);
      const err = p - y;
      for (let d = 0; d < dim; d += 1) grad[d] = (grad[d] ?? 0) + err * (x[d] ?? 0);
      gradBias += err;
    }
    for (let d = 0; d < dim; d += 1) {
      w[d] = (w[d] ?? 0) - learningRate * ((grad[d] ?? 0) / n + l2 * (w[d] ?? 0));
    }
    bias -= learningRate * (gradBias / n);
  }

  let loss = 0;
  let correct = 0;
  for (let i = 0; i < n; i += 1) {
    const x = xs[i];
    const y = ys[i];
    if (!x || y === undefined) continue;
    let z = bias;
    for (let d = 0; d < dim; d += 1) z += (w[d] ?? 0) * (x[d] ?? 0);
    const p = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(z)));
    loss -= y * Math.log(p) + (1 - y) * Math.log(1 - p);
    if ((p >= 0.5 ? 1 : 0) === y) correct += 1;
  }

  const weights = {} as Record<WinModelFeature, number>;
  WIN_MODEL_FEATURES.forEach((key, index) => {
    weights[key] = round4(w[index] ?? 0);
  });

  return {
    version: WIN_MODEL_VERSION,
    weights,
    bias: round4(bias),
    sampleSize: n,
    positives,
    iterations,
    logLoss: n === 0 ? 0 : round4(loss / n),
    accuracy: n === 0 ? 0 : round4(correct / n),
    baseRate: round4(baseRate),
  };
}

export function predictLogistic(model: LogisticModel, features: FeatureVector): number {
  let z = model.bias;
  for (const key of WIN_MODEL_FEATURES) z += model.weights[key] * features[key];
  return round4(sigmoid(z));
}

export interface WinProbabilityResult {
  probability: Unknowable;
  model: LogisticModel | null;
  features: FeatureVector | null;
  /** each feature's contribution to the log-odds — the "why" of the number */
  contributions: Array<{ feature: WinModelFeature; value: number; weight: number; logOdds: number }>;
  basis: string;
}

/**
 * The minimum history before a fitted probability means anything. Below this
 * the answer is "we do not know", which is a true statement and a useful one.
 */
export const MIN_WIN_MODEL_SAMPLE = 8;
export const MIN_WIN_MODEL_OUTCOMES = 2;

export function estimateWinProbability(
  candidate: FeatureVector,
  history: readonly TrainingRow[],
): WinProbabilityResult {
  const positives = history.filter((r) => r.label === 1).length;
  const negatives = history.length - positives;
  if (history.length < MIN_WIN_MODEL_SAMPLE) {
    return {
      probability: unknowable<number>(
        `Only ${history.length} decided bid(s) are on the record; at least ` +
          `${MIN_WIN_MODEL_SAMPLE} are needed before a fitted probability says anything about ` +
          "this company rather than about noise.",
      ),
      model: null,
      features: candidate,
      contributions: [],
      basis:
        "No win probability was produced. A model fitted on a handful of tenders will happily " +
        "report 0.83 and be wrong in a way nobody can see; the honest answer at this sample " +
        "size is that we do not know. Record the outcome of every bid and the model becomes " +
        "available on its own.",
    };
  }
  if (positives < MIN_WIN_MODEL_OUTCOMES || negatives < MIN_WIN_MODEL_OUTCOMES) {
    return {
      probability: unknowable<number>(
        `The recorded history contains ${positives} win(s) and ${negatives} loss(es). A model ` +
          "needs at least " +
          `${MIN_WIN_MODEL_OUTCOMES} of each to distinguish them; with one class missing it can ` +
          "only predict that class.",
      ),
      model: null,
      features: candidate,
      contributions: [],
      basis:
        "No win probability was produced: the outcome history is one-sided. Until both wins and " +
        "losses are recorded, any figure would simply restate the majority class.",
    };
  }

  const model = fitLogistic(history);
  const probability = predictLogistic(model, candidate);
  const contributions = WIN_MODEL_FEATURES.map((feature) => ({
    feature,
    value: round4(candidate[feature]),
    weight: model.weights[feature],
    logOdds: round4(model.weights[feature] * candidate[feature]),
  })).sort((a, b) => Math.abs(b.logOdds) - Math.abs(a.logOdds));
  const top = contributions[0];

  return {
    probability: known(round4(probability)),
    model,
    features: candidate,
    contributions,
    basis:
      `Fitted on ${model.sampleSize} decided bid(s) (${model.positives} won), base rate ` +
      `${round2(model.baseRate * 100)}%. In-sample accuracy ${round2(model.accuracy * 100)}% at ` +
      `a 0.5 cut, mean log loss ${model.logLoss}. The largest single influence on this estimate ` +
      `is "${top?.feature ?? "none"}" at ${top?.logOdds ?? 0} log-odds. In-sample accuracy is ` +
      "always flattering — this is a model of what this company has done, not a forecast of " +
      "what the market will do, and it should move a marginal decision rather than make one.",
  };
}

/**
 * Build the feature vector for one pursuit from facts the platform already
 * holds. Every feature is bounded to keep an outlier from dominating the fit.
 */
export function buildWinFeatures(input: {
  clientWins: number;
  clientBids: number;
  workTypeWins: number;
  workTypeBids: number;
  value: number | null;
  medianDecidedValue: number | null;
  competitorCount: number | null;
  leadTimeDays: number | null;
}): FeatureVector {
  const rate = (wins: number, bids: number): number => (bids <= 0 ? 0.5 : wins / bids);
  const relative =
    input.value !== null &&
    input.value > 0 &&
    input.medianDecidedValue !== null &&
    input.medianDecidedValue > 0
      ? Math.log10(input.value / input.medianDecidedValue)
      : 0;
  const competitors = input.competitorCount ?? 0;
  const lead = input.leadTimeDays ?? 0;
  return {
    priorWinRateWithClient: round4(rate(input.clientWins, input.clientBids)),
    priorWinRateInWorkType: round4(rate(input.workTypeWins, input.workTypeBids)),
    logRelativeValue: round4(Math.max(-2, Math.min(2, relative))),
    // More competitors, lower chance; bounded so a 40-bidder framework does
    // not swamp every other feature.
    competitorPressure: round4(Math.max(0, Math.min(1, competitors / 10))),
    // Under a fortnight to price a job is a real handicap and shows up as one.
    leadTimeAdequacy: round4(Math.max(0, Math.min(1, lead / 42))),
    isRepeatClient: input.clientBids > 0 ? 1 : 0,
  };
}

/* ================================================================== */
/* 3. Win-rate analytics (#1049)                                       */
/* ================================================================== */

export interface OutcomeRow {
  key: string;
  label: string;
  outcome: "won" | "lost" | "no_bid" | "abandoned" | "pending";
  value: number | null;
  currency: string;
}

export interface WinRateGroup {
  key: string;
  label: string;
  bids: number;
  wins: number;
  losses: number;
  pending: number;
  noBids: number;
  /** wins / (wins + losses) — pending pursuits are not counted either way */
  winRatePercent: Unknowable;
  /** value won / value bid, per currency; never summed across them */
  valueByCurrency: Array<{
    currency: string;
    bidValue: number;
    wonValue: number;
    winRateByValuePercent: number | null;
  }>;
}

/**
 * Win rate by any grouping. Two rules do the work: a rate over fewer than
 * three decided bids is refused with the count named, and value is bucketed
 * per currency and never added across them.
 */
export function winRates(
  rows: readonly OutcomeRow[],
  minDecided = 3,
): { groups: WinRateGroup[]; overall: WinRateGroup } {
  const byKey = new Map<string, OutcomeRow[]>();
  for (const row of rows) byKey.set(row.key, [...(byKey.get(row.key) ?? []), row]);

  const build = (key: string, label: string, group: readonly OutcomeRow[]): WinRateGroup => {
    const wins = group.filter((r) => r.outcome === "won").length;
    const losses = group.filter((r) => r.outcome === "lost").length;
    const pending = group.filter((r) => r.outcome === "pending").length;
    const noBids = group.filter((r) => r.outcome === "no_bid" || r.outcome === "abandoned").length;
    const decided = wins + losses;
    const currencies = [...new Set(group.map((r) => r.currency.toUpperCase()))].sort();
    return {
      key,
      label,
      bids: decided + pending,
      wins,
      losses,
      pending,
      noBids,
      winRatePercent:
        decided < minDecided
          ? unknowable<number>(
              `${decided} decided bid(s) in this group; a win rate over fewer than ${minDecided} ` +
                "outcomes describes the last few tenders, not a rate.",
            )
          : known(round2((wins / decided) * 100)),
      valueByCurrency: currencies.map((currency) => {
        const inCurrency = group.filter(
          (r) => r.currency.toUpperCase() === currency && r.value !== null,
        );
        const bidValue = round2(
          inCurrency
            .filter((r) => r.outcome === "won" || r.outcome === "lost")
            .reduce((s, r) => s + (r.value ?? 0), 0),
        );
        const wonValue = round2(
          inCurrency.filter((r) => r.outcome === "won").reduce((s, r) => s + (r.value ?? 0), 0),
        );
        return {
          currency,
          bidValue,
          wonValue,
          winRateByValuePercent: bidValue > 0 ? round2((wonValue / bidValue) * 100) : null,
        };
      }),
    };
  };

  const groups = [...byKey.entries()]
    .map(([key, group]) => build(key, group[0]?.label ?? key, group))
    .sort((a, b) => b.bids - a.bids);
  return { groups, overall: build("__all__", "All pursuits", rows) };
}

/* ================================================================== */
/* 4. Competitor pricing intelligence (#1050)                          */
/* ================================================================== */

export interface PricingObservation {
  packageId: string;
  packageReference: string;
  tradeCode: string | null;
  vendorId: string;
  vendorName: string | null;
  amount: number;
  currency: string;
  /** the median of the field on that package, for a like-for-like position */
  fieldMedian: number | null;
  engineersEstimate: number | null;
  rank: number | null;
  fieldSize: number;
  won: boolean;
}

export interface CompetitorProfile {
  vendorId: string;
  vendorName: string | null;
  appearances: number;
  wins: number;
  winRatePercent: Unknowable;
  averageRank: Unknowable;
  /** mean percent above/below the field median across their bids */
  medianDeviationPercent: Unknowable;
  /** mean percent above/below the pre-tender estimate */
  estimateDeviationPercent: Unknowable;
  /** how consistently they price relative to the field — low = predictable */
  deviationSpread: number | null;
  note: string;
}

/**
 * Where each bidder sits against the field. This is the only competitor
 * intelligence worth having and the only kind that is lawful to keep: it is
 * built entirely from prices those bidders submitted to US, and it says how
 * they price relative to the market rather than what they will bid next.
 */
export function competitorProfiles(
  observations: readonly PricingObservation[],
  minObservations = 3,
): CompetitorProfile[] {
  const byVendor = new Map<string, PricingObservation[]>();
  for (const o of observations) byVendor.set(o.vendorId, [...(byVendor.get(o.vendorId) ?? []), o]);

  return [...byVendor.entries()]
    .map(([vendorId, rows]): CompetitorProfile => {
      const wins = rows.filter((r) => r.won).length;
      const ranked = rows.filter((r) => r.rank !== null).map((r) => r.rank as number);
      const medianDeviations = rows
        .filter((r) => r.fieldMedian !== null && r.fieldMedian > 0)
        .map((r) => ((r.amount - (r.fieldMedian as number)) / (r.fieldMedian as number)) * 100);
      const estimateDeviations = rows
        .filter((r) => r.engineersEstimate !== null && r.engineersEstimate > 0)
        .map(
          (r) =>
            ((r.amount - (r.engineersEstimate as number)) / (r.engineersEstimate as number)) * 100,
        );
      const mean = (xs: readonly number[]): number | null =>
        xs.length === 0 ? null : round2(xs.reduce((s, x) => s + x, 0) / xs.length);
      const meanDeviation = mean(medianDeviations);
      const spread =
        medianDeviations.length < 2 || meanDeviation === null
          ? null
          : round2(
              Math.sqrt(
                medianDeviations.reduce((s, x) => s + (x - meanDeviation) ** 2, 0) /
                  medianDeviations.length,
              ),
            );
      const thin = rows.length < minObservations;
      return {
        vendorId,
        vendorName: rows[0]?.vendorName ?? null,
        appearances: rows.length,
        wins,
        winRatePercent: thin
          ? unknowable<number>(
              `${rows.length} bid(s) from this vendor are on the record; ${minObservations} are ` +
                "needed before a win rate is a rate.",
            )
          : known(round2((wins / rows.length) * 100)),
        averageRank:
          ranked.length === 0
            ? unknowable<number>("None of this vendor's bids carries a computed rank.")
            : known(round2(ranked.reduce((s, r) => s + r, 0) / ranked.length)),
        medianDeviationPercent:
          meanDeviation === null
            ? unknowable<number>(
                "No package this vendor bid on had a field of priced bids to take a median from.",
              )
            : known(meanDeviation),
        estimateDeviationPercent:
          estimateDeviations.length === 0
            ? unknowable<number>(
                "None of the packages this vendor bid on carries a pre-tender estimate, so there " +
                  "is nothing to measure their pricing against.",
              )
            : known(mean(estimateDeviations) as number),
        deviationSpread: spread,
        note:
          meanDeviation === null
            ? "Not enough of a field to place this vendor against the market."
            : `${rows[0]?.vendorName ?? vendorId} prices on average ${
                meanDeviation >= 0 ? `${meanDeviation}% above` : `${Math.abs(meanDeviation)}% below`
              } the median of the fields they appear in` +
              (spread !== null
                ? `, with a spread of ${spread} points — ${
                    spread < 5
                      ? "unusually consistent, which is what a formula rather than an estimate " +
                        "looks like"
                      : "the ordinary variation of a company pricing each job on its merits"
                  }`
                : "") +
              ".",
      };
    })
    .sort((a, b) => b.appearances - a.appearances);
}

/* ================================================================== */
/* 5. Scope gaps across bids (#172)                                    */
/* ================================================================== */

export interface ScopeCoverageFacts {
  itemId: string;
  itemCode: string | null;
  description: string;
  isMandatory: boolean;
  engineersEstimate: number | null;
  /** one entry per contender: what they said about this row */
  answers: Array<{
    submissionId: string;
    vendorId: string;
    vendorName: string | null;
    includedStatus: string | null;
    levelledAmount: number | null;
    adjustmentAmount: number;
  }>;
}

export interface ScopeGap {
  itemId: string;
  itemCode: string | null;
  description: string;
  contenders: number;
  answered: number;
  included: number;
  excluded: number;
  unclear: number;
  unanswered: number;
  /** the widest unexplained hole: excluded or unclear with no adjustment */
  uncoveredVendorIds: string[];
  /** what the row is worth, where we have a number for it */
  exposure: number | null;
  severity: "critical" | "high" | "medium" | "low";
  note: string;
}

/**
 * SCOPE GAP IDENTIFICATION ACROSS BIDS. The failure this catches is the one
 * that makes the cheapest bid the most expensive: a scope row that NOBODY
 * priced, or that only the expensive bidders priced, so the low bid is low
 * because it is missing work that will be bought later at a variation rate
 * with no competition.
 */
export function findScopeGaps(
  items: readonly ScopeCoverageFacts[],
  contenderCount: number,
): { gaps: ScopeGap[]; summary: { rows: number; gapRows: number; universalGaps: number; exposure: number | null } } {
  const gaps: ScopeGap[] = [];
  let exposureTotal = 0;
  let exposureKnown = false;

  for (const item of items) {
    const answered = item.answers.length;
    const included = item.answers.filter(
      (a) => a.includedStatus === "included" || a.includedStatus === "included_elsewhere",
    ).length;
    const excluded = item.answers.filter((a) => a.includedStatus === "excluded").length;
    const unclear = item.answers.filter(
      (a) => a.includedStatus === "unclear" || a.includedStatus === "partially_included",
    ).length;
    const unanswered = Math.max(0, contenderCount - answered);
    const uncovered = item.answers
      .filter(
        (a) =>
          (a.includedStatus === "excluded" ||
            a.includedStatus === "unclear" ||
            a.includedStatus === "partially_included") &&
          Math.abs(a.adjustmentAmount) < 0.005,
      )
      .map((a) => a.vendorId);
    if (excluded === 0 && unclear === 0 && unanswered === 0) continue;

    const universal = contenderCount > 0 && included === 0;
    const severity: ScopeGap["severity"] = universal
      ? "critical"
      : item.isMandatory && (excluded > 0 || unanswered > 0)
        ? "high"
        : unclear > 0
          ? "medium"
          : "low";
    if (item.engineersEstimate !== null) {
      exposureTotal += item.engineersEstimate;
      exposureKnown = true;
    }
    gaps.push({
      itemId: item.itemId,
      itemCode: item.itemCode,
      description: item.description,
      contenders: contenderCount,
      answered,
      included,
      excluded,
      unclear,
      unanswered,
      uncoveredVendorIds: uncovered,
      exposure: item.engineersEstimate,
      severity,
      note: universal
        ? `No bidder has this scope in their price. "${item.description}" will be bought after ` +
          "the award, from whoever wins, with no competition and no comparison — which is the " +
          "most expensive way to buy anything on a construction site. Either it belongs in the " +
          "package and the tender must be re-issued with it, or it belongs to somebody else and " +
          "the interface needs writing down."
        : excluded > 0 || unanswered > 0
          ? `${excluded + unanswered} of ${contenderCount} bidder(s) do not carry ` +
            `"${item.description}". Any comparison that treats their totals as like-for-like is ` +
            "comparing a priced scope against an unpriced one; the levelling adjustment is what " +
            "closes that, and until it is made the low bid is low for the wrong reason."
          : `${unclear} bidder(s) gave an unclear answer on "${item.description}". An unclear ` +
            "answer is an exclusion nobody has admitted to yet — raise it as a tender query " +
            "before the comparison rather than assuming the answer.",
    });
  }

  return {
    gaps: gaps.sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
      return order[a.severity] - order[b.severity];
    }),
    summary: {
      rows: items.length,
      gapRows: gaps.length,
      universalGaps: gaps.filter((g) => g.severity === "critical").length,
      exposure: exposureKnown ? round2(exposureTotal) : null,
    },
  };
}

/* ================================================================== */
/* 6. Cost of sale (#1051)                                             */
/* ================================================================== */

export interface CostRow {
  subjectId: string;
  outcome: "won" | "lost" | "no_bid" | "abandoned" | "pending";
  amount: number;
  currency: string;
  hours: number | null;
  kind: string;
}

export interface CostOfSaleSummary {
  currency: string;
  totalCost: number;
  totalHours: number | null;
  byOutcome: Array<{ outcome: string; pursuits: number; cost: number; hours: number | null }>;
  byKind: Array<{ kind: string; cost: number; sharePercent: number }>;
  wonCost: number;
  lostCost: number;
  /** what one win cost, all pursuits included — the number nobody computes */
  costPerWin: Unknowable;
  /** cost of sale as a percent of the value won, where the value is known */
  costOfSalePercent: Unknowable;
  note: string;
}

export function costOfSale(
  rows: readonly CostRow[],
  wonValueByCurrency: ReadonlyMap<string, number>,
  winsByCurrency: ReadonlyMap<string, number>,
): CostOfSaleSummary[] {
  const currencies = [...new Set(rows.map((r) => r.currency.toUpperCase()))].sort();
  return currencies.map((currency) => {
    const inCurrency = rows.filter((r) => r.currency.toUpperCase() === currency);
    const totalCost = round2(inCurrency.reduce((s, r) => s + r.amount, 0));
    const hoursRows = inCurrency.filter((r) => r.hours !== null);
    const totalHours =
      hoursRows.length === 0 ? null : round2(hoursRows.reduce((s, r) => s + (r.hours ?? 0), 0));
    const outcomes = [...new Set(inCurrency.map((r) => r.outcome))];
    const wonCost = round2(
      inCurrency.filter((r) => r.outcome === "won").reduce((s, r) => s + r.amount, 0),
    );
    const lostCost = round2(
      inCurrency.filter((r) => r.outcome === "lost").reduce((s, r) => s + r.amount, 0),
    );
    const wins = winsByCurrency.get(currency) ?? 0;
    const wonValue = wonValueByCurrency.get(currency) ?? 0;
    const kinds = [...new Set(inCurrency.map((r) => r.kind))].sort();
    return {
      currency,
      totalCost,
      totalHours,
      byOutcome: outcomes.map((outcome) => {
        const group = inCurrency.filter((r) => r.outcome === outcome);
        const groupHours = group.filter((r) => r.hours !== null);
        return {
          outcome,
          pursuits: new Set(group.map((r) => r.subjectId)).size,
          cost: round2(group.reduce((s, r) => s + r.amount, 0)),
          hours:
            groupHours.length === 0
              ? null
              : round2(groupHours.reduce((s, r) => s + (r.hours ?? 0), 0)),
        };
      }),
      byKind: kinds.map((kind) => {
        const cost = round2(
          inCurrency.filter((r) => r.kind === kind).reduce((s, r) => s + r.amount, 0),
        );
        return { kind, cost, sharePercent: totalCost > 0 ? round2((cost / totalCost) * 100) : 0 };
      }),
      wonCost,
      lostCost,
      costPerWin:
        wins <= 0
          ? unknowable<number>(
              `No win is recorded in ${currency}, so the cost of a win cannot be computed. The ` +
                `${totalCost} spent is not zero-value — it is unrecovered.`,
            )
          : known(round2(totalCost / wins)),
      costOfSalePercent:
        wonValue <= 0
          ? unknowable<number>(
              `No won value is recorded in ${currency}, so cost of sale cannot be expressed as a ` +
                "percentage of anything.",
            )
          : known(round2((totalCost / wonValue) * 100)),
      note:
        `${currency} ${totalCost} was spent pursuing work` +
        (totalHours !== null ? ` across ${totalHours} recorded hour(s)` : "") +
        `, of which ${currency} ${lostCost} was spent on tenders that were lost. That is not ` +
        "waste — it is the price of the ones that were won, and it belongs in the margin " +
        "expectation of every bid rather than in an overhead line nobody looks at.",
    };
  });
}
