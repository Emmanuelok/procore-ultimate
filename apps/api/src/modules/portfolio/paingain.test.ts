import { describe, expect, it } from "vitest";
import {
  PainGainError,
  computePainGain,
  parseParticipants,
  parseShareBands,
  validateShareBands,
  type PainGainInput,
  type ShareBand,
} from "./paingain.js";

/** A conventional NEC-style stepped share, gain side negative. */
const bands: ShareBand[] = [
  { fromPercent: -100, toPercent: -5, contractorSharePercent: 30 },
  { fromPercent: -5, toPercent: 0, contractorSharePercent: 50 },
  { fromPercent: 0, toPercent: 5, contractorSharePercent: 50 },
  { fromPercent: 5, toPercent: null, contractorSharePercent: 20 },
];

const base = (over: Partial<PainGainInput> = {}): PainGainInput => ({
  currency: "GBP",
  baseTargetCost: 1_000_000,
  targetAdjustments: 0,
  outturnCost: 1_000_000,
  feePercent: 10,
  mechanism: "banded_share",
  shareBands: bands,
  painCap: null,
  gainCap: null,
  participants: [],
  ...over,
});

describe("parseShareBands / parseParticipants", () => {
  it("accepts a well-formed band set", () => {
    expect(parseShareBands([{ fromPercent: 0, toPercent: 5, contractorSharePercent: 50 }])).toEqual([
      { fromPercent: 0, toPercent: 5, contractorSharePercent: 50 },
    ]);
    expect(parseShareBands([{ fromPercent: 0, toPercent: null, contractorSharePercent: 20 }])[0]!.toPercent).toBeNull();
  });

  it("refuses malformed bands", () => {
    expect(() => parseShareBands("no")).toThrow(PainGainError);
    expect(() => parseShareBands([{ toPercent: 5 }])).toThrow(/numeric fromPercent/);
    expect(() => parseShareBands([{ fromPercent: 5, toPercent: 1, contractorSharePercent: 50 }])).toThrow(/does not move forward/);
    expect(() => parseShareBands([{ fromPercent: 0, toPercent: 5, contractorSharePercent: 120 }])).toThrow(/between 0 and 100/);
  });

  it("refuses participant shares over 100%", () => {
    expect(parseParticipants(null)).toEqual([]);
    expect(() =>
      parseParticipants([
        { name: "A", sharePercent: 70 },
        { name: "B", sharePercent: 40 },
      ]),
    ).toThrow(/cannot exceed 100/);
    expect(() => parseParticipants([{ sharePercent: 10 }])).toThrow(/needs a name/);
  });

  it("finds overlaps, gaps and mechanism mismatches", () => {
    expect(validateShareBands(bands, "banded_share")).toEqual([]);
    expect(validateShareBands([], "banded_share")[0]).toMatch(/no share bands/);
    expect(
      validateShareBands(
        [
          { fromPercent: 0, toPercent: 10, contractorSharePercent: 50 },
          { fromPercent: 5, toPercent: 20, contractorSharePercent: 20 },
        ],
        "banded_share",
      )[0],
    ).toMatch(/overlap/);
    expect(
      validateShareBands(
        [
          { fromPercent: 0, toPercent: 5, contractorSharePercent: 50 },
          { fromPercent: 10, toPercent: 20, contractorSharePercent: 20 },
        ],
        "banded_share",
      )[0],
    ).toMatch(/gap/);
    expect(validateShareBands(bands, "flat_share")[0]).toMatch(/single share/);
  });
});

describe("computePainGain — banded integration", () => {
  it("returns nothing to share when outturn equals the adjusted target", () => {
    const out = computePainGain(base());
    expect(out.computable).toBe(true);
    expect(out.side).toBe("on_target");
    expect(out.contractorShare).toBe(0);
    expect(out.contractorAdjustment).toBe(0);
    expect(out.contractorPayment).toBe(1_100_000); // cost + 10% fee
  });

  it("integrates an overrun through the bands rather than applying one rate", () => {
    // 8% overrun = 80,000. First 5% (50,000) at 50% = 25,000; next 3%
    // (30,000) at 20% = 6,000. Contractor bears 31,000, client 49,000.
    const out = computePainGain(base({ outturnCost: 1_080_000 }));
    expect(out.side).toBe("pain");
    expect(out.variance).toBe(80_000);
    expect(out.variancePercent).toBe(8);
    expect(out.contractorShare).toBe(31_000);
    expect(out.clientShare).toBe(49_000);
    expect(out.contractorAdjustment).toBe(-31_000);
    // fee is on defined cost, so it rises with the overrun
    expect(out.fee).toBe(108_000);
    expect(out.contractorPayment).toBe(1_080_000 + 108_000 - 31_000);
    expect(out.bands.map((b) => b.contractorAmount)).toEqual([25_000, 6_000]);
  });

  it("integrates a saving through the gain-side bands", () => {
    // 7% saving = 70,000. First 5% (50,000) at 50% = 25,000; next 2%
    // (20,000) at 30% = 6,000. Contractor earns 31,000.
    const out = computePainGain(base({ outturnCost: 930_000 }));
    expect(out.side).toBe("gain");
    expect(out.variance).toBe(-70_000);
    expect(out.contractorShare).toBe(31_000);
    expect(out.clientShare).toBe(39_000);
    expect(out.contractorAdjustment).toBe(31_000);
    expect(out.contractorPayment).toBe(930_000 + 93_000 + 31_000);
  });

  it("applies target adjustments before measuring the variance", () => {
    const out = computePainGain(base({ targetAdjustments: 100_000, outturnCost: 1_080_000 }));
    // Adjusted target is 1.1m, so 1.08m is a 20,000 saving, not an overrun.
    expect(out.adjustedTarget).toBe(1_100_000);
    expect(out.side).toBe("gain");
    expect(out.variance).toBe(-20_000);
  });

  it("attributes variance outside every band to the client and warns", () => {
    const truncated: ShareBand[] = [{ fromPercent: 0, toPercent: 5, contractorSharePercent: 50 }];
    const out = computePainGain(base({ outturnCost: 1_100_000, shareBands: truncated }));
    // 10% overrun: 5% inside the band (50,000 → 25,000 contractor), 5% outside.
    expect(out.contractorShare).toBe(25_000);
    expect(out.clientShare).toBe(75_000);
    expect(out.warnings.join(" ")).toMatch(/outside every declared share band/);
  });
});

describe("computePainGain — caps and flat mechanisms", () => {
  it("caps contractor pain and transfers the excess to the client", () => {
    const out = computePainGain(base({ outturnCost: 1_080_000, painCap: 20_000 }));
    expect(out.contractorShare).toBe(20_000);
    expect(out.capApplied).toBe("pain");
    expect(out.cappedAt).toBe(20_000);
    expect(out.capTransfer).toBe(11_000);
    expect(out.clientShare).toBe(60_000); // 49,000 + 11,000 — the money does not vanish
  });

  it("caps contractor gain the same way", () => {
    const out = computePainGain(base({ outturnCost: 930_000, gainCap: 10_000 }));
    expect(out.contractorShare).toBe(10_000);
    expect(out.capApplied).toBe("gain");
    expect(out.clientShare).toBe(60_000);
  });

  it("applies a flat share to the whole variance and warns about extra bands", () => {
    const out = computePainGain(base({ outturnCost: 1_080_000, mechanism: "flat_share" }));
    expect(out.contractorShare).toBe(80_000 * 0.3); // the first band's 30%
    expect(out.warnings.join(" ")).toMatch(/only the first/);
  });
});

describe("computePainGain — alliance participants (#1061)", () => {
  it("splits the contractor side by participant share and keeps the sign", () => {
    const out = computePainGain(
      base({
        outturnCost: 1_080_000,
        participants: [
          { name: "Constructor", sharePercent: 60 },
          { name: "Designer", sharePercent: 40 },
        ],
      }),
    );
    expect(out.participants.map((p) => p.amount)).toEqual([-18_600, -12_400]); // 60/40 of −31,000
  });

  it("warns when participant shares do not add to 100% of the contractor side", () => {
    const out = computePainGain(
      base({ outturnCost: 930_000, participants: [{ name: "Solo", sharePercent: 70 }] }),
    );
    expect(out.warnings.join(" ")).toMatch(/30% is unallocated/);
    expect(out.participants[0]!.amount).toBe(21_700);
  });
});

describe("computePainGain — refusals", () => {
  it("refuses to compute against a zero or negative target", () => {
    const out = computePainGain(base({ baseTargetCost: 0, outturnCost: 100 }));
    expect(out.computable).toBe(false);
    expect(out.contractorShare).toBeNull();
    expect(out.reasons[0]).toMatch(/zero or negative/);
  });

  it("refuses when no share bands are defined", () => {
    const out = computePainGain(base({ shareBands: [], outturnCost: 1_100_000 }));
    expect(out.computable).toBe(false);
    expect(out.reasons[0]).toMatch(/no share bands/);
  });

  it("refuses a negative outturn", () => {
    const out = computePainGain(base({ outturnCost: -1 }));
    expect(out.computable).toBe(false);
    expect(out.reasons[0]).toMatch(/negative/);
  });
});
