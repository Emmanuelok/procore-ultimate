/**
 * Grievance triage — engine unit tests and route integration tests.
 *
 * The engine tests are pure and fast (no database). The route tests cover the
 * three things that actually matter about an assistant on a community
 * complaint: it degrades to a useful deterministic panel when the model is
 * off, it never applies its own proposal, and the officer's decision moves
 * the SLA clocks from the date the community raised the grievance rather than
 * from the date somebody got round to re-classifying it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { grievanceTriages, grievances, ledgerEntries, obligations, projects } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";
import { setAiClientFactory, type AiClientLike } from "../ai/service.js";
import {
  agreementOf,
  calibrationOf,
  precedentSuggestion,
  similarGrievances,
  slaCitations,
  tokenize,
  type TriageCorpusItem,
} from "./triage.js";

/* ================================================================== */
/* Engine (pure)                                                       */
/* ================================================================== */

const corpusItem = (
  n: number,
  description: string,
  category: string,
  severity: string,
  extra: Partial<TriageCorpusItem> = {},
): TriageCorpusItem => ({
  id: `grv-${n}`,
  number: n,
  description,
  category,
  severity,
  status: "closed_verified",
  resolution: null,
  resolutionDays: null,
  complainantSatisfied: null,
  ...extra,
});

describe("triage engine — tokenizer", () => {
  it("drops stop words, punctuation and single characters", () => {
    expect(tokenize("The dust from the haul road is on my crops!")).toEqual([
      "dust",
      "haul",
      "road",
      "crops",
    ]);
  });

  it("keeps non-ASCII words — the corpus is frequently translated", () => {
    expect(tokenize("poussière sur la récolte")).toContain("poussière");
  });

  it("is empty for a description with nothing to match on", () => {
    expect(tokenize("it is a to the")).toEqual([]);
  });
});

describe("triage engine — precedent search", () => {
  const corpus: TriageCorpusItem[] = [
    corpusItem(
      1,
      "Dust from haul road trucks is settling on maize crops next to the alignment",
      "dust",
      "medium",
      { resolutionDays: 12, complainantSatisfied: true },
    ),
    corpusItem(
      2,
      "Heavy dust from the haul road covering the maize crop and the school roof",
      "dust",
      "medium",
    ),
    corpusItem(
      3,
      "Compensation for the demolished shop has still not been paid after four months",
      "compensation",
      "high",
    ),
    corpusItem(4, "Request for a copy of the resettlement action plan document", "other", "low"),
  ];

  it("ranks the closest precedent first and reports the shared terms", () => {
    const out = similarGrievances(
      "Dust from the haul road is covering our maize crops",
      corpus,
      3,
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.category).toBe("dust");
    expect(out[0]!.score).toBeGreaterThan(0);
    expect(out[0]!.sharedTerms).toEqual(expect.arrayContaining(["dust", "haul"]));
    // scores are monotonically non-increasing
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i]!.score).toBeLessThanOrEqual(out[i - 1]!.score);
    }
  });

  it("drops precedents that share nothing rather than padding to the limit", () => {
    const out = similarGrievances("Security guard assaulted a herder at the north gate", corpus, 3);
    for (const m of out) expect(m.score).toBeGreaterThan(0);
    expect(out.every((m) => m.sharedTerms.length > 0)).toBe(true);
  });

  it("returns nothing for an empty corpus or an all-stop-word description", () => {
    expect(similarGrievances("Dust on the crops", [], 3)).toEqual([]);
    expect(similarGrievances("it is on the", corpus, 3)).toEqual([]);
  });

  it("is deterministic — the same inputs give the same order", () => {
    const a = similarGrievances("dust haul road maize", corpus, 4);
    const b = similarGrievances("dust haul road maize", [...corpus].reverse(), 4);
    expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id));
  });

  it("honours the limit", () => {
    expect(similarGrievances("dust haul road maize compensation shop", corpus, 2).length).toBe(2);
  });
});

describe("triage engine — precedent suggestion", () => {
  it("votes by similarity weight and says what it voted over", () => {
    const matches = similarGrievances(
      "Dust from the haul road is covering our maize crops",
      [
        corpusItem(1, "Dust from haul road on maize crops", "dust", "medium"),
        corpusItem(2, "Dust from the haul road on the maize", "dust", "medium"),
        corpusItem(3, "Compensation for the shop not paid", "compensation", "high"),
      ],
      3,
    );
    const s = precedentSuggestion(matches);
    expect(s.category).toBe("dust");
    expect(s.severity).toBe("medium");
    expect(s.confidence).toBeGreaterThan(0.5);
    expect(s.basis).toContain("Similarity-weighted vote");
  });

  it("reports honestly that there is no precedent rather than guessing", () => {
    const s = precedentSuggestion([]);
    expect(s.category).toBeNull();
    expect(s.severity).toBeNull();
    expect(s.confidence).toBe(0);
    expect(s.basis).toMatch(/no previously recorded grievance/i);
  });
});

describe("triage engine — SLA citations", () => {
  it("quotes the published standard for every severity", () => {
    const rules = slaCitations();
    expect(rules.map((r) => r.severity).sort()).toEqual(["critical", "high", "low", "medium"]);
    const critical = rules.find((r) => r.severity === "critical")!;
    expect(critical.acknowledgeDays).toBe(1);
    expect(critical.resolveDays).toBe(7);
    expect(critical.rule).toContain("acknowledge within 1 calendar day");
  });
});

describe("triage engine — calibration", () => {
  const proposal = (over: Partial<Parameters<typeof agreementOf>[0]> = {}) => ({
    proposedCategory: "dust",
    proposedSeverity: "medium",
    proposedAssigneeId: null,
    decidedCategory: null,
    decidedSeverity: null,
    decidedAssigneeId: null,
    decidedAt: null,
    ...over,
  });

  it("reports nulls, not zeroes, while nothing has been decided", () => {
    const c = calibrationOf([proposal(), proposal()]);
    expect(c.proposals).toBe(2);
    expect(c.decided).toBe(0);
    expect(c.categoryAgreementPercent).toBeNull();
    expect(c.severityAgreementPercent).toBeNull();
    expect(c.reasons.join(" ")).toMatch(/not measurable/i);
  });

  it("measures agreement once officers have decided", () => {
    const c = calibrationOf([
      proposal({
        decidedCategory: "dust",
        decidedSeverity: "medium",
        decidedAt: "2026-01-01T00:00:00Z",
      }),
      proposal({
        decidedCategory: "noise",
        decidedSeverity: "high",
        decidedAt: "2026-01-02T00:00:00Z",
      }),
    ]);
    expect(c.decided).toBe(2);
    expect(c.categoryAgreementPercent).toBe(50);
    expect(c.severityAgreementPercent).toBe(50);
    // the officer went HARSHER than the proposal: that is the dangerous miss
    expect(c.severityUnderCalled).toBe(1);
    expect(c.severityOverCalled).toBe(0);
  });

  it("counts a softened severity separately from an under-call", () => {
    const c = calibrationOf([
      proposal({
        proposedSeverity: "critical",
        decidedCategory: "dust",
        decidedSeverity: "low",
        decidedAt: "2026-01-03T00:00:00Z",
      }),
    ]);
    expect(c.severityOverCalled).toBe(1);
    expect(c.severityUnderCalled).toBe(0);
  });

  it("does not count an assignee neither proposed nor decided as a disagreement", () => {
    const a = agreementOf(
      proposal({
        decidedCategory: "dust",
        decidedSeverity: "medium",
        decidedAt: "2026-01-01T00:00:00Z",
      }),
    );
    expect(a.assignee).toBeNull();
    expect(a.category).toBe(true);
  });

  it("is empty-safe", () => {
    const c = calibrationOf([]);
    expect(c.proposals).toBe(0);
    expect(c.categoryAgreementPercent).toBeNull();
    expect(c.reasons.join(" ")).toMatch(/no triage proposal/i);
  });
});

/* ================================================================== */
/* Routes                                                              */
/* ================================================================== */

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let stranger: TestActor;
let pid: string;

/** the model's next answer; swapped per test */
let modelResponse: unknown = {};
let modelThrows: string | null = null;

const fakeClient = {
  beta: {
    messages: {
      async create(params: { model: string }) {
        if (modelThrows) throw new Error(modelThrows);
        return {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: params.model,
          content: [{ type: "text", text: JSON.stringify(modelResponse), citations: null }],
          stop_reason: "end_turn",
          stop_sequence: null,
          stop_details: null,
          usage: {
            input_tokens: 120,
            output_tokens: 60,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            server_tool_use: null,
            service_tier: null,
          },
        } as unknown as Anthropic.Beta.BetaMessage;
      },
    },
  },
} as unknown as AiClientLike;

async function makeGrievance(
  projectId: string,
  actor: TestActor,
  body: Record<string, unknown>,
): Promise<{ id: string; number: number }> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/grievances`,
    headers: actor.headers,
    payload: {
      channel: "in_person",
      category: "other",
      severity: "low",
      receivedAt: todayISO(),
      ...body,
    },
  });
  if (res.statusCode !== 201) throw new Error(`intake failed: ${res.statusCode} ${res.body}`);
  const json = res.json() as { id: string; number: number };
  return json;
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  stranger = await registerActor(app);
  pid = newId("prj");
  await app.db.insert(projects).values({
    id: pid,
    companyId: owner.companyId,
    name: "Northern corridor upgrade",
  });
  /* explicit: the first assertions are about the AI-disabled path */
  delete app.appConfig.ANTHROPIC_API_KEY;
  setAiClientFactory(null);
}, 120_000);

afterAll(async () => {
  setAiClientFactory(null);
  delete app.appConfig.ANTHROPIC_API_KEY;
  await built.close();
});

describe("grievance triage routes", () => {
  let subjectId: string;
  let subjectNumber: number;

  it("builds a precedent corpus and ranks it with no model configured", async () => {
    await makeGrievance(pid, owner, {
      category: "dust",
      severity: "medium",
      description: "Dust from the haul road trucks is settling on our maize crops",
    });
    await makeGrievance(pid, owner, {
      category: "dust",
      severity: "medium",
      description: "Haul road dust covering the maize and the school roof every afternoon",
    });
    await makeGrievance(pid, owner, {
      category: "compensation",
      severity: "high",
      description: "Compensation for the demolished shop has not been paid after four months",
    });
    const subject = await makeGrievance(pid, owner, {
      category: "other",
      severity: "low",
      description: "Dust from the haul road is covering the maize crops by our compound",
    });
    subjectId = subject.id;
    subjectNumber = subject.number;

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/grievances/${subjectId}/triage`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      precedents: Array<{ id: string; score: number; category: string; excerpt: string }>;
      suggestion: { category: string | null; confidence: number; basis: string };
      slaRules: Array<{ severity: string; rule: string }>;
      corpusSize: number;
      aiAvailable: boolean;
      current: { category: string; severity: string };
    };
    expect(body.aiAvailable).toBe(false);
    expect(body.corpusSize).toBe(3);
    expect(body.precedents.length).toBeGreaterThan(0);
    // the subject itself is never its own precedent
    expect(body.precedents.some((p) => p.id === subjectId)).toBe(false);
    expect(body.suggestion.category).toBe("dust");
    expect(body.suggestion.basis).toContain("Similarity-weighted vote");
    expect(body.slaRules).toHaveLength(4);
    expect(body.current.category).toBe("other");
  });

  it("returns 503 AiDisabled for the model proposal while the panel keeps working", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${subjectId}/triage`,
      headers: owner.headers,
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    const panel = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/grievances/${subjectId}/triage`,
      headers: owner.headers,
    });
    expect(panel.statusCode).toBe(200);
    expect((panel.json() as { precedents: unknown[] }).precedents.length).toBeGreaterThan(0);
  });

  it("reports calibration as unmeasured rather than zero before anything is proposed", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/grievances/triage/calibration`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      overall: { proposals: number; categoryAgreementPercent: number | null; reasons: string[] };
    };
    expect(body.overall.proposals).toBe(0);
    expect(body.overall.categoryAgreementPercent).toBeNull();
    expect(body.overall.reasons.join(" ")).toMatch(/no triage proposal/i);
  });

  it("records a cited proposal and changes nothing about the grievance", async () => {
    app.appConfig.ANTHROPIC_API_KEY = "test-key-not-a-real-key";
    setAiClientFactory(() => fakeClient);
    modelResponse = {
      category: "dust",
      severity: "medium",
      confidence: 0.82,
      rationale:
        "Three prior grievances on this project with the same haul-road dust wording were " +
        "classified dust/medium and resolved within the 30-day standard.",
      citations: [
        { type: "sla_rule", id: "medium", quote: "Nuisance-level impacts" },
        // a fabricated id, to prove citation validation drops it
        { type: "grievance", id: "grv-does-not-exist", quote: "invented" },
      ],
    };
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${subjectId}/triage`,
      headers: owner.headers,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      runId: string;
      proposedCategory: string;
      proposedSeverity: string;
      confidence: number;
      citations: unknown[];
      droppedCitations: number;
      applied: boolean;
      precedents: unknown[];
    };
    expect(body.proposedCategory).toBe("dust");
    expect(body.applied).toBe(false);
    expect(body.confidence).toBeCloseTo(0.82, 5);
    // the invented citation did not survive
    expect(body.droppedCitations).toBeGreaterThanOrEqual(1);
    expect(body.precedents.length).toBeGreaterThan(0);

    const [g] = await app.db.select().from(grievances).where(eq(grievances.id, subjectId));
    expect(g!.category).toBe("other");
    expect(g!.severity).toBe("low");

    const rows = await app.db
      .select()
      .from(grievanceTriages)
      .where(eq(grievanceTriages.grievanceId, subjectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.method).toBe("agent");
    expect(rows[0]!.decidedAt).toBeNull();
  });

  it("moves the SLA clocks from the date of receipt when the officer decides", async () => {
    const [before] = await app.db.select().from(grievances).where(eq(grievances.id, subjectId));
    const receivedAt = before!.receivedAt;
    expect(before!.resolveDueAt).toBe(addDaysISO(receivedAt, 45)); // low

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${subjectId}/triage/decide`,
      headers: owner.headers,
      payload: {
        category: "dust",
        severity: "high",
        note: "Crops affected, not just nuisance",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      category: string;
      severity: string;
      resolveDueAt: string;
      acknowledgeDueAt: string;
      deadlinesRecomputedFrom: string;
    };
    expect(body.category).toBe("dust");
    expect(body.severity).toBe("high");
    // high = 2-day acknowledgement / 14-day resolution, FROM RECEIPT
    expect(body.acknowledgeDueAt).toBe(addDaysISO(receivedAt, 2));
    expect(body.resolveDueAt).toBe(addDaysISO(receivedAt, 14));
    expect(body.deadlinesRecomputedFrom).toBe(receivedAt);

    const [g] = await app.db.select().from(grievances).where(eq(grievances.id, subjectId));
    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, g!.obligationId!));
    expect(obl!.deadline.slice(0, 10)).toBe(addDaysISO(receivedAt, 14));
  });

  it("records the officer's decision against the proposal and ledgers before/after", async () => {
    const rows = await app.db
      .select()
      .from(grievanceTriages)
      .where(eq(grievanceTriages.grievanceId, subjectId));
    expect(rows[0]!.decidedAt).not.toBeNull();
    expect(rows[0]!.decidedCategory).toBe("dust");
    expect(rows[0]!.decidedSeverity).toBe("high");
    expect(rows[0]!.decidedBy).toBe(owner.userId);

    const led = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "grievance"),
          eq(ledgerEntries.objectId, subjectId),
          eq(ledgerEntries.action, "state_change"),
        ),
      );
    const triaged = led.find(
      (l) => (l.payload as Record<string, unknown> | null)?.["event"] === "triaged",
    );
    expect(triaged).toBeDefined();
    const payload = triaged!.payload as Record<string, unknown>;
    expect((payload["before"] as Record<string, unknown>)["severity"]).toBe("low");
    expect((payload["after"] as Record<string, unknown>)["severity"]).toBe("high");
    const agreed = payload["proposalAgreed"] as Record<string, boolean>;
    expect(agreed["category"]).toBe(true);
    expect(agreed["severity"]).toBe(false); // proposed medium, decided high
  });

  it("measures calibration once a decision exists, counting the under-call", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/grievances/triage/calibration`,
      headers: owner.headers,
    });
    const body = res.json() as {
      overall: {
        proposals: number;
        decided: number;
        categoryAgreementPercent: number | null;
        severityAgreementPercent: number | null;
        severityUnderCalled: number;
      };
      agent: { proposals: number };
    };
    expect(body.overall.proposals).toBe(1);
    expect(body.overall.decided).toBe(1);
    expect(body.overall.categoryAgreementPercent).toBe(100);
    expect(body.overall.severityAgreementPercent).toBe(0);
    expect(body.overall.severityUnderCalled).toBe(1);
    expect(body.agent.proposals).toBe(1);
  });

  it("naming a handler at triage moves the case exactly as /assign does", async () => {
    const [before] = await app.db.select().from(grievances).where(eq(grievances.id, subjectId));
    expect(before!.status).toBe("received");
    expect(before!.assigneeId).toBeNull();

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${subjectId}/triage/decide`,
      headers: owner.headers,
      payload: { category: "dust", severity: "high", assigneeId: owner.userId },
    });
    expect(res.statusCode).toBe(200);
    const [after] = await app.db.select().from(grievances).where(eq(grievances.id, subjectId));
    expect(after!.assigneeId).toBe(owner.userId);
    expect(after!.status).toBe("investigating");
  });

  it("rejects an assignee who is not a member of the company", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${subjectId}/triage/decide`,
      headers: owner.headers,
      payload: { category: "dust", severity: "medium", assigneeId: stranger.userId },
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.json().message)).toMatch(/not a member/i);
  });

  it("refuses to triage a settled grievance", async () => {
    const g = await makeGrievance(pid, owner, {
      category: "other",
      severity: "low",
      description: "Request for a copy of the resettlement action plan",
    });
    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${g.id}/reject`,
      headers: owner.headers,
      payload: { reason: "Out of scope — handled by the disclosure desk" },
    });
    expect(rejected.statusCode).toBe(200);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${g.id}/triage/decide`,
      headers: owner.headers,
      payload: { category: "other", severity: "low" },
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.json().message)).toMatch(/no longer be re-triaged/i);
  });

  it("validates the proposed classification against the closed value sets", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${subjectId}/triage/decide`,
      headers: owner.headers,
      payload: { category: "not-a-category", severity: "medium" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("keeps another tenant out of every triage route", async () => {
    for (const [method, url] of [
      ["GET", `/api/v1/projects/${pid}/grievances/${subjectId}/triage`],
      ["POST", `/api/v1/projects/${pid}/grievances/${subjectId}/triage`],
      ["POST", `/api/v1/projects/${pid}/grievances/${subjectId}/triage/decide`],
      ["GET", `/api/v1/projects/${pid}/grievances/triage/calibration`],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: stranger.headers,
        ...(method === "POST" ? { payload: { category: "dust", severity: "medium" } } : {}),
      });
      expect([403, 404]).toContain(res.statusCode);
    }
    // and nothing of the other tenant's leaked into their own calibration
    const spid = newId("prj");
    await app.db
      .insert(projects)
      .values({ id: spid, companyId: stranger.companyId, name: "Stranger scheme" });
    const own = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${spid}/grievances/triage/calibration`,
      headers: stranger.headers,
    });
    expect(own.statusCode).toBe(200);
    expect((own.json() as { overall: { proposals: number } }).overall.proposals).toBe(0);
  });

  it("records a failed model call as a failed run and does not write a proposal", async () => {
    const g = await makeGrievance(pid, owner, {
      category: "noise",
      severity: "medium",
      description: "Night-time piling noise from the bridge works keeps the village awake",
    });
    modelThrows = "upstream exploded";
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${g.id}/triage`,
      headers: owner.headers,
      payload: {},
    });
    modelThrows = null;
    expect(res.statusCode).toBe(502);
    const rows = await app.db
      .select()
      .from(grievanceTriages)
      .where(eq(grievanceTriages.grievanceId, g.id));
    expect(rows).toHaveLength(0);
  });
});
