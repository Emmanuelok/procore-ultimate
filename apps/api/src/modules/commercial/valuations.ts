import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import {
  assertions,
  boqItems,
  boqs,
  contracts,
  paymentCertificates,
  valuationLines,
  valuations,
} from "@constructos/db";
import { VALUATION_BASES, VALUATION_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isoDateSchema, requireCommercialLevel, round2 } from "./shared.js";

const valuationCreateSchema = z.object({
  boqId: z.string().min(1),
  valuationDate: isoDateSchema,
  basis: z.enum(VALUATION_BASES),
  retentionPercent: z.number().min(0).max(100).optional(),
  contractId: z.string().nullable().optional(),
});

const valuationPatchSchema = z.object({
  materialsOnSite: z.number().min(0).optional(),
  materialsOffSite: z.number().min(0).optional(),
  retentionPercent: z.number().min(0).max(100).optional(),
  valuationDate: isoDateSchema.optional(),
});

const valuationListQuery = pageQuerySchema.extend({
  status: z.enum(VALUATION_STATUSES).optional(),
  boqId: z.string().optional(),
});

const putLinesSchema = z.object({
  lines: z
    .array(
      z.object({
        boqItemId: z.string().min(1),
        qtyToDate: z.number().min(0).nullable().optional(),
        percentToDate: z.number().min(0).max(100).nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});

const certifySchema = z.object({
  certifiedWorkDone: z.number().min(0).optional(),
  certifiedMaterials: z.number().min(0).optional(),
  varianceReason: z.string().max(2000).nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
});

/**
 * Interim valuations, payment applications and payment certificates
 * (spec Vol II Domain B #162-167, #179-180).
 */
export const valuationRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("commercial", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("commercial", "standard"),
  ];
  const companyGate = [app.authenticate, app.requireCompany];

  async function fetchValuation(valuationId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(valuations)
      .where(and(eq(valuations.id, valuationId), eq(valuations.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Valuation not found");
    return rows[0];
  }

  /** Σ netCertified over the (non-withdrawn) certificates of a BoQ's valuations. */
  async function previousNetFor(boqId: string): Promise<number> {
    const rows = await app.db
      .select({ net: paymentCertificates.netCertified })
      .from(paymentCertificates)
      .innerJoin(valuations, eq(valuations.id, paymentCertificates.valuationId))
      .where(and(eq(valuations.boqId, boqId), ne(paymentCertificates.status, "withdrawn")));
    return round2(rows.reduce((s, r) => s + r.net, 0));
  }

  /**
   * Recompute the money position of a draft valuation from its lines:
   *   workDoneToDate = Σ line amountToDate
   *   retentionHeld  = retention% × (workDone + matOnSite + matOffSite)
   *   netDue         = workDone + matOnSite + matOffSite − retention − previousNet
   * where previousNet = Σ netCertified of previous certificates on this BoQ.
   */
  async function recomputeValuation(
    valuationId: string,
    patch: Partial<{
      materialsOnSite: number;
      materialsOffSite: number;
      retentionPercent: number;
      valuationDate: string;
    }> = {},
  ) {
    const rows = await app.db
      .select()
      .from(valuations)
      .where(eq(valuations.id, valuationId))
      .limit(1);
    const val = rows[0];
    if (!val) throw notFound("Valuation not found");
    const lines = await app.db
      .select({ amountToDate: valuationLines.amountToDate })
      .from(valuationLines)
      .where(eq(valuationLines.valuationId, valuationId));
    const workDoneToDate = round2(lines.reduce((s, l) => s + l.amountToDate, 0));
    const materialsOnSite = patch.materialsOnSite ?? val.materialsOnSite;
    const materialsOffSite = patch.materialsOffSite ?? val.materialsOffSite;
    const retentionPercent = patch.retentionPercent ?? val.retentionPercent;
    const gross = workDoneToDate + materialsOnSite + materialsOffSite;
    const retentionHeld = round2((retentionPercent / 100) * gross);
    const previousNet = await previousNetFor(val.boqId);
    const netDue = round2(gross - retentionHeld - previousNet);
    await app.db
      .update(valuations)
      .set({
        ...(patch.valuationDate !== undefined ? { valuationDate: patch.valuationDate } : {}),
        materialsOnSite,
        materialsOffSite,
        retentionPercent,
        workDoneToDate,
        retentionHeld,
        previousNet,
        netDue,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(valuations.id, valuationId));
  }

  async function valuationWithLines(valuationId: string, companyId: string) {
    const val = await fetchValuation(valuationId, companyId);
    const lines = await app.db
      .select({
        id: valuationLines.id,
        boqItemId: valuationLines.boqItemId,
        qtyToDate: valuationLines.qtyToDate,
        percentToDate: valuationLines.percentToDate,
        amountToDate: valuationLines.amountToDate,
        previousAmount: valuationLines.previousAmount,
        thisPeriod: valuationLines.thisPeriod,
        code: boqItems.code,
        description: boqItems.description,
        unit: boqItems.unit,
        boqQuantity: boqItems.quantity,
        rate: boqItems.rate,
        boqAmount: boqItems.amount,
      })
      .from(valuationLines)
      .innerJoin(boqItems, eq(boqItems.id, valuationLines.boqItemId))
      .where(eq(valuationLines.valuationId, valuationId))
      .orderBy(asc(boqItems.path));
    return { ...val, lines };
  }

  /* ---------------------------------------------------------------- */
  /* Valuations                                                        */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/valuations", { preHandler: standardGate }, async (req, reply) => {
    const body = valuationCreateSchema.parse(req.body);
    const boqRows = await app.db
      .select()
      .from(boqs)
      .where(
        and(
          eq(boqs.id, body.boqId),
          eq(boqs.companyId, req.companyId!),
          eq(boqs.projectId, req.projectId!),
        ),
      )
      .limit(1);
    if (!boqRows[0]) throw badRequest("boqId does not reference a BoQ on this project");
    if (body.contractId) {
      const c = await app.db
        .select({ id: contracts.id })
        .from(contracts)
        .where(
          and(
            eq(contracts.id, body.contractId),
            eq(contracts.companyId, req.companyId!),
            eq(contracts.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!c[0]) throw badRequest("contractId does not reference a contract on this project");
    }

    // previous position: the latest CERTIFIED valuation of this BoQ seeds
    // each line's previousAmount (0 when this is the first application)
    const latestCertified = await app.db
      .select()
      .from(valuations)
      .where(and(eq(valuations.boqId, body.boqId), inArray(valuations.status, ["certified", "paid"])))
      .orderBy(desc(valuations.number))
      .limit(1);
    const prevByItem = new Map<
      string,
      { amountToDate: number; qtyToDate: number | null; percentToDate: number | null }
    >();
    if (latestCertified[0]) {
      const prevLines = await app.db
        .select()
        .from(valuationLines)
        .where(eq(valuationLines.valuationId, latestCertified[0].id));
      for (const l of prevLines) {
        prevByItem.set(l.boqItemId, {
          amountToDate: l.amountToDate,
          qtyToDate: l.qtyToDate,
          percentToDate: l.percentToDate,
        });
      }
    }

    const leafItems = await app.db
      .select()
      .from(boqItems)
      .where(and(eq(boqItems.boqId, body.boqId), eq(boqItems.level, "item")))
      .orderBy(asc(boqItems.path));

    const number = await nextRecordNumber(app.db, req.projectId!, "valuation");
    const id = newId("val");
    const retentionPercent = body.retentionPercent ?? 0;
    const previousNet = await previousNetFor(body.boqId);
    const workDoneToDate = round2(
      leafItems.reduce((s, i) => s + (prevByItem.get(i.id)?.amountToDate ?? 0), 0),
    );
    const retentionHeld = round2((retentionPercent / 100) * workDoneToDate);
    const netDue = round2(workDoneToDate - retentionHeld - previousNet);

    await app.db.transaction(async (tx) => {
      await tx.insert(valuations).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        contractId: body.contractId ?? null,
        boqId: body.boqId,
        number,
        valuationDate: body.valuationDate,
        basis: body.basis,
        status: "draft",
        retentionPercent,
        workDoneToDate,
        retentionHeld,
        previousNet,
        netDue,
        createdBy: req.user!.id,
      });
      for (const item of leafItems) {
        const prev = prevByItem.get(item.id);
        await tx.insert(valuationLines).values({
          id: newId("vln"),
          valuationId: id,
          boqItemId: item.id,
          qtyToDate: prev?.qtyToDate ?? null,
          percentToDate: prev?.percentToDate ?? null,
          amountToDate: prev?.amountToDate ?? 0,
          previousAmount: prev?.amountToDate ?? 0,
          thisPeriod: 0,
        });
      }
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "valuation",
      objectId: id,
      payload: { number, boqId: body.boqId, basis: body.basis },
    });
    return reply.status(201).send(await valuationWithLines(id, req.companyId!));
  });

  app.get("/projects/:projectId/valuations", { preHandler: readGate }, async (req) => {
    const q = valuationListQuery.parse(req.query);
    const clauses = [
      eq(valuations.companyId, req.companyId!),
      eq(valuations.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(valuations.status, q.status));
    if (q.boqId) clauses.push(eq(valuations.boqId, q.boqId));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(valuations).where(where);
    const items = await app.db
      .select()
      .from(valuations)
      .where(where)
      .orderBy(desc(valuations.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/valuations/:valuationId", { preHandler: companyGate }, async (req) => {
    const { valuationId } = req.params as { valuationId: string };
    return valuationWithLines(valuationId, req.companyId!);
  });

  app.put("/valuations/:valuationId/lines", { preHandler: companyGate }, async (req, reply) => {
    const { valuationId } = req.params as { valuationId: string };
    const body = putLinesSchema.parse(req.body);
    const val = await fetchValuation(valuationId, req.companyId!);
    await requireCommercialLevel(app, req, reply, val.projectId, "standard");
    if (val.status !== "draft") throw badRequest("Only a draft valuation's lines can be edited");

    const existing = await app.db
      .select()
      .from(valuationLines)
      .where(eq(valuationLines.valuationId, valuationId));
    const lineByItem = new Map(existing.map((l) => [l.boqItemId, l]));
    const itemIds = body.lines.map((l) => l.boqItemId);
    const items =
      itemIds.length > 0
        ? await app.db.select().from(boqItems).where(inArray(boqItems.id, itemIds))
        : [];
    const itemById = new Map(items.map((i) => [i.id, i]));

    for (const patch of body.lines) {
      const line = lineByItem.get(patch.boqItemId);
      if (!line) throw badRequest(`No valuation line for BQ item ${patch.boqItemId}`);
      const item = itemById.get(patch.boqItemId);
      if (!item) throw badRequest(`BQ item ${patch.boqItemId} not found`);
      const hasQty = patch.qtyToDate != null;
      const hasPercent = patch.percentToDate != null;
      if (hasQty === hasPercent) {
        throw badRequest("Each line takes exactly one of qtyToDate or percentToDate");
      }
      // #163 remeasure: qty × BQ rate | #164 percent: % × BQ item amount
      const amountToDate = hasQty
        ? round2(patch.qtyToDate! * (item.rate ?? 0))
        : round2((patch.percentToDate! / 100) * (item.amount ?? 0));
      await app.db
        .update(valuationLines)
        .set({
          qtyToDate: hasQty ? patch.qtyToDate! : null,
          percentToDate: hasPercent ? patch.percentToDate! : null,
          amountToDate,
          thisPeriod: round2(amountToDate - line.previousAmount),
        })
        .where(eq(valuationLines.id, line.id));
    }

    await recomputeValuation(valuationId);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "valuation",
      objectId: valuationId,
      payload: { linesUpdated: body.lines.length },
    });
    return valuationWithLines(valuationId, req.companyId!);
  });

  app.patch("/valuations/:valuationId", { preHandler: companyGate }, async (req, reply) => {
    const { valuationId } = req.params as { valuationId: string };
    const body = valuationPatchSchema.parse(req.body);
    const val = await fetchValuation(valuationId, req.companyId!);
    await requireCommercialLevel(app, req, reply, val.projectId, "standard");
    if (val.status !== "draft") throw badRequest("Only a draft valuation can be edited");
    await recomputeValuation(valuationId, body);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "valuation",
      objectId: valuationId,
      payload: { changed: Object.keys(body) },
    });
    return valuationWithLines(valuationId, req.companyId!);
  });

  app.post("/valuations/:valuationId/submit", { preHandler: companyGate }, async (req, reply) => {
    const { valuationId } = req.params as { valuationId: string };
    const val = await fetchValuation(valuationId, req.companyId!);
    await requireCommercialLevel(app, req, reply, val.projectId, "standard");
    if (val.status !== "draft") throw badRequest("Only a draft valuation can be submitted");
    const now = new Date().toISOString();
    await app.db
      .update(valuations)
      .set({ status: "submitted", submittedBy: req.user!.id, submittedAt: now, updatedAt: now })
      .where(eq(valuations.id, valuationId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "valuation",
      objectId: valuationId,
      payload: { from: "draft", to: "submitted", netDue: val.netDue },
    });
    return fetchValuation(valuationId, req.companyId!);
  });

  /* ---------------------------------------------------------------- */
  /* Payment certificates (#179-180)                                   */
  /* ---------------------------------------------------------------- */

  app.post("/valuations/:valuationId/certify", { preHandler: companyGate }, async (req, reply) => {
    const { valuationId } = req.params as { valuationId: string };
    const body = certifySchema.parse(req.body);
    const val = await fetchValuation(valuationId, req.companyId!);
    await requireCommercialLevel(app, req, reply, val.projectId, "admin");
    if (val.status !== "submitted") {
      throw badRequest("Only a submitted valuation can be certified");
    }
    // separation of duties: the certifier must be independent of the applicant
    if (val.submittedBy === req.user!.id) {
      throw forbidden("The certifier must not be the valuation's submitter");
    }

    const boqRows = await app.db
      .select()
      .from(boqs)
      .where(eq(boqs.id, val.boqId))
      .limit(1);
    const currency = boqRows[0]?.currency ?? "USD";

    const certifiedWorkDone = round2(body.certifiedWorkDone ?? val.workDoneToDate);
    const certifiedMaterials = round2(
      body.certifiedMaterials ?? val.materialsOnSite + val.materialsOffSite,
    );
    const retentionHeld = round2(
      (val.retentionPercent / 100) * (certifiedWorkDone + certifiedMaterials),
    );
    const previousCertified = await previousNetFor(val.boqId);
    const netCertified = round2(
      certifiedWorkDone + certifiedMaterials - retentionHeld - previousCertified,
    );
    const varianceFromApplication = round2(netCertified - val.netDue);

    const number = await nextRecordNumber(app.db, val.projectId, "certificate");
    const certId = newId("cert");
    const now = new Date().toISOString();
    await app.db.transaction(async (tx) => {
      await tx.insert(paymentCertificates).values({
        id: certId,
        companyId: req.companyId!,
        projectId: val.projectId,
        valuationId,
        number,
        certifiedWorkDone,
        certifiedMaterials,
        retentionHeld,
        previousCertified,
        netCertified,
        varianceFromApplication,
        varianceReason: body.varianceReason ?? null,
        dueDate: body.dueDate ?? null,
        status: "issued",
        issuedBy: req.user!.id,
      });
      await tx
        .update(valuations)
        .set({ status: "certified", updatedAt: now })
        .where(eq(valuations.id, valuationId));
      // the certified value is a reconcilable Assertion in the assurance layer
      await tx.insert(assertions).values({
        id: newId("ast"),
        companyId: req.companyId!,
        projectId: val.projectId,
        kind: "cost",
        claimantId: req.user!.id,
        claimantKind: "user",
        value: netCertified,
        unit: currency,
        basis: `payment certificate ${number}`,
        sourceType: "payment_certificate",
        sourceId: certId,
        assertedAt: now,
      });
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "payment_certificate",
      objectId: certId,
      payload: {
        number,
        valuationId,
        certifiedWorkDone,
        certifiedMaterials,
        retentionHeld,
        previousCertified,
        netCertified,
        varianceFromApplication,
      },
      storePayload: true,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "valuation",
      objectId: valuationId,
      payload: { from: "submitted", to: "certified", certificateId: certId },
    });
    const created = await app.db
      .select()
      .from(paymentCertificates)
      .where(eq(paymentCertificates.id, certId))
      .limit(1);
    return reply.status(201).send(created[0]);
  });

  app.get("/projects/:projectId/certificates", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = and(
      eq(paymentCertificates.companyId, req.companyId!),
      eq(paymentCertificates.projectId, req.projectId!),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(paymentCertificates).where(where);
    const items = await app.db
      .select()
      .from(paymentCertificates)
      .where(where)
      .orderBy(desc(paymentCertificates.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/certificates/:certId", { preHandler: companyGate }, async (req) => {
    const { certId } = req.params as { certId: string };
    const rows = await app.db
      .select()
      .from(paymentCertificates)
      .where(
        and(eq(paymentCertificates.id, certId), eq(paymentCertificates.companyId, req.companyId!)),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Certificate not found");
    return rows[0];
  });
};
