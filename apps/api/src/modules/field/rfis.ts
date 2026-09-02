/**
 * RFIs — spec Vol I §2.4 #302–#325.
 *
 * Covers: numbered drafts with private drafting (#325), issue with due-date
 * defaulting, ball-in-court tracking and analytics (#321), ageing and
 * cycle-time measured from issue (#322), a response-approval workflow of
 * draft responses adopted as the official answer (#311), references to
 * prior RFIs (#316), inbound email ingestion (#324), and a locked question
 * once issued with before/after ledger snapshots.
 *
 * Does NOT do: AI evaluation of RFIs (modules/ai owns that) or drawing
 * markup linking (drawings module; use recordLinks).
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, lt, ne, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { companyMemberships, rfiResponses, rfis, users } from "@constructos/db";
import { RFI_SOURCES, RFI_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { pushNotifications } from "../notifications/service.js";
import { addDaysISO, isoDateSchema, todayISO } from "./dates.js";
import { assertCompanyUsers, assertProjectLocation, hasToolAdmin } from "./access.js";
import { ageInDays, bucketise, daysOverdue } from "./ageingEngine.js";
import { ballInCourtSummary, cycleTimeStats } from "./rfiEngine.js";
import { parseInboundRfiEmail } from "./emailIngest.js";
import { actorOf, jsonbHas, nowIso, pad3, pick } from "./shared.js";

const impactSchema = z.enum(["yes", "no", "tbd"]);

const rfiCreateSchema = z.object({
  subject: z.string().min(1).max(300),
  question: z.string().min(1).max(20000),
  proposedSolution: z.string().max(20000).nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  ballInCourtId: z.string().nullable().optional(),
  distribution: z.array(z.string().min(1)).max(50).optional(),
  dueDate: isoDateSchema.nullable().optional(),
  costImpact: impactSchema.optional(),
  scheduleImpact: impactSchema.optional(),
  scheduleImpactDays: z.number().int().min(0).nullable().optional(),
  locationId: z.string().nullable().optional(),
  isPrivate: z.boolean().optional(),
  visibleTo: z.array(z.string().min(1)).max(50).optional(),
  relatedRfiIds: z.array(z.string().min(1)).max(20).optional(),
  fileIds: z.array(z.string().min(1)).max(50).optional(),
});

const rfiPatchSchema = rfiCreateSchema.partial();

/** Fields that are frozen once the RFI has left draft (audit: rfis.ts:218). */
const LOCKED_AFTER_DRAFT = ["subject", "question", "proposedSolution"] as const;

const rfiListQuery = pageQuerySchema.extend({
  status: z.enum(RFI_STATUSES).optional(),
  assigneeId: z.string().optional(),
  ballInCourtId: z.string().optional(),
  source: z.enum(RFI_SOURCES).optional(),
  overdue: z.enum(["true", "false"]).optional(),
  search: z.string().max(200).optional(),
});

const respondSchema = z.object({
  officialResponse: z.string().min(1).max(20000),
  costImpact: impactSchema.optional(),
  scheduleImpact: impactSchema.optional(),
  scheduleImpactDays: z.number().int().min(0).nullable().optional(),
});

const draftResponseSchema = z.object({
  body: z.string().min(1).max(20000),
  costImpact: impactSchema.optional(),
  scheduleImpact: impactSchema.optional(),
  scheduleImpactDays: z.number().int().min(0).nullable().optional(),
});

const inboundSchema = z.object({
  email: z.object({
    from: z.string().min(3).max(320),
    to: z.array(z.string()).max(20).optional(),
    subject: z.string().max(998),
    text: z.string().max(200000).optional(),
    html: z.string().max(500000).optional(),
    messageId: z.string().max(500).optional(),
    receivedAt: z.string().max(40).optional(),
    attachments: z
      .array(z.object({ fileId: z.string().optional(), filename: z.string().optional() }))
      .max(50)
      .optional(),
  }),
});

const ageingQuery = z.object({ groupBy: z.enum(["assignee", "ballInCourt"]).default("ballInCourt") });

export const rfiRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("rfis", "read")];
  const standardGate = [app.authenticate, app.requireCompany, app.requireTool("rfis", "standard")];

  const label = (n: number) => `RFI-${pad3(n)}`;

  /** Rows the caller may see: public, or private and the caller is a party to it. */
  function visibilityClause(userId: string): SQL {
    return or(
      eq(rfis.isPrivate, 0),
      eq(rfis.createdBy, userId),
      eq(rfis.assigneeId, userId),
      eq(rfis.ballInCourtId, userId),
      jsonbHas(rfis.visibleTo, userId),
      jsonbHas(rfis.distribution, userId),
    )!;
  }

  async function isRfiAdmin(req: FastifyRequest): Promise<boolean> {
    return hasToolAdmin(app, actorOf(req), req.projectId!, "rfis");
  }

  async function fetchRfi(rfiId: string, req: FastifyRequest) {
    const rows = await app.db
      .select()
      .from(rfis)
      .where(and(eq(rfis.id, rfiId), eq(rfis.companyId, req.companyId!), eq(rfis.projectId, req.projectId!)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("RFI not found");
    if (row.isPrivate === 1) {
      const me = req.user!.id;
      const party =
        row.createdBy === me ||
        row.assigneeId === me ||
        row.ballInCourtId === me ||
        row.visibleTo.includes(me) ||
        row.distribution.includes(me);
      if (!party && !(await isRfiAdmin(req))) throw notFound("RFI not found");
    }
    return row;
  }

  async function ledgerRfi(
    action: "create" | "update" | "state_change",
    rfiId: string,
    req: FastifyRequest,
    payload: unknown,
    storePayload = false,
  ) {
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action,
      objectType: "rfi",
      objectId: rfiId,
      payload,
      storePayload,
      projectId: req.projectId!,
    });
  }

  async function validateParties(
    req: FastifyRequest,
    body: { assigneeId?: string | null; ballInCourtId?: string | null; distribution?: string[]; visibleTo?: string[]; locationId?: string | null },
  ) {
    await assertCompanyUsers(
      app.db,
      req.companyId!,
      [body.assigneeId, body.ballInCourtId, ...(body.distribution ?? []), ...(body.visibleTo ?? [])],
      "user",
    );
    await assertProjectLocation(app.db, req.companyId!, req.projectId!, body.locationId);
  }

  async function validateRelated(req: FastifyRequest, ids: string[] | undefined, selfId?: string) {
    if (!ids || ids.length === 0) return [];
    const unique = [...new Set(ids)].filter((id) => id !== selfId);
    if (unique.length === 0) return [];
    const rows = await app.db
      .select({ id: rfis.id })
      .from(rfis)
      .where(and(eq(rfis.companyId, req.companyId!), eq(rfis.projectId, req.projectId!), inArray(rfis.id, unique)));
    const found = new Set(rows.map((r) => r.id));
    const missing = unique.find((id) => !found.has(id));
    if (missing) throw badRequest(`Related RFI "${missing}" is not in this project`);
    return unique;
  }

  /* ---------------------------------------------------------------- */
  /* Create / list                                                     */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/rfis", { preHandler: standardGate }, async (req, reply) => {
    const body = rfiCreateSchema.parse(req.body);
    await validateParties(req, body);
    const relatedRfiIds = await validateRelated(req, body.relatedRfiIds);
    const number = await nextRecordNumber(app.db, req.projectId!, "rfi");
    const id = newId("rfi");
    const row: typeof rfis.$inferInsert = {
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      number,
      subject: body.subject,
      question: body.question,
      proposedSolution: body.proposedSolution ?? null,
      status: "draft",
      assigneeId: body.assigneeId ?? null,
      ballInCourtId: body.ballInCourtId ?? body.assigneeId ?? null,
      distribution: body.distribution ?? [],
      dueDate: body.dueDate ?? null,
      costImpact: body.costImpact ?? "tbd",
      scheduleImpact: body.scheduleImpact ?? "tbd",
      scheduleImpactDays: body.scheduleImpactDays ?? null,
      locationId: body.locationId ?? null,
      isPrivate: body.isPrivate ? 1 : 0,
      visibleTo: body.visibleTo ?? [],
      relatedRfiIds,
      fileIds: body.fileIds ?? [],
      source: "manual",
      createdBy: req.user!.id,
    };
    await app.db.insert(rfis).values(row);
    await ledgerRfi("create", id, req, { number, subject: body.subject, isPrivate: row.isPrivate === 1 });
    return reply.status(201).send(await fetchRfi(id, req));
  });

  app.get("/projects/:projectId/rfis", { preHandler: readGate }, async (req) => {
    const q = rfiListQuery.parse(req.query);
    const clauses: SQL[] = [eq(rfis.companyId, req.companyId!), eq(rfis.projectId, req.projectId!)];
    if (!(await isRfiAdmin(req))) clauses.push(visibilityClause(req.user!.id));
    if (q.status) clauses.push(eq(rfis.status, q.status));
    if (q.assigneeId) clauses.push(eq(rfis.assigneeId, q.assigneeId));
    if (q.ballInCourtId) clauses.push(eq(rfis.ballInCourtId, q.ballInCourtId));
    if (q.source) clauses.push(eq(rfis.source, q.source));
    if (q.search) clauses.push(ilike(rfis.subject, `%${q.search}%`));
    if (q.overdue === "true") {
      clauses.push(eq(rfis.status, "open"), isNotNull(rfis.dueDate), lt(rfis.dueDate, todayISO()));
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(rfis).where(where);
    const items = await app.db
      .select()
      .from(rfis)
      .where(where)
      .orderBy(desc(rfis.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const today = todayISO();
    return paginate(
      items.map((r) => ({
        ...r,
        daysOverdue: r.status === "open" ? daysOverdue(r.dueDate, today) : 0,
        ageDays: r.status === "open" ? ageInDays(r.issuedAt ?? r.createdAt, today) : null,
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  /* ---------------------------------------------------------------- */
  /* Analytics — #321 ball in court, #322 ageing & cycle time          */
  /* ---------------------------------------------------------------- */

  /**
   * Analytics and ageing are register-wide reads, so they honour the same
   * private-draft visibility as the list: a subcontractor drafting privately
   * must not have the subject line surfaced in someone else's backlog report.
   */
  async function analyticsScope(req: FastifyRequest): Promise<SQL> {
    const clauses: SQL[] = [eq(rfis.companyId, req.companyId!), eq(rfis.projectId, req.projectId!)];
    if (!(await isRfiAdmin(req))) clauses.push(visibilityClause(req.user!.id));
    return and(...clauses)!;
  }

  app.get("/projects/:projectId/rfis/analytics", { preHandler: readGate }, async (req) => {
    const scope = await analyticsScope(req);
    const byStatusRows = await app.db
      .select({ status: rfis.status, n: count() })
      .from(rfis)
      .where(scope)
      .groupBy(rfis.status);
    const byStatus: Record<string, number> = {};
    for (const r of byStatusRows) byStatus[r.status] = Number(r.n);
    const today = todayISO();
    const rows = await app.db
      .select({
        id: rfis.id,
        status: rfis.status,
        issuedAt: rfis.issuedAt,
        createdAt: rfis.createdAt,
        respondedAt: rfis.respondedAt,
        dueDate: rfis.dueDate,
        ballInCourtId: rfis.ballInCourtId,
        assigneeId: rfis.assigneeId,
        updatedAt: rfis.updatedAt,
        costImpact: rfis.costImpact,
        scheduleImpact: rfis.scheduleImpact,
      })
      .from(rfis)
      .where(scope)
      .limit(5000);
    const openRows = rows.filter((r) => r.status === "open");
    const cycle = cycleTimeStats(rows);
    const ageing = bucketise(
      openRows,
      (r) => ageInDays(r.issuedAt ?? r.createdAt, today),
      (r) => r.ballInCourtId ?? "unassigned",
    );
    return {
      open: byStatus["open"] ?? 0,
      overdue: openRows.filter((r) => daysOverdue(r.dueDate, today) > 0).length,
      avgResponseDays: cycle.avgResponseDays,
      medianResponseDays: cycle.medianResponseDays,
      cycleTimeBasis: cycle.basis,
      answeredCount: cycle.n,
      byStatus,
      ballInCourt: ballInCourtSummary(rows, today),
      ageing,
      impacts: {
        costYes: rows.filter((r) => r.costImpact === "yes").length,
        scheduleYes: rows.filter((r) => r.scheduleImpact === "yes").length,
        tbd: rows.filter((r) => r.costImpact === "tbd" || r.scheduleImpact === "tbd").length,
      },
    };
  });

  app.get("/projects/:projectId/rfis/ageing", { preHandler: readGate }, async (req) => {
    const q = ageingQuery.parse(req.query);
    const today = todayISO();
    const rows = await app.db
      .select({
        id: rfis.id,
        number: rfis.number,
        subject: rfis.subject,
        issuedAt: rfis.issuedAt,
        createdAt: rfis.createdAt,
        dueDate: rfis.dueDate,
        assigneeId: rfis.assigneeId,
        ballInCourtId: rfis.ballInCourtId,
      })
      .from(rfis)
      .where(and(await analyticsScope(req), eq(rfis.status, "open")))
      .orderBy(asc(rfis.number))
      .limit(5000);
    const ageOf = (r: (typeof rows)[number]) => ageInDays(r.issuedAt ?? r.createdAt, today);
    const groupOf = (r: (typeof rows)[number]) =>
      (q.groupBy === "assignee" ? r.assigneeId : r.ballInCourtId) ?? "unassigned";
    return {
      groupBy: q.groupBy,
      asOf: today,
      ...bucketise(rows, ageOf, groupOf),
      items: rows.map((r) => ({
        id: r.id,
        number: r.number,
        subject: r.subject,
        ageDays: ageOf(r),
        daysOverdue: daysOverdue(r.dueDate, today),
        group: groupOf(r),
      })),
    };
  });

  /* ---------------------------------------------------------------- */
  /* Inbound email → RFI (#324)                                        */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/rfis/inbound", { preHandler: standardGate }, async (req, reply) => {
    const body = inboundSchema.parse(req.body);
    const parsed = parseInboundRfiEmail(body.email);
    // Resolve the sender to a company member when the address matches.
    const senderRows = await app.db
      .select({ id: users.id })
      .from(users)
      .innerJoin(companyMemberships, eq(companyMemberships.userId, users.id))
      .where(and(eq(companyMemberships.companyId, req.companyId!), eq(users.email, parsed.senderEmail)))
      .limit(1);
    const senderUserId = senderRows[0]?.id ?? null;
    const sourceMeta = {
      from: body.email.from,
      senderUserId,
      messageId: body.email.messageId ?? null,
      receivedAt: body.email.receivedAt ?? nowIso(),
      ingestedBy: req.user!.id,
    };

    if (parsed.replyToNumber !== null) {
      const target = (
        await app.db
          .select()
          .from(rfis)
          .where(and(eq(rfis.companyId, req.companyId!), eq(rfis.projectId, req.projectId!), eq(rfis.number, parsed.replyToNumber)))
          .limit(1)
      )[0];
      if (target && target.status === "open") {
        const responseId = newId("rfr");
        await app.db.insert(rfiResponses).values({
          id: responseId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          rfiId: target.id,
          body: parsed.question,
          status: "draft",
          authorId: senderUserId ?? req.user!.id,
        });
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "create",
          objectType: "rfi_response",
          objectId: responseId,
          payload: { rfiId: target.id, source: "email", sourceMeta },
          projectId: req.projectId!,
        });
        await pushNotifications(app.db, [
          {
            companyId: req.companyId!,
            userId: target.createdBy,
            projectId: req.projectId!,
            kind: "status_change",
            title: `${label(target.number)} received an emailed draft response`,
            body: `From ${body.email.from}. Review and adopt it as the official answer.`,
            recordType: "rfi",
            recordId: target.id,
          },
        ]);
        return reply.status(201).send({ action: "draft_response", rfiId: target.id, responseId });
      }
    }

    const number = await nextRecordNumber(app.db, req.projectId!, "rfi");
    const id = newId("rfi");
    await app.db.insert(rfis).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      number,
      subject: parsed.subject,
      question: parsed.question,
      status: "draft",
      fileIds: parsed.fileIds,
      source: "email",
      sourceMeta,
      createdBy: senderUserId ?? req.user!.id,
      visibleTo: senderUserId && senderUserId !== req.user!.id ? [req.user!.id] : [],
    });
    await ledgerRfi("create", id, req, { number, subject: parsed.subject, source: "email", sourceMeta });
    const created = (await app.db.select().from(rfis).where(eq(rfis.id, id)).limit(1))[0];
    return reply.status(201).send({ action: "created_rfi", rfiId: id, rfi: created });
  });

  /* ---------------------------------------------------------------- */
  /* Detail / edit                                                     */
  /* ---------------------------------------------------------------- */

  /** The record plus its draft responses, related RFIs and what THIS caller may do. */
  async function rfiDetail(rfiId: string, req: FastifyRequest) {
    const rfi = await fetchRfi(rfiId, req);
    const responses = await app.db
      .select()
      .from(rfiResponses)
      .where(eq(rfiResponses.rfiId, rfiId))
      .orderBy(asc(rfiResponses.createdAt));
    const related =
      rfi.relatedRfiIds.length > 0
        ? await app.db
            .select({ id: rfis.id, number: rfis.number, subject: rfis.subject, status: rfis.status })
            .from(rfis)
            .where(and(eq(rfis.projectId, req.projectId!), inArray(rfis.id, rfi.relatedRfiIds)))
        : [];
    const today = todayISO();
    const me = req.user!.id;
    const admin = await isRfiAdmin(req);
    return {
      ...rfi,
      responses,
      related,
      daysOverdue: rfi.status === "open" ? daysOverdue(rfi.dueDate, today) : 0,
      ageDays: ageInDays(rfi.issuedAt ?? rfi.createdAt, today),
      permissions: {
        canRespond: rfi.status === "open" && (admin || me === rfi.assigneeId || me === rfi.ballInCourtId),
        canAdopt: rfi.status === "open" && (admin || me === rfi.createdBy || me === rfi.assigneeId || me === rfi.ballInCourtId),
        canVoid: rfi.status !== "closed" && rfi.status !== "void" && (admin || me === rfi.createdBy),
        canEditQuestion: rfi.status === "draft",
      },
    };
  }

  app.get("/projects/:projectId/rfis/:rfiId", { preHandler: readGate }, async (req) => {
    const { rfiId } = req.params as { rfiId: string };
    return rfiDetail(rfiId, req);
  });

  app.patch("/projects/:projectId/rfis/:rfiId", { preHandler: standardGate }, async (req) => {
    const { rfiId } = req.params as { rfiId: string };
    const body = rfiPatchSchema.parse(req.body);
    const rfi = await fetchRfi(rfiId, req);
    if (rfi.status === "void" || rfi.status === "closed") {
      throw badRequest(`A ${rfi.status} RFI cannot be edited`);
    }
    if (rfi.status !== "draft") {
      const locked = LOCKED_AFTER_DRAFT.filter((k) => body[k] !== undefined && body[k] !== rfi[k]);
      if (locked.length > 0) {
        throw badRequest(
          `${locked.join(", ")} cannot change once the RFI is issued — void it and reissue a corrected RFI`,
        );
      }
    }
    await validateParties(req, body);
    const relatedRfiIds =
      body.relatedRfiIds !== undefined ? await validateRelated(req, body.relatedRfiIds, rfiId) : undefined;
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      if (k === "isPrivate") set["isPrivate"] = v ? 1 : 0;
      else if (k === "relatedRfiIds") set["relatedRfiIds"] = relatedRfiIds;
      else set[k] = v;
    }
    const changed = Object.keys(body).filter((k) => body[k as keyof typeof body] !== undefined);
    await app.db.update(rfis).set(set).where(eq(rfis.id, rfiId));
    await ledgerRfi(
      "update",
      rfiId,
      req,
      { changed, before: pick(rfi, changed), after: pick(set, changed) },
      true,
    );
    if (body.assigneeId && body.assigneeId !== rfi.assigneeId) {
      await pushNotifications(app.db, [
        {
          companyId: req.companyId!,
          userId: body.assigneeId,
          projectId: req.projectId!,
          kind: "assignment",
          title: `${label(rfi.number)} assigned to you: ${rfi.subject}`,
          recordType: "rfi",
          recordId: rfiId,
        },
      ]);
    }
    return rfiDetail(rfiId, req);
  });

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/rfis/:rfiId/issue", { preHandler: standardGate }, async (req) => {
    const { rfiId } = req.params as { rfiId: string };
    const rfi = await fetchRfi(rfiId, req);
    if (rfi.status !== "draft") throw badRequest("Only a draft RFI can be issued");
    const dueDate = rfi.dueDate ?? addDaysISO(todayISO(), 7);
    const now = nowIso();
    await app.db
      .update(rfis)
      .set({ status: "open", dueDate, issuedAt: now, isPrivate: 0, updatedAt: now })
      .where(eq(rfis.id, rfiId));
    await ledgerRfi("state_change", rfiId, req, { from: "draft", to: "open", dueDate, issuedAt: now });
    const targets = [];
    if (rfi.assigneeId) {
      targets.push({
        companyId: req.companyId!,
        userId: rfi.assigneeId,
        projectId: req.projectId!,
        kind: "assignment" as const,
        title: `${label(rfi.number)} issued to you: ${rfi.subject}`,
        body: `Response due ${dueDate}.`,
        recordType: "rfi",
        recordId: rfiId,
      });
    }
    for (const userId of rfi.distribution ?? []) {
      targets.push({
        companyId: req.companyId!,
        userId,
        projectId: req.projectId!,
        kind: "status_change" as const,
        title: `${label(rfi.number)} issued: ${rfi.subject}`,
        recordType: "rfi",
        recordId: rfiId,
      });
    }
    await pushNotifications(app.db, targets);
    return rfiDetail(rfiId, req);
  });

  async function recordOfficialResponse(
    req: FastifyRequest,
    rfi: typeof rfis.$inferSelect,
    answer: { text: string; costImpact?: string; scheduleImpact?: string; scheduleImpactDays?: number | null; authorId: string; adoptedFrom?: string },
  ) {
    const now = nowIso();
    await app.db
      .update(rfis)
      .set({
        status: "answered",
        officialResponse: answer.text,
        respondedBy: answer.authorId,
        respondedAt: now,
        costImpact: answer.costImpact ?? rfi.costImpact,
        scheduleImpact: answer.scheduleImpact ?? rfi.scheduleImpact,
        scheduleImpactDays:
          answer.scheduleImpactDays !== undefined ? answer.scheduleImpactDays : rfi.scheduleImpactDays,
        ballInCourtId: rfi.createdBy,
        responseRevision: rfi.responseRevision + 1,
        updatedAt: now,
      })
      .where(eq(rfis.id, rfi.id));
    await ledgerRfi("state_change", rfi.id, req, {
      from: "open",
      to: "answered",
      respondedBy: answer.authorId,
      adoptedFrom: answer.adoptedFrom ?? null,
    });
    const title = `${label(rfi.number)} answered: ${rfi.subject}`;
    await pushNotifications(app.db, [
      { companyId: req.companyId!, userId: rfi.createdBy, projectId: req.projectId!, kind: "status_change", title, recordType: "rfi", recordId: rfi.id },
      ...(rfi.distribution ?? []).map((userId) => ({
        companyId: req.companyId!,
        userId,
        projectId: req.projectId!,
        kind: "status_change" as const,
        title,
        recordType: "rfi",
        recordId: rfi.id,
      })),
    ]);
  }

  app.post("/projects/:projectId/rfis/:rfiId/respond", { preHandler: standardGate }, async (req) => {
    const { rfiId } = req.params as { rfiId: string };
    const body = respondSchema.parse(req.body);
    const rfi = await fetchRfi(rfiId, req);
    if (rfi.status !== "open") throw badRequest("Only an open RFI can be answered");
    const me = req.user!.id;
    if (me !== rfi.assigneeId && me !== rfi.ballInCourtId && !(await isRfiAdmin(req))) {
      throw forbidden(
        "Only the assignee or ball-in-court holder records the official response — submit a draft response instead",
      );
    }
    await recordOfficialResponse(req, rfi, {
      text: body.officialResponse,
      costImpact: body.costImpact,
      scheduleImpact: body.scheduleImpact,
      scheduleImpactDays: body.scheduleImpactDays,
      authorId: me,
    });
    return rfiDetail(rfiId, req);
  });

  /* ---------------------------------------------------------------- */
  /* Draft responses → adoption (#311)                                 */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/rfis/:rfiId/responses", { preHandler: readGate }, async (req) => {
    const { rfiId } = req.params as { rfiId: string };
    await fetchRfi(rfiId, req);
    const items = await app.db
      .select()
      .from(rfiResponses)
      .where(eq(rfiResponses.rfiId, rfiId))
      .orderBy(asc(rfiResponses.createdAt));
    return { items };
  });

  app.post("/projects/:projectId/rfis/:rfiId/responses", { preHandler: standardGate }, async (req, reply) => {
    const { rfiId } = req.params as { rfiId: string };
    const body = draftResponseSchema.parse(req.body);
    const rfi = await fetchRfi(rfiId, req);
    if (rfi.status !== "open") throw badRequest("Draft responses can only be added to an open RFI");
    const id = newId("rfr");
    await app.db.insert(rfiResponses).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      rfiId,
      body: body.body,
      costImpact: body.costImpact ?? null,
      scheduleImpact: body.scheduleImpact ?? null,
      scheduleImpactDays: body.scheduleImpactDays ?? null,
      status: "draft",
      authorId: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "rfi_response",
      objectId: id,
      payload: { rfiId },
      projectId: req.projectId!,
    });
    const notify = new Set<string>([rfi.createdBy]);
    if (rfi.ballInCourtId) notify.add(rfi.ballInCourtId);
    notify.delete(req.user!.id);
    await pushNotifications(
      app.db,
      [...notify].map((userId) => ({
        companyId: req.companyId!,
        userId,
        projectId: req.projectId!,
        kind: "status_change" as const,
        title: `${label(rfi.number)} has a new draft response`,
        recordType: "rfi",
        recordId: rfiId,
      })),
    );
    const created = (await app.db.select().from(rfiResponses).where(eq(rfiResponses.id, id)).limit(1))[0];
    return reply.status(201).send(created);
  });

  app.post(
    "/projects/:projectId/rfis/:rfiId/responses/:responseId/adopt",
    { preHandler: standardGate },
    async (req) => {
      const { rfiId, responseId } = req.params as { rfiId: string; responseId: string };
      const rfi = await fetchRfi(rfiId, req);
      if (rfi.status !== "open") throw badRequest("Only an open RFI can adopt a response");
      const me = req.user!.id;
      if (me !== rfi.createdBy && me !== rfi.assigneeId && me !== rfi.ballInCourtId && !(await isRfiAdmin(req))) {
        throw forbidden("Only the RFI creator, assignee, ball-in-court holder or an admin can adopt a response");
      }
      const draft = (
        await app.db
          .select()
          .from(rfiResponses)
          .where(and(eq(rfiResponses.id, responseId), eq(rfiResponses.rfiId, rfiId)))
          .limit(1)
      )[0];
      if (!draft) throw notFound("Draft response not found");
      if (draft.status !== "draft") throw badRequest(`This response is already ${draft.status}`);
      const now = nowIso();
      await app.db
        .update(rfiResponses)
        .set({ status: "adopted", adoptedBy: me, adoptedAt: now })
        .where(eq(rfiResponses.id, responseId));
      await app.db
        .update(rfiResponses)
        .set({ status: "discarded" })
        .where(and(eq(rfiResponses.rfiId, rfiId), eq(rfiResponses.status, "draft"), ne(rfiResponses.id, responseId)));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: me,
        action: "state_change",
        objectType: "rfi_response",
        objectId: responseId,
        payload: { rfiId, from: "draft", to: "adopted", authorId: draft.authorId },
        projectId: req.projectId!,
      });
      await recordOfficialResponse(req, rfi, {
        text: draft.body,
        costImpact: draft.costImpact ?? undefined,
        scheduleImpact: draft.scheduleImpact ?? undefined,
        scheduleImpactDays: draft.scheduleImpactDays,
        authorId: draft.authorId,
        adoptedFrom: responseId,
      });
      return rfiDetail(rfiId, req);
    },
  );

  app.post(
    "/projects/:projectId/rfis/:rfiId/responses/:responseId/discard",
    { preHandler: standardGate },
    async (req) => {
      const { rfiId, responseId } = req.params as { rfiId: string; responseId: string };
      const rfi = await fetchRfi(rfiId, req);
      const draft = (
        await app.db
          .select()
          .from(rfiResponses)
          .where(and(eq(rfiResponses.id, responseId), eq(rfiResponses.rfiId, rfiId)))
          .limit(1)
      )[0];
      if (!draft) throw notFound("Draft response not found");
      if (draft.status !== "draft") throw badRequest(`This response is already ${draft.status}`);
      const me = req.user!.id;
      if (me !== draft.authorId && me !== rfi.createdBy && !(await isRfiAdmin(req))) {
        throw forbidden("Only the author, the RFI creator or an admin can discard a draft response");
      }
      await app.db.update(rfiResponses).set({ status: "discarded" }).where(eq(rfiResponses.id, responseId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: me,
        action: "state_change",
        objectType: "rfi_response",
        objectId: responseId,
        payload: { rfiId, from: "draft", to: "discarded" },
        projectId: req.projectId!,
      });
      return { id: responseId, status: "discarded" };
    },
  );

  app.post("/projects/:projectId/rfis/:rfiId/close", { preHandler: standardGate }, async (req) => {
    const { rfiId } = req.params as { rfiId: string };
    const rfi = await fetchRfi(rfiId, req);
    if (rfi.status !== "open" && rfi.status !== "answered") {
      throw badRequest("Only an open or answered RFI can be closed");
    }
    await app.db.update(rfis).set({ status: "closed", updatedAt: nowIso() }).where(eq(rfis.id, rfiId));
    await ledgerRfi("state_change", rfiId, req, { from: rfi.status, to: "closed" });
    return rfiDetail(rfiId, req);
  });

  app.post("/projects/:projectId/rfis/:rfiId/void", { preHandler: standardGate }, async (req) => {
    const { rfiId } = req.params as { rfiId: string };
    const rfi = await fetchRfi(rfiId, req);
    if (rfi.status === "closed" || rfi.status === "void") {
      throw badRequest(`A ${rfi.status} RFI cannot be voided`);
    }
    if (req.user!.id !== rfi.createdBy && !(await isRfiAdmin(req))) {
      throw forbidden("Only the RFI creator or an admin can void an RFI");
    }
    await app.db
      .update(rfis)
      .set({ status: "void", updatedAt: nowIso() })
      .where(and(eq(rfis.id, rfiId), ne(rfis.status, "void")));
    await ledgerRfi("state_change", rfiId, req, { from: rfi.status, to: "void" });
    return rfiDetail(rfiId, req);
  });
};
