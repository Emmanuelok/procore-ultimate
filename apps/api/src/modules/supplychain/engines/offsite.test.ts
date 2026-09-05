import { describe, expect, it } from "vitest";
import { derivedProductionStatus, rollupStages, transitionAllowed, verifiedForPayment, type StageRow } from "./offsite.js";

const stage = (over: Partial<StageRow> & { id: string }): StageRow => ({
  position: 0,
  status: "not_started",
  isQaGate: false,
  qaResult: "pending",
  completedBy: null,
  ...over,
});

describe("rollupStages", () => {
  it("reports an empty unit honestly", () => {
    const r = rollupStages([]);
    expect(r.percentComplete).toBe(0);
    expect(r.readyToShip).toBe(false);
    expect(r.reasons[0]).toMatch(/No production stages/);
  });

  it("computes percent from stages and holds on a failed gate", () => {
    const r = rollupStages([
      stage({ id: "a", status: "complete" }),
      stage({ id: "b", status: "complete", isQaGate: true, qaResult: "failed" }),
      stage({ id: "c", status: "not_started" }),
    ]);
    expect(r.percentComplete).toBeCloseTo(66.7, 1);
    expect(r.onQaHold).toBe(true);
    expect(r.readyToShip).toBe(false);
    expect(r.qaGatesFailed).toBe(1);
  });

  it("is ready to ship only when every stage is complete and every gate passed or waived", () => {
    const stages = [
      stage({ id: "a", status: "complete" }),
      stage({ id: "b", status: "complete", isQaGate: true, qaResult: "pending" }),
    ];
    expect(rollupStages(stages).readyToShip).toBe(false);
    expect(rollupStages(stages).qaGatesPending).toBe(1);
    stages[1]!.qaResult = "waived";
    expect(rollupStages(stages).readyToShip).toBe(true);
  });
});

describe("derivedProductionStatus / transitionAllowed", () => {
  it("derives qa_hold, passed_qa and in_production, and never regresses a shipped unit", () => {
    const hold = rollupStages([stage({ id: "a", status: "complete", isQaGate: true, qaResult: "failed" })]);
    expect(derivedProductionStatus("in_production", hold)).toBe("qa_hold");
    const done = rollupStages([stage({ id: "a", status: "complete", isQaGate: true, qaResult: "passed" })]);
    expect(derivedProductionStatus("in_production", done)).toBe("passed_qa");
    expect(derivedProductionStatus("in_transit", hold)).toBe("in_transit");
    const partial = rollupStages([stage({ id: "a", status: "complete" }), stage({ id: "b" })]);
    expect(derivedProductionStatus("planned", partial)).toBe("in_production");
  });

  it("refuses ready_to_ship until QA is complete and refuses illegal jumps", () => {
    const notReady = rollupStages([stage({ id: "a", status: "in_progress" })]);
    expect(transitionAllowed("passed_qa", "ready_to_ship", notReady).ok).toBe(false);
    expect(transitionAllowed("planned", "delivered", notReady).ok).toBe(false);
    // qa_hold is derived from a failed gate; offering it as a manual target
    // rendered a button that did nothing, so it is refused with the reason.
    const hold = transitionAllowed("in_production", "qa_hold", notReady);
    expect(hold.ok).toBe(false);
    expect(hold.reason).toMatch(/not set by hand/);
    const ready = rollupStages([stage({ id: "a", status: "complete", isQaGate: true, qaResult: "passed" })]);
    expect(transitionAllowed("passed_qa", "ready_to_ship", ready).ok).toBe(true);
    expect(transitionAllowed("ready_to_ship", "in_transit", ready).ok).toBe(true);
    expect(transitionAllowed("installed", "rejected", ready).ok).toBe(false);
  });
});

describe("verifiedForPayment", () => {
  it("is null with the reason when nothing was inspected", () => {
    const r = verifiedForPayment([]);
    expect(r.percent).toBeNull();
    expect(r.reasons[0]).toMatch(/No factory inspection/);
  });
  it("takes the latest passed/conditional inspection and ignores failed ones", () => {
    const r = verifiedForPayment([
      { result: "passed", percentVerified: 40, performedAt: "2026-08-01", inspectorId: "u1" },
      { result: "conditional", percentVerified: 65, performedAt: "2026-08-20", inspectorId: "u1" },
      { result: "failed", percentVerified: 90, performedAt: "2026-08-25", inspectorId: "u1" },
    ]);
    expect(r.percent).toBe(65);
    expect(r.inspectionCount).toBe(3);
    expect(r.source?.performedAt).toBe("2026-08-20");
  });

  it("lets a later, LOWER inspection correct an over-stated one", () => {
    const r = verifiedForPayment([
      { id: "i1", result: "passed", percentVerified: 90, performedAt: "2026-08-01", inspectorId: "u1" },
      { id: "i2", result: "passed", percentVerified: 40, performedAt: "2026-08-09", inspectorId: "u2" },
    ]);
    expect(r.percent).toBe(40);
    expect(r.source).toEqual({ id: "i2", inspectorId: "u2", performedAt: "2026-08-09" });
    expect(r.reasons[0]).toMatch(/superseded/);
  });

  it("breaks a same-day tie on the record's creation order", () => {
    const r = verifiedForPayment([
      { id: "i1", result: "passed", percentVerified: 90, performedAt: "2026-08-09", createdAt: "2026-08-09T08:00:00.000Z", inspectorId: "u1" },
      { id: "i2", result: "conditional", percentVerified: 45, performedAt: "2026-08-09", createdAt: "2026-08-09T16:00:00.000Z", inspectorId: "u2" },
    ]);
    expect(r.percent).toBe(45);
    expect(r.source?.id).toBe("i2");
  });

  it("ignores a voided inspection entirely", () => {
    const r = verifiedForPayment([
      { id: "i1", result: "passed", percentVerified: 90, performedAt: "2026-08-01", inspectorId: "u1" },
      { id: "i2", result: "voided", percentVerified: 40, performedAt: "2026-08-09", inspectorId: "u2" },
    ]);
    expect(r.percent).toBe(90);
    expect(r.usableCount).toBe(1);
  });
});
