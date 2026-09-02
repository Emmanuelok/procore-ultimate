import { describe, expect, it } from "vitest";
import {
  costOfQuality,
  firstTimeRightByTrade,
  type ChecklistOutcomeLike,
  type ReworkLike,
} from "./costOfQuality.js";

const rework = (over: Partial<ReworkLike> & { id: string }): ReworkLike => ({
  totalCost: null,
  currency: "USD",
  causeCategory: "workmanship",
  discoveryPhase: "at_inspection",
  status: "complete",
  trade: null,
  responsibleVendorId: null,
  labourHours: null,
  ...over,
});

const activity = {
  approvedItps: 3,
  approvedTemplates: 5,
  trainingSessions: 1,
  completedChecklists: 20,
  commissioningTests: 4,
  ndtExaminations: 6,
  concreteSpecimens: 12,
  qualityAudits: 2,
};

describe("costOfQuality", () => {
  it("counts prevention and appraisal without inventing a cost for them", () => {
    const out = costOfQuality({ rework: [], ncrs: [], dlpDefects: [], activity });
    const prevention = out.buckets.find((b) => b.bucket === "prevention")!;
    const appraisal = out.buckets.find((b) => b.bucket === "appraisal")!;
    expect(prevention.money).toEqual([]);
    expect(prevention.activityCount).toBe(9);
    expect(appraisal.activityCount).toBe(44);
    expect(prevention.reasons.join(" ")).toContain("flattering and false");
  });

  it("splits failure by where it was caught", () => {
    const out = costOfQuality({
      rework: [
        rework({ id: "r1", totalCost: 1000, discoveryPhase: "at_inspection" }),
        rework({ id: "r2", totalCost: 4000, discoveryPhase: "post_handover" }),
      ],
      ncrs: [],
      dlpDefects: [],
      activity,
    });
    const internal = out.buckets.find((b) => b.bucket === "internal_failure")!;
    const external = out.buckets.find((b) => b.bucket === "external_failure")!;
    expect(internal.money).toEqual([{ currency: "USD", amount: 1000, recordCount: 1 }]);
    expect(external.money).toEqual([{ currency: "USD", amount: 4000, recordCount: 1 }]);
    expect(out.failureByCurrency[0]).toEqual({
      currency: "USD",
      internal: 1000,
      external: 4000,
      total: 5000,
      externalShare: 80,
    });
  });

  it("never sums across currencies and says why", () => {
    const out = costOfQuality({
      rework: [
        rework({ id: "r1", totalCost: 1000, currency: "USD" }),
        rework({ id: "r2", totalCost: 800, currency: "GBP" }),
      ],
      ncrs: [],
      dlpDefects: [],
      activity,
    });
    const internal = out.buckets.find((b) => b.bucket === "internal_failure")!;
    expect(internal.money).toHaveLength(2);
    expect(internal.reasons.join(" ")).toContain("cross-currency total would be a made-up number");
    expect(out.failureByCurrency.map((f) => f.currency)).toEqual(["GBP", "USD"]);
  });

  it("reports an uncosted bucket as unmeasured rather than zero", () => {
    const out = costOfQuality({
      rework: [rework({ id: "r1", totalCost: null })],
      ncrs: [],
      dlpDefects: [],
      activity,
    });
    const internal = out.buckets.find((b) => b.bucket === "internal_failure")!;
    expect(internal.money).toEqual([]);
    expect(internal.reasons.join(" ")).toContain("unmeasured — not zero");
  });

  it("flags a partially costed bucket as a floor", () => {
    const out = costOfQuality({
      rework: [rework({ id: "r1", totalCost: 500 }), rework({ id: "r2", totalCost: null })],
      ncrs: [],
      dlpDefects: [],
      activity,
    });
    const internal = out.buckets.find((b) => b.bucket === "internal_failure")!;
    expect(internal.reasons.join(" ")).toContain("floor rather than the figure");
  });

  it("excludes cancelled rework and voided NCRs", () => {
    const out = costOfQuality({
      rework: [rework({ id: "r1", totalCost: 900, status: "cancelled" })],
      ncrs: [{ id: "n1", costImpact: 700, currency: "USD", status: "void" }],
      dlpDefects: [],
      activity,
    });
    expect(out.failureByCurrency).toHaveLength(0);
    expect(out.reasons.join(" ")).toContain("No failure cost is recorded");
  });

  it("counts liability-period defects as external failure", () => {
    const out = costOfQuality({
      rework: [],
      ncrs: [],
      dlpDefects: [{ id: "d1", cost: 250, currency: "EUR" }],
      activity,
    });
    const external = out.buckets.find((b) => b.bucket === "external_failure")!;
    expect(external.money).toEqual([{ currency: "EUR", amount: 250, recordCount: 1 }]);
  });
});

describe("firstTimeRightByTrade", () => {
  const checklist = (
    over: Partial<ChecklistOutcomeLike> & { id: string },
  ): ChecklistOutcomeLike => ({
    result: "pass",
    failedItemCount: 0,
    criticalFailureCount: 0,
    vendorId: null,
    category: "quality",
    ...over,
  });

  it("counts a pass with a failed item as NOT first-time right", () => {
    const { overall } = firstTimeRightByTrade([
      checklist({ id: "c1", result: "pass_with_observations", failedItemCount: 1 }),
      checklist({ id: "c2" }),
    ]);
    expect(overall.judged).toBe(2);
    expect(overall.right).toBe(1);
    expect(overall.rate).toBe(50);
  });

  it("groups by vendor and resolves a label", () => {
    const { rows } = firstTimeRightByTrade(
      [
        checklist({ id: "c1", vendorId: "v1" }),
        checklist({ id: "c2", vendorId: "v1", result: "fail", failedItemCount: 2 }),
        checklist({ id: "c3", vendorId: "v2" }),
      ],
      new Map([
        ["v1", "Concrete Sub Ltd"],
        ["v2", "M&E Sub Ltd"],
      ]),
    );
    expect(rows[0]!.label).toBe("Concrete Sub Ltd");
    expect(rows[0]!.rate).toBe(50);
    expect(rows[1]!.label).toBe("M&E Sub Ltd");
    expect(rows[1]!.rate).toBe(100);
  });

  it("prefers an explicit trade on the record over the vendor", () => {
    const { rows } = firstTimeRightByTrade([
      checklist({ id: "c1", vendorId: "v1", detail: { trade: "Steelwork" } }),
    ]);
    expect(rows[0]!.key).toBe("Steelwork");
  });

  it("ignores checklists with no result at all", () => {
    const { overall } = firstTimeRightByTrade([checklist({ id: "c1", result: null })]);
    expect(overall.judged).toBe(0);
    expect(overall.rate).toBeNull();
    expect(overall.reasons.join(" ")).toContain("unmeasured rather than perfect");
  });

  it("warns that a small sample is not a trend", () => {
    const { overall } = firstTimeRightByTrade([checklist({ id: "c1" })]);
    expect(overall.reasons.join(" ")).toContain("should not be read as a trend");
  });

  it("labels unattributed records honestly", () => {
    const { rows } = firstTimeRightByTrade([checklist({ id: "c1" })]);
    expect(rows[0]!.label).toContain("Unattributed");
  });
});
