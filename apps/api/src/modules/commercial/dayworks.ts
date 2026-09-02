import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { contracts, dayworkItems, dayworkSheets, variations } from "@constructos/db";
import { DAYWORK_BASES, DAYWORK_RESOURCE_KINDS, DAYWORK_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import { isoDateSchema, requireCommercialLevel, round2, subResourceGate } from "./shared.js";

const percentAdditionsSchema = z.object({
  labour: z.number().min(0).max(500).optional(),
  material: z.number().min(0).max(500).optional(),
  plant: z.number().min(0).max(500).optional(),
});

const sheetCreateSchema = z.object({
  workDate: isoDateSchema,
  description: z.string().min(1).max(1000),
  location: z.string().max(300).nullable().optional(),
  reference: z.string().max(100).nullable().optional(),
  instructionRef: z.string().max(200).nullable().optional(),
  basis: z.enum(DAYWORK_BASES).optional(),
  contractId: z.string().nullable().optional(),
  variationId: z.string().nullable().optional(),
  percentAdditions: percentAdditionsSchema.optional(),
  currency: z.string().min(3).max(8).optional(),
});

const sheetPatchSchema = sheetCreateSchema.partial().omit({ currency: true });

const itemSchema = z.object({
  kind: z.enum(DAYWORK_RESOURCE_KINDS),
  description: z.string().min(1).max(500),
  unit: z.string().max(20).nullable().optional(),
  qty: z.number().positive(),
  rate: z.number().nonnegative(),
  resourceRef: z.string().max(100).nullable().optional(),
});

const sheetListQuery = pageQuerySchema.extend({
  status: z.enum(DAYWORK_STATUSES).optional(),
  variationId: z.string().optional(),
});

const rejectSchema = z.object({ reason: z.string().min(3).max(2000) });

/** The percentage-addition key each resource class uses. */
const ADDITION_KEY: Record<string, string> = {
  labour: "labour",
  material: "material",
  plant: "plant",
};

/**
 * Recompute a sheet's totals from its items and the percentage additions
 * (#132): each line's uplift comes from its own resource class, so a daywork
 * schedule with 80% on labour and 10% on plant prices correctly.
 */
async function recomputeSheet(db: Db, sheetId: string): Promise<void> {
  const rows = await db.select().from(dayworkSheets).where(eq(dayworkSheets.id, sheetId)).limit(1);
  const sheet = rows[0];
  if (!sheet) throw notFound("Daywork sheet not found");
  const items = await db.select().from(dayworkItems).where(eq(dayworkItems.sheetId, sheetId));
  const additions = sheet.percentAdditions ?? {};
  let net = 0;
  let addition = 0;
  for (const item of items) {
    const amount = round2(item.qty * item.rate);
    const pct = additions[ADDITION_KEY[item.kind] ?? ""] ?? 0;
    const withAddition = round2(amount * (1 + pct / 100));
    net += amount;
    addition += withAddition - amount;
    await db
      .update(dayworkItems)
      .set({ amount, percentAddition: pct, amountWithAddition: withAddition })
      .where(eq(dayworkItems.id, item.id));
  }
  await db
    .update(dayworkSheets)
    .set({
      netTotal: round2(net),
      additionTotal: round2(addition),
      grossTotal: round2(net + addition),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(dayworkSheets.id, sheetId));
}

/**
 * Daywork sheets (spec Vol II Domain B #150-161, #132).
 *
 * A daywork sheet is a two-party site record: the contractor submits the
 * resources used, the administrator verifies them, and only a VERIFIED sheet
 * can be valued into an application. Verification is refused to the submitter
 * — a sheet signed off by the person who wrote it is not a verification.
 */
export const dayworkRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("commercial", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("commercial", "standard"),
  ];
  const subRead = subResourceGate(app, "read");
  const subWrite = subResourceGate(app, "standard");
  const subAdmin = subResourceGate(app, "admin");

  async function fetchSheet(sheetId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(dayworkSheets)
      .where(and(eq(dayworkSheets.id, sheetId), eq(dayworkSheets.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Daywork sheet not found");
    return rows[0];
  }

  async function sheetWithItems(sheetId: string, companyId: string) {
    const sheet = await fetchSheet(sheetId, companyId);
    const items = await app.db
      .select()
      .from(dayworkItems)
      .where(eq(dayworkItems.sheetId, sheetId))
      .orderBy(asc(dayworkItems.sequence));
    return { ...sheet, items };
  }

  async function ledger(
    req: { companyId?: string; user?: { id: string } },
    action: "create" | "update" | "delete" | "state_change",
    objectId: string,
    payload: unknown,
    projectId: string,
    storePayload = false,
  ) {
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action,
      objectType: "daywork_sheet",
      objectId,
      payload,
      projectId,
      storePayload,
    });
  }

  app.post("/projects/:projectId/daywork-sheets", { preHandler: standardGate }, async (req, reply) => {
    const body = sheetCreateSchema.parse(req.body);
    let currency = body.currency ?? null;
    if (body.contractId) {
      const c = await app.db
        .select({ id: contracts.id, currency: contracts.currency })
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
      currency = c[0].currency;
    }
    if (body.variationId) {
      const v = await app.db
        .select({ id: variations.id, currency: variations.currency })
        .from(variations)
        .where(
          and(
            eq(variations.id, body.variationId),
            eq(variations.companyId, req.companyId!),
            eq(variations.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!v[0]) throw badRequest("variationId does not reference a variation on this project");
      currency = currency ?? v[0].currency;
    }

    const number = await nextRecordNumber(app.db, req.projectId!, "daywork_sheet");
    const id = newId("dws");
    await app.db.insert(dayworkSheets).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      contractId: body.contractId ?? null,
      variationId: body.variationId ?? null,
      number,
      reference: body.reference ?? null,
      workDate: body.workDate,
      description: body.description,
      location: body.location ?? null,
      instructionRef: body.instructionRef ?? null,
      basis: body.basis ?? "schedule_rates",
      status: "draft",
      currency: currency ?? "USD",
      percentAdditions: body.percentAdditions ?? {},
      createdBy: req.user!.id,
    });
    await ledger(req, "create", id, { number, workDate: body.workDate }, req.projectId!);
    return reply.status(201).send(await sheetWithItems(id, req.companyId!));
  });

  app.get("/projects/:projectId/daywork-sheets", { preHandler: readGate }, async (req) => {
    const q = sheetListQuery.parse(req.query);
    const clauses = [
      eq(dayworkSheets.companyId, req.companyId!),
      eq(dayworkSheets.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(dayworkSheets.status, q.status));
    if (q.variationId) clauses.push(eq(dayworkSheets.variationId, q.variationId));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(dayworkSheets).where(where);
    const items = await app.db
      .select()
      .from(dayworkSheets)
      .where(where)
      .orderBy(desc(dayworkSheets.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));

    // register position, bucketed by currency and by status
    const all = await app.db
      .select({
        status: dayworkSheets.status,
        currency: dayworkSheets.currency,
        grossTotal: dayworkSheets.grossTotal,
      })
      .from(dayworkSheets)
      .where(
        and(
          eq(dayworkSheets.companyId, req.companyId!),
          eq(dayworkSheets.projectId, req.projectId!),
        ),
      );
    const byCurrency = new Map<string, { verified: number; pending: number }>();
    for (const s of all) {
      const bucket = byCurrency.get(s.currency) ?? { verified: 0, pending: 0 };
      if (s.status === "verified" || s.status === "valued") bucket.verified += s.grossTotal;
      else if (s.status === "submitted" || s.status === "draft") bucket.pending += s.grossTotal;
      byCurrency.set(s.currency, bucket);
    }
    return {
      ...paginate(items, Number(totalRow?.n ?? 0), q),
      byCurrency: [...byCurrency.entries()].map(([currency, b]) => ({
        currency,
        verified: round2(b.verified),
        pending: round2(b.pending),
      })),
    };
  });

  app.get("/daywork-sheets/:sheetId", { preHandler: subRead }, async (req, reply) => {
    const { sheetId } = req.params as { sheetId: string };
    const sheet = await fetchSheet(sheetId, req.companyId!);
    await requireCommercialLevel(app, req, reply, sheet.projectId, "read");
    return sheetWithItems(sheetId, req.companyId!);
  });

  app.patch("/daywork-sheets/:sheetId", { preHandler: subWrite }, async (req, reply) => {
    const { sheetId } = req.params as { sheetId: string };
    const body = sheetPatchSchema.parse(req.body);
    const sheet = await fetchSheet(sheetId, req.companyId!);
    await requireCommercialLevel(app, req, reply, sheet.projectId, "standard");
    if (sheet.status !== "draft") throw badRequest("Only a draft daywork sheet can be edited");
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const [k, v] of Object.entries(body)) if (v !== undefined) set[k] = v;
    await app.db.transaction(async (tx) => {
      await tx.update(dayworkSheets).set(set).where(eq(dayworkSheets.id, sheetId));
      await recomputeSheet(tx, sheetId);
    });
    await ledger(req, "update", sheetId, { changed: Object.keys(body) }, sheet.projectId);
    return sheetWithItems(sheetId, req.companyId!);
  });

  app.post("/daywork-sheets/:sheetId/items", { preHandler: subWrite }, async (req, reply) => {
    const { sheetId } = req.params as { sheetId: string };
    const body = itemSchema.parse(req.body);
    const sheet = await fetchSheet(sheetId, req.companyId!);
    await requireCommercialLevel(app, req, reply, sheet.projectId, "standard");
    if (sheet.status !== "draft") throw badRequest("Only a draft daywork sheet can be edited");
    const [seqRow] = await app.db
      .select({ n: count() })
      .from(dayworkItems)
      .where(eq(dayworkItems.sheetId, sheetId));
    const id = newId("dwi");
    await app.db.transaction(async (tx) => {
      await tx.insert(dayworkItems).values({
        id,
        sheetId,
        kind: body.kind,
        description: body.description,
        unit: body.unit ?? null,
        qty: body.qty,
        rate: body.rate,
        amount: round2(body.qty * body.rate),
        percentAddition: 0,
        amountWithAddition: round2(body.qty * body.rate),
        resourceRef: body.resourceRef ?? null,
        sequence: Number(seqRow?.n ?? 0),
      });
      await recomputeSheet(tx, sheetId);
    });
    await ledger(
      req,
      "update",
      sheetId,
      { addedItem: id, kind: body.kind, amount: round2(body.qty * body.rate) },
      sheet.projectId,
    );
    return reply.status(201).send(await sheetWithItems(sheetId, req.companyId!));
  });

  app.delete("/daywork-items/:itemId", { preHandler: subWrite }, async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const rows = await app.db
      .select({ item: dayworkItems, sheet: dayworkSheets })
      .from(dayworkItems)
      .innerJoin(dayworkSheets, eq(dayworkSheets.id, dayworkItems.sheetId))
      .where(and(eq(dayworkItems.id, itemId), eq(dayworkSheets.companyId, req.companyId!)))
      .limit(1);
    if (!rows[0]) throw notFound("Daywork item not found");
    const { sheet } = rows[0];
    await requireCommercialLevel(app, req, reply, sheet.projectId, "standard");
    if (sheet.status !== "draft") throw badRequest("Only a draft daywork sheet can be edited");
    await app.db.transaction(async (tx) => {
      await tx.delete(dayworkItems).where(eq(dayworkItems.id, itemId));
      await recomputeSheet(tx, sheet.id);
    });
    await ledger(req, "update", sheet.id, { removedItem: itemId }, sheet.projectId);
    return sheetWithItems(sheet.id, req.companyId!);
  });

  app.post("/daywork-sheets/:sheetId/submit", { preHandler: subWrite }, async (req, reply) => {
    const { sheetId } = req.params as { sheetId: string };
    const sheet = await fetchSheet(sheetId, req.companyId!);
    await requireCommercialLevel(app, req, reply, sheet.projectId, "standard");
    if (sheet.status !== "draft") throw badRequest("Only a draft daywork sheet can be submitted");
    const [itemCount] = await app.db
      .select({ n: count() })
      .from(dayworkItems)
      .where(eq(dayworkItems.sheetId, sheetId));
    if (Number(itemCount?.n ?? 0) === 0) {
      throw badRequest("A daywork sheet needs at least one resource line before it is submitted");
    }
    const now = new Date().toISOString();
    await app.db.transaction(async (tx) => {
      await recomputeSheet(tx, sheetId);
      await tx
        .update(dayworkSheets)
        .set({ status: "submitted", submittedBy: req.user!.id, submittedAt: now, updatedAt: now })
        .where(and(eq(dayworkSheets.id, sheetId), eq(dayworkSheets.status, "draft")));
    });
    const submitted = await fetchSheet(sheetId, req.companyId!);
    await ledger(
      req,
      "state_change",
      sheetId,
      { from: "draft", to: "submitted", grossTotal: submitted.grossTotal },
      sheet.projectId,
      true,
    );
    return submitted;
  });

  /** Verification is the independent test of the contractor's assertion. */
  app.post("/daywork-sheets/:sheetId/verify", { preHandler: subAdmin }, async (req, reply) => {
    const { sheetId } = req.params as { sheetId: string };
    const sheet = await fetchSheet(sheetId, req.companyId!);
    await requireCommercialLevel(app, req, reply, sheet.projectId, "admin");
    if (sheet.status !== "submitted") {
      throw badRequest("Only a submitted daywork sheet can be verified");
    }
    if (sheet.submittedBy === req.user!.id || sheet.createdBy === req.user!.id) {
      throw forbidden(
        "A daywork sheet must be verified by someone other than the person who recorded or submitted it",
      );
    }
    const now = new Date().toISOString();
    await app.db
      .update(dayworkSheets)
      .set({ status: "verified", verifiedBy: req.user!.id, verifiedAt: now, updatedAt: now })
      .where(and(eq(dayworkSheets.id, sheetId), eq(dayworkSheets.status, "submitted")));
    await ledger(
      req,
      "state_change",
      sheetId,
      { from: "submitted", to: "verified", grossTotal: sheet.grossTotal },
      sheet.projectId,
      true,
    );
    return fetchSheet(sheetId, req.companyId!);
  });

  app.post("/daywork-sheets/:sheetId/reject", { preHandler: subAdmin }, async (req, reply) => {
    const { sheetId } = req.params as { sheetId: string };
    const body = rejectSchema.parse(req.body);
    const sheet = await fetchSheet(sheetId, req.companyId!);
    await requireCommercialLevel(app, req, reply, sheet.projectId, "admin");
    if (sheet.status !== "submitted") {
      throw badRequest("Only a submitted daywork sheet can be rejected");
    }
    if (sheet.submittedBy === req.user!.id) {
      throw forbidden("A daywork sheet cannot be rejected by the person who submitted it");
    }
    await app.db
      .update(dayworkSheets)
      .set({
        status: "rejected",
        rejectionReason: body.reason,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(dayworkSheets.id, sheetId), eq(dayworkSheets.status, "submitted")));
    await ledger(
      req,
      "state_change",
      sheetId,
      { from: "submitted", to: "rejected", reason: body.reason },
      sheet.projectId,
      true,
    );
    return fetchSheet(sheetId, req.companyId!);
  });
};
