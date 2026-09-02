/**
 * OPEN-BOOK COST VERIFICATION, DEFINED COST, DISALLOWED COST, AUDIT RIGHTS.
 * Spec Vol II Domain Z #1063 (open-book cost verification and audit), #1064
 * (cost-reimbursable audit rights execution), #1065 (defined cost verified
 * against the Schedule of Cost Components), #1066 (disallowed cost register).
 *
 * Project-scoped: a verification tests one project's claimed defined cost.
 *
 * This is the part of the module where the assurance thesis bites hardest,
 * so the rules are strict and the refusals say why:
 *
 *  · THE CLAIM AND THE TEST ARE NOT THE SAME ACT. Whoever recorded a claimed
 *    cost item cannot be the person who marks it verified. An assertion tested
 *    by its own author is not evidence of anything.
 *  · A DISALLOWANCE NEEDS A GROUND. The register refuses a disallowed cost
 *    with no category, and a disallowance with no contract clause is flagged
 *    on every read — it is an opinion, and it will not survive adjudication.
 *  · A RESPONSE DEADLINE IS AN OBLIGATION. Raising a disallowance with a
 *    response date creates one, so the sweep can breach it like any other.
 *  · AN EXTRAPOLATION IS A PROJECTION, NOT A FINDING, and the response says so
 *    in those words, with the sample and population it rests on.
 *  · Header totals are materialised from the items on every item write, so the
 *    register is never showing a number the items no longer support.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  auditRightsExecutions,
  definedCostItems,
  disallowedCosts,
  openBookVerifications,
  targetCostContracts,
} from "@constructos/db";
import {
  AUDIT_RIGHTS_STATUSES,
  DEFINED_COST_COMPONENTS,
  DEFINED_COST_VERDICTS,
  DISALLOWED_COST_CATEGORIES,
  DISALLOWED_COST_STATUSES,
  OPEN_BOOK_STATUSES,
} from "@constructos/shared";
import { badRequest, conflict, forbidden, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { nextRecordNumber } from "../../../lib/numbering.js";
import {
  disallowedSummary,
  extrapolate,
  verificationTotals,
  type DefinedCostItemRow,
  type DisallowedRow,
} from "../openbook.js";
import { createObligation, recomputeVerification, setObligationStatus } from "../service.js";
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
  pad3,
  round2,
  todayISO,
} from "../shared.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const samplingSchema = z.object({
  basis: z.string().max(500).optional(),
  populationCount: z.number().int().nonnegative().optional(),
  populationValue: z.number().finite().nonnegative().optional(),
  sampleCount: z.number().int().nonnegative().optional(),
  confidence: z.number().finite().min(0).max(100).optional(),
});

const verificationCreate = z.object({
  title: z.string().min(1).max(200),
  targetCostId: idSchema.nullable().optional(),
  periodStart: isoDateSchema.nullable().optional(),
  periodEnd: isoDateSchema.nullable().optional(),
  currency: currencySchema,
  claimedAmount: nonNegativeMoneySchema.default(0),
  auditRightsClause: z.string().max(200).nullable().optional(),
  componentMapping: z.record(z.string().max(120), z.string().max(120)).optional(),
  methodology: z.string().max(20000).nullable().optional(),
  sampling: samplingSchema.optional(),
  verifierId: idSchema.nullable().optional(),
  verifierName: z.string().max(200).nullable().optional(),
  plannedAt: isoDateSchema.nullable().optional(),
});

const verificationPatch = patchSchemaOf(verificationCreate.omit({ currency: true }));

const itemCreate = z.object({
  component: z.enum(DEFINED_COST_COMPONENTS),
  contractHeading: z.string().max(200).nullable().optional(),
  description: z.string().min(1).max(1000),
  currency: currencySchema.optional(),
  claimedAmount: nonNegativeMoneySchema,
  evidenceRef: z.string().max(500).nullable().optional(),
  evidenceId: idSchema.nullable().optional(),
  sourceType: z.string().max(60).nullable().optional(),
  sourceId: idSchema.nullable().optional(),
});

const itemPatch = z.object({
  component: z.enum(DEFINED_COST_COMPONENTS).optional(),
  contractHeading: z.string().max(200).nullable().optional(),
  description: z.string().min(1).max(1000).optional(),
  claimedAmount: nonNegativeMoneySchema.optional(),
  evidenceRef: z.string().max(500).nullable().optional(),
  evidenceId: idSchema.nullable().optional(),
});

const verdictSchema = z.object({
  verdict: z.enum(DEFINED_COST_VERDICTS),
  verifiedAmount: nonNegativeMoneySchema.optional(),
  verifierNote: z.string().max(8000).nullable().optional(),
  /** raise a disallowance for the difference, with its ground */
  disallowance: z
    .object({
      category: z.enum(DISALLOWED_COST_CATEGORIES),
      groundClause: z.string().max(200).nullable().optional(),
      responseDueAt: isoDateSchema.nullable().optional(),
      description: z.string().max(1000).optional(),
    })
    .nullable()
    .optional(),
});

const disallowedCreate = z.object({
  description: z.string().min(1).max(1000),
  category: z.enum(DISALLOWED_COST_CATEGORIES),
  groundClause: z.string().max(200).nullable().optional(),
  currency: currencySchema,
  amount: z.number().finite().positive(),
  verificationId: idSchema.nullable().optional(),
  definedCostItemId: idSchema.nullable().optional(),
  raisedAt: isoDateSchema.optional(),
  responseDueAt: isoDateSchema.nullable().optional(),
});

const auditCreate = z.object({
  reference: z.string().min(1).max(80),
  subjectType: z.enum(["commitment", "framework", "term_contract", "jv", "project"]).default("commitment"),
  subjectId: idSchema.nullable().optional(),
  subjectName: z.string().min(1).max(200),
  contractReference: z.string().max(200).nullable().optional(),
  clause: z.string().max(200).nullable().optional(),
  scope: z.string().min(1).max(8000),
  auditorName: z.string().max(200).nullable().optional(),
  auditorUserId: idSchema.nullable().optional(),
  verificationId: idSchema.nullable().optional(),
  noticeDate: isoDateSchema.optional(),
  noticeDays: z.number().int().min(0).max(365).nullable().optional(),
  scheduledDate: isoDateSchema.nullable().optional(),
  recordsRequested: z
    .array(
      z.object({
        id: z.string().max(64).optional(),
        description: z.string().min(1).max(1000),
        requestedAt: isoDateSchema.optional(),
        providedAt: isoDateSchema.nullable().optional(),
        refused: z.boolean().optional(),
        note: z.string().max(2000).nullable().optional(),
      }),
    )
    .max(500)
    .optional(),
});

const auditPatch = patchSchemaOf(auditCreate.omit({ reference: true }));

export const openBookRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate, adminGate } = buildGates(app);

  async function fetchVerification(id: string, companyId: string, projectId: string) {
    const [row] = await app.db
      .select()
      .from(openBookVerifications)
      .where(
        and(
          eq(openBookVerifications.id, id),
          eq(openBookVerifications.companyId, companyId),
          eq(openBookVerifications.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Open-book verification not found on this project");
    return row;
  }

  async function itemsOf(companyId: string, verificationId: string): Promise<DefinedCostItemRow[]> {
    const rows = await app.db
      .select()
      .from(definedCostItems)
      .where(
        and(
          eq(definedCostItems.companyId, companyId),
          eq(definedCostItems.verificationId, verificationId),
        ),
      );
    return rows.map((i) => ({
      id: i.id,
      component: i.component,
      currency: i.currency,
      claimedAmount: i.claimedAmount,
      verifiedAmount: i.verifiedAmount,
      verdict: i.verdict,
      evidenceRef: i.evidenceRef,
      evidenceId: i.evidenceId,
    }));
  }

  /* ================================================================ */
  /* Verifications (#1063)                                             */
  /* ================================================================ */

  app.get(
    "/projects/:projectId/portfolio/verifications",
    { preHandler: readGate },
    async (req) => {
      const q = pageQuerySchema
        .extend({ status: z.enum(OPEN_BOOK_STATUSES).optional(), targetCostId: idSchema.optional() })
        .parse(req.query);
      const clauses: SQL[] = [
        eq(openBookVerifications.companyId, req.companyId!),
        eq(openBookVerifications.projectId, req.projectId!),
      ];
      if (q.status) clauses.push(eq(openBookVerifications.status, q.status));
      if (q.targetCostId) clauses.push(eq(openBookVerifications.targetCostId, q.targetCostId));
      const where = and(...clauses);
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(openBookVerifications)
        .where(where);
      const items = await app.db
        .select()
        .from(openBookVerifications)
        .where(where)
        .orderBy(desc(openBookVerifications.number))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(
        items.map((v) => ({
          ...v,
          untestedAmount: round2(
            v.claimedAmount - (v.verifiedAmount + v.queriedAmount + v.disallowedAmount + v.pendingAmount),
          ),
        })),
        Number(totalRow?.n ?? 0),
        q,
      );
    },
  );

  app.post(
    "/projects/:projectId/portfolio/verifications",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = verificationCreate.parse(req.body);
      if (body.periodStart && body.periodEnd && body.periodEnd < body.periodStart) {
        throw badRequest("periodEnd must not precede periodStart");
      }
      if (body.targetCostId) {
        const [tc] = await app.db
          .select({ id: targetCostContracts.id, currency: targetCostContracts.currency })
          .from(targetCostContracts)
          .where(
            and(
              eq(targetCostContracts.id, body.targetCostId),
              eq(targetCostContracts.companyId, req.companyId!),
              eq(targetCostContracts.projectId, req.projectId!),
            ),
          )
          .limit(1);
        if (!tc) throw badRequest("targetCostId does not name a target-cost contract on this project");
        if (tc.currency !== body.currency) {
          throw badRequest(
            `The verification is in ${body.currency} but the target-cost contract is in ${tc.currency}; the verified cost could not feed the pain/gain calculation.`,
          );
        }
      }
      const number = await nextRecordNumber(app.db, req.projectId!, "open_book_verification");
      const id = newId("obv");
      await app.db.insert(openBookVerifications).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        reference: `OB-${pad3(number)}`,
        title: body.title,
        targetCostId: body.targetCostId ?? null,
        periodStart: body.periodStart ?? null,
        periodEnd: body.periodEnd ?? null,
        currency: body.currency,
        claimedAmount: body.claimedAmount,
        auditRightsClause: body.auditRightsClause ?? null,
        componentMapping: body.componentMapping ?? {},
        methodology: body.methodology ?? null,
        sampling: body.sampling ?? {},
        verifierId: body.verifierId ?? null,
        verifierName: body.verifierName ?? null,
        plannedAt: body.plannedAt ?? null,
        createdBy: req.user!.id,
      });
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "open_book_verification",
        objectId: id,
        payload: {
          reference: `OB-${pad3(number)}`,
          claimedAmount: body.claimedAmount,
          currency: body.currency,
          plannedAt: body.plannedAt ?? null,
          targetCostId: body.targetCostId ?? null,
        },
        storePayload: true,
      });
      return reply.status(201).send(await fetchVerification(id, req.companyId!, req.projectId!));
    },
  );

  app.get(
    "/projects/:projectId/portfolio/verifications/:verificationId",
    { preHandler: readGate },
    async (req) => {
      const { verificationId } = req.params as { verificationId: string };
      const row = await fetchVerification(verificationId, req.companyId!, req.projectId!);
      const items = await app.db
        .select()
        .from(definedCostItems)
        .where(
          and(
            eq(definedCostItems.companyId, req.companyId!),
            eq(definedCostItems.verificationId, verificationId),
          ),
        )
        .orderBy(asc(definedCostItems.component), desc(definedCostItems.claimedAmount));
      const totals = verificationTotals(
        items.map((i) => ({
          id: i.id,
          component: i.component,
          currency: i.currency,
          claimedAmount: i.claimedAmount,
          verifiedAmount: i.verifiedAmount,
          verdict: i.verdict,
          evidenceRef: i.evidenceRef,
          evidenceId: i.evidenceId,
        })),
        row.currency,
      );
      const disallowed = await app.db
        .select()
        .from(disallowedCosts)
        .where(
          and(
            eq(disallowedCosts.companyId, req.companyId!),
            eq(disallowedCosts.verificationId, verificationId),
          ),
        )
        .orderBy(desc(disallowedCosts.number));
      const audits = await app.db
        .select()
        .from(auditRightsExecutions)
        .where(
          and(
            eq(auditRightsExecutions.companyId, req.companyId!),
            eq(auditRightsExecutions.verificationId, verificationId),
          ),
        );
      const sampling = (row.sampling ?? {}) as Record<string, unknown>;
      return {
        ...row,
        items,
        totals,
        disallowed,
        auditRightsExecutions: audits,
        extrapolation: extrapolate(totals, {
          basis: typeof sampling["basis"] === "string" ? sampling["basis"] : undefined,
          populationCount:
            typeof sampling["populationCount"] === "number" ? sampling["populationCount"] : undefined,
          populationValue:
            typeof sampling["populationValue"] === "number" ? sampling["populationValue"] : undefined,
          sampleCount:
            typeof sampling["sampleCount"] === "number" ? sampling["sampleCount"] : undefined,
          confidence: typeof sampling["confidence"] === "number" ? sampling["confidence"] : undefined,
        }),
        /* Claimed on the header versus claimed on the items: a gap means the
           exercise has not yet touched everything it says it is testing. */
        untestedAmount: round2(row.claimedAmount - totals.claimed),
      };
    },
  );

  app.patch(
    "/projects/:projectId/portfolio/verifications/:verificationId",
    { preHandler: standardGate },
    async (req) => {
      const { verificationId } = req.params as { verificationId: string };
      const body = verificationPatch.parse(req.body);
      const row = await fetchVerification(verificationId, req.companyId!, req.projectId!);
      if (row.status === "closed") {
        throw conflict("A closed verification is a settled record and cannot be edited.");
      }
      await app.db
        .update(openBookVerifications)
        .set(patchSet(body as Record<string, unknown>))
        .where(eq(openBookVerifications.id, verificationId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "open_book_verification",
        objectId: verificationId,
        payload: { changed: Object.keys(body) },
      });
      return fetchVerification(verificationId, req.companyId!, req.projectId!);
    },
  );

  const verificationStatus = z.object({
    status: z.enum(OPEN_BOOK_STATUSES),
    findings: z.string().max(20000).nullable().optional(),
  });

  app.post(
    "/projects/:projectId/portfolio/verifications/:verificationId/status",
    { preHandler: standardGate },
    async (req) => {
      const { verificationId } = req.params as { verificationId: string };
      const body = verificationStatus.parse(req.body);
      const row = await fetchVerification(verificationId, req.companyId!, req.projectId!);
      if (row.status === body.status) return row;
      if (row.status === "closed") throw conflict("A closed verification cannot be reopened.");
      if (body.status === "reported") {
        const rows = await itemsOf(req.companyId!, verificationId);
        if (rows.length === 0) {
          throw conflict(
            "A verification with no defined cost items tested has nothing to report; add the items the exercise examined.",
          );
        }
        const totals = verificationTotals(rows, row.currency);
        if (totals.pending > 0.005) {
          throw conflict(
            `${totals.pending} ${row.currency} of tested cost is still pending a verdict; a report that leaves items untested overstates what was verified.`,
          );
        }
        if (!body.findings) {
          throw badRequest("A reported verification must record its findings.");
        }
      }
      const set: Record<string, unknown> = { status: body.status, updatedAt: nowISO() };
      if (body.findings !== undefined) set["findings"] = body.findings;
      if (body.status === "reported") set["reportedAt"] = nowISO();
      await app.db
        .update(openBookVerifications)
        .set(set)
        .where(eq(openBookVerifications.id, verificationId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "open_book_verification",
        objectId: verificationId,
        payload: {
          from: row.status,
          to: body.status,
          verified: row.verifiedAmount,
          disallowed: row.disallowedAmount,
          currency: row.currency,
        },
        storePayload: true,
      });
      return fetchVerification(verificationId, req.companyId!, req.projectId!);
    },
  );

  /* ================================================================ */
  /* Defined cost items (#1065)                                        */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/portfolio/verifications/:verificationId/items",
    { preHandler: standardGate },
    async (req, reply) => {
      const { verificationId } = req.params as { verificationId: string };
      const body = z
        .union([itemCreate, z.object({ items: z.array(itemCreate).min(1).max(500) })])
        .parse(req.body);
      const verification = await fetchVerification(verificationId, req.companyId!, req.projectId!);
      if (verification.status === "closed" || verification.status === "reported") {
        throw conflict(
          `Verification ${verification.reference} is ${verification.status}; items cannot be added to a concluded exercise.`,
        );
      }
      const list = "items" in body ? body.items : [body];
      const ids: string[] = [];
      for (const item of list) {
        const id = newId("dci");
        ids.push(id);
        await app.db.insert(definedCostItems).values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          verificationId,
          component: item.component,
          contractHeading: item.contractHeading ?? null,
          description: item.description,
          currency: item.currency ?? verification.currency,
          claimedAmount: item.claimedAmount,
          evidenceRef: item.evidenceRef ?? null,
          evidenceId: item.evidenceId ?? null,
          sourceType: item.sourceType ?? null,
          sourceId: item.sourceId ?? null,
          createdBy: req.user!.id,
        });
      }
      await recomputeVerification(app.db, req.companyId!, verificationId);
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "defined_cost_item",
        objectId: ids[0]!,
        payload: {
          verificationId,
          count: ids.length,
          claimed: round2(list.reduce((s, i) => s + i.claimedAmount, 0)),
          currency: verification.currency,
        },
        storePayload: true,
      });
      const rows = await app.db
        .select()
        .from(definedCostItems)
        .where(
          and(
            eq(definedCostItems.companyId, req.companyId!),
            eq(definedCostItems.verificationId, verificationId),
          ),
        );
      return reply.status(201).send({
        items: rows.filter((r) => ids.includes(r.id)),
        totals: verificationTotals(await itemsOf(req.companyId!, verificationId), verification.currency),
      });
    },
  );

  app.patch(
    "/projects/:projectId/portfolio/verifications/:verificationId/items/:itemId",
    { preHandler: standardGate },
    async (req) => {
      const { verificationId, itemId } = req.params as { verificationId: string; itemId: string };
      const body = itemPatch.parse(req.body);
      const verification = await fetchVerification(verificationId, req.companyId!, req.projectId!);
      const [item] = await app.db
        .select()
        .from(definedCostItems)
        .where(
          and(
            eq(definedCostItems.id, itemId),
            eq(definedCostItems.companyId, req.companyId!),
            eq(definedCostItems.verificationId, verificationId),
          ),
        )
        .limit(1);
      if (!item) throw notFound("Defined cost item not found on this verification");
      if (item.verdict !== "pending" && body.claimedAmount !== undefined) {
        throw conflict(
          "This item has been given a verdict; its claimed amount cannot be changed under the verdict. Reset it to pending first.",
        );
      }
      await app.db
        .update(definedCostItems)
        .set(patchSet(body as Record<string, unknown>))
        .where(eq(definedCostItems.id, itemId));
      await recomputeVerification(app.db, req.companyId!, verificationId);
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "defined_cost_item",
        objectId: itemId,
        payload: { verificationId, changed: Object.keys(body) },
      });
      const [row] = await app.db
        .select()
        .from(definedCostItems)
        .where(eq(definedCostItems.id, itemId))
        .limit(1);
      return {
        item: row,
        totals: verificationTotals(await itemsOf(req.companyId!, verificationId), verification.currency),
      };
    },
  );

  /**
   * Give an item its verdict (#1065). The verifier may not be the person who
   * recorded the claim: an assertion and the evidence that tests it must not
   * be authored through the same pathway (Vol III §4).
   */
  app.post(
    "/projects/:projectId/portfolio/verifications/:verificationId/items/:itemId/verdict",
    { preHandler: standardGate },
    async (req) => {
      const { verificationId, itemId } = req.params as { verificationId: string; itemId: string };
      const body = verdictSchema.parse(req.body);
      const verification = await fetchVerification(verificationId, req.companyId!, req.projectId!);
      if (verification.status === "closed") {
        throw conflict("This verification is closed; its verdicts are settled.");
      }
      const [item] = await app.db
        .select()
        .from(definedCostItems)
        .where(
          and(
            eq(definedCostItems.id, itemId),
            eq(definedCostItems.companyId, req.companyId!),
            eq(definedCostItems.verificationId, verificationId),
          ),
        )
        .limit(1);
      if (!item) throw notFound("Defined cost item not found on this verification");
      if (item.createdBy === req.user!.id && body.verdict !== "pending") {
        throw forbidden(
          "The person who recorded this claimed cost cannot verify it. A cost verified by its own claimant is an assertion, not a verification.",
        );
      }

      /* #1066: a disallowance needs a ground. Recording a disallowing verdict
         without one would put an amount on the register that cites nothing,
         which is an opinion and will not survive adjudication. */
      if (
        (body.verdict === "disallowed" || body.verdict === "partially_disallowed") &&
        !body.disallowance
      ) {
        throw badRequest(
          "A disallowing verdict must state the ground it rests on. Send a `disallowance` with its category (and the contract clause where there is one); a disallowance with no ground is an opinion.",
        );
      }

      let verifiedAmount = 0;
      if (body.verdict === "verified") {
        verifiedAmount = body.verifiedAmount ?? item.claimedAmount;
        if (verifiedAmount > item.claimedAmount + 0.005) {
          throw badRequest(
            `The verified amount (${verifiedAmount}) exceeds the amount claimed (${item.claimedAmount}); a verification cannot find more than was asked for.`,
          );
        }
      } else if (body.verdict === "partially_disallowed") {
        if (body.verifiedAmount === undefined) {
          throw badRequest(
            "A partial disallowance must state how much was verified; the balance is what is disallowed.",
          );
        }
        verifiedAmount = body.verifiedAmount;
        if (verifiedAmount >= item.claimedAmount - 0.005) {
          throw badRequest(
            "A partial disallowance that verifies the whole claim disallows nothing; use the `verified` verdict.",
          );
        }
        if (verifiedAmount < 0) throw badRequest("The verified amount cannot be negative");
      }

      const at = nowISO();
      await app.db
        .update(definedCostItems)
        .set({
          verdict: body.verdict,
          verifiedAmount,
          verifierNote: body.verifierNote ?? item.verifierNote,
          verifiedBy: body.verdict === "pending" ? null : req.user!.id,
          verifiedAt: body.verdict === "pending" ? null : at,
          updatedAt: at,
        })
        .where(eq(definedCostItems.id, itemId));

      /* A disallowance recorded here lands in the register with its ground,
         and its response deadline becomes an obligation like any other. */
      let disallowedId: string | null = null;
      const disallowedAmount = round2(item.claimedAmount - verifiedAmount);
      if (
        body.disallowance &&
        (body.verdict === "disallowed" || body.verdict === "partially_disallowed")
      ) {
        const number = await nextRecordNumber(app.db, req.projectId!, "disallowed_cost");
        disallowedId = newId("dsc");
        let obligationId: string | null = null;
        if (body.disallowance.responseDueAt) {
          obligationId = await createObligation(app.db, {
            companyId: req.companyId!,
            projectId: req.projectId!,
            sourceClause:
              body.disallowance.groundClause ??
              verification.auditRightsClause ??
              "Open-book verification — disallowed cost",
            trigger: `Contractor to respond to disallowance DC-${pad3(number)} of ${disallowedAmount} ${item.currency}`,
            deadline: `${body.disallowance.responseDueAt}T23:59:59.000Z`,
            warnDaysBefore: 5,
            evidenceRequirement: "The contractor's written response to the disallowance",
            createdBy: req.user!.id,
          });
        }
        await app.db.insert(disallowedCosts).values({
          id: disallowedId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          number,
          verificationId,
          definedCostItemId: itemId,
          description: body.disallowance.description ?? item.description,
          category: body.disallowance.category,
          groundClause: body.disallowance.groundClause ?? null,
          currency: item.currency,
          amount: disallowedAmount,
          raisedBy: req.user!.id,
          raisedAt: todayISO(),
          responseDueAt: body.disallowance.responseDueAt ?? null,
          obligationId,
        });
        await ledger(app.db, {
          companyId: req.companyId!,
          projectId: req.projectId!,
          actorId: req.user!.id,
          action: "create",
          objectType: "disallowed_cost",
          objectId: disallowedId,
          payload: {
            verificationId,
            definedCostItemId: itemId,
            amount: disallowedAmount,
            currency: item.currency,
            category: body.disallowance.category,
            groundClause: body.disallowance.groundClause ?? null,
            obligationId,
          },
          storePayload: true,
        });
      }

      await recomputeVerification(app.db, req.companyId!, verificationId);
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "defined_cost_item",
        objectId: itemId,
        payload: {
          verificationId,
          verdict: { from: item.verdict, to: body.verdict },
          claimedAmount: item.claimedAmount,
          verifiedAmount,
          currency: item.currency,
          disallowedCostId: disallowedId,
        },
        storePayload: true,
      });

      const [row] = await app.db
        .select()
        .from(definedCostItems)
        .where(eq(definedCostItems.id, itemId))
        .limit(1);
      return {
        item: row,
        disallowedCostId: disallowedId,
        totals: verificationTotals(await itemsOf(req.companyId!, verificationId), verification.currency),
      };
    },
  );

  app.delete(
    "/projects/:projectId/portfolio/verifications/:verificationId/items/:itemId",
    { preHandler: standardGate },
    async (req, reply) => {
      const { verificationId, itemId } = req.params as { verificationId: string; itemId: string };
      const verification = await fetchVerification(verificationId, req.companyId!, req.projectId!);
      const [item] = await app.db
        .select()
        .from(definedCostItems)
        .where(
          and(
            eq(definedCostItems.id, itemId),
            eq(definedCostItems.companyId, req.companyId!),
            eq(definedCostItems.verificationId, verificationId),
          ),
        )
        .limit(1);
      if (!item) throw notFound("Defined cost item not found on this verification");
      if (verification.status === "reported" || verification.status === "closed") {
        throw conflict("A concluded verification's items are the record of what was tested.");
      }
      const [linked] = await app.db
        .select({ n: count() })
        .from(disallowedCosts)
        .where(
          and(
            eq(disallowedCosts.companyId, req.companyId!),
            eq(disallowedCosts.definedCostItemId, itemId),
          ),
        );
      if (Number(linked?.n ?? 0) > 0) {
        throw conflict(
          "A disallowance has been raised against this item; withdraw the disallowance before removing the item it rests on.",
        );
      }
      await app.db.delete(definedCostItems).where(eq(definedCostItems.id, itemId));
      await recomputeVerification(app.db, req.companyId!, verificationId);
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "defined_cost_item",
        objectId: itemId,
        payload: {
          verificationId,
          description: item.description,
          claimedAmount: item.claimedAmount,
          currency: item.currency,
        },
        storePayload: true,
      });
      return reply.status(204).send();
    },
  );

  /* ================================================================ */
  /* Disallowed cost register (#1066)                                  */
  /* ================================================================ */

  async function fetchDisallowed(id: string, companyId: string, projectId: string) {
    const [row] = await app.db
      .select()
      .from(disallowedCosts)
      .where(
        and(
          eq(disallowedCosts.id, id),
          eq(disallowedCosts.companyId, companyId),
          eq(disallowedCosts.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Disallowed cost not found on this project");
    return row;
  }

  app.get(
    "/projects/:projectId/portfolio/disallowed-costs",
    { preHandler: readGate },
    async (req) => {
      const q = pageQuerySchema
        .extend({
          status: z.enum(DISALLOWED_COST_STATUSES).optional(),
          category: z.enum(DISALLOWED_COST_CATEGORIES).optional(),
          verificationId: idSchema.optional(),
        })
        .parse(req.query);
      const clauses: SQL[] = [
        eq(disallowedCosts.companyId, req.companyId!),
        eq(disallowedCosts.projectId, req.projectId!),
      ];
      if (q.status) clauses.push(eq(disallowedCosts.status, q.status));
      if (q.category) clauses.push(eq(disallowedCosts.category, q.category));
      if (q.verificationId) clauses.push(eq(disallowedCosts.verificationId, q.verificationId));
      const where = and(...clauses);
      const [totalRow] = await app.db.select({ n: count() }).from(disallowedCosts).where(where);
      const items = await app.db
        .select()
        .from(disallowedCosts)
        .where(where)
        .orderBy(desc(disallowedCosts.number))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      const all = await app.db
        .select()
        .from(disallowedCosts)
        .where(
          and(
            eq(disallowedCosts.companyId, req.companyId!),
            eq(disallowedCosts.projectId, req.projectId!),
          ),
        );
      const rows: DisallowedRow[] = all.map((d) => ({
        id: d.id,
        category: d.category,
        status: d.status,
        currency: d.currency,
        amount: d.amount,
        deductedAmount: d.deductedAmount,
        raisedAt: d.raisedAt,
        responseDueAt: d.responseDueAt,
        groundClause: d.groundClause,
      }));
      return {
        ...paginate(items, Number(totalRow?.n ?? 0), q),
        summary: disallowedSummary(rows, todayISO()),
      };
    },
  );

  app.post(
    "/projects/:projectId/portfolio/disallowed-costs",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = disallowedCreate.parse(req.body);
      if (body.verificationId) {
        await fetchVerification(body.verificationId, req.companyId!, req.projectId!);
      }
      const number = await nextRecordNumber(app.db, req.projectId!, "disallowed_cost");
      const id = newId("dsc");
      let obligationId: string | null = null;
      if (body.responseDueAt) {
        obligationId = await createObligation(app.db, {
          companyId: req.companyId!,
          projectId: req.projectId!,
          sourceClause: body.groundClause ?? "Open-book verification — disallowed cost",
          trigger: `Contractor to respond to disallowance DC-${pad3(number)} of ${body.amount} ${body.currency}`,
          deadline: `${body.responseDueAt}T23:59:59.000Z`,
          warnDaysBefore: 5,
          evidenceRequirement: "The contractor's written response to the disallowance",
          createdBy: req.user!.id,
        });
      }
      await app.db.insert(disallowedCosts).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        verificationId: body.verificationId ?? null,
        definedCostItemId: body.definedCostItemId ?? null,
        description: body.description,
        category: body.category,
        groundClause: body.groundClause ?? null,
        currency: body.currency,
        amount: body.amount,
        raisedBy: req.user!.id,
        raisedAt: body.raisedAt ?? todayISO(),
        responseDueAt: body.responseDueAt ?? null,
        obligationId,
      });
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "disallowed_cost",
        objectId: id,
        payload: {
          reference: `DC-${pad3(number)}`,
          amount: body.amount,
          currency: body.currency,
          category: body.category,
          groundClause: body.groundClause ?? null,
          obligationId,
        },
        storePayload: true,
      });
      const row = await fetchDisallowed(id, req.companyId!, req.projectId!);
      return reply.status(201).send({
        ...row,
        warning: body.groundClause
          ? null
          : "No contract clause is cited for this disallowance. A disallowance without a ground is an opinion and will not survive adjudication.",
      });
    },
  );

  app.post(
    "/projects/:projectId/portfolio/disallowed-costs/:disallowedId/respond",
    { preHandler: standardGate },
    async (req) => {
      const { disallowedId } = req.params as { disallowedId: string };
      const body = z
        .object({
          response: z.string().min(1).max(20000),
          disputed: z.boolean().default(false),
        })
        .parse(req.body);
      const row = await fetchDisallowed(disallowedId, req.companyId!, req.projectId!);
      if (["accepted", "withdrawn", "deducted"].includes(row.status)) {
        throw conflict(`Disallowance DC-${pad3(row.number)} is already ${row.status}.`);
      }
      const at = nowISO();
      await app.db
        .update(disallowedCosts)
        .set({
          contractorResponse: body.response,
          respondedAt: at,
          status: body.disputed ? "disputed" : "under_review",
          updatedAt: at,
        })
        .where(eq(disallowedCosts.id, disallowedId));
      /* The response performs the obligation, whether or not it agrees. */
      await setObligationStatus(app.db, row.obligationId, "open", "satisfied");
      await setObligationStatus(app.db, row.obligationId, "breached", "satisfied");
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "disallowed_cost",
        objectId: disallowedId,
        payload: {
          from: row.status,
          to: body.disputed ? "disputed" : "under_review",
          respondedAt: at,
          obligationId: row.obligationId,
        },
        storePayload: true,
      });
      return fetchDisallowed(disallowedId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/portfolio/disallowed-costs/:disallowedId/resolve",
    { preHandler: standardGate },
    async (req) => {
      const { disallowedId } = req.params as { disallowedId: string };
      const body = z
        .object({
          outcome: z.enum(["accepted", "withdrawn", "deducted"]),
          deductedAmount: nonNegativeMoneySchema.optional(),
          deductionRefType: z.string().max(60).nullable().optional(),
          deductionRefId: idSchema.nullable().optional(),
          note: z.string().min(1).max(8000),
        })
        .parse(req.body);
      const row = await fetchDisallowed(disallowedId, req.companyId!, req.projectId!);
      if (["accepted", "withdrawn", "deducted"].includes(row.status)) {
        throw conflict(`Disallowance DC-${pad3(row.number)} is already ${row.status}.`);
      }
      if (row.raisedBy === req.user!.id && body.outcome === "deducted") {
        throw forbidden(
          "The person who raised a disallowance cannot also execute the deduction; the finding and the money movement need different hands.",
        );
      }
      let deducted = 0;
      if (body.outcome === "deducted") {
        deducted = body.deductedAmount ?? row.amount;
        if (deducted > row.amount + 0.005) {
          throw badRequest(
            `The deduction (${deducted} ${row.currency}) exceeds the ${row.amount} ${row.currency} disallowed.`,
          );
        }
        if (!body.deductionRefType || !body.deductionRefId) {
          throw badRequest(
            "A deduction must say where it landed — the invoice, payment or commitment change that carries it.",
          );
        }
      }
      const at = nowISO();
      await app.db
        .update(disallowedCosts)
        .set({
          status: body.outcome,
          deductedAmount: deducted,
          deductionRefType: body.deductionRefType ?? null,
          deductionRefId: body.deductionRefId ?? null,
          resolvedBy: req.user!.id,
          resolvedAt: at,
          resolutionNote: body.note,
          updatedAt: at,
        })
        .where(eq(disallowedCosts.id, disallowedId));
      await setObligationStatus(app.db, row.obligationId, "open", "satisfied");
      await setObligationStatus(app.db, row.obligationId, "breached", "satisfied");
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "disallowed_cost",
        objectId: disallowedId,
        payload: {
          from: row.status,
          to: body.outcome,
          amount: row.amount,
          deductedAmount: deducted,
          currency: row.currency,
          deductionRefType: body.deductionRefType ?? null,
          deductionRefId: body.deductionRefId ?? null,
          note: body.note,
        },
        storePayload: true,
      });
      return fetchDisallowed(disallowedId, req.companyId!, req.projectId!);
    },
  );

  /* ================================================================ */
  /* Audit rights execution (#1064)                                    */
  /* ================================================================ */

  async function fetchAudit(id: string, companyId: string, projectId: string) {
    const [row] = await app.db
      .select()
      .from(auditRightsExecutions)
      .where(
        and(
          eq(auditRightsExecutions.id, id),
          eq(auditRightsExecutions.companyId, companyId),
          eq(auditRightsExecutions.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Audit rights execution not found on this project");
    return row;
  }

  app.get(
    "/projects/:projectId/portfolio/audit-rights",
    { preHandler: readGate },
    async (req) => {
      const q = pageQuerySchema
        .extend({ status: z.enum(AUDIT_RIGHTS_STATUSES).optional() })
        .parse(req.query);
      const clauses: SQL[] = [
        eq(auditRightsExecutions.companyId, req.companyId!),
        eq(auditRightsExecutions.projectId, req.projectId!),
      ];
      if (q.status) clauses.push(eq(auditRightsExecutions.status, q.status));
      const where = and(...clauses);
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(auditRightsExecutions)
        .where(where);
      const items = await app.db
        .select()
        .from(auditRightsExecutions)
        .where(where)
        .orderBy(desc(auditRightsExecutions.noticeDate))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(
        items.map((a) => {
          const requested = Array.isArray(a.recordsRequested) ? a.recordsRequested : [];
          const provided = requested.filter(
            (r) => typeof r === "object" && r !== null && (r as Record<string, unknown>)["providedAt"],
          ).length;
          const refused = requested.filter(
            (r) => typeof r === "object" && r !== null && (r as Record<string, unknown>)["refused"] === true,
          ).length;
          return {
            ...a,
            recordsSummary: { requested: requested.length, provided, refused, outstanding: requested.length - provided },
          };
        }),
        Number(totalRow?.n ?? 0),
        q,
      );
    },
  );

  app.post(
    "/projects/:projectId/portfolio/audit-rights",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = auditCreate.parse(req.body);
      if (body.verificationId) {
        await fetchVerification(body.verificationId, req.companyId!, req.projectId!);
      }
      const noticeDate = body.noticeDate ?? todayISO();
      if (body.scheduledDate && body.scheduledDate < noticeDate) {
        throw badRequest("scheduledDate must not precede the notice date");
      }
      const id = newId("are");
      let obligationId: string | null = null;
      if (body.scheduledDate) {
        obligationId = await createObligation(app.db, {
          companyId: req.companyId!,
          projectId: req.projectId!,
          sourceClause: body.clause ?? `${body.contractReference ?? body.subjectName} — audit rights`,
          trigger: `${body.subjectName} to give access to records for audit ${body.reference} by ${body.scheduledDate}`,
          deadline: `${body.scheduledDate}T23:59:59.000Z`,
          warnDaysBefore: body.noticeDays ?? 7,
          evidenceRequirement: "Record of access granted and the documents produced",
          createdBy: req.user!.id,
        });
      }
      await app.db.insert(auditRightsExecutions).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        verificationId: body.verificationId ?? null,
        reference: body.reference,
        subjectType: body.subjectType,
        subjectId: body.subjectId ?? null,
        subjectName: body.subjectName,
        contractReference: body.contractReference ?? null,
        clause: body.clause ?? null,
        scope: body.scope,
        auditorName: body.auditorName ?? null,
        auditorUserId: body.auditorUserId ?? null,
        noticeDate,
        noticeDays: body.noticeDays ?? null,
        scheduledDate: body.scheduledDate ?? null,
        recordsRequested: (body.recordsRequested ?? []).map((r, i) => ({
          id: r.id ?? `r${i + 1}`,
          requestedAt: r.requestedAt ?? noticeDate,
          ...r,
        })),
        obligationId,
        createdBy: req.user!.id,
      });
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "audit_rights_execution",
        objectId: id,
        payload: {
          reference: body.reference,
          subjectType: body.subjectType,
          subjectName: body.subjectName,
          clause: body.clause ?? null,
          noticeDate,
          scheduledDate: body.scheduledDate ?? null,
          obligationId,
        },
        storePayload: true,
      });
      return reply.status(201).send(await fetchAudit(id, req.companyId!, req.projectId!));
    },
  );

  app.patch(
    "/projects/:projectId/portfolio/audit-rights/:auditId",
    { preHandler: standardGate },
    async (req) => {
      const { auditId } = req.params as { auditId: string };
      const body = auditPatch.parse(req.body);
      const row = await fetchAudit(auditId, req.companyId!, req.projectId!);
      if (row.status === "closed") throw conflict("A closed audit record cannot be edited.");
      const set = patchSet(body as Record<string, unknown>);
      if (body.recordsRequested !== undefined) {
        set["recordsRequested"] = (body.recordsRequested ?? []).map((r, i) => ({
          id: r.id ?? `r${i + 1}`,
          requestedAt: r.requestedAt ?? row.noticeDate,
          ...r,
        }));
      }
      await app.db
        .update(auditRightsExecutions)
        .set(set)
        .where(eq(auditRightsExecutions.id, auditId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "audit_rights_execution",
        objectId: auditId,
        payload: { changed: Object.keys(body) },
      });
      return fetchAudit(auditId, req.companyId!, req.projectId!);
    },
  );

  const auditStatus = z.object({
    status: z.enum(AUDIT_RIGHTS_STATUSES),
    accessGrantedAt: z.string().max(40).optional(),
    obstructionNote: z.string().max(8000).nullable().optional(),
    outcome: z.string().max(20000).nullable().optional(),
  });

  app.post(
    "/projects/:projectId/portfolio/audit-rights/:auditId/status",
    { preHandler: standardGate },
    async (req) => {
      const { auditId } = req.params as { auditId: string };
      const body = auditStatus.parse(req.body);
      const row = await fetchAudit(auditId, req.companyId!, req.projectId!);
      if (row.status === body.status && body.status !== "obstructed") return row;
      if (row.status === "closed") throw conflict("A closed audit record cannot be reopened.");
      if (body.status === "obstructed" && !body.obstructionNote) {
        throw badRequest(
          "Recording an obstruction requires a note. What was refused, and by whom, is the evidence in any later dispute.",
        );
      }
      if (body.status === "completed" && !body.outcome) {
        throw badRequest("A completed audit must record its outcome.");
      }
      const at = nowISO();
      const set: Record<string, unknown> = { status: body.status, updatedAt: at };
      if (body.status === "in_progress" || body.status === "completed") {
        set["accessGrantedAt"] = body.accessGrantedAt ?? row.accessGrantedAt ?? at;
      }
      if (body.obstructionNote !== undefined) set["obstructionNote"] = body.obstructionNote;
      if (body.outcome !== undefined) set["outcome"] = body.outcome;
      if (body.status === "completed") set["completedAt"] = at;
      await app.db
        .update(auditRightsExecutions)
        .set(set)
        .where(eq(auditRightsExecutions.id, auditId));

      if (body.status === "in_progress" || body.status === "completed") {
        await setObligationStatus(app.db, row.obligationId, "open", "satisfied");
        await setObligationStatus(app.db, row.obligationId, "breached", "satisfied");
      }
      if (body.status === "obstructed") {
        await setObligationStatus(app.db, row.obligationId, "open", "breached");
      }
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "audit_rights_execution",
        objectId: auditId,
        payload: {
          from: row.status,
          to: body.status,
          obstructionNote: body.obstructionNote ?? null,
          obligationId: row.obligationId,
        },
        storePayload: true,
      });
      return fetchAudit(auditId, req.companyId!, req.projectId!);
    },
  );

  app.delete(
    "/projects/:projectId/portfolio/audit-rights/:auditId",
    { preHandler: adminGate },
    async (req, reply) => {
      const { auditId } = req.params as { auditId: string };
      const row = await fetchAudit(auditId, req.companyId!, req.projectId!);
      if (row.status !== "notified") {
        throw conflict(
          "An audit that has progressed beyond notice is part of the assurance record; close it rather than deleting it.",
        );
      }
      await app.db.delete(auditRightsExecutions).where(eq(auditRightsExecutions.id, auditId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "audit_rights_execution",
        objectId: auditId,
        payload: { reference: row.reference, subjectName: row.subjectName },
        storePayload: true,
      });
      return reply.status(204).send();
    },
  );
};
