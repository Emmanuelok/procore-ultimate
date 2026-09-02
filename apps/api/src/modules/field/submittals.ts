/**
 * Submittals — spec Vol I §2.5 #326–#348.
 *
 * Covers: register with backward scheduling from required-on-site (#337),
 * schedule generation from spec sections (#338), at-risk flagging (#339),
 * sequential/parallel review chains whose responses are serialised in a
 * transaction with a row lock (#334 — two parallel reviewers can no longer
 * strand a record), explicit final-code precedence, per-company response
 * code sets, resubmittal chains that supersede the parent atomically (#340),
 * distribution on final response and close (#345), turnaround and in-court
 * analytics (#347) and closeout segregation (#348).
 *
 * Does NOT do: AI review of submittal content (modules/ai) or spec-section
 * register generation from the specifications module (that module's job;
 * this file accepts the seeds it produces).
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, lt, type SQL } from "drizzle-orm";
import { z } from "zod";
import { submittalResponseCodes, submittalReviewSteps, submittals } from "@constructos/db";
import { SUBMITTAL_STATUSES_EXTENDED, SUBMITTAL_TYPES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { pushNotifications } from "../notifications/service.js";
import { addDaysISO, isoDateSchema, todayISO } from "./dates.js";
import { assertCompanyUsers, hasToolAdmin, isCompanyAdmin, requireToolLevel } from "./access.js";
import { ageInDays, bucketise } from "./ageingEngine.js";
import {
  BUILTIN_RESPONSE_CODES,
  chainIsStranded,
  computeSubmitBy,
  firstPendingGroup,
  generateSubmittalSchedule,
  isCloseoutType,
  isResubmitCode,
  resolveFinalCode,
  resubmissionBySpecSection,
  reviewerTurnaround,
  submittalRisk,
  type ResponseCodeDef,
} from "./submittalEngine.js";
import { loadFieldSettings } from "./settings.js";
import { actorOf, nowIso, pad3 } from "./shared.js";

const submittalCreateSchema = z.object({
  title: z.string().min(1).max(300),
  specSection: z.string().max(100).nullable().optional(),
  submittalType: z.enum(SUBMITTAL_TYPES).optional(),
  ballInCourtId: z.string().nullable().optional(),
  requiredOnSite: isoDateSchema.nullable().optional(),
  leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
  fileIds: z.array(z.string()).max(100).optional(),
  distribution: z.array(z.string().min(1)).max(50).optional(),
  vendorId: z.string().nullable().optional(),
});

const submittalPatchSchema = submittalCreateSchema.partial();

const submittalListQuery = pageQuerySchema.extend({
  status: z.enum(SUBMITTAL_STATUSES_EXTENDED).optional(),
  type: z.enum(SUBMITTAL_TYPES).optional(),
  ballInCourt: z.string().optional(),
  specSection: z.string().max(100).optional(),
  closeout: z.enum(["true", "false"]).optional(),
  overdue: z.enum(["true", "false"]).optional(),
  atRisk: z.enum(["true", "false"]).optional(),
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
  responseCode: z.string().min(1).max(60),
  comments: z.string().max(10000).optional(),
});

const resubmitSchema = z
  .object({
    copyFiles: z.boolean().optional(),
    copyReviewChain: z.boolean().optional(),
  })
  .optional();

const scheduleSchema = z.object({
  items: z
    .array(
      z.object({
        specSection: z.string().min(1).max(100),
        title: z.string().min(1).max(300),
        submittalType: z.enum(SUBMITTAL_TYPES).optional(),
        requiredOnSite: isoDateSchema.nullable().optional(),
        leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
  create: z.boolean().optional(),
});

const responseCodesSchema = z.object({
  codes: z
    .array(
      z.object({
        code: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
        label: z.string().min(1).max(100),
        isApproval: z.boolean().optional(),
        isResubmit: z.boolean().optional(),
        sortOrder: z.number().int().min(0).max(1000).optional(),
      }),
    )
    .min(1)
    .max(30),
});

const ACTIVE_STATUSES = ["draft", "open", "in_review"] as const;

export const submittalRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("submittals", "read")];
  const standardGate = [app.authenticate, app.requireCompany, app.requireTool("submittals", "standard")];
  const companyGate = [app.authenticate, app.requireCompany];
  const companyAdminGate = [app.authenticate, app.requireCompany, app.requireCompanyRole(["owner", "admin"])];

  function label(row: { number: number; revision: number }): string {
    const base = `SUB-${pad3(row.number)}`;
    return row.revision > 0 ? `${base} Rev ${row.revision}` : base;
  }

  async function fetchSubmittal(id: string, companyId: string, projectId?: string) {
    const clauses = [eq(submittals.id, id), eq(submittals.companyId, companyId)];
    if (projectId) clauses.push(eq(submittals.projectId, projectId));
    const rows = await app.db.select().from(submittals).where(and(...clauses)).limit(1);
    if (!rows[0]) throw notFound("Submittal not found");
    return rows[0];
  }

  async function ledgerSubmittal(
    action: "create" | "update" | "state_change",
    id: string,
    companyId: string,
    actorId: string,
    projectId: string,
    payload: unknown,
    storePayload = false,
  ) {
    await appendLedger(app.db, {
      companyId,
      actorId,
      action,
      objectType: "submittal",
      objectId: id,
      payload,
      storePayload,
      projectId,
    });
  }

  async function companyCodes(companyId: string): Promise<ResponseCodeDef[]> {
    const rows = await app.db
      .select()
      .from(submittalResponseCodes)
      .where(and(eq(submittalResponseCodes.companyId, companyId), eq(submittalResponseCodes.isActive, 1)))
      .orderBy(asc(submittalResponseCodes.sortOrder));
    if (rows.length === 0) return [...BUILTIN_RESPONSE_CODES];
    return rows.map((r) => ({
      code: r.code,
      label: r.label,
      isApproval: r.isApproval === 1,
      isResubmit: r.isResubmit === 1,
      sortOrder: r.sortOrder,
    }));
  }

  function stepsOf(submittalId: string) {
    return app.db
      .select()
      .from(submittalReviewSteps)
      .where(eq(submittalReviewSteps.submittalId, submittalId))
      .orderBy(asc(submittalReviewSteps.position));
  }

  function notifyGroup(
    companyId: string,
    projectId: string,
    sub: { id: string; number: number; revision: number; title: string },
    reviewerIds: string[],
  ) {
    return pushNotifications(
      app.db,
      reviewerIds.map((userId) => ({
        companyId,
        userId,
        projectId,
        kind: "assignment" as const,
        title: `${label(sub)} awaiting your review: ${sub.title}`,
        recordType: "submittal",
        recordId: sub.id,
      })),
    );
  }

  /** Signed whole days from today to an ISO date: negative when it has passed. */
  function daysUntil(isoDate: string, today: string): number {
    return Math.round((Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  }

  function decorate(row: typeof submittals.$inferSelect, today: string, atRiskDays: number) {
    return {
      ...row,
      risk: submittalRisk(row, today, atRiskDays),
      label: label(row),
      daysToSubmitBy: row.submitByDate ? daysUntil(row.submitByDate, today) : null,
      daysInCourt: row.status === "in_review" ? ageInDays(row.submittedAt ?? row.updatedAt, today) : null,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Company response-code set (#334)                                  */
  /* ---------------------------------------------------------------- */

  app.get("/submittal-response-codes", { preHandler: companyGate }, async (req) => {
    const codes = await companyCodes(req.companyId!);
    const rows = await app.db
      .select({ n: count() })
      .from(submittalResponseCodes)
      .where(eq(submittalResponseCodes.companyId, req.companyId!));
    return { items: codes, custom: Number(rows[0]?.n ?? 0) > 0 };
  });

  app.put("/submittal-response-codes", { preHandler: companyAdminGate }, async (req) => {
    const body = responseCodesSchema.parse(req.body);
    const seen = new Set<string>();
    for (const c of body.codes) {
      if (seen.has(c.code)) throw badRequest(`Duplicate response code "${c.code}"`);
      seen.add(c.code);
    }
    if (!body.codes.some((c) => c.isResubmit)) {
      throw badRequest("At least one code must be a resubmit code, or nothing can ever be sent back");
    }
    await app.db.transaction(async (tx) => {
      await tx.delete(submittalResponseCodes).where(eq(submittalResponseCodes.companyId, req.companyId!));
      await tx.insert(submittalResponseCodes).values(
        body.codes.map((c, i) => ({
          id: newId("src"),
          companyId: req.companyId!,
          code: c.code,
          label: c.label,
          isApproval: c.isApproval ? 1 : 0,
          isResubmit: c.isResubmit ? 1 : 0,
          sortOrder: c.sortOrder ?? i,
          isActive: 1,
        })),
      );
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "submittal_response_codes",
      objectId: req.companyId!,
      payload: { codes: body.codes },
      storePayload: true,
    });
    return { items: await companyCodes(req.companyId!), custom: true };
  });

  /* ---------------------------------------------------------------- */
  /* Create / list                                                     */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/submittals", { preHandler: standardGate }, async (req, reply) => {
    const body = submittalCreateSchema.parse(req.body);
    await assertCompanyUsers(app.db, req.companyId!, [body.ballInCourtId, ...(body.distribution ?? [])]);
    const settings = await loadFieldSettings(app.db, req.companyId!, req.projectId!);
    const number = await nextRecordNumber(app.db, req.projectId!, "submittal");
    const id = newId("sub");
    const submittalType = body.submittalType ?? "other";
    await app.db.insert(submittals).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      number,
      revision: 0,
      title: body.title,
      specSection: body.specSection ?? null,
      submittalType,
      status: "draft",
      ballInCourtId: body.ballInCourtId ?? null,
      requiredOnSite: body.requiredOnSite ?? null,
      leadTimeDays: body.leadTimeDays ?? null,
      reviewAllowanceDays: settings.submittal.reviewAllowanceDays,
      submitByDate: computeSubmitBy(body.requiredOnSite, body.leadTimeDays, settings.submittal.reviewAllowanceDays),
      fileIds: body.fileIds ?? [],
      distribution: body.distribution ?? [],
      isCloseout: isCloseoutType(submittalType) ? 1 : 0,
      vendorId: body.vendorId ?? null,
      createdBy: req.user!.id,
    });
    await ledgerSubmittal("create", id, req.companyId!, req.user!.id, req.projectId!, { number, title: body.title });
    return reply.status(201).send(await fetchSubmittal(id, req.companyId!, req.projectId!));
  });

  app.get("/projects/:projectId/submittals", { preHandler: readGate }, async (req) => {
    const q = submittalListQuery.parse(req.query);
    const settings = await loadFieldSettings(app.db, req.companyId!, req.projectId!);
    const today = todayISO();
    const clauses: SQL[] = [eq(submittals.companyId, req.companyId!), eq(submittals.projectId, req.projectId!)];
    if (q.status) clauses.push(eq(submittals.status, q.status));
    if (q.type) clauses.push(eq(submittals.submittalType, q.type));
    if (q.ballInCourt) clauses.push(eq(submittals.ballInCourtId, q.ballInCourt));
    if (q.specSection) clauses.push(eq(submittals.specSection, q.specSection));
    if (q.closeout) clauses.push(eq(submittals.isCloseout, q.closeout === "true" ? 1 : 0));
    if (q.search) clauses.push(ilike(submittals.title, `%${q.search}%`));
    if (q.overdue === "true") {
      clauses.push(inArray(submittals.status, [...ACTIVE_STATUSES]), isNotNull(submittals.submitByDate), lt(submittals.submitByDate, today));
    }
    if (q.atRisk === "true") {
      clauses.push(
        inArray(submittals.status, [...ACTIVE_STATUSES]),
        isNotNull(submittals.submitByDate),
        lt(submittals.submitByDate, addDaysISO(today, settings.submittal.atRiskDays)),
      );
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(submittals).where(where);
    const items = await app.db
      .select()
      .from(submittals)
      .where(where)
      .orderBy(desc(submittals.number), desc(submittals.revision))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      items.map((r) => decorate(r, today, settings.submittal.atRiskDays)),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  /* ---------------------------------------------------------------- */
  /* Analytics (#339, #347, #348)                                      */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/submittals/analytics", { preHandler: readGate }, async (req) => {
    const settings = await loadFieldSettings(app.db, req.companyId!, req.projectId!);
    const today = todayISO();
    const scope = and(eq(submittals.companyId, req.companyId!), eq(submittals.projectId, req.projectId!));
    const rows = await app.db.select().from(submittals).where(scope).limit(5000);
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const risks = rows.map((r) => submittalRisk(r, today, settings.submittal.atRiskDays));
    const steps =
      rows.length > 0
        ? await app.db
            .select()
            .from(submittalReviewSteps)
            .where(inArray(submittalReviewSteps.submittalId, rows.map((r) => r.id)))
        : [];
    const typeOf = new Map(rows.map((r) => [r.id, r.submittalType]));
    const turnaroundByType = new Map<string, number[]>();
    for (const s of steps) {
      if (!s.responseCode || !s.respondedAt || !s.activatedAt) continue;
      const t = typeOf.get(s.submittalId) ?? "other";
      const days = Math.max(0, (Date.parse(s.respondedAt) - Date.parse(s.activatedAt)) / 86_400_000);
      turnaroundByType.set(t, [...(turnaroundByType.get(t) ?? []), days]);
    }
    const inCourt = rows.filter((r) => r.status === "in_review" && r.ballInCourtId);
    const closeout = rows.filter((r) => r.isCloseout === 1 && r.status !== "void" && r.status !== "superseded");
    return {
      asOf: today,
      byStatus,
      overdue: risks.filter((r) => r === "late" || r === "required_on_site_passed").length,
      atRisk: risks.filter((r) => r === "at_risk").length,
      inCourtAgeing: bucketise(
        inCourt,
        (r) => ageInDays(r.submittedAt ?? r.updatedAt, today),
        (r) => r.ballInCourtId ?? "unassigned",
      ),
      reviewers: reviewerTurnaround(steps, nowIso(), settings.submittal.inCourtAllowanceDays),
      turnaroundByType: [...turnaroundByType.entries()].map(([submittalType, ds]) => ({
        submittalType,
        responded: ds.length,
        avgDays: Math.round((ds.reduce((a, b) => a + b, 0) / ds.length) * 10) / 10,
      })),
      resubmissionBySpecSection: resubmissionBySpecSection(rows),
      closeout: {
        total: closeout.length,
        approved: closeout.filter((r) => r.responseCode === "approved" || r.responseCode === "approved_as_noted" || r.status === "closed").length,
        outstanding: closeout.filter((r) => (ACTIVE_STATUSES as readonly string[]).includes(r.status)).length,
      },
      stranded: rows.filter((r) => r.status === "in_review" && chainIsStranded(r.status, steps.filter((s) => s.submittalId === r.id))).length,
      basis: `Turnaround measured from when a review group became current (activatedAt) to its response; in-court allowance ${settings.submittal.inCourtAllowanceDays} days; at-risk window ${settings.submittal.atRiskDays} days.`,
    };
  });

  app.get("/projects/:projectId/submittals/closeout", { preHandler: readGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(submittals)
      .where(and(eq(submittals.companyId, req.companyId!), eq(submittals.projectId, req.projectId!), eq(submittals.isCloseout, 1)))
      .orderBy(asc(submittals.submittalType), desc(submittals.number))
      .limit(2000);
    const byType: Record<string, { total: number; approved: number; outstanding: number }> = {};
    for (const r of rows) {
      if (r.status === "void" || r.status === "superseded") continue;
      const rec = byType[r.submittalType] ?? { total: 0, approved: 0, outstanding: 0 };
      rec.total += 1;
      if (r.responseCode === "approved" || r.responseCode === "approved_as_noted" || r.status === "closed") rec.approved += 1;
      else rec.outstanding += 1;
      byType[r.submittalType] = rec;
    }
    return { items: rows, byType };
  });

  /* ---------------------------------------------------------------- */
  /* Schedule generation (#338)                                        */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/submittals/schedule", { preHandler: standardGate }, async (req, reply) => {
    const body = scheduleSchema.parse(req.body);
    const settings = await loadFieldSettings(app.db, req.companyId!, req.projectId!);
    const rows = generateSubmittalSchedule(body.items, settings.submittal.reviewAllowanceDays);
    if (!body.create) return { preview: true, items: rows };
    const created: string[] = [];
    await app.db.transaction(async (tx) => {
      for (const row of rows) {
        const number = await nextRecordNumber(tx, req.projectId!, "submittal");
        const id = newId("sub");
        await tx.insert(submittals).values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          number,
          revision: 0,
          title: row.title,
          specSection: row.specSection,
          submittalType: row.submittalType,
          status: "draft",
          requiredOnSite: row.requiredOnSite ?? null,
          leadTimeDays: row.leadTimeDays ?? null,
          reviewAllowanceDays: settings.submittal.reviewAllowanceDays,
          submitByDate: row.submitByDate,
          isCloseout: row.isCloseout ? 1 : 0,
          createdBy: req.user!.id,
        });
        created.push(id);
      }
    });
    for (const id of created) {
      await ledgerSubmittal("create", id, req.companyId!, req.user!.id, req.projectId!, { generatedFromSchedule: true });
    }
    const items = await app.db.select().from(submittals).where(inArray(submittals.id, created)).orderBy(asc(submittals.number));
    return reply.status(201).send({ preview: false, items });
  });

  /* ---------------------------------------------------------------- */
  /* Detail / edit                                                     */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/submittals/:submittalId", { preHandler: readGate }, async (req) => {
    const { submittalId } = req.params as { submittalId: string };
    const row = await fetchSubmittal(submittalId, req.companyId!, req.projectId!);
    const settings = await loadFieldSettings(app.db, req.companyId!, req.projectId!);
    const reviewSteps = await stepsOf(submittalId);
    type Rev = { id: string; revision: number; status: string; responseCode: string | null; createdAt: string };
    const toRev = (s: typeof row): Rev => ({ id: s.id, revision: s.revision, status: s.status, responseCode: s.responseCode, createdAt: s.createdAt });
    const seen = new Set<string>([row.id]);
    const ancestors: Rev[] = [];
    let cursor = row;
    while (cursor.previousId && !seen.has(cursor.previousId)) {
      const prev = (
        await app.db.select().from(submittals).where(and(eq(submittals.id, cursor.previousId), eq(submittals.companyId, req.companyId!))).limit(1)
      )[0];
      if (!prev) break;
      seen.add(prev.id);
      ancestors.unshift(toRev(prev));
      cursor = prev;
    }
    const descendants: Rev[] = [];
    let head = row;
    for (let guard = 0; guard < 50; guard += 1) {
      const nextId = head.supersededById;
      const next = nextId
        ? (await app.db.select().from(submittals).where(and(eq(submittals.id, nextId), eq(submittals.companyId, req.companyId!))).limit(1))[0]
        : (await app.db.select().from(submittals).where(and(eq(submittals.previousId, head.id), eq(submittals.companyId, req.companyId!))).orderBy(asc(submittals.revision)).limit(1))[0];
      if (!next || seen.has(next.id)) break;
      seen.add(next.id);
      descendants.push(toRev(next));
      head = next;
    }
    const me = req.user!.id;
    const admin = isCompanyAdmin(req.companyRole) || (await hasToolAdmin(app, actorOf(req), req.projectId!, "submittals"));
    const pending = firstPendingGroup(reviewSteps);
    return {
      ...decorate(row, todayISO(), settings.submittal.atRiskDays),
      reviewSteps,
      revisions: [...ancestors, toRev(row), ...descendants],
      stranded: chainIsStranded(row.status, reviewSteps),
      currentPosition: pending?.position ?? null,
      permissions: {
        isAdmin: admin,
        canRespondStepIds: row.status === "in_review" && pending ? pending.steps.filter((s) => admin || s.reviewerId === me).map((s) => s.id) : [],
        canResubmit: row.status === "responded" && !row.supersededById && !!row.responseCode && isResubmitCode(row.responseCode, await companyCodes(req.companyId!)),
      },
    };
  });

  app.patch("/projects/:projectId/submittals/:submittalId", { preHandler: standardGate }, async (req) => {
    const { submittalId } = req.params as { submittalId: string };
    const body = submittalPatchSchema.parse(req.body);
    const row = await fetchSubmittal(submittalId, req.companyId!, req.projectId!);
    if (row.status === "closed" || row.status === "void" || row.status === "superseded") {
      throw badRequest(`A ${row.status} submittal cannot be edited`);
    }
    await assertCompanyUsers(app.db, req.companyId!, [body.ballInCourtId, ...(body.distribution ?? [])]);
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    for (const [k, v] of Object.entries(body)) if (v !== undefined) set[k] = v;
    if (body.submittalType !== undefined) set["isCloseout"] = isCloseoutType(body.submittalType) ? 1 : 0;
    if (body.requiredOnSite !== undefined || body.leadTimeDays !== undefined) {
      const requiredOnSite = body.requiredOnSite !== undefined ? body.requiredOnSite : row.requiredOnSite;
      const leadTimeDays = body.leadTimeDays !== undefined ? body.leadTimeDays : row.leadTimeDays;
      const settings = await loadFieldSettings(app.db, req.companyId!, req.projectId!);
      const allowance = row.reviewAllowanceDays ?? settings.submittal.reviewAllowanceDays;
      set["reviewAllowanceDays"] = allowance;
      set["submitByDate"] = computeSubmitBy(requiredOnSite, leadTimeDays, allowance);
    }
    await app.db.update(submittals).set(set).where(eq(submittals.id, submittalId));
    await ledgerSubmittal("update", submittalId, req.companyId!, req.user!.id, req.projectId!, { changed: Object.keys(body) });
    return fetchSubmittal(submittalId, req.companyId!, req.projectId!);
  });

  /* ---------------------------------------------------------------- */
  /* Review chain                                                      */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/submittals/:submittalId/review-steps", { preHandler: standardGate }, async (req) => {
    const { submittalId } = req.params as { submittalId: string };
    const body = reviewStepsSchema.parse(req.body);
    const row = await fetchSubmittal(submittalId, req.companyId!, req.projectId!);
    if (row.status === "closed" || row.status === "void" || row.status === "superseded" || row.status === "responded") {
      throw badRequest(`A ${row.status} submittal cannot change its review chain`);
    }
    await assertCompanyUsers(app.db, req.companyId!, body.steps.map((s) => s.reviewerId), "reviewer");
    const now = nowIso();
    const outcome = await app.db.transaction(async (tx) => {
      await tx.select({ id: submittals.id }).from(submittals).where(eq(submittals.id, submittalId)).for("update");
      // Responded steps are history and stay; only the pending chain is replaced.
      await tx
        .delete(submittalReviewSteps)
        .where(and(eq(submittalReviewSteps.submittalId, submittalId), isNull(submittalReviewSteps.responseCode)));
      await tx.insert(submittalReviewSteps).values(
        body.steps.map((s) => ({
          id: newId("subs"),
          submittalId,
          position: s.position,
          reviewerId: s.reviewerId,
          isParallel: s.isParallel ? 1 : 0,
        })),
      );
      const steps = await tx.select().from(submittalReviewSteps).where(eq(submittalReviewSteps.submittalId, submittalId)).orderBy(asc(submittalReviewSteps.position));
      let newBic: string | null = null;
      let notified: string[] = [];
      if (row.status === "in_review") {
        const group = firstPendingGroup(steps);
        if (group) {
          newBic = group.steps[0]!.reviewerId;
          await tx.update(submittalReviewSteps).set({ activatedAt: now }).where(inArray(submittalReviewSteps.id, group.steps.map((s) => s.id)));
          await tx.update(submittals).set({ ballInCourtId: newBic, updatedAt: now }).where(eq(submittals.id, submittalId));
          notified = group.steps.map((s) => s.reviewerId).filter((id) => id !== row.ballInCourtId);
        }
      }
      return { steps, newBic, notified };
    });
    await ledgerSubmittal("update", submittalId, req.companyId!, req.user!.id, req.projectId!, {
      reviewSteps: body.steps,
      ballInCourtId: outcome.newBic ?? row.ballInCourtId,
    });
    if (outcome.notified.length > 0) await notifyGroup(req.companyId!, req.projectId!, row, outcome.notified);
    const steps = await stepsOf(submittalId);
    return { items: steps, ballInCourtId: outcome.newBic ?? row.ballInCourtId };
  });

  app.post("/projects/:projectId/submittals/:submittalId/submit", { preHandler: standardGate }, async (req) => {
    const { submittalId } = req.params as { submittalId: string };
    const row = await fetchSubmittal(submittalId, req.companyId!, req.projectId!);
    if (row.status !== "draft" && row.status !== "open") {
      throw badRequest("Only a draft or open submittal can be submitted");
    }
    const now = nowIso();
    const outcome = await app.db.transaction(async (tx) => {
      const steps = await tx.select().from(submittalReviewSteps).where(eq(submittalReviewSteps.submittalId, submittalId)).orderBy(asc(submittalReviewSteps.position));
      const group = firstPendingGroup(steps);
      if (!group) {
        await tx.update(submittals).set({ status: "open", submittedAt: now, updatedAt: now }).where(eq(submittals.id, submittalId));
        return { to: "open" as const, reviewers: [] as string[], bic: null as string | null };
      }
      await tx.update(submittalReviewSteps).set({ activatedAt: now }).where(inArray(submittalReviewSteps.id, group.steps.map((s) => s.id)));
      const bic = group.steps[0]!.reviewerId;
      await tx.update(submittals).set({ status: "in_review", ballInCourtId: bic, submittedAt: now, updatedAt: now }).where(eq(submittals.id, submittalId));
      return { to: "in_review" as const, reviewers: group.steps.map((s) => s.reviewerId), bic };
    });
    await ledgerSubmittal("state_change", submittalId, req.companyId!, req.user!.id, req.projectId!, {
      from: row.status,
      to: outcome.to,
      ballInCourtId: outcome.bic,
      submittedAt: now,
    });
    if (outcome.reviewers.length > 0) await notifyGroup(req.companyId!, req.projectId!, row, outcome.reviewers);
    return fetchSubmittal(submittalId, req.companyId!, req.projectId!);
  });

  /**
   * Respond to a review step. Serialised per submittal with SELECT … FOR
   * UPDATE so concurrent parallel reviewers cannot both see the other's
   * step as pending and leave the record stranded (audit: submittals.ts:367).
   */
  async function respondToStep(req: FastifyRequest, stepId: string, body: z.infer<typeof stepRespondSchema>) {
    const stepRow = (await app.db.select().from(submittalReviewSteps).where(eq(submittalReviewSteps.id, stepId)).limit(1))[0];
    if (!stepRow) throw notFound("Review step not found");
    const subPre = await fetchSubmittal(stepRow.submittalId, req.companyId!);
    if (req.projectId && subPre.projectId !== req.projectId) throw notFound("Review step not found");
    // A reviewer is often a consultant with read-only access to the register;
    // responding to their own step is the one write that role legitimately
    // performs, so the gate is "read on the tool" plus "you are the reviewer".
    await requireToolLevel(app, actorOf(req), subPre.projectId, "submittals", "read");
    const admin = isCompanyAdmin(req.companyRole) || (await hasToolAdmin(app, actorOf(req), subPre.projectId, "submittals"));
    const codes = await companyCodes(req.companyId!);
    if (!codes.some((c) => c.code === body.responseCode)) {
      throw badRequest(`Unknown response code "${body.responseCode}" for this company`);
    }
    const now = nowIso();
    const outcome = await app.db.transaction(async (tx) => {
      const sub = (await tx.select().from(submittals).where(eq(submittals.id, stepRow.submittalId)).for("update"))[0];
      if (!sub) throw notFound("Submittal not found");
      if (sub.status !== "in_review") throw badRequest("Submittal is not in review");
      const steps = await tx.select().from(submittalReviewSteps).where(eq(submittalReviewSteps.submittalId, sub.id)).orderBy(asc(submittalReviewSteps.position));
      const step = steps.find((s) => s.id === stepId);
      if (!step) throw notFound("Review step not found");
      if (step.responseCode) throw conflict("Step has already been responded to");
      if (req.user!.id !== step.reviewerId && !admin) throw forbidden("Only the assigned reviewer may respond");
      const group = firstPendingGroup(steps);
      if (!group || group.position !== step.position) throw badRequest("Earlier review steps must respond first");

      await tx
        .update(submittalReviewSteps)
        .set({ responseCode: body.responseCode, comments: body.comments ?? null, respondedAt: now })
        .where(eq(submittalReviewSteps.id, stepId));
      const after = steps.map((s) => (s.id === stepId ? { ...s, responseCode: body.responseCode } : s));

      const finalise = async (finalCode: string) => {
        await tx
          .update(submittals)
          .set({ status: "responded", responseCode: finalCode, respondedBy: req.user!.id, respondedAt: now, ballInCourtId: sub.createdBy, updatedAt: now })
          .where(eq(submittals.id, sub.id));
        return { sub, kind: "finalised" as const, finalCode, nextReviewers: [] as string[], nextBic: null as string | null };
      };

      if (isResubmitCode(body.responseCode, codes)) return finalise(body.responseCode);
      const next = firstPendingGroup(after);
      if (!next) return finalise(resolveFinalCode(after.map((s) => s.responseCode), codes) ?? body.responseCode);
      if (next.position === step.position) {
        return { sub, kind: "waiting" as const, finalCode: null, nextReviewers: [] as string[], nextBic: sub.ballInCourtId };
      }
      const nextBic = next.steps[0]!.reviewerId;
      await tx.update(submittalReviewSteps).set({ activatedAt: now }).where(inArray(submittalReviewSteps.id, next.steps.map((s) => s.id)));
      await tx.update(submittals).set({ ballInCourtId: nextBic, updatedAt: now }).where(eq(submittals.id, sub.id));
      return { sub, kind: "advanced" as const, finalCode: null, nextReviewers: next.steps.map((s) => s.reviewerId), nextBic };
    });

    const sub = outcome.sub;
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "submittal_review_step",
      objectId: stepId,
      payload: { submittalId: sub.id, responseCode: body.responseCode, hasComments: Boolean(body.comments) },
      projectId: sub.projectId,
    });
    if (outcome.kind === "finalised") {
      await ledgerSubmittal("state_change", sub.id, req.companyId!, req.user!.id, sub.projectId, { from: "in_review", to: "responded", responseCode: outcome.finalCode });
      const title = `${label(sub)} responded (${outcome.finalCode}): ${sub.title}`;
      await pushNotifications(app.db, [
        { companyId: req.companyId!, userId: sub.createdBy, projectId: sub.projectId, kind: "status_change", title, recordType: "submittal", recordId: sub.id },
        ...sub.distribution.map((userId) => ({ companyId: req.companyId!, userId, projectId: sub.projectId, kind: "status_change" as const, title, recordType: "submittal", recordId: sub.id })),
      ]);
      return { stepId, responseCode: body.responseCode, submittalStatus: "responded", finalCode: outcome.finalCode };
    }
    if (outcome.kind === "advanced") {
      await ledgerSubmittal("update", sub.id, req.companyId!, req.user!.id, sub.projectId, { ballInCourtId: outcome.nextBic });
      await notifyGroup(req.companyId!, sub.projectId, sub, outcome.nextReviewers);
    }
    return { stepId, responseCode: body.responseCode, submittalStatus: "in_review", ballInCourtId: outcome.nextBic };
  }

  app.post("/submittal-steps/:stepId/respond", { preHandler: companyGate }, async (req) => {
    const { stepId } = req.params as { stepId: string };
    return respondToStep(req, stepId, stepRespondSchema.parse(req.body));
  });

  app.post("/projects/:projectId/submittals/:submittalId/steps/:stepId/respond", { preHandler: standardGate }, async (req) => {
    const { stepId } = req.params as { stepId: string };
    return respondToStep(req, stepId, stepRespondSchema.parse(req.body));
  });

  /** Repair path: finalise a stranded chain or re-derive ball in court. */
  app.post("/projects/:projectId/submittals/:submittalId/recompute", { preHandler: standardGate }, async (req) => {
    const { submittalId } = req.params as { submittalId: string };
    const codes = await companyCodes(req.companyId!);
    const now = nowIso();
    const result = await app.db.transaction(async (tx) => {
      const sub = (await tx.select().from(submittals).where(and(eq(submittals.id, submittalId), eq(submittals.companyId, req.companyId!), eq(submittals.projectId, req.projectId!))).for("update"))[0];
      if (!sub) throw notFound("Submittal not found");
      if (sub.status !== "in_review") return { action: "none" as const, sub };
      const steps = await tx.select().from(submittalReviewSteps).where(eq(submittalReviewSteps.submittalId, sub.id)).orderBy(asc(submittalReviewSteps.position));
      const group = firstPendingGroup(steps);
      if (!group) {
        const finalCode = resolveFinalCode(steps.map((s) => s.responseCode), codes) ?? "approved";
        await tx.update(submittals).set({ status: "responded", responseCode: finalCode, respondedBy: req.user!.id, respondedAt: now, ballInCourtId: sub.createdBy, updatedAt: now }).where(eq(submittals.id, sub.id));
        return { action: "finalised" as const, sub, finalCode };
      }
      const bic = group.steps[0]!.reviewerId;
      if (bic !== sub.ballInCourtId) {
        await tx.update(submittals).set({ ballInCourtId: bic, updatedAt: now }).where(eq(submittals.id, sub.id));
        await tx.update(submittalReviewSteps).set({ activatedAt: now }).where(and(inArray(submittalReviewSteps.id, group.steps.map((s) => s.id)), isNull(submittalReviewSteps.activatedAt)));
        return { action: "rebalanced" as const, sub, bic };
      }
      return { action: "none" as const, sub };
    });
    if (result.action !== "none") {
      await ledgerSubmittal("state_change", submittalId, req.companyId!, req.user!.id, req.projectId!, { repair: result.action, ...(result.action === "finalised" ? { responseCode: result.finalCode } : { ballInCourtId: result.bic }) });
    }
    return { action: result.action, submittal: await fetchSubmittal(submittalId, req.companyId!, req.projectId!) };
  });

  /* ---------------------------------------------------------------- */
  /* Resubmit (#340) / close                                           */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/submittals/:submittalId/resubmit", { preHandler: standardGate }, async (req, reply) => {
    const { submittalId } = req.params as { submittalId: string };
    const body = resubmitSchema.parse(req.body ?? {}) ?? {};
    const codes = await companyCodes(req.companyId!);
    const id = newId("sub");
    const created = await app.db.transaction(async (tx) => {
      const row = (await tx.select().from(submittals).where(and(eq(submittals.id, submittalId), eq(submittals.companyId, req.companyId!), eq(submittals.projectId, req.projectId!))).for("update"))[0];
      if (!row) throw notFound("Submittal not found");
      if (row.supersededById) throw conflict("This revision has already been resubmitted");
      if (row.status !== "responded") throw badRequest("Only a responded submittal can be resubmitted");
      if (!row.responseCode || !isResubmitCode(row.responseCode, codes)) {
        throw badRequest("Resubmission requires a revise-and-resubmit or rejected response");
      }
      const maxRow = (await tx.select({ maxRev: submittals.revision }).from(submittals).where(and(eq(submittals.projectId, req.projectId!), eq(submittals.number, row.number))).orderBy(desc(submittals.revision)).limit(1))[0];
      const revision = Number(maxRow?.maxRev ?? row.revision) + 1;
      const now = nowIso();
      await tx.insert(submittals).values({
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
        reviewAllowanceDays: row.reviewAllowanceDays,
        submitByDate: row.submitByDate,
        fileIds: body.copyFiles ? row.fileIds : [],
        distribution: row.distribution,
        isCloseout: row.isCloseout,
        vendorId: row.vendorId,
        previousId: row.id,
        createdBy: req.user!.id,
      });
      await tx.update(submittals).set({ status: "superseded", supersededById: id, updatedAt: now }).where(eq(submittals.id, row.id));
      if (body.copyReviewChain) {
        const steps = await tx.select().from(submittalReviewSteps).where(eq(submittalReviewSteps.submittalId, row.id)).orderBy(asc(submittalReviewSteps.position));
        if (steps.length > 0) {
          await tx.insert(submittalReviewSteps).values(
            steps.map((s) => ({ id: newId("subs"), submittalId: id, position: s.position, reviewerId: s.reviewerId, isParallel: s.isParallel })),
          );
        }
      }
      return { row, revision };
    });
    await ledgerSubmittal("create", id, req.companyId!, req.user!.id, req.projectId!, { number: created.row.number, revision: created.revision, previousId: created.row.id });
    await ledgerSubmittal("state_change", created.row.id, req.companyId!, req.user!.id, req.projectId!, { from: "responded", to: "superseded", supersededById: id });
    return reply.status(201).send(await fetchSubmittal(id, req.companyId!, req.projectId!));
  });

  app.post("/projects/:projectId/submittals/:submittalId/close", { preHandler: standardGate }, async (req) => {
    const { submittalId } = req.params as { submittalId: string };
    const row = await fetchSubmittal(submittalId, req.companyId!, req.projectId!);
    if (row.status !== "open" && row.status !== "responded") {
      throw badRequest("Only an open or responded submittal can be closed");
    }
    const now = nowIso();
    await app.db.update(submittals).set({ status: "closed", closedAt: now, updatedAt: now }).where(eq(submittals.id, submittalId));
    await ledgerSubmittal("state_change", submittalId, req.companyId!, req.user!.id, req.projectId!, { from: row.status, to: "closed" });
    const title = `${label(row)} closed: ${row.title}`;
    await pushNotifications(
      app.db,
      row.distribution.map((userId) => ({ companyId: req.companyId!, userId, projectId: req.projectId!, kind: "status_change" as const, title, recordType: "submittal", recordId: submittalId })),
    );
    return fetchSubmittal(submittalId, req.companyId!, req.projectId!);
  });
};

