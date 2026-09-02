/**
 * Helpers shared by the budget module's route files (index.ts and
 * intelligence.ts): tenant-scoped fetchers, the tool gate for sub-resource
 * routes that carry no `:projectId`, and the void-aware "latest capture"
 * read every period guard depends on. One definition, so a guard in one
 * file and a guard in the other can never disagree about what "captured"
 * means.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, desc, eq } from "drizzle-orm";
import { budgetLineItems, budgetSnapshots, budgets } from "@constructos/db";
import type { PermissionLevel } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { notFound } from "../../lib/errors.js";

export type BudgetRow = typeof budgets.$inferSelect;
export type LineRow = typeof budgetLineItems.$inferSelect;
export type SnapshotRow = typeof budgetSnapshots.$inferSelect;

export const pad3 = (n: number): string => String(n).padStart(3, "0");
export const today = (): string => new Date().toISOString().slice(0, 10);
export const nowIso = (): string => new Date().toISOString();

/**
 * Tool-permission check for sub-resource routes (e.g. /budget-lines/:lineId).
 * The owning project comes from the record, is injected into params, and the
 * gate runs — so a sub-resource write enforces exactly the same budget tool
 * level as a project route.
 */
export async function requireBudgetLevel(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
  level: PermissionLevel,
): Promise<void> {
  (req.params as Record<string, string | undefined>)["projectId"] = projectId;
  await app.requireTool("budget", level)(req, reply);
}

export async function fetchBudget(db: Db, budgetId: string, companyId: string): Promise<BudgetRow> {
  const rows = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.id, budgetId), eq(budgets.companyId, companyId)))
    .limit(1);
  if (!rows[0]) throw notFound("Budget not found");
  return rows[0];
}

export async function fetchLineWithBudget(
  db: Db,
  lineId: string,
  companyId: string,
): Promise<{ line: LineRow; budget: BudgetRow }> {
  const rows = await db
    .select({ line: budgetLineItems, budget: budgets })
    .from(budgetLineItems)
    .innerJoin(budgets, eq(budgets.id, budgetLineItems.budgetId))
    .where(and(eq(budgetLineItems.id, lineId), eq(budgetLineItems.companyId, companyId)))
    .limit(1);
  if (!rows[0]) throw notFound("Budget line item not found");
  return rows[0];
}

export const linesOfBudget = (db: Db, budgetId: string): Promise<LineRow[]> =>
  db
    .select()
    .from(budgetLineItems)
    .where(eq(budgetLineItems.budgetId, budgetId))
    .orderBy(asc(budgetLineItems.sortOrder), asc(budgetLineItems.costCode));

/** A capture an admin has voided keeps its hashed row but no longer guards a period. */
export const isVoidSnapshot = (row: Pick<SnapshotRow, "detail">): boolean =>
  typeof (row.detail as Record<string, unknown> | null)?.["voidedAt"] === "string";

/**
 * The most recent LIVE capture on a budget. Voided captures are skipped: the
 * row stays (its hash is evidence that it existed and what it said) but it
 * no longer freezes the plan or closes the period.
 */
export async function latestSnapshot(db: Db, budgetId: string): Promise<SnapshotRow | null> {
  const rows = await db
    .select()
    .from(budgetSnapshots)
    .where(eq(budgetSnapshots.budgetId, budgetId))
    .orderBy(desc(budgetSnapshots.asOfDate), desc(budgetSnapshots.number));
  return rows.find((r) => !isVoidSnapshot(r)) ?? null;
}
