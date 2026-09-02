import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import {
  changeEvents,
  changeLineItems,
  equipment,
  equipmentUtilisation,
  potentialChangeOrders,
  timecardAllocations,
  timecards,
  tmTicketLines,
  tmTickets,
  workers,
} from "@constructos/db";
import {
  CHANGE_EVENT_TYPES,
  CHANGE_REASONS,
  SIGNATURE_METHODS,
  TM_LINE_KINDS,
  TM_RATE_BASES,
  TM_TICKET_STATUSES,
  type CostType,
  type TmLineKind,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
// The changes module owns change-order pricing. This module links INTO it and
// reuses its line builder and rollup rather than restating either.
import { recomputeEventRollup } from "../changes/events.js";
import { recomputePcoEstimate } from "../changes/pcos.js";
import { buildLineRow, fetchEvent } from "../changes/shared.js";
import {
  computeTicketTotals,
  formatMoney,
  round2,
  signatureEvidence,
  type TmLineInput,
  type TmTotals,
} from "./tm.js";
import {
  actorOf,
  assertTransition,
  companyOf,
  detailSchema,
  fetchTicket,
  idSchema,
  isoDateSchema,
  ledgerTimecards,
  nowIso,
  pad3,
  projectOf,
  requireBudgetLine,
  requireCostCode,
  requireVendor,
  timecardGates,
  todayIso,
  type TicketRow,
} from "./shared.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const lineSchema = z.object({
  lineKind: z.enum(TM_LINE_KINDS).optional(),
  description: z.string().min(1).max(2000),
  workerId: idSchema.nullable().optional(),
  crewId: idSchema.nullable().optional(),
  equipmentId: idSchema.nullable().optional(),
  materialItemId: idSchema.nullable().optional(),
  timecardId: idSchema.nullable().optional(),
  timecardAllocationId: idSchema.nullable().optional(),
  deliveryLineId: idSchema.nullable().optional(),
  costCodeId: idSchema.nullable().optional(),
  budgetLineItemId: idSchema.nullable().optional(),
  quantity: z.number().nullable().optional(),
  unit: z.string().max(30).nullable().optional(),
  hours: z.number().min(0).max(1000).nullable().optional(),
  rate: z.number().nullable().optional(),
  amount: z.number().nullable().optional(),
  currency: z.string().length(3).optional(),
  isDisputed: z.boolean().optional(),
  disputeNote: z.string().max(4000).nullable().optional(),
  agreedAmount: z.number().nullable().optional(),
  detail: detailSchema.optional(),
});
type LineBody = z.infer<typeof lineSchema>;

const ticketCreateSchema = z.object({
  ticketDate: isoDateSchema.optional(),
  title: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  scopeOfWork: z.string().max(20000).nullable().optional(),
  instructedByName: z.string().max(300).nullable().optional(),
  instructionRef: z.string().max(200).nullable().optional(),
  instructionDate: isoDateSchema.nullable().optional(),
  /** verbal instructions are the norm and the problem — flagged as such */
  wasVerbalInstruction: z.boolean().optional(),
  changeEventId: idSchema.nullable().optional(),
  commitmentId: idSchema.nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  crewId: idSchema.nullable().optional(),
  locationId: idSchema.nullable().optional(),
  locationText: z.string().max(500).nullable().optional(),
  rateBasis: z.enum(TM_RATE_BASES).optional(),
  markupPercent: z.number().min(-100).max(500).nullable().optional(),
  currency: z.string().length(3).optional(),
  photoFileIds: z.array(idSchema).max(200).optional(),
  attachmentFileIds: z.array(idSchema).max(200).optional(),
  lines: z.array(lineSchema).max(300).optional(),
  detail: detailSchema.optional(),
});

const ticketPatchSchema = ticketCreateSchema.omit({ lines: true }).partial();

const ticketListQuery = pageQuerySchema.extend({
  status: z.enum(TM_TICKET_STATUSES).optional(),
  vendorId: idSchema.optional(),
  crewId: idSchema.optional(),
  changeEventId: idSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  /** signed, signed under protest, refused, or never presented */
  signatureState: z.enum(["unsigned", "signed", "signed_under_protest", "refused_to_sign"]).optional(),
  verbalOnly: z.enum(["true", "false"]).optional(),
});

const linesPutSchema = z.object({ lines: z.array(lineSchema).min(1).max(300) });

const sourceSchema = z
  .object({
    timecardAllocationIds: z.array(idSchema).max(300).optional(),
    equipmentUtilisationIds: z.array(idSchema).max(300).optional(),
  })
  .refine(
    (b) =>
      (b.timecardAllocationIds?.length ?? 0) + (b.equipmentUtilisationIds?.length ?? 0) > 0,
    { message: "Name at least one timecard allocation or equipment utilisation row to source." },
  );

const signSchema = z.object({
  outcome: z.enum(["signed", "signed_under_protest", "refused"]),
  signedByName: z.string().min(1).max(300),
  signedByRole: z.string().max(200).nullable().optional(),
  signedByOrganisation: z.string().max(300).nullable().optional(),
  signedByContactId: idSchema.nullable().optional(),
  signedByUserId: idSchema.nullable().optional(),
  signatureMethod: z.enum(SIGNATURE_METHODS).optional(),
  signedAt: z.string().min(1).max(40).optional(),
  signatureFileId: idSchema.nullable().optional(),
  signatureLatitude: z.number().min(-90).max(90).nullable().optional(),
  signatureLongitude: z.number().min(-180).max(180).nullable().optional(),
  signatureDeviceId: z.string().max(200).nullable().optional(),
  protestNote: z.string().max(10000).nullable().optional(),
  refusalNote: z.string().max(10000).nullable().optional(),
});

const submitSchema = z.object({ comment: z.string().max(4000).nullable().optional() });

const promoteSchema = z.object({
  target: z.enum(["change_event", "potential_change_order"]).default("change_event"),
  /** promote into an EXISTING change event rather than raising a new one */
  changeEventId: idSchema.nullable().optional(),
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(20000).nullable().optional(),
  eventType: z.enum(CHANGE_EVENT_TYPES).optional(),
  reason: z.enum(CHANGE_REASONS).nullable().optional(),
  commitmentId: idSchema.nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  /** carry the ticket's priced lines onto the PCO instead of retyping them */
  copyLines: z.boolean().optional(),
});

/* ------------------------------------------------------------------ */
/* Totals                                                              */
/* ------------------------------------------------------------------ */

const KIND_TO_COST_TYPE: Record<TmLineKind, CostType> = {
  labour: "labour",
  equipment: "equipment",
  material: "material",
  subcontract: "subcontract",
  markup: "other",
  other: "other",
};

export type TicketLineRow = typeof tmTicketLines.$inferSelect;

export function lineInputsOf(lines: TicketLineRow[], currency: string): TmLineInput[] {
  return lines.map((l) => ({
    position: l.position + 1,
    lineKind: l.lineKind as TmLineKind,
    description: l.description,
    quantity: l.quantity,
    unit: l.unit,
    hours: l.hours,
    rate: l.rate,
    // `amount` is stored NOT NULL, so a line that was never priced is marked
    // in detail rather than by a null column. Reading it back as null is what
    // keeps an unpriced line from presenting as a zero-value one.
    amount: (l.detail as { unpriced?: boolean } | null)?.unpriced ? null : l.amount,
    currency: l.currency || currency,
    isDisputed: l.isDisputed === 1,
    agreedAmount: l.agreedAmount,
  }));
}

/**
 * Recompute a ticket's totals from its lines and persist them.
 *
 * The stored money columns are NOT NULL, so they hold the PRICED-SO-FAR
 * subtotals; `detail.totals` records whether those subtotals are the whole
 * story and why not. Every read returns the full `totals` object, where an
 * incomplete figure is a null with reasons. A client must render `totals`,
 * never the raw columns, when `totalsAreComplete` is false.
 */
export async function recomputeTicketTotals(db: Db, ticketId: string): Promise<TmTotals> {
  const [ticket] = await db.select().from(tmTickets).where(eq(tmTickets.id, ticketId)).limit(1);
  if (!ticket) throw notFound("T&M ticket not found");
  const lines = await db
    .select()
    .from(tmTicketLines)
    .where(eq(tmTicketLines.ticketId, ticketId))
    .orderBy(asc(tmTicketLines.position));
  const totals = computeTicketTotals({
    lines: lineInputsOf(lines, ticket.currency),
    currency: ticket.currency,
    markupPercent: ticket.markupPercent,
  });
  const pricedSoFar = (kinds: TmLineKind[]): number =>
    round2(
      totals.lines
        .filter((l) => kinds.includes(l.lineKind))
        .reduce((s, l) => s + (l.amount ?? 0), 0),
    );
  const labour = pricedSoFar(["labour"]);
  const equip = pricedSoFar(["equipment"]);
  const material = pricedSoFar(["material"]);
  const subcontract = pricedSoFar(["subcontract"]);
  const other = pricedSoFar(["markup", "other"]);
  const net = round2(labour + equip + material + subcontract + other);
  const markup = round2((net * (totals.markupPercent ?? 0)) / 100);

  await db
    .update(tmTickets)
    .set({
      labourTotal: labour,
      equipmentTotal: equip,
      materialTotal: material,
      subcontractTotal: subcontract,
      markupTotal: markup,
      total: round2(net + markup),
      totalLabourHours: totals.totalLabourHours,
      lineCount: totals.lineCount,
      detail: {
        ...(ticket.detail ?? {}),
        totals: {
          complete: totals.total.value !== null,
          storedColumnsArePricedSoFar: totals.unpricedLineCount > 0,
          unpricedLineCount: totals.unpricedLineCount,
          disputedLineCount: totals.disputedLineCount,
          reasons: totals.total.reasons,
          notes: totals.notes,
          agreedTotal: totals.agreedTotal.value,
          agreedTotalReasons: totals.agreedTotal.reasons,
        },
      },
      updatedAt: nowIso(),
    })
    .where(eq(tmTickets.id, ticketId));
  return totals;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const tmTicketRoutes: FastifyPluginAsync = async (app) => {
  const gates = timecardGates(app);

  async function loadLines(ticketId: string): Promise<TicketLineRow[]> {
    return app.db
      .select()
      .from(tmTicketLines)
      .where(eq(tmTicketLines.ticketId, ticketId))
      .orderBy(asc(tmTicketLines.position));
  }

  /**
   * Every ticket read carries `signature`, derived strictly from the
   * signature columns. `status` is our own workflow and is never allowed to
   * be the source of truth about what the client did: an unsigned ticket must
   * never present as signed, because on a disputed change the presence or
   * absence of a site signature IS the argument.
   */
  async function ticketView(ticketId: string, companyId: string, projectId: string) {
    const ticket = await fetchTicket(app.db, ticketId, companyId, projectId);
    const lines = await loadLines(ticketId);
    const totals = computeTicketTotals({
      lines: lineInputsOf(lines, ticket.currency),
      currency: ticket.currency,
      markupPercent: ticket.markupPercent,
    });
    const signature = signatureEvidence(ticket);
    return {
      ...ticket,
      lines,
      totals,
      totalsAreComplete: totals.total.value !== null,
      signature,
      /** the single most litigated fact on the document, up front */
      isSigned: signature.isSigned,
      verbalInstruction:
        ticket.wasVerbalInstruction === 1
          ? {
              instructedByName: ticket.instructedByName,
              instructionDate: ticket.instructionDate,
              note:
                "This work was instructed VERBALLY. Entitlement to a verbal instruction is won " +
                "or lost on whether the instructor was named at the time and the instruction " +
                "confirmed in writing promptly — both are recorded here.",
            }
          : null,
    };
  }

  /* ---------------------------- create ----------------------------- */

  app.post("/projects/:projectId/tm-tickets", { preHandler: gates.standard }, async (req, reply) => {
    const body = ticketCreateSchema.parse(req.body);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    if (body.vendorId) await requireVendor(app.db, body.vendorId, companyId);
    if (body.changeEventId) await fetchEvent(app.db, body.changeEventId, companyId, projectId);

    // A verbal instruction with nobody's name on it is not an instruction.
    if (body.wasVerbalInstruction && !(body.instructedByName ?? "").trim()) {
      throw badRequest(
        "This ticket is flagged as a verbal instruction but names nobody who gave it. Verbal " +
          "instructions are where entitlement is won or lost, and an unattributed one is worth " +
          "nothing at all — record who said it, and when.",
      );
    }

    const number = await nextRecordNumber(app.db, projectId, "tm_ticket");
    const id = newId("tmt");
    const reference = `TM-${pad3(number)}`;
    const currency = (body.currency ?? "USD").toUpperCase();

    await app.db.insert(tmTickets).values({
      id,
      companyId,
      projectId,
      number,
      reference,
      ticketDate: body.ticketDate ?? todayIso(),
      title: body.title,
      description: body.description ?? null,
      scopeOfWork: body.scopeOfWork ?? null,
      instructedByName: body.instructedByName ?? null,
      instructionRef: body.instructionRef ?? null,
      instructionDate: body.instructionDate ?? null,
      wasVerbalInstruction: body.wasVerbalInstruction ? 1 : 0,
      changeEventId: body.changeEventId ?? null,
      commitmentId: body.commitmentId ?? null,
      vendorId: body.vendorId ?? null,
      crewId: body.crewId ?? null,
      locationId: body.locationId ?? null,
      locationText: body.locationText ?? null,
      rateBasis: body.rateBasis ?? "to_be_agreed",
      markupPercent: body.markupPercent ?? null,
      currency,
      status: "draft",
      signatureMethod: "none",
      photoFileIds: body.photoFileIds ?? [],
      attachmentFileIds: body.attachmentFileIds ?? [],
      detail: body.detail ?? {},
      createdBy: actorOf(req),
    });

    if (body.lines && body.lines.length > 0) {
      await writeLines(companyId, projectId, id, currency, body.lines);
    }
    const totals = await recomputeTicketTotals(app.db, id);
    await ledgerTimecards(app.db, req, "create", "tm_ticket", id, {
      reference,
      title: body.title,
      ticketDate: body.ticketDate ?? todayIso(),
      vendorId: body.vendorId ?? null,
      wasVerbalInstruction: body.wasVerbalInstruction ? 1 : 0,
      instructedByName: body.instructedByName ?? null,
      lineCount: totals.lineCount,
      total: totals.total.value,
      currency,
    });
    return reply.status(201).send(await ticketView(id, companyId, projectId));
  });

  /* ----------------------------- read ------------------------------ */

  app.get("/projects/:projectId/tm-tickets", { preHandler: gates.read }, async (req) => {
    const q = ticketListQuery.parse(req.query);
    const clauses = [eq(tmTickets.companyId, companyOf(req)), eq(tmTickets.projectId, projectOf(req))];
    if (q.status) clauses.push(eq(tmTickets.status, q.status));
    if (q.vendorId) clauses.push(eq(tmTickets.vendorId, q.vendorId));
    if (q.crewId) clauses.push(eq(tmTickets.crewId, q.crewId));
    if (q.changeEventId) clauses.push(eq(tmTickets.changeEventId, q.changeEventId));
    if (q.from) clauses.push(gte(tmTickets.ticketDate, q.from));
    if (q.to) clauses.push(lte(tmTickets.ticketDate, q.to));
    if (q.verbalOnly === "true") clauses.push(eq(tmTickets.wasVerbalInstruction, 1));
    // The signature filter is applied in SQL, not after paging, so `total`
    // means what it says. It reads the signature COLUMNS, never `status`.
    if (q.signatureState === "signed") {
      clauses.push(isNotNull(tmTickets.signedAt));
      clauses.push(eq(tmTickets.signedUnderProtest, 0));
      clauses.push(eq(tmTickets.refusedToSign, 0));
    } else if (q.signatureState === "signed_under_protest") {
      clauses.push(isNotNull(tmTickets.signedAt));
      clauses.push(eq(tmTickets.signedUnderProtest, 1));
      clauses.push(eq(tmTickets.refusedToSign, 0));
    } else if (q.signatureState === "refused_to_sign") {
      clauses.push(eq(tmTickets.refusedToSign, 1));
    } else if (q.signatureState === "unsigned") {
      clauses.push(isNull(tmTickets.signedAt));
      clauses.push(eq(tmTickets.refusedToSign, 0));
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(tmTickets).where(where);
    const rows = await app.db
      .select()
      .from(tmTickets)
      .where(where)
      .orderBy(desc(tmTickets.ticketDate), desc(tmTickets.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const items = rows.map((t) => {
      const signature = signatureEvidence(t);
      return { ...t, signature, isSigned: signature.isSigned };
    });
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/tm-tickets/:ticketId", { preHandler: gates.read }, async (req) => {
    const { ticketId } = req.params as { ticketId: string };
    return ticketView(ticketId, companyOf(req), projectOf(req));
  });

  app.patch(
    "/projects/:projectId/tm-tickets/:ticketId",
    { preHandler: gates.standard },
    async (req) => {
      const { ticketId } = req.params as { ticketId: string };
      const body = ticketPatchSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const ticket = await fetchTicket(app.db, ticketId, companyId, projectId);
      assertUnfrozen(ticket, "edit");
      if (body.vendorId) await requireVendor(app.db, body.vendorId, companyId);
      if (body.changeEventId) await fetchEvent(app.db, body.changeEventId, companyId, projectId);
      const verbal = body.wasVerbalInstruction ?? ticket.wasVerbalInstruction === 1;
      const instructor = body.instructedByName ?? ticket.instructedByName;
      if (verbal && !(instructor ?? "").trim()) {
        throw badRequest(
          "A ticket flagged as a verbal instruction must name who gave it. An unattributed verbal " +
            "instruction is worth nothing when entitlement is argued.",
        );
      }
      const set: Record<string, unknown> = { updatedAt: nowIso() };
      const direct = [
        "ticketDate",
        "title",
        "description",
        "scopeOfWork",
        "instructedByName",
        "instructionRef",
        "instructionDate",
        "changeEventId",
        "commitmentId",
        "vendorId",
        "crewId",
        "locationId",
        "locationText",
        "rateBasis",
        "markupPercent",
        "photoFileIds",
        "attachmentFileIds",
      ] as const;
      for (const key of direct) if (body[key] !== undefined) set[key] = body[key];
      if (body.wasVerbalInstruction !== undefined) {
        set["wasVerbalInstruction"] = body.wasVerbalInstruction ? 1 : 0;
      }
      if (body.currency !== undefined) set["currency"] = body.currency.toUpperCase();
      if (body.detail !== undefined) set["detail"] = { ...(ticket.detail ?? {}), ...body.detail };
      await app.db.update(tmTickets).set(set).where(eq(tmTickets.id, ticketId));
      await recomputeTicketTotals(app.db, ticketId);
      await ledgerTimecards(app.db, req, "update", "tm_ticket", ticketId, {
        reference: ticket.reference,
        changed: Object.keys(body),
      });
      return ticketView(ticketId, companyId, projectId);
    },
  );

  /* ----------------------------- lines ----------------------------- */

  app.get(
    "/projects/:projectId/tm-tickets/:ticketId/lines",
    { preHandler: gates.read },
    async (req) => {
      const { ticketId } = req.params as { ticketId: string };
      const ticket = await fetchTicket(app.db, ticketId, companyOf(req), projectOf(req));
      const lines = await loadLines(ticketId);
      return {
        ticketId,
        reference: ticket.reference,
        lines,
        totals: computeTicketTotals({
          lines: lineInputsOf(lines, ticket.currency),
          currency: ticket.currency,
          markupPercent: ticket.markupPercent,
        }),
      };
    },
  );

  app.put(
    "/projects/:projectId/tm-tickets/:ticketId/lines",
    { preHandler: gates.standard },
    async (req) => {
      const { ticketId } = req.params as { ticketId: string };
      const body = linesPutSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const ticket = await fetchTicket(app.db, ticketId, companyId, projectId);
      assertUnfrozen(ticket, "re-line");
      await writeLines(companyId, projectId, ticketId, ticket.currency, body.lines, true);
      const totals = await recomputeTicketTotals(app.db, ticketId);
      await ledgerTimecards(app.db, req, "update", "tm_ticket_lines", ticketId, {
        reference: ticket.reference,
        lineCount: totals.lineCount,
        total: totals.total.value,
        totalLabourHours: totals.totalLabourHours,
      });
      return ticketView(ticketId, companyId, projectId);
    },
  );

  /**
   * Source lines from what actually happened rather than retyping it.
   *
   * A T&M line built from a `timecard_allocation` carries `timecardId` and
   * `timecardAllocationId`, which is the join between what we PAID a worker
   * and what we BILLED the client for that same hour. Without it a ticket is
   * an assertion with nothing behind it; with it, a client's quantity surveyor
   * can be walked from the ticket to the card to the turnstile record.
   */
  app.post(
    "/projects/:projectId/tm-tickets/:ticketId/lines/source",
    { preHandler: gates.standard },
    async (req) => {
      const { ticketId } = req.params as { ticketId: string };
      const body = sourceSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const ticket = await fetchTicket(app.db, ticketId, companyId, projectId);
      assertUnfrozen(ticket, "add sourced lines to");

      const existing = await loadLines(ticketId);
      const alreadySourced = new Set(
        existing.map((l) => l.timecardAllocationId).filter((v): v is string => !!v),
      );
      const alreadyEquipment = new Set(
        existing.map((l) => (l.detail as { equipmentUtilisationId?: string } | null)?.equipmentUtilisationId)
          .filter((v): v is string => !!v),
      );
      const newLines: LineBody[] = [];
      const skipped: Array<{ id: string; reason: string }> = [];

      if (body.timecardAllocationIds && body.timecardAllocationIds.length > 0) {
        const allocs = await app.db
          .select({ alloc: timecardAllocations, card: timecards, worker: workers })
          .from(timecardAllocations)
          .innerJoin(timecards, eq(timecards.id, timecardAllocations.timecardId))
          .innerJoin(workers, eq(workers.id, timecards.workerId))
          .where(
            and(
              eq(timecardAllocations.projectId, projectId),
              inArray(timecardAllocations.id, body.timecardAllocationIds),
            ),
          );
        const found = new Set(allocs.map((a) => a.alloc.id));
        for (const id of body.timecardAllocationIds) {
          if (!found.has(id)) skipped.push({ id, reason: "not a timecard allocation on this project" });
        }
        for (const { alloc, card, worker } of allocs) {
          if (alreadySourced.has(alloc.id)) {
            skipped.push({ id: alloc.id, reason: "already on this ticket" });
            continue;
          }
          if (alloc.tmTicketId && alloc.tmTicketId !== ticketId) {
            skipped.push({
              id: alloc.id,
              reason: `already billed on T&M ticket ${alloc.tmTicketId} — an hour is billed once`,
            });
            continue;
          }
          if (alloc.currency.toUpperCase() !== ticket.currency.toUpperCase()) {
            skipped.push({
              id: alloc.id,
              reason: `is in ${alloc.currency} and this ticket is in ${ticket.currency}`,
            });
            continue;
          }
          newLines.push({
            lineKind: "labour",
            description:
              `${worker.fullName} (${worker.reference}) — ${card.workDate} ${card.shift} shift` +
              (alloc.costCode ? `, ${alloc.costCode}` : ""),
            workerId: worker.id,
            crewId: card.crewId,
            timecardId: card.id,
            timecardAllocationId: alloc.id,
            costCodeId: alloc.costCodeId,
            budgetLineItemId: alloc.budgetLineItemId,
            hours: alloc.totalHours,
            rate: alloc.hourlyRate,
            unit: "hour",
            currency: alloc.currency,
          });
        }
      }

      if (body.equipmentUtilisationIds && body.equipmentUtilisationIds.length > 0) {
        const rows = await app.db
          .select({ util: equipmentUtilisation, plant: equipment })
          .from(equipmentUtilisation)
          .innerJoin(equipment, eq(equipment.id, equipmentUtilisation.equipmentId))
          .where(
            and(
              eq(equipmentUtilisation.projectId, projectId),
              inArray(equipmentUtilisation.id, body.equipmentUtilisationIds),
            ),
          );
        const found = new Set(rows.map((r) => r.util.id));
        for (const id of body.equipmentUtilisationIds) {
          if (!found.has(id)) {
            skipped.push({ id, reason: "not an equipment utilisation row on this project" });
          }
        }
        for (const { util, plant } of rows) {
          if (alreadyEquipment.has(util.id)) {
            skipped.push({ id: util.id, reason: "already on this ticket" });
            continue;
          }
          if (util.tmTicketId && util.tmTicketId !== ticketId) {
            skipped.push({
              id: util.id,
              reason: `already billed on T&M ticket ${util.tmTicketId} — an hour is billed once`,
            });
            continue;
          }
          if (util.currency.toUpperCase() !== ticket.currency.toUpperCase()) {
            skipped.push({
              id: util.id,
              reason: `is in ${util.currency} and this ticket is in ${ticket.currency}`,
            });
            continue;
          }
          const hours = round2(util.workingHours + util.standbyHours);
          newLines.push({
            lineKind: "equipment",
            description:
              `${plant.name} (${plant.reference}) — ${util.utilisationDate} ${util.shift} shift, ` +
              `${util.workingHours} working + ${util.standbyHours} standby hour(s)`,
            equipmentId: plant.id,
            crewId: util.crewId,
            costCodeId: util.costCodeId,
            budgetLineItemId: util.budgetLineItemId,
            hours,
            // The hire rate is NOT assumed from the machine record: what a
            // client pays for plant on a daywork ticket is a contract rate,
            // and an unpriced line is the honest state until it is agreed.
            rate: null,
            amount: util.hireCost !== null ? round2(util.hireCost) : null,
            unit: "hour",
            currency: util.currency,
            detail: { equipmentUtilisationId: util.id, source: util.source },
          });
        }
      }

      if (newLines.length === 0) {
        throw badRequest(
          `Nothing was sourced onto ${ticket.reference}. ` +
            skipped.map((s) => `${s.id}: ${s.reason}`).join("; "),
        );
      }

      const position = existing.length;
      await insertLines(companyId, projectId, ticketId, ticket.currency, newLines, position);
      // Link the source rows back, so double-billing the same hour is visible.
      const allocIds = newLines
        .map((l) => l.timecardAllocationId)
        .filter((v): v is string => !!v);
      if (allocIds.length > 0) {
        await app.db
          .update(timecardAllocations)
          .set({ tmTicketId: ticketId, isBillable: 1, updatedAt: nowIso() })
          .where(inArray(timecardAllocations.id, allocIds));
      }
      const utilIds = newLines
        .map((l) => (l.detail as { equipmentUtilisationId?: string } | undefined)?.equipmentUtilisationId)
        .filter((v): v is string => !!v);
      if (utilIds.length > 0) {
        await app.db
          .update(equipmentUtilisation)
          .set({ tmTicketId: ticketId, isBillable: 1, updatedAt: nowIso() })
          .where(inArray(equipmentUtilisation.id, utilIds));
      }
      const totals = await recomputeTicketTotals(app.db, ticketId);
      await ledgerTimecards(app.db, req, "update", "tm_ticket_lines", ticketId, {
        reference: ticket.reference,
        sourced: newLines.length,
        skipped: skipped.length,
        totalLabourHours: totals.totalLabourHours,
      });
      return {
        ...(await ticketView(ticketId, companyId, projectId)),
        sourced: newLines.length,
        skipped,
      };
    },
  );

  /* --------------------------- signature --------------------------- */

  /**
   * THE SIGNATURE. The whole document exists for this.
   *
   * Three outcomes, all of them real and all of them recorded distinctly:
   *
   *  - `signed` — an unqualified site signature.
   *  - `signed_under_protest` — "signed for record of hours only, without
   *    prejudice". This is NOT a signature for the purposes of acceptance and
   *    never reports as one; a protest note is required, because the note is
   *    the endorsement that decides what the ticket is worth later.
   *  - `refused` — the representative declined. `signedAt` stays NULL and the
   *    refusal is recorded with its note. A refusal is evidence in its own
   *    right: it fixes the date the client was told and declined, which is
   *    frequently worth more in a dispute than a clean signature would be.
   */
  app.post(
    "/projects/:projectId/tm-tickets/:ticketId/sign",
    { preHandler: gates.standard },
    async (req) => {
      const { ticketId } = req.params as { ticketId: string };
      const body = signSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const ticket = await fetchTicket(app.db, ticketId, companyId, projectId);
      assertUnfrozen(ticket, "sign");

      const current = signatureEvidence(ticket);
      if (current.hasClientResponse) {
        throw conflict(
          `${ticket.reference} already carries a client response: ${current.summary} A signature ` +
            "block is written once. If the position has changed, raise a superseding ticket so " +
            "both records survive.",
        );
      }

      const method = body.signatureMethod ?? (body.outcome === "refused" ? "none" : "on_device");
      if (body.outcome !== "refused") {
        if (method === "none") {
          throw badRequest(
            "A signature needs a method — wet ink scanned, on device, typed, biometric or email " +
              "confirmation. \"none\" is what an unsigned ticket carries, and an unsigned ticket " +
              "must never present as signed.",
          );
        }
        if (!(body.signedByRole ?? "").trim() || !(body.signedByOrganisation ?? "").trim()) {
          throw badRequest(
            "Record the signatory's ROLE and ORGANISATION. \"J. Smith\" proves nothing; \"J. Smith, " +
              "Resident Engineer, Owner's Representative\" is the fact that makes the signature " +
              "bind somebody.",
          );
        }
      }
      if (body.outcome === "signed_under_protest" && !(body.protestNote ?? "").trim()) {
        throw badRequest(
          "A signature under protest needs its protest note. The endorsement — \"signed for record " +
            "of hours only, without prejudice to liability\" — is the entire difference between a " +
            "ticket that admits the change and one that merely admits the people were there.",
        );
      }
      if (body.outcome === "refused" && !(body.refusalNote ?? "").trim()) {
        throw badRequest(
          "A refusal to sign needs its note: who refused, and the reason they gave. A bare " +
            "\"refused\" is an assertion; a recorded reason is evidence.",
        );
      }

      const signedAt = body.outcome === "refused" ? null : (body.signedAt ?? nowIso());
      const status =
        body.outcome === "signed"
          ? "signed"
          : body.outcome === "signed_under_protest"
            ? "signed_under_protest"
            : "disputed";

      await app.db
        .update(tmTickets)
        .set({
          signedByName: body.signedByName,
          signedByRole: body.signedByRole ?? null,
          signedByOrganisation: body.signedByOrganisation ?? null,
          signedByContactId: body.signedByContactId ?? null,
          signedByUserId: body.signedByUserId ?? null,
          signedAt,
          signatureMethod: method,
          signatureFileId: body.signatureFileId ?? null,
          signatureLatitude: body.signatureLatitude ?? null,
          signatureLongitude: body.signatureLongitude ?? null,
          signatureDeviceId: body.signatureDeviceId ?? null,
          signedUnderProtest: body.outcome === "signed_under_protest" ? 1 : 0,
          protestNote: body.outcome === "signed_under_protest" ? (body.protestNote ?? null) : null,
          refusedToSign: body.outcome === "refused" ? 1 : 0,
          refusalNote: body.outcome === "refused" ? (body.refusalNote ?? null) : null,
          disputedReason: body.outcome === "refused" ? (body.refusalNote ?? null) : ticket.disputedReason,
          status,
          detail: {
            ...(ticket.detail ?? {}),
            signature: {
              outcome: body.outcome,
              recordedAt: nowIso(),
              recordedBy: actorOf(req),
              /** a refusal has no signedAt, so the moment is kept here */
              refusedAt: body.outcome === "refused" ? nowIso() : null,
              location:
                body.signatureLatitude !== undefined && body.signatureLongitude !== undefined
                  ? { latitude: body.signatureLatitude, longitude: body.signatureLongitude }
                  : null,
              deviceId: body.signatureDeviceId ?? null,
            },
          },
          updatedAt: nowIso(),
        })
        .where(eq(tmTickets.id, ticketId));

      await ledgerTimecards(app.db, req, "state_change", "tm_ticket_signature", ticketId, {
        reference: ticket.reference,
        outcome: body.outcome,
        signedByName: body.signedByName,
        signedByRole: body.signedByRole ?? null,
        signedByOrganisation: body.signedByOrganisation ?? null,
        signatureMethod: method,
        signedAt,
        signedUnderProtest: body.outcome === "signed_under_protest",
        refusedToSign: body.outcome === "refused",
        protestNote: body.protestNote ?? null,
        refusalNote: body.refusalNote ?? null,
        latitude: body.signatureLatitude ?? null,
        longitude: body.signatureLongitude ?? null,
        deviceId: body.signatureDeviceId ?? null,
      });
      return ticketView(ticketId, companyId, projectId);
    },
  );

  app.post(
    "/projects/:projectId/tm-tickets/:ticketId/submit",
    { preHandler: gates.standard },
    async (req) => {
      const { ticketId } = req.params as { ticketId: string };
      const body = submitSchema.parse(req.body ?? {});
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const ticket = await fetchTicket(app.db, ticketId, companyId, projectId);
      assertTransition(ticket.status, ["draft"], "T&M ticket", "submit");
      const lines = await loadLines(ticketId);
      if (lines.length === 0) {
        throw conflict(
          `${ticket.reference} has no lines. A ticket with nothing on it evidences nothing.`,
        );
      }
      await app.db
        .update(tmTickets)
        .set({
          status: "submitted",
          submittedBy: actorOf(req),
          submittedAt: nowIso(),
          detail: { ...(ticket.detail ?? {}), submitComment: body.comment ?? null },
          updatedAt: nowIso(),
        })
        .where(eq(tmTickets.id, ticketId));
      await ledgerTimecards(app.db, req, "state_change", "tm_ticket", ticketId, {
        reference: ticket.reference,
        from: ticket.status,
        to: "submitted",
      });
      return ticketView(ticketId, companyId, projectId);
    },
  );

  /* --------------------------- promotion --------------------------- */

  /**
   * Promote a ticket into the change chain.
   *
   * A T&M ticket with a client-side signature event is the evidence a change
   * was INSTRUCTED — it is a change-order origin, not a filing cabinet. This
   * route creates (or attaches to) a `change_event` in the change-management
   * module and, optionally, a `potential_change_order` carrying the ticket's
   * priced lines, then stamps `incorporatedChangeOrderId` so the ticket stops
   * being a loose claim.
   *
   * PRICING IS NOT DUPLICATED HERE. The PCO's line arithmetic and the
   * contractual markup stack belong to that module and are called, not
   * restated. A ticket with unpriced lines therefore cannot become a PCO — it
   * has hours and no cost position — but it CAN become a change event, which
   * is precisely what preserves the entitlement while the rates are argued.
   */
  app.post(
    "/projects/:projectId/tm-tickets/:ticketId/promote",
    { preHandler: gates.standard },
    async (req, reply) => {
      const body = promoteSchema.parse(req.body ?? {});
      const { ticketId } = req.params as { ticketId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const actorId = actorOf(req);
      const ticket = await fetchTicket(app.db, ticketId, companyId, projectId);

      if (ticket.incorporatedChangeOrderId) {
        throw conflict(
          `${ticket.reference} was already incorporated at ${ticket.incorporatedAt} into ` +
            `${ticket.incorporatedChangeOrderId}. A ticket is absorbed once, or the same hours are ` +
            "claimed twice.",
        );
      }
      const signature = signatureEvidence(ticket);
      if (!signature.hasClientResponse) {
        throw conflict(
          `${ticket.reference} carries no client response at all — no signature, no protest and no ` +
            "recorded refusal. There is nothing here that evidences an instruction, so it cannot " +
            "be promoted into the change chain. Present it on site and record what the client's " +
            "representative did, including a refusal.",
        );
      }
      if (ticket.status === "void") {
        throw conflict(`${ticket.reference} is void.`);
      }

      const lines = await loadLines(ticketId);
      const totals = computeTicketTotals({
        lines: lineInputsOf(lines, ticket.currency),
        currency: ticket.currency,
        markupPercent: ticket.markupPercent,
      });

      // Attach to an existing change event, or raise one.
      let eventId: string;
      let eventReference: string;
      let created = false;
      if (body.changeEventId ?? ticket.changeEventId) {
        const event = await fetchEvent(
          app.db,
          (body.changeEventId ?? ticket.changeEventId)!,
          companyId,
          projectId,
        );
        if (event.status === "void") {
          throw conflict(`Change event ${event.reference} is void — nothing to incorporate into.`);
        }
        eventId = event.id;
        eventReference = event.reference;
      } else {
        const number = await nextRecordNumber(app.db, projectId, "change_event");
        eventId = newId("cev");
        eventReference = `CE-${pad3(number)}`;
        created = true;
        await app.db.insert(changeEvents).values({
          id: eventId,
          companyId,
          projectId,
          number,
          reference: eventReference,
          title: body.title ?? ticket.title,
          description:
            body.description ??
            [ticket.description, ticket.scopeOfWork].filter(Boolean).join("\n\n") ??
            null,
          status: "open",
          eventType: body.eventType ?? "owner_change",
          scope: "additive",
          reason: body.reason ?? (ticket.wasVerbalInstruction === 1 ? "client_request" : null),
          // CHANGE_EVENT_ORIGIN_KINDS holds no "tm_ticket" member, so the
          // provenance is recorded in `detail.origin` rather than misfiled
          // under an origin kind that means something else.
          originType: "manual",
          originId: null,
          roughOrderOfMagnitude: totals.total.value ?? 0,
          scheduleImpactDays: 0,
          identifiedDate: ticket.ticketDate,
          notes:
            `Raised from T&M ticket ${ticket.reference} (${ticket.ticketDate}). ${signature.summary}` +
            (ticket.wasVerbalInstruction === 1
              ? ` Instructed verbally by ${ticket.instructedByName ?? "an unnamed person"}.`
              : ""),
          documentIds: [],
          detail: {
            origin: {
              originType: "tm_ticket",
              originId: ticket.id,
              verified: true,
              label: `${ticket.reference} — ${ticket.title}`,
              reasons: [],
            },
            tmTicket: {
              id: ticket.id,
              reference: ticket.reference,
              ticketDate: ticket.ticketDate,
              signatureState: signature.state,
              signatureSummary: signature.summary,
              signedByName: ticket.signedByName,
              signedByRole: ticket.signedByRole,
              signedByOrganisation: ticket.signedByOrganisation,
              wasVerbalInstruction: ticket.wasVerbalInstruction === 1,
              instructedByName: ticket.instructedByName,
              totalLabourHours: totals.totalLabourHours,
              total: totals.total.value,
              totalReasons: totals.total.reasons,
              currency: ticket.currency,
            },
          },
          createdBy: actorId,
        });
      }

      let pcoId: string | null = null;
      let pcoReference: string | null = null;
      if (body.target === "potential_change_order") {
        if (totals.total.value === null) {
          throw conflict(
            `${ticket.reference} cannot become a potential change order: ${totals.total.reasons.join(" ")} ` +
              "A PCO is a cost position, and this ticket does not have one yet. It has been " +
              `promoted to change event ${eventReference} instead, which preserves the entitlement ` +
              "while the rates are agreed — price the lines, then raise the PCO.",
          );
        }
        if (body.vendorId) await requireVendor(app.db, body.vendorId, companyId);
        const number = await nextRecordNumber(app.db, projectId, "potential_change_order");
        pcoId = newId("pco");
        pcoReference = `PCO-${pad3(number)}`;
        const vendorId = body.vendorId ?? ticket.vendorId ?? null;
        await app.db.insert(potentialChangeOrders).values({
          id: pcoId,
          companyId,
          projectId,
          changeEventId: eventId,
          number,
          reference: pcoReference,
          title: body.title ?? ticket.title,
          description: body.description ?? ticket.description ?? null,
          status: "draft",
          reason: body.reason ?? null,
          scope: "additive",
          commitmentId: body.commitmentId ?? ticket.commitmentId ?? null,
          vendorId,
          estimatedAmount: totals.total.value,
          quotedAmount: 0,
          amount: 0,
          scheduleImpactDays: 0,
          noCharge: 0,
          detail: {
            tmTicketId: ticket.id,
            tmTicketReference: ticket.reference,
            signatureState: signature.state,
          },
          createdBy: actorId,
        });
        if (body.copyLines !== false) {
          // buildLineRow is the changes module's own line builder — its
          // derivation rules and its refusals, not a second implementation.
          let sort = 0;
          for (const line of totals.lines) {
            sort += 10;
            await app.db.insert(changeLineItems).values(
              buildLineRow(
                { companyId, projectId, changeEventId: eventId, createdBy: actorId },
                "potential_change_order",
                pcoId,
                {
                  description: `${ticket.reference} L${line.position}: ${line.description}`,
                  costType: KIND_TO_COST_TYPE[line.lineKind],
                  costAmount: line.amount ?? 0,
                  ...(line.hours != null ? { quantity: line.hours, unit: "hour" } : {}),
                  ...(line.hours != null && line.rate != null ? { unitRate: line.rate } : {}),
                },
                sort,
              ),
            );
          }
          // The site-agreed daywork percentage becomes a line of its own so
          // the PCO's own estimate reconciles with the ticket that produced
          // it. The CONTRACTUAL markup stack — overhead on cost, profit on
          // cost-plus-overhead — is the changes module's, and is applied
          // there when the PCO is priced; nothing here anticipates it.
          if (totals.markupTotal.value != null && totals.markupTotal.value !== 0) {
            sort += 10;
            await app.db.insert(changeLineItems).values(
              buildLineRow(
                { companyId, projectId, changeEventId: eventId, createdBy: actorId },
                "potential_change_order",
                pcoId,
                {
                  description:
                    `${ticket.reference}: daywork markup at ${totals.markupPercent}% on ` +
                    `${formatMoney(totals.netTotal.value ?? 0)} ${ticket.currency}, as signed on the ticket`,
                  costType: "other",
                  costAmount: totals.markupTotal.value,
                },
                sort,
              ),
            );
          }
          await recomputePcoEstimate(app.db, pcoId);
        }
      }

      await recomputeEventRollup(app.db, eventId);

      const incorporatedId = pcoId ?? eventId;
      await app.db
        .update(tmTickets)
        .set({
          changeEventId: eventId,
          incorporatedChangeOrderId: incorporatedId,
          incorporatedAt: nowIso(),
          status: "incorporated",
          detail: {
            ...(ticket.detail ?? {}),
            incorporation: {
              target: body.target,
              changeEventId: eventId,
              changeEventReference: eventReference,
              changeEventCreated: created,
              potentialChangeOrderId: pcoId,
              potentialChangeOrderReference: pcoReference,
              incorporatedChangeOrderId: incorporatedId,
              signatureState: signature.state,
              total: totals.total.value,
              totalReasons: totals.total.reasons,
              currency: ticket.currency,
            },
          },
          updatedAt: nowIso(),
        })
        .where(eq(tmTickets.id, ticketId));

      // Carry the change link down onto the timecard allocations behind the
      // ticket, so labour spent on a change is findable from the cost side.
      const allocIds = lines.map((l) => l.timecardAllocationId).filter((v): v is string => !!v);
      if (allocIds.length > 0) {
        await app.db
          .update(timecardAllocations)
          .set({ changeEventId: eventId, updatedAt: nowIso() })
          .where(inArray(timecardAllocations.id, allocIds));
      }

      await ledgerTimecards(app.db, req, "state_change", "tm_ticket", ticketId, {
        reference: ticket.reference,
        from: ticket.status,
        to: "incorporated",
        target: body.target,
        changeEventId: eventId,
        changeEventReference: eventReference,
        changeEventCreated: created,
        potentialChangeOrderId: pcoId,
        incorporatedChangeOrderId: incorporatedId,
        signatureState: signature.state,
        total: totals.total.value,
        currency: ticket.currency,
      });

      return reply.status(201).send({
        ticket: await ticketView(ticketId, companyId, projectId),
        changeEvent: { id: eventId, reference: eventReference, created },
        potentialChangeOrder: pcoId ? { id: pcoId, reference: pcoReference } : null,
        incorporatedChangeOrderId: incorporatedId,
        total: totals.total,
        note:
          `${ticket.reference} is now on the change chain as ${eventReference}` +
          (pcoReference ? ` → ${pcoReference}` : "") +
          ". Pricing beyond this point is the change-management module's; nothing here restates it.",
      });
    },
  );

  /* --------------------------- helpers ----------------------------- */

  function assertUnfrozen(ticket: TicketRow, what: string): void {
    if (ticket.status === "incorporated") {
      throw conflict(
        `Cannot ${what} ${ticket.reference}: it has been incorporated into ` +
          `${ticket.incorporatedChangeOrderId}. Change the change order, not the evidence behind it.`,
      );
    }
    if (ticket.status === "void") {
      throw conflict(`Cannot ${what} ${ticket.reference}: it is void.`);
    }
    if (ticket.signedAt !== null || ticket.refusedToSign === 1) {
      if (what !== "sign") {
        throw conflict(
          `Cannot ${what} ${ticket.reference}: ${signatureEvidence(ticket).summary} The document ` +
            "the client responded to must stay exactly as it was when they responded. Raise a " +
            "superseding ticket instead.",
        );
      }
    }
  }

  async function writeLines(
    companyId: string,
    projectId: string,
    ticketId: string,
    currency: string,
    lines: LineBody[],
    replace = false,
  ): Promise<void> {
    for (const [i, l] of lines.entries()) {
      if (l.costCodeId) await requireCostCode(app.db, l.costCodeId, companyId);
      if (l.budgetLineItemId) await requireBudgetLine(app.db, l.budgetLineItemId, companyId, projectId);
      const lineCurrency = (l.currency ?? currency).toUpperCase();
      if (lineCurrency !== currency.toUpperCase()) {
        throw badRequest(
          `Line ${i + 1} is in ${lineCurrency} while the ticket is in ${currency}. Money is never ` +
            "summed across currencies here — raise a separate ticket per currency.",
        );
      }
      if (l.isDisputed && !(l.disputeNote ?? "").trim()) {
        throw badRequest(
          `Line ${i + 1} is marked disputed with no note. What the client struck, and why, is the ` +
            "part of the record that matters when the ticket is finally valued.",
        );
      }
    }
    if (replace) {
      await app.db.delete(tmTicketLines).where(eq(tmTicketLines.ticketId, ticketId));
    }
    await insertLines(companyId, projectId, ticketId, currency, lines, replace ? 0 : undefined);
  }

  async function insertLines(
    companyId: string,
    projectId: string,
    ticketId: string,
    currency: string,
    lines: LineBody[],
    startPosition?: number,
  ): Promise<void> {
    let position = startPosition ?? (await loadLines(ticketId)).length;
    for (const l of lines) {
      const priced =
        l.amount != null
          ? round2(l.amount)
          : l.hours != null && l.rate != null
            ? round2(l.hours * l.rate)
            : l.quantity != null && l.rate != null
              ? round2(l.quantity * l.rate)
              : null;
      await app.db.insert(tmTicketLines).values({
        id: newId("tml"),
        companyId,
        projectId,
        ticketId,
        position,
        lineKind: l.lineKind ?? "labour",
        description: l.description,
        workerId: l.workerId ?? null,
        crewId: l.crewId ?? null,
        equipmentId: l.equipmentId ?? null,
        materialItemId: l.materialItemId ?? null,
        timecardId: l.timecardId ?? null,
        timecardAllocationId: l.timecardAllocationId ?? null,
        deliveryLineId: l.deliveryLineId ?? null,
        costCodeId: l.costCodeId ?? null,
        budgetLineItemId: l.budgetLineItemId ?? null,
        quantity: l.quantity ?? null,
        unit: l.unit ?? null,
        hours: l.hours ?? null,
        rate: l.rate ?? null,
        // NOT NULL in the schema; `detail.unpriced` is what distinguishes a
        // line genuinely worth zero from one nobody has priced yet.
        amount: priced ?? 0,
        currency: (l.currency ?? currency).toUpperCase(),
        isDisputed: l.isDisputed ? 1 : 0,
        disputeNote: l.disputeNote ?? null,
        agreedAmount: l.agreedAmount ?? null,
        detail: { ...(l.detail ?? {}), unpriced: priced === null },
      });
      position += 1;
    }
  }
};
