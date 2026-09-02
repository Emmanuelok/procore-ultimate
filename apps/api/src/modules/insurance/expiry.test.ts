import { describe, expect, it } from "vitest";
import {
  addDays,
  bondCurrentExposure,
  bondsExpiringWithin,
  bondsPastDemandDeadline,
  certificatesExpiringWithin,
  computeCoverGaps,
  computeExpiryReport,
  computeNotificationWindow,
  coverGapKey,
  daysBetweenISO,
  derivePolicyStatus,
  expiredBonds,
  expiredCertificates,
  isCertificateInDate,
  isDemandOutOfTime,
  isIsoDate,
  isNotificationLate,
  lapsedPolicies,
  parseReductionSchedule,
  policiesExpiringWithin,
  policyPeriodGap,
  type BondLike,
  type CertificateLike,
  type PolicyLike,
  type VendorAtWork,
} from "./expiry.js";

const ASOF = "2026-06-01";

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

const policy = (over: Partial<PolicyLike> = {}): PolicyLike => ({
  id: "pol_1",
  number: "POL-0001",
  projectId: "prj_1",
  policyType: "contractors_all_risks",
  insurer: "Acme Re",
  policyNumber: "CAR/2026/1",
  periodStart: "2026-01-01",
  periodEnd: "2026-12-31",
  status: "active",
  limitOfIndemnity: 10_000_000,
  currency: "GBP",
  requiredByClause: null,
  ...over,
});

const cert = (over: Partial<CertificateLike> = {}): CertificateLike => ({
  id: "cert_1",
  projectId: "prj_1",
  policyId: null,
  vendorId: "ven_1",
  subjectName: "Groundworks Ltd",
  policyType: "employers_liability",
  validFrom: "2026-01-01",
  validTo: "2026-12-31",
  status: "active",
  verifiedAt: null,
  ...over,
});

const bond = (over: Partial<BondLike> = {}): BondLike => ({
  id: "bnd_1",
  number: "BND-0001",
  projectId: "prj_1",
  bondType: "performance",
  guarantor: "Surety Co",
  principalVendorId: "ven_1",
  amount: 1_000_000,
  currency: "GBP",
  status: "active",
  expiryAt: "2026-12-31",
  demandDeadline: "2026-11-30",
  reductionSchedule: [],
  ...over,
});

const atWork = (over: Partial<VendorAtWork> = {}): VendorAtWork => ({
  vendorId: "ven_1",
  vendorName: "Groundworks Ltd",
  projectId: "prj_1",
  source: "workers_on_site",
  ...over,
});

/* ------------------------------------------------------------------ */
/* Date primitives                                                     */
/* ------------------------------------------------------------------ */

describe("date primitives", () => {
  it("counts whole days in both directions and validates ISO dates", () => {
    expect(daysBetweenISO("2026-06-01", "2026-06-08")).toBe(7);
    expect(daysBetweenISO("2026-06-08", "2026-06-01")).toBe(-7);
    expect(daysBetweenISO("2026-06-01", "2026-06-01")).toBe(0);
    // across a month boundary and a leap day
    expect(daysBetweenISO("2028-02-28", "2028-03-01")).toBe(2);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(isIsoDate("2026-06-01")).toBe(true);
    expect(isIsoDate("01/06/2026")).toBe(false);
    expect(isIsoDate(null)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Policies                                                            */
/* ------------------------------------------------------------------ */

describe("policy expiry", () => {
  it("derives expiry from the period rather than trusting the stored status", () => {
    expect(derivePolicyStatus(policy(), ASOF)).toBe("active");
    expect(derivePolicyStatus(policy({ periodEnd: "2026-05-31" }), ASOF)).toBe("expired");
    // the last day of cover is still cover
    expect(derivePolicyStatus(policy({ periodEnd: ASOF }), ASOF)).toBe("active");
    // a draft or cancelled policy is never silently promoted to expired
    expect(derivePolicyStatus(policy({ status: "draft", periodEnd: "2020-01-01" }), ASOF)).toBe(
      "draft",
    );
    expect(
      derivePolicyStatus(policy({ status: "cancelled", periodEnd: "2020-01-01" }), ASOF),
    ).toBe("cancelled");
  });

  it("reports policies expiring inside the window, soonest first, excluding past ones", () => {
    const rows = [
      policy({ id: "a", periodEnd: "2026-06-10" }),
      policy({ id: "b", periodEnd: "2026-06-02" }),
      policy({ id: "c", periodEnd: "2026-09-01" }), // outside a 30-day window
      policy({ id: "d", periodEnd: "2026-05-01" }), // already lapsed, not "expiring"
      policy({ id: "e", periodEnd: "2026-06-05", status: "draft" }), // not on risk
    ];
    const out = policiesExpiringWithin(rows, ASOF, 30);
    expect(out.map((p) => p.policyId)).toEqual(["b", "a"]);
    expect(out[0]?.daysRemaining).toBe(1);
    expect(out[1]?.daysRemaining).toBe(9);
  });

  it("separates already-lapsed in-force policies from expiring ones", () => {
    const rows = [
      policy({ id: "past", periodEnd: "2026-04-01" }),
      policy({ id: "future", periodEnd: "2026-06-15" }),
    ];
    const lapsed = lapsedPolicies(rows, ASOF);
    expect(lapsed).toHaveLength(1);
    expect(lapsed[0]?.policyId).toBe("past");
    expect(lapsed[0]?.daysRemaining).toBeLessThan(0);
  });

  it("measures the policy-period versus works-period gap and refuses to guess", () => {
    const p = policy({ periodStart: "2026-02-01", periodEnd: "2026-10-01" });
    const gap = policyPeriodGap(p, "2026-01-01", "2026-12-01");
    expect(gap.uncoveredAtStartDays).toBe(31);
    expect(gap.uncoveredAtEndDays).toBe(61);
    expect(gap.covered).toBe(false);

    const flush = policyPeriodGap(p, "2026-03-01", "2026-09-01");
    expect(flush.covered).toBe(true);

    // unknown works dates yield null, never a false "covered"
    expect(policyPeriodGap(p, null, null).covered).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Certificates                                                        */
/* ------------------------------------------------------------------ */

describe("certificate expiry", () => {
  it("treats validity as inclusive at both ends", () => {
    expect(isCertificateInDate(cert({ validFrom: ASOF, validTo: ASOF }), ASOF)).toBe(true);
    expect(isCertificateInDate(cert({ validFrom: "2026-06-02" }), ASOF)).toBe(false);
    expect(isCertificateInDate(cert({ validTo: "2026-05-31" }), ASOF)).toBe(false);
    expect(isCertificateInDate(cert({ status: "withdrawn" }), ASOF)).toBe(false);
  });

  it("lists expiring and expired certificates separately", () => {
    const rows = [
      cert({ id: "soon", validTo: "2026-06-20" }),
      cert({ id: "later", validTo: "2026-12-01" }),
      cert({ id: "gone", validTo: "2026-05-20" }),
      cert({ id: "already-flagged", validTo: "2026-05-20", status: "expired" }),
    ];
    expect(certificatesExpiringWithin(rows, ASOF, 30).map((c) => c.certificateId)).toEqual([
      "soon",
    ]);
    const gone = expiredCertificates(rows, ASOF);
    expect(gone.map((c) => c.certificateId)).toEqual(["gone"]);
    expect(gone[0]?.daysRemaining).toBe(-12);
  });
});

/* ------------------------------------------------------------------ */
/* Cover gaps (#778)                                                   */
/* ------------------------------------------------------------------ */

describe("cover gap analysis", () => {
  it("refuses to answer when no cover requirement is recorded", () => {
    const res = computeCoverGaps({
      certificates: [],
      vendorsAtWork: [atWork()],
      requiredPolicyTypes: null,
      asOf: ASOF,
    });
    expect(res.requirementsKnown).toBe(false);
    expect(res.gaps).toEqual([]);
    expect(res.note).toMatch(/cannot be computed/i);

    const empty = computeCoverGaps({
      certificates: [],
      vendorsAtWork: [atWork()],
      requiredPolicyTypes: [],
      asOf: ASOF,
    });
    expect(empty.requirementsKnown).toBe(false);
  });

  it("flags a vendor at work with no certificate at all", () => {
    const res = computeCoverGaps({
      certificates: [],
      vendorsAtWork: [atWork()],
      requiredPolicyTypes: ["employers_liability", "third_party_liability"],
      asOf: ASOF,
    });
    expect(res.requirementsKnown).toBe(true);
    expect(res.gaps).toHaveLength(2);
    expect(res.gaps.every((g) => g.reason === "no_certificate")).toBe(true);
    expect(res.gaps[0]?.key).toBe(coverGapKey("prj_1", "ven_1", "employers_liability"));
  });

  it("distinguishes expired cover from cover that has not started", () => {
    const res = computeCoverGaps({
      certificates: [
        cert({ id: "old", policyType: "employers_liability", validTo: "2026-05-01" }),
        cert({
          id: "future",
          policyType: "third_party_liability",
          validFrom: "2026-07-01",
          validTo: "2027-07-01",
        }),
      ],
      vendorsAtWork: [atWork()],
      requiredPolicyTypes: ["employers_liability", "third_party_liability"],
      asOf: ASOF,
    });
    const byType = new Map(res.gaps.map((g) => [g.policyType, g] as const));
    expect(byType.get("employers_liability")?.reason).toBe("expired");
    expect(byType.get("employers_liability")?.lastValidTo).toBe("2026-05-01");
    expect(byType.get("third_party_liability")?.reason).toBe("not_yet_effective");
  });

  it("counts in-date cover as covered, and picks the latest certificate as the evidence of a gap", () => {
    const res = computeCoverGaps({
      certificates: [
        cert({ id: "stale", validTo: "2026-02-01" }),
        cert({ id: "newer", validTo: "2026-04-01" }),
      ],
      vendorsAtWork: [atWork()],
      requiredPolicyTypes: ["employers_liability"],
      asOf: ASOF,
    });
    expect(res.gaps).toHaveLength(1);
    expect(res.gaps[0]?.lastCertificateId).toBe("newer");

    const covered = computeCoverGaps({
      certificates: [cert({ id: "live", verifiedAt: "2026-01-05T00:00:00Z" })],
      vendorsAtWork: [atWork()],
      requiredPolicyTypes: ["employers_liability"],
      asOf: ASOF,
    });
    expect(covered.gaps).toEqual([]);
    expect(covered.unverified).toEqual([]);
  });

  it("separates unverified-but-in-date cover from an actual gap", () => {
    const res = computeCoverGaps({
      certificates: [cert({ id: "live", verifiedAt: null })],
      vendorsAtWork: [atWork()],
      requiredPolicyTypes: ["employers_liability"],
      asOf: ASOF,
    });
    expect(res.gaps).toEqual([]);
    expect(res.unverified).toHaveLength(1);
    expect(res.unverified[0]?.reason).toBe("unverified");
  });

  it("ignores another vendor's certificate and de-duplicates the vendor population", () => {
    const res = computeCoverGaps({
      certificates: [cert({ id: "someone-else", vendorId: "ven_2" })],
      vendorsAtWork: [
        atWork(),
        atWork({ source: "bond_principal" }), // same vendor, weaker trace
      ],
      requiredPolicyTypes: ["employers_liability"],
      asOf: ASOF,
    });
    expect(res.gaps).toHaveLength(1);
    expect(res.gaps[0]?.source).toBe("workers_on_site");
  });
});

/* ------------------------------------------------------------------ */
/* Bonds                                                               */
/* ------------------------------------------------------------------ */

describe("bond reduction schedule", () => {
  it("parses well-formed steps and counts the rest instead of dropping them silently", () => {
    const parsed = parseReductionSchedule([
      { trigger: "practical_completion", reducesToPercent: 50, occurredAt: "2026-03-01" },
      { trigger: "no date yet", reducesToPercent: 25 },
      { trigger: "bad percent", reducesToPercent: 150 },
      "not an object",
      null,
    ]);
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.unparsable).toBe(3);
    expect(parsed.steps[1]?.occurredAt).toBeNull();
    expect(parseReductionSchedule(undefined).steps).toEqual([]);
  });

  it("applies only triggered reductions and lets the lowest govern", () => {
    const b = bond({
      reductionSchedule: [
        { trigger: "pc", reducesToPercent: 50, occurredAt: "2026-03-01" },
        { trigger: "final_account", reducesToPercent: 25, occurredAt: null },
      ],
    });
    const e = bondCurrentExposure(b, ASOF);
    expect(e.faceAmount).toBe(1_000_000);
    expect(e.appliedPercent).toBe(50);
    expect(e.currentAmount).toBe(500_000);
    expect(e.pending).toHaveLength(1);

    const both = bondCurrentExposure(
      bond({
        reductionSchedule: [
          { trigger: "pc", reducesToPercent: 50, occurredAt: "2026-03-01" },
          { trigger: "final_account", reducesToPercent: 25, occurredAt: "2026-05-01" },
        ],
      }),
      ASOF,
    );
    expect(both.appliedPercent).toBe(25);
    expect(both.currentAmount).toBe(250_000);

    // a reduction dated in the future has not happened yet
    const future = bondCurrentExposure(
      bond({ reductionSchedule: [{ trigger: "pc", reducesToPercent: 50, occurredAt: "2026-08-01" }] }),
      ASOF,
    );
    expect(future.appliedPercent).toBe(100);
    expect(future.currentAmount).toBe(1_000_000);
  });
});

describe("bond deadlines", () => {
  it("finds live bonds past the demand deadline and ignores dead ones", () => {
    const rows = [
      bond({ id: "past", demandDeadline: "2026-05-01" }),
      bond({ id: "live", demandDeadline: "2026-07-01" }),
      bond({ id: "released", demandDeadline: "2026-05-01", status: "released" }),
      bond({ id: "draft", demandDeadline: "2026-05-01", status: "draft" }),
      bond({ id: "no-deadline", demandDeadline: null }),
    ];
    expect(bondsPastDemandDeadline(rows, ASOF).map((b) => b.bondId)).toEqual(["past"]);
  });

  it("treats the demand deadline as the operative date for the expiry window", () => {
    const rows = [
      bond({ id: "deadline-first", demandDeadline: "2026-06-20", expiryAt: "2026-12-31" }),
      bond({ id: "expiry-only", demandDeadline: null, expiryAt: "2026-06-25" }),
      bond({ id: "far", demandDeadline: "2026-11-30" }),
    ];
    const out = bondsExpiringWithin(rows, ASOF, 30);
    expect(out.map((b) => b.bondId)).toEqual(["deadline-first", "expiry-only"]);
    expect(out[0]?.daysRemaining).toBe(19);
  });

  it("flips live bonds whose expiry has passed", () => {
    const rows = [bond({ id: "gone", expiryAt: "2026-03-01" }), bond({ id: "ok" })];
    expect(expiredBonds(rows, ASOF).map((b) => b.bondId)).toEqual(["gone"]);
  });

  it("rules a demand out of time only after the deadline, never on it", () => {
    const b = bond({ demandDeadline: "2026-06-01" });
    expect(isDemandOutOfTime(b, "2026-05-31").outOfTime).toBe(false);
    expect(isDemandOutOfTime(b, "2026-06-01").outOfTime).toBe(false); // the deadline day counts
    const late = isDemandOutOfTime(b, "2026-06-04");
    expect(late.outOfTime).toBe(true);
    expect(late.daysLate).toBe(3);
    expect(late.deadline).toBe("2026-06-01");
    // no deadline recorded: nothing can be out of time, and we say so with null
    const none = isDemandOutOfTime(bond({ demandDeadline: null }), "2030-01-01");
    expect(none.outOfTime).toBe(false);
    expect(none.deadline).toBeNull();
    expect(none.daysLate).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Notification arithmetic (#783)                                      */
/* ------------------------------------------------------------------ */

describe("claim notification window", () => {
  it("counts the notification period off the aware date", () => {
    const w = computeNotificationWindow("2026-06-01", 14);
    expect(w.notificationDueAt).toBe("2026-06-15");
    expect(w.note).toBeNull();
    expect(computeNotificationWindow("2026-12-25", 14).notificationDueAt).toBe("2027-01-08");
    // a same-day notification duty is a real wording, not an error
    expect(computeNotificationWindow("2026-06-01", 0).notificationDueAt).toBe("2026-06-01");
  });

  it("returns no deadline, and says why, when the policy records no period", () => {
    const w = computeNotificationWindow("2026-06-01", null);
    expect(w.notificationDueAt).toBeNull();
    expect(w.notificationDays).toBeNull();
    expect(w.note).toMatch(/no notification period/i);
    expect(computeNotificationWindow("2026-06-01", undefined).notificationDueAt).toBeNull();
  });

  it("treats the due date itself as in time and anything after it as late", () => {
    expect(isNotificationLate("2026-06-15", "2026-06-15")).toBe(false);
    expect(isNotificationLate("2026-06-15", "2026-06-14")).toBe(false);
    expect(isNotificationLate("2026-06-15", "2026-06-16")).toBe(true);
    // no deadline computed: lateness cannot be asserted
    expect(isNotificationLate(null, "2030-01-01")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* The whole report                                                    */
/* ------------------------------------------------------------------ */

describe("computeExpiryReport", () => {
  it("assembles all four detectors and counts what needs a human today", () => {
    const report = computeExpiryReport({
      asOf: ASOF,
      windowDays: 30,
      policies: [
        policy({ id: "lapsed", periodEnd: "2026-05-01" }),
        policy({ id: "soon", periodEnd: "2026-06-20" }),
      ],
      certificates: [
        cert({ id: "cert-gone", validTo: "2026-05-02" }),
        cert({ id: "cert-soon", validTo: "2026-06-10", vendorId: "ven_2" }),
      ],
      bonds: [bond({ id: "bond-past", demandDeadline: "2026-04-01" })],
      vendorsAtWork: [atWork({ vendorId: "ven_3", vendorName: "Steel Ltd" })],
      requiredPolicyTypes: ["employers_liability"],
    });
    expect(report.policiesLapsed.map((p) => p.policyId)).toEqual(["lapsed"]);
    expect(report.policiesExpiring.map((p) => p.policyId)).toEqual(["soon"]);
    expect(report.certificatesExpired.map((c) => c.certificateId)).toEqual(["cert-gone"]);
    expect(report.certificatesExpiring.map((c) => c.certificateId)).toEqual(["cert-soon"]);
    expect(report.bondsPastDemandDeadline.map((b) => b.bondId)).toEqual(["bond-past"]);
    expect(report.coverGaps).toHaveLength(1);
    expect(report.coverRequirementsKnown).toBe(true);
    // 1 lapsed policy + 1 expired certificate + 1 dead bond + 1 gap
    expect(report.actionableCount).toBe(4);
  });

  it("stays silent about gaps, and says so, when nothing requires cover", () => {
    const report = computeExpiryReport({
      asOf: ASOF,
      windowDays: 30,
      policies: [],
      certificates: [],
      bonds: [],
      vendorsAtWork: [atWork()],
      requiredPolicyTypes: null,
    });
    expect(report.coverRequirementsKnown).toBe(false);
    expect(report.coverNote).toBeTruthy();
    expect(report.actionableCount).toBe(0);
  });

  it("is a pure function — the same input twice yields the same output", () => {
    const input = {
      asOf: ASOF,
      windowDays: 30,
      policies: [policy({ id: "lapsed", periodEnd: "2026-05-01" })],
      certificates: [cert({ id: "gone", validTo: "2026-05-02" })],
      bonds: [bond({ id: "past", demandDeadline: "2026-04-01" })],
      vendorsAtWork: [atWork()],
      requiredPolicyTypes: ["employers_liability"],
    };
    expect(computeExpiryReport(input)).toEqual(computeExpiryReport(input));
  });
});
