/**
 * DESIGN MANAGEMENT & UPSTREAM CHANGE CONTROL — module
 * (spec Vol I §1.5 #249–255; Vol II Domain T #886–912). Routed under
 * /projects/:projectId/design/*, tool key `design`.
 *
 * What it covers
 *   stages       RIBA/AIA/ISO 19650 stage library and the project's gates,
 *                with criteria that must be met before sign-off      #888–#889
 *   packages     the unit that is issued, reviewed, approved, frozen  #253, #886
 *   reviews      cycles with reviewers, status codes A–D consolidated
 *                by the engine, comments with segregated response and
 *                closure, resubmission chains and cycle time         #249, #897–#900
 *   issues       discipline-routed register with assignment, stale
 *                detection and escalation from review comments       #250, #901–#903
 *   decisions    the decision log: options, choice, rationale,
 *                supersession — proposed and decided by different
 *                people                                              #251–#252, #904–#905
 *   consultants  the appointed design team with professional
 *                indemnity adequacy as a live check                  #910, #912
 *   deliverables the TIDP/MIDP schedule assessed against the
 *                programme, with obligations and late signals        #254, #887, #909
 *   change       design change notices with per-discipline impact
 *                assessment, computed authorisation, freeze position
 *                stamped at submission, entitlement attribution, and
 *                the change event they do (or deliberately do not)
 *                raise                                               #255, #890–#896
 *   information  EIR/BEP/TIDP/MIDP milestones with obligations and
 *                verification by a second actor                      ISO 19650
 *   readiness    design-to-construction handover readiness scoring
 *                with an honest confidence and named blockers        #907–#908
 *   analytics    review cycle time, deliverable slippage, change
 *                frequency, health inputs for the intelligence layer
 *
 * What it deliberately does not do: hold drawings or their revisions
 * (drawings.*), models (bim.*), specification sections (specifications.*),
 * the money of a change (financials.change_events) or the programme
 * (schedule.*). It links to all of them by id through `record_links` and
 * reads what they hold.
 *
 * Sweeps are scheduler jobs (jobs.ts); every one is also a POST endpoint so
 * an operator or a test can run a cycle on demand.
 */
import type { FastifyPluginAsync } from "fastify";
import { registerDesignJobs } from "./jobs.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { changeRoutes } from "./routes/changes.js";
import { deliverableRoutes } from "./routes/deliverables.js";
import { issueRoutes } from "./routes/issues.js";
import { packageRoutes } from "./routes/packages.js";
import { reviewRoutes } from "./routes/reviews.js";

export const designModule: FastifyPluginAsync = async (app) => {
  await app.register(packageRoutes);
  await app.register(reviewRoutes);
  await app.register(issueRoutes);
  await app.register(deliverableRoutes);
  await app.register(changeRoutes);
  await app.register(analyticsRoutes);
  registerDesignJobs(app);
};
