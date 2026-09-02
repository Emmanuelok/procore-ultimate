/**
 * Field tools — RFIs (§2.4), submittals (§2.5), daily logs (§2.7), punch
 * list (§2.8), photos (§2.10) and observations (§4.2) mounted as one
 * module, plus the pieces that make them one system: per-project field
 * settings, the overdue escalation ladder (a scheduler job), the
 * ledger-driven integrity detectors and the health inputs the intelligence
 * layer reads.
 */
import type { FastifyPluginAsync } from "fastify";
import { rfiRoutes } from "./rfis.js";
import { submittalRoutes } from "./submittals.js";
import { dailyLogRoutes } from "./dailyLogs.js";
import { punchRoutes } from "./punch.js";
import { photoRoutes } from "./photos.js";
import { observationRoutes } from "./observations.js";
import { fieldSettingsRoutes } from "./settings.js";
import { escalationRoutes, registerFieldEscalationJob } from "./escalations.js";
import { registerFieldIntegrity } from "./integrity.js";
import { fieldHealthRoutes } from "./health.js";

export const fieldModule: FastifyPluginAsync = async (app) => {
  await app.register(rfiRoutes);
  await app.register(submittalRoutes);
  await app.register(dailyLogRoutes);
  await app.register(punchRoutes);
  await app.register(photoRoutes);
  await app.register(observationRoutes);
  await app.register(fieldSettingsRoutes);
  await app.register(escalationRoutes);
  await app.register(fieldHealthRoutes);
  registerFieldEscalationJob(app);
  registerFieldIntegrity(app);
};
