/**
 * MATERIALS SUPPLY ENGINE — pure, no I/O (#719-720, #726-730; Domain U
 * #918-919).
 *
 * Three questions the register cannot answer by itself, and one scorecard:
 *
 *  1. WHEN SHOULD THIS HAVE BEEN ORDERED. required-on-site minus lead time,
 *     minus a procurement allowance. A long-lead item ordered the week it is
 *     needed is not late by one week — it is late by the lead time, and the
 *     day that becomes visible is the day it is already unrecoverable.
 *  2. WILL WE RUN OUT. required against (on hand + still to be delivered),
 *     inside the lead time, so the answer arrives while re-ordering is still
 *     an option.
 *  3. IS THE DELIVERY LATE, and what does it hold up.
 *  4. WHICH SUPPLIERS ACTUALLY PERFORM — on-time %, discrepancy rate,
 *     rejection rate, waiting time, invoice-match variance.
 *
 * Every figure is null-with-a-reason when its input is missing. An item with
 * no lead time has no order-by date; it does not have an order-by date of
 * today. An item with no required-on-site date is excluded from the shortage
 * forecast rather than assumed urgent.
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

const addDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Working days between raising a requisition and the order leaving. Not a
 * guess about the supplier — a guess about us, and it is stated so it can be
 * argued with.
 */
export const PROCUREMENT_ALLOWANCE_DAYS = 5;

/* ------------------------------------------------------------------ */
/* 1 + 2. Order-by dates and shortages                                 */
/* ------------------------------------------------------------------ */

export interface SupplyItemInput {
  id: string;
  reference: string;
  name: string;
  unit: string;
  status: string;
  leadTimeDays: number | null;
  requiredOnSiteDate: string | null;
  orderPlacedAt: string | null;
  scheduleActivityId: string | null;
  /** the activity's planned start, where the caller resolved one */
  activityStart?: string | null;
  activityName?: string | null;
  quantityRequired: number;
  quantityOrdered: number;
  quantityDelivered: number;
  quantityAccepted: number;
  quantityOnHand: number;
  quantityReserved: number;
  /** quantity on deliveries that are booked but not yet received */
  quantityInTransit: number;
  unitCost: number | null;
  currency: string;
}

export type SupplyRisk = "ok" | "order_now" | "order_by_date_missed" | "shortage" | "unknown";

export interface SupplyItemAssessment {
  id: string;
  reference: string;
  name: string;
  unit: string;
  /** required-on-site − lead time − procurement allowance */
  orderByDate: string | null;
  daysUntilOrderBy: number | null;
  /** required − (accepted + on hand not yet installed + in transit) */
  shortfall: number | null;
  /** the earliest date the item could now arrive if ordered today */
  earliestArrivalIfOrderedToday: string | null;
  risk: SupplyRisk;
  /** money exposed, null when no unit cost is held */
  exposure: number | null;
  currency: string;
  activityAtRisk: { id: string; name: string | null; start: string | null } | null;
  reasons: string[];
}

export function assessSupplyItem(
  item: SupplyItemInput,
  asOf: string,
): SupplyItemAssessment {
  const reasons: string[] = [];
  let orderByDate: string | null = null;

  if (item.requiredOnSiteDate === null) {
    reasons.push(
      "No required-on-site date is held for this item, so it has no order-by date. Link it to the " +
        "programme activity it feeds, or set the date directly.",
    );
  } else if (item.leadTimeDays === null) {
    reasons.push(
      `The item is needed on ${item.requiredOnSiteDate} but carries no lead time, so the date it ` +
        "had to be ordered by cannot be computed. A lead time of zero is a claim, not a default.",
    );
  } else {
    orderByDate = addDays(
      item.requiredOnSiteDate,
      -(item.leadTimeDays + PROCUREMENT_ALLOWANCE_DAYS),
    );
  }

  const daysUntilOrderBy = orderByDate ? daysBetween(asOf, orderByDate) : null;
  const ordered = item.quantityOrdered > 0 || item.orderPlacedAt !== null;

  /* covered = accepted on site + still to arrive on booked deliveries */
  const covered = round3(item.quantityAccepted + item.quantityInTransit);
  const shortfall =
    item.quantityRequired > 0 ? round3(Math.max(0, item.quantityRequired - covered)) : null;

  const earliestArrivalIfOrderedToday =
    item.leadTimeDays !== null ? addDays(asOf, item.leadTimeDays) : null;

  let risk: SupplyRisk = "ok";
  if (orderByDate === null) {
    risk = "unknown";
  } else if (!ordered && daysUntilOrderBy !== null && daysUntilOrderBy < 0) {
    risk = "order_by_date_missed";
    reasons.push(
      `This item had to be ordered by ${orderByDate} to be on site for ` +
        `${item.requiredOnSiteDate} (${item.leadTimeDays} day lead time plus ` +
        `${PROCUREMENT_ALLOWANCE_DAYS} days to place the order). It is ${-daysUntilOrderBy} day(s) ` +
        `past that and no order has been placed: ordered today it arrives ` +
        `${earliestArrivalIfOrderedToday}, which is ` +
        `${earliestArrivalIfOrderedToday && item.requiredOnSiteDate ? `${daysBetween(item.requiredOnSiteDate, earliestArrivalIfOrderedToday)} day(s) late` : "after it is needed"}.`,
    );
  } else if (!ordered && daysUntilOrderBy !== null && daysUntilOrderBy <= 7) {
    risk = "order_now";
    reasons.push(
      `The order-by date is ${orderByDate} — ${daysUntilOrderBy} day(s) away — and nothing has been ` +
        "ordered.",
    );
  } else if (
    shortfall !== null &&
    shortfall > 0 &&
    item.requiredOnSiteDate !== null &&
    earliestArrivalIfOrderedToday !== null &&
    earliestArrivalIfOrderedToday > item.requiredOnSiteDate
  ) {
    risk = "shortage";
    reasons.push(
      `${shortfall} ${item.unit} short of the ${item.quantityRequired} ${item.unit} required: ` +
        `${item.quantityAccepted} accepted on site and ${item.quantityInTransit} on booked ` +
        `deliveries. Re-ordering the shortfall today lands it ${earliestArrivalIfOrderedToday}, ` +
        `after the ${item.requiredOnSiteDate} it is needed.`,
    );
  } else if (shortfall !== null && shortfall > 0) {
    reasons.push(
      `${shortfall} ${item.unit} of the required quantity is neither on site nor on a booked ` +
        "delivery, but there is still lead time to cover it.",
    );
  }

  return {
    id: item.id,
    reference: item.reference,
    name: item.name,
    unit: item.unit,
    orderByDate,
    daysUntilOrderBy,
    shortfall,
    earliestArrivalIfOrderedToday,
    risk,
    exposure:
      item.unitCost !== null && shortfall !== null ? round2(shortfall * item.unitCost) : null,
    currency: item.currency,
    activityAtRisk: item.scheduleActivityId
      ? {
          id: item.scheduleActivityId,
          name: item.activityName ?? null,
          start: item.activityStart ?? null,
        }
      : null,
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* 3. Delayed shipments                                                */
/* ------------------------------------------------------------------ */

export interface DeliveryDelayInput {
  id: string;
  reference: string;
  status: string;
  scheduledFor: string | null;
  arrivedAt: string | null;
  receivedAt: string | null;
  supplierVendorId: string | null;
  itemIds: string[];
}

export interface DeliveryDelay {
  id: string;
  reference: string;
  scheduledFor: string;
  overdueDays: number;
  supplierVendorId: string | null;
  itemIds: string[];
  explanation: string;
}

/** Deliveries booked for a date that has passed and never arrived. */
export function detectDelayedDeliveries(
  deliveries: DeliveryDelayInput[],
  asOf: string,
): DeliveryDelay[] {
  const out: DeliveryDelay[] = [];
  for (const d of deliveries) {
    if (!d.scheduledFor) continue;
    if (d.arrivedAt || d.receivedAt) continue;
    if (!["scheduled", "in_transit"].includes(d.status)) continue;
    const scheduledDate = d.scheduledFor.slice(0, 10);
    const overdueDays = daysBetween(scheduledDate, asOf);
    if (overdueDays <= 0) continue;
    out.push({
      id: d.id,
      reference: d.reference,
      scheduledFor: scheduledDate,
      overdueDays,
      supplierVendorId: d.supplierVendorId,
      itemIds: d.itemIds,
      explanation:
        `Delivery ${d.reference} was booked for ${scheduledDate} and is still "${d.status}" ` +
        `${overdueDays} day(s) later, with no arrival recorded. Either it did not come and nobody ` +
        "chased it, or it came and nobody booked it in — and the second is how stock goes missing.",
    });
  }
  return out.sort((a, b) => b.overdueDays - a.overdueDays);
}

/* ------------------------------------------------------------------ */
/* 4. Supplier scorecard                                               */
/* ------------------------------------------------------------------ */

export interface SupplierDeliveryFact {
  vendorId: string;
  scheduledFor: string | null;
  receivedAt: string | null;
  hasDiscrepancy: boolean;
  waitingMinutes: number | null;
  quantityReceived: number;
  quantityRejected: number;
  invoiceMatched: boolean | null;
  /** |invoice − delivery value| where both are known and in one currency */
  invoiceVarianceAmount: number | null;
  currency: string;
}

export interface SupplierScore {
  vendorId: string;
  vendorName: string | null;
  deliveries: number;
  /** deliveries received on or before the booked day, as a % of those booked */
  onTimePercent: number | null;
  onTimeBasis: number;
  discrepancyPercent: number | null;
  rejectionPercent: number | null;
  averageWaitingMinutes: number | null;
  invoiceMatchPercent: number | null;
  invoiceVarianceByCurrency: Array<{ currency: string; amount: number }>;
  /** 0-100, higher is better; null when there is not enough to score */
  score: number | null;
  reasons: string[];
}

/**
 * Supplier performance from deliveries alone — no survey, no opinion.
 *
 * A supplier with fewer than `MIN_DELIVERIES_TO_SCORE` deliveries gets its
 * measured rates but no score: ranking a haulier on one delivery is how a
 * scorecard loses its credibility with the people it judges.
 */
export const MIN_DELIVERIES_TO_SCORE = 3;

export function scoreSuppliers(
  facts: SupplierDeliveryFact[],
  names: Map<string, string>,
): SupplierScore[] {
  const byVendor = new Map<string, SupplierDeliveryFact[]>();
  for (const f of facts) {
    const list = byVendor.get(f.vendorId) ?? [];
    list.push(f);
    byVendor.set(f.vendorId, list);
  }

  const out: SupplierScore[] = [];
  for (const [vendorId, rows] of byVendor) {
    const reasons: string[] = [];
    const booked = rows.filter((r) => r.scheduledFor !== null);
    const bookedAndReceived = booked.filter((r) => r.receivedAt !== null);
    const onTime = bookedAndReceived.filter(
      (r) => r.receivedAt!.slice(0, 10) <= r.scheduledFor!.slice(0, 10),
    );
    const onTimePercent =
      bookedAndReceived.length > 0
        ? round2((onTime.length / bookedAndReceived.length) * 100)
        : null;
    if (onTimePercent === null) {
      reasons.push(
        "No delivery from this supplier carries both a booked date and a receipt, so punctuality " +
          "cannot be measured.",
      );
    }

    const received = rows.filter((r) => r.receivedAt !== null);
    const discrepancyPercent =
      received.length > 0
        ? round2((received.filter((r) => r.hasDiscrepancy).length / received.length) * 100)
        : null;
    const totalReceived = round3(received.reduce((s, r) => s + r.quantityReceived, 0));
    const totalRejected = round3(received.reduce((s, r) => s + r.quantityRejected, 0));
    const rejectionPercent =
      totalReceived > 0 ? round2((totalRejected / totalReceived) * 100) : null;

    const waits = rows
      .map((r) => r.waitingMinutes)
      .filter((v): v is number => v !== null && v >= 0);
    const averageWaitingMinutes =
      waits.length > 0 ? Math.round(waits.reduce((s, v) => s + v, 0) / waits.length) : null;

    const matchable = rows.filter((r) => r.invoiceMatched !== null);
    const invoiceMatchPercent =
      matchable.length > 0
        ? round2((matchable.filter((r) => r.invoiceMatched).length / matchable.length) * 100)
        : null;

    const varianceMap = new Map<string, number>();
    for (const r of rows) {
      if (r.invoiceVarianceAmount === null) continue;
      varianceMap.set(
        r.currency,
        round2((varianceMap.get(r.currency) ?? 0) + Math.abs(r.invoiceVarianceAmount)),
      );
    }

    let score: number | null = null;
    if (rows.length >= MIN_DELIVERIES_TO_SCORE && onTimePercent !== null) {
      // 50 punctuality, 25 quality (discrepancy + rejection), 15 invoice
      // accuracy, 10 waiting time. Missing components drop out of the
      // denominator rather than scoring zero.
      let earned = 0;
      let available = 0;
      earned += (onTimePercent / 100) * 50;
      available += 50;
      if (discrepancyPercent !== null) {
        earned += (1 - Math.min(1, discrepancyPercent / 100)) * 15;
        available += 15;
      }
      if (rejectionPercent !== null) {
        earned += (1 - Math.min(1, rejectionPercent / 100)) * 10;
        available += 10;
      }
      if (invoiceMatchPercent !== null) {
        earned += (invoiceMatchPercent / 100) * 15;
        available += 15;
      }
      if (averageWaitingMinutes !== null) {
        earned += (1 - Math.min(1, averageWaitingMinutes / 120)) * 10;
        available += 10;
      }
      score = available > 0 ? round2((earned / available) * 100) : null;
    } else if (rows.length < MIN_DELIVERIES_TO_SCORE) {
      reasons.push(
        `${rows.length} delivery(ies) on record — fewer than the ${MIN_DELIVERIES_TO_SCORE} this ` +
          "platform will score a supplier on. The measured rates are shown; the score is not.",
      );
    }

    out.push({
      vendorId,
      vendorName: names.get(vendorId) ?? null,
      deliveries: rows.length,
      onTimePercent,
      onTimeBasis: bookedAndReceived.length,
      discrepancyPercent,
      rejectionPercent,
      averageWaitingMinutes,
      invoiceMatchPercent,
      invoiceVarianceByCurrency: [...varianceMap.entries()]
        .map(([currency, amount]) => ({ currency, amount }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
      score,
      reasons,
    });
  }

  return out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

/* ------------------------------------------------------------------ */
/* 5. Inventory valuation and waste                                    */
/* ------------------------------------------------------------------ */

export interface ValuationItem {
  id: string;
  reference: string;
  name: string;
  unit: string;
  quantityOnHand: number;
  quantityDelivered: number;
  quantityInstalled: number;
  quantityWasted: number;
  unitCost: number | null;
  currency: string;
}

export interface InventoryValuation {
  byCurrency: Array<{
    currency: string;
    onHandValue: number;
    wasteValue: number;
    items: number;
  }>;
  /** items with stock but no unit cost — the reason a total is not complete */
  unpricedItems: Array<{ id: string; reference: string; quantityOnHand: number }>;
  wasteRatePercent: number | null;
  totals: {
    itemsWithStock: number;
    quantityWasted: number;
    quantityDelivered: number;
  };
  reasons: string[];
}

/**
 * What the compound is holding, at cost, and how much of what was delivered
 * never became work. Money is bucketed by currency and never added across
 * them; an item with stock and no unit cost is listed rather than valued at
 * zero, because a zero silently understates the whole compound.
 */
export function valueInventory(items: ValuationItem[]): InventoryValuation {
  const buckets = new Map<string, { onHandValue: number; wasteValue: number; items: number }>();
  const unpriced: InventoryValuation["unpricedItems"] = [];
  let delivered = 0;
  let wasted = 0;
  let withStock = 0;

  for (const item of items) {
    delivered = round3(delivered + item.quantityDelivered);
    wasted = round3(wasted + item.quantityWasted);
    if (item.quantityOnHand > 0) withStock += 1;
    if (item.unitCost === null) {
      if (item.quantityOnHand > 0 || item.quantityWasted > 0) {
        unpriced.push({
          id: item.id,
          reference: item.reference,
          quantityOnHand: item.quantityOnHand,
        });
      }
      continue;
    }
    const b = buckets.get(item.currency) ?? { onHandValue: 0, wasteValue: 0, items: 0 };
    b.onHandValue = round2(b.onHandValue + item.quantityOnHand * item.unitCost);
    b.wasteValue = round2(b.wasteValue + item.quantityWasted * item.unitCost);
    b.items += 1;
    buckets.set(item.currency, b);
  }

  const reasons: string[] = [];
  if (unpriced.length > 0) {
    reasons.push(
      `${unpriced.length} item(s) hold stock or waste with no unit cost, so they are excluded from ` +
        "the valuation and listed instead. A compound valued with the unpriced lines silently set " +
        "to zero reads as complete and is not.",
    );
  }

  return {
    byCurrency: [...buckets.entries()]
      .map(([currency, v]) => ({ currency, ...v }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    unpricedItems: unpriced,
    wasteRatePercent: delivered > 0 ? round2((wasted / delivered) * 100) : null,
    totals: { itemsWithStock: withStock, quantityWasted: wasted, quantityDelivered: delivered },
    reasons,
  };
}
