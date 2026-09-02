/**
 * The productivity read path, shared by the routes and the scheduler sweeps.
 *
 * One loader, one report builder and one snapshot writer, so a figure a user
 * sees on the page and a figure the weekly capture keeps can never disagree.
 *
 * WHICH HOURS COUNT. Rejected, void and superseded cards are excluded: they
 * are hours somebody refused, and including them makes every productivity
 * figure pessimistic in a way nobody can reproduce. Draft cards ARE included,
 * and every response says so, because on a live job the current week is
 * always in draft and a trend that stops a fortnight ago is a trend nobody
 * uses.
 */
import { and, asc, eq, gte, lte, notInArray } from "drizzle-orm";
import {
  crews,
  resourceProductivitySnapshots,
  resourceTypes,
  timecardAllocations,
  timecards,
} from "@constructos/db";
import type { HoursForecastMethod, ProductivityScope } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { badRequest } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { addDays, round2, todayIso } from "./engines/calendar.js";
import {
  computeResourceProductivity,
  forecastHoursAtCompletion,
  type ForecastResult,
  type ProductivityAllocation,
  type ResourceProductivityReport,
} from "./engines/productivity.js";
import { plannedLinesFor } from "./shared.js";

/** Cards in these statuses are hours somebody refused; they never count. */
export const EXCLUDED_TIMECARD_STATUSES = ["rejected", "void", "revised"] as const;
/** Allocations read in one pass. */
export const MAX_ALLOCATIONS = 50_000;
/** Default lookback when no window is given. */
export const DEFAULT_WINDOW_DAYS = 182;

export const DRAFT_INCLUSION_NOTE =
  "Rejected, void and superseded cards are excluded. Draft cards are included so the current " +
  "week is visible; a trend that stops a fortnight ago is a trend nobody uses.";

export interface LoadedAllocations {
  allocations: ProductivityAllocation[];
  window: { from: string; to: string };
  reasons: string[];
  truncated: boolean;
  unmappedTrades: string[];
}

/**
 * Coded hours in the window, each mapped to a resource type by matching the
 * card's (or its crew's) trade against the type's code, name, trade or
 * `mapsToTrade`. Hours whose trade matches nothing are KEPT and labelled "not
 * mapped" rather than dropped: a project total smaller than its own
 * timesheets is worse than an unattributed bucket.
 */
export async function loadAllocations(
  db: Db,
  companyId: string,
  projectId: string,
  from: string | undefined,
  to: string | undefined,
  filters: { resourceTypeId?: string; crewId?: string } = {},
  now: Date = new Date(),
): Promise<LoadedAllocations> {
  const windowTo = to ?? todayIso(now);
  const windowFrom = from ?? addDays(windowTo, -DEFAULT_WINDOW_DAYS);
  if (windowTo < windowFrom) throw badRequest("`to` must not precede `from`");

  const types = await db.select().from(resourceTypes).where(eq(resourceTypes.companyId, companyId));
  const byTrade = new Map<string, { id: string; name: string }>();
  for (const type of types) {
    if (type.projectId !== null && type.projectId !== projectId) continue;
    for (const key of [type.code, type.name, type.trade, type.mapsToTrade]) {
      if (key) byTrade.set(key.trim().toLowerCase(), { id: type.id, name: type.name });
    }
  }

  const clauses = [
    eq(timecardAllocations.companyId, companyId),
    eq(timecardAllocations.projectId, projectId),
    gte(timecards.workDate, windowFrom),
    lte(timecards.workDate, windowTo),
    notInArray(timecards.status, [...EXCLUDED_TIMECARD_STATUSES]),
  ];
  if (filters.crewId) clauses.push(eq(timecards.crewId, filters.crewId));

  const rows = await db
    .select({
      hours: timecardAllocations.totalHours,
      quantity: timecardAllocations.quantity,
      unit: timecardAllocations.unit,
      budgetLineItemId: timecardAllocations.budgetLineItemId,
      workDate: timecards.workDate,
      cardTrade: timecards.trade,
      crewId: timecards.crewId,
      crewName: crews.name,
      crewTrade: crews.trade,
    })
    .from(timecardAllocations)
    .innerJoin(timecards, eq(timecards.id, timecardAllocations.timecardId))
    .leftJoin(crews, eq(crews.id, timecards.crewId))
    .where(and(...clauses))
    .orderBy(asc(timecards.workDate))
    .limit(MAX_ALLOCATIONS + 1);

  const truncated = rows.length > MAX_ALLOCATIONS;
  const kept = truncated ? rows.slice(0, MAX_ALLOCATIONS) : rows;
  const unmapped = new Set<string>();

  const allocations: ProductivityAllocation[] = [];
  for (const row of kept) {
    const tradeKey = (row.cardTrade ?? row.crewTrade ?? "").trim().toLowerCase();
    const type = tradeKey ? byTrade.get(tradeKey) : undefined;
    if (!type && tradeKey) unmapped.add(row.cardTrade ?? row.crewTrade ?? tradeKey);
    if (filters.resourceTypeId && type?.id !== filters.resourceTypeId) continue;
    allocations.push({
      workDate: row.workDate,
      hours: row.hours,
      quantity: row.quantity,
      unit: row.unit,
      budgetLineItemId: row.budgetLineItemId,
      crewId: row.crewId,
      crewName: row.crewName,
      resourceTypeId: type?.id ?? null,
      resourceTypeName: type?.name ?? null,
    });
  }

  const reasons: string[] = [];
  if (truncated) {
    reasons.push(
      `More than ${MAX_ALLOCATIONS} coded allocations fall in this window; only the first ` +
        `${MAX_ALLOCATIONS} were read. Narrow the window for a complete figure.`,
    );
  }
  if (unmapped.size > 0) {
    reasons.push(
      `${unmapped.size} trade(s) on the timecards match no resource type (${[...unmapped]
        .slice(0, 8)
        .join(", ")}). Their hours are counted under "not mapped" rather than dropped.`,
    );
  }
  reasons.push(DRAFT_INCLUSION_NOTE);
  return {
    allocations,
    window: { from: windowFrom, to: windowTo },
    reasons,
    truncated,
    unmappedTrades: [...unmapped],
  };
}

export interface ProductivityReadout {
  report: ResourceProductivityReport;
  window: { from: string; to: string };
  reasons: string[];
  /** planned hours per budget line, reused by the forecast */
  planned: Awaited<ReturnType<typeof plannedLinesFor>>;
}

export async function buildProductivityReport(
  db: Db,
  companyId: string,
  projectId: string,
  q: { from?: string; to?: string; resourceTypeId?: string; crewId?: string } = {},
  now: Date = new Date(),
): Promise<ProductivityReadout> {
  const loaded = await loadAllocations(
    db,
    companyId,
    projectId,
    q.from,
    q.to,
    {
      ...(q.resourceTypeId ? { resourceTypeId: q.resourceTypeId } : {}),
      ...(q.crewId ? { crewId: q.crewId } : {}),
    },
    now,
  );
  const planned = await plannedLinesFor(db, companyId, projectId);
  const report = computeResourceProductivity(loaded.allocations, planned.lines);
  return {
    report,
    window: loaded.window,
    planned,
    reasons: [...loaded.reasons, ...planned.reasons, ...report.reasons],
  };
}

export interface ForecastReadout {
  window: { from: string; to: string };
  method: HoursForecastMethod;
  resourceTypeId: string | null;
  forecast: ForecastResult;
  totals: ResourceProductivityReport["totals"];
  reasons: string[];
}

export async function computeHoursForecast(
  db: Db,
  companyId: string,
  projectId: string,
  options: {
    method: HoursForecastMethod;
    from?: string;
    to?: string;
    resourceTypeId: string | null;
    manualForecastHours?: number | null;
  },
  now: Date = new Date(),
): Promise<ForecastReadout> {
  const { report, window, reasons, planned } = await buildProductivityReport(
    db,
    companyId,
    projectId,
    {
      ...(options.from ? { from: options.from } : {}),
      ...(options.to ? { to: options.to } : {}),
      ...(options.resourceTypeId ? { resourceTypeId: options.resourceTypeId } : {}),
    },
    now,
  );

  /* Budgeted hours for the scope: every line with a derivable figure. NULL
     when no line has one — never zero, which would forecast an overrun of the
     entire spend. */
  const withHours = planned.lines.filter((l) => l.budgetHours !== null);
  const budgetHours =
    withHours.length > 0 ? round2(withHours.reduce((s, l) => s + (l.budgetHours ?? 0), 0)) : null;
  const budgetQuantity =
    withHours.length > 0
      ? withHours.reduce<number | null>(
          (s, l) => (s === null || l.budgetQuantity === null ? null : s + l.budgetQuantity),
          0,
        )
      : null;
  const installedQuantity = report.byResourceType.reduce<number | null>(
    (s, b) => (s === null || b.installedQuantity === null ? null : s + b.installedQuantity),
    0,
  );

  const forecast = forecastHoursAtCompletion(
    {
      budgetHours,
      actualHours: report.totals.actualHours,
      earnedHours: report.totals.earnedHours,
      budgetQuantity,
      installedQuantity,
      manualForecastHours: options.manualForecastHours ?? null,
    },
    options.method,
  );
  return {
    window,
    method: options.method,
    resourceTypeId: options.resourceTypeId,
    forecast,
    totals: report.totals,
    reasons: [...reasons, ...forecast.reasons],
  };
}

/**
 * Persist a productivity readout. `capturedBy` is null when the scheduler
 * took it — the system actor — which is how the register distinguishes a
 * weekly automatic capture from one a person asked for.
 */
export async function writeProductivitySnapshots(
  db: Db,
  companyId: string,
  projectId: string,
  window: { from: string; to: string },
  report: ResourceProductivityReport,
  scopes: ProductivityScope[],
  includeWeeks: boolean,
  capturedBy: string | null,
): Promise<string[]> {
  const values: Array<typeof resourceProductivitySnapshots.$inferInsert> = [];
  const base = {
    companyId,
    projectId,
    periodStart: window.from,
    periodEnd: window.to,
    capturedBy,
  };
  if (scopes.includes("project")) {
    values.push({
      ...base,
      id: newId("rps"),
      weekStart: null,
      scope: "project",
      scopeId: null,
      scopeLabel: "Project",
      actualHours: report.totals.actualHours,
      earnedHours: report.totals.earnedHours,
      productivityFactor: report.totals.productivityFactor,
      installedQuantity: null,
      unit: null,
      achievedUnitRate: null,
      plannedUnitRate: null,
      linesMeasured: report.totals.linesMeasured,
      linesUnmeasurable: report.totals.linesUnmeasurable,
      reasons: report.reasons,
      basis: `${report.totals.actualHours} coded hours between ${window.from} and ${window.to}.`,
    });
  }
  const bucketScopes: Array<[ProductivityScope, ResourceProductivityReport["byResourceType"], string]> = [
    ["resource_type", report.byResourceType, "__unmapped__"],
    ["crew", report.byCrew, "__nocrew__"],
  ];
  for (const [scope, buckets, sentinel] of bucketScopes) {
    if (!scopes.includes(scope)) continue;
    for (const bucket of buckets) {
      values.push({
        ...base,
        id: newId("rps"),
        weekStart: null,
        scope,
        scopeId: bucket.key === sentinel ? null : bucket.key,
        scopeLabel: bucket.label,
        actualHours: bucket.actualHours,
        earnedHours: bucket.earnedHours,
        productivityFactor: bucket.productivityFactor,
        installedQuantity: bucket.installedQuantity,
        unit: bucket.unit,
        achievedUnitRate: bucket.achievedUnitRate,
        plannedUnitRate: bucket.plannedUnitRate,
        linesMeasured: 0,
        linesUnmeasurable: 0,
        reasons: bucket.reasons,
        basis: `${bucket.actualHours} hours booked to ${bucket.label}.`,
      });
    }
  }
  if (includeWeeks) {
    for (const week of report.weeks) {
      values.push({
        ...base,
        id: newId("rps"),
        periodStart: week.weekStart,
        periodEnd: addDays(week.weekStart, 6),
        weekStart: week.weekStart,
        scope: "project",
        scopeId: null,
        scopeLabel: `Week beginning ${week.weekStart}`,
        actualHours: week.actualHours,
        earnedHours: week.earnedHours,
        productivityFactor: week.productivityFactor,
        installedQuantity: week.installedQuantity,
        unit: week.unit,
        achievedUnitRate: week.achievedUnitRate,
        plannedUnitRate: week.plannedUnitRate,
        linesMeasured: 0,
        linesUnmeasurable: 0,
        reasons: week.reasons,
        basis: `Week beginning ${week.weekStart}.`,
      });
    }
  }
  if (values.length === 0) return [];
  for (let i = 0; i < values.length; i += 500) {
    await db.insert(resourceProductivitySnapshots).values(values.slice(i, i + 500));
  }
  return values.map((v) => v.id);
}
