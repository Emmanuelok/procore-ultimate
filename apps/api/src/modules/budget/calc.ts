import { hashPayload } from "@constructos/ledger";
import type { BudgetChangeKind, CostType, ForecastMethod } from "@constructos/shared";

/**
 * BUDGET ARITHMETIC — pure, dependency-free, unit-tested in isolation.
 *
 * Every number the budget module shows a user is produced HERE and nowhere
 * else. The route layer reads rows, calls into this file, and writes the
 * result back; it never does arithmetic of its own. That is the only way the
 * figure on the budget grid, the figure in the month-end snapshot and the
 * figure in the budget-vs-actual summary are provably the same figure.
 *
 * Three rules govern everything below.
 *
 *  1. NOTHING IS FABRICATED. A computation whose inputs are missing returns
 *     `null` plus a `reasons[]` explaining what was absent — never 0, which a
 *     reader cannot distinguish from "genuinely zero cost". This mirrors the
 *     benchmark metric contract (modules/benchmarks/metrics.ts).
 *  2. NOTHING IS SUMMED ACROSS CURRENCIES. Currency-aware helpers here take
 *     a target currency and report what they excluded rather than silently
 *     adding a euro to a dollar.
 *  3. EVERY TOTAL RECONCILES. `reconcile()` re-derives the identities from
 *     stored rows so a caller (and a test) can assert them rather than trust
 *     them.
 */

/* ------------------------------------------------------------------ */
/* Numeric primitives                                                  */
/* ------------------------------------------------------------------ */

/** Money to 2dp. Every value that leaves this file passes through it. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Percentages to 4dp (0.0001 = one basis point of progress). */
export const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * Half a cent. Two money figures that differ by less than this are the same
 * figure — doublePrecision columns and repeated 2dp rounding make exact
 * equality the wrong test for a balance check.
 */
export const MONEY_EPSILON = 0.005;

export const nearlyEqual = (a: number, b: number, tolerance = MONEY_EPSILON): boolean =>
  Math.abs(a - b) <= tolerance;

const finite = (n: number | null | undefined): number | null =>
  typeof n === "number" && Number.isFinite(n) ? n : null;

/* ------------------------------------------------------------------ */
/* The "no fabricated number" contract                                 */
/* ------------------------------------------------------------------ */

/**
 * A figure the platform either holds the inputs for, or does not. Identical
 * in shape to `MetricComputation` in the benchmarks module so a client
 * renders "—, because …" the same way everywhere.
 */
export interface Component {
  /** null when the inputs are absent — never a fabricated 0 */
  value: number | null;
  /** the exact figures the computation read */
  inputs: Record<string, unknown>;
  /** why `value` is null; empty when a value was computed */
  reasons: string[];
}

export const computed = (value: number, inputs: Record<string, unknown> = {}): Component => ({
  value: round2(value),
  inputs,
  reasons: [],
});

export const unavailable = (
  reasons: string[],
  inputs: Record<string, unknown> = {},
): Component => ({ value: null, inputs, reasons });

/* ------------------------------------------------------------------ */
/* Currency discipline                                                 */
/* ------------------------------------------------------------------ */

export interface CurrencyAmount {
  amount: number;
  currency: string | null | undefined;
}

export interface CurrencySumResult {
  /** null when every candidate row was in a foreign currency, or there were none */
  value: number | null;
  counted: number;
  excluded: number;
  excludedCurrencies: string[];
  reasons: string[];
}

/**
 * Sum only the rows denominated in `currency`. Foreign rows are EXCLUDED and
 * disclosed — never converted at an invented rate and never quietly added.
 * An empty candidate set yields `null`, not `0`: "we hold no commitments"
 * and "we hold commitments worth nothing" are different statements and a cost
 * report that conflates them is lying to its reader.
 */
export function sumInCurrency(
  rows: readonly CurrencyAmount[],
  currency: string,
  label: string,
): CurrencySumResult {
  if (rows.length === 0) {
    return {
      value: null,
      counted: 0,
      excluded: 0,
      excludedCurrencies: [],
      reasons: [`No ${label} recorded on this project.`],
    };
  }
  const foreign = new Set<string>();
  let total = 0;
  let counted = 0;
  let excluded = 0;
  for (const row of rows) {
    const rowCurrency = row.currency ?? currency;
    if (rowCurrency !== currency) {
      excluded += 1;
      foreign.add(rowCurrency);
      continue;
    }
    total += finite(row.amount) ?? 0;
    counted += 1;
  }
  const excludedCurrencies = [...foreign].sort();
  const reasons: string[] = [];
  if (excluded > 0) {
    reasons.push(
      `${excluded} ${label} row(s) denominated in ${excludedCurrencies.join(", ")} were ` +
        `excluded — this budget is kept in ${currency} and figures are never summed across ` +
        "currencies.",
    );
  }
  if (counted === 0) {
    return {
      value: null,
      counted,
      excluded,
      excludedCurrencies,
      reasons: [
        ...reasons,
        `No ${label} in ${currency} on this project — a total would be a fabrication.`,
      ],
    };
  }
  return { value: round2(total), counted, excluded, excludedCurrencies, reasons };
}

/* ------------------------------------------------------------------ */
/* The budget line                                                     */
/* ------------------------------------------------------------------ */

/** The subset of `budget_line_items` the arithmetic actually reads. */
export interface LineAmounts {
  originalBudget: number;
  budgetModifications: number;
  approvedChanges: number;
  pendingBudgetChanges: number;
  committedCost: number;
  pendingCommitments: number;
  directCosts: number;
  jobToDateCosts: number;
  percentComplete: number;
  quantity?: number | null;
  unitRate?: number | null;
}

export const ZERO_LINE: LineAmounts = {
  originalBudget: 0,
  budgetModifications: 0,
  approvedChanges: 0,
  pendingBudgetChanges: 0,
  committedCost: 0,
  pendingCommitments: 0,
  directCosts: 0,
  jobToDateCosts: 0,
  percentComplete: 0,
};

/**
 * revised = original + modifications (approved transfers in/out)
 *                    + approvedChanges (owner-funded increases)
 *
 * `pendingBudgetChanges` is deliberately NOT in it: a pending transfer is an
 * exposure, not budget. Including it is how a project talks itself into
 * spending money nobody has approved.
 */
export const revisedBudgetOf = (l: LineAmounts): number =>
  round2(l.originalBudget + l.budgetModifications + l.approvedChanges);

/** committed + pending commitments — money the project is on the hook for. */
export const obligatedOf = (l: LineAmounts): number =>
  round2(l.committedCost + l.pendingCommitments);

/**
 * Revised budget not yet covered by a commitment or already spent outside
 * one. Floored at zero: a line that is already over-committed has no
 * uncommitted budget left, it has an overrun.
 */
export const uncommittedBudgetOf = (l: LineAmounts): number =>
  round2(Math.max(0, revisedBudgetOf(l) - obligatedOf(l) - l.directCosts));

/* ------------------------------------------------------------------ */
/* Forecasting                                                         */
/* ------------------------------------------------------------------ */

export interface ForecastInput {
  /** required when method = "manual" */
  manualForecastToComplete?: number | null;
  /** overrides the line's stored percentComplete for this computation */
  percentComplete?: number | null;
}

export interface ForecastResult {
  method: ForecastMethod;
  /** null when the method's inputs are absent — the caller must refuse to store it */
  forecastToComplete: number | null;
  forecastFinal: number | null;
  /** revisedBudget - forecastFinal; negative is an overrun */
  projectedOverUnder: number | null;
  inputs: Record<string, unknown>;
  reasons: string[];
}

/**
 * Forecast-to-complete by the named method. The method is recorded alongside
 * the number precisely so a reader knows whether they are looking at an
 * estimator's judgement or a formula — the two carry very different weight in
 * a cost review, and a report that shows only the figure hides which it is.
 *
 * The six methods, and why they are not the same number:
 *
 *  manual                 The estimator typed it. Nothing is derived; the
 *                         figure is refused if absent rather than guessed.
 *  remaining_budget       FTC = revised − job-to-date. The default: assumes
 *                         the remaining work costs exactly what was budgeted
 *                         for it. Needs no progress measurement.
 *  percent_complete       FTC = revised × (1 − pc). Remaining WORK at the
 *                         BUDGETED rate (PMBOK "EAC = AC + BAC − EV"). Treats
 *                         the overrun to date as a one-off.
 *  productivity_trend     FAC = job-to-date ÷ pc. Assumes the rate achieved
 *                         so far continues (PMBOK "EAC = BAC ÷ CPI"). The
 *                         pessimistic sibling of percent_complete.
 *  unit_rate_trend        Actual unit rate to date × total quantity. Only
 *                         meaningful on a measured line.
 *  committed_plus_pending FAC = max(revised, committed + pending + direct).
 *                         The commitment-led view: you will spend at least
 *                         what you have signed for, and the uncommitted
 *                         balance of the budget on top.
 */
export function computeForecast(
  method: ForecastMethod,
  line: LineAmounts,
  input: ForecastInput = {},
): ForecastResult {
  const revised = revisedBudgetOf(line);
  const jtd = line.jobToDateCosts;
  const pc = finite(input.percentComplete ?? line.percentComplete) ?? 0;
  const inputs: Record<string, unknown> = {
    method,
    revisedBudget: revised,
    jobToDateCosts: jtd,
    percentComplete: pc,
    committedCost: line.committedCost,
    pendingCommitments: line.pendingCommitments,
    directCosts: line.directCosts,
  };
  const fail = (...reasons: string[]): ForecastResult => ({
    method,
    forecastToComplete: null,
    forecastFinal: null,
    projectedOverUnder: null,
    inputs,
    reasons,
  });
  const ok = (ftc: number): ForecastResult => {
    const forecastToComplete = round2(Math.max(0, ftc));
    const forecastFinal = round2(jtd + forecastToComplete);
    return {
      method,
      forecastToComplete,
      forecastFinal,
      projectedOverUnder: round2(revised - forecastFinal),
      inputs,
      reasons: [],
    };
  };

  switch (method) {
    case "manual": {
      const manual = finite(input.manualForecastToComplete);
      if (manual === null) {
        return fail(
          "Method 'manual' requires an explicit forecastToComplete — a manual forecast " +
            "with no typed figure is not a forecast.",
        );
      }
      if (manual < 0) return fail("A manual forecast to complete cannot be negative.");
      inputs["manualForecastToComplete"] = manual;
      return ok(manual);
    }
    case "remaining_budget": {
      if (revised === 0 && jtd === 0) {
        return fail(
          "Method 'remaining_budget' needs a revised budget or costs to date; this line " +
            "has neither.",
        );
      }
      return ok(revised - jtd);
    }
    case "percent_complete": {
      if (pc <= 0) {
        return fail(
          "Method 'percent_complete' requires a percent complete greater than 0 — record " +
            "progress on the line first.",
        );
      }
      if (pc > 1) return fail("Percent complete must be expressed as a fraction in (0, 1].");
      if (revised === 0) {
        return fail("Method 'percent_complete' requires a revised budget to spread.");
      }
      return ok(revised * (1 - pc));
    }
    case "productivity_trend": {
      if (pc <= 0) {
        return fail(
          "Method 'productivity_trend' extrapolates the rate achieved so far and requires a " +
            "percent complete greater than 0.",
        );
      }
      if (pc > 1) return fail("Percent complete must be expressed as a fraction in (0, 1].");
      if (jtd <= 0) {
        return fail(
          "Method 'productivity_trend' extrapolates costs incurred; this line has no " +
            "job-to-date cost to extrapolate from.",
        );
      }
      return ok(jtd / pc - jtd);
    }
    case "unit_rate_trend": {
      const quantity = finite(line.quantity);
      if (quantity === null || quantity <= 0) {
        return fail(
          "Method 'unit_rate_trend' is only meaningful on a measured line — this line has " +
            "no quantity.",
        );
      }
      if (pc <= 0) {
        return fail(
          "Method 'unit_rate_trend' needs the quantity installed so far; record a percent " +
            "complete on the line first.",
        );
      }
      if (jtd <= 0) {
        return fail("Method 'unit_rate_trend' needs job-to-date cost to derive an actual rate.");
      }
      const quantityToDate = quantity * pc;
      const actualUnitRate = jtd / quantityToDate;
      inputs["quantity"] = quantity;
      inputs["quantityToDate"] = round4(quantityToDate);
      inputs["actualUnitRate"] = round2(actualUnitRate);
      inputs["budgetUnitRate"] = finite(line.unitRate);
      return ok(actualUnitRate * (quantity - quantityToDate));
    }
    case "committed_plus_pending": {
      const obligatedAndSpent = round2(obligatedOf(line) + line.directCosts);
      if (obligatedAndSpent === 0 && revised === 0) {
        return fail(
          "Method 'committed_plus_pending' needs a commitment, a direct cost or a revised " +
            "budget; this line has none of them.",
        );
      }
      const forecastFinal = Math.max(revised, obligatedAndSpent);
      inputs["obligatedAndSpent"] = obligatedAndSpent;
      inputs["uncommittedBudget"] = uncommittedBudgetOf(line);
      return ok(forecastFinal - jtd);
    }
    default: {
      // exhaustive: ForecastMethod has no other member
      const never: never = method;
      return fail(`Unknown forecast method '${String(never)}'.`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Derived line                                                        */
/* ------------------------------------------------------------------ */

export interface DerivedLine {
  revisedBudget: number;
  obligated: number;
  uncommittedBudget: number;
  forecastToComplete: number;
  forecastFinal: number;
  /** revised − forecastFinal; NEGATIVE IS AN OVERRUN */
  projectedOverUnder: number;
  /** cost-based progress, null when there is no revised budget to divide by */
  costPercentComplete: number | null;
  /** exposure if every pending transfer and commitment lands */
  exposure: number;
}

/**
 * Everything derivable from one line plus a settled forecast-to-complete.
 * The route layer persists exactly these columns; nothing recomputes them
 * on read, which is what keeps a 4,000-line budget grid fast.
 */
export function deriveLine(line: LineAmounts, forecastToComplete: number): DerivedLine {
  const revisedBudget = revisedBudgetOf(line);
  const ftc = round2(Math.max(0, forecastToComplete));
  const forecastFinal = round2(line.jobToDateCosts + ftc);
  return {
    revisedBudget,
    obligated: obligatedOf(line),
    uncommittedBudget: uncommittedBudgetOf(line),
    forecastToComplete: ftc,
    forecastFinal,
    projectedOverUnder: round2(revisedBudget - forecastFinal),
    costPercentComplete:
      revisedBudget > 0 ? round4(line.jobToDateCosts / revisedBudget) : null,
    exposure: round2(revisedBudget + line.pendingBudgetChanges),
  };
}

/* ------------------------------------------------------------------ */
/* Rollups                                                             */
/* ------------------------------------------------------------------ */

export interface RollupLine extends LineAmounts {
  revisedBudget: number;
  forecastToComplete: number;
  forecastFinal: number;
  projectedOverUnder: number;
}

export interface BudgetTotals {
  originalBudgetTotal: number;
  budgetModificationsTotal: number;
  approvedChangesTotal: number;
  pendingChangesTotal: number;
  revisedBudgetTotal: number;
  committedTotal: number;
  pendingCommitmentsTotal: number;
  directCostsTotal: number;
  jobToDateCostsTotal: number;
  forecastToCompleteTotal: number;
  forecastFinalTotal: number;
  varianceTotal: number;
}

export const ZERO_TOTALS: BudgetTotals = {
  originalBudgetTotal: 0,
  budgetModificationsTotal: 0,
  approvedChangesTotal: 0,
  pendingChangesTotal: 0,
  revisedBudgetTotal: 0,
  committedTotal: 0,
  pendingCommitmentsTotal: 0,
  directCostsTotal: 0,
  jobToDateCostsTotal: 0,
  forecastToCompleteTotal: 0,
  forecastFinalTotal: 0,
  varianceTotal: 0,
};

/**
 * Σ over lines. Every total is a plain sum of a stored column — no total is
 * derived from another total, so `revisedBudgetTotal` proving equal to
 * `original + modifications + approved` is a real reconciliation rather than
 * an algebraic tautology.
 */
export function rollUpTotals(lines: readonly RollupLine[]): BudgetTotals {
  const t = { ...ZERO_TOTALS };
  for (const l of lines) {
    t.originalBudgetTotal += l.originalBudget;
    t.budgetModificationsTotal += l.budgetModifications;
    t.approvedChangesTotal += l.approvedChanges;
    t.pendingChangesTotal += l.pendingBudgetChanges;
    t.revisedBudgetTotal += l.revisedBudget;
    t.committedTotal += l.committedCost;
    t.pendingCommitmentsTotal += l.pendingCommitments;
    t.directCostsTotal += l.directCosts;
    t.jobToDateCostsTotal += l.jobToDateCosts;
    t.forecastToCompleteTotal += l.forecastToComplete;
    t.forecastFinalTotal += l.forecastFinal;
    t.varianceTotal += l.projectedOverUnder;
  }
  for (const key of Object.keys(t) as (keyof BudgetTotals)[]) t[key] = round2(t[key]);
  return t;
}

export interface RollupGroup<T extends RollupLine = RollupLine> {
  key: string;
  label: string;
  lineCount: number;
  totals: BudgetTotals;
  lines?: T[];
}

/** Group lines by an arbitrary key and total each group. Stable by key. */
export function groupBy<T extends RollupLine>(
  lines: readonly T[],
  keyOf: (line: T) => { key: string; label: string } | null,
): RollupGroup<T>[] {
  const buckets = new Map<string, { label: string; lines: T[] }>();
  for (const line of lines) {
    const k = keyOf(line);
    if (!k) continue;
    const bucket = buckets.get(k.key) ?? { label: k.label, lines: [] };
    bucket.lines.push(line);
    buckets.set(k.key, bucket);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      lineCount: bucket.lines.length,
      totals: rollUpTotals(bucket.lines),
      lines: bucket.lines,
    }));
}

/**
 * Every ancestor path of a materialized WBS path, root first:
 *   "03/03300/03310" -> ["03", "03/03300", "03/03300/03310"]
 * A WBS rollup credits a line to every node above it, which is what makes a
 * collapsed budget tree add up at each level.
 */
export function wbsAncestors(path: string | null | undefined): string[] {
  if (!path) return [];
  const parts = path.split("/").filter((p) => p.length > 0);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) out.push(parts.slice(0, i + 1).join("/"));
  return out;
}

export interface WbsRollupNode {
  key: string;
  label: string;
  /** 0 for the unassigned bucket, otherwise the number of path segments */
  depth: number;
  lineCount: number;
  totals: BudgetTotals;
}

/** Roll lines up the WBS tree so every node totals its whole subtree. */
export function rollUpByWbs<T extends RollupLine & { wbsPath?: string | null }>(
  lines: readonly T[],
): WbsRollupNode[] {
  const buckets = new Map<string, T[]>();
  for (const line of lines) {
    const ancestors = wbsAncestors(line.wbsPath);
    if (ancestors.length === 0) {
      const bucket = buckets.get("") ?? [];
      bucket.push(line);
      buckets.set("", bucket);
      continue;
    }
    for (const node of ancestors) {
      const bucket = buckets.get(node) ?? [];
      bucket.push(line);
      buckets.set(node, bucket);
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, bucketLines]) => ({
      key,
      label: key === "" ? "(unassigned)" : key,
      lineCount: bucketLines.length,
      depth: key === "" ? 0 : key.split("/").length,
      totals: rollUpTotals(bucketLines),
    }));
}

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

export interface Identity {
  identity: string;
  left: number;
  right: number;
  delta: number;
  ok: boolean;
}

/**
 * Re-derive the identities a construction cost report is required to satisfy.
 * A caller returns these to the client and a test asserts them; when one is
 * false, the budget is wrong and says so out loud instead of presenting a
 * plausible-looking grid.
 */
export function reconcile(t: BudgetTotals): Identity[] {
  const check = (identity: string, left: number, right: number): Identity => ({
    identity,
    left: round2(left),
    right: round2(right),
    delta: round2(left - right),
    ok: nearlyEqual(left, right),
  });
  return [
    check(
      "originalBudget + budgetModifications + approvedChanges = revisedBudget",
      t.originalBudgetTotal + t.budgetModificationsTotal + t.approvedChangesTotal,
      t.revisedBudgetTotal,
    ),
    check(
      "jobToDateCosts + forecastToComplete = forecastFinal",
      t.jobToDateCostsTotal + t.forecastToCompleteTotal,
      t.forecastFinalTotal,
    ),
    check(
      "revisedBudget - forecastFinal = variance",
      t.revisedBudgetTotal - t.forecastFinalTotal,
      t.varianceTotal,
    ),
  ];
}

/* ------------------------------------------------------------------ */
/* Budget changes (transfers, draws, owner changes)                    */
/* ------------------------------------------------------------------ */

export interface ChangeLeg {
  lineItemId: string;
  costCode: string;
  costType: CostType;
  amount: number;
}

export interface ChangeLegAnalysis {
  /** Σ of every leg. Zero for a transfer; the funded increase for an owner change */
  net: number;
  /** Σ of the positive legs — the absolute amount moved */
  amount: number;
  sources: ChangeLeg[];
  destinations: ChangeLeg[];
  /** kinds other than owner_change must net to zero */
  balances: boolean;
}

export function analyzeLegs(legs: readonly ChangeLeg[]): ChangeLegAnalysis {
  let net = 0;
  let amount = 0;
  const sources: ChangeLeg[] = [];
  const destinations: ChangeLeg[] = [];
  for (const leg of legs) {
    net += leg.amount;
    if (leg.amount > 0) {
      amount += leg.amount;
      destinations.push(leg);
    } else if (leg.amount < 0) {
      sources.push(leg);
    }
  }
  return {
    net: round2(net),
    amount: round2(amount),
    sources,
    destinations,
    balances: nearlyEqual(net, 0),
  };
}

/**
 * Is this set of legs a legal movement of the named kind? Returns the reason
 * it is not, or null when it is.
 *
 * A transfer that does not net to zero is not a transfer — it is an
 * unfunded increase wearing a transfer's clothes, and it is the single
 * easiest way to inflate a budget without anyone signing for the money.
 * Only `owner_change` may move the total, and only as the downstream effect
 * of an executed prime contract change order.
 */
export function legVerdict(
  kind: BudgetChangeKind,
  legs: readonly ChangeLeg[],
): { analysis: ChangeLegAnalysis; error: string | null } {
  const analysis = analyzeLegs(legs);
  if (legs.length === 0) {
    return { analysis, error: "A budget change must move at least one line." };
  }
  if (legs.some((l) => !Number.isFinite(l.amount) || l.amount === 0)) {
    return { analysis, error: "Every budget change leg must carry a non-zero finite amount." };
  }
  const seen = new Set<string>();
  for (const leg of legs) {
    if (seen.has(leg.lineItemId)) {
      return {
        analysis,
        error:
          `Line ${leg.lineItemId} appears on more than one leg — net the movement into a ` +
          "single leg so the audit trail reads unambiguously.",
      };
    }
    seen.add(leg.lineItemId);
  }
  if (kind === "owner_change") {
    if (analysis.net === 0) {
      return {
        analysis,
        error:
          "An owner_change must change the budget total; a net-zero movement is a transfer " +
          "and should be recorded as one.",
      };
    }
    return { analysis, error: null };
  }
  if (!analysis.balances) {
    return {
      analysis,
      error:
        `A ${kind} must balance to zero across its lines — these legs net to ` +
        `${analysis.net.toFixed(2)}. Money moved out of one line has to land in another.`,
    };
  }
  if (analysis.sources.length === 0 || analysis.destinations.length === 0) {
    return {
      analysis,
      error: `A ${kind} needs at least one source leg (negative) and one destination leg.`,
    };
  }
  return { analysis, error: null };
}

/**
 * Which stored column an approved change writes into. Transfers and draws
 * are internal reallocations (`budgetModifications`); an owner change is new
 * money and belongs in `approvedChanges`, because the two are reported
 * separately for the whole life of the job.
 */
export const changeTargetColumn = (
  kind: BudgetChangeKind,
): "budgetModifications" | "approvedChanges" => (kind === "owner_change" ? "approvedChanges" : "budgetModifications");

/* ------------------------------------------------------------------ */
/* Snapshots                                                           */
/* ------------------------------------------------------------------ */

export interface SnapshotLine {
  lineItemId: string;
  costCode: string;
  costType: string;
  description: string;
  wbsPath: string | null;
  lineKind: string;
  originalBudget: number;
  budgetModifications: number;
  approvedChanges: number;
  revisedBudget: number;
  committedCost: number;
  pendingCommitments: number;
  directCosts: number;
  jobToDateCosts: number;
  forecastMethod: string;
  forecastToComplete: number;
  forecastFinal: number;
  projectedOverUnder: number;
  percentComplete: number;
}

/** The money fields a snapshot diff compares, in report order. */
export const SNAPSHOT_MONEY_FIELDS = [
  "originalBudget",
  "budgetModifications",
  "approvedChanges",
  "revisedBudget",
  "committedCost",
  "pendingCommitments",
  "directCosts",
  "jobToDateCosts",
  "forecastToComplete",
  "forecastFinal",
  "projectedOverUnder",
  "percentComplete",
] as const;

export type SnapshotMoneyField = (typeof SNAPSHOT_MONEY_FIELDS)[number];

/**
 * sha-256 over the frozen payload. A snapshot is the answer to "what did the
 * budget say at month end", relied on months later in a claim; the hash is
 * what makes a later edit to the capture itself detectable rather than
 * merely unlikely.
 */
export const snapshotContentHash = (lines: unknown[], totals: Record<string, number>): string =>
  hashPayload({ lines, totals });

export interface FieldDelta {
  field: SnapshotMoneyField;
  from: number;
  to: number;
  delta: number;
}

export interface SnapshotLineDiff {
  lineItemId: string;
  costCode: string;
  costType: string;
  description: string;
  fields: FieldDelta[];
}

export interface SnapshotDiff {
  added: SnapshotLine[];
  removed: SnapshotLine[];
  changed: SnapshotLineDiff[];
  unchangedCount: number;
  totals: Array<{ field: string; from: number; to: number; delta: number }>;
}

/** Identity of a snapshot line — cost code × cost type is the WBS coordinate. */
const lineKey = (l: SnapshotLine): string => `${l.costCode} ${l.costType}`;

/**
 * Compare two immutable captures line by line. Lines are matched on their
 * WBS coordinate rather than on `lineItemId`: a line deleted and recreated at
 * the same cost code is the same line to a cost reviewer, and matching on id
 * would report it as a deletion plus an addition of identical value, which is
 * exactly the noise that makes a month-end diff unreadable.
 */
export function diffSnapshots(
  from: { lines: SnapshotLine[]; totals: Record<string, number> },
  to: { lines: SnapshotLine[]; totals: Record<string, number> },
): SnapshotDiff {
  const fromByKey = new Map(from.lines.map((l) => [lineKey(l), l]));
  const toByKey = new Map(to.lines.map((l) => [lineKey(l), l]));

  const added: SnapshotLine[] = [];
  const changed: SnapshotLineDiff[] = [];
  let unchangedCount = 0;

  for (const [key, toLine] of toByKey) {
    const fromLine = fromByKey.get(key);
    if (!fromLine) {
      added.push(toLine);
      continue;
    }
    const fields: FieldDelta[] = [];
    for (const field of SNAPSHOT_MONEY_FIELDS) {
      const a = finite(fromLine[field]) ?? 0;
      const b = finite(toLine[field]) ?? 0;
      if (!nearlyEqual(a, b)) fields.push({ field, from: a, to: b, delta: round2(b - a) });
    }
    if (fields.length === 0) unchangedCount += 1;
    else {
      changed.push({
        lineItemId: toLine.lineItemId,
        costCode: toLine.costCode,
        costType: toLine.costType,
        description: toLine.description,
        fields,
      });
    }
  }

  const removed = [...fromByKey.entries()]
    .filter(([key]) => !toByKey.has(key))
    .map(([, line]) => line);

  const totalKeys = [...new Set([...Object.keys(from.totals), ...Object.keys(to.totals)])].sort();
  const totals = totalKeys
    .map((field) => {
      const a = finite(from.totals[field]) ?? 0;
      const b = finite(to.totals[field]) ?? 0;
      return { field, from: a, to: b, delta: round2(b - a) };
    })
    .filter((row) => !nearlyEqual(row.delta, 0));

  changed.sort((a, b) => a.costCode.localeCompare(b.costCode));
  added.sort((a, b) => a.costCode.localeCompare(b.costCode));
  removed.sort((a, b) => a.costCode.localeCompare(b.costCode));

  return { added, removed, changed, unchangedCount, totals };
}
