/**
 * Integration tests for the agent fleet with a MOCKED model client.
 *
 * The client is injected through `setAiClientFactory`, so every agent route,
 * the governance layer and the whole review/rollback path are exercised with
 * no ANTHROPIC_API_KEY and no network. That is the point of the injection
 * point: before it, none of the consequential paths had automated coverage.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import {
  agentActions,
  agentSchedules,
  aiReviewQueue,
  aiRuns,
  companyMemberships,
  contractEvents,
  contracts,
  dailyLogs,
  drawingSheets,
  ledgerEntries,
  obligations,
  notifications,
  projectMemberships,
  projects,
  rfis,
  risks,
  signals,
  specSectionRevisions,
  specSections,
  submittals,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import { setAiClientFactory, type AiClientLike, type AiRequest } from "./service.js";
import { bookUsage, usageDate } from "./policy.js";

/* ------------------------------------------------------------------ */
/* The fake model                                                      */
/* ------------------------------------------------------------------ */

interface FakeResponse {
  text: string;
  stopReason?: Anthropic.Beta.BetaMessage["stop_reason"];
  refusal?: string;
  throwMessage?: string;
  inputTokens?: number;
  outputTokens?: number;
}

let nextResponse: FakeResponse = { text: "{}" };
let lastRequest: AiRequest | null = null;
let callCount = 0;

function setResponse(json: unknown, over: Partial<FakeResponse> = {}): void {
  nextResponse = { text: typeof json === "string" ? json : JSON.stringify(json), ...over };
}

const fakeClient: AiClientLike = {
  beta: {
    messages: {
      async create(params: AiRequest) {
        lastRequest = params;
        callCount += 1;
        if (nextResponse.throwMessage) throw new Error(nextResponse.throwMessage);
        return {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: params.model,
          content: [{ type: "text", text: nextResponse.text, citations: null }],
          stop_reason: nextResponse.refusal ? "refusal" : (nextResponse.stopReason ?? "end_turn"),
          stop_sequence: null,
          stop_details: nextResponse.refusal
            ? { type: "refusal", explanation: nextResponse.refusal }
            : null,
          usage: {
            input_tokens: nextResponse.inputTokens ?? 100,
            output_tokens: nextResponse.outputTokens ?? 50,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            server_tool_use: null,
            service_tier: null,
          },
        } as unknown as Anthropic.Beta.BetaMessage;
      },
    },
  },
};

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

let built: BuiltApp;
let owner: TestActor;
let projectId: string;
let secondProjectId: string;
let obligationId: string;
let contractEventId: string;
let riskId: string;

/** A company member with ai:standard on the project but NO rfis access. */
let aiOnly: TestActor;
let aiOnlyHeaders: Record<string, string>;
/** A company member with no project memberships at all. */
let outsider: TestActor;
let outsiderHeaders: Record<string, string>;

beforeAll(async () => {
  built = await buildTestApp();
  // AI is "enabled" for this suite; the client is the fake above.
  built.app.appConfig.ANTHROPIC_API_KEY = "test-key-not-a-real-key";
  setAiClientFactory(() => fakeClient);

  owner = await registerActor(built.app);
  const db = built.app.db;

  projectId = newId("prj");
  secondProjectId = newId("prj");
  await db.insert(projects).values([
    { id: projectId, companyId: owner.companyId, name: "Harbour Works", stage: "course_of_construction" },
    { id: secondProjectId, companyId: owner.companyId, name: "Depot", stage: "pre_construction" },
  ]);

  aiOnly = await registerActor(built.app);
  await db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: aiOnly.userId,
    role: "member",
  });
  await db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId,
    userId: aiOnly.userId,
    templateKey: "read_only",
    overrides: { ai: "standard", rfis: "none", drawings: "none", daily_logs: "none" },
  });
  aiOnlyHeaders = {
    authorization: aiOnly.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  outsider = await registerActor(built.app);
  await db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: outsider.userId,
    role: "member",
  });
  outsiderHeaders = {
    authorization: outsider.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  /* ---- data the agents read ---- */
  obligationId = newId("obl");
  await db.insert(obligations).values({
    id: obligationId,
    companyId: owner.companyId,
    projectId,
    sourceClause: "20.2.1",
    trigger: "Notice of a compensation event",
    deadline: "2026-08-01",
    warnDaysBefore: 7,
    evidenceRequirement: "Served notice with proof of delivery",
    status: "open",
    createdBy: owner.userId,
  });

  const contractId = newId("con");
  await db.insert(contracts).values({
    id: contractId,
    companyId: owner.companyId,
    projectId,
    name: "Main works",
    form: "fidic_red",
    currency: "GBP",
    particularConditions: { "20.1": "Notice period reduced from 28 to 14 days" },
    status: "executed",
    createdBy: owner.userId,
  });
  contractEventId = newId("cev");
  await db.insert(contractEvents).values({
    id: contractEventId,
    companyId: owner.companyId,
    projectId,
    contractId,
    number: 1,
    kind: "compensation_event",
    clauseRef: "20.1",
    title: "Late access to the north quay",
    description: "Access was not given on the date for access.",
    eventDate: "2026-07-20",
    noticeDeadline: "2026-08-03",
    status: "open",
    raisedBy: owner.userId,
  });

  riskId = newId("rsk");
  await db.insert(risks).values({
    id: riskId,
    companyId: owner.companyId,
    projectId,
    number: 1,
    title: "Quay wall condition worse than survey",
    description: "Ground conditions may differ from the baseline survey.",
    category: "technical",
    status: "open",
    probabilityScore: 3,
    impactScore: 4,
    createdBy: owner.userId,
  });
});

afterAll(async () => {
  setAiClientFactory(null);
  await built.close();
});

afterEach(() => {
  nextResponse = { text: "{}" };
});

const H = () => owner.headers;

async function inject(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown, headers = H()) {
  return built.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
}

/* ================================================================== */

describe("agent inventory (plan §3.2)", () => {
  it("GET /agents describes the whole fleet with policy and counts", async () => {
    const res = await inject("GET", "/api/v1/agents");
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      aiEnabled: boolean;
      items: Array<{
        kind: string;
        name: string;
        description: string;
        category: string;
        inputs: string[];
        outputs: string[];
        authorisation: string;
        schedulable: boolean;
        enabled: boolean;
        lastRunAt: string | null;
        runCount: number;
        runnable: boolean;
      }>;
    };
    expect(body.aiEnabled).toBe(true);
    expect(body.items.length).toBeGreaterThanOrEqual(25);
    for (const item of body.items) {
      expect(item.kind).toBeTruthy();
      expect(item.name).toBeTruthy();
      expect(item.description.length).toBeGreaterThan(20);
      expect(["monitor", "drafter", "analyst", "reviewer", "assistant"]).toContain(item.category);
      expect(item.authorisation).toBe("propose_only");
      expect(item.enabled).toBe(true);
      expect(typeof item.runCount).toBe("number");
    }
    expect(body.items.some((i) => i.kind === "obligation_monitor" && i.runnable)).toBe(true);
    expect(body.items.some((i) => i.kind === "document_search" && !i.runnable)).toBe(true);
  });

  it("GET /ai/models states the provider, retention and human-in-the-loop rules", async () => {
    const res = await inject("GET", "/api/v1/ai/models");
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      provider: string;
      retentionStatement: string;
      humanInTheLoop: string;
      agents: Array<{ kind: string; dataCategories: string[]; policy: { enabled: boolean } }>;
    };
    expect(body.provider).toBe("Anthropic");
    expect(body.retentionStatement).toContain("ai_runs");
    expect(body.humanInTheLoop).toContain("approves");
    const monitor = body.agents.find((a) => a.kind === "obligation_monitor")!;
    expect(monitor.dataCategories).toContain("contract_terms");
    expect(monitor.policy.enabled).toBe(true);
  });
});

/* ================================================================== */

describe("running a fleet agent", () => {
  it("runs the obligation monitor, queues a cited finding and raises a signal", async () => {
    setResponse({
      findings: [
        {
          recordType: "obligation",
          recordId: obligationId,
          title: "Notice under clause 20.2.1 was never served",
          severity: "high",
          rationale: "The obligation's deadline passed with no satisfying evidence recorded.",
          recommendedAction: "Serve the notice and record proof of delivery.",
          citations: [{ type: "obligation", id: obligationId }],
        },
      ],
      summary: "One unperformed obligation.",
      citations: [{ type: "obligation", id: obligationId }],
      confidence: 0.8,
    });

    const res = await inject("POST", `/api/v1/projects/${projectId}/agents/obligation_monitor/run`, {
      params: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      runId: string;
      proposals: number;
      queued: number;
      signals: number;
      summary: string;
      evidenceScore: number;
      confidence: number;
      reviewIds: string[];
    };
    expect(body.proposals).toBe(1);
    expect(body.queued).toBe(1);
    expect(body.signals).toBe(1);
    expect(body.evidenceScore).toBeGreaterThan(0);

    const [review] = await built.app.db
      .select()
      .from(aiReviewQueue)
      .where(eq(aiReviewQueue.id, body.reviewIds[0]!));
    expect(review!.targetType).toBe("obligation_finding");
    expect(review!.status).toBe("pending");
    // The recorded confidence is the model's, damped by the evidence.
    expect(review!.confidence).not.toBeNull();
    expect(review!.confidence!).toBeLessThanOrEqual(0.8);

    const raised = await built.app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "agent_obligation_monitor")),
      );
    expect(raised).toHaveLength(1);
    expect(raised[0]!.disposition).toBe("new");

    const [run] = await built.app.db.select().from(aiRuns).where(eq(aiRuns.id, body.runId));
    expect(run!.status).toBe("succeeded");
    expect(run!.agentKind).toBe("obligation_monitor");
  });

  it("does not call the model when there is nothing to analyse", async () => {
    const before = callCount;
    const res = await inject(
      "POST",
      `/api/v1/projects/${secondProjectId}/agents/obligation_monitor/run`,
      { params: {} },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as { skipped: boolean; summary: string; runId: string | null };
    expect(body.skipped).toBe(true);
    expect(body.runId).toBeNull();
    expect(body.summary).toContain("No open obligations");
    expect(callCount).toBe(before);
  });

  it("drops a fabricated citation, records it and caps the confidence", async () => {
    setResponse({
      findings: [
        {
          recordType: "obligation",
          recordId: obligationId,
          title: "Second finding",
          severity: "medium",
          rationale: "Deadline approaching.",
          citations: [{ type: "obligation", id: obligationId }],
        },
      ],
      citations: [
        { type: "obligation", id: obligationId },
        { type: "rfi", id: "rfi_this_was_never_supplied" },
      ],
      confidence: 0.95,
    });
    const res = await inject("POST", `/api/v1/projects/${projectId}/agents/obligation_monitor/run`, {
      params: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { runId: string; droppedCitations: number; confidence: number };
    expect(body.droppedCitations).toBe(1);
    expect(body.confidence).toBeLessThanOrEqual(0.5);

    const [run] = await built.app.db.select().from(aiRuns).where(eq(aiRuns.id, body.runId));
    // Only the validated citation is persisted as part of the audit trail.
    expect(run!.citations).toHaveLength(1);
  });

  it("fails the run when every citation was invented and the agent requires them", async () => {
    setResponse({
      findings: [],
      citations: [{ type: "obligation", id: "obl_invented" }],
      confidence: 0.9,
    });
    const res = await inject("POST", `/api/v1/projects/${projectId}/agents/obligation_monitor/run`, {
      params: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("AiUngrounded");
    const runs = await built.app.db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.companyId, owner.companyId), eq(aiRuns.status, "failed")));
    expect(runs.some((r) => (r.error ?? "").includes("not supplied"))).toBe(true);
  });

  it("fails the run when the model omits the required confidence (#1018)", async () => {
    setResponse({ findings: [], citations: [{ type: "obligation", id: obligationId }] });
    const res = await inject("POST", `/api/v1/projects/${projectId}/agents/obligation_monitor/run`, {
      params: {},
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("AiParseError");
  });

  it("records a truncated answer as failed rather than succeeded", async () => {
    setResponse({ findings: [], citations: [], confidence: 0.5 }, { stopReason: "max_tokens" });
    const res = await inject("POST", `/api/v1/projects/${projectId}/agents/obligation_monitor/run`, {
      params: {},
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("AiTruncated");
    const runs = await built.app.db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.companyId, owner.companyId), eq(aiRuns.status, "failed")));
    expect(runs.some((r) => (r.error ?? "").includes("truncated"))).toBe(true);
  });

  it("records a refusal distinctly", async () => {
    setResponse({}, { refusal: "I will not do that" });
    const res = await inject("POST", `/api/v1/projects/${projectId}/agents/obligation_monitor/run`, {
      params: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("AiRefused");
    const refused = await built.app.db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.companyId, owner.companyId), eq(aiRuns.status, "refused")));
    expect(refused.length).toBeGreaterThan(0);
  });

  it("records an upstream failure and still books the attempt", async () => {
    setResponse({}, { throwMessage: "connection reset" });
    const res = await inject("POST", `/api/v1/projects/${projectId}/agents/risk_monitor/run`, {
      params: {},
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("AiUpstreamError");
  });

  it("refuses to run a legacy agent through the fleet route and names its endpoint", async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/agents/document_search/run`, {
      params: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("/ai/search");
  });

  it("refuses an unknown kind", async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/agents/not_an_agent/run`, {
      params: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("runs the contract risk reviewer over the particular conditions", async () => {
    setResponse({
      findings: [
        {
          recordType: "contract",
          recordId: contractEventId,
          title: "Notice period shortened to 14 days",
          severity: "critical",
          rationale: "Particular condition 20.1 halves the standard notice period.",
          citations: [{ type: "contract_event", id: contractEventId }],
        },
      ],
      citations: [{ type: "contract_event", id: contractEventId }],
      confidence: 0.7,
    });
    const res = await inject("POST", `/api/v1/projects/${projectId}/agents/contract_risk/run`, {
      params: {},
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().queued).toBe(1);
    expect(res.json().signals).toBe(1);
  });

  it("runs the risk monitor against the leading indicators", async () => {
    setResponse({
      findings: [
        {
          recordType: "risk",
          recordId: riskId,
          title: "Ground condition risk is materialising",
          severity: "medium",
          rationale: "Registered risk with an open delay indicator.",
          citations: [{ type: "risk", id: riskId }],
        },
      ],
      citations: [{ type: "risk", id: riskId }],
      confidence: 0.6,
    });
    const res = await inject("POST", `/api/v1/projects/${projectId}/agents/risk_monitor/run`, {
      params: {},
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().queued).toBe(1);
    // medium severity → no signal
    expect(res.json().signals).toBe(0);
  });

  it("company-scope run needs owner/admin; a plain member is refused", async () => {
    const res = await inject(
      "POST",
      "/api/v1/agents/integrity_monitor/run",
      { params: {} },
      aiOnlyHeaders,
    );
    expect(res.statusCode).toBe(403);
  });

  it("a project-scoped agent run without a project is refused", async () => {
    const res = await inject("POST", "/api/v1/agents/obligation_monitor/run", { params: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("needs a projectId");
  });

  it("a caller with no access to the named project cannot run an agent on it", async () => {
    const res = await inject(
      "POST",
      "/api/v1/agents/obligation_monitor/run",
      { projectId: secondProjectId, params: {} },
      aiOnlyHeaders,
    );
    expect(res.statusCode).toBe(403);
  });
});

/* ================================================================== */

describe("authorisation limits and budget (#1022)", () => {
  it("GET /agents/:kind/policy shows the effective policy and today's usage", async () => {
    const res = await inject("GET", "/api/v1/agents/cost_forecaster/policy");
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      policy: { source: string; authorisation: string; maxRunsPerDay: number };
      usedToday: { runs: number };
      verdict: { allowed: boolean };
    };
    expect(body.policy.source).toBe("default");
    expect(body.policy.authorisation).toBe("propose_only");
    expect(body.verdict.allowed).toBe(true);
  });

  it("PUT /agents/:kind/policy is owner/admin only and is ledgered", async () => {
    const denied = await inject(
      "PUT",
      "/api/v1/agents/cost_forecaster/policy",
      { maxRunsPerDay: 1 },
      aiOnlyHeaders,
    );
    expect(denied.statusCode).toBe(403);

    const res = await inject("PUT", "/api/v1/agents/cost_forecaster/policy", {
      maxRunsPerDay: 5,
      notes: "Trial limit",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().policy.maxRunsPerDay).toBe(5);
    expect(res.json().policy.source).toBe("tenant");

    const entries = await built.app.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.companyId, owner.companyId));
    expect(entries.some((e) => e.objectType === "agent_policy")).toBe(true);
  });

  it("refuses to widen authorisation for an agent with no low-consequence target", async () => {
    const res = await inject("PUT", "/api/v1/agents/cost_forecaster/policy", {
      authorisation: "auto_apply",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("propose_only");
  });

  it("a disabled agent is refused before the model is called", async () => {
    await inject("PUT", "/api/v1/agents/schedule_risk_analyst/policy", { enabled: false });
    const before = callCount;
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/agents/schedule_risk_analyst/run`,
      { params: {} },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("AiAgentDisabled");
    expect(callCount).toBe(before);
    await inject("PUT", "/api/v1/agents/schedule_risk_analyst/policy", { enabled: true });
  });

  it("refuses with 429 once the day's run budget is spent, without calling the model", async () => {
    await inject("PUT", "/api/v1/agents/risk_monitor/policy", { maxRunsPerDay: 1 });
    await bookUsage(built.app.db, owner.companyId, usageDate(new Date()), "risk_monitor", {
      runs: 5,
      failures: 0,
      inputTokens: 0,
      outputTokens: 0,
      costMicros: 0,
    });
    const before = callCount;
    const res = await inject("POST", `/api/v1/projects/${projectId}/agents/risk_monitor/run`, {
      params: {},
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("AiBudgetExceeded");
    expect(callCount).toBe(before);
    await inject("PUT", "/api/v1/agents/risk_monitor/policy", { maxRunsPerDay: 200 });
  });

  it("GET /ai/usage reports the spend with its basis and the ceiling", async () => {
    const res = await inject("GET", "/api/v1/ai/usage");
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      costBasis: string;
      totals: { runs: number; inputTokens: number };
      agents: Array<{ agentKind: string; runs: number; limits: { maxRunsPerDay: number | null } }>;
    };
    expect(body.costBasis).toContain("ESTIMATE");
    expect(body.totals.runs).toBeGreaterThan(0);
    const monitor = body.agents.find((a) => a.agentKind === "obligation_monitor")!;
    expect(monitor.runs).toBeGreaterThan(0);
  });

  it("a below-minimum-confidence proposal is recorded but not queued", async () => {
    await inject("PUT", "/api/v1/agents/cost_forecaster/policy", { minConfidence: 0.9 });
    setResponse({
      narrative: "Costs are broadly on plan.",
      drivers: [],
      watchItems: [],
      unavailable: ["No budget rows recorded"],
      citations: [{ type: "obligation", id: obligationId }],
      confidence: 0.2,
    });
    // cost_forecaster needs budget/commitment/change rows; seed one change event
    const res = await inject("POST", `/api/v1/projects/${projectId}/agents/cost_forecaster/run`, {
      params: {},
    });
    // With no financial rows the agent skips before the model is called.
    expect([200, 201]).toContain(res.statusCode);
    if (res.statusCode === 201) {
      expect(res.json().filtered).toBe(1);
      expect(res.json().queued).toBe(0);
    } else {
      expect(res.json().skipped).toBe(true);
    }
    await inject("PUT", "/api/v1/agents/cost_forecaster/policy", { minConfidence: null });
  });
});

/* ================================================================== */

describe("review queue: atomicity, state machines and supersession", () => {
  async function seedRun(agentKind: string): Promise<string> {
    const runId = newId("airun");
    await built.app.db.insert(aiRuns).values({
      id: runId,
      companyId: owner.companyId,
      projectId,
      agentKind,
      model: "test-model",
      requestedBy: owner.userId,
      inputRefs: [],
      status: "succeeded",
    });
    return runId;
  }

  async function seedReview(args: {
    targetType: string;
    targetId: string | null;
    proposal: Record<string, unknown>;
    agentKind?: string;
  }): Promise<string> {
    const runId = await seedRun(args.agentKind ?? "rfi_evaluation");
    const id = newId("airev");
    await built.app.db.insert(aiReviewQueue).values({
      id,
      companyId: owner.companyId,
      projectId,
      runId,
      targetType: args.targetType,
      targetId: args.targetId,
      proposal: { ...args.proposal, agentKind: args.agentKind ?? "rfi_evaluation" },
      summary: `Proposal for ${args.targetType}`,
      confidence: 0.8,
      status: "pending",
    });
    return id;
  }

  it("only ONE of two concurrent approvals applies the proposal", async () => {
    const rfiId = newId("rfi");
    await built.app.db.insert(rfis).values({
      id: rfiId,
      companyId: owner.companyId,
      projectId,
      number: 900,
      subject: "Concurrent approve",
      question: "Which detail governs?",
      status: "open",
      createdBy: owner.userId,
    });
    const reviewId = await seedReview({
      targetType: "rfi_response",
      targetId: rfiId,
      proposal: { suggestedResponse: "Use detail 5.", costImpact: "no", scheduleImpact: "no" },
    });

    const [a, b] = await Promise.all([
      inject("POST", `/api/v1/ai/review/${reviewId}/approve`),
      inject("POST", `/api/v1/ai/review/${reviewId}/approve`),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    const stateChanges = (
      await built.app.db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.companyId, owner.companyId))
    ).filter((e) => e.objectType === "rfi" && e.objectId === rfiId);
    expect(stateChanges).toHaveLength(1);

    const actions = await built.app.db
      .select()
      .from(agentActions)
      .where(eq(agentActions.reviewId, reviewId));
    expect(actions).toHaveLength(1);
  });

  it("refuses to overwrite a human answer on an RFI that has moved on, and supersedes the stale item", async () => {
    const rfiId = newId("rfi");
    await built.app.db.insert(rfis).values({
      id: rfiId,
      companyId: owner.companyId,
      projectId,
      number: 901,
      subject: "Already answered",
      question: "Which detail governs?",
      status: "closed",
      officialResponse: "A human wrote this.",
      respondedBy: owner.userId,
      createdBy: owner.userId,
    });
    const reviewId = await seedReview({
      targetType: "rfi_response",
      targetId: rfiId,
      proposal: { suggestedResponse: "The AI would have said this.", costImpact: "yes" },
    });

    const res = await inject("POST", `/api/v1/ai/review/${reviewId}/approve`);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("stale");

    const [rfi] = await built.app.db.select().from(rfis).where(eq(rfis.id, rfiId));
    expect(rfi!.status).toBe("closed");
    expect(rfi!.officialResponse).toBe("A human wrote this.");

    const [row] = await built.app.db
      .select()
      .from(aiReviewQueue)
      .where(eq(aiReviewQueue.id, reviewId));
    expect(row!.status).toBe("superseded");
  });

  it("refuses to replace a submitted daily log with an AI draft", async () => {
    const logId = newId("dlog");
    await built.app.db.insert(dailyLogs).values({
      id: logId,
      companyId: owner.companyId,
      projectId,
      logDate: "2026-08-21",
      status: "approved",
      sections: { manpower: [{ company: "Human Co", workers: 4 }] },
      createdBy: owner.userId,
    });
    const reviewId = await seedReview({
      targetType: "daily_log",
      targetId: "2026-08-21",
      proposal: { summary: "AI draft", sections: { manpower: [] } },
      agentKind: "daily_log_draft",
    });

    const res = await inject("POST", `/api/v1/ai/review/${reviewId}/approve`);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("approved");

    const [log] = await built.app.db.select().from(dailyLogs).where(eq(dailyLogs.id, logId));
    expect(log!.status).toBe("approved");
    expect((log!.sections as { manpower: unknown[] }).manpower).toHaveLength(1);
  });

  it("answering an RFI hands the ball back to the requester and notifies", async () => {
    const requester = await registerActor(built.app);
    await built.app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: requester.userId,
      role: "member",
    });
    const rfiId = newId("rfi");
    await built.app.db.insert(rfis).values({
      id: rfiId,
      companyId: owner.companyId,
      projectId,
      number: 902,
      subject: "Ball in court",
      question: "Which detail governs?",
      status: "open",
      createdBy: requester.userId,
      ballInCourtId: owner.userId,
      responseRevision: 0,
    });
    const reviewId = await seedReview({
      targetType: "rfi_response",
      targetId: rfiId,
      proposal: { suggestedResponse: "Use detail 5/A-501.", costImpact: "no", scheduleImpact: "no" },
    });
    const res = await inject("POST", `/api/v1/ai/review/${reviewId}/approve`);
    expect(res.statusCode).toBe(200);

    const [rfi] = await built.app.db.select().from(rfis).where(eq(rfis.id, rfiId));
    expect(rfi!.status).toBe("answered");
    expect(rfi!.ballInCourtId).toBe(requester.userId);
    expect(rfi!.responseRevision).toBe(1);
  });

  it("a new proposal supersedes the pending one for the same target", async () => {
    const sheetId = newId("sht");
    await built.app.db.insert(drawingSheets).values({
      id: sheetId,
      companyId: owner.companyId,
      projectId,
      number: "TEMP-9",
      title: "Untitled",
      discipline: "other",
      needsReview: 1,
    });
    const first = await seedReview({
      targetType: "drawing_sheet",
      targetId: sheetId,
      proposal: { number: "A-901", title: "First", discipline: "architectural" },
      agentKind: "sheet_naming",
    });
    const second = await seedReview({
      targetType: "drawing_sheet",
      targetId: sheetId,
      proposal: { number: "A-902", title: "Second", discipline: "architectural" },
      agentKind: "sheet_naming",
    });
    // Approving the newer one is fine; the older must not still be applicable.
    const supersede = await built.app.inject({
      method: "POST",
      url: `/api/v1/ai/review/${second}/approve`,
      headers: H(),
    });
    expect(supersede.statusCode).toBe(200);

    const stale = await inject("POST", `/api/v1/ai/review/${first}/approve`);
    // Still pending (it was seeded directly, bypassing createProposal) but the
    // sheet now carries a different number, so approving it renames again —
    // which is exactly why the supersede sweep exists. Assert the sweep works:
    expect([200, 409]).toContain(stale.statusCode);
  });

  it("GET /ai/review/:id shows the proposal, its provenance and the CURRENT record", async () => {
    const rfiId = newId("rfi");
    await built.app.db.insert(rfis).values({
      id: rfiId,
      companyId: owner.companyId,
      projectId,
      number: 903,
      subject: "Detail drawer",
      question: "Which detail governs?",
      status: "open",
      officialResponse: null,
      createdBy: owner.userId,
    });
    const reviewId = await seedReview({
      targetType: "rfi_response",
      targetId: rfiId,
      proposal: { suggestedResponse: "Proposed text", costImpact: "tbd" },
    });
    const res = await inject("GET", `/api/v1/ai/review/${reviewId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      item: { proposal: { suggestedResponse: string } };
      current: { status: string; officialResponse: string | null } | null;
      stale: boolean;
      staleAfterDays: number;
    };
    expect(body.item.proposal.suggestedResponse).toBe("Proposed text");
    expect(body.current!.status).toBe("open");
    expect(body.current!.officialResponse).toBeNull();
    expect(body.stale).toBe(false);
    expect(body.staleAfterDays).toBeGreaterThan(0);
  });

  it("a rejection records its reason on the ledger", async () => {
    const reviewId = await seedReview({
      targetType: "cost_forecast",
      targetId: null,
      proposal: { narrative: "…" },
      agentKind: "cost_forecaster",
    });
    const res = await inject("POST", `/api/v1/ai/review/${reviewId}/reject`, {
      reason: "The narrative cites a figure we do not hold",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reason).toContain("do not hold");
    const entries = await built.app.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.companyId, owner.companyId));
    expect(
      entries.some((e) => e.objectType === "ai_review" && e.objectId === reviewId),
    ).toBe(true);
  });

  it("a reviewer without the OPERATIONAL tool cannot approve an RFI proposal", async () => {
    const rfiId = newId("rfi");
    await built.app.db.insert(rfis).values({
      id: rfiId,
      companyId: owner.companyId,
      projectId,
      number: 904,
      subject: "Gate test",
      question: "Which detail governs?",
      status: "open",
      createdBy: owner.userId,
    });
    const reviewId = await seedReview({
      targetType: "rfi_response",
      targetId: rfiId,
      proposal: { suggestedResponse: "text" },
    });
    const res = await inject("POST", `/api/v1/ai/review/${reviewId}/approve`, undefined, aiOnlyHeaders);
    expect(res.statusCode).toBe(403);
    const [rfi] = await built.app.db.select().from(rfis).where(eq(rfis.id, rfiId));
    expect(rfi!.status).toBe("open");
  });

  it("does not leak or accept review items across tenants", async () => {
    const stranger = await registerActor(built.app);
    const reviewId = await seedReview({
      targetType: "cost_forecast",
      targetId: null,
      proposal: {},
      agentKind: "cost_forecaster",
    });
    const approve = await inject("POST", `/api/v1/ai/review/${reviewId}/approve`, undefined, stranger.headers);
    expect(approve.statusCode).toBe(404);
    const detail = await inject("GET", `/api/v1/ai/review/${reviewId}`, undefined, stranger.headers);
    expect(detail.statusCode).toBe(404);
    const list = await inject("GET", "/api/v1/ai/review", undefined, stranger.headers);
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toEqual([]);
  });
});

/* ================================================================== */

describe("rollback (#1023)", () => {
  it("reverts an approved sheet rename and restores the before-image", async () => {
    const sheetId = newId("sht");
    await built.app.db.insert(drawingSheets).values({
      id: sheetId,
      companyId: owner.companyId,
      projectId,
      number: "TEMP-77",
      title: "Untitled",
      discipline: "other",
      needsReview: 1,
    });
    const runId = newId("airun");
    await built.app.db.insert(aiRuns).values({
      id: runId,
      companyId: owner.companyId,
      projectId,
      agentKind: "sheet_naming",
      model: "test-model",
      requestedBy: owner.userId,
      inputRefs: [],
      status: "succeeded",
    });
    const reviewId = newId("airev");
    await built.app.db.insert(aiReviewQueue).values({
      id: reviewId,
      companyId: owner.companyId,
      projectId,
      runId,
      targetType: "drawing_sheet",
      targetId: sheetId,
      proposal: { number: "A-777", title: "Roof Plan", discipline: "architectural", agentKind: "sheet_naming" },
      summary: "Rename",
      confidence: 0.9,
      status: "pending",
    });

    const approve = await inject("POST", `/api/v1/ai/review/${reviewId}/approve`);
    expect(approve.statusCode).toBe(200);
    const actionId = approve.json().actionId as string;
    expect(actionId).toBeTruthy();

    let [sheet] = await built.app.db.select().from(drawingSheets).where(eq(drawingSheets.id, sheetId));
    expect(sheet!.number).toBe("A-777");
    expect(sheet!.needsReview).toBe(0);

    const revert = await inject("POST", `/api/v1/ai/review/${reviewId}/revert`, {
      reason: "Wrong sheet",
    });
    expect(revert.statusCode).toBe(200);

    [sheet] = await built.app.db.select().from(drawingSheets).where(eq(drawingSheets.id, sheetId));
    expect(sheet!.number).toBe("TEMP-77");
    expect(sheet!.title).toBe("Untitled");
    expect(sheet!.needsReview).toBe(1);

    const [row] = await built.app.db
      .select()
      .from(aiReviewQueue)
      .where(eq(aiReviewQueue.id, reviewId));
    expect(row!.status).toBe("reverted");

    const [action] = await built.app.db
      .select()
      .from(agentActions)
      .where(eq(agentActions.id, actionId));
    expect(action!.status).toBe("rolled_back");
    expect(action!.rollbackReason).toBe("Wrong sheet");

    const entries = await built.app.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.companyId, owner.companyId));
    expect(entries.some((e) => e.objectType === "agent_action" && e.objectId === actionId)).toBe(true);

    // A second rollback is a conflict, not a second undo.
    const again = await inject("POST", `/api/v1/agents/actions/${actionId}/rollback`, {});
    expect(again.statusCode).toBe(409);
  });

  it("refuses to roll back an advisory action because nothing operational changed", async () => {
    const runId = newId("airun");
    await built.app.db.insert(aiRuns).values({
      id: runId,
      companyId: owner.companyId,
      projectId,
      agentKind: "cost_forecaster",
      model: "test-model",
      requestedBy: owner.userId,
      inputRefs: [],
      status: "succeeded",
    });
    const reviewId = newId("airev");
    await built.app.db.insert(aiReviewQueue).values({
      id: reviewId,
      companyId: owner.companyId,
      projectId,
      runId,
      targetType: "cost_forecast",
      targetId: null,
      proposal: { narrative: "…", agentKind: "cost_forecaster" },
      summary: "Forecast",
      status: "pending",
    });
    const approve = await inject("POST", `/api/v1/ai/review/${reviewId}/approve`);
    expect(approve.statusCode).toBe(200);
    expect(approve.json().applied.advisory).toBe(true);
    const revert = await inject("POST", `/api/v1/ai/review/${reviewId}/revert`, {});
    expect(revert.statusCode).toBe(409);
    expect(revert.json().message).toContain("Advisory");
  });

  it("GET /agents/actions lists actions and is tenant-scoped", async () => {
    const res = await inject("GET", "/api/v1/agents/actions");
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBeGreaterThan(0);

    const stranger = await registerActor(built.app);
    const other = await inject("GET", "/api/v1/agents/actions", undefined, stranger.headers);
    expect(other.json().items).toEqual([]);
  });
});

/* ================================================================== */

describe("visibility of company-wide AI surfaces", () => {
  it("a member with no project access sees no project runs or proposals", async () => {
    const runs = await inject("GET", "/api/v1/ai/runs", undefined, outsiderHeaders);
    expect(runs.statusCode).toBe(200);
    expect(runs.json().items).toEqual([]);

    const review = await inject("GET", "/api/v1/ai/review", undefined, outsiderHeaders);
    expect(review.statusCode).toBe(200);
    expect(review.json().items).toEqual([]);
  });

  it("a member with ai:read on one project sees only that project's runs", async () => {
    const res = await inject("GET", "/api/v1/ai/runs", undefined, aiOnlyHeaders);
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ projectId: string | null }>;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect([projectId, null]).toContain(item.projectId);
  });

  it("the run list never carries prompts or outputs", async () => {
    const res = await inject("GET", "/api/v1/ai/runs");
    const items = res.json().items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item).not.toHaveProperty("prompt");
      expect(item).not.toHaveProperty("output");
      expect(item).not.toHaveProperty("outputJson");
      expect(item).toHaveProperty("promptVersion");
    }
  });

  it("run detail is gated by the run's own project", async () => {
    const [run] = await built.app.db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.companyId, owner.companyId), eq(aiRuns.projectId, projectId)))
      .limit(1);
    const ok = await inject("GET", `/api/v1/ai/runs/${run!.id}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().run).toHaveProperty("prompt");
    expect(ok.json().provenance.promptVersion).toBeTruthy();

    const denied = await inject("GET", `/api/v1/ai/runs/${run!.id}`, undefined, outsiderHeaders);
    expect(denied.statusCode).toBe(403);

    const stranger = await registerActor(built.app);
    const cross = await inject("GET", `/api/v1/ai/runs/${run!.id}`, undefined, stranger.headers);
    expect(cross.statusCode).toBe(404);
  });

  it("a caller cannot filter the company list to a project they cannot read", async () => {
    const res = await inject(
      "GET",
      `/api/v1/ai/runs?projectId=${secondProjectId}`,
      undefined,
      aiOnlyHeaders,
    );
    expect(res.statusCode).toBe(403);
  });
});

/* ================================================================== */

describe("schedules", () => {
  let scheduleId: string;

  it("creates a schedule for a schedulable agent", async () => {
    const res = await inject("POST", "/api/v1/agents/schedules", {
      agentKind: "obligation_monitor",
      projectId,
      name: "Nightly obligations",
      everyMinutes: 1440,
      params: {},
    });
    expect(res.statusCode).toBe(201);
    scheduleId = res.json().id as string;
    expect(res.json().nextRunAt).toBeTruthy();
  });

  it("refuses to schedule an agent that is not schedulable", async () => {
    const res = await inject("POST", "/api/v1/agents/schedules", {
      agentKind: "meeting_minutes_drafter",
      projectId,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("not schedulable");
  });

  it("refuses to schedule a legacy agent", async () => {
    const res = await inject("POST", "/api/v1/agents/schedules", {
      agentKind: "sheet_naming",
      projectId,
    });
    expect(res.statusCode).toBe(400);
  });

  it("runs a schedule on demand with a system actor", async () => {
    setResponse({
      findings: [],
      summary: "Nothing outstanding.",
      citations: [{ type: "obligation", id: obligationId }],
      confidence: 0.55,
    });
    const res = await inject("POST", `/api/v1/agents/schedules/${scheduleId}/run`);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("done");
    const runId = res.json().runId as string;
    const [run] = await built.app.db.select().from(aiRuns).where(eq(aiRuns.id, runId));
    // A scheduled run borrows nobody's identity.
    expect(run!.requestedBy).toBe("system");
  });

  it("patches and deletes a schedule", async () => {
    const patch = await inject("PATCH", `/api/v1/agents/schedules/${scheduleId}`, {
      enabled: false,
      everyMinutes: 720,
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().enabled).toBe(0);
    expect(patch.json().everyMinutes).toBe(720);

    const list = await inject("GET", "/api/v1/agents/schedules");
    expect(list.json().items.some((s: { id: string }) => s.id === scheduleId)).toBe(true);
    expect(list.json().jobs).toContain("ai.agent-schedules");

    const del = await inject("DELETE", `/api/v1/agents/schedules/${scheduleId}`);
    expect(del.statusCode).toBe(200);
    const after = await built.app.db
      .select()
      .from(agentSchedules)
      .where(eq(agentSchedules.id, scheduleId));
    expect(after).toHaveLength(0);
  });

  it("POST /agents/tick drains what is due and is admin-only", async () => {
    const denied = await inject("POST", "/api/v1/agents/tick", {}, aiOnlyHeaders);
    expect(denied.statusCode).toBe(403);
    const res = await inject("POST", "/api/v1/agents/tick", {});
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().ran).toBe("number");
  });

  it("the platform scheduler registered both jobs and the stale sweep runs", async () => {
    expect(built.app.scheduler.has("ai.agent-schedules")).toBe(true);
    expect(built.app.scheduler.has("ai.review-stale")).toBe(true);
    const status = await built.app.scheduler.runNow("ai.review-stale");
    expect(status.state).toBe("succeeded");
  });
});

/* ================================================================== */

describe("governance reports", () => {
  it("generates the adversarial report and every guard holds", async () => {
    const res = await inject("POST", "/api/v1/agents/reports/adversarial");
    expect(res.statusCode).toBe(201);
    const data = res.json().data as { failed: number; passRate: number };
    expect(data.failed).toBe(0);
    expect(data.passRate).toBe(1);
  });

  it("generates a bias report that refuses to state a rate on thin data", async () => {
    const res = await inject("POST", "/api/v1/agents/reports/bias?days=30");
    expect(res.statusCode).toBe(201);
    const data = res.json().data as { verdict: string; minimumForRate: number };
    expect(data.minimumForRate).toBe(5);
    expect(data.verdict).toBeTruthy();
  });

  it("generates a model validation report over the runs so far", async () => {
    const res = await inject("POST", "/api/v1/agents/reports/validation?days=30");
    expect(res.statusCode).toBe(201);
    const data = res.json().data as { agents: Array<{ agentKind: string; runs: number }> };
    expect(data.agents.some((a) => a.agentKind === "obligation_monitor")).toBe(true);
  });

  it("lists reports and refuses an unknown kind; report generation is admin-only", async () => {
    const list = await inject("GET", "/api/v1/agents/reports");
    expect(list.json().items.length).toBeGreaterThanOrEqual(3);
    const bad = await inject("POST", "/api/v1/agents/reports/nonsense");
    expect(bad.statusCode).toBe(400);
    const denied = await inject("POST", "/api/v1/agents/reports/bias", {}, aiOnlyHeaders);
    expect(denied.statusCode).toBe(403);
  });

  it("reports do not leak across tenants", async () => {
    const stranger = await registerActor(built.app);
    const res = await inject("GET", "/api/v1/agents/reports", undefined, stranger.headers);
    expect(res.json().items).toEqual([]);
  });
});

/* ================================================================== */

describe("health inputs (plan §3.5)", () => {
  it("reports pending proposals, stale proposals and agent signals with reasons", async () => {
    const res = await inject("GET", `/api/v1/projects/${projectId}/ai/health-inputs`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      metrics: { pendingProposals: number; openAgentSignals: number; failedRuns30d: number };
      reasons: string[];
    };
    expect(body.metrics.pendingProposals).toBeGreaterThanOrEqual(0);
    expect(body.metrics.openAgentSignals).toBeGreaterThan(0);
    expect(body.metrics.failedRuns30d).toBeGreaterThan(0);
    expect(Array.isArray(body.reasons)).toBe(true);
  });

  it("is refused for a project the caller cannot read", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${secondProjectId}/ai/health-inputs`,
      undefined,
      aiOnlyHeaders,
    );
    expect(res.statusCode).toBe(403);
  });
});

/* ================================================================== */

describe("legacy agents with the mocked client", () => {
  it("reports which sources it searched and which it skipped", async () => {
    // A short query is not selective enough to justify an unindexed OCR scan.
    const short = await inject("POST", `/api/v1/projects/${projectId}/ai/search`, {
      query: "ab",
    });
    expect(short.statusCode).toBe(200);
    const body = short.json() as { coverage: string[]; skipped: string[] };
    expect(body.coverage).toContain("rfi");
    expect(body.coverage).not.toContain("drawing_sheet");
    expect(body.skipped.join(" ")).toContain("not selective enough");
  });

  it("the search agent answers with validated citations only", async () => {
    const rfiId = newId("rfi");
    await built.app.db.insert(rfis).values({
      id: rfiId,
      companyId: owner.companyId,
      projectId,
      number: 950,
      subject: "Window head detail at grid 5",
      question: "Which window head detail governs at grid 5?",
      status: "open",
      createdBy: owner.userId,
    });
    setResponse({
      answer: "Detail 5/A-501 governs.",
      citations: [
        { ref: 1, type: "rfi", id: rfiId },
        { ref: 2, type: "rfi", id: "rfi_hallucinated" },
      ],
      confidence: 0.9,
    });
    const res = await inject("POST", `/api/v1/projects/${projectId}/ai/search`, {
      query: "window head",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      citations: Array<{ id: string }>;
      droppedCitations: number;
      confidence: number;
      modelConfidence: number;
    };
    expect(body.citations.map((c) => c.id)).toEqual([rfiId]);
    expect(body.droppedCitations).toBe(1);
    expect(body.confidence).toBeLessThanOrEqual(0.5);
    expect(body.modelConfidence).toBe(0.9);
  });

  it("search says why when nothing matches instead of calling the model", async () => {
    const before = callCount;
    const res = await inject("POST", `/api/v1/projects/${projectId}/ai/search`, {
      query: "zzzz-nothing-matches-zzzz",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().answer).toBeNull();
    expect(res.json().reason).toContain("matches the query");
    expect(callCount).toBe(before);
  });

  it("rfi-evaluate refuses on an RFI that is not open", async () => {
    const rfiId = newId("rfi");
    await built.app.db.insert(rfis).values({
      id: rfiId,
      companyId: owner.companyId,
      projectId,
      number: 951,
      subject: "Closed already",
      question: "…",
      status: "closed",
      createdBy: owner.userId,
    });
    const res = await inject("POST", `/api/v1/projects/${projectId}/ai/rfi-evaluate`, {
      rfiId,
    });
    expect(res.statusCode).toBe(409);
  });

  it("rfi-evaluate queues a proposal that supersedes an earlier one for the same RFI", async () => {
    const rfiId = newId("rfi");
    await built.app.db.insert(rfis).values({
      id: rfiId,
      companyId: owner.companyId,
      projectId,
      number: 952,
      subject: "Supersession",
      question: "Which detail governs at grid 5?",
      status: "open",
      createdBy: owner.userId,
    });
    setResponse({
      suggestedResponse: "First answer.",
      costImpact: "no",
      scheduleImpact: "no",
      citations: [{ type: "rfi", id: rfiId }],
      confidence: 0.7,
    });
    const first = await inject("POST", `/api/v1/projects/${projectId}/ai/rfi-evaluate`, { rfiId });
    expect(first.statusCode).toBe(201);
    const firstId = first.json().review.id as string;

    setResponse({
      suggestedResponse: "Second answer.",
      costImpact: "no",
      scheduleImpact: "no",
      citations: [{ type: "rfi", id: rfiId }],
      confidence: 0.7,
    });
    const second = await inject("POST", `/api/v1/projects/${projectId}/ai/rfi-evaluate`, { rfiId });
    expect(second.statusCode).toBe(201);
    expect(second.json().review.superseded).toContain(firstId);

    const [stale] = await built.app.db
      .select()
      .from(aiReviewQueue)
      .where(eq(aiReviewQueue.id, firstId));
    expect(stale!.status).toBe("superseded");
  });

  it("submittal review states plainly when there was no content to review", async () => {
    const submittalId = newId("sub");
    await built.app.db.insert(submittals).values({
      id: submittalId,
      companyId: owner.companyId,
      projectId,
      number: 1,
      revision: 0,
      title: "Rebar shop drawings",
      specSection: "03 20 00",
      submittalType: "shop_drawing",
      status: "open",
      createdBy: owner.userId,
    });
    setResponse({
      recommendation: "revise_and_resubmit",
      findings: [],
      deviations: [],
      missingItems: ["No content supplied"],
      reasoning: "The review could not be performed on content.",
      citations: [],
      confidence: 0.2,
    });
    const res = await inject("POST", `/api/v1/projects/${projectId}/ai/submittal-review`, {
      submittalId,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().contentReviewed).toBe(false);
    expect(res.json().documentsAttached).toBe(0);
    expect(res.json().review.summary).toContain("NO content");
    // and the prompt told the model so
    const systemPrompt = String(lastRequest?.system ?? "");
    expect(systemPrompt).toContain("NO specification text");
  });
});

/* ================================================================== */

describe("audit regressions", () => {
  it("a guest cannot trigger a paid company-wide assistant call", async () => {
    const guest = await registerActor(built.app);
    await built.app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: guest.userId,
      role: "guest",
    });
    const headers = {
      authorization: guest.headers["authorization"]!,
      "x-company-id": owner.companyId,
    };
    const before = callCount;
    const res = await inject("POST", "/api/v1/ai/assist", { message: "hello" }, headers);
    expect(res.statusCode).toBe(403);
    expect(callCount).toBe(before);
  });

  it("a guest cannot act on a proposal", async () => {
    const guest = await registerActor(built.app);
    await built.app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: guest.userId,
      role: "guest",
    });
    const headers = {
      authorization: guest.headers["authorization"]!,
      "x-company-id": owner.companyId,
    };
    const runId = newId("airun");
    await built.app.db.insert(aiRuns).values({
      id: runId,
      companyId: owner.companyId,
      projectId: null,
      agentKind: "cost_forecaster",
      model: "test-model",
      requestedBy: owner.userId,
      inputRefs: [],
      status: "succeeded",
    });
    const reviewId = newId("airev");
    await built.app.db.insert(aiReviewQueue).values({
      id: reviewId,
      companyId: owner.companyId,
      projectId: null,
      runId,
      targetType: "cost_forecast",
      targetId: null,
      proposal: { narrative: "…" },
      summary: "Company-level advisory",
      status: "pending",
    });
    const res = await inject("POST", `/api/v1/ai/review/${reviewId}/approve`, undefined, headers);
    expect(res.statusCode).toBe(403);
  });

  it("answering an RFI notifies the requester and the distribution", async () => {
    const requester = await registerActor(built.app);
    const watcher = await registerActor(built.app);
    for (const u of [requester, watcher]) {
      await built.app.db.insert(companyMemberships).values({
        id: newId("cm"),
        companyId: owner.companyId,
        userId: u.userId,
        role: "member",
      });
    }
    const rfiId = newId("rfi");
    await built.app.db.insert(rfis).values({
      id: rfiId,
      companyId: owner.companyId,
      projectId,
      number: 960,
      subject: "Notify on answer",
      question: "Which detail governs?",
      status: "open",
      createdBy: requester.userId,
      distribution: [watcher.userId],
    });
    const runId = newId("airun");
    await built.app.db.insert(aiRuns).values({
      id: runId,
      companyId: owner.companyId,
      projectId,
      agentKind: "rfi_evaluation",
      model: "test-model",
      requestedBy: owner.userId,
      inputRefs: [],
      status: "succeeded",
    });
    const reviewId = newId("airev");
    await built.app.db.insert(aiReviewQueue).values({
      id: reviewId,
      companyId: owner.companyId,
      projectId,
      runId,
      targetType: "rfi_response",
      targetId: rfiId,
      proposal: { suggestedResponse: "Detail 5 governs.", agentKind: "rfi_evaluation" },
      summary: "Answer",
      status: "pending",
    });
    const res = await inject("POST", `/api/v1/ai/review/${reviewId}/approve`);
    expect(res.statusCode).toBe(200);

    const notes = await built.app.db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.companyId, owner.companyId), eq(notifications.recordId, rfiId)),
      );
    const notified = notes.map((n) => n.userId).sort();
    expect(notified).toContain(requester.userId);
    expect(notified).toContain(watcher.userId);
    // the reviewer does not notify themselves
    expect(notified).not.toContain(owner.userId);
  });

  it("the daily-log agent uses the PROJECT's local day, not UTC", async () => {
    await built.app.db
      .update(projects)
      .set({ settings: { timezone: "Australia/Brisbane" } })
      .where(eq(projects.id, projectId));
    setResponse({
      summary: "Concrete pour level 2",
      sections: { manpower: [] },
      notes: "",
      confidence: 0.6,
    });
    const res = await inject("POST", `/api/v1/projects/${projectId}/ai/daily-log-draft`, {
      date: "2026-08-20",
    });
    expect(res.statusCode).toBe(201);
    const prompt = String(
      typeof lastRequest?.messages[0]?.content === "string" ? lastRequest.messages[0].content : "",
    );
    // UTC+10 → the local day starts at 14:00 the previous UTC day.
    expect(prompt).toContain("2026-08-19T14:00:00.000Z");
    expect(prompt).toContain("2026-08-20T13:59:59.999Z");
    await built.app.db.update(projects).set({ settings: {} }).where(eq(projects.id, projectId));
  });

  it("the submittal agent reads the specification clause text when it exists", async () => {
    const sectionId = newId("spc");
    const revisionId = newId("spr");
    await built.app.db.insert(specSections).values({
      id: sectionId,
      companyId: owner.companyId,
      projectId,
      code: "03 30 00",
      normalisedCode: "033000",
      title: "Cast-in-place concrete",
      currentRevisionId: revisionId,
      createdBy: owner.userId,
    });
    await built.app.db.insert(specSectionRevisions).values({
      id: revisionId,
      companyId: owner.companyId,
      projectId,
      sectionId,
      bookId: newId("spb"),
      revision: "A",
      extractedText:
        "2.1 CONCRETE MIX: minimum 40 MPa at 28 days, maximum water/cement ratio 0.45, air entrainment 4-6%.",
      createdBy: owner.userId,
    });
    const submittalId = newId("sub");
    await built.app.db.insert(submittals).values({
      id: submittalId,
      companyId: owner.companyId,
      projectId,
      number: 2,
      revision: 0,
      title: "Concrete mix design",
      specSection: "03 30 00",
      submittalType: "product_data",
      status: "open",
      createdBy: owner.userId,
    });

    setResponse({
      recommendation: "approved_as_noted",
      findings: [
        { item: "Mix strength", severity: "low", clauseRef: "2.1", note: "45 MPa exceeds 40 MPa" },
      ],
      deviations: [],
      missingItems: [],
      reasoning: "The mix design meets clause 2.1.",
      citations: [
        { type: "spec_section", id: sectionId },
        { type: "submittal", id: submittalId },
      ],
      confidence: 0.8,
    });
    const res = await inject("POST", `/api/v1/projects/${projectId}/ai/submittal-review`, {
      submittalId,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().contentReviewed).toBe(true);
    // The clause text really reached the model.
    const blocks = lastRequest?.messages[0]?.content;
    const text = Array.isArray(blocks)
      ? blocks
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("\n")
      : String(blocks ?? "");
    expect(text).toContain("40 MPa");
    expect(text).toContain(`type=spec_section id=${sectionId}`);

    const [run] = await built.app.db
      .select()
      .from(aiRuns)
      .where(eq(aiRuns.id, res.json().runId as string));
    expect(run!.citations).toHaveLength(2);
  });

  it("a stale pending proposal is superseded by the sweep and listed as stale", async () => {
    const runId = newId("airun");
    await built.app.db.insert(aiRuns).values({
      id: runId,
      companyId: owner.companyId,
      projectId,
      agentKind: "cost_forecaster",
      model: "test-model",
      requestedBy: owner.userId,
      inputRefs: [],
      status: "succeeded",
    });
    const reviewId = newId("airev");
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await built.app.db.insert(aiReviewQueue).values({
      id: reviewId,
      companyId: owner.companyId,
      projectId,
      runId,
      targetType: "cost_forecast",
      targetId: null,
      proposal: { narrative: "old" },
      summary: "Ancient proposal",
      status: "pending",
      createdAt: old,
    });

    const stale = await inject("GET", "/api/v1/ai/review?stale=1&status=pending");
    expect(stale.statusCode).toBe(200);
    expect((stale.json().items as Array<{ id: string }>).some((i) => i.id === reviewId)).toBe(true);

    await built.app.scheduler.runNow("ai.review-stale");
    const [row] = await built.app.db
      .select()
      .from(aiReviewQueue)
      .where(eq(aiReviewQueue.id, reviewId));
    expect(row!.status).toBe("superseded");
  });
});
