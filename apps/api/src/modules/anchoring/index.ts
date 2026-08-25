import type { FastifyPluginAsync } from "fastify";

/**
 * M1 — Ledger anchoring & escrow (Domain S).
 * Signed chain seals, external anchor providers, escrow receipts a third
 * party can verify, and truncation-aware chain verdicts.
 */
export const anchoringModule: FastifyPluginAsync = async (app) => {
  void app;
};
