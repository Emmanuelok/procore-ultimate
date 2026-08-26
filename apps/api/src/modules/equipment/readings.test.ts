import { describe, expect, it } from "vitest";
import { detectReadingAnomaly, type AnomalyCheckInput } from "./readings.js";
import {
  checkShortfall,
  classifyDeliveryLine,
  onHandDelta,
  reconcileStock,
  signedQuantity,
} from "./stock.js";

const NOW = "2026-08-25T12:00:00.000Z";

const check = (over: Partial<AnomalyCheckInput> = {}): AnomalyCheckInput => ({
  readingType: "hours",
  value: null,
  readAt: "2026-08-25T08:00:00.000Z",
  previousValue: null,
  previousReadAt: null,
  meterType: "hours",
  fuelLitres: null,
  fuelCapacityLitres: null,
  nowIso: NOW,
  ...over,
});

describe("detectReadingAnomaly — meter regression", () => {
  it("flags a meter that goes backwards", () => {
    const r = detectReadingAnomaly(
      check({
        value: 1180,
        previousValue: 1200,
        previousReadAt: "2026-08-24T08:00:00.000Z",
      }),
    );
    expect(r.isAnomalous).toBe(true);
    expect(r.kinds).toContain("meter_regression");
    expect(r.note).toContain("went backwards");
  });

  it("does NOT flag a meter that is unchanged — a machine that did not run", () => {
    const r = detectReadingAnomaly(
      check({
        value: 1200,
        previousValue: 1200,
        previousReadAt: "2026-08-24T08:00:00.000Z",
      }),
    );
    expect(r.isAnomalous).toBe(false);
    expect(r.delta).toBe(0);
  });
});

describe("detectReadingAnomaly — implausible jump at the boundary", () => {
  it("accepts exactly 24 engine hours in exactly one day", () => {
    const r = detectReadingAnomaly(
      check({
        value: 1224,
        previousValue: 1200,
        previousReadAt: "2026-08-24T08:00:00.000Z",
      }),
    );
    expect(r.isAnomalous).toBe(false);
    expect(r.ratePerDay).toBe(24);
  });

  it("flags 24.5 engine hours in one day", () => {
    const r = detectReadingAnomaly(
      check({
        value: 1224.5,
        previousValue: 1200,
        previousReadAt: "2026-08-24T08:00:00.000Z",
      }),
    );
    expect(r.isAnomalous).toBe(true);
    expect(r.kinds).toContain("implausible_jump");
    expect(r.note).toContain("physical ceiling");
  });

  it("accepts 48 hours across two days", () => {
    const r = detectReadingAnomaly(
      check({
        value: 1248,
        previousValue: 1200,
        previousReadAt: "2026-08-23T08:00:00.000Z",
      }),
    );
    expect(r.isAnomalous).toBe(false);
  });

  it("flags movement between two readings taken at the same instant", () => {
    const r = detectReadingAnomaly(
      check({
        value: 1250,
        previousValue: 1200,
        previousReadAt: "2026-08-25T08:00:00.000Z",
      }),
    );
    expect(r.isAnomalous).toBe(true);
    expect(r.kinds).toContain("implausible_jump");
  });

  it("abstains from the jump check with no previous reading, and says so", () => {
    const r = detectReadingAnomaly(check({ value: 1200 }));
    expect(r.isAnomalous).toBe(false);
    expect(r.reasons.join(" ")).toContain("nor the jump check was run");
  });

  it("uses the odometer ceiling for a kilometres meter", () => {
    const ok = detectReadingAnomaly(
      check({
        readingType: "odometer",
        meterType: "kilometres",
        value: 1600,
        previousValue: 0,
        previousReadAt: "2026-08-24T08:00:00.000Z",
      }),
    );
    const bad = detectReadingAnomaly(
      check({
        readingType: "odometer",
        meterType: "kilometres",
        value: 2400,
        previousValue: 0,
        previousReadAt: "2026-08-24T08:00:00.000Z",
      }),
    );
    expect(ok.isAnomalous).toBe(false);
    expect(bad.isAnomalous).toBe(true);
  });
});

describe("detectReadingAnomaly — fuel over tank capacity", () => {
  it("accepts a fill of exactly a tankful", () => {
    const r = detectReadingAnomaly(
      check({ readingType: "fuel_fill", fuelLitres: 250, fuelCapacityLitres: 250 }),
    );
    expect(r.isAnomalous).toBe(false);
  });

  it("flags 400 litres into a 250-litre tank and names the surplus", () => {
    const r = detectReadingAnomaly(
      check({ readingType: "fuel_fill", fuelLitres: 400, fuelCapacityLitres: 250 }),
    );
    expect(r.isAnomalous).toBe(true);
    expect(r.kinds).toContain("fuel_exceeds_capacity");
    expect(r.note).toContain("150 litres went somewhere");
  });

  it("abstains — and says why — when no tank capacity is recorded", () => {
    const r = detectReadingAnomaly(
      check({ readingType: "fuel_fill", fuelLitres: 400, fuelCapacityLitres: null }),
    );
    expect(r.isAnomalous).toBe(false);
    expect(r.reasons.join(" ")).toContain("no tank capacity is recorded");
  });

  it("flags a future-dated reading", () => {
    const r = detectReadingAnomaly(check({ value: 1200, readAt: "2026-09-01T08:00:00.000Z" }));
    expect(r.kinds).toContain("future_reading");
  });
});

describe("stock signs and shortfall", () => {
  it("signs each movement kind by its name, leaving adjustment to the caller", () => {
    expect(signedQuantity("receipt", 10)).toBe(10);
    expect(signedQuantity("issue", 10)).toBe(-10);
    expect(signedQuantity("theft", 10)).toBe(-10);
    expect(signedQuantity("adjustment", -3)).toBe(-3);
    expect(signedQuantity("adjustment", 3)).toBe(3);
  });

  it("leaves on-hand untouched for reservations", () => {
    expect(onHandDelta("reservation", 10)).toBe(0);
    expect(onHandDelta("reservation_release", 10)).toBe(0);
  });

  it("permits a movement that lands exactly on zero", () => {
    const r = checkShortfall(25, "issue", 25, "bags");
    expect(r.wouldGoNegative).toBe(false);
    expect(r.projectedBalance).toBe(0);
  });

  it("refuses a movement that would go negative and names the shortfall", () => {
    const r = checkShortfall(25, "issue", 40, "bags");
    expect(r.wouldGoNegative).toBe(true);
    expect(r.shortfall).toBe(15);
    expect(r.message).toContain("shortfall of 15 bags");
  });
});

describe("reconcileStock", () => {
  const m = (id: string, type: Parameters<typeof signedQuantity>[0], qty: number, at: string, bal: number | null) => ({
    id,
    movementType: type,
    quantity: signedQuantity(type, qty),
    movedAt: at,
    balanceAfter: bal,
  });

  it("replays the statement and agrees with a correct balance", () => {
    const r = reconcileStock({
      recordedBalance: 60,
      movements: [
        m("a", "receipt", 100, "2026-08-01T09:00:00.000Z", 100),
        m("b", "issue", 30, "2026-08-02T09:00:00.000Z", 70),
        m("c", "wastage", 10, "2026-08-03T09:00:00.000Z", 60),
      ],
    });
    expect(r.computedBalance).toBe(60);
    expect(r.reconciles).toBe(true);
    expect(r.byType["wastage"]).toBe(-10);
  });

  it("reports the drift when the materialized balance disagrees", () => {
    const r = reconcileStock({
      recordedBalance: 75,
      movements: [
        m("a", "receipt", 100, "2026-08-01T09:00:00.000Z", 100),
        m("b", "issue", 30, "2026-08-02T09:00:00.000Z", 70),
      ],
    });
    expect(r.reconciles).toBe(false);
    expect(r.difference).toBe(5);
    expect(r.reasons.join(" ")).toContain("replayed (70) by 5");
  });

  it("replays in movedAt order so a back-dated correction lands in sequence", () => {
    const r = reconcileStock({
      recordedBalance: 70,
      movements: [
        m("b", "issue", 30, "2026-08-02T09:00:00.000Z", 70),
        m("a", "receipt", 100, "2026-08-01T09:00:00.000Z", 100),
      ],
    });
    expect(r.computedBalance).toBe(70);
    expect(r.reconciles).toBe(true);
    expect(r.driftedMovements).toHaveLength(0);
  });

  it("identifies the movement where the drift entered", () => {
    const r = reconcileStock({
      recordedBalance: 70,
      movements: [
        m("a", "receipt", 100, "2026-08-01T09:00:00.000Z", 120),
        m("b", "issue", 30, "2026-08-02T09:00:00.000Z", 70),
      ],
    });
    expect(r.driftedMovements.map((d) => d.id)).toEqual(["a"]);
    expect(r.driftedMovements[0]!.drift).toBe(20);
  });

  it("notices a balance that exists with no movements behind it", () => {
    const r = reconcileStock({ recordedBalance: 40, movements: [] });
    expect(r.reconciles).toBe(false);
    expect(r.reasons.join(" ")).toContain("without being booked in");
  });

  it("does not let a reservation move the on-hand balance", () => {
    const r = reconcileStock({
      recordedBalance: 100,
      movements: [
        m("a", "receipt", 100, "2026-08-01T09:00:00.000Z", 100),
        m("b", "reservation", 40, "2026-08-02T09:00:00.000Z", 100),
      ],
    });
    expect(r.computedBalance).toBe(100);
    expect(r.reconciles).toBe(true);
  });
});

describe("classifyDeliveryLine", () => {
  it("names a short delivery against the expected quantity", () => {
    const r = classifyDeliveryLine({
      quantityExpected: 100,
      quantityReceived: 80,
      quantityAccepted: 80,
      quantityRejected: 0,
    });
    expect(r.kind).toBe("short_delivery");
    expect(r.variance).toBe(-20);
    expect(r.balanced).toBe(true);
  });

  it("names an over delivery", () => {
    const r = classifyDeliveryLine({
      quantityExpected: 100,
      quantityReceived: 110,
      quantityAccepted: 110,
      quantityRejected: 0,
    });
    expect(r.kind).toBe("over_delivery");
    expect(r.variance).toBe(10);
  });

  it("ranks a rejection above a quantity variance", () => {
    const r = classifyDeliveryLine({
      quantityExpected: 100,
      quantityReceived: 80,
      quantityAccepted: 60,
      quantityRejected: 20,
    });
    expect(r.kind).toBe("failed_inspection");
  });

  it("says the delivery is being taken on trust when nothing was expected", () => {
    const r = classifyDeliveryLine({
      quantityExpected: null,
      quantityReceived: 80,
      quantityAccepted: 80,
      quantityRejected: 0,
    });
    expect(r.kind).toBe("none");
    expect(r.variance).toBeNull();
    expect(r.message).toContain("taken on trust");
  });

  it("marks a line that does not add up as unbalanced", () => {
    const r = classifyDeliveryLine({
      quantityExpected: 100,
      quantityReceived: 100,
      quantityAccepted: 60,
      quantityRejected: 10,
    });
    expect(r.balanced).toBe(false);
  });
});
