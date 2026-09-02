/**
 * Scheduler jobs for the design module. Each job is the same service a button
 * calls, run for every tenant with the system actor, bounded per project, and
 * idempotent: a condition already signalled is never raised twice, an
 * obligation already open is not opened again, a readiness verdict that has
 * not moved writes no snapshot.
 *
 *   design.deliverables       hourly  re-assess slippage, keep obligations in
 *                                     step, raise late signals
 *   design.reviews            hourly  overdue review cycles → signal + notify
 *   design.information        6-hourly overdue EIR/BEP/TIDP → obligation + signal
 *   design.issues             daily   stale issues by priority → signal
 *   design.change-control     daily   design churn per package, professional
 *                                     indemnity adequacy
 *   design.readiness          daily   handover readiness snapshots
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import {
  designChangeNotices,
  designConsultants,
  designDeliverables,
  designInfoRequirements,
  designIssues,
  designPackages,
  designReviews,
} from "@constructos/db";
import type { Db } from "../../lib/db.js";
import { forEachCompany } from "../../lib/scheduler.js";
import {
  OPEN_ISSUE_STATUSES,
  OPEN_REVIEW_STATUSES,
  computeReadiness,
  sweepChangeFrequency,
  sweepDeliverables,
  sweepInfoRequirements,
  sweepIssues,
  sweepProfessionalIndemnity,
  sweepReviews,
} from "./service.js";

const today = (now: Date): string => now.toISOString().slice(0, 10);

async function projectsWithDeliverables(db: Db, companyId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ projectId: designDeliverables.projectId })
    .from(designDeliverables)
    .where(and(eq(designDeliverables.companyId, companyId), inArray(designDeliverables.status, ["planned", "in_progress", "issued", "rejected"])));
  return rows.map((r) => r.projectId);
}

async function projectsWithOpenReviews(db: Db, companyId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ projectId: designReviews.projectId })
    .from(designReviews)
    .where(and(eq(designReviews.companyId, companyId), inArray(designReviews.status, [...OPEN_REVIEW_STATUSES])));
  return rows.map((r) => r.projectId);
}

async function projectsWithOpenIssues(db: Db, companyId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ projectId: designIssues.projectId })
    .from(designIssues)
    .where(and(eq(designIssues.companyId, companyId), inArray(designIssues.status, [...OPEN_ISSUE_STATUSES])));
  return rows.map((r) => r.projectId);
}

async function projectsWithInfoRequirements(db: Db, companyId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ projectId: designInfoRequirements.projectId })
    .from(designInfoRequirements)
    .where(
      and(
        eq(designInfoRequirements.companyId, companyId),
        inArray(designInfoRequirements.status, ["planned", "in_progress", "overdue"]),
      ),
    );
  return rows.map((r) => r.projectId);
}

async function projectsWithChangeControl(db: Db, companyId: string): Promise<string[]> {
  const [notices, consultants] = await Promise.all([
    db.selectDistinct({ projectId: designChangeNotices.projectId }).from(designChangeNotices).where(eq(designChangeNotices.companyId, companyId)),
    db
      .selectDistinct({ projectId: designConsultants.projectId })
      .from(designConsultants)
      .where(and(eq(designConsultants.companyId, companyId), inArray(designConsultants.status, ["appointed", "active", "novated"]))),
  ]);
  return [...new Set([...notices, ...consultants].map((r) => r.projectId))];
}

async function projectsWithPackages(db: Db, companyId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ projectId: designPackages.projectId })
    .from(designPackages)
    .where(eq(designPackages.companyId, companyId));
  return rows.map((r) => r.projectId);
}

export async function runDeliverableJob(db: Db, companyId: string, now: Date) {
  let assessed = 0;
  let raised = 0;
  let obligations = 0;
  for (const projectId of await projectsWithDeliverables(db, companyId)) {
    const r = await sweepDeliverables(db, companyId, projectId, null, today(now));
    assessed += r.assessed;
    raised += r.signalsRaised;
    obligations += r.obligationsOpened;
  }
  return { assessed, raised, obligationsOpened: obligations };
}

export async function runReviewJob(db: Db, companyId: string, now: Date) {
  let checked = 0;
  let overdue = 0;
  let raised = 0;
  for (const projectId of await projectsWithOpenReviews(db, companyId)) {
    const r = await sweepReviews(db, companyId, projectId, null, now.toISOString());
    checked += r.checked;
    overdue += r.overdue;
    raised += r.signalsRaised;
  }
  return { checked, overdue, raised };
}

export async function runIssueJob(db: Db, companyId: string, now: Date) {
  let checked = 0;
  let stale = 0;
  let raised = 0;
  for (const projectId of await projectsWithOpenIssues(db, companyId)) {
    const r = await sweepIssues(db, companyId, projectId, null, now.toISOString());
    checked += r.checked;
    stale += r.stale;
    raised += r.signalsRaised;
  }
  return { checked, stale, raised };
}

export async function runInformationJob(db: Db, companyId: string, now: Date) {
  let checked = 0;
  let overdue = 0;
  let opened = 0;
  let raised = 0;
  for (const projectId of await projectsWithInfoRequirements(db, companyId)) {
    const r = await sweepInfoRequirements(db, companyId, projectId, null, today(now));
    checked += r.checked;
    overdue += r.overdue;
    opened += r.obligationsOpened;
    raised += r.signalsRaised;
  }
  return { checked, overdue, obligationsOpened: opened, raised };
}

export async function runChangeControlJob(db: Db, companyId: string, now: Date) {
  let flagged = 0;
  let raised = 0;
  let inadequatePi = 0;
  for (const projectId of await projectsWithChangeControl(db, companyId)) {
    const frequency = await sweepChangeFrequency(db, companyId, projectId, null, today(now));
    const pi = await sweepProfessionalIndemnity(db, companyId, projectId, null, today(now));
    flagged += frequency.flagged;
    raised += frequency.signalsRaised + pi.signalsRaised;
    inadequatePi += pi.inadequate;
  }
  return { flagged, raised, inadequatePi };
}

export async function runReadinessJob(db: Db, companyId: string) {
  let projects = 0;
  let snapshots = 0;
  for (const projectId of await projectsWithPackages(db, companyId)) {
    const r = await computeReadiness(db, companyId, projectId, null, null);
    projects += 1;
    if (r.snapshotWritten) snapshots += 1;
  }
  return { projects, snapshots };
}

export function registerDesignJobs(app: FastifyInstance): void {
  app.scheduler.register({
    name: "design.deliverables",
    description:
      "Re-assess every live consultant deliverable against its planned date and the task it feeds; keep the order-by obligation in step and raise late signals",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => runDeliverableJob(db, companyId, now)),
  });
  app.scheduler.register({
    name: "design.reviews",
    description: "Detect review cycles past their due date, raise one signal each and notify the issuer",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => runReviewJob(db, companyId, now)),
  });
  app.scheduler.register({
    name: "design.information",
    description: "Open obligations for information requirements with a due date and flag the overdue ones",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => runInformationJob(db, companyId, now)),
  });
  app.scheduler.register({
    name: "design.issues",
    description: "Raise a signal for open design issues that have not moved within the threshold their priority allows",
    everyMs: 24 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => runIssueJob(db, companyId, now)),
  });
  app.scheduler.register({
    name: "design.change-control",
    description: "Measure design churn per package and test every consultant's professional indemnity cover for adequacy",
    everyMs: 24 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => runChangeControlJob(db, companyId, now)),
  });
  app.scheduler.register({
    name: "design.readiness",
    description: "Recompute design-to-construction handover readiness per project, writing a snapshot only when the verdict moves",
    everyMs: 24 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db }) => forEachCompany(db, (companyId) => runReadinessJob(db, companyId)),
  });
}
