/**
 * The rework register (#1098) — what it cost to do it twice, and why.
 *
 * "Rework" as a single number in a monthly report is a rounding error nobody
 * acts on. Rework split by CAUSE is a management decision: late information is
 * a client problem, workmanship is a subcontract problem, and design error is
 * a professional-indemnity problem, and the three have different remedies and
 * different people to talk to. `discoveryPhase` carries the other half — the
 * same defect caught at inspection and caught after handover is the same
 * mistake at ten times the price, and the cost-of-quality model depends on the
 * distinction.
 *
 * Costs are itemised (labour, material, plant, subcontractor) so the total can
 * be defended line by line, and `costBasis` says whether the figure is an
 * estimate, a quote or an actual — a number whose provenance is unstated is
 * one nobody will stand behind in a backcharge argument.
 */

import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray } from "drizzle-orm";
import { z } from "zod";
import { nonConformanceReports, reworkItems } from "@constructos/db";
import {
  REWORK_CAUSES,
  REWORK_COST_BASES,
  REWORK_DISCOVERY_PHASES,
  REWORK_STATUSES,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
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
  patchSet,
  round2,
  todayISO,
  totalsByCurrency,
} from "./shared.js";

const costFields = {
  labourHours: z.number().finite().nonnegative().nullable().optional(),
  labourCost: z.number().finite().nullable().optional(),
  materialCost: z.number().finite().nullable().optional(),
  plantCost: z.number().finite().nullable().optional(),
  subcontractorCost: z.number().finite().nullable().optional(),
  otherCost: z.number().finite().nullable().optional(),
  currency: z.string().length(3).optional(),
  costBasis: z.enum(REWORK_COST_BASES).optional(),
};

const createSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(20_000).nullable().optional(),
  causeCategory: z.enum(REWORK_CAUSES).optional(),
  causeDescription: z.string().max(10_000).nullable().optional(),
  discoveryPhase: z.enum(REWORK_DISCOVERY_PHASES).optional(),
  discoveredAt: isoDateSchema.nullable().optional(),
  sourceType: z
    .enum(["ncr", "punch_item", "checklist", "test_record", "audit", "self_identified", "dlp_defect"])
    .optional(),
  sourceId: idSchema.nullable().optional(),
  ncrId: idSchema.nullable().optional(),
  punchItemId: idSchema.nullable().optional(),
  checklistId: idSchema.nullable().optional(),
  testRecordId: idSchema.nullable().optional(),
  auditFindingId: idSchema.nullable().optional(),
  responsibleVendorId: idSchema.nullable().optional(),
  responsibleParty: z.string().max(200).nullable().optional(),
  trade: z.string().max(200).nullable().optional(),
  locationId: idSchema.nullable().optional(),
  locationText: z.string().max(500).nullable().optional(),
  systemId: idSchema.nullable().optional(),
  quantityAffected: z.number().finite().nullable().optional(),
  unit: z.string().max(50).nullable().optional(),
  scheduleImpactDays: z.number().finite().nullable().optional(),
  preventable: z.boolean().optional(),
  isBackcharged: z.boolean().optional(),
  changeEventId: idSchema.nullable().optional(),
  photoFileIds: fileIdsSchema.optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
  ...costFields,
});

const PATCH_COLUMNS = [
  "title",
  "description",
  "causeCategory",
  "causeDescription",
  "discoveryPhase",
  "discoveredAt",
  "sourceType",
  "sourceId",
  "ncrId",
  "punchItemId",
  "checklistId",
  "testRecordId",
  "auditFindingId",
  "responsibleVendorId",
  "responsibleParty",
  "trade",
  "locationId",
  "locationText",
  "systemId",
  "quantityAffected",
  "unit",
  "scheduleImpactDays",
  "preventable",
  "isBackcharged",
  "changeEventId",
  "photoFileIds",
  "labourHours",
  "labourCost",
  "materialCost",
  "plantCost",
  "subcontractorCost",
  "otherCost",
  "currency",
  "costBasis",
  "detail",
] as const;

const listQuery = pageQuerySchema.extend({
  status: z.enum(REWORK_STATUSES).optional(),
  causeCategory: z.enum(REWORK_CAUSES).optional(),
  discoveryPhase: z.enum(REWORK_DISCOVERY_PHASES).optional(),
  responsibleVendorId: idSchema.optional(),
  trade: z.string().max(200).optional(),
  openOnly: z.coerce.boolean().optional(),
  search: z.string().max(200).optional(),
});

const OPEN_STATUSES = ["identified", "approved", "in_progress"];

/** The total is only ever the sum of the parts that were given. */
function totalCost(row: {
  labourCost: number | null;
  materialCost: number | null;
  plantCost: number | null;
  subcontractorCost: number | null;
  otherCost: number | null;
}): number | null {
  const parts = [
    row.labourCost,
    row.materialCost,
    row.plantCost,
    row.subcontractorCost,
    row.otherCost,
  ].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (parts.length === 0) return null;
  return round2(parts.reduce((a, b) => a + b, 0));
}

export const reworkRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);

  async function fetchOr404(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(reworkItems)
      .where(
        and(
          eq(reworkItems.id, id),
          eq(reworkItems.companyId, companyId),
          eq(reworkItems.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Rework item not found");
    return rows[0];
  }

  app.post("/projects/:projectId/rework-items", { preHandler: standardGate }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    if (body.responsibleVendorId) {
      await assertVendor(app.db, req.companyId!, body.responsibleVendorId);
    }
    if (body.locationId) await assertLocation(app.db, req.projectId!, body.locationId);
    if (body.ncrId) {
      const ncr = await app.db
        .select({ id: nonConformanceReports.id })
        .from(nonConformanceReports)
        .where(
          and(
            eq(nonConformanceReports.id, body.ncrId),
            eq(nonConformanceReports.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!ncr[0]) throw badRequest(`NCR ${body.ncrId} not found in this project.`);
    }
    const { number, reference } = await allocateReference(app.db, req.projectId!, "rework", "RWK");
    const id = newId("rwk");
    const computed = totalCost({
      labourCost: body.labourCost ?? null,
      materialCost: body.materialCost ?? null,
      plantCost: body.plantCost ?? null,
      subcontractorCost: body.subcontractorCost ?? null,
      otherCost: body.otherCost ?? null,
    });
    const [created] = await app.db
      .insert(reworkItems)
      .values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        reference,
        title: body.title,
        description: body.description ?? null,
        sourceType: body.sourceType ?? (body.ncrId ? "ncr" : "self_identified"),
        sourceId: body.sourceId ?? body.ncrId ?? null,
        ncrId: body.ncrId ?? null,
        punchItemId: body.punchItemId ?? null,
        checklistId: body.checklistId ?? null,
        testRecordId: body.testRecordId ?? null,
        auditFindingId: body.auditFindingId ?? null,
        causeCategory: body.causeCategory ?? "workmanship",
        causeDescription: body.causeDescription ?? null,
        discoveryPhase: body.discoveryPhase ?? "during_works",
        discoveredAt: body.discoveredAt ?? todayISO(),
        responsibleVendorId: body.responsibleVendorId ?? null,
        responsibleParty: body.responsibleParty ?? null,
        trade: body.trade ?? null,
        locationId: body.locationId ?? null,
        locationText: body.locationText ?? null,
        systemId: body.systemId ?? null,
        labourHours: body.labourHours ?? null,
        labourCost: body.labourCost ?? null,
        materialCost: body.materialCost ?? null,
        plantCost: body.plantCost ?? null,
        subcontractorCost: body.subcontractorCost ?? null,
        otherCost: body.otherCost ?? null,
        totalCost: computed,
        currency: body.currency ?? "USD",
        costBasis: body.costBasis ?? "estimated",
        scheduleImpactDays: body.scheduleImpactDays ?? null,
        quantityAffected: body.quantityAffected ?? null,
        unit: body.unit ?? null,
        isBackcharged: body.isBackcharged ? 1 : 0,
        changeEventId: body.changeEventId ?? null,
        preventable: body.preventable === false ? 0 : 1,
        photoFileIds: body.photoFileIds ?? [],
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "rework_item",
      objectId: id,
      payload: created,
      storePayload: true,
    });
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/rework-items", { preHandler: readGate }, async (req) => {
    const q = listQuery.parse(req.query);
    const clauses = [
      eq(reworkItems.companyId, req.companyId!),
      eq(reworkItems.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(reworkItems.status, q.status));
    else if (q.openOnly) clauses.push(inArray(reworkItems.status, OPEN_STATUSES));
    if (q.causeCategory) clauses.push(eq(reworkItems.causeCategory, q.causeCategory));
    if (q.discoveryPhase) clauses.push(eq(reworkItems.discoveryPhase, q.discoveryPhase));
    if (q.responsibleVendorId) clauses.push(eq(reworkItems.responsibleVendorId, q.responsibleVendorId));
    if (q.trade) clauses.push(eq(reworkItems.trade, q.trade));
    if (q.search) clauses.push(ilike(reworkItems.title, `%${q.search}%`));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(reworkItems).where(where);
    const rows = await app.db
      .select()
      .from(reworkItems)
      .where(where)
      .orderBy(desc(reworkItems.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/rework-items/:id", { preHandler: readGate }, async (req) => {
    const { id } = req.params as { id: string };
    return fetchOr404(id, req.companyId!, req.projectId!);
  });

  app.patch("/projects/:projectId/rework-items/:id", { preHandler: standardGate }, async (req) => {
    const { id } = req.params as { id: string };
    const body = createSchema.partial().parse(req.body);
    const row = await fetchOr404(id, req.companyId!, req.projectId!);
    if (row.status === "verified") {
      throw badRequest(
        `${row.reference} has been verified; the cost and cause somebody signed off are not edited afterwards.`,
      );
    }
    if (body.responsibleVendorId) {
      await assertVendor(app.db, req.companyId!, body.responsibleVendorId);
    }
    if (body.locationId) await assertLocation(app.db, req.projectId!, body.locationId);
    const set = patchSet(body as Record<string, unknown>, PATCH_COLUMNS);
    if (body.preventable !== undefined) set["preventable"] = body.preventable ? 1 : 0;
    if (body.isBackcharged !== undefined) set["isBackcharged"] = body.isBackcharged ? 1 : 0;
    const merged = {
      labourCost: body.labourCost !== undefined ? (body.labourCost ?? null) : row.labourCost,
      materialCost: body.materialCost !== undefined ? (body.materialCost ?? null) : row.materialCost,
      plantCost: body.plantCost !== undefined ? (body.plantCost ?? null) : row.plantCost,
      subcontractorCost:
        body.subcontractorCost !== undefined ? (body.subcontractorCost ?? null) : row.subcontractorCost,
      otherCost: body.otherCost !== undefined ? (body.otherCost ?? null) : row.otherCost,
    };
    set["totalCost"] = totalCost(merged);
    await app.db.update(reworkItems).set(set).where(eq(reworkItems.id, id));
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "rework_item",
      objectId: id,
      payload: { changed: Object.keys(body), totalCost: set["totalCost"] },
    });
    return fetchOr404(id, req.companyId!, req.projectId!);
  });

  app.post(
    "/projects/:projectId/rework-items/:id/status",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({
          status: z.enum(["approved", "in_progress", "complete", "cancelled"]),
          note: z.string().max(4000).nullable().optional(),
        })
        .parse(req.body);
      const row = await fetchOr404(id, req.companyId!, req.projectId!);
      if (row.status === "verified") {
        throw badRequest(`${row.reference} is verified; reopen it by raising a new rework item.`);
      }
      if (body.status === "cancelled" && !body.note) {
        throw badRequest(
          "Cancelling a rework item removes a cost from the project's failure record; it must say why.",
        );
      }
      const at = nowISO();
      await app.db
        .update(reworkItems)
        .set({
          status: body.status,
          startedAt: body.status === "in_progress" ? (row.startedAt ?? todayISO()) : row.startedAt,
          completedAt: body.status === "complete" ? todayISO() : row.completedAt,
          detail: { ...(row.detail as Record<string, unknown>), lastStatusNote: body.note ?? null },
          updatedAt: at,
        })
        .where(eq(reworkItems.id, id));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "rework_item",
        objectId: id,
        payload: { from: row.status, to: body.status, note: body.note ?? null },
        storePayload: true,
      });
      return fetchOr404(id, req.companyId!, req.projectId!);
    },
  );

  /** Verification of the fix, by somebody other than whoever recorded it. */
  app.post(
    "/projects/:projectId/rework-items/:id/verify",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({
          verificationChecklistId: idSchema.nullable().optional(),
          note: z.string().max(4000).nullable().optional(),
        })
        .parse(req.body ?? {});
      const row = await fetchOr404(id, req.companyId!, req.projectId!);
      if (row.status !== "complete") {
        throw badRequest(
          `${row.reference} is ${row.status}; rework is verified once it has been completed.`,
        );
      }
      assertDistinctActor(
        req.user!.id,
        row.createdBy,
        `Verification of rework ${row.reference}`,
        "recorded",
      );
      const at = nowISO();
      await app.db
        .update(reworkItems)
        .set({
          status: "verified",
          verifiedBy: req.user!.id,
          verifiedAt: at,
          verificationChecklistId: body.verificationChecklistId ?? row.verificationChecklistId,
          detail: { ...(row.detail as Record<string, unknown>), verificationNote: body.note ?? null },
          updatedAt: at,
        })
        .where(eq(reworkItems.id, id));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "rework_item",
        objectId: id,
        payload: {
          from: "complete",
          to: "verified",
          verifiedBy: req.user!.id,
          recordedBy: row.createdBy,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      return fetchOr404(id, req.companyId!, req.projectId!);
    },
  );

  /** The register's own analysis: cost by cause, by trade and by phase. */
  app.get("/projects/:projectId/rework-summary", { preHandler: readGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(reworkItems)
      .where(
        and(eq(reworkItems.companyId, req.companyId!), eq(reworkItems.projectId, req.projectId!)),
      )
      .orderBy(asc(reworkItems.number));
    const live = rows.filter((r) => r.status !== "cancelled");
    const group = (key: (row: (typeof rows)[number]) => string) => {
      const map = new Map<string, typeof rows>();
      for (const row of live) {
        const k = key(row);
        const list = map.get(k) ?? [];
        list.push(row);
        map.set(k, list);
      }
      return [...map.entries()]
        .map(([k, list]) => {
          const money = totalsByCurrency(
            list.map((r) => ({ amount: r.totalCost, currency: r.currency })),
          );
          return {
            key: k,
            items: list.length,
            costedItems: money.withAmount,
            uncostedItems: money.withoutAmount,
            totals: money.totals,
            labourHours: list.reduce((n, r) => n + (r.labourHours ?? 0), 0),
            reasons:
              money.withAmount === 0
                ? [
                    `${list.length} item(s) and none carries a cost, so the money here is unmeasured — not zero.`,
                  ]
                : money.withoutAmount > 0
                  ? [
                      `${money.withoutAmount} of ${list.length} item(s) carry no cost and are excluded; the total is a floor.`,
                    ]
                  : [],
          };
        })
        .sort((a, b) => b.items - a.items);
    };
    const overall = totalsByCurrency(
      live.map((r) => ({ amount: r.totalCost, currency: r.currency })),
    );
    return {
      total: rows.length,
      open: rows.filter((r) => OPEN_STATUSES.includes(r.status)).length,
      verified: rows.filter((r) => r.status === "verified").length,
      cancelled: rows.filter((r) => r.status === "cancelled").length,
      preventable: live.filter((r) => r.preventable === 1).length,
      backcharged: live.filter((r) => r.isBackcharged === 1).length,
      totals: overall.totals,
      costedItems: overall.withAmount,
      uncostedItems: overall.withoutAmount,
      byCause: group((r) => r.causeCategory),
      byPhase: group((r) => r.discoveryPhase),
      byTrade: group((r) => r.trade ?? r.responsibleVendorId ?? "(unattributed)"),
      scheduleImpactDays: live.reduce((n, r) => n + (r.scheduleImpactDays ?? 0), 0),
      reasons:
        overall.withAmount === 0 && live.length > 0
          ? [
              "No rework item on this project carries a cost. The register is counting the events but not their price, so every figure below is a count rather than a cost.",
            ]
          : overall.totals.length > 1
            ? [
                "Rework costs are held in more than one currency and are reported per currency; a combined total would be invented.",
              ]
            : [],
    };
  });
};
