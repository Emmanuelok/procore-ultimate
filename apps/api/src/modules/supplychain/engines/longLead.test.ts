import { describe, expect, it } from "vitest";
import {
  assessLongLead,
  computeOrderByDate,
  isExpeditingStale,
  milestoneAllowed,
  statusAfterMilestone,
  type LongLeadInput,
} from "./longLead.js";
import { addDays, daysBetween, minutesBetween, parseIsoDate } from "./dates.js";

const base = (over: Partial<LongLeadInput> = {}): LongLeadInput => ({
  status: "identified",
  requiredOnSite: "2026-12-01",
  leadTimeDays: 60,
  bufferDays: 10,
  plannedOrderDate: null,
  actualOrderDate: null,
  plannedShipDate: null,
  actualShipDate: null,
  plannedArrivalDate: null,
  forecastArrivalDate: null,
  actualArrivalDate: null,
  customsRequired: false,
  customsClearedAt: null,
  lastExpeditedAt: null,
  ...over,
});

describe("dates", () => {
  it("does calendar arithmetic in UTC", () => {
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(daysBetween("2026-01-01", "2026-01-31")).toBe(30);
    expect(daysBetween(null, "2026-01-31")).toBeNull();
    expect(parseIsoDate("garbage")).toBeNull();
    expect(minutesBetween("2026-01-01T08:00:00Z", "2026-01-01T08:45:00Z")).toBe(45);
  });
});

describe("computeOrderByDate", () => {
  it("subtracts lead time and buffer from the need date", () => {
    expect(computeOrderByDate({ requiredOnSite: "2026-12-01", leadTimeDays: 60, bufferDays: 10 })).toBe(
      "2026-09-22",
    );
  });
  it("is null without a need date", () => {
    expect(computeOrderByDate({ requiredOnSite: null, leadTimeDays: 60, bufferDays: 10 })).toBeNull();
  });
});

describe("assessLongLead", () => {
  it("is not assessable without a required-on-site date and says why", () => {
    const r = assessLongLead(base({ requiredOnSite: null }), "2026-09-01");
    expect(r.riskLevel).toBe("not_assessable");
    expect(r.orderByDate).toBeNull();
    expect(r.reasons[0]).toMatch(/No required-on-site date/);
  });

  it("is on track when unordered with plenty of time", () => {
    const r = assessLongLead(base(), "2026-07-01");
    expect(r.riskLevel).toBe("on_track");
    expect(r.orderByDate).toBe("2026-09-22");
    expect(r.expectedOnSiteBasis).toBe("today_plus_lead");
    expect(r.floatDays).toBe(daysBetween("2026-08-30", "2026-12-01"));
  });

  it("watches then flags at risk as the order-by date approaches", () => {
    expect(assessLongLead(base(), "2026-08-25").riskLevel).toBe("watch");
    expect(assessLongLead(base(), "2026-09-15").riskLevel).toBe("at_risk");
  });

  it("is late once the order-by date has passed unordered", () => {
    const r = assessLongLead(base(), "2026-10-01");
    expect(r.riskLevel).toBe("late");
    expect(r.orderLatenessDays).toBe(9);
    expect(r.reasons.some((x) => /order-by date 2026-09-22 passed 9 day/.test(x))).toBe(true);
  });

  it("uses the supplier forecast over the plan and reports negative float", () => {
    const r = assessLongLead(
      base({
        status: "in_production",
        actualOrderDate: "2026-09-01",
        plannedArrivalDate: "2026-11-15",
        forecastArrivalDate: "2026-12-10",
      }),
      "2026-10-01",
    );
    expect(r.expectedOnSiteBasis).toBe("forecast");
    expect(r.floatDays).toBe(-9);
    expect(r.riskLevel).toBe("late");
    expect(r.reasons.some((x) => /slipped 25 day/.test(x))).toBe(true);
  });

  it("flags a missed planned ship date and an unchased order", () => {
    const r = assessLongLead(
      base({
        status: "in_production",
        actualOrderDate: "2026-09-01",
        plannedShipDate: "2026-10-20",
        plannedArrivalDate: "2026-11-20",
      }),
      "2026-11-01",
    );
    expect(r.riskLevel).toBe("at_risk");
    expect(r.reasons.some((x) => /Planned ship date 2026-10-20 passed 12 day/.test(x))).toBe(true);
    expect(r.reasons.some((x) => /No expediting contact/.test(x))).toBe(true);
  });

  it("amplifies watch to at_risk when the feeding task is critical", () => {
    const watch = base({ status: "ordered", actualOrderDate: "2026-09-01", plannedArrivalDate: "2026-11-25" });
    expect(assessLongLead(watch, "2026-10-01").riskLevel).toBe("watch");
    expect(assessLongLead({ ...watch, taskIsCritical: true }, "2026-10-01").riskLevel).toBe("at_risk");
  });

  /*
   * Regression: an item that is ON SITE cannot be "at risk of arriving late".
   * The float rule used to fire on a delivered item with two days between
   * arrival and need, which raised an at_risk signal and chased the owner
   * about something already in the compound.
   */
  it("stops assessing risk once the item has actually arrived", () => {
    const thinFloat = base({ status: "arrived", actualOrderDate: "2026-09-20", actualArrivalDate: "2026-11-29" });
    const r = assessLongLead(thinFloat, "2026-11-30");
    expect(r.riskLevel).toBe("on_track");
    expect(r.floatDays).toBe(2);
    expect(r.reasons[0]).toMatch(/Arrived 2026-11-29/);

    // an unchased, ship-date-missed item that has nonetheless landed is still on track
    const messyButLanded = base({
      status: "arrived",
      actualOrderDate: "2026-09-20",
      plannedShipDate: "2026-10-01",
      actualArrivalDate: "2026-11-30",
      lastExpeditedAt: null,
    });
    expect(assessLongLead(messyButLanded, "2026-11-30").riskLevel).toBe("on_track");
  });

  it("still calls an item that arrived after it was needed late", () => {
    const r = assessLongLead(base({ status: "arrived", actualOrderDate: "2026-09-20", actualArrivalDate: "2026-12-09" }), "2026-12-10");
    expect(r.riskLevel).toBe("late");
    expect(r.floatDays).toBe(-8);
    expect(r.reasons[0]).toMatch(/Arrived 8 day\(s\) after the required-on-site date/);
  });

  it("closes cleanly once installed", () => {
    const r = assessLongLead(base({ status: "installed", actualArrivalDate: "2026-11-01" }), "2027-01-01");
    expect(r.riskLevel).toBe("on_track");
    expect(r.floatDays).toBeNull();
  });
});

describe("milestones", () => {
  it("maps milestones to statuses", () => {
    expect(statusAfterMilestone("ordered")).toBe("ordered");
    expect(statusAfterMilestone("customs_cleared")).toBe("in_customs");
    expect(statusAfterMilestone("nonsense")).toBeNull();
  });
  it("refuses skipped and backward steps but allows the optional customs step", () => {
    expect(milestoneAllowed("identified", "ordered").ok).toBe(true);
    expect(milestoneAllowed("ordered", "shipped").ok).toBe(false);
    expect(milestoneAllowed("shipped", "arrived").ok).toBe(true);
    expect(milestoneAllowed("arrived", "shipped").ok).toBe(false);
    expect(milestoneAllowed("cancelled", "ordered").ok).toBe(false);
  });
});

describe("isExpeditingStale", () => {
  it("counts ordered, unarrived, unchased items", () => {
    expect(isExpeditingStale({ status: "ordered", lastExpeditedAt: null, actualArrivalDate: null }, "2026-09-01")).toBe(true);
    expect(
      isExpeditingStale({ status: "ordered", lastExpeditedAt: "2026-08-25T00:00:00Z", actualArrivalDate: null }, "2026-09-01"),
    ).toBe(false);
    expect(
      isExpeditingStale({ status: "ordered", lastExpeditedAt: "2026-07-01T00:00:00Z", actualArrivalDate: null }, "2026-09-01"),
    ).toBe(true);
    expect(isExpeditingStale({ status: "identified", lastExpeditedAt: null, actualArrivalDate: null }, "2026-09-01")).toBe(false);
    expect(isExpeditingStale({ status: "arrived", lastExpeditedAt: null, actualArrivalDate: "2026-08-01" }, "2026-09-01")).toBe(false);
  });
});
