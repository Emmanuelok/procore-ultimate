import { describe, expect, it } from "vitest";
import {
  collapsedAsBuilt,
  impactedAsPlanned,
  recommendMethods,
  retrospectiveLongestPath,
  windowsAnalysis,
  type ForensicEvent,
  type ForensicNetwork,
} from "./methods.js";
import type { Cpm2DependencyInput, Cpm2TaskInput } from "../schedule/cpm2.js";

const START = "2026-01-05";

/** a(10d) -> b(10d) -> c(10d); d(5d) hangs off a with plenty of float. */
function network(overrides: Partial<Cpm2TaskInput>[] = []): ForensicNetwork {
  const base: Cpm2TaskInput[] = [
    { id: "a", duration: 10 },
    { id: "b", duration: 10 },
    { id: "c", duration: 10 },
    { id: "d", duration: 5 },
  ];
  const tasks = base.map((t) => {
    const o = overrides.find((x) => x.id === t.id);
    return o ? { ...t, ...o } : t;
  });
  const deps: Cpm2DependencyInput[] = [
    { predecessorId: "a", successorId: "b", type: "FS", lagDays: 0 },
    { predecessorId: "b", successorId: "c", type: "FS", lagDays: 0 },
    { predecessorId: "a", successorId: "d", type: "FS", lagDays: 0 },
  ];
  return { tasks, deps, projectStart: START };
}

function ev(id: string, extra: Partial<ForensicEvent> = {}): ForensicEvent {
  return {
    id,
    title: `Event ${id}`,
    startDate: "2026-01-15",
    durationDays: 5,
    struckTaskId: "b",
    party: "owner",
    excusable: true,
    compensable: true,
    ...extra,
  };
}

describe("impacted as-planned (MIP 3.6)", () => {
  it("reports each event's incremental effect, cumulatively", () => {
    const res = impactedAsPlanned(network(), [
      ev("e1", { startDate: "2026-01-15", durationDays: 5 }),
      ev("e2", { startDate: "2026-01-25", durationDays: 3 }),
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.baselineDurationDays).toBe(30);
    expect(res.steps).toHaveLength(2);
    expect(res.steps[0]!.incrementalDays).toBe(5);
    expect(res.steps[0]!.cumulativeDays).toBe(5);
    expect(res.steps[1]!.cumulativeDays).toBe(res.totalDays);
    // The second event's cumulative effect can never be less than the first's.
    expect(res.steps[1]!.cumulativeDays).toBeGreaterThanOrEqual(res.steps[0]!.cumulativeDays);
    expect(res.mipCode).toBe("3.6");
  });

  it("an event striking an activity with float does not move completion", () => {
    const res = impactedAsPlanned(network(), [ev("e1", { struckTaskId: "d", durationDays: 3 })]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.steps[0]!.incrementalDays).toBe(0);
    expect(res.steps[0]!.driving).toBe(false);
    expect(res.totalDays).toBe(0);
  });

  it("skips events it cannot model instead of scoring them as zero impact", () => {
    const res = impactedAsPlanned(network(), [
      ev("e1", { struckTaskId: null }),
      ev("e2", { struckTaskId: "missing" }),
      ev("e3", { durationDays: 0 }),
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.steps).toHaveLength(0);
    expect(res.skipped.map((s) => s.eventId).sort()).toEqual(["e1", "e2", "e3"]);
    expect(res.skipped[0]!.reason).toMatch(/struck activity/);
  });

  it("refuses to run on a cyclic network", () => {
    const n = network();
    n.deps.push({ predecessorId: "c", successorId: "a", type: "FS", lagDays: 0 });
    const res = impactedAsPlanned(n, [ev("e1")]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/cycle/);
  });
});

describe("collapsed as-built (MIP 3.8)", () => {
  it("computes the but-for completion by removing one party's delay", () => {
    // As-built: b actually took 15 days (10 planned + a 5-day owner event).
    const n = network([{ id: "b", duration: 15 }]);
    const res = collapsedAsBuilt(n, [ev("e1", { struckTaskId: "b", durationDays: 5, party: "owner" })], "owner");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.collapsedDays).toBe(5);
    expect(res.removed).toHaveLength(1);
    expect(res.butForFinish! < res.asBuiltFinish!).toBe(true);
    expect(res.mipCode).toBe("3.8");
  });

  it("returns a zero collapse when the party owns no events, rather than an error", () => {
    const res = collapsedAsBuilt(network(), [ev("e1", { party: "owner" })], "contractor");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.collapsedDays).toBe(0);
    expect(res.removed).toHaveLength(0);
    expect(res.butForFinish).toBe(res.asBuiltFinish);
  });

  it("releases actual dates on collapsed activities so the logic can reschedule", () => {
    const n = network([
      { id: "a", duration: 10, actualStart: "2026-01-05", actualFinish: "2026-01-14" },
      { id: "b", duration: 15, actualStart: "2026-01-15" },
    ]);
    const res = collapsedAsBuilt(n, [ev("e1", { struckTaskId: "b", durationDays: 5 })], "owner");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.collapsedDays).toBeGreaterThan(0);
  });

  it("reports events whose struck activity is missing", () => {
    const res = collapsedAsBuilt(network(), [ev("e1", { struckTaskId: "ghost" })], "owner");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.skipped[0]!.reason).toMatch(/not in this network/);
  });
});

describe("windows analysis (MIP 3.4)", () => {
  it("measures per-window movement and attributes it to driving events only", () => {
    const startNetwork = network();
    const endNetwork = network([{ id: "b", duration: 15 }]); // b slipped 5 days
    const res = windowsAnalysis(
      [
        {
          start: "2026-01-01",
          end: "2026-02-01",
          startNetwork,
          startSourceId: "rev1",
          startSourceName: "Rev 1",
          endNetwork,
          endSourceId: "rev2",
          endSourceName: "Rev 2",
        },
      ],
      [
        ev("driving", { startDate: "2026-01-10", struckTaskId: "b", durationDays: 5 }),
        ev("floatbound", { startDate: "2026-01-12", struckTaskId: "d", durationDays: 5 }),
        ev("outside", { startDate: "2026-03-01", struckTaskId: "b", durationDays: 5 }),
      ],
      );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const w = res.windows[0]!;
    expect(w.movementDays).toBe(5);
    expect(w.events.map((e) => e.eventId).sort()).toEqual(["driving", "floatbound"]);
    expect(w.events.find((e) => e.eventId === "driving")!.driving).toBe(true);
    expect(w.events.find((e) => e.eventId === "floatbound")!.driving).toBe(false);
    expect(w.drivingEvents).toBe(1);
    expect(w.attributedDays).toBe(5);
    expect(w.unattributedDays).toBe(0);
  });

  it("reports unattributed movement instead of forcing the numbers to agree", () => {
    const startNetwork = network();
    const endNetwork = network([{ id: "c", duration: 20 }]); // 10 days of slip nobody claimed
    const res = windowsAnalysis(
      [
        {
          start: "2026-01-01",
          end: null,
          startNetwork,
          startSourceId: null,
          startSourceName: null,
          endNetwork,
          endSourceId: null,
          endSourceName: null,
        },
      ],
      [],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.windows[0]!.movementDays).toBe(10);
    expect(res.windows[0]!.unattributedDays).toBe(10);
  });

  it("explains why an event could not be modelled", () => {
    const n = network();
    const res = windowsAnalysis(
      [
        {
          start: "2026-01-01",
          end: null,
          startNetwork: n,
          startSourceId: null,
          startSourceName: null,
          endNetwork: n,
          endSourceId: null,
          endSourceName: null,
        },
      ],
      [ev("e1", { startDate: "2026-01-10", struckTaskId: null })],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.windows[0]!.events[0]!.reason).toMatch(/struck activity/);
    expect(res.windows[0]!.events[0]!.tiaDeltaDays).toBeNull();
  });
});

describe("retrospective longest path (MIP 3.9)", () => {
  it("returns the driving chain with dates", () => {
    const res = retrospectiveLongestPath(network());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.path.map((p) => p.taskId)).toEqual(["a", "b", "c"]);
    expect(res.finish).toBe("2026-02-03");
  });
});

describe("AACE 29R-03 method selection", () => {
  it("recommends windows retrospectively when updates exist", () => {
    const recs = recommendMethods({
      perspective: "retrospective",
      updatesAvailable: true,
      baselineAvailable: true,
      asBuiltComplete: true,
      concurrencyInIssue: false,
    });
    expect(recs[0]!.suitability).toBe("recommended");
    expect(recs.find((r) => r.method === "windows")!.suitability).toBe("recommended");
  });

  it("rules out impacted as-planned with no baseline and says why", () => {
    const recs = recommendMethods({
      perspective: "prospective",
      updatesAvailable: false,
      baselineAvailable: false,
      asBuiltComplete: false,
      concurrencyInIssue: false,
    });
    const iap = recs.find((r) => r.method === "impacted_as_planned")!;
    expect(iap.suitability).toBe("not_advised");
    expect(iap.rationale).toMatch(/baseline/);
  });

  it("adds a concurrency assessment when concurrency is in issue", () => {
    const recs = recommendMethods({
      perspective: "retrospective",
      updatesAvailable: true,
      baselineAvailable: true,
      asBuiltComplete: true,
      concurrencyInIssue: true,
    });
    expect(recs.some((r) => r.method === "concurrency")).toBe(true);
  });
});
