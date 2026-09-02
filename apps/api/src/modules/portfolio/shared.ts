/**
 * Shared plumbing for the owner / portfolio module: gates, wire formats,
 * numbering, the ledger wrapper and the small guards the route files would
 * otherwise each restate.
 *
 * Three rules live here rather than in nine route files:
 *
 *  · GATES. Company-level routes (money authority, frameworks, term
 *    contracts, prioritisation) are the owner's own business and use the
 *    company gate; anything that authorises or moves money additionally
 *    requires an owner/admin company role. Project-scoped routes carry
 *    `:projectId` so `requireTool("portfolio", …)` can resolve the project.
 *  · LEDGER. Every consequential mutation appends, and `ledger()` fixes the
 *    object-type vocabulary so the portfolio chain reads as one record.
 *  · CURRENCY. A money field never travels without its currency, and a
 *    comparison across two currencies is refused with a reason rather than
 *    performed at an unstated rate.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { portfolios, projects } from "@constructos/db";
import type { Db } from "../../lib/db.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { appendLedger } from "../../lib/ledger.js";
import { nextRecordNumber } from "../../lib/numbering.js";

/* ------------------------------------------------------------------ */
/* Wire formats                                                        */
/* ------------------------------------------------------------------ */

export const idSchema = z.string().min(1).max(64);

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");

export const isoTimestampSchema = z
  .string()
  .min(4)
  .refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO timestamp");

export const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, "Expected a 3-letter ISO 4217 currency code")
  .transform((c) => c.toUpperCase());

/** A fiscal year label as the owner writes it: "2026/27", "FY26", "2026". */
export const fiscalYearSchema = z.string().trim().min(2).max(20);

export const moneySchema = z.number().finite();
export const nonNegativeMoneySchema = z.number().finite().nonnegative();
export const percentSchema = z.number().finite().min(0).max(100);

export const todayISO = (): string => new Date().toISOString().slice(0, 10);
export const nowISO = (): string => new Date().toISOString();
export const pad3 = (n: number): string => String(n).padStart(3, "0");
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Whole days from `a` to `b` (ISO dates); negative when b precedes a. */
export function daysBetweenISO(a: string, b: string): number | null {
  const from = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

export function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Turn a create schema into a patch schema: every key optional, nothing new
 * accepted. Status and approval fields are never in a create schema, so they
 * can never leak into a generic PATCH (plan §6.3).
 *
 * `.partial()` alone keeps every `.default()`, and a PATCH parsed through that
 * would silently reset untouched columns to their default. The defaults are
 * stripped first: a PATCH body is only what the caller actually sent.
 */
type WithoutDefaults<T extends z.ZodRawShape> = {
  [K in keyof T]: T[K] extends z.ZodDefault<infer Inner extends z.ZodTypeAny> ? Inner : T[K];
};

export function patchSchemaOf<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    shape[key] = (field instanceof z.ZodDefault ? field.removeDefault() : field) as z.ZodTypeAny;
  }
  return z.object(shape as unknown as WithoutDefaults<T>).partial();
}

/** Copy the keys the caller actually sent onto an update set, with a stamp. */
export function patchSet(body: Record<string, unknown>): Record<string, unknown> {
  const set: Record<string, unknown> = { updatedAt: nowISO() };
  for (const [k, v] of Object.entries(body)) if (v !== undefined) set[k] = v;
  return set;
}

/* ------------------------------------------------------------------ */
/* Gates                                                               */
/* ------------------------------------------------------------------ */

export function buildGates(app: FastifyInstance) {
  return {
    /** project-scoped, tool `portfolio` */
    readGate: [app.authenticate, app.requireCompany, app.requireTool("portfolio", "read")],
    standardGate: [app.authenticate, app.requireCompany, app.requireTool("portfolio", "standard")],
    adminGate: [app.authenticate, app.requireCompany, app.requireTool("portfolio", "admin")],
    /** company-level reads: the owner's own portfolio */
    companyGate: [app.authenticate, app.requireCompany],
    /**
     * company-level writes that create or move spending authority. Deciding
     * what the organisation may spend is an owner act, not a project one.
     */
    companyAdminGate: [
      app.authenticate,
      app.requireCompany,
      app.requireCompanyRole(["owner", "admin"]),
    ],
  };
}
export type PortfolioGates = ReturnType<typeof buildGates>;

/* ------------------------------------------------------------------ */
/* Numbering                                                           */
/* ------------------------------------------------------------------ */

export async function allocateReference(
  db: Db,
  projectId: string,
  counterKey: string,
  prefix: string,
): Promise<{ number: number; reference: string }> {
  const number = await nextRecordNumber(db, projectId, counterKey);
  return { number, reference: `${prefix}-${pad3(number)}` };
}

/* ------------------------------------------------------------------ */
/* Ledger                                                              */
/* ------------------------------------------------------------------ */

export type PortfolioObjectType =
  | "portfolio_funding_source"
  | "portfolio_appropriation"
  | "portfolio_virement"
  | "portfolio_allocation"
  | "portfolio_envelope"
  | "portfolio_scoring_model"
  | "portfolio_score"
  | "framework_agreement"
  | "framework_lot"
  | "framework_supplier"
  | "framework_mini_competition"
  | "term_contract"
  | "schedule_of_rates_item"
  | "call_off_order"
  | "joint_venture"
  | "jv_partner"
  | "jv_transaction"
  | "jv_decision"
  | "target_cost_contract"
  | "pain_gain_calculation"
  | "open_book_verification"
  | "defined_cost_item"
  | "disallowed_cost"
  | "audit_rights_execution";

export async function ledger(
  db: Db,
  input: {
    companyId: string;
    projectId?: string | null;
    actorId: string | null;
    action: "create" | "update" | "delete" | "state_change" | "access";
    objectType: PortfolioObjectType;
    objectId: string;
    payload?: unknown;
    storePayload?: boolean;
  },
): Promise<void> {
  await appendLedger(db, {
    companyId: input.companyId,
    projectId: input.projectId ?? null,
    actorId: input.actorId,
    action: input.action,
    objectType: input.objectType,
    objectId: input.objectId,
    payload: input.payload,
    storePayload: input.storePayload ?? false,
  });
}

/* ------------------------------------------------------------------ */
/* Reference checks                                                    */
/* ------------------------------------------------------------------ */

/** A live project in this company, or a 400 naming what was wrong. */
export async function assertProject(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<{ id: string; name: string; currency: string }> {
  const [row] = await db
    .select({ id: projects.id, name: projects.name, currency: projects.currency })
    .from(projects)
    .where(
      and(eq(projects.id, projectId), eq(projects.companyId, companyId), isNull(projects.deletedAt)),
    )
    .limit(1);
  if (!row) throw badRequest("projectId does not name a live project in this company");
  return row;
}

/** A portfolio grouping in this company (core.portfolios, owned by projects). */
export async function assertPortfolio(
  db: Db,
  companyId: string,
  portfolioId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.companyId, companyId)))
    .limit(1);
  if (!row) throw badRequest("portfolioId does not name a portfolio in this company");
}

/**
 * Fetch one row of a tenant table by id, scoped to the company, or 404.
 * Written once here because twenty-odd routes would otherwise each repeat it.
 */
export async function fetchScoped<T extends Record<string, unknown>>(
  rows: T[],
  what: string,
): Promise<T> {
  const row = rows[0];
  if (!row) throw notFound(`${what} not found`);
  return row;
}

/* ------------------------------------------------------------------ */
/* Currency discipline                                                 */
/* ------------------------------------------------------------------ */

/**
 * Refuse a comparison the platform cannot honestly make. Used wherever a
 * child record's currency must match its parent's before an amount may be
 * counted against a ceiling.
 */
export function assertSameCurrency(
  child: string,
  parent: string,
  context: { childLabel: string; parentLabel: string },
): void {
  if (child !== parent) {
    throw badRequest(
      `The ${context.childLabel} is in ${child} but the ${context.parentLabel} is in ${parent}. ` +
        `This platform does not convert currencies, so the amount cannot be counted against it.`,
    );
  }
}
