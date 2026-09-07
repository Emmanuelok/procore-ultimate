import { describe, expect, it } from "vitest";
import {
  assessSupplyItem,
  detectDelayedDeliveries,
  scoreSuppliers,
  valueInventory,
  type SupplierDeliveryFact,
  type SupplyItemInput,
} from "./materials.js";

const item = (over: Partial<SupplyItemInput> = {}): SupplyItemInput => ({
  id: "mat_1",
  reference: "MAT-0001",
  name: "Structural steel — primary frame",
  unit: "t",
  status: "planned",
  leadTimeDays: 60,
  requiredOnSiteDate: "2026-06-01",
  orderPlacedAt: null,
  scheduleActivityId: "act_1",
  activityStart: "2026-06-03",
  activityName: "Steel erection",
  quantityRequired: 100,
  quantityOrdered: 0,
  quantityDelivered: 0,
  quantityAccepted: 0,
  quantityOnHand: 0,
  quantityReserved: 0,
  quantityInTransit: 0,
  unitCost: 900,
  currency: "GBP",
  ...over,
});

describe("assessSupplyItem", () => {
  it("computes the order-by date from lead time plus the procurement allowance", () => {
    const out = assessSupplyItem(item(), "2026-01-01");
    expect(out.orderByDate).toBe("2026-03-28");
    expect(out.risk).toBe("ok");
  });

  it("refuses an order-by date when no lead time is held", () => {
    const out = assessSupplyItem(item({ leadTimeDays: null }), "2026-01-01");
    expect(out.orderByDate).toBeNull();
    expect(out.risk).toBe("unknown");
    expect(out.reasons.join(" ")).toContain("lead time of zero is a claim");
  });

  it("raises the missed order-by date with the lateness that follows from it", () => {
    const out = assessSupplyItem(item(), "2026-04-15");
    expect(out.risk).toBe("order_by_date_missed");
    expect(out.earliestArrivalIfOrderedToday).toBe("2026-06-14");
    expect(out.reasons.join(" ")).toContain("13 day(s) late");
    expect(out.exposure).toBe(90000);
  });

  it("says nothing about an item already ordered", () => {
    const out = assessSupplyItem(
      item({ orderPlacedAt: "2026-03-01", quantityOrdered: 100, quantityInTransit: 100 }),
      "2026-04-15",
    );
    expect(out.risk).toBe("ok");
    expect(out.shortfall).toBe(0);
  });

  it("forecasts a shortage that lead time can no longer cover", () => {
    const out = assessSupplyItem(
      item({
        orderPlacedAt: "2026-03-01",
        quantityOrdered: 60,
        quantityAccepted: 60,
        quantityInTransit: 0,
      }),
      "2026-05-01",
    );
    expect(out.risk).toBe("shortage");
    expect(out.shortfall).toBe(40);
    expect(out.exposure).toBe(36000);
  });

  it("warns before the order-by date rather than only after it", () => {
    const out = assessSupplyItem(item(), "2026-03-25");
    expect(out.risk).toBe("order_now");
    expect(out.daysUntilOrderBy).toBe(3);
  });
});

describe("detectDelayedDeliveries", () => {
  it("finds a booked delivery that never arrived", () => {
    const out = detectDelayedDeliveries(
      [
        {
          id: "del_1",
          reference: "DEL-001",
          status: "scheduled",
          scheduledFor: "2026-03-01T08:00:00.000Z",
          arrivedAt: null,
          receivedAt: null,
          supplierVendorId: "ven_1",
          itemIds: ["mat_1"],
        },
      ],
      "2026-03-05",
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.overdueDays).toBe(4);
  });

  it("ignores a delivery that arrived, and one still in the future", () => {
    const out = detectDelayedDeliveries(
      [
        {
          id: "del_1",
          reference: "DEL-001",
          status: "received",
          scheduledFor: "2026-03-01T08:00:00.000Z",
          arrivedAt: "2026-03-01T09:00:00.000Z",
          receivedAt: "2026-03-01T10:00:00.000Z",
          supplierVendorId: "ven_1",
          itemIds: [],
        },
        {
          id: "del_2",
          reference: "DEL-002",
          status: "scheduled",
          scheduledFor: "2026-03-20T08:00:00.000Z",
          arrivedAt: null,
          receivedAt: null,
          supplierVendorId: "ven_1",
          itemIds: [],
        },
      ],
      "2026-03-05",
    );
    expect(out).toHaveLength(0);
  });
});

describe("scoreSuppliers", () => {
  const fact = (over: Partial<SupplierDeliveryFact> = {}): SupplierDeliveryFact => ({
    vendorId: "ven_1",
    scheduledFor: "2026-03-01T08:00:00.000Z",
    receivedAt: "2026-03-01T09:00:00.000Z",
    hasDiscrepancy: false,
    waitingMinutes: 20,
    quantityReceived: 100,
    quantityRejected: 0,
    invoiceMatched: true,
    invoiceVarianceAmount: 0,
    currency: "GBP",
    ...over,
  });

  it("scores punctuality, quality, invoice accuracy and waiting time", () => {
    const out = scoreSuppliers([fact(), fact(), fact()], new Map([["ven_1", "Steel Co"]]));
    expect(out[0]!.onTimePercent).toBe(100);
    expect(out[0]!.score).toBeGreaterThan(90);
    expect(out[0]!.vendorName).toBe("Steel Co");
  });

  it("refuses to score a supplier on too few deliveries but still measures it", () => {
    const out = scoreSuppliers([fact()], new Map());
    expect(out[0]!.score).toBeNull();
    expect(out[0]!.onTimePercent).toBe(100);
    expect(out[0]!.reasons.join(" ")).toContain("fewer than the 3");
  });

  it("marks a late delivery late and drops the score", () => {
    const late = fact({ receivedAt: "2026-03-05T09:00:00.000Z", hasDiscrepancy: true, quantityRejected: 20 });
    const out = scoreSuppliers([late, late, late], new Map());
    expect(out[0]!.onTimePercent).toBe(0);
    expect(out[0]!.discrepancyPercent).toBe(100);
    expect(out[0]!.rejectionPercent).toBe(20);
    expect(out[0]!.score).toBeLessThan(40);
  });

  it("buckets invoice variance by currency", () => {
    const out = scoreSuppliers(
      [
        fact({ invoiceVarianceAmount: 100, currency: "GBP" }),
        fact({ invoiceVarianceAmount: -50, currency: "GBP" }),
        fact({ invoiceVarianceAmount: 25, currency: "EUR" }),
      ],
      new Map(),
    );
    expect(out[0]!.invoiceVarianceByCurrency).toEqual([
      { currency: "EUR", amount: 25 },
      { currency: "GBP", amount: 150 },
    ]);
  });
});

describe("valueInventory", () => {
  it("buckets value by currency and never values an unpriced item at zero", () => {
    const out = valueInventory([
      {
        id: "a",
        reference: "MAT-1",
        name: "Rebar",
        unit: "t",
        quantityOnHand: 10,
        quantityDelivered: 100,
        quantityInstalled: 80,
        quantityWasted: 5,
        unitCost: 800,
        currency: "GBP",
      },
      {
        id: "b",
        reference: "MAT-2",
        name: "Blocks",
        unit: "no",
        quantityOnHand: 500,
        quantityDelivered: 1000,
        quantityInstalled: 400,
        quantityWasted: 0,
        unitCost: null,
        currency: "GBP",
      },
    ]);
    expect(out.byCurrency).toEqual([
      { currency: "GBP", onHandValue: 8000, wasteValue: 4000, items: 1 },
    ]);
    expect(out.unpricedItems.map((i) => i.reference)).toEqual(["MAT-2"]);
    expect(out.wasteRatePercent).toBe(0.45);
    expect(out.reasons.join(" ")).toContain("reads as complete and is not");
  });
});
