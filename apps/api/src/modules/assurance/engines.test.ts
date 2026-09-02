/**
 * Unit tests for the pure assurance engines: the ghost-vendor detector family,
 * the typed reconciliation library, integrity scoring and measured precision,
 * entity-graph conflict detection, backdating forensics and name screening.
 *
 * No database, no app: plain rows in, drafts and numbers out. Every threshold
 * is tested on both sides — a detector that only ever fires is as useless as
 * one that never does.
 */
import { describe, expect, it } from "vitest";
import {
  GHOST_VENDOR_DEFAULTS,
  approverVendorAffinity,
  authorityLimitBreaches,
  dormantVendorActivity,
  duplicatePayments,
  invoiceBeforePurchaseOrder,
  invoiceNumberParts,
  localParts,
  normaliseIdentifier,
  outOfHoursApprovals,
  roundSumInvoicing,
  sequentialInvoiceNumbers,
  splitInvoicing,
  vendorConcentration,
  vendorPersonCollisions,
  type ApprovalLike,
  type InvoiceLike,
} from "./ghostvendor.js";
import {
  DEFAULT_TOLERANCE,
  RECONCILERS,
  autoReconcile,
  effectiveIndependence,
  proximityFactor,
  reconcilersFor,
  runReconciler,
  type AssertionLike,
  type EvidenceLike,
} from "./reconcilers.js";
import { bandFor, belowPrecisionFloor, detectorPrecision, integrityScore } from "./scoring.js";
import { backdatedRecords, overrideActivity } from "./backdating.js";
import { shellCompanyIndicators, shortestPath, undeclaredConflicts, type GraphEdge } from "./graph.js";
import {
  fixtureSnapshot,
  nameMatchScore,
  normaliseName,
  screenAgainst,
  statusFromMatches,
} from "./screening.js";
import { DETECTOR_REGISTRY, detectorById, detectorsForScope } from "./registry.js";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function invoice(partial: Partial<InvoiceLike> & { id: string }): InvoiceLike {
  return {
    reference: `INV-${partial.id}`,
    vendorId: "ven_1",
    invoiceNumber: null,
    commitmentId: null,
    currency: "GBP",
    total: 1000,
    billingDate: "2026-06-01",
    receivedDate: null,
    status: "approved",
    approvedBy: null,
    approvedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    ...partial,
  };
}

const NAMES = new Map([
  ["ven_1", "Kestrel Labour Supply Ltd"],
  ["ven_2", "Heron Site Services Ltd"],
  ["ven_3", "Merlin Plant Hire Ltd"],
]);

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

describe("detector registry", () => {
  it("has unique ids and a spec reference for every detector", () => {
    const ids = DETECTOR_REGISTRY.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of DETECTOR_REGISTRY) {
      expect(d.specRef.length).toBeGreaterThan(3);
      expect(d.description.length).toBeGreaterThan(20);
    }
  });

  it("separates project scope from company scope and excludes passive detectors", () => {
    const project = detectorsForScope("project").map((d) => d.id);
    const company = detectorsForScope("company").map((d) => d.id);
    expect(project).toContain("benford_first_digit");
    expect(company).toContain("duplicate_payment");
    expect(project).not.toContain("duplicate_payment");
    // chain-integrity detectors are raised by the anchoring paths, never by a run
    expect([...project, ...company]).not.toContain("ledger_truncation_detected");
    expect(detectorById("nonsense")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Ghost-vendor family                                                 */
/* ------------------------------------------------------------------ */

describe("vendor_person_identity_collision", () => {
  it("fires when a supplier email matches a person on the register", () => {
    const drafts = vendorPersonCollisions(
      [
        {
          id: "ven_1",
          name: "Kestrel Labour Supply Ltd",
          address: "12 High Street, Leeds",
          city: "Leeds",
          email: "j.smith@example.com",
          phone: null,
          taxId: null,
          registrationNumber: null,
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      [
        {
          id: "usr_1",
          kind: "user",
          name: "Jane Smith",
          address: null,
          email: "J.Smith@Example.com",
          phone: null,
        },
      ],
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.severity).toBe("critical");
    expect(drafts[0]!.subjectId).toBe("ven_1");
    expect(drafts[0]!.fingerprint).toContain("email");
  });

  it("does not fire on different identities", () => {
    const drafts = vendorPersonCollisions(
      [
        {
          id: "ven_1",
          name: "A",
          address: "12 High Street",
          city: null,
          email: "a@a.com",
          phone: null,
          taxId: null,
          registrationNumber: null,
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      [{ id: "usr_1", kind: "user", name: "B", address: "9 Low Road", email: "b@b.com", phone: null }],
    );
    expect(drafts).toHaveLength(0);
  });

  it("normalises addresses so punctuation and street words do not defeat it", () => {
    expect(normaliseIdentifier("12 High St.")).toBe(normaliseIdentifier("12 high street"));
    expect(normaliseIdentifier("  ")).toBeNull();
  });
});

describe("sequential_invoice_numbers", () => {
  it("fires on a run of consecutive supplier numbers", () => {
    const invoices = [1001, 1002, 1003, 1004].map((n, i) =>
      invoice({ id: `inv_${i}`, invoiceNumber: `KLS-${n}`, billingDate: `2026-0${i + 1}-01` }),
    );
    const drafts = sequentialInvoiceNumbers(invoices, NAMES);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.detector).toBe("sequential_invoice_numbers");
    expect((drafts[0]!.evidenceRefs as { runLength: number }).runLength).toBe(4);
  });

  it("does not fire when the numbers have gaps (the supplier has other customers)", () => {
    const invoices = [1001, 1019, 1044, 1090].map((n, i) =>
      invoice({ id: `inv_${i}`, invoiceNumber: `KLS-${n}` }),
    );
    expect(sequentialInvoiceNumbers(invoices, NAMES)).toHaveLength(0);
  });

  it("parses trailing integers with their prefix", () => {
    expect(invoiceNumberParts("KLS-0042")).toEqual({ prefix: "kls-", n: 42 });
    expect(invoiceNumberParts("no-digits")).toBeNull();
    expect(invoiceNumberParts(null)).toBeNull();
  });
});

describe("split_invoicing", () => {
  it("reports itself skipped rather than guessing when no threshold is configured", () => {
    const result = splitInvoicing([invoice({ id: "inv_1" })]);
    expect(result.drafts).toHaveLength(0);
    expect(result.skippedReason).toMatch(/no approval threshold/);
  });

  it("fires on invoices just under a configured threshold that together exceed it", () => {
    const result = splitInvoicing(
      [
        invoice({ id: "inv_1", total: 9_500, billingDate: "2026-06-01" }),
        invoice({ id: "inv_2", total: 9_800, billingDate: "2026-06-10" }),
      ],
      { ...GHOST_VENDOR_DEFAULTS, approvalThreshold: 10_000 },
    );
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]!.severity).toBe("high");
    expect((result.drafts[0]!.evidenceRefs as { total: number }).total).toBe(19_300);
  });

  it("does not fire on one large invoice that clears the threshold honestly", () => {
    const result = splitInvoicing(
      [invoice({ id: "inv_1", total: 40_000 })],
      { ...GHOST_VENDOR_DEFAULTS, approvalThreshold: 10_000 },
    );
    expect(result.drafts).toHaveLength(0);
  });
});

describe("invoice_before_purchase_order", () => {
  it("fires when the invoice predates the order and scales severity with the gap", () => {
    const drafts = invoiceBeforePurchaseOrder(
      [invoice({ id: "inv_1", commitmentId: "com_1", billingDate: "2026-04-01" })],
      [
        {
          id: "com_1",
          reference: "PO-1",
          vendorId: "ven_1",
          contractDate: "2026-06-01",
          executionDate: null,
          currency: "GBP",
        },
      ],
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.severity).toBe("high");
    expect((drafts[0]!.evidenceRefs as { daysBefore: number }).daysBefore).toBe(61);
  });

  it("does not fire when the invoice follows the order", () => {
    const drafts = invoiceBeforePurchaseOrder(
      [invoice({ id: "inv_1", commitmentId: "com_1", billingDate: "2026-07-01" })],
      [
        {
          id: "com_1",
          reference: "PO-1",
          vendorId: "ven_1",
          contractDate: "2026-06-01",
          executionDate: null,
          currency: "GBP",
        },
      ],
    );
    expect(drafts).toHaveLength(0);
  });
});

describe("dormant_vendor_reactivated / duplicate_payment / round_sum_invoicing", () => {
  it("flags a supplier billing again after a long silence", () => {
    const drafts = dormantVendorActivity(
      [
        invoice({ id: "inv_1", billingDate: "2024-01-01" }),
        invoice({ id: "inv_2", billingDate: "2026-01-01" }),
      ],
      NAMES,
    );
    expect(drafts).toHaveLength(1);
    expect((drafts[0]!.evidenceRefs as { gapDays: number }).gapDays).toBeGreaterThan(700);
  });

  it("flags identical amounts days apart, harder when the supplier number repeats", () => {
    const same = duplicatePayments([
      invoice({ id: "inv_1", total: 4_250, billingDate: "2026-06-01", invoiceNumber: "K-7" }),
      invoice({ id: "inv_2", total: 4_250, billingDate: "2026-06-03", invoiceNumber: "K-7" }),
    ]);
    expect(same).toHaveLength(1);
    expect(same[0]!.severity).toBe("high");

    const spread = duplicatePayments([
      invoice({ id: "inv_1", total: 4_250, billingDate: "2026-06-01" }),
      invoice({ id: "inv_2", total: 4_250, billingDate: "2026-08-01" }),
    ]);
    expect(spread).toHaveLength(0);
  });

  it("flags a supplier whose invoices are overwhelmingly round thousands", () => {
    const rounds = [1000, 2000, 3000, 4000, 5000, 6000].map((total, i) =>
      invoice({ id: `inv_${i}`, total }),
    );
    expect(roundSumInvoicing(rounds, NAMES)).toHaveLength(1);
    const measured = [1013.44, 2807.19, 3311.02, 41.5, 5099.87, 60.13].map((total, i) =>
      invoice({ id: `inv_${i}`, total }),
    );
    expect(roundSumInvoicing(measured, NAMES)).toHaveLength(0);
  });
});

describe("vendor_concentration", () => {
  it("buckets by currency and never sums across them", () => {
    const drafts = vendorConcentration(
      [
        invoice({ id: "a", vendorId: "ven_1", total: 900_000, currency: "GBP" }),
        invoice({ id: "b", vendorId: "ven_2", total: 50_000, currency: "GBP" }),
        invoice({ id: "c", vendorId: "ven_3", total: 50_000, currency: "GBP" }),
        // A different currency: its own bucket, too few suppliers to judge.
        invoice({ id: "d", vendorId: "ven_1", total: 10_000_000, currency: "NGN" }),
      ],
      NAMES,
    );
    expect(drafts).toHaveLength(1);
    const refs = drafts[0]!.evidenceRefs as { currency: string; share: number };
    expect(refs.currency).toBe("GBP");
    expect(refs.share).toBeCloseTo(0.9, 5);
  });

  it("says nothing when there are only two suppliers", () => {
    const drafts = vendorConcentration(
      [
        invoice({ id: "a", vendorId: "ven_1", total: 900 }),
        invoice({ id: "b", vendorId: "ven_2", total: 100 }),
      ],
      NAMES,
    );
    expect(drafts).toHaveLength(0);
  });
});

describe("approval-pattern detectors", () => {
  const approval = (p: Partial<ApprovalLike> & { id: string }): ApprovalLike => ({
    approverId: "usr_a",
    decidedAt: "2026-06-01T12:00:00.000Z",
    objectType: "invoice",
    objectId: p.id,
    amount: 1000,
    currency: "GBP",
    vendorId: "ven_1",
    ...p,
  });

  it("computes local hour and weekday from a UTC instant and an offset", () => {
    expect(localParts("2026-06-01T23:30:00.000Z", 60)).toEqual({ hour: 0, day: 2 });
    expect(localParts("not-a-date", 0)).toBeNull();
  });

  it("fires out_of_hours only above the count threshold", () => {
    const nights = [1, 2, 3].map((i) =>
      approval({ id: `inv_${i}`, decidedAt: `2026-06-0${i}T03:00:00.000Z` }),
    );
    expect(outOfHoursApprovals(nights)).toHaveLength(1);
    expect(outOfHoursApprovals(nights.slice(0, 2))).toHaveLength(0);
    const daytime = [1, 2, 3].map((i) =>
      approval({ id: `inv_${i}`, decidedAt: `2026-06-0${i}T10:00:00.000Z` }),
    );
    expect(outOfHoursApprovals(daytime)).toHaveLength(0);
  });

  it("fires affinity only when the approver is NOT the general gatekeeper", () => {
    // usr_a signs every one of ven_1's five, but only 5 of 15 overall.
    const approvals: ApprovalLike[] = [
      ...[1, 2, 3, 4, 5].map((i) => approval({ id: `v1_${i}`, approverId: "usr_a", vendorId: "ven_1" })),
      ...[1, 2, 3, 4, 5].map((i) => approval({ id: `v2_${i}`, approverId: "usr_b", vendorId: "ven_2" })),
      ...[1, 2, 3, 4, 5].map((i) => approval({ id: `v3_${i}`, approverId: "usr_c", vendorId: "ven_3" })),
    ];
    const drafts = approverVendorAffinity(approvals, NAMES);
    expect(drafts.map((d) => d.subjectId)).toContain("usr_a");

    // A one-approver company: everything is 100%, and that says nothing.
    const soleApprover = approvals.map((a) => approval({ ...a, approverId: "usr_a" }));
    expect(approverVendorAffinity(soleApprover, NAMES)).toHaveLength(0);
  });

  it("fires an authority breach on the lowest applicable limit", () => {
    const drafts = authorityLimitBreaches(
      [approval({ id: "inv_1", amount: 75_000, currency: "GBP" })],
      [
        { userId: "usr_a", objectType: "any", maxAmount: 100_000, currency: "GBP" },
        { userId: "usr_a", objectType: "invoice", maxAmount: 50_000, currency: "GBP" },
      ],
    );
    expect(drafts).toHaveLength(1);
    expect((drafts[0]!.evidenceRefs as { limit: number }).limit).toBe(50_000);
  });

  it("ignores an approval in a currency the limit does not cover", () => {
    const drafts = authorityLimitBreaches(
      [approval({ id: "inv_1", amount: 75_000, currency: "EUR" })],
      [{ userId: "usr_a", objectType: "any", maxAmount: 50_000, currency: "GBP" }],
    );
    expect(drafts).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Typed reconcilers                                                   */
/* ------------------------------------------------------------------ */

function assertion(p: Partial<AssertionLike> = {}): AssertionLike {
  return {
    id: "asr_1",
    kind: "progress_percent",
    value: 80,
    unit: "%",
    claimantId: "usr_claimant",
    claimantKind: "user",
    createdBy: "usr_claimant",
    assertedAt: "2026-06-15T00:00:00.000Z",
    periodStart: "2026-06-01T00:00:00.000Z",
    periodEnd: "2026-06-30T00:00:00.000Z",
    ...p,
  };
}

function ev(p: Partial<EvidenceLike> & { id: string }): EvidenceLike {
  return {
    kind: "reality_capture",
    source: "drone survey",
    capturedAt: "2026-06-20T00:00:00.000Z",
    ingestedAt: "2026-06-21T00:00:00.000Z",
    independenceScore: 0.9,
    metadata: {},
    submittedBy: "usr_surveyor",
    ...p,
  };
}

describe("typed reconcilers", () => {
  it("refuses evidence of a kind the reconciler does not accept, with the reason", () => {
    const reconciler = RECONCILERS.find((r) => r.kind === "headcount_vs_access")!;
    const outcome = runReconciler(
      reconciler,
      assertion({ kind: "headcount", value: 40 }),
      [ev({ id: "evd_1", kind: "photograph", metadata: { value: 40 } })],
    );
    expect(outcome.result).toBe("insufficient_evidence");
    expect(outcome.rejected[0]!.reason).toMatch(/not accepted by the headcount_vs_access/);
  });

  it("scores evidence submitted by the claimant at zero independence", () => {
    const a = assertion();
    const own = effectiveIndependence(ev({ id: "e", submittedBy: "usr_claimant" }), a);
    expect(own.score).toBe(0);
    expect(own.reason).toMatch(/claimant/);
    const other = effectiveIndependence(ev({ id: "e", submittedBy: "usr_surveyor" }), a);
    expect(other.score).toBeCloseTo(0.9, 5);
  });

  it("also scores zero for the AUTHOR of the assertion, not just the named claimant", () => {
    // The attack: file the claim in a colleague's name, then produce all the
    // evidence yourself. `createdBy` closes it.
    const a = assertion({ claimantId: "usr_colleague", createdBy: "usr_author" });
    expect(effectiveIndependence(ev({ id: "e", submittedBy: "usr_author" }), a).score).toBe(0);
  });

  it("discounts evidence captured outside the claim window", () => {
    const policy = { ...DEFAULT_TOLERANCE, maxCaptureGapDays: 30 };
    const inside = proximityFactor(ev({ id: "e", capturedAt: "2026-06-15T00:00:00.000Z" }), assertion(), policy);
    expect(inside.factor).toBe(1);
    const outside = proximityFactor(
      ev({ id: "e", capturedAt: "2026-08-15T00:00:00.000Z" }),
      assertion(),
      policy,
    );
    expect(outside.factor).toBe(0);
    const partial = proximityFactor(
      ev({ id: "e", capturedAt: "2026-07-15T00:00:00.000Z" }),
      assertion(),
      policy,
    );
    expect(partial.factor).toBeGreaterThan(0);
    expect(partial.factor).toBeLessThan(1);
  });

  it("bands a progress claim against reality capture and marks the adverse direction", () => {
    const outcome = autoReconcile(assertion({ value: 80 }), [
      ev({ id: "e1", metadata: { observedPercent: 55 } }),
      ev({ id: "e2", metadata: { observedPercent: 57 } }),
    ]);
    expect(outcome.reconciler).toBe("progress_vs_capture");
    expect(outcome.result).toBe("contradicted");
    expect(outcome.adverse).toBe(true);
    expect(outcome.observed).toBeCloseTo(56, 5);
    expect(outcome.confidence).toBeGreaterThan(0.8);
  });

  it("supports a claim inside the tolerance band and respects a tightened policy", () => {
    const claim = assertion({ value: 80 });
    const evidence = [ev({ id: "e1", metadata: { observedPercent: 78 } })];
    expect(autoReconcile(claim, evidence).result).toBe("supported");
    const strict = autoReconcile(claim, evidence, {
      ...DEFAULT_TOLERANCE,
      supportedWithinPercent: 1,
      partialWithinPercent: 2,
    });
    expect(strict.result).toBe("contradicted");
  });

  it("sums delivery quantities rather than averaging them", () => {
    const outcome = autoReconcile(
      assertion({ kind: "quantity", value: 300, unit: "m3" }),
      [
        ev({ id: "e1", kind: "delivery_note", metadata: { quantityDelivered: 100 } }),
        ev({ id: "e2", kind: "delivery_note", metadata: { quantityDelivered: 100 } }),
        ev({ id: "e3", kind: "delivery_note", metadata: { quantityDelivered: 100 } }),
      ],
    );
    expect(outcome.reconciler).toBe("quantity_vs_delivery");
    expect(outcome.observed).toBe(300);
    expect(outcome.result).toBe("supported");
  });

  it("falls back to the generic numeric comparison when no typed reconciler applies", () => {
    const outcome = autoReconcile(
      assertion({ kind: "cost", value: 100, unit: "usd" }),
      [ev({ id: "e1", kind: "survey", metadata: { value: 103 } })],
    );
    expect(outcome.reconciler).toBe("numeric_mean");
    expect(outcome.variancePercent).toBeCloseTo(3, 5);
  });

  it("returns insufficient_evidence, never a guess, when the claim has no number", () => {
    const outcome = autoReconcile(assertion({ value: null }), [ev({ id: "e1", metadata: { observedPercent: 50 } })]);
    expect(outcome.result).toBe("insufficient_evidence");
    expect(outcome.observed).toBeNull();
    expect(outcome.basis).toMatch(/no numeric value/);
  });

  it("offers a typed reconciler first and the fallback last", () => {
    const order = reconcilersFor("headcount").map((r) => r.kind);
    expect(order[0]).toBe("headcount_vs_access");
    expect(order[order.length - 1]).toBe("numeric_mean");
  });
});

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

describe("detector precision", () => {
  it("refuses to publish a figure below the minimum reviewed count", () => {
    const rows = [
      { detector: "duplicate_payment", disposition: "confirmed", createdAt: new Date().toISOString() },
      { detector: "duplicate_payment", disposition: "false_positive", createdAt: new Date().toISOString() },
    ];
    const [result] = detectorPrecision(rows, { now: new Date(), minReviewed: 10 });
    expect(result!.precision).toBeNull();
    expect(result!.reason).toMatch(/fewer than the 10 needed/);
  });

  it("computes precision and suppresses below the configured floor", () => {
    const now = new Date();
    const rows = [
      ...Array.from({ length: 3 }, () => ({
        detector: "round_sum_invoicing",
        disposition: "confirmed",
        createdAt: now.toISOString(),
      })),
      ...Array.from({ length: 9 }, () => ({
        detector: "round_sum_invoicing",
        disposition: "false_positive",
        createdAt: now.toISOString(),
      })),
    ];
    const [measured] = detectorPrecision(rows, { now, minReviewed: 10 });
    expect(measured!.precision).toBeCloseTo(0.25, 5);
    expect(belowPrecisionFloor(measured, 0.3).suppressed).toBe(true);
    expect(belowPrecisionFloor(measured, 0.2).suppressed).toBe(false);
    // No floor configured = never auto-suppressed.
    expect(belowPrecisionFloor(measured, null).suppressed).toBe(false);
  });

  it("ignores reviewed signals outside the rolling window", () => {
    const now = new Date("2026-09-01T00:00:00.000Z");
    const rows = Array.from({ length: 12 }, () => ({
      detector: "duplicate_payment",
      disposition: "false_positive",
      createdAt: "2024-01-01T00:00:00.000Z",
    }));
    expect(detectorPrecision(rows, { now, windowDays: 180 })).toHaveLength(0);
  });
});

describe("integrity exposure score", () => {
  const now = new Date("2026-09-01T00:00:00.000Z");

  it("says nothing rather than zero-with-confidence for a subject with no findings", () => {
    const result = integrityScore([], { now });
    expect(result.score).toBe(0);
    expect(result.band).toBe("clear");
    expect(result.basis).toMatch(/not a statement that nothing is wrong/);
  });

  it("weights severity, disposition and detector trust, and decays with age", () => {
    const fresh = integrityScore(
      [
        {
          id: "s1",
          detector: "duplicate_payment",
          severity: "critical",
          disposition: "confirmed",
          createdAt: now.toISOString(),
        },
      ],
      { now, precisionByDetector: new Map([["duplicate_payment", 1]]) },
    );
    const old = integrityScore(
      [
        {
          id: "s1",
          detector: "duplicate_payment",
          severity: "critical",
          disposition: "confirmed",
          createdAt: "2026-03-01T00:00:00.000Z",
        },
      ],
      { now, precisionByDetector: new Map([["duplicate_payment", 1]]) },
    );
    expect(fresh.score).toBeGreaterThan(old.score);
    expect(fresh.components[0]!.basis).toMatch(/age decay/);
  });

  it("gives a false positive no weight at all", () => {
    const result = integrityScore(
      [
        {
          id: "s1",
          detector: "duplicate_payment",
          severity: "critical",
          disposition: "false_positive",
          createdAt: now.toISOString(),
        },
      ],
      { now },
    );
    expect(result.score).toBe(0);
    expect(result.openSignals).toBe(0);
  });

  it("saturates: no finite number of findings exceeds 100", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      id: `s${i}`,
      detector: "duplicate_payment",
      severity: "critical",
      disposition: "confirmed",
      createdAt: now.toISOString(),
    }));
    const result = integrityScore(many, { now, precisionByDetector: new Map([["duplicate_payment", 1]]) });
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.band).toBe("severe");
    expect(result.components.length).toBeLessThanOrEqual(25);
  });

  it("bands consistently", () => {
    expect(bandFor(0)).toBe("clear");
    expect(bandFor(15)).toBe("watch");
    expect(bandFor(45)).toBe("elevated");
    expect(bandFor(90)).toBe("severe");
  });
});

/* ------------------------------------------------------------------ */
/* Backdating                                                          */
/* ------------------------------------------------------------------ */

describe("backdating forensics", () => {
  it("flags records antedated beyond the window, grouped by actor", () => {
    const drafts = backdatedRecords(
      [
        {
          objectType: "assertion",
          objectId: "asr_1",
          statedAt: "2026-05-01T00:00:00.000Z",
          createdAt: "2026-06-20T00:00:00.000Z",
          actorId: "usr_a",
          label: "assertion asr_1 (cost)",
        },
        {
          objectType: "event",
          objectId: "evt_1",
          statedAt: "2026-06-19T00:00:00.000Z",
          createdAt: "2026-06-20T00:00:00.000Z",
          actorId: "usr_a",
          label: "event evt_1",
        },
      ],
      { windowHours: 72 },
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.severity).toBe("high");
    expect((drafts[0]!.evidenceRefs as { count: number }).count).toBe(1);
  });

  it("does not flag a record written up the same evening", () => {
    const drafts = backdatedRecords([
      {
        objectType: "evidence",
        objectId: "evd_1",
        statedAt: "2026-06-20T09:00:00.000Z",
        createdAt: "2026-06-20T21:00:00.000Z",
        actorId: "usr_a",
        label: "evidence evd_1",
      },
    ]);
    expect(drafts).toHaveLength(0);
  });

  it("flags deletes of high-value objects even below the update threshold, and exempts reviewers", () => {
    const entries = [
      { seq: 1, actorId: "usr_a", action: "delete", objectType: "invoice", objectId: "inv_1", at: "2026-06-01T00:00:00.000Z" },
    ];
    expect(overrideActivity(entries, { highValueTypes: ["invoice"] })).toHaveLength(1);
    expect(
      overrideActivity(entries, { highValueTypes: ["invoice"], exemptActorIds: ["usr_a"] }),
    ).toHaveLength(0);
    // A single update is below the threshold — routine corrections are not findings.
    expect(
      overrideActivity(
        [{ ...entries[0]!, action: "update" }],
        { highValueTypes: ["invoice"] },
      ),
    ).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Entity graph                                                        */
/* ------------------------------------------------------------------ */

describe("entity graph", () => {
  const edges: GraphEdge[] = [
    { id: "r1", from: "ent_person", to: "ent_holdco", kind: "director_of", confidence: 1, source: "registry" },
    { id: "r2", from: "ent_holdco", to: "ent_vendor", kind: "shareholder_of", confidence: 1, source: "registry" },
    { id: "r3", from: "ent_other", to: "ent_unrelated", kind: "employee_of", confidence: 1, source: null },
  ];

  it("finds the shortest path and respects the depth limit", () => {
    const path = shortestPath(edges, "ent_person", "ent_vendor", 3);
    expect(path?.length).toBe(2);
    expect(path?.edges.map((e) => e.id)).toEqual(["r1", "r2"]);
    expect(shortestPath(edges, "ent_person", "ent_vendor", 1)).toBeNull();
    expect(shortestPath(edges, "ent_person", "ent_unrelated", 5)).toBeNull();
  });

  it("raises an undeclared conflict and stays silent once it is declared", () => {
    const input = {
      edges,
      approvals: [
        {
          id: "inv_1",
          approverId: "usr_a",
          vendorId: "ven_1",
          objectType: "invoice",
          objectId: "inv_1",
          amount: 10_000,
          currency: "GBP",
          decidedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
      userEntityId: new Map([["usr_a", "ent_person"]]),
      vendorEntityId: new Map([["ven_1", "ent_vendor"]]),
      entityNames: new Map([
        ["ent_person", "A Person"],
        ["ent_holdco", "Holdco"],
        ["ent_vendor", "Vendor Ltd"],
      ]),
      declarations: [],
    };
    const raised = undeclaredConflicts(input);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe("critical");
    expect(raised[0]!.explanation).toMatch(/director_of/);

    const declared = undeclaredConflicts({
      ...input,
      declarations: [{ userId: "usr_a", entityId: "ent_vendor", nature: "director", endedAt: null }],
    });
    expect(declared).toHaveLength(0);
  });

  it("flags an entity that won work days after incorporation", () => {
    const drafts = shellCompanyIndicators({
      entities: [
        { id: "ent_1", name: "Newco Civils", kind: "company", incorporatedOn: "2026-01-01" },
        { id: "ent_2", name: "Old Hand Ltd", kind: "company", incorporatedOn: "2001-01-01" },
      ],
      awards: [
        { entityId: "ent_1", vendorId: null, objectId: "com_1", awardedOn: "2026-02-01", amount: 1, currency: "GBP" },
        { entityId: "ent_2", vendorId: null, objectId: "com_2", awardedOn: "2026-02-01", amount: 1, currency: "GBP" },
      ],
      entityByVendor: new Map(),
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.subjectId).toBe("ent_1");
    expect((drafts[0]!.evidenceRefs as { daysToFirstAward: number }).daysToFirstAward).toBe(31);
  });
});

/* ------------------------------------------------------------------ */
/* Screening                                                           */
/* ------------------------------------------------------------------ */

describe("entity screening", () => {
  it("normalises names and scores containment above bare token overlap", () => {
    expect(normaliseName("Ironvale Construction Services, Ltd.")).toBe(
      "ironvale construction services ltd",
    );
    expect(nameMatchScore("Ironvale Construction", "Ironvale Construction Services Ltd")).toBeGreaterThan(0.6);
    expect(nameMatchScore("Ironvale", "Completely Different Co")).toBe(0);
  });

  it("matches a fixture designation and labels the snapshot it used", () => {
    const snapshot = fixtureSnapshot("uk_hmt");
    const matches = screenAgainst(
      { id: "ent_1", name: "Ironvale Construction Services Limited", kind: "company", jurisdiction: "GB" },
      snapshot,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.matchScore).toBeGreaterThan(0.9);
    expect(matches[0]!.fixture).toBe(true);
    expect(matches[0]!.listSource).toMatch(/SHIPPED FIXTURE/);
    expect(matches[0]!.listSnapshotHash).toHaveLength(64);
    expect(statusFromMatches(matches)).toBe("sanctions_hit");
  });

  it("returns nothing for a name that is not on the list", () => {
    const matches = screenAgainst(
      { id: "ent_2", name: "Perfectly Ordinary Builders", kind: "company", jurisdiction: "GB" },
      fixtureSnapshot("ofac_sdn"),
    );
    expect(matches).toHaveLength(0);
    expect(statusFromMatches(matches)).toBe("clear");
  });

  it("ranks debarment above sanctions above PEP when several lists hit", () => {
    expect(
      statusFromMatches([
        { list: "pep", listSource: "", listSnapshotHash: "", fixture: true, matchScore: 1, matchedName: "", matchedRef: "", detail: {} },
        { list: "world_bank_debarred", listSource: "", listSnapshotHash: "", fixture: true, matchScore: 1, matchedName: "", matchedRef: "", detail: {} },
      ]),
    ).toBe("debarred");
  });

  it("hashes the snapshot deterministically, so a clean result is reproducible", () => {
    expect(fixtureSnapshot("pep").snapshotHash).toBe(fixtureSnapshot("pep").snapshotHash);
    expect(fixtureSnapshot("pep").snapshotHash).not.toBe(fixtureSnapshot("ofac_sdn").snapshotHash);
  });
});
