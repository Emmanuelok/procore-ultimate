import { describe, expect, it } from "vitest";
import {
  attentionId,
  daysUntil,
  moneyFactor,
  rankAttention,
  rankCandidates,
  severityForDeadline,
  severityWeight,
  urgencyFactor,
  type AttentionCandidate,
} from "./attention-engine.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const iso = (daysFromNow: number) => new Date(NOW.getTime() + daysFromNow * 86_400_000).toISOString();

const candidate = (over: Partial<AttentionCandidate> = {}): AttentionCandidate => ({
  companyId: "cmp_1",
  projectId: "prj_1",
  projectName: "Bridge",
  kind: "obligation_due",
  severity: "medium",
  title: "Serve notice under cl. 20.1",
  detail: "Notice of claim",
  dueAt: iso(2),
  href: "/projects/prj_1/contracts",
  sourceType: "obligation",
  sourceId: "obl_1",
  ...over,
});

describe("attentionId", () => {
  it("is deterministic and depends on company, source and kind", () => {
    const a = attentionId("c", "obligation", "o1", "obligation_due");
    expect(a).toBe(attentionId("c", "obligation", "o1", "obligation_due"));
    expect(a).toMatch(/^att_[0-9a-f]{24}$/);
    expect(a).not.toBe(attentionId("c2", "obligation", "o1", "obligation_due"));
    expect(a).not.toBe(attentionId("c", "obligation", "o1", "time_bar"));
  });
});

describe("factors", () => {
  it("orders severity weights", () => {
    expect(severityWeight("critical")).toBeGreaterThan(severityWeight("high"));
    expect(severityWeight("high")).toBeGreaterThan(severityWeight("medium"));
    expect(severityWeight("medium")).toBeGreaterThan(severityWeight("low"));
    expect(severityWeight("low")).toBeGreaterThan(severityWeight("info"));
  });

  it("urgency rises as the deadline nears and peaks when overdue", () => {
    const later = urgencyFactor(iso(60), NOW);
    const month = urgencyFactor(iso(20), NOW);
    const week = urgencyFactor(iso(5), NOW);
    const days = urgencyFactor(iso(2), NOW);
    const today = urgencyFactor(iso(0.5), NOW);
    const overdue = urgencyFactor(iso(-1), NOW);
    const longOverdue = urgencyFactor(iso(-20), NOW);
    expect(later).toBeLessThan(month);
    expect(month).toBeLessThan(week);
    expect(week).toBeLessThan(days);
    expect(days).toBeLessThan(today);
    expect(today).toBeLessThan(overdue);
    expect(overdue).toBeLessThan(longOverdue);
  });

  it("an item without a deadline sits below one due this month", () => {
    expect(urgencyFactor(null, NOW)).toBeLessThan(urgencyFactor(iso(20), NOW));
    expect(urgencyFactor("not a date", NOW)).toBe(urgencyFactor(null, NOW));
  });

  it("money is a magnitude multiplier and never negative", () => {
    expect(moneyFactor(null)).toBe(1);
    expect(moneyFactor(0)).toBe(1);
    expect(moneyFactor(-5)).toBe(1);
    expect(moneyFactor(500)).toBeGreaterThan(1);
    expect(moneyFactor(50_000)).toBeGreaterThan(moneyFactor(500));
    expect(moneyFactor(500_000)).toBeGreaterThan(moneyFactor(50_000));
    expect(moneyFactor(5_000_000)).toBeGreaterThan(moneyFactor(500_000));
  });

  it("daysUntil rounds and handles missing deadlines", () => {
    expect(daysUntil(iso(3), NOW)).toBe(3);
    expect(daysUntil(iso(-2), NOW)).toBe(-2);
    expect(daysUntil(null, NOW)).toBeNull();
  });

  it("severityForDeadline escalates as the date closes", () => {
    expect(severityForDeadline(iso(-1), NOW)).toBe("critical");
    expect(severityForDeadline(iso(2), NOW)).toBe("high");
    expect(severityForDeadline(iso(10), NOW)).toBe("medium");
    expect(severityForDeadline(iso(40), NOW)).toBe("low");
    expect(severityForDeadline(null, NOW, "low")).toBe("low");
  });
});

describe("rankAttention", () => {
  it("multiplies severity, urgency and money", () => {
    const c = candidate({ severity: "high", dueAt: iso(-1), money: 250_000 });
    expect(rankAttention(c, NOW)).toBe(Math.round(70 * 1.5 * 1.2 * 100) / 100);
  });

  it("an overdue medium item outranks a far-off critical one only when the gap is large enough", () => {
    const overdueMedium = rankAttention(candidate({ severity: "medium", dueAt: iso(-10) }), NOW);
    const farCritical = rankAttention(candidate({ severity: "critical", dueAt: iso(90) }), NOW);
    expect(farCritical).toBeGreaterThan(overdueMedium);
    const overdueHigh = rankAttention(candidate({ severity: "high", dueAt: iso(-10), money: 2_000_000 }), NOW);
    expect(overdueHigh).toBeGreaterThan(farCritical);
  });
});

describe("rankCandidates", () => {
  it("sorts by score, then earlier deadline, then title, and dedupes by id keeping the higher score", () => {
    const ranked = rankCandidates(
      [
        candidate({ sourceId: "a", severity: "low", dueAt: iso(20), title: "Zed" }),
        candidate({ sourceId: "b", severity: "critical", dueAt: iso(-3), title: "Alpha" }),
        candidate({ sourceId: "c", severity: "low", dueAt: iso(20), title: "Beta" }),
        candidate({ sourceId: "b", severity: "medium", dueAt: iso(-3), title: "Alpha (older read)" }),
        candidate({ sourceId: "d", severity: "low", dueAt: iso(5), title: "Gamma" }),
      ],
      NOW,
    );
    expect(ranked.map((r) => r.sourceId)).toEqual(["b", "d", "c", "a"]);
    expect(ranked[0]?.severity).toBe("critical");
    expect(ranked[0]?.id).toBe(attentionId("cmp_1", "obligation", "b", "obligation_due"));
    expect(new Set(ranked.map((r) => r.id)).size).toBe(4);
  });

  it("is stable across calls with the same clock", () => {
    const input = [
      candidate({ sourceId: "x", dueAt: iso(1) }),
      candidate({ sourceId: "y", dueAt: iso(1), title: "Another" }),
    ];
    expect(rankCandidates(input, NOW)).toEqual(rankCandidates([...input].reverse(), NOW));
  });
});
