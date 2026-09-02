import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { z } from "zod";
import { obligations, paymentAdjudications, paymentClaims, signals } from "@constructos/db";
import { PAYMENT_ADJUDICATION_STATUSES, PAYMENT_REGIMES, type PaymentRegime } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import { forEachCompany } from "../../lib/scheduler.js";
import { addDaysISO, isoDateSchema, todayISO } from "../field/dates.js";
import { addBusinessDays, findRegime } from "./regimes.js";

/**
 * STATUTORY PAYMENT ADJUDICATION (spec Vol II F #386–390).
 *
 * Every security-of-payment regime provides a fast-track dispute path with a
 * timetable measured in days: notice → referral → response → decision →
 * enforcement. The timetable is COMPUTED from a code-resident model of the
 * regime at referral and each step is an Obligation, so the case, the
 * assurance register and the radar hold the same dates. The model is
 * INDICATIVE (see `ADJUDICATION_RULES` and `disclaimer`): it carries the
 * headline periods of each Act and none of the extensions parties may agree.
 */

export interface AdjudicationRule {
  regime: PaymentRegime;
  /** days from notice of adjudication to referral */
  referralDays: number;
  referralBasis: "calendar" | "business";
  /** days from referral for the respondent's response */
  responseDays: number;
  responseBasis: "calendar" | "business";
  /** days from referral (or response, where the Act says so) to the decision */
  decisionDays: number;
  decisionBasis: "calendar" | "business";
  decisionRunsFrom: "referral" | "response";
  note: string;
}

export const ADJUDICATION_RULES: Record<PaymentRegime, AdjudicationRule> = {
  uk_hgcra: {
    regime: "uk_hgcra",
    referralDays: 7,
    referralBasis: "calendar",
    responseDays: 7,
    responseBasis: "calendar",
    decisionDays: 28,
    decisionBasis: "calendar",
    decisionRunsFrom: "referral",
    note: "Scheme for Construction Contracts: referral within 7 days of the notice; decision within 28 days of referral (extendable by 14 with the referring party's consent). The response period is the Scheme's usual direction, not a statutory figure.",
  },
  sg_sopa: {
    regime: "sg_sopa",
    referralDays: 7,
    referralBasis: "business",
    responseDays: 7,
    responseBasis: "business",
    decisionDays: 14,
    decisionBasis: "business",
    decisionRunsFrom: "response",
    note: "Building and Construction Industry Security of Payment Act: adjudication application within 7 days after the entitlement arises; response within 7 days of service; determination within 14 days after the response period ends.",
  },
  au_nsw_sopa: {
    regime: "au_nsw_sopa",
    referralDays: 10,
    referralBasis: "business",
    responseDays: 5,
    responseBasis: "business",
    decisionDays: 10,
    decisionBasis: "business",
    decisionRunsFrom: "response",
    note: "NSW Building and Construction Industry Security of Payment Act s 17–21: application within 10 business days; response within 5 business days of the application (or 2 of acceptance); determination within 10 business days of the response.",
  },
  my_cipaa: {
    regime: "my_cipaa",
    referralDays: 10,
    referralBasis: "business",
    responseDays: 10,
    responseBasis: "business",
    decisionDays: 45,
    decisionBasis: "business",
    decisionRunsFrom: "response",
    note: "Construction Industry Payment and Adjudication Act 2012 s 9–12: adjudication claim within 10 working days; response within 10 working days; decision within 45 working days from the response (or reply).",
  },
  nz_cca: {
    regime: "nz_cca",
    referralDays: 5,
    referralBasis: "business",
    responseDays: 5,
    responseBasis: "business",
    decisionDays: 20,
    decisionBasis: "business",
    decisionRunsFrom: "response",
    note: "Construction Contracts Act 2002 s 36–46: claim within 5 working days of the adjudicator's acceptance; response within 5 working days; determination within 20 working days after the response period.",
  },
};

export const ADJUDICATION_DISCLAIMER =
  "The timetable is indicative: headline statutory periods with weekend-only working days, no public holidays and no agreed extensions. Confirm against the Act and the adjudicator's directions.";

const addDays = (iso: string, days: number, basis: "calendar" | "business"): string =>
  basis === "business" ? addBusinessDays(iso, days) : addDaysISO(iso, days);

export interface TimetableStep {
  step: "referral" | "response" | "decision";
  dueAt: string;
  basis: string;
  obligationId: string | null;
}

/** Pure: the timetable from the notice date (and referral date, once known). */
export function computeAdjudicationTimetable(
  regime: PaymentRegime,
  noticeAt: string,
  referralAt: string | null,
): TimetableStep[] {
  const rule = ADJUDICATION_RULES[regime];
  const referralDue = addDays(noticeAt, rule.referralDays, rule.referralBasis);
  const steps: TimetableStep[] = [
    { step: "referral", dueAt: referralDue, basis: `${rule.referralDays} ${rule.referralBasis} days from the notice of adjudication`, obligationId: null },
  ];
  const referral = referralAt ?? referralDue;
  const responseDue = addDays(referral, rule.responseDays, rule.responseBasis);
  steps.push({ step: "response", dueAt: responseDue, basis: `${rule.responseDays} ${rule.responseBasis} days from referral`, obligationId: null });
  const decisionFrom = rule.decisionRunsFrom === "referral" ? referral : responseDue;
  steps.push({
    step: "decision",
    dueAt: addDays(decisionFrom, rule.decisionDays, rule.decisionBasis),
    basis: `${rule.decisionDays} ${rule.decisionBasis} days from ${rule.decisionRunsFrom === "referral" ? "referral" : "the response date"}`,
    obligationId: null,
  });
  return steps;
}

const createSchema = z.object({
  regime: z.enum(PAYMENT_REGIMES),
  paymentClaimId: z.string().min(1).max(64).nullable().optional(),
  referringParty: z.enum(["claimant", "respondent"]).optional(),
  disputedAmount: z.number().finite().min(0),
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  noticeAt: isoDateSchema.optional(),
  adjudicatorName: z.string().max(200).nullable().optional(),
  nominatingBody: z.string().max(200).nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const listQuery = pageQuerySchema.extend({ status: z.enum(PAYMENT_ADJUDICATION_STATUSES).optional() });

/** Sweep: decision or response deadlines passed on a live case → breached obligation + signal, once. */
export async function sweepAdjudicationDeadlines(db: Db, companyId: string, today: string = todayISO()): Promise<{ breached: number }> {
  const live = await db
    .select()
    .from(paymentAdjudications)
    .where(and(eq(paymentAdjudications.companyId, companyId), inArray(paymentAdjudications.status, ["referred", "responded"]), isNotNull(paymentAdjudications.decisionDueAt), lt(paymentAdjudications.decisionDueAt, today)));
  let breached = 0;
  for (const c of live) {
    const detail = (c.detail ?? {}) as Record<string, unknown>;
    if (detail["decisionOverdueAt"]) continue;
    const now = new Date().toISOString();
    const flipped = await db
      .update(paymentAdjudications)
      .set({ detail: { ...detail, decisionOverdueAt: now }, updatedAt: now })
      .where(and(eq(paymentAdjudications.id, c.id), eq(paymentAdjudications.status, c.status)))
      .returning({ id: paymentAdjudications.id });
    if (flipped.length === 0) continue;
    breached += 1;
    const steps = c.timetable as TimetableStep[];
    const decision = steps.find((s) => s.step === "decision");
    if (decision?.obligationId) {
      await db.update(obligations).set({ status: "breached" }).where(and(eq(obligations.id, decision.obligationId), eq(obligations.status, "open")));
    }
    await db.insert(signals).values({
      id: newId("sig"),
      companyId,
      projectId: c.projectId,
      detector: "adjudication_decision_overdue",
      severity: "high",
      confidence: 1,
      title: `${c.reference}: adjudication decision was due ${c.decisionDueAt} and none is recorded`,
      explanation: `${ADJUDICATION_RULES[c.regime as PaymentRegime]?.note ?? c.regime} ${ADJUDICATION_DISCLAIMER}`,
    });
    await appendLedger(db, { companyId, actorId: null, action: "state_change", objectType: "payment_adjudication", objectId: c.id, projectId: c.projectId, payload: { decisionOverdue: true, decisionDueAt: c.decisionDueAt } });
  }
  return { breached };
}

export const adjudicationRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("payments", "read")];
  const standardGate = [app.authenticate, app.requireCompany, app.requireTool("payments", "standard")];

  app.scheduler.register({
    name: "payments.adjudication-deadlines",
    description: "Breach the obligation and raise a signal for adjudication decisions past their statutory due date",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => {
      let breached = 0;
      const r = await forEachCompany(db, async (companyId) => {
        breached += (await sweepAdjudicationDeadlines(db, companyId, now.toISOString().slice(0, 10))).breached;
      });
      return { breached, companies: r.companies, failed: r.failed };
    },
  });

  async function fetchCase(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(paymentAdjudications)
      .where(and(eq(paymentAdjudications.id, id), eq(paymentAdjudications.companyId, companyId), eq(paymentAdjudications.projectId, projectId)))
      .limit(1);
    if (!rows[0]) throw notFound("Adjudication case not found");
    return rows[0];
  }

  async function materialiseObligations(c: typeof paymentAdjudications.$inferSelect, actorId: string): Promise<TimetableStep[]> {
    const steps = c.timetable as TimetableStep[];
    const out: TimetableStep[] = [];
    for (const step of steps) {
      if (step.obligationId) {
        await app.db.update(obligations).set({ deadline: `${step.dueAt}T23:59:59Z` }).where(and(eq(obligations.id, step.obligationId), eq(obligations.status, "open")));
        out.push(step);
        continue;
      }
      const id = newId("obl");
      await app.db.insert(obligations).values({
        id,
        companyId: c.companyId,
        projectId: c.projectId,
        sourceClause: `${findRegime(c.regime)?.name ?? c.regime} — adjudication ${step.step}`,
        trigger: `${c.reference}: ${step.step} due`,
        deadline: `${step.dueAt}T23:59:59Z`,
        warnDaysBefore: 2,
        evidenceRequirement: `${step.step} recorded on the adjudication case`,
        status: "open",
        createdBy: actorId,
      });
      out.push({ ...step, obligationId: id });
    }
    await app.db.update(paymentAdjudications).set({ timetable: out }).where(eq(paymentAdjudications.id, c.id));
    return out;
  }

  app.get("/adjudication-rules", { preHandler: [app.authenticate] }, async () => ({ items: Object.values(ADJUDICATION_RULES), indicative: true, disclaimer: ADJUDICATION_DISCLAIMER }));

  app.post("/projects/:projectId/adjudications", { preHandler: standardGate }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    if (body.paymentClaimId) {
      const claim = await app.db.select({ id: paymentClaims.id, currency: paymentClaims.currency }).from(paymentClaims).where(and(eq(paymentClaims.id, body.paymentClaimId), eq(paymentClaims.projectId, req.projectId!))).limit(1);
      if (!claim[0]) throw badRequest("paymentClaimId does not reference a payment claim on this project");
    }
    const number = await nextRecordNumber(app.db, req.projectId!, "payment_adjudication");
    const id = newId("adj");
    const noticeAt = body.noticeAt ?? todayISO();
    const timetable = computeAdjudicationTimetable(body.regime, noticeAt, null);
    await app.db.insert(paymentAdjudications).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      number,
      reference: `ADJ-${String(number).padStart(3, "0")}`,
      paymentClaimId: body.paymentClaimId ?? null,
      regime: body.regime,
      status: "notice",
      referringParty: body.referringParty ?? "claimant",
      disputedAmount: body.disputedAmount,
      currency: (body.currency ?? "GBP").toUpperCase(),
      adjudicatorName: body.adjudicatorName ?? null,
      nominatingBody: body.nominatingBody ?? null,
      noticeAt,
      responseDueAt: timetable.find((s) => s.step === "response")?.dueAt ?? null,
      decisionDueAt: timetable.find((s) => s.step === "decision")?.dueAt ?? null,
      timetable,
      notes: body.notes ?? null,
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });
    const c = await fetchCase(id, req.companyId!, req.projectId!);
    await materialiseObligations(c, req.user!.id);
    await appendLedger(app.db, { companyId: req.companyId!, actorId: req.user!.id, action: "create", objectType: "payment_adjudication", objectId: id, projectId: req.projectId!, payload: { regime: body.regime, disputedAmount: body.disputedAmount, noticeAt, timetable }, storePayload: true });
    return reply.status(201).send({ ...(await fetchCase(id, req.companyId!, req.projectId!)), indicative: true, disclaimer: ADJUDICATION_DISCLAIMER });
  });

  app.get("/projects/:projectId/adjudications", { preHandler: readGate }, async (req) => {
    const q = listQuery.parse(req.query);
    const clauses = [eq(paymentAdjudications.companyId, req.companyId!), eq(paymentAdjudications.projectId, req.projectId!)];
    if (q.status) clauses.push(eq(paymentAdjudications.status, q.status));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(paymentAdjudications).where(where);
    const items = await app.db.select().from(paymentAdjudications).where(where).orderBy(desc(paymentAdjudications.number)).limit(q.pageSize).offset(pageOffset(q));
    return { ...paginate(items, Number(totalRow?.n ?? 0), q), indicative: true, disclaimer: ADJUDICATION_DISCLAIMER };
  });

  app.get("/projects/:projectId/adjudications/:caseId", { preHandler: readGate }, async (req) => {
    const { caseId } = req.params as { caseId: string };
    const c = await fetchCase(caseId, req.companyId!, req.projectId!);
    const steps = c.timetable as TimetableStep[];
    const obl = steps.some((s) => s.obligationId)
      ? await app.db.select().from(obligations).where(inArray(obligations.id, steps.map((s) => s.obligationId).filter((x): x is string => !!x)))
      : [];
    return { ...c, obligations: obl, rule: ADJUDICATION_RULES[c.regime as PaymentRegime] ?? null, indicative: true, disclaimer: ADJUDICATION_DISCLAIMER };
  });

  app.post("/projects/:projectId/adjudications/:caseId/refer", { preHandler: standardGate }, async (req) => {
    const { caseId } = req.params as { caseId: string };
    const body = z.object({ referralAt: isoDateSchema.optional(), adjudicatorName: z.string().max(200).nullable().optional() }).parse(req.body ?? {});
    const c = await fetchCase(caseId, req.companyId!, req.projectId!);
    if (c.status !== "notice") throw conflict(`A ${c.status} case cannot be referred`);
    const referralAt = body.referralAt ?? todayISO();
    const prior = c.timetable as TimetableStep[];
    const recomputed = computeAdjudicationTimetable(c.regime as PaymentRegime, c.noticeAt ?? referralAt, referralAt).map((s) => ({
      ...s,
      obligationId: prior.find((p) => p.step === s.step)?.obligationId ?? null,
    }));
    const referralStep = recomputed.find((s) => s.step === "referral");
    if (referralStep?.obligationId) {
      await app.db.update(obligations).set({ status: referralAt <= referralStep.dueAt ? "satisfied" : "breached" }).where(and(eq(obligations.id, referralStep.obligationId), eq(obligations.status, "open")));
    }
    await app.db
      .update(paymentAdjudications)
      .set({
        status: "referred",
        referralAt,
        adjudicatorName: body.adjudicatorName ?? c.adjudicatorName,
        responseDueAt: recomputed.find((s) => s.step === "response")?.dueAt ?? null,
        decisionDueAt: recomputed.find((s) => s.step === "decision")?.dueAt ?? null,
        timetable: recomputed,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(paymentAdjudications.id, caseId));
    await materialiseObligations(await fetchCase(caseId, req.companyId!, req.projectId!), req.user!.id);
    await appendLedger(app.db, { companyId: req.companyId!, actorId: req.user!.id, action: "state_change", objectType: "payment_adjudication", objectId: caseId, projectId: req.projectId!, payload: { from: "notice", to: "referred", referralAt, timetable: recomputed }, storePayload: true });
    return fetchCase(caseId, req.companyId!, req.projectId!);
  });

  app.post("/projects/:projectId/adjudications/:caseId/respond", { preHandler: standardGate }, async (req) => {
    const { caseId } = req.params as { caseId: string };
    const body = z.object({ responseAt: isoDateSchema.optional(), summary: z.string().max(20000).nullable().optional() }).parse(req.body ?? {});
    const c = await fetchCase(caseId, req.companyId!, req.projectId!);
    if (c.status !== "referred") throw conflict(`A ${c.status} case is not awaiting a response`);
    const responseAt = body.responseAt ?? todayISO();
    const late = c.responseDueAt !== null && responseAt > c.responseDueAt;
    const step = (c.timetable as TimetableStep[]).find((s) => s.step === "response");
    if (step?.obligationId) {
      await app.db.update(obligations).set({ status: late ? "breached" : "satisfied" }).where(and(eq(obligations.id, step.obligationId), eq(obligations.status, "open")));
    }
    await app.db.update(paymentAdjudications).set({ status: "responded", responseAt, detail: { ...(c.detail ?? {}), responseSummary: body.summary ?? null, responseLate: late }, updatedAt: new Date().toISOString() }).where(eq(paymentAdjudications.id, caseId));
    await appendLedger(app.db, { companyId: req.companyId!, actorId: req.user!.id, action: "state_change", objectType: "payment_adjudication", objectId: caseId, projectId: req.projectId!, payload: { from: "referred", to: "responded", responseAt, late }, storePayload: true });
    return fetchCase(caseId, req.companyId!, req.projectId!);
  });

  app.post("/projects/:projectId/adjudications/:caseId/decide", { preHandler: standardGate }, async (req) => {
    const { caseId } = req.params as { caseId: string };
    const body = z.object({ decisionAt: isoDateSchema.optional(), decisionAmount: z.number().finite().min(0), decisionSummary: z.string().min(1).max(20000) }).parse(req.body);
    const c = await fetchCase(caseId, req.companyId!, req.projectId!);
    if (c.status !== "referred" && c.status !== "responded") throw conflict(`A ${c.status} case cannot be decided`);
    const decisionAt = body.decisionAt ?? todayISO();
    const late = c.decisionDueAt !== null && decisionAt > c.decisionDueAt;
    const step = (c.timetable as TimetableStep[]).find((s) => s.step === "decision");
    if (step?.obligationId) {
      await app.db.update(obligations).set({ status: late ? "breached" : "satisfied" }).where(and(eq(obligations.id, step.obligationId), eq(obligations.status, "open")));
    }
    await app.db.update(paymentAdjudications).set({ status: "decided", decisionAt, decisionAmount: body.decisionAmount, decisionSummary: body.decisionSummary, updatedAt: new Date().toISOString() }).where(eq(paymentAdjudications.id, caseId));
    await appendLedger(app.db, { companyId: req.companyId!, actorId: req.user!.id, action: "state_change", objectType: "payment_adjudication", objectId: caseId, projectId: req.projectId!, payload: { from: c.status, to: "decided", decisionAt, decisionAmount: body.decisionAmount, late }, storePayload: true });
    return fetchCase(caseId, req.companyId!, req.projectId!);
  });

  for (const [action, from, to] of [
    ["enforce", ["decided"], "enforced"],
    ["settle", ["notice", "referred", "responded", "decided"], "settled"],
    ["withdraw", ["notice", "referred", "responded"], "withdrawn"],
  ] as const) {
    app.post(`/projects/:projectId/adjudications/:caseId/${action}`, { preHandler: standardGate }, async (req) => {
      const { caseId } = req.params as { caseId: string };
      const body = z.object({ note: z.string().max(4000).nullable().optional(), amount: z.number().finite().min(0).optional() }).parse(req.body ?? {});
      const c = await fetchCase(caseId, req.companyId!, req.projectId!);
      if (!(from as readonly string[]).includes(c.status)) throw conflict(`Cannot ${action} a ${c.status} case`);
      const now = new Date().toISOString();
      await app.db
        .update(paymentAdjudications)
        .set({
          status: to,
          ...(to === "enforced" ? { enforcedAt: todayISO() } : {}),
          detail: { ...(c.detail ?? {}), [`${to}Note`]: body.note ?? null, ...(body.amount !== undefined ? { settledAmount: body.amount } : {}) },
          updatedAt: now,
        })
        .where(eq(paymentAdjudications.id, caseId));
      /* a closed case moots its open deadlines */
      const openIds = (c.timetable as TimetableStep[]).map((s) => s.obligationId).filter((x): x is string => !!x);
      if (to !== "enforced" && openIds.length > 0) {
        await app.db.update(obligations).set({ status: "satisfied" }).where(and(inArray(obligations.id, openIds), eq(obligations.status, "open")));
      }
      await appendLedger(app.db, { companyId: req.companyId!, actorId: req.user!.id, action: "state_change", objectType: "payment_adjudication", objectId: caseId, projectId: req.projectId!, payload: { from: c.status, to, ...body }, storePayload: true });
      return fetchCase(caseId, req.companyId!, req.projectId!);
    });
  }

  /** Deadline radar for cases: the next response/decision dates, soonest first. */
  app.get("/projects/:projectId/adjudications-radar", { preHandler: readGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(paymentAdjudications)
      .where(and(eq(paymentAdjudications.companyId, req.companyId!), eq(paymentAdjudications.projectId, req.projectId!), inArray(paymentAdjudications.status, ["notice", "referred", "responded"])))
      .orderBy(asc(paymentAdjudications.decisionDueAt));
    const today = todayISO();
    const days = (iso: string | null) => (iso ? Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null);
    return {
      items: rows.map((c) => ({
        id: c.id,
        reference: c.reference,
        status: c.status,
        regime: c.regime,
        disputedAmount: c.disputedAmount,
        currency: c.currency,
        nextStep: c.status === "notice" ? "referral" : c.status === "referred" ? "response" : "decision",
        nextDueAt: c.status === "notice" ? ((c.timetable as TimetableStep[]).find((s) => s.step === "referral")?.dueAt ?? null) : c.status === "referred" ? c.responseDueAt : c.decisionDueAt,
        daysRemaining: days(c.status === "notice" ? ((c.timetable as TimetableStep[]).find((s) => s.step === "referral")?.dueAt ?? null) : c.status === "referred" ? c.responseDueAt : c.decisionDueAt),
      })),
      indicative: true,
      disclaimer: ADJUDICATION_DISCLAIMER,
    };
  });
};
