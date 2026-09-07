/**
 * The sequential sign-off chain on an intervention point (#1092–1094).
 *
 * `itpActivities.verifyingParties` names WHO is nominated; this file records
 * what each of them actually did. The difference matters at the point of a
 * dispute: "the engineer released it" is a claim, while "the contractor's QC
 * signed at 09:14, the engineer at 11:02 having attended at 10:30, and the
 * notified body signed at 14:20 against surveillance report SR-114" is a
 * record, and only the second one survives.
 *
 * The order is enforced (see ./releaseChain.ts) because signing out of
 * sequence certifies an inspection that has not happened yet, and one human
 * may not sign two legs of the same point however they are nominated.
 *
 * The activity itself is released only when the chain completes, which is why
 * this file — not the caller — writes the activity's release columns.
 */

import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, eq, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import { inspectionTestPlans, itpActivities, itpActivityReleases } from "@constructos/db";
import { ITP_RESPONSIBLE_PARTIES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { pushNotifications } from "../notifications/service.js";
import {
  buildGates,
  idSchema,
  isoTimestampSchema,
  ledger,
  nowISO,
  todayISO,
} from "./shared.js";
import { summariseActivities, TERMINAL_ACTIVITY_STATUSES } from "./holdPoints.js";
import {
  canReleaseLeg,
  chainSummary,
  isLegTerminal,
  legLabel,
  LEG_AUTHORISATION_REFUSALS,
  type ReleaseLegLike,
} from "./releaseChain.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const legSchema = z.object({
  party: z.enum(ITP_RESPONSIBLE_PARTIES),
  required: z.boolean().optional(),
  userId: idSchema.nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  organisation: z.string().max(200).nullable().optional(),
  contactName: z.string().max(200).nullable().optional(),
  contactEmail: z.string().max(320).nullable().optional(),
  accreditation: z.string().max(200).nullable().optional(),
});

const chainSchema = z.object({ parties: z.array(legSchema).min(1).max(12) });

const notifyLegSchema = z.object({
  method: z.string().min(1).max(200).optional(),
  notifiedAt: isoTimestampSchema.optional(),
  note: z.string().max(2000).nullable().optional(),
});

const attendSchema = z.object({
  attendedAt: isoTimestampSchema.optional(),
  attendedByName: z.string().max(200).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

const releaseLegSchema = z.object({
  note: z.string().max(4000).nullable().optional(),
  releasedByName: z.string().max(200).nullable().optional(),
  reportFileId: idSchema.nullable().optional(),
  signatureFileId: idSchema.nullable().optional(),
  concessionId: idSchema.nullable().optional(),
});

const rejectLegSchema = z.object({ reason: z.string().min(1).max(4000) });

const waiveLegSchema = z.object({ reason: z.string().min(1).max(4000) });

const asLeg = (row: typeof itpActivityReleases.$inferSelect): ReleaseLegLike => ({
  id: row.id,
  position: row.position,
  party: row.party,
  required: row.required,
  userId: row.userId,
  organisation: row.organisation,
  contactName: row.contactName,
  status: row.status,
  releasedBy: row.releasedBy,
  releasedAt: row.releasedAt,
});

export const surveillanceRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);

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

  async function loadLegs(activityId: string) {
    return app.db
      .select()
      .from(itpActivityReleases)
      .where(eq(itpActivityReleases.activityId, activityId))
      .orderBy(asc(itpActivityReleases.position), asc(itpActivityReleases.createdAt));
  }

  async function refreshCounters(itpId: string) {
    const acts = await app.db
      .select()
      .from(itpActivities)
      .where(eq(itpActivities.itpId, itpId))
      .orderBy(asc(itpActivities.position));
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
  }

  async function chainView(activityId: string) {
    const rows = await loadLegs(activityId);
    return { items: rows, summary: chainSummary(rows.map(asLeg)) };
  }

  /**
   * When every required leg is signed the ACTIVITY is released, once, naming
   * the chain that released it. Doing it here rather than asking the user to
   * press a second button is the point: the release of a hold point is the
   * completion of its chain, not a separate opinion about it.
   */
  async function completeActivityIfChainDone(
    activity: typeof itpActivities.$inferSelect,
    actorId: string,
    companyId: string,
    projectId: string,
  ) {
    const rows = await loadLegs(activity.id);
    const summary = chainSummary(rows.map(asLeg));
    if (!summary.complete || isLegTerminal(activity.status) || activity.status === "released") {
      return summary;
    }
    const at = nowISO();
    const last = [...rows]
      .filter((r) => r.releasedAt)
      .sort((a, b) => (a.releasedAt! < b.releasedAt! ? 1 : -1))[0];
    await app.db
      .update(itpActivities)
      .set({
        status: "released",
        releasedBy: last?.releasedBy ?? actorId,
        releasedAt: at,
        releaseNote: `Released by the sign-off chain: ${rows
          .filter((r) => r.required === 1)
          .map((r) => `${legLabel(asLeg(r))} ${r.status}`)
          .join(", ")}.`,
        actualDate: activity.actualDate ?? todayISO(),
        updatedAt: at,
      })
      .where(eq(itpActivities.id, activity.id));
    await refreshCounters(activity.itpId);
    await ledger(app.db, {
      companyId,
      projectId,
      actorId,
      action: "state_change",
      objectType: "itp_activity",
      objectId: activity.id,
      payload: {
        from: activity.status,
        to: "released",
        via: "release_chain",
        legs: rows.map((r) => ({
          party: r.party,
          status: r.status,
          releasedBy: r.releasedBy,
          releasedAt: r.releasedAt,
        })),
      },
      storePayload: true,
    });
    return summary;
  }

  /* ---------------------------------------------------------------- */
  /* The chain                                                         */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/itps/:itpId/activities/:activityId/parties",
    { preHandler: readGate },
    async (req) => {
      const { itpId, activityId } = req.params as { itpId: string; activityId: string };
      await fetchItp(itpId, req.companyId!, req.projectId!);
      await fetchActivity(activityId, itpId, req.projectId!);
      return chainView(activityId);
    },
  );

  /**
   * Set the chain. Replacing it is refused once any leg has been signed: the
   * signatures were given against a chain, and rewriting the chain underneath
   * them would make them evidence of something that never happened.
   */
  app.put(
    "/projects/:projectId/itps/:itpId/activities/:activityId/parties",
    { preHandler: standardGate },
    async (req) => {
      const { itpId, activityId } = req.params as { itpId: string; activityId: string };
      const body = chainSchema.parse(req.body);
      await fetchItp(itpId, req.companyId!, req.projectId!);
      const activity = await fetchActivity(activityId, itpId, req.projectId!);
      const existing = await loadLegs(activityId);
      const signed = existing.filter((l) => isLegTerminal(l.status));
      if (signed.length > 0) {
        throw badRequest(
          `${signed.length} leg(s) of this point have already been signed (${signed
            .map((l) => `${l.party} ${l.status}`)
            .join(", ")}). The chain cannot be rewritten under a signature — waive the point and re-raise it if the parties have genuinely changed.`,
        );
      }
      if (existing.length > 0) {
        await app.db
          .delete(itpActivityReleases)
          .where(eq(itpActivityReleases.activityId, activityId));
      }
      const rows = body.parties.map((p, index) => ({
        id: newId("ipr"),
        companyId: req.companyId!,
        projectId: req.projectId!,
        itpId,
        activityId,
        position: (index + 1) * 10,
        party: p.party,
        required: p.required === false ? 0 : 1,
        userId: p.userId ?? null,
        vendorId: p.vendorId ?? null,
        organisation: p.organisation ?? null,
        contactName: p.contactName ?? null,
        contactEmail: p.contactEmail ?? null,
        accreditation: p.accreditation ?? null,
      }));
      await app.db.insert(itpActivityReleases).values(rows);
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "itp_activity",
        objectId: activityId,
        payload: { signOffChain: rows.map((r) => ({ party: r.party, required: r.required })) },
        storePayload: true,
      });
      void activity;
      return chainView(activityId);
    },
  );

  async function loadLegOr404(activityId: string, legId: string) {
    const rows = await app.db
      .select()
      .from(itpActivityReleases)
      .where(
        and(eq(itpActivityReleases.id, legId), eq(itpActivityReleases.activityId, activityId)),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Sign-off leg not found on this activity");
    return rows[0];
  }

  app.post(
    "/projects/:projectId/itps/:itpId/activities/:activityId/parties/:legId/notify",
    { preHandler: standardGate },
    async (req) => {
      const { itpId, activityId, legId } = req.params as {
        itpId: string;
        activityId: string;
        legId: string;
      };
      const body = notifyLegSchema.parse(req.body ?? {});
      await fetchItp(itpId, req.companyId!, req.projectId!);
      const activity = await fetchActivity(activityId, itpId, req.projectId!);
      const leg = await loadLegOr404(activityId, legId);
      if (isLegTerminal(leg.status)) {
        throw badRequest(`The ${legLabel(asLeg(leg))} leg is already ${leg.status}.`);
      }
      const at = body.notifiedAt ?? nowISO();
      await app.db
        .update(itpActivityReleases)
        .set({
          status: leg.status === "attended" ? leg.status : "notified",
          notifiedAt: at,
          notifiedBy: req.user!.id,
          detail: { ...(leg.detail as Record<string, unknown>), noticeMethod: body.method ?? null, noticeNote: body.note ?? null },
          updatedAt: nowISO(),
        })
        .where(eq(itpActivityReleases.id, legId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "itp_activity",
        objectId: activityId,
        payload: { leg: legId, party: leg.party, to: "notified", at, method: body.method ?? null },
        storePayload: true,
      });
      if (leg.userId && leg.userId !== req.user!.id) {
        await pushNotifications(app.db, [
          {
            companyId: req.companyId!,
            userId: leg.userId,
            projectId: req.projectId!,
            kind: "assignment",
            title: `${activity.interventionPoint.replace(/_/g, " ")} notice: ${activity.activity}`,
            recordType: "itp_activity",
            recordId: activityId,
          },
        ]);
      }
      return chainView(activityId);
    },
  );

  /** Attendance is recorded separately from a signature, on purpose. */
  app.post(
    "/projects/:projectId/itps/:itpId/activities/:activityId/parties/:legId/attend",
    { preHandler: standardGate },
    async (req) => {
      const { itpId, activityId, legId } = req.params as {
        itpId: string;
        activityId: string;
        legId: string;
      };
      const body = attendSchema.parse(req.body ?? {});
      await fetchItp(itpId, req.companyId!, req.projectId!);
      await fetchActivity(activityId, itpId, req.projectId!);
      const leg = await loadLegOr404(activityId, legId);
      if (isLegTerminal(leg.status)) {
        throw badRequest(`The ${legLabel(asLeg(leg))} leg is already ${leg.status}.`);
      }
      const at = body.attendedAt ?? nowISO();
      await app.db
        .update(itpActivityReleases)
        .set({
          status: "attended",
          attendedAt: at,
          attendedByName: body.attendedByName ?? null,
          detail: { ...(leg.detail as Record<string, unknown>), attendanceNote: body.note ?? null },
          updatedAt: nowISO(),
        })
        .where(eq(itpActivityReleases.id, legId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "itp_activity",
        objectId: activityId,
        payload: { leg: legId, party: leg.party, to: "attended", at },
        storePayload: true,
      });
      return chainView(activityId);
    },
  );

  app.post(
    "/projects/:projectId/itps/:itpId/activities/:activityId/parties/:legId/release",
    { preHandler: standardGate },
    async (req) => {
      const { itpId, activityId, legId } = req.params as {
        itpId: string;
        activityId: string;
        legId: string;
      };
      const body = releaseLegSchema.parse(req.body ?? {});
      const itp = await fetchItp(itpId, req.companyId!, req.projectId!);
      const activity = await fetchActivity(activityId, itpId, req.projectId!);
      const legs = await loadLegs(activityId);
      const decision = canReleaseLeg(legs.map(asLeg), legId, {
        actorId: req.user!.id,
        raisedBy: activity.notifiedBy ?? itp.createdBy,
      });
      if (!decision.allowed) {
        throw decision.code && LEG_AUTHORISATION_REFUSALS.includes(decision.code)
          ? forbidden(decision.reasons.join(" "))
          : badRequest(decision.reasons.join(" "));
      }
      const leg = legs.find((l) => l.id === legId)!;
      const at = nowISO();
      await app.db
        .update(itpActivityReleases)
        .set({
          status: "released",
          releasedBy: req.user!.id,
          releasedAt: at,
          releasedByName: body.releasedByName ?? null,
          note: body.note ?? null,
          reportFileId: body.reportFileId ?? leg.reportFileId,
          signatureFileId: body.signatureFileId ?? leg.signatureFileId,
          concessionId: body.concessionId ?? leg.concessionId,
          updatedAt: at,
        })
        .where(eq(itpActivityReleases.id, legId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "itp_activity",
        objectId: activityId,
        payload: {
          leg: legId,
          party: leg.party,
          organisation: leg.organisation,
          to: "released",
          releasedBy: req.user!.id,
          at,
          reportFileId: body.reportFileId ?? leg.reportFileId,
          concessionId: body.concessionId ?? leg.concessionId,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      const summary = await completeActivityIfChainDone(
        activity,
        req.user!.id,
        req.companyId!,
        req.projectId!,
      );
      const view = await chainView(activityId);
      return { ...view, activityReleased: summary.complete };
    },
  );

  /** A refusal to certify. It fails the activity rather than delaying it. */
  app.post(
    "/projects/:projectId/itps/:itpId/activities/:activityId/parties/:legId/reject",
    { preHandler: standardGate },
    async (req) => {
      const { itpId, activityId, legId } = req.params as {
        itpId: string;
        activityId: string;
        legId: string;
      };
      const body = rejectLegSchema.parse(req.body);
      const itp = await fetchItp(itpId, req.companyId!, req.projectId!);
      const activity = await fetchActivity(activityId, itpId, req.projectId!);
      const legs = await loadLegs(activityId);
      const decision = canReleaseLeg(legs.map(asLeg), legId, {
        actorId: req.user!.id,
        raisedBy: activity.notifiedBy ?? itp.createdBy,
        enforceSequence: false,
      });
      if (!decision.allowed) {
        throw decision.code && LEG_AUTHORISATION_REFUSALS.includes(decision.code)
          ? forbidden(decision.reasons.join(" "))
          : badRequest(decision.reasons.join(" "));
      }
      const leg = legs.find((l) => l.id === legId)!;
      const at = nowISO();
      await app.db
        .update(itpActivityReleases)
        .set({
          status: "rejected",
          releasedBy: req.user!.id,
          releasedAt: at,
          note: body.reason,
          updatedAt: at,
        })
        .where(eq(itpActivityReleases.id, legId));
      if (!isLegTerminal(activity.status)) {
        await app.db
          .update(itpActivities)
          .set({ status: "failed", updatedAt: at })
          .where(eq(itpActivities.id, activityId));
        await refreshCounters(itpId);
      }
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "itp_activity",
        objectId: activityId,
        payload: {
          leg: legId,
          party: leg.party,
          to: "rejected",
          reason: body.reason,
          activityStatus: isLegTerminal(activity.status) ? activity.status : "failed",
        },
        storePayload: true,
      });
      return chainView(activityId);
    },
  );

  /**
   * Waive one leg. A waived leg is a different fact from a signed one and only
   * survives a challenge if the reason was written at the time, so the reason
   * is required here exactly as it is on the activity-level waiver.
   */
  app.post(
    "/projects/:projectId/itps/:itpId/activities/:activityId/parties/:legId/waive",
    { preHandler: standardGate },
    async (req) => {
      const { itpId, activityId, legId } = req.params as {
        itpId: string;
        activityId: string;
        legId: string;
      };
      const body = waiveLegSchema.parse(req.body);
      await fetchItp(itpId, req.companyId!, req.projectId!);
      const activity = await fetchActivity(activityId, itpId, req.projectId!);
      const leg = await loadLegOr404(activityId, legId);
      if (isLegTerminal(leg.status)) {
        throw badRequest(`The ${legLabel(asLeg(leg))} leg is already ${leg.status}.`);
      }
      const at = nowISO();
      await app.db
        .update(itpActivityReleases)
        .set({
          status: "waived",
          releasedBy: req.user!.id,
          releasedAt: at,
          note: body.reason,
          updatedAt: at,
        })
        .where(eq(itpActivityReleases.id, legId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "itp_activity",
        objectId: activityId,
        payload: { leg: legId, party: leg.party, to: "waived", reason: body.reason },
        storePayload: true,
      });
      const summary = await completeActivityIfChainDone(
        activity,
        req.user!.id,
        req.companyId!,
        req.projectId!,
      );
      const view = await chainView(activityId);
      return { ...view, activityReleased: summary.complete };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Third-party surveillance register                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Every leg on the project awaiting a third party — the list a surveillance
   * co-ordinator works from, because the joints waiting for a notified body
   * are the ones that stop the programme.
   */
  app.get("/projects/:projectId/surveillance", { preHandler: readGate }, async (req) => {
    const query = pageQuerySchema
      .extend({
        party: z.enum(ITP_RESPONSIBLE_PARTIES).optional(),
        openOnly: z.coerce.boolean().optional(),
      })
      .parse(req.query ?? {});
    const clauses = [
      eq(itpActivityReleases.companyId, req.companyId!),
      eq(itpActivityReleases.projectId, req.projectId!),
    ];
    if (query.party) clauses.push(eq(itpActivityReleases.party, query.party));
    else {
      clauses.push(
        inArray(itpActivityReleases.party, ["third_party", "regulator", "certifying_authority", "client"]),
      );
    }
    if (query.openOnly) {
      clauses.push(inArray(itpActivityReleases.status, ["pending", "notified", "attended"]));
      /*
       * A LEG ON A POINT THAT IS OVER IS NOT OUTSTANDING.
       *
       * The register is the list a surveillance co-ordinator chases, and it
       * judged only the leg. A point that was waived, failed, marked not
       * applicable or closed leaves its unsigned legs sitting at `pending` for
       * ever — nothing reconciles them, because the decision was taken about
       * the point rather than about the leg — so the co-ordinator was being
       * sent to chase a notified body for an inspection nobody is going to
       * hold. Those legs still exist and are still readable without
       * `openOnly`; they are simply not outstanding work.
       */
      clauses.push(notInArray(itpActivities.status, [...TERMINAL_ACTIVITY_STATUSES]));
    }
    /*
     * PAGINATED, AND THE TOTAL IS THE REAL TOTAL.
     *
     * This used to take 500 rows with no offset and report `rows.length` as
     * the total, so a project with 900 outstanding legs told its surveillance
     * co-ordinator there were 500 — and the 400 it dropped were the ones
     * nobody would then chase. The counts below are computed over the same
     * where clause as the page, not over the page.
     */
    const where = and(...clauses);
    const joined = () =>
      app.db
        .select({ n: count() })
        .from(itpActivityReleases)
        .innerJoin(itpActivities, eq(itpActivities.id, itpActivityReleases.activityId));
    const [totalRow] = await joined().where(where);
    const [awaitingRow] = await joined().where(
      and(
        where,
        inArray(itpActivityReleases.status, ["pending", "notified", "attended"]),
        isNull(itpActivityReleases.attendedAt),
      ),
    );
    const [notifiedRow] = await joined().where(
      and(
        where,
        inArray(itpActivityReleases.status, ["pending", "notified", "attended"]),
        isNotNull(itpActivityReleases.notifiedAt),
      ),
    );
    const rows = await app.db
      .select({ leg: itpActivityReleases, activity: itpActivities })
      .from(itpActivityReleases)
      .innerJoin(itpActivities, eq(itpActivities.id, itpActivityReleases.activityId))
      .where(where)
      .orderBy(asc(itpActivityReleases.createdAt))
      .limit(query.pageSize)
      .offset(pageOffset(query));
    const items = rows.map((r) => ({
      ...r.leg,
      activity: {
        id: r.activity.id,
        activity: r.activity.activity,
        activityCode: r.activity.activityCode,
        interventionPoint: r.activity.interventionPoint,
        plannedDate: r.activity.plannedDate,
        status: r.activity.status,
        itpId: r.activity.itpId,
      },
    }));
    return {
      ...paginate(items, Number(totalRow?.n ?? 0), query),
      awaitingAttendance: Number(awaitingRow?.n ?? 0),
      notifiedAwaitingSignature: Number(notifiedRow?.n ?? 0),
    };
  });
};
