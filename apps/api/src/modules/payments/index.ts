import type { FastifyPluginAsync } from "fastify";
import type { Db } from "../../lib/db.js";
import { forEachCompany } from "../../lib/scheduler.js";
import { and, asc, count, desc, eq, inArray, isNotNull, lt, lte } from "drizzle-orm";
import { z } from "zod";
import {
  contracts,
  obligations,
  paymentAdjudications,
  paymentClaims,
  paymentResponses,
  paymentSecurityAccounts,
  signals,
  statutoryLiens,
  suspensionNotices,
  valuations,
} from "@constructos/db";
import {
  PAYMENT_CLAIM_STATUSES,
  PAYMENT_REGIMES,
  PAYMENT_RESPONSE_KINDS,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { addDaysISO, isoDateSchema, todayISO } from "../field/dates.js";
import { pushNotifications } from "../notifications/service.js";
import { computeTimeline, findRegime, REGIME_LIBRARY } from "./regimes.js";
import { lienRoutes } from "./liens.js";
import { reconcileAccountRow, securityAccountRoutes } from "./security.js";
import { adjudicationRoutes } from "./adjudication.js";
import { supplyChainRoutes } from "./supplychain.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

/** Lenient ISO timestamp (avoids zod version drift on .datetime()). */
const isoTimestamp = z
  .string()
  .min(4)
  .refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO timestamp");

const claimCreateSchema = z.object({
  regime: z.enum(PAYMENT_REGIMES),
  referenceDate: isoDateSchema,
  claimedAmount: z.number().positive(),
  currency: z.string().length(3).optional(),
  description: z.string().max(20000).nullable().optional(),
  contractId: z.string().min(1).nullable().optional(),
  valuationId: z.string().min(1).nullable().optional(),
});

const claimPatchSchema = claimCreateSchema.partial();

const claimListQuery = pageQuerySchema.extend({
  regime: z.enum(PAYMENT_REGIMES).optional(),
  status: z.enum(PAYMENT_CLAIM_STATUSES).optional(),
});

const serveSchema = z.object({
  method: z.enum(["email", "portal", "registered_post", "letter"]),
  reference: z.string().max(300).nullable().optional(),
});

const respondSchema = z.object({
  kind: z.enum(PAYMENT_RESPONSE_KINDS),
  amount: z.number().nonnegative(),
  reasons: z.string().max(20000).nullable().optional(),
  breakdown: z.array(z.unknown()).max(500).optional(),
});

const markPaidSchema = z.object({
  paidAmount: z.number().positive(),
  paidAt: isoTimestamp.optional(),
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Whole days from today (UTC) to an ISO date; negative = already past. */
function daysUntil(isoDate: string): number {
  return Math.round(
    (Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${todayISO()}T00:00:00Z`)) / 86_400_000,
  );
}

/** Whole days from ISO date `a` to ISO date `b` (date-only, UTC). */
function wholeDaysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;


/**
 * DEEMED-LIABILITY SWEEP (#361). A served claim whose response deadline
 * (end of day) has passed with no ON-TIME response flips to `deemed`, its
 * response obligation is breached and a critical signal is raised — exactly
 * once: the status flip is a conditional UPDATE ... RETURNING and the signal
 * is inserted only for the row that flipped, so two concurrent sweeps cannot
 * raise it twice. A LATE response does not rescue a claim: statutes make a
 * late pay-less notice ineffective, so the claim is deemed regardless.
 *
 * Runs from the scheduler (`payments.deemed-liability`, hourly) and from the
 * read paths, so a project nobody opens is still deemed on time.
 */
export async function sweepDeemedClaims(
  db: Db,
  companyId: string,
  projectId: string | null,
  actorId: string | null,
  today: string = todayISO(),
): Promise<{ deemed: number }> {
  const clauses = [
    eq(paymentClaims.companyId, companyId),
    eq(paymentClaims.status, "served"),
    isNotNull(paymentClaims.responseDeadline),
    lt(paymentClaims.responseDeadline, today),
  ];
  if (projectId) clauses.push(eq(paymentClaims.projectId, projectId));
  const overdue = await db.select().from(paymentClaims).where(and(...clauses));
  let deemed = 0;
  for (const claim of overdue) {
    const [onTime] = await db
      .select({ n: count() })
      .from(paymentResponses)
      .where(and(eq(paymentResponses.paymentClaimId, claim.id), eq(paymentResponses.late, 0)));
    if (Number(onTime?.n ?? 0) > 0) continue; // an on-time response exists — not deemed
    const flipped = await db
      .update(paymentClaims)
      .set({ status: "deemed", updatedAt: new Date().toISOString() })
      .where(and(eq(paymentClaims.id, claim.id), eq(paymentClaims.status, "served")))
      .returning({ id: paymentClaims.id });
    if (flipped.length === 0) continue; // somebody else flipped it a moment ago
    deemed += 1;
    if (claim.obligationId) {
      await db
        .update(obligations)
        .set({ status: "breached" })
        .where(and(eq(obligations.id, claim.obligationId), eq(obligations.status, "open")));
    }
    const def = findRegime(claim.regime);
    await db.insert(signals).values({
      id: newId("sig"),
      companyId,
      projectId: claim.projectId,
      detector: "payment_deemed_liability",
      severity: "critical",
      confidence: 1,
      title: `No payment response served in time — deemed liability for ${claim.currency} ${claim.claimedAmount}`,
      explanation:
        `Payment claim #${claim.number} (${claim.currency} ${claim.claimedAmount}, ${def?.name ?? claim.regime}) ` +
        `was served on ${claim.servedAt?.slice(0, 10)} with a statutory response deadline of ${claim.responseDeadline}. ` +
        `No on-time payment response or pay-less notice was recorded before the deadline elapsed. ` +
        `${def?.deemedRule ?? "The claimed amount may now be payable in full."} ${INDICATIVE_DISCLAIMER}`,
    });
    await appendLedger(db, {
      companyId,
      actorId,
      action: "state_change",
      objectType: "payment_claim",
      objectId: claim.id,
      projectId: claim.projectId,
      payload: { from: "served", to: "deemed", responseDeadline: claim.responseDeadline },
    });
  }
  return { deemed };
}

/**
 * The regime library is a MODEL of each statute (see regimes.ts for the
 * documented simplifications: no public-holiday calendars, one response
 * clock per regime, pinned interest rates). Every computed deadline carries
 * this so a user never mistakes the radar for legal advice.
 */
export const INDICATIVE_DISCLAIMER =
  "Deadlines are indicative: computed from a simplified model of the statute (weekend-only " +
  "business days, one response clock, pinned interest rate). Confirm against the contract and " +
  "the statute before relying on them.";

/**
 * Statutory payment security — spec Vol II Domain F / M10 (#358-393
 * foundation subset): code-resident regime library (#364-369), payment
 * claim register with the statutory deadline engine (#358-360), payment
 * response / pay-less engine with ground-stating (#359, #365), deemed
 * liability sweep (#361), right-to-suspend notices (#362), late-payment
 * interest (#387) and days-to-pay analytics (#386). Response deadlines
 * materialize as assurance Obligations so the payment clock and the
 * assurance layer see the same date.
 */
export const paymentsModule: FastifyPluginAsync = async (app) => {
  await app.register(lienRoutes);
  await app.register(securityAccountRoutes);
  await app.register(adjudicationRoutes);
  await app.register(supplyChainRoutes);
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("payments", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("payments", "standard"),
  ];

  async function fetchClaim(claimId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(paymentClaims)
      .where(
        and(
          eq(paymentClaims.id, claimId),
          eq(paymentClaims.companyId, companyId),
          eq(paymentClaims.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Payment claim not found");
    return rows[0];
  }

  /** Route-side sweep: the scheduled job runs the same function for every company. */
  async function sweepDeemed(companyId: string, projectId: string, actorId: string | null): Promise<void> {
    await sweepDeemedClaims(app.db, companyId, projectId, actorId);
  }

  /* ---------------------------------------------------------------- */
  /* Regime library (reference data, not tenant data)                  */
  /* ---------------------------------------------------------------- */

  app.get("/payment-regimes", { preHandler: [app.authenticate] }, async () => ({
    items: REGIME_LIBRARY.map((r) => ({ ...r, indicative: true })),
    total: REGIME_LIBRARY.length,
    indicative: true,
    disclaimer: INDICATIVE_DISCLAIMER,
  }));

  app.get("/payment-regimes/:regime", { preHandler: [app.authenticate] }, async (req) => {
    const { regime } = req.params as { regime: string };
    const def = findRegime(regime);
    if (!def) throw notFound("Unknown payment regime");
    return { ...def, indicative: true, disclaimer: INDICATIVE_DISCLAIMER };
  });

  /* ---------------------------------------------------------------- */
  /* Scheduled sweeps — a project nobody opens is still deemed on time  */
  /* ---------------------------------------------------------------- */

  app.scheduler.register({
    name: "payments.deemed-liability",
    description: "Flip served payment claims past their statutory response deadline to deemed; breach the obligation and raise the signal",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => {
      let deemed = 0;
      const result = await forEachCompany(db, async (companyId) => {
        const r = await sweepDeemedClaims(db, companyId, null, null, now.toISOString().slice(0, 10));
        deemed += r.deemed;
      });
      return { deemed, companies: result.companies, failed: result.failed };
    },
  });

  /* ---------------------------------------------------------------- */
  /* Payment claims (#358-360)                                         */
  /* ---------------------------------------------------------------- */

  async function validateLinks(
    companyId: string,
    projectId: string,
    contractId?: string | null,
    valuationId?: string | null,
  ): Promise<void> {
    if (contractId) {
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
      if (!rows[0]) throw badRequest("contractId does not belong to this project");
    }
    if (valuationId) {
      const rows = await app.db
        .select({ id: valuations.id })
        .from(valuations)
        .where(
          and(
            eq(valuations.id, valuationId),
            eq(valuations.companyId, companyId),
            eq(valuations.projectId, projectId),
          ),
        )
        .limit(1);
      if (!rows[0]) throw badRequest("valuationId does not belong to this project");
    }
  }

  app.post(
    "/projects/:projectId/payment-claims",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = claimCreateSchema.parse(req.body);
      await validateLinks(req.companyId!, req.projectId!, body.contractId, body.valuationId);
      const number = await nextRecordNumber(app.db, req.projectId!, "payment_claim");
      const id = newId("pcl");
      await app.db.insert(paymentClaims).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        contractId: body.contractId ?? null,
        valuationId: body.valuationId ?? null,
        number,
        regime: body.regime,
        referenceDate: body.referenceDate,
        claimedAmount: body.claimedAmount,
        currency: body.currency ?? "GBP",
        description: body.description ?? null,
        status: "draft",
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "payment_claim",
        objectId: id,
        payload: {
          number,
          regime: body.regime,
          referenceDate: body.referenceDate,
          claimedAmount: body.claimedAmount,
          currency: body.currency ?? "GBP",
        },
        storePayload: true,
      });
      const created = await fetchClaim(id, req.companyId!, req.projectId!);
      return reply.status(201).send(created);
    },
  );

  app.get("/projects/:projectId/payment-claims", { preHandler: readGate }, async (req) => {
    const q = claimListQuery.parse(req.query);
    await sweepDeemed(req.companyId!, req.projectId!, req.user!.id);
    const clauses = [
      eq(paymentClaims.companyId, req.companyId!),
      eq(paymentClaims.projectId, req.projectId!),
    ];
    if (q.regime) clauses.push(eq(paymentClaims.regime, q.regime));
    if (q.status) clauses.push(eq(paymentClaims.status, q.status));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(paymentClaims).where(where);
    const rows = await app.db
      .select()
      .from(paymentClaims)
      .where(where)
      .orderBy(desc(paymentClaims.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const items = rows.map((c) => ({
      ...c,
      daysToResponseDeadline: c.responseDeadline ? daysUntil(c.responseDeadline) : null,
    }));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /**
   * Deadline radar (#361 early warning): served claims whose statutory
   * response deadline falls inside the window, soonest first.
   */
  app.get("/projects/:projectId/payments/deadlines", { preHandler: readGate }, async (req) => {
    const q = z
      .object({ days: z.coerce.number().int().min(1).max(365).default(14) })
      .parse(req.query);
    await sweepDeemed(req.companyId!, req.projectId!, req.user!.id);
    const horizon = addDaysISO(todayISO(), q.days);
    const rows = await app.db
      .select()
      .from(paymentClaims)
      .where(
        and(
          eq(paymentClaims.companyId, req.companyId!),
          eq(paymentClaims.projectId, req.projectId!),
          eq(paymentClaims.status, "served"),
          isNotNull(paymentClaims.responseDeadline),
          lte(paymentClaims.responseDeadline, horizon),
        ),
      )
      .orderBy(asc(paymentClaims.responseDeadline));
    const items = rows.map((c) => ({
      id: c.id,
      number: c.number,
      regime: c.regime,
      claimedAmount: c.claimedAmount,
      currency: c.currency,
      servedAt: c.servedAt,
      responseDeadline: c.responseDeadline,
      finalPaymentDate: c.finalPaymentDate,
      daysRemaining: daysUntil(c.responseDeadline!),
    }));
    return { items, windowDays: q.days };
  });

  /**
   * Days-to-pay analytics (#386): status mix, average service-to-payment
   * days over paid claims, outstanding book and deemed exposure (deemed +
   * suspended — suspension does not extinguish the underlying liability).
   */
  /**
   * HEALTH INPUTS (plan §3.5) for the intelligence layer's `finance` and
   * `risk` dimensions. Counts only: the claims, liens and trusts on a project
   * may be denominated in several currencies and a single money total across
   * them would be arithmetically meaningless. The sweep runs first so a
   * deemed claim is counted as deemed rather than as merely served.
   */
  app.get("/projects/:projectId/payments/health-inputs", { preHandler: readGate }, async (req) => {
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    await sweepDeemed(companyId, projectId, req.user!.id);
    const today = todayISO();
    const [claims, liens, accounts, cases] = await Promise.all([
      app.db
        .select({ status: paymentClaims.status, responseDeadline: paymentClaims.responseDeadline })
        .from(paymentClaims)
        .where(and(eq(paymentClaims.companyId, companyId), eq(paymentClaims.projectId, projectId))),
      app.db
        .select({ status: statutoryLiens.status, deadlineAt: statutoryLiens.deadlineAt })
        .from(statutoryLiens)
        .where(
          and(eq(statutoryLiens.companyId, companyId), eq(statutoryLiens.projectId, projectId)),
        ),
      app.db
        .select()
        .from(paymentSecurityAccounts)
        .where(
          and(
            eq(paymentSecurityAccounts.companyId, companyId),
            eq(paymentSecurityAccounts.projectId, projectId),
          ),
        ),
      app.db
        .select({ status: paymentAdjudications.status, decisionDueAt: paymentAdjudications.decisionDueAt })
        .from(paymentAdjudications)
        .where(
          and(
            eq(paymentAdjudications.companyId, companyId),
            eq(paymentAdjudications.projectId, projectId),
          ),
        ),
    ]);
    let underfunded = 0;
    for (const a of accounts.filter((x) => x.status === "active")) {
      const rec = await reconcileAccountRow(app.db, a);
      if (!rec.funded) underfunded += 1;
    }
    const reasons: string[] = [];
    if (claims.length === 0 && liens.length === 0) {
      reasons.push(
        "No statutory payment claim or lien is on this project, so the statutory dimension is unrated.",
      );
    }
    reasons.push(INDICATIVE_DISCLAIMER);
    return {
      projectId,
      asOf: today,
      metrics: {
        paymentClaims: claims.length,
        deemedClaims: claims.filter((c) => c.status === "deemed").length,
        suspendedClaims: claims.filter((c) => c.status === "suspended").length,
        responsesDueWithin7:
          claims.filter(
            (c) =>
              c.status === "served" &&
              c.responseDeadline !== null &&
              c.responseDeadline >= today &&
              c.responseDeadline <= addDaysISO(today, 7),
          ).length,
        openLiens: liens.filter((l) => ["noticed", "filed", "disputed"].includes(l.status)).length,
        liensPastDeadline: liens.filter(
          (l) =>
            ["noticed", "filed", "disputed"].includes(l.status) &&
            l.deadlineAt !== null &&
            l.deadlineAt < today,
        ).length,
        underfundedSecurityAccounts: underfunded,
        liveAdjudications: cases.filter((c) =>
          ["notice", "referred", "responded"].includes(c.status),
        ).length,
      },
      reasons,
    };
  });

  app.get("/projects/:projectId/payments/analytics", { preHandler: readGate }, async (req) => {
    await sweepDeemed(req.companyId!, req.projectId!, req.user!.id);
    const all = await app.db
      .select()
      .from(paymentClaims)
      .where(
        and(
          eq(paymentClaims.companyId, req.companyId!),
          eq(paymentClaims.projectId, req.projectId!),
        ),
      );
    const byStatus = (s: string) => all.filter((c) => c.status === s).length;
    const paidClaims = all.filter((c) => c.status === "paid" && c.servedAt && c.paidAt);
    const avgDaysToPay =
      paidClaims.length === 0
        ? null
        : Math.round(
            (paidClaims.reduce(
              (sum, c) => sum + (Date.parse(c.paidAt!) - Date.parse(c.servedAt!)) / 86_400_000,
              0,
            ) /
              paidClaims.length) *
              10,
          ) / 10;

    // Outstanding = served-but-unpaid book, valued at the latest on-time
    // response amount where one exists, else the claimed amount.
    const open = all.filter((c) => c.servedAt && c.status !== "paid" && c.status !== "draft");
    const onTimeAmounts = new Map<string, number>();
    if (open.length > 0) {
      const resp = await app.db
        .select()
        .from(paymentResponses)
        .where(
          inArray(
            paymentResponses.paymentClaimId,
            open.map((c) => c.id),
          ),
        )
        .orderBy(asc(paymentResponses.servedAt));
      for (const r of resp) {
        if (r.late === 0) onTimeAmounts.set(r.paymentClaimId, r.amount);
      }
    }
    const totalOutstanding = round2(
      open.reduce((sum, c) => sum + (onTimeAmounts.get(c.id) ?? c.claimedAmount), 0),
    );
    const deemedExposure = round2(
      all
        .filter((c) => c.status === "deemed" || c.status === "suspended")
        .reduce((sum, c) => sum + c.claimedAmount, 0),
    );
    return {
      claims: all.length,
      served: byStatus("served"),
      responded: byStatus("responded"),
      deemed: byStatus("deemed"),
      paid: byStatus("paid"),
      suspended: byStatus("suspended"),
      avgDaysToPay,
      totalOutstanding,
      deemedExposure,
    };
  });

  app.get("/projects/:projectId/payment-claims/:claimId", { preHandler: readGate }, async (req) => {
    const { claimId } = req.params as { claimId: string };
    await fetchClaim(claimId, req.companyId!, req.projectId!); // 404 before sweeping
    await sweepDeemed(req.companyId!, req.projectId!, req.user!.id);
    const claim = await fetchClaim(claimId, req.companyId!, req.projectId!);
    const responses = await app.db
      .select()
      .from(paymentResponses)
      .where(eq(paymentResponses.paymentClaimId, claimId))
      .orderBy(asc(paymentResponses.servedAt));
    const notices = await app.db
      .select()
      .from(suspensionNotices)
      .where(eq(suspensionNotices.paymentClaimId, claimId))
      .orderBy(asc(suspensionNotices.servedAt));
    return {
      ...claim,
      daysToResponseDeadline: claim.responseDeadline ? daysUntil(claim.responseDeadline) : null,
      responses,
      suspensionNotices: notices,
      regimeDef: findRegime(claim.regime) ?? null,
      indicative: true,
      disclaimer: INDICATIVE_DISCLAIMER,
    };
  });

  app.patch(
    "/projects/:projectId/payment-claims/:claimId",
    { preHandler: standardGate },
    async (req) => {
      const { claimId } = req.params as { claimId: string };
      const body = claimPatchSchema.parse(req.body);
      const claim = await fetchClaim(claimId, req.companyId!, req.projectId!);
      if (claim.status !== "draft") {
        throw badRequest("Only a draft payment claim can be edited; served claims are immutable");
      }
      await validateLinks(req.companyId!, req.projectId!, body.contractId, body.valuationId);
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined) set[k] = v;
      }
      await app.db.update(paymentClaims).set(set).where(eq(paymentClaims.id, claimId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "payment_claim",
        objectId: claimId,
        payload: { changed: Object.keys(body) },
      });
      return fetchClaim(claimId, req.companyId!, req.projectId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Service — starts the statutory clocks (#359-360)                  */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/payment-claims/:claimId/serve",
    { preHandler: standardGate },
    async (req) => {
      const { claimId } = req.params as { claimId: string };
      const body = serveSchema.parse(req.body);
      const claim = await fetchClaim(claimId, req.companyId!, req.projectId!);
      if (claim.status !== "draft") {
        throw badRequest(`A ${claim.status} payment claim cannot be served`);
      }
      const def = findRegime(claim.regime);
      if (!def) throw badRequest(`Unknown payment regime: ${claim.regime}`);
      const servedAt = new Date().toISOString();
      const timeline = computeTimeline(def.regime, claim.referenceDate, servedAt);

      // The statutory response deadline materializes as an assurance
      // Obligation, so the payment clock and the obligation register agree.
      const obligationId = newId("obl");
      await app.db.insert(obligations).values({
        id: obligationId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        sourceClause: `${def.name} — payment response`,
        trigger: `Respond to payment claim ${claim.number}`,
        deadline: `${timeline.responseDeadline}T23:59:59Z`,
        warnDaysBefore: 3,
        evidenceRequirement: "Served payment/pay-less notice",
        status: "open",
        createdBy: req.user!.id,
      });
      await app.db
        .update(paymentClaims)
        .set({
          status: "served",
          servedAt,
          serviceMethod: body.method,
          serviceReference: body.reference ?? null,
          responseDeadline: timeline.responseDeadline,
          finalPaymentDate: timeline.finalPaymentDate,
          obligationId,
          updatedAt: servedAt,
        })
        .where(eq(paymentClaims.id, claimId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "payment_claim",
        objectId: claimId,
        payload: {
          from: "draft",
          to: "served",
          method: body.method,
          servedAt,
          regime: claim.regime,
          referenceDate: claim.referenceDate,
          responseDeadline: timeline.responseDeadline,
          finalPaymentDate: timeline.finalPaymentDate,
          obligationId,
        },
        storePayload: true,
      });
      const updated = await fetchClaim(claimId, req.companyId!, req.projectId!);
      return {
        ...updated,
        daysToResponseDeadline: daysUntil(timeline.responseDeadline),
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Payment responses / pay-less notices (#359, #365)                 */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/payment-claims/:claimId/respond",
    { preHandler: standardGate },
    async (req, reply) => {
      const { claimId } = req.params as { claimId: string };
      const body = respondSchema.parse(req.body);
      await fetchClaim(claimId, req.companyId!, req.projectId!); // 404 before sweeping
      /* a late response must not rescue an un-swept claim: deem first, then record */
      await sweepDeemed(req.companyId!, req.projectId!, req.user!.id);
      const claim = await fetchClaim(claimId, req.companyId!, req.projectId!);
      if (claim.status !== "served" && claim.status !== "deemed") {
        throw badRequest(`A payment response cannot be served on a ${claim.status} claim`);
      }
      // Statutory ground-stating: paying less than the claimed amount
      // without reasons is exactly what the regimes exist to prevent.
      if (
        body.kind === "pay_less_notice" &&
        body.amount < claim.claimedAmount &&
        !body.reasons?.trim()
      ) {
        throw badRequest(
          "A pay-less notice for less than the claimed amount must state the grounds (reasons) for withholding",
        );
      }
      const servedAt = new Date().toISOString();
      const late =
        claim.responseDeadline != null &&
        Date.parse(servedAt) > Date.parse(`${claim.responseDeadline}T23:59:59.999Z`);
      const id = newId("prs");
      await app.db.insert(paymentResponses).values({
        id,
        paymentClaimId: claimId,
        companyId: req.companyId!,
        kind: body.kind,
        amount: body.amount,
        reasons: body.reasons ?? null,
        breakdown: body.breakdown ?? null,
        servedAt,
        late: late ? 1 : 0,
        servedBy: req.user!.id,
      });
      if (!late) {
        // On-time response: claim answered, obligation satisfied.
        await app.db
          .update(paymentClaims)
          .set({ status: "responded", updatedAt: servedAt })
          .where(and(eq(paymentClaims.id, claimId), eq(paymentClaims.status, "served")));
        if (claim.obligationId) {
          await app.db
            .update(obligations)
            .set({ status: "satisfied" })
            .where(and(eq(obligations.id, claim.obligationId), eq(obligations.status, "open")));
        }
      } else {
        // Late response: no status rescue — a deemed claim stays deemed and
        // an unswept served claim is not promoted to responded. The deadline
        // obligation is breached (if the sweep has not already done so) and
        // a high signal records the statutory ineffectiveness.
        if (claim.obligationId) {
          await app.db
            .update(obligations)
            .set({ status: "breached" })
            .where(and(eq(obligations.id, claim.obligationId), eq(obligations.status, "open")));
        }
        await app.db.insert(signals).values({
          id: newId("sig"),
          companyId: req.companyId!,
          projectId: req.projectId!,
          detector: "late_payment_response",
          severity: "high",
          confidence: 1,
          title: `Payment response served late on claim #${claim.number}`,
          explanation:
            `A ${body.kind === "pay_less_notice" ? "pay-less notice" : "payment notice"} for payment claim ` +
            `#${claim.number} was served on ${servedAt.slice(0, 10)}, after the statutory response deadline of ` +
            `${claim.responseDeadline}. A late response is statutorily ineffective under most regimes: the ` +
            `claimed amount of ${claim.currency} ${claim.claimedAmount} may remain payable in full.`,
        });
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "payment_response",
        objectId: id,
        payload: {
          paymentClaimId: claimId,
          kind: body.kind,
          amount: body.amount,
          servedAt,
          late,
        },
        storePayload: true,
      });
      const updated = await fetchClaim(claimId, req.companyId!, req.projectId!);
      return reply.status(201).send({
        ...updated,
        response: { id, kind: body.kind, amount: body.amount, servedAt, late },
      });
    },
  );

  /* ---------------------------------------------------------------- */
  /* Right to suspend (#362)                                           */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/payment-claims/:claimId/suspend",
    { preHandler: standardGate },
    async (req, reply) => {
      const { claimId } = req.params as { claimId: string };
      await fetchClaim(claimId, req.companyId!, req.projectId!); // 404 before sweeping
      await sweepDeemed(req.companyId!, req.projectId!, req.user!.id);
      const claim = await fetchClaim(claimId, req.companyId!, req.projectId!);
      // SIMPLIFICATION: the model grounds the right to suspend on deemed
      // liability only. Statutes also allow suspension after a certified/
      // scheduled amount goes unpaid past the final date — not modelled.
      if (claim.status !== "deemed") {
        throw badRequest(
          `Right to suspend is only available on a deemed claim (this claim is ${claim.status})`,
        );
      }
      const def = findRegime(claim.regime);
      if (!def) throw badRequest(`Unknown payment regime: ${claim.regime}`);
      const servedAt = new Date().toISOString();
      const effectiveFrom = addDaysISO(todayISO(), def.suspensionNoticeDays);
      const id = newId("ssn");
      await app.db.insert(suspensionNotices).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        paymentClaimId: claimId,
        servedAt,
        effectiveFrom,
        servedBy: req.user!.id,
      });
      await app.db
        .update(paymentClaims)
        .set({ status: "suspended", updatedAt: servedAt })
        .where(eq(paymentClaims.id, claimId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "suspension_notice",
        objectId: id,
        payload: {
          paymentClaimId: claimId,
          regime: claim.regime,
          noticeDays: def.suspensionNoticeDays,
          effectiveFrom,
        },
        storePayload: true,
      });
      await pushNotifications(app.db, [
        {
          companyId: req.companyId!,
          userId: claim.createdBy,
          projectId: req.projectId!,
          kind: "status_change",
          title: `Suspension notice served — payment claim #${claim.number}`,
          body:
            `A right-to-suspend notice under ${def.name} was served for payment claim #${claim.number} ` +
            `(${claim.currency} ${claim.claimedAmount}). Suspension may take effect from ${effectiveFrom} ` +
            `(${def.suspensionNoticeDays} days' statutory notice).`,
          recordType: "payment_claim",
          recordId: claimId,
        },
      ]);
      const notice = (
        await app.db.select().from(suspensionNotices).where(eq(suspensionNotices.id, id)).limit(1)
      )[0];
      return reply.status(201).send(notice);
    },
  );

  app.post(
    "/projects/:projectId/suspension-notices/:noticeId/lift",
    { preHandler: standardGate },
    async (req) => {
      const { noticeId } = req.params as { noticeId: string };
      const rows = await app.db
        .select()
        .from(suspensionNotices)
        .where(
          and(
            eq(suspensionNotices.id, noticeId),
            eq(suspensionNotices.companyId, req.companyId!),
            eq(suspensionNotices.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const notice = rows[0];
      if (!notice) throw notFound("Suspension notice not found");
      if (notice.liftedAt) throw badRequest("Suspension notice is already lifted");
      const now = new Date().toISOString();
      await app.db
        .update(suspensionNotices)
        .set({ liftedAt: now })
        .where(eq(suspensionNotices.id, noticeId));
      // Lifting the suspension returns the claim to its pre-suspension
      // state: the deemed liability itself is unaffected.
      await app.db
        .update(paymentClaims)
        .set({ status: "deemed", updatedAt: now })
        .where(
          and(eq(paymentClaims.id, notice.paymentClaimId), eq(paymentClaims.status, "suspended")),
        );
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "suspension_notice",
        objectId: noticeId,
        payload: { liftedAt: now, paymentClaimId: notice.paymentClaimId },
      });
      const updated = (
        await app.db
          .select()
          .from(suspensionNotices)
          .where(eq(suspensionNotices.id, noticeId))
          .limit(1)
      )[0];
      return updated;
    },
  );

  /* ---------------------------------------------------------------- */
  /* Payment + statutory interest (#387)                               */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/payment-claims/:claimId/mark-paid",
    { preHandler: standardGate },
    async (req) => {
      const { claimId } = req.params as { claimId: string };
      const body = markPaidSchema.parse(req.body);
      await fetchClaim(claimId, req.companyId!, req.projectId!); // 404 before sweeping
      await sweepDeemed(req.companyId!, req.projectId!, req.user!.id);
      const claim = await fetchClaim(claimId, req.companyId!, req.projectId!);
      if (!["served", "responded", "deemed", "suspended"].includes(claim.status)) {
        throw badRequest(`A ${claim.status} payment claim cannot be marked paid`);
      }
      const paidAt = body.paidAt ? new Date(body.paidAt).toISOString() : new Date().toISOString();
      const now = new Date().toISOString();
      await app.db
        .update(paymentClaims)
        .set({ status: "paid", paidAt, paidAmount: body.paidAmount, updatedAt: now })
        .where(eq(paymentClaims.id, claimId));
      // Payment moots the response obligation if it is still open (a
      // breached obligation stays breached — paying late does not rewrite
      // the register).
      if (claim.obligationId) {
        await app.db
          .update(obligations)
          .set({ status: "satisfied" })
          .where(and(eq(obligations.id, claim.obligationId), eq(obligations.status, "open")));
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "payment_claim",
        objectId: claimId,
        payload: { from: claim.status, to: "paid", paidAmount: body.paidAmount, paidAt },
        storePayload: true,
      });
      return fetchClaim(claimId, req.companyId!, req.projectId!);
    },
  );

  /**
   * Statutory late-payment interest (#387): simple interest, ACT/365, at
   * the regime's modelled rate on the outstanding amount — the latest
   * ON-TIME response amount where a valid response exists, else the
   * claimed amount (a late response is statutorily ineffective and does
   * not reduce the base).
   */
  app.get(
    "/projects/:projectId/payment-claims/:claimId/interest",
    { preHandler: readGate },
    async (req) => {
      const { claimId } = req.params as { claimId: string };
      const claim = await fetchClaim(claimId, req.companyId!, req.projectId!);
      const def = findRegime(claim.regime);
      if (!def) throw badRequest(`Unknown payment regime: ${claim.regime}`);

      const responses = await app.db
        .select()
        .from(paymentResponses)
        .where(eq(paymentResponses.paymentClaimId, claimId))
        .orderBy(asc(paymentResponses.servedAt));
      const validResponse = [...responses].reverse().find((r) => r.late === 0);
      const outstanding = validResponse ? validResponse.amount : claim.claimedAmount;

      const zero = (basis: string) => ({
        claimId,
        status: claim.status,
        currency: claim.currency,
        outstanding,
        finalPaymentDate: claim.finalPaymentDate,
        daysLate: 0,
        annualRate: def.annualInterestPercent,
        interest: 0,
        basis,
      });

      if (!claim.finalPaymentDate) {
        return zero("Claim has not been served — no statutory final payment date exists yet.");
      }
      let daysLate = 0;
      if (claim.status === "paid" && claim.paidAt) {
        const paidDate = new Date(claim.paidAt).toISOString().slice(0, 10);
        daysLate = Math.max(
          0,
          wholeDaysBetween(claim.finalPaymentDate, paidDate),
        );
        if (daysLate === 0) {
          return zero(
            `Paid on ${paidDate}, on or before the final payment date ${claim.finalPaymentDate}.`,
          );
        }
      } else if (claim.status !== "paid") {
        daysLate = Math.max(0, wholeDaysBetween(claim.finalPaymentDate, todayISO()));
        if (daysLate === 0) {
          return zero(
            `The final payment date ${claim.finalPaymentDate} has not yet passed — no interest accrues.`,
          );
        }
      }
      const interest = round2(
        (outstanding * def.annualInterestPercent * daysLate) / 100 / 365,
      );
      return {
        claimId,
        status: claim.status,
        currency: claim.currency,
        outstanding,
        finalPaymentDate: claim.finalPaymentDate,
        daysLate,
        annualRate: def.annualInterestPercent,
        interest,
        basis:
          `Simple interest (ACT/365) at ${def.annualInterestPercent}% p.a. on ${claim.currency} ` +
          `${outstanding} for ${daysLate} day(s) past the final payment date ${claim.finalPaymentDate}. ` +
          def.interestNote,
      };
    },
  );
};
