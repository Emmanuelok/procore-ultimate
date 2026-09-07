/**
 * Grievance triage — the retrieval half (#571-572, #574).
 *
 * A grievance arrives as free text from a community member, often through an
 * intermediary, often in translation. The intake officer has to give it a
 * category and a severity in the minutes before the acknowledgement clock
 * starts, and that severity IS the SLA: `critical` buys 1 day to acknowledge
 * and 7 to resolve, `low` buys 5 and 45. A mis-classification at intake is
 * not a labelling error, it is a service-standard breach nobody will notice
 * until the supervision mission counts them.
 *
 * This file is the deterministic, model-free part of triage:
 *
 *  · `similarGrievances` — a tf-idf cosine ranking over the description
 *    corpus, no external dependency, no network, no embeddings service.
 *    Precedent is the only honest basis for "this is a compensation
 *    grievance, not a land one" on a scheme that has already handled four
 *    hundred of them, and it is the thing an officer can check.
 *  · `slaCitations` — the published GRM service standard as quotable rule
 *    text, so a severity proposal cites the rule it is invoking rather than
 *    asserting a number.
 *  · `agreementOf` / `calibrationOf` — the calibration arithmetic. A triage
 *    proposal the officer silently overrides teaches nobody anything; the
 *    proposal and the decision are both recorded and the agreement rate is
 *    reported, so the tenant can see whether the assistant is worth reading.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: call a model. The route in
 * `grievances-triage.ts` passes this file's output to `runAgent`, and when
 * `ANTHROPIC_API_KEY` is unset the route returns 503 while everything here —
 * including the precedent ranking, which is genuinely useful on its own —
 * keeps working and is served by the same endpoint's `GET` sibling.
 */

import type { GrievanceSeverity } from "@constructos/shared";
import { GRIEVANCE_SLA, type GrievanceCategory } from "./reference.js";

/* ------------------------------------------------------------------ */
/* tf-idf precedent search                                             */
/* ------------------------------------------------------------------ */

/**
 * Words carrying no discriminating power in a grievance corpus. Kept short
 * and English-only on purpose: an aggressive stop list on a corpus that is
 * frequently translated throws away signal, and idf already suppresses a term
 * that appears in every record.
 */
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "for", "from", "had", "has",
  "have", "he", "her", "his", "i", "in", "is", "it", "its", "me", "my", "not", "of", "on", "or",
  "our", "she", "that", "the", "their", "them", "there", "they", "this", "to", "us", "was",
  "we", "were", "when", "which", "who", "will", "with", "you", "your",
]);

/** Lowercase, split on non-letters/digits, drop stop words and 1-char tokens. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** Term frequencies of one document, normalised by its own length. */
function termFrequencies(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  const total = tokens.length || 1;
  for (const [k, v] of counts) counts.set(k, v / total);
  return counts;
}

export interface TriageCorpusItem {
  id: string;
  number: number;
  description: string;
  category: string;
  severity: string;
  status: string;
  resolution: string | null;
  /** whole days from receipt to resolution, null while unresolved */
  resolutionDays: number | null;
  complainantSatisfied: boolean | null;
}

export interface SimilarGrievance extends TriageCorpusItem {
  /** cosine similarity in tf-idf space, 0..1, rounded to 4dp */
  score: number;
  /** the terms that carried the match, most informative first */
  sharedTerms: string[];
}

/**
 * Rank `corpus` against `description` by tf-idf cosine similarity.
 *
 * Documents with no term in common score 0 and are dropped: an officer shown
 * three "most similar" grievances that share nothing with the one in front of
 * them stops trusting the panel, and a zero-similarity precedent is worse
 * than an empty state that says so.
 *
 * Deterministic: ties break on the higher grievance number (the more recent
 * precedent), never on map iteration order.
 */
export function similarGrievances(
  description: string,
  corpus: readonly TriageCorpusItem[],
  limit = 3,
): SimilarGrievance[] {
  const queryTokens = tokenize(description);
  if (queryTokens.length === 0 || corpus.length === 0) return [];

  const docTokens = corpus.map((c) => tokenize(c.description));
  // document frequency over the corpus PLUS the query, so a term unique to
  // the query does not get an infinite idf
  const df = new Map<string, number>();
  const seenPerDoc = [queryTokens, ...docTokens].map((toks) => new Set(toks));
  for (const seen of seenPerDoc) {
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const nDocs = seenPerDoc.length;
  const idf = (term: string): number => {
    const d = df.get(term) ?? 0;
    if (d === 0) return 0;
    // smoothed idf, always > 0 so a universal term contributes a little
    return Math.log((nDocs + 1) / (d + 1)) + 1;
  };

  const weigh = (tokens: readonly string[]): Map<string, number> => {
    const tf = termFrequencies(tokens);
    const out = new Map<string, number>();
    for (const [term, f] of tf) out.set(term, f * idf(term));
    return out;
  };

  const qVec = weigh(queryTokens);
  const qNorm = Math.sqrt([...qVec.values()].reduce((s, v) => s + v * v, 0));
  if (qNorm === 0) return [];

  const scored: SimilarGrievance[] = [];
  for (let i = 0; i < corpus.length; i += 1) {
    const item = corpus[i]!;
    const dVec = weigh(docTokens[i]!);
    const dNorm = Math.sqrt([...dVec.values()].reduce((s, v) => s + v * v, 0));
    if (dNorm === 0) continue;
    let dot = 0;
    const shared: Array<{ term: string; weight: number }> = [];
    for (const [term, qw] of qVec) {
      const dw = dVec.get(term);
      if (dw === undefined) continue;
      dot += qw * dw;
      shared.push({ term, weight: qw * dw });
    }
    if (dot <= 0) continue;
    const score = Math.round((dot / (qNorm * dNorm)) * 10_000) / 10_000;
    shared.sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term));
    scored.push({ ...item, score, sharedTerms: shared.slice(0, 6).map((s) => s.term) });
  }

  scored.sort((a, b) => b.score - a.score || b.number - a.number);
  return scored.slice(0, Math.max(0, limit));
}

/* ------------------------------------------------------------------ */
/* Rule citations                                                      */
/* ------------------------------------------------------------------ */

export interface SlaCitation {
  severity: GrievanceSeverity;
  acknowledgeDays: number;
  resolveDays: number;
  /** the quotable rule text a proposal must cite to justify a severity */
  rule: string;
}

/**
 * The published GRM service standard as quotable text. A severity proposal
 * that cannot point at one of these strings is an opinion; one that can is a
 * reading of a rule the project published to the community.
 */
export function slaCitations(): SlaCitation[] {
  return (Object.keys(GRIEVANCE_SLA) as GrievanceSeverity[]).map((severity) => {
    const rule = GRIEVANCE_SLA[severity];
    return {
      severity,
      acknowledgeDays: rule.acknowledgeDays,
      resolveDays: rule.resolveDays,
      rule:
        `Severity "${severity}": acknowledge within ${rule.acknowledgeDays} calendar day` +
        `${rule.acknowledgeDays === 1 ? "" : "s"} and resolve within ${rule.resolveDays} ` +
        `calendar days of receipt. ${rule.rationale}`,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Precedent baseline (works with the model switched off)              */
/* ------------------------------------------------------------------ */

export interface PrecedentSuggestion {
  category: GrievanceCategory | null;
  severity: GrievanceSeverity | null;
  /** 0..1 — the share of the matched precedent weight behind the suggestion */
  confidence: number;
  basis: string;
}

const isCategory = (v: string): v is GrievanceCategory =>
  ["land", "noise", "dust", "access", "employment", "conduct", "compensation", "other"].includes(v);
const isSeverity = (v: string): v is GrievanceSeverity =>
  ["critical", "high", "medium", "low"].includes(v);

/**
 * A similarity-weighted vote over the matched precedents. This is what the
 * endpoint returns when AI is switched off: not a guess dressed as an
 * inference, but "of the closest four grievances this project has already
 * handled, three were classified `compensation`".
 */
export function precedentSuggestion(matches: readonly SimilarGrievance[]): PrecedentSuggestion {
  if (matches.length === 0) {
    return {
      category: null,
      severity: null,
      confidence: 0,
      basis: "No previously recorded grievance on this project shares wording with this one.",
    };
  }
  const totalWeight = matches.reduce((s, m) => s + m.score, 0);
  const vote = <T extends string>(
    pick: (m: SimilarGrievance) => string,
    guard: (v: string) => v is T,
  ): { value: T | null; weight: number } => {
    const tally = new Map<string, number>();
    for (const m of matches) {
      const v = pick(m);
      if (!guard(v)) continue;
      tally.set(v, (tally.get(v) ?? 0) + m.score);
    }
    let best: { value: T | null; weight: number } = { value: null, weight: 0 };
    // deterministic: highest weight, ties on the lexicographically first value
    for (const [value, weight] of [...tally.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )) {
      best = { value: value as T, weight };
      break;
    }
    return best;
  };
  const cat = vote<GrievanceCategory>((m) => m.category, isCategory);
  const sev = vote<GrievanceSeverity>((m) => m.severity, isSeverity);
  const confidence =
    totalWeight > 0 ? Math.round((cat.weight / totalWeight) * 100) / 100 : 0;
  const refs = matches.map((m) => `#${m.number} (${m.category}/${m.severity})`).join(", ");
  return {
    category: cat.value,
    severity: sev.value,
    confidence,
    basis: `Similarity-weighted vote over ${matches.length} precedent${
      matches.length === 1 ? "" : "s"
    }: ${refs}.`,
  };
}

/* ------------------------------------------------------------------ */
/* Calibration                                                         */
/* ------------------------------------------------------------------ */

export interface TriageOutcome {
  proposedCategory: string;
  proposedSeverity: string;
  proposedAssigneeId: string | null;
  decidedCategory: string | null;
  decidedSeverity: string | null;
  decidedAssigneeId: string | null;
  decidedAt: string | null;
}

export interface TriageAgreement {
  category: boolean | null;
  severity: boolean | null;
  assignee: boolean | null;
  /** true when the officer's severity was HARSHER than proposed */
  severityUnderCalled: boolean | null;
}

const SEVERITY_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Agreement of one proposal with the officer's decision; nulls while undecided. */
export function agreementOf(o: TriageOutcome): TriageAgreement {
  if (!o.decidedAt) {
    return { category: null, severity: null, assignee: null, severityUnderCalled: null };
  }
  const proposedRank = SEVERITY_ORDER[o.proposedSeverity];
  const decidedRank = o.decidedSeverity === null ? undefined : SEVERITY_ORDER[o.decidedSeverity];
  return {
    category: o.decidedCategory === null ? null : o.decidedCategory === o.proposedCategory,
    severity: o.decidedSeverity === null ? null : o.decidedSeverity === o.proposedSeverity,
    // an assignee neither proposed nor decided is not a disagreement
    assignee:
      o.proposedAssigneeId === null && o.decidedAssigneeId === null
        ? null
        : o.decidedAssigneeId === o.proposedAssigneeId,
    severityUnderCalled:
      proposedRank === undefined || decidedRank === undefined ? null : decidedRank > proposedRank,
  };
}

export interface TriageCalibration {
  proposals: number;
  decided: number;
  /** null rather than 0 when nothing has been decided — an unmeasured rate */
  categoryAgreementPercent: number | null;
  severityAgreementPercent: number | null;
  assigneeAgreementPercent: number | null;
  /** how often the officer raised the severity above the proposal */
  severityUnderCalled: number;
  severityOverCalled: number;
  reasons: string[];
}

/**
 * Aggregate agreement. Rates are null, never 0, until something has been
 * decided: "0% agreement" and "nothing has been decided yet" are different
 * facts and the second one is what an empty register means.
 */
export function calibrationOf(outcomes: readonly TriageOutcome[]): TriageCalibration {
  const decided = outcomes.filter((o) => o.decidedAt !== null);
  const reasons: string[] = [];
  if (outcomes.length === 0) reasons.push("No triage proposal has been recorded on this project.");
  else if (decided.length === 0) {
    reasons.push(
      `${outcomes.length} triage proposal${outcomes.length === 1 ? "" : "s"} recorded, none yet ` +
        "confirmed or overridden by an officer, so agreement is not measurable.",
    );
  }
  const rate = (pick: (a: TriageAgreement) => boolean | null): number | null => {
    const vals = decided.map((o) => pick(agreementOf(o))).filter((v): v is boolean => v !== null);
    if (vals.length === 0) return null;
    return Math.round((vals.filter(Boolean).length / vals.length) * 1000) / 10;
  };
  let under = 0;
  let over = 0;
  for (const o of decided) {
    const a = agreementOf(o);
    if (a.severity === false) {
      if (a.severityUnderCalled === true) under += 1;
      else if (a.severityUnderCalled === false) over += 1;
    }
  }
  return {
    proposals: outcomes.length,
    decided: decided.length,
    categoryAgreementPercent: rate((a) => a.category),
    severityAgreementPercent: rate((a) => a.severity),
    assigneeAgreementPercent: rate((a) => a.assignee),
    severityUnderCalled: under,
    severityOverCalled: over,
    reasons,
  };
}
