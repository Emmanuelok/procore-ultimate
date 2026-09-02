import { describe, expect, it } from "vitest";
import {
  checkDirectAward,
  evaluateMiniCompetition,
  frameworkUtilisation,
  priceCallOffLines,
  type CallOffRow,
  type FrameworkRow,
  type LotRow,
  type SorItem,
} from "./frameworks.js";

const framework: FrameworkRow = {
  id: "fw1",
  reference: "FW-001",
  title: "Minor works",
  currency: "GBP",
  maximumValue: 1_000_000,
  startDate: "2025-01-01",
  endDate: "2026-12-31",
  extensionToDate: null,
  awardMode: "direct_or_mini",
  directAwardThreshold: 100_000,
  status: "live",
};

const lots: LotRow[] = [
  { id: "l1", frameworkId: "fw1", lotNumber: "1", title: "Civils", currency: "GBP", ceilingValue: 400_000, awardMode: null, status: "live" },
  { id: "l2", frameworkId: "fw1", lotNumber: "2", title: "M&E", currency: "GBP", ceilingValue: null, awardMode: "mini_competition", status: "live" },
];

const callOff = (over: Partial<CallOffRow> & { id: string }): CallOffRow => ({
  projectId: "p1",
  reference: over.id,
  frameworkId: "fw1",
  lotId: null,
  termContractId: null,
  route: "direct_award",
  currency: "GBP",
  orderValue: 0,
  certifiedValue: 0,
  status: "issued",
  ...over,
});

describe("frameworkUtilisation (#1053)", () => {
  it("consumes the ceiling from live call-offs and releases cancelled ones", () => {
    const u = frameworkUtilisation(
      framework,
      lots,
      [
        callOff({ id: "c1", lotId: "l1", orderValue: 250_000, certifiedValue: 100_000 }),
        callOff({ id: "c2", lotId: "l1", orderValue: 200_000, status: "cancelled" }),
        callOff({ id: "c3", lotId: "l2", orderValue: 300_000, status: "completed", certifiedValue: 300_000 }),
        callOff({ id: "c4", orderValue: 50_000 }),
      ],
      "2026-09-02",
    );
    expect(u.ordered).toBe(600_000);
    expect(u.certified).toBe(400_000);
    expect(u.headroom).toBe(400_000);
    expect(u.utilisationPercent).toBe(60);
    expect(u.breached).toBe(false);
    expect(u.unallocatedCallOffs).toBe(1);
    const civils = u.lots.find((l) => l.lotId === "l1")!;
    expect(civils.ordered).toBe(250_000);
    expect(civils.headroom).toBe(150_000);
    const me = u.lots.find((l) => l.lotId === "l2")!;
    expect(me.headroom).toBeNull();
    expect(me.reasons[0]).toMatch(/no declared ceiling/);
  });

  it("flags a breached lot ceiling with the amount", () => {
    const u = frameworkUtilisation(framework, lots, [callOff({ id: "c1", lotId: "l1", orderValue: 450_000 })], "2026-09-02");
    const civils = u.lots.find((l) => l.lotId === "l1")!;
    expect(civils.breached).toBe(true);
    expect(civils.breachedBy).toBe(50_000);
  });

  it("excludes call-offs in another currency rather than converting them", () => {
    const u = frameworkUtilisation(
      framework,
      lots,
      [callOff({ id: "c1", orderValue: 900_000, currency: "EUR" }), callOff({ id: "c2", orderValue: 10_000 })],
      "2026-09-02",
    );
    expect(u.ordered).toBe(10_000);
    expect(u.currencyMismatches).toBe(1);
    expect(u.reasons.join(" ")).toMatch(/other than the framework's/);
  });

  it("reports days to expiry from the exercised extension and counts live call-offs", () => {
    const u = frameworkUtilisation(
      { ...framework, extensionToDate: "2027-06-30" },
      [],
      [callOff({ id: "c1", orderValue: 1, status: "in_progress" }), callOff({ id: "c2", orderValue: 1, status: "completed" })],
      "2027-06-01",
    );
    expect(u.expiresOn).toBe("2027-06-30");
    expect(u.daysToExpiry).toBe(29);
    expect(u.liveCallOffsAtExpiry).toBe(1);
  });

  it("says when the framework declares no ceiling", () => {
    const u = frameworkUtilisation({ ...framework, maximumValue: null }, [], [], "2026-09-02");
    expect(u.headroom).toBeNull();
    expect(u.reasons.join(" ")).toMatch(/no declared maximum value/);
  });
});

describe("checkDirectAward (#1053)", () => {
  it("permits a direct award inside the threshold on a live framework", () => {
    expect(checkDirectAward(framework, lots[0]!, 50_000, "GBP")).toEqual({ permitted: true, reasons: [] });
  });

  it("refuses over the threshold, on a mini-competition lot, across currencies and off a dead framework", () => {
    expect(checkDirectAward(framework, null, 150_000, "GBP").reasons[0]).toMatch(/exceeds the framework's direct-award threshold/);
    expect(checkDirectAward(framework, lots[1]!, 10, "GBP").reasons[0]).toMatch(/requires a mini-competition/);
    expect(checkDirectAward(framework, null, 10, "EUR").reasons[0]).toMatch(/cannot be applied across currencies/);
    expect(checkDirectAward({ ...framework, status: "expired" }, null, 10, "GBP").reasons.join(" ")).toMatch(/only a live framework/);
  });
});

describe("priceCallOffLines (#1055–#1056)", () => {
  const sor: SorItem[] = [
    { id: "s1", code: "E10", description: "Excavate", unit: "m3", currency: "GBP", rate: 20, active: true },
    { id: "s2", code: "C20", description: "Concrete", unit: "m3", currency: "GBP", rate: 100, active: false },
    { id: "s3", code: "X99", description: "Foreign", unit: "m", currency: "EUR", rate: 5, active: true },
  ];

  it("applies the contract's percentage adjustment to schedule rates", () => {
    const order = priceCallOffLines([{ code: "E10", quantity: 10 }], sor, { currency: "GBP", adjustmentPercent: 5 });
    expect(order.lines[0]!.baseRate).toBe(20);
    expect(order.lines[0]!.rate).toBe(21);
    expect(order.lines[0]!.amount).toBe(210);
    expect(order.total).toBe(210);
    expect(order.reasons.join(" ")).toMatch(/\+5% adjustment/);
  });

  it("takes a star rate as given and does not adjust it", () => {
    const order = priceCallOffLines([{ code: "E10", quantity: 10, rate: 30 }], sor, { currency: "GBP", adjustmentPercent: 5 });
    expect(order.lines[0]!.source).toBe("star_rate");
    expect(order.lines[0]!.amount).toBe(300);
  });

  it("leaves an unmatched, inactive or foreign-currency line unpriced with a reason", () => {
    const order = priceCallOffLines(
      [{ code: "ZZZ", quantity: 1 }, { code: "C20", quantity: 1 }, { code: "X99", quantity: 1 }, { code: "E10", quantity: 2 }],
      sor,
      { currency: "GBP", adjustmentPercent: 0 },
    );
    expect(order.unpricedLines).toBe(3);
    expect(order.pricedLines).toBe(1);
    expect(order.total).toBe(40);
    expect(order.lines[0]!.reason).toMatch(/no item in the schedule of rates/);
    expect(order.lines[1]!.reason).toMatch(/no longer active/);
    expect(order.lines[2]!.reason).toMatch(/is in EUR/);
    expect(order.reasons.join(" ")).toMatch(/3 line\(s\) could not be priced/);
  });

  it("matches by id as well as by code, case-insensitively", () => {
    const byId = priceCallOffLines([{ sorItemId: "s1", quantity: 1 }], sor, { currency: "GBP", adjustmentPercent: 0 });
    expect(byId.lines[0]!.amount).toBe(20);
    const byCode = priceCallOffLines([{ code: "e10", quantity: 1 }], sor, { currency: "GBP", adjustmentPercent: 0 });
    expect(byCode.lines[0]!.amount).toBe(20);
  });
});

describe("evaluateMiniCompetition (#1054)", () => {
  const criteria = [
    { key: "price", label: "Price", weight: 60, isPrice: true },
    { key: "quality", label: "Quality", weight: 40 },
  ];

  it("scores price against the lowest and blends by weight", () => {
    const result = evaluateMiniCompetition(criteria, [
      { supplierId: "a", supplierName: "A", price: 100, scores: { quality: 60 } },
      { supplierId: "b", supplierName: "B", price: 125, scores: { quality: 100 } },
    ]);
    expect(result.lowestPrice).toBe(100);
    const a = result.responses.find((r) => r.supplierId === "a")!;
    const b = result.responses.find((r) => r.supplierId === "b")!;
    expect(a.priceScore).toBe(100);
    expect(b.priceScore).toBe(80);
    // A: 0.6×100 + 0.4×60 = 84; B: 0.6×80 + 0.4×100 = 88
    expect(a.totalScore).toBeCloseTo(84, 6);
    expect(b.totalScore).toBeCloseTo(88, 6);
    expect(result.indicatedWinnerId).toBe("b");
  });

  it("excludes withdrawn responses and reports unusable prices", () => {
    const result = evaluateMiniCompetition(criteria, [
      { supplierId: "a", supplierName: "A", price: 100, scores: { quality: 50 } },
      { supplierId: "b", supplierName: "B", price: null, scores: { quality: 90 } },
      { supplierId: "c", supplierName: "C", price: 50, scores: { quality: 10 }, withdrawn: true },
    ]);
    expect(result.responses).toHaveLength(2);
    expect(result.lowestPrice).toBe(100); // the withdrawn 50 does not set the benchmark
    expect(result.warnings.join(" ")).toMatch(/1 response\(s\) were withdrawn/);
    const b = result.responses.find((r) => r.supplierId === "b")!;
    expect(b.priceScore).toBeNull();
    expect(b.reasons.join(" ")).toMatch(/no usable price/);
    // B is scored on quality only: 40 of the 100 weight
    expect(b.totalScore).toBe(90);
    expect(b.reasons.join(" ")).toMatch(/40% of the evaluation weight/);
  });

  it("warns when no criterion carries weight", () => {
    const result = evaluateMiniCompetition([{ key: "q", label: "Q", weight: 0 }], [
      { supplierId: "a", supplierName: "A", price: 10 },
    ]);
    expect(result.warnings.join(" ")).toMatch(/No evaluation criterion carries weight/);
    expect(result.responses[0]!.totalScore).toBeNull();
    expect(result.indicatedWinnerId).toBeNull();
  });
});
