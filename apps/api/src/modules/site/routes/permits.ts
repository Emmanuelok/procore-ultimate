/**
 * PERMITS TO WORK, EXCLUSION ZONES AND LONE WORKING (spec Vol II Z #1070–1073).
 *
 * Every rule the permit engine enforces is here as a refusal with a reason:
 * an approver who is the requester, an activation with precautions
 * outstanding, an excavation permit with no utility survey behind it, a
 * closure with people still inside, hot work closed before the fire watch.
 *
 * Exclusion zones are closed polygon rings; `POST .../zones/check` answers
 * "is this position inside a live zone" with point-in-polygon, which is what
 * a phone, a gate reader or a plant tracker asks.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  siteExclusionZones,
  siteLoneWorkerCheckins,
  siteLoneWorkerSessions,
  sitePermitEntries,
  sitePermits,
} from "@constructos/db";
import {
  SITE_EXCLUSION_ZONE_KINDS,
  SITE_PERMIT_TYPES,
  SIGNAL_SEVERITIES,
} from "@constructos/shared";
import { badRequest, conflict, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { zonesContaining, type ZoneShape } from "../engines/geometry.js";
import { canTransition, loneWorkerDue, overdueEntries, type PermitState } from "../engines/permits.js";
import { sweepLoneWorkers, sweepPermitEntries, sweepPermitExpiry } from "../service.js";
import {
  addMinutesISO,
  allocateReference,
  assertLocation,
  assertVendor,
  assertWorker,
  buildGates,
  fileIdsSchema,
  idSchema,
  isoTimestampSchema,
  latSchema,
  ledger,
  lonSchema,
  minutesBetween,
  notFoundIfMissing,
  notifyUsers,
  nowISO,
  patchSchemaOf,
  patchSet,
  ringSchema,
} from "../shared.js";

const precautionSchema = z.object({
  item: z.string().trim().min(1).max(300),
  required: z.boolean().default(true),
  done: z.boolean().default(false),
  note: z.string().max(500).optional(),
});

const permitBody = z.object({
  permitType: z.enum(SITE_PERMIT_TYPES),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(6000).nullish(),
  locationId: idSchema.nullish(),
  locationDescription: z.string().max(300).nullish(),
  exclusionZoneId: idSchema.nullish(),
  vendorId: idSchema.nullish(),
  supervisorName: z.string().trim().max(200).nullish(),
  validFrom: isoTimestampSchema.nullish(),
  validTo: isoTimestampSchema.nullish(),
  precautions: z.array(precautionSchema).max(100).default([]),
  isolations: z
    .array(
      z.object({
        ref: z.string().trim().min(1).max(100),
        description: z.string().trim().min(1).max(500),
        appliedAt: isoTimestampSchema.optional(),
        removedAt: isoTimestampSchema.optional(),
      }),
    )
    .max(100)
    .default([]),
  maxOccupancy: z.number().int().min(1).max(500).nullish(),
  requiresGasTest: z.boolean().default(false),
  gasTestIntervalMinutes: z.number().int().min(1).max(1440).nullish(),
  fireWatchMinutes: z.number().int().min(0).max(1440).nullish(),
  utilityScanId: idSchema.nullish(),
  riskAssessmentRef: z.string().max(200).nullish(),
  safetyRecordId: idSchema.nullish(),
  fileIds: fileIdsSchema.default([]),
  notes: z.string().max(4000).nullish(),
});

const zoneBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind: z.enum(SITE_EXCLUSION_ZONE_KINDS).default("other"),
    permitId: idSchema.nullish(),
    ring: ringSchema.optional(),
    centreLat: latSchema.nullish(),
    centreLon: lonSchema.nullish(),
    radiusM: z.number().positive().max(50_000).nullish(),
    severity: z.enum(SIGNAL_SEVERITIES).default("high"),
    activeFrom: isoTimestampSchema.nullish(),
    activeTo: isoTimestampSchema.nullish(),
    description: z.string().max(2000).nullish(),
  })
  .refine(
    (v) =>
      (v.ring !== undefined && v.ring.length >= 3) ||
      (typeof v.centreLat === "number" && typeof v.centreLon === "number" && typeof v.radiusM === "number"),
    {
      message:
        "An exclusion zone needs either a ring of at least three [lon, lat] points or a centre (lat/lon) with a radius in metres. A zone with neither cannot be tested against a position.",
    },
  );

type PermitPrecaution = { item: string; required: boolean; done: boolean; note?: string };

/**
 * Apply a submitted precaution list to the one recorded on the permit.
 *
 * Ticking a precaution at the point of issue is legitimate; REWRITING the list
 * the approver signed off is not. Recorded entries keep their `item` and their
 * `required` flag — only `done` and the note may change — so an activation body
 * can tick a precaution but can never delete one or turn a required precaution
 * into an optional one. Genuinely new items are appended.
 */
function mergePrecautions(
  recorded: readonly PermitPrecaution[],
  submitted: readonly PermitPrecaution[],
): PermitPrecaution[] {
  const remaining = new Map(submitted.map((p) => [p.item, p]));
  const merged = recorded.map((p) => {
    const update = remaining.get(p.item);
    remaining.delete(p.item);
    if (!update) return p;
    return { ...p, done: update.done, ...(update.note === undefined ? {} : { note: update.note }) };
  });
  return [...merged, ...remaining.values()];
}

export const permitRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate, adminGate } = buildGates(app);
  const base = "/projects/:projectId/site";

  async function loadPermit(companyId: string, projectId: string, id: string) {
    const row = notFoundIfMissing(
      (
        await app.db
          .select()
          .from(sitePermits)
          .where(and(eq(sitePermits.id, id), eq(sitePermits.companyId, companyId), eq(sitePermits.projectId, projectId)))
          .limit(1)
      )[0],
      "Permit",
    );
    const [inside] = await app.db
      .select({ n: count() })
      .from(sitePermitEntries)
      .where(and(eq(sitePermitEntries.permitId, id), inArray(sitePermitEntries.status, ["inside", "overdue"])));
    return { row, openEntries: inside?.n ?? 0 };
  }

  function toState(row: typeof sitePermits.$inferSelect, openEntries: number): PermitState {
    return {
      status: row.status as PermitState["status"],
      permitType: row.permitType,
      requestedBy: row.requestedBy,
      approvedBy: row.approvedBy,
      validFrom: row.validFrom,
      validTo: row.validTo,
      precautions: row.precautions ?? [],
      utilityScanId: row.utilityScanId,
      fireWatchMinutes: row.fireWatchMinutes,
      fireWatchCompletedAt: row.fireWatchCompletedAt,
      closedAt: row.closedAt,
      openEntries,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Permits                                                           */
  /* ---------------------------------------------------------------- */

  app.get(`${base}/permits`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({
        status: z.string().max(20).optional(),
        permitType: z.enum(SITE_PERMIT_TYPES).optional(),
        vendorId: idSchema.optional(),
        open: z.coerce.boolean().optional(),
      })
      .parse(req.query);
    const where = and(
      eq(sitePermits.companyId, req.companyId!),
      eq(sitePermits.projectId, projectId),
      q.status ? eq(sitePermits.status, q.status) : undefined,
      q.permitType ? eq(sitePermits.permitType, q.permitType) : undefined,
      q.vendorId ? eq(sitePermits.vendorId, q.vendorId) : undefined,
      q.open ? inArray(sitePermits.status, ["requested", "approved", "active", "suspended"]) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(sitePermits).where(where).orderBy(desc(sitePermits.createdAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(sitePermits).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post(`${base}/permits`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = permitBody.parse(req.body);
    const companyId = req.companyId!;
    if (body.locationId) await assertLocation(app.db, projectId, body.locationId);
    if (body.vendorId) await assertVendor(app.db, companyId, body.vendorId);
    if (body.validFrom && body.validTo && Date.parse(body.validTo) <= Date.parse(body.validFrom)) {
      throw badRequest("A permit's validity must end after it begins.");
    }
    const { number, reference } = await allocateReference(app.db, projectId, "site_permit", "PTW");
    const id = newId("ptw");
    const [row] = await app.db
      .insert(sitePermits)
      .values({
        id,
        companyId,
        projectId,
        number,
        reference,
        permitType: body.permitType,
        title: body.title,
        description: body.description ?? null,
        locationId: body.locationId ?? null,
        locationDescription: body.locationDescription ?? null,
        exclusionZoneId: body.exclusionZoneId ?? null,
        vendorId: body.vendorId ?? null,
        supervisorName: body.supervisorName ?? null,
        status: "draft",
        validFrom: body.validFrom ?? null,
        validTo: body.validTo ?? null,
        requestedBy: req.user!.id,
        precautions: body.precautions,
        isolations: body.isolations,
        maxOccupancy: body.maxOccupancy ?? null,
        requiresGasTest: body.requiresGasTest ? 1 : 0,
        gasTestIntervalMinutes: body.gasTestIntervalMinutes ?? null,
        fireWatchMinutes: body.fireWatchMinutes ?? null,
        utilityScanId: body.utilityScanId ?? null,
        riskAssessmentRef: body.riskAssessmentRef ?? null,
        safetyRecordId: body.safetyRecordId ?? null,
        fileIds: body.fileIds,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "site_permit",
      objectId: id,
      payload: { reference, permitType: body.permitType, title: body.title },
    });
    return reply.code(201).send(row);
  });

  app.get(`${base}/permits/:id`, { preHandler: readGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const { row, openEntries } = await loadPermit(companyId, projectId, id);
    const entries = await app.db
      .select()
      .from(sitePermitEntries)
      .where(and(eq(sitePermitEntries.permitId, id), eq(sitePermitEntries.companyId, companyId)))
      .orderBy(desc(sitePermitEntries.enteredAt))
      .limit(500);
    const zone = row.exclusionZoneId
      ? (
          await app.db
            .select()
            .from(siteExclusionZones)
            .where(and(eq(siteExclusionZones.id, row.exclusionZoneId), eq(siteExclusionZones.companyId, companyId)))
            .limit(1)
        )[0] ?? null
      : null;
    const state = toState(row, openEntries);
    const now = nowISO();
    const transitions = (["request", "approve", "activate", "suspend", "close", "cancel"] as const).map((action) => {
      const verdict = canTransition(state, action, { userId: req.user!.id }, now);
      return verdict.allowed
        ? { action, allowed: true as const, warnings: verdict.warnings }
        : { action, allowed: false as const, reason: verdict.reason };
    });
    return {
      ...row,
      openEntries,
      entries,
      exclusionZone: zone,
      overdueEntries: overdueEntries(
        entries.map((e) => ({
          id: e.id,
          personName: e.personName,
          enteredAt: e.enteredAt,
          expectedExitAt: e.expectedExitAt,
          status: e.status,
        })),
        now,
      ),
      transitions,
    };
  });

  app.patch(`${base}/permits/:id`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const body = patchSchemaOf(permitBody).parse(req.body);
    const { row } = await loadPermit(companyId, projectId, id);
    if (!["draft", "requested"].includes(row.status)) {
      throw conflict(
        `Permit ${row.reference} is ${row.status}. The terms of an issued permit are not editable — cancel it and raise a new one, so the record of what was authorised stays true.`,
      );
    }
    if (body.locationId) await assertLocation(app.db, projectId, body.locationId);
    if (body.vendorId) await assertVendor(app.db, companyId, body.vendorId);
    const set = patchSet(body as Record<string, unknown>, [
      "permitType",
      "title",
      "description",
      "locationId",
      "locationDescription",
      "exclusionZoneId",
      "vendorId",
      "supervisorName",
      "validFrom",
      "validTo",
      "precautions",
      "isolations",
      "maxOccupancy",
      "gasTestIntervalMinutes",
      "fireWatchMinutes",
      "utilityScanId",
      "riskAssessmentRef",
      "safetyRecordId",
      "fileIds",
      "notes",
    ]);
    if (body.requiresGasTest !== undefined) set["requiresGasTest"] = body.requiresGasTest ? 1 : 0;
    const [updated] = await app.db
      .update(sitePermits)
      .set(set)
      .where(and(eq(sitePermits.id, id), eq(sitePermits.companyId, companyId)))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "site_permit",
      objectId: id,
      payload: set,
    });
    return updated;
  });

  const transition = (
    action: "request" | "approve" | "reject" | "activate" | "suspend" | "close" | "cancel",
  ) =>
    app.post(`${base}/permits/:id/${action}`, { preHandler: standardGate }, async (req) => {
      const { projectId, id } = req.params as { projectId: string; id: string };
      const companyId = req.companyId!;
      const body = z
        .object({
          reason: z.string().trim().max(2000).optional(),
          notes: z.string().trim().max(4000).optional(),
          precautions: z.array(precautionSchema).max(100).optional(),
        })
        .parse(req.body ?? {});
      const { row, openEntries } = await loadPermit(companyId, projectId, id);
      const at = nowISO();

      // A transition body may tick the recorded precautions; it may not replace
      // them. Without the merge, `activate` with `precautions: []` would clear
      // the approved list and walk straight past the outstanding-precaution
      // refusal that is the whole point of the control.
      const precautions = body.precautions
        ? mergePrecautions(row.precautions ?? [], body.precautions)
        : undefined;

      const state = toState(row, openEntries);
      if (action === "activate" && precautions) state.precautions = precautions;
      const verdict = canTransition(state, action, { userId: req.user!.id }, at);
      if (!verdict.allowed) throw conflict(verdict.reason);
      if (action === "reject" && !body.reason) throw badRequest("A rejection must carry a reason.");
      if (action === "suspend" && !body.reason) throw badRequest("A suspension must carry a reason.");

      const set: Record<string, unknown> = { updatedAt: at };
      if (precautions) set["precautions"] = precautions;
      switch (action) {
        case "request":
          set["status"] = "requested";
          set["requestedAt"] = at;
          break;
        case "approve":
          set["status"] = "approved";
          set["approvedBy"] = req.user!.id;
          set["approvedAt"] = at;
          break;
        case "reject":
          set["status"] = "rejected";
          set["rejectedBy"] = req.user!.id;
          set["rejectedAt"] = at;
          set["rejectionReason"] = body.reason ?? null;
          break;
        case "activate":
          set["status"] = "active";
          set["issuedAt"] = row.issuedAt ?? at;
          break;
        case "suspend":
          set["status"] = "suspended";
          set["suspendedAt"] = at;
          set["suspendReason"] = body.reason ?? null;
          break;
        case "close":
          set["status"] = "closed";
          set["closedBy"] = req.user!.id;
          set["closedAt"] = at;
          set["closureNotes"] = body.notes ?? null;
          break;
        case "cancel":
          set["status"] = "cancelled";
          set["closureNotes"] = body.reason ?? null;
          break;
      }

      const [updated] = await app.db
        .update(sitePermits)
        .set(set)
        .where(and(eq(sitePermits.id, id), eq(sitePermits.companyId, companyId), eq(sitePermits.status, row.status)))
        .returning();
      if (!updated) throw conflict("The permit changed while this transition was being applied. Reload and try again.");

      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "site_permit",
        objectId: id,
        payload: { action, from: row.status, to: set["status"], reason: body.reason ?? null },
      });
      if (action === "approve" || action === "reject") {
        await notifyUsers(app.db, {
          companyId,
          projectId,
          userIds: [row.requestedBy],
          kind: "status_change",
          title: `Permit ${row.reference} ${action === "approve" ? "approved" : "rejected"}`,
          body: action === "approve" ? `"${row.title}" may now be activated.` : `"${row.title}" was rejected: ${body.reason}`,
          recordType: "site_permit",
          recordId: id,
        });
      }
      return { ...updated, warnings: verdict.warnings };
    });
  transition("request");
  transition("approve");
  transition("reject");
  transition("activate");
  transition("suspend");
  transition("close");
  transition("cancel");

  app.post(`${base}/permits/:id/fire-watch`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const { completedAt } = z.object({ completedAt: isoTimestampSchema.optional() }).parse(req.body ?? {});
    const { row } = await loadPermit(companyId, projectId, id);
    if (row.permitType !== "hot_work") throw badRequest("A fire watch is only recorded against a hot-work permit.");
    if (!row.fireWatchMinutes) throw badRequest("This permit does not require a fire watch; set the fire-watch duration first.");
    const at = completedAt ?? nowISO();
    const [updated] = await app.db
      .update(sitePermits)
      .set({ fireWatchCompletedAt: at, updatedAt: nowISO() })
      .where(and(eq(sitePermits.id, id), eq(sitePermits.companyId, companyId)))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "site_permit",
      objectId: id,
      payload: { fireWatchCompletedAt: at, fireWatchMinutes: row.fireWatchMinutes },
    });
    return updated;
  });

  /* ---------------------------------------------------------------- */
  /* Entries (live occupancy of a permitted space)                     */
  /* ---------------------------------------------------------------- */

  app.post(`${base}/permits/:id/entries`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const body = z
      .object({
        personName: z.string().trim().min(1).max(200),
        workerId: idSchema.nullish(),
        passId: idSchema.nullish(),
        attendantName: z.string().trim().max(200).nullish(),
        enteredAt: isoTimestampSchema.optional(),
        expectedExitAt: isoTimestampSchema.optional(),
        expectedDurationMinutes: z.number().int().min(1).max(1440).optional(),
        notes: z.string().max(2000).nullish(),
      })
      .parse(req.body);
    const { row, openEntries } = await loadPermit(companyId, projectId, id);
    if (row.status !== "active") {
      throw conflict(`Permit ${row.reference} is ${row.status}. Nobody may enter under a permit that is not active.`);
    }
    if (body.workerId) await assertWorker(app.db, projectId, body.workerId);
    if (row.maxOccupancy !== null && openEntries >= row.maxOccupancy) {
      throw conflict(
        `Permit ${row.reference} allows ${row.maxOccupancy} person(s) inside and ${openEntries} are already recorded. Record an exit first.`,
      );
    }
    const enteredAt = body.enteredAt ?? nowISO();
    const expectedExitAt =
      body.expectedExitAt ??
      (body.expectedDurationMinutes ? addMinutesISO(enteredAt, body.expectedDurationMinutes) : row.validTo);
    if (!expectedExitAt) {
      throw badRequest(
        "An entry needs an expected exit time: give `expectedExitAt`, `expectedDurationMinutes`, or set the permit's validity end. Without one, nobody can be overdue.",
      );
    }
    const entryId = newId("pen");
    const [entry] = await app.db
      .insert(sitePermitEntries)
      .values({
        id: entryId,
        companyId,
        projectId,
        permitId: id,
        personName: body.personName,
        workerId: body.workerId ?? null,
        passId: body.passId ?? null,
        attendantName: body.attendantName ?? null,
        enteredAt,
        expectedExitAt,
        status: "inside",
        notes: body.notes ?? null,
        recordedBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "site_permit_entry",
      objectId: entryId,
      payload: { permitId: id, personName: body.personName, enteredAt, expectedExitAt },
    });
    return reply.code(201).send(entry);
  });

  app.post(`${base}/permits/:permitId/entries/:entryId/exit`, { preHandler: standardGate }, async (req) => {
    const { projectId, permitId, entryId } = req.params as { projectId: string; permitId: string; entryId: string };
    const companyId = req.companyId!;
    const { exitedAt } = z.object({ exitedAt: isoTimestampSchema.optional() }).parse(req.body ?? {});
    const at = exitedAt ?? nowISO();
    const [entry] = await app.db
      .update(sitePermitEntries)
      .set({ status: "exited", exitedAt: at, updatedAt: nowISO() })
      .where(
        and(
          eq(sitePermitEntries.id, entryId),
          eq(sitePermitEntries.permitId, permitId),
          eq(sitePermitEntries.companyId, companyId),
          eq(sitePermitEntries.projectId, projectId),
          inArray(sitePermitEntries.status, ["inside", "overdue"]),
        ),
      )
      .returning();
    if (!entry) throw notFound("Entry not found, or the person is already recorded as out");
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "site_permit_entry",
      objectId: entryId,
      payload: { to: "exited", exitedAt: at, insideMinutes: Math.round(minutesBetween(entry.enteredAt, at)) },
    });
    return entry;
  });

  app.post(`${base}/permits/:permitId/entries/:entryId/gas-reading`, { preHandler: standardGate }, async (req) => {
    const { projectId, permitId, entryId } = req.params as { projectId: string; permitId: string; entryId: string };
    const companyId = req.companyId!;
    const reading = z
      .object({
        gas: z.string().trim().min(1).max(40),
        value: z.number(),
        unit: z.string().trim().min(1).max(20),
        safe: z.boolean(),
        at: isoTimestampSchema.optional(),
      })
      .parse(req.body);
    const existing = notFoundIfMissing(
      (
        await app.db
          .select()
          .from(sitePermitEntries)
          .where(
            and(
              eq(sitePermitEntries.id, entryId),
              eq(sitePermitEntries.permitId, permitId),
              eq(sitePermitEntries.companyId, companyId),
              eq(sitePermitEntries.projectId, projectId),
            ),
          )
          .limit(1)
      )[0],
      "Entry",
    );
    const readings = [...(existing.gasReadings ?? []), { ...reading, at: reading.at ?? nowISO() }].slice(-200);
    const [updated] = await app.db
      .update(sitePermitEntries)
      .set({ gasReadings: readings, updatedAt: nowISO() })
      .where(and(eq(sitePermitEntries.id, entryId), eq(sitePermitEntries.companyId, companyId)))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "site_permit_entry",
      objectId: entryId,
      payload: { gasReading: reading },
    });
    return updated;
  });

  /* ---------------------------------------------------------------- */
  /* Exclusion zones                                                   */
  /* ---------------------------------------------------------------- */

  app.get(`${base}/zones`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema.extend({ status: z.string().max(20).optional() }).parse(req.query);
    const where = and(
      eq(siteExclusionZones.companyId, req.companyId!),
      eq(siteExclusionZones.projectId, projectId),
      q.status ? eq(siteExclusionZones.status, q.status) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(siteExclusionZones).where(where).orderBy(desc(siteExclusionZones.createdAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(siteExclusionZones).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post(`${base}/zones`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = zoneBody.parse(req.body);
    const companyId = req.companyId!;
    const id = newId("ezn");
    const [row] = await app.db
      .insert(siteExclusionZones)
      .values({
        id,
        companyId,
        projectId,
        name: body.name,
        kind: body.kind,
        permitId: body.permitId ?? null,
        ring: body.ring ?? [],
        centreLat: body.centreLat ?? null,
        centreLon: body.centreLon ?? null,
        radiusM: body.radiusM ?? null,
        status: body.activeFrom && Date.parse(body.activeFrom) <= Date.now() ? "active" : "planned",
        severity: body.severity,
        activeFrom: body.activeFrom ?? null,
        activeTo: body.activeTo ?? null,
        description: body.description ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "site_exclusion_zone",
      objectId: id,
      payload: { name: body.name, kind: body.kind, vertices: body.ring?.length ?? 0, radiusM: body.radiusM ?? null },
    });
    return reply.code(201).send(row);
  });

  const zoneTransition = (action: "activate" | "lift" | "cancel") =>
    app.post(`${base}/zones/:id/${action}`, { preHandler: standardGate }, async (req) => {
      const { projectId, id } = req.params as { projectId: string; id: string };
      const companyId = req.companyId!;
      const at = nowISO();
      const target = action === "activate" ? "active" : action === "lift" ? "lifted" : "cancelled";
      const from = action === "activate" ? (["planned", "lifted"] as const) : (["planned", "active"] as const);
      const [row] = await app.db
        .update(siteExclusionZones)
        .set({
          status: target,
          updatedAt: at,
          ...(action === "activate" ? { activeFrom: at, liftedAt: null, liftedBy: null } : {}),
          ...(action === "lift" ? { liftedAt: at, liftedBy: req.user!.id } : {}),
        })
        .where(
          and(
            eq(siteExclusionZones.id, id),
            eq(siteExclusionZones.companyId, companyId),
            eq(siteExclusionZones.projectId, projectId),
            inArray(siteExclusionZones.status, [...from]),
          ),
        )
        .returning();
      if (!row) {
        throw conflict(
          `The zone could not be ${action}d: it does not exist here, or its status is not one of ${from.join(", ")}.`,
        );
      }
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "site_exclusion_zone",
        objectId: id,
        payload: { action, to: target },
      });
      return row;
    });
  zoneTransition("activate");
  zoneTransition("lift");
  zoneTransition("cancel");

  app.post(`${base}/zones/check`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const body = z
      .object({
        lat: latSchema,
        lon: lonSchema,
        at: isoTimestampSchema.optional(),
        includePlanned: z.boolean().default(false),
      })
      .parse(req.body);
    const statuses = body.includePlanned ? ["active", "planned"] : ["active"];
    const zones = await app.db
      .select()
      .from(siteExclusionZones)
      .where(
        and(
          eq(siteExclusionZones.companyId, req.companyId!),
          eq(siteExclusionZones.projectId, projectId),
          inArray(siteExclusionZones.status, statuses),
        ),
      )
      .limit(2000);
    const shapes: ZoneShape[] = zones.map((z) => ({
      id: z.id,
      name: z.name,
      ring: z.ring ?? [],
      centreLat: z.centreLat,
      centreLon: z.centreLon,
      radiusM: z.radiusM,
    }));
    const { hits, unusable } = zonesContaining({ lat: body.lat, lon: body.lon }, shapes);
    const byId = new Map(zones.map((z) => [z.id, z]));
    return {
      inside: hits.length > 0,
      hits: hits.map((h) => {
        const zone = byId.get(h.zoneId);
        return {
          ...h,
          kind: zone?.kind ?? null,
          severity: zone?.severity ?? null,
          permitId: zone?.permitId ?? null,
          activeTo: zone?.activeTo ?? null,
        };
      }),
      zonesTested: shapes.length - unusable.length,
      unusableZoneIds: unusable,
      reasons:
        unusable.length > 0
          ? [
              `${unusable.length} zone(s) hold neither a usable ring nor a centre and radius, so this position could not be tested against them. They are named rather than treated as a miss.`,
            ]
          : [],
    };
  });

  /* ---------------------------------------------------------------- */
  /* Lone working                                                      */
  /* ---------------------------------------------------------------- */

  app.get(`${base}/lone-workers`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema.extend({ status: z.string().max(20).optional() }).parse(req.query);
    const where = and(
      eq(siteLoneWorkerSessions.companyId, req.companyId!),
      eq(siteLoneWorkerSessions.projectId, projectId),
      q.status ? eq(siteLoneWorkerSessions.status, q.status) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(siteLoneWorkerSessions).where(where).orderBy(asc(siteLoneWorkerSessions.nextDueAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(siteLoneWorkerSessions).where(where),
    ]);
    const now = nowISO();
    const due = loneWorkerDue(
      rows.map((r) => ({
        id: r.id,
        personName: r.personName,
        status: r.status,
        nextDueAt: r.nextDueAt,
        intervalMinutes: r.intervalMinutes,
        missedCount: r.missedCount,
        expectedEndAt: r.expectedEndAt,
      })),
      now,
    );
    return { ...paginate(rows, total?.n ?? 0, q), due, asOf: now };
  });

  app.post(`${base}/lone-workers`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const companyId = req.companyId!;
    const body = z
      .object({
        personName: z.string().trim().min(1).max(200),
        workerId: idSchema.nullish(),
        passId: idSchema.nullish(),
        activity: z.string().trim().min(1).max(500),
        locationId: idSchema.nullish(),
        locationDescription: z.string().max(300).nullish(),
        lat: latSchema.nullish(),
        lon: lonSchema.nullish(),
        startedAt: isoTimestampSchema.optional(),
        intervalMinutes: z.number().int().min(5).max(240).default(30),
        expectedEndAt: isoTimestampSchema.nullish(),
        contactName: z.string().max(200).nullish(),
        contactPhone: z.string().max(60).nullish(),
        watcherUserIds: z.array(idSchema).max(50).default([]),
        notes: z.string().max(2000).nullish(),
      })
      .parse(req.body);
    if (body.workerId) await assertWorker(app.db, projectId, body.workerId);
    if (body.locationId) await assertLocation(app.db, projectId, body.locationId);
    const startedAt = body.startedAt ?? nowISO();
    const id = newId("lws");
    const [row] = await app.db
      .insert(siteLoneWorkerSessions)
      .values({
        id,
        companyId,
        projectId,
        workerId: body.workerId ?? null,
        passId: body.passId ?? null,
        personName: body.personName,
        activity: body.activity,
        locationId: body.locationId ?? null,
        locationDescription: body.locationDescription ?? null,
        lat: body.lat ?? null,
        lon: body.lon ?? null,
        startedAt,
        intervalMinutes: body.intervalMinutes,
        nextDueAt: addMinutesISO(startedAt, body.intervalMinutes),
        expectedEndAt: body.expectedEndAt ?? null,
        status: "active",
        contactName: body.contactName ?? null,
        contactPhone: body.contactPhone ?? null,
        watcherUserIds: body.watcherUserIds,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "site_lone_worker_session",
      objectId: id,
      payload: { personName: body.personName, activity: body.activity, intervalMinutes: body.intervalMinutes },
    });
    return reply.code(201).send(row);
  });

  app.post(`${base}/lone-workers/:id/check-in`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const body = z
      .object({
        at: isoTimestampSchema.optional(),
        lat: latSchema.nullish(),
        lon: lonSchema.nullish(),
        method: z.enum(["mobile", "radio", "phone", "manual"]).default("mobile"),
        ok: z.boolean().default(true),
        note: z.string().max(1000).nullish(),
      })
      .parse(req.body ?? {});
    const session = notFoundIfMissing(
      (
        await app.db
          .select()
          .from(siteLoneWorkerSessions)
          .where(
            and(
              eq(siteLoneWorkerSessions.id, id),
              eq(siteLoneWorkerSessions.companyId, companyId),
              eq(siteLoneWorkerSessions.projectId, projectId),
            ),
          )
          .limit(1)
      )[0],
      "Lone-worker session",
    );
    if (session.status === "completed" || session.status === "cancelled") {
      throw conflict(`This session is ${session.status}; a check-in cannot be added to it.`);
    }
    const at = body.at ?? nowISO();
    const lateSeconds = Math.round((Date.parse(at) - Date.parse(session.nextDueAt)) / 1000);
    await app.db.insert(siteLoneWorkerCheckins).values({
      id: newId("lwc"),
      companyId,
      projectId,
      sessionId: id,
      checkedInAt: at,
      dueAt: session.nextDueAt,
      lateSeconds,
      lat: body.lat ?? null,
      lon: body.lon ?? null,
      method: body.method,
      ok: body.ok ? 1 : 0,
      note: body.note ?? null,
      recordedBy: req.user!.id,
    });
    const [updated] = await app.db
      .update(siteLoneWorkerSessions)
      .set({
        status: "active",
        lastCheckInAt: at,
        nextDueAt: addMinutesISO(at, session.intervalMinutes),
        checkInCount: session.checkInCount + 1,
        lat: body.lat ?? session.lat,
        lon: body.lon ?? session.lon,
        updatedAt: nowISO(),
      })
      .where(and(eq(siteLoneWorkerSessions.id, id), eq(siteLoneWorkerSessions.companyId, companyId)))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "site_lone_worker_session",
      objectId: id,
      payload: { checkedInAt: at, lateSeconds, ok: body.ok, priorStatus: session.status },
    });
    return { session: updated, lateSeconds };
  });

  app.post(`${base}/lone-workers/:id/close`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const { status, notes } = z
      .object({ status: z.enum(["completed", "cancelled"]).default("completed"), notes: z.string().max(2000).optional() })
      .parse(req.body ?? {});
    const at = nowISO();
    const [row] = await app.db
      .update(siteLoneWorkerSessions)
      .set({ status, completedAt: at, completedBy: req.user!.id, notes: notes ?? null, updatedAt: at })
      .where(
        and(
          eq(siteLoneWorkerSessions.id, id),
          eq(siteLoneWorkerSessions.companyId, companyId),
          eq(siteLoneWorkerSessions.projectId, projectId),
          inArray(siteLoneWorkerSessions.status, ["active", "overdue", "escalated"]),
        ),
      )
      .returning();
    if (!row) throw notFound("Lone-worker session not found, or already closed");
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "site_lone_worker_session",
      objectId: id,
      payload: { to: status, notes: notes ?? null },
    });
    return row;
  });

  app.get(`${base}/lone-workers/:id/check-ins`, { preHandler: readGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const q = pageQuerySchema.parse(req.query);
    const where = and(
      eq(siteLoneWorkerCheckins.companyId, req.companyId!),
      eq(siteLoneWorkerCheckins.projectId, projectId),
      eq(siteLoneWorkerCheckins.sessionId, id),
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(siteLoneWorkerCheckins).where(where).orderBy(desc(siteLoneWorkerCheckins.checkedInAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(siteLoneWorkerCheckins).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  /* ---------------------------------------------------------------- */
  /* Manual sweep triggers (the scheduler runs the same code)          */
  /* ---------------------------------------------------------------- */

  app.post(`${base}/permits/sweep`, { preHandler: adminGate }, async (req) => {
    const companyId = req.companyId!;
    const now = new Date();
    const [expiry, entries, lone] = await Promise.all([
      sweepPermitExpiry(app.db, companyId, now),
      sweepPermitEntries(app.db, companyId, now),
      sweepLoneWorkers(app.db, companyId, now),
    ]);
    return { ranAt: now.toISOString(), permits: expiry, entries, loneWorkers: lone };
  });
};
