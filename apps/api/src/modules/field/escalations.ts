/**
 * Overdue escalation ladder across every field register — spec #308 (RFI
 * overdue), #321 (RFI ageing), #339/#347 (submittal at-risk / in-court),
 * #395 (missing daily logs), #411 (punch ageing) and §4.2 observations.
 *
 * One scheduled job per day walks each company's projects and, for every
 * record that is past its date, climbs a three-rung ladder configured per
 * project (settings.escalation.stepDays):
 *
 *   rung 1  day it turns overdue   → notify the responsible person
 *   rung 2  after stepDays         → notify the project managers
 *   rung 3  after 2 × stepDays     → raise an integrity signal
 *
 * Idempotency is a table, not a memory: `field_escalations` holds one row
 * per (record, rung), so a rung that has been acted on is never repeated
 * however often the sweep runs. Daily-log gaps are escalated per missing
 * business day and go to the project managers from rung 1 — there is no
 * single "responsible" diarist for a day nobody wrote up.
 *
 * Deliberately NOT here: what counts as overdue for each register (each
 * route file owns its own definition and this sweep reuses the same columns).
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  dailyLogs,
  fieldEscalations,
  fieldObservations,
  projects,
  punchItems,
  rfis,
  signals,
  submittals,
} from "@constructos/db";
import type { FieldEscalationRecordType } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { forEachCompany } from "../../lib/scheduler.js";
import { pushNotifications, type NotifyTarget } from "../notifications/service.js";
import { addDaysISO } from "./dates.js";
import { projectManagerIds } from "./access.js";
import { ageInDays, daysOverdue, escalationLevelFor } from "./ageingEngine.js";
import { businessDaysBetween } from "./dailyLogEngine.js";
import { PUNCH_OPEN_STATUSES } from "./punchEngine.js";
import { loadFieldSettings } from "./settings.js";
import { pad3 } from "./shared.js";

export const ESCALATION_JOB = "field.overdue-escalation";
const DAILY_LOG_LOOKBACK_DAYS = 14;

interface Candidate {
  recordType: FieldEscalationRecordType;
  recordId: string;
  label: string;
  title: string;
  overdueDays: number;
  responsible: string[];
  href: string;
  /** what the record is overdue against, for the signal explanation */
  basis: string;
}

export interface SweepSummary {
  projects: number;
  candidates: number;
  notified: number;
  escalatedToPm: number;
  signals: number;
}

async function candidatesFor(db: Db, companyId: string, projectId: string, today: string, inCourtAllowanceDays: number): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const base = `/projects/${projectId}`;

  const rfiRows = await db
    .select({ id: rfis.id, number: rfis.number, subject: rfis.subject, dueDate: rfis.dueDate, assigneeId: rfis.assigneeId, ballInCourtId: rfis.ballInCourtId, createdBy: rfis.createdBy })
    .from(rfis)
    .where(and(eq(rfis.companyId, companyId), eq(rfis.projectId, projectId), eq(rfis.status, "open"), isNotNull(rfis.dueDate), lt(rfis.dueDate, today)))
    .limit(500);
  for (const r of rfiRows) {
    out.push({
      recordType: "rfi",
      recordId: r.id,
      label: `RFI-${pad3(r.number)}`,
      title: r.subject,
      overdueDays: daysOverdue(r.dueDate, today),
      responsible: [r.ballInCourtId ?? r.assigneeId ?? r.createdBy],
      href: `${base}/rfis/${r.id}`,
      basis: `response due ${r.dueDate}`,
    });
  }

  const subRows = await db
    .select({ id: submittals.id, number: submittals.number, revision: submittals.revision, title: submittals.title, status: submittals.status, submitByDate: submittals.submitByDate, submittedAt: submittals.submittedAt, ballInCourtId: submittals.ballInCourtId, createdBy: submittals.createdBy })
    .from(submittals)
    .where(and(eq(submittals.companyId, companyId), eq(submittals.projectId, projectId), inArray(submittals.status, ["draft", "open", "in_review"])))
    .limit(1000);
  for (const s of subRows) {
    const label = `SUB-${pad3(s.number)}${s.revision > 0 ? ` Rev ${s.revision}` : ""}`;
    if (s.status === "in_review") {
      const inCourt = ageInDays(s.submittedAt, today);
      if (s.submittedAt && inCourt > inCourtAllowanceDays) {
        out.push({
          recordType: "submittal",
          recordId: `${s.id}:in_court`,
          label,
          title: s.title,
          overdueDays: inCourt - inCourtAllowanceDays,
          responsible: [s.ballInCourtId ?? s.createdBy],
          href: `${base}/submittals/${s.id}`,
          basis: `in review for ${inCourt} days against a ${inCourtAllowanceDays}-day allowance`,
        });
      }
      continue;
    }
    if (s.submitByDate && s.submitByDate < today) {
      out.push({
        recordType: "submittal",
        recordId: s.id,
        label,
        title: s.title,
        overdueDays: daysOverdue(s.submitByDate, today),
        responsible: [s.ballInCourtId ?? s.createdBy],
        href: `${base}/submittals/${s.id}`,
        basis: `submit-by ${s.submitByDate} not met`,
      });
    }
  }

  const punchRows = await db
    .select({ id: punchItems.id, number: punchItems.number, title: punchItems.title, dueDate: punchItems.dueDate, assigneeId: punchItems.assigneeId, createdBy: punchItems.createdBy })
    .from(punchItems)
    .where(and(eq(punchItems.companyId, companyId), eq(punchItems.projectId, projectId), inArray(punchItems.status, [...PUNCH_OPEN_STATUSES]), isNotNull(punchItems.dueDate), lt(punchItems.dueDate, today)))
    .limit(500);
  for (const p of punchRows) {
    out.push({
      recordType: "punch_item",
      recordId: p.id,
      label: `Punch #${pad3(p.number)}`,
      title: p.title,
      overdueDays: daysOverdue(p.dueDate, today),
      responsible: [p.assigneeId ?? p.createdBy],
      href: `${base}/punch?item=${p.id}`,
      basis: `due ${p.dueDate}`,
    });
  }

  const obsRows = await db
    .select({ id: fieldObservations.id, number: fieldObservations.number, title: fieldObservations.title, dueDate: fieldObservations.dueDate, assigneeId: fieldObservations.assigneeId, createdBy: fieldObservations.createdBy })
    .from(fieldObservations)
    .where(and(eq(fieldObservations.companyId, companyId), eq(fieldObservations.projectId, projectId), inArray(fieldObservations.status, ["open", "in_progress", "ready_for_review"]), isNotNull(fieldObservations.dueDate), lt(fieldObservations.dueDate, today)))
    .limit(500);
  for (const o of obsRows) {
    out.push({
      recordType: "observation",
      recordId: o.id,
      label: `OBS-${pad3(o.number)}`,
      title: o.title,
      overdueDays: daysOverdue(o.dueDate, today),
      responsible: [o.assigneeId ?? o.createdBy],
      href: `${base}/observations?item=${o.id}`,
      basis: `due ${o.dueDate}`,
    });
  }

  // Daily logs: only projects that keep a diary at all are expected to keep one every business day.
  const [firstLog] = await db
    .select({ logDate: sql<string>`min(${dailyLogs.logDate})` })
    .from(dailyLogs)
    .where(and(eq(dailyLogs.companyId, companyId), eq(dailyLogs.projectId, projectId)));
  if (firstLog?.logDate) {
    const from = firstLog.logDate > addDaysISO(today, -DAILY_LOG_LOOKBACK_DAYS) ? firstLog.logDate : addDaysISO(today, -DAILY_LOG_LOOKBACK_DAYS);
    const yesterday = addDaysISO(today, -1);
    if (from <= yesterday) {
      const days = businessDaysBetween(from, yesterday);
      const logged = await db
        .select({ logDate: dailyLogs.logDate })
        .from(dailyLogs)
        .where(and(eq(dailyLogs.companyId, companyId), eq(dailyLogs.projectId, projectId), inArray(dailyLogs.status, ["submitted", "approved"]), inArray(dailyLogs.logDate, days.length > 0 ? days : ["-"])));
      const covered = new Set(logged.map((l) => l.logDate));
      for (const day of days) {
        if (covered.has(day)) continue;
        out.push({
          recordType: "daily_log",
          recordId: `${projectId}:${day}`,
          label: `Daily log ${day}`,
          title: "No submitted daily log",
          overdueDays: ageInDays(day, today),
          responsible: [],
          href: `${base}/daily-logs?date=${day}`,
          basis: "business day with no submitted or approved log",
        });
      }
    }
  }
  return out;
}

/** Run the ladder for one company (optionally one project). Idempotent. */
export async function sweepFieldEscalations(
  app: FastifyInstance,
  companyId: string,
  now: Date,
  options: { projectId?: string; actorId?: string | null } = {},
): Promise<SweepSummary> {
  const db = app.db;
  const today = now.toISOString().slice(0, 10);
  const summary: SweepSummary = { projects: 0, candidates: 0, notified: 0, escalatedToPm: 0, signals: 0 };
  const projectClauses = [eq(projects.companyId, companyId), eq(projects.isTemplate, 0)];
  if (options.projectId) projectClauses.push(eq(projects.id, options.projectId));
  const projectRows = await db.select({ id: projects.id, name: projects.name }).from(projects).where(and(...projectClauses)).limit(500);

  for (const project of projectRows) {
    summary.projects += 1;
    const settings = await loadFieldSettings(db, companyId, project.id);
    const candidates = await candidatesFor(db, companyId, project.id, today, settings.submittal.inCourtAllowanceDays);
    if (candidates.length === 0) continue;
    summary.candidates += candidates.length;
    const pms = settings.escalation.pmUserIds.length > 0 ? settings.escalation.pmUserIds : await projectManagerIds(db, companyId, project.id);
    const existing = await db
      .select({ recordType: fieldEscalations.recordType, recordId: fieldEscalations.recordId, level: fieldEscalations.level })
      .from(fieldEscalations)
      .where(and(eq(fieldEscalations.projectId, project.id), inArray(fieldEscalations.recordId, candidates.map((c) => c.recordId))));
    const done = new Set(existing.map((e) => `${e.recordType}|${e.recordId}|${e.level}`));

    for (const c of candidates) {
      const level = escalationLevelFor(c.overdueDays, settings.escalation.stepDays);
      for (let rung = 1; rung <= level; rung += 1) {
        const key = `${c.recordType}|${c.recordId}|${rung}`;
        if (done.has(key)) continue;
        const targets: NotifyTarget[] = [];
        let signalId: string | null = null;
        let notifiedIds: string[] = [];
        if (rung === 1) {
          const ids = c.recordType === "daily_log" ? pms : settings.escalation.notifyResponsible ? c.responsible : [];
          notifiedIds = [...new Set(ids.filter(Boolean))];
          for (const userId of notifiedIds) {
            targets.push({
              companyId,
              userId,
              projectId: project.id,
              kind: "overdue",
              title: `${c.label} is overdue: ${c.title}`,
              body: `${c.basis}; ${c.overdueDays} day(s) overdue. ${c.href}`,
              recordType: c.recordType,
              recordId: c.recordId.split(":")[0]!,
            });
          }
          summary.notified += notifiedIds.length;
        } else if (rung === 2) {
          notifiedIds = [...new Set(pms)];
          for (const userId of notifiedIds) {
            targets.push({
              companyId,
              userId,
              projectId: project.id,
              kind: "escalation",
              title: `Escalated: ${c.label} is ${c.overdueDays} days overdue`,
              body: `${c.title} — ${c.basis}. Escalated to project management after ${settings.escalation.stepDays} days. ${c.href}`,
              recordType: c.recordType,
              recordId: c.recordId.split(":")[0]!,
            });
          }
          summary.escalatedToPm += 1;
        } else {
          const signalKey = `field_overdue:${c.recordType}:${c.recordId}`;
          const dup = await db
            .select({ id: signals.id })
            .from(signals)
            .where(and(eq(signals.companyId, companyId), eq(signals.detector, "field_overdue_escalation"), sql`${signals.evidenceRefs}->>'key' = ${signalKey}`))
            .limit(1);
          if (dup[0]) {
            signalId = dup[0].id;
          } else {
            signalId = newId("sig");
            await db.insert(signals).values({
              id: signalId,
              companyId,
              projectId: project.id,
              detector: "field_overdue_escalation",
              severity: c.overdueDays >= settings.escalation.stepDays * 4 ? "high" : "medium",
              confidence: 1,
              title: `${c.label} unresolved ${c.overdueDays} days past its date (${project.name})`,
              explanation: `${c.title}: ${c.basis}. The responsible person was notified when it turned overdue and project management after ${settings.escalation.stepDays} days; it is still open after ${c.overdueDays} days. On an owner-side record an unanswered field question, an unsubmitted diary or an unverified defect that nobody escalates is how a later claim gets its "we told you" — this signal is the record that the platform did.`,
              evidenceRefs: { key: signalKey, recordType: c.recordType, recordId: c.recordId, href: c.href, overdueDays: c.overdueDays, stepDays: settings.escalation.stepDays },
            });
            await appendLedger(db, {
              companyId,
              actorId: options.actorId ?? null,
              action: "create",
              objectType: "signal",
              objectId: signalId,
              payload: { detector: "field_overdue_escalation", key: signalKey },
              projectId: project.id,
            });
            summary.signals += 1;
          }
        }
        if (targets.length > 0) await pushNotifications(db, targets);
        const id = newId("fesc");
        await db.insert(fieldEscalations).values({
          id,
          companyId,
          projectId: project.id,
          recordType: c.recordType,
          recordId: c.recordId,
          level: rung,
          daysOverdue: c.overdueDays,
          notifiedUserIds: notifiedIds,
          signalId,
        });
        await appendLedger(db, {
          companyId,
          actorId: options.actorId ?? null,
          action: "create",
          objectType: "field_escalation",
          objectId: id,
          payload: { recordType: c.recordType, recordId: c.recordId, level: rung, daysOverdue: c.overdueDays, notified: notifiedIds.length, signalId },
          projectId: project.id,
        });
        done.add(key);
      }
    }
  }
  return summary;
}

export function registerFieldEscalationJob(app: FastifyInstance): void {
  app.scheduler.register({
    name: ESCALATION_JOB,
    description: "Climb the overdue ladder for RFIs, submittals, punch items, observations and missing daily logs",
    everyMs: 24 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => {
      const totals: SweepSummary = { projects: 0, candidates: 0, notified: 0, escalatedToPm: 0, signals: 0 };
      const result = await forEachCompany(db, async (companyId) => {
        const s = await sweepFieldEscalations(app, companyId, now);
        totals.projects += s.projects;
        totals.candidates += s.candidates;
        totals.notified += s.notified;
        totals.escalatedToPm += s.escalatedToPm;
        totals.signals += s.signals;
      });
      return { ...result, ...totals };
    },
  });
}

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });

export const escalationRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("rfis", "read")];
  const adminGate = [app.authenticate, app.requireCompany, app.requireTool("rfis", "admin")];

  app.get("/projects/:projectId/field/escalations", { preHandler: readGate }, async (req) => {
    const q = listQuery.parse(req.query);
    const items = await app.db
      .select()
      .from(fieldEscalations)
      .where(and(eq(fieldEscalations.companyId, req.companyId!), eq(fieldEscalations.projectId, req.projectId!)))
      .orderBy(desc(fieldEscalations.notifiedAt))
      .limit(q.limit);
    const byLevel: Record<string, number> = { "1": 0, "2": 0, "3": 0 };
    for (const i of items) byLevel[String(i.level)] = (byLevel[String(i.level)] ?? 0) + 1;
    return { items, byLevel, job: ESCALATION_JOB };
  });

  app.post("/projects/:projectId/field/escalations/run", { preHandler: adminGate }, async (req) => {
    const summary = await sweepFieldEscalations(app, req.companyId!, new Date(), { projectId: req.projectId!, actorId: req.user!.id });
    return { ran: true, ...summary };
  });
};
