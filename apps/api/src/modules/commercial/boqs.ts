import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { boqItems, boqs, contracts, drawingSheets, takeoffLines, valuations } from "@constructos/db";
import { BOQ_ITEM_TYPES, BOQ_LEVELS, BOQ_METHODS, BOQ_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import {
  computeRateBuildUp,
  rateBuildUpComponentSchema,
  requireCommercialLevel,
  round2,
  round3,
} from "./shared.js";

const boqCreateSchema = z.object({
  name: z.string().min(1).max(200),
  method: z.enum(BOQ_METHODS),
  currency: z.string().min(3).max(8).optional(),
  contractId: z.string().nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
});

const boqPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  notes: z.string().max(20000).nullable().optional(),
  status: z.enum(BOQ_STATUSES).optional(),
});

const boqListQuery = pageQuerySchema.extend({
  status: z.enum(BOQ_STATUSES).optional(),
});

const itemCreateSchema = z.object({
  parentId: z.string().nullable().optional(),
  level: z.enum(BOQ_LEVELS),
  code: z.string().min(1).max(50),
  description: z.string().min(1).max(2000),
  unit: z.string().max(20).nullable().optional(),
  quantity: z.number().finite().nullable().optional(),
  rate: z.number().finite().nullable().optional(),
  itemType: z.enum(BOQ_ITEM_TYPES).optional(),
  rateBuildUp: z.array(rateBuildUpComponentSchema).min(1).max(50).optional(),
  sortOrder: z.number().int().optional(),
});

const itemPatchSchema = itemCreateSchema.omit({ parentId: true, level: true }).partial();

const takeoffCreateSchema = z.object({
  description: z.string().min(1).max(1000),
  timesing: z.number().positive().optional(),
  length: z.number().positive().nullable().optional(),
  width: z.number().positive().nullable().optional(),
  depth: z.number().positive().nullable().optional(),
  /** manual override quantity — recorded with isManual = 1 */
  quantity: z.number().finite().nullable().optional(),
  drawingSheetId: z.string().nullable().optional(),
});

type BoqItemRow = typeof boqItems.$inferSelect;
interface BoqItemNode extends BoqItemRow {
  children: BoqItemNode[];
}

/** Assemble the bill > section > item tree, siblings ordered by sortOrder then code. */
function buildTree(rows: BoqItemRow[]): BoqItemNode[] {
  const nodes = new Map<string, BoqItemNode>(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots: BoqItemNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortRec = (list: BoqItemNode[]) => {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

/**
 * Resolve the item rate + persisted build-up from the request. When a
 * build-up sheet is supplied the item rate is the Σ of component amounts;
 * an explicit rate that disagrees by more than 0.01 is a 400 (the build-up
 * is the audit trail for the rate — they must reconcile, spec #145-149).
 */
function resolveRate(
  explicitRate: number | null | undefined,
  buildUp: z.infer<typeof rateBuildUpComponentSchema>[] | undefined,
): { rate: number | null; rateBuildUp: unknown[] | null | undefined } {
  if (buildUp && buildUp.length > 0) {
    const computed = computeRateBuildUp(buildUp);
    if (explicitRate != null && Math.abs(explicitRate - computed.rate) > 0.01) {
      throw badRequest(
        `Explicit rate ${explicitRate} does not match the rate build-up total ${computed.rate}`,
      );
    }
    return { rate: explicitRate ?? computed.rate, rateBuildUp: computed.components };
  }
  return { rate: explicitRate ?? null, rateBuildUp: undefined };
}

/**
 * Bills of Quantities, BQ item hierarchy and taking-off sheets
 * (spec Vol II Domain B #115-116, #135-140, #145-149).
 */
export const boqRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("commercial", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("commercial", "standard"),
  ];
  const companyGate = [app.authenticate, app.requireCompany];

  async function fetchBoq(boqId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(boqs)
      .where(and(eq(boqs.id, boqId), eq(boqs.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("BoQ not found");
    return rows[0];
  }

  async function fetchItemWithBoq(itemId: string, companyId: string) {
    const rows = await app.db
      .select({ item: boqItems, boq: boqs })
      .from(boqItems)
      .innerJoin(boqs, eq(boqs.id, boqItems.boqId))
      .where(and(eq(boqItems.id, itemId), eq(boqs.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("BQ item not found");
    return rows[0];
  }

  async function ledger(
    req: { companyId?: string; user?: { id: string } },
    action: "create" | "update" | "delete" | "state_change",
    objectType: string,
    objectId: string,
    payload: unknown,
  ) {
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action,
      objectType,
      objectId,
      payload,
    });
  }

  /* ---------------------------------------------------------------- */
  /* BoQs                                                              */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/boqs", { preHandler: standardGate }, async (req, reply) => {
    const body = boqCreateSchema.parse(req.body);
    if (body.contractId) {
      const c = await app.db
        .select({ id: contracts.id })
        .from(contracts)
        .where(
          and(
            eq(contracts.id, body.contractId),
            eq(contracts.companyId, req.companyId!),
            eq(contracts.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!c[0]) throw badRequest("contractId does not reference a contract on this project");
    }
    const id = newId("boq");
    await app.db.insert(boqs).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      contractId: body.contractId ?? null,
      name: body.name,
      method: body.method,
      currency: body.currency ?? "USD",
      notes: body.notes ?? null,
      status: "draft",
      createdBy: req.user!.id,
    });
    await ledger(req, "create", "boq", id, { name: body.name, method: body.method });
    const created = await fetchBoq(id, req.companyId!);
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/boqs", { preHandler: readGate }, async (req) => {
    const q = boqListQuery.parse(req.query);
    const clauses = [eq(boqs.companyId, req.companyId!), eq(boqs.projectId, req.projectId!)];
    if (q.status) clauses.push(eq(boqs.status, q.status));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(boqs).where(where);
    const items = await app.db
      .select()
      .from(boqs)
      .where(where)
      .orderBy(desc(boqs.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));

    const ids = items.map((b) => b.id);
    const aggByBoq = new Map<string, { itemCount: number; totalAmount: number }>();
    if (ids.length > 0) {
      const agg = await app.db
        .select({
          boqId: boqItems.boqId,
          n: count(),
          total: sql<number>`coalesce(sum(case when ${boqItems.level} = 'item' then coalesce(${boqItems.amount}, 0) else 0 end), 0)`,
        })
        .from(boqItems)
        .where(inArray(boqItems.boqId, ids))
        .groupBy(boqItems.boqId);
      for (const row of agg) {
        aggByBoq.set(row.boqId, { itemCount: Number(row.n), totalAmount: round2(Number(row.total)) });
      }
    }
    const enriched = items.map((b) => ({
      ...b,
      itemCount: aggByBoq.get(b.id)?.itemCount ?? 0,
      totalAmount: aggByBoq.get(b.id)?.totalAmount ?? 0,
    }));
    return paginate(enriched, Number(totalRow?.n ?? 0), q);
  });

  app.get("/boqs/:boqId", { preHandler: companyGate }, async (req) => {
    const { boqId } = req.params as { boqId: string };
    const boq = await fetchBoq(boqId, req.companyId!);
    const rows = await app.db
      .select()
      .from(boqItems)
      .where(eq(boqItems.boqId, boqId))
      .orderBy(asc(boqItems.path), asc(boqItems.sortOrder));
    const leaves = rows.filter((r) => r.level === "item");
    const totalAmount = round2(leaves.reduce((s, r) => s + (r.amount ?? 0), 0));
    return { ...boq, items: buildTree(rows), itemCount: rows.length, totalAmount };
  });

  app.patch("/boqs/:boqId", { preHandler: companyGate }, async (req, reply) => {
    const { boqId } = req.params as { boqId: string };
    const body = boqPatchSchema.parse(req.body);
    const boq = await fetchBoq(boqId, req.companyId!);
    await requireCommercialLevel(app, req, reply, boq.projectId, "standard");

    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.name !== undefined) set["name"] = body.name;
    if (body.notes !== undefined) set["notes"] = body.notes;
    let statusChanged = false;
    if (body.status !== undefined && body.status !== boq.status) {
      // forward-only lifecycle: draft → issued → agreed (#115)
      if (BOQ_STATUSES.indexOf(body.status) < BOQ_STATUSES.indexOf(boq.status as never)) {
        throw badRequest("BoQ status can only move forward (draft → issued → agreed)");
      }
      set["status"] = body.status;
      statusChanged = true;
    }
    await app.db.update(boqs).set(set).where(eq(boqs.id, boqId));
    await ledger(
      req,
      statusChanged ? "state_change" : "update",
      "boq",
      boqId,
      statusChanged
        ? { from: boq.status, to: body.status, changed: Object.keys(body) }
        : { changed: Object.keys(body) },
    );
    return fetchBoq(boqId, req.companyId!);
  });

  app.delete("/boqs/:boqId", { preHandler: companyGate }, async (req, reply) => {
    const { boqId } = req.params as { boqId: string };
    const boq = await fetchBoq(boqId, req.companyId!);
    await requireCommercialLevel(app, req, reply, boq.projectId, "admin");
    if (boq.status !== "draft") throw badRequest("Only a draft BoQ can be deleted");
    const referencing = await app.db
      .select({ id: valuations.id })
      .from(valuations)
      .where(eq(valuations.boqId, boqId))
      .limit(1);
    if (referencing[0]) throw conflict("BoQ has valuations against it and cannot be deleted");
    await app.db.transaction(async (tx) => {
      const ids = (
        await tx.select({ id: boqItems.id }).from(boqItems).where(eq(boqItems.boqId, boqId))
      ).map((r) => r.id);
      if (ids.length > 0) {
        await tx.delete(takeoffLines).where(inArray(takeoffLines.boqItemId, ids));
      }
      await tx.delete(boqItems).where(eq(boqItems.boqId, boqId));
      await tx.delete(boqs).where(eq(boqs.id, boqId));
    });
    await ledger(req, "delete", "boq", boqId, { name: boq.name });
    return { ok: true };
  });

  app.get("/boqs/:boqId/summary", { preHandler: companyGate }, async (req) => {
    const { boqId } = req.params as { boqId: string };
    const boq = await fetchBoq(boqId, req.companyId!);
    const rows = await app.db.select().from(boqItems).where(eq(boqItems.boqId, boqId));
    const leaves = rows.filter((r) => r.level === "item");

    const byTypeMap = new Map<string, { count: number; amount: number }>();
    const byBillMap = new Map<string, number>();
    for (const leaf of leaves) {
      const t = byTypeMap.get(leaf.itemType) ?? { count: 0, amount: 0 };
      t.count += 1;
      t.amount += leaf.amount ?? 0;
      byTypeMap.set(leaf.itemType, t);
      const rootId = leaf.path.split("/")[0]!;
      byBillMap.set(rootId, (byBillMap.get(rootId) ?? 0) + (leaf.amount ?? 0));
    }
    const roots = rows
      .filter((r) => !r.parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
    return {
      boqId,
      status: boq.status,
      currency: boq.currency,
      total: round2(leaves.reduce((s, r) => s + (r.amount ?? 0), 0)),
      byItemType: [...byTypeMap.entries()].map(([itemType, v]) => ({
        itemType,
        count: v.count,
        amount: round2(v.amount),
      })),
      byBill: roots.map((r) => ({
        id: r.id,
        code: r.code,
        description: r.description,
        amount: round2(byBillMap.get(r.id) ?? 0),
      })),
    };
  });

  /* ---------------------------------------------------------------- */
  /* BQ items                                                          */
  /* ---------------------------------------------------------------- */

  app.post("/boqs/:boqId/items", { preHandler: companyGate }, async (req, reply) => {
    const { boqId } = req.params as { boqId: string };
    const body = itemCreateSchema.parse(req.body);
    const boq = await fetchBoq(boqId, req.companyId!);
    await requireCommercialLevel(app, req, reply, boq.projectId, "standard");
    if (boq.status === "agreed") throw badRequest("An agreed BoQ can no longer be edited");

    let parent: typeof boqItems.$inferSelect | null = null;
    if (body.level === "bill") {
      // bills sit at the root of the BQ only
      if (body.parentId) throw badRequest("A bill must sit at the root of the BQ");
    } else {
      if (!body.parentId) throw badRequest(`A ${body.level} requires a parentId`);
      const rows = await app.db
        .select()
        .from(boqItems)
        .where(and(eq(boqItems.id, body.parentId), eq(boqItems.boqId, boqId)))
        .limit(1);
      if (!rows[0]) throw badRequest("parentId does not reference an item of this BoQ");
      parent = rows[0];
      if (body.level === "section" && parent.level !== "bill") {
        throw badRequest("A section must sit under a bill");
      }
      // items normally sit under a section; small BQs may hang items
      // directly off a bill (documented relaxation of #116)
      if (body.level === "item" && parent.level !== "section" && parent.level !== "bill") {
        throw badRequest("An item must sit under a section (or a bill for small BQs)");
      }
    }

    const { rate, rateBuildUp } = resolveRate(body.rate, body.rateBuildUp);
    const quantity = body.quantity ?? null;
    const amount = quantity != null && rate != null ? round2(quantity * rate) : null;
    const id = newId("bqi");
    await app.db.insert(boqItems).values({
      id,
      boqId,
      parentId: parent?.id ?? null,
      path: parent ? `${parent.path}/${id}` : id,
      level: body.level,
      code: body.code,
      description: body.description,
      unit: body.unit ?? null,
      quantity,
      rate,
      amount,
      itemType: body.itemType ?? "measured",
      rateBuildUp: rateBuildUp ?? null,
      sortOrder: body.sortOrder ?? 0,
    });
    await ledger(req, "create", "boq_item", id, {
      boqId,
      level: body.level,
      code: body.code,
      amount,
    });
    const created = await app.db.select().from(boqItems).where(eq(boqItems.id, id)).limit(1);
    return reply.status(201).send(created[0]);
  });

  app.patch("/boq-items/:itemId", { preHandler: companyGate }, async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const body = itemPatchSchema.parse(req.body);
    const { item, boq } = await fetchItemWithBoq(itemId, req.companyId!);
    await requireCommercialLevel(app, req, reply, boq.projectId, "standard");
    if (boq.status === "agreed") throw badRequest("An agreed BoQ can no longer be edited");

    const { rate, rateBuildUp } = resolveRate(
      body.rate !== undefined ? body.rate : item.rate,
      body.rateBuildUp,
    );
    const quantity = body.quantity !== undefined ? body.quantity : item.quantity;
    const amount = quantity != null && rate != null ? round2(quantity * rate) : null;

    const set: Record<string, unknown> = {
      quantity,
      rate,
      amount,
      updatedAt: new Date().toISOString(),
    };
    if (body.code !== undefined) set["code"] = body.code;
    if (body.description !== undefined) set["description"] = body.description;
    if (body.unit !== undefined) set["unit"] = body.unit;
    if (body.itemType !== undefined) set["itemType"] = body.itemType;
    if (body.sortOrder !== undefined) set["sortOrder"] = body.sortOrder;
    if (rateBuildUp !== undefined) set["rateBuildUp"] = rateBuildUp;

    await app.db.update(boqItems).set(set).where(eq(boqItems.id, itemId));
    await ledger(req, "update", "boq_item", itemId, { changed: Object.keys(body), amount });
    const updated = await app.db.select().from(boqItems).where(eq(boqItems.id, itemId)).limit(1);
    return updated[0];
  });

  app.delete("/boq-items/:itemId", { preHandler: companyGate }, async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const { item, boq } = await fetchItemWithBoq(itemId, req.companyId!);
    await requireCommercialLevel(app, req, reply, boq.projectId, "admin");
    if (boq.status !== "draft") throw badRequest("Items can only be deleted while the BoQ is draft");
    const children = await app.db
      .select({ id: boqItems.id })
      .from(boqItems)
      .where(eq(boqItems.parentId, itemId))
      .limit(1);
    if (children[0]) throw badRequest("Delete or move child items first");
    await app.db.transaction(async (tx) => {
      await tx.delete(takeoffLines).where(eq(takeoffLines.boqItemId, itemId));
      await tx.delete(boqItems).where(eq(boqItems.id, itemId));
    });
    await ledger(req, "delete", "boq_item", itemId, { code: item.code });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* Taking-off (#135-140)                                             */
  /* ---------------------------------------------------------------- */

  app.post("/boq-items/:itemId/takeoff", { preHandler: companyGate }, async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const body = takeoffCreateSchema.parse(req.body);
    const { item, boq } = await fetchItemWithBoq(itemId, req.companyId!);
    await requireCommercialLevel(app, req, reply, boq.projectId, "standard");
    if (item.level !== "item") throw badRequest("Taking-off applies to leaf BQ items only");
    if (boq.status === "agreed") throw badRequest("An agreed BoQ can no longer be measured");

    if (body.drawingSheetId) {
      const sheet = await app.db
        .select({ id: drawingSheets.id })
        .from(drawingSheets)
        .where(
          and(
            eq(drawingSheets.id, body.drawingSheetId),
            eq(drawingSheets.companyId, req.companyId!),
            eq(drawingSheets.projectId, boq.projectId),
          ),
        )
        .limit(1);
      if (!sheet[0]) {
        throw badRequest("drawingSheetId does not reference a drawing sheet on this project");
      }
    }

    const timesing = body.timesing ?? 1;
    let quantity: number;
    let isManual = 0;
    if (body.quantity != null) {
      quantity = round3(body.quantity);
      isManual = 1;
    } else {
      const dims = [body.length, body.width, body.depth].filter(
        (d): d is number => d != null,
      );
      if (dims.length === 0) {
        throw badRequest("Provide at least one dimension, or a manual quantity override");
      }
      quantity = round3(timesing * dims.reduce((p, d) => p * d, 1));
    }

    const id = newId("tol");
    await app.db.insert(takeoffLines).values({
      id,
      boqItemId: itemId,
      projectId: boq.projectId,
      drawingSheetId: body.drawingSheetId ?? null,
      description: body.description,
      timesing,
      length: body.length ?? null,
      width: body.width ?? null,
      depth: body.depth ?? null,
      quantity,
      isManual,
      createdBy: req.user!.id,
    });
    await ledger(req, "create", "takeoff_line", id, { boqItemId: itemId, quantity, isManual });
    const created = await app.db
      .select()
      .from(takeoffLines)
      .where(eq(takeoffLines.id, id))
      .limit(1);
    return reply.status(201).send(created[0]);
  });

  app.get("/boq-items/:itemId/takeoff", { preHandler: companyGate }, async (req) => {
    const { itemId } = req.params as { itemId: string };
    await fetchItemWithBoq(itemId, req.companyId!);
    const items = await app.db
      .select()
      .from(takeoffLines)
      .where(eq(takeoffLines.boqItemId, itemId))
      .orderBy(asc(takeoffLines.createdAt));
    return { items, total: round3(items.reduce((s, l) => s + l.quantity, 0)) };
  });

  app.delete("/takeoff-lines/:lineId", { preHandler: companyGate }, async (req, reply) => {
    const { lineId } = req.params as { lineId: string };
    const rows = await app.db
      .select()
      .from(takeoffLines)
      .where(eq(takeoffLines.id, lineId))
      .limit(1);
    if (!rows[0]) throw notFound("Taking-off line not found");
    const line = rows[0];
    const { boq } = await fetchItemWithBoq(line.boqItemId, req.companyId!);
    await requireCommercialLevel(app, req, reply, boq.projectId, "admin");
    if (boq.status === "agreed") throw badRequest("An agreed BoQ can no longer be measured");
    await app.db.delete(takeoffLines).where(eq(takeoffLines.id, lineId));
    await ledger(req, "delete", "takeoff_line", lineId, { boqItemId: line.boqItemId });
    return { ok: true };
  });

  /**
   * Apply the dimension sheet to the BQ item — the item quantity becomes the
   * Σ of its taking-off lines, giving every quantity a measured provenance
   * (#139-140).
   */
  app.post("/boq-items/:itemId/takeoff/apply", { preHandler: companyGate }, async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const { item, boq } = await fetchItemWithBoq(itemId, req.companyId!);
    await requireCommercialLevel(app, req, reply, boq.projectId, "standard");
    if (boq.status === "agreed") throw badRequest("An agreed BoQ can no longer be measured");
    const lines = await app.db
      .select({ quantity: takeoffLines.quantity })
      .from(takeoffLines)
      .where(eq(takeoffLines.boqItemId, itemId));
    if (lines.length === 0) throw badRequest("No taking-off lines to apply");
    const quantity = round3(lines.reduce((s, l) => s + l.quantity, 0));
    const amount = item.rate != null ? round2(quantity * item.rate) : null;
    await app.db
      .update(boqItems)
      .set({ quantity, amount, updatedAt: new Date().toISOString() })
      .where(eq(boqItems.id, itemId));
    await ledger(req, "update", "boq_item", itemId, {
      quantity,
      amount,
      source: "taking_off",
      appliedLines: lines.length,
    });
    const updated = await app.db.select().from(boqItems).where(eq(boqItems.id, itemId)).limit(1);
    return updated[0];
  });
};
