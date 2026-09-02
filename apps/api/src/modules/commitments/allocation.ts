import { and, eq, inArray } from "drizzle-orm";
import { commitmentSovLines } from "@constructos/db";
import type { COST_TYPES } from "@constructos/shared";
import { badRequest } from "../../lib/errors.js";
import type { Db } from "../../lib/db.js";
import { deriveSovLine, type ChangeLineAllocation } from "./arithmetic.js";
import { insertSovLine, sovContext } from "./sov.js";
import { round2, type CommitmentRow } from "./shared.js";

/**
 * THE ONE WRITER of change-order value onto a commitment's schedule of values.
 *
 * Both the commitments module (CCO approval) and the change-management module
 * (executing a commitment package) land money on the schedule. Before this
 * file they did it with two implementations that disagreed about which column
 * holds the value — one wrote `changeOrderValue`, the other `scheduledValue` —
 * and the next recompute quietly moved executed change value into the
 * ORIGINAL commitment sum. Now there is one implementation, it takes a `db`
 * that may be a transaction, and the identity it keeps is:
 *
 *   an appended change-order line carries scheduledValue = 0 and the whole of
 *   its value in changeOrderValue; an existing line takes the delta on
 *   changeOrderValue and never on scheduledValue.
 *
 * That is what keeps `originalCommitmentSum = Σ scheduledValue` equal to the
 * original subcontract however many change orders land on it.
 */

export interface ApplyAllocationResult {
  /** SOV lines whose changeOrderValue moved */
  updatedSovLineIds: string[];
  /** SOV lines appended for new scope */
  appendedSovLineIds: string[];
}

/**
 * Validate an allocation against the commitment's CURRENT schedule of values.
 * Returns the missing ids rather than throwing so callers can phrase the
 * refusal for their own context (create, patch or approval).
 */
export async function missingSovLineIds(
  db: Db,
  commitmentId: string,
  allocation: readonly ChangeLineAllocation[],
): Promise<string[]> {
  const sovIds = [
    ...new Set(
      allocation.map((l) => l.sovLineId).filter((id): id is string => typeof id === "string"),
    ),
  ];
  if (sovIds.length === 0) return [];
  const rows = await db
    .select({ id: commitmentSovLines.id })
    .from(commitmentSovLines)
    .where(
      and(eq(commitmentSovLines.commitmentId, commitmentId), inArray(commitmentSovLines.id, sovIds)),
    );
  const found = new Set(rows.map((r) => r.id));
  return sovIds.filter((id) => !found.has(id));
}

/**
 * Write an allocation onto the schedule of values. Runs on whatever `db` it
 * is handed — pass the transaction, so a failure on the third line rolls back
 * the first two and the change order's own status update with them.
 */
export async function applyChangeAllocation(
  db: Db,
  commitment: CommitmentRow,
  changeNumber: number,
  allocation: readonly ChangeLineAllocation[],
  options: { changeOrderPackageId?: string | null; lineNumberPrefix?: string } = {},
): Promise<ApplyAllocationResult> {
  const missing = await missingSovLineIds(db, commitment.id, allocation);
  if (missing.length > 0) {
    throw badRequest(
      `sovLineId ${missing.join(", ")} no longer exists on this commitment's schedule of values. ` +
        "The allocation was made against a line that has since been deleted — re-allocate the " +
        "change order before approving it, or its value would silently vanish.",
      { missingSovLineIds: missing },
    );
  }

  const byExisting = new Map<string, number>();
  const appended: ChangeLineAllocation[] = [];
  for (const line of allocation) {
    if (line.sovLineId) {
      byExisting.set(line.sovLineId, round2((byExisting.get(line.sovLineId) ?? 0) + line.amount));
    } else {
      appended.push(line);
    }
  }

  const updatedSovLineIds: string[] = [];
  if (byExisting.size > 0) {
    const rows = await db
      .select()
      .from(commitmentSovLines)
      .where(inArray(commitmentSovLines.id, [...byExisting.keys()]));
    for (const row of rows) {
      const delta = byExisting.get(row.id) ?? 0;
      const changeOrderValue = round2(row.changeOrderValue + delta);
      const derived = deriveSovLine({
        scheduledValue: row.scheduledValue,
        changeOrderValue,
        previousBilled: row.previousBilled,
        previousStoredMaterials: row.previousStoredMaterials,
        thisPeriodWork: row.thisPeriodWork,
        thisPeriodStoredMaterials: row.thisPeriodStoredMaterials,
        materialsPresentlyStored: row.materialsPresentlyStored,
        retainagePercent: row.retainagePercent,
        retainageReleased: row.retainageReleased,
      });
      await db
        .update(commitmentSovLines)
        .set({
          changeOrderValue,
          revisedScheduledValue: derived.revisedScheduledValue,
          totalCompletedAndStored: derived.totalCompletedAndStored,
          percentComplete: derived.percentComplete,
          balanceToFinish: derived.balanceToFinish,
          retainageHeld: derived.retainageHeld,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(commitmentSovLines.id, row.id));
      updatedSovLineIds.push(row.id);
    }
  }

  const appendedSovLineIds: string[] = [];
  if (appended.length > 0) {
    const ctx = await sovContext(db, commitment.companyId, commitment.projectId, commitment);
    const prefix = options.lineNumberPrefix ?? `CO-${String(changeNumber).padStart(3, "0")}`;
    let n = 0;
    for (const line of appended) {
      n += 1;
      let lineNumber = `${prefix}.${n}`;
      let suffix = 1;
      while (ctx.taken.has(lineNumber)) {
        suffix += 1;
        lineNumber = `${prefix}.${n}-${suffix}`;
      }
      const id = await insertSovLine(
        ctx,
        {
          lineNumber,
          description: line.description,
          costCode: line.costCode,
          ...(line.costType ? { costType: line.costType as (typeof COST_TYPES)[number] } : {}),
          budgetLineItemId: line.budgetLineItemId,
          scheduledValue: 0,
          retainagePercent: commitment.defaultRetainagePercent,
          ...(commitment.kind === "purchase_order" && commitment.taxable === 1
            ? { taxable: true, taxPercent: commitment.taxPercent }
            : {}),
        },
        {
          isChangeOrderLine: true,
          changeOrderPackageId: options.changeOrderPackageId ?? null,
        },
      );
      const derived = deriveSovLine({
        scheduledValue: 0,
        changeOrderValue: line.amount,
        previousBilled: 0,
        previousStoredMaterials: 0,
        thisPeriodWork: 0,
        thisPeriodStoredMaterials: 0,
        materialsPresentlyStored: 0,
        retainagePercent: commitment.defaultRetainagePercent,
        retainageReleased: 0,
      });
      await db
        .update(commitmentSovLines)
        .set({
          changeOrderValue: round2(line.amount),
          revisedScheduledValue: derived.revisedScheduledValue,
          balanceToFinish: derived.balanceToFinish,
          percentComplete: derived.percentComplete,
          retainageHeld: derived.retainageHeld,
        })
        .where(eq(commitmentSovLines.id, id));
      appendedSovLineIds.push(id);
    }
  }
  return { updatedSovLineIds, appendedSovLineIds };
}
