import { describe, expect, it } from "vitest";
import { likePattern, rankHits, scoreCandidate, tokenize } from "./engine.js";

describe("tokenize", () => {
  it("lowercases and splits on punctuation, keeping record-reference characters", () => {
    expect(tokenize("RFI-0042 slab pour")).toEqual(["rfi-0042", "slab", "pour"]);
    expect(tokenize("03 30 00")).toEqual(["03", "30", "00"]);
  });

  it("drops empties and caps the term count", () => {
    expect(tokenize("   ,,,  ")).toEqual([]);
    expect(tokenize(Array.from({ length: 30 }, (_, i) => `t${i}`).join(" "))).toHaveLength(12);
  });
});

describe("likePattern", () => {
  it("neutralises LIKE metacharacters so a query cannot become a wildcard", () => {
    expect(likePattern("100%")).toBe("%100\\%%");
    expect(likePattern("a_b")).toBe("%a\\_b%");
    expect(likePattern("back\\slash")).toBe("%back\\\\slash%");
  });
});

describe("scoreCandidate", () => {
  const terms = tokenize("slab pour");

  it("returns 0 when nothing matches, so a loose SQL filter cannot inject noise", () => {
    expect(scoreCandidate({ title: "Roof membrane" }, terms)).toBe(0);
  });

  it("scores an exact reference match above a title match", () => {
    const reference = scoreCandidate({ title: "Something else", reference: "slab pour" }, terms);
    const title = scoreCandidate({ title: "Slab pour sequence" }, terms);
    expect(reference).toBeGreaterThan(title);
  });

  it("prefers a title that starts with the query", () => {
    const prefix = scoreCandidate({ title: "Slab pour sequence" }, terms);
    const middle = scoreCandidate({ title: "Sequence for the slab pour" }, terms);
    expect(prefix).toBeGreaterThan(middle);
  });

  it("rewards matching every term", () => {
    const both = scoreCandidate({ title: "slab pour" }, terms);
    const one = scoreCandidate({ title: "slab only" }, terms);
    expect(both).toBeGreaterThan(one);
  });

  it("counts a subtitle match, but less than a title match", () => {
    const inTitle = scoreCandidate({ title: "slab", subtitle: null }, terms);
    const inSubtitle = scoreCandidate({ title: "unrelated", subtitle: "slab" }, terms);
    expect(inTitle).toBeGreaterThan(inSubtitle);
    expect(inSubtitle).toBeGreaterThan(0);
  });

  it("lets recency break ties without creating them", () => {
    const now = Date.parse("2026-06-01T00:00:00Z");
    const fresh = scoreCandidate(
      { title: "slab pour", updatedAt: "2026-05-30T00:00:00Z" },
      terms,
      now,
    );
    const stale = scoreCandidate(
      { title: "slab pour", updatedAt: "2020-01-01T00:00:00Z" },
      terms,
      now,
    );
    expect(fresh).toBeGreaterThan(stale);
    // Recency alone can never outweigh a genuine content match.
    const staleButBetter = scoreCandidate(
      { title: "slab pour", reference: "slab pour", updatedAt: "2020-01-01T00:00:00Z" },
      terms,
      now,
    );
    expect(staleButBetter).toBeGreaterThan(fresh);
  });

  it("applies the source weight", () => {
    const plain = scoreCandidate({ title: "slab pour" }, terms);
    const weighted = scoreCandidate({ title: "slab pour", sourceWeight: 1.5 }, terms);
    expect(weighted).toBeGreaterThan(plain);
  });

  it("scores nothing when there are no terms", () => {
    expect(scoreCandidate({ title: "anything" }, [])).toBe(0);
  });
});

describe("rankHits", () => {
  it("orders by score, then recency, then title, then id — deterministically", () => {
    const hits = [
      { type: "rfi", id: "b", score: 10, title: "Beta", updatedAt: "2026-01-01T00:00:00Z" },
      { type: "rfi", id: "a", score: 10, title: "Alpha", updatedAt: "2026-01-02T00:00:00Z" },
      { type: "rfi", id: "c", score: 20, title: "Gamma", updatedAt: null },
    ];
    expect(rankHits(hits, 10).map((h) => h.id)).toEqual(["c", "a", "b"]);
    // Same input, same output — the palette is navigated with the keyboard.
    expect(rankHits([...hits].reverse(), 10).map((h) => h.id)).toEqual(["c", "a", "b"]);
  });

  it("drops zero-score hits and honours the limit", () => {
    const hits = [
      { type: "rfi", id: "a", score: 0, title: "A" },
      { type: "rfi", id: "b", score: 5, title: "B" },
      { type: "rfi", id: "c", score: 4, title: "C" },
    ];
    expect(rankHits(hits, 1).map((h) => h.id)).toEqual(["b"]);
  });
});
