/**
 * SUB-QUOTE LEVELLING — spec Vol I §1.2 (#202–203).
 *
 * Comparing subcontract quotes is not an arithmetic problem, it is a SCOPE
 * problem: the cheapest number on the page is normally the one that priced
 * the least. So this engine works on scope rows rather than on totals, and
 * reports three things a total cannot say:
 *
 *   coverage   who priced this row at all, and who excluded it
 *   spread     how far apart the people who did price it are
 *   outliers   whose number is a long way from the pack, in either direction
 *
 * Outliers are flagged by MEDIAN ABSOLUTE DEVIATION rather than by standard
 * deviation, because with three or four bidders one wild number drags a mean
 * and its own standard deviation far enough to hide itself. A row with fewer
 * than three prices gets no outlier verdict at all, and says so — a spread of
 * two is a difference of opinion, not evidence.
 *
 * Pure; no database.
 */
import { round2, round4 } from "./pricing.js";

export interface QuoteLineInput {
  quoteId: string;
  vendorName: string;
  lineId: string;
  scopeKey: string;
  description: string;
  unit?: string | null;
  quantity?: number | null;
  unitRate?: number | null;
  amount: number;
  excluded?: boolean;
}

export interface QuoteInput {
  id: string;
  vendorId?: string | null;
  vendorName: string;
  tradePackage: string;
  status: string;
  currency: string;
  quotedTotal: number;
  adjustmentAmount?: number | null;
  validUntil?: string | null;
  lines: readonly QuoteLineInput[];
}

export interface ScopeRowEntry {
  quoteId: string;
  vendorName: string;
  lineId: string;
  amount: number;
  unitRate: number | null;
  excluded: boolean;
  /** |amount − median| ÷ MAD; null when the row has too few prices to judge */
  deviation: number | null;
  outlier: boolean;
}

export interface ScopeRow {
  scopeKey: string;
  description: string;
  unit: string | null;
  quantity: number | null;
  entries: ScopeRowEntry[];
  pricedCount: number;
  excludedCount: number;
  /** quotes that never mentioned this row at all — the real scope gap */
  missingVendors: string[];
  low: number | null;
  high: number | null;
  median: number | null;
  mean: number | null;
  /** high − low as a fraction of the median; null when unjudgeable */
  spread: number | null;
  verdict: string;
}

export interface QuoteTotal {
  quoteId: string;
  vendorName: string;
  status: string;
  currency: string;
  quotedTotal: number;
  adjustmentAmount: number;
  levelledTotal: number;
  /** scope rows this bidder priced, out of the rows in the comparison */
  coverage: number;
  pricedRows: number;
  excludedRows: number;
  missingRows: number;
  /** levelledTotal + the pack median for every row this bidder did not price */
  comparableTotal: number | null;
  comparableBasis: string;
}

export interface LevellingResult {
  tradePackage: string | null;
  currencies: string[];
  /** the single currency the comparison is in, or null when quotes disagree */
  currency: string | null;
  rows: ScopeRow[];
  totals: QuoteTotal[];
  scopeGaps: Array<{ scopeKey: string; description: string; missingVendors: string[] }>;
  outliers: Array<{
    scopeKey: string;
    description: string;
    vendorName: string;
    quoteId: string;
    amount: number;
    median: number;
    deviation: number;
    direction: "high" | "low";
  }>;
  warnings: string[];
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  if (lo === undefined || hi === undefined) return null;
  return (lo + hi) / 2;
}

/** Normalise a free-text scope description into a comparison key. */
export function normaliseScopeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
}

/** Median absolute deviation, scaled to be comparable with a standard deviation. */
export function medianAbsoluteDeviation(values: readonly number[]): number | null {
  const m = median(values);
  if (m === null) return null;
  const deviations = values.map((v) => Math.abs(v - m));
  const mad = median(deviations);
  if (mad === null) return null;
  return mad * 1.4826;
}

const OUTLIER_THRESHOLD = 3;

/**
 * Level a set of quotes on the same package.
 *
 * `minEntriesForOutlier` guards the small-n case: with two prices there is no
 * pack to be outside of.
 */
export function levelQuotes(
  quotes: readonly QuoteInput[],
  options: { minEntriesForOutlier?: number } = {},
): LevellingResult {
  const warnings: string[] = [];
  const minEntries = options.minEntriesForOutlier ?? 3;

  const currencies = [...new Set(quotes.map((q) => q.currency))].sort();
  const currency = currencies.length === 1 ? (currencies[0] ?? null) : null;
  if (currencies.length > 1) {
    warnings.push(
      `The quotes are in ${currencies.length} currencies (${currencies.join(", ")}). Totals are NOT summed or converted across them; level the currencies first.`,
    );
  }
  const packages = [...new Set(quotes.map((q) => q.tradePackage))];
  if (packages.length > 1) {
    warnings.push(
      `The quotes span ${packages.length} trade packages (${packages.join(", ")}), so the scope rows may not be comparable.`,
    );
  }

  /* --- gather the scope rows -------------------------------------------- */
  interface Bucket {
    description: string;
    unit: string | null;
    quantity: number | null;
    byQuote: Map<string, QuoteLineInput>;
  }
  const buckets = new Map<string, Bucket>();
  for (const q of quotes) {
    for (const line of q.lines) {
      const key = normaliseScopeKey(line.scopeKey || line.description);
      if (key.length === 0) continue;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          description: line.description,
          unit: line.unit ?? null,
          quantity: line.quantity ?? null,
          byQuote: new Map(),
        };
        buckets.set(key, bucket);
      }
      if (bucket.byQuote.has(q.id)) {
        warnings.push(
          `${q.vendorName} priced "${bucket.description}" more than once; only the first row was compared.`,
        );
        continue;
      }
      bucket.byQuote.set(q.id, { ...line, quoteId: q.id, vendorName: q.vendorName });
    }
  }

  const rows: ScopeRow[] = [];
  const outliers: LevellingResult["outliers"] = [];

  for (const [scopeKey, bucket] of buckets) {
    const entries: ScopeRowEntry[] = [];
    const missingVendors: string[] = [];
    for (const q of quotes) {
      const line = bucket.byQuote.get(q.id);
      if (!line) {
        missingVendors.push(q.vendorName);
        continue;
      }
      entries.push({
        quoteId: q.id,
        vendorName: q.vendorName,
        lineId: line.lineId,
        amount: round2(line.amount),
        unitRate: line.unitRate === null || line.unitRate === undefined ? null : round4(line.unitRate),
        excluded: line.excluded === true,
        deviation: null,
        outlier: false,
      });
    }

    const priced = entries.filter((e) => !e.excluded);
    const amounts = priced.map((e) => e.amount);
    const med = median(amounts);
    const mad = medianAbsoluteDeviation(amounts);
    const low = amounts.length > 0 ? Math.min(...amounts) : null;
    const high = amounts.length > 0 ? Math.max(...amounts) : null;
    const mean =
      amounts.length > 0 ? round2(amounts.reduce((s, v) => s + v, 0) / amounts.length) : null;

    if (priced.length >= minEntries && med !== null && mad !== null && mad > 0) {
      for (const e of priced) {
        const deviation = round4(Math.abs(e.amount - med) / mad);
        e.deviation = deviation;
        e.outlier = deviation >= OUTLIER_THRESHOLD;
        if (e.outlier) {
          outliers.push({
            scopeKey,
            description: bucket.description,
            vendorName: e.vendorName,
            quoteId: e.quoteId,
            amount: e.amount,
            median: round2(med),
            deviation,
            direction: e.amount > med ? "high" : "low",
          });
        }
      }
    }

    const spread =
      low !== null && high !== null && med !== null && med !== 0
        ? round4((high - low) / Math.abs(med))
        : null;

    let verdict: string;
    if (priced.length === 0) {
      verdict = "Nobody priced this row.";
    } else if (priced.length < minEntries) {
      verdict = `Only ${priced.length} price${priced.length === 1 ? "" : "s"} — too few to call an outlier.`;
    } else if (mad === null || mad === 0) {
      verdict = "Every bidder priced this row identically; check for cover pricing.";
    } else if (spread !== null && spread > 0.5) {
      verdict = `Prices span ${Math.round(spread * 100)}% of the median — the scope is probably being read differently.`;
    } else {
      verdict = "Prices are consistent.";
    }

    rows.push({
      scopeKey,
      description: bucket.description,
      unit: bucket.unit,
      quantity: bucket.quantity,
      entries,
      pricedCount: priced.length,
      excludedCount: entries.filter((e) => e.excluded).length,
      missingVendors,
      low: low === null ? null : round2(low),
      high: high === null ? null : round2(high),
      median: med === null ? null : round2(med),
      mean,
      spread,
      verdict,
    });
  }

  rows.sort((a, b) => (b.median ?? 0) - (a.median ?? 0));

  /* --- per-quote totals -------------------------------------------------- */
  const totals: QuoteTotal[] = quotes.map((q) => {
    const adjustment = Number.isFinite(q.adjustmentAmount ?? 0) ? (q.adjustmentAmount ?? 0) : 0;
    const levelled = round2(q.quotedTotal + adjustment);
    let priced = 0;
    let excluded = 0;
    let missing = 0;
    let gapFill = 0;
    let gapFillable = true;
    for (const row of rows) {
      const entry = row.entries.find((e) => e.quoteId === q.id);
      if (!entry) {
        missing += 1;
        if (row.median === null) gapFillable = false;
        else gapFill += row.median;
      } else if (entry.excluded) {
        excluded += 1;
        if (row.median === null) gapFillable = false;
        else gapFill += row.median;
      } else {
        priced += 1;
      }
    }
    const comparable = gapFillable ? round2(levelled + gapFill) : null;
    return {
      quoteId: q.id,
      vendorName: q.vendorName,
      status: q.status,
      currency: q.currency,
      quotedTotal: round2(q.quotedTotal),
      adjustmentAmount: round2(adjustment),
      levelledTotal: levelled,
      coverage: rows.length === 0 ? 0 : round4(priced / rows.length),
      pricedRows: priced,
      excludedRows: excluded,
      missingRows: missing,
      comparableTotal: comparable,
      comparableBasis:
        missing + excluded === 0
          ? "The bidder priced every scope row; the levelled total is directly comparable."
          : gapFillable
            ? `${missing + excluded} unpriced or excluded row${missing + excluded === 1 ? "" : "s"} filled at the pack median.`
            : "One or more unpriced rows have no pack median to fill from, so no comparable total can be stated.",
    };
  });
  totals.sort((a, b) => (a.comparableTotal ?? a.levelledTotal) - (b.comparableTotal ?? b.levelledTotal));

  const scopeGaps = rows
    .filter((r) => r.missingVendors.length > 0)
    .map((r) => ({ scopeKey: r.scopeKey, description: r.description, missingVendors: r.missingVendors }));

  return {
    tradePackage: packages.length === 1 ? (packages[0] ?? null) : null,
    currencies,
    currency,
    rows,
    totals,
    scopeGaps,
    outliers: outliers.sort((a, b) => b.deviation - a.deviation),
    warnings,
  };
}
