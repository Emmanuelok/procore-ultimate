import { describe, expect, it } from "vitest";
import { fetchArchive, openMeteoArchiveUrl, parseOpenMeteoArchive, weatherCodeToConditions } from "./provider.js";

const body = {
  daily: {
    time: ["2026-01-01", "2026-01-02"],
    temperature_2m_min: [-3, 2],
    temperature_2m_max: [4, 9],
    temperature_2m_mean: [null, 5.5],
    precipitation_sum: [12.5, 0],
    snowfall_sum: [1.2, 0],
    wind_speed_10m_max: [30, 12],
    wind_gusts_10m_max: [72, 20],
    weather_code: [71, 1],
  },
};

describe("openMeteoArchiveUrl", () => {
  it("asks for the metrics the thresholds are written against", () => {
    const url = openMeteoArchiveUrl(51.5, -0.12, "2026-01-01", "2026-01-31");
    expect(url).toContain("latitude=51.5000");
    expect(url).toContain("wind_gusts_10m_max");
    expect(url).toContain("snowfall_sum");
    expect(url).toContain("start_date=2026-01-01");
    expect(url).toContain("end_date=2026-01-31");
  });
});

describe("parseOpenMeteoArchive", () => {
  it("maps one reading per date and converts snowfall from cm to mm", () => {
    const { readings, reasons } = parseOpenMeteoArchive(body);
    expect(reasons).toEqual([]);
    expect(readings).toHaveLength(2);
    expect(readings[0]?.observedOn).toBe("2026-01-01");
    expect(readings[0]?.snowfallMm).toBe(12);
    expect(readings[0]?.windGustKph).toBe(72);
    expect(readings[0]?.conditions).toBe("Snow");
    // mean derived from min/max when the provider omits it
    expect(readings[0]?.tempMeanC).toBe(0.5);
    expect(readings[1]?.tempMeanC).toBe(5.5);
  });

  it("drops a row with no metrics rather than storing zeroes", () => {
    const { readings, reasons } = parseOpenMeteoArchive({
      daily: {
        time: ["2026-01-01"],
        temperature_2m_min: [null],
        temperature_2m_max: [null],
        precipitation_sum: [null],
        wind_speed_10m_max: [null],
        wind_gusts_10m_max: [null],
      },
    });
    expect(readings).toEqual([]);
    expect(reasons[0]).toContain("dropped rather than stored as zeroes");
  });

  it("explains a body it cannot use", () => {
    expect(parseOpenMeteoArchive(null).reasons[0]).toContain("not an object");
    expect(parseOpenMeteoArchive({}).reasons[0]).toContain("no `daily` block");
    expect(parseOpenMeteoArchive({ daily: { time: [] } }).reasons[0]).toContain("no dates");
  });
});

describe("weatherCodeToConditions", () => {
  it("maps the WMO bands", () => {
    expect(weatherCodeToConditions(0)).toBe("Clear");
    expect(weatherCodeToConditions(63)).toBe("Rain");
    expect(weatherCodeToConditions(null)).toBe("Unknown");
    expect(weatherCodeToConditions(120)).toBe("WMO 120");
  });
});

describe("fetchArchive", () => {
  const window = { from: "2026-01-01", to: "2026-01-02" };

  it("is a no-op when disabled", async () => {
    const r = await fetchArchive({ latitude: 51, longitude: 0, ...window }, { enabled: false });
    expect(r.readings).toEqual([]);
    expect(r.reasons[0]).toContain("disabled");
  });

  it("explains a project with no coordinates", async () => {
    const r = await fetchArchive({ latitude: null, longitude: null, ...window }, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }) });
    expect(r.readings).toEqual([]);
    expect(r.reasons[0]).toContain("no latitude/longitude");
  });

  it("returns readings on a good response", async () => {
    const r = await fetchArchive(
      { latitude: 51, longitude: 0, ...window },
      { fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }), now: () => "2026-02-01T00:00:00.000Z" },
    );
    expect(r.readings).toHaveLength(2);
    expect(r.fetchedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("never throws on a bad status or a rejecting fetch", async () => {
    const bad = await fetchArchive({ latitude: 51, longitude: 0, ...window }, { fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
    expect(bad.reasons[0]).toContain("HTTP 503");

    const boom = await fetchArchive({ latitude: 51, longitude: 0, ...window }, {
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(boom.readings).toEqual([]);
    expect(boom.reasons[0]).toContain("network down");
  });
});
