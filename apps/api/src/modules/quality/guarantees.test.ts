import { describe, expect, it } from "vitest";
import { assessGuarantee, guaranteeExposure, type GuaranteeLike } from "./guarantees.js";
import { verifyCertificate, verifyProperties } from "./certificateCheck.js";

const guarantee = (over: Partial<GuaranteeLike> = {}): GuaranteeLike => ({
  id: "pg1",
  reference: "PG-001",
  parameter: "Cooling capacity",
  operator: "at_least",
  guaranteedValue: 1200,
  guaranteedMin: null,
  guaranteedMax: null,
  unit: "kW",
  tolerancePercent: null,
  measuredValue: null,
  ldRatePerUnit: null,
  ldCapAmount: null,
  currency: "USD",
  status: "declared",
  ...over,
});

describe("assessGuarantee", () => {
  it("is unmeasured, not failed, before a test", () => {
    const out = assessGuarantee(guarantee());
    expect(out.met).toBeNull();
    expect(out.reasons.join(" ")).toContain("unmeasured, not failed");
  });

  it("meets an at-least guarantee on the nose", () => {
    const out = assessGuarantee(guarantee({ measuredValue: 1200 }));
    expect(out.met).toBe(true);
    expect(out.status).toBe("met");
    expect(out.ldAmount).toBe(0);
  });

  it("computes the shortfall and the damages when a rate is held", () => {
    const out = assessGuarantee(
      guarantee({ measuredValue: 1150, ldRatePerUnit: 100, currency: "GBP" }),
    );
    expect(out.met).toBe(false);
    expect(out.shortfall).toBe(50);
    expect(out.shortfallPercent).toBeCloseTo(4.17, 1);
    expect(out.ldAmount).toBe(5000);
    expect(out.basis).toContain("Damages at 100 GBP per unit");
  });

  it("caps the damages and says it capped them", () => {
    const out = assessGuarantee(
      guarantee({ measuredValue: 1000, ldRatePerUnit: 100, ldCapAmount: 10_000 }),
    );
    expect(out.ldAmount).toBe(10_000);
    expect(out.ldCapped).toBe(true);
    expect(out.basis).toContain("capped");
  });

  it("returns a null exposure — never zero — when no rate is recorded", () => {
    const out = assessGuarantee(guarantee({ measuredValue: 1100 }));
    expect(out.met).toBe(false);
    expect(out.ldAmount).toBeNull();
    expect(out.reasons.join(" ")).toContain("unknown, not nil");
  });

  it("handles at-most, equals with a tolerance, and between", () => {
    expect(
      assessGuarantee(guarantee({ operator: "at_most", guaranteedValue: 3, measuredValue: 2.5 })).met,
    ).toBe(true);
    expect(
      assessGuarantee(
        guarantee({ operator: "equals", guaranteedValue: 100, tolerancePercent: 5, measuredValue: 104 }),
      ).met,
    ).toBe(true);
    expect(
      assessGuarantee(
        guarantee({ operator: "equals", guaranteedValue: 100, tolerancePercent: 5, measuredValue: 94 }),
      ).met,
    ).toBe(false);
    const between = assessGuarantee(
      guarantee({ operator: "between", guaranteedMin: 20, guaranteedMax: 24, measuredValue: 26 }),
    );
    expect(between.met).toBe(false);
    expect(between.shortfall).toBe(2);
  });

  it("reports a waiver rather than a verdict", () => {
    const out = assessGuarantee(guarantee({ status: "waived", measuredValue: 1 }));
    expect(out.status).toBe("waived");
    expect(out.met).toBeNull();
  });

  it("cannot judge a guarantee with no guaranteed value", () => {
    const out = assessGuarantee(guarantee({ guaranteedValue: null, measuredValue: 900 }));
    expect(out.met).toBeNull();
    expect(out.reasons.join(" ")).toContain("cannot be judged");
  });
});

describe("guaranteeExposure", () => {
  it("buckets exposure by currency and names unpriced shortfalls", () => {
    const rows = [
      guarantee({ id: "a", reference: "PG-001", measuredValue: 1100, ldRatePerUnit: 10 }),
      guarantee({ id: "b", reference: "PG-002", measuredValue: 1000, currency: "GBP", ldRatePerUnit: 5 }),
      guarantee({ id: "c", reference: "PG-003", measuredValue: 1150 }),
      guarantee({ id: "d", reference: "PG-004" }),
    ].map((g) => ({ guarantee: g, assessment: assessGuarantee(g) }));
    const exposure = guaranteeExposure(rows);
    expect(exposure.byCurrency).toEqual([
      { currency: "GBP", amount: 1000, guarantees: 1, capped: 0 },
      { currency: "USD", amount: 1000, guarantees: 1, capped: 0 },
    ]);
    expect(exposure.unpricedShortfalls[0]!.reference).toBe("PG-003");
    expect(exposure.unmeasured[0]!.reference).toBe("PG-004");
    expect(exposure.reasons.join(" ")).toContain("more than one currency");
  });
});

describe("verifyProperties", () => {
  it("passes a measurement inside the required window", () => {
    const verdicts = verifyProperties(
      [{ property: "Yield strength", min: 355, unit: "MPa" }],
      [{ property: "yield strength", value: 402, unit: "MPa" }],
    );
    expect(verdicts[0]!.passed).toBe(true);
  });

  it("fails a requirement the certificate is silent on rather than passing it", () => {
    const verdicts = verifyProperties([{ property: "Carbon equivalent", max: 0.45 }], []);
    expect(verdicts[0]!.passed).toBe(false);
    expect(verdicts[0]!.reason).toContain("pass by omission");
  });

  it("fails a measurement outside the window and quotes both numbers", () => {
    const verdicts = verifyProperties(
      [{ property: "Elongation", min: 22, unit: "%" }],
      [{ property: "Elongation", value: 18, unit: "%" }],
    );
    expect(verdicts[0]!.passed).toBe(false);
    expect(verdicts[0]!.reason).toContain("below the minimum 22");
  });

  it("leaves a worded requirement for a human rather than deciding it", () => {
    const verdicts = verifyProperties(
      [{ property: "Grain practice", text: "fine grain" }],
      [{ property: "Grain practice", text: "fine grain, Al killed" }],
    );
    expect(verdicts[0]!.passed).toBeNull();
  });
});

describe("verifyCertificate", () => {
  const base = {
    certificateType: "en_10204_3_1",
    heatNumber: "H-1234",
    batchNumber: null,
    castNumber: null,
    documentFileId: "file-1",
    required: [{ property: "Yield strength", min: 355, unit: "MPa" }],
    measured: [{ property: "Yield strength", value: 400, unit: "MPa" }],
  };

  it("verifies a lot-specific certificate whose numbers meet the spec", () => {
    const out = verifyCertificate(base);
    expect(out.status).toBe("verified");
    expect(out.lotTraceable).toBe(true);
    expect(out.independentlyWitnessed).toBe(false);
  });

  it("refuses to call a 2.2 document traceable to the delivered lot", () => {
    const out = verifyCertificate({ ...base, certificateType: "en_10204_2_2" });
    expect(out.lotTraceable).toBe(false);
    expect(out.status).toBe("unverified");
    expect(out.reasons.join(" ")).toContain("not specific to the delivered lot");
  });

  it("marks a 3.2 certificate as independently witnessed", () => {
    expect(verifyCertificate({ ...base, certificateType: "en_10204_3_2" }).independentlyWitnessed).toBe(
      true,
    );
  });

  it("fails the certificate when a property misses the requirement", () => {
    const out = verifyCertificate({
      ...base,
      measured: [{ property: "Yield strength", value: 300, unit: "MPa" }],
    });
    expect(out.status).toBe("failed");
    expect(out.reasons.join(" ")).toContain("non-conformance before it is installed");
  });

  it("says a certificate with no specified properties has been filed, not checked", () => {
    const out = verifyCertificate({ ...base, required: [] });
    expect(out.status).toBe("unverified");
    expect(out.reasons.join(" ")).toContain("filed, not checked");
  });

  it("notes a missing heat number and a missing document", () => {
    const out = verifyCertificate({ ...base, heatNumber: null, documentFileId: null });
    expect(out.reasons.join(" ")).toContain("cannot be tied to any material on site");
    expect(out.reasons.join(" ")).toContain("not attached");
  });
});
