import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, ne, or } from "drizzle-orm";
import { z } from "zod";
import {
  billingPeriods,
  budgetChanges,
  budgetLineItems,
  budgets,
  changeOrderPackages,
  contacts,
  contracts,
  invoiceLineItems,
  invoices,
  paymentApplications,
  primeContractChanges,
  primeContractComplianceDocuments,
  primeContractSovLines,
  primeContracts,
  vendors,
} from "@constructos/db";
import {
  CHANGE_ORDER_STATUSES,
  CHANGE_REASONS,
  CONTRACT_PRICING_TYPES,
  COST_TYPES,
  PRIME_CONTRACT_STATUSES,
  SOV_BILLING_METHODS,
  type PermissionLevel,
  type PrimeContractStatus,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { rollUpTotals as rollUpBudgetTotals } from "../budget/calc.js";
import { derivedColumns as deriveBudgetColumns } from "../budget/derive.js";
import { complianceGate } from "./analytics.js";
import { primeLifecycleRoutes } from "./lifecycle.js";
import {
  CERTIFIED_APP_STATUSES,
  OPEN_APP_STATUSES,
  certifiedBilledOf,
  fetchBilling as fetchBillingRow,
  fetchContract as fetchContractRow,
  loadChanges as loadChangeRows,
  loadSov as loadSovRows,
  nowIso,
  recalcContract as recalcContractRow,
  recordReceipt,
  requireContractsLevel,
  today,
  type AppRow,
  type Billing,
  type ChangeRow,
  type ContractRow,
  type InvoiceRow,
  type SovRow,
} from "./shared.js";
import {
  changeOrderLineNumber,
  changeSums,
  checkSovAgainstContract,
  computeApplication,
  derivePeriodValues,
  executionDateProblem,
  formatMoney,
  mirrorLine,
  nearlyEqual,
  pad3,
  percentCompleteOf,
  reconcileContract,
  revisedScheduledValueOf,
  rollForward,
  round2,
  round4,
  sovTotals,
  unavailable,
  validatePeriodValues,
  type BillableLine,
  type Component,
  type DerivedPeriodValues,
  type G703Row,
  type LineBillingInput,
  type RetainageTerms,
} from "./sov.js";

/* ------------------------------------------------------------------ */
/* Wire schemas                                                        */
/* ------------------------------------------------------------------ */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");
const money = z.number().finite();
const idRef = z.string().min(1).max(64);
const percent = z.number().min(0).max(100);

/**
 * The half of the retainage clause that has no column of its own. The work
 * rate lives on `prime_contracts.default_retainage_percent`; the stored-
 * material rate and the step-down live in `detail.retainage`, which is what
 * that jsonb column is for.
 */
const retainageTermsSchema = z.object({
  materialsPercent: percent.nullable().optional(),
  reductionThresholdPercent: percent.nullable().optional(),
  reducedPercent: percent.nullable().optional(),
});

const contractCreateSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  scopeOfWork: z.string().max(50000).nullable().optional(),
  ownerVendorId: idRef.nullable().optional(),
  ownerContactId: idRef.nullable().optional(),
  contractorVendorId: idRef.nullable().optional(),
  architectVendorId: idRef.nullable().optional(),
  contractId: idRef.nullable().optional(),
  pricingType: z.enum(CONTRACT_PRICING_TYPES).optional(),
  currency: z.string().min(3).max(8).optional(),
  originalContractSum: money.optional(),
  defaultRetainagePercent: percent.optional(),
  retainage: retainageTermsSchema.optional(),
  contractDate: isoDate.nullable().optional(),
  startDate: isoDate.nullable().optional(),
  substantialCompletionDate: isoDate.nullable().optional(),
  signedContractReceivedDate: isoDate.nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  inclusions: z.string().max(20000).nullable().optional(),
  exclusions: z.string().max(20000).nullable().optional(),
  documentIds: z.array(idRef).max(200).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const contractPatchSchema = contractCreateSchema.partial().extend({
  actualCompletionDate: isoDate.nullable().optional(),
  terminationDate: isoDate.nullable().optional(),
  /**
   * Where a change to `originalContractSum` lands in the schedule of values.
   * A contract sum that moves without the schedule moving with it is the
   * exact failure this module exists to prevent, so a sum change on a
   * contract that already has lines must say which line takes the delta.
   */
  absorbIntoLineId: idRef.optional(),
});

const contractListQuery = pageQuerySchema.extend({
  status: z.enum(PRIME_CONTRACT_STATUSES).optional(),
  executed: z.enum(["true", "false"]).optional(),
  q: z.string().max(200).optional(),
});

const executeSchema = z.object({
  executionDate: isoDate,
  signedContractReceivedDate: isoDate.nullable().optional(),
});

/**
 * The owner's (or architect's) identity on an approval or a certification —
 * the owner modelled as an actor (#511). Recorded on the record and in the
 * ledger; a document hash ties the act to the signed instrument.
 */
const externalSignatorySchema = z.object({
  contactId: idRef.nullable().optional(),
  name: z.string().min(1).max(200),
  signedAt: isoDate.optional(),
  documentHash: z.string().max(128).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const statusSchema = z.object({
  status: z.enum(PRIME_CONTRACT_STATUSES),
  reason: z.string().max(2000).nullable().optional(),
  actualCompletionDate: isoDate.nullable().optional(),
  terminationDate: isoDate.nullable().optional(),
});

const sovLineFieldsSchema = z.object({
  lineNumber: z.string().min(1).max(40),
  description: z.string().min(1).max(2000),
  scheduledValue: money,
  sortOrder: z.number().int().min(0).max(100000).optional(),
  costCodeId: idRef.nullable().optional(),
  costCode: z.string().max(50).nullable().optional(),
  costType: z.enum(COST_TYPES).nullable().optional(),
  budgetLineItemId: idRef.nullable().optional(),
  billingMethod: z.enum(SOV_BILLING_METHODS).optional(),
  unit: z.string().max(20).nullable().optional(),
  quantity: money.nullable().optional(),
  unitRate: money.nullable().optional(),
  retainagePercent: percent.optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const sovPutSchema = z.object({
  lines: z.array(sovLineFieldsSchema).max(2000),
  /**
   * Bottom-up build: let the SOV define the contract sum rather than the
   * other way round. Only legal while the contract is unexecuted — after
   * execution the sum is what both parties signed and only an executed
   * change order moves it.
   */
  syncContractSum: z.boolean().optional(),
});

const sovLineCreateSchema = sovLineFieldsSchema.extend({
  /**
   * Bottom-up growth on an unexecuted contract: this line brings NEW scope,
   * so the contract sum rises by exactly its value and the sheet stays
   * balanced through the write. Without it the line must fill scope that is
   * already in the sum but not yet allocated.
   */
  raiseContractSum: z.boolean().optional(),
});

const sovLinePatchSchema = sovLineFieldsSchema.partial().extend({
  /**
   * Keep the schedule balanced by moving the difference onto another line.
   * Scope has to come from somewhere; this is where it comes from.
   */
  absorbIntoLineId: idRef.optional(),
});

const sovLineDeleteSchema = z.object({ absorbIntoLineId: idRef.optional() });

const changeLineSchema = z.object({
  sovLineId: idRef.nullable().optional(),
  costCode: z.string().max(50).nullable().optional(),
  costType: z.enum(COST_TYPES).nullable().optional(),
  description: z.string().min(1).max(2000),
  amount: money,
});

const changeCreateSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  reason: z.enum(CHANGE_REASONS).optional(),
  changeOrderPackageId: idRef.nullable().optional(),
  amount: money.optional(),
  scheduleImpactDays: z.number().int().min(-3650).max(3650).optional(),
  lines: z.array(changeLineSchema).max(500).optional(),
  requestedDate: isoDate.nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const changePatchSchema = changeCreateSchema.partial();

const changeListQuery = pageQuerySchema.extend({
  status: z.enum(CHANGE_ORDER_STATUSES).optional(),
});

const rejectSchema = z.object({ reason: z.string().min(1).max(2000) });
const voidSchema = z.object({ reason: z.string().min(1).max(2000) });

const changeApproveSchema = z.object({
  ownerApproval: externalSignatorySchema.optional(),
});

const billingCreateSchema = z.object({
  billingDate: isoDate,
  periodStart: isoDate.nullable().optional(),
  periodEnd: isoDate.nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  billingPeriodId: idRef.nullable().optional(),
  title: z.string().max(300).nullable().optional(),
});

const billingPatchSchema = billingCreateSchema.partial();

const billingLinesSchema = z.object({
  lines: z
    .array(
      z.object({
        sovLineId: idRef,
        thisPeriodWork: money.nullable().optional(),
        thisPeriodQuantity: money.nullable().optional(),
        percentComplete: percent.nullable().optional(),
        thisPeriodStoredMaterials: money.nullable().optional(),
        materialsPresentlyStored: money.nullable().optional(),
        notes: z.string().max(5000).nullable().optional(),
      }),
    )
    .max(2000),
});

const submitSchema = z.object({
  certifiedByContractorName: z.string().min(1).max(200),
  notaryReference: z.string().max(200).nullable().optional(),
});

const certifySchema = z.object({
  certifiedAmount: money.optional(),
  certificationNotes: z.string().max(5000).nullable().optional(),
  architectVendorId: idRef.nullable().optional(),
  /** who signed the certificate on the owner/architect side */
  certifier: externalSignatorySchema.optional(),
});

const paySchema = z.object({
  paidAmount: money.optional(),
  paidAt: isoDate.optional(),
  paymentReference: z.string().max(200).nullable().optional(),
  method: z.enum(["ach", "wire", "check", "card", "other"]).optional(),
  bankReference: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const billingListQuery = pageQuerySchema.extend({
  billingPeriodId: idRef.optional(),
});

/* ------------------------------------------------------------------ */
/* Row types and small helpers                                         */
/* ------------------------------------------------------------------ */

/** The one SoD control this module applies; the web renders it as "the control did its job". */
const segregation = (message: string): AppError =>
  new AppError(403, message, { control: "no_self_certification" });

/**
 * The prime contract lifecycle. `approved` is reachable only through
 * /approve (which carries the segregation-of-duties check) and execution is
 * a separate flag on top of it, not a status — a contract can be approved
 * internally for weeks before both parties sign.
 */
const STATUS_TRANSITIONS: Record<PrimeContractStatus, readonly PrimeContractStatus[]> = {
  draft: ["out_for_bid", "out_for_signature", "void"],
  out_for_bid: ["out_for_signature", "draft", "void"],
  out_for_signature: ["draft", "void"],
  approved: ["complete", "terminated", "void"],
  complete: [],
  terminated: [],
  void: [],
};

/** Read the retainage clause off the contract row. */
function retainageTermsOf(contract: ContractRow): RetainageTerms {
  const stored = (contract.detail as Record<string, unknown> | null)?.["retainage"];
  const t = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const workPercent = contract.defaultRetainagePercent;
  return {
    workPercent,
    // Unstated means "the same as work" — the overwhelmingly common clause,
    // and the one an owner's counsel will assume. A contract that holds
    // nothing on stored material says so explicitly with materialsPercent: 0.
    materialsPercent: num(t["materialsPercent"]) ?? workPercent,
    reductionThresholdPercent: num(t["reductionThresholdPercent"]),
    reducedPercent: num(t["reducedPercent"]),
  };
}

/** Merge a retainage patch into the contract's `detail` blob. */
function mergeRetainageDetail(
  contract: Pick<ContractRow, "detail">,
  patch: z.infer<typeof retainageTermsSchema> | undefined,
): Record<string, unknown> {
  const detail = { ...((contract.detail as Record<string, unknown> | null) ?? {}) };
  if (!patch) return detail;
  const existing = (detail["retainage"] as Record<string, unknown> | undefined) ?? {};
  detail["retainage"] = {
    ...existing,
    ...(patch.materialsPercent !== undefined ? { materialsPercent: patch.materialsPercent } : {}),
    ...(patch.reductionThresholdPercent !== undefined
      ? { reductionThresholdPercent: patch.reductionThresholdPercent }
      : {}),
    ...(patch.reducedPercent !== undefined ? { reducedPercent: patch.reducedPercent } : {}),
  };
  return detail;
}

/**
 * A SOV row, projected onto exactly what the arithmetic reads. Drizzle rows
 * satisfy `BillableLine` structurally already; this exists so the projection
 * is one place when a column is renamed.
 */
const billable = (l: SovRow): BillableLine => l;

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

/**
 * PRIME CONTRACTS (M3, spec Vol I §3.2) — the owner-side agreement, its
 * schedule of values, and progress billing against it.
 *
 * TOOL KEY: `contracts`.
 *
 * The four financial siblings each own the permission key named after them
 * (`budget`, `commitments`, `change_management`, `invoicing`), which leaves
 * the prime contract needing one of its own. `contracts` is it, and it is
 * the right one rather than the leftover one: this module administers a
 * contract — parties, sum, dates, execution — and `contracts` is already the
 * key guarding the standard-form contract record (`contracts` table,
 * FIDIC/NEC/JCT clause sets) that a prime contract optionally points at
 * through `contractId`. The same person who administers the clause set
 * administers the agreement it governs. `commercial` was the alternative and
 * is a worse fit: it guards the measurement-and-valuation engine (BoQs,
 * interim valuations, variations), a different discipline on a different
 * record set, and folding the owner contract into it would mean a QS with
 * BoQ access silently acquiring the power to execute a prime contract.
 *
 * The billing routes sit under this key too, deliberately: billing the owner
 * against a prime contract's SOV is an act of prime-contract administration,
 * and the certifier gate that matters (`admin`) is a level, not a key. See
 * the notes on `invoicing` in the module summary.
 *
 * WHAT IS ENFORCED HERE, AND WHY IT IS ENFORCED HERE
 *  - Σ SOV = the contract sum, on every write. A G703 that does not total
 *    the G702's line 3 is not a continuation sheet.
 *  - Execution cannot precede award, and only an executed contract may be
 *    billed against.
 *  - Executed change orders APPEND SOV lines. Originals are never edited, so
 *    a continuation sheet always reconciles back to the signed contract.
 *  - Certification is a third party's act: the certifier may be neither the
 *    creator nor the submitter of the application (ADR 0004), and may certify
 *    LESS than was applied for but never more.
 *  - A certified application is a legal record. It does not reopen.
 */
export const primeContractsModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("contracts", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("contracts", "standard"),
  ];
  const companyGate = [app.authenticate, app.requireCompany];

  /**
   * Tool gate for the sub-resource routes that carry no `:projectId` param.
   * The owning project is resolved from the record, injected into params and
   * put through the standard gate — so `/prime-contracts/:id/...` enforces
   * exactly the levels `/projects/:projectId/prime-contracts` does.
   */
  const requireLevel = (
    req: FastifyRequest,
    reply: FastifyReply,
    projectId: string,
    level: PermissionLevel,
  ): Promise<void> => requireContractsLevel(app as FastifyInstance, req, reply, projectId, level);

  /* ---------------------------------------------------------------- */
  /* Fetchers                                                          */
  /* ---------------------------------------------------------------- */

  const fetchContract = (id: string, companyId: string): Promise<ContractRow> =>
    fetchContractRow(app.db, id, companyId);
  const loadSov = (primeContractId: string): Promise<SovRow[]> => loadSovRows(app.db, primeContractId);
  const loadChanges = (primeContractId: string): Promise<ChangeRow[]> =>
    loadChangeRows(app.db, primeContractId);

  async function fetchChange(
    contract: ContractRow,
    changeId: string,
  ): Promise<ChangeRow> {
    const rows = await app.db
      .select()
      .from(primeContractChanges)
      .where(
        and(
          eq(primeContractChanges.id, changeId),
          eq(primeContractChanges.primeContractId, contract.id),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Prime contract change not found");
    return rows[0];
  }

  /** A billing = the owner invoice (G703) plus the payment application (G702). */
  const fetchBilling = (contract: ContractRow, billingId: string): Promise<Billing> =>
    fetchBillingRow(app.db, contract, billingId);

  /** Refuse to touch money inside a period someone has closed or locked. */
  async function assertPeriodWritable(
    billingPeriodId: string | null,
    projectId: string,
    what: string,
  ): Promise<void> {
    if (!billingPeriodId) return;
    const rows = await app.db
      .select()
      .from(billingPeriods)
      .where(
        and(eq(billingPeriods.id, billingPeriodId), eq(billingPeriods.projectId, projectId)),
      )
      .limit(1);
    const period = rows[0];
    if (!period) throw badRequest("billingPeriodId does not reference a period on this project");
    if (period.status !== "open") {
      throw conflict(
        `Billing period ${period.reference} is ${period.status} — ${what} inside a ` +
          `${period.status} period would change a number the monthly report has already ` +
          "published. Reopen the period first, or bill into the next one.",
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Totals                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Re-derive every rollup column on the contract from the rows underneath
   * it (shared.ts). `totalBilled` is the CERTIFIED position.
   */
  const recalcContract = (contractId: string, companyId: string): Promise<ContractRow> =>
    recalcContractRow(app.db, contractId, companyId);

  /** Contract + SOV identity + reconciliation, the shape every read returns. */
  async function contractView(contract: ContractRow) {
    const lines = await loadSov(contract.id);
    const identity = checkSovAgainstContract(lines.map(billable), {
      originalContractSum: contract.originalContractSum,
      approvedChangeSum: contract.approvedChangeSum,
      currency: contract.currency,
    });
    const totals = sovTotals(lines.map(billable));
    // The identity compares like with like: the CERTIFIED billed position on
    // the lines against the certified total stored on the contract. Work on
    // a draft application is mirrored onto the lines for the G703 and is
    // reported separately as `draftBilled`, never as a failed identity.
    const lineBilledToDate = round2(lines.reduce((s, l) => s + certifiedBilledOf(l), 0));
    const draftBilled = round2(
      lines.reduce((s, l) => s + l.totalCompletedAndStored, 0) - lineBilledToDate,
    );
    const lineRetainageHeld = round2(lines.reduce((s, l) => s + l.retainageHeld, 0));
    const identities = reconcileContract({
      originalContractSum: contract.originalContractSum,
      approvedChangeSum: contract.approvedChangeSum,
      revisedContractSum: contract.revisedContractSum,
      sovTotal: totals.revisedScheduledValue,
      totalBilled: contract.totalBilled,
      retainageHeld: contract.retainageHeld,
      balanceToFinish: contract.balanceToFinish,
      lineRetainageHeld,
      lineBilledToDate,
    });
    const percentComplete = percentCompleteOf(
      contract.totalBilled,
      contract.revisedContractSum,
      `Prime contract ${contract.reference}`,
    );
    return {
      ...contract,
      retainageTerms: retainageTermsOf(contract),
      sov: { totals, identity },
      percentComplete,
      /** this-period work on an open (uncertified) application, outside totalBilled */
      draftBilled,
      identities,
      reconciled: identities.every((i) => i.ok) && identity.ok,
    };
  }

  /**
   * The SOV-equals-contract-sum gate. Every write that touches either side
   * of the identity ends here, and the refusal names the discrepancy rather
   * than reporting that something was "invalid".
   */
  function assertSovBalanced(
    lines: readonly BillableLine[],
    sums: { originalContractSum: number; approvedChangeSum: number; currency: string },
  ): void {
    const check = checkSovAgainstContract(lines, sums);
    if (!check.ok) {
      throw new AppError(409, check.message, {
        sovTotal: check.sovTotal,
        contractSum: check.contractSum,
        discrepancy: check.discrepancy,
        direction: check.direction,
        currency: check.currency,
        legs: check.legs,
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Prime contracts                                                   */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/prime-contracts",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = contractCreateSchema.parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      await assertVendors(body, companyId);
      await assertContractLink(body.contractId, companyId, projectId);
      await assertOwnerContact(body.ownerContactId, companyId);
      const number = await nextRecordNumber(app.db, projectId, "prime_contract");
      const id = newId("pct");
      const original = round2(body.originalContractSum ?? 0);
      await app.db.insert(primeContracts).values({
        id,
        companyId,
        projectId,
        number,
        reference: `PC-${pad3(number)}`,
        title: body.title,
        description: body.description ?? null,
        scopeOfWork: body.scopeOfWork ?? null,
        ownerVendorId: body.ownerVendorId ?? null,
        ownerContactId: body.ownerContactId ?? null,
        contractorVendorId: body.contractorVendorId ?? null,
        architectVendorId: body.architectVendorId ?? null,
        contractId: body.contractId ?? null,
        pricingType: body.pricingType ?? "lump_sum",
        status: "draft",
        executed: 0,
        currency: body.currency ?? "USD",
        originalContractSum: original,
        revisedContractSum: original,
        balanceToFinish: original,
        defaultRetainagePercent: body.defaultRetainagePercent ?? 0,
        contractDate: body.contractDate ?? null,
        startDate: body.startDate ?? null,
        substantialCompletionDate: body.substantialCompletionDate ?? null,
        signedContractReceivedDate: body.signedContractReceivedDate ?? null,
        paymentTermsDays: body.paymentTermsDays ?? null,
        inclusions: body.inclusions ?? null,
        exclusions: body.exclusions ?? null,
        documentIds: body.documentIds ?? [],
        detail: mergeRetainageDetail({ detail: body.detail ?? {} }, body.retainage),
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "create",
        objectType: "prime_contract",
        objectId: id,
        payload: {
          number,
          title: body.title,
          originalContractSum: original,
          currency: body.currency ?? "USD",
        },
        storePayload: true,
      });
      return reply.status(201).send(await contractView(await fetchContract(id, companyId)));
    },
  );

  /** `contractId` must be a standard-form contract record on THIS project and company. */
  async function assertContractLink(
    contractId: string | null | undefined,
    companyId: string,
    projectId: string,
  ): Promise<void> {
    if (!contractId) return;
    const rows = await app.db
      .select({ id: contracts.id })
      .from(contracts)
      .where(
        and(
          eq(contracts.id, contractId),
          eq(contracts.companyId, companyId),
          eq(contracts.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw badRequest("contractId does not reference a contract on this project");
  }

  /** `ownerContactId` must be a directory contact of this company. */
  async function assertOwnerContact(
    contactId: string | null | undefined,
    companyId: string,
  ): Promise<void> {
    if (!contactId) return;
    const rows = await app.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw badRequest("ownerContactId is not a contact in this company's directory");
  }

  async function assertVendors(
    body: Partial<z.infer<typeof contractCreateSchema>>,
    companyId: string,
  ): Promise<void> {
    const ids = [body.ownerVendorId, body.contractorVendorId, body.architectVendorId].filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    if (ids.length === 0) return;
    const rows = await app.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(inArray(vendors.id, ids), eq(vendors.companyId, companyId)));
    const found = new Set(rows.map((r) => r.id));
    for (const id of ids) {
      if (!found.has(id)) throw badRequest(`Vendor ${id} is not in this company's directory`);
    }
  }

  app.get("/projects/:projectId/prime-contracts", { preHandler: readGate }, async (req) => {
    const q = contractListQuery.parse(req.query);
    const clauses = [
      eq(primeContracts.companyId, req.companyId!),
      eq(primeContracts.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(primeContracts.status, q.status));
    if (q.executed) clauses.push(eq(primeContracts.executed, q.executed === "true" ? 1 : 0));
    // The text search is part of the WHERE, so the count and every page
    // reflect the same filtered set — a match on page 2 is not invisible
    // from page 1.
    if (q.q && q.q.trim() !== "") {
      const needle = `%${q.q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      const textMatch = or(ilike(primeContracts.title, needle), ilike(primeContracts.reference, needle));
      if (textMatch) clauses.push(textMatch);
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(primeContracts).where(where);
    const items = await app.db
      .select()
      .from(primeContracts)
      .where(where)
      .orderBy(desc(primeContracts.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /**
   * The portfolio position, grouped BY CURRENCY and never across it. A
   * project holding a USD prime and a EUR prime has two positions and no
   * combined total — the combined figure comes back null with the reason
   * attached rather than as a number nobody can spend.
   */
  app.get(
    "/projects/:projectId/prime-contracts/summary",
    { preHandler: readGate },
    async (req) => {
      const rows = await app.db
        .select()
        .from(primeContracts)
        .where(
          and(
            eq(primeContracts.companyId, req.companyId!),
            eq(primeContracts.projectId, req.projectId!),
            ne(primeContracts.status, "void"),
          ),
        );
      const byCurrency = new Map<string, ContractRow[]>();
      for (const r of rows) {
        const list = byCurrency.get(r.currency) ?? [];
        list.push(r);
        byCurrency.set(r.currency, list);
      }
      const groups = [...byCurrency.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, list]) => {
          const sum = (pick: (c: ContractRow) => number): number =>
            round2(list.reduce((s, c) => s + pick(c), 0));
          const revised = sum((c) => c.revisedContractSum);
          const billed = sum((c) => c.totalBilled);
          return {
            currency,
            contractCount: list.length,
            executedCount: list.filter((c) => c.executed === 1).length,
            originalContractSum: sum((c) => c.originalContractSum),
            approvedChangeSum: sum((c) => c.approvedChangeSum),
            pendingChangeSum: sum((c) => c.pendingChangeSum),
            revisedContractSum: revised,
            totalBilled: billed,
            totalPaid: sum((c) => c.totalPaid),
            retainageHeld: sum((c) => c.retainageHeld),
            balanceToFinish: sum((c) => c.balanceToFinish),
            percentComplete: percentCompleteOf(billed, revised, `The ${currency} prime contracts`),
          };
        });
      const combined: Component =
        groups.length === 1
          ? {
              value: groups[0]!.revisedContractSum,
              inputs: { currency: groups[0]!.currency, contracts: groups[0]!.contractCount },
              reasons: [],
            }
          : unavailable(
              groups.length === 0
                ? ["No prime contracts on this project."]
                : [
                    `Prime contracts on this project are denominated in ${groups
                      .map((g) => g.currency)
                      .join(", ")} — contract sums are never summed across currencies.`,
                  ],
              { currencies: groups.map((g) => g.currency) },
            );
      return { groups, combinedRevisedContractSum: combined };
    },
  );

  app.get("/prime-contracts/:primeContractId", { preHandler: companyGate }, async (req, reply) => {
    const { primeContractId } = req.params as { primeContractId: string };
    const contract = await fetchContract(primeContractId, req.companyId!);
    await requireLevel(req, reply, contract.projectId, "read");
    return contractView(contract);
  });

  app.patch("/prime-contracts/:primeContractId", { preHandler: companyGate }, async (req, reply) => {
    const { primeContractId } = req.params as { primeContractId: string };
    const body = contractPatchSchema.parse(req.body);
    const contract = await fetchContract(primeContractId, req.companyId!);
    await requireLevel(req, reply, contract.projectId, "standard");
    if (contract.status === "void" || contract.status === "terminated") {
      throw conflict(`A ${contract.status} prime contract cannot be edited`);
    }
    await assertVendors(body, req.companyId!);
    await assertContractLink(body.contractId, req.companyId!, contract.projectId);
    await assertOwnerContact(body.ownerContactId, req.companyId!);

    // The contract sum is one half of an identity. Moving it without moving
    // the schedule of values breaks the G703, so it is checked here and not
    // after the fact.
    let absorbLine: SovRow | undefined;
    let absorbValue = 0;
    if (body.originalContractSum !== undefined) {
      if (contract.executed === 1) {
        throw conflict(
          "The contract sum of an executed prime contract cannot be typed over — raise an " +
            "executed change order, which appends the value to the schedule of values as it " +
            "adds it to the sum.",
        );
      }
      const lines = await loadSov(contract.id);
      if (lines.length > 0) {
        const delta = round2(round2(body.originalContractSum) - contract.originalContractSum);
        if (body.absorbIntoLineId) {
          absorbLine = lines.find((l) => l.id === body.absorbIntoLineId);
          if (!absorbLine) throw badRequest("absorbIntoLineId is not a line on this contract");
          if (absorbLine.isChangeOrderLine === 1) {
            throw badRequest(
              `Line ${absorbLine.lineNumber} was appended by a change order — base scope cannot ` +
                "be moved into it.",
            );
          }
          if (!nearlyEqual(absorbLine.totalCompletedAndStored, 0)) {
            throw conflict(
              `Line ${absorbLine.lineNumber} has already been billed and cannot absorb a ` +
                "contract sum change.",
            );
          }
          absorbValue = round2(absorbLine.scheduledValue + delta);
          if (absorbValue < -0.005) {
            throw badRequest(
              `Line ${absorbLine.lineNumber} holds ${formatMoney(absorbLine.scheduledValue)} ` +
                `${contract.currency}, less than the ${formatMoney(Math.abs(delta))} being taken ` +
                "out of it.",
            );
          }
        }
        const proposed = lines.map((l): BillableLine =>
          absorbLine && l.id === absorbLine.id
            ? { ...billable(l), scheduledValue: absorbValue }
            : billable(l),
        );
        assertSovBalanced(proposed, {
          originalContractSum: round2(body.originalContractSum),
          approvedChangeSum: contract.approvedChangeSum,
          currency: body.currency ?? contract.currency,
        });
      }
    }
    if (body.currency !== undefined && body.currency !== contract.currency) {
      const billed = await app.db
        .select({ n: count() })
        .from(invoices)
        .where(eq(invoices.primeContractId, contract.id));
      if (Number(billed[0]?.n ?? 0) > 0) {
        throw conflict(
          "A prime contract that has been billed cannot change currency — the applications " +
            "already issued are denominated in " +
            `${contract.currency} and re-denominating them would be a fabrication.`,
        );
      }
    }

    const patch: Partial<typeof primeContracts.$inferInsert> = { updatedAt: nowIso() };
    const assign = <K extends keyof typeof patch>(key: K, value: (typeof patch)[K]): void => {
      if (value !== undefined) patch[key] = value;
    };
    assign("title", body.title);
    assign("description", body.description);
    assign("scopeOfWork", body.scopeOfWork);
    assign("ownerVendorId", body.ownerVendorId);
    assign("ownerContactId", body.ownerContactId);
    assign("contractorVendorId", body.contractorVendorId);
    assign("architectVendorId", body.architectVendorId);
    assign("contractId", body.contractId);
    assign("pricingType", body.pricingType);
    assign("currency", body.currency);
    assign("defaultRetainagePercent", body.defaultRetainagePercent);
    assign("contractDate", body.contractDate);
    assign("startDate", body.startDate);
    assign("substantialCompletionDate", body.substantialCompletionDate);
    assign("actualCompletionDate", body.actualCompletionDate);
    assign("signedContractReceivedDate", body.signedContractReceivedDate);
    assign("terminationDate", body.terminationDate);
    assign("paymentTermsDays", body.paymentTermsDays);
    assign("inclusions", body.inclusions);
    assign("exclusions", body.exclusions);
    assign("documentIds", body.documentIds);
    if (body.originalContractSum !== undefined) {
      patch.originalContractSum = round2(body.originalContractSum);
    }
    if (body.retainage !== undefined || body.detail !== undefined) {
      patch.detail = mergeRetainageDetail(
        { detail: body.detail ?? contract.detail },
        body.retainage,
      );
    }
    await app.db.transaction(async (tx) => {
      await tx.update(primeContracts).set(patch).where(eq(primeContracts.id, contract.id));
      if (absorbLine) {
        await tx
          .update(primeContractSovLines)
          .set({
            scheduledValue: absorbValue,
            revisedScheduledValue: round2(absorbValue + absorbLine.changeOrderValue),
            balanceToFinish: round2(
              absorbValue + absorbLine.changeOrderValue - absorbLine.totalCompletedAndStored,
            ),
            updatedAt: nowIso(),
          })
          .where(eq(primeContractSovLines.id, absorbLine.id));
      }
    });
    const recalculated = await recalcContract(contract.id, req.companyId!);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      projectId: contract.projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "prime_contract",
      objectId: contract.id,
      payload: { changed: Object.keys(body), revisedContractSum: recalculated.revisedContractSum },
    });
    return contractView(recalculated);
  });

  /**
   * Internal approval. The approver may be neither the creator nor anybody
   * who has already signed off — ADR 0004, and the reason a contract sum
   * cannot be raised and blessed by the same hand in one sitting.
   */
  app.post(
    "/prime-contracts/:primeContractId/approve",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId } = req.params as { primeContractId: string };
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "admin");
      if (!["draft", "out_for_bid", "out_for_signature"].includes(contract.status)) {
        throw conflict(`A ${contract.status} prime contract cannot be approved`);
      }
      if (contract.createdBy === req.user!.id) {
        throw segregation(
          "The approver of a prime contract may not be the person who raised it (segregation " +
            "of duties, ADR 0004).",
        );
      }
      const lines = await loadSov(contract.id);
      if (lines.length > 0) {
        assertSovBalanced(lines.map(billable), {
          originalContractSum: contract.originalContractSum,
          approvedChangeSum: contract.approvedChangeSum,
          currency: contract.currency,
        });
      }
      const now = nowIso();
      await app.db
        .update(primeContracts)
        .set({ status: "approved", approvedBy: req.user!.id, approvedAt: now, updatedAt: now })
        .where(eq(primeContracts.id, contract.id));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "prime_contract",
        objectId: contract.id,
        payload: {
          from: contract.status,
          to: "approved",
          revisedContractSum: contract.revisedContractSum,
        },
        storePayload: true,
      });
      return contractView(await fetchContract(contract.id, req.companyId!));
    },
  );

  /**
   * Execution — both parties have signed. Three gates: the contract must be
   * approved, the schedule of values must reconcile to the sum being signed,
   * and the execution date may not precede the award.
   */
  app.post(
    "/prime-contracts/:primeContractId/execute",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId } = req.params as { primeContractId: string };
      const body = executeSchema.parse(req.body);
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "admin");
      if (contract.executed === 1) {
        throw conflict(
          `Prime contract ${contract.reference} was already executed on ` +
            `${contract.executionDate ?? "an unrecorded date"}`,
        );
      }
      if (contract.status !== "approved") {
        throw conflict(
          `Prime contract ${contract.reference} is ${contract.status} — approve it before ` +
            "recording execution.",
        );
      }
      const problem = executionDateProblem({
        executionDate: body.executionDate,
        contractDate: contract.contractDate,
        approvedAt: contract.approvedAt,
      });
      if (problem) throw badRequest(problem);

      const lines = await loadSov(contract.id);
      if (lines.length === 0) {
        throw conflict(
          `Prime contract ${contract.reference} has no schedule of values — there is nothing ` +
            "to bill against and nothing to prove the contract sum is allocated.",
        );
      }
      assertSovBalanced(lines.map(billable), {
        originalContractSum: contract.originalContractSum,
        approvedChangeSum: contract.approvedChangeSum,
        currency: contract.currency,
      });

      const now = nowIso();
      await app.db
        .update(primeContracts)
        .set({
          executed: 1,
          executedBy: req.user!.id,
          executionDate: body.executionDate,
          signedContractReceivedDate:
            body.signedContractReceivedDate ?? contract.signedContractReceivedDate,
          updatedAt: now,
        })
        .where(eq(primeContracts.id, contract.id));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "prime_contract",
        objectId: contract.id,
        payload: {
          executed: 1,
          executionDate: body.executionDate,
          contractSum: contract.revisedContractSum,
          currency: contract.currency,
          sovLines: lines.length,
        },
        storePayload: true,
      });
      return contractView(await fetchContract(contract.id, req.companyId!));
    },
  );

  app.post(
    "/prime-contracts/:primeContractId/status",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId } = req.params as { primeContractId: string };
      const body = statusSchema.parse(req.body);
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "admin");
      if (body.status === "approved") {
        throw badRequest(
          "Approval carries a segregation-of-duties check — use POST /prime-contracts/:id/approve.",
        );
      }
      const allowed = STATUS_TRANSITIONS[contract.status as PrimeContractStatus] ?? [];
      if (!allowed.includes(body.status)) {
        throw conflict(
          `A ${contract.status} prime contract cannot become ${body.status}` +
            (allowed.length > 0 ? ` — allowed: ${allowed.join(", ")}` : " — it is terminal"),
        );
      }
      if (body.status === "complete") {
        const open = await app.db
          .select({ n: count() })
          .from(paymentApplications)
          .where(
            and(
              eq(paymentApplications.primeContractId, contract.id),
              inArray(paymentApplications.status, [...OPEN_APP_STATUSES]),
            ),
          );
        if (Number(open[0]?.n ?? 0) > 0) {
          throw conflict(
            "This prime contract still has an open payment application — certify, reject or " +
              "void it before closing the contract.",
          );
        }
      }
      if (body.status === "void") {
        // An executed contract with money moved under it is a signed
        // instrument with a billing history; it is terminated, not voided.
        if (!body.reason || body.reason.trim() === "") {
          throw badRequest("Voiding a prime contract requires a reason.");
        }
        if (contract.executed === 1) {
          const [apps, executedChanges] = await Promise.all([
            app.db
              .select({ n: count() })
              .from(paymentApplications)
              .where(
                and(
                  eq(paymentApplications.primeContractId, contract.id),
                  ne(paymentApplications.status, "void"),
                ),
              ),
            app.db
              .select({ n: count() })
              .from(primeContractChanges)
              .where(
                and(
                  eq(primeContractChanges.primeContractId, contract.id),
                  eq(primeContractChanges.status, "executed"),
                ),
              ),
          ]);
          const appCount = Number(apps[0]?.n ?? 0);
          const changeCount = Number(executedChanges[0]?.n ?? 0);
          if (appCount > 0 || changeCount > 0) {
            throw conflict(
              `Prime contract ${contract.reference} is executed and carries ${appCount} live ` +
                `application(s) and ${changeCount} executed change order(s). A signed instrument ` +
                "with a billing history is terminated, never voided.",
            );
          }
        }
      }
      const now = nowIso();
      await app.db
        .update(primeContracts)
        .set({
          status: body.status,
          ...(body.actualCompletionDate !== undefined
            ? { actualCompletionDate: body.actualCompletionDate }
            : {}),
          ...(body.terminationDate !== undefined
            ? { terminationDate: body.terminationDate }
            : body.status === "terminated"
              ? { terminationDate: today() }
              : {}),
          updatedAt: now,
        })
        .where(eq(primeContracts.id, contract.id));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "prime_contract",
        objectId: contract.id,
        payload: { from: contract.status, to: body.status, reason: body.reason ?? null },
        storePayload: true,
      });
      return contractView(await fetchContract(contract.id, req.companyId!));
    },
  );

  app.delete(
    "/prime-contracts/:primeContractId",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId } = req.params as { primeContractId: string };
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "admin");
      if (contract.executed === 1) {
        throw conflict(
          "An executed prime contract is a signed instrument — void or terminate it, never " +
            "delete it.",
        );
      }
      const billed = await app.db
        .select({ n: count() })
        .from(invoices)
        .where(eq(invoices.primeContractId, contract.id));
      if (Number(billed[0]?.n ?? 0) > 0) {
        throw conflict("This prime contract has billing history and cannot be deleted");
      }
      await app.db.transaction(async (tx) => {
        await tx
          .delete(primeContractSovLines)
          .where(eq(primeContractSovLines.primeContractId, contract.id));
        await tx
          .delete(primeContractChanges)
          .where(eq(primeContractChanges.primeContractId, contract.id));
        await tx.delete(primeContracts).where(eq(primeContracts.id, contract.id));
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: req.user!.id,
        action: "delete",
        objectType: "prime_contract",
        objectId: contract.id,
        payload: { reference: contract.reference },
      });
      return { deleted: true, id: contract.id };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Schedule of values                                                */
  /* ---------------------------------------------------------------- */

  app.get(
    "/prime-contracts/:primeContractId/sov",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId } = req.params as { primeContractId: string };
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "read");
      const lines = await loadSov(contract.id);
      const identity = checkSovAgainstContract(lines.map(billable), {
        originalContractSum: contract.originalContractSum,
        approvedChangeSum: contract.approvedChangeSum,
        currency: contract.currency,
      });
      return {
        primeContractId: contract.id,
        reference: contract.reference,
        currency: contract.currency,
        retainageTerms: retainageTermsOf(contract),
        totals: sovTotals(lines.map(billable)),
        identity,
        lines: lines.map((l) => ({
          ...l,
          revisedScheduledValue: revisedScheduledValueOf(l),
          percentComplete: percentCompleteOf(
            l.totalCompletedAndStored,
            revisedScheduledValueOf(l),
            `Line ${l.lineNumber}`,
          ),
        })),
      };
    },
  );

  async function assertBudgetLines(
    ids: readonly (string | null | undefined)[],
    projectId: string,
  ): Promise<void> {
    const wanted = [...new Set(ids.filter((v): v is string => typeof v === "string" && v !== ""))];
    if (wanted.length === 0) return;
    const rows = await app.db
      .select({ id: budgetLineItems.id })
      .from(budgetLineItems)
      .where(and(inArray(budgetLineItems.id, wanted), eq(budgetLineItems.projectId, projectId)));
    const found = new Set(rows.map((r) => r.id));
    for (const id of wanted) {
      if (!found.has(id)) {
        throw badRequest(`budgetLineItemId ${id} is not a budget line on this project`);
      }
    }
  }

  /**
   * Replace the base-scope schedule of values in one atomic write. This is
   * how an SOV is built: the whole sheet at once, because the identity it
   * has to satisfy is a property of the sheet and not of any one line.
   *
   * Change-order lines are never touched — they are the appended record of
   * executed change orders and belong to the change order, not to the sheet.
   */
  app.put(
    "/prime-contracts/:primeContractId/sov",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId } = req.params as { primeContractId: string };
      const body = sovPutSchema.parse(req.body);
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "standard");
      if (contract.executed === 1) {
        throw conflict(
          `Prime contract ${contract.reference} is executed — its schedule of values is part of ` +
            "the signed instrument. Append scope with an executed change order instead.",
        );
      }
      const existing = await loadSov(contract.id);
      const billedLine = existing.find(
        (l) => !nearlyEqual(l.totalCompletedAndStored, 0) || !nearlyEqual(l.previousBilled, 0),
      );
      if (billedLine) {
        throw conflict(
          `Line ${billedLine.lineNumber} has already been billed ` +
            `(${formatMoney(billedLine.totalCompletedAndStored)} ${contract.currency} to date) — ` +
            "a billed schedule of values cannot be replaced wholesale.",
        );
      }
      const seen = new Set<string>();
      for (const line of body.lines) {
        if (seen.has(line.lineNumber)) {
          throw badRequest(`Duplicate SOV line number "${line.lineNumber}"`);
        }
        seen.add(line.lineNumber);
      }
      const coLines = existing.filter((l) => l.isChangeOrderLine === 1);
      for (const line of body.lines) {
        if (coLines.some((c) => c.lineNumber === line.lineNumber)) {
          throw badRequest(
            `Line number "${line.lineNumber}" is already held by a change-order line — pick ` +
              "another.",
          );
        }
      }
      await assertBudgetLines(
        body.lines.map((l) => l.budgetLineItemId),
        contract.projectId,
      );

      const baseTotal = round2(body.lines.reduce((s, l) => s + l.scheduledValue, 0));
      const originalContractSum =
        body.syncContractSum === true ? baseTotal : contract.originalContractSum;

      // the identity, checked on the proposed sheet before anything is written
      const proposed: BillableLine[] = [
        ...body.lines.map((l, i) => ({
          id: `proposed-${i}`,
          lineNumber: l.lineNumber,
          description: l.description,
          sortOrder: l.sortOrder ?? i,
          billingMethod: l.billingMethod ?? "percent_complete",
          costCode: l.costCode ?? null,
          costType: l.costType ?? null,
          costCodeId: l.costCodeId ?? null,
          budgetLineItemId: l.budgetLineItemId ?? null,
          unit: l.unit ?? null,
          quantity: l.quantity ?? null,
          unitRate: l.unitRate ?? null,
          scheduledValue: round2(l.scheduledValue),
          changeOrderValue: 0,
          previousBilled: 0,
          previousStoredMaterials: 0,
          materialsPresentlyStored: 0,
          thisPeriodWork: 0,
          thisPeriodStoredMaterials: 0,
          retainagePercent: l.retainagePercent ?? contract.defaultRetainagePercent,
          retainageHeld: 0,
          retainageReleased: 0,
          isChangeOrderLine: 0,
          changeOrderPackageId: null,
        })),
        ...coLines.map(billable),
      ];
      assertSovBalanced(proposed, {
        originalContractSum,
        approvedChangeSum: contract.approvedChangeSum,
        currency: contract.currency,
      });

      const now = nowIso();
      await app.db.transaction(async (tx) => {
        await tx
          .delete(primeContractSovLines)
          .where(
            and(
              eq(primeContractSovLines.primeContractId, contract.id),
              eq(primeContractSovLines.isChangeOrderLine, 0),
            ),
          );
        for (const [i, line] of body.lines.entries()) {
          const scheduledValue = round2(line.scheduledValue);
          await tx.insert(primeContractSovLines).values({
            id: newId("sov"),
            companyId: contract.companyId,
            projectId: contract.projectId,
            primeContractId: contract.id,
            lineNumber: line.lineNumber,
            sortOrder: line.sortOrder ?? i,
            costCodeId: line.costCodeId ?? null,
            costCode: line.costCode ?? null,
            costType: line.costType ?? null,
            budgetLineItemId: line.budgetLineItemId ?? null,
            description: line.description,
            billingMethod: line.billingMethod ?? "percent_complete",
            unit: line.unit ?? null,
            quantity: line.quantity ?? null,
            unitRate: line.unitRate ?? null,
            scheduledValue,
            changeOrderValue: 0,
            revisedScheduledValue: scheduledValue,
            balanceToFinish: scheduledValue,
            retainagePercent: line.retainagePercent ?? contract.defaultRetainagePercent,
            notes: line.notes ?? null,
            updatedAt: now,
          });
        }
        if (body.syncContractSum === true) {
          await tx
            .update(primeContracts)
            .set({ originalContractSum: baseTotal, updatedAt: now })
            .where(eq(primeContracts.id, contract.id));
        }
      });
      const recalculated = await recalcContract(contract.id, req.companyId!);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: req.user!.id,
        action: "update",
        objectType: "prime_contract_sov",
        objectId: contract.id,
        payload: {
          lineCount: body.lines.length,
          sovTotal: baseTotal,
          contractSum: recalculated.revisedContractSum,
          syncContractSum: body.syncContractSum === true,
        },
        storePayload: true,
      });
      const lines = await loadSov(contract.id);
      return {
        primeContractId: contract.id,
        totals: sovTotals(lines.map(billable)),
        identity: checkSovAgainstContract(lines.map(billable), {
          originalContractSum: recalculated.originalContractSum,
          approvedChangeSum: recalculated.approvedChangeSum,
          currency: recalculated.currency,
        }),
        lines,
      };
    },
  );

  /**
   * Add one line. It succeeds only when the schedule is currently
   * under-allocated by exactly this line's value — i.e. you are allocating
   * contract sum that has not been allocated yet. Anything else would put
   * the sheet out of balance, and the refusal says by how much.
   */
  app.post(
    "/prime-contracts/:primeContractId/sov/lines",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId } = req.params as { primeContractId: string };
      const body = sovLineCreateSchema.parse(req.body);
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "standard");
      if (contract.executed === 1) {
        throw conflict(
          `Prime contract ${contract.reference} is executed — scope is added by executing a ` +
            "change order, which appends its own SOV line.",
        );
      }
      const existing = await loadSov(contract.id);
      if (existing.some((l) => l.lineNumber === body.lineNumber)) {
        throw conflict(`SOV line "${body.lineNumber}" already exists on this contract`);
      }
      await assertBudgetLines([body.budgetLineItemId], contract.projectId);
      const scheduledValue = round2(body.scheduledValue);
      const proposed: BillableLine[] = [
        ...existing.map(billable),
        {
          id: "proposed",
          lineNumber: body.lineNumber,
          description: body.description,
          sortOrder: body.sortOrder ?? existing.length,
          billingMethod: body.billingMethod ?? "percent_complete",
          costCode: body.costCode ?? null,
          costType: body.costType ?? null,
          costCodeId: body.costCodeId ?? null,
          budgetLineItemId: body.budgetLineItemId ?? null,
          unit: body.unit ?? null,
          quantity: body.quantity ?? null,
          unitRate: body.unitRate ?? null,
          scheduledValue,
          changeOrderValue: 0,
          previousBilled: 0,
          previousStoredMaterials: 0,
          materialsPresentlyStored: 0,
          thisPeriodWork: 0,
          thisPeriodStoredMaterials: 0,
          retainagePercent: body.retainagePercent ?? contract.defaultRetainagePercent,
          retainageHeld: 0,
          retainageReleased: 0,
          isChangeOrderLine: 0,
          changeOrderPackageId: null,
        },
      ];
      const originalContractSum =
        body.raiseContractSum === true
          ? round2(contract.originalContractSum + scheduledValue)
          : contract.originalContractSum;
      assertSovBalanced(proposed, {
        originalContractSum,
        approvedChangeSum: contract.approvedChangeSum,
        currency: contract.currency,
      });
      const id = newId("sov");
      // The line and the contract sum move together, or not at all: a
      // failure between the two would leave the sheet out of balance, which
      // every later write then refuses.
      await app.db.transaction(async (tx) => {
        await tx.insert(primeContractSovLines).values({
          id,
          companyId: contract.companyId,
          projectId: contract.projectId,
          primeContractId: contract.id,
          lineNumber: body.lineNumber,
          sortOrder: body.sortOrder ?? existing.length,
          costCodeId: body.costCodeId ?? null,
          costCode: body.costCode ?? null,
          costType: body.costType ?? null,
          budgetLineItemId: body.budgetLineItemId ?? null,
          description: body.description,
          billingMethod: body.billingMethod ?? "percent_complete",
          unit: body.unit ?? null,
          quantity: body.quantity ?? null,
          unitRate: body.unitRate ?? null,
          scheduledValue,
          revisedScheduledValue: scheduledValue,
          balanceToFinish: scheduledValue,
          retainagePercent: body.retainagePercent ?? contract.defaultRetainagePercent,
          notes: body.notes ?? null,
        });
        if (body.raiseContractSum === true) {
          await tx
            .update(primeContracts)
            .set({ originalContractSum, updatedAt: nowIso() })
            .where(eq(primeContracts.id, contract.id));
        }
      });
      if (body.raiseContractSum === true) {
        await recalcContract(contract.id, req.companyId!);
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: req.user!.id,
        action: "create",
        objectType: "prime_contract_sov_line",
        objectId: id,
        payload: {
          primeContractId: contract.id,
          lineNumber: body.lineNumber,
          scheduledValue,
          raisedContractSumTo: body.raiseContractSum === true ? originalContractSum : null,
        },
      });
      const rows = await app.db
        .select()
        .from(primeContractSovLines)
        .where(eq(primeContractSovLines.id, id))
        .limit(1);
      return reply.status(201).send(rows[0]);
    },
  );

  /**
   * Edit one line. A change to `scheduledValue` must keep the sheet in
   * balance — either because the sheet was under-allocated by exactly that
   * much, or because `absorbIntoLineId` names the line the value comes from.
   * Scope has to come from somewhere.
   */
  app.patch(
    "/prime-contracts/:primeContractId/sov/lines/:lineId",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId, lineId } = req.params as {
        primeContractId: string;
        lineId: string;
      };
      const body = sovLinePatchSchema.parse(req.body);
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "standard");
      const existing = await loadSov(contract.id);
      const line = existing.find((l) => l.id === lineId);
      if (!line) throw notFound("SOV line not found on this prime contract");

      const changesValue = body.scheduledValue !== undefined;
      if (changesValue && contract.executed === 1) {
        throw conflict(
          `Line ${line.lineNumber} belongs to an executed contract — its value moves only ` +
            "through an executed change order.",
        );
      }
      if (changesValue && !nearlyEqual(line.totalCompletedAndStored, 0)) {
        throw conflict(
          `Line ${line.lineNumber} has ${formatMoney(line.totalCompletedAndStored)} ` +
            `${contract.currency} billed against it — its scheduled value cannot be retyped.`,
        );
      }
      if (body.lineNumber !== undefined && body.lineNumber !== line.lineNumber) {
        if (existing.some((l) => l.id !== lineId && l.lineNumber === body.lineNumber)) {
          throw conflict(`SOV line "${body.lineNumber}" already exists on this contract`);
        }
      }
      await assertBudgetLines([body.budgetLineItemId], contract.projectId);

      let absorb: SovRow | undefined;
      let absorbValue = 0;
      if (changesValue) {
        const delta = round2(round2(body.scheduledValue as number) - line.scheduledValue);
        if (body.absorbIntoLineId) {
          absorb = existing.find((l) => l.id === body.absorbIntoLineId);
          if (!absorb) throw badRequest("absorbIntoLineId is not a line on this contract");
          if (absorb.id === line.id) {
            throw badRequest("absorbIntoLineId must name a different line");
          }
          if (absorb.isChangeOrderLine === 1) {
            throw badRequest(
              `Line ${absorb.lineNumber} was appended by a change order — base scope cannot be ` +
                "moved into it.",
            );
          }
          absorbValue = round2(absorb.scheduledValue - delta);
          if (absorbValue < -0.005) {
            throw badRequest(
              `Line ${absorb.lineNumber} holds ${formatMoney(absorb.scheduledValue)} ` +
                `${contract.currency}, which is less than the ${formatMoney(delta)} being moved ` +
                "out of it.",
            );
          }
        }
      }

      const proposed = existing.map((l): BillableLine => {
        if (l.id === line.id && changesValue) {
          return { ...billable(l), scheduledValue: round2(body.scheduledValue as number) };
        }
        if (absorb && l.id === absorb.id) {
          return { ...billable(l), scheduledValue: absorbValue };
        }
        return billable(l);
      });
      assertSovBalanced(proposed, {
        originalContractSum: contract.originalContractSum,
        approvedChangeSum: contract.approvedChangeSum,
        currency: contract.currency,
      });

      const now = nowIso();
      const patch: Partial<typeof primeContractSovLines.$inferInsert> = { updatedAt: now };
      const assign = <K extends keyof typeof patch>(k: K, v: (typeof patch)[K]): void => {
        if (v !== undefined) patch[k] = v;
      };
      assign("lineNumber", body.lineNumber);
      assign("description", body.description);
      assign("sortOrder", body.sortOrder);
      assign("costCodeId", body.costCodeId);
      assign("costCode", body.costCode);
      assign("costType", body.costType);
      assign("budgetLineItemId", body.budgetLineItemId);
      assign("billingMethod", body.billingMethod);
      assign("unit", body.unit);
      assign("quantity", body.quantity);
      assign("unitRate", body.unitRate);
      assign("retainagePercent", body.retainagePercent);
      assign("notes", body.notes);
      if (changesValue) {
        const scheduledValue = round2(body.scheduledValue as number);
        patch.scheduledValue = scheduledValue;
        patch.revisedScheduledValue = round2(scheduledValue + line.changeOrderValue);
        patch.balanceToFinish = round2(
          scheduledValue + line.changeOrderValue - line.totalCompletedAndStored,
        );
      }
      await app.db.transaction(async (tx) => {
        await tx
          .update(primeContractSovLines)
          .set(patch)
          .where(eq(primeContractSovLines.id, line.id));
        if (absorb) {
          await tx
            .update(primeContractSovLines)
            .set({
              scheduledValue: absorbValue,
              revisedScheduledValue: round2(absorbValue + absorb.changeOrderValue),
              balanceToFinish: round2(
                absorbValue + absorb.changeOrderValue - absorb.totalCompletedAndStored,
              ),
              updatedAt: now,
            })
            .where(eq(primeContractSovLines.id, absorb.id));
        }
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: req.user!.id,
        action: "update",
        objectType: "prime_contract_sov_line",
        objectId: line.id,
        payload: {
          primeContractId: contract.id,
          changed: Object.keys(body),
          absorbedInto: absorb?.id ?? null,
        },
      });
      const rows = await app.db
        .select()
        .from(primeContractSovLines)
        .where(eq(primeContractSovLines.id, line.id))
        .limit(1);
      return rows[0];
    },
  );

  app.delete(
    "/prime-contracts/:primeContractId/sov/lines/:lineId",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId, lineId } = req.params as {
        primeContractId: string;
        lineId: string;
      };
      const body = sovLineDeleteSchema.parse(req.body ?? {});
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "standard");
      const existing = await loadSov(contract.id);
      const line = existing.find((l) => l.id === lineId);
      if (!line) throw notFound("SOV line not found on this prime contract");
      if (contract.executed === 1) {
        throw conflict(
          `Prime contract ${contract.reference} is executed — a signed schedule of values does ` +
            "not lose lines.",
        );
      }
      if (!nearlyEqual(line.totalCompletedAndStored, 0)) {
        throw conflict(
          `Line ${line.lineNumber} has ${formatMoney(line.totalCompletedAndStored)} ` +
            `${contract.currency} billed against it and cannot be deleted.`,
        );
      }
      let absorb: SovRow | undefined;
      let absorbValue = 0;
      if (body.absorbIntoLineId) {
        absorb = existing.find((l) => l.id === body.absorbIntoLineId);
        if (!absorb) throw badRequest("absorbIntoLineId is not a line on this contract");
        if (absorb.id === line.id) throw badRequest("absorbIntoLineId must name a different line");
        if (absorb.isChangeOrderLine === 1) {
          throw badRequest(
            `Line ${absorb.lineNumber} was appended by a change order — base scope cannot be ` +
              "moved into it.",
          );
        }
        absorbValue = round2(absorb.scheduledValue + line.scheduledValue);
      }
      const proposed = existing
        .filter((l) => l.id !== line.id)
        .map((l): BillableLine =>
          absorb && l.id === absorb.id ? { ...billable(l), scheduledValue: absorbValue } : billable(l),
        );
      assertSovBalanced(proposed, {
        originalContractSum: contract.originalContractSum,
        approvedChangeSum: contract.approvedChangeSum,
        currency: contract.currency,
      });
      const now = nowIso();
      await app.db.transaction(async (tx) => {
        await tx.delete(primeContractSovLines).where(eq(primeContractSovLines.id, line.id));
        if (absorb) {
          await tx
            .update(primeContractSovLines)
            .set({
              scheduledValue: absorbValue,
              revisedScheduledValue: round2(absorbValue + absorb.changeOrderValue),
              balanceToFinish: round2(
                absorbValue + absorb.changeOrderValue - absorb.totalCompletedAndStored,
              ),
              updatedAt: now,
            })
            .where(eq(primeContractSovLines.id, absorb.id));
        }
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: req.user!.id,
        action: "delete",
        objectType: "prime_contract_sov_line",
        objectId: line.id,
        payload: {
          primeContractId: contract.id,
          lineNumber: line.lineNumber,
          scheduledValue: line.scheduledValue,
          absorbedInto: absorb?.id ?? null,
        },
      });
      return { deleted: true, id: line.id, absorbedInto: absorb?.id ?? null };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Prime contract change orders                                      */
  /* ---------------------------------------------------------------- */

  /** Σ of a change's allocation lines, which must equal its amount. */
  const changeLinesTotal = (lines: ReadonlyArray<{ amount: number }>): number =>
    round2(lines.reduce((s, l) => s + l.amount, 0));

  app.post(
    "/prime-contracts/:primeContractId/changes",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId } = req.params as { primeContractId: string };
      const body = changeCreateSchema.parse(req.body);
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "standard");
      if (["void", "terminated"].includes(contract.status)) {
        throw conflict(`A ${contract.status} prime contract cannot take change orders`);
      }
      const lines = body.lines ?? [];
      const amount = body.amount ?? changeLinesTotal(lines);
      if (lines.length > 0 && !nearlyEqual(changeLinesTotal(lines), amount)) {
        throw badRequest(
          `Change order lines total ${formatMoney(changeLinesTotal(lines))} but the change is ` +
            `${formatMoney(amount)} — the allocation must account for the whole amount.`,
        );
      }
      if (body.changeOrderPackageId) {
        const pkg = await app.db
          .select({ id: changeOrderPackages.id })
          .from(changeOrderPackages)
          .where(
            and(
              eq(changeOrderPackages.id, body.changeOrderPackageId),
              eq(changeOrderPackages.projectId, contract.projectId),
            ),
          )
          .limit(1);
        if (!pkg[0]) {
          throw badRequest("changeOrderPackageId does not reference a package on this project");
        }
      }
      const sovIds = lines
        .map((l) => l.sovLineId)
        .filter((v): v is string => typeof v === "string" && v !== "");
      if (sovIds.length > 0) {
        const rows = await app.db
          .select({ id: primeContractSovLines.id })
          .from(primeContractSovLines)
          .where(
            and(
              inArray(primeContractSovLines.id, sovIds),
              eq(primeContractSovLines.primeContractId, contract.id),
            ),
          );
        const found = new Set(rows.map((r) => r.id));
        for (const id of sovIds) {
          if (!found.has(id)) {
            throw badRequest(`sovLineId ${id} is not a line on this prime contract`);
          }
        }
      }
      const number = await nextRecordNumber(app.db, contract.projectId, "prime_contract_change");
      const id = newId("pcc");
      await app.db.insert(primeContractChanges).values({
        id,
        companyId: contract.companyId,
        projectId: contract.projectId,
        primeContractId: contract.id,
        number,
        reference: `PCCO-${pad3(number)}`,
        changeOrderPackageId: body.changeOrderPackageId ?? null,
        title: body.title,
        description: body.description ?? null,
        reason: body.reason ?? null,
        status: "draft",
        amount: round2(amount),
        scheduleImpactDays: body.scheduleImpactDays ?? 0,
        lines,
        revisedContractSum: round2(contract.revisedContractSum + amount),
        requestedDate: body.requestedDate ?? today(),
        dueDate: body.dueDate ?? null,
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      });
      await recalcContract(contract.id, req.companyId!);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: req.user!.id,
        action: "create",
        objectType: "prime_contract_change",
        objectId: id,
        payload: { primeContractId: contract.id, number, amount: round2(amount) },
        storePayload: true,
      });
      const rows = await app.db
        .select()
        .from(primeContractChanges)
        .where(eq(primeContractChanges.id, id))
        .limit(1);
      return reply.status(201).send(rows[0]);
    },
  );

  app.get(
    "/prime-contracts/:primeContractId/changes",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId } = req.params as { primeContractId: string };
      const q = changeListQuery.parse(req.query);
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "read");
      const clauses = [eq(primeContractChanges.primeContractId, contract.id)];
      if (q.status) clauses.push(eq(primeContractChanges.status, q.status));
      const where = and(...clauses);
      const [totalRow] = await app.db.select({ n: count() }).from(primeContractChanges).where(where);
      const items = await app.db
        .select()
        .from(primeContractChanges)
        .where(where)
        .orderBy(asc(primeContractChanges.number))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(items, Number(totalRow?.n ?? 0), q);
    },
  );

  app.patch(
    "/prime-contracts/:primeContractId/changes/:changeId",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId, changeId } = req.params as {
        primeContractId: string;
        changeId: string;
      };
      const body = changePatchSchema.parse(req.body);
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "standard");
      const change = await fetchChange(contract, changeId);
      // Only a change order nobody has yet signed off may be edited. An
      // approved number is the number that was approved; changing it and
      // executing on the old approval would defeat the second pair of eyes.
      if (!["draft", "revise_and_resubmit"].includes(change.status)) {
        throw conflict(
          `${change.reference} is ${change.status} — ` +
            (change.status === "executed"
              ? "an executed change order is part of the contract sum and cannot be edited."
              : "a change order under review or already approved cannot be edited. Reject it " +
                "back to revise_and_resubmit (or void it) and raise the corrected figure."),
        );
      }
      const lines = (body.lines ?? (change.lines as Array<{ amount: number }>)) as Array<{
        amount: number;
      }>;
      const amount = body.amount ?? (body.lines ? changeLinesTotal(lines) : change.amount);
      if (lines.length > 0 && !nearlyEqual(changeLinesTotal(lines), amount)) {
        throw badRequest(
          `Change order lines total ${formatMoney(changeLinesTotal(lines))} but the change is ` +
            `${formatMoney(amount)} — the allocation must account for the whole amount.`,
        );
      }
      const now = nowIso();
      await app.db
        .update(primeContractChanges)
        .set({
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
          ...(body.changeOrderPackageId !== undefined
            ? { changeOrderPackageId: body.changeOrderPackageId }
            : {}),
          ...(body.scheduleImpactDays !== undefined
            ? { scheduleImpactDays: body.scheduleImpactDays }
            : {}),
          ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
          ...(body.requestedDate !== undefined ? { requestedDate: body.requestedDate } : {}),
          ...(body.lines !== undefined ? { lines: body.lines } : {}),
          ...(body.detail !== undefined ? { detail: body.detail } : {}),
          amount: round2(amount),
          revisedContractSum: round2(contract.revisedContractSum + amount),
          updatedAt: now,
        })
        .where(eq(primeContractChanges.id, change.id));
      await recalcContract(contract.id, req.companyId!);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: req.user!.id,
        action: "update",
        objectType: "prime_contract_change",
        objectId: change.id,
        payload: { changed: Object.keys(body), amount: round2(amount) },
      });
      return fetchChange(contract, change.id);
    },
  );

  app.post(
    "/prime-contracts/:primeContractId/changes/:changeId/submit",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId, changeId } = req.params as {
        primeContractId: string;
        changeId: string;
      };
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "standard");
      const change = await fetchChange(contract, changeId);
      if (!["draft", "revise_and_resubmit"].includes(change.status)) {
        throw conflict(`${change.reference} is ${change.status} and cannot be submitted`);
      }
      const now = nowIso();
      await app.db
        .update(primeContractChanges)
        .set({
          status: "pending_owner_approval",
          submittedBy: req.user!.id,
          submittedAt: now,
          updatedAt: now,
        })
        .where(eq(primeContractChanges.id, change.id));
      await recalcContract(contract.id, req.companyId!);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "prime_contract_change",
        objectId: change.id,
        payload: { from: change.status, to: "pending_owner_approval", amount: change.amount },
      });
      return fetchChange(contract, change.id);
    },
  );

  app.post(
    "/prime-contracts/:primeContractId/changes/:changeId/approve",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId, changeId } = req.params as {
        primeContractId: string;
        changeId: string;
      };
      const body = changeApproveSchema.parse(req.body ?? {});
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "admin");
      const change = await fetchChange(contract, changeId);
      if (!["pending_owner_approval", "pending_in_house_review", "pending_pricing"].includes(
        change.status,
      )) {
        throw conflict(`${change.reference} is ${change.status} and is not awaiting approval`);
      }
      const actor = req.user!.id;
      if (actor === change.createdBy || actor === change.submittedBy) {
        throw segregation(
          "The approver of a change order may be neither the person who raised it nor the " +
            "person who submitted it (segregation of duties, ADR 0004).",
        );
      }
      if (body.ownerApproval?.contactId) {
        await assertOwnerContact(body.ownerApproval.contactId, req.companyId!);
      }
      const now = nowIso();
      const ownerApproval = body.ownerApproval
        ? {
            contactId: body.ownerApproval.contactId ?? contract.ownerContactId ?? null,
            name: body.ownerApproval.name,
            signedAt: body.ownerApproval.signedAt ?? today(),
            documentHash: body.ownerApproval.documentHash ?? null,
            notes: body.ownerApproval.notes ?? null,
            recordedBy: actor,
            recordedAt: now,
          }
        : null;
      await app.db
        .update(primeContractChanges)
        .set({
          status: "approved",
          approvedBy: actor,
          approvedAt: now,
          updatedAt: now,
          ...(ownerApproval
            ? { detail: { ...((change.detail as Record<string, unknown> | null) ?? {}), ownerApproval } }
            : {}),
        })
        .where(eq(primeContractChanges.id, change.id));
      await recalcContract(contract.id, req.companyId!);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: actor,
        action: "state_change",
        objectType: "prime_contract_change",
        objectId: change.id,
        payload: { from: change.status, to: "approved", amount: change.amount, ownerApproval },
        storePayload: true,
      });
      return fetchChange(contract, change.id);
    },
  );

  app.post(
    "/prime-contracts/:primeContractId/changes/:changeId/reject",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId, changeId } = req.params as {
        primeContractId: string;
        changeId: string;
      };
      const body = rejectSchema.parse(req.body);
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "admin");
      const change = await fetchChange(contract, changeId);
      if (change.status === "executed") {
        throw conflict(`${change.reference} is executed and cannot be rejected`);
      }
      const actor = req.user!.id;
      if (actor === change.createdBy || actor === change.submittedBy) {
        throw segregation(
          "The reviewer of a change order may be neither its author nor its submitter " +
            "(segregation of duties, ADR 0004).",
        );
      }
      const now = nowIso();
      await app.db
        .update(primeContractChanges)
        .set({
          status: "rejected",
          rejectedBy: actor,
          rejectedAt: now,
          rejectionReason: body.reason,
          updatedAt: now,
        })
        .where(eq(primeContractChanges.id, change.id));
      await recalcContract(contract.id, req.companyId!);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: actor,
        action: "state_change",
        objectType: "prime_contract_change",
        objectId: change.id,
        payload: { from: change.status, to: "rejected", reason: body.reason },
      });
      return fetchChange(contract, change.id);
    },
  );

  interface OwnerChangePlan {
    budgetId: string;
    budgetStatus: string;
    legs: Array<{ lineItemId: string; costCode: string; costType: string; amount: number }>;
    rows: Map<string, typeof budgetLineItems.$inferSelect>;
  }

  /** Why the last plan produced nothing — set by planOwnerChange, read by the ledger. */
  let planReasons: string[] = [];

  /**
   * Resolve a change order's allocation onto the lines of the ACTIVE budget,
   * or refuse. A leg resolves by the budget line its source SOV line is
   * bound to, else by cost code × cost type on the budget. Nothing is
   * invented: with an active budget every leg must land, and the refusal
   * names the ones that do not. Without an active budget the contract side
   * executes alone and the reasons are recorded on the change.
   */
  async function planOwnerChange(
    contract: ContractRow,
    change: ChangeRow,
    legs: ReadonlyArray<{ sovLineId?: string | null; costCode?: string | null; costType?: string | null; description?: string; amount: number }>,
    appended: ReadonlyArray<typeof primeContractSovLines.$inferInsert>,
  ): Promise<OwnerChangePlan | null> {
    planReasons = [];
    const active = await app.db
      .select()
      .from(budgets)
      .where(and(eq(budgets.companyId, contract.companyId), eq(budgets.projectId, contract.projectId), eq(budgets.isActive, 1)))
      .limit(1);
    const budget = active[0];
    if (!budget) {
      planReasons = ["This project has no active budget, so there is no budget column for this change to fund. The contract side executed on its own."];
      return null;
    }
    if (budget.currency.toUpperCase() !== contract.currency.toUpperCase()) {
      throw conflict(
        `Budget ${budget.reference} is kept in ${budget.currency} and this change is in ` +
          `${contract.currency}. Money is never converted silently — align the budget currency first.`,
      );
    }
    if (budget.status === "closed") {
      throw conflict(`Budget ${budget.reference} is closed and cannot take an owner change.`);
    }
    const rows = await app.db.select().from(budgetLineItems).where(eq(budgetLineItems.budgetId, budget.id));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const byCode = new Map(rows.map((r) => [`${r.costCode}::${r.costType}`, r]));
    const merged = new Map<string, OwnerChangePlan["legs"][number]>();
    const unresolved: string[] = [];
    legs.forEach((leg, i) => {
      const source = appended[i];
      let row = source?.budgetLineItemId ? byId.get(source.budgetLineItemId) : undefined;
      if (!row && leg.costCode) row = byCode.get(`${leg.costCode}::${leg.costType ?? "other"}`);
      if (!row) {
        unresolved.push(`"${leg.description ?? change.title}" (${leg.costCode ?? "no cost code"} / ${leg.costType ?? "no cost type"}, ${formatMoney(leg.amount)})`);
        return;
      }
      if (row.status === "void") {
        throw conflict(`Budget line ${row.costCode} / ${row.costType} is void and cannot take an owner-funded increase.`);
      }
      const existing = merged.get(row.id);
      if (existing) existing.amount = round2(existing.amount + leg.amount);
      else merged.set(row.id, { lineItemId: row.id, costCode: row.costCode, costType: row.costType, amount: round2(leg.amount) });
    });
    if (unresolved.length > 0) {
      throw badRequest(
        `These change order lines do not resolve to a line of budget ${budget.reference}: ` +
          `${unresolved.join("; ")}. Point each line at a schedule-of-values line bound to a ` +
          "budget line, or give it a cost code and cost type the budget carries — an owner-funded " +
          "increase has to land somewhere a cost report can find it.",
        { unresolved },
      );
    }
    for (const leg of merged.values()) {
      const row = byId.get(leg.lineItemId)!;
      const next = round2(row.originalBudget + row.budgetModifications + row.approvedChanges + leg.amount);
      if (next < 0) {
        throw conflict(
          `Executing this change would take budget line ${row.costCode} / ${row.costType} to ` +
            `${formatMoney(next)}. A budget line cannot hold a negative revised budget.`,
        );
      }
    }
    return { budgetId: budget.id, budgetStatus: budget.status, legs: [...merged.values()], rows: byId };
  }

  /** Re-derive the budget's materialized rollups after an owner change lands. */
  async function recomputeBudgetTotals(budgetId: string): Promise<void> {
    const rows = await app.db.select().from(budgetLineItems).where(eq(budgetLineItems.budgetId, budgetId));
    const totals = rollUpBudgetTotals(
      rows.map((l) => ({
        originalBudget: l.originalBudget,
        budgetModifications: l.budgetModifications,
        approvedChanges: l.approvedChanges,
        pendingBudgetChanges: l.pendingBudgetChanges,
        committedCost: l.committedCost,
        pendingCommitments: l.pendingCommitments,
        directCosts: l.directCosts,
        jobToDateCosts: l.jobToDateCosts,
        percentComplete: l.percentComplete,
        quantity: l.quantity,
        unitRate: l.unitRate,
        revisedBudget: l.revisedBudget,
        forecastToComplete: l.forecastToComplete,
        forecastFinal: l.forecastFinal,
        projectedOverUnder: l.projectedOverUnder,
      })),
    );
    await app.db
      .update(budgets)
      .set({ ...totals, totalsCalculatedAt: nowIso(), updatedAt: nowIso() })
      .where(eq(budgets.id, budgetId));
  }

  /**
   * Execution — the moment a change order becomes money. It APPENDS SOV
   * lines rather than editing the originals, so the continuation sheet keeps
   * reconciling to the signed contract, and it raises the contract sum by
   * exactly what it appends. The two happen in one transaction because a
   * contract sum that moved without its schedule of values is precisely the
   * failure this module exists to prevent — and the owner-funded budget
   * increase lands in the same transaction, for the same reason.
   */
  app.post(
    "/prime-contracts/:primeContractId/changes/:changeId/execute",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId, changeId } = req.params as {
        primeContractId: string;
        changeId: string;
      };
      const body = z
        .object({
          executedDate: isoDate.optional(),
          signedChangeOrderReceivedDate: isoDate.nullable().optional(),
        })
        .parse(req.body ?? {});
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "admin");
      const change = await fetchChange(contract, changeId);
      if (change.status === "executed") {
        throw conflict(`${change.reference} was already executed on ${change.executedDate}`);
      }
      if (change.status !== "approved") {
        throw conflict(
          `${change.reference} is ${change.status} — a change order is executed only after it ` +
            "is approved.",
        );
      }
      if (contract.executed !== 1) {
        throw conflict(
          `Prime contract ${contract.reference} is not executed — there is no contract sum for ` +
            "a change order to modify yet.",
        );
      }
      const executedDate = body.executedDate ?? today();
      const problem = executionDateProblem({
        executionDate: executedDate,
        contractDate: contract.executionDate ?? contract.contractDate,
        approvedAt: change.approvedAt,
      });
      if (problem) {
        throw badRequest(
          problem.replace("a contract cannot", "a change order cannot").replace(
            "the contract date",
            "the prime contract's execution date",
          ),
        );
      }

      const allocation = (change.lines as Array<{
        sovLineId?: string | null;
        costCode?: string | null;
        costType?: string | null;
        description?: string;
        amount: number;
      }>) ?? [];
      const existing = await loadSov(contract.id);
      const appended: Array<typeof primeContractSovLines.$inferInsert> = [];
      const legs =
        allocation.length > 0
          ? allocation
          : [{ description: change.title, amount: change.amount, costCode: null, costType: null }];
      if (!nearlyEqual(changeLinesTotal(legs), change.amount)) {
        throw conflict(
          `${change.reference} allocates ${formatMoney(changeLinesTotal(legs))} across its lines ` +
            `but is worth ${formatMoney(change.amount)} — the schedule of values would not ` +
            "reconcile to the new contract sum.",
        );
      }
      let seq = 0;
      for (const leg of legs) {
        seq += 1;
        const source = leg.sovLineId
          ? existing.find((l) => l.id === leg.sovLineId)
          : undefined;
        const value = round2(leg.amount);
        appended.push({
          id: newId("sov"),
          companyId: contract.companyId,
          projectId: contract.projectId,
          primeContractId: contract.id,
          lineNumber: changeOrderLineNumber(change.number, seq),
          sortOrder: 10000 + change.number * 10 + seq,
          costCodeId: source?.costCodeId ?? null,
          costCode: leg.costCode ?? source?.costCode ?? null,
          costType: leg.costType ?? source?.costType ?? null,
          budgetLineItemId: source?.budgetLineItemId ?? null,
          description: `${change.reference} — ${leg.description ?? change.title}`,
          billingMethod: source?.billingMethod ?? "percent_complete",
          scheduledValue: value,
          revisedScheduledValue: value,
          balanceToFinish: value,
          retainagePercent: source?.retainagePercent ?? contract.defaultRetainagePercent,
          isChangeOrderLine: 1,
          changeOrderPackageId: change.changeOrderPackageId ?? null,
        });
      }

      // The package this change came from (when the chain started in change
      // management) must not have executed its own PCCO already — that would
      // be the same instrument entering the contract sum twice.
      if (change.changeOrderPackageId) {
        const pkg = await app.db
          .select({ id: changeOrderPackages.id, reference: changeOrderPackages.reference, primeContractChangeId: changeOrderPackages.primeContractChangeId, status: changeOrderPackages.status })
          .from(changeOrderPackages)
          .where(eq(changeOrderPackages.id, change.changeOrderPackageId))
          .limit(1);
        if (pkg[0]?.primeContractChangeId && pkg[0].primeContractChangeId !== change.id) {
          throw conflict(
            `${pkg[0].reference} was already executed through change management as ` +
              `${pkg[0].primeContractChangeId}; executing ${change.reference} would carry the ` +
              "same instrument into the contract sum twice.",
          );
        }
      }

      const newApprovedChangeSum = round2(contract.approvedChangeSum + change.amount);
      const proposed: BillableLine[] = [
        ...existing.map(billable),
        ...appended.map(
          (a): BillableLine => ({
            id: a.id,
            lineNumber: a.lineNumber,
            description: a.description,
            sortOrder: a.sortOrder ?? 0,
            billingMethod: a.billingMethod ?? "percent_complete",
            costCode: a.costCode ?? null,
            costType: a.costType ?? null,
            costCodeId: a.costCodeId ?? null,
            budgetLineItemId: a.budgetLineItemId ?? null,
            unit: a.unit ?? null,
            quantity: a.quantity ?? null,
            unitRate: a.unitRate ?? null,
            scheduledValue: a.scheduledValue ?? 0,
            changeOrderValue: 0,
            previousBilled: 0,
            previousStoredMaterials: 0,
            materialsPresentlyStored: 0,
            thisPeriodWork: 0,
            thisPeriodStoredMaterials: 0,
            retainagePercent: a.retainagePercent ?? 0,
            retainageHeld: 0,
            retainageReleased: 0,
            isChangeOrderLine: 1,
            changeOrderPackageId: a.changeOrderPackageId ?? null,
          }),
        ),
      ];
      assertSovBalanced(proposed, {
        originalContractSum: contract.originalContractSum,
        approvedChangeSum: newApprovedChangeSum,
        currency: contract.currency,
      });

      // The budget side. Revenue and budget rise together or the chain the
      // schema promises (PCCO -> owner_change -> approvedChanges) is broken
      // for every UI-raised change order. Planned before the transaction so
      // a refusal names the uncoded lines and writes nothing.
      const plan = await planOwnerChange(contract, change, legs, appended);
      const budgetChangeNumber = plan ? await nextRecordNumber(app.db, plan.budgetId, "budget_change") : null;
      const budgetChangeId = plan ? newId("bch") : null;

      const now = nowIso();
      let budgetLinesMoved = 0;
      await app.db.transaction(async (tx) => {
        for (const row of appended) await tx.insert(primeContractSovLines).values(row);
        await tx
          .update(primeContractChanges)
          .set({
            status: "executed",
            executedBy: req.user!.id,
            executedDate,
            signedChangeOrderReceivedDate:
              body.signedChangeOrderReceivedDate ?? change.signedChangeOrderReceivedDate,
            revisedContractSum: round2(contract.originalContractSum + newApprovedChangeSum),
            detail: {
              ...((change.detail as Record<string, unknown> | null) ?? {}),
              budgetChangeId,
              budgetReasons: plan ? [] : planReasons,
            },
            updatedAt: now,
          })
          .where(eq(primeContractChanges.id, change.id));
        if (plan && budgetChangeId && budgetChangeNumber !== null) {
          const requestedBy = change.submittedBy ?? change.createdBy;
          const approvedBy = change.approvedBy ?? req.user!.id;
          if (approvedBy === requestedBy) {
            throw new AppError(
              403,
              "Segregation of duties: the budget movement this change order funds would be " +
                "requested and approved by the same person.",
              { control: "no_self_certification" },
            );
          }
          await tx.insert(budgetChanges).values({
            id: budgetChangeId,
            companyId: contract.companyId,
            projectId: contract.projectId,
            budgetId: plan.budgetId,
            number: budgetChangeNumber,
            reference: `BC-${pad3(budgetChangeNumber)}`,
            kind: "owner_change",
            title: `${change.reference} — ${change.title}`,
            description: change.description,
            reason: "Owner-funded change order",
            status: "approved",
            lines: plan.legs.map((leg) => ({
              lineItemId: leg.lineItemId,
              costCode: leg.costCode,
              costType: leg.costType,
              amount: leg.amount,
            })),
            fromLineItemId: null,
            toLineItemId: plan.legs[0]?.lineItemId ?? null,
            amount: round2(plan.legs.reduce((sum, l) => sum + Math.abs(l.amount), 0)),
            netEffect: round2(change.amount),
            effectiveDate: executedDate,
            sourceType: "prime_contract_change",
            sourceId: change.id,
            requestedBy,
            requestedAt: change.submittedAt ?? now,
            approvedBy,
            approvedAt: change.approvedAt ?? now,
            detail: { primeContractChangeId: change.id, changeOrderPackageId: change.changeOrderPackageId },
            createdBy: change.createdBy,
          });
          for (const leg of plan.legs) {
            const row = plan.rows.get(leg.lineItemId)!;
            const approvedChanges = round2(row.approvedChanges + leg.amount);
            const derived = deriveBudgetColumns({
              originalBudget: row.originalBudget,
              budgetModifications: row.budgetModifications,
              approvedChanges,
              pendingBudgetChanges: row.pendingBudgetChanges,
              committedCost: row.committedCost,
              pendingCommitments: row.pendingCommitments,
              directCosts: row.directCosts,
              jobToDateCosts: row.jobToDateCosts,
              percentComplete: row.percentComplete,
              quantity: row.quantity,
              unitRate: row.unitRate,
              forecastMethod: row.forecastMethod,
              forecastToComplete: row.forecastToComplete,
            });
            await tx
              .update(budgetLineItems)
              .set({ approvedChanges, updatedAt: now, ...derived.set })
              .where(eq(budgetLineItems.id, leg.lineItemId));
            budgetLinesMoved += 1;
          }
          if (plan.budgetStatus === "locked") {
            await tx.update(budgets).set({ status: "revised", updatedAt: now }).where(eq(budgets.id, plan.budgetId));
          }
        }
        if (change.changeOrderPackageId) {
          await tx
            .update(changeOrderPackages)
            .set({ primeContractChangeId: change.id, budgetChangeId, updatedAt: now })
            .where(eq(changeOrderPackages.id, change.changeOrderPackageId));
        }
      });
      if (plan) await recomputeBudgetTotals(plan.budgetId);
      const recalculated = await recalcContract(contract.id, req.companyId!);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "prime_contract_change",
        objectId: change.id,
        payload: {
          from: "approved",
          to: "executed",
          amount: change.amount,
          appendedSovLines: appended.map((a) => a.lineNumber),
          revisedContractSum: recalculated.revisedContractSum,
          budget: { applied: plan !== null, budgetId: plan?.budgetId ?? null, budgetChangeId, linesMoved: budgetLinesMoved, reasons: plan ? [] : planReasons },
        },
        storePayload: true,
      });
      if (plan && budgetChangeId) {
        await appendLedger(app.db, {
          companyId: req.companyId!,
          projectId: contract.projectId,
          actorId: req.user!.id,
          action: "create",
          objectType: "budget_change",
          objectId: budgetChangeId,
          payload: { budgetId: plan.budgetId, kind: "owner_change", status: "approved", sourceType: "prime_contract_change", sourceId: change.id, netEffect: round2(change.amount), legs: plan.legs },
          storePayload: true,
        });
      }
      return {
        change: await fetchChange(contract, change.id),
        appendedLines: appended.map((a) => ({
          id: a.id,
          lineNumber: a.lineNumber,
          scheduledValue: a.scheduledValue,
        })),
        budget: {
          applied: plan !== null,
          budgetId: plan?.budgetId ?? null,
          budgetChangeId,
          linesMoved: budgetLinesMoved,
          amount: plan ? round2(plan.legs.reduce((sum, l) => sum + l.amount, 0)) : 0,
          reasons: plan ? [] : planReasons,
        },
        contract: await contractView(recalculated),
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Progress billing — the G702/G703 application                      */
  /* ---------------------------------------------------------------- */

  /** Σ certified on prior applications: G702 line 7. */
  async function previousCertificates(
    primeContractId: string,
    excludeApplicationId: string | null,
  ): Promise<number> {
    const rows = await app.db
      .select({
        id: paymentApplications.id,
        certifiedAmount: paymentApplications.certifiedAmount,
        currentPaymentDue: paymentApplications.currentPaymentDue,
      })
      .from(paymentApplications)
      .where(
        and(
          eq(paymentApplications.primeContractId, primeContractId),
          inArray(paymentApplications.status, [...CERTIFIED_APP_STATUSES]),
        ),
      );
    return round2(
      rows
        .filter((r) => r.id !== excludeApplicationId)
        .reduce((s, r) => s + (r.certifiedAmount ?? r.currentPaymentDue), 0),
    );
  }

  /**
   * Recompute a draft application end to end from the schedule of values and
   * whatever the biller last entered, then persist every figure. Called on
   * creation, on every line edit and once more at submission — the numbers
   * are stored rather than derived on read because an application is a legal
   * document that must say tomorrow what it said today.
   */
  async function recomputeBilling(
    contract: ContractRow,
    billing: Billing,
    inputs: Map<string, LineBillingInput>,
  ): Promise<{
    rows: G703Row[];
    application: AppRow;
    invoice: InvoiceRow;
    reasons: string[];
  }> {
    const sov = await loadSov(contract.id);
    if (sov.length === 0) {
      throw conflict("This prime contract has no schedule of values to bill from");
    }
    const existingLines = await app.db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, billing.invoice.id));
    const byLineId = new Map(
      existingLines
        .filter((l) => l.primeContractSovLineId)
        .map((l) => [l.primeContractSovLineId as string, l]),
    );

    // derive this period's figures line by line, refusing as a set so the
    // caller sees every problem at once rather than one per round trip
    const derivations: Array<{ line: SovRow; derived: DerivedPeriodValues }> = [];
    const problems: string[] = [];
    for (const line of sov) {
      const input = inputs.get(line.id) ?? {};
      const derivation = derivePeriodValues(billable(line), input);
      if (!derivation.ok) {
        problems.push(...derivation.reasons);
        continue;
      }
      problems.push(...validatePeriodValues(billable(line), derivation.value));
      derivations.push({ line, derived: derivation.value });
    }
    if (problems.length > 0) {
      throw new AppError(422, `This application cannot be computed: ${problems[0]}`, {
        reasons: problems,
      });
    }

    const lessPrevious = await previousCertificates(contract.id, billing.application.id);
    const result = computeApplication({
      contract: {
        originalContractSum: contract.originalContractSum,
        approvedChangeSum: contract.approvedChangeSum,
        currency: contract.currency,
      },
      lines: derivations.map(({ line, derived }) => ({ line: billable(line), derived })),
      terms: retainageTermsOf(contract),
      lessPreviousCertificates: lessPrevious,
    });

    const now = nowIso();
    const g = result.g702;
    await app.db.transaction(async (tx) => {
      for (const row of result.rows) {
        const existing = byLineId.get(row.sovLineId);
        const values = {
          scheduledValue: row.revisedScheduledValue,
          previousBilled: row.previousBilled,
          previousStoredMaterials: row.previousStoredMaterials,
          thisPeriodWork: row.thisPeriodWork,
          thisPeriodStoredMaterials: row.thisPeriodStoredMaterials,
          materialsPresentlyStored: row.materialsPresentlyStored,
          totalCompletedAndStored: row.totalCompletedAndStored,
          percentComplete: row.percentComplete ?? 0,
          balanceToFinish: row.balanceToFinish,
          retainagePercent: row.retainagePercent,
          retainageThisPeriod: row.retainageThisPeriod,
          retainageHeldToDate: row.retainageHeldToDate,
          retainageReleased: row.retainageReleased,
          amount: row.amount,
          updatedAt: now,
        };
        if (existing) {
          await tx.update(invoiceLineItems).set(values).where(eq(invoiceLineItems.id, existing.id));
        } else {
          // a change order executed mid-period appends SOV lines; the sheet
          // picks them up at zero rather than going silently incomplete
          await tx.insert(invoiceLineItems).values({
            id: newId("ivl"),
            companyId: contract.companyId,
            projectId: contract.projectId,
            invoiceId: billing.invoice.id,
            lineNumber: row.lineNumber,
            sortOrder: row.sortOrder,
            primeContractSovLineId: row.sovLineId,
            costCodeId: row.costCodeId,
            costCode: row.costCode,
            costType: row.costType,
            budgetLineItemId: row.budgetLineItemId,
            description: row.description,
            source: row.isChangeOrderLine === 1 ? "change_order" : "contract_sov",
            billingMethod: row.billingMethod,
            unit: row.unit,
            quantity: row.quantity,
            unitRate: row.unitRate,
            changeOrderPackageId: row.changeOrderPackageId,
            ...values,
          });
        }
        // mirror the live position onto the SOV line so the schedule of
        // values reads true mid-period. Carried-forward columns are NOT
        // touched here — only certification moves those.
        await tx
          .update(primeContractSovLines)
          .set({ ...mirrorLine(row), updatedAt: now })
          .where(eq(primeContractSovLines.id, row.sovLineId));
      }
      await tx
        .update(invoices)
        .set({
          originalContractSum: g.originalContractSum,
          netChangeOrders: g.netChangeOrders,
          revisedContractSum: g.contractSumToDate,
          completedToDate: g.completedToDate,
          storedMaterials: g.storedMaterials,
          totalCompletedAndStored: g.totalCompletedAndStored,
          retainagePercentWork: g.retainagePercentWork,
          retainageWork: g.retainageWork,
          retainagePercentMaterials: g.retainagePercentMaterials,
          retainageMaterials: g.retainageMaterials,
          totalRetainage: g.totalRetainage,
          retainageReleased: g.retainageReleased,
          totalEarnedLessRetainage: g.totalEarnedLessRetainage,
          previousPaymentsAmount: g.lessPreviousCertificates,
          currentPaymentDue: g.currentPaymentDue,
          balanceToFinishPlusRetainage: g.balanceToFinishPlusRetainage,
          subtotal: g.currentPaymentDue,
          total: g.currentPaymentDue,
          updatedAt: now,
        })
        .where(eq(invoices.id, billing.invoice.id));
      await tx
        .update(paymentApplications)
        .set({
          originalContractSum: g.originalContractSum,
          netChangeOrders: g.netChangeOrders,
          contractSumToDate: g.contractSumToDate,
          totalCompletedAndStored: g.totalCompletedAndStored,
          totalRetainage: g.totalRetainage,
          totalEarnedLessRetainage: g.totalEarnedLessRetainage,
          lessPreviousCertificates: g.lessPreviousCertificates,
          currentPaymentDue: g.currentPaymentDue,
          balanceToFinishPlusRetainage: g.balanceToFinishPlusRetainage,
          detail: {
            ...((billing.application.detail as Record<string, unknown> | null) ?? {}),
            retainage: result.retainage,
            identities: result.identities,
          },
          updatedAt: now,
        })
        .where(eq(paymentApplications.id, billing.application.id));
    });

    const refreshed = await fetchBilling(contract, billing.application.id);
    return {
      rows: result.rows,
      application: refreshed.application,
      invoice: refreshed.invoice,
      reasons: result.reasons,
    };
  }

  /** The full G702 + G703 view of one billing. */
  async function billingView(contract: ContractRow, billingId: string) {
    const billing = await fetchBilling(contract, billingId);
    const lines = await app.db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, billing.invoice.id))
      .orderBy(asc(invoiceLineItems.sortOrder), asc(invoiceLineItems.lineNumber));
    const a = billing.application;
    const identities = [
      { identity: "line 1 + line 2 = line 3", left: round2(a.originalContractSum + a.netChangeOrders), right: a.contractSumToDate, delta: round2(a.originalContractSum + a.netChangeOrders - a.contractSumToDate), ok: nearlyEqual(a.originalContractSum + a.netChangeOrders, a.contractSumToDate) },
      { identity: "Σ G703 total completed and stored = line 4", left: round2(lines.reduce((s, l) => s + l.totalCompletedAndStored, 0)), right: a.totalCompletedAndStored, delta: round2(lines.reduce((s, l) => s + l.totalCompletedAndStored, 0) - a.totalCompletedAndStored), ok: nearlyEqual(lines.reduce((s, l) => s + l.totalCompletedAndStored, 0), a.totalCompletedAndStored) },
      { identity: "line 4 − line 5 = line 6", left: round2(a.totalCompletedAndStored - a.totalRetainage), right: a.totalEarnedLessRetainage, delta: round2(a.totalCompletedAndStored - a.totalRetainage - a.totalEarnedLessRetainage), ok: nearlyEqual(a.totalCompletedAndStored - a.totalRetainage, a.totalEarnedLessRetainage) },
      { identity: "line 6 − line 7 = line 8", left: round2(a.totalEarnedLessRetainage - a.lessPreviousCertificates), right: a.currentPaymentDue, delta: round2(a.totalEarnedLessRetainage - a.lessPreviousCertificates - a.currentPaymentDue), ok: nearlyEqual(a.totalEarnedLessRetainage - a.lessPreviousCertificates, a.currentPaymentDue) },
      { identity: "line 3 − line 6 = line 9", left: round2(a.contractSumToDate - a.totalEarnedLessRetainage), right: a.balanceToFinishPlusRetainage, delta: round2(a.contractSumToDate - a.totalEarnedLessRetainage - a.balanceToFinishPlusRetainage), ok: nearlyEqual(a.contractSumToDate - a.totalEarnedLessRetainage, a.balanceToFinishPlusRetainage) },
    ];
    return {
      application: a,
      invoice: billing.invoice,
      g702: {
        originalContractSum: a.originalContractSum,
        netChangeOrders: a.netChangeOrders,
        contractSumToDate: a.contractSumToDate,
        completedToDate: billing.invoice.completedToDate,
        storedMaterials: billing.invoice.storedMaterials,
        totalCompletedAndStored: a.totalCompletedAndStored,
        retainagePercentWork: billing.invoice.retainagePercentWork,
        retainageWork: billing.invoice.retainageWork,
        retainagePercentMaterials: billing.invoice.retainagePercentMaterials,
        retainageMaterials: billing.invoice.retainageMaterials,
        totalRetainage: a.totalRetainage,
        totalEarnedLessRetainage: a.totalEarnedLessRetainage,
        lessPreviousCertificates: a.lessPreviousCertificates,
        currentPaymentDue: a.currentPaymentDue,
        balanceToFinishPlusRetainage: a.balanceToFinishPlusRetainage,
        percentComplete: percentCompleteOf(
          a.totalCompletedAndStored,
          a.contractSumToDate,
          `Application ${a.reference}`,
        ),
        currency: a.currency,
      },
      g703: lines,
      identities,
      reconciled: identities.every((i) => i.ok),
      retainage: (a.detail as Record<string, unknown> | null)?.["retainage"] ?? null,
    };
  }

  /**
   * Open a billing application for a period, auto-populated from the SOV.
   * One open application at a time per contract: two drafts against one
   * schedule of values would each snapshot the same `previousBilled` and
   * bill the same work twice.
   */
  app.post(
    "/prime-contracts/:primeContractId/billings",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId } = req.params as { primeContractId: string };
      const body = billingCreateSchema.parse(req.body);
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "standard");
      if (contract.executed !== 1) {
        throw conflict(
          `Prime contract ${contract.reference} is not executed — an unexecuted contract cannot ` +
            "be billed against.",
        );
      }
      if (["void", "terminated"].includes(contract.status)) {
        throw conflict(`A ${contract.status} prime contract cannot be billed`);
      }
      const sov = await loadSov(contract.id);
      assertSovBalanced(sov.map(billable), {
        originalContractSum: contract.originalContractSum,
        approvedChangeSum: contract.approvedChangeSum,
        currency: contract.currency,
      });
      const open = await app.db
        .select({ id: paymentApplications.id, reference: paymentApplications.reference, status: paymentApplications.status })
        .from(paymentApplications)
        .where(
          and(
            eq(paymentApplications.primeContractId, contract.id),
            inArray(paymentApplications.status, [...OPEN_APP_STATUSES]),
          ),
        )
        .limit(1);
      if (open[0]) {
        throw conflict(
          `Application ${open[0].reference} is still open (${open[0].status}) on this contract — ` +
            "certify, reopen or void it before starting the next one. Two open applications " +
            "would each carry this period's figures for the same work.",
        );
      }
      await assertPeriodWritable(
        body.billingPeriodId ?? null,
        contract.projectId,
        "opening an application",
      );
      if (body.billingPeriodId) {
        const dupe = await app.db
          .select({ reference: paymentApplications.reference })
          .from(paymentApplications)
          .where(
            and(
              eq(paymentApplications.primeContractId, contract.id),
              eq(paymentApplications.billingPeriodId, body.billingPeriodId),
              ne(paymentApplications.status, "void"),
            ),
          )
          .limit(1);
        if (dupe[0]) {
          throw conflict(
            `Application ${dupe[0].reference} already bills this contract for that billing ` +
              "period — one application per contract per period.",
          );
        }
      }

      const invoiceNumber = await nextRecordNumber(
        app.db,
        contract.projectId,
        "owner_billing_invoice",
      );
      const appNumber = await nextRecordNumber(app.db, contract.projectId, "payment_application");
      const invoiceId = newId("inv");
      const applicationId = newId("pap");
      const now = nowIso();
      await app.db.transaction(async (tx) => {
        await tx.insert(invoices).values({
          id: invoiceId,
          companyId: contract.companyId,
          projectId: contract.projectId,
          kind: "owner_billing",
          number: invoiceNumber,
          reference: `OB-${pad3(invoiceNumber)}`,
          title: body.title ?? `${contract.reference} application ${pad3(appNumber)}`,
          status: "draft",
          primeContractId: contract.id,
          vendorId: contract.ownerVendorId,
          billingPeriodId: body.billingPeriodId ?? null,
          currency: contract.currency,
          billingDate: body.billingDate,
          periodStart: body.periodStart ?? null,
          periodEnd: body.periodEnd ?? body.billingDate,
          dueDate:
            body.dueDate ??
            (contract.paymentTermsDays != null
              ? new Date(
                  Date.parse(`${body.billingDate}T00:00:00Z`) +
                    contract.paymentTermsDays * 86_400_000,
                )
                  .toISOString()
                  .slice(0, 10)
              : null),
          originalContractSum: contract.originalContractSum,
          netChangeOrders: contract.approvedChangeSum,
          revisedContractSum: contract.revisedContractSum,
          createdBy: req.user!.id,
        });
        await tx.insert(paymentApplications).values({
          id: applicationId,
          companyId: contract.companyId,
          projectId: contract.projectId,
          primeContractId: contract.id,
          invoiceId,
          billingPeriodId: body.billingPeriodId ?? null,
          number: appNumber,
          reference: `PA-${pad3(appNumber)}`,
          status: "draft",
          applicationDate: body.billingDate,
          periodTo: body.periodEnd ?? body.billingDate,
          currency: contract.currency,
          architectVendorId: contract.architectVendorId,
          originalContractSum: contract.originalContractSum,
          netChangeOrders: contract.approvedChangeSum,
          contractSumToDate: contract.revisedContractSum,
          createdBy: req.user!.id,
        });
        for (const [i, line] of sov.entries()) {
          await tx.insert(invoiceLineItems).values({
            id: newId("ivl"),
            companyId: contract.companyId,
            projectId: contract.projectId,
            invoiceId,
            lineNumber: line.lineNumber,
            sortOrder: line.sortOrder || i,
            primeContractSovLineId: line.id,
            costCodeId: line.costCodeId,
            costCode: line.costCode,
            costType: line.costType,
            budgetLineItemId: line.budgetLineItemId,
            description: line.description,
            source: line.isChangeOrderLine === 1 ? "change_order" : "contract_sov",
            billingMethod: line.billingMethod,
            unit: line.unit,
            quantity: line.quantity,
            unitRate: line.unitRate,
            changeOrderPackageId: line.changeOrderPackageId,
            scheduledValue: revisedScheduledValueOf(line),
            previousBilled: line.previousBilled,
            previousStoredMaterials: line.previousStoredMaterials,
            materialsPresentlyStored: line.previousStoredMaterials,
            retainagePercent: line.retainagePercent,
            updatedAt: now,
          });
        }
      });
      const billing = await fetchBilling(contract, applicationId);
      await recomputeBilling(contract, billing, new Map());
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: req.user!.id,
        action: "create",
        objectType: "payment_application",
        objectId: applicationId,
        payload: {
          primeContractId: contract.id,
          number: appNumber,
          invoiceId,
          billingDate: body.billingDate,
          sovLines: sov.length,
        },
        storePayload: true,
      });
      return reply.status(201).send(await billingView(contract, applicationId));
    },
  );

  app.get(
    "/prime-contracts/:primeContractId/billings",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId } = req.params as { primeContractId: string };
      const q = billingListQuery.parse(req.query);
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "read");
      const clauses = [eq(paymentApplications.primeContractId, contract.id)];
      if (q.billingPeriodId) {
        clauses.push(eq(paymentApplications.billingPeriodId, q.billingPeriodId));
      }
      const where = and(...clauses);
      const [totalRow] = await app.db.select({ n: count() }).from(paymentApplications).where(where);
      const items = await app.db
        .select()
        .from(paymentApplications)
        .where(where)
        .orderBy(desc(paymentApplications.number))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(items, Number(totalRow?.n ?? 0), q);
    },
  );

  app.get(
    "/prime-contracts/:primeContractId/billings/:billingId",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId, billingId } = req.params as {
        primeContractId: string;
        billingId: string;
      };
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "read");
      return billingView(contract, billingId);
    },
  );

  app.patch(
    "/prime-contracts/:primeContractId/billings/:billingId",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId, billingId } = req.params as {
        primeContractId: string;
        billingId: string;
      };
      const body = billingPatchSchema.parse(req.body);
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "standard");
      const billing = await fetchBilling(contract, billingId);
      if (billing.application.status !== "draft") {
        throw conflict(
          `Application ${billing.application.reference} is ${billing.application.status} — only a ` +
            "draft application can be edited.",
        );
      }
      await assertPeriodWritable(
        body.billingPeriodId ?? billing.application.billingPeriodId,
        contract.projectId,
        "editing an application",
      );
      const now = nowIso();
      await app.db
        .update(paymentApplications)
        .set({
          ...(body.billingDate !== undefined ? { applicationDate: body.billingDate } : {}),
          ...(body.periodEnd !== undefined ? { periodTo: body.periodEnd } : {}),
          ...(body.billingPeriodId !== undefined
            ? { billingPeriodId: body.billingPeriodId }
            : {}),
          updatedAt: now,
        })
        .where(eq(paymentApplications.id, billing.application.id));
      await app.db
        .update(invoices)
        .set({
          ...(body.billingDate !== undefined ? { billingDate: body.billingDate } : {}),
          ...(body.periodStart !== undefined ? { periodStart: body.periodStart } : {}),
          ...(body.periodEnd !== undefined ? { periodEnd: body.periodEnd } : {}),
          ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.billingPeriodId !== undefined
            ? { billingPeriodId: body.billingPeriodId }
            : {}),
          updatedAt: now,
        })
        .where(eq(invoices.id, billing.invoice.id));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: req.user!.id,
        action: "update",
        objectType: "payment_application",
        objectId: billing.application.id,
        payload: { changed: Object.keys(body) },
      });
      return billingView(contract, billing.application.id);
    },
  );

  /** Enter this period's progress. The whole application is recomputed. */
  app.put(
    "/prime-contracts/:primeContractId/billings/:billingId/lines",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId, billingId } = req.params as {
        primeContractId: string;
        billingId: string;
      };
      const body = billingLinesSchema.parse(req.body);
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "standard");
      const billing = await fetchBilling(contract, billingId);
      if (billing.application.status !== "draft") {
        throw conflict(
          `Application ${billing.application.reference} is ${billing.application.status} — its ` +
            "figures are frozen. Reopen it first if it has not been certified.",
        );
      }
      await assertPeriodWritable(
        billing.application.billingPeriodId,
        contract.projectId,
        "billing work",
      );
      const sov = await loadSov(contract.id);
      const known = new Set(sov.map((l) => l.id));
      for (const line of body.lines) {
        if (!known.has(line.sovLineId)) {
          throw badRequest(
            `sovLineId ${line.sovLineId} is not a schedule-of-values line on this contract`,
          );
        }
      }
      const inputs = new Map<string, LineBillingInput>(
        body.lines.map((l) => [l.sovLineId, l as LineBillingInput]),
      );
      const result = await recomputeBilling(contract, billing, inputs);
      for (const line of body.lines) {
        if (line.notes !== undefined) {
          await app.db
            .update(invoiceLineItems)
            .set({ notes: line.notes })
            .where(
              and(
                eq(invoiceLineItems.invoiceId, billing.invoice.id),
                eq(invoiceLineItems.primeContractSovLineId, line.sovLineId),
              ),
            );
        }
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: req.user!.id,
        action: "update",
        objectType: "payment_application",
        objectId: billing.application.id,
        payload: {
          linesBilled: body.lines.length,
          currentPaymentDue: result.application.currentPaymentDue,
          totalCompletedAndStored: result.application.totalCompletedAndStored,
        },
      });
      return billingView(contract, billing.application.id);
    },
  );

  /** The contractor's sworn certification — the bottom half of a G702. */
  app.post(
    "/prime-contracts/:primeContractId/billings/:billingId/submit",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId, billingId } = req.params as {
        primeContractId: string;
        billingId: string;
      };
      const body = submitSchema.parse(req.body);
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "standard");
      const billing = await fetchBilling(contract, billingId);
      if (billing.application.status !== "draft") {
        throw conflict(
          `Application ${billing.application.reference} is ${billing.application.status} and ` +
            "cannot be submitted",
        );
      }
      await assertPeriodWritable(
        billing.application.billingPeriodId,
        contract.projectId,
        "submitting an application",
      );
      // The owner-side mirror of commitments.paymentHold: an application
      // cannot go out while a required compliance document is missing or
      // expired. The refusal names the documents.
      const docs = await app.db
        .select()
        .from(primeContractComplianceDocuments)
        .where(eq(primeContractComplianceDocuments.primeContractId, contract.id));
      const gate = complianceGate(docs, today());
      if (!gate.ok) {
        throw new AppError(
          409,
          `Application ${billing.application.reference} cannot be submitted: ${gate.blocking.length} ` +
            `required compliance document(s) block it — ${gate.blocking.map((b) => b.problem).join(" ")}`,
          { control: "compliance_gate", blocking: gate.blocking },
        );
      }
      // recompute once more so what is sworn to is what the SOV says now
      const result = await recomputeBilling(contract, billing, new Map());
      if (result.application.currentPaymentDue < -0.005) {
        throw conflict(
          `Application ${billing.application.reference} computes a current payment due of ` +
            `${formatMoney(result.application.currentPaymentDue)} ${contract.currency} — a ` +
            "negative application is a credit note, not a payment application.",
        );
      }
      const now = nowIso();
      await app.db.transaction(async (tx) => {
        await tx
          .update(paymentApplications)
          .set({
            status: "submitted",
            submittedBy: req.user!.id,
            submittedAt: now,
            certifiedByContractorName: body.certifiedByContractorName,
            contractorCertifiedAt: now,
            notaryReference: body.notaryReference ?? null,
            updatedAt: now,
          })
          .where(eq(paymentApplications.id, billing.application.id));
        await tx
          .update(invoices)
          .set({ status: "submitted", submittedBy: req.user!.id, submittedAt: now, updatedAt: now })
          .where(eq(invoices.id, billing.invoice.id));
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "payment_application",
        objectId: billing.application.id,
        payload: {
          from: "draft",
          to: "submitted",
          currentPaymentDue: result.application.currentPaymentDue,
          totalCompletedAndStored: result.application.totalCompletedAndStored,
          totalRetainage: result.application.totalRetainage,
          certifiedByContractorName: body.certifiedByContractorName,
        },
        storePayload: true,
      });
      return billingView(contract, billing.application.id);
    },
  );

  /**
   * Certification. A third party's act, and the point at which the schedule
   * of values rolls forward: this period becomes previous, retainage held
   * moves, and the contract's billed position is re-derived from the lines.
   *
   * The certifier may certify LESS than was applied for — that is what the
   * form is for — but never more, and may be neither the author nor the
   * submitter of the application.
   */
  app.post(
    "/prime-contracts/:primeContractId/billings/:billingId/certify",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId, billingId } = req.params as {
        primeContractId: string;
        billingId: string;
      };
      const body = certifySchema.parse(req.body ?? {});
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "admin");
      const billing = await fetchBilling(contract, billingId);
      const a = billing.application;
      if (a.status !== "submitted") {
        throw conflict(
          `Application ${a.reference} is ${a.status} — only a submitted application can be ` +
            "certified.",
        );
      }
      const actor = req.user!.id;
      if (actor === a.createdBy || actor === a.submittedBy) {
        throw segregation(
          "The certifier of a payment application may be neither the person who prepared it nor " +
            "the person who submitted it (segregation of duties, ADR 0004).",
        );
      }
      if (body.certifier?.contactId) await assertOwnerContact(body.certifier.contactId, req.companyId!);
      await assertPeriodWritable(a.billingPeriodId, contract.projectId, "certifying an application");
      const certifier = body.certifier
        ? {
            contactId: body.certifier.contactId ?? contract.ownerContactId ?? null,
            name: body.certifier.name,
            signedAt: body.certifier.signedAt ?? today(),
            documentHash: body.certifier.documentHash ?? null,
            notes: body.certifier.notes ?? null,
            recordedBy: actor,
          }
        : null;
      const stepDown = (a.detail as Record<string, unknown> | null)?.["retainage"] as
        | { stepDownApplied?: boolean; percentCompleteAtCalc?: number | null; note?: string | null; workPercent?: number; reducedPercent?: number | null; thresholdPercent?: number | null }
        | undefined;
      const certifiedAmount = round2(body.certifiedAmount ?? a.currentPaymentDue);
      if (certifiedAmount - a.currentPaymentDue > 0.005) {
        throw badRequest(
          `Certified amount ${formatMoney(certifiedAmount)} ${contract.currency} exceeds the ` +
            `${formatMoney(a.currentPaymentDue)} ${contract.currency} applied for — a certifier ` +
            "may certify less than was applied for, never more.",
        );
      }
      if (certifiedAmount < -0.005) throw badRequest("Certified amount cannot be negative");
      const partial = !nearlyEqual(certifiedAmount, a.currentPaymentDue);

      // roll the schedule of values forward from what was actually billed
      const sov = await loadSov(contract.id);
      const lines = await app.db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, billing.invoice.id));
      const byId = new Map(
        lines.filter((l) => l.primeContractSovLineId).map((l) => [l.primeContractSovLineId!, l]),
      );
      const now = nowIso();
      await app.db.transaction(async (tx) => {
        for (const line of sov) {
          const billed = byId.get(line.id);
          if (!billed) continue;
          const rolled = rollForward({
            sovLineId: line.id,
            lineNumber: line.lineNumber,
            description: line.description,
            sortOrder: line.sortOrder,
            billingMethod: line.billingMethod,
            costCode: line.costCode,
            costType: line.costType,
            costCodeId: line.costCodeId,
            budgetLineItemId: line.budgetLineItemId,
            unit: line.unit,
            quantity: line.quantity,
            unitRate: line.unitRate,
            isChangeOrderLine: line.isChangeOrderLine,
            changeOrderPackageId: line.changeOrderPackageId,
            scheduledValue: line.scheduledValue,
            changeOrderValue: line.changeOrderValue,
            revisedScheduledValue: revisedScheduledValueOf(line),
            previousBilled: billed.previousBilled,
            thisPeriodWork: billed.thisPeriodWork,
            previousStoredMaterials: billed.previousStoredMaterials,
            thisPeriodStoredMaterials: billed.thisPeriodStoredMaterials,
            materialsPresentlyStored: billed.materialsPresentlyStored,
            workCompletedToDate: round2(billed.previousBilled + billed.thisPeriodWork),
            totalCompletedAndStored: billed.totalCompletedAndStored,
            percentComplete: billed.percentComplete,
            balanceToFinish: billed.balanceToFinish,
            retainagePercent: billed.retainagePercent,
            retainageWork: 0,
            retainageMaterials: 0,
            retainageHeldToDate: billed.retainageHeldToDate,
            retainageThisPeriod: billed.retainageThisPeriod,
            retainageReleased: billed.retainageReleased,
            amount: billed.amount,
            reasons: [],
          });
          await tx
            .update(primeContractSovLines)
            .set({ ...rolled, updatedAt: now })
            .where(eq(primeContractSovLines.id, line.id));
        }
        await tx
          .update(paymentApplications)
          .set({
            status: partial ? "partially_certified" : "certified",
            certifiedAmount,
            certificationNotes: body.certificationNotes ?? null,
            certifiedBy: actor,
            certifiedAt: now,
            architectVendorId: body.architectVendorId ?? a.architectVendorId,
            ...(certifier
              ? { detail: { ...((a.detail as Record<string, unknown> | null) ?? {}), certifier } }
              : {}),
            updatedAt: now,
          })
          .where(eq(paymentApplications.id, a.id));
        await tx
          .update(invoices)
          .set({
            status: partial ? "approved_as_noted" : "approved",
            reviewedBy: actor,
            reviewedAt: now,
            approvedBy: actor,
            approvedAt: now,
            reviewNotes: body.certificationNotes ?? null,
            updatedAt: now,
          })
          .where(eq(invoices.id, billing.invoice.id));
      });
      const recalculated = await recalcContract(contract.id, req.companyId!);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: actor,
        action: "state_change",
        objectType: "payment_application",
        objectId: a.id,
        payload: {
          from: "submitted",
          to: partial ? "partially_certified" : "certified",
          appliedFor: a.currentPaymentDue,
          certifiedAmount,
          shortfall: round2(a.currentPaymentDue - certifiedAmount),
          totalBilled: recalculated.totalBilled,
          retainageHeld: recalculated.retainageHeld,
          certifier,
        },
        storePayload: true,
      });
      // The contractual step-down is a decision with money attached; it is
      // ledgered as its own event, not left inside the application's detail.
      if (stepDown?.stepDownApplied) {
        await appendLedger(app.db, {
          companyId: req.companyId!,
          projectId: contract.projectId,
          actorId: actor,
          action: "state_change",
          objectType: "prime_retainage_step_down",
          objectId: a.id,
          payload: {
            primeContractId: contract.id,
            applicationId: a.id,
            applicationReference: a.reference,
            percentCompleteAtCalc: stepDown.percentCompleteAtCalc ?? null,
            thresholdPercent: stepDown.thresholdPercent ?? null,
            fromPercent: contract.defaultRetainagePercent,
            toPercent: stepDown.reducedPercent ?? stepDown.workPercent ?? null,
            retainageHeldAfter: recalculated.retainageHeld,
            note: stepDown.note ?? null,
          },
          storePayload: true,
        });
      }
      return billingView(recalculated, a.id);
    },
  );

  app.post(
    "/prime-contracts/:primeContractId/billings/:billingId/reject",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId, billingId } = req.params as {
        primeContractId: string;
        billingId: string;
      };
      const body = rejectSchema.parse(req.body);
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "admin");
      const billing = await fetchBilling(contract, billingId);
      const a = billing.application;
      if (a.status !== "submitted") {
        throw conflict(`Application ${a.reference} is ${a.status} and is not awaiting review`);
      }
      const actor = req.user!.id;
      if (actor === a.createdBy || actor === a.submittedBy) {
        throw segregation(
          "The reviewer of a payment application may be neither its author nor its submitter " +
            "(segregation of duties, ADR 0004).",
        );
      }
      const now = nowIso();
      await app.db.transaction(async (tx) => {
        await tx
          .update(paymentApplications)
          .set({
            status: "rejected",
            rejectedBy: actor,
            rejectedAt: now,
            rejectionReason: body.reason,
            updatedAt: now,
          })
          .where(eq(paymentApplications.id, a.id));
        await tx
          .update(invoices)
          .set({
            status: "revise_and_resubmit",
            reviewedBy: actor,
            reviewedAt: now,
            rejectionReason: body.reason,
            updatedAt: now,
          })
          .where(eq(invoices.id, billing.invoice.id));
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: actor,
        action: "state_change",
        objectType: "payment_application",
        objectId: a.id,
        payload: { from: "submitted", to: "rejected", reason: body.reason },
        storePayload: true,
      });
      return billingView(contract, a.id);
    },
  );

  /**
   * Reopen a submitted or rejected application for correction.
   *
   * A CERTIFIED application never reopens. Certification is a third party's
   * determination on a specific set of figures; reopening it would rewrite a
   * document someone else signed and on which statutory payment clocks run.
   * Corrections go on the next application, which is exactly what line 7
   * exists to carry.
   */
  app.post(
    "/prime-contracts/:primeContractId/billings/:billingId/reopen",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId, billingId } = req.params as {
        primeContractId: string;
        billingId: string;
      };
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "standard");
      const billing = await fetchBilling(contract, billingId);
      const a = billing.application;
      if ((CERTIFIED_APP_STATUSES as readonly string[]).includes(a.status)) {
        throw conflict(
          `Application ${a.reference} was certified on ${a.certifiedAt ?? "record"} for ` +
            `${formatMoney(a.certifiedAmount ?? a.currentPaymentDue)} ${a.currency} — a certified ` +
            "application is a third party's determination and does not reopen. Correct it on the " +
            "next application, where line 7 carries what was certified before.",
        );
      }
      if (a.status === "draft") {
        throw conflict(`Application ${a.reference} is already a draft`);
      }
      if (a.status === "void") throw conflict("A void application cannot be reopened");
      await assertPeriodWritable(a.billingPeriodId, contract.projectId, "reopening an application");
      const now = nowIso();
      await app.db.transaction(async (tx) => {
        await tx
          .update(paymentApplications)
          .set({
            status: "draft",
            submittedBy: null,
            submittedAt: null,
            certifiedByContractorName: null,
            contractorCertifiedAt: null,
            rejectedBy: null,
            rejectedAt: null,
            updatedAt: now,
          })
          .where(eq(paymentApplications.id, a.id));
        await tx
          .update(invoices)
          .set({ status: "draft", submittedBy: null, submittedAt: null, updatedAt: now })
          .where(eq(invoices.id, billing.invoice.id));
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "payment_application",
        objectId: a.id,
        payload: { from: a.status, to: "draft" },
      });
      return billingView(contract, a.id);
    },
  );

  /**
   * Void an application that has not been certified. The mirror this
   * application left on the schedule of values is reset to the rolled-
   * forward (certified) position so the next application starts from what
   * was actually certified, not from figures a rejected draft carried.
   * Admin, reason required, ledgered with the payload.
   */
  app.post(
    "/prime-contracts/:primeContractId/billings/:billingId/void",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId, billingId } = req.params as {
        primeContractId: string;
        billingId: string;
      };
      const body = voidSchema.parse(req.body);
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "admin");
      const billing = await fetchBilling(contract, billingId);
      const a = billing.application;
      if ((CERTIFIED_APP_STATUSES as readonly string[]).includes(a.status)) {
        throw conflict(
          `Application ${a.reference} was certified on ${a.certifiedAt ?? "record"} — a certified ` +
            "application is a third party's determination and cannot be voided. Correct it on the " +
            "next application.",
        );
      }
      if (a.status === "void") throw conflict(`Application ${a.reference} is already void.`);
      const sov = await loadSov(contract.id);
      const now = nowIso();
      await app.db.transaction(async (tx) => {
        for (const line of sov) {
          const certified = certifiedBilledOf(line);
          const revised = revisedScheduledValueOf(line);
          await tx
            .update(primeContractSovLines)
            .set({
              thisPeriodWork: 0,
              thisPeriodStoredMaterials: 0,
              materialsPresentlyStored: line.previousStoredMaterials,
              totalCompletedAndStored: certified,
              percentComplete: revised > 0 ? round4((certified / revised) * 100) : 0,
              balanceToFinish: round2(revised - certified),
              updatedAt: now,
            })
            .where(eq(primeContractSovLines.id, line.id));
        }
        await tx
          .update(paymentApplications)
          .set({
            status: "void",
            detail: {
              ...((a.detail as Record<string, unknown> | null) ?? {}),
              voidedAt: now,
              voidedBy: req.user!.id,
              voidReason: body.reason,
              statusBeforeVoid: a.status,
            },
            updatedAt: now,
          })
          .where(eq(paymentApplications.id, a.id));
        await tx
          .update(invoices)
          .set({ status: "void", updatedAt: now })
          .where(eq(invoices.id, billing.invoice.id));
      });
      const recalculated = await recalcContract(contract.id, req.companyId!);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "payment_application",
        objectId: a.id,
        payload: {
          from: a.status,
          to: "void",
          reason: body.reason,
          currentPaymentDue: a.currentPaymentDue,
          totalCompletedAndStored: a.totalCompletedAndStored,
          totalBilled: recalculated.totalBilled,
        },
        storePayload: true,
      });
      return billingView(recalculated, a.id);
    },
  );

  /**
   * Settlement: the owner has paid (some of) a certified application. Each
   * call records ONE receipt; the application's paid amount and status are
   * derived from the receipts, so a partial payment leaves the application
   * certified with the balance outstanding and a later receipt can settle
   * it. Σ receipts may never exceed the certified amount.
   */
  app.post(
    "/prime-contracts/:primeContractId/billings/:billingId/pay",
    { preHandler: companyGate },
    async (req, reply) => {
      const { primeContractId, billingId } = req.params as {
        primeContractId: string;
        billingId: string;
      };
      const body = paySchema.parse(req.body ?? {});
      const contract = await fetchContract(primeContractId, req.companyId!);
      await requireLevel(req, reply, contract.projectId, "admin");
      const billing = await fetchBilling(contract, billingId);
      const a = billing.application;
      if (!["certified", "partially_certified"].includes(a.status)) {
        throw conflict(
          `Application ${a.reference} is ${a.status} — only a certified application is payable.`,
        );
      }
      const result = await recordReceipt(
        app.db,
        contract,
        billing,
        req.user!.id,
        {
          amount: body.paidAmount,
          receivedDate: body.paidAt,
          method: body.method,
          paymentReference: body.paymentReference,
          bankReference: body.bankReference,
          notes: body.notes,
        },
        () => nextRecordNumber(app.db, contract.id, "owner_payment_receipt"),
      );
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: contract.projectId,
        actorId: req.user!.id,
        action: "create",
        objectType: "owner_payment_receipt",
        objectId: result.receipt.id,
        payload: {
          applicationId: a.id,
          applicationReference: a.reference,
          amount: result.receipt.amount,
          currency: result.receipt.currency,
          receivedDate: result.receipt.receivedDate,
          method: result.receipt.method,
          paymentReference: result.receipt.paymentReference,
          certifiedAmount: round2(a.certifiedAmount ?? a.currentPaymentDue),
          paid: result.settlement.paid,
          outstanding: result.settlement.outstanding,
          settlement: result.settlement.state,
          totalPaid: result.contract.totalPaid,
        },
        storePayload: true,
      });
      if (result.settlement.state === "paid") {
        await appendLedger(app.db, {
          companyId: req.companyId!,
          projectId: contract.projectId,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "payment_application",
          objectId: a.id,
          payload: { from: a.status, to: "paid", paidAmount: result.settlement.paid, receipts: true },
          storePayload: true,
        });
      }
      return {
        ...(await billingView(result.contract, a.id)),
        receipt: result.receipt,
        settlement: {
          paid: result.settlement.paid,
          outstanding: result.settlement.outstanding,
          state: result.settlement.state,
        },
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Lifecycle layer: compliance, stored materials, receipts, ageing,  */
  /* retainage, change analytics, AIA export, health inputs           */
  /* ---------------------------------------------------------------- */
  await app.register(primeLifecycleRoutes);
};
