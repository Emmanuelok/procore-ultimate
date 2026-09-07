/**
 * Dispute outcome database and root-cause analytics (spec Vol II Domain E
 * #356-357).
 *
 * WHY THIS EXISTS
 * Every organisation that has fought a dispute knows what it cost. Almost
 * none can say which CLAUSE keeps costing them money, which forum recovers
 * best, or whether the cost of recovery exceeded the recovery. Those are
 * answerable questions once terminal disputes carry structured outcome
 * fields, and the answers are what should change the next contract.
 *
 * HONESTY RULES BAKED IN
 *  - Money is bucketed by currency and never summed across currencies.
 *  - A rate computed from fewer than `MIN_SAMPLE` disputes is returned with
 *    `thin: true` so the UI can refuse to draw a trend line through three
 *    points.
 *  - A dispute missing the field a metric needs is EXCLUDED and counted in
 *    `excluded`, never defaulted to zero.
 */

export const MIN_SAMPLE = 5;

export interface DisputeOutcomeRow {
  id: string;
  projectId: string;
  number: number;
  title: string;
  kind: string;
  forum: string | null;
  status: string;
  jurisdiction: string | null;
  contractFamily: string | null;
  governingClause: string | null;
  rootCause: string | null;
  currency: string;
  amountClaimed: number | null;
  amountAwarded: number | null;
  costsAwarded: number | null;
  /** ISO dates; duration is resolvedAt − notifiedAt */
  notifiedAt: string | null;
  resolvedAt: string | null;
  /** total own costs from the dispute cost ledger, in `currency` */
  ownCosts: number | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export interface GroupMetrics {
  key: string;
  label: string;
  disputes: number;
  /** disputes where amountAwarded > 0, over those with an award recorded */
  winRate: number | null;
  winRateSample: number;
  /** mean awarded / claimed, over disputes carrying both */
  awardRatio: number | null;
  awardRatioSample: number;
  /** mean days from notification to resolution, over disputes carrying both */
  averageDurationDays: number | null;
  durationSample: number;
  /** own costs per unit recovered, per currency; null when nothing recovered */
  costPerUnitRecovered: Array<{ currency: string; ratio: number | null; sample: number }>;
  recoveredByCurrency: Array<{ currency: string; amount: number }>;
  costsByCurrency: Array<{ currency: string; amount: number }>;
  thin: boolean;
}

function metricsFor(key: string, label: string, rows: DisputeOutcomeRow[]): GroupMetrics {
  const withAward = rows.filter((r) => r.amountAwarded !== null);
  const wins = withAward.filter((r) => (r.amountAwarded ?? 0) > 0);
  const withBoth = rows.filter(
    (r) => r.amountAwarded !== null && r.amountClaimed !== null && r.amountClaimed > 0,
  );
  const withDates = rows.filter((r) => r.notifiedAt !== null && r.resolvedAt !== null);

  const recoveredMap = new Map<string, number>();
  const costsMap = new Map<string, number>();
  const costSampleMap = new Map<string, number>();
  for (const r of rows) {
    if (r.amountAwarded !== null) {
      recoveredMap.set(r.currency, (recoveredMap.get(r.currency) ?? 0) + r.amountAwarded);
    }
    if (r.ownCosts !== null) {
      costsMap.set(r.currency, (costsMap.get(r.currency) ?? 0) + r.ownCosts);
      costSampleMap.set(r.currency, (costSampleMap.get(r.currency) ?? 0) + 1);
    }
  }
  const currencies = [...new Set([...recoveredMap.keys(), ...costsMap.keys()])].sort();

  return {
    key,
    label,
    disputes: rows.length,
    winRate: withAward.length === 0 ? null : round4(wins.length / withAward.length),
    winRateSample: withAward.length,
    awardRatio:
      withBoth.length === 0
        ? null
        : round4(
            withBoth.reduce((s, r) => s + r.amountAwarded! / r.amountClaimed!, 0) / withBoth.length,
          ),
    awardRatioSample: withBoth.length,
    averageDurationDays:
      withDates.length === 0
        ? null
        : Math.round(
            withDates.reduce((s, r) => s + daysBetween(r.notifiedAt!, r.resolvedAt!), 0) /
              withDates.length,
          ),
    durationSample: withDates.length,
    costPerUnitRecovered: currencies.map((currency) => {
      const recovered = recoveredMap.get(currency) ?? 0;
      const costs = costsMap.get(currency) ?? 0;
      return {
        currency,
        ratio: recovered > 0 ? round4(costs / recovered) : null,
        sample: costSampleMap.get(currency) ?? 0,
      };
    }),
    recoveredByCurrency: currencies
      .filter((c) => recoveredMap.has(c))
      .map((currency) => ({ currency, amount: round2(recoveredMap.get(currency)!) })),
    costsByCurrency: currencies
      .filter((c) => costsMap.has(c))
      .map((currency) => ({ currency, amount: round2(costsMap.get(currency)!) })),
    thin: rows.length < MIN_SAMPLE,
  };
}

export type GroupBy = "forum" | "kind" | "jurisdiction" | "rootCause" | "contractFamily" | "governingClause";

function groupKey(row: DisputeOutcomeRow, by: GroupBy): string {
  switch (by) {
    case "forum":
      return row.forum ?? "(not recorded)";
    case "kind":
      return row.kind;
    case "jurisdiction":
      return row.jurisdiction ?? "(not recorded)";
    case "rootCause":
      return row.rootCause ?? "(not recorded)";
    case "contractFamily":
      return row.contractFamily ?? "(not recorded)";
    case "governingClause":
      return row.governingClause ?? "(not recorded)";
  }
}

export interface OutcomeAnalytics {
  overall: GroupMetrics;
  groups: GroupMetrics[];
  groupedBy: GroupBy;
  /** disputes excluded because they have not reached a terminal status */
  excludedNotTerminal: number;
  basis: string;
}

const TERMINAL_STATUSES = new Set(["decided", "settled", "withdrawn"]);

/**
 * Aggregate terminal disputes into overall and per-group metrics. Only
 * terminal disputes count: a live dispute has no outcome and including it
 * would drag every rate toward zero.
 */
export function outcomeAnalytics(
  rows: DisputeOutcomeRow[],
  groupedBy: GroupBy = "rootCause",
): OutcomeAnalytics {
  const terminal = rows.filter((r) => TERMINAL_STATUSES.has(r.status));
  const byKey = new Map<string, DisputeOutcomeRow[]>();
  for (const r of terminal) {
    const key = groupKey(r, groupedBy);
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }
  return {
    overall: metricsFor("__all__", "All terminal disputes", terminal),
    groups: [...byKey.entries()]
      .map(([key, group]) => metricsFor(key, key, group))
      .sort((a, b) => b.disputes - a.disputes || (a.key < b.key ? -1 : 1)),
    groupedBy,
    excludedNotTerminal: rows.length - terminal.length,
    basis:
      `Computed over ${terminal.length} terminal dispute(s) (decided, settled or withdrawn). ` +
      `Live disputes are excluded because they have no outcome. Rates are computed only over the ` +
      `disputes carrying the fields they need — the sample size is reported beside each. Money is ` +
      `bucketed by currency and never summed across currencies. Groups with fewer than ` +
      `${MIN_SAMPLE} disputes are flagged as thin.`,
  };
}

/* ------------------------------------------------------------------ */
/* Contract drafting recommendations (#357)                            */
/* ------------------------------------------------------------------ */

export interface DraftingRecommendation {
  /** the clause or root cause the recommendation is about */
  subject: string;
  dimension: "governingClause" | "rootCause" | "contractFamily";
  disputes: number;
  /** ids of the disputes cited — every recommendation is traceable */
  citedDisputeIds: string[];
  averageDurationDays: number | null;
  recoveredByCurrency: Array<{ currency: string; amount: number }>;
  costsByCurrency: Array<{ currency: string; amount: number }>;
  awardRatio: number | null;
  headline: string;
  thin: boolean;
}

/**
 * Turn the outcome database into something the contracts module can show
 * next to a clause: "this clause has been litigated N times, recovering X
 * and costing Y". Every recommendation cites its disputes; nothing is
 * asserted that cannot be clicked through to.
 */
export function draftingRecommendations(
  rows: DisputeOutcomeRow[],
  options: { minDisputes?: number; limit?: number } = {},
): DraftingRecommendation[] {
  const minDisputes = options.minDisputes ?? 2;
  const limit = options.limit ?? 10;
  const out: DraftingRecommendation[] = [];

  for (const dimension of ["governingClause", "rootCause"] as const) {
    const analytics = outcomeAnalytics(rows, dimension);
    for (const group of analytics.groups) {
      if (group.key === "(not recorded)") continue;
      if (group.disputes < minDisputes) continue;
      const cited = rows
        .filter((r) => TERMINAL_STATUSES.has(r.status) && groupKey(r, dimension) === group.key)
        .map((r) => r.id);
      out.push({
        subject: group.key,
        dimension,
        disputes: group.disputes,
        citedDisputeIds: cited,
        averageDurationDays: group.averageDurationDays,
        recoveredByCurrency: group.recoveredByCurrency,
        costsByCurrency: group.costsByCurrency,
        awardRatio: group.awardRatio,
        headline:
          `${group.disputes} terminal dispute(s) turn on ${dimension === "governingClause" ? "clause" : "root cause"} ` +
          `"${group.key}"` +
          (group.averageDurationDays !== null
            ? `, averaging ${group.averageDurationDays} days to resolve`
            : "") +
          (group.costsByCurrency.length > 0
            ? `, costing ${group.costsByCurrency.map((c) => `${c.currency} ${c.amount}`).join(" + ")} to pursue`
            : "") +
          (group.recoveredByCurrency.length > 0
            ? ` and recovering ${group.recoveredByCurrency.map((c) => `${c.currency} ${c.amount}`).join(" + ")}`
            : "") +
          ".",
        thin: group.thin,
      });
    }
  }
  return out.sort((a, b) => b.disputes - a.disputes || (a.subject < b.subject ? -1 : 1)).slice(0, limit);
}
