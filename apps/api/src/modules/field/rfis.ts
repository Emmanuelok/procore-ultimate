import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, ilike, isNotNull, lt, ne } from "drizzle-orm";
import { z } from "zod";
import { rfis } from "@constructos/db";
import { RFI_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { pushNotifications } from "../notifications/service.js";
import { addDaysISO, daysBetween, isoDateSchema, todayISO } from "./dates.js";

const impactSchema = z.enum(["yes", "no", "tbd"]);

const rfiCreateSchema = z.object({
  subject: z.string().min(1).max(300),
  question: z.string().min(1).max(20000),
  proposedSolution: z.string().max(20000).nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  ballInCourtId: z.string().nullable().optional(),
  distribution: z.array(z.string().min(1)).max(50).optional(),
  dueDate: isoDateSchema.nullable().optional(),
  costImpact: impactSchema.optional(),
  scheduleImpact: impactSchema.optional(),
  scheduleImpactDays: z.number().int().min(0).nullable().optional(),
  locationId: z.string().nullable().optional(),
});

const rfiPatchSchema = rfiCreateSchema.partial();

const rfiListQuery = pageQuerySchema.extend({
  status: z.enum(RFI_STATUSES).optional(),
  assigneeId: z.string().optional(),
  overdue: z.enum(["true", "false"]).optional(),
  search: z.string().max(200).optional(),
});

const respondSchema = z.object({
  officialResponse: z.string().min(1).max(20000),
  costImpact: impactSchema.optional(),
  scheduleImpact: impactSchema.optional(),
  scheduleImpactDays: z.number().int().min(0).nullable().optional(),
});

/** RFIs — spec Vol I §2.4 #302-#325. */
export const rfiRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("rfis", "read")];
  const standardGate = [app.authenticate, app.requireCompany, app.requireTool("rfis", "standard")];

  async function fetchRfi(rfiId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(rfis)
      .where(
        and(eq(rfis.id, rfiId), eq(rfis.companyId, companyId), eq(rfis.projectId, projectId)),
      )
      .limit(1);
    if (!rows[0]) throw notFound("RFI not found");
    return rows[0];
  }

  async function ledgerRfi(
    action: "create" | "update" | "state_change",
    rfiId: string,
    req: { companyId?: string; user?: { id: string } },
    payload: unknown,
  ) {
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action,
      objectType: "rfi",
      objectId: rfiId,
      payload,
    });
  }

  app.post("/projects/:projectId/rfis", { preHandler: standardGate }, async (req, reply) => {
    const body = rfiCreateSchema.parse(req.body);
    const number = await nextRecordNumber(app.db, req.projectId!, "rfi");
    const id = newId("rfi");
    const row: typeof rfis.$inferInsert = {
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      number,
      subject: body.subject,
      question: body.question,
      proposedSolution: body.proposedSolution ?? null,
      status: "draft",
      assigneeId: body.assigneeId ?? null,
      ballInCourtId: body.ballInCourtId ?? body.assigneeId ?? null,
      distribution: body.distribution ?? [],
      dueDate: body.dueDate ?? null,
      costImpact: body.costImpact ?? "tbd",
      scheduleImpact: body.scheduleImpact ?? "tbd",
      scheduleImpactDays: body.scheduleImpactDays ?? null,
      locationId: body.locationId ?? null,
      createdBy: req.user!.id,
    };
    await app.db.insert(rfis).values(row);
    await ledgerRfi("create", id, req, { number, subject: body.subject });
    const created = await fetchRfi(id, req.companyId!, req.projectId!);
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/rfis", { preHandler: readGate }, async (req) => {
    const q = rfiListQuery.parse(req.query);
    const clauses = [eq(rfis.companyId, req.companyId!), eq(rfis.projectId, req.projectId!)];
    if (q.status) clauses.push(eq(rfis.status, q.status));
    if (q.assigneeId) clauses.push(eq(rfis.assigneeId, q.assigneeId));
    if (q.search) clauses.push(ilike(rfis.subject, `%${q.search}%`));
    if (q.overdue === "true") {
      clauses.push(eq(rfis.status, "open"), isNotNull(rfis.dueDate), lt(rfis.dueDate, todayISO()));
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(rfis).where(where);
    const items = await app.db
      .select()
      .from(rfis)
      .where(where)
      .orderBy(desc(rfis.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/rfis/analytics", { preHandler: readGate }, async (req) => {
    const scope = and(eq(rfis.companyId, req.companyId!), eq(rfis.projectId, req.projectId!));
    const byStatusRows = await app.db
      .select({ status: rfis.status, n: count() })
      .from(rfis)
      .where(scope)
      .groupBy(rfis.status);
    const byStatus: Record<string, number> = {};
    for (const r of byStatusRows) byStatus[r.status] = Number(r.n);
    const [overdueRow] = await app.db
      .select({ n: count() })
      .from(rfis)
      .where(
        and(scope, eq(rfis.status, "open"), isNotNull(rfis.dueDate), lt(rfis.dueDate, todayISO())),
      );
    const answered = await app.db
      .select({ createdAt: rfis.createdAt, respondedAt: rfis.respondedAt })
      .from(rfis)
      .where(and(scope, isNotNull(rfis.respondedAt)));
    const durations = answered
      .filter((r) => r.respondedAt)
      .map((r) => daysBetween(r.createdAt, r.respondedAt!));
    const avgResponseDays =
      durations.length > 0
        ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10
        : null;
    return {
      open: byStatus["open"] ?? 0,
      overdue: Number(overdueRow?.n ?? 0),
      avgResponseDays,
      byStatus,
    };
  });

  app.get("/projects/:projectId/rfis/:rfiId", { preHandler: readGate }, async (req) => {
    const { rfiId } = req.params as { rfiId: string };
    return fetchRfi(rfiId, req.companyId!, req.projectId!);
  });

  app.patch("/projects/:projectId/rfis/:rfiId", { preHandler: standardGate }, async (req) => {
    const { rfiId } = req.params as { rfiId: string };
    const body = rfiPatchSchema.parse(req.body);
    const rfi = await fetchRfi(rfiId, req.companyId!, req.projectId!);
    if (rfi.status === "void" || rfi.status === "closed") {
      throw badRequest(`A ${rfi.status} RFI cannot be edited`);
    }
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) set[k] = v;
    }
    await app.db.update(rfis).set(set).where(eq(rfis.id, rfiId));
    await ledgerRfi("update", rfiId, req, { changed: Object.keys(body) });
    if (body.assigneeId && body.assigneeId !== rfi.assigneeId) {
      await pushNotifications(app.db, [
        {
          companyId: req.companyId!,
          userId: body.assigneeId,
          projectId: req.projectId!,
          kind: "assignment",
          title: `RFI-${String(rfi.number).padStart(3, "0")} assigned to you: ${rfi.subject}`,
          recordType: "rfi",
          recordId: rfiId,
        },
      ]);
    }
    return fetchRfi(rfiId, req.companyId!, req.projectId!);
  });

  app.post(
    "/projects/:projectId/rfis/:rfiId/issue",
    { preHandler: standardGate },
    async (req) => {
      const { rfiId } = req.params as { rfiId: string };
      const rfi = await fetchRfi(rfiId, req.companyId!, req.projectId!);
      if (rfi.status !== "draft") throw badRequest("Only a draft RFI can be issued");
      const dueDate = rfi.dueDate ?? addDaysISO(todayISO(), 7);
      await app.db
        .update(rfis)
        .set({ status: "open", dueDate, updatedAt: new Date().toISOString() })
        .where(eq(rfis.id, rfiId));
      await ledgerRfi("state_change", rfiId, req, { from: "draft", to: "open", dueDate });
      const label = `RFI-${String(rfi.number).padStart(3, "0")}`;
      const targets = [];
      if (rfi.assigneeId) {
        targets.push({
          companyId: req.companyId!,
          userId: rfi.assigneeId,
          projectId: req.projectId!,
          kind: "assignment" as const,
          title: `${label} issued to you: ${rfi.subject}`,
          body: `Response due ${dueDate}.`,
          recordType: "rfi",
          recordId: rfiId,
        });
      }
      for (const userId of rfi.distribution ?? []) {
        targets.push({
          companyId: req.companyId!,
          userId,
          projectId: req.projectId!,
          kind: "status_change" as const,
          title: `${label} issued: ${rfi.subject}`,
          recordType: "rfi",
          recordId: rfiId,
        });
      }
      await pushNotifications(app.db, targets);
      return fetchRfi(rfiId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/rfis/:rfiId/respond",
    { preHandler: standardGate },
    async (req) => {
      const { rfiId } = req.params as { rfiId: string };
      const body = respondSchema.parse(req.body);
      const rfi = await fetchRfi(rfiId, req.companyId!, req.projectId!);
      if (rfi.status !== "open") throw badRequest("Only an open RFI can be answered");
      const now = new Date().toISOString();
      await app.db
        .update(rfis)
        .set({
          status: "answered",
          officialResponse: body.officialResponse,
          respondedBy: req.user!.id,
          respondedAt: now,
          costImpact: body.costImpact ?? rfi.costImpact,
          scheduleImpact: body.scheduleImpact ?? rfi.scheduleImpact,
          scheduleImpactDays:
            body.scheduleImpactDays !== undefined
              ? body.scheduleImpactDays
              : rfi.scheduleImpactDays,
          ballInCourtId: rfi.createdBy,
          updatedAt: now,
        })
        .where(eq(rfis.id, rfiId));
      await ledgerRfi("state_change", rfiId, req, { from: "open", to: "answered" });
      const label = `RFI-${String(rfi.number).padStart(3, "0")}`;
      const targets = [
        {
          companyId: req.companyId!,
          userId: rfi.createdBy,
          projectId: req.projectId!,
          kind: "status_change" as const,
          title: `${label} answered: ${rfi.subject}`,
          recordType: "rfi",
          recordId: rfiId,
        },
        ...(rfi.distribution ?? []).map((userId) => ({
          companyId: req.companyId!,
          userId,
          projectId: req.projectId!,
          kind: "status_change" as const,
          title: `${label} answered: ${rfi.subject}`,
          recordType: "rfi",
          recordId: rfiId,
        })),
      ];
      await pushNotifications(app.db, targets);
      return fetchRfi(rfiId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/rfis/:rfiId/close",
    { preHandler: standardGate },
    async (req) => {
      const { rfiId } = req.params as { rfiId: string };
      const rfi = await fetchRfi(rfiId, req.companyId!, req.projectId!);
      if (rfi.status !== "open" && rfi.status !== "answered") {
        throw badRequest("Only an open or answered RFI can be closed");
      }
      await app.db
        .update(rfis)
        .set({ status: "closed", updatedAt: new Date().toISOString() })
        .where(eq(rfis.id, rfiId));
      await ledgerRfi("state_change", rfiId, req, { from: rfi.status, to: "closed" });
      return fetchRfi(rfiId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/rfis/:rfiId/void",
    { preHandler: standardGate },
    async (req) => {
      const { rfiId } = req.params as { rfiId: string };
      const rfi = await fetchRfi(rfiId, req.companyId!, req.projectId!);
      if (rfi.status === "closed" || rfi.status === "void") {
        throw badRequest(`A ${rfi.status} RFI cannot be voided`);
      }
      await app.db
        .update(rfis)
        .set({ status: "void", updatedAt: new Date().toISOString() })
        .where(and(eq(rfis.id, rfiId), ne(rfis.status, "void")));
      await ledgerRfi("state_change", rfiId, req, { from: rfi.status, to: "void" });
      return fetchRfi(rfiId, req.companyId!, req.projectId!);
    },
  );
};
