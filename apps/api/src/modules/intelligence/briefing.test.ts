import { describe, expect, it } from "vitest";
import {
  briefingOutputSchema,
  buildBriefingContext,
  reconcileCitations,
  type BriefingOutput,
} from "./briefing.js";
import type { PulseResponse } from "./types.js";

const pulse = (): PulseResponse => ({
  generatedAt: "2026-09-01T06:00:00.000Z",
  portfolio: { projects: 2, byStage: { course_of_construction: 2 }, byHealth: { on_track: 1, watch: 0, off_track: 1, unrated: 0 } },
  attention: [
    {
      id: "att_1",
      projectId: "prj_a",
      projectName: "Bridge",
      kind: "time_bar",
      severity: "critical",
      title: "Notice deadline: Delay to piling",
      detail: "claim notice under cl. 20.1 — due in 2 days",
      dueAt: "2026-09-03T00:00:00.000Z",
      href: "/projects/prj_a/contracts/ctr_1",
      sourceType: "contract_event",
      sourceId: "cev_1",
      score: 140,
      money: 250000,
      currency: "GBP",
    },
    {
      id: "att_2",
      projectId: "prj_b",
      projectName: "Depot",
      kind: "overdue_rfi",
      severity: "medium",
      title: "RFI #4 overdue: Rebar detail",
      detail: "5 days overdue",
      dueAt: "2026-08-27T00:00:00.000Z",
      href: "/projects/prj_b/rfis/rfi_4",
      sourceType: "rfi",
      sourceId: "rfi_4",
      score: 60,
    },
  ],
  attentionBySeverity: { critical: 1, high: 0, medium: 1, low: 0, info: 0 },
  openAttention: 2,
  scores: [
    {
      projectId: "prj_a",
      level: "off_track",
      score: 42,
      dimensions: [
        { key: "contract", score: 30, level: "off_track", basis: "1 time-barred event", inputs: {} },
        { key: "field", score: 90, level: "on_track", basis: "fine", inputs: {} },
      ],
      computedAt: "2026-09-01T05:00:00.000Z",
      trend: [],
      ...({ projectName: "Bridge", stage: "course_of_construction" } as object),
    },
    {
      projectId: "prj_b",
      level: "on_track",
      score: 88,
      dimensions: [],
      computedAt: "2026-09-01T05:00:00.000Z",
      trend: [],
      ...({ projectName: "Depot", stage: "course_of_construction" } as object),
    },
  ],
  briefing: { text: null, runId: null, reason: "never_generated" },
  changes: {
    since: "2026-08-31T06:00:00.000Z",
    levelChanges: [{ projectId: "prj_a", projectName: "Bridge", from: "watch", to: "off_track", scoreFrom: 55, scoreTo: 42 }],
    newAttention: 1,
    resolvedAttention: 0,
    openAttentionFrom: 1,
    openAttentionTo: 2,
  },
  computedOnRead: false,
});

describe("buildBriefingContext", () => {
  it("numbers attention, health and changes as evidence and mirrors them as inputRefs", () => {
    const ctx = buildBriefingContext(pulse(), { projectId: null, companyName: "Acme", today: "2026-09-01" });
    expect(ctx.evidence.map((e) => e.ref)).toEqual([1, 2, 3, 4, 5]);
    expect(ctx.evidence[0]?.sourceType).toBe("attention_item");
    expect(ctx.evidence[0]?.label).toContain("[critical] Bridge");
    expect(ctx.evidence[2]?.sourceType).toBe("project_health");
    expect(ctx.evidence[2]?.label).toContain("weak: contract 30");
    expect(ctx.evidence[4]?.sourceType).toBe("pulse_changes");
    expect(ctx.evidence[4]?.label).toContain("Bridge: watch → off_track");
    expect(ctx.inputRefs).toEqual([
      { type: "attention_item", id: "att_1" },
      { type: "attention_item", id: "att_2" },
      { type: "project_health", id: "prj_a" },
      { type: "project_health", id: "prj_b" },
    ]);
    expect(ctx.user).toContain("[1] ");
    expect(ctx.system).toContain("Today is 2026-09-01");
    expect(ctx.system).toContain("Never invent figures");
    expect(ctx.system).toContain("Acme");
  });

  it("scopes to one project and says so", () => {
    const ctx = buildBriefingContext(pulse(), { projectId: "prj_b", projectName: "Depot", today: "2026-09-01" });
    expect(ctx.evidence.filter((e) => e.projectId === "prj_a")).toHaveLength(0);
    expect(ctx.evidence.map((e) => e.sourceType)).toEqual(["attention_item", "project_health", "pulse_changes"]);
    expect(ctx.system).toContain('the project "Depot" only');
  });

  it("is honest about an empty evidence list", () => {
    const p = pulse();
    p.attention = [];
    p.scores = [];
    p.changes.since = null;
    const ctx = buildBriefingContext(p, { projectId: null, today: "2026-09-01" });
    expect(ctx.evidence).toHaveLength(0);
    expect(ctx.user).toContain("(none");
  });

  it("is deterministic", () => {
    const a = buildBriefingContext(pulse(), { projectId: null, today: "2026-09-01" });
    const b = buildBriefingContext(pulse(), { projectId: null, today: "2026-09-01" });
    expect(a).toEqual(b);
  });
});

describe("briefingOutputSchema", () => {
  it("accepts a well-formed model output with defaults", () => {
    const parsed = briefingOutputSchema.parse({
      headline: "Bridge needs a notice today",
      summary: "One time bar closes in two days.",
      highlights: [{ text: "Serve the cl. 20.1 notice [1]", citations: [1] }],
      proposedActions: [{ title: "Draft the notice", rationale: "Time bar in 2 days [1]", citations: [1], attentionRef: 1 }],
    });
    expect(parsed.proposedActions[0]?.kind).toBe("other");
    expect(parsed.citations).toEqual([]);
  });

  it("rejects an output without a headline or with an unknown action kind", () => {
    expect(() => briefingOutputSchema.parse({ summary: "x" })).toThrow();
    expect(() =>
      briefingOutputSchema.parse({
        headline: "h",
        summary: "s",
        proposedActions: [{ title: "t", rationale: "r", kind: "delete_everything", citations: [1] }],
      }),
    ).toThrow();
  });
});

describe("reconcileCitations", () => {
  const evidence = buildBriefingContext(pulse(), { projectId: null, today: "2026-09-01" }).evidence;

  it("drops uncited or wrongly-cited claims and resolves attention ids", () => {
    const output: BriefingOutput = {
      headline: "h",
      summary: "s",
      highlights: [
        { text: "cited", citations: [1, 3] },
        { text: "uncited", citations: [] },
        { text: "hallucinated ref", citations: [99] },
        { text: "mixed", citations: [2, 42] },
      ],
      proposedActions: [
        { title: "Serve notice", rationale: "r", kind: "escalate", attentionRef: 1, citations: [1] },
        { title: "Chase RFI", rationale: "r", kind: "notify", attentionRef: 3, citations: [3] }, // ref 3 is health, not an item
        { title: "Bogus", rationale: "r", kind: "other", attentionRef: null, citations: [77] },
      ],
      citations: [1, 2, 3, 99],
    };
    const r = reconcileCitations(output, evidence);
    expect(r.highlights.map((h) => h.text)).toEqual(["cited", "mixed"]);
    expect(r.highlights[1]?.citations).toEqual([2]);
    expect(r.droppedHighlights).toBe(2);
    expect(r.proposedActions).toHaveLength(2);
    expect(r.proposedActions[0]?.attentionId).toBe("att_1");
    expect(r.proposedActions[1]?.attentionId).toBeNull();
    expect(r.droppedActions).toBe(1);
    expect(r.citations.map((c) => c.ref)).toEqual([1, 2, 3]);
  });
});
