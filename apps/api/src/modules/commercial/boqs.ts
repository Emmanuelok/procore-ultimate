import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  boqItems,
  boqs,
  drawingSheets,
  provisionalSums,
  takeoffLines,
  valuationLines,
  valuations,
  variations,
} from "@constructos/db";
import {
  BOQ_ITEM_TYPES,
  BOQ_LEVELS,
  BOQ_METHODS,
  BOQ_STATUSES,
  type BoqMethod,
  type BoqStatus,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { measurementStandards, validateBoq, type MomItemInput } from "./mom.js";
import {
  assertBoqCurrencyMatchesContract,
  compareCodes,
  computeRateBuildUp,
  rateBuildUpComponentSchema,
  requireCommercialLevel,
  round2,
  round3,
  subResourceGate,
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

const itemPatchSchema = itemCreateSchema.omit({ parentId: true, level: true }).partial().extend({
  /** explicit removal of a build-up that no longer supports the rate */
  clearRateBuildUp: z.boolean().optional(),
});

const takeoffCreateSchema = z.object({
  description: z.string().min(1).max(1000),
  timesing: z.number().positive().optional(),
  length: z.number().positive().nullable().optional(),
  width: z.number().positive().nullable().optional(),
  depth: z.number().positive().nullable().optional(),
  /** manual override quantity — recorded with isManual = 1; never negative */
  quantity: z.number().finite().nonnegative().nullable().optional(),
  /** dimension-paper deduction: measured positive, subtracted on apply */
  deduct: z.boolean().optional(),
  drawingSheetId: z.string().nullable().optional(),
});

const importSchema = z.object({
  /** CSV text with a header row; delimiter is inferred from the header */
  content: z.string().min(1).max(4_000_000),
  /** column name → field, when the file does not use the canonical headers */
  mapping: z.record(z.string(), z.string()).optional(),
  /** replace the bill's items instead of appending */
  replace: z.boolean().optional(),
});

type BoqItemRow = typeof boqItems.$inferSelect;
interface BoqItemNode extends BoqItemRow {
  children: BoqItemNode[];
}

/**
 * Assemble the bill > section > item tree. Siblings order by sortOrder then by
 * a NATURAL code comparison, so 1, 2, … 10, 11 reads in bill order rather than
 * 1, 10, 11, 2 — the lexicographic sort the first cut used.
 */
function buildTree(rows: BoqItemRow[]): BoqItemNode[] {
  const nodes = new Map<string, BoqItemNode>(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots: BoqItemNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortRec = (list: BoqItemNode[]) => {
    list.sort((a, b) => a.sortOrder - b.sortOrder || compareCodes(a.code, b.code));
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

/** Depth-first flatten of the ordered tree — the canonical BQ line order. */
export function orderedItems(rows: BoqItemRow[]): BoqItemRow[] {
  const out: BoqItemRow[] = [];
  const walk = (nodes: BoqItemNode[]) => {
    for (const n of nodes) {
      const { children, ...rest } = n;
      out.push(rest as BoqItemRow);
      walk(children);
    }
  };
  walk(buildTree(rows));
  return out;
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

/* ------------------------------------------------------------------ */
/* CSV (#191)                                                          */
/* ------------------------------------------------------------------ */

/** RFC4180-ish parser: quoted fields, doubled quotes, CR/LF tolerant. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const delimiter = (text.split("\n")[0] ?? "").includes(";") &&
    !(text.split("\n")[0] ?? "").includes(",")
    ? ";"
    : ",";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CANONICAL_FIELDS = [
  "code",
  "description",
  "unit",
  "quantity",
  "rate",
  "amount",
  "level",
  "itemType",
] as const;

/** Infer the BQ level from the depth of a dotted/hierarchical code. */
function levelFromCode(code: string): "bill" | "section" | "item" {
  const depth = code.trim().split(/[.\-/]/).filter(Boolean).length;
  if (depth <= 1) return "bill";
  if (depth === 2) return "section";
  return "item";
}

/**
 * Bills of Quantities, BQ item hierarchy, taking-off sheets, method-of-
 * measurement validation and CSV import/export
 * (spec Vol II Domain B #115-116, #117-134, #135-140, #145-149, #191).
 */
export const boqRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("commercial", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("commercial", "standard"),
  ];
  const subRead = subResourceGate(app, "read");
  const subWrite = subResourceGate(app, "standard");
  const subAdmin = subResourceGate(app, "admin");

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
    req: { companyId?: string; user?: { id: string }; projectId?: string },
    action: "create" | "update" | "delete" | "state_change",
    objectType: string,
    objectId: string,
    payload: unknown,
    projectId?: string,
  ) {
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action,
      objectType,
      objectId,
      payload,
      projectId: projectId ?? req.projectId,
    });
  }

  /** Next sortOrder among an item's siblings, so insertion order is bill order. */
  async function nextSortOrder(boqId: string, parentId: string | null): Promise<number> {
    const rows = await app.db
      .select({ max: sql<number>`coalesce(max(${boqItems.sortOrder}), -1)` })
      .from(boqItems)
      .where(
        parentId
          ? and(eq(boqItems.boqId, boqId), eq(boqItems.parentId, parentId))
          : and(eq(boqItems.boqId, boqId), sql`${boqItems.parentId} is null`),
      );
    return Number(rows[0]?.max ?? -1) + 1;
  }

  /* ---------------------------------------------------------------- */
  /* Measurement standards reference (#117-134)                        */
  /* ---------------------------------------------------------------- */

  app.get("/measurement-standards", { preHandler: [app.authenticate] }, async () => ({
    items: measurementStandards(),
  }));

  /* ---------------------------------------------------------------- */
  /* BoQs                                                              */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/boqs", { preHandler: standardGate }, async (req, reply) => {
    const body = boqCreateSchema.parse(req.body);
    const currency = body.currency ?? "USD";
    await assertBoqCurrencyMatchesContract(
      app.db,
      body.contractId,
      req.companyId!,
      req.projectId!,
      currency,
    );
    const id = newId("boq");
    await app.db.insert(boqs).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      contractId: body.contractId ?? null,
      name: body.name,
      method: body.method,
      currency,
      notes: body.notes ?? null,
      status: "draft",
      createdBy: req.user!.id,
    });
    await ledger(req, "create", "boq", id, {
      name: body.name,
      method: body.method,
      currency,
    });
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

  app.get("/boqs/:boqId", { preHandler: subRead }, async (req, reply) => {
    const { boqId } = req.params as { boqId: string };
    const boq = await fetchBoq(boqId, req.companyId!);
    await requireCommercialLevel(app, req, reply, boq.projectId, "read");
    const rows = await app.db
      .select()
      .from(boqItems)
      .where(eq(boqItems.boqId, boqId))
      .orderBy(asc(boqItems.path), asc(boqItems.sortOrder));
    const leaves = rows.filter((r) => r.level === "item");
    const totalAmount = round2(leaves.reduce((s, r) => s + (r.amount ?? 0), 0));
    return { ...boq, items: buildTree(rows), itemCount: rows.length, totalAmount };
  });

  app.patch("/boqs/:boqId", { preHandler: subWrite }, async (req, reply) => {
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
      if (BOQ_STATUSES.indexOf(body.status) < BOQ_STATUSES.indexOf(boq.status as BoqStatus)) {
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
      boq.projectId,
    );
    return fetchBoq(boqId, req.companyId!);
  });

  app.delete("/boqs/:boqId", { preHandler: subAdmin }, async (req, reply) => {
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

    const itemIds = (
      await app.db.select({ id: boqItems.id }).from(boqItems).where(eq(boqItems.boqId, boqId))
    ).map((r) => r.id);
    // A deleted BoQ must not leave dangling item ids in the variation
    // register: a variation that still cites a vanished BQ item can never be
    // re-valued and its basis silently stops reconciling.
    const referencingVariations =
      itemIds.length === 0
        ? []
        : (
            await app.db
              .select({ id: variations.id, refs: variations.boqItemRefs, status: variations.status })
              .from(variations)
              .where(
                and(
                  eq(variations.companyId, req.companyId!),
                  eq(variations.projectId, boq.projectId),
                ),
              )
          ).filter((v) => v.refs.some((r) => itemIds.includes(r)));
    const blocked = referencingVariations.filter((v) => v.status === "agreed");
    if (blocked.length > 0) {
      throw conflict(
        `BQ items in this bill are cited by ${blocked.length} agreed variation(s); the bill cannot be deleted.`,
      );
    }

    await app.db.transaction(async (tx) => {
      if (itemIds.length > 0) {
        await tx.delete(takeoffLines).where(inArray(takeoffLines.boqItemId, itemIds));
        await tx.delete(provisionalSums).where(inArray(provisionalSums.boqItemId, itemIds));
        for (const v of referencingVariations) {
          await tx
            .update(variations)
            .set({
              boqItemRefs: v.refs.filter((r) => !itemIds.includes(r)),
              updatedAt: new Date().toISOString(),
            })
            .where(eq(variations.id, v.id));
        }
      }
      await tx.delete(boqItems).where(eq(boqItems.boqId, boqId));
      await tx.delete(boqs).where(eq(boqs.id, boqId));
    });
    await ledger(
      req,
      "delete",
      "boq",
      boqId,
      { name: boq.name, variationsStripped: referencingVariations.length },
      boq.projectId,
    );
    return { ok: true };
  });

  app.get("/boqs/:boqId/summary", { preHandler: subRead }, async (req, reply) => {
    const { boqId } = req.params as { boqId: string };
    const boq = await fetchBoq(boqId, req.companyId!);
    await requireCommercialLevel(app, req, reply, boq.projectId, "read");
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
      .sort((a, b) => a.sortOrder - b.sortOrder || compareCodes(a.code, b.code));
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

  /**
   * Method-of-measurement compliance for the whole bill (#117-134). Read-only
   * and deterministic: the same bill always produces the same findings.
   */
  app.get("/boqs/:boqId/measurement-check", { preHandler: subRead }, async (req, reply) => {
    const { boqId } = req.params as { boqId: string };
    const boq = await fetchBoq(boqId, req.companyId!);
    await requireCommercialLevel(app, req, reply, boq.projectId, "read");
    const rows = await app.db.select().from(boqItems).where(eq(boqItems.boqId, boqId));
    const input: MomItemInput[] = orderedItems(rows).map((r) => ({
      id: r.id,
      parentId: r.parentId,
      level: r.level,
      code: r.code,
      description: r.description,
      unit: r.unit,
      quantity: r.quantity,
      rate: r.rate,
      amount: r.amount,
      itemType: r.itemType,
    }));
    return validateBoq(boq.method as BoqMethod, input);
  });

  /* ---------------------------------------------------------------- */
  /* Import / export (#191)                                            */
  /* ---------------------------------------------------------------- */

  app.get("/boqs/:boqId/export", { preHandler: subRead }, async (req, reply) => {
    const { boqId } = req.params as { boqId: string };
    const q = z.object({ format: z.enum(["csv", "json"]).default("csv") }).parse(req.query);
    const boq = await fetchBoq(boqId, req.companyId!);
    await requireCommercialLevel(app, req, reply, boq.projectId, "read");
    const rows = orderedItems(await app.db.select().from(boqItems).where(eq(boqItems.boqId, boqId)));
    if (q.format === "json") {
      return {
        boq: { id: boq.id, name: boq.name, method: boq.method, currency: boq.currency, status: boq.status },
        items: rows.map((r) => ({
          code: r.code,
          description: r.description,
          unit: r.unit,
          quantity: r.quantity,
          rate: r.rate,
          amount: r.amount,
          level: r.level,
          itemType: r.itemType,
        })),
      };
    }
    const header = CANONICAL_FIELDS.join(",");
    const lines = rows.map((r) =>
      [r.code, r.description, r.unit, r.quantity, r.rate, r.amount, r.level, r.itemType]
        .map(csvCell)
        .join(","),
    );
    void reply.header("content-type", "text/csv; charset=utf-8");
    void reply.header(
      "content-disposition",
      `attachment; filename="${boq.name.replace(/[^\w.-]+/g, "_")}.csv"`,
    );
    return [header, ...lines].join("\n");
  });

  /**
   * CSV import with hierarchy inference (#191). The code's depth decides the
   * level unless the file states one; parents are created on demand so a flat
   * export from an estimating package lands as a bill tree.
   */
  app.post("/boqs/:boqId/import", { preHandler: subWrite }, async (req, reply) => {
    const { boqId } = req.params as { boqId: string };
    const body = importSchema.parse(req.body);
    const boq = await fetchBoq(boqId, req.companyId!);
    await requireCommercialLevel(app, req, reply, boq.projectId, "standard");
    if (boq.status !== "draft") throw badRequest("Only a draft BoQ can be imported into");

    const rows = parseCsv(body.content);
    const headerRow = rows[0];
    if (!headerRow) throw badRequest("The file has no header row");
    const mapping = body.mapping ?? {};
    const columns = headerRow.map((h) => {
      const raw = h.trim();
      const mapped = mapping[raw] ?? raw;
      const norm = mapped.toLowerCase().replace(/[^a-z]/g, "");
      const match = CANONICAL_FIELDS.find((f) => f.toLowerCase().replace(/[^a-z]/g, "") === norm);
      return match ?? null;
    });
    if (!columns.includes("code") || !columns.includes("description")) {
      throw badRequest(
        `The file must have at least "code" and "description" columns (found: ${headerRow.join(", ")})`,
      );
    }

    const parsed: Array<{
      code: string;
      description: string;
      unit: string | null;
      quantity: number | null;
      rate: number | null;
      level: "bill" | "section" | "item";
      itemType: string;
      line: number;
    }> = [];
    const errors: string[] = [];
    for (let r = 1; r < rows.length; r += 1) {
      const cells = rows[r]!;
      const rec: Record<string, string> = {};
      columns.forEach((field, i) => {
        if (field) rec[field] = (cells[i] ?? "").trim();
      });
      const code = rec["code"] ?? "";
      const description = rec["description"] ?? "";
      if (!code || !description) {
        errors.push(`Row ${r + 1}: code and description are required.`);
        continue;
      }
      const num = (v: string | undefined): number | null => {
        if (!v) return null;
        const n = Number(v.replace(/[,\s]/g, ""));
        return Number.isFinite(n) ? n : null;
      };
      const levelRaw = (rec["level"] ?? "").toLowerCase();
      const level = (BOQ_LEVELS as readonly string[]).includes(levelRaw)
        ? (levelRaw as "bill" | "section" | "item")
        : levelFromCode(code);
      const itemTypeRaw = rec["itemType"] ?? "";
      const itemType = (BOQ_ITEM_TYPES as readonly string[]).includes(itemTypeRaw)
        ? itemTypeRaw
        : "measured";
      parsed.push({
        code,
        description,
        unit: rec["unit"] || null,
        quantity: num(rec["quantity"]),
        rate: num(rec["rate"]),
        level,
        itemType,
        line: r + 1,
      });
    }
    if (parsed.length === 0) {
      throw badRequest(`No importable rows were found. ${errors.slice(0, 5).join(" ")}`.trim());
    }
    if (parsed.length > 5000) throw badRequest("Import is limited to 5,000 rows per file");

    const created: string[] = [];
    await app.db.transaction(async (tx) => {
      if (body.replace) {
        const existing = (
          await tx.select({ id: boqItems.id }).from(boqItems).where(eq(boqItems.boqId, boqId))
        ).map((r) => r.id);
        if (existing.length > 0) {
          const used = await tx
            .select({ id: valuationLines.id })
            .from(valuationLines)
            .where(inArray(valuationLines.boqItemId, existing))
            .limit(1);
          if (used[0]) {
            throw conflict(
              "Items in this bill are referenced by a valuation; import without `replace` or delete the valuation first.",
            );
          }
          await tx.delete(takeoffLines).where(inArray(takeoffLines.boqItemId, existing));
          await tx.delete(boqItems).where(eq(boqItems.boqId, boqId));
        }
      }
      // codes already present keep their node so an append merges cleanly
      const byCode = new Map<string, { id: string; path: string; level: string }>();
      for (const existing of await tx.select().from(boqItems).where(eq(boqItems.boqId, boqId))) {
        byCode.set(existing.code.trim(), {
          id: existing.id,
          path: existing.path,
          level: existing.level,
        });
      }
      const sortCounters = new Map<string, number>();
      const nextSort = (parentKey: string) => {
        const n = sortCounters.get(parentKey) ?? 0;
        sortCounters.set(parentKey, n + 1);
        return n;
      };

      const parentCodeOf = (code: string): string | null => {
        const parts = code.trim().split(/[.\-/]/).filter(Boolean);
        if (parts.length <= 1) return null;
        return parts.slice(0, -1).join(".");
      };

      const ensure = async (
        code: string,
        description: string,
        level: "bill" | "section" | "item",
        unit: string | null,
        quantity: number | null,
        rate: number | null,
        itemType: string,
      ): Promise<{ id: string; path: string; level: string }> => {
        const key = code.trim();
        const found = byCode.get(key);
        if (found) return found;
        const parentCode = parentCodeOf(key);
        let parent: { id: string; path: string; level: string } | null = null;
        if (parentCode && level !== "bill") {
          parent = await ensure(
            parentCode,
            `Section ${parentCode}`,
            parentCode.split(/[.\-/]/).filter(Boolean).length <= 1 ? "bill" : "section",
            null,
            null,
            null,
            "measured",
          );
        }
        const id = newId("bqi");
        const path = parent ? `${parent.path}/${id}` : id;
        const amount = quantity != null && rate != null ? round2(quantity * rate) : null;
        await tx.insert(boqItems).values({
          id,
          boqId,
          parentId: parent?.id ?? null,
          path,
          level,
          code: key,
          description,
          unit,
          quantity,
          rate,
          amount,
          itemType,
          sortOrder: nextSort(parent?.id ?? "root"),
        });
        const node = { id, path, level };
        byCode.set(key, node);
        created.push(id);
        return node;
      };

      // shallowest codes first so parents exist before their children
      const ordered = [...parsed].sort(
        (a, b) =>
          a.code.split(/[.\-/]/).filter(Boolean).length -
            b.code.split(/[.\-/]/).filter(Boolean).length || compareCodes(a.code, b.code),
      );
      for (const row of ordered) {
        await ensure(
          row.code,
          row.description,
          row.level,
          row.unit,
          row.quantity,
          row.rate,
          row.itemType,
        );
      }
    });

    await ledger(
      req,
      "update",
      "boq",
      boqId,
      { imported: created.length, rejected: errors.length, replace: Boolean(body.replace) },
      boq.projectId,
    );
    return reply.status(201).send({
      imported: created.length,
      rejected: errors.length,
      errors: errors.slice(0, 50),
    });
  });

  /* ---------------------------------------------------------------- */
  /* BQ items                                                          */
  /* ---------------------------------------------------------------- */

  app.post("/boqs/:boqId/items", { preHandler: subWrite }, async (req, reply) => {
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
    const sortOrder = body.sortOrder ?? (await nextSortOrder(boqId, parent?.id ?? null));
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
      sortOrder,
    });
    await ledger(
      req,
      "create",
      "boq_item",
      id,
      { boqId, level: body.level, code: body.code, amount },
      boq.projectId,
    );
    const created = await app.db.select().from(boqItems).where(eq(boqItems.id, id)).limit(1);
    return reply.status(201).send(created[0]);
  });

  app.patch("/boq-items/:itemId", { preHandler: subWrite }, async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const body = itemPatchSchema.parse(req.body);
    const { item, boq } = await fetchItemWithBoq(itemId, req.companyId!);
    await requireCommercialLevel(app, req, reply, boq.projectId, "standard");
    if (boq.status === "agreed") throw badRequest("An agreed BoQ can no longer be edited");

    // The build-up IS the audit trail for the rate. Moving the rate without
    // supplying a new build-up would leave a stored derivation that no longer
    // reconciles, so the caller must either restate it or clear it explicitly.
    const hasStoredBuildUp = Array.isArray(item.rateBuildUp) && item.rateBuildUp.length > 0;
    const changesRate = body.rate !== undefined && body.rate !== item.rate;
    if (hasStoredBuildUp && changesRate && !body.rateBuildUp && !body.clearRateBuildUp) {
      throw badRequest(
        "This item's rate is supported by a build-up. Send a replacement rateBuildUp, or clearRateBuildUp: true to drop the derivation.",
      );
    }

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
    else if (body.clearRateBuildUp) set["rateBuildUp"] = null;

    await app.db.update(boqItems).set(set).where(eq(boqItems.id, itemId));
    await ledger(
      req,
      "update",
      "boq_item",
      itemId,
      {
        changed: Object.keys(body),
        amount,
        buildUpCleared: body.clearRateBuildUp === true && !body.rateBuildUp,
      },
      boq.projectId,
    );
    const updated = await app.db.select().from(boqItems).where(eq(boqItems.id, itemId)).limit(1);
    return updated[0];
  });

  app.delete("/boq-items/:itemId", { preHandler: subAdmin }, async (req, reply) => {
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
    // A valuation line whose BQ item has gone still sums into workDoneToDate
    // while the UI's inner join hides it — invisible money in the application.
    const valued = await app.db
      .select({ id: valuationLines.id })
      .from(valuationLines)
      .where(eq(valuationLines.boqItemId, itemId))
      .limit(1);
    if (valued[0]) {
      throw conflict(
        "This BQ item is referenced by a valuation line and cannot be deleted; remove the valuation first.",
      );
    }
    await app.db.transaction(async (tx) => {
      await tx.delete(takeoffLines).where(eq(takeoffLines.boqItemId, itemId));
      await tx.delete(provisionalSums).where(eq(provisionalSums.boqItemId, itemId));
      await tx.delete(boqItems).where(eq(boqItems.id, itemId));
    });
    await ledger(req, "delete", "boq_item", itemId, { code: item.code }, boq.projectId);
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* Taking-off (#135-140)                                             */
  /* ---------------------------------------------------------------- */

  app.post("/boq-items/:itemId/takeoff", { preHandler: subWrite }, async (req, reply) => {
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
      deduct: body.deduct ?? false,
      createdBy: req.user!.id,
    });
    await ledger(
      req,
      "create",
      "takeoff_line",
      id,
      { boqItemId: itemId, quantity, isManual, deduct: body.deduct ?? false },
      boq.projectId,
    );
    const created = await app.db
      .select()
      .from(takeoffLines)
      .where(eq(takeoffLines.id, id))
      .limit(1);
    return reply.status(201).send(created[0]);
  });

  app.get("/boq-items/:itemId/takeoff", { preHandler: subRead }, async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const { boq } = await fetchItemWithBoq(itemId, req.companyId!);
    await requireCommercialLevel(app, req, reply, boq.projectId, "read");
    const items = await app.db
      .select()
      .from(takeoffLines)
      .where(eq(takeoffLines.boqItemId, itemId))
      .orderBy(asc(takeoffLines.createdAt));
    const total = round3(items.reduce((s, l) => s + (l.deduct ? -l.quantity : l.quantity), 0));
    return {
      items,
      total,
      added: round3(items.filter((l) => !l.deduct).reduce((s, l) => s + l.quantity, 0)),
      deducted: round3(items.filter((l) => l.deduct).reduce((s, l) => s + l.quantity, 0)),
    };
  });

  app.delete("/takeoff-lines/:lineId", { preHandler: subAdmin }, async (req, reply) => {
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
    await ledger(
      req,
      "delete",
      "takeoff_line",
      lineId,
      { boqItemId: line.boqItemId },
      boq.projectId,
    );
    return { ok: true };
  });

  /**
   * Apply the dimension sheet to the BQ item — the item quantity becomes the
   * net of its taking-off lines (additions less deductions), giving every
   * quantity a measured provenance (#139-140).
   */
  app.post("/boq-items/:itemId/takeoff/apply", { preHandler: subWrite }, async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const { item, boq } = await fetchItemWithBoq(itemId, req.companyId!);
    await requireCommercialLevel(app, req, reply, boq.projectId, "standard");
    if (boq.status === "agreed") throw badRequest("An agreed BoQ can no longer be measured");
    const lines = await app.db
      .select({ quantity: takeoffLines.quantity, deduct: takeoffLines.deduct })
      .from(takeoffLines)
      .where(eq(takeoffLines.boqItemId, itemId));
    if (lines.length === 0) throw badRequest("No taking-off lines to apply");
    const quantity = round3(
      lines.reduce((s, l) => s + (l.deduct ? -l.quantity : l.quantity), 0),
    );
    if (quantity < 0) {
      throw badRequest(
        `The dimension sheet nets to ${quantity}; deductions exceed additions, so the item quantity would be negative.`,
      );
    }
    const amount = item.rate != null ? round2(quantity * item.rate) : null;
    await app.db
      .update(boqItems)
      .set({ quantity, amount, updatedAt: new Date().toISOString() })
      .where(eq(boqItems.id, itemId));
    await ledger(
      req,
      "update",
      "boq_item",
      itemId,
      { quantity, amount, source: "taking_off", appliedLines: lines.length },
      boq.projectId,
    );
    const updated = await app.db.select().from(boqItems).where(eq(boqItems.id, itemId)).limit(1);
    return updated[0];
  });
};
