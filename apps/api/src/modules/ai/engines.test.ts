/**
 * Unit tests for the pure engines behind the agent fleet: citation
 * validation, evidence scoring, confidence damping, the budget and
 * auto-apply ceilings, the day-window arithmetic, candidate interleaving,
 * schedule due-ness and the three governance reports.
 *
 * These need no database and no API key, which is the point: the guarantees
 * the platform makes about AI output are arithmetic, not prompts.
 */
import { describe, expect, it } from "vitest";
import {
  escapeLike,
  estimateCostMicros,
  extractJson,
  promptVersion,
  renderSnippets,
  snippetAround,
  validateCitations,
} from "./service.js";
import { computeEvidenceScore, effectiveConfidence } from "./evidence.js";
import {
  autoApplyVerdict,
  budgetVerdict,
  GLOBAL_POLICY_DEFAULT,
  policyDefaults,
  registerPolicyDefaults,
  usageDate,
  ZERO_USAGE,
  type EffectivePolicy,
} from "./policy.js";
import { dayRange, interleave, targetTool, tzOffsetMinutes } from "./index.js";
import { isDue, nextRunAt, staleCutoff } from "./schedules.js";
import {
  ADVERSARIAL_CASES,
  biasSubject,
  isAdverse,
  runAdversarialSuite,
  summariseBias,
  summariseValidation,
} from "./reports.js";
import { AGENT_INVENTORY, getAgentDefinition, KNOWN_AGENT_KINDS } from "./registry.js";

const policy = (over: Partial<EffectivePolicy> = {}): EffectivePolicy => ({
  ...GLOBAL_POLICY_DEFAULT,
  agentKind: "test_agent",
  policyId: null,
  source: "default",
  updatedAt: null,
  updatedBy: null,
  notes: null,
  ...over,
});

/* ------------------------------------------------------------------ */

describe("prompt/output helpers", () => {
  it("extractJson parses a bare object, fences and prose", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"answer":"yes"}\n```')).toEqual({ answer: "yes" });
    expect(extractJson('Here you go:\n{"ok":true}\nHope that helps')).toEqual({ ok: true });
    expect(() => extractJson("no json at all")).toThrow();
  });

  it("snippetAround centres on the match, escapeLike escapes metacharacters", () => {
    const text = `${"x".repeat(400)} THE NEEDLE ${"y".repeat(400)}`;
    expect(snippetAround(text, "needle", 100).toLowerCase()).toContain("needle");
    expect(escapeLike("50%_done\\x")).toBe("50\\%\\_done\\\\x");
  });

  it("renderSnippets prints the provenance header the citations must match", () => {
    const out = renderSnippets([
      { type: "rfi", id: "rfi_1", label: "RFI #1", snippet: "window head" },
    ]);
    expect(out).toContain("[1] type=rfi id=rfi_1");
  });

  it("promptVersion is stable and changes with the prompt", () => {
    expect(promptVersion("abc")).toBe(promptVersion("abc"));
    expect(promptVersion("abc")).not.toBe(promptVersion("abd"));
    expect(promptVersion("abc")).toHaveLength(12);
  });

  it("estimateCostMicros uses the model family rate and states its basis", () => {
    const opus = estimateCostMicros("claude-opus-5", 1000, 100);
    expect(opus.micros).toBe(1000 * 15 + 100 * 75);
    expect(opus.basis).toContain("claude-opus");
    // An unknown model falls back to the most expensive entry rather than 0.
    expect(estimateCostMicros("mystery-model", 1000, 0).micros).toBe(15_000);
  });
});

/* ------------------------------------------------------------------ */

describe("citation validation (#1019)", () => {
  const refs = [
    { type: "rfi", id: "rfi_1" },
    { type: "drawing_sheet", id: "sht_1" },
  ];

  it("keeps a citation that names a supplied record", () => {
    const v = validateCitations([{ type: "rfi", id: "rfi_1" }], refs);
    expect(v.kept).toHaveLength(1);
    expect(v.dropped).toHaveLength(0);
  });

  it("drops a fabricated id", () => {
    const v = validateCitations([{ type: "rfi", id: "rfi_invented" }], refs);
    expect(v.kept).toHaveLength(0);
    expect(v.dropped).toHaveLength(1);
  });

  it("corrects a type/id mix-up rather than throwing away a real reference", () => {
    const v = validateCitations([{ type: "submittal", id: "sht_1" }], refs);
    expect(v.dropped).toHaveLength(0);
    expect(v.kept[0]).toMatchObject({ type: "drawing_sheet", id: "sht_1" });
  });

  it("leaves citations of another shape alone (the briefing agent cites numbers)", () => {
    const v = validateCitations([1, 2, 3], refs);
    expect(v.kept).toEqual([1, 2, 3]);
    expect(v.dropped).toHaveLength(0);
  });

  it("treats a non-array as no citations", () => {
    expect(validateCitations(undefined, refs)).toEqual({ kept: [], dropped: [] });
    expect(validateCitations("rfi_1", refs)).toEqual({ kept: [], dropped: [] });
  });
});

/* ------------------------------------------------------------------ */

describe("evidence sufficiency (#1017/#1018)", () => {
  it("scores zero with nothing supplied and reports why", () => {
    const { score, basis } = computeEvidenceScore({
      inputRefs: [],
      contextChars: 0,
      citationsRequired: true,
    });
    expect(score).toBe(0);
    expect(basis["records"]).toBe(0);
  });

  it("rewards breadth, diversity and density, and saturates", () => {
    const thin = computeEvidenceScore({
      inputRefs: [{ type: "rfi", id: "a" }],
      contextChars: 200,
      citationsRequired: true,
    }).score;
    const rich = computeEvidenceScore({
      inputRefs: [
        { type: "rfi", id: "a" },
        { type: "drawing_sheet", id: "b" },
        { type: "submittal", id: "c" },
        { type: "daily_log", id: "d" },
        { type: "rfi", id: "e" },
        { type: "rfi", id: "f" },
        { type: "rfi", id: "g" },
        { type: "rfi", id: "h" },
      ],
      contextChars: 8_000,
      citationsRequired: true,
      contradictions: 2,
    }).score;
    expect(rich).toBeGreaterThan(thin);
    expect(rich).toBeLessThanOrEqual(1);
  });

  it("cannot reach the top on volume of one record type alone", () => {
    const { score } = computeEvidenceScore({
      inputRefs: Array.from({ length: 30 }, (_, i) => ({ type: "rfi", id: `r${i}` })),
      contextChars: 50_000,
      citationsRequired: true,
    });
    expect(score).toBeLessThan(0.85);
  });
});

describe("confidence damping", () => {
  it("never raises the model's number", () => {
    expect(effectiveConfidence(0.3, 1, 0)).toBe(0.3);
  });

  it("caps at 0.5 when a citation was fabricated", () => {
    expect(effectiveConfidence(0.99, 1, 1)).toBe(0.5);
  });

  it("caps by the evidence score", () => {
    // evidence 0 → ceiling 0.4
    expect(effectiveConfidence(0.99, 0, 0)).toBe(0.4);
  });

  it("returns null when the model stated no confidence", () => {
    expect(effectiveConfidence(undefined, 1, 0)).toBeNull();
    expect(effectiveConfidence(Number.NaN, 1, 0)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe("budget ceiling (#1022)", () => {
  it("allows a run inside the ceiling", () => {
    expect(budgetVerdict(policy({ maxRunsPerDay: 10 }), ZERO_USAGE).allowed).toBe(true);
  });

  it("refuses at the run ceiling and says which counter tripped", () => {
    const v = budgetVerdict(policy({ maxRunsPerDay: 3 }), { ...ZERO_USAGE, runs: 3 });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("run budget");
  });

  it("refuses at the input and output token ceilings", () => {
    expect(
      budgetVerdict(policy({ maxInputTokensPerDay: 100 }), { ...ZERO_USAGE, inputTokens: 100 })
        .allowed,
    ).toBe(false);
    expect(
      budgetVerdict(policy({ maxOutputTokensPerDay: 50 }), { ...ZERO_USAGE, outputTokens: 60 })
        .allowed,
    ).toBe(false);
  });

  it("treats a null ceiling as unlimited", () => {
    const v = budgetVerdict(
      policy({ maxRunsPerDay: null, maxInputTokensPerDay: null, maxOutputTokensPerDay: null }),
      { ...ZERO_USAGE, runs: 10_000, inputTokens: 10_000_000 },
    );
    expect(v.allowed).toBe(true);
  });

  it("usageDate is the UTC calendar day", () => {
    expect(usageDate(new Date("2026-08-20T23:59:00Z"))).toBe("2026-08-20");
  });
});

describe("auto-apply ceiling (#1022)", () => {
  const low = ["drawing_sheet"];

  it("propose_only never auto-applies", () => {
    expect(autoApplyVerdict(policy(), "drawing_sheet", 1, low).auto).toBe(false);
  });

  it("never auto-applies a high-consequence target type, whatever the policy", () => {
    expect(
      autoApplyVerdict(policy({ authorisation: "auto_apply" }), "rfi_response", 1, low).auto,
    ).toBe(false);
    expect(
      autoApplyVerdict(policy({ authorisation: "auto_apply" }), "daily_log", 1, low).auto,
    ).toBe(false);
  });

  it("applies below-threshold policy only at or above the threshold", () => {
    const p = policy({
      authorisation: "auto_apply_below_threshold",
      autoApplyMinConfidence: 0.9,
    });
    expect(autoApplyVerdict(p, "drawing_sheet", 0.89, low).auto).toBe(false);
    expect(autoApplyVerdict(p, "drawing_sheet", 0.9, low).auto).toBe(true);
    expect(autoApplyVerdict(p, "drawing_sheet", null, low).auto).toBe(false);
  });

  it("respects an explicit allowedTargetTypes list", () => {
    const p = policy({ authorisation: "auto_apply", allowedTargetTypes: ["photo_tag"] });
    expect(autoApplyVerdict(p, "drawing_sheet", 1, low).auto).toBe(false);
  });

  it("refuses when no threshold is configured", () => {
    const p = policy({ authorisation: "auto_apply_below_threshold", autoApplyMinConfidence: null });
    expect(autoApplyVerdict(p, "drawing_sheet", 1, low).auto).toBe(false);
  });
});

describe("policy defaults", () => {
  it("falls back to the global default for an unknown kind", () => {
    expect(policyDefaults("no_such_agent")).toEqual(GLOBAL_POLICY_DEFAULT);
  });

  it("registry registered a default for every fleet kind", () => {
    for (const entry of AGENT_INVENTORY.filter((a) => a.runnable)) {
      expect(policyDefaults(entry.kind).authorisation).toBe("propose_only");
    }
  });

  it("a later registration wins", () => {
    registerPolicyDefaults("temp_kind_for_test", { maxRunsPerDay: 7 });
    expect(policyDefaults("temp_kind_for_test").maxRunsPerDay).toBe(7);
  });
});

/* ------------------------------------------------------------------ */

describe("project-local day window", () => {
  it("is UTC when no offset is known", () => {
    expect(dayRange("2026-08-20")).toEqual({
      start: "2026-08-20T00:00:00.000Z",
      end: "2026-08-20T23:59:59.999Z",
    });
  });

  it("shifts the window for an east-of-UTC project", () => {
    // UTC+10: local midnight is 14:00 the previous UTC day.
    expect(dayRange("2026-08-20", 600).start).toBe("2026-08-19T14:00:00.000Z");
    expect(dayRange("2026-08-20", 600).end).toBe("2026-08-20T13:59:59.999Z");
  });

  it("shifts the window for a west-of-UTC project", () => {
    expect(dayRange("2026-08-20", -420).start).toBe("2026-08-20T07:00:00.000Z");
  });

  it("tzOffsetMinutes reads a real zone and refuses an unknown one", () => {
    expect(tzOffsetMinutes("UTC", new Date("2026-08-20T12:00:00Z"))).toBe(0);
    expect(tzOffsetMinutes("Australia/Brisbane", new Date("2026-08-20T12:00:00Z"))).toBe(600);
    expect(tzOffsetMinutes("Not/AZone", new Date())).toBeNull();
  });
});

describe("search candidate interleaving", () => {
  it("never starves the last group when an earlier one saturates", () => {
    const drawings = Array.from({ length: 15 }, (_, i) => `d${i}`);
    const files = Array.from({ length: 10 }, (_, i) => `f${i}`);
    const rfis = Array.from({ length: 10 }, (_, i) => `r${i}`);
    const submittals = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const out = interleave([drawings, rfis, submittals, files], 40);
    expect(out).toHaveLength(40);
    expect(out).toContain("s0");
    expect(out).toContain("s5");
  });

  it("keeps everything when under the limit", () => {
    expect(interleave([["a"], ["b"]], 40)).toEqual(["a", "b"]);
    expect(interleave([], 40)).toEqual([]);
  });
});

describe("reviewer tool mapping", () => {
  it("maps every operational target type to the tool that owns it", () => {
    expect(targetTool("rfi_response")).toBe("rfis");
    expect(targetTool("daily_log")).toBe("daily_logs");
    expect(targetTool("drawing_sheet")).toBe("drawings");
    expect(targetTool("submittal_review")).toBe("submittals");
    expect(targetTool("signal_explanation")).toBe("assurance");
    expect(targetTool("cost_forecast")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe("schedules", () => {
  it("nextRunAt clamps to a sane interval", () => {
    const from = new Date("2026-08-20T00:00:00Z");
    expect(nextRunAt(from, 60)).toBe("2026-08-20T01:00:00.000Z");
    // below the floor
    expect(nextRunAt(from, 1)).toBe("2026-08-20T00:15:00.000Z");
  });

  it("isDue respects enabled and the next run time", () => {
    const now = new Date("2026-08-20T12:00:00Z");
    expect(isDue({ enabled: 0, nextRunAt: null }, now)).toBe(false);
    expect(isDue({ enabled: 1, nextRunAt: null }, now)).toBe(true);
    expect(isDue({ enabled: 1, nextRunAt: "2026-08-20T11:00:00Z" }, now)).toBe(true);
    expect(isDue({ enabled: 1, nextRunAt: "2026-08-20T13:00:00Z" }, now)).toBe(false);
  });

  it("staleCutoff is the configured number of days back", () => {
    const cutoff = staleCutoff(new Date("2026-08-20T00:00:00Z"), 14);
    expect(cutoff).toBe("2026-08-06T00:00:00.000Z");
  });
});

/* ------------------------------------------------------------------ */

describe("adversarial harness (#1024)", () => {
  it("every guard holds", () => {
    const report = runAdversarialSuite(new Date("2026-08-20T00:00:00Z"));
    const failures = report.cases.filter((c) => !c.held);
    expect(failures.map((f) => `${f.id}: ${f.observed}`)).toEqual([]);
    expect(report.passRate).toBe(1);
    expect(report.total).toBe(ADVERSARIAL_CASES.length);
  });

  it("groups results by family so a whole guard family cannot silently rot", () => {
    const report = runAdversarialSuite();
    expect(Object.keys(report.byFamily).sort()).toEqual([
      "authorisation",
      "calibration",
      "cost",
      "grounding",
    ]);
  });
});

describe("bias assessment (#1025)", () => {
  it("names no rate below the minimum sample", () => {
    const report = summariseBias(
      [
        {
          reviewId: "a",
          agentKind: "bid_levelling_analyst",
          targetType: "bid_levelling",
          subjectId: "ven_1",
          adverse: true,
          status: "pending",
          confidence: 0.8,
        },
      ],
      new Date(),
      "2026-08-01T00:00:00.000Z",
    );
    expect(report.overallAdverseRate).toBeNull();
    expect(report.groups[0]!.adverseRate).toBeNull();
    expect(report.groups[0]!.reason).toContain("at least 5");
    expect(report.verdict).toContain("will not state a rate");
  });

  it("flags a subject whose adverse rate is 1.5x the overall rate", () => {
    const obs = [
      ...Array.from({ length: 6 }, (_, i) => ({
        reviewId: `a${i}`,
        agentKind: "risk_monitor",
        targetType: "risk_finding",
        subjectId: "ven_hot",
        adverse: true,
        status: "pending",
        confidence: 0.7,
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        reviewId: `b${i}`,
        agentKind: "risk_monitor",
        targetType: "risk_finding",
        subjectId: "ven_cool",
        adverse: false,
        status: "pending",
        confidence: 0.7,
      })),
    ];
    const report = summariseBias(obs, new Date(), "2026-08-01T00:00:00.000Z");
    expect(report.overallAdverseRate).toBe(0.5);
    expect(report.disparity).toEqual({ subjectId: "ven_hot", ratio: 2 });
    expect(report.verdict).toContain("ven_hot");
  });

  it("counts an output whose subject cannot be identified as unattributed", () => {
    const report = summariseBias(
      [
        {
          reviewId: "a",
          agentKind: "risk_monitor",
          targetType: "risk_finding",
          subjectId: null,
          adverse: true,
          status: "pending",
          confidence: null,
        },
      ],
      new Date(),
      "2026-08-01T00:00:00.000Z",
    );
    expect(report.unattributed).toBe(1);
    expect(report.subjectsIdentified).toBe(0);
  });

  it("extracts the subject only from fields that actually name one", () => {
    expect(biasSubject({ vendorId: "ven_1" })).toBe("ven_1");
    expect(biasSubject({ affectedVendors: ["ven_2"] })).toBe("ven_2");
    expect(biasSubject({ outliers: [{ submissionId: "sub_3" }] })).toBe("sub_3");
    expect(biasSubject({ title: "something" })).toBeNull();
    expect(biasSubject(null)).toBeNull();
  });

  it("recognises the adverse outputs", () => {
    expect(isAdverse("risk_finding", { severity: "critical" })).toBe(true);
    expect(isAdverse("spec_compliance", { compliant: "no" })).toBe(true);
    expect(isAdverse("spec_compliance", { compliant: "yes" })).toBe(false);
    expect(isAdverse("incident_classification", { reportable: true })).toBe(true);
    expect(isAdverse("submittal_review", { recommendation: "rejected" })).toBe(true);
    expect(isAdverse("submittal_review", { recommendation: "approved" })).toBe(false);
  });
});

describe("model validation (#1027)", () => {
  const run = (over: Partial<Parameters<typeof summariseValidation>[0][number]> = {}) => ({
    agentKind: "risk_monitor",
    model: "claude-opus-5",
    status: "succeeded",
    latencyMs: 100,
    inputTokens: 10,
    outputTokens: 5,
    promptVersion: "abc123",
    evidenceScore: 0.6,
    droppedCitations: 0,
    citationCount: 2,
    ...over,
  });

  it("withholds every rate below the minimum sample and says why", () => {
    const report = summariseValidation([run()], [], new Date(), "2026-08-01T00:00:00.000Z");
    const agent = report.agents[0]!;
    expect(agent.successRate).toBeNull();
    expect(agent.reasons[0]).toContain("at least 5");
  });

  it("computes success, fabrication and human-agreement rates over enough data", () => {
    const runs = [
      ...Array.from({ length: 8 }, () => run()),
      run({ status: "failed" }),
      run({ droppedCitations: 2 }),
    ];
    const reviews = [
      ...Array.from({ length: 4 }, () => ({ agentKind: "risk_monitor", status: "approved" })),
      ...Array.from({ length: 2 }, () => ({ agentKind: "risk_monitor", status: "rejected" })),
      { agentKind: "risk_monitor", status: "superseded" },
    ];
    const report = summariseValidation(runs, reviews, new Date(), "2026-08-01T00:00:00.000Z");
    const agent = report.agents[0]!;
    expect(agent.runs).toBe(10);
    expect(agent.successRate).toBe(0.9);
    expect(agent.fabricationRate).toBe(0.1);
    expect(agent.humanAgreementRate).toBeCloseTo(0.67, 2);
    expect(agent.superseded).toBe(1);
    expect(agent.promptVersions).toEqual(["abc123"]);
    expect(report.totals.runs).toBe(10);
  });
});

/* ------------------------------------------------------------------ */

describe("agent registry", () => {
  it("every fleet agent is runnable, has a prompt version and required citations", () => {
    const fleet = AGENT_INVENTORY.filter((a) => a.runnable);
    expect(fleet.length).toBeGreaterThanOrEqual(18);
    for (const a of fleet) {
      expect(a.promptVersion, a.kind).toBeTruthy();
      expect(getAgentDefinition(a.kind), a.kind).not.toBeNull();
      expect(a.targetTypes.length, a.kind).toBeGreaterThan(0);
    }
  });

  it("lists the legacy agents with the route that serves them", () => {
    const legacy = AGENT_INVENTORY.filter((a) => !a.runnable);
    expect(legacy.map((a) => a.kind).sort()).toEqual([
      "assistant",
      "daily_log_draft",
      "document_search",
      "photo_intelligence",
      "rfi_evaluation",
      "sheet_naming",
      "submittal_review",
    ]);
    for (const a of legacy) expect(a.route).toMatch(/^POST /);
  });

  it("knows the frozen enum kinds too", () => {
    expect(KNOWN_AGENT_KINDS).toContain("contract_risk");
    expect(KNOWN_AGENT_KINDS).toContain("document_search");
    expect(KNOWN_AGENT_KINDS).toContain("obligation_monitor");
  });

  it("no two agents share a kind", () => {
    const kinds = AGENT_INVENTORY.map((a) => a.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});
