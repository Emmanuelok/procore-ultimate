/**
 * Punch list — spec Vol I §2.8 #398–#414.
 *
 * Covers: numbered items with trade/type/location/vendor (#398–#400),
 * templates and bulk creation (#399, #401), walk mode grouped by the
 * location tree (#402), before/after photo evidence with an optional
 * closure gate (#403), a two-stage sign-off whose verifier is never the
 * assignee and never the person who marked the item ready (#408 — the
 * audit's self-verification bypass is closed in punchEngine.ts), admin-only
 * void that never erases a completed sign-off, vendor/assignee/distribution
 * notifications (#409), ageing and completion analytics (#411–#413) and a
 * CSV export grouped by vendor or trade (#410).
 *
 * Deliberately NOT here: photo binary handling (photos.ts) and the
 * observation the item may have been converted from (observations.ts).
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, lt, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { locations, punchItems, punchTemplates, vendors } from "@constructos/db";
import { FIELD_PRIORITIES, PUNCH_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { pushNotifications } from "../notifications/service.js";
import { addDaysISO, isoDateSchema, todayISO } from "./dates.js";
import {
  assertCompanyUsers,
  assertProjectLocation,
  assertVendor,
  hasToolAdmin,
  isCompanyAdmin,
} from "./access.js";
import { ageInDays, bucketise, daysOverdue } from "./ageingEngine.js";
import {
  PUNCH_OPEN_STATUSES,
  authorisePunchTransition,
  completionStats,
  groupByLocation,
  toCsv,
  validateVerifierChange,
} from "./punchEngine.js";
import { loadFieldSettings } from "./settings.js";
import { actorOf, nowIso, pad3, pick } from "./shared.js";

const itemFields = {
  title: z.string().min(1).max(300),
  description: z.string().max(10000).nullable().optional(),
  itemType: z.string().max(100).nullable().optional(),
  trade: z.string().max(100).nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  verifierId: z.string().nullable().optional(),
  vendorId: z.string().nullable().optional(),
  locationId: z.string().nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  priority: z.enum(FIELD_PRIORITIES).optional(),
  beforePhotoIds: z.array(z.string()).max(50).optional(),
  afterPhotoIds: z.array(z.string()).max(50).optional(),
  distribution: z.array(z.string().min(1)).max(50).optional(),
};

const punchCreateSchema = z.object(itemFields);
const punchPatchSchema = punchCreateSchema.partial();

const bulkSchema = z.object({
  items: z.array(punchCreateSchema).min(1).max(200),
  /** applied to every item that does not set the field itself */
  defaults: punchCreateSchema.partial().optional(),
});

const templateSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(10000).nullable().optional(),
  trade: z.string().max(100).nullable().optional(),
  itemType: z.string().max(100).nullable().optional(),
  priority: z.enum(FIELD_PRIORITIES).optional(),
  defaultVerifierId: z.string().nullable().optional(),
  defaultDueDays: z.number().int().min(0).max(365).nullable().optional(),
  /** company-wide library entries need a company admin */
  scope: z.enum(["project", "company"]).optional(),
});

const fromTemplateSchema = z.object({
  templateId: z.string().min(1),
  locationIds: z.array(z.string().min(1)).max(200).optional(),
  locationId: z.string().nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  vendorId: z.string().nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  titleSuffix: z.string().max(200).optional(),
});

const punchListQuery = pageQuerySchema.extend({
  status: z.enum(PUNCH_STATUSES).optional(),
  open: z.enum(["true", "false"]).optional(),
  assigneeId: z.string().optional(),
  verifierId: z.string().optional(),
  vendorId: z.string().optional(),
  locationId: z.string().optional(),
  trade: z.string().max(100).optional(),
  priority: z.enum(FIELD_PRIORITIES).optional(),
  overdue: z.enum(["true", "false"]).optional(),
  search: z.string().max(200).optional(),
});

const ageingQuery = z.object({ groupBy: z.enum(["assignee", "vendor", "priority", "trade"]).default("assignee") });
const walkQuery = z.object({
  open: z.enum(["true", "false"]).default("true"),
  locationId: z.string().optional(),
});
const exportQuery = z.object({ groupBy: z.enum(["vendor", "trade", "location", "none"]).default("vendor") });

type Item = typeof punchItems.$inferSelect;

export const punchRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("punch", "read")];
  const standardGate = [app.authenticate, app.requireCompany, app.requireTool("punch", "standard")];

  const label = (n: number) => `Punch #${pad3(n)}`;

  function scope(req: FastifyRequest) {
    return and(eq(punchItems.companyId, req.companyId!), eq(punchItems.projectId, req.projectId!))!;
  }

  async function fetchItem(itemId: string, req: FastifyRequest): Promise<Item> {
    const rows = await app.db.select().from(punchItems).where(and(scope(req), eq(punchItems.id, itemId))).limit(1);
    if (!rows[0]) throw notFound("Punch item not found");
    return rows[0];
  }

  async function isAdmin(req: FastifyRequest): Promise<boolean> {
    return isCompanyAdmin(req.companyRole) || hasToolAdmin(app, actorOf(req), req.projectId!, "punch");
  }

  async function ledgerItem(
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
      objectType: "punch_item",
      objectId: id,
      payload,
      storePayload,
      projectId: req.projectId!,
    });
  }

  async function validateRefs(
    req: FastifyRequest,
    body: { assigneeId?: string | null; verifierId?: string | null; distribution?: string[]; vendorId?: string | null; locationId?: string | null },
  ) {
    await assertCompanyUsers(app.db, req.companyId!, [body.assigneeId, body.verifierId, ...(body.distribution ?? [])]);
    await assertVendor(app.db, req.companyId!, body.vendorId);
    await assertProjectLocation(app.db, req.companyId!, req.projectId!, body.locationId);
  }

  function decorate(row: Item, today: string) {
    const open = (PUNCH_OPEN_STATUSES as readonly string[]).includes(row.status);
    return {
      ...row,
      label: label(row.number),
      isOpen: open,
      daysOverdue: open ? daysOverdue(row.dueDate, today) : 0,
      ageDays: open ? ageInDays(row.createdAt, today) : null,
    };
  }

  function notify(req: FastifyRequest, row: { id: string; number: number; title: string }, userIds: Iterable<string>, kind: "assignment" | "status_change", title?: string) {
    const ids = [...new Set(userIds)].filter((id) => id && id !== req.user!.id);
    return pushNotifications(
      app.db,
      ids.map((userId) => ({
        companyId: req.companyId!,
        userId,
        projectId: req.projectId!,
        kind,
        title: title ?? `${label(row.number)} assigned to you: ${row.title}`,
        recordType: "punch_item",
        recordId: row.id,
      })),
    );
  }

  type CreateInput = z.infer<typeof punchCreateSchema>;

  function toInsert(req: FastifyRequest, body: CreateInput, number: number, id: string, templateId: string | null = null): typeof punchItems.$inferInsert {
    return {
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      number,
      title: body.title,
      description: body.description ?? null,
      status: "open",
      itemType: body.itemType ?? null,
      trade: body.trade ?? null,
      assigneeId: body.assigneeId ?? null,
      verifierId: body.verifierId ?? null,
      vendorId: body.vendorId ?? null,
      locationId: body.locationId ?? null,
      dueDate: body.dueDate ?? null,
      priority: body.priority ?? "medium",
      beforePhotoIds: body.beforePhotoIds ?? [],
      afterPhotoIds: body.afterPhotoIds ?? [],
      distribution: body.distribution ?? [],
      templateId,
      createdBy: req.user!.id,
    };
  }

  function checkVerifierNotAssignee(body: { assigneeId?: string | null; verifierId?: string | null }) {
    if (body.assigneeId && body.verifierId && body.assigneeId === body.verifierId) {
      throw badRequest("The verifier must be a different person from the assignee");
    }
  }

  /* ---------------------------------------------------------------- */
  /* Create / bulk / from template                                     */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/punch", { preHandler: standardGate }, async (req, reply) => {
    const body = punchCreateSchema.parse(req.body);
    await validateRefs(req, body);
    checkVerifierNotAssignee(body);
    const number = await nextRecordNumber(app.db, req.projectId!, "punch");
    const id = newId("pun");
    await app.db.insert(punchItems).values(toInsert(req, body, number, id));
    await ledgerItem("create", id, req, { number, title: body.title, vendorId: body.vendorId ?? null, locationId: body.locationId ?? null });
    await notify(req, { id, number, title: body.title }, [body.assigneeId ?? "", ...(body.distribution ?? [])], "assignment");
    return reply.status(201).send(decorate(await fetchItem(id, req), todayISO()));
  });

  /** Up to 200 items in one numbered transaction (#401). */
  app.post("/projects/:projectId/punch/bulk", { preHandler: standardGate }, async (req, reply) => {
    const body = bulkSchema.parse(req.body);
    const merged: CreateInput[] = body.items.map((item) => ({ ...(body.defaults ?? {}), ...item }));
    const userIds = merged.flatMap((m) => [m.assigneeId, m.verifierId, ...(m.distribution ?? [])]);
    await assertCompanyUsers(app.db, req.companyId!, userIds);
    for (const vendorId of new Set(merged.map((m) => m.vendorId).filter(Boolean))) await assertVendor(app.db, req.companyId!, vendorId);
    for (const locationId of new Set(merged.map((m) => m.locationId).filter(Boolean))) {
      await assertProjectLocation(app.db, req.companyId!, req.projectId!, locationId);
    }
    for (const m of merged) checkVerifierNotAssignee(m);
    const created: Array<{ id: string; number: number; title: string; assigneeId: string | null; distribution: string[] }> = [];
    await app.db.transaction(async (tx) => {
      for (const m of merged) {
        const number = await nextRecordNumber(tx, req.projectId!, "punch");
        const id = newId("pun");
        await tx.insert(punchItems).values(toInsert(req, m, number, id));
        created.push({ id, number, title: m.title, assigneeId: m.assigneeId ?? null, distribution: m.distribution ?? [] });
      }
    });
    for (const c of created) {
      await ledgerItem("create", c.id, req, { number: c.number, title: c.title, bulk: true, batchSize: created.length });
    }
    const targets = created.flatMap((c) =>
      [c.assigneeId ?? "", ...c.distribution]
        .filter((u) => u && u !== req.user!.id)
        .map((userId) => ({
          companyId: req.companyId!,
          userId,
          projectId: req.projectId!,
          kind: "assignment" as const,
          title: `${label(c.number)} assigned to you: ${c.title}`,
          recordType: "punch_item",
          recordId: c.id,
        })),
    );
    await pushNotifications(app.db, targets);
    const rows = await app.db.select().from(punchItems).where(inArray(punchItems.id, created.map((c) => c.id))).orderBy(asc(punchItems.number));
    const today = todayISO();
    return reply.status(201).send({ created: rows.length, items: rows.map((r) => decorate(r, today)) });
  });

  /* ---------------------------------------------------------------- */
  /* Templates (#399)                                                  */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/punch/templates", { preHandler: readGate }, async (req) => {
    const items = await app.db
      .select()
      .from(punchTemplates)
      .where(
        and(
          eq(punchTemplates.companyId, req.companyId!),
          eq(punchTemplates.isActive, 1),
          or(isNull(punchTemplates.projectId), eq(punchTemplates.projectId, req.projectId!)),
        ),
      )
      .orderBy(asc(punchTemplates.trade), asc(punchTemplates.title));
    return { items };
  });

  app.post("/projects/:projectId/punch/templates", { preHandler: standardGate }, async (req, reply) => {
    const body = templateSchema.parse(req.body);
    if (body.scope === "company" && !isCompanyAdmin(req.companyRole)) {
      throw forbidden("Only a company owner or admin can add to the company-wide punch template library");
    }
    await assertCompanyUsers(app.db, req.companyId!, [body.defaultVerifierId], "verifier");
    const id = newId("ptpl");
    await app.db.insert(punchTemplates).values({
      id,
      companyId: req.companyId!,
      projectId: body.scope === "company" ? null : req.projectId!,
      trade: body.trade ?? null,
      itemType: body.itemType ?? null,
      title: body.title,
      description: body.description ?? null,
      priority: body.priority ?? "medium",
      defaultVerifierId: body.defaultVerifierId ?? null,
      defaultDueDays: body.defaultDueDays ?? null,
      isActive: 1,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "punch_template",
      objectId: id,
      payload: { title: body.title, scope: body.scope ?? "project" },
      projectId: body.scope === "company" ? null : req.projectId!,
    });
    return reply.status(201).send((await app.db.select().from(punchTemplates).where(eq(punchTemplates.id, id)).limit(1))[0]);
  });

  app.delete("/projects/:projectId/punch/templates/:templateId", { preHandler: standardGate }, async (req) => {
    const { templateId } = req.params as { templateId: string };
    const row = (
      await app.db
        .select()
        .from(punchTemplates)
        .where(and(eq(punchTemplates.id, templateId), eq(punchTemplates.companyId, req.companyId!)))
        .limit(1)
    )[0];
    if (!row || (row.projectId !== null && row.projectId !== req.projectId!)) throw notFound("Template not found");
    if (row.projectId === null && !isCompanyAdmin(req.companyRole)) {
      throw forbidden("Only a company owner or admin can retire a company-wide template");
    }
    await app.db.update(punchTemplates).set({ isActive: 0 }).where(eq(punchTemplates.id, templateId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "punch_template",
      objectId: templateId,
      payload: { retired: true },
      projectId: row.projectId,
    });
    return { deleted: true, id: templateId };
  });

  /** One item per location (walk mode quick-add) or a single item, seeded from a template. */
  app.post("/projects/:projectId/punch/from-template", { preHandler: standardGate }, async (req, reply) => {
    const body = fromTemplateSchema.parse(req.body);
    const template = (
      await app.db
        .select()
        .from(punchTemplates)
        .where(
          and(
            eq(punchTemplates.id, body.templateId),
            eq(punchTemplates.companyId, req.companyId!),
            eq(punchTemplates.isActive, 1),
            or(isNull(punchTemplates.projectId), eq(punchTemplates.projectId, req.projectId!)),
          ),
        )
        .limit(1)
    )[0];
    if (!template) throw notFound("Punch template not found");
    const locationIds = body.locationIds && body.locationIds.length > 0 ? body.locationIds : [body.locationId ?? null];
    await assertCompanyUsers(app.db, req.companyId!, [body.assigneeId, template.defaultVerifierId]);
    await assertVendor(app.db, req.companyId!, body.vendorId);
    for (const locationId of locationIds) await assertProjectLocation(app.db, req.companyId!, req.projectId!, locationId);
    const dueDate = body.dueDate !== undefined ? body.dueDate : template.defaultDueDays !== null ? addDaysISO(todayISO(), template.defaultDueDays) : null;
    const verifierId = template.defaultVerifierId && template.defaultVerifierId !== body.assigneeId ? template.defaultVerifierId : null;
    const created: string[] = [];
    await app.db.transaction(async (tx) => {
      for (const locationId of locationIds) {
        const number = await nextRecordNumber(tx, req.projectId!, "punch");
        const id = newId("pun");
        await tx.insert(punchItems).values(
          toInsert(
            req,
            {
              title: body.titleSuffix ? `${template.title} — ${body.titleSuffix}` : template.title,
              description: template.description,
              itemType: template.itemType,
              trade: template.trade,
              priority: template.priority as (typeof FIELD_PRIORITIES)[number],
              assigneeId: body.assigneeId ?? null,
              verifierId,
              vendorId: body.vendorId ?? null,
              locationId,
              dueDate,
            },
            number,
            id,
            template.id,
          ),
        );
        created.push(id);
      }
    });
    for (const id of created) await ledgerItem("create", id, req, { templateId: template.id, title: template.title });
    const rows = await app.db.select().from(punchItems).where(inArray(punchItems.id, created)).orderBy(asc(punchItems.number));
    if (body.assigneeId && body.assigneeId !== req.user!.id) {
      await pushNotifications(
        app.db,
        rows.map((r) => ({
          companyId: req.companyId!,
          userId: body.assigneeId!,
          projectId: req.projectId!,
          kind: "assignment" as const,
          title: `${label(r.number)} assigned to you: ${r.title}`,
          recordType: "punch_item",
          recordId: r.id,
        })),
      );
    }
    const today = todayISO();
    return reply.status(201).send({ created: rows.length, items: rows.map((r) => decorate(r, today)) });
  });

  /* ---------------------------------------------------------------- */
  /* Register / walk / ageing / analytics / export                      */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/punch", { preHandler: readGate }, async (req) => {
    const q = punchListQuery.parse(req.query);
    const today = todayISO();
    const clauses: SQL[] = [scope(req)];
    if (q.status) clauses.push(eq(punchItems.status, q.status));
    if (q.open === "true") clauses.push(inArray(punchItems.status, [...PUNCH_OPEN_STATUSES]));
    if (q.assigneeId) clauses.push(eq(punchItems.assigneeId, q.assigneeId));
    if (q.verifierId) clauses.push(eq(punchItems.verifierId, q.verifierId));
    if (q.vendorId) clauses.push(eq(punchItems.vendorId, q.vendorId));
    if (q.locationId) clauses.push(eq(punchItems.locationId, q.locationId));
    if (q.trade) clauses.push(eq(punchItems.trade, q.trade));
    if (q.priority) clauses.push(eq(punchItems.priority, q.priority));
    if (q.search) clauses.push(ilike(punchItems.title, `%${q.search}%`));
    if (q.overdue === "true") {
      clauses.push(inArray(punchItems.status, [...PUNCH_OPEN_STATUSES]), isNotNull(punchItems.dueDate), lt(punchItems.dueDate, today));
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(punchItems).where(where);
    const items = await app.db.select().from(punchItems).where(where).orderBy(desc(punchItems.number)).limit(q.pageSize).offset(pageOffset(q));
    return paginate(items.map((r) => decorate(r, today)), Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/punch/by-location", { preHandler: readGate }, async (req) => {
    const q = walkQuery.parse(req.query);
    const clauses: SQL[] = [scope(req)];
    if (q.open === "true") clauses.push(inArray(punchItems.status, [...PUNCH_OPEN_STATUSES]));
    if (q.locationId) clauses.push(eq(punchItems.locationId, q.locationId));
    const items = await app.db.select().from(punchItems).where(and(...clauses)).orderBy(asc(punchItems.number)).limit(2000);
    const locs = await app.db
      .select({ id: locations.id, name: locations.name, parentId: locations.parentId, path: locations.path })
      .from(locations)
      .where(and(eq(locations.companyId, req.companyId!), eq(locations.projectId, req.projectId!)));
    const today = todayISO();
    const groups = groupByLocation(items.map((r) => decorate(r, today)), locs);
    return {
      asOf: today,
      openOnly: q.open === "true",
      total: items.length,
      locations: locs,
      groups,
    };
  });

  app.get("/projects/:projectId/punch/ageing", { preHandler: readGate }, async (req) => {
    const q = ageingQuery.parse(req.query);
    const today = todayISO();
    const rows = await app.db
      .select()
      .from(punchItems)
      .where(and(scope(req), inArray(punchItems.status, [...PUNCH_OPEN_STATUSES])))
      .orderBy(asc(punchItems.number))
      .limit(5000);
    const vendorIds = [...new Set(rows.map((r) => r.vendorId).filter((v): v is string => Boolean(v)))];
    const vendorRows = vendorIds.length > 0 ? await app.db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(inArray(vendors.id, vendorIds)) : [];
    const vendorName = new Map(vendorRows.map((v) => [v.id, v.name]));
    const groupOf = (r: Item) =>
      q.groupBy === "assignee"
        ? (r.assigneeId ?? "unassigned")
        : q.groupBy === "vendor"
          ? (r.vendorId ? (vendorName.get(r.vendorId) ?? r.vendorId) : "no vendor")
          : q.groupBy === "trade"
            ? (r.trade ?? "no trade")
            : r.priority;
    const ageOf = (r: Item) => ageInDays(r.createdAt, today);
    return {
      groupBy: q.groupBy,
      asOf: today,
      ...bucketise(rows, ageOf, groupOf),
      overdueBuckets: bucketise(rows.filter((r) => daysOverdue(r.dueDate, today) > 0), (r) => daysOverdue(r.dueDate, today), groupOf),
      items: rows.map((r) => ({ id: r.id, number: r.number, title: r.title, ageDays: ageOf(r), daysOverdue: daysOverdue(r.dueDate, today), group: groupOf(r), status: r.status })),
      basis: "Age = days since the item was created; overdue = days past its due date",
    };
  });

  app.get("/projects/:projectId/punch/analytics", { preHandler: readGate }, async (req) => {
    const today = todayISO();
    const rows = await app.db
      .select({
        id: punchItems.id,
        status: punchItems.status,
        assigneeId: punchItems.assigneeId,
        vendorId: punchItems.vendorId,
        trade: punchItems.trade,
        priority: punchItems.priority,
        dueDate: punchItems.dueDate,
        createdAt: punchItems.createdAt,
        closedAt: punchItems.closedAt,
      })
      .from(punchItems)
      .where(scope(req))
      .limit(5000);
    const byStatus: Record<string, number> = {};
    const byAssignee = new Map<string, number>();
    const byVendor = new Map<string, number>();
    const byTrade = new Map<string, number>();
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      if ((PUNCH_OPEN_STATUSES as readonly string[]).includes(r.status)) {
        if (r.assigneeId) byAssignee.set(r.assigneeId, (byAssignee.get(r.assigneeId) ?? 0) + 1);
        byVendor.set(r.vendorId ?? "none", (byVendor.get(r.vendorId ?? "none") ?? 0) + 1);
        byTrade.set(r.trade ?? "none", (byTrade.get(r.trade ?? "none") ?? 0) + 1);
      }
    }
    const open = rows.filter((r) => (PUNCH_OPEN_STATUSES as readonly string[]).includes(r.status));
    const completion = completionStats(rows, today);
    return {
      asOf: today,
      byStatus,
      byAssignee: [...byAssignee.entries()].map(([assigneeId, n]) => ({ assigneeId, count: n })).sort((a, b) => b.count - a.count).slice(0, 10),
      byVendor: [...byVendor.entries()].map(([vendorId, n]) => ({ vendorId: vendorId === "none" ? null : vendorId, count: n })).sort((a, b) => b.count - a.count),
      byTrade: [...byTrade.entries()].map(([trade, n]) => ({ trade: trade === "none" ? null : trade, count: n })).sort((a, b) => b.count - a.count),
      overdue: completion.overdue,
      completion,
      ageing: bucketise(open, (r) => ageInDays(r.createdAt, today), (r) => r.priority),
    };
  });

  app.get("/projects/:projectId/punch/export.csv", { preHandler: readGate }, async (req, reply) => {
    const q = exportQuery.parse(req.query);
    const rows = await app.db.select().from(punchItems).where(scope(req)).orderBy(asc(punchItems.number)).limit(5000);
    const vendorIds = [...new Set(rows.map((r) => r.vendorId).filter((v): v is string => Boolean(v)))];
    const vendorRows = vendorIds.length > 0 ? await app.db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(inArray(vendors.id, vendorIds)) : [];
    const vendorName = new Map(vendorRows.map((v) => [v.id, v.name]));
    const locs = await app.db.select({ id: locations.id, name: locations.name }).from(locations).where(and(eq(locations.companyId, req.companyId!), eq(locations.projectId, req.projectId!)));
    const locName = new Map(locs.map((l) => [l.id, l.name]));
    const today = todayISO();
    const flat = rows.map((r) => ({
      number: pad3(r.number),
      title: r.title,
      status: r.status,
      priority: r.priority,
      trade: r.trade ?? "",
      vendor: r.vendorId ? (vendorName.get(r.vendorId) ?? r.vendorId) : "",
      location: r.locationId ? (locName.get(r.locationId) ?? r.locationId) : "",
      assigneeId: r.assigneeId ?? "",
      verifierId: r.verifierId ?? "",
      dueDate: r.dueDate ?? "",
      daysOverdue: (PUNCH_OPEN_STATUSES as readonly string[]).includes(r.status) ? daysOverdue(r.dueDate, today) : "",
      createdAt: r.createdAt,
      closedAt: r.closedAt ?? "",
    }));
    const key = q.groupBy === "none" ? null : q.groupBy;
    if (key) flat.sort((a, b) => String(a[key]).localeCompare(String(b[key])) || a.number.localeCompare(b.number));
    const csv = toCsv(flat, [
      { key: "number", header: "No." },
      { key: "title", header: "Title" },
      { key: "status", header: "Status" },
      { key: "priority", header: "Priority" },
      { key: "trade", header: "Trade" },
      { key: "vendor", header: "Vendor" },
      { key: "location", header: "Location" },
      { key: "assigneeId", header: "Assignee id" },
      { key: "verifierId", header: "Verifier id" },
      { key: "dueDate", header: "Due" },
      { key: "daysOverdue", header: "Days overdue" },
      { key: "createdAt", header: "Created" },
      { key: "closedAt", header: "Closed" },
    ]);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "access",
      objectType: "punch_export",
      objectId: req.projectId!,
      payload: { groupBy: q.groupBy, rows: flat.length },
      projectId: req.projectId!,
    });
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="punch-list-by-${q.groupBy}.csv"`)
      .send(csv);
  });

  /* ---------------------------------------------------------------- */
  /* Detail / edit / lifecycle                                         */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/punch/:itemId", { preHandler: readGate }, async (req) => {
    const { itemId } = req.params as { itemId: string };
    const item = await fetchItem(itemId, req);
    const me = req.user!.id;
    const admin = await isAdmin(req);
    const settings = await loadFieldSettings(app.db, req.companyId!, req.projectId!);
    const can = (to: string) => authorisePunchTransition({ item, actorId: me, isAdmin: admin, to, settings: settings.punch });
    const verdicts = {
      in_progress: can("in_progress"),
      ready_for_review: can("ready_for_review"),
      closed: can("closed"),
      void: can("void"),
    };
    return {
      ...decorate(item, todayISO()),
      permissions: {
        isAdmin: admin,
        canStart: verdicts.in_progress.ok,
        canReadyForReview: verdicts.ready_for_review.ok,
        canClose: verdicts.closed.ok,
        canVoid: verdicts.void.ok,
        canEditVerifier: admin || item.status !== "ready_for_review",
        canEditAssignee: admin || item.status !== "ready_for_review",
        reasons: Object.fromEntries(Object.entries(verdicts).map(([k, v]) => [k, v.ok ? null : v.reason])),
      },
      settings: settings.punch,
    };
  });

  app.patch("/projects/:projectId/punch/:itemId", { preHandler: standardGate }, async (req) => {
    const { itemId } = req.params as { itemId: string };
    const body = punchPatchSchema.parse(req.body);
    const item = await fetchItem(itemId, req);
    if (item.status === "closed" || item.status === "void") {
      throw badRequest(`A ${item.status} punch item cannot be edited`);
    }
    await validateRefs(req, body);
    const admin = await isAdmin(req);
    const verdict = validateVerifierChange({
      item,
      nextVerifierId: body.verifierId,
      nextAssigneeId: body.assigneeId,
      actorId: req.user!.id,
      isAdmin: admin,
    });
    if (!verdict.ok) throw new AppError(verdict.status, verdict.reason);
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    for (const [k, v] of Object.entries(body)) if (v !== undefined) set[k] = v;
    const changed = Object.keys(body).filter((k) => body[k as keyof typeof body] !== undefined);
    await app.db.update(punchItems).set(set).where(eq(punchItems.id, itemId));
    await ledgerItem("update", itemId, req, { changed, before: pick(item, changed), after: pick(set, changed) }, true);
    if (body.assigneeId && body.assigneeId !== item.assigneeId) await notify(req, item, [body.assigneeId], "assignment");
    if (body.verifierId && body.verifierId !== item.verifierId) {
      await notify(req, item, [body.verifierId], "assignment", `${label(item.number)} names you as verifier: ${item.title}`);
    }
    return decorate(await fetchItem(itemId, req), todayISO());
  });

  app.post("/projects/:projectId/punch/:itemId/status", { preHandler: standardGate }, async (req) => {
    const { itemId } = req.params as { itemId: string };
    const body = z.object({ status: z.enum(PUNCH_STATUSES) }).parse(req.body);
    const item = await fetchItem(itemId, req);
    const me = req.user!.id;
    const admin = await isAdmin(req);
    const settings = await loadFieldSettings(app.db, req.companyId!, req.projectId!);
    const verdict = authorisePunchTransition({ item, actorId: me, isAdmin: admin, to: body.status, settings: settings.punch });
    if (!verdict.ok) throw new AppError(verdict.status, verdict.reason);
    const now = nowIso();
    const set: Record<string, unknown> = { status: body.status, updatedAt: now };
    if (body.status === "ready_for_review") {
      set["readyForReviewBy"] = me;
      set["readyForReviewAt"] = now;
    }
    if (body.status === "closed") {
      set["closedBy"] = me;
      set["closedAt"] = now;
    }
    if (body.status === "in_progress" && item.status === "ready_for_review") {
      set["readyForReviewBy"] = null;
      set["readyForReviewAt"] = null;
    }
    await app.db.update(punchItems).set(set).where(eq(punchItems.id, itemId));
    await ledgerItem("state_change", itemId, req, { from: item.status, to: body.status, adminOverride: admin && me !== item.verifierId && body.status === "closed" });
    if (body.status === "ready_for_review" && item.verifierId) {
      await notify(req, item, [item.verifierId], "status_change", `${label(item.number)} ready for your review: ${item.title}`);
    }
    if (body.status === "closed" || body.status === "in_progress") {
      await notify(
        req,
        item,
        [item.createdBy, item.assigneeId ?? "", ...item.distribution],
        "status_change",
        `${label(item.number)} ${body.status === "closed" ? "verified and closed" : "sent back to in progress"}: ${item.title}`,
      );
    }
    return decorate(await fetchItem(itemId, req), todayISO());
  });
};
