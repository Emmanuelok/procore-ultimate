/**
 * Observations — spec Vol I §4.2 #634–#646: the first-class field finding.
 *
 * Covers: typed observations (#634–#636) with priority, assignment and
 * distribution (#637–#638), a drawing pin (#640), photo/file attachments
 * (#641), a two-hands lifecycle borrowed from the punch list (#642–#643:
 * the verifier is never the assignee), conversion into a punch item, a
 * safety incident or a change event (#644) with a record link back, and
 * register analytics (#645–#646).
 *
 * Gate: observations live under the `punch` tool — they are the finding a
 * punch item is made from, and the same people work both registers.
 *
 * Deliberately NOT here: inspection-template scoring that produces
 * observations (modules/safety) and drawing markup rendering (drawings).
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, count, desc, eq, ilike, inArray, isNotNull, lt, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  changeEvents,
  fieldObservations,
  punchItems,
  recordLinks,
  safetyIncidents,
} from "@constructos/db";
import {
  CHANGE_EVENT_TYPES,
  FIELD_PRIORITIES,
  INCIDENT_SEVERITIES,
  INCIDENT_TYPES,
  OBSERVATION_CONVERSION_TARGETS,
  OBSERVATION_STATUSES,
  OBSERVATION_TYPES,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { AppError, badRequest, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { pushNotifications } from "../notifications/service.js";
import { isoDateSchema, todayISO } from "./dates.js";
import {
  assertCompanyUsers,
  assertProjectLocation,
  assertVendor,
  hasToolAdmin,
  isCompanyAdmin,
} from "./access.js";
import { ageInDays, bucketise, daysOverdue } from "./ageingEngine.js";
import { authorisePunchTransition, validateVerifierChange } from "./punchEngine.js";
import { loadFieldSettings } from "./settings.js";
import { actorOf, nowIso, pad3, pad4, pick } from "./shared.js";

const pinSchema = z
  .object({
    sheetId: z.string().min(1).max(60),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  })
  .nullable();

const createSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(10000).nullable().optional(),
  observationType: z.enum(OBSERVATION_TYPES).optional(),
  priority: z.enum(FIELD_PRIORITIES).optional(),
  assigneeId: z.string().nullable().optional(),
  verifierId: z.string().nullable().optional(),
  vendorId: z.string().nullable().optional(),
  distribution: z.array(z.string().min(1)).max(50).optional(),
  dueDate: isoDateSchema.nullable().optional(),
  locationId: z.string().nullable().optional(),
  pin: pinSchema.optional(),
  photoIds: z.array(z.string().min(1)).max(50).optional(),
  fileIds: z.array(z.string().min(1)).max(50).optional(),
});

const patchSchema = createSchema.partial();

const listQuery = pageQuerySchema.extend({
  status: z.enum(OBSERVATION_STATUSES).optional(),
  type: z.enum(OBSERVATION_TYPES).optional(),
  assigneeId: z.string().optional(),
  priority: z.enum(FIELD_PRIORITIES).optional(),
  overdue: z.enum(["true", "false"]).optional(),
  open: z.enum(["true", "false"]).optional(),
  search: z.string().max(200).optional(),
});

const statusSchema = z.object({ status: z.enum(OBSERVATION_STATUSES) });

const convertSchema = z.object({
  target: z.enum(OBSERVATION_CONVERSION_TARGETS),
  /** incident only */
  incidentType: z.enum(INCIDENT_TYPES).optional(),
  severity: z.enum(INCIDENT_SEVERITIES).optional(),
  occurredAt: z.string().max(40).optional(),
  /** change event only */
  eventType: z.enum(CHANGE_EVENT_TYPES).optional(),
  /** punch only */
  dueDate: isoDateSchema.nullable().optional(),
  /** close the observation once converted (default true) */
  closeObservation: z.boolean().optional(),
});

const OPEN_STATUSES = ["open", "in_progress", "ready_for_review"] as const;

export const observationRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("punch", "read")];
  const standardGate = [app.authenticate, app.requireCompany, app.requireTool("punch", "standard")];

  const label = (n: number) => `OBS-${pad3(n)}`;

  async function fetchObservation(id: string, req: FastifyRequest) {
    const rows = await app.db
      .select()
      .from(fieldObservations)
      .where(
        and(
          eq(fieldObservations.id, id),
          eq(fieldObservations.companyId, req.companyId!),
          eq(fieldObservations.projectId, req.projectId!),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Observation not found");
    return rows[0];
  }

  async function isAdmin(req: FastifyRequest): Promise<boolean> {
    return isCompanyAdmin(req.companyRole) || hasToolAdmin(app, actorOf(req), req.projectId!, "punch");
  }

  async function ledger(
    action: "create" | "update" | "state_change",
    id: string,
    req: FastifyRequest,
    payload: unknown,
    storePayload = false,
  ) {
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action,
      objectType: "observation",
      objectId: id,
      payload,
      storePayload,
      projectId: req.projectId!,
    });
  }

  async function validateRefs(
    req: FastifyRequest,
    body: {
      assigneeId?: string | null;
      verifierId?: string | null;
      distribution?: string[];
      vendorId?: string | null;
      locationId?: string | null;
    },
  ) {
    await assertCompanyUsers(app.db, req.companyId!, [body.assigneeId, body.verifierId, ...(body.distribution ?? [])]);
    await assertVendor(app.db, req.companyId!, body.vendorId);
    await assertProjectLocation(app.db, req.companyId!, req.projectId!, body.locationId);
  }

  function decorate(row: typeof fieldObservations.$inferSelect, today: string) {
    const open = (OPEN_STATUSES as readonly string[]).includes(row.status);
    return {
      ...row,
      label: label(row.number),
      isOpen: open,
      daysOverdue: open ? daysOverdue(row.dueDate, today) : 0,
      ageDays: open ? ageInDays(row.createdAt, today) : null,
    };
  }

  function notifyAssignment(req: FastifyRequest, row: { id: string; number: number; title: string }, userIds: string[]) {
    return pushNotifications(
      app.db,
      userIds.map((userId) => ({
        companyId: req.companyId!,
        userId,
        projectId: req.projectId!,
        kind: "assignment" as const,
        title: `${label(row.number)} assigned to you: ${row.title}`,
        recordType: "observation",
        recordId: row.id,
      })),
    );
  }

  /* ---------------------------------------------------------------- */
  /* Create / list / analytics                                         */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/observations", { preHandler: standardGate }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    await validateRefs(req, body);
    if (body.assigneeId && body.verifierId && body.assigneeId === body.verifierId) {
      throw badRequest("The verifier must be a different person from the assignee");
    }
    const number = await nextRecordNumber(app.db, req.projectId!, "observation");
    const id = newId("obs");
    await app.db.insert(fieldObservations).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      number,
      title: body.title,
      description: body.description ?? null,
      observationType: body.observationType ?? "other",
      status: "open",
      priority: body.priority ?? "medium",
      assigneeId: body.assigneeId ?? null,
      verifierId: body.verifierId ?? null,
      vendorId: body.vendorId ?? null,
      distribution: body.distribution ?? [],
      dueDate: body.dueDate ?? null,
      locationId: body.locationId ?? null,
      sheetId: body.pin?.sheetId ?? null,
      pinX: body.pin?.x ?? null,
      pinY: body.pin?.y ?? null,
      photoIds: body.photoIds ?? [],
      fileIds: body.fileIds ?? [],
      createdBy: req.user!.id,
    });
    await ledger("create", id, req, { number, title: body.title, observationType: body.observationType ?? "other" });
    const notify = new Set<string>(body.distribution ?? []);
    if (body.assigneeId) notify.add(body.assigneeId);
    notify.delete(req.user!.id);
    await notifyAssignment(req, { id, number, title: body.title }, [...notify]);
    return reply.status(201).send(decorate(await fetchObservation(id, req), todayISO()));
  });

  app.get("/projects/:projectId/observations", { preHandler: readGate }, async (req) => {
    const q = listQuery.parse(req.query);
    const today = todayISO();
    const clauses: SQL[] = [
      eq(fieldObservations.companyId, req.companyId!),
      eq(fieldObservations.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(fieldObservations.status, q.status));
    if (q.type) clauses.push(eq(fieldObservations.observationType, q.type));
    if (q.assigneeId) clauses.push(eq(fieldObservations.assigneeId, q.assigneeId));
    if (q.priority) clauses.push(eq(fieldObservations.priority, q.priority));
    if (q.search) clauses.push(ilike(fieldObservations.title, `%${q.search}%`));
    if (q.open === "true") clauses.push(inArray(fieldObservations.status, [...OPEN_STATUSES]));
    if (q.overdue === "true") {
      clauses.push(inArray(fieldObservations.status, [...OPEN_STATUSES]), isNotNull(fieldObservations.dueDate), lt(fieldObservations.dueDate, today));
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(fieldObservations).where(where);
    const items = await app.db
      .select()
      .from(fieldObservations)
      .where(where)
      .orderBy(desc(fieldObservations.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items.map((r) => decorate(r, today)), Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/observations/analytics", { preHandler: readGate }, async (req) => {
    const today = todayISO();
    const rows = await app.db
      .select({
        id: fieldObservations.id,
        status: fieldObservations.status,
        observationType: fieldObservations.observationType,
        priority: fieldObservations.priority,
        assigneeId: fieldObservations.assigneeId,
        dueDate: fieldObservations.dueDate,
        createdAt: fieldObservations.createdAt,
        closedAt: fieldObservations.closedAt,
        convertedToType: fieldObservations.convertedToType,
      })
      .from(fieldObservations)
      .where(and(eq(fieldObservations.companyId, req.companyId!), eq(fieldObservations.projectId, req.projectId!)))
      .limit(5000);
    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    const converted: Record<string, number> = {};
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      byType[r.observationType] = (byType[r.observationType] ?? 0) + 1;
      if (r.convertedToType) converted[r.convertedToType] = (converted[r.convertedToType] ?? 0) + 1;
    }
    const open = rows.filter((r) => (OPEN_STATUSES as readonly string[]).includes(r.status));
    const closedDurations = rows
      .filter((r) => r.status === "closed" && r.closedAt)
      .map((r) => Math.max(0, (Date.parse(r.closedAt!) - Date.parse(r.createdAt)) / 86_400_000));
    return {
      asOf: today,
      total: rows.length,
      open: open.length,
      overdue: open.filter((r) => daysOverdue(r.dueDate, today) > 0).length,
      byStatus,
      byType,
      converted,
      avgDaysToClose:
        closedDurations.length > 0
          ? Math.round((closedDurations.reduce((a, b) => a + b, 0) / closedDurations.length) * 10) / 10
          : null,
      ageing: bucketise(open, (r) => ageInDays(r.createdAt, today), (r) => r.assigneeId ?? "unassigned"),
      basis:
        rows.length > 0
          ? "Open = open/in_progress/ready_for_review; overdue = due date before today; days-to-close from created to closed"
          : "No observations recorded yet",
    };
  });

  /* ---------------------------------------------------------------- */
  /* Detail / edit / lifecycle                                         */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/observations/:observationId", { preHandler: readGate }, async (req) => {
    const { observationId } = req.params as { observationId: string };
    const row = await fetchObservation(observationId, req);
    const links = await app.db
      .select()
      .from(recordLinks)
      .where(and(eq(recordLinks.fromType, "observation"), eq(recordLinks.fromId, row.id)));
    const me = req.user!.id;
    const admin = await isAdmin(req);
    const settings = await loadFieldSettings(app.db, req.companyId!, req.projectId!);
    const item = {
      status: row.status,
      assigneeId: row.assigneeId,
      verifierId: row.verifierId,
      createdBy: row.createdBy,
      readyForReviewBy: row.readyForReviewBy,
      afterPhotoIds: row.photoIds,
    };
    const can = (to: string) =>
      authorisePunchTransition({ item, actorId: me, isAdmin: admin, to, settings: { requireVerifier: settings.punch.requireVerifier } }).ok;
    return {
      ...decorate(row, todayISO()),
      links,
      permissions: {
        isAdmin: admin,
        canStart: can("in_progress"),
        canReadyForReview: can("ready_for_review"),
        canClose: can("closed"),
        canVoid: can("void"),
        canConvert: !row.convertedToType && row.status !== "void",
        canEditVerifier: admin || row.status !== "ready_for_review",
      },
    };
  });

  app.patch("/projects/:projectId/observations/:observationId", { preHandler: standardGate }, async (req) => {
    const { observationId } = req.params as { observationId: string };
    const body = patchSchema.parse(req.body);
    const row = await fetchObservation(observationId, req);
    if (row.status === "closed" || row.status === "void") {
      throw badRequest(`A ${row.status} observation cannot be edited`);
    }
    await validateRefs(req, body);
    const admin = await isAdmin(req);
    const verdict = validateVerifierChange({
      item: row,
      nextVerifierId: body.verifierId,
      nextAssigneeId: body.assigneeId,
      actorId: req.user!.id,
      isAdmin: admin,
    });
    if (!verdict.ok) throw new AppError(verdict.status, verdict.reason);
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      if (k === "pin") {
        set["sheetId"] = body.pin?.sheetId ?? null;
        set["pinX"] = body.pin?.x ?? null;
        set["pinY"] = body.pin?.y ?? null;
      } else set[k] = v;
    }
    const changed = Object.keys(body).filter((k) => body[k as keyof typeof body] !== undefined);
    await app.db.update(fieldObservations).set(set).where(eq(fieldObservations.id, observationId));
    await ledger("update", observationId, req, { changed, before: pick(row, changed), after: pick(set, changed) }, true);
    if (body.assigneeId && body.assigneeId !== row.assigneeId) {
      await notifyAssignment(req, row, [body.assigneeId]);
    }
    return decorate(await fetchObservation(observationId, req), todayISO());
  });

  app.post("/projects/:projectId/observations/:observationId/status", { preHandler: standardGate }, async (req) => {
    const { observationId } = req.params as { observationId: string };
    const body = statusSchema.parse(req.body);
    const row = await fetchObservation(observationId, req);
    const me = req.user!.id;
    const admin = await isAdmin(req);
    const settings = await loadFieldSettings(app.db, req.companyId!, req.projectId!);
    const verdict = authorisePunchTransition({
      item: {
        status: row.status,
        assigneeId: row.assigneeId,
        verifierId: row.verifierId,
        createdBy: row.createdBy,
        readyForReviewBy: row.readyForReviewBy,
        afterPhotoIds: row.photoIds,
      },
      actorId: me,
      isAdmin: admin,
      to: body.status,
      settings: { requireVerifier: settings.punch.requireVerifier, requireAfterPhoto: false },
    });
    if (!verdict.ok) throw new AppError(verdict.status, verdict.reason);
    const now = nowIso();
    const set: Record<string, unknown> = { status: body.status, updatedAt: now };
    if (body.status === "ready_for_review") set["readyForReviewBy"] = me;
    if (body.status === "closed") {
      set["closedBy"] = me;
      set["closedAt"] = now;
    }
    await app.db.update(fieldObservations).set(set).where(eq(fieldObservations.id, observationId));
    await ledger("state_change", observationId, req, { from: row.status, to: body.status });
    const targets: string[] = [];
    if (body.status === "ready_for_review" && row.verifierId) targets.push(row.verifierId);
    if (body.status === "closed" || body.status === "in_progress") {
      if (row.createdBy !== me) targets.push(row.createdBy);
      if (row.assigneeId && row.assigneeId !== me) targets.push(row.assigneeId);
    }
    await pushNotifications(
      app.db,
      targets.map((userId) => ({
        companyId: req.companyId!,
        userId,
        projectId: req.projectId!,
        kind: "status_change" as const,
        title: `${label(row.number)} is now ${body.status.replace(/_/g, " ")}: ${row.title}`,
        recordType: "observation",
        recordId: row.id,
      })),
    );
    return decorate(await fetchObservation(observationId, req), todayISO());
  });

  /* ---------------------------------------------------------------- */
  /* Conversion (#644)                                                 */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/observations/:observationId/convert", { preHandler: standardGate }, async (req, reply) => {
    const { observationId } = req.params as { observationId: string };
    const body = convertSchema.parse(req.body);
    const row = await fetchObservation(observationId, req);
    if (row.status === "void") throw badRequest("A void observation cannot be converted");
    if (row.convertedToType) {
      throw badRequest(`Already converted to ${row.convertedToType} ${row.convertedToId ?? ""}`.trim());
    }
    const me = req.user!.id;
    const now = nowIso();
    let targetId = "";
    let targetLabel = "";
    let targetObjectType = "";

    if (body.target === "punch_item") {
      const number = await nextRecordNumber(app.db, req.projectId!, "punch");
      targetId = newId("pun");
      targetLabel = `Punch #${pad3(number)}`;
      targetObjectType = "punch_item";
      await app.db.insert(punchItems).values({
        id: targetId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        title: row.title,
        description: row.description,
        status: "open",
        itemType: row.observationType,
        assigneeId: row.assigneeId,
        verifierId: row.verifierId,
        vendorId: row.vendorId,
        locationId: row.locationId,
        dueDate: body.dueDate !== undefined ? body.dueDate : row.dueDate,
        priority: row.priority,
        beforePhotoIds: row.photoIds,
        afterPhotoIds: [],
        distribution: row.distribution,
        observationId: row.id,
        createdBy: me,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: me,
        action: "create",
        objectType: "punch_item",
        objectId: targetId,
        payload: { number, title: row.title, fromObservation: row.id },
        projectId: req.projectId!,
      });
      if (row.assigneeId && row.assigneeId !== me) {
        await pushNotifications(app.db, [
          {
            companyId: req.companyId!,
            userId: row.assigneeId,
            projectId: req.projectId!,
            kind: "assignment",
            title: `${targetLabel} assigned to you: ${row.title}`,
            recordType: "punch_item",
            recordId: targetId,
          },
        ]);
      }
    } else if (body.target === "incident") {
      const seq = await nextRecordNumber(app.db, req.projectId!, "safety_incident");
      targetId = newId("inc");
      targetLabel = `INC-${pad4(seq)}`;
      targetObjectType = "safety_incident";
      const occurredAt = body.occurredAt ?? row.createdAt;
      if (Number.isNaN(Date.parse(occurredAt))) throw badRequest("occurredAt must be an ISO timestamp");
      await app.db.insert(safetyIncidents).values({
        id: targetId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number: seq,
        reference: targetLabel,
        incidentType: body.incidentType ?? "near_miss",
        severity: body.severity ?? "minor",
        title: row.title,
        description: row.description ?? row.title,
        occurredAt: new Date(occurredAt).toISOString(),
        reportedAt: now,
        locationId: row.locationId,
        vendorId: row.vendorId,
        createdBy: me,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: me,
        action: "create",
        objectType: "safety_incident",
        objectId: targetId,
        payload: { reference: targetLabel, title: row.title, fromObservation: row.id },
        projectId: req.projectId!,
      });
    } else {
      const number = await nextRecordNumber(app.db, req.projectId!, "change_event");
      targetId = newId("ce");
      targetLabel = `CE-${pad3(number)}`;
      targetObjectType = "change_event";
      await app.db.insert(changeEvents).values({
        id: targetId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        reference: targetLabel,
        title: row.title,
        description: row.description,
        status: "open",
        eventType: body.eventType ?? "field_condition",
        originType: "observation",
        originId: row.id,
        locationId: row.locationId,
        identifiedDate: todayISO(),
        createdBy: me,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: me,
        action: "create",
        objectType: "change_event",
        objectId: targetId,
        payload: { reference: targetLabel, title: row.title, fromObservation: row.id },
        projectId: req.projectId!,
      });
    }

    await app.db.insert(recordLinks).values({
      id: newId("lnk"),
      companyId: req.companyId!,
      projectId: req.projectId!,
      fromType: "observation",
      fromId: row.id,
      toType: targetObjectType,
      toId: targetId,
      linkKind: "converted_to",
      createdBy: me,
    });
    const close = body.closeObservation !== false && row.status !== "closed";
    await app.db
      .update(fieldObservations)
      .set({
        convertedToType: body.target,
        convertedToId: targetId,
        convertedAt: now,
        ...(close ? { status: "closed", closedBy: me, closedAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(fieldObservations.id, row.id));
    await ledger("state_change", row.id, req, {
      from: row.status,
      to: close ? "closed" : row.status,
      convertedTo: { type: body.target, id: targetId, label: targetLabel },
    });
    return reply.status(201).send({
      observation: decorate(await fetchObservation(row.id, req), todayISO()),
      target: { type: body.target, id: targetId, label: targetLabel },
    });
  });
};
