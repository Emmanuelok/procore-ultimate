/**
 * SCHEDULED RESOURCE SWEEPS.
 *
 * Four time-driven behaviours, all registered with the platform scheduler
 * rather than run lazily when somebody opens a page. A resourcing shortfall
 * that is only noticed when a planner happens to look at the histogram is a
 * shortfall noticed in the week it bites.
 *
 *   resources.plan-coverage        weeks where demand exceeds fielded supply
 *   resources.assignment-conflicts crews, workers and plant booked twice
 *   resources.certification-expiry tickets lapsing under a live booking
 *   resources.productivity         weekly capture + sustained-shortfall detect
 *
 * EVERY JOB IS IDEMPOTENT. Findings are fingerprinted on what they are ABOUT
 * (project + trade + week, project + resource + window, worker + ticket), not
 * on the run that found them, so a sweep over unchanged data refreshes the
 * existing signal instead of manufacturing a second one. When the condition
 * clears the signal is auto-closed. False-positive fatigue is what switches a
 * control off, and then the real findings go unseen too.
 *
 * The productivity capture is weekly by design: a snapshot per run of a
 * six-hourly job would bury the trend it exists to preserve.
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import {
  projects,
  resourceAssignments,
  resourceAvailability,
  resourceDemands,
  resourcePlans,
  resourceProductivitySnapshots,
  resourceSkills,
  resourceTypes,
  scheduleTasks,
  signals,
  workerSkills,
  workers,
} from "@constructos/db";
import { ACTIVE_ASSIGNMENT_STATUSES } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { appendLedger } from "../../lib/ledger.js";
import { forEachCompany } from "../../lib/scheduler.js";
import { pushNotifications, type NotifyTarget } from "../notifications/service.js";
import {
  addDays,
  daysBetween,
  enumerateWeeks,
  round2,
  todayIso,
  weekStartOf,
} from "./engines/calendar.js";
import { buildHistogram, type HistogramType } from "./engines/histogram.js";
import {
  detectAssignmentConflicts,
  type AssignmentWindow,
} from "./engines/conflicts.js";
import { classifyValidity, EXPIRY_WARN_DAYS } from "./engines/skills.js";
import { detectSustainedShortfall } from "./engines/productivity.js";
import { buildProductivityReport, writeProductivitySnapshots } from "./service.js";
import {
  closeSignals,
  projectMemberIds,
  raiseSignal,
  standardWorkingDaysPerWeek,
  workPatternFor,
} from "./shared.js";

export const RESOURCE_JOBS = [
  "resources.plan-coverage",
  "resources.assignment-conflicts",
  "resources.certification-expiry",
  "resources.productivity",
] as const;
export type ResourceJobName = (typeof RESOURCE_JOBS)[number];

/** How far ahead the coverage sweep looks. Beyond a quarter the plan is a
 *  hypothesis and a shortfall signal is noise. */
const COVERAGE_HORIZON_WEEKS = 13;
/** Ignore a shortfall smaller than this — rounding, not a resourcing problem. */
const COVERAGE_MIN_SHORTFALL_HOURS = 8;
/** Certificates lapsing within this many days are warned about. */
const CERT_WARN_DAYS = EXPIRY_WARN_DAYS;
/** Projects visited per company per sweep. */
const MAX_PROJECTS = 500;

const severityForShortfall = (percent: number): "critical" | "high" | "medium" =>
  percent >= 50 ? "critical" : percent >= 20 ? "high" : "medium";

async function activeProjects(db: Db, companyId: string) {
  return db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.companyId, companyId), eq(projects.isTemplate, 0)))
    .limit(MAX_PROJECTS);
}

/* ================================================================== */
/* 1. Plan coverage                                                    */
/* ================================================================== */

export interface CoverageResult {
  projects: number;
  weeksExamined: number;
  signalsRaised: number;
  signalsClosed: number;
  unresourcedActivities: number;
}

/**
 * Weeks in the next quarter where an active plan needs more hours of a trade
 * than the project has said it can field.
 *
 * A week with NO recorded availability is not a finding: unknown supply is a
 * question, not a crisis, and raising a signal for every un-filled cell would
 * bury the weeks that are genuinely short.
 */
export async function sweepPlanCoverage(
  db: Db,
  companyId: string,
  now: Date,
): Promise<CoverageResult> {
  const result: CoverageResult = {
    projects: 0,
    weeksExamined: 0,
    signalsRaised: 0,
    signalsClosed: 0,
    unresourcedActivities: 0,
  };
  const today = todayIso(now);
  const horizonEnd = addDays(today, COVERAGE_HORIZON_WEEKS * 7);
  const liveOverAllocation = new Set<string>();
  const liveUnresourced = new Set<string>();

  for (const project of await activeProjects(db, companyId)) {
    const planRows = await db
      .select()
      .from(resourcePlans)
      .where(
        and(
          eq(resourcePlans.companyId, companyId),
          eq(resourcePlans.projectId, project.id),
          eq(resourcePlans.status, "active"),
          eq(resourcePlans.planKind, "current"),
        ),
      )
      .limit(1);
    const plan = planRows[0];
    if (!plan) continue;
    result.projects += 1;

    const weekStart = weekStartOf(today, plan.weekStartsOn);
    const weeks = enumerateWeeks(weekStart, horizonEnd, plan.weekStartsOn);
    result.weeksExamined += weeks.length;

    const demand = await db
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
    if (demand.length === 0) continue;

    const supply = await db
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
          eq(resourceAvailability.projectId, project.id),
          gte(resourceAvailability.weekStart, weekStart),
          lte(resourceAvailability.weekStart, horizonEnd),
        ),
      );

    const typeRows = await db
      .select()
      .from(resourceTypes)
      .where(eq(resourceTypes.companyId, companyId));
    const types: HistogramType[] = typeRows
      .filter((t) => t.projectId === null || t.projectId === project.id)
      .map((t) => ({
        id: t.id,
        code: t.code,
        name: t.name,
        kind: t.kind,
        unit: t.unit,
        standardHoursPerDay: t.standardHoursPerDay,
        workingDaysPerWeek: t.workingDaysPerWeek,
      }));
    const { pattern } = await workPatternFor(db, companyId, project.id);

    const histogram = buildHistogram({
      weeks,
      types,
      demand,
      supply,
      workingDaysPerWeek: standardWorkingDaysPerWeek(pattern),
    });

    const recipients = await projectMemberIds(db, companyId, project.id);
    const notifications: NotifyTarget[] = [];

    for (const series of histogram.series) {
      for (const cell of series.cells) {
        const fingerprint = `${project.id}|${cell.resourceTypeId}|${cell.weekStart}`;
        if (cell.state !== "over") continue;
        const shortfall = cell.overAllocationHours ?? cell.demandHours;
        if (shortfall < COVERAGE_MIN_SHORTFALL_HOURS) continue;
        const percent =
          cell.availableHours && cell.availableHours > 0
            ? round2((shortfall / cell.availableHours) * 100)
            : 100;
        liveOverAllocation.add(fingerprint);
        const outcome = await raiseSignal(
          db,
          companyId,
          project.id,
          {
            detector: "resource_over_allocation",
            fingerprint,
            severity: severityForShortfall(percent),
            confidence: 0.9,
            title: `${series.resourceType.name} short ${shortfall} h in the week of ${cell.weekStart} (${project.name})`,
            explanation:
              `Plan ${plan.reference} needs ${cell.demandHours} hours of ` +
              `${series.resourceType.name} in the week beginning ${cell.weekStart}, against ` +
              `${cell.availableHours ?? 0} hours this project has said it can field — a shortfall of ` +
              `${shortfall} hours (${percent}% of the stated supply). The week is ` +
              `${Math.max(0, daysBetween(today, cell.weekStart))} day(s) away, which is still long ` +
              "enough to move a float-bearing activity or field more people. It will not be in the " +
              "week itself.",
            subjectType: "resource_type",
            subjectId: cell.resourceTypeId,
            evidenceRefs: {
              planId: plan.id,
              planReference: plan.reference,
              weekStart: cell.weekStart,
              demandHours: cell.demandHours,
              availableHours: cell.availableHours,
              shortfallHours: shortfall,
              contributingTaskIds: cell.contributingTaskIds.slice(0, 20),
            },
          },
          now,
        );
        if (outcome === "created") {
          result.signalsRaised += 1;
          for (const userId of recipients) {
            notifications.push({
              companyId,
              userId,
              projectId: project.id,
              kind: "resource",
              title: `${series.resourceType.name} short ${shortfall} h — week of ${cell.weekStart}`,
              body:
                `${cell.demandHours} h needed against ${cell.availableHours ?? 0} h available on ` +
                `${project.name}.`,
              recordType: "resource_plan",
              recordId: plan.id,
              tool: "resources",
            });
          }
        }
      }
    }

    /* Work starting soon that no plan resources at all. */
    const soon = addDays(today, 28);
    const startingSoon = await db
      .select({ id: scheduleTasks.id, name: scheduleTasks.name, startDate: scheduleTasks.startDate })
      .from(scheduleTasks)
      .where(
        and(
          eq(scheduleTasks.projectId, project.id),
          gte(scheduleTasks.startDate, today),
          lte(scheduleTasks.startDate, soon),
          ne(scheduleTasks.taskType, "milestone"),
        ),
      )
      .limit(500);
    if (startingSoon.length > 0) {
      const resourcedTaskIds = new Set(
        (
          await db
            .select({ taskId: resourceDemands.sourceTaskId })
            .from(resourceDemands)
            .where(eq(resourceDemands.planId, plan.id))
        )
          .map((r) => r.taskId)
          .filter((id): id is string => Boolean(id)),
      );
      /* Only meaningful when the plan keeps per-activity traceability; an
         aggregated plan cannot answer "which activity". */
      if (resourcedTaskIds.size > 0) {
        const unresourced = startingSoon.filter((t) => !resourcedTaskIds.has(t.id));
        result.unresourcedActivities += unresourced.length;
        if (unresourced.length > 0) {
          const fingerprint = `${project.id}|unresourced|${weekStart}`;
          liveUnresourced.add(fingerprint);
          const outcome = await raiseSignal(
            db,
            companyId,
            project.id,
            {
              detector: "resource_unresourced_work",
              fingerprint,
              severity: unresourced.length >= 10 ? "high" : "medium",
              confidence: 0.7,
              title: `${unresourced.length} activities start within 4 weeks with nobody planned (${project.name})`,
              explanation:
                `${unresourced.length} activity(ies) on ${project.name} start between ${today} and ` +
                `${soon} and appear in no row of resource plan ${plan.reference}. Either they need ` +
                "nobody — in which case say so on the activity — or the plan understates the next " +
                "month's demand by however many hours they represent. " +
                unresourced
                  .slice(0, 5)
                  .map((t) => `"${t.name}" (${t.startDate})`)
                  .join("; ") +
                (unresourced.length > 5 ? `; and ${unresourced.length - 5} more.` : "."),
              subjectType: "resource_plan",
              subjectId: plan.id,
              evidenceRefs: {
                planId: plan.id,
                taskIds: unresourced.slice(0, 50).map((t) => t.id),
                from: today,
                to: soon,
              },
            },
            now,
          );
          if (outcome === "created") result.signalsRaised += 1;
        }
      }
    }

    if (notifications.length > 0) await pushNotifications(db, notifications);
  }

  /* A shortfall that has been resourced, or a week that has passed out of the
     horizon, closes itself rather than sitting open forever. */
  result.signalsClosed = await closeSignalsNotIn(
    db,
    companyId,
    "resource_over_allocation",
    liveOverAllocation,
    now,
  );
  result.signalsClosed += await closeSignalsNotIn(
    db,
    companyId,
    "resource_unresourced_work",
    liveUnresourced,
    now,
  );
  return result;
}

/* ================================================================== */
/* 2. Assignment conflicts                                             */
/* ================================================================== */

export interface ConflictSweepResult {
  projects: number;
  conflicts: number;
  signalsRaised: number;
  signalsClosed: number;
}

/**
 * Double bookings that are still in the future or running now. A conflict
 * that has already passed is history and raising it teaches nobody anything.
 */
export async function sweepAssignmentConflicts(
  db: Db,
  companyId: string,
  now: Date,
): Promise<ConflictSweepResult> {
  const result: ConflictSweepResult = {
    projects: 0,
    conflicts: 0,
    signalsRaised: 0,
    signalsClosed: 0,
  };
  const today = todayIso(now);
  const horizon = addDays(today, 180);
  const live = new Set<string>();

  for (const project of await activeProjects(db, companyId)) {
    const rows = await db
      .select()
      .from(resourceAssignments)
      .where(
        and(
          eq(resourceAssignments.companyId, companyId),
          eq(resourceAssignments.projectId, project.id),
          inArray(resourceAssignments.status, [...ACTIVE_ASSIGNMENT_STATUSES]),
          gte(resourceAssignments.toDate, today),
          lte(resourceAssignments.fromDate, horizon),
        ),
      )
      .limit(5000);
    if (rows.length < 2) continue;
    result.projects += 1;

    const windows: AssignmentWindow[] = rows.map((a) => ({
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
    result.conflicts += conflicts.length;

    const recipients = await projectMemberIds(db, companyId, project.id);
    const notifications: NotifyTarget[] = [];
    for (const conflict of conflicts) {
      const fingerprint = `${project.id}|${conflict.subjectKind}|${conflict.subjectId}|${conflict.fromDate}|${conflict.toDate}`;
      live.add(fingerprint);
      const outcome = await raiseSignal(
        db,
        companyId,
        project.id,
        {
          detector: "resource_assignment_conflict",
          fingerprint,
          severity: conflict.severity,
          confidence: 1,
          title: `${conflict.subjectLabel} double-booked ${conflict.fromDate} → ${conflict.toDate} (${project.name})`,
          explanation: conflict.explanation,
          subjectType: conflict.subjectKind,
          subjectId: conflict.subjectId,
          evidenceRefs: {
            assignmentIds: conflict.participants.map((p) => p.assignmentId),
            references: conflict.participants.map((p) => p.reference),
            totalAllocationPercent: conflict.totalAllocationPercent,
            days: conflict.days,
          },
        },
        now,
      );
      if (outcome === "created") {
        result.signalsRaised += 1;
        for (const userId of recipients) {
          notifications.push({
            companyId,
            userId,
            projectId: project.id,
            kind: "resource",
            title: `${conflict.subjectLabel} is booked twice`,
            body: `${conflict.fromDate} → ${conflict.toDate} at ${conflict.totalAllocationPercent}% on ${project.name}.`,
            recordType: "resource_assignment",
            recordId: conflict.participants[0]?.assignmentId ?? project.id,
            tool: "resources",
          });
        }
      }
    }
    if (notifications.length > 0) await pushNotifications(db, notifications);
  }

  /* A clash that no longer exists — one booking moved or was cancelled —
     closes itself rather than sitting open forever. */
  result.signalsClosed = await closeSignalsNotIn(
    db,
    companyId,
    "resource_assignment_conflict",
    live,
    now,
  );
  return result;
}

/* ================================================================== */
/* 3. Certification expiry                                             */
/* ================================================================== */

export interface CertificationSweepResult {
  projects: number;
  expiring: number;
  expired: number;
  notified: number;
  signalsRaised: number;
}

/**
 * Certificates that have lapsed, or lapse within a month, on workers who are
 * booked to work. Idempotent through `expiryNotifiedForDate`: a worker is
 * warned once per expiry date, not once per sweep.
 */
export async function sweepCertificationExpiry(
  db: Db,
  companyId: string,
  now: Date,
): Promise<CertificationSweepResult> {
  const result: CertificationSweepResult = {
    projects: 0,
    expiring: 0,
    expired: 0,
    notified: 0,
    signalsRaised: 0,
  };
  const today = todayIso(now);
  const horizon = addDays(today, CERT_WARN_DAYS);

  for (const project of await activeProjects(db, companyId)) {
    const rows = await db
      .select({
        cell: workerSkills,
        workerReference: workers.reference,
        workerName: workers.fullName,
        skillCode: resourceSkills.code,
        skillName: resourceSkills.name,
        isMandatory: resourceSkills.isMandatory,
      })
      .from(workerSkills)
      .innerJoin(workers, eq(workers.id, workerSkills.workerId))
      .innerJoin(resourceSkills, eq(resourceSkills.id, workerSkills.skillId))
      .where(
        and(
          eq(workerSkills.companyId, companyId),
          eq(workerSkills.projectId, project.id),
          lte(workerSkills.expiresAt, horizon),
          inArray(workerSkills.status, ["claimed", "verified"]),
          ne(workers.status, "demobilised"),
        ),
      )
      .limit(2000);
    if (rows.length === 0) continue;
    result.projects += 1;

    const recipients = await projectMemberIds(db, companyId, project.id);
    const notifications: NotifyTarget[] = [];
    for (const row of rows) {
      const validity = classifyValidity(row.cell.expiresAt, today, CERT_WARN_DAYS);
      if (validity.state === "valid" || validity.state === "unknown") continue;
      if (validity.state === "expired") result.expired += 1;
      else result.expiring += 1;

      const fingerprint = `${project.id}|${row.cell.workerId}|${row.cell.skillId}|${row.cell.expiresAt}`;
      const outcome = await raiseSignal(
        db,
        companyId,
        project.id,
        {
          detector: "resource_certification_expiry",
          fingerprint,
          severity:
            validity.state === "expired"
              ? row.isMandatory === 1
                ? "critical"
                : "high"
              : row.isMandatory === 1
                ? "high"
                : "medium",
          confidence: 1,
          title:
            validity.state === "expired"
              ? `${row.workerReference} ${row.workerName}: ${row.skillName} expired`
              : `${row.workerReference} ${row.workerName}: ${row.skillName} expires in ${validity.daysToExpiry} day(s)`,
          explanation:
            `${row.workerName} (${row.workerReference}) holds ${row.skillName} ` +
            `(${row.skillCode})${row.cell.certificateRef ? ` under certificate ${row.cell.certificateRef}` : ""}. ` +
            `${validity.reason} ` +
            (row.isMandatory === 1
              ? "This ticket is mandatory, so the work it covers cannot lawfully proceed without it."
              : "Renew it before the worker is next booked on work that needs it.") +
            (row.cell.status === "claimed"
              ? " The record has never been verified by anybody other than whoever entered it."
              : ""),
          subjectType: "worker",
          subjectId: row.cell.workerId,
          evidenceRefs: {
            workerSkillId: row.cell.id,
            skillId: row.cell.skillId,
            expiresAt: row.cell.expiresAt,
            status: row.cell.status,
          },
        },
        now,
      );
      if (outcome === "created") result.signalsRaised += 1;

      /* One warning per expiry date, not one per sweep. */
      if (row.cell.expiryNotifiedForDate !== row.cell.expiresAt) {
        for (const userId of recipients) {
          notifications.push({
            companyId,
            userId,
            projectId: project.id,
            kind: "compliance",
            title:
              validity.state === "expired"
                ? `${row.skillName} expired: ${row.workerName}`
                : `${row.skillName} expires in ${validity.daysToExpiry} days: ${row.workerName}`,
            body: `${validity.reason} on ${project.name}.`,
            recordType: "worker_skill",
            recordId: row.cell.id,
            tool: "resources",
          });
        }
        await db
          .update(workerSkills)
          .set({ expiryNotifiedAt: now.toISOString(), expiryNotifiedForDate: row.cell.expiresAt })
          .where(eq(workerSkills.id, row.cell.id));
        result.notified += 1;
      }
    }
    if (notifications.length > 0) await pushNotifications(db, notifications);
  }
  return result;
}

/* ================================================================== */
/* 4. Weekly productivity capture                                      */
/* ================================================================== */

export interface ProductivitySweepResult {
  projects: number;
  snapshotsWritten: number;
  signalsRaised: number;
  skippedRecent: number;
}

/**
 * Capture the trend and detect a sustained shortfall.
 *
 * A capture is taken at most once a week per project: the live figure moves
 * every time a timecard is corrected, and a snapshot per run of a frequent
 * job would bury the trend it exists to preserve.
 */
export async function sweepProductivity(
  db: Db,
  companyId: string,
  now: Date,
): Promise<ProductivitySweepResult> {
  const result: ProductivitySweepResult = {
    projects: 0,
    snapshotsWritten: 0,
    signalsRaised: 0,
    skippedRecent: 0,
  };
  const today = todayIso(now);
  const from = addDays(today, -182);

  for (const project of await activeProjects(db, companyId)) {
    const lastRows = await db
      .select({ createdAt: resourceProductivitySnapshots.createdAt })
      .from(resourceProductivitySnapshots)
      .where(
        and(
          eq(resourceProductivitySnapshots.companyId, companyId),
          eq(resourceProductivitySnapshots.projectId, project.id),
        ),
      )
      .orderBy(desc(resourceProductivitySnapshots.createdAt))
      .limit(1);
    const last = lastRows[0]?.createdAt;
    if (last && now.getTime() - Date.parse(last) < 6 * 24 * 60 * 60_000) {
      result.skippedRecent += 1;
      continue;
    }

    const { report, window } = await buildProductivityReport(
      db,
      companyId,
      project.id,
      { from, to: today },
      now,
    );
    if (report.totals.actualHours <= 0) continue;
    result.projects += 1;

    const ids = await writeProductivitySnapshots(
      db,
      companyId,
      project.id,
      window,
      report,
      ["project", "resource_type", "crew"],
      true,
      null,
    );
    result.snapshotsWritten += ids.length;
    await appendLedger(db, {
      companyId,
      actorId: null,
      action: "create",
      objectType: "resource_productivity_snapshot",
      objectId: ids[0] ?? project.id,
      projectId: project.id,
      payload: {
        periodStart: window.from,
        periodEnd: window.to,
        rows: ids.length,
        actualHours: report.totals.actualHours,
        earnedHours: report.totals.earnedHours,
        productivityFactor: report.totals.productivityFactor,
        capturedBy: "scheduler",
      },
    });

    const deviation = detectSustainedShortfall(
      report.weeks.map((w) => ({
        weekStart: w.weekStart,
        actualHours: w.actualHours,
        earnedHours: w.earnedHours,
        productivityFactor: w.productivityFactor,
      })),
    );
    if (deviation) {
      const outcome = await raiseSignal(
        db,
        companyId,
        project.id,
        {
          detector: "resource_productivity_deviation",
          fingerprint: `${project.id}|${deviation.from}|${deviation.to}`,
          severity: deviation.averageFactor < 0.6 ? "high" : "medium",
          confidence: 0.85,
          title: `Labour productivity below floor for ${deviation.weeks} weeks (${project.name})`,
          explanation:
            `${deviation.explanation} One bad week is weather; ${deviation.weeks} is a method, a ` +
            "sequence or a resourcing problem that will not fix itself, and it is still cheap to " +
            "change now. If the cause is disruption somebody else owns, this run is also the " +
            "impacted period a measured-mile comparison is built against.",
          subjectType: "project",
          subjectId: project.id,
          evidenceRefs: {
            from: deviation.from,
            to: deviation.to,
            weeks: deviation.weeks,
            averageFactor: deviation.averageFactor,
            worstFactor: deviation.worstFactor,
            lostHours: deviation.lostHours,
          },
        },
        now,
      );
      if (outcome === "created") result.signalsRaised += 1;
    }
  }
  return result;
}

/* ================================================================== */
/* Registration                                                        */
/* ================================================================== */

/** Close every open signal of a detector whose fingerprint is not in `live`. */
async function closeSignalsNotIn(
  db: Db,
  companyId: string,
  detector: string,
  live: Set<string>,
  now: Date,
): Promise<number> {
  const open = await db
    .select({ id: signals.id, fingerprint: signals.fingerprint })
    .from(signals)
    .where(
      and(
        eq(signals.companyId, companyId),
        eq(signals.detector, detector),
        inArray(signals.disposition, ["new", "under_review", "confirmed", "escalated"]),
      ),
    )
    .limit(2000);
  const stale = open
    .map((row) => row.fingerprint)
    .filter((f): f is string => f !== null && !live.has(f));
  return closeSignals(db, companyId, detector, stale, now);
}

export async function runResourceSweeps(db: Db, companyId: string, now: Date) {
  return {
    coverage: await sweepPlanCoverage(db, companyId, now),
    conflicts: await sweepAssignmentConflicts(db, companyId, now),
    certifications: await sweepCertificationExpiry(db, companyId, now),
    productivity: await sweepProductivity(db, companyId, now),
  };
}

export function registerResourceJobs(app: FastifyInstance): void {
  app.scheduler.register({
    name: "resources.plan-coverage",
    description:
      "Find the weeks in the next quarter where the active resource plan needs more hours of a trade than the project can field",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => sweepPlanCoverage(db, companyId, now)),
  });
  app.scheduler.register({
    name: "resources.assignment-conflicts",
    description: "Detect crews, workers and plant booked to two places at once",
    everyMs: 4 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) => sweepAssignmentConflicts(db, companyId, now)),
  });
  app.scheduler.register({
    name: "resources.certification-expiry",
    description:
      "Warn on certifications and licences that have lapsed or lapse within a month, once per expiry date",
    everyMs: 12 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) => sweepCertificationExpiry(db, companyId, now)),
  });
  app.scheduler.register({
    name: "resources.productivity",
    description:
      "Capture the weekly productivity trend so it survives later timecard corrections, and flag a sustained shortfall",
    everyMs: 24 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => sweepProductivity(db, companyId, now)),
  });
}
