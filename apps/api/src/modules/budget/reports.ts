/**
 * BUDGET REPORTS — budget vs actual variance (spec #497), grouped, with the
 * movement since the last capture. Pure functions over stored rows.
 */
import { groupBy, round2, round4, type BudgetTotals, type RollupLine, type SnapshotLine } from "./calc.js";

export interface VarianceLineInput extends RollupLine {
  id: string;
  costCode: string;
  costType: string;
  description: string;
  lineKind: string;
  subJob: string | null;
  wbsPath: string | null;
}

export type VarianceGroupBy = "cost_code" | "cost_type" | "division" | "line_kind" | "sub_job";

export interface VarianceGroup {
  key: string;
  label: string;
  lineCount: number;
  originalBudget: number;
  revisedBudget: number;
  committed: number;
  pendingCommitments: number;
  jobToDateCosts: number;
  forecastFinal: number;
  /** revised − forecastFinal; negative is an overrun */
  variance: number;
  /** variance ÷ revised, null when there is no revised budget */
  variancePct: number | null;
  /** jobToDate ÷ revised */
  spentPct: number | null;
  /** committed + pending ÷ revised */
  obligatedPct: number | null;
  /** movement since the previous capture, when one was supplied */
  movement: { revisedBudget: number; jobToDateCosts: number; forecastFinal: number; variance: number } | null;
  lines: Array<{ id: string; costCode: string; costType: string; description: string; revisedBudget: number; jobToDateCosts: number; forecastFinal: number; variance: number }>;
}

export interface VarianceReport {
  by: VarianceGroupBy;
  groups: VarianceGroup[];
  totals: BudgetTotals & { variancePct: number | null; spentPct: number | null };
  worst: Array<{ id: string; costCode: string; description: string; variance: number; variancePct: number | null }>;
  comparedWith: { snapshotId: string; reference: string; asOfDate: string } | null;
}

const divisionOf = (l: VarianceLineInput): string => {
  const head = (l.wbsPath ?? "").split("/").filter(Boolean)[0];
  if (head) return head;
  return l.costCode.split(/[.\-/]/)[0] ?? l.costCode;
};

export function varianceReport(
  lines: readonly VarianceLineInput[],
  by: VarianceGroupBy,
  previous: { snapshotId: string; reference: string; asOfDate: string; lines: SnapshotLine[] } | null,
): VarianceReport {
  const keyOf = (l: VarianceLineInput): { key: string; label: string } => {
    switch (by) {
      case "cost_type":
        return { key: l.costType, label: l.costType };
      case "division":
        return { key: divisionOf(l), label: divisionOf(l) };
      case "line_kind":
        return { key: l.lineKind, label: l.lineKind };
      case "sub_job":
        return { key: l.subJob ?? "", label: l.subJob ?? "(no sub job)" };
      default:
        return { key: l.costCode, label: l.costCode };
    }
  };
  const prevByKey = new Map<string, SnapshotLine>();
  for (const p of previous?.lines ?? []) prevByKey.set(`${p.costCode} ${p.costType}`, p);
  const groups = groupBy(lines, keyOf).map((g): VarianceGroup => {
    const t = g.totals;
    const revised = t.revisedBudgetTotal;
    const obligated = round2(t.committedTotal + t.pendingCommitmentsTotal);
    let movement: VarianceGroup["movement"] = null;
    if (previous) {
      const prevRows = (g.lines ?? []).map((l) => prevByKey.get(`${l.costCode} ${l.costType}`)).filter((p): p is SnapshotLine => Boolean(p));
      const prevRevised = round2(prevRows.reduce((s, p) => s + p.revisedBudget, 0));
      const prevJtd = round2(prevRows.reduce((s, p) => s + p.jobToDateCosts, 0));
      const prevFinal = round2(prevRows.reduce((s, p) => s + p.forecastFinal, 0));
      movement = {
        revisedBudget: round2(revised - prevRevised),
        jobToDateCosts: round2(t.jobToDateCostsTotal - prevJtd),
        forecastFinal: round2(t.forecastFinalTotal - prevFinal),
        variance: round2(t.varianceTotal - round2(prevRevised - prevFinal)),
      };
    }
    return {
      key: g.key,
      label: g.label,
      lineCount: g.lineCount,
      originalBudget: t.originalBudgetTotal,
      revisedBudget: revised,
      committed: t.committedTotal,
      pendingCommitments: t.pendingCommitmentsTotal,
      jobToDateCosts: t.jobToDateCostsTotal,
      forecastFinal: t.forecastFinalTotal,
      variance: t.varianceTotal,
      variancePct: revised > 0 ? round4(t.varianceTotal / revised) : null,
      spentPct: revised > 0 ? round4(t.jobToDateCostsTotal / revised) : null,
      obligatedPct: revised > 0 ? round4(obligated / revised) : null,
      movement,
      lines: (g.lines ?? []).map((l) => ({ id: l.id, costCode: l.costCode, costType: l.costType, description: l.description, revisedBudget: l.revisedBudget, jobToDateCosts: l.jobToDateCosts, forecastFinal: l.forecastFinal, variance: l.projectedOverUnder })),
    };
  });
  const totals = groups.reduce(
    (acc, g) => {
      acc.originalBudgetTotal = round2(acc.originalBudgetTotal + g.originalBudget);
      acc.revisedBudgetTotal = round2(acc.revisedBudgetTotal + g.revisedBudget);
      acc.committedTotal = round2(acc.committedTotal + g.committed);
      acc.pendingCommitmentsTotal = round2(acc.pendingCommitmentsTotal + g.pendingCommitments);
      acc.jobToDateCostsTotal = round2(acc.jobToDateCostsTotal + g.jobToDateCosts);
      acc.forecastFinalTotal = round2(acc.forecastFinalTotal + g.forecastFinal);
      acc.varianceTotal = round2(acc.varianceTotal + g.variance);
      return acc;
    },
    { originalBudgetTotal: 0, budgetModificationsTotal: 0, approvedChangesTotal: 0, pendingChangesTotal: 0, revisedBudgetTotal: 0, committedTotal: 0, pendingCommitmentsTotal: 0, directCostsTotal: 0, jobToDateCostsTotal: 0, forecastToCompleteTotal: 0, forecastFinalTotal: 0, varianceTotal: 0 },
  );
  for (const l of lines) {
    totals.budgetModificationsTotal = round2(totals.budgetModificationsTotal + l.budgetModifications);
    totals.approvedChangesTotal = round2(totals.approvedChangesTotal + l.approvedChanges);
    totals.pendingChangesTotal = round2(totals.pendingChangesTotal + l.pendingBudgetChanges);
    totals.directCostsTotal = round2(totals.directCostsTotal + l.directCosts);
    totals.forecastToCompleteTotal = round2(totals.forecastToCompleteTotal + l.forecastToComplete);
  }
  const worst = [...lines]
    .filter((l) => l.projectedOverUnder < 0)
    .sort((a, b) => a.projectedOverUnder - b.projectedOverUnder)
    .slice(0, 10)
    .map((l) => ({ id: l.id, costCode: l.costCode, description: l.description, variance: l.projectedOverUnder, variancePct: l.revisedBudget > 0 ? round4(l.projectedOverUnder / l.revisedBudget) : null }));
  return {
    by,
    groups,
    totals: { ...totals, variancePct: totals.revisedBudgetTotal > 0 ? round4(totals.varianceTotal / totals.revisedBudgetTotal) : null, spentPct: totals.revisedBudgetTotal > 0 ? round4(totals.jobToDateCostsTotal / totals.revisedBudgetTotal) : null },
    worst,
    comparedWith: previous ? { snapshotId: previous.snapshotId, reference: previous.reference, asOfDate: previous.asOfDate } : null,
  };
}
