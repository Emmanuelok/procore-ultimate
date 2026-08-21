import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, lt, lte } from "drizzle-orm";
import { z } from "zod";
import { contractEvents, contracts, eotClaims, obligations, signals } from "@constructos/db";
import {
  CLAUSE_CATEGORIES,
  CONTRACT_EVENT_KINDS,
  CONTRACT_EVENT_STATUSES,
  CONTRACT_FORMS,
  CONTRACT_STATUSES,
  NEC_OPTIONS,
  type ContractForm,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { addDaysISO, isoDateSchema, todayISO } from "../field/dates.js";
import { CLAUSE_LIBRARY, clausesForForm, findClause } from "./clause-library.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

/** Lenient ISO timestamp (avoids zod version drift on .datetime()). */
const isoTimestamp = z
  .string()
  .min(4)
  .refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO timestamp");

const particularConditionSchema = z.object({
  clauseRef: z.string().min(1).max(40),
  amendment: z.string().min(1).max(4000),
});

const contractCreateSchema = z.object({
  name: z.string().min(1).max(300),
  form: z.enum(CONTRACT_FORMS),
  necOption: z.enum(NEC_OPTIONS).optional(),
  parties: z.record(z.string(), z.string()).optional(),
  baseDate: isoDateSchema.nullable().optional(),
  commencementDate: isoDateSchema.nullable().optional(),
  completionDate: isoDateSchema.nullable().optional(),
  currency: z.string().length(3).optional(),
  contractSum: z.number().nonnegative().nullable().optional(),
  retentionPercent: z.number().min(0).max(100).optional(),
  retentionCap: z.number().nonnegative().nullable().optional(),
  defectsPeriodMonths: z.number().int().min(0).max(240).nullable().optional(),
  ldRatePerDay: z.number().nonnegative().nullable().optional(),
  ldCap: z.number().nonnegative().nullable().optional(),
  particularConditions: z.array(particularConditionSchema).max(200).optional(),
});

const contractPatchSchema = contractCreateSchema.partial();

const contractListQuery = pageQuerySchema.extend({
  status: z.enum(CONTRACT_STATUSES).optional(),
  form: z.enum(CONTRACT_FORMS).optional(),
});

const contractStatusSchema = z.object({
  status: z.enum(["executed", "completed", "terminated"]),
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
  return Math.round(
    (Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${todayISO()}T00:00:00Z`)) / 86_400_000,
  );
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
 * Contract intelligence — spec Vol II Domain C / M8 (#193-264 foundation
 * subset): code-resident clause library, contract register with Particular
 * Conditions overlay, notice/event register with the automatic time-bar
 * engine (#225-231), EOT claim lifecycle (#237-240) and LD exposure
 * (#249-250). Time-barred clauses materialize assurance Obligations so the
 * contract obligation register (#260) and the assurance layer see the same
 * deadlines.
 */
export const contractsModule: FastifyPluginAsync = async (app) => {
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

  /**
   * Lazy time-bar sweep (#230): open events whose notice deadline has fully
   * elapsed become time_barred, the linked obligation is breached and a
   * critical signal is raised — exactly once, guarded on the event still
   * being `open` at sweep time.
   */
  async function sweepTimeBars(
    contractIds: string[],
    companyId: string,
    projectId: string,
    actorId: string,
  ): Promise<void> {
    if (contractIds.length === 0) return;
    const today = todayISO();
    const stale = await app.db
      .select()
      .from(contractEvents)
      .where(
        and(
          eq(contractEvents.companyId, companyId),
          eq(contractEvents.projectId, projectId),
          inArray(contractEvents.contractId, contractIds),
          eq(contractEvents.status, "open"),
          isNotNull(contractEvents.noticeDeadline),
          lt(contractEvents.noticeDeadline, today),
        ),
      );
    for (const ev of stale) {
      await app.db
        .update(contractEvents)
        .set({ status: "time_barred", updatedAt: new Date().toISOString() })
        .where(and(eq(contractEvents.id, ev.id), eq(contractEvents.status, "open")));
      if (ev.obligationId) {
        await app.db
          .update(obligations)
          .set({ status: "breached" })
          .where(and(eq(obligations.id, ev.obligationId), eq(obligations.status, "open")));
      }
      await app.db.insert(signals).values({
        id: newId("sig"),
        companyId,
        projectId,
        detector: "time_bar_missed",
        severity: "critical",
        confidence: 1,
        title: `Notice time bar missed — event #${ev.number}: ${ev.title}`,
        explanation:
          `Contract event #${ev.number} (${ev.kind}${ev.clauseRef ? `, clause ${ev.clauseRef}` : ""}) ` +
          `dated ${ev.eventDate} required a notice by ${ev.noticeDeadline}. No notice was recorded ` +
          `before the deadline elapsed; the event is now time-barred and any related entitlement is at risk.`,
      });
      await appendLedger(app.db, {
        companyId,
        actorId,
        action: "state_change",
        objectType: "contract_event",
        objectId: ev.id,
        payload: { from: "open", to: "time_barred", noticeDeadline: ev.noticeDeadline },
      });
    }
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
    await app.db.insert(contracts).values({
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
      currency: body.currency ?? "USD",
      contractSum: body.contractSum ?? null,
      retentionPercent: body.retentionPercent ?? 0,
      retentionCap: body.retentionCap ?? null,
      defectsPeriodMonths: body.defectsPeriodMonths ?? null,
      ldRatePerDay: body.ldRatePerDay ?? null,
      ldCap: body.ldCap ?? null,
      particularConditions: body.particularConditions ?? [],
      status: "draft",
      createdBy: req.user!.id,
    });

    // #260 — materialize the form's standing obligations into the contract
    // obligation register (assurance layer) at the moment the contract exists.
    const standing = clausesForForm(body.form).filter((c) => c.standingObligation);
    for (const clause of standing) {
      await app.db.insert(obligations).values({
        id: newId("obl"),
        companyId: req.companyId!,
        projectId: req.projectId!,
        sourceClause: `${body.form} ${clause.clauseRef} — ${clause.title}`,
        trigger: clause.standingObligation!.description,
        deadline: null,
        status: "open",
        createdBy: req.user!.id,
      });
    }

    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "contract",
      objectId: id,
      payload: {
        name: body.name,
        form: body.form,
        necOption: body.necOption ?? null,
        contractSum: body.contractSum ?? null,
        standingObligations: standing.length,
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
   * window (or already past and not yet swept), soonest first.
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
          ? findClause(contract.form as ContractForm, ev.clauseRef)
          : undefined;
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
        noticeDeadline: ev.noticeDeadline,
        daysRemaining: daysUntil(ev.noticeDeadline!),
      };
    });
    return { items, windowDays: q.days };
  });

  app.get("/projects/:projectId/contracts/:contractId", { preHandler: readGate }, async (req) => {
    const { contractId } = req.params as { contractId: string };
    const contract = await fetchContract(contractId, req.companyId!, req.projectId!);

    // Effective clause list = library for the form overlaid with the
    // Particular Conditions (#201-202): amended clauses are flagged, never
    // silently replaced.
    const pcs = (contract.particularConditions ?? []) as {
      clauseRef: string;
      amendment: string;
    }[];
    const pcByRef = new Map(pcs.map((p) => [p.clauseRef, p.amendment] as const));
    const effectiveClauses = clausesForForm(contract.form as ContractForm).map((c) => ({
      ...c,
      amended: pcByRef.has(c.clauseRef),
      amendment: pcByRef.get(c.clauseRef) ?? null,
    }));

    // Obligation register size for this contract's form on this project
    // (standing obligations + notice obligations both carry the form prefix).
    const [oblRow] = await app.db
      .select({ n: count() })
      .from(obligations)
      .where(
        and(
          eq(obligations.companyId, req.companyId!),
          eq(obligations.projectId, req.projectId!),
          ilike(obligations.sourceClause, `${contract.form} %`),
        ),
      );

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
      effectiveClauses,
      obligationCount: Number(oblRow?.n ?? 0),
      eventCounts,
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
        payload: { changed: Object.keys(body) },
      });
      return fetchContract(contractId, req.companyId!, req.projectId!);
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
      await app.db
        .update(contracts)
        .set({ status: body.status, updatedAt: new Date().toISOString() })
        .where(eq(contracts.id, contractId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "contract",
        objectId: contractId,
        payload: { from: contract.status, to: body.status },
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
      const number = await nextRecordNumber(app.db, req.projectId!, "contract_event");
      const id = newId("cev");

      // Time-bar engine (#225): a clauseRef that resolves in the library for
      // this contract's form and carries a time bar fixes the notice deadline
      // and materializes a deadline obligation in the assurance layer (#226).
      let noticeDeadline: string | null = null;
      let obligationId: string | null = null;
      const clause = body.clauseRef
        ? findClause(contract.form as ContractForm, body.clauseRef)
        : undefined;
      if (clause?.timeBarDays) {
        noticeDeadline = addDaysISO(body.eventDate, clause.timeBarDays);
        obligationId = newId("obl");
        await app.db.insert(obligations).values({
          id: obligationId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          sourceClause: `${contract.form} ${clause.clauseRef}`,
          trigger: `Notice required: ${body.title}`,
          deadline: `${noticeDeadline}T23:59:59Z`,
          warnDaysBefore: Math.min(14, Math.ceil(clause.timeBarDays / 4)),
          evidenceRequirement: "Served notice with proof of service",
          status: "open",
          createdBy: req.user!.id,
        });
      }

      await app.db.insert(contractEvents).values({
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
        noticeDeadline,
        status: "open",
        obligationId,
        costImpactEstimate: body.costImpactEstimate ?? null,
        timeImpactDaysEstimate: body.timeImpactDaysEstimate ?? null,
        raisedBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "contract_event",
        objectId: id,
        payload: {
          number,
          kind: body.kind,
          clauseRef: body.clauseRef ?? null,
          eventDate: body.eventDate,
          noticeDeadline,
          obligationId,
        },
      });
      const created = await fetchEvent(id, contractId, req.companyId!, req.projectId!);
      return reply
        .status(201)
        .send({ ...created, daysToDeadline: noticeDeadline ? daysUntil(noticeDeadline) : null });
    },
  );

  app.get(
    "/projects/:projectId/contracts/:contractId/events",
    { preHandler: readGate },
    async (req) => {
      const { contractId } = req.params as { contractId: string };
      const q = eventListQuery.parse(req.query);
      await fetchContract(contractId, req.companyId!, req.projectId!);
      await sweepTimeBars([contractId], req.companyId!, req.projectId!, req.user!.id);
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

  app.get(
    "/projects/:projectId/contracts/:contractId/events/:eventId",
    { preHandler: readGate },
    async (req) => {
      const { contractId, eventId } = req.params as { contractId: string; eventId: string };
      const ev = await fetchEvent(eventId, contractId, req.companyId!, req.projectId!);
      return { ...ev, daysToDeadline: ev.noticeDeadline ? daysUntil(ev.noticeDeadline) : null };
    },
  );

  app.post(
    "/projects/:projectId/contracts/:contractId/events/:eventId/serve-notice",
    { preHandler: standardGate },
    async (req) => {
      const { contractId, eventId } = req.params as { contractId: string; eventId: string };
      const body = serveNoticeSchema.parse(req.body);
      const ev = await fetchEvent(eventId, contractId, req.companyId!, req.projectId!);
      if (ev.status !== "open" && ev.status !== "time_barred") {
        throw badRequest(`Notice cannot be served on a ${ev.status} event`);
      }
      const servedAt = body.servedAt ?? new Date().toISOString();
      const servedDate = new Date(servedAt).toISOString().slice(0, 10);
      const late = ev.noticeDeadline !== null && servedDate > ev.noticeDeadline;
      await app.db
        .update(contractEvents)
        .set({
          status: "notice_served",
          noticeServedAt: servedAt,
          noticeMethod: body.method,
          noticeReference: body.reference ?? null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(contractEvents.id, eventId));
      // Evidence-free satisfy of the deadline obligation (#228 keeps the
      // proof on the event's noticeMethod/noticeReference). A breached
      // obligation (already swept) is left breached — serving late does not
      // rewrite the register.
      if (ev.obligationId) {
        await app.db
          .update(obligations)
          .set({ status: "satisfied" })
          .where(and(eq(obligations.id, ev.obligationId), eq(obligations.status, "open")));
      }
      if (late) {
        await app.db.insert(signals).values({
          id: newId("sig"),
          companyId: req.companyId!,
          projectId: req.projectId!,
          detector: "time_bar_breach_risk",
          severity: "high",
          confidence: 1,
          title: "Notice served after time bar",
          explanation:
            `Notice for contract event #${ev.number} ("${ev.title}") was served on ${servedDate}, ` +
            `after the notice deadline of ${ev.noticeDeadline} computed from the event date ${ev.eventDate}. ` +
            `The related entitlement may be barred; review the clause's condition-precedent wording.`,
        });
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "contract_event",
        objectId: eventId,
        payload: {
          from: ev.status,
          to: "notice_served",
          method: body.method,
          servedAt,
          late,
        },
      });
      const updated = await fetchEvent(eventId, contractId, req.companyId!, req.projectId!);
      return {
        ...updated,
        late,
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
      return fetchEotClaim(claimId, contractId, req.companyId!, req.projectId!);
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
        set["daysAwarded"] = body.daysAwarded;
        set["assessedBy"] = req.user!.id;
        set["assessedAt"] = now;
      }
      await app.db.update(eotClaims).set(set).where(eq(eotClaims.id, claimId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "eot_claim",
        objectId: claimId,
        payload: {
          from: claim.status,
          to: body.status,
          daysAwarded: body.status === "assessed" ? body.daysAwarded : claim.daysAwarded,
        },
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
      if (contract.ldRatePerDay == null || !contract.completionDate) {
        return { applicable: false as const };
      }
      const daysLate = Math.max(0, -daysUntil(contract.completionDate));
      const raw = daysLate * contract.ldRatePerDay;
      const accrued = contract.ldCap != null ? Math.min(raw, contract.ldCap) : raw;
      return {
        applicable: true as const,
        completionDate: contract.completionDate,
        daysLate,
        ldRatePerDay: contract.ldRatePerDay,
        ldCap: contract.ldCap,
        accrued,
        capReached: contract.ldCap != null && raw >= contract.ldCap,
      };
    },
  );
};
