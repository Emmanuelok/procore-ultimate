/**
 * Supply chain MAP routes (spec #913–916): nodes and links, tiered.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import { longLeadItems, supplierRiskAssessments, supplyChainLinks, supplyChainNodes } from "@constructos/db";
import { SUPPLY_CRITICALITIES, SUPPLY_LINK_KINDS, SUPPLY_NODE_KINDS, SUPPLY_NODE_STATUSES } from "@constructos/shared";
import { badRequest, conflict, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import {
  assertVendor,
  buildGates,
  countryCodeSchema,
  idSchema,
  ledger,
  nowISO,
  patchSchemaOf,
  patchSet,
} from "../shared.js";

const nodeBodySchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(SUPPLY_NODE_KINDS).default("vendor"),
  tier: z.coerce.number().int().min(1).max(6).default(1),
  country: countryCodeSchema.nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  criticality: z.enum(SUPPLY_CRITICALITIES).default("medium"),
  categories: z.array(z.string().min(1).max(80)).max(50).default([]),
  vendorId: idSchema.nullable().optional(),
  entityId: idSchema.nullable().optional(),
  commitmentId: idSchema.nullable().optional(),
  annualValue: z.number().min(0).nullable().optional(),
  currency: z.string().length(3).toUpperCase().optional(),
  leadTimeDays: z.number().int().min(0).max(2000).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

const nodePatchSchema = patchSchemaOf(nodeBodySchema).extend({
  status: z.enum(SUPPLY_NODE_STATUSES).optional(),
});

const nodeListSchema = pageQuerySchema.extend({
  tier: z.coerce.number().int().min(1).max(6).optional(),
  criticality: z.enum(SUPPLY_CRITICALITIES).optional(),
  country: z.string().max(3).optional(),
  status: z.enum(SUPPLY_NODE_STATUSES).optional(),
  q: z.string().max(120).optional(),
});

const linkBodySchema = z.object({
  fromNodeId: idSchema,
  toNodeId: idSchema,
  kind: z.enum(SUPPLY_LINK_KINDS).default("supplies"),
  category: z.string().max(80).nullable().optional(),
  description: z.string().max(1000).nullable().optional(),
  isSoleSource: z.boolean().default(false),
  leadTimeDays: z.number().int().min(0).max(2000).nullable().optional(),
  value: z.number().min(0).nullable().optional(),
  currency: z.string().length(3).toUpperCase().nullable().optional(),
});

export const mapRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate, adminGate } = buildGates(app);

  /* ---------------------------------------------------------------- */
  /* The map                                                           */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/supply-chain/map", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const companyId = req.companyId!;
    const [nodes, links] = await Promise.all([
      app.db
        .select()
        .from(supplyChainNodes)
        .where(and(eq(supplyChainNodes.companyId, companyId), eq(supplyChainNodes.projectId, projectId)))
        .orderBy(asc(supplyChainNodes.tier), asc(supplyChainNodes.name)),
      app.db
        .select()
        .from(supplyChainLinks)
        .where(and(eq(supplyChainLinks.companyId, companyId), eq(supplyChainLinks.projectId, projectId))),
    ]);
    const byTier: Record<string, number> = {};
    const byCountry: Record<string, number> = {};
    const byCriticality: Record<string, number> = {};
    const byRiskLevel: Record<string, number> = {};
    for (const n of nodes) {
      byTier[String(n.tier)] = (byTier[String(n.tier)] ?? 0) + 1;
      const c = n.country ?? "unknown";
      byCountry[c] = (byCountry[c] ?? 0) + 1;
      byCriticality[n.criticality] = (byCriticality[n.criticality] ?? 0) + 1;
      const r = n.riskLevel ?? "not_assessed";
      byRiskLevel[r] = (byRiskLevel[r] ?? 0) + 1;
    }
    const inbound = new Map<string, number>();
    for (const l of links) inbound.set(l.toNodeId, (inbound.get(l.toNodeId) ?? 0) + 1);
    return {
      nodes,
      links,
      stats: {
        nodes: nodes.length,
        links: links.length,
        maxTier: nodes.reduce((m, n) => Math.max(m, n.tier), 0),
        byTier,
        byCountry,
        byCriticality,
        byRiskLevel,
        soleSourceLinks: links.filter((l) => l.isSoleSource === 1).length,
        lastRiskRunAt: nodes.reduce<string | null>((m, n) => (n.riskAssessedAt && (!m || n.riskAssessedAt > m) ? n.riskAssessedAt : m), null),
      },
    };
  });

  /* ---------------------------------------------------------------- */
  /* Nodes                                                             */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/supply-chain/nodes", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = nodeListSchema.parse(req.query);
    const where = and(
      eq(supplyChainNodes.companyId, req.companyId!),
      eq(supplyChainNodes.projectId, projectId),
      q.tier !== undefined ? eq(supplyChainNodes.tier, q.tier) : undefined,
      q.criticality ? eq(supplyChainNodes.criticality, q.criticality) : undefined,
      q.country ? eq(supplyChainNodes.country, q.country.toUpperCase()) : undefined,
      q.status ? eq(supplyChainNodes.status, q.status) : undefined,
      q.q ? or(ilike(supplyChainNodes.name, `%${q.q}%`), ilike(supplyChainNodes.city, `%${q.q}%`)) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(supplyChainNodes).where(where).orderBy(asc(supplyChainNodes.tier), asc(supplyChainNodes.name)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(supplyChainNodes).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post("/projects/:projectId/supply-chain/nodes", { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = nodeBodySchema.parse(req.body);
    const companyId = req.companyId!;
    if (body.vendorId) await assertVendor(app.db, companyId, body.vendorId);
    const id = newId("scn");
    const [row] = await app.db
      .insert(supplyChainNodes)
      .values({
        id,
        companyId,
        projectId,
        name: body.name,
        kind: body.kind,
        tier: body.tier,
        country: body.country ?? null,
        city: body.city ?? null,
        criticality: body.criticality,
        categories: body.categories,
        vendorId: body.vendorId ?? null,
        entityId: body.entityId ?? null,
        commitmentId: body.commitmentId ?? null,
        annualValue: body.annualValue ?? null,
        currency: body.currency ?? "USD",
        leadTimeDays: body.leadTimeDays ?? null,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "create", objectType: "supply_chain_node", objectId: id, payload: { name: body.name, tier: body.tier, criticality: body.criticality, vendorId: body.vendorId ?? null } });
    return reply.code(201).send(row);
  });

  app.get("/projects/:projectId/supply-chain/nodes/:nodeId", { preHandler: readGate }, async (req) => {
    const { projectId, nodeId } = req.params as { projectId: string; nodeId: string };
    const companyId = req.companyId!;
    const [node] = await app.db
      .select()
      .from(supplyChainNodes)
      .where(and(eq(supplyChainNodes.id, nodeId), eq(supplyChainNodes.companyId, companyId), eq(supplyChainNodes.projectId, projectId)))
      .limit(1);
    if (!node) throw notFound("Supply chain node not found");
    const [upstream, downstream, items, assessments] = await Promise.all([
      app.db.select().from(supplyChainLinks).where(and(eq(supplyChainLinks.projectId, projectId), eq(supplyChainLinks.toNodeId, nodeId))),
      app.db.select().from(supplyChainLinks).where(and(eq(supplyChainLinks.projectId, projectId), eq(supplyChainLinks.fromNodeId, nodeId))),
      app.db
        .select({ id: longLeadItems.id, reference: longLeadItems.reference, name: longLeadItems.name, status: longLeadItems.status, riskLevel: longLeadItems.riskLevel, requiredOnSite: longLeadItems.requiredOnSite })
        .from(longLeadItems)
        .where(and(eq(longLeadItems.projectId, projectId), eq(longLeadItems.supplierNodeId, nodeId))),
      app.db
        .select()
        .from(supplierRiskAssessments)
        .where(and(eq(supplierRiskAssessments.projectId, projectId), eq(supplierRiskAssessments.nodeId, nodeId)))
        .orderBy(desc(supplierRiskAssessments.assessedAt))
        .limit(10),
    ]);
    return { ...node, upstream, downstream, longLeadItems: items, assessments, latestAssessment: assessments[0] ?? null };
  });

  app.patch("/projects/:projectId/supply-chain/nodes/:nodeId", { preHandler: standardGate }, async (req) => {
    const { projectId, nodeId } = req.params as { projectId: string; nodeId: string };
    const body = nodePatchSchema.parse(req.body);
    const companyId = req.companyId!;
    if (body.vendorId) await assertVendor(app.db, companyId, body.vendorId);
    const set = patchSet(body as Record<string, unknown>, [
      "name", "kind", "tier", "country", "city", "criticality", "categories", "vendorId", "entityId", "commitmentId", "annualValue", "currency", "leadTimeDays", "notes", "status",
    ]);
    const [row] = await app.db
      .update(supplyChainNodes)
      .set(set)
      .where(and(eq(supplyChainNodes.id, nodeId), eq(supplyChainNodes.companyId, companyId), eq(supplyChainNodes.projectId, projectId)))
      .returning();
    if (!row) throw notFound("Supply chain node not found");
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "update", objectType: "supply_chain_node", objectId: nodeId, payload: body });
    return row;
  });

  app.delete("/projects/:projectId/supply-chain/nodes/:nodeId", { preHandler: adminGate }, async (req, reply) => {
    const { projectId, nodeId } = req.params as { projectId: string; nodeId: string };
    const companyId = req.companyId!;
    const [items] = await app.db.select({ n: count() }).from(longLeadItems).where(and(eq(longLeadItems.projectId, projectId), eq(longLeadItems.supplierNodeId, nodeId)));
    if ((items?.n ?? 0) > 0) {
      throw badRequest(`${items?.n} long-lead item(s) name this node as supplier. Re-point or cancel them first; the map must not lose the supplier of an open order.`);
    }
    const [row] = await app.db
      .delete(supplyChainNodes)
      .where(and(eq(supplyChainNodes.id, nodeId), eq(supplyChainNodes.companyId, companyId), eq(supplyChainNodes.projectId, projectId)))
      .returning({ id: supplyChainNodes.id });
    if (!row) throw notFound("Supply chain node not found");
    await app.db.delete(supplyChainLinks).where(and(eq(supplyChainLinks.projectId, projectId), or(eq(supplyChainLinks.fromNodeId, nodeId), eq(supplyChainLinks.toNodeId, nodeId))));
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "delete", objectType: "supply_chain_node", objectId: nodeId });
    return reply.code(204).send();
  });

  /* ---------------------------------------------------------------- */
  /* Links                                                             */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/supply-chain/links", { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = linkBodySchema.parse(req.body);
    const companyId = req.companyId!;
    if (body.fromNodeId === body.toNodeId) throw badRequest("A node cannot supply itself.");
    const ends = await app.db
      .select({ id: supplyChainNodes.id })
      .from(supplyChainNodes)
      .where(and(eq(supplyChainNodes.projectId, projectId), eq(supplyChainNodes.companyId, companyId), or(eq(supplyChainNodes.id, body.fromNodeId), eq(supplyChainNodes.id, body.toNodeId))));
    if (ends.length !== 2) throw badRequest("Both ends of a link must be nodes on this project's map.");
    const dup = await app.db
      .select({ id: supplyChainLinks.id })
      .from(supplyChainLinks)
      .where(and(eq(supplyChainLinks.fromNodeId, body.fromNodeId), eq(supplyChainLinks.toNodeId, body.toNodeId), eq(supplyChainLinks.kind, body.kind)))
      .limit(1);
    if (dup[0]) throw conflict("That link already exists.");
    const id = newId("scl");
    const [row] = await app.db
      .insert(supplyChainLinks)
      .values({
        id,
        companyId,
        projectId,
        fromNodeId: body.fromNodeId,
        toNodeId: body.toNodeId,
        kind: body.kind,
        category: body.category ?? null,
        description: body.description ?? null,
        isSoleSource: body.isSoleSource ? 1 : 0,
        leadTimeDays: body.leadTimeDays ?? null,
        value: body.value ?? null,
        currency: body.currency ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "create", objectType: "supply_chain_link", objectId: id, payload: body });
    await app.db.update(supplyChainNodes).set({ updatedAt: nowISO() }).where(eq(supplyChainNodes.id, body.toNodeId));
    return reply.code(201).send(row);
  });

  app.delete("/projects/:projectId/supply-chain/links/:linkId", { preHandler: standardGate }, async (req, reply) => {
    const { projectId, linkId } = req.params as { projectId: string; linkId: string };
    const companyId = req.companyId!;
    const [row] = await app.db
      .delete(supplyChainLinks)
      .where(and(eq(supplyChainLinks.id, linkId), eq(supplyChainLinks.companyId, companyId), eq(supplyChainLinks.projectId, projectId)))
      .returning({ id: supplyChainLinks.id });
    if (!row) throw notFound("Supply chain link not found");
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "delete", objectType: "supply_chain_link", objectId: linkId });
    return reply.code(204).send();
  });
};
