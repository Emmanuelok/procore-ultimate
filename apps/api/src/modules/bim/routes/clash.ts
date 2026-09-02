/**
 * Clash detection register (spec #240; Domain T #908).
 *
 * A clash test names two element sets (by discipline, IfcType or explicit
 * model versions), a tolerance and a clearance. Running it refreshes the
 * result register in place, so the same physical clash keeps its identity
 * across runs: `new` on first sight, `active` while it persists, `resolved`
 * automatically when a later run no longer finds it, and `approved`/`ignored`
 * when a coordinator signs it off. That is what makes the register a record
 * of resolution over time instead of a list that resets on every run.
 *
 * Results carry the method that produced them (`aabb_broad_phase`) and the
 * count of elements excluded for having no extents, because a clash count
 * that hides its coverage is worse than no clash count.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  bimElements,
  bimModelVersions,
  bimModels,
  clashResults,
  clashTests,
  coordinationIssues,
  federationMembers,
} from "@constructos/db";
import { CLASH_RULE_KINDS, CLASH_STATUSES, DRAWING_DISCIPLINES } from "@constructos/shared";
import { newId } from "../../../lib/ids.js";
import { badRequest, conflict, notFound } from "../../../lib/errors.js";
import { nextRecordNumber } from "../../../lib/numbering.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { detectClashes, type ClashElement } from "../clash.js";
import { buildBimGates, buildLoaders, closeSignal, ledger, nowISO, raiseSignal } from "../shared.js";

const filterSchema = z
  .object({
    disciplines: z.array(z.enum(DRAWING_DISCIPLINES)).max(20).optional(),
    ifcTypes: z.array(z.string().max(60)).max(50).optional(),
    modelVersionIds: z.array(z.string().max(64)).max(50).optional(),
  })
  .default({});

const testCreateSchema = z.object({
  name: z.string().min(1).max(200),
  federationId: z.string().max(64).nullable().optional(),
  ruleKind: z.enum(CLASH_RULE_KINDS).optional(),
  leftFilter: filterSchema.optional(),
  rightFilter: filterSchema.optional(),
  toleranceMm: z.number().min(0).max(5000).optional(),
  clearanceMm: z.number().min(0).max(5000).optional(),
});

const testPatchSchema = testCreateSchema.partial();

const resultListQuery = pageQuerySchema.extend({
  status: z.enum(CLASH_STATUSES).optional(),
  storey: z.string().max(200).optional(),
  kind: z.enum(["hard", "clearance", "duplicate"]).optional(),
});

const resultPatchSchema = z.object({
  status: z.enum(CLASH_STATUSES),
  notes: z.string().max(2000).optional(),
});

const raiseIssueSchema = z.object({
  resultIds: z.array(z.string().max(64)).min(1).max(200),
  title: z.string().min(1).max(300).optional(),
  assigneeId: z.string().max(64).nullable().optional(),
  discipline: z.enum(DRAWING_DISCIPLINES).nullable().optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});

export const clashRoutes: FastifyPluginAsync = async (app) => {
  const gates = buildBimGates(app);
  const { getClashTest } = buildLoaders(app);

  /* ---------------------------------------------------------------- */
  /* Element selection                                                 */
  /* ---------------------------------------------------------------- */

  interface Selector {
    disciplines?: string[];
    ifcTypes?: string[];
    modelVersionIds?: string[];
  }

  /** Versions in scope: the federation's members, or the whole project. */
  async function scopeVersionIds(
    companyId: string,
    projectId: string,
    federationId: string | null,
  ): Promise<string[]> {
    if (federationId) {
      const rows = await app.db
        .select({ id: bimModelVersions.id })
        .from(federationMembers)
        .innerJoin(bimModelVersions, eq(bimModelVersions.id, federationMembers.modelVersionId))
        .innerJoin(bimModels, eq(bimModels.id, bimModelVersions.modelId))
        .where(
          and(
            eq(federationMembers.groupId, federationId),
            eq(bimModels.companyId, companyId),
            eq(bimModels.projectId, projectId),
          ),
        );
      return rows.map((r) => r.id);
    }
    const rows = await app.db
      .select({ id: bimModels.currentVersionId })
      .from(bimModels)
      .where(and(eq(bimModels.companyId, companyId), eq(bimModels.projectId, projectId)));
    return rows.map((r) => r.id).filter((id): id is string => id !== null);
  }

  async function loadElements(
    companyId: string,
    projectId: string,
    versionIds: string[],
    selector: Selector,
  ): Promise<ClashElement[]> {
    const scoped = selector.modelVersionIds?.length
      ? versionIds.filter((id) => selector.modelVersionIds!.includes(id))
      : versionIds;
    if (scoped.length === 0) return [];
    // elements WITHOUT extents are loaded too: the engine counts them as
    // excluded so the run can report its own coverage instead of hiding it
    const conds = [
      eq(bimElements.projectId, projectId),
      inArray(bimElements.modelVersionId, scoped),
      eq(bimModels.companyId, companyId),
    ];
    if (selector.disciplines?.length) {
      conds.push(inArray(bimModels.discipline, selector.disciplines));
    }
    const rows = await app.db
      .select({
        globalId: bimElements.globalId,
        ifcType: bimElements.ifcType,
        name: bimElements.name,
        storey: bimElements.storey,
        modelVersionId: bimElements.modelVersionId,
        discipline: bimModels.discipline,
        minX: bimElements.minX,
        minY: bimElements.minY,
        minZ: bimElements.minZ,
        maxX: bimElements.maxX,
        maxY: bimElements.maxY,
        maxZ: bimElements.maxZ,
      })
      .from(bimElements)
      .innerJoin(bimModelVersions, eq(bimModelVersions.id, bimElements.modelVersionId))
      .innerJoin(bimModels, eq(bimModels.id, bimModelVersions.modelId))
      .where(and(...conds))
      .limit(100_000);

    const typePrefixes = (selector.ifcTypes ?? []).map((t) => t.toUpperCase());
    return rows
      .filter(
        (r) =>
          typePrefixes.length === 0 || typePrefixes.some((p) => r.ifcType.toUpperCase().startsWith(p)),
      )
      .map((r) => ({
        globalId: r.globalId,
        ifcType: r.ifcType,
        name: r.name,
        discipline: r.discipline,
        modelVersionId: r.modelVersionId,
        storey: r.storey,
        bounds:
          r.minX === null || r.minY === null || r.minZ === null || r.maxX === null || r.maxY === null || r.maxZ === null
            ? null
            : {
                minX: r.minX,
                minY: r.minY,
                minZ: r.minZ,
                maxX: r.maxX,
                maxY: r.maxY,
                maxZ: r.maxZ,
              },
      }));
  }

  /* ---------------------------------------------------------------- */
  /* Tests                                                             */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/bim/clash-tests", { preHandler: gates.readGate }, async (req) => {
    const items = await app.db
      .select()
      .from(clashTests)
      .where(
        and(
          eq(clashTests.companyId, req.companyId!),
          eq(clashTests.projectId, req.projectId!),
        ),
      )
      .orderBy(asc(clashTests.name))
      .limit(200);
    const counts = await app.db
      .select({ testId: clashResults.testId, status: clashResults.status, n: count() })
      .from(clashResults)
      .where(
        and(
          eq(clashResults.companyId, req.companyId!),
          eq(clashResults.projectId, req.projectId!),
        ),
      )
      .groupBy(clashResults.testId, clashResults.status);
    return {
      items: items.map((t) => ({
        ...t,
        counts: Object.fromEntries(
          counts.filter((c) => c.testId === t.id).map((c) => [c.status, Number(c.n)]),
        ),
      })),
      total: items.length,
    };
  });

  app.post(
    "/projects/:projectId/bim/clash-tests",
    { preHandler: gates.standardGate },
    async (req, reply) => {
      const body = testCreateSchema.parse(req.body);
      if (body.federationId) {
        const rows = await app.db
          .select({ id: federationMembers.groupId })
          .from(federationMembers)
          .where(eq(federationMembers.groupId, body.federationId))
          .limit(1);
        if (!rows[0]) {
          throw badRequest("Federation has no members — add model versions to it first");
        }
      }
      const id = newId("clt");
      const [created] = await app.db
        .insert(clashTests)
        .values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          federationId: body.federationId ?? null,
          name: body.name,
          ruleKind: body.ruleKind ?? "discipline_pair",
          leftFilter: body.leftFilter ?? {},
          rightFilter: body.rightFilter ?? {},
          toleranceMm: body.toleranceMm ?? 10,
          clearanceMm: body.clearanceMm ?? 0,
          createdBy: req.user!.id,
        })
        .returning();
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "clash_test",
        objectId: id,
        payload: created,
      });
      return reply.status(201).send(created);
    },
  );

  app.patch(
    "/projects/:projectId/bim/clash-tests/:testId",
    { preHandler: gates.standardGate },
    async (req) => {
      const { testId } = req.params as { testId: string };
      const test = await getClashTest(testId, req.companyId!);
      if (test.projectId !== req.projectId) throw notFound("Clash test not found");
      const body = testPatchSchema.parse(req.body);
      const patch: Record<string, unknown> = { updatedAt: nowISO() };
      for (const key of [
        "name",
        "federationId",
        "ruleKind",
        "leftFilter",
        "rightFilter",
        "toleranceMm",
        "clearanceMm",
      ] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (Object.keys(patch).length === 1) throw badRequest("Nothing to update");
      const [updated] = await app.db
        .update(clashTests)
        .set(patch)
        .where(eq(clashTests.id, testId))
        .returning();
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: test.projectId,
        actorId: req.user!.id,
        action: "update",
        objectType: "clash_test",
        objectId: testId,
        payload: patch,
      });
      return updated;
    },
  );

  app.delete(
    "/projects/:projectId/bim/clash-tests/:testId",
    { preHandler: gates.adminGate },
    async (req) => {
      const { testId } = req.params as { testId: string };
      const test = await getClashTest(testId, req.companyId!);
      if (test.projectId !== req.projectId) throw notFound("Clash test not found");
      await app.db.transaction(async (tx) => {
        await tx.delete(clashResults).where(eq(clashResults.testId, testId));
        await tx.delete(clashTests).where(eq(clashTests.id, testId));
      });
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: test.projectId,
        actorId: req.user!.id,
        action: "delete",
        objectType: "clash_test",
        objectId: testId,
        payload: { name: test.name },
        storePayload: true,
      });
      return { ok: true };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Run                                                               */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/bim/clash-tests/:testId/run",
    { preHandler: gates.standardGate },
    async (req) => {
      const { testId } = req.params as { testId: string };
      const test = await getClashTest(testId, req.companyId!);
      if (test.projectId !== req.projectId) throw notFound("Clash test not found");

      const versionIds = await scopeVersionIds(
        req.companyId!,
        test.projectId,
        test.federationId,
      );
      if (versionIds.length === 0) {
        await app.db
          .update(clashTests)
          .set({
            state: "failed",
            lastError: "No model versions in scope — add members to the federation or upload a model",
            lastRunAt: nowISO(),
            lastRunBy: req.user!.id,
          })
          .where(eq(clashTests.id, testId));
        throw conflict("No model versions in scope for this test");
      }

      const [left, right] = await Promise.all([
        loadElements(req.companyId!, test.projectId, versionIds, test.leftFilter),
        loadElements(req.companyId!, test.projectId, versionIds, test.rightFilter),
      ]);

      const run = detectClashes(left, right, {
        toleranceMm: test.toleranceMm,
        clearanceMm: test.clearanceMm,
      });

      const existing = await app.db
        .select()
        .from(clashResults)
        .where(eq(clashResults.testId, testId));
      const byFingerprint = new Map(existing.map((r) => [r.fingerprint, r]));
      const at = nowISO();
      const seen = new Set<string>();
      const inserts: Array<typeof clashResults.$inferInsert> = [];
      let persisting = 0;

      for (const hit of run.hits) {
        seen.add(hit.fingerprint);
        const prior = byFingerprint.get(hit.fingerprint);
        if (prior) {
          persisting += 1;
          await app.db
            .update(clashResults)
            .set({
              status: prior.status === "resolved" ? "active" : prior.status,
              kind: hit.kind,
              penetrationMm: hit.penetrationMm,
              distanceMm: hit.distanceMm,
              overlapVolume: hit.overlapVolume,
              centroid: hit.centroid,
              storey: hit.storey,
              lastSeenAt: at,
              resolvedAt: null,
            })
            .where(eq(clashResults.id, prior.id));
          continue;
        }
        inserts.push({
          id: newId("clr"),
          companyId: req.companyId!,
          projectId: test.projectId,
          testId,
          fingerprint: hit.fingerprint,
          kind: hit.kind,
          status: "new",
          globalIdA: hit.a.globalId,
          nameA: hit.a.name,
          ifcTypeA: hit.a.ifcType,
          modelVersionIdA: hit.a.modelVersionId,
          disciplineA: hit.a.discipline,
          globalIdB: hit.b.globalId,
          nameB: hit.b.name,
          ifcTypeB: hit.b.ifcType,
          modelVersionIdB: hit.b.modelVersionId,
          disciplineB: hit.b.discipline,
          penetrationMm: hit.penetrationMm,
          distanceMm: hit.distanceMm,
          overlapVolume: hit.overlapVolume,
          centroid: hit.centroid,
          storey: hit.storey,
          firstSeenAt: at,
          lastSeenAt: at,
        });
      }
      // new results go in in chunks: a first run over a real federation can
      // produce thousands, and one round trip each is not acceptable
      for (let i = 0; i < inserts.length; i += 500) {
        await app.db.insert(clashResults).values(inserts.slice(i, i + 500));
      }
      const created = inserts.length;

      // anything previously open that this run did not find has gone away
      const goneIds = existing
        .filter((r) => !seen.has(r.fingerprint) && (r.status === "new" || r.status === "active"))
        .map((r) => r.id);
      if (goneIds.length > 0) {
        await app.db
          .update(clashResults)
          .set({ status: "resolved", resolvedAt: at })
          .where(inArray(clashResults.id, goneIds));
      }

      const summary = {
        new: created,
        persisting,
        autoResolved: goneIds.length,
        comparedPairs: run.comparedPairs,
        elementsLeft: run.elementsLeft,
        elementsRight: run.elementsRight,
        skippedNoBounds: run.skippedNoBounds,
      };

      await app.db
        .update(clashTests)
        .set({
          state: "ready",
          lastRunAt: at,
          lastRunBy: req.user!.id,
          lastError: null,
          lastResult: summary,
          updatedAt: at,
        })
        .where(eq(clashTests.id, testId));

      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: test.projectId,
        actorId: req.user!.id,
        action: "update",
        objectType: "clash_test",
        objectId: testId,
        payload: { run: summary, method: run.method, truncated: run.truncated },
        storePayload: true,
      });

      const openCount = created + persisting;
      if (openCount === 0) {
        await closeSignal(
          app.db,
          req.companyId!,
          "bim_clash_unresolved",
          `bim_clash_unresolved:${testId}`,
          "Auto-closed: a later run of this clash test found no unresolved interference.",
        );
      }
      if (openCount > 0) {
        await raiseSignal(app.db, req.companyId!, test.projectId, req.user!.id, {
          detector: "bim_clash_unresolved",
          severity: openCount > 50 ? "high" : "medium",
          confidence: 0.7,
          title: `${openCount} unresolved clashes in "${test.name}"`,
          explanation: `Clash test "${test.name}" found ${openCount} interferences (${created} new) using an axis-aligned bounding-box pass at ${test.toleranceMm} mm tolerance. ${run.skippedNoBounds} elements had no extents and were excluded.`,
          key: `bim_clash_unresolved:${testId}`,
          evidence: { testId, ...summary, method: run.method },
          subjectType: "clash_test",
          subjectId: testId,
        });
      }

      return {
        testId,
        ...summary,
        method: run.method,
        truncated: run.truncated,
        coverageNote:
          run.skippedNoBounds > 0
            ? `${run.skippedNoBounds} elements carry no extents (no length/width/height quantities in the IFC) and could not be tested`
            : null,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Results                                                           */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/bim/clash-tests/:testId/results",
    { preHandler: gates.readGate },
    async (req) => {
      const { testId } = req.params as { testId: string };
      const test = await getClashTest(testId, req.companyId!);
      if (test.projectId !== req.projectId) throw notFound("Clash test not found");
      const q = resultListQuery.parse(req.query);
      const conds = [eq(clashResults.testId, testId)];
      if (q.status) conds.push(eq(clashResults.status, q.status));
      if (q.kind) conds.push(eq(clashResults.kind, q.kind));
      if (q.storey) conds.push(eq(clashResults.storey, q.storey));
      const where = and(...conds);
      const [totalRow] = await app.db.select({ n: count() }).from(clashResults).where(where);
      const items = await app.db
        .select()
        .from(clashResults)
        .where(where)
        .orderBy(desc(clashResults.penetrationMm), asc(clashResults.fingerprint))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      const byStorey = await app.db
        .select({ storey: clashResults.storey, n: count() })
        .from(clashResults)
        .where(and(eq(clashResults.testId, testId), inArray(clashResults.status, ["new", "active"])))
        .groupBy(clashResults.storey);
      return {
        ...paginate(items, Number(totalRow?.n ?? 0), q),
        test,
        byStorey: byStorey.map((r) => ({ storey: r.storey ?? "unknown", count: Number(r.n) })),
      };
    },
  );

  app.patch("/bim/clash-results/:resultId", { preHandler: gates.companyGate }, async (req, reply) => {
    const { resultId } = req.params as { resultId: string };
    const body = resultPatchSchema.parse(req.body);
    const rows = await app.db
      .select()
      .from(clashResults)
      .where(and(eq(clashResults.id, resultId), eq(clashResults.companyId, req.companyId!)))
      .limit(1);
    const result = rows[0];
    if (!result) throw notFound("Clash result not found");
    await gates.requireToolFor(req, reply, result.projectId, "standard");
    const [updated] = await app.db
      .update(clashResults)
      .set({
        status: body.status,
        notes: body.notes ?? result.notes,
        reviewedBy: req.user!.id,
        resolvedAt: body.status === "resolved" || body.status === "approved" ? nowISO() : null,
      })
      .where(eq(clashResults.id, resultId))
      .returning();
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: result.projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "clash_result",
      objectId: resultId,
      payload: { from: result.status, to: body.status, notes: body.notes },
      storePayload: true,
    });
    return updated;
  });

  /**
   * Turn a group of clashes into one coordination issue with a viewpoint
   * aimed at their centroid and every involved GlobalId selected (#240).
   */
  app.post(
    "/projects/:projectId/bim/clash-tests/:testId/raise-issue",
    { preHandler: gates.standardGate },
    async (req, reply) => {
      const { testId } = req.params as { testId: string };
      const body = raiseIssueSchema.parse(req.body);
      const test = await getClashTest(testId, req.companyId!);
      if (test.projectId !== req.projectId) throw notFound("Clash test not found");

      const results = await app.db
        .select()
        .from(clashResults)
        .where(
          and(
            eq(clashResults.testId, testId),
            inArray(clashResults.id, body.resultIds),
            eq(clashResults.companyId, req.companyId!),
          ),
        );
      if (results.length === 0) throw badRequest("No clash results matched");
      const already = results.find((r) => r.issueId);
      if (already) {
        throw conflict(`Clash ${already.fingerprint} is already on coordination issue ${already.issueId}`);
      }

      const globalIds = [
        ...new Set(results.flatMap((r) => [r.globalIdA, r.globalIdB])),
      ].slice(0, 500);
      const centroids = results
        .map((r) => r.centroid)
        .filter((c): c is { x: number; y: number; z: number } => !!c);
      const centre =
        centroids.length > 0
          ? {
              x: centroids.reduce((a, c) => a + c.x, 0) / centroids.length,
              y: centroids.reduce((a, c) => a + c.y, 0) / centroids.length,
              z: centroids.reduce((a, c) => a + c.z, 0) / centroids.length,
            }
          : null;

      const number = await nextRecordNumber(app.db, test.projectId, "coordination_issue");
      const issueId = newId("cis");
      const title =
        body.title ??
        `${results.length} clash${results.length === 1 ? "" : "es"} in ${test.name}${
          results[0]?.storey ? ` (${results[0].storey})` : ""
        }`;
      const description = results
        .slice(0, 20)
        .map(
          (r) =>
            `${r.ifcTypeA ?? "?"} ${r.nameA ?? r.globalIdA} vs ${r.ifcTypeB ?? "?"} ${r.nameB ?? r.globalIdB}: ${
              r.penetrationMm !== null
                ? `${Math.round(r.penetrationMm)} mm penetration`
                : `${Math.round(r.distanceMm ?? 0)} mm clearance`
            }`,
        )
        .join("\n");

      const [issue] = await app.db
        .insert(coordinationIssues)
        .values({
          id: issueId,
          companyId: req.companyId!,
          projectId: test.projectId,
          number,
          title,
          description,
          status: body.assigneeId ? "assigned" : "open",
          discipline: body.discipline ?? null,
          assigneeId: body.assigneeId ?? null,
          dueDate: body.dueDate ?? null,
          elementGlobalIds: globalIds,
          modelVersionId: results[0]?.modelVersionIdA ?? null,
          viewpoint: centre ? { camera: centre, selected: globalIds.slice(0, 50) } : null,
          source: "clash",
          clashResultId: results[0]?.id ?? null,
          createdBy: req.user!.id,
        })
        .returning();

      await app.db
        .update(clashResults)
        .set({ issueId })
        .where(
          inArray(
            clashResults.id,
            results.map((r) => r.id),
          ),
        );

      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: test.projectId,
        actorId: req.user!.id,
        action: "create",
        objectType: "coordination_issue",
        objectId: issueId,
        payload: { fromClashTest: testId, clashes: results.length, elements: globalIds.length },
        storePayload: true,
      });

      return reply.status(201).send({ ...issue, clashes: results.length });
    },
  );
};
