import { describe, expect, it } from "vitest";
import {
  canTransition,
  computePainGain,
  computeQuotation,
  deemedAcceptance,
  necValuationBasis,
} from "./ce.js";
import { complianceTemplatesForForm, evaluateCompliance } from "./compliance.js";

describe("compensation-event state machine", () => {
  it("walks the NEC cycle and refuses illegal jumps", () => {
    expect(canTransition("notified", "quotation_requested")).toBe(true);
    expect(canTransition("quotation_requested", "quotation_submitted")).toBe(true);
    expect(canTransition("quotation_submitted", "implemented")).toBe(true);
    expect(canTransition("notified", "implemented")).toBe(false);
    expect(canTransition("implemented", "rejected")).toBe(false);
  });

  it("maps each NEC main option to its valuation basis", () => {
    expect(necValuationBasis("A").basis).toBe("activity_schedule");
    expect(necValuationBasis("B").basis).toBe("bill_of_quantities");
    expect(necValuationBasis("C").painGainShare).toBe(true);
    expect(necValuationBasis("E").basis).toBe("cost_reimbursable");
    expect(necValuationBasis(null).explanation).toContain("No NEC main option");
  });
});

describe("quotation build-up", () => {
  it("totals Defined Cost by SCC head and adds the Fee, then risk", () => {
    const q = computeQuotation(
      [
        { component: "people", description: "Gang", qty: 40, rate: 55 },
        { component: "equipment", description: "Excavator", qty: 5, rate: 300 },
        { component: "plant_and_materials", description: "Stone", qty: 100, rate: 22 },
      ],
      12,
      1_000,
    );
    expect(q.definedCost).toBe(2_200 + 1_500 + 2_200);
    expect(q.byComponent["people"]).toBe(2_200);
    expect(q.fee).toBe(708);
    expect(q.total).toBe(5_900 + 708 + 1_000);
  });

  it("handles an empty build-up without inventing a total", () => {
    const q = computeQuotation([], 10);
    expect(q.definedCost).toBe(0);
    expect(q.total).toBe(0);
  });
});

describe("pain/gain share", () => {
  it("apportions a gain through the share ranges", () => {
    const r = computePainGain(1_000_000, 900_000, [
      { upTo: 0.95, sharePercent: 50 },
      { upTo: null, sharePercent: 30 },
    ]);
    expect(r.difference).toBe(100_000);
    // first band covers 5% of target = 50,000 at 50%; the rest at 30%
    expect(r.contractorShare).toBe(25_000 + 15_000);
    expect(r.explanation).toContain("Gain");
  });

  it("apportions pain with the same table and the opposite sign", () => {
    const r = computePainGain(1_000_000, 1_100_000, [
      { upTo: 1.05, sharePercent: 50 },
      { upTo: null, sharePercent: 30 },
    ]);
    expect(r.difference).toBe(-100_000);
    expect(r.contractorShare).toBe(-(25_000 + 15_000));
    expect(r.explanation).toContain("Pain");
  });

  it("returns zero when actual equals target", () => {
    const r = computePainGain(500_000, 500_000, [{ upTo: null, sharePercent: 50 }]);
    expect(r.contractorShare).toBe(0);
    expect(r.bands).toHaveLength(0);
  });
});

describe("deemed acceptance", () => {
  const base = {
    quotationStatus: "submitted",
    replyDueDate: "2025-01-15",
    repliedAt: null as string | null,
    form: "nec4_ecc",
  };

  it("does nothing before the reply is due", () => {
    const v = deemedAcceptance({ ...base, today: "2025-01-10" });
    expect(v.overdue).toBe(false);
    expect(v.deemed).toBe(false);
  });

  it("reports an overdue reply before the further period elapses", () => {
    const v = deemedAcceptance({ ...base, today: "2025-01-20" });
    expect(v.overdue).toBe(true);
    expect(v.deemed).toBe(false);
    expect(v.reason).toContain("62.6");
  });

  it("deems acceptance under NEC4 once the further period elapses", () => {
    const v = deemedAcceptance({ ...base, today: "2025-01-30" });
    expect(v.deemed).toBe(true);
    expect(v.daysOverdue).toBe(15);
  });

  it("never deems acceptance under NEC3 and says why", () => {
    const v = deemedAcceptance({ ...base, form: "nec3_ecc", today: "2025-03-01" });
    expect(v.deemed).toBe(false);
    expect(v.reason).toContain("NEC3 has no deemed-acceptance backstop");
  });

  it("stands down once the Project Manager has replied", () => {
    const v = deemedAcceptance({ ...base, repliedAt: "2025-01-14T09:00:00Z", today: "2025-03-01" });
    expect(v.overdue).toBe(false);
  });
});

describe("insurance and bond compliance", () => {
  it("carries a requirement template for every standard form except bespoke", () => {
    expect(complianceTemplatesForForm("fidic_red_2017").length).toBeGreaterThan(2);
    expect(complianceTemplatesForForm("nec4_ecc").some((t) => t.kind === "bond")).toBe(true);
    expect(complianceTemplatesForForm("jct_sbc_2016").length).toBeGreaterThan(0);
    expect(complianceTemplatesForForm("bespoke")).toHaveLength(0);
  });

  it("answers unknown, not compliant, with no evidence", () => {
    const r = evaluateCompliance({
      requirement: "Performance security 10%",
      kind: "bond",
      requiredAmount: 1_000_000,
      currency: "GBP",
      requiredUntil: "2026-01-01",
      evidence: null,
      today: "2025-01-01",
    });
    expect(r.status).toBe("unknown");
    expect(r.reason).toContain("No policy or bond");
  });

  it("fails cover that is short of the required amount", () => {
    const r = evaluateCompliance({
      requirement: "Performance security 10%",
      kind: "bond",
      requiredAmount: 1_000_000,
      currency: "GBP",
      requiredUntil: null,
      evidence: {
        evidenceType: "bond",
        evidenceId: "b1",
        amount: 600_000,
        currency: "GBP",
        expiry: "2027-01-01",
        status: "active",
        label: "Bond B-001",
      },
      today: "2025-01-01",
    });
    expect(r.status).toBe("non_compliant");
    expect(r.reason).toContain("short by 400000");
  });

  it("fails cover that expires before the required date", () => {
    const r = evaluateCompliance({
      requirement: "Works insurance to completion",
      kind: "insurance",
      requiredAmount: null,
      currency: "GBP",
      requiredUntil: "2026-06-30",
      evidence: {
        evidenceType: "insurance_policy",
        evidenceId: "p1",
        amount: null,
        currency: "GBP",
        expiry: "2026-01-31",
        status: "active",
        label: "Policy P-1",
      },
      today: "2025-01-01",
    });
    expect(r.status).toBe("non_compliant");
    expect(r.reason).toContain("before the required");
  });

  it("warns while cover is inside the expiry window", () => {
    const r = evaluateCompliance({
      requirement: "Public liability",
      kind: "insurance",
      requiredAmount: null,
      currency: "GBP",
      requiredUntil: null,
      evidence: {
        evidenceType: "insurance_policy",
        evidenceId: "p1",
        amount: null,
        currency: "GBP",
        expiry: "2025-01-20",
        status: "active",
        label: "Policy P-1",
      },
      today: "2025-01-01",
    });
    expect(r.status).toBe("expiring");
    expect(r.reason).toContain("19 days");
  });

  it("refuses to compare across currencies", () => {
    const r = evaluateCompliance({
      requirement: "Performance security",
      kind: "bond",
      requiredAmount: 1_000_000,
      currency: "GBP",
      requiredUntil: null,
      evidence: {
        evidenceType: "bond",
        evidenceId: "b1",
        amount: 1_500_000,
        currency: "AED",
        expiry: "2027-01-01",
        status: "active",
        label: "Bond B-001",
      },
      today: "2025-01-01",
    });
    expect(r.status).toBe("unknown");
    expect(r.reason).toContain("not comparable");
  });

  it("passes live, sufficient, long-enough cover", () => {
    const r = evaluateCompliance({
      requirement: "Performance security 10%",
      kind: "bond",
      requiredAmount: 1_000_000,
      currency: "GBP",
      requiredUntil: "2026-01-01",
      evidence: {
        evidenceType: "bond",
        evidenceId: "b1",
        amount: 1_000_000,
        currency: "GBP",
        expiry: "2027-01-01",
        status: "active",
        label: "Bond B-001",
      },
      today: "2025-01-01",
    });
    expect(r.status).toBe("compliant");
  });
});
