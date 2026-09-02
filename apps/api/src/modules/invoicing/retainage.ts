import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  commitmentSovLines,
  commitments,
  invoices,
  lienWaivers,
  primeContractSovLines,
  primeContracts,
  retainageReleases,
} from "@constructos/db";
import {
  RETAINAGE_BASES,
  RETAINAGE_RELEASE_STATUSES,
  RETAINAGE_SCOPES,
  type RetainageScope,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import { assertPeriodAcceptsBilling } from "./periods.js";
import { recomputeCommitmentBilling, recomputePrimeBilling } from "./invoices.js";
import {
  CENT,
  RELEASE_COUNTER,
  assertSegregation,
  byCurrency,
  detailSchema,
  formatMoney,
  isSatisfyingWaiver,
  isoDateSchema,
  ledger,
  nonNegativeMoneySchema,
  nowIso,
  percentSchema,
  reasonSchema,
  releaseReference,
  requireInvoicingLevel,
  round2,
  todayIso,
} from "./shared.js";

export type ReleaseRow = typeof retainageReleases.$inferSelect;

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const allocationSchema = z.object({
  sovLineId: z.string().min(1).max(64),
  costCode: z.string().max(100).nullable().optional(),
  amount: nonNegativeMoneySchema,
});

const releaseCreateSchema = z.object({
  scope: z.enum(RETAINAGE_SCOPES),
  primeContractId: z.string().min(1).max(64).optional(),
  commitmentId: z.string().min(1).max(64).optional(),
  invoiceId: z.string().min(1).max(64).nullable().optional(),
  billingPeriodId: z.string().min(1).max(64).nullable().optional(),
  basis: z.enum(RETAINAGE_BASES).optional(),
  /** omit to release everything held (a final release) */
  amount: nonNegativeMoneySchema.optional(),
  /** step-down clause: the rate applying to FUTURE billings */
  newRetainagePercent: percentSchema.nullable().optional(),
  lines: z.array(allocationSchema).max(1000).optional(),
  effectiveDate: isoDateSchema.optional(),
  reason: z.string().max(4000).nullable().optional(),
  conditions: z.string().max(4000).nullable().optional(),
  requiresLienWaiver: z.boolean().optional(),
  lienWaiverId: z.string().min(1).max(64).nullable().optional(),
  detail: detailSchema.optional(),
});

const releasePatchSchema = z.object({
  amount: nonNegativeMoneySchema.optional(),
  basis: z.enum(RETAINAGE_BASES).optional(),
  newRetainagePercent: percentSchema.nullable().optional(),
  lines: z.array(allocationSchema).max(1000).optional(),
  effectiveDate: isoDateSchema.optional(),
  reason: z.string().max(4000).nullable().optional(),
  conditions: z.string().max(4000).nullable().optional(),
  requiresLienWaiver: z.boolean().optional(),
  lienWaiverId: z.string().min(1).max(64).nullable().optional(),
  detail: detailSchema.optional(),
});

const releaseListQuery = pageQuerySchema.extend({
  status: z.enum(RETAINAGE_RELEASE_STATUSES).optional(),
  scope: z.enum(RETAINAGE_SCOPES).optional(),
  commitmentId: z.string().optional(),
  primeContractId: z.string().optional(),
});

/* ------------------------------------------------------------------ */
/* Held-retainage position                                             */
/* ------------------------------------------------------------------ */

interface HeldLine {
  id: string;
  lineNumber: string;
  costCode: string | null;
  description: string;
  retainagePercent: number;
  retainageHeld: number;
  retainageReleased: number;
  totalCompletedAndStored: number;
}

interface HeldPosition {
  contractId: string;
  /** the project the contract belongs to — a release on another project is refused */
  projectId: string;
  reference: string;
  currency: string;
  vendorId: string | null;
  retainageHeld: number;
  retainageReleased: number;
  lines: HeldLine[];
}

/**
 * What is actually being held, DERIVED from the schedule of values rather
 * than from a running balance somebody might have incremented twice.
 *
 * Each SOV line already carries `retainageHeld = rate% x completed-and-stored
 * - released`, written when an invoice approval rolled it forward. Summing
 * that column is therefore the same number a G703 column K would print, and
 * it reconciles line by line against the invoices that created it.
 */
async function heldPosition(
  db: Db,
  scope: RetainageScope,
  contractId: string,
  companyId: string,
): Promise<HeldPosition> {
  if (scope === "prime_contract") {
    const [contractRows, lines] = await Promise.all([
      db
        .select()
        .from(primeContracts)
        .where(and(eq(primeContracts.id, contractId), eq(primeContracts.companyId, companyId)))
        .limit(1),
      db
        .select()
        .from(primeContractSovLines)
        .where(eq(primeContractSovLines.primeContractId, contractId))
        .orderBy(asc(primeContractSovLines.sortOrder), asc(primeContractSovLines.lineNumber)),
    ]);
    const c = contractRows[0];
    if (!c) throw badRequest("primeContractId does not reference a prime contract");
    return {
      contractId,
      projectId: c.projectId,
      reference: c.reference,
      currency: c.currency,
      vendorId: c.ownerVendorId,
      retainageHeld: round2(lines.reduce((s, l) => s + l.retainageHeld, 0)),
      retainageReleased: round2(lines.reduce((s, l) => s + l.retainageReleased, 0)),
      lines: lines.map((l) => ({
        id: l.id,
        lineNumber: l.lineNumber,
        costCode: l.costCode,
        description: l.description,
        retainagePercent: l.retainagePercent,
        retainageHeld: l.retainageHeld,
        retainageReleased: l.retainageReleased,
        totalCompletedAndStored: l.totalCompletedAndStored,
      })),
    };
  }
  const [commitmentRows, lines] = await Promise.all([
    db
      .select()
      .from(commitments)
      .where(and(eq(commitments.id, contractId), eq(commitments.companyId, companyId)))
      .limit(1),
    db
      .select()
      .from(commitmentSovLines)
      .where(eq(commitmentSovLines.commitmentId, contractId))
      .orderBy(asc(commitmentSovLines.sortOrder), asc(commitmentSovLines.lineNumber)),
  ]);
  const c = commitmentRows[0];
  if (!c) throw badRequest("commitmentId does not reference a commitment");
  return {
    contractId,
    projectId: c.projectId,
    reference: c.reference,
    currency: c.currency,
    vendorId: c.vendorId,
    retainageHeld: round2(lines.reduce((s, l) => s + l.retainageHeld, 0)),
    retainageReleased: round2(lines.reduce((s, l) => s + l.retainageReleased, 0)),
    lines: lines.map((l) => ({
      id: l.id,
      lineNumber: l.lineNumber,
      costCode: l.costCode,
      description: l.description,
      retainagePercent: l.retainagePercent,
      retainageHeld: l.retainageHeld,
      retainageReleased: l.retainageReleased,
      totalCompletedAndStored: l.totalCompletedAndStored,
    })),
  };
}

/**
 * Every held position on a project in FOUR queries, not two per contract.
 * The retainage summary calls this; a project with 150 subcontracts used to
 * issue ~300 statements to open the tab.
 */
async function heldPositionsForProject(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<{ primes: Array<HeldPosition & { title: string }>; commitments: Array<HeldPosition & { title: string }> }> {
  const [primes, subs, primeLines, subLines] = await Promise.all([
    db.select().from(primeContracts).where(and(eq(primeContracts.projectId, projectId), eq(primeContracts.companyId, companyId))),
    db.select().from(commitments).where(and(eq(commitments.projectId, projectId), eq(commitments.companyId, companyId))),
    db.select().from(primeContractSovLines).where(and(eq(primeContractSovLines.projectId, projectId), eq(primeContractSovLines.companyId, companyId))),
    db.select().from(commitmentSovLines).where(and(eq(commitmentSovLines.projectId, projectId), eq(commitmentSovLines.companyId, companyId))),
  ]);
  const fold = <L extends HeldLine & { sortOrder: number }>(lines: L[]): HeldPosition["lines"] =>
    lines
      .sort((a, b) => a.sortOrder - b.sortOrder || a.lineNumber.localeCompare(b.lineNumber))
      .map((l) => ({
        id: l.id,
        lineNumber: l.lineNumber,
        costCode: l.costCode,
        description: l.description,
        retainagePercent: l.retainagePercent,
        retainageHeld: l.retainageHeld,
        retainageReleased: l.retainageReleased,
        totalCompletedAndStored: l.totalCompletedAndStored,
      }));
  const primeBy = new Map<string, typeof primeLines>();
  for (const l of primeLines) primeBy.set(l.primeContractId, [...(primeBy.get(l.primeContractId) ?? []), l]);
  const subBy = new Map<string, typeof subLines>();
  for (const l of subLines) subBy.set(l.commitmentId, [...(subBy.get(l.commitmentId) ?? []), l]);
  return {
    primes: primes.map((c) => {
      const lines = primeBy.get(c.id) ?? [];
      return {
        contractId: c.id,
        projectId: c.projectId,
        reference: c.reference,
        title: c.title,
        currency: c.currency,
        vendorId: c.ownerVendorId,
        retainageHeld: round2(lines.reduce((s, l) => s + l.retainageHeld, 0)),
        retainageReleased: round2(lines.reduce((s, l) => s + l.retainageReleased, 0)),
        lines: fold(lines),
      };
    }),
    commitments: subs.map((c) => {
      const lines = subBy.get(c.id) ?? [];
      return {
        contractId: c.id,
        projectId: c.projectId,
        reference: c.reference,
        title: c.title,
        currency: c.currency,
        vendorId: c.vendorId,
        retainageHeld: round2(lines.reduce((s, l) => s + l.retainageHeld, 0)),
        retainageReleased: round2(lines.reduce((s, l) => s + l.retainageReleased, 0)),
        lines: fold(lines),
      };
    }),
  };
}

/**
 * Spread a release across the lines holding retainage, largest first, in
 * proportion to what each holds. Explicit allocations are honoured as given;
 * this is the fallback that makes a one-number release land somewhere
 * defensible instead of nowhere.
 */
function proRata(lines: HeldLine[], amount: number): Array<{ sovLineId: string; costCode: string | null; amount: number }> {
  const held = lines.filter((l) => l.retainageHeld > CENT);
  const total = round2(held.reduce((s, l) => s + l.retainageHeld, 0));
  if (total <= CENT) return [];
  const out: Array<{ sovLineId: string; costCode: string | null; amount: number }> = [];
  let allocated = 0;
  held.sort((a, b) => b.retainageHeld - a.retainageHeld);
  for (const [i, l] of held.entries()) {
    // The last line absorbs the rounding so the allocation sums to the
    // release exactly. A pro-rata split that loses a cent is a release that
    // never reconciles.
    const share =
      i === held.length - 1
        ? round2(amount - allocated)
        : round2((l.retainageHeld / total) * amount);
    allocated = round2(allocated + share);
    out.push({ sovLineId: l.id, costCode: l.costCode, amount: share });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/**
 * RETAINAGE RELEASES — a record, not a calculation.
 *
 * Retainage moves because somebody with authority decided it should, and the
 * decision has a shape: someone requests, someone ELSE approves, and only
 * then does the held balance move. `retainageHeldBefore` and
 * `retainageHeldAfter` bracket the change so the release audits itself, and
 * both are re-derived from the schedule of values at approval — a release
 * approved a week after it was requested must not release money that has
 * since been released by something else.
 *
 * `newRetainagePercent` carries the step-down clause (10% held to 50%
 * complete, 5% thereafter): the release is then a rate change applying to
 * future billing, not only a lump sum.
 */
export const retainageRoutes: FastifyPluginAsync = async (app) => {
  const companyGate = [app.authenticate, app.requireCompany];
  const readGate = [...companyGate, app.requireTool("invoicing", "read")];
  const standardGate = [...companyGate, app.requireTool("invoicing", "standard")];

  async function fetchRelease(releaseId: string, companyId: string): Promise<ReleaseRow> {
    const rows = await app.db
      .select()
      .from(retainageReleases)
      .where(and(eq(retainageReleases.id, releaseId), eq(retainageReleases.companyId, companyId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Retainage release not found");
    return row;
  }

  const contractIdOf = (r: ReleaseRow): string => {
    const id = r.scope === "prime_contract" ? r.primeContractId : r.commitmentId;
    if (!id) throw new Error(`retainage release ${r.id} has no contract for scope ${r.scope}`);
    return id;
  };

  /** Refuse a release bigger than what is held, naming the overage exactly. */
  function assertWithinHeld(position: HeldPosition, amount: number, reference: string): void {
    if (amount <= CENT) {
      throw badRequest(
        `A retainage release must move money. ${reference} releases ` +
          `${formatMoney(amount)} ${position.currency}.`,
      );
    }
    const over = round2(amount - position.retainageHeld);
    if (over > CENT) {
      throw badRequest(
        `Release of ${formatMoney(amount)} ${position.currency} exceeds the ` +
          `${formatMoney(position.retainageHeld)} ${position.currency} of retainage held on ` +
          `${position.reference} — over by ${formatMoney(over)}. Retainage that was never ` +
          "withheld cannot be released.",
        {
          retainageHeld: position.retainageHeld,
          requested: round2(amount),
          overage: over,
          currency: position.currency,
        },
      );
    }
  }

  /**
   * A waiver named on a release must be THIS tenant's, on THIS project, and —
   * for a commitment release — on THIS commitment. A prime-contract release
   * has no subcontractor waiver to name.
   */
  async function assertWaiverLink(
    scope: RetainageScope,
    lienWaiverId: string,
    companyId: string,
    projectId: string,
    contractId: string,
  ): Promise<void> {
    if (scope === "prime_contract") {
      throw badRequest(
        "A prime-contract retainage release is the owner's release to us; a subcontractor lien " +
          "waiver does not gate it. Drop lienWaiverId, or raise the release on the commitment.",
      );
    }
    const rows = await app.db
      .select({ id: lienWaivers.id, commitmentId: lienWaivers.commitmentId, status: lienWaivers.status })
      .from(lienWaivers)
      .where(
        and(
          eq(lienWaivers.id, lienWaiverId),
          eq(lienWaivers.companyId, companyId),
          eq(lienWaivers.projectId, projectId),
        ),
      )
      .limit(1);
    const w = rows[0];
    if (!w) throw badRequest("lienWaiverId does not reference a lien waiver on this project");
    if (w.commitmentId !== contractId) {
      throw badRequest("lienWaiverId references a waiver on a different commitment");
    }
  }

  app.post("/projects/:projectId/retainage-releases", { preHandler: standardGate }, async (req, reply) => {
    const body = releaseCreateSchema.parse(req.body);
    const projectId = req.projectId!;
    const companyId = req.companyId!;
    const contractId =
      body.scope === "prime_contract" ? body.primeContractId : body.commitmentId;
    if (!contractId) {
      throw badRequest(
        body.scope === "prime_contract"
          ? "A prime-contract retainage release needs a primeContractId"
          : "A commitment retainage release needs a commitmentId",
      );
    }
    await assertPeriodAcceptsBilling(
      app.db,
      body.billingPeriodId,
      projectId,
      companyId,
      "recording a retainage release",
    );
    const position = await heldPosition(app.db, body.scope, contractId, companyId);
    if (position.projectId !== projectId) {
      throw badRequest(
        `${position.reference} belongs to a different project. A retainage release is raised on ` +
          "the project that holds the contract, by somebody with invoicing rights there.",
      );
    }
    if (body.lienWaiverId) {
      await assertWaiverLink(body.scope, body.lienWaiverId, companyId, projectId, contractId);
    }
    const amount = round2(body.amount ?? position.retainageHeld);
    assertWithinHeld(position, amount, "This release");

    let allocation = body.lines ?? proRata(position.lines, amount);
    const allocationTotal = round2(allocation.reduce((s, l) => s + l.amount, 0));
    if (body.lines && Math.abs(allocationTotal - amount) > CENT) {
      throw badRequest(
        `The per-line allocation totals ${formatMoney(allocationTotal)} but the release is ` +
          `${formatMoney(amount)} — a release that does not allocate to the lines it came from ` +
          "cannot be reconciled.",
        { allocationTotal, amount },
      );
    }
    if (body.lines) {
      const known = new Set(position.lines.map((l) => l.id));
      const stranger = body.lines.find((l) => !known.has(l.sovLineId));
      if (stranger) {
        throw badRequest(
          `sovLineId ${stranger.sovLineId} is not a schedule-of-values line on ` +
            `${position.reference}`,
        );
      }
      allocation = body.lines.map((l) => ({
        sovLineId: l.sovLineId,
        costCode: l.costCode ?? null,
        amount: round2(l.amount),
      }));
    }

    const number = await nextRecordNumber(app.db, projectId, RELEASE_COUNTER);
    const id = newId("rrl");
    await app.db.insert(retainageReleases).values({
      id,
      companyId,
      projectId,
      number,
      reference: releaseReference(number),
      scope: body.scope,
      primeContractId: body.scope === "prime_contract" ? contractId : null,
      commitmentId: body.scope === "commitment" ? contractId : null,
      vendorId: position.vendorId,
      invoiceId: body.invoiceId ?? null,
      billingPeriodId: body.billingPeriodId ?? null,
      status: "draft",
      basis: body.basis ?? (body.newRetainagePercent != null ? "milestone_reduction" : "percent_work_completed"),
      retainageHeldBefore: position.retainageHeld,
      amount,
      retainageHeldAfter: round2(position.retainageHeld - amount),
      newRetainagePercent: body.newRetainagePercent ?? null,
      lines: allocation,
      effectiveDate: body.effectiveDate ?? todayIso(),
      reason: body.reason ?? null,
      conditions: body.conditions ?? null,
      requiresLienWaiver: body.requiresLienWaiver === true ? 1 : 0,
      lienWaiverId: body.lienWaiverId ?? null,
      detail: { ...(body.detail ?? {}), currency: position.currency, explicitAllocation: body.lines !== undefined },
      createdBy: req.user!.id,
      updatedAt: nowIso(),
    });
    const row = await fetchRelease(id, companyId);
    await ledger(app.db, req, "create", "retainage_release", id, {
      reference: row.reference,
      scope: row.scope,
      contract: position.reference,
      currency: position.currency,
      retainageHeldBefore: row.retainageHeldBefore,
      amount: row.amount,
      retainageHeldAfter: row.retainageHeldAfter,
    }, projectId);
    return reply.status(201).send({ ...row, currency: position.currency });
  });

  app.get("/projects/:projectId/retainage-releases", { preHandler: readGate }, async (req) => {
    const q = releaseListQuery.parse(req.query);
    const clauses = [eq(retainageReleases.projectId, req.projectId!)];
    if (q.status) clauses.push(eq(retainageReleases.status, q.status));
    if (q.scope) clauses.push(eq(retainageReleases.scope, q.scope));
    if (q.commitmentId) clauses.push(eq(retainageReleases.commitmentId, q.commitmentId));
    if (q.primeContractId) clauses.push(eq(retainageReleases.primeContractId, q.primeContractId));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(retainageReleases).where(where);
    const items = await app.db
      .select()
      .from(retainageReleases)
      .where(where)
      .orderBy(desc(retainageReleases.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /**
   * Held and released across the whole project, both directions, bucketed by
   * currency. Retainage we are holding FROM subs and retainage the owner is
   * holding FROM us are separate positions and are never netted — one is a
   * liability we control, the other is an asset we are waiting on.
   */
  app.get("/projects/:projectId/retainage-summary", { preHandler: readGate }, async (req) => {
    const projectId = req.projectId!;
    const companyId = req.companyId!;
    const [positions, releases] = await Promise.all([
      heldPositionsForProject(app.db, companyId, projectId),
      app.db
        .select()
        .from(retainageReleases)
        .where(eq(retainageReleases.projectId, projectId)),
    ]);
    const receivable = positions.primes.map((p) => ({
      contractId: p.contractId,
      reference: p.reference,
      title: p.title,
      currency: p.currency,
      retainageHeld: p.retainageHeld,
      retainageReleased: p.retainageReleased,
    }));
    const payable = positions.commitments.map((p) => ({
      commitmentId: p.contractId,
      reference: p.reference,
      title: p.title,
      vendorId: p.vendorId,
      currency: p.currency,
      retainageHeld: p.retainageHeld,
      retainageReleased: p.retainageReleased,
    }));

    const fold = <T extends { currency: string; retainageHeld: number; retainageReleased: number }>(
      rows: T[],
    ) =>
      byCurrency(
        rows,
        (r) => r.currency,
        (list, currency) => ({
          currency,
          contracts: list.length,
          retainageHeld: round2(list.reduce((s, r) => s + r.retainageHeld, 0)),
          retainageReleased: round2(list.reduce((s, r) => s + r.retainageReleased, 0)),
        }),
      );

    return {
      projectId,
      /** retainage the OWNER holds from us — an asset we are waiting on */
      receivable: { byCurrency: fold(receivable), contracts: receivable },
      /** retainage WE hold from subs — a liability we control */
      payable: { byCurrency: fold(payable), commitments: payable },
      pendingReleases: releases
        .filter((r) => r.status === "draft" || r.status === "pending_approval")
        .map((r) => ({
          id: r.id,
          reference: r.reference,
          scope: r.scope,
          status: r.status,
          amount: r.amount,
          effectiveDate: r.effectiveDate,
        })),
      note:
        "Retainage receivable and retainage payable are reported separately and never netted; " +
        "figures in different currencies are never summed.",
    };
  });

  app.get("/retainage-releases/:releaseId", { preHandler: companyGate }, async (req, reply) => {
    const { releaseId } = req.params as { releaseId: string };
    const release = await fetchRelease(releaseId, req.companyId!);
    await requireInvoicingLevel(app, req, reply, release.projectId, "read");
    const position = await heldPosition(
      app.db,
      release.scope as RetainageScope,
      contractIdOf(release),
      req.companyId!,
    );
    return {
      ...release,
      currency: position.currency,
      currentlyHeld: position.retainageHeld,
      /** true when the bracketing figures still hold against today's SOV */
      stillValid: Math.abs(position.retainageHeld - release.retainageHeldBefore) <= CENT,
    };
  });

  app.patch("/retainage-releases/:releaseId", { preHandler: companyGate }, async (req, reply) => {
    const { releaseId } = req.params as { releaseId: string };
    const body = releasePatchSchema.parse(req.body);
    const release = await fetchRelease(releaseId, req.companyId!);
    await requireInvoicingLevel(app, req, reply, release.projectId, "standard");
    if (release.status !== "draft") {
      throw conflict(
        `Retainage release ${release.reference} is ${release.status} and can no longer be edited`,
      );
    }
    const position = await heldPosition(
      app.db,
      release.scope as RetainageScope,
      contractIdOf(release),
      req.companyId!,
    );
    const amount = body.amount !== undefined ? round2(body.amount) : release.amount;
    assertWithinHeld(position, amount, release.reference);
    if (body.lienWaiverId) {
      await assertWaiverLink(
        release.scope as RetainageScope,
        body.lienWaiverId,
        req.companyId!,
        release.projectId,
        contractIdOf(release),
      );
    }
    const allocation =
      body.lines ??
      (body.amount !== undefined ? proRata(position.lines, amount) : (release.lines as unknown[]));
    await app.db
      .update(retainageReleases)
      .set({
        amount,
        retainageHeldBefore: position.retainageHeld,
        retainageHeldAfter: round2(position.retainageHeld - amount),
        lines: allocation as unknown[],
        ...(body.basis !== undefined ? { basis: body.basis } : {}),
        ...(body.newRetainagePercent !== undefined
          ? { newRetainagePercent: body.newRetainagePercent }
          : {}),
        ...(body.effectiveDate !== undefined ? { effectiveDate: body.effectiveDate } : {}),
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        ...(body.conditions !== undefined ? { conditions: body.conditions } : {}),
        ...(body.requiresLienWaiver !== undefined
          ? { requiresLienWaiver: body.requiresLienWaiver ? 1 : 0 }
          : {}),
        ...(body.lienWaiverId !== undefined ? { lienWaiverId: body.lienWaiverId } : {}),
        ...(body.detail !== undefined
          ? { detail: { ...(release.detail as Record<string, unknown>), ...body.detail } }
          : {}),
        updatedAt: nowIso(),
      })
      .where(eq(retainageReleases.id, releaseId));
    const row = await fetchRelease(releaseId, req.companyId!);
    await ledger(app.db, req, "update", "retainage_release", releaseId, body, release.projectId);
    return row;
  });

  app.post("/retainage-releases/:releaseId/submit", { preHandler: companyGate }, async (req, reply) => {
    const { releaseId } = req.params as { releaseId: string };
    const release = await fetchRelease(releaseId, req.companyId!);
    await requireInvoicingLevel(app, req, reply, release.projectId, "standard");
    if (release.status !== "draft") {
      throw conflict(`Retainage release ${release.reference} is ${release.status}, not draft`);
    }
    const now = nowIso();
    await app.db
      .update(retainageReleases)
      .set({
        status: "pending_approval",
        requestedBy: req.user!.id,
        requestedAt: now,
        updatedAt: now,
      })
      .where(eq(retainageReleases.id, releaseId));
    await ledger(app.db, req, "state_change", "retainage_release", releaseId, {
      from: "draft",
      to: "pending_approval",
      amount: release.amount,
    }, release.projectId, true);
    return fetchRelease(releaseId, req.companyId!);
  });

  /**
   * Approval, by someone who is neither the author nor the requester. The
   * held position is RE-DERIVED here rather than trusted from the draft: a
   * release requested last week against 50,000 of retainage cannot be
   * approved this week if only 20,000 is still held.
   */
  app.post("/retainage-releases/:releaseId/approve", { preHandler: companyGate }, async (req, reply) => {
    const { releaseId } = req.params as { releaseId: string };
    const release = await fetchRelease(releaseId, req.companyId!);
    await requireInvoicingLevel(app, req, reply, release.projectId, "admin");
    if (release.status !== "pending_approval") {
      throw conflict(
        `Retainage release ${release.reference} is ${release.status} — only a release pending ` +
          "approval is approved",
      );
    }
    assertSegregation(
      req.user!.id,
      { createdBy: release.createdBy, requestedBy: release.requestedBy },
      "retainage release",
    );
    const position = await heldPosition(
      app.db,
      release.scope as RetainageScope,
      contractIdOf(release),
      req.companyId!,
    );
    assertWithinHeld(position, release.amount, release.reference);
    const now = nowIso();
    await app.db
      .update(retainageReleases)
      .set({
        status: "approved",
        approvedBy: req.user!.id,
        approvedAt: now,
        retainageHeldBefore: position.retainageHeld,
        retainageHeldAfter: round2(position.retainageHeld - release.amount),
        updatedAt: now,
      })
      .where(eq(retainageReleases.id, releaseId));
    await ledger(app.db, req, "state_change", "retainage_release", releaseId, {
      from: "pending_approval",
      to: "approved",
      amount: release.amount,
      retainageHeldBefore: position.retainageHeld,
      retainageHeldAfter: round2(position.retainageHeld - release.amount),
    }, release.projectId, true);
    return fetchRelease(releaseId, req.companyId!);
  });

  app.post("/retainage-releases/:releaseId/reject", { preHandler: companyGate }, async (req, reply) => {
    const { releaseId } = req.params as { releaseId: string };
    const body = reasonSchema.parse(req.body);
    const release = await fetchRelease(releaseId, req.companyId!);
    await requireInvoicingLevel(app, req, reply, release.projectId, "admin");
    if (release.status !== "pending_approval") {
      throw conflict(
        `Retainage release ${release.reference} is ${release.status} — only a release pending ` +
          "approval is rejected",
      );
    }
    assertSegregation(
      req.user!.id,
      { createdBy: release.createdBy, requestedBy: release.requestedBy },
      "retainage release",
    );
    const now = nowIso();
    await app.db
      .update(retainageReleases)
      .set({
        status: "rejected",
        rejectedBy: req.user!.id,
        rejectedAt: now,
        rejectionReason: body.reason,
        updatedAt: now,
      })
      .where(eq(retainageReleases.id, releaseId));
    await ledger(app.db, req, "state_change", "retainage_release", releaseId, {
      from: "pending_approval",
      to: "rejected",
      reason: body.reason,
    }, release.projectId, true);
    return fetchRelease(releaseId, req.companyId!);
  });

  /**
   * THE MONEY MOVES HERE. Approval says yes; release does it: the allocation
   * is written back onto the schedule of values, the contract's retainage
   * columns are re-derived, and — if the release carries a step-down rate —
   * future billing withholds at the new percentage.
   */
  app.post("/retainage-releases/:releaseId/release", { preHandler: companyGate }, async (req, reply) => {
    const { releaseId } = req.params as { releaseId: string };
    const body = z
      .object({ releaseDate: isoDateSchema.optional(), overrideMissingWaiver: z.boolean().optional() })
      .parse(req.body ?? {});
    const release = await fetchRelease(releaseId, req.companyId!);
    await requireInvoicingLevel(app, req, reply, release.projectId, "admin");
    if (release.status !== "approved") {
      throw conflict(
        `Retainage release ${release.reference} is ${release.status} — only an approved release ` +
          "moves money",
      );
    }
    if (release.requiresLienWaiver === 1 && body.overrideMissingWaiver !== true) {
      if (release.scope === "prime_contract") {
        /*
         * The owner releases retainage TO us; there is no subcontractor waiver
         * to gate it on. The flag is inapplicable here and is reported, never
         * silently turned into a permanent block.
         */
      } else {
        const waivers = await app.db
          .select({ id: lienWaivers.id, reference: lienWaivers.reference, status: lienWaivers.status, commitmentId: lienWaivers.commitmentId })
          .from(lienWaivers)
          .where(
            and(
              eq(lienWaivers.companyId, req.companyId!),
              eq(lienWaivers.projectId, release.projectId),
              release.lienWaiverId
                ? eq(lienWaivers.id, release.lienWaiverId)
                : eq(lienWaivers.commitmentId, release.commitmentId ?? ""),
            ),
          );
        const onFile = waivers.filter(
          (w) => isSatisfyingWaiver(w.status) && w.commitmentId === release.commitmentId,
        );
        if (onFile.length === 0) {
          throw new AppError(
            409,
            `Retainage release ${release.reference} requires a lien waiver and none is on file` +
              (waivers.length > 0
                ? `: ${waivers.map((w) => `${w.reference} (${w.status})`).join(", ")}.`
                : ".") +
              " Final retainage is the payment most often followed by a lien claim.",
            { control: "lien_waiver_required", waivers },
          );
        }
      }
    }

    const contractId = contractIdOf(release);
    const now = nowIso();
    let after: HeldPosition | null = null;
    let allocation: Array<{ sovLineId: string; amount: number }> = [];
    let positionBefore: HeldPosition | null = null;
    /*
     * ONE transaction with the contract's lines re-read inside it: the
     * position is the position NOW, not the draft's. If it moved since the
     * draft the pro-rata is re-run over the live lines; an explicit
     * allocation that would drive any line negative is refused, naming the
     * line, rather than written.
     */
    await app.db.transaction(async (tx) => {
      const position = await heldPosition(tx, release.scope as RetainageScope, contractId, req.companyId!);
      positionBefore = position;
      assertWithinHeld(position, release.amount, release.reference);
      const stored = release.lines as Array<{ sovLineId: string; amount: number }>;
      const byId = new Map(position.lines.map((l) => [l.id, l]));
      const stillValid =
        stored.length > 0 &&
        Math.abs(round2(stored.reduce((s, a) => s + a.amount, 0)) - release.amount) <= CENT &&
        stored.every((a) => {
          const line = byId.get(a.sovLineId);
          return line !== undefined && a.amount - line.retainageHeld <= CENT;
        });
      const wasExplicit = ((release.detail as Record<string, unknown>)["explicitAllocation"] as boolean | undefined) === true;
      if (!stillValid && wasExplicit && stored.length > 0) {
        const offending = stored.filter((a) => {
          const line = byId.get(a.sovLineId);
          return !line || a.amount - line.retainageHeld > CENT;
        });
        throw conflict(
          `The allocation on ${release.reference} no longer fits the retainage held: ` +
            offending
              .map((a) => {
                const line = byId.get(a.sovLineId);
                return line
                  ? `line ${line.lineNumber} holds ${formatMoney(line.retainageHeld)} but is allocated ${formatMoney(a.amount)}`
                  : `line ${a.sovLineId} no longer exists`;
              })
              .join("; ") +
            ". Re-allocate the release against the current position.",
          );
      }
      allocation = stillValid ? stored : proRata(position.lines, release.amount);
      for (const alloc of allocation) {
        const line = byId.get(alloc.sovLineId);
        if (!line) continue;
        const released = round2(line.retainageReleased + alloc.amount);
        const held = round2(line.retainageHeld - alloc.amount);
        if (held < -CENT) {
          throw conflict(
            `Line ${line.lineNumber} on ${position.reference} holds ${formatMoney(line.retainageHeld)} ` +
              `and cannot release ${formatMoney(alloc.amount)}.`,
          );
        }
        if (release.scope === "prime_contract") {
          await tx
            .update(primeContractSovLines)
            .set({
              retainageReleased: released,
              retainageHeld: Math.max(0, held),
              ...(release.newRetainagePercent != null
                ? { retainagePercent: release.newRetainagePercent }
                : {}),
              updatedAt: now,
            })
            .where(eq(primeContractSovLines.id, line.id));
        } else {
          await tx
            .update(commitmentSovLines)
            .set({
              retainageReleased: released,
              retainageHeld: Math.max(0, held),
              ...(release.newRetainagePercent != null
                ? { retainagePercent: release.newRetainagePercent }
                : {}),
              updatedAt: now,
            })
            .where(eq(commitmentSovLines.id, line.id));
        }
      }
      if (release.scope === "prime_contract") await recomputePrimeBilling(tx, contractId);
      else await recomputeCommitmentBilling(tx, contractId);

      after = await heldPosition(tx, release.scope as RetainageScope, contractId, req.companyId!);
      await tx
        .update(retainageReleases)
        .set({
          status: "released",
          releaseDate: body.releaseDate ?? todayIso(),
          retainageHeldBefore: position.retainageHeld,
          retainageHeldAfter: after.retainageHeld,
          lines: allocation,
          detail: {
            ...(release.detail as Record<string, unknown>),
            reallocatedAtRelease: !stillValid,
            ...(body.overrideMissingWaiver === true
              ? { waiverOverriddenBy: req.user!.id, waiverOverriddenAt: now }
              : {}),
          },
          updatedAt: now,
        })
        .where(eq(retainageReleases.id, releaseId));

      /*
       * The invoice that carried the release shows the releases ACCUMULATED
       * on its face — a second release against the same invoice adds to the
       * first rather than replacing it. Its sworn columns are otherwise
       * untouched.
       */
      if (release.invoiceId) {
        const inv = (
          await tx.select({ retainageReleased: invoices.retainageReleased }).from(invoices).where(eq(invoices.id, release.invoiceId)).limit(1)
        )[0];
        if (inv) {
          await tx
            .update(invoices)
            .set({ retainageReleased: round2(inv.retainageReleased + release.amount), updatedAt: now })
            .where(eq(invoices.id, release.invoiceId));
        }
      }
    });
    const position = positionBefore!;
    const afterPos = after!;

    await ledger(app.db, req, "state_change", "retainage_release", releaseId, {
      from: "approved",
      to: "released",
      amount: release.amount,
      retainageHeldBefore: position.retainageHeld,
      retainageHeldAfter: afterPos.retainageHeld,
      newRetainagePercent: release.newRetainagePercent,
      allocation,
      waiverOverridden: body.overrideMissingWaiver === true,
    }, release.projectId, true);
    return { ...(await fetchRelease(releaseId, req.companyId!)), currentlyHeld: afterPos.retainageHeld };
  });

  app.post("/retainage-releases/:releaseId/void", { preHandler: companyGate }, async (req, reply) => {
    const { releaseId } = req.params as { releaseId: string };
    const body = reasonSchema.parse(req.body);
    const release = await fetchRelease(releaseId, req.companyId!);
    await requireInvoicingLevel(app, req, reply, release.projectId, "admin");
    if (release.status === "released") {
      throw conflict(
        `Retainage release ${release.reference} has already moved money. Raise a new withholding ` +
          "rather than voiding a completed release — both movements must stay on the record.",
      );
    }
    const now = nowIso();
    await app.db
      .update(retainageReleases)
      .set({ status: "void", rejectionReason: body.reason, updatedAt: now })
      .where(eq(retainageReleases.id, releaseId));
    await ledger(app.db, req, "state_change", "retainage_release", releaseId, {
      from: release.status,
      to: "void",
      reason: body.reason,
    }, release.projectId, true);
    return fetchRelease(releaseId, req.companyId!);
  });
};
