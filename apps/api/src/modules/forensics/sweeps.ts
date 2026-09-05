/**
 * Time-driven forensics behaviour (registered with app.scheduler).
 *
 * One sweep: NOTICE TIME BARS. A delay event carries `noticeDueDate` — the
 * date the contract required a notice by. Missing that date is, under most
 * standard forms, the difference between a claim and nothing at all, so the
 * deadline must not live only inside the forensics register: the sweep opens
 * an Obligation for it (the register the whole platform escalates from),
 * raises a Signal when the bar is approaching or has passed, and notifies the
 * person who raised the event.
 *
 * Idempotence is the whole design:
 *  - the obligation id is stamped on the event, so exactly one is opened;
 *  - `noticeAlertedAt` plus a per-(detector, key) signal check means an
 *    approaching bar alerts once and a missed bar alerts once;
 *  - serving the notice (a contractEventId) or withdrawing the event closes
 *    the obligation rather than leaving it open forever.
 *
 * Runs with `actorId: null` — the system actor. Nobody performed these state
 * changes and attributing them to whoever loaded a page would be a lie.
 *
 * Deliberately NOT here: raising the notice itself. A notice is a contractual
 * act by a human; the platform can only make forgetting it hard.
 */
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { delayEvents, obligations, signals } from "@constructos/db";
import type { Db } from "../../lib/db.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { pushNotifications } from "../notifications/service.js";

const DAY_MS = 86_400_000;

/** Days from `b` to `a`, both ISO dates, as whole UTC days. */
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
    subjectType: "delay_event",
    subjectId: typeof a.evidenceRefs?.["eventId"] === "string" ? String(a.evidenceRefs["eventId"]) : null,
  });
  return true;
}

export interface NoticeSweepResult {
  scanned: number;
  obligationsOpened: number;
  obligationsClosed: number;
  dueSoon: number;
  missed: number;
  alerted: number;
}

/** How many days before the bar an "approaching" alert is raised. */
export const NOTICE_WARN_DAYS = 5;

/**
 * Sweep the notice time bars of one company.
 *
 * `options.projectId` narrows the sweep for the manual run endpoint; the
 * scheduled job runs company-wide. Bounded by company (and the status /
 * noticeDueDate index) — never an unbounded table scan.
 */
export async function sweepNoticeTimeBars(
  db: Db,
  companyId: string,
  now: Date,
  options: { projectId?: string } = {},
): Promise<NoticeSweepResult> {
  const clauses = [eq(delayEvents.companyId, companyId), isNotNull(delayEvents.noticeDueDate)];
  if (options.projectId) clauses.push(eq(delayEvents.projectId, options.projectId));
  const rows = await db
    .select()
    .from(delayEvents)
    .where(and(...clauses))
    .limit(5000);

  const today = now.toISOString().slice(0, 10);
  const nowIso = now.toISOString();
  const result: NoticeSweepResult = {
    scanned: rows.length,
    obligationsOpened: 0,
    obligationsClosed: 0,
    dueSoon: 0,
    missed: 0,
    alerted: 0,
  };

  for (const ev of rows) {
    const due = ev.noticeDueDate;
    if (!due) continue;
    /* Served, withdrawn or closed: the bar no longer bites. Close the
     * obligation with the right disposition and stop alerting. */
    const served = typeof ev.contractEventId === "string" && ev.contractEventId.length > 0;
    const dead = ev.status === "withdrawn" || ev.status === "closed";
    if (served || dead) {
      if (ev.noticeObligationId) {
        const [obl] = await db
          .select({ id: obligations.id, status: obligations.status })
          .from(obligations)
          .where(eq(obligations.id, ev.noticeObligationId))
          .limit(1);
        if (obl && obl.status === "open") {
          await db
            .update(obligations)
            .set({
              status: served ? "satisfied" : "waived",
              ...(served ? { satisfiedEvidenceId: ev.contractEventId } : {}),
            })
            .where(eq(obligations.id, obl.id));
          await appendLedger(db, {
            companyId,
            actorId: null,
            action: "state_change",
            objectType: "obligation",
            objectId: obl.id,
            projectId: ev.projectId,
            payload: {
              from: "open",
              to: served ? "satisfied" : "waived",
              reason: served ? "notice served" : `delay event ${ev.status}`,
              delayEventId: ev.id,
            },
          });
          result.obligationsClosed += 1;
        }
      }
      continue;
    }

    /* Live and unserved: make sure the deadline exists as an obligation. */
    let obligationId = ev.noticeObligationId;
    if (!obligationId) {
      obligationId = newId("obl");
      await db.insert(obligations).values({
        id: obligationId,
        companyId,
        projectId: ev.projectId,
        sourceClause: `Notice time bar — delay event DE-${String(ev.number).padStart(3, "0")}`,
        trigger:
          `A notice for "${ev.title}" must be served by ${due}. Under most standard forms a late ` +
          "notice extinguishes the entitlement the event would otherwise carry.",
        deadline: `${due}T23:59:59.000Z`,
        warnDaysBefore: NOTICE_WARN_DAYS,
        evidenceRequirement:
          "The served notice recorded as a contract event and linked to this delay event.",
        status: "open",
        createdBy: ev.raisedBy,
      });
      await db
        .update(delayEvents)
        .set({ noticeObligationId: obligationId, updatedAt: nowIso })
        .where(eq(delayEvents.id, ev.id));
      await appendLedger(db, {
        companyId,
        actorId: null,
        action: "create",
        objectType: "obligation",
        objectId: obligationId,
        projectId: ev.projectId,
        payload: { delayEventId: ev.id, deadline: due, kind: "notice_time_bar" },
      });
      result.obligationsOpened += 1;
    }

    const daysLeft = diffDays(due, today);
    if (daysLeft > NOTICE_WARN_DAYS) continue;

    const missed = daysLeft < 0;
    if (missed) result.missed += 1;
    else result.dueSoon += 1;

    /* Mark the obligation breached the moment the bar passes — an obligation
     * that stays "open" past its deadline understates the exposure. */
    if (missed && obligationId) {
      const [obl] = await db
        .select({ id: obligations.id, status: obligations.status })
        .from(obligations)
        .where(eq(obligations.id, obligationId))
        .limit(1);
      if (obl && obl.status === "open") {
        await db.update(obligations).set({ status: "breached" }).where(eq(obligations.id, obl.id));
        await appendLedger(db, {
          companyId,
          actorId: null,
          action: "state_change",
          objectType: "obligation",
          objectId: obl.id,
          projectId: ev.projectId,
          payload: { from: "open", to: "breached", deadline: due, delayEventId: ev.id },
        });
      }
    }

    const detector = missed ? "forensics.notice_time_bar_missed" : "forensics.notice_time_bar_due";
    const raised = await raiseSignalOnce(db, {
      companyId,
      projectId: ev.projectId,
      detector,
      key: ev.id,
      severity: missed ? "critical" : "high",
      confidence: 1,
      title: missed
        ? `Notice time bar missed on DE-${String(ev.number).padStart(3, "0")}`
        : `Notice due in ${daysLeft} day${daysLeft === 1 ? "" : "s"} on DE-${String(ev.number).padStart(3, "0")}`,
      explanation: missed
        ? `The contract required a notice for "${ev.title}" by ${due}; none is recorded against the event ` +
          `and it is now ${Math.abs(daysLeft)} day(s) past. Entitlement for this event may be barred — ` +
          "record the notice if one was served outside the platform."
        : `A notice for "${ev.title}" must be served by ${due} (${daysLeft} day(s) away). No contract event ` +
          "is linked to this delay event yet.",
      evidenceRefs: {
        eventId: ev.id,
        number: ev.number,
        noticeDueDate: due,
        obligationId,
        daysLeft,
      },
    });
    if (!raised) continue;

    result.alerted += 1;
    await db
      .update(delayEvents)
      .set({ noticeAlertedAt: nowIso, updatedAt: nowIso })
      .where(eq(delayEvents.id, ev.id));
    await pushNotifications(db, [
      {
        companyId,
        userId: ev.raisedBy,
        projectId: ev.projectId,
        kind: missed ? ("overdue" as const) : ("due_soon" as const),
        title: missed
          ? `Notice time bar missed: ${ev.title}`
          : `Notice due ${due}: ${ev.title}`,
        body: missed
          ? `The notice was due ${due} and none is recorded. Entitlement may be barred.`
          : `Serve and record the notice for DE-${String(ev.number).padStart(3, "0")} by ${due}.`,
        recordType: "delay_event",
        recordId: ev.id,
      },
    ]);
    await appendLedger(db, {
      companyId,
      actorId: null,
      action: "state_change",
      objectType: "delay_event",
      objectId: ev.id,
      projectId: ev.projectId,
      payload: { noticeTimeBar: missed ? "missed" : "due_soon", noticeDueDate: due, daysLeft },
    });
  }

  return result;
}

/**
 * Live notice exposure for a project — the figures the workspace and the
 * health-inputs endpoint quote. Bounded to one project.
 */
export async function noticeExposure(
  db: Db,
  companyId: string,
  projectId: string,
  today: string,
): Promise<{ withDueDate: number; unserved: number; dueSoon: number; missed: number }> {
  const rows = await db
    .select({
      id: delayEvents.id,
      noticeDueDate: delayEvents.noticeDueDate,
      contractEventId: delayEvents.contractEventId,
    })
    .from(delayEvents)
    .where(
      and(
        eq(delayEvents.companyId, companyId),
        eq(delayEvents.projectId, projectId),
        isNotNull(delayEvents.noticeDueDate),
        ne(delayEvents.status, "withdrawn"),
        ne(delayEvents.status, "closed"),
      ),
    )
    .limit(5000);
  let unserved = 0;
  let dueSoon = 0;
  let missed = 0;
  for (const r of rows) {
    const due = r.noticeDueDate;
    if (!due || r.contractEventId) continue;
    unserved += 1;
    const daysLeft = diffDays(due, today);
    if (daysLeft < 0) missed += 1;
    else if (daysLeft <= NOTICE_WARN_DAYS) dueSoon += 1;
  }
  return { withDueDate: rows.length, unserved, dueSoon, missed };
}
