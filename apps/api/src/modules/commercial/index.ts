import type { FastifyPluginAsync } from "fastify";
import { analysisRoutes } from "./analysis.js";
import { boqRoutes } from "./boqs.js";
import { dayworkRoutes } from "./dayworks.js";
import { registerCommercialJobs } from "./jobs.js";
import { measureRoutes } from "./measure.js";
import { reportingRoutes } from "./reporting.js";
import { registerCommercialSearch } from "./search.js";
import { summaryRoutes } from "./summary.js";
import { valuationRoutes } from "./valuations.js";
import { variationRoutes } from "./variations.js";

/**
 * Commercial — measurement & valuation engine (M7, spec Vol II Domain B).
 *
 * What it covers: bills of quantities with taking-off provenance and
 * method-of-measurement validation (NRM2/CESMM4/SMM7/POMI, #117-134);
 * remeasurement with two-party agreement (#141-144); rate build-ups and
 * benchmarking, including the star-rate register (#145-149, #171); dayworks
 * with percentage additions (#150-161, #132); interim valuations with typed
 * sections, retention (cap and release) and payment certificates that can be
 * withdrawn and paid (#162-167, #179-180, #254); provisional sums and their
 * expenditure (#125-127); fluctuations by indexed formula (#178); CVR/WIP with
 * over- and under-certification and a cash-flow S-curve (#184-189); and the
 * final account with a traceable adjustment schedule and two-sided sign-off
 * (#181-183, #187). CSV import/export (#191) makes the bill machine-readable.
 *
 * What it deliberately does not do: it does not own commitments, invoices or
 * payments (WP-FIN2), nor the schedule (WP-SCHED); it READS them for the CVR
 * and the S-curve and names the gap when a feed is absent.
 */
export const commercialModule: FastifyPluginAsync = async (app) => {
  await app.register(boqRoutes);
  await app.register(measureRoutes);
  await app.register(dayworkRoutes);
  await app.register(valuationRoutes);
  await app.register(variationRoutes);
  await app.register(analysisRoutes);
  await app.register(reportingRoutes);
  await app.register(summaryRoutes);
  registerCommercialSearch();
  registerCommercialJobs(app);
};
