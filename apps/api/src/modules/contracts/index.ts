import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";
import {
  contractEvents,
  contractObligationLinks,
  contracts,
  eotClaims,
  obligations,
  type ParticularCondition,
} from "@constructos/db";
import {
  CALENDAR_BASES,
  CLAUSE_CATEGORIES,
  CONTRACT_EVENT_KINDS,
  CONTRACT_EVENT_STATUSES,
  CONTRACT_FORMS,
  CONTRACT_STATUSES,
  NEC_OPTIONS,
  type ContractForm,
  type NecOption,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { addDaysISO, isoDateSchema, todayISO } from "../field/dates.js";
import { necValuationBasis } from "./ce.js";
import { ceRoutes } from "./ce-routes.js";
import { CLAUSE_LIBRARY, clausesForForm } from "./clause-library.js";
import { complianceRoutes } from "./compliance-routes.js";
import { raiseSignalOnce, registerContractJobs, sweepTimeBars } from "./sweeps.js";
import {
  chainedDeadlines,
  computeDeadline,
  daysBetweenIso,
  effectiveClauses,
  resolveClause,
} from "./timebar.js";
import { computeLdExposure } from "../commercial/valuation-engine.js";
import { buildNoticePack } from "./notice.js";
import { aiDisabledError, aiEnabled, runAgent, type InputRef } from "../ai/service.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

/** Lenient ISO timestamp (avoids zod version drift on .datetime()). */
const isoTimestamp = z
  .string()
  .min(4)
  .refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO timestamp");

/**
 * Particular Conditions are STRUCTURED (#201-202). `amendment` is the human
 * text; the optional fields are what the time-bar engine acts on. An amendment
 * with no structured bar is still flagged as amended, so the UI can warn that
 * the wording changed even where the engine cannot act on it.
 */
const particularConditionSchema = z.object({
  clauseRef: z.string().min(1).max(40),
  amendment: z.string().min(1).max(4000),
  timeBarDays: z.number().int().min(0).max(3650).nullable().optional(),
  noticeRequired: z.boolean().optional(),
  calendarBasis: z.enum(CALENDAR_BASES).optional(),
  warnDaysBefore: z.number().int().min(0).max(365).optional(),
  deleted: z.boolean().optional(),
});

const contractCreateSchema = z.object({
  name: z.string().min(1).max(300),
  form: z.enum(CONTRACT_FORMS),
  necOption: z.enum(NEC_OPTIONS).optional(),
  parties: z.record(z.string(), z.string()).optional(),
  baseDate: isoDateSchema.nullable().optional(),
  commencementDate: isoDateSchema.nullable().optional(),
  completionDate: isoDateSchema.nullable().optional(),
  takingOverDate: isoDateSchema.nullable().optional(),
  actualCompletionDate: isoDateSchema.nullable().optional(),
  currency: z.string().length(3).optional(),
  contractSum: z.number().nonnegative().nullable().optional(),
  retentionPercent: z.number().min(0).max(100).optional(),
  retentionCap: z.number().nonnegative().nullable().optional(),
  retentionReleaseAtTakingOver: z.number().min(0).max(1).optional(),
  defectsPeriodMonths: z.number().int().min(0).max(240).nullable().optional(),
  ldRatePerDay: z.number().nonnegative().nullable().optional(),
  ldCap: z.number().nonnegative().nullable().optional(),
  paymentDueDays: z.number().int().min(0).max(365).nullable().optional(),
  calendarBasis: z.enum(CALENDAR_BASES).optional(),
  holidays: z.array(isoDateSchema).max(400).optional(),
  jurisdiction: z.string().max(80).nullable().optional(),
  particularConditions: z.array(particularConditionSchema).max(200).optional(),
});

const contractPatchSchema = contractCreateSchema.partial();

const contractListQuery = pageQuerySchema.extend({
  status: z.enum(CONTRACT_STATUSES).optional(),
  form: z.enum(CONTRACT_FORMS).optional(),
});

const contractStatusSchema = z.object({
  status: z.enum(["executed", "completed", "terminated"]),
  takingOverDate: isoDateSchema.optional(),
  actualCompletionDate: isoDateSchema.optional(),
});

/** Forward-only lifecycle: draft → executed → completed | terminated. */
const CONTRACT_TRANSITIONS: Record<string, string[]> = {
  draft: ["executed"],
  executed: ["completed", "terminated"],
  completed: [],
  terminated: [],
};

const eventCreateSchema = z.object({
  kind: z.enum(CONTRACT_EVENT_KINDS),
  clauseRef: z.string().min(1).max(40).nullable().optional(),
  title: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  eventDate: isoDateSchema,
  /** the date the claiming party became aware — the bar usually runs from here */
  awarenessDate: isoDateSchema.nullable().optional(),
  /** bespoke forms and unlisted clauses: state the bar directly (#193-224) */
  timeBarDays: z.number().int().min(1).max(3650).nullable().optional(),
  noticeDeadline: isoDateSchema.nullable().optional(),
  costImpactEstimate: z.number().nullable().optional(),
  timeImpactDaysEstimate: z.number().int().nullable().optional(),
});

const eventListQuery = pageQuerySchema.extend({
  kind: z.enum(CONTRACT_EVENT_KINDS).optional(),
  status: z.enum(CONTRACT_EVENT_STATUSES).optional(),
});

const serveNoticeSchema = z.object({
  method: z.enum(["email", "letter", "portal", "registered_post"]),
  reference: z.string().max(300).nullable().optional(),
  servedAt: isoTimestamp.optional(),
  /** required when backdating service by more than a day */
  reason: z.string().max(2000).optional(),
  evidenceRef: z.string().max(300).optional(),
});

const eventStatusSchema = z.object({ status: z.enum(["resolved", "withdrawn"]) });

const eotCreateSchema = z.object({
  title: z.string().min(1).max(300),
  clauseRef: z.string().min(1).max(40).nullable().optional(),
  eventIds: z.array(z.string().min(1)).max(100).optional(),
  daysClaimed: z.number().int().min(1).max(10000),
  narrative: z.string().max(20000).nullable().optional(),
});

const eotListQuery = pageQuerySchema.extend({
  status: z.enum(["notified", "submitted", "assessed", "agreed", "rejected", "referred"]).optional(),
});

const eotStatusSchema = z.object({
  status: z.enum(["submitted", "assessed", "agreed", "rejected", "referred"]),
  daysAwarded: z.number().int().min(0).max(10000).optional(),
  /** the assessment record: method, concurrency, float ownership, reasons */
  assessment: z
    .object({
      method: z
        .enum([
          "as_planned_impacted",
          "time_impact_analysis",
          "collapsed_as_built",
          "as_planned_versus_as_built",
          "time_slice_windows",
          "impacted_as_planned_windows",
        ])
        .optional(),
      concurrency: z.enum(["none", "true_concurrency", "sequential", "pacing"]).optional(),
      floatOwnership: z.enum(["project", "contractor", "employer", "shared"]).optional(),
      reasons: z.string().max(20000).optional(),
      criticalPathEffectDays: z.number().int().optional(),
    })
    .optional(),
});

const EOT_TRANSITIONS: Record<string, string[]> = {
  notified: ["submitted"],
  submitted: ["assessed"],
  assessed: ["agreed", "rejected", "referred"],
  agreed: [],
  rejected: [],
  referred: [],
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Whole days from today (UTC) to an ISO date; negative = already past. */
function daysUntil(isoDate: string): number {
  return daysBetweenIso(todayISO(), isoDate);
}

function necFormCheck(form: string, necOption: string | null | undefined): void {
  const isNec = form.startsWith("nec");
  if (isNec && !necOption) {
    throw badRequest("necOption is required for NEC contract forms (A-F)");
  }
  if (!isNec && necOption) {
    throw badRequest("necOption is only applicable to NEC contract forms");
  }
}

/**
 * Contract intelligence — spec Vol II Domain C / M8 (#193-264).
 *
 * Code-resident clause library; contract register with a STRUCTURED Particular
 * Conditions overlay that actually drives the time-bar engine (#201-202); the
 * notice/event register with pre-expiry warnings, calendar-aware arithmetic and
 * chained deadlines (#225-231); NEC compensation-event cycle and accepted
 * programmes (#206-211, in ce-routes.ts); insurance/bond clause compliance
 * (#251-253, in compliance-routes.ts); the EOT claim lifecycle with a recorded
 * assessment (#237-240); and LD exposure that stops at taking-over (#249-250).
 *
 * Obligations belong to a CONTRACT through `contract_obligation_links` — the
 * `obligations` table is owned by the assurance package, so the link is an
 * explicit join rather than a column this package does not own.
 */
export const contractsModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("contracts", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("contracts", "standard"),
  ];
  const adminGate = [app.authenticate, app.requireCompany, app.requireTool("contracts", "admin")];

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

  async function fetchEvent(
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
    if (!rows[0]) throw notFound("Contract event not found");
    return rows[0];
  }

  async function fetchEotClaim(
    claimId: string,
    contractId: string,
    companyId: string,
    projectId: string,
  ) {
    const rows = await app.db
      .select()
      .from(eotClaims)
      .where(
        and(
          eq(eotClaims.id, claimId),
          eq(eotClaims.contractId, contractId),
          eq(eotClaims.companyId, companyId),
          eq(eotClaims.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("EOT claim not found");
    return rows[0];
  }

  /* ---------------------------------------------------------------- */
  /* Clause library (reference data, not tenant data)                  */
  /* ---------------------------------------------------------------- */

  app.get("/contract-forms", { preHandler: [app.authenticate] }, async () => ({
    items: CONTRACT_FORMS.map((form) => ({ form, clauseCount: clausesForForm(form).length })),
    totalClauses: CLAUSE_LIBRARY.length,
  }));

  app.get("/contract-forms/:form/clauses", { preHandler: [app.authenticate] }, async (req) => {
    const { form } = req.params as { form: string };
    if (!(CONTRACT_FORMS as readonly string[]).includes(form)) {
      throw notFound("Unknown contract form");
    }
    const q = z
      .object({
        category: z.enum(CLAUSE_CATEGORIES).optional(),
        search: z.string().max(200).optional(),
      })
      .parse(req.query);
    let items = clausesForForm(form as ContractForm);
    if (q.category) items = items.filter((c) => c.category === q.category);
    if (q.search) {
      const needle = q.search.toLowerCase();
      items = items.filter(
        (c) =>
          c.clauseRef.toLowerCase().includes(needle) ||
          c.title.toLowerCase().includes(needle) ||
          c.summary.toLowerCase().includes(needle),
      );
    }
    return { form, items, total: items.length };
  });

  /* ---------------------------------------------------------------- */
  /* Contracts                                                         */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/contracts", { preHandler: standardGate }, async (req, reply) => {
    const body = contractCreateSchema.parse(req.body);
    necFormCheck(body.form, body.necOption);
    const id = newId("con");
    const standing = clausesForForm(body.form).filter((c) => c.standingObligation);
    const pcs = (body.particularConditions ?? []) as ParticularCondition[];
    const deletedRefs = new Set(pcs.filter((p) => p.deleted).map((p) => p.clauseRef));

    // The contract and its standing obligation register are ONE write: a
    // failure part-way through the loop used to leave a contract with half a
    // register and no way to know it.
    await app.db.transaction(async (tx) => {
      await tx.insert(contracts).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        name: body.name,
        form: body.form,
        necOption: body.necOption ?? null,
        parties: body.parties ?? {},
        baseDate: body.baseDate ?? null,
        commencementDate: body.commencementDate ?? null,
        completionDate: body.completionDate ?? null,
        takingOverDate: body.takingOverDate ?? null,
        actualCompletionDate: body.actualCompletionDate ?? null,
        currency: body.currency ?? "USD",
        contractSum: body.contractSum ?? null,
        retentionPercent: body.retentionPercent ?? 0,
        retentionCap: body.retentionCap ?? null,
        retentionReleaseAtTakingOver: body.retentionReleaseAtTakingOver ?? 0.5,
        defectsPeriodMonths: body.defectsPeriodMonths ?? null,
        ldRatePerDay: body.ldRatePerDay ?? null,
        ldCap: body.ldCap ?? null,
        paymentDueDays: body.paymentDueDays ?? null,
        calendarBasis: body.calendarBasis ?? "calendar",
        holidays: body.holidays ?? [],
        jurisdiction: body.jurisdiction ?? null,
        particularConditions: pcs,
        status: "draft",
        createdBy: req.user!.id,
      });

      // #260 — materialize the form's standing obligations into the contract
      // obligation register, each linked to THIS contract.
      for (const clause of standing) {
        if (deletedRefs.has(clause.clauseRef)) continue;
        const obligationId = newId("obl");
        await tx.insert(obligations).values({
          id: obligationId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          sourceClause: `${body.form} ${clause.clauseRef} — ${clause.title}`,
          trigger: clause.standingObligation!.description,
          deadline: null,
          status: "open",
          createdBy: req.user!.id,
        });
        await tx.insert(contractObligationLinks).values({
          id: newId("col"),
          companyId: req.companyId!,
          projectId: req.projectId!,
          contractId: id,
          contractEventId: null,
          obligationId,
          kind: "standing",
          clauseRef: clause.clauseRef,
        });
      }
    });

    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "contract",
      objectId: id,
      projectId: req.projectId!,
      payload: {
        name: body.name,
        form: body.form,
        necOption: body.necOption ?? null,
        contractSum: body.contractSum ?? null,
        standingObligations: standing.length - deletedRefs.size,
        particularConditions: pcs.length,
      },
      storePayload: true,
    });

    const created = await fetchContract(id, req.companyId!, req.projectId!);
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/contracts", { preHandler: readGate }, async (req) => {
    const q = contractListQuery.parse(req.query);
    const clauses = [
      eq(contracts.companyId, req.companyId!),
      eq(contracts.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(contracts.status, q.status));
    if (q.form) clauses.push(eq(contracts.form, q.form));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(contracts).where(where);
    const items = await app.db
      .select()
      .from(contracts)
      .where(where)
      .orderBy(desc(contracts.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /**
   * Time-bar radar (#229): open events with a notice deadline inside the
   * window (or already past and not yet swept), soonest first, each carrying
   * the source its deadline came from.
   */
  app.get("/projects/:projectId/contracts/deadlines", { preHandler: readGate }, async (req) => {
    const q = z
      .object({ days: z.coerce.number().int().min(1).max(365).default(30) })
      .parse(req.query);
    const projectContracts = await app.db
      .select()
      .from(contracts)
      .where(and(eq(contracts.companyId, req.companyId!), eq(contracts.projectId, req.projectId!)));
    if (projectContracts.length === 0) return { items: [], windowDays: q.days };
    const byId = new Map(projectContracts.map((c) => [c.id, c] as const));
    const horizon = addDaysISO(todayISO(), q.days);
    const rows = await app.db
      .select()
      .from(contractEvents)
      .where(
        and(
          eq(contractEvents.companyId, req.companyId!),
          eq(contractEvents.projectId, req.projectId!),
          inArray(
            contractEvents.contractId,
            projectContracts.map((c) => c.id),
          ),
          eq(contractEvents.status, "open"),
          isNotNull(contractEvents.noticeDeadline),
          lte(contractEvents.noticeDeadline, horizon),
        ),
      )
      .orderBy(asc(contractEvents.noticeDeadline));
    const items = rows.map((ev) => {
      const contract = byId.get(ev.contractId);
      const clause =
        contract && ev.clauseRef
          ? resolveClause(contract.form as ContractForm, ev.clauseRef, contract.particularConditions, {
              calendarBasis: contract.calendarBasis as "calendar" | "working",
            })
          : null;
      const daysRemaining = daysUntil(ev.noticeDeadline!);
      return {
        id: ev.id,
        contractId: ev.contractId,
        contractName: contract?.name ?? null,
        number: ev.number,
        kind: ev.kind,
        title: ev.title,
        clauseRef: ev.clauseRef,
        clauseTitle: clause?.title ?? null,
        eventDate: ev.eventDate,
        awarenessDate: ev.awarenessDate,
        noticeDeadline: ev.noticeDeadline,
        effectiveTimeBarDays: ev.effectiveTimeBarDays,
        deadlineSource: ev.deadlineSource,
        calendarBasis: ev.calendarBasis,
        warnDaysBefore: ev.warnDaysBefore,
        daysRemaining,
        inWarningWindow: ev.warnDaysBefore != null && daysRemaining <= ev.warnDaysBefore,
      };
    });
    return { items, windowDays: q.days };
  });

  app.get("/projects/:projectId/contracts/:contractId", { preHandler: readGate }, async (req) => {
    const { contractId } = req.params as { contractId: string };
    const contract = await fetchContract(contractId, req.companyId!, req.projectId!);

    // Effective clause list = library ⊕ Particular Conditions (#201-202): the
    // PC is authoritative and the overlay says so, clause by clause.
    const clauses = effectiveClauses(
      contract.form as ContractForm,
      contract.particularConditions,
      { calendarBasis: contract.calendarBasis as "calendar" | "working" },
    );

    // Obligations belonging to THIS contract, via the link table — the old
    // `sourceClause LIKE '<form> %'` match merged every contract of the same
    // form on the project.
    const links = await app.db
      .select({ obligationId: contractObligationLinks.obligationId, kind: contractObligationLinks.kind })
      .from(contractObligationLinks)
      .where(
        and(
          eq(contractObligationLinks.companyId, req.companyId!),
          eq(contractObligationLinks.contractId, contractId),
        ),
      );
    const obligationRows =
      links.length === 0
        ? []
        : await app.db
            .select({ id: obligations.id, status: obligations.status })
            .from(obligations)
            .where(
              inArray(
                obligations.id,
                links.map((l) => l.obligationId),
              ),
            );
    const obligationStatus: Record<string, number> = {};
    for (const o of obligationRows) obligationStatus[o.status] = (obligationStatus[o.status] ?? 0) + 1;

    const eventRows = await app.db
      .select({ status: contractEvents.status, n: count() })
      .from(contractEvents)
      .where(
        and(
          eq(contractEvents.companyId, req.companyId!),
          eq(contractEvents.contractId, contractId),
        ),
      )
      .groupBy(contractEvents.status);
    const eventCounts: Record<string, number> = {};
    for (const r of eventRows) eventCounts[r.status] = Number(r.n);

    return {
      ...contract,
      effectiveClauses: clauses,
      amendedClauseCount: clauses.filter((c) => c.amended).length,
      obligationCount: obligationRows.length,
      obligationStatus,
      eventCounts,
      necBasis: contract.form.startsWith("nec")
        ? necValuationBasis(contract.necOption as NecOption | null)
        : null,
    };
  });

  app.patch(
    "/projects/:projectId/contracts/:contractId",
    { preHandler: standardGate },
    async (req) => {
      const { contractId } = req.params as { contractId: string };
      const body = contractPatchSchema.parse(req.body);
      const contract = await fetchContract(contractId, req.companyId!, req.projectId!);
      if (contract.status === "completed" || contract.status === "terminated") {
        throw badRequest(`A ${contract.status} contract cannot be edited`);
      }
      if ((body.form !== undefined || body.necOption !== undefined) && contract.status !== "draft") {
        throw badRequest("form and necOption may only be changed while the contract is draft");
      }
      const nextForm = body.form ?? contract.form;
      const nextOption = body.necOption !== undefined ? body.necOption : contract.necOption;
      if (body.form !== undefined || body.necOption !== undefined) {
        necFormCheck(nextForm, nextOption);
      }
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined) set[k] = v;
      }
      await app.db.update(contracts).set(set).where(eq(contracts.id, contractId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "contract",
        objectId: contractId,
        projectId: req.projectId!,
        payload: {
          changed: Object.keys(body),
          particularConditions:
            body.particularConditions !== undefined ? body.particularConditions : undefined,
        },
        storePayload: body.particularConditions !== undefined,
      });
      const updated = await fetchContract(contractId, req.companyId!, req.projectId!);
      // Amending the Particular Conditions changes what is owed and by when.
      // Existing events keep the deadline they were created under (a deadline
      // already served or breached is a historic fact), and the change is
      // surfaced so it can be reviewed.
      const affected =
        body.particularConditions === undefined
          ? 0
          : (
              await app.db
                .select({ id: contractEvents.id })
                .from(contractEvents)
                .where(
                  and(
                    eq(contractEvents.contractId, contractId),
                    eq(contractEvents.status, "open"),
                    isNotNull(contractEvents.noticeDeadline),
                  ),
                )
            ).length;
      return { ...updated, openEventsUnderPreviousConditions: affected };
    },
  );

  app.post(
    "/projects/:projectId/contracts/:contractId/status",
    { preHandler: standardGate },
    async (req) => {
      const { contractId } = req.params as { contractId: string };
      const body = contractStatusSchema.parse(req.body);
      const contract = await fetchContract(contractId, req.companyId!, req.projectId!);
      const allowed = CONTRACT_TRANSITIONS[contract.status] ?? [];
      if (!allowed.includes(body.status)) {
        throw badRequest(`Cannot transition a ${contract.status} contract to ${body.status}`);
      }
      const set: Record<string, unknown> = {
        status: body.status,
        updatedAt: new Date().toISOString(),
      };
      if (body.takingOverDate) set["takingOverDate"] = body.takingOverDate;
      if (body.actualCompletionDate) set["actualCompletionDate"] = body.actualCompletionDate;
      await app.db.update(contracts).set(set).where(eq(contracts.id, contractId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "contract",
        objectId: contractId,
        projectId: req.projectId!,
        payload: {
          from: contract.status,
          to: body.status,
          takingOverDate: body.takingOverDate ?? contract.takingOverDate,
        },
      });
      return fetchContract(contractId, req.companyId!, req.projectId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Contract events / notices (#225-236)                              */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/contracts/:contractId/events",
    { preHandler: standardGate },
    async (req, reply) => {
      const { contractId } = req.params as { contractId: string };
      const body = eventCreateSchema.parse(req.body);
      const contract = await fetchContract(contractId, req.companyId!, req.projectId!);
      if (body.awarenessDate && body.awarenessDate < body.eventDate) {
        throw badRequest("The awareness date cannot be earlier than the event date");
      }
      const number = await nextRecordNumber(app.db, req.projectId!, "contract_event");
      const id = newId("cev");

      // Time-bar engine (#225): the EFFECTIVE clause (library ⊕ Particular
      // Conditions) fixes the deadline, counted on the contract's calendar,
      // and materialises a deadline obligation linked to this contract (#226).
      const startDate = body.awarenessDate ?? body.eventDate;
      const deadline = computeDeadline({
        form: contract.form as ContractForm,
        clauseRef: body.clauseRef ?? null,
        particularConditions: contract.particularConditions,
        calendarBasis: contract.calendarBasis as "calendar" | "working",
        holidays: contract.holidays,
        startDate,
        manualTimeBarDays: body.timeBarDays ?? null,
        manualDeadline: body.noticeDeadline ?? null,
      });

      let obligationId: string | null = null;
      const isCe =
        body.kind === "compensation_event" && contract.form.startsWith("nec") ? "notified" : null;

      await app.db.transaction(async (tx) => {
        if (deadline.noticeDeadline) {
          obligationId = newId("obl");
          await tx.insert(obligations).values({
            id: obligationId,
            companyId: req.companyId!,
            projectId: req.projectId!,
            sourceClause: `${contract.form} ${body.clauseRef ?? "(stated)"}`,
            trigger: `Notice required: ${body.title}`,
            deadline: `${deadline.noticeDeadline}T23:59:59Z`,
            warnDaysBefore: deadline.warnDaysBefore,
            evidenceRequirement: "Served notice with proof of service",
            status: "open",
            createdBy: req.user!.id,
          });
          await tx.insert(contractObligationLinks).values({
            id: newId("col"),
            companyId: req.companyId!,
            projectId: req.projectId!,
            contractId,
            contractEventId: id,
            obligationId,
            kind: "notice",
            clauseRef: body.clauseRef ?? null,
          });
        }
        await tx.insert(contractEvents).values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          contractId,
          number,
          kind: body.kind,
          clauseRef: body.clauseRef ?? null,
          title: body.title,
          description: body.description ?? null,
          eventDate: body.eventDate,
          awarenessDate: body.awarenessDate ?? null,
          noticeDeadline: deadline.noticeDeadline,
          effectiveTimeBarDays: deadline.effectiveTimeBarDays,
          deadlineSource: deadline.deadlineSource,
          calendarBasis: deadline.calendarBasis,
          warnDaysBefore: deadline.warnDaysBefore,
          status: "open",
          obligationId,
          ceState: isCe,
          costImpactEstimate: body.costImpactEstimate ?? null,
          timeImpactDaysEstimate: body.timeImpactDaysEstimate ?? null,
          raisedBy: req.user!.id,
        });
      });

      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "contract_event",
        objectId: id,
        projectId: req.projectId!,
        payload: {
          number,
          kind: body.kind,
          clauseRef: body.clauseRef ?? null,
          eventDate: body.eventDate,
          awarenessDate: body.awarenessDate ?? null,
          noticeDeadline: deadline.noticeDeadline,
          deadlineSource: deadline.deadlineSource,
          effectiveTimeBarDays: deadline.effectiveTimeBarDays,
          obligationId,
        },
      });
      const created = await fetchEvent(id, contractId, req.companyId!, req.projectId!);
      return reply.status(201).send({
        ...created,
        daysToDeadline: deadline.noticeDeadline ? daysUntil(deadline.noticeDeadline) : null,
        deadlineExplanation: deadline.explanation,
      });
    },
  );

  app.get(
    "/projects/:projectId/contracts/:contractId/events",
    { preHandler: readGate },
    async (req) => {
      const { contractId } = req.params as { contractId: string };
      const q = eventListQuery.parse(req.query);
      await fetchContract(contractId, req.companyId!, req.projectId!);
      const clauses = [
        eq(contractEvents.companyId, req.companyId!),
        eq(contractEvents.projectId, req.projectId!),
        eq(contractEvents.contractId, contractId),
      ];
      if (q.kind) clauses.push(eq(contractEvents.kind, q.kind));
      if (q.status) clauses.push(eq(contractEvents.status, q.status));
      const where = and(...clauses);
      const [totalRow] = await app.db.select({ n: count() }).from(contractEvents).where(where);
      const rows = await app.db
        .select()
        .from(contractEvents)
        .where(where)
        .orderBy(desc(contractEvents.number))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      const items = rows.map((ev) => ({
        ...ev,
        daysToDeadline: ev.noticeDeadline ? daysUntil(ev.noticeDeadline) : null,
      }));
      return paginate(items, Number(totalRow?.n ?? 0), q);
    },
  );

  /**
   * Run the time-bar sweep on demand. The sweep is a SCHEDULED job
   * (contracts.time-bars); this endpoint exists so an operator or a test can
   * force a cycle without waiting an hour, and it is admin-gated because it
   * writes state changes.
   */
  app.post(
    "/projects/:projectId/contracts/sweep-time-bars",
    { preHandler: adminGate },
    async (req) => {
      const result = await sweepTimeBars(app.db, req.companyId!, new Date(), {
        projectId: req.projectId!,
      });
      return result;
    },
  );

  app.get(
    "/projects/:projectId/contracts/:contractId/events/:eventId",
    { preHandler: readGate },
    async (req) => {
      const { contractId, eventId } = req.params as { contractId: string; eventId: string };
      const contract = await fetchContract(contractId, req.companyId!, req.projectId!);
      const ev = await fetchEvent(eventId, contractId, req.companyId!, req.projectId!);
      const clause = ev.clauseRef
        ? resolveClause(contract.form as ContractForm, ev.clauseRef, contract.particularConditions, {
            calendarBasis: contract.calendarBasis as "calendar" | "working",
          })
        : null;
      const chain = await app.db
        .select()
        .from(contractEvents)
        .where(eq(contractEvents.chainParentId, eventId));
      return {
        ...ev,
        daysToDeadline: ev.noticeDeadline ? daysUntil(ev.noticeDeadline) : null,
        clause,
        chainedEvents: chain.map((c) => ({
          id: c.id,
          number: c.number,
          title: c.title,
          clauseRef: c.clauseRef,
          noticeDeadline: c.noticeDeadline,
          status: c.status,
          chainStage: c.chainStage,
        })),
      };
    },
  );

  /**
   * Serve a notice (#228, #230).
   *
   * Three things the first cut got wrong and this fixes:
   *  • a client-supplied `servedAt` before the deadline turned a time-barred
   *    event into a clean "notice served" with nothing persisted about it;
   *  • lateness lived only in a ledger payload, so the register could not tell
   *    a timely notice from one served after the bar;
   *  • serving a notice never started the NEXT clock the form imposes.
   */
  app.post(
    "/projects/:projectId/contracts/:contractId/events/:eventId/serve-notice",
    { preHandler: standardGate },
    async (req) => {
      const { contractId, eventId } = req.params as { contractId: string; eventId: string };
      const body = serveNoticeSchema.parse(req.body);
      const contract = await fetchContract(contractId, req.companyId!, req.projectId!);
      const ev = await fetchEvent(eventId, contractId, req.companyId!, req.projectId!);
      if (ev.status !== "open" && ev.status !== "time_barred") {
        throw badRequest(`Notice cannot be served on a ${ev.status} event`);
      }
      const nowIso = new Date().toISOString();
      const servedAt = body.servedAt ?? nowIso;
      if (Date.parse(servedAt) > Date.parse(nowIso) + 60_000) {
        throw badRequest("A notice cannot be recorded as served in the future");
      }
      const servedDate = new Date(servedAt).toISOString().slice(0, 10);
      // Backdating service is exactly the move that would launder a missed
      // bar, so it needs a reason and a pointer to the proof of service.
      const backdatedDays = daysBetweenIso(servedDate, todayISO());
      if (backdatedDays > 1 && (!body.reason || !body.evidenceRef)) {
        throw badRequest(
          `Recording service ${backdatedDays} days in the past requires a reason and an evidence reference (proof of service).`,
        );
      }
      const late = ev.noticeDeadline !== null && servedDate > ev.noticeDeadline;
      // A barred event stays visibly barred: a late notice is a served notice
      // on a time-barred event, not a clean one.
      const nextStatus = late || ev.status === "time_barred" ? "time_barred" : "notice_served";

      await app.db
        .update(contractEvents)
        .set({
          status: nextStatus,
          noticeServedAt: servedAt,
          noticeMethod: body.method,
          noticeReference: body.reference ?? null,
          noticeServedLate: late,
          deadlineAtService: ev.noticeDeadline,
          lateReason: body.reason ?? null,
          serviceEvidenceRef: body.evidenceRef ?? null,
          updatedAt: nowIso,
        })
        .where(eq(contractEvents.id, eventId));

      // The deadline obligation is satisfied only by a timely notice; a
      // breached obligation is left breached — serving late does not rewrite
      // the register.
      if (ev.obligationId && !late) {
        await app.db
          .update(obligations)
          .set({ status: "satisfied" })
          .where(and(eq(obligations.id, ev.obligationId), eq(obligations.status, "open")));
      }

      if (late) {
        await raiseSignalOnce(app.db, {
          companyId: req.companyId!,
          projectId: req.projectId!,
          detector: "time_bar_breach_risk",
          key: `time_bar_breach_risk:${eventId}`,
          severity: "high",
          confidence: 1,
          title: "Notice served after time bar",
          explanation:
            `Notice for contract event #${ev.number} ("${ev.title}") was served on ${servedDate}, ` +
            `after the notice deadline of ${ev.noticeDeadline} computed from ${ev.awarenessDate ?? ev.eventDate}` +
            `${ev.deadlineSource === "particular_condition" ? " under the amended Particular Condition" : ""}. ` +
            `The related entitlement may be barred; review the clause's condition-precedent wording.`,
          evidenceRefs: {
            eventId,
            servedDate,
            noticeDeadline: ev.noticeDeadline,
            reason: body.reason ?? null,
          },
        });
      }

      // Chained deadlines (#227): serving this notice starts the next clock.
      const clause = ev.clauseRef
        ? resolveClause(contract.form as ContractForm, ev.clauseRef, contract.particularConditions, {
            calendarBasis: contract.calendarBasis as "calendar" | "working",
          })
        : null;
      const chain = chainedDeadlines(clause, {
        form: contract.form as ContractForm,
        particularConditions: contract.particularConditions,
        calendarBasis: contract.calendarBasis as "calendar" | "working",
        holidays: contract.holidays,
        awarenessDate: ev.awarenessDate ?? ev.eventDate,
        servedDate,
      });
      const spawned: Array<{ id: string; clauseRef: string; deadline: string }> = [];
      for (const link of chain) {
        const already = await app.db
          .select({ id: contractEvents.id })
          .from(contractEvents)
          .where(
            and(
              eq(contractEvents.chainParentId, eventId),
              eq(contractEvents.chainStage, link.clauseRef),
            ),
          )
          .limit(1);
        if (already[0]) continue;
        const childNumber = await nextRecordNumber(app.db, req.projectId!, "contract_event");
        const childId = newId("cev");
        const childObligationId = newId("obl");
        await app.db.transaction(async (tx) => {
          await tx.insert(obligations).values({
            id: childObligationId,
            companyId: req.companyId!,
            projectId: req.projectId!,
            sourceClause: `${contract.form} ${link.clauseRef}`,
            trigger: `${link.label} for event #${ev.number}: ${ev.title}`,
            deadline: `${link.deadline}T23:59:59Z`,
            warnDaysBefore: link.warnDaysBefore,
            evidenceRequirement: "Submission with proof of service",
            status: "open",
            createdBy: req.user!.id,
          });
          await tx.insert(contractObligationLinks).values({
            id: newId("col"),
            companyId: req.companyId!,
            projectId: req.projectId!,
            contractId,
            contractEventId: childId,
            obligationId: childObligationId,
            kind: "chain",
            clauseRef: link.clauseRef,
          });
          await tx.insert(contractEvents).values({
            id: childId,
            companyId: req.companyId!,
            projectId: req.projectId!,
            contractId,
            number: childNumber,
            kind: ev.kind,
            clauseRef: link.clauseRef,
            title: `${link.label} — ${ev.title}`,
            description: link.explanation,
            eventDate: servedDate,
            awarenessDate: ev.awarenessDate ?? ev.eventDate,
            noticeDeadline: link.deadline,
            effectiveTimeBarDays: link.days,
            deadlineSource: link.deadlineSource,
            calendarBasis: link.calendarBasis,
            warnDaysBefore: link.warnDaysBefore,
            status: "open",
            obligationId: childObligationId,
            chainParentId: eventId,
            chainStage: link.clauseRef,
            raisedBy: req.user!.id,
          });
        });
        spawned.push({ id: childId, clauseRef: link.clauseRef, deadline: link.deadline });
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "create",
          objectType: "contract_event",
          objectId: childId,
          projectId: req.projectId!,
          payload: {
            number: childNumber,
            chainParentId: eventId,
            clauseRef: link.clauseRef,
            noticeDeadline: link.deadline,
            source: "deadline_chain",
          },
        });
      }

      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "contract_event",
        objectId: eventId,
        projectId: req.projectId!,
        payload: {
          from: ev.status,
          to: nextStatus,
          method: body.method,
          servedAt,
          late,
          deadlineAtService: ev.noticeDeadline,
          reason: body.reason ?? null,
          chained: spawned.map((s) => s.clauseRef),
        },
        storePayload: true,
      });
      const updated = await fetchEvent(eventId, contractId, req.companyId!, req.projectId!);
      return {
        ...updated,
        late,
        chainedEvents: spawned,
        daysToDeadline: updated.noticeDeadline ? daysUntil(updated.noticeDeadline) : null,
      };
    },
  );

  app.post(
    "/projects/:projectId/contracts/:contractId/events/:eventId/status",
    { preHandler: standardGate },
    async (req) => {
      const { contractId, eventId } = req.params as { contractId: string; eventId: string };
      const body = eventStatusSchema.parse(req.body);
      const ev = await fetchEvent(eventId, contractId, req.companyId!, req.projectId!);
      if (!["open", "notice_served", "time_barred"].includes(ev.status)) {
        throw badRequest(`Cannot transition a ${ev.status} event to ${body.status}`);
      }
      await app.db
        .update(contractEvents)
        .set({ status: body.status, updatedAt: new Date().toISOString() })
        .where(eq(contractEvents.id, eventId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "contract_event",
        objectId: eventId,
        projectId: req.projectId!,
        payload: { from: ev.status, to: body.status },
      });
      return fetchEvent(eventId, contractId, req.companyId!, req.projectId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* EOT claims (#237-240)                                             */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/contracts/:contractId/eot-claims",
    { preHandler: standardGate },
    async (req, reply) => {
      const { contractId } = req.params as { contractId: string };
      const body = eotCreateSchema.parse(req.body);
      await fetchContract(contractId, req.companyId!, req.projectId!);
      const eventIds = [...new Set(body.eventIds ?? [])];
      if (eventIds.length > 0) {
        const rows = await app.db
          .select({ id: contractEvents.id })
          .from(contractEvents)
          .where(
            and(
              eq(contractEvents.companyId, req.companyId!),
              eq(contractEvents.contractId, contractId),
              inArray(contractEvents.id, eventIds),
            ),
          );
        if (rows.length !== eventIds.length) {
          throw badRequest("One or more eventIds do not belong to this contract");
        }
      }
      const number = await nextRecordNumber(app.db, req.projectId!, "eot_claim");
      const id = newId("eot");
      await app.db.insert(eotClaims).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        contractId,
        number,
        title: body.title,
        clauseRef: body.clauseRef ?? null,
        eventIds,
        daysClaimed: body.daysClaimed,
        status: "notified",
        narrative: body.narrative ?? null,
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "eot_claim",
        objectId: id,
        projectId: req.projectId!,
        payload: { number, title: body.title, daysClaimed: body.daysClaimed, eventIds },
      });
      const created = await fetchEotClaim(id, contractId, req.companyId!, req.projectId!);
      return reply.status(201).send(created);
    },
  );

  app.get(
    "/projects/:projectId/contracts/:contractId/eot-claims",
    { preHandler: readGate },
    async (req) => {
      const { contractId } = req.params as { contractId: string };
      const q = eotListQuery.parse(req.query);
      await fetchContract(contractId, req.companyId!, req.projectId!);
      const clauses = [
        eq(eotClaims.companyId, req.companyId!),
        eq(eotClaims.projectId, req.projectId!),
        eq(eotClaims.contractId, contractId),
      ];
      if (q.status) clauses.push(eq(eotClaims.status, q.status));
      const where = and(...clauses);
      const [totalRow] = await app.db.select({ n: count() }).from(eotClaims).where(where);
      const items = await app.db
        .select()
        .from(eotClaims)
        .where(where)
        .orderBy(desc(eotClaims.number))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(items, Number(totalRow?.n ?? 0), q);
    },
  );

  app.get(
    "/projects/:projectId/contracts/:contractId/eot-claims/:claimId",
    { preHandler: readGate },
    async (req) => {
      const { contractId, claimId } = req.params as { contractId: string; claimId: string };
      const claim = await fetchEotClaim(claimId, contractId, req.companyId!, req.projectId!);
      const events =
        claim.eventIds.length === 0
          ? []
          : await app.db
              .select()
              .from(contractEvents)
              .where(inArray(contractEvents.id, claim.eventIds));
      return { ...claim, events };
    },
  );

  app.post(
    "/projects/:projectId/contracts/:contractId/eot-claims/:claimId/status",
    { preHandler: standardGate },
    async (req) => {
      const { contractId, claimId } = req.params as { contractId: string; claimId: string };
      const body = eotStatusSchema.parse(req.body);
      const claim = await fetchEotClaim(claimId, contractId, req.companyId!, req.projectId!);
      const allowed = EOT_TRANSITIONS[claim.status] ?? [];
      if (!allowed.includes(body.status)) {
        throw badRequest(`Cannot transition a ${claim.status} EOT claim to ${body.status}`);
      }
      const now = new Date().toISOString();
      const set: Record<string, unknown> = { status: body.status, updatedAt: now };
      if (body.status === "assessed") {
        // Determination independence (#232): the assessor must not be the
        // party who raised the claim.
        if (req.user!.id === claim.createdBy) {
          throw forbidden("An EOT claim cannot be assessed by the user who raised it");
        }
        if (body.daysAwarded === undefined) {
          throw badRequest("daysAwarded is required to assess an EOT claim");
        }
        if (!body.assessment?.method) {
          throw badRequest(
            "An assessment must record the delay-analysis method used (SCL protocol methods)",
          );
        }
        set["daysAwarded"] = body.daysAwarded;
        set["assessedBy"] = req.user!.id;
        set["assessedAt"] = now;
        set["assessment"] = body.assessment;
      }
      await app.db.update(eotClaims).set(set).where(eq(eotClaims.id, claimId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "eot_claim",
        objectId: claimId,
        projectId: req.projectId!,
        payload: {
          from: claim.status,
          to: body.status,
          daysAwarded: body.status === "assessed" ? body.daysAwarded : claim.daysAwarded,
          assessment: body.assessment ?? null,
        },
        storePayload: body.status === "assessed",
      });

      // Agreement of an assessed award extends the contract completion date
      // (#237): the ledger records the movement with the claim as cause.
      if (body.status === "agreed" && claim.daysAwarded != null) {
        const contract = await fetchContract(contractId, req.companyId!, req.projectId!);
        if (contract.completionDate) {
          const newCompletion = addDaysISO(contract.completionDate, claim.daysAwarded);
          await app.db
            .update(contracts)
            .set({ completionDate: newCompletion, updatedAt: now })
            .where(eq(contracts.id, contractId));
          await appendLedger(app.db, {
            companyId: req.companyId!,
            actorId: req.user!.id,
            action: "state_change",
            objectType: "contract",
            objectId: contractId,
            projectId: req.projectId!,
            payload: { from: contract.completionDate, to: newCompletion, eotClaimId: claimId },
          });
        }
      }
      return fetchEotClaim(claimId, contractId, req.companyId!, req.projectId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Liquidated damages exposure (#249-250)                            */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/contracts/:contractId/ld-exposure",
    { preHandler: readGate },
    async (req) => {
      const { contractId } = req.params as { contractId: string };
      const contract = await fetchContract(contractId, req.companyId!, req.projectId!);
      const exposure = computeLdExposure({
        completionDate: contract.completionDate,
        takingOverDate: contract.takingOverDate,
        actualCompletionDate: contract.actualCompletionDate,
        ldRatePerDay: contract.ldRatePerDay,
        ldCap: contract.ldCap,
        contractStatus: contract.status,
        today: todayISO(),
      });
      return { ...exposure, currency: contract.currency };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Notice composition (#228) and the AI drafting hook (#1006-1007)   */
  /* ---------------------------------------------------------------- */

  /**
   * The deterministic notice pack: who serves it on whom, by which route the
   * form's notices clause allows, what the notice must state, which of those
   * facts the record already holds — and a draft built ONLY from facts on the
   * record, with a bracketed placeholder wherever one is missing.
   *
   * This never touches the AI layer. A notice has a deadline; the pack must
   * exist whether or not ANTHROPIC_API_KEY is set.
   */
  app.get(
    "/projects/:projectId/contracts/:contractId/events/:eventId/notice-pack",
    { preHandler: readGate },
    async (req) => {
      const { contractId, eventId } = req.params as { contractId: string; eventId: string };
      const contract = await fetchContract(contractId, req.companyId!, req.projectId!);
      const ev = await fetchEvent(eventId, contractId, req.companyId!, req.projectId!);
      const clause = ev.clauseRef
        ? resolveClause(contract.form as ContractForm, ev.clauseRef, contract.particularConditions, {
            calendarBasis: contract.calendarBasis as "calendar" | "working",
          })
        : null;
      const pack = buildNoticePack({
        contract: {
          name: contract.name,
          form: contract.form as ContractForm,
          currency: contract.currency,
          parties: contract.parties ?? {},
        },
        event: {
          number: ev.number,
          kind: ev.kind,
          title: ev.title,
          description: ev.description,
          eventDate: ev.eventDate,
          awarenessDate: ev.awarenessDate,
          noticeDeadline: ev.noticeDeadline,
          deadlineSource: ev.deadlineSource,
          effectiveTimeBarDays: ev.effectiveTimeBarDays,
          calendarBasis: ev.calendarBasis,
          costImpactEstimate: ev.costImpactEstimate,
          timeImpactDaysEstimate: ev.timeImpactDaysEstimate,
          status: ev.status,
          noticeServedAt: ev.noticeServedAt,
        },
        clause,
        today: todayISO(),
      });
      return {
        ...pack,
        eventId: ev.id,
        contractId: contract.id,
        aiAvailable: aiEnabled(app),
        note: aiEnabled(app)
          ? "POST .../draft-notice to have the notice drafter expand this pack into prose, cited to the records it used."
          : "The AI drafter is unavailable (ANTHROPIC_API_KEY is not configured). This pack and its draft are produced deterministically from the contract and the event record.",
      };
    },
  );

  /**
   * The AI drafting hook (#1006-1007): hand the deterministic pack to the
   * notice drafter so it becomes prose, cited to the records it used, with
   * the facts it could not find listed rather than invented.
   *
   * 503 AiDisabled without a key — and the pack above still works, so the
   * capability degrades to a template rather than disappearing.
   */
  app.post(
    "/projects/:projectId/contracts/:contractId/events/:eventId/draft-notice",
    { preHandler: standardGate },
    async (req) => {
      const { contractId, eventId } = req.params as { contractId: string; eventId: string };
      const contract = await fetchContract(contractId, req.companyId!, req.projectId!);
      const ev = await fetchEvent(eventId, contractId, req.companyId!, req.projectId!);
      if (!aiEnabled(app)) throw aiDisabledError();

      const clause = ev.clauseRef
        ? resolveClause(contract.form as ContractForm, ev.clauseRef, contract.particularConditions, {
            calendarBasis: contract.calendarBasis as "calendar" | "working",
          })
        : null;
      const pack = buildNoticePack({
        contract: {
          name: contract.name,
          form: contract.form as ContractForm,
          currency: contract.currency,
          parties: contract.parties ?? {},
        },
        event: {
          number: ev.number,
          kind: ev.kind,
          title: ev.title,
          description: ev.description,
          eventDate: ev.eventDate,
          awarenessDate: ev.awarenessDate,
          noticeDeadline: ev.noticeDeadline,
          deadlineSource: ev.deadlineSource,
          effectiveTimeBarDays: ev.effectiveTimeBarDays,
          calendarBasis: ev.calendarBasis,
          costImpactEstimate: ev.costImpactEstimate,
          timeImpactDaysEstimate: ev.timeImpactDaysEstimate,
          status: ev.status,
          noticeServedAt: ev.noticeServedAt,
        },
        clause,
        today: todayISO(),
      });

      const inputRefs: InputRef[] = [
        { type: "contract_event", id: ev.id },
        { type: "contract", id: contract.id },
      ];
      const system = [
        "You are the ConstructOS contractual notice drafter.",
        "Expand the supplied notice pack into a compliant notice under the stated contract form.",
        "Use ONLY the facts in the pack. Do not invent clause numbers, dates, quantities or entitlements.",
        "Every requirement the pack marks NOT SATISFIED must appear in missingFacts and stay a bracketed placeholder in the draft.",
        'Return ONLY JSON: {"subject":string,"noticeText":string,"missingFacts":[string],"citations":[{"type":string,"id":string}],"confidence":number}.',
        "citations must reference the supplied record ids; confidence is 0-1.",
      ].join("\n");
      const user = [
        `Contract: ${contract.name} (${contract.form}${contract.necOption ? ` Option ${contract.necOption}` : ""}), currency ${contract.currency}.`,
        `Parties: ${JSON.stringify(contract.parties ?? {})}.`,
        `Record: contract_event ${ev.id}, contract ${contract.id}.`,
        `Clause in force: ${pack.clauseRef ?? "(none attached)"} — ${pack.clauseTitle ?? ""}.`,
        `Deadline basis: ${pack.basis}`,
        `Deadline: ${pack.deadline ?? "none"} (${pack.urgency}).`,
        `Service rules: ${pack.serviceRules.join(" ")}`,
        "Requirements:",
        ...pack.requirements.map(
          (r) => `- [${r.satisfied ? "SATISFIED" : "NOT SATISFIED"}] ${r.label}: ${r.detail}`,
        ),
        "",
        "Deterministic draft to expand:",
        pack.draft,
      ].join("\n");

      const schema = z.object({
        subject: z.string().min(1).max(300),
        noticeText: z.string().min(1).max(20_000),
        missingFacts: z.array(z.string().max(400)).max(30).default([]),
        confidence: z.number().min(0).max(1).default(0.5),
      });

      const result = await runAgent({
        app,
        req,
        agentKind: "time_bar_notice_drafter",
        projectId: req.projectId!,
        system,
        user,
        inputRefs,
        schema,
        dataCategories: ["contract_terms"],
        contextChars: user.length,
      });

      return {
        pack,
        runId: result.runId,
        subject: result.json?.subject ?? null,
        noticeText: result.json?.noticeText ?? result.text,
        // The engine's own gap list is authoritative; the model may only add.
        missingFacts: [...new Set([...pack.missing, ...(result.json?.missingFacts ?? [])])],
        confidence: result.json?.confidence ?? null,
        citations: result.grounding.citations,
        droppedCitations: result.grounding.dropped,
        note:
          "This is a draft for a contract administrator to review and serve. Serving it is a separate, recorded act: POST .../serve-notice.",
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Health inputs (platform contract 3.5)                             */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/contracts/health-inputs",
    { preHandler: readGate },
    async (req) => {
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const today = todayISO();
      const reasons: string[] = [];
      const metrics: Record<string, number | null> = {};

      const projectContracts = await app.db
        .select()
        .from(contracts)
        .where(and(eq(contracts.companyId, companyId), eq(contracts.projectId, projectId)));
      metrics["contracts"] = projectContracts.length;
      if (projectContracts.length === 0) {
        reasons.push("No contracts are recorded on this project.");
        return { metrics, reasons };
      }

      const events = await app.db
        .select()
        .from(contractEvents)
        .where(
          and(eq(contractEvents.companyId, companyId), eq(contractEvents.projectId, projectId)),
        );
      metrics["eventsOpen"] = events.filter((e) => e.status === "open").length;
      metrics["timeBarsMissed"] = events.filter((e) => e.status === "time_barred").length;
      metrics["noticesServedLate"] = events.filter((e) => e.noticeServedLate).length;
      metrics["deadlinesInsideWarningWindow"] = events.filter(
        (e) =>
          e.status === "open" &&
          e.noticeDeadline != null &&
          e.warnDaysBefore != null &&
          daysBetweenIso(today, e.noticeDeadline) <= e.warnDaysBefore,
      ).length;
      metrics["deadlinesOverdueUnswept"] = events.filter(
        (e) => e.status === "open" && e.noticeDeadline != null && e.noticeDeadline < today,
      ).length;

      const eots = await app.db
        .select({ status: eotClaims.status, claimed: eotClaims.daysClaimed, awarded: eotClaims.daysAwarded })
        .from(eotClaims)
        .where(and(eq(eotClaims.companyId, companyId), eq(eotClaims.projectId, projectId)));
      metrics["eotClaimsOpen"] = eots.filter(
        (e) => e.status !== "agreed" && e.status !== "rejected",
      ).length;
      metrics["eotDaysClaimedOpen"] = eots
        .filter((e) => e.status !== "agreed" && e.status !== "rejected")
        .reduce((s, e) => s + e.claimed, 0);
      metrics["eotDaysAwarded"] = eots
        .filter((e) => e.status === "agreed")
        .reduce((s, e) => s + (e.awarded ?? 0), 0);

      // LD exposure is money and therefore currency-bound: reported as days
      // late on the worst contract, plus a per-currency accrual list.
      let worstDaysLate = 0;
      const ldByCurrency = new Map<string, number>();
      for (const c of projectContracts) {
        const ld = computeLdExposure({
          completionDate: c.completionDate,
          takingOverDate: c.takingOverDate,
          actualCompletionDate: c.actualCompletionDate,
          ldRatePerDay: c.ldRatePerDay,
          ldCap: c.ldCap,
          contractStatus: c.status,
          today,
        });
        if (!ld.applicable) continue;
        worstDaysLate = Math.max(worstDaysLate, ld.daysLate);
        ldByCurrency.set(c.currency, (ldByCurrency.get(c.currency) ?? 0) + ld.accrued);
      }
      metrics["worstDaysLate"] = worstDaysLate;
      if (ldByCurrency.size > 1) {
        reasons.push(
          "Contracts on this project are in more than one currency; LD accrual is not summed.",
        );
      }
      metrics["ldAccrued"] = ldByCurrency.size === 1 ? [...ldByCurrency.values()][0]! : null;

      const amended = projectContracts.filter(
        (c) => (c.particularConditions ?? []).length > 0,
      ).length;
      metrics["contractsWithParticularConditions"] = amended;

      return { metrics, reasons };
    },
  );

  await app.register(ceRoutes);
  await app.register(complianceRoutes);
  registerContractJobs(app);
};
