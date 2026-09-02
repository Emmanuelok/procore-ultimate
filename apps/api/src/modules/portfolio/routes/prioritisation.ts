/**
 * PORTFOLIO PRIORITISATION — the MCDA model, the scores entered under it and
 * the ranking they produce.
 * Spec Vol II Domain G #424 (prioritisation and scoring), #425 (multi-criteria
 * decision analysis with weighting); Vol I §7 #781–#782.
 *
 * The ranking is computed on demand and never stored. A stored rank goes stale
 * the moment another project is scored, and a stale rank presented as current
 * is how a portfolio decision gets taken on last quarter's arithmetic.
 *
 * Two honesty rules the engine enforces and these routes surface:
 *  · a project nobody has scored ranks `null`, not zero — a fabricated zero
 *    reads as "scored badly", which is a different and defamatory claim;
 *  · the influence table says which criteria actually move the ranking, so a
 *    heavily weighted criterion that changes nothing is visible as such.
 *
 * Segregation: the person who scores a project is recorded on the score row.
 * Nothing here approves anything, so no approval can be self-granted.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { z } from "zod";
import { portfolioScores, portfolioScoringModels, projects } from "@constructos/db";
import {
  PORTFOLIO_CRITERION_DIRECTIONS,
  PORTFOLIO_NORMALISATION_METHODS,
  PORTFOLIO_SCORING_MODEL_STATUSES,
} from "@constructos/shared";
import { badRequest, conflict, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { McdaError, parseCriteria, rankPortfolio, type McdaCandidate } from "../mcda.js";
import { visibleProjectIds } from "../service.js";
import {
  assertPortfolio,
  assertProject,
  buildGates,
  idSchema,
  ledger,
  nowISO,
  patchSet,
} from "../shared.js";

const criterionSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9_]+$/i, "A criterion key may contain letters, digits and underscores only"),
  label: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  weight: z.number().finite().min(0).max(1000),
  direction: z.enum(PORTFOLIO_CRITERION_DIRECTIONS).default("benefit"),
  min: z.number().finite().default(0),
  max: z.number().finite().default(10),
});

const modelCreate = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).nullable().optional(),
  portfolioId: idSchema.nullable().optional(),
  criteria: z.array(criterionSchema).min(1).max(50),
  normalisation: z.enum(PORTFOLIO_NORMALISATION_METHODS).default("fixed_scale"),
});

const modelPatch = modelCreate.partial();

const modelList = pageQuerySchema.extend({
  status: z.enum(PORTFOLIO_SCORING_MODEL_STATUSES).optional(),
  portfolioId: idSchema.optional(),
});

const scoreSchema = z.object({
  scores: z.record(z.string().min(1).max(60), z.number().finite()),
  rationale: z.record(z.string().min(1).max(60), z.string().max(4000)).optional(),
  notes: z.string().max(8000).nullable().optional(),
});

const rankingQuery = z.object({
  method: z.enum(PORTFOLIO_NORMALISATION_METHODS).optional(),
  /** include projects with no score row at all, so the gap is visible */
  includeUnscored: z.coerce.boolean().default(true),
});

export const prioritisationRoutes: FastifyPluginAsync = async (app) => {
  const { companyGate, companyAdminGate } = buildGates(app);

  async function fetchModel(id: string, companyId: string) {
    const [row] = await app.db
      .select()
      .from(portfolioScoringModels)
      .where(
        and(eq(portfolioScoringModels.id, id), eq(portfolioScoringModels.companyId, companyId)),
      )
      .limit(1);
    if (!row) throw notFound("Scoring model not found");
    return row;
  }

  /** Parse the stored criteria, turning an engine complaint into a 400. */
  function criteriaOf(raw: unknown) {
    try {
      return parseCriteria(raw);
    } catch (err) {
      if (err instanceof McdaError) throw badRequest(`This scoring model is not usable: ${err.message}`);
      throw err;
    }
  }

  app.get("/portfolio/scoring-models", { preHandler: companyGate }, async (req) => {
    const q = modelList.parse(req.query);
    const clauses: SQL[] = [eq(portfolioScoringModels.companyId, req.companyId!)];
    if (q.status) clauses.push(eq(portfolioScoringModels.status, q.status));
    if (q.portfolioId) clauses.push(eq(portfolioScoringModels.portfolioId, q.portfolioId));
    const where = and(...clauses);
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(portfolioScoringModels)
      .where(where);
    const rows = await app.db
      .select()
      .from(portfolioScoringModels)
      .where(where)
      .orderBy(desc(portfolioScoringModels.status), asc(portfolioScoringModels.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const counts = rows.length
      ? await app.db
          .select({ modelId: portfolioScores.modelId, n: count() })
          .from(portfolioScores)
          .where(
            and(
              eq(portfolioScores.companyId, req.companyId!),
              inArray(
                portfolioScores.modelId,
                rows.map((r) => r.id),
              ),
            ),
          )
          .groupBy(portfolioScores.modelId)
      : [];
    const scored = new Map(counts.map((c) => [c.modelId, Number(c.n)]));
    return paginate(
      rows.map((r) => ({ ...r, scoredProjects: scored.get(r.id) ?? 0 })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.post("/portfolio/scoring-models", { preHandler: companyAdminGate }, async (req, reply) => {
    const body = modelCreate.parse(req.body);
    if (body.portfolioId) await assertPortfolio(app.db, req.companyId!, body.portfolioId);
    criteriaOf(body.criteria);
    const id = newId("psm");
    await app.db.insert(portfolioScoringModels).values({
      id,
      companyId: req.companyId!,
      portfolioId: body.portfolioId ?? null,
      name: body.name,
      description: body.description ?? null,
      criteria: body.criteria,
      normalisation: body.normalisation,
      createdBy: req.user!.id,
    });
    await ledger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "portfolio_scoring_model",
      objectId: id,
      payload: {
        name: body.name,
        criteria: body.criteria.map((c) => ({ key: c.key, weight: c.weight, direction: c.direction })),
        normalisation: body.normalisation,
      },
      storePayload: true,
    });
    return reply.status(201).send(await fetchModel(id, req.companyId!));
  });

  app.get("/portfolio/scoring-models/:modelId", { preHandler: companyGate }, async (req) => {
    const { modelId } = req.params as { modelId: string };
    const model = await fetchModel(modelId, req.companyId!);
    const scores = await app.db
      .select()
      .from(portfolioScores)
      .where(
        and(eq(portfolioScores.companyId, req.companyId!), eq(portfolioScores.modelId, modelId)),
      );
    const projectRows = scores.length
      ? await app.db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(
            and(
              eq(projects.companyId, req.companyId!),
              inArray(
                projects.id,
                scores.map((s) => s.projectId),
              ),
            ),
          )
      : [];
    const nameOf = new Map(projectRows.map((p) => [p.id, p.name]));
    const criteria = criteriaOf(model.criteria);
    const keys = new Set(criteria.map((c) => c.key));
    return {
      ...model,
      scores: scores.map((s) => ({
        ...s,
        projectName: nameOf.get(s.projectId) ?? null,
        /* Keys the model no longer carries: entered under an earlier version
           and now inert. Reported rather than silently dropped. */
        orphanedKeys: Object.keys(s.scores).filter((k) => !keys.has(k)),
      })),
    };
  });

  /**
   * Editing a model. Changing the criteria of a model that already carries
   * scores does not silently invalidate them — the version increments, the
   * change is ledgered, and the ranking response names every score entry that
   * no longer matches a criterion.
   */
  app.patch("/portfolio/scoring-models/:modelId", { preHandler: companyAdminGate }, async (req) => {
    const { modelId } = req.params as { modelId: string };
    const body = modelPatch.parse(req.body);
    const model = await fetchModel(modelId, req.companyId!);
    if (model.status === "archived") {
      throw conflict("An archived scoring model is a record of a past decision and is not editable.");
    }
    if (body.portfolioId) await assertPortfolio(app.db, req.companyId!, body.portfolioId);
    const set = patchSet(body as Record<string, unknown>);
    if (body.criteria) {
      criteriaOf(body.criteria);
      set["version"] = model.version + 1;
    }
    await app.db
      .update(portfolioScoringModels)
      .set(set)
      .where(eq(portfolioScoringModels.id, modelId));
    await ledger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "portfolio_scoring_model",
      objectId: modelId,
      payload: {
        changed: Object.keys(body),
        version: body.criteria ? { from: model.version, to: model.version + 1 } : undefined,
      },
      storePayload: Boolean(body.criteria),
    });
    return fetchModel(modelId, req.companyId!);
  });

  const statusSchema = z.object({ status: z.enum(["active", "archived", "draft"]) });

  app.post(
    "/portfolio/scoring-models/:modelId/status",
    { preHandler: companyAdminGate },
    async (req) => {
      const { modelId } = req.params as { modelId: string };
      const body = statusSchema.parse(req.body);
      const model = await fetchModel(modelId, req.companyId!);
      if (model.status === body.status) return model;
      if (model.status === "archived") {
        throw conflict("An archived model cannot be reopened; clone it into a new model instead.");
      }
      if (body.status === "active") criteriaOf(model.criteria);
      await app.db
        .update(portfolioScoringModels)
        .set({ status: body.status, updatedAt: nowISO() })
        .where(eq(portfolioScoringModels.id, modelId));
      await ledger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "portfolio_scoring_model",
        objectId: modelId,
        payload: { from: model.status, to: body.status },
        storePayload: true,
      });
      return fetchModel(modelId, req.companyId!);
    },
  );

  /** Enter or replace one project's raw scores under a model. */
  app.put(
    "/portfolio/scoring-models/:modelId/scores/:projectId",
    { preHandler: companyAdminGate },
    async (req) => {
      const { modelId, projectId } = req.params as { modelId: string; projectId: string };
      const body = scoreSchema.parse(req.body);
      const model = await fetchModel(modelId, req.companyId!);
      if (model.status === "archived") {
        throw conflict("An archived model cannot receive new scores.");
      }
      await assertProject(app.db, req.companyId!, projectId);
      const criteria = criteriaOf(model.criteria);
      const keys = new Set(criteria.map((c) => c.key));
      const unknown = Object.keys(body.scores).filter((k) => !keys.has(k));
      if (unknown.length > 0) {
        throw badRequest(
          `The model has no criterion named ${unknown.join(", ")}. Scoring against a criterion that does not exist would silently do nothing.`,
        );
      }

      const [existing] = await app.db
        .select()
        .from(portfolioScores)
        .where(
          and(
            eq(portfolioScores.companyId, req.companyId!),
            eq(portfolioScores.modelId, modelId),
            eq(portfolioScores.projectId, projectId),
          ),
        )
        .limit(1);

      const at = nowISO();
      const id = existing?.id ?? newId("psc");
      if (existing) {
        await app.db
          .update(portfolioScores)
          .set({
            scores: body.scores,
            rationale: body.rationale ?? {},
            notes: body.notes ?? null,
            scoredBy: req.user!.id,
            scoredAt: at,
            updatedAt: at,
          })
          .where(eq(portfolioScores.id, existing.id));
      } else {
        await app.db.insert(portfolioScores).values({
          id,
          companyId: req.companyId!,
          modelId,
          projectId,
          scores: body.scores,
          rationale: body.rationale ?? {},
          notes: body.notes ?? null,
          scoredBy: req.user!.id,
          scoredAt: at,
        });
      }
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId,
        actorId: req.user!.id,
        action: existing ? "update" : "create",
        objectType: "portfolio_score",
        objectId: id,
        payload: { modelId, projectId, scores: body.scores, modelVersion: model.version },
        storePayload: true,
      });
      const [row] = await app.db
        .select()
        .from(portfolioScores)
        .where(eq(portfolioScores.id, id))
        .limit(1);
      return row;
    },
  );

  app.delete(
    "/portfolio/scoring-models/:modelId/scores/:projectId",
    { preHandler: companyAdminGate },
    async (req, reply) => {
      const { modelId, projectId } = req.params as { modelId: string; projectId: string };
      await fetchModel(modelId, req.companyId!);
      const [row] = await app.db
        .select()
        .from(portfolioScores)
        .where(
          and(
            eq(portfolioScores.companyId, req.companyId!),
            eq(portfolioScores.modelId, modelId),
            eq(portfolioScores.projectId, projectId),
          ),
        )
        .limit(1);
      if (!row) throw notFound("This project has not been scored under that model");
      await app.db.delete(portfolioScores).where(eq(portfolioScores.id, row.id));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId,
        actorId: req.user!.id,
        action: "delete",
        objectType: "portfolio_score",
        objectId: row.id,
        payload: { modelId, projectId, scores: row.scores },
        storePayload: true,
      });
      return reply.status(204).send();
    },
  );

  /**
   * The ranking (#424). Computed here, now, from the criteria and the scores
   * as they stand. Candidates are the projects the caller may see; unscored
   * projects are included by default so the coverage gap is visible on the
   * page rather than hidden by the filter that produced the list.
   */
  app.get("/portfolio/scoring-models/:modelId/ranking", { preHandler: companyGate }, async (req) => {
    const { modelId } = req.params as { modelId: string };
    const q = rankingQuery.parse(req.query);
    const model = await fetchModel(modelId, req.companyId!);
    const criteria = criteriaOf(model.criteria);
    const method = q.method ?? (model.normalisation as "fixed_scale" | "relative");

    const visible = await visibleProjectIds(app.db, req.companyId!, req.user!.id, req.companyRole);
    const projectClauses: SQL[] = [
      eq(projects.companyId, req.companyId!),
      isNull(projects.deletedAt),
      eq(projects.isSandbox, 0),
      eq(projects.isTemplate, 0),
    ];
    if (model.portfolioId) projectClauses.push(eq(projects.portfolioId, model.portfolioId));
    if (visible !== null) {
      if (visible.length === 0) {
        return {
          modelId,
          modelName: model.name,
          modelVersion: model.version,
          method,
          run: null,
          reasons: ["You are not a member of any project, so no candidate can be ranked."],
          generatedAt: nowISO(),
        };
      }
      projectClauses.push(inArray(projects.id, visible));
    }
    const projectRows = await app.db
      .select({ id: projects.id, name: projects.name, stage: projects.stage })
      .from(projects)
      .where(and(...projectClauses));

    const scores = await app.db
      .select()
      .from(portfolioScores)
      .where(
        and(eq(portfolioScores.companyId, req.companyId!), eq(portfolioScores.modelId, modelId)),
      );
    const scoreOf = new Map(scores.map((s) => [s.projectId, s]));
    const keys = new Set(criteria.map((c) => c.key));
    const orphaned: Array<{ projectId: string; keys: string[] }> = [];

    const candidates: McdaCandidate[] = projectRows
      .filter((p) => q.includeUnscored || scoreOf.has(p.id))
      .map((p) => {
        const row = scoreOf.get(p.id);
        if (row) {
          const stale = Object.keys(row.scores).filter((k) => !keys.has(k));
          if (stale.length > 0) orphaned.push({ projectId: p.id, keys: stale });
        }
        return {
          projectId: p.id,
          projectName: p.name,
          scores: row?.scores ?? {},
          rationale: row?.rationale ?? {},
        };
      });

    const reasons: string[] = [];
    const unscored = candidates.filter((c) => Object.keys(c.scores).length === 0).length;
    if (unscored > 0) {
      reasons.push(
        `${unscored} of ${candidates.length} candidate project(s) carry no score under this model and are ranked "not scored" rather than last.`,
      );
    }
    if (orphaned.length > 0) {
      reasons.push(
        `${orphaned.length} project(s) hold entries against criteria this model no longer carries (version ${model.version}); those entries are ignored.`,
      );
    }
    if (model.status !== "active") {
      reasons.push(`This model is ${model.status}; the ranking is indicative only.`);
    }

    const run = rankPortfolio(criteria, candidates, method);
    const stageOf = new Map(projectRows.map((p) => [p.id, p.stage]));
    return {
      modelId,
      modelName: model.name,
      modelVersion: model.version,
      modelStatus: model.status,
      method,
      run: {
        ...run,
        ranked: run.ranked.map((r) => ({ ...r, stage: stageOf.get(r.projectId) ?? null })),
      },
      orphanedEntries: orphaned,
      reasons,
      generatedAt: nowISO(),
    };
  });
};
