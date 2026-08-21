import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, isNull, max } from "drizzle-orm";
import { z } from "zod";
import { submittalReviewSteps, submittals } from "@constructos/db";
import { SUBMITTAL_RESPONSES, SUBMITTAL_STATUSES, SUBMITTAL_TYPES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { pushNotifications } from "../notifications/service.js";
import { addDaysISO, isoDateSchema } from "./dates.js";

/** Days reserved for design-team review when back-computing submitBy. */
const REVIEW_ALLOWANCE_DAYS = 14;

const submittalCreateSchema = z.object({
  title: z.string().min(1).max(300),
  specSection: z.string().max(100).nullable().optional(),
  submittalType: z.enum(SUBMITTAL_TYPES).optional(),
  ballInCourtId: z.string().nullable().optional(),
  requiredOnSite: isoDateSchema.nullable().optional(),
  leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
  fileIds: z.array(z.string()).max(100).optional(),
});

const submittalPatchSchema = submittalCreateSchema.partial();

const submittalListQuery = pageQuerySchema.extend({
  status: z.enum(SUBMITTAL_STATUSES).optional(),
  type: z.enum(SUBMITTAL_TYPES).optional(),
  ballInCourt: z.string().optional(),
  search: z.string().max(200).optional(),
});

const reviewStepsSchema = z.object({
  steps: z
    .array(
      z.object({
        reviewerId: z.string().min(1),
        position: z.number().int().min(0).max(100),
        isParallel: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(20),
});

const stepRespondSchema = z.object({
  responseCode: z.enum(SUBMITTAL_RESPONSES),
  comments: z.string().max(10000).optional(),
});

function computeSubmitBy(
  requiredOnSite: string | null | undefined,
  leadTimeDays: number | null | undefined,
): string | null {
  if (!requiredOnSite) return null;
  return addDaysISO(requiredOnSite, -((leadTimeDays ?? 0) + REVIEW_ALLOWANCE_DAYS));
}

/** Submittals — spec Vol I §2.5 #326-#348. */
export const submittalRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("submittals", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("submittals", "standard"),
  ];
  const companyGate = [app.authenticate, app.requireCompany];

  async function fetchSubmittal(id: string, companyId: string, projectId?: string) {
    const clauses = [eq(submittals.id, id), eq(submittals.companyId, companyId)];
    if (projectId) clauses.push(eq(submittals.projectId, projectId));
    const rows = await app.db
      .select()
      .from(submittals)
      .where(and(...clauses))
      .limit(1);
    if (!rows[0]) throw notFound("Submittal not found");
    return rows[0];
  }

  async function ledgerSubmittal(
    action: "create" | "update" | "state_change",
    id: string,
    companyId: string,
    actorId: string,
    payload: unknown,
  ) {
    await appendLedger(app.db, {
      companyId,
      actorId,
      action,
      objectType: "submittal",
      objectId: id,
      payload,
    });
  }

  function label(row: { number: number; revision: number }): string {
    const base = `SUB-${String(row.number).padStart(3, "0")}`;
    return row.revision > 0 ? `${base} Rev ${row.revision}` : base;
  }

  app.post(
    "/projects/:projectId/submittals",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = submittalCreateSchema.parse(req.body);
      const number = await nextRecordNumber(app.db, req.projectId!, "submittal");
      const id = newId("sub");
      const row: typeof submittals.$inferInsert = {
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        revision: 0,
        title: body.title,
        specSection: body.specSection ?? null,
        submittalType: body.submittalType ?? "other",
        status: "draft",
        ballInCourtId: body.ballInCourtId ?? null,
        requiredOnSite: body.requiredOnSite ?? null,
        leadTimeDays: body.leadTimeDays ?? null,
        submitByDate: computeSubmitBy(body.requiredOnSite, body.leadTimeDays),
        fileIds: body.fileIds ?? [],
        createdBy: req.user!.id,
      };
      await app.db.insert(submittals).values(row);
      await ledgerSubmittal("create", id, req.companyId!, req.user!.id, {
        number,
        title: body.title,
      });
      return reply.status(201).send(await fetchSubmittal(id, req.companyId!, req.projectId!));
    },
  );

  app.get("/projects/:projectId/submittals", { preHandler: readGate }, async (req) => {
    const q = submittalListQuery.parse(req.query);
    const clauses = [
      eq(submittals.companyId, req.companyId!),
      eq(submittals.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(submittals.status, q.status));
    if (q.type) clauses.push(eq(submittals.submittalType, q.type));
    if (q.ballInCourt) clauses.push(eq(submittals.ballInCourtId, q.ballInCourt));
    if (q.search) clauses.push(ilike(submittals.title, `%${q.search}%`));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(submittals).where(where);
    const items = await app.db
      .select()
      .from(submittals)
      .where(where)
      .orderBy(desc(submittals.number), desc(submittals.revision))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get(
    "/projects/:projectId/submittals/:submittalId",
    { preHandler: readGate },
    async (req) => {
      const { submittalId } = req.params as { submittalId: string };
      const row = await fetchSubmittal(submittalId, req.companyId!, req.projectId!);
      const reviewSteps = await app.db
        .select()
        .from(submittalReviewSteps)
        .where(eq(submittalReviewSteps.submittalId, submittalId))
        .orderBy(asc(submittalReviewSteps.position));

      // Revision chain: walk backwards via previousId, then forwards.
      type Rev = {
        id: string;
        revision: number;
        status: string;
        responseCode: string | null;
        createdAt: string;
      };
      const toRev = (s: typeof row): Rev => ({
        id: s.id,
        revision: s.revision,
        status: s.status,
        responseCode: s.responseCode,
        createdAt: s.createdAt,
      });
      const seen = new Set<string>([row.id]);
      const ancestors: Rev[] = [];
      let cursor = row;
      while (cursor.previousId && !seen.has(cursor.previousId)) {
        const prevRows = await app.db
          .select()
          .from(submittals)
          .where(
            and(eq(submittals.id, cursor.previousId), eq(submittals.companyId, req.companyId!)),
          )
          .limit(1);
        if (!prevRows[0]) break;
        seen.add(prevRows[0].id);
        ancestors.unshift(toRev(prevRows[0]));
        cursor = prevRows[0];
      }
      const descendants: Rev[] = [];
      let head = row;
      for (;;) {
        const nextRows = await app.db
          .select()
          .from(submittals)
          .where(
            and(eq(submittals.previousId, head.id), eq(submittals.companyId, req.companyId!)),
          )
          .limit(1);
        if (!nextRows[0] || seen.has(nextRows[0].id)) break;
        seen.add(nextRows[0].id);
        descendants.push(toRev(nextRows[0]));
        head = nextRows[0];
      }
      return { ...row, reviewSteps, revisions: [...ancestors, toRev(row), ...descendants] };
    },
  );

  app.patch(
    "/projects/:projectId/submittals/:submittalId",
    { preHandler: standardGate },
    async (req) => {
      const { submittalId } = req.params as { submittalId: string };
      const body = submittalPatchSchema.parse(req.body);
      const row = await fetchSubmittal(submittalId, req.companyId!, req.projectId!);
      if (row.status === "closed" || row.status === "void") {
        throw badRequest(`A ${row.status} submittal cannot be edited`);
      }
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined) set[k] = v;
      }
      if (body.requiredOnSite !== undefined || body.leadTimeDays !== undefined) {
        const requiredOnSite =
          body.requiredOnSite !== undefined ? body.requiredOnSite : row.requiredOnSite;
        const leadTimeDays =
          body.leadTimeDays !== undefined ? body.leadTimeDays : row.leadTimeDays;
        set["submitByDate"] = computeSubmitBy(requiredOnSite, leadTimeDays);
      }
      await app.db.update(submittals).set(set).where(eq(submittals.id, submittalId));
      await ledgerSubmittal("update", submittalId, req.companyId!, req.user!.id, {
        changed: Object.keys(body),
      });
      return fetchSubmittal(submittalId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/submittals/:submittalId/review-steps",
    { preHandler: standardGate },
    async (req) => {
      const { submittalId } = req.params as { submittalId: string };
      const body = reviewStepsSchema.parse(req.body);
      const row = await fetchSubmittal(submittalId, req.companyId!, req.projectId!);
      if (row.status === "closed" || row.status === "void") {
        throw badRequest(`A ${row.status} submittal cannot change its review chain`);
      }
      // Replace the pending (unresponded) chain; responded steps are history.
      await app.db
        .delete(submittalReviewSteps)
        .where(
          and(
            eq(submittalReviewSteps.submittalId, submittalId),
            isNull(submittalReviewSteps.responseCode),
          ),
        );
      await app.db.insert(submittalReviewSteps).values(
        body.steps.map((s) => ({
          id: newId("subs"),
          submittalId,
          position: s.position,
          reviewerId: s.reviewerId,
          isParallel: s.isParallel ? 1 : 0,
        })),
      );
      await ledgerSubmittal("update", submittalId, req.companyId!, req.user!.id, {
        reviewSteps: body.steps,
      });
      const steps = await app.db
        .select()
        .from(submittalReviewSteps)
        .where(eq(submittalReviewSteps.submittalId, submittalId))
        .orderBy(asc(submittalReviewSteps.position));
      return { items: steps };
    },
  );

  app.post(
    "/projects/:projectId/submittals/:submittalId/submit",
    { preHandler: standardGate },
    async (req) => {
      const { submittalId } = req.params as { submittalId: string };
      const row = await fetchSubmittal(submittalId, req.companyId!, req.projectId!);
      if (row.status !== "draft" && row.status !== "open") {
        throw badRequest("Only a draft or open submittal can be submitted");
      }
      const pending = await app.db
        .select()
        .from(submittalReviewSteps)
        .where(
          and(
            eq(submittalReviewSteps.submittalId, submittalId),
            isNull(submittalReviewSteps.responseCode),
          ),
        )
        .orderBy(asc(submittalReviewSteps.position));
      const now = new Date().toISOString();
      if (pending.length === 0) {
        await app.db
          .update(submittals)
          .set({ status: "open", updatedAt: now })
          .where(eq(submittals.id, submittalId));
        await ledgerSubmittal("state_change", submittalId, req.companyId!, req.user!.id, {
          from: row.status,
          to: "open",
        });
        return fetchSubmittal(submittalId, req.companyId!, req.projectId!);
      }
      const firstPosition = pending[0]!.position;
      const firstGroup = pending.filter((s) => s.position === firstPosition);
      await app.db
        .update(submittals)
        .set({ status: "in_review", ballInCourtId: firstGroup[0]!.reviewerId, updatedAt: now })
        .where(eq(submittals.id, submittalId));
      await ledgerSubmittal("state_change", submittalId, req.companyId!, req.user!.id, {
        from: row.status,
        to: "in_review",
        ballInCourtId: firstGroup[0]!.reviewerId,
      });
      await pushNotifications(
        app.db,
        firstGroup.map((s) => ({
          companyId: req.companyId!,
          userId: s.reviewerId,
          projectId: req.projectId!,
          kind: "assignment" as const,
          title: `${label(row)} awaiting your review: ${row.title}`,
          recordType: "submittal",
          recordId: submittalId,
        })),
      );
      return fetchSubmittal(submittalId, req.companyId!, req.projectId!);
    },
  );

  app.post("/submittal-steps/:stepId/respond", { preHandler: companyGate }, async (req) => {
    const { stepId } = req.params as { stepId: string };
    const body = stepRespondSchema.parse(req.body);
    const stepRows = await app.db
      .select()
      .from(submittalReviewSteps)
      .where(eq(submittalReviewSteps.id, stepId))
      .limit(1);
    const step = stepRows[0];
    if (!step) throw notFound("Review step not found");
    const sub = await fetchSubmittal(step.submittalId, req.companyId!);
    if (sub.status !== "in_review") throw badRequest("Submittal is not in review");
    if (step.responseCode) throw conflict("Step has already been responded to");
    const isAdmin = req.companyRole === "owner" || req.companyRole === "admin";
    if (req.user!.id !== step.reviewerId && !isAdmin) {
      throw forbidden("Only the assigned reviewer may respond");
    }
    const pending = await app.db
      .select()
      .from(submittalReviewSteps)
      .where(
        and(
          eq(submittalReviewSteps.submittalId, sub.id),
          isNull(submittalReviewSteps.responseCode),
        ),
      )
      .orderBy(asc(submittalReviewSteps.position));
    const currentPosition = pending[0]!.position;
    if (step.position !== currentPosition) {
      throw badRequest("Earlier review steps must respond first");
    }

    const now = new Date().toISOString();
    await app.db
      .update(submittalReviewSteps)
      .set({ responseCode: body.responseCode, comments: body.comments ?? null, respondedAt: now })
      .where(eq(submittalReviewSteps.id, stepId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "submittal_review_step",
      objectId: stepId,
      payload: { submittalId: sub.id, responseCode: body.responseCode },
    });

    const finish = async (finalCode: string) => {
      await app.db
        .update(submittals)
        .set({
          status: "responded",
          responseCode: finalCode,
          respondedBy: req.user!.id,
          respondedAt: now,
          ballInCourtId: sub.createdBy,
          updatedAt: now,
        })
        .where(eq(submittals.id, sub.id));
      await ledgerSubmittal("state_change", sub.id, req.companyId!, req.user!.id, {
        from: "in_review",
        to: "responded",
        responseCode: finalCode,
      });
      await pushNotifications(app.db, [
        {
          companyId: req.companyId!,
          userId: sub.createdBy,
          projectId: sub.projectId,
          kind: "status_change",
          title: `${label(sub)} responded (${finalCode}): ${sub.title}`,
          recordType: "submittal",
          recordId: sub.id,
        },
      ]);
    };

    if (body.responseCode === "revise_and_resubmit" || body.responseCode === "rejected") {
      await finish(body.responseCode);
      return { stepId, responseCode: body.responseCode, submittalStatus: "responded" };
    }

    const remaining = await app.db
      .select()
      .from(submittalReviewSteps)
      .where(
        and(
          eq(submittalReviewSteps.submittalId, sub.id),
          isNull(submittalReviewSteps.responseCode),
        ),
      )
      .orderBy(asc(submittalReviewSteps.position));
    if (remaining.length === 0) {
      const all = await app.db
        .select({ responseCode: submittalReviewSteps.responseCode })
        .from(submittalReviewSteps)
        .where(eq(submittalReviewSteps.submittalId, sub.id));
      const hasAsNoted = all.some((s) => s.responseCode === "approved_as_noted");
      await finish(hasAsNoted ? "approved_as_noted" : "approved");
      return { stepId, responseCode: body.responseCode, submittalStatus: "responded" };
    }

    // Sequential advance: ball in court moves to the next unresponded group.
    const nextPosition = remaining[0]!.position;
    const nextGroup = remaining.filter((s) => s.position === nextPosition);
    if (nextPosition !== currentPosition) {
      await app.db
        .update(submittals)
        .set({ ballInCourtId: nextGroup[0]!.reviewerId, updatedAt: now })
        .where(eq(submittals.id, sub.id));
      await ledgerSubmittal("update", sub.id, req.companyId!, req.user!.id, {
        ballInCourtId: nextGroup[0]!.reviewerId,
      });
      await pushNotifications(
        app.db,
        nextGroup.map((s) => ({
          companyId: req.companyId!,
          userId: s.reviewerId,
          projectId: sub.projectId,
          kind: "assignment" as const,
          title: `${label(sub)} awaiting your review: ${sub.title}`,
          recordType: "submittal",
          recordId: sub.id,
        })),
      );
    }
    return { stepId, responseCode: body.responseCode, submittalStatus: "in_review" };
  });

  app.post(
    "/projects/:projectId/submittals/:submittalId/resubmit",
    { preHandler: standardGate },
    async (req, reply) => {
      const { submittalId } = req.params as { submittalId: string };
      const row = await fetchSubmittal(submittalId, req.companyId!, req.projectId!);
      if (row.status !== "responded") {
        throw badRequest("Only a responded submittal can be resubmitted");
      }
      if (row.responseCode !== "revise_and_resubmit" && row.responseCode !== "rejected") {
        throw badRequest("Resubmission requires a revise-and-resubmit or rejected response");
      }
      const [maxRow] = await app.db
        .select({ maxRev: max(submittals.revision) })
        .from(submittals)
        .where(
          and(eq(submittals.projectId, req.projectId!), eq(submittals.number, row.number)),
        );
      const revision = Number(maxRow?.maxRev ?? row.revision) + 1;
      const id = newId("sub");
      const newRow: typeof submittals.$inferInsert = {
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number: row.number,
        revision,
        title: row.title,
        specSection: row.specSection,
        submittalType: row.submittalType,
        status: "draft",
        ballInCourtId: null,
        requiredOnSite: row.requiredOnSite,
        leadTimeDays: row.leadTimeDays,
        submitByDate: row.submitByDate,
        fileIds: [],
        previousId: row.id,
        createdBy: req.user!.id,
      };
      await app.db.insert(submittals).values(newRow);
      await ledgerSubmittal("create", id, req.companyId!, req.user!.id, {
        number: row.number,
        revision,
        previousId: row.id,
      });
      return reply.status(201).send(await fetchSubmittal(id, req.companyId!, req.projectId!));
    },
  );

  app.post(
    "/projects/:projectId/submittals/:submittalId/close",
    { preHandler: standardGate },
    async (req) => {
      const { submittalId } = req.params as { submittalId: string };
      const row = await fetchSubmittal(submittalId, req.companyId!, req.projectId!);
      if (row.status !== "open" && row.status !== "responded") {
        throw badRequest("Only an open or responded submittal can be closed");
      }
      await app.db
        .update(submittals)
        .set({ status: "closed", updatedAt: new Date().toISOString() })
        .where(eq(submittals.id, submittalId));
      await ledgerSubmittal("state_change", submittalId, req.companyId!, req.user!.id, {
        from: row.status,
        to: "closed",
      });
      return fetchSubmittal(submittalId, req.companyId!, req.projectId!);
    },
  );
};
