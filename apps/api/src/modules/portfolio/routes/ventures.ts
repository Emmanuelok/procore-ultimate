/**
 * JOINT VENTURES, CONSORTIA, SPVs AND ALLIANCES.
 * Spec Vol II Domain Z #1057 (JV/consortium accounting with partner shares),
 * #1058 (governance, board decisions, deed compliance), #1059 (partner
 * contribution and distribution tracking), #1060 (SPV financial reporting).
 *
 * Project-scoped: a venture delivers a project, and that is the scope the
 * `portfolio` tool gate resolves against. A company-level read of every
 * venture is available at `GET /portfolio/ventures`, filtered to the projects
 * the caller can actually see.
 *
 * Rules enforced here:
 *  · Partner shares are validated against 100% and the imbalance is REPORTED,
 *    not corrected. A venture whose deed adds to 97% is a real and dangerous
 *    fact; silently normalising it would hide it.
 *  · Calling a partner contribution raises an Obligation with the due date, so
 *    the deadline lives in the same place as every other deadline on the
 *    platform and the sweep can breach it.
 *  · Settling a contribution is a money move: the row is locked, the amount is
 *    checked, and the obligation is discharged in the same act.
 *  · A board decision's outcome is computed from the deed's quorum and
 *    threshold and the votes actually cast. A vote that is not quorate is
 *    `not_quorate` — never "approved by those present".
 *  · The person who recorded a capital call may not settle it.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, isNotNull, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  jointVentures,
  jvDecisions,
  jvPartners,
  jvTransactions,
  obligations,
  projects,
  vendors,
} from "@constructos/db";
import {
  JV_DECISION_OUTCOMES,
  JV_DECISION_TYPES,
  JV_LIABILITY_BASES,
  JV_PARTNER_ROLES,
  JV_STATUSES,
  JV_STRUCTURES,
  JV_TRANSACTION_KINDS,
  JV_TRANSACTION_STATUSES,
} from "@constructos/shared";
import { badRequest, conflict, forbidden, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { pushNotifications } from "../../notifications/service.js";
import { decideVote, venturePosition, type VoteRow, type VoteValue } from "../jv.js";
import {
  createObligation,
  loadJvTransactions,
  loadPartners,
  setObligationStatus,
  visibleProjectIds,
} from "../service.js";
import {
  buildGates,
  currencySchema,
  idSchema,
  isoDateSchema,
  ledger,
  nonNegativeMoneySchema,
  nowISO,
  patchSchemaOf,
  patchSet,
  percentSchema,
  round2,
  todayISO,
} from "../shared.js";

const ventureCreate = z.object({
  name: z.string().min(1).max(200),
  structure: z.enum(JV_STRUCTURES).default("joint_venture"),
  currency: currencySchema,
  formationDate: isoDateSchema.nullable().optional(),
  endDate: isoDateSchema.nullable().optional(),
  deedReference: z.string().max(200).nullable().optional(),
  registeredNumber: z.string().max(120).nullable().optional(),
  jurisdiction: z.string().max(120).nullable().optional(),
  quorumPercent: percentSchema.nullable().optional(),
  reservedMatterThresholdPercent: percentSchema.nullable().optional(),
  notes: z.string().max(8000).nullable().optional(),
});

const venturePatch = patchSchemaOf(ventureCreate.omit({ currency: true })).extend({
  status: z.enum(JV_STATUSES).optional(),
});

const partnerCreate = z.object({
  name: z.string().min(1).max(200),
  entityId: idSchema.nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  role: z.enum(JV_PARTNER_ROLES).default("partner"),
  sharePercent: percentSchema,
  committedCapital: nonNegativeMoneySchema.nullable().optional(),
  liabilityBasis: z.enum(JV_LIABILITY_BASES).default("joint_and_several"),
  isSelf: z.boolean().default(false),
  boardSeats: z.number().int().min(0).max(100).nullable().optional(),
  joinedAt: isoDateSchema.nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

const partnerPatch = patchSchemaOf(partnerCreate).extend({
  status: z.enum(["active", "withdrawn", "transferred"]).optional(),
  leftAt: isoDateSchema.nullable().optional(),
});

const transactionCreate = z.object({
  partnerId: idSchema,
  kind: z.enum(JV_TRANSACTION_KINDS),
  amount: z.number().finite().positive(),
  currency: currencySchema.optional(),
  dueDate: isoDateSchema.nullable().optional(),
  reference: z.string().max(120).nullable().optional(),
  description: z.string().max(4000).nullable().optional(),
});

const settleSchema = z.object({
  settledDate: isoDateSchema.optional(),
  reference: z.string().max(120).nullable().optional(),
});

const decisionCreate = z.object({
  reference: z.string().max(120).nullable().optional(),
  decisionType: z.enum(JV_DECISION_TYPES).default("ordinary"),
  meetingDate: isoDateSchema,
  subject: z.string().min(1).max(300),
  narrative: z.string().max(20000).nullable().optional(),
  deedClause: z.string().max(200).nullable().optional(),
  votes: z
    .array(
      z.object({
        partnerId: idSchema,
        vote: z.enum(["for", "against", "abstain"]),
      }),
    )
    .max(100)
    .default([]),
  /** an action the decision imposes, raised as an obligation */
  action: z
    .object({
      description: z.string().min(1).max(2000),
      dueDate: isoDateSchema,
    })
    .nullable()
    .optional(),
});

export const ventureRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate, adminGate, companyGate } = buildGates(app);

  async function fetchVenture(id: string, companyId: string, projectId: string) {
    const [row] = await app.db
      .select()
      .from(jointVentures)
      .where(
        and(
          eq(jointVentures.id, id),
          eq(jointVentures.companyId, companyId),
          eq(jointVentures.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Venture not found on this project");
    return row;
  }

  async function summaryFor(companyId: string, venture: typeof jointVentures.$inferSelect) {
    const partners = await loadPartners(app.db, companyId, venture.id);
    const transactions = await loadJvTransactions(app.db, companyId, venture.id);
    return venturePosition(partners, transactions, {
      currency: venture.currency,
      today: todayISO(),
    });
  }

  /* ================================================================ */
  /* Company-level read                                                */
  /* ================================================================ */

  app.get("/portfolio/ventures", { preHandler: companyGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        status: z.enum(JV_STATUSES).optional(),
        structure: z.enum(JV_STRUCTURES).optional(),
      })
      .parse(req.query);
    const visible = await visibleProjectIds(app.db, req.companyId!, req.user!.id, req.companyRole);
    const clauses: SQL[] = [eq(jointVentures.companyId, req.companyId!)];
    if (visible !== null) {
      if (visible.length === 0) return paginate([], 0, q);
      clauses.push(inArray(jointVentures.projectId, visible));
    }
    if (q.status) clauses.push(eq(jointVentures.status, q.status));
    if (q.structure) clauses.push(eq(jointVentures.structure, q.structure));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(jointVentures).where(where);
    const rows = await app.db
      .select()
      .from(jointVentures)
      .where(where)
      .orderBy(asc(jointVentures.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const projectRows = rows.length
      ? await app.db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(
            and(
              eq(projects.companyId, req.companyId!),
              inArray(
                projects.id,
                rows.map((r) => r.projectId).filter((p): p is string => p !== null),
              ),
            ),
          )
      : [];
    const nameOf = new Map(projectRows.map((p) => [p.id, p.name]));
    const items = await Promise.all(
      rows.map(async (v) => ({
        ...v,
        projectName: v.projectId ? (nameOf.get(v.projectId) ?? null) : null,
        summary: await summaryFor(req.companyId!, v),
      })),
    );
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /* ================================================================ */
  /* Ventures (#1057, #1060)                                           */
  /* ================================================================ */

  app.get("/projects/:projectId/portfolio/ventures", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.extend({ status: z.enum(JV_STATUSES).optional() }).parse(req.query);
    const clauses: SQL[] = [
      eq(jointVentures.companyId, req.companyId!),
      eq(jointVentures.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(jointVentures.status, q.status));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(jointVentures).where(where);
    const rows = await app.db
      .select()
      .from(jointVentures)
      .where(where)
      .orderBy(asc(jointVentures.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const items = await Promise.all(
      rows.map(async (v) => ({ ...v, summary: await summaryFor(req.companyId!, v) })),
    );
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post(
    "/projects/:projectId/portfolio/ventures",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = ventureCreate.parse(req.body);
      if (body.formationDate && body.endDate && body.endDate < body.formationDate) {
        throw badRequest("endDate must not precede formationDate");
      }
      const id = newId("jvt");
      await app.db.insert(jointVentures).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        name: body.name,
        structure: body.structure,
        currency: body.currency,
        formationDate: body.formationDate ?? null,
        endDate: body.endDate ?? null,
        deedReference: body.deedReference ?? null,
        registeredNumber: body.registeredNumber ?? null,
        jurisdiction: body.jurisdiction ?? null,
        quorumPercent: body.quorumPercent ?? null,
        reservedMatterThresholdPercent: body.reservedMatterThresholdPercent ?? null,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      });
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "joint_venture",
        objectId: id,
        payload: {
          name: body.name,
          structure: body.structure,
          currency: body.currency,
          deedReference: body.deedReference ?? null,
          quorumPercent: body.quorumPercent ?? null,
        },
        storePayload: true,
      });
      return reply.status(201).send(await fetchVenture(id, req.companyId!, req.projectId!));
    },
  );

  app.get(
    "/projects/:projectId/portfolio/ventures/:jvId",
    { preHandler: readGate },
    async (req) => {
      const { jvId } = req.params as { jvId: string };
      const venture = await fetchVenture(jvId, req.companyId!, req.projectId!);
      const partners = await app.db
        .select()
        .from(jvPartners)
        .where(and(eq(jvPartners.companyId, req.companyId!), eq(jvPartners.jvId, jvId)))
        .orderBy(desc(jvPartners.sharePercent), asc(jvPartners.name));
      const transactions = await app.db
        .select()
        .from(jvTransactions)
        .where(and(eq(jvTransactions.companyId, req.companyId!), eq(jvTransactions.jvId, jvId)))
        .orderBy(desc(jvTransactions.createdAt));
      const decisions = await app.db
        .select()
        .from(jvDecisions)
        .where(and(eq(jvDecisions.companyId, req.companyId!), eq(jvDecisions.jvId, jvId)))
        .orderBy(desc(jvDecisions.meetingDate));
      return {
        ...venture,
        partners,
        transactions,
        decisions,
        summary: await summaryFor(req.companyId!, venture),
      };
    },
  );

  app.patch(
    "/projects/:projectId/portfolio/ventures/:jvId",
    { preHandler: standardGate },
    async (req) => {
      const { jvId } = req.params as { jvId: string };
      const body = venturePatch.parse(req.body);
      const venture = await fetchVenture(jvId, req.companyId!, req.projectId!);
      if (venture.status === "dissolved") {
        throw conflict("A dissolved venture is a closed record and cannot be edited.");
      }
      await app.db
        .update(jointVentures)
        .set(patchSet(body as Record<string, unknown>))
        .where(eq(jointVentures.id, jvId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: body.status ? "state_change" : "update",
        objectType: "joint_venture",
        objectId: jvId,
        payload: {
          changed: Object.keys(body),
          status: body.status ? { from: venture.status, to: body.status } : undefined,
        },
        storePayload: Boolean(body.status),
      });
      return fetchVenture(jvId, req.companyId!, req.projectId!);
    },
  );

  /* ================================================================ */
  /* Partners (#1057)                                                  */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/portfolio/ventures/:jvId/partners",
    { preHandler: standardGate },
    async (req, reply) => {
      const { jvId } = req.params as { jvId: string };
      const body = partnerCreate.parse(req.body);
      await fetchVenture(jvId, req.companyId!, req.projectId!);
      if (body.vendorId) {
        const [vendor] = await app.db
          .select({ id: vendors.id })
          .from(vendors)
          .where(and(eq(vendors.id, body.vendorId), eq(vendors.companyId, req.companyId!)))
          .limit(1);
        if (!vendor) throw badRequest("vendorId does not name a vendor in this company");
      }
      if (body.isSelf) {
        const [existing] = await app.db
          .select({ id: jvPartners.id, name: jvPartners.name })
          .from(jvPartners)
          .where(
            and(
              eq(jvPartners.companyId, req.companyId!),
              eq(jvPartners.jvId, jvId),
              eq(jvPartners.isSelf, 1),
            ),
          )
          .limit(1);
        if (existing) {
          throw conflict(
            `"${existing.name}" is already recorded as this company's own participation; a venture has one "our share".`,
          );
        }
      }
      const id = newId("jvp");
      await app.db.insert(jvPartners).values({
        id,
        companyId: req.companyId!,
        jvId,
        name: body.name,
        entityId: body.entityId ?? null,
        vendorId: body.vendorId ?? null,
        role: body.role,
        sharePercent: body.sharePercent,
        committedCapital: body.committedCapital ?? null,
        liabilityBasis: body.liabilityBasis,
        isSelf: body.isSelf ? 1 : 0,
        boardSeats: body.boardSeats ?? null,
        joinedAt: body.joinedAt ?? null,
        notes: body.notes ?? null,
      });
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "jv_partner",
        objectId: id,
        payload: {
          jvId,
          name: body.name,
          sharePercent: body.sharePercent,
          liabilityBasis: body.liabilityBasis,
          isSelf: body.isSelf,
        },
        storePayload: true,
      });
      const venture = await fetchVenture(jvId, req.companyId!, req.projectId!);
      const summary = await summaryFor(req.companyId!, venture);
      const [row] = await app.db.select().from(jvPartners).where(eq(jvPartners.id, id)).limit(1);
      return reply.status(201).send({ partner: row, summary });
    },
  );

  app.patch(
    "/projects/:projectId/portfolio/ventures/:jvId/partners/:partnerId",
    { preHandler: standardGate },
    async (req) => {
      const { jvId, partnerId } = req.params as { jvId: string; partnerId: string };
      const body = partnerPatch.parse(req.body);
      const venture = await fetchVenture(jvId, req.companyId!, req.projectId!);
      const [partner] = await app.db
        .select()
        .from(jvPartners)
        .where(
          and(
            eq(jvPartners.id, partnerId),
            eq(jvPartners.companyId, req.companyId!),
            eq(jvPartners.jvId, jvId),
          ),
        )
        .limit(1);
      if (!partner) throw notFound("Partner not found in this venture");
      const set = patchSet(body as Record<string, unknown>);
      if (body.isSelf !== undefined) set["isSelf"] = body.isSelf ? 1 : 0;
      await app.db.update(jvPartners).set(set).where(eq(jvPartners.id, partnerId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "jv_partner",
        objectId: partnerId,
        payload: {
          jvId,
          changed: Object.keys(body),
          sharePercent:
            body.sharePercent !== undefined
              ? { from: partner.sharePercent, to: body.sharePercent }
              : undefined,
        },
        storePayload: body.sharePercent !== undefined,
      });
      const [row] = await app.db.select().from(jvPartners).where(eq(jvPartners.id, partnerId)).limit(1);
      return { partner: row, summary: await summaryFor(req.companyId!, venture) };
    },
  );

  app.delete(
    "/projects/:projectId/portfolio/ventures/:jvId/partners/:partnerId",
    { preHandler: adminGate },
    async (req, reply) => {
      const { jvId, partnerId } = req.params as { jvId: string; partnerId: string };
      await fetchVenture(jvId, req.companyId!, req.projectId!);
      const [partner] = await app.db
        .select()
        .from(jvPartners)
        .where(
          and(
            eq(jvPartners.id, partnerId),
            eq(jvPartners.companyId, req.companyId!),
            eq(jvPartners.jvId, jvId),
          ),
        )
        .limit(1);
      if (!partner) throw notFound("Partner not found in this venture");
      const [used] = await app.db
        .select({ n: count() })
        .from(jvTransactions)
        .where(
          and(eq(jvTransactions.companyId, req.companyId!), eq(jvTransactions.partnerId, partnerId)),
        );
      if (Number(used?.n ?? 0) > 0) {
        throw conflict(
          `${used?.n} transaction(s) are recorded against this partner. Mark them withdrawn instead; deleting the partner would orphan the money.`,
        );
      }
      await app.db.delete(jvPartners).where(eq(jvPartners.id, partnerId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "jv_partner",
        objectId: partnerId,
        payload: { jvId, name: partner.name, sharePercent: partner.sharePercent },
        storePayload: true,
      });
      return reply.status(204).send();
    },
  );

  /* ================================================================ */
  /* Transactions (#1059)                                              */
  /* ================================================================ */

  async function fetchTransaction(id: string, companyId: string, jvId: string) {
    const [row] = await app.db
      .select()
      .from(jvTransactions)
      .where(
        and(
          eq(jvTransactions.id, id),
          eq(jvTransactions.companyId, companyId),
          eq(jvTransactions.jvId, jvId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Transaction not found in this venture");
    return row;
  }

  app.post(
    "/projects/:projectId/portfolio/ventures/:jvId/transactions",
    { preHandler: standardGate },
    async (req, reply) => {
      const { jvId } = req.params as { jvId: string };
      const body = transactionCreate.parse(req.body);
      const venture = await fetchVenture(jvId, req.companyId!, req.projectId!);
      const currency = body.currency ?? venture.currency;
      const [partner] = await app.db
        .select()
        .from(jvPartners)
        .where(
          and(
            eq(jvPartners.id, body.partnerId),
            eq(jvPartners.companyId, req.companyId!),
            eq(jvPartners.jvId, jvId),
          ),
        )
        .limit(1);
      if (!partner) throw badRequest("partnerId does not name a partner in this venture");
      const id = newId("jvx");
      await app.db.insert(jvTransactions).values({
        id,
        companyId: req.companyId!,
        jvId,
        partnerId: body.partnerId,
        kind: body.kind,
        currency,
        amount: body.amount,
        dueDate: body.dueDate ?? null,
        reference: body.reference ?? null,
        description: body.description ?? null,
        createdBy: req.user!.id,
      });
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "jv_transaction",
        objectId: id,
        payload: {
          jvId,
          partnerId: body.partnerId,
          partnerName: partner.name,
          kind: body.kind,
          amount: body.amount,
          currency,
          dueDate: body.dueDate ?? null,
        },
        storePayload: true,
      });
      return reply.status(201).send(await fetchTransaction(id, req.companyId!, jvId));
    },
  );

  /**
   * Call a planned contribution (#1059). The call carries a deadline, so it
   * becomes an Obligation — the same object every other deadline on the
   * platform is, which is what lets the sweep breach it and the attention
   * feed rank it.
   */
  app.post(
    "/projects/:projectId/portfolio/ventures/:jvId/transactions/:txId/call",
    { preHandler: standardGate },
    async (req) => {
      const { jvId, txId } = req.params as { jvId: string; txId: string };
      const body = z
        .object({ dueDate: isoDateSchema.optional(), note: z.string().max(2000).nullable().optional() })
        .parse(req.body ?? {});
      const venture = await fetchVenture(jvId, req.companyId!, req.projectId!);
      const tx = await fetchTransaction(txId, req.companyId!, jvId);
      if (tx.status !== "planned") {
        throw conflict(`This transaction is ${tx.status}; only a planned one can be called.`);
      }
      const dueDate = body.dueDate ?? tx.dueDate;
      if (!dueDate) {
        throw badRequest("A capital call needs a due date; a call with no deadline cannot be breached or enforced.");
      }
      const [partner] = await app.db
        .select({ name: jvPartners.name })
        .from(jvPartners)
        .where(eq(jvPartners.id, tx.partnerId))
        .limit(1);
      const obligationId = await createObligation(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        sourceClause: venture.deedReference
          ? `${venture.deedReference} — partner contributions`
          : `${venture.name} joint venture deed — partner contributions`,
        trigger: `${(partner?.name ?? "Partner")} to settle a ${tx.kind.replace(/_/g, " ")} of ${tx.amount} ${tx.currency}`,
        deadline: `${dueDate}T23:59:59.000Z`,
        warnDaysBefore: 7,
        evidenceRequirement: "Bank confirmation or receipt of the partner's payment into the venture account",
        createdBy: req.user!.id,
      });
      await app.db
        .update(jvTransactions)
        .set({ status: "called", dueDate, obligationId, updatedAt: nowISO() })
        .where(and(eq(jvTransactions.id, txId), eq(jvTransactions.status, "planned")));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "jv_transaction",
        objectId: txId,
        payload: {
          from: "planned",
          to: "called",
          dueDate,
          obligationId,
          amount: tx.amount,
          currency: tx.currency,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      return { ...(await fetchTransaction(txId, req.companyId!, jvId)), obligationId };
    },
  );

  /**
   * Settle a called contribution or a distribution. A money move: the row is
   * locked, and the person who recorded the call may not be the person who
   * confirms it was paid.
   */
  app.post(
    "/projects/:projectId/portfolio/ventures/:jvId/transactions/:txId/settle",
    { preHandler: standardGate },
    async (req) => {
      const { jvId, txId } = req.params as { jvId: string; txId: string };
      const body = settleSchema.parse(req.body ?? {});
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      await fetchVenture(jvId, companyId, projectId);

      const settled = await app.db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(jvTransactions)
          .where(
            and(
              eq(jvTransactions.id, txId),
              eq(jvTransactions.companyId, companyId),
              eq(jvTransactions.jvId, jvId),
            ),
          )
          .for("update");
        if (!locked) throw notFound("Transaction not found in this venture");
        if (locked.status === "paid") throw conflict("This transaction has already been settled.");
        if (locked.status === "cancelled" || locked.status === "waived") {
          throw conflict(`This transaction is ${locked.status} and cannot be settled.`);
        }
        if (locked.createdBy === req.user!.id) {
          throw forbidden(
            "The person who recorded this transaction cannot confirm it was settled; a movement of money needs a second pair of eyes.",
          );
        }
        await tx
          .update(jvTransactions)
          .set({
            status: "paid",
            settledDate: body.settledDate ?? todayISO(),
            reference: body.reference ?? locked.reference,
            updatedAt: nowISO(),
          })
          .where(eq(jvTransactions.id, txId));
        return locked;
      });

      /* Settling discharges the obligation the call created — from either
         `open` or `breached`, because a late payment still performs. */
      await setObligationStatus(app.db, settled.obligationId, "open", "satisfied");
      await setObligationStatus(app.db, settled.obligationId, "breached", "satisfied");
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "jv_transaction",
        objectId: txId,
        payload: {
          from: settled.status,
          to: "paid",
          amount: settled.amount,
          currency: settled.currency,
          settledDate: body.settledDate ?? todayISO(),
          obligationId: settled.obligationId,
        },
        storePayload: true,
      });
      return fetchTransaction(txId, companyId, jvId);
    },
  );

  app.post(
    "/projects/:projectId/portfolio/ventures/:jvId/transactions/:txId/waive",
    { preHandler: adminGate },
    async (req) => {
      const { jvId, txId } = req.params as { jvId: string; txId: string };
      const body = z
        .object({
          reason: z.string().min(1).max(4000),
          outcome: z.enum(["waived", "cancelled"]).default("waived"),
        })
        .parse(req.body);
      await fetchVenture(jvId, req.companyId!, req.projectId!);
      const tx = await fetchTransaction(txId, req.companyId!, jvId);
      if (tx.status === "paid") throw conflict("A settled transaction cannot be waived.");
      await app.db
        .update(jvTransactions)
        .set({
          status: body.outcome,
          description: `${tx.description ?? ""}\n[${body.outcome}] ${body.reason}`.trim(),
          updatedAt: nowISO(),
        })
        .where(eq(jvTransactions.id, txId));
      await setObligationStatus(app.db, tx.obligationId, "open", "waived");
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "jv_transaction",
        objectId: txId,
        payload: {
          from: tx.status,
          to: body.outcome,
          reason: body.reason,
          amount: tx.amount,
          currency: tx.currency,
        },
        storePayload: true,
      });
      return fetchTransaction(txId, req.companyId!, jvId);
    },
  );

  app.get(
    "/projects/:projectId/portfolio/ventures/:jvId/transactions",
    { preHandler: readGate },
    async (req) => {
      const { jvId } = req.params as { jvId: string };
      const q = pageQuerySchema
        .extend({
          status: z.enum(JV_TRANSACTION_STATUSES).optional(),
          kind: z.enum(JV_TRANSACTION_KINDS).optional(),
          partnerId: idSchema.optional(),
        })
        .parse(req.query);
      await fetchVenture(jvId, req.companyId!, req.projectId!);
      const clauses: SQL[] = [
        eq(jvTransactions.companyId, req.companyId!),
        eq(jvTransactions.jvId, jvId),
      ];
      if (q.status) clauses.push(eq(jvTransactions.status, q.status));
      if (q.kind) clauses.push(eq(jvTransactions.kind, q.kind));
      if (q.partnerId) clauses.push(eq(jvTransactions.partnerId, q.partnerId));
      const where = and(...clauses);
      const [totalRow] = await app.db.select({ n: count() }).from(jvTransactions).where(where);
      const items = await app.db
        .select()
        .from(jvTransactions)
        .where(where)
        .orderBy(desc(jvTransactions.createdAt))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(items, Number(totalRow?.n ?? 0), q);
    },
  );

  /* ================================================================ */
  /* Governance decisions (#1058)                                      */
  /* ================================================================ */

  /** Compute an outcome from a draft vote without recording anything. */
  app.post(
    "/projects/:projectId/portfolio/ventures/:jvId/decisions/preview",
    { preHandler: readGate },
    async (req) => {
      const { jvId } = req.params as { jvId: string };
      const body = decisionCreate
        .pick({ decisionType: true, votes: true })
        .parse(req.body ?? { votes: [] });
      const venture = await fetchVenture(jvId, req.companyId!, req.projectId!);
      const partners = await loadPartners(app.db, req.companyId!, jvId);
      return decideVote(partners, body.votes as VoteRow[], {
        quorumPercent: venture.quorumPercent,
        thresholdPercent:
          body.decisionType === "reserved_matter"
            ? venture.reservedMatterThresholdPercent
            : null,
        decisionType: body.decisionType,
      });
    },
  );

  app.post(
    "/projects/:projectId/portfolio/ventures/:jvId/decisions",
    { preHandler: standardGate },
    async (req, reply) => {
      const { jvId } = req.params as { jvId: string };
      const body = decisionCreate.parse(req.body);
      const venture = await fetchVenture(jvId, req.companyId!, req.projectId!);
      const partners = await loadPartners(app.db, req.companyId!, jvId);
      if (partners.length === 0) {
        throw badRequest(
          "This venture has no partners on the register, so no vote can be weighed. Record the partners and their shares first.",
        );
      }
      const votes: VoteRow[] = body.votes.map((v) => ({
        partnerId: v.partnerId,
        vote: v.vote as VoteValue,
      }));
      const outcome = decideVote(partners, votes, {
        quorumPercent: venture.quorumPercent,
        thresholdPercent:
          body.decisionType === "reserved_matter" ? venture.reservedMatterThresholdPercent : null,
        decisionType: body.decisionType,
      });

      let obligationId: string | null = null;
      if (body.action && outcome.outcome === "approved") {
        obligationId = await createObligation(app.db, {
          companyId: req.companyId!,
          projectId: req.projectId!,
          sourceClause: body.deedClause
            ? `${venture.name} deed ${body.deedClause}`
            : `${venture.name} board decision`,
          trigger: body.action.description,
          deadline: `${body.action.dueDate}T23:59:59.000Z`,
          warnDaysBefore: 7,
          evidenceRequirement: "Evidence that the action the board resolved on has been carried out",
          createdBy: req.user!.id,
        });
      }

      const id = newId("jvd");
      await app.db.insert(jvDecisions).values({
        id,
        companyId: req.companyId!,
        jvId,
        reference: body.reference ?? null,
        decisionType: body.decisionType,
        meetingDate: body.meetingDate,
        subject: body.subject,
        narrative: body.narrative ?? null,
        deedClause: body.deedClause ?? null,
        votes: body.votes.map((v) => ({
          ...v,
          sharePercent: partners.find((p) => p.id === v.partnerId)?.sharePercent ?? null,
        })),
        sharePresentPercent: outcome.sharePresentPercent,
        shareForPercent: outcome.shareForPercent,
        quorumMet: outcome.quorumMet ? 1 : 0,
        thresholdMet: outcome.thresholdMet ? 1 : 0,
        outcome: outcome.outcome,
        obligationId,
        recordedBy: req.user!.id,
      });
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "jv_decision",
        objectId: id,
        payload: {
          jvId,
          subject: body.subject,
          decisionType: body.decisionType,
          outcome: outcome.outcome,
          sharePresentPercent: outcome.sharePresentPercent,
          shareForPercent: outcome.shareForPercent,
          quorumMet: outcome.quorumMet,
          thresholdMet: outcome.thresholdMet,
          thresholdPercent: outcome.thresholdPercent,
          obligationId,
        },
        storePayload: true,
      });

      /* A reserved matter that failed for want of quorum is worth telling
         someone about: it is a governance failure, not a decision. */
      if (outcome.outcome === "not_quorate") {
        await pushNotifications(app.db, [
          {
            companyId: req.companyId!,
            userId: req.user!.id,
            projectId: req.projectId!,
            kind: "portfolio",
            title: `Board vote not quorate: ${body.subject}`,
            body: `${outcome.sharePresentPercent}% of shares were present; the deed requires ${outcome.quorumPercent ?? 0}%.`,
            recordType: "jv_decision",
            recordId: id,
          },
        ]);
      }

      const [row] = await app.db.select().from(jvDecisions).where(eq(jvDecisions.id, id)).limit(1);
      return reply.status(201).send({ decision: row, computed: outcome });
    },
  );

  app.get(
    "/projects/:projectId/portfolio/ventures/:jvId/decisions",
    { preHandler: readGate },
    async (req) => {
      const { jvId } = req.params as { jvId: string };
      const q = pageQuerySchema
        .extend({
          outcome: z.enum(JV_DECISION_OUTCOMES).optional(),
          decisionType: z.enum(JV_DECISION_TYPES).optional(),
        })
        .parse(req.query);
      await fetchVenture(jvId, req.companyId!, req.projectId!);
      const clauses: SQL[] = [eq(jvDecisions.companyId, req.companyId!), eq(jvDecisions.jvId, jvId)];
      if (q.outcome) clauses.push(eq(jvDecisions.outcome, q.outcome));
      if (q.decisionType) clauses.push(eq(jvDecisions.decisionType, q.decisionType));
      const where = and(...clauses);
      const [totalRow] = await app.db.select({ n: count() }).from(jvDecisions).where(where);
      const rows = await app.db
        .select()
        .from(jvDecisions)
        .where(where)
        .orderBy(desc(jvDecisions.meetingDate))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      const obligationIds = rows
        .map((r) => r.obligationId)
        .filter((o): o is string => o !== null);
      const obligationRows = obligationIds.length
        ? await app.db
            .select({ id: obligations.id, status: obligations.status, deadline: obligations.deadline })
            .from(obligations)
            .where(
              and(
                eq(obligations.companyId, req.companyId!),
                inArray(obligations.id, obligationIds),
                isNotNull(obligations.id),
              ),
            )
        : [];
      const obligationOf = new Map(obligationRows.map((o) => [o.id, o]));
      return paginate(
        rows.map((r) => ({
          ...r,
          obligation: r.obligationId ? (obligationOf.get(r.obligationId) ?? null) : null,
        })),
        Number(totalRow?.n ?? 0),
        q,
      );
    },
  );

  /** The venture position on its own — the number an owner actually needs. */
  app.get(
    "/projects/:projectId/portfolio/ventures/:jvId/position",
    { preHandler: readGate },
    async (req) => {
      const { jvId } = req.params as { jvId: string };
      const venture = await fetchVenture(jvId, req.companyId!, req.projectId!);
      const summary = await summaryFor(req.companyId!, venture);
      return {
        jvId,
        name: venture.name,
        structure: venture.structure,
        status: venture.status,
        ...summary,
        ourShareOfContributions:
          summary.ourSharePercent === null
            ? null
            : round2((summary.ourSharePercent / 100) * summary.totalContributed),
      };
    },
  );
};
