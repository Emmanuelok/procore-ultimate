/**
 * Scheduled sweeps for the commercial module.
 *
 *   commercial.payment-due      hourly  certificates past their statutory due date
 *   commercial.retention-due    daily   retention that has fallen due for release
 *
 * Both are idempotent (a condition already signalled is never signalled again),
 * bounded per company, and run with the system actor. The read paths do not
 * sweep: a deadline that only exists when somebody opens a page is not a
 * deadline the platform is keeping.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNotNull, lt, ne } from "drizzle-orm";
import {
  boqs,
  contracts,
  paymentCertificates,
  retentionReleases,
  valuations,
} from "@constructos/db";
import type { Db } from "../../lib/db.js";
import { forEachCompany } from "../../lib/scheduler.js";
import { pushNotifications } from "../notifications/service.js";
import { raiseSignalOnce, round2 } from "./shared.js";
import { retentionSchedule } from "./valuation-engine.js";

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * A certificate whose due date has passed and which is not recorded as paid
 * is a late payment: interest runs and, in most forms, a suspension right
 * accrues. It is raised once per certificate.
 */
export async function sweepOverduePayments(
  db: Db,
  companyId: string,
  now: Date,
): Promise<{ overdue: number; raised: number }> {
  const todayIso = today(now);
  const rows = await db
    .select()
    .from(paymentCertificates)
    .where(
      and(
        eq(paymentCertificates.companyId, companyId),
        eq(paymentCertificates.status, "issued"),
        isNotNull(paymentCertificates.dueDate),
        lt(paymentCertificates.dueDate, todayIso),
      ),
    );
  let raised = 0;
  for (const cert of rows) {
    const daysLate = Math.round(
      (Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(`${cert.dueDate}T00:00:00Z`)) / 86_400_000,
    );
    const res = await raiseSignalOnce(db, {
      companyId,
      projectId: cert.projectId,
      detector: "payment_overdue",
      key: `payment_overdue:${cert.id}`,
      severity: daysLate > 28 ? "high" : "medium",
      confidence: 1,
      title: `Payment certificate ${cert.number} is ${daysLate} day${daysLate === 1 ? "" : "s"} overdue`,
      explanation:
        `Certificate ${cert.number} for ${cert.netCertified} ${cert.currency} fell due on ${cert.dueDate} ` +
        `and is not recorded as paid. ${cert.dueDateBasis ?? "The due date was set on the certificate."} ` +
        `Late payment normally attracts financing charges and, after notice, a right to suspend or reduce the rate of work.`,
      evidenceRefs: {
        certificateId: cert.id,
        dueDate: cert.dueDate,
        daysLate,
        amount: cert.netCertified,
        currency: cert.currency,
      },
    });
    if (res.raised) {
      raised += 1;
      await pushNotifications(db, [
        {
          companyId,
          userId: cert.issuedBy,
          projectId: cert.projectId,
          kind: "overdue",
          title: `Payment certificate ${cert.number} is overdue`,
          body: `${cert.netCertified} ${cert.currency} fell due on ${cert.dueDate}.`,
          recordType: "payment_certificate",
          recordId: cert.id,
        },
      ]);
    }
  }
  return { overdue: rows.length, raised };
}

/**
 * Retention that has fallen due for release — half at taking-over, the
 * balance at the end of the Defects Notification Period — and has not been
 * released. Raised once per bill per tranche.
 */
export async function sweepRetentionDue(
  db: Db,
  companyId: string,
  now: Date,
): Promise<{ checked: number; raised: number }> {
  const todayIso = today(now);
  const bills = await db
    .select()
    .from(boqs)
    .where(and(eq(boqs.companyId, companyId), isNotNull(boqs.contractId)));
  let raised = 0;
  let checked = 0;
  for (const bill of bills) {
    if (!bill.contractId) continue;
    const contractRows = await db
      .select()
      .from(contracts)
      .where(eq(contracts.id, bill.contractId))
      .limit(1);
    const contract = contractRows[0];
    if (!contract?.takingOverDate) continue;
    const latest = await db
      .select()
      .from(valuations)
      .where(and(eq(valuations.boqId, bill.id), ne(valuations.status, "draft")))
      .orderBy(valuations.number)
      .limit(500);
    const current = latest[latest.length - 1];
    if (!current || current.retentionHeld <= 0.005) continue;
    checked += 1;
    const releasedRows = await db
      .select({ amount: retentionReleases.amount })
      .from(retentionReleases)
      .where(eq(retentionReleases.boqId, bill.id));
    const alreadyReleased = round2(releasedRows.reduce((s, r) => s + r.amount, 0));
    const schedule = retentionSchedule({
      retentionHeld: current.retentionHeld,
      takingOverDate: contract.takingOverDate,
      defectsPeriodMonths: contract.defectsPeriodMonths,
      releaseAtTakingOver: contract.retentionReleaseAtTakingOver,
      asOf: todayIso,
      alreadyReleased,
    });
    if (schedule.dueNow <= 0.005) continue;
    const tranche =
      schedule.secondTrancheDate && todayIso >= schedule.secondTrancheDate ? "balance" : "first";
    const res = await raiseSignalOnce(db, {
      companyId,
      projectId: bill.projectId,
      detector: "retention_release_due",
      key: `retention_release_due:${bill.id}:${tranche}`,
      severity: "medium",
      confidence: 1,
      title: `Retention release due on ${bill.name}`,
      explanation:
        `${schedule.dueNow} ${bill.currency} of retention has fallen due for release. ` +
        schedule.reasons.join(" "),
      evidenceRefs: {
        boqId: bill.id,
        contractId: contract.id,
        dueNow: schedule.dueNow,
        tranche,
        currency: bill.currency,
      },
    });
    if (res.raised) raised += 1;
  }
  return { checked, raised };
}

export function registerCommercialJobs(app: FastifyInstance): void {
  app.scheduler.register({
    name: "commercial.payment-due",
    description:
      "Flag payment certificates past their contractual due date so late-payment interest and suspension rights are visible",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => sweepOverduePayments(db, companyId, now)),
  });
  app.scheduler.register({
    name: "commercial.retention-due",
    description:
      "Detect retention that has fallen due for release at taking-over or at the end of the defects period",
    everyMs: 24 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => sweepRetentionDue(db, companyId, now)),
  });
}
