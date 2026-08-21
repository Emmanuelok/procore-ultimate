import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PermissionLevel } from "@constructos/shared";

/** ISO calendar date (YYYY-MM-DD) — the wire format for all date-only columns. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");

/** Money to 2 decimal places. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Measured quantities to 3 decimal places (m³ convention). */
export const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Tool-permission check for sub-resource routes that carry no `:projectId`
 * param (e.g. /boqs/:boqId, /valuations/:valuationId). The owning project is
 * resolved from the record itself, injected into params, and the standard
 * `requireTool` gate is run — so sub-resource writes enforce exactly the same
 * commercial tool levels as project-scoped routes.
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
