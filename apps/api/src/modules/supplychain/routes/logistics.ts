/**
 * LOGISTICS routes (spec #930–939; Vol I #720–722, #730): site gates, slot
 * booking with clash refusal, the arrival→unloading→completion lifecycle,
 * the damage/shortage register on completion, availability, on-time
 * analytics and the transport carbon hook (#945).
 *
 * Gates keep site time on the UTC clock: a slot at 08:00 is booked as
 * `YYYY-MM-DDT08:00:00Z`, and the gate window is compared on that clock.
 *
 * Completing a delivery moves the chain it carries (#921): a long-lead item
 * on the slot is stamped `arrived`; an offsite unit in transit becomes
 * `delivered`. The slot never edits those registers in any other way.
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, gte, ilike, inArray, lte, or } from "drizzle-orm";
import { z } from "zod";
import { deliverySlots, longLeadItems, materialDeliveries, offsiteUnits, siteGates, supplyChainNodes } from "@constructos/db";
import {
  DELIVERY_ISSUE_KINDS,
  DELIVERY_SLOT_STATUSES,
  SITE_GATE_STATUSES,
  TRANSPORT_MODES,
  VEHICLE_TYPES,
} from "@constructos/shared";
import { badRequest, conflict, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { assessArrival, estimateTransportCarbon, freeWindows, onTimeDelivery, validateBooking, type SlotWindow } from "../engines/logistics.js";
import { isoTs, loadLongLeadContext, persistAssessment, recomputeUnit, sweepDeliveryNoShows, syncSlotCarbon, wireSlot, type SlotRow } from "../service.js";
import {
  allocateReference,
  assertNode,
  assertVendor,
  buildGates,
  countryCodeSchema,
  idSchema,
  isoDateSchema,
  isoTimestampSchema,
  ledger,
  loadTask,
  nowISO,
  patchSchemaOf,
  patchSet,
  todayISO,
} from "../shared.js";

const hhmm = z.string().regex(/^\d{2}:\d{2}$/, "Expected HH:MM");

const gateBodySchema = z.object({
  name: z.string().min(1).max(120),
  code: z.string().max(20).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  opensAt: hhmm.default("07:00"),
  closesAt: hhmm.default("18:00"),
  concurrentSlots: z.number().int().min(1).max(20).default(1),
  slotMinutes: z.number().int().min(5).max(480).default(30),
  maxVehicleType: z.enum(VEHICLE_TYPES).nullable().optional(),
  craneAvailable: z.boolean().default(false),
  laydownAreas: z.array(z.string().min(1).max(80)).max(50).default([]),
});
const gatePatchSchema = patchSchemaOf(gateBodySchema).extend({ status: z.enum(SITE_GATE_STATUSES).optional() });

const slotBodySchema = z.object({
  gateId: idSchema,
  startsAt: isoTimestampSchema,
  endsAt: isoTimestampSchema,
  description: z.string().min(1).max(500),
  supplierNodeId: idSchema.nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  longLeadItemId: idSchema.nullable().optional(),
  offsiteUnitId: idSchema.nullable().optional(),
  materialDeliveryId: idSchema.nullable().optional(),
  scheduleTaskId: idSchema.nullable().optional(),
  vehicleType: z.enum(VEHICLE_TYPES).default("rigid_18t"),
  vehicleRegistration: z.string().max(20).nullable().optional(),
  haulierName: z.string().max(120).nullable().optional(),
  driverName: z.string().max(120).nullable().optional(),
  driverPhone: z.string().max(40).nullable().optional(),
  craneRequired: z.boolean().default(false),
  craneMinutes: z.number().int().min(0).max(1440).nullable().optional(),
  laydownArea: z.string().max(80).nullable().optional(),
  transportMode: z.enum(TRANSPORT_MODES).default("road"),
  originText: z.string().max(200).nullable().optional(),
  originCountry: countryCodeSchema.nullable().optional(),
  transportKm: z.number().min(0).max(50_000).nullable().optional(),
  loadTonnes: z.number().min(0).max(10_000).nullable().optional(),
});
const slotPatchSchema = patchSchemaOf(slotBodySchema);

const slotListSchema = pageQuerySchema.extend({
  gateId: idSchema.optional(),
  status: z.enum(DELIVERY_SLOT_STATUSES).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  scheduleTaskId: idSchema.optional(),
  longLeadItemId: idSchema.optional(),
  q: z.string().max(120).optional(),
});

const completeSchema = z.object({
  completedAt: isoTimestampSchema.optional(),
  issueKind: z.enum(DELIVERY_ISSUE_KINDS).optional(),
  issueNotes: z.string().max(4000).nullable().optional(),
  transportKm: z.number().min(0).max(50_000).nullable().optional(),
  loadTonnes: z.number().min(0).max(10_000).nullable().optional(),
  materialDeliveryId: idSchema.nullable().optional(),
});

const EDITABLE: ReadonlySet<string> = new Set(["requested", "confirmed"]);

export const logisticsRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate, adminGate } = buildGates(app);
  const base = "/projects/:projectId/supply-chain/logistics";

  async function loadGate(companyId: string, projectId: string, gateId: string) {
    const [row] = await app.db
      .select()
      .from(siteGates)
      .where(and(eq(siteGates.id, gateId), eq(siteGates.companyId, companyId), eq(siteGates.projectId, projectId)))
      .limit(1);
    if (!row) throw notFound("Site gate not found");
    return row;
  }

  async function loadSlot(companyId: string, projectId: string, slotId: string) {
    const [row] = await app.db
      .select()
      .from(deliverySlots)
      .where(and(eq(deliverySlots.id, slotId), eq(deliverySlots.companyId, companyId), eq(deliverySlots.projectId, projectId)))
      .limit(1);
    if (!row) throw notFound("Delivery slot not found");
    return row;
  }

  /** Bookings on a gate that could overlap [startsAt, endsAt] — one day either side. */
  async function neighbours(gateId: string, startsAt: string, endsAt: string): Promise<SlotWindow[]> {
    const lo = new Date(Date.parse(startsAt) - 86_400_000).toISOString();
    const hi = new Date(Date.parse(endsAt) + 86_400_000).toISOString();
    const rows = await app.db
      .select({ id: deliverySlots.id, reference: deliverySlots.reference, startsAt: deliverySlots.startsAt, endsAt: deliverySlots.endsAt, craneRequired: deliverySlots.craneRequired, status: deliverySlots.status })
      .from(deliverySlots)
      .where(and(eq(deliverySlots.gateId, gateId), gte(deliverySlots.startsAt, lo), lte(deliverySlots.startsAt, hi)));
    return rows.map((r) => ({ id: r.id, reference: r.reference, startsAt: isoTs(r.startsAt) ?? r.startsAt, endsAt: isoTs(r.endsAt) ?? r.endsAt, craneRequired: r.craneRequired === 1, status: r.status }));
  }

  async function validateRefs(companyId: string, projectId: string, body: Partial<z.infer<typeof slotBodySchema>>) {
    if (body.vendorId) await assertVendor(app.db, companyId, body.vendorId);
    if (body.supplierNodeId) await assertNode(app.db, projectId, body.supplierNodeId);
    if (body.scheduleTaskId) await loadTask(app.db, projectId, body.scheduleTaskId);
    if (body.longLeadItemId) {
      const [r] = await app.db.select({ id: longLeadItems.id }).from(longLeadItems).where(and(eq(longLeadItems.id, body.longLeadItemId), eq(longLeadItems.projectId, projectId))).limit(1);
      if (!r) throw badRequest(`Long-lead item ${body.longLeadItemId} not found in this project.`);
    }
    if (body.offsiteUnitId) {
      const [r] = await app.db.select({ id: offsiteUnits.id }).from(offsiteUnits).where(and(eq(offsiteUnits.id, body.offsiteUnitId), eq(offsiteUnits.projectId, projectId))).limit(1);
      if (!r) throw badRequest(`Offsite unit ${body.offsiteUnitId} not found in this project.`);
    }
    if (body.materialDeliveryId) {
      const [r] = await app.db.select({ id: materialDeliveries.id }).from(materialDeliveries).where(and(eq(materialDeliveries.id, body.materialDeliveryId), eq(materialDeliveries.projectId, projectId))).limit(1);
      if (!r) throw badRequest(`Material delivery ${body.materialDeliveryId} not found in this project.`);
    }
  }

  function checkBooking(gate: typeof siteGates.$inferSelect, existing: SlotWindow[], request: { startsAt: string; endsAt: string; craneRequired: boolean; vehicleType: string; laydownArea?: string | null; excludeSlotId?: string | null }) {
    const conflicts = validateBooking(
      { opensAt: gate.opensAt, closesAt: gate.closesAt, concurrentSlots: gate.concurrentSlots, craneAvailable: gate.craneAvailable === 1, maxVehicleType: gate.maxVehicleType, status: gate.status },
      existing,
      request,
    );
    if (request.laydownArea && gate.laydownAreas.length > 0 && !gate.laydownAreas.includes(request.laydownArea)) {
      conflicts.push({ kind: "invalid_window", detail: `Laydown area "${request.laydownArea}" is not one of this gate's areas (${gate.laydownAreas.join(", ")}).`, clashingSlotIds: [] });
    }
    if (conflicts.length > 0) {
      throw conflict(`Booking refused: ${conflicts.map((c) => c.detail).join(" ")}`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Gates                                                             */
  /* ---------------------------------------------------------------- */

  app.get(`${base}/gates`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const rows = await app.db
      .select()
      .from(siteGates)
      .where(and(eq(siteGates.companyId, req.companyId!), eq(siteGates.projectId, projectId)))
      .orderBy(asc(siteGates.name));
    return { items: rows, total: rows.length };
  });

  app.post(`${base}/gates`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = gateBodySchema.parse(req.body);
    if (body.closesAt <= body.opensAt) throw badRequest("The gate must close after it opens.");
    const id = newId("gat");
    const [row] = await app.db
      .insert(siteGates)
      .values({
        id,
        companyId: req.companyId!,
        projectId,
        name: body.name,
        code: body.code ?? null,
        description: body.description ?? null,
        opensAt: body.opensAt,
        closesAt: body.closesAt,
        concurrentSlots: body.concurrentSlots,
        slotMinutes: body.slotMinutes,
        maxVehicleType: body.maxVehicleType ?? null,
        craneAvailable: body.craneAvailable ? 1 : 0,
        laydownAreas: body.laydownAreas,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, { companyId: req.companyId!, projectId, actorId: req.user!.id, action: "create", objectType: "site_gate", objectId: id, payload: body });
    return reply.code(201).send(row);
  });

  app.patch(`${base}/gates/:gateId`, { preHandler: standardGate }, async (req) => {
    const { projectId, gateId } = req.params as { projectId: string; gateId: string };
    const body = gatePatchSchema.parse(req.body);
    const current = await loadGate(req.companyId!, projectId, gateId);
    const opens = body.opensAt ?? current.opensAt;
    const closes = body.closesAt ?? current.closesAt;
    if (closes <= opens) throw badRequest("The gate must close after it opens.");
    const set = patchSet(body as Record<string, unknown>, ["name", "code", "description", "opensAt", "closesAt", "concurrentSlots", "slotMinutes", "maxVehicleType", "laydownAreas", "status"]);
    if (body.craneAvailable !== undefined) set["craneAvailable"] = body.craneAvailable ? 1 : 0;
    const [row] = await app.db.update(siteGates).set(set).where(eq(siteGates.id, gateId)).returning();
    await ledger(app.db, { companyId: req.companyId!, projectId, actorId: req.user!.id, action: "update", objectType: "site_gate", objectId: gateId, payload: body });
    return row;
  });

  app.delete(`${base}/gates/:gateId`, { preHandler: adminGate }, async (req, reply) => {
    const { projectId, gateId } = req.params as { projectId: string; gateId: string };
    await loadGate(req.companyId!, projectId, gateId);
    const [live] = await app.db.select({ n: count() }).from(deliverySlots).where(and(eq(deliverySlots.gateId, gateId), inArray(deliverySlots.status, ["requested", "confirmed", "arrived", "unloading"])));
    if ((live?.n ?? 0) > 0) throw badRequest(`${live?.n} live booking(s) use this gate. Close it instead, or move them first.`);
    await app.db.delete(siteGates).where(eq(siteGates.id, gateId));
    await ledger(app.db, { companyId: req.companyId!, projectId, actorId: req.user!.id, action: "delete", objectType: "site_gate", objectId: gateId });
    return reply.code(204).send();
  });

  app.get(`${base}/gates/:gateId/availability`, { preHandler: readGate }, async (req) => {
    const { projectId, gateId } = req.params as { projectId: string; gateId: string };
    const q = z.object({ date: isoDateSchema.default(todayISO()) }).parse(req.query);
    const gate = await loadGate(req.companyId!, projectId, gateId);
    const dayStart = `${q.date}T00:00:00.000Z`;
    const dayEnd = `${q.date}T23:59:59.999Z`;
    const existing = await neighbours(gateId, dayStart, dayEnd);
    const booked = existing.filter((s) => s.startsAt.slice(0, 10) === q.date);
    return {
      gate,
      date: q.date,
      windows: freeWindows({ opensAt: gate.opensAt, closesAt: gate.closesAt, concurrentSlots: gate.concurrentSlots, craneAvailable: gate.craneAvailable === 1, maxVehicleType: gate.maxVehicleType, status: gate.status, slotMinutes: gate.slotMinutes }, existing, q.date),
      booked,
      note: "Times are on the site clock (UTC); the gate window is compared on the same clock.",
    };
  });

  /* ---------------------------------------------------------------- */
  /* Slots                                                             */
  /* ---------------------------------------------------------------- */

  app.get(`${base}/slots`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = slotListSchema.parse(req.query);
    const where = and(
      eq(deliverySlots.companyId, req.companyId!),
      eq(deliverySlots.projectId, projectId),
      q.gateId ? eq(deliverySlots.gateId, q.gateId) : undefined,
      q.status ? eq(deliverySlots.status, q.status) : undefined,
      q.from ? gte(deliverySlots.startsAt, `${q.from}T00:00:00.000Z`) : undefined,
      q.to ? lte(deliverySlots.startsAt, `${q.to}T23:59:59.999Z`) : undefined,
      q.scheduleTaskId ? eq(deliverySlots.scheduleTaskId, q.scheduleTaskId) : undefined,
      q.longLeadItemId ? eq(deliverySlots.longLeadItemId, q.longLeadItemId) : undefined,
      q.q ? or(ilike(deliverySlots.description, `%${q.q}%`), ilike(deliverySlots.reference, `%${q.q}%`), ilike(deliverySlots.haulierName, `%${q.q}%`), ilike(deliverySlots.vehicleRegistration, `%${q.q}%`)) : undefined,
    );
    const [rows, [total], gates] = await Promise.all([
      app.db.select().from(deliverySlots).where(where).orderBy(asc(deliverySlots.startsAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(deliverySlots).where(where),
      app.db.select({ id: siteGates.id, name: siteGates.name }).from(siteGates).where(eq(siteGates.projectId, projectId)),
    ]);
    const gateName = new Map(gates.map((g) => [g.id, g.name]));
    return paginate(rows.map((r) => ({ ...wireSlot(r), gateName: gateName.get(r.gateId) ?? null })), total?.n ?? 0, q);
  });

  app.post(`${base}/slots`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = slotBodySchema.parse(req.body);
    const companyId = req.companyId!;
    const gate = await loadGate(companyId, projectId, body.gateId);
    await validateRefs(companyId, projectId, body);
    const startsAt = new Date(body.startsAt).toISOString();
    const endsAt = new Date(body.endsAt).toISOString();
    checkBooking(gate, await neighbours(gate.id, startsAt, endsAt), { startsAt, endsAt, craneRequired: body.craneRequired, vehicleType: body.vehicleType, laydownArea: body.laydownArea ?? null });
    const { number, reference } = await allocateReference(app.db, projectId, "delivery_slot", "DEL");
    const preview = estimateTransportCarbon({ transportMode: body.transportMode, vehicleType: body.vehicleType, transportKm: body.transportKm ?? null, loadTonnes: body.loadTonnes ?? null });
    const id = newId("dsl");
    const [row] = await app.db
      .insert(deliverySlots)
      .values({
        id,
        companyId,
        projectId,
        number,
        reference,
        gateId: gate.id,
        startsAt,
        endsAt,
        description: body.description,
        supplierNodeId: body.supplierNodeId ?? null,
        vendorId: body.vendorId ?? null,
        longLeadItemId: body.longLeadItemId ?? null,
        offsiteUnitId: body.offsiteUnitId ?? null,
        materialDeliveryId: body.materialDeliveryId ?? null,
        scheduleTaskId: body.scheduleTaskId ?? null,
        vehicleType: body.vehicleType,
        vehicleRegistration: body.vehicleRegistration ?? null,
        haulierName: body.haulierName ?? null,
        driverName: body.driverName ?? null,
        driverPhone: body.driverPhone ?? null,
        craneRequired: body.craneRequired ? 1 : 0,
        craneMinutes: body.craneMinutes ?? null,
        laydownArea: body.laydownArea ?? null,
        transportMode: body.transportMode,
        originText: body.originText ?? null,
        originCountry: body.originCountry ?? null,
        transportKm: body.transportKm ?? null,
        loadTonnes: body.loadTonnes ?? null,
        carbonKgCo2e: preview.kgCo2e,
        carbonBasis: preview.kgCo2e === null ? preview.reasons.join(" ") : `${preview.basis} (estimate; booked in the carbon register on completion)`,
        bookedBy: req.user!.id,
      })
      .returning();
    if (body.offsiteUnitId) {
      await app.db.update(offsiteUnits).set({ deliverySlotId: id, updatedAt: nowISO() }).where(eq(offsiteUnits.id, body.offsiteUnitId));
    }
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "create", objectType: "delivery_slot", objectId: id, payload: { reference, gateId: gate.id, startsAt, endsAt, vehicleType: body.vehicleType, craneRequired: body.craneRequired, longLeadItemId: body.longLeadItemId ?? null, offsiteUnitId: body.offsiteUnitId ?? null } });
    return reply.code(201).send({ ...wireSlot(row!), gateName: gate.name });
  });

  app.get(`${base}/slots/:slotId`, { preHandler: readGate }, async (req) => {
    const { projectId, slotId } = req.params as { projectId: string; slotId: string };
    const slot = await loadSlot(req.companyId!, projectId, slotId);
    const [gate] = await app.db.select().from(siteGates).where(eq(siteGates.id, slot.gateId)).limit(1);
    const [node] = slot.supplierNodeId ? await app.db.select({ id: supplyChainNodes.id, name: supplyChainNodes.name }).from(supplyChainNodes).where(eq(supplyChainNodes.id, slot.supplierNodeId)).limit(1) : [undefined];
    const [item] = slot.longLeadItemId ? await app.db.select({ id: longLeadItems.id, reference: longLeadItems.reference, name: longLeadItems.name, status: longLeadItems.status }).from(longLeadItems).where(eq(longLeadItems.id, slot.longLeadItemId)).limit(1) : [undefined];
    const [unit] = slot.offsiteUnitId ? await app.db.select({ id: offsiteUnits.id, reference: offsiteUnits.reference, name: offsiteUnits.name, status: offsiteUnits.status }).from(offsiteUnits).where(eq(offsiteUnits.id, slot.offsiteUnitId)).limit(1) : [undefined];
    const carbon = estimateTransportCarbon({ transportMode: slot.transportMode, vehicleType: slot.vehicleType, transportKm: slot.transportKm, loadTonnes: slot.loadTonnes });
    return { ...wireSlot(slot), gate: gate ?? null, gateName: gate?.name ?? null, supplierNode: node ?? null, longLeadItem: item ?? null, offsiteUnit: unit ?? null, carbonEstimate: carbon };
  });

  app.patch(`${base}/slots/:slotId`, { preHandler: standardGate }, async (req) => {
    const { projectId, slotId } = req.params as { projectId: string; slotId: string };
    const body = slotPatchSchema.parse(req.body);
    const companyId = req.companyId!;
    const current = await loadSlot(companyId, projectId, slotId);
    const timingChanged = body.gateId !== undefined || body.startsAt !== undefined || body.endsAt !== undefined || body.craneRequired !== undefined || body.vehicleType !== undefined || body.laydownArea !== undefined;
    if (timingChanged && !EDITABLE.has(current.status)) throw badRequest(`A ${current.status.replace(/_/g, " ")} booking's time, gate, vehicle or crane cannot change.`);
    if (current.status === "cancelled") throw badRequest("A cancelled booking is read-only.");
    await validateRefs(companyId, projectId, body);
    const gate = await loadGate(companyId, projectId, body.gateId ?? current.gateId);
    const startsAt = body.startsAt ? new Date(body.startsAt).toISOString() : (isoTs(current.startsAt) ?? current.startsAt);
    const endsAt = body.endsAt ? new Date(body.endsAt).toISOString() : (isoTs(current.endsAt) ?? current.endsAt);
    if (timingChanged) {
      checkBooking(gate, await neighbours(gate.id, startsAt, endsAt), {
        startsAt,
        endsAt,
        craneRequired: body.craneRequired ?? current.craneRequired === 1,
        vehicleType: body.vehicleType ?? current.vehicleType,
        laydownArea: body.laydownArea === undefined ? current.laydownArea : body.laydownArea,
        excludeSlotId: current.id,
      });
    }
    const set = patchSet(body as Record<string, unknown>, [
      "gateId", "description", "supplierNodeId", "vendorId", "longLeadItemId", "offsiteUnitId", "materialDeliveryId", "scheduleTaskId", "vehicleType", "vehicleRegistration", "haulierName", "driverName", "driverPhone", "craneMinutes", "laydownArea", "transportMode", "originText", "originCountry", "transportKm", "loadTonnes",
    ]);
    if (body.startsAt) set["startsAt"] = startsAt;
    if (body.endsAt) set["endsAt"] = endsAt;
    if (body.craneRequired !== undefined) set["craneRequired"] = body.craneRequired ? 1 : 0;
    const [updated] = await app.db.update(deliverySlots).set(set).where(eq(deliverySlots.id, slotId)).returning();
    let row: SlotRow = updated!;
    if (row.status === "completed") {
      await syncSlotCarbon(app.db, row, req.user!.id);
      row = await loadSlot(companyId, projectId, slotId);
    } else {
      const preview = estimateTransportCarbon({ transportMode: row.transportMode, vehicleType: row.vehicleType, transportKm: row.transportKm, loadTonnes: row.loadTonnes });
      const [again] = await app.db
        .update(deliverySlots)
        .set({ carbonKgCo2e: preview.kgCo2e, carbonBasis: preview.kgCo2e === null ? preview.reasons.join(" ") : `${preview.basis} (estimate; booked in the carbon register on completion)` })
        .where(eq(deliverySlots.id, slotId))
        .returning();
      row = again ?? row;
    }
    if (body.offsiteUnitId) await app.db.update(offsiteUnits).set({ deliverySlotId: slotId, updatedAt: nowISO() }).where(eq(offsiteUnits.id, body.offsiteUnitId));
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "update", objectType: "delivery_slot", objectId: slotId, payload: body });
    return { ...wireSlot(row), gateName: gate.name };
  });

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  async function transition(req: FastifyRequest, slotId: string, from: readonly string[], to: string, set: Record<string, unknown>, payload: Record<string, unknown>) {
    const { projectId } = req.params as { projectId: string };
    const companyId = req.companyId!;
    const current = await loadSlot(companyId, projectId, slotId);
    if (!from.includes(current.status)) throw badRequest(`A ${current.status.replace(/_/g, " ")} booking cannot be marked ${to.replace(/_/g, " ")}.`);
    const [row] = await app.db.update(deliverySlots).set({ ...set, status: to, updatedAt: nowISO() }).where(eq(deliverySlots.id, slotId)).returning();
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "state_change", objectType: "delivery_slot", objectId: slotId, payload: { from: current.status, to, ...payload } });
    return { current, row: wireSlot(row!) };
  }

  app.post(`${base}/slots/:slotId/confirm`, { preHandler: standardGate }, async (req) => {
    const { slotId } = req.params as { slotId: string };
    const { row } = await transition(req, slotId, ["requested"], "confirmed", {}, {});
    return row;
  });

  app.post(`${base}/slots/:slotId/arrive`, { preHandler: standardGate }, async (req) => {
    const { projectId, slotId } = req.params as { projectId: string; slotId: string };
    const body = z.object({ arrivedAt: isoTimestampSchema.optional(), vehicleRegistration: z.string().max(20).optional(), driverName: z.string().max(120).optional() }).parse(req.body ?? {});
    const current = await loadSlot(req.companyId!, projectId, slotId);
    const arrivedAt = body.arrivedAt ? new Date(body.arrivedAt).toISOString() : nowISO();
    const arrival = assessArrival({ startsAt: isoTs(current.startsAt) ?? current.startsAt, endsAt: isoTs(current.endsAt) ?? current.endsAt }, arrivedAt, null);
    const { row } = await transition(req, slotId, ["requested", "confirmed", "no_show"], "arrived", {
      arrivedAt,
      wasOnTime: arrival.wasOnTime ? 1 : 0,
      lateMinutes: arrival.lateMinutes,
      ...(body.vehicleRegistration ? { vehicleRegistration: body.vehicleRegistration } : {}),
      ...(body.driverName ? { driverName: body.driverName } : {}),
    }, { arrivedAt, wasOnTime: arrival.wasOnTime, lateMinutes: arrival.lateMinutes });
    return { ...row, arrival };
  });

  app.post(`${base}/slots/:slotId/unloading`, { preHandler: standardGate }, async (req) => {
    const { projectId, slotId } = req.params as { projectId: string; slotId: string };
    const body = z.object({ at: isoTimestampSchema.optional() }).parse(req.body ?? {});
    const current = await loadSlot(req.companyId!, projectId, slotId);
    const at = body.at ? new Date(body.at).toISOString() : nowISO();
    const arrivedAt = isoTs(current.arrivedAt);
    const waiting = arrivedAt ? assessArrival({ startsAt: isoTs(current.startsAt) ?? current.startsAt, endsAt: isoTs(current.endsAt) ?? current.endsAt }, arrivedAt, at).waitingMinutes : null;
    const { row } = await transition(req, slotId, ["arrived"], "unloading", { unloadingStartedAt: at, waitingMinutes: waiting }, { unloadingStartedAt: at, waitingMinutes: waiting });
    return row;
  });

  app.post(`${base}/slots/:slotId/complete`, { preHandler: standardGate }, async (req) => {
    const { projectId, slotId } = req.params as { projectId: string; slotId: string };
    const body = completeSchema.parse(req.body ?? {});
    const companyId = req.companyId!;
    const current = await loadSlot(companyId, projectId, slotId);
    if (body.materialDeliveryId) await validateRefs(companyId, projectId, { materialDeliveryId: body.materialDeliveryId });
    if (body.issueKind && body.issueKind !== "none" && !body.issueNotes) throw badRequest("Describe the damage, shortage or documentation problem: the register is what the supplier claim is built on.");
    const completedAt = body.completedAt ? new Date(body.completedAt).toISOString() : nowISO();
    const arrivedAt = isoTs(current.arrivedAt);
    const unloadingAt = isoTs(current.unloadingStartedAt);
    const waiting = current.waitingMinutes ?? (arrivedAt && unloadingAt ? assessArrival({ startsAt: isoTs(current.startsAt) ?? current.startsAt, endsAt: isoTs(current.endsAt) ?? current.endsAt }, arrivedAt, unloadingAt).waitingMinutes : null);
    const { row } = await transition(req, slotId, ["arrived", "unloading"], "completed", {
      completedAt,
      waitingMinutes: waiting,
      issueKind: body.issueKind ?? current.issueKind,
      issueNotes: body.issueNotes === undefined ? current.issueNotes : body.issueNotes,
      transportKm: body.transportKm === undefined ? current.transportKm : body.transportKm,
      loadTonnes: body.loadTonnes === undefined ? current.loadTonnes : body.loadTonnes,
      materialDeliveryId: body.materialDeliveryId ?? current.materialDeliveryId,
    }, { completedAt, issueKind: body.issueKind ?? current.issueKind });

    const carbon = await syncSlotCarbon(app.db, row, req.user!.id);

    // The chain moves with the delivery (#921).
    const effects: Record<string, unknown> = {};
    if (row.longLeadItemId) {
      const [item] = await app.db.select().from(longLeadItems).where(and(eq(longLeadItems.id, row.longLeadItemId), eq(longLeadItems.projectId, projectId))).limit(1);
      if (item && ["ordered", "in_production", "shipped", "in_customs"].includes(item.status)) {
        const arrivedOn = completedAt.slice(0, 10);
        const [stamped] = await app.db.update(longLeadItems).set({ status: "arrived", actualArrivalDate: arrivedOn, updatedAt: nowISO() }).where(eq(longLeadItems.id, item.id)).returning();
        const ctx = await loadLongLeadContext(app.db, projectId, [stamped!]);
        await persistAssessment(app.db, stamped!, ctx, todayISO(), req.user!.id);
        await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "state_change", objectType: "long_lead_item", objectId: item.id, payload: { from: item.status, to: "arrived", milestone: "arrived", at: arrivedOn, via: `delivery_slot:${row.id}` } });
        effects["longLeadItem"] = { id: item.id, reference: item.reference, from: item.status, to: "arrived" };
      }
    }
    if (row.offsiteUnitId) {
      const [unit] = await app.db.select().from(offsiteUnits).where(and(eq(offsiteUnits.id, row.offsiteUnitId), eq(offsiteUnits.projectId, projectId))).limit(1);
      if (unit && (unit.status === "ready_to_ship" || unit.status === "in_transit")) {
        const [moved] = await app.db.update(offsiteUnits).set({ status: "delivered", actualDeliveryDate: completedAt.slice(0, 10), deliverySlotId: row.id, updatedAt: nowISO() }).where(eq(offsiteUnits.id, unit.id)).returning();
        await recomputeUnit(app.db, moved!);
        await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "state_change", objectType: "offsite_unit", objectId: unit.id, payload: { from: unit.status, to: "delivered", via: `delivery_slot:${row.id}` } });
        effects["offsiteUnit"] = { id: unit.id, reference: unit.reference, from: unit.status, to: "delivered" };
      }
    }
    const fresh = await loadSlot(companyId, projectId, slotId);
    return { ...wireSlot(fresh), carbon, effects };
  });

  app.post(`${base}/slots/:slotId/no-show`, { preHandler: standardGate }, async (req) => {
    const { slotId } = req.params as { slotId: string };
    const body = z.object({ note: z.string().max(2000).optional() }).parse(req.body ?? {});
    const { row } = await transition(req, slotId, ["requested", "confirmed"], "no_show", { issueKind: "late", issueNotes: body.note ?? null }, { note: body.note ?? null });
    return row;
  });

  app.post(`${base}/slots/:slotId/cancel`, { preHandler: standardGate }, async (req) => {
    const { slotId } = req.params as { slotId: string };
    const body = z.object({ reason: z.string().min(1).max(2000) }).parse(req.body);
    const { row } = await transition(req, slotId, ["requested", "confirmed", "no_show"], "cancelled", { issueNotes: body.reason }, { reason: body.reason });
    if (row.offsiteUnitId) await app.db.update(offsiteUnits).set({ deliverySlotId: null, updatedAt: nowISO() }).where(and(eq(offsiteUnits.id, row.offsiteUnitId), eq(offsiteUnits.deliverySlotId, slotId)));
    return row;
  });

  /* ---------------------------------------------------------------- */
  /* Analytics and sweeps                                              */
  /* ---------------------------------------------------------------- */

  app.get(`${base}/on-time`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = z.object({ from: isoDateSchema.optional(), to: isoDateSchema.optional() }).parse(req.query);
    const rows = await app.db
      .select({ id: deliverySlots.id, gateId: deliverySlots.gateId, status: deliverySlots.status, wasOnTime: deliverySlots.wasOnTime, lateMinutes: deliverySlots.lateMinutes, waitingMinutes: deliverySlots.waitingMinutes, supplierNodeId: deliverySlots.supplierNodeId, vendorId: deliverySlots.vendorId, haulierName: deliverySlots.haulierName, issueKind: deliverySlots.issueKind, carbonKgCo2e: deliverySlots.carbonKgCo2e, transportKm: deliverySlots.transportKm })
      .from(deliverySlots)
      .where(
        and(
          eq(deliverySlots.companyId, req.companyId!),
          eq(deliverySlots.projectId, projectId),
          q.from ? gte(deliverySlots.startsAt, `${q.from}T00:00:00.000Z`) : undefined,
          q.to ? lte(deliverySlots.startsAt, `${q.to}T23:59:59.999Z`) : undefined,
        ),
      )
      .limit(5000);
    const overall = onTimeDelivery(rows);
    const group = <K extends string>(key: (r: (typeof rows)[number]) => K | null) => {
      const buckets = new Map<K, typeof rows>();
      for (const r of rows) {
        const k = key(r);
        if (!k) continue;
        const list = buckets.get(k) ?? [];
        list.push(r);
        buckets.set(k, list);
      }
      return [...buckets.entries()].map(([k, list]) => ({ key: k, ...onTimeDelivery(list) }));
    };
    const nodeIds = [...new Set(rows.map((r) => r.supplierNodeId).filter((x): x is string => Boolean(x)))];
    const nodeNames = nodeIds.length > 0 ? await app.db.select({ id: supplyChainNodes.id, name: supplyChainNodes.name }).from(supplyChainNodes).where(inArray(supplyChainNodes.id, nodeIds)) : [];
    const nameOf = new Map(nodeNames.map((n) => [n.id, n.name]));
    const issues: Record<string, number> = {};
    for (const r of rows) if (r.status === "completed" && r.issueKind !== "none") issues[r.issueKind] = (issues[r.issueKind] ?? 0) + 1;
    const withKm = rows.filter((r) => r.status === "completed" && r.carbonKgCo2e !== null);
    const completed = rows.filter((r) => r.status === "completed").length;
    return {
      from: q.from ?? null,
      to: q.to ?? null,
      overall,
      bySupplier: group((r) => r.supplierNodeId).map((b) => ({ ...b, name: nameOf.get(b.key) ?? b.key })),
      byHaulier: group((r) => r.haulierName),
      byGate: group((r) => r.gateId),
      issues,
      carbon: {
        kgCo2e: withKm.length > 0 ? Math.round(withKm.reduce((s, r) => s + (r.carbonKgCo2e ?? 0), 0) * 100) / 100 : null,
        deliveriesWithDistance: withKm.length,
        deliveriesWithoutDistance: completed - withKm.length,
        reasons: withKm.length === 0 ? ["No completed delivery has a transport distance recorded; the transport carbon figure cannot be produced."] : completed - withKm.length > 0 ? [`${completed - withKm.length} completed delivery(ies) have no distance and are not in the figure.`] : [],
        basis: "Generic per-km factors by vehicle type / per-tonne-km by mode; see each slot's carbonBasis.",
      },
      method: "On time = arrived within 15 minutes of the booked start. Only completed deliveries with an arrival time are assessed; no-shows are counted separately.",
    };
  });

  app.post(`${base}/no-show-sweep`, { preHandler: standardGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    return sweepDeliveryNoShows(app.db, req.companyId!, new Date(), projectId);
  });

  void desc;
};
