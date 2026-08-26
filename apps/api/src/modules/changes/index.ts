import type { FastifyPluginAsync } from "fastify";
import { changeEventRoutes } from "./events.js";
import { pcoRoutes } from "./pcos.js";
import { quoteRoutes } from "./quotes.js";
import { corRoutes } from "./requests.js";
import { packageRoutes } from "./packages.js";
import { changeLogRoutes } from "./log.js";

/**
 * CHANGE MANAGEMENT (M5, spec Vol I §3.4) — the chain from a field event to
 * money moving, on both sides of the ledger.
 *
 *   change_event            something happened, and nobody knows what it costs
 *     -> potential_change_order   our cost position, priced by cost type
 *          -> change_quote_request   RFQ out to the sub; compare, then select
 *     -> change_order_request     the ask to the owner, cost + markup stack
 *          -> change_order_package  executed: revenue up, cost up, budget up
 *
 * The point of modelling it as a chain rather than a list of change orders is
 * that most of the money on a construction project leaks in the gaps: exposure
 * identified and never priced, priced and never submitted, submitted and
 * quietly discounted, executed on the owner side but never passed down to the
 * subcontract. Every one of those gaps is a status transition here, countable
 * on the change log, and none of them can be skipped.
 *
 * Route surface, all under `/api/v1`, tool key `change_management`:
 *
 *   /projects/:projectId/change-events                     the origin record
 *   /projects/:projectId/potential-change-orders           the cost position
 *   /projects/:projectId/quote-requests                    RFQ + comparison
 *   /projects/:projectId/change-order-requests             the owner ask
 *   /projects/:projectId/change-order-packages             execution
 *   /projects/:projectId/change-log                        reconciliation
 *
 * `read` sees the log, `standard` moves a change along the chain, and `admin`
 * is required for exactly one route — executing a package — because it is the
 * only operation here that a correction cannot undo.
 */
export const changesModule: FastifyPluginAsync = async (app) => {
  await app.register(changeEventRoutes);
  await app.register(pcoRoutes);
  await app.register(quoteRoutes);
  await app.register(corRoutes);
  await app.register(packageRoutes);
  await app.register(changeLogRoutes);
};
