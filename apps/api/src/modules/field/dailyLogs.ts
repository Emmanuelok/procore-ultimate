/**
 * Daily logs — spec Vol I §2.7 #372–#397.
 *
 * Covers: one log per (project, date, creator) with GC and subcontractor
 * self-reported kinds (#396); weather auto-capture from a provider adapter
 * with manual override and honest provenance (#373); every section of the
 * diary (#382–#389) saved by KEY-LEVEL MERGE so a page that renders four
 * sections cannot wipe the other seven (audit: DailyLogsPage.tsx:281);
 * templates and carry-forward (#397); submit → approve by a different,
 * admin-level user with distribution (#392–#393); the consolidated
 * site-day view (#392); missing-log detection and per-creator compliance
 * (#395); printable HTML export; and an owner-side reconciliation of
 * logged manpower hours against the timecards register that raises a
 * signal when the two disagree.
 *
 * Deliberately NOT here: the AI daily-log drafter (modules/ai, which writes
 * a draft this file then normalises) and PDF rasterisation (the HTML export
 * prints cleanly; a PDF pipeline is the documents module's concern).
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { dailyLogTemplates, dailyLogs, projects, signals, timecards, users, vendors } from "@constructos/db";
import { DAILY_LOG_KINDS } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { pushNotifications } from "../notifications/service.js";
import { addDaysISO, isBusinessDay, isoDateSchema, todayISO } from "./dates.js";
import { assertCompanyUsers, assertVendor, hasToolAdmin, isCompanyAdmin } from "./access.js";
import {
  SECTION_KEYS,
  applyTemplate,
  businessDaysBetween,
  carryForwardSections,
  complianceByCreator,
  consolidateLogs,
  mergeSections,
  normaliseAiSections,
  reconcileHours,
  renderDailyLogHtml,
} from "./dailyLogEngine.js";
import { fetchHistoricalWeather } from "./weather.js";
import { loadFieldSettings } from "./settings.js";
import { actorOf, nowIso } from "./shared.js";

/* ------------------------------------------------------------------ */
/* Section schemas (#382–#389)                                         */
/* ------------------------------------------------------------------ */

const manpowerRow = z.object({
  company: z.string().min(1).max(200),
  workers: z.number().int().min(0),
  hours: z.number().min(0),
  trade: z.string().max(100).optional(),
  notes: z.string().max(1000).optional(),
});
const equipmentRow = z.object({
  name: z.string().min(1).max(200),
  hoursOperating: z.number().min(0),
  hoursIdle: z.number().min(0),
  notes: z.string().max(500).optional(),
});
const deliveryRow = z.object({
  supplier: z.string().min(1).max(200),
  description: z.string().min(1).max(1000),
  trackingRef: z.string().max(200).optional(),
  time: z.string().max(10).optional(),
});
const visitorRow = z.object({
  name: z.string().min(1).max(200),
  company: z.string().max(200).optional(),
  reason: z.string().max(500).optional(),
  time: z.string().max(10).optional(),
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
const inspectionRow = z.object({
  inspector: z.string().min(1).max(200),
  agency: z.string().max(200).optional(),
  subject: z.string().min(1).max(500),
  outcome: z.enum(["pass", "fail", "partial", "pending"]).optional(),
  notes: z.string().max(2000).optional(),
});
const safetyViolationRow = z.object({
  subject: z.string().min(1).max(300),
  description: z.string().max(2000).optional(),
  issuedTo: z.string().max(200).optional(),
  time: z.string().max(10).optional(),
});
const incidentRow = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(2000).optional(),
  /** safety_incidents.id when the incident was raised in the safety module */
  incidentId: z.string().max(60).optional(),
  time: z.string().max(10).optional(),
});
const wasteRow = z.object({
  material: z.string().min(1).max(200),
  qty: z.number().min(0),
  unit: z.string().min(1).max(50),
  disposal: z.string().max(200).optional(),
});
const callRow = z.object({
  with: z.string().min(1).max(200),
  subject: z.string().min(1).max(300),
  summary: z.string().max(2000).optional(),
  time: z.string().max(10).optional(),
});

/** Every section is optional; `null` clears it; absent leaves it untouched. */
const sectionsSchema = z.object({
  manpower: z.array(manpowerRow).max(200).nullable().optional(),
  equipment: z.array(equipmentRow).max(200).nullable().optional(),
  deliveries: z.array(deliveryRow).max(200).nullable().optional(),
  visitors: z.array(visitorRow).max(200).nullable().optional(),
  delays: z.array(delayRow).max(200).nullable().optional(),
  quantities: z.array(quantityRow).max(200).nullable().optional(),
  inspections: z.array(inspectionRow).max(200).nullable().optional(),
  safetyViolations: z.array(safetyViolationRow).max(200).nullable().optional(),
  incidents: z.array(incidentRow).max(200).nullable().optional(),
  waste: z.array(wasteRow).max(200).nullable().optional(),
  calls: z.array(callRow).max(200).nullable().optional(),
});

const weatherSchema = z.object({
  tempC: z.number().min(-80).max(70).optional(),
  tempMinC: z.number().min(-80).max(70).optional(),
  tempMaxC: z.number().min(-80).max(70).optional(),
  conditions: z.string().max(200).optional(),
  windKph: z.number().min(0).optional(),
  precipitationMm: z.number().min(0).optional(),
});

const upsertSchema = z.object({
  sections: sectionsSchema.optional(),
  weather: weatherSchema.nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  photoFileIds: z.array(z.string()).max(200).optional(),
  logKind: z.enum(DAILY_LOG_KINDS).optional(),
  vendorId: z.string().nullable().optional(),
  /** apply this template's default rows on first save */
  templateId: z.string().optional(),
});

const listQuery = pageQuerySchema.extend({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  status: z.enum(["draft", "submitted", "approved"]).optional(),
  createdBy: z.string().optional(),
  logKind: z.enum(DAILY_LOG_KINDS).optional(),
});

const rangeQuery = z.object({ from: isoDateSchema, to: isoDateSchema });

const templateSchema = z.object({
  name: z.string().min(1).max(200),
  sections: sectionsSchema.optional(),
  isDefault: z.boolean().optional(),
});

const byCreatorQuery = z.object({ createdBy: z.string().optional() });

const approveSchema = z.object({ createdBy: z.string().optional(), logId: z.string().optional() });

export const dailyLogRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("daily_logs", "read")];
  const standardGate = [app.authenticate, app.requireCompany, app.requireTool("daily_logs", "standard")];
  const adminGate = [app.authenticate, app.requireCompany, app.requireTool("daily_logs", "admin")];

  const weatherEnabled = app.appConfig.NODE_ENV !== "test";

  function parseDateParam(req: { params: unknown }): string {
    const { date } = req.params as { date: string };
    const parsed = isoDateSchema.safeParse(date);
    if (!parsed.success) throw badRequest("Expected an ISO date (YYYY-MM-DD) in the path");
    return parsed.data;
  }

  function scope(req: FastifyRequest) {
    return and(eq(dailyLogs.companyId, req.companyId!), eq(dailyLogs.projectId, req.projectId!));
  }

  async function logsForDate(req: FastifyRequest, date: string) {
    return app.db
      .select()
      .from(dailyLogs)
      .where(and(scope(req), eq(dailyLogs.logDate, date)))
      .orderBy(asc(dailyLogs.createdAt));
  }

  async function myLog(req: FastifyRequest, date: string) {
    const rows = await app.db
      .select()
      .from(dailyLogs)
      .where(and(scope(req), eq(dailyLogs.logDate, date), eq(dailyLogs.createdBy, req.user!.id)))
      .limit(1);
    return rows[0];
  }

  async function byId(id: string) {
    return (await app.db.select().from(dailyLogs).where(eq(dailyLogs.id, id)).limit(1))[0];
  }

  async function ledgerLog(
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
      objectType: "daily_log",
      objectId: id,
      payload,
      storePayload,
      projectId: req.projectId!,
    });
  }

  async function projectCoords(req: FastifyRequest) {
    const row = (
      await app.db
        .select({ name: projects.name, latitude: projects.latitude, longitude: projects.longitude })
        .from(projects)
        .where(and(eq(projects.id, req.projectId!), eq(projects.companyId, req.companyId!)))
        .limit(1)
    )[0];
    return row ?? { name: "Project", latitude: null, longitude: null };
  }

  /** Try the provider; returns the fields to set, or null with a reason. */
  async function captureWeather(req: FastifyRequest, date: string) {
    const coords = await projectCoords(req);
    if (coords.latitude === null || coords.longitude === null) {
      return { set: null, reason: "Project has no latitude/longitude — set them on the project to enable auto-capture" };
    }
    const captured = await fetchHistoricalWeather(
      { latitude: coords.latitude, longitude: coords.longitude, date },
      { enabled: weatherEnabled },
    );
    if (!captured) {
      return {
        set: null,
        reason: weatherEnabled
          ? "The weather provider did not return an observation for this date"
          : "Weather auto-capture is disabled in this environment",
      };
    }
    return {
      set: {
        weather: { ...captured.observation } as Record<string, unknown>,
        weatherSource: "auto",
        weatherProvider: captured.provider,
        weatherFetchedAt: captured.fetchedAt,
      },
      reason: null,
    };
  }

  function summary(row: typeof dailyLogs.$inferSelect) {
    return {
      id: row.id,
      createdBy: row.createdBy,
      status: row.status,
      logKind: row.logKind,
      vendorId: row.vendorId,
      aiDrafted: row.aiDrafted,
      updatedAt: row.updatedAt,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Upsert (merge)                                                    */
  /* ---------------------------------------------------------------- */

  app.put("/projects/:projectId/daily-logs/:date", { preHandler: standardGate }, async (req, reply) => {
    const date = parseDateParam(req);
    if (date > todayISO()) throw badRequest("A daily log cannot be written for a future date");
    const body = upsertSchema.parse(req.body);
    await assertVendor(app.db, req.companyId!, body.vendorId);
    if (body.logKind === "subcontractor" && !body.vendorId) {
      throw badRequest("A subcontractor self-reported log must name its vendor");
    }
    const existing = await myLog(req, date);
    const now = nowIso();
    const incoming = (body.sections ?? {}) as Record<string, unknown>;

    if (existing) {
      if (existing.status !== "draft") {
        throw conflict(`A ${existing.status} daily log can no longer be edited`);
      }
      const set: Record<string, unknown> = { updatedAt: now };
      if (body.sections !== undefined) {
        // AI-drafted logs may carry legacy row shapes; normalise before merging.
        const base = existing.aiDrafted === 1 ? normaliseAiSections(existing.sections) : existing.sections;
        set["sections"] = mergeSections(base, incoming);
      }
      if (body.weather !== undefined) {
        set["weather"] = body.weather;
        set["weatherSource"] = body.weather ? "manual" : null;
        set["weatherProvider"] = null;
        set["weatherFetchedAt"] = null;
      }
      if (body.notes !== undefined) set["notes"] = body.notes;
      if (body.photoFileIds !== undefined) set["photoFileIds"] = body.photoFileIds;
      if (body.logKind !== undefined) set["logKind"] = body.logKind;
      if (body.vendorId !== undefined) set["vendorId"] = body.vendorId;
      await app.db.update(dailyLogs).set(set).where(eq(dailyLogs.id, existing.id));
      await ledgerLog("update", existing.id, req, {
        logDate: date,
        changed: Object.keys(body),
        sectionsTouched: Object.keys(incoming),
      });
      return byId(existing.id);
    }

    // First save: template underneath, then weather auto-capture when nothing manual came in.
    let sections = normaliseAiSections(incoming);
    let templateId: string | null = null;
    const template = body.templateId
      ? (
          await app.db
            .select()
            .from(dailyLogTemplates)
            .where(and(eq(dailyLogTemplates.id, body.templateId), eq(dailyLogTemplates.companyId, req.companyId!), eq(dailyLogTemplates.projectId, req.projectId!)))
            .limit(1)
        )[0]
      : (
          await app.db
            .select()
            .from(dailyLogTemplates)
            .where(and(eq(dailyLogTemplates.companyId, req.companyId!), eq(dailyLogTemplates.projectId, req.projectId!), eq(dailyLogTemplates.isDefault, 1)))
            .limit(1)
        )[0];
    if (body.templateId && !template) throw badRequest("Unknown daily-log template for this project");
    if (template) {
      sections = applyTemplate(template.sections, sections);
      templateId = template.id;
    }

    const settings = await loadFieldSettings(app.db, req.companyId!, req.projectId!);
    let weatherFields: Record<string, unknown> = {
      weather: body.weather ?? null,
      weatherSource: body.weather ? "manual" : null,
      weatherProvider: null,
      weatherFetchedAt: null,
    };
    if (!body.weather && settings.dailyLog.weatherAuto) {
      const captured = await captureWeather(req, date);
      if (captured.set) weatherFields = captured.set;
    }

    const id = newId("dlog");
    await app.db.insert(dailyLogs).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      logDate: date,
      status: "draft",
      sections,
      notes: body.notes ?? null,
      photoFileIds: body.photoFileIds ?? [],
      logKind: body.logKind ?? "internal",
      vendorId: body.vendorId ?? null,
      templateId,
      createdBy: req.user!.id,
      ...(weatherFields as {
        weather: Record<string, unknown> | null;
        weatherSource: string | null;
        weatherProvider: string | null;
        weatherFetchedAt: string | null;
      }),
    });
    await ledgerLog("create", id, req, {
      logDate: date,
      logKind: body.logKind ?? "internal",
      templateId,
      weatherSource: weatherFields["weatherSource"] ?? null,
    });
    return reply.status(201).send(await byId(id));
  });

  /* ---------------------------------------------------------------- */
  /* Register / missing / compliance                                   */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/daily-logs", { preHandler: readGate }, async (req) => {
    const q = listQuery.parse(req.query);
    const clauses = [scope(req)!];
    if (q.from) clauses.push(gte(dailyLogs.logDate, q.from));
    if (q.to) clauses.push(lte(dailyLogs.logDate, q.to));
    if (q.status) clauses.push(eq(dailyLogs.status, q.status));
    if (q.createdBy) clauses.push(eq(dailyLogs.createdBy, q.createdBy));
    if (q.logKind) clauses.push(eq(dailyLogs.logKind, q.logKind));
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

  app.get("/projects/:projectId/daily-logs/missing", { preHandler: readGate }, async (req) => {
    const q = rangeQuery.parse(req.query);
    if (q.from > q.to) throw badRequest("'from' must not be after 'to'");
    const days = businessDaysBetween(q.from, q.to, 401);
    if (days.length > 400) throw badRequest("Range too large (max 400 days)");
    const logged = await app.db
      .select({ logDate: dailyLogs.logDate })
      .from(dailyLogs)
      .where(and(scope(req), gte(dailyLogs.logDate, q.from), lte(dailyLogs.logDate, q.to), inArray(dailyLogs.status, ["submitted", "approved"])));
    const covered = new Set(logged.map((l) => l.logDate));
    return { from: q.from, to: q.to, days: days.filter((d) => !covered.has(d)) };
  });

  app.get("/projects/:projectId/daily-logs/compliance", { preHandler: readGate }, async (req) => {
    const q = rangeQuery.parse(req.query);
    if (q.from > q.to) throw badRequest("'from' must not be after 'to'");
    if (businessDaysBetween(q.from, q.to, 401).length > 400) throw badRequest("Range too large (max 400 days)");
    const rows = await app.db
      .select({ createdBy: dailyLogs.createdBy, logDate: dailyLogs.logDate, status: dailyLogs.status, logKind: dailyLogs.logKind })
      .from(dailyLogs)
      .where(and(scope(req), gte(dailyLogs.logDate, q.from), lte(dailyLogs.logDate, q.to)));
    const byCreator = complianceByCreator(rows, q.from, q.to);
    const ids = byCreator.map((r) => r.createdBy);
    const names =
      ids.length > 0
        ? await app.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))
        : [];
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    const kindOf = new Map<string, string>();
    for (const r of rows) kindOf.set(r.createdBy, r.logKind);
    return {
      from: q.from,
      to: q.to,
      expectedDays: businessDaysBetween(q.from, q.to).length,
      items: byCreator.map((r) => ({ ...r, name: nameOf.get(r.createdBy) ?? null, logKind: kindOf.get(r.createdBy) ?? "internal" })),
      basis: "Expected = Monday–Friday in the window; submitted = a submitted or approved log on that day; creators who have never logged are not listed",
    };
  });

  /* ---------------------------------------------------------------- */
  /* Templates (#397)                                                  */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/daily-logs/templates", { preHandler: readGate }, async (req) => {
    const items = await app.db
      .select()
      .from(dailyLogTemplates)
      .where(and(eq(dailyLogTemplates.companyId, req.companyId!), eq(dailyLogTemplates.projectId, req.projectId!)))
      .orderBy(desc(dailyLogTemplates.isDefault), asc(dailyLogTemplates.name));
    return { items };
  });

  app.post("/projects/:projectId/daily-logs/templates", { preHandler: standardGate }, async (req, reply) => {
    const body = templateSchema.parse(req.body);
    const id = newId("dlt");
    const sections = mergeSections({}, (body.sections ?? {}) as Record<string, unknown>);
    await app.db.transaction(async (tx) => {
      if (body.isDefault) {
        await tx
          .update(dailyLogTemplates)
          .set({ isDefault: 0, updatedAt: nowIso() })
          .where(and(eq(dailyLogTemplates.companyId, req.companyId!), eq(dailyLogTemplates.projectId, req.projectId!)));
      }
      await tx.insert(dailyLogTemplates).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        name: body.name,
        sections,
        isDefault: body.isDefault ? 1 : 0,
        createdBy: req.user!.id,
      });
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "daily_log_template",
      objectId: id,
      payload: { name: body.name, isDefault: Boolean(body.isDefault) },
      projectId: req.projectId!,
    });
    const created = (await app.db.select().from(dailyLogTemplates).where(eq(dailyLogTemplates.id, id)).limit(1))[0];
    return reply.status(201).send(created);
  });

  app.put("/projects/:projectId/daily-logs/templates/:templateId", { preHandler: standardGate }, async (req) => {
    const { templateId } = req.params as { templateId: string };
    const body = templateSchema.partial().parse(req.body);
    const existing = (
      await app.db
        .select()
        .from(dailyLogTemplates)
        .where(and(eq(dailyLogTemplates.id, templateId), eq(dailyLogTemplates.companyId, req.companyId!), eq(dailyLogTemplates.projectId, req.projectId!)))
        .limit(1)
    )[0];
    if (!existing) throw notFound("Template not found");
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    if (body.name !== undefined) set["name"] = body.name;
    if (body.sections !== undefined) set["sections"] = mergeSections(existing.sections, body.sections as Record<string, unknown>);
    if (body.isDefault !== undefined) set["isDefault"] = body.isDefault ? 1 : 0;
    await app.db.transaction(async (tx) => {
      if (body.isDefault) {
        await tx
          .update(dailyLogTemplates)
          .set({ isDefault: 0 })
          .where(and(eq(dailyLogTemplates.companyId, req.companyId!), eq(dailyLogTemplates.projectId, req.projectId!)));
      }
      await tx.update(dailyLogTemplates).set(set).where(eq(dailyLogTemplates.id, templateId));
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "daily_log_template",
      objectId: templateId,
      payload: { changed: Object.keys(body) },
      projectId: req.projectId!,
    });
    return (await app.db.select().from(dailyLogTemplates).where(eq(dailyLogTemplates.id, templateId)).limit(1))[0];
  });

  app.delete("/projects/:projectId/daily-logs/templates/:templateId", { preHandler: standardGate }, async (req) => {
    const { templateId } = req.params as { templateId: string };
    const deleted = await app.db
      .delete(dailyLogTemplates)
      .where(and(eq(dailyLogTemplates.id, templateId), eq(dailyLogTemplates.companyId, req.companyId!), eq(dailyLogTemplates.projectId, req.projectId!)))
      .returning({ id: dailyLogTemplates.id });
    if (deleted.length === 0) throw notFound("Template not found");
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "daily_log_template",
      objectId: templateId,
      payload: {},
      projectId: req.projectId!,
    });
    return { deleted: true, id: templateId };
  });

  /* ---------------------------------------------------------------- */
  /* One date: mine + who else, consolidated, export, weather          */
  /* ---------------------------------------------------------------- */

  /**
   * The caller's own log for the date (or the creator asked for), never a
   * stranger's draft passed off as editable (audit: DailyLogsPage.tsx:272).
   */
  app.get("/projects/:projectId/daily-logs/:date", { preHandler: readGate }, async (req) => {
    const date = parseDateParam(req);
    const q = byCreatorQuery.parse(req.query);
    const rows = await logsForDate(req, date);
    const me = req.user!.id;
    const wanted = q.createdBy ?? me;
    const log = rows.find((r) => r.createdBy === wanted) ?? null;
    if (q.createdBy && !log) throw notFound("No daily log by that creator for this date");
    return {
      date,
      log,
      isMine: log !== null && log.createdBy === me,
      hasOwn: rows.some((r) => r.createdBy === me),
      logs: rows.map(summary),
    };
  });

  app.get("/projects/:projectId/daily-logs/:date/consolidated", { preHandler: readGate }, async (req) => {
    const date = parseDateParam(req);
    const rows = await logsForDate(req, date);
    const day = consolidateLogs(rows);
    const ids = [...new Set(rows.map((r) => r.createdBy))];
    const names =
      ids.length > 0
        ? await app.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))
        : [];
    return {
      date,
      ...day,
      logs: rows.map(summary),
      people: Object.fromEntries(names.map((n) => [n.id, n.name])),
    };
  });

  app.get("/projects/:projectId/daily-logs/:date/export", { preHandler: readGate }, async (req, reply) => {
    const date = parseDateParam(req);
    const q = byCreatorQuery.parse(req.query);
    const rows = await logsForDate(req, date);
    const log = rows.find((r) => r.createdBy === (q.createdBy ?? req.user!.id)) ?? rows[0];
    if (!log) throw notFound("No daily log for this date");
    const coords = await projectCoords(req);
    const ids = [log.createdBy, log.approvedBy].filter((id): id is string => Boolean(id));
    const names = await app.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
    const nameOf = (id: string | null) => names.find((n) => n.id === id)?.name ?? id ?? "";
    const html = renderDailyLogHtml(
      { ...log, sections: log.aiDrafted === 1 ? normaliseAiSections(log.sections) : log.sections },
      {
        projectName: coords.name,
        creatorName: nameOf(log.createdBy),
        approverName: log.approvedBy ? nameOf(log.approvedBy) : null,
        generatedAt: nowIso(),
      },
    );
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "access",
      objectType: "daily_log",
      objectId: log.id,
      payload: { export: "html", logDate: date },
      projectId: req.projectId!,
    });
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .header("content-disposition", `inline; filename="daily-log-${date}.html"`)
      .send(html);
  });

  /** (Re)capture the weather for my draft; never fabricates — reports the reason instead. */
  app.post("/projects/:projectId/daily-logs/:date/weather", { preHandler: standardGate }, async (req) => {
    const date = parseDateParam(req);
    const log = await myLog(req, date);
    if (!log) throw notFound("You have no daily log for this date — save a draft first");
    if (log.status !== "draft") throw conflict(`A ${log.status} daily log can no longer be edited`);
    const captured = await captureWeather(req, date);
    if (!captured.set) return { captured: false, reason: captured.reason, log };
    await app.db.update(dailyLogs).set({ ...captured.set, updatedAt: nowIso() }).where(eq(dailyLogs.id, log.id));
    await ledgerLog("update", log.id, req, { logDate: date, weather: "auto", provider: captured.set.weatherProvider });
    return { captured: true, reason: null, log: await byId(log.id) };
  });

  /** Seed my draft for the date from the previous submitted/approved day's structure (#397). */
  app.post("/projects/:projectId/daily-logs/:date/carry-forward", { preHandler: standardGate }, async (req, reply) => {
    const date = parseDateParam(req);
    if (date > todayISO()) throw badRequest("A daily log cannot be written for a future date");
    const previous = (
      await app.db
        .select()
        .from(dailyLogs)
        .where(and(scope(req), eq(dailyLogs.createdBy, req.user!.id), sql`${dailyLogs.logDate} < ${date}`, inArray(dailyLogs.status, ["submitted", "approved"])))
        .orderBy(desc(dailyLogs.logDate))
        .limit(1)
    )[0];
    if (!previous) throw notFound("You have no earlier submitted log to carry forward from");
    const carried = carryForwardSections(previous.sections);
    const existing = await myLog(req, date);
    const now = nowIso();
    if (existing) {
      if (existing.status !== "draft") throw conflict(`A ${existing.status} daily log can no longer be edited`);
      const merged = applyTemplate(carried, existing.sections);
      await app.db.update(dailyLogs).set({ sections: merged, updatedAt: now }).where(eq(dailyLogs.id, existing.id));
      await ledgerLog("update", existing.id, req, { logDate: date, carriedForwardFrom: previous.logDate });
      return { from: previous.logDate, log: await byId(existing.id) };
    }
    const id = newId("dlog");
    await app.db.insert(dailyLogs).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      logDate: date,
      status: "draft",
      sections: carried,
      logKind: previous.logKind,
      vendorId: previous.vendorId,
      createdBy: req.user!.id,
    });
    await ledgerLog("create", id, req, { logDate: date, carriedForwardFrom: previous.logDate });
    return reply.status(201).send({ from: previous.logDate, log: await byId(id) });
  });

  /* ---------------------------------------------------------------- */
  /* Lifecycle: submit → approve (+ distribution)                      */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/daily-logs/:date/submit", { preHandler: standardGate }, async (req) => {
    const date = parseDateParam(req);
    const log = await myLog(req, date);
    if (!log) throw notFound("You have no daily log for this date");
    if (log.status !== "draft") throw badRequest("Only a draft log can be submitted");
    const now = nowIso();
    await app.db.update(dailyLogs).set({ status: "submitted", submittedAt: now, updatedAt: now }).where(eq(dailyLogs.id, log.id));
    await ledgerLog("state_change", log.id, req, { from: "draft", to: "submitted", logDate: date });
    const settings = await loadFieldSettings(app.db, req.companyId!, req.projectId!);
    await pushNotifications(
      app.db,
      settings.dailyLog.distribution
        .filter((userId) => userId !== req.user!.id)
        .map((userId) => ({
          companyId: req.companyId!,
          userId,
          projectId: req.projectId!,
          kind: "status_change" as const,
          title: `Daily log ${date} submitted for approval`,
          recordType: "daily_log",
          recordId: log.id,
        })),
    );
    return byId(log.id);
  });

  /**
   * Approval is an admin-level act on the tool (a project manager or a
   * company admin) and never by the log's own creator.
   */
  app.post("/projects/:projectId/daily-logs/:date/approve", { preHandler: adminGate }, async (req) => {
    const date = parseDateParam(req);
    const body = approveSchema.parse((req.body as object) ?? {});
    const clauses = [scope(req)!, eq(dailyLogs.logDate, date), eq(dailyLogs.status, "submitted")];
    if (body.logId) clauses.push(eq(dailyLogs.id, body.logId));
    if (body.createdBy) clauses.push(eq(dailyLogs.createdBy, body.createdBy));
    const candidates = await app.db.select().from(dailyLogs).where(and(...clauses));
    if (candidates.length === 0) throw notFound("No submitted daily log for this date");
    if (candidates.length > 1) throw badRequest("Multiple submitted logs for this date — pass createdBy or logId");
    const log = candidates[0]!;
    if (log.createdBy === req.user!.id) {
      throw forbidden("A daily log must be approved by someone other than its creator");
    }
    const settings = await loadFieldSettings(app.db, req.companyId!, req.projectId!);
    const distributedTo = [...new Set([log.createdBy, ...settings.dailyLog.distribution])].filter((id) => id !== req.user!.id);
    const now = nowIso();
    await app.db
      .update(dailyLogs)
      .set({ status: "approved", approvedBy: req.user!.id, approvedAt: now, distributedTo, updatedAt: now })
      .where(eq(dailyLogs.id, log.id));
    await ledgerLog("state_change", log.id, req, { from: "submitted", to: "approved", logDate: date, distributedTo });
    await pushNotifications(
      app.db,
      distributedTo.map((userId) => ({
        companyId: req.companyId!,
        userId,
        projectId: req.projectId!,
        kind: "status_change" as const,
        title: `Daily log ${date} approved`,
        body: userId === log.createdBy ? undefined : "Distributed on approval per the project's daily-log distribution list.",
        recordType: "daily_log",
        recordId: log.id,
      })),
    );
    return byId(log.id);
  });

  /* ---------------------------------------------------------------- */
  /* Reconciliation — logged manpower vs timecards (owner-side)        */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/daily-logs/:date/reconciliation", { preHandler: readGate }, async (req) => {
    const date = parseDateParam(req);
    const q = byCreatorQuery.parse(req.query);
    return reconcileDate(req, date, q.createdBy, false);
  });

  app.post("/projects/:projectId/daily-logs/:date/reconcile", { preHandler: standardGate }, async (req) => {
    const date = parseDateParam(req);
    const body = byCreatorQuery.parse((req.body as object) ?? {});
    const admin = isCompanyAdmin(req.companyRole) || (await hasToolAdmin(app, actorOf(req), req.projectId!, "daily_logs"));
    if (!admin) throw forbidden("Raising reconciliation signals requires admin access to daily logs");
    return reconcileDate(req, date, body.createdBy, true);
  });

  async function reconcileDate(req: FastifyRequest, date: string, createdBy: string | undefined, raise: boolean) {
    const rows = await logsForDate(req, date);
    const counted = rows.filter((r) => (r.status === "submitted" || r.status === "approved") && (!createdBy || r.createdBy === createdBy));
    const settings = await loadFieldSettings(app.db, req.companyId!, req.projectId!);
    const logged = new Map<string, number>();
    for (const log of counted) {
      const manpower = Array.isArray(log.sections["manpower"]) ? (log.sections["manpower"] as unknown[]) : [];
      for (const raw of manpower) {
        if (!raw || typeof raw !== "object") continue;
        const row = raw as Record<string, unknown>;
        const key = String(row["company"] ?? "").trim().toLowerCase() || "unknown";
        const hours = Number(row["hours"]);
        logged.set(key, (logged.get(key) ?? 0) + (Number.isFinite(hours) ? hours : 0));
      }
    }
    const cards = await app.db
      .select({ vendorId: timecards.vendorId, hours: sql<number>`coalesce(sum(${timecards.totalHours}), 0)`, n: count() })
      .from(timecards)
      .where(and(eq(timecards.companyId, req.companyId!), eq(timecards.projectId, req.projectId!), eq(timecards.workDate, date), sql`${timecards.status} not in ('void', 'rejected')`))
      .groupBy(timecards.vendorId);
    if (cards.length === 0) {
      return {
        date,
        logs: counted.length,
        thresholdPct: settings.dailyLog.reconciliationThresholdPct,
        variances: [],
        signalsRaised: 0,
        reasons: ["No timecards recorded for this date — there is nothing independent to reconcile the log against"],
      };
    }
    const vendorIds = cards.map((c) => c.vendorId).filter((v): v is string => Boolean(v));
    const vendorRows =
      vendorIds.length > 0
        ? await app.db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(inArray(vendors.id, vendorIds))
        : [];
    const vendorName = new Map(vendorRows.map((v) => [v.id, v.name.trim().toLowerCase()]));
    const tc = new Map<string, number>();
    for (const c of cards) {
      const key = c.vendorId ? (vendorName.get(c.vendorId) ?? c.vendorId) : "own workforce";
      tc.set(key, (tc.get(key) ?? 0) + Number(c.hours));
    }
    const variances = reconcileHours(logged, tc, settings.dailyLog.reconciliationThresholdPct);
    let signalsRaised = 0;
    if (raise) {
      for (const v of variances.filter((x) => x.flagged)) {
        const key = `daily_log_manpower:${req.projectId!}:${date}:${v.key}`;
        const existing = await app.db
          .select({ id: signals.id })
          .from(signals)
          .where(and(eq(signals.companyId, req.companyId!), eq(signals.detector, "field_daily_log_manpower_variance"), sql`${signals.evidenceRefs}->>'key' = ${key}`))
          .limit(1);
        if (existing.length > 0) continue;
        const id = newId("sig");
        await app.db.insert(signals).values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          detector: "field_daily_log_manpower_variance",
          severity: Math.abs(v.variancePct ?? 100) > 50 ? "high" : "medium",
          confidence: 0.7,
          title: `Daily log ${date}: ${v.key} logged ${v.loggedHours}h vs ${v.timecardHours}h on timecards`,
          explanation: `The site diary claims ${v.loggedHours} labour hours for "${v.key}" on ${date}; the timecards register carries ${v.timecardHours}h (${v.variancePct === null ? "no timecards" : `${v.variancePct}% variance`}). The diary is a claim and the timecards are the evidence; the gap exceeds the ${settings.dailyLog.reconciliationThresholdPct}% tolerance and needs an explanation before the day's labour is certified.`,
          evidenceRefs: { key, date, logIds: counted.map((l) => l.id), vendorKey: v.key, loggedHours: v.loggedHours, timecardHours: v.timecardHours },
        });
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "create",
          objectType: "signal",
          objectId: id,
          payload: { detector: "field_daily_log_manpower_variance", key },
          projectId: req.projectId!,
        });
        signalsRaised += 1;
      }
    }
    return {
      date,
      logs: counted.length,
      thresholdPct: settings.dailyLog.reconciliationThresholdPct,
      variances,
      signalsRaised,
      reasons: [] as string[],
      basis: "Logged hours are summed from the manpower section of every submitted/approved log for the date, keyed by company name; timecard hours are summed by the worker's vendor for the same work date (void/rejected excluded)",
    };
  }

  /** Section keys the API understands — exported for the UI so it never invents a section. */
  app.get("/projects/:projectId/daily-logs/meta", { preHandler: readGate }, async () => {
    return { sectionKeys: SECTION_KEYS, businessDaysOnly: true, isBusinessDayToday: isBusinessDay(todayISO()), nextDay: addDaysISO(todayISO(), 1) };
  });
};
