import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { budgetLineItems, commitmentSovLines } from "@constructos/db";
import { COST_TYPES, SOV_BILLING_METHODS } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import type { Db } from "../../lib/db.js";
import { deriveSovLine, resolveScheduledValue } from "./arithmetic.js";
import {
  budgetLineIdsFor,
  recomputeCommitmentTotals,
  syncBudgetCommitted,
} from "./rollups.js";
import {
  detailSchema,
  fetchCommitment,
  isCommittedCommitment,
  ledger,
  moneySchema,
  percentSchema,
  requireCommitmentsLevel,
  round2,
  type CommitmentRow,
} from "./shared.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

export const sovLineInputSchema = z.object({
  /** text, not integer — "03.1" is a legitimate SOV line number */
  lineNumber: z.string().min(1).max(40).optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  costCodeId: z.string().min(1).max(64).nullable().optional(),
  costCode: z.string().min(1).max(50).nullable().optional(),
  costType: z.enum(COST_TYPES).optional(),
  budgetLineItemId: z.string().min(1).max(64).nullable().optional(),
  description: z.string().min(1).max(2000),
  billingMethod: z.enum(SOV_BILLING_METHODS).optional(),
  unit: z.string().min(1).max(20).nullable().optional(),
  quantity: z.number().finite().nullable().optional(),
  unitRate: z.number().finite().nullable().optional(),
  scheduledValue: moneySchema.optional(),
  retainagePercent: percentSchema.optional(),
  taxable: z.boolean().optional(),
  taxCode: z.string().min(1).max(40).nullable().optional(),
  taxPercent: percentSchema.nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  detail: detailSchema.optional(),
});
export type SovLineInput = z.infer<typeof sovLineInputSchema>;

/** After approval the commitment sum moves only through change orders. */
const sovLinePostApprovalPatchSchema = z.object({
  description: z.string().min(1).max(2000).optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  costCodeId: z.string().min(1).max(64).nullable().optional(),
  costCode: z.string().min(1).max(50).nullable().optional(),
  costType: z.enum(COST_TYPES).optional(),
  budgetLineItemId: z.string().min(1).max(64).nullable().optional(),
  billingMethod: z.enum(SOV_BILLING_METHODS).optional(),
  unit: z.string().min(1).max(20).nullable().optional(),
  taxCode: z.string().min(1).max(40).nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  detail: detailSchema.optional(),
});

const sovLinePatchSchema = sovLinePostApprovalPatchSchema.extend({
  quantity: z.number().finite().nullable().optional(),
  unitRate: z.number().finite().nullable().optional(),
  scheduledValue: moneySchema.optional(),
  retainagePercent: percentSchema.optional(),
  taxable: z.boolean().optional(),
  taxPercent: percentSchema.nullable().optional(),
});

export const sovReplaceSchema = z.object({
  lines: z.array(sovLineInputSchema).max(2000),
});

/** Fields that stop being editable the moment the commitment is approved. */
const FROZEN_AFTER_APPROVAL = [
  "scheduledValue",
  "quantity",
  "unitRate",
  "retainagePercent",
  "taxable",
  "taxPercent",
] as const;

/* ------------------------------------------------------------------ */
/* Insert helper — shared with commitment creation                     */
/* ------------------------------------------------------------------ */

export interface InsertSovContext {
  db: Db;
  companyId: string;
  projectId: string;
  commitment: Pick<CommitmentRow, "id" | "kind" | "defaultRetainagePercent">;
  /** line numbers already taken on this commitment */
  taken: Set<string>;
  nextAuto: { value: number };
  nextSort: { value: number };
}

/**
 * Resolve and insert one schedule-of-values line.
 *
 * Two pieces of care live here. First, a line bound to a budget line inherits
 * that line's cost code and cost type unless the caller overrode them, so the
 * two sides of the budget/commitment join cannot be coded differently by
 * accident — which is the single most common reason a buyout log does not
 * reconcile. Second, a measured line's scheduled value IS quantity x rate: an
 * explicit third figure that disagrees is refused rather than accepted, since
 * the disagreement is the interesting fact, not the rounding.
 */
export async function insertSovLine(
  ctx: InsertSovContext,
  input: SovLineInput,
  options: { isChangeOrderLine?: boolean; changeOrderPackageId?: string | null } = {},
): Promise<string> {
  let costCode = input.costCode ?? null;
  let costType: string = input.costType ?? "other";
  let budgetLineItemId = input.budgetLineItemId ?? null;

  if (budgetLineItemId) {
    const rows = await ctx.db
      .select()
      .from(budgetLineItems)
      .where(
        and(
          eq(budgetLineItems.id, budgetLineItemId),
          eq(budgetLineItems.companyId, ctx.companyId),
          eq(budgetLineItems.projectId, ctx.projectId),
        ),
      )
      .limit(1);
    const budgetLine = rows[0];
    if (!budgetLine) {
      throw badRequest(
        `budgetLineItemId ${budgetLineItemId} does not reference a budget line on this project. ` +
          "A commitment consumes budget; it cannot be bound to another project's budget.",
      );
    }
    if (budgetLine.status === "void") {
      throw badRequest("That budget line is void and cannot take new committed cost.");
    }
    costCode = input.costCode ?? budgetLine.costCode;
    costType = input.costType ?? budgetLine.costType;
  }

  const resolved = resolveScheduledValue(input.scheduledValue, input.quantity, input.unitRate);
  if (resolved.error) throw badRequest(resolved.error);

  let lineNumber = input.lineNumber;
  if (!lineNumber) {
    do {
      lineNumber = String(ctx.nextAuto.value);
      ctx.nextAuto.value += 1;
    } while (ctx.taken.has(lineNumber));
  }
  if (ctx.taken.has(lineNumber)) {
    throw conflict(`SOV line number "${lineNumber}" already exists on this commitment`);
  }
  ctx.taken.add(lineNumber);

  const isChangeOrderLine = options.isChangeOrderLine ? 1 : 0;
  const retainagePercent = input.retainagePercent ?? ctx.commitment.defaultRetainagePercent;
  const derived = deriveSovLine({
    scheduledValue: resolved.value,
    changeOrderValue: 0,
    previousBilled: 0,
    previousStoredMaterials: 0,
    thisPeriodWork: 0,
    thisPeriodStoredMaterials: 0,
    materialsPresentlyStored: 0,
    retainagePercent,
    retainageReleased: 0,
  });

  const id = newId("csl");
  const sortOrder = input.sortOrder ?? ctx.nextSort.value;
  ctx.nextSort.value = Math.max(ctx.nextSort.value, sortOrder) + 1;

  await ctx.db.insert(commitmentSovLines).values({
    id,
    companyId: ctx.companyId,
    projectId: ctx.projectId,
    commitmentId: ctx.commitment.id,
    lineNumber,
    sortOrder,
    costCodeId: input.costCodeId ?? null,
    costCode,
    costType,
    budgetLineItemId,
    description: input.description,
    billingMethod: input.billingMethod ?? "percent_complete",
    unit: input.unit ?? null,
    quantity: input.quantity ?? null,
    unitRate: input.unitRate ?? null,
    scheduledValue: resolved.value,
    changeOrderValue: 0,
    revisedScheduledValue: derived.revisedScheduledValue,
    percentComplete: derived.percentComplete,
    balanceToFinish: derived.balanceToFinish,
    retainagePercent,
    retainageHeld: derived.retainageHeld,
    isChangeOrderLine,
    changeOrderPackageId: options.changeOrderPackageId ?? null,
    /* PO lines carry tax; a subcontract line does not */
    taxable: ctx.commitment.kind === "purchase_order" && input.taxable ? 1 : 0,
    taxCode: input.taxCode ?? null,
    taxPercent: input.taxPercent ?? null,
    notes: input.notes ?? null,
    detail: input.detail ?? {},
  });
  return id;
}

/** Build the insert context for a commitment, reading the numbers already used. */
export async function sovContext(
  db: Db,
  companyId: string,
  projectId: string,
  commitment: Pick<CommitmentRow, "id" | "kind" | "defaultRetainagePercent">,
): Promise<InsertSovContext> {
  const existing = await db
    .select({ lineNumber: commitmentSovLines.lineNumber, sortOrder: commitmentSovLines.sortOrder })
    .from(commitmentSovLines)
    .where(eq(commitmentSovLines.commitmentId, commitment.id));
  const taken = new Set(existing.map((r) => r.lineNumber));
  const maxNumeric = existing.reduce((max, r) => {
    const n = Number(r.lineNumber);
    return Number.isInteger(n) && n > max ? n : max;
  }, 0);
  const maxSort = existing.reduce((max, r) => Math.max(max, r.sortOrder), -1);
  return {
    db,
    companyId,
    projectId,
    commitment,
    taken,
    nextAuto: { value: maxNumeric + 1 },
    nextSort: { value: maxSort + 1 },
  };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/**
 * The schedule of values IS the commitment sum. Every route in this file ends
 * by recomputing the commitment's materialized totals from the lines, so the
 * identity `SIGMA revisedScheduledValue = revisedCommitmentSum` cannot be
 * broken by any sequence of calls — there is no second place the sum lives.
 */
export const sovRoutes: FastifyPluginAsync = async (app) => {
  const companyGate = [app.authenticate, app.requireCompany];

  async function fetchLine(lineId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(commitmentSovLines)
      .where(
        and(eq(commitmentSovLines.id, lineId), eq(commitmentSovLines.companyId, companyId)),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Commitment SOV line not found");
    return row;
  }

  async function afterWrite(commitment: CommitmentRow): Promise<void> {
    await recomputeCommitmentTotals(app.db, commitment.id);
    const ids = await budgetLineIdsFor(app.db, commitment.id);
    if (ids.length > 0) {
      await syncBudgetCommitted(app.db, commitment.companyId, commitment.projectId, ids);
    }
  }

  const listLines = (commitmentId: string) =>
    app.db
      .select()
      .from(commitmentSovLines)
      .where(eq(commitmentSovLines.commitmentId, commitmentId))
      .orderBy(asc(commitmentSovLines.sortOrder), asc(commitmentSovLines.lineNumber));

  app.get("/commitments/:commitmentId/sov", { preHandler: companyGate }, async (req, reply) => {
    const { commitmentId } = req.params as { commitmentId: string };
    const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "read");
    const lines = await listLines(commitmentId);
    return {
      commitmentId,
      currency: commitment.currency,
      lines,
      totals: {
        scheduledValue: round2(lines.reduce((s, l) => s + l.scheduledValue, 0)),
        changeOrderValue: round2(lines.reduce((s, l) => s + l.changeOrderValue, 0)),
        revisedScheduledValue: round2(lines.reduce((s, l) => s + l.revisedScheduledValue, 0)),
        totalCompletedAndStored: round2(
          lines.reduce((s, l) => s + l.totalCompletedAndStored, 0),
        ),
        retainageHeld: round2(lines.reduce((s, l) => s + l.retainageHeld, 0)),
        balanceToFinish: round2(lines.reduce((s, l) => s + l.balanceToFinish, 0)),
      },
      /** the identity, asserted on every read so a drift is visible immediately */
      identity: {
        statement: "SIGMA revisedScheduledValue = commitment.revisedCommitmentSum",
        sovTotal: round2(lines.reduce((s, l) => s + l.revisedScheduledValue, 0)),
        commitmentSum: commitment.revisedCommitmentSum,
        reconciles:
          Math.abs(
            round2(lines.reduce((s, l) => s + l.revisedScheduledValue, 0)) -
              commitment.revisedCommitmentSum,
          ) <= 0.005,
      },
    };
  });

  app.post(
    "/commitments/:commitmentId/sov-lines",
    { preHandler: companyGate },
    async (req, reply) => {
      const { commitmentId } = req.params as { commitmentId: string };
      const body = sovLineInputSchema.parse(req.body);
      const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, commitment.projectId, "standard");
      assertSovEditable(commitment);
      const ctx = await sovContext(app.db, req.companyId!, commitment.projectId, commitment);
      const id = await insertSovLine(ctx, body);
      await afterWrite(commitment);
      await ledger(app.db, req, "create", "commitment_sov_line", id, {
        commitmentId,
        lineNumber: body.lineNumber ?? null,
        scheduledValue: body.scheduledValue ?? null,
      }, commitment.projectId);
      return reply.status(201).send(await fetchLine(id, req.companyId!));
    },
  );

  /**
   * Replace the whole schedule in one call — how a SOV actually arrives, as a
   * spreadsheet. Refused once anything has been billed against the existing
   * lines: replacing a schedule that has been invoiced would orphan the
   * invoice lines that point at it.
   */
  app.put("/commitments/:commitmentId/sov", { preHandler: companyGate }, async (req, reply) => {
    const { commitmentId } = req.params as { commitmentId: string };
    const body = sovReplaceSchema.parse(req.body);
    const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "standard");
    assertSovEditable(commitment);

    const existing = await listLines(commitmentId);
    const billed = existing.filter((l) => l.totalCompletedAndStored !== 0);
    if (billed.length > 0) {
      throw conflict(
        `${billed.length} SOV line(s) have been billed against. Replace the schedule before ` +
          "billing starts, or move the value with a change order.",
      );
    }
    const changeOrderLines = existing.filter((l) => l.isChangeOrderLine === 1);
    if (changeOrderLines.length > 0) {
      throw conflict(
        `${changeOrderLines.length} line(s) on this schedule were appended by a change order ` +
          "and cannot be replaced wholesale. Reverse the change order instead.",
      );
    }

    const previousBudgetLines = await budgetLineIdsFor(app.db, commitmentId);
    await app.db
      .delete(commitmentSovLines)
      .where(eq(commitmentSovLines.commitmentId, commitmentId));
    const ctx = await sovContext(app.db, req.companyId!, commitment.projectId, commitment);
    for (const line of body.lines) await insertSovLine(ctx, line);
    await recomputeCommitmentTotals(app.db, commitmentId);
    const nowBudgetLines = await budgetLineIdsFor(app.db, commitmentId);
    const touched = [...new Set([...previousBudgetLines, ...nowBudgetLines])];
    if (touched.length > 0) {
      await syncBudgetCommitted(app.db, req.companyId!, commitment.projectId, touched);
    }
    await ledger(app.db, req, "update", "commitment", commitmentId, {
      sovReplaced: true,
      lineCount: body.lines.length,
    }, commitment.projectId);
    const lines = await listLines(commitmentId);
    return { commitmentId, lines, lineCount: lines.length };
  });

  app.patch("/commitment-sov-lines/:lineId", { preHandler: companyGate }, async (req, reply) => {
    const { lineId } = req.params as { lineId: string };
    const line = await fetchLine(lineId, req.companyId!);
    const commitment = await fetchCommitment(app.db, line.commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "standard");
    assertSovMutable(commitment);

    const frozen = isCommittedCommitment(commitment.status);
    if (frozen) {
      /*
       * Zod strips unknown keys, and silently dropping a figure somebody typed
       * is worse than refusing it: they would believe the schedule changed.
       * Name the frozen fields back to the caller instead.
       */
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const offending = FROZEN_AFTER_APPROVAL.filter((k) => raw[k] !== undefined);
      if (offending.length > 0) {
        throw conflict(
          `${offending.join(", ")} cannot be changed on a ${commitment.status} commitment. ` +
            "The commitment sum moves only through change orders once it is approved — raise " +
            "one instead.",
        );
      }
    }
    const body = frozen
      ? sovLinePostApprovalPatchSchema.parse(req.body)
      : sovLinePatchSchema.parse(req.body);
    const patch = body as z.infer<typeof sovLinePatchSchema>;

    if (patch.budgetLineItemId) {
      const rows = await app.db
        .select({ id: budgetLineItems.id })
        .from(budgetLineItems)
        .where(
          and(
            eq(budgetLineItems.id, patch.budgetLineItemId),
            eq(budgetLineItems.companyId, req.companyId!),
            eq(budgetLineItems.projectId, commitment.projectId),
          ),
        )
        .limit(1);
      if (!rows[0]) {
        throw badRequest("budgetLineItemId does not reference a budget line on this project");
      }
    }

    const quantity = patch.quantity !== undefined ? patch.quantity : line.quantity;
    const unitRate = patch.unitRate !== undefined ? patch.unitRate : line.unitRate;
    let scheduledValue = line.scheduledValue;
    if (!frozen) {
      const resolved = resolveScheduledValue(
        patch.scheduledValue !== undefined
          ? patch.scheduledValue
          : patch.quantity !== undefined || patch.unitRate !== undefined
            ? undefined
            : line.scheduledValue,
        quantity,
        unitRate,
      );
      if (resolved.error) throw badRequest(resolved.error);
      scheduledValue = resolved.value;
    }
    const retainagePercent = frozen
      ? line.retainagePercent
      : (patch.retainagePercent ?? line.retainagePercent);

    const derived = deriveSovLine({
      scheduledValue,
      changeOrderValue: line.changeOrderValue,
      previousBilled: line.previousBilled,
      previousStoredMaterials: line.previousStoredMaterials,
      thisPeriodWork: line.thisPeriodWork,
      thisPeriodStoredMaterials: line.thisPeriodStoredMaterials,
      materialsPresentlyStored: line.materialsPresentlyStored,
      retainagePercent,
      retainageReleased: line.retainageReleased,
    });

    const previousBudgetLine = line.budgetLineItemId;
    await app.db
      .update(commitmentSovLines)
      .set({
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        ...(patch.costCodeId !== undefined ? { costCodeId: patch.costCodeId } : {}),
        ...(patch.costCode !== undefined ? { costCode: patch.costCode } : {}),
        ...(patch.costType !== undefined ? { costType: patch.costType } : {}),
        ...(patch.budgetLineItemId !== undefined
          ? { budgetLineItemId: patch.budgetLineItemId }
          : {}),
        ...(patch.billingMethod !== undefined ? { billingMethod: patch.billingMethod } : {}),
        ...(patch.unit !== undefined ? { unit: patch.unit } : {}),
        ...(patch.taxCode !== undefined ? { taxCode: patch.taxCode } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
        ...(frozen
          ? {}
          : {
              quantity,
              unitRate,
              scheduledValue,
              retainagePercent,
              ...(patch.taxable !== undefined
                ? { taxable: commitment.kind === "purchase_order" && patch.taxable ? 1 : 0 }
                : {}),
              ...(patch.taxPercent !== undefined ? { taxPercent: patch.taxPercent } : {}),
            }),
        revisedScheduledValue: derived.revisedScheduledValue,
        totalCompletedAndStored: derived.totalCompletedAndStored,
        percentComplete: derived.percentComplete,
        balanceToFinish: derived.balanceToFinish,
        retainageHeld: derived.retainageHeld,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(commitmentSovLines.id, lineId));

    await recomputeCommitmentTotals(app.db, commitment.id);
    const touched = [
      ...new Set(
        [previousBudgetLine, patch.budgetLineItemId ?? previousBudgetLine].filter(
          (v): v is string => typeof v === "string",
        ),
      ),
    ];
    if (touched.length > 0) {
      await syncBudgetCommitted(app.db, req.companyId!, commitment.projectId, touched);
    }
    await ledger(app.db, req, "update", "commitment_sov_line", lineId, {
      commitmentId: commitment.id,
      changed: Object.keys(patch),
      frozenFinancials: frozen,
    }, commitment.projectId);
    return fetchLine(lineId, req.companyId!);
  });

  app.delete("/commitment-sov-lines/:lineId", { preHandler: companyGate }, async (req, reply) => {
    const { lineId } = req.params as { lineId: string };
    const line = await fetchLine(lineId, req.companyId!);
    const commitment = await fetchCommitment(app.db, line.commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "standard");
    assertSovEditable(commitment);
    if (line.isChangeOrderLine === 1) {
      throw conflict(
        "This line was appended by a change order. Reverse the change order rather than " +
          "deleting the line it created — deleting it would leave the change order register " +
          "and the schedule of values disagreeing.",
      );
    }
    if (line.totalCompletedAndStored !== 0) {
      throw conflict("This line has been billed against and cannot be deleted");
    }
    await app.db.delete(commitmentSovLines).where(eq(commitmentSovLines.id, lineId));
    await recomputeCommitmentTotals(app.db, commitment.id);
    if (line.budgetLineItemId) {
      await syncBudgetCommitted(app.db, req.companyId!, commitment.projectId, [
        line.budgetLineItemId,
      ]);
    }
    await ledger(app.db, req, "delete", "commitment_sov_line", lineId, {
      commitmentId: commitment.id,
      lineNumber: line.lineNumber,
    }, commitment.projectId);
    return reply.status(204).send();
  });
};

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

/** No structural change to a schedule once the commitment is signed or dead. */
export function assertSovEditable(commitment: CommitmentRow): void {
  if (isCommittedCommitment(commitment.status)) {
    throw conflict(
      `This commitment is ${commitment.status}. Its schedule of values is fixed — the ` +
        "commitment sum moves only through change orders from here.",
    );
  }
  assertSovMutable(commitment);
}

/** Nothing at all may be touched on a terminated or void commitment. */
export function assertSovMutable(commitment: CommitmentRow): void {
  if (commitment.status === "terminated" || commitment.status === "void") {
    throw conflict(`This commitment is ${commitment.status} and can no longer be edited`);
  }
}
