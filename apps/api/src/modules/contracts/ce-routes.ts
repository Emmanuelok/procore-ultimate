import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  acceptedProgrammes,
  ceQuotations,
  contractEvents,
  contracts,
  obligations,
  contractObligationLinks,
} from "@constructos/db";
import {
  CE_STATES,
  PROGRAMME_REJECTION_REASONS,
  SCC_COMPONENTS,
  type CeState,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isoDateSchema, todayISO } from "../field/dates.js";
import { canTransition, computeQuotation, deemedAcceptance, NEC_CLOCKS, necValuationBasis } from "./ce.js";
import { addDaysOnCalendar } from "./timebar.js";

const ceStateSchema = z.object({
  state: z.enum(CE_STATES),
  /** 62.1 instruction reference when moving to quotation_requested */
  instructionRef: z.string().max(200).optional(),
  reason: z.string().max(4000).optional(),
});

const quotationSchema = z.object({
  components: z
    .array(
      z.object({
        component: z.enum(SCC_COMPONENTS),
        description: z.string().min(1).max(500),
        unit: z.string().max(20).nullable().optional(),
        qty: z.number().finite(),
        rate: z.number().finite(),
      }),
    )
    .min(1)
    .max(200),
  feePercent: z.number().min(0).max(100),
  riskAllowance: z.number().min(0).optional(),
  timeImpactDays: z.number().int().min(0).max(3650).optional(),
  assumptions: z.string().max(20000).nullable().optional(),
});

const replySchema = z.object({
  decision: z.enum(["accepted", "rejected", "revision_requested", "pm_assessment"]),
  reason: z.string().max(4000).optional(),
});

const programmeSchema = z.object({
  revision: z.string().max(40).nullable().optional(),
  scheduleId: z.string().max(60).nullable().optional(),
  submittedAt: isoDateSchema,
  plannedCompletion: isoDateSchema.nullable().optional(),
  terminalFloatDays: z.number().int().min(-3650).max(3650).nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
});

const programmeDecisionSchema = z.object({
  decision: z.enum(["accepted", "rejected"]),
  decisionAt: isoDateSchema.optional(),
  rejectionReason: z.enum(PROGRAMME_REJECTION_REASONS).optional(),
  rejectionDetail: z.string().max(4000).optional(),
});

/**
 * NEC compensation-event cycle and the accepted-programme register
 * (spec Vol II Domain C #206-211).
 *
 * The CE sub-state machine runs alongside the generic notice/time-bar axis:
 * `contract_events.status` remains the notice story, `ceState` is the NEC
 * story, and the clocks (62.3 quotation, 62.3 reply, 62.6 deemed acceptance)
 * are computed on the contract's calendar and swept by `contracts.ce-clocks`.
 */
export const ceRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("contracts", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("contracts", "standard"),
  ];

  async function fetchContract(contractId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(contracts)
      .where(
        and(
          eq(contracts.id, contractId),
          eq(contracts.companyId, companyId),
          eq(contracts.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Contract not found");
    return rows[0];
  }

  async function fetchCeEvent(
    eventId: string,
    contractId: string,
    companyId: string,
    projectId: string,
  ) {
    const rows = await app.db
      .select()
      .from(contractEvents)
      .where(
        and(
          eq(contractEvents.id, eventId),
          eq(contractEvents.contractId, contractId),
          eq(contractEvents.companyId, companyId),
          eq(contractEvents.projectId, projectId),
        ),
      )
      .limit(1);
    const ev = rows[0];
    if (!ev) throw notFound("Contract event not found");
    if (ev.kind !== "compensation_event") {
      throw badRequest("This event is not a compensation event");
    }
    return ev;
  }

  function calendarOf(contract: typeof contracts.$inferSelect) {
    return {
      basis: contract.calendarBasis as "calendar" | "working",
      holidays: contract.holidays,
    };
  }

  /* ---------------------------------------------------------------- */
  /* CE state machine                                                  */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/contracts/:contractId/events/:eventId/ce-state",
    { preHandler: standardGate },
    async (req) => {
      const { contractId, eventId } = req.params as { contractId: string; eventId: string };
      const body = ceStateSchema.parse(req.body);
      const contract = await fetchContract(contractId, req.companyId!, req.projectId!);
      if (!contract.form.startsWith("nec")) {
        throw badRequest("The compensation-event cycle applies to NEC contracts only");
      }
      const ev = await fetchCeEvent(eventId, contractId, req.companyId!, req.projectId!);
      const from = (ev.ceState ?? "notified") as CeState;
      if (!canTransition(from, body.state)) {
        throw badRequest(`A compensation event cannot move from ${from} to ${body.state}`);
      }
      const cal = calendarOf(contract);
      const now = new Date().toISOString();
      const today = todayISO();
      const set: Record<string, unknown> = { ceState: body.state, updatedAt: now };

      // 62.1: instructing a quotation starts the Contractor's three weeks.
      if (body.state === "quotation_requested") {
        if (!body.instructionRef) {
          throw badRequest("Instructing a quotation requires the instruction reference (62.1)");
        }
        const due = addDaysOnCalendar(today, NEC_CLOCKS.quotationSubmission, cal.basis, cal.holidays);
        set["quotationDueDate"] = due;
        set["noticeReference"] = body.instructionRef;
      }
      if (body.state === "rejected" && !body.reason) {
        throw badRequest("Rejecting a compensation event requires a reason");
      }
      await app.db.update(contractEvents).set(set).where(eq(contractEvents.id, eventId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "contract_event",
        objectId: eventId,
        projectId: req.projectId!,
        payload: {
          ceState: { from, to: body.state },
          instructionRef: body.instructionRef ?? null,
          quotationDueDate: set["quotationDueDate"] ?? null,
          reason: body.reason ?? null,
        },
      });
      const updated = await fetchCeEvent(eventId, contractId, req.companyId!, req.projectId!);
      return { ...updated, necBasis: necValuationBasis(contract.necOption as never) };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Quotations (#207-208)                                             */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/contracts/:contractId/events/:eventId/quotations",
    { preHandler: readGate },
    async (req) => {
      const { contractId, eventId } = req.params as { contractId: string; eventId: string };
      const contract = await fetchContract(contractId, req.companyId!, req.projectId!);
      await fetchCeEvent(eventId, contractId, req.companyId!, req.projectId!);
      const items = await app.db
        .select()
        .from(ceQuotations)
        .where(eq(ceQuotations.eventId, eventId))
        .orderBy(desc(ceQuotations.number));
      const today = todayISO();
      return {
        items: items.map((q) => ({
          ...q,
          clock: deemedAcceptance({
            quotationStatus: q.status,
            replyDueDate: q.replyDueDate,
            repliedAt: q.repliedAt,
            today,
            form: contract.form,
          }),
        })),
        total: items.length,
      };
    },
  );

  app.post(
    "/projects/:projectId/contracts/:contractId/events/:eventId/quotations",
    { preHandler: standardGate },
    async (req, reply) => {
      const { contractId, eventId } = req.params as { contractId: string; eventId: string };
      const body = quotationSchema.parse(req.body);
      const contract = await fetchContract(contractId, req.companyId!, req.projectId!);
      if (!contract.form.startsWith("nec")) {
        throw badRequest("Compensation-event quotations apply to NEC contracts only");
      }
      const ev = await fetchCeEvent(eventId, contractId, req.companyId!, req.projectId!);
      const open = await app.db
        .select({ id: ceQuotations.id, number: ceQuotations.number })
        .from(ceQuotations)
        .where(and(eq(ceQuotations.eventId, eventId), eq(ceQuotations.status, "submitted")))
        .limit(1);
      if (open[0]) {
        throw conflict(
          `Quotation ${open[0].number} is awaiting the Project Manager's reply; it must be replied to before another is submitted.`,
        );
      }

      const computed = computeQuotation(body.components, body.feePercent, body.riskAllowance ?? 0);
      const cal = calendarOf(contract);
      const today = todayISO();
      const replyDueDate = addDaysOnCalendar(
        today,
        NEC_CLOCKS.pmReplyToQuotation,
        cal.basis,
        cal.holidays,
      );
      const [numberRow] = await app.db
        .select({ n: count() })
        .from(ceQuotations)
        .where(eq(ceQuotations.eventId, eventId));
      const number = Number(numberRow?.n ?? 0) + 1;
      const id = newId("ceq");

      await app.db.transaction(async (tx) => {
        await tx.insert(ceQuotations).values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          contractId,
          eventId,
          number,
          status: "submitted",
          currency: contract.currency,
          components: computed.components,
          definedCost: computed.definedCost,
          feePercent: computed.feePercent,
          fee: computed.fee,
          riskAllowance: computed.riskAllowance,
          total: computed.total,
          timeImpactDays: body.timeImpactDays ?? 0,
          assumptions: body.assumptions ?? null,
          submittedBy: req.user!.id,
          replyDueDate,
        });
        await tx
          .update(contractEvents)
          .set({
            ceState: "quotation_submitted",
            replyDueDate,
            costImpactEstimate: computed.total,
            timeImpactDaysEstimate: body.timeImpactDays ?? ev.timeImpactDaysEstimate,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(contractEvents.id, eventId));
        // The Project Manager's reply is an obligation with a deadline, so it
        // shows up in the same register as every other contractual clock.
        const obligationId = newId("obl");
        await tx.insert(obligations).values({
          id: obligationId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          sourceClause: `${contract.form} 62.3`,
          trigger: `Reply to quotation ${number} on compensation event #${ev.number}`,
          deadline: `${replyDueDate}T23:59:59Z`,
          warnDaysBefore: 3,
          evidenceRequirement: "Project Manager's reply",
          status: "open",
          createdBy: req.user!.id,
        });
        await tx.insert(contractObligationLinks).values({
          id: newId("col"),
          companyId: req.companyId!,
          projectId: req.projectId!,
          contractId,
          contractEventId: eventId,
          obligationId,
          kind: "chain",
          clauseRef: "62.3",
        });
      });

      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "ce_quotation",
        objectId: id,
        projectId: req.projectId!,
        payload: {
          number,
          eventId,
          definedCost: computed.definedCost,
          fee: computed.fee,
          total: computed.total,
          timeImpactDays: body.timeImpactDays ?? 0,
          replyDueDate,
        },
        storePayload: true,
      });
      const created = await app.db
        .select()
        .from(ceQuotations)
        .where(eq(ceQuotations.id, id))
        .limit(1);
      return reply.status(201).send({ ...created[0], byComponent: computed.byComponent });
    },
  );

  /** The Project Manager's reply (62.3). A different actor from the submitter. */
  app.post("/ce-quotations/:quotationId/reply", { preHandler: [app.authenticate, app.requireCompany] }, async (req, reply) => {
    const { quotationId } = req.params as { quotationId: string };
    const body = replySchema.parse(req.body);
    const rows = await app.db
      .select()
      .from(ceQuotations)
      .where(and(eq(ceQuotations.id, quotationId), eq(ceQuotations.companyId, req.companyId!)))
      .limit(1);
    const q = rows[0];
    if (!q) throw notFound("Quotation not found");
    (req.params as Record<string, string>)["projectId"] = q.projectId;
    await app.requireTool("contracts", "standard")(req, reply);
    if (q.status !== "submitted") {
      throw badRequest(`A ${q.status} quotation cannot be replied to`);
    }
    if (q.submittedBy === req.user!.id) {
      throw forbidden("A quotation cannot be replied to by the person who submitted it");
    }
    if (body.decision !== "accepted" && !body.reason) {
      throw badRequest("Rejecting, assessing or asking for a revision requires a reason");
    }

    const now = new Date().toISOString();
    const nextCeState: CeState =
      body.decision === "accepted"
        ? "implemented"
        : body.decision === "pm_assessment"
          ? "pm_assessment"
          : body.decision === "revision_requested"
            ? "quotation_requested"
            : "pm_replied";
    await app.db.transaction(async (tx) => {
      await tx
        .update(ceQuotations)
        .set({
          status: body.decision,
          repliedBy: req.user!.id,
          repliedAt: now,
          replyReason: body.reason ?? null,
          updatedAt: now,
        })
        .where(and(eq(ceQuotations.id, quotationId), eq(ceQuotations.status, "submitted")));
      await tx
        .update(contractEvents)
        .set({ ceState: nextCeState, updatedAt: now })
        .where(eq(contractEvents.id, q.eventId));
      const links = await tx
        .select({ obligationId: contractObligationLinks.obligationId })
        .from(contractObligationLinks)
        .where(
          and(
            eq(contractObligationLinks.contractEventId, q.eventId),
            eq(contractObligationLinks.clauseRef, "62.3"),
          ),
        );
      for (const l of links) {
        await tx
          .update(obligations)
          .set({ status: "satisfied" })
          .where(and(eq(obligations.id, l.obligationId), eq(obligations.status, "open")));
      }
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "ce_quotation",
      objectId: quotationId,
      projectId: q.projectId,
      payload: {
        from: "submitted",
        to: body.decision,
        reason: body.reason ?? null,
        total: q.total,
        ceState: nextCeState,
      },
      storePayload: true,
    });
    const updated = await app.db
      .select()
      .from(ceQuotations)
      .where(eq(ceQuotations.id, quotationId))
      .limit(1);
    return updated[0];
  });

  /* ---------------------------------------------------------------- */
  /* Accepted programme register (#209-210)                            */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/contracts/:contractId/programmes",
    { preHandler: readGate },
    async (req) => {
      const { contractId } = req.params as { contractId: string };
      const q = pageQuerySchema.parse(req.query);
      await fetchContract(contractId, req.companyId!, req.projectId!);
      const where = and(
        eq(acceptedProgrammes.companyId, req.companyId!),
        eq(acceptedProgrammes.contractId, contractId),
      );
      const [totalRow] = await app.db.select({ n: count() }).from(acceptedProgrammes).where(where);
      const items = await app.db
        .select()
        .from(acceptedProgrammes)
        .where(where)
        .orderBy(desc(acceptedProgrammes.number))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      const accepted = items.find((p) => p.status === "accepted") ?? null;
      return {
        ...paginate(items, Number(totalRow?.n ?? 0), q),
        currentAcceptedProgrammeId: accepted?.id ?? null,
      };
    },
  );

  app.post(
    "/projects/:projectId/contracts/:contractId/programmes",
    { preHandler: standardGate },
    async (req, reply) => {
      const { contractId } = req.params as { contractId: string };
      const body = programmeSchema.parse(req.body);
      const contract = await fetchContract(contractId, req.companyId!, req.projectId!);
      const cal = calendarOf(contract);
      const [numberRow] = await app.db
        .select({ n: count() })
        .from(acceptedProgrammes)
        .where(eq(acceptedProgrammes.contractId, contractId));
      const number = Number(numberRow?.n ?? 0) + 1;
      const id = newId("apr");
      // NEC 31.3: the Project Manager replies within two weeks of submission.
      const decisionDue = addDaysOnCalendar(body.submittedAt, 14, cal.basis, cal.holidays);
      await app.db.transaction(async (tx) => {
        // A newly submitted programme supersedes any earlier SUBMITTED one;
        // the accepted programme stays accepted until a new one is accepted.
        await tx
          .update(acceptedProgrammes)
          .set({ status: "superseded", updatedAt: new Date().toISOString() })
          .where(
            and(
              eq(acceptedProgrammes.contractId, contractId),
              eq(acceptedProgrammes.status, "submitted"),
            ),
          );
        await tx.insert(acceptedProgrammes).values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          contractId,
          number,
          revision: body.revision ?? null,
          scheduleId: body.scheduleId ?? null,
          submittedAt: body.submittedAt,
          submittedBy: req.user!.id,
          status: "submitted",
          decisionDueDate: decisionDue,
          plannedCompletion: body.plannedCompletion ?? null,
          terminalFloatDays: body.terminalFloatDays ?? null,
          notes: body.notes ?? null,
        });
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "accepted_programme",
        objectId: id,
        projectId: req.projectId!,
        payload: {
          number,
          submittedAt: body.submittedAt,
          decisionDueDate: decisionDue,
          plannedCompletion: body.plannedCompletion ?? null,
        },
      });
      const created = await app.db
        .select()
        .from(acceptedProgrammes)
        .where(eq(acceptedProgrammes.id, id))
        .limit(1);
      return reply.status(201).send(created[0]);
    },
  );

  app.post(
    "/projects/:projectId/contracts/:contractId/programmes/:programmeId/decide",
    { preHandler: standardGate },
    async (req) => {
      const { contractId, programmeId } = req.params as {
        contractId: string;
        programmeId: string;
      };
      const body = programmeDecisionSchema.parse(req.body);
      await fetchContract(contractId, req.companyId!, req.projectId!);
      const rows = await app.db
        .select()
        .from(acceptedProgrammes)
        .where(
          and(
            eq(acceptedProgrammes.id, programmeId),
            eq(acceptedProgrammes.contractId, contractId),
            eq(acceptedProgrammes.companyId, req.companyId!),
          ),
        )
        .limit(1);
      const programme = rows[0];
      if (!programme) throw notFound("Programme not found");
      if (programme.status !== "submitted") {
        throw badRequest(`A ${programme.status} programme cannot be decided`);
      }
      if (programme.submittedBy === req.user!.id) {
        throw forbidden("A programme cannot be accepted or rejected by the person who submitted it");
      }
      if (body.decision === "rejected" && !body.rejectionReason) {
        throw badRequest(
          "NEC 31.3 requires one of the four stated reasons for not accepting a programme",
        );
      }
      const decisionAt = body.decisionAt ?? todayISO();
      await app.db.transaction(async (tx) => {
        if (body.decision === "accepted") {
          await tx
            .update(acceptedProgrammes)
            .set({ status: "superseded", updatedAt: new Date().toISOString() })
            .where(
              and(
                eq(acceptedProgrammes.contractId, contractId),
                eq(acceptedProgrammes.status, "accepted"),
              ),
            );
        }
        await tx
          .update(acceptedProgrammes)
          .set({
            status: body.decision,
            decisionAt,
            decisionBy: req.user!.id,
            rejectionReason: body.rejectionReason ?? null,
            rejectionDetail: body.rejectionDetail ?? null,
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(eq(acceptedProgrammes.id, programmeId), eq(acceptedProgrammes.status, "submitted")),
          );
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "accepted_programme",
        objectId: programmeId,
        projectId: req.projectId!,
        payload: {
          from: "submitted",
          to: body.decision,
          decisionAt,
          rejectionReason: body.rejectionReason ?? null,
          lateDecision: programme.decisionDueDate != null && decisionAt > programme.decisionDueDate,
        },
        storePayload: true,
      });
      const updated = await app.db
        .select()
        .from(acceptedProgrammes)
        .where(eq(acceptedProgrammes.id, programmeId))
        .limit(1);
      return updated[0];
    },
  );

  /** The NEC valuation basis this contract's main option implies (#211). */
  app.get(
    "/projects/:projectId/contracts/:contractId/nec-basis",
    { preHandler: readGate },
    async (req) => {
      const { contractId } = req.params as { contractId: string };
      const contract = await fetchContract(contractId, req.companyId!, req.projectId!);
      if (!contract.form.startsWith("nec")) {
        return {
          applicable: false as const,
          reason: `${contract.form} is not an NEC form; the NEC main-option basis does not apply.`,
        };
      }
      const quotations = await app.db
        .select({ total: ceQuotations.total, status: ceQuotations.status })
        .from(ceQuotations)
        .where(eq(ceQuotations.contractId, contractId));
      const implemented = quotations.filter(
        (q) => q.status === "accepted" || q.status === "deemed_accepted",
      );
      return {
        applicable: true as const,
        necOption: contract.necOption,
        ...necValuationBasis(contract.necOption as never),
        currency: contract.currency,
        implementedCompensationEvents: implemented.length,
        implementedValue: Math.round(implemented.reduce((s, q) => s + q.total, 0) * 100) / 100,
      };
    },
  );
};
