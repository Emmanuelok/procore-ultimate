import { and, eq, inArray } from "drizzle-orm";
import {
  budgetLineItems,
  budgets,
  commitmentChanges,
  commitmentPayments,
  commitmentSovLines,
  commitments,
  invoices,
} from "@constructos/db";
import type { Db } from "../../lib/db.js";
import { computeCommitmentTotals, reconcileCommitment, type ReconciliationCheck } from "./arithmetic.js";
import {
  DEAD_COMMITMENT_STATUSES,
  isCommittedChange,
  isCommittedCommitment,
  isPaidPayment,
  isPendingCommitment,
  known,
  round2,
  round4,
  unknown,
  type Unknowable,
} from "./shared.js";

/**
 * ROLLUPS — the buy side, aggregated.
 *
 * Three questions a project team asks about commitments every single week,
 * and the three answers this file computes from stored rows only:
 *
 *   1. What have we committed, by cost code?      -> committedByCostCode
 *   2. How much is left to commit against budget? -> the same rows, minus budget
 *   3. Did we buy it for less than we budgeted?   -> buyoutLog
 *
 * TWO RULES GOVERN EVERY FIGURE HERE.
 *
 * Currency: totals are bucketed BY CURRENCY and never summed across them. A
 * project running a USD subcontract and a EUR equipment PO gets two buckets
 * and a flag, not one wrong number. There is no rate on the record, so any
 * single number would be invented.
 *
 * Missing inputs: a figure that cannot be derived comes back as
 * `{ value: null, reasons: [...] }`, the same contract the benchmark metrics
 * use. "Remaining to commit" against a project with no budget is NOT the
 * committed total negated — it is unknown, and it says so.
 */

/**
 * Purchase-order tax, line by line. A PO's SOV lines carry their own
 * `taxable` flag and `taxPercent`; tax is Σ over TAXABLE lines of
 * revisedScheduledValue × (line rate, else the header rate). A PO with one
 * taxable and three non-taxable lines is taxed on one line, not four. Where no
 * line carries a flag at all the header decides, as it did before.
 */
export function purchaseOrderTax(
  commitment: { kind: string; taxable: number; taxPercent: number | null; taxAmount: number | null },
  lines: ReadonlyArray<{ taxable: number; taxPercent: number | null; revisedScheduledValue: number }>,
): number | null {
  if (commitment.kind !== "purchase_order") return null;
  const flagged = lines.filter((l) => l.taxable === 1);
  if (flagged.length > 0) {
    return round2(
      flagged.reduce(
        (s, l) => s + ((l.taxPercent ?? commitment.taxPercent ?? 0) / 100) * l.revisedScheduledValue,
        0,
      ),
    );
  }
  if (commitment.taxable === 1 && commitment.taxPercent !== null) {
    return round2(
      (commitment.taxPercent / 100) * lines.reduce((s, l) => s + l.revisedScheduledValue, 0),
    );
  }
  return commitment.taxAmount;
}

/* ------------------------------------------------------------------ */
/* Recompute — the write path for a commitment's materialized totals   */
/* ------------------------------------------------------------------ */

export interface RecomputeResult {
  originalCommitmentSum: number;
  approvedChangeSum: number;
  pendingChangeSum: number;
  draftChangeSum: number;
  revisedCommitmentSum: number;
  retainageHeld: number;
  balanceToFinish: number;
  totalPaid: number;
  lineCount: number;
}

/**
 * Recompute a commitment's materialized totals from its schedule of values
 * and its change-order register, and stamp `totalsCalculatedAt`.
 *
 * Called after every write that can move a figure: SOV edits, change-order
 * transitions, invoice and payment posting. The rollup columns exist because
 * the commitments list is a hot read; they are only ever DERIVED here, so
 * there is exactly one implementation of the arithmetic on the write path.
 */
export async function recomputeCommitmentTotals(
  db: Db,
  commitmentId: string,
): Promise<RecomputeResult> {
  const [lines, changes, paymentRows, rows] = await Promise.all([
    db
      .select()
      .from(commitmentSovLines)
      .where(eq(commitmentSovLines.commitmentId, commitmentId)),
    db
      .select({ status: commitmentChanges.status, amount: commitmentChanges.amount })
      .from(commitmentChanges)
      .where(eq(commitmentChanges.commitmentId, commitmentId)),
    db
      .select({ status: commitmentPayments.status, amount: commitmentPayments.amount })
      .from(commitmentPayments)
      .where(eq(commitmentPayments.commitmentId, commitmentId)),
    db.select().from(commitments).where(eq(commitments.id, commitmentId)).limit(1),
  ]);
  const commitment = rows[0];
  if (!commitment) throw new Error(`recomputeCommitmentTotals: commitment ${commitmentId} is gone`);

  /*
   * Paid is DERIVED from the payment register rather than incremented on
   * issue: an increment that runs twice is undetectable afterwards, and a
   * derived figure is provable against the rows a bank statement reconciles
   * to. `totalInvoiced` is deliberately NOT recomputed here — invoices are the
   * invoicing module's write, and this module must not silently overwrite it.
   */
  const totalPaid = round2(
    paymentRows.filter((p) => isPaidPayment(p.status)).reduce((s, p) => s + p.amount, 0),
  );

  const totals = computeCommitmentTotals(lines, changes);
  const balanceToFinish = round2(totals.revisedCommitmentSum - commitment.totalInvoiced);
  /*
   * Purchase-order tax is a function of the PO sum, so it is recomputed here
   * with everything else rather than typed on a form and left behind when a
   * change order moves the sum. Subcontracts carry no tax column value at all.
   */
  const taxAmount = purchaseOrderTax(commitment, lines);
  await db
    .update(commitments)
    .set({
      taxAmount,
      originalCommitmentSum: totals.originalCommitmentSum,
      approvedChangeSum: totals.approvedChangeSum,
      pendingChangeSum: totals.pendingChangeSum,
      draftChangeSum: totals.draftChangeSum,
      revisedCommitmentSum: totals.revisedCommitmentSum,
      retainageHeld: totals.retainageHeld,
      retainageReleased: totals.retainageReleased,
      balanceToFinish,
      totalPaid,
      totalsCalculatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(commitments.id, commitmentId));

  return { ...totals, balanceToFinish, totalPaid };
}

/** Every identity checked against the stored rows for one commitment. */
export async function reconcile(
  db: Db,
  commitmentId: string,
): Promise<{ checks: ReconciliationCheck[]; reconciles: boolean }> {
  const [lines, changes, rows] = await Promise.all([
    db.select().from(commitmentSovLines).where(eq(commitmentSovLines.commitmentId, commitmentId)),
    db
      .select({ status: commitmentChanges.status, amount: commitmentChanges.amount })
      .from(commitmentChanges)
      .where(eq(commitmentChanges.commitmentId, commitmentId)),
    db.select().from(commitments).where(eq(commitments.id, commitmentId)).limit(1),
  ]);
  const c = rows[0];
  if (!c) throw new Error(`reconcile: commitment ${commitmentId} is gone`);
  return reconcileCommitment({
    originalCommitmentSum: c.originalCommitmentSum,
    approvedChangeSum: c.approvedChangeSum,
    revisedCommitmentSum: c.revisedCommitmentSum,
    lines,
    committedChangeAmount: round2(
      changes.filter((ch) => isCommittedChange(ch.status)).reduce((s, ch) => s + ch.amount, 0),
    ),
    totalInvoiced: c.totalInvoiced,
    totalPaid: c.totalPaid,
    balanceToFinish: c.balanceToFinish,
  });
}

/**
 * Every identity on every commitment of a project, in three queries rather
 * than three per commitment. The reconcile report loads this on every open.
 */
export async function reconcileProject(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<
  Array<{
    commitment: typeof commitments.$inferSelect;
    checks: ReconciliationCheck[];
    reconciles: boolean;
  }>
> {
  const [rows, lines, changes] = await Promise.all([
    db
      .select()
      .from(commitments)
      .where(and(eq(commitments.companyId, companyId), eq(commitments.projectId, projectId))),
    db
      .select()
      .from(commitmentSovLines)
      .where(and(eq(commitmentSovLines.companyId, companyId), eq(commitmentSovLines.projectId, projectId))),
    db
      .select({
        commitmentId: commitmentChanges.commitmentId,
        status: commitmentChanges.status,
        amount: commitmentChanges.amount,
      })
      .from(commitmentChanges)
      .where(and(eq(commitmentChanges.companyId, companyId), eq(commitmentChanges.projectId, projectId))),
  ]);
  const linesBy = new Map<string, typeof lines>();
  for (const l of lines) {
    const list = linesBy.get(l.commitmentId) ?? [];
    list.push(l);
    linesBy.set(l.commitmentId, list);
  }
  const committedBy = new Map<string, number>();
  for (const ch of changes) {
    if (!isCommittedChange(ch.status)) continue;
    committedBy.set(ch.commitmentId, round2((committedBy.get(ch.commitmentId) ?? 0) + ch.amount));
  }
  return rows.map((c) => {
    const r = reconcileCommitment({
      originalCommitmentSum: c.originalCommitmentSum,
      approvedChangeSum: c.approvedChangeSum,
      revisedCommitmentSum: c.revisedCommitmentSum,
      lines: linesBy.get(c.id) ?? [],
      committedChangeAmount: committedBy.get(c.id) ?? 0,
      totalInvoiced: c.totalInvoiced,
      totalPaid: c.totalPaid,
      balanceToFinish: c.balanceToFinish,
    });
    return { commitment: c, checks: r.checks, reconciles: r.reconciles };
  });
}

/* ------------------------------------------------------------------ */
/* Budget roll — committed cost landing on the budget line             */
/* ------------------------------------------------------------------ */

export interface BudgetSyncResult {
  budgetLinesUpdated: number;
  /** SOV value skipped because its commitment is not in the budget's currency */
  skippedForCurrency: Array<{ budgetLineItemId: string; currency: string; amount: number }>;
  asOf: string;
}

/**
 * Materialize `budget_line_items.committed_cost` and `.pending_commitments`
 * from the commitment schedules of values that point at them.
 *
 * This is the join the whole financial suite turns on. A budget line's
 * committed cost is not something anybody types: it is the sum of the revised
 * scheduled values of every APPROVED commitment SOV line bound to it, and
 * `pendingCommitments` is the same sum over commitments still in buyout. Both
 * are recomputed from scratch for the affected lines rather than incremented,
 * so a rerun is idempotent and a bug cannot compound.
 *
 * Currency: a commitment written in a currency other than the budget's is
 * EXCLUDED from the total and reported in `skippedForCurrency`. Adding it
 * would produce a budget line whose committed cost is a sum of two currencies,
 * which is worse than no number at all.
 */
export async function syncBudgetCommitted(
  db: Db,
  companyId: string,
  projectId: string,
  onlyBudgetLineIds?: readonly string[],
): Promise<BudgetSyncResult> {
  const asOf = new Date().toISOString();
  const scope =
    onlyBudgetLineIds && onlyBudgetLineIds.length === 0
      ? []
      : await db
          .select()
          .from(budgetLineItems)
          .where(
            onlyBudgetLineIds
              ? and(
                  eq(budgetLineItems.companyId, companyId),
                  eq(budgetLineItems.projectId, projectId),
                  inArray(budgetLineItems.id, [...onlyBudgetLineIds]),
                )
              : and(
                  eq(budgetLineItems.companyId, companyId),
                  eq(budgetLineItems.projectId, projectId),
                ),
          );
  if (scope.length === 0) {
    return { budgetLinesUpdated: 0, skippedForCurrency: [], asOf };
  }

  const budgetIds = [...new Set(scope.map((l) => l.budgetId))];
  const budgetRows = await db
    .select({ id: budgets.id, currency: budgets.currency })
    .from(budgets)
    .where(inArray(budgets.id, budgetIds));
  const budgetCurrency = new Map(budgetRows.map((b) => [b.id, b.currency.toUpperCase()]));

  const scopeIds = scope.map((l) => l.id);
  /*
   * Read only the SOV lines that point at the budget lines in scope. Before
   * this filter every write re-read the whole project's schedule; on a project
   * with two hundred subcontracts that was the slowest statement on the buy
   * side and it ran on every SOV keystroke.
   */
  const rows = await db
    .select({
      sovLineId: commitmentSovLines.id,
      commitmentId: commitmentSovLines.commitmentId,
      budgetLineItemId: commitmentSovLines.budgetLineItemId,
      revisedScheduledValue: commitmentSovLines.revisedScheduledValue,
      status: commitments.status,
      currency: commitments.currency,
    })
    .from(commitmentSovLines)
    .innerJoin(commitments, eq(commitments.id, commitmentSovLines.commitmentId))
    .where(
      and(
        eq(commitmentSovLines.companyId, companyId),
        eq(commitmentSovLines.projectId, projectId),
        inArray(commitmentSovLines.budgetLineItemId, scopeIds),
      ),
    );
  /*
   * Priced-but-unapproved change orders are exposure too (#526): a pending or
   * draft CCO allocated to a budget line lands in `pendingCommitments`, which
   * is what the schema promises that column holds. Allocation lines name a
   * budget line directly, or an existing SOV line whose budget line is known.
   */
  const commitmentIds = [...new Set(rows.map((r) => r.commitmentId))];
  const sovBudget = new Map(rows.map((r) => [r.sovLineId, r.budgetLineItemId]));
  const pendingChangeRows =
    commitmentIds.length > 0
      ? await db
          .select({
            commitmentId: commitmentChanges.commitmentId,
            status: commitmentChanges.status,
            lines: commitmentChanges.lines,
          })
          .from(commitmentChanges)
          .where(
            and(
              inArray(commitmentChanges.commitmentId, commitmentIds),
              inArray(commitmentChanges.status, [
                "draft",
                "pending_pricing",
                "pending_in_house_review",
                "pending_owner_approval",
                "revise_and_resubmit",
              ]),
            ),
          )
      : [];
  const commitmentMeta = new Map(rows.map((r) => [r.commitmentId, { status: r.status, currency: r.currency }]));

  const committed = new Map<string, Map<string, number>>();
  const pending = new Map<string, Map<string, number>>();
  const bump = (
    target: Map<string, Map<string, number>>,
    lineId: string,
    currency: string,
    amount: number,
  ): void => {
    const byCurrency = target.get(lineId) ?? new Map<string, number>();
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + amount);
    target.set(lineId, byCurrency);
  };

  for (const r of rows) {
    if (!r.budgetLineItemId) continue;
    if ((DEAD_COMMITMENT_STATUSES as readonly string[]).includes(r.status)) continue;
    const currency = r.currency.toUpperCase();
    if (isCommittedCommitment(r.status)) {
      bump(committed, r.budgetLineItemId, currency, r.revisedScheduledValue);
    } else if (isPendingCommitment(r.status)) {
      bump(pending, r.budgetLineItemId, currency, r.revisedScheduledValue);
    }
  }
  for (const change of pendingChangeRows) {
    const meta = commitmentMeta.get(change.commitmentId);
    if (!meta || (DEAD_COMMITMENT_STATUSES as readonly string[]).includes(meta.status)) continue;
    const currency = meta.currency.toUpperCase();
    for (const raw of change.lines as Array<Record<string, unknown>>) {
      const amount = typeof raw["amount"] === "number" ? raw["amount"] : 0;
      const direct = typeof raw["budgetLineItemId"] === "string" ? raw["budgetLineItemId"] : null;
      const viaSov = typeof raw["sovLineId"] === "string" ? sovBudget.get(raw["sovLineId"]) ?? null : null;
      const target = direct ?? viaSov;
      if (!target || !scopeIds.includes(target)) continue;
      bump(pending, target, currency, amount);
    }
  }

  const skippedForCurrency: BudgetSyncResult["skippedForCurrency"] = [];
  let budgetLinesUpdated = 0;
  for (const line of scope) {
    const currency = budgetCurrency.get(line.budgetId) ?? "USD";
    const take = (m: Map<string, Map<string, number>>): number => {
      const byCurrency = m.get(line.id);
      if (!byCurrency) return 0;
      for (const [cur, amount] of byCurrency) {
        if (cur !== currency) {
          skippedForCurrency.push({ budgetLineItemId: line.id, currency: cur, amount: round2(amount) });
        }
      }
      return round2(byCurrency.get(currency) ?? 0);
    };
    const committedCost = take(committed);
    const pendingCommitments = take(pending);
    if (
      Math.abs(committedCost - line.committedCost) <= 0.005 &&
      Math.abs(pendingCommitments - line.pendingCommitments) <= 0.005
    ) {
      continue;
    }
    await db
      .update(budgetLineItems)
      .set({ committedCost, pendingCommitments, updatedAt: asOf })
      .where(eq(budgetLineItems.id, line.id));
    budgetLinesUpdated += 1;
  }
  return { budgetLinesUpdated, skippedForCurrency, asOf };
}

/** Budget line ids a commitment's SOV points at — the sync's blast radius. */
export async function budgetLineIdsFor(db: Db, commitmentId: string): Promise<string[]> {
  const rows = await db
    .select({ id: commitmentSovLines.budgetLineItemId })
    .from(commitmentSovLines)
    .where(eq(commitmentSovLines.commitmentId, commitmentId));
  return [...new Set(rows.map((r) => r.id).filter((id): id is string => id !== null))];
}

/* ------------------------------------------------------------------ */
/* Committed by cost code                                              */
/* ------------------------------------------------------------------ */

export interface CostCodeRollupRow {
  costCode: string;
  costType: string;
  description: string | null;
  /** original scheduled value of committed commitments */
  originalCommitted: number;
  /** executed/approved change-order value on those lines */
  changeOrders: number;
  revisedCommitted: number;
  /** commitments still in buyout — exposure, deliberately a separate column */
  pendingCommitted: number;
  invoiced: number;
  retainageHeld: number;
  balanceToFinish: number;
  commitmentCount: number;
  /** budget position for the same coordinate, when a budget line exists */
  revisedBudget: Unknowable;
  remainingToCommit: Unknowable;
  percentBoughtOut: Unknowable;
}

export interface CurrencyBucket<T> {
  currency: string;
  rows: T[];
  totals: {
    originalCommitted: number;
    changeOrders: number;
    revisedCommitted: number;
    pendingCommitted: number;
    invoiced: number;
    retainageHeld: number;
    balanceToFinish: number;
  };
}

export interface CostCodeRollup {
  projectId: string;
  /** true when the project holds commitments in more than one currency */
  mixedCurrency: boolean;
  currencies: string[];
  buckets: Array<CurrencyBucket<CostCodeRollupRow>>;
  budgetId: string | null;
  budgetCurrency: string | null;
  notes: string[];
}

interface Accumulator {
  costCode: string;
  costType: string;
  description: string | null;
  originalCommitted: number;
  changeOrders: number;
  pendingCommitted: number;
  invoicedShare: number;
  retainageHeld: number;
  commitmentIds: Set<string>;
}

/**
 * Committed cost by (cost code, cost type), bucketed by currency, with the
 * budget for the same coordinate alongside it and the remaining-to-commit
 * derived from the two.
 *
 * `invoiced` is apportioned to a line by its share of the commitment's
 * revised sum, because subcontractor invoices are billed against SOV lines
 * but `commitments.totalInvoiced` is the authoritative header figure. The
 * apportionment is stated rather than hidden: it is exact whenever the sub
 * bills every line pro rata and approximate otherwise, and the per-commitment
 * total always reconciles even when a single line's share does not.
 */
export async function committedByCostCode(
  db: Db,
  companyId: string,
  projectId: string,
  options: { budgetId?: string | null } = {},
): Promise<CostCodeRollup> {
  const rows = await db
    .select({
      commitmentId: commitments.id,
      status: commitments.status,
      currency: commitments.currency,
      revisedCommitmentSum: commitments.revisedCommitmentSum,
      totalInvoiced: commitments.totalInvoiced,
      lineCostCode: commitmentSovLines.costCode,
      lineCostType: commitmentSovLines.costType,
      description: commitmentSovLines.description,
      scheduledValue: commitmentSovLines.scheduledValue,
      changeOrderValue: commitmentSovLines.changeOrderValue,
      revisedScheduledValue: commitmentSovLines.revisedScheduledValue,
      retainageHeld: commitmentSovLines.retainageHeld,
      budgetLineItemId: commitmentSovLines.budgetLineItemId,
    })
    .from(commitmentSovLines)
    .innerJoin(commitments, eq(commitments.id, commitmentSovLines.commitmentId))
    .where(
      and(eq(commitmentSovLines.companyId, companyId), eq(commitmentSovLines.projectId, projectId)),
    );

  const byCurrency = new Map<string, Map<string, Accumulator>>();
  const currencies = new Set<string>();
  for (const r of rows) {
    if ((DEAD_COMMITMENT_STATUSES as readonly string[]).includes(r.status)) continue;
    const committedNow = isCommittedCommitment(r.status);
    const pendingNow = isPendingCommitment(r.status);
    if (!committedNow && !pendingNow) continue;
    const currency = r.currency.toUpperCase();
    currencies.add(currency);
    const key = `${r.lineCostCode ?? "(uncoded)"}::${r.lineCostType ?? "other"}`;
    const bucket = byCurrency.get(currency) ?? new Map<string, Accumulator>();
    const acc =
      bucket.get(key) ??
      ({
        costCode: r.lineCostCode ?? "(uncoded)",
        costType: r.lineCostType ?? "other",
        description: r.description,
        originalCommitted: 0,
        changeOrders: 0,
        pendingCommitted: 0,
        invoicedShare: 0,
        retainageHeld: 0,
        commitmentIds: new Set<string>(),
      } satisfies Accumulator);
    if (committedNow) {
      acc.originalCommitted += r.scheduledValue;
      acc.changeOrders += r.changeOrderValue;
      acc.retainageHeld += r.retainageHeld;
      const share =
        r.revisedCommitmentSum === 0 ? 0 : r.revisedScheduledValue / r.revisedCommitmentSum;
      acc.invoicedShare += share * r.totalInvoiced;
    } else {
      acc.pendingCommitted += r.revisedScheduledValue;
    }
    acc.commitmentIds.add(r.commitmentId);
    bucket.set(key, acc);
    byCurrency.set(currency, bucket);
  }

  const notes: string[] = [];
  const budget = await resolveBudget(db, companyId, projectId, options.budgetId ?? null);
  const budgetByKey = new Map<string, number>();
  if (budget) {
    for (const line of budget.lines) {
      const key = `${line.costCode}::${line.costType}`;
      budgetByKey.set(key, (budgetByKey.get(key) ?? 0) + line.revisedBudget);
    }
  } else {
    notes.push(
      "No active budget on this project, so remaining-to-commit and percent-bought-out are " +
        "reported as unknown rather than as the committed total.",
    );
  }

  const buckets: Array<CurrencyBucket<CostCodeRollupRow>> = [];
  for (const [currency, bucket] of [...byCurrency].sort((a, b) => a[0].localeCompare(b[0]))) {
    const rowsOut: CostCodeRollupRow[] = [];
    for (const acc of bucket.values()) {
      const revisedCommitted = round2(acc.originalCommitted + acc.changeOrders);
      const invoiced = round2(acc.invoicedShare);
      const key = `${acc.costCode}::${acc.costType}`;
      const budgetAmount =
        budget && budget.currency === currency ? (budgetByKey.get(key) ?? null) : null;
      const revisedBudget: Unknowable = !budget
        ? unknown("No active budget on this project.")
        : budget.currency !== currency
          ? unknown(
              `The active budget is in ${budget.currency}; these commitments are in ${currency}. ` +
                "Figures in different currencies are never compared.",
            )
          : budgetAmount === null
            ? unknown(`No budget line exists for cost code ${acc.costCode} / ${acc.costType}.`)
            : known(round2(budgetAmount));
      rowsOut.push({
        costCode: acc.costCode,
        costType: acc.costType,
        description: acc.description,
        originalCommitted: round2(acc.originalCommitted),
        changeOrders: round2(acc.changeOrders),
        revisedCommitted,
        pendingCommitted: round2(acc.pendingCommitted),
        invoiced,
        retainageHeld: round2(acc.retainageHeld),
        balanceToFinish: round2(revisedCommitted - invoiced),
        commitmentCount: acc.commitmentIds.size,
        revisedBudget,
        remainingToCommit:
          revisedBudget.value === null
            ? unknown(...revisedBudget.reasons)
            : known(round2(revisedBudget.value - revisedCommitted - acc.pendingCommitted)),
        percentBoughtOut:
          revisedBudget.value === null
            ? unknown(...revisedBudget.reasons)
            : revisedBudget.value === 0
              ? unknown("The budget for this cost code is zero, so percent bought out is undefined.")
              : known(round4((revisedCommitted / revisedBudget.value) * 100)),
      });
    }
    rowsOut.sort(
      (a, b) => a.costCode.localeCompare(b.costCode) || a.costType.localeCompare(b.costType),
    );
    buckets.push({
      currency,
      rows: rowsOut,
      totals: {
        originalCommitted: round2(rowsOut.reduce((s, r) => s + r.originalCommitted, 0)),
        changeOrders: round2(rowsOut.reduce((s, r) => s + r.changeOrders, 0)),
        revisedCommitted: round2(rowsOut.reduce((s, r) => s + r.revisedCommitted, 0)),
        pendingCommitted: round2(rowsOut.reduce((s, r) => s + r.pendingCommitted, 0)),
        invoiced: round2(rowsOut.reduce((s, r) => s + r.invoiced, 0)),
        retainageHeld: round2(rowsOut.reduce((s, r) => s + r.retainageHeld, 0)),
        balanceToFinish: round2(rowsOut.reduce((s, r) => s + r.balanceToFinish, 0)),
      },
    });
  }

  if (currencies.size > 1) {
    notes.push(
      `This project holds commitments in ${[...currencies].sort().join(", ")}. Totals are ` +
        "reported per currency and are never added together.",
    );
  }

  return {
    projectId,
    mixedCurrency: currencies.size > 1,
    currencies: [...currencies].sort(),
    buckets,
    budgetId: budget?.id ?? null,
    budgetCurrency: budget?.currency ?? null,
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* Buyout log                                                          */
/* ------------------------------------------------------------------ */

export interface BuyoutRow {
  budgetLineItemId: string;
  costCode: string;
  costType: string;
  description: string;
  revisedBudget: number;
  committed: number;
  pendingCommitted: number;
  /** revisedBudget - committed - pendingCommitted; negative is an overrun */
  projectedSavings: number;
  percentBoughtOut: Unknowable;
  /** true once nothing further is expected to be bought against this line */
  boughtOut: boolean;
  commitmentCount: number;
  currency: string;
  /** commitments in another currency that could not be counted against this line */
  excludedCurrencies: string[];
}

export interface BuyoutLog {
  projectId: string;
  budgetId: string | null;
  currency: string | null;
  rows: BuyoutRow[];
  totals: {
    revisedBudget: number;
    committed: number;
    pendingCommitted: number;
    projectedSavings: number;
  } | null;
  /** budget lines with no commitment against them at all — the buyout to come */
  unboughtLineCount: number;
  notes: string[];
}

/**
 * THE BUYOUT LOG — budget versus committed versus projected savings, per
 * budget line. This is the single report that tells a project whether it is
 * making or losing money on procurement, and it is why every commitment SOV
 * line carries `budgetLineItemId`.
 *
 * `projectedSavings` is deliberately budget minus BOTH committed and pending:
 * a line that is 60% bought out with an out-for-signature subcontract for the
 * rest has no savings, it has a decision that has already been taken.
 */
export async function buyoutLog(
  db: Db,
  companyId: string,
  projectId: string,
  options: { budgetId?: string | null } = {},
): Promise<BuyoutLog> {
  const notes: string[] = [];
  const budget = await resolveBudget(db, companyId, projectId, options.budgetId ?? null);
  if (!budget) {
    return {
      projectId,
      budgetId: null,
      currency: null,
      rows: [],
      totals: null,
      unboughtLineCount: 0,
      notes: [
        "No active budget on this project. A buyout log compares committed cost against " +
          "budget, so with no budget there is nothing to compare and no figure is invented. " +
          "Create and activate a budget first.",
      ],
    };
  }

  const rows = await db
    .select({
      budgetLineItemId: commitmentSovLines.budgetLineItemId,
      revisedScheduledValue: commitmentSovLines.revisedScheduledValue,
      commitmentId: commitments.id,
      status: commitments.status,
      currency: commitments.currency,
    })
    .from(commitmentSovLines)
    .innerJoin(commitments, eq(commitments.id, commitmentSovLines.commitmentId))
    .where(
      and(eq(commitmentSovLines.companyId, companyId), eq(commitmentSovLines.projectId, projectId)),
    );

  const committed = new Map<string, number>();
  const pending = new Map<string, number>();
  const counts = new Map<string, Set<string>>();
  const excluded = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.budgetLineItemId) continue;
    if ((DEAD_COMMITMENT_STATUSES as readonly string[]).includes(r.status)) continue;
    const currency = r.currency.toUpperCase();
    if (currency !== budget.currency) {
      const set = excluded.get(r.budgetLineItemId) ?? new Set<string>();
      set.add(currency);
      excluded.set(r.budgetLineItemId, set);
      continue;
    }
    if (isCommittedCommitment(r.status)) {
      committed.set(
        r.budgetLineItemId,
        (committed.get(r.budgetLineItemId) ?? 0) + r.revisedScheduledValue,
      );
    } else if (isPendingCommitment(r.status)) {
      pending.set(
        r.budgetLineItemId,
        (pending.get(r.budgetLineItemId) ?? 0) + r.revisedScheduledValue,
      );
    } else {
      continue;
    }
    const set = counts.get(r.budgetLineItemId) ?? new Set<string>();
    set.add(r.commitmentId);
    counts.set(r.budgetLineItemId, set);
  }

  const out: BuyoutRow[] = budget.lines.map((line) => {
    const c = round2(committed.get(line.id) ?? 0);
    const p = round2(pending.get(line.id) ?? 0);
    const ex = [...(excluded.get(line.id) ?? new Set<string>())].sort();
    return {
      budgetLineItemId: line.id,
      costCode: line.costCode,
      costType: line.costType,
      description: line.description,
      revisedBudget: round2(line.revisedBudget),
      committed: c,
      pendingCommitted: p,
      projectedSavings: round2(line.revisedBudget - c - p),
      percentBoughtOut:
        line.revisedBudget === 0
          ? unknown("This budget line is zero, so percent bought out is undefined.")
          : known(round4((c / line.revisedBudget) * 100)),
      boughtOut: c > 0 && p === 0 && c + 0.005 >= line.revisedBudget,
      commitmentCount: counts.get(line.id)?.size ?? 0,
      currency: budget.currency,
      excludedCurrencies: ex,
    };
  });
  out.sort((a, b) => a.costCode.localeCompare(b.costCode) || a.costType.localeCompare(b.costType));

  if (out.some((r) => r.excludedCurrencies.length > 0)) {
    notes.push(
      `Some commitments on this project are not written in ${budget.currency} and are excluded ` +
        "from the buyout comparison — they are listed per row in excludedCurrencies.",
    );
  }

  return {
    projectId,
    budgetId: budget.id,
    currency: budget.currency,
    rows: out,
    totals: {
      revisedBudget: round2(out.reduce((s, r) => s + r.revisedBudget, 0)),
      committed: round2(out.reduce((s, r) => s + r.committed, 0)),
      pendingCommitted: round2(out.reduce((s, r) => s + r.pendingCommitted, 0)),
      projectedSavings: round2(out.reduce((s, r) => s + r.projectedSavings, 0)),
    },
    unboughtLineCount: out.filter((r) => r.commitmentCount === 0).length,
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* Per-commitment financial position                                   */
/* ------------------------------------------------------------------ */

export interface CommitmentPosition {
  commitmentId: string;
  currency: string;
  originalCommitmentSum: number;
  approvedChangeSum: number;
  pendingChangeSum: number;
  draftChangeSum: number;
  revisedCommitmentSum: number;
  /** revised sum plus everything priced but unsigned — the worst case */
  potentialCommitmentSum: number;
  totalInvoiced: number;
  totalPaid: number;
  retainageHeld: number;
  retainageReleased: number;
  balanceToFinish: number;
  /** invoiced but not yet paid out */
  outstandingToPay: number;
  percentInvoiced: Unknowable;
  percentPaid: Unknowable;
  invoiceCount: number;
  reconciliation: { checks: ReconciliationCheck[]; reconciles: boolean };
}

/** The full money position of one commitment, every figure derivable from rows. */
export async function commitmentPosition(db: Db, commitmentId: string): Promise<CommitmentPosition> {
  const rows = await db.select().from(commitments).where(eq(commitments.id, commitmentId)).limit(1);
  const c = rows[0];
  if (!c) throw new Error(`commitmentPosition: commitment ${commitmentId} is gone`);
  const invoiceRows = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(eq(invoices.commitmentId, commitmentId));
  const reconciliation = await reconcile(db, commitmentId);
  const pct = (num: number, den: number, what: string): Unknowable =>
    den === 0
      ? unknown(`The revised commitment sum is zero, so ${what} is undefined.`)
      : known(round4((num / den) * 100));
  return {
    commitmentId,
    currency: c.currency,
    originalCommitmentSum: c.originalCommitmentSum,
    approvedChangeSum: c.approvedChangeSum,
    pendingChangeSum: c.pendingChangeSum,
    draftChangeSum: c.draftChangeSum,
    revisedCommitmentSum: c.revisedCommitmentSum,
    potentialCommitmentSum: round2(c.revisedCommitmentSum + c.pendingChangeSum + c.draftChangeSum),
    totalInvoiced: c.totalInvoiced,
    totalPaid: c.totalPaid,
    retainageHeld: c.retainageHeld,
    retainageReleased: c.retainageReleased,
    balanceToFinish: c.balanceToFinish,
    outstandingToPay: round2(c.totalInvoiced - c.totalPaid),
    percentInvoiced: pct(c.totalInvoiced, c.revisedCommitmentSum, "percent invoiced"),
    percentPaid: pct(c.totalPaid, c.revisedCommitmentSum, "percent paid"),
    invoiceCount: invoiceRows.length,
    reconciliation,
  };
}

/* ------------------------------------------------------------------ */
/* Budget resolution                                                   */
/* ------------------------------------------------------------------ */

interface ResolvedBudget {
  id: string;
  currency: string;
  lines: Array<{
    id: string;
    costCode: string;
    costType: string;
    description: string;
    revisedBudget: number;
  }>;
}

/**
 * The budget every commitment rollup compares against: the explicitly named
 * one, else the project's active budget. Never "the most recent" — a budget
 * that has not been marked active is a scenario, and comparing committed cost
 * against a scenario is how a project convinces itself it is under budget.
 */
async function resolveBudget(
  db: Db,
  companyId: string,
  projectId: string,
  budgetId: string | null,
): Promise<ResolvedBudget | null> {
  const where = budgetId
    ? and(
        eq(budgets.id, budgetId),
        eq(budgets.companyId, companyId),
        eq(budgets.projectId, projectId),
      )
    : and(
        eq(budgets.companyId, companyId),
        eq(budgets.projectId, projectId),
        eq(budgets.isActive, 1),
      );
  const rows = await db.select().from(budgets).where(where).limit(1);
  const budget = rows[0];
  if (!budget) return null;
  const lines = await db
    .select()
    .from(budgetLineItems)
    .where(eq(budgetLineItems.budgetId, budget.id));
  return {
    id: budget.id,
    currency: budget.currency.toUpperCase(),
    lines: lines.map((l) => ({
      id: l.id,
      costCode: l.costCode,
      costType: l.costType,
      description: l.description,
      revisedBudget: l.revisedBudget,
    })),
  };
}
