import { describe, expect, it } from "vitest";
import {
  assertDifferentActors,
  assessProgress,
  overclaimSeverity,
  scoreIndependence,
  SelfVerifiedProgressError,
  type ProgressInput,
} from "./progress.js";

const base: ProgressInput = {
  claimedPercent: 80,
  observedPercent: 78,
  method: "photo",
  claimantId: "usr_claimant",
  observerId: "usr_observer",
  attachmentCount: 2,
};

describe("the different-actor rule", () => {
  it("refuses an observation authored by the claimant", () => {
    expect(() => assertDifferentActors("usr_a", "usr_a")).toThrow(SelfVerifiedProgressError);
    expect(() => assessProgress({ ...base, observerId: base.claimantId })).toThrow(SelfVerifiedProgressError);
  });

  it("allows different actors", () => {
    expect(() => assertDifferentActors("usr_a", "usr_b")).not.toThrow();
  });

  it("does not trip on empty ids (the caller validates those)", () => {
    expect(() => assertDifferentActors("", "")).not.toThrow();
  });
});

describe("scoreIndependence", () => {
  it("ranks a scan above a visual walk", () => {
    const scan = scoreIndependence({ ...base, method: "scan", hasCaptureRecord: true });
    const visual = scoreIndependence({ ...base, method: "visual", attachmentCount: 0 });
    expect(scan.score).toBeGreaterThan(visual.score);
    expect(scan.score).toBeLessThanOrEqual(1);
  });

  it("penalises an observer employed by the claimant's company", () => {
    const same = scoreIndependence({ ...base, claimantVendorId: "v1", observerVendorId: "v1" });
    const different = scoreIndependence({ ...base, claimantVendorId: "v1", observerVendorId: "v2" });
    expect(different.score - same.score).toBeCloseTo(0.35, 2);
    expect(same.basis.some((b) => b.includes("same company"))).toBe(true);
  });

  it("penalises an observation with nothing attached", () => {
    const bare = scoreIndependence({ ...base, attachmentCount: 0 });
    expect(bare.basis.some((b) => b.includes("cannot be re-examined"))).toBe(true);
    expect(bare.score).toBeLessThan(scoreIndependence(base).score);
  });

  it("never scores outside 0..1", () => {
    const s = scoreIndependence({ ...base, method: "unheard_of", claimantVendorId: "v1", observerVendorId: "v1", attachmentCount: 0 });
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(1);
  });
});

describe("assessProgress", () => {
  it("supports a claim inside the tolerance", () => {
    const r = assessProgress(base);
    expect(r.result).toBe("supported");
    expect(r.variancePercent).toBe(2);
    expect(r.overclaim).toBe(false);
  });

  it("supports (and notes) an underclaim", () => {
    const r = assessProgress({ ...base, claimedPercent: 60, observedPercent: 75 });
    expect(r.result).toBe("supported");
    expect(r.variancePercent).toBe(-15);
    expect(r.reasons[0]).toContain("understated");
  });

  it("partially supports a modest overclaim", () => {
    const r = assessProgress({ ...base, claimedPercent: 80, observedPercent: 70 });
    expect(r.result).toBe("partially_supported");
    expect(r.overclaim).toBe(true);
  });

  it("calls a large overclaim unsupported", () => {
    const r = assessProgress({ ...base, claimedPercent: 90, observedPercent: 40 });
    expect(r.result).toBe("unsupported");
    expect(r.variancePercent).toBe(50);
  });

  it("calls a claim with nothing built contradicted", () => {
    const r = assessProgress({ ...base, claimedPercent: 60, observedPercent: 0 });
    expect(r.result).toBe("contradicted");
    expect(r.reasons[0]).toContain("nothing was observed");
  });

  it("returns insufficient_evidence when independence is too low to test anything", () => {
    const r = assessProgress({
      ...base,
      method: "visual",
      attachmentCount: 0,
      claimantVendorId: "v1",
      observerVendorId: "v1",
      claimedPercent: 90,
      observedPercent: 10,
    });
    expect(r.result).toBe("insufficient_evidence");
    expect(r.reasons[0]).toContain("below the 0.35");
  });

  it("honours a caller-supplied tolerance", () => {
    expect(assessProgress({ ...base, claimedPercent: 80, observedPercent: 72, tolerancePercent: 10 }).result).toBe("supported");
    expect(assessProgress({ ...base, claimedPercent: 80, observedPercent: 72, tolerancePercent: 1 }).result).toBe("unsupported");
  });

  it("clamps nonsense percentages instead of propagating them", () => {
    const r = assessProgress({ ...base, claimedPercent: 250, observedPercent: -30 });
    expect(r.variancePercent).toBe(100);
    expect(r.result).toBe("contradicted");
  });

  it("gives a confidence bounded by the independence score", () => {
    const r = assessProgress({ ...base, method: "scan", hasCaptureRecord: true });
    expect(r.confidence).toBeLessThanOrEqual(r.independenceScore);
    expect(r.confidence).toBeGreaterThan(0);
  });
});

describe("overclaimSeverity", () => {
  it("escalates with the size of the gap", () => {
    expect(overclaimSeverity(5)).toBe("low");
    expect(overclaimSeverity(12)).toBe("medium");
    expect(overclaimSeverity(25)).toBe("high");
    expect(overclaimSeverity(60)).toBe("critical");
  });
});
