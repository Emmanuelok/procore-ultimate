/**
 * Small helpers shared by the field route files. Nothing here talks to the
 * network; the SQL fragment is the one jsonb containment idiom the module
 * uses for "is this user id in that array column".
 */
import type { FastifyRequest } from "fastify";
import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Actor } from "./access.js";

export function actorOf(req: FastifyRequest): Actor {
  return { userId: req.user!.id, companyId: req.companyId!, companyRole: req.companyRole };
}

/** `column @> '["value"]'::jsonb` — true when a jsonb string array contains `value`. */
export function jsonbHas(column: PgColumn, value: string): SQL {
  return sql`${column} @> ${JSON.stringify([value])}::jsonb`;
}

/** `column @> '[{...}]'::jsonb` — containment of one object in a jsonb array. */
export function jsonbHasObject(column: PgColumn, value: Record<string, unknown>): SQL {
  return sql`${column} @> ${JSON.stringify([value])}::jsonb`;
}

export const nowIso = (): string => new Date().toISOString();

export const pad3 = (n: number): string => String(n).padStart(3, "0");
export const pad4 = (n: number): string => String(n).padStart(4, "0");

/** Pick a subset of keys — used for before/after ledger snapshots. */
export function pick<T extends Record<string, unknown>>(row: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in row) out[k] = row[k];
  return out;
}
