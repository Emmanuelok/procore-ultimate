/**
 * Unit tests for the prime-contract analytics engine: change order register
 * analytics, receipts/settlement/ageing, the compliance gate, stored
 * materials reconciliation, retainage release proposals and the AIA export.
 */
import { describe, expect, it } from "vitest";
import {
  aiaCsv,
  aiaExport,
  changeOrderAnalytics,
  complianceGate,
  finalReleaseProposal,
  receivablesAging,
  settlementOf,
  storedMaterialsReconciliation,
} from "./analytics.js";

describe("changeOrderAnalytics", () => {
  const changes = [
    { id: "1", reference: "PCCO-001", status: "executed", amount: 50_000, reason: "client_request", createdAt: "2026-01-01T00:00:00Z", submittedAt: "2026-01-05T00:00:00Z", approvedAt: "2026-01-15T00:00:00Z", executedDate: "2026-01-20", requestedDate: "2026-01-01", scheduleImpactDays: 5 },
    { id: "2", reference: "PCCO-002", status: "executed", amount: -10_000, reason: "value_engineering", createdAt: "2026-02-01T00:00:00Z", submittedAt: "2026-02-03T00:00:00Z", approvedAt: "2026-02-13T00:00:00Z", executedDate: "2026-02-20", requestedDate: null, scheduleImpactDays: 0 },
    { id: "3", reference: "PCCO-003", status: "pending_owner_approval", amount: 30_000, reason: "client_request", createdAt: "2026-03-01T00:00:00Z", submittedAt: "2026-03-02T00:00:00Z", approvedAt: null, executedDate: null, requestedDate: null, scheduleImpactDays: 2 },
    { id: "4", reference: "PCCO-004", status: "draft", amount: 5_000, reason: null, createdAt: "2026-03-10T00:00:00Z", submittedAt: null, approvedAt: null, executedDate: null, requestedDate: null, scheduleImpactDays: 0 },
  ];

  it("buckets by status and reason, ages pending, and measures cycle time", () => {
    const a = changeOrderAnalytics(changes, 1_000_000, "2026-04-01");
    expect(a.executed).toEqual({ count: 2, amount: 40_000, shareOfOriginal: 0.04, scheduleImpactDays: 5 });
    expect(a.pending.count).toBe(1);
    expect(a.pending.amount).toBe(30_000);
    expect(a.pending.oldestDays).toBe(30);
    expect(a.byReason[0]).toEqual({ reason: "client_request", count: 2, amount: 80_000 });
    expect(a.byStatus.find((s) => s.status === "draft")?.amount).toBe(5_000);
    expect(a.cycleTimeDays.createdToSubmitted).toBe(3); // (4 + 2 + 1) / 3
    expect(a.cycleTimeDays.submittedToApproved).toBe(10);
    expect(a.cycleTimeDays.approvedToExecuted).toBe(6); // 5 and 7
    expect(a.monthly.map((m) => m.cumulative)).toEqual([50_000, 40_000]);
  });

  it("says when it has nothing to say", () => {
    const a = changeOrderAnalytics([], 0, "2026-04-01");
    expect(a.executed.shareOfOriginal).toBeNull();
    expect(a.reasons).toHaveLength(2);
  });
});

describe("receipts and ageing", () => {
  const app = { id: "pa1", reference: "PA-001", status: "certified", currency: "USD", currentPaymentDue: 350_000, certifiedAmount: 350_000, certifiedAt: "2026-01-10T12:00:00Z", applicationDate: "2026-01-05" };
  const receipts = [
    { paymentApplicationId: "pa1", status: "recorded", amount: 300_000, receivedDate: "2026-02-01" },
    { paymentApplicationId: "pa1", status: "void", amount: 999, receivedDate: "2026-02-02" },
  ];

  it("derives settlement from non-void receipts", () => {
    const s = settlementOf(app, receipts);
    expect(s).toEqual({ certified: 350_000, paid: 300_000, outstanding: 50_000, state: "partially_paid", receipts: 1, lastReceivedDate: "2026-02-01" });
    expect(settlementOf(app, []).state).toBe("unpaid");
    expect(settlementOf(app, [{ paymentApplicationId: "pa1", status: "recorded", amount: 350_000, receivedDate: "2026-02-01" }]).state).toBe("paid");
  });

  it("ages outstanding balances against the payment terms and builds the dunning list", () => {
    const aging = receivablesAging([app, { ...app, id: "pa2", reference: "PA-002", certifiedAt: "2026-03-25T00:00:00Z", currentPaymentDue: 100_000, certifiedAmount: null }], receipts, 30, "2026-04-01", "USD");
    const one = aging.items.find((i) => i.reference === "PA-001")!;
    expect(one.dueDate).toBe("2026-02-09");
    expect(one.daysOverdue).toBe(51);
    expect(one.bucket).toBe("31-60");
    const two = aging.items.find((i) => i.reference === "PA-002")!;
    expect(two.certified).toBe(100_000);
    expect(two.bucket).toBe("current");
    expect(aging.totals).toEqual({ certified: 450_000, paid: 300_000, outstanding: 150_000, overdue: 50_000 });
    expect(aging.dunning.map((d) => d.reference)).toEqual(["PA-001"]);
    expect(aging.buckets.find((b) => b.bucket === "31-60")?.amount).toBe(50_000);
  });

  it("refuses to call anything overdue without payment terms", () => {
    const aging = receivablesAging([app], receipts, null, "2026-04-01", "USD");
    expect(aging.items[0]?.daysOverdue).toBeNull();
    expect(aging.items[0]?.bucket).toBe("unknown");
    expect(aging.dunning).toEqual([]);
    expect(aging.reasons[0]).toMatch(/no payment terms/);
  });
});

describe("complianceGate", () => {
  it("blocks on missing and expired required documents, ignores optional ones, warns on expiring", () => {
    const gate = complianceGate(
      [
        { id: "a", kind: "insurance_certificate", title: "GL insurance", required: 1, status: "verified", expiryDate: "2026-04-20" },
        { id: "b", kind: "performance_bond", title: "Performance bond", required: 1, status: "received", expiryDate: "2026-01-01" },
        { id: "c", kind: "permit", title: "Building permit", required: 1, status: "missing", expiryDate: null },
        { id: "d", kind: "other", title: "Nice to have", required: 0, status: "missing", expiryDate: null },
        { id: "e", kind: "tax_form", title: "W-9", required: 1, status: "waived", expiryDate: null },
      ],
      "2026-04-01",
    );
    expect(gate.ok).toBe(false);
    expect(gate.blocking.map((b) => b.id)).toEqual(["b", "c"]);
    expect(gate.blocking[0]?.problem).toMatch(/expired on 2026-01-01/);
    expect(gate.expiringSoon).toEqual([{ id: "a", kind: "insurance_certificate", title: "GL insurance", expiryDate: "2026-04-20", daysLeft: 19 }]);
    expect(gate.summary).toEqual({ required: 4, satisfied: 2, missing: 1, expired: 1, waived: 1, optional: 1 });
    expect(complianceGate([], "2026-04-01").ok).toBe(true);
  });
});

describe("storedMaterialsReconciliation", () => {
  it("proves Σ register = column F per line and names uninsured / unevidenced items", () => {
    const r = storedMaterialsReconciliation(
      [
        { id: "i1", sovLineId: "L1", status: "stored", value: 30_000, incorporatedValue: 0, insured: 1, supplierInvoiceReference: "SUP-1" },
        { id: "i2", sovLineId: "L1", status: "partially_incorporated", value: 20_000, incorporatedValue: 5_000, insured: 0, supplierInvoiceReference: null },
        { id: "i3", sovLineId: "L1", status: "incorporated", value: 10_000, incorporatedValue: 10_000, insured: 1, supplierInvoiceReference: "SUP-3" },
      ],
      [
        { id: "L1", lineNumber: "01", materialsPresentlyStored: 45_000 },
        { id: "L2", lineNumber: "02", materialsPresentlyStored: 7_000 },
      ],
    );
    expect(r.lines[0]?.registerValue).toBe(45_000);
    expect(r.lines[0]?.identity.ok).toBe(true);
    expect(r.lines[1]?.identity.ok).toBe(false); // column F claims 7,000 with no register behind it
    expect(r.totals.identity.delta).toBe(-7_000);
    expect(r.reasons.join(" ")).toMatch(/1 stored item\(s\) carry no insurance/);
    expect(r.reasons.join(" ")).toMatch(/no supplier invoice/);
  });
});

describe("finalReleaseProposal", () => {
  const base = { retainageHeld: 100_000, retainageReleased: 0, percentComplete: 60, substantialCompletionDate: null, actualCompletionDate: null, terms: { workPercent: 10, reductionThresholdPercent: 50, reducedPercent: 5 }, pendingReleases: 0, openApplications: 0, outstandingLienWaivers: 0, complianceOk: true, today: "2026-04-01" };

  it("proposes a step-down release once the threshold is passed", () => {
    const p = finalReleaseProposal(base);
    expect(p.kind).toBe("step_down");
    expect(p.amount.value).toBe(50_000); // held at 10% → 5%
    expect(p.gate.ok).toBe(true);
  });

  it("proposes the full held balance at substantial completion, gated on waivers and open applications", () => {
    const p = finalReleaseProposal({ ...base, substantialCompletionDate: "2026-03-01", outstandingLienWaivers: 2, openApplications: 1 });
    expect(p.kind).toBe("final");
    expect(p.amount.value).toBe(100_000);
    expect(p.gate.ok).toBe(false);
    expect(p.gate.reasons).toHaveLength(2);
  });

  it("proposes nothing before any trigger, and says why", () => {
    const p = finalReleaseProposal({ ...base, percentComplete: 20 });
    expect(p.kind).toBe("none");
    expect(p.amount.value).toBeNull();
    expect(finalReleaseProposal({ ...base, retainageHeld: 0 }).rationale).toMatch(/Nothing is held/);
  });
});

describe("aiaExport", () => {
  const input = {
    contract: { reference: "PC-001", title: "Tower", currency: "USD", ownerName: "Owner LLC", contractorName: "Us", architectName: "Arch", contractDate: "2026-01-01", executionDate: "2026-01-05" },
    application: { reference: "PA-002", number: 2, applicationDate: "2026-03-01", periodTo: "2026-02-28", status: "certified", certifiedAmount: 350_000, certifiedAt: "2026-03-05T00:00:00Z", certifiedByContractorName: "R. Okonkwo", contractorCertifiedAt: "2026-03-01T00:00:00Z", notaryReference: null },
    g702: { originalContractSum: 1_000_000, netChangeOrders: 50_000, contractSumToDate: 1_050_000, completedToDate: 600_000, storedMaterials: 30_000, totalCompletedAndStored: 630_000, retainagePercentWork: 10, retainageWork: 60_000, retainagePercentMaterials: 10, retainageMaterials: 3_000, totalRetainage: 63_000, totalEarnedLessRetainage: 567_000, lessPreviousCertificates: 189_000, currentPaymentDue: 378_000, balanceToFinishPlusRetainage: 483_000 },
    g703: [
      { lineNumber: "01", description: "General, \"conditions\"", scheduledValue: 100_000, previousBilled: 50_000, thisPeriodWork: 20_000, materialsPresentlyStored: 0, totalCompletedAndStored: 70_000, percentComplete: 70, balanceToFinish: 30_000, retainageHeldToDate: 7_000 },
      { lineNumber: "02", description: "Sitework", scheduledValue: 250_000, previousBilled: 100_000, thisPeriodWork: 50_000, materialsPresentlyStored: 30_000, totalCompletedAndStored: 180_000, percentComplete: 72, balanceToFinish: 70_000, retainageHeldToDate: 18_000 },
    ],
    changes: [{ reference: "PCCO-001", amount: 60_000, executedDate: "2026-02-01" }, { reference: "PCCO-002", amount: -10_000, executedDate: "2026-02-15" }],
  };

  it("prints the form's own field names with the nine numbered lines and the continuation sheet", () => {
    const e = aiaExport(input);
    expect(e.g702["3. CONTRACT SUM TO DATE"]).toBe(1_050_000);
    expect(e.g702["8. CURRENT PAYMENT DUE"]).toBe(378_000);
    expect(e.changeOrderSummary).toMatchObject({ additions: 60_000, deductions: 10_000, net: 50_000 });
    expect(e.g703).toHaveLength(2);
    expect(e.g703Totals["G. TOTAL COMPLETED AND STORED TO DATE"]).toBe(250_000);
    const csv = aiaCsv(e);
    expect(csv).toContain("AIA G702");
    expect(csv).toContain('"General, ""conditions"""');
    expect(csv.split("\n").pop()).toMatch(/^TOTALS,,350000,150000,70000,30000,250000,,100000,25000$/);
  });
});
