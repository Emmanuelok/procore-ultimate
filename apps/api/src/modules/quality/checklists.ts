/**
 * Checklist templates and the checklists executed from them.
 *
 * A template is a CONTROLLED DOCUMENT: it is drafted, its items are typed,
 * somebody other than the author approves it, and only then may work be
 * recorded against it. Revisions supersede rather than overwrite, and every
 * executed checklist stamps the template version it was taken from — a form
 * that silently re-reads its questions from a mutable template is not
 * evidence of anything.
 *
 * The typing and the arithmetic live in ./checklistItems.ts, which is the one
 * implementation shared with safety inspections and prequalification
 * questionnaires. This file is the register and the consequences: what
 * happens when an item fails.
 */

import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  checklistResponses,
  checklists,
  checklistTemplateItems,
  checklistTemplates,
  itpActivities,
} from "@constructos/db";
import {
  CHECKLIST_CATEGORIES,
  CHECKLIST_ITEM_TYPES,
  CHECKLIST_STATUSES,
  INSPECTION_SCORING_METHODS,
  NCR_SEVERITIES,
  TEMPLATE_STATUSES,
  type NcrSeverity,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import {
  allocateReference,
  assertAsset,
  assertDistinctActor,
  assertLocation,
  assertVendor,
  buildGates,
  fileIdsSchema,
  idSchema,
  isoDateSchema,
  isoTimestampSchema,
  ledger,
  nowISO,
  todayISO,
} from "./shared.js";
import {
  answerIsPopulated,
  evaluateAnswerItem,
  scoreChecklist,
  validateAnswer,
  validateItemDefinition,
  type ChecklistAnswer,
  type ChecklistItemSpec,
  type ScoreEntry,
} from "./checklistItems.js";
import { createNcr, createPunchItemFor } from "./raise.js";
import { sweepQuality } from "./sweeps.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const templateItemSchema = z.object({
  section: z.string().max(200).nullable().optional(),
  position: z.number().int().min(0).max(100_000).optional(),
  itemNumber: z.string().max(50).nullable().optional(),
  text: z.string().min(1).max(2000),
  itemType: z.enum(CHECKLIST_ITEM_TYPES).optional(),
  required: z.boolean().optional(),
  options: z.array(z.string().min(1).max(300)).max(100).optional(),
  targetValue: z.number().finite().nullable().optional(),
  minValue: z.number().finite().nullable().optional(),
  maxValue: z.number().finite().nullable().optional(),
  tolerancePlus: z.number().finite().nullable().optional(),
  toleranceMinus: z.number().finite().nullable().optional(),
  unit: z.string().max(50).nullable().optional(),
  acceptanceCriteria: z.string().max(4000).nullable().optional(),
  guidance: z.string().max(4000).nullable().optional(),
  specReference: z.string().max(200).nullable().optional(),
  photoRequired: z.boolean().optional(),
  weight: z.number().finite().min(0).max(1000).optional(),
  isCritical: z.boolean().optional(),
  isHoldPoint: z.boolean().optional(),
  raisesNcrOnFail: z.boolean().optional(),
  /** severity stamped on an NCR this item raises; defaults from isCritical */
  ncrSeverity: z.enum(NCR_SEVERITIES).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const templateCreateSchema = z.object({
  reference: z.string().min(1).max(100),
  name: z.string().min(1).max(300),
  description: z.string().max(10_000).nullable().optional(),
  category: z.enum(CHECKLIST_CATEGORIES).optional(),
  projectId: idSchema.nullable().optional(),
  scoringMethod: z.enum(INSPECTION_SCORING_METHODS).optional(),
  passThreshold: z.number().min(0).max(100).nullable().optional(),
  specSectionId: idSchema.nullable().optional(),
  specSectionCode: z.string().max(100).nullable().optional(),
  appliesToTrades: z.array(z.string().max(100)).max(100).optional(),
  isStatutory: z.boolean().optional(),
  regulatoryBasis: z.string().max(500).nullable().optional(),
  requiredSignatures: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
  items: z.array(templateItemSchema).max(500).optional(),
});

const templatePatchSchema = templateCreateSchema.omit({ items: true, reference: true }).partial();

const templateListQuery = pageQuerySchema.extend({
  category: z.enum(CHECKLIST_CATEGORIES).optional(),
  status: z.enum(TEMPLATE_STATUSES).optional(),
  projectId: idSchema.optional(),
  includeCompanyStandards: z.coerce.boolean().optional(),
  search: z.string().max(200).optional(),
});

const checklistCreateSchema = z.object({
  templateId: idSchema.optional(),
  title: z.string().min(1).max(300).optional(),
  category: z.enum(CHECKLIST_CATEGORIES).optional(),
  locationId: idSchema.nullable().optional(),
  locationText: z.string().max(500).nullable().optional(),
  assetId: idSchema.nullable().optional(),
  equipmentId: idSchema.nullable().optional(),
  itpId: idSchema.nullable().optional(),
  itpActivityId: idSchema.nullable().optional(),
  specSectionId: idSchema.nullable().optional(),
  drawingSheetId: idSchema.nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  commitmentId: idSchema.nullable().optional(),
  scheduledFor: isoDateSchema.nullable().optional(),
  performedByName: z.string().max(200).nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const checklistPatchSchema = checklistCreateSchema.omit({ templateId: true }).partial().extend({
  photoFileIds: fileIdsSchema.optional(),
  reportFileId: idSchema.nullable().optional(),
});

const checklistListQuery = pageQuerySchema.extend({
  status: z.enum(CHECKLIST_STATUSES).optional(),
  category: z.enum(CHECKLIST_CATEGORIES).optional(),
  templateId: idSchema.optional(),
  itpId: idSchema.optional(),
  assetId: idSchema.optional(),
  vendorId: idSchema.optional(),
  result: z.enum(["pass", "pass_with_observations", "fail", "not_applicable"]).optional(),
  search: z.string().max(200).optional(),
});

const answerSchema = z.object({
  response: z.string().max(10_000).nullable().optional(),
  numericValue: z.number().finite().nullable().optional(),
  selectedOptions: z.array(z.string().max(300)).max(100).optional(),
  isNotApplicable: z.boolean().optional(),
  naReason: z.string().max(2000).nullable().optional(),
  note: z.string().max(4000).nullable().optional(),
  photoFileIds: fileIdsSchema.optional(),
  fileIds: fileIdsSchema.optional(),
  instrumentId: idSchema.nullable().optional(),
  instrumentSerial: z.string().max(200).nullable().optional(),
  measuredAt: isoTimestampSchema.nullable().optional(),
});

const bulkAnswerSchema = z.object({
  answers: z
    .array(answerSchema.extend({ responseId: idSchema.optional(), templateItemId: idSchema.optional() }))
    .min(1)
    .max(500),
});

const adhocItemSchema = templateItemSchema.extend({ itemType: z.enum(CHECKLIST_ITEM_TYPES) });

const completeSchema = z.object({
  performedAt: isoTimestampSchema.optional(),
  performedByName: z.string().max(200).nullable().optional(),
  photoFileIds: fileIdsSchema.optional(),
  reportFileId: idSchema.nullable().optional(),
  /** default due date stamped on any NCR this completion raises */
  ncrResponseDueDate: isoDateSchema.nullable().optional(),
});

const signOffSchema = z.object({
  name: z.string().max(200).nullable().optional(),
  signatureFileId: idSchema.nullable().optional(),
  note: z.string().max(4000).nullable().optional(),
});

const TEMPLATE_PATCH_COLUMNS = [
  "name",
  "description",
  "category",
  "scoringMethod",
  "passThreshold",
  "specSectionId",
  "specSectionCode",
  "appliesToTrades",
  "regulatoryBasis",
  "requiredSignatures",
  "detail",
] as const;

const CHECKLIST_PATCH_COLUMNS = [
  "title",
  "category",
  "locationId",
  "locationText",
  "assetId",
  "equipmentId",
  "itpId",
  "itpActivityId",
  "specSectionId",
  "drawingSheetId",
  "vendorId",
  "commitmentId",
  "scheduledFor",
  "performedByName",
  "photoFileIds",
  "reportFileId",
  "detail",
] as const;

const OPEN_CHECKLIST_STATUSES = ["draft", "scheduled", "in_progress"];

/* ------------------------------------------------------------------ */
/* Spec adapters                                                       */
/* ------------------------------------------------------------------ */

type TemplateItemRow = typeof checklistTemplateItems.$inferSelect;
type ResponseRow = typeof checklistResponses.$inferSelect;

export function specFromTemplateItem(row: TemplateItemRow): ChecklistItemSpec {
  return {
    id: row.id,
    itemNumber: row.itemNumber,
    text: row.text,
    itemType: row.itemType,
    required: row.required === 1,
    options: row.options,
    targetValue: row.targetValue,
    minValue: row.minValue,
    maxValue: row.maxValue,
    tolerancePlus: row.tolerancePlus,
    toleranceMinus: row.toleranceMinus,
    unit: row.unit,
    weight: row.weight,
    isCritical: row.isCritical === 1,
    photoRequired: row.photoRequired === 1,
    raisesNcrOnFail: row.raisesNcrOnFail === 1,
  };
}

/**
 * An ad-hoc checklist (one taken without a template) carries its item
 * definition on the response row itself, under `detail.itemSpec`. The
 * definition is still typed and still judged by the same engine — the only
 * thing it lacks is a controlled template behind it, which is recorded rather
 * than hidden.
 */
export function specFromResponse(row: ResponseRow): ChecklistItemSpec {
  const detail = (row.detail ?? {}) as Record<string, unknown>;
  const raw = (detail["itemSpec"] ?? {}) as Record<string, unknown>;
  const num = (key: string): number | null =>
    typeof raw[key] === "number" && Number.isFinite(raw[key]) ? (raw[key] as number) : null;
  return {
    id: row.id,
    itemNumber: row.itemNumber,
    text: row.questionText,
    itemType: row.itemType,
    required: raw["required"] === true,
    options: Array.isArray(raw["options"]) ? (raw["options"] as string[]) : [],
    targetValue: num("targetValue"),
    minValue: num("minValue"),
    maxValue: num("maxValue"),
    tolerancePlus: num("tolerancePlus"),
    toleranceMinus: num("toleranceMinus"),
    unit: row.unit,
    weight: typeof raw["weight"] === "number" ? (raw["weight"] as number) : 1,
    isCritical: raw["isCritical"] === true,
    photoRequired: raw["photoRequired"] === true,
    raisesNcrOnFail: raw["raisesNcrOnFail"] === true,
  };
}

function answerFromRow(row: ResponseRow): ChecklistAnswer {
  return {
    response: row.response,
    numericValue: row.numericValue,
    selectedOptions: row.selectedOptions,
    isNotApplicable: row.isNotApplicable === 1,
    naReason: row.naReason,
    photoFileIds: row.photoFileIds,
    fileIds: row.fileIds,
  };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const checklistRoutes: FastifyPluginAsync = async (app) => {
  const { memberGate, readGate, standardGate } = buildGates(app);

  /* ---------------------------------------------------------------- */
  /* Templates (company-scoped)                                        */
  /* ---------------------------------------------------------------- */

  async function fetchTemplate(templateId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(checklistTemplates)
      .where(
        and(eq(checklistTemplates.id, templateId), eq(checklistTemplates.companyId, companyId)),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Checklist template not found");
    return rows[0];
  }

  async function loadTemplateItems(templateId: string) {
    return app.db
      .select()
      .from(checklistTemplateItems)
      .where(eq(checklistTemplateItems.templateId, templateId))
      .orderBy(asc(checklistTemplateItems.position), asc(checklistTemplateItems.createdAt));
  }

  async function refreshItemCount(templateId: string) {
    const [row] = await app.db
      .select({ n: count() })
      .from(checklistTemplateItems)
      .where(eq(checklistTemplateItems.templateId, templateId));
    await app.db
      .update(checklistTemplates)
      .set({ itemCount: Number(row?.n ?? 0), updatedAt: nowISO() })
      .where(eq(checklistTemplates.id, templateId));
  }

  function insertItemValues(
    template: typeof checklistTemplates.$inferSelect,
    item: z.infer<typeof templateItemSchema>,
    position: number,
  ) {
    const validation = validateItemDefinition({
      itemType: item.itemType ?? "pass_fail",
      options: item.options ?? [],
      targetValue: item.targetValue ?? null,
      minValue: item.minValue ?? null,
      maxValue: item.maxValue ?? null,
      tolerancePlus: item.tolerancePlus ?? null,
      toleranceMinus: item.toleranceMinus ?? null,
      isCritical: item.isCritical ?? false,
      raisesNcrOnFail: item.raisesNcrOnFail ?? false,
      weight: item.weight ?? 1,
    });
    if (!validation.ok) {
      throw badRequest(`Item "${item.text}" cannot be judged as defined. ${validation.errors.join(" ")}`);
    }
    return {
      id: newId("cti"),
      companyId: template.companyId,
      projectId: template.projectId,
      templateId: template.id,
      section: item.section ?? null,
      position,
      itemNumber: item.itemNumber ?? null,
      text: item.text,
      itemType: item.itemType ?? "pass_fail",
      required: item.required === false ? 0 : 1,
      options: item.options ?? [],
      targetValue: item.targetValue ?? null,
      minValue: item.minValue ?? null,
      maxValue: item.maxValue ?? null,
      tolerancePlus: item.tolerancePlus ?? null,
      toleranceMinus: item.toleranceMinus ?? null,
      unit: item.unit ?? null,
      acceptanceCriteria: item.acceptanceCriteria ?? null,
      guidance: item.guidance ?? null,
      specReference: item.specReference ?? null,
      photoRequired: item.photoRequired ? 1 : 0,
      weight: item.weight ?? 1,
      isCritical: item.isCritical ? 1 : 0,
      isHoldPoint: item.isHoldPoint ? 1 : 0,
      raisesNcrOnFail: item.raisesNcrOnFail ? 1 : 0,
      detail: {
        ...(item.detail ?? {}),
        ...(item.ncrSeverity ? { ncrSeverity: item.ncrSeverity } : {}),
      },
    } satisfies typeof checklistTemplateItems.$inferInsert;
  }

  app.post("/companies/current/checklist-templates", { preHandler: memberGate }, async (req, reply) => {
    const body = templateCreateSchema.parse(req.body);
    const dupe = await app.db
      .select({ id: checklistTemplates.id })
      .from(checklistTemplates)
      .where(
        and(
          eq(checklistTemplates.companyId, req.companyId!),
          eq(checklistTemplates.reference, body.reference),
          eq(checklistTemplates.version, 1),
        ),
      )
      .limit(1);
    if (dupe[0]) {
      throw conflict(
        `Template reference "${body.reference}" version 1 already exists in this company. Revise the existing template rather than starting a second one under the same reference.`,
      );
    }
    const id = newId("clt");
    const [created] = await app.db
      .insert(checklistTemplates)
      .values({
        id,
        companyId: req.companyId!,
        projectId: body.projectId ?? null,
        reference: body.reference,
        name: body.name,
        description: body.description ?? null,
        category: body.category ?? "quality",
        scoringMethod: body.scoringMethod ?? "pass_fail",
        passThreshold: body.passThreshold ?? null,
        specSectionId: body.specSectionId ?? null,
        specSectionCode: body.specSectionCode ?? null,
        appliesToTrades: body.appliesToTrades ?? [],
        isStatutory: body.isStatutory ? 1 : 0,
        regulatoryBasis: body.regulatoryBasis ?? null,
        requiredSignatures: body.requiredSignatures ?? [],
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      })
      .returning();
    for (const [index, item] of (body.items ?? []).entries()) {
      await app.db
        .insert(checklistTemplateItems)
        .values(insertItemValues(created!, item, item.position ?? (index + 1) * 10));
    }
    await refreshItemCount(id);
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: body.projectId ?? null,
      actorId: req.user!.id,
      action: "create",
      objectType: "checklist_template",
      objectId: id,
      payload: { ...created, itemCount: (body.items ?? []).length },
      storePayload: true,
    });
    const template = await fetchTemplate(id, req.companyId!);
    return reply.status(201).send({ ...template, items: await loadTemplateItems(id) });
  });

  app.get("/companies/current/checklist-templates", { preHandler: memberGate }, async (req) => {
    const q = templateListQuery.parse(req.query);
    const clauses = [eq(checklistTemplates.companyId, req.companyId!)];
    if (q.category) clauses.push(eq(checklistTemplates.category, q.category));
    if (q.status) clauses.push(eq(checklistTemplates.status, q.status));
    if (q.projectId) {
      clauses.push(
        q.includeCompanyStandards === false
          ? eq(checklistTemplates.projectId, q.projectId)
          : or(
              eq(checklistTemplates.projectId, q.projectId),
              isNull(checklistTemplates.projectId),
            )!,
      );
    }
    if (q.search) clauses.push(ilike(checklistTemplates.name, `%${q.search}%`));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(checklistTemplates).where(where);
    const items = await app.db
      .select()
      .from(checklistTemplates)
      .where(where)
      .orderBy(asc(checklistTemplates.reference), desc(checklistTemplates.version))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get(
    "/companies/current/checklist-templates/:templateId",
    { preHandler: memberGate },
    async (req) => {
      const { templateId } = req.params as { templateId: string };
      const template = await fetchTemplate(templateId, req.companyId!);
      return { ...template, items: await loadTemplateItems(templateId) };
    },
  );

  app.patch(
    "/companies/current/checklist-templates/:templateId",
    { preHandler: memberGate },
    async (req) => {
      const { templateId } = req.params as { templateId: string };
      const body = templatePatchSchema.parse(req.body);
      const template = await fetchTemplate(templateId, req.companyId!);
      if (template.status !== "draft") {
        throw badRequest(
          `Template ${template.reference} v${template.version} is ${template.status}. An issued form is revised, not edited — POST /companies/current/checklist-templates/${templateId}/revise.`,
        );
      }
      const set: Record<string, unknown> = { updatedAt: nowISO() };
      for (const key of TEMPLATE_PATCH_COLUMNS) {
        const value = (body as Record<string, unknown>)[key];
        if (value !== undefined) set[key] = value;
      }
      if (body.isStatutory !== undefined) set["isStatutory"] = body.isStatutory ? 1 : 0;
      await app.db.update(checklistTemplates).set(set).where(eq(checklistTemplates.id, templateId));
      await ledger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "checklist_template",
        objectId: templateId,
        payload: { changed: Object.keys(body) },
      });
      const updated = await fetchTemplate(templateId, req.companyId!);
      return { ...updated, items: await loadTemplateItems(templateId) };
    },
  );

  app.post(
    "/companies/current/checklist-templates/:templateId/items",
    { preHandler: memberGate },
    async (req, reply) => {
      const { templateId } = req.params as { templateId: string };
      const body = templateItemSchema.parse(req.body);
      const template = await fetchTemplate(templateId, req.companyId!);
      if (template.status !== "draft") {
        throw badRequest(
          `Template ${template.reference} v${template.version} is ${template.status}; items are added to a draft.`,
        );
      }
      const existing = await loadTemplateItems(templateId);
      const position =
        body.position ??
        (existing.length > 0 ? Math.max(...existing.map((i) => i.position)) + 10 : 10);
      const [created] = await app.db
        .insert(checklistTemplateItems)
        .values(insertItemValues(template, body, position))
        .returning();
      await refreshItemCount(templateId);
      await ledger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "checklist_template_item",
        objectId: created!.id,
        payload: created,
        storePayload: true,
      });
      return reply.status(201).send(created);
    },
  );

  app.patch(
    "/companies/current/checklist-templates/:templateId/items/:itemId",
    { preHandler: memberGate },
    async (req) => {
      const { templateId, itemId } = req.params as { templateId: string; itemId: string };
      const body = templateItemSchema.partial().parse(req.body);
      const template = await fetchTemplate(templateId, req.companyId!);
      if (template.status !== "draft") {
        throw badRequest(`Template ${template.reference} v${template.version} is ${template.status}.`);
      }
      const rows = await app.db
        .select()
        .from(checklistTemplateItems)
        .where(
          and(
            eq(checklistTemplateItems.id, itemId),
            eq(checklistTemplateItems.templateId, templateId),
          ),
        )
        .limit(1);
      const existing = rows[0];
      if (!existing) throw notFound("Template item not found");
      const merged = {
        itemType: body.itemType ?? existing.itemType,
        options: body.options ?? existing.options,
        targetValue: body.targetValue !== undefined ? body.targetValue : existing.targetValue,
        minValue: body.minValue !== undefined ? body.minValue : existing.minValue,
        maxValue: body.maxValue !== undefined ? body.maxValue : existing.maxValue,
        tolerancePlus:
          body.tolerancePlus !== undefined ? body.tolerancePlus : existing.tolerancePlus,
        toleranceMinus:
          body.toleranceMinus !== undefined ? body.toleranceMinus : existing.toleranceMinus,
        isCritical: body.isCritical ?? existing.isCritical === 1,
        raisesNcrOnFail: body.raisesNcrOnFail ?? existing.raisesNcrOnFail === 1,
        weight: body.weight ?? existing.weight,
      };
      const validation = validateItemDefinition(merged);
      if (!validation.ok) throw badRequest(validation.errors.join(" "));
      const set: Record<string, unknown> = { updatedAt: nowISO(), ...merged };
      set["isCritical"] = merged.isCritical ? 1 : 0;
      set["raisesNcrOnFail"] = merged.raisesNcrOnFail ? 1 : 0;
      if (body.text !== undefined) set["text"] = body.text;
      if (body.section !== undefined) set["section"] = body.section;
      if (body.position !== undefined) set["position"] = body.position;
      if (body.itemNumber !== undefined) set["itemNumber"] = body.itemNumber;
      if (body.required !== undefined) set["required"] = body.required ? 1 : 0;
      if (body.unit !== undefined) set["unit"] = body.unit;
      if (body.acceptanceCriteria !== undefined) set["acceptanceCriteria"] = body.acceptanceCriteria;
      if (body.guidance !== undefined) set["guidance"] = body.guidance;
      if (body.specReference !== undefined) set["specReference"] = body.specReference;
      if (body.photoRequired !== undefined) set["photoRequired"] = body.photoRequired ? 1 : 0;
      if (body.isHoldPoint !== undefined) set["isHoldPoint"] = body.isHoldPoint ? 1 : 0;
      await app.db
        .update(checklistTemplateItems)
        .set(set)
        .where(eq(checklistTemplateItems.id, itemId));
      await ledger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "checklist_template_item",
        objectId: itemId,
        payload: { changed: Object.keys(body) },
      });
      const [updated] = await app.db
        .select()
        .from(checklistTemplateItems)
        .where(eq(checklistTemplateItems.id, itemId));
      return updated;
    },
  );

  app.delete(
    "/companies/current/checklist-templates/:templateId/items/:itemId",
    { preHandler: memberGate },
    async (req) => {
      const { templateId, itemId } = req.params as { templateId: string; itemId: string };
      const template = await fetchTemplate(templateId, req.companyId!);
      if (template.status !== "draft") {
        throw badRequest(`Template ${template.reference} v${template.version} is ${template.status}.`);
      }
      const deleted = await app.db
        .delete(checklistTemplateItems)
        .where(
          and(
            eq(checklistTemplateItems.id, itemId),
            eq(checklistTemplateItems.templateId, templateId),
          ),
        )
        .returning({ id: checklistTemplateItems.id });
      if (!deleted[0]) throw notFound("Template item not found");
      await refreshItemCount(templateId);
      await ledger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "checklist_template_item",
        objectId: itemId,
        payload: { templateId },
      });
      return { ok: true };
    },
  );

  /** Issue the form. Never the author — an unreviewed form is not a control. */
  app.post(
    "/companies/current/checklist-templates/:templateId/approve",
    { preHandler: memberGate },
    async (req) => {
      const { templateId } = req.params as { templateId: string };
      const template = await fetchTemplate(templateId, req.companyId!);
      if (template.status !== "draft") {
        throw badRequest(`Template ${template.reference} v${template.version} is already ${template.status}.`);
      }
      const items = await loadTemplateItems(templateId);
      if (items.length === 0) {
        throw badRequest("A template with no items cannot be issued — it records nothing.");
      }
      assertDistinctActor(
        req.user!.id,
        template.createdBy,
        "Approval of a checklist template",
        "drafted",
      );
      const at = nowISO();
      await app.db
        .update(checklistTemplates)
        .set({ status: "active", approvedBy: req.user!.id, approvedAt: at, updatedAt: at })
        .where(eq(checklistTemplates.id, templateId));
      await ledger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "checklist_template",
        objectId: templateId,
        payload: { from: "draft", to: "active", approvedBy: req.user!.id, itemCount: items.length },
        storePayload: true,
      });
      const updated = await fetchTemplate(templateId, req.companyId!);
      return { ...updated, items };
    },
  );

  app.post(
    "/companies/current/checklist-templates/:templateId/revise",
    { preHandler: memberGate },
    async (req, reply) => {
      const { templateId } = req.params as { templateId: string };
      const template = await fetchTemplate(templateId, req.companyId!);
      const id = newId("clt");
      const [created] = await app.db
        .insert(checklistTemplates)
        .values({
          id,
          companyId: template.companyId,
          projectId: template.projectId,
          reference: template.reference,
          name: template.name,
          description: template.description,
          category: template.category,
          version: template.version + 1,
          status: "draft",
          scoringMethod: template.scoringMethod,
          passThreshold: template.passThreshold,
          specSectionId: template.specSectionId,
          specSectionCode: template.specSectionCode,
          appliesToTrades: template.appliesToTrades,
          isStatutory: template.isStatutory,
          regulatoryBasis: template.regulatoryBasis,
          requiredSignatures: template.requiredSignatures,
          supersedesId: template.id,
          detail: template.detail,
          createdBy: req.user!.id,
        })
        .returning();
      const items = await loadTemplateItems(templateId);
      for (const item of items) {
        const { id: _priorId, createdAt: _c, updatedAt: _u, ...carried } = item;
        await app.db
          .insert(checklistTemplateItems)
          .values({ ...carried, id: newId("cti"), templateId: id });
      }
      await refreshItemCount(id);
      await app.db
        .update(checklistTemplates)
        .set({ status: "retired", updatedAt: nowISO() })
        .where(eq(checklistTemplates.id, templateId));
      await ledger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "checklist_template",
        objectId: id,
        payload: { ...created, supersedesId: templateId },
        storePayload: true,
      });
      const fresh = await fetchTemplate(id, req.companyId!);
      return reply.status(201).send({ ...fresh, items: await loadTemplateItems(id) });
    },
  );

  app.post(
    "/companies/current/checklist-templates/:templateId/retire",
    { preHandler: memberGate },
    async (req) => {
      const { templateId } = req.params as { templateId: string };
      const template = await fetchTemplate(templateId, req.companyId!);
      await app.db
        .update(checklistTemplates)
        .set({ status: "retired", updatedAt: nowISO() })
        .where(eq(checklistTemplates.id, templateId));
      await ledger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "checklist_template",
        objectId: templateId,
        payload: { from: template.status, to: "retired" },
      });
      return fetchTemplate(templateId, req.companyId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Checklists (project-scoped)                                       */
  /* ---------------------------------------------------------------- */

  async function fetchChecklist(checklistId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(checklists)
      .where(
        and(
          eq(checklists.id, checklistId),
          eq(checklists.companyId, companyId),
          eq(checklists.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Checklist not found");
    return rows[0];
  }

  async function loadResponses(checklistId: string) {
    return app.db
      .select()
      .from(checklistResponses)
      .where(eq(checklistResponses.checklistId, checklistId))
      .orderBy(asc(checklistResponses.position), asc(checklistResponses.createdAt));
  }

  /** Pair every response with the item definition that governs it. */
  async function buildEntries(checklist: typeof checklists.$inferSelect) {
    const responses = await loadResponses(checklist.id);
    const items = checklist.templateId ? await loadTemplateItems(checklist.templateId) : [];
    const itemById = new Map(items.map((i) => [i.id, i] as const));
    const entries: ScoreEntry[] = [];
    const specByResponseId = new Map<string, ChecklistItemSpec>();
    for (const response of responses) {
      const templateItem = response.templateItemId
        ? itemById.get(response.templateItemId)
        : undefined;
      const spec = templateItem ? specFromTemplateItem(templateItem) : specFromResponse(response);
      specByResponseId.set(response.id, spec);
      entries.push({
        item: spec,
        answer: answerIsPopulated(answerFromRow(response)) ? answerFromRow(response) : null,
      });
    }
    return { responses, entries, specByResponseId };
  }

  async function scoreOf(checklist: typeof checklists.$inferSelect) {
    const { responses, entries, specByResponseId } = await buildEntries(checklist);
    const template = checklist.templateId
      ? await fetchTemplate(checklist.templateId, checklist.companyId).catch(() => null)
      : null;
    const score = scoreChecklist(entries, {
      scoringMethod: template?.scoringMethod ?? "pass_fail",
      passThreshold: template?.passThreshold ?? null,
    });
    return { responses, score, specByResponseId, template };
  }

  app.post("/projects/:projectId/checklists", { preHandler: standardGate }, async (req, reply) => {
    const body = checklistCreateSchema.parse(req.body);
    if (body.vendorId) await assertVendor(app.db, req.companyId!, body.vendorId);
    if (body.locationId) await assertLocation(app.db, req.projectId!, body.locationId);
    if (body.assetId) await assertAsset(app.db, req.projectId!, body.assetId);

    let template: typeof checklistTemplates.$inferSelect | null = null;
    let items: TemplateItemRow[] = [];
    if (body.templateId) {
      template = await fetchTemplate(body.templateId, req.companyId!);
      if (template.status !== "active") {
        throw badRequest(
          `Template ${template.reference} v${template.version} is ${template.status}. Work is recorded against an ISSUED form: approve the template first so the record names a controlled document.`,
        );
      }
      if (template.projectId && template.projectId !== req.projectId!) {
        throw badRequest(
          `Template ${template.reference} belongs to project ${template.projectId} and cannot be used on this one.`,
        );
      }
      items = await loadTemplateItems(template.id);
    }
    if (!template && !body.title) {
      throw badRequest("A checklist taken without a template must at least carry a title.");
    }

    const { number, reference } = await allocateReference(
      app.db,
      req.projectId!,
      "checklist",
      "CL",
      4,
    );
    const id = newId("chk");
    const [created] = await app.db
      .insert(checklists)
      .values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        reference,
        templateId: template?.id ?? null,
        templateVersion: template?.version ?? null,
        title: body.title ?? template!.name,
        category: body.category ?? template?.category ?? "quality",
        locationId: body.locationId ?? null,
        locationText: body.locationText ?? null,
        assetId: body.assetId ?? null,
        equipmentId: body.equipmentId ?? null,
        itpId: body.itpId ?? null,
        itpActivityId: body.itpActivityId ?? null,
        specSectionId: body.specSectionId ?? template?.specSectionId ?? null,
        drawingSheetId: body.drawingSheetId ?? null,
        vendorId: body.vendorId ?? null,
        commitmentId: body.commitmentId ?? null,
        scheduledFor: body.scheduledFor ?? null,
        performedByName: body.performedByName ?? null,
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      })
      .returning();

    for (const item of items) {
      await app.db.insert(checklistResponses).values({
        id: newId("chr"),
        companyId: req.companyId!,
        projectId: req.projectId!,
        checklistId: id,
        templateItemId: item.id,
        itemNumber: item.itemNumber,
        position: item.position,
        questionText: item.text,
        itemType: item.itemType,
        unit: item.unit,
        detail: { section: item.section },
      });
    }

    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "checklist",
      objectId: id,
      payload: { ...created, itemCount: items.length },
      storePayload: true,
    });
    const checklist = await fetchChecklist(id, req.companyId!, req.projectId!);
    return reply.status(201).send({ ...checklist, responses: await loadResponses(id) });
  });

  app.get("/projects/:projectId/checklists", { preHandler: readGate }, async (req) => {
    await sweepQuality(app.db, req.companyId!, req.projectId!, req.user!.id);
    const q = checklistListQuery.parse(req.query);
    const clauses = [
      eq(checklists.companyId, req.companyId!),
      eq(checklists.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(checklists.status, q.status));
    if (q.category) clauses.push(eq(checklists.category, q.category));
    if (q.templateId) clauses.push(eq(checklists.templateId, q.templateId));
    if (q.itpId) clauses.push(eq(checklists.itpId, q.itpId));
    if (q.assetId) clauses.push(eq(checklists.assetId, q.assetId));
    if (q.vendorId) clauses.push(eq(checklists.vendorId, q.vendorId));
    if (q.result) clauses.push(eq(checklists.result, q.result));
    if (q.search) clauses.push(ilike(checklists.title, `%${q.search}%`));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(checklists).where(where);
    const items = await app.db
      .select()
      .from(checklists)
      .where(where)
      .orderBy(desc(checklists.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/checklists/:checklistId", { preHandler: readGate }, async (req) => {
    const { checklistId } = req.params as { checklistId: string };
    const checklist = await fetchChecklist(checklistId, req.companyId!, req.projectId!);
    const { responses, score, template } = await scoreOf(checklist);
    return { ...checklist, responses, template, scoring: score };
  });

  /** Scoring preview — the same arithmetic the completion will apply. */
  app.get(
    "/projects/:projectId/checklists/:checklistId/score",
    { preHandler: readGate },
    async (req) => {
      const { checklistId } = req.params as { checklistId: string };
      const checklist = await fetchChecklist(checklistId, req.companyId!, req.projectId!);
      const { score } = await scoreOf(checklist);
      return score;
    },
  );

  app.patch(
    "/projects/:projectId/checklists/:checklistId",
    { preHandler: standardGate },
    async (req) => {
      const { checklistId } = req.params as { checklistId: string };
      const body = checklistPatchSchema.parse(req.body);
      const checklist = await fetchChecklist(checklistId, req.companyId!, req.projectId!);
      if (checklist.status === "closed" || checklist.status === "void") {
        throw badRequest(`A ${checklist.status} checklist cannot be edited.`);
      }
      if (body.vendorId) await assertVendor(app.db, req.companyId!, body.vendorId);
      if (body.locationId) await assertLocation(app.db, req.projectId!, body.locationId);
      if (body.assetId) await assertAsset(app.db, req.projectId!, body.assetId);
      const set: Record<string, unknown> = { updatedAt: nowISO() };
      for (const key of CHECKLIST_PATCH_COLUMNS) {
        const value = (body as Record<string, unknown>)[key];
        if (value !== undefined) set[key] = value;
      }
      await app.db.update(checklists).set(set).where(eq(checklists.id, checklistId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "checklist",
        objectId: checklistId,
        payload: { changed: Object.keys(body) },
      });
      return fetchChecklist(checklistId, req.companyId!, req.projectId!);
    },
  );

  /** Add an item to an ad-hoc checklist (one taken without a template). */
  app.post(
    "/projects/:projectId/checklists/:checklistId/items",
    { preHandler: standardGate },
    async (req, reply) => {
      const { checklistId } = req.params as { checklistId: string };
      const body = adhocItemSchema.parse(req.body);
      const checklist = await fetchChecklist(checklistId, req.companyId!, req.projectId!);
      if (checklist.templateId) {
        throw badRequest(
          `${checklist.reference} was taken from template ${checklist.templateId}; its items come from the template so the record matches the issued form. Add the item to the template and revise it.`,
        );
      }
      if (!OPEN_CHECKLIST_STATUSES.includes(checklist.status)) {
        throw badRequest(`${checklist.reference} is ${checklist.status} and takes no further items.`);
      }
      const validation = validateItemDefinition({
        itemType: body.itemType,
        options: body.options ?? [],
        targetValue: body.targetValue ?? null,
        minValue: body.minValue ?? null,
        maxValue: body.maxValue ?? null,
        tolerancePlus: body.tolerancePlus ?? null,
        toleranceMinus: body.toleranceMinus ?? null,
        isCritical: body.isCritical ?? false,
        raisesNcrOnFail: body.raisesNcrOnFail ?? false,
        weight: body.weight ?? 1,
      });
      if (!validation.ok) throw badRequest(validation.errors.join(" "));
      const existing = await loadResponses(checklistId);
      const [created] = await app.db
        .insert(checklistResponses)
        .values({
          id: newId("chr"),
          companyId: req.companyId!,
          projectId: req.projectId!,
          checklistId,
          templateItemId: null,
          itemNumber: body.itemNumber ?? null,
          position:
            body.position ??
            (existing.length > 0 ? Math.max(...existing.map((r) => r.position)) + 10 : 10),
          questionText: body.text,
          itemType: body.itemType,
          unit: body.unit ?? null,
          detail: {
            section: body.section ?? null,
            itemSpec: {
              required: body.required !== false,
              options: body.options ?? [],
              targetValue: body.targetValue ?? null,
              minValue: body.minValue ?? null,
              maxValue: body.maxValue ?? null,
              tolerancePlus: body.tolerancePlus ?? null,
              toleranceMinus: body.toleranceMinus ?? null,
              weight: body.weight ?? 1,
              isCritical: body.isCritical === true,
              photoRequired: body.photoRequired === true,
              raisesNcrOnFail: body.raisesNcrOnFail === true,
              ncrSeverity: body.ncrSeverity ?? null,
            },
          },
        })
        .returning();
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "checklist_response",
        objectId: created!.id,
        payload: created,
      });
      return reply.status(201).send(created);
    },
  );

  async function applyAnswer(
    response: ResponseRow,
    spec: ChecklistItemSpec,
    body: z.infer<typeof answerSchema>,
    actorId: string,
  ) {
    const answer: ChecklistAnswer = {
      response: body.response !== undefined ? body.response : response.response,
      numericValue: body.numericValue !== undefined ? body.numericValue : response.numericValue,
      selectedOptions: body.selectedOptions ?? response.selectedOptions,
      isNotApplicable:
        body.isNotApplicable !== undefined ? body.isNotApplicable : response.isNotApplicable === 1,
      naReason: body.naReason !== undefined ? body.naReason : response.naReason,
      photoFileIds: body.photoFileIds ?? response.photoFileIds,
      fileIds: body.fileIds ?? response.fileIds,
    };
    const validation = validateAnswer(spec, answer);
    if (!validation.ok) throw badRequest(validation.errors.join(" "));
    const evaluation = evaluateAnswerItem(spec, answer);
    await app.db
      .update(checklistResponses)
      .set({
        response: answer.response ?? null,
        numericValue: answer.numericValue ?? null,
        selectedOptions: answer.selectedOptions ?? [],
        isNotApplicable: answer.isNotApplicable ? 1 : 0,
        naReason: answer.naReason ?? null,
        note: body.note !== undefined ? body.note : response.note,
        photoFileIds: answer.photoFileIds ?? [],
        fileIds: answer.fileIds ?? [],
        instrumentId: body.instrumentId !== undefined ? body.instrumentId : response.instrumentId,
        instrumentSerial:
          body.instrumentSerial !== undefined ? body.instrumentSerial : response.instrumentSerial,
        measuredAt: body.measuredAt !== undefined ? body.measuredAt : response.measuredAt,
        isPass: evaluation.isPass === null ? null : evaluation.isPass ? 1 : 0,
        score: evaluation.score,
        maxScore: evaluation.maxScore,
        respondedBy: actorId,
        respondedAt: nowISO(),
        updatedAt: nowISO(),
      })
      .where(eq(checklistResponses.id, response.id));
    return evaluation;
  }

  /** Answer one item. */
  app.put(
    "/projects/:projectId/checklists/:checklistId/responses/:responseId",
    { preHandler: standardGate },
    async (req) => {
      const { checklistId, responseId } = req.params as {
        checklistId: string;
        responseId: string;
      };
      const body = answerSchema.parse(req.body);
      const checklist = await fetchChecklist(checklistId, req.companyId!, req.projectId!);
      if (!OPEN_CHECKLIST_STATUSES.includes(checklist.status)) {
        throw badRequest(
          `${checklist.reference} is ${checklist.status}. A completed checklist is evidence of what was found at the time; reopen it explicitly rather than editing the answers underneath the result.`,
        );
      }
      const { responses, specByResponseId } = await buildEntries(checklist);
      const response = responses.find((r) => r.id === responseId);
      if (!response) throw notFound("Checklist response not found");
      const spec = specByResponseId.get(responseId)!;
      const evaluation = await applyAnswer(response, spec, body, req.user!.id);
      if (checklist.status === "draft" || checklist.status === "scheduled") {
        await app.db
          .update(checklists)
          .set({ status: "in_progress", updatedAt: nowISO() })
          .where(eq(checklists.id, checklistId));
      }
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "checklist_response",
        objectId: responseId,
        payload: { checklistId, isPass: evaluation.isPass, reasons: evaluation.reasons },
      });
      const refreshed = await fetchChecklist(checklistId, req.companyId!, req.projectId!);
      const { score, responses: fresh } = await scoreOf(refreshed);
      return {
        response: fresh.find((r) => r.id === responseId),
        evaluation,
        scoring: score,
      };
    },
  );

  /** Answer many at once — the mobile round-trip. */
  app.post(
    "/projects/:projectId/checklists/:checklistId/responses",
    { preHandler: standardGate },
    async (req) => {
      const { checklistId } = req.params as { checklistId: string };
      const body = bulkAnswerSchema.parse(req.body);
      const checklist = await fetchChecklist(checklistId, req.companyId!, req.projectId!);
      if (!OPEN_CHECKLIST_STATUSES.includes(checklist.status)) {
        throw badRequest(`${checklist.reference} is ${checklist.status} and takes no further answers.`);
      }
      const { responses, specByResponseId } = await buildEntries(checklist);
      const byTemplateItem = new Map(
        responses.filter((r) => r.templateItemId).map((r) => [r.templateItemId!, r] as const),
      );
      for (const answer of body.answers) {
        const response = answer.responseId
          ? responses.find((r) => r.id === answer.responseId)
          : answer.templateItemId
            ? byTemplateItem.get(answer.templateItemId)
            : undefined;
        if (!response) {
          throw badRequest(
            `No item on ${checklist.reference} matches ${JSON.stringify(answer.responseId ?? answer.templateItemId)}.`,
          );
        }
        await applyAnswer(response, specByResponseId.get(response.id)!, answer, req.user!.id);
      }
      if (checklist.status === "draft" || checklist.status === "scheduled") {
        await app.db
          .update(checklists)
          .set({ status: "in_progress", updatedAt: nowISO() })
          .where(eq(checklists.id, checklistId));
      }
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "checklist",
        objectId: checklistId,
        payload: { answered: body.answers.length },
      });
      const refreshed = await fetchChecklist(checklistId, req.companyId!, req.projectId!);
      const { score, responses: fresh } = await scoreOf(refreshed);
      return { responses: fresh, scoring: score };
    },
  );

  /**
   * Complete the checklist: score it, stamp the result, and raise what the
   * TEMPLATE said to raise.
   *
   *  - a failed item whose template row says `raisesNcrOnFail` → exactly one
   *    NCR, linked back to the response that failed;
   *  - a failed NON-CRITICAL item that does not → a punch item, because a
   *    snag belongs on the snag list;
   *  - a failed CRITICAL item that does not → nothing is raised, and the
   *    completion response says so by name. The platform does not silently
   *    invent a register entry the form never asked for, and it does not
   *    silently swallow a critical failure either.
   *
   * Re-completion is refused rather than re-running, so a failed critical
   * item raises exactly one NCR however many times the button is pressed.
   */
  app.post(
    "/projects/:projectId/checklists/:checklistId/complete",
    { preHandler: standardGate },
    async (req) => {
      const { checklistId } = req.params as { checklistId: string };
      const body = completeSchema.parse(req.body ?? {});
      const checklist = await fetchChecklist(checklistId, req.companyId!, req.projectId!);
      if (!OPEN_CHECKLIST_STATUSES.includes(checklist.status)) {
        throw badRequest(
          `${checklist.reference} is already ${checklist.status}. Completing it twice would raise a second NCR for the same failure.`,
        );
      }
      const { responses, score, specByResponseId, template } = await scoreOf(checklist);
      if (score.unansweredRequiredItemIds.length > 0) {
        const names = responses
          .filter(
            (r) =>
              score.unansweredRequiredItemIds.includes(r.templateItemId ?? r.id) ||
              score.unansweredRequiredItemIds.includes(r.id),
          )
          .map((r) => (r.itemNumber ? `${r.itemNumber}. ${r.questionText}` : r.questionText));
        throw badRequest(
          `${checklist.reference} has ${score.unansweredRequiredItemIds.length} unanswered required item(s): ${names.join("; ")}. Answer them, or mark them not applicable with a reason.`,
        );
      }
      if (score.answeredItemCount === 0) {
        throw badRequest(`${checklist.reference} has no answers and cannot be completed.`);
      }

      const at = body.performedAt ?? nowISO();
      const raisedNcrs: { responseId: string; ncrId: string; reference: string }[] = [];
      const raisedPunchItems: { responseId: string; punchItemId: string; number: number }[] = [];
      const unraised: { responseId: string; reason: string }[] = [];

      for (const response of responses) {
        const spec = specByResponseId.get(response.id)!;
        if (!score.failedItemIds.includes(spec.id)) continue;
        if (response.ncrId || response.punchItemId) continue;
        const criticality = spec.isCritical ? "critical" : "non-critical";
        const detail = (response.detail ?? {}) as Record<string, unknown>;
        const specDetail = (detail["itemSpec"] ?? {}) as Record<string, unknown>;
        const declaredSeverity =
          typeof specDetail["ncrSeverity"] === "string" ? specDetail["ncrSeverity"] : null;

        if (spec.raisesNcrOnFail) {
          const templateItemRows = response.templateItemId
            ? await app.db
                .select({ detail: checklistTemplateItems.detail })
                .from(checklistTemplateItems)
                .where(eq(checklistTemplateItems.id, response.templateItemId))
                .limit(1)
            : [];
          const templateItemDetail = (templateItemRows[0]?.detail ?? {}) as Record<string, unknown>;
          const fromTemplate =
            typeof templateItemDetail["ncrSeverity"] === "string"
              ? (templateItemDetail["ncrSeverity"] as string)
              : null;
          const severity = (fromTemplate ??
            declaredSeverity ??
            (spec.isCritical ? "major" : "minor")) as NcrSeverity;
          const ncr = await createNcr(app.db, {
            companyId: req.companyId!,
            projectId: req.projectId!,
            actorId: req.user!.id,
            title: `${checklist.reference} — ${response.itemNumber ? `${response.itemNumber} ` : ""}${response.questionText}`.slice(0, 300),
            description:
              `Raised automatically on completion of checklist ${checklist.reference} (${checklist.title}). ` +
              `The ${criticality} item "${response.questionText}" failed` +
              (response.numericValue !== null
                ? ` with a recorded value of ${response.numericValue}${response.unit ? ` ${response.unit}` : ""}` +
                  (spec.targetValue !== null ? ` against a target of ${spec.targetValue}` : "")
                : response.response
                  ? ` with the answer "${response.response}"`
                  : "") +
              `.${response.note ? ` Inspector's note: ${response.note}` : ""}`,
            category: "workmanship",
            severity,
            sourceType: "checklist",
            sourceId: checklist.id,
            checklistId: checklist.id,
            checklistResponseId: response.id,
            itpActivityId: checklist.itpActivityId,
            specSectionId: checklist.specSectionId,
            locationId: checklist.locationId,
            locationText: checklist.locationText,
            assetId: checklist.assetId,
            raisedAgainstVendorId: checklist.vendorId,
            commitmentId: checklist.commitmentId,
            responseDueDate: body.ncrResponseDueDate ?? null,
            photoFileIds: response.photoFileIds,
            detail: { raisedBy: "checklist_completion", criticality },
          });
          await app.db
            .update(checklistResponses)
            .set({ ncrId: ncr.id, updatedAt: nowISO() })
            .where(eq(checklistResponses.id, response.id));
          raisedNcrs.push({ responseId: response.id, ncrId: ncr.id, reference: ncr.reference });
        } else if (!spec.isCritical) {
          const punch = await createPunchItemFor(app.db, {
            companyId: req.companyId!,
            projectId: req.projectId!,
            actorId: req.user!.id,
            title: `${checklist.reference} — ${response.questionText}`.slice(0, 300),
            description:
              `Failed on checklist ${checklist.reference}.${response.note ? ` Note: ${response.note}` : ""}`,
            itemType: "quality",
            vendorId: checklist.vendorId,
            locationId: checklist.locationId,
            beforePhotoIds: response.photoFileIds,
          });
          await app.db
            .update(checklistResponses)
            .set({ punchItemId: punch.id, updatedAt: nowISO() })
            .where(eq(checklistResponses.id, response.id));
          raisedPunchItems.push({
            responseId: response.id,
            punchItemId: punch.id,
            number: punch.number,
          });
        } else {
          unraised.push({
            responseId: response.id,
            reason:
              `Critical item "${response.questionText}" failed, but the template does not declare raisesNcrOnFail for it. ` +
              `The checklist is failed and nothing was raised automatically — raise an NCR by hand if this failure is a non-conformance, ` +
              `or amend the template so the next one is caught.`,
          });
        }
      }

      const status = score.result === "fail" ? "failed" : "complete";
      await app.db
        .update(checklists)
        .set({
          status,
          result: score.result,
          score: score.score,
          maxScore: score.maxScore,
          scorePercent: score.scorePercent,
          answeredItemCount: score.answeredItemCount,
          failedItemCount: score.failedItemCount,
          criticalFailureCount: score.criticalFailureCount,
          ncrCount: raisedNcrs.length,
          performedAt: at,
          performedBy: req.user!.id,
          performedByName: body.performedByName ?? checklist.performedByName,
          photoFileIds: body.photoFileIds ?? checklist.photoFileIds,
          reportFileId: body.reportFileId ?? checklist.reportFileId,
          updatedAt: nowISO(),
        })
        .where(eq(checklists.id, checklistId));

      // The ITP activity this checklist was the record for.
      if (checklist.itpActivityId) {
        await app.db
          .update(itpActivities)
          .set({
            checklistId,
            ncrId: raisedNcrs[0]?.ncrId ?? null,
            ...(score.result === "fail" ? { status: "failed" as const } : {}),
            actualDate: todayISO(),
            updatedAt: nowISO(),
          })
          .where(eq(itpActivities.id, checklist.itpActivityId));
      }

      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "checklist",
        objectId: checklistId,
        payload: {
          from: checklist.status,
          to: status,
          result: score.result,
          score: score.score,
          maxScore: score.maxScore,
          scorePercent: score.scorePercent,
          failedItemCount: score.failedItemCount,
          criticalFailureCount: score.criticalFailureCount,
          raisedNcrs,
          raisedPunchItems,
          unraised,
          scoringMethod: template?.scoringMethod ?? "pass_fail",
          reasons: score.reasons,
        },
        storePayload: true,
      });

      const refreshed = await fetchChecklist(checklistId, req.companyId!, req.projectId!);
      return {
        ...refreshed,
        responses: await loadResponses(checklistId),
        scoring: score,
        raised: { ncrs: raisedNcrs, punchItems: raisedPunchItems, unraised },
      };
    },
  );

  /** Witnessing — a second party watching the same test. Never the performer. */
  app.post(
    "/projects/:projectId/checklists/:checklistId/witness",
    { preHandler: standardGate },
    async (req) => {
      const { checklistId } = req.params as { checklistId: string };
      const body = signOffSchema.parse(req.body ?? {});
      const checklist = await fetchChecklist(checklistId, req.companyId!, req.projectId!);
      assertDistinctActor(
        req.user!.id,
        checklist.performedBy,
        "Witnessing a checklist",
        "performed",
      );
      const at = nowISO();
      await app.db
        .update(checklists)
        .set({
          witnessedBy: req.user!.id,
          witnessedByName: body.name ?? null,
          witnessedAt: at,
          signatureFileId: body.signatureFileId ?? checklist.signatureFileId,
          updatedAt: at,
        })
        .where(eq(checklists.id, checklistId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "checklist",
        objectId: checklistId,
        payload: { witnessedBy: req.user!.id, witnessedAt: at, note: body.note ?? null },
        storePayload: true,
      });
      return fetchChecklist(checklistId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/checklists/:checklistId/review",
    { preHandler: standardGate },
    async (req) => {
      const { checklistId } = req.params as { checklistId: string };
      const body = signOffSchema.parse(req.body ?? {});
      const checklist = await fetchChecklist(checklistId, req.companyId!, req.projectId!);
      if (checklist.status !== "complete" && checklist.status !== "failed") {
        throw badRequest(`${checklist.reference} is ${checklist.status}; only a completed record is reviewed.`);
      }
      assertDistinctActor(req.user!.id, checklist.performedBy, "Review of a checklist", "performed");
      const at = nowISO();
      await app.db
        .update(checklists)
        .set({ status: "reviewed", reviewedBy: req.user!.id, reviewedAt: at, updatedAt: at })
        .where(eq(checklists.id, checklistId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "checklist",
        objectId: checklistId,
        payload: { from: checklist.status, to: "reviewed", note: body.note ?? null },
        storePayload: true,
      });
      return fetchChecklist(checklistId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/checklists/:checklistId/close",
    { preHandler: standardGate },
    async (req) => {
      const { checklistId } = req.params as { checklistId: string };
      const checklist = await fetchChecklist(checklistId, req.companyId!, req.projectId!);
      if (checklist.status !== "reviewed") {
        throw badRequest(
          `${checklist.reference} is ${checklist.status}; a record is closed after it has been reviewed.`,
        );
      }
      const at = nowISO();
      await app.db
        .update(checklists)
        .set({ status: "closed", closedBy: req.user!.id, closedAt: at, updatedAt: at })
        .where(eq(checklists.id, checklistId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "checklist",
        objectId: checklistId,
        payload: { from: "reviewed", to: "closed" },
      });
      return fetchChecklist(checklistId, req.companyId!, req.projectId!);
    },
  );
};
