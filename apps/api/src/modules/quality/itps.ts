/**
 * Inspection and test plans (§ ITP) — the agreement, made before the work
 * starts, about who looks at what and when everybody else gets to stop it.
 *
 * The plan itself is almost administrative. The ACTIVITIES are the module:
 * each carries an intervention point, the notice its verifying party is
 * contractually owed, and — for hold points — a release that somebody other
 * than the party doing the work has to give. Those rules live in
 * ./holdPoints.ts as a pure state machine; this file is the register around
 * them.
 */

import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray } from "drizzle-orm";
import { z } from "zod";
import { inspectionTestPlans, itpActivities } from "@constructos/db";
import {
  INTERVENTION_POINTS,
  ITP_ACTIVITY_STATUSES,
  ITP_RESPONSIBLE_PARTIES,
  ITP_STATUSES,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { pushNotifications } from "../notifications/service.js";
import {
  allocateReference,
  assertDistinctActor,
  assertLocation,
  assertVendor,
  buildGates,
  fileIdsSchema,
  idSchema,
  isoDateSchema,
  ledger,
  nowISO,
  todayISO,
} from "./shared.js";
import {
  AUTHORISATION_REFUSALS,
  canNotify,
  canRelease,
  canWaive,
  isTerminalActivityStatus,
  mayProceedPast,
  noticeStatus,
  parseVerifyingParties,
  summariseActivities,
  type HoldPointActivityLike,
} from "./holdPoints.js";
import { sweepQuality } from "./sweeps.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const verifyingPartySchema = z.object({
  party: z.enum(ITP_RESPONSIBLE_PARTIES),
  interventionPoint: z.enum(INTERVENTION_POINTS).nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  /** a platform user, where the verifier has an account — the strongest form */
  userId: idSchema.nullable().optional(),
  name: z.string().max(200).nullable().optional(),
  email: z.string().max(320).nullable().optional(),
});

const itpCreateSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(10_000).nullable().optional(),
  scopeOfWork: z.string().max(10_000).nullable().optional(),
  discipline: z.string().max(100).nullable().optional(),
  specSectionId: idSchema.nullable().optional(),
  specSectionCode: z.string().max(100).nullable().optional(),
  workPackage: z.string().max(200).nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  commitmentId: idSchema.nullable().optional(),
  locationId: idSchema.nullable().optional(),
  standardsReferences: z.array(z.string().max(200)).max(100).optional(),
  effectiveFrom: isoDateSchema.nullable().optional(),
  documentFileId: idSchema.nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const itpPatchSchema = itpCreateSchema.partial();

const itpListQuery = pageQuerySchema.extend({
  status: z.enum(ITP_STATUSES).optional(),
  discipline: z.string().max(100).optional(),
  vendorId: idSchema.optional(),
  specSectionId: idSchema.optional(),
  search: z.string().max(200).optional(),
});

const activityCreateSchema = z.object({
  activity: z.string().min(1).max(300),
  activityCode: z.string().max(50).nullable().optional(),
  description: z.string().max(10_000).nullable().optional(),
  position: z.number().int().min(0).max(100_000).optional(),
  specReference: z.string().max(200).nullable().optional(),
  specSectionId: idSchema.nullable().optional(),
  drawingReference: z.string().max(200).nullable().optional(),
  drawingSheetId: idSchema.nullable().optional(),
  acceptanceCriteria: z.string().max(10_000).nullable().optional(),
  testMethod: z.string().max(500).nullable().optional(),
  frequency: z.string().max(200).nullable().optional(),
  recordRequired: z.string().max(300).nullable().optional(),
  responsibleParty: z.enum(ITP_RESPONSIBLE_PARTIES).optional(),
  interventionPoint: z.enum(INTERVENTION_POINTS).optional(),
  noticePeriodHours: z.number().int().min(0).max(8760).nullable().optional(),
  verifyingParties: z.array(verifyingPartySchema).max(20).optional(),
  plannedDate: isoDateSchema.nullable().optional(),
  scheduleActivityId: idSchema.nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const activityPatchSchema = activityCreateSchema.partial().extend({
  actualDate: isoDateSchema.nullable().optional(),
  checklistId: idSchema.nullable().optional(),
  testRecordId: idSchema.nullable().optional(),
  status: z.enum(["pending", "failed", "closed", "not_applicable"]).optional(),
});

const notifySchema = z.object({
  method: z.string().min(1).max(200),
  notifiedAt: z.string().min(4).optional(),
  note: z.string().max(2000).nullable().optional(),
  /** platform users to notify in-app alongside the recorded service of notice */
  notifyUserIds: z.array(idSchema).max(50).optional(),
});

const releaseSchema = z.object({
  note: z.string().max(4000).nullable().optional(),
  releasedAt: z.string().min(4).optional(),
});

const waiveSchema = z.object({
  reason: z.string().min(1).max(4000),
});

const approveSchema = z.object({
  decision: z.enum(["approved", "approved_as_noted", "rejected"]),
  approvalAuthority: z.string().min(1).max(200),
  comments: z.string().max(4000).nullable().optional(),
});

const reorderSchema = z.object({ order: z.array(idSchema).min(1).max(500) });

const reviseSchema = z.object({
  reason: z.string().max(4000).nullable().optional(),
  copyActivities: z.boolean().optional(),
});

const holdPointListQuery = pageQuerySchema.extend({
  interventionPoint: z.enum(INTERVENTION_POINTS).optional(),
  status: z.enum(ITP_ACTIVITY_STATUSES).optional(),
  openOnly: z.coerce.boolean().optional(),
});

/** Plan fields may only be edited before the plan is agreed. */
const EDITABLE_ITP_STATUSES = ["draft", "rejected"];

const ITP_PATCH_COLUMNS = [
  "title",
  "description",
  "scopeOfWork",
  "discipline",
  "specSectionId",
  "specSectionCode",
  "workPackage",
  "vendorId",
  "commitmentId",
  "locationId",
  "standardsReferences",
  "effectiveFrom",
  "documentFileId",
  "detail",
] as const;

const ACTIVITY_PLAN_COLUMNS = [
  "activity",
  "activityCode",
  "description",
  "position",
  "specReference",
  "specSectionId",
  "drawingReference",
  "drawingSheetId",
  "acceptanceCriteria",
  "testMethod",
  "frequency",
  "recordRequired",
  "responsibleParty",
  "interventionPoint",
  "noticePeriodHours",
  "verifyingParties",
  "plannedDate",
  "scheduleActivityId",
  "detail",
] as const;

const ACTIVITY_EXECUTION_COLUMNS = [
  "actualDate",
  "checklistId",
  "testRecordId",
  "status",
] as const;

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const itpRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);

  async function fetchItp(itpId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(inspectionTestPlans)
      .where(
        and(
          eq(inspectionTestPlans.id, itpId),
          eq(inspectionTestPlans.companyId, companyId),
          eq(inspectionTestPlans.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Inspection and test plan not found");
    return rows[0];
  }

  async function fetchActivity(activityId: string, itpId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(itpActivities)
      .where(
        and(
          eq(itpActivities.id, activityId),
          eq(itpActivities.itpId, itpId),
          eq(itpActivities.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("ITP activity not found");
    return rows[0];
  }

  async function loadActivities(itpId: string) {
    return app.db
      .select()
      .from(itpActivities)
      .where(eq(itpActivities.itpId, itpId))
      .orderBy(asc(itpActivities.position), asc(itpActivities.createdAt));
  }

  /** Recompute the denormalised hold/witness counters from the activities. */
  async function refreshCounters(itpId: string) {
    const acts = await loadActivities(itpId);
    const summary = summariseActivities(acts, todayISO(), Date.now());
    await app.db
      .update(inspectionTestPlans)
      .set({
        activityCount: summary.activityCount,
        holdPointCount: summary.holdPointCount,
        witnessPointCount: summary.witnessPointCount,
        openHoldPointCount: summary.openHoldPointCount,
        updatedAt: nowISO(),
      })
      .where(eq(inspectionTestPlans.id, itpId));
    return summary;
  }

  /** The plan plus its activities and their computed standing — the detail shape. */
  async function itpDetail(itpId: string, companyId: string, projectId: string) {
    const itp = await fetchItp(itpId, companyId, projectId);
    const acts = await loadActivities(itpId);
    const nowMs = Date.now();
    return {
      ...itp,
      activities: acts.map((a) => decorate(a, nowMs)),
      holdPoints: summariseActivities(acts, todayISO(), nowMs),
    };
  }

  /** An activity as the API renders it: the row plus its computed standing. */
  function decorate(a: HoldPointActivityLike & Record<string, unknown>, nowMs: number) {
    return {
      ...a,
      parsedVerifyingParties: parseVerifyingParties(a.verifyingParties),
      notice: noticeStatus(a, nowMs),
      mayProceed: mayProceedPast(a, nowMs),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Plans                                                             */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/itps", { preHandler: standardGate }, async (req, reply) => {
    const body = itpCreateSchema.parse(req.body);
    if (body.vendorId) await assertVendor(app.db, req.companyId!, body.vendorId);
    if (body.locationId) await assertLocation(app.db, req.projectId!, body.locationId);
    const { number, reference } = await allocateReference(
      app.db,
      req.projectId!,
      "itp",
      "ITP",
    );
    const id = newId("itp");
    const [created] = await app.db
      .insert(inspectionTestPlans)
      .values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        reference,
        title: body.title,
        description: body.description ?? null,
        scopeOfWork: body.scopeOfWork ?? null,
        discipline: body.discipline ?? null,
        specSectionId: body.specSectionId ?? null,
        specSectionCode: body.specSectionCode ?? null,
        workPackage: body.workPackage ?? null,
        vendorId: body.vendorId ?? null,
        commitmentId: body.commitmentId ?? null,
        locationId: body.locationId ?? null,
        standardsReferences: body.standardsReferences ?? [],
        effectiveFrom: body.effectiveFrom ?? null,
        documentFileId: body.documentFileId ?? null,
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "inspection_test_plan",
      objectId: id,
      payload: created,
      storePayload: true,
    });
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/itps", { preHandler: readGate }, async (req) => {
    await sweepQuality(app.db, req.companyId!, req.projectId!, req.user!.id);
    const q = itpListQuery.parse(req.query);
    const clauses = [
      eq(inspectionTestPlans.companyId, req.companyId!),
      eq(inspectionTestPlans.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(inspectionTestPlans.status, q.status));
    if (q.discipline) clauses.push(eq(inspectionTestPlans.discipline, q.discipline));
    if (q.vendorId) clauses.push(eq(inspectionTestPlans.vendorId, q.vendorId));
    if (q.specSectionId) clauses.push(eq(inspectionTestPlans.specSectionId, q.specSectionId));
    if (q.search) clauses.push(ilike(inspectionTestPlans.title, `%${q.search}%`));
    const where = and(...clauses);
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(inspectionTestPlans)
      .where(where);
    const items = await app.db
      .select()
      .from(inspectionTestPlans)
      .where(where)
      .orderBy(desc(inspectionTestPlans.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/itps/:itpId", { preHandler: readGate }, async (req) => {
    const { itpId } = req.params as { itpId: string };
    return itpDetail(itpId, req.companyId!, req.projectId!);
  });

  app.patch("/projects/:projectId/itps/:itpId", { preHandler: standardGate }, async (req) => {
    const { itpId } = req.params as { itpId: string };
    const body = itpPatchSchema.parse(req.body);
    const itp = await fetchItp(itpId, req.companyId!, req.projectId!);
    if (!EDITABLE_ITP_STATUSES.includes(itp.status)) {
      throw badRequest(
        `${itp.reference} is ${itp.status}. An agreed plan is not edited in place — issue a revision (POST /projects/:projectId/itps/${itpId}/revise) so the superseded version stays readable.`,
      );
    }
    if (body.vendorId) await assertVendor(app.db, req.companyId!, body.vendorId);
    if (body.locationId) await assertLocation(app.db, req.projectId!, body.locationId);
    const set: Record<string, unknown> = { updatedAt: nowISO() };
    for (const key of ITP_PATCH_COLUMNS) {
      const value = (body as Record<string, unknown>)[key];
      if (value !== undefined) set[key] = value;
    }
    await app.db
      .update(inspectionTestPlans)
      .set(set)
      .where(eq(inspectionTestPlans.id, itpId));
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "inspection_test_plan",
      objectId: itpId,
      payload: { changed: Object.keys(body) },
    });
    return fetchItp(itpId, req.companyId!, req.projectId!);
  });

  app.post(
    "/projects/:projectId/itps/:itpId/submit",
    { preHandler: standardGate },
    async (req) => {
      const { itpId } = req.params as { itpId: string };
      const itp = await fetchItp(itpId, req.companyId!, req.projectId!);
      if (!EDITABLE_ITP_STATUSES.includes(itp.status)) {
        throw badRequest(`${itp.reference} is ${itp.status} and cannot be submitted again.`);
      }
      const acts = await loadActivities(itpId);
      if (acts.length === 0) {
        throw badRequest(
          `${itp.reference} has no activities. A plan that verifies nothing cannot be submitted for approval.`,
        );
      }
      await app.db
        .update(inspectionTestPlans)
        .set({
          status: "submitted",
          submittedAt: nowISO(),
          submittedBy: req.user!.id,
          updatedAt: nowISO(),
        })
        .where(eq(inspectionTestPlans.id, itpId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "inspection_test_plan",
        objectId: itpId,
        payload: { from: itp.status, to: "submitted", activityCount: acts.length },
      });
      return fetchItp(itpId, req.companyId!, req.projectId!);
    },
  );

  /**
   * Approval of the plan. The approving authority is the engineer or the
   * client; it is NEVER the author, and never the person who submitted it —
   * an ITP the contractor approved for itself agrees nothing with anybody.
   */
  app.post(
    "/projects/:projectId/itps/:itpId/approve",
    { preHandler: standardGate },
    async (req) => {
      const { itpId } = req.params as { itpId: string };
      const body = approveSchema.parse(req.body);
      const itp = await fetchItp(itpId, req.companyId!, req.projectId!);
      if (itp.status !== "submitted") {
        throw badRequest(
          `${itp.reference} is ${itp.status}; only a submitted plan is put to an approval authority.`,
        );
      }
      assertDistinctActor(req.user!.id, itp.createdBy, "Approval of an ITP", "authored");
      assertDistinctActor(req.user!.id, itp.submittedBy, "Approval of an ITP", "submitted");
      const at = nowISO();
      await app.db
        .update(inspectionTestPlans)
        .set({
          status: body.decision,
          approvedBy: body.decision === "rejected" ? null : req.user!.id,
          approvedAt: body.decision === "rejected" ? null : at,
          approvalAuthority: body.approvalAuthority,
          approvalComments: body.comments ?? null,
          updatedAt: at,
        })
        .where(eq(inspectionTestPlans.id, itpId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "inspection_test_plan",
        objectId: itpId,
        payload: {
          from: itp.status,
          to: body.decision,
          approvalAuthority: body.approvalAuthority,
          comments: body.comments ?? null,
        },
        storePayload: true,
      });
      if (itp.createdBy !== req.user!.id) {
        await pushNotifications(app.db, [
          {
            companyId: req.companyId!,
            userId: itp.createdBy,
            projectId: req.projectId!,
            kind: "status_change",
            title: `${itp.reference} ${body.decision.replace(/_/g, " ")} by ${body.approvalAuthority}`,
            recordType: "inspection_test_plan",
            recordId: itpId,
          },
        ]);
      }
      return fetchItp(itpId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/itps/:itpId/activate",
    { preHandler: standardGate },
    async (req) => {
      const { itpId } = req.params as { itpId: string };
      const itp = await fetchItp(itpId, req.companyId!, req.projectId!);
      if (itp.status !== "approved" && itp.status !== "approved_as_noted") {
        throw badRequest(
          `${itp.reference} is ${itp.status}. Only an approved plan goes active — the point of the approval is that the hold points were agreed before the work started.`,
        );
      }
      await app.db
        .update(inspectionTestPlans)
        .set({ status: "active", updatedAt: nowISO() })
        .where(eq(inspectionTestPlans.id, itpId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "inspection_test_plan",
        objectId: itpId,
        payload: { from: itp.status, to: "active" },
      });
      return fetchItp(itpId, req.companyId!, req.projectId!);
    },
  );

  app.post("/projects/:projectId/itps/:itpId/close", { preHandler: standardGate }, async (req) => {
    const { itpId } = req.params as { itpId: string };
    const itp = await fetchItp(itpId, req.companyId!, req.projectId!);
    const acts = await loadActivities(itpId);
    const open = acts.filter((a) => !isTerminalActivityStatus(a.status));
    if (open.length > 0) {
      throw badRequest(
        `${itp.reference} still has ${open.length} outstanding activity(ies): ${open
          .map((a) => a.activityCode ?? a.activity)
          .join(", ")}. Release, waive or mark them not applicable before closing the plan.`,
      );
    }
    await app.db
      .update(inspectionTestPlans)
      .set({ status: "closed", updatedAt: nowISO() })
      .where(eq(inspectionTestPlans.id, itpId));
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "inspection_test_plan",
      objectId: itpId,
      payload: { from: itp.status, to: "closed" },
    });
    return fetchItp(itpId, req.companyId!, req.projectId!);
  });

  /**
   * Issue the next revision. The old plan is SUPERSEDED rather than edited:
   * a hold point that was released against revision 0 was released against
   * the criteria revision 0 carried, and rewriting them afterwards would make
   * the release evidence of something that never happened.
   */
  app.post(
    "/projects/:projectId/itps/:itpId/revise",
    { preHandler: standardGate },
    async (req, reply) => {
      const { itpId } = req.params as { itpId: string };
      const body = reviseSchema.parse(req.body ?? {});
      const itp = await fetchItp(itpId, req.companyId!, req.projectId!);
      if (itp.supersededById) {
        throw badRequest(
          `${itp.reference} has already been superseded by ${itp.supersededById}. Revise the current revision instead.`,
        );
      }
      const { number, reference } = await allocateReference(
        app.db,
        req.projectId!,
        "itp",
        "ITP",
      );
      const newIdValue = newId("itp");
      const at = nowISO();
      const [created] = await app.db
        .insert(inspectionTestPlans)
        .values({
          id: newIdValue,
          companyId: itp.companyId,
          projectId: itp.projectId,
          number,
          reference,
          title: itp.title,
          description: itp.description,
          scopeOfWork: itp.scopeOfWork,
          discipline: itp.discipline,
          specSectionId: itp.specSectionId,
          specSectionCode: itp.specSectionCode,
          workPackage: itp.workPackage,
          vendorId: itp.vendorId,
          commitmentId: itp.commitmentId,
          locationId: itp.locationId,
          revision: itp.revision + 1,
          status: "draft",
          standardsReferences: itp.standardsReferences,
          effectiveFrom: itp.effectiveFrom,
          supersedesId: itp.id,
          documentFileId: itp.documentFileId,
          detail: { ...(itp.detail as Record<string, unknown>), revisionReason: body.reason ?? null },
          createdBy: req.user!.id,
        })
        .returning();
      await app.db
        .update(inspectionTestPlans)
        .set({ status: "superseded", supersededById: newIdValue, updatedAt: at })
        .where(eq(inspectionTestPlans.id, itpId));

      if (body.copyActivities !== false) {
        const acts = await loadActivities(itpId);
        for (const a of acts) {
          await app.db.insert(itpActivities).values({
            id: newId("ita"),
            companyId: a.companyId,
            projectId: a.projectId,
            itpId: newIdValue,
            position: a.position,
            activityCode: a.activityCode,
            activity: a.activity,
            description: a.description,
            specReference: a.specReference,
            specSectionId: a.specSectionId,
            drawingReference: a.drawingReference,
            drawingSheetId: a.drawingSheetId,
            acceptanceCriteria: a.acceptanceCriteria,
            testMethod: a.testMethod,
            frequency: a.frequency,
            recordRequired: a.recordRequired,
            responsibleParty: a.responsibleParty,
            interventionPoint: a.interventionPoint,
            noticePeriodHours: a.noticePeriodHours,
            verifyingParties: a.verifyingParties,
            plannedDate: a.plannedDate,
            scheduleActivityId: a.scheduleActivityId,
            detail: { ...(a.detail as Record<string, unknown>), copiedFromActivityId: a.id },
          });
        }
        await refreshCounters(newIdValue);
      }

      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "inspection_test_plan",
        objectId: itpId,
        payload: {
          from: itp.status,
          to: "superseded",
          supersededById: newIdValue,
          revision: itp.revision + 1,
          reason: body.reason ?? null,
        },
        storePayload: true,
      });
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "inspection_test_plan",
        objectId: newIdValue,
        payload: created,
        storePayload: true,
      });
      return reply.status(201).send(await itpDetail(newIdValue, req.companyId!, req.projectId!));
    },
  );

  /* ---------------------------------------------------------------- */
  /* Activities                                                        */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/itps/:itpId/activities",
    { preHandler: readGate },
    async (req) => {
      const { itpId } = req.params as { itpId: string };
      await fetchItp(itpId, req.companyId!, req.projectId!);
      const acts = await loadActivities(itpId);
      const nowMs = Date.now();
      return {
        items: acts.map((a) => decorate(a, nowMs)),
        total: acts.length,
        summary: summariseActivities(acts, todayISO(), nowMs),
      };
    },
  );

  app.post(
    "/projects/:projectId/itps/:itpId/activities",
    { preHandler: standardGate },
    async (req, reply) => {
      const { itpId } = req.params as { itpId: string };
      const body = activityCreateSchema.parse(req.body);
      const itp = await fetchItp(itpId, req.companyId!, req.projectId!);
      if (!EDITABLE_ITP_STATUSES.includes(itp.status)) {
        throw badRequest(
          `${itp.reference} is ${itp.status}. Activities are added to a draft plan; adding one to an agreed plan requires a revision.`,
        );
      }
      const interventionPoint = body.interventionPoint ?? "surveillance_point";
      const parties = body.verifyingParties ?? [];
      if (interventionPoint === "hold_point" && parties.length === 0) {
        throw badRequest(
          "A hold point must name at least one verifying party. A point held by nobody in particular cannot be released by anybody in particular, and the release is the only thing that lets the work proceed.",
        );
      }
      const existing = await loadActivities(itpId);
      const position =
        body.position ??
        (existing.length > 0 ? Math.max(...existing.map((a) => a.position)) + 10 : 10);
      const id = newId("ita");
      const [created] = await app.db
        .insert(itpActivities)
        .values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          itpId,
          position,
          activityCode: body.activityCode ?? null,
          activity: body.activity,
          description: body.description ?? null,
          specReference: body.specReference ?? null,
          specSectionId: body.specSectionId ?? null,
          drawingReference: body.drawingReference ?? null,
          drawingSheetId: body.drawingSheetId ?? null,
          acceptanceCriteria: body.acceptanceCriteria ?? null,
          testMethod: body.testMethod ?? null,
          frequency: body.frequency ?? null,
          recordRequired: body.recordRequired ?? null,
          responsibleParty: body.responsibleParty ?? "contractor",
          interventionPoint,
          noticePeriodHours: body.noticePeriodHours ?? null,
          verifyingParties: parties,
          plannedDate: body.plannedDate ?? null,
          scheduleActivityId: body.scheduleActivityId ?? null,
          detail: body.detail ?? {},
        })
        .returning();
      await refreshCounters(itpId);
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "itp_activity",
        objectId: id,
        payload: created,
        storePayload: true,
      });
      return reply.status(201).send(decorate(created!, Date.now()));
    },
  );

  app.patch(
    "/projects/:projectId/itps/:itpId/activities/:activityId",
    { preHandler: standardGate },
    async (req) => {
      const { itpId, activityId } = req.params as { itpId: string; activityId: string };
      const body = activityPatchSchema.parse(req.body);
      const itp = await fetchItp(itpId, req.companyId!, req.projectId!);
      const activity = await fetchActivity(activityId, itpId, req.projectId!);
      const touchesPlan = ACTIVITY_PLAN_COLUMNS.some(
        (k) => (body as Record<string, unknown>)[k] !== undefined,
      );
      if (touchesPlan && !EDITABLE_ITP_STATUSES.includes(itp.status)) {
        throw badRequest(
          `${itp.reference} is ${itp.status}. The plan fields of an agreed activity are changed by revising the plan, not by editing the row that a release may already have been given against.`,
        );
      }
      if (
        body.interventionPoint === "hold_point" &&
        (body.verifyingParties ?? (activity.verifyingParties as unknown[])).length === 0
      ) {
        throw badRequest("A hold point must name at least one verifying party.");
      }
      const set: Record<string, unknown> = { updatedAt: nowISO() };
      for (const key of [...ACTIVITY_PLAN_COLUMNS, ...ACTIVITY_EXECUTION_COLUMNS]) {
        const value = (body as Record<string, unknown>)[key];
        if (value !== undefined) set[key] = value;
      }
      await app.db.update(itpActivities).set(set).where(eq(itpActivities.id, activityId));
      await refreshCounters(itpId);
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "itp_activity",
        objectId: activityId,
        payload: { changed: Object.keys(body) },
      });
      return decorate(await fetchActivity(activityId, itpId, req.projectId!), Date.now());
    },
  );

  app.post(
    "/projects/:projectId/itps/:itpId/activities/reorder",
    { preHandler: standardGate },
    async (req) => {
      const { itpId } = req.params as { itpId: string };
      const body = reorderSchema.parse(req.body);
      await fetchItp(itpId, req.companyId!, req.projectId!);
      const acts = await loadActivities(itpId);
      const known = new Set(acts.map((a) => a.id));
      const unknownIds = body.order.filter((id) => !known.has(id));
      if (unknownIds.length > 0) {
        throw badRequest(`Not activities of this ITP: ${unknownIds.join(", ")}`);
      }
      if (body.order.length !== acts.length) {
        throw badRequest(
          `The order must list every activity exactly once: ${acts.length} expected, ${body.order.length} given. An ITP is a sequence — a partial order would leave the rest of the plan unordered.`,
        );
      }
      for (const [index, id] of body.order.entries()) {
        await app.db
          .update(itpActivities)
          .set({ position: (index + 1) * 10, updatedAt: nowISO() })
          .where(eq(itpActivities.id, id));
      }
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "inspection_test_plan",
        objectId: itpId,
        payload: { reordered: body.order },
        storePayload: true,
      });
      const reordered = await loadActivities(itpId);
      const nowMs = Date.now();
      return { items: reordered.map((a) => decorate(a, nowMs)), total: reordered.length };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Notify / release / waive — the hold-point transitions             */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/itps/:itpId/activities/:activityId/notify",
    { preHandler: standardGate },
    async (req) => {
      const { itpId, activityId } = req.params as { itpId: string; activityId: string };
      const body = notifySchema.parse(req.body);
      await fetchItp(itpId, req.companyId!, req.projectId!);
      const activity = await fetchActivity(activityId, itpId, req.projectId!);
      const decision = canNotify(activity);
      if (!decision.allowed) throw badRequest(decision.reasons.join(" "));
      const at = body.notifiedAt ?? nowISO();
      await app.db
        .update(itpActivities)
        .set({
          status: "notified",
          notifiedAt: at,
          notifiedBy: req.user!.id,
          notificationMethod: body.method,
          detail: {
            ...(activity.detail as Record<string, unknown>),
            lastNotificationNote: body.note ?? null,
          },
          updatedAt: nowISO(),
        })
        .where(eq(itpActivities.id, activityId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "itp_activity",
        objectId: activityId,
        payload: {
          from: activity.status,
          to: "notified",
          notifiedAt: at,
          method: body.method,
          noticePeriodHours: activity.noticePeriodHours,
          verifyingParties: activity.verifyingParties,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      const partyUserIds = parseVerifyingParties(activity.verifyingParties)
        .map((p) => p.userId)
        .filter((id): id is string => typeof id === "string" && id !== "");
      const recipients = [...new Set([...(body.notifyUserIds ?? []), ...partyUserIds])].filter(
        (id) => id !== req.user!.id,
      );
      if (recipients.length > 0) {
        await pushNotifications(
          app.db,
          recipients.map((userId) => ({
            companyId: req.companyId!,
            userId,
            projectId: req.projectId!,
            kind: "assignment" as const,
            title: `${activity.interventionPoint.replace(/_/g, " ")} notice: ${activity.activity}`,
            recordType: "itp_activity",
            recordId: activityId,
          })),
        );
      }
      const updated = await fetchActivity(activityId, itpId, req.projectId!);
      return decorate(updated, Date.now());
    },
  );

  /**
   * Release. The one route in this module most worth reading: it refuses when
   * the releasing user is not the nominated verifying party, and refuses when
   * the user who raised the point tries to release their own.
   */
  app.post(
    "/projects/:projectId/itps/:itpId/activities/:activityId/release",
    { preHandler: standardGate },
    async (req) => {
      const { itpId, activityId } = req.params as { itpId: string; activityId: string };
      const body = releaseSchema.parse(req.body ?? {});
      const itp = await fetchItp(itpId, req.companyId!, req.projectId!);
      const activity = await fetchActivity(activityId, itpId, req.projectId!);
      const decision = canRelease(activity, {
        actorId: req.user!.id,
        raisedBy: activity.notifiedBy ?? itp.createdBy,
      });
      if (!decision.allowed) {
        // A wrong-party or self-release refusal is an authorisation failure,
        // not a malformed request: no rewording of the body makes it allowed.
        throw decision.code && AUTHORISATION_REFUSALS.includes(decision.code)
          ? forbidden(decision.reasons.join(" "))
          : badRequest(decision.reasons.join(" "));
      }
      const at = body.releasedAt ?? nowISO();
      await app.db
        .update(itpActivities)
        .set({
          status: "released",
          releasedBy: req.user!.id,
          releasedAt: at,
          releaseNote: body.note ?? null,
          actualDate: activity.actualDate ?? todayISO(),
          updatedAt: nowISO(),
        })
        .where(eq(itpActivities.id, activityId));
      await refreshCounters(itpId);
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "itp_activity",
        objectId: activityId,
        payload: {
          from: activity.status,
          to: "released",
          releasedBy: req.user!.id,
          releasedAt: at,
          note: body.note ?? null,
          notifiedAt: activity.notifiedAt,
          notifiedBy: activity.notifiedBy,
        },
        storePayload: true,
      });
      return decorate(await fetchActivity(activityId, itpId, req.projectId!), Date.now());
    },
  );

  app.post(
    "/projects/:projectId/itps/:itpId/activities/:activityId/waive",
    { preHandler: standardGate },
    async (req) => {
      const { itpId, activityId } = req.params as { itpId: string; activityId: string };
      const body = waiveSchema.parse(req.body);
      await fetchItp(itpId, req.companyId!, req.projectId!);
      const activity = await fetchActivity(activityId, itpId, req.projectId!);
      const decision = canWaive(activity, body.reason);
      if (!decision.allowed) throw badRequest(decision.reasons.join(" "));
      const at = nowISO();
      await app.db
        .update(itpActivities)
        .set({
          status: "waived",
          waivedBy: req.user!.id,
          waivedAt: at,
          waiverReason: body.reason,
          updatedAt: at,
        })
        .where(eq(itpActivities.id, activityId));
      await refreshCounters(itpId);
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "itp_activity",
        objectId: activityId,
        payload: { from: activity.status, to: "waived", waivedBy: req.user!.id, reason: body.reason },
        storePayload: true,
      });
      return decorate(await fetchActivity(activityId, itpId, req.projectId!), Date.now());
    },
  );

  /* ---------------------------------------------------------------- */
  /* Cross-plan hold-point register                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Every intervention point on the project in one list — the screen a site
   * team actually works from, because a hold point matters to the person
   * about to pour concrete regardless of which ITP it sits on.
   */
  app.get("/projects/:projectId/hold-points", { preHandler: readGate }, async (req) => {
    await sweepQuality(app.db, req.companyId!, req.projectId!, req.user!.id);
    const q = holdPointListQuery.parse(req.query);
    const clauses = [
      eq(itpActivities.companyId, req.companyId!),
      eq(itpActivities.projectId, req.projectId!),
    ];
    if (q.interventionPoint) {
      clauses.push(eq(itpActivities.interventionPoint, q.interventionPoint));
    } else {
      clauses.push(inArray(itpActivities.interventionPoint, ["hold_point", "witness_point"]));
    }
    if (q.status) clauses.push(eq(itpActivities.status, q.status));
    else if (q.openOnly) clauses.push(inArray(itpActivities.status, ["pending", "notified", "failed"]));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(itpActivities).where(where);
    const rows = await app.db
      .select()
      .from(itpActivities)
      .where(where)
      .orderBy(asc(itpActivities.plannedDate), asc(itpActivities.position))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const nowMs = Date.now();
    const today = todayISO();
    return {
      ...paginate(
        rows.map((a) => decorate(a, nowMs)),
        Number(totalRow?.n ?? 0),
        q,
      ),
      summary: summariseActivities(rows, today, nowMs),
    };
  });
};
