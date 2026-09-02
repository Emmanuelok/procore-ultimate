/**
 * CONSULTANTS, DELIVERABLE SCHEDULE AND INFORMATION REQUIREMENTS
 * (spec Vol I #254; Vol II T #887, #909–#912; ISO 19650 EIR/BEP/TIDP/MIDP).
 *
 * The deliverable schedule is where a design programme stops being a wall
 * chart: every row is assessed against the planned date and the construction
 * task it feeds, carries an obligation while it is outstanding, and raises a
 * signal when it goes late. Acceptance of a deliverable is by someone other
 * than whoever issued it; verification of an information requirement is by
 * someone other than whoever delivered it.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import { designConsultants, designDeliverables, designInfoRequirements, obligations } from "@constructos/db";
import {
  DESIGN_CONSULTANT_STATUSES,
  DESIGN_DELIVERABLE_STATUSES,
  DESIGN_DELIVERABLE_TYPES,
  DESIGN_DISCIPLINES,
  DESIGN_INFO_REQUIREMENT_KINDS,
  DESIGN_INFO_REQUIREMENT_STATUSES,
  DESIGN_SLIPPAGE_LEVELS,
  DESIGN_STAGE_KEYS,
} from "@constructos/shared";
import { badRequest, conflict, forbidden, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { pushNotifications } from "../../notifications/service.js";
import { assessPi } from "../engines/readiness.js";
import { slippageByConsultant, slippageStats } from "../engines/slippage.js";
import {
  assessDeliverableRow,
  persistDeliverableAssessment,
  sweepDeliverables,
  sweepInfoRequirements,
  sweepProfessionalIndemnity,
  syncDeliverableObligation,
} from "../service.js";
import {
  allocateReference,
  assertConsultant,
  assertPackage,
  assertUser,
  assertVendor,
  buildGates,
  currencySchema,
  fileIdsSchema,
  idSchema,
  isoDateSchema,
  ledger,
  loadTask,
  nowISO,
  patchSchemaOf,
  patchSet,
  todayISO,
} from "../shared.js";

const consultantBodySchema = z.object({
  name: z.string().min(1).max(200),
  vendorId: idSchema.nullable().optional(),
  discipline: z.enum(DESIGN_DISCIPLINES).default("multi_discipline"),
  role: z.string().max(120).nullable().optional(),
  appointmentRef: z.string().max(80).nullable().optional(),
  commitmentId: idSchema.nullable().optional(),
  appointedAt: isoDateSchema.nullable().optional(),
  feeValue: z.number().min(0).nullable().optional(),
  currency: currencySchema.default("USD"),
  contactName: z.string().max(160).nullable().optional(),
  contactEmail: z.string().email().max(200).nullable().optional(),
  piRequiredAmount: z.number().min(0).nullable().optional(),
  piCoverAmount: z.number().min(0).nullable().optional(),
  piCurrency: currencySchema.nullable().optional(),
  piExpiresOn: isoDateSchema.nullable().optional(),
  piInsurerName: z.string().max(200).nullable().optional(),
  piPolicyNumber: z.string().max(120).nullable().optional(),
  notes: z.string().max(8000).nullable().optional(),
});

const consultantPatchSchema = patchSchemaOf(consultantBodySchema);

const deliverableBodySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(8000).nullable().optional(),
  deliverableType: z.enum(DESIGN_DELIVERABLE_TYPES).default("drawing"),
  discipline: z.enum(DESIGN_DISCIPLINES).default("multi_discipline"),
  packageId: idSchema.nullable().optional(),
  consultantId: idSchema.nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  stageKey: z.enum(DESIGN_STAGE_KEYS).nullable().optional(),
  infoRequirementId: idSchema.nullable().optional(),
  scheduleTaskId: idSchema.nullable().optional(),
  requiredOnSite: isoDateSchema.nullable().optional(),
  plannedIssueDate: isoDateSchema.nullable().optional(),
  forecastIssueDate: isoDateSchema.nullable().optional(),
  revision: z.string().max(20).nullable().optional(),
  drawingSheetIds: z.array(idSchema).max(200).default([]),
  fileIds: fileIdsSchema.default([]),
  notes: z.string().max(8000).nullable().optional(),
});

const deliverablePatchSchema = patchSchemaOf(deliverableBodySchema);

const infoRequirementBodySchema = z.object({
  kind: z.enum(DESIGN_INFO_REQUIREMENT_KINDS).default("eir"),
  title: z.string().min(1).max(200),
  requirement: z.string().max(8000).nullable().optional(),
  stageKey: z.enum(DESIGN_STAGE_KEYS).nullable().optional(),
  packageId: idSchema.nullable().optional(),
  consultantId: idSchema.nullable().optional(),
  responsibleUserId: idSchema.nullable().optional(),
  responsibleVendorId: idSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  fileIds: fileIdsSchema.default([]),
});

const infoRequirementPatchSchema = patchSchemaOf(infoRequirementBodySchema);

export const deliverableRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate, adminGate } = buildGates(app);

  /* ---------------------------------------------------------------- */
  /* Consultants                                                      */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/design/consultants", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({
        status: z.enum(DESIGN_CONSULTANT_STATUSES).optional(),
        discipline: z.enum(DESIGN_DISCIPLINES).optional(),
      })
      .parse(req.query);
    const where = and(
      eq(designConsultants.companyId, req.companyId!),
      eq(designConsultants.projectId, projectId),
      q.status ? eq(designConsultants.status, q.status) : undefined,
      q.discipline ? eq(designConsultants.discipline, q.discipline) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db
        .select()
        .from(designConsultants)
        .where(where)
        .orderBy(asc(designConsultants.name))
        .limit(q.pageSize)
        .offset(pageOffset(q)),
      app.db.select({ n: count() }).from(designConsultants).where(where),
    ]);
    const asOf = todayISO();
    return paginate(
      rows.map((row) => ({
        ...row,
        pi: assessPi(
          {
            id: row.id,
            name: row.name,
            status: row.status,
            piRequiredAmount: row.piRequiredAmount,
            piCoverAmount: row.piCoverAmount,
            piCurrency: row.piCurrency,
            piExpiresOn: row.piExpiresOn,
          },
          asOf,
        ),
      })),
      total?.n ?? 0,
      q,
    );
  });

  app.post("/projects/:projectId/design/consultants", { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = consultantBodySchema.parse(req.body);
    const companyId = req.companyId!;
    if (body.vendorId) await assertVendor(app.db, companyId, body.vendorId);
    const id = newId("dcn");
    const [inserted] = await app.db
      .insert(designConsultants)
      .values({
        id,
        companyId,
        projectId,
        vendorId: body.vendorId ?? null,
        name: body.name,
        discipline: body.discipline,
        role: body.role ?? null,
        appointmentRef: body.appointmentRef ?? null,
        commitmentId: body.commitmentId ?? null,
        appointedAt: body.appointedAt ?? null,
        feeValue: body.feeValue ?? null,
        currency: body.currency,
        contactName: body.contactName ?? null,
        contactEmail: body.contactEmail ?? null,
        piRequiredAmount: body.piRequiredAmount ?? null,
        piCoverAmount: body.piCoverAmount ?? null,
        piCurrency: body.piCurrency ?? null,
        piExpiresOn: body.piExpiresOn ?? null,
        piInsurerName: body.piInsurerName ?? null,
        piPolicyNumber: body.piPolicyNumber ?? null,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "design_consultant",
      objectId: id,
      payload: { name: body.name, discipline: body.discipline, vendorId: body.vendorId ?? null },
    });
    return reply.code(201).send(inserted);
  });

  app.patch("/projects/:projectId/design/consultants/:consultantId", { preHandler: standardGate }, async (req) => {
    const { projectId, consultantId } = req.params as { projectId: string; consultantId: string };
    const body = consultantPatchSchema.parse(req.body);
    const companyId = req.companyId!;
    await assertConsultant(app.db, companyId, projectId, consultantId);
    if (body.vendorId) await assertVendor(app.db, companyId, body.vendorId);
    const set = patchSet(body as Record<string, unknown>, [
      "name",
      "vendorId",
      "discipline",
      "role",
      "appointmentRef",
      "commitmentId",
      "appointedAt",
      "feeValue",
      "currency",
      "contactName",
      "contactEmail",
      "piRequiredAmount",
      "piCoverAmount",
      "piCurrency",
      "piExpiresOn",
      "piInsurerName",
      "piPolicyNumber",
      "notes",
    ]);
    // Changing the cover invalidates the previous verification and the signal.
    if ("piCoverAmount" in body || "piExpiresOn" in body || "piRequiredAmount" in body) {
      set["piVerifiedBy"] = null;
      set["piVerifiedAt"] = null;
      set["piSignalId"] = null;
    }
    const [updated] = await app.db
      .update(designConsultants)
      .set(set)
      .where(eq(designConsultants.id, consultantId))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "design_consultant",
      objectId: consultantId,
      payload: { keys: Object.keys(set).filter((k) => k !== "updatedAt") },
    });
    return updated;
  });

  /** PI cover is verified by someone who did not record it (#912). */
  app.post("/projects/:projectId/design/consultants/:consultantId/verify-pi", { preHandler: standardGate }, async (req) => {
    const { projectId, consultantId } = req.params as { projectId: string; consultantId: string };
    const body = z.object({ note: z.string().max(2000).optional() }).parse(req.body ?? {});
    const companyId = req.companyId!;
    const row = await assertConsultant(app.db, companyId, projectId, consultantId);
    if (row.createdBy === req.user!.id) {
      throw forbidden(
        "Professional indemnity cover is verified by someone other than whoever recorded it — otherwise the check is the same person reading their own typing.",
      );
    }
    if (row.piCoverAmount === null) {
      throw badRequest("There is no cover amount to verify. Record the policy first.");
    }
    const [updated] = await app.db
      .update(designConsultants)
      .set({ piVerifiedBy: req.user!.id, piVerifiedAt: nowISO(), updatedAt: nowISO() })
      .where(eq(designConsultants.id, consultantId))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_consultant",
      objectId: consultantId,
      payload: { piVerified: true, note: body.note ?? null, cover: row.piCoverAmount, expiresOn: row.piExpiresOn },
    });
    return updated;
  });

  app.post("/projects/:projectId/design/consultants/pi-check", { preHandler: standardGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    return sweepProfessionalIndemnity(app.db, req.companyId!, projectId, req.user!.id);
  });

  /* ---------------------------------------------------------------- */
  /* Deliverables                                                     */
  /* ---------------------------------------------------------------- */

  async function loadDeliverable(companyId: string, projectId: string, id: string) {
    const [row] = await app.db
      .select()
      .from(designDeliverables)
      .where(
        and(
          eq(designDeliverables.id, id),
          eq(designDeliverables.companyId, companyId),
          eq(designDeliverables.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Design deliverable not found");
    return row;
  }

  async function validateDeliverableRefs(
    companyId: string,
    projectId: string,
    body: Partial<z.infer<typeof deliverableBodySchema>>,
  ) {
    if (body.packageId) await assertPackage(app.db, companyId, projectId, body.packageId);
    if (body.consultantId) await assertConsultant(app.db, companyId, projectId, body.consultantId);
    if (body.vendorId) await assertVendor(app.db, companyId, body.vendorId);
    if (body.scheduleTaskId) await loadTask(app.db, projectId, body.scheduleTaskId);
  }

  app.get("/projects/:projectId/design/deliverables", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({
        status: z.enum(DESIGN_DELIVERABLE_STATUSES).optional(),
        slippageLevel: z.enum(DESIGN_SLIPPAGE_LEVELS).optional(),
        discipline: z.enum(DESIGN_DISCIPLINES).optional(),
        consultantId: idSchema.optional(),
        packageId: idSchema.optional(),
        q: z.string().max(120).optional(),
      })
      .parse(req.query);
    const where = and(
      eq(designDeliverables.companyId, req.companyId!),
      eq(designDeliverables.projectId, projectId),
      q.status ? eq(designDeliverables.status, q.status) : undefined,
      q.slippageLevel ? eq(designDeliverables.slippageLevel, q.slippageLevel) : undefined,
      q.discipline ? eq(designDeliverables.discipline, q.discipline) : undefined,
      q.consultantId ? eq(designDeliverables.consultantId, q.consultantId) : undefined,
      q.packageId ? eq(designDeliverables.packageId, q.packageId) : undefined,
      q.q
        ? or(ilike(designDeliverables.title, `%${q.q}%`), ilike(designDeliverables.reference, `%${q.q}%`))
        : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db
        .select()
        .from(designDeliverables)
        .where(where)
        .orderBy(asc(designDeliverables.plannedIssueDate), asc(designDeliverables.number))
        .limit(q.pageSize)
        .offset(pageOffset(q)),
      app.db.select({ n: count() }).from(designDeliverables).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post("/projects/:projectId/design/deliverables", { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = deliverableBodySchema.parse(req.body);
    const companyId = req.companyId!;
    await validateDeliverableRefs(companyId, projectId, body);
    const { number, reference } = await allocateReference(app.db, projectId, "design_deliverable", "DLV");
    const id = newId("ddl");
    const [inserted] = await app.db
      .insert(designDeliverables)
      .values({
        id,
        companyId,
        projectId,
        number,
        reference,
        title: body.title,
        description: body.description ?? null,
        deliverableType: body.deliverableType,
        discipline: body.discipline,
        packageId: body.packageId ?? null,
        consultantId: body.consultantId ?? null,
        vendorId: body.vendorId ?? null,
        stageKey: body.stageKey ?? null,
        infoRequirementId: body.infoRequirementId ?? null,
        scheduleTaskId: body.scheduleTaskId ?? null,
        requiredOnSite: body.requiredOnSite ?? null,
        plannedIssueDate: body.plannedIssueDate ?? null,
        forecastIssueDate: body.forecastIssueDate ?? null,
        revision: body.revision ?? null,
        drawingSheetIds: body.drawingSheetIds,
        fileIds: body.fileIds,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    if (!inserted) throw badRequest("The deliverable could not be created.");
    const assessed = await assessDeliverableRow(app.db, inserted, todayISO());
    await persistDeliverableAssessment(app.db, inserted, assessed);
    await syncDeliverableObligation(app.db, inserted, req.user!.id);
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "design_deliverable",
      objectId: id,
      payload: { reference, plannedIssueDate: body.plannedIssueDate ?? null, slippageLevel: assessed.level },
    });
    const fresh = await loadDeliverable(companyId, projectId, id);
    return reply.code(201).send({ ...fresh, assessment: assessed });
  });

  app.get("/projects/:projectId/design/deliverables/:deliverableId", { preHandler: readGate }, async (req) => {
    const { projectId, deliverableId } = req.params as { projectId: string; deliverableId: string };
    const companyId = req.companyId!;
    const row = await loadDeliverable(companyId, projectId, deliverableId);
    const assessment = await assessDeliverableRow(app.db, row, todayISO());
    const [consultant, obligation] = await Promise.all([
      row.consultantId
        ? app.db.select().from(designConsultants).where(eq(designConsultants.id, row.consultantId)).limit(1)
        : Promise.resolve([]),
      row.obligationId
        ? app.db.select().from(obligations).where(eq(obligations.id, row.obligationId)).limit(1)
        : Promise.resolve([]),
    ]);
    const task = row.scheduleTaskId ? await loadTask(app.db, projectId, row.scheduleTaskId).catch(() => null) : null;
    return { ...row, assessment, consultant: consultant[0] ?? null, obligation: obligation[0] ?? null, task };
  });

  app.patch("/projects/:projectId/design/deliverables/:deliverableId", { preHandler: standardGate }, async (req) => {
    const { projectId, deliverableId } = req.params as { projectId: string; deliverableId: string };
    const body = deliverablePatchSchema.parse(req.body);
    const companyId = req.companyId!;
    const row = await loadDeliverable(companyId, projectId, deliverableId);
    if (row.status === "accepted") {
      throw conflict("An accepted deliverable is a record. Register the next revision instead of editing it.");
    }
    await validateDeliverableRefs(companyId, projectId, body);
    const set = patchSet(body as Record<string, unknown>, [
      "title",
      "description",
      "deliverableType",
      "discipline",
      "packageId",
      "consultantId",
      "vendorId",
      "stageKey",
      "infoRequirementId",
      "scheduleTaskId",
      "requiredOnSite",
      "plannedIssueDate",
      "forecastIssueDate",
      "revision",
      "drawingSheetIds",
      "fileIds",
      "notes",
    ]);
    await app.db.update(designDeliverables).set(set).where(eq(designDeliverables.id, deliverableId));
    let updated = await loadDeliverable(companyId, projectId, deliverableId);
    // A moved planned date is a new obligation deadline: close the old one so
    // an obligation never points at a date the record no longer claims.
    if (body.plannedIssueDate !== undefined && body.plannedIssueDate !== row.plannedIssueDate && row.obligationId) {
      await app.db
        .update(obligations)
        .set({ status: "waived" })
        .where(and(eq(obligations.id, row.obligationId), eq(obligations.status, "open")));
      await app.db
        .update(designDeliverables)
        .set({ obligationId: null, lateSignalId: null, updatedAt: nowISO() })
        .where(eq(designDeliverables.id, deliverableId));
      updated = await loadDeliverable(companyId, projectId, deliverableId);
    }
    const assessed = await assessDeliverableRow(app.db, updated, todayISO());
    await persistDeliverableAssessment(app.db, updated, assessed);
    await syncDeliverableObligation(app.db, updated, req.user!.id);
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "design_deliverable",
      objectId: deliverableId,
      payload: { keys: Object.keys(set).filter((k) => k !== "updatedAt"), slippageLevel: assessed.level },
    });
    const fresh = await loadDeliverable(companyId, projectId, deliverableId);
    return { ...fresh, assessment: assessed };
  });

  app.post("/projects/:projectId/design/deliverables/:deliverableId/issue", { preHandler: standardGate }, async (req) => {
    const { projectId, deliverableId } = req.params as { projectId: string; deliverableId: string };
    const body = z
      .object({
        actualIssueDate: isoDateSchema.optional(),
        revision: z.string().max(20).optional(),
        fileIds: fileIdsSchema.optional(),
        drawingSheetIds: z.array(idSchema).max(200).optional(),
        note: z.string().max(4000).optional(),
      })
      .parse(req.body ?? {});
    const companyId = req.companyId!;
    const row = await loadDeliverable(companyId, projectId, deliverableId);
    if (row.actualIssueDate) throw conflict(`${row.reference} was already issued on ${row.actualIssueDate}.`);
    if (row.status === "cancelled") throw conflict("A cancelled deliverable cannot be issued.");
    const set: Record<string, unknown> = {
      actualIssueDate: body.actualIssueDate ?? todayISO(),
      status: "issued",
      rejectedAt: null,
      rejectedReason: null,
      updatedAt: nowISO(),
    };
    if (body.revision) set["revision"] = body.revision;
    if (body.fileIds) set["fileIds"] = body.fileIds;
    if (body.drawingSheetIds) set["drawingSheetIds"] = body.drawingSheetIds;
    await app.db.update(designDeliverables).set(set).where(eq(designDeliverables.id, deliverableId));
    const updated = await loadDeliverable(companyId, projectId, deliverableId);
    const assessed = await assessDeliverableRow(app.db, updated, todayISO());
    await persistDeliverableAssessment(app.db, updated, assessed);
    await syncDeliverableObligation(app.db, updated, req.user!.id);
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_deliverable",
      objectId: deliverableId,
      payload: {
        to: "issued",
        actualIssueDate: set["actualIssueDate"],
        plannedIssueDate: row.plannedIssueDate,
        slippageDays: assessed.slippageDays,
        note: body.note ?? null,
      },
    });
    const fresh = await loadDeliverable(companyId, projectId, deliverableId);
    return { ...fresh, assessment: assessed };
  });

  /** Acceptance is by someone other than whoever issued it. */
  app.post("/projects/:projectId/design/deliverables/:deliverableId/accept", { preHandler: standardGate }, async (req) => {
    const { projectId, deliverableId } = req.params as { projectId: string; deliverableId: string };
    const body = z.object({ note: z.string().max(4000).optional() }).parse(req.body ?? {});
    const companyId = req.companyId!;
    const row = await loadDeliverable(companyId, projectId, deliverableId);
    if (row.status !== "issued") throw badRequest("Only an issued deliverable can be accepted.");
    if (row.createdBy === req.user!.id) {
      throw forbidden(
        "A deliverable is accepted by someone other than the person who registered and issued it. Otherwise acceptance records nothing.",
      );
    }
    const [updated] = await app.db
      .update(designDeliverables)
      .set({ status: "accepted", acceptedAt: nowISO(), acceptedBy: req.user!.id, updatedAt: nowISO() })
      .where(eq(designDeliverables.id, deliverableId))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_deliverable",
      objectId: deliverableId,
      payload: { to: "accepted", note: body.note ?? null },
    });
    return updated;
  });

  app.post("/projects/:projectId/design/deliverables/:deliverableId/reject", { preHandler: standardGate }, async (req) => {
    const { projectId, deliverableId } = req.params as { projectId: string; deliverableId: string };
    const body = z.object({ reason: z.string().min(1).max(4000) }).parse(req.body);
    const companyId = req.companyId!;
    const row = await loadDeliverable(companyId, projectId, deliverableId);
    if (row.status !== "issued") throw badRequest("Only an issued deliverable can be rejected.");
    // Rejection returns the deliverable to outstanding: the issue no longer counts.
    await app.db
      .update(designDeliverables)
      .set({
        status: "rejected",
        rejectedAt: nowISO(),
        rejectedReason: body.reason,
        actualIssueDate: null,
        acceptedAt: null,
        acceptedBy: null,
        updatedAt: nowISO(),
      })
      .where(eq(designDeliverables.id, deliverableId));
    const updated = await loadDeliverable(companyId, projectId, deliverableId);
    const assessed = await assessDeliverableRow(app.db, updated, todayISO());
    await persistDeliverableAssessment(app.db, updated, assessed);
    await syncDeliverableObligation(app.db, updated, req.user!.id);
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_deliverable",
      objectId: deliverableId,
      payload: { to: "rejected", reason: body.reason },
    });
    if (row.createdBy !== req.user!.id) {
      await pushNotifications(app.db, [
        {
          companyId,
          userId: row.createdBy,
          projectId,
          kind: "design",
          title: `Deliverable ${row.reference} rejected`,
          body: body.reason.slice(0, 240),
          recordType: "design_deliverable",
          recordId: deliverableId,
        },
      ]);
    }
    const fresh = await loadDeliverable(companyId, projectId, deliverableId);
    return { ...fresh, assessment: assessed };
  });

  app.post("/projects/:projectId/design/deliverables/recompute", { preHandler: standardGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    return sweepDeliverables(app.db, req.companyId!, projectId, req.user!.id);
  });

  app.get("/projects/:projectId/design/deliverables-performance", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const rows = await app.db
      .select({
        id: designDeliverables.id,
        consultantId: designDeliverables.consultantId,
        discipline: designDeliverables.discipline,
        packageId: designDeliverables.packageId,
        status: designDeliverables.status,
        slippageLevel: designDeliverables.slippageLevel,
        slippageDays: designDeliverables.slippageDays,
        plannedIssueDate: designDeliverables.plannedIssueDate,
        actualIssueDate: designDeliverables.actualIssueDate,
      })
      .from(designDeliverables)
      .where(and(eq(designDeliverables.companyId, req.companyId!), eq(designDeliverables.projectId, projectId)));
    const consultants = await app.db
      .select({ id: designConsultants.id, name: designConsultants.name, discipline: designConsultants.discipline })
      .from(designConsultants)
      .where(and(eq(designConsultants.companyId, req.companyId!), eq(designConsultants.projectId, projectId)));
    const names = new Map(consultants.map((c) => [c.id, c.name]));
    return {
      overall: slippageStats(rows),
      byConsultant: slippageByConsultant(rows).map((entry) => ({
        ...entry,
        name: entry.consultantId ? names.get(entry.consultantId) ?? entry.consultantId : "Unattributed",
      })),
    };
  });

  /* ---------------------------------------------------------------- */
  /* Information requirements                                         */
  /* ---------------------------------------------------------------- */

  async function loadInfoRequirement(companyId: string, projectId: string, id: string) {
    const [row] = await app.db
      .select()
      .from(designInfoRequirements)
      .where(
        and(
          eq(designInfoRequirements.id, id),
          eq(designInfoRequirements.companyId, companyId),
          eq(designInfoRequirements.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Information requirement not found");
    return row;
  }

  app.get("/projects/:projectId/design/information-requirements", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({
        status: z.enum(DESIGN_INFO_REQUIREMENT_STATUSES).optional(),
        kind: z.enum(DESIGN_INFO_REQUIREMENT_KINDS).optional(),
      })
      .parse(req.query);
    const where = and(
      eq(designInfoRequirements.companyId, req.companyId!),
      eq(designInfoRequirements.projectId, projectId),
      q.status ? eq(designInfoRequirements.status, q.status) : undefined,
      q.kind ? eq(designInfoRequirements.kind, q.kind) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db
        .select()
        .from(designInfoRequirements)
        .where(where)
        .orderBy(asc(designInfoRequirements.dueDate), asc(designInfoRequirements.number))
        .limit(q.pageSize)
        .offset(pageOffset(q)),
      app.db.select({ n: count() }).from(designInfoRequirements).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post("/projects/:projectId/design/information-requirements", { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = infoRequirementBodySchema.parse(req.body);
    const companyId = req.companyId!;
    if (body.packageId) await assertPackage(app.db, companyId, projectId, body.packageId);
    if (body.consultantId) await assertConsultant(app.db, companyId, projectId, body.consultantId);
    if (body.responsibleUserId) await assertUser(app.db, body.responsibleUserId);
    if (body.responsibleVendorId) await assertVendor(app.db, companyId, body.responsibleVendorId);
    const { number, reference } = await allocateReference(app.db, projectId, "design_info_requirement", "IR");
    const id = newId("dir");
    const [inserted] = await app.db
      .insert(designInfoRequirements)
      .values({
        id,
        companyId,
        projectId,
        number,
        reference,
        kind: body.kind,
        title: body.title,
        requirement: body.requirement ?? null,
        stageKey: body.stageKey ?? null,
        packageId: body.packageId ?? null,
        consultantId: body.consultantId ?? null,
        responsibleUserId: body.responsibleUserId ?? null,
        responsibleVendorId: body.responsibleVendorId ?? null,
        dueDate: body.dueDate ?? null,
        fileIds: body.fileIds,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "design_info_requirement",
      objectId: id,
      payload: { reference, kind: body.kind, dueDate: body.dueDate ?? null },
    });
    return reply.code(201).send(inserted);
  });

  app.patch(
    "/projects/:projectId/design/information-requirements/:requirementId",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, requirementId } = req.params as { projectId: string; requirementId: string };
      const body = infoRequirementPatchSchema.parse(req.body);
      const companyId = req.companyId!;
      const row = await loadInfoRequirement(companyId, projectId, requirementId);
      if (row.status === "verified") {
        throw conflict("A verified information requirement is a record; raise a new requirement instead of editing it.");
      }
      if (body.packageId) await assertPackage(app.db, companyId, projectId, body.packageId);
      if (body.consultantId) await assertConsultant(app.db, companyId, projectId, body.consultantId);
      if (body.responsibleUserId) await assertUser(app.db, body.responsibleUserId);
      const set = patchSet(body as Record<string, unknown>, [
        "kind",
        "title",
        "requirement",
        "stageKey",
        "packageId",
        "consultantId",
        "responsibleUserId",
        "responsibleVendorId",
        "dueDate",
        "fileIds",
      ]);
      if (body.dueDate !== undefined && body.dueDate !== row.dueDate && row.obligationId) {
        await app.db
          .update(obligations)
          .set({ status: "waived" })
          .where(and(eq(obligations.id, row.obligationId), eq(obligations.status, "open")));
        set["obligationId"] = null;
        set["overdueSignalId"] = null;
        if (row.status === "overdue") set["status"] = "planned";
      }
      const [updated] = await app.db
        .update(designInfoRequirements)
        .set(set)
        .where(eq(designInfoRequirements.id, requirementId))
        .returning();
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "update",
        objectType: "design_info_requirement",
        objectId: requirementId,
        payload: { keys: Object.keys(set).filter((k) => k !== "updatedAt") },
      });
      return updated;
    },
  );

  app.post(
    "/projects/:projectId/design/information-requirements/:requirementId/deliver",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, requirementId } = req.params as { projectId: string; requirementId: string };
      const body = z.object({ fileIds: fileIdsSchema.optional(), note: z.string().max(4000).optional() }).parse(req.body ?? {});
      const companyId = req.companyId!;
      const row = await loadInfoRequirement(companyId, projectId, requirementId);
      if (row.status === "verified") throw conflict("This requirement has already been verified.");
      if (row.status === "waived") throw conflict("This requirement was waived.");
      const set: Record<string, unknown> = {
        status: "delivered",
        deliveredAt: nowISO(),
        deliveredBy: req.user!.id,
        updatedAt: nowISO(),
      };
      if (body.fileIds) set["fileIds"] = body.fileIds;
      const [updated] = await app.db
        .update(designInfoRequirements)
        .set(set)
        .where(eq(designInfoRequirements.id, requirementId))
        .returning();
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "design_info_requirement",
        objectId: requirementId,
        payload: { to: "delivered", note: body.note ?? null },
      });
      return updated;
    },
  );

  /** Verification is by someone other than the deliverer. */
  app.post(
    "/projects/:projectId/design/information-requirements/:requirementId/verify",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, requirementId } = req.params as { projectId: string; requirementId: string };
      const body = z.object({ note: z.string().max(4000).optional() }).parse(req.body ?? {});
      const companyId = req.companyId!;
      const row = await loadInfoRequirement(companyId, projectId, requirementId);
      if (row.status !== "delivered") throw badRequest("Only a delivered requirement can be verified.");
      if (row.deliveredBy === req.user!.id) {
        throw forbidden(
          "Verification must come from someone other than whoever delivered the information. An assertion and the evidence that tests it are never authored by the same actor.",
        );
      }
      const [updated] = await app.db
        .update(designInfoRequirements)
        .set({
          status: "verified",
          verifiedAt: nowISO(),
          verifiedBy: req.user!.id,
          verificationNote: body.note ?? null,
          updatedAt: nowISO(),
        })
        .where(eq(designInfoRequirements.id, requirementId))
        .returning();
      if (row.obligationId) {
        await app.db
          .update(obligations)
          .set({ status: "satisfied" })
          .where(and(eq(obligations.id, row.obligationId), eq(obligations.status, "open")));
      }
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "design_info_requirement",
        objectId: requirementId,
        payload: { to: "verified", note: body.note ?? null },
      });
      return updated;
    },
  );

  app.post(
    "/projects/:projectId/design/information-requirements/:requirementId/waive",
    { preHandler: adminGate },
    async (req) => {
      const { projectId, requirementId } = req.params as { projectId: string; requirementId: string };
      const body = z.object({ reason: z.string().min(1).max(4000) }).parse(req.body);
      const companyId = req.companyId!;
      const row = await loadInfoRequirement(companyId, projectId, requirementId);
      if (row.status === "waived") throw conflict("This requirement is already waived.");
      const [updated] = await app.db
        .update(designInfoRequirements)
        .set({ status: "waived", waivedAt: nowISO(), waivedBy: req.user!.id, waiveReason: body.reason, updatedAt: nowISO() })
        .where(eq(designInfoRequirements.id, requirementId))
        .returning();
      if (row.obligationId) {
        await app.db
          .update(obligations)
          .set({ status: "waived" })
          .where(and(eq(obligations.id, row.obligationId), eq(obligations.status, "open")));
      }
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "design_info_requirement",
        objectId: requirementId,
        payload: { to: "waived", reason: body.reason },
      });
      return updated;
    },
  );

  app.post("/projects/:projectId/design/information-requirements/sweep", { preHandler: standardGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    return sweepInfoRequirements(app.db, req.companyId!, projectId, req.user!.id);
  });

};
