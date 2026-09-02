import { describe, expect, it } from "vitest";
import { analyseWeather, classifyDay, daysInclusive, type Threshold, type WeatherReading } from "./weather.js";

const thresholds: Threshold[] = [
  { metric: "precipitation_mm", comparator: "gte", value: 10, label: "Rainfall" },
  { metric: "wind_gust_kph", comparator: "gte", value: 60, label: "Gust" },
  { metric: "temp_min_c", comparator: "lte", value: -2, label: "Frost" },
];

function reading(partial: Partial<WeatherReading> & { observedOn: string }): WeatherReading {
  return {
    precipitationMm: null,
    snowfallMm: null,
    tempMinC: null,
    tempMaxC: null,
    windMeanKph: null,
    windGustKph: null,
    humidityPct: null,
    visibilityM: null,
    seaStateM: null,
    workStopped: 0,
    hoursLost: null,
    ...partial,
  };
}

describe("classifyDay", () => {
  it("quotes the breached threshold with the observed value", () => {
    const v = classifyDay(reading({ observedOn: "2026-01-05", precipitationMm: 14.2, windGustKph: 20, tempMinC: 4 }), thresholds);
    expect(v.adverse).toBe(true);
    expect(v.reasons[0]).toContain("14.2mm");
    expect(v.reasons[0]).toContain("10mm");
    expect(v.undetermined).toBe(false);
  });

  it("evaluates lte comparators for frost", () => {
    expect(classifyDay(reading({ observedOn: "2026-01-06", tempMinC: -2 }), thresholds).adverse).toBe(true);
    expect(classifyDay(reading({ observedOn: "2026-01-06", tempMinC: -1.9 }), thresholds).adverse).toBe(false);
  });

  it("marks a day with no usable readings undetermined, never fair", () => {
    const v = classifyDay(reading({ observedOn: "2026-01-07" }), thresholds);
    expect(v.undetermined).toBe(true);
    expect(v.adverse).toBe(false);
    expect(v.undeterminedMetrics).toEqual(["precipitation_mm", "wind_gust_kph", "temp_min_c"]);
  });

  it("does not count a stoppage the readings do not support, and says so", () => {
    const v = classifyDay(reading({ observedOn: "2026-01-08", precipitationMm: 1, workStopped: 1 }), thresholds);
    expect(v.adverse).toBe(false);
    expect(v.reasons[0]).toContain("no contract threshold was breached");
  });

  it("names an unknown metric as undetermined rather than failing", () => {
    const v = classifyDay(reading({ observedOn: "2026-01-09", precipitationMm: 1 }), [
      { metric: "cosmic_rays", comparator: "gte", value: 1 },
    ]);
    expect(v.undetermined).toBe(true);
    expect(v.undeterminedMetrics).toEqual(["cosmic_rays"]);
  });
});

describe("analyseWeather", () => {
  const january = (dates: Array<[string, number]>): WeatherReading[] =>
    dates.map(([d, mm]) => reading({ observedOn: d, precipitationMm: mm, windGustKph: 10, tempMinC: 5 }));

  it("counts adverse days and subtracts the baseline per month", () => {
    const readings = january([
      ["2026-01-01", 20],
      ["2026-01-02", 30],
      ["2026-01-03", 40],
      ["2026-01-04", 1],
      ["2026-01-05", 2],
    ]);
    const r = analyseWeather(readings, thresholds, {
      periodStart: "2026-01-01",
      periodEnd: "2026-01-05",
      monthlyExpectedAdverseDays: { "1": 6.2 },
    });
    expect(r.observedAdverseDays).toBe(3);
    // 6.2 * 5/31 = 1.0
    expect(r.baselineAdverseDays).toBe(1);
    expect(r.exceptionalDays).toBe(2);
    expect(r.byMonth).toHaveLength(1);
    expect(r.byMonth[0]?.reasons.some((x) => x.includes("pro-rated"))).toBe(true);
  });

  it("never nets a mild month against a wet one", () => {
    const readings = [
      ...january([["2026-01-15", 30]]),
      reading({ observedOn: "2026-02-10", precipitationMm: 30, windGustKph: 5, tempMinC: 5 }),
      reading({ observedOn: "2026-02-11", precipitationMm: 30, windGustKph: 5, tempMinC: 5 }),
      reading({ observedOn: "2026-02-12", precipitationMm: 30, windGustKph: 5, tempMinC: 5 }),
    ];
    const r = analyseWeather(readings, thresholds, {
      periodStart: "2026-01-01",
      periodEnd: "2026-02-28",
      monthlyExpectedAdverseDays: { "1": 10, "2": 1 },
    });
    // January: 1 observed vs 10 expected → 0 exceptional (not -9)
    expect(r.byMonth[0]?.exceptional).toBe(0);
    expect(r.byMonth[1]?.exceptional).toBe(2);
    expect(r.exceptionalDays).toBe(2);
  });

  it("reports coverage and never counts a missing day as fair weather", () => {
    const r = analyseWeather(january([["2026-01-01", 20]]), thresholds, {
      periodStart: "2026-01-01",
      periodEnd: "2026-01-10",
      monthlyExpectedAdverseDays: { "1": 3 },
    });
    expect(r.daysInPeriod).toBe(10);
    expect(r.daysObserved).toBe(1);
    expect(r.coveragePercent).toBe(10);
    expect(r.gapDates).toHaveLength(9);
    expect(r.reasons.some((x) => x.includes("NOT counted as fair weather"))).toBe(true);
  });

  it("declines to compute exceptional days without a baseline expectation", () => {
    const r = analyseWeather(january([["2026-01-01", 20]]), thresholds, {
      periodStart: "2026-01-01",
      periodEnd: "2026-01-02",
    });
    expect(r.observedAdverseDays).toBe(1);
    expect(r.baselineAdverseDays).toBeNull();
    expect(r.exceptionalDays).toBeNull();
    expect(r.reasons.some((x) => x.includes("cannot be derived"))).toBe(true);
  });

  it("refuses to test anything when the baseline has no thresholds", () => {
    const r = analyseWeather(january([["2026-01-01", 90]]), [], {
      periodStart: "2026-01-01",
      periodEnd: "2026-01-01",
      monthlyExpectedAdverseDays: { "1": 1 },
    });
    expect(r.observedAdverseDays).toBe(0);
    expect(r.daysObserved).toBe(0);
    expect(r.reasons.some((x) => x.includes("no thresholds"))).toBe(true);
  });

  it("merges two sources for the same date and keeps the adverse verdict", () => {
    const r = analyseWeather(
      [
        reading({ observedOn: "2026-01-01", precipitationMm: 2, windGustKph: 5, tempMinC: 5 }),
        reading({ observedOn: "2026-01-01", precipitationMm: 22, windGustKph: 5, tempMinC: 5, hoursLost: 4, workStopped: 1 }),
      ],
      thresholds,
      { periodStart: "2026-01-01", periodEnd: "2026-01-01", monthlyExpectedAdverseDays: { "1": 0 } },
    );
    expect(r.daysObserved).toBe(1);
    expect(r.observedAdverseDays).toBe(1);
    expect(r.hoursLost).toBe(4);
    expect(r.adverseDayDetail[0]?.workStopped).toBe(true);
  });

  it("ignores readings outside the window", () => {
    const r = analyseWeather(january([["2025-12-31", 50], ["2026-01-01", 50]]), thresholds, {
      periodStart: "2026-01-01",
      periodEnd: "2026-01-01",
      monthlyExpectedAdverseDays: { "1": 0 },
    });
    expect(r.observedAdverseDays).toBe(1);
    expect(r.daysObserved).toBe(1);
  });

  it("reports lost hours as unavailable rather than zero", () => {
    const r = analyseWeather(january([["2026-01-01", 50]]), thresholds, {
      periodStart: "2026-01-01",
      periodEnd: "2026-01-01",
      monthlyExpectedAdverseDays: { "1": 0 },
    });
    expect(r.hoursLost).toBeNull();
    expect(r.reasons.some((x) => x.includes("lost time is not available"))).toBe(true);
  });
});

describe("daysInclusive", () => {
  it("counts both ends and refuses a reversed range", () => {
    expect(daysInclusive("2026-01-01", "2026-01-01")).toBe(1);
    expect(daysInclusive("2026-01-01", "2026-01-31")).toBe(31);
    expect(daysInclusive("2026-01-31", "2026-01-01")).toBe(0);
  });
});
