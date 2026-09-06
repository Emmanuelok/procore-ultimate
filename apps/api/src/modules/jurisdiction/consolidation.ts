/**
 * Multi-entity consolidation (#600-607) — IAS 21 translation with an IAS 29
 * hyperinflation hook. Pure: rates and amounts come in, a frozen statement
 * goes out.
 *
 * WHAT IS ACTUALLY HARD HERE
 *
 * A cross-border programme is delivered through a parent, local
 * subsidiaries, branches and JV vehicles. Three currencies are in play for
 * every one of them and conflating any two produces a plausible, wrong
 * number:
 *
 *   · the TRANSACTION currency (what the invoice was written in);
 *   · the FUNCTIONAL currency (IAS 21 para 9 — the currency of the primary
 *     economic environment the entity operates in, which is a fact about the
 *     entity, not a choice);
 *   · the PRESENTATION currency (what the group reports in).
 *
 * Translation from functional to presentation (IAS 21 paras 39-40) uses the
 * CLOSING rate for assets and liabilities and the AVERAGE rate for income and
 * expenses; the difference between them is the translation reserve, which is
 * recognised in other comprehensive income and never touches profit. This
 * engine reports the reserve explicitly rather than letting it disappear into
 * a rounding line, because "where did the FX difference go" is the first
 * question a group auditor asks.
 *
 * IAS 29 (hyperinflationary economies) is a HOOK, not a full implementation:
 * where an entity's functional currency is hyperinflationary, its amounts are
 * restated by the general price index (index at the closing date ÷ index at
 * the transaction date) BEFORE translation, and the restatement factor is
 * reported on the line. Where the index series is absent, the line is
 * reported as unpriced with the reason — never translated as though the
 * economy were stable, which would overstate the group by whatever the
 * inflation was.
 *
 * OWNERSHIP: an entity is included at its ownership percentage. A 60%-owned
 * subsidiary contributes 60% of its position to the group line here; full
 * consolidation with a non-controlling interest split is a general-ledger
 * concern this platform does not hold the data for, and pretending otherwise
 * would be worse than saying so.
 */

import type { ResolvedRate, RateLookup } from "./fx.js";
import { normalizeCurrency, resolveRate, round2, round8 } from "./fx.js";

export type TranslationMethodValue = "closing_rate" | "average_rate" | "historical_rate";

export interface ConsolidationEntity {
  id: string;
  name: string;
  role: string;
  country: string;
  functionalCurrency: string;
  ownershipPercent: number;
  hyperinflationary: boolean;
  /** [{ period, index }] general price index series for IAS 29 */
  priceIndex: readonly { period: string; index: number }[];
  /** the amount to consolidate, in the entity's FUNCTIONAL currency */
  amount: number;
  /** the period the amount was struck in, used for the IAS 29 restatement */
  amountPeriod?: string | null;
}

export interface ConsolidationLine {
  entityId: string;
  name: string;
  role: string;
  country: string;
  functionalCurrency: string;
  ownershipPercent: number;
  /** the entity's own figure, before ownership and before translation */
  functionalAmount: number;
  /** IAS 29 restatement factor applied, 1 when not hyperinflationary */
  restatementFactor: number;
  restatedFunctionalAmount: number;
  /** functional amount × ownership share */
  groupShareAmount: number;
  rate: number | null;
  ratePath: ResolvedRate["path"] | null;
  rateDate: string | null;
  rateSource: string | null;
  translatedAmount: number | null;
  notes: string[];
}

export interface UnpricedLine {
  entityId: string;
  name: string;
  functionalCurrency: string;
  reason: string;
}

export interface ConsolidationResult {
  presentationCurrency: string;
  method: TranslationMethodValue;
  asOf: string;
  lines: ConsolidationLine[];
  unpriced: UnpricedLine[];
  totals: {
    entities: number;
    translated: number;
    /** total in the presentation currency of the translatable entities only */
    presentationTotal: number;
    /** what those same entities would total if translated at the alternative
     *  rate basis — the difference IS the translation reserve exposure */
    alternativeBasisTotal: number | null;
    translationReserve: number | null;
    /** functional-currency subtotals, never summed across currencies */
    byFunctionalCurrency: { currency: string; entities: number; amount: number }[];
    ias29Entities: number;
  };
  note: string | null;
}

/**
 * The IAS 29 restatement factor: index at the closing date ÷ index at the
 * date the amount was struck. Returns null when the series cannot support
 * the calculation — which is a reason to report the line as unpriced, not to
 * silently use 1.
 */
export function restatementFactor(
  priceIndex: readonly { period: string; index: number }[],
  amountPeriod: string | null | undefined,
  asOf: string,
): { factor: number; basis: string } | null {
  if (priceIndex.length === 0) return null;
  const sorted = [...priceIndex].sort((a, b) => a.period.localeCompare(b.period));
  const closing = [...sorted].reverse().find((p) => p.period <= asOf) ?? sorted[sorted.length - 1]!;
  if (!amountPeriod) {
    return null;
  }
  const opening = [...sorted].reverse().find((p) => p.period <= amountPeriod);
  if (!opening || !(opening.index > 0) || !(closing.index > 0)) return null;
  const factor = round8(closing.index / opening.index);
  return {
    factor,
    basis:
      `IAS 29 restatement: general price index ${closing.index} at ${closing.period} ÷ ` +
      `${opening.index} at ${opening.period} = ${factor}.`,
  };
}

/**
 * Consolidate. `lookup` resolves functional → presentation at the run's
 * as-of date on the closing-rate basis; `alternativeLookup`, when supplied,
 * is the average-rate basis for the same period, and the difference between
 * the two totals is the translation reserve exposure.
 */
export function consolidate(args: {
  asOf: string;
  presentationCurrency: string;
  method: TranslationMethodValue;
  entities: readonly ConsolidationEntity[];
  lookup: RateLookup;
  alternativeLookup?: RateLookup | null;
}): ConsolidationResult {
  const presentation = normalizeCurrency(args.presentationCurrency);
  const lines: ConsolidationLine[] = [];
  const unpriced: UnpricedLine[] = [];
  const byFunctional = new Map<string, { currency: string; entities: number; amount: number }>();
  let presentationTotal = 0;
  let alternativeTotal = 0;
  let alternativeUsable = args.alternativeLookup != null;
  let ias29Entities = 0;

  for (const e of args.entities) {
    const functional = normalizeCurrency(e.functionalCurrency);
    const notes: string[] = [];
    const bucket = byFunctional.get(functional) ?? {
      currency: functional,
      entities: 0,
      amount: 0,
    };
    bucket.entities += 1;
    bucket.amount += e.amount;
    byFunctional.set(functional, bucket);

    let factor = 1;
    if (e.hyperinflationary) {
      ias29Entities += 1;
      const restated = restatementFactor(e.priceIndex, e.amountPeriod ?? null, args.asOf);
      if (!restated) {
        unpriced.push({
          entityId: e.id,
          name: e.name,
          functionalCurrency: functional,
          reason:
            `${e.name} reports in a hyperinflationary functional currency (${functional}) but ` +
            `carries no usable general price index for the period the amount was struck in. ` +
            `IAS 29 requires restatement before translation; translating it unrestated would ` +
            `overstate the group by the whole of the inflation, so the line is excluded and ` +
            `reported here instead.`,
        });
        continue;
      }
      factor = restated.factor;
      notes.push(restated.basis);
    }

    const restatedAmount = round2(e.amount * factor);
    const share = Math.max(0, Math.min(100, e.ownershipPercent)) / 100;
    const groupShare = round2(restatedAmount * share);
    if (share < 1) {
      notes.push(
        `Included at ${e.ownershipPercent}% ownership: ${restatedAmount} × ${share} = ${groupShare}.`,
      );
    }

    const rate = resolveRate(functional, presentation, args.lookup, presentation);
    if (!rate || !(rate.rate > 0)) {
      unpriced.push({
        entityId: e.id,
        name: e.name,
        functionalCurrency: functional,
        reason:
          `No ${functional}/${presentation} rate is on file on or before ${args.asOf}. The ` +
          `entity's position is stated in its functional currency and excluded from the ` +
          `presentation-currency total rather than converted at a guessed rate.`,
      });
      lines.push({
        entityId: e.id,
        name: e.name,
        role: e.role,
        country: e.country,
        functionalCurrency: functional,
        ownershipPercent: e.ownershipPercent,
        functionalAmount: round2(e.amount),
        restatementFactor: factor,
        restatedFunctionalAmount: restatedAmount,
        groupShareAmount: groupShare,
        rate: null,
        ratePath: null,
        rateDate: null,
        rateSource: null,
        translatedAmount: null,
        notes,
      });
      continue;
    }

    const translated = round2(groupShare * rate.rate);
    presentationTotal += translated;
    if (args.alternativeLookup) {
      const alt = resolveRate(functional, presentation, args.alternativeLookup, presentation);
      if (alt && alt.rate > 0) alternativeTotal += round2(groupShare * alt.rate);
      else alternativeUsable = false;
    }
    lines.push({
      entityId: e.id,
      name: e.name,
      role: e.role,
      country: e.country,
      functionalCurrency: functional,
      ownershipPercent: e.ownershipPercent,
      functionalAmount: round2(e.amount),
      restatementFactor: factor,
      restatedFunctionalAmount: restatedAmount,
      groupShareAmount: groupShare,
      rate: rate.rate,
      ratePath: rate.path,
      rateDate: rate.rateDate,
      rateSource: rate.legs[0]?.source ?? (rate.path === "identity" ? "identity" : null),
      translatedAmount: translated,
      notes,
    });
  }

  lines.sort((a, b) => (b.translatedAmount ?? -Infinity) - (a.translatedAmount ?? -Infinity));

  const translatedCount = lines.filter((l) => l.translatedAmount !== null).length;
  const notes: string[] = [];
  if (unpriced.length > 0) {
    notes.push(
      `${unpriced.length} entit${unpriced.length === 1 ? "y is" : "ies are"} excluded from the ` +
        `presentation-currency total; each reason is listed under "unpriced".`,
    );
  }
  if (ias29Entities > 0) {
    notes.push(
      `${ias29Entities} entit${ias29Entities === 1 ? "y reports" : "ies report"} in a ` +
        `hyperinflationary functional currency and ${ias29Entities === 1 ? "was" : "were"} ` +
        `restated under IAS 29 before translation.`,
    );
  }

  return {
    presentationCurrency: presentation,
    method: args.method,
    asOf: args.asOf,
    lines,
    unpriced,
    totals: {
      entities: args.entities.length,
      translated: translatedCount,
      presentationTotal: round2(presentationTotal),
      alternativeBasisTotal: alternativeUsable ? round2(alternativeTotal) : null,
      translationReserve: alternativeUsable
        ? round2(presentationTotal - alternativeTotal)
        : null,
      byFunctionalCurrency: [...byFunctional.values()]
        .map((b) => ({ ...b, amount: round2(b.amount) }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
      ias29Entities,
    },
    note: notes.length > 0 ? notes.join(" ") : null,
  };
}
