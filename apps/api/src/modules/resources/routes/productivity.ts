/**
 * PRODUCTIVITY, HOURS FORECASTING AND THE MEASURED MILE (spec Vol I
 * #691–699).
 *
 * The hours come from `timecard_allocations` — coded labour carrying an
 * installed quantity — because that is the only place on the platform where
 * an hour is attached both to a cost code and to something built. This module
 * reads them; it does not restate them and it creates no second hours table.
 *
 * SNAPSHOTS EXIST BECAUSE THE LIVE FIGURE MOVES. Correcting an old timecard
 * silently rewrites last month's productivity, so a measured-mile argument
 * rests on numbers that were captured, dated and kept.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, gte, lte } from "drizzle-orm";
import { resourceForecasts, resourceProductivitySnapshots } from "@constructos/db";
import type { HoursForecastMethod, ProductivityScope } from "@constructos/shared";
import { newId } from "../../../lib/ids.js";
import { badRequest } from "../../../lib/errors.js";
import { pageOffset, paginate } from "../../../lib/pagination.js";
import { measuredMile } from "../engines/productivity.js";
import {
  buildProductivityReport,
  computeHoursForecast,
  writeProductivitySnapshots,
} from "../service.js";
import {
  actorOf,
  companyOf,
  ledgerResources,
  projectOf,
  requireTypeForProject,
  resourceGates,
  todayIso,
} from "../shared.js";
import * as S from "../schemas.js";

export const productivityRoutes: FastifyPluginAsync = async (app) => {
  const gates = resourceGates(app);

  app.get("/projects/:projectId/resources/productivity", { preHandler: gates.read }, async (req) => {
    const q = S.productivityQuery.parse(req.query);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    if (q.resourceTypeId) await requireTypeForProject(app.db, q.resourceTypeId, companyId, projectId);
    const { report, window, reasons } = await buildProductivityReport(
      app.db,
      companyId,
      projectId,
      q,
    );
    return { window, ...report, reasons };
  });

  /* ================================================================== */
  /* Snapshots                                                           */
  /* ================================================================== */

  app.post(
    "/projects/:projectId/resources/productivity/snapshot",
    { preHandler: gates.standard },
    async (req, reply) => {
      const body = S.snapshotCreateSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      if (body.to < body.from) throw badRequest("`to` must not precede `from`");
      const { report, window, reasons } = await buildProductivityReport(app.db, companyId, projectId, {
        from: body.from,
        to: body.to,
      });
      const scopes: ProductivityScope[] = body.scopes ?? ["project", "resource_type", "crew"];
      const ids = await writeProductivitySnapshots(
        app.db,
        companyId,
        projectId,
        window,
        report,
        scopes,
        body.includeWeeks ?? true,
        actorOf(req),
      );
      await ledgerResources(
        app.db,
        req,
        "create",
        "resource_productivity_snapshot",
        ids[0] ?? projectId,
        {
          periodStart: window.from,
          periodEnd: window.to,
          rows: ids.length,
          actualHours: report.totals.actualHours,
          earnedHours: report.totals.earnedHours,
          productivityFactor: report.totals.productivityFactor,
        },
      );
      return reply
        .status(201)
        .send({ window, rowsWritten: ids.length, totals: report.totals, reasons });
    },
  );

  app.get(
    "/projects/:projectId/resources/productivity/snapshots",
    { preHandler: gates.read },
    async (req) => {
      const q = S.snapshotListQuery.parse(req.query);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const clauses = [
        eq(resourceProductivitySnapshots.companyId, companyId),
        eq(resourceProductivitySnapshots.projectId, projectId),
      ];
      if (q.scope) clauses.push(eq(resourceProductivitySnapshots.scope, q.scope));
      if (q.scopeId) clauses.push(eq(resourceProductivitySnapshots.scopeId, q.scopeId));
      if (q.from) clauses.push(gte(resourceProductivitySnapshots.periodEnd, q.from));
      if (q.to) clauses.push(lte(resourceProductivitySnapshots.periodStart, q.to));
      const where = and(...clauses);
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(resourceProductivitySnapshots)
        .where(where);
      const rows = await app.db
        .select()
        .from(resourceProductivitySnapshots)
        .where(where)
        .orderBy(
          desc(resourceProductivitySnapshots.periodEnd),
          asc(resourceProductivitySnapshots.scope),
        )
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(rows, Number(totalRow?.n ?? 0), q);
    },
  );

  /* ================================================================== */
  /* Measured mile                                                       */
  /* ================================================================== */

  app.get("/projects/:projectId/resources/measured-mile", { preHandler: gates.read }, async (req) => {
    const q = S.measuredMileQuery.parse(req.query);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    if (q.resourceTypeId) await requireTypeForProject(app.db, q.resourceTypeId, companyId, projectId);
    const { report, window, reasons } = await buildProductivityReport(
      app.db,
      companyId,
      projectId,
      q,
    );
    const result = measuredMile(
      report.weeks.map((w) => ({
        weekStart: w.weekStart,
        actualHours: w.actualHours,
        earnedHours: w.earnedHours,
        productivityFactor: w.productivityFactor,
      })),
      q.minWeeks ? { minWeeks: q.minWeeks } : {},
    );
    return {
      window,
      scope: { resourceTypeId: q.resourceTypeId ?? null, crewId: q.crewId ?? null },
      weeks: report.weeks.map((w) => ({
        weekStart: w.weekStart,
        actualHours: w.actualHours,
        earnedHours: w.earnedHours,
        productivityFactor: w.productivityFactor,
        reasons: w.reasons,
      })),
      ...result,
      forensicsNote:
        "This is the arithmetic of a measured-mile comparison, not a finding of causation. The " +
        "cause of the disruption is evidenced in the forensics module; this quantifies it only " +
        "once that link is made.",
      reasons: [...reasons, ...result.reasons],
    };
  });

  /* ================================================================== */
  /* Hours at completion                                                 */
  /* ================================================================== */

  /** Compute a forecast without keeping it — the "what would it say" call. */
  app.get("/projects/:projectId/resources/forecast", { preHandler: gates.read }, async (req) => {
    const q = S.forecastQuery.parse(req.query);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    if (q.resourceTypeId) await requireTypeForProject(app.db, q.resourceTypeId, companyId, projectId);
    const computed = await computeHoursForecast(app.db, companyId, projectId, {
      method: q.method ?? "productivity_factor",
      ...(q.from ? { from: q.from } : {}),
      ...(q.to ? { to: q.to } : {}),
      resourceTypeId: q.resourceTypeId ?? null,
    });
    const history = await app.db
      .select()
      .from(resourceForecasts)
      .where(
        and(
          eq(resourceForecasts.companyId, companyId),
          eq(resourceForecasts.projectId, projectId),
          ...(q.resourceTypeId ? [eq(resourceForecasts.resourceTypeId, q.resourceTypeId)] : []),
        ),
      )
      .orderBy(desc(resourceForecasts.asOfDate), desc(resourceForecasts.createdAt))
      .limit(24);
    return { ...computed, history };
  });

  /** Keep it. "What did we think in March" is the only way a forecast can
   *  ever be shown to have been optimistic. */
  app.post(
    "/projects/:projectId/resources/forecast",
    { preHandler: gates.standard },
    async (req, reply) => {
      const body = S.forecastCreateSchema.parse(req.body ?? {});
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      if (body.resourceTypeId) {
        await requireTypeForProject(app.db, body.resourceTypeId, companyId, projectId);
      }
      const method: HoursForecastMethod = body.method ?? "productivity_factor";
      if (method === "manual" && (body.manualForecastHours ?? null) === null) {
        throw badRequest(
          "A manual forecast needs a figure and a basis. A method named `manual` with no number is " +
            "an opinion nobody can check.",
        );
      }
      const computed = await computeHoursForecast(app.db, companyId, projectId, {
        method,
        ...(body.from ? { from: body.from } : {}),
        ...(body.to ? { to: body.to } : {}),
        resourceTypeId: body.resourceTypeId ?? null,
        manualForecastHours: body.manualForecastHours ?? null,
      });
      const id = newId("rfc");
      const asOf = todayIso();
      await app.db.insert(resourceForecasts).values({
        id,
        companyId,
        projectId,
        resourceTypeId: body.resourceTypeId ?? null,
        asOfDate: asOf,
        method,
        budgetHours: computed.forecast.budgetHours,
        actualHours: computed.forecast.actualHours,
        earnedHours: computed.forecast.earnedHours,
        productivityFactor: computed.forecast.productivityFactor,
        percentComplete: computed.forecast.percentComplete,
        remainingHours: computed.forecast.remainingHours,
        forecastHoursAtCompletion: computed.forecast.forecastHoursAtCompletion,
        varianceHours: computed.forecast.varianceHours,
        confidence: body.confidence ?? computed.forecast.confidence,
        basis: body.basis ?? computed.forecast.basis,
        reasons: computed.forecast.reasons,
        inputs: {
          window: computed.window,
          resourceTypeId: body.resourceTypeId ?? null,
          method,
        },
        createdBy: actorOf(req),
      });
      await ledgerResources(app.db, req, "create", "resource_forecast", id, {
        method,
        asOfDate: asOf,
        forecastHoursAtCompletion: computed.forecast.forecastHoursAtCompletion,
        varianceHours: computed.forecast.varianceHours,
        resourceTypeId: body.resourceTypeId ?? null,
      });
      const [created] = await app.db
        .select()
        .from(resourceForecasts)
        .where(eq(resourceForecasts.id, id));
      return reply.status(201).send({ ...created, reasons: computed.reasons });
    },
  );
};
