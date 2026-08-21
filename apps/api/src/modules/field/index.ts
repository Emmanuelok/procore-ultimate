import type { FastifyPluginAsync } from "fastify";
import { rfiRoutes } from "./rfis.js";
import { submittalRoutes } from "./submittals.js";
import { dailyLogRoutes } from "./dailyLogs.js";
import { punchRoutes } from "./punch.js";
import { photoRoutes } from "./photos.js";

/**
 * Field tools — RFIs (§2.4), submittals (§2.5), daily logs (§2.7),
 * punch list (§2.8) and photos (§2.10) mounted as one module.
 */
export const fieldModule: FastifyPluginAsync = async (app) => {
  await app.register(rfiRoutes);
  await app.register(submittalRoutes);
  await app.register(dailyLogRoutes);
  await app.register(punchRoutes);
  await app.register(photoRoutes);
};
