/**
 * The quality module's scheduler jobs.
 *
 * Every sweep in this module also runs on a list read, which keeps an open
 * page honest. That is not enough on its own: a hold point nobody looks at is
 * exactly the hold point that gets buried, a concession expires while the
 * person who asked for it is on another project, and a defects liability
 * period ends whether or not anybody opened the closeout tab. So each sweep is
 * registered here as well, and the two paths share one implementation so they
 * cannot drift.
 *
 * Every job is idempotent: signals are keyed on the record id, and status
 * moves are no-ops the second time. Jobs run with `actorId: null` — the system
 * actor — because nobody pressed anything.
 */

import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  commissioningSystems,
  inspectionTestPlans,
  nonConformanceReports,
  turnoverPackages,
} from "@constructos/db";
import { forEachCompany } from "../../lib/scheduler.js";
import type { Db } from "../../lib/db.js";
import { sweepQuality, type SweepOutcome } from "./sweeps.js";
import { sweepConcessions } from "./concessions.js";
import { sweepCalibration } from "./calibration.js";
import { sweepNdtCoverage, sweepWelderQualifications } from "./welding.js";
import { sweepCertificates } from "./certificates.js";
import { sweepAuditFindings } from "./audits.js";
import { sweepDlp, sweepSeasonalTests } from "./closeout.js";
import { todayISO } from "./shared.js";

/**
 * Projects in this company that hold quality records at all. Bounded by
 * design: a sweep must never load every project on the platform, and a
 * project with no ITP, NCR, system or turnover package has nothing to sweep.
 */
async function projectsWithQualityRecords(db: Db, companyId: string): Promise<string[]> {
  const [itps, ncrs, systems, packages] = await Promise.all([
    db
      .selectDistinct({ projectId: inspectionTestPlans.projectId })
      .from(inspectionTestPlans)
      .where(eq(inspectionTestPlans.companyId, companyId)),
    db
      .selectDistinct({ projectId: nonConformanceReports.projectId })
      .from(nonConformanceReports)
      .where(eq(nonConformanceReports.companyId, companyId)),
    db
      .selectDistinct({ projectId: commissioningSystems.projectId })
      .from(commissioningSystems)
      .where(eq(commissioningSystems.companyId, companyId)),
    db
      .selectDistinct({ projectId: turnoverPackages.projectId })
      .from(turnoverPackages)
      .where(eq(turnoverPackages.companyId, companyId)),
  ]);
  return [
    ...new Set(
      [...itps, ...ncrs, ...systems, ...packages]
        .map((r) => r.projectId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
}

/** The four core detectors, over every project in one company. */
export async function sweepQualityCompany(
  db: Db,
  companyId: string,
  asOf: string = todayISO(),
): Promise<{ projects: number; raised: number; byDetector: SweepOutcome["byDetector"] | null }> {
  const projectIds = await projectsWithQualityRecords(db, companyId);
  let raised = 0;
  let byDetector: SweepOutcome["byDetector"] | null = null;
  for (const projectId of projectIds) {
    const outcome = await sweepQuality(db, companyId, projectId, null, asOf);
    raised += outcome.raised;
    if (byDetector === null) byDetector = { ...outcome.byDetector };
    else {
      for (const [key, value] of Object.entries(outcome.byDetector)) {
        byDetector[key as keyof typeof byDetector] += value;
      }
    }
  }
  return { projects: projectIds.length, raised, byDetector };
}

/** Systems whose commissioning is complete but whose turnover has not started. */
async function staleCommissioning(db: Db, companyId: string): Promise<number> {
  const rows = await db
    .select({ id: commissioningSystems.id })
    .from(commissioningSystems)
    .where(
      and(
        eq(commissioningSystems.companyId, companyId),
        eq(commissioningSystems.status, "functional_complete"),
      ),
    );
  return rows.length;
}

export function registerQualityJobs(app: FastifyInstance): void {
  app.scheduler.register({
    name: "quality.sweeps",
    description:
      "Hold points unreleased past their date, NCRs past their response date, turnover packages short of artefacts and systems with open deficiencies — over every project that holds quality records",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        sweepQualityCompany(db, companyId, now.toISOString().slice(0, 10)),
      ),
  });

  app.scheduler.register({
    name: "quality.concessions",
    description:
      "Expire concessions that have run out and warn ahead of the ones about to — work covered by an expired concession is non-conforming again",
    everyMs: 12 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        sweepConcessions(db, companyId, now.toISOString().slice(0, 10)),
      ),
  });

  app.scheduler.register({
    name: "quality.calibration",
    description:
      "Move instruments to due-soon and overdue from their certificates and intervals, and raise a signal for every instrument out of calibration",
    everyMs: 12 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        sweepCalibration(db, companyId, now.toISOString().slice(0, 10)),
      ),
  });

  app.scheduler.register({
    name: "quality.welding",
    description:
      "Lapse welder qualifications on expiry and continuity, and flag welded joints whose required examination has not been carried out",
    everyMs: 12 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, async (companyId) => {
        const quals = await sweepWelderQualifications(db, companyId, now.toISOString().slice(0, 10));
        const ndt = await sweepNdtCoverage(db, companyId);
        return { quals, ndt };
      }),
  });

  app.scheduler.register({
    name: "quality.certificates",
    description:
      "Flag material test certificates that have sat unverified — the moment to reject material is before it is installed",
    everyMs: 24 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        sweepCertificates(db, companyId, now.toISOString().slice(0, 10)),
      ),
  });

  app.scheduler.register({
    name: "quality.audit-findings",
    description: "Raise a signal for every audit finding past its close-out date",
    everyMs: 24 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        sweepAuditFindings(db, companyId, now.toISOString().slice(0, 10)),
      ),
  });

  app.scheduler.register({
    name: "quality.defects-liability",
    description:
      "Advance defects liability periods through active, expiring and expired, and warn before the retention and the final certificate fall due",
    everyMs: 24 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) => sweepDlp(db, companyId, now.toISOString().slice(0, 10))),
  });

  app.scheduler.register({
    name: "quality.seasonal-commissioning",
    description:
      "Raise the deferred seasonal tests when their date comes round, creating the scheduled test record so the promise has a row somebody must close",
    everyMs: 24 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, async (companyId) => {
        const seasonal = await sweepSeasonalTests(db, companyId, now.toISOString().slice(0, 10));
        return { ...seasonal, systemsAwaitingTurnover: await staleCommissioning(db, companyId) };
      }),
  });
}
