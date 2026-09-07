/**
 * OWNER / PORTFOLIO WORKSPACE AND COMMERCIAL STRUCTURES — module.
 * Spec Vol I §7 (#776–#789), Vol II Domain G (#423–#434), Domain Z
 * (#1053–#1066). Tool key `portfolio`.
 *
 * Two halves, deliberately kept apart:
 *
 *   THE OWNER SIDE — how money is authorised and how projects are ranked
 *     funding sources → multi-year appropriations → per-project allocations,
 *     with capital/revenue classification, carry-forward, virement control and
 *     an affordability envelope that portfolio demand is measured against;
 *     an MCDA model whose ranking is computed on demand and never stored.
 *     Routes: `/portfolio/*` (company gate; authorising or moving money
 *     additionally needs the owner/admin company role).
 *
 *   THE COMMERCIAL STRUCTURES SIDE — how work is bought and how risk is shared
 *     frameworks → lots → appointed suppliers → mini-competitions → call-off
 *     orders; term contracts with a schedule of rates and measured term
 *     orders; joint ventures with partner shares, capital calls and deed
 *     governance; target-cost pain/gain and the alliance model; open-book
 *     verification of defined cost with the disallowed-cost register and the
 *     audit-rights execution log.
 *     Routes: `/portfolio/*` for the company-level instruments,
 *     `/projects/:projectId/portfolio/*` for everything a project owns.
 *
 * Every commercial number comes out of a pure engine with unit tests:
 *   rollup.ts     portfolio roll-up, appropriation and funding positions,
 *                 affordability, capital/revenue split, stage-gate pipeline
 *   mcda.ts       multi-criteria ranking with per-criterion influence
 *   frameworks.ts framework/lot utilisation, direct-award rules, schedule-of-
 *                 rates pricing, mini-competition evaluation
 *   jv.ts         partner positions and board-vote outcomes
 *   paingain.ts   banded/flat/capped pain-gain with caps and alliance splits
 *   openbook.ts   verification totals, sampling extrapolation, register summary
 *
 * Cross-cutting rules this module never bends:
 *  · Money is never summed across currencies. Anything that would need a rate
 *    comes back `{ value: null, reasons }`.
 *  · A claim and the test of that claim are not authored by the same person:
 *    the verifier of a defined cost item may not be its claimant, the approver
 *    of an appropriation or allocation may not be its author, the awarder of a
 *    mini-competition may not be its issuer, and the settler of a capital call
 *    may not be the person who recorded it.
 *  · Every consequential write appends to the ledger, with the decision's own
 *    numbers stored on the high-value ones.
 *  · Every deadline becomes an Obligation, so the platform's existing sweeps,
 *    attention feed and breach machinery apply to it unchanged.
 *  · Every control runs on the scheduler (sweeps.ts), not on a page read; a
 *    control that only fires when someone opens a page is not a control.
 *
 * What this module deliberately does NOT do: hold the project's budget
 * (financials.budgets), its commitments (financials.commitments), its
 * invoices, or the governance gates it reads for the pipeline
 * (governance.stage_gates). It reads them and never writes them.
 */
import type { FastifyPluginAsync } from "fastify";
import { callOffRoutes } from "./routes/calloffs.js";
import { frameworkRoutes } from "./routes/frameworks.js";
import { fundingRoutes } from "./routes/funding.js";
import { openBookRoutes } from "./routes/openbook.js";
import { overviewRoutes } from "./routes/overview.js";
import { prioritisationRoutes } from "./routes/prioritisation.js";
import { targetCostRoutes } from "./routes/targetcost.js";
import { ventureRoutes } from "./routes/ventures.js";
import { registerPortfolioJobs } from "./sweeps.js";

export const portfolioModule: FastifyPluginAsync = async (app) => {
  await app.register(fundingRoutes);
  await app.register(prioritisationRoutes);
  await app.register(frameworkRoutes);
  await app.register(callOffRoutes);
  await app.register(ventureRoutes);
  await app.register(targetCostRoutes);
  await app.register(openBookRoutes);
  await app.register(overviewRoutes);
  registerPortfolioJobs(app);
};
