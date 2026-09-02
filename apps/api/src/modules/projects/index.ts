/**
 * Projects, the project substrate and the cross-tool primitives that hang off
 * it (Vol I §0.3 #49–#78).
 *
 * This module owns: the project record and its lifecycle, portfolios,
 * locations, cost codes, WBS segments, record links, comments and mentions,
 * watchers, tags, custom fields, saved views, bulk edit and CSV import, and
 * the recycle bin.
 *
 * WHAT CHANGED IN THIS WAVE
 *  • `GET /projects` is scoped to project membership (see access.ts). It used
 *    to hand every project's name, value, address and dates to any member of
 *    the tenant, including a subcontractor with one membership.
 *  • deletion is soft (#78): a project, and every child record keyed to it,
 *    survives a mis-click and can be restored. A hard purge is a separate,
 *    explicit route that refuses under a legal hold.
 *  • the lifecycle has rules (lifecycle.ts): stage reversals and currency
 *    changes are privileged, dates are validated, and a currency cannot move
 *    while money records denominated in the old one exist.
 *  • custom field values are validated against their definition
 *    (customfields.ts) instead of being written as opaque JSON.
 *  • watchers and custom field values carry tenant columns, so a record id
 *    from another company can no longer be used to read or write against them.
 *  • watching finally does something: `notifyWatchers` fires on comments and
 *    project state changes.
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, like, ne, or } from "drizzle-orm";
import { z } from "zod";
import {
  assets,
  bimModels,
  budgetLineItems,
  comments,
  commitmentSovLines,
  companyMemberships,
  costCodes,
  customFieldDefs,
  customFieldValues,
  distributionGroups,
  drawingSheets,
  equipment,
  importJobs,
  invoiceLineItems,
  legalHolds,
  locations,
  portfolios,
  projectMemberships,
  projects,
  punchItems,
  recordLinks,
  rfis,
  safetyIncidents,
  savedViews,
  signals,
  submittals,
  tagAssignments,
  tags,
  users,
  watchers,
  wbsSegments,
  workflowTemplates,
} from "@constructos/db";
import {
  COST_TYPES,
  PROJECT_STAGES,
  SAVED_VIEW_SCOPES,
  TOOLS,
  type ToolKey,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { pushNotifications, notifyWatchers } from "../notifications/service.js";
import { canUseTool, loadProjectAccess, visibleProjectIds } from "./access.js";
import { missingRequired, validateFieldValues, type FieldDefLike } from "./customfields.js";
import {
  allowedNextStages,
  currencyChange,
  stageTransition,
  validateProjectDates,
} from "./lifecycle.js";
import {
  committableRows,
  IMPORT_SPECS,
  parseCsv,
  templateCsv,
  toRecords,
  validateRows,
  type ImportRowError,
} from "./import.js";
import { checkRecord } from "./records.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const projectCreateSchema = z.object({
  name: z.string().min(1).max(200),
  number: z.string().max(50).optional(),
  stage: z.enum(PROJECT_STAGES).optional(),
  type: z.string().max(100).optional(),
  department: z.string().max(100).optional(),
  address: z.string().max(300).optional(),
  city: z.string().max(100).optional(),
  country: z.string().max(100).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  startDate: z.string().optional(),
  finishDate: z.string().optional(),
  currency: z.string().min(3).max(3).optional(),
  value: z.number().optional(),
  description: z.string().max(5000).optional(),
  portfolioId: z.string().nullable().optional(),
  /** a template project is a shape to clone, not an operational project (#5) */
  isTemplate: z.boolean().optional(),
  /** a sandbox project is excluded from portfolio roll-ups (#6) */
  isSandbox: z.boolean().optional(),
});

const projectPatchSchema = projectCreateSchema.partial().extend({
  name: z.string().min(1).max(200).optional(),
});

const projectListQuery = pageQuerySchema.extend({
  stage: z.enum(PROJECT_STAGES).optional(),
  search: z.string().max(200).optional(),
  portfolioId: z.string().optional(),
  /** templates and sandboxes are hidden from operational views by default */
  include: z.enum(["operational", "templates", "sandbox", "all"]).default("operational"),
});

const cloneSchema = z.object({
  name: z.string().min(1).max(200),
  number: z.string().max(50).optional(),
  include: z
    .array(
      z.enum([
        "locations",
        "costCodes",
        "customFields",
        "workflowTemplates",
        "memberships",
        "distributionGroups",
        "wbs",
      ]),
    )
    .default(["locations", "costCodes", "customFields", "wbs"]),
  asTemplate: z.boolean().optional(),
  asSandbox: z.boolean().optional(),
});

const savedViewSchema = z.object({
  tableId: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  scope: z.enum(SAVED_VIEW_SCOPES).default("private"),
  projectId: z.string().max(100).nullable().optional(),
  isDefault: z.boolean().optional(),
  state: z.record(z.string(), z.unknown()).default({}),
});

const savedViewPatchSchema = savedViewSchema.partial().omit({ tableId: true });

const projectBulkSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
  patch: z
    .object({
      stage: z.enum(PROJECT_STAGES).optional(),
      portfolioId: z.string().nullable().optional(),
      department: z.string().max(100).nullable().optional(),
      type: z.string().max(100).nullable().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, "Nothing to update"),
});

const portfolioSchema = z.object({
  name: z.string().min(1).max(200),
  programme: z.string().max(200).nullable().optional(),
});

const locationCreateSchema = z.object({
  name: z.string().min(1).max(200),
  parentId: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
});

const locationPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  sortOrder: z.number().int().optional(),
  /** present = move (null = to root). absent = no move */
  parentId: z.string().nullable().optional(),
});

const costCodeCreateSchema = z.object({
  code: z.string().min(1).max(50),
  title: z.string().min(1).max(300),
  division: z.string().max(100).nullable().optional(),
  costType: z.enum(COST_TYPES).nullable().optional(),
  parentId: z.string().nullable().optional(),
});

const costCodePatchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  division: z.string().max(100).nullable().optional(),
  costType: z.enum(COST_TYPES).nullable().optional(),
  isActive: z.boolean().optional(),
});

const WBS_SEGMENT_TYPES = ["cost_code", "cost_type", "sub_job", "custom"] as const;

const wbsCreateSchema = z.object({
  name: z.string().min(1).max(200),
  segmentType: z.enum(WBS_SEGMENT_TYPES),
  position: z.number().int().min(0),
});

const wbsPatchSchema = wbsCreateSchema.partial();

const linkCreateSchema = z.object({
  fromType: z.string().min(1).max(50),
  fromId: z.string().min(1),
  toType: z.string().min(1).max(50),
  toId: z.string().min(1),
  linkKind: z.string().max(50).optional(),
});

const commentCreateSchema = z.object({
  body: z.string().min(1).max(10000),
  mentions: z.array(z.string()).max(50).optional(),
});

const tagAssignSchema = z
  .object({
    tagId: z.string().optional(),
    name: z.string().min(1).max(100).optional(),
    color: z.string().max(30).optional(),
  })
  .refine((v) => v.tagId || v.name, { message: "tagId or name is required" });

const FIELD_TYPES = [
  "text",
  "number",
  "date",
  "dropdown",
  "multi_select",
  "checkbox",
  "currency",
  "lookup",
] as const;

const fieldDefCreateSchema = z.object({
  projectId: z.string().nullable().optional(),
  tool: z.enum(TOOLS),
  key: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9_]+$/, "key must be lowercase snake_case"),
  label: z.string().min(1).max(200),
  fieldType: z.enum(FIELD_TYPES),
  options: z.array(z.string()).max(200).optional(),
  required: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const fieldDefPatchSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  options: z.array(z.string()).max(200).optional(),
  required: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const customValuesSchema = z.object({
  values: z.record(z.string(), z.unknown()),
});

/** statuses considered "open" for the project summary */
const OPEN_RFI = ["open", "answered"];
const OPEN_SUBMITTAL = ["open", "in_review", "responded"];
const OPEN_PUNCH = ["open", "in_progress", "ready_for_review"];
const OPEN_SIGNAL = ["new", "under_review", "confirmed", "escalated"];

interface RecordParams {
  projectId: string;
  recordType: string;
  recordId: string;
}

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

export const projectsModule: FastifyPluginAsync = async (app) => {
  const memberGate = [app.authenticate, app.requireCompany];
  const creatorGate = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin", "member"]),
  ];
  const adminGate = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin"]),
  ];
  const ownerGate = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner"]),
  ];
  const tool = (level: "read" | "standard" | "admin") => [
    app.authenticate,
    app.requireCompany,
    app.requireTool("projects", level),
  ];

  /* ---------------------------------------------------------------- */
  /* Shared helpers                                                    */
  /* ---------------------------------------------------------------- */

  /** The project, or 404 — never a soft-deleted one. */
  async function liveProject(companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.companyId, companyId),
          isNull(projects.deletedAt),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Project not found");
    return rows[0];
  }

  /**
   * How much money is denominated in this project's currency, by record
   * class. Used to refuse a currency change (which would restate every stored
   * amount) and to refuse a purge (which would sever ledger-referenced rows).
   */
  async function moneyFootprint(companyId: string, projectId: string, currency: string) {
    const counts: Record<string, number> = {};
    const tally = async (label: string, run: () => Promise<Array<{ n: unknown }>>) => {
      const [row] = await run();
      counts[label] = Number(row?.n ?? 0);
    };
    await tally("budget lines", () =>
      app.db
        .select({ n: count() })
        .from(budgetLineItems)
        .where(
          and(eq(budgetLineItems.companyId, companyId), eq(budgetLineItems.projectId, projectId)),
        ),
    );
    await tally("commitment lines", () =>
      app.db
        .select({ n: count() })
        .from(commitmentSovLines)
        .where(
          and(
            eq(commitmentSovLines.companyId, companyId),
            eq(commitmentSovLines.projectId, projectId),
          ),
        ),
    );
    await tally("invoice lines", () =>
      app.db
        .select({ n: count() })
        .from(invoiceLineItems)
        .where(
          and(eq(invoiceLineItems.companyId, companyId), eq(invoiceLineItems.projectId, projectId)),
        ),
    );
    return { counts, currencies: [currency] };
  }

  /**
   * Refuse a delete while a legal hold covers the record (#47).
   *
   * A hold may name a project, an object class, or a single record; the
   * refusal names the hold that caused it so the person can find who placed
   * it rather than filing a ticket.
   */
  async function assertNoLegalHold(
    companyId: string,
    objectType: string,
    objectId: string,
    projectId: string | null,
  ) {
    const rows = await app.db
      .select({
        id: legalHolds.id,
        name: legalHolds.name,
        projectId: legalHolds.projectId,
        objectType: legalHolds.objectType,
        objectId: legalHolds.objectId,
      })
      .from(legalHolds)
      .where(and(eq(legalHolds.companyId, companyId), eq(legalHolds.status, "active")));
    const covering = rows.find(
      (h) =>
        (h.projectId === null || h.projectId === projectId) &&
        (h.objectType === null || h.objectType === objectType) &&
        (h.objectId === null || h.objectId === objectId),
    );
    if (covering) {
      throw conflict(
        `Legal hold "${covering.name}" covers this record; it cannot be deleted while the hold is active.`,
      );
    }
  }

  /**
   * Refuse to attach a watcher / value / tag to a record that does not belong
   * to this project. For record types the registry does not cover the check
   * cannot be made — the tenant columns on the attachment tables still scope
   * every later read, which is the part that mattered.
   */
  async function assertRecordInProject(
    companyId: string,
    projectId: string,
    recordType: string,
    recordId: string,
  ) {
    const result = await checkRecord(app.db, companyId, projectId, recordType, recordId);
    if (result.known && !result.exists) {
      throw badRequest(`No ${recordType} with id ${recordId} in this project`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Projects (spec #49-53, #71)                                       */
  /* ---------------------------------------------------------------- */

  /**
   * The portfolio list.
   *
   * Scoped to what the caller may actually open. Before this, the list was
   * filtered by `companyId` alone while `GET /projects/:id` required a
   * membership — so a subcontractor saw the name, number, address, dates,
   * currency and recorded value of every project in the tenant and got a 403
   * on clicking through. See access.ts.
   */
  app.get("/projects", { preHandler: memberGate }, async (req) => {
    const q = projectListQuery.parse(req.query);
    const visible = await visibleProjectIds(app, req);
    if (visible !== null && visible.length === 0) {
      return paginate([], 0, q);
    }
    const conds = [eq(projects.companyId, req.companyId!), isNull(projects.deletedAt)];
    if (visible !== null) conds.push(inArray(projects.id, visible));
    if (q.stage) conds.push(eq(projects.stage, q.stage));
    if (q.portfolioId) conds.push(eq(projects.portfolioId, q.portfolioId));
    if (q.include === "operational") {
      conds.push(eq(projects.isTemplate, 0));
      conds.push(eq(projects.isSandbox, 0));
    } else if (q.include === "templates") {
      conds.push(eq(projects.isTemplate, 1));
    } else if (q.include === "sandbox") {
      conds.push(eq(projects.isSandbox, 1));
    }
    if (q.search) {
      const term = `%${q.search}%`;
      conds.push(or(ilike(projects.name, term), ilike(projects.number, term))!);
    }
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(projects).where(where);
    const items = await app.db
      .select()
      .from(projects)
      .where(where)
      .orderBy(desc(projects.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/projects", { preHandler: creatorGate }, async (req, reply) => {
    const body = projectCreateSchema.parse(req.body);
    if (body.portfolioId) {
      const pf = await app.db
        .select({ id: portfolios.id })
        .from(portfolios)
        .where(and(eq(portfolios.id, body.portfolioId), eq(portfolios.companyId, req.companyId!)))
        .limit(1);
      if (!pf[0]) throw badRequest("Unknown portfolio");
    }
    const dates = validateProjectDates(body.startDate, body.finishDate);
    if (!dates.ok) throw badRequest(dates.reason);
    const id = newId("prj");
    // One transaction: a project without its creator's membership is a
    // project nobody can open, and the two writes must not be able to
    // separate.
    const created = await app.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(projects)
        .values({
          id,
          companyId: req.companyId!,
          name: body.name,
          number: body.number ?? null,
          stage: body.stage ?? "pre_construction",
          type: body.type ?? null,
          department: body.department ?? null,
          address: body.address ?? null,
          city: body.city ?? null,
          country: body.country ?? null,
          latitude: body.latitude ?? null,
          longitude: body.longitude ?? null,
          startDate: body.startDate ?? null,
          finishDate: body.finishDate ?? null,
          currency: body.currency ?? "USD",
          value: body.value ?? null,
          description: body.description ?? null,
          portfolioId: body.portfolioId ?? null,
          isTemplate: body.isTemplate ? 1 : 0,
          isSandbox: body.isSandbox ? 1 : 0,
        })
        .returning();
      // the creator becomes project admin so they can operate their own project
      await tx.insert(projectMemberships).values({
        id: newId("pm"),
        companyId: req.companyId!,
        projectId: id,
        userId: req.user!.id,
        templateKey: "project_admin",
      });
      return row;
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "project",
      objectId: id,
      payload: created,
      storePayload: true,
    });
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId", { preHandler: tool("read") }, async (req) => {
    // `requireTool` lives in a shared plugin this package does not own and
    // resolves the project without a deleted_at filter, so every route here
    // checks it for itself.
    const project = await liveProject(req.companyId!, req.projectId!);
    const access = await loadProjectAccess(app, req);
    return {
      ...project,
      allowedNextStages: allowedNextStages(
        project.stage,
        canUseTool(access, project.id, "projects", "admin"),
      ),
    };
  });

  app.patch("/projects/:projectId", { preHandler: tool("standard") }, async (req) => {
    const body = projectPatchSchema.parse(req.body);
    const existing = await liveProject(req.companyId!, req.projectId!);
    const access = await loadProjectAccess(app, req);
    const isProjectAdmin = canUseTool(access, req.projectId!, "projects", "admin");

    const dates = validateProjectDates(
      body.startDate ?? existing.startDate,
      body.finishDate ?? existing.finishDate,
    );
    if (!dates.ok) throw badRequest(dates.reason);

    if (body.stage !== undefined && body.stage !== existing.stage) {
      const decision = stageTransition(existing.stage, body.stage);
      if (!decision.allowed) throw badRequest(decision.reason);
      if (decision.requiresAdmin && !isProjectAdmin) {
        throw forbidden(
          `Moving a project from "${existing.stage}" to "${body.stage}" is a reversal or a skipped stage and needs projects:admin`,
        );
      }
    }

    if (body.currency !== undefined && body.currency !== existing.currency) {
      if (!isProjectAdmin) throw forbidden("Changing a project's currency needs projects:admin");
      const footprint = await moneyFootprint(req.companyId!, req.projectId!, existing.currency);
      const decision = currencyChange(existing.currency, body.currency, footprint);
      if (!decision.allowed) throw conflict(decision.reason);
    }

    if (body.value !== undefined && body.value !== existing.value && !isProjectAdmin) {
      throw forbidden("Changing a project's recorded value needs projects:admin");
    }

    if (body.portfolioId) {
      const pf = await app.db
        .select({ id: portfolios.id })
        .from(portfolios)
        .where(and(eq(portfolios.id, body.portfolioId), eq(portfolios.companyId, req.companyId!)))
        .limit(1);
      if (!pf[0]) throw badRequest("Unknown portfolio");
    }

    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const key of [
      "name",
      "number",
      "stage",
      "type",
      "department",
      "address",
      "city",
      "country",
      "latitude",
      "longitude",
      "startDate",
      "finishDate",
      "currency",
      "value",
      "description",
      "portfolioId",
    ] as const) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (body.isTemplate !== undefined) patch["isTemplate"] = body.isTemplate ? 1 : 0;
    if (body.isSandbox !== undefined) patch["isSandbox"] = body.isSandbox ? 1 : 0;
    const [updated] = await app.db
      .update(projects)
      .set(patch)
      .where(and(eq(projects.id, req.projectId!), eq(projects.companyId, req.companyId!)))
      .returning();

    const stageChanged = body.stage !== undefined && body.stage !== existing.stage;
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: stageChanged ? "state_change" : "update",
      objectType: "project",
      objectId: req.projectId!,
      payload: stageChanged ? { from: existing.stage, to: body.stage, patch } : patch,
      storePayload: true,
      projectId: req.projectId!,
    });
    if (stageChanged) {
      // #70 — watching finally means something.
      await notifyWatchers(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        recordType: "project",
        recordId: req.projectId!,
        actorId: req.user!.id,
        kind: "status_change",
        title: `${existing.name} moved to ${String(body.stage).replace(/_/g, " ")}`,
        body: `Stage changed from ${existing.stage.replace(/_/g, " ")}.`,
        tool: "projects",
      });
    }
    return updated;
  });

  /**
   * Soft-delete a project (#78).
   *
   * The hard delete this replaces removed one row from `projects` and left
   * every child record — memberships, locations, cost codes, RFIs, budgets,
   * signals, notifications — pointing at a project that no longer existed but
   * that company-wide counters still counted. There are no foreign keys in
   * this schema, so a cascade would have to be hand-written across 249 tables
   * and would be wrong the first time a table was added.
   *
   * Instead the project is marked deleted and disappears from every list and
   * every gate in this module. It can be restored intact, and purged
   * explicitly (which still refuses under a legal hold).
   */
  app.delete("/projects/:projectId", { preHandler: tool("admin") }, async (req) => {
    const project = await liveProject(req.companyId!, req.projectId!);
    await assertNoLegalHold(req.companyId!, "project", req.projectId!, req.projectId!);
    const now = new Date().toISOString();
    await app.db
      .update(projects)
      .set({ deletedAt: now, deletedBy: req.user!.id, updatedAt: now })
      .where(and(eq(projects.id, req.projectId!), eq(projects.companyId, req.companyId!)));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "project",
      objectId: req.projectId!,
      payload: { id: project.id, name: project.name, soft: true },
      storePayload: true,
      projectId: req.projectId!,
    });
    return { ok: true, deletedAt: now, restorable: true };
  });

  /* ---------------------------------------------------------------- */
  /* Recycle bin (#78)                                                 */
  /* ---------------------------------------------------------------- */

  app.get("/recycle-bin", { preHandler: adminGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const rows = await app.db
      .select({
        id: projects.id,
        name: projects.name,
        number: projects.number,
        stage: projects.stage,
        deletedAt: projects.deletedAt,
        deletedBy: projects.deletedBy,
        deletedByName: users.name,
      })
      .from(projects)
      .leftJoin(users, eq(users.id, projects.deletedBy))
      .where(and(eq(projects.companyId, req.companyId!), isNotNull(projects.deletedAt)))
      .orderBy(desc(projects.deletedAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(projects)
      .where(and(eq(projects.companyId, req.companyId!), isNotNull(projects.deletedAt)));
    return paginate(
      rows.map((r) => ({ ...r, objectType: "project" as const })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.post("/recycle-bin/projects/:projectId/restore", { preHandler: adminGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const rows = await app.db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.companyId, req.companyId!),
          isNotNull(projects.deletedAt),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("No deleted project with that id");
    const now = new Date().toISOString();
    await app.db
      .update(projects)
      .set({ deletedAt: null, deletedBy: null, updatedAt: now })
      .where(eq(projects.id, projectId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "project",
      objectId: projectId,
      payload: { event: "restored", deletedAt: rows[0].deletedAt },
      storePayload: true,
      projectId,
    });
    return { ok: true, id: projectId, restored: true };
  });

  /**
   * Purge a soft-deleted project for good.
   *
   * Owner-only, refuses under a legal hold, and refuses while the project
   * still holds executed money records — the same reasoning as the prime
   * contract delete guard. What it removes is the substrate this module owns
   * (memberships, locations, cost codes, WBS, links, comments, watchers,
   * custom values, saved views) plus the project row; other modules' records
   * are LISTED in the response rather than silently destroyed, because this
   * module cannot know whether they are still evidence.
   */
  app.delete("/recycle-bin/projects/:projectId", { preHandler: ownerGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const rows = await app.db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.companyId, req.companyId!),
          isNotNull(projects.deletedAt),
        ),
      )
      .limit(1);
    const project = rows[0];
    if (!project) throw notFound("No deleted project with that id");
    await assertNoLegalHold(req.companyId!, "project", projectId, projectId);

    const residual = await moneyFootprint(req.companyId!, projectId, project.currency);
    const held = Object.entries(residual.counts).filter(([, n]) => n > 0);
    if (held.length > 0) {
      throw conflict(
        `This project still holds ${held.map(([k, n]) => `${n} ${k}`).join(", ")}. Purging it would sever records the ledger references; export them first.`,
      );
    }

    const removed = await app.db.transaction(async (tx) => {
      const counts: Record<string, number> = {};
      const del = async (label: string, fn: () => Promise<{ id: string }[]>) => {
        counts[label] = (await fn()).length;
      };
      await del("memberships", () =>
        tx
          .delete(projectMemberships)
          .where(eq(projectMemberships.projectId, projectId))
          .returning({ id: projectMemberships.id }),
      );
      await del("locations", () =>
        tx.delete(locations).where(eq(locations.projectId, projectId)).returning({ id: locations.id }),
      );
      await del("costCodes", () =>
        tx.delete(costCodes).where(eq(costCodes.projectId, projectId)).returning({ id: costCodes.id }),
      );
      await del("wbs", () =>
        tx.delete(wbsSegments).where(eq(wbsSegments.projectId, projectId)).returning({ id: wbsSegments.id }),
      );
      await del("links", () =>
        tx.delete(recordLinks).where(eq(recordLinks.projectId, projectId)).returning({ id: recordLinks.id }),
      );
      await del("comments", () =>
        tx.delete(comments).where(eq(comments.projectId, projectId)).returning({ id: comments.id }),
      );
      await del("watchers", () =>
        tx.delete(watchers).where(eq(watchers.projectId, projectId)).returning({ id: watchers.id }),
      );
      await del("customValues", () =>
        tx
          .delete(customFieldValues)
          .where(eq(customFieldValues.projectId, projectId))
          .returning({ id: customFieldValues.id }),
      );
      await del("savedViews", () =>
        tx.delete(savedViews).where(eq(savedViews.projectId, projectId)).returning({ id: savedViews.id }),
      );
      await tx.delete(projects).where(eq(projects.id, projectId));
      return counts;
    });

    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "project",
      objectId: projectId,
      payload: { event: "purged", name: project.name, removed },
      storePayload: true,
      projectId,
    });
    return { ok: true, purged: true, removed };
  });

  /* ---------------------------------------------------------------- */
  /* Templates and cloning (#5, #6)                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Deep-copy a project's SHAPE — never its transactions.
   *
   * What is copied is the configuration a new job needs on day one:
   * locations, cost codes, custom field definitions, WBS, workflow templates,
   * memberships and distribution groups. Ids are remapped so the clone's
   * hierarchy points at the clone. Nothing operational (RFIs, budgets,
   * invoices) is copied — a clone of a live project's records would be an
   * invented history.
   */
  app.post("/projects/:projectId/clone", { preHandler: tool("admin") }, async (req, reply) => {
    const body = cloneSchema.parse(req.body);
    const source = await liveProject(req.companyId!, req.projectId!);
    const include = new Set(body.include);
    const newProjectId = newId("prj");
    const companyId = req.companyId!;
    const actorId = req.user!.id;

    const summary = await app.db.transaction(async (tx) => {
      const copied: Record<string, number> = {};
      await tx.insert(projects).values({
        id: newProjectId,
        companyId,
        name: body.name,
        number: body.number ?? null,
        stage: "pre_construction",
        type: source.type,
        department: source.department,
        address: source.address,
        city: source.city,
        country: source.country,
        currency: source.currency,
        description: source.description,
        settings: source.settings,
        portfolioId: source.portfolioId,
        isTemplate: body.asTemplate ? 1 : 0,
        isSandbox: body.asSandbox ? 1 : 0,
        clonedFromId: source.id,
      });
      await tx.insert(projectMemberships).values({
        id: newId("pm"),
        companyId,
        projectId: newProjectId,
        userId: actorId,
        templateKey: "project_admin",
      });

      if (include.has("locations")) {
        const rows = await tx
          .select()
          .from(locations)
          .where(and(eq(locations.companyId, companyId), eq(locations.projectId, source.id)))
          .orderBy(asc(locations.path));
        const idMap = new Map<string, string>();
        for (const row of rows) idMap.set(row.id, newId("loc"));
        const values = rows.map((row) => {
          const remapped = row.path
            .split("/")
            .map((segment) => idMap.get(segment) ?? segment)
            .join("/");
          return {
            id: idMap.get(row.id)!,
            companyId,
            projectId: newProjectId,
            parentId: row.parentId ? (idMap.get(row.parentId) ?? null) : null,
            name: row.name,
            path: remapped,
            sortOrder: row.sortOrder,
          };
        });
        if (values.length > 0) await tx.insert(locations).values(values);
        copied["locations"] = values.length;
      }

      if (include.has("costCodes")) {
        const rows = await tx
          .select()
          .from(costCodes)
          .where(and(eq(costCodes.companyId, companyId), eq(costCodes.projectId, source.id)));
        const idMap = new Map<string, string>();
        for (const row of rows) idMap.set(row.id, newId("cc"));
        const values = rows.map((row) => ({
          id: idMap.get(row.id)!,
          companyId,
          projectId: newProjectId,
          code: row.code,
          title: row.title,
          division: row.division,
          costType: row.costType,
          parentId: row.parentId ? (idMap.get(row.parentId) ?? null) : null,
          isActive: row.isActive,
        }));
        if (values.length > 0) await tx.insert(costCodes).values(values);
        copied["costCodes"] = values.length;
      }

      if (include.has("customFields")) {
        const rows = await tx
          .select()
          .from(customFieldDefs)
          .where(
            and(eq(customFieldDefs.companyId, companyId), eq(customFieldDefs.projectId, source.id)),
          );
        const values = rows.map((row) => ({
          id: newId("cfd"),
          companyId,
          projectId: newProjectId,
          tool: row.tool,
          key: row.key,
          label: row.label,
          fieldType: row.fieldType,
          options: row.options,
          required: row.required,
          sortOrder: row.sortOrder,
        }));
        if (values.length > 0) await tx.insert(customFieldDefs).values(values);
        copied["customFields"] = values.length;
      }

      if (include.has("wbs")) {
        const rows = await tx
          .select()
          .from(wbsSegments)
          .where(and(eq(wbsSegments.companyId, companyId), eq(wbsSegments.projectId, source.id)));
        const values = rows.map((row) => ({
          id: newId("wbs"),
          companyId,
          projectId: newProjectId,
          name: row.name,
          segmentType: row.segmentType,
          position: row.position,
        }));
        if (values.length > 0) await tx.insert(wbsSegments).values(values);
        copied["wbs"] = values.length;
      }

      if (include.has("workflowTemplates")) {
        const rows = await tx
          .select()
          .from(workflowTemplates)
          .where(
            and(
              eq(workflowTemplates.companyId, companyId),
              eq(workflowTemplates.projectId, source.id),
            ),
          );
        const values = rows.map((row) => ({
          id: newId("wft"),
          companyId,
          projectId: newProjectId,
          name: row.name,
          recordType: row.recordType,
          version: 1,
          steps: row.steps,
          isActive: row.isActive,
          createdBy: actorId,
        }));
        if (values.length > 0) await tx.insert(workflowTemplates).values(values);
        copied["workflowTemplates"] = values.length;
      }

      if (include.has("memberships")) {
        const rows = await tx
          .select()
          .from(projectMemberships)
          .where(
            and(
              eq(projectMemberships.companyId, companyId),
              eq(projectMemberships.projectId, source.id),
              ne(projectMemberships.userId, actorId),
            ),
          );
        const values = rows.map((row) => ({
          id: newId("pm"),
          companyId,
          projectId: newProjectId,
          userId: row.userId,
          templateKey: row.templateKey,
          overrides: row.overrides,
        }));
        if (values.length > 0) await tx.insert(projectMemberships).values(values);
        copied["memberships"] = values.length;
      }

      if (include.has("distributionGroups")) {
        const rows = await tx
          .select()
          .from(distributionGroups)
          .where(
            and(
              eq(distributionGroups.companyId, companyId),
              eq(distributionGroups.projectId, source.id),
            ),
          );
        const values = rows.map((row) => ({
          id: newId("dg"),
          companyId,
          projectId: newProjectId,
          name: row.name,
        }));
        if (values.length > 0) await tx.insert(distributionGroups).values(values);
        copied["distributionGroups"] = values.length;
      }

      return copied;
    });

    await appendLedger(app.db, {
      companyId,
      actorId,
      action: "create",
      objectType: "project",
      objectId: newProjectId,
      payload: { clonedFrom: source.id, name: body.name, copied: summary },
      storePayload: true,
      projectId: newProjectId,
    });

    const [created] = await app.db.select().from(projects).where(eq(projects.id, newProjectId));
    return reply.status(201).send({ ...created, copied: summary });
  });

  /* ---------------------------------------------------------------- */
  /* Bulk edit (#76)                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Change one field across many projects.
   *
   * Every id is checked against the caller's own project access — a bulk
   * endpoint is exactly where a scoping mistake becomes a tenant-wide one —
   * and the whole batch is one transaction so a partial apply is impossible.
   */
  app.post("/projects/bulk", { preHandler: adminGate }, async (req) => {
    const body = projectBulkSchema.parse(req.body);
    const visible = await visibleProjectIds(app, req);
    const rows = await app.db
      .select({ id: projects.id, stage: projects.stage, name: projects.name })
      .from(projects)
      .where(
        and(
          eq(projects.companyId, req.companyId!),
          inArray(projects.id, body.ids),
          isNull(projects.deletedAt),
        ),
      );
    const allowed = rows.filter((r) => visible === null || visible.includes(r.id));
    const refused = body.ids.filter((id) => !allowed.some((r) => r.id === id));

    if (body.patch.portfolioId) {
      const pf = await app.db
        .select({ id: portfolios.id })
        .from(portfolios)
        .where(
          and(eq(portfolios.id, body.patch.portfolioId), eq(portfolios.companyId, req.companyId!)),
        )
        .limit(1);
      if (!pf[0]) throw badRequest("Unknown portfolio");
    }

    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.patch.stage !== undefined) patch["stage"] = body.patch.stage;
    if (body.patch.portfolioId !== undefined) patch["portfolioId"] = body.patch.portfolioId;
    if (body.patch.department !== undefined) patch["department"] = body.patch.department;
    if (body.patch.type !== undefined) patch["type"] = body.patch.type;

    const updatedIds: string[] = [];
    if (allowed.length > 0) {
      await app.db.transaction(async (tx) => {
        await tx
          .update(projects)
          .set(patch)
          .where(
            and(
              eq(projects.companyId, req.companyId!),
              inArray(
                projects.id,
                allowed.map((r) => r.id),
              ),
            ),
          );
      });
      updatedIds.push(...allowed.map((r) => r.id));
    }
    for (const id of updatedIds) {
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: body.patch.stage !== undefined ? "state_change" : "update",
        objectType: "project",
        objectId: id,
        payload: { bulk: true, ...body.patch },
        projectId: id,
      });
    }
    return { updated: updatedIds.length, ids: updatedIds, refused };
  });

  /** Cross-tool dashboard counters for the project home page. */
  app.get("/projects/:projectId/summary", { preHandler: tool("read") }, async (req) => {
    const pid = req.projectId!;
    const cid = req.companyId!;
    const countWhere = async (
      table:
        | typeof rfis
        | typeof submittals
        | typeof punchItems
        | typeof drawingSheets
        | typeof bimModels
        | typeof assets
        | typeof signals,
      extra?: ReturnType<typeof inArray>,
    ) => {
      const conds = [eq(table.companyId, cid), eq(table.projectId, pid)];
      if (extra) conds.push(extra);
      const [row] = await app.db.select({ n: count() }).from(table).where(and(...conds));
      return Number(row?.n ?? 0);
    };
    const [rfisOpen, submittalsOpen, punchOpen, sheets, models, assetCount, signalsOpen] =
      await Promise.all([
        countWhere(rfis, inArray(rfis.status, OPEN_RFI)),
        countWhere(submittals, inArray(submittals.status, OPEN_SUBMITTAL)),
        countWhere(punchItems, inArray(punchItems.status, OPEN_PUNCH)),
        countWhere(drawingSheets),
        countWhere(bimModels),
        countWhere(assets),
        countWhere(signals, inArray(signals.disposition, OPEN_SIGNAL)),
      ]);
    return {
      rfisOpen,
      submittalsOpen,
      punchOpen,
      sheets,
      models,
      assets: assetCount,
      signalsOpen,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Portfolios / programmes (spec #52-53)                             */
  /* ---------------------------------------------------------------- */

  app.get("/portfolios", { preHandler: memberGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = eq(portfolios.companyId, req.companyId!);
    const [totalRow] = await app.db.select({ n: count() }).from(portfolios).where(where);
    const items = await app.db
      .select()
      .from(portfolios)
      .where(where)
      .orderBy(asc(portfolios.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/portfolios", { preHandler: creatorGate }, async (req, reply) => {
    const body = portfolioSchema.parse(req.body);
    const [created] = await app.db
      .insert(portfolios)
      .values({
        id: newId("pf"),
        companyId: req.companyId!,
        name: body.name,
        programme: body.programme ?? null,
      })
      .returning();
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "portfolio",
      objectId: created!.id,
      payload: created,
    });
    return reply.status(201).send(created);
  });

  app.patch("/portfolios/:portfolioId", { preHandler: creatorGate }, async (req) => {
    const { portfolioId } = req.params as { portfolioId: string };
    const body = portfolioSchema.partial().parse(req.body);
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch["name"] = body.name;
    if (body.programme !== undefined) patch["programme"] = body.programme;
    if (Object.keys(patch).length === 0) throw badRequest("Nothing to update");
    const [updated] = await app.db
      .update(portfolios)
      .set(patch)
      .where(and(eq(portfolios.id, portfolioId), eq(portfolios.companyId, req.companyId!)))
      .returning();
    if (!updated) throw notFound("Portfolio not found");
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "portfolio",
      objectId: portfolioId,
      payload: patch,
    });
    return updated;
  });

  app.delete("/portfolios/:portfolioId", { preHandler: adminGate }, async (req) => {
    const { portfolioId } = req.params as { portfolioId: string };
    const rows = await app.db
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(and(eq(portfolios.id, portfolioId), eq(portfolios.companyId, req.companyId!)))
      .limit(1);
    if (!rows[0]) throw notFound("Portfolio not found");
    await app.db.transaction(async (tx) => {
      // detach projects, then remove the grouping
      await tx
        .update(projects)
        .set({ portfolioId: null })
        .where(and(eq(projects.portfolioId, portfolioId), eq(projects.companyId, req.companyId!)));
      await tx
        .delete(portfolios)
        .where(and(eq(portfolios.id, portfolioId), eq(portfolios.companyId, req.companyId!)));
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "portfolio",
      objectId: portfolioId,
    });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* Locations — hierarchical tree (spec #54-55)                       */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/locations", { preHandler: tool("read") }, async (req) => {
    const items = await app.db
      .select()
      .from(locations)
      .where(
        and(eq(locations.companyId, req.companyId!), eq(locations.projectId, req.projectId!)),
      )
      .orderBy(asc(locations.path), asc(locations.sortOrder));

    type LocationRow = (typeof items)[number];
    type TreeNode = LocationRow & { children: TreeNode[] };
    const byId = new Map<string, TreeNode>();
    for (const row of items) byId.set(row.id, { ...row, children: [] });
    const tree: TreeNode[] = [];
    for (const node of byId.values()) {
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      if (parent) parent.children.push(node);
      else tree.push(node);
    }
    return { items, tree, total: items.length };
  });

  app.post("/projects/:projectId/locations", { preHandler: tool("standard") }, async (req, reply) => {
    const body = locationCreateSchema.parse(req.body);
    let parentPath: string | null = null;
    if (body.parentId) {
      const parentRows = await app.db
        .select()
        .from(locations)
        .where(
          and(
            eq(locations.id, body.parentId),
            eq(locations.companyId, req.companyId!),
            eq(locations.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!parentRows[0]) throw badRequest("Parent location not found in this project");
      parentPath = parentRows[0].path;
    }
    const id = newId("loc");
    const [created] = await app.db
      .insert(locations)
      .values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        parentId: body.parentId ?? null,
        name: body.name,
        path: parentPath ? `${parentPath}/${id}` : id,
        sortOrder: body.sortOrder ?? 0,
      })
      .returning();
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "location",
      objectId: id,
      payload: created,
    });
    return reply.status(201).send(created);
  });

  app.patch(
    "/projects/:projectId/locations/:locationId",
    { preHandler: tool("standard") },
    async (req) => {
      const { locationId } = req.params as { locationId: string };
      const body = locationPatchSchema.parse(req.body);
      const rows = await app.db
        .select()
        .from(locations)
        .where(
          and(
            eq(locations.id, locationId),
            eq(locations.companyId, req.companyId!),
            eq(locations.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const node = rows[0];
      if (!node) throw notFound("Location not found");

      const moving = body.parentId !== undefined && (body.parentId ?? null) !== node.parentId;

      const updated = await app.db.transaction(async (tx) => {
        if (body.name !== undefined || body.sortOrder !== undefined) {
          const patch: Record<string, unknown> = {};
          if (body.name !== undefined) patch["name"] = body.name;
          if (body.sortOrder !== undefined) patch["sortOrder"] = body.sortOrder;
          await tx.update(locations).set(patch).where(eq(locations.id, node.id));
        }
        if (moving) {
          let newParentPath: string | null = null;
          if (body.parentId) {
            const parentRows = await tx
              .select()
              .from(locations)
              .where(
                and(
                  eq(locations.id, body.parentId),
                  eq(locations.companyId, req.companyId!),
                  eq(locations.projectId, req.projectId!),
                ),
              )
              .limit(1);
            const parent = parentRows[0];
            if (!parent) throw badRequest("New parent not found in this project");
            if (parent.id === node.id || parent.path.startsWith(`${node.path}/`)) {
              throw badRequest("Cannot move a location beneath itself");
            }
            newParentPath = parent.path;
          }
          const oldPath = node.path;
          const newPath = newParentPath ? `${newParentPath}/${node.id}` : node.id;
          await tx
            .update(locations)
            .set({ parentId: body.parentId ?? null, path: newPath })
            .where(eq(locations.id, node.id));
          // recompute every descendant's materialized path
          const descendants = await tx
            .select({ id: locations.id, path: locations.path })
            .from(locations)
            .where(
              and(
                eq(locations.projectId, req.projectId!),
                like(locations.path, `${oldPath}/%`),
              ),
            );
          for (const d of descendants) {
            await tx
              .update(locations)
              .set({ path: newPath + d.path.slice(oldPath.length) })
              .where(eq(locations.id, d.id));
          }
        }
        const fresh = await tx.select().from(locations).where(eq(locations.id, node.id)).limit(1);
        return fresh[0];
      });

      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "location",
        objectId: node.id,
        payload: { ...body, moved: moving },
      });
      return updated;
    },
  );

  app.delete(
    "/projects/:projectId/locations/:locationId",
    { preHandler: tool("standard") },
    async (req) => {
      const { locationId } = req.params as { locationId: string };
      const rows = await app.db
        .select()
        .from(locations)
        .where(
          and(
            eq(locations.id, locationId),
            eq(locations.companyId, req.companyId!),
            eq(locations.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!rows[0]) throw notFound("Location not found");
      const [childRow] = await app.db
        .select({ n: count() })
        .from(locations)
        .where(and(eq(locations.parentId, locationId), eq(locations.projectId, req.projectId!)));
      if (Number(childRow?.n ?? 0) > 0) {
        throw conflict("Location has child locations — delete or move them first");
      }
      /*
       * Twenty-nine tables carry `location_id` and none of them has a foreign
       * key. Deleting a location that records still name left RFIs, punch
       * items, incidents and assets pointing at nothing, with no way back.
       * The check is bounded to the high-traffic classes; the message names
       * what is holding it.
       */
      const refs: Record<string, number> = {};
      const [rfiRow] = await app.db
        .select({ n: count() })
        .from(rfis)
        .where(and(eq(rfis.projectId, req.projectId!), eq(rfis.locationId, locationId)));
      refs["RFIs"] = Number(rfiRow?.n ?? 0);
      const [punchRow] = await app.db
        .select({ n: count() })
        .from(punchItems)
        .where(
          and(eq(punchItems.projectId, req.projectId!), eq(punchItems.locationId, locationId)),
        );
      refs["punch items"] = Number(punchRow?.n ?? 0);
      const [incidentRow] = await app.db
        .select({ n: count() })
        .from(safetyIncidents)
        .where(
          and(
            eq(safetyIncidents.projectId, req.projectId!),
            eq(safetyIncidents.locationId, locationId),
          ),
        );
      refs["safety incidents"] = Number(incidentRow?.n ?? 0);
      const [assetRow] = await app.db
        .select({ n: count() })
        .from(assets)
        .where(and(eq(assets.projectId, req.projectId!), eq(assets.locationId, locationId)));
      refs["assets"] = Number(assetRow?.n ?? 0);
      const [equipmentRow] = await app.db
        .select({ n: count() })
        .from(equipment)
        .where(and(eq(equipment.projectId, req.projectId!), eq(equipment.locationId, locationId)));
      refs["equipment"] = Number(equipmentRow?.n ?? 0);
      const held = Object.entries(refs).filter(([, n]) => n > 0);
      if (held.length > 0) {
        throw conflict(
          `${held.map(([k, n]) => `${n} ${k}`).join(", ")} still reference this location. Move them first.`,
        );
      }
      await app.db.delete(locations).where(eq(locations.id, locationId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "location",
        objectId: locationId,
        payload: rows[0],
      });
      return { ok: true };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Cost codes — company standard + project overrides (spec #56-57)   */
  /* ---------------------------------------------------------------- */

  app.get("/cost-codes", { preHandler: memberGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ search: z.string().max(100).optional() })
      .parse(req.query);
    const conds = [eq(costCodes.companyId, req.companyId!), isNull(costCodes.projectId)];
    if (q.search) {
      const term = `%${q.search}%`;
      conds.push(or(ilike(costCodes.code, term), ilike(costCodes.title, term))!);
    }
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(costCodes).where(where);
    const items = await app.db
      .select()
      .from(costCodes)
      .where(where)
      .orderBy(asc(costCodes.code))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  async function createCostCode(
    req: { companyId?: string; user?: { id: string } },
    projectId: string | null,
    body: z.infer<typeof costCodeCreateSchema>,
  ) {
    const existing = await app.db
      .select({ id: costCodes.id })
      .from(costCodes)
      .where(
        and(
          eq(costCodes.companyId, req.companyId!),
          projectId ? eq(costCodes.projectId, projectId) : isNull(costCodes.projectId),
          eq(costCodes.code, body.code),
        ),
      )
      .limit(1);
    if (existing[0]) throw conflict(`Cost code ${body.code} already exists at this level`);
    if (body.parentId) {
      // A parent must exist, in this company, at a visible level. Storing an
      // unchecked id let a hierarchy point at another tenant's code, or at
      // nothing at all.
      const parent = await app.db
        .select({ id: costCodes.id })
        .from(costCodes)
        .where(
          and(
            eq(costCodes.id, body.parentId),
            eq(costCodes.companyId, req.companyId!),
            projectId
              ? or(isNull(costCodes.projectId), eq(costCodes.projectId, projectId))!
              : isNull(costCodes.projectId),
          ),
        )
        .limit(1);
      if (!parent[0]) throw badRequest("parentId is not a cost code visible at this level");
    }
    const [created] = await app.db
      .insert(costCodes)
      .values({
        id: newId("cc"),
        companyId: req.companyId!,
        projectId,
        code: body.code,
        title: body.title,
        division: body.division ?? null,
        costType: body.costType ?? null,
        parentId: body.parentId ?? null,
      })
      .returning();
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "cost_code",
      objectId: created!.id,
      payload: created,
    });
    return created;
  }

  app.post("/cost-codes", { preHandler: adminGate }, async (req, reply) => {
    const body = costCodeCreateSchema.parse(req.body);
    return reply.status(201).send(await createCostCode(req, null, body));
  });

  app.get("/projects/:projectId/cost-codes", { preHandler: tool("read") }, async (req) => {
    const rows = await app.db
      .select()
      .from(costCodes)
      .where(
        and(
          eq(costCodes.companyId, req.companyId!),
          or(isNull(costCodes.projectId), eq(costCodes.projectId, req.projectId!)),
        ),
      )
      .orderBy(asc(costCodes.code));
    // merge: project-level entry wins over the company standard on the same code
    const merged = new Map<string, (typeof rows)[number] & { source: "standard" | "project" }>();
    for (const row of rows.filter((r) => r.projectId === null)) {
      merged.set(row.code, { ...row, source: "standard" });
    }
    for (const row of rows.filter((r) => r.projectId !== null)) {
      merged.set(row.code, { ...row, source: "project" });
    }
    const items = [...merged.values()].sort((a, b) => a.code.localeCompare(b.code));
    return { items, total: items.length };
  });

  app.post(
    "/projects/:projectId/cost-codes",
    { preHandler: tool("admin") },
    async (req, reply) => {
      const body = costCodeCreateSchema.parse(req.body);
      return reply.status(201).send(await createCostCode(req, req.projectId!, body));
    },
  );

  async function patchCostCode(
    req: { companyId?: string; user?: { id: string } },
    costCodeId: string,
    projectId: string | null,
    body: z.infer<typeof costCodePatchSchema>,
  ) {
    const patch: Record<string, unknown> = {};
    if (body.title !== undefined) patch["title"] = body.title;
    if (body.division !== undefined) patch["division"] = body.division;
    if (body.costType !== undefined) patch["costType"] = body.costType;
    if (body.isActive !== undefined) patch["isActive"] = body.isActive ? 1 : 0;
    if (Object.keys(patch).length === 0) throw badRequest("Nothing to update");
    const [updated] = await app.db
      .update(costCodes)
      .set(patch)
      .where(
        and(
          eq(costCodes.id, costCodeId),
          eq(costCodes.companyId, req.companyId!),
          projectId ? eq(costCodes.projectId, projectId) : isNull(costCodes.projectId),
        ),
      )
      .returning();
    if (!updated) throw notFound("Cost code not found");
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "cost_code",
      objectId: costCodeId,
      payload: patch,
    });
    return updated;
  }

  /** How many records still point at this cost code, by class. */
  async function costCodeReferences(companyId: string, costCodeId: string) {
    const counts: Record<string, number> = {};
    const [budget] = await app.db
      .select({ n: count() })
      .from(budgetLineItems)
      .where(
        and(
          eq(budgetLineItems.companyId, companyId),
          eq(budgetLineItems.costCodeId, costCodeId),
        ),
      );
    counts["budget lines"] = Number(budget?.n ?? 0);
    const [sov] = await app.db
      .select({ n: count() })
      .from(commitmentSovLines)
      .where(
        and(
          eq(commitmentSovLines.companyId, companyId),
          eq(commitmentSovLines.costCodeId, costCodeId),
        ),
      );
    counts["commitment lines"] = Number(sov?.n ?? 0);
    const [inv] = await app.db
      .select({ n: count() })
      .from(invoiceLineItems)
      .where(
        and(
          eq(invoiceLineItems.companyId, companyId),
          eq(invoiceLineItems.costCodeId, costCodeId),
        ),
      );
    counts["invoice lines"] = Number(inv?.n ?? 0);
    const [children] = await app.db
      .select({ n: count() })
      .from(costCodes)
      .where(and(eq(costCodes.companyId, companyId), eq(costCodes.parentId, costCodeId)));
    counts["child cost codes"] = Number(children?.n ?? 0);
    return counts;
  }

  async function deleteCostCode(
    req: { companyId?: string; user?: { id: string } },
    costCodeId: string,
    projectId: string | null,
  ) {
    /*
     * Refuse rather than orphan. Fifteen tables carry `cost_code_id` and none
     * of them has a foreign key, so deleting a code that a budget line, an
     * SOV line or an invoice line still names left every cost report grouping
     * under a code that no longer exists. Deactivating (`isActive: false`)
     * hides it from pickers without breaking the history.
     */
    const references = await costCodeReferences(req.companyId!, costCodeId);
    const held = Object.entries(references).filter(([, n]) => n > 0);
    if (held.length > 0) {
      throw conflict(
        `This cost code is still used by ${held.map(([k, n]) => `${n} ${k}`).join(", ")}. Deactivate it instead (PATCH isActive: false) so existing records keep their code.`,
      );
    }
    const deleted = await app.db
      .delete(costCodes)
      .where(
        and(
          eq(costCodes.id, costCodeId),
          eq(costCodes.companyId, req.companyId!),
          projectId ? eq(costCodes.projectId, projectId) : isNull(costCodes.projectId),
        ),
      )
      .returning({ id: costCodes.id });
    if (!deleted[0]) throw notFound("Cost code not found");
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "cost_code",
      objectId: costCodeId,
    });
    return { ok: true };
  }

  app.patch("/cost-codes/:costCodeId", { preHandler: adminGate }, async (req) => {
    const { costCodeId } = req.params as { costCodeId: string };
    return patchCostCode(req, costCodeId, null, costCodePatchSchema.parse(req.body));
  });

  app.delete("/cost-codes/:costCodeId", { preHandler: adminGate }, async (req) => {
    const { costCodeId } = req.params as { costCodeId: string };
    return deleteCostCode(req, costCodeId, null);
  });

  app.patch(
    "/projects/:projectId/cost-codes/:costCodeId",
    { preHandler: tool("admin") },
    async (req) => {
      const { costCodeId } = req.params as { costCodeId: string };
      return patchCostCode(req, costCodeId, req.projectId!, costCodePatchSchema.parse(req.body));
    },
  );

  app.delete(
    "/projects/:projectId/cost-codes/:costCodeId",
    { preHandler: tool("admin") },
    async (req) => {
      const { costCodeId } = req.params as { costCodeId: string };
      return deleteCostCode(req, costCodeId, req.projectId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* WBS segments (spec #58-59)                                        */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/wbs", { preHandler: tool("read") }, async (req) => {
    const items = await app.db
      .select()
      .from(wbsSegments)
      .where(
        and(eq(wbsSegments.companyId, req.companyId!), eq(wbsSegments.projectId, req.projectId!)),
      )
      .orderBy(asc(wbsSegments.position));
    return { items, total: items.length };
  });

  app.post("/projects/:projectId/wbs", { preHandler: tool("standard") }, async (req, reply) => {
    const body = wbsCreateSchema.parse(req.body);
    const [created] = await app.db
      .insert(wbsSegments)
      .values({
        id: newId("wbs"),
        companyId: req.companyId!,
        projectId: req.projectId!,
        name: body.name,
        segmentType: body.segmentType,
        position: body.position,
      })
      .returning();
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "wbs_segment",
      objectId: created!.id,
      payload: created,
    });
    return reply.status(201).send(created);
  });

  app.patch(
    "/projects/:projectId/wbs/:segmentId",
    { preHandler: tool("standard") },
    async (req) => {
      const { segmentId } = req.params as { segmentId: string };
      const body = wbsPatchSchema.parse(req.body);
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch["name"] = body.name;
      if (body.segmentType !== undefined) patch["segmentType"] = body.segmentType;
      if (body.position !== undefined) patch["position"] = body.position;
      if (Object.keys(patch).length === 0) throw badRequest("Nothing to update");
      const [updated] = await app.db
        .update(wbsSegments)
        .set(patch)
        .where(
          and(
            eq(wbsSegments.id, segmentId),
            eq(wbsSegments.companyId, req.companyId!),
            eq(wbsSegments.projectId, req.projectId!),
          ),
        )
        .returning();
      if (!updated) throw notFound("WBS segment not found");
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "wbs_segment",
        objectId: segmentId,
        payload: patch,
      });
      return updated;
    },
  );

  app.delete(
    "/projects/:projectId/wbs/:segmentId",
    { preHandler: tool("standard") },
    async (req) => {
      const { segmentId } = req.params as { segmentId: string };
      const deleted = await app.db
        .delete(wbsSegments)
        .where(
          and(
            eq(wbsSegments.id, segmentId),
            eq(wbsSegments.companyId, req.companyId!),
            eq(wbsSegments.projectId, req.projectId!),
          ),
        )
        .returning({ id: wbsSegments.id });
      if (!deleted[0]) throw notFound("WBS segment not found");
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "wbs_segment",
        objectId: segmentId,
      });
      return { ok: true };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Cross-tool record links (spec #73)                                */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/links", { preHandler: tool("standard") }, async (req, reply) => {
    const body = linkCreateSchema.parse(req.body);
    const [created] = await app.db
      .insert(recordLinks)
      .values({
        id: newId("lnk"),
        companyId: req.companyId!,
        projectId: req.projectId!,
        fromType: body.fromType,
        fromId: body.fromId,
        toType: body.toType,
        toId: body.toId,
        linkKind: body.linkKind ?? "reference",
        createdBy: req.user!.id,
      })
      .returning();
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "record_link",
      objectId: created!.id,
      payload: created,
    });
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/links", { preHandler: tool("read") }, async (req) => {
    const q = z
      .object({
        recordType: z.string().optional(),
        recordId: z.string().optional(),
      })
      .parse(req.query);
    const scope = and(
      eq(recordLinks.companyId, req.companyId!),
      eq(recordLinks.projectId, req.projectId!),
    );
    let where = scope;
    if (q.recordType && q.recordId) {
      // both directions: links pointing at the record and links from it
      where = and(
        scope,
        or(
          and(eq(recordLinks.fromType, q.recordType), eq(recordLinks.fromId, q.recordId)),
          and(eq(recordLinks.toType, q.recordType), eq(recordLinks.toId, q.recordId)),
        ),
      );
    }
    const items = await app.db
      .select()
      .from(recordLinks)
      .where(where)
      .orderBy(desc(recordLinks.createdAt));
    return { items, total: items.length };
  });

  /**
   * Deleting a link needs the same authority as creating one.
   *
   * This route was gated on company membership alone while `POST
   * /projects/:id/links` required `projects:standard` on the project — so a
   * guest could delete any link in the tenant and silently break the
   * RFI ↔ drawing ↔ submittal traceability the spec treats as evidentiary.
   * The link is loaded first so its project can be resolved and checked.
   */
  app.delete("/links/:linkId", { preHandler: memberGate }, async (req) => {
    const { linkId } = req.params as { linkId: string };
    const rows = await app.db
      .select()
      .from(recordLinks)
      .where(and(eq(recordLinks.id, linkId), eq(recordLinks.companyId, req.companyId!)))
      .limit(1);
    const link = rows[0];
    if (!link) throw notFound("Link not found");
    const access = await loadProjectAccess(app, req);
    if (!canUseTool(access, link.projectId, "projects", "standard")) {
      throw forbidden("Requires standard access to projects on this project");
    }
    await app.db.delete(recordLinks).where(eq(recordLinks.id, linkId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "record_link",
      objectId: linkId,
      payload: { fromType: link.fromType, fromId: link.fromId, toType: link.toType, toId: link.toId },
      projectId: link.projectId,
    });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* Comments + @mentions (spec #68-69)                                */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/records/:recordType/:recordId/comments",
    { preHandler: tool("standard") },
    async (req, reply) => {
      const { recordType, recordId } = req.params as RecordParams;
      const body = commentCreateSchema.parse(req.body);
      const id = newId("cmt");
      const mentionIds = [...new Set(body.mentions ?? [])].filter((m) => m !== req.user!.id);

      /*
       * A mention may only reach someone who can OPEN the record.
       *
       * Validating against company membership alone (the previous rule) sent
       * the first 280 characters of the comment to people with no rights on
       * the project — the notification body was the leak, and the recipient
       * could not even follow the link to see the context.
       */
      let validMentions: string[] = [];
      const refusedMentions: string[] = [];
      if (mentionIds.length > 0) {
        const members = await app.db
          .select({ userId: companyMemberships.userId, role: companyMemberships.role })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, req.companyId!),
              inArray(companyMemberships.userId, mentionIds),
            ),
          );
        const onProject = await app.db
          .select({ userId: projectMemberships.userId })
          .from(projectMemberships)
          .where(
            and(
              eq(projectMemberships.companyId, req.companyId!),
              eq(projectMemberships.projectId, req.projectId!),
              inArray(
                projectMemberships.userId,
                members.map((m) => m.userId),
              ),
            ),
          );
        const projectMemberIds = new Set(onProject.map((m) => m.userId));
        for (const member of members) {
          if (member.role === "owner" || member.role === "admin" || projectMemberIds.has(member.userId)) {
            validMentions.push(member.userId);
          } else {
            refusedMentions.push(member.userId);
          }
        }
      }

      const [created] = await app.db
        .insert(comments)
        .values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          recordType,
          recordId,
          authorId: req.user!.id,
          body: body.body,
          mentions: validMentions,
        })
        .returning();

      await pushNotifications(
        app.db,
        validMentions.map((userId) => ({
          companyId: req.companyId!,
          userId,
          projectId: req.projectId!,
          kind: "mention" as const,
          title: `${req.user!.name} mentioned you in a comment`,
          body: body.body.slice(0, 280),
          recordType,
          recordId,
          tool: "projects",
        })),
      );

      // #70 — the record's watchers hear about the comment too, minus anyone
      // already mentioned and minus the author.
      const mentioned = new Set([...validMentions, req.user!.id]);
      const watcherRows = await app.db
        .select({ userId: watchers.userId })
        .from(watchers)
        .where(
          and(
            eq(watchers.companyId, req.companyId!),
            eq(watchers.recordType, recordType),
            eq(watchers.recordId, recordId),
          ),
        );
      await pushNotifications(
        app.db,
        watcherRows
          .filter((w) => !mentioned.has(w.userId))
          .map((w) => ({
            companyId: req.companyId!,
            userId: w.userId,
            projectId: req.projectId!,
            kind: "status_change" as const,
            title: `New comment on ${recordType.replace(/_/g, " ")}`,
            body: body.body.slice(0, 280),
            recordType,
            recordId,
            tool: "projects",
          })),
      );

      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "comment",
        objectId: id,
        payload: created,
        projectId: req.projectId!,
      });
      return reply.status(201).send({
        ...created,
        // Honesty: say who was named but not notified, rather than letting the
        // author believe the mention landed.
        notNotified: refusedMentions,
      });
    },
  );

  app.get(
    "/projects/:projectId/records/:recordType/:recordId/comments",
    { preHandler: tool("read") },
    async (req) => {
      const { recordType, recordId } = req.params as RecordParams;
      const items = await app.db
        .select({
          id: comments.id,
          recordType: comments.recordType,
          recordId: comments.recordId,
          authorId: comments.authorId,
          authorName: users.name,
          body: comments.body,
          mentions: comments.mentions,
          createdAt: comments.createdAt,
        })
        .from(comments)
        .leftJoin(users, eq(users.id, comments.authorId))
        .where(
          and(
            eq(comments.companyId, req.companyId!),
            eq(comments.projectId, req.projectId!),
            eq(comments.recordType, recordType),
            eq(comments.recordId, recordId),
          ),
        )
        .orderBy(asc(comments.createdAt));
      return { items, total: items.length };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Watchers (spec #70)                                               */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/records/:recordType/:recordId/watchers",
    { preHandler: tool("read") },
    async (req) => {
      const { recordType, recordId } = req.params as RecordParams;
      const items = await app.db
        .select({
          id: watchers.id,
          userId: watchers.userId,
          userName: users.name,
          createdAt: watchers.createdAt,
        })
        .from(watchers)
        .leftJoin(users, eq(users.id, watchers.userId))
        .where(
          and(
            // `watchers` is addressed by (recordType, recordId) and record ids
            // are not unique across tenants: without these two predicates a
            // caller with read on ANY project could ask for a record id from
            // another company and receive its watchers' names.
            eq(watchers.companyId, req.companyId!),
            eq(watchers.projectId, req.projectId!),
            eq(watchers.recordType, recordType),
            eq(watchers.recordId, recordId),
          ),
        )
        .orderBy(asc(watchers.createdAt));
      return {
        items,
        total: items.length,
        watching: items.some((w) => w.userId === req.user!.id),
      };
    },
  );

  app.post(
    "/projects/:projectId/records/:recordType/:recordId/watchers",
    { preHandler: tool("read") },
    async (req, reply) => {
      const { recordType, recordId } = req.params as RecordParams;
      await assertRecordInProject(req.companyId!, req.projectId!, recordType, recordId);
      const existing = await app.db
        .select({ id: watchers.id })
        .from(watchers)
        .where(
          and(
            eq(watchers.recordType, recordType),
            eq(watchers.recordId, recordId),
            eq(watchers.userId, req.user!.id),
          ),
        )
        .limit(1);
      if (existing[0]) return { watching: true };
      const id = newId("wch");
      await app.db.insert(watchers).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        recordType,
        recordId,
        userId: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "watcher",
        objectId: id,
        payload: { recordType, recordId },
      });
      return reply.status(201).send({ watching: true });
    },
  );

  app.delete(
    "/projects/:projectId/records/:recordType/:recordId/watchers",
    { preHandler: tool("read") },
    async (req) => {
      const { recordType, recordId } = req.params as RecordParams;
      const deleted = await app.db
        .delete(watchers)
        .where(
          and(
            eq(watchers.companyId, req.companyId!),
            eq(watchers.recordType, recordType),
            eq(watchers.recordId, recordId),
            eq(watchers.userId, req.user!.id),
          ),
        )
        .returning({ id: watchers.id });
      if (deleted[0]) {
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "delete",
          objectType: "watcher",
          objectId: deleted[0].id,
          payload: { recordType, recordId },
        });
      }
      return { watching: false };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Tags (spec #66)                                                   */
  /* ---------------------------------------------------------------- */

  app.get("/tags", { preHandler: memberGate }, async (req) => {
    const items = await app.db
      .select()
      .from(tags)
      .where(eq(tags.companyId, req.companyId!))
      .orderBy(asc(tags.name));
    return { items, total: items.length };
  });

  app.get(
    "/projects/:projectId/records/:recordType/:recordId/tags",
    { preHandler: tool("read") },
    async (req) => {
      const { recordType, recordId } = req.params as RecordParams;
      const items = await app.db
        .select({
          id: tags.id,
          name: tags.name,
          color: tags.color,
          assignmentId: tagAssignments.id,
        })
        .from(tagAssignments)
        .innerJoin(tags, eq(tags.id, tagAssignments.tagId))
        .where(
          and(
            eq(tagAssignments.recordType, recordType),
            eq(tagAssignments.recordId, recordId),
            eq(tags.companyId, req.companyId!),
          ),
        )
        .orderBy(asc(tags.name));
      return { items, total: items.length };
    },
  );

  app.post(
    "/projects/:projectId/records/:recordType/:recordId/tags",
    { preHandler: tool("standard") },
    async (req, reply) => {
      const { recordType, recordId } = req.params as RecordParams;
      const body = tagAssignSchema.parse(req.body);

      let tagId = body.tagId ?? null;
      if (tagId) {
        const rows = await app.db
          .select({ id: tags.id })
          .from(tags)
          .where(and(eq(tags.id, tagId), eq(tags.companyId, req.companyId!)))
          .limit(1);
        if (!rows[0]) throw badRequest("Unknown tag");
      } else {
        // create-on-the-fly by name (idempotent per company)
        const existing = await app.db
          .select({ id: tags.id })
          .from(tags)
          .where(and(eq(tags.companyId, req.companyId!), eq(tags.name, body.name!)))
          .limit(1);
        if (existing[0]) {
          tagId = existing[0].id;
        } else {
          tagId = newId("tag");
          await app.db.insert(tags).values({
            id: tagId,
            companyId: req.companyId!,
            name: body.name!,
            color: body.color ?? null,
          });
        }
      }

      const assigned = await app.db
        .select({ id: tagAssignments.id })
        .from(tagAssignments)
        .where(
          and(
            eq(tagAssignments.tagId, tagId),
            eq(tagAssignments.recordType, recordType),
            eq(tagAssignments.recordId, recordId),
          ),
        )
        .limit(1);
      if (assigned[0]) return { tagId, assignmentId: assigned[0].id };

      const assignmentId = newId("tga");
      await app.db.insert(tagAssignments).values({
        id: assignmentId,
        tagId,
        recordType,
        recordId,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "tag_assignment",
        objectId: assignmentId,
        payload: { tagId, recordType, recordId },
      });
      return reply.status(201).send({ tagId, assignmentId });
    },
  );

  app.delete(
    "/projects/:projectId/records/:recordType/:recordId/tags/:tagId",
    { preHandler: tool("standard") },
    async (req) => {
      const { recordType, recordId, tagId } = req.params as RecordParams & { tagId: string };
      const rows = await app.db
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.id, tagId), eq(tags.companyId, req.companyId!)))
        .limit(1);
      if (!rows[0]) throw notFound("Tag not found");
      const deleted = await app.db
        .delete(tagAssignments)
        .where(
          and(
            eq(tagAssignments.tagId, tagId),
            eq(tagAssignments.recordType, recordType),
            eq(tagAssignments.recordId, recordId),
          ),
        )
        .returning({ id: tagAssignments.id });
      if (deleted[0]) {
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "delete",
          objectType: "tag_assignment",
          objectId: deleted[0].id,
          payload: { tagId, recordType, recordId },
        });
      }
      return { ok: true };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Custom fields (spec #62-64)                                       */
  /* ---------------------------------------------------------------- */

  app.get("/custom-field-defs", { preHandler: memberGate }, async (req) => {
    const q = z
      .object({
        tool: z.enum(TOOLS).optional(),
        projectId: z.string().optional(),
      })
      .parse(req.query);
    const conds = [eq(customFieldDefs.companyId, req.companyId!)];
    if (q.tool) conds.push(eq(customFieldDefs.tool, q.tool));
    if (q.projectId) {
      conds.push(
        or(isNull(customFieldDefs.projectId), eq(customFieldDefs.projectId, q.projectId))!,
      );
    }
    const items = await app.db
      .select()
      .from(customFieldDefs)
      .where(and(...conds))
      .orderBy(asc(customFieldDefs.tool), asc(customFieldDefs.sortOrder));
    return { items, total: items.length };
  });

  app.post("/custom-field-defs", { preHandler: adminGate }, async (req, reply) => {
    const body = fieldDefCreateSchema.parse(req.body);
    if (body.projectId) {
      const prj = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, body.projectId), eq(projects.companyId, req.companyId!)))
        .limit(1);
      if (!prj[0]) throw badRequest("Unknown project");
    }
    const existing = await app.db
      .select({ id: customFieldDefs.id })
      .from(customFieldDefs)
      .where(
        and(
          eq(customFieldDefs.companyId, req.companyId!),
          body.projectId
            ? eq(customFieldDefs.projectId, body.projectId)
            : isNull(customFieldDefs.projectId),
          eq(customFieldDefs.tool, body.tool),
          eq(customFieldDefs.key, body.key),
        ),
      )
      .limit(1);
    if (existing[0]) throw conflict(`Field "${body.key}" already exists for ${body.tool}`);
    const [created] = await app.db
      .insert(customFieldDefs)
      .values({
        id: newId("cfd"),
        companyId: req.companyId!,
        projectId: body.projectId ?? null,
        tool: body.tool,
        key: body.key,
        label: body.label,
        fieldType: body.fieldType,
        options: body.options ?? [],
        required: body.required ? 1 : 0,
        sortOrder: body.sortOrder ?? 0,
      })
      .returning();
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "custom_field_def",
      objectId: created!.id,
      payload: created,
    });
    return reply.status(201).send(created);
  });

  app.patch("/custom-field-defs/:defId", { preHandler: adminGate }, async (req) => {
    const { defId } = req.params as { defId: string };
    const body = fieldDefPatchSchema.parse(req.body);
    const patch: Record<string, unknown> = {};
    if (body.label !== undefined) patch["label"] = body.label;
    if (body.options !== undefined) patch["options"] = body.options;
    if (body.required !== undefined) patch["required"] = body.required ? 1 : 0;
    if (body.sortOrder !== undefined) patch["sortOrder"] = body.sortOrder;
    if (Object.keys(patch).length === 0) throw badRequest("Nothing to update");
    const [updated] = await app.db
      .update(customFieldDefs)
      .set(patch)
      .where(and(eq(customFieldDefs.id, defId), eq(customFieldDefs.companyId, req.companyId!)))
      .returning();
    if (!updated) throw notFound("Field definition not found");
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "custom_field_def",
      objectId: defId,
      payload: patch,
    });
    return updated;
  });

  app.delete("/custom-field-defs/:defId", { preHandler: adminGate }, async (req) => {
    const { defId } = req.params as { defId: string };
    const deleted = await app.db.transaction(async (tx) => {
      const rows = await tx
        .delete(customFieldDefs)
        .where(and(eq(customFieldDefs.id, defId), eq(customFieldDefs.companyId, req.companyId!)))
        .returning({ id: customFieldDefs.id });
      if (rows[0]) {
        await tx.delete(customFieldValues).where(eq(customFieldValues.fieldDefId, defId));
      }
      return rows;
    });
    if (!deleted[0]) throw notFound("Field definition not found");
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "custom_field_def",
      objectId: defId,
    });
    return { ok: true };
  });

  app.put(
    "/projects/:projectId/records/:recordType/:recordId/custom-values",
    { preHandler: tool("standard") },
    async (req) => {
      const { recordType, recordId } = req.params as RecordParams;
      const body = customValuesSchema.parse(req.body);
      const defIds = Object.keys(body.values);
      if (defIds.length === 0) throw badRequest("values is empty");

      const defs = await app.db
        .select()
        .from(customFieldDefs)
        .where(
          and(
            eq(customFieldDefs.companyId, req.companyId!),
            inArray(customFieldDefs.id, defIds),
            or(
              isNull(customFieldDefs.projectId),
              eq(customFieldDefs.projectId, req.projectId!),
            ),
          ),
        );
      const known = new Set(defs.map((d) => d.id));
      const unknown = defIds.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw badRequest(`Unknown field definition(s): ${unknown.join(", ")}`);
      }

      /*
       * A definition belongs to a tool, and the tool must match the record it
       * is being written onto — otherwise the `tool` on the definition is
       * decoration and a "budget" field can be stored against a punch item.
       * Tool keys are plural ("rfis", "daily_logs") while record types are
       * singular ("rfi", "daily_log"), so both spellings are accepted.
       */
      const toolMatches = (toolKey: string) =>
        toolKey === recordType || toolKey === `${recordType}s` || `${toolKey}s` === recordType;
      const wrongTool = defs.filter((d) => !toolMatches(d.tool));
      if (wrongTool.length > 0) {
        throw badRequest(
          `Field(s) ${wrongTool.map((d) => d.key).join(", ")} belong to the ${wrongTool
            .map((d) => d.tool)
            .join("/")} tool, not to "${recordType}"`,
        );
      }

      await assertRecordInProject(req.companyId!, req.projectId!, recordType, recordId);

      /*
       * Vol I #63 — values are typed. `PUT` used to write whatever JSON it
       * received: a dropdown accepted a value outside its options, a number
       * field accepted a string, and `required` meant nothing, so every
       * report built on custom fields had to defend itself against data the
       * platform had promised was typed.
       */
      const report = validateFieldValues(defs as FieldDefLike[], body.values);
      if (report.errors.length > 0) {
        throw badRequest("One or more custom field values are invalid", {
          errors: report.errors,
        });
      }

      const storedRows = await app.db
        .select({ fieldDefId: customFieldValues.fieldDefId })
        .from(customFieldValues)
        .where(
          and(
            eq(customFieldValues.companyId, req.companyId!),
            eq(customFieldValues.recordType, recordType),
            eq(customFieldValues.recordId, recordId),
          ),
        );
      const stored = new Set(storedRows.map((r) => r.fieldDefId));
      const missing = missingRequired(defs as FieldDefLike[], body.values, stored).filter((d) =>
        defIds.includes(d.id),
      );
      if (missing.length > 0) {
        throw badRequest(
          `Required field(s) cannot be cleared: ${missing.map((d) => d.label).join(", ")}`,
        );
      }

      await app.db.transaction(async (tx) => {
        for (const defId of defIds) {
          const value = report.values[defId] ?? null;
          const existing = await tx
            .select({ id: customFieldValues.id })
            .from(customFieldValues)
            .where(
              and(
                eq(customFieldValues.fieldDefId, defId),
                eq(customFieldValues.recordType, recordType),
                eq(customFieldValues.recordId, recordId),
              ),
            )
            .limit(1);
          if (existing[0]) {
            await tx
              .update(customFieldValues)
              .set({
                value,
                companyId: req.companyId!,
                projectId: req.projectId!,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(customFieldValues.id, existing[0].id));
          } else {
            await tx.insert(customFieldValues).values({
              id: newId("cfv"),
              companyId: req.companyId!,
              projectId: req.projectId!,
              fieldDefId: defId,
              recordType,
              recordId,
              value,
            });
          }
        }
      });

      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "custom_field_values",
        objectId: `${recordType}:${recordId}`,
        payload: report.values,
        projectId: req.projectId!,
      });
      return { ok: true, updated: defIds.length };
    },
  );

  app.get(
    "/projects/:projectId/records/:recordType/:recordId/custom-values",
    { preHandler: tool("read") },
    async (req) => {
      const { recordType, recordId } = req.params as RecordParams;
      const items = await app.db
        .select({
          fieldDefId: customFieldValues.fieldDefId,
          key: customFieldDefs.key,
          label: customFieldDefs.label,
          fieldType: customFieldDefs.fieldType,
          tool: customFieldDefs.tool,
          value: customFieldValues.value,
          updatedAt: customFieldValues.updatedAt,
        })
        .from(customFieldValues)
        .innerJoin(customFieldDefs, eq(customFieldDefs.id, customFieldValues.fieldDefId))
        .where(
          and(
            eq(customFieldValues.companyId, req.companyId!),
            eq(customFieldValues.recordType, recordType),
            eq(customFieldValues.recordId, recordId),
            eq(customFieldDefs.companyId, req.companyId!),
            or(
              isNull(customFieldDefs.projectId),
              eq(customFieldDefs.projectId, req.projectId!),
            ),
          ),
        )
        .orderBy(asc(customFieldDefs.sortOrder));
      return { items, total: items.length };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Saved views / filter sets (#75, #148)                             */
  /* ---------------------------------------------------------------- */

  /**
   * A saved view is a register's filter, sort and column state under a name.
   *
   * Server-side rather than in the browser, for two reasons the spec cares
   * about: a filter that only exists on one laptop is not a shared way of
   * working, and a `company`-scoped view is how a team agrees what "open
   * commercial risk" means.
   */
  app.get("/saved-views", { preHandler: memberGate }, async (req) => {
    const q = z
      .object({ tableId: z.string().max(80).optional(), projectId: z.string().max(100).optional() })
      .parse(req.query);
    const conds = [
      eq(savedViews.companyId, req.companyId!),
      // Mine, plus everything shared with the company.
      or(eq(savedViews.ownerId, req.user!.id), eq(savedViews.scope, "company"))!,
    ];
    if (q.tableId) conds.push(eq(savedViews.tableId, q.tableId));
    if (q.projectId) {
      conds.push(or(isNull(savedViews.projectId), eq(savedViews.projectId, q.projectId))!);
    }
    const items = await app.db
      .select()
      .from(savedViews)
      .where(and(...conds))
      .orderBy(desc(savedViews.isDefault), asc(savedViews.name));
    return {
      items: items.map((v) => ({ ...v, mine: v.ownerId === req.user!.id })),
      total: items.length,
    };
  });

  app.post("/saved-views", { preHandler: memberGate }, async (req, reply) => {
    const body = savedViewSchema.parse(req.body);
    if (body.projectId) {
      const access = await loadProjectAccess(app, req);
      if (!canUseTool(access, body.projectId, "projects", "read")) {
        throw forbidden("Requires read access to that project");
      }
    }
    const id = newId("sv");
    if (body.isDefault) {
      await app.db
        .update(savedViews)
        .set({ isDefault: 0 })
        .where(
          and(
            eq(savedViews.companyId, req.companyId!),
            eq(savedViews.ownerId, req.user!.id),
            eq(savedViews.tableId, body.tableId),
          ),
        );
    }
    const existing = await app.db
      .select({ id: savedViews.id })
      .from(savedViews)
      .where(
        and(
          eq(savedViews.companyId, req.companyId!),
          eq(savedViews.tableId, body.tableId),
          eq(savedViews.ownerId, req.user!.id),
          eq(savedViews.name, body.name),
        ),
      )
      .limit(1);
    if (existing[0]) throw conflict("You already have a view with that name on this table");
    await app.db.insert(savedViews).values({
      id,
      companyId: req.companyId!,
      projectId: body.projectId ?? null,
      tableId: body.tableId,
      name: body.name,
      scope: body.scope,
      ownerId: req.user!.id,
      isDefault: body.isDefault ? 1 : 0,
      state: body.state,
    });
    const [created] = await app.db.select().from(savedViews).where(eq(savedViews.id, id));
    return reply.status(201).send(created);
  });

  app.patch("/saved-views/:viewId", { preHandler: memberGate }, async (req) => {
    const { viewId } = req.params as { viewId: string };
    const body = savedViewPatchSchema.parse(req.body);
    const rows = await app.db
      .select()
      .from(savedViews)
      .where(and(eq(savedViews.id, viewId), eq(savedViews.companyId, req.companyId!)))
      .limit(1);
    const view = rows[0];
    if (!view) throw notFound("Saved view not found");
    // A shared view is still owned by the person who made it; an admin may
    // also curate the company's shared views.
    const isAdmin = req.companyRole === "owner" || req.companyRole === "admin";
    if (view.ownerId !== req.user!.id && !(isAdmin && view.scope === "company")) {
      throw forbidden("Only the view's owner may change it");
    }
    if (body.isDefault) {
      await app.db
        .update(savedViews)
        .set({ isDefault: 0 })
        .where(
          and(
            eq(savedViews.companyId, req.companyId!),
            eq(savedViews.ownerId, view.ownerId),
            eq(savedViews.tableId, view.tableId),
          ),
        );
    }
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.name !== undefined) patch["name"] = body.name;
    if (body.scope !== undefined) patch["scope"] = body.scope;
    if (body.state !== undefined) patch["state"] = body.state;
    if (body.isDefault !== undefined) patch["isDefault"] = body.isDefault ? 1 : 0;
    const [updated] = await app.db
      .update(savedViews)
      .set(patch)
      .where(eq(savedViews.id, viewId))
      .returning();
    return updated;
  });

  app.delete("/saved-views/:viewId", { preHandler: memberGate }, async (req) => {
    const { viewId } = req.params as { viewId: string };
    const rows = await app.db
      .select()
      .from(savedViews)
      .where(and(eq(savedViews.id, viewId), eq(savedViews.companyId, req.companyId!)))
      .limit(1);
    const view = rows[0];
    if (!view) throw notFound("Saved view not found");
    const isAdmin = req.companyRole === "owner" || req.companyRole === "admin";
    if (view.ownerId !== req.user!.id && !(isAdmin && view.scope === "company")) {
      throw forbidden("Only the view's owner may delete it");
    }
    await app.db.delete(savedViews).where(eq(savedViews.id, viewId));
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* CSV import (#77)                                                  */
  /* ---------------------------------------------------------------- */

  /** The blank template for a dataset, as a downloadable CSV. */
  app.get("/imports/:dataset/template", { preHandler: memberGate }, async (req, reply) => {
    const { dataset } = req.params as { dataset: string };
    const spec = IMPORT_SPECS[dataset];
    if (!spec) throw notFound(`No import template for "${dataset}"`);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${dataset}-template.csv"`)
      .send(templateCsv(spec));
  });

  app.get("/imports", { preHandler: adminGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ dataset: z.string().max(40).optional() })
      .parse(req.query);
    const conds = [eq(importJobs.companyId, req.companyId!)];
    if (q.dataset) conds.push(eq(importJobs.dataset, q.dataset));
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(importJobs).where(where);
    const items = await app.db
      .select({
        id: importJobs.id,
        dataset: importJobs.dataset,
        status: importJobs.status,
        projectId: importJobs.projectId,
        fileName: importJobs.fileName,
        rowCount: importJobs.rowCount,
        validCount: importJobs.validCount,
        errorCount: importJobs.errorCount,
        createdCount: importJobs.createdCount,
        updatedCount: importJobs.updatedCount,
        createdBy: importJobs.createdBy,
        createdAt: importJobs.createdAt,
        committedAt: importJobs.committedAt,
      })
      .from(importJobs)
      .where(where)
      .orderBy(desc(importJobs.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/imports/:jobId", { preHandler: adminGate }, async (req) => {
    const { jobId } = req.params as { jobId: string };
    const rows = await app.db
      .select()
      .from(importJobs)
      .where(and(eq(importJobs.id, jobId), eq(importJobs.companyId, req.companyId!)))
      .limit(1);
    if (!rows[0]) throw notFound("Import job not found");
    return rows[0];
  });

  /**
   * Step one of an import: parse and validate, write NOTHING.
   *
   * The parsed rows and the findings are stored on the job, so the commit
   * replays exactly the file that was reviewed rather than trusting the
   * client to send the same content twice.
   */
  app.post("/imports/:dataset/preview", { preHandler: adminGate }, async (req, reply) => {
    const { dataset } = req.params as { dataset: string };
    const spec = IMPORT_SPECS[dataset];
    if (!spec) throw badRequest(`Unknown import dataset "${dataset}"`);
    const body = z
      .object({
        csv: z.string().min(1).max(8 * 1024 * 1024),
        fileName: z.string().max(300).optional(),
        projectId: z.string().max(100).optional(),
      })
      .parse(req.body);
    if (spec.projectScoped) {
      if (!body.projectId) throw badRequest(`${spec.label} import needs a projectId`);
      const access = await loadProjectAccess(app, req);
      if (!canUseTool(access, body.projectId, "projects", "admin")) {
        throw forbidden("Requires admin access to projects on that project");
      }
      await liveProject(req.companyId!, body.projectId);
    }
    const preview = validateRows(spec, toRecords(parseCsv(body.csv)));
    const id = newId("imp");
    await app.db.insert(importJobs).values({
      id,
      companyId: req.companyId!,
      projectId: body.projectId ?? null,
      dataset,
      status: "preview",
      fileName: body.fileName ?? null,
      rowCount: preview.rowCount,
      validCount: preview.validCount,
      errorCount: preview.errorCount,
      report: preview.errors,
      rows: preview.rows,
      createdBy: req.user!.id,
    });
    return reply.status(201).send({ id, ...preview, status: "preview" });
  });

  /** Step two: write the rows that passed validation. */
  app.post("/imports/:jobId/commit", { preHandler: adminGate }, async (req) => {
    const { jobId } = req.params as { jobId: string };
    const rows = await app.db
      .select()
      .from(importJobs)
      .where(and(eq(importJobs.id, jobId), eq(importJobs.companyId, req.companyId!)))
      .limit(1);
    const job = rows[0];
    if (!job) throw notFound("Import job not found");
    if (job.status !== "preview") throw conflict(`Import job is already ${job.status}`);
    const spec = IMPORT_SPECS[job.dataset];
    if (!spec) throw badRequest(`Unknown import dataset "${job.dataset}"`);
    if (job.dataset !== "cost_codes" && job.dataset !== "locations") {
      throw badRequest(
        `${spec.label} are imported through the directory module (POST /directory/imports/:jobId/commit)`,
      );
    }

    const preview = {
      dataset: job.dataset,
      columns: spec.columns,
      rows: (job.rows ?? []) as Array<Record<string, string>>,
      errors: (job.report ?? []) as ImportRowError[],
      rowCount: job.rowCount,
      validCount: job.validCount,
      errorCount: job.errorCount,
    };
    const writable = committableRows(preview);

    let created = 0;
    let updated = 0;
    if (job.dataset === "cost_codes") {
      const existing = await app.db
        .select({ id: costCodes.id, code: costCodes.code })
        .from(costCodes)
        .where(and(eq(costCodes.companyId, req.companyId!), isNull(costCodes.projectId)));
      const byCode = new Map(existing.map((c) => [c.code.toLowerCase(), c.id]));
      await app.db.transaction(async (tx) => {
        // Two passes so a parent that arrives later in the file still links.
        for (const row of writable) {
          const code = (row["code"] ?? "").trim();
          if (!code) continue;
          const known = byCode.get(code.toLowerCase());
          const values = {
            title: (row["title"] ?? "").trim(),
            division: (row["division"] ?? "").trim() || null,
            costType: (row["cost_type"] ?? "").trim().toLowerCase() || null,
          };
          if (known) {
            await tx.update(costCodes).set(values).where(eq(costCodes.id, known));
            updated += 1;
          } else {
            const id = newId("cc");
            await tx.insert(costCodes).values({
              id,
              companyId: req.companyId!,
              projectId: null,
              code,
              ...values,
              title: values.title || code,
            });
            byCode.set(code.toLowerCase(), id);
            created += 1;
          }
        }
        for (const row of writable) {
          const parent = (row["parent_code"] ?? "").trim();
          const code = (row["code"] ?? "").trim();
          if (!parent || !code) continue;
          const parentId = byCode.get(parent.toLowerCase());
          const childId = byCode.get(code.toLowerCase());
          if (!parentId || !childId || parentId === childId) continue;
          await tx.update(costCodes).set({ parentId }).where(eq(costCodes.id, childId));
        }
      });
    } else {
      const projectId = job.projectId;
      if (!projectId) throw badRequest("This import job has no project");
      const existing = await app.db
        .select({ id: locations.id, name: locations.name, parentId: locations.parentId, path: locations.path })
        .from(locations)
        .where(and(eq(locations.companyId, req.companyId!), eq(locations.projectId, projectId)));
      // Key a location by its full "A > B > C" path so a second import of
      // the same sheet updates rather than duplicates.
      const nameById = new Map(existing.map((l) => [l.id, l.name]));
      const keyFor = (row: { id: string; path: string }) =>
        row.path
          .split("/")
          .map((segment) => nameById.get(segment) ?? segment)
          .join(" > ")
          .toLowerCase();
      const byPath = new Map(existing.map((l) => [keyFor(l), l.id]));
      await app.db.transaction(async (tx) => {
        for (const row of writable) {
          const path = (row["path"] ?? "").trim();
          if (!path) continue;
          const segments = path.split(">").map((p) => p.trim()).filter(Boolean);
          let parentId: string | null = null;
          let parentPath = "";
          let accumulated: string[] = [];
          for (const segment of segments) {
            accumulated.push(segment);
            const key = accumulated.join(" > ").toLowerCase();
            const known = byPath.get(key);
            if (known) {
              const parentRow = await tx
                .select({ path: locations.path })
                .from(locations)
                .where(eq(locations.id, known))
                .limit(1);
              parentId = known;
              parentPath = parentRow[0]?.path ?? known;
              continue;
            }
            const id = newId("loc");
            const materialised = parentPath ? `${parentPath}/${id}` : id;
            await tx.insert(locations).values({
              id,
              companyId: req.companyId!,
              projectId,
              parentId,
              name: segment,
              path: materialised,
              sortOrder: Number((row["sort_order"] ?? "0").trim()) || 0,
            });
            byPath.set(key, id);
            parentId = id;
            parentPath = materialised;
            created += 1;
          }
        }
      });
    }

    const now = new Date().toISOString();
    await app.db
      .update(importJobs)
      .set({ status: "committed", createdCount: created, updatedCount: updated, committedAt: now })
      .where(eq(importJobs.id, jobId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "import_job",
      objectId: jobId,
      payload: { dataset: job.dataset, created, updated, rows: writable.length },
      storePayload: true,
      projectId: job.projectId,
    });
    return { id: jobId, status: "committed", created, updated, skipped: preview.rowCount - writable.length };
  });
};
