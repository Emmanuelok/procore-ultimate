import { describe, expect, it } from "vitest";
import {
  assessIdlePlant,
  computeDayCost,
  computeHireCost,
  computeUtilisation,
  idleCostByCurrency,
  type IdleDayInput,
  type UtilisationHours,
} from "./utilisation.js";

const hours = (over: Partial<UtilisationHours> = {}): UtilisationHours => ({
  availableHours: null,
  workingHours: 0,
  idleHours: 0,
  standbyHours: 0,
  downtimeHours: 0,
  travelHours: 0,
  ...over,
});

describe("computeUtilisation", () => {
  it("divides working hours by the recorded available window", () => {
    const r = computeUtilisation(hours({ availableHours: 10, workingHours: 6, idleHours: 4 }));
    expect(r.utilisationPercent).toBe(60);
    expect(r.basis).toBe("available_hours");
    expect(r.accountedHours).toBe(10);
    expect(r.unproductiveHours).toBe(4);
  });

  it("falls back to accounted hours when no window was recorded, and says so", () => {
    const r = computeUtilisation(hours({ workingHours: 3, idleHours: 1 }));
    expect(r.utilisationPercent).toBe(75);
    expect(r.basis).toBe("accounted_hours");
    expect(r.reasons.join(" ")).toContain("availableHours was not recorded");
  });

  it("excludes travel from the numerator but keeps it in the denominator", () => {
    const r = computeUtilisation(hours({ availableHours: 10, workingHours: 5, travelHours: 5 }));
    expect(r.utilisationPercent).toBe(50);
  });

  it("returns null with a reason when nothing at all was recorded — never 0%", () => {
    const r = computeUtilisation(hours());
    expect(r.utilisationPercent).toBeNull();
    expect(r.basis).toBeNull();
    expect(r.reasons.join(" ")).toContain("no hours were recorded");
  });

  it("refuses a row whose buckets exceed the available window", () => {
    const r = computeUtilisation(hours({ availableHours: 8, workingHours: 6, idleHours: 4 }));
    expect(r.utilisationPercent).toBeNull();
    expect(r.reasons.join(" ")).toContain("contradicts itself");
  });

  it("refuses negative hours", () => {
    const r = computeUtilisation(hours({ availableHours: 10, workingHours: -1 }));
    expect(r.utilisationPercent).toBeNull();
    expect(r.reasons.join(" ")).toContain("negative hours");
  });
});

describe("computeHireCost", () => {
  it("charges worked hours at the hire rate and idle at the standing rate", () => {
    const r = computeHireCost({
      hireRateAmount: 40,
      hireRateUnit: "hour",
      idleRateAmount: 25,
      hours: hours({ availableHours: 10, workingHours: 6, idleHours: 4 }),
    });
    expect(r.amount).toBe(6 * 40 + 4 * 25);
  });

  it("charges idle at the full rate when no standing rate is agreed, and says why", () => {
    const r = computeHireCost({
      hireRateAmount: 40,
      hireRateUnit: "hour",
      idleRateAmount: null,
      hours: hours({ availableHours: 10, workingHours: 6, idleHours: 4 }),
    });
    expect(r.amount).toBe(10 * 40);
    expect(r.reasons.join(" ")).toContain("no standing (idle) rate");
  });

  it("excludes downtime from a per-hour hire charge", () => {
    const r = computeHireCost({
      hireRateAmount: 40,
      hireRateUnit: "hour",
      idleRateAmount: 40,
      hours: hours({ availableHours: 10, workingHours: 6, downtimeHours: 4 }),
    });
    expect(r.amount).toBe(6 * 40);
    expect(r.reasons.join(" ")).toContain("comes off hire");
  });

  it("charges a day rate whole however little the machine worked", () => {
    const worked = computeHireCost({
      hireRateAmount: 700,
      hireRateUnit: "day",
      idleRateAmount: null,
      hours: hours({ availableHours: 10, workingHours: 9 }),
    });
    const stood = computeHireCost({
      hireRateAmount: 700,
      hireRateUnit: "day",
      idleRateAmount: null,
      hours: hours({ availableHours: 10, idleHours: 10 }),
    });
    expect(worked.amount).toBe(700);
    expect(stood.amount).toBe(700);
  });

  it("apportions a weekly rate over 7 calendar days and names the divisor", () => {
    const r = computeHireCost({
      hireRateAmount: 1400,
      hireRateUnit: "week",
      idleRateAmount: null,
      hours: hours({ availableHours: 10, workingHours: 8 }),
    });
    expect(r.amount).toBe(200);
    expect(r.basis).toContain("7 calendar days");
  });

  it("refuses to apportion a lump sum to one day", () => {
    const r = computeHireCost({
      hireRateAmount: 5000,
      hireRateUnit: "lump_sum",
      idleRateAmount: null,
      hours: hours({ availableHours: 10, workingHours: 8 }),
    });
    expect(r.amount).toBeNull();
    expect(r.reasons.join(" ")).toContain("no defensible share");
  });

  it("returns null with a reason when the machine carries no hire rate at all", () => {
    const r = computeHireCost({
      hireRateAmount: null,
      hireRateUnit: null,
      idleRateAmount: null,
      hours: hours({ availableHours: 10, idleHours: 10 }),
    });
    expect(r.amount).toBeNull();
    expect(r.reasons.join(" ")).toContain("no hire rate is recorded");
  });
});

describe("computeDayCost", () => {
  it("marks the total incomplete when a component could not be computed", () => {
    const r = computeDayCost({
      hireRateAmount: 40,
      hireRateUnit: "hour",
      idleRateAmount: 40,
      operatorRateAmount: null,
      fuelCost: null,
      fuelLitres: 120,
      currency: "GBP",
      hours: hours({ availableHours: 10, workingHours: 10 }),
    });
    expect(r.hireCost).toBe(400);
    expect(r.operatorCost).toBeNull();
    expect(r.fuelCost).toBeNull();
    expect(r.totalCost).toBe(400);
    expect(r.totalIsComplete).toBe(false);
    expect(r.reasons.join(" ")).toContain("floor on the day's cost");
  });

  it("adds hire, fuel and operator when all three are known", () => {
    const r = computeDayCost({
      hireRateAmount: 40,
      hireRateUnit: "hour",
      idleRateAmount: 40,
      operatorRateAmount: 30,
      fuelCost: 150,
      fuelLitres: 100,
      currency: "GBP",
      hours: hours({ availableHours: 10, workingHours: 10 }),
    });
    expect(r.totalCost).toBe(400 + 150 + 300);
    expect(r.totalIsComplete).toBe(true);
    expect(r.currency).toBe("GBP");
  });
});

describe("assessIdlePlant", () => {
  const day = (date: string, working: number, available = 10): IdleDayInput => ({
    date,
    hours: hours({ availableHours: available, workingHours: working, idleHours: available - working }),
    idleReason: "awaiting_materials",
  });

  const base = {
    equipmentId: "eqp_1",
    reference: "EQP-0001",
    name: "30t excavator",
    ownership: "hired",
    status: "idle",
    currency: "GBP",
    hireRateAmount: 700,
    hireRateUnit: "day" as const,
    idleRateAmount: null,
    operatorRateAmount: null,
    offHireRequestedAt: null,
    offHiredAt: null,
    hireEndDate: null,
    windowStart: "2026-08-01",
    windowEnd: "2026-08-07",
  };

  it("flags a sustained trailing run and states the accumulated standing cost", () => {
    const r = assessIdlePlant({
      ...base,
      days: [
        day("2026-08-01", 9),
        day("2026-08-02", 8),
        day("2026-08-03", 1),
        day("2026-08-04", 0),
        day("2026-08-05", 1),
        day("2026-08-06", 0),
        day("2026-08-07", 1),
      ],
    });
    expect(r.isIdleOnHire).toBe(true);
    expect(r.consecutiveLowDays).toBe(5);
    // 5 trailing days at the whole day rate
    expect(r.idleCost).toBe(5 * 700);
    expect(r.idleReasons).toEqual(["awaiting_materials"]);
  });

  it("does not flag a run broken by a working day", () => {
    const r = assessIdlePlant({
      ...base,
      days: [
        day("2026-08-01", 0),
        day("2026-08-02", 0),
        day("2026-08-03", 0),
        day("2026-08-04", 0),
        day("2026-08-05", 9),
        day("2026-08-06", 0),
        day("2026-08-07", 0),
      ],
    });
    expect(r.consecutiveLowDays).toBe(2);
    expect(r.lowDays).toBe(6);
    expect(r.isIdleOnHire).toBe(false);
  });

  it("excludes owned plant, because there is no hire to stop", () => {
    const r = assessIdlePlant({
      ...base,
      ownership: "owned",
      days: ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"].map((d) =>
        day(d, 0),
      ),
    });
    expect(r.isIdleOnHire).toBe(false);
    expect(r.reasons.join(" ")).toContain("no hire to stop");
  });

  it("excludes plant that has already been collected", () => {
    const r = assessIdlePlant({
      ...base,
      offHiredAt: "2026-08-06T09:00:00.000Z",
      days: ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"].map((d) =>
        day(d, 0),
      ),
    });
    expect(r.isIdleOnHire).toBe(false);
    expect(r.reasons.join(" ")).toContain("the charge has stopped");
  });

  it("flags the machine but reports a null cost when no usable rate exists", () => {
    const r = assessIdlePlant({
      ...base,
      hireRateAmount: null,
      hireRateUnit: null,
      days: ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"].map((d) =>
        day(d, 0),
      ),
    });
    expect(r.isIdleOnHire).toBe(true);
    expect(r.idleCost).toBeNull();
    expect(r.reasons.join(" ")).toContain("no hire rate is recorded");
  });

  it("notes an off-hire that was requested but never collected", () => {
    const r = assessIdlePlant({
      ...base,
      offHireRequestedAt: "2026-08-02T09:00:00.000Z",
      days: ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"].map((d) =>
        day(d, 0),
      ),
    });
    expect(r.isIdleOnHire).toBe(true);
    expect(r.reasons.join(" ")).toContain("has not been collected");
  });

  it("buckets idle cost by currency and never adds across them", () => {
    const gbp = assessIdlePlant({
      ...base,
      days: ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"].map((d) =>
        day(d, 0),
      ),
    });
    const usd = assessIdlePlant({
      ...base,
      equipmentId: "eqp_2",
      reference: "EQP-0002",
      currency: "USD",
      hireRateAmount: 500,
      days: ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"].map((d) =>
        day(d, 0),
      ),
    });
    expect(idleCostByCurrency([gbp, usd])).toEqual({ GBP: 3500, USD: 2500 });
  });
});
