import type { LessonCategory, ToolKey } from "@constructos/shared";

/**
 * Deterministic, explainable relevance ranking (#978, #983-987).
 *
 * The reason lessons registers go unread is that retrieval is a search box
 * someone has to remember to visit. This ranks the published register against
 * what the user is doing RIGHT NOW — the tool they are in, the category and
 * phase of the record they are creating, the tags on it — and returns, for
 * every hit, the reason it was surfaced.
 *
 * Every component is an integer and every input is supplied by the caller
 * (including `now`), so the same inputs always produce the same output in the
 * same order. Nothing here touches the database or the clock.
 */

export interface RankableLesson {
  id: string;
  number: string;
  title: string;
  category: string;
  phase: string | null;
  tags: string[];
  impactValue: number | null;
  impactCurrency: string | null;
  impactDays: number | null;
  publishedAt: string | null;
  originProjectId: string | null;
  /** how many times this lesson has already been applied to a later record */
  applicationCount: number;
}

export interface RelevanceQuery {
  tool?: string | null;
  category?: string | null;
  phase?: string | null;
  tags?: string[];
  /**
   * Optional tf-idf similarity of each lesson to the free text of the record
   * being created (0..1), computed by `semanticMatches`. Supplied as a map
   * rather than computed here so ranking stays pure arithmetic over inputs
   * and the index can be built once per request.
   */
  semantic?: ReadonlyMap<string, number>;
  /** evaluation instant (ISO); injected so ranking is testable and stable */
  now: string;
}

export interface RelevanceReason {
  code:
    | "category_match"
    | "tool_affinity"
    | "tool_tag"
    | "phase_match"
    | "tag_overlap"
    | "impact_magnitude"
    | "recency"
    | "previously_applied"
    | "semantic_similarity";
  points: number;
  detail: string;
}

export interface RankedLesson {
  lesson: RankableLesson;
  score: number;
  reasons: RelevanceReason[];
}

/* ------------------------------------------------------------------ */
/* Weights — named, so the ranking can be argued with                  */
/* ------------------------------------------------------------------ */

export const WEIGHTS = {
  categoryMatch: 30,
  toolAffinity: 18,
  toolTag: 10,
  phaseMatch: 20,
  perTag: 12,
  maxTagPoints: 36,
  maxImpactPoints: 25,
  recencyRecent: 12, // published within 90 days
  recencyYear: 8, // within a year
  recencyThreeYears: 4,
  recencyOlder: 1,
  appliedBase: 8,
  appliedPerExtra: 2,
  maxAppliedPoints: 16,
  /** full marks for a lesson whose words are the record's words */
  maxSemanticPoints: 34,
} as const;

/**
 * Which lesson categories a tool's work usually belongs to. A user raising a
 * variation is doing commercial and contractual work; a user in the schedule
 * tool is doing programme work. Deliberately coarse — the category and tag
 * filters carry the precision.
 */
const TOOL_AFFINITY: Partial<Record<ToolKey, readonly LessonCategory[]>> = {
  rfis: ["design", "quality"],
  submittals: ["design", "quality", "procurement"],
  drawings: ["design"],
  specifications: ["design", "quality"],
  bim: ["design"],
  punch: ["quality", "construction"],
  daily_logs: ["construction"],
  photos: ["construction", "safety"],
  budget: ["commercial"],
  commitments: ["commercial", "procurement"],
  change_management: ["commercial", "contractual"],
  invoicing: ["commercial"],
  commercial: ["commercial"],
  contracts: ["contractual"],
  disputes: ["contractual", "commercial"],
  payments: ["commercial", "contractual"],
  schedule: ["programme"],
  forensics: ["programme", "contractual"],
  risk: ["governance", "programme"],
  governance: ["governance"],
  finance: ["commercial", "governance"],
  insurance: ["contractual", "governance"],
  esg: ["environmental", "stakeholder"],
  land: ["stakeholder", "environmental"],
  workforce: ["safety"],
  jurisdiction: ["governance", "contractual"],
  assurance: ["governance", "quality"],
  benchmarks: ["commercial", "programme"],
  workflow: ["governance"],
  documents: ["quality"],
  meetings: ["stakeholder"],
  twin: ["quality", "construction"],
  directory: ["procurement"],
  projects: ["governance"],
};

/** The lesson categories a tool implies. Exported for the API's explanation text. */
export function toolAffinity(tool: string | null | undefined): readonly LessonCategory[] {
  if (!tool) return [];
  return TOOL_AFFINITY[tool as ToolKey] ?? [];
}

const MS_PER_DAY = 86_400_000;

function impactPoints(lesson: RankableLesson): { points: number; detail: string } {
  const parts: string[] = [];
  let points = 0;
  if (lesson.impactValue != null && Number.isFinite(lesson.impactValue)) {
    const magnitude = Math.abs(lesson.impactValue);
    const p = Math.max(0, Math.min(20, Math.round(Math.log10(1 + magnitude) * 4)));
    points += p;
    parts.push(
      `recorded cost impact of ${lesson.impactCurrency ?? ""}${
        lesson.impactCurrency ? " " : ""
      }${Math.round(magnitude).toLocaleString("en-GB")}`.trim(),
    );
  }
  if (lesson.impactDays != null && Number.isFinite(lesson.impactDays)) {
    const p = Math.max(0, Math.min(10, Math.round(Math.abs(lesson.impactDays) / 5)));
    points += p;
    parts.push(`${Math.abs(lesson.impactDays)} day(s) of programme impact`);
  }
  return {
    points: Math.min(WEIGHTS.maxImpactPoints, points),
    detail: parts.length > 0 ? `Cost of the lesson: ${parts.join(" and ")}.` : "",
  };
}

function recencyPoints(publishedAt: string | null, now: string): { points: number; detail: string } {
  if (!publishedAt) return { points: 0, detail: "" };
  const ageMs = Date.parse(now) - Date.parse(publishedAt);
  if (!Number.isFinite(ageMs)) return { points: 0, detail: "" };
  const days = Math.max(0, Math.floor(ageMs / MS_PER_DAY));
  if (days <= 90) return { points: WEIGHTS.recencyRecent, detail: `Published ${days} day(s) ago.` };
  if (days <= 365) return { points: WEIGHTS.recencyYear, detail: `Published ${days} day(s) ago.` };
  if (days <= 1095) {
    return { points: WEIGHTS.recencyThreeYears, detail: `Published ${days} day(s) ago.` };
  }
  return { points: WEIGHTS.recencyOlder, detail: `Published ${days} day(s) ago — older evidence.` };
}

/**
 * Rank published lessons against the moment. When the query carries any
 * dimension (tool, category, phase, tags), a lesson must match at least one
 * of them to be returned at all — retrieval bound to the moment, not a
 * whole-register dump with a sort applied. With no dimensions supplied the
 * whole register is returned, ranked by impact and recency.
 */
export function rankLessons(
  lessons: readonly RankableLesson[],
  query: RelevanceQuery,
): RankedLesson[] {
  const wantedTags = (query.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const affinity = toolAffinity(query.tool);
  const semantic = query.semantic;
  const hasDimension =
    Boolean(query.tool) ||
    Boolean(query.category) ||
    Boolean(query.phase) ||
    wantedTags.length > 0 ||
    (semantic !== undefined && semantic.size > 0);

  const ranked: RankedLesson[] = [];
  for (const lesson of lessons) {
    const reasons: RelevanceReason[] = [];
    let matched = false;

    if (query.category && lesson.category === query.category) {
      matched = true;
      reasons.push({
        code: "category_match",
        points: WEIGHTS.categoryMatch,
        detail: `Same category as the record you are working on (${lesson.category}).`,
      });
    }

    if (affinity.includes(lesson.category as LessonCategory)) {
      matched = true;
      reasons.push({
        code: "tool_affinity",
        points: WEIGHTS.toolAffinity,
        detail: `Work in the ${query.tool} tool is usually ${lesson.category} work.`,
      });
    }

    const lessonTags = lesson.tags.map((t) => t.toLowerCase());
    if (query.tool && lessonTags.includes(query.tool.toLowerCase())) {
      matched = true;
      reasons.push({
        code: "tool_tag",
        points: WEIGHTS.toolTag,
        detail: `Tagged for the ${query.tool} tool.`,
      });
    }

    if (query.phase && lesson.phase && lesson.phase === query.phase) {
      matched = true;
      reasons.push({
        code: "phase_match",
        points: WEIGHTS.phaseMatch,
        detail: `Belongs to the ${lesson.phase} phase, which is the phase you are in.`,
      });
    }

    if (wantedTags.length > 0) {
      const overlap = wantedTags.filter((t) => lessonTags.includes(t));
      if (overlap.length > 0) {
        matched = true;
        reasons.push({
          code: "tag_overlap",
          points: Math.min(WEIGHTS.maxTagPoints, overlap.length * WEIGHTS.perTag),
          detail: `Shares ${overlap.length} tag(s) with your record: ${overlap.join(", ")}.`,
        });
      }
    }

    /*
     * SIMILARITY IS A DIMENSION, NOT A TIEBREAK.
     *
     * The structured filters (category, phase, tags) only find lessons whose
     * metadata somebody remembered to set. A lesson filed under "commercial"
     * that describes exactly this ground condition is the one the reader
     * needs, and no tag says so. The tf-idf similarity of the lesson's own
     * words to the record's words is therefore allowed to MATCH on its own —
     * and it is reported as a number, so a weak match reads as a weak match.
     */
    const similarity = semantic?.get(lesson.id) ?? 0;
    if (similarity >= SEMANTIC_MATCH_FLOOR) {
      matched = true;
      reasons.push({
        code: "semantic_similarity",
        points: Math.round(similarity * WEIGHTS.maxSemanticPoints),
        detail: `Semantic similarity: ${similarity.toFixed(2)} — the lesson's own wording overlaps the text of the record you are working on (tf-idf cosine over the published register).`,
      });
    }

    if (hasDimension && !matched) continue;

    const impact = impactPoints(lesson);
    if (impact.points > 0) {
      reasons.push({ code: "impact_magnitude", points: impact.points, detail: impact.detail });
    }
    const recency = recencyPoints(lesson.publishedAt, query.now);
    if (recency.points > 0) {
      reasons.push({ code: "recency", points: recency.points, detail: recency.detail });
    }
    if (lesson.applicationCount > 0) {
      const points = Math.min(
        WEIGHTS.maxAppliedPoints,
        WEIGHTS.appliedBase + (lesson.applicationCount - 1) * WEIGHTS.appliedPerExtra,
      );
      reasons.push({
        code: "previously_applied",
        points,
        detail: `Already applied ${lesson.applicationCount} time(s) on later work — this one travels.`,
      });
    }

    ranked.push({
      lesson,
      score: reasons.reduce((s, r) => s + r.points, 0),
      reasons,
    });
  }

  // Total order: score, then most recently published, then id — no ties.
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ap = a.lesson.publishedAt ?? "";
    const bp = b.lesson.publishedAt ?? "";
    if (ap !== bp) return bp.localeCompare(ap);
    return a.lesson.id.localeCompare(b.lesson.id);
  });
  return ranked;
}

/* ------------------------------------------------------------------ */
/* Deterministic keyword search (the AI-free floor, #993)              */
/* ------------------------------------------------------------------ */

export interface SearchableLesson extends RankableLesson {
  context: string | null;
  whatHappened: string;
  rootCause: string | null;
  recommendation: string;
}

export interface KeywordHit {
  lesson: SearchableLesson;
  score: number;
  matchedTerms: string[];
  /** where the terms were found, for the "why this one" line */
  matchedFields: string[];
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "was", "are",
  "were", "be", "been", "at", "by", "it", "this", "that", "we", "our", "us", "do", "did",
  "does", "how", "what", "why", "when", "which", "any", "all", "from", "about", "have", "has",
]);

/** Split a natural-language query into searchable terms. Pure. */
export function tokenize(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9£$€%-]+/)
        .map((t) => t.replace(/^-+|-+$/g, ""))
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
    ),
  ];
}

const FIELD_WEIGHTS: { field: string; weight: number; read: (l: SearchableLesson) => string }[] = [
  { field: "title", weight: 8, read: (l) => l.title },
  { field: "tags", weight: 6, read: (l) => l.tags.join(" ") },
  { field: "category", weight: 4, read: (l) => l.category },
  { field: "phase", weight: 3, read: (l) => l.phase ?? "" },
  { field: "recommendation", weight: 4, read: (l) => l.recommendation },
  { field: "whatHappened", weight: 3, read: (l) => l.whatHappened },
  { field: "rootCause", weight: 3, read: (l) => l.rootCause ?? "" },
  { field: "context", weight: 2, read: (l) => l.context ?? "" },
];

/**
 * Term-frequency keyword search over the published register. This is the
 * floor the AI layer sits on: when ANTHROPIC_API_KEY is absent, or the model
 * call fails, search degrades to this rather than erroring.
 */
export function keywordSearch(
  lessons: readonly SearchableLesson[],
  query: string,
): KeywordHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const hits: KeywordHit[] = [];
  for (const lesson of lessons) {
    let score = 0;
    const matchedTerms = new Set<string>();
    const matchedFields = new Set<string>();
    for (const { field, weight, read } of FIELD_WEIGHTS) {
      const haystack = read(lesson).toLowerCase();
      if (!haystack) continue;
      for (const term of terms) {
        if (haystack.includes(term)) {
          score += weight;
          matchedTerms.add(term);
          matchedFields.add(field);
        }
      }
    }
    if (score === 0) continue;
    // A lesson that has already travelled outranks one that has not, all else equal.
    score += Math.min(6, lesson.applicationCount * 2);
    hits.push({
      lesson,
      score,
      matchedTerms: [...matchedTerms].sort(),
      matchedFields: [...matchedFields].sort(),
    });
  }
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ap = a.lesson.publishedAt ?? "";
    const bp = b.lesson.publishedAt ?? "";
    if (ap !== bp) return bp.localeCompare(ap);
    return a.lesson.id.localeCompare(b.lesson.id);
  });
  return hits;
}

/* ------------------------------------------------------------------ */
/* Semantic-ish retrieval: tf-idf cosine, no external dependency (#993) */
/* ------------------------------------------------------------------ */

/**
 * A lesson only matches below this and it is not worth surfacing: at 0.05 the
 * overlap is a couple of common-ish words, which is noise dressed as insight.
 */
export const SEMANTIC_MATCH_FLOOR = 0.05;

/**
 * WHY tf-idf AND NOT EMBEDDINGS.
 *
 * The honest options were a vector database (an operational dependency, a
 * model version to pin, and a similarity nobody can explain) or classical
 * tf-idf cosine (deterministic, inspectable, and computable in the request).
 * For a register of hundreds — not millions — of lessons the second wins on
 * every axis that matters here: a reader can be shown WHICH terms drove the
 * match, and the same query gives the same answer next month. If embeddings
 * are ever added they should sit BESIDE this, not replace it: the reason line
 * must always be able to name the words.
 *
 * Terms are weighted by the field they appear in (a term in the title says
 * more than the same term buried in the context), which is the classic
 * field-boost trick and keeps the vector sparse.
 */
const SEMANTIC_FIELD_WEIGHTS: {
  weight: number;
  read: (l: SearchableLesson) => string;
}[] = [
  { weight: 4, read: (l) => l.title },
  { weight: 3, read: (l) => l.tags.join(" ") },
  { weight: 2, read: (l) => l.category },
  { weight: 2, read: (l) => l.phase ?? "" },
  { weight: 3, read: (l) => l.recommendation },
  { weight: 2, read: (l) => l.whatHappened },
  { weight: 2, read: (l) => l.rootCause ?? "" },
  { weight: 1, read: (l) => l.context ?? "" },
];

export interface TfIdfIndex {
  /** unit-length tf-idf vector per lesson id */
  vectors: Map<string, Map<string, number>>;
  idf: Map<string, number>;
  documents: number;
}

/** Weighted term counts for one lesson. Pure. */
export function documentTerms(lesson: SearchableLesson): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { weight, read } of SEMANTIC_FIELD_WEIGHTS) {
    const text = read(lesson);
    if (!text) continue;
    for (const term of tokenizeAll(text)) {
      counts.set(term, (counts.get(term) ?? 0) + weight);
    }
  }
  return counts;
}

/**
 * Like `tokenize` but keeps repeats: term FREQUENCY is the point here, where
 * the keyword searcher only cares whether a term is present.
 */
export function tokenizeAll(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9£$€%-]+/)
    .map((t) => t.replace(/^-+|-+$/g, ""))
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function l2normalise(vec: Map<string, number>): Map<string, number> {
  let sum = 0;
  for (const v of vec.values()) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return new Map();
  const out = new Map<string, number>();
  for (const [k, v] of vec) out.set(k, v / norm);
  return out;
}

/**
 * Build the index over the register. O(total terms); called once per request.
 * Smoothed idf (`log(1 + N/df)`) so a term present in every lesson still
 * contributes a little rather than collapsing the vector to nothing.
 */
export function buildTfIdfIndex(lessons: readonly SearchableLesson[]): TfIdfIndex {
  const termCounts: Array<[string, Map<string, number>]> = lessons.map((l) => [
    l.id,
    documentTerms(l),
  ]);
  const df = new Map<string, number>();
  for (const [, counts] of termCounts) {
    for (const term of counts.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const n = Math.max(1, termCounts.length);
  const idf = new Map<string, number>();
  for (const [term, d] of df) idf.set(term, Math.log(1 + n / d));
  const vectors = new Map<string, Map<string, number>>();
  for (const [id, counts] of termCounts) {
    const vec = new Map<string, number>();
    for (const [term, tf] of counts) {
      vec.set(term, (1 + Math.log(tf)) * (idf.get(term) ?? 0));
    }
    vectors.set(id, l2normalise(vec));
  }
  return { vectors, idf, documents: termCounts.length };
}

function queryVector(index: TfIdfIndex, text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of tokenizeAll(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
  const vec = new Map<string, number>();
  for (const [term, tf] of counts) {
    const idf = index.idf.get(term);
    /* A term the register has never used carries no information about it. */
    if (idf === undefined) continue;
    vec.set(term, (1 + Math.log(tf)) * idf);
  }
  return l2normalise(vec);
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  /* Both vectors are unit length, so the dot product IS the cosine. */
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, v] of small) {
    const w = large.get(term);
    if (w !== undefined) dot += v * w;
  }
  return dot;
}

export interface SemanticMatch {
  lessonId: string;
  similarity: number;
  /** the terms that contributed most, so the match can be explained */
  terms: string[];
}

/**
 * Rank the register against free text — the title and description of the RFI,
 * variation or risk the user is creating. Returns a stable total order.
 */
export function semanticMatches(
  index: TfIdfIndex,
  text: string,
  opts: { floor?: number; limit?: number } = {},
): SemanticMatch[] {
  const floor = opts.floor ?? SEMANTIC_MATCH_FLOOR;
  const qv = queryVector(index, text);
  if (qv.size === 0) return [];
  const out: SemanticMatch[] = [];
  for (const [lessonId, vec] of index.vectors) {
    const similarity = cosine(qv, vec);
    if (similarity < floor) continue;
    const contributions: Array<[string, number]> = [];
    for (const [term, v] of qv) {
      const w = vec.get(term);
      if (w !== undefined) contributions.push([term, v * w]);
    }
    contributions.sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])));
    out.push({
      lessonId,
      similarity,
      terms: contributions.slice(0, 5).map(([t]) => t),
    });
  }
  out.sort((a, b) =>
    b.similarity !== a.similarity
      ? b.similarity - a.similarity
      : a.lessonId.localeCompare(b.lessonId),
  );
  return opts.limit ? out.slice(0, opts.limit) : out;
}

/** Lesson-to-lesson similarity, for "see also" edges in the knowledge graph. */
export function similarLessons(
  index: TfIdfIndex,
  lessonId: string,
  opts: { floor?: number; limit?: number } = {},
): SemanticMatch[] {
  const floor = opts.floor ?? SEMANTIC_MATCH_FLOOR;
  const self = index.vectors.get(lessonId);
  if (!self) return [];
  const out: SemanticMatch[] = [];
  for (const [otherId, vec] of index.vectors) {
    if (otherId === lessonId) continue;
    const similarity = cosine(self, vec);
    if (similarity < floor) continue;
    const contributions: Array<[string, number]> = [];
    for (const [term, v] of self) {
      const w = vec.get(term);
      if (w !== undefined) contributions.push([term, v * w]);
    }
    contributions.sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])));
    out.push({ lessonId: otherId, similarity, terms: contributions.slice(0, 5).map(([t]) => t) });
  }
  out.sort((a, b) =>
    b.similarity !== a.similarity
      ? b.similarity - a.similarity
      : a.lessonId.localeCompare(b.lessonId),
  );
  return opts.limit ? out.slice(0, opts.limit) : out;
}
