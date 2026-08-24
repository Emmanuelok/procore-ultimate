import { describe, expect, it } from "vitest";
import { computeProlongation } from "./prolongation.js";

describe("computeProlongation (#299)", () => {
  it("uses an explicit rate when given", () => {
    const r = computeProlongation({ compensableDays: 10, prelimsRatePerDay: 512.345 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prelimsRatePerDay).toBe(512.35); // rounded to 2dp
    expect(r.amount).toBe(5123.45);
    expect(r.derivation).toContain("explicit");
  });

  it("derives the rate from prelims_time total over the programme duration", () => {
    const r = computeProlongation({
      compensableDays: 12,
      prelimsTimeTotal: 1500,
      scheduleDurationDays: 15,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prelimsRatePerDay).toBe(100);
    expect(r.amount).toBe(1200);
    expect(r.derivation).toContain("prelims_time");
  });

  it("fails cleanly when neither rate nor derivation inputs exist", () => {
    const noPrelims = computeProlongation({ compensableDays: 5 });
    expect(noPrelims.ok).toBe(false);
    if (!noPrelims.ok) expect(noPrelims.reason).toContain("prelims_time");

    const noDuration = computeProlongation({ compensableDays: 5, prelimsTimeTotal: 1000 });
    expect(noDuration.ok).toBe(false);
    if (!noDuration.ok) expect(noDuration.reason).toContain("duration");

    const negative = computeProlongation({ compensableDays: -1, prelimsRatePerDay: 100 });
    expect(negative.ok).toBe(false);
  });
});
