/**
 * SUPPLY CHAIN ANALYTICS routes: the workspace summary, the health inputs
 * the intelligence layer reads, the just-in-time conflict view (#919, #930)
 * and the open supply signals. Every figure carries its basis; a figure with
 * no inputs is null with the reason, never zero.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { deliverySlots, longLeadItems, materialTraceRecords, offsiteUnits, signals, supplyChainLinks, supplyChainNodes } from "@constructos/db";
import { SUPPLY_CHAIN_DETECTORS } from "@constructos/shared";
import { isExpeditingStale } from "../engines/longLead.js";
import { onTimeDelivery } from "../engines/logistics.js";
import { traceCoverage } from "../engines/traceability.js";
import { OPEN_ITEM_STATUSES, computeJitConflicts, isoTs, sweepJit } from "../service.js";
import { buildGates, figure, todayISO } from "../shared.js";

const OPEN_DISPOSITIONS = ["new", "under_review", "confirmed", "escalated"] as const;

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);
  const base = "/projects/:projectId/supply-chain";

  async function gather(companyId: string, projectId: string) {
    const today = todayISO();
    const [nodes, links, items, units, slots, traces, openSignals] = await Promise.all([
      app.db.select({ id: supplyChainNodes.id, tier: supplyChainNodes.tier, country: supplyChainNodes.country, criticality: supplyChainNodes.criticality, riskLevel: supplyChainNodes.riskLevel, riskAssessedAt: supplyChainNodes.riskAssessedAt, status: supplyChainNodes.status }).from(supplyChainNodes).where(and(eq(supplyChainNodes.companyId, companyId), eq(supplyChainNodes.projectId, projectId))),
      app.db.select({ isSoleSource: supplyChainLinks.isSoleSource }).from(supplyChainLinks).where(and(eq(supplyChainLinks.companyId, companyId), eq(supplyChainLinks.projectId, projectId))),
      app.db.select({ id: longLeadItems.id, reference: longLeadItems.reference, name: longLeadItems.name, status: longLeadItems.status, riskLevel: longLeadItems.riskLevel, orderByDate: longLeadItems.orderByDate, floatDays: longLeadItems.floatDays, lastExpeditedAt: longLeadItems.lastExpeditedAt, actualArrivalDate: longLeadItems.actualArrivalDate, requiredOnSite: longLeadItems.requiredOnSite, riskAssessedAt: longLeadItems.riskAssessedAt, value: longLeadItems.value, currency: longLeadItems.currency }).from(longLeadItems).where(and(eq(longLeadItems.companyId, companyId), eq(longLeadItems.projectId, projectId))),
      app.db.select({ id: offsiteUnits.id, status: offsiteUnits.status, percentComplete: offsiteUnits.percentComplete, percentVerifiedForPayment: offsiteUnits.percentVerifiedForPayment, qaGatesFailed: offsiteUnits.qaGatesFailed, value: offsiteUnits.value, currency: offsiteUnits.currency, storageInsuredUntil: offsiteUnits.storageInsuredUntil, vestingCertifiedAt: offsiteUnits.vestingCertifiedAt }).from(offsiteUnits).where(and(eq(offsiteUnits.companyId, companyId), eq(offsiteUnits.projectId, projectId))),
      app.db.select({ id: deliverySlots.id, status: deliverySlots.status, startsAt: deliverySlots.startsAt, wasOnTime: deliverySlots.wasOnTime, lateMinutes: deliverySlots.lateMinutes, waitingMinutes: deliverySlots.waitingMinutes, issueKind: deliverySlots.issueKind, carbonKgCo2e: deliverySlots.carbonKgCo2e, transportKm: deliverySlots.transportKm }).from(deliverySlots).where(and(eq(deliverySlots.companyId, companyId), eq(deliverySlots.projectId, projectId))),
      app.db.select({ chainComplete: materialTraceRecords.chainComplete, status: materialTraceRecords.status, certificateCount: materialTraceRecords.certificateCount }).from(materialTraceRecords).where(and(eq(materialTraceRecords.companyId, companyId), eq(materialTraceRecords.projectId, projectId))),
      app.db
        .select({ id: signals.id, detector: signals.detector, severity: signals.severity, title: signals.title, explanation: signals.explanation, disposition: signals.disposition, createdAt: signals.createdAt, evidenceRefs: signals.evidenceRefs })
        .from(signals)
        .where(and(eq(signals.companyId, companyId), eq(signals.projectId, projectId), inArray(signals.detector, [...SUPPLY_CHAIN_DETECTORS]), inArray(signals.disposition, [...OPEN_DISPOSITIONS])))
        .orderBy(desc(signals.createdAt))
        .limit(200),
    ]);
    return { today, nodes, links, items, units, slots, traces, openSignals };
  }

  app.get(`${base}/summary`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const { today, nodes, links, items, units, slots, traces, openSignals } = await gather(req.companyId!, projectId);

    /* long-lead */
    const openItems = items.filter((i) => (OPEN_ITEM_STATUSES as readonly string[]).includes(i.status));
    const byRisk: Record<string, number> = {};
    for (const i of openItems) byRisk[i.riskLevel] = (byRisk[i.riskLevel] ?? 0) + 1;
    const backlog = openItems.filter((i) => isExpeditingStale({ status: i.status, lastExpeditedAt: isoTs(i.lastExpeditedAt), actualArrivalDate: i.actualArrivalDate }, today));
    const orderBySoon = openItems.filter((i) => (i.status === "identified" || i.status === "requisitioned") && i.orderByDate && i.orderByDate >= today && i.orderByDate <= addDays(today, 14));
    const valueByCurrency: Record<string, number> = {};
    for (const i of openItems) if (typeof i.value === "number") valueByCurrency[i.currency] = (valueByCurrency[i.currency] ?? 0) + i.value;

    /* deliveries */
    const onTime = onTimeDelivery(slots);
    const upcoming = slots.filter((s) => (s.status === "requested" || s.status === "confirmed") && (isoTs(s.startsAt) ?? "") >= `${today}T00:00:00.000Z`).length;
    const completed = slots.filter((s) => s.status === "completed");
    const withKm = completed.filter((s) => s.carbonKgCo2e !== null);
    const issues = completed.filter((s) => s.issueKind !== "none").length;

    /* offsite */
    const unitsByStatus: Record<string, number> = {};
    for (const u of units) unitsByStatus[u.status] = (unitsByStatus[u.status] ?? 0) + 1;
    const inFactory = units.filter((u) => ["in_design", "in_production", "qa_hold", "passed_qa", "ready_to_ship"].includes(u.status));
    const verified = inFactory.filter((u) => u.percentVerifiedForPayment !== null);
    const unitValueByCurrency: Record<string, number> = {};
    for (const u of inFactory) if (typeof u.value === "number") unitValueByCurrency[u.currency] = (unitValueByCurrency[u.currency] ?? 0) + u.value;
    const uninsuredStored = inFactory.filter((u) => u.status === "ready_to_ship" && (!u.storageInsuredUntil || u.storageInsuredUntil < today)).length;

    /* map + risk */
    const byRiskLevel: Record<string, number> = {};
    for (const n of nodes) {
      const k = n.riskLevel ?? "not_assessed";
      byRiskLevel[k] = (byRiskLevel[k] ?? 0) + 1;
    }
    const countries = new Set(nodes.map((n) => n.country).filter(Boolean));

    /* signals */
    const bySeverity: Record<string, number> = {};
    for (const s of openSignals) bySeverity[s.severity] = (bySeverity[s.severity] ?? 0) + 1;

    return {
      asOf: today,
      map: {
        nodes: nodes.length,
        links: links.length,
        tiers: nodes.reduce((m, n) => Math.max(m, n.tier), 0),
        countries: countries.size,
        soleSourceLinks: links.filter((l) => l.isSoleSource === 1).length,
        byRiskLevel,
        lastRiskRunAt: nodes.reduce<string | null>((m, n) => (n.riskAssessedAt && (!m || n.riskAssessedAt > m) ? n.riskAssessedAt : m), null),
      },
      longLead: {
        total: items.length,
        open: openItems.length,
        byRisk,
        late: byRisk["late"] ?? 0,
        atRisk: byRisk["at_risk"] ?? 0,
        watch: byRisk["watch"] ?? 0,
        notAssessable: byRisk["not_assessable"] ?? 0,
        orderByWithin14Days: orderBySoon.length,
        expeditingBacklog: backlog.length,
        expeditingBacklogItems: backlog.slice(0, 20).map((i) => ({ id: i.id, reference: i.reference, name: i.name, status: i.status, lastExpeditedAt: i.lastExpeditedAt })),
        valueByCurrency,
        currencyNote: Object.keys(valueByCurrency).length > 1 ? "Open order value is reported per currency and never added across them." : null,
      },
      deliveries: {
        total: slots.length,
        upcoming,
        completed: completed.length,
        onTimePercent: figure(onTime.onTimePercent, "%", { assessed: onTime.onTime + onTime.late, onTime: onTime.onTime, late: onTime.late }, onTime.reasons),
        averageLateMinutes: onTime.averageLateMinutes,
        averageWaitingMinutes: onTime.averageWaitingMinutes,
        noShows: onTime.noShow,
        withIssues: issues,
        transportCarbonKgCo2e: figure(
          withKm.length > 0 ? Math.round(withKm.reduce((s, r) => s + (r.carbonKgCo2e ?? 0), 0) * 100) / 100 : null,
          "kgCO2e",
          { deliveriesWithDistance: withKm.length, deliveriesWithoutDistance: completed.length - withKm.length },
          withKm.length === 0 ? ["No completed delivery has a transport distance recorded."] : completed.length - withKm.length > 0 ? [`${completed.length - withKm.length} completed delivery(ies) carry no distance and are excluded.`] : [],
        ),
      },
      offsite: {
        units: units.length,
        byStatus: unitsByStatus,
        inFactory: inFactory.length,
        qaHold: unitsByStatus["qa_hold"] ?? 0,
        averagePercentComplete: figure(
          inFactory.length > 0 ? Math.round((inFactory.reduce((s, u) => s + u.percentComplete, 0) / inFactory.length) * 10) / 10 : null,
          "%",
          { units: inFactory.length },
          inFactory.length === 0 ? ["No units in the factory."] : [],
        ),
        averagePercentVerified: figure(
          verified.length > 0 ? Math.round((verified.reduce((s, u) => s + (u.percentVerifiedForPayment ?? 0), 0) / verified.length) * 10) / 10 : null,
          "%",
          { unitsVerified: verified.length, unitsInFactory: inFactory.length },
          verified.length === 0 ? ["No factory inspection has verified a percent complete; a valuation may not rely on the factory's own figure."] : inFactory.length - verified.length > 0 ? [`${inFactory.length - verified.length} unit(s) in the factory have no independently verified percent.`] : [],
        ),
        valueInFactoryByCurrency: unitValueByCurrency,
        readyToShipUninsured: uninsuredStored,
      },
      traceability: traceCoverage(traces),
      signals: { open: openSignals.length, bySeverity, items: openSignals.slice(0, 50) },
    };
  });

  app.get(`${base}/health-inputs`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const { today, nodes, items, units, slots, traces, openSignals } = await gather(req.companyId!, projectId);
    const openItems = items.filter((i) => (OPEN_ITEM_STATUSES as readonly string[]).includes(i.status));
    const onTime = onTimeDelivery(slots);
    const coverage = traceCoverage(traces);
    const conflicts = await computeJitConflicts(app.db, req.companyId!, projectId, today);
    const reasons: string[] = [];
    if (openItems.length === 0) reasons.push("No open long-lead items: long-lead metrics are null.");
    if (onTime.onTimePercent === null) reasons.push(onTime.reasons[0] ?? "No delivery assessed.");
    if (nodes.length === 0) reasons.push("No supply chain nodes: supplier risk metrics are null.");
    if (traces.length === 0) reasons.push("No traceability records: chain completeness is null.");
    const assessedNodes = nodes.filter((n) => n.riskLevel && n.riskLevel !== "not_assessable");
    return {
      metrics: {
        longLeadOpen: openItems.length,
        longLeadLate: openItems.length > 0 ? openItems.filter((i) => i.riskLevel === "late").length : null,
        longLeadAtRisk: openItems.length > 0 ? openItems.filter((i) => i.riskLevel === "at_risk").length : null,
        longLeadLatePercent: openItems.length > 0 ? Math.round((openItems.filter((i) => i.riskLevel === "late" || i.riskLevel === "at_risk").length / openItems.length) * 1000) / 10 : null,
        expeditingBacklog: openItems.length > 0 ? openItems.filter((i) => isExpeditingStale({ status: i.status, lastExpeditedAt: isoTs(i.lastExpeditedAt), actualArrivalDate: i.actualArrivalDate }, today)).length : null,
        onTimeDeliveryPercent: onTime.onTimePercent,
        deliveryNoShows: slots.length > 0 ? onTime.noShow : null,
        jitConflicts: conflicts.filter((c) => c.severity !== "low").length,
        jitConflictsCritical: conflicts.filter((c) => c.severity === "critical").length,
        supplierRiskCritical: nodes.length > 0 ? assessedNodes.filter((n) => n.riskLevel === "critical").length : null,
        supplierRiskHigh: nodes.length > 0 ? assessedNodes.filter((n) => n.riskLevel === "high").length : null,
        supplierNodesUnassessed: nodes.length > 0 ? nodes.length - assessedNodes.length : null,
        offsiteQaHold: units.length > 0 ? units.filter((u) => u.status === "qa_hold").length : null,
        traceChainCompletePercent: coverage.completenessPercent,
        traceInstalledWithoutCertificate: traces.length > 0 ? coverage.installedWithoutCertificate : null,
        openSignals: openSignals.length,
        openSignalsCritical: openSignals.filter((s) => s.severity === "critical").length,
      },
      reasons,
    };
  });

  app.get(`${base}/jit/conflicts`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const conflicts = await computeJitConflicts(app.db, req.companyId!, projectId, todayISO());
    const byKind: Record<string, number> = {};
    for (const c of conflicts) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
    return { asOf: todayISO(), items: conflicts, total: conflicts.length, byKind, method: "Every booked delivery, open long-lead item and offsite unit is tested against the start of the schedule task it feeds; a task starting within 10 days with linked material and no booking is flagged." };
  });

  app.post(`${base}/jit/run`, { preHandler: standardGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const r = await sweepJit(app.db, req.companyId!, projectId, req.user!.id, todayISO());
    return { asOf: todayISO(), conflicts: r.conflicts.length, signalsRaised: r.raised, items: r.conflicts };
  });

  app.get(`${base}/signals`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const { openSignals } = await gather(req.companyId!, projectId);
    return { items: openSignals, total: openSignals.length };
  });
};

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
