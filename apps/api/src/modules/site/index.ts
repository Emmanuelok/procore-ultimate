/**
 * SITE OPERATIONS & REALITY CAPTURE — module (spec Vol II Z #1067–1084,
 * X #995–1003; Vol I §2.15 #471–478). Routed under /projects/:projectId/site/*,
 * tool key `site_ops`.
 *
 * What it covers
 *   access       inductions → passes → gate feed → the live on-site register
 *                → musters reconciled against a human headcount   #1067–1069
 *   permits      permits to work with segregation of duties, confined-space
 *                entry/exit, exclusion zones with point-in-polygon,
 *                lone-worker check-ins with escalation              #1070–1073
 *   weather      daily archive (manual + provider), contract baseline and the
 *                exceptional-weather analysis a claim is built on   #1074–1076
 *   capture      drone flights (permission-gated), laser scans, scan-vs-model
 *                deviation reports, 360° tours                      #1077–1080
 *   survey       control points and setting-out records checked by a second
 *                person                                                 #1081
 *   ground       geotechnical investigations, baseline comparison findings,
 *                buried utilities and the strikes register          #1082–1083
 *   environment  seismic / tidal / flood / dust / noise event log, mirrored
 *                into the platform-wide occurrence log                  #1084
 *   progress     claimed-versus-observed progress as Assertion + Evidence +
 *                Reconciliation, refusing self-verified claims     #995–1003
 *   summary      workspace summary, health inputs, this module's signals
 *
 * What it deliberately does not do: keep a second labour register (workforce),
 * a second incident register (safety), a second photo library (field), a
 * second model store (bim) or a second delay-event register (forensics). It
 * links to them by id and reads what they hold.
 *
 * Sweeps are scheduler jobs (jobs.ts); every one is also a POST endpoint.
 */
import type { FastifyPluginAsync } from "fastify";
import { registerSiteJobs } from "./jobs.js";
import { accessRoutes } from "./routes/access.js";
import { captureRoutes } from "./routes/capture.js";
import { environmentalRoutes } from "./routes/events.js";
import { groundRoutes } from "./routes/ground.js";
import { permitRoutes } from "./routes/permits.js";
import { progressRoutes } from "./routes/progress.js";
import { summaryRoutes } from "./routes/summary.js";
import { surveyRoutes } from "./routes/survey.js";
import { weatherRoutes } from "./routes/weather.js";

export const siteModule: FastifyPluginAsync = async (app) => {
  await app.register(accessRoutes);
  await app.register(permitRoutes);
  await app.register(weatherRoutes);
  await app.register(captureRoutes);
  await app.register(surveyRoutes);
  await app.register(groundRoutes);
  await app.register(environmentalRoutes);
  await app.register(progressRoutes);
  await app.register(summaryRoutes);
  registerSiteJobs(app);
};
