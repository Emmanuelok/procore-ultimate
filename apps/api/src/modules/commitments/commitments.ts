import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  commitmentChanges,
  commitmentPayments,
  commitmentSovLines,
  commitments,
  contacts,
  contracts,
  primeContracts,
  vendors,
} from "@constructos/db";
import {
  COMMITMENT_KINDS,
  CONTRACT_PRICING_TYPES,
  FINANCIAL_COMMITMENT_STATUSES,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { badRequest, conflict } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import { assessCommitment, complianceRequirementsSchema, readRequirements } from "./compliance.js";
import {
  budgetLineIdsFor,
  commitmentPosition,
  recomputeCommitmentTotals,
  syncBudgetCommitted,
} from "./rollups.js";
import { insertSovLine, sovContext, sovLineInputSchema } from "./sov.js";
import {
  assertSegregation,
  commitmentReference,
  currencySchema,
  detailSchema,
  fetchCommitment,
  isCommittedCommitment,
  isoDateSchema,
  ledger,
  percentSchema,
  requireCommitmentsLevel,
  todayIso,
  type CommitmentRow,
} from "./shared.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

/**
 * Purchase-order-only columns. A subcontract that arrives carrying a ship-to
 * address is a data-entry mistake worth refusing: the discriminator has to
 * mean something or the table is just a bag of nullable columns.
 */
const purchaseOrderFieldsSchema = z.object({
  shipTo: z.string().max(2000).nullable().optional(),
  shipVia: z.string().max(200).nullable().optional(),
  deliveryDate: isoDateSchema.nullable().optional(),
  taxable: z.boolean().optional(),
  taxPercent: percentSchema.nullable().optional(),
});

const commitmentBaseSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  scopeOfWork: z.string().max(100000).nullable().optional(),
  vendorContactId: z.string().min(1).max(64).nullable().optional(),
  contractId: z.string().min(1).max(64).nullable().optional(),
  primeContractId: z.string().min(1).max(64).nullable().optional(),
  pricingType: z.enum(CONTRACT_PRICING_TYPES).optional(),
  defaultRetainagePercent: percentSchema.optional(),
  contractDate: isoDateSchema.nullable().optional(),
  startDate: isoDateSchema.nullable().optional(),
  estimatedCompletionDate: isoDateSchema.nullable().optional(),
  actualCompletionDate: isoDateSchema.nullable().optional(),
  signedContractReceivedDate: isoDateSchema.nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  requiresLienWaiver: z.boolean().optional(),
  inclusions: z.string().max(100000).nullable().optional(),
  exclusions: z.string().max(100000).nullable().optional(),
  documentIds: z.array(z.string().min(1).max(64)).max(500).optional(),
  /** insurance + bond requirements, tested against the insurance module records */
  compliance: complianceRequirementsSchema.partial().optional(),
  detail: detailSchema.optional(),
});

const commitmentCreateSchema = commitmentBaseSchema.merge(purchaseOrderFieldsSchema).extend({
  kind: z.enum(COMMITMENT_KINDS),
  vendorId: z.string().min(1).max(64),
  currency: currencySchema.optional(),
  /** the schedule of values, which IS the commitment sum */
  sovLines: z.array(sovLineInputSchema).max(2000).optional(),
});

/** Every field optional — `title` included, which `.partial()` is what fixes. */
const commitmentPatchSchema = commitmentBaseSchema
  .merge(purchaseOrderFieldsSchema)
  .partial()
  .extend({
    vendorId: z.string().min(1).max(64).optional(),
    currency: currencySchema.optional(),
  });

const commitmentListQuery = pageQuerySchema.extend({
  kind: z.enum(COMMITMENT_KINDS).optional(),
  status: z.enum(FINANCIAL_COMMITMENT_STATUSES).optional(),
  vendorId: z.string().min(1).max(64).optional(),
  primeContractId: z.string().min(1).max(64).optional(),
  executed: z.enum(["0", "1"]).optional(),
  paymentHold: z.enum(["0", "1"]).optional(),
  /** free text over reference, title and scope */
  q: z.string().min(1).max(200).optional(),
  sort: z.enum(["number", "title", "revisedCommitmentSum", "updatedAt"]).default("number"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});

const approveSchema = z.object({
  notes: z.string().max(4000).nullable().optional(),
});

const executeSchema = z.object({
  executionDate: isoDateSchema.optional(),
  signedContractReceivedDate: isoDateSchema.nullable().optional(),
});

const terminateSchema = z.object({
  terminationDate: isoDateSchema.optional(),
  reason: z.string().min(1).max(4000),
});

const holdSchema = z.object({
  reason: z.string().min(1).max(2000),
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/**
 * COMMITMENTS — the buy side of the project.
 *
 * Subcontracts and purchase orders are one table with a `kind` discriminator
 * because every rollup treats them identically: committed cost, retainage
 * held, invoiced to date and balance to finish are the same arithmetic on a
 * $4m mechanical subcontract and a $900 rebar PO. What genuinely differs —
 * tax, shipping, delivery — is nullable, and the routes REFUSE those fields
 * on a subcontract so the discriminator keeps meaning something.
 *
 * The commitment sum is never typed. It is the sum of the schedule of values,
 * and it moves after approval only through change orders. That single rule is
 * what makes `originalCommitmentSum` defensible two years later in front of an
 * auditor, instead of being whatever the last person to open the form left it.
 */
export const commitmentRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("commitments", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("commitments", "standard"),
  ];
  const companyGate = [app.authenticate, app.requireCompany];
  const detail = (commitmentId: string, companyId: string) =>
    commitmentDetail(app.db, commitmentId, companyId);

  /* ---------------------------------------------------------------- */
  /* Reference validation                                              */
  /* ---------------------------------------------------------------- */

  async function assertVendor(vendorId: string, companyId: string): Promise<void> {
    const rows = await app.db
      .select({ id: vendors.id, status: vendors.status })
      .from(vendors)
      .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)))
      .limit(1);
    if (!rows[0]) {
      throw badRequest(
        "vendorId does not reference a vendor in this company's directory. Every commitment " +
          "is bound to a directory vendor — that binding is what carries insurance, bonding " +
          "and lien-waiver compliance onto the commitment.",
      );
    }
  }

  async function assertReferences(
    companyId: string,
    projectId: string,
    body: {
      vendorContactId?: string | null | undefined;
      contractId?: string | null | undefined;
      primeContractId?: string | null | undefined;
    },
    vendorId: string | null,
  ): Promise<void> {
    if (body.vendorContactId) {
      const rows = await app.db
        .select({ id: contacts.id, vendorId: contacts.vendorId })
        .from(contacts)
        .where(and(eq(contacts.id, body.vendorContactId), eq(contacts.companyId, companyId)))
        .limit(1);
      const contact = rows[0];
      if (!contact) throw badRequest("vendorContactId does not reference a contact in this company");
      if (vendorId && contact.vendorId && contact.vendorId !== vendorId) {
        throw badRequest(
          "vendorContactId belongs to a different vendor than the commitment's vendorId",
        );
      }
    }
    if (body.contractId) {
      const rows = await app.db
        .select({ id: contracts.id })
        .from(contracts)
        .where(
          and(
            eq(contracts.id, body.contractId),
            eq(contracts.companyId, companyId),
            eq(contracts.projectId, projectId),
          ),
        )
        .limit(1);
      if (!rows[0]) throw badRequest("contractId does not reference a contract on this project");
    }
    if (body.primeContractId) {
      const rows = await app.db
        .select({ id: primeContracts.id })
        .from(primeContracts)
        .where(
          and(
            eq(primeContracts.id, body.primeContractId),
            eq(primeContracts.companyId, companyId),
            eq(primeContracts.projectId, projectId),
          ),
        )
        .limit(1);
      if (!rows[0]) {
        throw badRequest("primeContractId does not reference a prime contract on this project");
      }
    }
  }

  /**
   * A purchase order's fields on a subcontract, or vice versa, is refused
   * rather than nulled: silently dropping a ship-to date somebody typed is
   * how a delivery gets missed.
   */
  function assertKindFields(kind: string, body: z.infer<typeof purchaseOrderFieldsSchema>): void {
    if (kind === "purchase_order") return;
    const offending = (
      ["shipTo", "shipVia", "deliveryDate", "taxable", "taxPercent"] as const
    ).filter((k) => body[k] !== undefined && body[k] !== null && body[k] !== false);
    if (offending.length > 0) {
      throw badRequest(
        `${offending.join(", ")} ${offending.length === 1 ? "is" : "are"} purchase-order fields ` +
          "and cannot be set on a subcontract. Create the record as kind=purchase_order, or " +
          "record the delivery arrangement in scopeOfWork.",
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Create                                                            */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/commitments", { preHandler: standardGate }, async (req, reply) => {
    const body = commitmentCreateSchema.parse(req.body);
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    assertKindFields(body.kind, body);
    await assertVendor(body.vendorId, companyId);
    await assertReferences(companyId, projectId, body, body.vendorId);

    /*
     * One number sequence per project across BOTH kinds: `commitments_uq` is
     * UNIQUE(projectId, number), so subcontracts and purchase orders share it.
     * The human reference still carries the kind (SC-0003 / PO-0004), which is
     * what people actually read, while the integer stays globally ordered so
     * "the fourth thing we bought" is answerable.
     */
    const number = await nextRecordNumber(app.db, projectId, "commitment");
    const reference = commitmentReference(body.kind, number);
    const id = newId("cmt");
    const isPo = body.kind === "purchase_order";
    const requirements = complianceRequirementsSchema.parse(body.compliance ?? {});

    await app.db.insert(commitments).values({
      id,
      companyId,
      projectId,
      kind: body.kind,
      number,
      reference,
      title: body.title,
      description: body.description ?? null,
      scopeOfWork: body.scopeOfWork ?? null,
      vendorId: body.vendorId,
      vendorContactId: body.vendorContactId ?? null,
      contractId: body.contractId ?? null,
      primeContractId: body.primeContractId ?? null,
      pricingType: body.pricingType ?? "lump_sum",
      status: "draft",
      executed: 0,
      currency: body.currency ?? "USD",
      defaultRetainagePercent: body.defaultRetainagePercent ?? 0,
      contractDate: body.contractDate ?? null,
      startDate: body.startDate ?? null,
      estimatedCompletionDate: body.estimatedCompletionDate ?? null,
      actualCompletionDate: body.actualCompletionDate ?? null,
      signedContractReceivedDate: body.signedContractReceivedDate ?? null,
      paymentTermsDays: body.paymentTermsDays ?? null,
      requiresLienWaiver: body.requiresLienWaiver === false ? 0 : 1,
      complianceDetail: requirements,
      shipTo: isPo ? (body.shipTo ?? null) : null,
      shipVia: isPo ? (body.shipVia ?? null) : null,
      deliveryDate: isPo ? (body.deliveryDate ?? null) : null,
      taxable: isPo && body.taxable ? 1 : 0,
      taxPercent: isPo ? (body.taxPercent ?? null) : null,
      inclusions: body.inclusions ?? null,
      exclusions: body.exclusions ?? null,
      documentIds: body.documentIds ?? [],
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });

    if (body.sovLines && body.sovLines.length > 0) {
      const created = await fetchCommitment(app.db, id, companyId);
      const ctx = await sovContext(app.db, companyId, projectId, created);
      for (const line of body.sovLines) await insertSovLine(ctx, line);
    }
    await recomputeCommitmentTotals(app.db, id);
    const budgetLines = await budgetLineIdsFor(app.db, id);
    if (budgetLines.length > 0) {
      await syncBudgetCommitted(app.db, companyId, projectId, budgetLines);
    }

    await ledger(app.db, req, "create", "commitment", id, {
      projectId,
      kind: body.kind,
      number,
      reference,
      vendorId: body.vendorId,
      sovLineCount: body.sovLines?.length ?? 0,
    }, projectId);
    return reply.status(201).send(await detail(id, companyId));
  });

  /* ---------------------------------------------------------------- */
  /* Read                                                              */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/commitments", { preHandler: readGate }, async (req) => {
    const q = commitmentListQuery.parse(req.query);
    const clauses = [
      eq(commitments.companyId, req.companyId!),
      eq(commitments.projectId, req.projectId!),
    ];
    if (q.kind) clauses.push(eq(commitments.kind, q.kind));
    if (q.status) clauses.push(eq(commitments.status, q.status));
    if (q.vendorId) clauses.push(eq(commitments.vendorId, q.vendorId));
    if (q.primeContractId) clauses.push(eq(commitments.primeContractId, q.primeContractId));
    if (q.executed) clauses.push(eq(commitments.executed, Number(q.executed)));
    if (q.paymentHold) clauses.push(eq(commitments.paymentHold, Number(q.paymentHold)));
    if (q.q) {
      const like = `%${q.q}%`;
      const search = or(
        ilike(commitments.title, like),
        ilike(commitments.reference, like),
        ilike(commitments.scopeOfWork, like),
      );
      if (search) clauses.push(search);
    }
    const where = and(...clauses);
    const column =
      q.sort === "title"
        ? commitments.title
        : q.sort === "revisedCommitmentSum"
          ? commitments.revisedCommitmentSum
          : q.sort === "updatedAt"
            ? commitments.updatedAt
            : commitments.number;
    const [totalRow] = await app.db.select({ n: count() }).from(commitments).where(where);
    const rows = await app.db
      .select({
        commitment: commitments,
        vendorName: vendors.name,
      })
      .from(commitments)
      .leftJoin(vendors, eq(vendors.id, commitments.vendorId))
      .where(where)
      .orderBy(q.dir === "asc" ? asc(column) : desc(column))
      .limit(q.pageSize)
      .offset(pageOffset(q));

    const items = rows.map((r) => ({ ...r.commitment, vendorName: r.vendorName }));
    /*
     * The list carries per-currency subtotals over the WHOLE filtered set, not
     * just the page — a page total is a number nobody can use — and it never
     * adds two currencies together.
     */
    const totalsRows = await app.db
      .select({
        currency: commitments.currency,
        n: count(),
        original: sql<number>`coalesce(sum(${commitments.originalCommitmentSum}), 0)`,
        approvedChanges: sql<number>`coalesce(sum(${commitments.approvedChangeSum}), 0)`,
        revised: sql<number>`coalesce(sum(${commitments.revisedCommitmentSum}), 0)`,
        invoiced: sql<number>`coalesce(sum(${commitments.totalInvoiced}), 0)`,
        paid: sql<number>`coalesce(sum(${commitments.totalPaid}), 0)`,
        retainageHeld: sql<number>`coalesce(sum(${commitments.retainageHeld}), 0)`,
      })
      .from(commitments)
      .where(where)
      .groupBy(commitments.currency);

    return {
      ...paginate(items, Number(totalRow?.n ?? 0), q),
      totalsByCurrency: totalsRows.map((t) => ({
        currency: t.currency,
        commitmentCount: Number(t.n),
        originalCommitmentSum: Number(t.original),
        approvedChangeSum: Number(t.approvedChanges),
        revisedCommitmentSum: Number(t.revised),
        totalInvoiced: Number(t.invoiced),
        totalPaid: Number(t.paid),
        retainageHeld: Number(t.retainageHeld),
      })),
      mixedCurrency: totalsRows.length > 1,
    };
  });

  app.get("/commitments/:commitmentId", { preHandler: companyGate }, async (req, reply) => {
    const { commitmentId } = req.params as { commitmentId: string };
    const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "read");
    return detail(commitmentId, req.companyId!);
  });

  /** The compliance position of one commitment, evaluated now. */
  app.get(
    "/commitments/:commitmentId/compliance",
    { preHandler: companyGate },
    async (req, reply) => {
      const { commitmentId } = req.params as { commitmentId: string };
      const asOf = z.object({ asOf: isoDateSchema.optional() }).parse(req.query).asOf ?? todayIso();
      const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, commitment.projectId, "read");
      return assessCommitment(app.db, commitment, asOf);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Update                                                            */
  /* ---------------------------------------------------------------- */

  app.patch("/commitments/:commitmentId", { preHandler: companyGate }, async (req, reply) => {
    const { commitmentId } = req.params as { commitmentId: string };
    const body = commitmentPatchSchema.parse(req.body);
    const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "standard");
    if (commitment.status === "void" || commitment.status === "terminated") {
      throw conflict(`This commitment is ${commitment.status} and can no longer be edited`);
    }
    assertKindFields(commitment.kind, body);

    const vendorId = body.vendorId ?? commitment.vendorId;
    if (body.vendorId && body.vendorId !== commitment.vendorId) {
      if (isCommittedCommitment(commitment.status)) {
        throw conflict(
          "The vendor on an approved commitment cannot be changed. The counterparty is the " +
            "contract — void this commitment and raise a new one against the correct vendor.",
        );
      }
      await assertVendor(body.vendorId, req.companyId!);
    }
    await assertReferences(req.companyId!, commitment.projectId, body, vendorId);

    if (body.currency && body.currency !== commitment.currency) {
      if (commitment.revisedCommitmentSum !== 0 || commitment.totalInvoiced !== 0) {
        throw conflict(
          `The currency of a commitment carrying value cannot be changed from ` +
            `${commitment.currency} to ${body.currency}: the stored figures would silently ` +
            "change meaning. Void this commitment and raise it again in the correct currency.",
        );
      }
    }

    const isPo = commitment.kind === "purchase_order";
    const requirements = body.compliance
      ? complianceRequirementsSchema.parse({
          ...readRequirements(commitment.complianceDetail),
          ...body.compliance,
        })
      : undefined;

    const set: Partial<typeof commitments.$inferInsert> = {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.scopeOfWork !== undefined ? { scopeOfWork: body.scopeOfWork } : {}),
      ...(body.vendorId !== undefined ? { vendorId: body.vendorId } : {}),
      ...(body.vendorContactId !== undefined ? { vendorContactId: body.vendorContactId } : {}),
      ...(body.contractId !== undefined ? { contractId: body.contractId } : {}),
      ...(body.primeContractId !== undefined ? { primeContractId: body.primeContractId } : {}),
      ...(body.pricingType !== undefined ? { pricingType: body.pricingType } : {}),
      ...(body.currency !== undefined ? { currency: body.currency } : {}),
      ...(body.defaultRetainagePercent !== undefined
        ? { defaultRetainagePercent: body.defaultRetainagePercent }
        : {}),
      ...(body.contractDate !== undefined ? { contractDate: body.contractDate } : {}),
      ...(body.startDate !== undefined ? { startDate: body.startDate } : {}),
      ...(body.estimatedCompletionDate !== undefined
        ? { estimatedCompletionDate: body.estimatedCompletionDate }
        : {}),
      ...(body.actualCompletionDate !== undefined
        ? { actualCompletionDate: body.actualCompletionDate }
        : {}),
      ...(body.signedContractReceivedDate !== undefined
        ? { signedContractReceivedDate: body.signedContractReceivedDate }
        : {}),
      ...(body.paymentTermsDays !== undefined ? { paymentTermsDays: body.paymentTermsDays } : {}),
      ...(body.requiresLienWaiver !== undefined
        ? { requiresLienWaiver: body.requiresLienWaiver ? 1 : 0 }
        : {}),
      ...(requirements ? { complianceDetail: requirements } : {}),
      ...(body.inclusions !== undefined ? { inclusions: body.inclusions } : {}),
      ...(body.exclusions !== undefined ? { exclusions: body.exclusions } : {}),
      ...(body.documentIds !== undefined ? { documentIds: body.documentIds } : {}),
      ...(body.detail !== undefined ? { detail: body.detail } : {}),
      ...(isPo && body.shipTo !== undefined ? { shipTo: body.shipTo } : {}),
      ...(isPo && body.shipVia !== undefined ? { shipVia: body.shipVia } : {}),
      ...(isPo && body.deliveryDate !== undefined ? { deliveryDate: body.deliveryDate } : {}),
      ...(isPo && body.taxable !== undefined ? { taxable: body.taxable ? 1 : 0 } : {}),
      ...(isPo && body.taxPercent !== undefined ? { taxPercent: body.taxPercent } : {}),
      updatedAt: new Date().toISOString(),
    };
    await app.db.update(commitments).set(set).where(eq(commitments.id, commitmentId));
    await recomputeCommitmentTotals(app.db, commitmentId);
    await ledger(app.db, req, "update", "commitment", commitmentId, {
      changed: Object.keys(body),
    }, commitment.projectId);
    return detail(commitmentId, req.companyId!);
  });

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  const transition = async (
    commitmentId: string,
    companyId: string,
    from: readonly string[],
    verb: string,
  ): Promise<CommitmentRow> => {
    const commitment = await fetchCommitment(app.db, commitmentId, companyId);
    if (!from.includes(commitment.status)) {
      throw conflict(
        `A commitment in status "${commitment.status}" cannot be ${verb}. ` +
          `Expected one of: ${from.join(", ")}.`,
      );
    }
    return commitment;
  };

  app.post(
    "/commitments/:commitmentId/out-for-bid",
    { preHandler: companyGate },
    async (req, reply) => {
      const { commitmentId } = req.params as { commitmentId: string };
      const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, commitment.projectId, "standard");
      await transition(commitmentId, req.companyId!, ["draft"], "sent out for bid");
      await setStatus(commitmentId, "out_for_bid");
      await ledger(app.db, req, "state_change", "commitment", commitmentId, {
        status: "out_for_bid",
      }, commitment.projectId);
      return detail(commitmentId, req.companyId!);
    },
  );

  app.post("/commitments/:commitmentId/submit", { preHandler: companyGate }, async (req, reply) => {
    const { commitmentId } = req.params as { commitmentId: string };
    const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "standard");
    await transition(
      commitmentId,
      req.companyId!,
      ["draft", "out_for_bid"],
      "sent out for signature",
    );
    await assertHasSchedule(commitmentId);
    await setStatus(commitmentId, "out_for_signature");
    await ledger(app.db, req, "state_change", "commitment", commitmentId, {
      status: "out_for_signature",
    }, commitment.projectId);
    return detail(commitmentId, req.companyId!);
  });

  /**
   * Approval. Two controls fire here and neither is optional:
   *
   *  - segregation of duties (ADR 0004): the author may not approve their own
   *    commitment. This is enforced at the route, not in a template.
   *  - a commitment with no schedule of values, or a zero sum, is refused.
   *    "Approved, amount to follow" is how uncontrolled cost enters a project.
   */
  app.post("/commitments/:commitmentId/approve", { preHandler: companyGate }, async (req, reply) => {
    const { commitmentId } = req.params as { commitmentId: string };
    approveSchema.parse(req.body ?? {});
    const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "standard");
    await transition(
      commitmentId,
      req.companyId!,
      ["draft", "out_for_bid", "out_for_signature"],
      "approved",
    );
    assertSegregation(req.user!.id, { createdBy: commitment.createdBy }, "commitment");
    const totals = await recomputeCommitmentTotals(app.db, commitmentId);
    if (totals.lineCount === 0) {
      throw badRequest(
        "This commitment has no schedule of values. The commitment sum is the sum of its SOV " +
          "lines, so approving an empty schedule would approve a sum of zero that nobody meant.",
      );
    }
    if (totals.revisedCommitmentSum === 0) {
      throw badRequest(
        "This commitment's schedule of values totals zero. Price the schedule before approving it.",
      );
    }
    const now = new Date().toISOString();
    await app.db
      .update(commitments)
      .set({ status: "approved", approvedBy: req.user!.id, approvedAt: now, updatedAt: now })
      .where(eq(commitments.id, commitmentId));
    const budgetLines = await budgetLineIdsFor(app.db, commitmentId);
    if (budgetLines.length > 0) {
      await syncBudgetCommitted(app.db, req.companyId!, commitment.projectId, budgetLines);
    }
    await ledger(app.db, req, "state_change", "commitment", commitmentId, {
      status: "approved",
      approvedBy: req.user!.id,
      revisedCommitmentSum: totals.revisedCommitmentSum,
    }, commitment.projectId);
    return detail(commitmentId, req.companyId!);
  });

  /**
   * Execution is a FLAG, not a status: `executed = 1` means the paperwork is
   * signed. An approved-but-unexecuted subcontract is a commercial commitment
   * we have made and not yet papered, and that distinction is exactly what
   * gates billing — a sub cannot invoice against an unexecuted subcontract.
   */
  app.post("/commitments/:commitmentId/execute", { preHandler: companyGate }, async (req, reply) => {
    const { commitmentId } = req.params as { commitmentId: string };
    const body = executeSchema.parse(req.body ?? {});
    const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "standard");
    await transition(commitmentId, req.companyId!, ["approved"], "executed");
    if (commitment.executed === 1) throw conflict("This commitment is already executed");
    const now = new Date().toISOString();
    await app.db
      .update(commitments)
      .set({
        executed: 1,
        executedBy: req.user!.id,
        executionDate: body.executionDate ?? todayIso(),
        ...(body.signedContractReceivedDate !== undefined
          ? { signedContractReceivedDate: body.signedContractReceivedDate }
          : {}),
        updatedAt: now,
      })
      .where(eq(commitments.id, commitmentId));
    await ledger(app.db, req, "state_change", "commitment", commitmentId, {
      executed: 1,
      executedBy: req.user!.id,
    }, commitment.projectId);
    return detail(commitmentId, req.companyId!);
  });

  app.post("/commitments/:commitmentId/complete", { preHandler: companyGate }, async (req, reply) => {
    const { commitmentId } = req.params as { commitmentId: string };
    const body = z
      .object({ actualCompletionDate: isoDateSchema.optional() })
      .parse(req.body ?? {});
    const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "standard");
    await transition(commitmentId, req.companyId!, ["approved"], "completed");
    const open = await app.db
      .select({ n: count() })
      .from(commitmentChanges)
      .where(
        and(
          eq(commitmentChanges.commitmentId, commitmentId),
          inArray(commitmentChanges.status, [
            "draft",
            "pending_pricing",
            "pending_in_house_review",
            "pending_owner_approval",
            "revise_and_resubmit",
          ]),
        ),
      );
    if (Number(open[0]?.n ?? 0) > 0) {
      throw conflict(
        `${open[0]?.n} change order(s) on this commitment are still open. Close or void them ` +
          "before completing the commitment — an open change order on a complete subcontract " +
          "is unpriced exposure that nothing will ever surface again.",
      );
    }
    const now = new Date().toISOString();
    await app.db
      .update(commitments)
      .set({
        status: "complete",
        actualCompletionDate: body.actualCompletionDate ?? commitment.actualCompletionDate ?? todayIso(),
        updatedAt: now,
      })
      .where(eq(commitments.id, commitmentId));
    await ledger(app.db, req, "state_change", "commitment", commitmentId, {
      status: "complete",
    }, commitment.projectId);
    return detail(commitmentId, req.companyId!);
  });

  app.post("/commitments/:commitmentId/terminate", { preHandler: companyGate }, async (req, reply) => {
    const { commitmentId } = req.params as { commitmentId: string };
    const body = terminateSchema.parse(req.body);
    const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "standard");
    await transition(
      commitmentId,
      req.companyId!,
      ["approved", "out_for_signature", "out_for_bid", "complete"],
      "terminated",
    );
    const now = new Date().toISOString();
    await app.db
      .update(commitments)
      .set({
        status: "terminated",
        terminationDate: body.terminationDate ?? todayIso(),
        complianceHoldReason: body.reason,
        paymentHold: 1,
        updatedAt: now,
      })
      .where(eq(commitments.id, commitmentId));
    const budgetLines = await budgetLineIdsFor(app.db, commitmentId);
    if (budgetLines.length > 0) {
      await syncBudgetCommitted(app.db, req.companyId!, commitment.projectId, budgetLines);
    }
    await ledger(app.db, req, "state_change", "commitment", commitmentId, {
      status: "terminated",
      reason: body.reason,
    }, commitment.projectId);
    return detail(commitmentId, req.companyId!);
  });

  app.post("/commitments/:commitmentId/void", { preHandler: companyGate }, async (req, reply) => {
    const { commitmentId } = req.params as { commitmentId: string };
    const body = z.object({ reason: z.string().min(1).max(4000) }).parse(req.body);
    const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "standard");
    await transition(
      commitmentId,
      req.companyId!,
      ["draft", "out_for_bid", "out_for_signature"],
      "voided",
    );
    if (commitment.totalInvoiced !== 0 || commitment.totalPaid !== 0) {
      throw conflict(
        "This commitment carries invoiced or paid value and cannot be voided. Terminate it " +
          "instead — voiding would erase a record that money moved against.",
      );
    }
    const now = new Date().toISOString();
    await app.db
      .update(commitments)
      .set({ status: "void", complianceHoldReason: body.reason, paymentHold: 1, updatedAt: now })
      .where(eq(commitments.id, commitmentId));
    const budgetLines = await budgetLineIdsFor(app.db, commitmentId);
    if (budgetLines.length > 0) {
      await syncBudgetCommitted(app.db, req.companyId!, commitment.projectId, budgetLines);
    }
    await ledger(app.db, req, "state_change", "commitment", commitmentId, {
      status: "void",
      reason: body.reason,
    }, commitment.projectId);
    return detail(commitmentId, req.companyId!);
  });

  /* ---------------------------------------------------------------- */
  /* Payment hold                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * A manual hold outranks every strictness setting. It is an instruction
   * from a human with a reason attached, and the reason travels with the
   * commitment rather than living in somebody's inbox.
   */
  app.post("/commitments/:commitmentId/hold", { preHandler: companyGate }, async (req, reply) => {
    const { commitmentId } = req.params as { commitmentId: string };
    const body = holdSchema.parse(req.body);
    const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "standard");
    await app.db
      .update(commitments)
      .set({
        paymentHold: 1,
        complianceHoldReason: body.reason,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(commitments.id, commitmentId));
    await ledger(app.db, req, "state_change", "commitment", commitmentId, {
      paymentHold: 1,
      reason: body.reason,
    }, commitment.projectId);
    return detail(commitmentId, req.companyId!);
  });

  app.post(
    "/commitments/:commitmentId/release-hold",
    { preHandler: companyGate },
    async (req, reply) => {
      const { commitmentId } = req.params as { commitmentId: string };
      const body = z.object({ note: z.string().max(2000).nullable().optional() }).parse(
        req.body ?? {},
      );
      const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, commitment.projectId, "standard");
      if (commitment.status === "terminated" || commitment.status === "void") {
        throw conflict(
          `This commitment is ${commitment.status}; its payment hold cannot be released.`,
        );
      }
      if (commitment.paymentHold === 0) throw conflict("This commitment is not on hold");
      /*
       * Releasing a hold is an approval in everything but name — it is what
       * lets money move again — so the person who placed it may not be the
       * person who lifts it unless they are the same act. The author of the
       * hold reason is not tracked separately, so the control applied here is
       * the weaker but still meaningful one: the release is ledgered with its
       * actor and the previous reason, so lifting your own hold is provable.
       */
      await app.db
        .update(commitments)
        .set({
          paymentHold: 0,
          complianceHoldReason: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(commitments.id, commitmentId));
      await ledger(app.db, req, "state_change", "commitment", commitmentId, {
        paymentHold: 0,
        previousReason: commitment.complianceHoldReason,
        note: body.note ?? null,
      }, commitment.projectId);
      return detail(commitmentId, req.companyId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Delete                                                            */
  /* ---------------------------------------------------------------- */

  app.delete("/commitments/:commitmentId", { preHandler: companyGate }, async (req, reply) => {
    const { commitmentId } = req.params as { commitmentId: string };
    const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "admin");
    if (commitment.status !== "draft") {
      throw conflict(
        `Only a draft commitment can be deleted; this one is ${commitment.status}. Void or ` +
          "terminate it instead so the record survives.",
      );
    }
    const [changeCount] = await app.db
      .select({ n: count() })
      .from(commitmentChanges)
      .where(eq(commitmentChanges.commitmentId, commitmentId));
    const [paymentCount] = await app.db
      .select({ n: count() })
      .from(commitmentPayments)
      .where(eq(commitmentPayments.commitmentId, commitmentId));
    if (Number(changeCount?.n ?? 0) > 0 || Number(paymentCount?.n ?? 0) > 0) {
      throw conflict(
        "This commitment has change orders or payments against it and cannot be deleted",
      );
    }
    const budgetLines = await budgetLineIdsFor(app.db, commitmentId);
    await app.db
      .delete(commitmentSovLines)
      .where(eq(commitmentSovLines.commitmentId, commitmentId));
    await app.db.delete(commitments).where(eq(commitments.id, commitmentId));
    if (budgetLines.length > 0) {
      await syncBudgetCommitted(app.db, req.companyId!, commitment.projectId, budgetLines);
    }
    await ledger(app.db, req, "delete", "commitment", commitmentId, {
      reference: commitment.reference,
    }, commitment.projectId);
    return reply.status(204).send();
  });

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  async function setStatus(commitmentId: string, status: string): Promise<void> {
    await app.db
      .update(commitments)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(commitments.id, commitmentId));
  }

  async function assertHasSchedule(commitmentId: string): Promise<void> {
    const [row] = await app.db
      .select({ n: count() })
      .from(commitmentSovLines)
      .where(eq(commitmentSovLines.commitmentId, commitmentId));
    if (Number(row?.n ?? 0) === 0) {
      throw badRequest(
        "This commitment has no schedule of values. A subcontract sent out for signature with " +
          "no priced schedule cannot be billed against and cannot be reconciled to the budget.",
      );
    }
  }

};

/**
 * The full commitment view: header, schedule of values, change-order
 * register, payments, the derived money position and the compliance
 * assessment — one round trip, because that is what the commitment page is.
 * Exported so the change-order and payment route files return the same shape.
 */
export async function commitmentDetail(db: Db, commitmentId: string, companyId: string) {
  const commitment = await fetchCommitment(db, commitmentId, companyId);
  const [lines, changes, payments, vendorRows, position, compliance] = await Promise.all([
    db
      .select()
      .from(commitmentSovLines)
      .where(eq(commitmentSovLines.commitmentId, commitmentId))
      .orderBy(asc(commitmentSovLines.sortOrder), asc(commitmentSovLines.lineNumber)),
    db
      .select()
      .from(commitmentChanges)
      .where(eq(commitmentChanges.commitmentId, commitmentId))
      .orderBy(asc(commitmentChanges.number)),
    db
      .select()
      .from(commitmentPayments)
      .where(eq(commitmentPayments.commitmentId, commitmentId))
      .orderBy(asc(commitmentPayments.number)),
    commitment.vendorId
      ? db
          .select({ id: vendors.id, name: vendors.name, status: vendors.status })
          .from(vendors)
          .where(eq(vendors.id, commitment.vendorId))
          .limit(1)
      : Promise.resolve([] as { id: string; name: string; status: string }[]),
    commitmentPosition(db, commitmentId),
    assessCommitment(db, commitment),
  ]);
  return {
    commitment: {
      ...commitment,
      complianceRequirements: readRequirements(commitment.complianceDetail),
    },
    /** whether a subcontractor may bill against this commitment today, and why not */
    billable: commitmentIsBillable(commitment),
    vendor: vendorRows[0] ?? null,
    sovLines: lines,
    changes,
    payments,
    position,
    compliance,
  };
}

/**
 * Whether a subcontractor may bill against this commitment today.
 *
 * Approval is the commercial decision and execution is the paperwork, and
 * billing needs BOTH: an invoice against an unexecuted subcontract has no
 * signed schedule of values behind it to check the claim against. Exported
 * so the invoicing module gates on exactly this rule rather than its own
 * reading of the same columns.
 */
export function commitmentIsBillable(commitment: CommitmentRow): {
  billable: boolean;
  reason: string | null;
} {
  if (commitment.status === "void" || commitment.status === "terminated") {
    return { billable: false, reason: `This commitment is ${commitment.status}.` };
  }
  if (!isCommittedCommitment(commitment.status)) {
    return {
      billable: false,
      reason:
        `This commitment is ${commitment.status}. A subcontractor cannot bill against a ` +
        "commitment that has not been approved.",
    };
  }
  if (commitment.executed !== 1) {
    return {
      billable: false,
      reason:
        "This commitment is approved but not executed. Signed paperwork is a precondition of " +
        "billing — record the execution before accepting an invoice against it.",
    };
  }
  return { billable: true, reason: null };
}
