import type { FastifyInstance } from "fastify";
import { and, asc, count, desc, eq, inArray, isNotNull, lt, notInArray } from "drizzle-orm";
import { z } from "zod";
import {
  affectedPersons,
  companyMemberships,
  grievances,
  locations,
  obligations,
} from "@constructos/db";
import {
  GRIEVANCE_CHANNELS,
  GRIEVANCE_SEVERITIES,
  GRIEVANCE_STATUSES,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { addDaysISO, isoDateSchema, todayISO } from "../field/dates.js";
import {
  GRIEVANCE_CATEGORIES,
  GRIEVANCE_SETTLED_STATUSES,
  GRIEVANCE_SLA,
} from "./reference.js";
import { GRIEVANCE_TIER_LABELS, MAX_GRIEVANCE_TIER } from "./grievance-engine.js";
import {
  daysFromDateToInstant,
  daysUntil,
  median,
  round1,
  shareOf,
  tallyBy,
  validateLocation,
  zeroFilled,
} from "./shared.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const grievanceCreateSchema = z.object({
  channel: z.enum(GRIEVANCE_CHANNELS),
  isAnonymous: z.boolean().optional(),
  complainantName: z.string().max(300).nullable().optional(),
  complainantContact: z.string().max(300).nullable().optional(),
  papId: z.string().min(1).nullable().optional(),
  category: z.enum(GRIEVANCE_CATEGORIES),
  severity: z.enum(GRIEVANCE_SEVERITIES),
  description: z.string().min(1).max(20000),
  locationId: z.string().min(1).nullable().optional(),
  receivedAt: isoDateSchema,
});

const grievanceListQuery = pageQuerySchema.extend({
  status: z.enum(GRIEVANCE_STATUSES).optional(),
  severity: z.enum(GRIEVANCE_SEVERITIES).optional(),
  category: z.enum(GRIEVANCE_CATEGORIES).optional(),
  overdue: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

const assignSchema = z.object({ assigneeId: z.string().min(1) });
const resolveSchema = z.object({ resolution: z.string().min(1).max(20000) });
const verifySchema = z.object({
  complainantSatisfied: z.boolean(),
  note: z.string().max(20000).nullable().optional(),
});
const escalateSchema = z.object({
  reason: z.string().min(1).max(20000),
  /** where on the published ladder this goes; defaults to one tier up */
  toTier: z.number().int().min(1).max(3).optional(),
  assigneeId: z.string().min(1).nullable().optional(),
});
const rejectSchema = z.object({
  reason: z.string().min(1).max(20000),
  /** a withdrawal by the complainant is recorded distinctly from a refusal */
  outcome: z.enum(["rejected", "withdrawn"]).optional(),
  complainantNotified: z.boolean().optional(),
});
const acknowledgeSchema = z.object({ note: z.string().max(10000).nullable().optional() });

const SETTLED: readonly string[] = GRIEVANCE_SETTLED_STATUSES;

/**
 * Community grievance redress mechanism — spec Domain J #569-574. Intake by
 * every channel including anonymous, severity-driven SLA materialized as an
 * assurance Obligation, escalation, closure verified WITH the complainant,
 * a lazy breach sweep and the analytics a lender's E&S supervision asks for.
 */
export async function registerGrievanceRoutes(app: FastifyInstance): Promise<void> {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("land", "read")];
  const standardGate = [app.authenticate, app.requireCompany, app.requireTool("land", "standard")];

  async function fetchGrievance(grievanceId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(grievances)
      .where(
        and(
          eq(grievances.id, grievanceId),
          eq(grievances.companyId, companyId),
          eq(grievances.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Grievance not found");
    return rows[0];
  }

  /** View-model fields the register and the detail view both need. */
  function decorate(g: typeof grievances.$inferSelect) {
    const settled = SETTLED.includes(g.status);
    const overdue = !settled && g.resolveDueAt != null && g.resolveDueAt < todayISO();
    return {
      ...g,
      isAnonymous: g.isAnonymous === 1,
      complainantSatisfied:
        g.complainantSatisfied == null ? null : g.complainantSatisfied === 1,
      sla: GRIEVANCE_SLA[g.severity as keyof typeof GRIEVANCE_SLA] ?? null,
      daysToResolve:
        g.resolvedAt != null ? round1(daysFromDateToInstant(g.receivedAt, g.resolvedAt)) : null,
      daysToAcknowledge:
        g.acknowledgedAt != null
          ? round1(daysFromDateToInstant(g.receivedAt, g.acknowledgedAt))
          : null,
      overdue,
      daysOverdue: overdue && g.resolveDueAt ? Math.abs(daysUntil(g.resolveDueAt)) : 0,
      daysUntilDue: !settled && g.resolveDueAt ? daysUntil(g.resolveDueAt) : null,
      escalationTierLabel: GRIEVANCE_TIER_LABELS[g.escalationTier] ?? null,
      settled,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Intake (#569-571)                                                 */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/grievances", { preHandler: standardGate }, async (req, reply) => {
    const body = grievanceCreateSchema.parse(req.body);
    // The anonymous channel is anonymous whatever the caller ticked, and an
    // anonymous grievance NEVER carries identifying data — not on the record
    // and not in the ledger payload. Stripping at intake is the only place
    // this can be guaranteed.
    const anonymous = body.isAnonymous === true || body.channel === "anonymous";
    const complainantName = anonymous ? null : (body.complainantName ?? null);
    const complainantContact = anonymous ? null : (body.complainantContact ?? null);
    if (body.papId) {
      const rows = await app.db
        .select({ id: affectedPersons.id })
        .from(affectedPersons)
        .where(
          and(
            eq(affectedPersons.id, body.papId),
            eq(affectedPersons.companyId, req.companyId!),
            eq(affectedPersons.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!rows[0]) throw badRequest("papId does not belong to this project");
    }
    if (body.locationId) {
      await validateLocation(app.db, req.companyId!, req.projectId!, body.locationId);
    }

    const rule = GRIEVANCE_SLA[body.severity];
    const acknowledgeDueAt = addDaysISO(body.receivedAt, rule.acknowledgeDays);
    const resolveDueAt = addDaysISO(body.receivedAt, rule.resolveDays);

    /*
     * Obligation, number, record and ledger are one act. The obligation used
     * to be inserted first, outside any transaction: a failure in between
     * (a numbering race, a DB error) left an orphan open obligation carrying
     * a GRM deadline that the assurance sweep would later breach against a
     * grievance nobody could find.
     */
    const id = newId("grv");
    const { number, obligationId } = await app.db.transaction(async (tx) => {
      const number = await nextRecordNumber(tx, req.projectId!, "grievance");
      // The resolution deadline materializes as an assurance Obligation so
      // the GRM clock and the obligation register see the same date (#572).
      const obligationId = newId("obl");
      await tx.insert(obligations).values({
        id: obligationId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        sourceClause: `Grievance redress mechanism — GRV-${number}`,
        trigger:
          `Grievance GRV-${number} (${body.category}, severity ${body.severity}) received ` +
          `${body.receivedAt} via ${body.channel}`,
        deadline: `${resolveDueAt}T23:59:59Z`,
        warnDaysBefore: 2,
        evidenceRequirement:
          "Resolution recorded and closure verified with the complainant (#573)",
        status: "open",
        createdBy: req.user!.id,
      });
      await tx.insert(grievances).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        channel: body.channel,
        isAnonymous: anonymous ? 1 : 0,
        complainantName,
        complainantContact,
        papId: body.papId ?? null,
        category: body.category,
        severity: body.severity,
        description: body.description,
        locationId: body.locationId ?? null,
        receivedAt: body.receivedAt,
        acknowledgeDueAt,
        resolveDueAt,
        status: "received",
        obligationId,
        createdBy: req.user!.id,
      });
      return { number, obligationId };
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "grievance",
      objectId: id,
      payload: {
        number,
        channel: body.channel,
        isAnonymous: anonymous,
        category: body.category,
        severity: body.severity,
        receivedAt: body.receivedAt,
        acknowledgeDueAt,
        resolveDueAt,
        obligationId,
        papId: body.papId ?? null,
        locationId: body.locationId ?? null,
      },
      storePayload: true,
    });
    const created = await fetchGrievance(id, req.companyId!, req.projectId!);
    return reply.status(201).send(decorate(created));
  });

  app.get("/projects/:projectId/grievances", { preHandler: readGate }, async (req) => {
    const q = grievanceListQuery.parse(req.query);
    const clauses = [
      eq(grievances.companyId, req.companyId!),
      eq(grievances.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(grievances.status, q.status));
    if (q.severity) clauses.push(eq(grievances.severity, q.severity));
    if (q.category) clauses.push(eq(grievances.category, q.category));
    if (q.overdue === true) {
      clauses.push(notInArray(grievances.status, [...GRIEVANCE_SETTLED_STATUSES]));
      clauses.push(isNotNull(grievances.resolveDueAt));
      clauses.push(lt(grievances.resolveDueAt, todayISO()));
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(grievances).where(where);
    const rows = await app.db
      .select()
      .from(grievances)
      .where(where)
      .orderBy(desc(grievances.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows.map(decorate), Number(totalRow?.n ?? 0), q);
  });

  app.get(
    "/projects/:projectId/grievances/:grievanceId",
    { preHandler: readGate },
    async (req) => {
      const { grievanceId } = req.params as { grievanceId: string };
      const g = await fetchGrievance(grievanceId, req.companyId!, req.projectId!);
      const obligation = g.obligationId
        ? (
            await app.db
              .select()
              .from(obligations)
              .where(eq(obligations.id, g.obligationId))
              .limit(1)
          )[0]
        : null;
      const pap = g.papId
        ? (
            await app.db
              .select()
              .from(affectedPersons)
              .where(eq(affectedPersons.id, g.papId))
              .limit(1)
          )[0]
        : null;
      const location = g.locationId
        ? (await app.db.select().from(locations).where(eq(locations.id, g.locationId)).limit(1))[0]
        : null;
      return {
        ...decorate(g),
        obligation: obligation ?? null,
        affectedPerson: pap ?? null,
        location: location ?? null,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Handling ladder (#572-573)                                        */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/grievances/:grievanceId/acknowledge",
    { preHandler: standardGate },
    async (req) => {
      const { grievanceId } = req.params as { grievanceId: string };
      const body = acknowledgeSchema.parse(req.body ?? {});
      const g = await fetchGrievance(grievanceId, req.companyId!, req.projectId!);
      if (g.acknowledgedAt) throw badRequest("Grievance was already acknowledged");
      if (SETTLED.includes(g.status)) {
        throw badRequest(`A ${g.status} grievance cannot be acknowledged`);
      }
      const now = new Date().toISOString();
      await app.db
        .update(grievances)
        .set({
          acknowledgedAt: now,
          status: g.status === "received" ? "acknowledged" : g.status,
          updatedAt: now,
        })
        .where(eq(grievances.id, grievanceId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "grievance",
        objectId: grievanceId,
        payload: {
          event: "acknowledged",
          number: g.number,
          acknowledgedAt: now,
          acknowledgeDueAt: g.acknowledgeDueAt,
          onTime: g.acknowledgeDueAt ? now.slice(0, 10) <= g.acknowledgeDueAt : null,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      return decorate(await fetchGrievance(grievanceId, req.companyId!, req.projectId!));
    },
  );

  app.post(
    "/projects/:projectId/grievances/:grievanceId/assign",
    { preHandler: standardGate },
    async (req) => {
      const { grievanceId } = req.params as { grievanceId: string };
      const body = assignSchema.parse(req.body);
      const g = await fetchGrievance(grievanceId, req.companyId!, req.projectId!);
      if (SETTLED.includes(g.status)) {
        throw badRequest(`A ${g.status} grievance cannot be reassigned`);
      }
      const member = await app.db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, req.companyId!),
            eq(companyMemberships.userId, body.assigneeId),
          ),
        )
        .limit(1);
      if (!member[0]) throw badRequest("assigneeId is not a member of this company");
      const now = new Date().toISOString();
      await app.db
        .update(grievances)
        .set({
          assigneeId: body.assigneeId,
          status: g.status === "received" || g.status === "acknowledged" ? "investigating" : g.status,
          updatedAt: now,
        })
        .where(eq(grievances.id, grievanceId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "grievance",
        objectId: grievanceId,
        payload: {
          event: "assigned",
          number: g.number,
          from: g.assigneeId,
          to: body.assigneeId,
        },
        storePayload: true,
      });
      return decorate(await fetchGrievance(grievanceId, req.companyId!, req.projectId!));
    },
  );

  app.post(
    "/projects/:projectId/grievances/:grievanceId/resolve",
    { preHandler: standardGate },
    async (req) => {
      const { grievanceId } = req.params as { grievanceId: string };
      const body = resolveSchema.parse(req.body);
      const g = await fetchGrievance(grievanceId, req.companyId!, req.projectId!);
      if (SETTLED.includes(g.status)) throw badRequest(`Grievance is already ${g.status}`);
      const now = new Date().toISOString();
      await app.db
        .update(grievances)
        .set({ status: "resolved", resolution: body.resolution, resolvedAt: now, updatedAt: now })
        .where(eq(grievances.id, grievanceId));
      // The obligation is deliberately NOT satisfied here: a resolution the
      // complainant has not accepted is not a closed grievance (#573).
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "grievance",
        objectId: grievanceId,
        payload: {
          from: g.status,
          to: "resolved",
          number: g.number,
          resolution: body.resolution,
          resolvedAt: now,
          resolveDueAt: g.resolveDueAt,
          onTime: g.resolveDueAt ? now.slice(0, 10) <= g.resolveDueAt : null,
        },
        storePayload: true,
      });
      return decorate(await fetchGrievance(grievanceId, req.companyId!, req.projectId!));
    },
  );

  /**
   * Closure verification with the complainant (#573) — the rule that makes
   * a GRM real. Only a complainant who says the resolution worked closes the
   * grievance and satisfies its obligation; an unsatisfied complainant
   * reopens it into investigation, and the reopen is ledgered so the
   * "closed" statistics can never be laundered.
   */
  app.post(
    "/projects/:projectId/grievances/:grievanceId/verify-closure",
    { preHandler: standardGate },
    async (req) => {
      const { grievanceId } = req.params as { grievanceId: string };
      const body = verifySchema.parse(req.body);
      const g = await fetchGrievance(grievanceId, req.companyId!, req.projectId!);
      if (g.status !== "resolved") {
        throw badRequest(
          `Closure can only be verified on a resolved grievance (this one is ${g.status})`,
        );
      }
      const now = new Date().toISOString();
      if (body.complainantSatisfied) {
        await app.db
          .update(grievances)
          .set({
            status: "closed_verified",
            complainantSatisfied: 1,
            verifiedAt: now,
            verifiedBy: req.user!.id,
            updatedAt: now,
          })
          .where(eq(grievances.id, grievanceId));
        if (g.obligationId) {
          // A late closure does not rewrite the register: a breached
          // obligation stays breached, only an open one is satisfied.
          await app.db
            .update(obligations)
            .set({ status: "satisfied" })
            .where(and(eq(obligations.id, g.obligationId), eq(obligations.status, "open")));
        }
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "grievance",
          objectId: grievanceId,
          payload: {
            from: "resolved",
            to: "closed_verified",
            number: g.number,
            complainantSatisfied: true,
            verifiedAt: now,
            note: body.note ?? null,
          },
          storePayload: true,
        });
      } else {
        await app.db
          .update(grievances)
          .set({
            status: "investigating",
            complainantSatisfied: 0,
            verifiedAt: now,
            verifiedBy: req.user!.id,
            resolvedAt: null,
            updatedAt: now,
          })
          .where(eq(grievances.id, grievanceId));
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "grievance",
          objectId: grievanceId,
          payload: {
            event: "closure_rejected_reopened",
            from: "resolved",
            to: "investigating",
            number: g.number,
            complainantSatisfied: false,
            rejectedResolution: g.resolution,
            verifiedAt: now,
            note: body.note ?? null,
          },
          storePayload: true,
        });
      }
      return decorate(await fetchGrievance(grievanceId, req.companyId!, req.projectId!));
    },
  );

  /**
   * Reject a grievance (#571-573). `rejected` is in the status enum, in the
   * settled set, in the list filter and zero-filled in the analytics — but
   * before this route nothing could reach it. An out-of-scope or vexatious
   * grievance therefore had to be "resolved" with a fabricated resolution and
   * then "verified", which inflated both the SLA compliance rate and the
   * satisfaction rate, or left open to breach its SLA and pollute the
   * integrity feed. A rejection is a real, honest outcome of a functioning
   * mechanism — provided the reason is recorded and the complainant is told,
   * which is why the reason is mandatory and stored in the ledger payload.
   *
   * The obligation is WAIVED rather than satisfied: nothing was delivered to
   * the complainant, and recording it as satisfied would be a false claim in
   * the obligation register.
   */
  app.post(
    "/projects/:projectId/grievances/:grievanceId/reject",
    { preHandler: standardGate },
    async (req) => {
      const { grievanceId } = req.params as { grievanceId: string };
      const body = rejectSchema.parse(req.body);
      const g = await fetchGrievance(grievanceId, req.companyId!, req.projectId!);
      if (SETTLED.includes(g.status)) throw badRequest(`Grievance is already ${g.status}`);
      const now = new Date().toISOString();
      const resolution =
        `${body.outcome === "withdrawn" ? "Withdrawn by the complainant" : "Rejected"}: ${body.reason}`;
      await app.db
        .update(grievances)
        .set({
          status: "rejected",
          resolution,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(eq(grievances.id, grievanceId));
      if (g.obligationId) {
        await app.db
          .update(obligations)
          .set({ status: "waived" })
          .where(and(eq(obligations.id, g.obligationId), eq(obligations.status, "open")));
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "grievance",
        objectId: grievanceId,
        payload: {
          from: g.status,
          to: "rejected",
          outcome: body.outcome ?? "rejected",
          number: g.number,
          reason: body.reason,
          complainantNotified: body.complainantNotified ?? false,
          resolveDueAt: g.resolveDueAt,
        },
        storePayload: true,
      });
      return decorate(await fetchGrievance(grievanceId, req.companyId!, req.projectId!));
    },
  );

  app.post(
    "/projects/:projectId/grievances/:grievanceId/escalate",
    { preHandler: standardGate },
    async (req) => {
      const { grievanceId } = req.params as { grievanceId: string };
      const body = escalateSchema.parse(req.body);
      const g = await fetchGrievance(grievanceId, req.companyId!, req.projectId!);
      if (SETTLED.includes(g.status)) throw badRequest(`A ${g.status} grievance cannot be escalated`);
      const toTier = body.toTier ?? Math.min(MAX_GRIEVANCE_TIER, g.escalationTier + 1);
      if (toTier <= g.escalationTier) {
        throw badRequest(
          `Grievance is already at tier ${g.escalationTier} (${GRIEVANCE_TIER_LABELS[g.escalationTier]}). ` +
            `The ladder only climbs: de-escalating would erase the record that it was escalated.`,
        );
      }
      if (body.assigneeId) {
        const member = await app.db
          .select({ id: companyMemberships.id })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, req.companyId!),
              eq(companyMemberships.userId, body.assigneeId),
            ),
          )
          .limit(1);
        if (!member[0]) throw badRequest("assigneeId is not a member of this company");
      }
      const now = new Date().toISOString();
      const history = [
        ...(g.escalationHistory as unknown[]),
        {
          at: now,
          fromTier: g.escalationTier,
          toTier,
          reason: body.reason,
          breach: "manual",
          automatic: false,
          assigneeId: body.assigneeId ?? g.assigneeId,
        },
      ];
      await app.db
        .update(grievances)
        .set({
          status: "escalated",
          escalationTier: toTier,
          escalatedAt: now,
          escalationHistory: history,
          assigneeId: body.assigneeId ?? g.assigneeId,
          updatedAt: now,
        })
        .where(eq(grievances.id, grievanceId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "grievance",
        objectId: grievanceId,
        payload: {
          from: g.status,
          to: "escalated",
          number: g.number,
          fromTier: g.escalationTier,
          toTier,
          tierLabel: GRIEVANCE_TIER_LABELS[toTier],
          automatic: false,
          reason: body.reason,
          assigneeId: body.assigneeId ?? g.assigneeId,
          resolveDueAt: g.resolveDueAt,
        },
        storePayload: true,
      });
      return decorate(await fetchGrievance(grievanceId, req.companyId!, req.projectId!));
    },
  );

  /* ---------------------------------------------------------------- */
  /* Analytics (#574)                                                  */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/grievances/analytics", { preHandler: readGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(grievances)
      .where(
        and(eq(grievances.companyId, req.companyId!), eq(grievances.projectId, req.projectId!)),
      )
      .orderBy(asc(grievances.number));
    const today = todayISO();
    const total = rows.length;
    const resolvedDurations = rows
      .filter((g) => g.resolvedAt != null)
      .map((g) => round1(daysFromDateToInstant(g.receivedAt, g.resolvedAt!)));
    const ackDurations = rows
      .filter((g) => g.acknowledgedAt != null)
      .map((g) => round1(daysFromDateToInstant(g.receivedAt, g.acknowledgedAt!)));
    const verified = rows.filter((g) => g.complainantSatisfied != null);
    const satisfied = verified.filter((g) => g.complainantSatisfied === 1);
    const open = rows.filter((g) => !SETTLED.includes(g.status));
    const openOverdue = open.filter((g) => g.resolveDueAt != null && g.resolveDueAt < today);
    /*
     * SLA compliance measures the mechanism's promise to DELIVER a
     * resolution. A rejected (or withdrawn) grievance was never going to be
     * resolved, so counting it as a hit inflates the rate and counting it as
     * a miss punishes the officer for saying no honestly: it belongs in
     * neither the numerator nor the denominator.
     */
    const resolvedForSla = rows.filter((g) => g.resolvedAt != null && g.status !== "rejected");
    const withinSla = resolvedForSla.filter(
      (g) => g.resolveDueAt != null && g.resolvedAt!.slice(0, 10) <= g.resolveDueAt,
    );

    // location names for the "by location" cut of #574
    const locationIds = [...new Set(rows.map((g) => g.locationId).filter((v): v is string => !!v))];
    const locationRows = locationIds.length
      ? await app.db
          .select({ id: locations.id, name: locations.name })
          .from(locations)
          .where(inArray(locations.id, locationIds))
      : [];
    const locationName = new Map(locationRows.map((l) => [l.id, l.name]));

    return {
      total,
      open: open.length,
      byCategory: zeroFilled(GRIEVANCE_CATEGORIES, tallyBy(rows, (g) => g.category)),
      bySeverity: zeroFilled(GRIEVANCE_SEVERITIES, tallyBy(rows, (g) => g.severity)),
      byChannel: zeroFilled(GRIEVANCE_CHANNELS, tallyBy(rows, (g) => g.channel)),
      byStatus: zeroFilled(GRIEVANCE_STATUSES, tallyBy(rows, (g) => g.status)),
      byMonth: tallyBy(rows, (g) => g.receivedAt.slice(0, 7)),
      byLocation: tallyBy(rows, (g) =>
        g.locationId ? (locationName.get(g.locationId) ?? g.locationId) : "unassigned",
      ),
      anonymousCount: rows.filter((g) => g.isAnonymous === 1).length,
      /** 0..1 — a healthy GRM shows some anonymous intake; zero suggests the
       *  anonymous channel is not trusted or not published */
      anonymousShare: shareOf(rows.filter((g) => g.isAnonymous === 1).length, total),
      medianDaysToResolve: median(resolvedDurations),
      medianDaysToAcknowledge: median(ackDurations),
      openOverdue: openOverdue.length,
      slaComplianceRate: shareOf(withinSla.length, resolvedForSla.length),
      slaDenominator: resolvedForSla.length,
      rejected: rows.filter((g) => g.status === "rejected").length,
      byEscalationTier: {
        0: rows.filter((g) => g.escalationTier === 0).length,
        1: rows.filter((g) => g.escalationTier === 1).length,
        2: rows.filter((g) => g.escalationTier === 2).length,
        3: rows.filter((g) => g.escalationTier === 3).length,
      },
      escalated: rows.filter((g) => g.escalationTier > 0).length,
      autoEscalated: rows.filter((g) =>
        (g.escalationHistory as { automatic?: unknown }[]).some((h) => h?.automatic === true),
      ).length,
      verifiedClosures: verified.length,
      /** share of verified closures where the complainant said it worked */
      satisfactionRate: shareOf(satisfied.length, verified.length),
      reopened: rows.filter((g) => g.complainantSatisfied === 0).length,
    };
  });
}
