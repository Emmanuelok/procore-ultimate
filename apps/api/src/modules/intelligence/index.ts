/**
 * Intelligence module — project health, the attention feed, the company
 * Pulse and the daily briefing (Vol I §6.1–6.3 #731–758, §7 #776–789;
 * Vol II X #1010–1012, #1017–1018). Cross-package contract: plan §3.1.
 *
 * Routes
 *   GET  /pulse                                   the one read the Pulse page makes
 *   POST /pulse/refresh                           admin: recompute everything now
 *   GET  /pulse/history?days=                     portfolio health over time
 *   GET  /pulse/activity                          recent agent runs + pending proposals
 *   GET  /pulse/briefing · GET /pulse/briefings   latest / recent company briefings
 *   POST /pulse/briefing                          AI (503 AiDisabled without a key)
 *   GET  /attention?projectId=&limit=…            ranked feed, visibility-filtered
 *   POST /attention/:id/dismiss · /reopen         ledgered
 *   GET  /projects/:projectId/health              latest (computed on first read)
 *   POST /projects/:projectId/health/recompute    manual, ledgered
 *   GET  /projects/:projectId/health/history
 *   GET  /projects/:projectId/attention
 *   GET  /projects/:projectId/intelligence/activity
 *   GET/POST /projects/:projectId/intelligence/briefing(s)
 *
 * Jobs (plan §6.1): intelligence.health (15 min, boot), intelligence.attention
 * (5 min), intelligence.event-recompute (1 min — drains the projects the
 * ledger hook marked dirty, so a burst of events costs one recompute).
 *
 * Deliberately not here: predictions (analytics), automation rules
 * (automation), the agent fleet (ai). Nothing non-AI depends on the key.
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, count, desc, eq, isNull, or, inArray } from "drizzle-orm";
import { z } from "zod";
import { aiReviewQueue, aiRuns, companies, projects, pulseBriefings } from "@constructos/db";
import { ATTENTION_SEVERITIES, ATTENTION_STATUSES } from "@constructos/shared";
import { forbidden, notFound } from "../../lib/errors.js";
import { addLedgerEmitHook, appendLedger } from "../../lib/ledger.js";
import { forEachCompany } from "../../lib/scheduler.js";
import { aiEnabled } from "../ai/service.js";
import { generateBriefing } from "./briefing.js";
import {
  computeProjectHealth,
  drainDirtyProjects,
  getAttentionItem,
  getOrComputeHealth,
  latestBriefing,
  listAttention,
  listCompanyProjects,
  listHealthHistory,
  markProjectDirty,
  pulseHistory,
  readPulse,
  refreshAttention,
  refreshPulse,
  rowToAttention,
  runCompanyRefresh,
  setAttentionStatus,
} from "./service.js";
import { canSeeProject, visibleProjectIds } from "./visibility.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const pulseQuery = z.object({
  attentionLimit: z.coerce.number().int().min(1).max(200).default(25),
});

const attentionQuery = z.object({
  projectId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  kind: z.string().min(1).max(60).optional(),
  severity: z.enum(ATTENTION_SEVERITIES).optional(),
  status: z.enum(ATTENTION_STATUSES).default("open"),
});

const projectAttentionQuery = attentionQuery.omit({ projectId: true });

const dismissBody = z.object({
  reason: z.string().max(1000).optional(),
});

const historyQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

export const intelligenceModule: FastifyPluginAsync = async (app) => {
  const companyGate = [app.authenticate, app.requireCompany];
  const adminGate = [app.authenticate, app.requireCompany, app.requireCompanyRole(["owner", "admin"])];
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("intelligence", "read")];
  const standardGate = [app.authenticate, app.requireCompany, app.requireTool("intelligence", "standard")];

  const companyName = async (companyId: string): Promise<string | null> => {
    const [row] = await app.db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1);
    return row?.name ?? null;
  };

  const projectName = async (companyId: string, projectId: string): Promise<string | null> => {
    const [row] = await app.db
      .select({ name: projects.name })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    return row?.name ?? null;
  };

  const briefingView = (row: typeof pulseBriefings.$inferSelect) => ({
    id: row.id,
    projectId: row.projectId,
    runId: row.runId,
    headline: row.headline,
    summary: row.summary,
    highlights: row.highlights,
    citations: row.citations,
    proposals: row.proposals,
    reviewIds: row.reviewIds,
    requestedBy: row.requestedBy,
    generatedAt: new Date(row.generatedAt).toISOString(),
  });

  /* ---------------------------------------------------------------- */
  /* Company Pulse                                                     */
  /* ---------------------------------------------------------------- */

  app.get("/pulse", { preHandler: companyGate }, async (req) => {
    const q = pulseQuery.parse(req.query);
    const visible = await visibleProjectIds(app, req);
    const pulse = await readPulse(app.db, req.companyId!, new Date(), {
      visible,
      attentionLimit: q.attentionLimit,
      aiEnabled: aiEnabled(app),
    });
    // A company-wide briefing is written over every project; a caller who
    // can only see some of them gets the reason, not the text.
    if (visible !== null && pulse.briefing.text !== null) {
      pulse.briefing = { text: null, runId: null, reason: "restricted_scope", id: null, generatedAt: null, headline: null, proposals: 0 };
    }
    return pulse;
  });

  app.post("/pulse/refresh", { preHandler: adminGate }, async (req) => {
    const now = new Date();
    const result = await runCompanyRefresh(app.db, req.companyId!, now, "manual");
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "pulse_snapshot",
      objectId: result.pulseId,
      payload: { trigger: "manual", projects: result.projects, recomputed: result.recomputed, levelChanges: result.levelChanges, attention: result.attention },
    });
    return result;
  });

  app.get("/pulse/history", { preHandler: companyGate }, async (req) => {
    const q = historyQuery.parse(req.query);
    const items = await pulseHistory(app.db, req.companyId!, new Date(), q.days);
    return { items, days: q.days };
  });

  app.get("/pulse/activity", { preHandler: companyGate }, async (req) => {
    const q = listQuery.parse(req.query);
    const visible = await visibleProjectIds(app, req);
    const scope = (col: typeof aiRuns.projectId | typeof aiReviewQueue.projectId) => {
      if (visible === null) return undefined;
      const ids = [...visible];
      return ids.length === 0 ? isNull(col) : or(isNull(col), inArray(col, ids));
    };
    const [runs, pending] = await Promise.all([
      app.db
        .select({
          id: aiRuns.id,
          projectId: aiRuns.projectId,
          agentKind: aiRuns.agentKind,
          status: aiRuns.status,
          model: aiRuns.model,
          latencyMs: aiRuns.latencyMs,
          requestedBy: aiRuns.requestedBy,
          createdAt: aiRuns.createdAt,
          citations: aiRuns.citations,
        })
        .from(aiRuns)
        .where(and(eq(aiRuns.companyId, req.companyId!), scope(aiRuns.projectId)))
        .orderBy(desc(aiRuns.createdAt))
        .limit(q.limit),
      app.db
        .select({ n: count() })
        .from(aiReviewQueue)
        .where(and(eq(aiReviewQueue.companyId, req.companyId!), eq(aiReviewQueue.status, "pending"), scope(aiReviewQueue.projectId))),
    ]);
    return {
      runs: runs.map((r) => ({ ...r, citations: Array.isArray(r.citations) ? r.citations.length : 0, createdAt: new Date(r.createdAt).toISOString() })),
      pendingProposals: Number(pending[0]?.n ?? 0),
      aiEnabled: aiEnabled(app),
    };
  });

  app.get("/pulse/briefing", { preHandler: companyGate }, async (req) => {
    const visible = await visibleProjectIds(app, req);
    if (visible !== null) return { briefing: null, reason: "restricted_scope", aiEnabled: aiEnabled(app) };
    const row = await latestBriefing(app.db, req.companyId!, null);
    return { briefing: row ? briefingView(row) : null, reason: row ? null : aiEnabled(app) ? "never_generated" : "ai_disabled", aiEnabled: aiEnabled(app) };
  });

  app.get("/pulse/briefings", { preHandler: companyGate }, async (req) => {
    const q = listQuery.parse(req.query);
    const visible = await visibleProjectIds(app, req);
    if (visible !== null) return { items: [], reason: "restricted_scope" };
    const rows = await app.db
      .select()
      .from(pulseBriefings)
      .where(and(eq(pulseBriefings.companyId, req.companyId!), isNull(pulseBriefings.projectId)))
      .orderBy(desc(pulseBriefings.generatedAt))
      .limit(q.limit);
    return { items: rows.map(briefingView), reason: null };
  });

  app.post("/pulse/briefing", { preHandler: adminGate }, async (req, reply) => {
    const now = new Date();
    const pulse = await readPulse(app.db, req.companyId!, now, { visible: null, attentionLimit: 50, aiEnabled: aiEnabled(app) });
    const result = await generateBriefing(app, req, {
      projectId: null,
      companyName: await companyName(req.companyId!),
      pulse,
      now,
    });
    return reply.status(201).send({ briefing: briefingView(result.briefing), reviewIds: result.reviewIds, dropped: result.dropped });
  });

  /* ---------------------------------------------------------------- */
  /* Attention feed                                                    */
  /* ---------------------------------------------------------------- */

  app.get("/attention", { preHandler: companyGate }, async (req) => {
    const q = attentionQuery.parse(req.query);
    const visible = await visibleProjectIds(app, req);
    if (q.projectId && !canSeeProject(visible, q.projectId)) throw forbidden("Project is not visible to you");
    return listAttention(app.db, req.companyId!, {
      visible,
      projectId: q.projectId ?? null,
      status: q.status,
      kind: q.kind,
      severity: q.severity,
      limit: q.limit,
      offset: q.offset,
    });
  });

  const loadVisibleItem = async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const item = await getAttentionItem(app.db, req.companyId!, id);
    if (!item) throw notFound("Attention item not found");
    const visible = await visibleProjectIds(app, req);
    if (!canSeeProject(visible, item.projectId)) throw notFound("Attention item not found");
    return item;
  };

  app.post("/attention/:id/dismiss", { preHandler: companyGate }, async (req) => {
    const body = dismissBody.parse(req.body ?? {});
    const item = await loadVisibleItem(req);
    const now = new Date();
    const updated = await setAttentionStatus(app.db, req.companyId!, item.id, "dismissed", req.user!.id, body.reason ?? null, now);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "attention_item",
      objectId: item.id,
      projectId: item.projectId,
      payload: { from: item.status, to: "dismissed", reason: body.reason ?? null, kind: item.kind, sourceType: item.sourceType, sourceId: item.sourceId },
    });
    return rowToAttention(updated);
  });

  app.post("/attention/:id/reopen", { preHandler: companyGate }, async (req) => {
    const item = await loadVisibleItem(req);
    const updated = await setAttentionStatus(app.db, req.companyId!, item.id, "open", req.user!.id, null, new Date());
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "attention_item",
      objectId: item.id,
      projectId: item.projectId,
      payload: { from: item.status, to: "open", kind: item.kind, sourceType: item.sourceType, sourceId: item.sourceId },
    });
    return rowToAttention(updated);
  });

  /* ---------------------------------------------------------------- */
  /* Project health                                                    */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/health", { preHandler: readGate }, async (req) => {
    const { health, computedOnRead } = await getOrComputeHealth(app.db, req.companyId!, req.projectId!, new Date());
    return { ...health, computedOnRead };
  });

  app.post("/projects/:projectId/health/recompute", { preHandler: standardGate }, async (req) => {
    const now = new Date();
    const result = await computeProjectHealth(app.db, req.companyId!, req.projectId!, now, "manual", { actorId: req.user!.id });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "project_health",
      objectId: req.projectId!,
      projectId: req.projectId!,
      payload: { trigger: "manual", level: result.health.level, score: result.health.score, snapshotId: result.health.snapshotId, previousLevel: result.previousLevel },
    });
    // the feed and the company snapshot follow the recompute so the Pulse agrees with the project page
    const projectList = await listCompanyProjects(app.db, req.companyId!);
    await refreshAttention(app.db, req.companyId!, projectList, now);
    await refreshPulse(app.db, req.companyId!, now);
    return { ...result.health, computedOnRead: false, levelChanged: result.levelChanged, previousLevel: result.previousLevel };
  });

  app.get("/projects/:projectId/health/history", { preHandler: readGate }, async (req) => {
    const q = historyQuery.parse(req.query);
    const items = await listHealthHistory(app.db, req.companyId!, req.projectId!, new Date(), q.days);
    return { items, days: q.days };
  });

  app.get("/projects/:projectId/attention", { preHandler: readGate }, async (req) => {
    const q = projectAttentionQuery.parse(req.query);
    return listAttention(app.db, req.companyId!, {
      visible: null,
      projectId: req.projectId!,
      status: q.status,
      kind: q.kind,
      severity: q.severity,
      limit: q.limit,
      offset: q.offset,
    });
  });

  /* ---------------------------------------------------------------- */
  /* Project intelligence — agent activity and briefings               */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/intelligence/activity", { preHandler: readGate }, async (req) => {
    const q = listQuery.parse(req.query);
    const [runs, pending, briefings] = await Promise.all([
      app.db
        .select({
          id: aiRuns.id,
          agentKind: aiRuns.agentKind,
          status: aiRuns.status,
          model: aiRuns.model,
          latencyMs: aiRuns.latencyMs,
          requestedBy: aiRuns.requestedBy,
          createdAt: aiRuns.createdAt,
          citations: aiRuns.citations,
        })
        .from(aiRuns)
        .where(and(eq(aiRuns.companyId, req.companyId!), eq(aiRuns.projectId, req.projectId!)))
        .orderBy(desc(aiRuns.createdAt))
        .limit(q.limit),
      app.db
        .select({ n: count() })
        .from(aiReviewQueue)
        .where(and(eq(aiReviewQueue.companyId, req.companyId!), eq(aiReviewQueue.projectId, req.projectId!), eq(aiReviewQueue.status, "pending"))),
      app.db
        .select()
        .from(pulseBriefings)
        .where(and(eq(pulseBriefings.companyId, req.companyId!), eq(pulseBriefings.projectId, req.projectId!)))
        .orderBy(desc(pulseBriefings.generatedAt))
        .limit(5),
    ]);
    return {
      runs: runs.map((r) => ({ ...r, citations: Array.isArray(r.citations) ? r.citations.length : 0, createdAt: new Date(r.createdAt).toISOString() })),
      pendingProposals: Number(pending[0]?.n ?? 0),
      briefings: briefings.map(briefingView),
      aiEnabled: aiEnabled(app),
    };
  });

  app.get("/projects/:projectId/intelligence/briefing", { preHandler: readGate }, async (req) => {
    const row = await latestBriefing(app.db, req.companyId!, req.projectId!);
    return { briefing: row ? briefingView(row) : null, reason: row ? null : aiEnabled(app) ? "never_generated" : "ai_disabled", aiEnabled: aiEnabled(app) };
  });

  app.post("/projects/:projectId/intelligence/briefing", { preHandler: standardGate }, async (req, reply) => {
    const now = new Date();
    const pulse = await readPulse(app.db, req.companyId!, now, {
      visible: new Set([req.projectId!]),
      attentionLimit: 50,
      aiEnabled: aiEnabled(app),
    });
    const result = await generateBriefing(app, req, {
      projectId: req.projectId!,
      projectName: await projectName(req.companyId!, req.projectId!),
      companyName: await companyName(req.companyId!),
      pulse,
      now,
    });
    return reply.status(201).send({ briefing: briefingView(result.briefing), reviewIds: result.reviewIds, dropped: result.dropped });
  });

  /* ---------------------------------------------------------------- */
  /* Jobs (plan §6.1) and the ledger hook                              */
  /* ---------------------------------------------------------------- */

  app.scheduler.register({
    name: "intelligence.health",
    description: "Recompute every project's health, refresh the attention feed and take the company Pulse snapshot",
    everyMs: 15 * 60_000,
    runOnBoot: true,
    run: async ({ db, now, reason }) =>
      forEachCompany(db, (companyId) => runCompanyRefresh(db, companyId, now, reason === "boot" ? "boot" : reason === "manual" ? "manual" : "interval")),
  });

  app.scheduler.register({
    name: "intelligence.attention",
    description: "Refresh the attention feed (deadline urgency moves between health sweeps) and the Pulse snapshot",
    everyMs: 5 * 60_000,
    run: async ({ db, now }) =>
      forEachCompany(db, async (companyId) => {
        const projectList = await listCompanyProjects(db, companyId);
        const attention = await refreshAttention(db, companyId, projectList, now);
        await refreshPulse(db, companyId, now);
        return attention;
      }),
  });

  app.scheduler.register({
    name: "intelligence.event-recompute",
    description: "Recompute health for projects the ledger touched since the last minute (throttled event-driven recompute)",
    everyMs: 60_000,
    run: async ({ db, now }) => drainDirtyProjects(db, now),
  });

  const unsubscribe = addLedgerEmitHook(app.db, (event) => {
    if (!event.projectId) return;
    markProjectDirty(app.db, event.companyId, event.projectId, event.objectType, event.action);
  });
  app.addHook("onClose", async () => {
    unsubscribe();
  });
};
