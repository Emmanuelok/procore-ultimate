import type { FastifyInstance } from "fastify";
import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { affectedPersons, landParcels, projects } from "@constructos/db";
import { DISPLACEMENT_TYPES, PAP_STATUSES, PARCEL_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isoDateSchema, todayISO } from "../field/dates.js";
import {
  LIVELIHOOD_REQUIRED_DISPLACEMENT,
  PARCEL_READY_STATUS,
  PHYSICAL_DISPLACEMENT,
  VULNERABILITY_FLAGS,
} from "./reference.js";
import { percentOf, round2, tallyBy, validateEvidence, zeroFilled } from "./shared.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const entitlementSchema = z.object({
  item: z.string().min(1).max(300),
  basis: z.string().min(1).max(2000),
  amount: z.number().nonnegative(),
  delivered: z.boolean().optional(),
});

const papCreateSchema = z.object({
  reference: z.string().min(1).max(200),
  householdHead: z.string().min(1).max(300),
  householdSize: z.number().int().positive().max(200).nullable().optional(),
  parcelId: z.string().min(1).nullable().optional(),
  displacementType: z.enum(DISPLACEMENT_TYPES),
  vulnerabilities: z.array(z.enum(VULNERABILITY_FLAGS)).max(20).optional(),
  baseline: z.record(z.string(), z.unknown()).optional(),
  censusDate: isoDateSchema.nullable().optional(),
  livelihoodProgramme: z.string().max(2000).nullable().optional(),
});

const papPatchSchema = papCreateSchema.partial().extend({
  livelihoodRestoredAt: isoDateSchema.nullable().optional(),
});

const papListQuery = pageQuerySchema.extend({
  status: z.enum(PAP_STATUSES).optional(),
  displacementType: z.enum(DISPLACEMENT_TYPES).optional(),
  vulnerable: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  parcelId: z.string().min(1).optional(),
});

const entitlementsSchema = z.object({
  entitlements: z.array(entitlementSchema).max(200),
});

const papCompensateSchema = z.object({
  paidAt: isoDateSchema,
  evidenceIds: z.array(z.string().min(1)).min(1).max(100),
  note: z.string().max(10000).nullable().optional(),
});

const papStatusSchema = z.object({
  status: z.enum(PAP_STATUSES),
  note: z.string().max(10000).nullable().optional(),
});

const cutOffSchema = z.object({
  date: isoDateSchema,
  note: z.string().max(10000).nullable().optional(),
});

interface Entitlement {
  item: string;
  basis: string;
  amount: number;
  delivered: boolean;
}

/**
 * Project Affected Person census, entitlement matrix, cut-off enforcement and
 * RAP progress — spec Domain J #555-568.
 */
export async function registerPapRoutes(app: FastifyInstance): Promise<void> {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("land", "read")];
  const standardGate = [app.authenticate, app.requireCompany, app.requireTool("land", "standard")];
  const adminGate = [app.authenticate, app.requireCompany, app.requireTool("land", "admin")];

  async function fetchPap(papId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(affectedPersons)
      .where(
        and(
          eq(affectedPersons.id, papId),
          eq(affectedPersons.companyId, companyId),
          eq(affectedPersons.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Affected person not found");
    return rows[0];
  }

  async function fetchProject(companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Project not found");
    return rows[0];
  }

  /** The declared cut-off date, or null when the project has not declared one. */
  async function cutOffDate(companyId: string, projectId: string): Promise<string | null> {
    const project = await fetchProject(companyId, projectId);
    const value = (project.settings as Record<string, unknown>)["landCutOffDate"];
    return typeof value === "string" ? value : null;
  }

  /**
   * Cut-off enforcement (#564). A household censused AFTER the declared
   * cut-off date is, by definition, an encroacher rather than a Project
   * Affected Person: admitting it into the register would inflate the
   * entitlement population and is the classic vector for compensation fraud
   * on a resettlement programme. The declaration itself is an admin act.
   */
  async function assertCensusWithinCutOff(
    companyId: string,
    projectId: string,
    censusDate: string | null | undefined,
  ): Promise<void> {
    if (!censusDate) return;
    const cutOff = await cutOffDate(companyId, projectId);
    if (!cutOff) return;
    if (censusDate > cutOff) {
      throw badRequest(
        `Census date ${censusDate} falls after the declared cut-off date ${cutOff}; ` +
          `households recorded after the cut-off are encroachment, not project-affected persons`,
      );
    }
  }

  async function assertReferenceFree(
    companyId: string,
    projectId: string,
    reference: string,
    exceptId?: string,
  ): Promise<void> {
    const clauses = [
      eq(affectedPersons.companyId, companyId),
      eq(affectedPersons.projectId, projectId),
      eq(affectedPersons.reference, reference),
    ];
    if (exceptId) clauses.push(ne(affectedPersons.id, exceptId));
    const rows = await app.db
      .select({ id: affectedPersons.id })
      .from(affectedPersons)
      .where(and(...clauses))
      .limit(1);
    if (rows[0]) {
      throw conflict(`A PAP with reference "${reference}" already exists on this project`);
    }
  }

  async function assertParcelInProject(
    companyId: string,
    projectId: string,
    parcelId: string,
  ): Promise<void> {
    const rows = await app.db
      .select({ id: landParcels.id })
      .from(landParcels)
      .where(
        and(
          eq(landParcels.id, parcelId),
          eq(landParcels.companyId, companyId),
          eq(landParcels.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw badRequest("parcelId does not belong to this project");
  }

  function normaliseEntitlements(input: z.infer<typeof entitlementsSchema>): Entitlement[] {
    return input.entitlements.map((e) => ({
      item: e.item,
      basis: e.basis,
      amount: round2(e.amount),
      delivered: e.delivered ?? false,
    }));
  }

  /* ---------------------------------------------------------------- */
  /* Cut-off declaration (#564)                                        */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/land/cut-off", { preHandler: readGate }, async (req) => {
    const project = await fetchProject(req.companyId!, req.projectId!);
    const settings = project.settings as Record<string, unknown>;
    const date = settings["landCutOffDate"];
    const after = date
      ? await app.db
          .select({ n: count() })
          .from(affectedPersons)
          .where(
            and(
              eq(affectedPersons.companyId, req.companyId!),
              eq(affectedPersons.projectId, req.projectId!),
              sql`${affectedPersons.censusDate} > ${date as string}`,
            ),
          )
      : [];
    return {
      cutOffDate: typeof date === "string" ? date : null,
      declaredAt: typeof settings["landCutOffDeclaredAt"] === "string" ? settings["landCutOffDeclaredAt"] : null,
      declaredBy: typeof settings["landCutOffDeclaredBy"] === "string" ? settings["landCutOffDeclaredBy"] : null,
      /** households already on the register with a post-cut-off census date */
      papsAfterCutOff: Number(after[0]?.n ?? 0),
    };
  });

  app.post("/projects/:projectId/land/cut-off", { preHandler: adminGate }, async (req) => {
    const body = cutOffSchema.parse(req.body);
    const project = await fetchProject(req.companyId!, req.projectId!);
    const settings = { ...(project.settings as Record<string, unknown>) };
    const previous = typeof settings["landCutOffDate"] === "string" ? settings["landCutOffDate"] : null;
    const now = new Date().toISOString();
    settings["landCutOffDate"] = body.date;
    settings["landCutOffDeclaredAt"] = now;
    settings["landCutOffDeclaredBy"] = req.user!.id;
    await app.db
      .update(projects)
      .set({ settings, updatedAt: now })
      .where(eq(projects.id, req.projectId!));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "land_cut_off",
      objectId: req.projectId!,
      payload: { from: previous, to: body.date, declaredAt: now, note: body.note ?? null },
      storePayload: true,
    });
    return { cutOffDate: body.date, previousCutOffDate: previous, declaredAt: now, declaredBy: req.user!.id };
  });

  /* ---------------------------------------------------------------- */
  /* PAP census (#555-557, #565)                                       */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/affected-persons",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = papCreateSchema.parse(req.body);
      await assertReferenceFree(req.companyId!, req.projectId!, body.reference);
      await assertCensusWithinCutOff(req.companyId!, req.projectId!, body.censusDate);
      if (body.parcelId) {
        await assertParcelInProject(req.companyId!, req.projectId!, body.parcelId);
      }
      const id = newId("pap");
      await app.db.insert(affectedPersons).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        reference: body.reference,
        householdHead: body.householdHead,
        householdSize: body.householdSize ?? null,
        parcelId: body.parcelId ?? null,
        displacementType: body.displacementType,
        vulnerabilities: body.vulnerabilities ?? [],
        baseline: body.baseline ?? {},
        entitlements: [],
        censusDate: body.censusDate ?? null,
        livelihoodProgramme: body.livelihoodProgramme ?? null,
        status: "registered",
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "affected_person",
        objectId: id,
        payload: {
          reference: body.reference,
          householdHead: body.householdHead,
          householdSize: body.householdSize ?? null,
          parcelId: body.parcelId ?? null,
          displacementType: body.displacementType,
          vulnerabilities: body.vulnerabilities ?? [],
          censusDate: body.censusDate ?? null,
        },
        storePayload: true,
      });
      const created = await fetchPap(id, req.companyId!, req.projectId!);
      return reply.status(201).send(created);
    },
  );

  app.get("/projects/:projectId/affected-persons", { preHandler: readGate }, async (req) => {
    const q = papListQuery.parse(req.query);
    const clauses = [
      eq(affectedPersons.companyId, req.companyId!),
      eq(affectedPersons.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(affectedPersons.status, q.status));
    if (q.displacementType) clauses.push(eq(affectedPersons.displacementType, q.displacementType));
    if (q.parcelId) clauses.push(eq(affectedPersons.parcelId, q.parcelId));
    if (q.vulnerable === true) {
      clauses.push(sql`jsonb_array_length(${affectedPersons.vulnerabilities}) > 0`);
    } else if (q.vulnerable === false) {
      clauses.push(sql`jsonb_array_length(${affectedPersons.vulnerabilities}) = 0`);
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(affectedPersons).where(where);
    const rows = await app.db
      .select()
      .from(affectedPersons)
      .where(where)
      .orderBy(asc(affectedPersons.reference))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const items = rows.map((r) => ({
      ...r,
      vulnerable: r.vulnerabilities.length > 0,
      entitlementCount: (r.entitlements as unknown[]).length,
      livelihoodRequired: LIVELIHOOD_REQUIRED_DISPLACEMENT.includes(r.displacementType),
    }));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get(
    "/projects/:projectId/affected-persons/:papId",
    { preHandler: readGate },
    async (req) => {
      const { papId } = req.params as { papId: string };
      const pap = await fetchPap(papId, req.companyId!, req.projectId!);
      const parcel = pap.parcelId
        ? (
            await app.db
              .select()
              .from(landParcels)
              .where(eq(landParcels.id, pap.parcelId))
              .limit(1)
          )[0]
        : null;
      return {
        ...pap,
        vulnerable: pap.vulnerabilities.length > 0,
        livelihoodRequired: LIVELIHOOD_REQUIRED_DISPLACEMENT.includes(pap.displacementType),
        parcel: parcel ?? null,
      };
    },
  );

  app.patch(
    "/projects/:projectId/affected-persons/:papId",
    { preHandler: standardGate },
    async (req) => {
      const { papId } = req.params as { papId: string };
      const body = papPatchSchema.parse(req.body);
      const pap = await fetchPap(papId, req.companyId!, req.projectId!);
      if (body.reference !== undefined && body.reference !== pap.reference) {
        await assertReferenceFree(req.companyId!, req.projectId!, body.reference, papId);
      }
      if (body.censusDate !== undefined) {
        await assertCensusWithinCutOff(req.companyId!, req.projectId!, body.censusDate);
      }
      if (body.parcelId) {
        await assertParcelInProject(req.companyId!, req.projectId!, body.parcelId);
      }
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const key of [
        "reference",
        "householdHead",
        "householdSize",
        "parcelId",
        "displacementType",
        "vulnerabilities",
        "baseline",
        "censusDate",
        "livelihoodProgramme",
        "livelihoodRestoredAt",
      ] as const) {
        if (body[key] !== undefined) set[key] = body[key];
      }
      await app.db.update(affectedPersons).set(set).where(eq(affectedPersons.id, papId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "affected_person",
        objectId: papId,
        payload: { changed: Object.keys(body) },
      });
      return fetchPap(papId, req.companyId!, req.projectId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Entitlement matrix (#566-567)                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Apply the entitlement matrix to one household (#566). The stored
   * `compensationTotal` is never client-supplied — it is recomputed from the
   * line items every time, so the register total and the sum of what was
   * actually promised can never drift apart.
   */
  app.put(
    "/projects/:projectId/affected-persons/:papId/entitlements",
    { preHandler: standardGate },
    async (req) => {
      const { papId } = req.params as { papId: string };
      const body = entitlementsSchema.parse(req.body);
      const pap = await fetchPap(papId, req.companyId!, req.projectId!);
      if (pap.compensationPaidAt) {
        throw badRequest(
          "Entitlements cannot be revised after compensation has been paid; " +
            "record a supplementary grievance or a new entitlement determination instead",
        );
      }
      const entitlements = normaliseEntitlements(body);
      const compensationTotal = round2(entitlements.reduce((s, e) => s + e.amount, 0));
      await app.db
        .update(affectedPersons)
        .set({
          entitlements,
          compensationTotal,
          // determining entitlements moves a censused household forward
          status: pap.status === "registered" || pap.status === "surveyed"
            ? "entitlement_agreed"
            : pap.status,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(affectedPersons.id, papId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "affected_person",
        objectId: papId,
        payload: {
          event: "entitlements_applied",
          reference: pap.reference,
          entitlements,
          compensationTotal,
          previousTotal: pap.compensationTotal,
        },
        storePayload: true,
      });
      return fetchPap(papId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/affected-persons/:papId/compensate",
    { preHandler: standardGate },
    async (req) => {
      const { papId } = req.params as { papId: string };
      const body = papCompensateSchema.parse(req.body);
      const pap = await fetchPap(papId, req.companyId!, req.projectId!);
      if (pap.compensationTotal == null) {
        throw badRequest(
          "Entitlements must be determined before compensation can be recorded for this household",
        );
      }
      if (pap.compensationPaidAt) {
        throw badRequest(`Compensation was already recorded as paid on ${pap.compensationPaidAt}`);
      }
      await validateEvidence(app.db, req.companyId!, req.projectId!, body.evidenceIds);
      await app.db
        .update(affectedPersons)
        .set({
          compensationPaidAt: body.paidAt,
          status: "compensated",
          updatedAt: new Date().toISOString(),
        })
        .where(eq(affectedPersons.id, papId));
      // The household register carries no evidence column, so the payment's
      // evidentiary trail is the stored ledger payload.
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "affected_person",
        objectId: papId,
        payload: {
          from: pap.status,
          to: "compensated",
          reference: pap.reference,
          householdHead: pap.householdHead,
          amount: pap.compensationTotal,
          paidAt: body.paidAt,
          evidenceIds: body.evidenceIds,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      return fetchPap(papId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/affected-persons/:papId/status",
    { preHandler: standardGate },
    async (req) => {
      const { papId } = req.params as { papId: string };
      const body = papStatusSchema.parse(req.body);
      const pap = await fetchPap(papId, req.companyId!, req.projectId!);
      if (body.status === pap.status) throw badRequest(`Household is already ${pap.status}`);
      if (body.status === "compensated") {
        throw badRequest(
          "A household is marked compensated only through the evidenced compensation route " +
            "(POST /affected-persons/:papId/compensate)",
        );
      }
      const set: Record<string, unknown> = {
        status: body.status,
        updatedAt: new Date().toISOString(),
      };
      // Livelihood restoration is dated when it is declared (#561).
      if (body.status === "livelihood_restored" && !pap.livelihoodRestoredAt) {
        set["livelihoodRestoredAt"] = todayISO();
      }
      await app.db.update(affectedPersons).set(set).where(eq(affectedPersons.id, papId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "affected_person",
        objectId: papId,
        payload: {
          from: pap.status,
          to: body.status,
          reference: pap.reference,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      return fetchPap(papId, req.companyId!, req.projectId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* RAP progress (#558, #568)                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Resettlement Action Plan monitoring dashboard — the numbers an
   * independent RAP monitor (#568) and an IFC PS5 / ESS5 supervision mission
   * (#559-560) ask for, computed from the register rather than typed into a
   * spreadsheet.
   */
  app.get("/projects/:projectId/land/rap-progress", { preHandler: readGate }, async (req) => {
    const parcels = await app.db
      .select()
      .from(landParcels)
      .where(
        and(
          eq(landParcels.companyId, req.companyId!),
          eq(landParcels.projectId, req.projectId!),
        ),
      );
    const paps = await app.db
      .select()
      .from(affectedPersons)
      .where(
        and(
          eq(affectedPersons.companyId, req.companyId!),
          eq(affectedPersons.projectId, req.projectId!),
        ),
      );

    const parcelsByStatus = zeroFilled(PARCEL_STATUSES, tallyBy(parcels, (p) => p.status));
    const papsByStatus = zeroFilled(PAP_STATUSES, tallyBy(paps, (p) => p.status));

    const physicallyDisplaced = paps.filter((p) =>
      PHYSICAL_DISPLACEMENT.includes(p.displacementType),
    ).length;
    const economicallyDisplaced = paps.filter((p) =>
      LIVELIHOOD_REQUIRED_DISPLACEMENT.includes(p.displacementType),
    ).length;
    const vulnerableHouseholds = paps.filter((p) => p.vulnerabilities.length > 0).length;

    const parcelCommitted = round2(
      parcels.reduce((s, p) => s + (p.compensationAmount ?? p.valuationAmount ?? 0), 0),
    );
    const parcelPaid = round2(
      parcels
        .filter((p) => p.compensationPaidAt)
        .reduce((s, p) => s + (p.compensationAmount ?? 0), 0),
    );
    const papCommitted = round2(paps.reduce((s, p) => s + (p.compensationTotal ?? 0), 0));
    const papPaid = round2(
      paps.filter((p) => p.compensationPaidAt).reduce((s, p) => s + (p.compensationTotal ?? 0), 0),
    );
    const compensationCommitted = round2(parcelCommitted + papCommitted);
    const compensationPaid = round2(parcelPaid + papPaid);

    const livelihoodRequired = economicallyDisplaced;
    const livelihoodRestored = paps.filter(
      (p) =>
        LIVELIHOOD_REQUIRED_DISPLACEMENT.includes(p.displacementType) &&
        (p.livelihoodRestoredAt != null || p.status === "livelihood_restored"),
    ).length;

    const readyParcels = parcels.filter((p) => p.status === PARCEL_READY_STATUS).length;

    // vulnerability breakdown for the enhanced-entitlement population (#557)
    const byVulnerability: Record<string, number> = Object.fromEntries(
      VULNERABILITY_FLAGS.map((f) => [f, 0]),
    );
    for (const pap of paps) {
      for (const flag of pap.vulnerabilities) {
        byVulnerability[flag] = (byVulnerability[flag] ?? 0) + 1;
      }
    }

    return {
      parcels: {
        total: parcels.length,
        byStatus: parcelsByStatus,
        areaSqm: round2(parcels.reduce((s, p) => s + (p.areaSqm ?? 0), 0)),
        acquired: readyParcels,
      },
      paps: {
        total: paps.length,
        byStatus: papsByStatus,
        households: paps.reduce((s, p) => s + (p.householdSize ?? 0), 0),
      },
      physicallyDisplaced,
      economicallyDisplaced,
      vulnerableHouseholds,
      byVulnerability,
      compensationCommitted,
      compensationPaid,
      compensationOutstanding: round2(compensationCommitted - compensationPaid),
      compensation: {
        parcels: { committed: parcelCommitted, paid: parcelPaid },
        paps: { committed: papCommitted, paid: papPaid },
      },
      livelihoodRequired,
      livelihoodRestored,
      /** null when no household requires livelihood restoration */
      livelihoodRestoredPercent: percentOf(livelihoodRestored, livelihoodRequired),
      /** null when the project holds no land parcels at all */
      readyForConstructionPercent: percentOf(readyParcels, parcels.length),
      cutOffDate: await cutOffDate(req.companyId!, req.projectId!),
    };
  });
}
