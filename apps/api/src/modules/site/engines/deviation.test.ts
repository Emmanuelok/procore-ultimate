import { describe, expect, it } from "vitest";
import { buildDeviationReport, classifyDeviation } from "./deviation.js";

const items = [
  { elementId: "e1", zone: "L1", deviationMm: 2 },
  { elementId: "e2", zone: "L1", deviationMm: -9 },
  { elementId: "e3", zone: "L2", deviationMm: 25 },
  { elementId: "e4", zone: "L2", deviationMm: -1 },
];

describe("classifyDeviation", () => {
  it("uses the marginal band between factor×tolerance and tolerance", () => {
    expect(classifyDeviation(7, 10, 0.8)).toBe("within_tolerance");
    expect(classifyDeviation(-8, 10, 0.8)).toBe("within_tolerance");
    expect(classifyDeviation(9, 10, 0.8)).toBe("marginal");
    expect(classifyDeviation(-10, 10, 0.8)).toBe("marginal");
    expect(classifyDeviation(10.1, 10, 0.8)).toBe("out_of_tolerance");
  });
});

describe("buildDeviationReport", () => {
  it("computes statistics and takes the worst element as the verdict", () => {
    const r = buildDeviationReport(items, { toleranceMm: 10, registrationStatus: "registered" });
    expect(r.elementCount).toBe(4);
    expect(r.outOfToleranceCount).toBe(1);
    expect(r.marginalCount).toBe(1);
    expect(r.withinToleranceCount).toBe(2);
    expect(r.maxDeviationMm).toBe(25);
    expect(r.meanAbsDeviationMm).toBe(9.3);
    expect(r.rmsDeviationMm).toBe(13.3);
    expect(r.verdict).toBe("out_of_tolerance");
    expect(r.reasons[0]).toContain("exceed the 10 mm tolerance");
  });

  it("rolls up per zone, worst first", () => {
    const r = buildDeviationReport(items, { toleranceMm: 10, registrationStatus: "registered" });
    expect(r.byZone.map((z) => z.zone)).toEqual(["L2", "L1"]);
    expect(r.byZone[0]?.outOfTolerance).toBe(1);
    expect(r.byZone[0]?.verdict).toBe("out_of_tolerance");
    expect(r.byZone[1]?.verdict).toBe("marginal");
  });

  it("refuses to assess an unregistered scan", () => {
    const r = buildDeviationReport(items, { toleranceMm: 10, registrationStatus: "unregistered" });
    expect(r.verdict).toBe("not_assessable");
    expect(r.maxDeviationMm).toBeNull();
    expect(r.outOfToleranceCount).toBe(0);
    expect(r.reasons.some((x) => x.includes("not registered"))).toBe(true);
  });

  it("refuses when the registration error swamps the tolerance", () => {
    const r = buildDeviationReport(items, {
      toleranceMm: 10,
      registrationStatus: "registered",
      registrationErrorMm: 12,
    });
    expect(r.verdict).toBe("not_assessable");
    expect(r.reasons.some((x) => x.includes("registration error"))).toBe(true);
  });

  it("refuses with no tolerance or no elements", () => {
    expect(buildDeviationReport(items, { toleranceMm: 0 }).verdict).toBe("not_assessable");
    expect(buildDeviationReport([], { toleranceMm: 10, registrationStatus: "registered" }).verdict).toBe("not_assessable");
  });

  it("drops non-finite deviations and says how many", () => {
    const r = buildDeviationReport(
      [...items, { elementId: "bad", deviationMm: Number.NaN }],
      { toleranceMm: 10, registrationStatus: "registered" },
    );
    expect(r.elementCount).toBe(4);
    expect(r.reasons.some((x) => x.includes("no finite deviation"))).toBe(true);
  });

  it("reports within_tolerance only when every element is inside the inner band", () => {
    const r = buildDeviationReport(
      [
        { elementId: "a", deviationMm: 1 },
        { elementId: "b", deviationMm: -3 },
      ],
      { toleranceMm: 10, registrationStatus: "registered" },
    );
    expect(r.verdict).toBe("within_tolerance");
    expect(r.reasons).toEqual([]);
  });

  it("clamps a nonsense marginal factor back to the default", () => {
    const r = buildDeviationReport([{ elementId: "a", deviationMm: 9 }], {
      toleranceMm: 10,
      marginalFactor: 7,
      registrationStatus: "registered",
    });
    expect(r.marginalFactor).toBe(0.8);
    expect(r.verdict).toBe("marginal");
  });
});
