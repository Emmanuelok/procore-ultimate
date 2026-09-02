import { describe, expect, it } from "vitest";
import {
  buildScottSchedule,
  scoreClaimSufficiency,
  type ChainLimbInput,
  type EventSufficiencyInput,
} from "./sufficiency.js";

const LONG = "The employer's late issue of the reinforcement drawings prevented the steel fixing to grid lines 4 to 9 from commencing on the programmed date, and the delay is evidenced by the contemporaneous records set out below in full detail.";

function limb(key: ChainLimbInput["key"], text = LONG, evidence: ChainLimbInput["evidence"] = []): ChainLimbInput {
  return { key, text, evidence };
}

function event(extra: Partial<EventSufficiencyInput> = {}): EventSufficiencyInput {
  return {
    eventId: "e1",
    number: 1,
    title: "Late reinforcement drawings",
    startDate: "2026-03-02",
    durationDays: 5,
    evidence: [
      { id: "ev1", kind: "photo", independenceScore: 0.8, capturedAt: "2026-03-03T09:00:00Z" },
      { id: "ev2", kind: "log", independenceScore: 0.6, capturedAt: "2026-03-04T09:00:00Z" },
    ],
    noticeServedAt: "2026-03-05T09:00:00Z",
    noticeDueDate: "2026-03-16",
    dailyLogDates: ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"],
    recordTypes: ["daily_log", "photo", "correspondence", "instruction"],
    ...extra,
  };
}

describe("chain limb scoring (#307)", () => {
  it("scores a full, evidenced limb higher than an empty one", () => {
    const res = scoreClaimSufficiency({
      limbs: [
        limb("cause", LONG, [{ id: "e", kind: "photo", independenceScore: 0.9, capturedAt: null }]),
        limb("effect", ""),
        limb("entitlement", ""),
        limb("quantum", ""),
      ],
      events: [],
    });
    const cause = res.limbs.find((l) => l.key === "cause")!;
    const effect = res.limbs.find((l) => l.key === "effect")!;
    expect(cause.score).toBeGreaterThan(effect.score);
    expect(effect.present).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/effect, entitlement, quantum limbs are empty/);
  });

  it("penalises self-generated evidence", () => {
    const independent = scoreClaimSufficiency({
      limbs: [limb("cause", LONG, [{ id: "a", kind: "x", independenceScore: 1, capturedAt: null }])],
      events: [],
    });
    const selfMade = scoreClaimSufficiency({
      limbs: [limb("cause", LONG, [{ id: "a", kind: "x", independenceScore: 0.1, capturedAt: null }])],
      events: [],
    });
    expect(independent.limbs[0]!.score).toBeGreaterThan(selfMade.limbs[0]!.score);
    expect(selfMade.limbs[0]!.reasons.join(" ")).toMatch(/self-generated/);
  });
});

describe("event sufficiency and gap detection (#308-309)", () => {
  it("scores a well-recorded event highly and finds no gaps", () => {
    const res = scoreClaimSufficiency({ limbs: [limb("cause")], events: [event()] });
    const e = res.events[0]!;
    expect(e.logCoveragePercent).toBe(100);
    expect(e.gaps).toHaveLength(0);
    expect(e.noticeServed).toBe(true);
    expect(e.noticeInTimeBar).toBe(true);
    expect(e.coverage).toBe(1);
    expect(e.score).toBeGreaterThan(0.7);
  });

  it("reports the exact date ranges with no daily log", () => {
    const res = scoreClaimSufficiency({
      limbs: [limb("cause")],
      events: [event({ dailyLogDates: ["2026-03-02", "2026-03-06"] })],
    });
    const e = res.events[0]!;
    expect(e.logCoveragePercent).toBe(40);
    expect(e.gaps).toEqual([{ from: "2026-03-03", to: "2026-03-05", days: 3, kind: "no_daily_log" }]);
    expect(res.gaps[0]!.eventId).toBe("e1");
  });

  it("flags a notice served outside the contractual time bar", () => {
    const res = scoreClaimSufficiency({
      limbs: [limb("cause")],
      events: [event({ noticeServedAt: "2026-04-01T09:00:00Z", noticeDueDate: "2026-03-16" })],
    });
    expect(res.events[0]!.noticeInTimeBar).toBe(false);
    expect(res.missingNotices[0]!.reason).toMatch(/outside the contractual time bar/);
  });

  it("flags a missing notice", () => {
    const res = scoreClaimSufficiency({
      limbs: [limb("cause")],
      events: [event({ noticeServedAt: null })],
    });
    expect(res.events[0]!.noticeServed).toBe(false);
    expect(res.missingNotices[0]!.reason).toMatch(/no notice has been recorded/);
  });

  it("penalises evidence captured long after the event", () => {
    const contemporaneous = scoreClaimSufficiency({ limbs: [limb("cause")], events: [event()] });
    const reconstructed = scoreClaimSufficiency({
      limbs: [limb("cause")],
      events: [
        event({
          evidence: [
            { id: "ev1", kind: "photo", independenceScore: 0.8, capturedAt: "2027-01-01T09:00:00Z" },
            { id: "ev2", kind: "log", independenceScore: 0.6, capturedAt: "2027-01-02T09:00:00Z" },
          ],
        }),
      ],
    });
    expect(reconstructed.events[0]!.contemporaneity).toBe(0);
    expect(reconstructed.events[0]!.score).toBeLessThan(contemporaneous.events[0]!.score);
    expect(reconstructed.events[0]!.reasons.join(" ")).toMatch(/reconstructed records/);
  });

  it("names the record types that are missing", () => {
    const res = scoreClaimSufficiency({
      limbs: [limb("cause")],
      events: [event({ recordTypes: ["daily_log"] })],
    });
    expect(res.events[0]!.reasons.join(" ")).toMatch(/No photo, correspondence, instruction record is linked/);
    expect(res.events[0]!.coverage).toBe(0.25);
  });

  it("says so when the claim links no events at all", () => {
    const res = scoreClaimSufficiency({ limbs: [limb("cause")], events: [] });
    expect(res.reasons.join(" ")).toMatch(/links no delay events/);
  });
});

describe("Scott Schedule (#317-319)", () => {
  it("fills the claimant columns and leaves the respondent and tribunal columns empty", () => {
    const rows = buildScottSchedule({
      claimNumber: 3,
      claimTitle: "EOT 4",
      currency: "GBP",
      events: [
        {
          id: "e1",
          number: 12,
          title: "Late reinforcement drawings",
          description: null,
          cause: "late_design_information",
          party: "owner",
          excusable: true,
          compensable: true,
          startDate: "2026-03-02",
          durationDays: 5,
          evidenceIds: ["ev1", "ev2"],
          tiaDeltaDays: 5,
        },
      ],
      amountsByEvent: { e1: 25_000 },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.item).toBe(1);
    expect(row.reference).toBe("DE-12");
    expect(row.claimantContention).toContain("late design information");
    expect(row.claimantContention).toContain("5-day movement");
    expect(row.daysClaimed).toBe(5);
    expect(row.amountClaimed).toBe(25_000);
    expect(row.respondentResponse).toBe("");
    expect(row.tribunalFinding).toBe("");
    expect(row.daysAwarded).toBeNull();
  });

  it("says when no TIA has been run rather than implying zero impact", () => {
    const rows = buildScottSchedule({
      claimNumber: 1,
      claimTitle: "EOT",
      currency: "GBP",
      events: [
        {
          id: "e1",
          title: "Weather",
          description: "Exceptional rainfall",
          cause: "exceptional_weather",
          party: "neither",
          excusable: true,
          compensable: false,
          startDate: "2026-03-02",
          durationDays: 3,
          evidenceIds: [],
          tiaDeltaDays: null,
        },
      ],
    });
    expect(rows[0]!.claimantContention).toContain("No time impact analysis has been run");
    expect(rows[0]!.daysClaimed).toBeNull();
  });
});
