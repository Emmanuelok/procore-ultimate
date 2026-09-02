/**
 * BIM, coordination and maps module (spec Vol I §1.4-1.5, §2.14-2.15;
 * Vol II Domain L).
 *
 *   models       registry, streamed upload, asynchronous IFC ingestion with
 *                property sets / spatial containment / extents, ISO 19650 CDE
 *                states, publication authorisation, quality gate, version
 *                comparison, viewer stream            #231-236, #247-248, #638-640
 *   federations  named sets of versions viewed and clash-tested together  #232
 *   clash        AABB clash engine, persistent result register, group ->
 *                coordination issue with a viewpoint                     #240
 *   issues       assignment, comments, SLA, RFI escalation, BCF-style
 *                export, register CSV                                    #241-245, #466-470
 *   links        4D element -> schedule task and 5D element -> budget line #238-239
 *   capture      reality capture overlays and scan-vs-model deviation     #246
 *   maps         geofences with in-process containment, project map data  #471-478
 *   analytics    workspace summary and health inputs (contract 3.5)
 *
 * What it deliberately does not do: render or tessellate geometry (the
 * browser viewer does that from the streamed container), own locations (it
 * creates and reuses them in the core register), own RFIs (it creates one and
 * links it), or own assets (modules/twin does, and binds to GlobalIds here).
 *
 * Sweeps are scheduler jobs (ingest.ts): `bim.ingest` drains the extraction
 * queue and requeues anything a crashed worker abandoned; `bim.issues-overdue`
 * notifies and signals overdue coordination issues once each.
 */
import type { FastifyPluginAsync } from "fastify";
import { registerBimJobs } from "./ingest.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { captureRoutes } from "./routes/capture.js";
import { clashRoutes } from "./routes/clash.js";
import { federationRoutes } from "./routes/federations.js";
import { issueRoutes } from "./routes/issues.js";
import { linkRoutes } from "./routes/links.js";
import { mapRoutes } from "./routes/maps.js";
import { modelRoutes } from "./routes/models.js";

export const bimModule: FastifyPluginAsync = async (app) => {
  await app.register(modelRoutes);
  await app.register(federationRoutes);
  await app.register(clashRoutes);
  await app.register(issueRoutes);
  await app.register(linkRoutes);
  await app.register(captureRoutes);
  await app.register(mapRoutes);
  await app.register(analyticsRoutes);
  registerBimJobs(app);
};
