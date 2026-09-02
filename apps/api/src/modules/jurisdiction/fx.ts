/**
 * Pure multi-currency engine — spec Vol II Domain K / M19 (#593-599).
 *
 * Two mechanics live here, both deliberately free of I/O so they can be
 * reasoned about and tested directly:
 *
 *  1. **Currency proportions** (#593-595). A contract fixes, at its base
 *     date, the share of each payment settled in each currency and the
 *     exchange rate applied to that share (FIDIC Sub-Clause 14.15). The
 *     proportions must exhaust the payment — they sum to 100%.
 *
 *  2. **Rate resolution and payment splitting** (#596, #599). Converting
 *     between two currencies from a sparse table of dated quotes, and
 *     valuing a contractual split against today's market to expose the
 *     FX gain/loss the contractual rate is carrying.
 *
 * RATE DIRECTION — the single convention everything else depends on:
 * a rate `from → to` is **the number of units of `to` bought by one unit
 * of `from`**. A portion's `baseRate` is therefore units of the portion
 * currency per 1 unit of the contract's base currency, and
 * `foreignAmount = baseAmount × baseRate`.
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** One currency share of a contract sum (#593-595). */
export interface Portion {
  currency: string;
  proportionPercent: number;
  /** units of `currency` per 1 unit of the config's base currency */
  baseRate: number;
}

/** A dated quote as stored in the fx_rates register (#597). */
export interface RateQuote {
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  rateDate: string;
  source: string;
}

/** How a rate was arrived at — reported so the audit trail is explicit. */
export type ConversionPath = "identity" | "direct" | "inverse" | "triangulated";

export interface ResolvedRate {
  rate: number;
  /** the quote date backing the rate; for a triangulation, the STALER leg */
  rateDate: string | null;
  path: ConversionPath;
  /** the pivot currency, triangulations only */
  via?: string;
  /** the quotes actually used, in the order applied */
  legs: RateQuote[];
}

export interface ConversionResult extends ResolvedRate {
  amount: number;
  fromCurrency: string;
  toCurrency: string;
  converted: number;
}

/** Quote lookup for an ordered pair; returns null when the pair is unquoted. */
export type RateLookup = (from: string, to: string) => RateQuote | null;

/* ------------------------------------------------------------------ */
/* Rounding                                                            */
/* ------------------------------------------------------------------ */

/** Money rounding — 2 decimal places, half-up on positive values. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Rate rounding — 8 decimal places, enough that reported = applied. */
export function round8(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

/** Percentages carry 4 decimals; proportions are never money. */
export function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

export function normalizeCurrency(code: string): string {
  return code.trim().toUpperCase();
}

/* ------------------------------------------------------------------ */
/* Portions (#593-595)                                                 */
/* ------------------------------------------------------------------ */

/** Currency proportions must sum to 100% within this absolute tolerance. */
export const PORTION_SUM_TOLERANCE = 0.01;

export interface PortionValidation {
  ok: boolean;
  /** human-readable reason, present only when `ok` is false */
  message?: string;
  /** currency codes uppercased, order preserved */
  portions: Portion[];
  sum: number;
}

/**
 * Validate and normalize a contractual currency split (#593-595).
 *
 * A split is valid when it has at least one portion, every currency code
 * appears exactly once (compared case-insensitively), every base rate is
 * strictly positive, and the proportions sum to 100 ± 0.01. The tolerance
 * exists because contracts routinely state thirds as 33.33/33.33/33.34.
 */
export function validatePortions(input: Portion[]): PortionValidation {
  const portions: Portion[] = input.map((p) => ({
    currency: normalizeCurrency(p.currency),
    proportionPercent: p.proportionPercent,
    baseRate: p.baseRate,
  }));
  const sum = round4(portions.reduce((s, p) => s + p.proportionPercent, 0));
  if (portions.length === 0) {
    return { ok: false, message: "At least one currency portion is required", portions, sum };
  }
  const seen = new Set<string>();
  for (const p of portions) {
    if (p.currency.length !== 3) {
      return {
        ok: false,
        message: `Currency "${p.currency}" is not a 3-letter code`,
        portions,
        sum,
      };
    }
    if (seen.has(p.currency)) {
      return {
        ok: false,
        message: `Currency ${p.currency} appears more than once in the portions`,
        portions,
        sum,
      };
    }
    seen.add(p.currency);
    if (!(p.baseRate > 0) || !Number.isFinite(p.baseRate)) {
      return {
        ok: false,
        message: `baseRate for ${p.currency} must be greater than 0`,
        portions,
        sum,
      };
    }
    if (!Number.isFinite(p.proportionPercent) || p.proportionPercent < 0) {
      return {
        ok: false,
        message: `proportionPercent for ${p.currency} must not be negative`,
        portions,
        sum,
      };
    }
  }
  if (Math.abs(sum - 100) > PORTION_SUM_TOLERANCE) {
    return {
      ok: false,
      message: `Currency proportions must sum to 100% (they sum to ${sum}%)`,
      portions,
      sum,
    };
  }
  return { ok: true, portions, sum };
}

/* ------------------------------------------------------------------ */
/* Rate resolution (#596-597)                                          */
/* ------------------------------------------------------------------ */

const key = (from: string, to: string): string => `${from}>${to}`;

/**
 * Build a lookup from a list of quotes. Later entries win, so pass rows
 * ordered oldest-first and the map holds the latest quote per ordered
 * pair — which is exactly "the rate as at the as-of date".
 */
export function buildRateLookup(rows: RateQuote[]): RateLookup {
  const map = new Map<string, RateQuote>();
  for (const r of rows) {
    map.set(key(normalizeCurrency(r.fromCurrency), normalizeCurrency(r.toCurrency)), {
      ...r,
      fromCurrency: normalizeCurrency(r.fromCurrency),
      toCurrency: normalizeCurrency(r.toCurrency),
    });
  }
  return (from, to) => map.get(key(normalizeCurrency(from), normalizeCurrency(to))) ?? null;
}

/** Direct quote, else the reciprocal of the opposite quote. Never pivots. */
function resolveLeg(from: string, to: string, lookup: RateLookup): ResolvedRate | null {
  if (from === to) return { rate: 1, rateDate: null, path: "identity", legs: [] };
  const direct = lookup(from, to);
  if (direct && direct.rate > 0) {
    return { rate: direct.rate, rateDate: direct.rateDate, path: "direct", legs: [direct] };
  }
  const inverse = lookup(to, from);
  if (inverse && inverse.rate > 0) {
    return {
      rate: 1 / inverse.rate,
      rateDate: inverse.rateDate,
      path: "inverse",
      legs: [inverse],
    };
  }
  return null;
}

/**
 * Resolve `from → to`, trying, **in this order**:
 *
 *   1. `identity`     — the currencies are the same; rate 1, no quote used.
 *   2. `direct`       — a quote from → to exists.
 *   3. `inverse`      — a quote to → from exists; the reciprocal is used.
 *   4. `triangulated` — both legs resolve through `baseCurrency` (each leg
 *                       itself direct-then-inverse); rate = leg1 × leg2.
 *
 * Returns null when no path exists. A triangulated rate is only as fresh
 * as its stalest leg, so `rateDate` reports the EARLIER of the two dates.
 */
export function resolveRate(
  from: string,
  to: string,
  lookup: RateLookup,
  baseCurrency?: string | null,
): ResolvedRate | null {
  const f = normalizeCurrency(from);
  const t = normalizeCurrency(to);
  const straight = resolveLeg(f, t, lookup);
  if (straight) return { ...straight, rate: round8(straight.rate) };
  const base = baseCurrency ? normalizeCurrency(baseCurrency) : null;
  if (!base || base === f || base === t) return null;
  const first = resolveLeg(f, base, lookup);
  const second = resolveLeg(base, t, lookup);
  if (!first || !second) return null;
  const dates = [first.rateDate, second.rateDate].filter((d): d is string => d !== null);
  dates.sort();
  return {
    rate: round8(first.rate * second.rate),
    rateDate: dates[0] ?? null,
    path: "triangulated",
    via: base,
    legs: [...first.legs, ...second.legs],
  };
}

/** Convert an amount, reporting the rate and the path that produced it. */
export function convert(
  amount: number,
  from: string,
  to: string,
  lookup: RateLookup,
  baseCurrency?: string | null,
): ConversionResult | null {
  const resolved = resolveRate(from, to, lookup, baseCurrency);
  if (!resolved) return null;
  return {
    ...resolved,
    amount: round2(amount),
    fromCurrency: normalizeCurrency(from),
    toCurrency: normalizeCurrency(to),
    // computed from the REPORTED (rounded) rate so the arithmetic on the
    // wire always reproduces
    converted: round2(amount * resolved.rate),
  };
}

/* ------------------------------------------------------------------ */
/* Payment splitting (#596) and FX gain/loss (#599)                    */
/* ------------------------------------------------------------------ */

export interface SplitLine {
  currency: string;
  proportionPercent: number;
  /** the portion's share of the payment, in the BASE currency */
  baseAmount: number;
  /** the rate fixed at the contract base date */
  contractualRate: number;
  /** what is actually payable in this currency under the contract */
  contractualAmount: number;
  /** latest market rate on/before the as-of date; null when unquoted */
  marketRate: number | null;
  marketRateDate: string | null;
  marketRatePath: ConversionPath | null;
  /** what the same base share would buy today; null when unquoted */
  marketAmount: number | null;
  /** marketAmount − contractualAmount, in this currency; null when unquoted */
  fxVariance: number | null;
  /**
   * The base-currency cost, at today's market, of buying the contractual
   * foreign entitlement (#599). Null when unquoted.
   */
  contractualBaseEquivalent: number | null;
  /** contractualBaseEquivalent − baseAmount: the unrealised gain/loss */
  baseVariance: number | null;
}

export interface SplitTotals {
  /** sum of the base-currency shares — equals the amount split */
  baseAmount: number;
  proportionPercent: number;
  /** base-currency shares of the portions that HAVE a market rate */
  coveredBaseAmount: number;
  /** market cost of those covered portions' contractual entitlements */
  coveredBaseEquivalent: number;
  /**
   * coveredBaseEquivalent − coveredBaseAmount. Positive means the
   * contractual rates are now expensive relative to the market (the payer
   * is over-paying against spot); negative means they are cheap.
   */
  baseVariance: number;
  /** currencies with no usable market quote on/before the as-of date */
  missingRates: string[];
}

export interface SplitResult {
  baseCurrency: string;
  lines: SplitLine[];
  totals: SplitTotals;
  /** present when at least one portion could not be valued at market */
  note: string | null;
}

/**
 * Split a payment across the contractual currency portions (#596) and
 * value each share against the market (#599).
 *
 * For each portion:
 *   baseAmount        = amount × proportionPercent / 100      (base currency)
 *   contractualAmount = baseAmount × baseRate                 (portion currency)
 *   marketAmount      = baseAmount × marketRate               (portion currency)
 *   fxVariance        = marketAmount − contractualAmount      (portion currency)
 *
 * and, for the gain/loss statement, the base-currency cost today of the
 * contractual entitlement, `contractualAmount ÷ marketRate`, against the
 * base share it was meant to settle.
 *
 * Market rates are resolved base → portion currency through the same
 * identity/direct/inverse/triangulated ladder; a portion with no path is
 * reported with nulls rather than dropped, so a partially-quoted contract
 * still produces a usable statement.
 */
export function splitPayment(
  amount: number,
  baseCurrency: string,
  portions: Portion[],
  lookup: RateLookup,
): SplitResult {
  const base = normalizeCurrency(baseCurrency);
  const missingRates: string[] = [];
  let coveredBaseAmount = 0;
  let coveredBaseEquivalent = 0;

  const lines: SplitLine[] = portions.map((p) => {
    const currency = normalizeCurrency(p.currency);
    const baseAmount = round2((amount * p.proportionPercent) / 100);
    const contractualAmount = round2(baseAmount * p.baseRate);
    const market = resolveRate(base, currency, lookup, base);
    if (!market || !(market.rate > 0)) {
      missingRates.push(currency);
      return {
        currency,
        proportionPercent: p.proportionPercent,
        baseAmount,
        contractualRate: p.baseRate,
        contractualAmount,
        marketRate: null,
        marketRateDate: null,
        marketRatePath: null,
        marketAmount: null,
        fxVariance: null,
        contractualBaseEquivalent: null,
        baseVariance: null,
      };
    }
    const marketAmount = round2(baseAmount * market.rate);
    const contractualBaseEquivalent = round2(contractualAmount / market.rate);
    coveredBaseAmount += baseAmount;
    coveredBaseEquivalent += contractualBaseEquivalent;
    return {
      currency,
      proportionPercent: p.proportionPercent,
      baseAmount,
      contractualRate: p.baseRate,
      contractualAmount,
      marketRate: market.rate,
      marketRateDate: market.rateDate,
      marketRatePath: market.path,
      marketAmount,
      fxVariance: round2(marketAmount - contractualAmount),
      contractualBaseEquivalent,
      baseVariance: round2(contractualBaseEquivalent - baseAmount),
    };
  });

  return {
    baseCurrency: base,
    lines,
    totals: {
      baseAmount: round2(lines.reduce((s, l) => s + l.baseAmount, 0)),
      proportionPercent: round4(lines.reduce((s, l) => s + l.proportionPercent, 0)),
      coveredBaseAmount: round2(coveredBaseAmount),
      coveredBaseEquivalent: round2(coveredBaseEquivalent),
      baseVariance: round2(coveredBaseEquivalent - coveredBaseAmount),
      missingRates,
    },
    note:
      missingRates.length > 0
        ? `No market rate on or before the as-of date for ${missingRates.join(", ")} — ` +
          `those portions are shown at contractual values only and are excluded from the variance.`
        : null,
  };
}
