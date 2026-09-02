/**
 * Multi-criteria decision analysis for portfolio prioritisation.
 * Spec Vol II Domain G #424 (prioritisation and scoring model) and #425 (MCDA
 * with weighting).
 *
 * Pure and deterministic: no database, no clock, no randomness. The route
 * hands it the model's criteria and every candidate's raw scores; it hands
 * back a ranked list where every number carries the weight that produced it
 * and every gap carries its reason.
 *
 * What it deliberately does NOT do: invent a score for a project nobody has
 * scored. A candidate with no entries ranks last with `score: null` and the
 * reason "not scored", because a fabricated zero would read as "scored badly"
 * and that is a different — and defamatory — claim about a project.
 */

import type {
  PortfolioCriterionDirection,
  PortfolioNormalisationMethod,
} from "@constructos/shared";

export interface McdaCriterion {
  key: string;
  label: string;
  description?: string | null;
  /** as the owner entered it — any positive scale; normalised internally */
  weight: number;
  direction: PortfolioCriterionDirection;
  /** the raw entry scale; ignored under relative normalisation */
  min: number;
  max: number;
}

export interface McdaCandidate {
  projectId: string;
  projectName: string;
  /** raw entries by criterion key; a missing key means "not scored" */
  scores: Record<string, number>;
  rationale?: Record<string, string>;
}

export interface McdaCriterionResult {
  key: string;
  label: string;
  direction: PortfolioCriterionDirection;
  weight: number;
  /** share of the model's total weight, 0..1 */
  weightShare: number;
  raw: number | null;
  /** 0..1 after direction and scale are applied */
  normalised: number | null;
  /** weightShare × normalised × 100, renormalised over covered weight */
  contribution: number | null;
  rationale: string | null;
  reason: string | null;
}

export interface McdaRanked {
  projectId: string;
  projectName: string;
  /** 1-based; ties share a rank and the next rank skips (competition ranking) */
  rank: number | null;
  /** 0..100 over the criteria this candidate was actually scored on */
  score: number | null;
  /** share of model weight this candidate has entries for, 0..1 */
  coverage: number;
  scoredCriteria: number;
  criteria: McdaCriterionResult[];
  reasons: string[];
}

export interface McdaInfluence {
  key: string;
  label: string;
  weightShare: number;
  /** how many candidates change rank when this criterion is removed */
  rankChanges: number;
  /** true when removing it changes which project is first */
  changesLeader: boolean;
}

export interface McdaRun {
  method: PortfolioNormalisationMethod;
  criteria: Array<{ key: string; label: string; weight: number; weightShare: number; direction: PortfolioCriterionDirection }>;
  /** criteria dropped from the run and why (e.g. zero weight, no spread) */
  excludedCriteria: Array<{ key: string; reason: string }>;
  ranked: McdaRanked[];
  influence: McdaInfluence[];
  warnings: string[];
}

export class McdaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McdaError";
  }
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Parse and validate a stored `criteria` JSON blob. Throws McdaError with a
 * message the route turns into a 400 — a malformed model must never score.
 */
export function parseCriteria(raw: unknown): McdaCriterion[] {
  if (!Array.isArray(raw)) throw new McdaError("The model's criteria must be a list");
  const out: McdaCriterion[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      throw new McdaError("Each criterion must be an object");
    }
    const c = entry as Record<string, unknown>;
    const key = typeof c["key"] === "string" ? c["key"].trim() : "";
    if (!key) throw new McdaError("Each criterion needs a key");
    if (seen.has(key)) throw new McdaError(`Duplicate criterion key "${key}"`);
    seen.add(key);
    const weight = isFiniteNumber(c["weight"]) ? c["weight"] : 0;
    if (weight < 0) throw new McdaError(`Criterion "${key}" has a negative weight`);
    const direction = c["direction"] === "cost" ? "cost" : "benefit";
    const min = isFiniteNumber(c["min"]) ? c["min"] : 0;
    const max = isFiniteNumber(c["max"]) ? c["max"] : 10;
    if (!(max > min)) throw new McdaError(`Criterion "${key}" needs max greater than min`);
    out.push({
      key,
      label: typeof c["label"] === "string" && c["label"] ? c["label"] : key,
      description: typeof c["description"] === "string" ? c["description"] : null,
      weight,
      direction,
      min,
      max,
    });
  }
  if (out.length === 0) throw new McdaError("A scoring model needs at least one criterion");
  if (out.every((c) => c.weight <= 0)) throw new McdaError("At least one criterion must carry a positive weight");
  return out;
}

interface Prepared {
  criteria: McdaCriterion[];
  excluded: Array<{ key: string; reason: string }>;
  /** per criterion key, the normalisation range actually used */
  ranges: Map<string, { lo: number; hi: number }>;
  totalWeight: number;
}

function prepare(
  criteria: McdaCriterion[],
  candidates: McdaCandidate[],
  method: PortfolioNormalisationMethod,
): Prepared {
  const excluded: Array<{ key: string; reason: string }> = [];
  const ranges = new Map<string, { lo: number; hi: number }>();
  const kept: McdaCriterion[] = [];

  for (const c of criteria) {
    if (c.weight <= 0) {
      excluded.push({ key: c.key, reason: "weight is zero — the criterion cannot affect the ranking" });
      continue;
    }
    if (method === "relative") {
      const values = candidates
        .map((cand) => cand.scores[c.key])
        .filter(isFiniteNumber);
      if (values.length === 0) {
        excluded.push({ key: c.key, reason: "no candidate has been scored on this criterion" });
        continue;
      }
      const lo = Math.min(...values);
      const hi = Math.max(...values);
      if (hi === lo) {
        excluded.push({
          key: c.key,
          reason: "every scored candidate has the same value — relative normalisation cannot separate them",
        });
        continue;
      }
      ranges.set(c.key, { lo, hi });
    } else {
      ranges.set(c.key, { lo: c.min, hi: c.max });
    }
    kept.push(c);
  }

  const totalWeight = kept.reduce((sum, c) => sum + c.weight, 0);
  return { criteria: kept, excluded, ranges, totalWeight };
}

function normaliseOne(
  criterion: McdaCriterion,
  raw: number,
  range: { lo: number; hi: number },
): number {
  const span = range.hi - range.lo;
  if (!(span > 0)) return 0;
  const clamped = Math.min(Math.max(raw, range.lo), range.hi);
  const unit = (clamped - range.lo) / span;
  return criterion.direction === "cost" ? 1 - unit : unit;
}

function scoreCandidate(
  prep: Prepared,
  candidate: McdaCandidate,
): { score: number | null; coverage: number; scoredCriteria: number; criteria: McdaCriterionResult[]; reasons: string[] } {
  const results: McdaCriterionResult[] = [];
  const reasons: string[] = [];
  let coveredWeight = 0;
  let weightedSum = 0;
  let scoredCriteria = 0;

  for (const c of prep.criteria) {
    const weightShare = prep.totalWeight > 0 ? c.weight / prep.totalWeight : 0;
    const raw = candidate.scores[c.key];
    const range = prep.ranges.get(c.key);
    if (!isFiniteNumber(raw) || !range) {
      results.push({
        key: c.key,
        label: c.label,
        direction: c.direction,
        weight: c.weight,
        weightShare,
        raw: null,
        normalised: null,
        contribution: null,
        rationale: candidate.rationale?.[c.key] ?? null,
        reason: "not scored",
      });
      continue;
    }
    const outOfRange = raw < range.lo || raw > range.hi;
    const normalised = normaliseOne(c, raw, range);
    coveredWeight += c.weight;
    weightedSum += c.weight * normalised;
    scoredCriteria += 1;
    results.push({
      key: c.key,
      label: c.label,
      direction: c.direction,
      weight: c.weight,
      weightShare,
      raw,
      normalised,
      contribution: null, // filled below once the covered base is known
      rationale: candidate.rationale?.[c.key] ?? null,
      reason: outOfRange ? `entered value ${raw} is outside the ${range.lo}–${range.hi} scale and was clamped` : null,
    });
  }

  const coverage = prep.totalWeight > 0 ? coveredWeight / prep.totalWeight : 0;
  if (coveredWeight <= 0) {
    reasons.push("no criterion carrying weight has been scored for this project");
    return { score: null, coverage: 0, scoredCriteria: 0, criteria: results, reasons };
  }
  const score = (weightedSum / coveredWeight) * 100;
  for (const r of results) {
    if (r.normalised === null) continue;
    r.contribution = ((r.weight * r.normalised) / coveredWeight) * 100;
  }
  if (coverage < 1) {
    const missing = results.filter((r) => r.reason === "not scored").map((r) => r.label);
    reasons.push(
      `scored on ${Math.round(coverage * 1000) / 10}% of the model's weight; not scored on ${missing.join(", ")}`,
    );
  }
  return { score, coverage, scoredCriteria, criteria: results, reasons };
}

/** Competition ranking: equal scores share a rank, the next rank skips. Unscored candidates rank null. */
function assignRanks(rows: McdaRanked[]): void {
  const scored = rows.filter((r) => r.score !== null);
  scored.sort((a, b) => {
    const diff = (b.score ?? 0) - (a.score ?? 0);
    if (Math.abs(diff) > 1e-9) return diff;
    return a.projectName.localeCompare(b.projectName) || a.projectId.localeCompare(b.projectId);
  });
  let rank = 0;
  let index = 0;
  let previous: number | null = null;
  for (const row of scored) {
    index += 1;
    if (previous === null || Math.abs((row.score ?? 0) - previous) > 1e-9) {
      rank = index;
      previous = row.score ?? 0;
    }
    row.rank = rank;
  }
}

function orderRows(rows: McdaRanked[]): McdaRanked[] {
  return [...rows].sort((a, b) => {
    if (a.rank === null && b.rank === null) return a.projectName.localeCompare(b.projectName);
    if (a.rank === null) return 1;
    if (b.rank === null) return -1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.projectName.localeCompare(b.projectName);
  });
}

function rankMap(rows: McdaRanked[]): Map<string, number | null> {
  return new Map(rows.map((r) => [r.projectId, r.rank]));
}

/**
 * Rank candidates under a model. `method` decides whether raw scores are
 * normalised against the criterion's declared scale (`fixed_scale`) or
 * against the spread actually observed in this candidate set (`relative`);
 * the latter is honest about the fact that its ranks move when the set does.
 */
export function rankPortfolio(
  criteria: McdaCriterion[],
  candidates: McdaCandidate[],
  method: PortfolioNormalisationMethod = "fixed_scale",
): McdaRun {
  const prep = prepare(criteria, candidates, method);
  const warnings: string[] = [];
  if (prep.criteria.length === 0) {
    warnings.push("every criterion was excluded — no ranking is possible");
  }
  if (method === "relative" && candidates.length < 2) {
    warnings.push("relative normalisation with fewer than two candidates has no spread to normalise against");
  }

  const rows: McdaRanked[] = candidates.map((candidate) => {
    const scored = scoreCandidate(prep, candidate);
    return {
      projectId: candidate.projectId,
      projectName: candidate.projectName,
      rank: null,
      score: scored.score,
      coverage: scored.coverage,
      scoredCriteria: scored.scoredCriteria,
      criteria: scored.criteria,
      reasons: scored.reasons,
    };
  });
  assignRanks(rows);
  const ordered = orderRows(rows);

  /* Influence: remove one criterion, re-rank, count who moved. A criterion
     that changes nothing when removed is carrying no decision, however heavy
     its weight looks on the page. */
  const baseline = rankMap(ordered);
  const leader = ordered.find((r) => r.rank === 1)?.projectId ?? null;
  const influence: McdaInfluence[] = [];
  if (prep.criteria.length > 1) {
    for (const c of prep.criteria) {
      const without = prep.criteria.filter((x) => x.key !== c.key);
      const subPrep: Prepared = {
        criteria: without,
        excluded: prep.excluded,
        ranges: prep.ranges,
        totalWeight: without.reduce((sum, x) => sum + x.weight, 0),
      };
      const subRows = candidates.map((candidate) => {
        const scored = scoreCandidate(subPrep, candidate);
        return {
          projectId: candidate.projectId,
          projectName: candidate.projectName,
          rank: null as number | null,
          score: scored.score,
          coverage: scored.coverage,
          scoredCriteria: scored.scoredCriteria,
          criteria: [],
          reasons: [],
        } satisfies McdaRanked;
      });
      assignRanks(subRows);
      const subOrdered = orderRows(subRows);
      const after = rankMap(subOrdered);
      let rankChanges = 0;
      for (const [projectId, before] of baseline) {
        if ((after.get(projectId) ?? null) !== before) rankChanges += 1;
      }
      const newLeader = subOrdered.find((r) => r.rank === 1)?.projectId ?? null;
      influence.push({
        key: c.key,
        label: c.label,
        weightShare: prep.totalWeight > 0 ? c.weight / prep.totalWeight : 0,
        rankChanges,
        changesLeader: leader !== null && newLeader !== leader,
      });
    }
    influence.sort((a, b) => b.rankChanges - a.rankChanges || b.weightShare - a.weightShare);
  }

  return {
    method,
    criteria: prep.criteria.map((c) => ({
      key: c.key,
      label: c.label,
      weight: c.weight,
      weightShare: prep.totalWeight > 0 ? c.weight / prep.totalWeight : 0,
      direction: c.direction,
    })),
    excludedCriteria: prep.excluded,
    ranked: ordered,
    influence,
    warnings,
  };
}
