import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import {
  budgetLineItems,
  costCodes,
  crews,
  timecardBatches,
  timecards,
  tmTickets,
  vendors,
  workers,
} from "@constructos/db";
import type { LedgerAction } from "@constructos/shared";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors.js";
import { appendLedger } from "../../lib/ledger.js";
import type { Db } from "../../lib/db.js";
import {
  OVERTIME_RULE_KINDS,
  VARIANCE_TOLERANCE_HOURS,
  type OvertimeRule,
  type OvertimeRuleKind,
} from "./hours.js";

/* ------------------------------------------------------------------ */
/* Small primitives                                                    */
/* ------------------------------------------------------------------ */

export const nowIso = (): string => new Date().toISOString();
export const todayIso = (): string => new Date().toISOString().slice(0, 10);
export const pad3 = (n: number): string => String(n).padStart(3, "0");

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO date (YYYY-MM-DD)")
  .refine((s) => !Number.isNaN(Date.parse(s)), "not a real calendar date");

export const timeOfDaySchema = z.string().regex(/^\d{2}:\d{2}$/, "expected HH:MM");
export const idSchema = z.string().min(1).max(64);
export const detailSchema = z.record(z.string(), z.unknown());
export const hoursSchema = z.number().min(0).max(24);

export type ActorRequest = FastifyRequest & {
  companyId?: string;
  projectId?: string;
  user?: { id: string };
};

export const actorOf = (req: FastifyRequest): string => (req as ActorRequest).user!.id;
export const companyOf = (req: FastifyRequest): string => (req as ActorRequest).companyId!;
export const projectOf = (req: FastifyRequest): string => (req as ActorRequest).projectId!;

/** ISO date arithmetic in UTC. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The first day of the PAY week containing `isoDate`. Configurable per crew
 * because the pay week is a contractual boundary, not a calendar fact: a
 * Sunday-start week and a Monday-start week put a Saturday's hours in
 * different weeks, and under a weekly overtime rule that changes what they
 * cost.
 */
export function weekStart(isoDate: string, weekStartsOn: number): string {
  const dow = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  const back = (dow - weekStartsOn + 7) % 7;
  return addDays(isoDate, -back);
}

/* ------------------------------------------------------------------ */
/* Gates                                                               */
/* ------------------------------------------------------------------ */

export interface TimecardGates {
  read: preHandlerHookHandler[];
  standard: preHandlerHookHandler[];
  admin: preHandlerHookHandler[];
}

/**
 * `timecards` is one tool key across crews, cards, batches and T&M tickets.
 * Reading is `read`; raising, coding, submitting and approving hours is
 * `standard`; and exactly two operations are `admin` — LOCKING a batch and
 * EXPORTING it to payroll — because after either one a correction is a new
 * dated adjustment rather than an edit, and neither can be undone.
 */
export function timecardGates(app: FastifyInstance): TimecardGates {
  return {
    read: [app.authenticate, app.requireCompany, app.requireTool("timecards", "read")],
    standard: [app.authenticate, app.requireCompany, app.requireTool("timecards", "standard")],
    admin: [app.authenticate, app.requireCompany, app.requireTool("timecards", "admin")],
  };
}

export async function ledgerTimecards(
  db: Db,
  req: FastifyRequest,
  action: LedgerAction,
  objectType: string,
  objectId: string,
  payload: Record<string, unknown>,
  options: { storePayload?: boolean } = {},
): Promise<void> {
  await appendLedger(db, {
    companyId: companyOf(req),
    actorId: actorOf(req),
    action,
    objectType,
    objectId,
    projectId: projectOf(req),
    payload: { projectId: projectOf(req), ...payload },
    storePayload: options.storePayload ?? true,
  });
}

/* ------------------------------------------------------------------ */
/* Crew configuration                                                  */
/* ------------------------------------------------------------------ */

/**
 * The parts of a crew's pay rules that have no column of their own. Kept in
 * `crews.detail` and read back through a schema so a hand-edited jsonb blob
 * degrades to the defaults instead of crashing a payroll run.
 */
export const crewConfigSchema = z.object({
  overtimeRule: z.enum(OVERTIME_RULE_KINDS).default("daily"),
  /** daily rule: hours per day beyond which double time applies */
  doubleTimeThresholdHours: z.number().min(0).max(24).nullable().default(null),
  /** weekly rule: hours per week beyond which overtime applies */
  weeklyOvertimeThresholdHours: z.number().min(0).max(168).nullable().default(null),
  weeklyDoubleTimeThresholdHours: z.number().min(0).max(168).nullable().default(null),
  /** 0 = Sunday … 6 = Saturday */
  weekStartsOn: z.number().int().min(0).max(6).default(1),
  /** how many distinct approval tiers a card needs before it is approved */
  approvalLevels: z.number().int().min(1).max(3).default(1),
  /** per-day claimed-vs-present tolerance before an explanation is required */
  varianceToleranceHours: z.number().min(0).max(12).default(VARIANCE_TOLERANCE_HOURS),
});
export type CrewConfig = z.infer<typeof crewConfigSchema>;

export const CREW_CONFIG_DEFAULTS: CrewConfig = crewConfigSchema.parse({});

export type CrewRow = typeof crews.$inferSelect;
export type TimecardRow = typeof timecards.$inferSelect;
export type BatchRow = typeof timecardBatches.$inferSelect;
export type TicketRow = typeof tmTickets.$inferSelect;

export function crewConfig(crew: CrewRow | null): CrewConfig {
  if (!crew) return CREW_CONFIG_DEFAULTS;
  const parsed = crewConfigSchema.safeParse(crew.detail ?? {});
  return parsed.success ? parsed.data : CREW_CONFIG_DEFAULTS;
}

/**
 * The overtime rule a crew runs, in the shape `classifyHours` consumes.
 *
 * There is no platform-wide default threshold and there never will be: 8
 * hours a day is Californian, 40 a week is federal, 48 a week is the Working
 * Time Directive, and a crew whose agreement says none of those must not be
 * silently costed under one of them. A crew that records no threshold
 * produces a REFUSAL from `classifyHours`, not a guess.
 */
export function overtimeRuleOf(crew: CrewRow | null): OvertimeRule {
  if (!crew) {
    return {
      kind: "daily",
      thresholdHours: null,
      doubleTimeThresholdHours: null,
      source: "no crew",
    };
  }
  const cfg = crewConfig(crew);
  const source = `Crew ${crew.reference} (${crew.name})`;
  const kind: OvertimeRuleKind = cfg.overtimeRule;
  if (kind === "weekly") {
    return {
      kind,
      thresholdHours: cfg.weeklyOvertimeThresholdHours ?? crew.overtimeThresholdHours,
      doubleTimeThresholdHours: cfg.weeklyDoubleTimeThresholdHours,
      source,
    };
  }
  if (kind === "none") {
    return { kind, thresholdHours: null, doubleTimeThresholdHours: null, source };
  }
  return {
    kind: "daily",
    thresholdHours: crew.overtimeThresholdHours,
    doubleTimeThresholdHours: cfg.doubleTimeThresholdHours,
    source,
  };
}

/* ------------------------------------------------------------------ */
/* Fetch helpers                                                       */
/* ------------------------------------------------------------------ */

export async function fetchCrew(
  db: Db,
  id: string,
  companyId: string,
  projectId: string,
): Promise<CrewRow> {
  const rows = await db
    .select()
    .from(crews)
    .where(and(eq(crews.id, id), eq(crews.companyId, companyId), eq(crews.projectId, projectId)))
    .limit(1);
  if (!rows[0]) throw notFound("Crew not found on this project");
  return rows[0];
}

export async function fetchTimecard(
  db: Db,
  id: string,
  companyId: string,
  projectId: string,
): Promise<TimecardRow> {
  const rows = await db
    .select()
    .from(timecards)
    .where(
      and(
        eq(timecards.id, id),
        eq(timecards.companyId, companyId),
        eq(timecards.projectId, projectId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound("Timecard not found on this project");
  return rows[0];
}

export async function fetchBatch(
  db: Db,
  id: string,
  companyId: string,
  projectId: string,
): Promise<BatchRow> {
  const rows = await db
    .select()
    .from(timecardBatches)
    .where(
      and(
        eq(timecardBatches.id, id),
        eq(timecardBatches.companyId, companyId),
        eq(timecardBatches.projectId, projectId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound("Timecard batch not found on this project");
  return rows[0];
}

export async function fetchTicket(
  db: Db,
  id: string,
  companyId: string,
  projectId: string,
): Promise<TicketRow> {
  const rows = await db
    .select()
    .from(tmTickets)
    .where(
      and(
        eq(tmTickets.id, id),
        eq(tmTickets.companyId, companyId),
        eq(tmTickets.projectId, projectId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound("T&M ticket not found on this project");
  return rows[0];
}

export type WorkerRow = typeof workers.$inferSelect;

/**
 * THE worker register (workforce.ts). This module creates no second person
 * table: a timecard names a worker who was already enrolled, age-verified and
 * inducted there, or it is refused.
 */
export async function requireWorker(
  db: Db,
  workerId: string,
  companyId: string,
  projectId: string,
): Promise<WorkerRow> {
  const rows = await db
    .select()
    .from(workers)
    .where(
      and(
        eq(workers.id, workerId),
        eq(workers.companyId, companyId),
        eq(workers.projectId, projectId),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw badRequest(
      `workerId ${workerId} is not on this project's worker register. Hours are only ever booked ` +
        "against an enrolled worker — there is no second person table here.",
    );
  }
  return rows[0];
}

export async function requireVendor(db: Db, vendorId: string, companyId: string) {
  const rows = await db
    .select({ id: vendors.id, name: vendors.name })
    .from(vendors)
    .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)))
    .limit(1);
  if (!rows[0]) throw badRequest(`vendorId ${vendorId} is not in this company's directory.`);
  return rows[0];
}

/** Cost codes are company-standard (projectId null) or project-specific. */
export async function requireCostCode(db: Db, costCodeId: string, companyId: string) {
  const rows = await db
    .select({ id: costCodes.id, code: costCodes.code, title: costCodes.title })
    .from(costCodes)
    .where(and(eq(costCodes.id, costCodeId), eq(costCodes.companyId, companyId)))
    .limit(1);
  if (!rows[0]) throw badRequest(`costCodeId ${costCodeId} is not a cost code in this company.`);
  return rows[0];
}

/** THE join that puts labour on the cost report (financials.ts). */
export async function requireBudgetLine(
  db: Db,
  budgetLineItemId: string,
  companyId: string,
  projectId: string,
) {
  const rows = await db
    .select({
      id: budgetLineItems.id,
      costCode: budgetLineItems.costCode,
      costCodeId: budgetLineItems.costCodeId,
      costType: budgetLineItems.costType,
      description: budgetLineItems.description,
      wbsPath: budgetLineItems.wbsPath,
      subJob: budgetLineItems.subJob,
    })
    .from(budgetLineItems)
    .where(
      and(
        eq(budgetLineItems.id, budgetLineItemId),
        eq(budgetLineItems.companyId, companyId),
        eq(budgetLineItems.projectId, projectId),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw badRequest(
      `budgetLineItemId ${budgetLineItemId} is not a budget line on this project. That link is ` +
        "what puts these hours on the cost report, so it is checked rather than trusted.",
    );
  }
  return rows[0];
}

/* ------------------------------------------------------------------ */
/* Immutability after lock / export                                    */
/* ------------------------------------------------------------------ */

export const FROZEN_TIMECARD_STATUSES = ["locked", "exported", "void", "revised"] as const;

/**
 * A locked or exported card is not editable. Payroll has drawn from it and an
 * external system may already have paid it, so quietly changing the hours
 * behind that payment destroys the only reconciliation anybody has. The
 * sanctioned route — a dated adjustment card that references this one — is
 * named in the refusal, because a control that only says "no" gets worked
 * around with a second card typed under a different worker.
 */
export function assertTimecardEditable(card: TimecardRow, what: string): void {
  if (!(FROZEN_TIMECARD_STATUSES as readonly string[]).includes(card.status)) return;
  const when =
    card.status === "exported"
      ? `exported to payroll${card.payrollBatchRef ? ` as ${card.payrollBatchRef}` : ""} at ${card.exportedAt}`
      : card.status === "locked"
        ? `locked at ${card.lockedAt}`
        : card.status;
  throw conflict(
    `Cannot ${what} timecard ${card.reference}: it is ${when}. A locked or exported card is ` +
      "corrected by a dated adjustment that references it — POST " +
      `/projects/${card.projectId}/timecards/${card.id}/revise — never by an edit, because the ` +
      "figure payroll paid must stay readable next to the figure that replaced it.",
  );
}

export function assertBatchEditable(batch: BatchRow, what: string): void {
  if (batch.status !== "locked" && batch.status !== "exported") return;
  throw conflict(
    `Cannot ${what} batch ${batch.reference}: it is ${batch.status}` +
      (batch.payrollBatchRef ? ` (payroll reference ${batch.payrollBatchRef})` : "") +
      ". Reopen it only by raising adjustment cards against the individual timecards.",
  );
}

/* ------------------------------------------------------------------ */
/* Segregation of duties                                               */
/* ------------------------------------------------------------------ */

export interface SelfApprovalCheck {
  isSelfApproval: boolean;
  /** which relationship made it a self-approval */
  role: "submitted_by" | "created_by" | null;
  message: string;
}

/**
 * Is this approver approving their own claim?
 *
 * A foreman signing off the crew sheet he filled in himself is the classic
 * labour fraud — it needs no forged document and no accomplice, only the
 * absence of this check. The relationship is reported rather than a bare
 * boolean because the approval record has to say WHICH relationship was
 * breached for the refusal to mean anything a year later.
 */
export function checkSelfApproval(
  actorId: string,
  parties: { submittedBy?: string | null; createdBy?: string | null },
  what: string,
): SelfApprovalCheck {
  if (parties.submittedBy && parties.submittedBy === actorId) {
    return {
      isSelfApproval: true,
      role: "submitted_by",
      message: `the person who submitted this ${what} may not approve it`,
    };
  }
  if (parties.createdBy && parties.createdBy === actorId) {
    return {
      isSelfApproval: true,
      role: "created_by",
      message: `the person who raised this ${what} may not approve it`,
    };
  }
  return { isSelfApproval: false, role: null, message: "" };
}

export function selfApprovalRefusal(
  what: string,
  reference: string,
  check: SelfApprovalCheck,
  approvalId: string,
): AppError {
  return new AppError(
    403,
    `Segregation of duties: ${check.message}. The attempt on ${what} ${reference} has been ` +
      `recorded as approval ${approvalId} with isSelfApproval set, and appended to the ledger — ` +
      "a control that silently blocks a breach leaves no evidence it was attempted.",
    {
      control: "no_self_approval",
      role: check.role,
      approvalId,
      recorded: true,
    },
  );
}

/* ------------------------------------------------------------------ */
/* Status transitions                                                  */
/* ------------------------------------------------------------------ */

export function assertTransition(
  current: string,
  allowedFrom: readonly string[],
  what: string,
  action: string,
): void {
  if (!allowedFrom.includes(current)) {
    throw conflict(
      `Cannot ${action} a ${what} that is "${current}" — only ${allowedFrom
        .map((s) => `"${s}"`)
        .join(", ")}.`,
    );
  }
}

/**
 * Two records only participate in the same arithmetic if they are denominated
 * in the same currency. A crew paid in two currencies is two rollups, never
 * one converted at a rate this module invented.
 */
export function assertSameCurrency(
  parts: ReadonlyArray<{ label: string; currency: string }>,
  context: string,
): string {
  const seen = new Map<string, string[]>();
  for (const part of parts) {
    const cur = part.currency.toUpperCase();
    const list = seen.get(cur) ?? [];
    list.push(part.label);
    seen.set(cur, list);
  }
  if (seen.size <= 1) return [...seen.keys()][0] ?? "USD";
  const description = [...seen.entries()]
    .map(([cur, labels]) => `${cur} (${labels.slice(0, 5).join(", ")}${labels.length > 5 ? ", …" : ""})`)
    .join(" vs ");
  throw badRequest(
    `${context} spans more than one currency — ${description}. Money is never summed across ` +
      "currencies here; split the rollup by currency instead.",
  );
}
