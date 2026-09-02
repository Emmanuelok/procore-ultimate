/**
 * ESTIMATE VERSION COMPARISON — spec Vol I §1.2 (#200–201).
 *
 * A diff between two estimate versions that answers the only question a
 * reviewer ever asks: WHY is version 3 £412k more than version 2? The answer
 * has to separate the three causes, because they have different owners:
 *
 *   quantity  the design grew            → the designer
 *   rate      the price moved            → the market, or the estimator
 *   scope     lines appeared/disappeared → whoever changed the scope
 *
 * Lines are paired on `lineageId` when both versions descend from the same
 * ancestor (the normal case — cutting a version copies the lineage), and
 * otherwise on a normalised natural key of cost code + cost type +
 * description, so a comparison between two unrelated estimates still works
 * and says which pairing it used.
 *
 * Pure; no database.
 */
import { round2, round4 } from "./pricing.js";

export interface ComparableLine {
  id: string;
  lineageId?: string | null;
  itemCode?: string | null;
  description: string;
  costCode?: string | null;
  costType: string;
  unit?: string | null;
  quantity: number;
  unitRate: number;
  amount: number;
  status: string;
  sectionId?: string | null;
  sectionName?: string | null;
}

export type ComparisonChange =
  | "added"
  | "removed"
  | "quantity"
  | "rate"
  | "quantity_and_rate"
  | "scope"
  | "unchanged";

export interface ComparisonRow {
  key: string;
  matchedOn: "lineage" | "natural_key" | "none";
  description: string;
  costCode: string | null;
  costType: string;
  unit: string | null;
  change: ComparisonChange;
  before: { id: string; quantity: number; unitRate: number; amount: number; status: string } | null;
  after: { id: string; quantity: number; unitRate: number; amount: number; status: string } | null;
  quantityDelta: number;
  rateDelta: number;
  amountDelta: number;
  /** the amount delta attributable to the quantity move, at the OLD rate */
  quantityEffect: number;
  /** the amount delta attributable to the rate move, at the NEW quantity */
  rateEffect: number;
}

export interface ComparisonTotals {
  beforeDirectCost: number;
  afterDirectCost: number;
  directCostDelta: number;
  beforeMarkupTotal: number;
  afterMarkupTotal: number;
  markupDelta: number;
  beforeTotal: number;
  afterTotal: number;
  totalDelta: number;
  /** the direct-cost delta decomposed; the three sum to directCostDelta */
  addedTotal: number;
  removedTotal: number;
  quantityEffectTotal: number;
  rateEffectTotal: number;
}

export interface ComparisonResult {
  rows: ComparisonRow[];
  totals: ComparisonTotals;
  byCostType: Array<{ costType: string; before: number; after: number; delta: number }>;
  counts: Record<ComparisonChange, number>;
  warnings: string[];
}

const TOL = 0.005;

/** A stable natural key when there is no shared lineage to pair on. */
export function naturalKey(line: ComparableLine): string {
  const desc = line.description.trim().toLowerCase().replace(/\s+/g, " ");
  return [line.costCode ?? "", line.costType ?? "", line.itemCode ?? "", desc].join("|");
}

function isCounted(status: string): boolean {
  return status === "active" || status === "provisional";
}

function snapshot(line: ComparableLine) {
  return {
    id: line.id,
    quantity: round4(line.quantity),
    unitRate: round4(line.unitRate),
    amount: round2(line.amount),
    status: line.status,
  };
}

/**
 * Compare two line sets. `beforeMarkupTotal`/`afterMarkupTotal` are supplied
 * by the caller (markups are compared as a block, not line by line — a
 * markup diff belongs next to the cascade, not inside the grid).
 */
export function compareEstimates(a: {
  before: readonly ComparableLine[];
  after: readonly ComparableLine[];
  beforeMarkupTotal?: number;
  afterMarkupTotal?: number;
  /** include rows that did not move; off by default because they are noise */
  includeUnchanged?: boolean;
}): ComparisonResult {
  const warnings: string[] = [];

  const beforeByLineage = new Map<string, ComparableLine>();
  const afterByLineage = new Map<string, ComparableLine>();
  for (const l of a.before) {
    if (l.lineageId) {
      if (beforeByLineage.has(l.lineageId)) {
        warnings.push(
          `The earlier version has more than one line on lineage ${l.lineageId}; only the first was paired.`,
        );
      } else beforeByLineage.set(l.lineageId, l);
    }
  }
  for (const l of a.after) {
    if (l.lineageId) {
      if (afterByLineage.has(l.lineageId)) {
        warnings.push(
          `The later version has more than one line on lineage ${l.lineageId}; only the first was paired.`,
        );
      } else afterByLineage.set(l.lineageId, l);
    }
  }

  const usedBefore = new Set<string>();
  const usedAfter = new Set<string>();
  const rows: ComparisonRow[] = [];

  const emit = (
    key: string,
    matchedOn: ComparisonRow["matchedOn"],
    before: ComparableLine | null,
    after: ComparableLine | null,
  ) => {
    const beforeCounted = before !== null && isCounted(before.status);
    const afterCounted = after !== null && isCounted(after.status);
    const bQty = beforeCounted && before ? before.quantity : 0;
    const aQty = afterCounted && after ? after.quantity : 0;
    const bRate = before ? before.unitRate : 0;
    const aRate = after ? after.unitRate : 0;
    const bAmt = beforeCounted && before ? before.amount : 0;
    const aAmt = afterCounted && after ? after.amount : 0;

    let change: ComparisonChange;
    if (before === null) change = "added";
    else if (after === null) change = "removed";
    else if (beforeCounted !== afterCounted) change = "scope";
    else {
      const qtyMoved = Math.abs(aQty - bQty) > TOL;
      const rateMoved = Math.abs(aRate - bRate) > TOL;
      change = qtyMoved && rateMoved
        ? "quantity_and_rate"
        : qtyMoved
          ? "quantity"
          : rateMoved
            ? "rate"
            : Math.abs(aAmt - bAmt) > TOL
              ? "scope"
              : "unchanged";
    }

    // Decomposition: quantity effect at the OLD rate, rate effect at the NEW
    // quantity. The two plus added/removed reconcile exactly to the total.
    const quantityEffect =
      before && after ? round2((aQty - bQty) * bRate) : 0;
    const rateEffect = before && after ? round2((aRate - bRate) * aQty) : 0;

    rows.push({
      key,
      matchedOn,
      description: (after ?? before)?.description ?? "",
      costCode: (after ?? before)?.costCode ?? null,
      costType: (after ?? before)?.costType ?? "other",
      unit: (after ?? before)?.unit ?? null,
      change,
      before: before ? snapshot(before) : null,
      after: after ? snapshot(after) : null,
      quantityDelta: round4(aQty - bQty),
      rateDelta: round4(aRate - bRate),
      amountDelta: round2(aAmt - bAmt),
      quantityEffect,
      rateEffect,
    });
  };

  /* 1. lineage pairs */
  for (const [lineage, beforeLine] of beforeByLineage) {
    const afterLine = afterByLineage.get(lineage);
    if (!afterLine) continue;
    usedBefore.add(beforeLine.id);
    usedAfter.add(afterLine.id);
    emit(lineage, "lineage", beforeLine, afterLine);
  }

  /* 2. natural-key pairs among what is left */
  const leftoverAfter = new Map<string, ComparableLine[]>();
  for (const l of a.after) {
    if (usedAfter.has(l.id)) continue;
    const k = naturalKey(l);
    const bucket = leftoverAfter.get(k);
    if (bucket) bucket.push(l);
    else leftoverAfter.set(k, [l]);
  }
  for (const beforeLine of a.before) {
    if (usedBefore.has(beforeLine.id)) continue;
    const k = naturalKey(beforeLine);
    const bucket = leftoverAfter.get(k);
    const afterLine = bucket?.shift();
    if (!afterLine) continue;
    usedBefore.add(beforeLine.id);
    usedAfter.add(afterLine.id);
    emit(k, "natural_key", beforeLine, afterLine);
  }

  /* 3. what is genuinely gone, and what is genuinely new */
  for (const beforeLine of a.before) {
    if (usedBefore.has(beforeLine.id)) continue;
    emit(naturalKey(beforeLine), "none", beforeLine, null);
  }
  for (const afterLine of a.after) {
    if (usedAfter.has(afterLine.id)) continue;
    emit(naturalKey(afterLine), "none", null, afterLine);
  }

  const counts: Record<ComparisonChange, number> = {
    added: 0,
    removed: 0,
    quantity: 0,
    rate: 0,
    quantity_and_rate: 0,
    scope: 0,
    unchanged: 0,
  };
  for (const r of rows) counts[r.change] += 1;

  const sum = (list: readonly ComparableLine[]): number =>
    round2(list.reduce((acc, l) => acc + (isCounted(l.status) ? l.amount : 0), 0));
  const beforeDirectCost = sum(a.before);
  const afterDirectCost = sum(a.after);
  const beforeMarkupTotal = round2(a.beforeMarkupTotal ?? 0);
  const afterMarkupTotal = round2(a.afterMarkupTotal ?? 0);

  const addedTotal = round2(
    rows.filter((r) => r.change === "added").reduce((acc, r) => acc + (r.after?.amount ?? 0), 0),
  );
  const removedTotal = round2(
    rows.filter((r) => r.change === "removed").reduce((acc, r) => acc - (r.before?.amount ?? 0), 0),
  );
  const pairedDelta = round2(
    rows
      .filter((r) => r.before !== null && r.after !== null)
      .reduce((acc, r) => acc + r.amountDelta, 0),
  );
  const quantityEffectTotal = round2(rows.reduce((acc, r) => acc + r.quantityEffect, 0));
  // Anything the quantity/rate decomposition does not explain (rounding, a
  // status flip) is folded into the rate effect so the three ALWAYS reconcile
  // to the paired delta rather than nearly reconciling.
  const rateEffectTotal = round2(pairedDelta - quantityEffectTotal);

  const costTypes = new Set<string>();
  for (const l of a.before) costTypes.add(l.costType || "other");
  for (const l of a.after) costTypes.add(l.costType || "other");
  const byCostType = [...costTypes].sort().map((ct) => {
    const before = round2(
      a.before.filter((l) => (l.costType || "other") === ct && isCounted(l.status)).reduce((s, l) => s + l.amount, 0),
    );
    const after = round2(
      a.after.filter((l) => (l.costType || "other") === ct && isCounted(l.status)).reduce((s, l) => s + l.amount, 0),
    );
    return { costType: ct, before, after, delta: round2(after - before) };
  });

  const visible = a.includeUnchanged ? rows : rows.filter((r) => r.change !== "unchanged");
  visible.sort((x, y) => Math.abs(y.amountDelta) - Math.abs(x.amountDelta));

  return {
    rows: visible,
    totals: {
      beforeDirectCost,
      afterDirectCost,
      directCostDelta: round2(afterDirectCost - beforeDirectCost),
      beforeMarkupTotal,
      afterMarkupTotal,
      markupDelta: round2(afterMarkupTotal - beforeMarkupTotal),
      beforeTotal: round2(beforeDirectCost + beforeMarkupTotal),
      afterTotal: round2(afterDirectCost + afterMarkupTotal),
      totalDelta: round2(
        afterDirectCost + afterMarkupTotal - (beforeDirectCost + beforeMarkupTotal),
      ),
      addedTotal,
      removedTotal,
      quantityEffectTotal,
      rateEffectTotal,
    },
    byCostType,
    counts,
    warnings,
  };
}
