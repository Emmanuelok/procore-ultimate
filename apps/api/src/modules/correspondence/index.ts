/**
 * CORRESPONDENCE, TRANSMITTALS, ACTION PLANS & FORMS — module
 * (spec Vol I §2.11 #440–446, §2.12 #447–456, §2.13 #457–464, §0.6 #99).
 * Routed under /projects/:projectId/correspondence/* with the company-level
 * libraries at /correspondence/*. Tool key `correspondence`.
 *
 * What it covers
 *   types        configurable correspondence types: prefix and numbering,
 *                response period, contractual flag, approval workflow  #440, #445
 *   letters      the numbered register, threaded, with recipients,
 *                acknowledgement, read receipts, response tracking and
 *                an obligation for every response deadline             #441, #443–#446
 *   inbound      parsed-email capture that routes a reply onto the
 *                thread it answers, is idempotent per message id, and
 *                says out loud when it could not route                 #99
 *   transmittals the formal issue of documents with a purpose, item
 *                revisions frozen at issue, and per-recipient
 *                acknowledgement tracking                              #442–#443
 *   plans        action plan templates → instances anchored to a
 *                location or a schedule task, with required
 *                activities, evidence requirements, multi-party
 *                sign-off, quality-checkpoint gating and a completion
 *                report                                                #447–#456
 *   forms        templates with fields, show/hide logic and an
 *                acroform mapping for an uploaded fillable PDF;
 *                assignment; completion with signature capture; the
 *                register and its CSV export                           #457–#464
 *   analytics    summary, register export, open signals, health inputs
 *                for the intelligence layer, manual sweep trigger
 *
 * What it deliberately does not do: hold files (documents.files), drawing
 * sheets, submittals or specification sections — a transmittal line points at
 * the register that owns the item and copies its revision at the moment of
 * issue. It does not own RFIs (field.rfis have their own inbound path), the
 * generic workflow engine (workflow.*), or notifications (notifications.*).
 *
 * Every sweep is a scheduler job (jobs.ts) and also a POST endpoint, so an
 * operator or a test can force a cycle without waiting for the interval.
 */
import type { FastifyPluginAsync } from "fastify";
import { registerCorrespondenceJobs } from "./jobs.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { formRoutes } from "./routes/forms.js";
import { letterRoutes } from "./routes/letters.js";
import { planRoutes } from "./routes/plans.js";
import { transmittalRoutes } from "./routes/transmittals.js";
import { typeRoutes } from "./routes/types.js";
import { registerCorrespondenceSearch } from "./search.js";

export const correspondenceModule: FastifyPluginAsync = async (app) => {
  await app.register(typeRoutes);
  await app.register(letterRoutes);
  await app.register(transmittalRoutes);
  await app.register(planRoutes);
  await app.register(formRoutes);
  await app.register(analyticsRoutes);
  registerCorrespondenceSearch();
  registerCorrespondenceJobs(app);
};
