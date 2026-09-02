import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  changeEvents,
  changeLineItems,
  changeOrderPackages,
  changeOrderRequests,
  changeStatusHistory,
  potentialChangeOrders,
  vendors,
} from "@constructos/db";
import { round2 } from "./arithmetic.js";
import { changeGates, companyOf, projectOf, todayIso } from "./shared.js";

/**
 * CHANGE ANALYTICS (spec #560–562): ageing, cycle time and pass-down leaks.
 *
 * Every status transition on the chain is materialised into
 * `change_status_history` by the module's ledger helper (shared.ts), so these
 * figures are computed from dated facts rather than inferred from
 * `updatedAt`. Where a record predates the history table its creation date is
 * the only anchor and the row says so (`anchoredOn: "createdAt"`).
 *
 *   /change-log/ageing      days in current status per live PCO / COR /
 *                           package, bucketed 0–7 / 8–30 / 31–60 / 60+, with
 *                           money at risk per bucket per currency
 *   /change-log/cycle-time  median and p90 days between stages
 *                           (identified → priced → submitted → decided →
 *                           executed), by reason and by vendor
 *   /change-log/pass-down   executed owner packages whose subcontract cost
 *                           was never passed down, and the inverse
 */

const DAY = 86_400_000;
const BUCKETS = ["0-7", "8-30", "31-60", "60+"] as const;
type Bucket = (typeof BUCKETS)[number];

export function bucketOf(days: number): Bucket {
  if (days <= 7) return "0-7";
  if (days <= 30) return "8-30";
  if (days <= 60) return "31-60";
  return "60+";
}

export const daysBetween = (fromIso: string, toIso: string): number =>
  Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / DAY));

/** Pure: the p-th percentile of a sorted numeric sample (nearest-rank). */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? null;
}

export function median(values: readonly number[]): number | null {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : round2(((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}

/** The stage a status belongs to, per object type — the vocabulary the cycle-time report uses. */
export type Stage = "identified" | "priced" | "submitted" | "decided" | "executed";

export function stageOfStatus(objectType: string, status: string): Stage | null {
  if (objectType === "potential_change_order") {
    if (["priced"].includes(status)) return "priced";
    if (status === "submitted") return "submitted";
    if (["approved", "rejected", "no_charge"].includes(status)) return "decided";
    return null;
  }
  if (objectType === "change_order_request") {
    if (status === "submitted") return "submitted";
    if (["approved", "partially_approved", "rejected"].includes(status)) return "decided";
    return null;
  }
  if (objectType === "change_order_package") {
    if (status === "executed") return "executed";
    return null;
  }
  return null;
}

export interface HistoryPoint {
  objectType: string;
  objectId: string;
  toStatus: string;
  at: string;
}

/**
 * Pure: for one PCO (with its COR and package history), the dated stage
 * reachings. `identified` is the PCO's creation; later stages take the
 * EARLIEST time the stage was reached across the chain.
 */
export function stageTimeline(
  createdAt: string,
  points: readonly HistoryPoint[],
): Partial<Record<Stage, string>> {
  const out: Partial<Record<Stage, string>> = { identified: createdAt };
  for (const p of points) {
    const stage = stageOfStatus(p.objectType, p.toStatus);
    if (!stage) continue;
    const prev = out[stage];
    if (!prev || p.at < prev) out[stage] = p.at;
  }
  return out;
}

const STAGE_PAIRS: Array<[Stage, Stage]> = [
  ["identified", "priced"],
  ["priced", "submitted"],
  ["submitted", "decided"],
  ["decided", "executed"],
  ["identified", "executed"],
];

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  const gates = changeGates(app);

  /** Latest transition per object on the project, from the history table. */
  async function lastTransitions(projectId: string, objectType: string): Promise<Map<string, { at: string; toStatus: string }>> {
    const rows = await app.db
      .select({ objectId: changeStatusHistory.objectId, toStatus: changeStatusHistory.toStatus, at: changeStatusHistory.at })
      .from(changeStatusHistory)
      .where(and(eq(changeStatusHistory.projectId, projectId), eq(changeStatusHistory.objectType, objectType)))
      .orderBy(asc(changeStatusHistory.at));
    const map = new Map<string, { at: string; toStatus: string }>();
    for (const r of rows) map.set(r.objectId, { at: r.at, toStatus: r.toStatus });
    return map;
  }

  /**
   * HEALTH INPUTS (plan §3.5) for the intelligence layer's `commercial`
   * dimension. The chain leaks in the gaps — exposure identified and never
   * priced, priced and never asked for, asked for and never executed — so the
   * counts here are the gaps, not the totals. No money crosses a currency.
   */
  app.get("/projects/:projectId/changes/health-inputs", { preHandler: gates.read }, async (req) => {
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const [events, pcos, cors, packages] = await Promise.all([
      app.db
        .select({ status: changeEvents.status })
        .from(changeEvents)
        .where(and(eq(changeEvents.companyId, companyId), eq(changeEvents.projectId, projectId))),
      app.db
        .select({ status: potentialChangeOrders.status, corId: potentialChangeOrders.changeOrderRequestId })
        .from(potentialChangeOrders)
        .where(
          and(
            eq(potentialChangeOrders.companyId, companyId),
            eq(potentialChangeOrders.projectId, projectId),
          ),
        ),
      app.db
        .select({ status: changeOrderRequests.status })
        .from(changeOrderRequests)
        .where(
          and(
            eq(changeOrderRequests.companyId, companyId),
            eq(changeOrderRequests.projectId, projectId),
          ),
        ),
      app.db
        .select({ status: changeOrderPackages.status })
        .from(changeOrderPackages)
        .where(
          and(
            eq(changeOrderPackages.companyId, companyId),
            eq(changeOrderPackages.projectId, projectId),
          ),
        ),
    ]);
    const reasons: string[] = [];
    if (events.length === 0 && pcos.length === 0) {
      reasons.push("No change has been raised on this project, so the commercial dimension is unrated.");
    }
    return {
      projectId,
      asOf: todayIso(),
      metrics: {
        openChangeEvents: events.filter((e) => e.status === "open").length,
        unpricedPcos: pcos.filter((p) => ["draft", "pending_quote"].includes(p.status)).length,
        pricedNotRequested: pcos.filter((p) => p.status === "priced" && p.corId === null).length,
        awaitingOwnerDecision: cors.filter((c) =>
          ["submitted", "under_review", "negotiating"].includes(c.status),
        ).length,
        rejectedRequests: cors.filter((c) => c.status === "rejected").length,
        approvedNotExecuted: packages.filter((p) => p.status === "approved").length,
      },
      reasons,
    };
  });

  app.get("/projects/:projectId/change-log/ageing", { preHandler: gates.read }, async (req) => {
    const q = z.object({ asOf: z.string().optional() }).parse(req.query ?? {});
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const asOf = q.asOf && !Number.isNaN(Date.parse(q.asOf)) ? new Date(q.asOf).toISOString() : new Date().toISOString();

    const [pcos, cors, packages, lastPco, lastCor, lastPkg] = await Promise.all([
      app.db.select().from(potentialChangeOrders).where(and(eq(potentialChangeOrders.companyId, companyId), eq(potentialChangeOrders.projectId, projectId))),
      app.db.select().from(changeOrderRequests).where(and(eq(changeOrderRequests.companyId, companyId), eq(changeOrderRequests.projectId, projectId))),
      app.db.select().from(changeOrderPackages).where(and(eq(changeOrderPackages.companyId, companyId), eq(changeOrderPackages.projectId, projectId))),
      lastTransitions(projectId, "potential_change_order"),
      lastTransitions(projectId, "change_order_request"),
      lastTransitions(projectId, "change_order_package"),
    ]);

    type Row = {
      objectType: "potential_change_order" | "change_order_request" | "change_order_package";
      id: string;
      reference: string;
      title: string;
      status: string;
      amount: number;
      currency: string | null;
      vendorId: string | null;
      sinceAt: string;
      anchoredOn: "history" | "createdAt";
      daysInStatus: number;
      bucket: Bucket;
    };
    const terminal = new Set(["executed", "void", "withdrawn", "rejected", "no_charge", "closed"]);
    const rows: Row[] = [];
    const push = (
      objectType: Row["objectType"],
      r: { id: string; reference: string; title: string; status: string; amount: number; vendorId?: string | null; createdAt: string; updatedAt: string },
      last: Map<string, { at: string; toStatus: string }>,
      currency: string | null,
    ) => {
      if (terminal.has(r.status)) return;
      const h = last.get(r.id);
      const anchored = h && h.toStatus === r.status ? "history" : "createdAt";
      const sinceAt = anchored === "history" ? h!.at : r.createdAt;
      const days = daysBetween(sinceAt, asOf);
      rows.push({
        objectType,
        id: r.id,
        reference: r.reference,
        title: r.title,
        status: r.status,
        amount: round2(r.amount),
        currency,
        vendorId: r.vendorId ?? null,
        sinceAt,
        anchoredOn: anchored,
        daysInStatus: days,
        bucket: bucketOf(days),
      });
    };
    for (const p of pcos) push("potential_change_order", p, lastPco, null);
    for (const c of cors) push("change_order_request", c, lastCor, null);
    for (const p of packages) push("change_order_package", p, lastPkg, null);
    rows.sort((a, b) => b.daysInStatus - a.daysInStatus);

    /*
     * Money at risk per bucket is bucketed by object type rather than
     * currency-summed: a PCO carries the commitment's currency and a COR the
     * contract's, and the two are not the same number.
     */
    const buckets = BUCKETS.map((b) => {
      const inBucket = rows.filter((r) => r.bucket === b);
      return {
        bucket: b,
        count: inBucket.length,
        byType: (["potential_change_order", "change_order_request", "change_order_package"] as const).map((t) => ({
          objectType: t,
          count: inBucket.filter((r) => r.objectType === t).length,
          amount: round2(inBucket.filter((r) => r.objectType === t).reduce((s, r) => s + r.amount, 0)),
        })),
      };
    });
    return {
      projectId,
      asOf,
      items: rows,
      buckets,
      oldest: rows[0] ?? null,
      note:
        rows.some((r) => r.anchoredOn === "createdAt")
          ? "Some rows predate the status history and are aged from their creation date."
          : null,
    };
  });

  app.get("/projects/:projectId/change-log/cycle-time", { preHandler: gates.read }, async (req) => {
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const [pcos, cors, packages, history] = await Promise.all([
      app.db.select().from(potentialChangeOrders).where(and(eq(potentialChangeOrders.companyId, companyId), eq(potentialChangeOrders.projectId, projectId))),
      app.db.select().from(changeOrderRequests).where(and(eq(changeOrderRequests.companyId, companyId), eq(changeOrderRequests.projectId, projectId))),
      app.db.select().from(changeOrderPackages).where(and(eq(changeOrderPackages.companyId, companyId), eq(changeOrderPackages.projectId, projectId))),
      app.db
        .select({ objectType: changeStatusHistory.objectType, objectId: changeStatusHistory.objectId, toStatus: changeStatusHistory.toStatus, at: changeStatusHistory.at })
        .from(changeStatusHistory)
        .where(eq(changeStatusHistory.projectId, projectId))
        .orderBy(asc(changeStatusHistory.at)),
    ]);
    const byObject = new Map<string, HistoryPoint[]>();
    for (const h of history) {
      const list = byObject.get(h.objectId) ?? [];
      list.push(h);
      byObject.set(h.objectId, list);
    }
    const corById = new Map(cors.map((c) => [c.id, c]));
    const pkgById = new Map(packages.map((p) => [p.id, p]));
    const vendorIds = [...new Set(pcos.map((p) => p.vendorId).filter((v): v is string => !!v))];
    const vendorRows = vendorIds.length ? await app.db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(inArray(vendors.id, vendorIds)) : [];
    const vendorName = new Map(vendorRows.map((v) => [v.id, v.name]));

    const perPco = pcos
      .filter((p) => p.status !== "void")
      .map((p) => {
        const points: HistoryPoint[] = [...(byObject.get(p.id) ?? [])];
        const cor = p.changeOrderRequestId ? corById.get(p.changeOrderRequestId) : undefined;
        if (cor) points.push(...(byObject.get(cor.id) ?? []));
        const pkgId = p.changeOrderPackageId ?? cor?.changeOrderPackageId ?? null;
        const pkg = pkgId ? pkgById.get(pkgId) : undefined;
        if (pkg) points.push(...(byObject.get(pkg.id) ?? []));
        const timeline = stageTimeline(p.createdAt, points);
        const durations: Partial<Record<string, number>> = {};
        for (const [from, to] of STAGE_PAIRS) {
          const a = timeline[from];
          const b = timeline[to];
          if (a && b) durations[`${from}_to_${to}`] = daysBetween(a, b);
        }
        return { id: p.id, reference: p.reference, reason: p.reason, vendorId: p.vendorId, vendorName: p.vendorId ? (vendorName.get(p.vendorId) ?? null) : null, timeline, durations };
      });

    const summarise = (rows: typeof perPco) =>
      STAGE_PAIRS.map(([from, to]) => {
        const key = `${from}_to_${to}`;
        const sample = rows.map((r) => r.durations[key]).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
        return {
          from,
          to,
          n: sample.length,
          medianDays: median(sample),
          p90Days: percentile(sample, 90),
          maxDays: sample.length ? sample[sample.length - 1] : null,
          reasons: sample.length === 0 ? [`No PCO on this project has both reached "${from}" and "${to}" with a dated transition.`] : [],
        };
      });
    const groupBy = <K extends string>(key: (r: (typeof perPco)[number]) => K | null) => {
      const groups = new Map<K, typeof perPco>();
      for (const r of perPco) {
        const k = key(r);
        if (!k) continue;
        const list = groups.get(k) ?? [];
        list.push(r);
        groups.set(k, list);
      }
      return [...groups.entries()].map(([k, rows]) => ({ key: k, n: rows.length, stages: summarise(rows) }));
    };
    return {
      projectId,
      asOf: todayIso(),
      pcos: perPco.length,
      overall: summarise(perPco),
      byReason: groupBy((r) => (r.reason as string | null) ?? null),
      byVendor: groupBy((r) => (r.vendorName ?? r.vendorId) as string | null).map((g) => ({ ...g, vendorName: g.key })),
      note: history.length === 0 ? "No status history has been recorded yet; cycle times need dated transitions and will fill in as changes move." : null,
    };
  });

  /**
   * PASS-DOWN LEAK DETECTOR. "Revenue up, cost not passed down": an executed
   * prime package whose member CORs carry subcontract-coded PCOs that never
   * reached an executed commitment package. And the inverse: cost executed
   * on a subcontract with no owner package covering it.
   */
  app.get("/projects/:projectId/change-log/pass-down", { preHandler: gates.read }, async (req) => {
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const [pcos, cors, packages] = await Promise.all([
      app.db.select().from(potentialChangeOrders).where(and(eq(potentialChangeOrders.companyId, companyId), eq(potentialChangeOrders.projectId, projectId))),
      app.db.select().from(changeOrderRequests).where(and(eq(changeOrderRequests.companyId, companyId), eq(changeOrderRequests.projectId, projectId))),
      app.db.select().from(changeOrderPackages).where(and(eq(changeOrderPackages.companyId, companyId), eq(changeOrderPackages.projectId, projectId))),
    ]);
    const pcoIds = pcos.map((p) => p.id);
    const lines = pcoIds.length
      ? await app.db
          .select({ parentId: changeLineItems.parentId, costType: changeLineItems.costType, amount: changeLineItems.costAmount })
          .from(changeLineItems)
          .where(and(eq(changeLineItems.parentType, "potential_change_order"), inArray(changeLineItems.parentId, pcoIds)))
      : [];
    const subcontractCostBy = new Map<string, number>();
    for (const l of lines) {
      if (l.costType !== "subcontract") continue;
      subcontractCostBy.set(l.parentId, round2((subcontractCostBy.get(l.parentId) ?? 0) + l.amount));
    }
    const pcoById = new Map(pcos.map((p) => [p.id, p]));
    const corById = new Map(cors.map((c) => [c.id, c]));
    const executedCommitmentPkgByPco = new Map<string, (typeof packages)[number]>();
    for (const pkg of packages) {
      if (pkg.kind !== "commitment" || pkg.status !== "executed") continue;
      for (const id of pkg.memberIds) executedCommitmentPkgByPco.set(id, pkg);
    }
    const today = todayIso();
    const revenueUpCostNotDown: Array<Record<string, unknown>> = [];
    for (const pkg of packages) {
      if (pkg.kind !== "prime_contract" || pkg.status !== "executed") continue;
      for (const corId of pkg.memberIds) {
        const cor = corById.get(corId);
        if (!cor) continue;
        for (const pcoId of cor.pcoIds) {
          const pco = pcoById.get(pcoId);
          if (!pco) continue;
          const subCost = subcontractCostBy.get(pco.id) ?? (pco.commitmentId ? pco.amount : 0);
          if (subCost <= 0.005) continue;
          if (executedCommitmentPkgByPco.has(pco.id)) continue;
          revenueUpCostNotDown.push({
            primePackageId: pkg.id,
            primePackageReference: pkg.reference,
            executedAt: pkg.executedAt,
            corId: cor.id,
            corReference: cor.reference,
            pcoId: pco.id,
            pcoReference: pco.reference,
            pcoStatus: pco.status,
            commitmentId: pco.commitmentId,
            vendorId: pco.vendorId,
            subcontractCost: round2(subCost),
            ageingDays: pkg.executedAt ? daysBetween(pkg.executedAt, `${today}T00:00:00Z`) : null,
          });
        }
      }
    }
    const executedPrimePkgByCor = new Map<string, (typeof packages)[number]>();
    for (const pkg of packages) {
      if (pkg.kind !== "prime_contract" || pkg.status !== "executed") continue;
      for (const id of pkg.memberIds) executedPrimePkgByCor.set(id, pkg);
    }
    const costDownNeverBilled: Array<Record<string, unknown>> = [];
    for (const pkg of packages) {
      if (pkg.kind !== "commitment" || pkg.status !== "executed") continue;
      for (const pcoId of pkg.memberIds) {
        const pco = pcoById.get(pcoId);
        if (!pco) continue;
        const cor = pco.changeOrderRequestId ? corById.get(pco.changeOrderRequestId) : undefined;
        const billed = cor ? executedPrimePkgByCor.has(cor.id) : false;
        if (billed) continue;
        costDownNeverBilled.push({
          commitmentPackageId: pkg.id,
          commitmentPackageReference: pkg.reference,
          executedAt: pkg.executedAt,
          pcoId: pco.id,
          pcoReference: pco.reference,
          corId: cor?.id ?? null,
          corReference: cor?.reference ?? null,
          corStatus: cor?.status ?? null,
          amount: round2(pco.amount),
          ageingDays: pkg.executedAt ? daysBetween(pkg.executedAt, `${today}T00:00:00Z`) : null,
          reason: !cor
            ? "The PCO was never rolled into an owner change order request."
            : `The owner request ${cor.reference} is ${cor.status} and has not been executed as a package.`,
        });
      }
    }
    return {
      projectId,
      asOf: today,
      revenueUpCostNotDown,
      costDownNeverBilled,
      summary: {
        revenueUpCostNotDown: revenueUpCostNotDown.length,
        costDownNeverBilled: costDownNeverBilled.length,
        /** by design no money total: PCOs may sit on commitments in different currencies */
        note: "Amounts are listed per row in the commitment's own currency and never summed across rows.",
      },
    };
  });
};
