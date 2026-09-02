/**
 * DESIGN MANAGEMENT — service layer.
 *
 * Everything that reads more than one table lives here so the route handlers
 * stay thin and so the scheduler jobs call exactly the same code a button
 * does. Every sweep is idempotent: a condition already signalled produces
 * nothing the second time, an obligation already open is not opened again.
 *
 * Covers: deliverable assessment + obligations + late signals (#254, #909),
 * review overdue detection (#897), stale issues (#902), information
 * requirement obligations, post-freeze change detection (#896), design change
 * frequency (#906), professional indemnity adequacy (#912), handover
 * readiness snapshots (#907–#908) and the analytics both the workspace and
 * WP-INTEL read.
 */
import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import {
  designChangeNotices,
  designComments,
  designConsultants,
  designDecisions,
  designDeliverables,
  designFreezes,
  designInfoRequirements,
  designIssues,
  designPackages,
  designReadinessSnapshots,
  designReviews,
  designStageGates,
  obligations,
  scheduleTasks,
  signals,
} from "@constructos/db";
import type { DesignDetector } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { newId } from "../../lib/ids.js";
import { pushNotifications } from "../notifications/service.js";
import {
  assessDeliverable,
  slippageByConsultant,
  slippageStats,
  type SlippageRow,
} from "./engines/slippage.js";
import { changeFrequency, freezePosition, type FreezeRecord } from "./engines/change.js";
import { cycleTimeStats, overdueCycles, type CycleTimeInput } from "./engines/review.js";
import { assessPi, assessReadiness, type ReadinessVerdict } from "./engines/readiness.js";
import { stageLabel, stageOrder } from "./engines/stages.js";
import { DESIGN_STAGE_FRAMEWORKS, type DesignStageFramework } from "@constructos/shared";

const isFramework = (value: string): value is DesignStageFramework =>
  (DESIGN_STAGE_FRAMEWORKS as readonly string[]).includes(value);
import {
  SYSTEM_ACTOR,
  alreadySignalled,
  figure,
  ledger,
  mean,
  nowISO,
  raiseSignal,
  tally,
  todayISO,
  type Figure,
} from "./shared.js";

/** Deliverable statuses that are still live for sweep purposes. */
export const OPEN_DELIVERABLE_STATUSES = ["planned", "in_progress", "rejected"] as const;
export const OPEN_ISSUE_STATUSES = ["open", "assigned", "in_progress"] as const;
export const OPEN_REVIEW_STATUSES = ["open", "in_review", "consolidating"] as const;
export const OPEN_DCN_STATUSES = ["submitted", "assessing", "approved"] as const;

/* ================================================================== */
/* Deliverables                                                        */
/* ================================================================== */

export interface DeliverableAssessed {
  id: string;
  level: string;
  slippageDays: number | null;
  reasons: string[];
  basis: string;
  blocksTask: boolean;
}

type DeliverableRow = typeof designDeliverables.$inferSelect;

/** The schedule-task start dates the deliverables in this set point at. */
async function taskStarts(db: Db, projectId: string, rows: readonly DeliverableRow[]) {
  const ids = [...new Set(rows.map((r) => r.scheduleTaskId).filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return new Map<string, { name: string; startDate: string | null }>();
  const tasks = await db
    .select({ id: scheduleTasks.id, name: scheduleTasks.name, startDate: scheduleTasks.startDate })
    .from(scheduleTasks)
    .where(and(eq(scheduleTasks.projectId, projectId), inArray(scheduleTasks.id, ids)));
  return new Map(tasks.map((t) => [t.id, { name: t.name, startDate: t.startDate }]));
}

/** Assess one deliverable against the programme; pure engine + the task lookup. */
export async function assessDeliverableRow(
  db: Db,
  row: DeliverableRow,
  asOf: string,
): Promise<DeliverableAssessed> {
  const tasks = await taskStarts(db, row.projectId, [row]);
  const task = row.scheduleTaskId ? tasks.get(row.scheduleTaskId) ?? null : null;
  const verdict = assessDeliverable(
    {
      status: row.status,
      plannedIssueDate: row.plannedIssueDate,
      forecastIssueDate: row.forecastIssueDate,
      actualIssueDate: row.actualIssueDate,
      acceptedAt: row.acceptedAt,
      requiredOnSite: row.requiredOnSite,
      taskStartDate: task?.startDate ?? null,
    },
    asOf,
  );
  return {
    id: row.id,
    level: verdict.level,
    slippageDays: verdict.slippageDays,
    reasons: verdict.reasons,
    basis: verdict.basis,
    blocksTask: verdict.blocksTask,
  };
}

/** Persist the verdict on the row so the register never reads a stale level. */
export async function persistDeliverableAssessment(
  db: Db,
  row: DeliverableRow,
  assessed: DeliverableAssessed,
): Promise<void> {
  await db
    .update(designDeliverables)
    .set({
      slippageLevel: assessed.level,
      slippageDays: assessed.slippageDays,
      slippageReasons: assessed.reasons,
      assessedAt: nowISO(),
      updatedAt: nowISO(),
    })
    .where(eq(designDeliverables.id, row.id));
}

/**
 * Keep the obligation for a deliverable's planned issue date in step: open
 * one while the deliverable is outstanding and has a planned date, satisfy it
 * when issued, waive it when cancelled. Never opens a second one.
 */
export async function syncDeliverableObligation(
  db: Db,
  row: DeliverableRow,
  actorId: string | null,
): Promise<string | null> {
  const outstanding = row.actualIssueDate === null && row.status !== "cancelled";
  if (outstanding && row.plannedIssueDate) {
    if (row.obligationId) return row.obligationId;
    // A fresh id every time: re-planning a date waives the old obligation and
    // opens a new one, so reusing `obl_<deliverableId>` would collide.
    const id = newId("obl");
    await db.insert(obligations).values({
      id,
      companyId: row.companyId,
      projectId: row.projectId,
      sourceClause: `Design deliverable ${row.reference} — planned issue date`,
      trigger: `${row.reference} "${row.title}" must be issued by ${row.plannedIssueDate}. Late design information is the most common upstream cause of a downstream delay claim.`,
      deadline: `${row.plannedIssueDate}T00:00:00.000Z`,
      warnDaysBefore: 7,
      evidenceRequirement: "The issued deliverable recorded against this row, with its revision and issue date.",
      status: "open",
      createdBy: actorId ?? SYSTEM_ACTOR,
    });
    await db
      .update(designDeliverables)
      .set({ obligationId: id, updatedAt: nowISO() })
      .where(eq(designDeliverables.id, row.id));
    await ledger(db, {
      companyId: row.companyId,
      projectId: row.projectId,
      actorId,
      action: "create",
      objectType: "obligation",
      objectId: id,
      payload: { deliverableId: row.id, deadline: row.plannedIssueDate },
    });
    return id;
  }
  if (!outstanding && row.obligationId) {
    const next = row.status === "cancelled" ? "waived" : "satisfied";
    await db
      .update(obligations)
      .set({ status: next })
      .where(
        and(
          eq(obligations.id, row.obligationId),
          eq(obligations.companyId, row.companyId),
          eq(obligations.status, "open"),
        ),
      );
  }
  return row.obligationId;
}

export interface DeliverableSweepResult {
  assessed: number;
  signalsRaised: number;
  obligationsOpened: number;
  byLevel: Record<string, number>;
}

/**
 * Re-assess every live deliverable in a project, refresh its obligation and
 * raise a `design_deliverable_late` signal once per (deliverable, planned
 * date). Re-planning the date is a new condition and may signal again;
 * running the sweep twice on the same facts may not.
 */
export async function sweepDeliverables(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  asOf: string = todayISO(),
): Promise<DeliverableSweepResult> {
  const rows = await db
    .select()
    .from(designDeliverables)
    .where(
      and(
        eq(designDeliverables.companyId, companyId),
        eq(designDeliverables.projectId, projectId),
        ne(designDeliverables.status, "cancelled"),
      ),
    );
  if (rows.length === 0) return { assessed: 0, signalsRaised: 0, obligationsOpened: 0, byLevel: {} };

  const tasks = await taskStarts(db, projectId, rows);
  const seen = await alreadySignalled(db, companyId, ["design_deliverable_late"], projectId);
  const byLevel: Record<string, number> = {};
  let signalsRaised = 0;
  let obligationsOpened = 0;

  for (const row of rows) {
    const task = row.scheduleTaskId ? tasks.get(row.scheduleTaskId) ?? null : null;
    const verdict = assessDeliverable(
      {
        status: row.status,
        plannedIssueDate: row.plannedIssueDate,
        forecastIssueDate: row.forecastIssueDate,
        actualIssueDate: row.actualIssueDate,
        acceptedAt: row.acceptedAt,
        requiredOnSite: row.requiredOnSite,
        taskStartDate: task?.startDate ?? null,
      },
      asOf,
    );
    byLevel[verdict.level] = (byLevel[verdict.level] ?? 0) + 1;
    await persistDeliverableAssessment(db, row, {
      id: row.id,
      level: verdict.level,
      slippageDays: verdict.slippageDays,
      reasons: verdict.reasons,
      basis: verdict.basis,
      blocksTask: verdict.blocksTask,
    });
    const before = row.obligationId;
    const obligationId = await syncDeliverableObligation(db, row, actorId);
    if (!before && obligationId) obligationsOpened += 1;

    if (verdict.level === "late") {
      const key = `design_deliverable_late:${row.id}:${row.plannedIssueDate ?? "none"}`;
      if (!seen.has(key)) {
        const signalId = await raiseSignal(db, companyId, projectId, actorId, {
          detector: "design_deliverable_late",
          severity: verdict.blocksTask ? "high" : "medium",
          confidence: 0.95,
          title: `Design deliverable ${row.reference} is late`,
          explanation: `${row.title} was planned for ${row.plannedIssueDate} and has not been issued. ${verdict.reasons.join(" ")}`,
          key,
          evidence: {
            deliverableId: row.id,
            reference: row.reference,
            plannedIssueDate: row.plannedIssueDate,
            forecastIssueDate: row.forecastIssueDate,
            slippageDays: verdict.slippageDays,
            scheduleTaskId: row.scheduleTaskId,
            scheduleTaskName: task?.name ?? null,
            blocksTask: verdict.blocksTask,
          },
        });
        seen.add(key);
        signalsRaised += 1;
        await db
          .update(designDeliverables)
          .set({ lateSignalId: signalId, updatedAt: nowISO() })
          .where(eq(designDeliverables.id, row.id));
      }
    }
  }
  return { assessed: rows.length, signalsRaised, obligationsOpened, byLevel };
}

/* ================================================================== */
/* Review cycles                                                       */
/* ================================================================== */

export interface ReviewSweepResult {
  checked: number;
  overdue: number;
  signalsRaised: number;
}

/** Overdue review cycles → one signal per cycle, plus a notification to the issuer. */
export async function sweepReviews(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  asOf: string = nowISO(),
): Promise<ReviewSweepResult> {
  const rows = await db
    .select()
    .from(designReviews)
    .where(
      and(
        eq(designReviews.companyId, companyId),
        eq(designReviews.projectId, projectId),
        inArray(designReviews.status, [...OPEN_REVIEW_STATUSES]),
      ),
    );
  if (rows.length === 0) return { checked: 0, overdue: 0, signalsRaised: 0 };

  const overdue = overdueCycles(
    rows.map((r) => ({
      id: r.id,
      packageId: r.packageId,
      cycleNumber: r.cycleNumber,
      issuedAt: r.issuedAt,
      dueAt: r.dueAt,
      closedAt: r.closedAt,
      consolidatedCode: r.consolidatedCode,
      status: r.status,
    })),
    asOf,
  );
  const seen = await alreadySignalled(db, companyId, ["design_review_overdue"], projectId);
  let raised = 0;
  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const entry of overdue) {
    const row = byId.get(entry.id);
    if (!row) continue;
    const key = `design_review_overdue:${row.id}:${row.dueAt ?? "none"}`;
    if (seen.has(key)) continue;
    const signalId = await raiseSignal(db, companyId, projectId, actorId, {
      detector: "design_review_overdue",
      severity: entry.daysOverdue >= 14 ? "high" : "medium",
      confidence: 0.9,
      title: `Design review ${row.reference} is ${entry.daysOverdue} day(s) overdue`,
      explanation: `${row.title} was due back on ${(row.dueAt ?? "").slice(0, 10)} and ${row.returnedCount} of ${row.reviewerCount} reviewer(s) have returned. A review cycle that does not close is design information the site does not have.`,
      key,
      evidence: {
        reviewId: row.id,
        reference: row.reference,
        packageId: row.packageId,
        dueAt: row.dueAt,
        daysOverdue: entry.daysOverdue,
        reviewerCount: row.reviewerCount,
        returnedCount: row.returnedCount,
      },
    });
    seen.add(key);
    raised += 1;
    await db
      .update(designReviews)
      .set({ overdueSignalId: signalId, updatedAt: nowISO() })
      .where(eq(designReviews.id, row.id));
    if (row.createdBy) {
      await pushNotifications(db, [
        {
          companyId,
          userId: row.createdBy,
          projectId,
          kind: "design",
          title: `Design review ${row.reference} is overdue`,
          body: `${entry.daysOverdue} day(s) past its due date with ${row.reviewerCount - row.returnedCount} reviewer(s) outstanding.`,
          recordType: "design_review",
          recordId: row.id,
        },
      ]);
    }
  }
  return { checked: rows.length, overdue: overdue.length, signalsRaised: raised };
}

/* ================================================================== */
/* Issues                                                              */
/* ================================================================== */

export interface IssueSweepResult {
  checked: number;
  stale: number;
  signalsRaised: number;
}

const STALE_DAYS_BY_PRIORITY: Record<string, number> = {
  critical: 7,
  high: 14,
  medium: 30,
  low: 60,
};

/**
 * An open design issue that has not moved for longer than its priority allows
 * is stale. The threshold is per priority because a critical coordination
 * clash sitting for a fortnight is not the same event as a low-priority note.
 */
export async function sweepIssues(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  asOf: string = nowISO(),
): Promise<IssueSweepResult> {
  const rows = await db
    .select()
    .from(designIssues)
    .where(
      and(
        eq(designIssues.companyId, companyId),
        eq(designIssues.projectId, projectId),
        inArray(designIssues.status, [...OPEN_ISSUE_STATUSES]),
      ),
    );
  if (rows.length === 0) return { checked: 0, stale: 0, signalsRaised: 0 };

  const seen = await alreadySignalled(db, companyId, ["design_issue_stale"], projectId);
  const at = Date.parse(asOf);
  let stale = 0;
  let raised = 0;

  for (const row of rows) {
    const threshold = STALE_DAYS_BY_PRIORITY[row.priority] ?? 30;
    const moved = Date.parse(row.updatedAt ?? row.createdAt);
    if (Number.isNaN(moved) || Number.isNaN(at)) continue;
    const idleDays = Math.floor((at - moved) / 86_400_000);
    if (idleDays < threshold) continue;
    stale += 1;
    // The key includes the threshold bucket the issue crossed, so an issue
    // that goes on rotting re-signals at the next multiple, not every sweep.
    const bucket = Math.floor(idleDays / threshold);
    const key = `design_issue_stale:${row.id}:${bucket}`;
    if (seen.has(key)) continue;
    const signalId = await raiseSignal(db, companyId, projectId, actorId, {
      detector: "design_issue_stale",
      severity: row.priority === "critical" ? "high" : row.priority === "high" ? "medium" : "low",
      confidence: 0.8,
      title: `Design issue ${row.reference} has not moved for ${idleDays} days`,
      explanation: `${row.title} is ${row.priority} priority and routed to ${row.discipline.replace(/_/g, " ")}; it has not been updated for ${idleDays} days against a ${threshold}-day threshold for that priority.`,
      key,
      evidence: {
        issueId: row.id,
        reference: row.reference,
        priority: row.priority,
        discipline: row.discipline,
        idleDays,
        thresholdDays: threshold,
        assignedToUserId: row.assignedToUserId,
      },
    });
    seen.add(key);
    raised += 1;
    await db
      .update(designIssues)
      .set({ staleSignalId: signalId })
      .where(eq(designIssues.id, row.id));
  }
  return { checked: rows.length, stale, signalsRaised: raised };
}

/* ================================================================== */
/* Information requirements                                            */
/* ================================================================== */

export interface InfoRequirementSweepResult {
  checked: number;
  overdue: number;
  obligationsOpened: number;
  signalsRaised: number;
}

/**
 * Overdue EIR/BEP/TIDP milestones: flip the status to `overdue`, open an
 * obligation with the deadline, and raise one signal per (requirement, due
 * date).
 */
export async function sweepInfoRequirements(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  asOf: string = todayISO(),
): Promise<InfoRequirementSweepResult> {
  const rows = await db
    .select()
    .from(designInfoRequirements)
    .where(
      and(
        eq(designInfoRequirements.companyId, companyId),
        eq(designInfoRequirements.projectId, projectId),
        inArray(designInfoRequirements.status, ["planned", "in_progress", "overdue"]),
      ),
    );
  if (rows.length === 0) return { checked: 0, overdue: 0, obligationsOpened: 0, signalsRaised: 0 };

  const seen = await alreadySignalled(db, companyId, ["design_info_requirement_overdue"], projectId);
  const today = asOf.slice(0, 10);
  let overdue = 0;
  let opened = 0;
  let raised = 0;

  for (const row of rows) {
    // Open an obligation for anything with a due date, overdue or not.
    if (row.dueDate && !row.obligationId) {
      const id = newId("obl");
      await db.insert(obligations).values({
        id,
        companyId,
        projectId,
        sourceClause: `Information requirement ${row.reference} (${row.kind.toUpperCase()})`,
        trigger: `${row.title} must be delivered by ${row.dueDate}.`,
        deadline: `${row.dueDate}T00:00:00.000Z`,
        warnDaysBefore: 14,
        evidenceRequirement: "The delivered information recorded against this requirement, verified by someone other than the deliverer.",
        status: "open",
        createdBy: actorId ?? SYSTEM_ACTOR,
      });
      await db
        .update(designInfoRequirements)
        .set({ obligationId: id, updatedAt: nowISO() })
        .where(eq(designInfoRequirements.id, row.id));
      opened += 1;
      await ledger(db, {
        companyId,
        projectId,
        actorId,
        action: "create",
        objectType: "obligation",
        objectId: id,
        payload: { infoRequirementId: row.id, deadline: row.dueDate },
      });
    }

    if (!row.dueDate || row.dueDate >= today) continue;
    overdue += 1;
    if (row.status !== "overdue") {
      await db
        .update(designInfoRequirements)
        .set({ status: "overdue", updatedAt: nowISO() })
        .where(eq(designInfoRequirements.id, row.id));
      await ledger(db, {
        companyId,
        projectId,
        actorId,
        action: "state_change",
        objectType: "design_info_requirement",
        objectId: row.id,
        payload: { from: row.status, to: "overdue", dueDate: row.dueDate },
      });
    }
    const key = `design_info_requirement_overdue:${row.id}:${row.dueDate}`;
    if (seen.has(key)) continue;
    const daysOver = Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${row.dueDate}T00:00:00Z`)) / 86_400_000));
    const signalId = await raiseSignal(db, companyId, projectId, actorId, {
      detector: "design_info_requirement_overdue",
      severity: daysOver >= 30 ? "high" : "medium",
      confidence: 0.9,
      title: `Information requirement ${row.reference} is ${daysOver} day(s) overdue`,
      explanation: `${row.title} (${row.kind.toUpperCase()}) was due on ${row.dueDate} and has not been delivered. An unmet information requirement is the quiet start of most design disputes.`,
      key,
      evidence: {
        infoRequirementId: row.id,
        reference: row.reference,
        kind: row.kind,
        dueDate: row.dueDate,
        daysOverdue: daysOver,
        responsibleUserId: row.responsibleUserId,
        responsibleVendorId: row.responsibleVendorId,
      },
    });
    seen.add(key);
    raised += 1;
    await db
      .update(designInfoRequirements)
      .set({ overdueSignalId: signalId, updatedAt: nowISO() })
      .where(eq(designInfoRequirements.id, row.id));
  }
  return { checked: rows.length, overdue, obligationsOpened: opened, signalsRaised: raised };
}

/* ================================================================== */
/* Change frequency and PI adequacy                                    */
/* ================================================================== */

export interface ChangeFrequencySweepResult {
  packages: number;
  flagged: number;
  signalsRaised: number;
  items: Array<{ packageId: string; ratePerMonth: number; changes: number; postFreeze: number; basis: string }>;
}

export async function sweepChangeFrequency(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  asOf: string = todayISO(),
): Promise<ChangeFrequencySweepResult> {
  const rows = await db
    .select({
      packageId: designChangeNotices.packageId,
      submittedAt: designChangeNotices.submittedAt,
      classification: designChangeNotices.classification,
      isPostFreeze: designChangeNotices.isPostFreeze,
    })
    .from(designChangeNotices)
    .where(and(eq(designChangeNotices.companyId, companyId), eq(designChangeNotices.projectId, projectId)));

  const verdicts = changeFrequency(
    rows.map((r) => ({
      packageId: r.packageId,
      submittedAt: r.submittedAt,
      classification: r.classification,
      isPostFreeze: r.isPostFreeze === 1,
    })),
    asOf,
  );
  const flagged = verdicts.filter((v) => v.exceedsThreshold);
  const seen = await alreadySignalled(db, companyId, ["design_change_frequency"], projectId);
  let raised = 0;

  const names = new Map<string, { reference: string; name: string }>();
  if (flagged.length > 0) {
    const rows2 = await db
      .select({ id: designPackages.id, reference: designPackages.reference, name: designPackages.name })
      .from(designPackages)
      .where(
        and(
          eq(designPackages.projectId, projectId),
          inArray(designPackages.id, flagged.map((f) => f.packageId)),
        ),
      );
    for (const r of rows2) names.set(r.id, { reference: r.reference, name: r.name });
  }

  for (const verdict of flagged) {
    // One signal per package per calendar month of the window's end.
    const key = `design_change_frequency:${verdict.packageId}:${asOf.slice(0, 7)}`;
    if (seen.has(key)) continue;
    const pkg = names.get(verdict.packageId);
    const signalId = await raiseSignal(db, companyId, projectId, actorId, {
      detector: "design_change_frequency",
      severity: verdict.postFreeze > 0 ? "high" : "medium",
      confidence: 0.75,
      title: `Design churn on ${pkg?.reference ?? verdict.packageId}: ${verdict.ratePerMonth} change notices per month`,
      explanation: `${pkg?.name ?? "This package"} has taken ${verdict.changes} change notice(s) in ${verdict.windowDays} days${verdict.postFreeze > 0 ? `, ${verdict.postFreeze} of them post-freeze` : ""}. ${verdict.basis} A churning package is a leading indicator of an unstable brief.`,
      key,
      evidence: {
        packageId: verdict.packageId,
        reference: pkg?.reference ?? null,
        changes: verdict.changes,
        postFreeze: verdict.postFreeze,
        ratePerMonth: verdict.ratePerMonth,
        windowDays: verdict.windowDays,
      },
    });
    seen.add(key);
    raised += 1;
    void signalId;
  }
  return {
    packages: verdicts.length,
    flagged: flagged.length,
    signalsRaised: raised,
    items: verdicts.map((v) => ({
      packageId: v.packageId,
      ratePerMonth: v.ratePerMonth,
      changes: v.changes,
      postFreeze: v.postFreeze,
      basis: v.basis,
    })),
  };
}

export interface PiSweepResult {
  consultants: number;
  inadequate: number;
  signalsRaised: number;
  items: Array<{ consultantId: string; name: string; adequate: boolean | null; shortfall: number | null; expiresInDays: number | null; reasons: string[] }>;
}

export async function sweepProfessionalIndemnity(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  asOf: string = todayISO(),
): Promise<PiSweepResult> {
  const rows = await db
    .select()
    .from(designConsultants)
    .where(
      and(
        eq(designConsultants.companyId, companyId),
        eq(designConsultants.projectId, projectId),
        inArray(designConsultants.status, ["appointed", "active", "novated"]),
      ),
    );
  if (rows.length === 0) return { consultants: 0, inadequate: 0, signalsRaised: 0, items: [] };

  const seen = await alreadySignalled(db, companyId, ["design_pi_inadequate"], projectId);
  let raised = 0;
  const items: PiSweepResult["items"] = [];

  for (const row of rows) {
    const verdict = assessPi(
      {
        id: row.id,
        name: row.name,
        status: row.status,
        piRequiredAmount: row.piRequiredAmount,
        piCoverAmount: row.piCoverAmount,
        piCurrency: row.piCurrency,
        piExpiresOn: row.piExpiresOn,
      },
      asOf,
    );
    items.push({
      consultantId: row.id,
      name: row.name,
      adequate: verdict.adequate,
      shortfall: verdict.shortfall,
      expiresInDays: verdict.expiresInDays,
      reasons: verdict.reasons,
    });
    if (verdict.adequate !== false) continue;
    if (seen.has(verdict.key)) continue;
    const signalId = await raiseSignal(db, companyId, projectId, actorId, {
      detector: "design_pi_inadequate",
      severity: verdict.severity,
      confidence: 0.9,
      title: `Professional indemnity cover for ${row.name} is inadequate`,
      explanation: verdict.reasons.join(" "),
      key: verdict.key,
      evidence: {
        consultantId: row.id,
        vendorId: row.vendorId,
        required: row.piRequiredAmount,
        cover: row.piCoverAmount,
        currency: row.piCurrency,
        expiresOn: row.piExpiresOn,
        shortfall: verdict.shortfall,
        expiresInDays: verdict.expiresInDays,
      },
    });
    seen.add(verdict.key);
    raised += 1;
    await db
      .update(designConsultants)
      .set({ piSignalId: signalId, updatedAt: nowISO() })
      .where(eq(designConsultants.id, row.id));
  }
  return { consultants: rows.length, inadequate: items.filter((i) => i.adequate === false).length, signalsRaised: raised, items };
}

/* ================================================================== */
/* Freeze position for a change notice                                 */
/* ================================================================== */

export async function loadFreezes(db: Db, companyId: string, projectId: string): Promise<FreezeRecord[]> {
  const rows = await db
    .select()
    .from(designFreezes)
    .where(and(eq(designFreezes.companyId, companyId), eq(designFreezes.projectId, projectId)));
  return rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    packageId: r.packageId,
    stageKey: r.stageKey,
    status: r.status,
    effectiveFrom: r.effectiveFrom,
    requiredAuthorisation: r.requiredAuthorisation,
  }));
}

export async function freezeFor(
  db: Db,
  companyId: string,
  projectId: string,
  target: { packageId: string | null; stageKey: string | null },
  atISO: string,
) {
  return freezePosition(await loadFreezes(db, companyId, projectId), target, atISO);
}

/* ================================================================== */
/* Handover readiness                                                  */
/* ================================================================== */

export interface ReadinessResult extends ReadinessVerdict {
  projectId: string;
  packageId: string | null;
  computedAt: string;
  snapshotId: string | null;
  snapshotWritten: boolean;
}

/**
 * Compute readiness for a project (or one package) and write a snapshot only
 * when the verdict moved — a snapshot per page-load is noise, not history.
 */
export async function computeReadiness(
  db: Db,
  companyId: string,
  projectId: string,
  packageId: string | null,
  actorId: string | null,
  options: { persist?: boolean } = {},
): Promise<ReadinessResult> {
  const packageWhere = packageId ? eq(designPackages.id, packageId) : undefined;
  const packages = await db
    .select({ id: designPackages.id, status: designPackages.status, stageKey: designPackages.stageKey })
    .from(designPackages)
    .where(and(eq(designPackages.companyId, companyId), eq(designPackages.projectId, projectId), packageWhere));

  const [reviews, comments, issues, deliverables, infoRequirements, notices, freezes] = await Promise.all([
    db
      .select({ packageId: designReviews.packageId, status: designReviews.status, consolidatedCode: designReviews.consolidatedCode })
      .from(designReviews)
      .where(
        and(
          eq(designReviews.companyId, companyId),
          eq(designReviews.projectId, projectId),
          packageId ? eq(designReviews.packageId, packageId) : undefined,
        ),
      ),
    db
      .select({ status: designComments.status })
      .from(designComments)
      .where(
        and(
          eq(designComments.companyId, companyId),
          eq(designComments.projectId, projectId),
          packageId ? eq(designComments.packageId, packageId) : undefined,
        ),
      ),
    db
      .select({ status: designIssues.status, priority: designIssues.priority })
      .from(designIssues)
      .where(
        and(
          eq(designIssues.companyId, companyId),
          eq(designIssues.projectId, projectId),
          packageId ? eq(designIssues.packageId, packageId) : undefined,
        ),
      ),
    db
      .select({ status: designDeliverables.status, slippageLevel: designDeliverables.slippageLevel })
      .from(designDeliverables)
      .where(
        and(
          eq(designDeliverables.companyId, companyId),
          eq(designDeliverables.projectId, projectId),
          packageId ? eq(designDeliverables.packageId, packageId) : undefined,
        ),
      ),
    db
      .select({ status: designInfoRequirements.status })
      .from(designInfoRequirements)
      .where(
        and(
          eq(designInfoRequirements.companyId, companyId),
          eq(designInfoRequirements.projectId, projectId),
          packageId ? eq(designInfoRequirements.packageId, packageId) : undefined,
        ),
      ),
    db
      .select({ status: designChangeNotices.status, isPostFreeze: designChangeNotices.isPostFreeze })
      .from(designChangeNotices)
      .where(
        and(
          eq(designChangeNotices.companyId, companyId),
          eq(designChangeNotices.projectId, projectId),
          packageId ? eq(designChangeNotices.packageId, packageId) : undefined,
        ),
      ),
    db
      .select({ id: designFreezes.id })
      .from(designFreezes)
      .where(
        and(
          eq(designFreezes.companyId, companyId),
          eq(designFreezes.projectId, projectId),
          eq(designFreezes.status, "active"),
          packageId ? or(eq(designFreezes.packageId, packageId), ne(designFreezes.scope, "package")) : undefined,
        ),
      ),
  ]);

  const verdict = assessReadiness({
    packages,
    reviews,
    openComments: comments.filter((c) => c.status === "open" || c.status === "responded").length,
    totalComments: comments.length,
    issues,
    deliverables,
    infoRequirements,
    changeNotices: notices.map((n) => ({ status: n.status, isPostFreeze: n.isPostFreeze === 1 })),
    activeFreezes: freezes.length,
  });

  const computedAt = nowISO();
  let snapshotId: string | null = null;
  let snapshotWritten = false;

  if (options.persist !== false) {
    const [previous] = await db
      .select()
      .from(designReadinessSnapshots)
      .where(
        and(
          eq(designReadinessSnapshots.companyId, companyId),
          eq(designReadinessSnapshots.projectId, projectId),
          packageId ? eq(designReadinessSnapshots.packageId, packageId) : isNull(designReadinessSnapshots.packageId),
        ),
      )
      .orderBy(desc(designReadinessSnapshots.computedAt))
      .limit(1);
    const moved =
      !previous ||
      previous.level !== verdict.level ||
      Math.abs((previous.score ?? -1) - (verdict.score ?? -1)) >= 1 ||
      (previous.blockers ?? []).length !== verdict.blockers.length;
    if (moved) {
      snapshotId = newId("drs");
      await db.insert(designReadinessSnapshots).values({
        id: snapshotId,
        companyId,
        projectId,
        packageId,
        computedAt,
        score: verdict.score,
        level: verdict.level,
        confidence: verdict.confidence,
        dimensions: verdict.dimensions,
        blockers: verdict.blockers,
        reasons: verdict.reasons,
        computedBy: actorId,
      });
      snapshotWritten = true;
      await ledger(db, {
        companyId,
        projectId,
        actorId,
        action: "create",
        objectType: "design_readiness",
        objectId: snapshotId,
        payload: { level: verdict.level, score: verdict.score, packageId, blockers: verdict.blockers.length },
      });
    } else {
      snapshotId = previous.id;
    }
  }

  return { ...verdict, projectId, packageId, computedAt, snapshotId, snapshotWritten };
}

/* ================================================================== */
/* Analytics and summary                                               */
/* ================================================================== */

export interface DesignAnalytics {
  asOf: string;
  reviewCycles: ReturnType<typeof cycleTimeStats>;
  deliverables: ReturnType<typeof slippageStats> & {
    byConsultant: ReturnType<typeof slippageByConsultant>;
  };
  changeFrequency: Array<{ packageId: string; reference: string | null; changes: number; postFreeze: number; ratePerMonth: number; exceedsThreshold: boolean; basis: string }>;
  issues: {
    total: number;
    open: number;
    byStatus: Record<string, number>;
    byDiscipline: Record<string, number>;
    byPriority: Record<string, number>;
    averageOpenAgeDays: number | null;
    averageResolutionDays: number | null;
    reasons: string[];
  };
  changeNotices: {
    total: number;
    byStatus: Record<string, number>;
    byClassification: Record<string, number>;
    byOriginator: Record<string, number>;
    postFreeze: number;
    costByCurrency: Record<string, number>;
    currencyNote: string | null;
    timeDaysApproved: number | null;
  };
}

export async function designAnalytics(
  db: Db,
  companyId: string,
  projectId: string,
  asOf: string = todayISO(),
): Promise<DesignAnalytics> {
  const [reviewRows, deliverableRows, issueRows, dcnRows, packageRows] = await Promise.all([
    db
      .select({
        id: designReviews.id,
        packageId: designReviews.packageId,
        cycleNumber: designReviews.cycleNumber,
        issuedAt: designReviews.issuedAt,
        dueAt: designReviews.dueAt,
        closedAt: designReviews.closedAt,
        consolidatedCode: designReviews.consolidatedCode,
        status: designReviews.status,
      })
      .from(designReviews)
      .where(and(eq(designReviews.companyId, companyId), eq(designReviews.projectId, projectId))),
    db
      .select({
        id: designDeliverables.id,
        consultantId: designDeliverables.consultantId,
        discipline: designDeliverables.discipline,
        packageId: designDeliverables.packageId,
        status: designDeliverables.status,
        slippageLevel: designDeliverables.slippageLevel,
        slippageDays: designDeliverables.slippageDays,
        plannedIssueDate: designDeliverables.plannedIssueDate,
        actualIssueDate: designDeliverables.actualIssueDate,
      })
      .from(designDeliverables)
      .where(and(eq(designDeliverables.companyId, companyId), eq(designDeliverables.projectId, projectId))),
    db
      .select()
      .from(designIssues)
      .where(and(eq(designIssues.companyId, companyId), eq(designIssues.projectId, projectId))),
    db
      .select()
      .from(designChangeNotices)
      .where(and(eq(designChangeNotices.companyId, companyId), eq(designChangeNotices.projectId, projectId))),
    db
      .select({ id: designPackages.id, reference: designPackages.reference })
      .from(designPackages)
      .where(and(eq(designPackages.companyId, companyId), eq(designPackages.projectId, projectId))),
  ]);

  const cycles: CycleTimeInput[] = reviewRows.map((r) => ({
    id: r.id,
    packageId: r.packageId,
    cycleNumber: r.cycleNumber,
    issuedAt: r.issuedAt,
    dueAt: r.dueAt,
    closedAt: r.closedAt,
    consolidatedCode: r.consolidatedCode,
    status: r.status,
  }));

  const slippageRows: SlippageRow[] = deliverableRows.map((d) => ({
    id: d.id,
    consultantId: d.consultantId,
    discipline: d.discipline,
    packageId: d.packageId,
    status: d.status,
    slippageLevel: d.slippageLevel,
    slippageDays: d.slippageDays,
    plannedIssueDate: d.plannedIssueDate,
    actualIssueDate: d.actualIssueDate,
  }));

  const packageRef = new Map(packageRows.map((p) => [p.id, p.reference]));
  const frequency = changeFrequency(
    dcnRows.map((n) => ({
      packageId: n.packageId,
      submittedAt: n.submittedAt,
      classification: n.classification,
      isPostFreeze: n.isPostFreeze === 1,
    })),
    asOf,
  ).map((f) => ({ ...f, reference: packageRef.get(f.packageId) ?? null }));

  /* issues ---------------------------------------------------------- */
  const openIssues = issueRows.filter((i) => (OPEN_ISSUE_STATUSES as readonly string[]).includes(i.status));
  const at = Date.parse(asOf.length > 10 ? asOf : `${asOf}T00:00:00Z`);
  const openAges = openIssues
    .map((i) => {
      const raised = Date.parse(i.raisedAt ?? i.createdAt);
      return Number.isNaN(raised) || Number.isNaN(at) ? null : (at - raised) / 86_400_000;
    })
    .filter((x): x is number => x !== null);
  const resolutionDays = issueRows
    .map((i) => {
      if (!i.resolvedAt) return null;
      const raised = Date.parse(i.raisedAt ?? i.createdAt);
      const resolved = Date.parse(i.resolvedAt);
      return Number.isNaN(raised) || Number.isNaN(resolved) ? null : (resolved - raised) / 86_400_000;
    })
    .filter((x): x is number => x !== null);
  const issueReasons: string[] = [];
  if (openIssues.length === 0) issueReasons.push("No open design issue, so open age is not available.");
  if (resolutionDays.length === 0) issueReasons.push("No issue has been resolved, so resolution time is not available.");

  /* change notices --------------------------------------------------- */
  const costByCurrency: Record<string, number> = {};
  for (const n of dcnRows) {
    if (n.assessedCost === null || !Number.isFinite(n.assessedCost)) continue;
    if (n.status === "rejected" || n.status === "withdrawn" || n.status === "draft") continue;
    const currency = (n.currency || "USD").toUpperCase();
    costByCurrency[currency] = Math.round(((costByCurrency[currency] ?? 0) + n.assessedCost) * 100) / 100;
  }
  const approvedTime = dcnRows
    .filter((n) => n.status === "approved" || n.status === "implemented")
    .map((n) => n.assessedTimeDays)
    .filter((x): x is number => typeof x === "number" && Number.isFinite(x));

  const roundOrNull = (v: number | null): number | null => (v === null ? null : Math.round(v * 10) / 10);

  return {
    asOf,
    reviewCycles: cycleTimeStats(cycles, asOf.length > 10 ? asOf : `${asOf}T00:00:00Z`),
    deliverables: { ...slippageStats(slippageRows), byConsultant: slippageByConsultant(slippageRows) },
    changeFrequency: frequency,
    issues: {
      total: issueRows.length,
      open: openIssues.length,
      byStatus: tally(issueRows, (i) => i.status),
      byDiscipline: tally(issueRows, (i) => i.discipline),
      byPriority: tally(openIssues, (i) => i.priority),
      averageOpenAgeDays: roundOrNull(mean(openAges)),
      averageResolutionDays: roundOrNull(mean(resolutionDays)),
      reasons: issueReasons,
    },
    changeNotices: {
      total: dcnRows.length,
      byStatus: tally(dcnRows, (n) => n.status),
      byClassification: tally(dcnRows, (n) => n.classification),
      byOriginator: tally(dcnRows, (n) => n.originator),
      postFreeze: dcnRows.filter((n) => n.isPostFreeze === 1).length,
      costByCurrency,
      currencyNote:
        Object.keys(costByCurrency).length > 1
          ? "Change notice cost is reported per currency and never added across currencies."
          : null,
      timeDaysApproved: approvedTime.length === 0 ? null : approvedTime.reduce((a, b) => a + b, 0),
    },
  };
}

export interface DesignSummary {
  asOf: string;
  packages: { total: number; byStatus: Record<string, number>; byDiscipline: Record<string, number>; frozen: number; approved: number };
  stages: { planned: number; open: number; signedOff: number; current: { stageKey: string; label: string | null } | null };
  reviews: { open: number; overdue: number; total: number; averageTurnaroundDays: Figure; byCode: Record<string, number> };
  comments: { total: number; open: number };
  issues: { total: number; open: number; criticalOpen: number; byDiscipline: Record<string, number> };
  decisions: { total: number; proposed: number; decided: number };
  deliverables: { total: number; late: number; atRisk: number; issued: number; onTimePercent: Figure };
  changeNotices: { total: number; open: number; postFreeze: number; costByCurrency: Record<string, number>; currencyNote: string | null };
  infoRequirements: { total: number; overdue: number; delivered: number; verified: number };
  consultants: { total: number; piInadequate: number; piUnknown: number };
  freezes: { active: number };
  readiness: { level: string; score: number | null; confidence: number; blockers: string[]; computedAt: string | null };
  signals: { open: number; bySeverity: Record<string, number>; items: Array<{ id: string; detector: string; severity: string; title: string; explanation: string; disposition: string; createdAt: string }> };
}

const DESIGN_DETECTOR_LIST: readonly DesignDetector[] = [
  "design_deliverable_late",
  "design_review_overdue",
  "design_post_freeze_change",
  "design_issue_stale",
  "design_change_frequency",
  "design_info_requirement_overdue",
  "design_pi_inadequate",
];

export async function designSummary(
  db: Db,
  companyId: string,
  projectId: string,
  asOf: string = todayISO(),
): Promise<DesignSummary> {
  const [
    packageRows,
    stageRows,
    reviewRows,
    commentRows,
    issueRows,
    decisionRows,
    deliverableRows,
    dcnRows,
    infoRows,
    consultantRows,
    freezeRows,
    readinessRows,
    signalRows,
  ] = await Promise.all([
    db.select().from(designPackages).where(and(eq(designPackages.companyId, companyId), eq(designPackages.projectId, projectId))),
    db
      .select({ stageKey: designStageGates.stageKey, status: designStageGates.status, label: designStageGates.label, framework: designStageGates.framework })
      .from(designStageGates)
      .where(and(eq(designStageGates.companyId, companyId), eq(designStageGates.projectId, projectId))),
    db.select().from(designReviews).where(and(eq(designReviews.companyId, companyId), eq(designReviews.projectId, projectId))),
    db.select({ status: designComments.status }).from(designComments).where(and(eq(designComments.companyId, companyId), eq(designComments.projectId, projectId))),
    db.select().from(designIssues).where(and(eq(designIssues.companyId, companyId), eq(designIssues.projectId, projectId))),
    db
      .select({ status: designDecisions.status })
      .from(designDecisions)
      .where(and(eq(designDecisions.companyId, companyId), eq(designDecisions.projectId, projectId))),
    db.select().from(designDeliverables).where(and(eq(designDeliverables.companyId, companyId), eq(designDeliverables.projectId, projectId))),
    db.select().from(designChangeNotices).where(and(eq(designChangeNotices.companyId, companyId), eq(designChangeNotices.projectId, projectId))),
    db.select({ status: designInfoRequirements.status }).from(designInfoRequirements).where(and(eq(designInfoRequirements.companyId, companyId), eq(designInfoRequirements.projectId, projectId))),
    db.select().from(designConsultants).where(and(eq(designConsultants.companyId, companyId), eq(designConsultants.projectId, projectId))),
    db.select({ id: designFreezes.id }).from(designFreezes).where(and(eq(designFreezes.companyId, companyId), eq(designFreezes.projectId, projectId), eq(designFreezes.status, "active"))),
    db
      .select()
      .from(designReadinessSnapshots)
      .where(and(eq(designReadinessSnapshots.companyId, companyId), eq(designReadinessSnapshots.projectId, projectId), isNull(designReadinessSnapshots.packageId)))
      .orderBy(desc(designReadinessSnapshots.computedAt))
      .limit(1),
    db
      .select()
      .from(signals)
      .where(and(eq(signals.companyId, companyId), eq(signals.projectId, projectId), inArray(signals.detector, [...DESIGN_DETECTOR_LIST])))
      .orderBy(desc(signals.createdAt))
      .limit(200),
  ]);

  const openReviews = reviewRows.filter((r) => (OPEN_REVIEW_STATUSES as readonly string[]).includes(r.status));
  const turnarounds = reviewRows.map((r) => r.turnaroundDays).filter((x): x is number => typeof x === "number");
  const openIssues = issueRows.filter((i) => (OPEN_ISSUE_STATUSES as readonly string[]).includes(i.status));
  const slippage = slippageStats(
    deliverableRows.map((d) => ({
      id: d.id,
      consultantId: d.consultantId,
      discipline: d.discipline,
      packageId: d.packageId,
      status: d.status,
      slippageLevel: d.slippageLevel,
      slippageDays: d.slippageDays,
      plannedIssueDate: d.plannedIssueDate,
      actualIssueDate: d.actualIssueDate,
    })),
  );
  const costByCurrency: Record<string, number> = {};
  for (const n of dcnRows) {
    if (n.assessedCost === null || !Number.isFinite(n.assessedCost)) continue;
    if (n.status === "rejected" || n.status === "withdrawn" || n.status === "draft") continue;
    const currency = (n.currency || "USD").toUpperCase();
    costByCurrency[currency] = Math.round(((costByCurrency[currency] ?? 0) + n.assessedCost) * 100) / 100;
  }

  const piVerdicts = consultantRows.map((c) =>
    assessPi(
      {
        id: c.id,
        name: c.name,
        status: c.status,
        piRequiredAmount: c.piRequiredAmount,
        piCoverAmount: c.piCoverAmount,
        piCurrency: c.piCurrency,
        piExpiresOn: c.piExpiresOn,
      },
      asOf,
    ),
  );

  const openSignals = signalRows.filter((s) => s.disposition === "new" || s.disposition === "triaged" || s.disposition === "investigating");
  const latestReadiness = readinessRows[0] ?? null;

  return {
    asOf,
    packages: {
      total: packageRows.length,
      byStatus: tally(packageRows, (p) => p.status),
      byDiscipline: tally(packageRows, (p) => p.discipline),
      frozen: packageRows.filter((p) => p.frozenAt !== null).length,
      approved: packageRows.filter((p) => p.status === "approved" || p.status === "frozen").length,
    },
    stages: {
      planned: stageRows.filter((g) => g.status === "planned").length,
      open: stageRows.filter((g) => g.status === "open").length,
      signedOff: stageRows.filter((g) => g.status === "signed_off").length,
      current: (() => {
        const open = stageRows
          .filter((g) => g.status === "open")
          .sort((a, b) => (stageOrder(a.stageKey) ?? 99) - (stageOrder(b.stageKey) ?? 99))[0];
        const next = open ??
          stageRows
            .filter((g) => g.status === "planned")
            .sort((a, b) => (stageOrder(a.stageKey) ?? 99) - (stageOrder(b.stageKey) ?? 99))[0];
        if (!next) return null;
        return {
          stageKey: next.stageKey,
          label: next.label ?? stageLabel(next.stageKey, isFramework(next.framework) ? next.framework : "riba_2020"),
        };
      })(),
    },
    reviews: {
      open: openReviews.length,
      overdue: overdueCycles(
        reviewRows.map((r) => ({
          id: r.id,
          packageId: r.packageId,
          cycleNumber: r.cycleNumber,
          issuedAt: r.issuedAt,
          dueAt: r.dueAt,
          closedAt: r.closedAt,
          consolidatedCode: r.consolidatedCode,
          status: r.status,
        })),
        asOf.length > 10 ? asOf : `${asOf}T00:00:00Z`,
      ).length,
      total: reviewRows.length,
      averageTurnaroundDays: figure(
        turnarounds.length === 0 ? null : Math.round((turnarounds.reduce((a, b) => a + b, 0) / turnarounds.length) * 10) / 10,
        "days",
        { closedCycles: turnarounds.length },
        turnarounds.length === 0 ? ["No review cycle has closed with both an issue and a close date."] : [],
      ),
      byCode: tally(reviewRows, (r) => r.consolidatedCode),
    },
    comments: {
      total: commentRows.length,
      open: commentRows.filter((c) => c.status === "open" || c.status === "responded").length,
    },
    issues: {
      total: issueRows.length,
      open: openIssues.length,
      criticalOpen: openIssues.filter((i) => i.priority === "critical" || i.priority === "high").length,
      byDiscipline: tally(openIssues, (i) => i.discipline),
    },
    decisions: {
      total: decisionRows.length,
      proposed: decisionRows.filter((d) => d.status === "proposed").length,
      decided: decisionRows.filter((d) => d.status === "decided").length,
    },
    deliverables: {
      total: deliverableRows.length,
      late: deliverableRows.filter((d) => d.slippageLevel === "late").length,
      atRisk: deliverableRows.filter((d) => d.slippageLevel === "at_risk").length,
      issued: slippage.issued,
      onTimePercent: figure(slippage.onTimePercent, "%", { issued: slippage.issued, onTime: slippage.issuedOnTime }, slippage.reasons),
    },
    changeNotices: {
      total: dcnRows.length,
      open: dcnRows.filter((n) => (OPEN_DCN_STATUSES as readonly string[]).includes(n.status)).length,
      postFreeze: dcnRows.filter((n) => n.isPostFreeze === 1).length,
      costByCurrency,
      currencyNote:
        Object.keys(costByCurrency).length > 1
          ? "Reported per currency and never added: a single total would need an FX rate and a date."
          : null,
    },
    infoRequirements: {
      total: infoRows.length,
      overdue: infoRows.filter((r) => r.status === "overdue").length,
      delivered: infoRows.filter((r) => r.status === "delivered").length,
      verified: infoRows.filter((r) => r.status === "verified").length,
    },
    consultants: {
      total: consultantRows.length,
      piInadequate: piVerdicts.filter((v) => v.adequate === false).length,
      piUnknown: piVerdicts.filter((v) => v.adequate === null).length,
    },
    freezes: { active: freezeRows.length },
    readiness: {
      level: latestReadiness?.level ?? "not_assessable",
      score: latestReadiness?.score ?? null,
      confidence: latestReadiness?.confidence ?? 0,
      blockers: latestReadiness?.blockers ?? [],
      computedAt: latestReadiness?.computedAt ?? null,
    },
    signals: {
      open: openSignals.length,
      bySeverity: tally(openSignals, (s) => s.severity),
      items: signalRows.slice(0, 25).map((s) => ({
        id: s.id,
        detector: s.detector,
        severity: s.severity,
        title: s.title,
        explanation: s.explanation,
        disposition: s.disposition,
        createdAt: s.createdAt,
      })),
    },
  };
}

/* ================================================================== */
/* Health inputs (contract 3.5)                                        */
/* ================================================================== */

export interface HealthInputs {
  metrics: Record<string, number | null>;
  reasons: string[];
}

export async function designHealthInputs(
  db: Db,
  companyId: string,
  projectId: string,
  asOf: string = todayISO(),
): Promise<HealthInputs> {
  const summary = await designSummary(db, companyId, projectId, asOf);
  const reasons: string[] = [];
  if (summary.packages.total === 0) reasons.push("No design package is registered for this project.");
  if (summary.deliverables.total === 0) reasons.push("No consultant deliverable schedule exists, so deliverable slippage is unknown.");
  if (summary.readiness.computedAt === null) reasons.push("Handover readiness has not been computed yet.");
  reasons.push(...summary.deliverables.onTimePercent.reasons);

  return {
    metrics: {
      designPackages: summary.packages.total,
      designPackagesApproved: summary.packages.approved,
      designReviewsOpen: summary.reviews.open,
      designReviewsOverdue: summary.reviews.overdue,
      designReviewAverageTurnaroundDays: summary.reviews.averageTurnaroundDays.value,
      designCommentsOpen: summary.comments.open,
      designIssuesOpen: summary.issues.open,
      designIssuesCriticalOpen: summary.issues.criticalOpen,
      designDeliverablesLate: summary.deliverables.late,
      designDeliverablesAtRisk: summary.deliverables.atRisk,
      designDeliverableOnTimePercent: summary.deliverables.onTimePercent.value,
      designChangeNoticesOpen: summary.changeNotices.open,
      designChangeNoticesPostFreeze: summary.changeNotices.postFreeze,
      designInfoRequirementsOverdue: summary.infoRequirements.overdue,
      designConsultantsPiInadequate: summary.consultants.piInadequate,
      designReadinessScore: summary.readiness.score,
      designOpenSignals: summary.signals.open,
    },
    reasons,
  };
}

