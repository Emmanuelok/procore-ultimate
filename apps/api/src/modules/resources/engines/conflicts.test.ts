import { describe, expect, it } from "vitest";
import { DEFAULT_WORK_PATTERN, isWorkday } from "./calendar.js";
import {
  computeUtilisation,
  detectAssignmentConflicts,
  type AssignmentWindow,
} from "./conflicts.js";

const booking = (over: Partial<AssignmentWindow> = {}): AssignmentWindow => ({
  id: "a1",
  reference: "RA-001",
  subjectKind: "crew",
  subjectId: "crew_1",
  subjectLabel: "Crew A",
  fromDate: "2026-02-09",
  toDate: "2026-02-13",
  status: "confirmed",
  allocationPercent: 100,
  hoursPerDay: 8,
  scheduleTaskId: null,
  taskName: null,
  ...over,
});

describe("detectAssignmentConflicts", () => {
  it("finds the overlap window when one crew is booked twice at full allocation", () => {
    const conflicts = detectAssignmentConflicts([
      booking({ id: "a1", reference: "RA-001", fromDate: "2026-02-09", toDate: "2026-02-13" }),
      booking({ id: "a2", reference: "RA-002", fromDate: "2026-02-11", toDate: "2026-02-17" }),
    ]);
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0]!;
    expect(c.fromDate).toBe("2026-02-11");
    expect(c.toDate).toBe("2026-02-13");
    expect(c.days).toBe(3);
    expect(c.totalAllocationPercent).toBe(200);
    expect(c.overByPercent).toBe(100);
    expect(c.severity).toBe("critical");
    expect(c.participants.map((p) => p.reference).sort()).toEqual(["RA-001", "RA-002"]);
    expect(c.explanation).toContain("decide which gives way");
  });

  it("does not flag two half allocations", () => {
    expect(
      detectAssignmentConflicts([
        booking({ id: "a1", allocationPercent: 50 }),
        booking({ id: "a2", allocationPercent: 50 }),
      ]),
    ).toEqual([]);
  });

  it("flags three half allocations as a 150% clash", () => {
    const conflicts = detectAssignmentConflicts([
      booking({ id: "a1", allocationPercent: 50 }),
      booking({ id: "a2", allocationPercent: 50 }),
      booking({ id: "a3", allocationPercent: 50 }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.totalAllocationPercent).toBe(150);
    expect(conflicts[0]!.severity).toBe("high");
    expect(conflicts[0]!.participants).toHaveLength(3);
  });

  it("ignores cancelled and completed bookings", () => {
    expect(
      detectAssignmentConflicts([
        booking({ id: "a1" }),
        booking({ id: "a2", status: "cancelled" }),
        booking({ id: "a3", status: "completed" }),
      ]),
    ).toEqual([]);
  });

  it("never conflicts across different subjects", () => {
    expect(
      detectAssignmentConflicts([
        booking({ id: "a1", subjectId: "crew_1" }),
        booking({ id: "a2", subjectId: "crew_2" }),
      ]),
    ).toEqual([]);
    expect(
      detectAssignmentConflicts([
        booking({ id: "a1", subjectKind: "crew", subjectId: "x" }),
        booking({ id: "a2", subjectKind: "worker", subjectId: "x" }),
      ]),
    ).toEqual([]);
  });

  it("merges consecutive days of the same clash into one finding", () => {
    const conflicts = detectAssignmentConflicts([
      booking({ id: "a1", fromDate: "2026-02-01", toDate: "2026-02-28" }),
      booking({ id: "a2", fromDate: "2026-02-01", toDate: "2026-02-28" }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.days).toBe(28);
  });

  it("splits a finding when a third booking joins part-way through", () => {
    const conflicts = detectAssignmentConflicts([
      booking({ id: "a1", fromDate: "2026-02-01", toDate: "2026-02-20" }),
      booking({ id: "a2", fromDate: "2026-02-01", toDate: "2026-02-20" }),
      booking({ id: "a3", fromDate: "2026-02-10", toDate: "2026-02-20" }),
    ]);
    expect(conflicts).toHaveLength(2);
    const totals = conflicts.map((c) => c.totalAllocationPercent).sort((a, b) => a - b);
    expect(totals).toEqual([200, 300]);
  });

  it("skips a booking whose window is inverted", () => {
    expect(
      detectAssignmentConflicts([
        booking({ id: "a1" }),
        booking({ id: "a2", fromDate: "2026-02-13", toDate: "2026-02-09" }),
      ]),
    ).toEqual([]);
  });
});

describe("computeUtilisation", () => {
  const isWork = (iso: string) => isWorkday(iso, DEFAULT_WORK_PATTERN);

  it("counts booked working days against the window", () => {
    const rows = computeUtilisation(
      [booking({ fromDate: "2026-02-09", toDate: "2026-02-11" })],
      { from: "2026-02-09", to: "2026-02-20" },
      isWork,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.windowDays).toBe(10);
    expect(rows[0]!.bookedDays).toBe(3);
    expect(rows[0]!.utilisationPercent).toBe(30);
    expect(rows[0]!.plannedHours).toBe(24);
  });

  it("reports planned hours as unknown when no booking states hours per day", () => {
    const rows = computeUtilisation(
      [booking({ hoursPerDay: null })],
      { from: "2026-02-09", to: "2026-02-13" },
      isWork,
    );
    expect(rows[0]!.plannedHours).toBeNull();
    expect(rows[0]!.reasons.join(" ")).toContain("not derivable");
  });

  it("does not double-count overlapping bookings on the same day", () => {
    const rows = computeUtilisation(
      [
        booking({ id: "a1", fromDate: "2026-02-09", toDate: "2026-02-13" }),
        booking({ id: "a2", fromDate: "2026-02-09", toDate: "2026-02-13" }),
      ],
      { from: "2026-02-09", to: "2026-02-13" },
      isWork,
    );
    expect(rows[0]!.bookedDays).toBe(5);
    expect(rows[0]!.utilisationPercent).toBe(100);
    expect(rows[0]!.assignments).toBe(2);
  });
});
