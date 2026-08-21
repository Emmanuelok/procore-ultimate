import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, ilike, inArray, isNotNull, lt } from "drizzle-orm";
import { z } from "zod";
import { punchItems } from "@constructos/db";
import { PUNCH_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { pushNotifications } from "../notifications/service.js";
import { isoDateSchema, todayISO } from "./dates.js";

const punchCreateSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(10000).nullable().optional(),
  itemType: z.string().max(100).nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  verifierId: z.string().nullable().optional(),
  vendorId: z.string().nullable().optional(),
  locationId: z.string().nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  beforePhotoIds: z.array(z.string()).max(50).optional(),
  afterPhotoIds: z.array(z.string()).max(50).optional(),
});

const punchPatchSchema = punchCreateSchema.partial();

const punchListQuery = pageQuerySchema.extend({
  status: z.enum(PUNCH_STATUSES).optional(),
  assigneeId: z.string().optional(),
  vendorId: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  search: z.string().max(200).optional(),
});

/** Forward transitions of the punch lifecycle (void is handled separately). */
const TRANSITIONS: Record<string, string[]> = {
  open: ["in_progress"],
  in_progress: ["ready_for_review"],
  ready_for_review: ["closed", "in_progress"],
  closed: [],
  void: [],
};

const OPEN_STATUSES = ["open", "in_progress", "ready_for_review"];

/** Punch list — spec Vol I §2.8 #398-#414. */
export const punchRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("punch", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("punch", "standard"),
  ];

  async function fetchItem(itemId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(punchItems)
      .where(
        and(
          eq(punchItems.id, itemId),
          eq(punchItems.companyId, companyId),
          eq(punchItems.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Punch item not found");
    return rows[0];
  }

  app.post("/projects/:projectId/punch", { preHandler: standardGate }, async (req, reply) => {
    const body = punchCreateSchema.parse(req.body);
    const number = await nextRecordNumber(app.db, req.projectId!, "punch");
    const id = newId("pun");
    const row: typeof punchItems.$inferInsert = {
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      number,
      title: body.title,
      description: body.description ?? null,
      status: "open",
      itemType: body.itemType ?? null,
      assigneeId: body.assigneeId ?? null,
      verifierId: body.verifierId ?? null,
      vendorId: body.vendorId ?? null,
      locationId: body.locationId ?? null,
      dueDate: body.dueDate ?? null,
      priority: body.priority ?? "medium",
      beforePhotoIds: body.beforePhotoIds ?? [],
      afterPhotoIds: body.afterPhotoIds ?? [],
      createdBy: req.user!.id,
    };
    await app.db.insert(punchItems).values(row);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "punch_item",
      objectId: id,
      payload: { number, title: body.title },
    });
    if (body.assigneeId) {
      await pushNotifications(app.db, [
        {
          companyId: req.companyId!,
          userId: body.assigneeId,
          projectId: req.projectId!,
          kind: "assignment",
          title: `Punch item #${number} assigned to you: ${body.title}`,
          recordType: "punch_item",
          recordId: id,
        },
      ]);
    }
    return reply.status(201).send(await fetchItem(id, req.companyId!, req.projectId!));
  });

  app.get("/projects/:projectId/punch", { preHandler: readGate }, async (req) => {
    const q = punchListQuery.parse(req.query);
    const clauses = [
      eq(punchItems.companyId, req.companyId!),
      eq(punchItems.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(punchItems.status, q.status));
    if (q.assigneeId) clauses.push(eq(punchItems.assigneeId, q.assigneeId));
    if (q.vendorId) clauses.push(eq(punchItems.vendorId, q.vendorId));
    if (q.priority) clauses.push(eq(punchItems.priority, q.priority));
    if (q.search) clauses.push(ilike(punchItems.title, `%${q.search}%`));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(punchItems).where(where);
    const items = await app.db
      .select()
      .from(punchItems)
      .where(where)
      .orderBy(desc(punchItems.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/punch/analytics", { preHandler: readGate }, async (req) => {
    const scope = and(
      eq(punchItems.companyId, req.companyId!),
      eq(punchItems.projectId, req.projectId!),
    );
    const byStatusRows = await app.db
      .select({ status: punchItems.status, n: count() })
      .from(punchItems)
      .where(scope)
      .groupBy(punchItems.status);
    const byStatus: Record<string, number> = {};
    for (const r of byStatusRows) byStatus[r.status] = Number(r.n);
    const byAssigneeRows = await app.db
      .select({ assigneeId: punchItems.assigneeId, n: count() })
      .from(punchItems)
      .where(
        and(scope, isNotNull(punchItems.assigneeId), inArray(punchItems.status, OPEN_STATUSES)),
      )
      .groupBy(punchItems.assigneeId)
      .orderBy(desc(count()))
      .limit(10);
    const [overdueRow] = await app.db
      .select({ n: count() })
      .from(punchItems)
      .where(
        and(
          scope,
          inArray(punchItems.status, OPEN_STATUSES),
          isNotNull(punchItems.dueDate),
          lt(punchItems.dueDate, todayISO()),
        ),
      );
    return {
      byStatus,
      byAssignee: byAssigneeRows.map((r) => ({ assigneeId: r.assigneeId, count: Number(r.n) })),
      overdue: Number(overdueRow?.n ?? 0),
    };
  });

  app.get("/projects/:projectId/punch/:itemId", { preHandler: readGate }, async (req) => {
    const { itemId } = req.params as { itemId: string };
    return fetchItem(itemId, req.companyId!, req.projectId!);
  });

  app.patch("/projects/:projectId/punch/:itemId", { preHandler: standardGate }, async (req) => {
    const { itemId } = req.params as { itemId: string };
    const body = punchPatchSchema.parse(req.body);
    const item = await fetchItem(itemId, req.companyId!, req.projectId!);
    if (item.status === "closed" || item.status === "void") {
      throw badRequest(`A ${item.status} punch item cannot be edited`);
    }
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) set[k] = v;
    }
    await app.db.update(punchItems).set(set).where(eq(punchItems.id, itemId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "punch_item",
      objectId: itemId,
      payload: { changed: Object.keys(body) },
    });
    if (body.assigneeId && body.assigneeId !== item.assigneeId) {
      await pushNotifications(app.db, [
        {
          companyId: req.companyId!,
          userId: body.assigneeId,
          projectId: req.projectId!,
          kind: "assignment",
          title: `Punch item #${item.number} assigned to you: ${item.title}`,
          recordType: "punch_item",
          recordId: itemId,
        },
      ]);
    }
    return fetchItem(itemId, req.companyId!, req.projectId!);
  });

  app.post(
    "/projects/:projectId/punch/:itemId/status",
    { preHandler: standardGate },
    async (req) => {
      const { itemId } = req.params as { itemId: string };
      const body = z.object({ status: z.enum(PUNCH_STATUSES) }).parse(req.body);
      const item = await fetchItem(itemId, req.companyId!, req.projectId!);
      const isAdmin = req.companyRole === "owner" || req.companyRole === "admin";

      if (body.status === "void") {
        if (!isAdmin) throw forbidden("Only a company admin can void a punch item");
        if (item.status === "void") throw badRequest("Punch item is already void");
      } else {
        const allowed = TRANSITIONS[item.status] ?? [];
        if (!allowed.includes(body.status)) {
          throw badRequest(`Cannot transition from ${item.status} to ${body.status}`);
        }
        if (body.status === "closed" && req.user!.id !== item.verifierId && !isAdmin) {
          throw forbidden("Only the verifier or a company admin can close a punch item");
        }
      }

      await app.db
        .update(punchItems)
        .set({ status: body.status, updatedAt: new Date().toISOString() })
        .where(eq(punchItems.id, itemId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "punch_item",
        objectId: itemId,
        payload: { from: item.status, to: body.status },
      });
      if (body.status === "ready_for_review" && item.verifierId) {
        await pushNotifications(app.db, [
          {
            companyId: req.companyId!,
            userId: item.verifierId,
            projectId: req.projectId!,
            kind: "status_change",
            title: `Punch item #${item.number} ready for your review: ${item.title}`,
            recordType: "punch_item",
            recordId: itemId,
          },
        ]);
      }
      return fetchItem(itemId, req.companyId!, req.projectId!);
    },
  );
};
