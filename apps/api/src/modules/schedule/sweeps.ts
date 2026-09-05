/**
 * Time-driven schedule behaviour (registered with app.scheduler).
 *
 * Two sweeps, both idempotent — a sweep that raises the same signal twice is
 * a bug, not a reminder:
 *
 *  1. MILESTONE SLIP (#362). A key milestone carries a contractual date. When
 *     the computed (or actual) finish moves past it, the sweep raises a signal
 *     and notifies the responsible party ONCE per slip magnitude: the stamp
 *     `slipAlertedDays` means "we have already told you about a slip of this
 *     size", so a slip that worsens alerts again and a stable slip does not.
 *  2. CONSTRAINT ESCALATION (#359). A lookahead constraint past its need-by
 *     date with nobody clearing it is the single most reliable predictor of a
 *     missed week. `escalatedAt` makes the escalation happen once.
 *
 * Both run with `actorId: null` — the system actor. Nobody performed these
 * state changes, and attributing them to whoever loaded a page would be a lie
 * in the ledger.
 */
import { and, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  scheduleConstraints,
  scheduleTasks,
  schedules,
  signals,
} from "@constructos/db";
import type { Db } from "../../lib/db.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { pushNotifications } from "../notifications/service.js";

const DAY_MS = 86_400_000;

export function isoDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);
}

/** Raise a signal once per (detector, key); returns true when it was new. */
async function raiseSignalOnce(
  db: Db,
  a: {
    companyId: string;
    projectId: string;
    detector: string;
    key: string;
    severity: "critical" | "high" | "medium" | "low" | "info";
    confidence: number;
    title: string;
    explanation: string;
    evidenceRefs?: Record<string, unknown>;
  },
): Promise<boolean> {
  const existing = await db
    .select({ id: signals.id })
    .from(signals)
    .where(
      and(
        eq(signals.companyId, a.companyId),
        eq(signals.projectId, a.projectId),
        eq(signals.detector, a.detector),
        sql`${signals.evidenceRefs} ->> 'key' = ${a.key}`,
      ),
    )
    .limit(1);
  if (existing[0]) return false;
  await db.insert(signals).values({
    id: newId("sig"),
    companyId: a.companyId,
    projectId: a.projectId,
    detector: a.detector,
    severity: a.severity,
    confidence: a.confidence,
    title: a.title,
    explanation: a.explanation,
    evidenceRefs: { key: a.key, ...(a.evidenceRefs ?? {}) },
    fingerprint: `${a.detector}:${a.key}`,
    subjectType: "schedule",
  });
  return true;
}

export interface MilestoneSweepResult {
  scanned: number;
  slipped: number;
  alerted: number;
}

/**
 * Compare every key milestone's forecast/actual finish with its contractual
 * date and alert on a slip that has grown since the last alert.
 */
export async function sweepMilestoneSlips(
  db: Db,
  companyId: string,
  now: Date,
  options: { projectId?: string; scheduleId?: string } = {},
): Promise<MilestoneSweepResult> {
  const scheduleClauses = [eq(schedules.companyId, companyId)];
  if (options.projectId) scheduleClauses.push(eq(schedules.projectId, options.projectId));
  if (options.scheduleId) scheduleClauses.push(eq(schedules.id, options.scheduleId));
  else scheduleClauses.push(eq(schedules.isActive, 1));
  const scheduleRows = await db
    .select({
      id: schedules.id,
      projectId: schedules.projectId,
      name: schedules.name,
      createdBy: schedules.createdBy,
    })
    .from(schedules)
    .where(and(...scheduleClauses));
  if (scheduleRows.length === 0) return { scanned: 0, slipped: 0, alerted: 0 };

  const byId = new Map(scheduleRows.map((s) => [s.id, s] as const));
  const rows = await db
    .select()
    .from(scheduleTasks)
    .where(
      and(
        inArray(
          scheduleTasks.scheduleId,
          scheduleRows.map((s) => s.id),
        ),
        eq(scheduleTasks.isKeyMilestone, 1),
        isNotNull(scheduleTasks.contractualDate),
      ),
    );

  let slipped = 0;
  let alerted = 0;
  const nowIso = now.toISOString();
  for (const t of rows) {
    const contractual = t.contractualDate;
    if (!contractual) continue;
    const forecast = t.actualFinish ?? t.finishDate;
    if (!forecast) continue;
    const slipDays = diffDays(forecast, contractual);
    if (slipDays <= 0) continue;
    slipped += 1;
    // Alert only when the slip is NEW or has grown — a stable slip is already known.
    if (t.slipAlertedDays !== null && slipDays <= t.slipAlertedDays) continue;
    const schedule = byId.get(t.scheduleId);
    if (!schedule) continue;
    await db
      .update(scheduleTasks)
      .set({ slipAlertedDays: slipDays, slipAlertedAt: nowIso, updatedAt: nowIso })
      .where(eq(scheduleTasks.id, t.id));
    await raiseSignalOnce(db, {
      companyId,
      projectId: schedule.projectId,
      detector: "schedule.milestone_slip",
      key: `${t.id}:${slipDays}`,
      severity: slipDays >= 28 ? "high" : slipDays >= 7 ? "medium" : "low",
      confidence: 0.9,
      title: `Key milestone "${t.name}" is ${slipDays} day${slipDays === 1 ? "" : "s"} late`,
      explanation:
        `The contractual date for "${t.name}" is ${contractual}; the programme "${schedule.name}" ` +
        `${t.actualFinish ? "recorded an actual finish of" : "forecasts"} ${forecast}, a slip of ${slipDays} days.`,
      evidenceRefs: {
        taskId: t.id,
        scheduleId: t.scheduleId,
        contractualDate: contractual,
        forecastFinish: forecast,
        slipDays,
      },
    });
    const recipients = [t.responsibleId, schedule.createdBy].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    if (recipients.length > 0) {
      await pushNotifications(
        db,
        recipients.map((userId) => ({
          companyId,
          userId,
          projectId: schedule.projectId,
          kind: "overdue" as const,
          title: `Milestone slip: ${t.name}`,
          body: `${slipDays} day${slipDays === 1 ? "" : "s"} past the contractual date ${contractual}.`,
          recordType: "schedule_task",
          recordId: t.id,
        })),
      );
    }
    await appendLedger(db, {
      companyId,
      actorId: null,
      action: "state_change",
      objectType: "schedule_task",
      objectId: t.id,
      projectId: schedule.projectId,
      payload: { milestoneSlipDays: slipDays, contractualDate: contractual, forecastFinish: forecast },
    });
    alerted += 1;
  }
  return { scanned: rows.length, slipped, alerted };
}

export interface ConstraintSweepResult {
  scanned: number;
  overdue: number;
  escalated: number;
}

/** Escalate lookahead constraints that are past their need-by date. */
export async function sweepConstraints(
  db: Db,
  companyId: string,
  now: Date,
  options: { projectId?: string } = {},
): Promise<ConstraintSweepResult> {
  const today = isoDay(now);
  const clauses = [
    eq(scheduleConstraints.companyId, companyId),
    or(eq(scheduleConstraints.status, "open"), eq(scheduleConstraints.status, "in_progress"))!,
    isNotNull(scheduleConstraints.needByDate),
    lt(scheduleConstraints.needByDate, today),
  ];
  if (options.projectId) clauses.push(eq(scheduleConstraints.projectId, options.projectId));
  const rows = await db
    .select()
    .from(scheduleConstraints)
    .where(and(...clauses))
    .limit(2000);

  let escalated = 0;
  const nowIso = now.toISOString();
  for (const c of rows) {
    if (c.escalatedAt) continue;
    await db
      .update(scheduleConstraints)
      .set({ status: "escalated", escalatedAt: nowIso, updatedAt: nowIso })
      .where(eq(scheduleConstraints.id, c.id));
    await raiseSignalOnce(db, {
      companyId,
      projectId: c.projectId,
      detector: "schedule.constraint_overdue",
      key: c.id,
      severity: "medium",
      confidence: 0.85,
      title: `Lookahead constraint C-${c.number} is past its need-by date`,
      explanation:
        `"${c.description}" (${c.category}) was needed by ${c.needByDate} and is still ${c.status}. ` +
        "Work depending on it cannot be made ready.",
      evidenceRefs: { constraintId: c.id, taskId: c.taskId, needByDate: c.needByDate },
    });
    if (c.ownerId) {
      await pushNotifications(db, [
        {
          companyId,
          userId: c.ownerId,
          projectId: c.projectId,
          kind: "escalation" as const,
          title: `Constraint C-${c.number} overdue`,
          body: `${c.description} — needed by ${c.needByDate}.`,
          recordType: "schedule_constraint",
          recordId: c.id,
        },
      ]);
    }
    await appendLedger(db, {
      companyId,
      actorId: null,
      action: "state_change",
      objectType: "schedule_constraint",
      objectId: c.id,
      projectId: c.projectId,
      payload: { from: c.status, to: "escalated", needByDate: c.needByDate },
    });
    escalated += 1;
  }
  return { scanned: rows.length, overdue: rows.length, escalated };
}

/** Constraints that are open and not yet overdue — used by health inputs. */
export async function countOpenConstraints(
  db: Db,
  companyId: string,
  projectId: string,
  now: Date,
): Promise<{ open: number; overdue: number }> {
  const rows = await db
    .select({ status: scheduleConstraints.status, needByDate: scheduleConstraints.needByDate })
    .from(scheduleConstraints)
    .where(
      and(
        eq(scheduleConstraints.companyId, companyId),
        eq(scheduleConstraints.projectId, projectId),
        ne(scheduleConstraints.status, "cleared"),
        ne(scheduleConstraints.status, "void"),
      ),
    );
  const today = isoDay(now);
  return {
    open: rows.length,
    overdue: rows.filter((r) => r.needByDate !== null && r.needByDate < today).length,
  };
}

/** Key milestones with no contractual date cannot be tracked — report them. */
export async function untrackedMilestones(
  db: Db,
  scheduleId: string,
): Promise<number> {
  const rows = await db
    .select({ id: scheduleTasks.id })
    .from(scheduleTasks)
    .where(
      and(
        eq(scheduleTasks.scheduleId, scheduleId),
        eq(scheduleTasks.isKeyMilestone, 1),
        isNull(scheduleTasks.contractualDate),
      ),
    );
  return rows.length;
}
