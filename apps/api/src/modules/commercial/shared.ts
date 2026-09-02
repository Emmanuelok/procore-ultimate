import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { boqs, contracts, signals } from "@constructos/db";
import type { PermissionLevel } from "@constructos/shared";
import { machineAuth } from "../integrations/machine-auth.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import type { Db } from "../../lib/db.js";

/** ISO calendar date (YYYY-MM-DD) — the wire format for all date-only columns. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");

/** ISO month (YYYY-MM) — the wire format for index periods. */
export const isoMonthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, "Expected an ISO month (YYYY-MM)");

/** Money to 2 decimal places. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Measured quantities to 3 decimal places (m³ convention). */
export const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Tool-permission check for sub-resource routes that carry no `:projectId`
 * param (e.g. /boqs/:boqId, /valuations/:valuationId). The owning project is
 * resolved from the record itself, injected into params, and the standard
 * `requireTool` gate is run — so sub-resource reads AND writes enforce exactly
 * the same commercial tool levels as project-scoped routes.
 *
 * Every sub-resource handler must call this, including the GETs: `requireTool`
 * is what checks project membership and the tool level, and a route gated on
 * company membership alone lets any company member — a subcontractor-template
 * user, or someone who is not on the project at all — read BQ rates,
 * applications and certificates by id.
 */
export async function requireCommercialLevel(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
  level: PermissionLevel,
): Promise<void> {
  (req.params as Record<string, string | undefined>)["projectId"] = projectId;
  await app.requireTool("commercial", level)(req, reply);
}

/**
 * The preHandler chain for a sub-resource route.
 *
 * The third entry is a marker, not a check: `machineAuth.noteRoute` records a
 * route as tool-gated by inspecting its preHandlers for the label
 * `requireTool` attaches, and `authenticate` refuses machine callers on any
 * route it has not recorded. Without the marker every OAuth/ERP client is
 * refused on /boqs/:id, /valuations/:id and /certificates/:id with "not
 * tool-scoped" — the commercial API becomes human-only. The real level check
 * still happens inside the handler through `requireCommercialLevel`, once the
 * record has told us which project it belongs to.
 */
export function subResourceGate(app: FastifyInstance, level: PermissionLevel) {
  return [
    app.authenticate,
    app.requireCompany,
    machineAuth.markToolGate(async () => {}, "commercial", level),
  ];
}

/** Rate build-up sheet component (spec #145-149). */
export const rateBuildUpComponentSchema = z.object({
  kind: z.enum(["labour", "material", "plant", "overhead", "profit"]),
  description: z.string().min(1).max(500),
  qty: z.number().finite(),
  unit: z.string().max(20).nullable().optional(),
  rate: z.number().finite(),
});
export type RateBuildUpComponent = z.infer<typeof rateBuildUpComponentSchema>;

export interface ComputedBuildUp {
  /** components with their extended amounts persisted */
  components: Array<RateBuildUpComponent & { amount: number }>;
  /** Σ component amounts — the built-up item rate */
  rate: number;
}

/** Extend each component (amount = qty × rate) and total the item rate. */
export function computeRateBuildUp(components: RateBuildUpComponent[]): ComputedBuildUp {
  const extended = components.map((c) => ({ ...c, amount: round2(c.qty * c.rate) }));
  const rate = round2(extended.reduce((sum, c) => sum + c.amount, 0));
  return { components: extended, rate };
}

/**
 * Natural (numeric-aware) comparison of BQ codes, so 2 sorts before 10 in
 * both the bill tree and the valuation line order.
 */
export function compareCodes(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Currency discipline (#178 / the honesty rule): a BoQ linked to a contract
 * must be in the contract's currency. Money in two currencies is two numbers,
 * and adding them produces a third that means nothing.
 */
export async function assertBoqCurrencyMatchesContract(
  db: Db,
  contractId: string | null | undefined,
  companyId: string,
  projectId: string,
  currency: string,
): Promise<{ id: string; currency: string } | null> {
  if (!contractId) return null;
  const rows = await db
    .select({ id: contracts.id, currency: contracts.currency })
    .from(contracts)
    .where(
      and(
        eq(contracts.id, contractId),
        eq(contracts.companyId, companyId),
        eq(contracts.projectId, projectId),
      ),
    )
    .limit(1);
  const contract = rows[0];
  if (!contract) throw badRequest("contractId does not reference a contract on this project");
  if (contract.currency !== currency) {
    throw badRequest(
      `The BoQ currency (${currency}) must match the contract currency (${contract.currency}); a BoQ priced in a different currency cannot be totalled with its contract.`,
    );
  }
  return contract;
}

/** Load a BoQ inside the caller's company or 404. */
export async function loadBoq(db: Db, boqId: string, companyId: string) {
  const rows = await db
    .select()
    .from(boqs)
    .where(and(eq(boqs.id, boqId), eq(boqs.companyId, companyId)))
    .limit(1);
  if (!rows[0]) throw notFound("BoQ not found");
  return rows[0];
}

/** Load a contract inside the caller's company or 404. */
export async function loadContract(db: Db, contractId: string, companyId: string) {
  const rows = await db
    .select()
    .from(contracts)
    .where(and(eq(contracts.id, contractId), eq(contracts.companyId, companyId)))
    .limit(1);
  if (!rows[0]) throw notFound("Contract not found");
  return rows[0];
}


/* ------------------------------------------------------------------ */
/* Signals                                                             */
/* ------------------------------------------------------------------ */

export interface RaiseSignalArgs {
  companyId: string;
  projectId: string;
  detector: string;
  /** stable identity of the CONDITION, stored in evidenceRefs.key */
  key: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  confidence: number;
  title: string;
  explanation: string;
  evidenceRefs?: Record<string, unknown>;
}

/**
 * Raise a signal at most once per condition.
 *
 * Sweeps run on a schedule and on demand; raising the same condition twice is
 * a defect, not a duplicate row to tidy later. The condition's identity lives
 * in `evidenceRefs.key`, which is matched in SQL so the check is a lookup
 * rather than a table scan in JavaScript.
 */
export async function raiseSignalOnce(
  db: Db,
  a: RaiseSignalArgs,
): Promise<{ raised: boolean; signalId: string }> {
  const existing = await db
    .select({ id: signals.id })
    .from(signals)
    .where(
      and(
        eq(signals.companyId, a.companyId),
        eq(signals.projectId, a.projectId),
        eq(signals.detector, a.detector),
        sql`${signals.evidenceRefs} ->> 'key' = ${a.key}`,
      ),
    )
    .limit(1);
  if (existing[0]) return { raised: false, signalId: existing[0].id };
  const id = newId("sig");
  await db.insert(signals).values({
    id,
    companyId: a.companyId,
    projectId: a.projectId,
    detector: a.detector,
    severity: a.severity,
    confidence: a.confidence,
    title: a.title,
    explanation: a.explanation,
    evidenceRefs: { key: a.key, ...(a.evidenceRefs ?? {}) },
  });
  return { raised: true, signalId: id };
}
