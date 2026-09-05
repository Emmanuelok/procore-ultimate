import { describe, expect, it } from "vitest";
import { bondCurrentExposure, type BondLike, type CertificateLike, type PolicyLike } from "./expiry.js";
import {
  addMonths,
  buildRenewalPipeline,
  checkRequirement,
  computeExperience,
  computePeriodGaps,
  evaluateHold,
  facilityUtilisation,
  findUninsuredLosses,
  requiredTypesForProject,
  type ClaimLike,
  type FacilityLike,
  type LossEventLike,
  type PremiumLike,
  type RequirementLike,
} from "./programme.js";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function policy(over: Partial<PolicyLike> & { id: string; number: string }): PolicyLike {
  return {
    projectId: null,
    policyType: "public_liability",
    insurer: "Acme Re",
    policyNumber: "PL/1",
    periodStart: "2026-01-01",
    periodEnd: "2026-12-31",
    status: "active",
    limitOfIndemnity: 10_000_000,
    currency: "GBP",
    requiredByClause: null,
    ...over,
  };
}

function requirement(over: Partial<RequirementLike> & { id: string }): RequirementLike {
  return {
    projectId: null,
    vendorId: null,
    policyType: "public_liability",
    requiredByClause: "FIDIC 18.3",
    minimumLimit: null,
    limitBasis: null,
    currency: "GBP",
    maximumDeductible: null,
    waiverOfSubrogation: 0,
    additionalInsuredRequired: 0,
    maintainMonthsAfterCompletion: null,
    territorialLimits: null,
    status: "required",
    ...over,
  };
}

function bond(over: Partial<BondLike & { facilityId: string | null }> & { id: string }) {
  return {
    number: "BND-0001",
    projectId: null,
    bondType: "performance",
    guarantor: "Surety Co",
    principalVendorId: null,
    amount: 1_000_000,
    currency: "GBP",
    status: "active",
    expiryAt: null,
    demandDeadline: null,
    reductionSchedule: [],
    facilityId: null,
    ...over,
  } as BondLike & { facilityId: string | null };
}

function facility(over: Partial<FacilityLike> & { id: string }): FacilityLike {
  return {
    number: "FAC-0001",
    name: "Surety line",
    provider: "Surety Co",
    projectId: null,
    limitAmount: 5_000_000,
    currency: "GBP",
    permittedBondTypes: [],
    status: "active",
    effectiveFrom: null,
    effectiveTo: null,
    reviewDate: null,
    ...over,
  };
}

function certificate(over: Partial<CertificateLike> & { id: string }): CertificateLike {
  return {
    projectId: null,
    policyId: null,
    vendorId: "ven_1",
    subjectName: "Groundworks Ltd",
    policyType: "public_liability",
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
    status: "active",
    verifiedAt: "2026-01-05T00:00:00.000Z",
    ...over,
  };
}

const exposure = (b: BondLike) => bondCurrentExposure(b, "2026-06-01").currentAmount;

/* ================================================================== */
/* 1. Facility headroom (#796)                                         */
/* ================================================================== */

describe("facilityUtilisation (#796)", () => {
  it("derives headroom from the live bonds drawn against the line", () => {
    const f = facility({ id: "fac_1", limitAmount: 5_000_000 });
    const out = facilityUtilisation(
      f,
      [
        bond({ id: "b1", facilityId: "fac_1", amount: 1_200_000 }),
        bond({ id: "b2", facilityId: "fac_1", amount: 800_000, status: "issued" }),
        bond({ id: "b3", facilityId: "fac_1", amount: 400_000, status: "released" }),
        bond({ id: "b4", facilityId: "other", amount: 999_000 }),
      ],
      exposure,
      "2026-06-01",
    );
    expect(out.drawnAmount).toBe(2_000_000);
    expect(out.headroom).toBe(3_000_000);
    expect(out.utilisationPct).toBe(40);
    expect(out.bondCount).toBe(2);
    expect(out.inForce).toBe(true);
  });

  it("honours reduction schedules through the supplied exposure function", () => {
    const reduced = bond({
      id: "b1",
      facilityId: "fac_1",
      amount: 1_000_000,
      reductionSchedule: [
        { trigger: "practical completion", reducesToPercent: 50, occurredAt: "2026-03-01" },
      ],
    });
    const out = facilityUtilisation(facility({ id: "fac_1" }), [reduced], exposure, "2026-06-01");
    expect(out.drawnAmount).toBe(500_000);
    expect(out.headroom).toBe(4_500_000);
  });

  it("never nets a foreign-currency bond against the line, and says why", () => {
    const out = facilityUtilisation(
      facility({ id: "fac_1", currency: "GBP" }),
      [
        bond({ id: "b1", facilityId: "fac_1", amount: 1_000_000 }),
        bond({ id: "b2", facilityId: "fac_1", amount: 2_000_000, currency: "USD" }),
      ],
      exposure,
      "2026-06-01",
    );
    expect(out.drawnAmount).toBe(1_000_000);
    expect(out.excludedForeignCurrency).toEqual([
      { bondId: "b2", currency: "USD", amount: 2_000_000 },
    ]);
    expect(out.reasons.join(" ")).toContain("different");
  });

  it("flags a bond type the facility does not permit but still counts the draw", () => {
    const out = facilityUtilisation(
      facility({ id: "fac_1", permittedBondTypes: ["performance"] }),
      [bond({ id: "b1", facilityId: "fac_1", bondType: "advance_payment", amount: 300_000 })],
      exposure,
      "2026-06-01",
    );
    expect(out.outsidePermittedTypes).toEqual(["advance_payment"]);
    expect(out.drawnAmount).toBe(300_000);
  });

  it("reports an over-drawn line rather than clamping at zero", () => {
    const out = facilityUtilisation(
      facility({ id: "fac_1", limitAmount: 1_000_000 }),
      [bond({ id: "b1", facilityId: "fac_1", amount: 1_500_000 })],
      exposure,
      "2026-06-01",
    );
    expect(out.headroom).toBe(-500_000);
    expect(out.reasons.join(" ")).toContain("over-drawn");
  });

  it("marks a suspended or out-of-date facility as not in force", () => {
    const suspended = facilityUtilisation(
      facility({ id: "f", status: "suspended" }),
      [],
      exposure,
      "2026-06-01",
    );
    expect(suspended.inForce).toBe(false);
    const lapsed = facilityUtilisation(
      facility({ id: "f", effectiveTo: "2026-05-01" }),
      [],
      exposure,
      "2026-06-01",
    );
    expect(lapsed.inForce).toBe(false);
    expect(lapsed.reasons.join(" ")).toContain("not in force");
  });
});

/* ================================================================== */
/* 2. Claims experience (#782)                                         */
/* ================================================================== */

describe("computeExperience (#782)", () => {
  const prem = (over: Partial<PremiumLike> & { id: string }): PremiumLike => ({
    policyId: "pol_1",
    kind: "premium",
    amount: 100_000,
    currency: "GBP",
    periodStart: null,
    periodEnd: null,
    paidAt: null,
    ...over,
  });
  const claim = (over: Partial<ClaimLike> & { id: string }): ClaimLike => ({
    policyId: "pol_1",
    projectId: null,
    status: "under_assessment",
    quantum: null,
    reserve: null,
    settledAmount: null,
    currency: "GBP",
    incidentDate: "2026-03-01",
    ...over,
  });

  it("computes the loss ratio from settled amounts plus reserves", () => {
    const out = computeExperience({
      premiums: [prem({ id: "p1", amount: 200_000 })],
      claims: [
        claim({ id: "c1", status: "settled", settledAmount: 40_000 }),
        claim({ id: "c2", status: "under_assessment", reserve: 60_000 }),
      ],
    });
    const gbp = out.byCurrency.find((b) => b.currency === "GBP")!;
    expect(gbp.claimsPaid).toBe(40_000);
    expect(gbp.claimsReserved).toBe(60_000);
    expect(gbp.claimsIncurred).toBe(100_000);
    expect(gbp.lossRatioPct).toBe(50);
  });

  it("nets return premium and keeps fees and levies out of the ratio", () => {
    const out = computeExperience({
      premiums: [
        prem({ id: "p1", amount: 100_000 }),
        prem({ id: "p2", kind: "return_premium", amount: 20_000 }),
        prem({ id: "p3", kind: "broker_fee", amount: 5_000 }),
        prem({ id: "p4", kind: "levy", amount: 1_000 }),
      ],
      claims: [claim({ id: "c1", status: "settled", settledAmount: 40_000 })],
    });
    const gbp = out.byCurrency[0]!;
    expect(gbp.premiumNet).toBe(80_000);
    expect(gbp.brokerFees).toBe(5_000);
    expect(gbp.levies).toBe(1_000);
    expect(gbp.lossRatioPct).toBe(50);
  });

  it("buckets by currency and never sums across", () => {
    const out = computeExperience({
      premiums: [
        prem({ id: "p1", amount: 100_000, currency: "GBP" }),
        prem({ id: "p2", amount: 50_000, currency: "USD" }),
      ],
      claims: [
        claim({ id: "c1", status: "settled", settledAmount: 10_000, currency: "GBP" }),
        claim({ id: "c2", status: "settled", settledAmount: 25_000, currency: "USD" }),
      ],
    });
    expect(out.byCurrency.map((b) => b.currency)).toEqual(["GBP", "USD"]);
    expect(out.byCurrency[0]!.lossRatioPct).toBe(10);
    expect(out.byCurrency[1]!.lossRatioPct).toBe(50);
  });

  it("refuses a ratio when no premium is recorded, with a reason", () => {
    const out = computeExperience({
      premiums: [],
      claims: [claim({ id: "c1", status: "settled", settledAmount: 10_000 })],
    });
    const gbp = out.byCurrency[0]!;
    expect(gbp.lossRatioPct).toBeNull();
    expect(gbp.reasons.join(" ")).toContain("No premium is recorded");
  });

  it("counts an unvalued live claim without valuing it", () => {
    const out = computeExperience({
      premiums: [prem({ id: "p1" })],
      claims: [claim({ id: "c1", status: "notified" })],
    });
    const gbp = out.byCurrency[0]!;
    expect(gbp.claimCount).toBe(1);
    expect(gbp.claimsIncurred).toBe(0);
    expect(out.note).toContain("counted, not valued");
  });

  it("reports a premium row whose currency disagrees with its policy", () => {
    const out = computeExperience({
      premiums: [prem({ id: "p1", currency: "USD" })],
      claims: [],
      policyCurrency: new Map([["pol_1", "GBP"]]),
    });
    expect(out.currencyMismatches).toEqual([{ premiumId: "p1", policyId: "pol_1" }]);
  });

  it("ignores repudiated and withdrawn claims in the incurred figure", () => {
    const out = computeExperience({
      premiums: [prem({ id: "p1", amount: 100_000 })],
      claims: [
        claim({ id: "c1", status: "repudiated", quantum: 500_000 }),
        claim({ id: "c2", status: "withdrawn", quantum: 500_000 }),
      ],
    });
    expect(out.byCurrency[0]!.claimsIncurred).toBe(0);
    expect(out.byCurrency[0]!.claimCount).toBe(2);
    expect(out.note).toBeNull();
  });
});

/* ================================================================== */
/* 3. Wording checks                                                   */
/* ================================================================== */

describe("checkRequirement", () => {
  it("passes a policy that meets the clause on every recorded term", () => {
    const out = checkRequirement(
      requirement({ id: "r1", minimumLimit: 5_000_000 }),
      [policy({ id: "pol_1", number: "POL-0001", limitOfIndemnity: 10_000_000 })],
      "2026-06-01",
    );
    expect(out.compliant).toBe(true);
    expect(out.satisfiedBy).toBe("pol_1");
  });

  it("reports the absence of any policy of the class as critical", () => {
    const out = checkRequirement(
      requirement({ id: "r1", policyType: "professional_indemnity" }),
      [policy({ id: "pol_1", number: "POL-0001" })],
      "2026-06-01",
    );
    expect(out.compliant).toBe(false);
    expect(out.findings[0]!.code).toBe("no_policy");
    expect(out.findings[0]!.severity).toBe("critical");
  });

  it("quantifies a shortfall against the required limit", () => {
    const out = checkRequirement(
      requirement({ id: "r1", minimumLimit: 20_000_000 }),
      [policy({ id: "pol_1", number: "POL-0001", limitOfIndemnity: 10_000_000 })],
      "2026-06-01",
    );
    const f = out.findings.find((x) => x.code === "limit_below_requirement")!;
    expect(f.detail).toContain("shortfall of GBP 10000000");
  });

  it("refuses to compare limits across currencies", () => {
    const out = checkRequirement(
      requirement({ id: "r1", minimumLimit: 5_000_000, currency: "USD" }),
      [policy({ id: "pol_1", number: "POL-0001", currency: "GBP" })],
      "2026-06-01",
    );
    expect(out.findings.map((f) => f.code)).toContain("currency_mismatch");
  });

  it("treats an unrecorded limit as unknown, not as nil", () => {
    const out = checkRequirement(
      requirement({ id: "r1", minimumLimit: 5_000_000 }),
      [policy({ id: "pol_1", number: "POL-0001", limitOfIndemnity: null })],
      "2026-06-01",
    );
    expect(out.findings[0]!.code).toBe("limit_unknown");
  });

  it("finds a missing waiver of subrogation from the recorded conditions", () => {
    const withWaiver = checkRequirement(
      requirement({ id: "r1", waiverOfSubrogation: 1 }),
      [policy({ id: "pol_1", number: "POL-0001" })],
      "2026-06-01",
      {
        conditionsById: new Map([
          ["pol_1", [{ ref: "3", text: "Insurer waives subrogation against the Employer" }]],
        ]),
      },
    );
    expect(withWaiver.compliant).toBe(true);
    const without = checkRequirement(
      requirement({ id: "r1", waiverOfSubrogation: 1 }),
      [policy({ id: "pol_1", number: "POL-0001" })],
      "2026-06-01",
      { conditionsById: new Map([["pol_1", [{ ref: "3", text: "Standard exclusions apply" }]]]) },
    );
    expect(without.findings.map((f) => f.code)).toContain("waiver_of_subrogation_missing");
  });

  it("finds a missing additional-insured endorsement", () => {
    const out = checkRequirement(
      requirement({ id: "r1", additionalInsuredRequired: 1 }),
      [policy({ id: "pol_1", number: "POL-0001" })],
      "2026-06-01",
      { conditionsById: new Map() },
    );
    expect(out.findings.map((f) => f.code)).toContain("additional_insured_missing");
  });

  it("flags a deductible above the contractual maximum", () => {
    const out = checkRequirement(
      requirement({ id: "r1", maximumDeductible: 10_000 }),
      [{ ...policy({ id: "pol_1", number: "POL-0001" }), deductible: 25_000 } as PolicyLike],
      "2026-06-01",
    );
    expect(out.findings.map((f) => f.code)).toContain("deductible_above_maximum");
  });

  it("flags cover that expires before the maintenance period ends", () => {
    const out = checkRequirement(
      requirement({ id: "r1", maintainMonthsAfterCompletion: 12 }),
      [policy({ id: "pol_1", number: "POL-0001", periodEnd: "2026-12-31" })],
      "2026-06-01",
      { worksEnd: "2026-10-01" },
    );
    const f = out.findings.find((x) => x.code === "period_ends_before_maintenance_period")!;
    expect(f.detail).toContain("2027-10-01");
  });

  it("reports a policy that exists but is not on risk", () => {
    const out = checkRequirement(
      requirement({ id: "r1" }),
      [policy({ id: "pol_1", number: "POL-0001", status: "lapsed" })],
      "2026-06-01",
    );
    expect(out.findings.map((f) => f.code)).toContain("not_in_force");
  });
});

describe("addMonths", () => {
  it("adds calendar months and clamps to the end of a shorter month", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-10-01", 12)).toBe("2027-10-01");
    expect(addMonths("2026-12-15", 3)).toBe("2027-03-15");
  });
});

/* ================================================================== */
/* 4. Period gaps (#777)                                               */
/* ================================================================== */

describe("computePeriodGaps (#777)", () => {
  it("finds uncovered days at both ends of the works", () => {
    const out = computePeriodGaps({
      projectId: "prj_1",
      worksStart: "2026-01-01",
      worksEnd: "2027-01-31",
      requirements: [requirement({ id: "r1", projectId: "prj_1" })],
      policies: [
        policy({
          id: "pol_1",
          number: "POL-0001",
          projectId: "prj_1",
          periodStart: "2026-02-01",
          periodEnd: "2026-12-31",
        }),
      ],
    });
    expect(out.gaps).toHaveLength(1);
    expect(out.gaps[0]!.uncoveredAtStartDays).toBe(31);
    expect(out.gaps[0]!.uncoveredAtEndDays).toBe(31);
  });

  it("treats back-to-back renewals as continuous cover", () => {
    const out = computePeriodGaps({
      projectId: "prj_1",
      worksStart: "2026-01-01",
      worksEnd: "2027-06-30",
      requirements: [requirement({ id: "r1", projectId: "prj_1" })],
      policies: [
        policy({
          id: "pol_1",
          number: "POL-0001",
          projectId: "prj_1",
          periodStart: "2026-01-01",
          periodEnd: "2026-12-31",
        }),
        policy({
          id: "pol_2",
          number: "POL-0002",
          projectId: "prj_1",
          periodStart: "2027-01-01",
          periodEnd: "2027-12-31",
        }),
      ],
    });
    expect(out.gaps).toHaveLength(0);
  });

  it("refuses the analysis when the works dates are unknown", () => {
    const out = computePeriodGaps({
      projectId: "prj_1",
      worksStart: null,
      worksEnd: "2027-01-01",
      requirements: [requirement({ id: "r1" })],
      policies: [],
    });
    expect(out.gaps).toEqual([]);
    expect(out.reasons.join(" ")).toContain("no start and end date");
  });

  it("refuses the analysis when no requirement is recorded", () => {
    const out = computePeriodGaps({
      projectId: "prj_1",
      worksStart: "2026-01-01",
      worksEnd: "2026-12-31",
      requirements: [],
      policies: [policy({ id: "pol_1", number: "POL-0001" })],
    });
    expect(out.reasons.join(" ")).toContain("No live insurance requirement");
  });

  it("leaves the complete absence of a policy to the cover-gap detector", () => {
    const out = computePeriodGaps({
      projectId: "prj_1",
      worksStart: "2026-01-01",
      worksEnd: "2026-12-31",
      requirements: [requirement({ id: "r1", policyType: "professional_indemnity" })],
      policies: [policy({ id: "pol_1", number: "POL-0001" })],
    });
    expect(out.gaps).toEqual([]);
  });
});

/* ================================================================== */
/* 5. Uninsured losses (#787)                                          */
/* ================================================================== */

describe("findUninsuredLosses (#787)", () => {
  const loss = (over: Partial<LossEventLike> & { recordId: string }): LossEventLike => ({
    recordType: "safety_incident",
    projectId: "prj_1",
    title: "Scaffold collapse",
    occurredAt: "2026-06-01",
    lossAmount: 250_000,
    currency: "GBP",
    policyType: "public_liability",
    ...over,
  });

  it("flags an insured loss for which nobody raised a claim", () => {
    const out = findUninsuredLosses({
      losses: [loss({ recordId: "inc_1" })],
      policies: [policy({ id: "pol_1", number: "POL-0001", projectId: "prj_1" })],
      deductibleById: new Map([["pol_1", 10_000]]),
      claims: [],
      claimedRecordIds: new Set(),
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.reason).toBe("no_claim_raised");
    expect(out[0]!.detail).toContain("condition");
  });

  it("stays silent once a claim references the record", () => {
    const out = findUninsuredLosses({
      losses: [loss({ recordId: "inc_1" })],
      policies: [policy({ id: "pol_1", number: "POL-0001", projectId: "prj_1" })],
      deductibleById: new Map(),
      claims: [],
      claimedRecordIds: new Set(["inc_1"]),
    });
    expect(out).toEqual([]);
  });

  it("names the absence of the class of cover", () => {
    const out = findUninsuredLosses({
      losses: [loss({ recordId: "inc_1", policyType: "employers_liability" })],
      policies: [policy({ id: "pol_1", number: "POL-0001", projectId: "prj_1" })],
      deductibleById: new Map(),
      claims: [],
      claimedRecordIds: new Set(),
    });
    expect(out[0]!.reason).toBe("no_policy_of_class");
  });

  it("recognises a loss outside every policy period", () => {
    const out = findUninsuredLosses({
      losses: [loss({ recordId: "inc_1", occurredAt: "2025-06-01" })],
      policies: [policy({ id: "pol_1", number: "POL-0001", projectId: "prj_1" })],
      deductibleById: new Map(),
      claims: [],
      claimedRecordIds: new Set(),
    });
    expect(out[0]!.reason).toBe("outside_policy_period");
  });

  it("recognises a loss that would recover nothing below the deductible", () => {
    const out = findUninsuredLosses({
      losses: [loss({ recordId: "inc_1", lossAmount: 5_000 })],
      policies: [policy({ id: "pol_1", number: "POL-0001", projectId: "prj_1" })],
      deductibleById: new Map([["pol_1", 10_000]]),
      claims: [],
      claimedRecordIds: new Set(),
    });
    expect(out[0]!.reason).toBe("below_deductible");
  });

  it("ignores a record with no mapped class of cover", () => {
    const out = findUninsuredLosses({
      losses: [loss({ recordId: "inc_1", policyType: null })],
      policies: [],
      deductibleById: new Map(),
      claims: [],
      claimedRecordIds: new Set(),
    });
    expect(out).toEqual([]);
  });
});

/* ================================================================== */
/* 6. Renewal pipeline (#775)                                          */
/* ================================================================== */

describe("buildRenewalPipeline (#775)", () => {
  const renewable = (over: Partial<PolicyLike> & { id: string; number: string }) => ({
    ...policy(over),
    renewalStatus: "not_started",
    renewalOwnerId: null,
    renewalTargetDate: null,
    renewedByPolicyId: null,
  });

  it("marks a renewal past its lead time as critical", () => {
    const rows = buildRenewalPipeline({
      policies: [renewable({ id: "pol_1", number: "POL-0001", periodEnd: "2026-06-20" })],
      asOf: "2026-06-01",
      leadTimeDays: 30,
    });
    expect(rows[0]!.urgency).toBe("critical");
    expect(rows[0]!.behindByDays).toBe(11);
  });

  it("marks an expired unrenewed policy as overdue", () => {
    const rows = buildRenewalPipeline({
      policies: [renewable({ id: "pol_1", number: "POL-0001", periodEnd: "2026-05-01" })],
      asOf: "2026-06-01",
    });
    expect(rows[0]!.urgency).toBe("overdue");
    expect(rows[0]!.reason).toContain("expired 31 day(s) ago");
  });

  it("drops bound, not-renewing and already-renewed policies", () => {
    const rows = buildRenewalPipeline({
      policies: [
        { ...renewable({ id: "a", number: "A", periodEnd: "2026-06-10" }), renewalStatus: "bound" },
        {
          ...renewable({ id: "b", number: "B", periodEnd: "2026-06-10" }),
          renewalStatus: "not_renewing",
        },
        {
          ...renewable({ id: "c", number: "C", periodEnd: "2026-06-10" }),
          renewedByPolicyId: "pol_next",
        },
      ],
      asOf: "2026-06-01",
    });
    expect(rows).toEqual([]);
  });

  it("respects an explicit renewal target date over the default lead time", () => {
    const rows = buildRenewalPipeline({
      policies: [
        {
          ...renewable({ id: "pol_1", number: "POL-0001", periodEnd: "2026-06-25" }),
          renewalTargetDate: "2026-06-20",
        },
      ],
      asOf: "2026-06-01",
      leadTimeDays: 30,
    });
    expect(rows[0]!.behindByDays).toBeNull();
    expect(rows[0]!.urgency).toBe("warning");
  });

  it("ignores policies beyond the horizon", () => {
    const rows = buildRenewalPipeline({
      policies: [renewable({ id: "pol_1", number: "POL-0001", periodEnd: "2027-06-01" })],
      asOf: "2026-06-01",
      horizonDays: 120,
    });
    expect(rows).toEqual([]);
  });
});

/* ================================================================== */
/* 7. The payment hold hook                                            */
/* ================================================================== */

describe("evaluateHold", () => {
  const args = (over: Partial<Parameters<typeof evaluateHold>[0]> = {}) => ({
    vendorId: "ven_1",
    projectId: "prj_1" as string | null,
    requirements: [requirement({ id: "r1", projectId: "prj_1", policyType: "public_liability" })],
    certificates: [certificate({ id: "cert_1" })],
    certificateLimits: new Map([["cert_1", { limit: 10_000_000, currency: "GBP" }]]),
    policies: [] as PolicyLike[],
    asOf: "2026-06-01",
    ...over,
  });

  it("releases when in-date verified cover meets the requirement", () => {
    const out = evaluateHold(args());
    expect(out.hold).toBe(false);
    expect(out.findings).toEqual([]);
    expect(out.requirementsKnown).toBe(true);
  });

  it("refuses to answer when no requirement is recorded, and says so", () => {
    const out = evaluateHold(args({ requirements: [] }));
    expect(out.hold).toBe(false);
    expect(out.requirementsKnown).toBe(false);
    expect(out.note).toContain("NOT a statement that the vendor is compliant");
  });

  it("holds when no certificate has ever been collected", () => {
    const out = evaluateHold(args({ certificates: [] }));
    expect(out.hold).toBe(true);
    expect(out.findings[0]!.reason).toBe("no_certificate");
  });

  it("holds on an expired certificate and names the date", () => {
    const out = evaluateHold(
      args({ certificates: [certificate({ id: "cert_1", validTo: "2026-01-31" })] }),
    );
    expect(out.hold).toBe(true);
    expect(out.findings[0]!.reason).toBe("certificate_expired");
    expect(out.findings[0]!.detail).toContain("2026-01-31");
  });

  it("holds when the certificate limit is below the required limit", () => {
    const out = evaluateHold(
      args({
        requirements: [requirement({ id: "r1", projectId: "prj_1", minimumLimit: 20_000_000 })],
      }),
    );
    expect(out.hold).toBe(true);
    expect(out.findings[0]!.reason).toBe("limit_below_requirement");
  });

  it("warns rather than holds on an unverified certificate", () => {
    const out = evaluateHold(
      args({ certificates: [certificate({ id: "cert_1", verifiedAt: null })] }),
    );
    expect(out.hold).toBe(false);
    expect(out.warnings.map((w) => w.reason)).toContain("certificate_unverified");
  });

  it("warns rather than holds when the recorded limit is unknown", () => {
    const out = evaluateHold(
      args({
        requirements: [requirement({ id: "r1", projectId: "prj_1", minimumLimit: 5_000_000 })],
        certificateLimits: new Map([["cert_1", { limit: null, currency: "GBP" }]]),
      }),
    );
    expect(out.hold).toBe(false);
    expect(out.warnings[0]!.detail).toContain("gap in your own");
  });

  it("ignores requirements recorded against a different vendor", () => {
    const out = evaluateHold(
      args({
        requirements: [
          requirement({ id: "r1", projectId: "prj_1", vendorId: "ven_other" }),
        ],
        certificates: [],
      }),
    );
    expect(out.requirementsKnown).toBe(false);
    expect(out.hold).toBe(false);
  });

  it("applies a company-wide requirement to a project payment", () => {
    const out = evaluateHold(
      args({ requirements: [requirement({ id: "r1", projectId: null })], certificates: [] }),
    );
    expect(out.hold).toBe(true);
  });
});

/* ================================================================== */
/* 8. Requirement resolution (the cross-project false-positive bug)    */
/* ================================================================== */

describe("requiredTypesForProject", () => {
  it("applies a project requirement only to its own project", () => {
    const reqs = [
      requirement({ id: "r1", projectId: "prj_a", policyType: "professional_indemnity" }),
      requirement({ id: "r2", projectId: null, policyType: "public_liability" }),
    ];
    expect(requiredTypesForProject(reqs, "prj_a")).toEqual([
      "professional_indemnity",
      "public_liability",
    ]);
    expect(requiredTypesForProject(reqs, "prj_b")).toEqual(["public_liability"]);
  });

  it("ignores waived and superseded requirements", () => {
    const reqs = [
      requirement({ id: "r1", projectId: null, status: "waived" }),
      requirement({
        id: "r2",
        projectId: null,
        status: "superseded",
        policyType: "employers_liability",
      }),
    ];
    expect(requiredTypesForProject(reqs, "prj_a")).toEqual([]);
  });
});
