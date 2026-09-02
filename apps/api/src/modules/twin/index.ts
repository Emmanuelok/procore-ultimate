/**
 * DIGITAL TWIN — asset register, telemetry, warranties and handover
 * (spec Vol II Domain L #627-661).
 *
 *   assets      register, hierarchy, geometry binding by IFC GlobalId, bulk
 *               instantiation from a model, element map for the viewer  #627-629, #658
 *   sensors     channels, machine-callable idempotent ingest, aggregated
 *               readings, alert register with cool-down and acknowledgement #659-661
 *   warranties  register with strict dates, expiry obligations and
 *               notifications, claims lifecycle                          #642-645
 *   milestones  ISO 19650 information delivery milestones, required
 *               containers and their automatic evaluation                #632-636
 *   handover    COBie workbook + validator + completeness, O&M readiness,
 *               performance against design intent, health inputs         #630-631, #660-661
 *
 * What it deliberately does not do: own the model (modules/bim does — this
 * module binds to GlobalIds), own locations (core), own maintenance work
 * orders (there is no CMMS here; the COBie Job sheet says so rather than
 * inventing rows), or accept synthetic telemetry in production.
 *
 * Sweeps are scheduler jobs (alerts.ts): `twin.warranty-expiry` and
 * `twin.sensor-stale`, both idempotent and both exposed as endpoints too.
 */
import type { FastifyPluginAsync } from "fastify";
import { registerTwinJobs } from "./alerts.js";
import { assetRoutes } from "./routes/assets.js";
import { handoverRoutes } from "./routes/handover.js";
import { milestoneRoutes } from "./routes/milestones.js";
import { sensorRoutes } from "./routes/sensors.js";
import { warrantyRoutes } from "./routes/warranties.js";

export const twinModule: FastifyPluginAsync = async (app) => {
  await app.register(assetRoutes);
  await app.register(sensorRoutes);
  await app.register(warrantyRoutes);
  await app.register(milestoneRoutes);
  await app.register(handoverRoutes);
  registerTwinJobs(app);
};
