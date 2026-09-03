/**
 * The workspace header and the platform's health feed.
 *
 * `GET /projects/:id/resources/summary` is the one cheap read the page opens
 * with: the live plan, the next shortfall, the current productivity factor,
 * open conflicts and expiring tickets. Every figure is nullable with a
 * reason, because a resourcing page that shows zeros for a project nobody has
 * planned yet reads as "fully resourced" — the opposite of the truth.
 *
 * `GET /projects/:id/resources/health-inputs` is the shape the intelligence
 * layer consumes (master plan §3.5): a flat map of metrics, each `number` or
 * `null`, plus the reasons for the nulls.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, gte, inArray, lte } from "drizzle-orm";
import {
  resourceAssignments,
  resourceAvailability,
  resourceDemands,
  resourceForecasts,
  resourcePlans,
  resourceProductivitySnapshots,
  resourceSkills,
  resourceTypes,
  workerSkills,
  workers,
} from "@constructos/db";
import { ACTIVE_ASSIGNMENT_STATUSES, RESOURCE_DETECTORS } from "@constructos/shared";
import { addDays, enumerateWeeks, weekStartOf } from "../engines/calendar.js";
import { buildHistogram, type HistogramType } from "../engines/histogram.js";
import { detectAssignmentConflicts, type AssignmentWindow } from "../engines/conflicts.js";
import { classifyValidity, EXPIRY_WARN_DAYS } from "../engines/skills.js";
import { buildProductivityReport } from "../service.js";
import {
  companyOf,
  openResourceSignals,
  projectOf,
  resourceGates,
  standardWorkingDaysPerWeek,
  todayIso,
  visibleProjectIds,
  workPatternFor,
} from "../shared.js";
import {
  runResourceSweeps,
  sweepAssignmentConflicts,
  sweepCertificationExpiry,
  sweepPlanCoverage,
  sweepProductivity,
} from "../sweeps.js";
import * as S from "../schemas.js";

/** How far ahead the summary looks for the next shortfall. */
const HORIZON_WEEKS = 13;

export const summaryRoutes: FastifyPluginAsync = async (app) => {
  const gates = resourceGates(app);

  async function snapshot(companyId: string, projectId: string) {
    const today = todayIso();
    const horizonEnd = addDays(today, HORIZON_WEEKS * 7);

    const planRows = await app.db
      .select()
      .from(resourcePlans)
      .where(
        and(
          eq(resourcePlans.companyId, companyId),
          eq(resourcePlans.projectId, projectId),
          eq(resourcePlans.status, "active"),
          eq(resourcePlans.planKind, "current"),
        ),
      )
      .limit(1);
    const plan = planRows[0] ?? null;
    const reasons: string[] = [];
    if (!plan) {
      reasons.push(
        "No active resource plan exists on this project, so demand, coverage and the peak are not " +
          "computable. They are unknown, not zero.",
      );
    }

    /* ---------------- coverage ---------------- */
    let overWeeks: number | null = null;
    let unknownSupplyWeeks: number | null = null;
    let worstShortfall: {
      weekStart: string;
      resourceTypeId: string;
      resourceTypeName: string;
      shortfallHours: number;
      demandHours: number;
      availableHours: number | null;
    } | null = null;
    let peakDemandHours: number | null = null;
    let peakWeekStart: string | null = null;

    if (plan) {
      const weekStart = weekStartOf(today, plan.weekStartsOn);
      const weeks = enumerateWeeks(weekStart, horizonEnd, plan.weekStartsOn);
      const demand = await app.db
        .select({
          resourceTypeId: resourceDemands.resourceTypeId,
          weekStart: resourceDemands.weekStart,
          demandHours: resourceDemands.demandHours,
          sourceTaskId: resourceDemands.sourceTaskId,
        })
        .from(resourceDemands)
        .where(
          and(
            eq(resourceDemands.planId, plan.id),
            gte(resourceDemands.weekStart, weekStart),
            lte(resourceDemands.weekStart, horizonEnd),
          ),
        );
      const supply = await app.db
        .select({
          resourceTypeId: resourceAvailability.resourceTypeId,
          weekStart: resourceAvailability.weekStart,
          availableHours: resourceAvailability.availableHours,
          availableHeadcount: resourceAvailability.availableHeadcount,
          source: resourceAvailability.source,
        })
        .from(resourceAvailability)
        .where(
          and(
            eq(resourceAvailability.companyId, companyId),
            eq(resourceAvailability.projectId, projectId),
            gte(resourceAvailability.weekStart, weekStart),
            lte(resourceAvailability.weekStart, horizonEnd),
          ),
        );
      const typeRows = await app.db
        .select()
        .from(resourceTypes)
        .where(eq(resourceTypes.companyId, companyId));
      const types: HistogramType[] = typeRows
        .filter((t) => t.projectId === null || t.projectId === projectId)
        .map((t) => ({
          id: t.id,
          code: t.code,
          name: t.name,
          kind: t.kind,
          unit: t.unit,
          standardHoursPerDay: t.standardHoursPerDay,
          workingDaysPerWeek: t.workingDaysPerWeek,
        }));
      const { pattern } = await workPatternFor(app.db, companyId, projectId);
      const histogram = buildHistogram({
        weeks,
        types,
        demand,
        supply,
        workingDaysPerWeek: standardWorkingDaysPerWeek(pattern),
      });
      overWeeks = histogram.totals.overAllocatedCells;
      unknownSupplyWeeks = histogram.totals.unknownSupplyCells;
      peakDemandHours = histogram.totals.peakDemandHours;
      peakWeekStart = histogram.totals.peakWeekStart;
      for (const series of histogram.series) {
        for (const cell of series.cells) {
          if (cell.state !== "over") continue;
          const shortfall = cell.overAllocationHours ?? cell.demandHours;
          if (!worstShortfall || shortfall > worstShortfall.shortfallHours) {
            worstShortfall = {
              weekStart: cell.weekStart,
              resourceTypeId: cell.resourceTypeId,
              resourceTypeName: series.resourceType.name,
              shortfallHours: shortfall,
              demandHours: cell.demandHours,
              availableHours: cell.availableHours,
            };
          }
        }
      }
      if (unknownSupplyWeeks > 0) {
        reasons.push(
          `${unknownSupplyWeeks} trade-week(s) in the next quarter have no recorded availability, ` +
            "so their coverage is unknown rather than short.",
        );
      }
    }

    /* ---------------- bookings ---------------- */
    const bookings = await app.db
      .select()
      .from(resourceAssignments)
      .where(
        and(
          eq(resourceAssignments.companyId, companyId),
          eq(resourceAssignments.projectId, projectId),
          inArray(resourceAssignments.status, [...ACTIVE_ASSIGNMENT_STATUSES]),
          gte(resourceAssignments.toDate, today),
        ),
      )
      .limit(5000);
    const windows: AssignmentWindow[] = bookings.map((a) => ({
      id: a.id,
      reference: a.reference,
      subjectKind: a.subjectKind,
      subjectId: a.crewId ?? a.workerId ?? a.equipmentId ?? a.id,
      subjectLabel: a.subjectLabel,
      fromDate: a.fromDate,
      toDate: a.toDate,
      status: a.status,
      allocationPercent: a.allocationPercent,
      hoursPerDay: a.hoursPerDay,
      scheduleTaskId: a.scheduleTaskId,
    }));
    const conflicts = detectAssignmentConflicts(windows);

    /* ---------------- certifications ---------------- */
    const [workerCount] = await app.db
      .select({ n: count() })
      .from(workers)
      .where(and(eq(workers.companyId, companyId), eq(workers.projectId, projectId)));
    const certRows = await app.db
      .select({
        expiresAt: workerSkills.expiresAt,
        status: workerSkills.status,
        isMandatory: resourceSkills.isMandatory,
      })
      .from(workerSkills)
      .innerJoin(resourceSkills, eq(resourceSkills.id, workerSkills.skillId))
      .where(
        and(eq(workerSkills.companyId, companyId), eq(workerSkills.projectId, projectId)),
      )
      .limit(20_000);
    let expired = 0;
    let expiring = 0;
    let unverified = 0;
    for (const row of certRows) {
      if (row.status !== "verified") unverified += 1;
      if (row.status === "rejected" || row.status === "revoked") continue;
      const validity = classifyValidity(row.expiresAt, today, EXPIRY_WARN_DAYS);
      if (validity.state === "expired") expired += 1;
      else if (validity.state === "expiring") expiring += 1;
    }

    /* ---------------- productivity ---------------- */
    const { report, window, reasons: prodReasons } = await buildProductivityReport(
      app.db,
      companyId,
      projectId,
      {},
    );
    const latestForecast = await app.db
      .select()
      .from(resourceForecasts)
      .where(
        and(
          eq(resourceForecasts.companyId, companyId),
          eq(resourceForecasts.projectId, projectId),
        ),
      )
      .orderBy(desc(resourceForecasts.asOfDate), desc(resourceForecasts.createdAt))
      .limit(1);
    const [snapshotCount] = await app.db
      .select({ n: count() })
      .from(resourceProductivitySnapshots)
      .where(
        and(
          eq(resourceProductivitySnapshots.companyId, companyId),
          eq(resourceProductivitySnapshots.projectId, projectId),
        ),
      );

    return {
      plan,
      today,
      horizonEnd,
      coverage: {
        overWeeks,
        unknownSupplyWeeks,
        worstShortfall,
        peakDemandHours,
        peakWeekStart,
      },
      bookings: {
        active: bookings.length,
        conflicts: conflicts.length,
        worstConflict: conflicts[0] ?? null,
      },
      certifications: {
        workers: Number(workerCount?.n ?? 0),
        records: certRows.length,
        expired,
        expiring,
        unverified,
      },
      productivity: {
        window,
        totals: report.totals,
        weeks: report.weeks.slice(-13),
        latestForecast: latestForecast[0] ?? null,
        snapshots: Number(snapshotCount?.n ?? 0),
      },
      reasons: [...reasons, ...prodReasons],
    };
  }

  app.get("/projects/:projectId/resources/summary", { preHandler: gates.read }, async (req) => {
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const data = await snapshot(companyId, projectId);
    const openSignals = await openResourceSignals(app.db, companyId, RESOURCE_DETECTORS, projectId);
    const types = await app.db
      .select({ id: resourceTypes.id, kind: resourceTypes.kind, status: resourceTypes.status })
      .from(resourceTypes)
      .where(eq(resourceTypes.companyId, companyId));
    const usable = types.filter((t) => t.status === "active");
    return {
      ...data,
      library: {
        resourceTypes: usable.length,
        labourTypes: usable.filter((t) => t.kind === "labour").length,
        equipmentTypes: usable.filter((t) => t.kind === "equipment").length,
      },
      openSignals: {
        total: openSignals.length,
        byDetector: openSignals.reduce<Record<string, number>>((acc, s) => {
          acc[s.detector] = (acc[s.detector] ?? 0) + 1;
          return acc;
        }, {}),
        items: openSignals.slice(0, 20),
      },
    };
  });

  /**
   * The intelligence layer's feed (master plan §3.5). Nulls are deliberate:
   * a project with no plan has an UNKNOWN coverage gap, and scoring it as
   * zero would rate an unplanned project as perfectly resourced.
   */
  app.get(
    "/projects/:projectId/resources/health-inputs",
    { preHandler: gates.read },
    async (req) => {
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const data = await snapshot(companyId, projectId);
      const openSignals = await openResourceSignals(
        app.db,
        companyId,
        RESOURCE_DETECTORS,
        projectId,
      );
      const reasons = [...data.reasons];
      if (!data.plan) {
        reasons.push(
          "resourcePlanExists is 0: this project has never had a resource plan activated, which is " +
            "itself the finding.",
        );
      }
      return {
        metrics: {
          resourcePlanExists: data.plan ? 1 : 0,
          overAllocatedWeeks: data.coverage.overWeeks,
          unknownSupplyWeeks: data.coverage.unknownSupplyWeeks,
          worstShortfallHours: data.coverage.worstShortfall?.shortfallHours ?? null,
          peakDemandHours: data.coverage.peakDemandHours,
          activeAssignments: data.bookings.active,
          assignmentConflicts: data.bookings.conflicts,
          expiredCertifications: data.certifications.expired,
          expiringCertifications: data.certifications.expiring,
          unverifiedCertifications: data.certifications.unverified,
          productivityFactor: data.productivity.totals.productivityFactor,
          actualHours: data.productivity.totals.actualHours,
          earnedHours: data.productivity.totals.earnedHours,
          unearnableHours: data.productivity.totals.unearnableHours,
          forecastHoursAtCompletion:
            data.productivity.latestForecast?.forecastHoursAtCompletion ?? null,
          forecastVarianceHours: data.productivity.latestForecast?.varianceHours ?? null,
          openResourceSignals: openSignals.length,
        },
        reasons,
      };
    },
  );

  /**
   * Run the sweeps on demand. Operators and tests need a way to force a cycle
   * without waiting for the scheduler, and the scheduler is disabled under
   * test entirely.
   */
  app.post("/projects/:projectId/resources/sweeps/run", { preHandler: gates.admin }, async (req) => {
    const body = S.sweepRunSchema.parse(req.body ?? {});
    const companyId = companyOf(req);
    const now = new Date();
    if (!body.job) return { ranAt: now.toISOString(), ...(await runResourceSweeps(app.db, companyId, now)) };
    switch (body.job) {
      case "resources.plan-coverage":
        return { ranAt: now.toISOString(), coverage: await sweepPlanCoverage(app.db, companyId, now) };
      case "resources.assignment-conflicts":
        return {
          ranAt: now.toISOString(),
          conflicts: await sweepAssignmentConflicts(app.db, companyId, now),
        };
      case "resources.certification-expiry":
        return {
          ranAt: now.toISOString(),
          certifications: await sweepCertificationExpiry(app.db, companyId, now),
        };
      default:
        return {
          ranAt: now.toISOString(),
          productivity: await sweepProductivity(app.db, companyId, now),
        };
    }
  });

  /**
   * Open resource findings across the company.
   *
   * Scoped to the projects the caller can actually see: an ordinary member is
   * shown findings on their own projects, an owner/admin sees the portfolio.
   * A company-wide list of project findings behind a bare company gate leaks
   * every project's resourcing problems to everybody in the tenant.
   */
  app.get("/resources/signals", { preHandler: gates.company }, async (req) => {
    const companyId = companyOf(req);
    const visible = await visibleProjectIds(app.db, req);
    const items = await openResourceSignals(app.db, companyId, RESOURCE_DETECTORS);
    const filtered =
      visible === "all"
        ? items
        : items.filter((s) => s.projectId !== null && visible.has(s.projectId));
    return {
      total: filtered.length,
      items: filtered,
      scope: visible === "all" ? "company" : "member_projects",
    };
  });
};
