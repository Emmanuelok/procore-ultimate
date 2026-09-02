/**
 * LONG-LEAD register routes (spec #918–921; Vol I #719–720, #727–728).
 *
 * Milestones are recorded in order and stamp actual dates; every write
 * re-runs the engine so `orderByDate`, `floatDays` and `riskLevel` are never
 * stale on the row the register reads.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import { longLeadExpeditingLog, longLeadItems } from "@constructos/db";
import {
  EXPEDITING_ACTIONS,
  INCOTERMS,
  LONG_LEAD_MILESTONES,
  LONG_LEAD_RISK_LEVELS,
  LONG_LEAD_STATUSES,
} from "@constructos/shared";
import { badRequest, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { milestoneAllowed, statusAfterMilestone } from "../engines/longLead.js";
import { assessItem, loadLongLeadContext, persistAssessment, sweepLongLead } from "../service.js";
import {
  allocateReference,
  assertMaterialItem,
  assertNode,
  assertVendor,
  buildGates,
  countryCodeSchema,
  idSchema,
  isoDateSchema,
  ledger,
  loadTask,
  nowISO,
  patchSchemaOf,
  patchSet,
  todayISO,
} from "../shared.js";

const itemBodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).nullable().optional(),
  category: z.string().max(80).nullable().optional(),
  supplierNodeId: idSchema.nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  commitmentId: idSchema.nullable().optional(),
  purchaseOrderRef: z.string().max(80).nullable().optional(),
  materialItemId: idSchema.nullable().optional(),
  scheduleTaskId: idSchema.nullable().optional(),
  requiredOnSite: isoDateSchema.nullable().optional(),
  leadTimeDays: z.number().int().min(0).max(2000).default(0),
  bufferDays: z.number().int().min(0).max(365).default(0),
  plannedOrderDate: isoDateSchema.nullable().optional(),
  plannedProductionStart: isoDateSchema.nullable().optional(),
  plannedShipDate: isoDateSchema.nullable().optional(),
  plannedArrivalDate: isoDateSchema.nullable().optional(),
  forecastArrivalDate: isoDateSchema.nullable().optional(),
  quantity: z.number().min(0).nullable().optional(),
  unit: z.string().max(20).nullable().optional(),
  value: z.number().min(0).nullable().optional(),
  currency: z.string().length(3).toUpperCase().optional(),
  incoterms: z.enum(INCOTERMS).nullable().optional(),
  originCountry: countryCodeSchema.nullable().optional(),
  customsRequired: z.boolean().default(false),
  expeditingOwnerId: idSchema.nullable().optional(),
});

const itemPatchSchema = patchSchemaOf(itemBodySchema);

const listSchema = pageQuerySchema.extend({
  status: z.enum(LONG_LEAD_STATUSES).optional(),
  riskLevel: z.enum(LONG_LEAD_RISK_LEVELS).optional(),
  supplierNodeId: idSchema.optional(),
  scheduleTaskId: idSchema.optional(),
  q: z.string().max(120).optional(),
});

const milestoneSchema = z.object({
  milestone: z.enum(LONG_LEAD_MILESTONES),
  at: isoDateSchema.optional(),
  note: z.string().max(2000).optional(),
});

const expediteSchema = z.object({
  action: z.enum(EXPEDITING_ACTIONS),
  note: z.string().max(4000).nullable().optional(),
  contactName: z.string().max(120).nullable().optional(),
  promisedDate: isoDateSchema.nullable().optional(),
});

export const longLeadRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);

  async function loadItem(companyId: string, projectId: string, itemId: string) {
    const [row] = await app.db
      .select()
      .from(longLeadItems)
      .where(and(eq(longLeadItems.id, itemId), eq(longLeadItems.companyId, companyId), eq(longLeadItems.projectId, projectId)))
      .limit(1);
    if (!row) throw notFound("Long-lead item not found");
    return row;
  }

  async function validateRefs(companyId: string, projectId: string, body: Partial<z.infer<typeof itemBodySchema>>) {
    if (body.vendorId) await assertVendor(app.db, companyId, body.vendorId);
    if (body.supplierNodeId) await assertNode(app.db, projectId, body.supplierNodeId);
    if (body.materialItemId) await assertMaterialItem(app.db, companyId, body.materialItemId);
    if (body.scheduleTaskId) await loadTask(app.db, projectId, body.scheduleTaskId);
  }

  app.get("/projects/:projectId/supply-chain/long-lead", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = listSchema.parse(req.query);
    const where = and(
      eq(longLeadItems.companyId, req.companyId!),
      eq(longLeadItems.projectId, projectId),
      q.status ? eq(longLeadItems.status, q.status) : undefined,
      q.riskLevel ? eq(longLeadItems.riskLevel, q.riskLevel) : undefined,
      q.supplierNodeId ? eq(longLeadItems.supplierNodeId, q.supplierNodeId) : undefined,
      q.scheduleTaskId ? eq(longLeadItems.scheduleTaskId, q.scheduleTaskId) : undefined,
      q.q ? or(ilike(longLeadItems.name, `%${q.q}%`), ilike(longLeadItems.reference, `%${q.q}%`), ilike(longLeadItems.purchaseOrderRef, `%${q.q}%`)) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(longLeadItems).where(where).orderBy(asc(longLeadItems.orderByDate), asc(longLeadItems.number)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(longLeadItems).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post("/projects/:projectId/supply-chain/long-lead", { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = itemBodySchema.parse(req.body);
    const companyId = req.companyId!;
    await validateRefs(companyId, projectId, body);
    const { number, reference } = await allocateReference(app.db, projectId, "long_lead_item", "LLI");
    const id = newId("lli");
    const [inserted] = await app.db
      .insert(longLeadItems)
      .values({
        id,
        companyId,
        projectId,
        number,
        reference,
        name: body.name,
        description: body.description ?? null,
        category: body.category ?? null,
        supplierNodeId: body.supplierNodeId ?? null,
        vendorId: body.vendorId ?? null,
        commitmentId: body.commitmentId ?? null,
        purchaseOrderRef: body.purchaseOrderRef ?? null,
        materialItemId: body.materialItemId ?? null,
        scheduleTaskId: body.scheduleTaskId ?? null,
        requiredOnSite: body.requiredOnSite ?? null,
        requiredFromSchedule: body.scheduleTaskId && !body.requiredOnSite ? 1 : 0,
        leadTimeDays: body.leadTimeDays,
        bufferDays: body.bufferDays,
        plannedOrderDate: body.plannedOrderDate ?? null,
        plannedProductionStart: body.plannedProductionStart ?? null,
        plannedShipDate: body.plannedShipDate ?? null,
        plannedArrivalDate: body.plannedArrivalDate ?? null,
        forecastArrivalDate: body.forecastArrivalDate ?? null,
        quantity: body.quantity ?? null,
        unit: body.unit ?? null,
        value: body.value ?? null,
        currency: body.currency ?? "USD",
        incoterms: body.incoterms ?? null,
        originCountry: body.originCountry ?? null,
        customsRequired: body.customsRequired ? 1 : 0,
        expeditingOwnerId: body.expeditingOwnerId ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    const ctx = await loadLongLeadContext(app.db, projectId, [inserted!]);
    const { row, assessed } = await persistAssessment(app.db, inserted!, ctx, todayISO(), req.user!.id);
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "create", objectType: "long_lead_item", objectId: id, payload: { reference, name: body.name, orderByDate: assessed.assessment.orderByDate, riskLevel: assessed.assessment.riskLevel } });
    return reply.code(201).send({ ...row, assessment: assessed.assessment });
  });

  app.get("/projects/:projectId/supply-chain/long-lead/:itemId", { preHandler: readGate }, async (req) => {
    const { projectId, itemId } = req.params as { projectId: string; itemId: string };
    const row = await loadItem(req.companyId!, projectId, itemId);
    const [log, ctx] = await Promise.all([
      app.db.select().from(longLeadExpeditingLog).where(eq(longLeadExpeditingLog.itemId, itemId)).orderBy(desc(longLeadExpeditingLog.loggedAt)),
      loadLongLeadContext(app.db, projectId, [row]),
    ]);
    const assessed = assessItem(row, ctx, todayISO());
    return {
      ...row,
      expeditingLog: log,
      assessment: assessed.assessment,
      task: row.scheduleTaskId ? (ctx.tasks.get(row.scheduleTaskId) ?? null) : null,
      supplierNode: row.supplierNodeId ? (ctx.nodes.get(row.supplierNodeId) ?? null) : null,
      obligationId: typeof row.detail["obligationId"] === "string" ? row.detail["obligationId"] : null,
    };
  });

  app.patch("/projects/:projectId/supply-chain/long-lead/:itemId", { preHandler: standardGate }, async (req) => {
    const { projectId, itemId } = req.params as { projectId: string; itemId: string };
    const body = itemPatchSchema.parse(req.body);
    const companyId = req.companyId!;
    const current = await loadItem(companyId, projectId, itemId);
    if (current.status === "cancelled") throw badRequest("A cancelled item is read-only.");
    await validateRefs(companyId, projectId, body);
    const set = patchSet(body as Record<string, unknown>, [
      "name", "description", "category", "supplierNodeId", "vendorId", "commitmentId", "purchaseOrderRef", "materialItemId", "scheduleTaskId", "requiredOnSite", "leadTimeDays", "bufferDays", "plannedOrderDate", "plannedProductionStart", "plannedShipDate", "plannedArrivalDate", "forecastArrivalDate", "quantity", "unit", "value", "currency", "incoterms", "originCountry", "expeditingOwnerId",
    ]);
    if (body.customsRequired !== undefined) set["customsRequired"] = body.customsRequired ? 1 : 0;
    // A typed need date takes the item off the programme; a task link without one puts it back on.
    if (body.requiredOnSite !== undefined) set["requiredFromSchedule"] = body.requiredOnSite ? 0 : 1;
    else if (body.scheduleTaskId) set["requiredFromSchedule"] = current.requiredOnSite && current.requiredFromSchedule === 0 ? 0 : 1;
    const [updated] = await app.db.update(longLeadItems).set(set).where(eq(longLeadItems.id, itemId)).returning();
    const ctx = await loadLongLeadContext(app.db, projectId, [updated!]);
    const { row, assessed } = await persistAssessment(app.db, updated!, ctx, todayISO(), req.user!.id);
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "update", objectType: "long_lead_item", objectId: itemId, payload: { ...body, riskLevel: assessed.assessment.riskLevel } });
    return { ...row, assessment: assessed.assessment };
  });

  app.post("/projects/:projectId/supply-chain/long-lead/:itemId/milestones", { preHandler: standardGate }, async (req) => {
    const { projectId, itemId } = req.params as { projectId: string; itemId: string };
    const body = milestoneSchema.parse(req.body);
    const companyId = req.companyId!;
    const current = await loadItem(companyId, projectId, itemId);
    const next = statusAfterMilestone(body.milestone);
    if (!next) throw badRequest(`Unknown milestone ${body.milestone}`);
    const allowed = milestoneAllowed(current.status, next);
    if (!allowed.ok) throw badRequest(allowed.reason ?? "Milestone not allowed");
    const at = body.at ?? todayISO();
    const set: Record<string, unknown> = { status: next, updatedAt: nowISO() };
    switch (body.milestone) {
      case "ordered":
        set["actualOrderDate"] = at;
        break;
      case "production_started":
        set["actualProductionStart"] = at;
        break;
      case "shipped":
        set["actualShipDate"] = at;
        break;
      case "customs_cleared":
        set["customsClearedAt"] = at;
        break;
      case "arrived":
        set["actualArrivalDate"] = at;
        break;
      case "installed":
        set["installedAt"] = at;
        if (!current.actualArrivalDate) set["actualArrivalDate"] = at;
        break;
      default:
        break;
    }
    const [updated] = await app.db.update(longLeadItems).set(set).where(eq(longLeadItems.id, itemId)).returning();
    const ctx = await loadLongLeadContext(app.db, projectId, [updated!]);
    const { row, assessed } = await persistAssessment(app.db, updated!, ctx, todayISO(), req.user!.id);
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "state_change", objectType: "long_lead_item", objectId: itemId, payload: { from: current.status, to: next, milestone: body.milestone, at, note: body.note ?? null } });
    return { ...row, assessment: assessed.assessment };
  });

  app.post("/projects/:projectId/supply-chain/long-lead/:itemId/cancel", { preHandler: standardGate }, async (req) => {
    const { projectId, itemId } = req.params as { projectId: string; itemId: string };
    const body = z.object({ reason: z.string().min(1).max(2000) }).parse(req.body);
    const companyId = req.companyId!;
    const current = await loadItem(companyId, projectId, itemId);
    if (current.status === "installed") throw badRequest("An installed item cannot be cancelled.");
    if (current.status === "cancelled") throw badRequest("Already cancelled.");
    const [updated] = await app.db
      .update(longLeadItems)
      .set({ status: "cancelled", detail: { ...current.detail, cancelReason: body.reason }, updatedAt: nowISO() })
      .where(eq(longLeadItems.id, itemId))
      .returning();
    const ctx = await loadLongLeadContext(app.db, projectId, [updated!]);
    const { row } = await persistAssessment(app.db, updated!, ctx, todayISO(), req.user!.id);
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "state_change", objectType: "long_lead_item", objectId: itemId, payload: { from: current.status, to: "cancelled", reason: body.reason } });
    return row;
  });

  app.post("/projects/:projectId/supply-chain/long-lead/:itemId/expedite", { preHandler: standardGate }, async (req, reply) => {
    const { projectId, itemId } = req.params as { projectId: string; itemId: string };
    const body = expediteSchema.parse(req.body);
    const companyId = req.companyId!;
    const current = await loadItem(companyId, projectId, itemId);
    if (current.status === "cancelled" || current.status === "installed") throw badRequest(`Nothing to expedite on a ${current.status} item.`);
    const loggedAt = nowISO();
    const logId = newId("llx");
    await app.db.insert(longLeadExpeditingLog).values({
      id: logId,
      companyId,
      projectId,
      itemId,
      action: body.action,
      note: body.note ?? null,
      contactName: body.contactName ?? null,
      promisedDate: body.promisedDate ?? null,
      loggedBy: req.user!.id,
      loggedAt,
    });
    const set: Record<string, unknown> = { lastExpeditedAt: loggedAt, expeditingCount: current.expeditingCount + 1, updatedAt: loggedAt };
    if (body.promisedDate) set["forecastArrivalDate"] = body.promisedDate;
    const [updated] = await app.db.update(longLeadItems).set(set).where(eq(longLeadItems.id, itemId)).returning();
    const ctx = await loadLongLeadContext(app.db, projectId, [updated!]);
    const { row, assessed } = await persistAssessment(app.db, updated!, ctx, todayISO(), req.user!.id);
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "update", objectType: "long_lead_expediting", objectId: logId, payload: { itemId, action: body.action, promisedDate: body.promisedDate ?? null } });
    return reply.code(201).send({ ...row, assessment: assessed.assessment, logId });
  });

  app.post("/projects/:projectId/supply-chain/long-lead/recompute", { preHandler: standardGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const result = await sweepLongLead(app.db, req.companyId!, projectId, req.user!.id, todayISO());
    return result;
  });
};
