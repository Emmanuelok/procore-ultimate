/**
 * Benefits dependency network and realisation roll-up (spec Vol II Domain G
 * #418-419, #421-422).
 *
 * WHY A GRAPH
 * A benefits register is a list of promises. A benefits NETWORK says which
 * promises depend on which: "reduced journey time" cannot be realised if
 * "new junction commissioned" was missed, no matter what the journey-time
 * readings say this quarter. Propagating risk along those edges is the
 * difference between a register that reports what has been measured and one
 * that reports what is going to happen.
 *
 * SEMANTICS
 *  - `enables`     — a hard precondition. If the predecessor is `missed`,
 *                    the successor is missed too; if it is `at_risk`, the
 *                    successor is at risk.
 *  - `contributes` — partial. Risk propagates as `at_risk` only; a missed
 *                    contributor does not by itself doom the successor.
 * Propagation NEVER downgrades a benefit that is already worse off, never
 * overrides a measured `realised`, and never invents a status for a benefit
 * with no readings that has no at-risk predecessors either.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not weight contributions or apportion value along edges: nobody
 * has the data to do that honestly, and a made-up weighting would flow
 * straight into a board report.
 */
import type { BenefitDependencyType, BenefitStatus } from "@constructos/shared";

export interface BenefitNode {
  id: string;
  number: number;
  name: string;
  /** status computed from this benefit's OWN readings */
  ownStatus: BenefitStatus;
  targetValue: number;
  baselineValue: number;
  latestValue: number | null;
  targetDate: string | null;
  isDisbenefit: boolean;
}

export interface BenefitEdge {
  fromBenefitId: string;
  toBenefitId: string;
  depType: BenefitDependencyType;
}

export interface PropagatedBenefit {
  id: string;
  /** ownStatus, or a worse status inherited from a predecessor */
  effectiveStatus: BenefitStatus;
  /** true when effectiveStatus differs from ownStatus */
  inherited: boolean;
  /** ids of the predecessors that caused the downgrade */
  causedBy: string[];
  reason: string | null;
}

/** Worse-first ordering used to decide whether propagation applies. */
const SEVERITY: Record<BenefitStatus, number> = {
  realised: 0,
  planned: 1,
  tracking: 2,
  at_risk: 3,
  missed: 4,
};

/** Topological order; nodes in a cycle are appended in id order at the end. */
export function topoOrder(nodes: BenefitNode[], edges: BenefitEdge[]): string[] {
  const ids = new Set(nodes.map((n) => n.id));
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!ids.has(e.fromBenefitId) || !ids.has(e.toBenefitId)) continue;
    out.get(e.fromBenefitId)!.push(e.toBenefitId);
    indegree.set(e.toBenefitId, (indegree.get(e.toBenefitId) ?? 0) + 1);
  }
  const queue = [...nodes]
    .filter((n) => (indegree.get(n.id) ?? 0) === 0)
    .map((n) => n.id)
    .sort();
  const order: string[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const next of (out.get(id) ?? []).sort()) {
      indegree.set(next, (indegree.get(next) ?? 1) - 1);
      if ((indegree.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  for (const n of [...nodes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!seen.has(n.id)) order.push(n.id);
  }
  return order;
}

/** Would adding from → to close a cycle? */
export function wouldCycle(edges: BenefitEdge[], from: string, to: string): boolean {
  if (from === to) return true;
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.fromBenefitId) ?? [];
    list.push(e.toBenefitId);
    adj.set(e.fromBenefitId, list);
  }
  // Reach `from` starting at `to`? Then to → … → from, and from → to closes it.
  const stack = [to];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of adj.get(id) ?? []) stack.push(next);
  }
  return false;
}

/**
 * Propagate at_risk / missed upstream-to-downstream along the network.
 * Returns one entry per node, whether or not anything was inherited.
 */
export function propagateBenefitStatus(
  nodes: BenefitNode[],
  edges: BenefitEdge[],
): PropagatedBenefit[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, BenefitEdge[]>();
  for (const e of edges) {
    if (!byId.has(e.fromBenefitId) || !byId.has(e.toBenefitId)) continue;
    const list = incoming.get(e.toBenefitId) ?? [];
    list.push(e);
    incoming.set(e.toBenefitId, list);
  }
  const effective = new Map<string, BenefitStatus>(nodes.map((n) => [n.id, n.ownStatus]));
  const causes = new Map<string, string[]>();

  for (const id of topoOrder(nodes, edges)) {
    const node = byId.get(id);
    if (!node) continue;
    // A benefit measured as realised is realised. Nothing upstream un-does a
    // measurement that has already been taken.
    if (node.ownStatus === "realised") continue;
    let status = effective.get(id) ?? node.ownStatus;
    const causedBy: string[] = [];
    for (const edge of incoming.get(id) ?? []) {
      const upstream = effective.get(edge.fromBenefitId);
      if (!upstream) continue;
      const candidate: BenefitStatus | null =
        edge.depType === "enables"
          ? upstream === "missed"
            ? "missed"
            : upstream === "at_risk"
              ? "at_risk"
              : null
          : upstream === "missed" || upstream === "at_risk"
            ? "at_risk"
            : null;
      if (candidate && SEVERITY[candidate] > SEVERITY[status]) {
        status = candidate;
        causedBy.length = 0;
        causedBy.push(edge.fromBenefitId);
      } else if (candidate && SEVERITY[candidate] === SEVERITY[status] && status !== node.ownStatus) {
        causedBy.push(edge.fromBenefitId);
      }
    }
    effective.set(id, status);
    if (causedBy.length > 0) causes.set(id, causedBy);
  }

  return nodes.map((n) => {
    const status = effective.get(n.id) ?? n.ownStatus;
    const causedBy = causes.get(n.id) ?? [];
    const inherited = status !== n.ownStatus;
    return {
      id: n.id,
      effectiveStatus: status,
      inherited,
      causedBy,
      reason: inherited
        ? `Own readings put this benefit at "${n.ownStatus}", but ${causedBy.length} dependency(ies) ` +
          `it relies on are at risk or missed — ${causedBy
            .map((c) => {
              const up = byId.get(c);
              return up ? `#${up.number} ${up.name}` : c;
            })
            .join(", ")}.`
        : null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Realisation roll-up (#421-422)                                      */
/* ------------------------------------------------------------------ */

export interface RealisationSeriesPoint {
  date: string;
  /** planned cumulative value at this date, when target dates allow it */
  planned: number | null;
  /** realised cumulative value from the readings taken up to this date */
  realised: number | null;
}

export interface BenefitReadingPoint {
  benefitId: string;
  readingDate: string;
  value: number;
}

/**
 * Planned vs realised value over time, per unit-compatible group.
 *
 * MONEY RULE: benefits carry a `unit`, and units are not commensurable —
 * "£m saved" and "minutes saved per journey" cannot be added. The caller
 * passes ONE unit's benefits at a time; this function does not aggregate
 * across units, and the route reports each unit as its own series.
 *
 * `planned` is the cumulative sum of target values whose target date has
 * arrived by that point; `realised` is the cumulative sum of the latest
 * reading per benefit as at that date. A benefit with no reading yet
 * contributes null, not zero — its absence is the point.
 */
export function realisationSeries(
  nodes: BenefitNode[],
  readings: BenefitReadingPoint[],
  dates: string[],
): RealisationSeriesPoint[] {
  const sortedDates = [...new Set(dates)].sort();
  const byBenefit = new Map<string, BenefitReadingPoint[]>();
  for (const r of readings) {
    const list = byBenefit.get(r.benefitId) ?? [];
    list.push(r);
    byBenefit.set(r.benefitId, list);
  }
  for (const list of byBenefit.values()) list.sort((a, b) => (a.readingDate < b.readingDate ? -1 : 1));

  return sortedDates.map((date) => {
    let planned: number | null = null;
    let realised: number | null = null;
    for (const n of nodes) {
      if (n.targetDate && n.targetDate <= date) {
        planned = (planned ?? 0) + (n.targetValue - n.baselineValue);
      }
      const list = byBenefit.get(n.id) ?? [];
      let latest: number | null = null;
      for (const r of list) {
        if (r.readingDate <= date) latest = r.value;
        else break;
      }
      if (latest !== null) realised = (realised ?? 0) + (latest - n.baselineValue);
    }
    const round2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);
    return { date, planned: round2(planned), realised: round2(realised) };
  });
}
