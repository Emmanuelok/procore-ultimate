import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import { dailyLogs } from "@constructos/db";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { pushNotifications } from "../notifications/service.js";
import { addDaysISO, isBusinessDay, isoDateSchema } from "./dates.js";

const manpowerRow = z.object({
  company: z.string().min(1).max(200),
  workers: z.number().int().min(0),
  hours: z.number().min(0),
  notes: z.string().max(1000).optional(),
});
const equipmentRow = z.object({
  name: z.string().min(1).max(200),
  hoursOperating: z.number().min(0),
  hoursIdle: z.number().min(0),
});
const deliveryRow = z.object({
  supplier: z.string().min(1).max(200),
  description: z.string().min(1).max(1000),
  trackingRef: z.string().max(200).optional(),
});
const visitorRow = z.object({
  name: z.string().min(1).max(200),
  company: z.string().max(200).optional(),
  reason: z.string().max(500).optional(),
});
const delayRow = z.object({
  cause: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  hoursLost: z.number().min(0).optional(),
});
const quantityRow = z.object({
  costCode: z.string().max(100).optional(),
  description: z.string().min(1).max(500),
  qty: z.number(),
  unit: z.string().min(1).max(50),
});

const sectionsSchema = z.object({
  manpower: z.array(manpowerRow).max(200).optional(),
  equipment: z.array(equipmentRow).max(200).optional(),
  deliveries: z.array(deliveryRow).max(200).optional(),
  visitors: z.array(visitorRow).max(200).optional(),
  delays: z.array(delayRow).max(200).optional(),
  quantities: z.array(quantityRow).max(200).optional(),
});

const weatherSchema = z.object({
  tempC: z.number().min(-80).max(70).optional(),
  conditions: z.string().max(200).optional(),
  windKph: z.number().min(0).optional(),
  precipitationMm: z.number().min(0).optional(),
});

const upsertSchema = z.object({
  sections: sectionsSchema.optional(),
  weather: weatherSchema.nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  photoFileIds: z.array(z.string()).max(200).optional(),
});

const listQuery = pageQuerySchema.extend({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  status: z.enum(["draft", "submitted", "approved"]).optional(),
  createdBy: z.string().optional(),
});

const rangeQuery = z.object({ from: isoDateSchema, to: isoDateSchema });

/** Daily logs — spec Vol I §2.7 #372-#397. */
export const dailyLogRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("daily_logs", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("daily_logs", "standard"),
  ];

  function parseDateParam(req: { params: unknown }): string {
    const { date } = req.params as { date: string };
    const parsed = isoDateSchema.safeParse(date);
    if (!parsed.success) throw badRequest("Expected an ISO date (YYYY-MM-DD) in the path");
    return parsed.data;
  }

  async function myLog(projectId: string, companyId: string, date: string, userId: string) {
    const rows = await app.db
      .select()
      .from(dailyLogs)
      .where(
        and(
          eq(dailyLogs.companyId, companyId),
          eq(dailyLogs.projectId, projectId),
          eq(dailyLogs.logDate, date),
          eq(dailyLogs.createdBy, userId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  app.put("/projects/:projectId/daily-logs/:date", { preHandler: standardGate }, async (req, reply) => {
    const date = parseDateParam(req);
    const body = upsertSchema.parse(req.body);
    const existing = await myLog(req.projectId!, req.companyId!, date, req.user!.id);
    const now = new Date().toISOString();
    if (existing) {
      if (existing.status !== "draft") {
        throw conflict(`A ${existing.status} daily log can no longer be edited`);
      }
      const set: Record<string, unknown> = { updatedAt: now };
      if (body.sections !== undefined) set["sections"] = body.sections;
      if (body.weather !== undefined) set["weather"] = body.weather;
      if (body.notes !== undefined) set["notes"] = body.notes;
      if (body.photoFileIds !== undefined) set["photoFileIds"] = body.photoFileIds;
      await app.db.update(dailyLogs).set(set).where(eq(dailyLogs.id, existing.id));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "daily_log",
        objectId: existing.id,
        payload: { logDate: date, changed: Object.keys(body) },
      });
      const rows = await app.db
        .select()
        .from(dailyLogs)
        .where(eq(dailyLogs.id, existing.id))
        .limit(1);
      return rows[0];
    }
    const id = newId("dlog");
    const row: typeof dailyLogs.$inferInsert = {
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      logDate: date,
      status: "draft",
      weather: body.weather ?? null,
      sections: body.sections ?? {},
      notes: body.notes ?? null,
      photoFileIds: body.photoFileIds ?? [],
      createdBy: req.user!.id,
    };
    await app.db.insert(dailyLogs).values(row);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "daily_log",
      objectId: id,
      payload: { logDate: date },
    });
    const rows = await app.db.select().from(dailyLogs).where(eq(dailyLogs.id, id)).limit(1);
    return reply.status(201).send(rows[0]);
  });

  app.get("/projects/:projectId/daily-logs", { preHandler: readGate }, async (req) => {
    const q = listQuery.parse(req.query);
    const clauses = [
      eq(dailyLogs.companyId, req.companyId!),
      eq(dailyLogs.projectId, req.projectId!),
    ];
    if (q.from) clauses.push(gte(dailyLogs.logDate, q.from));
    if (q.to) clauses.push(lte(dailyLogs.logDate, q.to));
    if (q.status) clauses.push(eq(dailyLogs.status, q.status));
    if (q.createdBy) clauses.push(eq(dailyLogs.createdBy, q.createdBy));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(dailyLogs).where(where);
    const items = await app.db
      .select()
      .from(dailyLogs)
      .where(where)
      .orderBy(desc(dailyLogs.logDate), asc(dailyLogs.createdBy))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get(
    "/projects/:projectId/daily-logs/missing",
    { preHandler: readGate },
    async (req) => {
      const q = rangeQuery.parse(req.query);
      if (q.from > q.to) throw badRequest("'from' must not be after 'to'");
      const logged = await app.db
        .select({ logDate: dailyLogs.logDate })
        .from(dailyLogs)
        .where(
          and(
            eq(dailyLogs.companyId, req.companyId!),
            eq(dailyLogs.projectId, req.projectId!),
            gte(dailyLogs.logDate, q.from),
            lte(dailyLogs.logDate, q.to),
            inArray(dailyLogs.status, ["submitted", "approved"]),
          ),
        );
      const covered = new Set(logged.map((l) => l.logDate));
      const days: string[] = [];
      let day = q.from;
      let guard = 0;
      while (day <= q.to && guard < 400) {
        if (isBusinessDay(day) && !covered.has(day)) days.push(day);
        day = addDaysISO(day, 1);
        guard += 1;
      }
      if (guard >= 400) throw badRequest("Range too large (max 400 days)");
      return { from: q.from, to: q.to, days };
    },
  );

  app.get("/projects/:projectId/daily-logs/:date", { preHandler: readGate }, async (req) => {
    const date = parseDateParam(req);
    const q = z.object({ createdBy: z.string().optional() }).parse(req.query);
    const clauses = [
      eq(dailyLogs.companyId, req.companyId!),
      eq(dailyLogs.projectId, req.projectId!),
      eq(dailyLogs.logDate, date),
    ];
    if (q.createdBy) clauses.push(eq(dailyLogs.createdBy, q.createdBy));
    const rows = await app.db
      .select()
      .from(dailyLogs)
      .where(and(...clauses))
      .orderBy(asc(dailyLogs.createdAt));
    if (rows.length === 0) throw notFound("No daily log for this date");
    const mine = rows.find((r) => r.createdBy === req.user!.id);
    return { ...(mine ?? rows[0]!), others: rows.length - 1 };
  });

  app.post(
    "/projects/:projectId/daily-logs/:date/submit",
    { preHandler: standardGate },
    async (req) => {
      const date = parseDateParam(req);
      const log = await myLog(req.projectId!, req.companyId!, date, req.user!.id);
      if (!log) throw notFound("You have no daily log for this date");
      if (log.status !== "draft") throw badRequest("Only a draft log can be submitted");
      await app.db
        .update(dailyLogs)
        .set({ status: "submitted", updatedAt: new Date().toISOString() })
        .where(eq(dailyLogs.id, log.id));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "daily_log",
        objectId: log.id,
        payload: { from: "draft", to: "submitted", logDate: date },
      });
      const rows = await app.db.select().from(dailyLogs).where(eq(dailyLogs.id, log.id)).limit(1);
      return rows[0];
    },
  );

  app.post(
    "/projects/:projectId/daily-logs/:date/approve",
    { preHandler: standardGate },
    async (req) => {
      const date = parseDateParam(req);
      const body = z
        .object({ createdBy: z.string().optional() })
        .parse((req.body as object) ?? {});
      const clauses = [
        eq(dailyLogs.companyId, req.companyId!),
        eq(dailyLogs.projectId, req.projectId!),
        eq(dailyLogs.logDate, date),
        eq(dailyLogs.status, "submitted"),
      ];
      if (body.createdBy) clauses.push(eq(dailyLogs.createdBy, body.createdBy));
      const candidates = await app.db
        .select()
        .from(dailyLogs)
        .where(and(...clauses));
      if (candidates.length === 0) throw notFound("No submitted daily log for this date");
      if (candidates.length > 1) {
        throw badRequest("Multiple submitted logs for this date — pass createdBy");
      }
      const log = candidates[0]!;
      if (log.createdBy === req.user!.id) {
        throw forbidden("A daily log must be approved by someone other than its creator");
      }
      await app.db
        .update(dailyLogs)
        .set({ status: "approved", approvedBy: req.user!.id, updatedAt: new Date().toISOString() })
        .where(eq(dailyLogs.id, log.id));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "daily_log",
        objectId: log.id,
        payload: { from: "submitted", to: "approved", logDate: date },
      });
      await pushNotifications(app.db, [
        {
          companyId: req.companyId!,
          userId: log.createdBy,
          projectId: req.projectId!,
          kind: "status_change",
          title: `Daily log ${date} approved`,
          recordType: "daily_log",
          recordId: log.id,
        },
      ]);
      const rows = await app.db.select().from(dailyLogs).where(eq(dailyLogs.id, log.id)).limit(1);
      return rows[0];
    },
  );
};
