/**
 * Framework, lot and call-off value tracking, and schedule-of-rates pricing.
 * Spec Vol II Domain Z #1053 (framework and call-off management), #1054
 * (mini-competitions), #1055 (term contract / schedule of rates), #1056
 * (measured term contract orders).
 *
 * Pure and deterministic. The route hands over one framework's lots and every
 * call-off drawn against it; this file works out what has been consumed,
 * what headroom is left and where a ceiling has been breached.
 *
 * Currency rule: a call-off in a currency other than the framework's cannot
 * consume that framework's ceiling. It is excluded and counted, never
 * converted — see `currencyMismatches`.
 *
 * What it deliberately does NOT do: price a measured term order against rates
 * it was not given. A line whose SOR code is unknown is returned unpriced
 * with its reason, so the order total is honest about the gap.
 */

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Call-off statuses that consume a framework ceiling. Cancelled ones release it. */
export const CONSUMING_CALL_OFF_STATUSES = ["issued", "in_progress", "completed", "disputed"];

export interface FrameworkRow {
  id: string;
  reference: string;
  title: string;
  currency: string;
  maximumValue: number | null;
  startDate: string | null;
  endDate: string | null;
  extensionToDate: string | null;
  awardMode: string;
  directAwardThreshold: number | null;
  status: string;
}

export interface LotRow {
  id: string;
  frameworkId: string;
  lotNumber: string;
  title: string;
  currency: string;
  ceilingValue: number | null;
  awardMode: string | null;
  status: string;
}

export interface CallOffRow {
  id: string;
  projectId: string;
  reference: string;
  frameworkId: string | null;
  lotId: string | null;
  termContractId: string | null;
  route: string;
  currency: string;
  orderValue: number;
  certifiedValue: number;
  status: string;
}

export interface LotUtilisation {
  lotId: string;
  lotNumber: string;
  title: string;
  currency: string;
  ceiling: number | null;
  ordered: number;
  certified: number;
  callOffCount: number;
  headroom: number | null;
  utilisationPercent: number | null;
  breached: boolean;
  breachedBy: number;
  currencyMismatches: number;
  reasons: string[];
}

export interface FrameworkUtilisation {
  frameworkId: string;
  currency: string;
  ceiling: number | null;
  ordered: number;
  certified: number;
  callOffCount: number;
  headroom: number | null;
  utilisationPercent: number | null;
  breached: boolean;
  breachedBy: number;
  currencyMismatches: number;
  /** call-offs against the framework that name no lot */
  unallocatedCallOffs: number;
  lots: LotUtilisation[];
  /** days until the framework (or its exercised extension) ends; null when open */
  daysToExpiry: number | null;
  expiresOn: string | null;
  liveCallOffsAtExpiry: number;
  reasons: string[];
}

function daysBetween(fromISO: string, toISO: string): number {
  const from = Date.parse(`${fromISO.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${toISO.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / 86_400_000);
}

/**
 * Consumption of a framework and each of its lots. `today` is passed in
 * rather than read from the clock so the function stays testable and the
 * caller owns the notion of "now".
 */
export function frameworkUtilisation(
  framework: FrameworkRow,
  lots: LotRow[],
  callOffs: CallOffRow[],
  today: string,
): FrameworkUtilisation {
  const reasons: string[] = [];
  const mine = callOffs.filter((c) => c.frameworkId === framework.id);
  const sameCurrency = mine.filter((c) => c.currency === framework.currency);
  const mismatches = mine.length - sameCurrency.length;
  if (mismatches > 0) {
    reasons.push(
      `${mismatches} call-off(s) are denominated in a currency other than the framework's (${framework.currency}) and are excluded from its consumption.`,
    );
  }
  const consuming = sameCurrency.filter((c) => CONSUMING_CALL_OFF_STATUSES.includes(c.status));

  const lotRows: LotUtilisation[] = lots
    .filter((l) => l.frameworkId === framework.id)
    .sort((a, b) => a.lotNumber.localeCompare(b.lotNumber, undefined, { numeric: true }))
    .map((lot) => {
      const inLot = mine.filter((c) => c.lotId === lot.id);
      const lotSame = inLot.filter((c) => c.currency === lot.currency);
      const lotMismatches = inLot.length - lotSame.length;
      const lotConsuming = lotSame.filter((c) => CONSUMING_CALL_OFF_STATUSES.includes(c.status));
      const ordered = round2(lotConsuming.reduce((s, c) => s + c.orderValue, 0));
      const certified = round2(lotSame.reduce((s, c) => s + c.certifiedValue, 0));
      const ceiling = lot.ceilingValue;
      const headroom = ceiling === null ? null : round2(ceiling - ordered);
      const lotReasons: string[] = [];
      if (ceiling === null) lotReasons.push("This lot has no declared ceiling, so headroom cannot be computed.");
      if (lotMismatches > 0) {
        lotReasons.push(`${lotMismatches} call-off(s) in another currency are excluded from this lot.`);
      }
      return {
        lotId: lot.id,
        lotNumber: lot.lotNumber,
        title: lot.title,
        currency: lot.currency,
        ceiling,
        ordered,
        certified,
        callOffCount: lotConsuming.length,
        headroom,
        utilisationPercent: ceiling !== null && ceiling > 0 ? round2((ordered / ceiling) * 100) : null,
        breached: headroom !== null && headroom < -0.005,
        breachedBy: headroom !== null && headroom < 0 ? round2(-headroom) : 0,
        currencyMismatches: lotMismatches,
        reasons: lotReasons,
      };
    });

  const ordered = round2(consuming.reduce((s, c) => s + c.orderValue, 0));
  const certified = round2(sameCurrency.reduce((s, c) => s + c.certifiedValue, 0));
  const ceiling = framework.maximumValue;
  const headroom = ceiling === null ? null : round2(ceiling - ordered);
  if (ceiling === null) {
    reasons.push("This framework has no declared maximum value, so overall headroom cannot be computed.");
  }
  const unallocated = consuming.filter((c) => c.lotId === null).length;
  if (unallocated > 0 && lotRows.length > 0) {
    reasons.push(`${unallocated} call-off(s) name the framework but no lot.`);
  }

  const expiresOn = framework.extensionToDate ?? framework.endDate;
  const daysToExpiry = expiresOn ? daysBetween(today, expiresOn) : null;
  const liveCallOffsAtExpiry = sameCurrency.filter((c) => c.status === "issued" || c.status === "in_progress").length;

  return {
    frameworkId: framework.id,
    currency: framework.currency,
    ceiling,
    ordered,
    certified,
    callOffCount: consuming.length,
    headroom,
    utilisationPercent: ceiling !== null && ceiling > 0 ? round2((ordered / ceiling) * 100) : null,
    breached: headroom !== null && headroom < -0.005,
    breachedBy: headroom !== null && headroom < 0 ? round2(-headroom) : 0,
    currencyMismatches: mismatches,
    unallocatedCallOffs: unallocated,
    lots: lotRows,
    daysToExpiry,
    expiresOn,
    liveCallOffsAtExpiry,
    reasons,
  };
}

/* ================================================================== */
/* Direct-award eligibility (#1053 framework rules)                    */
/* ================================================================== */

export interface DirectAwardCheck {
  permitted: boolean;
  reasons: string[];
}

/**
 * Whether a direct award of `value` is permissible under the framework's own
 * rules. A refusal is never silent — every reason is returned so the buyer
 * can see exactly which rule bites.
 */
export function checkDirectAward(
  framework: FrameworkRow,
  lot: LotRow | null,
  value: number,
  currency: string,
): DirectAwardCheck {
  const reasons: string[] = [];
  const mode = lot?.awardMode ?? framework.awardMode;
  if (mode === "mini_competition") {
    reasons.push(
      `${lot ? `Lot ${lot.lotNumber}` : "This framework"} requires a mini-competition; a direct award is not available.`,
    );
  }
  if (currency !== framework.currency) {
    reasons.push(
      `The call-off is in ${currency} but the framework is denominated in ${framework.currency}; the threshold cannot be applied across currencies.`,
    );
  } else if (framework.directAwardThreshold !== null && value > framework.directAwardThreshold) {
    reasons.push(
      `The value ${round2(value)} ${currency} exceeds the framework's direct-award threshold of ${round2(framework.directAwardThreshold)} ${currency}.`,
    );
  }
  if (framework.status !== "live") {
    reasons.push(`The framework status is "${framework.status}"; only a live framework may be called off.`);
  }
  return { permitted: reasons.length === 0, reasons };
}

/* ================================================================== */
/* Schedule-of-rates pricing for measured term orders (#1055–#1056)    */
/* ================================================================== */

export interface SorItem {
  id: string;
  code: string;
  description: string;
  unit: string;
  currency: string;
  rate: number;
  active: boolean;
}

export interface CallOffLineInput {
  sorItemId?: string | null;
  code?: string | null;
  description?: string | null;
  unit?: string | null;
  quantity: number;
  /** an explicitly agreed rate that overrides the schedule (a star rate) */
  rate?: number | null;
}

export interface PricedLine {
  sorItemId: string | null;
  code: string;
  description: string;
  unit: string;
  quantity: number;
  /** the schedule rate before the contract's percentage adjustment */
  baseRate: number | null;
  /** baseRate × (1 + adjustmentPercent/100), or the star rate as given */
  rate: number | null;
  amount: number | null;
  source: "schedule" | "star_rate" | "unpriced";
  reason: string | null;
}

export interface PricedOrder {
  currency: string;
  adjustmentPercent: number;
  lines: PricedLine[];
  /** total of the priced lines only */
  total: number;
  pricedLines: number;
  unpricedLines: number;
  reasons: string[];
}

/**
 * Price a measured term order against a term contract's schedule of rates.
 * The contract's percentage adjustment is applied to schedule rates and NOT
 * to star rates: a rate agreed for this order is already the agreed number.
 */
export function priceCallOffLines(
  lines: CallOffLineInput[],
  sorItems: SorItem[],
  options: { currency: string; adjustmentPercent: number },
): PricedOrder {
  const byId = new Map(sorItems.map((i) => [i.id, i]));
  const byCode = new Map(sorItems.map((i) => [i.code.toUpperCase(), i]));
  const reasons: string[] = [];
  const factor = 1 + options.adjustmentPercent / 100;

  const priced: PricedLine[] = lines.map((line) => {
    const quantity = Number.isFinite(line.quantity) ? line.quantity : 0;
    const item =
      (line.sorItemId ? byId.get(line.sorItemId) : undefined) ??
      (line.code ? byCode.get(line.code.toUpperCase()) : undefined) ??
      null;

    if (line.rate !== null && line.rate !== undefined && Number.isFinite(line.rate)) {
      return {
        sorItemId: item?.id ?? null,
        code: line.code ?? item?.code ?? "—",
        description: line.description ?? item?.description ?? "",
        unit: line.unit ?? item?.unit ?? "",
        quantity,
        baseRate: item?.rate ?? null,
        rate: line.rate,
        amount: round2(quantity * line.rate),
        source: "star_rate",
        reason: item ? null : "priced at an agreed star rate; no schedule item matches this code",
      };
    }
    if (!item) {
      return {
        sorItemId: null,
        code: line.code ?? "—",
        description: line.description ?? "",
        unit: line.unit ?? "",
        quantity,
        baseRate: null,
        rate: null,
        amount: null,
        source: "unpriced",
        reason: "no item in the schedule of rates matches this code and no star rate was agreed",
      };
    }
    if (!item.active) {
      return {
        sorItemId: item.id,
        code: item.code,
        description: item.description,
        unit: item.unit,
        quantity,
        baseRate: item.rate,
        rate: null,
        amount: null,
        source: "unpriced",
        reason: "the schedule item is no longer active; agree a star rate or reinstate the item",
      };
    }
    if (item.currency !== options.currency) {
      return {
        sorItemId: item.id,
        code: item.code,
        description: item.description,
        unit: item.unit,
        quantity,
        baseRate: item.rate,
        rate: null,
        amount: null,
        source: "unpriced",
        reason: `the schedule rate is in ${item.currency} but the order is in ${options.currency}`,
      };
    }
    const rate = round2(item.rate * factor);
    return {
      sorItemId: item.id,
      code: item.code,
      description: line.description ?? item.description,
      unit: item.unit,
      quantity,
      baseRate: item.rate,
      rate,
      amount: round2(quantity * rate),
      source: "schedule",
      reason: null,
    };
  });

  const unpriced = priced.filter((l) => l.amount === null).length;
  if (unpriced > 0) {
    reasons.push(`${unpriced} line(s) could not be priced and are excluded from the order total.`);
  }
  if (options.adjustmentPercent !== 0) {
    reasons.push(
      `Schedule rates carry the contract's ${options.adjustmentPercent > 0 ? "+" : ""}${options.adjustmentPercent}% adjustment; star rates do not.`,
    );
  }
  return {
    currency: options.currency,
    adjustmentPercent: options.adjustmentPercent,
    lines: priced,
    total: round2(priced.reduce((s, l) => s + (l.amount ?? 0), 0)),
    pricedLines: priced.length - unpriced,
    unpricedLines: unpriced,
    reasons,
  };
}

/* ================================================================== */
/* Mini-competition evaluation (#1054)                                 */
/* ================================================================== */

export interface MiniCompetitionResponse {
  supplierId: string;
  supplierName: string;
  price: number | null;
  /** quality scores by criterion key, 0..100 */
  scores?: Record<string, number>;
  withdrawn?: boolean;
  submittedAt?: string | null;
}

export interface MiniCompetitionCriterion {
  key: string;
  label: string;
  weight: number;
  /** when true this criterion is the price criterion and is scored inversely */
  isPrice?: boolean;
}

export interface EvaluatedResponse {
  supplierId: string;
  supplierName: string;
  price: number | null;
  qualityScore: number | null;
  priceScore: number | null;
  totalScore: number | null;
  rank: number | null;
  reasons: string[];
}

export interface MiniCompetitionEvaluation {
  responses: EvaluatedResponse[];
  lowestPrice: number | null;
  /** the supplier the arithmetic favours; the award decision remains a human act */
  indicatedWinnerId: string | null;
  warnings: string[];
}

/**
 * Score mini-competition responses. Price is scored relative to the lowest
 * compliant price (lowest = 100); quality criteria are taken as entered on a
 * 0–100 scale. The result is called "indicated", never "winner": the award is
 * a decision a person records, and the platform does not make it for them.
 */
export function evaluateMiniCompetition(
  criteria: MiniCompetitionCriterion[],
  responses: MiniCompetitionResponse[],
): MiniCompetitionEvaluation {
  const warnings: string[] = [];
  const live = responses.filter((r) => !r.withdrawn);
  if (live.length !== responses.length) {
    warnings.push(`${responses.length - live.length} response(s) were withdrawn and are excluded.`);
  }
  const totalWeight = criteria.reduce((s, c) => s + (c.weight > 0 ? c.weight : 0), 0);
  if (totalWeight <= 0) {
    warnings.push("No evaluation criterion carries weight; responses can only be compared on price.");
  }
  const priceCriterion = criteria.find((c) => c.isPrice) ?? null;
  const prices = live.map((r) => r.price).filter((p): p is number => p !== null && Number.isFinite(p) && p > 0);
  const lowestPrice = prices.length > 0 ? Math.min(...prices) : null;
  if (prices.length !== live.length) {
    warnings.push(`${live.length - prices.length} response(s) carry no usable price.`);
  }

  const evaluated: EvaluatedResponse[] = live.map((r) => {
    const reasons: string[] = [];
    let qualityWeighted = 0;
    let qualityWeight = 0;
    for (const c of criteria) {
      if (c.isPrice || c.weight <= 0) continue;
      const raw = r.scores?.[c.key];
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        reasons.push(`not scored on "${c.label}"`);
        continue;
      }
      qualityWeighted += c.weight * Math.min(Math.max(raw, 0), 100);
      qualityWeight += c.weight;
    }
    const qualityScore = qualityWeight > 0 ? round2(qualityWeighted / qualityWeight) : null;
    let priceScore: number | null = null;
    if (priceCriterion && lowestPrice !== null && r.price !== null && r.price > 0) {
      priceScore = round2((lowestPrice / r.price) * 100);
    } else if (priceCriterion) {
      reasons.push("no usable price, so the price criterion could not be scored");
    }

    let totalScore: number | null = null;
    if (totalWeight > 0) {
      let covered = 0;
      let sum = 0;
      for (const c of criteria) {
        if (c.weight <= 0) continue;
        // Price is scored relative to the lowest price; every other criterion
        // is taken from the entered 0–100 score for that criterion alone.
        const entered = r.scores?.[c.key];
        const value = c.isPrice
          ? priceScore
          : typeof entered === "number" && Number.isFinite(entered)
            ? Math.min(Math.max(entered, 0), 100)
            : null;
        if (value === null) continue;
        sum += c.weight * value;
        covered += c.weight;
      }
      totalScore = covered > 0 ? round2(sum / covered) : null;
      if (covered > 0 && covered < totalWeight) {
        reasons.push(`scored on ${round2((covered / totalWeight) * 100)}% of the evaluation weight`);
      }
    }
    return {
      supplierId: r.supplierId,
      supplierName: r.supplierName,
      price: r.price,
      qualityScore,
      priceScore,
      totalScore,
      rank: null,
      reasons,
    };
  });

  const ranked = [...evaluated]
    .filter((e) => e.totalScore !== null)
    .sort((a, b) => (b.totalScore ?? 0) - (a.totalScore ?? 0) || a.supplierName.localeCompare(b.supplierName));
  ranked.forEach((row, index) => {
    row.rank = index + 1;
  });

  return {
    responses: evaluated.sort((a, b) => {
      if (a.rank === null && b.rank === null) return a.supplierName.localeCompare(b.supplierName);
      if (a.rank === null) return 1;
      if (b.rank === null) return -1;
      return a.rank - b.rank;
    }),
    lowestPrice,
    indicatedWinnerId: ranked[0]?.supplierId ?? null,
    warnings,
  };
}
