import type { FastifyPluginAsync } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { commitments } from "@constructos/db";
import { assessProjectCommitments } from "./compliance.js";
import {
  buyoutLog,
  committedByCostCode,
  reconcile,
  recomputeCommitmentTotals,
  syncBudgetCommitted,
} from "./rollups.js";
import { isoDateSchema, todayIso } from "./shared.js";

const budgetQuery = z.object({
  budgetId: z.string().min(1).max(64).optional(),
});

const complianceQuery = z.object({
  asOf: isoDateSchema.optional(),
  /**
   * Narrow to the commitments that actually need a human today. Spelled as an
   * explicit "true"/"false" rather than a coerced boolean, because coercion
   * turns the string "false" into true and a compliance filter that inverts
   * itself is worse than no filter.
   */
  onlyActionable: z.enum(["true", "false"]).optional(),
});

/**
 * PROJECT-LEVEL REPORTS over the buy side.
 *
 * Four reads and one repair, all of them derived from stored rows:
 *
 *   /rollups/by-cost-code   committed cost by cost code against budget
 *   /rollups/buyout-log     budget vs committed vs projected savings per line
 *   /compliance             the certificate/bond register for every commitment
 *   /rollups/reconcile      every identity on every commitment, checked
 *   /rollups/sync           re-materialize committed cost onto the budget
 *
 * `sync` exists because materialized rollups are a cache and a cache needs a
 * rebuild path. It recomputes rather than increments, so running it twice
 * changes nothing the second time — which is the property that makes it safe
 * to run when somebody is unsure.
 */
export const reportRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("commitments", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("commitments", "standard"),
  ];

  app.get(
    "/projects/:projectId/commitments/rollups/by-cost-code",
    { preHandler: readGate },
    async (req) => {
      const q = budgetQuery.parse(req.query);
      return committedByCostCode(app.db, req.companyId!, req.projectId!, {
        budgetId: q.budgetId ?? null,
      });
    },
  );

  app.get(
    "/projects/:projectId/commitments/rollups/buyout-log",
    { preHandler: readGate },
    async (req) => {
      const q = budgetQuery.parse(req.query);
      return buyoutLog(app.db, req.companyId!, req.projectId!, { budgetId: q.budgetId ?? null });
    },
  );

  /**
   * The compliance register: every commitment on the project with its
   * insurance, bonding and lien-waiver position, worst first. This is the page
   * that makes an expired certificate somebody's problem before a payment run
   * rather than after one.
   */
  app.get("/projects/:projectId/commitments/compliance", { preHandler: readGate }, async (req) => {
    const q = complianceQuery.parse(req.query);
    const report = await assessProjectCommitments(
      app.db,
      req.companyId!,
      req.projectId!,
      q.asOf ?? todayIso(),
    );
    if (q.onlyActionable !== "true") return report;
    return {
      ...report,
      entries: report.entries.filter(
        (e) => e.compliance.status === "blocked" || e.compliance.status === "warning",
      ),
    };
  });

  /**
   * Every arithmetic identity this module claims, checked against the stored
   * rows for every commitment on the project. A reconciliation report that can
   * only say "fine" is worthless, so this one reports the failing checks with
   * both sides of each and the variance between them.
   */
  app.get(
    "/projects/:projectId/commitments/rollups/reconcile",
    { preHandler: readGate },
    async (req) => {
      const rows = await app.db
        .select({
          id: commitments.id,
          reference: commitments.reference,
          title: commitments.title,
          status: commitments.status,
          currency: commitments.currency,
        })
        .from(commitments)
        .where(
          and(
            eq(commitments.companyId, req.companyId!),
            eq(commitments.projectId, req.projectId!),
          ),
        );
      const results = [];
      for (const row of rows) {
        const r = await reconcile(app.db, row.id);
        results.push({
          commitmentId: row.id,
          reference: row.reference,
          title: row.title,
          status: row.status,
          currency: row.currency,
          reconciles: r.reconciles,
          failing: r.checks.filter((c) => !c.reconciles),
          checks: r.checks,
        });
      }
      const failing = results.filter((r) => !r.reconciles);
      return {
        projectId: req.projectId!,
        checkedAt: new Date().toISOString(),
        commitmentCount: results.length,
        reconciles: failing.length === 0,
        failingCount: failing.length,
        results,
      };
    },
  );

  /**
   * Rebuild the materialized rollups for the whole project: every
   * commitment's totals from its schedule of values and change register, then
   * `committed_cost` and `pending_commitments` on every budget line. Pure
   * recomputation — idempotent, and safe to run at any time.
   */
  app.post(
    "/projects/:projectId/commitments/rollups/sync",
    { preHandler: standardGate },
    async (req) => {
      const rows = await app.db
        .select({ id: commitments.id })
        .from(commitments)
        .where(
          and(
            eq(commitments.companyId, req.companyId!),
            eq(commitments.projectId, req.projectId!),
          ),
        );
      for (const row of rows) await recomputeCommitmentTotals(app.db, row.id);
      const budgetSync = await syncBudgetCommitted(app.db, req.companyId!, req.projectId!);
      return {
        projectId: req.projectId!,
        commitmentsRecomputed: rows.length,
        /*
         * Deliberately no project-wide money total here. Commitments on one
         * project may be written in several currencies, and a single number
         * across them would be meaningless. Per-currency totals live on the
         * list and cost-code endpoints, where the currency travels with them.
         */
        budgetLinesUpdated: budgetSync.budgetLinesUpdated,
        skippedForCurrency: budgetSync.skippedForCurrency,
        asOf: budgetSync.asOf,
      };
    },
  );
};
