import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { changeLineItems } from "@constructos/db";
import { conflict, notFound } from "../../lib/errors.js";
import type { Db } from "../../lib/db.js";
import { applyMarkupStack, round2 } from "./arithmetic.js";
import {
  actorOf,
  buildLineRow,
  changeLineSchema,
  companyOf,
  ledgerChange,
  loadLines,
  nowIso,
  projectOf,
  type ChangeGates,
  type ChangeLineParent,
  type ChangeLineRow,
} from "./shared.js";

/**
 * Cost lines behave identically wherever they hang — the same fields, the same
 * derivation, the same refusals — so they are registered once per host rather
 * than reimplemented per stage. What differs between hosts is only WHEN the
 * lines are frozen, and that is the one thing a host has to say.
 */
export interface LineHost {
  parentType: ChangeLineParent;
  /** ledger object type for the parent record */
  objectType: string;
  /** e.g. "/projects/:projectId/change-events/:eventId" */
  basePath: string;
  /** the route param holding the parent id */
  paramName: string;
  /** human noun for refusals */
  label: string;
  fetch: (
    db: Db,
    id: string,
    companyId: string,
    projectId: string,
  ) => Promise<{ id: string; reference: string; status: string; changeEventId: string | null }>;
  /** statuses in which the line set may no longer move */
  frozenStatuses: readonly string[];
  /** re-derive the parent's stored totals after a line moves */
  afterChange?: (db: Db, parentId: string) => Promise<void>;
}

export function lineTotals(lines: readonly ChangeLineRow[]) {
  const stack = applyMarkupStack(
    lines.map((l) => ({
      costAmount: l.costAmount,
      costType: l.costType,
      quantity: l.quantity,
      taxAmount: l.taxAmount,
    })),
    [],
  );
  const revenueSubtotal = round2(lines.reduce((s, l) => s + l.revenueAmount, 0));
  return {
    lineCount: lines.length,
    costSubtotal: stack.costSubtotal,
    costByType: stack.costByType,
    revenueSubtotal,
    lineMarkupTotal: round2(lines.reduce((s, l) => s + l.markupAmount, 0)),
    taxTotal: stack.taxTotal,
    margin: round2(revenueSubtotal - stack.costSubtotal),
  };
}

export function registerLineRoutes(
  app: FastifyInstance,
  gates: ChangeGates,
  host: LineHost,
): void {
  const idOf = (req: FastifyRequest): string =>
    (req.params as Record<string, string>)[host.paramName]!;

  async function loadParent(req: FastifyRequest) {
    return host.fetch(app.db, idOf(req), companyOf(req), projectOf(req));
  }

  function assertEditable(parent: { reference: string; status: string }): void {
    if (host.frozenStatuses.includes(parent.status)) {
      throw conflict(
        `${host.label} ${parent.reference} is "${parent.status}" — its cost lines are frozen. ` +
          "A priced position that can be edited after it has been put to someone is not a position.",
      );
    }
  }

  app.post(`${host.basePath}/lines`, { preHandler: gates.standard }, async (req, reply) => {
    const body = changeLineSchema.parse(req.body);
    const parent = await loadParent(req);
    assertEditable(parent);
    const existing = await loadLines(app.db, host.parentType, parent.id);
    const row = buildLineRow(
      {
        companyId: companyOf(req),
        projectId: projectOf(req),
        changeEventId: parent.changeEventId,
        createdBy: actorOf(req),
      },
      host.parentType,
      parent.id,
      body,
      (existing.length + 1) * 10,
    );
    await app.db.insert(changeLineItems).values(row);
    await host.afterChange?.(app.db, parent.id);
    const lines = await loadLines(app.db, host.parentType, parent.id);
    const totals = lineTotals(lines);
    await ledgerChange(app.db, req, "update", host.objectType, parent.id, {
      reference: parent.reference,
      lineAdded: row.id,
      costAmount: row.costAmount,
      revenueAmount: row.revenueAmount,
      costSubtotal: totals.costSubtotal,
    });
    return reply.status(201).send({ line: row, totals });
  });

  app.get(`${host.basePath}/lines`, { preHandler: gates.read }, async (req) => {
    const parent = await loadParent(req);
    const lines = await loadLines(app.db, host.parentType, parent.id);
    return { lines, totals: lineTotals(lines) };
  });

  app.patch(`${host.basePath}/lines/:lineId`, { preHandler: gates.standard }, async (req) => {
    const { lineId } = req.params as { lineId: string };
    const body = changeLineSchema.partial().parse(req.body);
    const parent = await loadParent(req);
    assertEditable(parent);
    const existing = await loadLines(app.db, host.parentType, parent.id);
    const line = existing.find((l) => l.id === lineId);
    if (!line) throw notFound(`Change line not found on this ${host.label}`);

    const pick = <K extends keyof typeof body>(
      key: K,
      current: unknown,
    ): (typeof body)[K] | typeof current =>
      body[key] !== undefined ? body[key] : current;

    const merged = buildLineRow(
      {
        companyId: companyOf(req),
        projectId: projectOf(req),
        changeEventId: line.changeEventId,
        createdBy: line.createdBy,
      },
      host.parentType,
      parent.id,
      {
        description: (pick("description", line.description) as string) ?? line.description,
        lineNumber: pick("lineNumber", line.lineNumber) as string | null,
        sortOrder: (pick("sortOrder", line.sortOrder) as number) ?? line.sortOrder,
        costCodeId: pick("costCodeId", line.costCodeId) as string | null,
        costCode: pick("costCode", line.costCode) as string | null,
        costType: pick("costType", line.costType) as never,
        budgetLineItemId: pick("budgetLineItemId", line.budgetLineItemId) as string | null,
        unit: pick("unit", line.unit) as string | null,
        quantity: pick("quantity", line.quantity) as number | null,
        unitRate: pick("unitRate", line.unitRate) as number | null,
        // A patch that moves the quantity or the rate must re-derive the cost,
        // so the stored amount is dropped unless the caller restated it.
        costAmount:
          body.costAmount !== undefined
            ? body.costAmount
            : body.quantity !== undefined || body.unitRate !== undefined
              ? null
              : line.costAmount,
        revenueAmount:
          body.revenueAmount !== undefined
            ? body.revenueAmount
            : body.quantity !== undefined ||
                body.unitRate !== undefined ||
                body.costAmount !== undefined ||
                body.markupPercent !== undefined ||
                body.markupKind !== undefined
              ? null
              : line.revenueAmount,
        markupKind: pick("markupKind", line.markupKind) as never,
        markupPercent: pick("markupPercent", line.markupPercent) as number | null,
        markupAmount: pick("markupAmount", line.markupAmount) as number | null,
        taxPercent: pick("taxPercent", line.taxPercent) as number | null,
        taxAmount: pick("taxAmount", line.taxAmount) as number | null,
        vendorId: pick("vendorId", line.vendorId) as string | null,
        commitmentSovLineId: pick("commitmentSovLineId", line.commitmentSovLineId) as string | null,
        primeContractSovLineId: pick(
          "primeContractSovLineId",
          line.primeContractSovLineId,
        ) as string | null,
        notes: pick("notes", line.notes) as string | null,
        detail: (pick("detail", line.detail) as Record<string, unknown>) ?? {},
      },
      line.sortOrder,
    );

    await app.db
      .update(changeLineItems)
      .set({
        lineNumber: merged.lineNumber,
        sortOrder: merged.sortOrder,
        costCodeId: merged.costCodeId,
        costCode: merged.costCode,
        costType: merged.costType,
        budgetLineItemId: merged.budgetLineItemId,
        description: merged.description,
        unit: merged.unit,
        quantity: merged.quantity,
        unitRate: merged.unitRate,
        costAmount: merged.costAmount,
        revenueAmount: merged.revenueAmount,
        markupKind: merged.markupKind,
        markupPercent: merged.markupPercent,
        markupAmount: merged.markupAmount,
        taxPercent: merged.taxPercent,
        taxAmount: merged.taxAmount,
        vendorId: merged.vendorId,
        commitmentSovLineId: merged.commitmentSovLineId,
        primeContractSovLineId: merged.primeContractSovLineId,
        notes: merged.notes,
        detail: merged.detail,
        updatedAt: nowIso(),
      })
      .where(eq(changeLineItems.id, lineId));
    await host.afterChange?.(app.db, parent.id);
    const after = await loadLines(app.db, host.parentType, parent.id);
    const totals = lineTotals(after);
    await ledgerChange(app.db, req, "update", host.objectType, parent.id, {
      reference: parent.reference,
      lineUpdated: lineId,
      costSubtotal: totals.costSubtotal,
    });
    return { line: after.find((l) => l.id === lineId), totals };
  });

  app.delete(`${host.basePath}/lines/:lineId`, { preHandler: gates.standard }, async (req) => {
    const { lineId } = req.params as { lineId: string };
    const parent = await loadParent(req);
    assertEditable(parent);
    const existing = await loadLines(app.db, host.parentType, parent.id);
    if (!existing.some((l) => l.id === lineId)) {
      throw notFound(`Change line not found on this ${host.label}`);
    }
    await app.db.delete(changeLineItems).where(eq(changeLineItems.id, lineId));
    await host.afterChange?.(app.db, parent.id);
    const after = await loadLines(app.db, host.parentType, parent.id);
    const totals = lineTotals(after);
    await ledgerChange(app.db, req, "update", host.objectType, parent.id, {
      reference: parent.reference,
      lineDeleted: lineId,
      costSubtotal: totals.costSubtotal,
    });
    return { deleted: lineId, totals };
  });
}
