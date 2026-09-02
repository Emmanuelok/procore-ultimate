import type { FastifyPluginAsync } from "fastify";
import { itpRoutes } from "./itps.js";
import { checklistRoutes } from "./checklists.js";
import { ncrRoutes } from "./ncrs.js";
import { commissioningRoutes } from "./commissioning.js";
import { turnoverRoutes } from "./turnover.js";
import { summaryRoutes } from "./summary.js";
import { surveillanceRoutes } from "./surveillance.js";
import { concessionRoutes } from "./concessions.js";
import { concreteRoutes } from "./concrete.js";
import { weldingRoutes } from "./welding.js";
import { certificateRoutes } from "./certificates.js";
import { calibrationRoutes } from "./calibration.js";
import { reworkRoutes } from "./rework.js";
import { auditRoutes } from "./audits.js";
import { closeoutRoutes } from "./closeout.js";
import { registerQualityJobs } from "./jobs.js";

/**
 * QUALITY (M22) — tool key `quality`.
 *
 * One chain, end to end, and it deliberately ends OUTSIDE this module:
 *
 *   ITP            what will be verified, agreed before the work starts
 *    └ activity    each verification, with its INTERVENTION POINT
 *        └ checklist   the record made when the point is reached
 *            └ response    one typed answer
 *                └ NCR         raised when a response fails
 *
 *   commissioning system
 *    └ test record (pre-functional → functional, one table)
 *        └ turnover package
 *            └ THE TWIN     assets, IFC bindings, warranties, COBie
 *
 * Four controls carry the whole module, and each one is a refusal:
 *
 *  1. HOLD POINTS. Work may not proceed past an unreleased hold point, and a
 *     hold point may not be released by the party who raised it where the
 *     nominated verifier is somebody else (./holdPoints.ts).
 *  2. DISPOSITION. An NCR's disposition is proposed by one person and
 *     approved by another; a `use_as_is` approved by its proposer is refused
 *     (./ncrs.ts).
 *  3. VERIFICATION. Closeout evidence is submitted by one person and verified
 *     by another, in both the NCR register and commissioning.
 *  4. TURNOVER. The artefact gap and the open punch items and NCRs against a
 *     package's systems are named, and block or warn per a configurable
 *     strictness (./turnover.ts).
 *
 * The upgrade wave added the registers that make the chain defensible rather
 * than merely complete — each one hanging off the four above rather than
 * restating them:
 *
 *   sign-off chain      per-party release of a hold point, in sequence, with
 *                       third-party surveillance attendance (./surveillance.ts)
 *   concessions         every departure somebody agreed to, with its expiry
 *   concrete            pours, cube/cylinder statistics and code acceptance
 *   welding             procedures, welder qualifications, the weld map, NDT
 *   certificates        material test certificates verified against the spec
 *   calibration         the instruments every acceptance reading depends on
 *   rework              what it cost to do it twice, and why
 *   audits              findings with requirement, evidence and verification,
 *                       plus the ISO 9001 evidence pack
 *   closeout            defects liability periods (as Obligations), performance
 *                       guarantees with LD exposure, operator training, spares
 *                       and post-occupancy evaluation
 *
 * What this module does NOT keep, on purpose:
 *  - a second corrective-action register (safety_corrective_actions, sourceType "ncr")
 *  - a second snag list (field/punch.ts)
 *  - a second asset register (twin.ts — turnover writes INTO it)
 *  - a second change register (financials change_events carry backcharges)
 *
 * Schema: packages/db/src/schema/quality.ts.
 * Sweeps run BOTH on list reads and on the platform scheduler (./jobs.ts);
 * they are idempotent, so the two paths cannot double-raise.
 */
export const qualityModule: FastifyPluginAsync = async (app) => {
  await app.register(itpRoutes);
  await app.register(checklistRoutes);
  await app.register(ncrRoutes);
  await app.register(commissioningRoutes);
  await app.register(turnoverRoutes);
  await app.register(summaryRoutes);
  await app.register(surveillanceRoutes);
  await app.register(concessionRoutes);
  await app.register(concreteRoutes);
  await app.register(weldingRoutes);
  await app.register(certificateRoutes);
  await app.register(calibrationRoutes);
  await app.register(reworkRoutes);
  await app.register(auditRoutes);
  await app.register(closeoutRoutes);
  registerQualityJobs(app);
};
