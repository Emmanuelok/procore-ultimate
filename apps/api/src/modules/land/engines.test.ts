/**
 * Unit tests for the pure land / resettlement engines: replacement cost,
 * the IFC PS5 conformance detectors, the grievance escalation ladder and
 * hotspot clustering, and the consent-to-programme view.
 *
 * Nothing here touches the database.
 */
import { describe, expect, it } from "vitest";
import {
  REPLACEMENT_TOLERANCE,
  computeReplacementCost,
  summariseReplacement,
} from "./replacement.js";
import {
  LIVELIHOOD_TEST_DAYS,
  detectCutOffNotDisclosed,
  detectDisplacementBeforeCompensation,
  detectLivelihoodNotRestored,
  detectVulnerableWithoutEnhancement,
  hasEnhancedEntitlement,
  type Ps5Pap,
  type Ps5Parcel,
  type Ps5Task,
} from "./ps5.js";
import {
  HOTSPOT_MIN_COUNT,
  detectHotspots,
  ladderDecision,
  type LadderGrievance,
} from "./grievance-engine.js";
import {
  DEFAULT_RESOLUTION_DAYS,
  MIN_OBSERVATIONS,
  UNKNOWN_STATE_DAYS,
  addDays,
  buildConsentView,
  estimateResolutionDays,
  medianOf,
  type ConsentDependency,
  type ConsentTask,
} from "./consent.js";

/* ================================================================== */
/* Replacement cost (#550, IFC PS5 para 27)                            */
/* ================================================================== */

describe("computeReplacementCost", () => {
  it("does NOT deduct depreciation — that is the whole point of PS5 para 27", () => {
    const r = computeReplacementCost({
      marketValue: 10_000,
      depreciationDeducted: 4_000,
      transactionCosts: 500,
      compensationOffered: 6_000,
    });
    // 10,000 + 500, with the 4,000 depreciation carried but never applied
    expect(r.replacementCost).toBe(10_500);
    expect(r.shortfall).toBe(4_500);
    expect(r.verdict).toBe("shortfall");
    expect(r.basis).toContain("does not permit");
  });

  it("reports adequacy when compensation meets replacement cost", () => {
    const r = computeReplacementCost({
      marketValue: 10_000,
      transactionCosts: 500,
      compensationOffered: 10_500,
    });
    expect(r.verdict).toBe("adequate");
    expect(r.shortfall).toBe(0);
    expect(r.shortfallPercent).toBe(0);
  });

  it("treats a rounding-sized gap as adequate but a real one as a shortfall", () => {
    const rounding = computeReplacementCost({
      marketValue: 10_000,
      compensationOffered: 10_000 - REPLACEMENT_TOLERANCE,
    });
    expect(rounding.verdict).toBe("adequate");
    const real = computeReplacementCost({
      marketValue: 10_000,
      compensationOffered: 10_000 - REPLACEMENT_TOLERANCE - 0.01,
    });
    expect(real.verdict).toBe("shortfall");
  });

  it("is unverified — not adequate — when no compensation has been recorded", () => {
    const r = computeReplacementCost({ marketValue: 8_000, transactionCosts: 200 });
    expect(r.verdict).toBe("unverified");
    expect(r.shortfall).toBeNull();
    expect(r.shortfallPercent).toBeNull();
    expect(r.basis).toContain("unverified");
  });

  it("handles a zero market value without dividing by zero", () => {
    const r = computeReplacementCost({ marketValue: 0, compensationOffered: 0 });
    expect(r.replacementCost).toBe(0);
    expect(r.shortfallPercent).toBeNull();
    expect(r.verdict).toBe("adequate");
  });
});

describe("summariseReplacement", () => {
  it("reports the adequate share of VERIFIED studies, not of all studies", () => {
    const s = summariseReplacement([
      { verdict: "adequate", replacementCost: 100, compensationOffered: 100, shortfall: 0 },
      { verdict: "shortfall", replacementCost: 100, compensationOffered: 60, shortfall: 40 },
      { verdict: "unverified", replacementCost: 100, compensationOffered: null, shortfall: null },
    ]);
    expect(s.studies).toBe(3);
    expect(s.verified).toBe(2);
    expect(s.adequateSharePercent).toBe(50);
    // negative "shortfalls" (over-compensation) do not offset real ones
    expect(s.totalShortfall).toBe(40);
  });

  it("returns null rather than 0% when nothing has been verified", () => {
    const s = summariseReplacement([
      { verdict: "unverified", replacementCost: 10, compensationOffered: null, shortfall: null },
    ]);
    expect(s.adequateSharePercent).toBeNull();
  });
});

/* ================================================================== */
/* IFC PS5 conformance detectors                                       */
/* ================================================================== */

const parcel = (over: Partial<Ps5Parcel> = {}): Ps5Parcel => ({
  id: "lpc_1",
  reference: "P-001",
  status: "agreed",
  compensationPaidAt: null,
  acquisitionBasis: null,
  tenureType: "freehold",
  blockingTaskIds: [],
  ...over,
});

const pap = (over: Partial<Ps5Pap> = {}): Ps5Pap => ({
  id: "pap_1",
  reference: "PAP-001",
  householdHead: "A. Household",
  status: "entitlement_agreed",
  displacementType: "physical",
  vulnerabilities: [],
  entitlements: [],
  compensationPaidAt: null,
  livelihoodRestoredAt: null,
  ...over,
});

describe("detectDisplacementBeforeCompensation", () => {
  it("flags a parcel recorded as acquired with no payment", () => {
    const f = detectDisplacementBeforeCompensation({
      parcels: [parcel({ status: "acquired" })],
      paps: [],
      tasksById: new Map(),
    });
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("critical");
    expect(f[0]!.key).toBe("parcel:lpc_1");
    expect(f[0]!.explanation).toContain("Performance Standard 5");
  });

  it("does NOT flag a donated or state-allocated parcel with no works started", () => {
    for (const basis of ["donation", "state_allocation", "court_order"]) {
      const f = detectDisplacementBeforeCompensation({
        parcels: [parcel({ status: "acquired", acquisitionBasis: basis })],
        paps: [],
        tasksById: new Map(),
      });
      expect(f, basis).toHaveLength(0);
    }
  });

  it("DOES flag a donated parcel once works have physically started on it", () => {
    const tasks = new Map<string, Ps5Task>([
      ["tsk_1", { id: "tsk_1", name: "Earthworks", actualStart: "2026-01-05" }],
    ]);
    const f = detectDisplacementBeforeCompensation({
      parcels: [
        parcel({ status: "agreed", acquisitionBasis: "donation", blockingTaskIds: ["tsk_1"] }),
      ],
      paps: [],
      tasksById: tasks,
    });
    expect(f).toHaveLength(1);
    expect(f[0]!.explanation).toContain("Earthworks");
  });

  it("flags a household resettled with no payment, and clears once paid", () => {
    const flagged = detectDisplacementBeforeCompensation({
      parcels: [],
      paps: [pap({ status: "resettled" })],
      tasksById: new Map(),
    });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.key).toBe("pap:pap_1");

    const paid = detectDisplacementBeforeCompensation({
      parcels: [],
      paps: [pap({ status: "resettled", compensationPaidAt: "2026-02-01" })],
      tasksById: new Map(),
    });
    expect(paid).toHaveLength(0);
  });

  it("says nothing about a parcel still under negotiation with no works", () => {
    const f = detectDisplacementBeforeCompensation({
      parcels: [parcel({ status: "under_negotiation" })],
      paps: [],
      tasksById: new Map(),
    });
    expect(f).toHaveLength(0);
  });
});

describe("hasEnhancedEntitlement / detectVulnerableWithoutEnhancement", () => {
  it("recognises livelihood, transitional and assistance items", () => {
    expect(hasEnhancedEntitlement([{ item: "Livelihood restoration grant", basis: "x" }])).toBe(
      true,
    );
    expect(hasEnhancedEntitlement([{ item: "Transitional allowance", basis: "x" }])).toBe(true);
    expect(hasEnhancedEntitlement([{ item: "Crop compensation", basis: "schedule" }])).toBe(false);
    expect(hasEnhancedEntitlement(["not an object", null, 7])).toBe(false);
  });

  it("flags a vulnerable household given only the standard matrix", () => {
    const f = detectVulnerableWithoutEnhancement([
      pap({
        vulnerabilities: ["female_headed", "below_poverty_line"],
        entitlements: [{ item: "Crop compensation", basis: "district schedule", amount: 100 }],
      }),
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("high");
    expect(f[0]!.explanation).toContain("female_headed");
  });

  it("stays silent when the matrix has not been applied yet — that is a different problem", () => {
    const f = detectVulnerableWithoutEnhancement([
      pap({ vulnerabilities: ["elderly"], entitlements: [] }),
    ]);
    expect(f).toHaveLength(0);
  });

  it("stays silent for a non-vulnerable household", () => {
    const f = detectVulnerableWithoutEnhancement([
      pap({ entitlements: [{ item: "Crop compensation", basis: "schedule" }] }),
    ]);
    expect(f).toHaveLength(0);
  });
});

describe("detectCutOffNotDisclosed", () => {
  const base = { projectId: "prj_1", cutOffDate: "2026-01-31", declaredAt: "2026-02-01T00:00:00Z" };

  it("flags a declared cut-off with no disclosure engagement after it", () => {
    const f = detectCutOffNotDisclosed({
      ...base,
      engagements: [{ id: "e1", kind: "meeting", engagementDate: "2026-02-10" }],
    });
    expect(f).toHaveLength(1);
    expect(f[0]!.key).toBe("project:prj_1:2026-01-31");
  });

  it("clears once a disclosure engagement is logged on or after the declaration", () => {
    const f = detectCutOffNotDisclosed({
      ...base,
      engagements: [{ id: "e1", kind: "disclosure", engagementDate: "2026-02-01" }],
    });
    expect(f).toHaveLength(0);
  });

  it("does not count a disclosure that predates the declaration", () => {
    const f = detectCutOffNotDisclosed({
      ...base,
      engagements: [{ id: "e1", kind: "disclosure", engagementDate: "2026-01-20" }],
    });
    expect(f).toHaveLength(1);
  });

  it("says nothing when no cut-off is declared", () => {
    expect(
      detectCutOffNotDisclosed({ projectId: "p", cutOffDate: null, declaredAt: null, engagements: [] }),
    ).toHaveLength(0);
  });
});

describe("detectLivelihoodNotRestored", () => {
  const args = {
    physicalDisplacementTypes: ["physical", "both"],
    livelihoodRequiredTypes: ["economic", "both"],
  };

  it("flags a compensated household a year past displacement with no restoration", () => {
    const paidAt = addDays("2026-09-06", -(LIVELIHOOD_TEST_DAYS + 1));
    const f = detectLivelihoodNotRestored({
      ...args,
      paps: [pap({ displacementType: "economic", compensationPaidAt: paidAt })],
      today: "2026-09-06",
    });
    expect(f).toHaveLength(1);
    expect(f[0]!.evidenceRefs["daysSinceDisplacement"]).toBe(LIVELIHOOD_TEST_DAYS + 1);
  });

  it("does not flag before the twelve-month test point", () => {
    const paidAt = addDays("2026-09-06", -(LIVELIHOOD_TEST_DAYS - 1));
    const f = detectLivelihoodNotRestored({
      ...args,
      paps: [pap({ displacementType: "economic", compensationPaidAt: paidAt })],
      today: "2026-09-06",
    });
    expect(f).toHaveLength(0);
  });

  it("does not flag an unpaid household — that is the earlier finding, not this one", () => {
    const f = detectLivelihoodNotRestored({
      ...args,
      paps: [pap({ displacementType: "economic", compensationPaidAt: null })],
      today: "2026-09-06",
    });
    expect(f).toHaveLength(0);
  });

  it("clears once restoration is dated or the status says so", () => {
    const paidAt = addDays("2026-09-06", -800);
    expect(
      detectLivelihoodNotRestored({
        ...args,
        paps: [
          pap({
            displacementType: "both",
            compensationPaidAt: paidAt,
            livelihoodRestoredAt: "2026-06-01",
          }),
        ],
        today: "2026-09-06",
      }),
    ).toHaveLength(0);
    expect(
      detectLivelihoodNotRestored({
        ...args,
        paps: [
          pap({
            displacementType: "both",
            compensationPaidAt: paidAt,
            status: "livelihood_restored",
          }),
        ],
        today: "2026-09-06",
      }),
    ).toHaveLength(0);
  });

  it("ignores a household with no displacement at all", () => {
    const f = detectLivelihoodNotRestored({
      ...args,
      paps: [
        pap({
          displacementType: "none",
          compensationPaidAt: addDays("2026-09-06", -900),
        }),
      ],
      today: "2026-09-06",
    });
    expect(f).toHaveLength(0);
  });
});

/* ================================================================== */
/* Grievance escalation ladder & hotspots (#572, #574)                 */
/* ================================================================== */

const grv = (over: Partial<LadderGrievance> = {}): LadderGrievance => ({
  id: "grv_1",
  number: 1,
  severity: "medium",
  status: "received",
  receivedAt: "2026-08-01",
  acknowledgeDueAt: "2026-08-04",
  resolveDueAt: "2026-08-31",
  acknowledgedAt: null,
  escalationTier: 0,
  category: "dust",
  locationId: "loc_1",
  ...over,
});

describe("ladderDecision", () => {
  it("escalates to tier 1 when the acknowledgement clock is missed", () => {
    const d = ladderDecision(grv(), "2026-08-05", 30);
    expect(d?.toTier).toBe(1);
    expect(d?.breach).toBe("acknowledgement");
  });

  it("escalates to tier 2 when the resolution clock is missed", () => {
    const d = ladderDecision(grv({ acknowledgedAt: "2026-08-02T00:00:00Z" }), "2026-09-05", 30);
    expect(d?.toTier).toBe(2);
    expect(d?.breach).toBe("resolution");
    expect(d?.overdueDays).toBe(5);
  });

  it("escalates to tier 3 — the external route — after a full extra service period", () => {
    const d = ladderDecision(grv({ acknowledgedAt: "2026-08-02T00:00:00Z" }), "2026-10-05", 30);
    expect(d?.toTier).toBe(3);
    expect(d?.breach).toBe("prolonged");
    expect(d?.reason).toContain("judicial");
  });

  it("never de-escalates: a case already at the justified tier returns null", () => {
    expect(ladderDecision(grv({ escalationTier: 1 }), "2026-08-05", 30)).toBeNull();
    expect(
      ladderDecision(grv({ escalationTier: 3, acknowledgedAt: null }), "2026-10-05", 30),
    ).toBeNull();
  });

  it("stops the ladder once the case is settled — including rejected", () => {
    for (const status of ["resolved", "closed_verified", "rejected"]) {
      expect(ladderDecision(grv({ status }), "2026-10-05", 30), status).toBeNull();
    }
  });

  it("does not escalate a case still inside both clocks", () => {
    expect(ladderDecision(grv(), "2026-08-02", 30)).toBeNull();
  });
});

describe("detectHotspots", () => {
  const cluster = (dates: string[], over: Partial<LadderGrievance> = {}) =>
    dates.map((receivedAt, i) => grv({ id: `g${i}`, number: i, receivedAt, ...over }));

  it("finds a cluster of the threshold count inside the window", () => {
    const found = detectHotspots(cluster(["2026-08-01", "2026-08-05", "2026-08-10"]));
    expect(found).toHaveLength(1);
    expect(found[0]!.count).toBe(HOTSPOT_MIN_COUNT);
    expect(found[0]!.windowStart).toBe("2026-08-01");
    expect(found[0]!.windowEnd).toBe("2026-08-10");
    expect(found[0]!.severityMix).toEqual({ medium: 3 });
  });

  it("does not cluster grievances spread beyond the window", () => {
    expect(detectHotspots(cluster(["2026-01-01", "2026-04-01", "2026-08-01"]))).toHaveLength(0);
  });

  it("reports the densest window, not the whole year", () => {
    const found = detectHotspots(
      cluster(["2026-01-01", "2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"]),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.count).toBe(4);
    expect(found[0]!.windowStart).toBe("2026-08-01");
  });

  it("excludes grievances with no location — a hotspot you cannot walk to is not one", () => {
    expect(
      detectHotspots(cluster(["2026-08-01", "2026-08-02", "2026-08-03"], { locationId: null })),
    ).toHaveLength(0);
  });

  it("does not merge different categories at the same location", () => {
    const rows = [
      ...cluster(["2026-08-01", "2026-08-02"], { category: "dust" }),
      grv({ id: "x", receivedAt: "2026-08-03", category: "noise" }),
    ];
    expect(detectHotspots(rows)).toHaveLength(0);
  });
});

/* ================================================================== */
/* Consent to programme (#591)                                         */
/* ================================================================== */

describe("estimateResolutionDays", () => {
  it("prefers the project's own median once there are enough observations", () => {
    const obs = [10, 20, 30].map((days) => ({ kind: "parcel" as const, status: "agreed", days }));
    const e = estimateResolutionDays("parcel", "agreed", obs);
    expect(e.source).toBe("observed_median");
    expect(e.days).toBe(20);
    expect(e.sampleSize).toBe(3);
  });

  it("falls back to the documented planning assumption below the sample threshold", () => {
    const obs = Array.from({ length: MIN_OBSERVATIONS - 1 }, () => ({
      kind: "parcel" as const,
      status: "agreed",
      days: 5,
    }));
    const e = estimateResolutionDays("parcel", "agreed", obs);
    expect(e.source).toBe("default");
    expect(e.days).toBe(DEFAULT_RESOLUTION_DAYS.parcel["agreed"]);
  });

  it("uses a conservative assumption for a state it has no rule for", () => {
    const e = estimateResolutionDays("permit", "invented_state", []);
    expect(e.source).toBe("unknown_state");
    expect(e.days).toBe(UNKNOWN_STATE_DAYS);
  });

  it("medianOf handles even samples and empties", () => {
    expect(medianOf([1, 2, 3, 4])).toBe(2.5);
    expect(medianOf([])).toBeNull();
  });
});

describe("buildConsentView", () => {
  const today = "2026-09-06";
  const task = (over: Partial<ConsentTask> = {}): ConsentTask => ({
    id: "tsk_1",
    name: "Piling",
    wbsCode: "1.1",
    startDate: addDays(today, 10),
    actualStart: null,
    totalFloat: null,
    isCritical: false,
    ...over,
  });
  const dep = (over: Partial<ConsentDependency> = {}): ConsentDependency => ({
    kind: "parcel",
    id: "lpc_1",
    reference: "P-001",
    label: "Parcel P-001",
    status: "agreed",
    resolved: false,
    taskIds: ["tsk_1"],
    detail: {},
    ...over,
  });

  it("quantifies days-at-risk from the expected resolution date", () => {
    const v = buildConsentView({
      today,
      horizonDays: 90,
      tasks: [task()],
      dependencies: [dep()],
    });
    expect(v.tasks).toHaveLength(1);
    const row = v.tasks[0]!;
    const expected = DEFAULT_RESOLUTION_DAYS.parcel["agreed"]!;
    // resolution expected `expected` days out; the task starts in 10
    expect(row.dependencies[0]!.daysAtRisk).toBe(Math.max(0, expected - 10));
    expect(row.daysUntilStart).toBe(10);
  });

  it("charges the whole delay to a critical task and nets float off a non-critical one", () => {
    const critical = buildConsentView({
      today,
      horizonDays: 90,
      tasks: [task({ isCritical: true })],
      dependencies: [dep()],
    });
    const floated = buildConsentView({
      today,
      horizonDays: 90,
      tasks: [task({ totalFloat: 1000 })],
      dependencies: [dep()],
    });
    expect(critical.tasks[0]!.slipContribution).toBe(critical.tasks[0]!.daysAtRisk);
    expect(floated.tasks[0]!.slipContribution).toBe(0);
  });

  it("cannot quantify a non-critical task with no float — and says so rather than guessing", () => {
    const v = buildConsentView({
      today,
      horizonDays: 90,
      tasks: [task()],
      dependencies: [dep()],
    });
    expect(v.tasks[0]!.slipContribution).toBeNull();
    expect(v.summary.unquantifiedTasks).toBe(1);
    expect(v.summary.projectedSlipDays).toBeNull();
  });

  it("ignores resolved dependencies and tasks outside the horizon", () => {
    expect(
      buildConsentView({
        today,
        horizonDays: 90,
        tasks: [task()],
        dependencies: [dep({ resolved: true })],
      }).tasks,
    ).toHaveLength(0);
    expect(
      buildConsentView({
        today,
        horizonDays: 5,
        tasks: [task()],
        dependencies: [dep()],
      }).tasks,
    ).toHaveLength(0);
  });

  it("flags works physically started while the dependency is unresolved", () => {
    const v = buildConsentView({
      today,
      horizonDays: 90,
      tasks: [task({ startDate: null, actualStart: addDays(today, -3) })],
      dependencies: [dep()],
    });
    expect(v.tasks[0]!.startedUnconsented).toBe(true);
    expect(v.summary.startedUnconsented).toBe(1);
  });

  it("ranks the worst dependency first and counts both kinds", () => {
    const v = buildConsentView({
      today,
      horizonDays: 90,
      tasks: [task()],
      dependencies: [
        dep({ id: "lpc_1", status: "identified" }),
        dep({ kind: "permit", id: "prm_1", reference: "PRM-1", status: "not_started" }),
      ],
    });
    const row = v.tasks[0]!;
    expect(row.dependencies).toHaveLength(2);
    expect(row.dependencies[0]!.daysAtRisk).toBeGreaterThanOrEqual(
      row.dependencies[1]!.daysAtRisk,
    );
    expect(v.summary.blockingParcels).toBe(1);
    expect(v.summary.blockingPermits).toBe(1);
  });

  it("skips an unscheduled task: there is no date to be at risk against", () => {
    const v = buildConsentView({
      today,
      horizonDays: 90,
      tasks: [task({ startDate: null, actualStart: null })],
      dependencies: [dep()],
    });
    expect(v.tasks).toHaveLength(0);
  });
});
