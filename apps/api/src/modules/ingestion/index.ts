import type { FastifyPluginAsync } from "fastify";

/**
 * M6 — Data ingestion & migration.
 * Staged CSV migration wizard, connector scaffolding (Procore/Aconex),
 * API tokens for machine evidence streams, OCDS export.
 * Routes are built out in apps/api/src/modules/ingestion/.
 */
export const ingestionModule: FastifyPluginAsync = async (app) => {
  void app;
};
