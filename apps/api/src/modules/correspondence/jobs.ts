/**
 * Scheduler jobs for the correspondence module. Each job is the same service
 * a button calls, run for every tenant with the system actor, bounded to the
 * projects that actually have something open, and idempotent.
 *
 *   correspondence.response-due   30 min  letters past their response date
 *   correspondence.ack-due        60 min  transmittals nobody acknowledged
 *   correspondence.plan-due       60 min  overdue action-plan activities and
 *                                         plan status re-derivation
 *   correspondence.form-due       60 min  form assignments past due
 *
 * A platform whose product is "the deadline was missed and here is the
 * record" cannot depend on someone opening the register to notice.
 */
import type { FastifyInstance } from "fastify";
import type { Db } from "../../lib/db.js";
import { forEachCompany } from "../../lib/scheduler.js";
import {
  projectsWithOpenCorrespondence,
  sweepAckDue,
  sweepFormDue,
  sweepPlanDue,
  sweepResponseDue,
  type SweepResult,
} from "./service.js";

const today = (now: Date): string => now.toISOString().slice(0, 10);

type Sweep = (
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  today: string,
) => Promise<SweepResult>;

async function runForCompany(db: Db, companyId: string, now: Date, sweep: Sweep) {
  const totals = { scanned: 0, raised: 0, notified: 0, projects: 0 };
  for (const projectId of await projectsWithOpenCorrespondence(db, companyId)) {
    const r = await sweep(db, companyId, projectId, null, today(now));
    totals.scanned += r.scanned;
    totals.raised += r.raised;
    totals.notified += r.notified;
    totals.projects += 1;
  }
  return totals;
}

export const runResponseDueJob = (db: Db, companyId: string, now: Date) =>
  runForCompany(db, companyId, now, sweepResponseDue);
export const runAckDueJob = (db: Db, companyId: string, now: Date) =>
  runForCompany(db, companyId, now, sweepAckDue);
export const runPlanDueJob = (db: Db, companyId: string, now: Date) =>
  runForCompany(db, companyId, now, sweepPlanDue);
export const runFormDueJob = (db: Db, companyId: string, now: Date) =>
  runForCompany(db, companyId, now, sweepFormDue);

export function registerCorrespondenceJobs(app: FastifyInstance): void {
  app.scheduler.register({
    name: "correspondence.response-due",
    description:
      "Raise a signal and chase the author once for every letter whose response date has passed with no answer recorded",
    everyMs: 30 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => runResponseDueJob(db, companyId, now)),
  });
  app.scheduler.register({
    name: "correspondence.ack-due",
    description:
      "Raise a signal for every issued transmittal whose recipients have not acknowledged receipt by the due date",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => runAckDueJob(db, companyId, now)),
  });
  app.scheduler.register({
    name: "correspondence.plan-due",
    description:
      "Re-derive action plan progress and quality-checkpoint holds, and raise a signal for plans with overdue activities",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => runPlanDueJob(db, companyId, now)),
  });
  app.scheduler.register({
    name: "correspondence.form-due",
    description: "Raise a signal and chase the assignee for every form assignment past its due date",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => runFormDueJob(db, companyId, now)),
  });
}
