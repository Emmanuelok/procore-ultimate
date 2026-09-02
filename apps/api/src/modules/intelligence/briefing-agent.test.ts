/**
 * The daily briefing with a MOCKED model: proves the pipeline around the
 * model call — evidence assembly, citation reconciliation (uncited claims
 * dropped), review-queue routing of proposals, the audited ai_runs row, the
 * ledger entry and the notification — without a network in the loop.
 * The AI-disabled (503) path lives in intelligence.test.ts.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { aiReviewQueue, aiRuns, ledgerEntries, notifications, projects, pulseBriefings, rfis, signals } from "@constructos/db";
import { loadConfig } from "../../config.js";
import { buildApp } from "../../app.js";
import { registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { intelligenceModule } from "./index.js";
import type { AttentionItem, PulseResponse } from "./types.js";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    beta = { messages: { create: createMock } };
  },
}));

interface ModelReply {
  headline: string;
  summary: string;
  highlights: Array<{ text: string; citations: number[] }>;
  proposedActions: Array<{ title: string; rationale: string; kind: string; attentionRef: number | null; citations: number[] }>;
  citations: number[];
}

function reply(text: string) {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: 120, output_tokens: 80 },
    stop_reason: "end_turn",
  };
}

interface BriefingWire {
  briefing: {
    id: string;
    projectId: string | null;
    runId: string;
    headline: string;
    summary: string;
    highlights: Array<{ text: string; citations: number[] }>;
    citations: Array<{ ref: number; sourceType: string; sourceId: string; label: string }>;
    proposals: Array<{ title: string; kind: string; attentionId: string | null; reviewId: string; citations: unknown[] }>;
    reviewIds: string[];
  };
  reviewIds: string[];
  dropped: { highlights: number; actions: number };
}

let built: Awaited<ReturnType<typeof buildApp>>;
let app: FastifyInstance;
let owner: TestActor;
let projectId: string;
let rfiItem: AttentionItem;

beforeAll(async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "",
    STORAGE_DIR: mkdtempSync(path.join(tmpdir(), "constructos-storage-")),
    AUTH_SECRET: "test-secret-test-secret-test-secret",
    LOG_LEVEL: "silent",
    ANTHROPIC_API_KEY: "test-key-never-used",
  });
  config.DATABASE_URL = undefined;
  built = await buildApp({ config, logger: false });
  app = built.app;
  // Until app.ts wires the module the test registers it; once wired, registering again would duplicate routes and jobs.
  if (!app.scheduler.has("intelligence.health")) await app.register(intelligenceModule, { prefix: "/api/v1" });
  owner = await registerActor(app);
  projectId = newId("prj");
  await app.db.insert(projects).values({ id: projectId, companyId: owner.companyId, name: "Viaduct", stage: "course_of_construction", currency: "EUR" });
  await app.db.insert(rfis).values({
    id: newId("rfi"),
    companyId: owner.companyId,
    projectId,
    number: 7,
    subject: "Bearing detail",
    question: "Which bearing?",
    status: "open",
    dueDate: new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10),
    createdBy: owner.userId,
  });
  await app.db.insert(signals).values({
    id: newId("sig"),
    companyId: owner.companyId,
    projectId,
    detector: "round_number_clustering",
    severity: "high",
    confidence: 0.7,
    title: "Round-number clustering in valuations",
    explanation: "58% of values are round",
    evidenceRefs: [],
  });
  await app.scheduler.runNow("intelligence.health", "interval");
  const feed = (await app.inject({ method: "GET", url: "/api/v1/attention?kind=overdue_rfi", headers: owner.headers })).json() as { items: AttentionItem[] };
  rfiItem = feed.items[0]!;
}, 120_000);

afterAll(async () => {
  await built.close();
}, 60_000);

describe("daily briefing with a mocked model", () => {
  it("writes a cited briefing, drops uncited claims, routes proposals to the review queue and audits everything", async () => {
    createMock.mockImplementationOnce(async (req: { system: string; messages: Array<{ content: string }> }) => {
      // the evidence list numbers attention items first; find the RFI's number from the prompt
      const prompt = req.messages[0]!.content;
      const line = prompt.split("\n").find((l) => l.includes("RFI #7 overdue"))!;
      const ref = Number(/^\[(\d+)\]/.exec(line)![1]);
      expect(req.system).toContain("Never invent figures");
      expect(prompt).toContain("EVIDENCE (cite by number)");
      const out: ModelReply = {
        headline: "Viaduct: one overdue RFI and an integrity signal need a decision",
        summary: "The bearing RFI is five days overdue and valuations show round-number clustering.",
        highlights: [
          { text: `RFI #7 on the bearing detail is 5 days overdue [${ref}]`, citations: [ref] },
          { text: "The weather will be fine tomorrow", citations: [] },
          { text: "A made-up claim with a made-up citation", citations: [999] },
        ],
        proposedActions: [
          { title: "Chase the bearing RFI response", rationale: `Five days overdue [${ref}]`, kind: "escalate", attentionRef: ref, citations: [ref] },
          { title: "Do something uncited", rationale: "no evidence", kind: "other", attentionRef: null, citations: [] },
        ],
        citations: [ref],
      };
      return reply(`Here is the briefing:\n\`\`\`json\n${JSON.stringify(out)}\n\`\`\``);
    });

    const res = await app.inject({ method: "POST", url: "/api/v1/pulse/briefing", headers: owner.headers });
    expect(res.statusCode).toBe(201);
    const body = res.json() as BriefingWire;
    expect(body.briefing.projectId).toBeNull();
    expect(body.briefing.headline).toContain("Viaduct");
    expect(body.briefing.highlights).toHaveLength(1);
    expect(body.dropped).toEqual({ highlights: 2, actions: 1 });
    expect(body.briefing.proposals).toHaveLength(1);
    expect(body.briefing.proposals[0]!.attentionId).toBe(rfiItem.id);
    expect(body.briefing.proposals[0]!.kind).toBe("escalate");
    expect(body.reviewIds).toHaveLength(1);
    expect(body.briefing.citations.map((c) => c.sourceType)).toEqual(["attention_item"]);
    expect(body.briefing.citations[0]!.sourceId).toBe(rfiItem.id);

    // the proposal is a pending review item — nothing self-applied
    const [review] = await app.db.select().from(aiReviewQueue).where(eq(aiReviewQueue.id, body.reviewIds[0]!));
    expect(review?.status).toBe("pending");
    expect(review?.targetType).toBe("attention_action");
    expect(review?.targetId).toBe(rfiItem.id);
    expect(review?.runId).toBe(body.briefing.runId);
    const [item] = await app.db.select().from(aiReviewQueue).where(eq(aiReviewQueue.id, body.reviewIds[0]!));
    expect(item).toBeDefined();

    // the run is audited with the platform's own evidence refs
    const [run] = await app.db.select().from(aiRuns).where(eq(aiRuns.id, body.briefing.runId));
    expect(run?.agentKind).toBe("daily_briefing");
    expect(run?.status).toBe("succeeded");
    expect((run?.inputRefs as Array<{ type: string }>).some((r) => r.type === "attention_item")).toBe(true);

    // stored, ledgered, notified
    const [stored] = await app.db.select().from(pulseBriefings).where(eq(pulseBriefings.id, body.briefing.id));
    expect(stored?.requestedBy).toBe(owner.userId);
    expect((stored?.reviewIds as string[])).toEqual(body.reviewIds);
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.objectType, "pulse_briefing"), eq(ledgerEntries.objectId, body.briefing.id)));
    expect(entries).toHaveLength(1);
    expect((entries[0]!.payload as { proposals: number; droppedHighlights: number }).proposals).toBe(1);
    expect((entries[0]!.payload as { droppedHighlights: number }).droppedHighlights).toBe(2);
    const notes = await app.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, owner.userId), eq(notifications.kind, "agent_proposal")));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.recordId).toBe(body.briefing.id);

    // and the Pulse now carries it, and the feed shows the proposal awaiting review
    const pulse = (await app.inject({ method: "GET", url: "/api/v1/pulse", headers: owner.headers })).json() as PulseResponse;
    expect(pulse.briefing.text).toBe(body.briefing.summary);
    expect(pulse.briefing.runId).toBe(body.briefing.runId);
    expect(pulse.briefing.proposals).toBe(1);
    await app.scheduler.runNow("intelligence.attention");
    const proposals = (await app.inject({ method: "GET", url: "/api/v1/attention?kind=agent_proposal", headers: owner.headers })).json() as { total: number };
    expect(proposals.total).toBe(1);
    const latest = (await app.inject({ method: "GET", url: "/api/v1/pulse/briefing", headers: owner.headers })).json() as { briefing: { id: string } | null; reason: string | null };
    expect(latest.briefing?.id).toBe(body.briefing.id);
    expect(latest.reason).toBeNull();
  });

  it("scopes a project briefing to that project's evidence", async () => {
    createMock.mockImplementationOnce(async (req: { system: string; messages: Array<{ content: string }> }) => {
      expect(req.system).toContain('the project "Viaduct" only');
      const out: ModelReply = {
        headline: "Viaduct today",
        summary: "One RFI overdue.",
        highlights: [{ text: "RFI overdue [1]", citations: [1] }],
        proposedActions: [],
        citations: [1],
      };
      return reply(JSON.stringify(out));
    });
    const res = await app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/intelligence/briefing`, headers: owner.headers });
    expect(res.statusCode).toBe(201);
    const body = res.json() as BriefingWire;
    expect(body.briefing.projectId).toBe(projectId);
    expect(body.reviewIds).toEqual([]);
    const activity = (await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/intelligence/activity`, headers: owner.headers })).json() as {
      runs: Array<{ agentKind: string; citations: number }>;
      briefings: Array<{ id: string }>;
      aiEnabled: boolean;
    };
    expect(activity.aiEnabled).toBe(true);
    expect(activity.briefings.map((b) => b.id)).toContain(body.briefing.id);
    expect(activity.runs.some((r) => r.agentKind === "daily_briefing")).toBe(true);
  });

  it("stores nothing when the model output cannot be parsed", async () => {
    createMock.mockImplementationOnce(async () => reply("I cannot produce JSON today."));
    const before = await app.db.select().from(pulseBriefings).where(eq(pulseBriefings.companyId, owner.companyId));
    const res = await app.inject({ method: "POST", url: "/api/v1/pulse/briefing", headers: owner.headers });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const after = await app.db.select().from(pulseBriefings).where(eq(pulseBriefings.companyId, owner.companyId));
    expect(after.length).toBe(before.length);
    const failed = await app.db.select().from(aiRuns).where(and(eq(aiRuns.companyId, owner.companyId), eq(aiRuns.status, "failed")));
    expect(failed.length).toBe(1);
  });
});
