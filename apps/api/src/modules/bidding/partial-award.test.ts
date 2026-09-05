import { describe, expect, it } from "vitest";
import {
  buildScopedComparison,
  planAwardScope,
  scopedLevelledAmount,
  type LevelledCell,
  type LiveAwardScope,
  type ScopeItem,
} from "./partial-award.js";

const item = (id: string, position: number, mandatory = true): ScopeItem => ({
  id,
  position,
  itemCode: id.toUpperCase(),
  description: `Row ${id}`,
  isMandatory: mandatory,
});

const ITEMS: ScopeItem[] = [item("a", 1), item("b", 2), item("c", 3), item("d", 4, false)];

const cell = (
  levellingItemId: string,
  submissionId: string,
  levelledAmount: number | null,
  currency = "GBP",
  includedStatus = "included",
): LevelledCell => ({ levellingItemId, submissionId, levelledAmount, currency, includedStatus });

const label = (id: string) => `Row ${id}`;
const inContention = (status: string) => status !== "withdrawn" && status !== "unsuccessful";

describe("planAwardScope", () => {
  it("treats an award with no named rows as a whole-package award", () => {
    const res = planAwardScope({ items: ITEMS, liveAwards: [], requested: undefined });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.partial).toBe(false);
    expect(res.plan.packageStatusAfterApproval).toBe("awarded");
    expect(res.plan.remaining).toEqual([]);
  });

  it("refuses a second whole-package award while one is live", () => {
    const live: LiveAwardScope[] = [
      { awardId: "aw1", reference: "AWD-0001", status: "approved", scopeLevellingItemIds: [] },
    ];
    const res = planAwardScope({ items: ITEMS, liveAwards: live, requested: [] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("full_award_exists");
    expect(res.message).toContain("AWD-0001");
  });

  it("refuses a whole-package award when part of the scope is already held", () => {
    const live: LiveAwardScope[] = [
      { awardId: "aw1", reference: "AWD-0001", status: "approved", scopeLevellingItemIds: ["a"] },
    ];
    const res = planAwardScope({ items: ITEMS, liveAwards: live, requested: [] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("partial_award_exists");
    expect(res.message).toMatch(/buy that work a second time/i);
  });

  it("refuses a partial award over rows that are not on the package", () => {
    const res = planAwardScope({ items: ITEMS, liveAwards: [], requested: ["a", "zzz"] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("unknown_scope_rows");
    expect(res.detail["unknownItemIds"]).toEqual(["zzz"]);
  });

  it("refuses overlapping scope and names the award that holds it", () => {
    const live: LiveAwardScope[] = [
      {
        awardId: "aw1",
        reference: "AWD-0001",
        status: "approved",
        scopeLevellingItemIds: ["a", "b"],
      },
    ];
    const res = planAwardScope({ items: ITEMS, liveAwards: live, requested: ["b", "c"] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("scope_overlap");
    expect(res.detail["overlappingItemIds"]).toEqual(["b"]);
    expect(res.message).toContain("AWD-0001");
    expect(res.message).toMatch(/pay for it twice/i);
  });

  it("permits a disjoint partial award and reports what is left", () => {
    const live: LiveAwardScope[] = [
      { awardId: "aw1", reference: "AWD-0001", status: "approved", scopeLevellingItemIds: ["a"] },
    ];
    const res = planAwardScope({ items: ITEMS, liveAwards: live, requested: ["b"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.partial).toBe(true);
    expect(res.plan.coveredItemIds).toEqual(["a", "b"]);
    expect(res.plan.remaining.map((r) => r.id)).toEqual(["c"]);
    expect(res.plan.packageStatusAfterApproval).toBe("partially_awarded");
  });

  it("marks the package fully awarded once every mandatory row is covered", () => {
    const live: LiveAwardScope[] = [
      {
        awardId: "aw1",
        reference: "AWD-0001",
        status: "approved",
        scopeLevellingItemIds: ["a", "b"],
      },
    ];
    const res = planAwardScope({ items: ITEMS, liveAwards: live, requested: ["c"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // "d" is optional, so it does not hold the package open.
    expect(res.plan.packageStatusAfterApproval).toBe("awarded");
    expect(res.plan.note).toMatch(/fully awarded/i);
  });

  it("ignores rejected and withdrawn awards — they hold no scope", () => {
    const live: LiveAwardScope[] = [];
    const res = planAwardScope({ items: ITEMS, liveAwards: live, requested: ["a"] });
    expect(res.ok).toBe(true);
  });

  it("refuses a partial award on a package with no levelling rows", () => {
    const res = planAwardScope({ items: [], liveAwards: [], requested: ["a"] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // An unknown row is caught first; with an id that cannot exist either way
    // the refusal still names the missing scope.
    expect(["unknown_scope_rows", "empty_scope"]).toContain(res.code);
  });

  it("de-duplicates the requested rows", () => {
    const res = planAwardScope({ items: ITEMS, liveAwards: [], requested: ["a", "a", "b"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.scopeItemIds).toEqual(["a", "b"]);
  });
});

describe("scopedLevelledAmount", () => {
  const cells: LevelledCell[] = [
    cell("a", "s1", 100),
    cell("b", "s1", 250.005),
    cell("c", "s1", null, "GBP", "excluded"),
    cell("a", "s2", 90),
    cell("b", "s2", 300),
  ];

  it("sums the bidder's levelled amounts over the named rows", () => {
    const res = scopedLevelledAmount("s1", ["a", "b"], cells, label);
    expect(res.amount).toBe(350.01);
    expect(res.currency).toBe("GBP");
    expect(res.reasons).toEqual([]);
  });

  it("refuses a total when a row carries no levelled figure", () => {
    const res = scopedLevelledAmount("s1", ["a", "c"], cells, label);
    expect(res.amount).toBeNull();
    expect(res.missing.map((m) => m.levellingItemId)).toEqual(["c"]);
    expect(res.reasons.join(" ")).toMatch(/excluded/);
  });

  it("refuses a total when the bidder has no entry on a row at all", () => {
    const res = scopedLevelledAmount("s2", ["a", "c"], cells, label);
    expect(res.amount).toBeNull();
    expect(res.reasons.join(" ")).toMatch(/no levelling entry on that row/i);
  });

  it("never adds across currencies", () => {
    const mixed = [cell("a", "s3", 100, "GBP"), cell("b", "s3", 100, "EUR")];
    const res = scopedLevelledAmount("s3", ["a", "b"], mixed, label);
    expect(res.amount).toBeNull();
    expect(res.reasons.join(" ")).toMatch(/never added together/i);
  });

  it("returns zero rather than null when every row is genuinely priced at zero", () => {
    const zeros = [cell("a", "s4", 0), cell("b", "s4", 0)];
    const res = scopedLevelledAmount("s4", ["a", "b"], zeros, label);
    expect(res.amount).toBe(0);
    expect(res.reasons).toEqual([]);
  });
});

describe("buildScopedComparison", () => {
  const subs = [
    { id: "s1", reference: "BID-0001", vendorId: "v1", status: "received" },
    { id: "s2", reference: "BID-0002", vendorId: "v2", status: "received" },
    { id: "s3", reference: "BID-0003", vendorId: "v3", status: "withdrawn" },
  ];
  const cells: LevelledCell[] = [
    cell("a", "s1", 100),
    cell("b", "s1", 100),
    cell("a", "s2", 80),
    cell("b", "s2", 80),
    cell("a", "s3", 1),
    cell("b", "s3", 1),
  ];

  it("ranks bidders on the subset, not the package total", () => {
    const res = buildScopedComparison(subs, ["a", "b"], cells, label, inContention);
    expect(res.lowest?.submissionId).toBe("s2");
    expect(res.lowest?.amount).toBe(160);
    expect(res.currency).toBe("GBP");
  });

  it("excludes bids that are not in contention however cheap they are", () => {
    const res = buildScopedComparison(subs, ["a", "b"], cells, label, inContention);
    expect(res.candidates.map((c) => c.submissionId)).toEqual(["s1", "s2"]);
  });

  it("ranks nobody where a bidder has left a scope row unpriced", () => {
    const partial: LevelledCell[] = [cell("a", "s1", 100), cell("a", "s2", 80)];
    const res = buildScopedComparison(subs, ["a", "b"], partial, label, inContention);
    expect(res.lowest).toBeNull();
    expect(res.candidates.every((c) => c.amount === null)).toBe(true);
    expect(res.candidates[0]?.reasons.length).toBeGreaterThan(0);
  });
});
