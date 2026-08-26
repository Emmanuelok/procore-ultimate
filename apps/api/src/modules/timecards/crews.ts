import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, gte, isNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { crewMembers, crews, timecards, workers } from "@constructos/db";
import { CREW_ROLES, CREW_STATUSES, SHIFTS } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { classifyHours } from "./hours.js";
import {
  actorOf,
  companyOf,
  crewConfig,
  crewConfigSchema,
  detailSchema,
  fetchCrew,
  idSchema,
  isoDateSchema,
  ledgerTimecards,
  nowIso,
  overtimeRuleOf,
  pad3,
  projectOf,
  requireCostCode,
  requireVendor,
  requireWorker,
  timecardGates,
  todayIso,
  type CrewRow,
} from "./shared.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const crewCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(10000).nullable().optional(),
  trade: z.string().max(200).nullable().optional(),
  foremanWorkerId: idSchema.nullable().optional(),
  supervisorUserId: idSchema.nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  defaultShift: z.enum(SHIFTS).optional(),
  standardHoursPerDay: z.number().min(0).max(24).nullable().optional(),
  /** hours per day beyond which overtime applies — the DAILY rule's threshold */
  overtimeThresholdHours: z.number().min(0).max(24).nullable().optional(),
  defaultCostCodeId: idSchema.nullable().optional(),
  defaultBudgetLineItemId: idSchema.nullable().optional(),
  locationId: idSchema.nullable().optional(),
  status: z.enum(CREW_STATUSES).optional(),
  headcountTarget: z.number().int().min(0).max(10000).nullable().optional(),
  activeFrom: isoDateSchema.nullable().optional(),
  activeTo: isoDateSchema.nullable().optional(),
  /** the pay rules that have no column of their own */
  config: crewConfigSchema.partial().optional(),
  detail: detailSchema.optional(),
});

const crewPatchSchema = crewCreateSchema.partial();

const crewListQuery = pageQuerySchema.extend({
  status: z.enum(CREW_STATUSES).optional(),
  vendorId: idSchema.optional(),
  trade: z.string().max(200).optional(),
  /** only crews whose active window contains this date */
  activeOn: isoDateSchema.optional(),
});

const memberCreateSchema = z.object({
  workerId: idSchema,
  roleInCrew: z.enum(CREW_ROLES).optional(),
  fromDate: isoDateSchema,
  toDate: isoDateSchema.nullable().optional(),
  defaultCostCodeId: idSchema.nullable().optional(),
  classification: z.string().max(200).nullable().optional(),
  hourlyRate: z.number().min(0).nullable().optional(),
  overtimeMultiplier: z.number().min(0).max(10).nullable().optional(),
  doubleTimeMultiplier: z.number().min(0).max(10).nullable().optional(),
  burdenRate: z.number().min(0).max(10).nullable().optional(),
  currency: z.string().length(3).optional(),
  detail: detailSchema.optional(),
});

const memberPatchSchema = memberCreateSchema.omit({ workerId: true, fromDate: true }).partial();

const memberListQuery = pageQuerySchema.extend({
  /** membership as it stood on this date — the historical question */
  onDate: isoDateSchema.optional(),
  includeEnded: z.enum(["true", "false"]).optional(),
  workerId: idSchema.optional(),
});

const endMemberSchema = z.object({
  toDate: isoDateSchema,
  reason: z.string().max(2000).nullable().optional(),
});

const membershipQuery = z.object({
  workerId: idSchema,
  onDate: isoDateSchema.optional(),
});

/* ------------------------------------------------------------------ */
/* Presentation                                                        */
/* ------------------------------------------------------------------ */

/**
 * A crew read always carries the overtime rule it runs, spelled out. The rule
 * decides what every hour costs, and burying it in a jsonb blob is how a
 * project discovers in month three that half its crews were costed under the
 * wrong agreement.
 */
export function crewView(crew: CrewRow) {
  const rule = overtimeRuleOf(crew);
  const probe = classifyHours({ workedHours: 10, rule });
  return {
    ...crew,
    config: crewConfig(crew),
    overtimeRule: rule,
    /** how the rule reads in words, or why it cannot classify anything yet */
    overtimeRuleExplanation:
      probe.rule?.explanation ??
      probe.reasons.join(" ") ??
      "This crew's overtime rule is not configured.",
    canClassifyHours: probe.value !== null,
  };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const crewRoutes: FastifyPluginAsync = async (app) => {
  const gates = timecardGates(app);

  /** Memberships of `workerId` whose [from, to] window overlaps [from, to]. */
  async function overlappingMemberships(
    projectId: string,
    workerId: string,
    fromDate: string,
    toDate: string | null,
    excludeMemberId?: string,
  ) {
    const clauses = [
      eq(crewMembers.projectId, projectId),
      eq(crewMembers.workerId, workerId),
      // existing.fromDate <= newTo (or newTo is open)
      toDate ? lte(crewMembers.fromDate, toDate) : sql`true`,
      // existing.toDate >= newFrom, or the existing membership is open-ended
      or(isNull(crewMembers.toDate), gte(crewMembers.toDate, fromDate)),
    ];
    if (excludeMemberId) clauses.push(ne(crewMembers.id, excludeMemberId));
    return app.db
      .select({
        id: crewMembers.id,
        crewId: crewMembers.crewId,
        fromDate: crewMembers.fromDate,
        toDate: crewMembers.toDate,
        crewReference: crews.reference,
        crewName: crews.name,
      })
      .from(crewMembers)
      .innerJoin(crews, eq(crews.id, crewMembers.crewId))
      .where(and(...clauses));
  }

  app.post("/projects/:projectId/crews", { preHandler: gates.standard }, async (req, reply) => {
    const body = crewCreateSchema.parse(req.body);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const actorId = actorOf(req);

    if (body.vendorId) await requireVendor(app.db, body.vendorId, companyId);
    if (body.foremanWorkerId) await requireWorker(app.db, body.foremanWorkerId, companyId, projectId);
    if (body.defaultCostCodeId) await requireCostCode(app.db, body.defaultCostCodeId, companyId);
    if (body.activeFrom && body.activeTo && body.activeTo < body.activeFrom) {
      throw badRequest("activeTo must not precede activeFrom");
    }
    const config = crewConfigSchema.parse(body.config ?? {});
    if (config.overtimeRule === "daily" && body.overtimeThresholdHours == null) {
      // Not a refusal: a crew may be set up before its agreement is known.
      // The refusal comes later, from classifyHours, at the point it matters.
    }

    const number = await nextRecordNumber(app.db, projectId, "crew");
    const id = newId("crw");
    const reference = `CRW-${pad3(number)}`;
    await app.db.insert(crews).values({
      id,
      companyId,
      projectId,
      number,
      reference,
      name: body.name,
      description: body.description ?? null,
      trade: body.trade ?? null,
      foremanWorkerId: body.foremanWorkerId ?? null,
      supervisorUserId: body.supervisorUserId ?? null,
      vendorId: body.vendorId ?? null,
      defaultShift: body.defaultShift ?? "day",
      standardHoursPerDay: body.standardHoursPerDay ?? null,
      overtimeThresholdHours: body.overtimeThresholdHours ?? null,
      defaultCostCodeId: body.defaultCostCodeId ?? null,
      defaultBudgetLineItemId: body.defaultBudgetLineItemId ?? null,
      locationId: body.locationId ?? null,
      status: body.status ?? "active",
      headcountTarget: body.headcountTarget ?? null,
      currentHeadcount: 0,
      activeFrom: body.activeFrom ?? null,
      activeTo: body.activeTo ?? null,
      detail: { ...(body.detail ?? {}), ...config },
      createdBy: actorId,
    });
    await ledgerTimecards(app.db, req, "create", "crew", id, {
      reference,
      name: body.name,
      vendorId: body.vendorId ?? null,
      overtimeRule: config.overtimeRule,
      overtimeThresholdHours: body.overtimeThresholdHours ?? null,
    });
    return reply.status(201).send(crewView(await fetchCrew(app.db, id, companyId, projectId)));
  });

  app.get("/projects/:projectId/crews", { preHandler: gates.read }, async (req) => {
    const q = crewListQuery.parse(req.query);
    const clauses = [eq(crews.companyId, companyOf(req)), eq(crews.projectId, projectOf(req))];
    if (q.status) clauses.push(eq(crews.status, q.status));
    if (q.vendorId) clauses.push(eq(crews.vendorId, q.vendorId));
    if (q.trade) clauses.push(eq(crews.trade, q.trade));
    if (q.activeOn) {
      clauses.push(or(isNull(crews.activeFrom), lte(crews.activeFrom, q.activeOn))!);
      clauses.push(or(isNull(crews.activeTo), gte(crews.activeTo, q.activeOn))!);
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(crews).where(where);
    const rows = await app.db
      .select()
      .from(crews)
      .where(where)
      .orderBy(asc(crews.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows.map(crewView), Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/crews/:crewId", { preHandler: gates.read }, async (req) => {
    const { crewId } = req.params as { crewId: string };
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const crew = await fetchCrew(app.db, crewId, companyId, projectId);
    const onDate = (req.query as { onDate?: string }).onDate ?? todayIso();
    const members = await app.db
      .select({
        member: crewMembers,
        workerReference: workers.reference,
        workerName: workers.fullName,
        workerStatus: workers.status,
      })
      .from(crewMembers)
      .innerJoin(workers, eq(workers.id, crewMembers.workerId))
      .where(eq(crewMembers.crewId, crewId))
      .orderBy(asc(crewMembers.fromDate));
    const onDateMembers = members.filter(
      (m) => m.member.fromDate <= onDate && (m.member.toDate === null || m.member.toDate >= onDate),
    );
    const [cardCount] = await app.db
      .select({ n: count() })
      .from(timecards)
      .where(eq(timecards.crewId, crewId));
    return {
      ...crewView(crew),
      /** membership as it stood on `onDate` — the historical question */
      asOf: onDate,
      members: onDateMembers.map((m) => ({
        ...m.member,
        workerReference: m.workerReference,
        workerName: m.workerName,
        workerStatus: m.workerStatus,
      })),
      memberHistory: members.map((m) => ({
        ...m.member,
        workerReference: m.workerReference,
        workerName: m.workerName,
      })),
      headcountOnDate: onDateMembers.length,
      timecardCount: Number(cardCount?.n ?? 0),
    };
  });

  app.patch("/projects/:projectId/crews/:crewId", { preHandler: gates.standard }, async (req) => {
    const { crewId } = req.params as { crewId: string };
    const body = crewPatchSchema.parse(req.body);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const crew = await fetchCrew(app.db, crewId, companyId, projectId);
    if (body.vendorId) await requireVendor(app.db, body.vendorId, companyId);
    if (body.foremanWorkerId) await requireWorker(app.db, body.foremanWorkerId, companyId, projectId);
    if (body.defaultCostCodeId) await requireCostCode(app.db, body.defaultCostCodeId, companyId);

    const set: Record<string, unknown> = { updatedAt: nowIso() };
    const direct = [
      "name",
      "description",
      "trade",
      "foremanWorkerId",
      "supervisorUserId",
      "vendorId",
      "defaultShift",
      "standardHoursPerDay",
      "overtimeThresholdHours",
      "defaultCostCodeId",
      "defaultBudgetLineItemId",
      "locationId",
      "status",
      "headcountTarget",
      "activeFrom",
      "activeTo",
    ] as const;
    for (const key of direct) if (body[key] !== undefined) set[key] = body[key];
    if (body.config || body.detail) {
      const current = crewConfig(crew);
      const merged = crewConfigSchema.parse({ ...current, ...(body.config ?? {}) });
      set["detail"] = {
        ...(crew.detail ?? {}),
        ...(body.detail ?? {}),
        ...merged,
      };
    }
    await app.db.update(crews).set(set).where(eq(crews.id, crewId));
    await ledgerTimecards(app.db, req, "update", "crew", crewId, {
      reference: crew.reference,
      changed: Object.keys(body),
    });
    return crewView(await fetchCrew(app.db, crewId, companyId, projectId));
  });

  /* ---------------------------------------------------------------- */
  /* Dated membership                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Membership is DATED, never a flag. "Who was in this crew on the day of
   * the incident" has to stay answerable after the crew has been re-formed
   * four times, and a boolean cannot answer it.
   */
  app.post(
    "/projects/:projectId/crews/:crewId/members",
    { preHandler: gates.standard },
    async (req, reply) => {
      const { crewId } = req.params as { crewId: string };
      const body = memberCreateSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const crew = await fetchCrew(app.db, crewId, companyId, projectId);
      const worker = await requireWorker(app.db, body.workerId, companyId, projectId);
      if (body.toDate && body.toDate < body.fromDate) {
        throw badRequest("toDate must not precede fromDate");
      }
      if (body.defaultCostCodeId) await requireCostCode(app.db, body.defaultCostCodeId, companyId);

      // One worker, one crew, one day. Two overlapping memberships would make
      // "which crew's rules cost this worker's Tuesday" unanswerable.
      const clashes = await overlappingMemberships(
        projectId,
        body.workerId,
        body.fromDate,
        body.toDate ?? null,
      );
      if (clashes[0]) {
        const c = clashes[0];
        throw conflict(
          `${worker.reference} (${worker.fullName}) is already a member of crew ${c.crewReference} ` +
            `(${c.crewName}) from ${c.fromDate}${c.toDate ? ` to ${c.toDate}` : " with no end date"}, ` +
            `which overlaps ${body.fromDate}${body.toDate ? `–${body.toDate}` : " onwards"}. End that ` +
            "membership first — a worker's hours must be attributable to one crew on any given day.",
        );
      }

      const id = newId("crm");
      await app.db.insert(crewMembers).values({
        id,
        companyId,
        projectId,
        crewId,
        workerId: body.workerId,
        roleInCrew: body.roleInCrew ?? "operative",
        fromDate: body.fromDate,
        toDate: body.toDate ?? null,
        isActive: body.toDate && body.toDate < todayIso() ? 0 : 1,
        defaultCostCodeId: body.defaultCostCodeId ?? null,
        classification: body.classification ?? null,
        hourlyRate: body.hourlyRate ?? null,
        overtimeMultiplier: body.overtimeMultiplier ?? null,
        doubleTimeMultiplier: body.doubleTimeMultiplier ?? null,
        burdenRate: body.burdenRate ?? null,
        currency: body.currency ?? worker.currency ?? "USD",
        detail: body.detail ?? {},
        createdBy: actorOf(req),
      });
      await recomputeHeadcount(crewId);
      await ledgerTimecards(app.db, req, "create", "crew_member", id, {
        crewId,
        crewReference: crew.reference,
        workerId: body.workerId,
        workerReference: worker.reference,
        fromDate: body.fromDate,
        toDate: body.toDate ?? null,
        roleInCrew: body.roleInCrew ?? "operative",
      });
      const [created] = await app.db.select().from(crewMembers).where(eq(crewMembers.id, id));
      return reply
        .status(201)
        .send({ ...created, workerReference: worker.reference, workerName: worker.fullName });
    },
  );

  app.get(
    "/projects/:projectId/crews/:crewId/members",
    { preHandler: gates.read },
    async (req) => {
      const { crewId } = req.params as { crewId: string };
      const q = memberListQuery.parse(req.query);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      await fetchCrew(app.db, crewId, companyId, projectId);
      const clauses = [eq(crewMembers.crewId, crewId)];
      if (q.workerId) clauses.push(eq(crewMembers.workerId, q.workerId));
      if (q.onDate) {
        clauses.push(lte(crewMembers.fromDate, q.onDate));
        clauses.push(or(isNull(crewMembers.toDate), gte(crewMembers.toDate, q.onDate))!);
      } else if (q.includeEnded !== "true") {
        const today = todayIso();
        clauses.push(or(isNull(crewMembers.toDate), gte(crewMembers.toDate, today))!);
      }
      const where = and(...clauses);
      const [totalRow] = await app.db.select({ n: count() }).from(crewMembers).where(where);
      const rows = await app.db
        .select({
          member: crewMembers,
          workerReference: workers.reference,
          workerName: workers.fullName,
          workerStatus: workers.status,
          vendorId: workers.vendorId,
        })
        .from(crewMembers)
        .innerJoin(workers, eq(workers.id, crewMembers.workerId))
        .where(where)
        .orderBy(asc(crewMembers.fromDate), asc(workers.reference))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(
        rows.map((r) => ({
          ...r.member,
          workerReference: r.workerReference,
          workerName: r.workerName,
          workerStatus: r.workerStatus,
          workerVendorId: r.vendorId,
        })),
        Number(totalRow?.n ?? 0),
        q,
      );
    },
  );

  app.patch(
    "/projects/:projectId/crews/:crewId/members/:memberId",
    { preHandler: gates.standard },
    async (req) => {
      const { crewId, memberId } = req.params as { crewId: string; memberId: string };
      const body = memberPatchSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      await fetchCrew(app.db, crewId, companyId, projectId);
      const [member] = await app.db
        .select()
        .from(crewMembers)
        .where(and(eq(crewMembers.id, memberId), eq(crewMembers.crewId, crewId)))
        .limit(1);
      if (!member) throw notFound("Crew membership not found on this crew");
      if (body.toDate !== undefined && body.toDate !== null && body.toDate < member.fromDate) {
        throw badRequest(`toDate ${body.toDate} precedes this membership's fromDate ${member.fromDate}`);
      }
      if (body.toDate !== undefined) {
        const clashes = await overlappingMemberships(
          projectId,
          member.workerId,
          member.fromDate,
          body.toDate,
          memberId,
        );
        if (clashes[0]) {
          throw conflict(
            `Extending this membership to ${body.toDate ?? "open-ended"} overlaps crew ` +
              `${clashes[0].crewReference} (${clashes[0].fromDate}–${clashes[0].toDate ?? "open"}).`,
          );
        }
      }
      if (body.defaultCostCodeId) await requireCostCode(app.db, body.defaultCostCodeId, companyId);
      const set: Record<string, unknown> = { updatedAt: nowIso() };
      const direct = [
        "roleInCrew",
        "toDate",
        "defaultCostCodeId",
        "classification",
        "hourlyRate",
        "overtimeMultiplier",
        "doubleTimeMultiplier",
        "burdenRate",
        "currency",
      ] as const;
      for (const key of direct) if (body[key] !== undefined) set[key] = body[key];
      if (body.detail !== undefined) set["detail"] = { ...(member.detail ?? {}), ...body.detail };
      if (body.toDate !== undefined) {
        set["isActive"] = body.toDate && body.toDate < todayIso() ? 0 : 1;
      }
      await app.db.update(crewMembers).set(set).where(eq(crewMembers.id, memberId));
      await recomputeHeadcount(crewId);
      await ledgerTimecards(app.db, req, "update", "crew_member", memberId, {
        crewId,
        changed: Object.keys(body),
      });
      const [updated] = await app.db.select().from(crewMembers).where(eq(crewMembers.id, memberId));
      return updated;
    },
  );

  /**
   * End a membership on a date. The row is never deleted: the crew a worker
   * belonged to last March is a fact somebody will need when an incident
   * report, a claim or a prosecution asks for it.
   */
  app.post(
    "/projects/:projectId/crews/:crewId/members/:memberId/end",
    { preHandler: gates.standard },
    async (req) => {
      const { crewId, memberId } = req.params as { crewId: string; memberId: string };
      const body = endMemberSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      await fetchCrew(app.db, crewId, companyId, projectId);
      const [member] = await app.db
        .select()
        .from(crewMembers)
        .where(and(eq(crewMembers.id, memberId), eq(crewMembers.crewId, crewId)))
        .limit(1);
      if (!member) throw notFound("Crew membership not found on this crew");
      if (body.toDate < member.fromDate) {
        throw badRequest(
          `toDate ${body.toDate} precedes this membership's fromDate ${member.fromDate}.`,
        );
      }
      await app.db
        .update(crewMembers)
        .set({
          toDate: body.toDate,
          isActive: body.toDate < todayIso() ? 0 : 1,
          detail: { ...(member.detail ?? {}), endedReason: body.reason ?? null },
          updatedAt: nowIso(),
        })
        .where(eq(crewMembers.id, memberId));
      await recomputeHeadcount(crewId);
      await ledgerTimecards(app.db, req, "state_change", "crew_member", memberId, {
        crewId,
        workerId: member.workerId,
        from: member.toDate,
        to: body.toDate,
        reason: body.reason ?? null,
      });
      const [updated] = await app.db.select().from(crewMembers).where(eq(crewMembers.id, memberId));
      return updated;
    },
  );

  /**
   * Which crew was this worker in on this date? The question the dated
   * membership model exists to answer, given its own route so a safety
   * investigation does not have to reconstruct it from a list.
   */
  app.get("/projects/:projectId/crew-membership", { preHandler: gates.read }, async (req) => {
    const q = membershipQuery.parse(req.query);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const worker = await requireWorker(app.db, q.workerId, companyId, projectId);
    const onDate = q.onDate ?? todayIso();
    const rows = await app.db
      .select({ member: crewMembers, crew: crews })
      .from(crewMembers)
      .innerJoin(crews, eq(crews.id, crewMembers.crewId))
      .where(
        and(
          eq(crewMembers.projectId, projectId),
          eq(crewMembers.workerId, q.workerId),
          lte(crewMembers.fromDate, onDate),
          or(isNull(crewMembers.toDate), gte(crewMembers.toDate, onDate))!,
        ),
      )
      .orderBy(desc(crewMembers.fromDate))
      .limit(1);
    const history = await app.db
      .select({ member: crewMembers, crewReference: crews.reference, crewName: crews.name })
      .from(crewMembers)
      .innerJoin(crews, eq(crews.id, crewMembers.crewId))
      .where(and(eq(crewMembers.projectId, projectId), eq(crewMembers.workerId, q.workerId)))
      .orderBy(asc(crewMembers.fromDate));
    const hit = rows[0];
    return {
      workerId: q.workerId,
      workerReference: worker.reference,
      workerName: worker.fullName,
      onDate,
      /** null with a reason rather than a guess when nothing covers the date */
      crew: hit ? crewView(hit.crew) : null,
      membership: hit?.member ?? null,
      reasons: hit
        ? []
        : [
            `No crew membership covers ${worker.reference} on ${onDate}. The worker is on the ` +
              "register but was not attributed to a crew that day, so no crew pay rule applies.",
          ],
      history: history.map((h) => ({
        ...h.member,
        crewReference: h.crewReference,
        crewName: h.crewName,
      })),
    };
  });

  /** Headcount is derived from today's live memberships, never incremented. */
  async function recomputeHeadcount(crewId: string): Promise<void> {
    const today = todayIso();
    const [row] = await app.db
      .select({ n: count() })
      .from(crewMembers)
      .where(
        and(
          eq(crewMembers.crewId, crewId),
          lte(crewMembers.fromDate, today),
          or(isNull(crewMembers.toDate), gte(crewMembers.toDate, today))!,
        ),
      );
    await app.db
      .update(crews)
      .set({ currentHeadcount: Number(row?.n ?? 0), updatedAt: nowIso() })
      .where(eq(crews.id, crewId));
  }
};
