import type { FastifyPluginAsync } from "fastify";
import { boqRoutes } from "./boqs.js";
import { valuationRoutes } from "./valuations.js";
import { variationRoutes } from "./variations.js";
import { summaryRoutes } from "./summary.js";

/**
 * Commercial — measurement & valuation engine (M7, spec Vol II Domain B):
 * Bills of Quantities with taking-off provenance, interim valuations,
 * payment certificates and the variation register, rolled up into the
 * project commercial summary (CVR seed).
 */
export const commercialModule: FastifyPluginAsync = async (app) => {
  await app.register(boqRoutes);
  await app.register(valuationRoutes);
  await app.register(variationRoutes);
  await app.register(summaryRoutes);
};
