/**
 * DESIGN REVIEW CYCLES, REVIEWERS AND COMMENTS
 * (spec Vol I #249; Vol II T #897–#900).
 *
 * A review cycle is one issue of a package out for comment. The rules that
 * make the record defensible rather than decorative:
 *
 *  - The cycle's code is NEVER typed. It is consolidated from what the
 *    reviewers returned (worst wins) by the engine, with its basis recorded.
 *  - A reviewer returns their own code. Nobody returns on another's behalf.
 *  - The person who raised a comment may not answer it, and only the raiser
 *    (or an admin) closes it: a designer cannot mark their own answer
 *    accepted.
 *  - A C or D cycle opens the resubmission with the cycle number incremented,
 *    which is what makes the rework multiple (#900) a measured figure.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  designComments,
  designIssues,
  designPackages,
  designReviewParticipants,
  designReviews,
} from "@constructos/db";
import {
  DESIGN_COMMENT_CATEGORIES,
  DESIGN_COMMENT_STATUSES,
  DESIGN_DISCIPLINES,
  DESIGN_ISSUE_PRIORITIES,
  DESIGN_REVIEW_CODES,
  DESIGN_REVIEW_STATUSES,
} from "@constructos/shared";
import { badRequest, conflict, forbidden, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { pushNotifications } from "../../notifications/service.js";
import { CODE_MEANING, checkClose, consolidate, requiresResubmission } from "../engines/review.js";
import {
  allocateReference,
  assertBimModel,
  assertDrawingSheet,
  assertSpecSection,
  assertUser,
  assertVendor,
  buildGates,
  idSchema,
  isoTimestampSchema,
  ledger,
  nowISO,
  patchSchemaOf,
  patchSet,
} from "../shared.js";

const reviewBodySchema = z.object({
  packageId: idSchema,
  title: z.string().min(1).max(200),
  revision: z.string().max(20).nullable().optional(),
  issuedAt: isoTimestampSchema.optional(),
  dueAt: isoTimestampSchema.nullable().optional(),
  previousReviewId: idSchema.nullable().optional(),
  notes: z.string().max(8000).nullable().optional(),
});

const reviewPatchSchema = patchSchemaOf(reviewBodySchema.omit({ packageId: true, previousReviewId: true }));

const participantBodySchema = z
  .object({
    userId: idSchema.nullable().optional(),
    vendorId: idSchema.nullable().optional(),
    displayName: z.string().max(160).nullable().optional(),
    discipline: z.enum(DESIGN_DISCIPLINES).default("multi_discipline"),
    isRequired: z.boolean().default(true),
    dueAt: isoTimestampSchema.nullable().optional(),
  })
  .refine((v) => Boolean(v.userId || v.vendorId || v.displayName), {
    message: "A reviewer needs a userId, a vendorId or a displayName.",
  });

const commentBodySchema = z.object({
  body: z.string().min(1).max(8000),
  category: z.enum(DESIGN_COMMENT_CATEGORIES).default("other"),
  priority: z.enum(DESIGN_ISSUE_PRIORITIES).default("medium"),
  discipline: z.enum(DESIGN_DISCIPLINES).default("multi_discipline"),
  code: z.enum(DESIGN_REVIEW_CODES).nullable().optional(),
  locationRef: z.string().max(160).nullable().optional(),
  drawingSheetId: idSchema.nullable().optional(),
  specSectionId: idSchema.nullable().optional(),
  bimModelId: idSchema.nullable().optional(),
});

export const reviewRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate, adminGate } = buildGates(app);

  async function loadReview(companyId: string, projectId: string, id: string) {
    const [row] = await app.db
      .select()
      .from(designReviews)
      .where(
        and(eq(designReviews.id, id), eq(designReviews.companyId, companyId), eq(designReviews.projectId, projectId)),
      )
      .limit(1);
    if (!row) throw notFound("Design review not found");
    return row;
  }

  async function participantsOf(reviewId: string) {
    return app.db
      .select()
      .from(designReviewParticipants)
      .where(eq(designReviewParticipants.reviewId, reviewId))
      .orderBy(asc(designReviewParticipants.createdAt));
  }

  async function refreshCounters(reviewId: string) {
    const [participants, comments] = await Promise.all([
      participantsOf(reviewId),
      app.db.select({ status: designComments.status }).from(designComments).where(eq(designComments.reviewId, reviewId)),
    ]);
    await app.db
      .update(designReviews)
      .set({
        reviewerCount: participants.filter((p) => p.status !== "declined").length,
        returnedCount: participants.filter((p) => p.status === "returned").length,
        commentCount: comments.length,
        openCommentCount: comments.filter((c) => c.status === "open" || c.status === "responded").length,
        updatedAt: nowISO(),
      })
      .where(eq(designReviews.id, reviewId));
  }

  async function refreshPackageCounters(packageId: string) {
    const [reviews, comments, issues] = await Promise.all([
      app.db.select({ n: count() }).from(designReviews).where(eq(designReviews.packageId, packageId)),
      app.db
        .select({ n: count() })
        .from(designComments)
        .where(and(eq(designComments.packageId, packageId), inArray(designComments.status, ["open", "responded"]))),
      app.db
        .select({ n: count() })
        .from(designIssues)
        .where(and(eq(designIssues.packageId, packageId), inArray(designIssues.status, ["open", "assigned", "in_progress"]))),
    ]);
    await app.db
      .update(designPackages)
      .set({
        reviewCount: reviews[0]?.n ?? 0,
        openCommentCount: comments[0]?.n ?? 0,
        openIssueCount: issues[0]?.n ?? 0,
        updatedAt: nowISO(),
      })
      .where(eq(designPackages.id, packageId));
  }

  /* ---------------------------------------------------------------- */
  /* Cycles                                                           */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/design/reviews", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({
        status: z.enum(DESIGN_REVIEW_STATUSES).optional(),
        packageId: idSchema.optional(),
        code: z.enum(DESIGN_REVIEW_CODES).optional(),
        open: z.coerce.boolean().optional(),
      })
      .parse(req.query);
    const where = and(
      eq(designReviews.companyId, req.companyId!),
      eq(designReviews.projectId, projectId),
      q.status ? eq(designReviews.status, q.status) : undefined,
      q.packageId ? eq(designReviews.packageId, q.packageId) : undefined,
      q.code ? eq(designReviews.consolidatedCode, q.code) : undefined,
      q.open ? inArray(designReviews.status, ["open", "in_review", "consolidating"]) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db
        .select()
        .from(designReviews)
        .where(where)
        .orderBy(desc(designReviews.createdAt))
        .limit(q.pageSize)
        .offset(pageOffset(q)),
      app.db.select({ n: count() }).from(designReviews).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post("/projects/:projectId/design/reviews", { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = reviewBodySchema.parse(req.body);
    const companyId = req.companyId!;
    const [pkg] = await app.db
      .select()
      .from(designPackages)
      .where(
        and(
          eq(designPackages.id, body.packageId),
          eq(designPackages.companyId, companyId),
          eq(designPackages.projectId, projectId),
        ),
      )
      .limit(1);
    if (!pkg) throw badRequest(`Design package ${body.packageId} not found in this project.`);

    let cycleNumber = 1;
    if (body.previousReviewId) {
      const previous = await loadReview(companyId, projectId, body.previousReviewId);
      if (previous.packageId !== body.packageId) {
        throw badRequest("A resubmission must belong to the same design package as the cycle it follows.");
      }
      if (previous.status !== "closed") {
        throw conflict("Close the previous review cycle before opening the resubmission.");
      }
      cycleNumber = previous.cycleNumber + 1;
    } else {
      const [openCycle] = await app.db
        .select({ id: designReviews.id, reference: designReviews.reference })
        .from(designReviews)
        .where(
          and(
            eq(designReviews.packageId, body.packageId),
            inArray(designReviews.status, ["open", "in_review", "consolidating"]),
          ),
        )
        .limit(1);
      if (openCycle) {
        throw conflict(
          `${openCycle.reference} is still open on this package. Close it, or open the resubmission with previousReviewId so the cycle count stays true.`,
        );
      }
      const [last] = await app.db
        .select({ cycleNumber: designReviews.cycleNumber })
        .from(designReviews)
        .where(eq(designReviews.packageId, body.packageId))
        .orderBy(desc(designReviews.cycleNumber))
        .limit(1);
      cycleNumber = (last?.cycleNumber ?? 0) + 1;
    }

    const { number, reference } = await allocateReference(app.db, projectId, "design_review", "DR");
    const id = newId("drv");
    const [inserted] = await app.db
      .insert(designReviews)
      .values({
        id,
        companyId,
        projectId,
        packageId: body.packageId,
        number,
        reference,
        title: body.title,
        revision: body.revision ?? pkg.revision ?? null,
        cycleNumber,
        previousReviewId: body.previousReviewId ?? null,
        issuedAt: body.issuedAt ?? nowISO(),
        dueAt: body.dueAt ?? null,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    if (pkg.status === "planned" || pkg.status === "in_progress") {
      await app.db
        .update(designPackages)
        .set({ status: "in_review", updatedAt: nowISO() })
        .where(eq(designPackages.id, body.packageId));
    }
    await refreshPackageCounters(body.packageId);
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "design_review",
      objectId: id,
      payload: { reference, packageId: body.packageId, cycleNumber, dueAt: body.dueAt ?? null },
    });
    return reply.code(201).send(inserted);
  });

  app.get("/projects/:projectId/design/reviews/:reviewId", { preHandler: readGate }, async (req) => {
    const { projectId, reviewId } = req.params as { projectId: string; reviewId: string };
    const companyId = req.companyId!;
    const row = await loadReview(companyId, projectId, reviewId);
    const [participants, comments, pkg] = await Promise.all([
      participantsOf(reviewId),
      app.db
        .select()
        .from(designComments)
        .where(eq(designComments.reviewId, reviewId))
        .orderBy(asc(designComments.sequence)),
      app.db.select().from(designPackages).where(eq(designPackages.id, row.packageId)).limit(1),
    ]);
    const consolidation = consolidate(
      participants.map((p) => ({
        id: p.id,
        isRequired: p.isRequired === 1,
        status: p.status,
        returnedCode: p.returnedCode,
        displayName: p.displayName,
        discipline: p.discipline,
      })),
    );
    return {
      ...row,
      package: pkg[0] ?? null,
      participants,
      comments,
      consolidation,
      codeMeaning: CODE_MEANING,
      canClose: checkClose(
        participants.map((p) => ({
          id: p.id,
          isRequired: p.isRequired === 1,
          status: p.status,
          returnedCode: p.returnedCode,
          displayName: p.displayName,
          discipline: p.discipline,
        })),
      ),
    };
  });

  app.patch("/projects/:projectId/design/reviews/:reviewId", { preHandler: standardGate }, async (req) => {
    const { projectId, reviewId } = req.params as { projectId: string; reviewId: string };
    const body = reviewPatchSchema.parse(req.body);
    const companyId = req.companyId!;
    const row = await loadReview(companyId, projectId, reviewId);
    if (row.status === "closed") {
      throw conflict("A closed review cycle is a record of what was returned; open a resubmission instead of editing it.");
    }
    const set = patchSet(body as Record<string, unknown>, ["title", "revision", "issuedAt", "dueAt", "notes"]);
    const [updated] = await app.db.update(designReviews).set(set).where(eq(designReviews.id, reviewId)).returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "design_review",
      objectId: reviewId,
      payload: { keys: Object.keys(set).filter((k) => k !== "updatedAt") },
    });
    return updated;
  });

  /* ---------------------------------------------------------------- */
  /* Reviewers                                                        */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/design/reviews/:reviewId/reviewers", { preHandler: standardGate }, async (req, reply) => {
    const { projectId, reviewId } = req.params as { projectId: string; reviewId: string };
    const body = participantBodySchema.parse(req.body);
    const companyId = req.companyId!;
    const review = await loadReview(companyId, projectId, reviewId);
    if (review.status === "closed" || review.status === "cancelled") {
      throw conflict("Reviewers cannot be added to a closed cycle.");
    }
    if (body.userId) await assertUser(app.db, body.userId);
    if (body.vendorId) await assertVendor(app.db, companyId, body.vendorId);
    if (body.userId) {
      const [existing] = await app.db
        .select({ id: designReviewParticipants.id })
        .from(designReviewParticipants)
        .where(
          and(eq(designReviewParticipants.reviewId, reviewId), eq(designReviewParticipants.userId, body.userId)),
        )
        .limit(1);
      if (existing) throw conflict("That reviewer is already on this cycle.");
    }
    const id = newId("drp");
    const [inserted] = await app.db
      .insert(designReviewParticipants)
      .values({
        id,
        companyId,
        projectId,
        reviewId,
        userId: body.userId ?? null,
        vendorId: body.vendorId ?? null,
        displayName: body.displayName ?? null,
        discipline: body.discipline,
        isRequired: body.isRequired ? 1 : 0,
        dueAt: body.dueAt ?? review.dueAt,
        createdBy: req.user!.id,
      })
      .returning();
    await refreshCounters(reviewId);
    if (body.userId) {
      await pushNotifications(app.db, [
        {
          companyId,
          userId: body.userId,
          projectId,
          kind: "assignment",
          title: `You are a reviewer on ${review.reference}`,
          body: `${review.title}${review.dueAt ? ` — due ${review.dueAt.slice(0, 10)}` : ""}.`,
          recordType: "design_review",
          recordId: reviewId,
        },
      ]);
    }
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "design_review_participant",
      objectId: id,
      payload: { reviewId, userId: body.userId ?? null, vendorId: body.vendorId ?? null, isRequired: body.isRequired },
    });
    return reply.code(201).send(inserted);
  });

  /**
   * A reviewer returns their own code. An administrator may return on behalf
   * of an external reviewer who has no account (`displayName` only) — never
   * on behalf of a named platform user, because that would put one person's
   * professional opinion under another person's login.
   */
  app.post(
    "/projects/:projectId/design/reviews/:reviewId/reviewers/:participantId/return",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, reviewId, participantId } = req.params as {
        projectId: string;
        reviewId: string;
        participantId: string;
      };
      const body = z
        .object({
          code: z.enum(DESIGN_REVIEW_CODES),
          summary: z.string().max(8000).nullable().optional(),
          comments: z.array(commentBodySchema).max(200).default([]),
        })
        .parse(req.body);
      const companyId = req.companyId!;
      const review = await loadReview(companyId, projectId, reviewId);
      if (review.status === "closed" || review.status === "cancelled") {
        throw conflict("This review cycle is closed; a code can no longer be returned against it.");
      }
      const [participant] = await app.db
        .select()
        .from(designReviewParticipants)
        .where(
          and(
            eq(designReviewParticipants.id, participantId),
            eq(designReviewParticipants.reviewId, reviewId),
            eq(designReviewParticipants.projectId, projectId),
          ),
        )
        .limit(1);
      if (!participant) throw notFound("Reviewer not found on this cycle");
      if (participant.status === "returned") throw conflict("This reviewer has already returned a code.");
      if (participant.userId && participant.userId !== req.user!.id) {
        throw forbidden(
          "A review code is a professional opinion: only the named reviewer may return it. Add yourself as a reviewer if you are the one reviewing.",
        );
      }

      const now = nowISO();
      await app.db
        .update(designReviewParticipants)
        .set({
          status: "returned",
          returnedCode: body.code,
          returnedAt: now,
          returnedBy: req.user!.id,
          summary: body.summary ?? null,
          updatedAt: now,
        })
        .where(eq(designReviewParticipants.id, participantId));

      const [lastComment] = await app.db
        .select({ sequence: designComments.sequence })
        .from(designComments)
        .where(eq(designComments.reviewId, reviewId))
        .orderBy(desc(designComments.sequence))
        .limit(1);
      let sequence = lastComment?.sequence ?? 0;
      const createdCommentIds: string[] = [];
      for (const comment of body.comments) {
        if (comment.drawingSheetId) await assertDrawingSheet(app.db, projectId, comment.drawingSheetId);
        if (comment.specSectionId) await assertSpecSection(app.db, projectId, comment.specSectionId);
        if (comment.bimModelId) await assertBimModel(app.db, projectId, comment.bimModelId);
        sequence += 1;
        const commentId = newId("dcm");
        await app.db.insert(designComments).values({
          id: commentId,
          companyId,
          projectId,
          reviewId,
          packageId: review.packageId,
          participantId,
          sequence,
          category: comment.category,
          priority: comment.priority,
          discipline: comment.discipline,
          body: comment.body,
          locationRef: comment.locationRef ?? null,
          drawingSheetId: comment.drawingSheetId ?? null,
          specSectionId: comment.specSectionId ?? null,
          bimModelId: comment.bimModelId ?? null,
          code: comment.code ?? body.code,
          raisedBy: req.user!.id,
        });
        createdCommentIds.push(commentId);
      }

      if (review.status === "open") {
        await app.db.update(designReviews).set({ status: "in_review", updatedAt: now }).where(eq(designReviews.id, reviewId));
      }
      await refreshCounters(reviewId);
      await refreshPackageCounters(review.packageId);
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "design_review_participant",
        objectId: participantId,
        payload: { reviewId, code: body.code, comments: createdCommentIds.length },
      });

      const participants = await participantsOf(reviewId);
      return {
        participantId,
        code: body.code,
        commentIds: createdCommentIds,
        consolidation: consolidate(
          participants.map((p) => ({
            id: p.id,
            isRequired: p.isRequired === 1,
            status: p.status,
            returnedCode: p.returnedCode,
            displayName: p.displayName,
            discipline: p.discipline,
          })),
        ),
      };
    },
  );

  app.post(
    "/projects/:projectId/design/reviews/:reviewId/reviewers/:participantId/decline",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, reviewId, participantId } = req.params as {
        projectId: string;
        reviewId: string;
        participantId: string;
      };
      const body = z.object({ reason: z.string().min(1).max(2000) }).parse(req.body);
      const companyId = req.companyId!;
      await loadReview(companyId, projectId, reviewId);
      const [participant] = await app.db
        .select()
        .from(designReviewParticipants)
        .where(
          and(eq(designReviewParticipants.id, participantId), eq(designReviewParticipants.reviewId, reviewId), eq(designReviewParticipants.projectId, projectId)),
        )
        .limit(1);
      if (!participant) throw notFound("Reviewer not found on this cycle");
      if (participant.status === "returned") throw conflict("This reviewer has already returned a code.");
      const [updated] = await app.db
        .update(designReviewParticipants)
        .set({ status: "declined", declineReason: body.reason, updatedAt: nowISO() })
        .where(eq(designReviewParticipants.id, participantId))
        .returning();
      await refreshCounters(reviewId);
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "design_review_participant",
        objectId: participantId,
        payload: { reviewId, to: "declined", reason: body.reason },
      });
      return updated;
    },
  );

  /* ---------------------------------------------------------------- */
  /* Close                                                            */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/design/reviews/:reviewId/close", { preHandler: standardGate }, async (req) => {
    const { projectId, reviewId } = req.params as { projectId: string; reviewId: string };
    const body = z.object({ force: z.boolean().default(false), note: z.string().max(4000).optional() }).parse(req.body ?? {});
    const companyId = req.companyId!;
    const review = await loadReview(companyId, projectId, reviewId);
    if (review.status === "closed") throw conflict("This review cycle is already closed.");
    if (review.status === "cancelled") throw conflict("This review cycle was cancelled.");

    const participants = await participantsOf(reviewId);
    const check = checkClose(
      participants.map((p) => ({
        id: p.id,
        isRequired: p.isRequired === 1,
        status: p.status,
        returnedCode: p.returnedCode,
        displayName: p.displayName,
        discipline: p.discipline,
      })),
      { force: body.force },
    );
    if (!check.canClose) {
      throw badRequest(`This cycle cannot be consolidated yet. ${check.blockers.join(" ")}`, {
        blockers: check.blockers,
      });
    }

    const now = nowISO();
    const issued = review.issuedAt ? Date.parse(review.issuedAt) : NaN;
    const turnaroundDays = Number.isNaN(issued) ? null : Math.round(((Date.parse(now) - issued) / 86_400_000) * 10) / 10;
    const [updated] = await app.db
      .update(designReviews)
      .set({
        status: "closed",
        closedAt: now,
        closedBy: req.user!.id,
        consolidatedCode: check.consolidation.code,
        consolidationBasis: `${check.consolidation.basis}${body.force ? " Closed with required reviewers outstanding." : ""}`,
        turnaroundDays,
        updatedAt: now,
      })
      .where(eq(designReviews.id, reviewId))
      .returning();

    // The package follows the outcome: accepted codes move it on; C/D send it
    // back to the designer, because a rejected package is not "in review".
    const code = check.consolidation.code;
    if (code === "A" || code === "B") {
      await app.db
        .update(designPackages)
        .set({ status: "in_review", updatedAt: now })
        .where(and(eq(designPackages.id, review.packageId), eq(designPackages.status, "in_progress")));
    } else if (requiresResubmission(code)) {
      await app.db
        .update(designPackages)
        .set({ status: "in_progress", updatedAt: now })
        .where(and(eq(designPackages.id, review.packageId), eq(designPackages.status, "in_review")));
    }
    await refreshPackageCounters(review.packageId);
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_review",
      objectId: reviewId,
      payload: {
        to: "closed",
        consolidatedCode: code,
        basis: check.consolidation.basis,
        forced: body.force,
        turnaroundDays,
      },
    });
    if (review.createdBy && review.createdBy !== req.user!.id) {
      await pushNotifications(app.db, [
        {
          companyId,
          userId: review.createdBy,
          projectId,
          kind: "design",
          title: `${review.reference} returned code ${code ?? "—"}`,
          body: code ? CODE_MEANING[code] : "The cycle closed without a code.",
          recordType: "design_review",
          recordId: reviewId,
        },
      ]);
    }
    return { ...updated, consolidation: check.consolidation, requiresResubmission: requiresResubmission(code) };
  });

  app.post("/projects/:projectId/design/reviews/:reviewId/cancel", { preHandler: adminGate }, async (req) => {
    const { projectId, reviewId } = req.params as { projectId: string; reviewId: string };
    const body = z.object({ reason: z.string().min(1).max(4000) }).parse(req.body);
    const companyId = req.companyId!;
    const review = await loadReview(companyId, projectId, reviewId);
    if (review.status === "closed") throw conflict("A closed cycle cannot be cancelled.");
    const [updated] = await app.db
      .update(designReviews)
      .set({ status: "cancelled", closedAt: nowISO(), closedBy: req.user!.id, notes: body.reason, updatedAt: nowISO() })
      .where(eq(designReviews.id, reviewId))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_review",
      objectId: reviewId,
      payload: { to: "cancelled", reason: body.reason },
    });
    return updated;
  });

  /* ---------------------------------------------------------------- */
  /* Comments                                                         */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/design/comments", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({
        reviewId: idSchema.optional(),
        packageId: idSchema.optional(),
        status: z.enum(DESIGN_COMMENT_STATUSES).optional(),
        category: z.enum(DESIGN_COMMENT_CATEGORIES).optional(),
        discipline: z.enum(DESIGN_DISCIPLINES).optional(),
        open: z.coerce.boolean().optional(),
      })
      .parse(req.query);
    const where = and(
      eq(designComments.companyId, req.companyId!),
      eq(designComments.projectId, projectId),
      q.reviewId ? eq(designComments.reviewId, q.reviewId) : undefined,
      q.packageId ? eq(designComments.packageId, q.packageId) : undefined,
      q.status ? eq(designComments.status, q.status) : undefined,
      q.category ? eq(designComments.category, q.category) : undefined,
      q.discipline ? eq(designComments.discipline, q.discipline) : undefined,
      q.open ? inArray(designComments.status, ["open", "responded"]) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db
        .select()
        .from(designComments)
        .where(where)
        .orderBy(desc(designComments.createdAt))
        .limit(q.pageSize)
        .offset(pageOffset(q)),
      app.db.select({ n: count() }).from(designComments).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post("/projects/:projectId/design/reviews/:reviewId/comments", { preHandler: standardGate }, async (req, reply) => {
    const { projectId, reviewId } = req.params as { projectId: string; reviewId: string };
    const body = commentBodySchema.parse(req.body);
    const companyId = req.companyId!;
    const review = await loadReview(companyId, projectId, reviewId);
    if (review.status === "closed" || review.status === "cancelled") {
      throw conflict("Comments belong to a live cycle. Raise a design issue against the package instead.");
    }
    if (body.drawingSheetId) await assertDrawingSheet(app.db, projectId, body.drawingSheetId);
    if (body.specSectionId) await assertSpecSection(app.db, projectId, body.specSectionId);
    if (body.bimModelId) await assertBimModel(app.db, projectId, body.bimModelId);
    const [last] = await app.db
      .select({ sequence: designComments.sequence })
      .from(designComments)
      .where(eq(designComments.reviewId, reviewId))
      .orderBy(desc(designComments.sequence))
      .limit(1);
    const [participant] = await app.db
      .select({ id: designReviewParticipants.id })
      .from(designReviewParticipants)
      .where(
        and(eq(designReviewParticipants.reviewId, reviewId), eq(designReviewParticipants.userId, req.user!.id)),
      )
      .limit(1);
    const id = newId("dcm");
    const [inserted] = await app.db
      .insert(designComments)
      .values({
        id,
        companyId,
        projectId,
        reviewId,
        packageId: review.packageId,
        participantId: participant?.id ?? null,
        sequence: (last?.sequence ?? 0) + 1,
        category: body.category,
        priority: body.priority,
        discipline: body.discipline,
        body: body.body,
        locationRef: body.locationRef ?? null,
        drawingSheetId: body.drawingSheetId ?? null,
        specSectionId: body.specSectionId ?? null,
        bimModelId: body.bimModelId ?? null,
        code: body.code ?? null,
        raisedBy: req.user!.id,
      })
      .returning();
    await refreshCounters(reviewId);
    await refreshPackageCounters(review.packageId);
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "design_comment",
      objectId: id,
      payload: { reviewId, category: body.category, priority: body.priority },
    });
    return reply.code(201).send(inserted);
  });

  async function loadComment(companyId: string, projectId: string, commentId: string) {
    const [row] = await app.db
      .select()
      .from(designComments)
      .where(
        and(eq(designComments.id, commentId), eq(designComments.companyId, companyId), eq(designComments.projectId, projectId)),
      )
      .limit(1);
    if (!row) throw notFound("Design comment not found");
    return row;
  }

  /** The designer's answer. Never the person who raised it. */
  app.post("/projects/:projectId/design/comments/:commentId/respond", { preHandler: standardGate }, async (req) => {
    const { projectId, commentId } = req.params as { projectId: string; commentId: string };
    const body = z.object({ response: z.string().min(1).max(8000) }).parse(req.body);
    const companyId = req.companyId!;
    const row = await loadComment(companyId, projectId, commentId);
    if (row.status === "closed" || row.status === "withdrawn") {
      throw conflict(`This comment is ${row.status}.`);
    }
    if (row.raisedBy === req.user!.id) {
      throw forbidden(
        "The person who raised a comment cannot answer it. A review comment answered by its own author is not a review.",
      );
    }
    const [updated] = await app.db
      .update(designComments)
      .set({
        response: body.response,
        respondedBy: req.user!.id,
        respondedAt: nowISO(),
        status: "responded",
        updatedAt: nowISO(),
      })
      .where(eq(designComments.id, commentId))
      .returning();
    await refreshCounters(row.reviewId);
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_comment",
      objectId: commentId,
      payload: { to: "responded" },
    });
    await pushNotifications(app.db, [
      {
        companyId,
        userId: row.raisedBy,
        projectId,
        kind: "design",
        title: "Your design review comment has been answered",
        body: body.response.slice(0, 240),
        recordType: "design_comment",
        recordId: commentId,
      },
    ]);
    return updated;
  });

  /** Only the raiser closes their comment: acceptance belongs to the reviewer. */
  app.post("/projects/:projectId/design/comments/:commentId/close", { preHandler: standardGate }, async (req) => {
    const { projectId, commentId } = req.params as { projectId: string; commentId: string };
    const body = z
      .object({ note: z.string().max(4000).optional(), status: z.enum(["closed", "withdrawn"]).default("closed") })
      .parse(req.body ?? {});
    const companyId = req.companyId!;
    const row = await loadComment(companyId, projectId, commentId);
    if (row.status === "closed" || row.status === "withdrawn") throw conflict(`This comment is already ${row.status}.`);
    if (row.raisedBy !== req.user!.id) {
      throw forbidden(
        "Only the reviewer who raised a comment may close it. Otherwise a designer could mark their own answer accepted.",
      );
    }
    if (body.status === "closed" && row.status !== "responded") {
      throw badRequest("A comment is closed once it has been answered. Withdraw it instead if it should not have been raised.");
    }
    const [updated] = await app.db
      .update(designComments)
      .set({ status: body.status, closedBy: req.user!.id, closedAt: nowISO(), closeNote: body.note ?? null, updatedAt: nowISO() })
      .where(eq(designComments.id, commentId))
      .returning();
    await refreshCounters(row.reviewId);
    await refreshPackageCounters(row.packageId);
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_comment",
      objectId: commentId,
      payload: { to: body.status, note: body.note ?? null },
    });
    return updated;
  });

  /** Escalate a comment the designer cannot resolve into the issue register. */
  app.post("/projects/:projectId/design/comments/:commentId/escalate", { preHandler: standardGate }, async (req, reply) => {
    const { projectId, commentId } = req.params as { projectId: string; commentId: string };
    const body = z
      .object({
        title: z.string().max(200).optional(),
        issueType: z.string().max(40).optional(),
        assignedToUserId: idSchema.nullable().optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      })
      .parse(req.body ?? {});
    const companyId = req.companyId!;
    const row = await loadComment(companyId, projectId, commentId);
    if (row.issueId) throw conflict("This comment has already been escalated to the issue register.");
    if (body.assignedToUserId) await assertUser(app.db, body.assignedToUserId);
    const { number, reference } = await allocateReference(app.db, projectId, "design_issue", "DI");
    const id = newId("dis");
    const [issue] = await app.db
      .insert(designIssues)
      .values({
        id,
        companyId,
        projectId,
        number,
        reference,
        title: body.title ?? row.body.slice(0, 160),
        description: row.body,
        issueType: "coordination",
        priority: row.priority,
        discipline: row.discipline,
        packageId: row.packageId,
        reviewId: row.reviewId,
        commentId: row.id,
        assignedToUserId: body.assignedToUserId ?? null,
        assignedAt: body.assignedToUserId ? nowISO() : null,
        status: body.assignedToUserId ? "assigned" : "open",
        dueDate: body.dueDate ?? null,
        drawingSheetId: row.drawingSheetId,
        specSectionId: row.specSectionId,
        bimModelId: row.bimModelId,
        locationRef: row.locationRef,
        raisedBy: req.user!.id,
      })
      .returning();
    await app.db.update(designComments).set({ issueId: id, updatedAt: nowISO() }).where(eq(designComments.id, commentId));
    await refreshPackageCounters(row.packageId);
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "design_issue",
      objectId: id,
      payload: { reference, fromCommentId: commentId, reviewId: row.reviewId },
    });
    return reply.code(201).send(issue);
  });

};
