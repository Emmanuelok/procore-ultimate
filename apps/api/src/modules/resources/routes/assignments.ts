/**
 * THE CREW & PLANT CALENDAR (spec Vol I #688–690).
 *
 * A booking of one crew, one worker or one machine, on one activity or
 * location, between two dates. Three decisions shape this file:
 *
 *  1. A DOUBLE BOOKING IS DETECTED, NOT REFUSED. Both bookings are usually
 *     real; refusing the second loses the requirement it represents. The
 *     create response therefore SUCCEEDS and carries the conflicts it caused,
 *     so the caller sees them immediately.
 *
 *  2. STATUS MOVES THROUGH DEDICATED ROUTES. A generic PATCH may not set
 *     `status`: confirming a booking is a commitment somebody makes, and
 *     cancelling one requires a reason on the record.
 *
 *  3. SUBJECTS ARE NEVER RE-POINTED. Which resource a booking is for cannot
 *     be edited — cancel it and raise another. Silently moving a booking from
 *     one machine to another destroys the conflict history of both.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { resourceAssignments, resourceTypes, scheduleTasks } from "@constructos/db";
import { ACTIVE_ASSIGNMENT_STATUSES } from "@constructos/shared";
import { newId } from "../../../lib/ids.js";
import { nextRecordNumber } from "../../../lib/numbering.js";
import { badRequest, conflict } from "../../../lib/errors.js";
import { pageOffset, paginate } from "../../../lib/pagination.js";
import { addDays, isWorkday, round2, workingDaysBetween } from "../engines/calendar.js";
import {
  computeUtilisation,
  detectAssignmentConflicts,
  type AssignmentWindow,
} from "../engines/conflicts.js";
import {
  actorOf,
  companyOf,
  fetchAssignment,
  ledgerResources,
  nowIso,
  pad3,
  projectOf,
  requireScheduleTask,
  requireTypeForProject,
  resolveSubject,
  resourceGates,
  workPatternFor,
} from "../shared.js";
import * as S from "../schemas.js";

/** Longest booking accepted, so a typo cannot occupy a decade of calendar. */
const MAX_ASSIGNMENT_DAYS = 1095; // three years
/** Bookings scanned in one conflict pass. */
const MAX_CONFLICT_ROWS = 5000;

export const assignmentRoutes: FastifyPluginAsync = async (app) => {
  const gates = resourceGates(app);

  app.post(
    "/projects/:projectId/resource-assignments",
    { preHandler: gates.standard },
    async (req, reply) => {
      const body = S.assignmentCreateSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      if (body.toDate < body.fromDate) throw badRequest("toDate must not precede fromDate");
      const span = Math.round(
        (Date.parse(`${body.toDate}T00:00:00Z`) - Date.parse(`${body.fromDate}T00:00:00Z`)) /
          86_400_000,
      );
      if (span > MAX_ASSIGNMENT_DAYS) {
        throw badRequest(
          `A booking may not span more than ${MAX_ASSIGNMENT_DAYS} days. Split a long-term ` +
            "commitment into terms so it can be re-confirmed.",
        );
      }

      const subject = await resolveSubject(app.db, body, companyId, projectId);
      if (body.resourceTypeId) {
        await requireTypeForProject(app.db, body.resourceTypeId, companyId, projectId);
      }
      const task = body.scheduleTaskId
        ? await requireScheduleTask(app.db, body.scheduleTaskId, projectId)
        : null;

      const { pattern } = await workPatternFor(app.db, companyId, projectId);
      const workingDays = workingDaysBetween(body.fromDate, body.toDate, pattern);
      const allocationPercent = body.allocationPercent ?? 100;
      const plannedHours =
        body.hoursPerDay != null
          ? round2(body.hoursPerDay * workingDays * (allocationPercent / 100))
          : null;

      const number = await nextRecordNumber(app.db, projectId, "resource_assignment");
      const id = newId("ras");
      const reference = `RA-${pad3(number)}`;
      await app.db.insert(resourceAssignments).values({
        id,
        companyId,
        projectId,
        number,
        reference,
        resourceTypeId: body.resourceTypeId ?? null,
        subjectKind: subject.subjectKind,
        crewId: subject.subjectKind === "crew" ? subject.subjectId : null,
        workerId: subject.subjectKind === "worker" ? subject.subjectId : null,
        equipmentId: subject.subjectKind === "equipment" ? subject.subjectId : null,
        subjectLabel: subject.subjectLabel,
        scheduleTaskId: task?.id ?? null,
        scheduleId: task?.scheduleId ?? null,
        locationId: body.locationId ?? null,
        fromDate: body.fromDate,
        toDate: body.toDate,
        shift: body.shift ?? "day",
        hoursPerDay: body.hoursPerDay ?? null,
        allocationPercent,
        plannedHours,
        status: "planned",
        notes: body.notes ?? null,
        detail: body.detail ?? {},
        createdBy: actorOf(req),
      });
      await ledgerResources(app.db, req, "create", "resource_assignment", id, {
        reference,
        subjectKind: subject.subjectKind,
        subjectId: subject.subjectId,
        subjectLabel: subject.subjectLabel,
        fromDate: body.fromDate,
        toDate: body.toDate,
        allocationPercent,
        scheduleTaskId: task?.id ?? null,
      });

      /* Detected, never refused — see the file header. */
      const conflicts = await conflictsForSubject(
        companyId,
        projectId,
        subject.subjectKind,
        subject.subjectId,
      );
      const mine = conflicts.filter((c) => c.participants.some((p) => p.assignmentId === id));
      return reply.status(201).send({
        ...(await fetchAssignment(app.db, id, companyId, projectId)),
        workingDays,
        conflicts: mine,
        conflictWarning:
          mine.length > 0
            ? `${subject.subjectLabel} is now over-booked on ${mine.length} window(s). Both bookings ` +
              "have been kept: decide which gives way rather than deleting one quietly."
            : null,
      });
    },
  );

  app.get("/projects/:projectId/resource-assignments", { preHandler: gates.read }, async (req) => {
    const q = S.assignmentListQuery.parse(req.query);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const clauses = [
      eq(resourceAssignments.companyId, companyId),
      eq(resourceAssignments.projectId, projectId),
    ];
    if (q.status) clauses.push(eq(resourceAssignments.status, q.status));
    if (q.subjectKind) clauses.push(eq(resourceAssignments.subjectKind, q.subjectKind));
    if (q.crewId) clauses.push(eq(resourceAssignments.crewId, q.crewId));
    if (q.workerId) clauses.push(eq(resourceAssignments.workerId, q.workerId));
    if (q.equipmentId) clauses.push(eq(resourceAssignments.equipmentId, q.equipmentId));
    if (q.scheduleTaskId) clauses.push(eq(resourceAssignments.scheduleTaskId, q.scheduleTaskId));
    /* Overlap, not containment: a booking that straddles the window edge is
       part of that window's picture. */
    if (q.to) clauses.push(lte(resourceAssignments.fromDate, q.to));
    if (q.from) clauses.push(gte(resourceAssignments.toDate, q.from));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(resourceAssignments).where(where);
    const rows = await app.db
      .select({
        assignment: resourceAssignments,
        taskName: scheduleTasks.name,
        typeCode: resourceTypes.code,
        typeName: resourceTypes.name,
      })
      .from(resourceAssignments)
      .leftJoin(scheduleTasks, eq(scheduleTasks.id, resourceAssignments.scheduleTaskId))
      .leftJoin(resourceTypes, eq(resourceTypes.id, resourceAssignments.resourceTypeId))
      .where(where)
      .orderBy(asc(resourceAssignments.fromDate), asc(resourceAssignments.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      rows.map((r) => ({
        ...r.assignment,
        taskName: r.taskName,
        resourceTypeCode: r.typeCode,
        resourceTypeName: r.typeName,
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.get(
    "/projects/:projectId/resource-assignments/:assignmentId",
    { preHandler: gates.read },
    async (req) => {
      const { assignmentId } = req.params as { assignmentId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const assignment = await fetchAssignment(app.db, assignmentId, companyId, projectId);
      const conflicts = (
        await conflictsForSubject(
          companyId,
          projectId,
          assignment.subjectKind,
          subjectIdOf(assignment),
        )
      ).filter((c) => c.participants.some((p) => p.assignmentId === assignmentId));
      return { ...assignment, conflicts };
    },
  );

  app.patch(
    "/projects/:projectId/resource-assignments/:assignmentId",
    { preHandler: gates.standard },
    async (req) => {
      const { assignmentId } = req.params as { assignmentId: string };
      const body = S.assignmentPatchSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const assignment = await fetchAssignment(app.db, assignmentId, companyId, projectId);
      if (assignment.status === "cancelled" || assignment.status === "completed") {
        throw conflict(
          `${assignment.reference} is ${assignment.status} and is now a record of what happened. ` +
            "Raise a new booking rather than editing a closed one.",
        );
      }
      const fromDate = body.fromDate ?? assignment.fromDate;
      const toDate = body.toDate ?? assignment.toDate;
      if (toDate < fromDate) throw badRequest("toDate must not precede fromDate");
      if (body.resourceTypeId) {
        await requireTypeForProject(app.db, body.resourceTypeId, companyId, projectId);
      }
      let task: { id: string; scheduleId: string } | null = null;
      if (body.scheduleTaskId) task = await requireScheduleTask(app.db, body.scheduleTaskId, projectId);

      const { pattern } = await workPatternFor(app.db, companyId, projectId);
      const allocationPercent = body.allocationPercent ?? assignment.allocationPercent;
      const hoursPerDay =
        body.hoursPerDay !== undefined ? body.hoursPerDay : assignment.hoursPerDay;
      const workingDays = workingDaysBetween(fromDate, toDate, pattern);

      const set: Record<string, unknown> = {
        updatedAt: nowIso(),
        fromDate,
        toDate,
        allocationPercent,
        hoursPerDay,
        plannedHours:
          hoursPerDay != null
            ? round2(hoursPerDay * workingDays * (allocationPercent / 100))
            : null,
      };
      if (body.resourceTypeId !== undefined) set["resourceTypeId"] = body.resourceTypeId;
      if (body.scheduleTaskId !== undefined) {
        set["scheduleTaskId"] = body.scheduleTaskId;
        set["scheduleId"] = task?.scheduleId ?? null;
      }
      if (body.locationId !== undefined) set["locationId"] = body.locationId;
      if (body.shift !== undefined) set["shift"] = body.shift;
      if (body.notes !== undefined) set["notes"] = body.notes;
      if (body.detail !== undefined) {
        set["detail"] = { ...(assignment.detail ?? {}), ...body.detail };
      }

      await app.db
        .update(resourceAssignments)
        .set(set)
        .where(eq(resourceAssignments.id, assignmentId));
      await ledgerResources(app.db, req, "update", "resource_assignment", assignmentId, {
        reference: assignment.reference,
        changed: Object.keys(body),
        fromDate,
        toDate,
      });
      const updated = await fetchAssignment(app.db, assignmentId, companyId, projectId);
      const conflicts = (
        await conflictsForSubject(companyId, projectId, updated.subjectKind, subjectIdOf(updated))
      ).filter((c) => c.participants.some((p) => p.assignmentId === assignmentId));
      return { ...updated, conflicts };
    },
  );

  /**
   * Confirming is a commitment somebody makes, so it is a distinct act with a
   * distinct actor recorded — not a status field on a general edit.
   */
  app.post(
    "/projects/:projectId/resource-assignments/:assignmentId/confirm",
    { preHandler: gates.standard },
    async (req) => {
      const { assignmentId } = req.params as { assignmentId: string };
      S.assignmentTransitionSchema.parse(req.body ?? {});
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const assignment = await fetchAssignment(app.db, assignmentId, companyId, projectId);
      assertTransition(assignment.status, ["planned"], "confirm");
      const at = nowIso();
      await app.db
        .update(resourceAssignments)
        .set({ status: "confirmed", confirmedBy: actorOf(req), confirmedAt: at, updatedAt: at })
        .where(eq(resourceAssignments.id, assignmentId));
      await ledgerResources(app.db, req, "state_change", "resource_assignment", assignmentId, {
        reference: assignment.reference,
        from: assignment.status,
        to: "confirmed",
      });
      return fetchAssignment(app.db, assignmentId, companyId, projectId);
    },
  );

  app.post(
    "/projects/:projectId/resource-assignments/:assignmentId/start",
    { preHandler: gates.standard },
    async (req) => {
      const { assignmentId } = req.params as { assignmentId: string };
      S.assignmentTransitionSchema.parse(req.body ?? {});
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const assignment = await fetchAssignment(app.db, assignmentId, companyId, projectId);
      assertTransition(assignment.status, ["planned", "confirmed"], "start");
      await app.db
        .update(resourceAssignments)
        .set({ status: "in_progress", updatedAt: nowIso() })
        .where(eq(resourceAssignments.id, assignmentId));
      await ledgerResources(app.db, req, "state_change", "resource_assignment", assignmentId, {
        reference: assignment.reference,
        from: assignment.status,
        to: "in_progress",
      });
      return fetchAssignment(app.db, assignmentId, companyId, projectId);
    },
  );

  app.post(
    "/projects/:projectId/resource-assignments/:assignmentId/complete",
    { preHandler: gates.standard },
    async (req) => {
      const { assignmentId } = req.params as { assignmentId: string };
      S.assignmentTransitionSchema.parse(req.body ?? {});
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const assignment = await fetchAssignment(app.db, assignmentId, companyId, projectId);
      assertTransition(assignment.status, ["confirmed", "in_progress"], "complete");
      const at = nowIso();
      await app.db
        .update(resourceAssignments)
        .set({ status: "completed", completedAt: at, updatedAt: at })
        .where(eq(resourceAssignments.id, assignmentId));
      await ledgerResources(app.db, req, "state_change", "resource_assignment", assignmentId, {
        reference: assignment.reference,
        from: assignment.status,
        to: "completed",
      });
      return fetchAssignment(app.db, assignmentId, companyId, projectId);
    },
  );

  /** Cancelling requires a reason: "why was the crane released" is the
   *  question a delay analysis asks six months later. */
  app.post(
    "/projects/:projectId/resource-assignments/:assignmentId/cancel",
    { preHandler: gates.standard },
    async (req) => {
      const { assignmentId } = req.params as { assignmentId: string };
      const body = S.assignmentCancelSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const assignment = await fetchAssignment(app.db, assignmentId, companyId, projectId);
      assertTransition(assignment.status, ["planned", "confirmed", "in_progress"], "cancel");
      await app.db
        .update(resourceAssignments)
        .set({ status: "cancelled", cancelledReason: body.reason, updatedAt: nowIso() })
        .where(eq(resourceAssignments.id, assignmentId));
      await ledgerResources(app.db, req, "state_change", "resource_assignment", assignmentId, {
        reference: assignment.reference,
        from: assignment.status,
        to: "cancelled",
        reason: body.reason,
      });
      return fetchAssignment(app.db, assignmentId, companyId, projectId);
    },
  );

  /* ================================================================== */
  /* Calendar, conflicts and utilisation                                 */
  /* ================================================================== */

  /**
   * The calendar view: one lane per resource, its bookings inside the window,
   * and the working days of the window so a client can lay out a grid without
   * re-deriving the project's calendar.
   */
  app.get("/projects/:projectId/resources/calendar", { preHandler: gates.read }, async (req) => {
    const q = S.calendarQuery.parse(req.query);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    if (q.to < q.from) throw badRequest("`to` must not precede `from`");
    const span = Math.round(
      (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000,
    );
    if (span > 366) {
      throw badRequest("The calendar window is limited to a year at a time.");
    }

    const rows = await loadWindow(companyId, projectId, q.from, q.to, q.subjectKind);
    const { pattern, source: calendarSource, isDefault } = await workPatternFor(
      app.db,
      companyId,
      projectId,
    );
    const days: Array<{ date: string; working: boolean }> = [];
    for (let i = 0; i <= span; i += 1) {
      const date = addDays(q.from, i);
      days.push({ date, working: isWorkday(date, pattern) });
    }

    const lanes = new Map<
      string,
      {
        subjectKind: string;
        subjectId: string;
        subjectLabel: string;
        bookings: Array<Record<string, unknown>>;
      }
    >();
    for (const row of rows) {
      const key = `${row.assignment.subjectKind}|${subjectIdOf(row.assignment)}`;
      const lane =
        lanes.get(key) ?? {
          subjectKind: row.assignment.subjectKind,
          subjectId: subjectIdOf(row.assignment),
          subjectLabel: row.assignment.subjectLabel,
          bookings: [],
        };
      lane.bookings.push({
        id: row.assignment.id,
        reference: row.assignment.reference,
        fromDate: row.assignment.fromDate,
        toDate: row.assignment.toDate,
        status: row.assignment.status,
        allocationPercent: row.assignment.allocationPercent,
        hoursPerDay: row.assignment.hoursPerDay,
        plannedHours: row.assignment.plannedHours,
        shift: row.assignment.shift,
        scheduleTaskId: row.assignment.scheduleTaskId,
        taskName: row.taskName,
        locationId: row.assignment.locationId,
        notes: row.assignment.notes,
      });
      lanes.set(key, lane);
    }

    const conflicts = detectAssignmentConflicts(rows.map(toWindow));
    return {
      window: { from: q.from, to: q.to },
      days,
      calendar: { source: calendarSource, isDefault },
      lanes: [...lanes.values()].sort((a, b) => a.subjectLabel.localeCompare(b.subjectLabel)),
      conflicts,
      reasons:
        rows.length === 0
          ? [
              "No bookings fall in this window. The calendar shows resource_assignments — crews, " +
                "workers and plant booked to activities — not timecards.",
            ]
          : [],
    };
  });

  app.get("/projects/:projectId/resources/conflicts", { preHandler: gates.read }, async (req) => {
    const q = S.assignmentListQuery.pick({ from: true, to: true, subjectKind: true }).parse(req.query);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const rows = await loadWindow(companyId, projectId, q.from, q.to, q.subjectKind);
    const conflicts = detectAssignmentConflicts(rows.map(toWindow));
    return {
      window: { from: q.from ?? null, to: q.to ?? null },
      total: conflicts.length,
      items: conflicts,
      scanned: rows.length,
      truncated: rows.length >= MAX_CONFLICT_ROWS,
      reasons:
        rows.length >= MAX_CONFLICT_ROWS
          ? [
              `Only the first ${MAX_CONFLICT_ROWS} bookings were scanned. Narrow the window to be ` +
                "sure every clash in a longer period is seen.",
            ]
          : [],
    };
  });

  app.get("/projects/:projectId/resources/utilisation", { preHandler: gates.read }, async (req) => {
    const q = S.utilisationQuery.parse(req.query);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    if (q.to < q.from) throw badRequest("`to` must not precede `from`");
    const rows = await loadWindow(companyId, projectId, q.from, q.to, q.subjectKind);
    const { pattern, source: calendarSource, isDefault } = await workPatternFor(
      app.db,
      companyId,
      projectId,
    );
    const utilisation = computeUtilisation(rows.map(toWindow), { from: q.from, to: q.to }, (iso) =>
      isWorkday(iso, pattern),
    );
    const measured = utilisation.filter((u) => u.utilisationPercent !== null);
    return {
      window: { from: q.from, to: q.to },
      calendar: { source: calendarSource, isDefault },
      items: utilisation,
      total: utilisation.length,
      averageUtilisationPercent:
        measured.length > 0
          ? round2(
              measured.reduce((s, u) => s + (u.utilisationPercent ?? 0), 0) / measured.length,
            )
          : null,
      reasons:
        utilisation.length === 0
          ? [
              "No resource is booked in this window, so utilisation is not computable. It is " +
                "derived from bookings, not from timecards.",
            ]
          : [],
    };
  });

  /* ================================================================== */
  /* Helpers                                                             */
  /* ================================================================== */

  function assertTransition(current: string, allowedFrom: string[], action: string): void {
    if (!allowedFrom.includes(current)) {
      throw conflict(
        `Cannot ${action} an assignment that is "${current}" — only ${allowedFrom
          .map((s) => `"${s}"`)
          .join(", ")}.`,
      );
    }
  }

  const subjectIdOf = (a: typeof resourceAssignments.$inferSelect): string =>
    a.crewId ?? a.workerId ?? a.equipmentId ?? a.id;

  const toWindow = (row: {
    assignment: typeof resourceAssignments.$inferSelect;
    taskName: string | null;
  }): AssignmentWindow => ({
    id: row.assignment.id,
    reference: row.assignment.reference,
    subjectKind: row.assignment.subjectKind,
    subjectId: subjectIdOf(row.assignment),
    subjectLabel: row.assignment.subjectLabel,
    fromDate: row.assignment.fromDate,
    toDate: row.assignment.toDate,
    status: row.assignment.status,
    allocationPercent: row.assignment.allocationPercent,
    hoursPerDay: row.assignment.hoursPerDay,
    scheduleTaskId: row.assignment.scheduleTaskId,
    taskName: row.taskName,
  });

  async function loadWindow(
    companyId: string,
    projectId: string,
    from?: string,
    to?: string,
    subjectKind?: string,
  ) {
    const clauses = [
      eq(resourceAssignments.companyId, companyId),
      eq(resourceAssignments.projectId, projectId),
      ne(resourceAssignments.status, "cancelled"),
    ];
    if (to) clauses.push(lte(resourceAssignments.fromDate, to));
    if (from) clauses.push(gte(resourceAssignments.toDate, from));
    if (subjectKind) clauses.push(eq(resourceAssignments.subjectKind, subjectKind));
    return app.db
      .select({ assignment: resourceAssignments, taskName: scheduleTasks.name })
      .from(resourceAssignments)
      .leftJoin(scheduleTasks, eq(scheduleTasks.id, resourceAssignments.scheduleTaskId))
      .where(and(...clauses))
      .orderBy(asc(resourceAssignments.fromDate))
      .limit(MAX_CONFLICT_ROWS);
  }

  async function conflictsForSubject(
    companyId: string,
    projectId: string,
    subjectKind: string,
    subjectId: string,
  ) {
    const column =
      subjectKind === "crew"
        ? resourceAssignments.crewId
        : subjectKind === "worker"
          ? resourceAssignments.workerId
          : resourceAssignments.equipmentId;
    const rows = await app.db
      .select({ assignment: resourceAssignments, taskName: scheduleTasks.name })
      .from(resourceAssignments)
      .leftJoin(scheduleTasks, eq(scheduleTasks.id, resourceAssignments.scheduleTaskId))
      .where(
        and(
          eq(resourceAssignments.companyId, companyId),
          eq(resourceAssignments.projectId, projectId),
          eq(column, subjectId),
          inArray(resourceAssignments.status, [...ACTIVE_ASSIGNMENT_STATUSES]),
        ),
      )
      .limit(MAX_CONFLICT_ROWS);
    return detectAssignmentConflicts(rows.map(toWindow));
  }
};
