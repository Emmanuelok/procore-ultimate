import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, isNull, like, or } from "drizzle-orm";
import { z } from "zod";
import {
  assets,
  bimModels,
  comments,
  companyMemberships,
  costCodes,
  customFieldDefs,
  customFieldValues,
  drawingSheets,
  locations,
  notifications,
  portfolios,
  projectMemberships,
  projects,
  punchItems,
  recordLinks,
  rfis,
  signals,
  submittals,
  tagAssignments,
  tags,
  users,
  watchers,
  wbsSegments,
} from "@constructos/db";
import { COST_TYPES, PROJECT_STAGES, TOOLS } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";

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
});

const projectPatchSchema = projectCreateSchema.partial().extend({
  name: z.string().min(1).max(200).optional(),
});

const projectListQuery = pageQuerySchema.extend({
  stage: z.enum(PROJECT_STAGES).optional(),
  search: z.string().max(200).optional(),
  portfolioId: z.string().optional(),
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
  const tool = (level: "read" | "standard" | "admin") => [
    app.authenticate,
    app.requireCompany,
    app.requireTool("projects", level),
  ];

  /* ---------------------------------------------------------------- */
  /* Projects (spec #49-53, #71)                                       */
  /* ---------------------------------------------------------------- */

  app.get("/projects", { preHandler: memberGate }, async (req) => {
    const q = projectListQuery.parse(req.query);
    const conds = [eq(projects.companyId, req.companyId!)];
    if (q.stage) conds.push(eq(projects.stage, q.stage));
    if (q.portfolioId) conds.push(eq(projects.portfolioId, q.portfolioId));
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
    const id = newId("prj");
    const [created] = await app.db
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
      })
      .returning();
    // the creator becomes project admin so they can operate their own project
    await app.db.insert(projectMemberships).values({
      id: newId("pm"),
      companyId: req.companyId!,
      projectId: id,
      userId: req.user!.id,
      templateKey: "project_admin",
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
    const rows = await app.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, req.projectId!), eq(projects.companyId, req.companyId!)))
      .limit(1);
    if (!rows[0]) throw notFound("Project not found");
    return rows[0];
  });

  app.patch("/projects/:projectId", { preHandler: tool("standard") }, async (req) => {
    const body = projectPatchSchema.parse(req.body);
    const rows = await app.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, req.projectId!), eq(projects.companyId, req.companyId!)))
      .limit(1);
    const existing = rows[0];
    if (!existing) throw notFound("Project not found");

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
    });
    return updated;
  });

  app.delete("/projects/:projectId", { preHandler: tool("admin") }, async (req) => {
    const rows = await app.db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(eq(projects.id, req.projectId!), eq(projects.companyId, req.companyId!)))
      .limit(1);
    if (!rows[0]) throw notFound("Project not found");
    await app.db
      .delete(projects)
      .where(and(eq(projects.id, req.projectId!), eq(projects.companyId, req.companyId!)));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "project",
      objectId: req.projectId!,
      payload: rows[0],
      storePayload: true,
    });
    return { ok: true };
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

  async function deleteCostCode(
    req: { companyId?: string; user?: { id: string } },
    costCodeId: string,
    projectId: string | null,
  ) {
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

  app.delete("/links/:linkId", { preHandler: memberGate }, async (req) => {
    const { linkId } = req.params as { linkId: string };
    const deleted = await app.db
      .delete(recordLinks)
      .where(and(eq(recordLinks.id, linkId), eq(recordLinks.companyId, req.companyId!)))
      .returning({ id: recordLinks.id });
    if (!deleted[0]) throw notFound("Link not found");
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "record_link",
      objectId: linkId,
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

      // only notify users who are actually members of this company
      let validMentions: string[] = [];
      if (mentionIds.length > 0) {
        const members = await app.db
          .select({ userId: companyMemberships.userId })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, req.companyId!),
              inArray(companyMemberships.userId, mentionIds),
            ),
          );
        validMentions = members.map((m) => m.userId);
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

      for (const userId of validMentions) {
        await app.db.insert(notifications).values({
          id: newId("ntf"),
          companyId: req.companyId!,
          userId,
          projectId: req.projectId!,
          kind: "mention",
          title: `${req.user!.name} mentioned you in a comment`,
          body: body.body.slice(0, 280),
          recordType,
          recordId,
        });
      }

      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "comment",
        objectId: id,
        payload: created,
      });
      return reply.status(201).send(created);
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
        .where(and(eq(watchers.recordType, recordType), eq(watchers.recordId, recordId)))
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

      await app.db.transaction(async (tx) => {
        for (const defId of defIds) {
          const value = body.values[defId] ?? null;
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
              .set({ value, updatedAt: new Date().toISOString() })
              .where(eq(customFieldValues.id, existing[0].id));
          } else {
            await tx.insert(customFieldValues).values({
              id: newId("cfv"),
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
        payload: body.values,
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
};
