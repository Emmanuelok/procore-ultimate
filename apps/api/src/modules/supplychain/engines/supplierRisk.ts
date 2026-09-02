/**
 * SUPPLIER RISK ENGINE (spec #915–917, #946).
 *
 * Scores every node on the map from what the platform already holds:
 *
 *  - single source     a critical flow with no alternative upstream node
 *  - concentration     too much of the critical supply in one country
 *  - financial distress  the prequalification financials say so (going-concern
 *                      qualification, insolvency events, current ratio < 1,
 *                      negative net assets, CCJs)
 *  - sanctions         the screened entity's status (placeholder: the assurance
 *                      layer holds screening; this engine only reads it)
 *  - prequal           rejected, missing or expired
 *  - visibility gap    a tier-2+ node with nobody it supplies (map incomplete)
 *  - critical path     the node feeds a long-lead item on a critical task
 *  - expediting backlog  the node's items are ordered and unchased
 *
 * Each flag carries its basis so a reader can dispute it. The score is a
 * bounded, additive, explainable number, not a model: 0 = nothing found.
 * A node with nothing to read (no financials, no entity, no links) is
 * `not_assessable`, never "low".
 */
import type { SupplierRiskLevel, SupplyRiskFlag } from "@constructos/shared";

export interface RiskNode {
  id: string;
  name: string;
  tier: number;
  country: string | null;
  criticality: string;
  categories: string[];
  vendorId: string | null;
  entityId: string | null;
  status: string;
}

export interface RiskLink {
  fromNodeId: string;
  toNodeId: string;
  kind: string;
  category: string | null;
  isSoleSource: boolean;
}

export interface RiskFinancials {
  vendorId: string;
  financialYearEnd: string;
  currentRatio: number | null;
  netAssets: number | null;
  gearingPercent: number | null;
  isGoingConcernQualified: boolean;
  ccjCount: number | null;
  insolvencyEvents: number;
  turnover: number | null;
}

export interface RiskPrequal {
  vendorId: string;
  outcome: string;
  expiresAt: string | null;
}

export interface RiskEntity {
  id: string;
  screeningStatus: string | null;
  screenedAt: string | null;
}

export interface RiskItemContext {
  supplierNodeId: string | null;
  taskIsCritical: boolean;
  riskLevel: string;
  expeditingStale: boolean;
  status: string;
}

export interface RiskFlagRecord {
  code: SupplyRiskFlag;
  severity: "info" | "low" | "medium" | "high" | "critical";
  detail: string;
  basis: string;
  points: number;
}

export interface NodeRiskAssessment {
  nodeId: string;
  vendorId: string | null;
  score: number | null;
  level: SupplierRiskLevel;
  flags: RiskFlagRecord[];
  inputs: Record<string, unknown>;
  basis: string;
}

export interface SupplyChainRiskInput {
  nodes: RiskNode[];
  links: RiskLink[];
  financials: RiskFinancials[];
  prequals: RiskPrequal[];
  entities: RiskEntity[];
  items: RiskItemContext[];
  today: string;
  /** share of critical/high nodes in one country that trips concentration; default 0.5 */
  concentrationThreshold?: number;
}

export interface ConcentrationBucket {
  country: string;
  nodes: number;
  criticalNodes: number;
  share: number;
}

export interface SupplyChainRiskResult {
  assessments: NodeRiskAssessment[];
  concentration: {
    byCountry: ConcentrationBucket[];
    flagged: ConcentrationBucket[];
    threshold: number;
    reasons: string[];
  };
  summary: Record<SupplierRiskLevel, number>;
}

const SEVERITY_POINTS = { info: 0, low: 5, medium: 15, high: 30, critical: 50 } as const;

function flag(
  code: SupplyRiskFlag,
  severity: RiskFlagRecord["severity"],
  detail: string,
  basis: string,
): RiskFlagRecord {
  return { code, severity, detail, basis, points: SEVERITY_POINTS[severity] };
}

export function levelForScore(score: number): SupplierRiskLevel {
  if (score >= 60) return "critical";
  if (score >= 35) return "high";
  if (score >= 15) return "medium";
  return "low";
}

/** Concentration: where the critical supply sits, by country. */
export function countryConcentration(
  nodes: RiskNode[],
  threshold: number,
): SupplyChainRiskResult["concentration"] {
  const active = nodes.filter((n) => n.status === "active");
  const important = active.filter((n) => n.criticality === "critical" || n.criticality === "high");
  const buckets = new Map<string, ConcentrationBucket>();
  for (const n of active) {
    const key = n.country ?? "unknown";
    const b = buckets.get(key) ?? { country: key, nodes: 0, criticalNodes: 0, share: 0 };
    b.nodes += 1;
    if (n.criticality === "critical" || n.criticality === "high") b.criticalNodes += 1;
    buckets.set(key, b);
  }
  const reasons: string[] = [];
  const denominator = important.length;
  const byCountry = [...buckets.values()]
    .map((b) => ({ ...b, share: denominator > 0 ? Math.round((b.criticalNodes / denominator) * 1000) / 1000 : 0 }))
    .sort((a, b) => b.criticalNodes - a.criticalNodes || b.nodes - a.nodes);
  if (denominator < 2) {
    reasons.push(
      denominator === 0
        ? "No critical or high-criticality nodes on the map; concentration cannot be judged."
        : "Only one critical/high node on the map; concentration needs at least two to mean anything.",
    );
    return { byCountry, flagged: [], threshold, reasons };
  }
  const flagged = byCountry.filter((b) => b.country !== "unknown" && b.share >= threshold && b.criticalNodes >= 2);
  const unknown = byCountry.find((b) => b.country === "unknown");
  if (unknown && unknown.criticalNodes > 0) {
    reasons.push(`${unknown.criticalNodes} critical/high node(s) have no country recorded and are excluded from the concentration test.`);
  }
  return { byCountry, flagged, threshold, reasons };
}

export function assessSupplyChain(input: SupplyChainRiskInput): SupplyChainRiskResult {
  const threshold = input.concentrationThreshold ?? 0.5;
  const concentration = countryConcentration(input.nodes, threshold);
  const flaggedCountries = new Set(concentration.flagged.map((b) => b.country));

  const financialsByVendor = new Map<string, RiskFinancials>();
  for (const f of input.financials) {
    const existing = financialsByVendor.get(f.vendorId);
    if (!existing || f.financialYearEnd > existing.financialYearEnd) financialsByVendor.set(f.vendorId, f);
  }
  const prequalByVendor = new Map<string, RiskPrequal[]>();
  for (const p of input.prequals) {
    const list = prequalByVendor.get(p.vendorId) ?? [];
    list.push(p);
    prequalByVendor.set(p.vendorId, list);
  }
  const entityById = new Map(input.entities.map((e) => [e.id, e]));

  // For each downstream node+category, how many upstream sources exist?
  const sourcesByTarget = new Map<string, Set<string>>();
  for (const l of input.links) {
    const key = `${l.toNodeId}|${l.category ?? "*"}`;
    const set = sourcesByTarget.get(key) ?? new Set<string>();
    set.add(l.fromNodeId);
    sourcesByTarget.set(key, set);
  }
  const outgoingByNode = new Map<string, RiskLink[]>();
  for (const l of input.links) {
    const list = outgoingByNode.get(l.fromNodeId) ?? [];
    list.push(l);
    outgoingByNode.set(l.fromNodeId, list);
  }
  const itemsByNode = new Map<string, RiskItemContext[]>();
  for (const it of input.items) {
    if (!it.supplierNodeId) continue;
    const list = itemsByNode.get(it.supplierNodeId) ?? [];
    list.push(it);
    itemsByNode.set(it.supplierNodeId, list);
  }

  const assessments: NodeRiskAssessment[] = [];
  for (const node of input.nodes) {
    const flags: RiskFlagRecord[] = [];
    const inputs: Record<string, unknown> = {
      tier: node.tier,
      country: node.country,
      criticality: node.criticality,
      vendorId: node.vendorId,
      entityId: node.entityId,
    };
    let evidence = 0; // count of information sources consulted

    /* single source */
    const outgoing = outgoingByNode.get(node.id) ?? [];
    if (outgoing.length > 0) evidence += 1;
    for (const l of outgoing) {
      const key = `${l.toNodeId}|${l.category ?? "*"}`;
      const sources = sourcesByTarget.get(key)?.size ?? 1;
      if (l.isSoleSource || sources === 1) {
        const important = node.criticality === "critical" || node.criticality === "high";
        flags.push(
          flag(
            "single_source",
            important ? "high" : "medium",
            `${node.name} is the only source of ${l.category ?? l.kind} for its customer on the map${l.isSoleSource ? " (declared sole source)" : ""}.`,
            l.isSoleSource ? "link declared sole source by the buyer" : `one upstream link for this flow (${sources} source)`,
          ),
        );
        break;
      }
    }

    /* concentration */
    if (node.country && flaggedCountries.has(node.country) && (node.criticality === "critical" || node.criticality === "high")) {
      const bucket = concentration.flagged.find((b) => b.country === node.country);
      flags.push(
        flag(
          "country_concentration",
          "medium",
          `${Math.round((bucket?.share ?? 0) * 100)}% of critical/high supply sits in ${node.country}.`,
          `${bucket?.criticalNodes ?? 0} of the critical/high nodes are in ${node.country}; threshold ${Math.round(threshold * 100)}%`,
        ),
      );
    }

    /* financials */
    const fin = node.vendorId ? financialsByVendor.get(node.vendorId) : undefined;
    if (fin) {
      evidence += 1;
      inputs["financialYearEnd"] = fin.financialYearEnd;
      inputs["currentRatio"] = fin.currentRatio;
      inputs["netAssets"] = fin.netAssets;
      if (fin.isGoingConcernQualified) {
        flags.push(flag("going_concern", "critical", "Auditor's going-concern qualification on the latest accounts.", `prequalification financials FYE ${fin.financialYearEnd}`));
      }
      if (fin.insolvencyEvents > 0) {
        flags.push(flag("financial_distress", "critical", `${fin.insolvencyEvents} insolvency event(s) recorded (administration, CVA, winding-up petition).`, `prequalification financials FYE ${fin.financialYearEnd}`));
      }
      if (fin.currentRatio !== null && fin.currentRatio < 1) {
        flags.push(flag("financial_distress", "high", `Current ratio ${fin.currentRatio.toFixed(2)} — current liabilities exceed current assets.`, `prequalification financials FYE ${fin.financialYearEnd}`));
      }
      if (fin.netAssets !== null && fin.netAssets < 0) {
        flags.push(flag("financial_distress", "high", `Negative net assets (${fin.netAssets}).`, `prequalification financials FYE ${fin.financialYearEnd}`));
      }
      if (fin.gearingPercent !== null && fin.gearingPercent > 100) {
        flags.push(flag("financial_distress", "medium", `Gearing ${fin.gearingPercent.toFixed(0)}%.`, `prequalification financials FYE ${fin.financialYearEnd}`));
      }
      if (fin.ccjCount !== null && fin.ccjCount > 0) {
        flags.push(flag("financial_distress", "medium", `${fin.ccjCount} county court judgment(s).`, `prequalification financials FYE ${fin.financialYearEnd}`));
      }
    } else if (node.vendorId && node.tier === 1) {
      flags.push(flag("financial_distress", "info", "No financial figures held for a tier-1 supplier; distress cannot be tested.", "no prequalification_financials row for the vendor"));
    }

    /* prequalification */
    const prequals = node.vendorId ? (prequalByVendor.get(node.vendorId) ?? []) : [];
    if (node.vendorId) {
      if (prequals.length === 0) {
        if (node.tier === 1) flags.push(flag("prequal_missing", "low", "Tier-1 supplier with no prequalification on record.", "no prequalification_submissions row for the vendor"));
      } else {
        evidence += 1;
        const latest = [...prequals].sort((a, b) => (b.expiresAt ?? "").localeCompare(a.expiresAt ?? ""))[0]!;
        inputs["prequalOutcome"] = latest.outcome;
        if (latest.outcome === "rejected") {
          flags.push(flag("prequal_rejected", "high", "Latest prequalification was rejected.", `prequalification outcome ${latest.outcome}`));
        } else if (latest.expiresAt && latest.expiresAt < input.today) {
          flags.push(flag("prequal_missing", "medium", `Prequalification expired on ${latest.expiresAt}.`, `prequalification expiresAt ${latest.expiresAt}`));
        }
      }
    }

    /* sanctions via the assurance entity */
    const entity = node.entityId ? entityById.get(node.entityId) : undefined;
    if (entity) {
      evidence += 1;
      inputs["screeningStatus"] = entity.screeningStatus;
      const status = entity.screeningStatus ?? "pending";
      if (status === "sanctions_hit" || status === "debarred") {
        flags.push(flag("sanctions_hit", "critical", `Screening status is ${status}.`, `entities.screeningStatus (screened ${entity.screenedAt ?? "date unknown"})`));
      } else if (status === "pep") {
        flags.push(flag("sanctions_unscreened", "medium", "Politically exposed person association on the screened entity.", "entities.screeningStatus = pep"));
      } else if (status !== "clear") {
        flags.push(flag("sanctions_unscreened", "low", "Entity exists but screening is pending.", "entities.screeningStatus not clear"));
      }
    } else if (node.criticality === "critical" || node.criticality === "high") {
      flags.push(flag("sanctions_unscreened", "low", "No screened entity linked; sanctions screening has not been done through the platform.", "supply_chain_nodes.entityId is null"));
    }

    /* visibility gap */
    if (node.tier >= 2 && outgoing.length === 0) {
      flags.push(flag("tier_visibility_gap", "low", `Tier ${node.tier} node with no downstream link: the map does not say who it supplies.`, "no supply_chain_links from this node"));
    }

    /* critical path and expediting */
    const items = itemsByNode.get(node.id) ?? [];
    if (items.length > 0) evidence += 1;
    const criticalItems = items.filter((i) => i.taskIsCritical && i.status !== "installed" && i.status !== "cancelled");
    if (criticalItems.length > 0) {
      const late = criticalItems.filter((i) => i.riskLevel === "late" || i.riskLevel === "at_risk").length;
      flags.push(
        flag(
          "critical_path_exposure",
          late > 0 ? "high" : "low",
          `${criticalItems.length} long-lead item(s) from this node feed critical-path tasks${late > 0 ? `; ${late} at risk or late` : ""}.`,
          "long_lead_items.scheduleTaskId → schedule_tasks.isCritical",
        ),
      );
    }
    const stale = items.filter((i) => i.expeditingStale).length;
    if (stale > 0) {
      flags.push(flag("expediting_backlog", "medium", `${stale} ordered item(s) not expedited in the last 14 days.`, "long_lead_items.lastExpeditedAt"));
    }

    const assessable = evidence > 0 || flags.some((f) => f.severity !== "info");
    const score = assessable ? Math.min(100, flags.reduce((s, f) => s + f.points, 0)) : null;
    // A critical flag (sanctions hit, going-concern qualification, insolvency
    // event) is a hard stop, not a contribution to a score.
    const hardStop = flags.some((f) => f.severity === "critical");
    const level: SupplierRiskLevel =
      score === null ? "not_assessable" : hardStop ? "critical" : levelForScore(score);
    const basis = assessable
      ? `${evidence} information source(s) consulted: ${[
          outgoing.length > 0 ? "map links" : null,
          fin ? "prequalification financials" : null,
          prequals.length > 0 ? "prequalification outcome" : null,
          entity ? "entity screening" : null,
          items.length > 0 ? "long-lead items" : null,
        ]
          .filter(Boolean)
          .join(", ")}. Score is the sum of flag points (info 0, low 5, medium 15, high 30, critical 50), capped at 100.`
      : "Nothing to read: no links, financials, prequalification, screened entity or long-lead items for this node.";

    assessments.push({ nodeId: node.id, vendorId: node.vendorId, score, level, flags, inputs, basis });
  }

  const summary: Record<SupplierRiskLevel, number> = { low: 0, medium: 0, high: 0, critical: 0, not_assessable: 0 };
  for (const a of assessments) summary[a.level] += 1;

  return { assessments, concentration, summary };
}
