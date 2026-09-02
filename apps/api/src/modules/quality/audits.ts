/**
 * Quality audits (#1095) and the ISO 9001 evidence pack (#1096).
 *
 * An audit is worth keeping only for its FINDINGS, and a finding is worth
 * keeping only if it carries three things: the requirement (quoted, not
 * paraphrased), the evidence seen, and the conclusion drawn. A register of
 * conclusions with no evidence is an opinion log, and it is the first thing a
 * certification body discounts.
 *
 * The evidence pack answers the other direction. A surveillance auditor asks
 * "show me how you control non-conforming output" (clause 8.7), and the honest
 * answer is a count of the records that exist plus a link to them — or, where
 * the platform holds nothing, an explicit statement that the clause is
 * unevidenced HERE. Reporting an unevidenced clause as compliant is the one
 * thing a QMS tool must never do.
 */

import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import {
  checklistTemplates,
  checklists,
  commissioningTestRecords,
  inspectionTestPlans,
  itpActivities,
  materialTestCertificates,
  ndtRecords,
  nonConformanceReports,
  operatorTrainingRecords,
  qualityAuditFindings,
  qualityAudits,
  qualityConcessions,
  reworkItems,
  turnoverPackages,
  calibratedInstruments,
} from "@constructos/db";
import {
  AUDIT_FINDING_STATUSES,
  AUDIT_FINDING_TYPES,
  AUDIT_STATUSES,
  AUDIT_TYPES,
  ISO_9001_CLAUSES,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { pushNotifications } from "../notifications/service.js";
import type { Db } from "../../lib/db.js";
import {
  allocateReference,
  alreadySignalled,
  assertDistinctActor,
  assertVendor,
  buildGates,
  fileIdsSchema,
  idSchema,
  isoDateSchema,
  ledger,
  nowISO,
  patchSet,
  QUALITY_DETECTORS,
  raiseSignal,
  round2,
  todayISO,
} from "./shared.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const auditCreateSchema = z.object({
  title: z.string().min(1).max(300),
  auditType: z.enum(AUDIT_TYPES).optional(),
  standard: z.string().max(200).nullable().optional(),
  scope: z.string().max(10_000).nullable().optional(),
  objectives: z.string().max(10_000).nullable().optional(),
  clauseReferences: z.array(z.string().max(100)).max(100).optional(),
  auditedVendorId: idSchema.nullable().optional(),
  auditedFunction: z.string().max(200).nullable().optional(),
  leadAuditorId: idSchema.nullable().optional(),
  leadAuditorName: z.string().max(200).nullable().optional(),
  leadAuditorOrganisation: z.string().max(200).nullable().optional(),
  auditTeam: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
  plannedDate: isoDateSchema.nullable().optional(),
  responseDueDate: isoDateSchema.nullable().optional(),
  nextAuditDueDate: isoDateSchema.nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const AUDIT_PATCH_COLUMNS = [
  "title",
  "auditType",
  "standard",
  "scope",
  "objectives",
  "clauseReferences",
  "auditedVendorId",
  "auditedFunction",
  "leadAuditorId",
  "leadAuditorName",
  "leadAuditorOrganisation",
  "auditTeam",
  "plannedDate",
  "responseDueDate",
  "nextAuditDueDate",
  "detail",
] as const;

const findingCreateSchema = z.object({
  findingType: z.enum(AUDIT_FINDING_TYPES),
  description: z.string().min(1).max(20_000),
  clauseReference: z.string().max(200).nullable().optional(),
  requirement: z.string().max(10_000).nullable().optional(),
  evidence: z.string().max(20_000).nullable().optional(),
  responsibleUserId: idSchema.nullable().optional(),
  responsibleVendorId: idSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  responseDueDate: isoDateSchema.nullable().optional(),
  attachmentFileIds: fileIdsSchema.optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const FINDING_PATCH_COLUMNS = [
  "findingType",
  "description",
  "clauseReference",
  "requirement",
  "evidence",
  "responsibleUserId",
  "responsibleVendorId",
  "dueDate",
  "responseDueDate",
  "attachmentFileIds",
  "detail",
] as const;

const OPEN_FINDING_STATUSES = ["open", "response_received", "action_agreed", "action_complete"];

const NONCONFORMITY_TYPES = ["major_nonconformity", "minor_nonconformity"];

/* ------------------------------------------------------------------ */
/* Overdue findings sweep                                              */
/* ------------------------------------------------------------------ */

export async function sweepAuditFindings(
  db: Db,
  companyId: string,
  asOf: string = todayISO(),
): Promise<{ raised: number }> {
  const rows = await db
    .select()
    .from(qualityAuditFindings)
    .where(
      and(
        eq(qualityAuditFindings.companyId, companyId),
        inArray(qualityAuditFindings.status, OPEN_FINDING_STATUSES),
        lt(qualityAuditFindings.dueDate, asOf),
      ),
    );
  if (rows.length === 0) return { raised: 0 };
  const seen = await alreadySignalled(db, companyId, QUALITY_DETECTORS.auditFindingOverdue);
  let raised = 0;
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    await raiseSignal(db, companyId, row.projectId, null, {
      detector: QUALITY_DETECTORS.auditFindingOverdue,
      severity: row.findingType === "major_nonconformity" ? "high" : "medium",
      confidence: 1,
      title: `Audit finding ${row.reference} is past its close-out date`,
      explanation:
        `${row.reference} (${row.findingType.replace(/_/g, " ")}${row.clauseReference ? `, clause ${row.clauseReference}` : ""}) was due to be closed by ` +
        `${row.dueDate} and is still ${row.status.replace(/_/g, " ")}. ` +
        `${row.description.slice(0, 400)} ` +
        `An audit finding that outlives its close-out date is the finding the next audit opens with, and a major non-conformity left open past its ` +
        `date is a certification issue rather than a project one.`,
      key: row.id,
      evidence: {
        findingId: row.id,
        auditId: row.auditId,
        reference: row.reference,
        findingType: row.findingType,
        dueDate: row.dueDate,
        status: row.status,
        responsibleUserId: row.responsibleUserId,
      },
    });
    if (row.status === "open") {
      await db
        .update(qualityAuditFindings)
        .set({ updatedAt: nowISO() })
        .where(eq(qualityAuditFindings.id, row.id));
    }
    raised += 1;
  }
  return { raised };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const auditRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);

  async function fetchAudit(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(qualityAudits)
      .where(
        and(
          eq(qualityAudits.id, id),
          eq(qualityAudits.companyId, companyId),
          eq(qualityAudits.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Quality audit not found");
    return rows[0];
  }

  async function findingsOf(auditId: string) {
    return app.db
      .select()
      .from(qualityAuditFindings)
      .where(eq(qualityAuditFindings.auditId, auditId))
      .orderBy(asc(qualityAuditFindings.position));
  }

  /** Counters are recomputed from the findings, never incremented in place. */
  async function refreshCounters(auditId: string) {
    const findings = await findingsOf(auditId);
    const major = findings.filter((f) => f.findingType === "major_nonconformity").length;
    const minor = findings.filter((f) => f.findingType === "minor_nonconformity").length;
    const observations = findings.filter((f) => f.findingType === "observation").length;
    const open = findings.filter((f) => OPEN_FINDING_STATUSES.includes(f.status)).length;
    const nonConformities = major + minor;
    const conformityPercent =
      findings.length === 0 ? null : round2(((findings.length - nonConformities) / findings.length) * 100);
    await app.db
      .update(qualityAudits)
      .set({
        findingCount: findings.length,
        majorFindingCount: major,
        minorFindingCount: minor,
        observationCount: observations,
        openFindingCount: open,
        conformityPercent,
        updatedAt: nowISO(),
      })
      .where(eq(qualityAudits.id, auditId));
    return findings;
  }

  app.post("/projects/:projectId/quality-audits", { preHandler: standardGate }, async (req, reply) => {
    const body = auditCreateSchema.parse(req.body);
    if (body.auditedVendorId) await assertVendor(app.db, req.companyId!, body.auditedVendorId);
    const { number, reference } = await allocateReference(app.db, req.projectId!, "quality_audit", "QA");
    const id = newId("qad");
    const [created] = await app.db
      .insert(qualityAudits)
      .values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        reference,
        title: body.title,
        auditType: body.auditType ?? "internal",
        standard: body.standard ?? null,
        scope: body.scope ?? null,
        objectives: body.objectives ?? null,
        clauseReferences: body.clauseReferences ?? [],
        auditedVendorId: body.auditedVendorId ?? null,
        auditedFunction: body.auditedFunction ?? null,
        leadAuditorId: body.leadAuditorId ?? null,
        leadAuditorName: body.leadAuditorName ?? null,
        leadAuditorOrganisation: body.leadAuditorOrganisation ?? null,
        auditTeam: body.auditTeam ?? [],
        plannedDate: body.plannedDate ?? null,
        responseDueDate: body.responseDueDate ?? null,
        nextAuditDueDate: body.nextAuditDueDate ?? null,
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "quality_audit",
      objectId: id,
      payload: created,
      storePayload: true,
    });
    return reply.status(201).send({ ...created, findings: [] });
  });

  app.get("/projects/:projectId/quality-audits", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        status: z.enum(AUDIT_STATUSES).optional(),
        auditType: z.enum(AUDIT_TYPES).optional(),
        auditedVendorId: idSchema.optional(),
        search: z.string().max(200).optional(),
      })
      .parse(req.query);
    const clauses = [
      eq(qualityAudits.companyId, req.companyId!),
      eq(qualityAudits.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(qualityAudits.status, q.status));
    if (q.auditType) clauses.push(eq(qualityAudits.auditType, q.auditType));
    if (q.auditedVendorId) clauses.push(eq(qualityAudits.auditedVendorId, q.auditedVendorId));
    if (q.search) clauses.push(ilike(qualityAudits.title, `%${q.search}%`));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(qualityAudits).where(where);
    const rows = await app.db
      .select()
      .from(qualityAudits)
      .where(where)
      .orderBy(desc(qualityAudits.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/quality-audits/:id", { preHandler: readGate }, async (req) => {
    const { id } = req.params as { id: string };
    const audit = await fetchAudit(id, req.companyId!, req.projectId!);
    return { ...audit, findings: await findingsOf(id) };
  });

  app.patch("/projects/:projectId/quality-audits/:id", { preHandler: standardGate }, async (req) => {
    const { id } = req.params as { id: string };
    const body = auditCreateSchema.partial().parse(req.body);
    const audit = await fetchAudit(id, req.companyId!, req.projectId!);
    if (audit.status === "closed") {
      throw badRequest(`${audit.reference} is closed; a closed audit report is not edited.`);
    }
    if (body.auditedVendorId) await assertVendor(app.db, req.companyId!, body.auditedVendorId);
    await app.db
      .update(qualityAudits)
      .set(patchSet(body as Record<string, unknown>, AUDIT_PATCH_COLUMNS))
      .where(eq(qualityAudits.id, id));
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "quality_audit",
      objectId: id,
      payload: { changed: Object.keys(body) },
    });
    return { ...(await fetchAudit(id, req.companyId!, req.projectId!)), findings: await findingsOf(id) };
  });

  app.post(
    "/projects/:projectId/quality-audits/:id/status",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({
          status: z.enum(["in_progress", "fieldwork_complete", "report_issued", "cancelled"]),
          reportFileId: idSchema.nullable().optional(),
          note: z.string().max(4000).nullable().optional(),
        })
        .parse(req.body);
      const audit = await fetchAudit(id, req.companyId!, req.projectId!);
      if (audit.status === "closed") throw badRequest(`${audit.reference} is closed.`);
      if (body.status === "report_issued") {
        const findings = await findingsOf(id);
        if (findings.length === 0) {
          throw badRequest(
            `${audit.reference} has no findings recorded. An audit report with no findings — not even a conformity — records that nobody looked, not that nothing was wrong.`,
          );
        }
      }
      const today = todayISO();
      await app.db
        .update(qualityAudits)
        .set({
          status: body.status,
          startedAt: body.status === "in_progress" ? (audit.startedAt ?? today) : audit.startedAt,
          completedAt:
            body.status === "fieldwork_complete" ? (audit.completedAt ?? today) : audit.completedAt,
          reportIssuedAt: body.status === "report_issued" ? today : audit.reportIssuedAt,
          reportFileId: body.reportFileId ?? audit.reportFileId,
          detail: { ...(audit.detail as Record<string, unknown>), lastStatusNote: body.note ?? null },
          updatedAt: nowISO(),
        })
        .where(eq(qualityAudits.id, id));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "quality_audit",
        objectId: id,
        payload: { from: audit.status, to: body.status, note: body.note ?? null },
        storePayload: true,
      });
      return { ...(await fetchAudit(id, req.companyId!, req.projectId!)), findings: await findingsOf(id) };
    },
  );

  app.post(
    "/projects/:projectId/quality-audits/:id/close",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({ note: z.string().max(4000).nullable().optional(), force: z.boolean().optional() })
        .parse(req.body ?? {});
      const audit = await fetchAudit(id, req.companyId!, req.projectId!);
      const findings = await findingsOf(id);
      const open = findings.filter((f) => OPEN_FINDING_STATUSES.includes(f.status));
      if (open.length > 0 && body.force !== true) {
        throw badRequest(
          `${audit.reference} still has ${open.length} open finding(s): ${open.map((f) => f.reference).join(", ")}. ` +
            `Closing an audit over open non-conformities is how they stop being tracked; close them, or force the closure and state why.`,
        );
      }
      const at = nowISO();
      await app.db
        .update(qualityAudits)
        .set({
          status: "closed",
          closedBy: req.user!.id,
          closedAt: at,
          detail: {
            ...(audit.detail as Record<string, unknown>),
            closureNote: body.note ?? null,
            closedOverOpenFindings: open.length > 0 ? open.map((f) => f.reference) : undefined,
          },
          updatedAt: at,
        })
        .where(eq(qualityAudits.id, id));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "quality_audit",
        objectId: id,
        payload: {
          from: audit.status,
          to: "closed",
          openFindingsAtClosure: open.map((f) => f.reference),
          note: body.note ?? null,
        },
        storePayload: true,
      });
      return { ...(await fetchAudit(id, req.companyId!, req.projectId!)), findings: await findingsOf(id) };
    },
  );

  /* ---------------- findings ---------------- */

  app.post(
    "/projects/:projectId/quality-audits/:id/findings",
    { preHandler: standardGate },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = findingCreateSchema.parse(req.body);
      const audit = await fetchAudit(id, req.companyId!, req.projectId!);
      if (audit.status === "closed") {
        throw badRequest(`${audit.reference} is closed; a finding is raised against a live audit.`);
      }
      if (NONCONFORMITY_TYPES.includes(body.findingType) && !body.requirement) {
        throw badRequest(
          "A non-conformity must quote the requirement it departs from. A finding that does not name the requirement cannot be answered, and cannot be defended if it is challenged.",
        );
      }
      if (NONCONFORMITY_TYPES.includes(body.findingType) && !body.evidence) {
        throw badRequest(
          "A non-conformity must record the evidence seen. Without it the register holds a conclusion nobody can retrace.",
        );
      }
      if (body.responsibleVendorId) {
        await assertVendor(app.db, req.companyId!, body.responsibleVendorId);
      }
      const existing = await findingsOf(id);
      const position = existing.length + 1;
      const findingId = newId("qaf");
      const [created] = await app.db
        .insert(qualityAuditFindings)
        .values({
          id: findingId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          auditId: id,
          position,
          reference: `${audit.reference}-F${String(position).padStart(2, "0")}`,
          findingType: body.findingType,
          clauseReference: body.clauseReference ?? null,
          requirement: body.requirement ?? null,
          evidence: body.evidence ?? null,
          description: body.description,
          responsibleUserId: body.responsibleUserId ?? null,
          responsibleVendorId: body.responsibleVendorId ?? null,
          responseDueDate: body.responseDueDate ?? audit.responseDueDate ?? null,
          dueDate: body.dueDate ?? null,
          attachmentFileIds: body.attachmentFileIds ?? [],
          detail: body.detail ?? {},
          createdBy: req.user!.id,
        })
        .returning();
      await refreshCounters(id);
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "quality_audit_finding",
        objectId: findingId,
        payload: created,
        storePayload: true,
      });
      if (body.responsibleUserId && body.responsibleUserId !== req.user!.id) {
        await pushNotifications(app.db, [
          {
            companyId: req.companyId!,
            userId: body.responsibleUserId,
            projectId: req.projectId!,
            kind: "assignment",
            title: `Audit finding ${created!.reference}: ${body.findingType.replace(/_/g, " ")}`,
            recordType: "quality_audit_finding",
            recordId: findingId,
          },
        ]);
      }
      return reply.status(201).send(created);
    },
  );

  async function fetchFinding(findingId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(qualityAuditFindings)
      .where(
        and(
          eq(qualityAuditFindings.id, findingId),
          eq(qualityAuditFindings.companyId, companyId),
          eq(qualityAuditFindings.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Audit finding not found");
    return rows[0];
  }

  app.patch(
    "/projects/:projectId/audit-findings/:findingId",
    { preHandler: standardGate },
    async (req) => {
      const { findingId } = req.params as { findingId: string };
      const body = findingCreateSchema.partial().parse(req.body);
      const finding = await fetchFinding(findingId, req.companyId!, req.projectId!);
      if (finding.status === "closed" || finding.status === "verified") {
        throw badRequest(
          `${finding.reference} is ${finding.status}; a verified finding's wording is the wording that was answered.`,
        );
      }
      await app.db
        .update(qualityAuditFindings)
        .set(patchSet(body as Record<string, unknown>, FINDING_PATCH_COLUMNS))
        .where(eq(qualityAuditFindings.id, findingId));
      await refreshCounters(finding.auditId);
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "quality_audit_finding",
        objectId: findingId,
        payload: { changed: Object.keys(body) },
      });
      return fetchFinding(findingId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/audit-findings/:findingId/respond",
    { preHandler: standardGate },
    async (req) => {
      const { findingId } = req.params as { findingId: string };
      const body = z
        .object({
          response: z.string().min(1).max(20_000),
          rootCause: z.string().max(10_000).nullable().optional(),
          dueDate: isoDateSchema.nullable().optional(),
          correctiveActionId: idSchema.nullable().optional(),
          ncrId: idSchema.nullable().optional(),
          reworkItemId: idSchema.nullable().optional(),
          agreed: z.boolean().optional(),
        })
        .parse(req.body);
      const finding = await fetchFinding(findingId, req.companyId!, req.projectId!);
      if (finding.status === "closed" || finding.status === "verified") {
        throw badRequest(`${finding.reference} is ${finding.status}.`);
      }
      if (NONCONFORMITY_TYPES.includes(finding.findingType) && !body.rootCause && body.agreed) {
        throw badRequest(
          "A corrective action agreed against a non-conformity must state the root cause. Correcting the symptom without naming the cause is the reason the same finding comes back next year.",
        );
      }
      const at = nowISO();
      await app.db
        .update(qualityAuditFindings)
        .set({
          status: body.agreed ? "action_agreed" : "response_received",
          response: body.response,
          respondedAt: at,
          rootCause: body.rootCause ?? finding.rootCause,
          dueDate: body.dueDate ?? finding.dueDate,
          correctiveActionId: body.correctiveActionId ?? finding.correctiveActionId,
          ncrId: body.ncrId ?? finding.ncrId,
          reworkItemId: body.reworkItemId ?? finding.reworkItemId,
          updatedAt: at,
        })
        .where(eq(qualityAuditFindings.id, findingId));
      await refreshCounters(finding.auditId);
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "quality_audit_finding",
        objectId: findingId,
        payload: {
          from: finding.status,
          to: body.agreed ? "action_agreed" : "response_received",
          rootCause: body.rootCause ?? null,
          dueDate: body.dueDate ?? finding.dueDate,
        },
        storePayload: true,
      });
      return fetchFinding(findingId, req.companyId!, req.projectId!);
    },
  );

  /**
   * Verification closes the finding, and it is segregated: the auditee cannot
   * verify their own corrective action, and neither can the person who wrote
   * the finding sign that it is closed without saying what they saw.
   */
  app.post(
    "/projects/:projectId/audit-findings/:findingId/verify",
    { preHandler: standardGate },
    async (req) => {
      const { findingId } = req.params as { findingId: string };
      const body = z
        .object({
          verificationEvidence: z.string().min(1).max(20_000),
          close: z.boolean().optional(),
        })
        .parse(req.body);
      const finding = await fetchFinding(findingId, req.companyId!, req.projectId!);
      if (finding.status === "verified" || finding.status === "closed") {
        throw badRequest(`${finding.reference} is already ${finding.status}.`);
      }
      if (finding.status === "open") {
        throw badRequest(
          `${finding.reference} has had no response. There is nothing to verify until the auditee has said what they did about it.`,
        );
      }
      if (finding.responsibleUserId) {
        assertDistinctActor(
          req.user!.id,
          finding.responsibleUserId,
          `Verification of finding ${finding.reference}`,
          "was responsible for",
        );
      }
      const at = nowISO();
      const status = body.close === false ? "verified" : "closed";
      await app.db
        .update(qualityAuditFindings)
        .set({
          status,
          verificationEvidence: body.verificationEvidence,
          verifiedBy: req.user!.id,
          verifiedAt: at,
          closedBy: status === "closed" ? req.user!.id : null,
          closedAt: status === "closed" ? at : null,
          updatedAt: at,
        })
        .where(eq(qualityAuditFindings.id, findingId));
      await refreshCounters(finding.auditId);
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "quality_audit_finding",
        objectId: findingId,
        payload: {
          from: finding.status,
          to: status,
          verifiedBy: req.user!.id,
          responsibleUserId: finding.responsibleUserId,
          evidence: body.verificationEvidence,
        },
        storePayload: true,
      });
      return fetchFinding(findingId, req.companyId!, req.projectId!);
    },
  );

  app.get("/projects/:projectId/audit-findings", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        status: z.enum(AUDIT_FINDING_STATUSES).optional(),
        findingType: z.enum(AUDIT_FINDING_TYPES).optional(),
        auditId: idSchema.optional(),
        openOnly: z.coerce.boolean().optional(),
        overdueOnly: z.coerce.boolean().optional(),
      })
      .parse(req.query);
    const clauses = [
      eq(qualityAuditFindings.companyId, req.companyId!),
      eq(qualityAuditFindings.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(qualityAuditFindings.status, q.status));
    else if (q.openOnly || q.overdueOnly) {
      clauses.push(inArray(qualityAuditFindings.status, OPEN_FINDING_STATUSES));
    }
    if (q.findingType) clauses.push(eq(qualityAuditFindings.findingType, q.findingType));
    if (q.auditId) clauses.push(eq(qualityAuditFindings.auditId, q.auditId));
    // Overdue is a SQL predicate rather than a post-page filter, so the page
    // is full and the total is the total.
    if (q.overdueOnly) clauses.push(lt(qualityAuditFindings.dueDate, todayISO()));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(qualityAuditFindings).where(where);
    const rows = await app.db
      .select()
      .from(qualityAuditFindings)
      .where(where)
      .orderBy(asc(qualityAuditFindings.dueDate), asc(qualityAuditFindings.reference))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, Number(totalRow?.n ?? 0), q);
  });

  app.post("/projects/:projectId/audit-findings/sweep", { preHandler: standardGate }, async (req) => {
    const body = z.object({ asOf: isoDateSchema.optional() }).parse(req.body ?? {});
    return sweepAuditFindings(app.db, req.companyId!, body.asOf ?? todayISO());
  });

  /* ---------------- ISO 9001 evidence pack (#1096) ---------------- */

  /**
   * What this project can actually show against the clauses a surveillance
   * audit asks about. Every clause reports the records the platform HOLDS; a
   * clause with none is reported unevidenced with the reason, never as
   * compliant. The pack is a starting point for an auditor, not a certificate.
   */
  app.get("/projects/:projectId/iso9001-evidence", { preHandler: readGate }, async (req) => {
    const scope = { companyId: req.companyId!, projectId: req.projectId! };
    const [
      itps,
      activities,
      templates,
      checklistRows,
      ncrs,
      concessions,
      certificates,
      instruments,
      audits,
      findings,
      rework,
      training,
      tests,
      ndt,
      packages,
    ] = await Promise.all([
      app.db.select().from(inspectionTestPlans).where(and(eq(inspectionTestPlans.companyId, scope.companyId), eq(inspectionTestPlans.projectId, scope.projectId))),
      app.db.select().from(itpActivities).where(and(eq(itpActivities.companyId, scope.companyId), eq(itpActivities.projectId, scope.projectId))),
      app.db.select().from(checklistTemplates).where(eq(checklistTemplates.companyId, scope.companyId)),
      app.db.select().from(checklists).where(and(eq(checklists.companyId, scope.companyId), eq(checklists.projectId, scope.projectId))),
      app.db.select().from(nonConformanceReports).where(and(eq(nonConformanceReports.companyId, scope.companyId), eq(nonConformanceReports.projectId, scope.projectId))),
      app.db.select().from(qualityConcessions).where(and(eq(qualityConcessions.companyId, scope.companyId), eq(qualityConcessions.projectId, scope.projectId))),
      app.db.select().from(materialTestCertificates).where(and(eq(materialTestCertificates.companyId, scope.companyId), eq(materialTestCertificates.projectId, scope.projectId))),
      app.db.select().from(calibratedInstruments).where(and(eq(calibratedInstruments.companyId, scope.companyId), eq(calibratedInstruments.projectId, scope.projectId))),
      app.db.select().from(qualityAudits).where(and(eq(qualityAudits.companyId, scope.companyId), eq(qualityAudits.projectId, scope.projectId))),
      app.db.select().from(qualityAuditFindings).where(and(eq(qualityAuditFindings.companyId, scope.companyId), eq(qualityAuditFindings.projectId, scope.projectId))),
      app.db.select().from(reworkItems).where(and(eq(reworkItems.companyId, scope.companyId), eq(reworkItems.projectId, scope.projectId))),
      app.db.select().from(operatorTrainingRecords).where(and(eq(operatorTrainingRecords.companyId, scope.companyId), eq(operatorTrainingRecords.projectId, scope.projectId))),
      app.db.select().from(commissioningTestRecords).where(and(eq(commissioningTestRecords.companyId, scope.companyId), eq(commissioningTestRecords.projectId, scope.projectId))),
      app.db.select().from(ndtRecords).where(and(eq(ndtRecords.companyId, scope.companyId), eq(ndtRecords.projectId, scope.projectId))),
      app.db.select().from(turnoverPackages).where(and(eq(turnoverPackages.companyId, scope.companyId), eq(turnoverPackages.projectId, scope.projectId))),
    ]);

    interface ClauseEvidence {
      clause: string;
      title: string;
      question: string;
      records: Array<{ kind: string; count: number; href?: string }>;
      evidenced: boolean;
      reasons: string[];
    }

    const clause = (
      clauseKey: (typeof ISO_9001_CLAUSES)[number],
      title: string,
      question: string,
      records: Array<{ kind: string; count: number; href?: string }>,
      extraReasons: string[] = [],
    ): ClauseEvidence => {
      const total = records.reduce((n, r) => n + r.count, 0);
      return {
        clause: clauseKey,
        title,
        question,
        records,
        evidenced: total > 0,
        reasons:
          total > 0
            ? extraReasons
            : [
                `This project holds no records of this kind on the platform, so the clause is unevidenced here. That is not a finding — the evidence may live elsewhere — but it is not compliance either, and this pack will not claim it is.`,
                ...extraReasons,
              ],
      };
    };

    const base = `/projects/${scope.projectId}/quality`;
    const clauses: ClauseEvidence[] = [
      clause("8_1_operational_planning", "Operational planning and control", "How is quality planned before the work starts?", [
        { kind: "Inspection and test plans", count: itps.length, href: `${base}?tab=itps` },
        { kind: "Approved plans", count: itps.filter((i) => i.status === "approved" || i.status === "active").length },
        { kind: "Intervention points", count: activities.length, href: `${base}?tab=holdPoints` },
      ]),
      clause("7_1_5_monitoring_resources", "Monitoring and measuring resources", "How do you know the instruments used for acceptance were in calibration?", [
        { kind: "Registered instruments", count: instruments.length, href: `${base}?tab=records` },
        { kind: "In service", count: instruments.filter((i) => i.status === "in_service").length },
        { kind: "Overdue", count: instruments.filter((i) => i.status === "overdue").length },
      ]),
      clause("8_4_external_providers", "Externally provided processes and products", "How is what suppliers deliver verified?", [
        { kind: "Material test certificates", count: certificates.length, href: `${base}?tab=records` },
        { kind: "Verified certificates", count: certificates.filter((c) => c.verificationStatus === "verified").length },
        { kind: "Supplier audits", count: audits.filter((a) => a.auditType === "supplier").length },
      ]),
      clause("8_5_2_identification_traceability", "Identification and traceability", "Can a delivered lot be traced to what was installed?", [
        { kind: "Certificates with a heat or batch number", count: certificates.filter((c) => c.heatNumber || c.batchNumber || c.castNumber).length },
        { kind: "NDT records", count: ndt.length },
      ]),
      clause("8_6_release", "Release of products and services", "Who released the work, and against what?", [
        { kind: "Completed checklists", count: checklistRows.filter((c) => c.performedAt).length, href: `${base}?tab=checklists` },
        { kind: "Witnessed records", count: checklistRows.filter((c) => c.witnessedBy).length },
        { kind: "Commissioning tests accepted", count: tests.filter((t) => t.status === "accepted").length },
        { kind: "Turnover packages handed over", count: packages.filter((p) => p.handedOverAt).length },
      ]),
      clause("8_7_nonconforming_output", "Control of nonconforming output", "What happens when something does not conform?", [
        { kind: "Non-conformance reports", count: ncrs.length, href: `${base}?tab=ncrs` },
        { kind: "Closed with independent verification", count: ncrs.filter((n) => n.verifiedBy && n.verifiedBy !== n.closedBy).length },
        { kind: "Concessions", count: concessions.length, href: `${base}?tab=concessions` },
      ]),
      clause("9_1_monitoring", "Monitoring, measurement, analysis and evaluation", "What is measured, and what does it say?", [
        { kind: "Checklists with a result", count: checklistRows.filter((c) => c.result !== null).length },
        { kind: "Rework items", count: rework.length, href: `${base}?tab=rework` },
      ]),
      clause("9_2_internal_audit", "Internal audit", "Is the system audited, and by whom?", [
        { kind: "Audits", count: audits.length, href: `${base}?tab=audits` },
        { kind: "Internal audits", count: audits.filter((a) => a.auditType === "internal").length },
        { kind: "Reports issued", count: audits.filter((a) => a.reportIssuedAt).length },
      ]),
      clause("10_2_nonconformity_corrective_action", "Nonconformity and corrective action", "Are causes found and actions verified?", [
        { kind: "Audit findings", count: findings.length },
        { kind: "With a recorded root cause", count: findings.filter((f) => f.rootCause).length },
        { kind: "Verified closed", count: findings.filter((f) => f.status === "closed" || f.status === "verified").length },
        { kind: "NCRs with a root cause", count: ncrs.filter((n) => n.rootCause).length },
      ]),
      clause("7_support", "Support — competence and awareness", "Are the people delivering and receiving the works competent?", [
        { kind: "Operator training records", count: training.length, href: `${base}?tab=closeout` },
        { kind: "Issued checklist templates (controlled forms)", count: templates.filter((t) => t.status === "active").length },
      ]),
    ];

    const evidenced = clauses.filter((c) => c.evidenced).length;
    return {
      generatedAt: nowISO(),
      standard: "ISO 9001:2015",
      clauses,
      coverage: {
        clausesReported: clauses.length,
        clausesEvidenced: evidenced,
        percent: round2((evidenced / clauses.length) * 100),
      },
      reasons: [
        "This pack reports what the platform holds against each clause. It is an index of evidence, not a compliance assessment: a clause with records may still be non-conformant, and a clause with none may be evidenced entirely outside this system.",
      ],
    };
  });
};
