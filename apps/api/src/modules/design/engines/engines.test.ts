/**
 * Unit tests for the four design engines. No database, no fastify: these are
 * the judgements the module makes, tested on their own.
 */
import { describe, expect, it } from "vitest";
import {
  DESIGN_STAGES,
  gateBlockers,
  outOfOrderStages,
  resolveStageKey,
  stageLabel,
  stageLibrary,
  stageOrder,
} from "./stages.js";
import { checkClose, consolidate, cycleTimeStats, overdueCycles, requiresResubmission } from "./review.js";
import { assessDeliverable, slippageByConsultant, slippageStats } from "./slippage.js";
import {
  DEFAULT_THRESHOLDS,
  assessEntitlement,
  authorisationRank,
  changeFrequency,
  freezePosition,
  maxAuthorisation,
  requiredAuthorisation,
  rollupImpacts,
} from "./change.js";
import { assessPi, assessReadiness } from "./readiness.js";

/* ================================================================== */
/* Stage library                                                       */
/* ================================================================== */

describe("stage library", () => {
  it("holds eight ordered stages with all three vocabularies", () => {
    expect(DESIGN_STAGES).toHaveLength(8);
    expect(DESIGN_STAGES.map((s) => s.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const stage of DESIGN_STAGES) {
      expect(stage.riba).not.toBe("");
      expect(stage.aia).not.toBe("");
      expect(stage.iso19650).not.toBe("");
    }
  });

  it("maps AIA and RIBA vocabularies onto the same canonical key", () => {
    expect(resolveStageKey("Design Development")).toBe("stage_3");
    expect(resolveStageKey("Spatial Coordination")).toBe("stage_3");
    expect(resolveStageKey("RIBA 3")).toBe("stage_3");
    expect(resolveStageKey("stage 3")).toBe("stage_3");
    expect(resolveStageKey("Construction Documents")).toBe("stage_4");
    expect(resolveStageKey("CD")).toBe("stage_4");
    expect(resolveStageKey("Technical Design")).toBe("stage_4");
  });

  it("returns null rather than guessing at an unknown label", () => {
    expect(resolveStageKey("stage nine")).toBeNull();
    expect(resolveStageKey("")).toBeNull();
    expect(resolveStageKey(null)).toBeNull();
    expect(resolveStageKey("RIBA 9")).toBeNull();
  });

  it("renders a stage in the framework the project speaks", () => {
    expect(stageLabel("stage_3", "riba_2020")).toContain("Spatial Coordination");
    expect(stageLabel("stage_3", "aia")).toBe("Design Development");
    expect(stageLabel("stage_3", "iso_19650")).toBe("Appointment");
    expect(stageLabel("nonsense", "aia")).toBeNull();
    expect(stageLibrary("aia")).toHaveLength(8);
    expect(stageOrder("stage_5")).toBe(5);
    expect(stageOrder(null)).toBeNull();
  });

  it("names the unmet criteria rather than saying 'not allowed'", () => {
    expect(
      gateBlockers([
        { key: "cost", label: "Cost plan signed off", met: true },
        { key: "planning", label: "Planning permission granted", met: false },
      ]),
    ).toEqual(["Planning permission granted"]);
    expect(gateBlockers([])).toEqual([]);
  });

  it("reports a stage plan that has been passed out of order", () => {
    expect(
      outOfOrderStages([
        { stageKey: "stage_2", status: "open" },
        { stageKey: "stage_3", status: "signed_off" },
      ]),
    ).toEqual(["stage_2"]);
    expect(
      outOfOrderStages([
        { stageKey: "stage_2", status: "signed_off" },
        { stageKey: "stage_3", status: "open" },
      ]),
    ).toEqual([]);
  });
});

/* ================================================================== */
/* Review consolidation                                                */
/* ================================================================== */

const reviewer = (over: Partial<Parameters<typeof consolidate>[0][number]> = {}) => ({
  id: "p1",
  isRequired: true,
  status: "returned",
  returnedCode: "A" as string | null,
  displayName: "Reviewer",
  discipline: "architectural",
  ...over,
});

describe("review consolidation", () => {
  it("takes the worst code returned, never the most common", () => {
    const result = consolidate([
      reviewer({ id: "a", returnedCode: "A" }),
      reviewer({ id: "b", returnedCode: "A" }),
      reviewer({ id: "c", returnedCode: "C" }),
    ]);
    expect(result.code).toBe("C");
    expect(result.byCode).toEqual({ A: 2, C: 1 });
    expect(result.basis).toContain("Worst of 3 returned");
  });

  it("rates D above C above B above A", () => {
    expect(consolidate([reviewer({ returnedCode: "B" }), reviewer({ id: "z", returnedCode: "D" })]).code).toBe("D");
    expect(consolidate([reviewer({ returnedCode: "A" }), reviewer({ id: "z", returnedCode: "B" })]).code).toBe("B");
  });

  it("excludes a declined reviewer from the count but records them", () => {
    const result = consolidate([
      reviewer({ id: "a", returnedCode: "A" }),
      reviewer({ id: "b", status: "declined", returnedCode: null }),
    ]);
    expect(result.declined).toBe(1);
    expect(result.required).toBe(1);
    expect(result.code).toBe("A");
    expect(result.basis).toContain("1 declined");
  });

  it("names the required reviewers who have not returned", () => {
    const result = consolidate([
      reviewer({ id: "a", returnedCode: "A" }),
      reviewer({ id: "b", status: "pending", returnedCode: null, displayName: "Structures" }),
    ]);
    expect(result.outstanding).toEqual(["Structures"]);
  });

  it("gives no code and an honest basis when nobody has returned", () => {
    const result = consolidate([reviewer({ status: "pending", returnedCode: null })]);
    expect(result.code).toBeNull();
    expect(result.basis).toContain("No reviewer has returned");
    expect(consolidate([]).basis).toContain("No reviewers were appointed");
  });

  it("blocks closure while a required reviewer is silent, unless forced", () => {
    const participants = [
      reviewer({ id: "a", returnedCode: "B" }),
      reviewer({ id: "b", status: "pending", returnedCode: null, displayName: "MEP" }),
    ];
    const blocked = checkClose(participants);
    expect(blocked.canClose).toBe(false);
    expect(blocked.blockers.join(" ")).toContain("MEP");
    const forced = checkClose(participants, { force: true });
    expect(forced.canClose).toBe(true);
    expect(forced.consolidation.code).toBe("B");
  });

  it("does not block closure on an optional reviewer", () => {
    const check = checkClose([
      reviewer({ id: "a", returnedCode: "A" }),
      reviewer({ id: "b", isRequired: false, status: "pending", returnedCode: null }),
    ]);
    expect(check.canClose).toBe(true);
  });

  it("refuses to close a cycle where nobody returned at all", () => {
    const check = checkClose([reviewer({ status: "pending", returnedCode: null, isRequired: false })]);
    expect(check.canClose).toBe(false);
    expect(check.blockers.join(" ")).toContain("no outcome");
  });

  it("knows which codes force a resubmission", () => {
    expect(requiresResubmission("C")).toBe(true);
    expect(requiresResubmission("D")).toBe(true);
    expect(requiresResubmission("B")).toBe(false);
    expect(requiresResubmission(null)).toBe(false);
  });
});

describe("review cycle time", () => {
  const cycle = (over: Partial<Parameters<typeof cycleTimeStats>[0][number]>) => ({
    id: "r1",
    packageId: "p1",
    cycleNumber: 1,
    issuedAt: "2026-01-01T00:00:00.000Z",
    dueAt: "2026-01-15T00:00:00.000Z",
    closedAt: "2026-01-11T00:00:00.000Z",
    consolidatedCode: "A" as string | null,
    status: "closed",
    ...over,
  });

  it("measures turnaround from issue to close", () => {
    const stats = cycleTimeStats([cycle({})], "2026-02-01T00:00:00.000Z");
    expect(stats.averageTurnaroundDays).toBe(10);
    expect(stats.medianTurnaroundDays).toBe(10);
    expect(stats.onTimeCount).toBe(1);
    expect(stats.onTimePercent).toBe(100);
  });

  it("returns null, not zero, when nothing has closed", () => {
    const stats = cycleTimeStats([cycle({ status: "open", closedAt: null })], "2026-02-01T00:00:00.000Z");
    expect(stats.averageTurnaroundDays).toBeNull();
    expect(stats.onTimePercent).toBeNull();
    expect(stats.reasons.join(" ")).toContain("No closed cycle");
  });

  it("excludes a closed cycle with no issue date and says so", () => {
    const stats = cycleTimeStats([cycle({ issuedAt: null })], "2026-02-01T00:00:00.000Z");
    expect(stats.averageTurnaroundDays).toBeNull();
    expect(stats.reasons.join(" ")).toContain("no issue date");
  });

  it("computes the rework multiple from the cycle that first reached an accepted code", () => {
    const stats = cycleTimeStats(
      [
        cycle({ id: "r1", cycleNumber: 1, consolidatedCode: "C" }),
        cycle({ id: "r2", cycleNumber: 2, consolidatedCode: "B" }),
        cycle({ id: "r3", packageId: "p2", cycleNumber: 1, consolidatedCode: "A" }),
      ],
      "2026-02-01T00:00:00.000Z",
    );
    expect(stats.packagesAccepted).toBe(2);
    expect(stats.reworkMultiple).toBe(1.5);
  });

  it("reports the rework multiple as null when nothing has been accepted", () => {
    const stats = cycleTimeStats([cycle({ consolidatedCode: "D" })], "2026-02-01T00:00:00.000Z");
    expect(stats.reworkMultiple).toBeNull();
    expect(stats.reasons.join(" ")).toContain("rework multiple");
  });

  it("finds cycles past their due date and how many days over", () => {
    const overdue = overdueCycles(
      [cycle({ status: "open", closedAt: null, dueAt: "2026-01-15T00:00:00.000Z" })],
      "2026-01-20T00:00:00.000Z",
    );
    expect(overdue).toEqual([{ id: "r1", packageId: "p1", daysOverdue: 5 }]);
    expect(overdueCycles([cycle({ status: "closed" })], "2026-06-01T00:00:00.000Z")).toEqual([]);
    expect(overdueCycles([cycle({ status: "open", closedAt: null, dueAt: null })], "2026-06-01T00:00:00.000Z")).toEqual([]);
  });
});

/* ================================================================== */
/* Deliverable slippage                                                */
/* ================================================================== */

describe("deliverable slippage", () => {
  const base = {
    status: "planned",
    plannedIssueDate: "2026-03-01",
    forecastIssueDate: null,
    actualIssueDate: null,
    acceptedAt: null,
    requiredOnSite: null,
    taskStartDate: null,
  };

  it("is late when the planned date has passed with nothing issued", () => {
    const v = assessDeliverable(base, "2026-03-10");
    expect(v.level).toBe("late");
    expect(v.reasons[0]).toContain("9 days overdue");
  });

  it("is at risk when the forecast is after the plan", () => {
    const v = assessDeliverable({ ...base, forecastIssueDate: "2026-03-20" }, "2026-02-01");
    expect(v.level).toBe("at_risk");
    expect(v.slippageDays).toBe(19);
  });

  it("is at risk when the due date is inside the warning window", () => {
    const v = assessDeliverable(base, "2026-02-26");
    expect(v.level).toBe("at_risk");
    expect(v.reasons.join(" ")).toContain("Due in 3 days");
  });

  it("is on track with time in hand and no forecast slip", () => {
    const v = assessDeliverable(base, "2026-01-01");
    expect(v.level).toBe("on_track");
    expect(v.slippageDays).toBe(0);
  });

  it("records the lateness it was delivered at, not a clean 'delivered'", () => {
    const v = assessDeliverable({ ...base, status: "issued", actualIssueDate: "2026-03-08" }, "2026-04-01");
    expect(v.level).toBe("delivered");
    expect(v.slippageDays).toBe(7);
    expect(v.reasons.join(" ")).toContain("7 days after the planned date");
  });

  it("flags a deliverable that arrives after the task it feeds starts", () => {
    const v = assessDeliverable({ ...base, forecastIssueDate: "2026-03-20", taskStartDate: "2026-03-10" }, "2026-02-01");
    expect(v.blocksTask).toBe(true);
    expect(v.reasons.join(" ")).toContain("too late");
  });

  it("is at risk on the task lead alone even when the forecast beats the plan", () => {
    const v = assessDeliverable(
      { ...base, plannedIssueDate: "2026-03-01", forecastIssueDate: "2026-02-20", taskStartDate: "2026-02-10" },
      "2026-01-01",
    );
    expect(v.blocksTask).toBe(true);
    expect(v.level).toBe("at_risk");
  });

  it("declines to assess without a planned date, and says why", () => {
    const v = assessDeliverable({ ...base, plannedIssueDate: null }, "2026-03-01");
    expect(v.level).toBe("not_assessable");
    expect(v.slippageDays).toBeNull();
    expect(v.reasons.join(" ")).toContain("No planned issue date");
  });

  it("does not assess a cancelled deliverable", () => {
    const v = assessDeliverable({ ...base, status: "cancelled" }, "2026-03-10");
    expect(v.level).toBe("not_assessable");
  });

  it("notes a required-on-site date the expected issue misses", () => {
    const v = assessDeliverable({ ...base, forecastIssueDate: "2026-03-20", requiredOnSite: "2026-03-05" }, "2026-01-01");
    expect(v.reasons.join(" ")).toContain("required on site");
  });
});

describe("slippage statistics", () => {
  const row = (over: Partial<Parameters<typeof slippageStats>[0][number]>) => ({
    id: "d1",
    consultantId: "c1",
    discipline: "architectural",
    packageId: "p1",
    status: "issued",
    slippageLevel: "delivered",
    slippageDays: 0 as number | null,
    plannedIssueDate: "2026-03-01",
    actualIssueDate: "2026-03-01" as string | null,
    ...over,
  });

  it("counts on-time against measurable issues only", () => {
    const stats = slippageStats([
      row({ id: "a", slippageDays: 0 }),
      row({ id: "b", slippageDays: 5 }),
      row({ id: "c", slippageDays: null, plannedIssueDate: null }),
    ]);
    expect(stats.issued).toBe(3);
    expect(stats.issuedOnTime).toBe(1);
    expect(stats.issuedLate).toBe(1);
    expect(stats.onTimePercent).toBe(50);
    expect(stats.reasons.join(" ")).toContain("excluded from the on-time figure");
  });

  it("returns null on-time when nothing has been issued", () => {
    const stats = slippageStats([row({ status: "planned", actualIssueDate: null, slippageLevel: "on_track", slippageDays: null })]);
    expect(stats.onTimePercent).toBeNull();
    expect(stats.averageSlippageDays).toBeNull();
    expect(stats.reasons.join(" ")).toContain("Nothing has been issued");
  });

  it("groups by consultant with the worst first", () => {
    const grouped = slippageByConsultant([
      row({ id: "a", consultantId: "c1", slippageLevel: "late" }),
      row({ id: "b", consultantId: "c1", slippageLevel: "late" }),
      row({ id: "c", consultantId: "c2", slippageLevel: "on_track" }),
      row({ id: "d", consultantId: null, slippageLevel: "at_risk" }),
    ]);
    expect(grouped[0]?.consultantId).toBe("c1");
    expect(grouped[0]?.late).toBe(2);
    expect(grouped.find((g) => g.consultantId === null)?.atRisk).toBe(1);
  });
});

/* ================================================================== */
/* Change control                                                      */
/* ================================================================== */

describe("impact roll-up", () => {
  it("buckets cost by currency and never adds across them", () => {
    const rollup = rollupImpacts([
      { discipline: "structural", costImpact: 10_000, currency: "GBP", timeImpactDays: 5, reworkHours: 40 },
      { discipline: "mechanical", costImpact: 20_000, currency: "USD", timeImpactDays: 3, reworkHours: 20 },
    ]);
    expect(rollup.costByCurrency).toEqual({ GBP: 10_000, USD: 20_000 });
    expect(rollup.cost).toBeNull();
    expect(rollup.currencies).toEqual(["GBP", "USD"]);
    expect(rollup.costReasons.join(" ")).toContain("never added");
  });

  it("gives a single total when there is only one currency", () => {
    const rollup = rollupImpacts([
      { discipline: "structural", costImpact: 10_000, currency: "GBP", timeImpactDays: 5, reworkHours: null },
      { discipline: "facade", costImpact: 2_500, currency: "GBP", timeImpactDays: 2, reworkHours: null },
    ]);
    expect(rollup.cost).toBe(12_500);
  });

  it("takes the longest time impact, not the sum: parallel work does not add", () => {
    const rollup = rollupImpacts([
      { discipline: "structural", costImpact: 0, currency: "GBP", timeImpactDays: 14, reworkHours: null },
      { discipline: "mechanical", costImpact: 0, currency: "GBP", timeImpactDays: 10, reworkHours: null },
    ]);
    expect(rollup.timeDays).toBe(14);
    expect(rollup.timeBasis).toContain("parallel");
  });

  it("adds rework hours, because hours are hours", () => {
    const rollup = rollupImpacts([
      { discipline: "structural", costImpact: null, currency: "GBP", timeImpactDays: null, reworkHours: 12.5 },
      { discipline: "facade", costImpact: null, currency: "GBP", timeImpactDays: null, reworkHours: 7.5 },
    ]);
    expect(rollup.reworkHours).toBe(20);
    expect(rollup.linesWithoutCost).toBe(2);
    expect(rollup.timeDays).toBeNull();
  });

  it("says nothing has been assessed rather than reporting zero", () => {
    const rollup = rollupImpacts([]);
    expect(rollup.cost).toBeNull();
    expect(rollup.timeDays).toBeNull();
    expect(rollup.reworkHours).toBeNull();
    expect(rollup.costReasons.join(" ")).toContain("No discipline has assessed");
  });
});

describe("freeze position", () => {
  const freeze = (over: Partial<Parameters<typeof freezePosition>[0][number]> = {}) => ({
    id: "f1",
    scope: "project",
    packageId: null as string | null,
    stageKey: null as string | null,
    status: "active",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    requiredAuthorisation: "client",
    ...over,
  });

  it("finds no freeze when none is in force", () => {
    const p = freezePosition([], { packageId: "p1", stageKey: "stage_4" }, "2026-02-01T00:00:00.000Z");
    expect(p.isPostFreeze).toBe(false);
    expect(p.basis).toContain("No design freeze");
  });

  it("ignores a freeze that takes effect after the change", () => {
    const p = freezePosition(
      [freeze({ effectiveFrom: "2026-03-01T00:00:00.000Z" })],
      { packageId: "p1", stageKey: null },
      "2026-02-01T00:00:00.000Z",
    );
    expect(p.isPostFreeze).toBe(false);
  });

  it("ignores a lifted freeze", () => {
    const p = freezePosition([freeze({ status: "lifted" })], { packageId: "p1", stageKey: null }, "2026-02-01T00:00:00.000Z");
    expect(p.isPostFreeze).toBe(false);
  });

  it("prefers the package freeze over the project freeze", () => {
    const p = freezePosition(
      [
        freeze({ id: "project", scope: "project", requiredAuthorisation: "board" }),
        freeze({ id: "pkg", scope: "package", packageId: "p1", requiredAuthorisation: "project_manager" }),
      ],
      { packageId: "p1", stageKey: null },
      "2026-02-01T00:00:00.000Z",
    );
    expect(p.freezeId).toBe("pkg");
    expect(p.requiredAuthorisation).toBe("project_manager");
  });

  it("does not apply a package freeze to a different package", () => {
    const p = freezePosition(
      [freeze({ id: "pkg", scope: "package", packageId: "other" })],
      { packageId: "p1", stageKey: null },
      "2026-02-01T00:00:00.000Z",
    );
    expect(p.isPostFreeze).toBe(false);
    expect(p.basis).toContain("none of them covers");
  });
});

describe("authorisation", () => {
  const noFreeze = { isPostFreeze: false, freezeId: null, requiredAuthorisation: null, basis: "" };

  it("escalates with the money", () => {
    const small = requiredAuthorisation({
      rollup: rollupImpacts([{ discipline: "a", costImpact: 500, currency: "GBP", timeImpactDays: 0, reworkHours: null }]),
      classification: "design_development",
      freeze: noFreeze,
    });
    expect(small.level).toBe("design_lead");
    const mid = requiredAuthorisation({
      rollup: rollupImpacts([{ discipline: "a", costImpact: 50_000, currency: "GBP", timeImpactDays: 0, reworkHours: null }]),
      classification: "design_development",
      freeze: noFreeze,
    });
    expect(mid.level).toBe("project_manager");
    const big = requiredAuthorisation({
      rollup: rollupImpacts([{ discipline: "a", costImpact: 2_000_000, currency: "GBP", timeImpactDays: 0, reworkHours: null }]),
      classification: "design_development",
      freeze: noFreeze,
    });
    expect(big.level).toBe("board");
  });

  it("uses the largest single-currency figure and says so", () => {
    const verdict = requiredAuthorisation({
      rollup: rollupImpacts([
        { discipline: "a", costImpact: 5_000, currency: "GBP", timeImpactDays: null, reworkHours: null },
        { discipline: "b", costImpact: 150_000, currency: "USD", timeImpactDays: null, reworkHours: null },
      ]),
      classification: "design_development",
      freeze: noFreeze,
    });
    expect(verdict.level).toBe("client");
    expect(verdict.reasons.join(" ")).toContain("never added together");
  });

  it("escalates on programme impact alone", () => {
    const verdict = requiredAuthorisation({
      rollup: rollupImpacts([{ discipline: "a", costImpact: 100, currency: "GBP", timeImpactDays: 20, reworkHours: null }]),
      classification: "design_development",
      freeze: noFreeze,
    });
    expect(verdict.level).toBe("client");
    expect(verdict.reasons.join(" ")).toContain("Programme impact");
  });

  it("never sits at design-lead level when no cost has been assessed", () => {
    const verdict = requiredAuthorisation({
      rollup: rollupImpacts([]),
      classification: "design_development",
      freeze: noFreeze,
    });
    expect(verdict.level).toBe("project_manager");
    expect(verdict.reasons.join(" ")).toContain("No cost has been assessed");
  });

  it("raises a design change above design-lead level even when it is cheap", () => {
    const verdict = requiredAuthorisation({
      rollup: rollupImpacts([{ discipline: "a", costImpact: 100, currency: "GBP", timeImpactDays: 0, reworkHours: null }]),
      classification: "design_change",
      freeze: noFreeze,
    });
    expect(verdict.level).toBe("project_manager");
  });

  it("never sits below what the freeze demands", () => {
    const verdict = requiredAuthorisation({
      rollup: rollupImpacts([{ discipline: "a", costImpact: 10, currency: "GBP", timeImpactDays: 0, reworkHours: null }]),
      classification: "design_development",
      freeze: { isPostFreeze: true, freezeId: "f1", requiredAuthorisation: "board", basis: "Frozen." },
    });
    expect(verdict.level).toBe("board");
  });

  it("orders and maxes levels correctly", () => {
    expect(authorisationRank("design_lead")).toBeLessThan(authorisationRank("board"));
    expect(maxAuthorisation("client", "project_manager")).toBe("client");
    expect(DEFAULT_THRESHOLDS.clientAbove).toBeGreaterThan(DEFAULT_THRESHOLDS.projectManagerAbove);
  });
});

describe("entitlement", () => {
  it("gives design development no entitlement", () => {
    const v = assessEntitlement({ classification: "design_development", originator: "client", isPostFreeze: false });
    expect(v.carriesEntitlement).toBe(false);
    expect(v.raisesChangeEvent).toBe(false);
    expect(v.reasons.join(" ")).toContain("carries no entitlement");
  });

  it("still notes the freeze on a post-freeze design development", () => {
    const v = assessEntitlement({ classification: "design_development", originator: "client", isPostFreeze: true });
    expect(v.reasons.join(" ")).toContain("after a design freeze");
  });

  it("attributes a client-originated design change to the client and raises a change event", () => {
    const v = assessEntitlement({ classification: "design_change", originator: "client", isPostFreeze: false });
    expect(v.carriesEntitlement).toBe(true);
    expect(v.costCarrier).toBe("client");
    expect(v.raisesChangeEvent).toBe(true);
  });

  it("refuses to turn a designer's own change into an owner variation", () => {
    const v = assessEntitlement({ classification: "design_change", originator: "designer", isPostFreeze: false });
    expect(v.carriesEntitlement).toBe(false);
    expect(v.raisesChangeEvent).toBe(false);
    expect(v.costCarrier).toBe("designer");
    expect(v.reasons.join(" ")).toContain("professional-indemnity");
  });

  it("treats statutory and site-condition changes as employer risk", () => {
    expect(assessEntitlement({ classification: "design_change", originator: "statutory", isPostFreeze: false }).raisesChangeEvent).toBe(true);
    expect(assessEntitlement({ classification: "design_change", originator: "site_condition", isPostFreeze: false }).raisesChangeEvent).toBe(true);
    expect(assessEntitlement({ classification: "design_change", originator: "contractor", isPostFreeze: false }).raisesChangeEvent).toBe(false);
    expect(assessEntitlement({ classification: "design_change", originator: "other", isPostFreeze: false }).raisesChangeEvent).toBe(false);
  });
});

describe("change frequency", () => {
  it("flags a package churning above the threshold", () => {
    const notices = Array.from({ length: 12 }, (_, i) => ({
      packageId: "p1",
      submittedAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      classification: "design_change",
      isPostFreeze: i < 3,
    }));
    const [verdict] = changeFrequency(notices, "2026-03-01");
    expect(verdict?.packageId).toBe("p1");
    expect(verdict?.changes).toBe(12);
    expect(verdict?.postFreeze).toBe(3);
    expect(verdict?.exceedsThreshold).toBe(true);
    expect(verdict?.basis).toContain("threshold");
  });

  it("counts a notice submitted today when the as-of is a bare date", () => {
    // A date-only as-of means the end of that day: a sweep run this afternoon
    // must see this morning's submissions.
    const verdicts = changeFrequency(
      Array.from({ length: 10 }, () => ({
        packageId: "p1",
        submittedAt: "2026-03-01T14:30:00.000Z",
        classification: "design_change",
        isPostFreeze: false,
      })),
      "2026-03-01",
    );
    expect(verdicts[0]?.changes).toBe(10);
    expect(verdicts[0]?.exceedsThreshold).toBe(true);
  });

  it("ignores notices outside the window and unsubmitted drafts", () => {
    const verdicts = changeFrequency(
      [
        { packageId: "p1", submittedAt: "2020-01-01T00:00:00.000Z", classification: "design_change", isPostFreeze: false },
        { packageId: "p1", submittedAt: null, classification: "design_change", isPostFreeze: false },
        { packageId: null, submittedAt: "2026-02-01T00:00:00.000Z", classification: "design_change", isPostFreeze: false },
      ],
      "2026-03-01",
    );
    expect(verdicts).toEqual([]);
  });
});

/* ================================================================== */
/* Readiness and PI                                                    */
/* ================================================================== */

const emptyInputs = {
  packages: [],
  reviews: [],
  openComments: 0,
  totalComments: 0,
  issues: [],
  deliverables: [],
  infoRequirements: [],
  changeNotices: [],
  activeFreezes: 0,
};

describe("handover readiness", () => {
  it("refuses to score anything when there are no inputs at all", () => {
    const v = assessReadiness(emptyInputs);
    expect(v.score).toBeNull();
    expect(v.level).toBe("not_assessable");
    expect(v.confidence).toBe(0);
    expect(v.reasons.join(" ")).toContain("No dimension had any input");
  });

  it("scores a dimension with no inputs as null, never zero", () => {
    const v = assessReadiness({
      ...emptyInputs,
      packages: [{ id: "p1", status: "approved", stageKey: "stage_4" }],
    });
    const approval = v.dimensions.find((d) => d.key === "package_approval");
    const reviews = v.dimensions.find((d) => d.key === "review_outcome");
    expect(approval?.score).toBe(100);
    expect(reviews?.score).toBeNull();
    expect(reviews?.reasons.join(" ")).toContain("cannot be scored");
  });

  it("declines to call readiness when too little of the weight has inputs", () => {
    const v = assessReadiness({
      ...emptyInputs,
      packages: [{ id: "p1", status: "approved", stageKey: "stage_4" }],
    });
    // only 25% of the weight has inputs
    expect(v.confidence).toBeLessThan(0.4);
    expect(v.level).toBe("not_assessable");
  });

  it("reaches 'ready' only with a high score and no blockers", () => {
    const v = assessReadiness({
      packages: [{ id: "p1", status: "approved", stageKey: "stage_4" }],
      reviews: [{ packageId: "p1", status: "closed", consolidatedCode: "A" }],
      openComments: 0,
      totalComments: 4,
      issues: [{ status: "closed", priority: "high" }],
      deliverables: [{ status: "accepted", slippageLevel: "delivered" }],
      infoRequirements: [{ status: "verified" }],
      changeNotices: [],
      activeFreezes: 1,
    });
    expect(v.score).toBe(100);
    expect(v.blockers).toEqual([]);
    expect(v.level).toBe("ready");
    expect(v.confidence).toBe(1);
  });

  it("drops to nearly-ready when a blocker survives a perfect score", () => {
    const v = assessReadiness({
      packages: [{ id: "p1", status: "approved", stageKey: "stage_4" }],
      reviews: [{ packageId: "p1", status: "closed", consolidatedCode: "A" }],
      openComments: 0,
      totalComments: 4,
      issues: [{ status: "closed", priority: "high" }],
      deliverables: [{ status: "accepted", slippageLevel: "delivered" }],
      infoRequirements: [{ status: "verified" }],
      changeNotices: [{ status: "submitted", isPostFreeze: false }],
      activeFreezes: 1,
    });
    expect(v.blockers.join(" ")).toContain("change notice");
    expect(v.level).toBe("nearly_ready");
  });

  it("names every blocker it found", () => {
    const v = assessReadiness({
      packages: [
        { id: "p1", status: "approved", stageKey: "stage_4" },
        { id: "p2", status: "in_progress", stageKey: "stage_4" },
      ],
      reviews: [{ packageId: "p1", status: "open", consolidatedCode: null }],
      openComments: 3,
      totalComments: 5,
      issues: [{ status: "open", priority: "critical" }],
      deliverables: [{ status: "planned", slippageLevel: "late" }],
      infoRequirements: [{ status: "overdue" }],
      changeNotices: [],
      activeFreezes: 0,
    });
    const joined = v.blockers.join(" ");
    expect(joined).toContain("not yet approved");
    expect(joined).toContain("review cycle");
    expect(joined).toContain("comment");
    expect(joined).toContain("critical");
    expect(joined).toContain("late");
    expect(joined).toContain("overdue");
    expect(v.level).toBe("not_ready");
    expect(v.reasons.join(" ")).toContain("No design freeze is in force");
  });
});

describe("professional indemnity adequacy", () => {
  const consultant = {
    id: "c1",
    name: "Structures LLP",
    status: "active",
    piRequiredAmount: 5_000_000 as number | null,
    piCoverAmount: 5_000_000 as number | null,
    piCurrency: "GBP" as string | null,
    piExpiresOn: "2027-01-01" as string | null,
  };

  it("passes cover that meets the requirement and is not near expiry", () => {
    const v = assessPi(consultant, "2026-01-01");
    expect(v.adequate).toBe(true);
    expect(v.shortfall).toBeNull();
  });

  it("declines to judge when no requirement is recorded", () => {
    const v = assessPi({ ...consultant, piRequiredAmount: null }, "2026-01-01");
    expect(v.adequate).toBeNull();
    expect(v.reasons.join(" ")).toContain("cannot be judged");
  });

  it("fails cover below the requirement and quantifies the shortfall", () => {
    const v = assessPi({ ...consultant, piCoverAmount: 2_000_000 }, "2026-01-01");
    expect(v.adequate).toBe(false);
    expect(v.shortfall).toBe(3_000_000);
    expect(v.severity).toBe("high");
  });

  it("fails a policy that has expired", () => {
    const v = assessPi({ ...consultant, piExpiresOn: "2025-06-01" }, "2026-01-01");
    expect(v.adequate).toBe(false);
    expect(v.expiresInDays).toBeLessThan(0);
    expect(v.severity).toBe("high");
  });

  it("fails a policy expiring inside the warning window", () => {
    const v = assessPi({ ...consultant, piExpiresOn: "2026-02-01" }, "2026-01-01");
    expect(v.adequate).toBe(false);
    expect(v.reasons.join(" ")).toContain("expires in 31 day");
  });

  it("fails a requirement with no cover recorded at all", () => {
    const v = assessPi({ ...consultant, piCoverAmount: null }, "2026-01-01");
    expect(v.adequate).toBe(false);
    expect(v.reasons.join(" ")).toContain("no cover amount has been recorded");
  });

  it("mints a dedupe key that changes when the policy changes", () => {
    const a = assessPi(consultant, "2026-01-01").key;
    const b = assessPi({ ...consultant, piCoverAmount: 1 }, "2026-01-01").key;
    expect(a).not.toBe(b);
  });
});
