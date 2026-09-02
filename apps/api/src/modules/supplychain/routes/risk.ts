/**
 * SUPPLIER RISK routes (spec #915–917, #946): run the engine, read the latest
 * verdict per node with its flags and basis, read the history, and see where
 * the critical supply is concentrated. The engine never runs on a page read;
 * the scheduler and the run button both call the same service.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { supplierRiskAssessments, supplyChainNodes } from "@constructos/db";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { countryConcentration } from "../engines/supplierRisk.js";
import { latestAssessments, runSupplierRisk } from "../service.js";
import { buildGates, idSchema, todayISO } from "../shared.js";

export const riskRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);
  const base = "/projects/:projectId/supply-chain/risk";

  app.get(base, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const companyId = req.companyId!;
    const [nodes, latest] = await Promise.all([
      app.db
        .select()
        .from(supplyChainNodes)
        .where(and(eq(supplyChainNodes.companyId, companyId), eq(supplyChainNodes.projectId, projectId)))
        .orderBy(asc(supplyChainNodes.tier), asc(supplyChainNodes.name)),
      latestAssessments(app.db, companyId, projectId),
    ]);
    const concentration = countryConcentration(
      nodes.map((n) => ({ id: n.id, name: n.name, tier: n.tier, country: n.country, criticality: n.criticality, categories: n.categories, vendorId: n.vendorId, entityId: n.entityId, status: n.status })),
      0.5,
    );
    const summary: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0, not_assessable: 0, not_assessed: 0 };
    const items = nodes.map((n) => {
      const a = latest.get(n.id);
      const level = a?.level ?? n.riskLevel ?? "not_assessed";
      summary[level] = (summary[level] ?? 0) + 1;
      return {
        nodeId: n.id,
        name: n.name,
        tier: n.tier,
        country: n.country,
        criticality: n.criticality,
        vendorId: n.vendorId,
        entityId: n.entityId,
        status: n.status,
        level,
        score: a?.score ?? n.riskScore ?? null,
        assessedAt: a?.assessedAt ?? n.riskAssessedAt ?? null,
        flags: a?.flags ?? [],
        basis: a?.basis ?? null,
        inputs: a?.inputs ?? null,
        signalIds: a?.signalIds ?? [],
      };
    });
    const lastRunAt = items.reduce<string | null>((m, i) => (i.assessedAt && (!m || i.assessedAt > m) ? i.assessedAt : m), null);
    return {
      items,
      summary,
      concentration,
      lastRunAt,
      reasons: nodes.length === 0 ? ["No supply chain nodes on the map; add the tier-1 suppliers and their upstream sources first."] : lastRunAt === null ? ["The supplier risk engine has not run for this project yet."] : [],
    };
  });

  app.post(`${base}/run`, { preHandler: standardGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const run = await runSupplierRisk(app.db, req.companyId!, projectId, req.user!.id, todayISO());
    return {
      assessedAt: run.assessedAt,
      nodes: run.nodes.length,
      signalsRaised: run.raised,
      snapshotsWritten: run.snapshotsWritten,
      unchanged: run.unchanged,
      summary: run.result.summary,
      concentration: run.result.concentration,
      assessments: run.result.assessments,
    };
  });

  app.get(`${base}/assessments`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema.extend({ nodeId: idSchema.optional(), level: z.string().max(20).optional() }).parse(req.query);
    const where = and(
      eq(supplierRiskAssessments.companyId, req.companyId!),
      eq(supplierRiskAssessments.projectId, projectId),
      q.nodeId ? eq(supplierRiskAssessments.nodeId, q.nodeId) : undefined,
      q.level ? eq(supplierRiskAssessments.level, q.level) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(supplierRiskAssessments).where(where).orderBy(desc(supplierRiskAssessments.assessedAt), desc(supplierRiskAssessments.createdAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(supplierRiskAssessments).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });
};
