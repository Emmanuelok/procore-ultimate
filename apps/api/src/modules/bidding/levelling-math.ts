import type { LevellingInclusion, LevellingItemCategory } from "@constructos/shared";
import { CENT, distinctCurrencies, known, round2, round4, unknowable, type Unknowable } from "./shared.js";

/**
 * LEVELLING ARITHMETIC — the analytical core of the module, kept pure so it
 * can be argued with.
 *
 * Two bids are never comparable as submitted. One excludes the scaffold, one
 * prices a provisional sum the others left out, a third corrects a quantity
 * it thinks is wrong. Levelling maps every bidder onto the SAME neutral scope
 * rows and states, per row, what was included and what we adjusted it by:
 *
 *     levelledAmount = asBidAmount + adjustmentAmount
 *
 * That one line is the easy half. The hard half is refusing to produce a
 * number when the inputs do not support one, and the table below is the whole
 * of that judgement:
 *
 *   included            asBid + adjustment. No amount ⇒ NULL: "included" with
 *                       no figure is a claim, not a price.
 *   partially_included  asBid + adjustment, and the adjustment may not be
 *                       zero — a partial inclusion levelled at its face value
 *                       is simply not levelled.
 *   excluded            the adjustment alone (what buying the scope elsewhere
 *                       costs). Zero adjustment ⇒ NULL: an exclusion priced
 *                       at nothing silently makes the cheapest bidder the one
 *                       who excluded the most.
 *   unclear             NULL — raise a clarification; do not guess.
 *   not_priced          NULL — the bidder did not price it.
 *
 * And in every case an adjustment with no stated reason yields NULL. Without
 * the reason, levelling is an opinion and the losing bidder's challenge
 * succeeds.
 *
 * `exclusion_check` rows carry no price at all: they exist only to force an
 * in-or-out answer, so they are never summed and are "covered" when the
 * bidder has said definitely in or definitely out.
 */

export interface LevellingItemFacts {
  id: string;
  itemCode: string | null;
  description: string;
  category: LevellingItemCategory;
  isMandatory: boolean;
  engineersEstimate: number | null;
  currency: string;
}

export interface LevellingEntryFacts {
  levellingItemId: string;
  submissionId: string;
  includedStatus: LevellingInclusion;
  asBidAmount: number | null;
  adjustmentAmount: number;
  adjustmentReason: string | null;
  currency: string;
}

export interface LevelledCell {
  levellingItemId: string;
  submissionId: string;
  itemCode: string | null;
  description: string;
  category: LevellingItemCategory;
  isMandatory: boolean;
  includedStatus: LevellingInclusion;
  asBidAmount: number | null;
  adjustmentAmount: number;
  adjustmentReason: string | null;
  currency: string;
  /** the like-for-like figure, or null with reasons — never a fabricated 0 */
  levelledAmount: number | null;
  reasons: string[];
  /** false for exclusion_check rows, which carry no money by design */
  priceable: boolean;
  /** the bidder has given a usable answer for this row */
  covered: boolean;
}

/** A row that carries money. `exclusion_check` is the only one that does not. */
export function isPriceableCategory(category: LevellingItemCategory): boolean {
  return category !== "exclusion_check";
}

const label = (item: LevellingItemFacts): string =>
  item.itemCode ? `${item.itemCode} (${item.description})` : item.description;

/**
 * Level ONE bidder's answer to ONE scope row. See the table in the file
 * header for the rule this implements.
 */
export function levelEntry(
  item: LevellingItemFacts,
  entry: LevellingEntryFacts,
): LevelledCell {
  const reasons: string[] = [];
  const priceable = isPriceableCategory(item.category);
  const adjustment = Number.isFinite(entry.adjustmentAmount) ? entry.adjustmentAmount : 0;
  const asBid = entry.asBidAmount;

  const base: Omit<LevelledCell, "levelledAmount" | "reasons" | "covered"> = {
    levellingItemId: item.id,
    submissionId: entry.submissionId,
    itemCode: item.itemCode,
    description: item.description,
    category: item.category,
    isMandatory: item.isMandatory,
    includedStatus: entry.includedStatus,
    asBidAmount: asBid,
    adjustmentAmount: round2(adjustment),
    adjustmentReason: entry.adjustmentReason,
    currency: entry.currency.toUpperCase(),
    priceable,
  };

  if (!priceable) {
    // An exclusion check is answered, not priced. "in" or "out" is the answer.
    const decided =
      entry.includedStatus === "included" || entry.includedStatus === "excluded";
    if (!decided) {
      reasons.push(
        `${label(item)} is an in-or-out check and the bidder's answer is "${entry.includedStatus}". ` +
          "The row exists precisely to stop that answer standing.",
      );
    }
    return { ...base, levelledAmount: null, reasons, covered: decided };
  }

  if (Math.abs(adjustment) > CENT && !entry.adjustmentReason) {
    reasons.push(
      `${label(item)} carries an adjustment of ${round2(adjustment)} with no stated reason. ` +
        "An unexplained adjustment is an opinion, and a losing bidder's challenge to it succeeds.",
    );
    return { ...base, levelledAmount: null, reasons, covered: false };
  }

  switch (entry.includedStatus) {
    case "included": {
      if (asBid === null || !Number.isFinite(asBid)) {
        reasons.push(
          `${label(item)} is marked included but carries no amount. "Included" with no figure ` +
            "is a claim about scope, not a price that can be compared.",
        );
        return { ...base, levelledAmount: null, reasons, covered: false };
      }
      return { ...base, levelledAmount: round2(asBid + adjustment), reasons, covered: true };
    }
    case "partially_included": {
      if (asBid === null || !Number.isFinite(asBid)) {
        reasons.push(
          `${label(item)} is partially included but carries no amount, so there is nothing to ` +
            "adjust from.",
        );
        return { ...base, levelledAmount: null, reasons, covered: false };
      }
      if (Math.abs(adjustment) <= CENT) {
        reasons.push(
          `${label(item)} is partially included but carries no adjustment. A partial inclusion ` +
            "levelled at its face value has not been levelled at all — price the missing part.",
        );
        return { ...base, levelledAmount: null, reasons, covered: false };
      }
      return { ...base, levelledAmount: round2(asBid + adjustment), reasons, covered: true };
    }
    case "excluded": {
      if (asBid !== null && Math.abs(asBid) > CENT) {
        reasons.push(
          `${label(item)} is marked excluded yet carries an as-bid amount of ${round2(asBid)}. ` +
            "Excluded scope is not in the price; correct the inclusion status or the amount.",
        );
        return { ...base, levelledAmount: null, reasons, covered: false };
      }
      if (Math.abs(adjustment) <= CENT) {
        reasons.push(
          `${label(item)} is excluded and carries no adjustment, so the comparison would treat ` +
            "the missing scope as free. That is how the bidder who excluded the most becomes " +
            "the cheapest. Price what buying this scope elsewhere costs.",
        );
        return { ...base, levelledAmount: null, reasons, covered: false };
      }
      return { ...base, levelledAmount: round2(adjustment), reasons, covered: true };
    }
    case "unclear": {
      reasons.push(
        `${label(item)} — the bidder's position is unclear. Raise a tender query and record the ` +
          "answer; an assumption made here decides the award on our guess, not their price.",
      );
      return { ...base, levelledAmount: null, reasons, covered: false };
    }
    case "not_priced":
    default: {
      reasons.push(`${label(item)} was not priced by this bidder.`);
      return { ...base, levelledAmount: null, reasons, covered: false };
    }
  }
}

export interface LevellingGap {
  levellingItemId: string;
  itemCode: string | null;
  description: string;
  isMandatory: boolean;
  reason: string;
}

export interface SubmissionLevelling {
  submissionId: string;
  currency: string | null;
  cells: LevelledCell[];
  /** priceable rows this bidder has given a usable answer for */
  itemsCovered: number;
  itemsTotal: number;
  mandatoryCovered: number;
  mandatoryTotal: number;
  /** every mandatory row (priceable or check) without a usable answer */
  gaps: LevellingGap[];
  asBidSubtotal: Unknowable;
  adjustmentSubtotal: Unknowable;
  /** the sum of the cells that DO have a figure — explicitly partial */
  pricedSubtotal: Unknowable;
  /** the comparable number, or null with the reasons it cannot be produced */
  levelledTotal: Unknowable;
}

/**
 * Level one bidder across every scope row. A missing entry is treated exactly
 * as `not_priced` — silence is not agreement.
 */
export function levelSubmission(
  submissionId: string,
  items: readonly LevellingItemFacts[],
  entries: readonly LevellingEntryFacts[],
  fallbackCurrency = "USD",
): SubmissionLevelling {
  const mine = entries.filter((e) => e.submissionId === submissionId);
  const byItem = new Map(mine.map((e) => [e.levellingItemId, e] as const));
  const cells: LevelledCell[] = [];
  const gaps: LevellingGap[] = [];

  for (const item of items) {
    const entry: LevellingEntryFacts = byItem.get(item.id) ?? {
      levellingItemId: item.id,
      submissionId,
      includedStatus: "not_priced",
      asBidAmount: null,
      adjustmentAmount: 0,
      adjustmentReason: null,
      currency: item.currency,
    };
    const cell = levelEntry(item, entry);
    cells.push(cell);
    if (!cell.covered && item.isMandatory) {
      gaps.push({
        levellingItemId: item.id,
        itemCode: item.itemCode,
        description: item.description,
        isMandatory: true,
        reason:
          cell.reasons[0] ??
          `${label(item)} has no usable answer from this bidder.`,
      });
    }
  }

  const priceable = cells.filter((c) => c.priceable);
  const currencies = distinctCurrencies(mine.map((e) => e.currency));
  const currency = currencies.length === 1 ? currencies[0]! : currencies.length === 0 ? fallbackCurrency.toUpperCase() : null;

  const mixedReason =
    currencies.length > 1
      ? `Entries for this bidder are in ${currencies.join(", ")}. Figures in different ` +
        "currencies are never summed on this platform — level each currency separately, or " +
        "record the rate as a commercial-term adjustment with its source."
      : null;

  const sumOf = (pick: (c: LevelledCell) => number | null): Unknowable => {
    if (mixedReason) return unknowable(mixedReason);
    let total = 0;
    for (const c of priceable) {
      const v = pick(c);
      if (v !== null && Number.isFinite(v)) total += v;
    }
    return known(round2(total));
  };

  const asBidSubtotal = sumOf((c) => c.asBidAmount);
  const adjustmentSubtotal = sumOf((c) => c.adjustmentAmount);
  const pricedSubtotal = sumOf((c) => c.levelledAmount);

  const totalReasons: string[] = [];
  if (mixedReason) totalReasons.push(mixedReason);
  for (const gap of gaps) totalReasons.push(gap.reason);
  const unpricedNonMandatory = priceable.filter((c) => !c.covered && !c.isMandatory);
  for (const c of unpricedNonMandatory) {
    totalReasons.push(
      c.reasons[0] ??
        `${c.itemCode ?? c.description} was not priced by this bidder (optional row).`,
    );
  }

  const levelledTotal: Unknowable =
    totalReasons.length > 0 ? unknowable(...totalReasons) : pricedSubtotal;

  return {
    submissionId,
    currency,
    cells,
    itemsCovered: priceable.filter((c) => c.covered).length,
    itemsTotal: priceable.length,
    mandatoryCovered: cells.filter((c) => c.isMandatory && c.covered).length,
    mandatoryTotal: cells.filter((c) => c.isMandatory).length,
    gaps,
    asBidSubtotal,
    adjustmentSubtotal,
    pricedSubtotal,
    levelledTotal,
  };
}

export interface ComparisonSubmissionFacts {
  id: string;
  vendorId: string;
  vendorName?: string | null;
  reference: string;
  status: string;
  currency: string;
  totalAmount: number | null;
  /** still in contention — see shared.isInContention */
  inContention: boolean;
}

export interface CoverageRow {
  levellingItemId: string;
  itemCode: string | null;
  description: string;
  category: LevellingItemCategory;
  isMandatory: boolean;
  engineersEstimate: number | null;
  /** submission ids that gave a usable answer */
  coveredBy: string[];
  /** submission ids still in contention that did not */
  missingFrom: string[];
}

export interface RankedSubmission {
  submissionId: string;
  levelledAmount: number;
  rank: number;
}

export interface Comparison {
  items: LevellingItemFacts[];
  currencies: string[];
  submissions: SubmissionLevelling[];
  coverage: CoverageRow[];
  /** ranking by levelled amount ascending; null while incomplete */
  ranking: RankedSubmission[] | null;
  /** may this comparison be declared complete and relied on for an award? */
  complete: boolean;
  /** every reason it may not be, each naming a bidder and a scope row */
  blockers: string[];
}

/**
 * The comparison grid: levelling items x submissions, with coverage.
 *
 * `complete` is false while any bidder STILL IN CONTENTION has left a
 * mandatory row unanswered. A bidder who has been marked unsuccessful or has
 * withdrawn no longer blocks anything — their gaps are history — but a bidder
 * who might yet be awarded the work must have priced everything the buyer
 * said was mandatory, or the comparison is comparing different scopes.
 */
export function buildComparison(
  items: readonly LevellingItemFacts[],
  entries: readonly LevellingEntryFacts[],
  submissions: readonly ComparisonSubmissionFacts[],
): Comparison {
  const levelled = submissions.map((s) =>
    levelSubmission(s.id, items, entries, s.currency),
  );
  const byId = new Map(levelled.map((l) => [l.submissionId, l] as const));

  const coverage: CoverageRow[] = items.map((item) => {
    const coveredBy: string[] = [];
    const missingFrom: string[] = [];
    for (const s of submissions) {
      const cell = byId.get(s.id)?.cells.find((c) => c.levellingItemId === item.id);
      if (cell?.covered) coveredBy.push(s.id);
      else if (s.inContention) missingFrom.push(s.id);
    }
    return {
      levellingItemId: item.id,
      itemCode: item.itemCode,
      description: item.description,
      category: item.category,
      isMandatory: item.isMandatory,
      engineersEstimate: item.engineersEstimate,
      coveredBy,
      missingFrom,
    };
  });

  const blockers: string[] = [];
  if (items.length === 0) {
    blockers.push(
      "No levelling items have been defined for this package. There is nothing to compare " +
        "bidders on until the buyer states the scope rows.",
    );
  }
  const contenders = submissions.filter((s) => s.inContention);
  if (contenders.length === 0) {
    blockers.push("No submission is still in contention on this package.");
  }
  for (const s of contenders) {
    const l = byId.get(s.id);
    if (!l) continue;
    for (const gap of l.gaps) {
      blockers.push(
        `${s.reference}: ${gap.itemCode ? `${gap.itemCode} — ` : ""}${gap.reason}`,
      );
    }
  }

  const contenderCurrencies = distinctCurrencies(contenders.map((s) => s.currency));
  if (contenderCurrencies.length > 1) {
    blockers.push(
      `Bids still in contention are priced in ${contenderCurrencies.join(", ")}. Bids in ` +
        "different currencies are never ranked against each other — no rate is on the record " +
        "and inventing one would decide the award on a number nobody supplied.",
    );
  }

  const complete = blockers.length === 0;
  let ranking: RankedSubmission[] | null = null;
  if (complete) {
    const rows = contenders
      .map((s) => ({
        submissionId: s.id,
        levelledAmount: byId.get(s.id)?.levelledTotal.value ?? null,
      }))
      .filter((r): r is { submissionId: string; levelledAmount: number } => r.levelledAmount !== null)
      .sort((a, b) => a.levelledAmount - b.levelledAmount);
    ranking = [];
    let lastAmount: number | null = null;
    let lastRank = 0;
    rows.forEach((row, index) => {
      const rank =
        lastAmount !== null && Math.abs(row.levelledAmount - lastAmount) <= CENT
          ? lastRank
          : index + 1;
      lastAmount = row.levelledAmount;
      lastRank = rank;
      ranking!.push({ ...row, rank });
    });
  }

  return {
    items: [...items],
    currencies: distinctCurrencies(submissions.map((s) => s.currency)),
    submissions: levelled,
    coverage,
    ranking,
    complete,
    blockers,
  };
}

/* ------------------------------------------------------------------ */
/* Scoring — price and quality, with the gaps left visible             */
/* ------------------------------------------------------------------ */

/**
 * A criterion declared on the package BEFORE bids open. Changing the basis
 * once the prices are visible is the classic procurement-integrity failure,
 * so the set is frozen at issue and this arithmetic reads it as given.
 */
export interface CriterionDef {
  key: string;
  label: string;
  weight: number;
  kind: "price" | "quality";
}

export interface CriterionScoreInput {
  key: string;
  score: number | null;
  maxScore: number | null;
  note?: string | null;
}

export interface ScoredCriterion {
  key: string;
  label: string;
  kind: "price" | "quality";
  weight: number;
  score: number | null;
  maxScore: number | null;
  /** score / maxScore in [0,1], null when unscored */
  normalised: number | null;
  /** normalised x weight, null when unscored — NEVER 0 for a missing score */
  weighted: number | null;
  missing: boolean;
  note: string | null;
}

export interface ScoreResult {
  criteria: ScoredCriterion[];
  /** 0-100 on price, or null with reasons */
  commercialScore: Unknowable;
  /** 0-100 on quality, or null with reasons */
  technicalScore: Unknowable;
  /** the weighted total, or null with reasons */
  totalScore: Unknowable;
  reasons: string[];
}

/**
 * Price scores from levelled amounts: the lowest comparable bid scores 100
 * and every other bid scores `lowest / theirs * 100`. A bidder with no
 * comparable amount gets NO price score — not zero.
 */
export function derivePriceScores(
  amounts: readonly { submissionId: string; amount: number | null }[],
): Map<string, Unknowable> {
  const out = new Map<string, Unknowable>();
  const usable = amounts.filter(
    (a): a is { submissionId: string; amount: number } =>
      a.amount !== null && Number.isFinite(a.amount) && a.amount > 0,
  );
  if (usable.length === 0) {
    for (const a of amounts) {
      out.set(
        a.submissionId,
        unknowable(
          "No bid on this package carries a comparable amount, so there is no lowest bid to " +
            "score price against.",
        ),
      );
    }
    return out;
  }
  const lowest = Math.min(...usable.map((a) => a.amount));
  for (const a of amounts) {
    if (a.amount === null || !Number.isFinite(a.amount)) {
      out.set(
        a.submissionId,
        unknowable(
          "This bid has no comparable (levelled) amount, so it cannot be scored on price. " +
            "Complete its levelling first.",
        ),
      );
    } else if (a.amount <= 0) {
      out.set(
        a.submissionId,
        unknowable(
          `This bid's comparable amount is ${a.amount}, which cannot be scored on price — a ` +
            "zero or negative tender is a data error, not the cheapest bid.",
        ),
      );
    } else {
      out.set(a.submissionId, known(round2((lowest / a.amount) * 100)));
    }
  }
  return out;
}

/**
 * Score one bid.
 *
 * THE RULE THAT MATTERS: an unscored criterion is NOT zero. A gap makes the
 * total null and says which criterion is missing. Counting a gap as zero is
 * how a bidder loses an award on a criterion nobody ever assessed them on.
 */
export function scoreSubmission(input: {
  criteria: readonly CriterionDef[];
  scores: readonly CriterionScoreInput[];
  priceWeight: number | null;
  qualityWeight: number | null;
  priceScore: Unknowable;
}): ScoreResult {
  const reasons: string[] = [];
  const byKey = new Map(input.scores.map((s) => [s.key, s] as const));

  const criteria: ScoredCriterion[] = input.criteria.map((c) => {
    const given = byKey.get(c.key);
    const score = given?.score ?? null;
    const maxScore = given?.maxScore ?? null;
    const usable =
      score !== null &&
      Number.isFinite(score) &&
      maxScore !== null &&
      Number.isFinite(maxScore) &&
      maxScore > 0;
    const normalised = usable ? round4(score / maxScore) : null;
    return {
      key: c.key,
      label: c.label,
      kind: c.kind,
      weight: c.weight,
      score,
      maxScore,
      normalised,
      weighted: normalised === null ? null : round4(normalised * c.weight),
      missing: !usable,
      note: given?.note ?? null,
    };
  });

  const qualityCriteria = criteria.filter((c) => c.kind === "quality");
  const qualityMissing = qualityCriteria.filter((c) => c.missing);
  const qualityWeightTotal = qualityCriteria.reduce((sum, c) => sum + c.weight, 0);

  let technicalScore: Unknowable;
  if (qualityCriteria.length === 0) {
    technicalScore = unknowable(
      "No quality criteria are declared on this package, so there is no quality score to give.",
    );
  } else if (qualityWeightTotal <= 0) {
    technicalScore = unknowable(
      "The declared quality criteria carry no weight between them, so a weighted quality " +
        "score cannot be formed.",
    );
  } else if (qualityMissing.length > 0) {
    technicalScore = unknowable(
      ...qualityMissing.map(
        (c) =>
          `Criterion "${c.label}" (${c.key}) has not been scored for this bidder. An unscored ` +
            "criterion counted as zero decides awards wrongly, so no total is produced until " +
            "it is scored or removed from the declared basis.",
      ),
    );
  } else {
    const weighted = qualityCriteria.reduce((sum, c) => sum + (c.weighted ?? 0), 0);
    technicalScore = known(round2((weighted / qualityWeightTotal) * 100));
  }

  // The commercial score is the derived price score unless the package
  // declares explicit price criteria, in which case those are scored like any
  // other and the derived figure is ignored.
  const priceCriteria = criteria.filter((c) => c.kind === "price");
  let commercialScore: Unknowable;
  if (priceCriteria.length > 0) {
    const missing = priceCriteria.filter((c) => c.missing);
    const priceWeightTotal = priceCriteria.reduce((sum, c) => sum + c.weight, 0);
    if (missing.length > 0) {
      commercialScore = unknowable(
        ...missing.map(
          (c) => `Price criterion "${c.label}" (${c.key}) has not been scored for this bidder.`,
        ),
      );
    } else if (priceWeightTotal <= 0) {
      commercialScore = unknowable("The declared price criteria carry no weight between them.");
    } else {
      const weighted = priceCriteria.reduce((sum, c) => sum + (c.weighted ?? 0), 0);
      commercialScore = known(round2((weighted / priceWeightTotal) * 100));
    }
  } else {
    commercialScore = input.priceScore;
  }

  const pw = input.priceWeight;
  const qw = input.qualityWeight;
  const totalReasons: string[] = [];
  if (pw === null || qw === null) {
    totalReasons.push(
      "This package does not declare a price weight and a quality weight, so a combined score " +
        "cannot be formed. Declare the weights before bids open — never after.",
    );
  } else if (pw + qw <= 0) {
    totalReasons.push("The declared price and quality weights sum to zero.");
  }
  if (commercialScore.value === null) totalReasons.push(...commercialScore.reasons);
  if (technicalScore.value === null) totalReasons.push(...technicalScore.reasons);

  const totalScore: Unknowable =
    totalReasons.length > 0
      ? unknowable(...[...new Set(totalReasons)])
      : known(
          round2(
            (commercialScore.value! * pw! + technicalScore.value! * qw!) / (pw! + qw!),
          ),
        );

  if (pw !== null && qw !== null && pw + qw > 0 && Math.abs(pw + qw - 100) > 0.01) {
    reasons.push(
      `Price and quality weights sum to ${round2(pw + qw)}, not 100. The total is normalised ` +
        "by their sum so the score stays on a 0-100 scale, but the declared basis should be " +
        "corrected.",
    );
  }

  return { criteria, commercialScore, technicalScore, totalScore, reasons };
}

export interface RankedScore {
  submissionId: string;
  totalScore: number | null;
  rank: number | null;
  reasons: string[];
}

/**
 * Rank by total score, highest first. A bid with no total is NOT ranked last
 * — it is not ranked at all, and carries the reasons why. Ranking an unscored
 * bid bottom is the same error as scoring its gap zero.
 */
export function rankByScore(
  rows: readonly { submissionId: string; totalScore: Unknowable }[],
): RankedScore[] {
  const scored = rows
    .filter((r) => r.totalScore.value !== null)
    .sort((a, b) => b.totalScore.value! - a.totalScore.value!);
  const ranks = new Map<string, number>();
  let lastScore: number | null = null;
  let lastRank = 0;
  scored.forEach((row, index) => {
    const rank =
      lastScore !== null && Math.abs(row.totalScore.value! - lastScore) <= 0.005
        ? lastRank
        : index + 1;
    lastScore = row.totalScore.value!;
    lastRank = rank;
    ranks.set(row.submissionId, rank);
  });
  return rows.map((r) => ({
    submissionId: r.submissionId,
    totalScore: r.totalScore.value,
    rank: ranks.get(r.submissionId) ?? null,
    reasons: r.totalScore.reasons,
  }));
}
