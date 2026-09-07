import { describe, expect, it } from "vitest";
import { computeEarnedValue, plannedFraction, type EvActivity } from "./earnedvalue.js";

function act(id: string, extra: Partial<EvActivity> = {}): EvActivity {
  return {
    id,
    name: id.toUpperCase(),
    bac: 1000,
    actualCost: 0,
    percentComplete: 0,
    plannedStart: "2026-01-01",
    plannedFinish: "2026-01-10",
    durationDays: 10,
    ...extra,
  };
}

describe("plannedFraction", () => {
  it("is 0 before the start, 1 after the finish and linear between", () => {
    expect(plannedFraction("2026-01-01", "2026-01-10", 10, "2025-12-31")).toBe(0);
    expect(plannedFraction("2026-01-01", "2026-01-10", 10, "2026-01-05")).toBe(0.5);
    expect(plannedFraction("2026-01-01", "2026-01-10", 10, "2026-02-01")).toBe(1);
  });

  it("falls back to duration when no finish date is known", () => {
    expect(plannedFraction("2026-01-01", null, 4, "2026-01-02")).toBe(0.5);
  });

  it("is null with no planned start — the caller must not treat that as zero", () => {
    expect(plannedFraction(null, "2026-01-10", 10, "2026-01-05")).toBeNull();
  });
});

describe("computeEarnedValue", () => {
  it("computes PV/EV/AC, the indices and both EACs", () => {
    const res = computeEarnedValue({
      dataDate: "2026-01-05",
      currency: "GBP",
      activities: [
        act("a", { percentComplete: 40, actualCost: 500 }),
        act("b", { percentComplete: 60, actualCost: 700 }),
      ],
    });
    expect(res.bac).toBe(2000);
    expect(res.pv).toBe(1000); // both half-planned at the data date
    expect(res.ev).toBe(1000); // 400 + 600
    expect(res.ac).toBe(1200);
    expect(res.spi).toBe(1);
    expect(res.cpi).toBeCloseTo(0.8333, 4);
    expect(res.eac).toBeCloseTo(2400.05, 1);
    expect(res.vac !== null && res.vac < 0).toBe(true); // overrun
    expect(res.currency).toBe("GBP");
  });

  it("reports SPI/CPI as null rather than inventing 1 when the denominator is 0", () => {
    const res = computeEarnedValue({
      dataDate: "2025-12-01", // before every planned start
      currency: "USD",
      activities: [act("a")],
    });
    expect(res.pv).toBe(0);
    expect(res.spi).toBeNull();
    expect(res.cpi).toBeNull();
    expect(res.eac).toBeNull();
    expect(res.scheduleEacDays).toBeNull();
  });

  it("excludes unpriced activities instead of counting them as zero, and says so", () => {
    const res = computeEarnedValue({
      dataDate: "2026-01-05",
      currency: "USD",
      activities: [act("a", { percentComplete: 50, actualCost: 400 }), act("b", { bac: null })],
    });
    expect(res.pricedActivities).toBe(1);
    expect(res.unpriced).toBe(1);
    expect(res.bac).toBe(1000);
    expect(res.reasons.join(" ")).toContain("no budget line");
  });

  it("returns an honest empty result when nothing is priced", () => {
    const res = computeEarnedValue({
      dataDate: "2026-01-05",
      currency: "USD",
      activities: [act("a", { bac: null }), act("b", { bac: 0 })],
    });
    expect(res.bac).toBe(0);
    expect(res.spi).toBeNull();
    expect(res.reasons.join(" ")).toContain("No activity carries a cost basis");
  });

  it("derives a schedule EAC in days from SPI", () => {
    const res = computeEarnedValue({
      dataDate: "2026-01-10",
      currency: "USD",
      activities: [act("a", { percentComplete: 50, actualCost: 500 })],
    });
    expect(res.plannedDurationDays).toBe(10);
    expect(res.spi).toBe(0.5);
    expect(res.scheduleEacDays).toBe(20);
  });

  it("never counts an unknown actual cost as zero: CPI is measured over the costed activities only", () => {
    const res = computeEarnedValue({
      dataDate: "2026-01-10",
      currency: "GBP",
      activities: [
        act("a", { percentComplete: 100, actualCost: 900 }),
        act("b", { percentComplete: 100, actualCost: 1000 }),
        act("c", { percentComplete: 100, actualCost: null }), // priced, no cost source
      ],
    });
    expect(res.costUnknown).toBe(1);
    expect(res.costedBac).toBe(2000);
    expect(res.costCoverage).toBeCloseTo(0.6667, 3);
    expect(res.ac).toBe(1900); // c contributes nothing, not 0
    // the naive figure would be EV 3000 / AC 1900 = 1.58; the honest one is 2000/1900
    expect(res.cpi).toBeCloseTo(1.0526, 3);
    expect(res.eac).toBeCloseTo(2900, 0); // 2000/1.0526 + 1000 carried at budget
    expect(res.activities.find((a) => a.id === "c")?.ac).toBeNull();
    expect(res.activities.find((a) => a.id === "c")?.cv).toBeNull();
    expect(res.reasons.join(" ")).toContain("no booked cost");
  });

  it("withholds CPI and EAC when most of the priced budget has no booked cost", () => {
    const res = computeEarnedValue({
      dataDate: "2026-01-10",
      currency: "GBP",
      activities: [
        act("a", { percentComplete: 100, actualCost: 900 }),
        act("b", { percentComplete: 100, actualCost: null }),
        act("c", { percentComplete: 100, actualCost: null }),
      ],
    });
    expect(res.costCoverage).toBeCloseTo(0.3333, 3);
    expect(res.cpi).toBeNull();
    expect(res.eac).toBeNull();
    expect(res.etc).toBeNull();
    expect(res.vac).toBeNull();
    expect(res.reasons.join(" ")).toContain("CPI and the cost forecast are withheld");
  });
});
