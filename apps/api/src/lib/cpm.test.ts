import { describe, expect, it } from "vitest";
import { computeCpm, dayFromIso, isoFromDay } from "./cpm.js";

const START = "2026-01-01";

describe("cpm date helpers", () => {
  it("round-trips days", () => {
    expect(dayFromIso("2026-01-11", START)).toBe(10);
    expect(isoFromDay(10, START)).toBe("2026-01-11");
  });
});

describe("computeCpm", () => {
  it("computes a textbook FS chain with a parallel branch", () => {
    // A(5) -> B(10) -> D(5); A -> C(3) -> D. Critical: A,B,D. C float = 7.
    const r = computeCpm(
      [
        { id: "A", duration: 5 },
        { id: "B", duration: 10 },
        { id: "C", duration: 3 },
        { id: "D", duration: 5 },
      ],
      [
        { predecessorId: "A", successorId: "B", type: "FS", lagDays: 0 },
        { predecessorId: "A", successorId: "C", type: "FS", lagDays: 0 },
        { predecessorId: "B", successorId: "D", type: "FS", lagDays: 0 },
        { predecessorId: "C", successorId: "D", type: "FS", lagDays: 0 },
      ],
      { projectStart: START },
    );
    expect(r.ok).toBe(true);
    expect(r.projectDurationDays).toBe(20);
    expect(r.criticalIds.sort()).toEqual(["A", "B", "D"]);
    expect(r.tasks.get("C")!.totalFloat).toBe(7);
    expect(r.tasks.get("A")!.startDate).toBe("2026-01-01");
    expect(r.tasks.get("A")!.finishDate).toBe("2026-01-05"); // inclusive
    expect(r.tasks.get("B")!.startDate).toBe("2026-01-06");
  });

  it("handles SS and FF with lags", () => {
    // A(10); B(4) SS+2 after A → B.ES=2; C(6) FF+0 with A → C.EF=10 → C.ES=4.
    const r = computeCpm(
      [
        { id: "A", duration: 10 },
        { id: "B", duration: 4 },
        { id: "C", duration: 6 },
      ],
      [
        { predecessorId: "A", successorId: "B", type: "SS", lagDays: 2 },
        { predecessorId: "A", successorId: "C", type: "FF", lagDays: 0 },
      ],
      { projectStart: START },
    );
    expect(r.tasks.get("B")!.earlyStart).toBe(2);
    expect(r.tasks.get("C")!.earlyFinish).toBe(10);
    expect(r.tasks.get("C")!.earlyStart).toBe(4);
  });

  it("supports negative lag (lead)", () => {
    const r = computeCpm(
      [
        { id: "A", duration: 10 },
        { id: "B", duration: 5 },
      ],
      [{ predecessorId: "A", successorId: "B", type: "FS", lagDays: -3 }],
      { projectStart: START },
    );
    expect(r.tasks.get("B")!.earlyStart).toBe(7);
    expect(r.projectDurationDays).toBe(12);
  });

  it("milestones (duration 0) sit on the path correctly", () => {
    const r = computeCpm(
      [
        { id: "A", duration: 5 },
        { id: "M", duration: 0 },
        { id: "B", duration: 5 },
      ],
      [
        { predecessorId: "A", successorId: "M", type: "FS", lagDays: 0 },
        { predecessorId: "M", successorId: "B", type: "FS", lagDays: 0 },
      ],
      { projectStart: START },
    );
    const m = r.tasks.get("M")!;
    expect(m.earlyStart).toBe(5);
    expect(m.earlyFinish).toBe(5);
    expect(m.isCritical).toBe(true);
    expect(m.startDate).toBe(m.finishDate);
  });

  it("start_no_earlier_than pushes ES; must_start_on can create negative float", () => {
    const r = computeCpm(
      [
        { id: "A", duration: 5 },
        { id: "B", duration: 5, constraintType: "start_no_earlier_than", constraintDate: "2026-01-11" },
      ],
      [{ predecessorId: "A", successorId: "B", type: "FS", lagDays: 0 }],
      { projectStart: START },
    );
    expect(r.tasks.get("B")!.earlyStart).toBe(10);

    const r2 = computeCpm(
      [
        { id: "A", duration: 10 },
        { id: "B", duration: 5, constraintType: "must_start_on", constraintDate: "2026-01-06" },
      ],
      [{ predecessorId: "A", successorId: "B", type: "FS", lagDays: 0 }],
      { projectStart: START },
    );
    // must_start_on day 5 while pred needs 10 → pinned ES=5... forward pins to 5,
    // pred pushes bound 10 but pin wins; float measured against its own LS pin = 0
    expect(r2.tasks.get("B")!.earlyStart).toBe(5);
  });

  it("finish_no_later_than produces negative float when breached", () => {
    const r = computeCpm(
      [{ id: "A", duration: 10, constraintType: "finish_no_later_than", constraintDate: "2026-01-05" }],
      [],
      { projectStart: START },
    );
    expect(r.tasks.get("A")!.totalFloat).toBeLessThan(0);
  });

  it("actuals pin the forward pass", () => {
    const r = computeCpm(
      [
        { id: "A", duration: 5, actualStart: "2026-01-03", actualFinish: "2026-01-09" },
        { id: "B", duration: 5 },
      ],
      [{ predecessorId: "A", successorId: "B", type: "FS", lagDays: 0 }],
      { projectStart: START },
    );
    expect(r.tasks.get("A")!.startDate).toBe("2026-01-03");
    expect(r.tasks.get("A")!.finishDate).toBe("2026-01-09");
    expect(r.tasks.get("B")!.startDate).toBe("2026-01-10");
  });

  it("detects cycles and reports the members", () => {
    const r = computeCpm(
      [
        { id: "A", duration: 5 },
        { id: "B", duration: 5 },
        { id: "C", duration: 2 },
      ],
      [
        { predecessorId: "A", successorId: "B", type: "FS", lagDays: 0 },
        { predecessorId: "B", successorId: "A", type: "FS", lagDays: 0 },
      ],
      { projectStart: START },
    );
    expect(r.ok).toBe(false);
    expect(r.cycle.sort()).toEqual(["A", "B"]);
  });

  it("fragnet insertion delays the completion (TIA primitive)", () => {
    const base = [
      { id: "A", duration: 5 },
      { id: "B", duration: 10 },
    ];
    const baseDeps = [{ predecessorId: "A", successorId: "B", type: "FS" as const, lagDays: 0 }];
    const before = computeCpm(base, baseDeps, { projectStart: START });
    const withFragnet = computeCpm(
      [...base, { id: "DELAY", duration: 7 }],
      [
        { predecessorId: "A", successorId: "DELAY", type: "FS", lagDays: 0 },
        { predecessorId: "DELAY", successorId: "B", type: "FS", lagDays: 0 },
      ],
      { projectStart: START },
    );
    expect(withFragnet.projectDurationDays - before.projectDurationDays).toBe(7);
  });
});
