import { describe, expect, it } from "vitest";
import { reconcileAttendance, type AttendanceClaim, type AttendanceObservation } from "./attendance.js";

const window = { from: "2026-05-04", to: "2026-05-05" };

const observation = (over: Partial<AttendanceObservation> = {}): AttendanceObservation => ({
  date: "2026-05-04",
  personKey: "worker:wk1",
  personName: "Ada Mason",
  workerId: "wk1",
  firstIn: "2026-05-04T07:00:00.000Z",
  lastOut: "2026-05-04T16:00:00.000Z",
  hours: 9,
  openAtWindowEnd: false,
  ...over,
});

const claim = (over: Partial<AttendanceClaim> = {}): AttendanceClaim => ({
  workerId: "wk1",
  workerName: "Ada Mason",
  date: "2026-05-04",
  firstIn: "07:00",
  lastOut: "16:00",
  hours: 9,
  source: "turnstile",
  ...over,
});

describe("reconcileAttendance", () => {
  it("agrees when the claim matches the gate within tolerance", () => {
    const r = reconcileAttendance([claim({ hours: 9.4 })], [observation()], window);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]?.result).toBe("agreed");
    expect(r.lines[0]?.varianceHours).toBe(0.4);
    expect(r.comparedLines).toBe(1);
    expect(r.worstOverclaimHours).toBeNull();
  });

  it("names an over-claim and its size, and an under-claim separately", () => {
    const r = reconcileAttendance(
      [claim({ hours: 12 }), claim({ workerId: "wk2", workerName: "Ben Coles", hours: 5 })],
      [observation(), observation({ workerId: "wk2", personKey: "worker:wk2", personName: "Ben Coles", hours: 9 })],
      window,
    );
    const ada = r.lines.find((l) => l.workerId === "wk1");
    const ben = r.lines.find((l) => l.workerId === "wk2");
    expect(ada?.result).toBe("over_claimed");
    expect(ada?.varianceHours).toBe(3);
    expect(ben?.result).toBe("under_claimed");
    expect(ben?.varianceHours).toBe(-4);
    expect(r.worstOverclaimHours).toBe(3);
    expect(r.byResult.over_claimed).toBe(1);
    expect(r.byResult.under_claimed).toBe(1);
  });

  it("does not call a day the feed never ran a discrepancy", () => {
    // The feed recorded reads on the 4th only; a claim on the 5th is untested.
    const r = reconcileAttendance([claim({ date: "2026-05-05" }), claim()], [observation()], window);
    const fifth = r.lines.find((l) => l.date === "2026-05-05");
    expect(fifth?.result).toBe("not_comparable");
    expect(fifth?.reasons.join(" ")).toContain("recorded nothing at all");
    expect(r.byResult.no_gate_record).toBe(0);
    expect(r.reasons.join(" ")).toContain("covers 1 of the 2 day(s)");
  });

  it("flags a claim with no gate read only on a day the feed was running", () => {
    const r = reconcileAttendance(
      [claim({ workerId: "wk3", workerName: "Cara Vine" }), claim()],
      [observation()],
      window,
    );
    const cara = r.lines.find((l) => l.workerId === "wk3");
    expect(cara?.result).toBe("no_gate_record");
    expect(cara?.observedHours).toBeNull();
  });

  it("reports gate presence the labour register does not know about", () => {
    const r = reconcileAttendance([], [observation()], window);
    expect(r.lines[0]?.result).toBe("no_attendance_record");
    expect(r.lines[0]?.observedHours).toBe(9);
    expect(r.reasons.join(" ")).toContain("no attendance records");
  });

  it("keeps an unmatched badge out of the accusation and lists it separately", () => {
    const r = reconcileAttendance(
      [claim()],
      [observation(), observation({ workerId: null, personKey: "badge:V-12", personName: "Visitor V-12", hours: 2 })],
      window,
    );
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]?.result).toBe("agreed");
    expect(r.unattributedPresence).toEqual([
      { date: "2026-05-04", personKey: "badge:V-12", personName: "Visitor V-12", hours: 2 },
    ]);
    expect(r.reasons.join(" ")).toContain("no worker id");
  });

  it("refuses to compare a session that is still open, or a claim with no hours", () => {
    const open = reconcileAttendance([claim()], [observation({ openAtWindowEnd: true })], window);
    expect(open.lines[0]?.result).toBe("not_comparable");
    expect(open.lines[0]?.reasons.join(" ")).toContain("not yet a fact");

    const noHours = reconcileAttendance([claim({ hours: null })], [observation()], window);
    expect(noHours.lines[0]?.result).toBe("not_comparable");
    expect(noHours.lines[0]?.claimedHours).toBeNull();
    expect(noHours.comparedLines).toBe(0);
  });

  it("sums two badges for one worker on one day rather than double-counting the day", () => {
    const r = reconcileAttendance(
      [claim({ hours: 9 })],
      [
        observation({ hours: 4, personKey: "badge:A", lastOut: "2026-05-04T11:00:00.000Z" }),
        observation({ hours: 5, personKey: "badge:B", firstIn: "2026-05-04T11:30:00.000Z" }),
      ],
      window,
    );
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]?.observedHours).toBe(9);
    expect(r.lines[0]?.result).toBe("agreed");
  });

  it("says the feed is the problem when it recorded nothing in the window at all", () => {
    const r = reconcileAttendance([claim()], [], window);
    expect(r.daysWithGateReads).toBe(0);
    expect(r.lines[0]?.result).toBe("not_comparable");
    expect(r.reasons.join(" ")).toContain("evidence that the feed is not running");
  });

  it("ignores claims and observations outside the window", () => {
    const r = reconcileAttendance(
      [claim({ date: "2026-06-01" })],
      [observation({ date: "2026-06-01" })],
      window,
    );
    expect(r.lines).toHaveLength(0);
    expect(r.daysInWindow).toBe(2);
  });
});
