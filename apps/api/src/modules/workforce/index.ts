import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  labourAudits,
  labourRiskFlags,
  obligations,
  payrollEntries,
  siteAccessRecords,
  signals,
  vendors,
  welfareInspections,
  workers,
} from "@constructos/db";
import {
  LABOUR_RISK_INDICATORS,
  WELFARE_INSPECTION_AREAS,
  WORKER_STATUSES,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { addDaysISO, isoDateSchema, todayISO } from "../field/dates.js";
import {
  MINIMUM_WORKING_AGE,
  ageOnDate,
  distinctAccessDays,
  indicatorSeverity,
  isUnderage,
  rankVendorRisk,
  reconcileWorkforce,
  type ReconcileWorkerInput,
  type ReconciliationSummary,
  type VendorRiskInput,
} from "./reconcile.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const timeOfDaySchema = z.string().regex(/^\d{2}:\d{2}$/, "Expected HH:MM");

const workerCreateSchema = z.object({
  reference: z.string().min(1).max(100),
  fullName: z.string().min(1).max(300),
  dateOfBirth: isoDateSchema.nullable().optional(),
  nationality: z.string().max(100).nullable().optional(),
  vendorId: z.string().min(1).nullable().optional(),
  trade: z.string().max(200).nullable().optional(),
  idVerified: z.boolean().optional(),
  biometricEnrolled: z.boolean().optional(),
  contractIssued: z.boolean().optional(),
  contractLanguage: z.string().max(100).nullable().optional(),
  recruitmentAgency: z.string().max(300).nullable().optional(),
  agreedDailyRate: z.number().nonnegative().nullable().optional(),
  currency: z.string().length(3).optional(),
  accommodationRef: z.string().max(200).nullable().optional(),
  inductedAt: isoDateSchema.nullable().optional(),
});

const workerPatchSchema = z.object({
  fullName: z.string().min(1).max(300).optional(),
  dateOfBirth: isoDateSchema.nullable().optional(),
  nationality: z.string().max(100).nullable().optional(),
  vendorId: z.string().min(1).nullable().optional(),
  trade: z.string().max(200).nullable().optional(),
  idVerified: z.boolean().optional(),
  biometricEnrolled: z.boolean().optional(),
  contractIssued: z.boolean().optional(),
  contractLanguage: z.string().max(100).nullable().optional(),
  recruitmentAgency: z.string().max(300).nullable().optional(),
  agreedDailyRate: z.number().nonnegative().nullable().optional(),
  currency: z.string().length(3).optional(),
  accommodationRef: z.string().max(200).nullable().optional(),
  inductedAt: isoDateSchema.nullable().optional(),
  demobilisedAt: isoDateSchema.nullable().optional(),
});

const workerStatusSchema = z.object({ status: z.enum(WORKER_STATUSES) });

const workerListQuerySchema = pageQuerySchema.extend({
  vendorId: z.string().min(1).optional(),
  status: z.enum(WORKER_STATUSES).optional(),
  trade: z.string().max(200).optional(),
  riskFlagged: z.enum(["true", "false"]).optional(),
});

const siteAccessIngestSchema = z.object({
  records: z
    .array(
      z.object({
        workerId: z.string().min(1).optional(),
        workerReference: z.string().min(1).max(100).optional(),
        accessDate: isoDateSchema,
        firstIn: timeOfDaySchema.nullable().optional(),
        lastOut: timeOfDaySchema.nullable().optional(),
        hoursOnSite: z.number().min(0).max(24).nullable().optional(),
        source: z.enum(["turnstile", "biometric", "manual", "gate_log"]).optional(),
      }),
    )
    .min(1)
    .max(5000),
});

const payrollIngestSchema = z.object({
  entries: z
    .array(
      z.object({
        workerId: z.string().min(1).optional(),
        workerReference: z.string().min(1).max(100).optional(),
        periodStart: isoDateSchema,
        periodEnd: isoDateSchema,
        daysClaimed: z.number().min(0).max(400),
        hoursClaimed: z.number().min(0).max(10000).nullable().optional(),
        grossPay: z.number().min(0),
        deductions: z.number().min(0).optional(),
        netPay: z.number(),
        currency: z.string().length(3).optional(),
        paidAt: isoDateSchema.nullable().optional(),
        wpsReference: z.string().max(200).nullable().optional(),
      }),
    )
    .min(1)
    .max(5000),
});

const reconcileSchema = z.object({ periodStart: isoDateSchema, periodEnd: isoDateSchema });

const reconciliationQuerySchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

const riskFlagCreateSchema = z
  .object({
    workerId: z.string().min(1).optional(),
    vendorId: z.string().min(1).optional(),
    indicator: z.enum(LABOUR_RISK_INDICATORS),
    severity: z.enum(["low", "medium", "high", "critical"]).optional(),
    detail: z.string().max(10000).nullable().optional(),
    source: z.enum(["audit", "worker_report", "detector", "inspection"]),
  })
  .refine((b) => Boolean(b.workerId) !== Boolean(b.vendorId), {
    message: "Provide exactly one of workerId or vendorId",
  });

const riskFlagListQuerySchema = pageQuerySchema.extend({
  indicator: z.enum(LABOUR_RISK_INDICATORS).optional(),
  vendorId: z.string().min(1).optional(),
  workerId: z.string().min(1).optional(),
  open: z.enum(["true", "false"]).optional(),
});

const resolveSchema = z.object({ resolution: z.string().min(1).max(10000) });

const welfareCreateSchema = z.object({
  inspectionDate: isoDateSchema,
  location: z.string().min(1).max(300),
  vendorId: z.string().min(1).nullable().optional(),
  areas: z
    .array(
      z.object({
        area: z.enum(WELFARE_INSPECTION_AREAS),
        score: z.number().int().min(1).max(5),
        note: z.string().max(5000).nullable().optional(),
        photoFileId: z.string().min(1).nullable().optional(),
      }),
    )
    .min(1)
    .max(WELFARE_INSPECTION_AREAS.length * 4),
  occupancyCount: z.number().int().min(0).nullable().optional(),
  capacity: z.number().int().min(0).nullable().optional(),
  actions: z
    .array(
      z.object({
        text: z.string().min(1).max(2000),
        dueDate: isoDateSchema.nullable().optional(),
      }),
    )
    .max(50)
    .optional(),
});

const welfareListQuerySchema = pageQuerySchema.extend({
  vendorId: z.string().min(1).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

const closeActionSchema = z.object({ note: z.string().max(5000).nullable().optional() });

const auditCreateSchema = z.object({
  vendorId: z.string().min(1),
  scheduledFor: isoDateSchema,
  isUnannounced: z.boolean().optional(),
});

const auditReportSchema = z.object({
  findings: z
    .array(
      z.object({
        indicator: z.enum(LABOUR_RISK_INDICATORS).nullable().optional(),
        description: z.string().min(1).max(10000),
        severity: z.enum(["low", "medium", "high", "critical"]),
        capDueDate: isoDateSchema.nullable().optional(),
      }),
    )
    .max(200),
  score: z.number().min(0).max(100).nullable().optional(),
  reportFileId: z.string().min(1).nullable().optional(),
});

const closeFindingSchema = z.object({ note: z.string().min(1).max(10000) });

const auditListQuerySchema = pageQuerySchema.extend({
  vendorId: z.string().min(1).optional(),
  status: z.enum(["scheduled", "in_progress", "reported", "closed"]).optional(),
});

/* ------------------------------------------------------------------ */
/* Stored JSON shapes                                                  */
/* ------------------------------------------------------------------ */

interface WelfareArea {
  area: string;
  score: number;
  note: string | null;
  photoFileId: string | null;
}

interface WelfareAction {
  id: string;
  text: string;
  dueDate: string | null;
  closed: boolean;
  closedAt: string | null;
  closedBy: string | null;
  note: string | null;
}

interface AuditFinding {
  id: string;
  indicator: string | null;
  description: string;
  severity: string;
  capDueDate: string | null;
  obligationId: string | null;
  closedAt: string | null;
  closedBy: string | null;
  closedNote: string | null;
  /** set once by the overdue sweep — the idempotence guard (#699) */
  capBreachedAt: string | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Signal detectors this module owns; also the reconciliation idempotence keys. */
const RECONCILIATION_DETECTORS = ["ghost_worker", "payroll_overclaim", "wage_underpayment"] as const;

/**
 * Workforce rights & welfare — spec Vol II Domain M / M17 (#667-699 subset):
 * the verified worker register (#667-668), age verification and child-labour
 * prevention (#670), GHOST-WORKER ELIMINATION by reconciling employer payroll
 * against the independent site-access stream (#669) with wage-versus-hours
 * verification (#677), modern-slavery indicator capture and subcontractor-level
 * composite scoring (#671-675, #694), accommodation and welfare inspection
 * scoring with occupancy-density compliance (#683-688), and the subcontractor
 * labour audit programme with corrective-action plans tracked as assurance
 * obligations (#697-699).
 *
 * Labour is modelled as PEOPLE WITH RIGHTS, not as cost and hours: every
 * finding lands in the same signals/obligations spine the rest of the platform
 * uses, so a lender or auditor reads worker harm on the same page as money.
 */
export const workforceModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("workforce", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("workforce", "standard"),
  ];

  /* ---------------------------------------------------------------- */
  /* Fetch helpers                                                     */
  /* ---------------------------------------------------------------- */

  async function fetchWorker(workerId: string, companyId: string, projectId: string) {
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
    if (!rows[0]) throw notFound("Worker not found");
    return rows[0];
  }

  async function fetchFlag(flagId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(labourRiskFlags)
      .where(
        and(
          eq(labourRiskFlags.id, flagId),
          eq(labourRiskFlags.companyId, companyId),
          eq(labourRiskFlags.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Labour risk flag not found");
    return rows[0];
  }

  async function fetchInspection(inspectionId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(welfareInspections)
      .where(
        and(
          eq(welfareInspections.id, inspectionId),
          eq(welfareInspections.companyId, companyId),
          eq(welfareInspections.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Welfare inspection not found");
    return rows[0];
  }

  async function fetchAudit(auditId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(labourAudits)
      .where(
        and(
          eq(labourAudits.id, auditId),
          eq(labourAudits.companyId, companyId),
          eq(labourAudits.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Labour audit not found");
    return rows[0];
  }

  /** Vendors are company-scoped in the directory; membership is the check. */
  async function requireVendor(vendorId: string, companyId: string) {
    const rows = await app.db
      .select({ id: vendors.id, name: vendors.name })
      .from(vendors)
      .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw badRequest("vendorId does not reference a vendor in this company");
    return rows[0];
  }

  async function vendorNames(companyId: string, ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await app.db
      .select({ id: vendors.id, name: vendors.name })
      .from(vendors)
      .where(and(eq(vendors.companyId, companyId), inArray(vendors.id, unique)));
    return new Map(rows.map((v) => [v.id, v.name]));
  }

  /**
   * Age verification (#670). Refusing enrolment is not enough — an ATTEMPT to
   * put a child on site is itself the reportable event, so a critical signal
   * is raised before the 400 is thrown. Age is measured at the induction date
   * when one is supplied (a worker inducted last year may be 18 today), else
   * today.
   */
  async function assertNotUnderage(
    companyId: string,
    projectId: string,
    actorId: string,
    input: { reference: string; fullName: string; dateOfBirth: string; inductedAt?: string | null },
  ): Promise<void> {
    const onDate = input.inductedAt ?? todayISO();
    if (!isUnderage(input.dateOfBirth, onDate)) return;
    const age = ageOnDate(input.dateOfBirth, onDate);
    await app.db.insert(signals).values({
      id: newId("sig"),
      companyId,
      projectId,
      detector: "underage_worker_blocked",
      severity: "critical",
      confidence: 1,
      title: `Child-labour control blocked worker enrolment — ${input.reference}`,
      explanation:
        `An attempt was made to enrol "${input.fullName}" (reference ${input.reference}) with a ` +
        `date of birth of ${input.dateOfBirth}, which is ${age ?? "under"} years old at ${onDate}. ` +
        `The platform's minimum working age is ${MINIMUM_WORKING_AGE} (ILO C138). The record was ` +
        `refused and no site access can be granted. Investigate the recruitment channel that ` +
        `presented this worker — an underage submission is a forced-labour red flag in its own right.`,
      evidenceRefs: {
        reference: input.reference,
        dateOfBirth: input.dateOfBirth,
        assessedOn: onDate,
        age,
        minimumAge: MINIMUM_WORKING_AGE,
      },
    });
    await appendLedger(app.db, {
      companyId,
      actorId,
      action: "create",
      objectType: "underage_worker_block",
      objectId: input.reference,
      payload: { reference: input.reference, dateOfBirth: input.dateOfBirth, age, onDate },
      storePayload: true,
    });
    throw badRequest(
      `Worker is ${age ?? "under"} years old at ${onDate}; the minimum working age is ${MINIMUM_WORKING_AGE}`,
    );
  }

  /** Open (unresolved) risk-flag counts for a set of workers. */
  async function openFlagCounts(
    companyId: string,
    projectId: string,
    workerIds: string[],
  ): Promise<Map<string, number>> {
    if (workerIds.length === 0) return new Map();
    const rows = await app.db
      .select({ workerId: labourRiskFlags.workerId, n: count() })
      .from(labourRiskFlags)
      .where(
        and(
          eq(labourRiskFlags.companyId, companyId),
          eq(labourRiskFlags.projectId, projectId),
          isNull(labourRiskFlags.resolvedAt),
          inArray(labourRiskFlags.workerId, workerIds),
        ),
      )
      .groupBy(labourRiskFlags.workerId);
    const map = new Map<string, number>();
    for (const r of rows) if (r.workerId) map.set(r.workerId, Number(r.n));
    return map;
  }

  /* ---------------------------------------------------------------- */
  /* Workers (#667-670, #674)                                          */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/workers", { preHandler: standardGate }, async (req, reply) => {
    const body = workerCreateSchema.parse(req.body);
    const companyId = req.companyId!;
    const projectId = req.projectId!;

    // Age is checked FIRST: an attempted child enrolment must raise its signal
    // even when the submission is also a duplicate or names an unknown vendor.
    if (body.dateOfBirth) {
      await assertNotUnderage(companyId, projectId, req.user!.id, {
        reference: body.reference,
        fullName: body.fullName,
        dateOfBirth: body.dateOfBirth,
        inductedAt: body.inductedAt ?? null,
      });
    }

    const existing = await app.db
      .select({ id: workers.id })
      .from(workers)
      .where(and(eq(workers.projectId, projectId), eq(workers.reference, body.reference)))
      .limit(1);
    if (existing[0]) {
      throw conflict(`A worker with reference ${body.reference} already exists on this project`);
    }
    if (body.vendorId) await requireVendor(body.vendorId, companyId);

    const id = newId("wkr");
    await app.db.insert(workers).values({
      id,
      companyId,
      projectId,
      reference: body.reference,
      fullName: body.fullName,
      dateOfBirth: body.dateOfBirth ?? null,
      nationality: body.nationality ?? null,
      vendorId: body.vendorId ?? null,
      trade: body.trade ?? null,
      idVerified: body.idVerified ? 1 : 0,
      biometricEnrolled: body.biometricEnrolled ? 1 : 0,
      contractIssued: body.contractIssued ? 1 : 0,
      contractLanguage: body.contractLanguage ?? null,
      recruitmentAgency: body.recruitmentAgency ?? null,
      agreedDailyRate: body.agreedDailyRate ?? null,
      currency: body.currency ?? "USD",
      accommodationRef: body.accommodationRef ?? null,
      inductedAt: body.inductedAt ?? null,
      status: "active",
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId,
      actorId: req.user!.id,
      action: "create",
      objectType: "worker",
      objectId: id,
      payload: {
        reference: body.reference,
        fullName: body.fullName,
        vendorId: body.vendorId ?? null,
        trade: body.trade ?? null,
        idVerified: body.idVerified ? 1 : 0,
        contractIssued: body.contractIssued ? 1 : 0,
      },
      storePayload: true,
    });
    const created = await fetchWorker(id, companyId, projectId);
    return reply.status(201).send({ ...created, openRiskFlags: 0 });
  });

  app.get("/projects/:projectId/workers", { preHandler: readGate }, async (req) => {
    const q = workerListQuerySchema.parse(req.query);
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    const conds = [eq(workers.companyId, companyId), eq(workers.projectId, projectId)];
    if (q.vendorId) conds.push(eq(workers.vendorId, q.vendorId));
    if (q.status) conds.push(eq(workers.status, q.status));
    if (q.trade) conds.push(eq(workers.trade, q.trade));

    if (q.riskFlagged === "true") {
      const flagged = await app.db
        .selectDistinct({ workerId: labourRiskFlags.workerId })
        .from(labourRiskFlags)
        .where(
          and(
            eq(labourRiskFlags.companyId, companyId),
            eq(labourRiskFlags.projectId, projectId),
            isNull(labourRiskFlags.resolvedAt),
          ),
        );
      const ids = flagged.map((f) => f.workerId).filter((v): v is string => Boolean(v));
      if (ids.length === 0) return paginate([], 0, q);
      conds.push(inArray(workers.id, ids));
    }

    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(workers).where(where);
    const rows = await app.db
      .select()
      .from(workers)
      .where(where)
      .orderBy(asc(workers.reference))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const flagCounts = await openFlagCounts(
      companyId,
      projectId,
      rows.map((r) => r.id),
    );
    const names = await vendorNames(
      companyId,
      rows.map((r) => r.vendorId).filter((v): v is string => Boolean(v)),
    );
    const items = rows.map((r) => ({
      ...r,
      vendorName: r.vendorId ? (names.get(r.vendorId) ?? null) : null,
      openRiskFlags: flagCounts.get(r.id) ?? 0,
    }));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/workers/:workerId", { preHandler: readGate }, async (req) => {
    const { workerId } = req.params as { workerId: string };
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    const worker = await fetchWorker(workerId, companyId, projectId);
    const flags = await app.db
      .select()
      .from(labourRiskFlags)
      .where(
        and(eq(labourRiskFlags.projectId, projectId), eq(labourRiskFlags.workerId, workerId)),
      )
      .orderBy(desc(labourRiskFlags.createdAt));
    const access = await app.db
      .select()
      .from(siteAccessRecords)
      .where(eq(siteAccessRecords.workerId, workerId))
      .orderBy(desc(siteAccessRecords.accessDate))
      .limit(30);
    const payroll = await app.db
      .select()
      .from(payrollEntries)
      .where(eq(payrollEntries.workerId, workerId))
      .orderBy(desc(payrollEntries.periodEnd))
      .limit(1);
    const names = worker.vendorId ? await vendorNames(companyId, [worker.vendorId]) : new Map();
    return {
      ...worker,
      vendorName: worker.vendorId ? (names.get(worker.vendorId) ?? null) : null,
      age: worker.dateOfBirth ? ageOnDate(worker.dateOfBirth, todayISO()) : null,
      openRiskFlags: flags.filter((f) => !f.resolvedAt).length,
      riskFlags: flags,
      recentAccess: access,
      latestPayroll: payroll[0] ?? null,
    };
  });

  app.patch("/projects/:projectId/workers/:workerId", { preHandler: standardGate }, async (req) => {
    const { workerId } = req.params as { workerId: string };
    const body = workerPatchSchema.parse(req.body);
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    const worker = await fetchWorker(workerId, companyId, projectId);

    // Correcting a date of birth downward is the same control as enrolment.
    const nextDob = body.dateOfBirth !== undefined ? body.dateOfBirth : worker.dateOfBirth;
    const nextInduction = body.inductedAt !== undefined ? body.inductedAt : worker.inductedAt;
    if (nextDob) {
      await assertNotUnderage(companyId, projectId, req.user!.id, {
        reference: worker.reference,
        fullName: body.fullName ?? worker.fullName,
        dateOfBirth: nextDob,
        inductedAt: nextInduction,
      });
    }
    if (body.vendorId) await requireVendor(body.vendorId, companyId);

    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    const direct = [
      "fullName",
      "dateOfBirth",
      "nationality",
      "vendorId",
      "trade",
      "contractLanguage",
      "recruitmentAgency",
      "agreedDailyRate",
      "currency",
      "accommodationRef",
      "inductedAt",
      "demobilisedAt",
    ] as const;
    for (const key of direct) {
      if (body[key] !== undefined) set[key] = body[key];
    }
    for (const key of ["idVerified", "biometricEnrolled", "contractIssued"] as const) {
      if (body[key] !== undefined) set[key] = body[key] ? 1 : 0;
    }
    await app.db.update(workers).set(set).where(eq(workers.id, workerId));
    await appendLedger(app.db, {
      companyId,
      actorId: req.user!.id,
      action: "update",
      objectType: "worker",
      objectId: workerId,
      payload: { changed: Object.keys(body) },
      storePayload: true,
    });
    return fetchWorker(workerId, companyId, projectId);
  });

  app.post(
    "/projects/:projectId/workers/:workerId/status",
    { preHandler: standardGate },
    async (req) => {
      const { workerId } = req.params as { workerId: string };
      const body = workerStatusSchema.parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const worker = await fetchWorker(workerId, companyId, projectId);
      if (worker.status === body.status) return worker;
      const set: Record<string, unknown> = {
        status: body.status,
        updatedAt: new Date().toISOString(),
      };
      if (body.status === "demobilised" && !worker.demobilisedAt) {
        set["demobilisedAt"] = todayISO();
      }
      await app.db.update(workers).set(set).where(eq(workers.id, workerId));
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "worker",
        objectId: workerId,
        payload: { from: worker.status, to: body.status },
        storePayload: true,
      });
      return fetchWorker(workerId, companyId, projectId);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Site access + payroll ingest (#668, #676)                         */
  /* ---------------------------------------------------------------- */

  /**
   * Resolve worker references/ids in a batch to project workers. Unknown
   * entries are RETURNED, not thrown: a turnstile export naming a leaver or a
   * worker from a neighbouring package must not lose the other 4,999 rows.
   */
  async function resolveBatchWorkers(
    companyId: string,
    projectId: string,
    keys: { workerId?: string | undefined; workerReference?: string | undefined }[],
  ): Promise<{ byId: Map<string, string>; byReference: Map<string, string> }> {
    const ids = [...new Set(keys.map((k) => k.workerId).filter((v): v is string => Boolean(v)))];
    const refs = [
      ...new Set(keys.map((k) => k.workerReference).filter((v): v is string => Boolean(v))),
    ];
    const byId = new Map<string, string>();
    const byReference = new Map<string, string>();
    const base = and(eq(workers.companyId, companyId), eq(workers.projectId, projectId));
    if (ids.length > 0) {
      const rows = await app.db
        .select({ id: workers.id, reference: workers.reference })
        .from(workers)
        .where(and(base, inArray(workers.id, ids)));
      for (const r of rows) byId.set(r.id, r.id);
    }
    if (refs.length > 0) {
      const rows = await app.db
        .select({ id: workers.id, reference: workers.reference })
        .from(workers)
        .where(and(base, inArray(workers.reference, refs)));
      for (const r of rows) byReference.set(r.reference, r.id);
    }
    return { byId, byReference };
  }

  app.post("/projects/:projectId/site-access", { preHandler: standardGate }, async (req, reply) => {
    const body = siteAccessIngestSchema.parse(req.body);
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    const { byId, byReference } = await resolveBatchWorkers(companyId, projectId, body.records);

    const unknown: { index: number; workerId?: string; workerReference?: string }[] = [];
    // Last write wins within one batch: a repeated (worker, date) pair in the
    // same payload would otherwise make ON CONFLICT touch a row twice.
    const staged = new Map<string, typeof siteAccessRecords.$inferInsert>();
    body.records.forEach((r, index) => {
      const workerId = r.workerId
        ? byId.get(r.workerId)
        : r.workerReference
          ? byReference.get(r.workerReference)
          : undefined;
      if (!workerId) {
        unknown.push({
          index,
          ...(r.workerId ? { workerId: r.workerId } : {}),
          ...(r.workerReference ? { workerReference: r.workerReference } : {}),
        });
        return;
      }
      staged.set(`${workerId}|${r.accessDate}`, {
        id: newId("sac"),
        companyId,
        projectId,
        workerId,
        accessDate: r.accessDate,
        firstIn: r.firstIn ?? null,
        lastOut: r.lastOut ?? null,
        hoursOnSite: r.hoursOnSite ?? null,
        source: r.source ?? "turnstile",
      });
    });

    const rows = [...staged.values()];
    for (let i = 0; i < rows.length; i += 500) {
      await app.db
        .insert(siteAccessRecords)
        .values(rows.slice(i, i + 500))
        .onConflictDoUpdate({
          target: [siteAccessRecords.workerId, siteAccessRecords.accessDate],
          set: {
            firstIn: sql`excluded.first_in`,
            lastOut: sql`excluded.last_out`,
            hoursOnSite: sql`excluded.hours_on_site`,
            source: sql`excluded.source`,
          },
        });
    }
    await appendLedger(app.db, {
      companyId,
      actorId: req.user!.id,
      action: "create",
      objectType: "site_access_batch",
      objectId: projectId,
      payload: { received: body.records.length, upserted: rows.length, unknown: unknown.length },
      storePayload: true,
    });
    return reply.status(201).send({
      received: body.records.length,
      upserted: rows.length,
      duplicatesCollapsed: body.records.length - unknown.length - rows.length,
      unknown,
    });
  });

  app.post("/projects/:projectId/payroll", { preHandler: standardGate }, async (req, reply) => {
    const body = payrollIngestSchema.parse(req.body);
    const companyId = req.companyId!;
    const projectId = req.projectId!;

    // Arithmetic integrity first — a payroll file that does not add up is
    // rejected whole, because a partial ingest of a broken file is worse.
    body.entries.forEach((e, index) => {
      if (e.periodEnd < e.periodStart) {
        throw badRequest(`entries[${index}]: periodEnd ${e.periodEnd} precedes periodStart ${e.periodStart}`);
      }
      const expected = e.grossPay - (e.deductions ?? 0);
      if (Math.abs(e.netPay - expected) > 0.01) {
        throw badRequest(
          `entries[${index}]: netPay ${e.netPay} does not equal grossPay ${e.grossPay} − deductions ` +
            `${e.deductions ?? 0} (= ${round2(expected)}, tolerance ±0.01)`,
        );
      }
    });

    const { byId, byReference } = await resolveBatchWorkers(companyId, projectId, body.entries);
    const unknown: { index: number; workerId?: string; workerReference?: string }[] = [];
    const rows: (typeof payrollEntries.$inferInsert)[] = [];
    body.entries.forEach((e, index) => {
      const workerId = e.workerId
        ? byId.get(e.workerId)
        : e.workerReference
          ? byReference.get(e.workerReference)
          : undefined;
      if (!workerId) {
        unknown.push({
          index,
          ...(e.workerId ? { workerId: e.workerId } : {}),
          ...(e.workerReference ? { workerReference: e.workerReference } : {}),
        });
        return;
      }
      rows.push({
        id: newId("pay"),
        companyId,
        projectId,
        workerId,
        periodStart: e.periodStart,
        periodEnd: e.periodEnd,
        daysClaimed: e.daysClaimed,
        hoursClaimed: e.hoursClaimed ?? null,
        grossPay: e.grossPay,
        deductions: e.deductions ?? 0,
        netPay: e.netPay,
        currency: e.currency ?? "USD",
        paidAt: e.paidAt ?? null,
        wpsReference: e.wpsReference ?? null,
        submittedBy: req.user!.id,
      });
    });
    for (let i = 0; i < rows.length; i += 500) {
      await app.db.insert(payrollEntries).values(rows.slice(i, i + 500));
    }
    await appendLedger(app.db, {
      companyId,
      actorId: req.user!.id,
      action: "create",
      objectType: "payroll_batch",
      objectId: projectId,
      payload: {
        received: body.entries.length,
        inserted: rows.length,
        unknown: unknown.length,
        gross: round2(rows.reduce((s, r) => s + r.grossPay, 0)),
      },
      storePayload: true,
    });
    return reply
      .status(201)
      .send({ received: body.entries.length, inserted: rows.length, unknown });
  });

  /* ---------------------------------------------------------------- */
  /* Ghost-worker reconciliation (#669, #677)                          */
  /* ---------------------------------------------------------------- */

  async function computeReconciliation(
    companyId: string,
    projectId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<ReconciliationSummary> {
    // Every payroll entry that OVERLAPS the window, not only those fully
    // inside it — a monthly run straddling a fortnightly window still counts.
    const pay = await app.db
      .select()
      .from(payrollEntries)
      .where(
        and(
          eq(payrollEntries.companyId, companyId),
          eq(payrollEntries.projectId, projectId),
          lte(payrollEntries.periodStart, periodEnd),
          gte(payrollEntries.periodEnd, periodStart),
        ),
      );
    const workerIds = [...new Set(pay.map((p) => p.workerId))];
    if (workerIds.length === 0) {
      return reconcileWorkforce([], { periodStart, periodEnd });
    }
    const workerRows = await app.db
      .select()
      .from(workers)
      .where(
        and(
          eq(workers.companyId, companyId),
          eq(workers.projectId, projectId),
          inArray(workers.id, workerIds),
        ),
      );
    const access = await app.db
      .select({
        workerId: siteAccessRecords.workerId,
        accessDate: siteAccessRecords.accessDate,
      })
      .from(siteAccessRecords)
      .where(
        and(
          eq(siteAccessRecords.companyId, companyId),
          eq(siteAccessRecords.projectId, projectId),
          inArray(siteAccessRecords.workerId, workerIds),
          gte(siteAccessRecords.accessDate, periodStart),
          lte(siteAccessRecords.accessDate, periodEnd),
        ),
      );
    const accessByWorker = new Map<string, string[]>();
    for (const a of access) {
      const list = accessByWorker.get(a.workerId);
      if (list) list.push(a.accessDate);
      else accessByWorker.set(a.workerId, [a.accessDate]);
    }
    const inputs: ReconcileWorkerInput[] = workerRows.map((w) => {
      const entries = pay.filter((p) => p.workerId === w.id);
      return {
        workerId: w.id,
        reference: w.reference,
        fullName: w.fullName,
        vendorId: w.vendorId,
        agreedDailyRate: w.agreedDailyRate,
        currency: entries[0]?.currency ?? w.currency,
        daysClaimed: round2(entries.reduce((s, e) => s + e.daysClaimed, 0)),
        grossPay: round2(entries.reduce((s, e) => s + e.grossPay, 0)),
        netPay: round2(entries.reduce((s, e) => s + e.netPay, 0)),
        accessDays: distinctAccessDays(accessByWorker.get(w.id) ?? [], periodStart, periodEnd)
          .length,
        payrollEntries: entries.length,
      };
    });
    return reconcileWorkforce(inputs, { periodStart, periodEnd });
  }

  app.post(
    "/projects/:projectId/workforce/reconcile",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = reconcileSchema.parse(req.body);
      if (body.periodEnd < body.periodStart) {
        throw badRequest("periodEnd must not precede periodStart");
      }
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const summary = await computeReconciliation(
        companyId,
        projectId,
        body.periodStart,
        body.periodEnd,
      );

      // Idempotence: a re-run of the same window must not duplicate signals.
      // The key is (detector, workerId, period) carried in evidenceRefs.
      const existing = await app.db
        .select({ detector: signals.detector, evidenceRefs: signals.evidenceRefs })
        .from(signals)
        .where(
          and(
            eq(signals.companyId, companyId),
            eq(signals.projectId, projectId),
            inArray(signals.detector, [...RECONCILIATION_DETECTORS]),
          ),
        );
      const seen = new Set<string>();
      for (const s of existing) {
        const ref = s.evidenceRefs as
          | { workerId?: string; periodStart?: string; periodEnd?: string }
          | null;
        if (!ref?.workerId) continue;
        if (ref.periodStart !== body.periodStart || ref.periodEnd !== body.periodEnd) continue;
        seen.add(`${s.detector}|${ref.workerId}`);
      }

      const toInsert: (typeof signals.$inferInsert)[] = [];
      const emit = (
        detector: (typeof RECONCILIATION_DETECTORS)[number],
        severity: "high" | "critical",
        row: ReconciliationSummary["rows"][number],
        title: string,
      ) => {
        if (seen.has(`${detector}|${row.workerId}`)) return;
        seen.add(`${detector}|${row.workerId}`);
        toInsert.push({
          id: newId("sig"),
          companyId,
          projectId,
          detector,
          severity,
          confidence: 1,
          title,
          explanation:
            `Payroll reconciliation for ${body.periodStart} → ${body.periodEnd}: ${row.reason}. ` +
            `Worker ${row.reference} (${row.fullName}) has ${row.payrollEntries} payroll entr(ies) ` +
            `in the window totalling ${row.currency} ${row.grossPay} for ${row.daysClaimed} claimed ` +
            `day(s) against ${row.accessDays} distinct site-access day(s).`,
          evidenceRefs: {
            workerId: row.workerId,
            reference: row.reference,
            vendorId: row.vendorId,
            periodStart: body.periodStart,
            periodEnd: body.periodEnd,
            daysClaimed: row.daysClaimed,
            accessDays: row.accessDays,
            unmatchedDays: row.unmatchedDays,
            grossPay: row.grossPay,
            valueAtRisk: row.valueAtRisk,
            wageShortfall: row.wageShortfall,
          },
        });
      };
      for (const row of summary.rows) {
        if (row.isGhost) {
          emit(
            "ghost_worker",
            "critical",
            row,
            `Ghost worker — ${row.currency} ${row.grossPay} paid to ${row.reference} with no site access`,
          );
        }
        if (row.isOverclaim) {
          emit(
            "payroll_overclaim",
            "high",
            row,
            `Payroll overclaim — ${row.unmatchedDays} unevidenced day(s) for ${row.reference}`,
          );
        }
        if (row.isUnderpaid) {
          emit(
            "wage_underpayment",
            "high",
            row,
            `Wage underpayment — ${row.reference} short by ${row.currency} ${row.wageShortfall}`,
          );
        }
      }
      for (let i = 0; i < toInsert.length; i += 200) {
        await app.db.insert(signals).values(toInsert.slice(i, i + 200));
      }

      const runId = newId("wrc");
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "create",
        objectType: "workforce_reconciliation",
        objectId: runId,
        payload: {
          periodStart: body.periodStart,
          periodEnd: body.periodEnd,
          workers: summary.workers,
          ghosts: summary.ghosts,
          overclaims: summary.overclaims,
          underpayments: summary.underpayments,
          totals: summary.totals,
          signalsRaised: toInsert.length,
        },
        storePayload: true,
      });
      return reply.status(201).send({ runId, ...summary, signalsRaised: toInsert.length });
    },
  );

  app.get(
    "/projects/:projectId/workforce/reconciliations",
    { preHandler: readGate },
    async (req) => {
      const q = reconciliationQuerySchema.parse(req.query);
      const to = q.to ?? todayISO();
      const from = q.from ?? addDaysISO(to, -30);
      if (to < from) throw badRequest("to must not precede from");
      const summary = await computeReconciliation(req.companyId!, req.projectId!, from, to);
      // A read never writes: this is the same engine, replayed for review.
      return { ...summary, persisted: false };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Labour risk flags (#671-675) + modern-slavery scoring (#694)      */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/labour-risk-flags",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = riskFlagCreateSchema.parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      let subject: string;
      let vendorId: string | null = body.vendorId ?? null;
      if (body.workerId) {
        const worker = await fetchWorker(body.workerId, companyId, projectId);
        subject = `worker ${worker.reference} (${worker.fullName})`;
      } else {
        const vendor = await requireVendor(body.vendorId!, companyId);
        vendorId = vendor.id;
        subject = `subcontractor ${vendor.name}`;
      }
      // The signal severity is driven by the INDICATOR, not by the reporter:
      // passport retention is high whoever files it.
      const derived = indicatorSeverity(body.indicator);
      const signalId = newId("sig");
      await app.db.insert(signals).values({
        id: signalId,
        companyId,
        projectId,
        detector: "labour_rights_indicator",
        severity: derived,
        confidence: 1,
        title: `Labour rights indicator: ${body.indicator} — ${subject}`,
        explanation:
          `A ${body.indicator.replace(/_/g, " ")} indicator was raised against ${subject} via ` +
          `${body.source.replace(/_/g, " ")}. ${body.detail ?? "No further detail was recorded."} ` +
          (derived === "high"
            ? "This indicator is treated as direct evidence of forced labour under the ILO framework " +
              "and must be investigated before further work is accepted from this employer."
            : "This indicator contributes to the subcontractor's modern-slavery exposure score."),
        evidenceRefs: {
          indicator: body.indicator,
          workerId: body.workerId ?? null,
          vendorId,
          source: body.source,
        },
      });
      const id = newId("lrf");
      await app.db.insert(labourRiskFlags).values({
        id,
        companyId,
        projectId,
        workerId: body.workerId ?? null,
        vendorId,
        indicator: body.indicator,
        severity: body.severity ?? derived,
        detail: body.detail ?? null,
        source: body.source,
        signalId,
        raisedBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "create",
        objectType: "labour_risk_flag",
        objectId: id,
        payload: {
          indicator: body.indicator,
          workerId: body.workerId ?? null,
          vendorId,
          source: body.source,
          signalId,
        },
        storePayload: true,
      });
      const created = await fetchFlag(id, companyId, projectId);
      return reply.status(201).send(created);
    },
  );

  app.get("/projects/:projectId/labour-risk-flags", { preHandler: readGate }, async (req) => {
    const q = riskFlagListQuerySchema.parse(req.query);
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    const conds = [
      eq(labourRiskFlags.companyId, companyId),
      eq(labourRiskFlags.projectId, projectId),
    ];
    if (q.indicator) conds.push(eq(labourRiskFlags.indicator, q.indicator));
    if (q.vendorId) conds.push(eq(labourRiskFlags.vendorId, q.vendorId));
    if (q.workerId) conds.push(eq(labourRiskFlags.workerId, q.workerId));
    if (q.open === "true") conds.push(isNull(labourRiskFlags.resolvedAt));
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(labourRiskFlags).where(where);
    const rows = await app.db
      .select()
      .from(labourRiskFlags)
      .where(where)
      .orderBy(desc(labourRiskFlags.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const workerIds = rows.map((r) => r.workerId).filter((v): v is string => Boolean(v));
    const workerRows = workerIds.length
      ? await app.db
          .select({ id: workers.id, reference: workers.reference, fullName: workers.fullName })
          .from(workers)
          .where(and(eq(workers.projectId, projectId), inArray(workers.id, workerIds)))
      : [];
    const workerById = new Map(workerRows.map((w) => [w.id, w]));
    const names = await vendorNames(
      companyId,
      rows.map((r) => r.vendorId).filter((v): v is string => Boolean(v)),
    );
    const items = rows.map((r) => ({
      ...r,
      open: r.resolvedAt === null,
      workerReference: r.workerId ? (workerById.get(r.workerId)?.reference ?? null) : null,
      workerName: r.workerId ? (workerById.get(r.workerId)?.fullName ?? null) : null,
      vendorName: r.vendorId ? (names.get(r.vendorId) ?? null) : null,
    }));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post(
    "/projects/:projectId/labour-risk-flags/:flagId/resolve",
    { preHandler: standardGate },
    async (req) => {
      const { flagId } = req.params as { flagId: string };
      const body = resolveSchema.parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const flag = await fetchFlag(flagId, companyId, projectId);
      if (flag.resolvedAt) throw badRequest("This risk flag is already resolved");
      const now = new Date().toISOString();
      await app.db
        .update(labourRiskFlags)
        .set({ resolvedAt: now, resolution: body.resolution })
        .where(eq(labourRiskFlags.id, flagId));
      if (flag.signalId) {
        // The signal is not deleted — the record that it was raised survives;
        // only its disposition moves to closed.
        await app.db
          .update(signals)
          .set({ disposition: "closed", reviewerId: req.user!.id, reviewerNotes: body.resolution })
          .where(and(eq(signals.id, flag.signalId), eq(signals.disposition, "new")));
      }
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "labour_risk_flag",
        objectId: flagId,
        payload: { from: "open", to: "resolved", resolution: body.resolution },
        storePayload: true,
      });
      return fetchFlag(flagId, companyId, projectId);
    },
  );

  /**
   * Modern-slavery composite scoring at subcontractor level (#694). Risk
   * attaches to the EMPLOYER: a flag raised against a worker rolls up to that
   * worker's vendor, and reconciliation signals are attributed through the
   * worker record too, so a vendor cannot dilute its score by keeping flags
   * nominally personal. Workers with no vendor are grouped as "Unassigned"
   * rather than dropped — unattributed labour is itself a finding.
   */
  app.get("/projects/:projectId/workforce/vendor-risk", { preHandler: readGate }, async (req) => {
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    const workerRows = await app.db
      .select()
      .from(workers)
      .where(and(eq(workers.companyId, companyId), eq(workers.projectId, projectId)));
    const vendorOfWorker = new Map(workerRows.map((w) => [w.id, w.vendorId]));

    const flags = await app.db
      .select()
      .from(labourRiskFlags)
      .where(
        and(
          eq(labourRiskFlags.companyId, companyId),
          eq(labourRiskFlags.projectId, projectId),
          isNull(labourRiskFlags.resolvedAt),
        ),
      );
    const reconSignals = await app.db
      .select({ detector: signals.detector, evidenceRefs: signals.evidenceRefs })
      .from(signals)
      .where(
        and(
          eq(signals.companyId, companyId),
          eq(signals.projectId, projectId),
          inArray(signals.detector, ["ghost_worker", "payroll_overclaim"]),
        ),
      );

    const UNASSIGNED = "__unassigned__";
    const buckets = new Map<string, VendorRiskInput>();
    const bucket = (vendorId: string | null): VendorRiskInput => {
      const key = vendorId ?? UNASSIGNED;
      let b = buckets.get(key);
      if (!b) {
        b = {
          vendorId,
          vendorName: vendorId ?? "Unassigned",
          workers: 0,
          contractIssued: 0,
          idVerified: 0,
          openFlagIndicators: [],
          ghostSignals: 0,
          overclaimSignals: 0,
        };
        buckets.set(key, b);
      }
      return b;
    };
    for (const w of workerRows) {
      const b = bucket(w.vendorId);
      b.workers += 1;
      if (w.contractIssued === 1) b.contractIssued += 1;
      if (w.idVerified === 1) b.idVerified += 1;
    }
    for (const f of flags) {
      const vendorId = f.vendorId ?? (f.workerId ? (vendorOfWorker.get(f.workerId) ?? null) : null);
      bucket(vendorId).openFlagIndicators.push(f.indicator);
    }
    for (const s of reconSignals) {
      const ref = s.evidenceRefs as { workerId?: string; vendorId?: string | null } | null;
      const vendorId = ref?.workerId
        ? (vendorOfWorker.get(ref.workerId) ?? ref.vendorId ?? null)
        : (ref?.vendorId ?? null);
      const b = bucket(vendorId);
      if (s.detector === "ghost_worker") b.ghostSignals += 1;
      else b.overclaimSignals += 1;
    }

    const names = await vendorNames(
      companyId,
      [...buckets.values()].map((b) => b.vendorId).filter((v): v is string => Boolean(v)),
    );
    for (const b of buckets.values()) {
      if (b.vendorId) b.vendorName = names.get(b.vendorId) ?? b.vendorId;
    }
    const items = rankVendorRisk([...buckets.values()]);
    return {
      items,
      total: items.length,
      weighting:
        "45 pts open risk flags (12 per critical indicator, 6 per other), 25 pts reconciliation " +
        "signals (6 per ghost worker, 3 per overclaim), 18 pts contract-issuance gap, 12 pts " +
        "identity-verification gap. Bands: <20 low, <45 medium, <70 high, else critical.",
    };
  });

  /* ---------------------------------------------------------------- */
  /* Welfare inspections (#683-688)                                    */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/welfare-inspections",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = welfareCreateSchema.parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      if (body.vendorId) await requireVendor(body.vendorId, companyId);
      const areas: WelfareArea[] = body.areas.map((a) => ({
        area: a.area,
        score: a.score,
        note: a.note ?? null,
        photoFileId: a.photoFileId ?? null,
      }));
      const overallScore = round2(areas.reduce((s, a) => s + a.score, 0) / areas.length);
      const actions: WelfareAction[] = (body.actions ?? []).map((a) => ({
        id: newId("wac"),
        text: a.text,
        dueDate: a.dueDate ?? null,
        closed: false,
        closedAt: null,
        closedBy: null,
        note: null,
      }));
      // Inspections are identified by date + location, not by a sequence:
      // the schema has no number column, and a number the record itself
      // cannot show is worse than none.
      const id = newId("wfi");
      const ref = `${body.location} on ${body.inspectionDate}`;
      await app.db.insert(welfareInspections).values({
        id,
        companyId,
        projectId,
        inspectionDate: body.inspectionDate,
        location: body.location,
        vendorId: body.vendorId ?? null,
        areas,
        occupancyCount: body.occupancyCount ?? null,
        capacity: body.capacity ?? null,
        overallScore,
        actions,
        inspectedBy: req.user!.id,
      });

      const raised: string[] = [];
      // Occupancy density compliance (#684) — overcrowding is measured, not
      // judged: capacity is the operator's own declared figure.
      if (
        body.occupancyCount != null &&
        body.capacity != null &&
        body.occupancyCount > body.capacity
      ) {
        const over = body.occupancyCount - body.capacity;
        const signalId = newId("sig");
        raised.push(signalId);
        await app.db.insert(signals).values({
          id: signalId,
          companyId,
          projectId,
          detector: "accommodation_overcrowding",
          severity: "high",
          confidence: 1,
          title: `Accommodation overcrowding — ${body.location} at ${body.occupancyCount}/${body.capacity}`,
          explanation:
            `The welfare inspection of ${ref} recorded ${body.occupancyCount} occupants against ` +
            `a declared capacity of ${body.capacity} — ` +
            `${over} over (${Math.round((body.occupancyCount / body.capacity) * 100)}% of capacity). ` +
            `Occupancy above declared capacity breaches IFC/EBRD worker accommodation guidance and ` +
            `is a standing health risk.`,
          evidenceRefs: {
            inspectionId: id,
            location: body.location,
            occupancyCount: body.occupancyCount,
            capacity: body.capacity,
            over,
          },
        });
      }
      const failing = areas.filter((a) => a.score <= 2);
      if (failing.length > 0) {
        const signalId = newId("sig");
        raised.push(signalId);
        await app.db.insert(signals).values({
          id: signalId,
          companyId,
          projectId,
          detector: "welfare_standard_failure",
          severity: "medium",
          confidence: 1,
          title: `Welfare standard failure — ${failing.map((f) => f.area).join(", ")} at ${body.location}`,
          explanation:
            `The welfare inspection of ${ref} scored ${failing.length} area(s) at or below 2 of 5: ` +
            `${failing.map((f) => `${f.area} (${f.score})`).join(", ")}. ` +
            `Overall score ${overallScore}/5. Areas scoring 2 or less are treated as failing the ` +
            `standard and require a dated corrective action.`,
          evidenceRefs: {
            inspectionId: id,
            location: body.location,
            overallScore,
            failing: failing.map((f) => ({ area: f.area, score: f.score })),
          },
        });
      }

      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "create",
        objectType: "welfare_inspection",
        objectId: id,
        payload: {
          location: body.location,
          inspectionDate: body.inspectionDate,
          overallScore,
          areas,
          occupancyCount: body.occupancyCount ?? null,
          capacity: body.capacity ?? null,
          signalsRaised: raised.length,
        },
        storePayload: true,
      });
      const created = await fetchInspection(id, companyId, projectId);
      return reply.status(201).send({ ...created, signalsRaised: raised.length });
    },
  );

  app.get("/projects/:projectId/welfare-inspections", { preHandler: readGate }, async (req) => {
    const q = welfareListQuerySchema.parse(req.query);
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    const conds = [
      eq(welfareInspections.companyId, companyId),
      eq(welfareInspections.projectId, projectId),
    ];
    if (q.vendorId) conds.push(eq(welfareInspections.vendorId, q.vendorId));
    if (q.from) conds.push(gte(welfareInspections.inspectionDate, q.from));
    if (q.to) conds.push(lte(welfareInspections.inspectionDate, q.to));
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(welfareInspections).where(where);
    const rows = await app.db
      .select()
      .from(welfareInspections)
      .where(where)
      .orderBy(desc(welfareInspections.inspectionDate), desc(welfareInspections.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const items = rows.map((r) => {
      const actions = r.actions as WelfareAction[];
      const areas = r.areas as WelfareArea[];
      return {
        ...r,
        openActions: actions.filter((a) => !a.closed).length,
        failingAreas: areas.filter((a) => a.score <= 2).length,
        overcrowded:
          r.occupancyCount != null && r.capacity != null && r.occupancyCount > r.capacity,
      };
    });
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get(
    "/projects/:projectId/welfare-inspections/:inspectionId",
    { preHandler: readGate },
    async (req) => {
      const { inspectionId } = req.params as { inspectionId: string };
      const companyId = req.companyId!;
      const inspection = await fetchInspection(inspectionId, companyId, req.projectId!);
      const names = inspection.vendorId
        ? await vendorNames(companyId, [inspection.vendorId])
        : new Map();
      const actions = inspection.actions as WelfareAction[];
      const areas = inspection.areas as WelfareArea[];
      return {
        ...inspection,
        vendorName: inspection.vendorId ? (names.get(inspection.vendorId) ?? null) : null,
        openActions: actions.filter((a) => !a.closed).length,
        failingAreas: areas.filter((a) => a.score <= 2).length,
        overcrowded:
          inspection.occupancyCount != null &&
          inspection.capacity != null &&
          inspection.occupancyCount > inspection.capacity,
      };
    },
  );

  app.post(
    "/projects/:projectId/welfare-inspections/:inspectionId/actions/:actionId/close",
    { preHandler: standardGate },
    async (req) => {
      const { inspectionId, actionId } = req.params as { inspectionId: string; actionId: string };
      const body = closeActionSchema.parse(req.body ?? {});
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const inspection = await fetchInspection(inspectionId, companyId, projectId);
      const actions = inspection.actions as WelfareAction[];
      const action = actions.find((a) => a.id === actionId);
      if (!action) throw notFound("Corrective action not found on this inspection");
      if (action.closed) throw badRequest("This corrective action is already closed");
      const now = new Date().toISOString();
      const next = actions.map((a) =>
        a.id === actionId
          ? { ...a, closed: true, closedAt: now, closedBy: req.user!.id, note: body.note ?? null }
          : a,
      );
      await app.db
        .update(welfareInspections)
        .set({ actions: next })
        .where(eq(welfareInspections.id, inspectionId));
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "welfare_action",
        objectId: actionId,
        payload: { inspectionId, from: "open", to: "closed", note: body.note ?? null },
        storePayload: true,
      });
      return fetchInspection(inspectionId, companyId, projectId);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Labour audits + CAP tracking (#697-699)                           */
  /* ---------------------------------------------------------------- */

  /**
   * Lazy CAP-overdue sweep (#699, the finance/payments sweep pattern): a
   * corrective action whose due date has passed while the finding is still
   * open breaches its obligation and raises a high signal — exactly once,
   * guarded by `capBreachedAt` stamped on the finding itself.
   */
  async function sweepOverdueCaps(
    companyId: string,
    projectId: string,
    actorId: string,
  ): Promise<void> {
    const today = todayISO();
    const rows = await app.db
      .select()
      .from(labourAudits)
      .where(
        and(
          eq(labourAudits.companyId, companyId),
          eq(labourAudits.projectId, projectId),
          inArray(labourAudits.status, ["reported", "in_progress"]),
        ),
      );
    if (rows.length === 0) return;
    const names = await vendorNames(
      companyId,
      rows.map((a) => a.vendorId),
    );
    for (const audit of rows) {
      const findings = audit.findings as AuditFinding[];
      const overdue = findings.filter(
        (f) => f.capDueDate !== null && f.capDueDate < today && !f.closedAt && !f.capBreachedAt,
      );
      if (overdue.length === 0) continue;
      const now = new Date().toISOString();
      const vendorName = names.get(audit.vendorId) ?? audit.vendorId;
      for (const f of overdue) {
        if (f.obligationId) {
          await app.db
            .update(obligations)
            .set({ status: "breached" })
            .where(and(eq(obligations.id, f.obligationId), eq(obligations.status, "open")));
        }
        await app.db.insert(signals).values({
          id: newId("sig"),
          companyId,
          projectId,
          detector: "labour_cap_overdue",
          severity: "high",
          confidence: 1,
          title: `Labour audit CAP overdue — ${vendorName}`,
          explanation:
            `A ${f.severity} corrective action from the labour audit of ${vendorName} ` +
            `(scheduled ${audit.scheduledFor}) fell due on ${f.capDueDate} and remains open: ` +
            `${f.description}. An unclosed corrective action on a labour-rights finding is a ` +
            `continuing breach of the subcontract's labour conditions and of IFC PS2.`,
          evidenceRefs: {
            auditId: audit.id,
            findingId: f.id,
            vendorId: audit.vendorId,
            indicator: f.indicator,
            capDueDate: f.capDueDate,
            obligationId: f.obligationId,
          },
        });
        await appendLedger(app.db, {
          companyId,
          actorId,
          action: "state_change",
          objectType: "labour_audit_finding",
          objectId: f.id,
          payload: { auditId: audit.id, from: "open", to: "cap_breached", capDueDate: f.capDueDate },
        });
      }
      const overdueIds = new Set(overdue.map((f) => f.id));
      const next = findings.map((f) =>
        overdueIds.has(f.id) ? { ...f, capBreachedAt: now } : f,
      );
      await app.db
        .update(labourAudits)
        .set({ findings: next, updatedAt: now })
        .where(eq(labourAudits.id, audit.id));
    }
  }

  app.post("/projects/:projectId/labour-audits", { preHandler: standardGate }, async (req, reply) => {
    const body = auditCreateSchema.parse(req.body);
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    const vendor = await requireVendor(body.vendorId, companyId);
    const id = newId("lab");
    await app.db.insert(labourAudits).values({
      id,
      companyId,
      projectId,
      vendorId: vendor.id,
      scheduledFor: body.scheduledFor,
      isUnannounced: body.isUnannounced ? 1 : 0,
      status: "scheduled",
      findings: [],
    });
    await appendLedger(app.db, {
      companyId,
      actorId: req.user!.id,
      action: "create",
      objectType: "labour_audit",
      objectId: id,
      payload: {
        vendorId: vendor.id,
        vendorName: vendor.name,
        scheduledFor: body.scheduledFor,
        isUnannounced: body.isUnannounced ? 1 : 0,
      },
      storePayload: true,
    });
    const created = await fetchAudit(id, companyId, projectId);
    return reply.status(201).send({ ...created, vendorName: vendor.name });
  });

  app.post(
    "/projects/:projectId/labour-audits/:auditId/report",
    { preHandler: standardGate },
    async (req) => {
      const { auditId } = req.params as { auditId: string };
      const body = auditReportSchema.parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const audit = await fetchAudit(auditId, companyId, projectId);
      if (audit.status === "reported" || audit.status === "closed") {
        throw badRequest(`A ${audit.status} audit cannot be reported again`);
      }
      const vendor = await requireVendor(audit.vendorId, companyId);
      const now = new Date().toISOString();

      // Every finding with a CAP deadline becomes an assurance Obligation, so
      // the labour register and the obligation register share one clock.
      const findings: AuditFinding[] = [];
      for (const f of body.findings) {
        const findingId = newId("laf");
        let obligationId: string | null = null;
        if (f.capDueDate) {
          obligationId = newId("obl");
          await app.db.insert(obligations).values({
            id: obligationId,
            companyId,
            projectId,
            sourceClause: `Labour audit CAP — ${vendor.name}`,
            trigger: f.description,
            deadline: `${f.capDueDate}T23:59:59Z`,
            warnDaysBefore: 7,
            evidenceRequirement:
              "Verified corrective action closing the labour audit finding, with re-inspection note",
            status: "open",
            createdBy: req.user!.id,
          });
        }
        findings.push({
          id: findingId,
          indicator: f.indicator ?? null,
          description: f.description,
          severity: f.severity,
          capDueDate: f.capDueDate ?? null,
          obligationId,
          closedAt: null,
          closedBy: null,
          closedNote: null,
          capBreachedAt: null,
        });
      }

      await app.db
        .update(labourAudits)
        .set({
          status: "reported",
          findings,
          score: body.score ?? null,
          reportFileId: body.reportFileId ?? null,
          auditedBy: req.user!.id,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(labourAudits.id, auditId));
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "labour_audit",
        objectId: auditId,
        payload: {
          from: audit.status,
          to: "reported",
          findings: findings.map((f) => ({
            id: f.id,
            severity: f.severity,
            indicator: f.indicator,
            capDueDate: f.capDueDate,
            obligationId: f.obligationId,
          })),
          score: body.score ?? null,
        },
        storePayload: true,
      });
      const updated = await fetchAudit(auditId, companyId, projectId);
      return { ...updated, vendorName: vendor.name };
    },
  );

  app.post(
    "/projects/:projectId/labour-audits/:auditId/findings/:findingId/close",
    { preHandler: standardGate },
    async (req) => {
      const { auditId, findingId } = req.params as { auditId: string; findingId: string };
      const body = closeFindingSchema.parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const audit = await fetchAudit(auditId, companyId, projectId);
      const findings = audit.findings as AuditFinding[];
      const finding = findings.find((f) => f.id === findingId);
      if (!finding) throw notFound("Finding not found on this audit");
      if (finding.closedAt) throw badRequest("This finding is already closed");
      const now = new Date().toISOString();
      const next = findings.map((f) =>
        f.id === findingId
          ? { ...f, closedAt: now, closedBy: req.user!.id, closedNote: body.note }
          : f,
      );
      // A late close does not rewrite the register: only a still-open
      // obligation flips to satisfied; a breached one stays breached.
      if (finding.obligationId) {
        await app.db
          .update(obligations)
          .set({ status: "satisfied" })
          .where(and(eq(obligations.id, finding.obligationId), eq(obligations.status, "open")));
      }
      const allClosed = next.every((f) => f.closedAt !== null);
      await app.db
        .update(labourAudits)
        .set({
          findings: next,
          status: allClosed ? "closed" : audit.status,
          updatedAt: now,
        })
        .where(eq(labourAudits.id, auditId));
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "labour_audit_finding",
        objectId: findingId,
        payload: {
          auditId,
          from: "open",
          to: "closed",
          note: body.note,
          obligationId: finding.obligationId,
          lateClose: finding.capBreachedAt !== null,
        },
        storePayload: true,
      });
      return fetchAudit(auditId, companyId, projectId);
    },
  );

  app.get("/projects/:projectId/labour-audits", { preHandler: readGate }, async (req) => {
    const q = auditListQuerySchema.parse(req.query);
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    await sweepOverdueCaps(companyId, projectId, req.user!.id);
    const conds = [eq(labourAudits.companyId, companyId), eq(labourAudits.projectId, projectId)];
    if (q.vendorId) conds.push(eq(labourAudits.vendorId, q.vendorId));
    if (q.status) conds.push(eq(labourAudits.status, q.status));
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(labourAudits).where(where);
    const rows = await app.db
      .select()
      .from(labourAudits)
      .where(where)
      .orderBy(desc(labourAudits.scheduledFor), desc(labourAudits.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const names = await vendorNames(
      companyId,
      rows.map((r) => r.vendorId),
    );
    const items = rows.map((r) => {
      const findings = r.findings as AuditFinding[];
      return {
        ...r,
        vendorName: names.get(r.vendorId) ?? r.vendorId,
        findingCount: findings.length,
        openFindings: findings.filter((f) => !f.closedAt).length,
        overdueCaps: findings.filter((f) => f.capBreachedAt !== null && !f.closedAt).length,
      };
    });
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/labour-audits/:auditId", { preHandler: readGate }, async (req) => {
    const { auditId } = req.params as { auditId: string };
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    await fetchAudit(auditId, companyId, projectId); // 404 before sweeping
    await sweepOverdueCaps(companyId, projectId, req.user!.id);
    const audit = await fetchAudit(auditId, companyId, projectId);
    const findings = audit.findings as AuditFinding[];
    const obligationIds = findings
      .map((f) => f.obligationId)
      .filter((v): v is string => Boolean(v));
    const obs = obligationIds.length
      ? await app.db
          .select()
          .from(obligations)
          .where(and(eq(obligations.projectId, projectId), inArray(obligations.id, obligationIds)))
      : [];
    const obById = new Map(obs.map((o) => [o.id, o]));
    const names = await vendorNames(companyId, [audit.vendorId]);
    return {
      ...audit,
      vendorName: names.get(audit.vendorId) ?? audit.vendorId,
      openFindings: findings.filter((f) => !f.closedAt).length,
      overdueCaps: findings.filter((f) => f.capBreachedAt !== null && !f.closedAt).length,
      findings: findings.map((f) => ({
        ...f,
        obligation: f.obligationId ? (obById.get(f.obligationId) ?? null) : null,
      })),
    };
  });
};
