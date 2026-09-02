/**
 * Commissioning — systems, subsystems, and the test records that prove they
 * work.
 *
 * The ladder in COMMISSIONING_STATUSES is a GATE, not a label: nothing is
 * functionally tested before its pre-functional checks are complete, because
 * a functional test of a system that was never statically checked proves
 * only that it ran once. `/readiness` exposes that gate as data so a screen
 * can say WHY the button is disabled instead of just disabling it.
 *
 * Pre-functional and functional records share one table with `testKind` as
 * the discriminator (see the schema comment). Two facts on those records are
 * worth more than the result itself:
 *
 *   - the WITNESS. A contractor's own signature on its own test is not
 *     evidence; a second party watching it is. Third-party witnesses (an
 *     insurer's engineer, a certifying authority) are recorded by name and
 *     organisation because they are frequently not platform users.
 *   - the INSTRUMENTS. A reading taken with an out-of-calibration meter is
 *     not a reading, and it is the first thing an auditor checks. A pass
 *     recorded on an expired instrument is refused here rather than
 *     discovered at handover.
 */

import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  commissioningSystems,
  commissioningTestRecords,
  nonConformanceReports,
  punchItems,
} from "@constructos/db";
import {
  COMMISSIONING_LEVELS,
  COMMISSIONING_STATUSES,
  COMMISSIONING_TEST_KINDS,
  COMMISSIONING_TEST_STATUSES,
  NCR_SEVERITIES,
  TEST_RESULTS,
  type CommissioningStatus,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import {
  allocateReference,
  assertAsset,
  assertDistinctActor,
  assertLocation,
  assertVendor,
  buildGates,
  fileIdsSchema,
  idSchema,
  isoDateSchema,
  isoTimestampSchema,
  ledger,
  loadSystemOr404,
  nowISO,
  todayISO,
  uniq,
} from "./shared.js";
import { evaluateNumeric } from "./checklistItems.js";
import { createNcr, createPunchItemFor } from "./raise.js";
import { sweepQuality } from "./sweeps.js";

/* ------------------------------------------------------------------ */
/* Test-kind classification                                            */
/* ------------------------------------------------------------------ */

/** Kinds that belong to the static, pre-energisation half of the ladder. */
export const PREFUNCTIONAL_TEST_KINDS = [
  "prefunctional_checklist",
  "static_completion",
  "energisation",
  "loop_check",
  "pressure_test",
  "leak_test",
  "insulation_resistance",
  "earth_continuity",
  "flushing_and_chlorination",
] as const;

/** Kinds that only mean something once the system is live. */
export const FUNCTIONAL_TEST_KINDS = [
  "functional_performance",
  "integrated_systems",
  "seasonal",
  "air_balance",
  "water_balance",
  "fire_alarm_verification",
  "energy_verification",
  "acoustic",
] as const;

const prefunctionalSet = new Set<string>(PREFUNCTIONAL_TEST_KINDS);
const functionalSet = new Set<string>(FUNCTIONAL_TEST_KINDS);

export type TestPhase = "prefunctional" | "functional" | "unclassified";

/**
 * Which half of the ladder a record belongs to. A `retest` inherits the phase
 * of the record it retests — a retest of a pressure test is still a
 * pre-functional test, however late in the programme it happens.
 */
export function testPhase(
  record: { testKind: string; retestOfId?: string | null },
  byId?: Map<string, { testKind: string; retestOfId?: string | null }>,
): TestPhase {
  if (prefunctionalSet.has(record.testKind)) return "prefunctional";
  if (functionalSet.has(record.testKind)) return "functional";
  if (record.testKind === "retest" && record.retestOfId && byId) {
    const parent = byId.get(record.retestOfId);
    if (parent && parent.retestOfId !== record.retestOfId) {
      return testPhase(parent, byId);
    }
  }
  return "unclassified";
}

/** Test statuses at which the record is finished and stands as evidence. */
const SETTLED_TEST_STATUSES = ["complete", "accepted"];

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const systemCreateSchema = z.object({
  systemCode: z.string().min(1).max(100),
  name: z.string().min(1).max(300),
  description: z.string().max(10_000).nullable().optional(),
  discipline: z.string().max(100).nullable().optional(),
  level: z.enum(COMMISSIONING_LEVELS).optional(),
  parentId: idSchema.nullable().optional(),
  locationId: idSchema.nullable().optional(),
  assetId: idSchema.nullable().optional(),
  ifcGlobalIds: z.array(z.string().min(1).max(64)).max(500).optional(),
  vendorId: idSchema.nullable().optional(),
  commitmentId: idSchema.nullable().optional(),
  cxAgentId: idSchema.nullable().optional(),
  plannedStaticCompletion: isoDateSchema.nullable().optional(),
  plannedEnergisation: isoDateSchema.nullable().optional(),
  plannedFunctionalTest: isoDateSchema.nullable().optional(),
  plannedCompletionDate: isoDateSchema.nullable().optional(),
  seasonalTestDueDate: isoDateSchema.nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const systemPatchSchema = systemCreateSchema.omit({ systemCode: true, parentId: true }).partial().extend({
  status: z.enum(COMMISSIONING_STATUSES).optional(),
  percentComplete: z.number().min(0).max(100).optional(),
  actualStaticCompletion: isoDateSchema.nullable().optional(),
  actualEnergisation: isoDateSchema.nullable().optional(),
  actualCompletionDate: isoDateSchema.nullable().optional(),
  beneficialUseDate: isoDateSchema.nullable().optional(),
  warrantyStartDate: isoDateSchema.nullable().optional(),
});

const systemListQuery = pageQuerySchema.extend({
  status: z.enum(COMMISSIONING_STATUSES).optional(),
  level: z.enum(COMMISSIONING_LEVELS).optional(),
  discipline: z.string().max(100).optional(),
  parentId: idSchema.optional(),
  assetId: idSchema.optional(),
  search: z.string().max(200).optional(),
});

const instrumentSchema = z.object({
  instrumentId: idSchema.nullable().optional(),
  name: z.string().max(200).nullable().optional(),
  serial: z.string().min(1).max(200),
  calibrationDueDate: isoDateSchema.nullable().optional(),
  certificateFileId: idSchema.nullable().optional(),
});

const readingSchema = z.object({
  point: z.string().min(1).max(300),
  expected: z.number().finite().nullable().optional(),
  measured: z.number().finite().nullable().optional(),
  unit: z.string().max(50).nullable().optional(),
  tolerance: z.number().finite().nullable().optional(),
  toleranceMinus: z.number().finite().nullable().optional(),
  minValue: z.number().finite().nullable().optional(),
  maxValue: z.number().finite().nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

const testCreateSchema = z.object({
  systemId: idSchema,
  testKind: z.enum(COMMISSIONING_TEST_KINDS),
  title: z.string().min(1).max(300),
  description: z.string().max(10_000).nullable().optional(),
  testProcedureRef: z.string().max(200).nullable().optional(),
  procedureFileId: idSchema.nullable().optional(),
  checklistId: idSchema.nullable().optional(),
  checklistTemplateId: idSchema.nullable().optional(),
  assetId: idSchema.nullable().optional(),
  equipmentId: idSchema.nullable().optional(),
  locationId: idSchema.nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  scheduledFor: isoDateSchema.nullable().optional(),
  contractorRepName: z.string().max(200).nullable().optional(),
  ambientConditions: z.record(z.string(), z.unknown()).optional(),
  instruments: z.array(instrumentSchema).max(50).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const testPatchSchema = testCreateSchema.omit({ systemId: true, testKind: true }).partial().extend({
  status: z.enum(COMMISSIONING_TEST_STATUSES).optional(),
});

const testListQuery = pageQuerySchema.extend({
  systemId: idSchema.optional(),
  testKind: z.enum(COMMISSIONING_TEST_KINDS).optional(),
  phase: z.enum(["prefunctional", "functional", "unclassified"]).optional(),
  status: z.enum(COMMISSIONING_TEST_STATUSES).optional(),
  result: z.enum(TEST_RESULTS).optional(),
  assetId: idSchema.optional(),
  search: z.string().max(200).optional(),
});

const deficiencySchema = z.object({
  description: z.string().min(1).max(10_000),
  raiseAs: z.enum(["punch_item", "ncr"]).optional(),
  severity: z.enum(NCR_SEVERITIES).optional(),
  ownerVendorId: idSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
});

const resultSchema = z.object({
  result: z.enum(TEST_RESULTS),
  performedAt: isoTimestampSchema.optional(),
  performedByName: z.string().max(200).nullable().optional(),
  readings: z.array(readingSchema).max(500).optional(),
  instruments: z.array(instrumentSchema).max(50).optional(),
  ambientConditions: z.record(z.string(), z.unknown()).optional(),
  deficiencies: z.array(deficiencySchema).max(200).optional(),
  reportFileId: idSchema.nullable().optional(),
  certificateFileId: idSchema.nullable().optional(),
  photoFileIds: fileIdsSchema.optional(),
});

const witnessSchema = z.object({
  witnessedByName: z.string().max(200).nullable().optional(),
  witnessedByOrganisation: z.string().max(200).nullable().optional(),
  /** a witness with no platform account: an insurer's engineer, a notified body */
  thirdPartyWitness: z.string().max(300).nullable().optional(),
  witnessedAt: isoTimestampSchema.optional(),
  note: z.string().max(4000).nullable().optional(),
});

const acceptTestSchema = z.object({
  certificateFileId: idSchema.nullable().optional(),
  note: z.string().max(4000).nullable().optional(),
});

const retestSchema = z.object({
  title: z.string().max(300).optional(),
  testKind: z.enum(COMMISSIONING_TEST_KINDS).optional(),
  scheduledFor: isoDateSchema.nullable().optional(),
  reason: z.string().max(10_000).nullable().optional(),
});

const acceptSystemSchema = z.object({
  beneficialUseDate: isoDateSchema.nullable().optional(),
  warrantyStartDate: isoDateSchema.nullable().optional(),
  note: z.string().max(4000).nullable().optional(),
});

const SYSTEM_PATCH_COLUMNS = [
  "name",
  "description",
  "discipline",
  "level",
  "locationId",
  "assetId",
  "ifcGlobalIds",
  "vendorId",
  "commitmentId",
  "cxAgentId",
  "plannedStaticCompletion",
  "plannedEnergisation",
  "plannedFunctionalTest",
  "plannedCompletionDate",
  "seasonalTestDueDate",
  "percentComplete",
  "actualStaticCompletion",
  "actualEnergisation",
  "actualCompletionDate",
  "beneficialUseDate",
  "warrantyStartDate",
  "detail",
] as const;

const TEST_PATCH_COLUMNS = [
  "title",
  "description",
  "testProcedureRef",
  "procedureFileId",
  "checklistId",
  "checklistTemplateId",
  "assetId",
  "equipmentId",
  "locationId",
  "vendorId",
  "scheduledFor",
  "contractorRepName",
  "ambientConditions",
  "instruments",
  "status",
  "detail",
] as const;

const OPEN_PUNCH_STATUSES = ["open", "in_progress", "ready_for_review"];
const OPEN_NCR_STATUSES = [
  "open",
  "under_review",
  "disposition_proposed",
  "disposition_approved",
  "action_in_progress",
  "verification_pending",
];

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const commissioningRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);

  async function fetchTest(recordId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(commissioningTestRecords)
      .where(
        and(
          eq(commissioningTestRecords.id, recordId),
          eq(commissioningTestRecords.companyId, companyId),
          eq(commissioningTestRecords.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Commissioning test record not found");
    return rows[0];
  }

  async function testsForSystem(systemId: string) {
    return app.db
      .select()
      .from(commissioningTestRecords)
      .where(eq(commissioningTestRecords.systemId, systemId))
      .orderBy(asc(commissioningTestRecords.number));
  }

  /**
   * Recount the system's tests and its OPEN deficiencies. Deficiencies live
   * in the punch and NCR registers, so the count is derived from them rather
   * than kept as a second truth that drifts.
   */
  async function refreshSystemCounters(systemId: string, projectId: string) {
    const tests = await testsForSystem(systemId);
    const byId = new Map(tests.map((t) => [t.id, t] as const));
    let prefunctional = 0;
    let functional = 0;
    const punchIds: string[] = [];
    const testIds: string[] = [];
    for (const t of tests) {
      const phase = testPhase(t, byId);
      if (phase === "prefunctional") prefunctional += 1;
      if (phase === "functional") functional += 1;
      testIds.push(t.id);
      for (const id of t.deficiencyRecordIds) punchIds.push(id);
    }
    const openPunch = punchIds.length
      ? await app.db
          .select({ id: punchItems.id })
          .from(punchItems)
          .where(
            and(
              inArray(punchItems.id, uniq(punchIds)),
              inArray(punchItems.status, OPEN_PUNCH_STATUSES),
            ),
          )
      : [];
    const openNcrs = testIds.length
      ? await app.db
          .select({ id: nonConformanceReports.id })
          .from(nonConformanceReports)
          .where(
            and(
              eq(nonConformanceReports.projectId, projectId),
              inArray(nonConformanceReports.testRecordId, testIds),
              inArray(nonConformanceReports.status, OPEN_NCR_STATUSES),
            ),
          )
      : [];
    const openDeficiencyCount = openPunch.length + openNcrs.length;
    await app.db
      .update(commissioningSystems)
      .set({
        prefunctionalTestCount: prefunctional,
        functionalTestCount: functional,
        openDeficiencyCount,
        updatedAt: nowISO(),
      })
      .where(eq(commissioningSystems.id, systemId));
    return {
      tests,
      openDeficiencyCount,
      openPunchItemIds: openPunch.map((p) => p.id),
      openNcrIds: openNcrs.map((n) => n.id),
    };
  }

  /** Is the system ready for a functional test, and if not, why not? */
  function functionalReadiness(tests: (typeof commissioningTestRecords.$inferSelect)[]) {
    const byId = new Map(tests.map((t) => [t.id, t] as const));
    const pre = tests.filter((t) => testPhase(t, byId) === "prefunctional");
    const blockers: string[] = [];
    if (pre.length === 0) {
      blockers.push(
        "No pre-functional test record exists on this system. Nothing may be functionally tested before its pre-functional checks are complete — a functional test of a system that was never statically checked proves only that it ran once.",
      );
    }
    for (const t of pre) {
      if (!SETTLED_TEST_STATUSES.includes(t.status)) {
        blockers.push(`${t.reference} (${t.testKind}) is ${t.status} and not yet complete.`);
      } else if (t.result === "fail" || t.result === "aborted") {
        blockers.push(`${t.reference} (${t.testKind}) recorded ${t.result} and has not been retested to a pass.`);
      }
    }
    return { allowed: blockers.length === 0, blockers };
  }

  /** Refuse a pass recorded on a meter that was out of calibration. */
  function calibrationBlockers(
    instruments: z.infer<typeof instrumentSchema>[],
    onDate: string,
  ): string[] {
    const blockers: string[] = [];
    for (const inst of instruments) {
      if (!inst.calibrationDueDate) continue;
      if (inst.calibrationDueDate < onDate) {
        blockers.push(
          `Instrument ${inst.name ?? inst.serial} (serial ${inst.serial}) was out of calibration on ${onDate} — its calibration ran out on ${inst.calibrationDueDate}.`,
        );
      }
    }
    return blockers;
  }

  /** Judge each reading against its own expected/tolerance, honestly. */
  function judgeReadings(readings: z.infer<typeof readingSchema>[]) {
    return readings.map((r) => {
      const verdict = evaluateNumeric(
        {
          id: r.point,
          itemType: "measurement",
          required: true,
          options: [],
          targetValue: r.expected ?? null,
          minValue: r.minValue ?? null,
          maxValue: r.maxValue ?? null,
          tolerancePlus: r.tolerance ?? null,
          toleranceMinus: r.toleranceMinus ?? r.tolerance ?? null,
          weight: 1,
          isCritical: false,
          photoRequired: false,
          raisesNcrOnFail: false,
        },
        r.measured ?? null,
      );
      return {
        ...r,
        lower: verdict.lower,
        upper: verdict.upper,
        pass: verdict.isPass,
        reasons: verdict.reasons,
      };
    });
  }

  /* ---------------------------------------------------------------- */
  /* Systems                                                           */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/commissioning/systems",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = systemCreateSchema.parse(req.body);
      const dupe = await app.db
        .select({ id: commissioningSystems.id })
        .from(commissioningSystems)
        .where(
          and(
            eq(commissioningSystems.projectId, req.projectId!),
            eq(commissioningSystems.systemCode, body.systemCode),
          ),
        )
        .limit(1);
      if (dupe[0]) {
        throw conflict(`System code "${body.systemCode}" already exists in this project.`);
      }
      if (body.vendorId) await assertVendor(app.db, req.companyId!, body.vendorId);
      if (body.locationId) await assertLocation(app.db, req.projectId!, body.locationId);
      if (body.assetId) await assertAsset(app.db, req.projectId!, body.assetId);
      let parent: typeof commissioningSystems.$inferSelect | null = null;
      if (body.parentId) {
        parent = await loadSystemOr404(app.db, req.companyId!, req.projectId!, body.parentId);
      }
      const { number, reference } = await allocateReference(
        app.db,
        req.projectId!,
        "commissioning_system",
        "CXS",
      );
      const id = newId("cxs");
      const path = parent ? `${parent.path ?? parent.id}/${id}` : id;
      const [created] = await app.db
        .insert(commissioningSystems)
        .values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          number,
          reference,
          systemCode: body.systemCode,
          name: body.name,
          description: body.description ?? null,
          discipline: body.discipline ?? null,
          level: body.level ?? (parent ? "subsystem" : "system"),
          parentId: parent?.id ?? null,
          path,
          locationId: body.locationId ?? null,
          assetId: body.assetId ?? null,
          ifcGlobalIds: body.ifcGlobalIds ?? [],
          vendorId: body.vendorId ?? null,
          commitmentId: body.commitmentId ?? null,
          cxAgentId: body.cxAgentId ?? null,
          plannedStaticCompletion: body.plannedStaticCompletion ?? null,
          plannedEnergisation: body.plannedEnergisation ?? null,
          plannedFunctionalTest: body.plannedFunctionalTest ?? null,
          plannedCompletionDate: body.plannedCompletionDate ?? null,
          seasonalTestDueDate: body.seasonalTestDueDate ?? null,
          detail: body.detail ?? {},
          createdBy: req.user!.id,
        })
        .returning();
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "commissioning_system",
        objectId: id,
        payload: created,
        storePayload: true,
      });
      return reply.status(201).send(created);
    },
  );

  app.get(
    "/projects/:projectId/commissioning/systems",
    { preHandler: readGate },
    async (req) => {
      await sweepQuality(app.db, req.companyId!, req.projectId!, req.user!.id);
      const q = systemListQuery.parse(req.query);
      const clauses = [
        eq(commissioningSystems.companyId, req.companyId!),
        eq(commissioningSystems.projectId, req.projectId!),
      ];
      if (q.status) clauses.push(eq(commissioningSystems.status, q.status));
      if (q.level) clauses.push(eq(commissioningSystems.level, q.level));
      if (q.discipline) clauses.push(eq(commissioningSystems.discipline, q.discipline));
      if (q.parentId) clauses.push(eq(commissioningSystems.parentId, q.parentId));
      if (q.assetId) clauses.push(eq(commissioningSystems.assetId, q.assetId));
      if (q.search) clauses.push(ilike(commissioningSystems.name, `%${q.search}%`));
      const where = and(...clauses);
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(commissioningSystems)
        .where(where);
      const items = await app.db
        .select()
        .from(commissioningSystems)
        .where(where)
        .orderBy(asc(commissioningSystems.path))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(items, Number(totalRow?.n ?? 0), q);
    },
  );

  app.get(
    "/projects/:projectId/commissioning/systems/:systemId",
    { preHandler: readGate },
    async (req) => {
      const { systemId } = req.params as { systemId: string };
      const system = await loadSystemOr404(app.db, req.companyId!, req.projectId!, systemId);
      const counters = await refreshSystemCounters(systemId, req.projectId!);
      const children = await app.db
        .select()
        .from(commissioningSystems)
        .where(eq(commissioningSystems.parentId, systemId))
        .orderBy(asc(commissioningSystems.systemCode));
      const readiness = functionalReadiness(counters.tests);
      return {
        ...(await loadSystemOr404(app.db, req.companyId!, req.projectId!, systemId)),
        children,
        testRecords: counters.tests,
        openDeficiencies: {
          count: counters.openDeficiencyCount,
          punchItemIds: counters.openPunchItemIds,
          ncrIds: counters.openNcrIds,
        },
        functionalReadiness: readiness,
        parentPath: system.path,
      };
    },
  );

  app.get(
    "/projects/:projectId/commissioning/systems/:systemId/readiness",
    { preHandler: readGate },
    async (req) => {
      const { systemId } = req.params as { systemId: string };
      await loadSystemOr404(app.db, req.companyId!, req.projectId!, systemId);
      const counters = await refreshSystemCounters(systemId, req.projectId!);
      const readiness = functionalReadiness(counters.tests);
      return {
        functionalTestingAllowed: readiness.allowed,
        blockers: readiness.blockers,
        prefunctionalTestCount: counters.tests.filter(
          (t) => testPhase(t, new Map(counters.tests.map((x) => [x.id, x]))) === "prefunctional",
        ).length,
        openDeficiencyCount: counters.openDeficiencyCount,
        openPunchItemIds: counters.openPunchItemIds,
        openNcrIds: counters.openNcrIds,
      };
    },
  );

  app.patch(
    "/projects/:projectId/commissioning/systems/:systemId",
    { preHandler: standardGate },
    async (req) => {
      const { systemId } = req.params as { systemId: string };
      const body = systemPatchSchema.parse(req.body);
      const system = await loadSystemOr404(app.db, req.companyId!, req.projectId!, systemId);
      if (body.vendorId) await assertVendor(app.db, req.companyId!, body.vendorId);
      if (body.locationId) await assertLocation(app.db, req.projectId!, body.locationId);
      if (body.assetId) await assertAsset(app.db, req.projectId!, body.assetId);

      if (body.status && body.status !== system.status) {
        // `on_hold` is the one status that may be entered from anywhere and
        // left back to where the system was; the rest of the ladder is
        // forward-only, because a system does not become less commissioned.
        const from = COMMISSIONING_STATUSES.indexOf(system.status as CommissioningStatus);
        const to = COMMISSIONING_STATUSES.indexOf(body.status);
        const holdInvolved = body.status === "on_hold" || system.status === "on_hold";
        if (!holdInvolved && to <= from) {
          throw badRequest(
            `Illegal commissioning transition ${system.status} → ${body.status}. The ladder is forward-only: ${COMMISSIONING_STATUSES.filter((s) => s !== "on_hold").join(" → ")}. Put the system on hold if work has stopped.`,
          );
        }
        if (
          (body.status === "functional_in_progress" || body.status === "functional_complete") &&
          system.status !== "on_hold"
        ) {
          const tests = await testsForSystem(systemId);
          const readiness = functionalReadiness(tests);
          if (!readiness.allowed) {
            throw badRequest(
              `${system.systemCode} is not ready for functional testing. ${readiness.blockers.join(" ")}`,
            );
          }
        }
      }

      const set: Record<string, unknown> = { updatedAt: nowISO() };
      for (const key of SYSTEM_PATCH_COLUMNS) {
        const value = (body as Record<string, unknown>)[key];
        if (value !== undefined) set[key] = value;
      }
      if (body.status !== undefined) set["status"] = body.status;
      await app.db
        .update(commissioningSystems)
        .set(set)
        .where(eq(commissioningSystems.id, systemId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: body.status ? "state_change" : "update",
        objectType: "commissioning_system",
        objectId: systemId,
        payload: { changed: Object.keys(body), from: system.status, to: body.status ?? system.status },
      });
      return loadSystemOr404(app.db, req.companyId!, req.projectId!, systemId);
    },
  );

  /** Owner acceptance of the system — never the Cx agent who tested it. */
  app.post(
    "/projects/:projectId/commissioning/systems/:systemId/accept",
    { preHandler: standardGate },
    async (req) => {
      const { systemId } = req.params as { systemId: string };
      const body = acceptSystemSchema.parse(req.body ?? {});
      const system = await loadSystemOr404(app.db, req.companyId!, req.projectId!, systemId);
      if (!["functional_complete", "seasonal_pending"].includes(system.status)) {
        throw badRequest(
          `${system.systemCode} is ${system.status}. A system is accepted once its functional testing is complete — accepting it earlier accepts a system nobody has finished proving.`,
        );
      }
      assertDistinctActor(
        req.user!.id,
        system.cxAgentId,
        `Acceptance of ${system.systemCode}`,
        "commissioned",
      );
      assertDistinctActor(
        req.user!.id,
        system.createdBy,
        `Acceptance of ${system.systemCode}`,
        "raised",
      );
      const at = nowISO();
      await app.db
        .update(commissioningSystems)
        .set({
          status: "accepted",
          acceptedBy: req.user!.id,
          acceptedAt: at,
          beneficialUseDate: body.beneficialUseDate ?? system.beneficialUseDate,
          warrantyStartDate: body.warrantyStartDate ?? system.warrantyStartDate,
          actualCompletionDate: system.actualCompletionDate ?? todayISO(),
          percentComplete: 100,
          updatedAt: at,
        })
        .where(eq(commissioningSystems.id, systemId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "commissioning_system",
        objectId: systemId,
        payload: {
          from: system.status,
          to: "accepted",
          acceptedBy: req.user!.id,
          cxAgentId: system.cxAgentId,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      return loadSystemOr404(app.db, req.companyId!, req.projectId!, systemId);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Test records                                                      */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/commissioning/test-records",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = testCreateSchema.parse(req.body);
      const system = await loadSystemOr404(app.db, req.companyId!, req.projectId!, body.systemId);
      if (body.vendorId) await assertVendor(app.db, req.companyId!, body.vendorId);
      if (body.locationId) await assertLocation(app.db, req.projectId!, body.locationId);
      if (body.assetId) await assertAsset(app.db, req.projectId!, body.assetId);

      if (functionalSet.has(body.testKind)) {
        const tests = await testsForSystem(system.id);
        const readiness = functionalReadiness(tests);
        if (!readiness.allowed) {
          throw badRequest(
            `A ${body.testKind.replace(/_/g, " ")} cannot be raised against ${system.systemCode} yet. ${readiness.blockers.join(" ")}`,
          );
        }
      }

      const { number, reference } = await allocateReference(
        app.db,
        req.projectId!,
        "commissioning_test",
        "CXT",
      );
      const id = newId("cxt");
      const [created] = await app.db
        .insert(commissioningTestRecords)
        .values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          number,
          reference,
          systemId: system.id,
          testKind: body.testKind,
          title: body.title,
          description: body.description ?? null,
          testProcedureRef: body.testProcedureRef ?? null,
          procedureFileId: body.procedureFileId ?? null,
          checklistId: body.checklistId ?? null,
          checklistTemplateId: body.checklistTemplateId ?? null,
          assetId: body.assetId ?? system.assetId,
          equipmentId: body.equipmentId ?? null,
          locationId: body.locationId ?? system.locationId,
          scheduledFor: body.scheduledFor ?? null,
          vendorId: body.vendorId ?? system.vendorId,
          contractorRepName: body.contractorRepName ?? null,
          ambientConditions: body.ambientConditions ?? {},
          instruments: body.instruments ?? [],
          detail: body.detail ?? {},
          createdBy: req.user!.id,
        })
        .returning();
      await refreshSystemCounters(system.id, req.projectId!);
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "commissioning_test_record",
        objectId: id,
        payload: created,
        storePayload: true,
      });
      return reply.status(201).send({ ...created, phase: testPhase(created!) });
    },
  );

  app.get(
    "/projects/:projectId/commissioning/test-records",
    { preHandler: readGate },
    async (req) => {
      await sweepQuality(app.db, req.companyId!, req.projectId!, req.user!.id);
      const q = testListQuery.parse(req.query);
      const clauses = [
        eq(commissioningTestRecords.companyId, req.companyId!),
        eq(commissioningTestRecords.projectId, req.projectId!),
      ];
      if (q.systemId) clauses.push(eq(commissioningTestRecords.systemId, q.systemId));
      if (q.testKind) clauses.push(eq(commissioningTestRecords.testKind, q.testKind));
      if (q.status) clauses.push(eq(commissioningTestRecords.status, q.status));
      if (q.result) clauses.push(eq(commissioningTestRecords.result, q.result));
      if (q.assetId) clauses.push(eq(commissioningTestRecords.assetId, q.assetId));
      if (q.search) clauses.push(ilike(commissioningTestRecords.title, `%${q.search}%`));
      if (q.phase === "prefunctional") {
        clauses.push(inArray(commissioningTestRecords.testKind, [...PREFUNCTIONAL_TEST_KINDS]));
      } else if (q.phase === "functional") {
        clauses.push(inArray(commissioningTestRecords.testKind, [...FUNCTIONAL_TEST_KINDS]));
      }
      const where = and(...clauses);
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(commissioningTestRecords)
        .where(where);
      const rows = await app.db
        .select()
        .from(commissioningTestRecords)
        .where(where)
        .orderBy(desc(commissioningTestRecords.number))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      const byId = new Map(rows.map((r) => [r.id, r] as const));
      return paginate(
        rows.map((r) => ({ ...r, phase: testPhase(r, byId) })),
        Number(totalRow?.n ?? 0),
        q,
      );
    },
  );

  app.get(
    "/projects/:projectId/commissioning/test-records/:recordId",
    { preHandler: readGate },
    async (req) => {
      const { recordId } = req.params as { recordId: string };
      const record = await fetchTest(recordId, req.companyId!, req.projectId!);
      const siblings = await testsForSystem(record.systemId);
      const byId = new Map(siblings.map((r) => [r.id, r] as const));
      const retests = siblings.filter((r) => r.retestOfId === recordId);
      return {
        ...record,
        phase: testPhase(record, byId),
        retests,
        retestOf: record.retestOfId ? (byId.get(record.retestOfId) ?? null) : null,
      };
    },
  );

  app.patch(
    "/projects/:projectId/commissioning/test-records/:recordId",
    { preHandler: standardGate },
    async (req) => {
      const { recordId } = req.params as { recordId: string };
      const body = testPatchSchema.parse(req.body);
      const record = await fetchTest(recordId, req.companyId!, req.projectId!);
      if (record.status === "accepted" || record.status === "void") {
        throw badRequest(
          `${record.reference} is ${record.status}; an accepted test record is evidence and is not edited.`,
        );
      }
      if (body.vendorId) await assertVendor(app.db, req.companyId!, body.vendorId);
      if (body.locationId) await assertLocation(app.db, req.projectId!, body.locationId);
      if (body.assetId) await assertAsset(app.db, req.projectId!, body.assetId);
      const set: Record<string, unknown> = { updatedAt: nowISO() };
      for (const key of TEST_PATCH_COLUMNS) {
        const value = (body as Record<string, unknown>)[key];
        if (value !== undefined) set[key] = value;
      }
      await app.db
        .update(commissioningTestRecords)
        .set(set)
        .where(eq(commissioningTestRecords.id, recordId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "commissioning_test_record",
        objectId: recordId,
        payload: { changed: Object.keys(body) },
      });
      return fetchTest(recordId, req.companyId!, req.projectId!);
    },
  );

  /**
   * Record the result, the readings and whatever went wrong.
   *
   * Two refusals worth calling out: a pass may not be recorded on an
   * out-of-calibration instrument, and a result of `pass` may not be recorded
   * alongside deficiencies (that state has a name — `pass_with_deficiencies`
   * — and it is the honest one most functional tests end in).
   */
  app.post(
    "/projects/:projectId/commissioning/test-records/:recordId/result",
    { preHandler: standardGate },
    async (req) => {
      const { recordId } = req.params as { recordId: string };
      const body = resultSchema.parse(req.body);
      const record = await fetchTest(recordId, req.companyId!, req.projectId!);
      /*
       * ONE RESULT PER RECORD.
       *
       * Only `accepted` used to be refused, so a record already `complete` or
       * `retest_required` could take a second result — and the deficiency loop
       * below creates a punch item or an NCR for every deficiency in the body
       * every time it runs. Two submissions of the same list produced duplicate
       * punch items in the field register and duplicate NCRs, both of which then
       * block turnover against work that has one defect, not two. A test that
       * has been performed is evidence of what happened on the day; correcting
       * it is a retest (POST .../retest), which is a new record that names this
       * one.
       */
      if (SETTLED_TEST_STATUSES.includes(record.status) || record.status === "retest_required") {
        throw badRequest(
          `${record.reference} already records a result (${record.result ?? record.status}) performed at ${record.performedAt ?? "an unrecorded time"}. ` +
            `A test record carries what happened on the day it was performed; recording a second result over it would raise the same deficiencies twice. ` +
            `Raise a retest instead: POST /projects/:projectId/commissioning/test-records/${record.id}/retest.`,
        );
      }
      const performedAt = body.performedAt ?? nowISO();
      const onDate = performedAt.slice(0, 10);
      const instruments = (body.instruments ??
        (record.instruments as z.infer<typeof instrumentSchema>[])) as z.infer<
        typeof instrumentSchema
      >[];
      const deficiencies = body.deficiencies ?? [];

      if (body.result === "pass" || body.result === "pass_with_deficiencies") {
        const blockers = calibrationBlockers(instruments, onDate);
        if (blockers.length > 0) {
          throw badRequest(
            `A pass cannot be recorded on ${record.reference} with an out-of-calibration instrument. ${blockers.join(" ")} Recalibrate and retest, or record the true result.`,
          );
        }
      }
      if (body.result === "pass" && deficiencies.length > 0) {
        throw badRequest(
          `${record.reference} records ${deficiencies.length} deficiency(ies), so the result is "pass_with_deficiencies", not "pass". The distinction is the whole basis on which turnover is made conditional.`,
        );
      }

      const judged = judgeReadings(body.readings ?? []);
      const failedReadings = judged.filter((r) => r.pass === false);
      if (body.result === "pass" && failedReadings.length > 0) {
        throw badRequest(
          `${record.reference} cannot record a pass: ${failedReadings.length} reading(s) are outside their acceptance window — ${failedReadings
            .map((r) => `${r.point} measured ${r.measured}${r.unit ? ` ${r.unit}` : ""} against [${r.lower ?? "-∞"}, ${r.upper ?? "+∞"}]`)
            .join("; ")}.`,
        );
      }

      const deficiencyRecordIds: string[] = [...record.deficiencyRecordIds];
      const raisedPunchItems: { punchItemId: string; number: number }[] = [];
      const raisedNcrs: { ncrId: string; reference: string }[] = [];
      let ncrId = record.ncrId;
      for (const deficiency of deficiencies) {
        if (deficiency.raiseAs === "ncr") {
          const ncr = await createNcr(app.db, {
            companyId: req.companyId!,
            projectId: req.projectId!,
            actorId: req.user!.id,
            title: `${record.reference} — ${deficiency.description}`.slice(0, 300),
            description: `Raised from commissioning test ${record.reference} (${record.testKind}) on system ${record.systemId}. ${deficiency.description}`,
            category: "testing",
            severity: deficiency.severity ?? "minor",
            sourceType: "test_record",
            sourceId: record.id,
            testRecordId: record.id,
            assetId: record.assetId,
            locationId: record.locationId,
            raisedAgainstVendorId: deficiency.ownerVendorId ?? record.vendorId,
            responseDueDate: deficiency.dueDate ?? null,
            detail: { systemId: record.systemId, raisedBy: "commissioning_test" },
          });
          ncrId = ncrId ?? ncr.id;
          raisedNcrs.push({ ncrId: ncr.id, reference: ncr.reference });
        } else {
          const punch = await createPunchItemFor(app.db, {
            companyId: req.companyId!,
            projectId: req.projectId!,
            actorId: req.user!.id,
            title: `${record.reference} — ${deficiency.description}`.slice(0, 300),
            description: `Deficiency recorded on commissioning test ${record.reference}.`,
            itemType: "commissioning",
            vendorId: deficiency.ownerVendorId ?? record.vendorId,
            locationId: record.locationId,
            dueDate: deficiency.dueDate ?? null,
          });
          deficiencyRecordIds.push(punch.id);
          raisedPunchItems.push({ punchItemId: punch.id, number: punch.number });
        }
      }

      const status =
        body.result === "fail" || body.result === "aborted" ? "retest_required" : "complete";
      await app.db
        .update(commissioningTestRecords)
        .set({
          status,
          result: body.result,
          performedAt,
          performedBy: req.user!.id,
          performedByName: body.performedByName ?? record.performedByName,
          readings: judged,
          instruments,
          ambientConditions: body.ambientConditions ?? record.ambientConditions,
          deficiencyCount: deficiencyRecordIds.length + raisedNcrs.length,
          deficiencyRecordIds,
          ncrId,
          reportFileId: body.reportFileId ?? record.reportFileId,
          certificateFileId: body.certificateFileId ?? record.certificateFileId,
          photoFileIds: body.photoFileIds ?? record.photoFileIds,
          updatedAt: nowISO(),
        })
        .where(eq(commissioningTestRecords.id, recordId));
      await refreshSystemCounters(record.systemId, req.projectId!);
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "commissioning_test_record",
        objectId: recordId,
        payload: {
          from: record.status,
          to: status,
          result: body.result,
          readings: judged,
          instruments,
          raisedPunchItems,
          raisedNcrs,
        },
        storePayload: true,
      });
      const updated = await fetchTest(recordId, req.companyId!, req.projectId!);
      return {
        ...updated,
        judgedReadings: judged,
        raised: { punchItems: raisedPunchItems, ncrs: raisedNcrs },
      };
    },
  );

  app.post(
    "/projects/:projectId/commissioning/test-records/:recordId/witness",
    { preHandler: standardGate },
    async (req) => {
      const { recordId } = req.params as { recordId: string };
      const body = witnessSchema.parse(req.body ?? {});
      const record = await fetchTest(recordId, req.companyId!, req.projectId!);
      /*
       * A witness watches a test being carried out. Recording one against a
       * scheduled record that nobody has performed says a second party watched
       * something that has not happened, and the segregation check passes
       * trivially because `performedBy` is still null.
       */
      if (!record.performedAt) {
        throw badRequest(
          `${record.reference} has not been performed (it is ${record.status}). A witness attests to a test that took place; record the result first, then the witness.`,
        );
      }
      if (!body.thirdPartyWitness) {
        assertDistinctActor(
          req.user!.id,
          record.performedBy,
          `Witnessing ${record.reference}`,
          "performed",
        );
      }
      const at = body.witnessedAt ?? nowISO();
      await app.db
        .update(commissioningTestRecords)
        .set({
          witnessedBy: body.thirdPartyWitness ? null : req.user!.id,
          witnessedByName: body.witnessedByName ?? null,
          witnessedByOrganisation: body.witnessedByOrganisation ?? null,
          thirdPartyWitness: body.thirdPartyWitness ?? null,
          witnessedAt: at,
          updatedAt: nowISO(),
        })
        .where(eq(commissioningTestRecords.id, recordId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "commissioning_test_record",
        objectId: recordId,
        payload: {
          witnessedBy: body.thirdPartyWitness ? null : req.user!.id,
          thirdPartyWitness: body.thirdPartyWitness ?? null,
          organisation: body.witnessedByOrganisation ?? null,
          witnessedAt: at,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      return fetchTest(recordId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/commissioning/test-records/:recordId/accept",
    { preHandler: standardGate },
    async (req) => {
      const { recordId } = req.params as { recordId: string };
      const body = acceptTestSchema.parse(req.body ?? {});
      const record = await fetchTest(recordId, req.companyId!, req.projectId!);
      if (record.status !== "complete") {
        throw badRequest(
          `${record.reference} is ${record.status}; a test is accepted once it is complete.`,
        );
      }
      assertDistinctActor(
        req.user!.id,
        record.performedBy,
        `Acceptance of ${record.reference}`,
        "performed",
      );
      const at = nowISO();
      await app.db
        .update(commissioningTestRecords)
        .set({
          status: "accepted",
          acceptedBy: req.user!.id,
          acceptedAt: at,
          certificateFileId: body.certificateFileId ?? record.certificateFileId,
          updatedAt: at,
        })
        .where(eq(commissioningTestRecords.id, recordId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "commissioning_test_record",
        objectId: recordId,
        payload: {
          from: "complete",
          to: "accepted",
          acceptedBy: req.user!.id,
          performedBy: record.performedBy,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      return fetchTest(recordId, req.companyId!, req.projectId!);
    },
  );

  /** A retest is a NEW record that names what it retests. */
  app.post(
    "/projects/:projectId/commissioning/test-records/:recordId/retest",
    { preHandler: standardGate },
    async (req, reply) => {
      const { recordId } = req.params as { recordId: string };
      const body = retestSchema.parse(req.body ?? {});
      const record = await fetchTest(recordId, req.companyId!, req.projectId!);
      if (record.result === null) {
        throw badRequest(
          `${record.reference} has no result yet — there is nothing to retest. Record the result first.`,
        );
      }
      const { number, reference } = await allocateReference(
        app.db,
        req.projectId!,
        "commissioning_test",
        "CXT",
      );
      const id = newId("cxt");
      const [created] = await app.db
        .insert(commissioningTestRecords)
        .values({
          id,
          companyId: record.companyId,
          projectId: record.projectId,
          number,
          reference,
          systemId: record.systemId,
          testKind: body.testKind ?? record.testKind,
          title: body.title ?? `Retest of ${record.reference} — ${record.title}`.slice(0, 300),
          description: record.description,
          testProcedureRef: record.testProcedureRef,
          procedureFileId: record.procedureFileId,
          checklistTemplateId: record.checklistTemplateId,
          assetId: record.assetId,
          equipmentId: record.equipmentId,
          locationId: record.locationId,
          scheduledFor: body.scheduledFor ?? null,
          vendorId: record.vendorId,
          instruments: record.instruments,
          retestOfId: record.id,
          detail: { retestReason: body.reason ?? null, retestOfReference: record.reference },
          createdBy: req.user!.id,
        })
        .returning();
      await app.db
        .update(commissioningTestRecords)
        .set({
          retestCount: record.retestCount + 1,
          status: record.status === "accepted" ? record.status : "retest_required",
          updatedAt: nowISO(),
        })
        .where(eq(commissioningTestRecords.id, recordId));
      await refreshSystemCounters(record.systemId, req.projectId!);
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "commissioning_test_record",
        objectId: id,
        payload: { ...created, retestOfId: record.id, reason: body.reason ?? null },
        storePayload: true,
      });
      const siblings = await testsForSystem(record.systemId);
      const byId = new Map(siblings.map((r) => [r.id, r] as const));
      return reply.status(201).send({ ...created, phase: testPhase(created!, byId) });
    },
  );
};
