import { describe, expect, it } from "vitest";
import { LESSON_TRIGGER_KINDS } from "@constructos/shared";
import {
  DEFAULT_VARIATION_TRIGGER_THRESHOLD,
  describeTriggerRules,
  dueDaysFor,
  resolveVariationThreshold,
  selectNewCandidates,
  TRIGGER_RULES,
  triggerKey,
  type TriggerCandidate,
} from "./triggers.js";
import { keywordSearch, rankLessons, tokenize, type RankableLesson, type SearchableLesson } from "./relevance.js";

/* ------------------------------------------------------------------ */
/* Rule registry                                                       */
/* ------------------------------------------------------------------ */

describe("trigger rule registry", () => {
  it("declares a rule for every mandatory-capture kind except `manual` (#977)", () => {
    const kinds = TRIGGER_RULES.map((r) => r.kind).sort();
    const expected = LESSON_TRIGGER_KINDS.filter((k) => k !== "manual").sort();
    expect(kinds).toEqual([...expected]);
  });

  it("says which platform records each rule reads, so the claim is auditable", () => {
    for (const rule of describeTriggerRules()) {
      expect(rule.reads.length).toBeGreaterThan(10);
      expect(rule.dueDays).toBeGreaterThan(0);
    }
  });

  it("gives every kind a due-day budget and falls back for unknown kinds", () => {
    expect(dueDaysFor("signal_confirmed")).toBe(14);
    expect(dueDaysFor("project_closeout")).toBe(45);
    expect(dueDaysFor("manual")).toBe(30); // no rule — the documented fallback
  });
});

/* ------------------------------------------------------------------ */
/* Configurable threshold                                              */
/* ------------------------------------------------------------------ */

describe("variation threshold resolution", () => {
  it("prefers project settings, then company settings, then the code default", () => {
    expect(
      resolveVariationThreshold(
        { learning: { variationTriggerThreshold: 10_000 } },
        { learning: { variationTriggerThreshold: 99_000 } },
      ),
    ).toEqual({ value: 10_000, source: "project" });
    expect(
      resolveVariationThreshold({}, { learning: { variationTriggerThreshold: 99_000 } }),
    ).toEqual({ value: 99_000, source: "company" });
    expect(resolveVariationThreshold(null, null)).toEqual({
      value: DEFAULT_VARIATION_TRIGGER_THRESHOLD,
      source: "default",
    });
  });

  it("ignores unusable configured values rather than trusting them", () => {
    for (const bad of [0, -5, "abc", null, {}, []]) {
      expect(
        resolveVariationThreshold({ learning: { variationTriggerThreshold: bad } }, null).source,
      ).toBe("default");
    }
    // a numeric string is usable — settings arrive from JSON and forms alike
    expect(
      resolveVariationThreshold({ learning: { variationTriggerThreshold: "2500" } }, null),
    ).toEqual({ value: 2500, source: "project" });
  });
});

/* ------------------------------------------------------------------ */
/* Idempotency                                                         */
/* ------------------------------------------------------------------ */

const candidate = (kind: TriggerCandidate["kind"], recordId: string): TriggerCandidate => ({
  kind,
  sourceRef: { tool: "disputes", recordId, label: `record ${recordId}` },
  rationale: "because it happened",
});

describe("sweep idempotency (pure)", () => {
  it("keys a trigger on (kind, source record) so the same event never fires twice", () => {
    expect(triggerKey("dispute_closed", "dsp_1")).toBe("dispute_closed:dsp_1");
    expect(triggerKey("dispute_closed", "dsp_1")).not.toBe(triggerKey("gate_review", "dsp_1"));
  });

  it("drops candidates already materialized", () => {
    const candidates = [candidate("dispute_closed", "a"), candidate("dispute_closed", "b")];
    const fresh = selectNewCandidates(candidates, new Set(["dispute_closed:a"]));
    expect(fresh.map((c) => c.sourceRef.recordId)).toEqual(["b"]);
  });

  it("de-duplicates within a single scan as well as against existing rows", () => {
    const candidates = [
      candidate("dispute_closed", "a"),
      candidate("dispute_closed", "a"),
      candidate("claim_settled", "a"),
    ];
    const fresh = selectNewCandidates(candidates, new Set());
    expect(fresh).toHaveLength(2);
    expect(fresh.map((c) => c.kind)).toEqual(["dispute_closed", "claim_settled"]);
  });

  it("returns nothing at all when every candidate is known — the second sweep is a no-op", () => {
    const candidates = [candidate("dispute_closed", "a"), candidate("claim_settled", "b")];
    const known = new Set(candidates.map((c) => triggerKey(c.kind, c.sourceRef.recordId)));
    expect(selectNewCandidates(candidates, known)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Relevance ranking (pure)                                            */
/* ------------------------------------------------------------------ */

const NOW = "2026-06-01T00:00:00.000Z";

const lesson = (over: Partial<RankableLesson> = {}): RankableLesson => ({
  id: "lsn_base",
  number: "LL-0001",
  title: "Base lesson",
  category: "commercial",
  phase: "construction",
  tags: [],
  impactValue: null,
  impactCurrency: null,
  impactDays: null,
  publishedAt: "2026-05-01T00:00:00.000Z",
  originProjectId: "prj_a",
  applicationCount: 0,
  ...over,
});

describe("relevance ranking", () => {
  it("surfaces only lessons that match a supplied dimension", () => {
    const ranked = rankLessons(
      [
        lesson({ id: "lsn_hit", category: "commercial" }),
        lesson({ id: "lsn_miss", category: "safety", phase: "handover" }),
      ],
      { category: "commercial", now: NOW },
    );
    expect(ranked.map((r) => r.lesson.id)).toEqual(["lsn_hit"]);
  });

  it("returns the whole register ranked when the moment supplies no dimensions", () => {
    const ranked = rankLessons([lesson({ id: "a" }), lesson({ id: "b", category: "safety" })], {
      now: NOW,
    });
    expect(ranked).toHaveLength(2);
  });

  it("gives every hit the reasons it was surfaced", () => {
    const [hit] = rankLessons(
      [lesson({ tags: ["retention", "cashflow"], impactValue: 250_000, applicationCount: 3 })],
      { category: "commercial", phase: "construction", tags: ["retention"], tool: "commercial", now: NOW },
    );
    const codes = hit!.reasons.map((r) => r.code);
    expect(codes).toContain("category_match");
    expect(codes).toContain("phase_match");
    expect(codes).toContain("tag_overlap");
    expect(codes).toContain("tool_affinity");
    expect(codes).toContain("impact_magnitude");
    expect(codes).toContain("previously_applied");
    expect(hit!.score).toBe(hit!.reasons.reduce((s, r) => s + r.points, 0));
    for (const reason of hit!.reasons) expect(reason.detail.length).toBeGreaterThan(0);
  });

  it("is deterministic: identical input yields identical order and scores", () => {
    const register = [
      lesson({ id: "a", tags: ["rebar"] }),
      lesson({ id: "b", tags: ["rebar"], impactValue: 1_000_000 }),
      lesson({ id: "c", tags: ["rebar"], applicationCount: 9 }),
    ];
    const q = { tags: ["rebar"], now: NOW };
    const first = rankLessons(register, q);
    const second = rankLessons([...register].reverse(), q);
    expect(second.map((r) => r.lesson.id)).toEqual(first.map((r) => r.lesson.id));
    expect(second.map((r) => r.score)).toEqual(first.map((r) => r.score));
  });

  it("breaks ties by publication date then id, so there is a total order", () => {
    const ranked = rankLessons(
      [
        lesson({ id: "z", publishedAt: "2026-05-01T00:00:00.000Z" }),
        lesson({ id: "a", publishedAt: "2026-05-01T00:00:00.000Z" }),
        lesson({ id: "m", publishedAt: "2026-05-20T00:00:00.000Z" }),
      ],
      { now: NOW },
    );
    expect(ranked.map((r) => r.lesson.id)).toEqual(["m", "a", "z"]);
  });

  it("ranks a big-money, recently-applied lesson above a cheap unused one", () => {
    const ranked = rankLessons(
      [
        lesson({ id: "cheap", tags: ["piling"] }),
        lesson({ id: "expensive", tags: ["piling"], impactValue: 2_000_000, impactDays: 40, applicationCount: 4 }),
      ],
      { tags: ["piling"], now: NOW },
    );
    expect(ranked[0]!.lesson.id).toBe("expensive");
  });

  it("decays with age but never drops a lesson for being old", () => {
    const ranked = rankLessons(
      [
        lesson({ id: "fresh", publishedAt: "2026-05-25T00:00:00.000Z" }),
        lesson({ id: "ancient", publishedAt: "2018-01-01T00:00:00.000Z" }),
      ],
      { now: NOW },
    );
    expect(ranked.map((r) => r.lesson.id)).toEqual(["fresh", "ancient"]);
    expect(ranked[1]!.score).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Deterministic keyword search (the AI-free floor)                    */
/* ------------------------------------------------------------------ */

const searchable = (over: Partial<SearchableLesson> = {}): SearchableLesson => ({
  ...lesson(),
  context: null,
  whatHappened: "Nothing in particular",
  rootCause: null,
  recommendation: "Do better",
  ...over,
});

describe("keyword search", () => {
  it("drops stopwords and short tokens", () => {
    expect(tokenize("what was the root cause of it")).toEqual(["root", "cause"]);
  });

  it("weights a title match above a body match", () => {
    const hits = keywordSearch(
      [
        searchable({ id: "title", title: "Retention release delays" }),
        searchable({ id: "body", whatHappened: "There were retention problems" }),
      ],
      "retention",
    );
    expect(hits[0]!.lesson.id).toBe("title");
    expect(hits[0]!.matchedFields).toContain("title");
  });

  it("returns nothing rather than everything when no term matches", () => {
    expect(keywordSearch([searchable()], "zzzzqqq")).toEqual([]);
  });

  it("reports which terms matched where, so a result can be justified", () => {
    const [hit] = keywordSearch(
      [searchable({ tags: ["piling"], recommendation: "Survey the piling records first" })],
      "piling survey",
    );
    expect(hit!.matchedTerms).toEqual(["piling", "survey"]);
    expect(hit!.matchedFields).toEqual(expect.arrayContaining(["tags", "recommendation"]));
  });
});
