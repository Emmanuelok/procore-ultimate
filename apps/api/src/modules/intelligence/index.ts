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
 *   POST /attention/:id/dismiss · /reopen         ledgered; acting needs `standard` on the project
 *   POST /projects/:projectId/attention/:id/dismiss · /reopen   same, behind the tool gate
 *   GET  /projects/:projectId/health              latest (computed on first read)
 *   POST /projects/:projectId/health/recompute    manual, ledgered
 *   GET  /projects/:projectId/health/history
 *   GET  /projects/:projectId/health/inputs        the loader's raw metrics + reasons (plan §3.5)
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
import { loadHealthInputs } from "./health-inputs.js";
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
  refreshProjectAttention,
  refreshPulse,
  rowToAttention,
  runCompanyRefresh,
  setAttentionStatus,
} from "./service.js";
import { actableProjectIds, canActOnProject, canActWith, canSeeProject, visibleProjectIds } from "./visibility.js";

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
    const [visible, actable] = await Promise.all([visibleProjectIds(app, req), actableProjectIds(app, req)]);
    const pulse = await readPulse(app.db, req.companyId!, new Date(), {
      visible,
      attentionLimit: q.attentionLimit,
      aiEnabled: aiEnabled(app),
    });
    pulse.attention = pulse.attention.map((i) => ({ ...i, canAct: canActWith(actable, i.projectId) }));
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
      storePayload: true,
      payload: {
        trigger: "manual",
        projects: result.projects,
        recomputed: result.recomputed,
        levelChanges: result.levelChanges,
        attention: result.attention,
        truncatedSources: result.truncatedSources,
      },
    });
    return result;
  });

  // Visibility-filtered like /pulse: a caller who sees three of forty projects
  // gets the series for those three, rebuilt from each snapshot's per-project
  // rollup, never the company's mix (plan §6.3).
  app.get("/pulse/history", { preHandler: companyGate }, async (req) => {
    const q = historyQuery.parse(req.query);
    const visible = await visibleProjectIds(app, req);
    const items = await pulseHistory(app.db, req.companyId!, new Date(), q.days, visible);
    return { items, days: q.days, scope: visible === null ? "company" : "visible_projects" };
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
    const [visible, actable] = await Promise.all([visibleProjectIds(app, req), actableProjectIds(app, req)]);
    if (q.projectId && !canSeeProject(visible, q.projectId)) throw forbidden("Project is not visible to you");
    const page = await listAttention(app.db, req.companyId!, {
      visible,
      projectId: q.projectId ?? null,
      status: q.status,
      kind: q.kind,
      severity: q.severity,
      limit: q.limit,
      offset: q.offset,
    });
    return { ...page, items: page.items.map((i) => ({ ...i, canAct: canActWith(actable, i.projectId) })) };
  });

  const loadVisibleItem = async (req: FastifyRequest, projectId?: string) => {
    const { id } = req.params as { id: string };
    const item = await getAttentionItem(app.db, req.companyId!, id);
    if (!item) throw notFound("Attention item not found");
    if (projectId !== undefined) {
      // project-scoped route: the item must belong to the project the gate resolved
      if (item.projectId !== projectId) throw notFound("Attention item not found");
      return item;
    }
    const visible = await visibleProjectIds(app, req);
    if (!canSeeProject(visible, item.projectId)) throw notFound("Attention item not found");
    // Seeing an item is not the same as setting it aside (plan §6.3): a
    // project-scoped item needs `standard` on the project, never company
    // membership alone, and an assurance grant is read-only.
    if (!(await canActOnProject(app, req, item.projectId))) {
      throw forbidden("Requires standard access to intelligence on this project");
    }
    return item;
  };

  const dismiss = async (req: FastifyRequest, item: Awaited<ReturnType<typeof loadVisibleItem>>) => {
    const body = dismissBody.parse(req.body ?? {});
    const updated = await setAttentionStatus(app.db, req.companyId!, item.id, "dismissed", req.user!.id, body.reason ?? null, new Date());
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "attention_item",
      objectId: item.id,
      projectId: item.projectId,
      storePayload: true,
      payload: { from: item.status, to: "dismissed", reason: body.reason ?? null, kind: item.kind, sourceType: item.sourceType, sourceId: item.sourceId },
    });
    return rowToAttention(updated);
  };

  const reopen = async (req: FastifyRequest, item: Awaited<ReturnType<typeof loadVisibleItem>>) => {
    const updated = await setAttentionStatus(app.db, req.companyId!, item.id, "open", req.user!.id, null, new Date());
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "attention_item",
      objectId: item.id,
      projectId: item.projectId,
      storePayload: true,
      payload: { from: item.status, to: "open", kind: item.kind, sourceType: item.sourceType, sourceId: item.sourceId },
    });
    return rowToAttention(updated);
  };

  app.post("/attention/:id/dismiss", { preHandler: companyGate }, async (req) => dismiss(req, await loadVisibleItem(req)));

  app.post("/attention/:id/reopen", { preHandler: companyGate }, async (req) => reopen(req, await loadVisibleItem(req)));

  app.post("/projects/:projectId/attention/:id/dismiss", { preHandler: standardGate }, async (req) =>
    dismiss(req, await loadVisibleItem(req, req.projectId!)),
  );

  app.post("/projects/:projectId/attention/:id/reopen", { preHandler: standardGate }, async (req) =>
    reopen(req, await loadVisibleItem(req, req.projectId!)),
  );

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
      storePayload: true,
      payload: { trigger: "manual", level: result.health.level, score: result.health.score, snapshotId: result.health.snapshotId, previousLevel: result.previousLevel },
    });
    // This project's feed follows its recompute so the two agree — but only
    // this project's: one person's button must not run a company-wide sweep
    // (the scheduler owns that). The Pulse snapshot is a handful of aggregate
    // queries, so it is refreshed here too and the company stays consistent.
    await refreshProjectAttention(app.db, req.companyId!, req.projectId!, now);
    await refreshPulse(app.db, req.companyId!, now);
    return { ...result.health, computedOnRead: false, levelChanged: result.levelChanged, previousLevel: result.previousLevel };
  });

  app.get("/projects/:projectId/health/history", { preHandler: readGate }, async (req) => {
    const q = historyQuery.parse(req.query);
    const items = await listHealthHistory(app.db, req.companyId!, req.projectId!, new Date(), q.days);
    return { items, days: q.days };
  });

  // Plan §3.5 shape — { metrics, reasons } — plus the per-dimension inputs
  // exactly as the engine receives them, so a score can always be traced.
  app.get("/projects/:projectId/health/inputs", { preHandler: readGate }, async (req) => {
    const inputs = await loadHealthInputs(app.db, req.companyId!, req.projectId!, new Date());
    const metrics: Record<string, number | null> = {};
    const { asOf, reasons, ...dims } = inputs;
    for (const [dim, value] of Object.entries(dims)) {
      if (value === null || value === undefined) continue;
      for (const [k, v] of Object.entries(value as unknown as Record<string, unknown>)) {
        if (typeof v === "number") metrics[`${dim}.${k}`] = v;
        else if (v === null) metrics[`${dim}.${k}`] = null;
        else if (v && typeof v === "object") {
          for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
            if (typeof v2 === "number") metrics[`${dim}.${k}.${k2}`] = v2;
          }
        }
      }
    }
    return { asOf, metrics, reasons: Object.values(reasons), inputs: dims, unrated: Object.keys(reasons) };
  });

  app.get("/projects/:projectId/attention", { preHandler: readGate }, async (req) => {
    const q = projectAttentionQuery.parse(req.query);
    const [page, canAct] = await Promise.all([
      listAttention(app.db, req.companyId!, {
        visible: null,
        projectId: req.projectId!,
        status: q.status,
        kind: q.kind,
        severity: q.severity,
        limit: q.limit,
        offset: q.offset,
      }),
      canActOnProject(app, req, req.projectId!),
    ]);
    return { ...page, canAct, items: page.items.map((i) => ({ ...i, canAct })) };
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
