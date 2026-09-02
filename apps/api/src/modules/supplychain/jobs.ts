/**
 * Scheduler jobs for the supply chain module. Each job is the same service a
 * button calls, run for every tenant with the system actor, bounded per
 * project, and idempotent: a condition already signalled is never raised
 * twice, a risk verdict that has not moved writes no snapshot.
 *
 *   supplychain.long-lead          hourly   re-assess open items, raise late / at-risk
 *   supplychain.jit                hourly   delivery-vs-task conflicts
 *   supplychain.delivery-no-show   30 min   bookings that never arrived
 *   supplychain.supplier-risk      daily    supplier risk engine per project
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { deliverySlots, longLeadItems, offsiteUnits, supplyChainNodes } from "@constructos/db";
import type { Db } from "../../lib/db.js";
import { forEachCompany } from "../../lib/scheduler.js";
import { OPEN_ITEM_STATUSES, runSupplierRisk, sweepDeliveryNoShows, sweepJit, sweepLongLead } from "./service.js";

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function projectsWithOpenItems(db: Db, companyId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ projectId: longLeadItems.projectId })
    .from(longLeadItems)
    .where(and(eq(longLeadItems.companyId, companyId), inArray(longLeadItems.status, [...OPEN_ITEM_STATUSES])));
  return rows.map((r) => r.projectId);
}

async function projectsWithLogistics(db: Db, companyId: string): Promise<string[]> {
  const [a, b, c] = await Promise.all([
    db.selectDistinct({ projectId: deliverySlots.projectId }).from(deliverySlots).where(and(eq(deliverySlots.companyId, companyId), inArray(deliverySlots.status, ["requested", "confirmed"]))),
    db.selectDistinct({ projectId: longLeadItems.projectId }).from(longLeadItems).where(and(eq(longLeadItems.companyId, companyId), inArray(longLeadItems.status, [...OPEN_ITEM_STATUSES]))),
    db.selectDistinct({ projectId: offsiteUnits.projectId }).from(offsiteUnits).where(and(eq(offsiteUnits.companyId, companyId), inArray(offsiteUnits.status, ["planned", "in_design", "in_production", "qa_hold", "passed_qa", "ready_to_ship", "in_transit"]))),
  ]);
  return [...new Set([...a, ...b, ...c].map((r) => r.projectId))];
}

async function projectsWithNodes(db: Db, companyId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ projectId: supplyChainNodes.projectId })
    .from(supplyChainNodes)
    .where(and(eq(supplyChainNodes.companyId, companyId), eq(supplyChainNodes.status, "active")));
  return rows.map((r) => r.projectId);
}

export async function runLongLeadJob(db: Db, companyId: string, now: Date) {
  let assessed = 0;
  let raised = 0;
  for (const projectId of await projectsWithOpenItems(db, companyId)) {
    const r = await sweepLongLead(db, companyId, projectId, null, today(now));
    assessed += r.assessed;
    raised += r.signalsRaised;
  }
  return { assessed, raised };
}

export async function runJitJob(db: Db, companyId: string, now: Date) {
  let conflicts = 0;
  let raised = 0;
  for (const projectId of await projectsWithLogistics(db, companyId)) {
    const r = await sweepJit(db, companyId, projectId, null, today(now));
    conflicts += r.conflicts.length;
    raised += r.raised;
  }
  return { conflicts, raised };
}

export async function runSupplierRiskJob(db: Db, companyId: string, now: Date) {
  let nodes = 0;
  let raised = 0;
  let snapshots = 0;
  for (const projectId of await projectsWithNodes(db, companyId)) {
    const r = await runSupplierRisk(db, companyId, projectId, null, today(now));
    nodes += r.nodes.length;
    raised += r.raised;
    snapshots += r.snapshotsWritten;
  }
  return { nodes, raised, snapshots };
}

export function registerSupplyChainJobs(app: FastifyInstance): void {
  app.scheduler.register({
    name: "supplychain.long-lead",
    description: "Re-assess every open long-lead item against the programme; raise late and at-risk signals; keep order-by obligations in step",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => runLongLeadJob(db, companyId, now)),
  });
  app.scheduler.register({
    name: "supplychain.jit",
    description: "Detect delivery-versus-task-start conflicts (just-in-time) and raise signals",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => runJitJob(db, companyId, now)),
  });
  app.scheduler.register({
    name: "supplychain.delivery-no-show",
    description: "Mark delivery bookings with no arrival 24h after their window as no-shows and raise a signal",
    everyMs: 30 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => sweepDeliveryNoShows(db, companyId, now)),
  });
  app.scheduler.register({
    name: "supplychain.supplier-risk",
    description: "Run the supplier risk engine (single source, concentration, financial distress, screening, prequal, expediting) per project; snapshot only when the verdict moves",
    everyMs: 24 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => runSupplierRiskJob(db, companyId, now)),
  });
}
