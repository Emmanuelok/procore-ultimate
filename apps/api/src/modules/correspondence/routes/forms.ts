/**
 * FORMS (spec #457–464): the template library with fields, show/hide logic
 * and an acroform mapping for an uploaded fillable PDF; assignment and
 * distribution; mobile-friendly completion with signature capture; and the
 * register with a CSV export.
 *
 * Two decisions worth stating:
 *
 *  · A RESPONSE IS BOUND TO A TEMPLATE VERSION. Publishing an edit bumps the
 *    version; responses keep the version they were captured on, so a form
 *    answered last March still reads as the form that was asked.
 *  · HIDDEN FIELDS ARE STRIPPED, NOT REJECTED. A branch that closes mid-fill
 *    drops its answers on submission rather than trapping the person filling
 *    it in — and the response records which fields were hidden, so the gaps
 *    are explained rather than mysterious.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  contacts,
  formAssignments,
  formResponses,
  formTemplates,
  projects,
  users,
} from "@constructos/db";
import {
  FORM_ASSIGNMENT_STATUSES,
  FORM_FIELD_TYPES,
  FORM_LOGIC_OPERATORS,
  FORM_RESPONSE_STATUSES,
  FORM_TEMPLATE_STATUSES,
  type FormFieldDef,
  type FormLogicRule,
  type FormSignature,
} from "@constructos/shared";
import { badRequest, conflict, forbidden, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { pushNotifications } from "../../notifications/service.js";
import {
  reconcilePdfMapping,
  resolveVisibility,
  validateResponse,
  validateTemplate,
} from "../engines/forms.js";
import {
  allocateReference,
  assertCompanyUser,
  assertContact,
  assertFiles,
  assertLocation,
  assertScheduleTask,
  buildGates,
  fileIdsSchema,
  idSchema,
  isoDateSchema,
  keySchema,
  ledger,
  nowISO,
  patchSchemaOf,
  patchSet,
  todayISO,
} from "../shared.js";

/* ------------------------------------------------------------------ */
/* Wire formats                                                        */
/* ------------------------------------------------------------------ */

const conditionSchema = z.object({
  field: z.string().min(1).max(64),
  operator: z.enum(FORM_LOGIC_OPERATORS),
  value: z.unknown().optional(),
});

const ruleSchema = z.object({
  all: z.array(conditionSchema).max(20).optional(),
  any: z.array(conditionSchema).max(20).optional(),
});

const fieldSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(300),
  type: z.enum(FORM_FIELD_TYPES),
  required: z.boolean().optional(),
  help: z.string().max(1000).nullable().optional(),
  placeholder: z.string().max(200).nullable().optional(),
  section: z.string().max(120).nullable().optional(),
  options: z
    .array(z.object({ value: z.string().min(1).max(120), label: z.string().min(1).max(200) }))
    .max(200)
    .optional(),
  min: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
  maxLength: z.number().int().min(1).max(100_000).nullable().optional(),
  defaultValue: z.unknown().optional(),
  pdfField: z.string().max(200).nullable().optional(),
  visibleWhen: ruleSchema.nullable().optional(),
});

const templateBodySchema = z.object({
  key: keySchema,
  name: z.string().trim().min(1).max(160),
  description: z.string().max(4000).nullable().optional(),
  category: z.string().max(80).nullable().optional(),
  projectId: idSchema.nullable().optional(),
  fields: z.array(fieldSchema).max(300).default([]),
  logic: z.record(z.string().max(64), ruleSchema).default({}),
  signatureRequired: z.boolean().default(false),
  pdfFileId: idSchema.nullable().optional(),
  pdfFieldMap: z.record(z.string().max(200), z.string().max(64)).default({}),
});

const assignmentBodySchema = z.object({
  templateId: idSchema,
  assigneeUserId: idSchema.nullable().optional(),
  assigneeContactId: idSchema.nullable().optional(),
  assigneeName: z.string().trim().min(1).max(200).optional(),
  locationId: idSchema.nullable().optional(),
  scheduleTaskId: idSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  instructions: z.string().max(4000).nullable().optional(),
});

const responseBodySchema = z.object({
  templateId: idSchema.optional(),
  assignmentId: idSchema.nullable().optional(),
  title: z.string().trim().max(300).nullable().optional(),
  values: z.record(z.string().max(64), z.unknown()).default({}),
  locationId: idSchema.nullable().optional(),
  scheduleTaskId: idSchema.nullable().optional(),
  fileIds: fileIdsSchema.default([]),
});

const signatureSchema = z.object({
  name: z.string().trim().min(1).max(200),
  method: z.enum(["typed", "drawn", "uploaded"]).default("typed"),
  fileId: idSchema.nullable().optional(),
  statement: z.string().max(1000).nullable().optional(),
});

const toFieldDefs = (fields: z.infer<typeof fieldSchema>[]): FormFieldDef[] =>
  fields.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    required: f.required ?? false,
    help: f.help ?? null,
    placeholder: f.placeholder ?? null,
    section: f.section ?? null,
    options: f.options ?? [],
    min: f.min ?? null,
    max: f.max ?? null,
    maxLength: f.maxLength ?? null,
    defaultValue: f.defaultValue,
    pdfField: f.pdfField ?? null,
    visibleWhen: (f.visibleWhen ?? null) as FormLogicRule | null,
  }));

/** The stored jsonb comes back structurally typed; narrow it once, here. */
const storedFields = (value: unknown): FormFieldDef[] =>
  Array.isArray(value) ? (value as FormFieldDef[]) : [];
const storedLogic = (value: unknown): Record<string, FormLogicRule> =>
  value && typeof value === "object" ? (value as Record<string, FormLogicRule>) : {};

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join("; ") : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const formRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate, companyGate, companyAdminGate } = buildGates(app);

  /* ================================================================ */
  /* Template library (company level, #464)                            */
  /* ================================================================ */

  app.get("/correspondence/form-templates", { preHandler: companyGate }, async (req) => {
    const q = z
      .object({
        projectId: idSchema.optional(),
        status: z.enum(FORM_TEMPLATE_STATUSES).optional(),
        category: z.string().max(80).optional(),
      })
      .parse(req.query);
    const rows = await app.db
      .select()
      .from(formTemplates)
      .where(
        and(
          eq(formTemplates.companyId, req.companyId!),
          q.status ? eq(formTemplates.status, q.status) : undefined,
          q.category ? eq(formTemplates.category, q.category) : undefined,
          q.projectId
            ? or(isNull(formTemplates.projectId), eq(formTemplates.projectId, q.projectId))
            : undefined,
        ),
      )
      .orderBy(asc(formTemplates.name));
    return {
      items: rows.map((r) => ({ ...r, fieldCount: storedFields(r.fields).length })),
      total: rows.length,
    };
  });

  app.post("/correspondence/form-templates", { preHandler: companyAdminGate }, async (req, reply) => {
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
      .select({ id: formTemplates.id })
      .from(formTemplates)
      .where(and(eq(formTemplates.companyId, companyId), eq(formTemplates.key, body.key)))
      .limit(1);
    if (clash[0]) throw conflict(`A form template with the key "${body.key}" already exists.`);
    const fields = toFieldDefs(body.fields);
    const logic = body.logic as Record<string, FormLogicRule>;
    // A draft may be structurally incomplete, but never internally broken.
    if (fields.length > 0) {
      const problems = validateTemplate(fields, logic);
      if (problems.length > 0) throw badRequest("This template has problems that must be fixed first.", { problems });
    }
    const id = newId("fmt");
    const [row] = await app.db
      .insert(formTemplates)
      .values({
        id,
        companyId,
        projectId: body.projectId ?? null,
        key: body.key,
        name: body.name,
        description: body.description ?? null,
        category: body.category ?? null,
        fields,
        logic,
        signatureRequired: body.signatureRequired ? 1 : 0,
        pdfFileId: body.pdfFileId ?? null,
        pdfFieldMap: body.pdfFieldMap,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId: body.projectId ?? null,
      actorId: req.user!.id,
      action: "create",
      objectType: "form_template",
      objectId: id,
      payload: { key: body.key, name: body.name, fields: fields.length },
    });
    return reply.code(201).send(row);
  });

  app.get("/correspondence/form-templates/:templateId", { preHandler: companyGate }, async (req) => {
    const { templateId } = req.params as { templateId: string };
    const [row] = await app.db
      .select()
      .from(formTemplates)
      .where(and(eq(formTemplates.id, templateId), eq(formTemplates.companyId, req.companyId!)))
      .limit(1);
    if (!row) throw notFound("Form template not found");
    const fields = storedFields(row.fields);
    const logic = storedLogic(row.logic);
    const [{ n = 0 } = { n: 0 }] = await app.db
      .select({ n: sql<number>`count(*)::int` })
      .from(formResponses)
      .where(
        and(eq(formResponses.companyId, req.companyId!), eq(formResponses.templateId, templateId)),
      );
    return {
      ...row,
      responseCount: Number(n),
      problems: validateTemplate(fields, logic),
      pdfMapping: reconcilePdfMapping(fields, (row.pdfFieldMap ?? {}) as Record<string, string>),
      initialVisibility: resolveVisibility(fields, {}, logic),
    };
  });

  app.patch("/correspondence/form-templates/:templateId", { preHandler: companyAdminGate }, async (req) => {
    const { templateId } = req.params as { templateId: string };
    // `.partial()` KEEPS every `.default()`, so parsing a PATCH through it
    // would reset `fields`, `logic` and `pdfFieldMap` to their defaults and
    // silently empty the template. `patchSchemaOf` strips the defaults first:
    // a PATCH body is only what the caller actually sent.
    const body = patchSchemaOf(templateBodySchema)
      .omit({ key: true, projectId: true })
      .parse(req.body);
    const companyId = req.companyId!;
    const [current] = await app.db
      .select()
      .from(formTemplates)
      .where(and(eq(formTemplates.id, templateId), eq(formTemplates.companyId, companyId)))
      .limit(1);
    if (!current) throw notFound("Form template not found");
    if (current.status === "archived") throw conflict("An archived template cannot be edited. Clone it instead.");

    const structural = body.fields !== undefined || body.logic !== undefined;
    const fields = body.fields ? toFieldDefs(body.fields) : storedFields(current.fields);
    const logic = body.logic ? (body.logic as Record<string, FormLogicRule>) : storedLogic(current.logic);
    // A structural edit is validated even when it empties the form — that is
    // exactly the edit that must not be allowed to land silently.
    if (structural || fields.length > 0) {
      const problems = validateTemplate(fields, logic);
      if (problems.length > 0) throw badRequest("This template has problems that must be fixed first.", { problems });
    }
    const set = patchSet(
      {
        name: body.name,
        description: body.description,
        category: body.category,
        pdfFileId: body.pdfFileId,
        pdfFieldMap: body.pdfFieldMap,
        signatureRequired:
          body.signatureRequired === undefined ? undefined : body.signatureRequired ? 1 : 0,
        fields: body.fields ? fields : undefined,
        logic: body.logic ? logic : undefined,
      },
      ["name", "description", "category", "pdfFileId", "pdfFieldMap", "signatureRequired", "fields", "logic"],
    );
    // Editing a PUBLISHED template's questions is a new version, so responses
    // already captured keep the form they were actually asked.
    if (structural && current.status === "published") set["version"] = current.version + 1;

    const [row] = await app.db
      .update(formTemplates)
      .set(set)
      .where(eq(formTemplates.id, templateId))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId: current.projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "form_template",
      objectId: templateId,
      payload: {
        changed: Object.keys(set).filter((k) => k !== "updatedAt"),
        version: row?.version ?? current.version,
      },
    });
    return row;
  });

  app.post(
    "/correspondence/form-templates/:templateId/publish",
    { preHandler: companyAdminGate },
    async (req) => {
      const { templateId } = req.params as { templateId: string };
      const companyId = req.companyId!;
      const [current] = await app.db
        .select()
        .from(formTemplates)
        .where(and(eq(formTemplates.id, templateId), eq(formTemplates.companyId, companyId)))
        .limit(1);
      if (!current) throw notFound("Form template not found");
      if (current.status === "published") throw conflict("This template is already published.");
      const problems = validateTemplate(storedFields(current.fields), storedLogic(current.logic));
      if (problems.length > 0) {
        throw badRequest("This template cannot be published until its problems are fixed.", { problems });
      }
      const [row] = await app.db
        .update(formTemplates)
        .set({
          status: "published",
          publishedAt: nowISO(),
          publishedBy: req.user!.id,
          archivedAt: null,
          updatedAt: nowISO(),
        })
        .where(eq(formTemplates.id, templateId))
        .returning();
      await ledger(app.db, {
        companyId,
        projectId: current.projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "form_template",
        objectId: templateId,
        payload: { to: "published", version: current.version },
      });
      return row;
    },
  );

  app.post(
    "/correspondence/form-templates/:templateId/archive",
    { preHandler: companyAdminGate },
    async (req) => {
      const { templateId } = req.params as { templateId: string };
      const companyId = req.companyId!;
      const [current] = await app.db
        .select()
        .from(formTemplates)
        .where(and(eq(formTemplates.id, templateId), eq(formTemplates.companyId, companyId)))
        .limit(1);
      if (!current) throw notFound("Form template not found");
      const open = await app.db
        .select({ n: count() })
        .from(formAssignments)
        .where(
          and(
            eq(formAssignments.templateId, templateId),
            inArray(formAssignments.status, ["assigned", "in_progress"]),
          ),
        );
      if ((open[0]?.n ?? 0) > 0) {
        throw conflict(
          `${open[0]?.n} assignment(s) of this form are still open. Cancel or complete them before archiving, otherwise people are asked to fill in a form that no longer exists.`,
        );
      }
      const [row] = await app.db
        .update(formTemplates)
        .set({ status: "archived", archivedAt: nowISO(), updatedAt: nowISO() })
        .where(eq(formTemplates.id, templateId))
        .returning();
      await ledger(app.db, {
        companyId,
        projectId: current.projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "form_template",
        objectId: templateId,
        payload: { to: "archived" },
      });
      return row;
    },
  );

  /* ================================================================ */
  /* Assignments (project level, #460)                                 */
  /* ================================================================ */

  async function loadTemplateForProject(companyId: string, projectId: string, templateId: string) {
    const [row] = await app.db
      .select()
      .from(formTemplates)
      .where(and(eq(formTemplates.id, templateId), eq(formTemplates.companyId, companyId)))
      .limit(1);
    if (!row) throw badRequest(`Form template ${templateId} not found in this company.`);
    if (row.projectId !== null && row.projectId !== projectId) {
      throw badRequest(`Form template "${row.key}" belongs to another project.`);
    }
    return row;
  }

  app.get("/projects/:projectId/correspondence/form-assignments", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({
        status: z.enum(FORM_ASSIGNMENT_STATUSES).optional(),
        templateId: idSchema.optional(),
        assigneeUserId: idSchema.optional(),
        overdueOnly: z.coerce.boolean().optional(),
      })
      .parse(req.query);
    const today = todayISO();
    const where = and(
      eq(formAssignments.companyId, req.companyId!),
      eq(formAssignments.projectId, projectId),
      q.status ? eq(formAssignments.status, q.status) : undefined,
      q.templateId ? eq(formAssignments.templateId, q.templateId) : undefined,
      q.assigneeUserId ? eq(formAssignments.assigneeUserId, q.assigneeUserId) : undefined,
      q.overdueOnly
        ? and(
            inArray(formAssignments.status, ["assigned", "in_progress"]),
            sql`${formAssignments.dueDate} < ${today}`,
          )
        : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db
        .select()
        .from(formAssignments)
        .where(where)
        .orderBy(asc(formAssignments.dueDate), desc(formAssignments.createdAt))
        .limit(q.pageSize)
        .offset(pageOffset(q)),
      app.db.select({ n: count() }).from(formAssignments).where(where),
    ]);
    return paginate(
      rows.map((r) => ({
        ...r,
        overdue:
          (r.status === "assigned" || r.status === "in_progress") &&
          r.dueDate !== null &&
          r.dueDate < today,
      })),
      total?.n ?? 0,
      q,
    );
  });

  app.post(
    "/projects/:projectId/correspondence/form-assignments",
    { preHandler: standardGate },
    async (req, reply) => {
      const { projectId } = req.params as { projectId: string };
      const body = assignmentBodySchema.parse(req.body);
      const companyId = req.companyId!;
      const template = await loadTemplateForProject(companyId, projectId, body.templateId);
      if (template.status !== "published") {
        throw badRequest(
          `Form "${template.name}" is ${template.status}. Only a published form can be assigned — an unpublished one is still being written.`,
        );
      }
      let assigneeName = body.assigneeName ?? null;
      if (body.assigneeUserId) {
        const user = await assertCompanyUser(app.db, companyId, body.assigneeUserId);
        assigneeName = assigneeName ?? user.name;
      } else if (body.assigneeContactId) {
        await assertContact(app.db, companyId, body.assigneeContactId);
        if (!assigneeName) {
          const [contact] = await app.db
            .select({ name: contacts.name })
            .from(contacts)
            .where(eq(contacts.id, body.assigneeContactId))
            .limit(1);
          assigneeName = contact?.name ?? null;
        }
      }
      if (!assigneeName) {
        throw badRequest("An assignment needs an assignee — a company user, a contact, or at least a name.");
      }
      if (body.locationId) await assertLocation(app.db, projectId, body.locationId);
      if (body.scheduleTaskId) await assertScheduleTask(app.db, projectId, body.scheduleTaskId);

      const id = newId("fma");
      const [row] = await app.db
        .insert(formAssignments)
        .values({
          id,
          companyId,
          projectId,
          templateId: template.id,
          templateVersion: template.version,
          assigneeUserId: body.assigneeUserId ?? null,
          assigneeContactId: body.assigneeContactId ?? null,
          assigneeName,
          locationId: body.locationId ?? null,
          scheduleTaskId: body.scheduleTaskId ?? null,
          dueDate: body.dueDate ?? null,
          instructions: body.instructions ?? null,
          createdBy: req.user!.id,
        })
        .returning();
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "create",
        objectType: "form_assignment",
        objectId: id,
        payload: { templateId: template.id, assignee: assigneeName, dueDate: body.dueDate ?? null },
      });
      if (body.assigneeUserId) {
        await pushNotifications(app.db, [
          {
            companyId,
            userId: body.assigneeUserId,
            projectId,
            kind: "assignment",
            title: `You were assigned the form "${template.name}"`,
            body: body.dueDate ? `Due ${body.dueDate}.` : "No due date set.",
            recordType: "form_assignment",
            recordId: id,
          },
        ]);
      }
      return reply.code(201).send(row);
    },
  );

  app.post(
    "/projects/:projectId/correspondence/form-assignments/:assignmentId/cancel",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, assignmentId } = req.params as { projectId: string; assignmentId: string };
      const body = z.object({ reason: z.string().trim().min(3).max(2000) }).parse(req.body);
      const companyId = req.companyId!;
      const [assignment] = await app.db
        .select()
        .from(formAssignments)
        .where(
          and(
            eq(formAssignments.id, assignmentId),
            eq(formAssignments.companyId, companyId),
            eq(formAssignments.projectId, projectId),
          ),
        )
        .limit(1);
      if (!assignment) throw notFound("Form assignment not found");
      if (assignment.status === "completed") throw conflict("This assignment has already been completed.");
      const [row] = await app.db
        .update(formAssignments)
        .set({ status: "cancelled", cancelledReason: body.reason, updatedAt: nowISO() })
        .where(eq(formAssignments.id, assignmentId))
        .returning();
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "form_assignment",
        objectId: assignmentId,
        payload: { to: "cancelled", reason: body.reason },
      });
      return row;
    },
  );

  /* ================================================================ */
  /* Responses (#461–463)                                              */
  /* ================================================================ */

  async function loadResponse(companyId: string, projectId: string, responseId: string) {
    const [row] = await app.db
      .select()
      .from(formResponses)
      .where(
        and(
          eq(formResponses.id, responseId),
          eq(formResponses.companyId, companyId),
          eq(formResponses.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Form response not found");
    return row;
  }

  app.get("/projects/:projectId/correspondence/form-responses", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({
        status: z.enum(FORM_RESPONSE_STATUSES).optional(),
        templateId: idSchema.optional(),
        assignmentId: idSchema.optional(),
        locationId: idSchema.optional(),
        q: z.string().max(200).optional(),
      })
      .parse(req.query);
    const where = and(
      eq(formResponses.companyId, req.companyId!),
      eq(formResponses.projectId, projectId),
      q.status ? eq(formResponses.status, q.status) : undefined,
      q.templateId ? eq(formResponses.templateId, q.templateId) : undefined,
      q.assignmentId ? eq(formResponses.assignmentId, q.assignmentId) : undefined,
      q.locationId ? eq(formResponses.locationId, q.locationId) : undefined,
      q.q ? or(ilike(formResponses.title, `%${q.q}%`), ilike(formResponses.reference, `%${q.q}%`)) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db
        .select()
        .from(formResponses)
        .where(where)
        .orderBy(desc(formResponses.createdAt))
        .limit(q.pageSize)
        .offset(pageOffset(q)),
      app.db.select({ n: count() }).from(formResponses).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  /** Register export (#463). One row per response, one column per field. */
  app.get(
    "/projects/:projectId/correspondence/form-responses/export",
    { preHandler: readGate },
    async (req, reply) => {
      const { projectId } = req.params as { projectId: string };
      const q = z
        .object({ templateId: idSchema, status: z.enum(FORM_RESPONSE_STATUSES).optional() })
        .parse(req.query);
      const companyId = req.companyId!;
      const template = await loadTemplateForProject(companyId, projectId, q.templateId);
      const rows = await app.db
        .select()
        .from(formResponses)
        .where(
          and(
            eq(formResponses.companyId, companyId),
            eq(formResponses.projectId, projectId),
            eq(formResponses.templateId, q.templateId),
            q.status ? eq(formResponses.status, q.status) : undefined,
          ),
        )
        .orderBy(asc(formResponses.number))
        .limit(10_000);
      const fields = storedFields(template.fields).filter((f) => f.type !== "heading");
      const header = [
        "reference",
        "status",
        "template_version",
        "submitted_at",
        "submitted_by",
        "signed_by",
        ...fields.map((f) => f.key),
      ];
      const lines = [header.map(csvCell).join(",")];
      for (const row of rows) {
        const values = (row.values ?? {}) as Record<string, unknown>;
        lines.push(
          [
            row.reference,
            row.status,
            row.templateVersion,
            row.submittedAt ?? "",
            row.submittedBy ?? "",
            row.signature?.name ?? "",
            ...fields.map((f) => values[f.key]),
          ]
            .map(csvCell)
            .join(","),
        );
      }
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "access",
        objectType: "form_template",
        objectId: q.templateId,
        payload: { export: "csv", rows: rows.length },
      });
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="${template.key}-responses.csv"`)
        .send(lines.join("\n"));
    },
  );

  app.post("/projects/:projectId/correspondence/form-responses", { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = responseBodySchema.parse(req.body);
    const companyId = req.companyId!;

    let assignment: typeof formAssignments.$inferSelect | null = null;
    if (body.assignmentId) {
      const [row] = await app.db
        .select()
        .from(formAssignments)
        .where(
          and(
            eq(formAssignments.id, body.assignmentId),
            eq(formAssignments.companyId, companyId),
            eq(formAssignments.projectId, projectId),
          ),
        )
        .limit(1);
      if (!row) throw badRequest(`Form assignment ${body.assignmentId} not found in this project.`);
      if (row.status === "cancelled") throw conflict("That assignment was cancelled.");
      if (row.responseId) throw conflict("That assignment already has a response.");
      assignment = row;
    }
    const templateId = assignment?.templateId ?? body.templateId;
    if (!templateId) throw badRequest("A response needs a templateId, or an assignmentId to take one from.");
    const template = await loadTemplateForProject(companyId, projectId, templateId);
    if (template.status !== "published" && !assignment) {
      throw badRequest(`Form "${template.name}" is ${template.status}; only a published form can be filled in.`);
    }
    if (body.locationId) await assertLocation(app.db, projectId, body.locationId);
    if (body.scheduleTaskId) await assertScheduleTask(app.db, projectId, body.scheduleTaskId);
    if (body.fileIds.length > 0) await assertFiles(app.db, companyId, projectId, body.fileIds);

    const fields = storedFields(template.fields);
    const logic = storedLogic(template.logic);
    const validation = validateResponse(fields, body.values, logic, {
      requireComplete: false,
      signatureRequired: false,
    });
    if (!validation.ok) {
      throw badRequest("Some answers do not fit this form.", { errors: validation.errors });
    }

    const id = newId("fmr");
    const { number, reference } = await allocateReference(app.db, projectId, "form_response", "FR");
    const [row] = await app.db
      .insert(formResponses)
      .values({
        id,
        companyId,
        projectId,
        templateId: template.id,
        templateVersion: assignment?.templateVersion ?? template.version,
        assignmentId: assignment?.id ?? null,
        number,
        reference,
        title: body.title ?? template.name,
        values: validation.cleaned,
        hiddenFields: validation.hidden,
        locationId: body.locationId ?? assignment?.locationId ?? null,
        scheduleTaskId: body.scheduleTaskId ?? assignment?.scheduleTaskId ?? null,
        fileIds: body.fileIds,
        createdBy: req.user!.id,
      })
      .returning();
    if (assignment) {
      await app.db
        .update(formAssignments)
        .set({ status: "in_progress", responseId: id, updatedAt: nowISO() })
        .where(eq(formAssignments.id, assignment.id));
    }
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "form_response",
      objectId: id,
      payload: { reference, templateId: template.id, assignmentId: assignment?.id ?? null },
    });
    return reply.code(201).send({ ...row, validation });
  });

  app.get(
    "/projects/:projectId/correspondence/form-responses/:responseId",
    { preHandler: readGate },
    async (req) => {
      const { projectId, responseId } = req.params as { projectId: string; responseId: string };
      const companyId = req.companyId!;
      const response = await loadResponse(companyId, projectId, responseId);
      const [template] = await app.db
        .select()
        .from(formTemplates)
        .where(eq(formTemplates.id, response.templateId))
        .limit(1);
      const fields = storedFields(template?.fields);
      const logic = storedLogic(template?.logic);
      return {
        ...response,
        template: template ?? null,
        templateDrifted: template ? template.version !== response.templateVersion : false,
        visibility: resolveVisibility(fields, (response.values ?? {}) as Record<string, unknown>, logic),
      };
    },
  );

  app.patch(
    "/projects/:projectId/correspondence/form-responses/:responseId",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, responseId } = req.params as { projectId: string; responseId: string };
      const body = z
        .object({
          title: z.string().trim().max(300).nullable().optional(),
          values: z.record(z.string().max(64), z.unknown()).optional(),
          fileIds: fileIdsSchema.optional(),
          locationId: idSchema.nullable().optional(),
        })
        .parse(req.body);
      const companyId = req.companyId!;
      const response = await loadResponse(companyId, projectId, responseId);
      if (response.status !== "draft") {
        throw conflict(
          `${response.reference} was ${response.status}; a submitted form is the record of what was observed and cannot be edited. Raise a new response.`,
        );
      }
      const [template] = await app.db
        .select()
        .from(formTemplates)
        .where(eq(formTemplates.id, response.templateId))
        .limit(1);
      if (!template) throw notFound("The template behind this response no longer exists");
      if (body.fileIds && body.fileIds.length > 0) {
        await assertFiles(app.db, companyId, projectId, body.fileIds);
      }
      if (body.locationId) await assertLocation(app.db, projectId, body.locationId);

      const set: Record<string, unknown> = { updatedAt: nowISO() };
      let validation = null;
      if (body.values) {
        validation = validateResponse(
          storedFields(template.fields),
          body.values,
          storedLogic(template.logic),
          { requireComplete: false, signatureRequired: false },
        );
        if (!validation.ok) {
          throw badRequest("Some answers do not fit this form.", { errors: validation.errors });
        }
        set["values"] = validation.cleaned;
        set["hiddenFields"] = validation.hidden;
      }
      if (body.title !== undefined) set["title"] = body.title;
      if (body.fileIds !== undefined) set["fileIds"] = body.fileIds;
      if (body.locationId !== undefined) set["locationId"] = body.locationId;

      const [row] = await app.db
        .update(formResponses)
        .set(set)
        .where(eq(formResponses.id, responseId))
        .returning();
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "update",
        objectType: "form_response",
        objectId: responseId,
        payload: { changed: Object.keys(set).filter((k) => k !== "updatedAt") },
      });
      return { ...row, validation };
    },
  );

  app.post(
    "/projects/:projectId/correspondence/form-responses/:responseId/submit",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, responseId } = req.params as { projectId: string; responseId: string };
      const body = z
        .object({
          values: z.record(z.string().max(64), z.unknown()).optional(),
          signature: signatureSchema.nullable().optional(),
        })
        .parse(req.body ?? {});
      const companyId = req.companyId!;
      const response = await loadResponse(companyId, projectId, responseId);
      if (response.status !== "draft") throw conflict(`${response.reference} is already ${response.status}.`);
      const [template] = await app.db
        .select()
        .from(formTemplates)
        .where(eq(formTemplates.id, response.templateId))
        .limit(1);
      if (!template) throw notFound("The template behind this response no longer exists");

      const values = body.values ?? ((response.values ?? {}) as Record<string, unknown>);
      const signature = body.signature
        ? { ...body.signature, signedAt: nowISO(), fileId: body.signature.fileId ?? null, statement: body.signature.statement ?? null }
        : ((response.signature ?? null) as FormSignature | null);
      const validation = validateResponse(
        storedFields(template.fields),
        values,
        storedLogic(template.logic),
        {
          requireComplete: true,
          signatureRequired: template.signatureRequired === 1,
          signature,
        },
      );
      if (!validation.ok) {
        throw badRequest("This form is not complete.", { errors: validation.errors, defects: validation.defects });
      }
      if (signature?.fileId) await assertFiles(app.db, companyId, projectId, [signature.fileId]);

      const now = nowISO();
      const [row] = await app.db
        .update(formResponses)
        .set({
          status: "submitted",
          values: validation.cleaned,
          hiddenFields: validation.hidden,
          signature,
          submittedAt: now,
          submittedBy: req.user!.id,
          updatedAt: now,
        })
        .where(eq(formResponses.id, responseId))
        .returning();
      if (response.assignmentId) {
        await app.db
          .update(formAssignments)
          .set({ status: "completed", completedAt: now, responseId, updatedAt: now })
          .where(eq(formAssignments.id, response.assignmentId));
        await ledger(app.db, {
          companyId,
          projectId,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "form_assignment",
          objectId: response.assignmentId,
          payload: { to: "completed", responseId },
        });
      }
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "form_response",
        objectId: responseId,
        payload: {
          to: "submitted",
          answered: validation.answered,
          askable: validation.askable,
          hidden: validation.hidden.length,
          signed: signature !== null,
        },
      });
      return { ...row, validation };
    },
  );

  app.post(
    "/projects/:projectId/correspondence/form-responses/:responseId/review",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, responseId } = req.params as { projectId: string; responseId: string };
      const body = z
        .object({ decision: z.enum(["approved", "rejected"]), note: z.string().max(4000).nullable().optional() })
        .parse(req.body);
      const companyId = req.companyId!;
      const response = await loadResponse(companyId, projectId, responseId);
      if (response.status !== "submitted") {
        throw conflict(`${response.reference} is ${response.status}; only a submitted form can be reviewed.`);
      }
      // Segregation of duties: the person who filled it in does not review it.
      if (response.submittedBy === req.user!.id) {
        throw forbidden(
          "The person who submitted a form cannot review it. A check by its own author is not a check.",
        );
      }
      const [row] = await app.db
        .update(formResponses)
        .set({
          status: body.decision,
          reviewedAt: nowISO(),
          reviewedBy: req.user!.id,
          reviewNote: body.note ?? null,
          updatedAt: nowISO(),
        })
        .where(eq(formResponses.id, responseId))
        .returning();
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "form_response",
        objectId: responseId,
        payload: { to: body.decision, note: body.note ?? null },
      });
      if (response.submittedBy) {
        await pushNotifications(app.db, [
          {
            companyId,
            userId: response.submittedBy,
            projectId,
            kind: "status_change",
            title: `${response.reference} was ${body.decision}`,
            body: body.note ?? response.title ?? "",
            recordType: "form_response",
            recordId: responseId,
          },
        ]);
      }
      return row;
    },
  );
};
