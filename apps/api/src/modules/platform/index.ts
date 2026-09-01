/**
 * Platform operations surface: the job scheduler's status and manual runs.
 *
 * Company owners and admins can see every registered job — what it does,
 * when it last ran, how long it took, whether it failed — and trigger one on
 * demand. The jobs themselves are registered by the modules that own the
 * behaviour (contracts.time-bars, payments.deemed-liability, insurance.expiry,
 * anchoring.heartbeat, …); this module only exposes the ticker.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { notFound } from "../../lib/errors.js";

const jobParams = z.object({ name: z.string().min(1).max(120) });

export const platformModule: FastifyPluginAsync = async (app) => {
  const adminGate = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin"]),
  ];

  app.get("/platform/scheduler", { preHandler: adminGate }, async () => ({
    enabled: app.scheduler.enabled,
    tickMs: app.scheduler.options.tickMs,
    replicaSafe: app.scheduler.options.postgres,
    jobs: app.scheduler.list(),
  }));

  app.post(
    "/platform/scheduler/jobs/:name/run",
    { preHandler: adminGate },
    async (req) => {
      const { name } = jobParams.parse(req.params);
      if (!app.scheduler.has(name)) throw notFound(`Unknown scheduler job "${name}"`);
      const status = await app.scheduler.runNow(name, "manual");
      return { job: status };
    },
  );
};
