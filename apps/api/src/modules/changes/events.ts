import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  changeEvents,
  changeLineItems,
  changeOrderPackages,
  changeOrderRequests,
  potentialChangeOrders,
  primeContracts,
  projects,
} from "@constructos/db";
import {
  CHANGE_EVENT_ORIGIN_KINDS,
  CHANGE_EVENT_SCOPES,
  CHANGE_EVENT_STATUSES,
  CHANGE_EVENT_TYPES,
  CHANGE_MANAGEMENT_TIERS,
  CHANGE_REASONS,
  type ChangeManagementTier,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import { applyMarkupStack, ratio, round2, type Component } from "./arithmetic.js";
import { isDead, isApprovedCor } from "./reconcile.js";
import { registerLineRoutes } from "./lines.js";
import {
  actorOf,
  assertTransition,
  buildLineRow,
  changeGates,
  changeLineSchema,
  companyOf,
  detailSchema,
  fetchEvent,
  idSchema,
  isoDateSchema,
  ledgerChange,
  loadLines,
  moneySchema,
  nowIso,
  pad3,
  projectOf,
  verifyOrigin,
} from "./shared.js";

const eventCreateSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  eventType: z.enum(CHANGE_EVENT_TYPES).optional(),
  scope: z.enum(CHANGE_EVENT_SCOPES).optional(),
  reason: z.enum(CHANGE_REASONS).nullable().optional(),
  originType: z.enum(CHANGE_EVENT_ORIGIN_KINDS).optional(),
  originId: idSchema.nullable().optional(),
  primeContractId: idSchema.nullable().optional(),
  locationId: idSchema.nullable().optional(),
  tier: z.enum(CHANGE_MANAGEMENT_TIERS).nullable().optional(),
  roughOrderOfMagnitude: moneySchema.optional(),
  scheduleImpactDays: z.number().int().min(0).max(3650).optional(),
  identifiedDate: isoDateSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  documentIds: z.array(idSchema).max(200).optional(),
  detail: detailSchema.optional(),
  lines: z.array(changeLineSchema).max(500).optional(),
});

const eventPatchSchema = eventCreateSchema
  .omit({ lines: true, originType: true, originId: true })
  .partial();

const eventListQuery = pageQuerySchema.extend({
  status: z.enum(CHANGE_EVENT_STATUSES).optional(),
  eventType: z.enum(CHANGE_EVENT_TYPES).optional(),
  scope: z.enum(CHANGE_EVENT_SCOPES).optional(),
  reason: z.enum(CHANGE_REASONS).optional(),
  originType: z.enum(CHANGE_EVENT_ORIGIN_KINDS).optional(),
  primeContractId: idSchema.optional(),
  search: z.string().max(200).optional(),
});

const statusSchema = z.object({
  status: z.enum(CHANGE_EVENT_STATUSES),
  notes: z.string().max(4000).nullable().optional(),
});

/* ------------------------------------------------------------------ */
/* Rollup                                                              */
/* ------------------------------------------------------------------ */

export interface EventRollup {
  roughOrderOfMagnitude: number;
  estimatedCost: number;
  latestCost: number;
  estimatedRevenue: number;
  approvedRevenue: number;
  /** latest cost against approved revenue, once anything is executed */
  margin: Component;
  pcoCount: number;
  corCount: number;
  executedPackageCount: number;
}

/**
 * Re-derive a change event's three cost columns and two revenue columns from
 * the documents underneath it. Nothing is incremented in place.
 *
 * The three cost columns are three levels of CONFIDENCE, not three guesses:
 *   roughOrderOfMagnitude  what someone typed the day it was raised
 *   estimatedCost          the priced position — Σ of the live PCOs
 *   latestCost             the best number available: executed where the
 *                          commitment change order is signed, priced where it
 *                          is only priced, and the ROM where there is nothing
 *                          else at all.
 * Collapsing them is how a change log stops showing whether exposure is
 * hardening or softening, which is the only question the number is asked.
 */
export async function computeEventRollup(db: Db, eventId: string): Promise<EventRollup> {
  const [event] = await db.select().from(changeEvents).where(eq(changeEvents.id, eventId)).limit(1);
  if (!event) throw notFound("Change event not found");

  const [pcos, cors] = await Promise.all([
    db
      .select()
      .from(potentialChangeOrders)
      .where(eq(potentialChangeOrders.changeEventId, eventId)),
    db.select().from(changeOrderRequests).where(eq(changeOrderRequests.changeEventId, eventId)),
  ]);

  const packageIds = [
    ...new Set(
      [
        ...pcos.map((p) => p.changeOrderPackageId),
        ...cors.map((c) => c.changeOrderPackageId),
      ].filter((x): x is string => !!x),
    ),
  ];
  const packages =
    packageIds.length > 0
      ? await db
          .select()
          .from(changeOrderPackages)
          .where(inArray(changeOrderPackages.id, packageIds))
      : [];
  const executed = new Set(packages.filter((p) => p.status === "executed").map((p) => p.id));

  const livePcos = pcos.filter((p) => !isDead(p.status));
  const position = (p: (typeof pcos)[number]): number =>
    p.noCharge === 1 ? 0 : p.amount !== 0 ? p.amount : p.estimatedAmount;

  const estimatedCost = round2(livePcos.reduce((s, p) => s + position(p), 0));
  const executedCost = round2(
    livePcos
      .filter((p) => p.changeOrderPackageId && executed.has(p.changeOrderPackageId))
      .reduce((s, p) => s + position(p), 0),
  );
  const unexecutedCost = round2(
    livePcos
      .filter((p) => !(p.changeOrderPackageId && executed.has(p.changeOrderPackageId)))
      .reduce((s, p) => s + position(p), 0),
  );
  const latestCost =
    livePcos.length === 0 ? round2(event.roughOrderOfMagnitude) : round2(executedCost + unexecutedCost);

  const liveCors = cors.filter((c) => !isDead(c.status) && c.status !== "draft");
  const estimatedRevenue = round2(
    liveCors.reduce((s, c) => s + (isApprovedCor(c.status) ? c.approvedAmount : c.amount), 0),
  );
  const approvedRevenue = round2(
    cors
      .filter((c) => c.changeOrderPackageId && executed.has(c.changeOrderPackageId))
      .reduce((s, c) => s + c.approvedAmount, 0),
  );

  return {
    roughOrderOfMagnitude: round2(event.roughOrderOfMagnitude),
    estimatedCost,
    latestCost,
    estimatedRevenue,
    approvedRevenue,
    margin:
      approvedRevenue === 0
        ? {
            value: null,
            inputs: { approvedRevenue, executedCost },
            reasons: [
              "Nothing on this event has been executed on the prime contract yet, so there is no " +
                "revenue to take a margin against.",
            ],
          }
        : ratio(approvedRevenue - executedCost, approvedRevenue, "Change event margin"),
    pcoCount: pcos.length,
    corCount: cors.length,
    executedPackageCount: executed.size,
  };
}

/** Compute the rollup AND persist it. Called after every write that moves it. */
export async function recomputeEventRollup(db: Db, eventId: string): Promise<EventRollup> {
  const rollup = await computeEventRollup(db, eventId);
  await db
    .update(changeEvents)
    .set({
      estimatedCost: rollup.estimatedCost,
      latestCost: rollup.latestCost,
      estimatedRevenue: rollup.estimatedRevenue,
      approvedRevenue: rollup.approvedRevenue,
      updatedAt: nowIso(),
    })
    .where(eq(changeEvents.id, eventId));
  return rollup;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const changeEventRoutes: FastifyPluginAsync = async (app) => {
  const gates = changeGates(app);

  async function projectTier(projectId: string): Promise<ChangeManagementTier | null> {
    const rows = await app.db
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const raw = (rows[0]?.settings ?? {})["changeManagementTier"];
    return typeof raw === "string" &&
      (CHANGE_MANAGEMENT_TIERS as readonly string[]).includes(raw)
      ? (raw as ChangeManagementTier)
      : null;
  }

  async function assertContract(primeContractId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(primeContracts)
      .where(
        and(
          eq(primeContracts.id, primeContractId),
          eq(primeContracts.companyId, companyId),
          eq(primeContracts.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) {
      throw badRequest(
        `primeContractId ${primeContractId} is not a prime contract on this project. A change ` +
          "event is billed under this project's contract or under none.",
      );
    }
    return rows[0];
  }

  app.post(
    "/projects/:projectId/change-events",
    { preHandler: gates.standard },
    async (req, reply) => {
      const body = eventCreateSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const actorId = actorOf(req);

      const originType = body.originType ?? "manual";
      const origin = await verifyOrigin(
        app.db,
        companyId,
        projectId,
        originType,
        body.originId ?? null,
      );
      // A link that names a record we hold and cannot resolve is refused; a
      // link to a register the platform does not keep is recorded unverified.
      if (!origin.verified && origin.originId !== null && origin.reasons.length > 0) {
        const hardFailure = origin.reasons.some((r) => r.startsWith("No "));
        if (hardFailure) throw badRequest(origin.reasons.join(" "));
      }
      if (!origin.verified && origin.originId === null && originType !== "manual") {
        throw badRequest(origin.reasons.join(" "));
      }
      if (body.primeContractId) {
        await assertContract(body.primeContractId, companyId, projectId);
      }

      const number = await nextRecordNumber(app.db, projectId, "change_event");
      const id = newId("cev");
      const reference = `CE-${pad3(number)}`;
      const tier = body.tier ?? (await projectTier(projectId));

      await app.db.transaction(async (tx) => {
        await tx.insert(changeEvents).values({
          id,
          companyId,
          projectId,
          number,
          reference,
          title: body.title,
          description: body.description ?? null,
          status: "open",
          eventType: body.eventType ?? "other",
          scope: body.scope ?? "tbd",
          reason: body.reason ?? null,
          originType,
          originId: body.originId ?? null,
          primeContractId: body.primeContractId ?? null,
          locationId: body.locationId ?? null,
          tier,
          roughOrderOfMagnitude: round2(body.roughOrderOfMagnitude ?? 0),
          scheduleImpactDays: body.scheduleImpactDays ?? 0,
          identifiedDate: body.identifiedDate ?? null,
          dueDate: body.dueDate ?? null,
          notes: body.notes ?? null,
          documentIds: body.documentIds ?? [],
          detail: { ...(body.detail ?? {}), origin },
          createdBy: actorId,
        });
        const lines = body.lines ?? [];
        for (const [i, line] of lines.entries()) {
          await tx.insert(changeLineItems).values(
            buildLineRow(
              { companyId, projectId, changeEventId: id, createdBy: actorId },
              "change_event",
              id,
              line,
              (i + 1) * 10,
            ),
          );
        }
      });

      await ledgerChange(app.db, req, "create", "change_event", id, {
        reference,
        title: body.title,
        eventType: body.eventType ?? "other",
        originType,
        originId: body.originId ?? null,
        originVerified: origin.verified,
        roughOrderOfMagnitude: round2(body.roughOrderOfMagnitude ?? 0),
      });

      const created = await fetchEvent(app.db, id, companyId, projectId);
      return reply.status(201).send({ event: created, origin });
    },
  );

  app.get("/projects/:projectId/change-events", { preHandler: gates.read }, async (req) => {
    const q = eventListQuery.parse(req.query);
    const clauses = [
      eq(changeEvents.companyId, companyOf(req)),
      eq(changeEvents.projectId, projectOf(req)),
    ];
    if (q.status) clauses.push(eq(changeEvents.status, q.status));
    if (q.eventType) clauses.push(eq(changeEvents.eventType, q.eventType));
    if (q.scope) clauses.push(eq(changeEvents.scope, q.scope));
    if (q.reason) clauses.push(eq(changeEvents.reason, q.reason));
    if (q.originType) clauses.push(eq(changeEvents.originType, q.originType));
    if (q.primeContractId) clauses.push(eq(changeEvents.primeContractId, q.primeContractId));
    if (q.search) clauses.push(ilike(changeEvents.title, `%${q.search}%`));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(changeEvents).where(where);
    const items = await app.db
      .select()
      .from(changeEvents)
      .where(where)
      .orderBy(desc(changeEvents.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get(
    "/projects/:projectId/change-events/:eventId",
    { preHandler: gates.read },
    async (req) => {
      const { eventId } = req.params as { eventId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const event = await fetchEvent(app.db, eventId, companyId, projectId);
      const [lines, pcos, cors] = await Promise.all([
        loadLines(app.db, "change_event", eventId),
        app.db
          .select()
          .from(potentialChangeOrders)
          .where(eq(potentialChangeOrders.changeEventId, eventId))
          .orderBy(asc(potentialChangeOrders.number)),
        app.db
          .select()
          .from(changeOrderRequests)
          .where(eq(changeOrderRequests.changeEventId, eventId))
          .orderBy(asc(changeOrderRequests.number)),
      ]);
      const rollup = await computeEventRollup(app.db, eventId);
      const stack = applyMarkupStack(
        lines.map((l) => ({
          costAmount: l.costAmount,
          costType: l.costType,
          quantity: l.quantity,
          taxAmount: l.taxAmount,
        })),
        [],
      );
      return {
        event,
        lines,
        lineTotals: {
          costSubtotal: stack.costSubtotal,
          costByType: stack.costByType,
          revenueSubtotal: round2(lines.reduce((s, l) => s + l.revenueAmount, 0)),
          taxTotal: stack.taxTotal,
        },
        potentialChangeOrders: pcos,
        changeOrderRequests: cors,
        rollup,
      };
    },
  );

  app.patch(
    "/projects/:projectId/change-events/:eventId",
    { preHandler: gates.standard },
    async (req) => {
      const { eventId } = req.params as { eventId: string };
      const body = eventPatchSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const event = await fetchEvent(app.db, eventId, companyId, projectId);
      if (event.status === "void" || event.status === "closed") {
        throw conflict(
          `Change event ${event.reference} is ${event.status} and cannot be edited. Reopen it ` +
            "first if the facts have changed.",
        );
      }
      if (body.primeContractId) await assertContract(body.primeContractId, companyId, projectId);

      const set: Record<string, unknown> = { updatedAt: nowIso() };
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined) continue;
        set[key] = key === "roughOrderOfMagnitude" ? round2(value as number) : value;
      }
      await app.db.update(changeEvents).set(set).where(eq(changeEvents.id, eventId));
      await ledgerChange(app.db, req, "update", "change_event", eventId, {
        reference: event.reference,
        changed: Object.keys(body),
      });
      return fetchEvent(app.db, eventId, companyId, projectId);
    },
  );

  app.post(
    "/projects/:projectId/change-events/:eventId/status",
    { preHandler: gates.standard },
    async (req) => {
      const { eventId } = req.params as { eventId: string };
      const body = statusSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const event = await fetchEvent(app.db, eventId, companyId, projectId);
      if (event.status === body.status) {
        throw conflict(`Change event ${event.reference} is already ${body.status}.`);
      }
      assertTransition(
        event.status,
        body.status === "void"
          ? ["open", "pending"]
          : body.status === "closed"
            ? ["open", "pending"]
            : body.status === "pending"
              ? ["open", "closed"]
              : ["closed", "pending"],
        "change event",
        `move to ${body.status}`,
      );

      if (body.status === "closed" || body.status === "void") {
        const live = await app.db
          .select({ id: potentialChangeOrders.id, reference: potentialChangeOrders.reference, status: potentialChangeOrders.status })
          .from(potentialChangeOrders)
          .where(eq(potentialChangeOrders.changeEventId, eventId));
        const unresolved = live.filter((p) => !isDead(p.status) && p.status !== "approved");
        if (unresolved.length > 0) {
          throw conflict(
            `Change event ${event.reference} still has live potential change orders ` +
              `(${unresolved.map((p) => `${p.reference} — ${p.status}`).join("; ")}). Resolve or ` +
              "void them first; closing the event over the top of them hides the exposure.",
          );
        }
        const liveCors = await app.db
          .select({ id: changeOrderRequests.id, reference: changeOrderRequests.reference, status: changeOrderRequests.status })
          .from(changeOrderRequests)
          .where(eq(changeOrderRequests.changeEventId, eventId));
        const openCors = liveCors.filter(
          (c) => !isDead(c.status) && c.status !== "approved" && c.status !== "partially_approved",
        );
        if (openCors.length > 0) {
          throw conflict(
            `Change event ${event.reference} still has change order requests with the owner ` +
              `(${openCors.map((c) => `${c.reference} — ${c.status}`).join("; ")}).`,
          );
        }
      }

      const now = nowIso();
      const closing = body.status === "closed" || body.status === "void";
      await app.db
        .update(changeEvents)
        .set({
          status: body.status,
          closedBy: closing ? actorOf(req) : null,
          closedAt: closing ? now : null,
          notes: body.notes ?? event.notes,
          updatedAt: now,
        })
        .where(eq(changeEvents.id, eventId));
      await ledgerChange(app.db, req, "state_change", "change_event", eventId, {
        reference: event.reference,
        from: event.status,
        to: body.status,
      });
      return fetchEvent(app.db, eventId, companyId, projectId);
    },
  );

  app.post(
    "/projects/:projectId/change-events/:eventId/recalculate",
    { preHandler: gates.standard },
    async (req) => {
      const { eventId } = req.params as { eventId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      await fetchEvent(app.db, eventId, companyId, projectId);
      const rollup = await recomputeEventRollup(app.db, eventId);
      return { event: await fetchEvent(app.db, eventId, companyId, projectId), rollup };
    },
  );

  registerLineRoutes(app, gates, {
    parentType: "change_event",
    objectType: "change_event",
    basePath: "/projects/:projectId/change-events/:eventId",
    paramName: "eventId",
    label: "Change event",
    frozenStatuses: ["closed", "void"],
    fetch: async (db, id, companyId, projectId) => {
      const row = await fetchEvent(db, id, companyId, projectId);
      return { id: row.id, reference: row.reference, status: row.status, changeEventId: row.id };
    },
  });
};
