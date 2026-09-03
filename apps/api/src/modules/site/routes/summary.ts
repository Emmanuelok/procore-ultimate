/**
 * SITE OPERATIONS — summary, health inputs, open signals and the manual sweep.
 *
 * The summary is what the workspace header and the intelligence layer read.
 * It never fabricates: a project with no gate feed has an UNKNOWN headcount
 * (`null` with a reason), not a headcount of zero.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { signals } from "@constructos/db";
import { SITE_DETECTORS } from "@constructos/shared";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import {
  siteHealthInputs,
  siteSummary,
  sweepAccessCredentials,
  sweepExclusionZones,
  sweepLoneWorkers,
  sweepOverstays,
  sweepPermitEntries,
  sweepPermitExpiry,
} from "../service.js";
import { buildGates, isoTimestampSchema, nowISO } from "../shared.js";

export const summaryRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, adminGate } = buildGates(app);
  const base = "/projects/:projectId/site";

  app.get(`${base}/summary`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = z.object({ asOf: isoTimestampSchema.optional() }).parse(req.query);
    return siteSummary(app.db, req.companyId!, projectId, q.asOf ?? nowISO());
  });

  app.get(`${base}/health-inputs`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    return siteHealthInputs(app.db, req.companyId!, projectId, nowISO());
  });

  app.get(`${base}/signals`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({ disposition: z.string().max(30).optional(), detector: z.string().max(60).optional() })
      .parse(req.query);
    const where = and(
      eq(signals.companyId, req.companyId!),
      eq(signals.projectId, projectId),
      // Always constrained to this module's detectors: `site_ops` read access
      // is not read access to every detector that ever fired on the project.
      inArray(signals.detector, [...SITE_DETECTORS]),
      q.detector ? eq(signals.detector, q.detector) : undefined,
      q.disposition ? eq(signals.disposition, q.disposition) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(signals).where(where).orderBy(desc(signals.createdAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(signals).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  /**
   * Run every site sweep for this company now. The scheduler runs the same
   * services on its own cadence; this is the operator's button and what the
   * tests drive.
   */
  app.post(`${base}/sweeps/run`, { preHandler: adminGate }, async (req) => {
    const companyId = req.companyId!;
    const now = new Date();
    const [permits, entries, loneWorkers, credentials, zones, overstays] = await Promise.all([
      sweepPermitExpiry(app.db, companyId, now),
      sweepPermitEntries(app.db, companyId, now),
      sweepLoneWorkers(app.db, companyId, now),
      sweepAccessCredentials(app.db, companyId, now),
      sweepExclusionZones(app.db, companyId, now),
      sweepOverstays(app.db, companyId, now),
    ]);
    return { ranAt: now.toISOString(), permits, entries, loneWorkers, credentials, zones, overstays };
  });
};
