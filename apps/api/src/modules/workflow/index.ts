/**
 * Configurable approval workflow (Vol I §0.4 #79–#92).
 *
 * WHAT THIS MODULE IS
 * A template describes an ordered chain of approval steps; an instance runs
 * that chain against one record. This file owns the routes and the database
 * work; engine.ts owns every decision (grouping, conditions, quorum, dates,
 * the graph payload) and context.ts owns resolving the record's own fields so
 * a condition cannot be answered by the caller.
 *
 * WHAT CHANGED IN THIS WAVE, AND WHY
 *  • `decide` is now ONE transaction that locks the instance row and updates
 *    the step with a `decision = 'pending'` predicate. Before, two concurrent
 *    approvals of the last two steps of a parallel group both observed
 *    "nothing pending" and both activated the next group — duplicate step
 *    rows, duplicate notifications, and two 'approved' transitions on one
 *    instance.
 *  • an unreadable step snapshot BLOCKS the instance instead of approving it.
 *  • a condition that cannot be evaluated creates the step pending (#82),
 *    rather than pre-skipping the approval the caller forgot to feed.
 *  • steps may name a role or a distribution group (#83), resolved against
 *    the project's memberships at activation.
 *  • cancel, reassign, remind and "apply this template version to running
 *    instances" (#90) exist, so a chain can be recovered instead of being
 *    stuck for ever.
 *  • reading an instance requires the `workflow` tool on the instance's
 *    project, not merely company membership.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not decide whether a record is ALLOWED to move on without a
 * workflow — the owning module does that. It exposes the "is a workflow
 * mandatory here" answer (#788) for those modules to consult.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  isNotNull,
  lt,
  lte,
  ne,
  or,
} from "drizzle-orm";
import { z } from "zod";
import {
  companyMemberships,
  distributionGroupMembers,
  distributionGroups,
  permissionTemplates,
  projectMemberships,
  projects,
  workflowInstances,
  workflowStepInstances,
  workflowTemplates,
} from "@constructos/db";
import {
  WORKFLOW_INSTANCE_STATES,
  type WorkflowInstanceState,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { forEachCompany } from "../../lib/scheduler.js";
import type { Db } from "../../lib/db.js";
import { pushNotifications } from "../notifications/service.js";
import { todayISO } from "../field/dates.js";
import { loadProjectAccess, canUseTool } from "../projects/access.js";
import {
  buildGraph,
  buildGroups,
  planGroup,
  stepDates,
  stepsSchema,
  unresolvedConditionFields,
  type PlannedStep,
  type StepDef,
} from "./engine.js";
import { resolveWorkflowContext, resolvableRecordTypes } from "./context.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const templateCreateSchema = z.object({
  name: z.string().min(1).max(200),
  recordType: z.string().min(1).max(50),
  steps: stepsSchema,
  isActive: z.boolean().optional(),
  /** #788 — a mandatory template must be started before the record advances */
  isMandatory: z.boolean().optional(),
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
const reassignSchema = z.object({
  toUserId: z.string().min(1),
  reason: z.string().max(1000).optional(),
});
const cancelSchema = z.object({ reason: z.string().min(1).max(1000) });

const instanceListQuery = pageQuerySchema.extend({
  recordType: z.string().max(50).optional(),
  recordId: z.string().optional(),
  status: z.enum(WORKFLOW_INSTANCE_STATES).optional(),
});

/** Reserved context key holding the step-definition snapshot for the run. */
const STEPS_KEY = "__steps";
/** Reserved context key recording which fields the server resolved. */
const PROVENANCE_KEY = "__provenance";

const ESCALATION_JOB = "workflow.escalations";

type InstanceRow = typeof workflowInstances.$inferSelect;
type StepRow = typeof workflowStepInstances.$inferSelect;

function stripContext(context: Record<string, unknown>): Record<string, unknown> {
  const { [STEPS_KEY]: _steps, [PROVENANCE_KEY]: _prov, ...rest } = context;
  return rest;
}

/**
 * Read the step snapshot captured at start.
 *
 * Returns `null` — never `[]` — when the snapshot cannot be parsed. The old
 * code returned an empty array here, and an empty array of groups meant "no
 * work left", which approved the whole instance.
 */
function snapshotSteps(context: Record<string, unknown>): StepDef[] | null {
  const parsed = stepsSchema.safeParse(context[STEPS_KEY]);
  return parsed.success ? parsed.data : null;
}

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

  /* ---------------------------------------------------------------- */
  /* Authorisation helpers                                             */
  /* ---------------------------------------------------------------- */

  /** Is this user named on the run — as its starter, an assignee or a delegate? */
  async function isInstanceParticipant(instanceId: string, userId: string, startedBy: string) {
    if (userId === startedBy) return true;
    const rows = await app.db
      .select({ id: workflowStepInstances.id })
      .from(workflowStepInstances)
      .where(
        and(
          eq(workflowStepInstances.instanceId, instanceId),
          or(
            eq(workflowStepInstances.assigneeId, userId),
            eq(workflowStepInstances.delegatedToId, userId),
          ),
        ),
      )
      .limit(1);
    return Boolean(rows[0]);
  }

  /**
   * An instance is addressed by its own id, so the tool gate cannot resolve
   * the project from the URL. Resolve it from the row instead — company
   * membership alone let a guest read every instance's context (which callers
   * populate with fields such as `cost`) and every decision on it.
   *
   * `allowParticipant` is the deliberate exception: an approver named on the
   * chain must be able to see and act on the step assigned to them even when
   * they hold no membership on the project (an external reviewer, a finance
   * approver who works across projects). Being named on the run IS the
   * authorisation, and it is bounded to that one run.
   */
  async function requireInstanceAccess(
    req: FastifyRequest,
    instance: InstanceRow,
    level: "read" | "standard" | "admin",
    options: { allowParticipant?: boolean } = {},
  ): Promise<void> {
    const access = await loadProjectAccess(app, req);
    if (canUseTool(access, instance.projectId, "workflow", level)) return;
    if (
      options.allowParticipant &&
      (await isInstanceParticipant(instance.id, req.user!.id, instance.startedBy))
    ) {
      return;
    }
    throw forbidden(`Requires ${level} access to workflow on this project`);
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

  async function assertCompanyMembers(companyId: string, userIds: string[], label: string) {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return;
    const rows = await app.db
      .select({ userId: companyMemberships.userId })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          inArray(companyMemberships.userId, unique),
        ),
      );
    const known = new Set(rows.map((r) => r.userId));
    const missing = unique.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw badRequest(`${label} are not members of this company: ${missing.join(", ")}`);
    }
  }

  /** Validate that every explicit assignee on a template is a company member. */
  async function validateTemplateSteps(companyId: string, steps: StepDef[]) {
    const ids = steps.flatMap((s) => s.assigneeIds ?? []);
    await assertCompanyMembers(companyId, ids, "Step assignees");
    const roleKeys = [...new Set(steps.map((s) => s.role).filter((r): r is string => Boolean(r)))];
    if (roleKeys.length > 0) {
      const rows = await app.db
        .select({ key: permissionTemplates.key })
        .from(permissionTemplates)
        .where(eq(permissionTemplates.companyId, companyId));
      const known = new Set(rows.map((r) => r.key));
      const missing = roleKeys.filter((k) => !known.has(k));
      if (missing.length > 0) {
        throw badRequest(`Unknown permission template key(s): ${missing.join(", ")}`);
      }
    }
    const groupIds = [
      ...new Set(steps.map((s) => s.groupId).filter((g): g is string => Boolean(g))),
    ];
    if (groupIds.length > 0) {
      const rows = await app.db
        .select({ id: distributionGroups.id })
        .from(distributionGroups)
        .where(
          and(
            eq(distributionGroups.companyId, companyId),
            inArray(distributionGroups.id, groupIds),
          ),
        );
      const known = new Set(rows.map((r) => r.id));
      const missing = groupIds.filter((g) => !known.has(g));
      if (missing.length > 0) {
        throw badRequest(`Unknown distribution group(s): ${missing.join(", ")}`);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Assignee resolution (#83)                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Turn each step's declared audience into concrete user ids, at the moment
   * the group activates. Explicit ids are filtered to live company members —
   * a template naming someone who has since left must not produce a step
   * nobody can decide.
   */
  async function buildAssigneeResolver(
    companyId: string,
    projectId: string,
    steps: StepDef[],
  ): Promise<(step: StepDef) => { ids: string[]; reason?: string }> {
    const explicit = [...new Set(steps.flatMap((s) => s.assigneeIds ?? []))];
    const members = new Set<string>();
    if (explicit.length > 0) {
      const rows = await app.db
        .select({ userId: companyMemberships.userId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            inArray(companyMemberships.userId, explicit),
          ),
        );
      for (const r of rows) members.add(r.userId);
    }

    const roleKeys = [...new Set(steps.map((s) => s.role).filter((r): r is string => Boolean(r)))];
    const byRole = new Map<string, string[]>();
    if (roleKeys.length > 0) {
      const rows = await app.db
        .select({ userId: projectMemberships.userId, templateKey: projectMemberships.templateKey })
        .from(projectMemberships)
        .where(
          and(
            eq(projectMemberships.companyId, companyId),
            eq(projectMemberships.projectId, projectId),
            inArray(projectMemberships.templateKey, roleKeys),
          ),
        );
      for (const r of rows) {
        const list = byRole.get(r.templateKey) ?? [];
        list.push(r.userId);
        byRole.set(r.templateKey, list);
      }
    }

    const groupIds = [
      ...new Set(steps.map((s) => s.groupId).filter((g): g is string => Boolean(g))),
    ];
    const byGroup = new Map<string, string[]>();
    if (groupIds.length > 0) {
      const rows = await app.db
        .select({ groupId: distributionGroupMembers.groupId, userId: distributionGroupMembers.userId })
        .from(distributionGroupMembers)
        .innerJoin(distributionGroups, eq(distributionGroups.id, distributionGroupMembers.groupId))
        .where(
          and(
            eq(distributionGroups.companyId, companyId),
            inArray(distributionGroupMembers.groupId, groupIds),
          ),
        );
      for (const r of rows) {
        if (!r.userId) continue;
        const list = byGroup.get(r.groupId) ?? [];
        list.push(r.userId);
        byGroup.set(r.groupId, list);
      }
    }

    return (step) => {
      if (step.role) {
        const ids = byRole.get(step.role) ?? [];
        return ids.length > 0
          ? { ids: [...new Set(ids)] }
          : { ids: [], reason: `no project member holds the role "${step.role}"` };
      }
      if (step.groupId) {
        const ids = byGroup.get(step.groupId) ?? [];
        return ids.length > 0
          ? { ids: [...new Set(ids)] }
          : { ids: [], reason: `distribution group ${step.groupId} has no platform users` };
      }
      const ids = (step.assigneeIds ?? []).filter((id) => members.has(id));
      return ids.length > 0
        ? { ids }
        : { ids: [], reason: "no named assignee is still a member of this company" };
    };
  }

  /* ---------------------------------------------------------------- */
  /* Notifications                                                     */
  /* ---------------------------------------------------------------- */

  async function notifyPendingSteps(
    instance: InstanceRow,
    pending: Array<{ id: string; name: string; assigneeId: string }>,
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

  /* ---------------------------------------------------------------- */
  /* Activation                                                        */
  /* ---------------------------------------------------------------- */

  interface ActivationResult {
    status: WorkflowInstanceState;
    currentPosition: number;
    blockedReason?: string;
    unresolvable: Array<{ step: string; reason: string }>;
  }

  /**
   * Materialise groups from `fromIdx` onwards until one has a pending step.
   *
   * Runs inside the caller's transaction so the whole advance — the step rows,
   * the instance position and the completion — is one atomic move.
   */
  async function activateFrom(
    tx: Db,
    instance: InstanceRow,
    groups: StepDef[][],
    fromIdx: number,
    actorId: string,
    resolve: (step: StepDef) => { ids: string[]; reason?: string },
  ): Promise<ActivationResult> {
    const context = stripContext(instance.context);
    const now = new Date().toISOString();
    const today = todayISO();
    const unresolvable: Array<{ step: string; reason: string }> = [];

    for (let g = fromIdx; g < groups.length; g += 1) {
      const { plan, unresolvable: bad } = planGroup(groups[g]!, g, context, resolve);
      unresolvable.push(...bad);

      if (bad.length > 0) {
        // Fail closed: an approval whose approver cannot be resolved must not
        // simply disappear from the chain.
        await tx
          .update(workflowInstances)
          .set({
            status: "blocked",
            blockedReason: bad.map((b) => `${b.step}: ${b.reason}`).join("; ").slice(0, 900),
            currentPosition: g,
            updatedAt: now,
          })
          .where(eq(workflowInstances.id, instance.id));
        return {
          status: "blocked",
          currentPosition: g,
          blockedReason: bad[0]!.reason,
          unresolvable,
        };
      }

      const rows = plan.steps.map((s: PlannedStep) => {
        const dates = stepDates(today, {
          dueInDays: s.dueInDays,
          escalateAfterDays: s.escalateAfterDays,
        });
        return {
          id: newId("wfs"),
          instanceId: instance.id,
          position: g,
          name: s.name,
          stepType: s.stepType,
          assigneeId: s.assigneeId,
          assignedVia: s.assignedVia,
          assignedViaKey: s.assignedViaKey,
          quorum: s.quorum,
          decision: s.skipped ? "skipped" : "pending",
          dueDate: s.skipped ? null : dates.dueDate,
          escalateAt: s.skipped ? null : dates.escalateAt,
          decidedAt: s.skipped ? now : null,
        } satisfies typeof workflowStepInstances.$inferInsert;
      });

      if (rows.length > 0) await tx.insert(workflowStepInstances).values(rows);
      await tx
        .update(workflowInstances)
        .set({ currentPosition: g, updatedAt: now })
        .where(eq(workflowInstances.id, instance.id));

      const pending = rows.filter((r) => r.decision === "pending");
      if (pending.length > 0) {
        return { status: "running", currentPosition: g, unresolvable };
      }
    }

    // Past the last group — everything approved or skipped.
    await tx
      .update(workflowInstances)
      .set({ status: "approved", completedAt: now, updatedAt: now })
      .where(eq(workflowInstances.id, instance.id));
    return { status: "approved", currentPosition: groups.length - 1, unresolvable };
  }

  /** Ledger + notify for an activation that already committed. */
  async function announceActivation(
    instance: InstanceRow,
    result: ActivationResult,
    actorId: string,
  ) {
    if (result.status === "blocked") {
      await appendLedger(app.db, {
        companyId: instance.companyId,
        actorId,
        action: "state_change",
        objectType: "workflow_instance",
        objectId: instance.id,
        payload: { event: "blocked", reason: result.blockedReason, position: result.currentPosition },
        projectId: instance.projectId,
      });
      await pushNotifications(app.db, [
        {
          companyId: instance.companyId,
          userId: instance.startedBy,
          projectId: instance.projectId,
          kind: "workflow_step",
          title: `Workflow blocked: ${instance.recordType} ${instance.recordId}`,
          body: result.blockedReason ?? "The next approval step could not be assigned.",
          recordType: "workflow_instance",
          recordId: instance.id,
        },
      ]);
      return;
    }
    await appendLedger(app.db, {
      companyId: instance.companyId,
      actorId,
      action: "state_change",
      objectType: "workflow_instance",
      objectId: instance.id,
      payload: { event: "group_activated", currentPosition: result.currentPosition },
      projectId: instance.projectId,
    });
    if (result.status === "approved") {
      await appendLedger(app.db, {
        companyId: instance.companyId,
        actorId,
        action: "state_change",
        objectType: "workflow_instance",
        objectId: instance.id,
        payload: { from: "running", to: "approved" },
        projectId: instance.projectId,
      });
      await pushNotifications(app.db, [
        {
          companyId: instance.companyId,
          userId: instance.startedBy,
          projectId: instance.projectId,
          kind: "status_change",
          title: `Workflow approved: ${instance.recordType} ${instance.recordId}`,
          recordType: "workflow_instance",
          recordId: instance.id,
        },
      ]);
      return;
    }
    const pending = await app.db
      .select({
        id: workflowStepInstances.id,
        name: workflowStepInstances.name,
        assigneeId: workflowStepInstances.assigneeId,
      })
      .from(workflowStepInstances)
      .where(
        and(
          eq(workflowStepInstances.instanceId, instance.id),
          eq(workflowStepInstances.position, result.currentPosition),
          eq(workflowStepInstances.decision, "pending"),
        ),
      );
    if (pending.length > 0) await notifyPendingSteps(instance, pending);
  }

  function instanceDto(row: InstanceRow) {
    return { ...row, context: stripContext(row.context) };
  }

  /* ---------------------------------------------------------------- */
  /* Templates (#79–#82, #89)                                          */
  /* ---------------------------------------------------------------- */

  async function createTemplate(
    body: z.infer<typeof templateCreateSchema>,
    companyId: string,
    projectId: string | null,
    actorId: string,
  ) {
    await validateTemplateSteps(companyId, body.steps);
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
      payload: { name: body.name, recordType: body.recordType, projectId, mandatory: body.isMandatory === true },
      projectId,
    });
    return { ...row, isMandatory: body.isMandatory === true };
  }

  function templateWhere(templateId: string, companyId: string, projectId: string | null) {
    return projectId
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
  }

  async function patchTemplate(
    templateId: string,
    body: z.infer<typeof templatePatchSchema>,
    companyId: string,
    projectId: string | null,
    actorId: string,
  ) {
    const rows = await app.db
      .select()
      .from(workflowTemplates)
      .where(templateWhere(templateId, companyId, projectId))
      .limit(1);
    const existing = rows[0];
    if (!existing) throw notFound("Workflow template not found");
    if (body.steps) await validateTemplateSteps(companyId, body.steps);
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
      projectId,
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
    const rows = await app.db
      .select()
      .from(workflowTemplates)
      .where(templateWhere(templateId, companyId, projectId))
      .limit(1);
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
      projectId,
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
    const tpl = rows[0];
    if (!tpl) throw notFound("Workflow template not found");
    // A project-scoped template is readable only by someone who can read that
    // project's workflow tool.
    if (tpl.projectId) {
      const access = await loadProjectAccess(app, req);
      if (!canUseTool(access, tpl.projectId, "workflow", "read")) {
        throw forbidden("Requires read access to workflow on this project");
      }
    }
    return tpl;
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

  /** What a template designer may pick from: fields the server can resolve. */
  app.get("/workflow-templates/meta/context-fields", { preHandler: companyGate }, async () => ({
    recordTypes: resolvableRecordTypes(),
    note: "Conditions on these record types are evaluated against the stored record, not the caller's payload.",
  }));

  /* -------------------- Project-scoped templates -------------------- */

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
      or(eq(workflowTemplates.projectId, req.projectId!), isNull(workflowTemplates.projectId)),
    );
    const where = q.recordType ? and(scope, eq(workflowTemplates.recordType, q.recordType)) : scope;
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
            or(eq(workflowTemplates.projectId, req.projectId!), isNull(workflowTemplates.projectId)),
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
  /* Start (#83, #90)                                                  */
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
            or(eq(workflowTemplates.projectId, req.projectId!), isNull(workflowTemplates.projectId)),
          ),
        )
        .limit(1);
      const tpl = tplRows[0];
      if (!tpl) throw notFound("Workflow template not found");
      if (!tpl.isActive) throw badRequest("Workflow template is inactive");
      const steps = stepsSchema.parse(tpl.steps);
      const groups = buildGroups(steps);

      // Idempotent start: a double click must not open a second approval
      // chain on one record.
      const live = await app.db
        .select()
        .from(workflowInstances)
        .where(
          and(
            eq(workflowInstances.companyId, req.companyId!),
            eq(workflowInstances.projectId, req.projectId!),
            eq(workflowInstances.recordType, body.recordType),
            eq(workflowInstances.recordId, body.recordId),
            inArray(workflowInstances.status, ["running", "blocked"]),
          ),
        )
        .limit(1);
      if (live[0]) {
        const stepRows = await app.db
          .select()
          .from(workflowStepInstances)
          .where(eq(workflowStepInstances.instanceId, live[0].id))
          .orderBy(asc(workflowStepInstances.position), asc(workflowStepInstances.createdAt));
        return reply
          .status(200)
          .send({ ...instanceDto(live[0]), steps: stepRows, alreadyRunning: true });
      }

      // Conditions branch on the RECORD, not on what the caller says about it.
      const resolved = await resolveWorkflowContext(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        recordType: body.recordType,
        recordId: body.recordId,
        clientContext: body.context ?? {},
      });
      const unresolvedFields = unresolvedConditionFields(steps, resolved.context);

      const instanceId = newId("wfi");
      const context = {
        ...resolved.context,
        [STEPS_KEY]: steps,
        [PROVENANCE_KEY]: {
          recordResolved: resolved.recordResolved,
          serverResolved: resolved.serverResolved,
          clientSupplied: resolved.clientSupplied,
        },
      };
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

      const resolveAssignees = await buildAssigneeResolver(
        req.companyId!,
        req.projectId!,
        steps,
      );

      const outcome = await app.db.transaction(async (tx) => {
        await tx.insert(workflowInstances).values(row);
        const inserted = (
          await tx.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId)).limit(1)
        )[0]!;
        return activateFrom(tx as Db, inserted, groups, 0, req.user!.id, resolveAssignees);
      });

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
          serverResolved: resolved.serverResolved,
        },
        projectId: req.projectId!,
      });
      const finalInstance = await fetchInstance(instanceId, req.companyId!);
      await announceActivation(finalInstance, outcome, req.user!.id);

      const stepRows = await app.db
        .select()
        .from(workflowStepInstances)
        .where(eq(workflowStepInstances.instanceId, instanceId))
        .orderBy(asc(workflowStepInstances.position), asc(workflowStepInstances.createdAt));
      return reply.status(201).send({
        ...instanceDto(finalInstance),
        steps: stepRows,
        provenance: {
          recordResolved: resolved.recordResolved,
          serverResolved: resolved.serverResolved,
          clientSupplied: resolved.clientSupplied,
        },
        // Honesty: a condition that could not be evaluated did NOT skip its
        // step. Say so rather than letting the caller believe it did.
        unresolvedConditionFields: unresolvedFields,
      });
    },
  );

  /* ---------------------------------------------------------------- */
  /* Reading                                                           */
  /* ---------------------------------------------------------------- */

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
      .innerJoin(workflowInstances, eq(workflowInstances.id, workflowStepInstances.instanceId))
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
      total: rows.length,
    };
  });

  /**
   * #788 — is a workflow mandatory for this record type on this project, and
   * has one been started? The owning module calls this before letting a
   * record leave draft.
   */
  app.get("/projects/:projectId/workflow-required", { preHandler: readGate }, async (req) => {
    const q = z
      .object({ recordType: z.string().min(1).max(50), recordId: z.string().max(100).optional() })
      .parse(req.query);
    const templates = await app.db
      .select()
      .from(workflowTemplates)
      .where(
        and(
          eq(workflowTemplates.companyId, req.companyId!),
          eq(workflowTemplates.recordType, q.recordType),
          eq(workflowTemplates.isActive, 1),
          or(eq(workflowTemplates.projectId, req.projectId!), isNull(workflowTemplates.projectId)),
        ),
      );
    let started: InstanceRow | null = null;
    if (q.recordId) {
      const rows = await app.db
        .select()
        .from(workflowInstances)
        .where(
          and(
            eq(workflowInstances.companyId, req.companyId!),
            eq(workflowInstances.projectId, req.projectId!),
            eq(workflowInstances.recordType, q.recordType),
            eq(workflowInstances.recordId, q.recordId),
          ),
        )
        .orderBy(desc(workflowInstances.createdAt))
        .limit(1);
      started = rows[0] ?? null;
    }
    return {
      recordType: q.recordType,
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        version: t.version,
        projectId: t.projectId,
      })),
      required: templates.length > 0,
      instance: started ? { id: started.id, status: started.status } : null,
      satisfied: started ? started.status === "approved" : false,
    };
  });

  app.get("/workflows/:instanceId", { preHandler: companyGate }, async (req) => {
    const { instanceId } = req.params as { instanceId: string };
    const instance = await fetchInstance(instanceId, req.companyId!);
    await requireInstanceAccess(req, instance, "read", { allowParticipant: true });
    const steps = await app.db
      .select()
      .from(workflowStepInstances)
      .where(eq(workflowStepInstances.instanceId, instanceId))
      .orderBy(asc(workflowStepInstances.position), asc(workflowStepInstances.createdAt));
    return { ...instanceDto(instance), steps };
  });

  /** #91 — the payload a UI draws the chain from. */
  app.get("/workflows/:instanceId/graph", { preHandler: companyGate }, async (req) => {
    const { instanceId } = req.params as { instanceId: string };
    const instance = await fetchInstance(instanceId, req.companyId!);
    await requireInstanceAccess(req, instance, "read", { allowParticipant: true });
    const steps = snapshotSteps(instance.context);
    const rows = await app.db
      .select()
      .from(workflowStepInstances)
      .where(eq(workflowStepInstances.instanceId, instanceId))
      .orderBy(asc(workflowStepInstances.position), asc(workflowStepInstances.createdAt));
    if (!steps) {
      return {
        instanceId,
        status: instance.status,
        nodes: [],
        // Never pretend a chain is complete because its definition is
        // unreadable — that is the failure this whole rewrite is about.
        unavailable: "The step snapshot for this run cannot be read; the instance is blocked.",
      };
    }
    return {
      instanceId,
      status: instance.status,
      currentPosition: instance.currentPosition,
      blockedReason: instance.blockedReason,
      nodes: buildGraph(buildGroups(steps), rows, instance.currentPosition, instance.status),
      unavailable: null,
    };
  });

  app.get("/me/workflow-inbox", { preHandler: companyGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const uid = req.user!.id;
    const where = and(
      eq(workflowInstances.companyId, req.companyId!),
      eq(workflowInstances.status, "running"),
      eq(workflowStepInstances.decision, "pending"),
      eq(workflowStepInstances.position, workflowInstances.currentPosition),
      or(eq(workflowStepInstances.assigneeId, uid), eq(workflowStepInstances.delegatedToId, uid)),
    );
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(workflowStepInstances)
      .innerJoin(workflowInstances, eq(workflowInstances.id, workflowStepInstances.instanceId))
      .where(where);
    const rows = await app.db
      .select({ step: workflowStepInstances, instance: workflowInstances, projectName: projects.name })
      .from(workflowStepInstances)
      .innerJoin(workflowInstances, eq(workflowInstances.id, workflowStepInstances.instanceId))
      .leftJoin(projects, eq(projects.id, workflowInstances.projectId))
      .where(where)
      .orderBy(asc(workflowStepInstances.dueDate), asc(workflowStepInstances.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const today = todayISO();
    return paginate(
      rows.map((r) => ({
        ...r.step,
        overdue: Boolean(r.step.dueDate && r.step.dueDate < today),
        instance: {
          id: r.instance.id,
          projectId: r.instance.projectId,
          projectName: r.projectName,
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

  /**
   * Decide one step.
   *
   * The whole advance is one transaction: lock the instance, claim the step
   * with a conditional UPDATE (so a double submit loses instead of doubling),
   * count what remains, and activate the next group in the same transaction.
   */
  app.post("/workflow-steps/:stepInstanceId/decide", { preHandler: companyGate }, async (req) => {
    const { stepInstanceId } = req.params as { stepInstanceId: string };
    const body = decideSchema.parse(req.body);
    const { step, instance } = await loadStepAndInstance(stepInstanceId, req.companyId!);
    if (instance.status !== "running") throw badRequest(`Workflow is ${instance.status}`);
    // Being the named approver IS the authorisation here; no project tool
    // check, or an external reviewer could never decide the step assigned to
    // them. Every other reader of this instance goes through the tool gate.
    const uid = req.user!.id;
    if (uid !== step.assigneeId && uid !== step.delegatedToId) {
      throw forbidden("Only the step assignee or their delegate may decide");
    }

    const snapshot = snapshotSteps(instance.context);
    if (!snapshot) {
      // Fail closed and say why. Approving here is what the old engine did.
      await app.db
        .update(workflowInstances)
        .set({
          status: "blocked",
          blockedReason: "Step snapshot for this run cannot be parsed",
          updatedAt: new Date().toISOString(),
        })
        .where(eq(workflowInstances.id, instance.id));
      await appendLedger(app.db, {
        companyId: instance.companyId,
        actorId: uid,
        action: "state_change",
        objectType: "workflow_instance",
        objectId: instance.id,
        payload: { event: "blocked", reason: "unreadable_snapshot" },
        projectId: instance.projectId,
      });
      throw conflict(
        "This workflow's step definition cannot be read; it has been blocked for an administrator to restart or cancel.",
      );
    }
    const groups = buildGroups(snapshot);
    const resolveAssignees = await buildAssigneeResolver(
      instance.companyId,
      instance.projectId,
      snapshot,
    );

    const now = new Date().toISOString();
    const result = await app.db.transaction(async (tx) => {
      const locked = (
        await tx
          .select()
          .from(workflowInstances)
          .where(eq(workflowInstances.id, instance.id))
          .for("update")
      )[0];
      if (!locked) throw notFound("Workflow instance not found");
      if (locked.status !== "running") throw badRequest(`Workflow is ${locked.status}`);

      // Claim the step. Zero rows = somebody else already decided it.
      const claimed = await tx
        .update(workflowStepInstances)
        .set({
          decision: body.decision,
          comments: body.comments ?? null,
          decidedAt: now,
          decidedBy: uid,
        })
        .where(
          and(
            eq(workflowStepInstances.id, step.id),
            eq(workflowStepInstances.decision, "pending"),
            eq(workflowStepInstances.position, locked.currentPosition),
          ),
        )
        .returning({ id: workflowStepInstances.id });
      if (!claimed[0]) {
        throw conflict("Step has already been decided or is not in the active group");
      }

      if (body.decision === "rejected") {
        // A rejection withdraws the rest of the active group: there is
        // nothing left for them to decide.
        await tx
          .update(workflowStepInstances)
          .set({ decision: "skipped", decidedAt: now })
          .where(
            and(
              eq(workflowStepInstances.instanceId, locked.id),
              eq(workflowStepInstances.position, locked.currentPosition),
              eq(workflowStepInstances.decision, "pending"),
            ),
          );
        await tx
          .update(workflowInstances)
          .set({ status: "rejected", completedAt: now, updatedAt: now })
          .where(eq(workflowInstances.id, locked.id));
        return { kind: "rejected" as const, locked };
      }

      const groupRows = await tx
        .select({ decision: workflowStepInstances.decision, quorum: workflowStepInstances.quorum })
        .from(workflowStepInstances)
        .where(
          and(
            eq(workflowStepInstances.instanceId, locked.id),
            eq(workflowStepInstances.position, locked.currentPosition),
          ),
        );
      const anyOf = groupRows.some((r) => r.quorum === "any");
      const stillPending = groupRows.filter((r) => r.decision === "pending").length;
      if (!anyOf && stillPending > 0) {
        return { kind: "waiting" as const, locked };
      }
      if (anyOf && stillPending > 0) {
        // ANY-of: one approval settles the group; withdraw the rest.
        await tx
          .update(workflowStepInstances)
          .set({ decision: "skipped", decidedAt: now })
          .where(
            and(
              eq(workflowStepInstances.instanceId, locked.id),
              eq(workflowStepInstances.position, locked.currentPosition),
              eq(workflowStepInstances.decision, "pending"),
            ),
          );
      }

      const activation = await activateFrom(
        tx as Db,
        locked,
        groups,
        locked.currentPosition + 1,
        uid,
        resolveAssignees,
      );
      return { kind: "advanced" as const, locked, activation };
    });

    await appendLedger(app.db, {
      companyId: instance.companyId,
      actorId: uid,
      action: "state_change",
      objectType: "workflow_step",
      objectId: step.id,
      payload: { decision: body.decision, instanceId: instance.id, position: step.position },
      projectId: instance.projectId,
    });

    if (result.kind === "rejected") {
      await appendLedger(app.db, {
        companyId: instance.companyId,
        actorId: uid,
        action: "state_change",
        objectType: "workflow_instance",
        objectId: instance.id,
        payload: { from: "running", to: "rejected" },
        projectId: instance.projectId,
      });
      await pushNotifications(app.db, [
        {
          companyId: instance.companyId,
          userId: instance.startedBy,
          projectId: instance.projectId,
          kind: "status_change",
          title: `Workflow rejected: ${instance.recordType} ${instance.recordId}`,
          body: body.comments ?? null,
          recordType: "workflow_instance",
          recordId: instance.id,
        },
      ]);
      return { stepId: step.id, decision: "rejected", instanceStatus: "rejected" };
    }
    if (result.kind === "waiting") {
      return { stepId: step.id, decision: "approved", instanceStatus: "running" };
    }
    const fresh = await fetchInstance(instance.id, instance.companyId);
    await announceActivation(fresh, result.activation, uid);
    return {
      stepId: step.id,
      decision: "approved",
      instanceStatus: result.activation.status,
      blockedReason: result.activation.blockedReason ?? null,
    };
  });

  app.post("/workflow-steps/:stepInstanceId/delegate", { preHandler: companyGate }, async (req) => {
    const { stepInstanceId } = req.params as { stepInstanceId: string };
    const body = delegateSchema.parse(req.body);
    const { step, instance } = await loadStepAndInstance(stepInstanceId, req.companyId!);
    if (instance.status !== "running") throw badRequest(`Workflow is ${instance.status}`);
    if (step.decision !== "pending") throw conflict("Step has already been decided");
    if (req.user!.id !== step.assigneeId) throw forbidden("Only the step assignee may delegate");
    if (body.toUserId === req.user!.id) throw badRequest("A step cannot be delegated to yourself");
    if (body.toUserId === instance.startedBy) {
      // Segregation of duties: the person who started the chain must not
      // become the approver of their own record.
      throw badRequest("A step cannot be delegated to the person who started the workflow");
    }
    await assertCompanyMembers(instance.companyId, [body.toUserId], "Delegate");

    await app.db
      .update(workflowStepInstances)
      .set({ delegatedToId: body.toUserId })
      .where(
        and(eq(workflowStepInstances.id, step.id), eq(workflowStepInstances.decision, "pending")),
      );
    await appendLedger(app.db, {
      companyId: instance.companyId,
      actorId: req.user!.id,
      action: "update",
      objectType: "workflow_step",
      objectId: step.id,
      payload: { delegatedToId: body.toUserId },
      projectId: instance.projectId,
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
  });

  /** Move a pending step to somebody else entirely (workflow admin). */
  app.post("/workflow-steps/:stepInstanceId/reassign", { preHandler: companyGate }, async (req) => {
    const { stepInstanceId } = req.params as { stepInstanceId: string };
    const body = reassignSchema.parse(req.body);
    const { step, instance } = await loadStepAndInstance(stepInstanceId, req.companyId!);
    await requireInstanceAccess(req, instance, "admin");
    if (instance.status !== "running" && instance.status !== "blocked") {
      throw badRequest(`Workflow is ${instance.status}`);
    }
    if (step.decision !== "pending") throw conflict("Step has already been decided");
    await assertCompanyMembers(instance.companyId, [body.toUserId], "Reassignee");
    if (body.toUserId === step.assigneeId) throw badRequest("Step is already assigned to that user");

    await app.db
      .update(workflowStepInstances)
      .set({
        assigneeId: body.toUserId,
        delegatedToId: null,
        reassignedFrom: step.assigneeId,
        remindedAt: null,
      })
      .where(
        and(eq(workflowStepInstances.id, step.id), eq(workflowStepInstances.decision, "pending")),
      );
    await appendLedger(app.db, {
      companyId: instance.companyId,
      actorId: req.user!.id,
      action: "update",
      objectType: "workflow_step",
      objectId: step.id,
      payload: { reassignedFrom: step.assigneeId, to: body.toUserId, reason: body.reason ?? null },
      projectId: instance.projectId,
    });
    await pushNotifications(app.db, [
      {
        companyId: instance.companyId,
        userId: body.toUserId,
        projectId: instance.projectId,
        kind: "workflow_step",
        title: `Workflow step reassigned to you: ${step.name}`,
        body: `${instance.recordType} ${instance.recordId} is waiting on your decision.`,
        recordType: "workflow_step",
        recordId: step.id,
      },
    ]);
    return { stepId: step.id, assigneeId: body.toUserId };
  });

  /** Nudge the current approvers without changing anything. */
  app.post("/workflows/:instanceId/remind", { preHandler: companyGate }, async (req) => {
    const { instanceId } = req.params as { instanceId: string };
    const instance = await fetchInstance(instanceId, req.companyId!);
    if (instance.startedBy !== req.user!.id) {
      await requireInstanceAccess(req, instance, "standard");
    }
    if (instance.status !== "running") throw badRequest(`Workflow is ${instance.status}`);
    const pending = await app.db
      .select()
      .from(workflowStepInstances)
      .where(
        and(
          eq(workflowStepInstances.instanceId, instanceId),
          eq(workflowStepInstances.position, instance.currentPosition),
          eq(workflowStepInstances.decision, "pending"),
        ),
      );
    if (pending.length === 0) return { reminded: 0 };
    await pushNotifications(
      app.db,
      pending.map((s) => ({
        companyId: instance.companyId,
        userId: s.delegatedToId ?? s.assigneeId,
        projectId: instance.projectId,
        kind: "reminder" as const,
        title: `Reminder: ${s.name}`,
        body: `${instance.recordType} ${instance.recordId} is still waiting on your decision.`,
        recordType: "workflow_step",
        recordId: s.id,
      })),
    );
    const now = new Date().toISOString();
    await app.db
      .update(workflowStepInstances)
      .set({ remindedAt: now })
      .where(
        inArray(
          workflowStepInstances.id,
          pending.map((s) => s.id),
        ),
      );
    return { reminded: pending.length };
  });

  /** Cancel a running or blocked chain (starter, or workflow admin). */
  app.post("/workflows/:instanceId/cancel", { preHandler: companyGate }, async (req) => {
    const { instanceId } = req.params as { instanceId: string };
    const body = cancelSchema.parse(req.body);
    const instance = await fetchInstance(instanceId, req.companyId!);
    if (instance.startedBy !== req.user!.id) {
      await requireInstanceAccess(req, instance, "admin");
    }
    if (instance.status !== "running" && instance.status !== "blocked") {
      throw conflict(`Workflow is already ${instance.status}`);
    }
    const now = new Date().toISOString();
    await app.db.transaction(async (tx) => {
      const locked = (
        await tx
          .select()
          .from(workflowInstances)
          .where(eq(workflowInstances.id, instanceId))
          .for("update")
      )[0];
      if (!locked || (locked.status !== "running" && locked.status !== "blocked")) {
        throw conflict("Workflow is no longer cancellable");
      }
      await tx
        .update(workflowStepInstances)
        .set({ decision: "skipped", decidedAt: now })
        .where(
          and(
            eq(workflowStepInstances.instanceId, instanceId),
            eq(workflowStepInstances.decision, "pending"),
          ),
        );
      await tx
        .update(workflowInstances)
        .set({
          status: "cancelled",
          cancelledBy: req.user!.id,
          cancelReason: body.reason,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(workflowInstances.id, instanceId));
    });
    await appendLedger(app.db, {
      companyId: instance.companyId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "workflow_instance",
      objectId: instanceId,
      payload: { from: instance.status, to: "cancelled", reason: body.reason },
      projectId: instance.projectId,
    });
    await pushNotifications(app.db, [
      {
        companyId: instance.companyId,
        userId: instance.startedBy,
        projectId: instance.projectId,
        kind: "status_change",
        title: `Workflow cancelled: ${instance.recordType} ${instance.recordId}`,
        body: body.reason,
        recordType: "workflow_instance",
        recordId: instanceId,
      },
    ]);
    return { id: instanceId, status: "cancelled" };
  });

  /**
   * #90 — retroactive template updates.
   *
   * Migrate running instances of a template to its current version, keeping
   * each at the group it has reached. Steps already decided are untouched;
   * the pending group is rebuilt from the new definition. Every migration is
   * ledgered with the version it moved from and to.
   */
  app.post(
    "/workflow-templates/:templateId/apply-to-running",
    { preHandler: adminCompanyGate },
    async (req) => {
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
      const tpl = rows[0];
      if (!tpl) throw notFound("Workflow template not found");
      const steps = stepsSchema.parse(tpl.steps);
      const groups = buildGroups(steps);

      const running = await app.db
        .select()
        .from(workflowInstances)
        .where(
          and(
            eq(workflowInstances.companyId, req.companyId!),
            eq(workflowInstances.templateId, templateId),
            inArray(workflowInstances.status, ["running", "blocked"]),
            ne(workflowInstances.templateVersion, tpl.version),
          ),
        )
        .limit(500);

      const migrated: Array<{ id: string; from: number; to: number; status: string }> = [];
      for (const instance of running) {
        if (instance.currentPosition >= groups.length) {
          // The new definition is shorter than where this run has reached —
          // migrating it would silently drop approvals that have not happened.
          continue;
        }
        const resolveAssignees = await buildAssigneeResolver(
          instance.companyId,
          instance.projectId,
          steps,
        );
        const now = new Date().toISOString();
        const outcome = await app.db.transaction(async (tx) => {
          const locked = (
            await tx
              .select()
              .from(workflowInstances)
              .where(eq(workflowInstances.id, instance.id))
              .for("update")
          )[0];
          if (!locked) return null;
          // Drop the pending group and rebuild it from the new definition.
          await tx
            .delete(workflowStepInstances)
            .where(
              and(
                eq(workflowStepInstances.instanceId, locked.id),
                eq(workflowStepInstances.position, locked.currentPosition),
                eq(workflowStepInstances.decision, "pending"),
              ),
            );
          await tx
            .update(workflowInstances)
            .set({
              templateVersion: tpl.version,
              status: "running",
              blockedReason: null,
              context: { ...locked.context, [STEPS_KEY]: steps },
              updatedAt: now,
            })
            .where(eq(workflowInstances.id, locked.id));
          const refreshed = (
            await tx.select().from(workflowInstances).where(eq(workflowInstances.id, locked.id)).limit(1)
          )[0]!;
          return activateFrom(
            tx as Db,
            refreshed,
            groups,
            refreshed.currentPosition,
            req.user!.id,
            resolveAssignees,
          );
        });
        if (!outcome) continue;
        await appendLedger(app.db, {
          companyId: instance.companyId,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "workflow_instance",
          objectId: instance.id,
          payload: {
            event: "template_migrated",
            fromVersion: instance.templateVersion,
            toVersion: tpl.version,
            position: instance.currentPosition,
          },
          projectId: instance.projectId,
        });
        const fresh = await fetchInstance(instance.id, instance.companyId);
        await announceActivation(fresh, outcome, req.user!.id);
        migrated.push({
          id: instance.id,
          from: instance.templateVersion,
          to: tpl.version,
          status: outcome.status,
        });
      }

      return {
        templateId,
        version: tpl.version,
        candidates: running.length,
        migrated: migrated.length,
        skipped: running.length - migrated.length,
        items: migrated,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Escalation and reminder sweep (#85, #86)                           */
  /* ---------------------------------------------------------------- */

  registerWorkflowEscalationJob(app);
};

/* ------------------------------------------------------------------ */
/* Scheduled sweep                                                     */
/* ------------------------------------------------------------------ */

export interface WorkflowSweepSummary {
  overdue: number;
  escalated: number;
  reminded: number;
}

/**
 * Escalate and remind on pending steps.
 *
 * Idempotent by construction: a step is escalated once (`escalated_at` is
 * stamped) and reminded at most once a day (`reminded_at`). Nothing here
 * decides a step — an escalation is a louder notification and a record, not
 * an automatic approval.
 */
export async function sweepWorkflowDeadlines(
  db: Db,
  companyId: string,
  now: Date,
): Promise<WorkflowSweepSummary> {
  const today = now.toISOString().slice(0, 10);
  const summary: WorkflowSweepSummary = { overdue: 0, escalated: 0, reminded: 0 };

  const rows = await db
    .select({ step: workflowStepInstances, instance: workflowInstances })
    .from(workflowStepInstances)
    .innerJoin(workflowInstances, eq(workflowInstances.id, workflowStepInstances.instanceId))
    .where(
      and(
        eq(workflowInstances.companyId, companyId),
        eq(workflowInstances.status, "running"),
        eq(workflowStepInstances.decision, "pending"),
        eq(workflowStepInstances.position, workflowInstances.currentPosition),
        or(
          and(
            isNotNull(workflowStepInstances.escalateAt),
            lte(workflowStepInstances.escalateAt, today),
            isNull(workflowStepInstances.escalatedAt),
          ),
          and(isNotNull(workflowStepInstances.dueDate), lt(workflowStepInstances.dueDate, today)),
        ),
      ),
    )
    .limit(500);

  if (rows.length === 0) return summary;

  const nowISO = now.toISOString();
  const escalateIds: string[] = [];
  const remindIds: string[] = [];
  const notifications: Parameters<typeof pushNotifications>[1] = [];

  // Who receives an escalation: the project's admins on the workflow tool.
  const projectIds = [...new Set(rows.map((r) => r.instance.projectId))];
  const admins = await db
    .select({ projectId: projectMemberships.projectId, userId: projectMemberships.userId })
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.companyId, companyId),
        inArray(projectMemberships.projectId, projectIds),
        inArray(projectMemberships.templateKey, ["project_admin", "project_manager"]),
      ),
    );
  const adminsByProject = new Map<string, string[]>();
  for (const a of admins) {
    const list = adminsByProject.get(a.projectId) ?? [];
    list.push(a.userId);
    adminsByProject.set(a.projectId, list);
  }

  for (const { step, instance } of rows) {
    const overdue = Boolean(step.dueDate && step.dueDate < today);
    if (overdue) summary.overdue += 1;

    const dueEscalation =
      step.escalateAt !== null && step.escalateAt <= today && step.escalatedAt === null;
    if (dueEscalation) {
      escalateIds.push(step.id);
      summary.escalated += 1;
      const targets = new Set<string>(adminsByProject.get(instance.projectId) ?? []);
      targets.add(instance.startedBy);
      for (const userId of targets) {
        notifications.push({
          companyId,
          userId,
          projectId: instance.projectId,
          kind: "escalation",
          title: `Escalated: ${step.name}`,
          body: `${instance.recordType} ${instance.recordId} has been waiting since ${step.dueDate ?? step.createdAt.slice(0, 10)}.`,
          recordType: "workflow_step",
          recordId: step.id,
        });
      }
      continue;
    }

    // Overdue but not yet escalated: nudge the assignee once a day.
    const lastReminder = step.remindedAt?.slice(0, 10) ?? null;
    if (overdue && lastReminder !== today) {
      remindIds.push(step.id);
      summary.reminded += 1;
      notifications.push({
        companyId,
        userId: step.delegatedToId ?? step.assigneeId,
        projectId: instance.projectId,
        kind: "overdue",
        title: `Overdue approval: ${step.name}`,
        body: `${instance.recordType} ${instance.recordId} was due ${step.dueDate}.`,
        recordType: "workflow_step",
        recordId: step.id,
      });
    }
  }

  if (escalateIds.length > 0) {
    await db
      .update(workflowStepInstances)
      .set({ escalatedAt: nowISO, remindedAt: nowISO })
      .where(inArray(workflowStepInstances.id, escalateIds));
  }
  if (remindIds.length > 0) {
    await db
      .update(workflowStepInstances)
      .set({ remindedAt: nowISO })
      .where(inArray(workflowStepInstances.id, remindIds));
  }
  if (notifications.length > 0) await pushNotifications(db, notifications);
  return summary;
}

export function registerWorkflowEscalationJob(app: FastifyInstance): void {
  if (app.scheduler.has(ESCALATION_JOB)) return;
  app.scheduler.register({
    name: ESCALATION_JOB,
    description: "Escalate and remind on overdue approval steps (#85, #86)",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => {
      const totals: WorkflowSweepSummary = { overdue: 0, escalated: 0, reminded: 0 };
      const result = await forEachCompany(db, async (companyId) => {
        const s = await sweepWorkflowDeadlines(db, companyId, now);
        totals.overdue += s.overdue;
        totals.escalated += s.escalated;
        totals.reminded += s.reminded;
      });
      return { ...result, ...totals };
    },
  });
}

/** Exported for tests that need the job's name. */
export const WORKFLOW_ESCALATION_JOB = ESCALATION_JOB;
