/**
 * Database helpers shared by the portfolio routes and the sweeps.
 * Spec Vol I §7 (#776–#789), Vol II Domain G (#423–#434), Domain Z
 * (#1053–#1066).
 *
 * Nothing here decides anything commercial: the arithmetic lives in the pure
 * engines (mcda.ts, paingain.ts, rollup.ts, frameworks.ts, jv.ts,
 * openbook.ts). This file is the boundary between those engines and the
 * tables — fetching bounded row sets, recomputing materialised totals, and
 * raising signals and obligations exactly once.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  callOffOrders,
  definedCostItems,
  jvPartners,
  jvTransactions,
  obligations,
  openBookVerifications,
  portfolioAllocations,
  projectMemberships,
  signals,
} from "@constructos/db";
import type { PortfolioSignalDetector } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { newId } from "../../lib/ids.js";
import { verificationTotals, type DefinedCostItemRow } from "./openbook.js";
import { CONSUMING_CALL_OFF_STATUSES, type CallOffRow } from "./frameworks.js";
import type { AllocationRow } from "./rollup.js";
import type { PartnerRow, TransactionRow } from "./jv.js";

/* ------------------------------------------------------------------ */
/* Visibility                                                          */
/* ------------------------------------------------------------------ */

/**
 * The projects a caller may see in a COMPANY-level list of project data.
 * Owners and admins see the whole tenant; everyone else sees the projects
 * they are a member of. `null` means "no restriction".
 *
 * Copied deliberately rather than imported: §6.3 of the plan asks each module
 * to own this so no package blocks on another landing first.
 */
export async function visibleProjectIds(
  db: Db,
  companyId: string,
  userId: string,
  companyRole: string | undefined,
): Promise<string[] | null> {
  if (companyRole === "owner" || companyRole === "admin") return null;
  const rows = await db
    .select({ projectId: projectMemberships.projectId })
    .from(projectMemberships)
    .where(and(eq(projectMemberships.companyId, companyId), eq(projectMemberships.userId, userId)));
  return rows.map((r) => r.projectId);
}

/* ------------------------------------------------------------------ */
/* Signals — raised once per key, closed when the condition clears     */
/* ------------------------------------------------------------------ */

export interface RaiseSignalArgs {
  companyId: string;
  projectId: string | null;
  detector: PortfolioSignalDetector;
  /** idempotency key stored in evidenceRefs.key */
  key: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  confidence: number;
  title: string;
  explanation: string;
  evidenceRefs: Record<string, unknown>;
}

const OPEN_DISPOSITIONS = ["new", "under_review", "confirmed", "escalated"];

async function existingSignal(
  db: Db,
  companyId: string,
  projectId: string | null,
  detector: string,
  key: string,
): Promise<{ id: string; disposition: string } | null> {
  const rows = await db
    .select({ id: signals.id, refs: signals.evidenceRefs, disposition: signals.disposition })
    .from(signals)
    .where(
      and(
        eq(signals.companyId, companyId),
        projectId ? eq(signals.projectId, projectId) : isNull(signals.projectId),
        eq(signals.detector, detector),
      ),
    );
  for (const row of rows) {
    const refs = row.refs as { key?: unknown } | null;
    if (refs && refs.key === key) return { id: row.id, disposition: row.disposition };
  }
  return null;
}

/**
 * Raise a signal unless one with the same key already exists in ANY
 * disposition. Re-running a sweep over unchanged data must not manufacture a
 * second finding — that is the false-positive fatigue Vol III §6 warns about.
 */
export async function raiseSignalOnce(
  db: Db,
  a: RaiseSignalArgs,
): Promise<{ raised: boolean; signalId: string }> {
  const existing = await existingSignal(db, a.companyId, a.projectId, a.detector, a.key);
  if (existing) return { raised: false, signalId: existing.id };
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
    evidenceRefs: { key: a.key, ...a.evidenceRefs },
  });
  return { raised: true, signalId: id };
}

/** Close an open signal by key when the condition it reported has cleared. */
export async function closeSignalByKey(
  db: Db,
  companyId: string,
  projectId: string | null,
  detector: PortfolioSignalDetector,
  key: string,
  note: string,
): Promise<boolean> {
  const existing = await existingSignal(db, companyId, projectId, detector, key);
  if (!existing || !OPEN_DISPOSITIONS.includes(existing.disposition)) return false;
  await db
    .update(signals)
    .set({ disposition: "closed", reviewerNotes: note, closedAt: new Date().toISOString() })
    .where(eq(signals.id, existing.id));
  return true;
}

/* ------------------------------------------------------------------ */
/* Obligations                                                         */
/* ------------------------------------------------------------------ */

export interface ObligationArgs {
  companyId: string;
  projectId: string;
  sourceClause: string;
  trigger: string;
  /** ISO timestamp */
  deadline: string | null;
  warnDaysBefore?: number;
  evidenceRequirement?: string;
  createdBy: string;
}

/** Create an obligation and return its id. */
export async function createObligation(db: Db, a: ObligationArgs): Promise<string> {
  const id = newId("obl");
  await db.insert(obligations).values({
    id,
    companyId: a.companyId,
    projectId: a.projectId,
    sourceClause: a.sourceClause,
    trigger: a.trigger,
    deadline: a.deadline,
    warnDaysBefore: a.warnDaysBefore ?? 7,
    evidenceRequirement: a.evidenceRequirement ?? null,
    status: "open",
    createdBy: a.createdBy,
  });
  return id;
}

/** Move an obligation from one status to another, if it is still in `from`. */
export async function setObligationStatus(
  db: Db,
  obligationId: string | null,
  from: string,
  to: string,
): Promise<void> {
  if (!obligationId) return;
  await db
    .update(obligations)
    .set({ status: to })
    .where(and(eq(obligations.id, obligationId), eq(obligations.status, from)));
}

/* ------------------------------------------------------------------ */
/* Materialised totals                                                 */
/* ------------------------------------------------------------------ */

/**
 * Recompute an open-book verification's header totals from its items.
 * Called after every item write so the register never shows a stale number.
 */
export async function recomputeVerification(
  db: Db,
  companyId: string,
  verificationId: string,
): Promise<void> {
  const [header] = await db
    .select()
    .from(openBookVerifications)
    .where(
      and(eq(openBookVerifications.id, verificationId), eq(openBookVerifications.companyId, companyId)),
    )
    .limit(1);
  if (!header) return;
  const items = await db
    .select()
    .from(definedCostItems)
    .where(
      and(eq(definedCostItems.companyId, companyId), eq(definedCostItems.verificationId, verificationId)),
    );
  const rows: DefinedCostItemRow[] = items.map((i) => ({
    id: i.id,
    component: i.component,
    currency: i.currency,
    claimedAmount: i.claimedAmount,
    verifiedAmount: i.verifiedAmount,
    verdict: i.verdict,
    evidenceRef: i.evidenceRef,
    evidenceId: i.evidenceId,
  }));
  const totals = verificationTotals(rows, header.currency);
  await db
    .update(openBookVerifications)
    .set({
      verifiedAmount: totals.verified,
      queriedAmount: totals.queried,
      disallowedAmount: totals.disallowed,
      pendingAmount: totals.pending,
      totalsCalculatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(openBookVerifications.id, verificationId));
}

/* ------------------------------------------------------------------ */
/* Row loaders shared by routes and sweeps                             */
/* ------------------------------------------------------------------ */

export async function loadAllocations(
  db: Db,
  companyId: string,
  options: { projectIds?: string[] | null } = {},
): Promise<AllocationRow[]> {
  const clauses = [eq(portfolioAllocations.companyId, companyId)];
  if (options.projectIds) {
    if (options.projectIds.length === 0) return [];
    clauses.push(inArray(portfolioAllocations.projectId, options.projectIds));
  }
  const rows = await db
    .select()
    .from(portfolioAllocations)
    .where(and(...clauses));
  return rows.map((r) => ({
    id: r.id,
    appropriationId: r.appropriationId,
    fundingSourceId: r.fundingSourceId,
    projectId: r.projectId,
    currency: r.currency,
    amount: r.amount,
    drawnAmount: r.drawnAmount,
    status: r.status,
    expenditureClass: r.expenditureClass,
    fiscalYear: r.fiscalYear,
  }));
}

export async function loadCallOffs(
  db: Db,
  companyId: string,
  options: { frameworkId?: string; termContractId?: string; projectId?: string } = {},
): Promise<CallOffRow[]> {
  const clauses = [eq(callOffOrders.companyId, companyId)];
  if (options.frameworkId) clauses.push(eq(callOffOrders.frameworkId, options.frameworkId));
  if (options.termContractId) clauses.push(eq(callOffOrders.termContractId, options.termContractId));
  if (options.projectId) clauses.push(eq(callOffOrders.projectId, options.projectId));
  const rows = await db
    .select()
    .from(callOffOrders)
    .where(and(...clauses));
  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    reference: r.reference,
    frameworkId: r.frameworkId,
    lotId: r.lotId,
    termContractId: r.termContractId,
    route: r.route,
    currency: r.currency,
    orderValue: r.orderValue,
    certifiedValue: r.certifiedValue,
    status: r.status,
  }));
}

/** Consumed value of a term contract, per its own currency. */
export async function termContractConsumption(
  db: Db,
  companyId: string,
  termContractId: string,
  currency: string,
): Promise<{ ordered: number; certified: number; count: number; currencyMismatches: number }> {
  const rows = await loadCallOffs(db, companyId, { termContractId });
  const same = rows.filter((r) => r.currency === currency);
  const consuming = same.filter((r) => CONSUMING_CALL_OFF_STATUSES.includes(r.status));
  return {
    ordered: Math.round(consuming.reduce((s, r) => s + r.orderValue, 0) * 100) / 100,
    certified: Math.round(same.reduce((s, r) => s + r.certifiedValue, 0) * 100) / 100,
    count: consuming.length,
    currencyMismatches: rows.length - same.length,
  };
}

export async function loadPartners(db: Db, companyId: string, jvId: string): Promise<PartnerRow[]> {
  const rows = await db
    .select()
    .from(jvPartners)
    .where(and(eq(jvPartners.companyId, companyId), eq(jvPartners.jvId, jvId)));
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      sharePercent: r.sharePercent,
      committedCapital: r.committedCapital,
      liabilityBasis: r.liabilityBasis,
      isSelf: r.isSelf === 1,
      status: r.status,
    }))
    .sort((a, b) => b.sharePercent - a.sharePercent || a.name.localeCompare(b.name));
}

export async function loadJvTransactions(
  db: Db,
  companyId: string,
  jvId: string,
): Promise<TransactionRow[]> {
  const rows = await db
    .select()
    .from(jvTransactions)
    .where(and(eq(jvTransactions.companyId, companyId), eq(jvTransactions.jvId, jvId)));
  return rows.map((r) => ({
    id: r.id,
    partnerId: r.partnerId,
    kind: r.kind,
    currency: r.currency,
    amount: r.amount,
    dueDate: r.dueDate,
    settledDate: r.settledDate,
    status: r.status,
  }));
}

/**
 * Statuses a disallowance is still live in. Shared by the sweep and the
 * register summary so the two can never disagree about what "unresolved"
 * means.
 */
export const UNRESOLVED_DISALLOWED_STATUSES = ["raised", "under_review", "disputed"];
