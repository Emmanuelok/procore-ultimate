/**
 * Scheduled work for dispute resolution.
 *
 *  1. `disputes.deadlines` — breaches the obligation behind any timetable
 *     step past its due date. Missing a procedural deadline in adjudication
 *     is frequently fatal, so this cannot wait for somebody to open the
 *     page: it runs on a schedule, and the read path still calls it so a
 *     page opened between cycles is current.
 *  2. `disputes.offers` — lapses settlement offers past their expiry. An
 *     offer received six months ago that expired after 21 days is not a
 *     price the counterparty is still willing to pay, and leaving it "open"
 *     drove a settle recommendation against a number nobody was offering.
 *  3. `disputes.enforcement` — raises a signal when a decision's compliance
 *     deadline passes without payment, and when the notice-of-dissatisfaction
 *     window is about to close (#333).
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { disputes, obligations, settlementOffers } from "@constructos/db";
import { forEachCompany } from "../../lib/scheduler.js";
import type { Db } from "../../lib/db.js";
import { appendLedger } from "../../lib/ledger.js";
import { closeSignalByKey, raiseSignalOnce } from "../governance/signals.js";

/** A procedural timetable step, as stored in disputes.timetable. */
export interface TimetableStepRow {
  id: string;
  name: string;
  dueDate: string | null;
  obligationId: string | null;
  done: boolean;
  doneAt: string | null;
  breachedAt: string | null;
  /** regime step key when the step came from a generated timetable */
  key?: string | null;
  owner?: string | null;
  authority?: string | null;
  extendedDueDate?: string | null;
}

export const ACTIVE_STATUSES = ["notified", "referred", "submissions", "hearing"] as const;
export const TERMINAL_STATUSES = ["decided", "settled", "withdrawn"] as const;

/* ------------------------------------------------------------------ */
/* Missed procedural deadlines (#338)                                  */
/* ------------------------------------------------------------------ */

export async function sweepMissedDeadlines(
  db: Db,
  companyId: string,
  today: string,
  projectId?: string,
): Promise<{ disputes: number; breached: number }> {
  const clauses = [
    eq(disputes.companyId, companyId),
    inArray(disputes.status, [...ACTIVE_STATUSES]),
  ];
  if (projectId) clauses.push(eq(disputes.projectId, projectId));
  const rows = await db
    .select()
    .from(disputes)
    .where(and(...clauses));
  let breached = 0;
  for (const d of rows) {
    const steps = d.timetable as TimetableStepRow[];
    const overdue = steps.filter(
      (s) => s.dueDate !== null && !s.done && !s.breachedAt && s.dueDate < today,
    );
    if (overdue.length === 0) continue;
    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      for (const step of overdue) {
        step.breachedAt = now;
        if (step.obligationId) {
          await tx
            .update(obligations)
            .set({ status: "breached" })
            .where(and(eq(obligations.id, step.obligationId), eq(obligations.status, "open")));
        }
        await appendLedger(tx as Db, {
          companyId,
          actorId: null,
          action: "state_change",
          objectType: "dispute_timetable_step",
          objectId: step.id,
          payload: {
            disputeId: d.id,
            step: step.name,
            dueDate: step.dueDate,
            status: "breached",
            obligationId: step.obligationId,
          },
          projectId: d.projectId,
        });
      }
      await tx.update(disputes).set({ timetable: steps }).where(eq(disputes.id, d.id));
    });
    for (const step of overdue) {
      await raiseSignalOnce(db, {
        companyId,
        projectId: d.projectId,
        detector: "dispute_deadline_missed",
        key: step.id,
        severity: "high",
        confidence: 1,
        title: `Dispute timetable deadline missed — ${step.name} (dispute #${d.number})`,
        explanation:
          `Procedural timetable step "${step.name}" of ${d.kind} dispute #${d.number} ` +
          `("${d.title}") was due on ${step.dueDate} and has not been completed. Missing a ` +
          `procedural deadline can be fatal in adjudication and arbitration: the tribunal may ` +
          `disregard late submissions or draw adverse inferences.` +
          (step.authority ? ` Authority: ${step.authority}.` : ""),
        subjectType: "dispute",
        subjectId: d.id,
        evidenceRefs: { disputeId: d.id, stepId: step.id, dueDate: step.dueDate },
      });
      breached += 1;
    }
  }
  return { disputes: rows.length, breached };
}

/* ------------------------------------------------------------------ */
/* Offer expiry (#352)                                                 */
/* ------------------------------------------------------------------ */

/**
 * Flip open offers past their expiry date to `lapsed`.
 *
 * Without this an expired offer stayed "open" forever: it remained the best
 * open offer, drove a "settle" recommendation, and could be accepted to
 * settle the dispute at a price the counterparty had already withdrawn.
 */
export async function sweepExpiredOffers(
  db: Db,
  companyId: string,
  today: string,
  disputeIds?: string[],
): Promise<{ lapsed: number }> {
  const clauses = [eq(settlementOffers.companyId, companyId), eq(settlementOffers.status, "open")];
  if (disputeIds && disputeIds.length > 0) {
    clauses.push(inArray(settlementOffers.disputeId, disputeIds));
  }
  const open = await db
    .select()
    .from(settlementOffers)
    .where(and(...clauses));
  const expired = open.filter((o) => o.expiresAt !== null && o.expiresAt < today);
  if (expired.length === 0) return { lapsed: 0 };
  const now = new Date().toISOString();
  let lapsed = 0;
  for (const offer of expired) {
    const updated = await db
      .update(settlementOffers)
      .set({ status: "lapsed", updatedAt: now })
      .where(and(eq(settlementOffers.id, offer.id), eq(settlementOffers.status, "open")))
      .returning({ id: settlementOffers.id });
    if (updated.length === 0) continue;
    await appendLedger(db, {
      companyId,
      actorId: null,
      action: "state_change",
      objectType: "settlement_offer",
      objectId: offer.id,
      payload: {
        from: "open",
        to: "lapsed",
        expiresAt: offer.expiresAt,
        disputeId: offer.disputeId,
        sweep: true,
      },
      storePayload: true,
    });
    lapsed += 1;
  }
  return { lapsed };
}

/* ------------------------------------------------------------------ */
/* Enforcement of decisions (#333)                                     */
/* ------------------------------------------------------------------ */

export async function sweepEnforcement(
  db: Db,
  companyId: string,
  today: string,
): Promise<{ checked: number; raised: number }> {
  const rows = await db
    .select()
    .from(disputes)
    .where(and(eq(disputes.companyId, companyId), eq(disputes.status, "decided")));
  let raised = 0;
  for (const d of rows) {
    if (
      d.complianceDeadline &&
      d.complianceDeadline < today &&
      d.enforcementStatus !== "complied" &&
      d.enforcementStatus !== "enforced"
    ) {
      const outcome = await raiseSignalOnce(db, {
        companyId,
        projectId: d.projectId,
        detector: "dispute_decision_not_complied",
        key: d.id,
        severity: "critical",
        confidence: 1,
        title: `Decision not complied with — dispute #${d.number}`,
        explanation:
          `The decision in ${d.kind} dispute #${d.number} ("${d.title}") required compliance by ` +
          `${d.complianceDeadline} and the record still shows "${d.enforcementStatus}". An ` +
          `adjudicator's decision is binding until finally determined; non-compliance is enforceable ` +
          `and usually attracts interest and costs.`,
        subjectType: "dispute",
        subjectId: d.id,
        evidenceRefs: { disputeId: d.id, complianceDeadline: d.complianceDeadline },
      });
      if (outcome.raised) raised += 1;
    } else if (d.enforcementStatus === "complied" || d.enforcementStatus === "enforced") {
      await closeSignalByKey(
        db,
        companyId,
        "dispute_decision_not_complied",
        d.id,
        "The decision has been complied with or enforced.",
      );
    }
    if (d.nodDeadline && d.nodDeadline >= today) {
      const days = Math.round(
        (Date.parse(`${d.nodDeadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
      );
      if (days <= 7) {
        const outcome = await raiseSignalOnce(db, {
          companyId,
          projectId: d.projectId,
          detector: "notice_of_dissatisfaction_window",
          key: d.id,
          severity: "high",
          confidence: 1,
          title: `Notice of dissatisfaction window closing — dispute #${d.number}`,
          explanation:
            `The window to serve a notice of dissatisfaction on the decision in dispute ` +
            `#${d.number} closes on ${d.nodDeadline} (${days} day(s) away). Once it closes the ` +
            `decision becomes final and binding and cannot be reopened in arbitration.`,
          subjectType: "dispute",
          subjectId: d.id,
          evidenceRefs: { disputeId: d.id, nodDeadline: d.nodDeadline },
        });
        if (outcome.raised) raised += 1;
      }
    }
  }
  return { checked: rows.length, raised };
}

/* ------------------------------------------------------------------ */
/* Terminal-status cleanup (#338)                                      */
/* ------------------------------------------------------------------ */

/**
 * Close out the obligations of a dispute that has ended.
 *
 * A settled or withdrawn dispute used to leave every not-done step's
 * obligation `open` forever: the sweep only looked at ACTIVE disputes, so
 * those rows never breached, never satisfied and never closed — orphans on
 * the assurance register. On a terminal transition the remaining
 * obligations are now resolved: `satisfied` where the dispute was decided
 * (the process ran its course) and `waived` where it settled or was
 * withdrawn (the process stopped by agreement).
 */
export async function closeTimetableObligations(
  tx: Db,
  args: {
    companyId: string;
    projectId: string;
    actorId: string | null;
    disputeId: string;
    steps: TimetableStepRow[];
    terminalStatus: string;
  },
): Promise<{ resolved: number; to: string }> {
  const to = args.terminalStatus === "decided" ? "satisfied" : "waived";
  const open = args.steps.filter((s) => !s.done && s.obligationId);
  let resolved = 0;
  for (const step of open) {
    const updated = await tx
      .update(obligations)
      .set({ status: to })
      .where(
        and(
          eq(obligations.id, step.obligationId!),
          inArray(obligations.status, ["open", "breached"]),
        ),
      )
      .returning({ id: obligations.id });
    if (updated.length > 0) resolved += 1;
  }
  if (resolved > 0) {
    await appendLedger(tx, {
      companyId: args.companyId,
      actorId: args.actorId,
      action: "state_change",
      objectType: "dispute",
      objectId: args.disputeId,
      payload: {
        event: "timetable_obligations_closed",
        terminalStatus: args.terminalStatus,
        obligationStatus: to,
        resolved,
      },
      storePayload: true,
      projectId: args.projectId,
    });
  }
  return { resolved, to };
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

export function registerDisputeJobs(app: FastifyInstance): void {
  app.scheduler.register({
    name: "disputes.deadlines",
    description:
      "Breach the obligation behind any procedural timetable step past its due date and raise the signal — missing an adjudication deadline is frequently fatal",
    everyMs: 3 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        sweepMissedDeadlines(db, companyId, now.toISOString().slice(0, 10)),
      ),
  });

  app.scheduler.register({
    name: "disputes.offers",
    description:
      "Lapse settlement offers past their expiry date so an expired offer stops driving the settlement recommendation",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        sweepExpiredOffers(db, companyId, now.toISOString().slice(0, 10)),
      ),
  });

  app.scheduler.register({
    name: "disputes.enforcement",
    description:
      "Flag decisions past their compliance deadline and notice-of-dissatisfaction windows about to close",
    everyMs: 12 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        sweepEnforcement(db, companyId, now.toISOString().slice(0, 10)),
      ),
  });
}
