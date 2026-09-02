/**
 * ACTION PLANS (spec #447–456): the template library, the plan instance, its
 * required activities, evidence, multi-party sign-off and the completion
 * report.
 *
 * The rules the engine enforces and this file refuses to bypass:
 *   · evidence must exist before an activity can be signed off (#449);
 *   · every required party must sign, not the first one (#452);
 *   · a quality checkpoint blocks everything after it until it closes (#456);
 *   · the person who submitted the evidence may not be the only signatory when
 *     the plan asks for someone else — a signature by the doer alone is not an
 *     independent check.
 *
 * Templates are company-level configuration; plans are project data.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  actionPlanActivities,
  actionPlanSignoffs,
  actionPlanTemplateActivities,
  actionPlanTemplates,
  actionPlans,
  projects,
} from "@constructos/db";
import {
  ACTION_PLAN_ANCHORS,
  ACTION_PLAN_STATUSES,
  SIGNOFF_PARTY_TYPES,
} from "@constructos/shared";
import { badRequest, conflict, forbidden, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { pushNotifications } from "../../notifications/service.js";
import { addDaysISO } from "../engines/dates.js";
import {
  completionReport,
  signoffReadiness,
  signoffsSatisfied,
} from "../engines/plans.js";
import { loadPlanActivities, syncPlan, toActivityInput } from "../service.js";
import {
  allocateReference,
  assertCompanyUser,
  assertFiles,
  assertLocation,
  assertScheduleTask,
  assertVendor,
  buildGates,
  fileIdsSchema,
  idSchema,
  isoDateSchema,
  keySchema,
  ledger,
  nowISO,
  patchSet,
  todayISO,
} from "../shared.js";

/* ------------------------------------------------------------------ */
/* Wire formats                                                        */
/* ------------------------------------------------------------------ */

const signoffPartySchema = z.object({
  partyType: z.enum(SIGNOFF_PARTY_TYPES).default("user"),
  partyId: idSchema.nullable().optional(),
  label: z.string().trim().min(1).max(120),
});

const templateActivitySchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(10_000).nullable().optional(),
  evidenceRequired: z.boolean().default(false),
  evidenceRequirement: z.string().max(2000).nullable().optional(),
  referenceFileIds: fileIdsSchema.default([]),
  signoffParties: z.array(signoffPartySchema).max(10).default([]),
  isQualityCheckpoint: z.boolean().default(false),
  dueOffsetDays: z.number().int().min(0).max(3650).nullable().optional(),
});

const templateBodySchema = z.object({
  key: keySchema,
  name: z.string().trim().min(1).max(160),
  description: z.string().max(4000).nullable().optional(),
  category: z.string().max(80).nullable().optional(),
  projectId: idSchema.nullable().optional(),
  activities: z.array(templateActivitySchema).max(200).default([]),
});

const planBodySchema = z.object({
  templateId: idSchema.nullable().optional(),
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(10_000).nullable().optional(),
  anchor: z.enum(ACTION_PLAN_ANCHORS).default("none"),
  locationId: idSchema.nullable().optional(),
  scheduleTaskId: idSchema.nullable().optional(),
  ownerId: idSchema.nullable().optional(),
  startDate: isoDateSchema.optional(),
  dueDate: isoDateSchema.nullable().optional(),
  activities: z.array(templateActivitySchema).max(200).default([]),
});

const planListSchema = pageQuerySchema.extend({
  status: z.enum(ACTION_PLAN_STATUSES).optional(),
  templateId: idSchema.optional(),
  locationId: idSchema.optional(),
  scheduleTaskId: idSchema.optional(),
  ownerId: idSchema.optional(),
  overdueOnly: z.coerce.boolean().optional(),
  q: z.string().max(200).optional(),
});

export const planRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate, companyGate, companyAdminGate } = buildGates(app);

  /* ================================================================ */
  /* Template library (company level)                                  */
  /* ================================================================ */

  app.get("/correspondence/action-plan-templates", { preHandler: companyGate }, async (req) => {
    const q = z
      .object({ projectId: idSchema.optional(), includeInactive: z.coerce.boolean().default(false) })
      .parse(req.query);
    const rows = await app.db
      .select()
      .from(actionPlanTemplates)
      .where(
        and(
          eq(actionPlanTemplates.companyId, req.companyId!),
          q.includeInactive ? undefined : eq(actionPlanTemplates.isActive, 1),
          q.projectId
            ? or(isNull(actionPlanTemplates.projectId), eq(actionPlanTemplates.projectId, q.projectId))
            : undefined,
        ),
      )
      .orderBy(asc(actionPlanTemplates.name));
    const counts =
      rows.length === 0
        ? []
        : await app.db
            .select({
              templateId: actionPlanTemplateActivities.templateId,
              n: sql<number>`count(*)::int`,
            })
            .from(actionPlanTemplateActivities)
            .where(
              inArray(
                actionPlanTemplateActivities.templateId,
                rows.map((r) => r.id),
              ),
            )
            .groupBy(actionPlanTemplateActivities.templateId);
    const byTemplate = new Map(counts.map((c) => [c.templateId, Number(c.n)]));
    return {
      items: rows.map((r) => ({ ...r, activityCount: byTemplate.get(r.id) ?? 0 })),
      total: rows.length,
    };
  });

  app.post("/correspondence/action-plan-templates", { preHandler: companyAdminGate }, async (req, reply) => {
    const body = templateBodySchema.parse(req.body);
    const companyId = req.companyId!;
    if (body.projectId) {
      const [row] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, body.projectId), eq(projects.companyId, companyId)))
        .limit(1);
      if (!row) throw badRequest(`Project ${body.projectId} not found in this company.`);
    }
    const clash = await app.db
      .select({ id: actionPlanTemplates.id })
      .from(actionPlanTemplates)
      .where(and(eq(actionPlanTemplates.companyId, companyId), eq(actionPlanTemplates.key, body.key)))
      .limit(1);
    if (clash[0]) throw conflict(`An action plan template with the key "${body.key}" already exists.`);

    const id = newId("apt");
    const [row] = await app.db
      .insert(actionPlanTemplates)
      .values({
        id,
        companyId,
        projectId: body.projectId ?? null,
        key: body.key,
        name: body.name,
        description: body.description ?? null,
        category: body.category ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    const activities = body.activities.map((a, index) => ({
      id: newId("apa"),
      companyId,
      templateId: id,
      seq: index + 1,
      title: a.title,
      description: a.description ?? null,
      evidenceRequired: a.evidenceRequired ? 1 : 0,
      evidenceRequirement: a.evidenceRequirement ?? null,
      referenceFileIds: a.referenceFileIds,
      signoffParties: a.signoffParties.map((p) => ({
        partyType: p.partyType,
        partyId: p.partyId ?? null,
        label: p.label,
      })),
      isQualityCheckpoint: a.isQualityCheckpoint ? 1 : 0,
      dueOffsetDays: a.dueOffsetDays ?? null,
    }));
    if (activities.length > 0) await app.db.insert(actionPlanTemplateActivities).values(activities);
    await ledger(app.db, {
      companyId,
      projectId: body.projectId ?? null,
      actorId: req.user!.id,
      action: "create",
      objectType: "action_plan_template",
      objectId: id,
      payload: { key: body.key, name: body.name, activities: activities.length },
    });
    return reply.code(201).send({ ...row, activities });
  });

  app.get("/correspondence/action-plan-templates/:templateId", { preHandler: companyGate }, async (req) => {
    const { templateId } = req.params as { templateId: string };
    const [row] = await app.db
      .select()
      .from(actionPlanTemplates)
      .where(
        and(eq(actionPlanTemplates.id, templateId), eq(actionPlanTemplates.companyId, req.companyId!)),
      )
      .limit(1);
    if (!row) throw notFound("Action plan template not found");
    const activities = await app.db
      .select()
      .from(actionPlanTemplateActivities)
      .where(eq(actionPlanTemplateActivities.templateId, templateId))
      .orderBy(asc(actionPlanTemplateActivities.seq));
    return { ...row, activities };
  });

  app.patch(
    "/correspondence/action-plan-templates/:templateId",
    { preHandler: companyAdminGate },
    async (req) => {
      const { templateId } = req.params as { templateId: string };
      const body = z
        .object({
          name: z.string().trim().min(1).max(160).optional(),
          description: z.string().max(4000).nullable().optional(),
          category: z.string().max(80).nullable().optional(),
          isActive: z.boolean().optional(),
          activities: z.array(templateActivitySchema).max(200).optional(),
        })
        .parse(req.body);
      const companyId = req.companyId!;
      const [current] = await app.db
        .select()
        .from(actionPlanTemplates)
        .where(and(eq(actionPlanTemplates.id, templateId), eq(actionPlanTemplates.companyId, companyId)))
        .limit(1);
      if (!current) throw notFound("Action plan template not found");

      const set = patchSet(
        { ...body, isActive: body.isActive === undefined ? undefined : body.isActive ? 1 : 0 },
        ["name", "description", "category", "isActive"],
      );
      if (body.activities) {
        // Replacing the activity list is a new version: plans already created
        // keep the version they were built from, which is why instances copy
        // rather than reference.
        set["version"] = current.version + 1;
        await app.db
          .delete(actionPlanTemplateActivities)
          .where(eq(actionPlanTemplateActivities.templateId, templateId));
        const rows = body.activities.map((a, index) => ({
          id: newId("apa"),
          companyId,
          templateId,
          seq: index + 1,
          title: a.title,
          description: a.description ?? null,
          evidenceRequired: a.evidenceRequired ? 1 : 0,
          evidenceRequirement: a.evidenceRequirement ?? null,
          referenceFileIds: a.referenceFileIds,
          signoffParties: a.signoffParties.map((p) => ({
            partyType: p.partyType,
            partyId: p.partyId ?? null,
            label: p.label,
          })),
          isQualityCheckpoint: a.isQualityCheckpoint ? 1 : 0,
          dueOffsetDays: a.dueOffsetDays ?? null,
        }));
        if (rows.length > 0) await app.db.insert(actionPlanTemplateActivities).values(rows);
      }
      const [row] = await app.db
        .update(actionPlanTemplates)
        .set(set)
        .where(eq(actionPlanTemplates.id, templateId))
        .returning();
      await ledger(app.db, {
        companyId,
        projectId: current.projectId,
        actorId: req.user!.id,
        action: "update",
        objectType: "action_plan_template",
        objectId: templateId,
        payload: { changed: Object.keys(set).filter((k) => k !== "updatedAt") },
      });
      return row;
    },
  );

  /* ================================================================ */
  /* Plans (project level)                                             */
  /* ================================================================ */

  async function loadPlan(companyId: string, projectId: string, planId: string) {
    const [row] = await app.db
      .select()
      .from(actionPlans)
      .where(
        and(
          eq(actionPlans.id, planId),
          eq(actionPlans.companyId, companyId),
          eq(actionPlans.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Action plan not found");
    return row;
  }

  async function loadActivity(companyId: string, projectId: string, activityId: string) {
    const [row] = await app.db
      .select()
      .from(actionPlanActivities)
      .where(
        and(
          eq(actionPlanActivities.id, activityId),
          eq(actionPlanActivities.companyId, companyId),
          eq(actionPlanActivities.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Action plan activity not found");
    return row;
  }

  app.get("/projects/:projectId/correspondence/action-plans", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = planListSchema.parse(req.query);
    const today = todayISO();
    const where = and(
      eq(actionPlans.companyId, req.companyId!),
      eq(actionPlans.projectId, projectId),
      q.status ? eq(actionPlans.status, q.status) : undefined,
      q.templateId ? eq(actionPlans.templateId, q.templateId) : undefined,
      q.locationId ? eq(actionPlans.locationId, q.locationId) : undefined,
      q.scheduleTaskId ? eq(actionPlans.scheduleTaskId, q.scheduleTaskId) : undefined,
      q.ownerId ? eq(actionPlans.ownerId, q.ownerId) : undefined,
      q.overdueOnly
        ? and(
            inArray(actionPlans.status, ["active", "blocked"]),
            sql`${actionPlans.dueDate} < ${today}`,
          )
        : undefined,
      q.q ? or(ilike(actionPlans.title, `%${q.q}%`), ilike(actionPlans.reference, `%${q.q}%`)) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db
        .select()
        .from(actionPlans)
        .where(where)
        .orderBy(desc(actionPlans.createdAt))
        .limit(q.pageSize)
        .offset(pageOffset(q)),
      app.db.select({ n: count() }).from(actionPlans).where(where),
    ]);
    return paginate(
      rows.map((row) => ({
        ...row,
        overdue:
          (row.status === "active" || row.status === "blocked") &&
          row.dueDate !== null &&
          row.dueDate < today,
      })),
      total?.n ?? 0,
      q,
    );
  });

  app.post("/projects/:projectId/correspondence/action-plans", { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = planBodySchema.parse(req.body);
    const companyId = req.companyId!;

    let template: typeof actionPlanTemplates.$inferSelect | null = null;
    let templateActivities: Array<z.infer<typeof templateActivitySchema>> = body.activities;
    if (body.templateId) {
      const [row] = await app.db
        .select()
        .from(actionPlanTemplates)
        .where(
          and(eq(actionPlanTemplates.id, body.templateId), eq(actionPlanTemplates.companyId, companyId)),
        )
        .limit(1);
      if (!row) throw badRequest(`Action plan template ${body.templateId} not found in this company.`);
      if (row.projectId !== null && row.projectId !== projectId) {
        throw badRequest(`Template "${row.key}" belongs to another project.`);
      }
      if (row.isActive !== 1) throw badRequest(`Template "${row.key}" is not active.`);
      template = row;
      const rows = await app.db
        .select()
        .from(actionPlanTemplateActivities)
        .where(eq(actionPlanTemplateActivities.templateId, row.id))
        .orderBy(asc(actionPlanTemplateActivities.seq));
      templateActivities = rows.map((a) => ({
        title: a.title,
        description: a.description,
        evidenceRequired: a.evidenceRequired === 1,
        evidenceRequirement: a.evidenceRequirement,
        referenceFileIds: a.referenceFileIds ?? [],
        signoffParties: (a.signoffParties ?? []).map((p) => ({
          partyType: (p.partyType ?? "user") as z.infer<typeof signoffPartySchema>["partyType"],
          partyId: p.partyId ?? null,
          label: p.label,
        })),
        isQualityCheckpoint: a.isQualityCheckpoint === 1,
        dueOffsetDays: a.dueOffsetDays,
      }));
      if (body.activities.length > 0) templateActivities = [...templateActivities, ...body.activities];
    }
    const title = body.title ?? template?.name;
    if (!title) throw badRequest("A plan needs a title, or a template to take its name from.");

    if (body.anchor === "location") {
      if (!body.locationId) throw badRequest("A location-anchored plan needs a locationId.");
      await assertLocation(app.db, projectId, body.locationId);
    }
    if (body.anchor === "schedule_task") {
      if (!body.scheduleTaskId) throw badRequest("A task-anchored plan needs a scheduleTaskId.");
      await assertScheduleTask(app.db, projectId, body.scheduleTaskId);
    }
    if (body.ownerId) await assertCompanyUser(app.db, companyId, body.ownerId);

    const id = newId("apl");
    const { number, reference } = await allocateReference(app.db, projectId, "action_plan", "AP");
    const startDate = body.startDate ?? todayISO();
    const [row] = await app.db
      .insert(actionPlans)
      .values({
        id,
        companyId,
        projectId,
        number,
        reference,
        title,
        description: body.description ?? template?.description ?? null,
        templateId: template?.id ?? null,
        templateVersion: template?.version ?? null,
        anchor: body.anchor,
        locationId: body.anchor === "location" ? (body.locationId ?? null) : null,
        scheduleTaskId: body.anchor === "schedule_task" ? (body.scheduleTaskId ?? null) : null,
        ownerId: body.ownerId ?? req.user!.id,
        startDate,
        dueDate: body.dueDate ?? null,
        activityCount: templateActivities.length,
        createdBy: req.user!.id,
      })
      .returning();

    const activityRows = [];
    const signoffRows = [];
    for (const [index, a] of templateActivities.entries()) {
      const activityId = newId("apc");
      const required = a.signoffParties.length;
      activityRows.push({
        id: activityId,
        companyId,
        projectId,
        planId: id,
        seq: index + 1,
        title: a.title,
        description: a.description ?? null,
        evidenceRequired: a.evidenceRequired ? 1 : 0,
        evidenceRequirement: a.evidenceRequirement ?? null,
        referenceFileIds: a.referenceFileIds ?? [],
        isQualityCheckpoint: a.isQualityCheckpoint ? 1 : 0,
        signoffRequiredCount: required,
        dueDate: a.dueOffsetDays !== null && a.dueOffsetDays !== undefined ? addDaysISO(startDate, a.dueOffsetDays) : null,
      });
      for (const [pIndex, party] of (a.signoffParties ?? []).entries()) {
        signoffRows.push({
          id: newId("aps"),
          companyId,
          projectId,
          planId: id,
          activityId,
          seq: pIndex + 1,
          partyType: party.partyType,
          partyId: party.partyId ?? null,
          label: party.label,
        });
      }
    }
    if (activityRows.length > 0) await app.db.insert(actionPlanActivities).values(activityRows);
    if (signoffRows.length > 0) await app.db.insert(actionPlanSignoffs).values(signoffRows);
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "action_plan",
      objectId: id,
      payload: {
        reference,
        title,
        templateId: template?.id ?? null,
        activities: activityRows.length,
        anchor: body.anchor,
      },
    });
    return reply.code(201).send({ ...row, activities: activityRows, signoffs: signoffRows });
  });

  app.get(
    "/projects/:projectId/correspondence/action-plans/:planId",
    { preHandler: readGate },
    async (req) => {
      const { projectId, planId } = req.params as { projectId: string; planId: string };
      const companyId = req.companyId!;
      const plan = await loadPlan(companyId, projectId, planId);
      const [activities, signoffs] = await Promise.all([
        loadPlanActivities(app.db, companyId, planId),
        app.db
          .select()
          .from(actionPlanSignoffs)
          .where(and(eq(actionPlanSignoffs.companyId, companyId), eq(actionPlanSignoffs.planId, planId)))
          .orderBy(asc(actionPlanSignoffs.seq)),
      ]);
      const inputs = activities.map(toActivityInput);
      const report = completionReport(inputs, todayISO());
      const bySignoff = new Map<string, typeof signoffs>();
      for (const s of signoffs) {
        const list = bySignoff.get(s.activityId) ?? [];
        list.push(s);
        bySignoff.set(s.activityId, list);
      }
      return {
        ...plan,
        activities: activities.map((a) => ({
          ...a,
          signoffs: bySignoff.get(a.id) ?? [],
          readiness: signoffReadiness(toActivityInput(a), inputs),
        })),
        progress: report.progress,
        report,
      };
    },
  );

  app.get(
    "/projects/:projectId/correspondence/action-plans/:planId/report",
    { preHandler: readGate },
    async (req) => {
      const { projectId, planId } = req.params as { projectId: string; planId: string };
      const companyId = req.companyId!;
      const plan = await loadPlan(companyId, projectId, planId);
      const activities = (await loadPlanActivities(app.db, companyId, planId)).map(toActivityInput);
      return {
        plan: {
          id: plan.id,
          reference: plan.reference,
          title: plan.title,
          status: plan.status,
          startDate: plan.startDate,
          dueDate: plan.dueDate,
          anchor: plan.anchor,
          locationId: plan.locationId,
          scheduleTaskId: plan.scheduleTaskId,
        },
        ...completionReport(activities, todayISO()),
        generatedAt: nowISO(),
      };
    },
  );

  app.patch(
    "/projects/:projectId/correspondence/action-plans/:planId",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, planId } = req.params as { projectId: string; planId: string };
      const body = z
        .object({
          title: z.string().trim().min(1).max(300).optional(),
          description: z.string().max(10_000).nullable().optional(),
          ownerId: idSchema.nullable().optional(),
          startDate: isoDateSchema.optional(),
          dueDate: isoDateSchema.nullable().optional(),
        })
        .parse(req.body);
      const companyId = req.companyId!;
      const plan = await loadPlan(companyId, projectId, planId);
      if (plan.status === "completed" || plan.status === "cancelled") {
        throw conflict(`${plan.reference} is ${plan.status} and cannot be edited.`);
      }
      if (body.ownerId) await assertCompanyUser(app.db, companyId, body.ownerId);
      const set = patchSet(body, ["title", "description", "ownerId", "startDate", "dueDate"]);
      const [row] = await app.db
        .update(actionPlans)
        .set(set)
        .where(eq(actionPlans.id, planId))
        .returning();
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "update",
        objectType: "action_plan",
        objectId: planId,
        payload: { changed: Object.keys(set).filter((k) => k !== "updatedAt") },
      });
      return row;
    },
  );

  app.post(
    "/projects/:projectId/correspondence/action-plans/:planId/activate",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, planId } = req.params as { projectId: string; planId: string };
      const companyId = req.companyId!;
      const plan = await loadPlan(companyId, projectId, planId);
      if (plan.status !== "draft") throw conflict(`${plan.reference} is already ${plan.status}.`);
      const activities = await loadPlanActivities(app.db, companyId, planId);
      if (activities.length === 0) {
        throw badRequest(
          `${plan.reference} has no activities. A plan with nothing to do enforces nothing — add its required activities first.`,
        );
      }
      await app.db
        .update(actionPlans)
        .set({ status: "active", activatedAt: nowISO(), updatedAt: nowISO() })
        .where(eq(actionPlans.id, planId));
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "action_plan",
        objectId: planId,
        payload: { from: "draft", to: "active", activities: activities.length },
      });
      const synced = await syncPlan(app.db, companyId, projectId, planId, req.user!.id, todayISO());
      const [row] = await app.db.select().from(actionPlans).where(eq(actionPlans.id, planId)).limit(1);
      await pushNotifications(
        app.db,
        [plan.ownerId].filter((id): id is string => !!id).map((userId) => ({
          companyId,
          userId,
          projectId,
          kind: "assignment" as const,
          title: `${plan.reference} is now active`,
          body: `${activities.length} required activities on "${plan.title}".`,
          recordType: "action_plan",
          recordId: planId,
        })),
      );
      return { ...row, progress: synced.progress };
    },
  );

  app.post(
    "/projects/:projectId/correspondence/action-plans/:planId/cancel",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, planId } = req.params as { projectId: string; planId: string };
      const body = z.object({ reason: z.string().trim().min(3).max(2000) }).parse(req.body);
      const companyId = req.companyId!;
      const plan = await loadPlan(companyId, projectId, planId);
      if (plan.status === "cancelled") throw conflict(`${plan.reference} is already cancelled.`);
      if (plan.status === "completed") throw conflict(`${plan.reference} is complete and cannot be cancelled.`);
      const [row] = await app.db
        .update(actionPlans)
        .set({ status: "cancelled", cancelledReason: body.reason, updatedAt: nowISO() })
        .where(eq(actionPlans.id, planId))
        .returning();
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "action_plan",
        objectId: planId,
        payload: { from: plan.status, to: "cancelled", reason: body.reason },
      });
      return row;
    },
  );

  /* ---------------------------------------------------------------- */
  /* Activities                                                        */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/correspondence/action-plans/:planId/activities",
    { preHandler: standardGate },
    async (req, reply) => {
      const { projectId, planId } = req.params as { projectId: string; planId: string };
      const body = templateActivitySchema
        .extend({ assigneeId: idSchema.nullable().optional(), dueDate: isoDateSchema.nullable().optional() })
        .parse(req.body);
      const companyId = req.companyId!;
      const plan = await loadPlan(companyId, projectId, planId);
      if (plan.status === "completed" || plan.status === "cancelled") {
        throw conflict(`${plan.reference} is ${plan.status}; no more activities can be added.`);
      }
      if (body.referenceFileIds.length > 0) {
        await assertFiles(app.db, companyId, projectId, body.referenceFileIds);
      }
      if (body.assigneeId) await assertCompanyUser(app.db, companyId, body.assigneeId);
      const [{ maxSeq = 0 } = { maxSeq: 0 }] = await app.db
        .select({ maxSeq: sql<number>`coalesce(max(${actionPlanActivities.seq}), 0)::int` })
        .from(actionPlanActivities)
        .where(eq(actionPlanActivities.planId, planId));
      const activityId = newId("apc");
      const [row] = await app.db
        .insert(actionPlanActivities)
        .values({
          id: activityId,
          companyId,
          projectId,
          planId,
          seq: Number(maxSeq) + 1,
          title: body.title,
          description: body.description ?? null,
          evidenceRequired: body.evidenceRequired ? 1 : 0,
          evidenceRequirement: body.evidenceRequirement ?? null,
          referenceFileIds: body.referenceFileIds,
          isQualityCheckpoint: body.isQualityCheckpoint ? 1 : 0,
          signoffRequiredCount: body.signoffParties.length,
          assigneeId: body.assigneeId ?? null,
          dueDate:
            body.dueDate ??
            (body.dueOffsetDays !== null && body.dueOffsetDays !== undefined && plan.startDate
              ? addDaysISO(plan.startDate, body.dueOffsetDays)
              : null),
        })
        .returning();
      const signoffRows = body.signoffParties.map((party, index) => ({
        id: newId("aps"),
        companyId,
        projectId,
        planId,
        activityId,
        seq: index + 1,
        partyType: party.partyType,
        partyId: party.partyId ?? null,
        label: party.label,
      }));
      if (signoffRows.length > 0) await app.db.insert(actionPlanSignoffs).values(signoffRows);
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "create",
        objectType: "action_plan_activity",
        objectId: activityId,
        payload: { planId, seq: Number(maxSeq) + 1, title: body.title, checkpoint: body.isQualityCheckpoint },
      });
      await syncPlan(app.db, companyId, projectId, planId, req.user!.id, todayISO());
      return reply.code(201).send({ ...row, signoffs: signoffRows });
    },
  );

  app.patch(
    "/projects/:projectId/correspondence/activities/:activityId",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, activityId } = req.params as { projectId: string; activityId: string };
      const body = z
        .object({
          title: z.string().trim().min(1).max(300).optional(),
          description: z.string().max(10_000).nullable().optional(),
          assigneeId: idSchema.nullable().optional(),
          dueDate: isoDateSchema.nullable().optional(),
          evidenceRequirement: z.string().max(2000).nullable().optional(),
        })
        .parse(req.body);
      const companyId = req.companyId!;
      const activity = await loadActivity(companyId, projectId, activityId);
      if (activity.status === "signed_off" || activity.status === "waived") {
        throw conflict(
          `Activity ${activity.seq} is ${activity.status.replace("_", " ")}; editing it would change what was signed.`,
        );
      }
      if (body.assigneeId) await assertCompanyUser(app.db, companyId, body.assigneeId);
      const set = patchSet(body, ["title", "description", "assigneeId", "dueDate", "evidenceRequirement"]);
      const [row] = await app.db
        .update(actionPlanActivities)
        .set(set)
        .where(eq(actionPlanActivities.id, activityId))
        .returning();
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "update",
        objectType: "action_plan_activity",
        objectId: activityId,
        payload: { planId: activity.planId, changed: Object.keys(set).filter((k) => k !== "updatedAt") },
      });
      if (body.assigneeId) {
        await pushNotifications(app.db, [
          {
            companyId,
            userId: body.assigneeId,
            projectId,
            kind: "assignment",
            title: `You were assigned activity ${activity.seq}`,
            body: row?.title ?? activity.title,
            recordType: "action_plan_activity",
            recordId: activityId,
          },
        ]);
      }
      await syncPlan(app.db, companyId, projectId, activity.planId, req.user!.id, todayISO());
      return row;
    },
  );

  app.post(
    "/projects/:projectId/correspondence/activities/:activityId/evidence",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, activityId } = req.params as { projectId: string; activityId: string };
      const body = z
        .object({ fileIds: fileIdsSchema.default([]), note: z.string().max(10_000).nullable().optional() })
        .parse(req.body);
      const companyId = req.companyId!;
      const activity = await loadActivity(companyId, projectId, activityId);
      if (activity.status === "signed_off" || activity.status === "waived") {
        throw conflict(`Activity ${activity.seq} is already closed.`);
      }
      const activities = (await loadPlanActivities(app.db, companyId, activity.planId)).map(toActivityInput);
      const readiness = signoffReadiness(
        { ...toActivityInput(activity), evidenceRequired: false, evidenceFileIds: [] },
        activities,
      );
      // The checkpoint gate applies to doing the work, not only to signing it.
      const gateBlockers = readiness.blockers.filter((b) => b.includes("checkpoint"));
      if (gateBlockers.length > 0) throw conflict(gateBlockers[0]!);
      if (body.fileIds.length > 0) await assertFiles(app.db, companyId, projectId, body.fileIds);
      if (activity.evidenceRequired === 1 && body.fileIds.length === 0) {
        throw badRequest(
          `Activity ${activity.seq} requires evidence: ${activity.evidenceRequirement ?? "attach the record that proves the activity was performed"}.`,
        );
      }
      const merged = [...new Set([...(activity.evidenceFileIds ?? []), ...body.fileIds])];
      const [row] = await app.db
        .update(actionPlanActivities)
        .set({
          evidenceFileIds: merged,
          evidenceNote: body.note ?? activity.evidenceNote,
          evidenceSubmittedAt: nowISO(),
          evidenceSubmittedBy: req.user!.id,
          status: "evidence_submitted",
          updatedAt: nowISO(),
        })
        .where(eq(actionPlanActivities.id, activityId))
        .returning();
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "action_plan_activity",
        objectId: activityId,
        payload: { planId: activity.planId, evidence: merged.length, status: "evidence_submitted" },
      });
      await syncPlan(app.db, companyId, projectId, activity.planId, req.user!.id, todayISO());
      return row;
    },
  );

  app.post(
    "/projects/:projectId/correspondence/activities/:activityId/signoffs/:signoffId/sign",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, activityId, signoffId } = req.params as {
        projectId: string;
        activityId: string;
        signoffId: string;
      };
      const body = z
        .object({
          decision: z.enum(["signed", "rejected"]).default("signed"),
          signerName: z.string().trim().min(1).max(200).optional(),
          note: z.string().max(4000).nullable().optional(),
        })
        .parse(req.body ?? {});
      const companyId = req.companyId!;
      const activity = await loadActivity(companyId, projectId, activityId);
      const [signoff] = await app.db
        .select()
        .from(actionPlanSignoffs)
        .where(
          and(
            eq(actionPlanSignoffs.id, signoffId),
            eq(actionPlanSignoffs.companyId, companyId),
            eq(actionPlanSignoffs.activityId, activityId),
          ),
        )
        .limit(1);
      if (!signoff) throw notFound("Sign-off not found");
      if (signoff.status !== "pending") throw conflict(`This sign-off was already ${signoff.status}.`);
      if (signoff.partyType === "user" && signoff.partyId && signoff.partyId !== req.user!.id) {
        throw forbidden(`This signature belongs to another person (${signoff.label}).`);
      }
      if (signoff.partyType === "vendor" && signoff.partyId) {
        await assertVendor(app.db, companyId, signoff.partyId);
      }

      const activities = (await loadPlanActivities(app.db, companyId, activity.planId)).map(toActivityInput);
      const readiness = signoffReadiness(toActivityInput(activity), activities);
      if (body.decision === "signed" && !readiness.ready) {
        throw conflict(readiness.blockers[0]!);
      }
      // Segregation of duties: where the plan asks more than one party to sign,
      // the person who submitted the evidence cannot be the only signatory.
      if (
        body.decision === "signed" &&
        activity.evidenceSubmittedBy === req.user!.id &&
        activity.signoffRequiredCount > 1 &&
        activity.signoffCount + 1 >= activity.signoffRequiredCount
      ) {
        const others = await app.db
          .select({ signedBy: actionPlanSignoffs.signedBy })
          .from(actionPlanSignoffs)
          .where(
            and(eq(actionPlanSignoffs.activityId, activityId), eq(actionPlanSignoffs.status, "signed")),
          );
        if (others.every((o) => o.signedBy === req.user!.id)) {
          throw forbidden(
            "The person who submitted the evidence cannot be the only signatory on an activity that asks for more than one signature.",
          );
        }
      }

      const now = nowISO();
      const [row] = await app.db
        .update(actionPlanSignoffs)
        .set({
          status: body.decision,
          signedAt: now,
          signedBy: req.user!.id,
          signerName: body.signerName ?? null,
          note: body.note ?? null,
        })
        .where(eq(actionPlanSignoffs.id, signoffId))
        .returning();
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "action_plan_signoff",
        objectId: signoffId,
        payload: { activityId, planId: activity.planId, decision: body.decision, label: signoff.label },
      });

      if (body.decision === "rejected") {
        await app.db
          .update(actionPlanActivities)
          .set({
            status: "blocked",
            blockedReason: `${signoff.label} rejected the sign-off${body.note ? `: ${body.note}` : "."}`,
            updatedAt: now,
          })
          .where(eq(actionPlanActivities.id, activityId));
      } else {
        // Recount from the register rather than incrementing a value read
        // before the write: two people signing at once must not both believe
        // they were the second signature.
        const [{ n = 0 } = { n: 0 }] = await app.db
          .select({ n: sql<number>`count(*)::int` })
          .from(actionPlanSignoffs)
          .where(
            and(eq(actionPlanSignoffs.activityId, activityId), eq(actionPlanSignoffs.status, "signed")),
          );
        const signedCount = Number(n);
        const complete = signoffsSatisfied({
          signoffRequiredCount: activity.signoffRequiredCount,
          signoffCount: signedCount,
        });
        await app.db
          .update(actionPlanActivities)
          .set({
            signoffCount: signedCount,
            status: complete ? "signed_off" : "evidence_submitted",
            completedAt: complete ? now : null,
            blockedReason: null,
            updatedAt: now,
          })
          .where(eq(actionPlanActivities.id, activityId));
        if (complete) {
          await ledger(app.db, {
            companyId,
            projectId,
            actorId: req.user!.id,
            action: "state_change",
            objectType: "action_plan_activity",
            objectId: activityId,
            payload: { planId: activity.planId, to: "signed_off", signatures: signedCount },
          });
        }
      }
      const synced = await syncPlan(app.db, companyId, projectId, activity.planId, req.user!.id, todayISO());
      const [updated] = await app.db
        .select()
        .from(actionPlanActivities)
        .where(eq(actionPlanActivities.id, activityId))
        .limit(1);
      return { signoff: row, activity: updated, progress: synced.progress, planStatus: synced.status };
    },
  );

  app.post(
    "/projects/:projectId/correspondence/activities/:activityId/waive",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, activityId } = req.params as { projectId: string; activityId: string };
      const body = z.object({ reason: z.string().trim().min(3).max(2000) }).parse(req.body);
      const companyId = req.companyId!;
      const activity = await loadActivity(companyId, projectId, activityId);
      if (activity.status === "signed_off" || activity.status === "waived") {
        throw conflict(`Activity ${activity.seq} is already closed.`);
      }
      // A waiver is a decision, not a completion — and never the doer's own.
      if (activity.evidenceSubmittedBy === req.user!.id) {
        throw forbidden(
          "The person who submitted the evidence cannot waive the activity. A waiver is somebody else deciding the requirement no longer applies.",
        );
      }
      const [row] = await app.db
        .update(actionPlanActivities)
        .set({
          status: "waived",
          waivedReason: body.reason,
          completedAt: nowISO(),
          blockedReason: null,
          updatedAt: nowISO(),
        })
        .where(eq(actionPlanActivities.id, activityId))
        .returning();
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "action_plan_activity",
        objectId: activityId,
        payload: { planId: activity.planId, to: "waived", reason: body.reason },
      });
      const synced = await syncPlan(app.db, companyId, projectId, activity.planId, req.user!.id, todayISO());
      return { ...row, progress: synced.progress, planStatus: synced.status };
    },
  );
};
