/** ISO-date arithmetic shared by the supply chain engines. All UTC, all calendar days. */

const DAY_MS = 86_400_000;

export function parseIsoDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : Math.floor(t / DAY_MS) * DAY_MS;
  }
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) ? null : t;
}

export function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const t = parseIsoDate(iso);
  if (t === null) throw new Error(`addDays: invalid date ${iso}`);
  return toIsoDate(t + days * DAY_MS);
}

/** b − a in whole days; null when either side is missing. */
export function daysBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  const ta = parseIsoDate(a);
  const tb = parseIsoDate(b);
  if (ta === null || tb === null) return null;
  return Math.round((tb - ta) / DAY_MS);
}

export function maxIso(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (!v) continue;
    if (best === null || v > best) best = v;
  }
  return best;
}

export function minutesBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((tb - ta) / 60_000);
}
