/**
 * THE SKILLS & CERTIFICATION MATRIX (spec Vol I #692–696).
 *
 * Workers come from `workers` (workforce.ts). This module records what each
 * of them holds, who checked it, and when it lapses — and it keeps those
 * three facts apart:
 *
 *   · the CLAIM   — a worker (or their employer) says they hold a ticket;
 *   · the CHECK   — somebody other than the claimant verified the evidence;
 *   · the EXPIRY  — a date, independent of both.
 *
 * VERIFICATION IS SEGREGATED. The route refuses a verification by the same
 * person who recorded the claim: a certificate checked by the person who
 * benefits from it is not checked. The refusal names the control rather than
 * saying "forbidden", because a control that cannot be explained gets worked
 * around.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, eq, gte, inArray, lte, ne } from "drizzle-orm";
import {
  resourceAssignments,
  resourceSkills,
  resourceTypes,
  workerSkills,
  workers,
} from "@constructos/db";
import { ACTIVE_ASSIGNMENT_STATUSES } from "@constructos/shared";
import { newId } from "../../../lib/ids.js";
import { AppError, badRequest, notFound } from "../../../lib/errors.js";
import { pageOffset, paginate } from "../../../lib/pagination.js";
import { addDays } from "../engines/calendar.js";
import {
  EXPIRY_WARN_DAYS,
  buildSkillsMatrix,
  classifyValidity,
  detectSkillGaps,
  type AssignedWorker,
  type SkillDefinition,
  type WorkerRef,
  type WorkerSkillCell,
} from "../engines/skills.js";
import {
  actorOf,
  companyOf,
  fetchSkill,
  ledgerResources,
  nowIso,
  projectOf,
  resourceGates,
  todayIso,
} from "../shared.js";
import * as S from "../schemas.js";

/** Matrix size cap — a project with more workers than this is paged instead. */
const MAX_MATRIX_WORKERS = 2000;

export const matrixRoutes: FastifyPluginAsync = async (app) => {
  const gates = resourceGates(app);

  /* ================================================================== */
  /* Matrix cells                                                        */
  /* ================================================================== */

  app.post("/projects/:projectId/worker-skills", { preHandler: gates.standard }, async (req, reply) => {
    const body = S.workerSkillUpsertSchema.parse(req.body);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const worker = await requireWorker(body.workerId, companyId, projectId);
    const skill = await fetchSkill(app.db, body.skillId, companyId);
    if (body.issuedAt && body.expiresAt && body.expiresAt < body.issuedAt) {
      throw badRequest("expiresAt must not precede issuedAt");
    }

    const existing = await app.db
      .select()
      .from(workerSkills)
      .where(and(eq(workerSkills.workerId, body.workerId), eq(workerSkills.skillId, body.skillId)))
      .limit(1);

    if (existing[0]) {
      /* Re-recording a ticket is the renewal path. It resets verification:
         a new certificate has not been checked just because the old one was. */
      const at = nowIso();
      await app.db
        .update(workerSkills)
        .set({
          level: body.level ?? existing[0].level,
          certificateRef: body.certificateRef ?? existing[0].certificateRef,
          issuingBody: body.issuingBody ?? existing[0].issuingBody ?? skill.issuingBody,
          issuedAt: body.issuedAt ?? existing[0].issuedAt,
          expiresAt: body.expiresAt ?? existing[0].expiresAt,
          evidenceFileIds: body.evidenceFileIds ?? existing[0].evidenceFileIds,
          notes: body.notes ?? existing[0].notes,
          status: "claimed",
          verifiedBy: null,
          verifiedAt: null,
          rejectedReason: null,
          expiryNotifiedAt: null,
          expiryNotifiedForDate: null,
          detail: { ...(existing[0].detail ?? {}), ...(body.detail ?? {}) },
          updatedAt: at,
        })
        .where(eq(workerSkills.id, existing[0].id));
      await ledgerResources(app.db, req, "update", "worker_skill", existing[0].id, {
        workerId: body.workerId,
        workerReference: worker.reference,
        skillId: body.skillId,
        skillCode: skill.code,
        expiresAt: body.expiresAt ?? existing[0].expiresAt,
        verificationReset: true,
      });
      return reply.status(200).send(await cellView(existing[0].id));
    }

    const id = newId("wsk");
    await app.db.insert(workerSkills).values({
      id,
      companyId,
      projectId,
      workerId: body.workerId,
      skillId: body.skillId,
      level: body.level ?? "competent",
      status: "claimed",
      certificateRef: body.certificateRef ?? null,
      issuingBody: body.issuingBody ?? skill.issuingBody ?? null,
      issuedAt: body.issuedAt ?? null,
      expiresAt: body.expiresAt ?? null,
      evidenceFileIds: body.evidenceFileIds ?? [],
      source: "manual",
      notes: body.notes ?? null,
      detail: body.detail ?? {},
      createdBy: actorOf(req),
    });
    await ledgerResources(app.db, req, "create", "worker_skill", id, {
      workerId: body.workerId,
      workerReference: worker.reference,
      skillId: body.skillId,
      skillCode: skill.code,
      expiresAt: body.expiresAt ?? null,
    });
    return reply.status(201).send(await cellView(id));
  });

  app.get("/projects/:projectId/worker-skills", { preHandler: gates.read }, async (req) => {
    const q = S.workerSkillListQuery.parse(req.query);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const clauses = [eq(workerSkills.companyId, companyId), eq(workerSkills.projectId, projectId)];
    if (q.workerId) clauses.push(eq(workerSkills.workerId, q.workerId));
    if (q.skillId) clauses.push(eq(workerSkills.skillId, q.skillId));
    if (q.status) clauses.push(eq(workerSkills.status, q.status));
    if (q.expiringWithinDays !== undefined) {
      clauses.push(lte(workerSkills.expiresAt, addDays(todayIso(), q.expiringWithinDays)));
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(workerSkills).where(where);
    const rows = await app.db
      .select({
        cell: workerSkills,
        workerReference: workers.reference,
        workerName: workers.fullName,
        skillCode: resourceSkills.code,
        skillName: resourceSkills.name,
        skillCategory: resourceSkills.category,
        isMandatory: resourceSkills.isMandatory,
      })
      .from(workerSkills)
      .innerJoin(workers, eq(workers.id, workerSkills.workerId))
      .innerJoin(resourceSkills, eq(resourceSkills.id, workerSkills.skillId))
      .where(where)
      .orderBy(asc(workers.reference), asc(resourceSkills.code))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const today = todayIso();
    return paginate(
      rows.map((r) => {
        const validity = classifyValidity(r.cell.expiresAt, today);
        return {
          ...r.cell,
          workerReference: r.workerReference,
          workerName: r.workerName,
          skillCode: r.skillCode,
          skillName: r.skillName,
          skillCategory: r.skillCategory,
          isMandatory: r.isMandatory === 1,
          validity: validity.state,
          daysToExpiry: validity.daysToExpiry,
          validityReason: validity.reason,
        };
      }),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.patch(
    "/projects/:projectId/worker-skills/:cellId",
    { preHandler: gates.standard },
    async (req) => {
      const { cellId } = req.params as { cellId: string };
      const body = S.workerSkillPatchSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const cell = await fetchCell(cellId, companyId, projectId);
      const issuedAt = body.issuedAt !== undefined ? body.issuedAt : cell.issuedAt;
      const expiresAt = body.expiresAt !== undefined ? body.expiresAt : cell.expiresAt;
      if (issuedAt && expiresAt && expiresAt < issuedAt) {
        throw badRequest("expiresAt must not precede issuedAt");
      }
      const set: Record<string, unknown> = { updatedAt: nowIso() };
      const direct = [
        "level",
        "certificateRef",
        "issuingBody",
        "issuedAt",
        "expiresAt",
        "evidenceFileIds",
        "notes",
      ] as const;
      for (const key of direct) if (body[key] !== undefined) set[key] = body[key];
      if (body.detail !== undefined) set["detail"] = { ...(cell.detail ?? {}), ...body.detail };
      /* Changing the certificate or its dates invalidates the check: the
         verification was of the old evidence. */
      const touchesEvidence =
        body.certificateRef !== undefined ||
        body.issuedAt !== undefined ||
        body.expiresAt !== undefined ||
        body.evidenceFileIds !== undefined;
      if (touchesEvidence && cell.status === "verified") {
        set["status"] = "claimed";
        set["verifiedBy"] = null;
        set["verifiedAt"] = null;
      }
      if (body.expiresAt !== undefined) {
        set["expiryNotifiedAt"] = null;
        set["expiryNotifiedForDate"] = null;
      }
      await app.db.update(workerSkills).set(set).where(eq(workerSkills.id, cellId));
      await ledgerResources(app.db, req, "update", "worker_skill", cellId, {
        workerId: cell.workerId,
        skillId: cell.skillId,
        changed: Object.keys(body),
        verificationReset: touchesEvidence && cell.status === "verified",
      });
      return cellView(cellId);
    },
  );

  /**
   * Verify, reject or revoke. Segregated from the claim: the person who
   * recorded the ticket may not be the person who attests to it.
   */
  app.post(
    "/projects/:projectId/worker-skills/:cellId/verify",
    { preHandler: gates.admin },
    async (req) => {
      const { cellId } = req.params as { cellId: string };
      const body = S.workerSkillVerifySchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const actorId = actorOf(req);
      const cell = await fetchCell(cellId, companyId, projectId);
      const skill = await fetchSkill(app.db, cell.skillId, companyId);

      if (body.decision === "verify" && cell.createdBy === actorId) {
        throw new AppError(
          403,
          "Segregation of duties: the person who recorded this certification may not verify it. " +
            "A ticket checked by the person who entered it is not checked, and it is the record " +
            "somebody relies on before putting a worker on a machine.",
          { control: "no_self_verification", cellId, skillCode: skill.code },
        );
      }
      if (body.decision === "verify" && skill.requiresEvidence === 1 && !cell.certificateRef) {
        throw badRequest(
          `${skill.name} requires evidence, and no certificate reference is recorded against this ` +
            "worker. Record the certificate before verifying it.",
        );
      }
      if (body.decision !== "verify" && !body.reason) {
        throw badRequest(
          `A ${body.decision} needs a reason on the record — it removes somebody's qualification.`,
        );
      }

      const at = nowIso();
      const status = body.decision === "verify" ? "verified" : body.decision === "reject" ? "rejected" : "revoked";
      await app.db
        .update(workerSkills)
        .set({
          status,
          verifiedBy: body.decision === "verify" ? actorId : null,
          verifiedAt: body.decision === "verify" ? at : null,
          rejectedReason: body.decision === "verify" ? null : (body.reason ?? null),
          updatedAt: at,
        })
        .where(eq(workerSkills.id, cellId));
      await ledgerResources(app.db, req, "state_change", "worker_skill", cellId, {
        workerId: cell.workerId,
        skillId: cell.skillId,
        skillCode: skill.code,
        from: cell.status,
        to: status,
        reason: body.reason ?? null,
      });
      return cellView(cellId);
    },
  );

  /* ================================================================== */
  /* The matrix                                                          */
  /* ================================================================== */

  app.get("/projects/:projectId/resources/skills-matrix", { preHandler: gates.read }, async (req) => {
    const q = S.matrixQuery.parse(req.query);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const warnDays = q.warnDays ?? EXPIRY_WARN_DAYS;

    const skillClauses = [
      eq(resourceSkills.companyId, companyId),
      eq(resourceSkills.status, "active"),
    ];
    if (q.category) skillClauses.push(eq(resourceSkills.category, q.category));
    if (q.trade) skillClauses.push(eq(resourceSkills.trade, q.trade));
    const skillRows = await app.db
      .select()
      .from(resourceSkills)
      .where(and(...skillClauses))
      .orderBy(asc(resourceSkills.code));

    const workerRows = await app.db
      .select()
      .from(workers)
      .where(
        and(
          eq(workers.companyId, companyId),
          eq(workers.projectId, projectId),
          ne(workers.status, "demobilised"),
        ),
      )
      .orderBy(asc(workers.reference))
      .limit(MAX_MATRIX_WORKERS + 1);
    const truncated = workerRows.length > MAX_MATRIX_WORKERS;
    const keptWorkers = truncated ? workerRows.slice(0, MAX_MATRIX_WORKERS) : workerRows;

    const cellRows =
      keptWorkers.length > 0 && skillRows.length > 0
        ? await app.db
            .select()
            .from(workerSkills)
            .where(
              and(
                eq(workerSkills.companyId, companyId),
                eq(workerSkills.projectId, projectId),
                inArray(
                  workerSkills.skillId,
                  skillRows.map((s) => s.id),
                ),
              ),
            )
        : [];

    const matrix = buildSkillsMatrix(
      keptWorkers.map(toWorkerRef),
      skillRows.map(toSkillDefinition),
      cellRows.map(toCell),
      { today: todayIso(), warnDays },
    );
    const rows =
      q.onlyGaps === "true"
        ? matrix.rows.filter((r) => r.gapCount > 0 || r.expiredCount > 0 || r.expiringCount > 0)
        : matrix.rows;

    return {
      ...matrix,
      rows,
      warnDays,
      truncated,
      reasons: [
        ...matrix.reasons,
        ...(truncated
          ? [
              `Only the first ${MAX_MATRIX_WORKERS} workers are shown. Filter by trade or ` +
                "certification category to see the rest.",
            ]
          : []),
      ],
    };
  });

  /**
   * Workers booked onto work whose resource type demands a ticket they do
   * not hold, hold expired, or whose ticket lapses part-way through the
   * booking. The last of those is the one nobody catches by hand.
   */
  app.get("/projects/:projectId/resources/skill-gaps", { preHandler: gates.read }, async (req) => {
    const q = S.skillGapQuery.parse(req.query);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const from = q.from ?? todayIso();
    const to = q.to ?? addDays(from, 90);
    if (to < from) throw badRequest("`to` must not precede `from`");

    const gaps = await computeSkillGaps(app.db, companyId, projectId, from, to, todayIso());
    return {
      window: { from, to },
      total: gaps.gaps.length,
      items: gaps.gaps,
      workersConsidered: gaps.workersConsidered,
      reasons: gaps.reasons,
    };
  });

  /* ================================================================== */
  /* Helpers                                                             */
  /* ================================================================== */

  async function requireWorker(workerId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(workers)
      .where(
        and(
          eq(workers.id, workerId),
          eq(workers.companyId, companyId),
          eq(workers.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) {
      throw badRequest(
        `workerId ${workerId} is not on this project's worker register. Certifications are recorded ` +
          "against enrolled workers — this module keeps no second person table.",
      );
    }
    return rows[0];
  }

  async function fetchCell(cellId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(workerSkills)
      .where(
        and(
          eq(workerSkills.id, cellId),
          eq(workerSkills.companyId, companyId),
          eq(workerSkills.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Worker skill record not found on this project");
    return rows[0];
  }

  async function cellView(cellId: string) {
    const rows = await app.db
      .select({
        cell: workerSkills,
        workerReference: workers.reference,
        workerName: workers.fullName,
        skillCode: resourceSkills.code,
        skillName: resourceSkills.name,
        skillCategory: resourceSkills.category,
        isMandatory: resourceSkills.isMandatory,
        requiresEvidence: resourceSkills.requiresEvidence,
      })
      .from(workerSkills)
      .innerJoin(workers, eq(workers.id, workerSkills.workerId))
      .innerJoin(resourceSkills, eq(resourceSkills.id, workerSkills.skillId))
      .where(eq(workerSkills.id, cellId))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Worker skill record not found");
    const validity = classifyValidity(row.cell.expiresAt, todayIso());
    return {
      ...row.cell,
      workerReference: row.workerReference,
      workerName: row.workerName,
      skillCode: row.skillCode,
      skillName: row.skillName,
      skillCategory: row.skillCategory,
      isMandatory: row.isMandatory === 1,
      requiresEvidence: row.requiresEvidence === 1,
      validity: validity.state,
      daysToExpiry: validity.daysToExpiry,
      validityReason: validity.reason,
    };
  }
};

/* ------------------------------------------------------------------ */
/* Shared with the sweeps                                              */
/* ------------------------------------------------------------------ */

export const toWorkerRef = (w: typeof workers.$inferSelect): WorkerRef => ({
  id: w.id,
  reference: w.reference,
  fullName: w.fullName,
  trade: w.trade,
  vendorId: w.vendorId,
  status: w.status,
});

export const toSkillDefinition = (s: typeof resourceSkills.$inferSelect): SkillDefinition => ({
  id: s.id,
  code: s.code,
  name: s.name,
  category: s.category as SkillDefinition["category"],
  trade: s.trade,
  validityMonths: s.validityMonths,
  isMandatory: s.isMandatory === 1,
  requiresEvidence: s.requiresEvidence === 1,
});

export const toCell = (c: typeof workerSkills.$inferSelect): WorkerSkillCell => ({
  workerId: c.workerId,
  skillId: c.skillId,
  level: c.level,
  status: c.status as WorkerSkillCell["status"],
  issuedAt: c.issuedAt,
  expiresAt: c.expiresAt,
  certificateRef: c.certificateRef,
});

/**
 * Skill gaps over the bookings that overlap a window. Shared by the route and
 * the certification sweep so the page and the signal register can never
 * disagree about who is short of a ticket.
 */
export async function computeSkillGaps(
  db: import("../../../lib/db.js").Db,
  companyId: string,
  projectId: string,
  from: string,
  to: string,
  /** The date validity is judged as at — today, not the window start. A
   *  window that begins in the past must not make a lapsed ticket look
   *  current. */
  today: string,
) {
  const bookings = await db
    .select({
      id: resourceAssignments.id,
      reference: resourceAssignments.reference,
      workerId: resourceAssignments.workerId,
      crewId: resourceAssignments.crewId,
      subjectLabel: resourceAssignments.subjectLabel,
      fromDate: resourceAssignments.fromDate,
      toDate: resourceAssignments.toDate,
      resourceTypeId: resourceAssignments.resourceTypeId,
    })
    .from(resourceAssignments)
    .where(
      and(
        eq(resourceAssignments.companyId, companyId),
        eq(resourceAssignments.projectId, projectId),
        inArray(resourceAssignments.status, [...ACTIVE_ASSIGNMENT_STATUSES]),
        lte(resourceAssignments.fromDate, to),
        gte(resourceAssignments.toDate, from),
      ),
    )
    .limit(5000);

  const reasons: string[] = [];
  const typeIds = [
    ...new Set(bookings.map((b) => b.resourceTypeId).filter((id): id is string => Boolean(id))),
  ];
  const types =
    typeIds.length > 0
      ? await db
          .select({ id: resourceTypes.id, requiredSkillIds: resourceTypes.requiredSkillIds })
          .from(resourceTypes)
          .where(and(eq(resourceTypes.companyId, companyId), inArray(resourceTypes.id, typeIds)))
      : [];
  const requiredByType = new Map(types.map((t) => [t.id, t.requiredSkillIds]));

  const workerBookings: AssignedWorker[] = [];
  let crewBookings = 0;
  for (const booking of bookings) {
    const required = booking.resourceTypeId
      ? (requiredByType.get(booking.resourceTypeId) ?? [])
      : [];
    if (required.length === 0) continue;
    if (!booking.workerId) {
      crewBookings += 1;
      continue;
    }
    workerBookings.push({
      assignmentId: booking.id,
      assignmentReference: booking.reference,
      workerId: booking.workerId,
      workerLabel: booking.subjectLabel,
      fromDate: booking.fromDate,
      toDate: booking.toDate,
      requiredSkillIds: required,
    });
  }
  if (crewBookings > 0) {
    reasons.push(
      `${crewBookings} booking(s) in this window are of a crew or a machine rather than a named ` +
        "worker, so the ticket check cannot be run against them. Book the individuals whose " +
        "qualifications matter, or check the crew's members in the matrix.",
    );
  }
  if (bookings.length > 0 && workerBookings.length === 0 && crewBookings === 0) {
    reasons.push(
      "No booking in this window names a resource type that requires a certification, so there is " +
        "nothing to check. Set required skills on the resource types the work is booked against.",
    );
  }

  const workerIds = [...new Set(workerBookings.map((b) => b.workerId))];
  const skillIds = [...new Set(workerBookings.flatMap((b) => b.requiredSkillIds))];
  const skillRows =
    skillIds.length > 0
      ? await db
          .select()
          .from(resourceSkills)
          .where(and(eq(resourceSkills.companyId, companyId), inArray(resourceSkills.id, skillIds)))
      : [];
  const cellRows =
    workerIds.length > 0
      ? await db
          .select()
          .from(workerSkills)
          .where(
            and(
              eq(workerSkills.companyId, companyId),
              eq(workerSkills.projectId, projectId),
              inArray(workerSkills.workerId, workerIds),
            ),
          )
      : [];

  const gaps = detectSkillGaps(
    workerBookings,
    skillRows.map(toSkillDefinition),
    cellRows.map(toCell),
    { today },
  );
  return { gaps, workersConsidered: workerIds.length, reasons };
}
