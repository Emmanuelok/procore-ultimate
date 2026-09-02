import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  bidLevellingEntries,
  bidLevellingItems,
  bidPackages,
  bidSubmissionLines,
  bidSubmissions,
  vendors,
} from "@constructos/db";
import {
  LEVELLING_ADJUSTMENT_REASONS,
  LEVELLING_INCLUSIONS,
  LEVELLING_ITEM_CATEGORIES,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import type { Db } from "../../lib/db.js";
import {
  assertSegregation,
  CENT,
  currencySchema,
  detailSchema,
  fetchPackage,
  isInContention,
  ledger,
  moneySchema,
  requireBiddingLevel,
  round2,
} from "./shared.js";
import { assertLateBidUsable, assertUnsealedForAnalysis, sealState } from "./sealing.js";
import {
  buildComparison,
  isPriceableCategory,
  levelEntry,
  type ComparisonSubmissionFacts,
  type LevellingEntryFacts,
  type LevellingItemFacts,
} from "./levelling-math.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const itemSchema = z.object({
  itemCode: z.string().max(60).nullable().optional(),
  description: z.string().trim().min(1).max(2000),
  category: z.enum(LEVELLING_ITEM_CATEGORIES).default("base_scope"),
  specSectionId: z.string().min(1).max(64).nullable().optional(),
  scopeReference: z.string().max(500).nullable().optional(),
  drawingSheetId: z.string().min(1).max(64).nullable().optional(),
  unit: z.string().max(30).nullable().optional(),
  estimatedQuantity: z.number().finite().nullable().optional(),
  engineersEstimate: moneySchema.nullable().optional(),
  currency: currencySchema.optional(),
  isMandatory: z.boolean().default(true),
  budgetLineItemId: z.string().min(1).max(64).nullable().optional(),
  costCodeId: z.string().min(1).max(64).nullable().optional(),
  notes: z.string().max(8000).nullable().optional(),
  position: z.number().int().min(0).max(100000).optional(),
  detail: detailSchema.optional(),
});

const itemsCreateSchema = z.union([
  itemSchema,
  z.object({ items: z.array(itemSchema).min(1).max(500) }),
]);

const entrySchema = z.object({
  levellingItemId: z.string().min(1).max(64),
  submissionId: z.string().min(1).max(64),
  submissionLineId: z.string().min(1).max(64).nullable().optional(),
  includedStatus: z.enum(LEVELLING_INCLUSIONS),
  asBidAmount: moneySchema.nullable().optional(),
  adjustmentAmount: moneySchema.default(0),
  adjustmentReason: z.enum(LEVELLING_ADJUSTMENT_REASONS).nullable().optional(),
  adjustmentNote: z.string().max(8000).nullable().optional(),
  currency: currencySchema.optional(),
  quantity: z.number().finite().nullable().optional(),
  unitRate: z.number().finite().nullable().optional(),
  isAssumption: z.boolean().optional(),
  clarificationRef: z.string().max(120).nullable().optional(),
  detail: detailSchema.optional(),
});

const entriesUpsertSchema = z.union([
  entrySchema,
  z.object({ entries: z.array(entrySchema).min(1).max(1000) }),
]);

/* ------------------------------------------------------------------ */
/* Loaders                                                             */
/* ------------------------------------------------------------------ */

export async function loadLevellingFacts(
  db: Db,
  packageId: string,
): Promise<{
  items: LevellingItemFacts[];
  entries: LevellingEntryFacts[];
  submissionRows: (typeof bidSubmissions.$inferSelect)[];
}> {
  const itemRows = await db
    .select()
    .from(bidLevellingItems)
    .where(eq(bidLevellingItems.packageId, packageId))
    .orderBy(asc(bidLevellingItems.position));
  const entryRows = await db
    .select()
    .from(bidLevellingEntries)
    .where(eq(bidLevellingEntries.packageId, packageId));
  const submissionRows = await db
    .select()
    .from(bidSubmissions)
    .where(eq(bidSubmissions.packageId, packageId))
    .orderBy(asc(bidSubmissions.createdAt));

  return {
    items: itemRows.map((i) => ({
      id: i.id,
      itemCode: i.itemCode,
      description: i.description,
      category: i.category as LevellingItemFacts["category"],
      isMandatory: i.isMandatory === 1,
      engineersEstimate: i.engineersEstimate,
      currency: i.currency,
    })),
    entries: entryRows.map((e) => ({
      levellingItemId: e.levellingItemId,
      submissionId: e.submissionId,
      includedStatus: e.includedStatus as LevellingEntryFacts["includedStatus"],
      asBidAmount: e.asBidAmount,
      adjustmentAmount: e.adjustmentAmount,
      adjustmentReason: e.adjustmentReason,
      currency: e.currency,
    })),
    submissionRows,
  };
}

export function comparisonFacts(
  rows: readonly (typeof bidSubmissions.$inferSelect)[],
): ComparisonSubmissionFacts[] {
  return rows.map((s) => ({
    id: s.id,
    vendorId: s.vendorId,
    reference: s.reference,
    status: s.status,
    currency: s.currency,
    totalAmount: s.totalAmount,
    // A late bid nobody has accepted is not in contention, and does not
    // block the comparison of the bids that arrived on time.
    inContention:
      isInContention(s.status) && !(s.isLate === 1 && !s.lateAcceptedBy),
  }));
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/**
 * LEVELLING ROUTES.
 *
 * The buyer defines the neutral scope rows; every bidder is mapped onto them;
 * the grid is the comparison. Two refusals carry the whole module's weight:
 *
 *  - Nothing here may run while the package is sealed and unopened. Levelling
 *    reads prices, and the seal exists so that nobody reads prices.
 *  - `POST /levelling/complete` refuses while a bidder STILL IN CONTENTION
 *    has left a mandatory row unanswered, naming the bidder and the row. A
 *    comparison declared complete over a gap is a comparison of two different
 *    scopes, and the award made on it will not survive the challenge.
 */
export const levellingRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("bidding", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("bidding", "standard"),
  ];
  const companyGate = [app.authenticate, app.requireCompany];

  async function fetchItem(itemId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(bidLevellingItems)
      .where(and(eq(bidLevellingItems.id, itemId), eq(bidLevellingItems.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Levelling item not found");
    return rows[0];
  }

  async function fetchEntry(entryId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(bidLevellingEntries)
      .where(and(eq(bidLevellingEntries.id, entryId), eq(bidLevellingEntries.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Levelling entry not found");
    return rows[0];
  }

  /* ---------------------------------------------------------------- */
  /* Items — the neutral scope rows                                    */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/bid-packages/:packageId/levelling/items",
    { preHandler: standardGate },
    async (req, reply) => {
      const { packageId } = req.params as { packageId: string };
      const parsed = itemsCreateSchema.parse(req.body);
      const wanted = "items" in parsed ? parsed.items : [parsed];
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      const existing = await app.db
        .select({ position: bidLevellingItems.position, itemCode: bidLevellingItems.itemCode })
        .from(bidLevellingItems)
        .where(eq(bidLevellingItems.packageId, packageId));
      const taken = new Set(existing.map((e) => e.itemCode).filter(Boolean) as string[]);
      let nextPosition = existing.reduce((max, e) => Math.max(max, e.position + 1), 0);

      const created: string[] = [];
      for (const item of wanted) {
        if (item.itemCode && taken.has(item.itemCode)) {
          throw conflict(`Levelling item code "${item.itemCode}" already exists on this package.`);
        }
        if (item.itemCode) taken.add(item.itemCode);
        if (!isPriceableCategory(item.category) && item.engineersEstimate !== null && item.engineersEstimate !== undefined) {
          throw badRequest(
            `"${item.description}" is an exclusion_check row, which carries no price by design — ` +
              "it exists only to force an in-or-out answer. Remove the estimate, or make it a " +
              "base_scope row.",
          );
        }
        const id = newId("bli");
        await app.db.insert(bidLevellingItems).values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          packageId,
          position: item.position ?? nextPosition,
          itemCode: item.itemCode ?? null,
          description: item.description,
          category: item.category,
          specSectionId: item.specSectionId ?? null,
          scopeReference: item.scopeReference ?? null,
          drawingSheetId: item.drawingSheetId ?? null,
          unit: item.unit ?? null,
          estimatedQuantity: item.estimatedQuantity ?? null,
          engineersEstimate: item.engineersEstimate ?? null,
          currency: item.currency ?? pkg.currency,
          isMandatory: item.isMandatory ? 1 : 0,
          budgetLineItemId: item.budgetLineItemId ?? null,
          costCodeId: item.costCodeId ?? null,
          notes: item.notes ?? null,
          detail: item.detail ?? {},
          createdBy: req.user!.id,
        });
        nextPosition = Math.max(nextPosition, item.position ?? nextPosition) + 1;
        created.push(id);
      }
      await ledger(app.db, req, "create", "bid_levelling_item", created[0] ?? packageId, {
        projectId: req.projectId!,
        packageId,
        created: created.length,
        itemIds: created,
      }, req.projectId!);
      const items = await app.db
        .select()
        .from(bidLevellingItems)
        .where(inArray(bidLevellingItems.id, created))
        .orderBy(asc(bidLevellingItems.position));
      return reply.status(201).send({ items, total: items.length });
    },
  );

  app.get(
    "/projects/:projectId/bid-packages/:packageId/levelling/items",
    { preHandler: readGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      const items = await app.db
        .select()
        .from(bidLevellingItems)
        .where(eq(bidLevellingItems.packageId, packageId))
        .orderBy(asc(bidLevellingItems.position));
      return {
        items: items.map((i) => ({
          ...i,
          isMandatory: i.isMandatory === 1,
          priceable: isPriceableCategory(i.category as LevellingItemFacts["category"]),
        })),
        total: items.length,
      };
    },
  );

  app.patch("/bid-levelling-items/:itemId", { preHandler: companyGate }, async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const item = await fetchItem(itemId, req.companyId!);
    await requireBiddingLevel(app, req, reply, item.projectId, "standard");
    const body = itemSchema.partial().parse(req.body);
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const key of [
      "itemCode",
      "description",
      "category",
      "specSectionId",
      "scopeReference",
      "drawingSheetId",
      "unit",
      "estimatedQuantity",
      "engineersEstimate",
      "currency",
      "budgetLineItemId",
      "costCodeId",
      "notes",
      "position",
      "detail",
    ] as const) {
      if (body[key] !== undefined) patch[key] = body[key] ?? null;
    }
    if (body.isMandatory !== undefined) patch["isMandatory"] = body.isMandatory ? 1 : 0;
    await app.db.update(bidLevellingItems).set(patch).where(eq(bidLevellingItems.id, itemId));
    await ledger(app.db, req, "update", "bid_levelling_item", itemId, {
      projectId: item.projectId,
      packageId: item.packageId,
      changed: Object.keys(body),
    }, item.projectId);
    return fetchItem(itemId, req.companyId!);
  });

  app.delete("/bid-levelling-items/:itemId", { preHandler: companyGate }, async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const item = await fetchItem(itemId, req.companyId!);
    await requireBiddingLevel(app, req, reply, item.projectId, "standard");
    const entries = await app.db
      .select({ id: bidLevellingEntries.id })
      .from(bidLevellingEntries)
      .where(eq(bidLevellingEntries.levellingItemId, itemId));
    if (entries.length > 0) {
      throw conflict(
        `This scope row already carries ${entries.length} bidder answer(s). Deleting it would ` +
          "erase what those bidders said about that scope. Mark it non-mandatory instead.",
      );
    }
    await app.db.delete(bidLevellingItems).where(eq(bidLevellingItems.id, itemId));
    await ledger(app.db, req, "delete", "bid_levelling_item", itemId, {
      projectId: item.projectId,
      packageId: item.packageId,
      description: item.description,
    }, item.projectId);
    return reply.status(204).send();
  });

  /* ---------------------------------------------------------------- */
  /* Entries — one cell of the grid                                    */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/bid-packages/:packageId/levelling/entries",
    { preHandler: standardGate },
    async (req, reply) => {
      const { packageId } = req.params as { packageId: string };
      const parsed = entriesUpsertSchema.parse(req.body);
      const wanted = "entries" in parsed ? parsed.entries : [parsed];
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      assertUnsealedForAnalysis(pkg, "Levelling");

      const itemRows = await app.db
        .select()
        .from(bidLevellingItems)
        .where(eq(bidLevellingItems.packageId, packageId));
      const itemsById = new Map(itemRows.map((i) => [i.id, i] as const));
      const subRows = await app.db
        .select()
        .from(bidSubmissions)
        .where(eq(bidSubmissions.packageId, packageId));
      const subsById = new Map(subRows.map((s) => [s.id, s] as const));

      const touched: string[] = [];
      const now = new Date().toISOString();
      for (const e of wanted) {
        const item = itemsById.get(e.levellingItemId);
        if (!item) throw badRequest(`Levelling item ${e.levellingItemId} is not on this package.`);
        const submission = subsById.get(e.submissionId);
        if (!submission) throw badRequest(`Submission ${e.submissionId} is not on this package.`);
        assertLateBidUsable(submission, "Levelling this bid");

        if (Math.abs(e.adjustmentAmount) > CENT && !e.adjustmentReason) {
          throw badRequest(
            `The adjustment of ${e.adjustmentAmount} on "${item.description}" for ` +
              `${submission.reference} carries no reason. Every levelling adjustment states WHY ` +
              "the comparable number differs from the number the bidder wrote — without it, " +
              "levelling is an opinion and the losing bidder's challenge succeeds.",
          );
        }

        const facts: LevellingEntryFacts = {
          levellingItemId: e.levellingItemId,
          submissionId: e.submissionId,
          includedStatus: e.includedStatus,
          asBidAmount: e.asBidAmount ?? null,
          adjustmentAmount: e.adjustmentAmount,
          adjustmentReason: e.adjustmentReason ?? null,
          currency: e.currency ?? submission.currency,
        };
        const cell = levelEntry(
          {
            id: item.id,
            itemCode: item.itemCode,
            description: item.description,
            category: item.category as LevellingItemFacts["category"],
            isMandatory: item.isMandatory === 1,
            engineersEstimate: item.engineersEstimate,
            currency: item.currency,
          },
          facts,
        );

        const [existing] = await app.db
          .select({ id: bidLevellingEntries.id, adjustedBy: bidLevellingEntries.adjustedBy })
          .from(bidLevellingEntries)
          .where(
            and(
              eq(bidLevellingEntries.levellingItemId, e.levellingItemId),
              eq(bidLevellingEntries.submissionId, e.submissionId),
            ),
          )
          .limit(1);

        const values = {
          companyId: req.companyId!,
          projectId: req.projectId!,
          packageId,
          levellingItemId: e.levellingItemId,
          submissionId: e.submissionId,
          vendorId: submission.vendorId,
          submissionLineId: e.submissionLineId ?? null,
          includedStatus: e.includedStatus,
          asBidAmount: e.asBidAmount ?? null,
          adjustmentAmount: round2(e.adjustmentAmount),
          adjustmentReason: e.adjustmentReason ?? null,
          adjustmentNote: e.adjustmentNote ?? null,
          levelledAmount: cell.levelledAmount,
          currency: facts.currency,
          quantity: e.quantity ?? null,
          unitRate: e.unitRate ?? null,
          isAssumption: e.isAssumption ? 1 : 0,
          clarificationRef: e.clarificationRef ?? null,
          adjustedBy: req.user!.id,
          adjustedAt: now,
          // any prior review is void — the numbers just changed
          reviewedBy: null,
          reviewedAt: null,
          detail: { ...(e.detail ?? {}), levellingReasons: cell.reasons },
          updatedAt: now,
        };

        if (existing) {
          await app.db
            .update(bidLevellingEntries)
            .set(values)
            .where(eq(bidLevellingEntries.id, existing.id));
          touched.push(existing.id);
        } else {
          const id = newId("ble");
          await app.db.insert(bidLevellingEntries).values({ id, ...values });
          touched.push(id);
        }
      }

      await ledger(app.db, req, "update", "bid_levelling_entry", touched[0] ?? packageId, {
        projectId: req.projectId!,
        packageId,
        entries: touched.length,
        entryIds: touched,
      }, req.projectId!, true);

      const rows = await app.db
        .select()
        .from(bidLevellingEntries)
        .where(inArray(bidLevellingEntries.id, touched));
      return reply.status(201).send({
        items: rows.map((r) => ({
          ...r,
          isAssumption: r.isAssumption === 1,
          reasons: ((r.detail as Record<string, unknown>)["levellingReasons"] as string[]) ?? [],
        })),
        total: rows.length,
      });
    },
  );

  /**
   * Review of a levelling adjustment — never by the person who made it. An
   * adjustment is a judgement about somebody else's price; one person making
   * and blessing it is not a check.
   */
  app.post(
    "/bid-levelling-entries/:entryId/review",
    { preHandler: companyGate },
    async (req, reply) => {
      const { entryId } = req.params as { entryId: string };
      const entry = await fetchEntry(entryId, req.companyId!);
      await requireBiddingLevel(app, req, reply, entry.projectId, "standard");
      assertSegregation(req.user!.id, { adjustedBy: entry.adjustedBy }, "levelling adjustment");
      const now = new Date().toISOString();
      await app.db
        .update(bidLevellingEntries)
        .set({ reviewedBy: req.user!.id, reviewedAt: now, updatedAt: now })
        .where(eq(bidLevellingEntries.id, entryId));
      await ledger(app.db, req, "state_change", "bid_levelling_entry", entryId, {
        projectId: entry.projectId,
        packageId: entry.packageId,
        event: "levelling_reviewed",
        adjustedBy: entry.adjustedBy,
        reviewedBy: req.user!.id,
        levelledAmount: entry.levelledAmount,
      }, entry.projectId, true);
      return fetchEntry(entryId, req.companyId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Auto-map — a starting point, never a conclusion                   */
  /* ---------------------------------------------------------------- */

  /**
   * Map priced lines onto scope rows by item code. Deliberately conservative:
   * an EXCLUDED line becomes an `excluded` entry with NO adjustment, which
   * leaves the row uncovered and blocks completion until a human prices what
   * buying that scope elsewhere costs. Auto-mapping must never turn an
   * exclusion into a free lunch.
   */
  app.post(
    "/projects/:projectId/bid-packages/:packageId/levelling/auto-map",
    { preHandler: standardGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      assertUnsealedForAnalysis(pkg, "Auto-mapping bid lines onto scope rows");
      const items = await app.db
        .select()
        .from(bidLevellingItems)
        .where(eq(bidLevellingItems.packageId, packageId));
      const byCode = new Map(
        items.filter((i) => i.itemCode).map((i) => [i.itemCode as string, i] as const),
      );
      const lines = await app.db
        .select()
        .from(bidSubmissionLines)
        .where(eq(bidSubmissionLines.packageId, packageId));
      const subs = await app.db
        .select()
        .from(bidSubmissions)
        .where(eq(bidSubmissions.packageId, packageId));
      const subsById = new Map(subs.map((s) => [s.id, s] as const));

      const now = new Date().toISOString();
      let mapped = 0;
      const unmatched: { submissionId: string; description: string; itemCode: string | null }[] = [];

      for (const line of lines) {
        const item =
          (line.levellingItemId ? items.find((i) => i.id === line.levellingItemId) : undefined) ??
          (line.itemCode ? byCode.get(line.itemCode) : undefined);
        if (!item) {
          unmatched.push({
            submissionId: line.submissionId,
            description: line.description,
            itemCode: line.itemCode,
          });
          continue;
        }
        const submission = subsById.get(line.submissionId);
        if (!submission) continue;
        const [existing] = await app.db
          .select({ id: bidLevellingEntries.id, adjustedBy: bidLevellingEntries.adjustedBy })
          .from(bidLevellingEntries)
          .where(
            and(
              eq(bidLevellingEntries.levellingItemId, item.id),
              eq(bidLevellingEntries.submissionId, line.submissionId),
            ),
          )
          .limit(1);
        if (existing) continue; // never overwrite a human's judgement

        const includedStatus = line.isExcluded === 1 ? "excluded" : "included";
        const facts: LevellingEntryFacts = {
          levellingItemId: item.id,
          submissionId: line.submissionId,
          includedStatus,
          asBidAmount: line.isExcluded === 1 ? null : line.amount,
          adjustmentAmount: 0,
          adjustmentReason: null,
          currency: line.currency,
        };
        const cell = levelEntry(
          {
            id: item.id,
            itemCode: item.itemCode,
            description: item.description,
            category: item.category as LevellingItemFacts["category"],
            isMandatory: item.isMandatory === 1,
            engineersEstimate: item.engineersEstimate,
            currency: item.currency,
          },
          facts,
        );
        await app.db.insert(bidLevellingEntries).values({
          id: newId("ble"),
          companyId: req.companyId!,
          projectId: req.projectId!,
          packageId,
          levellingItemId: item.id,
          submissionId: line.submissionId,
          vendorId: line.vendorId,
          submissionLineId: line.id,
          includedStatus,
          asBidAmount: facts.asBidAmount,
          adjustmentAmount: 0,
          adjustmentReason: null,
          adjustmentNote: null,
          levelledAmount: cell.levelledAmount,
          currency: line.currency,
          quantity: line.quantity,
          unitRate: line.unitRate,
          isAssumption: 0,
          adjustedBy: req.user!.id,
          adjustedAt: now,
          detail: { autoMapped: true, levellingReasons: cell.reasons },
        });
        mapped += 1;
      }

      await ledger(app.db, req, "update", "bid_levelling_entry", packageId, {
        projectId: req.projectId!,
        packageId,
        event: "levelling_auto_map",
        mapped,
        unmatched: unmatched.length,
      }, req.projectId!);

      return {
        mapped,
        unmatched,
        note:
          "Auto-mapping fills in what the bidders priced against matching item codes. Excluded " +
          "lines are mapped as exclusions with NO adjustment, so they stay uncovered until " +
          "somebody prices the gap — that refusal is the whole point of levelling.",
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* THE GRID                                                          */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/bid-packages/:packageId/levelling/grid",
    { preHandler: readGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      const seal = sealState(pkg);
      const { items, entries, submissionRows } = await loadLevellingFacts(app.db, packageId);

      if (seal.amountsWithheld) {
        return {
          seal,
          sealed: true,
          items,
          submissions: submissionRows.map((s) => ({
            id: s.id,
            vendorId: s.vendorId,
            reference: s.reference,
            status: s.status,
          })),
          comparison: null,
          note:
            "The comparison grid is withheld in full while this package is sealed: every cell " +
            `in it is a price. ${seal.note}`,
        };
      }

      const facts = comparisonFacts(submissionRows);
      const comparison = buildComparison(items, entries, facts);
      const vendorRows = submissionRows.length
        ? await app.db
            .select({ id: vendors.id, name: vendors.name })
            .from(vendors)
            .where(inArray(vendors.id, [...new Set(submissionRows.map((s) => s.vendorId))]))
        : [];
      const names = new Map(vendorRows.map((v) => [v.id, v.name] as const));

      return {
        seal,
        sealed: false,
        package: {
          id: pkg.id,
          reference: pkg.reference,
          currency: pkg.currency,
          engineersEstimate: pkg.engineersEstimate,
          levelledAt: pkg.status === "levelled" ? pkg.updatedAt : null,
        },
        items: comparison.items,
        submissions: facts.map((f) => ({
          ...f,
          vendorName: names.get(f.vendorId) ?? null,
        })),
        grid: comparison.submissions,
        coverage: comparison.coverage,
        ranking: comparison.ranking,
        complete: comparison.complete,
        blockers: comparison.blockers,
        currencies: comparison.currencies,
      };
    },
  );

  /**
   * Declare the comparison complete and freeze the levelled figures onto the
   * submissions. Refused — with every blocker named — while a bidder still in
   * contention has an unpriced mandatory row.
   */
  app.post(
    "/projects/:projectId/bid-packages/:packageId/levelling/complete",
    { preHandler: standardGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      assertUnsealedForAnalysis(pkg, "Completing the levelling");
      const { items, entries, submissionRows } = await loadLevellingFacts(app.db, packageId);
      const facts = comparisonFacts(submissionRows);
      const comparison = buildComparison(items, entries, facts);

      if (!comparison.complete) {
        throw conflict(
          "The levelling is not complete and cannot be declared so. " +
            `${comparison.blockers.length} thing(s) block it — each one is a bidder still in ` +
            "contention who has not answered a mandatory scope row, so comparing them would be " +
            "comparing different scopes:\n- " +
            comparison.blockers.join("\n- "),
        );
      }

      const now = new Date().toISOString();
      const frozen: { submissionId: string; normalisedAmount: number | null }[] = [];
      for (const levelled of comparison.submissions) {
        const amount = levelled.levelledTotal.value;
        await app.db
          .update(bidSubmissions)
          .set({ normalisedAmount: amount, levellingCompletedAt: now, updatedAt: now })
          .where(eq(bidSubmissions.id, levelled.submissionId));
        frozen.push({ submissionId: levelled.submissionId, normalisedAmount: amount });
      }
      await app.db
        .update(bidPackages)
        .set({ status: "levelled", updatedAt: now })
        .where(eq(bidPackages.id, packageId));

      await ledger(
        app.db,
        req,
        "state_change",
        "bid_package",
        packageId,
        {
          projectId: req.projectId!,
          event: "levelling_completed",
          reference: pkg.reference,
          itemCount: items.length,
          entryCount: entries.length,
          frozen,
          ranking: comparison.ranking,
        },
        req.projectId!,
        true,
      );

      return {
        complete: true,
        frozen,
        ranking: comparison.ranking,
        coverage: comparison.coverage,
        note:
          "Levelled amounts are frozen onto each submission as `normalisedAmount`. That figure, " +
          "not the as-bid total, is what the award is measured against.",
      };
    },
  );
};
