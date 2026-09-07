/**
 * Weather provider adapter for the site archive (spec Vol II Z #1074).
 *
 * The archive is a claim record, so what goes in it must be traceable: the
 * provider name, the URL shape and the raw body are all kept. Open-Meteo's
 * historical archive is the reference provider — no key, daily aggregates by
 * latitude/longitude — and the adapter pulls the metrics the contract
 * thresholds are actually written against, gusts and snowfall included.
 *
 * It is a graceful no-op by construction: no coordinates, no fetch
 * implementation, a non-200, a timeout or a malformed body all resolve to
 * `null` with a reason. Weather is never fabricated, and a capture failure
 * never blocks anything else on the platform.
 */

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface ProviderReading {
  observedOn: string;
  tempMinC: number | null;
  tempMaxC: number | null;
  tempMeanC: number | null;
  precipitationMm: number | null;
  snowfallMm: number | null;
  windMeanKph: number | null;
  windGustKph: number | null;
  conditions: string;
  raw: Record<string, unknown>;
}

export interface ProviderResult {
  provider: string;
  fetchedAt: string;
  readings: ProviderReading[];
  /** why nothing (or less than asked) came back — never silently empty */
  reasons: string[];
}

const DAILY_FIELDS = [
  "temperature_2m_max",
  "temperature_2m_min",
  "temperature_2m_mean",
  "precipitation_sum",
  "snowfall_sum",
  "wind_speed_10m_max",
  "wind_gusts_10m_max",
  "weather_code",
].join(",");

export function openMeteoArchiveUrl(
  latitude: number,
  longitude: number,
  from: string,
  to: string,
): string {
  const params = new URLSearchParams({
    latitude: latitude.toFixed(4),
    longitude: longitude.toFixed(4),
    start_date: from,
    end_date: to,
    daily: DAILY_FIELDS,
    timezone: "UTC",
  });
  return `https://archive-api.open-meteo.com/v1/archive?${params.toString()}`;
}

/** WMO weather interpretation codes → a short human condition string. */
export function weatherCodeToConditions(code: number | null): string {
  if (code === null || !Number.isFinite(code)) return "Unknown";
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

function numAt(value: unknown, index: number): number | null {
  if (!Array.isArray(value)) return null;
  const v = value[index];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Parse an Open-Meteo daily archive body into one reading per date. */
export function parseOpenMeteoArchive(body: unknown): { readings: ProviderReading[]; reasons: string[] } {
  if (!body || typeof body !== "object") {
    return { readings: [], reasons: ["The provider returned a body that is not an object."] };
  }
  const daily = (body as { daily?: unknown }).daily;
  if (!daily || typeof daily !== "object") {
    return { readings: [], reasons: ["The provider response carried no `daily` block."] };
  }
  const d = daily as Record<string, unknown>;
  const time = Array.isArray(d["time"]) ? (d["time"] as unknown[]) : [];
  if (time.length === 0) {
    return { readings: [], reasons: ["The provider response carried no dates."] };
  }
  const readings: ProviderReading[] = [];
  const reasons: string[] = [];
  for (let i = 0; i < time.length; i += 1) {
    const date = time[i];
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      reasons.push(`Row ${i} carried no usable date and was dropped.`);
      continue;
    }
    const min = numAt(d["temperature_2m_min"], i);
    const max = numAt(d["temperature_2m_max"], i);
    const mean = numAt(d["temperature_2m_mean"], i) ?? (min !== null && max !== null ? (min + max) / 2 : null);
    const code = numAt(d["weather_code"], i);
    const reading: ProviderReading = {
      observedOn: date,
      tempMinC: min,
      tempMaxC: max,
      tempMeanC: mean === null ? null : Math.round(mean * 10) / 10,
      precipitationMm: numAt(d["precipitation_sum"], i),
      // Open-Meteo reports snowfall in centimetres.
      snowfallMm: (() => {
        const cm = numAt(d["snowfall_sum"], i);
        return cm === null ? null : Math.round(cm * 10 * 10) / 10;
      })(),
      windMeanKph: numAt(d["wind_speed_10m_max"], i),
      windGustKph: numAt(d["wind_gusts_10m_max"], i),
      conditions: weatherCodeToConditions(code),
      raw: {
        weatherCode: code,
        tempMinC: min,
        tempMaxC: max,
        precipitationSumMm: numAt(d["precipitation_sum"], i),
        snowfallSumCm: numAt(d["snowfall_sum"], i),
        windSpeedMaxKph: numAt(d["wind_speed_10m_max"], i),
        windGustsMaxKph: numAt(d["wind_gusts_10m_max"], i),
      },
    };
    const everyMetricMissing =
      reading.tempMinC === null &&
      reading.tempMaxC === null &&
      reading.precipitationMm === null &&
      reading.windMeanKph === null &&
      reading.windGustKph === null;
    if (everyMetricMissing) {
      reasons.push(`${date} came back with no metrics at all and was dropped rather than stored as zeroes.`);
      continue;
    }
    readings.push(reading);
  }
  return { readings, reasons };
}

/**
 * Fetch an archive window. Never throws.
 *
 * `enabled=false` (tests, air-gapped deployments) short-circuits before any
 * network call, which is why the sweep is safe to register unconditionally.
 */
export async function fetchArchive(
  input: { latitude: number | null; longitude: number | null; from: string; to: string },
  options: { fetchImpl?: FetchLike; timeoutMs?: number; enabled?: boolean; now?: () => string } = {},
): Promise<ProviderResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const base = { provider: "open-meteo", fetchedAt: now(), readings: [] as ProviderReading[] };
  if (options.enabled === false) {
    return { ...base, reasons: ["Weather capture is disabled in this environment."] };
  }
  const { latitude, longitude, from, to } = input;
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    return {
      ...base,
      reasons: [
        "The project has no latitude/longitude, so no provider can be asked for its weather. Set the project's coordinates, or record observations manually.",
      ],
    };
  }
  const fetchImpl: FetchLike | undefined =
    options.fetchImpl ??
    (typeof globalThis.fetch === "function" ? (globalThis.fetch as unknown as FetchLike) : undefined);
  if (!fetchImpl) {
    return { ...base, reasons: ["No fetch implementation is available in this runtime."] };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 6000);
  try {
    const res = await fetchImpl(openMeteoArchiveUrl(latitude, longitude, from, to), {
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ...base, reasons: [`The provider answered HTTP ${res.status}.`] };
    }
    const body: unknown = await res.json();
    const parsed = parseOpenMeteoArchive(body);
    return { ...base, readings: parsed.readings, reasons: parsed.reasons };
  } catch (err) {
    return {
      ...base,
      reasons: [`The provider could not be reached: ${err instanceof Error ? err.message : String(err)}`],
    };
  } finally {
    clearTimeout(timer);
  }
}
