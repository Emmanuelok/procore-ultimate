import { describe, expect, it } from "vitest";
import {
  checkpointGate,
  completionReport,
  derivePlanStatus,
  planProgress,
  signoffReadiness,
  signoffsSatisfied,
  type ActivityInput,
} from "./plans.js";

const TODAY = "2026-09-02";

const activity = (over: Partial<ActivityInput> & { seq: number }): ActivityInput => ({
  id: `act_${over.seq}`,
  title: `Activity ${over.seq}`,
  status: "pending",
  isQualityCheckpoint: false,
  evidenceRequired: false,
  evidenceFileIds: [],
  signoffRequiredCount: 1,
  signoffCount: 0,
  dueDate: null,
  ...over,
});

describe("checkpointGate", () => {
  const plan = [
    activity({ seq: 1 }),
    activity({ seq: 2, isQualityCheckpoint: true }),
    activity({ seq: 3 }),
  ];

  it("lets work proceed up to and including the checkpoint", () => {
    expect(checkpointGate(plan, 1).allowed).toBe(true);
    expect(checkpointGate(plan, 2).allowed).toBe(true);
  });

  it("blocks everything after an unsigned checkpoint", () => {
    const gate = checkpointGate(plan, 3);
    expect(gate.allowed).toBe(false);
    expect(gate.blockedBy?.seq).toBe(2);
    expect(gate.reason).toContain("quality checkpoint 2");
  });

  it("opens once the checkpoint is signed off, and a waiver also opens it", () => {
    const signed = plan.map((a) => (a.seq === 2 ? { ...a, status: "signed_off" } : a));
    expect(checkpointGate(signed, 3).allowed).toBe(true);
    const waived = plan.map((a) => (a.seq === 2 ? { ...a, status: "waived" } : a));
    expect(checkpointGate(waived, 3).allowed).toBe(true);
  });

  it("names the earliest blocking checkpoint when there are several", () => {
    const two = [...plan, activity({ seq: 4, isQualityCheckpoint: true })];
    expect(checkpointGate(two, 5).blockedBy?.seq).toBe(2);
  });
});

describe("signoffReadiness", () => {
  it("refuses a sign-off with no evidence when evidence is required", () => {
    const a = activity({ seq: 1, evidenceRequired: true });
    const r = signoffReadiness(a, [a]);
    expect(r.ready).toBe(false);
    expect(r.blockers[0]).toContain("requires evidence");
  });

  it("allows a sign-off once evidence is attached", () => {
    const a = activity({ seq: 1, evidenceRequired: true, evidenceFileIds: ["fil_1"] });
    expect(signoffReadiness(a, [a]).ready).toBe(true);
  });

  it("refuses to sign an activity that is already closed", () => {
    const a = activity({ seq: 1, status: "signed_off" });
    expect(signoffReadiness(a, [a]).blockers[0]).toContain("already signed off");
  });

  it("carries the checkpoint block through", () => {
    const plan = [activity({ seq: 1, isQualityCheckpoint: true }), activity({ seq: 2 })];
    const r = signoffReadiness(plan[1]!, plan);
    expect(r.ready).toBe(false);
    expect(r.blockers[0]).toContain("checkpoint 1");
  });
});

describe("signoffsSatisfied", () => {
  it("needs every required signature, not the first", () => {
    expect(signoffsSatisfied({ signoffRequiredCount: 3, signoffCount: 2 })).toBe(false);
    expect(signoffsSatisfied({ signoffRequiredCount: 3, signoffCount: 3 })).toBe(true);
    expect(signoffsSatisfied({ signoffRequiredCount: 0, signoffCount: 0 })).toBe(true);
  });
});

describe("planProgress", () => {
  it("returns null with a reason when there is nothing to measure", () => {
    const p = planProgress([], TODAY);
    expect(p.percent).toBeNull();
    expect(p.reasons[0]).toContain("no activities");
  });

  it("counts signed-off and waived as closed and says so", () => {
    const p = planProgress(
      [
        activity({ seq: 1, status: "signed_off" }),
        activity({ seq: 2, status: "waived" }),
        activity({ seq: 3 }),
        activity({ seq: 4 }),
      ],
      TODAY,
    );
    expect(p.percent).toBe(50);
    expect(p.signedOff).toBe(1);
    expect(p.waived).toBe(1);
    expect(p.outstanding).toBe(2);
    expect(p.reasons.some((r) => r.includes("waived rather than performed"))).toBe(true);
  });

  it("counts overdue outstanding activities only", () => {
    const p = planProgress(
      [
        activity({ seq: 1, dueDate: "2026-08-01" }),
        activity({ seq: 2, dueDate: "2026-08-01", status: "signed_off" }),
        activity({ seq: 3, dueDate: "2026-12-01" }),
      ],
      TODAY,
    );
    expect(p.overdue).toBe(1);
  });

  it("names the next actionable activity", () => {
    const p = planProgress([activity({ seq: 1, status: "signed_off" }), activity({ seq: 2 })], TODAY);
    expect(p.nextActivity?.seq).toBe(2);
    expect(p.heldBy).toBeNull();
  });

  it("reports the checkpoint holding the plan up and offers no next activity past it", () => {
    const p = planProgress(
      [activity({ seq: 1, status: "signed_off" }), activity({ seq: 2, isQualityCheckpoint: true, status: "signed_off" }), activity({ seq: 3 })],
      TODAY,
    );
    expect(p.nextActivity?.seq).toBe(3);

    const held = planProgress(
      [activity({ seq: 1, isQualityCheckpoint: true }), activity({ seq: 2 })],
      TODAY,
    );
    expect(held.nextActivity?.seq).toBe(1);
    expect(held.heldBy).toBeNull();
  });
});

describe("derivePlanStatus", () => {
  const done = planProgress([activity({ seq: 1, status: "signed_off" })], TODAY);
  const open = planProgress([activity({ seq: 1 })], TODAY);
  const blockedProgress = planProgress([activity({ seq: 1, status: "blocked" })], TODAY);

  it("never overwrites a human decision", () => {
    expect(derivePlanStatus("draft", done)).toBe("draft");
    expect(derivePlanStatus("cancelled", done)).toBe("cancelled");
  });

  it("completes only when nothing is outstanding", () => {
    expect(derivePlanStatus("active", done)).toBe("completed");
    expect(derivePlanStatus("active", open)).toBe("active");
  });

  it("blocks when an activity is blocked", () => {
    expect(derivePlanStatus("active", blockedProgress)).toBe("blocked");
  });

  it("does not complete an empty plan", () => {
    expect(derivePlanStatus("active", planProgress([], TODAY))).toBe("active");
  });
});

describe("completionReport", () => {
  it("lists every gap that stands between the plan and closure", () => {
    const report = completionReport(
      [
        activity({ seq: 1, status: "signed_off" }),
        activity({ seq: 2, evidenceRequired: true, signoffRequiredCount: 2, signoffCount: 1, dueDate: "2026-08-01" }),
      ],
      TODAY,
    );
    expect(report.complete).toBe(false);
    expect(report.gaps).toEqual([
      "Activity 2: evidence required and none attached.",
      "Activity 2: 1 of 2 required signatures outstanding.",
      "Activity 2: past its due date of 2026-08-01.",
    ]);
    expect(report.rows[1]?.overdue).toBe(true);
  });

  it("is complete when every activity is closed", () => {
    const report = completionReport([activity({ seq: 1, status: "signed_off" }), activity({ seq: 2, status: "waived" })], TODAY);
    expect(report.complete).toBe(true);
    expect(report.gaps).toEqual([]);
  });

  it("is not complete when the plan is empty", () => {
    expect(completionReport([], TODAY).complete).toBe(false);
  });
});
