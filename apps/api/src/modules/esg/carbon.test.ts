import { describe, expect, it } from "vitest";
import { addDaysISO, todayISO } from "../field/dates.js";
import {
  DEFAULT_CARBON_FACTORS,
  budgetDrawdown,
  commitmentStatus,
  computeTco2e,
  csvEscape,
  factorFromEntry,
  normaliseUnit,
  percent,
  unitsMatch,
  wasteDiversion,
} from "./carbon.js";

describe("units", () => {
  it("collapses spelling and case variants", () => {
    expect(normaliseUnit(" KG ")).toBe("kg");
    expect(normaliseUnit("m³")).toBe("m3");
    expect(normaliseUnit("M^3")).toBe("m3");
    expect(normaliseUnit("Litres")).toBe("litre");
    expect(normaliseUnit("nr")).toBe("item");
    expect(unitsMatch("m3", "cum")).toBe(true);
    expect(unitsMatch("t", "tonnes")).toBe(true);
  });

  it("keeps a genuine mismatch a mismatch", () => {
    expect(unitsMatch("kg", "m3")).toBe(false);
    expect(unitsMatch("m2", "m3")).toBe(false);
    // unknown units are compared verbatim, not silently accepted
    expect(unitsMatch("widget", "gadget")).toBe(false);
    expect(unitsMatch("widget", "WIDGET")).toBe(true);
  });
});

describe("computeTco2e", () => {
  it("divides kg by 1000 exactly", () => {
    // 10,000 kg of C30/37 at 0.103 kgCO2e/kg = 1030 kgCO2e = 1.03 tCO2e
    expect(computeTco2e(10_000, 0.103)).toBe(1.03);
    expect(computeTco2e(1, 1000)).toBe(1);
    expect(computeTco2e(2500, 1.99)).toBe(4.975);
  });

  it("round-trips the factor back out of a stored entry", () => {
    const tco2e = computeTco2e(10_000, 0.103);
    expect(factorFromEntry(10_000, tco2e)).toBe(0.103);
    expect(factorFromEntry(0, 5)).toBe(0);
  });
});

describe("budgetDrawdown", () => {
  it("bands on_track / at_risk / exceeded at 80 and 100 percent", () => {
    expect(budgetDrawdown(79, 100).status).toBe("on_track");
    expect(budgetDrawdown(79.9, 100).status).toBe("on_track");
    expect(budgetDrawdown(80, 100).status).toBe("at_risk");
    expect(budgetDrawdown(100, 100).status).toBe("at_risk");
    expect(budgetDrawdown(100.5, 100).status).toBe("exceeded");
  });

  it("reports remaining as target minus actual, negative when overrun", () => {
    expect(budgetDrawdown(30, 100)).toEqual({
      drawdownPercent: 30,
      remaining: 70,
      status: "on_track",
    });
    expect(budgetDrawdown(120, 100).remaining).toBe(-20);
  });

  it("treats a zero target as exceeded by any emission at all", () => {
    expect(budgetDrawdown(0, 0).status).toBe("on_track");
    expect(budgetDrawdown(0.001, 0).status).toBe("exceeded");
  });
});

describe("wasteDiversion", () => {
  it("computes diversion and the narrow recycled share", () => {
    // 100 t moved: 20 t landfilled, 50 t recycled
    expect(wasteDiversion(100, 20, 50)).toEqual({
      diversionFromLandfillPercent: 80,
      recycledPercent: 50,
    });
  });

  it("is zero, not NaN, when nothing has moved", () => {
    expect(wasteDiversion(0, 0, 0)).toEqual({
      diversionFromLandfillPercent: 0,
      recycledPercent: 0,
    });
  });
});

describe("commitmentStatus", () => {
  const today = todayISO();

  it("is delivered once the target is met, whatever the date", () => {
    expect(commitmentStatus(100, 100, addDaysISO(today, -400), today)).toBe("delivered");
    expect(commitmentStatus(120, 100, null, today)).toBe("delivered");
  });

  it("stays committed with nothing delivered and no date pressure", () => {
    expect(commitmentStatus(0, 100, null, today)).toBe("committed");
    expect(commitmentStatus(0, 100, addDaysISO(today, 60), today)).toBe("committed");
  });

  it("is on_track once something has been delivered before the due date", () => {
    expect(commitmentStatus(10, 100, addDaysISO(today, 60), today)).toBe("on_track");
  });

  it("is at_risk past the due date under 70 percent", () => {
    expect(commitmentStatus(10, 100, addDaysISO(today, -1), today)).toBe("at_risk");
    // 70% or better past the due date is not yet at risk
    expect(commitmentStatus(70, 100, addDaysISO(today, -1), today)).toBe("on_track");
  });

  it("is shortfall past the due date plus 30 days while under target", () => {
    expect(commitmentStatus(99, 100, addDaysISO(today, -31), today)).toBe("shortfall");
    // exactly 30 days past is still within grace
    expect(commitmentStatus(10, 100, addDaysISO(today, -30), today)).toBe("at_risk");
  });
});

describe("percent + csvEscape", () => {
  it("guards division by zero", () => {
    expect(percent(5, 0)).toBe(0);
    expect(percent(1, 3)).toBe(33.33);
  });

  it("quotes commas, quotes and newlines", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape(null)).toBe("");
  });
});

describe("default factor library", () => {
  it("is 15 uniquely-named, positively-valued generic factors", () => {
    expect(DEFAULT_CARBON_FACTORS).toHaveLength(15);
    expect(new Set(DEFAULT_CARBON_FACTORS.map((f) => f.name)).size).toBe(15);
    for (const f of DEFAULT_CARBON_FACTORS) {
      expect(f.factorKgCo2ePerUnit).toBeGreaterThan(0);
      expect(f.unit.length).toBeGreaterThan(0);
      expect(f.materialCategory.length).toBeGreaterThan(0);
    }
  });
});
