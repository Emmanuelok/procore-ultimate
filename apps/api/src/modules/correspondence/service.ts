/**
 * Correspondence service — everything that reads or writes more than one
 * table, so route handlers stay thin and the scheduler jobs call exactly the
 * same code a button does.
 *
 * Every sweep here is IDEMPOTENT: a condition already signalled produces
 * nothing the second time (dedupe keys in `signals.evidenceRefs.key`), a
 * person already chased is not chased again (`overdue_notified_at`), and a
 * derived status that has not moved writes nothing.
 *
 * Covers: response-due chasing (#446), acknowledgement chasing (#443),
 * action-plan progress and quality-checkpoint gating (#454–456), form
 * assignment chasing (#460), and the register/summary/health-input reads the
 * workspace and the intelligence layer consume.
 */
import { and, asc, eq, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import {
  actionPlanActivities,
  actionPlans,
  correspondenceInboundMessages,
  correspondenceLetters,
  correspondenceRecipients,
  formAssignments,
  formResponses,
  formTemplates,
  signals,
  transmittals,
} from "@constructos/db";
import type { Db } from "../../lib/db.js";
import { pushNotifications } from "../notifications/service.js";
import { daysBetween } from "./engines/dates.js";
import {
  completionReport,
  derivePlanStatus,
  planProgress,
  type ActivityInput,
  type PlanProgress,
} from "./engines/plans.js";
import {
  ackPosition,
  assessLetter,
  deriveTransmittalStatus,
  registerStats,
  type AckPosition,
  type LetterInput,
  type RecipientInput,
} from "./engines/tracking.js";
import {
  alreadySignalled,
  figure,
  ledger,
  nowISO,
  raiseSignal,
  settleObligation,
  type Figure,
} from "./shared.js";

/* ------------------------------------------------------------------ */
/* Loaders                                                             */
/* ------------------------------------------------------------------ */

const LETTER_COLUMNS = {
  id: correspondenceLetters.id,
  reference: correspondenceLetters.reference,
  typeKey: correspondenceLetters.typeKey,
  direction: correspondenceLetters.direction,
  status: correspondenceLetters.status,
  priority: correspondenceLetters.priority,
  responseRequired: correspondenceLetters.responseRequired,
  responseDueDate: correspondenceLetters.responseDueDate,
  respondedAt: correspondenceLetters.respondedAt,
  issuedAt: correspondenceLetters.issuedAt,
  letterDate: correspondenceLetters.letterDate,
  createdAt: correspondenceLetters.createdAt,
} as const;

type LetterRow = {
  id: string;
  reference: string;
  typeKey: string;
  direction: string;
  status: string;
  priority: string;
  responseRequired: number;
  responseDueDate: string | null;
  respondedAt: string | null;
  issuedAt: string | null;
  letterDate: string | null;
  createdAt: string;
};

export const toLetterInput = (row: LetterRow): LetterInput => ({
  id: row.id,
  reference: row.reference,
  typeKey: row.typeKey,
  direction: row.direction,
  status: row.status,
  priority: row.priority,
  responseRequired: row.responseRequired === 1,
  responseDueDate: row.responseDueDate,
  respondedAt: row.respondedAt,
  issuedAt: row.issuedAt,
  letterDate: row.letterDate,
  createdAt: row.createdAt,
});

export async function loadRecipients(
  db: Db,
  companyId: string,
  recordType: "letter" | "transmittal",
  recordId: string,
) {
  return db
    .select()
    .from(correspondenceRecipients)
    .where(
      and(
        eq(correspondenceRecipients.companyId, companyId),
        eq(correspondenceRecipients.recordType, recordType),
        eq(correspondenceRecipients.recordId, recordId),
      ),
    )
    .orderBy(asc(correspondenceRecipients.createdAt));
}

export const toRecipientInput = (row: {
  id: string;
  name: string;
  kind: string;
  acknowledgementRequired: number;
  acknowledgedAt: string | null;
  firstReadAt: string | null;
  deliveryStatus: string;
}): RecipientInput => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  acknowledgementRequired: row.acknowledgementRequired === 1,
  acknowledgedAt: row.acknowledgedAt,
  firstReadAt: row.firstReadAt,
  deliveryStatus: row.deliveryStatus,
});

export async function loadPlanActivities(
  db: Db,
  companyId: string,
  planId: string,
) {
  return db
    .select()
    .from(actionPlanActivities)
    .where(
      and(eq(actionPlanActivities.companyId, companyId), eq(actionPlanActivities.planId, planId)),
    )
    .orderBy(asc(actionPlanActivities.seq));
}

export const toActivityInput = (row: {
  id: string;
  seq: number;
  title: string;
  status: string;
  isQualityCheckpoint: number;
  evidenceRequired: number;
  evidenceFileIds: string[];
  signoffRequiredCount: number;
  signoffCount: number;
  dueDate: string | null;
}): ActivityInput => ({
  id: row.id,
  seq: row.seq,
  title: row.title,
  status: row.status,
  isQualityCheckpoint: row.isQualityCheckpoint === 1,
  evidenceRequired: row.evidenceRequired === 1,
  evidenceFileIds: row.evidenceFileIds ?? [],
  signoffRequiredCount: row.signoffRequiredCount,
  signoffCount: row.signoffCount,
  dueDate: row.dueDate,
});

/* ------------------------------------------------------------------ */
/* Derived-state synchronisation                                       */
/* ------------------------------------------------------------------ */

/**
 * Recompute a transmittal's acknowledgement counters and status from its
 * recipients. Writes only when something moved, and settles the
 * acknowledgement obligation the moment the last recipient acknowledges.
 */
export async function syncTransmittal(
  db: Db,
  companyId: string,
  projectId: string,
  transmittalId: string,
  actorId: string | null,
  today: string,
): Promise<{ position: AckPosition; status: string }> {
  const rows = await db
    .select()
    .from(transmittals)
    .where(and(eq(transmittals.id, transmittalId), eq(transmittals.companyId, companyId)))
    .limit(1);
  const record = rows[0];
  if (!record) throw new Error(`Transmittal ${transmittalId} vanished during sync`);
  const recipients = (await loadRecipients(db, companyId, "transmittal", transmittalId)).map(
    toRecipientInput,
  );
  const position = ackPosition(recipients, record.ackDueDate, today);
  const status = deriveTransmittalStatus(record.status, position);

  const [{ items = 0 } = { items: 0 }] = await db
    .select({ items: sql<number>`count(*)::int` })
    .from(correspondenceRecipients)
    .where(
      and(
        eq(correspondenceRecipients.companyId, companyId),
        eq(correspondenceRecipients.recordType, "transmittal"),
        eq(correspondenceRecipients.recordId, transmittalId),
      ),
    );

  const changed =
    record.status !== status ||
    record.recipientCount !== items ||
    record.ackRequiredCount !== position.required ||
    record.acknowledgedCount !== position.acknowledged;

  if (changed) {
    await db
      .update(transmittals)
      .set({
        status,
        recipientCount: items,
        ackRequiredCount: position.required,
        acknowledgedCount: position.acknowledged,
        updatedAt: nowISO(),
      })
      .where(eq(transmittals.id, transmittalId));
    if (record.status !== status) {
      await ledger(db, {
        companyId,
        projectId,
        actorId,
        action: "state_change",
        objectType: "transmittal",
        objectId: transmittalId,
        payload: { from: record.status, to: status, acknowledged: position.acknowledged, required: position.required },
      });
    }
  }

  if (status === "acknowledged" && record.obligationId) {
    await settleObligation(
      db,
      companyId,
      projectId,
      actorId,
      record.obligationId,
      "satisfied",
      `Every recipient of ${record.reference} acknowledged receipt.`,
    );
    await db.update(transmittals).set({ obligationId: null }).where(eq(transmittals.id, transmittalId));
  }

  return { position, status };
}

/**
 * Recompute an action plan's progress and status from its activities. The
 * quality-checkpoint gate is the reason this is engine-driven rather than a
 * running counter: a checkpoint that fails re-blocks everything after it.
 */
export async function syncPlan(
  db: Db,
  companyId: string,
  projectId: string,
  planId: string,
  actorId: string | null,
  today: string,
): Promise<{ progress: PlanProgress; status: string }> {
  const rows = await db
    .select()
    .from(actionPlans)
    .where(and(eq(actionPlans.id, planId), eq(actionPlans.companyId, companyId)))
    .limit(1);
  const plan = rows[0];
  if (!plan) throw new Error(`Action plan ${planId} vanished during sync`);
  const activities = (await loadPlanActivities(db, companyId, planId)).map(toActivityInput);
  const progress = planProgress(activities, today);
  const status = derivePlanStatus(plan.status, progress);
  const blockedReason = progress.heldBy
    ? `Held behind quality checkpoint ${progress.heldBy.seq} ("${progress.heldBy.title}").`
    : null;

  const changed =
    plan.status !== status ||
    plan.activityCount !== progress.total ||
    plan.completedCount !== progress.signedOff + progress.waived ||
    plan.progressPercent !== progress.percent ||
    plan.blockedReason !== blockedReason;

  if (changed) {
    await db
      .update(actionPlans)
      .set({
        status,
        activityCount: progress.total,
        completedCount: progress.signedOff + progress.waived,
        progressPercent: progress.percent,
        blockedReason,
        completedAt: status === "completed" ? (plan.completedAt ?? nowISO()) : null,
        updatedAt: nowISO(),
      })
      .where(eq(actionPlans.id, planId));
    if (plan.status !== status) {
      await ledger(db, {
        companyId,
        projectId,
        actorId,
        action: "state_change",
        objectType: "action_plan",
        objectId: planId,
        payload: { from: plan.status, to: status, percent: progress.percent },
      });
    }
  }
  return { progress, status };
}

/* ------------------------------------------------------------------ */
/* Sweeps                                                              */
/* ------------------------------------------------------------------ */

export interface SweepResult {
  scanned: number;
  raised: number;
  notified: number;
  cleared: number;
}

const emptySweep = (): SweepResult => ({ scanned: 0, raised: 0, notified: 0, cleared: 0 });

/**
 * Letters whose response date has passed with no answer (#446). One signal
 * and one nudge per letter, ever — the sweep runs every 30 minutes and a
 * register that shouts hourly is a register nobody reads.
 */
export async function sweepResponseDue(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  today: string,
): Promise<SweepResult> {
  const result = emptySweep();
  const rows = await db
    .select()
    .from(correspondenceLetters)
    .where(
      and(
        eq(correspondenceLetters.companyId, companyId),
        eq(correspondenceLetters.projectId, projectId),
        eq(correspondenceLetters.responseRequired, 1),
        isNull(correspondenceLetters.respondedAt),
        isNotNull(correspondenceLetters.responseDueDate),
        inArray(correspondenceLetters.status, ["issued", "acknowledged"]),
      ),
    )
    .limit(5000);
  result.scanned = rows.length;
  if (rows.length === 0) return result;

  const seen = await alreadySignalled(db, companyId, ["correspondence_response_overdue"], projectId);
  for (const row of rows) {
    const assessment = assessLetter(toLetterInput(row), today);
    if (!assessment.overdue || assessment.daysOverdue === null) continue;
    const key = `corr:letter:${row.id}:response_overdue`;
    if (!seen.has(key)) {
      await raiseSignal(db, companyId, projectId, actorId, {
        detector: "correspondence_response_overdue",
        severity: assessment.daysOverdue >= 14 ? "high" : "medium",
        confidence: 1,
        title: `${row.reference} has had no response for ${assessment.daysOverdue} day${assessment.daysOverdue === 1 ? "" : "s"}`,
        explanation: `${row.reference} ("${row.subject}") required a response by ${row.responseDueDate}. Nothing has been recorded against it. On a contractual record an unanswered notice is a fact the other side will rely on.`,
        key,
        evidence: {
          letterId: row.id,
          reference: row.reference,
          responseDueDate: row.responseDueDate,
          daysOverdue: assessment.daysOverdue,
          direction: row.direction,
          isContractual: row.isContractual === 1,
        },
      });
      seen.add(key);
      result.raised += 1;
    }
    if (row.overdueNotifiedAt === null) {
      const targets = [...new Set([row.createdBy, row.issuedBy].filter((id): id is string => !!id))];
      await pushNotifications(
        db,
        targets.map((userId) => ({
          companyId,
          userId,
          projectId,
          kind: "overdue" as const,
          title: `${row.reference} is ${assessment.daysOverdue} day${assessment.daysOverdue === 1 ? "" : "s"} past its response date`,
          body: `"${row.subject}" — response was due ${row.responseDueDate}. Chase it or record the response.`,
          recordType: "correspondence_letter",
          recordId: row.id,
        })),
      );
      await db
        .update(correspondenceLetters)
        .set({ overdueNotifiedAt: nowISO() })
        .where(eq(correspondenceLetters.id, row.id));
      result.notified += targets.length;
    }
  }
  return result;
}

/** Transmittals whose acknowledgement date has passed with recipients silent (#443). */
export async function sweepAckDue(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  today: string,
): Promise<SweepResult> {
  const result = emptySweep();
  const rows = await db
    .select()
    .from(transmittals)
    .where(
      and(
        eq(transmittals.companyId, companyId),
        eq(transmittals.projectId, projectId),
        eq(transmittals.ackRequired, 1),
        isNotNull(transmittals.ackDueDate),
        inArray(transmittals.status, ["issued", "partially_acknowledged"]),
      ),
    )
    .limit(5000);
  result.scanned = rows.length;
  if (rows.length === 0) return result;

  const seen = await alreadySignalled(db, companyId, ["correspondence_ack_overdue"], projectId);
  for (const row of rows) {
    const recipients = (await loadRecipients(db, companyId, "transmittal", row.id)).map(
      toRecipientInput,
    );
    const position = ackPosition(recipients, row.ackDueDate, today);
    if (!position.overdue || position.daysOverdue === null) continue;
    const key = `corr:transmittal:${row.id}:ack_overdue`;
    if (!seen.has(key)) {
      await raiseSignal(db, companyId, projectId, actorId, {
        detector: "correspondence_ack_overdue",
        severity: row.purpose === "for_construction" ? "high" : "medium",
        confidence: 1,
        title: `${row.reference} — ${position.outstanding} recipient${position.outstanding === 1 ? " has" : "s have"} not acknowledged receipt`,
        explanation: `${row.reference} was issued ${row.purpose.replace(/_/g, " ")} with acknowledgement due ${row.ackDueDate}. ${position.outstandingNames.join(", ")} ${position.outstanding === 1 ? "has" : "have"} not acknowledged. Without an acknowledgement there is no record that the issue was received.`,
        key,
        evidence: {
          transmittalId: row.id,
          reference: row.reference,
          purpose: row.purpose,
          ackDueDate: row.ackDueDate,
          daysOverdue: position.daysOverdue,
          outstanding: position.outstandingNames,
        },
      });
      seen.add(key);
      result.raised += 1;
    }
    if (row.overdueNotifiedAt === null) {
      const targets = [...new Set([row.createdBy, row.issuedBy].filter((id): id is string => !!id))];
      await pushNotifications(
        db,
        targets.map((userId) => ({
          companyId,
          userId,
          projectId,
          kind: "correspondence" as const,
          title: `${row.reference} — acknowledgement overdue`,
          body: `${position.outstanding} of ${position.required} recipients have not acknowledged. Outstanding: ${position.outstandingNames.join(", ")}.`,
          recordType: "transmittal",
          recordId: row.id,
        })),
      );
      await db
        .update(transmittals)
        .set({ overdueNotifiedAt: nowISO() })
        .where(eq(transmittals.id, row.id));
      result.notified += targets.length;
    }
  }
  return result;
}

/** Action plan activities past their due date (#454). */
export async function sweepPlanDue(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  today: string,
): Promise<SweepResult> {
  const result = emptySweep();
  const plans = await db
    .select()
    .from(actionPlans)
    .where(
      and(
        eq(actionPlans.companyId, companyId),
        eq(actionPlans.projectId, projectId),
        inArray(actionPlans.status, ["active", "blocked"]),
      ),
    )
    .limit(5000);
  result.scanned = plans.length;
  if (plans.length === 0) return result;

  const seen = await alreadySignalled(db, companyId, ["correspondence_plan_overdue"], projectId);
  for (const plan of plans) {
    const activities = (await loadPlanActivities(db, companyId, plan.id)).map(toActivityInput);
    const report = completionReport(activities, today);
    const overdue = report.rows.filter((r) => r.overdue);
    // Keep the plan's derived status honest even when nothing is overdue.
    await syncPlan(db, companyId, projectId, plan.id, actorId, today);
    if (overdue.length === 0) continue;
    const worst = overdue.reduce((acc, r) => {
      const d = daysBetween(r.dueDate, today) ?? 0;
      return d > acc.days ? { days: d, row: r } : acc;
    }, { days: -1, row: overdue[0]! });
    const key = `corr:plan:${plan.id}:overdue`;
    if (!seen.has(key)) {
      await raiseSignal(db, companyId, projectId, actorId, {
        detector: "correspondence_plan_overdue",
        severity: overdue.some((r) => r.isQualityCheckpoint) ? "high" : "medium",
        confidence: 1,
        title: `${plan.reference} has ${overdue.length} overdue activit${overdue.length === 1 ? "y" : "ies"}`,
        explanation: `Action plan ${plan.reference} ("${plan.title}") has ${overdue.length} activity/activities past their due date; the oldest is activity ${worst.row.seq} ("${worst.row.title}"), ${worst.days} day(s) late.${overdue.some((r) => r.isQualityCheckpoint) ? " One of them is a quality checkpoint, so everything after it is held." : ""}`,
        key,
        evidence: {
          planId: plan.id,
          reference: plan.reference,
          overdue: overdue.map((r) => ({ seq: r.seq, title: r.title, dueDate: r.dueDate })),
          gaps: report.gaps.slice(0, 20),
        },
      });
      seen.add(key);
      result.raised += 1;
    }
    if (plan.overdueNotifiedAt === null) {
      const targets = [...new Set([plan.ownerId, plan.createdBy].filter((id): id is string => !!id))];
      await pushNotifications(
        db,
        targets.map((userId) => ({
          companyId,
          userId,
          projectId,
          kind: "overdue" as const,
          title: `${plan.reference} has overdue activities`,
          body: `${overdue.length} activity/activities past due on "${plan.title}".`,
          recordType: "action_plan",
          recordId: plan.id,
        })),
      );
      await db
        .update(actionPlans)
        .set({ overdueNotifiedAt: nowISO() })
        .where(eq(actionPlans.id, plan.id));
      result.notified += targets.length;
    }
  }
  return result;
}

/** Form assignments past their due date with nothing submitted (#460). */
export async function sweepFormDue(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  today: string,
): Promise<SweepResult> {
  const result = emptySweep();
  const rows = await db
    .select()
    .from(formAssignments)
    .where(
      and(
        eq(formAssignments.companyId, companyId),
        eq(formAssignments.projectId, projectId),
        isNotNull(formAssignments.dueDate),
        inArray(formAssignments.status, ["assigned", "in_progress"]),
      ),
    )
    .limit(5000);
  result.scanned = rows.length;
  if (rows.length === 0) return result;

  const seen = await alreadySignalled(db, companyId, ["correspondence_form_overdue"], projectId);
  for (const row of rows) {
    const late = daysBetween(row.dueDate, today);
    if (late === null || late <= 0) continue;
    const key = `corr:form_assignment:${row.id}:overdue`;
    if (!seen.has(key)) {
      await raiseSignal(db, companyId, projectId, actorId, {
        detector: "correspondence_form_overdue",
        severity: late >= 7 ? "medium" : "low",
        confidence: 1,
        title: `A form assigned to ${row.assigneeName} is ${late} day${late === 1 ? "" : "s"} overdue`,
        explanation: `The form assigned to ${row.assigneeName} was due ${row.dueDate} and nothing has been submitted. An unreturned form is an unrecorded inspection, not an inspection that passed.`,
        key,
        evidence: {
          assignmentId: row.id,
          templateId: row.templateId,
          assignee: row.assigneeName,
          dueDate: row.dueDate,
          daysOverdue: late,
        },
      });
      seen.add(key);
      result.raised += 1;
    }
    if (row.overdueNotifiedAt === null) {
      const targets = [...new Set([row.assigneeUserId, row.createdBy].filter((id): id is string => !!id))];
      await pushNotifications(
        db,
        targets.map((userId) => ({
          companyId,
          userId,
          projectId,
          kind: "overdue" as const,
          title: `Form overdue by ${late} day${late === 1 ? "" : "s"}`,
          body: `Assigned to ${row.assigneeName}, due ${row.dueDate}.`,
          recordType: "form_assignment",
          recordId: row.id,
        })),
      );
      await db
        .update(formAssignments)
        .set({ overdueNotifiedAt: nowISO() })
        .where(eq(formAssignments.id, row.id));
      result.notified += targets.length;
    }
  }
  return result;
}

export interface ScanResult {
  responses: SweepResult;
  acknowledgements: SweepResult;
  plans: SweepResult;
  forms: SweepResult;
  ranAt: string;
}

export async function runAllSweeps(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  today: string,
): Promise<ScanResult> {
  return {
    responses: await sweepResponseDue(db, companyId, projectId, actorId, today),
    acknowledgements: await sweepAckDue(db, companyId, projectId, actorId, today),
    plans: await sweepPlanDue(db, companyId, projectId, actorId, today),
    forms: await sweepFormDue(db, companyId, projectId, actorId, today),
    ranAt: nowISO(),
  };
}

/* ------------------------------------------------------------------ */
/* Summary and health inputs                                           */
/* ------------------------------------------------------------------ */

export interface CorrespondenceSummary {
  letters: ReturnType<typeof registerStats>;
  transmittals: {
    total: number;
    byStatus: Record<string, number>;
    issued: number;
    outstandingAcks: number;
    overdueAcks: number;
    acknowledgementRate: Figure;
  };
  plans: {
    total: number;
    byStatus: Record<string, number>;
    active: number;
    blocked: number;
    completed: number;
    overdueActivities: number;
    averageProgress: Figure;
  };
  forms: {
    templates: number;
    published: number;
    assignments: number;
    openAssignments: number;
    overdueAssignments: number;
    responses: number;
    submitted: number;
  };
  inbound: { captured: number; unmatched: number };
  openSignals: number;
  reasons: string[];
}

export async function correspondenceSummary(
  db: Db,
  companyId: string,
  projectId: string,
  today: string,
): Promise<CorrespondenceSummary> {
  const [letterRows, transmittalRows, planRows, activityRows, templateRows, assignmentRows, responseRows] =
    await Promise.all([
      db
        .select(LETTER_COLUMNS)
        .from(correspondenceLetters)
        .where(
          and(
            eq(correspondenceLetters.companyId, companyId),
            eq(correspondenceLetters.projectId, projectId),
          ),
        )
        .limit(20_000),
      db
        .select()
        .from(transmittals)
        .where(and(eq(transmittals.companyId, companyId), eq(transmittals.projectId, projectId)))
        .limit(20_000),
      db
        .select()
        .from(actionPlans)
        .where(and(eq(actionPlans.companyId, companyId), eq(actionPlans.projectId, projectId)))
        .limit(20_000),
      db
        .select({
          status: actionPlanActivities.status,
          dueDate: actionPlanActivities.dueDate,
        })
        .from(actionPlanActivities)
        .where(
          and(
            eq(actionPlanActivities.companyId, companyId),
            eq(actionPlanActivities.projectId, projectId),
          ),
        )
        .limit(50_000),
      db
        .select({ status: formTemplates.status, projectId: formTemplates.projectId })
        .from(formTemplates)
        .where(
          and(
            eq(formTemplates.companyId, companyId),
            or(isNull(formTemplates.projectId), eq(formTemplates.projectId, projectId)),
          ),
        )
        .limit(5000),
      db
        .select()
        .from(formAssignments)
        .where(and(eq(formAssignments.companyId, companyId), eq(formAssignments.projectId, projectId)))
        .limit(20_000),
      db
        .select({ status: formResponses.status })
        .from(formResponses)
        .where(and(eq(formResponses.companyId, companyId), eq(formResponses.projectId, projectId)))
        .limit(20_000),
    ]);

  const reasons: string[] = [];
  const letters = registerStats(letterRows.map(toLetterInput), today);

  const transmittalStatuses: Record<string, number> = {};
  let ackRequired = 0;
  let acknowledged = 0;
  let overdueAcks = 0;
  for (const t of transmittalRows) {
    transmittalStatuses[t.status] = (transmittalStatuses[t.status] ?? 0) + 1;
    if (t.status === "draft" || t.status === "void") continue;
    ackRequired += t.ackRequiredCount;
    acknowledged += t.acknowledgedCount;
    const late = daysBetween(t.ackDueDate, today);
    if (
      t.ackRequired === 1 &&
      t.ackRequiredCount > t.acknowledgedCount &&
      late !== null &&
      late > 0 &&
      (t.status === "issued" || t.status === "partially_acknowledged")
    ) {
      overdueAcks += 1;
    }
  }
  const ackRate =
    ackRequired === 0
      ? figure(null, "%", { ackRequired }, [
          "No issued transmittal on this project asked a recipient to acknowledge receipt, so there is no rate to report.",
        ])
      : figure(Math.round((acknowledged / ackRequired) * 1000) / 10, "%", {
          acknowledged,
          required: ackRequired,
        });

  const planStatuses: Record<string, number> = {};
  const percents: number[] = [];
  for (const p of planRows) {
    planStatuses[p.status] = (planStatuses[p.status] ?? 0) + 1;
    if (p.progressPercent !== null) percents.push(p.progressPercent);
  }
  const overdueActivities = activityRows.filter(
    (a) => a.status !== "signed_off" && a.status !== "waived" && a.dueDate !== null && a.dueDate < today,
  ).length;
  const averageProgress =
    percents.length === 0
      ? figure(null, "%", { plans: planRows.length }, [
          planRows.length === 0
            ? "No action plans on this project yet."
            : "No plan on this project has any activities, so there is no progress to average.",
        ])
      : figure(
          Math.round((percents.reduce((a, b) => a + b, 0) / percents.length) * 10) / 10,
          "%",
          { plans: percents.length },
        );

  const openAssignments = assignmentRows.filter(
    (a) => a.status === "assigned" || a.status === "in_progress",
  );
  const overdueAssignments = openAssignments.filter((a) => {
    const late = daysBetween(a.dueDate, today);
    return late !== null && late > 0;
  }).length;

  const inboundCounts = await db
    .select({ status: correspondenceInboundMessages.status, n: sql<number>`count(*)::int` })
    .from(correspondenceInboundMessages)
    .where(
      and(
        eq(correspondenceInboundMessages.companyId, companyId),
        eq(correspondenceInboundMessages.projectId, projectId),
      ),
    )
    .groupBy(correspondenceInboundMessages.status);
  let capturedInbound = 0;
  let unmatchedInbound = 0;
  for (const row of inboundCounts) {
    capturedInbound += Number(row.n);
    if (row.status === "unmatched") unmatchedInbound += Number(row.n);
  }

  const openSignalRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(signals)
    .where(
      and(
        eq(signals.companyId, companyId),
        eq(signals.projectId, projectId),
        like(signals.detector, "correspondence_%"),
        inArray(signals.disposition, ["new", "under_review", "confirmed", "escalated"]),
      ),
    );
  const openSignals = Number(openSignalRows[0]?.n ?? 0);

  if (letters.total === 0) reasons.push("No correspondence has been recorded on this project yet.");
  if (transmittalRows.length === 0) reasons.push("No transmittals have been issued on this project yet.");

  return {
    letters,
    transmittals: {
      total: transmittalRows.length,
      byStatus: transmittalStatuses,
      issued: transmittalRows.filter((t) => t.status !== "draft" && t.status !== "void").length,
      outstandingAcks: Math.max(0, ackRequired - acknowledged),
      overdueAcks,
      acknowledgementRate: ackRate,
    },
    plans: {
      total: planRows.length,
      byStatus: planStatuses,
      active: planRows.filter((p) => p.status === "active").length,
      blocked: planRows.filter((p) => p.status === "blocked").length,
      completed: planRows.filter((p) => p.status === "completed").length,
      overdueActivities,
      averageProgress,
    },
    forms: {
      templates: templateRows.length,
      published: templateRows.filter((t) => t.status === "published").length,
      assignments: assignmentRows.length,
      openAssignments: openAssignments.length,
      overdueAssignments,
      responses: responseRows.length,
      submitted: responseRows.filter((r) => r.status !== "draft" && r.status !== "void").length,
    },
    inbound: { captured: capturedInbound, unmatched: unmatchedInbound },
    openSignals,
    reasons,
  };
}

/**
 * Health inputs for WP-INTEL (contract §3.5). Every metric is a count the
 * intelligence layer can score; a metric it cannot derive is null with the
 * reason alongside, never zero.
 */
export async function correspondenceHealthInputs(
  db: Db,
  companyId: string,
  projectId: string,
  today: string,
): Promise<{ metrics: Record<string, number | null>; reasons: string[] }> {
  const summary = await correspondenceSummary(db, companyId, projectId, today);
  const reasons: string[] = [...summary.reasons];
  const metrics: Record<string, number | null> = {
    lettersTotal: summary.letters.total,
    lettersOpen: summary.letters.open,
    lettersAwaitingResponse: summary.letters.awaitingResponse,
    lettersOverdue: summary.letters.overdue,
    lettersDueSoon: summary.letters.dueSoon,
    ballInOurCourt: summary.letters.ballWithUs,
    averageResponseDays: summary.letters.averageResponseDays,
    oldestOpenLetterDays: summary.letters.oldestOpenDays,
    transmittalsIssued: summary.transmittals.issued,
    acknowledgementsOutstanding: summary.transmittals.outstandingAcks,
    acknowledgementsOverdue: summary.transmittals.overdueAcks,
    acknowledgementRatePercent: summary.transmittals.acknowledgementRate.value,
    actionPlansActive: summary.plans.active,
    actionPlansBlocked: summary.plans.blocked,
    actionPlanActivitiesOverdue: summary.plans.overdueActivities,
    actionPlanAverageProgressPercent: summary.plans.averageProgress.value,
    formAssignmentsOpen: summary.forms.openAssignments,
    formAssignmentsOverdue: summary.forms.overdueAssignments,
    inboundUnmatched: summary.inbound.unmatched,
    openCorrespondenceSignals: summary.openSignals,
  };
  if (summary.letters.averageResponseDays === null) reasons.push(summary.letters.averageResponseBasis);
  reasons.push(...summary.transmittals.acknowledgementRate.reasons);
  reasons.push(...summary.plans.averageProgress.reasons);
  return { metrics, reasons: [...new Set(reasons)] };
}

/* ------------------------------------------------------------------ */
/* Project discovery for the scheduler jobs                            */
/* ------------------------------------------------------------------ */

export async function projectsWithOpenCorrespondence(
  db: Db,
  companyId: string,
): Promise<string[]> {
  const [letters, transmittalRows, plans, assignments] = await Promise.all([
    db
      .selectDistinct({ projectId: correspondenceLetters.projectId })
      .from(correspondenceLetters)
      .where(
        and(
          eq(correspondenceLetters.companyId, companyId),
          eq(correspondenceLetters.responseRequired, 1),
          isNull(correspondenceLetters.respondedAt),
          inArray(correspondenceLetters.status, ["issued", "acknowledged"]),
        ),
      ),
    db
      .selectDistinct({ projectId: transmittals.projectId })
      .from(transmittals)
      .where(
        and(
          eq(transmittals.companyId, companyId),
          inArray(transmittals.status, ["issued", "partially_acknowledged"]),
        ),
      ),
    db
      .selectDistinct({ projectId: actionPlans.projectId })
      .from(actionPlans)
      .where(and(eq(actionPlans.companyId, companyId), inArray(actionPlans.status, ["active", "blocked"]))),
    db
      .selectDistinct({ projectId: formAssignments.projectId })
      .from(formAssignments)
      .where(
        and(
          eq(formAssignments.companyId, companyId),
          inArray(formAssignments.status, ["assigned", "in_progress"]),
        ),
      ),
  ]);
  return [
    ...new Set([...letters, ...transmittalRows, ...plans, ...assignments].map((r) => r.projectId)),
  ];
}
