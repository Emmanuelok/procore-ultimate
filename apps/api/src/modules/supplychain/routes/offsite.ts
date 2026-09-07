/**
 * OFFSITE / MODULAR PRODUCTION routes (spec #922–929).
 *
 * A unit is tracked from design to factory to site to installation under one
 * identifier (#927–928). Stages carry the factory's own progress; QA gates are
 * recorded by a verifier who is NOT the person who completed the stage; and
 * the percent a valuation may rely on (#924) comes only from inspections by
 * someone who completed none of the stages — the assertion and the evidence
 * that tests it never share an author.
 *
 * That figure is the MOST RECENT inspection that still stands, never the
 * highest ever recorded, and a mis-recorded inspection can be withdrawn
 * (POST .../inspections/:id/void) by a second person: an inspector's typo
 * must never become a permanent over-certification a payment draws on.
 *
 * Reads do not write. GET /units/:unitId computes the rollup for the
 * response only; the write paths persist it.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import { factoryInspections, longLeadItems, materialTraceRecords, offsiteProductionStages, offsiteUnits } from "@constructos/db";
import {
  FACTORY_INSPECTION_KINDS,
  FACTORY_INSPECTION_RESULTS,
  OFFSITE_UNIT_STATUSES,
  OFFSITE_UNIT_TYPES,
  type OffsiteUnitStatus,
} from "@constructos/shared";
import { badRequest, forbidden, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { transitionAllowed } from "../engines/offsite.js";
import { computeUnit, loadLongLeadContext, recomputeUnit } from "../service.js";
import {
  allocateReference,
  assertLocation,
  assertNode,
  assertVendor,
  buildGates,
  currencyCodeSchema,
  fileIdsSchema,
  idSchema,
  isoDateSchema,
  ledger,
  loadTask,
  nowISO,
  patchSchemaOf,
  patchSet,
  raiseSignal,
  todayISO,
} from "../shared.js";

const stageInputSchema = z.object({
  name: z.string().min(1).max(200),
  position: z.number().int().min(0).max(1000).optional(),
  isQaGate: z.boolean().default(false),
  plannedStart: isoDateSchema.nullable().optional(),
  plannedEnd: isoDateSchema.nullable().optional(),
});

const unitBodySchema = z.object({
  name: z.string().min(1).max(200),
  unitType: z.enum(OFFSITE_UNIT_TYPES).default("volumetric_module"),
  serialNumber: z.string().max(120).nullable().optional(),
  designReference: z.string().max(120).nullable().optional(),
  factoryNodeId: idSchema.nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  longLeadItemId: idSchema.nullable().optional(),
  locationId: idSchema.nullable().optional(),
  scheduleTaskId: idSchema.nullable().optional(),
  plannedProductionStart: isoDateSchema.nullable().optional(),
  plannedProductionEnd: isoDateSchema.nullable().optional(),
  plannedDeliveryDate: isoDateSchema.nullable().optional(),
  value: z.number().min(0).nullable().optional(),
  currency: currencyCodeSchema.optional(),
  transportKm: z.number().min(0).nullable().optional(),
  weightTonnes: z.number().min(0).nullable().optional(),
  storageLocationText: z.string().max(300).nullable().optional(),
  stages: z.array(stageInputSchema).max(100).default([]),
});

const unitPatchSchema = patchSchemaOf(unitBodySchema.omit({ stages: true }));
const stagePatchSchema = patchSchemaOf(stageInputSchema);

const unitListSchema = pageQuerySchema.extend({
  status: z.enum(OFFSITE_UNIT_STATUSES).optional(),
  factoryNodeId: idSchema.optional(),
  scheduleTaskId: idSchema.optional(),
  q: z.string().max(120).optional(),
});

const transitionSchema = z.object({
  status: z.enum(OFFSITE_UNIT_STATUSES),
  at: isoDateSchema.optional(),
  note: z.string().max(2000).nullable().optional(),
  /** required for `installed` when the unit has no location yet */
  locationId: idSchema.optional(),
});

const qaSchema = z.object({
  result: z.enum(["passed", "failed", "waived"]),
  notes: z.string().max(4000).nullable().optional(),
  evidenceFileIds: fileIdsSchema.optional(),
});

const vestingSchema = z.object({
  vestingCertificateFileId: idSchema.nullable().optional(),
  vestingCertifiedAt: isoDateSchema.nullable().optional(),
  titleTransferredAt: isoDateSchema.nullable().optional(),
  storageLocationText: z.string().max(300).nullable().optional(),
  storageInsuredUntil: isoDateSchema.nullable().optional(),
});

const inspectionBodySchema = z.object({
  unitId: idSchema.nullable().optional(),
  longLeadItemId: idSchema.nullable().optional(),
  nodeId: idSchema.nullable().optional(),
  kind: z.enum(FACTORY_INSPECTION_KINDS).default("factory_acceptance_test"),
  title: z.string().min(1).max(200),
  scheduledFor: isoDateSchema.nullable().optional(),
  inspectorId: idSchema.nullable().optional(),
  inspectorName: z.string().max(120).nullable().optional(),
});

const inspectionRecordSchema = z.object({
  result: z.enum(["passed", "conditional", "failed"]),
  performedAt: isoDateSchema.optional(),
  findings: z.string().max(8000).nullable().optional(),
  percentVerified: z.number().min(0).max(100).nullable().optional(),
  fileIds: fileIdsSchema.optional(),
});

const inspectionListSchema = pageQuerySchema.extend({
  unitId: idSchema.optional(),
  longLeadItemId: idSchema.optional(),
  nodeId: idSchema.optional(),
  result: z.enum(FACTORY_INSPECTION_RESULTS).optional(),
  kind: z.enum(FACTORY_INSPECTION_KINDS).optional(),
});

export const offsiteRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate, adminGate } = buildGates(app);
  const base = "/projects/:projectId/supply-chain/offsite";

  async function loadUnit(companyId: string, projectId: string, unitId: string) {
    const [row] = await app.db
      .select()
      .from(offsiteUnits)
      .where(and(eq(offsiteUnits.id, unitId), eq(offsiteUnits.companyId, companyId), eq(offsiteUnits.projectId, projectId)))
      .limit(1);
    if (!row) throw notFound("Offsite unit not found");
    return row;
  }

  async function loadStage(unitId: string, stageId: string) {
    const [row] = await app.db
      .select()
      .from(offsiteProductionStages)
      .where(and(eq(offsiteProductionStages.id, stageId), eq(offsiteProductionStages.unitId, unitId)))
      .limit(1);
    if (!row) throw notFound("Production stage not found");
    return row;
  }

  async function assertItem(projectId: string, itemId: string) {
    const [row] = await app.db
      .select({ id: longLeadItems.id })
      .from(longLeadItems)
      .where(and(eq(longLeadItems.id, itemId), eq(longLeadItems.projectId, projectId)))
      .limit(1);
    if (!row) throw badRequest(`Long-lead item ${itemId} not found in this project.`);
  }

  async function validateRefs(companyId: string, projectId: string, body: Partial<z.infer<typeof unitBodySchema>>) {
    if (body.vendorId) await assertVendor(app.db, companyId, body.vendorId);
    if (body.factoryNodeId) await assertNode(app.db, projectId, body.factoryNodeId);
    if (body.longLeadItemId) await assertItem(projectId, body.longLeadItemId);
    if (body.locationId) await assertLocation(app.db, projectId, body.locationId);
    if (body.scheduleTaskId) await loadTask(app.db, projectId, body.scheduleTaskId);
  }

  /* ---------------------------------------------------------------- */
  /* Units                                                             */
  /* ---------------------------------------------------------------- */

  app.get(`${base}/units`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = unitListSchema.parse(req.query);
    const where = and(
      eq(offsiteUnits.companyId, req.companyId!),
      eq(offsiteUnits.projectId, projectId),
      q.status ? eq(offsiteUnits.status, q.status) : undefined,
      q.factoryNodeId ? eq(offsiteUnits.factoryNodeId, q.factoryNodeId) : undefined,
      q.scheduleTaskId ? eq(offsiteUnits.scheduleTaskId, q.scheduleTaskId) : undefined,
      q.q ? or(ilike(offsiteUnits.name, `%${q.q}%`), ilike(offsiteUnits.reference, `%${q.q}%`), ilike(offsiteUnits.serialNumber, `%${q.q}%`)) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(offsiteUnits).where(where).orderBy(asc(offsiteUnits.number)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(offsiteUnits).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post(`${base}/units`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = unitBodySchema.parse(req.body);
    const companyId = req.companyId!;
    await validateRefs(companyId, projectId, body);
    const { number, reference } = await allocateReference(app.db, projectId, "offsite_unit", "MOD");
    const id = newId("osu");
    const [inserted] = await app.db
      .insert(offsiteUnits)
      .values({
        id,
        companyId,
        projectId,
        number,
        reference,
        name: body.name,
        unitType: body.unitType,
        serialNumber: body.serialNumber ?? null,
        designReference: body.designReference ?? null,
        factoryNodeId: body.factoryNodeId ?? null,
        vendorId: body.vendorId ?? null,
        longLeadItemId: body.longLeadItemId ?? null,
        locationId: body.locationId ?? null,
        scheduleTaskId: body.scheduleTaskId ?? null,
        plannedProductionStart: body.plannedProductionStart ?? null,
        plannedProductionEnd: body.plannedProductionEnd ?? null,
        plannedDeliveryDate: body.plannedDeliveryDate ?? null,
        value: body.value ?? null,
        currency: body.currency ?? "USD",
        transportKm: body.transportKm ?? null,
        weightTonnes: body.weightTonnes ?? null,
        storageLocationText: body.storageLocationText ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    if (body.stages.length > 0) {
      await app.db.insert(offsiteProductionStages).values(
        body.stages.map((s, i) => ({
          id: newId("oss"),
          companyId,
          projectId,
          unitId: id,
          position: s.position ?? i,
          name: s.name,
          isQaGate: s.isQaGate ? 1 : 0,
          plannedStart: s.plannedStart ?? null,
          plannedEnd: s.plannedEnd ?? null,
        })),
      );
    }
    const { unit, rollup } = await recomputeUnit(app.db, inserted!);
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "create", objectType: "offsite_unit", objectId: id, payload: { reference, name: body.name, unitType: body.unitType, stages: body.stages.length } });
    return reply.code(201).send({ ...unit, rollup });
  });

  app.get(`${base}/units/:unitId`, { preHandler: readGate }, async (req) => {
    const { projectId, unitId } = req.params as { projectId: string; unitId: string };
    const row = await loadUnit(req.companyId!, projectId, unitId);
    // A read never writes: the rollup is computed for the response only. The
    // write paths (stage start/complete/QA, inspection record, transition,
    // delivery completion) are what persist it.
    const { unit, stages, inspections, rollup, verified } = await computeUnit(app.db, row);
    const [ctx, traces] = await Promise.all([
      loadLongLeadContext(app.db, projectId, [{ scheduleTaskId: unit.scheduleTaskId, supplierNodeId: unit.factoryNodeId }]),
      app.db
        .select({ id: materialTraceRecords.id, reference: materialTraceRecords.reference, description: materialTraceRecords.description, status: materialTraceRecords.status, chainComplete: materialTraceRecords.chainComplete })
        .from(materialTraceRecords)
        .where(and(eq(materialTraceRecords.projectId, projectId), eq(materialTraceRecords.offsiteUnitId, unitId))),
    ]);
    return {
      ...unit,
      stages,
      inspections,
      rollup,
      verifiedForPayment: verified,
      task: unit.scheduleTaskId ? (ctx.tasks.get(unit.scheduleTaskId) ?? null) : null,
      factoryNode: unit.factoryNodeId ? (ctx.nodes.get(unit.factoryNodeId) ?? null) : null,
      traceRecords: traces,
      allowedTransitions: OFFSITE_UNIT_STATUSES.filter((s) => transitionAllowed(unit.status, s, rollup).ok),
    };
  });

  app.patch(`${base}/units/:unitId`, { preHandler: standardGate }, async (req) => {
    const { projectId, unitId } = req.params as { projectId: string; unitId: string };
    const body = unitPatchSchema.parse(req.body);
    const companyId = req.companyId!;
    const current = await loadUnit(companyId, projectId, unitId);
    if (current.status === "installed") throw badRequest("An installed unit is read-only.");
    await validateRefs(companyId, projectId, body);
    const set = patchSet(body as Record<string, unknown>, [
      "name", "unitType", "serialNumber", "designReference", "factoryNodeId", "vendorId", "longLeadItemId", "locationId", "scheduleTaskId",
      "plannedProductionStart", "plannedProductionEnd", "plannedDeliveryDate", "value", "currency", "transportKm", "weightTonnes", "storageLocationText",
    ]);
    const [updated] = await app.db.update(offsiteUnits).set(set).where(eq(offsiteUnits.id, unitId)).returning();
    const { unit, rollup } = await recomputeUnit(app.db, updated!);
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "update", objectType: "offsite_unit", objectId: unitId, payload: body });
    return { ...unit, rollup };
  });

  app.delete(`${base}/units/:unitId`, { preHandler: adminGate }, async (req, reply) => {
    const { projectId, unitId } = req.params as { projectId: string; unitId: string };
    const companyId = req.companyId!;
    const current = await loadUnit(companyId, projectId, unitId);
    if (current.status !== "planned" && current.status !== "in_design" && current.status !== "rejected") {
      throw badRequest(`A ${current.status.replace(/_/g, " ")} unit cannot be deleted; reject it instead so the record survives.`);
    }
    await app.db.delete(offsiteProductionStages).where(eq(offsiteProductionStages.unitId, unitId));
    await app.db.delete(offsiteUnits).where(eq(offsiteUnits.id, unitId));
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "delete", objectType: "offsite_unit", objectId: unitId, payload: { reference: current.reference } });
    return reply.code(204).send();
  });

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  app.post(`${base}/units/:unitId/transition`, { preHandler: standardGate }, async (req) => {
    const { projectId, unitId } = req.params as { projectId: string; unitId: string };
    const body = transitionSchema.parse(req.body);
    const companyId = req.companyId!;
    const current = await loadUnit(companyId, projectId, unitId);
    const { rollup } = await recomputeUnit(app.db, current);
    const next: OffsiteUnitStatus = body.status;
    const allowed = transitionAllowed(current.status, next, rollup);
    if (!allowed.ok) throw badRequest(allowed.reason ?? "Transition not allowed", { control: "offsite_lifecycle", reasons: rollup.reasons });
    if (next === "rejected" && !body.note) throw badRequest("A rejection needs a reason.");
    const at = body.at ?? todayISO();
    const set: Record<string, unknown> = { status: next, updatedAt: nowISO() };
    switch (next) {
      case "in_production":
        if (!current.actualProductionStart) set["actualProductionStart"] = at;
        break;
      case "passed_qa":
        set["actualProductionEnd"] = at;
        break;
      case "delivered":
        set["actualDeliveryDate"] = at;
        break;
      case "installed": {
        const locationId = body.locationId ?? current.locationId;
        if (!locationId) throw badRequest("Record where the unit was installed: an installed unit without a location cannot be traced.");
        await assertLocation(app.db, projectId, locationId);
        set["locationId"] = locationId;
        set["installedAt"] = at;
        break;
      }
      default:
        break;
    }
    if (body.note) set["detail"] = { ...current.detail, [`${next}Note`]: body.note };
    const [updated] = await app.db.update(offsiteUnits).set(set).where(eq(offsiteUnits.id, unitId)).returning();
    // The rollup derives production statuses; a manual step downstream sticks.
    const { unit, rollup: after } = await recomputeUnit(app.db, updated!);
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "state_change", objectType: "offsite_unit", objectId: unitId, payload: { from: current.status, to: next, at, note: body.note ?? null } });
    return { ...unit, rollup: after };
  });

  app.post(`${base}/units/:unitId/vesting`, { preHandler: standardGate }, async (req) => {
    const { projectId, unitId } = req.params as { projectId: string; unitId: string };
    const body = vestingSchema.parse(req.body);
    const companyId = req.companyId!;
    await loadUnit(companyId, projectId, unitId);
    const set = patchSet(body as Record<string, unknown>, ["vestingCertificateFileId", "vestingCertifiedAt", "titleTransferredAt", "storageLocationText", "storageInsuredUntil"]);
    const [updated] = await app.db.update(offsiteUnits).set(set).where(eq(offsiteUnits.id, unitId)).returning();
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "update", objectType: "offsite_unit", objectId: unitId, payload: { vesting: body } });
    return updated;
  });

  /* ---------------------------------------------------------------- */
  /* Stages and QA gates                                               */
  /* ---------------------------------------------------------------- */

  app.post(`${base}/units/:unitId/stages`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId, unitId } = req.params as { projectId: string; unitId: string };
    const body = stageInputSchema.parse(req.body);
    const companyId = req.companyId!;
    const current = await loadUnit(companyId, projectId, unitId);
    if (current.status === "installed") throw badRequest("An installed unit is read-only.");
    const [{ n } = { n: 0 }] = await app.db.select({ n: count() }).from(offsiteProductionStages).where(eq(offsiteProductionStages.unitId, unitId));
    const id = newId("oss");
    const [row] = await app.db
      .insert(offsiteProductionStages)
      .values({
        id,
        companyId,
        projectId,
        unitId,
        position: body.position ?? n,
        name: body.name,
        isQaGate: body.isQaGate ? 1 : 0,
        plannedStart: body.plannedStart ?? null,
        plannedEnd: body.plannedEnd ?? null,
      })
      .returning();
    const { rollup } = await recomputeUnit(app.db, current);
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "create", objectType: "offsite_production_stage", objectId: id, payload: { unitId, name: body.name, isQaGate: body.isQaGate } });
    return reply.code(201).send({ ...row, rollup });
  });

  app.patch(`${base}/units/:unitId/stages/:stageId`, { preHandler: standardGate }, async (req) => {
    const { projectId, unitId, stageId } = req.params as { projectId: string; unitId: string; stageId: string };
    const body = stagePatchSchema.parse(req.body);
    const companyId = req.companyId!;
    const unit = await loadUnit(companyId, projectId, unitId);
    const stage = await loadStage(unitId, stageId);
    if (stage.status === "complete" && body.isQaGate !== undefined && (body.isQaGate ? 1 : 0) !== stage.isQaGate) {
      throw badRequest("A completed stage cannot change whether it is a QA gate.");
    }
    const set = patchSet(body as Record<string, unknown>, ["name", "position", "plannedStart", "plannedEnd"]);
    if (body.isQaGate !== undefined) set["isQaGate"] = body.isQaGate ? 1 : 0;
    const [row] = await app.db.update(offsiteProductionStages).set(set).where(eq(offsiteProductionStages.id, stageId)).returning();
    const { rollup } = await recomputeUnit(app.db, unit);
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "update", objectType: "offsite_production_stage", objectId: stageId, payload: body });
    return { ...row, rollup };
  });

  app.delete(`${base}/units/:unitId/stages/:stageId`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId, unitId, stageId } = req.params as { projectId: string; unitId: string; stageId: string };
    const companyId = req.companyId!;
    const unit = await loadUnit(companyId, projectId, unitId);
    const stage = await loadStage(unitId, stageId);
    if (stage.status !== "not_started") throw badRequest("Only a stage that has not started can be removed; a started stage is history.");
    await app.db.delete(offsiteProductionStages).where(eq(offsiteProductionStages.id, stageId));
    await recomputeUnit(app.db, unit);
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "delete", objectType: "offsite_production_stage", objectId: stageId, payload: { unitId, name: stage.name } });
    return reply.code(204).send();
  });

  app.post(`${base}/units/:unitId/stages/:stageId/start`, { preHandler: standardGate }, async (req) => {
    const { projectId, unitId, stageId } = req.params as { projectId: string; unitId: string; stageId: string };
    const body = z.object({ at: isoDateSchema.optional() }).parse(req.body ?? {});
    const companyId = req.companyId!;
    const unit = await loadUnit(companyId, projectId, unitId);
    const stage = await loadStage(unitId, stageId);
    if (stage.status !== "not_started" && stage.status !== "failed") throw badRequest(`Stage is already ${stage.status.replace(/_/g, " ")}.`);
    const at = body.at ?? todayISO();
    const [row] = await app.db
      .update(offsiteProductionStages)
      .set({ status: "in_progress", actualStart: stage.actualStart ?? at, qaResult: "pending", qaVerifiedBy: null, qaVerifiedAt: null, updatedAt: nowISO() })
      .where(eq(offsiteProductionStages.id, stageId))
      .returning();
    const { unit: after, rollup } = await recomputeUnit(app.db, unit);
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "state_change", objectType: "offsite_production_stage", objectId: stageId, payload: { unitId, from: stage.status, to: "in_progress", at } });
    return { ...row, rollup, unitStatus: after.status };
  });

  app.post(`${base}/units/:unitId/stages/:stageId/complete`, { preHandler: standardGate }, async (req) => {
    const { projectId, unitId, stageId } = req.params as { projectId: string; unitId: string; stageId: string };
    const body = z.object({ at: isoDateSchema.optional(), evidenceFileIds: fileIdsSchema.optional(), note: z.string().max(2000).optional() }).parse(req.body ?? {});
    const companyId = req.companyId!;
    const unit = await loadUnit(companyId, projectId, unitId);
    const stage = await loadStage(unitId, stageId);
    if (stage.status === "complete") throw badRequest("Stage is already complete.");
    const at = body.at ?? todayISO();
    const [row] = await app.db
      .update(offsiteProductionStages)
      .set({
        status: "complete",
        actualStart: stage.actualStart ?? at,
        actualEnd: at,
        completedBy: req.user!.id,
        qaResult: "pending",
        qaVerifiedBy: null,
        qaVerifiedAt: null,
        evidenceFileIds: body.evidenceFileIds ?? stage.evidenceFileIds,
        updatedAt: nowISO(),
      })
      .where(eq(offsiteProductionStages.id, stageId))
      .returning();
    const { unit: after, rollup } = await recomputeUnit(app.db, unit);
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "state_change", objectType: "offsite_production_stage", objectId: stageId, payload: { unitId, from: stage.status, to: "complete", at, isQaGate: stage.isQaGate === 1, note: body.note ?? null } });
    return { ...row, rollup, unitStatus: after.status };
  });

  /**
   * The QA gate. The verifier must not be the person who completed the stage:
   * that is the one rule the whole offsite register stands on.
   */
  app.post(`${base}/units/:unitId/stages/:stageId/qa`, { preHandler: standardGate }, async (req) => {
    const { projectId, unitId, stageId } = req.params as { projectId: string; unitId: string; stageId: string };
    const body = qaSchema.parse(req.body);
    const companyId = req.companyId!;
    const unit = await loadUnit(companyId, projectId, unitId);
    const stage = await loadStage(unitId, stageId);
    if (stage.isQaGate !== 1) throw badRequest("This stage is not a QA gate.");
    if (stage.status !== "complete") throw badRequest("The stage must be complete before its QA gate is recorded.");
    if (stage.completedBy && stage.completedBy === req.user!.id) {
      throw forbidden("The QA gate must be recorded by someone other than the person who completed the stage.");
    }
    if (body.result === "waived" && !body.notes) throw badRequest("A waiver needs a written reason.");
    const verifiedAt = nowISO();
    const [row] = await app.db
      .update(offsiteProductionStages)
      .set({
        qaResult: body.result,
        qaVerifiedBy: req.user!.id,
        qaVerifiedAt: verifiedAt,
        qaNotes: body.notes ?? null,
        evidenceFileIds: body.evidenceFileIds ? [...stage.evidenceFileIds, ...body.evidenceFileIds] : stage.evidenceFileIds,
        status: body.result === "failed" ? "failed" : "complete",
        updatedAt: verifiedAt,
      })
      .where(eq(offsiteProductionStages.id, stageId))
      .returning();
    const { unit: after, rollup } = await recomputeUnit(app.db, unit);
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "state_change", objectType: "offsite_production_stage", objectId: stageId, payload: { unitId, qaResult: body.result, completedBy: stage.completedBy, verifiedBy: req.user!.id, notes: body.notes ?? null } });
    if (body.result === "failed") {
      await raiseSignal(app.db, companyId, projectId, req.user!.id, {
        detector: "supply_offsite_qa_failed",
        severity: unit.scheduleTaskId ? "high" : "medium",
        confidence: 0.95,
        title: `${unit.reference} ${unit.name}: QA gate "${stage.name}" failed`,
        explanation: `${body.notes ?? "No notes recorded."} The unit is on QA hold; nothing ships until the gate passes or is waived with a reason.`,
        key: `unit:${unitId}:stage:${stageId}:qafail:${verifiedAt}`,
        evidence: { unitId, stageId, verifiedBy: req.user!.id, completedBy: stage.completedBy },
      });
    }
    return { ...row, rollup, unitStatus: after.status };
  });

  /* ---------------------------------------------------------------- */
  /* Factory inspections (#923, #924, #926)                            */
  /* ---------------------------------------------------------------- */

  app.get(`${base}/inspections`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = inspectionListSchema.parse(req.query);
    const where = and(
      eq(factoryInspections.companyId, req.companyId!),
      eq(factoryInspections.projectId, projectId),
      q.unitId ? eq(factoryInspections.unitId, q.unitId) : undefined,
      q.longLeadItemId ? eq(factoryInspections.longLeadItemId, q.longLeadItemId) : undefined,
      q.nodeId ? eq(factoryInspections.nodeId, q.nodeId) : undefined,
      q.result ? eq(factoryInspections.result, q.result) : undefined,
      q.kind ? eq(factoryInspections.kind, q.kind) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(factoryInspections).where(where).orderBy(desc(factoryInspections.scheduledFor), desc(factoryInspections.createdAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(factoryInspections).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post(`${base}/inspections`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = inspectionBodySchema.parse(req.body);
    const companyId = req.companyId!;
    if (!body.unitId && !body.longLeadItemId && !body.nodeId) throw badRequest("An inspection must be of a unit, a long-lead item or a supply chain node.");
    if (body.unitId) await loadUnit(companyId, projectId, body.unitId);
    if (body.longLeadItemId) await assertItem(projectId, body.longLeadItemId);
    if (body.nodeId) await assertNode(app.db, projectId, body.nodeId);
    const id = newId("fin");
    const [row] = await app.db
      .insert(factoryInspections)
      .values({
        id,
        companyId,
        projectId,
        unitId: body.unitId ?? null,
        longLeadItemId: body.longLeadItemId ?? null,
        nodeId: body.nodeId ?? null,
        kind: body.kind,
        title: body.title,
        scheduledFor: body.scheduledFor ?? null,
        inspectorId: body.inspectorId ?? null,
        inspectorName: body.inspectorName ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "create", objectType: "factory_inspection", objectId: id, payload: { kind: body.kind, title: body.title, unitId: body.unitId ?? null, scheduledFor: body.scheduledFor ?? null } });
    return reply.code(201).send(row);
  });

  /**
   * Record the result. The recorder becomes the inspector of record, and may
   * not have completed any production stage on the unit — an inspection is
   * evidence against the factory's assertion, not a restatement of it.
   */
  app.post(`${base}/inspections/:inspectionId/record`, { preHandler: standardGate }, async (req) => {
    const { projectId, inspectionId } = req.params as { projectId: string; inspectionId: string };
    const body = inspectionRecordSchema.parse(req.body);
    const companyId = req.companyId!;
    const [inspection] = await app.db
      .select()
      .from(factoryInspections)
      .where(and(eq(factoryInspections.id, inspectionId), eq(factoryInspections.companyId, companyId), eq(factoryInspections.projectId, projectId)))
      .limit(1);
    if (!inspection) throw notFound("Inspection not found");
    if (inspection.result !== "scheduled") throw badRequest(`Inspection already recorded as ${inspection.result}.`);
    let unit = inspection.unitId ? await loadUnit(companyId, projectId, inspection.unitId) : null;
    if (unit) {
      const completers = await app.db
        .select({ completedBy: offsiteProductionStages.completedBy })
        .from(offsiteProductionStages)
        .where(and(eq(offsiteProductionStages.unitId, unit.id), eq(offsiteProductionStages.completedBy, req.user!.id)))
        .limit(1);
      if (completers[0]) throw forbidden("Whoever completed a production stage on this unit cannot also record its inspection.");
    }
    const performedAt = body.performedAt ?? todayISO();
    const [row] = await app.db
      .update(factoryInspections)
      .set({
        result: body.result,
        performedAt,
        inspectorId: req.user!.id,
        findings: body.findings ?? null,
        percentVerified: body.percentVerified ?? null,
        fileIds: body.fileIds ?? inspection.fileIds,
        updatedAt: nowISO(),
      })
      .where(eq(factoryInspections.id, inspectionId))
      .returning();
    let unitAfter: unknown = null;
    if (unit) {
      const extra: Record<string, unknown> = {};
      if (inspection.kind === "storage_inspection" || inspection.kind === "insurance_inspection") extra["storageInspectedAt"] = performedAt;
      if (inspection.kind === "vesting" && body.result === "passed" && !unit.vestingCertifiedAt) extra["vestingCertifiedAt"] = performedAt;
      if (Object.keys(extra).length > 0) {
        const [u] = await app.db.update(offsiteUnits).set({ ...extra, updatedAt: nowISO() }).where(eq(offsiteUnits.id, unit.id)).returning();
        unit = u ?? unit;
      }
      const rc = await recomputeUnit(app.db, unit);
      unitAfter = { ...rc.unit, rollup: rc.rollup, verifiedForPayment: rc.verified };
    }
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "state_change", objectType: "factory_inspection", objectId: inspectionId, payload: { result: body.result, performedAt, percentVerified: body.percentVerified ?? null, unitId: inspection.unitId } });
    return { ...row, unit: unitAfter };
  });

  /**
   * Withdraw a recorded inspection (#924). An inspector's typo must never be
   * permanent: a second person voids the record with a written reason, the
   * row survives for the audit trail, and the unit's verified-for-payment
   * percent falls back to the most recent inspection that still stands.
   * The voider may not be the inspector of record — the same segregation the
   * recording itself is held to.
   */
  app.post(`${base}/inspections/:inspectionId/void`, { preHandler: standardGate }, async (req) => {
    const { projectId, inspectionId } = req.params as { projectId: string; inspectionId: string };
    const body = z.object({ reason: z.string().trim().min(10).max(2000) }).parse(req.body);
    const companyId = req.companyId!;
    const [inspection] = await app.db
      .select()
      .from(factoryInspections)
      .where(and(eq(factoryInspections.id, inspectionId), eq(factoryInspections.companyId, companyId), eq(factoryInspections.projectId, projectId)))
      .limit(1);
    if (!inspection) throw notFound("Inspection not found");
    if (inspection.result === "scheduled") throw badRequest("Nothing is recorded yet; cancel the inspection instead of voiding it.");
    if (inspection.result === "voided") throw badRequest("This inspection is already voided.");
    if (inspection.inspectorId && inspection.inspectorId === req.user!.id) {
      throw forbidden("The inspector of record cannot void their own inspection: a second person must withdraw it.");
    }
    const at = nowISO();
    const [row] = await app.db
      .update(factoryInspections)
      .set({
        result: "voided",
        findings: `${inspection.findings ? `${inspection.findings}\n\n` : ""}VOIDED by a second person: ${body.reason}`,
        updatedAt: at,
      })
      .where(eq(factoryInspections.id, inspectionId))
      .returning();
    let unitAfter: unknown = null;
    if (inspection.unitId) {
      const unit = await loadUnit(companyId, projectId, inspection.unitId);
      const rc = await recomputeUnit(app.db, unit);
      unitAfter = { ...rc.unit, rollup: rc.rollup, verifiedForPayment: rc.verified };
    }
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "factory_inspection",
      objectId: inspectionId,
      payload: { from: inspection.result, to: "voided", reason: body.reason, inspectorOfRecord: inspection.inspectorId, percentVerified: inspection.percentVerified, unitId: inspection.unitId },
    });
    return { ...row, unit: unitAfter };
  });

  app.post(`${base}/inspections/:inspectionId/cancel`, { preHandler: standardGate }, async (req) => {
    const { projectId, inspectionId } = req.params as { projectId: string; inspectionId: string };
    const body = z.object({ reason: z.string().min(1).max(2000) }).parse(req.body);
    const companyId = req.companyId!;
    const [row] = await app.db
      .update(factoryInspections)
      .set({ result: "cancelled", findings: body.reason, updatedAt: nowISO() })
      .where(and(eq(factoryInspections.id, inspectionId), eq(factoryInspections.companyId, companyId), eq(factoryInspections.projectId, projectId), eq(factoryInspections.result, "scheduled")))
      .returning();
    if (!row) throw notFound("Scheduled inspection not found");
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "state_change", objectType: "factory_inspection", objectId: inspectionId, payload: { result: "cancelled", reason: body.reason } });
    return row;
  });

};
