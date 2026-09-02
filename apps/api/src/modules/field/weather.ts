/**
 * Weather provider adapter for daily-log auto-capture (spec #373).
 *
 * Open-Meteo's archive API is the reference provider: no key, historical
 * daily aggregates by lat/lng. The adapter is a graceful no-op — any network
 * failure, timeout, malformed body or missing coordinate yields `null` and
 * the daily log simply keeps whatever the site diarist typed. Weather is
 * never fabricated: a null observation renders "not captured" with the reason.
 *
 * The fetch function is injected so the parser and the fallback paths are
 * unit-testable without the network.
 */

export interface WeatherObservation {
  tempC: number;
  tempMinC?: number;
  tempMaxC?: number;
  conditions: string;
  windKph: number;
  precipitationMm: number;
  weatherCode?: number;
}

export interface WeatherCapture {
  provider: string;
  fetchedAt: string;
  observation: WeatherObservation;
}

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** WMO weather interpretation codes → a short human condition string. */
export function weatherCodeToConditions(code: number | null | undefined): string {
  if (code === null || code === undefined || !Number.isFinite(code)) return "Unknown";
  if (code === 0) return "Clear";
  if (code === 1) return "Mainly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Rain showers";
  if (code === 85 || code === 86) return "Snow showers";
  if (code === 95) return "Thunderstorm";
  if (code === 96 || code === 99) return "Thunderstorm with hail";
  return `WMO ${code}`;
}

export function openMeteoArchiveUrl(latitude: number, longitude: number, date: string): string {
  const params = new URLSearchParams({
    latitude: latitude.toFixed(4),
    longitude: longitude.toFixed(4),
    start_date: date,
    end_date: date,
    daily: "temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,wind_speed_10m_max,weather_code",
    timezone: "UTC",
  });
  return `https://archive-api.open-meteo.com/v1/archive?${params.toString()}`;
}

function firstNumber(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  const v = value[0];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Parse an Open-Meteo daily response; null when it does not carry the day. */
export function parseOpenMeteoDaily(body: unknown, date: string): WeatherObservation | null {
  if (!body || typeof body !== "object") return null;
  const daily = (body as { daily?: unknown }).daily;
  if (!daily || typeof daily !== "object") return null;
  const d = daily as Record<string, unknown>;
  const time = Array.isArray(d["time"]) ? (d["time"] as unknown[]) : [];
  if (time[0] !== date) return null;
  const mean = firstNumber(d["temperature_2m_mean"]);
  const max = firstNumber(d["temperature_2m_max"]);
  const min = firstNumber(d["temperature_2m_min"]);
  const temp = mean ?? (max !== null && min !== null ? (max + min) / 2 : (max ?? min));
  if (temp === null) return null;
  const code = firstNumber(d["weather_code"]);
  return {
    tempC: Math.round(temp * 10) / 10,
    ...(min !== null ? { tempMinC: min } : {}),
    ...(max !== null ? { tempMaxC: max } : {}),
    conditions: weatherCodeToConditions(code),
    windKph: Math.round((firstNumber(d["wind_speed_10m_max"]) ?? 0) * 10) / 10,
    precipitationMm: Math.round((firstNumber(d["precipitation_sum"]) ?? 0) * 10) / 10,
    ...(code !== null ? { weatherCode: code } : {}),
  };
}

export interface WeatherRequest {
  latitude: number | null | undefined;
  longitude: number | null | undefined;
  date: string;
}

/**
 * Fetch the historical observation for a site and date. Never throws: every
 * failure path resolves to null so a daily-log save cannot be blocked by the
 * weather service. `enabled=false` (tests, air-gapped deployments) short-circuits.
 */
export async function fetchHistoricalWeather(
  req: WeatherRequest,
  options: { fetchImpl?: FetchLike; timeoutMs?: number; enabled?: boolean; now?: () => string } = {},
): Promise<WeatherCapture | null> {
  if (options.enabled === false) return null;
  const { latitude, longitude, date } = req;
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    return null;
  }
  const fetchImpl: FetchLike | undefined =
    options.fetchImpl ?? (typeof globalThis.fetch === "function" ? (globalThis.fetch as unknown as FetchLike) : undefined);
  if (!fetchImpl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 4000);
  try {
    const res = await fetchImpl(openMeteoArchiveUrl(latitude, longitude, date), {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const observation = parseOpenMeteoDaily(body, date);
    if (!observation) return null;
    return { provider: "open-meteo", fetchedAt: (options.now ?? (() => new Date().toISOString()))(), observation };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
