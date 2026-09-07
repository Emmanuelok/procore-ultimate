import type {
  BidIntegrityDetector,
  BidIntegritySeverity,
} from "@constructos/shared";
import { CENT, round2, round4 } from "./shared.js";

/**
 * BID-PATTERN INTEGRITY (Domain A #1–35).
 *
 * A rigged tender does not look wrong from inside one package. Every bid is
 * signed, every envelope is sealed, every price is different from every
 * other. The signature of collusion is STATISTICAL, and it appears in three
 * places:
 *
 *  WITHIN ONE PACKAGE  — the shape of the numbers. Three contenders whose
 *    totals sit within 1.5% of each other did not arrive at that
 *    independently; two bidders quoting the identical unit rate on the same
 *    scope row priced the same spreadsheet; a bidder whose every rate is
 *    1.07x another's copied it and added a margin. And bids arriving within
 *    ten minutes of each other after a month-long tender period were sent by
 *    one person.
 *
 *  WITHIN ONE BID      — the shape of one bidder's rates against the market.
 *    A total 20% under the median with front-loaded early rates and starved
 *    later ones is not a keen price; it is a cash-flow trap, an unbalanced
 *    bid, and it is the reason abnormally low tenders must justify
 *    themselves before they can be recommended.
 *
 *  ACROSS PACKAGES     — the shape of who wins. Cover bidding shows up as one
 *    vendor losing to the same winner over and over in one trade; market
 *    allocation shows up as winners rotating with far less entropy than
 *    chance would produce; and both are invisible until several tenders are
 *    read together, which is exactly what a per-package screen never does.
 *
 * EVERY FUNCTION HERE IS PURE AND DETERMINISTIC. They take facts and return
 * findings; nothing writes, nothing reads the clock, nothing raises a signal.
 * Persistence lives in `integrity-service.ts`, which is what makes these
 * testable against planted fixtures and lets the measured precision of each
 * detector mean something.
 *
 * A FINDING IS NOT AN ACCUSATION. Each one carries the statistic it was
 * computed from, the records it was computed over, and a plain-English
 * explanation of what innocent explanations would look like — because the
 * response to "these three bids are 1.2% apart" is to ask, not to disqualify.
 */

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

export interface IntegrityFinding {
  detector: BidIntegrityDetector;
  severity: BidIntegritySeverity;
  /** 0..1 — how strongly the statistic supports the pattern, never certainty */
  confidence: number;
  title: string;
  explanation: string;
  /**
   * Deterministic identity of the FINDING, not of the run. Re-running the
   * detectors over unchanged data must not manufacture a second signal.
   */
  key: string;
  /** the computed numbers, so a reviewer can check the arithmetic */
  statistic: Record<string, number | string | null>;
  /** the records the finding was computed over */
  evidence: Record<string, unknown>;
  subjectType: "bid_package" | "bid_submission" | "vendor" | "bid_award" | "company";
  subjectId: string;
}

/* ------------------------------------------------------------------ */
/* Thresholds — declared, not buried                                   */
/* ------------------------------------------------------------------ */

export interface IntegrityThresholds {
  /** CV below this across >=3 contenders is a complementary-bidding signature */
  clusteringCvPercent: number;
  /** CV above this means somebody priced a different job */
  dispersionCvPercent: number;
  /** two rates within this percent of each other count as identical */
  rateMatchTolerancePercent: number;
  /** how many matched rate lines before a pair is reported */
  minMatchedRateLines: number;
  /** share of a pair's comparable lines that must match */
  matchedRateShare: number;
  /** a constant-ratio relationship must hold across this share of lines */
  constantRatioShare: number;
  /** tolerance on the ratio itself */
  constantRatioTolerancePercent: number;
  /** submissions arriving inside this window are clustered */
  submissionClusterMinutes: number;
  /** deviation below the median that makes a tender abnormally low */
  abnormallyLowPercent: number;
  /** deviation above the median that makes a tender abnormally high */
  abnormallyHighPercent: number;
  /** an early-item rate this many times the median is front-loaded */
  frontLoadRateMultiple: number;
  /** a late-item rate below this share of the median is starved */
  backLoadRateShare: number;
  /** losing to the same winner this many times in the trailing window */
  coverBiddingLosses: number;
  coverBiddingWindow: number;
  /** normalised winner entropy below this in a trade is a rotation pattern */
  rotationEntropyCeiling: number;
  /** minimum packages in a trade before rotation means anything */
  rotationMinPackages: number;
  /** an approval this many minutes after the recommendation is not a review */
  approvalVelocityMinutes: number;
  /** working hours, local to the company's declared convention */
  workingHourStart: number;
  workingHourEnd: number;
}

export const DEFAULT_INTEGRITY_THRESHOLDS: IntegrityThresholds = {
  clusteringCvPercent: 3,
  dispersionCvPercent: 40,
  rateMatchTolerancePercent: 0.5,
  minMatchedRateLines: 3,
  matchedRateShare: 0.5,
  constantRatioShare: 0.8,
  constantRatioTolerancePercent: 1,
  submissionClusterMinutes: 10,
  abnormallyLowPercent: 15,
  abnormallyHighPercent: 25,
  frontLoadRateMultiple: 2,
  backLoadRateShare: 0.5,
  coverBiddingLosses: 3,
  coverBiddingWindow: 5,
  rotationEntropyCeiling: 0.6,
  rotationMinPackages: 4,
  approvalVelocityMinutes: 15,
  workingHourStart: 7,
  workingHourEnd: 19,
};

/**
 * Thresholds may be overridden per package (`detail.integrityThresholds`) —
 * a two-bidder plant hire enquiry and a public works tender do not share a
 * dispersion expectation. Unknown keys and non-numbers are ignored rather
 * than trusted.
 */
export function resolveThresholds(raw: unknown): IntegrityThresholds {
  const out: IntegrityThresholds = { ...DEFAULT_INTEGRITY_THRESHOLDS };
  if (!raw || typeof raw !== "object") return out;
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_INTEGRITY_THRESHOLDS) as (keyof IntegrityThresholds)[]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Facts the detectors run on                                          */
/* ------------------------------------------------------------------ */

export interface ContenderFacts {
  submissionId: string;
  reference: string;
  vendorId: string;
  vendorName: string | null;
  /** the figure the package is compared on — levelled where levelled */
  amount: number | null;
  currency: string;
  receivedAt: string | null;
  isLate: boolean;
  lateAccepted: boolean;
  status: string;
}

export interface RateFacts {
  submissionId: string;
  vendorId: string;
  lineId: string;
  /** the neutral scope row, or the item code — what makes two lines the same */
  key: string;
  position: number;
  description: string;
  unitRate: number | null;
  amount: number | null;
  quantity: number | null;
}

export interface PackageFacts {
  packageId: string;
  reference: string;
  title: string;
  currency: string;
  engineersEstimate: number | null;
  tradeCode: string | null;
  comparisonBasis: "levelled" | "as_bid";
}

/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

export interface Dispersion {
  n: number;
  mean: number | null;
  sd: number | null;
  /** coefficient of variation as a percent */
  cvPercent: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
}

export function dispersionOf(values: readonly number[]): Dispersion {
  const clean = values.filter((v) => Number.isFinite(v));
  const n = clean.length;
  if (n === 0) return { n: 0, mean: null, sd: null, cvPercent: null, median: null, min: null, max: null };
  const sorted = [...clean].sort((a, b) => a - b);
  const sum = clean.reduce((s, v) => s + v, 0);
  const mean = sum / n;
  const median = medianOf(sorted);
  const min = sorted[0] ?? null;
  const max = sorted[sorted.length - 1] ?? null;
  if (n === 1) {
    return { n, mean: round2(mean), sd: 0, cvPercent: 0, median, min, max };
  }
  // Population standard deviation: these are all the bids, not a sample of them.
  const variance = clean.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  return {
    n,
    mean: round2(mean),
    sd: round2(sd),
    cvPercent: mean === 0 ? null : round4((sd / Math.abs(mean)) * 100),
    median,
    min,
    max,
  };
}

/** Median of an already-sorted, non-empty array of finite numbers. */
export function medianOf(sorted: readonly number[]): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  if (n % 2 === 1) return round2(sorted[(n - 1) / 2] ?? 0);
  const a = sorted[n / 2 - 1];
  const b = sorted[n / 2];
  if (a === undefined || b === undefined) return null;
  return round2((a + b) / 2);
}

export function medianUnsorted(values: readonly number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return medianOf(clean);
}

/**
 * Shannon entropy of a win distribution, normalised to 0..1 against the
 * maximum entropy for the same number of distinct winners. 1 means wins are
 * spread as evenly as they could be; 0 means one bidder takes everything.
 *
 * The interesting case is the MIDDLE: a trade where four bidders each win
 * exactly a quarter, package after package, in strict turn. That is not
 * competition, it is a rota — and it produces high entropy, so entropy alone
 * is never the finding. The rotation detector pairs it with the runs test
 * below.
 */
export function normalisedEntropy(counts: readonly number[]): number | null {
  const total = counts.reduce((s, c) => s + c, 0);
  const k = counts.filter((c) => c > 0).length;
  if (total === 0 || k <= 1) return null;
  let h = 0;
  for (const c of counts) {
    if (c <= 0) continue;
    const p = c / total;
    h -= p * Math.log2(p);
  }
  return round4(h / Math.log2(k));
}

/**
 * How close a sequence of winners is to a strict rotation: the share of
 * consecutive pairs where the winner CHANGED. A strict rota gives 1.0; a
 * single dominant winner gives close to 0. Paired with an even win
 * distribution, a value at or near 1 across enough packages is the market-
 * allocation signature.
 */
export function alternationRate(sequence: readonly string[]): number | null {
  if (sequence.length < 3) return null;
  let changes = 0;
  for (let i = 1; i < sequence.length; i += 1) {
    if (sequence[i] !== sequence[i - 1]) changes += 1;
  }
  return round4(changes / (sequence.length - 1));
}

/* ------------------------------------------------------------------ */
/* 1. Price clustering and dispersion (Domain A #1, #2)                */
/* ------------------------------------------------------------------ */

/**
 * The complementary-bid signature. Independent estimators pricing the same
 * bill of quantities from their own rates, their own subcontractors and
 * their own view of the risk normally land 5–15% apart. Three of them inside
 * 3% did not do that independently: the usual mechanism is that one priced
 * the job and the others were told what to write so the winner would look
 * competitive.
 */
export function detectPriceClustering(
  pkg: PackageFacts,
  contenders: readonly ContenderFacts[],
  t: IntegrityThresholds = DEFAULT_INTEGRITY_THRESHOLDS,
): IntegrityFinding[] {
  const priced = contenders.filter(
    (c): c is ContenderFacts & { amount: number } => c.amount !== null && Number.isFinite(c.amount),
  );
  if (priced.length < 3) return [];
  const currencies = new Set(priced.map((c) => c.currency.toUpperCase()));
  if (currencies.size > 1) return [];

  const stats = dispersionOf(priced.map((c) => c.amount));
  if (stats.cvPercent === null) return [];
  const findings: IntegrityFinding[] = [];
  const evidence = {
    packageId: pkg.packageId,
    packageReference: pkg.reference,
    comparisonBasis: pkg.comparisonBasis,
    submissionIds: priced.map((c) => c.submissionId),
    vendorIds: priced.map((c) => c.vendorId),
    amounts: priced.map((c) => ({
      submissionId: c.submissionId,
      vendorId: c.vendorId,
      vendorName: c.vendorName,
      amount: c.amount,
    })),
  };
  const statistic = {
    contenders: stats.n,
    mean: stats.mean,
    standardDeviation: stats.sd,
    coefficientOfVariationPercent: stats.cvPercent,
    spread: stats.max !== null && stats.min !== null ? round2(stats.max - stats.min) : null,
    currency: pkg.currency,
  };

  if (stats.cvPercent < t.clusteringCvPercent) {
    findings.push({
      detector: "bid_integrity_price_clustering",
      severity: stats.cvPercent < t.clusteringCvPercent / 2 ? "high" : "medium",
      confidence: round4(
        Math.min(0.95, 0.5 + (t.clusteringCvPercent - stats.cvPercent) / t.clusteringCvPercent / 2),
      ),
      title: `Bids on ${pkg.reference} are clustered within ${stats.cvPercent}% of each other`,
      explanation:
        `${stats.n} contenders on ${pkg.reference} priced within a coefficient of variation of ` +
        `${stats.cvPercent}% (${pkg.currency} ${stats.min} to ${stats.max}, mean ${stats.mean}). ` +
        "Independent estimators pricing the same bill from their own rates, their own " +
        "subcontractors and their own view of the risk normally land 5–15% apart. A cluster " +
        "this tight is the classic complementary-bidding signature: one company prices the job " +
        "and the others submit cover prices a stated margin above it, so the intended winner " +
        "looks competitive. The innocent explanations are real and should be checked first — a " +
        "fully specified bill with published rates, a schedule of rates framework, or a market " +
        "where every bidder buys from the same two suppliers. Ask the question; the answer is " +
        "the record.",
      key: `clustering:${pkg.packageId}`,
      statistic,
      evidence,
      subjectType: "bid_package",
      subjectId: pkg.packageId,
    });
  } else if (stats.cvPercent > t.dispersionCvPercent) {
    findings.push({
      detector: "bid_integrity_price_dispersion",
      severity: "medium",
      confidence: 0.6,
      title: `Bids on ${pkg.reference} are dispersed by ${stats.cvPercent}%`,
      explanation:
        `${stats.n} contenders on ${pkg.reference} range from ${pkg.currency} ${stats.min} to ` +
        `${stats.max} — a coefficient of variation of ${stats.cvPercent}%. Bidders that far ` +
        "apart were not pricing the same job. Either the scope is ambiguous enough that two " +
        "competent estimators read it differently, an addendum reached some bidders and not " +
        "others, or the cheapest bid has excluded something the others carried. The levelling " +
        "is where that is settled, and until it is, the low bid is not a saving.",
      key: `dispersion:${pkg.packageId}`,
      statistic,
      evidence,
      subjectType: "bid_package",
      subjectId: pkg.packageId,
    });
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* 2. Identical and proportional unit rates (Domain A #4, #5)          */
/* ------------------------------------------------------------------ */

interface PairedLine {
  key: string;
  description: string;
  a: number;
  b: number;
  aLineId: string;
  bLineId: string;
}

function pairLines(
  lines: readonly RateFacts[],
  aId: string,
  bId: string,
): PairedLine[] {
  const byKeyA = new Map<string, RateFacts>();
  for (const line of lines) {
    if (line.submissionId !== aId) continue;
    if (line.unitRate === null || !Number.isFinite(line.unitRate)) continue;
    byKeyA.set(line.key, line);
  }
  const out: PairedLine[] = [];
  for (const line of lines) {
    if (line.submissionId !== bId) continue;
    if (line.unitRate === null || !Number.isFinite(line.unitRate)) continue;
    const other = byKeyA.get(line.key);
    if (!other || other.unitRate === null) continue;
    out.push({
      key: line.key,
      description: other.description || line.description,
      a: other.unitRate,
      b: line.unitRate,
      aLineId: other.lineId,
      bLineId: line.lineId,
    });
  }
  return out;
}

/**
 * Two bidders quoting the same unit rate on the same scope row priced the
 * same spreadsheet. One or two coincidences on round-number rates mean
 * nothing; a run of them across a bill does not happen.
 */
export function detectIdenticalRates(
  pkg: PackageFacts,
  contenders: readonly ContenderFacts[],
  lines: readonly RateFacts[],
  t: IntegrityThresholds = DEFAULT_INTEGRITY_THRESHOLDS,
): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  const ids = contenders.map((c) => c.submissionId);
  const byId = new Map(contenders.map((c) => [c.submissionId, c] as const));
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const aId = ids[i];
      const bId = ids[j];
      if (!aId || !bId) continue;
      const a = byId.get(aId);
      const b = byId.get(bId);
      if (!a || !b || a.vendorId === b.vendorId) continue;
      const paired = pairLines(lines, aId, bId);
      if (paired.length === 0) continue;
      const exact: PairedLine[] = [];
      const near: PairedLine[] = [];
      for (const p of paired) {
        if (Math.abs(p.a) < CENT && Math.abs(p.b) < CENT) continue; // 0 = 0 proves nothing
        const diff = Math.abs(p.a - p.b);
        if (diff <= CENT) exact.push(p);
        else if (
          Math.max(Math.abs(p.a), Math.abs(p.b)) > 0 &&
          (diff / Math.max(Math.abs(p.a), Math.abs(p.b))) * 100 <= t.rateMatchTolerancePercent
        ) {
          near.push(p);
        }
      }
      const matched = exact.length + near.length;
      const share = paired.length === 0 ? 0 : matched / paired.length;
      if (matched < t.minMatchedRateLines || share < t.matchedRateShare) continue;
      const key = [a.vendorId, b.vendorId].sort().join("|");
      findings.push({
        detector: "bid_integrity_identical_rates",
        severity: share >= 0.9 ? "high" : "medium",
        confidence: round4(Math.min(0.95, 0.4 + share / 2)),
        title:
          `${a.vendorName ?? a.vendorId} and ${b.vendorName ?? b.vendorId} quoted the same rate ` +
          `on ${matched} of ${paired.length} comparable lines of ${pkg.reference}`,
        explanation:
          `${exact.length} unit rate(s) are identical to the cent and ${near.length} more agree ` +
          `to within ${t.rateMatchTolerancePercent}% — ${Math.round(share * 100)}% of the ` +
          `${paired.length} lines both bidders priced. Two estimators build rates from their own ` +
          "labour constants, their own plant and their own supplier quotations; agreeing on a " +
          "handful of round-number rates is ordinary, but agreeing across a bill is not. The " +
          "usual mechanism is one priced document shared between the two. Check whether both " +
          "bids were prepared by the same estimating consultant, whether they share a parent " +
          "company, and whether the lines that match are the ones a common supplier would set.",
        key: `identical_rates:${pkg.packageId}:${key}`,
        statistic: {
          comparableLines: paired.length,
          exactMatches: exact.length,
          nearMatches: near.length,
          matchSharePercent: round2(share * 100),
          tolerancePercent: t.rateMatchTolerancePercent,
        },
        evidence: {
          packageId: pkg.packageId,
          packageReference: pkg.reference,
          submissionIds: [aId, bId],
          vendorIds: [a.vendorId, b.vendorId],
          vendorNames: [a.vendorName, b.vendorName],
          matchedLines: [...exact, ...near].slice(0, 40).map((p) => ({
            key: p.key,
            description: p.description,
            rateA: p.a,
            rateB: p.b,
            lineIds: [p.aLineId, p.bLineId],
          })),
        },
        subjectType: "bid_package",
        subjectId: pkg.packageId,
      });
    }
  }
  return findings;
}

/**
 * A constant-ratio relationship: every rate of bidder B is the same multiple
 * of bidder A's. That is not two companies pricing a job — it is one priced
 * document with a percentage applied, which is precisely how a cover price
 * is produced.
 */
export function detectConstantRatio(
  pkg: PackageFacts,
  contenders: readonly ContenderFacts[],
  lines: readonly RateFacts[],
  t: IntegrityThresholds = DEFAULT_INTEGRITY_THRESHOLDS,
): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  const ids = contenders.map((c) => c.submissionId);
  const byId = new Map(contenders.map((c) => [c.submissionId, c] as const));
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const aId = ids[i];
      const bId = ids[j];
      if (!aId || !bId) continue;
      const a = byId.get(aId);
      const b = byId.get(bId);
      if (!a || !b || a.vendorId === b.vendorId) continue;
      const paired = pairLines(lines, aId, bId).filter(
        (p) => Math.abs(p.a) > CENT && Math.abs(p.b) > CENT,
      );
      if (paired.length < 5) continue;
      const ratios = paired.map((p) => p.b / p.a);
      const median = medianUnsorted(ratios);
      if (median === null || median <= 0) continue;
      // Identical rates are their own detector; a ratio of 1 is that finding.
      if (Math.abs(median - 1) * 100 <= t.constantRatioTolerancePercent) continue;
      const within = ratios.filter(
        (r) => (Math.abs(r - median) / median) * 100 <= t.constantRatioTolerancePercent,
      ).length;
      const share = within / ratios.length;
      if (share < t.constantRatioShare) continue;
      const key = [a.vendorId, b.vendorId].sort().join("|");
      findings.push({
        detector: "bid_integrity_constant_ratio",
        severity: "high",
        confidence: round4(Math.min(0.95, 0.5 + share / 2)),
        title:
          `${b.vendorName ?? b.vendorId}'s rates on ${pkg.reference} are a constant ` +
          `${round2(median)}x ${a.vendorName ?? a.vendorId}'s`,
        explanation:
          `${within} of ${ratios.length} comparable unit rates hold the same ratio of ` +
          `${round2(median)} to within ${t.constantRatioTolerancePercent}%. Two independent ` +
          "estimators never produce that: their rates differ by different amounts on different " +
          "items because their labour constants, plant rates and supplier discounts differ " +
          "item by item. A single multiplier across a whole bill is one priced document with a " +
          `percentage added — which is how a cover price is written. The ${round2(
            (median - 1) * 100,
          )}% uplift is the margin the covering bidder was told to add.`,
        key: `constant_ratio:${pkg.packageId}:${key}`,
        statistic: {
          comparableLines: ratios.length,
          medianRatio: round4(median),
          linesWithinTolerance: within,
          shareWithinTolerancePercent: round2(share * 100),
          impliedUpliftPercent: round2((median - 1) * 100),
        },
        evidence: {
          packageId: pkg.packageId,
          packageReference: pkg.reference,
          submissionIds: [aId, bId],
          vendorIds: [a.vendorId, b.vendorId],
          vendorNames: [a.vendorName, b.vendorName],
          sample: paired.slice(0, 40).map((p) => ({
            key: p.key,
            description: p.description,
            rateA: p.a,
            rateB: p.b,
            ratio: round4(p.b / p.a),
          })),
        },
        subjectType: "bid_package",
        subjectId: pkg.packageId,
      });
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* 3. Submission timestamp clustering (Domain A #7)                    */
/* ------------------------------------------------------------------ */

/**
 * Bids from different companies arriving within minutes of each other, at
 * the end of a tender period measured in weeks, were sent by one person.
 */
export function detectSubmissionClustering(
  pkg: PackageFacts,
  contenders: readonly ContenderFacts[],
  t: IntegrityThresholds = DEFAULT_INTEGRITY_THRESHOLDS,
): IntegrityFinding[] {
  const timed = contenders
    .map((c) => ({ ...c, ms: c.receivedAt ? Date.parse(c.receivedAt) : Number.NaN }))
    .filter((c) => Number.isFinite(c.ms))
    .sort((a, b) => a.ms - b.ms);
  if (timed.length < 2) return [];
  const windowMs = t.submissionClusterMinutes * 60_000;
  const findings: IntegrityFinding[] = [];
  let start = 0;
  while (start < timed.length) {
    let end = start;
    while (end + 1 < timed.length) {
      const next = timed[end + 1];
      const first = timed[start];
      if (!next || !first || next.ms - first.ms > windowMs) break;
      end += 1;
    }
    const group = timed.slice(start, end + 1);
    const vendorIds = new Set(group.map((g) => g.vendorId));
    if (vendorIds.size >= 2) {
      const first = group[0];
      const last = group[group.length - 1];
      const spanMinutes =
        first && last ? round2((last.ms - first.ms) / 60_000) : 0;
      findings.push({
        detector: "bid_integrity_submission_clustering",
        severity: spanMinutes <= 2 ? "high" : "medium",
        confidence: round4(Math.min(0.9, 0.4 + (vendorIds.size - 1) * 0.2)),
        title:
          `${vendorIds.size} bids on ${pkg.reference} arrived within ${spanMinutes} minute(s) of ` +
          "each other",
        explanation:
          `${group.map((g) => g.vendorName ?? g.vendorId).join(", ")} submitted between ` +
          `${first?.receivedAt} and ${last?.receivedAt}. A tender period runs for weeks and ` +
          "bidders finish when they finish; independent companies do not converge on the same " +
          "few minutes. Submissions this close together usually mean one person sent them — " +
          "check the delivery route, the sending addresses and the document metadata. The " +
          "innocent explanation is a shared deadline rush against a portal that timestamps on " +
          "receipt rather than on send, and that is worth confirming before anything else.",
        key: `submission_clustering:${pkg.packageId}:${group
          .map((g) => g.submissionId)
          .sort()
          .join("|")}`,
        statistic: {
          bidders: vendorIds.size,
          spanMinutes,
          windowMinutes: t.submissionClusterMinutes,
        },
        evidence: {
          packageId: pkg.packageId,
          packageReference: pkg.reference,
          submissionIds: group.map((g) => g.submissionId),
          vendorIds: [...vendorIds],
          receipts: group.map((g) => ({
            submissionId: g.submissionId,
            vendorId: g.vendorId,
            vendorName: g.vendorName,
            receivedAt: g.receivedAt,
          })),
        },
        subjectType: "bid_package",
        subjectId: pkg.packageId,
      });
    }
    start = end + 1;
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* 4. Abnormally low / high tenders (Domain A #16–19)                  */
/* ------------------------------------------------------------------ */

export interface AbnormalityAssessment {
  submissionId: string;
  vendorId: string;
  vendorName: string | null;
  amount: number;
  deviationFromMedianPercent: number | null;
  deviationFromEstimatePercent: number | null;
  verdict: "abnormally_low" | "abnormally_high" | "normal";
  /** true while an abnormally-low bid has no recorded price explanation */
  requiresJustification: boolean;
  note: string;
}

/**
 * The abnormally-low tender is the one that costs the most. A bid 20% under
 * the field is either a mistake, a deliberate loss-leader to be recovered
 * through variations, or a bidder who has not read the scope — and all three
 * end with the buyer paying more than the second-lowest price would have
 * cost. Public procurement rules require the buyer to ASK before accepting
 * it; this is the machinery that makes the asking mandatory.
 */
export function assessAbnormalPricing(
  pkg: PackageFacts,
  contenders: readonly ContenderFacts[],
  justifiedSubmissionIds: ReadonlySet<string> = new Set(),
  t: IntegrityThresholds = DEFAULT_INTEGRITY_THRESHOLDS,
): { median: number | null; assessments: AbnormalityAssessment[] } {
  const priced = contenders.filter(
    (c): c is ContenderFacts & { amount: number } => c.amount !== null && Number.isFinite(c.amount),
  );
  const currencies = new Set(priced.map((c) => c.currency.toUpperCase()));
  if (priced.length === 0 || currencies.size > 1) return { median: null, assessments: [] };
  const median = medianUnsorted(priced.map((c) => c.amount));
  const estimate = pkg.engineersEstimate;

  const assessments = priced.map((c): AbnormalityAssessment => {
    const fromMedian =
      median === null || median === 0 ? null : round2(((c.amount - median) / median) * 100);
    const fromEstimate =
      estimate === null || estimate <= 0 ? null : round2(((c.amount - estimate) / estimate) * 100);
    // Only measurable against a field: one bid is not a market.
    const measurable = priced.length >= 3 ? fromMedian : fromEstimate;
    let verdict: AbnormalityAssessment["verdict"] = "normal";
    if (measurable !== null && measurable <= -t.abnormallyLowPercent) verdict = "abnormally_low";
    else if (measurable !== null && measurable >= t.abnormallyHighPercent) verdict = "abnormally_high";
    const basis =
      priced.length >= 3
        ? `the median of the ${priced.length} contenders (${pkg.currency} ${median})`
        : estimate !== null
          ? `the pre-tender estimate (${pkg.currency} ${estimate})`
          : "nothing — there is neither a field of three bids nor an estimate to measure against";
    const note =
      verdict === "abnormally_low"
        ? `At ${pkg.currency} ${c.amount} this bid is ${measurable}% below ${basis}. It cannot be ` +
          "recommended until the bidder has been asked to explain the price in writing and the " +
          "explanation is on the record: an abnormally low tender accepted without that question " +
          "is the one that returns as a claim, a variation account or an insolvency."
        : verdict === "abnormally_high"
          ? `At ${pkg.currency} ${c.amount} this bid is ${measurable}% above ${basis}. A bid that ` +
            "far above the field is often a polite refusal to tender — a cover price — and " +
            "counting it as competition overstates how many real bids the package attracted."
          : measurable === null
            ? `No abnormality test could be applied: ${basis}.`
            : `Within the normal range at ${measurable}% against ${basis}.`;
    return {
      submissionId: c.submissionId,
      vendorId: c.vendorId,
      vendorName: c.vendorName,
      amount: c.amount,
      deviationFromMedianPercent: fromMedian,
      deviationFromEstimatePercent: fromEstimate,
      verdict,
      requiresJustification:
        verdict === "abnormally_low" && !justifiedSubmissionIds.has(c.submissionId),
      note,
    };
  });
  return { median, assessments };
}

export function abnormalPricingFindings(
  pkg: PackageFacts,
  assessments: readonly AbnormalityAssessment[],
): IntegrityFinding[] {
  return assessments
    .filter((a) => a.verdict !== "normal")
    .map((a) => ({
      detector:
        a.verdict === "abnormally_low"
          ? ("bid_integrity_abnormally_low" as const)
          : ("bid_integrity_abnormally_high" as const),
      severity: a.verdict === "abnormally_low" ? ("high" as const) : ("low" as const),
      confidence: 0.8,
      title:
        `${a.vendorName ?? a.vendorId} bid ${a.verdict === "abnormally_low" ? "well below" : "well above"} ` +
        `the field on ${pkg.reference}`,
      explanation: a.note,
      key: `${a.verdict}:${a.submissionId}`,
      statistic: {
        amount: a.amount,
        currency: pkg.currency,
        deviationFromMedianPercent: a.deviationFromMedianPercent,
        deviationFromEstimatePercent: a.deviationFromEstimatePercent,
      },
      evidence: {
        packageId: pkg.packageId,
        packageReference: pkg.reference,
        submissionId: a.submissionId,
        vendorId: a.vendorId,
      },
      subjectType: "bid_submission" as const,
      subjectId: a.submissionId,
    }));
}

/* ------------------------------------------------------------------ */
/* 5. Unbalanced bids and front-loading                                */
/* ------------------------------------------------------------------ */

export interface UnbalancedCell {
  key: string;
  description: string;
  position: number;
  rate: number;
  medianRate: number;
  ratio: number;
  section: "early" | "middle" | "late";
  flag: "front_loaded" | "starved" | null;
}

export interface UnbalancedAssessment {
  submissionId: string;
  vendorId: string;
  vendorName: string | null;
  comparedLines: number;
  frontLoadedLines: number;
  starvedLines: number;
  /**
   * How much of the bid's value has been shifted into the first third
   * relative to the median bidder, as a percent of the bid total. This is
   * the number that matters: it is what the bidder gets paid early and never
   * has to earn back if the job stops.
   */
  frontLoadingShiftPercent: number | null;
  unbalanced: boolean;
  note: string;
  cells: UnbalancedCell[];
}

/**
 * Front-loading is the oldest trick in measured contracts: price the early
 * items high and the late ones low, get paid most of the contract sum in the
 * first few valuations, and leave the buyer holding an unfinished job with
 * no money left in it. It is invisible in the total — the bid can be the
 * lowest — and obvious in the rates.
 */
export function assessUnbalancedBids(
  pkg: PackageFacts,
  contenders: readonly ContenderFacts[],
  lines: readonly RateFacts[],
  t: IntegrityThresholds = DEFAULT_INTEGRITY_THRESHOLDS,
): UnbalancedAssessment[] {
  const contenderIds = new Set(contenders.map((c) => c.submissionId));
  const relevant = lines.filter(
    (l) => contenderIds.has(l.submissionId) && l.unitRate !== null && Number.isFinite(l.unitRate),
  );
  if (relevant.length === 0) return [];

  // Median rate per scope row, across every contender that priced it.
  const byKey = new Map<string, { rates: number[]; position: number; description: string }>();
  for (const line of relevant) {
    const entry = byKey.get(line.key) ?? {
      rates: [],
      position: line.position,
      description: line.description,
    };
    entry.rates.push(line.unitRate as number);
    entry.position = Math.min(entry.position, line.position);
    byKey.set(line.key, entry);
  }
  const orderedKeys = [...byKey.entries()]
    .filter(([, v]) => v.rates.length >= 3)
    .sort((a, b) => a[1].position - b[1].position)
    .map(([k]) => k);
  if (orderedKeys.length < 6) return [];
  const third = Math.max(1, Math.floor(orderedKeys.length / 3));
  const sectionOf = (index: number): UnbalancedCell["section"] =>
    index < third ? "early" : index >= orderedKeys.length - third ? "late" : "middle";

  const medians = new Map<string, number>();
  for (const key of orderedKeys) {
    const entry = byKey.get(key);
    if (!entry) continue;
    const m = medianUnsorted(entry.rates);
    if (m !== null && m > 0) medians.set(key, m);
  }

  return contenders.map((c) => {
    const own = new Map<string, RateFacts>();
    for (const line of relevant) {
      if (line.submissionId === c.submissionId) own.set(line.key, line);
    }
    const cells: UnbalancedCell[] = [];
    let earlyOwn = 0;
    let earlyMedian = 0;
    let totalOwn = 0;
    let totalMedian = 0;
    orderedKeys.forEach((key, index) => {
      const line = own.get(key);
      const median = medians.get(key);
      const entry = byKey.get(key);
      if (!line || median === undefined || line.unitRate === null || !entry) return;
      const ratio = round4(line.unitRate / median);
      const section = sectionOf(index);
      const quantity = line.quantity !== null && Number.isFinite(line.quantity) ? line.quantity : 1;
      const ownValue = line.unitRate * quantity;
      const medianValue = median * quantity;
      totalOwn += ownValue;
      totalMedian += medianValue;
      if (section === "early") {
        earlyOwn += ownValue;
        earlyMedian += medianValue;
      }
      const flag =
        section === "early" && ratio >= t.frontLoadRateMultiple
          ? ("front_loaded" as const)
          : section === "late" && ratio <= t.backLoadRateShare
            ? ("starved" as const)
            : null;
      cells.push({
        key,
        description: entry.description,
        position: index,
        rate: round2(line.unitRate),
        medianRate: round2(median),
        ratio,
        section,
        flag,
      });
    });

    const frontLoaded = cells.filter((x) => x.flag === "front_loaded").length;
    const starved = cells.filter((x) => x.flag === "starved").length;
    const shift =
      totalOwn > 0 && totalMedian > 0
        ? round2((earlyOwn / totalOwn - earlyMedian / totalMedian) * 100)
        : null;
    const unbalanced = frontLoaded > 0 && starved > 0;
    return {
      submissionId: c.submissionId,
      vendorId: c.vendorId,
      vendorName: c.vendorName,
      comparedLines: cells.length,
      frontLoadedLines: frontLoaded,
      starvedLines: starved,
      frontLoadingShiftPercent: shift,
      unbalanced,
      note: unbalanced
        ? `${frontLoaded} early item(s) are priced at or above ${t.frontLoadRateMultiple}x the ` +
          `median rate while ${starved} late item(s) sit at or below ${Math.round(
            t.backLoadRateShare * 100,
          )}% of it` +
          (shift !== null
            ? `, shifting ${shift}% of the bid's value into the first third of the programme`
            : "") +
          ". An unbalanced bid is paid most of its money before it has done most of its work: " +
          "if the job stops, the buyer is holding an unfinished contract with nothing left in " +
          "it to finish with. Ask for the rate build-ups before this bid is recommended."
        : cells.length === 0
          ? "No comparable priced lines: this bidder did not price the rows the others did, so " +
            "the balance of their rates cannot be tested."
          : "Rates track the market across the programme; no front-loading detected.",
      cells,
    };
  });
}

export function unbalancedFindings(
  pkg: PackageFacts,
  assessments: readonly UnbalancedAssessment[],
): IntegrityFinding[] {
  return assessments
    .filter((a) => a.unbalanced)
    .map((a) => ({
      detector: "bid_integrity_unbalanced_bid" as const,
      severity: "high" as const,
      confidence: round4(
        Math.min(0.9, 0.4 + (a.frontLoadedLines + a.starvedLines) / Math.max(a.comparedLines, 1)),
      ),
      title: `${a.vendorName ?? a.vendorId}'s rates on ${pkg.reference} are front-loaded`,
      explanation: a.note,
      key: `unbalanced:${a.submissionId}`,
      statistic: {
        comparedLines: a.comparedLines,
        frontLoadedLines: a.frontLoadedLines,
        starvedLines: a.starvedLines,
        frontLoadingShiftPercent: a.frontLoadingShiftPercent,
      },
      evidence: {
        packageId: pkg.packageId,
        packageReference: pkg.reference,
        submissionId: a.submissionId,
        vendorId: a.vendorId,
        cells: a.cells.filter((c) => c.flag !== null).slice(0, 40),
      },
      subjectType: "bid_submission" as const,
      subjectId: a.submissionId,
    }));
}

/* ------------------------------------------------------------------ */
/* 6. Cross-package patterns (Domain A #12, #14)                       */
/* ------------------------------------------------------------------ */

export interface PackageHistoryFacts {
  packageId: string;
  reference: string;
  tradeCode: string | null;
  awardedAt: string | null;
  winnerVendorId: string | null;
  /** every vendor that submitted a bid in contention */
  bidderVendorIds: string[];
  /** every vendor invited, whether or not they bid */
  invitedVendorIds: string[];
  /** vendors that withdrew or declined after expressing an intent to bid */
  withdrawnVendorIds: string[];
  /** the winner arrived after the deadline and was let in */
  winnerWasLate: boolean;
  winnerSubmissionId: string | null;
}

const vendorLabel = (id: string, names: ReadonlyMap<string, string>): string =>
  names.get(id) ?? id;

/**
 * COVER BIDDING. The signature is not that one company wins a lot — a good
 * company should. It is that one particular company keeps turning up as the
 * loser to one particular winner, package after package, in the same trade,
 * while never winning anything itself. That is a firm being paid, in kind, to
 * make the field look competitive.
 */
export function detectCoverBidding(
  history: readonly PackageHistoryFacts[],
  vendorNames: ReadonlyMap<string, string>,
  t: IntegrityThresholds = DEFAULT_INTEGRITY_THRESHOLDS,
): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  const byTrade = new Map<string, PackageHistoryFacts[]>();
  for (const pkg of history) {
    if (!pkg.winnerVendorId) continue;
    const trade = pkg.tradeCode ?? "__untraded__";
    byTrade.set(trade, [...(byTrade.get(trade) ?? []), pkg]);
  }
  for (const [trade, packages] of byTrade) {
    const ordered = [...packages].sort((a, b) =>
      (a.awardedAt ?? "").localeCompare(b.awardedAt ?? ""),
    );
    const recent = ordered.slice(-t.coverBiddingWindow);
    if (recent.length < t.coverBiddingLosses) continue;
    const pairs = new Map<string, { loser: string; winner: string; packages: string[] }>();
    for (const pkg of recent) {
      const winner = pkg.winnerVendorId;
      if (!winner) continue;
      for (const bidder of pkg.bidderVendorIds) {
        if (bidder === winner) continue;
        const key = `${bidder}->${winner}`;
        const entry = pairs.get(key) ?? { loser: bidder, winner, packages: [] };
        entry.packages.push(pkg.packageId);
        pairs.set(key, entry);
      }
    }
    for (const entry of pairs.values()) {
      if (entry.packages.length < t.coverBiddingLosses) continue;
      const everWon = recent.some((p) => p.winnerVendorId === entry.loser);
      if (everWon) continue;
      findings.push({
        detector: "bid_integrity_cover_bidding",
        severity: entry.packages.length >= t.coverBiddingWindow ? "high" : "medium",
        confidence: round4(Math.min(0.9, 0.35 + entry.packages.length * 0.12)),
        title:
          `${vendorLabel(entry.loser, vendorNames)} has lost to ` +
          `${vendorLabel(entry.winner, vendorNames)} in ${entry.packages.length} of the last ` +
          `${recent.length} ${trade === "__untraded__" ? "packages" : `${trade} packages`}`,
        explanation:
          `${vendorLabel(entry.loser, vendorNames)} bid against ` +
          `${vendorLabel(entry.winner, vendorNames)} ${entry.packages.length} time(s) in the ` +
          `trailing ${recent.length} package(s) of this trade and never won one of them. Losing ` +
          "is ordinary; losing repeatedly to the same company while winning nothing is the " +
          "shape of cover bidding, where a firm submits a deliberately uncompetitive price so " +
          "the intended winner has a field to be cheapest in. Compare the losing prices against " +
          "the winner's: cover prices are usually a round percentage above, and cluster. Check " +
          "whether the two companies share directors, an address, a bank account or a parent.",
        key: `cover_bidding:${trade}:${entry.loser}:${entry.winner}`,
        statistic: {
          losses: entry.packages.length,
          windowPackages: recent.length,
          tradeCode: trade === "__untraded__" ? null : trade,
        },
        evidence: {
          tradeCode: trade === "__untraded__" ? null : trade,
          loserVendorId: entry.loser,
          winnerVendorId: entry.winner,
          packageIds: entry.packages,
          packageReferences: recent
            .filter((p) => entry.packages.includes(p.packageId))
            .map((p) => p.reference),
        },
        subjectType: "vendor",
        subjectId: entry.loser,
      });
    }
  }
  return findings;
}

/**
 * MARKET ALLOCATION / BID ROTATION. Where a group has carved up a market,
 * the wins do not concentrate — they SPREAD, evenly and in turn, because
 * that is the deal. So the detector looks for the opposite of what a naive
 * concentration check would look for: an unusually even distribution of wins
 * combined with an unusually high rate of alternation, across a stable
 * bidder set.
 */
export function detectWinnerRotation(
  history: readonly PackageHistoryFacts[],
  vendorNames: ReadonlyMap<string, string>,
  t: IntegrityThresholds = DEFAULT_INTEGRITY_THRESHOLDS,
): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  const byTrade = new Map<string, PackageHistoryFacts[]>();
  for (const pkg of history) {
    if (!pkg.winnerVendorId || !pkg.tradeCode) continue;
    byTrade.set(pkg.tradeCode, [...(byTrade.get(pkg.tradeCode) ?? []), pkg]);
  }
  for (const [trade, packages] of byTrade) {
    if (packages.length < t.rotationMinPackages) continue;
    const ordered = [...packages].sort((a, b) =>
      (a.awardedAt ?? "").localeCompare(b.awardedAt ?? ""),
    );
    const sequence = ordered
      .map((p) => p.winnerVendorId)
      .filter((v): v is string => v !== null);
    const counts = new Map<string, number>();
    for (const winner of sequence) counts.set(winner, (counts.get(winner) ?? 0) + 1);
    if (counts.size < 3) continue;
    const entropy = normalisedEntropy([...counts.values()]);
    const alternation = alternationRate(sequence);
    if (entropy === null || alternation === null) continue;
    // The rota signature: wins spread almost perfectly evenly (high entropy)
    // AND the winner changing almost every time (high alternation).
    if (entropy < 0.95 || alternation < 0.9) continue;
    findings.push({
      detector: "bid_integrity_winner_rotation",
      severity: "medium",
      confidence: round4(Math.min(0.85, 0.3 + entropy * 0.3 + alternation * 0.25)),
      title: `Wins in trade ${trade} rotate almost perfectly between ${counts.size} bidders`,
      explanation:
        `Across ${sequence.length} awarded ${trade} packages, ${counts.size} bidders each won ` +
        `${[...counts.values()].join("/")} of them, and the winner changed on ` +
        `${Math.round(alternation * 100)}% of consecutive awards (normalised win entropy ` +
        `${entropy}). Genuine competition is lumpy: a company on form wins two or three in a ` +
        "row, then loses several. A distribution this even, alternating this reliably, is the " +
        "shape of an agreed rota — each firm taking its turn while the others price to lose. " +
        "Compare the losing margins across these packages: under a rota they are usually " +
        "consistent, because the losers are told what to write.",
      key: `winner_rotation:${trade}`,
      statistic: {
        packages: sequence.length,
        distinctWinners: counts.size,
        normalisedEntropy: entropy,
        alternationRate: alternation,
      },
      evidence: {
        tradeCode: trade,
        packageIds: ordered.map((p) => p.packageId),
        sequence: sequence.map((v) => ({ vendorId: v, vendorName: vendorLabel(v, vendorNames) })),
        wins: [...counts.entries()].map(([vendorId, n]) => ({
          vendorId,
          vendorName: vendorLabel(vendorId, vendorNames),
          wins: n,
        })),
      },
      subjectType: "company",
      subjectId: trade,
    });
  }
  return findings;
}

/**
 * THE SAME ROOM EVERY TIME. An invitation list that never changes is not
 * evidence of wrongdoing, but it is evidence that the market is not being
 * tested — and it is the precondition every allocation scheme needs.
 */
export function detectRepeatInvitationSets(
  history: readonly PackageHistoryFacts[],
  vendorNames: ReadonlyMap<string, string>,
): IntegrityFinding[] {
  const bySet = new Map<string, { vendorIds: string[]; packages: PackageHistoryFacts[] }>();
  for (const pkg of history) {
    if (pkg.invitedVendorIds.length < 3) continue;
    const sorted = [...new Set(pkg.invitedVendorIds)].sort();
    const key = sorted.join("|");
    const entry = bySet.get(key) ?? { vendorIds: sorted, packages: [] };
    entry.packages.push(pkg);
    bySet.set(key, entry);
  }
  const findings: IntegrityFinding[] = [];
  for (const [key, entry] of bySet) {
    if (entry.packages.length < 3) continue;
    findings.push({
      detector: "bid_integrity_repeat_invitation_set",
      severity: "low",
      confidence: 0.5,
      title: `The same ${entry.vendorIds.length} bidders were invited to ${entry.packages.length} packages`,
      explanation:
        `${entry.packages.map((p) => p.reference).join(", ")} were all issued to exactly ` +
        `${entry.vendorIds.map((v) => vendorLabel(v, vendorNames)).join(", ")} and to nobody ` +
        "else. A stable, closed bidder list is where cover bidding and market allocation live, " +
        "because the same firms meet each other every time and know they will meet again. It is " +
        "also, quite often, simply the shortlist of firms who are any good at this trade. The " +
        "test is whether anyone outside the list has been invited in the last year, and whether " +
        "the prices have moved.",
      key: `repeat_invitation_set:${key}`,
      statistic: {
        packages: entry.packages.length,
        bidders: entry.vendorIds.length,
      },
      evidence: {
        vendorIds: entry.vendorIds,
        vendorNames: entry.vendorIds.map((v) => vendorLabel(v, vendorNames)),
        packageIds: entry.packages.map((p) => p.packageId),
        packageReferences: entry.packages.map((p) => p.reference),
      },
      subjectType: "company",
      subjectId: key.slice(0, 60),
    });
  }
  return findings;
}

/** A bidder that repeatedly walks away after seeing who else is in the room. */
export function detectWithdrawalPatterns(
  history: readonly PackageHistoryFacts[],
  vendorNames: ReadonlyMap<string, string>,
): IntegrityFinding[] {
  const counts = new Map<string, string[]>();
  for (const pkg of history) {
    for (const vendorId of pkg.withdrawnVendorIds) {
      counts.set(vendorId, [...(counts.get(vendorId) ?? []), pkg.packageId]);
    }
  }
  const findings: IntegrityFinding[] = [];
  for (const [vendorId, packageIds] of counts) {
    if (packageIds.length < 3) continue;
    const won = history.filter((p) => p.winnerVendorId === vendorId).length;
    findings.push({
      detector: "bid_integrity_withdrawal_pattern",
      severity: won === 0 ? "medium" : "low",
      confidence: round4(Math.min(0.8, 0.3 + packageIds.length * 0.1)),
      title: `${vendorLabel(vendorId, vendorNames)} withdrew from ${packageIds.length} tenders after committing to bid`,
      explanation:
        `${vendorLabel(vendorId, vendorNames)} confirmed an intent to bid and then withdrew or ` +
        `declined on ${packageIds.length} package(s), winning ${won}. A firm that repeatedly ` +
        "takes a place in the field and then vacates it is either chronically over-committed — " +
        "which is a prequalification finding about their capacity — or is holding a place so the " +
        "package looks competitive until the moment it does not matter. Either way the packages " +
        "they left went to market with fewer real bidders than the record shows.",
      key: `withdrawal_pattern:${vendorId}`,
      statistic: { withdrawals: packageIds.length, wins: won },
      evidence: { vendorId, packageIds },
      subjectType: "vendor",
      subjectId: vendorId,
    });
  }
  return findings;
}

/** A late bid that was let in and then won. */
export function detectLateSubmissionWins(
  history: readonly PackageHistoryFacts[],
  vendorNames: ReadonlyMap<string, string>,
): IntegrityFinding[] {
  return history
    .filter((p) => p.winnerWasLate && p.winnerVendorId)
    .map((p) => ({
      detector: "bid_integrity_late_submission_win" as const,
      severity: "high" as const,
      confidence: 0.85,
      title: `The winning bid on ${p.reference} arrived after the deadline`,
      explanation:
        `${vendorLabel(p.winnerVendorId ?? "", vendorNames)} submitted after the published bid ` +
        `due time on ${p.reference}, was accepted late, and was then awarded the package. A ` +
        "late bid is a bid submitted with knowledge nobody else had: the deadline had passed, " +
        "the other envelopes were in the room, and the only thing standing between that and a " +
        "priced advantage is the integrity of whoever held them. The late acceptance was " +
        "recorded with a reason, which is the control working — but a late bid that then wins " +
        "is the specific outcome the control exists to make visible, and it should be reviewed " +
        "by somebody who was not in the evaluation.",
      key: `late_submission_win:${p.packageId}`,
      statistic: { packageId: p.packageId },
      evidence: {
        packageId: p.packageId,
        packageReference: p.reference,
        vendorId: p.winnerVendorId,
        submissionId: p.winnerSubmissionId,
      },
      subjectType: "bid_package" as const,
      subjectId: p.packageId,
    }));
}

/* ------------------------------------------------------------------ */
/* 7. Approval behaviour (Domain A #37, #38)                           */
/* ------------------------------------------------------------------ */

export interface ApprovalFacts {
  awardId: string;
  reference: string;
  packageId: string;
  projectId: string;
  vendorId: string;
  awardAmount: number;
  currency: string;
  recommendedAt: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
}

/**
 * An approval fifteen minutes after the recommendation is a signature, not a
 * review — nobody read the levelling, the scores and the not-lowest
 * justification in that time. And an award signed at 03:40 was signed by
 * somebody who did not want to be interrupted.
 */
export function detectApprovalBehaviour(
  award: ApprovalFacts,
  t: IntegrityThresholds = DEFAULT_INTEGRITY_THRESHOLDS,
): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  const recMs = award.recommendedAt ? Date.parse(award.recommendedAt) : Number.NaN;
  const appMs = award.approvedAt ? Date.parse(award.approvedAt) : Number.NaN;
  if (Number.isFinite(recMs) && Number.isFinite(appMs) && appMs >= recMs) {
    const minutes = round2((appMs - recMs) / 60_000);
    if (minutes < t.approvalVelocityMinutes) {
      findings.push({
        detector: "bid_integrity_approval_velocity",
        severity: minutes < 2 ? "high" : "medium",
        confidence: round4(Math.min(0.9, 0.5 + (t.approvalVelocityMinutes - minutes) / 40)),
        title: `Award ${award.reference} was approved ${minutes} minute(s) after it was recommended`,
        explanation:
          `The recommendation on ${award.reference} (${award.currency} ${award.awardAmount}) was ` +
          `approved ${minutes} minute(s) after it was made. Approval is meant to be a second ` +
          "person independently satisfying themselves about the levelling, the scores, whether " +
          "the lowest bid was taken and, if not, why not. That reading takes longer than this. " +
          "Either the approver had already reviewed the package before the recommendation was " +
          "formally entered — in which case say so on the record — or the approval was a " +
          "keystroke, and the segregation of duties this platform enforces is being satisfied " +
          "in form rather than in substance.",
        key: `approval_velocity:${award.awardId}`,
        statistic: {
          minutesBetween: minutes,
          thresholdMinutes: t.approvalVelocityMinutes,
          awardAmount: award.awardAmount,
          currency: award.currency,
        },
        evidence: {
          awardId: award.awardId,
          reference: award.reference,
          packageId: award.packageId,
          approvedBy: award.approvedBy,
          recommendedAt: award.recommendedAt,
          approvedAt: award.approvedAt,
        },
        subjectType: "bid_award",
        subjectId: award.awardId,
      });
    }
  }
  if (Number.isFinite(appMs)) {
    const at = new Date(appMs);
    const hour = at.getUTCHours();
    const day = at.getUTCDay();
    const weekend = day === 0 || day === 6;
    if (weekend || hour < t.workingHourStart || hour >= t.workingHourEnd) {
      findings.push({
        detector: "bid_integrity_out_of_hours_approval",
        severity: "low",
        confidence: 0.5,
        title: `Award ${award.reference} was approved outside working hours`,
        explanation:
          `${award.reference} was approved at ${award.approvedAt} (UTC ` +
          `${String(hour).padStart(2, "0")}:00${weekend ? ", at a weekend" : ""}). Out-of-hours ` +
          "approvals are not wrong in themselves — construction does not keep office hours — " +
          "but they are the single most common attribute of approvals nobody else saw. Taken " +
          "with the velocity of the approval and the size of the award, it is worth knowing " +
          "which of these were signed when the office was empty.",
        key: `out_of_hours_approval:${award.awardId}`,
        statistic: {
          approvalHourUtc: hour,
          weekend: weekend ? 1 : 0,
          workingHours: `${t.workingHourStart}:00–${t.workingHourEnd}:00 UTC`,
          awardAmount: award.awardAmount,
        },
        evidence: {
          awardId: award.awardId,
          reference: award.reference,
          packageId: award.packageId,
          approvedBy: award.approvedBy,
          approvedAt: award.approvedAt,
        },
        subjectType: "bid_award",
        subjectId: award.awardId,
      });
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* The package-level run                                               */
/* ------------------------------------------------------------------ */

export interface PackageIntegrityResult {
  findings: IntegrityFinding[];
  dispersion: Dispersion;
  abnormal: { median: number | null; assessments: AbnormalityAssessment[] };
  unbalanced: UnbalancedAssessment[];
  /** detectors that could not run, and why — never a silent skip */
  notRun: { detector: string; reason: string }[];
}

/**
 * Every within-package detector, run over one package's facts. The `notRun`
 * list matters as much as the findings: "no findings" and "no detector could
 * run because only two bidders priced anything" are different answers, and
 * only one of them is reassuring.
 */
export function runPackageIntegrity(
  pkg: PackageFacts,
  contenders: readonly ContenderFacts[],
  lines: readonly RateFacts[],
  justifiedSubmissionIds: ReadonlySet<string> = new Set(),
  t: IntegrityThresholds = DEFAULT_INTEGRITY_THRESHOLDS,
): PackageIntegrityResult {
  const notRun: { detector: string; reason: string }[] = [];
  const priced = contenders.filter((c) => c.amount !== null);
  const currencies = new Set(priced.map((c) => c.currency.toUpperCase()));

  if (priced.length < 3) {
    notRun.push({
      detector: "bid_integrity_price_clustering",
      reason:
        `Only ${priced.length} contender(s) carry a comparable amount. Dispersion across fewer ` +
        "than three bids is not a statistic; two bids are a quotation, not a market.",
    });
  }
  if (currencies.size > 1) {
    notRun.push({
      detector: "bid_integrity_price_clustering",
      reason:
        `Contenders are priced in ${[...currencies].join(", ")}. Amounts in different currencies ` +
        "are never compared here — no rate is on the record.",
    });
  }
  const ratedLines = lines.filter((l) => l.unitRate !== null);
  if (ratedLines.length === 0) {
    notRun.push({
      detector: "bid_integrity_identical_rates",
      reason:
        "No priced line on this package carries a unit rate, so no rate-level comparison is " +
        "possible. Rate-level detectors need a bill, not a lump sum.",
    });
  }

  const findings = [
    ...detectPriceClustering(pkg, contenders, t),
    ...detectIdenticalRates(pkg, contenders, lines, t),
    ...detectConstantRatio(pkg, contenders, lines, t),
    ...detectSubmissionClustering(pkg, contenders, t),
  ];
  const abnormal = assessAbnormalPricing(pkg, contenders, justifiedSubmissionIds, t);
  findings.push(...abnormalPricingFindings(pkg, abnormal.assessments));
  const unbalanced = assessUnbalancedBids(pkg, contenders, lines, t);
  findings.push(...unbalancedFindings(pkg, unbalanced));

  return {
    findings,
    dispersion: dispersionOf(
      priced.map((c) => c.amount).filter((a): a is number => a !== null),
    ),
    abnormal,
    unbalanced,
    notRun,
  };
}

/** Every cross-package detector, run over a company's award history. */
export function runCompanyIntegrity(
  history: readonly PackageHistoryFacts[],
  vendorNames: ReadonlyMap<string, string>,
  t: IntegrityThresholds = DEFAULT_INTEGRITY_THRESHOLDS,
): IntegrityFinding[] {
  return [
    ...detectCoverBidding(history, vendorNames, t),
    ...detectWinnerRotation(history, vendorNames, t),
    ...detectRepeatInvitationSets(history, vendorNames),
    ...detectWithdrawalPatterns(history, vendorNames),
    ...detectLateSubmissionWins(history, vendorNames),
  ];
}
