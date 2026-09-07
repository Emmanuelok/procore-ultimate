import { describe, expect, it } from "vitest";
import {
  MIN_PROJECTS,
  clausePerformance,
  normaliseClause,
  normaliseFamily,
  normaliseRoute,
  procurementRoutePerformance,
  type DisputeObservation,
  type ProjectObservation,
  type VariationObservation,
} from "./clauses.js";

const ASOF = "2026-09-01";

function dispute(over: Partial<DisputeObservation> = {}): DisputeObservation {
  return {
    projectId: "prj_1",
    clause: "20.1",
    contractFamily: "FIDIC",
    status: "settled",
    outcome: "settled",
    rootCause: "late_information",
    amountClaimed: 100_000,
    amountAwarded: 40_000,
    currency: "GBP",
    resolvedAt: "2026-05-01",
    ...over,
  };
}

function variation(over: Partial<VariationObservation> = {}): VariationObservation {
  return {
    projectId: "prj_1",
    clause: "13.3",
    status: "agreed",
    currency: "GBP",
    agreedValue: 25_000,
    costEstimate: 24_000,
    timeImpactDays: 4,
    ...over,
  };
}

function project(over: Partial<ProjectObservation> = {}): ProjectObservation {
  return {
    projectId: "prj_1",
    name: "Project One",
    procurementRoute: "design_and_build",
    contractFamily: "FIDIC",
    contractSum: 1_000_000,
    contractCurrency: "GBP",
    ...over,
  };
}

describe("clause reference normalisation", () => {
  it("collapses the ways people write the same clause", () => {
    expect(normaliseClause("Sub-Clause 20.1")).toBe("20.1");
    expect(normaliseClause("clause 20.1")).toBe("20.1");
    expect(normaliseClause("Cl. 20.1")).toBe("20.1");
    expect(normaliseClause("20.1 [Contractor's Claims]")).toBe("20.1");
    expect(normaliseClause("  20.1 ,")).toBe("20.1");
    expect(normaliseClause("Clause  60.1 (12) ")).toBe("60.1");
  });

  it("never guesses a relationship between different clauses", () => {
    expect(normaliseClause("20")).toBe("20");
    expect(normaliseClause("20.1")).toBe("20.1");
    expect(normaliseClause("20")).not.toBe(normaliseClause("20.1"));
  });

  it("treats blank and missing references as unattributable, not as a clause", () => {
    expect(normaliseClause(null)).toBeNull();
    expect(normaliseClause("")).toBeNull();
    expect(normaliseClause("   ")).toBeNull();
    expect(normaliseClause("clause")).toBeNull();
  });

  it("labels an unrecorded family and route rather than dropping the row", () => {
    expect(normaliseFamily(null)).toBe("unrecorded");
    expect(normaliseFamily(" NEC4 ")).toBe("nec4");
    expect(normaliseRoute("")).toBe("unrecorded");
    expect(normaliseRoute("Design and Build")).toBe("design and build");
  });
});

describe("clausePerformance", () => {
  it("groups disputes by family and clause and measures recovery", () => {
    const report = clausePerformance({
      asOf: ASOF,
      disputes: [
        dispute({ projectId: "prj_1", amountClaimed: 100_000, amountAwarded: 40_000 }),
        dispute({
          projectId: "prj_2",
          clause: "Sub-Clause 20.1",
          amountClaimed: 100_000,
          amountAwarded: 60_000,
        }),
      ],
      variations: [],
      forensicClaims: [],
      obligations: [],
    });
    expect(report.items).toHaveLength(1);
    const row = report.items[0]!;
    expect(row.key).toBe("fidic::20.1");
    expect(row.disputes).toBe(2);
    expect(row.projects).toBe(2);
    expect(row.disputesResolved).toBe(2);
    expect(row.amountClaimed).toEqual({ GBP: 200_000 });
    expect(row.amountAwarded).toEqual({ GBP: 100_000 });
    expect(row.recoveryRatio).toBe(0.5);
    expect(row.recoveryObservations).toBe(2);
  });

  it("keeps the same clause number under different forms apart", () => {
    const report = clausePerformance({
      asOf: ASOF,
      disputes: [
        dispute({ contractFamily: "FIDIC" }),
        dispute({ projectId: "prj_2", contractFamily: "NEC4" }),
      ],
      variations: [],
      forensicClaims: [],
      obligations: [],
    });
    expect(report.items.map((r) => r.key).sort()).toEqual(["fidic::20.1", "nec4::20.1"]);
  });

  it("never sums money across currencies", () => {
    const report = clausePerformance({
      asOf: ASOF,
      disputes: [
        dispute({ currency: "GBP", amountClaimed: 100_000, amountAwarded: null }),
        dispute({ projectId: "prj_2", currency: "EUR", amountClaimed: 50_000, amountAwarded: null }),
      ],
      variations: [],
      forensicClaims: [],
      obligations: [],
    });
    const row = report.items[0]!;
    expect(row.amountClaimed).toEqual({ GBP: 100_000, EUR: 50_000 });
    expect(row.recoveryRatio).toBeNull();
    expect(row.reasons.join(" ")).toContain("No recovery ratio");
  });

  it("reports a clause with no awarded figure as unknown rather than zero recovery", () => {
    const report = clausePerformance({
      asOf: ASOF,
      disputes: [dispute({ amountAwarded: null })],
      variations: [],
      forensicClaims: [],
      obligations: [],
    });
    expect(report.items[0]!.recoveryRatio).toBeNull();
    expect(report.items[0]!.recoveryObservations).toBe(0);
  });

  it("counts obligations and their breaches per clause", () => {
    const report = clausePerformance({
      asOf: ASOF,
      disputes: [],
      variations: [],
      forensicClaims: [],
      obligations: [
        { projectId: "prj_1", clause: "20.1", status: "breached" },
        { projectId: "prj_1", clause: "Clause 20.1", status: "discharged" },
        { projectId: "prj_2", clause: "20.1", status: "open" },
        { projectId: "prj_2", clause: null, status: "breached" },
      ],
    });
    const row = report.items.find((r) => r.clause === "20.1")!;
    expect(row.obligations).toBe(3);
    expect(row.obligationsBreached).toBe(1);
    expect(row.breachRate).toBeCloseTo(1 / 3, 4);
    expect(report.unattributed.obligations).toBe(1);
  });

  it("attributes variations to the family the project's disputes established", () => {
    const report = clausePerformance({
      asOf: ASOF,
      disputes: [dispute({ clause: "20.1", contractFamily: "JCT" })],
      variations: [variation({ clause: "5.6", timeImpactDays: 6 })],
      forensicClaims: [],
      obligations: [],
    });
    const row = report.items.find((r) => r.clause === "5.6")!;
    expect(row.contractFamily).toBe("jct");
    expect(row.variations).toBe(1);
    expect(row.variationValue).toEqual({ GBP: 25_000 });
    expect(row.variationTimeImpactDays).toBe(6);
  });

  it("falls back to the estimate when no value was agreed, and averages time impact", () => {
    const report = clausePerformance({
      asOf: ASOF,
      disputes: [],
      variations: [
        variation({ agreedValue: null, costEstimate: 10_000, timeImpactDays: 2 }),
        variation({ agreedValue: 30_000, timeImpactDays: 8 }),
      ],
      forensicClaims: [],
      obligations: [],
    });
    const row = report.items[0]!;
    expect(row.variationValue).toEqual({ GBP: 40_000 });
    expect(row.variationTimeImpactDays).toBe(5);
  });

  it("counts records with no clause reference instead of silently dropping them", () => {
    const report = clausePerformance({
      asOf: ASOF,
      disputes: [dispute({ clause: null })],
      variations: [variation({ clause: "  " })],
      forensicClaims: [
        {
          projectId: "prj_1",
          clause: null,
          status: "submitted",
          currency: "GBP",
          amountClaimed: 1,
          amountAssessed: null,
          daysClaimed: null,
          daysAssessed: null,
        },
      ],
      obligations: [],
    });
    expect(report.items).toHaveLength(0);
    expect(report.unattributed).toEqual({
      disputes: 1,
      variations: 1,
      forensicClaims: 1,
      obligations: 0,
    });
    expect(report.reasons.join(" ")).toContain("carry no clause reference");
  });

  it("flags a single-project clause as one project's experience", () => {
    const report = clausePerformance({
      asOf: ASOF,
      disputes: [dispute()],
      variations: [],
      forensicClaims: [],
      obligations: [],
    });
    expect(report.items[0]!.reasons.join(" ")).toContain("single project");
  });

  it("warns that an unrecorded contract form is not comparable", () => {
    const report = clausePerformance({
      asOf: ASOF,
      disputes: [dispute({ contractFamily: null })],
      variations: [],
      forensicClaims: [],
      obligations: [],
    });
    expect(report.items[0]!.contractFamily).toBe("unrecorded");
    expect(report.items[0]!.reasons.join(" ")).toContain("not comparable");
  });

  it("orders the most-disputed clause first", () => {
    const report = clausePerformance({
      asOf: ASOF,
      disputes: [
        dispute({ clause: "8.4" }),
        dispute({ clause: "20.1", projectId: "prj_2" }),
        dispute({ clause: "20.1", projectId: "prj_3" }),
      ],
      variations: [],
      forensicClaims: [],
      obligations: [],
    });
    expect(report.items.map((r) => r.clause)).toEqual(["20.1", "8.4"]);
  });

  it("says so when nothing carries a clause at all", () => {
    const report = clausePerformance({
      asOf: ASOF,
      disputes: [],
      variations: [],
      forensicClaims: [],
      obligations: [],
    });
    expect(report.items).toHaveLength(0);
    expect(report.reasons.join(" ")).toContain("nothing to measure");
  });
});

describe("procurementRoutePerformance", () => {
  const fourProjects: ProjectObservation[] = [
    project({ projectId: "p1" }),
    project({ projectId: "p2" }),
    project({ projectId: "p3" }),
    project({ projectId: "p4" }),
  ];

  it("computes outturn variance as the mean of per-project ratios", () => {
    const report = procurementRoutePerformance({
      asOf: ASOF,
      projects: fourProjects,
      disputes: [],
      variations: [
        variation({ projectId: "p1", agreedValue: 100_000 }),
        variation({ projectId: "p2", agreedValue: 200_000 }),
      ],
    });
    const row = report.items[0]!;
    // ratios: 0.10, 0.20, 0, 0 → mean 0.075 → 7.5%
    expect(row.outturnVariancePercent).toBe(7.5);
    expect(row.outturnObservations).toBe(4);
    expect(row.variationsPerProject).toBe(0.5);
    expect(row.reliable).toBe(true);
  });

  it("only counts variations that were actually agreed", () => {
    const report = procurementRoutePerformance({
      asOf: ASOF,
      projects: [project({ projectId: "p1" })],
      disputes: [],
      variations: [
        variation({ projectId: "p1", status: "proposed", agreedValue: 500_000 }),
        variation({ projectId: "p1", status: "agreed", agreedValue: 100_000 }),
      ],
    });
    const row = report.items[0]!;
    expect(row.agreedVariationValue).toEqual({ GBP: 100_000 });
    expect(row.outturnVariancePercent).toBe(10);
    expect(row.variations).toBe(2);
  });

  it("excludes a project whose variations are in another currency, and says why", () => {
    const report = procurementRoutePerformance({
      asOf: ASOF,
      projects: [project({ projectId: "p1" }), project({ projectId: "p2" })],
      disputes: [],
      variations: [
        variation({ projectId: "p1", currency: "EUR", agreedValue: 100_000 }),
        variation({ projectId: "p2", agreedValue: 50_000 }),
      ],
    });
    const row = report.items[0]!;
    expect(row.outturnObservations).toBe(1);
    expect(row.outturnVariancePercent).toBe(5);
    expect(row.agreedVariationValue).toEqual({ EUR: 100_000, GBP: 50_000 });
    expect(row.reasons.join(" ")).toContain("other than the contract currency");
  });

  it("reports the dispute rate as the share of projects that had one", () => {
    const report = procurementRoutePerformance({
      asOf: ASOF,
      projects: fourProjects,
      disputes: [
        dispute({ projectId: "p1" }),
        dispute({ projectId: "p1" }),
        dispute({ projectId: "p2" }),
      ],
      variations: [],
    });
    const row = report.items[0]!;
    expect(row.disputes).toBe(3);
    expect(row.disputedProjects).toBe(2);
    expect(row.disputeRate).toBe(0.5);
  });

  it("splits routes and keeps unrecorded ones visible", () => {
    const report = procurementRoutePerformance({
      asOf: ASOF,
      projects: [
        project({ projectId: "p1", procurementRoute: "traditional" }),
        project({ projectId: "p2", procurementRoute: null }),
        project({ projectId: "p3", procurementRoute: null }),
      ],
      disputes: [],
      variations: [],
    });
    expect(report.items.map((r) => r.route)).toEqual(["unrecorded", "traditional"]);
    const unrecorded = report.items.find((r) => r.route === "unrecorded")!;
    expect(unrecorded.reasons.join(" ")).toContain("No procurement route is recorded");
  });

  it("flags a thin sample as indicative rather than hiding it", () => {
    const report = procurementRoutePerformance({
      asOf: ASOF,
      projects: [project({ projectId: "p1" })],
      disputes: [],
      variations: [],
    });
    const row = report.items[0]!;
    expect(row.reliable).toBe(false);
    expect(row.projects).toBeLessThan(MIN_PROJECTS);
    expect(row.reasons.join(" ")).toContain(`below the ${MIN_PROJECTS}`);
  });

  it("cannot compute a variance without a contract sum, and says how many", () => {
    const report = procurementRoutePerformance({
      asOf: ASOF,
      projects: [
        project({ projectId: "p1", contractSum: null }),
        project({ projectId: "p2", contractSum: 500_000 }),
      ],
      disputes: [],
      variations: [variation({ projectId: "p2", agreedValue: 50_000 })],
    });
    const row = report.items[0]!;
    expect(row.outturnObservations).toBe(1);
    expect(row.outturnVariancePercent).toBe(10);
    expect(row.reasons.join(" ")).toContain("no contract sum");
  });

  it("never sums contract sums across currencies", () => {
    const report = procurementRoutePerformance({
      asOf: ASOF,
      projects: [
        project({ projectId: "p1", contractSum: 1_000_000, contractCurrency: "GBP" }),
        project({ projectId: "p2", contractSum: 2_000_000, contractCurrency: "USD" }),
      ],
      disputes: [],
      variations: [],
    });
    expect(report.items[0]!.contractSum).toEqual({ GBP: 1_000_000, USD: 2_000_000 });
  });

  it("says so when the caller can see no project", () => {
    const report = procurementRoutePerformance({
      asOf: ASOF,
      projects: [],
      disputes: [],
      variations: [],
    });
    expect(report.items).toHaveLength(0);
    expect(report.reasons.join(" ")).toContain("no route can be measured");
  });
});
