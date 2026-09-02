/**
 * SUPPLY CHAIN, LOGISTICS & OFFSITE MANUFACTURE — module (spec Vol II Domain
 * U #913–947; Vol I §5.4 #719–730). Routed under
 * /projects/:projectId/supply-chain/*, tool key `supply_chain`.
 *
 * What it covers
 *   map          multi-tier nodes and links, sole-source flags        #913–916
 *   long-lead    order-by-date engine tied to the programme, milestones,
 *                expediting log, order-by obligations, late signals   #918–921, #719–720, #727–728
 *   offsite      units, stages, independent QA gates, factory
 *                inspections, verified-for-payment, vesting/storage   #922–928
 *   logistics    gates, slot booking with clash refusal, arrival →
 *                completion, damage/shortage register, availability,
 *                on-time %, transport carbon → ESG A4                 #930–939, #945, #721–722, #730
 *   trace        heat/batch → certificate (verified by a second
 *                person) → installed location, CE/UKCA, from-delivery #945–947, #721, #724–725
 *   risk         supplier risk engine and snapshots                   #915–917, #946
 *   jit          delivery-vs-task conflicts → signals                 #919, #930
 *   analytics    summary, health-inputs, open supply signals
 *
 * What it deliberately does not do: keep a second materials catalogue or
 * stock ledger (equipment.material_*), screen entities (assurance), hold
 * carbon factors (esg), or compute the programme (schedule). It links to all
 * of them by id and reads what they hold.
 *
 * Sweeps are scheduler jobs (jobs.ts); every one is also a POST endpoint.
 */
import type { FastifyPluginAsync } from "fastify";
import { registerSupplyChainJobs } from "./jobs.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { logisticsRoutes } from "./routes/logistics.js";
import { longLeadRoutes } from "./routes/longLead.js";
import { mapRoutes } from "./routes/map.js";
import { offsiteRoutes } from "./routes/offsite.js";
import { riskRoutes } from "./routes/risk.js";
import { traceabilityRoutes } from "./routes/traceability.js";

export const supplychainModule: FastifyPluginAsync = async (app) => {
  await app.register(mapRoutes);
  await app.register(longLeadRoutes);
  await app.register(offsiteRoutes);
  await app.register(logisticsRoutes);
  await app.register(traceabilityRoutes);
  await app.register(riskRoutes);
  await app.register(analyticsRoutes);
  registerSupplyChainJobs(app);
};
