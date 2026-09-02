/**
 * Supply chain services — the database-touching orchestration the routes AND
 * the scheduler jobs share, so a sweep and a button do exactly the same thing.
 *
 *  - long-lead: refresh required-on-site from the programme, re-assess, keep
 *    the order-by OBLIGATION in step, raise late/at-risk SIGNALS idempotently
 *  - JIT: detect delivery-vs-task conflicts and raise signals
 *  - supplier risk: assemble what the platform holds about every node, run
 *    the engine, snapshot the result, raise signals
 *
 * Nothing here computes: the engines do. Nothing here decides who may call
 * it: the routes and the scheduler do.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  deliverySlots,
  entities,
  longLeadItems,
  obligations,
  offsiteUnits,
  prequalificationFinancials,
  prequalificationSubmissions,
  scheduleTasks,
  supplierRiskAssessments,
  supplyChainLinks,
  supplyChainNodes,
} from "@constructos/db";
import type { SignalSeverity } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { newId } from "../../lib/ids.js";
import { detectJitConflicts, type JitConflict } from "./engines/jit.js";
import {
  assessLongLead,
  isExpeditingStale,
  type LongLeadAssessment,
} from "./engines/longLead.js";
import { assessSupplyChain, type RiskFlagRecord, type SupplyChainRiskResult } from "./engines/supplierRisk.js";
import { SYSTEM_ACTOR, alreadySignalled, ledger, nowISO, raiseSignal } from "./shared.js";

export type LongLeadRow = typeof longLeadItems.$inferSelect;
export type NodeRow = typeof supplyChainNodes.$inferSelect;

export interface TaskLite {
  id: string;
  name: string;
  startDate: string | null;
  actualStart: string | null;
  isCritical: boolean;
}

export interface LongLeadContext {
  tasks: Map<string, TaskLite>;
  nodes: Map<string, NodeRow>;
}

/* ------------------------------------------------------------------ */
/* Long-lead                                                           */
/* ------------------------------------------------------------------ */

export async function loadLongLeadContext(
  db: Db,
  projectId: string,
  rows: Array<Pick<LongLeadRow, "scheduleTaskId" | "supplierNodeId">>,
): Promise<LongLeadContext> {
  const taskIds = [...new Set(rows.map((r) => r.scheduleTaskId).filter((x): x is string => Boolean(x)))];
  const nodeIds = [...new Set(rows.map((r) => r.supplierNodeId).filter((x): x is string => Boolean(x)))];
  const tasks = new Map<string, TaskLite>();
  if (taskIds.length > 0) {
    const found = await db
      .select({
        id: scheduleTasks.id,
        name: scheduleTasks.name,
        startDate: scheduleTasks.startDate,
        actualStart: scheduleTasks.actualStart,
        isCritical: scheduleTasks.isCritical,
      })
      .from(scheduleTasks)
      .where(and(eq(scheduleTasks.projectId, projectId), inArray(scheduleTasks.id, taskIds)));
    for (const t of found) tasks.set(t.id, { ...t, isCritical: t.isCritical === 1 });
  }
  const nodes = new Map<string, NodeRow>();
  if (nodeIds.length > 0) {
    const found = await db
      .select()
      .from(supplyChainNodes)
      .where(and(eq(supplyChainNodes.projectId, projectId), inArray(supplyChainNodes.id, nodeIds)));
    for (const n of found) nodes.set(n.id, n);
  }
  return { tasks, nodes };
}

export interface ItemAssessment {
  assessment: LongLeadAssessment;
  requiredOnSite: string | null;
  requiredFromSchedule: number;
  scheduleTaskName: string | null;
  taskIsCritical: boolean;
}

/** Pure given the context: what the row should look like after assessment. */
export function assessItem(row: LongLeadRow, ctx: LongLeadContext, today: string): ItemAssessment {
  const task = row.scheduleTaskId ? ctx.tasks.get(row.scheduleTaskId) : undefined;
  const node = row.supplierNodeId ? ctx.nodes.get(row.supplierNodeId) : undefined;
  // The programme wins when the item follows it; a typed date wins otherwise.
  let requiredOnSite = row.requiredOnSite;
  let requiredFromSchedule = row.requiredFromSchedule;
  if (task && (row.requiredFromSchedule === 1 || !row.requiredOnSite)) {
    const fromTask = task.actualStart ?? task.startDate;
    if (fromTask) {
      requiredOnSite = fromTask;
      requiredFromSchedule = 1;
    }
  }
  const assessment = assessLongLead(
    {
      status: row.status,
      requiredOnSite,
      leadTimeDays: row.leadTimeDays,
      bufferDays: row.bufferDays,
      plannedOrderDate: row.plannedOrderDate,
      actualOrderDate: row.actualOrderDate,
      plannedShipDate: row.plannedShipDate,
      actualShipDate: row.actualShipDate,
      plannedArrivalDate: row.plannedArrivalDate,
      forecastArrivalDate: row.forecastArrivalDate,
      actualArrivalDate: row.actualArrivalDate,
      customsRequired: row.customsRequired === 1,
      customsClearedAt: row.customsClearedAt,
      lastExpeditedAt: row.lastExpeditedAt,
      supplierCriticality: node?.criticality ?? null,
      taskIsCritical: task?.isCritical ?? false,
    },
    today,
  );
  return {
    assessment,
    requiredOnSite,
    requiredFromSchedule,
    scheduleTaskName: task?.name ?? row.scheduleTaskName,
    taskIsCritical: task?.isCritical ?? false,
  };
}

const UNORDERED: ReadonlySet<string> = new Set(["identified", "requisitioned"]);

/**
 * Keep the order-by OBLIGATION in step with the item: an unordered item with
 * an order-by date has one open obligation carrying that deadline; ordering
 * satisfies it; cancelling waives it. The id lives in `detail.obligationId`.
 */
async function syncOrderByObligation(
  db: Db,
  row: LongLeadRow,
  assessed: ItemAssessment,
  actorId: string | null,
): Promise<Record<string, unknown>> {
  const detail = { ...(row.detail ?? {}) } as Record<string, unknown>;
  const existingId = typeof detail["obligationId"] === "string" ? (detail["obligationId"] as string) : null;
  const orderBy = assessed.assessment.orderByDate;
  const deadline = orderBy ? `${orderBy}T23:59:59.000Z` : null;

  if (UNORDERED.has(row.status) && deadline) {
    if (existingId) {
      await db
        .update(obligations)
        .set({ deadline, status: "open" })
        .where(and(eq(obligations.id, existingId), eq(obligations.companyId, row.companyId)));
    } else {
      const id = newId("obl");
      await db.insert(obligations).values({
        id,
        companyId: row.companyId,
        projectId: row.projectId,
        sourceClause: `Long-lead ${row.reference} — order-by date`,
        trigger: `${row.reference} ${row.name} must be ordered by ${orderBy} (required on site ${assessed.requiredOnSite}, lead time ${row.leadTimeDays}d, buffer ${row.bufferDays}d) or the programme slips.`,
        deadline,
        warnDaysBefore: 14,
        evidenceRequirement: "The ordered milestone recorded on the item, or a commitment (purchase order) linked to it",
        status: "open",
        createdBy: actorId ?? SYSTEM_ACTOR,
      });
      detail["obligationId"] = id;
    }
  } else if (existingId) {
    const next = row.status === "cancelled" ? "waived" : "satisfied";
    await db
      .update(obligations)
      .set({ status: next })
      .where(and(eq(obligations.id, existingId), eq(obligations.companyId, row.companyId), eq(obligations.status, "open")));
  }
  return detail;
}

/** Assess one item and persist the engine's outputs. Returns the stored row. */
export async function persistAssessment(
  db: Db,
  row: LongLeadRow,
  ctx: LongLeadContext,
  today: string,
  actorId: string | null,
): Promise<{ row: LongLeadRow; assessed: ItemAssessment }> {
  const assessed = assessItem(row, ctx, today);
  const detail = await syncOrderByObligation(db, row, assessed, actorId);
  const [updated] = await db
    .update(longLeadItems)
    .set({
      requiredOnSite: assessed.requiredOnSite,
      requiredFromSchedule: assessed.requiredFromSchedule,
      scheduleTaskName: assessed.scheduleTaskName,
      orderByDate: assessed.assessment.orderByDate,
      floatDays: assessed.assessment.floatDays,
      riskLevel: assessed.assessment.riskLevel,
      riskReasons: assessed.assessment.reasons,
      riskAssessedAt: nowISO(),
      detail,
      updatedAt: nowISO(),
    })
    .where(eq(longLeadItems.id, row.id))
    .returning();
  return { row: updated ?? row, assessed };
}

const OPEN_ITEM_STATUSES = ["identified", "requisitioned", "ordered", "in_production", "shipped", "in_customs"] as const;

export interface LongLeadSweepResult {
  assessed: number;
  signalsRaised: number;
  byRisk: Record<string, number>;
}

/** Re-assess every open item on a project and raise late / at-risk signals once each. */
export async function sweepLongLead(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  today: string,
): Promise<LongLeadSweepResult> {
  const rows = await db
    .select()
    .from(longLeadItems)
    .where(
      and(
        eq(longLeadItems.companyId, companyId),
        eq(longLeadItems.projectId, projectId),
        inArray(longLeadItems.status, [...OPEN_ITEM_STATUSES]),
      ),
    );
  const ctx = await loadLongLeadContext(db, projectId, rows);
  const seen = await alreadySignalled(db, companyId, ["supply_long_lead_late", "supply_long_lead_at_risk"]);
  const byRisk: Record<string, number> = {};
  let signalsRaised = 0;
  for (const row of rows) {
    const { row: stored, assessed } = await persistAssessment(db, row, ctx, today, actorId);
    byRisk[assessed.assessment.riskLevel] = (byRisk[assessed.assessment.riskLevel] ?? 0) + 1;
    const level = assessed.assessment.riskLevel;
    if (level !== "late" && level !== "at_risk") continue;
    const detector = level === "late" ? "supply_long_lead_late" : "supply_long_lead_at_risk";
    const key = `lli:${row.id}:${level}`;
    if (seen.has(key)) continue;
    const severity: SignalSeverity =
      level === "late" ? (assessed.taskIsCritical ? "critical" : "high") : assessed.taskIsCritical ? "high" : "medium";
    const signalId = await raiseSignal(db, companyId, projectId, actorId, {
      detector,
      severity,
      confidence: 0.85,
      title: `${stored.reference} ${stored.name} is ${level.replace("_", " ")}${assessed.taskIsCritical ? " on a critical-path task" : ""}`,
      explanation: assessed.assessment.reasons.join(" "),
      key,
      evidence: {
        longLeadItemId: row.id,
        reference: stored.reference,
        orderByDate: assessed.assessment.orderByDate,
        requiredOnSite: assessed.requiredOnSite,
        expectedOnSite: assessed.assessment.expectedOnSite,
        floatDays: assessed.assessment.floatDays,
        scheduleTaskId: stored.scheduleTaskId,
      },
    });
    seen.add(key);
    signalsRaised += 1;
    await db.update(longLeadItems).set({ signalId }).where(eq(longLeadItems.id, row.id));
  }
  return { assessed: rows.length, signalsRaised, byRisk };
}

/* ------------------------------------------------------------------ */
/* Just-in-time                                                        */
/* ------------------------------------------------------------------ */

export async function computeJitConflicts(db: Db, companyId: string, projectId: string, today: string): Promise<JitConflict[]> {
  const [slots, items, units] = await Promise.all([
    db
      .select({
        id: deliverySlots.id,
        reference: deliverySlots.reference,
        scheduleTaskId: deliverySlots.scheduleTaskId,
        longLeadItemId: deliverySlots.longLeadItemId,
        offsiteUnitId: deliverySlots.offsiteUnitId,
        startsAt: deliverySlots.startsAt,
        status: deliverySlots.status,
      })
      .from(deliverySlots)
      .where(and(eq(deliverySlots.companyId, companyId), eq(deliverySlots.projectId, projectId))),
    db
      .select()
      .from(longLeadItems)
      .where(and(eq(longLeadItems.companyId, companyId), eq(longLeadItems.projectId, projectId), inArray(longLeadItems.status, [...OPEN_ITEM_STATUSES]))),
    db
      .select({
        id: offsiteUnits.id,
        reference: offsiteUnits.reference,
        name: offsiteUnits.name,
        scheduleTaskId: offsiteUnits.scheduleTaskId,
        status: offsiteUnits.status,
        plannedDeliveryDate: offsiteUnits.plannedDeliveryDate,
        actualDeliveryDate: offsiteUnits.actualDeliveryDate,
      })
      .from(offsiteUnits)
      .where(and(eq(offsiteUnits.companyId, companyId), eq(offsiteUnits.projectId, projectId))),
  ]);
  const taskIds = new Set<string>();
  for (const s of slots) if (s.scheduleTaskId) taskIds.add(s.scheduleTaskId);
  for (const i of items) if (i.scheduleTaskId) taskIds.add(i.scheduleTaskId);
  for (const u of units) if (u.scheduleTaskId) taskIds.add(u.scheduleTaskId);
  const tasks =
    taskIds.size > 0
      ? await db
          .select({
            id: scheduleTasks.id,
            name: scheduleTasks.name,
            startDate: scheduleTasks.startDate,
            actualStart: scheduleTasks.actualStart,
            isCritical: scheduleTasks.isCritical,
          })
          .from(scheduleTasks)
          .where(and(eq(scheduleTasks.projectId, projectId), inArray(scheduleTasks.id, [...taskIds])))
      : [];
  const ctx = await loadLongLeadContext(db, projectId, items);
  return detectJitConflicts({
    tasks: tasks.map((t) => ({ ...t, isCritical: t.isCritical === 1 })),
    slots: slots.map((s) => ({ ...s, startsAt: new Date(s.startsAt).toISOString() })),
    items: items.map((i) => ({
      id: i.id,
      reference: i.reference,
      name: i.name,
      scheduleTaskId: i.scheduleTaskId,
      expectedOnSite: assessItem(i, ctx, today).assessment.expectedOnSite,
      status: i.status,
    })),
    units,
    today,
  });
}

export async function sweepJit(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  today: string,
): Promise<{ conflicts: JitConflict[]; raised: number }> {
  const conflicts = await computeJitConflicts(db, companyId, projectId, today);
  const seen = await alreadySignalled(db, companyId, ["supply_jit_conflict"]);
  let raised = 0;
  for (const c of conflicts) {
    if (c.severity === "low" || seen.has(c.key)) continue;
    await raiseSignal(db, companyId, projectId, actorId, {
      detector: "supply_jit_conflict",
      severity: c.severity,
      confidence: 0.8,
      title: c.title,
      explanation: c.explanation,
      key: c.key,
      evidence: { kind: c.kind, taskId: c.taskId, sourceType: c.sourceType, sourceId: c.sourceId, daysDelta: c.daysDelta },
    });
    seen.add(c.key);
    raised += 1;
  }
  return { conflicts, raised };
}

/* ------------------------------------------------------------------ */
/* Supplier risk                                                       */
/* ------------------------------------------------------------------ */

export interface SupplierRiskRun {
  result: SupplyChainRiskResult;
  nodes: NodeRow[];
  raised: number;
  assessedAt: string;
}

export async function runSupplierRisk(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  today: string,
): Promise<SupplierRiskRun> {
  const nodes = await db
    .select()
    .from(supplyChainNodes)
    .where(and(eq(supplyChainNodes.companyId, companyId), eq(supplyChainNodes.projectId, projectId)));
  const links = await db
    .select()
    .from(supplyChainLinks)
    .where(and(eq(supplyChainLinks.companyId, companyId), eq(supplyChainLinks.projectId, projectId)));
  const vendorIds = [...new Set(nodes.map((n) => n.vendorId).filter((x): x is string => Boolean(x)))];
  const entityIds = [...new Set(nodes.map((n) => n.entityId).filter((x): x is string => Boolean(x)))];
  const [financials, prequals, ents, items] = await Promise.all([
    vendorIds.length > 0
      ? db
          .select({
            vendorId: prequalificationFinancials.vendorId,
            financialYearEnd: prequalificationFinancials.financialYearEnd,
            currentRatio: prequalificationFinancials.currentRatio,
            netAssets: prequalificationFinancials.netAssets,
            gearingPercent: prequalificationFinancials.gearingPercent,
            isGoingConcernQualified: prequalificationFinancials.isGoingConcernQualified,
            ccjCount: prequalificationFinancials.ccjCount,
            insolvencyEvents: prequalificationFinancials.insolvencyEvents,
            turnover: prequalificationFinancials.turnover,
          })
          .from(prequalificationFinancials)
          .where(and(eq(prequalificationFinancials.companyId, companyId), inArray(prequalificationFinancials.vendorId, vendorIds)))
      : Promise.resolve([]),
    vendorIds.length > 0
      ? db
          .select({
            vendorId: prequalificationSubmissions.vendorId,
            outcome: prequalificationSubmissions.outcome,
            expiresAt: prequalificationSubmissions.expiresAt,
          })
          .from(prequalificationSubmissions)
          .where(and(eq(prequalificationSubmissions.companyId, companyId), inArray(prequalificationSubmissions.vendorId, vendorIds)))
      : Promise.resolve([]),
    entityIds.length > 0
      ? db
          .select({ id: entities.id, screeningStatus: entities.screeningStatus, screenedAt: entities.screenedAt })
          .from(entities)
          .where(and(eq(entities.companyId, companyId), inArray(entities.id, entityIds)))
      : Promise.resolve([]),
    db
      .select()
      .from(longLeadItems)
      .where(and(eq(longLeadItems.companyId, companyId), eq(longLeadItems.projectId, projectId), inArray(longLeadItems.status, [...OPEN_ITEM_STATUSES]))),
  ]);
  const ctx = await loadLongLeadContext(db, projectId, items);

  const result = assessSupplyChain({
    nodes: nodes.map((n) => ({
      id: n.id,
      name: n.name,
      tier: n.tier,
      country: n.country,
      criticality: n.criticality,
      categories: n.categories,
      vendorId: n.vendorId,
      entityId: n.entityId,
      status: n.status,
    })),
    links: links.map((l) => ({
      fromNodeId: l.fromNodeId,
      toNodeId: l.toNodeId,
      kind: l.kind,
      category: l.category,
      isSoleSource: l.isSoleSource === 1,
    })),
    financials: financials.map((f) => ({
      ...f,
      isGoingConcernQualified: f.isGoingConcernQualified === 1,
      insolvencyEvents: Array.isArray(f.insolvencyEvents) ? f.insolvencyEvents.length : 0,
    })),
    prequals,
    entities: ents,
    items: items.map((i) => ({
      supplierNodeId: i.supplierNodeId,
      taskIsCritical: i.scheduleTaskId ? (ctx.tasks.get(i.scheduleTaskId)?.isCritical ?? false) : false,
      riskLevel: i.riskLevel,
      expeditingStale: isExpeditingStale(i, today),
      status: i.status,
    })),
    today,
  });

  const assessedAt = nowISO();
  const seen = await alreadySignalled(db, companyId, [
    "supply_single_source_critical",
    "supply_country_concentration",
    "supply_financial_distress",
    "supply_sanctions",
  ]);
  let raised = 0;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  for (const a of result.assessments) {
    const node = nodeById.get(a.nodeId);
    if (!node) continue;
    const signalIds: string[] = [];
    const raiseFor = async (
      detector: "supply_single_source_critical" | "supply_financial_distress" | "supply_sanctions",
      key: string,
      severity: SignalSeverity,
      title: string,
      flag: RiskFlagRecord,
    ) => {
      if (seen.has(key)) return;
      const id = await raiseSignal(db, companyId, projectId, actorId, {
        detector,
        severity,
        confidence: 0.8,
        title,
        explanation: `${flag.detail} Basis: ${flag.basis}.`,
        key,
        evidence: { nodeId: node.id, vendorId: node.vendorId, flag: flag.code, basis: flag.basis },
      });
      seen.add(key);
      signalIds.push(id);
      raised += 1;
    };
    for (const f of a.flags) {
      if (f.code === "single_source" && f.severity === "high") {
        await raiseFor("supply_single_source_critical", `risk:${node.id}:single_source`, "high", `${node.name} is a single source for critical supply`, f);
      } else if ((f.code === "financial_distress" || f.code === "going_concern") && (f.severity === "high" || f.severity === "critical")) {
        await raiseFor("supply_financial_distress", `risk:${node.id}:financial:${String(a.inputs["financialYearEnd"] ?? "")}:${f.code}`, f.severity, `${node.name}: ${f.code === "going_concern" ? "going-concern qualification" : "financial distress indicator"}`, f);
      } else if (f.code === "sanctions_hit") {
        await raiseFor("supply_sanctions", `risk:${node.id}:sanctions`, "critical", `${node.name}: screening hit on the linked entity`, f);
      }
    }
    const id = newId("sra");
    await db.insert(supplierRiskAssessments).values({
      id,
      companyId,
      projectId,
      nodeId: node.id,
      vendorId: node.vendorId,
      assessedAt,
      score: a.score,
      level: a.level,
      flags: a.flags,
      inputs: a.inputs,
      basis: a.basis,
      signalIds,
    });
    await db
      .update(supplyChainNodes)
      .set({ riskLevel: a.level, riskScore: a.score, riskAssessedAt: assessedAt, updatedAt: assessedAt })
      .where(eq(supplyChainNodes.id, node.id));
    await ledger(db, {
      companyId,
      projectId,
      actorId,
      action: "create",
      objectType: "supplier_risk_assessment",
      objectId: id,
      payload: { nodeId: node.id, level: a.level, score: a.score, flags: a.flags.map((f) => f.code) },
    });
  }

  for (const bucket of result.concentration.flagged) {
    const key = `risk:${projectId}:concentration:${bucket.country}`;
    if (seen.has(key)) continue;
    await raiseSignal(db, companyId, projectId, actorId, {
      detector: "supply_country_concentration",
      severity: "medium",
      confidence: 0.75,
      title: `${Math.round(bucket.share * 100)}% of critical supply is concentrated in ${bucket.country}`,
      explanation: `${bucket.criticalNodes} of the project's critical/high-criticality supply chain nodes are in ${bucket.country} (threshold ${Math.round(result.concentration.threshold * 100)}%). A single disruption there stops several flows at once.`,
      key,
      evidence: { country: bucket.country, criticalNodes: bucket.criticalNodes, share: bucket.share },
    });
    seen.add(key);
    raised += 1;
  }

  const refreshed = await db
    .select()
    .from(supplyChainNodes)
    .where(and(eq(supplyChainNodes.companyId, companyId), eq(supplyChainNodes.projectId, projectId)));
  return { result, nodes: refreshed, raised, assessedAt };
}

/** Latest snapshot per node for a project (one query, newest first, first-seen wins). */
export async function latestAssessments(db: Db, companyId: string, projectId: string) {
  const rows = await db
    .select()
    .from(supplierRiskAssessments)
    .where(and(eq(supplierRiskAssessments.companyId, companyId), eq(supplierRiskAssessments.projectId, projectId)))
    .orderBy(desc(supplierRiskAssessments.assessedAt))
    .limit(2000);
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.nodeId)) latest.set(r.nodeId, r);
  return latest;
}
