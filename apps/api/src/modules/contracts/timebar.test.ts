import { describe, expect, it } from "vitest";
import type { ParticularCondition } from "@constructos/db";
import {
  addDaysOnCalendar,
  chainedDeadlines,
  computeDeadline,
  defaultWarnDays,
  effectiveClauses,
  resolveClause,
  sweepVerdict,
} from "./timebar.js";

const CAL = { calendarBasis: "calendar" as const };

describe("effective clause resolution", () => {
  it("uses the library bar when there is no Particular Condition", () => {
    const clause = resolveClause("fidic_red_2017", "20.2", [], CAL);
    expect(clause?.timeBarDays).toBe(28);
    expect(clause?.deadlineSource).toBe("library");
    expect(clause?.amended).toBe(false);
  });

  it("lets a Particular Condition override the bar and records the source", () => {
    const pcs: ParticularCondition[] = [
      { clauseRef: "20.2", amendment: "Notice period extended to 56 days", timeBarDays: 56 },
    ];
    const clause = resolveClause("fidic_red_2017", "20.2", pcs, CAL);
    expect(clause?.timeBarDays).toBe(56);
    expect(clause?.libraryTimeBarDays).toBe(28);
    expect(clause?.deadlineSource).toBe("particular_condition");
    expect(clause?.amended).toBe(true);
  });

  it("treats a PC that deletes a clause as removing its bar", () => {
    const pcs: ParticularCondition[] = [
      { clauseRef: "20.2", amendment: "Sub-Clause 20.2 is deleted", deleted: true },
    ];
    const clause = resolveClause("fidic_red_2017", "20.2", pcs, CAL);
    expect(clause?.deleted).toBe(true);
  });

  it("flags an amendment that carries no structured bar as amended but unchanged", () => {
    const pcs: ParticularCondition[] = [
      { clauseRef: "20.2", amendment: "Wording clarified; period unchanged" },
    ];
    const clause = resolveClause("fidic_red_2017", "20.2", pcs, CAL);
    expect(clause?.amended).toBe(true);
    expect(clause?.timeBarDays).toBe(28);
    expect(clause?.deadlineSource).toBe("library");
  });

  it("surfaces a clause that exists only in the Particular Conditions", () => {
    const pcs: ParticularCondition[] = [
      { clauseRef: "20.9", amendment: "Bespoke notice of dissatisfaction within 21 days", timeBarDays: 21 },
    ];
    const clause = resolveClause("bespoke", "20.9", pcs, CAL);
    expect(clause?.timeBarDays).toBe(21);
    expect(clause?.deadlineSource).toBe("particular_condition");

    const all = effectiveClauses("bespoke", pcs, CAL);
    expect(all).toHaveLength(1);
    expect(all[0]?.clauseRef).toBe("20.9");
  });

  it("overlays the whole clause set for a form", () => {
    const pcs: ParticularCondition[] = [
      { clauseRef: "20.2", amendment: "56 days", timeBarDays: 56 },
    ];
    const all = effectiveClauses("fidic_red_2017", pcs, CAL);
    const amended = all.filter((c) => c.amended);
    expect(amended).toHaveLength(1);
    expect(all.length).toBeGreaterThan(20);
  });
});

describe("calendar arithmetic", () => {
  it("adds calendar days plainly", () => {
    expect(addDaysOnCalendar("2025-01-01", 28, "calendar")).toBe("2025-01-29");
  });

  it("skips weekends when counting working days", () => {
    // Wednesday 2025-01-01 + 5 working days = Wednesday 2025-01-08
    expect(addDaysOnCalendar("2025-01-01", 5, "working")).toBe("2025-01-08");
  });

  it("skips the contract's holidays too", () => {
    expect(addDaysOnCalendar("2025-01-01", 5, "working", ["2025-01-02"])).toBe("2025-01-09");
  });

  it("rolls a zero-day working deadline forward off a weekend", () => {
    // Saturday
    expect(addDaysOnCalendar("2025-01-04", 0, "working")).toBe("2025-01-06");
  });
});

describe("deadline computation", () => {
  const base = {
    form: "fidic_red_2017" as const,
    particularConditions: [] as ParticularCondition[],
    calendarBasis: "calendar" as const,
    holidays: [] as string[],
    startDate: "2025-01-01",
  };

  it("computes from the library clause and explains the source", () => {
    const r = computeDeadline({ ...base, clauseRef: "20.2" });
    expect(r.noticeDeadline).toBe("2025-01-29");
    expect(r.effectiveTimeBarDays).toBe(28);
    expect(r.deadlineSource).toBe("library");
    expect(r.explanation).toContain("20.2");
  });

  it("computes from the Particular Condition when one amends the bar", () => {
    const r = computeDeadline({
      ...base,
      clauseRef: "20.2",
      particularConditions: [{ clauseRef: "20.2", amendment: "56 days", timeBarDays: 56 }],
    });
    expect(r.noticeDeadline).toBe("2025-02-26");
    expect(r.effectiveTimeBarDays).toBe(56);
    expect(r.deadlineSource).toBe("particular_condition");
    expect(r.explanation).toContain("Particular Condition");
    expect(r.explanation).toContain("28");
  });

  it("accepts a manual bar for a bespoke contract with no library", () => {
    const r = computeDeadline({
      ...base,
      form: "bespoke",
      clauseRef: "8.4.2",
      manualTimeBarDays: 30,
    });
    expect(r.noticeDeadline).toBe("2025-01-31");
    expect(r.deadlineSource).toBe("manual");
  });

  it("accepts an explicit deadline over everything else", () => {
    const r = computeDeadline({ ...base, clauseRef: "20.2", manualDeadline: "2025-03-01" });
    expect(r.noticeDeadline).toBe("2025-03-01");
    expect(r.deadlineSource).toBe("manual");
  });

  it("returns no deadline with a reason for an unknown clause", () => {
    const r = computeDeadline({ ...base, form: "bespoke", clauseRef: "99.9" });
    expect(r.noticeDeadline).toBeNull();
    expect(r.explanation).toContain("not in the bespoke library");
  });

  it("returns no deadline for a clause the PC deleted", () => {
    const r = computeDeadline({
      ...base,
      clauseRef: "20.2",
      particularConditions: [{ clauseRef: "20.2", amendment: "deleted", deleted: true }],
    });
    expect(r.noticeDeadline).toBeNull();
    expect(r.explanation).toContain("deleted by the Particular Conditions");
  });

  it("counts working days when the contract says so", () => {
    const r = computeDeadline({
      ...base,
      clauseRef: "20.2",
      calendarBasis: "working",
      startDate: "2025-01-01",
    });
    expect(r.calendarBasis).toBe("working");
    expect(r.noticeDeadline).toBe("2025-02-10");
  });
});

describe("chained deadlines", () => {
  it("spawns the FIDIC 20.2.4 fully detailed claim from awareness", () => {
    const clause = resolveClause("fidic_red_2017", "20.2", [], CAL)!;
    const chain = chainedDeadlines(clause, {
      form: "fidic_red_2017",
      particularConditions: [],
      calendarBasis: "calendar",
      holidays: [],
      awarenessDate: "2025-01-01",
      servedDate: "2025-01-20",
    });
    expect(chain).toHaveLength(1);
    expect(chain[0]?.clauseRef).toBe("20.2.4");
    expect(chain[0]?.deadline).toBe("2025-03-26");
    expect(chain[0]?.from).toBe("awareness");
  });

  it("spawns the NEC 62.3 quotation clock from the date of service", () => {
    const clause = resolveClause("nec4_ecc", "61.3", [], CAL)!;
    const chain = chainedDeadlines(clause, {
      form: "nec4_ecc",
      particularConditions: [],
      calendarBasis: "calendar",
      holidays: [],
      awarenessDate: "2025-01-01",
      servedDate: "2025-02-01",
    });
    expect(chain[0]?.clauseRef).toBe("62.3");
    expect(chain[0]?.deadline).toBe("2025-02-22");
  });

  it("honours a Particular Condition that amends the chained clause", () => {
    const clause = resolveClause("fidic_red_2017", "20.2", [], CAL)!;
    const chain = chainedDeadlines(clause, {
      form: "fidic_red_2017",
      particularConditions: [
        { clauseRef: "20.2.4", amendment: "Fully detailed claim within 120 days", timeBarDays: 120 },
      ],
      calendarBasis: "calendar",
      holidays: [],
      awarenessDate: "2025-01-01",
      servedDate: "2025-01-20",
    });
    expect(chain[0]?.days).toBe(120);
    expect(chain[0]?.deadlineSource).toBe("particular_condition");
  });

  it("drops a chained clause the Particular Conditions delete", () => {
    const clause = resolveClause("fidic_red_2017", "20.2", [], CAL)!;
    const chain = chainedDeadlines(clause, {
      form: "fidic_red_2017",
      particularConditions: [{ clauseRef: "20.2.4", amendment: "deleted", deleted: true }],
      calendarBasis: "calendar",
      holidays: [],
      awarenessDate: "2025-01-01",
      servedDate: "2025-01-20",
    });
    expect(chain).toHaveLength(0);
  });
});

describe("sweep decisions", () => {
  const open = { status: "open", noticeDeadline: "2025-02-01", warnDaysBefore: 7, warnedAt: null };

  it("does nothing while the deadline is far away", () => {
    expect(sweepVerdict(open, "2025-01-01")).toBe("none");
  });

  it("warns inside the warning window, once", () => {
    expect(sweepVerdict(open, "2025-01-28")).toBe("warn");
    expect(sweepVerdict({ ...open, warnedAt: "2025-01-28T00:00:00Z" }, "2025-01-29")).toBe("none");
  });

  it("breaches the day after the deadline, not on it", () => {
    expect(sweepVerdict(open, "2025-02-01")).toBe("warn");
    expect(sweepVerdict(open, "2025-02-02")).toBe("breach");
  });

  it("ignores events that are not open or have no deadline", () => {
    expect(sweepVerdict({ ...open, status: "notice_served" }, "2025-03-01")).toBe("none");
    expect(sweepVerdict({ ...open, noticeDeadline: null }, "2025-03-01")).toBe("none");
  });

  it("derives a sane default warning lead time", () => {
    expect(defaultWarnDays(28)).toBe(7);
    expect(defaultWarnDays(84)).toBe(14);
    expect(defaultWarnDays(2)).toBe(1);
    expect(defaultWarnDays(null)).toBe(0);
  });
});
