import { and, eq, inArray } from "drizzle-orm";
import {
  budgetChanges,
  budgetLineItems,
  budgets,
  changeOrderPackages,
  changeOrderRequests,
  commitmentChanges,
  commitmentSovLines,
  commitments,
  potentialChangeOrders,
  primeContractChanges,
  primeContractSovLines,
  primeContracts,
} from "@constructos/db";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { badRequest, conflict } from "../../lib/errors.js";
import type { Db } from "../../lib/db.js";
import {
  allocateProRata,
  checkIdentity,
  deriveBudgetLine,
  formatMoney,
  round2,
  type Identity,
} from "./arithmetic.js";
import { applyChangeAllocation } from "../commitments/allocation.js";
import { recomputeCommitmentTotals, syncBudgetCommitted } from "../commitments/rollups.js";
import { loadLines, loadLinesForParents, nowIso, pad3, todayIso, type ChangeLineRow } from "./shared.js";

/**
 * EXECUTION — the only transaction on the platform that moves revenue, cost and
 * budget at the same instant.
 *
 * Everything before this point is a position: an event is a fact, a PCO is an
 * estimate, a COR is an ask, an approval is a promise. Execution is where the
 * promise becomes money, and it lands in three places at once:
 *
 *   prime_contract  (kind = "prime_contract")   revenue up
 *     -> one prime_contract_changes row, status "executed"
 *     -> appended prime_contract_sov_lines, so the G703 still reconciles to
 *        the ORIGINAL contract sum with the change orders beside it
 *     -> the contract's four sum columns re-derived from every change row
 *     -> a budget_changes row of kind "owner_change", applied to the budget's
 *        approved-changes column
 *
 *   commitment      (kind = "commitment")       cost up
 *     -> one commitment_changes row, status "executed"
 *     -> appended commitment_sov_lines
 *     -> the commitment's sum columns re-derived
 *     -> committed cost re-derived on every budget line the commitment touches
 *
 * THREE RULES HOLD THROUGHOUT.
 *
 * 1. Nothing is incremented in place. Every rollup is re-derived from the rows
 *    underneath it, because a total that is only ever added to drifts, and a
 *    drifted contract sum is a dispute.
 * 2. The parts sum to the whole, exactly. Allocation across cost codes is
 *    pro-rata with the rounding residual parked deterministically, so Σ SOV
 *    lines = the change amount = Σ budget legs to the cent.
 * 3. It is all-or-nothing. A change order that raised the contract sum but
 *    failed to move the budget is worse than one that never executed, so every
 *    write is inside one transaction and any refusal rolls the lot back.
 */

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

export interface ExecuteCtx {
  db: Db;
  companyId: string;
  projectId: string;
  actorId: string;
}

export interface ExecuteOptions {
  signedDate?: string | null;
  executedDate?: string | null;
}

export interface AllocationLegOut {
  key: string;
  costCode: string | null;
  costType: string | null;
  budgetLineItemId: string | null;
  description: string;
  amount: number;
  residual: number;
}

export interface BudgetEffect {
  applied: boolean;
  budgetId: string | null;
  budgetChangeId: string | null;
  linesMoved: number;
  amount: number;
  reasons: string[];
  forecastNotes: string[];
}

export interface ExecutionResult {
  packageId: string;
  reference: string;
  kind: string;
  amount: number;
  currency: string;
  scale: number;
  legs: AllocationLegOut[];
  /** prime side */
  primeContractChangeId: string | null;
  primeContractChangeReference: string | null;
  appendedSovLineIds: string[];
  contractSums: {
    originalContractSum: number;
    approvedChangeSum: number;
    pendingChangeSum: number;
    draftChangeSum: number;
    revisedContractSum: number;
  } | null;
  /** commitment side */
  commitmentChangeId: string | null;
  commitmentChangeReference: string | null;
  commitmentSums: {
    originalCommitmentSum: number;
    approvedChangeSum: number;
    pendingChangeSum: number;
    draftChangeSum: number;
    revisedCommitmentSum: number;
  } | null;
  budget: BudgetEffect;
  identities: Identity[];
}

/* ------------------------------------------------------------------ */
/* Status buckets                                                      */
/* ------------------------------------------------------------------ */

/**
 * Which change-order statuses are already inside a contract sum. These mirror
 * the prime-contract and commitment modules exactly: only EXECUTED changes are
 * in the prime contract sum, while a commitment counts an approved change as
 * committed cost the moment it is approved. The asymmetry is real — an owner
 * change is money we may bill only once it is signed, a subcontract change is
 * money we owe as soon as we agree it.
 */
const PRIME_IN_SUM = ["executed"];
const PRIME_PENDING = [
  "pending_pricing",
  "pending_in_house_review",
  "pending_owner_approval",
  "revise_and_resubmit",
  "approved",
];
const COMMITMENT_IN_SUM = ["approved", "executed"];
const COMMITMENT_PENDING = [
  "pending_pricing",
  "pending_in_house_review",
  "pending_owner_approval",
  "revise_and_resubmit",
];
const DRAFT = ["draft"];

function bucketSums(
  original: number,
  rows: ReadonlyArray<{ status: string; amount: number }>,
  inSum: readonly string[],
  pending: readonly string[],
) {
  let approved = 0;
  let pendingTotal = 0;
  let draft = 0;
  for (const row of rows) {
    if (inSum.includes(row.status)) approved += row.amount;
    else if (pending.includes(row.status)) pendingTotal += row.amount;
    else if (DRAFT.includes(row.status)) draft += row.amount;
  }
  return {
    approvedChangeSum: round2(approved),
    pendingChangeSum: round2(pendingTotal),
    draftChangeSum: round2(draft),
    revised: round2(original + approved),
  };
}

/* ------------------------------------------------------------------ */
/* Allocation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Spread the executed amount across the cost lines behind it.
 *
 * The weight is the line's REVENUE amount on the prime side and its COST
 * amount on the commitment side, which is the same statement made twice: money
 * is allocated in proportion to the figure that side of the ledger deals in.
 * A partially approved COR simply scales — an owner who granted 90% of the ask
 * granted 90% of every cost code, unless somebody says otherwise line by line,
 * and `scale` records that they did not.
 */
export function buildLegs(
  lines: readonly ChangeLineRow[],
  target: number,
  side: "revenue" | "cost",
): { legs: AllocationLegOut[]; scale: number } {
  const weightOf = (l: ChangeLineRow): number =>
    side === "revenue" ? l.revenueAmount + l.taxAmount : l.costAmount + l.taxAmount;
  const allocation = allocateProRata(
    lines.map((l) => ({ key: l.id, weight: weightOf(l) })),
    target,
  );
  if (!allocation.ok) throw badRequest(allocation.error);
  const byId = new Map(lines.map((l) => [l.id, l]));
  return {
    scale: allocation.scale,
    legs: allocation.legs.map((leg) => {
      const line = byId.get(leg.key)!;
      return {
        key: leg.key,
        costCode: line.costCode,
        costType: line.costType,
        budgetLineItemId: line.budgetLineItemId,
        description: line.description,
        amount: leg.amount,
        residual: leg.residual,
      };
    }),
  };
}

/** Unique, stable SOV line numbers for the appended change-order lines. */
function sovLineNumbers(changeNumber: number, count: number, taken: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    let candidate = `CO-${pad3(changeNumber)}.${i}`;
    let suffix = 1;
    while (taken.has(candidate)) {
      suffix += 1;
      candidate = `CO-${pad3(changeNumber)}.${i}-${suffix}`;
    }
    taken.add(candidate);
    out.push(candidate);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Budget                                                              */
/* ------------------------------------------------------------------ */

interface BudgetPlan {
  budgetId: string;
  currency: string;
  legs: Array<{ lineItemId: string; costCode: string; costType: string; amount: number }>;
  /** the budget line rows, pre-read, keyed by id */
  rows: Map<string, typeof budgetLineItems.$inferSelect>;
}

/**
 * Resolve every allocation leg onto a line of the ACTIVE budget, or refuse.
 *
 * A leg resolves by `budgetLineItemId` when the change line carries one, and
 * otherwise by cost code and cost type. What it never does is invent a budget
 * line: an owner-funded increase landing on a cost code nobody planned is a
 * decision for a human, and the refusal names exactly which lines are
 * uncoded so the fix is one PATCH away.
 */
async function planBudget(
  ctx: ExecuteCtx,
  legs: readonly AllocationLegOut[],
  contractCurrency: string,
): Promise<{ plan: BudgetPlan | null; reasons: string[] }> {
  const active = await ctx.db
    .select()
    .from(budgets)
    .where(
      and(
        eq(budgets.companyId, ctx.companyId),
        eq(budgets.projectId, ctx.projectId),
        eq(budgets.isActive, 1),
      ),
    )
    .limit(1);
  const budget = active[0];
  if (!budget) {
    return {
      plan: null,
      reasons: [
        "This project has no active budget, so there is no budget column for this change to move. " +
          "The contract side executed on its own.",
      ],
    };
  }
  if (budget.currency.toUpperCase() !== contractCurrency.toUpperCase()) {
    throw conflict(
      `Budget ${budget.reference} is denominated in ${budget.currency} and this change is in ` +
        `${contractCurrency}. Money is never converted silently here — align the budget currency ` +
        "or raise the change against a contract in the budget's currency.",
    );
  }
  if (budget.status === "closed") {
    throw conflict(
      `Budget ${budget.reference} is closed and cannot take an owner change. Reopen it, or ` +
        "execute this change against the budget that succeeded it.",
    );
  }

  const rows = await ctx.db
    .select()
    .from(budgetLineItems)
    .where(eq(budgetLineItems.budgetId, budget.id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byCode = new Map(rows.map((r) => [`${r.costCode}::${r.costType}`, r]));

  const resolved: BudgetPlan["legs"] = [];
  const unresolved: string[] = [];
  for (const leg of legs) {
    let row = leg.budgetLineItemId ? byId.get(leg.budgetLineItemId) : undefined;
    if (!row && leg.costCode) row = byCode.get(`${leg.costCode}::${leg.costType ?? "other"}`);
    if (!row) {
      unresolved.push(
        `"${leg.description}" (${leg.costCode ?? "no cost code"} / ${leg.costType ?? "no cost type"}, ` +
          `${formatMoney(leg.amount)})`,
      );
      continue;
    }
    if (row.status === "void") {
      throw conflict(
        `Budget line ${row.costCode} / ${row.costType} is void and cannot take an owner-funded ` +
          "increase. Point the change line at a live budget line first.",
      );
    }
    resolved.push({
      lineItemId: row.id,
      costCode: row.costCode,
      costType: row.costType,
      amount: leg.amount,
    });
  }
  if (unresolved.length > 0) {
    throw badRequest(
      `These change lines do not resolve to a line of budget ${budget.reference}: ` +
        `${unresolved.join("; ")}. Set a cost code (or a budgetLineItemId) on them — an ` +
        "owner-funded increase has to land somewhere a cost report can find it.",
      { unresolved },
    );
  }

  // Merge legs that land on the same budget line: one movement per line.
  const merged = new Map<string, BudgetPlan["legs"][number]>();
  for (const leg of resolved) {
    const existing = merged.get(leg.lineItemId);
    if (existing) existing.amount = round2(existing.amount + leg.amount);
    else merged.set(leg.lineItemId, { ...leg });
  }

  for (const leg of merged.values()) {
    const row = byId.get(leg.lineItemId)!;
    const next = round2(row.originalBudget + row.budgetModifications + row.approvedChanges + leg.amount);
    if (next < 0) {
      throw conflict(
        `Executing this change would take budget line ${row.costCode} / ${row.costType} to ` +
          `${formatMoney(next)}. A budget line cannot hold a negative revised budget — recode the ` +
          "credit, or source it from a line that can carry it.",
      );
    }
  }

  return {
    plan: { budgetId: budget.id, currency: budget.currency, legs: [...merged.values()], rows: byId },
    reasons: [],
  };
}

/** Re-derive the budget's materialized rollups from its lines. */
async function recomputeBudgetTotals(db: Db, budgetId: string): Promise<void> {
  const rows = await db.select().from(budgetLineItems).where(eq(budgetLineItems.budgetId, budgetId));
  const t = {
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
  for (const l of rows) {
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
  const totals = Object.fromEntries(
    Object.entries(t).map(([k, v]) => [k, round2(v)]),
  ) as typeof t;
  await db
    .update(budgets)
    .set({ ...totals, totalsCalculatedAt: nowIso(), updatedAt: nowIso() })
    .where(eq(budgets.id, budgetId));
}


/* ------------------------------------------------------------------ */
/* Prime contract execution                                            */
/* ------------------------------------------------------------------ */

export async function executePrimePackage(
  ctx: ExecuteCtx,
  pkg: typeof changeOrderPackages.$inferSelect,
  options: ExecuteOptions,
): Promise<ExecutionResult> {
  const { db, companyId, projectId, actorId } = ctx;
  if (!pkg.primeContractId) {
    throw badRequest("A prime-contract package must name the prime contract it executes against.");
  }
  const [contract] = await db
    .select()
    .from(primeContracts)
    .where(
      and(
        eq(primeContracts.id, pkg.primeContractId),
        eq(primeContracts.companyId, companyId),
        eq(primeContracts.projectId, projectId),
      ),
    )
    .limit(1);
  if (!contract) throw conflict("The prime contract behind this package no longer exists.");
  if (contract.status === "void" || contract.status === "terminated") {
    throw conflict(
      `Prime contract ${contract.reference} is ${contract.status} — no change can be executed ` +
        "under it.",
    );
  }
  if (contract.executed !== 1) {
    throw conflict(
      `Prime contract ${contract.reference} has not been executed. A change order amends a signed ` +
        "contract; there is nothing here to amend yet.",
    );
  }

  const cors = await db
    .select()
    .from(changeOrderRequests)
    .where(inArray(changeOrderRequests.id, pkg.memberIds.length > 0 ? pkg.memberIds : ["-"]));
  const lines = await loadLinesForParents(db, "change_order_request", pkg.memberIds);
  if (lines.length === 0) {
    throw badRequest(
      `${pkg.reference} has no cost lines behind it. There is nothing to append to the schedule of ` +
        "values, and a change order that cannot be billed is not a change order.",
    );
  }

  const { legs, scale } = buildLegs(lines, pkg.amount, "revenue");
  const { plan, reasons: budgetReasons } = await planBudget(ctx, legs, contract.currency);

  // Numbers are allocated BEFORE the transaction: nextRecordNumber runs its own
  // transaction, and nesting one inside this one would deadlock the single
  // embedded connection under test.
  const changeNumber = await nextRecordNumber(db, projectId, "prime_contract_change");
  const budgetChangeNumber = plan ? await nextRecordNumber(db, plan.budgetId, "budget_change") : null;

  const existingSov = await db
    .select({ lineNumber: primeContractSovLines.lineNumber, sortOrder: primeContractSovLines.sortOrder })
    .from(primeContractSovLines)
    .where(eq(primeContractSovLines.primeContractId, contract.id));
  const taken = new Set(existingSov.map((l) => l.lineNumber));
  const lineNumbers = sovLineNumbers(changeNumber, legs.length, taken);
  const baseSort = existingSov.reduce((max, l) => Math.max(max, l.sortOrder), 0) + 10;

  const priorChanges = await db
    .select({ status: primeContractChanges.status, amount: primeContractChanges.amount })
    .from(primeContractChanges)
    .where(eq(primeContractChanges.primeContractId, contract.id));
  const sums = bucketSums(
    contract.originalContractSum,
    [...priorChanges, { status: "executed", amount: pkg.amount }],
    PRIME_IN_SUM,
    PRIME_PENDING,
  );

  const changeId = newId("pcc");
  const changeReference = `PCCO-${pad3(changeNumber)}`;
  const budgetChangeId = plan ? newId("bch") : null;
  const now = nowIso();
  const executedDate = options.executedDate ?? todayIso();
  const appendedSovLineIds: string[] = [];
  const forecastNotes = new Set<string>();
  let budgetLinesMoved = 0;

  await db.transaction(async (tx) => {
    await tx.insert(primeContractChanges).values({
      id: changeId,
      companyId,
      projectId,
      primeContractId: contract.id,
      number: changeNumber,
      reference: changeReference,
      changeOrderPackageId: pkg.id,
      title: pkg.title,
      description: pkg.description,
      reason: (cors.find((c) => c.reason)?.reason ?? null) as string | null,
      status: "executed",
      amount: round2(pkg.amount),
      scheduleImpactDays: pkg.scheduleImpactDays,
      lines: legs.map((leg) => ({
        sovLineId: null,
        costCode: leg.costCode,
        costType: leg.costType,
        description: leg.description,
        amount: leg.amount,
      })),
      revisedContractSum: sums.revised,
      requestedDate: pkg.submittedAt ? pkg.submittedAt.slice(0, 10) : null,
      executedDate,
      signedChangeOrderReceivedDate: options.signedDate ?? pkg.signedDate ?? null,
      detail: { changeOrderPackageId: pkg.id, memberCorIds: pkg.memberIds, allocationScale: scale },
      createdBy: pkg.createdBy,
      submittedBy: pkg.submittedBy,
      submittedAt: pkg.submittedAt,
      approvedBy: pkg.approvedBy,
      approvedAt: pkg.approvedAt,
      executedBy: actorId,
    });

    for (const [i, leg] of legs.entries()) {
      const sovId = newId("sov");
      appendedSovLineIds.push(sovId);
      await tx.insert(primeContractSovLines).values({
        id: sovId,
        companyId,
        projectId,
        primeContractId: contract.id,
        lineNumber: lineNumbers[i]!,
        sortOrder: baseSort + i,
        costCode: leg.costCode,
        costType: leg.costType,
        budgetLineItemId: leg.budgetLineItemId,
        description: `${changeReference} — ${leg.description}`,
        billingMethod: "percent_complete",
        // An appended change-order line carries its value in the scheduled
        // value column with isChangeOrderLine = 1: the G703 then reconciles
        // base scope to the ORIGINAL contract sum and change-order scope to
        // the approved change sum, as two separate legs.
        scheduledValue: leg.amount,
        changeOrderValue: 0,
        revisedScheduledValue: leg.amount,
        balanceToFinish: leg.amount,
        retainagePercent: contract.defaultRetainagePercent,
        isChangeOrderLine: 1,
        changeOrderPackageId: pkg.id,
        detail: { changeId, legKey: leg.key },
      });
    }

    await tx
      .update(primeContracts)
      .set({
        approvedChangeSum: sums.approvedChangeSum,
        pendingChangeSum: sums.pendingChangeSum,
        draftChangeSum: sums.draftChangeSum,
        revisedContractSum: sums.revised,
        balanceToFinish: round2(sums.revised - contract.totalBilled),
        totalsCalculatedAt: now,
        updatedAt: now,
      })
      .where(eq(primeContracts.id, contract.id));

    if (plan && budgetChangeId && budgetChangeNumber !== null) {
      const requestedBy = pkg.submittedBy ?? pkg.createdBy;
      const approvedBy = pkg.approvedBy;
      if (!approvedBy) {
        throw conflict("This package has no approver recorded; it cannot fund a budget change.");
      }
      if (approvedBy === requestedBy) {
        throw conflict(
          "Segregation of duties: the budget movement this change order funds would be requested " +
            "and approved by the same person.",
        );
      }
      await tx.insert(budgetChanges).values({
        id: budgetChangeId,
        companyId,
        projectId,
        budgetId: plan.budgetId,
        number: budgetChangeNumber,
        reference: `BC-${pad3(budgetChangeNumber)}`,
        kind: "owner_change",
        title: `${pkg.reference} — ${pkg.title}`,
        description: pkg.description,
        reason: "Owner-funded change order",
        status: "approved",
        lines: plan.legs.map((leg) => ({
          lineItemId: leg.lineItemId,
          costCode: leg.costCode,
          costType: leg.costType,
          amount: leg.amount,
        })),
        fromLineItemId: null,
        toLineItemId: plan.legs[0]?.lineItemId ?? null,
        amount: round2(plan.legs.reduce((s, l) => s + Math.abs(l.amount), 0)),
        // An owner change is the ONE budget movement with a non-zero net
        // effect: it is new money, not a transfer between existing lines.
        netEffect: round2(pkg.amount),
        effectiveDate: executedDate,
        sourceType: "change_order_package",
        sourceId: pkg.id,
        requestedBy,
        requestedAt: pkg.submittedAt ?? now,
        approvedBy,
        approvedAt: pkg.approvedAt ?? now,
        detail: { primeContractChangeId: changeId, allocationScale: scale },
        createdBy: pkg.createdBy,
      });

      for (const leg of plan.legs) {
        const row = plan.rows.get(leg.lineItemId)!;
        const approvedChanges = round2(row.approvedChanges + leg.amount);
        const derived = deriveBudgetLine({
          originalBudget: row.originalBudget,
          budgetModifications: row.budgetModifications,
          approvedChanges,
          jobToDateCosts: row.jobToDateCosts,
          forecastMethod: row.forecastMethod,
          forecastToComplete: row.forecastToComplete,
          percentComplete: row.percentComplete,
        });
        for (const reason of derived.reasons) forecastNotes.add(reason);
        await tx
          .update(budgetLineItems)
          .set({
            approvedChanges,
            revisedBudget: derived.revisedBudget,
            forecastToComplete: derived.forecastToComplete,
            forecastFinal: derived.forecastFinal,
            projectedOverUnder: derived.projectedOverUnder,
            updatedAt: now,
          })
          .where(eq(budgetLineItems.id, leg.lineItemId));
        budgetLinesMoved += 1;
      }
      // A locked budget that has taken an approved change is "revised" — the
      // lock still means "no free-hand edits", which is the point of it.
      const [budgetRow] = await tx
        .select({ status: budgets.status })
        .from(budgets)
        .where(eq(budgets.id, plan.budgetId))
        .limit(1);
      if (budgetRow?.status === "locked") {
        await tx.update(budgets).set({ status: "revised", updatedAt: now }).where(eq(budgets.id, plan.budgetId));
      }
    }

    await tx
      .update(changeOrderPackages)
      .set({
        status: "executed",
        executedAt: now,
        executedBy: actorId,
        signedDate: options.signedDate ?? pkg.signedDate ?? executedDate,
        primeContractChangeId: changeId,
        budgetChangeId,
        updatedAt: now,
      })
      .where(eq(changeOrderPackages.id, pkg.id));
  });

  if (plan) await recomputeBudgetTotals(db, plan.budgetId);

  const legTotal = round2(legs.reduce((s, l) => s + l.amount, 0));
  const budgetTotal = plan ? round2(plan.legs.reduce((s, l) => s + l.amount, 0)) : 0;
  const identities: Identity[] = [
    checkIdentity("Σ appended SOV lines = package amount", legTotal, pkg.amount),
    checkIdentity(
      "originalContractSum + approvedChangeSum = revisedContractSum",
      contract.originalContractSum + sums.approvedChangeSum,
      sums.revised,
    ),
    checkIdentity(
      "contract sum movement = package amount",
      sums.revised - contract.revisedContractSum,
      pkg.amount,
    ),
  ];
  if (plan) {
    identities.push(
      checkIdentity("Σ budget change legs = package amount", budgetTotal, pkg.amount),
    );
  }

  return {
    packageId: pkg.id,
    reference: pkg.reference,
    kind: pkg.kind,
    amount: round2(pkg.amount),
    currency: contract.currency,
    scale,
    legs,
    primeContractChangeId: changeId,
    primeContractChangeReference: changeReference,
    appendedSovLineIds,
    contractSums: {
      originalContractSum: round2(contract.originalContractSum),
      approvedChangeSum: sums.approvedChangeSum,
      pendingChangeSum: sums.pendingChangeSum,
      draftChangeSum: sums.draftChangeSum,
      revisedContractSum: sums.revised,
    },
    commitmentChangeId: null,
    commitmentChangeReference: null,
    commitmentSums: null,
    budget: {
      applied: plan !== null,
      budgetId: plan?.budgetId ?? null,
      budgetChangeId,
      linesMoved: budgetLinesMoved,
      amount: budgetTotal,
      reasons: budgetReasons,
      forecastNotes: [...forecastNotes],
    },
    identities,
  };
}

/* ------------------------------------------------------------------ */
/* Commitment execution                                                */
/* ------------------------------------------------------------------ */

export async function executeCommitmentPackage(
  ctx: ExecuteCtx,
  pkg: typeof changeOrderPackages.$inferSelect,
  options: ExecuteOptions,
): Promise<ExecutionResult> {
  const { db, companyId, projectId, actorId } = ctx;
  if (!pkg.commitmentId) {
    throw badRequest("A commitment package must name the commitment it executes against.");
  }
  const [commitment] = await db
    .select()
    .from(commitments)
    .where(
      and(
        eq(commitments.id, pkg.commitmentId),
        eq(commitments.companyId, companyId),
        eq(commitments.projectId, projectId),
      ),
    )
    .limit(1);
  if (!commitment) throw conflict("The commitment behind this package no longer exists.");
  if (commitment.status === "void" || commitment.status === "terminated") {
    throw conflict(
      `Commitment ${commitment.reference} is ${commitment.status} — no change can be executed ` +
        "against it.",
    );
  }
  if (commitment.executed !== 1) {
    throw conflict(
      `Commitment ${commitment.reference} has not been executed. A change order amends a signed ` +
        "subcontract; sign the subcontract first.",
    );
  }

  const pcos = await db
    .select()
    .from(potentialChangeOrders)
    .where(inArray(potentialChangeOrders.id, pkg.memberIds.length > 0 ? pkg.memberIds : ["-"]));

  /*
   * Each PCO is allocated within itself: a PCO with a cost breakdown spreads
   * its own position across its own lines, and a PCO with none contributes a
   * single line. Allocating the WHOLE package pro-rata across every line would
   * silently move money between subcontract scopes that were priced
   * separately.
   */
  const legs: AllocationLegOut[] = [];
  for (const pco of pcos) {
    const pcoLines = await loadLines(db, "potential_change_order", pco.id);
    if (pcoLines.length === 0) {
      legs.push({
        key: pco.id,
        costCode: null,
        costType: "subcontract",
        budgetLineItemId: null,
        description: `${pco.reference} — ${pco.title}`,
        amount: round2(pco.amount),
        residual: 0,
      });
      continue;
    }
    const built = buildLegs(pcoLines, pco.amount, "cost");
    legs.push(
      ...built.legs.map((leg) => ({
        ...leg,
        description: `${pco.reference} — ${leg.description}`,
      })),
    );
  }
  if (legs.length === 0) {
    throw badRequest(`${pkg.reference} has nothing behind it to execute.`);
  }

  const changeNumber = await nextRecordNumber(db, projectId, `commitment_change:${commitment.id}`);

  const changeId = newId("cco");
  const changeReference = `${commitment.reference}-CCO-${pad3(changeNumber)}`;
  const now = nowIso();
  const executedDate = options.executedDate ?? todayIso();
  const budgetLineIds = [
    ...new Set(legs.map((l) => l.budgetLineItemId).filter((x): x is string => !!x)),
  ];

  /*
   * THE COMMITMENTS MODULE OWNS THE ARITHMETIC. The change order row is
   * written here; its value lands on the schedule of values through
   * `applyChangeAllocation` (scheduledValue 0 / changeOrderValue = amount, so
   * the ORIGINAL commitment sum stays the original subcontract), and the
   * header sums are re-derived by `recomputeCommitmentTotals` — the same two
   * functions a CCO approved inside the commitments module goes through.
   * One implementation, one identity, one transaction.
   */
  const allocation = legs.map((leg) => ({
    sovLineId: null,
    costCode: leg.costCode,
    costType: leg.costType,
    description: `${changeReference} — ${leg.description}`,
    amount: leg.amount,
    budgetLineItemId: leg.budgetLineItemId,
  }));
  let appendedSovLineIds: string[] = [];
  let totals: Awaited<ReturnType<typeof recomputeCommitmentTotals>> | null = null;
  let budgetLinesMoved = 0;
  await db.transaction(async (tx) => {
    const locked = await tx
      .select({ status: changeOrderPackages.status })
      .from(changeOrderPackages)
      .where(eq(changeOrderPackages.id, pkg.id))
      .for("update");
    if (locked[0]?.status !== "approved") {
      throw conflict(`${pkg.reference} is now ${locked[0]?.status ?? "gone"}; it was executed by somebody else a moment ago.`);
    }
    await tx.insert(commitmentChanges).values({
      id: changeId,
      companyId,
      projectId,
      commitmentId: commitment.id,
      number: changeNumber,
      reference: changeReference,
      changeOrderPackageId: pkg.id,
      potentialChangeOrderId: pcos.length === 1 ? pcos[0]!.id : null,
      title: pkg.title,
      description: pkg.description,
      reason: (pcos.find((p) => p.reason)?.reason ?? null) as string | null,
      status: "executed",
      amount: round2(pkg.amount),
      scheduleImpactDays: pkg.scheduleImpactDays,
      lines: allocation,
      revisedCommitmentSum: round2(commitment.revisedCommitmentSum + pkg.amount),
      requestedDate: pkg.submittedAt ? pkg.submittedAt.slice(0, 10) : null,
      executedDate,
      signedChangeOrderReceivedDate: options.signedDate ?? pkg.signedDate ?? null,
      detail: { changeOrderPackageId: pkg.id, memberPcoIds: pkg.memberIds },
      createdBy: pkg.createdBy,
      submittedBy: pkg.submittedBy,
      submittedAt: pkg.submittedAt,
      approvedBy: pkg.approvedBy,
      approvedAt: pkg.approvedAt,
      executedBy: actorId,
    });

    const applied = await applyChangeAllocation(tx, commitment, changeNumber, allocation, {
      changeOrderPackageId: pkg.id,
    });
    appendedSovLineIds = applied.appendedSovLineIds;
    totals = await recomputeCommitmentTotals(tx, commitment.id);
    await tx
      .update(commitmentChanges)
      .set({ revisedCommitmentSum: totals.revisedCommitmentSum })
      .where(eq(commitmentChanges.id, changeId));

    await tx
      .update(changeOrderPackages)
      .set({
        status: "executed",
        executedAt: now,
        executedBy: actorId,
        signedDate: options.signedDate ?? pkg.signedDate ?? executedDate,
        commitmentChangeId: changeId,
        updatedAt: now,
      })
      .where(eq(changeOrderPackages.id, pkg.id));

    if (budgetLineIds.length > 0) {
      const sync = await syncBudgetCommitted(tx, companyId, projectId, budgetLineIds);
      budgetLinesMoved = sync.budgetLinesUpdated;
    }
  });
  const sums = totals!;
  let budgetId: string | null = null;
  if (budgetLinesMoved > 0) {
    const [row] = await db
      .select({ budgetId: budgetLineItems.budgetId })
      .from(budgetLineItems)
      .where(eq(budgetLineItems.id, budgetLineIds[0]!))
      .limit(1);
    budgetId = row?.budgetId ?? null;
    if (budgetId) await recomputeBudgetTotals(db, budgetId);
  }

  const legTotal = round2(legs.reduce((s, l) => s + l.amount, 0));
  return {
    packageId: pkg.id,
    reference: pkg.reference,
    kind: pkg.kind,
    amount: round2(pkg.amount),
    currency: commitment.currency,
    scale: 1,
    legs,
    primeContractChangeId: null,
    primeContractChangeReference: null,
    appendedSovLineIds,
    contractSums: null,
    commitmentChangeId: changeId,
    commitmentChangeReference: changeReference,
    commitmentSums: {
      originalCommitmentSum: round2(sums.originalCommitmentSum),
      approvedChangeSum: round2(sums.approvedChangeSum),
      pendingChangeSum: round2(sums.pendingChangeSum),
      draftChangeSum: round2(sums.draftChangeSum),
      revisedCommitmentSum: round2(sums.revisedCommitmentSum),
    },
    budget: {
      applied: budgetLinesMoved > 0,
      budgetId,
      budgetChangeId: null,
      linesMoved: budgetLinesMoved,
      amount: legTotal,
      reasons:
        budgetLinesMoved > 0
          ? []
          : [
              "No change line on this package points at a budget line, so committed cost could not " +
                "be moved. Code the PCO lines to a budget line to close the loop.",
            ],
      forecastNotes: [],
    },
    identities: [
      checkIdentity("Σ appended SOV lines = package amount", legTotal, pkg.amount),
      checkIdentity(
        "originalCommitmentSum + approvedChangeSum = revisedCommitmentSum",
        sums.originalCommitmentSum + sums.approvedChangeSum,
        sums.revisedCommitmentSum,
      ),
      checkIdentity(
        "originalCommitmentSum is unchanged by execution",
        sums.originalCommitmentSum,
        commitment.originalCommitmentSum,
      ),
    ],
  };
}
