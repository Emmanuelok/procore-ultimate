/**
 * Search ranking — the pure half of company-wide search.
 *
 * Covers: cross-package contract §3.3 (the `score` on every hit), Vol I §0.3
 * #74 (find any record from anywhere).
 *
 * Deliberately NOT a full-text index. A tsvector column maintained by the
 * write path of every module is the right long-term answer, but this package
 * cannot edit those modules, and a search that silently misses records
 * because a module forgot to update an index is worse than a slower one that
 * reads the live rows. So: bounded ILIKE candidate fetch per source, then
 * this deterministic scorer decides the order. Everything here is a pure
 * function of its inputs, which is what makes the ordering testable.
 */

/** A term the user typed, normalised for comparison. */
export type SearchTerm = string;

/** Split a query into comparable terms. Punctuation splits; case is dropped. */
export function tokenize(query: string): SearchTerm[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9#.\-/]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 12);
}

/** The SQL LIKE pattern for one term, with LIKE metacharacters neutralised. */
export function likePattern(term: string): string {
  return `%${term.replace(/([\\%_])/g, "\\$1")}%`;
}

export interface ScoreInput {
  title: string | null;
  subtitle?: string | null;
  /** an exact identifier (record reference, number, code) if the source has one */
  reference?: string | null;
  status?: string | null;
  updatedAt?: string | null;
  /** relative weight of the source, e.g. a project outranks a comment */
  sourceWeight?: number;
}

/**
 * Score one candidate against the query terms. Range is roughly 0..100.
 *
 * The shape of the ranking, in order of strength:
 *  1. the whole query is the record's reference          — a direct hit
 *  2. the title starts with the query                    — "what I typed"
 *  3. every term appears in the title                    — all words matched
 *  4. terms appear in title or subtitle                  — partial
 *  5. recency breaks ties, never creates them (max +6)
 * A candidate that matches no term at all scores 0 and is dropped, so a
 * source whose SQL was looser than the scorer cannot inject noise.
 */
export function scoreCandidate(input: ScoreInput, terms: SearchTerm[], nowMs = Date.now()): number {
  if (terms.length === 0) return 0;
  const title = (input.title ?? "").toLowerCase();
  const subtitle = (input.subtitle ?? "").toLowerCase();
  const reference = (input.reference ?? "").toLowerCase();
  const joined = terms.join(" ");

  let score = 0;
  let matched = 0;

  // An exact reference match is the strongest single signal there is: if
  // someone typed "RFI-0042", they want RFI-0042 and nothing else.
  if (reference && (reference === joined || terms.some((t) => reference === t))) score += 70;
  else if (reference && terms.some((t) => reference.includes(t))) score += 18;

  if (title.startsWith(joined)) score += 30;
  else if (title.includes(joined)) score += 20;

  for (const term of terms) {
    if (title.includes(term)) {
      matched += 1;
      score += 10;
      if (new RegExp(`\\b${escapeRegExp(term)}`).test(title)) score += 4;
    } else if (subtitle.includes(term)) {
      matched += 1;
      score += 4;
    } else if (reference.includes(term)) {
      matched += 1;
      score += 3;
    }
  }
  if (matched === 0) return 0;
  // Every term matched somewhere — the query as a whole is satisfied.
  if (matched === terms.length) score += 8;

  score *= input.sourceWeight ?? 1;

  if (input.updatedAt) {
    const ageDays = (nowMs - Date.parse(input.updatedAt)) / 86_400_000;
    if (Number.isFinite(ageDays)) {
      if (ageDays <= 7) score += 6;
      else if (ageDays <= 30) score += 4;
      else if (ageDays <= 180) score += 2;
    }
  }
  return Math.round(score * 100) / 100;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RankableHit {
  type: string;
  id: string;
  score: number;
  title: string;
  updatedAt?: string | null;
}

/**
 * Order hits and cut to `limit`. Ties break on recency, then on title, then
 * on id — so the same query over the same data always returns the same page,
 * which matters for a palette people navigate with the keyboard.
 */
export function rankHits<T extends RankableHit>(hits: T[], limit: number): T[] {
  return [...hits]
    .filter((h) => h.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const at = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      if (bt !== at) return bt - at;
      const byTitle = a.title.localeCompare(b.title);
      if (byTitle !== 0) return byTitle;
      return a.id.localeCompare(b.id);
    })
    .slice(0, limit);
}
