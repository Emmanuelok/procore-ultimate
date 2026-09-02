/**
 * DESIGN ISSUE REGISTER AND DECISION LOG
 * (spec Vol I #250–#252; Vol II T #901–#905).
 *
 * The issue register routes by DISCIPLINE first and person second: that is
 * what makes "who is holding the coordination" answerable when the assignee
 * changes. The decision log records the question, the options, the choice and
 * the rationale — and a decision is proposed by one person and taken by
 * another, so the log cannot be a diary of one person's opinions.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { designComments, designDecisions, designIssues, designPackages } from "@constructos/db";
import {
  DCN_AUTHORISATION_LEVELS,
  DESIGN_DECISION_STATUSES,
  DESIGN_DISCIPLINES,
  DESIGN_ISSUE_PRIORITIES,
  DESIGN_ISSUE_STATUSES,
  DESIGN_ISSUE_TYPES,
  DESIGN_STAGE_KEYS,
} from "@constructos/shared";
import { badRequest, conflict, forbidden, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { pushNotifications } from "../../notifications/service.js";
import {
  allocateReference,
  assertBimModel,
  buildGates,
  assertDrawingSheet,
  assertPackage,
  assertSpecSection,
  assertUser,
  assertVendor,
  currencySchema,
  fileIdsSchema,
  idSchema,
  isoDateSchema,
  ledger,
  nowISO,
  patchSchemaOf,
  patchSet,
} from "../shared.js";

const issueBodySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(8000).nullable().optional(),
  issueType: z.enum(DESIGN_ISSUE_TYPES).default("coordination"),
  priority: z.enum(DESIGN_ISSUE_PRIORITIES).default("medium"),
  discipline: z.enum(DESIGN_DISCIPLINES).default("multi_discipline"),
  affectedDisciplines: z.array(z.enum(DESIGN_DISCIPLINES)).max(16).default([]),
  packageId: idSchema.nullable().optional(),
  reviewId: idSchema.nullable().optional(),
  assignedToUserId: idSchema.nullable().optional(),
  assignedToVendorId: idSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  drawingSheetId: idSchema.nullable().optional(),
  specSectionId: idSchema.nullable().optional(),
  bimModelId: idSchema.nullable().optional(),
  locationRef: z.string().max(160).nullable().optional(),
  fileIds: fileIdsSchema.default([]),
});

const issuePatchSchema = patchSchemaOf(issueBodySchema);

const decisionBodySchema = z.object({
  title: z.string().min(1).max(200),
  question: z.string().min(1).max(8000),
  background: z.string().max(8000).nullable().optional(),
  discipline: z.enum(DESIGN_DISCIPLINES).default("multi_discipline"),
  stageKey: z.enum(DESIGN_STAGE_KEYS).nullable().optional(),
  packageId: idSchema.nullable().optional(),
  issueId: idSchema.nullable().optional(),
  options: z
    .array(
      z.object({
        key: z.string().min(1).max(40),
        label: z.string().min(1).max(200),
        costImpact: z.number().nullable().optional(),
        timeImpactDays: z.number().int().nullable().optional(),
        note: z.string().max(2000).optional(),
      }),
    )
    .max(20)
    .default([]),
  supersedesId: idSchema.nullable().optional(),
  fileIds: fileIdsSchema.default([]),
});

const decisionPatchSchema = patchSchemaOf(decisionBodySchema.omit({ supersedesId: true }));

export const issueRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate, adminGate } = buildGates(app);

  async function loadIssue(companyId: string, projectId: string, id: string) {
    const [row] = await app.db
      .select()
      .from(designIssues)
      .where(and(eq(designIssues.id, id), eq(designIssues.companyId, companyId), eq(designIssues.projectId, projectId)))
      .limit(1);
    if (!row) throw notFound("Design issue not found");
    return row;
  }

  async function refreshPackageIssueCount(packageId: string | null) {
    if (!packageId) return;
    const [row] = await app.db
      .select({ n: count() })
      .from(designIssues)
      .where(and(eq(designIssues.packageId, packageId), inArray(designIssues.status, ["open", "assigned", "in_progress"])));
    await app.db
      .update(designPackages)
      .set({ openIssueCount: row?.n ?? 0, updatedAt: nowISO() })
      .where(eq(designPackages.id, packageId));
  }

  async function validateIssueRefs(
    companyId: string,
    projectId: string,
    body: Partial<z.infer<typeof issueBodySchema>>,
  ) {
    if (body.packageId) await assertPackage(app.db, companyId, projectId, body.packageId);
    if (body.assignedToUserId) await assertUser(app.db, body.assignedToUserId);
    if (body.assignedToVendorId) await assertVendor(app.db, companyId, body.assignedToVendorId);
    if (body.drawingSheetId) await assertDrawingSheet(app.db, projectId, body.drawingSheetId);
    if (body.specSectionId) await assertSpecSection(app.db, projectId, body.specSectionId);
    if (body.bimModelId) await assertBimModel(app.db, projectId, body.bimModelId);
  }

  /* ---------------------------------------------------------------- */
  /* Issues                                                           */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/design/issues", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({
        status: z.enum(DESIGN_ISSUE_STATUSES).optional(),
        priority: z.enum(DESIGN_ISSUE_PRIORITIES).optional(),
        discipline: z.enum(DESIGN_DISCIPLINES).optional(),
        issueType: z.enum(DESIGN_ISSUE_TYPES).optional(),
        packageId: idSchema.optional(),
        assignedToUserId: idSchema.optional(),
        open: z.coerce.boolean().optional(),
        q: z.string().max(120).optional(),
      })
      .parse(req.query);
    const where = and(
      eq(designIssues.companyId, req.companyId!),
      eq(designIssues.projectId, projectId),
      q.status ? eq(designIssues.status, q.status) : undefined,
      q.priority ? eq(designIssues.priority, q.priority) : undefined,
      q.discipline ? eq(designIssues.discipline, q.discipline) : undefined,
      q.issueType ? eq(designIssues.issueType, q.issueType) : undefined,
      q.packageId ? eq(designIssues.packageId, q.packageId) : undefined,
      q.assignedToUserId ? eq(designIssues.assignedToUserId, q.assignedToUserId) : undefined,
      q.open ? inArray(designIssues.status, ["open", "assigned", "in_progress"]) : undefined,
      q.q ? or(ilike(designIssues.title, `%${q.q}%`), ilike(designIssues.reference, `%${q.q}%`)) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db
        .select()
        .from(designIssues)
        .where(where)
        .orderBy(asc(designIssues.dueDate), desc(designIssues.createdAt))
        .limit(q.pageSize)
        .offset(pageOffset(q)),
      app.db.select({ n: count() }).from(designIssues).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post("/projects/:projectId/design/issues", { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = issueBodySchema.parse(req.body);
    const companyId = req.companyId!;
    await validateIssueRefs(companyId, projectId, body);
    const { number, reference } = await allocateReference(app.db, projectId, "design_issue", "DI");
    const id = newId("dis");
    const [inserted] = await app.db
      .insert(designIssues)
      .values({
        id,
        companyId,
        projectId,
        number,
        reference,
        title: body.title,
        description: body.description ?? null,
        issueType: body.issueType,
        priority: body.priority,
        discipline: body.discipline,
        affectedDisciplines: body.affectedDisciplines,
        packageId: body.packageId ?? null,
        reviewId: body.reviewId ?? null,
        assignedToUserId: body.assignedToUserId ?? null,
        assignedToVendorId: body.assignedToVendorId ?? null,
        assignedAt: body.assignedToUserId || body.assignedToVendorId ? nowISO() : null,
        status: body.assignedToUserId || body.assignedToVendorId ? "assigned" : "open",
        dueDate: body.dueDate ?? null,
        drawingSheetId: body.drawingSheetId ?? null,
        specSectionId: body.specSectionId ?? null,
        bimModelId: body.bimModelId ?? null,
        locationRef: body.locationRef ?? null,
        fileIds: body.fileIds,
        raisedBy: req.user!.id,
      })
      .returning();
    await refreshPackageIssueCount(body.packageId ?? null);
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "design_issue",
      objectId: id,
      payload: { reference, discipline: body.discipline, priority: body.priority, issueType: body.issueType },
    });
    if (body.assignedToUserId) {
      await pushNotifications(app.db, [
        {
          companyId,
          userId: body.assignedToUserId,
          projectId,
          kind: "assignment",
          title: `Design issue ${reference} assigned to you`,
          body: body.title,
          recordType: "design_issue",
          recordId: id,
        },
      ]);
    }
    return reply.code(201).send(inserted);
  });

  app.get("/projects/:projectId/design/issues/:issueId", { preHandler: readGate }, async (req) => {
    const { projectId, issueId } = req.params as { projectId: string; issueId: string };
    const companyId = req.companyId!;
    const row = await loadIssue(companyId, projectId, issueId);
    const [pkg, comment, decisions] = await Promise.all([
      row.packageId
        ? app.db.select().from(designPackages).where(eq(designPackages.id, row.packageId)).limit(1)
        : Promise.resolve([]),
      row.commentId
        ? app.db.select().from(designComments).where(eq(designComments.id, row.commentId)).limit(1)
        : Promise.resolve([]),
      app.db.select().from(designDecisions).where(eq(designDecisions.issueId, issueId)),
    ]);
    return { ...row, package: pkg[0] ?? null, comment: comment[0] ?? null, decisions };
  });

  app.patch("/projects/:projectId/design/issues/:issueId", { preHandler: standardGate }, async (req) => {
    const { projectId, issueId } = req.params as { projectId: string; issueId: string };
    const body = issuePatchSchema.parse(req.body);
    const companyId = req.companyId!;
    const row = await loadIssue(companyId, projectId, issueId);
    if (row.status === "closed" || row.status === "void") {
      throw conflict(`This issue is ${row.status}; reopen it deliberately rather than editing a closed record.`);
    }
    await validateIssueRefs(companyId, projectId, body);
    const set = patchSet(body as Record<string, unknown>, [
      "title",
      "description",
      "issueType",
      "priority",
      "discipline",
      "affectedDisciplines",
      "packageId",
      "reviewId",
      "dueDate",
      "drawingSheetId",
      "specSectionId",
      "bimModelId",
      "locationRef",
      "fileIds",
    ]);
    if ("assignedToUserId" in body || "assignedToVendorId" in body) {
      throw badRequest(
        "Assignment moves through POST /design/issues/:id/assign so the routing is ledgered and the assignee is notified.",
      );
    }
    const [updated] = await app.db.update(designIssues).set(set).where(eq(designIssues.id, issueId)).returning();
    if (row.packageId !== updated?.packageId) {
      await refreshPackageIssueCount(row.packageId);
      await refreshPackageIssueCount(updated?.packageId ?? null);
    }
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "design_issue",
      objectId: issueId,
      payload: { keys: Object.keys(set).filter((k) => k !== "updatedAt") },
    });
    return updated;
  });

  app.post("/projects/:projectId/design/issues/:issueId/assign", { preHandler: standardGate }, async (req) => {
    const { projectId, issueId } = req.params as { projectId: string; issueId: string };
    const body = z
      .object({
        assignedToUserId: idSchema.nullable().optional(),
        assignedToVendorId: idSchema.nullable().optional(),
        discipline: z.enum(DESIGN_DISCIPLINES).optional(),
        dueDate: isoDateSchema.nullable().optional(),
        note: z.string().max(2000).optional(),
      })
      .parse(req.body);
    const companyId = req.companyId!;
    const row = await loadIssue(companyId, projectId, issueId);
    if (row.status === "closed" || row.status === "void") throw conflict(`This issue is ${row.status}.`);
    if (!body.assignedToUserId && !body.assignedToVendorId && !body.discipline) {
      throw badRequest("Routing needs at least a discipline, a user or a vendor.");
    }
    if (body.assignedToUserId) await assertUser(app.db, body.assignedToUserId);
    if (body.assignedToVendorId) await assertVendor(app.db, companyId, body.assignedToVendorId);
    const set: Record<string, unknown> = { updatedAt: nowISO() };
    if (body.assignedToUserId !== undefined) set["assignedToUserId"] = body.assignedToUserId;
    if (body.assignedToVendorId !== undefined) set["assignedToVendorId"] = body.assignedToVendorId;
    if (body.discipline) set["discipline"] = body.discipline;
    if (body.dueDate !== undefined) set["dueDate"] = body.dueDate;
    set["assignedAt"] = nowISO();
    if (row.status === "open") set["status"] = "assigned";
    const [updated] = await app.db.update(designIssues).set(set).where(eq(designIssues.id, issueId)).returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_issue",
      objectId: issueId,
      payload: {
        assignedToUserId: body.assignedToUserId ?? null,
        assignedToVendorId: body.assignedToVendorId ?? null,
        discipline: body.discipline ?? row.discipline,
        note: body.note ?? null,
      },
    });
    if (body.assignedToUserId) {
      await pushNotifications(app.db, [
        {
          companyId,
          userId: body.assignedToUserId,
          projectId,
          kind: "assignment",
          title: `Design issue ${row.reference} routed to you`,
          body: `${row.title}${body.dueDate ? ` — due ${body.dueDate}` : ""}`,
          recordType: "design_issue",
          recordId: issueId,
        },
      ]);
    }
    return updated;
  });

  app.post("/projects/:projectId/design/issues/:issueId/resolve", { preHandler: standardGate }, async (req) => {
    const { projectId, issueId } = req.params as { projectId: string; issueId: string };
    const body = z.object({ resolution: z.string().min(1).max(8000) }).parse(req.body);
    const companyId = req.companyId!;
    const row = await loadIssue(companyId, projectId, issueId);
    if (row.status === "closed" || row.status === "void") throw conflict(`This issue is ${row.status}.`);
    if (row.status === "resolved") throw conflict("This issue is already resolved; close it or reopen it.");
    const [updated] = await app.db
      .update(designIssues)
      .set({ status: "resolved", resolution: body.resolution, resolvedBy: req.user!.id, resolvedAt: nowISO(), updatedAt: nowISO() })
      .where(eq(designIssues.id, issueId))
      .returning();
    await refreshPackageIssueCount(row.packageId);
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_issue",
      objectId: issueId,
      payload: { to: "resolved" },
    });
    if (row.raisedBy !== req.user!.id) {
      await pushNotifications(app.db, [
        {
          companyId,
          userId: row.raisedBy,
          projectId,
          kind: "design",
          title: `Design issue ${row.reference} resolved`,
          body: body.resolution.slice(0, 240),
          recordType: "design_issue",
          recordId: issueId,
        },
      ]);
    }
    return updated;
  });

  /** Closure verifies the resolution, so it must not be the person who resolved it. */
  app.post("/projects/:projectId/design/issues/:issueId/close", { preHandler: standardGate }, async (req) => {
    const { projectId, issueId } = req.params as { projectId: string; issueId: string };
    const body = z.object({ note: z.string().max(4000).optional() }).parse(req.body ?? {});
    const companyId = req.companyId!;
    const row = await loadIssue(companyId, projectId, issueId);
    if (row.status === "closed") throw conflict("This issue is already closed.");
    if (row.status !== "resolved") {
      throw badRequest("An issue is closed once it has been resolved. Record the resolution first, or void it.");
    }
    if (row.resolvedBy === req.user!.id) {
      throw forbidden(
        "Closure verifies the resolution, so it cannot be done by whoever resolved it. Ask the raiser or the design lead to close it.",
      );
    }
    const [updated] = await app.db
      .update(designIssues)
      .set({ status: "closed", closedBy: req.user!.id, closedAt: nowISO(), updatedAt: nowISO() })
      .where(eq(designIssues.id, issueId))
      .returning();
    await refreshPackageIssueCount(row.packageId);
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_issue",
      objectId: issueId,
      payload: { to: "closed", note: body.note ?? null },
    });
    return updated;
  });

  app.post("/projects/:projectId/design/issues/:issueId/reopen", { preHandler: standardGate }, async (req) => {
    const { projectId, issueId } = req.params as { projectId: string; issueId: string };
    const body = z.object({ reason: z.string().min(1).max(4000) }).parse(req.body);
    const companyId = req.companyId!;
    const row = await loadIssue(companyId, projectId, issueId);
    if (row.status !== "closed" && row.status !== "resolved") throw conflict("Only a resolved or closed issue can be reopened.");
    const [updated] = await app.db
      .update(designIssues)
      .set({
        status: row.assignedToUserId || row.assignedToVendorId ? "assigned" : "open",
        resolvedAt: null,
        resolvedBy: null,
        closedAt: null,
        closedBy: null,
        staleSignalId: null,
        updatedAt: nowISO(),
      })
      .where(eq(designIssues.id, issueId))
      .returning();
    await refreshPackageIssueCount(row.packageId);
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_issue",
      objectId: issueId,
      payload: { from: row.status, to: updated?.status ?? "open", reason: body.reason },
    });
    return updated;
  });

  app.post("/projects/:projectId/design/issues/:issueId/void", { preHandler: adminGate }, async (req) => {
    const { projectId, issueId } = req.params as { projectId: string; issueId: string };
    const body = z.object({ reason: z.string().min(1).max(4000) }).parse(req.body);
    const companyId = req.companyId!;
    const row = await loadIssue(companyId, projectId, issueId);
    if (row.status === "void") throw conflict("This issue is already void.");
    const [updated] = await app.db
      .update(designIssues)
      .set({ status: "void", voidReason: body.reason, closedBy: req.user!.id, closedAt: nowISO(), updatedAt: nowISO() })
      .where(eq(designIssues.id, issueId))
      .returning();
    await refreshPackageIssueCount(row.packageId);
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_issue",
      objectId: issueId,
      payload: { to: "void", reason: body.reason },
    });
    return updated;
  });

  /** Ball-in-court by discipline: the register's most-used view. */
  app.get("/projects/:projectId/design/issues-by-discipline", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const rows = await app.db
      .select()
      .from(designIssues)
      .where(and(eq(designIssues.companyId, req.companyId!), eq(designIssues.projectId, projectId)));
    const now = Date.now();
    const buckets = new Map<
      string,
      { discipline: string; open: number; overdue: number; critical: number; oldestDays: number | null; total: number }
    >();
    for (const row of rows) {
      const bucket = buckets.get(row.discipline) ?? {
        discipline: row.discipline,
        open: 0,
        overdue: 0,
        critical: 0,
        oldestDays: null,
        total: 0,
      };
      bucket.total += 1;
      const isOpen = ["open", "assigned", "in_progress"].includes(row.status);
      if (isOpen) {
        bucket.open += 1;
        if (row.priority === "critical" || row.priority === "high") bucket.critical += 1;
        if (row.dueDate && Date.parse(`${row.dueDate}T00:00:00Z`) < now) bucket.overdue += 1;
        const raised = Date.parse(row.raisedAt ?? row.createdAt);
        if (!Number.isNaN(raised)) {
          const age = Math.floor((now - raised) / 86_400_000);
          bucket.oldestDays = bucket.oldestDays === null ? age : Math.max(bucket.oldestDays, age);
        }
      }
      buckets.set(row.discipline, bucket);
    }
    const items = [...buckets.values()].sort((a, b) => b.open - a.open);
    return {
      items,
      total: rows.length,
      reasons: rows.length === 0 ? ["No design issue has been raised on this project."] : [],
    };
  });

  /* ---------------------------------------------------------------- */
  /* Decision log                                                     */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/design/decisions", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({
        status: z.enum(DESIGN_DECISION_STATUSES).optional(),
        discipline: z.enum(DESIGN_DISCIPLINES).optional(),
        packageId: idSchema.optional(),
        q: z.string().max(120).optional(),
      })
      .parse(req.query);
    const where = and(
      eq(designDecisions.companyId, req.companyId!),
      eq(designDecisions.projectId, projectId),
      q.status ? eq(designDecisions.status, q.status) : undefined,
      q.discipline ? eq(designDecisions.discipline, q.discipline) : undefined,
      q.packageId ? eq(designDecisions.packageId, q.packageId) : undefined,
      q.q ? or(ilike(designDecisions.title, `%${q.q}%`), ilike(designDecisions.reference, `%${q.q}%`)) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db
        .select()
        .from(designDecisions)
        .where(where)
        .orderBy(desc(designDecisions.number))
        .limit(q.pageSize)
        .offset(pageOffset(q)),
      app.db.select({ n: count() }).from(designDecisions).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  async function loadDecision(companyId: string, projectId: string, id: string) {
    const [row] = await app.db
      .select()
      .from(designDecisions)
      .where(
        and(eq(designDecisions.id, id), eq(designDecisions.companyId, companyId), eq(designDecisions.projectId, projectId)),
      )
      .limit(1);
    if (!row) throw notFound("Design decision not found");
    return row;
  }

  app.post("/projects/:projectId/design/decisions", { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = decisionBodySchema.parse(req.body);
    const companyId = req.companyId!;
    if (body.packageId) await assertPackage(app.db, companyId, projectId, body.packageId);
    if (body.issueId) await loadIssue(companyId, projectId, body.issueId);
    if (body.supersedesId) await loadDecision(companyId, projectId, body.supersedesId);
    const keys = new Set(body.options.map((o) => o.key));
    if (keys.size !== body.options.length) throw badRequest("Option keys must be unique within a decision.");
    const { number, reference } = await allocateReference(app.db, projectId, "design_decision", "DD");
    const id = newId("ddc");
    const [inserted] = await app.db
      .insert(designDecisions)
      .values({
        id,
        companyId,
        projectId,
        number,
        reference,
        title: body.title,
        question: body.question,
        background: body.background ?? null,
        discipline: body.discipline,
        stageKey: body.stageKey ?? null,
        packageId: body.packageId ?? null,
        issueId: body.issueId ?? null,
        options: body.options,
        supersedesId: body.supersedesId ?? null,
        fileIds: body.fileIds,
        proposedBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "design_decision",
      objectId: id,
      payload: { reference, options: body.options.length, supersedesId: body.supersedesId ?? null },
    });
    return reply.code(201).send(inserted);
  });

  app.get("/projects/:projectId/design/decisions/:decisionId", { preHandler: readGate }, async (req) => {
    const { projectId, decisionId } = req.params as { projectId: string; decisionId: string };
    const companyId = req.companyId!;
    const row = await loadDecision(companyId, projectId, decisionId);
    const [supersedes, supersededBy] = await Promise.all([
      row.supersedesId
        ? app.db.select().from(designDecisions).where(eq(designDecisions.id, row.supersedesId)).limit(1)
        : Promise.resolve([]),
      app.db.select().from(designDecisions).where(eq(designDecisions.supersedesId, decisionId)),
    ]);
    return { ...row, supersedes: supersedes[0] ?? null, supersededBy };
  });

  app.patch("/projects/:projectId/design/decisions/:decisionId", { preHandler: standardGate }, async (req) => {
    const { projectId, decisionId } = req.params as { projectId: string; decisionId: string };
    const body = decisionPatchSchema.parse(req.body);
    const companyId = req.companyId!;
    const row = await loadDecision(companyId, projectId, decisionId);
    if (row.status !== "proposed") {
      throw conflict("A decision that has been taken is a record. Supersede it with a new decision instead of editing it.");
    }
    if (body.packageId) await assertPackage(app.db, companyId, projectId, body.packageId);
    const set = patchSet(body as Record<string, unknown>, [
      "title",
      "question",
      "background",
      "discipline",
      "stageKey",
      "packageId",
      "issueId",
      "options",
      "fileIds",
    ]);
    const [updated] = await app.db.update(designDecisions).set(set).where(eq(designDecisions.id, decisionId)).returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "design_decision",
      objectId: decisionId,
      payload: { keys: Object.keys(set).filter((k) => k !== "updatedAt") },
    });
    return updated;
  });

  /** Taking the decision. The proposer may not be the decider. */
  app.post("/projects/:projectId/design/decisions/:decisionId/decide", { preHandler: standardGate }, async (req) => {
    const { projectId, decisionId } = req.params as { projectId: string; decisionId: string };
    const body = z
      .object({
        decision: z.string().min(1).max(8000),
        chosenOptionKey: z.string().max(40).nullable().optional(),
        rationale: z.string().min(1).max(8000),
        authorisationLevel: z.enum(DCN_AUTHORISATION_LEVELS).default("design_lead"),
        costImpact: z.number().nullable().optional(),
        currency: currencySchema.optional(),
        timeImpactDays: z.number().int().nullable().optional(),
      })
      .parse(req.body);
    const companyId = req.companyId!;
    const row = await loadDecision(companyId, projectId, decisionId);
    if (row.status !== "proposed") throw conflict(`This decision is ${row.status}.`);
    if (row.proposedBy === req.user!.id) {
      throw forbidden(
        "A design decision is taken by someone other than whoever proposed it. A decision log where the proposer signs their own proposal records nothing.",
      );
    }
    if (body.chosenOptionKey) {
      const keys = (row.options ?? []).map((o) => o.key);
      if (keys.length > 0 && !keys.includes(body.chosenOptionKey)) {
        throw badRequest(`chosenOptionKey must be one of the recorded options: ${keys.join(", ")}.`);
      }
    }
    const [updated] = await app.db
      .update(designDecisions)
      .set({
        status: "decided",
        decision: body.decision,
        chosenOptionKey: body.chosenOptionKey ?? null,
        rationale: body.rationale,
        authorisationLevel: body.authorisationLevel,
        decidedBy: req.user!.id,
        decidedAt: nowISO(),
        costImpact: body.costImpact ?? null,
        currency: body.currency ?? row.currency,
        timeImpactDays: body.timeImpactDays ?? null,
        updatedAt: nowISO(),
      })
      .where(eq(designDecisions.id, decisionId))
      .returning();
    if (row.supersedesId) {
      await app.db
        .update(designDecisions)
        .set({ status: "superseded", supersededById: decisionId, updatedAt: nowISO() })
        .where(and(eq(designDecisions.id, row.supersedesId), eq(designDecisions.status, "decided")));
    }
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_decision",
      objectId: decisionId,
      payload: {
        to: "decided",
        chosenOptionKey: body.chosenOptionKey ?? null,
        authorisationLevel: body.authorisationLevel,
        supersedesId: row.supersedesId,
      },
    });
    await pushNotifications(app.db, [
      {
        companyId,
        userId: row.proposedBy,
        projectId,
        kind: "design",
        title: `Design decision ${row.reference} taken`,
        body: body.decision.slice(0, 240),
        recordType: "design_decision",
        recordId: decisionId,
      },
    ]);
    return updated;
  });

  app.post("/projects/:projectId/design/decisions/:decisionId/reverse", { preHandler: adminGate }, async (req) => {
    const { projectId, decisionId } = req.params as { projectId: string; decisionId: string };
    const body = z.object({ reason: z.string().min(1).max(4000) }).parse(req.body);
    const companyId = req.companyId!;
    const row = await loadDecision(companyId, projectId, decisionId);
    if (row.status !== "decided") throw conflict("Only a decision that was taken can be reversed.");
    const [updated] = await app.db
      .update(designDecisions)
      .set({ status: "reversed", reversedReason: body.reason, updatedAt: nowISO() })
      .where(eq(designDecisions.id, decisionId))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_decision",
      objectId: decisionId,
      payload: { to: "reversed", reason: body.reason },
    });
    return updated;
  });

};
