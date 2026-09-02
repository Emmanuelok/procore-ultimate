/**
 * DEMAND PLANS, SUPPLY AND THE HISTOGRAM (spec Vol I #676–687).
 *
 * A plan is versioned rather than edited, and exactly one `current` plan is
 * `active` at a time — activating a new one supersedes the old one in the
 * same transaction so there is never a moment with two live plans or none.
 *
 * Derivation from the schedule is the point of the module: change the
 * programme, re-derive, and the histogram moves. Manual rows are never
 * destroyed by a re-derive; only rows the previous derivation wrote are
 * replaced, because a planner's hand-entered allowance for a trade the
 * programme does not model must survive the next import.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  resourceAvailability,
  resourceDemands,
  resourcePlans,
  resourceTypes,
  scheduleTaskResources,
  scheduleTasks,
} from "@constructos/db";
import { newId } from "../../../lib/ids.js";
import { nextRecordNumber } from "../../../lib/numbering.js";
import { badRequest, conflict, notFound } from "../../../lib/errors.js";
import { pageOffset, paginate } from "../../../lib/pagination.js";
import {
  addDays,
  enumerateWeeks,
  round2,
  weekStartOf,
  workingDaysInWeek,
} from "../engines/calendar.js";
import {
  collapseByTypeWeek,
  deriveDemand,
  headcountFor,
  type DemandTask,
  type DemandTaskResource,
} from "../engines/demand.js";
import {
  buildHistogram,
  suggestLevelling,
  type HistogramSupplyRow,
  type HistogramType,
  type LevellingTask,
} from "../engines/histogram.js";
import {
  actorOf,
  companyOf,
  fetchPlan,
  ledgerResources,
  nowIso,
  pad3,
  projectOf,
  requireScheduleTask,
  requireTypeForProject,
  resolveSchedule,
  resourceGates,
  standardWorkingDaysPerWeek,
  todayIso,
  typesForProject,
  workPatternFor,
} from "../shared.js";
import * as S from "../schemas.js";

/** A derive pass over more activities than this is refused rather than
 *  loading an unbounded programme into memory. */
const MAX_DERIVE_TASKS = 20_000;
/** Widest window a histogram will draw, so one query cannot allocate forever. */
const MAX_HISTOGRAM_WEEKS = 260;

export const planRoutes: FastifyPluginAsync = async (app) => {
  const gates = resourceGates(app);

  /* ================================================================== */
  /* Plans                                                               */
  /* ================================================================== */

  app.post("/projects/:projectId/resource-plans", { preHandler: gates.standard }, async (req, reply) => {
    const body = S.planCreateSchema.parse(req.body);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    if (body.periodStart && body.periodEnd && body.periodEnd < body.periodStart) {
      throw badRequest("periodEnd must not precede periodStart");
    }
    const schedule = body.scheduleId
      ? await resolveSchedule(app.db, projectId, body.scheduleId)
      : null;
    if (body.supersedesPlanId) await fetchPlan(app.db, body.supersedesPlanId, companyId, projectId);

    const number = await nextRecordNumber(app.db, projectId, "resource_plan");
    const id = newId("rpl");
    const reference = `RP-${pad3(number)}`;
    await app.db.insert(resourcePlans).values({
      id,
      companyId,
      projectId,
      number,
      reference,
      name: body.name,
      description: body.description ?? null,
      planKind: body.planKind ?? "current",
      status: "draft",
      scheduleId: schedule?.id ?? null,
      periodStart: body.periodStart ?? null,
      periodEnd: body.periodEnd ?? null,
      weekStartsOn: body.weekStartsOn ?? 1,
      source: "manual",
      version: 1,
      supersedesPlanId: body.supersedesPlanId ?? null,
      detail: body.detail ?? {},
      createdBy: actorOf(req),
    });
    await ledgerResources(app.db, req, "create", "resource_plan", id, {
      reference,
      name: body.name,
      planKind: body.planKind ?? "current",
    });
    return reply.status(201).send(await planView(id, companyId, projectId));
  });

  app.get("/projects/:projectId/resource-plans", { preHandler: gates.read }, async (req) => {
    const q = S.planListQuery.parse(req.query);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const clauses = [eq(resourcePlans.companyId, companyId), eq(resourcePlans.projectId, projectId)];
    if (q.status) clauses.push(eq(resourcePlans.status, q.status));
    if (q.planKind) clauses.push(eq(resourcePlans.planKind, q.planKind));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(resourcePlans).where(where);
    const rows = await app.db
      .select()
      .from(resourcePlans)
      .where(where)
      .orderBy(asc(resourcePlans.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/resource-plans/:planId", { preHandler: gates.read }, async (req) => {
    const { planId } = req.params as { planId: string };
    return planView(planId, companyOf(req), projectOf(req));
  });

  app.patch(
    "/projects/:projectId/resource-plans/:planId",
    { preHandler: gates.standard },
    async (req) => {
      const { planId } = req.params as { planId: string };
      const body = S.planPatchSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const plan = await fetchPlan(app.db, planId, companyId, projectId);
      assertMutable(plan.status, "edit");
      if (body.scheduleId) await resolveSchedule(app.db, projectId, body.scheduleId);
      const set: Record<string, unknown> = { updatedAt: nowIso() };
      const direct = [
        "name",
        "description",
        "planKind",
        "scheduleId",
        "periodStart",
        "periodEnd",
        "weekStartsOn",
      ] as const;
      for (const key of direct) if (body[key] !== undefined) set[key] = body[key];
      if (body.detail !== undefined) set["detail"] = { ...(plan.detail ?? {}), ...body.detail };
      await app.db.update(resourcePlans).set(set).where(eq(resourcePlans.id, planId));
      await ledgerResources(app.db, req, "update", "resource_plan", planId, {
        reference: plan.reference,
        changed: Object.keys(body),
      });
      return planView(planId, companyId, projectId);
    },
  );

  /**
   * Activate a plan. One `current` plan is live at a time: any other active
   * plan of the same kind is superseded inside the same transaction, so a
   * reader never sees two live plans and never sees none.
   */
  app.post(
    "/projects/:projectId/resource-plans/:planId/activate",
    { preHandler: gates.admin },
    async (req) => {
      const { planId } = req.params as { planId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const actorId = actorOf(req);
      const plan = await fetchPlan(app.db, planId, companyId, projectId);
      if (plan.status === "active") throw conflict(`${plan.reference} is already active.`);
      if (plan.status === "archived") {
        throw conflict(`${plan.reference} is archived; copy it into a new plan rather than reviving it.`);
      }
      const at = nowIso();
      const superseded = await app.db.transaction(async (tx) => {
        const others = await tx
          .select({ id: resourcePlans.id, reference: resourcePlans.reference })
          .from(resourcePlans)
          .where(
            and(
              eq(resourcePlans.companyId, companyId),
              eq(resourcePlans.projectId, projectId),
              eq(resourcePlans.planKind, plan.planKind),
              eq(resourcePlans.status, "active"),
            ),
          )
          .for("update");
        if (others.length > 0) {
          await tx
            .update(resourcePlans)
            .set({ status: "superseded", updatedAt: at })
            .where(
              inArray(
                resourcePlans.id,
                others.map((o) => o.id),
              ),
            );
        }
        await tx
          .update(resourcePlans)
          .set({ status: "active", activatedBy: actorId, activatedAt: at, updatedAt: at })
          .where(eq(resourcePlans.id, planId));
        return others;
      });
      await ledgerResources(app.db, req, "state_change", "resource_plan", planId, {
        reference: plan.reference,
        from: plan.status,
        to: "active",
        supersededPlanIds: superseded.map((o) => o.id),
      });
      return {
        ...(await planView(planId, companyId, projectId)),
        superseded: superseded.map((o) => o.reference),
      };
    },
  );

  app.post(
    "/projects/:projectId/resource-plans/:planId/archive",
    { preHandler: gates.admin },
    async (req) => {
      const { planId } = req.params as { planId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const plan = await fetchPlan(app.db, planId, companyId, projectId);
      if (plan.status === "archived") return planView(planId, companyId, projectId);
      await app.db
        .update(resourcePlans)
        .set({ status: "archived", updatedAt: nowIso() })
        .where(eq(resourcePlans.id, planId));
      await ledgerResources(app.db, req, "state_change", "resource_plan", planId, {
        reference: plan.reference,
        from: plan.status,
        to: "archived",
      });
      return planView(planId, companyId, projectId);
    },
  );

  /* ================================================================== */
  /* Derivation from the schedule                                        */
  /* ================================================================== */

  app.post(
    "/projects/:projectId/resource-plans/:planId/derive",
    { preHandler: gates.standard },
    async (req) => {
      const { planId } = req.params as { planId: string };
      const body = S.deriveSchema.parse(req.body ?? {});
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const plan = await fetchPlan(app.db, planId, companyId, projectId);
      assertMutable(plan.status, "re-derive");

      const schedule = await resolveSchedule(
        app.db,
        projectId,
        body.scheduleId ?? plan.scheduleId ?? null,
      );
      if (!schedule) {
        throw badRequest(
          "This project has no active schedule to derive demand from. Import or create one first — " +
            "a resource plan that is not tied to a programme stops being true the first time a date moves.",
        );
      }
      const types = await typesForProject(app.db, companyId, projectId);
      if (types.length === 0) {
        throw badRequest(
          "No resource types are available to this project, so derived hours would have nothing to " +
            "attribute themselves to. Create the trades and plant classes first.",
        );
      }
      if (body.defaultResourceTypeId) {
        await requireTypeForProject(app.db, body.defaultResourceTypeId, companyId, projectId);
      }
      for (const typeId of Object.values(body.typeMap ?? {})) {
        await requireTypeForProject(app.db, typeId, companyId, projectId);
      }

      const taskRows = await app.db
        .select()
        .from(scheduleTasks)
        .where(eq(scheduleTasks.scheduleId, schedule.id))
        .limit(MAX_DERIVE_TASKS + 1);
      if (taskRows.length > MAX_DERIVE_TASKS) {
        throw badRequest(
          `This schedule holds more than ${MAX_DERIVE_TASKS} activities. Derive from a filtered ` +
            "schedule rather than loading the whole programme in one pass.",
        );
      }
      const resourceRows = await app.db
        .select()
        .from(scheduleTaskResources)
        .where(eq(scheduleTaskResources.scheduleId, schedule.id));

      /* Map each schedule resource line to a resource type: an explicit map
         entry first, then a case-insensitive match on the type's code, name
         or mapsToTrade, then the caller's default. */
      const byCode = new Map<string, string>();
      for (const type of types) {
        byCode.set(type.code.trim().toLowerCase(), type.id);
        byCode.set(type.name.trim().toLowerCase(), type.id);
        if (type.mapsToTrade) byCode.set(type.mapsToTrade.trim().toLowerCase(), type.id);
      }
      const explicit = new Map(
        Object.entries(body.typeMap ?? {}).map(([k, v]) => [k.trim().toLowerCase(), v]),
      );
      const resolveType = (name: string | null): string | null => {
        if (!name) return body.defaultResourceTypeId ?? null;
        const key = name.trim().toLowerCase();
        return explicit.get(key) ?? byCode.get(key) ?? body.defaultResourceTypeId ?? null;
      };

      const resourcesByTask = new Map<string, DemandTaskResource[]>();
      for (const row of resourceRows) {
        const list = resourcesByTask.get(row.taskId) ?? [];
        list.push({
          resourceTypeId: resolveType(row.name),
          name: row.name,
          budgetedUnits: row.budgetedUnits,
          unit: row.unit ?? (row.resourceType === "labour" ? "hours" : row.unit),
          remainingUnits: row.remainingUnits,
          actualUnits: row.actualUnits,
        });
        resourcesByTask.set(row.taskId, list);
      }

      const tasks: DemandTask[] = taskRows.map((task) => ({
        id: task.id,
        name: task.name,
        startDate: task.startDate,
        finishDate: task.finishDate,
        percentComplete: task.percentComplete,
        totalFloat: task.totalFloat,
        isCritical: task.isCritical === 1,
        budgetedHours: task.budgetedHours,
        resourceTypeId: resolveType(null),
        resources: resourcesByTask.get(task.id) ?? [],
        locationId: task.locationId,
      }));

      const { pattern, source: calendarSource, isDefault } = await workPatternFor(
        app.db,
        companyId,
        projectId,
      );
      const derivation = deriveDemand(tasks, {
        weekStartsOn: plan.weekStartsOn,
        pattern,
        remainingOnly: body.remainingOnly ?? false,
      });
      const rows = body.perActivity ? derivation.rows : collapseByTypeWeek(derivation.rows);
      const typeIndex = new Map(types.map((t) => [t.id, t]));

      const at = nowIso();
      const inserted = await app.db.transaction(async (tx) => {
        if (body.replaceDerived !== false) {
          await tx
            .delete(resourceDemands)
            .where(and(eq(resourceDemands.planId, planId), eq(resourceDemands.source, "schedule")));
        }
        if (rows.length === 0) return 0;
        const values = rows.map((row) => {
          const type = typeIndex.get(row.resourceTypeId);
          const daysInWeek = workingDaysInWeek(
            row.weekStart,
            row.weekStart,
            addDays(row.weekStart, 6),
            pattern,
          );
          const headcount = headcountFor(
            row.demandHours,
            type?.standardHoursPerDay ?? null,
            daysInWeek,
          );
          return {
            id: newId("rdm"),
            companyId,
            projectId,
            planId,
            resourceTypeId: row.resourceTypeId,
            weekStart: row.weekStart,
            demandHours: row.demandHours,
            headcount: headcount.value,
            source: "schedule" as const,
            sourceTaskId: body.perActivity ? row.sourceTaskId : null,
            sourceScheduleId: schedule.id,
            basis: row.basis,
            locationId: row.locationId,
            crewId: null,
            detail: {},
          };
        });
        for (let i = 0; i < values.length; i += 500) {
          await tx.insert(resourceDemands).values(values.slice(i, i + 500));
        }
        return values.length;
      });

      await recomputePlanRollups(planId, companyId, projectId);
      await app.db
        .update(resourcePlans)
        .set({
          source: "schedule",
          scheduleId: schedule.id,
          derivedAt: at,
          derivedTaskCount: derivation.derivedTaskCount,
          skippedTaskCount: derivation.skipped.length,
          periodStart: derivation.periodStart ?? plan.periodStart,
          periodEnd: derivation.periodEnd ?? plan.periodEnd,
          updatedAt: at,
        })
        .where(eq(resourcePlans.id, planId));

      await ledgerResources(app.db, req, "update", "resource_plan", planId, {
        reference: plan.reference,
        action: "derive",
        scheduleId: schedule.id,
        rowsWritten: inserted,
        tasksContributing: derivation.derivedTaskCount,
        tasksSkipped: derivation.skipped.length,
        remainingOnly: body.remainingOnly ?? false,
      });

      return {
        plan: await planView(planId, companyId, projectId),
        rowsWritten: inserted,
        derivedTaskCount: derivation.derivedTaskCount,
        totalDemandHours: derivation.totalDemandHours,
        skipped: derivation.skipped.slice(0, 200),
        skippedCount: derivation.skipped.length,
        calendar: { source: calendarSource, isDefault },
        reasons: [...derivation.reasons, ...(isDefault ? [calendarSource] : [])],
      };
    },
  );

  /* ================================================================== */
  /* Demand rows                                                         */
  /* ================================================================== */

  app.post(
    "/projects/:projectId/resource-plans/:planId/demand",
    { preHandler: gates.standard },
    async (req, reply) => {
      const { planId } = req.params as { planId: string };
      const body = S.demandCreateSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const plan = await fetchPlan(app.db, planId, companyId, projectId);
      assertMutable(plan.status, "add demand to");
      const type = await requireTypeForProject(app.db, body.resourceTypeId, companyId, projectId);
      if (body.sourceTaskId) await requireScheduleTask(app.db, body.sourceTaskId, projectId);

      const weekStart = weekStartOf(body.weekStart, plan.weekStartsOn);
      const { pattern } = await workPatternFor(app.db, companyId, projectId);
      const daysInWeek = workingDaysInWeek(weekStart, weekStart, addDays(weekStart, 6), pattern);
      const headcount =
        body.headcount ?? headcountFor(body.demandHours, type.standardHoursPerDay, daysInWeek).value;

      const id = newId("rdm");
      await app.db.insert(resourceDemands).values({
        id,
        companyId,
        projectId,
        planId,
        resourceTypeId: body.resourceTypeId,
        weekStart,
        demandHours: body.demandHours,
        headcount,
        source: "manual",
        sourceTaskId: body.sourceTaskId ?? null,
        sourceScheduleId: null,
        basis: body.basis ?? "Entered by hand.",
        locationId: body.locationId ?? null,
        crewId: body.crewId ?? null,
        detail: body.detail ?? {},
      });
      await recomputePlanRollups(planId, companyId, projectId);
      await ledgerResources(app.db, req, "create", "resource_demand", id, {
        planId,
        planReference: plan.reference,
        resourceTypeId: body.resourceTypeId,
        weekStart,
        demandHours: body.demandHours,
      });
      const [created] = await app.db
        .select()
        .from(resourceDemands)
        .where(eq(resourceDemands.id, id));
      return reply.status(201).send(created);
    },
  );

  app.get(
    "/projects/:projectId/resource-plans/:planId/demand",
    { preHandler: gates.read },
    async (req) => {
      const { planId } = req.params as { planId: string };
      const q = S.demandListQuery.parse(req.query);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      await fetchPlan(app.db, planId, companyId, projectId);
      const clauses = [eq(resourceDemands.planId, planId)];
      if (q.resourceTypeId) clauses.push(eq(resourceDemands.resourceTypeId, q.resourceTypeId));
      if (q.source) clauses.push(eq(resourceDemands.source, q.source));
      if (q.from) clauses.push(gte(resourceDemands.weekStart, q.from));
      if (q.to) clauses.push(lte(resourceDemands.weekStart, q.to));
      const where = and(...clauses);
      const [totalRow] = await app.db.select({ n: count() }).from(resourceDemands).where(where);
      const rows = await app.db
        .select({
          demand: resourceDemands,
          typeCode: resourceTypes.code,
          typeName: resourceTypes.name,
          typeKind: resourceTypes.kind,
        })
        .from(resourceDemands)
        .leftJoin(resourceTypes, eq(resourceTypes.id, resourceDemands.resourceTypeId))
        .where(where)
        .orderBy(asc(resourceDemands.weekStart), asc(resourceTypes.code))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(
        rows.map((r) => ({
          ...r.demand,
          resourceTypeCode: r.typeCode,
          resourceTypeName: r.typeName,
          resourceTypeKind: r.typeKind,
        })),
        Number(totalRow?.n ?? 0),
        q,
      );
    },
  );

  app.patch(
    "/projects/:projectId/resource-plans/:planId/demand/:demandId",
    { preHandler: gates.standard },
    async (req) => {
      const { planId, demandId } = req.params as { planId: string; demandId: string };
      const body = S.demandPatchSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const plan = await fetchPlan(app.db, planId, companyId, projectId);
      assertMutable(plan.status, "edit demand on");
      const row = await fetchDemand(demandId, planId);
      const set: Record<string, unknown> = { updatedAt: nowIso(), source: "manual" };
      const direct = ["demandHours", "headcount", "basis", "locationId", "crewId"] as const;
      for (const key of direct) if (body[key] !== undefined) set[key] = body[key];
      if (body.sourceTaskId !== undefined) {
        if (body.sourceTaskId) await requireScheduleTask(app.db, body.sourceTaskId, projectId);
        set["sourceTaskId"] = body.sourceTaskId;
      }
      if (body.detail !== undefined) set["detail"] = { ...(row.detail ?? {}), ...body.detail };
      await app.db.update(resourceDemands).set(set).where(eq(resourceDemands.id, demandId));
      await recomputePlanRollups(planId, companyId, projectId);
      await ledgerResources(app.db, req, "update", "resource_demand", demandId, {
        planId,
        changed: Object.keys(body),
      });
      const [updated] = await app.db
        .select()
        .from(resourceDemands)
        .where(eq(resourceDemands.id, demandId));
      return updated;
    },
  );

  app.delete(
    "/projects/:projectId/resource-plans/:planId/demand/:demandId",
    { preHandler: gates.standard },
    async (req) => {
      const { planId, demandId } = req.params as { planId: string; demandId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const plan = await fetchPlan(app.db, planId, companyId, projectId);
      assertMutable(plan.status, "delete demand from");
      const row = await fetchDemand(demandId, planId);
      await app.db.delete(resourceDemands).where(eq(resourceDemands.id, demandId));
      await recomputePlanRollups(planId, companyId, projectId);
      await ledgerResources(app.db, req, "delete", "resource_demand", demandId, {
        planId,
        resourceTypeId: row.resourceTypeId,
        weekStart: row.weekStart,
        demandHours: row.demandHours,
      });
      return { deleted: true, id: demandId };
    },
  );

  /* ================================================================== */
  /* Availability                                                        */
  /* ================================================================== */

  app.put("/projects/:projectId/resource-availability", { preHandler: gates.standard }, async (req) => {
    const body = S.availabilityUpsertSchema.parse(req.body);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    await requireTypeForProject(app.db, body.resourceTypeId, companyId, projectId);
    const weekStart = weekStartOf(body.weekStart, 1);
    const row = await upsertAvailability(
      companyId,
      projectId,
      { ...body, weekStart },
      actorOf(req),
    );
    await ledgerResources(app.db, req, "update", "resource_availability", row.id, {
      resourceTypeId: body.resourceTypeId,
      weekStart,
      availableHours: body.availableHours,
      source: body.source ?? "manual",
    });
    return row;
  });

  /** Fill a term in one act — a planner states a rate for a period, not 40 weeks. */
  app.post(
    "/projects/:projectId/resource-availability/bulk",
    { preHandler: gates.standard },
    async (req) => {
      const body = S.availabilityBulkSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      if (body.to < body.from) throw badRequest("`to` must not precede `from`");
      await requireTypeForProject(app.db, body.resourceTypeId, companyId, projectId);
      const weeks = enumerateWeeks(body.from, body.to, 1);
      if (weeks.length > MAX_HISTOGRAM_WEEKS) {
        throw badRequest(
          `That window is ${weeks.length} weeks. Availability is set in windows of at most ` +
            `${MAX_HISTOGRAM_WEEKS} weeks so a typo cannot write five years of rows.`,
        );
      }
      const written: string[] = [];
      for (const weekStart of weeks) {
        const row = await upsertAvailability(
          companyId,
          projectId,
          { ...body, weekStart },
          actorOf(req),
        );
        written.push(row.id);
      }
      await ledgerResources(app.db, req, "update", "resource_availability", body.resourceTypeId, {
        action: "bulk",
        from: body.from,
        to: body.to,
        weeks: weeks.length,
        availableHours: body.availableHours,
        source: body.source ?? "manual",
      });
      return { weeks: weeks.length, ids: written };
    },
  );

  app.get("/projects/:projectId/resource-availability", { preHandler: gates.read }, async (req) => {
    const q = S.availabilityListQuery.parse(req.query);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const clauses = [
      eq(resourceAvailability.companyId, companyId),
      eq(resourceAvailability.projectId, projectId),
    ];
    if (q.resourceTypeId) clauses.push(eq(resourceAvailability.resourceTypeId, q.resourceTypeId));
    if (q.from) clauses.push(gte(resourceAvailability.weekStart, q.from));
    if (q.to) clauses.push(lte(resourceAvailability.weekStart, q.to));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(resourceAvailability).where(where);
    const rows = await app.db
      .select({
        availability: resourceAvailability,
        typeCode: resourceTypes.code,
        typeName: resourceTypes.name,
      })
      .from(resourceAvailability)
      .leftJoin(resourceTypes, eq(resourceTypes.id, resourceAvailability.resourceTypeId))
      .where(where)
      .orderBy(asc(resourceAvailability.weekStart), asc(resourceTypes.code))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      rows.map((r) => ({
        ...r.availability,
        resourceTypeCode: r.typeCode,
        resourceTypeName: r.typeName,
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.delete(
    "/projects/:projectId/resource-availability/:availabilityId",
    { preHandler: gates.standard },
    async (req) => {
      const { availabilityId } = req.params as { availabilityId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const rows = await app.db
        .select()
        .from(resourceAvailability)
        .where(
          and(
            eq(resourceAvailability.id, availabilityId),
            eq(resourceAvailability.companyId, companyId),
            eq(resourceAvailability.projectId, projectId),
          ),
        )
        .limit(1);
      if (!rows[0]) throw notFound("Availability row not found on this project");
      await app.db.delete(resourceAvailability).where(eq(resourceAvailability.id, availabilityId));
      await ledgerResources(app.db, req, "delete", "resource_availability", availabilityId, {
        resourceTypeId: rows[0].resourceTypeId,
        weekStart: rows[0].weekStart,
      });
      return { deleted: true, id: availabilityId };
    },
  );

  /* ================================================================== */
  /* The histogram                                                       */
  /* ================================================================== */

  app.get("/projects/:projectId/resources/histogram", { preHandler: gates.read }, async (req) => {
    const q = S.histogramQuery.parse(req.query);
    const companyId = companyOf(req);
    const projectId = projectOf(req);

    const plan = q.planId
      ? await fetchPlan(app.db, q.planId, companyId, projectId)
      : await activePlan(companyId, projectId);
    const reasons: string[] = [];
    if (!plan) {
      reasons.push(
        "No active resource plan exists on this project, so there is no demand to plot. Create a " +
          "plan and derive it from the schedule.",
      );
    }

    const demandRows = plan
      ? await app.db
          .select({
            resourceTypeId: resourceDemands.resourceTypeId,
            weekStart: resourceDemands.weekStart,
            demandHours: resourceDemands.demandHours,
            sourceTaskId: resourceDemands.sourceTaskId,
          })
          .from(resourceDemands)
          .where(
            and(
              eq(resourceDemands.planId, plan.id),
              ...(q.from ? [gte(resourceDemands.weekStart, q.from)] : []),
              ...(q.to ? [lte(resourceDemands.weekStart, q.to)] : []),
              ...(q.resourceTypeId ? [eq(resourceDemands.resourceTypeId, q.resourceTypeId)] : []),
            ),
          )
      : [];

    const supplyRows = await app.db
      .select({
        resourceTypeId: resourceAvailability.resourceTypeId,
        weekStart: resourceAvailability.weekStart,
        availableHours: resourceAvailability.availableHours,
        availableHeadcount: resourceAvailability.availableHeadcount,
        source: resourceAvailability.source,
      })
      .from(resourceAvailability)
      .where(
        and(
          eq(resourceAvailability.companyId, companyId),
          eq(resourceAvailability.projectId, projectId),
          ...(q.from ? [gte(resourceAvailability.weekStart, q.from)] : []),
          ...(q.to ? [lte(resourceAvailability.weekStart, q.to)] : []),
          ...(q.resourceTypeId
            ? [eq(resourceAvailability.resourceTypeId, q.resourceTypeId)]
            : []),
        ),
      );

    const allWeeks = [
      ...demandRows.map((r) => r.weekStart),
      ...supplyRows.map((r) => r.weekStart),
    ].sort();
    const from = q.from ?? allWeeks[0] ?? plan?.periodStart ?? todayIso();
    const to = q.to ?? allWeeks[allWeeks.length - 1] ?? plan?.periodEnd ?? addDays(from, 6);
    let weeks = enumerateWeeks(from, to, plan?.weekStartsOn ?? 1);
    if (weeks.length > MAX_HISTOGRAM_WEEKS) {
      weeks = weeks.slice(0, MAX_HISTOGRAM_WEEKS);
      reasons.push(
        `The window was truncated to ${MAX_HISTOGRAM_WEEKS} weeks (to ${weeks[weeks.length - 1]}). ` +
          "Narrow the from/to range to see beyond it.",
      );
    }

    const allTypes = await typesForProject(app.db, companyId, projectId);
    const usedTypeIds = new Set([
      ...demandRows.map((r) => r.resourceTypeId),
      ...supplyRows.map((r) => r.resourceTypeId),
    ]);
    const types: HistogramType[] = allTypes
      .filter((t) => (q.kind ? t.kind === q.kind : true))
      .filter((t) => (q.resourceTypeId ? t.id === q.resourceTypeId : usedTypeIds.has(t.id)))
      .map((t) => ({
        id: t.id,
        code: t.code,
        name: t.name,
        kind: t.kind,
        unit: t.unit,
        standardHoursPerDay: t.standardHoursPerDay,
        workingDaysPerWeek: t.workingDaysPerWeek,
      }));

    const { pattern, source: calendarSource, isDefault } = await workPatternFor(
      app.db,
      companyId,
      projectId,
    );
    if (isDefault) reasons.push(calendarSource);

    const histogram = buildHistogram({
      weeks,
      types,
      demand: demandRows,
      supply: supplyRows as HistogramSupplyRow[],
      workingDaysPerWeek: standardWorkingDaysPerWeek(pattern),
    });

    let levelling: ReturnType<typeof suggestLevelling> = [];
    if (q.includeLevelling !== "false" && histogram.totals.overAllocatedCells > 0 && plan) {
      const taskIds = [
        ...new Set(
          histogram.series
            .flatMap((s) => s.cells)
            .flatMap((c) => c.contributingTaskIds)
            .filter((id): id is string => Boolean(id)),
        ),
      ].slice(0, 500);
      const tasks: LevellingTask[] =
        taskIds.length > 0
          ? (
              await app.db
                .select({
                  id: scheduleTasks.id,
                  name: scheduleTasks.name,
                  totalFloat: scheduleTasks.totalFloat,
                  isCritical: scheduleTasks.isCritical,
                  startDate: scheduleTasks.startDate,
                  finishDate: scheduleTasks.finishDate,
                })
                .from(scheduleTasks)
                .where(
                  and(eq(scheduleTasks.projectId, projectId), inArray(scheduleTasks.id, taskIds)),
                )
            ).map((t) => ({
              id: t.id,
              name: t.name,
              totalFloat: t.totalFloat,
              isCritical: t.isCritical === 1,
              startDate: t.startDate,
              finishDate: t.finishDate,
            }))
          : [];
      levelling = suggestLevelling({
        histogram,
        contributions: demandRows.map((r) => ({
          resourceTypeId: r.resourceTypeId,
          weekStart: r.weekStart,
          sourceTaskId: r.sourceTaskId,
          demandHours: r.demandHours,
        })),
        tasks,
      });
      if (levelling.length === 0 && histogram.totals.overAllocatedCells > 0) {
        reasons.push(
          "This plan's demand rows are aggregated per trade-week rather than per activity, so a " +
            "levelling suggestion cannot name which activity to move. Re-derive with perActivity " +
            "set to keep the traceability.",
        );
      }
    }

    return {
      plan: plan
        ? {
            id: plan.id,
            reference: plan.reference,
            name: plan.name,
            status: plan.status,
            planKind: plan.planKind,
            weekStartsOn: plan.weekStartsOn,
          }
        : null,
      window: { from, to },
      calendar: { source: calendarSource, isDefault },
      ...histogram,
      levelling,
      reasons: [...reasons, ...histogram.reasons],
    };
  });

  /* ================================================================== */
  /* Helpers                                                             */
  /* ================================================================== */

  function assertMutable(status: string, what: string): void {
    if (status === "superseded" || status === "archived") {
      throw conflict(
        `Cannot ${what} a plan that is ${status}. A superseded plan is the record of what was ` +
          "planned at the time; copy it into a new version instead of rewriting history.",
      );
    }
  }

  async function fetchDemand(demandId: string, planId: string) {
    const rows = await app.db
      .select()
      .from(resourceDemands)
      .where(and(eq(resourceDemands.id, demandId), eq(resourceDemands.planId, planId)))
      .limit(1);
    if (!rows[0]) throw notFound("Demand row not found on this plan");
    return rows[0];
  }

  async function activePlan(companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(resourcePlans)
      .where(
        and(
          eq(resourcePlans.companyId, companyId),
          eq(resourcePlans.projectId, projectId),
          eq(resourcePlans.status, "active"),
          eq(resourcePlans.planKind, "current"),
        ),
      )
      .orderBy(asc(resourcePlans.number))
      .limit(1);
    return rows[0] ?? null;
  }

  async function upsertAvailability(
    companyId: string,
    projectId: string,
    body: {
      resourceTypeId: string;
      weekStart: string;
      availableHours: number;
      availableHeadcount?: number | null;
      source?: string;
      vendorId?: string | null;
      commitmentId?: string | null;
      note?: string | null;
      detail?: Record<string, unknown>;
    },
    actorId: string,
  ) {
    const existing = await app.db
      .select()
      .from(resourceAvailability)
      .where(
        and(
          eq(resourceAvailability.projectId, projectId),
          eq(resourceAvailability.resourceTypeId, body.resourceTypeId),
          eq(resourceAvailability.weekStart, body.weekStart),
        ),
      )
      .limit(1);
    if (existing[0]) {
      await app.db
        .update(resourceAvailability)
        .set({
          availableHours: body.availableHours,
          availableHeadcount: body.availableHeadcount ?? null,
          source: body.source ?? "manual",
          vendorId: body.vendorId ?? null,
          commitmentId: body.commitmentId ?? null,
          note: body.note ?? null,
          detail: { ...(existing[0].detail ?? {}), ...(body.detail ?? {}) },
          updatedAt: nowIso(),
        })
        .where(eq(resourceAvailability.id, existing[0].id));
      const [updated] = await app.db
        .select()
        .from(resourceAvailability)
        .where(eq(resourceAvailability.id, existing[0].id));
      return updated!;
    }
    const id = newId("rav");
    await app.db.insert(resourceAvailability).values({
      id,
      companyId,
      projectId,
      resourceTypeId: body.resourceTypeId,
      weekStart: body.weekStart,
      availableHours: body.availableHours,
      availableHeadcount: body.availableHeadcount ?? null,
      source: body.source ?? "manual",
      vendorId: body.vendorId ?? null,
      commitmentId: body.commitmentId ?? null,
      note: body.note ?? null,
      detail: body.detail ?? {},
      createdBy: actorId,
    });
    const [created] = await app.db
      .select()
      .from(resourceAvailability)
      .where(eq(resourceAvailability.id, id));
    return created!;
  }

  /**
   * Materialise the plan's roll-ups. The peak headcount is NULL whenever any
   * contributing trade cannot be converted to a headcount — a peak that
   * silently omits the trades with no standard day is a smaller, plausible,
   * wrong number, and it is the number a resourcing decision gets made on.
   */
  async function recomputePlanRollups(
    planId: string,
    companyId: string,
    projectId: string,
  ): Promise<void> {
    const rows = await app.db
      .select({
        weekStart: resourceDemands.weekStart,
        demandHours: resourceDemands.demandHours,
        headcount: resourceDemands.headcount,
      })
      .from(resourceDemands)
      .where(eq(resourceDemands.planId, planId));
    const byWeek = new Map<string, { hours: number; headcount: number; complete: boolean }>();
    let total = 0;
    for (const row of rows) {
      total = round2(total + row.demandHours);
      const held = byWeek.get(row.weekStart) ?? { hours: 0, headcount: 0, complete: true };
      held.hours = round2(held.hours + row.demandHours);
      if (row.headcount === null) held.complete = false;
      else held.headcount = round2(held.headcount + row.headcount);
      byWeek.set(row.weekStart, held);
    }
    let peakWeek: string | null = null;
    let peakHours = -1;
    for (const [week, agg] of byWeek) {
      if (agg.hours > peakHours) {
        peakHours = agg.hours;
        peakWeek = week;
      }
    }
    const peak = peakWeek ? byWeek.get(peakWeek)! : null;
    await app.db
      .update(resourcePlans)
      .set({
        demandRowCount: rows.length,
        totalDemandHours: total,
        peakWeekStart: peakWeek,
        peakHeadcount: peak && peak.complete ? peak.headcount : null,
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(resourcePlans.id, planId),
          eq(resourcePlans.companyId, companyId),
          eq(resourcePlans.projectId, projectId),
        ),
      );
  }

  async function planView(planId: string, companyId: string, projectId: string) {
    const plan = await fetchPlan(app.db, planId, companyId, projectId);
    const [rowCount] = await app.db
      .select({ n: count(), hours: sql<number>`coalesce(sum(${resourceDemands.demandHours}), 0)` })
      .from(resourceDemands)
      .where(eq(resourceDemands.planId, planId));
    const typeRows = await app.db
      .select({
        resourceTypeId: resourceDemands.resourceTypeId,
        hours: sql<number>`coalesce(sum(${resourceDemands.demandHours}), 0)`,
        code: resourceTypes.code,
        name: resourceTypes.name,
        kind: resourceTypes.kind,
      })
      .from(resourceDemands)
      .leftJoin(resourceTypes, eq(resourceTypes.id, resourceDemands.resourceTypeId))
      .where(eq(resourceDemands.planId, planId))
      .groupBy(
        resourceDemands.resourceTypeId,
        resourceTypes.code,
        resourceTypes.name,
        resourceTypes.kind,
      );
    return {
      ...plan,
      demandRows: Number(rowCount?.n ?? 0),
      demandHours: round2(Number(rowCount?.hours ?? 0)),
      byResourceType: typeRows
        .map((r) => ({
          resourceTypeId: r.resourceTypeId,
          code: r.code,
          name: r.name,
          kind: r.kind,
          demandHours: round2(Number(r.hours ?? 0)),
        }))
        .sort((a, b) => b.demandHours - a.demandHours),
      peakHeadcountBasis:
        plan.peakHeadcount === null
          ? "Not derivable: at least one trade in the peak week records no standard hours per day, " +
            "so a headcount that omitted it would understate the peak."
          : `Peak week beginning ${plan.peakWeekStart}.`,
    };
  }
};
