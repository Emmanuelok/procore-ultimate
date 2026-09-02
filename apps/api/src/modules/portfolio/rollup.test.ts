import { describe, expect, it } from "vitest";
import {
  affordability,
  appropriationPosition,
  classificationSplit,
  combinedTotal,
  fundingSourcePosition,
  pipeline,
  rollUpPortfolio,
  unknowable,
  type AllocationRow,
  type AppropriationRow,
  type EnvelopeRow,
  type GateRow,
  type RollupProject,
} from "./rollup.js";

const project = (over: Partial<RollupProject> & { projectId: string }): RollupProject => ({
  name: over.projectId.toUpperCase(),
  stage: "construction",
  currency: "GBP",
  value: null,
  portfolioId: null,
  isSandbox: false,
  ...over,
});

const allocation = (over: Partial<AllocationRow> & { id: string }): AllocationRow => ({
  appropriationId: null,
  fundingSourceId: null,
  projectId: "p1",
  currency: "GBP",
  amount: 0,
  drawnAmount: 0,
  status: "approved",
  expenditureClass: "capital",
  fiscalYear: "2026/27",
  ...over,
});

describe("combinedTotal", () => {
  it("totals a single currency and refuses to total several", () => {
    expect(combinedTotal([{ currency: "GBP", v: 10 }], (b) => b.v, "spend")).toEqual({ value: 10, reasons: [] });
    const mixed = combinedTotal(
      [
        { currency: "GBP", v: 10 },
        { currency: "EUR", v: 5 },
      ],
      (b) => b.v,
      "spend",
    );
    expect(mixed.value).toBeNull();
    expect(mixed.reasons[0]).toMatch(/exchange rate/);
    expect(combinedTotal([], (b: { currency: string }) => 0, "spend").value).toBeNull();
    expect(unknowable(["because"]).reasons).toEqual(["because"]);
  });
});

describe("rollUpPortfolio (#777)", () => {
  it("buckets by currency, never sums across, and names what is missing", () => {
    const result = rollUpPortfolio(
      [
        project({ projectId: "p1", currency: "GBP", value: 1000 }),
        project({ projectId: "p2", currency: "EUR", value: 500 }),
        project({ projectId: "p3", currency: "GBP", value: 250 }),
        project({ projectId: "sandbox", currency: "GBP", value: 999, isSandbox: true }),
      ],
      [
        { projectId: "p1", currency: "GBP", revisedBudgetTotal: 900, committedTotal: 400, jobToDateCostsTotal: 200, forecastFinalTotal: 950 },
        { projectId: "p2", currency: "EUR", revisedBudgetTotal: 400, committedTotal: 100, jobToDateCostsTotal: 50, forecastFinalTotal: 420 },
      ],
      [{ projectId: "p1", currency: "GBP", revisedCommitmentSum: 400, totalInvoiced: 250, totalPaid: 200 }],
    );
    expect(result.byCurrency.map((b) => b.currency)).toEqual(["EUR", "GBP"]);
    const gbp = result.byCurrency.find((b) => b.currency === "GBP")!;
    expect(gbp.projects).toBe(2); // sandbox excluded
    expect(gbp.projectValue).toBe(1250);
    expect(gbp.forecastVariance).toBe(50);
    expect(result.combinedForecastFinal.value).toBeNull();
    expect(result.combinedForecastFinal.reasons[0]).toMatch(/2 currencies/);
    expect(result.projectsWithoutBudget).toBe(1);
    expect(result.reasons.join(" ")).toMatch(/sandbox project/);
    expect(result.reasons.join(" ")).toMatch(/no active budget/);
  });

  it("gives a combined total when there is only one currency", () => {
    const result = rollUpPortfolio(
      [project({ projectId: "p1", value: 100 })],
      [{ projectId: "p1", currency: "GBP", revisedBudgetTotal: 90, committedTotal: 10, jobToDateCostsTotal: 5, forecastFinalTotal: 95 }],
      [],
    );
    expect(result.combinedForecastFinal.value).toBe(95);
  });

  it("counts a budget denominated differently from its project and flags it", () => {
    const result = rollUpPortfolio(
      [project({ projectId: "p1", currency: "GBP" })],
      [{ projectId: "p1", currency: "USD", revisedBudgetTotal: 100, committedTotal: 0, jobToDateCostsTotal: 0, forecastFinalTotal: 100 }],
      [],
    );
    expect(result.projectsMixedCurrency).toBe(1);
    expect(result.byCurrency.find((b) => b.currency === "USD")!.revisedBudget).toBe(100);
    expect(result.reasons.join(" ")).toMatch(/other than their project's header currency/);
  });

  it("ignores rows for projects outside the set", () => {
    const result = rollUpPortfolio(
      [project({ projectId: "p1" })],
      [{ projectId: "ghost", currency: "GBP", revisedBudgetTotal: 1000, committedTotal: 0, jobToDateCostsTotal: 0, forecastFinalTotal: 1000 }],
      [{ projectId: "ghost", currency: "GBP", revisedCommitmentSum: 50, totalInvoiced: 0, totalPaid: 0 }],
    );
    expect(result.byCurrency[0]!.revisedBudget).toBe(0);
    expect(result.byCurrency[0]!.commitmentValue).toBe(0);
  });
});

describe("appropriationPosition (#428, #433)", () => {
  const appropriation: AppropriationRow = {
    id: "ap1",
    fiscalYear: "2026/27",
    currency: "GBP",
    appropriatedAmount: 1000,
    carriedForwardIn: 200,
    carriedForwardOut: 0,
    virementNet: -100,
    status: "approved",
    carryForwardPolicy: "carry_forward",
    expenditureClass: "capital",
  };

  it("computes authority, allocation and headroom", () => {
    const pos = appropriationPosition(appropriation, [
      allocation({ id: "a1", appropriationId: "ap1", amount: 600, drawnAmount: 300 }),
      allocation({ id: "a2", appropriationId: "ap1", amount: 200, drawnAmount: 0, status: "cancelled" }),
      allocation({ id: "a3", appropriationId: "other", amount: 900 }),
    ]);
    expect(pos.authorised).toBe(1100); // 1000 + 200 − 100
    expect(pos.allocated).toBe(600); // cancelled released
    expect(pos.drawn).toBe(300);
    expect(pos.uncommitted).toBe(500);
    expect(pos.overcommitted).toBe(false);
    expect(pos.utilisationPercent).toBeCloseTo(54.55, 2);
    expect(pos.carryForwardEligible).toBe(800);
  });

  it("flags an overcommitted appropriation", () => {
    const pos = appropriationPosition(appropriation, [
      allocation({ id: "a1", appropriationId: "ap1", amount: 1500 }),
    ]);
    expect(pos.overcommitted).toBe(true);
    expect(pos.overcommittedBy).toBe(400);
  });

  it("excludes allocations in another currency rather than adding them at par", () => {
    const pos = appropriationPosition(appropriation, [
      allocation({ id: "a1", appropriationId: "ap1", amount: 400 }),
      allocation({ id: "a2", appropriationId: "ap1", amount: 400, currency: "EUR" }),
    ]);
    expect(pos.allocated).toBe(400);
    expect(pos.currencyMismatches).toBe(1);
    expect(pos.reasons.join(" ")).toMatch(/different currency/);
  });

  it("lapses rather than carries when the policy says so, and says what is lost", () => {
    const pos = appropriationPosition({ ...appropriation, carryForwardPolicy: "lapse" }, []);
    expect(pos.carryForwardEligible).toBe(0);
    expect(pos.reasons.join(" ")).toMatch(/would be lost at the year end/);
  });

  it("states that a request policy is not automatic", () => {
    const pos = appropriationPosition({ ...appropriation, carryForwardPolicy: "request" }, []);
    expect(pos.reasons.join(" ")).toMatch(/requires an approval/);
  });
});

describe("fundingSourcePosition (#427)", () => {
  it("computes headroom and flags an overdrawn facility", () => {
    const pos = fundingSourcePosition(
      { id: "fs1", currency: "GBP", amount: 1000, status: "available", expenditureClass: "capital" },
      [
        allocation({ id: "a1", fundingSourceId: "fs1", amount: 700, drawnAmount: 400 }),
        allocation({ id: "a2", fundingSourceId: "fs1", amount: 500 }),
        allocation({ id: "a3", fundingSourceId: "fs1", amount: 999, currency: "USD" }),
      ],
    );
    expect(pos.allocated).toBe(1200);
    expect(pos.headroom).toBe(-200);
    expect(pos.overdrawn).toBe(true);
    expect(pos.overdrawnBy).toBe(200);
    expect(pos.drawn).toBe(400);
    expect(pos.currencyMismatches).toBe(1);
  });
});

describe("affordability (#426, #430)", () => {
  const envelopes: EnvelopeRow[] = [
    {
      id: "e1",
      name: "Capital 26/27",
      portfolioId: null,
      fiscalYear: "2026/27",
      currency: "GBP",
      envelopeAmount: 1000,
      expenditureClass: "capital",
      status: "active",
      basis: "Board minute 12",
    },
    {
      id: "e2",
      name: "Draft",
      portfolioId: null,
      fiscalYear: "2026/27",
      currency: "GBP",
      envelopeAmount: 9999,
      expenditureClass: "capital",
      status: "draft",
      basis: null,
    },
  ];

  it("measures demand only in the matching year, currency and class", () => {
    const result = affordability(envelopes, [
      allocation({ id: "a1", amount: 600 }),
      allocation({ id: "a2", amount: 300, expenditureClass: "revenue" }),
      allocation({ id: "a3", amount: 200, currency: "EUR" }),
      allocation({ id: "a4", amount: 100, fiscalYear: "2027/28" }),
      allocation({ id: "a5", amount: 500, status: "cancelled" }),
    ]);
    expect(result.lines).toHaveLength(1); // the draft envelope is not a control
    const line = result.lines[0]!;
    expect(line.demand).toBe(600);
    expect(line.headroom).toBe(400);
    expect(line.breached).toBe(false);
    expect(line.utilisationPercent).toBe(60);
    expect(line.basis).toBe("Board minute 12");
    expect(result.uncovered.map((u) => u.expenditureClass).sort()).toEqual(["capital", "capital", "revenue"]);
    expect(result.reasons.join(" ")).toMatch(/fall outside every active envelope/);
  });

  it("flags a breach with the amount", () => {
    const result = affordability(envelopes, [allocation({ id: "a1", amount: 1400 })]);
    expect(result.lines[0]!.breached).toBe(true);
    expect(result.lines[0]!.breachedBy).toBe(400);
  });

  it("says so when nothing is active", () => {
    const result = affordability([{ ...envelopes[1]! }], []);
    expect(result.lines).toEqual([]);
    expect(result.reasons.join(" ")).toMatch(/No envelope is active/);
  });

  it("lets a mixed-class envelope absorb both classes", () => {
    const mixed: EnvelopeRow = { ...envelopes[0]!, id: "e3", expenditureClass: "mixed" };
    const result = affordability([mixed], [
      allocation({ id: "a1", amount: 400 }),
      allocation({ id: "a2", amount: 300, expenditureClass: "revenue" }),
    ]);
    expect(result.lines[0]!.demand).toBe(700);
    expect(result.uncovered).toEqual([]);
  });
});

describe("classificationSplit (#430)", () => {
  it("splits per currency and ignores cancelled allocations", () => {
    const split = classificationSplit([
      allocation({ id: "a1", amount: 600 }),
      allocation({ id: "a2", amount: 400, expenditureClass: "revenue" }),
      allocation({ id: "a3", amount: 100, expenditureClass: "unclassified" }),
      allocation({ id: "a4", amount: 200, currency: "EUR", expenditureClass: "mixed" }),
      allocation({ id: "a5", amount: 900, status: "cancelled" }),
    ]);
    const gbp = split.find((s) => s.currency === "GBP")!;
    expect(gbp.capital).toBe(600);
    expect(gbp.revenue).toBe(400);
    expect(gbp.unclassified).toBe(100);
    expect(gbp.total).toBe(1100);
    expect(gbp.capitalPercent).toBeCloseTo(54.55, 2);
    expect(split.find((s) => s.currency === "EUR")!.mixed).toBe(200);
  });
});

describe("pipeline (#778, #786)", () => {
  const gates: GateRow[] = [
    { id: "g1", projectId: "p1", gateNumber: 1, name: "Gate 1", status: "decided", plannedDate: "2026-01-01" },
    { id: "g2", projectId: "p1", gateNumber: 2, name: "Gate 2", status: "pending", plannedDate: "2026-06-01" },
    { id: "g3", projectId: "p1", gateNumber: 3, name: "Gate 3", status: "pending", plannedDate: null },
  ];

  it("reports the next gate, decided count and overdue gates", () => {
    const result = pipeline(
      [project({ projectId: "p1", name: "Alpha", stage: "design" }), project({ projectId: "p2", name: "Beta" })],
      gates,
      [
        { id: "r1", gateId: "g1", projectId: "p1", reviewDate: "2026-01-05", rag: "amber", decision: "approve_with_conditions" },
        { id: "r2", gateId: "g1", projectId: "p1", reviewDate: "2025-11-01", rag: "green", decision: "approve" },
      ],
      "2026-09-02",
    );
    const alpha = result.entries.find((e) => e.projectId === "p1")!;
    expect(alpha.gatesTotal).toBe(3);
    expect(alpha.gatesDecided).toBe(1);
    expect(alpha.nextGate!.gateNumber).toBe(2);
    expect(alpha.overdueGates).toBe(1); // gate 2 planned 2026-06-01, still pending
    expect(alpha.lastReview).toEqual({ gateNumber: 1, reviewDate: "2026-01-05", rag: "amber", decision: "approve_with_conditions" });
    const beta = result.entries.find((e) => e.projectId === "p2")!;
    expect(beta.gatesTotal).toBe(0);
    expect(beta.reasons[0]).toMatch(/No stage gates/);
    expect(result.projectsWithoutGates).toBe(1);
    expect(result.gatesOverdue).toBe(1);
    expect(result.byStage).toEqual({ design: 1, construction: 1 });
    expect(result.byRag).toEqual({ amber: 1, unrated: 1 });
  });

  it("excludes sandbox projects", () => {
    const result = pipeline([project({ projectId: "s", isSandbox: true })], [], [], "2026-09-02");
    expect(result.entries).toEqual([]);
  });
});
