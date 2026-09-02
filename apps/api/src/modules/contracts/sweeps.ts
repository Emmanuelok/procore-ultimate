/**
 * Time-bar sweeps (spec Vol II Domain C #229-231).
 *
 * WHAT WAS BROKEN
 * The sweep was a closure called from ONE read route: GET .../events. If
 * nobody opened a contract's Events tab, an overdue notice never became
 * time-barred, the obligation never breached, no signal was raised and nothing
 * reached the ledger. There were no pre-expiry warnings at all, and the
 * per-row update was not atomic — two concurrent readers both inserted a
 * critical signal and both wrote a state_change for the same transition, with
 * the READING user recorded as the actor of a change they did not make.
 *
 * WHAT THIS IS
 * Two idempotent sweeps run by the platform scheduler over every tenant with
 * the system actor:
 *   contracts.time-bars    hourly — breach past-deadline events, atomically
 *   contracts.ce-clocks    hourly — NEC quotation reply clocks and deemed acceptance
 *
 * The breach transition uses `UPDATE … WHERE id = ? AND status = 'open'
 * RETURNING id`, and the signal and ledger entry are written ONLY when a row
 * comes back — so a losing racer writes nothing.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { ceQuotations, contractEvents, contracts, obligations, signals } from "@constructos/db";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import type { Db } from "../../lib/db.js";
import { forEachCompany } from "../../lib/scheduler.js";
import { pushNotifications } from "../notifications/service.js";
import { deemedAcceptance } from "./ce.js";
import { daysBetweenIso } from "./timebar.js";

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Raise a signal once per condition, keyed in evidenceRefs.key. */
export async function raiseSignalOnce(
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
  });
  return true;
}

export interface TimeBarSweepResult {
  breached: number;
  warned: number;
  scanned: number;
}

/**
 * Sweep one company's open contract events.
 *
 * `actorId: null` is the system actor: a state change nobody performed is
 * attributed to the platform, not to whoever happened to load a page.
 */
export async function sweepTimeBars(
  db: Db,
  companyId: string,
  now: Date,
  options: { projectId?: string; contractIds?: string[] } = {},
): Promise<TimeBarSweepResult> {
  const todayIso = today(now);
  const clauses = [
    eq(contractEvents.companyId, companyId),
    eq(contractEvents.status, "open"),
    isNotNull(contractEvents.noticeDeadline),
  ];
  if (options.projectId) clauses.push(eq(contractEvents.projectId, options.projectId));
  if (options.contractIds && options.contractIds.length > 0) {
    clauses.push(inArray(contractEvents.contractId, options.contractIds));
  }
  const candidates = await db
    .select()
    .from(contractEvents)
    .where(and(...clauses));

  let breached = 0;
  let warned = 0;
  for (const ev of candidates) {
    const deadline = ev.noticeDeadline!;
    if (todayIso > deadline) {
      // Atomic claim: only the writer that actually flips the row emits.
      const claimed = await db
        .update(contractEvents)
        .set({ status: "time_barred", updatedAt: now.toISOString() })
        .where(and(eq(contractEvents.id, ev.id), eq(contractEvents.status, "open")))
        .returning({ id: contractEvents.id });
      if (claimed.length === 0) continue;
      breached += 1;
      if (ev.obligationId) {
        await db
          .update(obligations)
          .set({ status: "breached" })
          .where(and(eq(obligations.id, ev.obligationId), eq(obligations.status, "open")));
      }
      await raiseSignalOnce(db, {
        companyId,
        projectId: ev.projectId,
        detector: "time_bar_missed",
        key: `time_bar_missed:${ev.id}`,
        severity: "critical",
        confidence: 1,
        title: `Notice time bar missed — event #${ev.number}: ${ev.title}`,
        explanation:
          `Contract event #${ev.number} (${ev.kind}${ev.clauseRef ? `, clause ${ev.clauseRef}` : ""}) ` +
          `dated ${ev.eventDate}${ev.awarenessDate ? ` (awareness ${ev.awarenessDate})` : ""} required a notice by ${deadline}` +
          `${ev.deadlineSource === "particular_condition" ? ", as amended by the Particular Conditions" : ""}. ` +
          `No notice was recorded before the deadline elapsed; the event is now time-barred and any related entitlement is at risk.`,
        evidenceRefs: {
          eventId: ev.id,
          contractId: ev.contractId,
          noticeDeadline: deadline,
          deadlineSource: ev.deadlineSource,
        },
      });
      await appendLedger(db, {
        companyId,
        actorId: null,
        action: "state_change",
        objectType: "contract_event",
        objectId: ev.id,
        projectId: ev.projectId,
        payload: {
          from: "open",
          to: "time_barred",
          noticeDeadline: deadline,
          deadlineSource: ev.deadlineSource,
          sweptBy: "contracts.time-bars",
        },
      });
      await pushNotifications(db, [
        {
          companyId,
          userId: ev.raisedBy,
          projectId: ev.projectId,
          kind: "overdue",
          title: `Time bar missed on event #${ev.number}`,
          body: `The notice for "${ev.title}" was due by ${deadline}.`,
          recordType: "contract_event",
          recordId: ev.id,
        },
      ]);
      continue;
    }

    // Pre-expiry warning (#229): once, inside the warning window.
    const warn = ev.warnDaysBefore ?? 0;
    if (warn <= 0 || ev.warnedAt) continue;
    const daysRemaining = daysBetweenIso(todayIso, deadline);
    if (daysRemaining > warn) continue;
    const claimed = await db
      .update(contractEvents)
      .set({ warnedAt: now.toISOString() })
      .where(
        and(
          eq(contractEvents.id, ev.id),
          eq(contractEvents.status, "open"),
          sql`${contractEvents.warnedAt} is null`,
        ),
      )
      .returning({ id: contractEvents.id });
    if (claimed.length === 0) continue;
    warned += 1;
    await raiseSignalOnce(db, {
      companyId,
      projectId: ev.projectId,
      detector: "time_bar_warning",
      key: `time_bar_warning:${ev.id}`,
      severity: daysRemaining <= 2 ? "high" : "medium",
      confidence: 1,
      title: `Notice due in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} — event #${ev.number}`,
      explanation:
        `The notice for contract event #${ev.number} ("${ev.title}"${ev.clauseRef ? `, clause ${ev.clauseRef}` : ""}) ` +
        `must be served by ${deadline}` +
        `${ev.deadlineSource === "particular_condition" ? " under the amended Particular Condition" : ""}. ` +
        `Serving late risks the entitlement under a condition-precedent bar.`,
      evidenceRefs: {
        eventId: ev.id,
        contractId: ev.contractId,
        noticeDeadline: deadline,
        daysRemaining,
      },
    });
    await pushNotifications(db, [
      {
        companyId,
        userId: ev.raisedBy,
        projectId: ev.projectId,
        kind: "due_soon",
        title: `Notice due ${deadline} — event #${ev.number}`,
        body: `"${ev.title}" needs a notice within ${daysRemaining} day${daysRemaining === 1 ? "" : "s"}.`,
        recordType: "contract_event",
        recordId: ev.id,
      },
    ]);
  }

  return { breached, warned, scanned: candidates.length };
}

/**
 * NEC quotation clocks: a Project Manager's reply that is overdue, and — under
 * NEC4 — the point at which silence becomes deemed acceptance (62.6 / 64.4).
 */
export async function sweepCeClocks(
  db: Db,
  companyId: string,
  now: Date,
): Promise<{ overdue: number; deemed: number }> {
  const todayIso = today(now);
  const rows = await db
    .select({ q: ceQuotations, form: contracts.form })
    .from(ceQuotations)
    .innerJoin(contracts, eq(contracts.id, ceQuotations.contractId))
    .where(
      and(
        eq(ceQuotations.companyId, companyId),
        eq(ceQuotations.status, "submitted"),
        isNotNull(ceQuotations.replyDueDate),
        lte(ceQuotations.replyDueDate, todayIso),
      ),
    );
  let overdue = 0;
  let deemed = 0;
  for (const { q, form } of rows) {
    const verdict = deemedAcceptance({
      quotationStatus: q.status,
      replyDueDate: q.replyDueDate,
      repliedAt: q.repliedAt,
      today: todayIso,
      form,
    });
    if (!verdict.overdue) continue;
    overdue += 1;
    if (verdict.deemed) {
      const claimed = await db
        .update(ceQuotations)
        .set({
          status: "deemed_accepted",
          deemedAcceptedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        })
        .where(and(eq(ceQuotations.id, q.id), eq(ceQuotations.status, "submitted")))
        .returning({ id: ceQuotations.id });
      if (claimed.length === 0) continue;
      deemed += 1;
      await db
        .update(contractEvents)
        .set({ ceState: "implemented", deemedAcceptedAt: now.toISOString() })
        .where(eq(contractEvents.id, q.eventId));
      await appendLedger(db, {
        companyId,
        actorId: null,
        action: "state_change",
        objectType: "ce_quotation",
        objectId: q.id,
        projectId: q.projectId,
        payload: {
          from: "submitted",
          to: "deemed_accepted",
          replyDueDate: q.replyDueDate,
          total: q.total,
          reason: verdict.reason,
        },
        storePayload: true,
      });
    }
    await raiseSignalOnce(db, {
      companyId,
      projectId: q.projectId,
      detector: "ce_deemed_acceptance",
      key: `ce_reply_overdue:${q.id}${verdict.deemed ? ":deemed" : ""}`,
      severity: verdict.deemed ? "high" : "medium",
      confidence: 1,
      title: verdict.deemed
        ? `Compensation-event quotation deemed accepted (${q.total})`
        : `Project Manager's reply overdue by ${verdict.daysOverdue} days`,
      explanation: verdict.reason,
      evidenceRefs: {
        quotationId: q.id,
        eventId: q.eventId,
        replyDueDate: q.replyDueDate,
        total: q.total,
        currency: q.currency,
      },
    });
  }
  return { overdue, deemed };
}

export function registerContractJobs(app: FastifyInstance): void {
  app.scheduler.register({
    name: "contracts.time-bars",
    description:
      "Record time-bar breaches on open contract events and warn ahead of every notice deadline",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => sweepTimeBars(db, companyId, now)),
  });
  app.scheduler.register({
    name: "contracts.ce-clocks",
    description:
      "Watch NEC compensation-event quotation reply clocks and apply deemed acceptance where the form provides it",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => sweepCeClocks(db, companyId, now)),
  });
}
