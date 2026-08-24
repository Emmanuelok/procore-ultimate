import type { FastifyInstance } from "fastify";
import { and, asc, count, desc, eq, inArray, isNotNull, lt, notInArray } from "drizzle-orm";
import { z } from "zod";
import {
  affectedPersons,
  companyMemberships,
  grievances,
  locations,
  obligations,
  signals,
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
const escalateSchema = z.object({ reason: z.string().min(1).max(20000) });
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

  /**
   * Lazy SLA breach sweep (#572), same shape as the payments deemed-liability
   * sweep: a grievance whose resolution deadline has passed while it is still
   * open breaches its obligation and raises a signal — exactly once, keyed on
   * the grievance id carried in the signal's evidenceRefs so repeated reads
   * never duplicate it. Severity tracks the grievance: a critical community
   * grievance left past its deadline is itself a critical integrity signal.
   */
  async function sweepSlaBreaches(
    companyId: string,
    projectId: string,
    actorId: string,
  ): Promise<void> {
    const today = todayISO();
    const overdue = await app.db
      .select()
      .from(grievances)
      .where(
        and(
          eq(grievances.companyId, companyId),
          eq(grievances.projectId, projectId),
          notInArray(grievances.status, [...GRIEVANCE_SETTLED_STATUSES]),
          isNotNull(grievances.resolveDueAt),
          lt(grievances.resolveDueAt, today),
        ),
      );
    if (overdue.length === 0) return;
    const existing = await app.db
      .select({ evidenceRefs: signals.evidenceRefs })
      .from(signals)
      .where(
        and(
          eq(signals.companyId, companyId),
          eq(signals.projectId, projectId),
          eq(signals.detector, "grievance_sla_breach"),
        ),
      );
    const seen = new Set(
      existing.map((row) => (row.evidenceRefs as { grievanceId?: string } | null)?.grievanceId ?? ""),
    );
    for (const g of overdue) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      if (g.obligationId) {
        await app.db
          .update(obligations)
          .set({ status: "breached" })
          .where(and(eq(obligations.id, g.obligationId), eq(obligations.status, "open")));
      }
      const rule = GRIEVANCE_SLA[g.severity as keyof typeof GRIEVANCE_SLA];
      const overdueBy = g.resolveDueAt ? Math.abs(daysUntil(g.resolveDueAt)) : 0;
      const sigId = newId("sig");
      await app.db.insert(signals).values({
        id: sigId,
        companyId,
        projectId,
        detector: "grievance_sla_breach",
        severity: g.severity === "critical" ? "critical" : "high",
        confidence: 1,
        title: `Grievance GRV-${g.number} past its resolution SLA by ${overdueBy} day(s)`,
        explanation:
          `Grievance GRV-${g.number} (${g.category}, severity ${g.severity}) was received on ` +
          `${g.receivedAt} with a resolution deadline of ${g.resolveDueAt} under the ` +
          `${rule ? `${rule.resolveDays}-day` : "published"} grievance redress standard, and remains ` +
          `${g.status}. An unresolved grievance past its published SLA is the single clearest ` +
          `evidence that the grievance mechanism is not functioning — a reportable finding under ` +
          `IFC PS1 / ESS10 and a common trigger for community disruption of the works.`,
        evidenceRefs: {
          grievanceId: g.id,
          number: g.number,
          resolveDueAt: g.resolveDueAt,
          severity: g.severity,
        },
      });
      await appendLedger(app.db, {
        companyId,
        actorId,
        action: "state_change",
        objectType: "grievance",
        objectId: g.id,
        payload: {
          event: "sla_breached",
          number: g.number,
          resolveDueAt: g.resolveDueAt,
          status: g.status,
          obligationId: g.obligationId,
        },
        storePayload: true,
      });
    }
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
    const number = await nextRecordNumber(app.db, req.projectId!, "grievance");

    // The resolution deadline materializes as an assurance Obligation so the
    // GRM clock and the obligation register see the same date (#572).
    const obligationId = newId("obl");
    await app.db.insert(obligations).values({
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

    const id = newId("grv");
    await app.db.insert(grievances).values({
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
    await sweepSlaBreaches(req.companyId!, req.projectId!, req.user!.id);
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
      await fetchGrievance(grievanceId, req.companyId!, req.projectId!); // 404 before sweeping
      await sweepSlaBreaches(req.companyId!, req.projectId!, req.user!.id);
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

  app.post(
    "/projects/:projectId/grievances/:grievanceId/escalate",
    { preHandler: standardGate },
    async (req) => {
      const { grievanceId } = req.params as { grievanceId: string };
      const body = escalateSchema.parse(req.body);
      const g = await fetchGrievance(grievanceId, req.companyId!, req.projectId!);
      if (SETTLED.includes(g.status)) throw badRequest(`A ${g.status} grievance cannot be escalated`);
      if (g.status === "escalated") throw badRequest("Grievance is already escalated");
      const now = new Date().toISOString();
      await app.db
        .update(grievances)
        .set({ status: "escalated", updatedAt: now })
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
          reason: body.reason,
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
    await sweepSlaBreaches(req.companyId!, req.projectId!, req.user!.id);
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
    const withinSla = rows.filter(
      (g) => g.resolvedAt != null && g.resolveDueAt != null && g.resolvedAt.slice(0, 10) <= g.resolveDueAt,
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
      slaComplianceRate: shareOf(withinSla.length, resolvedDurations.length),
      verifiedClosures: verified.length,
      /** share of verified closures where the complainant said it worked */
      satisfactionRate: shareOf(satisfied.length, verified.length),
      reopened: rows.filter((g) => g.complainantSatisfied === 0).length,
    };
  });
}
