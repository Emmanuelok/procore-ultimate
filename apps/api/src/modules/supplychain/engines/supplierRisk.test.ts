import { describe, expect, it } from "vitest";
import {
  assessSupplyChain,
  countryConcentration,
  levelForScore,
  type RiskNode,
  type SupplyChainRiskInput,
} from "./supplierRisk.js";

const node = (over: Partial<RiskNode> & { id: string }): RiskNode => ({
  name: over.id,
  tier: 1,
  country: "GB",
  criticality: "medium",
  categories: [],
  vendorId: null,
  entityId: null,
  status: "active",
  ...over,
});

const input = (over: Partial<SupplyChainRiskInput> = {}): SupplyChainRiskInput => ({
  nodes: [],
  links: [],
  financials: [],
  prequals: [],
  entities: [],
  items: [],
  today: "2026-09-01",
  ...over,
});

describe("levelForScore", () => {
  it("bands the additive score", () => {
    expect(levelForScore(0)).toBe("low");
    expect(levelForScore(15)).toBe("medium");
    expect(levelForScore(35)).toBe("high");
    expect(levelForScore(60)).toBe("critical");
  });
});

describe("countryConcentration", () => {
  it("refuses to judge with fewer than two critical nodes", () => {
    const c = countryConcentration([node({ id: "a", criticality: "critical" })], 0.5);
    expect(c.flagged).toHaveLength(0);
    expect(c.reasons[0]).toMatch(/Only one/);
  });

  it("flags a country holding the threshold share of critical supply", () => {
    const c = countryConcentration(
      [
        node({ id: "a", criticality: "critical", country: "CN" }),
        node({ id: "b", criticality: "high", country: "CN" }),
        node({ id: "c", criticality: "critical", country: "DE" }),
        node({ id: "d", criticality: "low", country: "GB" }),
      ],
      0.5,
    );
    expect(c.flagged.map((b) => b.country)).toEqual(["CN"]);
    expect(c.flagged[0]?.share).toBeCloseTo(0.667, 2);
  });

  it("excludes nodes without a country and says so", () => {
    const c = countryConcentration(
      [node({ id: "a", criticality: "critical", country: null }), node({ id: "b", criticality: "critical", country: "FR" })],
      0.5,
    );
    expect(c.flagged).toHaveLength(0);
    expect(c.reasons.some((r) => /no country recorded/.test(r))).toBe(true);
  });
});

describe("assessSupplyChain", () => {
  it("returns not_assessable for a node with nothing to read", () => {
    const r = assessSupplyChain(input({ nodes: [node({ id: "n1" })] }));
    expect(r.assessments[0]?.level).toBe("not_assessable");
    expect(r.assessments[0]?.score).toBeNull();
    expect(r.summary.not_assessable).toBe(1);
  });

  it("flags single source on a critical flow with one upstream", () => {
    const r = assessSupplyChain(
      input({
        nodes: [node({ id: "mill", tier: 2, criticality: "critical" }), node({ id: "fab", tier: 1 })],
        links: [{ fromNodeId: "mill", toNodeId: "fab", kind: "supplies", category: "steel", isSoleSource: false }],
      }),
    );
    const mill = r.assessments.find((a) => a.nodeId === "mill")!;
    expect(mill.flags.some((f) => f.code === "single_source" && f.severity === "high")).toBe(true);
    expect(mill.level).toBe("high");
    // fab has an upstream but no downstream link: it is tier 1 so no visibility gap
    const fab = r.assessments.find((a) => a.nodeId === "fab")!;
    expect(fab.flags.some((f) => f.code === "tier_visibility_gap")).toBe(false);
  });

  it("does not flag single source when two upstreams supply the same flow", () => {
    const r = assessSupplyChain(
      input({
        nodes: [node({ id: "m1", tier: 2 }), node({ id: "m2", tier: 2 }), node({ id: "fab" })],
        links: [
          { fromNodeId: "m1", toNodeId: "fab", kind: "supplies", category: "steel", isSoleSource: false },
          { fromNodeId: "m2", toNodeId: "fab", kind: "supplies", category: "steel", isSoleSource: false },
        ],
      }),
    );
    expect(r.assessments.find((a) => a.nodeId === "m1")!.flags.some((f) => f.code === "single_source")).toBe(false);
  });

  it("reads financial distress from the latest prequalification financials", () => {
    const r = assessSupplyChain(
      input({
        nodes: [node({ id: "n1", vendorId: "v1" })],
        financials: [
          { vendorId: "v1", financialYearEnd: "2024-12-31", currentRatio: 1.4, netAssets: 100, gearingPercent: 20, isGoingConcernQualified: false, ccjCount: 0, insolvencyEvents: 0, turnover: 1000 },
          { vendorId: "v1", financialYearEnd: "2025-12-31", currentRatio: 0.7, netAssets: -50, gearingPercent: 150, isGoingConcernQualified: true, ccjCount: 2, insolvencyEvents: 0, turnover: 900 },
        ],
      }),
    );
    const a = r.assessments[0]!;
    expect(a.inputs["financialYearEnd"]).toBe("2025-12-31");
    expect(a.flags.map((f) => f.code)).toEqual(
      expect.arrayContaining(["going_concern", "financial_distress"]),
    );
    expect(a.level).toBe("critical");
    const financial = a.flags.filter((f) => f.code === "financial_distress" || f.code === "going_concern");
    expect(financial.length).toBeGreaterThanOrEqual(4);
    expect(financial.every((f) => f.basis.includes("FYE 2025-12-31"))).toBe(true);
  });

  it("treats a sanctions hit on the linked entity as critical", () => {
    const r = assessSupplyChain(
      input({
        nodes: [node({ id: "n1", entityId: "e1" })],
        entities: [{ id: "e1", screeningStatus: "sanctions_hit", screenedAt: "2026-08-01" }],
      }),
    );
    expect(r.assessments[0]!.flags.some((f) => f.code === "sanctions_hit")).toBe(true);
    expect(r.assessments[0]!.level).toBe("critical");
  });

  it("notes an unscreened critical node and a tier-2 visibility gap", () => {
    const r = assessSupplyChain(input({ nodes: [node({ id: "n1", tier: 3, criticality: "critical" })] }));
    const codes = r.assessments[0]!.flags.map((f) => f.code);
    expect(codes).toContain("sanctions_unscreened");
    expect(codes).toContain("tier_visibility_gap");
    expect(r.assessments[0]!.level).toBe("low");
  });

  it("flags prequal rejection and expiry", () => {
    const r = assessSupplyChain(
      input({
        nodes: [node({ id: "a", vendorId: "v1" }), node({ id: "b", vendorId: "v2" })],
        prequals: [
          { vendorId: "v1", outcome: "rejected", expiresAt: null },
          { vendorId: "v2", outcome: "approved", expiresAt: "2026-01-01" },
        ],
      }),
    );
    expect(r.assessments.find((x) => x.nodeId === "a")!.flags.some((f) => f.code === "prequal_rejected")).toBe(true);
    expect(r.assessments.find((x) => x.nodeId === "b")!.flags.some((f) => f.code === "prequal_missing" && /expired/.test(f.detail))).toBe(true);
  });

  it("adds critical-path exposure and expediting backlog from the long-lead register", () => {
    const r = assessSupplyChain(
      input({
        nodes: [node({ id: "n1" })],
        items: [
          { supplierNodeId: "n1", taskIsCritical: true, riskLevel: "late", expeditingStale: true, status: "ordered" },
          { supplierNodeId: "n1", taskIsCritical: false, riskLevel: "on_track", expeditingStale: false, status: "ordered" },
        ],
      }),
    );
    const a = r.assessments[0]!;
    expect(a.flags.some((f) => f.code === "critical_path_exposure" && f.severity === "high")).toBe(true);
    expect(a.flags.some((f) => f.code === "expediting_backlog")).toBe(true);
    expect(a.level).toBe("high");
  });

  it("applies country concentration to the critical nodes in the flagged country", () => {
    const r = assessSupplyChain(
      input({
        nodes: [
          node({ id: "a", criticality: "critical", country: "CN" }),
          node({ id: "b", criticality: "critical", country: "CN" }),
          node({ id: "c", criticality: "low", country: "CN" }),
        ],
      }),
    );
    expect(r.concentration.flagged[0]?.country).toBe("CN");
    expect(r.assessments.find((x) => x.nodeId === "a")!.flags.some((f) => f.code === "country_concentration")).toBe(true);
    expect(r.assessments.find((x) => x.nodeId === "c")!.flags.some((f) => f.code === "country_concentration")).toBe(false);
  });
});
