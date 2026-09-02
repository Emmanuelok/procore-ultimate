/**
 * 4D and 5D linking (spec #238-239).
 *
 * 4D: model elements bound to schedule tasks, so a task carries the geometry
 * it builds and a simulation can be driven off the programme dates.
 * 5D: model elements bound to budget lines with a measured quantity, so the
 * cost report can be traced back to what it pays for.
 *
 * Both are the same table with a `linkType`, because the interesting queries
 * ("what is linked to nothing", "which tasks have geometry") are the same
 * question asked twice. Targets are validated against the project: a link to
 * another project's task or budget line is refused, not stored.
 *
 * Deliberately not here: progress inference. A 4D link does not claim an
 * element is built; the schedule module owns percent complete and the site
 * module owns observed progress.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bimElementLinks,
  bimElements,
  bimModelVersions,
  bimModels,
  budgetLineItems,
  scheduleTasks,
} from "@constructos/db";
import { ELEMENT_LINK_ROLES, ELEMENT_LINK_TYPES } from "@constructos/shared";
import { newId } from "../../../lib/ids.js";
import { badRequest, conflict, notFound } from "../../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { buildBimGates, ledger } from "../shared.js";

const linkCreateSchema = z.object({
  linkType: z.enum(ELEMENT_LINK_TYPES),
  targetId: z.string().min(1).max(64),
  globalIds: z.array(z.string().min(1).max(64)).min(1).max(500),
  modelVersionId: z.string().max(64).nullable().optional(),
  role: z.enum(ELEMENT_LINK_ROLES).optional(),
  quantity: z.number().finite().nullable().optional(),
  unit: z.string().max(30).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const linkListQuery = pageQuerySchema.extend({
  linkType: z.enum(ELEMENT_LINK_TYPES).optional(),
  targetId: z.string().max(64).optional(),
  globalId: z.string().max(64).optional(),
});

export const linkRoutes: FastifyPluginAsync = async (app) => {
  const gates = buildBimGates(app);

  async function assertTarget(
    companyId: string,
    projectId: string,
    linkType: string,
    targetId: string,
  ): Promise<{ label: string }> {
    if (linkType === "schedule_task") {
      const rows = await app.db
        .select({ id: scheduleTasks.id, name: scheduleTasks.name })
        .from(scheduleTasks)
        .where(and(eq(scheduleTasks.id, targetId), eq(scheduleTasks.projectId, projectId)))
        .limit(1);
      if (!rows[0]) throw badRequest("Schedule task not found in this project");
      return { label: rows[0].name };
    }
    const rows = await app.db
      .select({ id: budgetLineItems.id, description: budgetLineItems.description })
      .from(budgetLineItems)
      .where(
        and(
          eq(budgetLineItems.id, targetId),
          eq(budgetLineItems.projectId, projectId),
          eq(budgetLineItems.companyId, companyId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw badRequest("Budget line not found in this project");
    return { label: rows[0].description };
  }

  app.get("/projects/:projectId/bim/links", { preHandler: gates.readGate }, async (req) => {
    const q = linkListQuery.parse(req.query);
    const conds = [
      eq(bimElementLinks.companyId, req.companyId!),
      eq(bimElementLinks.projectId, req.projectId!),
    ];
    if (q.linkType) conds.push(eq(bimElementLinks.linkType, q.linkType));
    if (q.targetId) conds.push(eq(bimElementLinks.targetId, q.targetId));
    if (q.globalId) conds.push(eq(bimElementLinks.globalId, q.globalId));
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(bimElementLinks).where(where);
    const items = await app.db
      .select()
      .from(bimElementLinks)
      .where(where)
      .orderBy(asc(bimElementLinks.linkType), asc(bimElementLinks.globalId))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/projects/:projectId/bim/links", { preHandler: gates.standardGate }, async (req, reply) => {
    const body = linkCreateSchema.parse(req.body);
    const target = await assertTarget(
      req.companyId!,
      req.projectId!,
      body.linkType,
      body.targetId,
    );

    const globalIds = [...new Set(body.globalIds)];
    const known = await app.db
      .select({ globalId: bimElements.globalId })
      .from(bimElements)
      .where(
        and(
          eq(bimElements.projectId, req.projectId!),
          inArray(bimElements.globalId, globalIds),
        ),
      );
    const knownSet = new Set(known.map((k) => k.globalId));
    const unknown = globalIds.filter((g) => !knownSet.has(g));
    if (knownSet.size === 0) {
      throw badRequest("None of these GlobalIds exist in this project's models");
    }

    const existing = await app.db
      .select({ globalId: bimElementLinks.globalId })
      .from(bimElementLinks)
      .where(
        and(
          eq(bimElementLinks.projectId, req.projectId!),
          eq(bimElementLinks.linkType, body.linkType),
          eq(bimElementLinks.targetId, body.targetId),
          inArray(bimElementLinks.globalId, [...knownSet]),
        ),
      );
    const already = new Set(existing.map((e) => e.globalId));
    const toInsert = [...knownSet].filter((g) => !already.has(g));
    if (toInsert.length === 0) {
      throw conflict("Every element supplied is already linked to this target");
    }

    const rows = toInsert.map((globalId) => ({
      id: newId("bml"),
      companyId: req.companyId!,
      projectId: req.projectId!,
      linkType: body.linkType,
      globalId,
      modelVersionId: body.modelVersionId ?? null,
      targetId: body.targetId,
      role: body.role ?? "construct",
      quantity: body.quantity ?? null,
      unit: body.unit ?? null,
      notes: body.notes ?? null,
      createdBy: req.user!.id,
    }));
    const created = await app.db.insert(bimElementLinks).values(rows).returning();

    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "bim_element_link",
      objectId: body.targetId,
      payload: {
        linkType: body.linkType,
        targetId: body.targetId,
        target: target.label,
        linked: created.length,
        skippedExisting: already.size,
        unknownGlobalIds: unknown.length,
      },
      storePayload: true,
    });

    return reply.status(201).send({
      items: created,
      linked: created.length,
      skippedExisting: already.size,
      unknownGlobalIds: unknown,
    });
  });

  app.delete(
    "/projects/:projectId/bim/links/:linkId",
    { preHandler: gates.standardGate },
    async (req) => {
      const { linkId } = req.params as { linkId: string };
      const deleted = await app.db
        .delete(bimElementLinks)
        .where(
          and(
            eq(bimElementLinks.id, linkId),
            eq(bimElementLinks.companyId, req.companyId!),
            eq(bimElementLinks.projectId, req.projectId!),
          ),
        )
        .returning();
      if (!deleted[0]) throw notFound("Element link not found");
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "bim_element_link",
        objectId: linkId,
        payload: { linkType: deleted[0].linkType, targetId: deleted[0].targetId },
      });
      return { ok: true };
    },
  );

  /** 4D: the programme with the geometry bound to each task (#238). */
  app.get("/projects/:projectId/bim/4d", { preHandler: gates.readGate }, async (req) => {
    const links = await app.db
      .select({
        targetId: bimElementLinks.targetId,
        globalId: bimElementLinks.globalId,
        role: bimElementLinks.role,
      })
      .from(bimElementLinks)
      .where(
        and(
          eq(bimElementLinks.companyId, req.companyId!),
          eq(bimElementLinks.projectId, req.projectId!),
          eq(bimElementLinks.linkType, "schedule_task"),
        ),
      )
      .limit(50_000);
    const taskIds = [...new Set(links.map((l) => l.targetId))];
    const tasks = taskIds.length
      ? await app.db
          .select({
            id: scheduleTasks.id,
            name: scheduleTasks.name,
            startDate: scheduleTasks.startDate,
            finishDate: scheduleTasks.finishDate,
            percentComplete: scheduleTasks.percentComplete,
            isCritical: scheduleTasks.isCritical,
          })
          .from(scheduleTasks)
          .where(
            and(eq(scheduleTasks.projectId, req.projectId!), inArray(scheduleTasks.id, taskIds)),
          )
      : [];
    const items = tasks.map((t) => {
      const own = links.filter((l) => l.targetId === t.id);
      return {
        ...t,
        elementCount: own.length,
        globalIds: own.slice(0, 500).map((l) => l.globalId),
        roles: [...new Set(own.map((l) => l.role))],
      };
    });
    const [elementTotal] = await app.db
      .select({ n: count() })
      .from(bimElements)
      .innerJoin(bimModelVersions, eq(bimModelVersions.id, bimElements.modelVersionId))
      .innerJoin(bimModels, eq(bimModels.id, bimModelVersions.modelId))
      .where(
        and(
          eq(bimElements.projectId, req.projectId!),
          eq(bimModels.companyId, req.companyId!),
          sql`${bimModels.currentVersionId} = ${bimElements.modelVersionId}`,
        ),
      );
    const linkedElements = new Set(links.map((l) => l.globalId)).size;
    return {
      items: items.sort((a, b) => (a.startDate ?? "").localeCompare(b.startDate ?? "")),
      total: items.length,
      linkedElements,
      currentModelElements: Number(elementTotal?.n ?? 0),
      unlinkedElements: Math.max(0, Number(elementTotal?.n ?? 0) - linkedElements),
    };
  });

  /** 5D: budget lines with the quantities their linked geometry carries (#239). */
  app.get("/projects/:projectId/bim/5d", { preHandler: gates.readGate }, async (req) => {
    const links = await app.db
      .select({
        targetId: bimElementLinks.targetId,
        globalId: bimElementLinks.globalId,
        quantity: bimElementLinks.quantity,
        unit: bimElementLinks.unit,
      })
      .from(bimElementLinks)
      .where(
        and(
          eq(bimElementLinks.companyId, req.companyId!),
          eq(bimElementLinks.projectId, req.projectId!),
          eq(bimElementLinks.linkType, "budget_line"),
        ),
      )
      .limit(50_000);
    const lineIds = [...new Set(links.map((l) => l.targetId))];
    const lines = lineIds.length
      ? await app.db
          .select({
            id: budgetLineItems.id,
            costCode: budgetLineItems.costCode,
            description: budgetLineItems.description,
            unit: budgetLineItems.unit,
            quantity: budgetLineItems.quantity,
            revisedBudget: budgetLineItems.revisedBudget,
          })
          .from(budgetLineItems)
          .where(
            and(
              eq(budgetLineItems.projectId, req.projectId!),
              eq(budgetLineItems.companyId, req.companyId!),
              inArray(budgetLineItems.id, lineIds),
            ),
          )
      : [];
    const items = lines.map((line) => {
      const own = links.filter((l) => l.targetId === line.id);
      const measured = own.filter((l) => l.quantity !== null);
      const units = [...new Set(measured.map((l) => l.unit ?? line.unit ?? null))].filter(Boolean);
      const modelQuantity =
        measured.length > 0 && units.length <= 1
          ? measured.reduce((sum, l) => sum + (l.quantity ?? 0), 0)
          : null;
      return {
        ...line,
        elementCount: own.length,
        modelQuantity,
        modelQuantityUnit: units[0] ?? line.unit ?? null,
        quantityBasis:
          measured.length === 0
            ? "no linked element carries a quantity"
            : units.length > 1
              ? `linked elements mix units (${units.join(", ")}) — not summed`
              : `${measured.length} linked elements`,
        variance:
          modelQuantity !== null && line.quantity !== null
            ? Math.round((modelQuantity - line.quantity) * 1000) / 1000
            : null,
      };
    });
    return { items, total: items.length };
  });
};
