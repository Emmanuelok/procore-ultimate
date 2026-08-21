import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, isNull, isNotNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { workflowInstances, workflowStepInstances, workflowTemplates } from "@constructos/db";
import { WORKFLOW_INSTANCE_STATUSES, WORKFLOW_STEP_TYPES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { pushNotifications } from "../notifications/service.js";
import { addDaysISO, todayISO } from "../field/dates.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const conditionSchema = z.object({
  field: z.string().min(1).max(100),
  op: z.enum(["eq", "ne", "gt", "lt"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

const stepSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(WORKFLOW_STEP_TYPES),
  assigneeIds: z.array(z.string().min(1)).min(1).max(20),
  parallel: z.boolean().optional(),
  dueInDays: z.number().int().min(0).max(365).optional(),
  condition: conditionSchema.optional(),
});

type StepDef = z.infer<typeof stepSchema>;

const templateCreateSchema = z.object({
  name: z.string().min(1).max(200),
  recordType: z.string().min(1).max(50),
  steps: z.array(stepSchema).min(1).max(50),
  isActive: z.boolean().optional(),
});

const templatePatchSchema = templateCreateSchema.partial();

const startSchema = z.object({
  templateId: z.string().min(1),
  recordType: z.string().min(1).max(50),
  recordId: z.string().min(1),
  context: z.record(z.string(), z.unknown()).optional(),
});

const decideSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  comments: z.string().max(5000).optional(),
});

const delegateSchema = z.object({ toUserId: z.string().min(1) });

const instanceListQuery = pageQuerySchema.extend({
  recordType: z.string().max(50).optional(),
  recordId: z.string().optional(),
  status: z.enum(WORKFLOW_INSTANCE_STATUSES).optional(),
});

/** Reserved context key holding the step-definition snapshot for the run. */
const STEPS_KEY = "__steps";

/* ------------------------------------------------------------------ */
/* Engine helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Group template steps into activation groups: a consecutive run of steps
 * each marked parallel:true forms one group; every other step is a singleton.
 */
function buildGroups(steps: StepDef[]): StepDef[][] {
  const groups: StepDef[][] = [];
  for (const step of steps) {
    const last = groups[groups.length - 1];
    if (step.parallel && last && last[last.length - 1]!.parallel) last.push(step);
    else groups.push([step]);
  }
  return groups;
}

function conditionHolds(
  cond: StepDef["condition"],
  context: Record<string, unknown>,
): boolean {
  if (!cond) return true;
  const actual = context[cond.field];
  switch (cond.op) {
    case "eq":
      return actual === cond.value;
    case "ne":
      return actual !== cond.value;
    case "gt":
      return Number(actual) > Number(cond.value);
    case "lt":
      return Number(actual) < Number(cond.value);
  }
}

function stripContext(context: Record<string, unknown>): Record<string, unknown> {
  const { [STEPS_KEY]: _steps, ...rest } = context;
  return rest;
}

function snapshotSteps(context: Record<string, unknown>): StepDef[] {
  const parsed = z.array(stepSchema).safeParse(context[STEPS_KEY]);
  return parsed.success ? parsed.data : [];
}

type InstanceRow = typeof workflowInstances.$inferSelect;

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

export const workflowModule: FastifyPluginAsync = async (app) => {
  const companyGate = [app.authenticate, app.requireCompany];
  const adminCompanyGate = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin"]),
  ];
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("workflow", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("workflow", "standard"),
  ];
  const adminGate = [app.authenticate, app.requireCompany, app.requireTool("workflow", "admin")];

  async function notifyPendingSteps(
    instance: InstanceRow,
    pending: { id: string; name: string; assigneeId: string }[],
  ) {
    await pushNotifications(
      app.db,
      pending.map((s) => ({
        companyId: instance.companyId,
        userId: s.assigneeId,
        projectId: instance.projectId,
        kind: "workflow_step" as const,
        title: `Workflow step assigned: ${s.name}`,
        body: `${instance.recordType} ${instance.recordId} is waiting on your decision.`,
        recordType: "workflow_step",
        recordId: s.id,
      })),
    );
  }

  /**
   * Materialize groups starting at `fromIdx`. Steps whose condition fails are
   * created pre-skipped; fully-skipped groups auto-advance. Returns the final
   * instance status.
   */
  async function activateFrom(
    instance: InstanceRow,
    groups: StepDef[][],
    fromIdx: number,
  ): Promise<{ status: string; currentPosition: number }> {
    const context = stripContext(instance.context);
    const now = new Date().toISOString();
    for (let g = fromIdx; g < groups.length; g += 1) {
      const created: (typeof workflowStepInstances.$inferInsert)[] = [];
      for (const step of groups[g]!) {
        const skipped = !conditionHolds(step.condition, context);
        for (const assigneeId of step.assigneeIds) {
          created.push({
            id: newId("wfs"),
            instanceId: instance.id,
            position: g,
            name: step.name,
            stepType: step.type,
            assigneeId,
            decision: skipped ? "skipped" : "pending",
            dueDate:
              !skipped && step.dueInDays != null ? addDaysISO(todayISO(), step.dueInDays) : null,
            decidedAt: skipped ? now : null,
          });
        }
      }
      if (created.length > 0) await app.db.insert(workflowStepInstances).values(created);
      await app.db
        .update(workflowInstances)
        .set({ currentPosition: g, updatedAt: now })
        .where(eq(workflowInstances.id, instance.id));
      await appendLedger(app.db, {
        companyId: instance.companyId,
        actorId: instance.startedBy,
        action: "state_change",
        objectType: "workflow_instance",
        objectId: instance.id,
        payload: { event: "group_activated", currentPosition: g },
      });
      const pending = created.filter((c) => c.decision === "pending") as {
        id: string;
        name: string;
        assigneeId: string;
      }[];
      if (pending.length > 0) {
        await notifyPendingSteps(instance, pending);
        return { status: "running", currentPosition: g };
      }
    }
    // Past the last group — everything approved or skipped.
    await completeInstance(instance, "approved", instance.startedBy);
    return { status: "approved", currentPosition: instance.currentPosition };
  }

  async function completeInstance(
    instance: InstanceRow,
    status: "approved" | "rejected" | "cancelled",
    actorId: string,
  ) {
    const now = new Date().toISOString();
    await app.db
      .update(workflowInstances)
      .set({ status, completedAt: now, updatedAt: now })
      .where(eq(workflowInstances.id, instance.id));
    await appendLedger(app.db, {
      companyId: instance.companyId,
      actorId,
      action: "state_change",
      objectType: "workflow_instance",
      objectId: instance.id,
      payload: { from: instance.status, to: status },
    });
    await pushNotifications(app.db, [
      {
        companyId: instance.companyId,
        userId: instance.startedBy,
        projectId: instance.projectId,
        kind: "status_change",
        title: `Workflow ${status}: ${instance.recordType} ${instance.recordId}`,
        recordType: "workflow_instance",
        recordId: instance.id,
      },
    ]);
  }

  function instanceDto(row: InstanceRow) {
    return { ...row, context: stripContext(row.context) };
  }

  async function fetchInstance(instanceId: string, companyId: string): Promise<InstanceRow> {
    const rows = await app.db
      .select()
      .from(workflowInstances)
      .where(and(eq(workflowInstances.id, instanceId), eq(workflowInstances.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Workflow instance not found");
    return rows[0];
  }

  /* ---------------------------------------------------------------- */
  /* Templates — company-wide (spec #79-#82)                           */
  /* ---------------------------------------------------------------- */

  async function createTemplate(
    body: z.infer<typeof templateCreateSchema>,
    companyId: string,
    projectId: string | null,
    actorId: string,
  ) {
    const id = newId("wft");
    const row = {
      id,
      companyId,
      projectId,
      name: body.name,
      recordType: body.recordType,
      version: 1,
      steps: body.steps as unknown[],
      isActive: body.isActive === false ? 0 : 1,
      createdBy: actorId,
    };
    await app.db.insert(workflowTemplates).values(row);
    await appendLedger(app.db, {
      companyId,
      actorId,
      action: "create",
      objectType: "workflow_template",
      objectId: id,
      payload: { name: body.name, recordType: body.recordType, projectId },
    });
    return row;
  }

  async function patchTemplate(
    templateId: string,
    body: z.infer<typeof templatePatchSchema>,
    companyId: string,
    projectId: string | null,
    actorId: string,
  ) {
    const where = projectId
      ? and(
          eq(workflowTemplates.id, templateId),
          eq(workflowTemplates.companyId, companyId),
          eq(workflowTemplates.projectId, projectId),
        )
      : and(
          eq(workflowTemplates.id, templateId),
          eq(workflowTemplates.companyId, companyId),
          isNull(workflowTemplates.projectId),
        );
    const rows = await app.db.select().from(workflowTemplates).where(where).limit(1);
    const existing = rows[0];
    if (!existing) throw notFound("Workflow template not found");
    const set: Record<string, unknown> = {
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
    };
    if (body.name !== undefined) set["name"] = body.name;
    if (body.recordType !== undefined) set["recordType"] = body.recordType;
    if (body.steps !== undefined) set["steps"] = body.steps as unknown[];
    if (body.isActive !== undefined) set["isActive"] = body.isActive ? 1 : 0;
    await app.db.update(workflowTemplates).set(set).where(eq(workflowTemplates.id, templateId));
    await appendLedger(app.db, {
      companyId,
      actorId,
      action: "update",
      objectType: "workflow_template",
      objectId: templateId,
      payload: { changed: Object.keys(body), version: existing.version + 1 },
    });
    const updated = await app.db
      .select()
      .from(workflowTemplates)
      .where(eq(workflowTemplates.id, templateId))
      .limit(1);
    return updated[0];
  }

  async function deactivateTemplate(
    templateId: string,
    companyId: string,
    projectId: string | null,
    actorId: string,
  ) {
    const where = projectId
      ? and(
          eq(workflowTemplates.id, templateId),
          eq(workflowTemplates.companyId, companyId),
          eq(workflowTemplates.projectId, projectId),
        )
      : and(
          eq(workflowTemplates.id, templateId),
          eq(workflowTemplates.companyId, companyId),
          isNull(workflowTemplates.projectId),
        );
    const rows = await app.db.select().from(workflowTemplates).where(where).limit(1);
    if (!rows[0]) throw notFound("Workflow template not found");
    await app.db
      .update(workflowTemplates)
      .set({ isActive: 0, updatedAt: new Date().toISOString() })
      .where(eq(workflowTemplates.id, templateId));
    await appendLedger(app.db, {
      companyId,
      actorId,
      action: "delete",
      objectType: "workflow_template",
      objectId: templateId,
      payload: { deactivated: true },
    });
    return { id: templateId, isActive: 0 };
  }

  app.post("/workflow-templates", { preHandler: adminCompanyGate }, async (req, reply) => {
    const body = templateCreateSchema.parse(req.body);
    const row = await createTemplate(body, req.companyId!, null, req.user!.id);
    return reply.status(201).send(row);
  });

  app.get("/workflow-templates", { preHandler: companyGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ recordType: z.string().max(50).optional() })
      .parse(req.query);
    const where = q.recordType
      ? and(
          eq(workflowTemplates.companyId, req.companyId!),
          isNull(workflowTemplates.projectId),
          eq(workflowTemplates.recordType, q.recordType),
        )
      : and(eq(workflowTemplates.companyId, req.companyId!), isNull(workflowTemplates.projectId));
    const [totalRow] = await app.db.select({ n: count() }).from(workflowTemplates).where(where);
    const items = await app.db
      .select()
      .from(workflowTemplates)
      .where(where)
      .orderBy(desc(workflowTemplates.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/workflow-templates/:templateId", { preHandler: companyGate }, async (req) => {
    const { templateId } = req.params as { templateId: string };
    const rows = await app.db
      .select()
      .from(workflowTemplates)
      .where(
        and(
          eq(workflowTemplates.id, templateId),
          eq(workflowTemplates.companyId, req.companyId!),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Workflow template not found");
    return rows[0];
  });

  app.patch("/workflow-templates/:templateId", { preHandler: adminCompanyGate }, async (req) => {
    const { templateId } = req.params as { templateId: string };
    const body = templatePatchSchema.parse(req.body);
    return patchTemplate(templateId, body, req.companyId!, null, req.user!.id);
  });

  app.delete("/workflow-templates/:templateId", { preHandler: adminCompanyGate }, async (req) => {
    const { templateId } = req.params as { templateId: string };
    return deactivateTemplate(templateId, req.companyId!, null, req.user!.id);
  });

  /* ---------------------------------------------------------------- */
  /* Templates — project-scoped                                        */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/workflow-templates",
    { preHandler: adminGate },
    async (req, reply) => {
      const body = templateCreateSchema.parse(req.body);
      const row = await createTemplate(body, req.companyId!, req.projectId!, req.user!.id);
      return reply.status(201).send(row);
    },
  );

  app.get("/projects/:projectId/workflow-templates", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ recordType: z.string().max(50).optional() })
      .parse(req.query);
    const scope = and(
      eq(workflowTemplates.companyId, req.companyId!),
      or(
        eq(workflowTemplates.projectId, req.projectId!),
        isNull(workflowTemplates.projectId),
      ),
    );
    const where = q.recordType
      ? and(scope, eq(workflowTemplates.recordType, q.recordType))
      : scope;
    const [totalRow] = await app.db.select({ n: count() }).from(workflowTemplates).where(where);
    const items = await app.db
      .select()
      .from(workflowTemplates)
      .where(where)
      .orderBy(desc(workflowTemplates.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get(
    "/projects/:projectId/workflow-templates/:templateId",
    { preHandler: readGate },
    async (req) => {
      const { templateId } = req.params as { templateId: string };
      const rows = await app.db
        .select()
        .from(workflowTemplates)
        .where(
          and(
            eq(workflowTemplates.id, templateId),
            eq(workflowTemplates.companyId, req.companyId!),
            or(
              eq(workflowTemplates.projectId, req.projectId!),
              isNull(workflowTemplates.projectId),
            ),
          ),
        )
        .limit(1);
      if (!rows[0]) throw notFound("Workflow template not found");
      return rows[0];
    },
  );

  app.patch(
    "/projects/:projectId/workflow-templates/:templateId",
    { preHandler: adminGate },
    async (req) => {
      const { templateId } = req.params as { templateId: string };
      const body = templatePatchSchema.parse(req.body);
      return patchTemplate(templateId, body, req.companyId!, req.projectId!, req.user!.id);
    },
  );

  app.delete(
    "/projects/:projectId/workflow-templates/:templateId",
    { preHandler: adminGate },
    async (req) => {
      const { templateId } = req.params as { templateId: string };
      return deactivateTemplate(templateId, req.companyId!, req.projectId!, req.user!.id);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Instances (spec #83-#92)                                          */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/workflows/start",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = startSchema.parse(req.body);
      const tplRows = await app.db
        .select()
        .from(workflowTemplates)
        .where(
          and(
            eq(workflowTemplates.id, body.templateId),
            eq(workflowTemplates.companyId, req.companyId!),
            or(
              eq(workflowTemplates.projectId, req.projectId!),
              isNull(workflowTemplates.projectId),
            ),
          ),
        )
        .limit(1);
      const tpl = tplRows[0];
      if (!tpl) throw notFound("Workflow template not found");
      if (!tpl.isActive) throw badRequest("Workflow template is inactive");
      const steps = z.array(stepSchema).min(1).parse(tpl.steps);
      const groups = buildGroups(steps);

      const instanceId = newId("wfi");
      const context = { ...(body.context ?? {}), [STEPS_KEY]: steps };
      const row: typeof workflowInstances.$inferInsert = {
        id: instanceId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        templateId: tpl.id,
        templateVersion: tpl.version,
        recordType: body.recordType,
        recordId: body.recordId,
        status: "running",
        currentPosition: 0,
        context,
        startedBy: req.user!.id,
      };
      await app.db.insert(workflowInstances).values(row);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "workflow_instance",
        objectId: instanceId,
        payload: {
          templateId: tpl.id,
          templateVersion: tpl.version,
          recordType: body.recordType,
          recordId: body.recordId,
        },
      });

      const instance = await fetchInstance(instanceId, req.companyId!);
      const result = await activateFrom(instance, groups, 0);
      const finalInstance = await fetchInstance(instanceId, req.companyId!);
      const stepRows = await app.db
        .select()
        .from(workflowStepInstances)
        .where(eq(workflowStepInstances.instanceId, instanceId))
        .orderBy(asc(workflowStepInstances.position), asc(workflowStepInstances.createdAt));
      return reply
        .status(201)
        .send({ ...instanceDto(finalInstance), status: result.status, steps: stepRows });
    },
  );

  app.get("/projects/:projectId/workflows", { preHandler: readGate }, async (req) => {
    const q = instanceListQuery.parse(req.query);
    const clauses = [
      eq(workflowInstances.companyId, req.companyId!),
      eq(workflowInstances.projectId, req.projectId!),
    ];
    if (q.recordType) clauses.push(eq(workflowInstances.recordType, q.recordType));
    if (q.recordId) clauses.push(eq(workflowInstances.recordId, q.recordId));
    if (q.status) clauses.push(eq(workflowInstances.status, q.status));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(workflowInstances).where(where);
    const items = await app.db
      .select()
      .from(workflowInstances)
      .where(where)
      .orderBy(desc(workflowInstances.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const ids = items.map((i) => i.id);
    const steps = ids.length
      ? await app.db
          .select()
          .from(workflowStepInstances)
          .where(inArray(workflowStepInstances.instanceId, ids))
          .orderBy(asc(workflowStepInstances.position), asc(workflowStepInstances.createdAt))
      : [];
    const byInstance = new Map<string, typeof steps>();
    for (const s of steps) {
      const list = byInstance.get(s.instanceId) ?? [];
      list.push(s);
      byInstance.set(s.instanceId, list);
    }
    return paginate(
      items.map((i) => ({ ...instanceDto(i), steps: byInstance.get(i.id) ?? [] })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.get("/projects/:projectId/workflows/overdue", { preHandler: readGate }, async (req) => {
    const today = todayISO();
    const rows = await app.db
      .select({ step: workflowStepInstances, instance: workflowInstances })
      .from(workflowStepInstances)
      .innerJoin(
        workflowInstances,
        eq(workflowInstances.id, workflowStepInstances.instanceId),
      )
      .where(
        and(
          eq(workflowInstances.companyId, req.companyId!),
          eq(workflowInstances.projectId, req.projectId!),
          eq(workflowInstances.status, "running"),
          eq(workflowStepInstances.decision, "pending"),
          isNotNull(workflowStepInstances.dueDate),
          lt(workflowStepInstances.dueDate, today),
        ),
      )
      .orderBy(asc(workflowStepInstances.dueDate));
    return {
      items: rows.map((r) => ({
        ...r.step,
        instance: {
          id: r.instance.id,
          recordType: r.instance.recordType,
          recordId: r.instance.recordId,
          status: r.instance.status,
        },
      })),
    };
  });

  app.get("/workflows/:instanceId", { preHandler: companyGate }, async (req) => {
    const { instanceId } = req.params as { instanceId: string };
    const instance = await fetchInstance(instanceId, req.companyId!);
    const steps = await app.db
      .select()
      .from(workflowStepInstances)
      .where(eq(workflowStepInstances.instanceId, instanceId))
      .orderBy(asc(workflowStepInstances.position), asc(workflowStepInstances.createdAt));
    return { ...instanceDto(instance), steps };
  });

  app.get("/me/workflow-inbox", { preHandler: companyGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const uid = req.user!.id;
    const where = and(
      eq(workflowInstances.companyId, req.companyId!),
      eq(workflowInstances.status, "running"),
      eq(workflowStepInstances.decision, "pending"),
      eq(workflowStepInstances.position, workflowInstances.currentPosition),
      or(
        eq(workflowStepInstances.assigneeId, uid),
        eq(workflowStepInstances.delegatedToId, uid),
      ),
    );
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(workflowStepInstances)
      .innerJoin(workflowInstances, eq(workflowInstances.id, workflowStepInstances.instanceId))
      .where(where);
    const rows = await app.db
      .select({ step: workflowStepInstances, instance: workflowInstances })
      .from(workflowStepInstances)
      .innerJoin(workflowInstances, eq(workflowInstances.id, workflowStepInstances.instanceId))
      .where(where)
      .orderBy(asc(workflowStepInstances.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      rows.map((r) => ({
        ...r.step,
        instance: {
          id: r.instance.id,
          projectId: r.instance.projectId,
          recordType: r.instance.recordType,
          recordId: r.instance.recordId,
          startedBy: r.instance.startedBy,
        },
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  /* ---------------------------------------------------------------- */
  /* Step decisions                                                    */
  /* ---------------------------------------------------------------- */

  async function loadStepAndInstance(stepInstanceId: string, companyId: string) {
    const stepRows = await app.db
      .select()
      .from(workflowStepInstances)
      .where(eq(workflowStepInstances.id, stepInstanceId))
      .limit(1);
    const step = stepRows[0];
    if (!step) throw notFound("Workflow step not found");
    const instRows = await app.db
      .select()
      .from(workflowInstances)
      .where(
        and(eq(workflowInstances.id, step.instanceId), eq(workflowInstances.companyId, companyId)),
      )
      .limit(1);
    const instance = instRows[0];
    if (!instance) throw notFound("Workflow step not found");
    return { step, instance };
  }

  app.post(
    "/workflow-steps/:stepInstanceId/decide",
    { preHandler: companyGate },
    async (req) => {
      const { stepInstanceId } = req.params as { stepInstanceId: string };
      const body = decideSchema.parse(req.body);
      const { step, instance } = await loadStepAndInstance(stepInstanceId, req.companyId!);
      if (instance.status !== "running") throw badRequest("Workflow is not running");
      if (step.decision !== "pending") throw conflict("Step has already been decided");
      if (step.position !== instance.currentPosition) {
        throw badRequest("Step is not in the active group");
      }
      const uid = req.user!.id;
      if (uid !== step.assigneeId && uid !== step.delegatedToId) {
        throw forbidden("Only the step assignee or their delegate may decide");
      }

      const now = new Date().toISOString();
      await app.db
        .update(workflowStepInstances)
        .set({ decision: body.decision, comments: body.comments ?? null, decidedAt: now })
        .where(eq(workflowStepInstances.id, step.id));
      await appendLedger(app.db, {
        companyId: instance.companyId,
        actorId: uid,
        action: "state_change",
        objectType: "workflow_step",
        objectId: step.id,
        payload: { decision: body.decision, instanceId: instance.id, position: step.position },
      });

      if (body.decision === "rejected") {
        await completeInstance(instance, "rejected", uid);
        return { stepId: step.id, decision: "rejected", instanceStatus: "rejected" };
      }

      // Approved — advance only once every step in the active group is decided.
      const [pendingRow] = await app.db
        .select({ n: count() })
        .from(workflowStepInstances)
        .where(
          and(
            eq(workflowStepInstances.instanceId, instance.id),
            eq(workflowStepInstances.position, instance.currentPosition),
            eq(workflowStepInstances.decision, "pending"),
          ),
        );
      if (Number(pendingRow?.n ?? 0) > 0) {
        return { stepId: step.id, decision: "approved", instanceStatus: "running" };
      }

      const steps = snapshotSteps(instance.context);
      const groups = buildGroups(steps);
      const result = await activateFrom(instance, groups, instance.currentPosition + 1);
      return { stepId: step.id, decision: "approved", instanceStatus: result.status };
    },
  );

  app.post(
    "/workflow-steps/:stepInstanceId/delegate",
    { preHandler: companyGate },
    async (req) => {
      const { stepInstanceId } = req.params as { stepInstanceId: string };
      const body = delegateSchema.parse(req.body);
      const { step, instance } = await loadStepAndInstance(stepInstanceId, req.companyId!);
      if (instance.status !== "running") throw badRequest("Workflow is not running");
      if (step.decision !== "pending") throw conflict("Step has already been decided");
      if (req.user!.id !== step.assigneeId) {
        throw forbidden("Only the step assignee may delegate");
      }
      await app.db
        .update(workflowStepInstances)
        .set({ delegatedToId: body.toUserId })
        .where(eq(workflowStepInstances.id, step.id));
      await appendLedger(app.db, {
        companyId: instance.companyId,
        actorId: req.user!.id,
        action: "update",
        objectType: "workflow_step",
        objectId: step.id,
        payload: { delegatedToId: body.toUserId },
      });
      await pushNotifications(app.db, [
        {
          companyId: instance.companyId,
          userId: body.toUserId,
          projectId: instance.projectId,
          kind: "workflow_step",
          title: `Workflow step delegated to you: ${step.name}`,
          body: `${instance.recordType} ${instance.recordId} is waiting on your decision.`,
          recordType: "workflow_step",
          recordId: step.id,
        },
      ]);
      return { stepId: step.id, delegatedToId: body.toUserId };
    },
  );
};
