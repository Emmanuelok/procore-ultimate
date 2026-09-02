import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  assertions,
  boqItems,
  boqs,
  contracts,
  dayworkSheets,
  paymentCertificates,
  retentionReleases,
  valuationLines,
  valuationSections,
  valuations,
  variations,
} from "@constructos/db";
import {
  RETENTION_RELEASE_KINDS,
  VALUATION_BASES,
  VALUATION_SECTION_KINDS,
  VALUATION_STATUSES,
  type ContractForm,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import { orderedItems } from "./boqs.js";
import {
  isoDateSchema,
  requireCommercialLevel,
  round2,
  subResourceGate,
  todayISO,
} from "./shared.js";
import {
  computeValuationTotals,
  paymentDueRule,
  retentionSchedule,
  type SectionInput,
} from "./valuation-engine.js";

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

const sectionCreateSchema = z.object({
  kind: z.enum(VALUATION_SECTION_KINDS),
  description: z.string().min(1).max(500),
  amountToDate: z.number().finite(),
  previousAmount: z.number().finite().optional(),
  sourceType: z.string().max(60).nullable().optional(),
  sourceId: z.string().max(60).nullable().optional(),
  retentionApplies: z.boolean().optional(),
  evidenceRef: z.string().max(300).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

const sectionPatchSchema = sectionCreateSchema.partial().omit({ kind: true });

const certifySchema = z.object({
  certifiedWorkDone: z.number().min(0).optional(),
  certifiedMaterials: z.number().min(0).optional(),
  certifiedSections: z.number().finite().optional(),
  varianceReason: z.string().max(2000).nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
});

const withdrawSchema = z.object({ reason: z.string().min(3).max(2000) });

const paidSchema = z.object({
  amount: z.number().finite(),
  paidOn: isoDateSchema,
  reference: z.string().max(200).nullable().optional(),
});

const releaseSchema = z.object({
  kind: z.enum(RETENTION_RELEASE_KINDS),
  amount: z.number().positive(),
  releasedOn: isoDateSchema,
  boqId: z.string().nullable().optional(),
  contractId: z.string().nullable().optional(),
  bondReference: z.string().max(200).nullable().optional(),
  reason: z.string().max(2000).nullable().optional(),
});

/** Statuses that mean a valuation is still in play on its BoQ. */
const OPEN_VALUATION_STATUSES = ["draft", "submitted"] as const;

/**
 * Interim valuations, typed valuation sections, payment certificates and
 * retention (spec Vol II Domain B #162-167, #179-180, #254).
 *
 * The three defects this file exists to fix:
 *  • valuations could be created and certified out of sequence, so an earlier
 *    certificate netted off money certified after it was applied for and could
 *    be issued NEGATIVE;
 *  • retention ignored the contract's percentage and cap entirely;
 *  • a certificate could never be withdrawn or marked paid, so "certified to
 *    date" could never become "paid to date".
 */
export const valuationRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("commercial", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("commercial", "standard"),
  ];
  const adminGate = [app.authenticate, app.requireCompany, app.requireTool("commercial", "admin")];
  const subRead = subResourceGate(app, "read");
  const subWrite = subResourceGate(app, "standard");
  const subAdmin = subResourceGate(app, "admin");

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
  async function previousNetFor(db: Db, boqId: string, excludeValuationId?: string): Promise<number> {
    const rows = await db
      .select({ net: paymentCertificates.netCertified, valuationId: paymentCertificates.valuationId })
      .from(paymentCertificates)
      .innerJoin(valuations, eq(valuations.id, paymentCertificates.valuationId))
      .where(and(eq(valuations.boqId, boqId), ne(paymentCertificates.status, "withdrawn")));
    return round2(
      rows
        .filter((r) => r.valuationId !== excludeValuationId)
        .reduce((s, r) => s + r.net, 0),
    );
  }

  /** Retention already released against a BoQ (cash out, or replaced by a bond). */
  async function releasedFor(db: Db, boqId: string): Promise<number> {
    const rows = await db
      .select({ amount: retentionReleases.amount })
      .from(retentionReleases)
      .where(eq(retentionReleases.boqId, boqId));
    return round2(rows.reduce((s, r) => s + r.amount, 0));
  }

  async function sectionsFor(db: Db, valuationId: string): Promise<SectionInput[]> {
    const rows = await db
      .select({
        kind: valuationSections.kind,
        amountToDate: valuationSections.amountToDate,
        retentionApplies: valuationSections.retentionApplies,
      })
      .from(valuationSections)
      .where(eq(valuationSections.valuationId, valuationId));
    return rows;
  }

  /**
   * Recompute the money position of a valuation from its lines and sections.
   * Takes the db handle so it can run INSIDE the certify transaction — the
   * previous implementation recomputed on the draft path only, leaving
   * `netDue` frozen at the last draft edit while `previousCertified` moved on.
   */
  async function recomputeValuation(
    db: Db,
    valuationId: string,
    patch: Partial<{
      materialsOnSite: number;
      materialsOffSite: number;
      retentionPercent: number;
      valuationDate: string;
    }> = {},
  ) {
    const rows = await db.select().from(valuations).where(eq(valuations.id, valuationId)).limit(1);
    const val = rows[0];
    if (!val) throw notFound("Valuation not found");
    const lines = await db
      .select({ amountToDate: valuationLines.amountToDate })
      .from(valuationLines)
      .where(eq(valuationLines.valuationId, valuationId));
    const sections = await sectionsFor(db, valuationId);
    const totals = computeValuationTotals({
      workDoneToDate: lines.reduce((s, l) => s + l.amountToDate, 0),
      materialsOnSite: patch.materialsOnSite ?? val.materialsOnSite,
      materialsOffSite: patch.materialsOffSite ?? val.materialsOffSite,
      sections,
      retentionPercent: patch.retentionPercent ?? val.retentionPercent,
      retentionCap: val.retentionCap,
      retentionReleased: await releasedFor(db, val.boqId),
      previousNet: await previousNetFor(db, val.boqId, valuationId),
    });
    await db
      .update(valuations)
      .set({
        ...(patch.valuationDate !== undefined ? { valuationDate: patch.valuationDate } : {}),
        materialsOnSite: totals.materialsOnSite,
        materialsOffSite: totals.materialsOffSite,
        retentionPercent: totals.retentionPercent,
        workDoneToDate: totals.workDoneToDate,
        sectionsTotal: totals.sectionsTotal,
        grossTotal: totals.grossTotal,
        retentionHeld: totals.retentionHeld,
        retentionReleased: totals.retentionReleased,
        previousNet: totals.previousNet,
        netDue: totals.netDue,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(valuations.id, valuationId));
    return totals;
  }

  async function valuationWithLines(valuationId: string, companyId: string) {
    const val = await fetchValuation(valuationId, companyId);
    const items = orderedItems(
      await app.db.select().from(boqItems).where(eq(boqItems.boqId, val.boqId)),
    );
    const order = new Map(items.map((i, idx) => [i.id, idx]));
    const raw = await app.db
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
      .where(eq(valuationLines.valuationId, valuationId));
    // the same order the BoQ tab shows, not insertion order
    const lines = raw.sort(
      (a, b) => (order.get(a.boqItemId) ?? 0) - (order.get(b.boqItemId) ?? 0),
    );
    const sections = await app.db
      .select()
      .from(valuationSections)
      .where(eq(valuationSections.valuationId, valuationId))
      .orderBy(asc(valuationSections.createdAt));
    const certificates = await app.db
      .select()
      .from(paymentCertificates)
      .where(eq(paymentCertificates.valuationId, valuationId))
      .orderBy(desc(paymentCertificates.number));
    return { ...val, lines, sections, certificates };
  }

  async function ledger(
    req: { companyId?: string; user?: { id: string } },
    action: "create" | "update" | "delete" | "state_change",
    objectType: string,
    objectId: string,
    payload: unknown,
    projectId: string,
    storePayload = false,
  ) {
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action,
      objectType,
      objectId,
      payload,
      projectId,
      storePayload,
    });
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
    const boq = boqRows[0];
    if (!boq) throw badRequest("boqId does not reference a BoQ on this project");
    // A draft bill is still being written; valuing against it lets items move
    // (or vanish) underneath lines that already carry money.
    if (boq.status === "draft") {
      throw badRequest(
        "Only an issued or agreed BoQ can be valued; issue the bill before raising an application.",
      );
    }

    // Sequence discipline (#162): one open application per bill at a time.
    // Without this, a later valuation can be certified first and the earlier
    // one then nets off money certified after it was applied for — producing a
    // NEGATIVE certificate and a false variance statement.
    const open = await app.db
      .select({ id: valuations.id, number: valuations.number, status: valuations.status })
      .from(valuations)
      .where(
        and(eq(valuations.boqId, body.boqId), inArray(valuations.status, [...OPEN_VALUATION_STATUSES])),
      )
      .orderBy(asc(valuations.number))
      .limit(1);
    if (open[0]) {
      throw conflict(
        `Valuation ${open[0].number} on this bill is still ${open[0].status}; certify or withdraw it before raising the next application.`,
      );
    }

    const contractId = body.contractId ?? boq.contractId ?? null;
    let contract: typeof contracts.$inferSelect | undefined;
    if (contractId) {
      const c = await app.db
        .select()
        .from(contracts)
        .where(
          and(
            eq(contracts.id, contractId),
            eq(contracts.companyId, req.companyId!),
            eq(contracts.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!c[0]) throw badRequest("contractId does not reference a contract on this project");
      contract = c[0];
      if (contract.currency !== boq.currency) {
        throw badRequest(
          `The contract is in ${contract.currency} and the BoQ in ${boq.currency}; a valuation cannot span two currencies.`,
        );
      }
    }

    // Retention comes from the CONTRACT unless the caller overrides it, and the
    // contract's cap is carried onto the valuation so it survives recompute.
    const retentionPercent = body.retentionPercent ?? contract?.retentionPercent ?? 0;
    const retentionCap = contract?.retentionCap ?? null;

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

    const leafItems = orderedItems(
      await app.db.select().from(boqItems).where(eq(boqItems.boqId, body.boqId)),
    ).filter((i) => i.level === "item");

    const number = await nextRecordNumber(app.db, req.projectId!, "valuation");
    const id = newId("val");
    const previousNet = await previousNetFor(app.db, body.boqId);
    const released = await releasedFor(app.db, body.boqId);
    const totals = computeValuationTotals({
      workDoneToDate: leafItems.reduce((s, i) => s + (prevByItem.get(i.id)?.amountToDate ?? 0), 0),
      materialsOnSite: 0,
      materialsOffSite: 0,
      sections: [],
      retentionPercent,
      retentionCap,
      retentionReleased: released,
      previousNet,
    });

    await app.db.transaction(async (tx) => {
      await tx.insert(valuations).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        contractId,
        boqId: body.boqId,
        number,
        valuationDate: body.valuationDate,
        basis: body.basis,
        status: "draft",
        currency: boq.currency,
        retentionPercent,
        retentionCap,
        workDoneToDate: totals.workDoneToDate,
        sectionsTotal: 0,
        grossTotal: totals.grossTotal,
        retentionHeld: totals.retentionHeld,
        retentionReleased: totals.retentionReleased,
        previousNet: totals.previousNet,
        netDue: totals.netDue,
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
    await ledger(
      req,
      "create",
      "valuation",
      id,
      { number, boqId: body.boqId, basis: body.basis, retentionPercent, retentionCap },
      req.projectId!,
    );
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

  app.get("/valuations/:valuationId", { preHandler: subRead }, async (req, reply) => {
    const { valuationId } = req.params as { valuationId: string };
    const val = await fetchValuation(valuationId, req.companyId!);
    await requireCommercialLevel(app, req, reply, val.projectId, "read");
    return valuationWithLines(valuationId, req.companyId!);
  });

  app.put("/valuations/:valuationId/lines", { preHandler: subWrite }, async (req, reply) => {
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

    // Validate every line BEFORE writing any of them, then write them all in
    // one transaction: a half-applied autosave used to leave header totals
    // stale with no ledger entry.
    const updates: Array<{
      id: string;
      qtyToDate: number | null;
      percentToDate: number | null;
      amountToDate: number;
      thisPeriod: number;
    }> = [];
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
      updates.push({
        id: line.id,
        qtyToDate: hasQty ? patch.qtyToDate! : null,
        percentToDate: hasPercent ? patch.percentToDate! : null,
        amountToDate,
        thisPeriod: round2(amountToDate - line.previousAmount),
      });
    }

    await app.db.transaction(async (tx) => {
      for (const u of updates) {
        await tx
          .update(valuationLines)
          .set({
            qtyToDate: u.qtyToDate,
            percentToDate: u.percentToDate,
            amountToDate: u.amountToDate,
            thisPeriod: u.thisPeriod,
          })
          .where(eq(valuationLines.id, u.id));
      }
      await recomputeValuation(tx, valuationId);
    });
    await ledger(
      req,
      "update",
      "valuation",
      valuationId,
      { linesUpdated: body.lines.length },
      val.projectId,
    );
    return valuationWithLines(valuationId, req.companyId!);
  });

  app.patch("/valuations/:valuationId", { preHandler: subWrite }, async (req, reply) => {
    const { valuationId } = req.params as { valuationId: string };
    const body = valuationPatchSchema.parse(req.body);
    const val = await fetchValuation(valuationId, req.companyId!);
    await requireCommercialLevel(app, req, reply, val.projectId, "standard");
    if (val.status !== "draft") throw badRequest("Only a draft valuation can be edited");
    await app.db.transaction(async (tx) => {
      await recomputeValuation(tx, valuationId, body);
    });
    await ledger(
      req,
      "update",
      "valuation",
      valuationId,
      { changed: Object.keys(body) },
      val.projectId,
    );
    return valuationWithLines(valuationId, req.companyId!);
  });

  /* ---------------------------------------------------------------- */
  /* Valuation sections (#132, #166-167)                               */
  /* ---------------------------------------------------------------- */

  app.get("/valuations/:valuationId/sections", { preHandler: subRead }, async (req, reply) => {
    const { valuationId } = req.params as { valuationId: string };
    const val = await fetchValuation(valuationId, req.companyId!);
    await requireCommercialLevel(app, req, reply, val.projectId, "read");
    const items = await app.db
      .select()
      .from(valuationSections)
      .where(eq(valuationSections.valuationId, valuationId))
      .orderBy(asc(valuationSections.createdAt));
    return { items, total: items.length, currency: val.currency };
  });

  app.post("/valuations/:valuationId/sections", { preHandler: subWrite }, async (req, reply) => {
    const { valuationId } = req.params as { valuationId: string };
    const body = sectionCreateSchema.parse(req.body);
    const val = await fetchValuation(valuationId, req.companyId!);
    await requireCommercialLevel(app, req, reply, val.projectId, "standard");
    if (val.status !== "draft") throw badRequest("Sections can only be edited while the valuation is draft");
    if (body.kind === "contra_charge" && body.amountToDate > 0) {
      throw badRequest("A contra charge is a deduction and must be negative");
    }
    if (
      (body.kind === "materials_on_site" || body.kind === "materials_off_site") &&
      !body.evidenceRef
    ) {
      throw badRequest(
        "Materials on or off site must cite the vesting certificate or off-site bond that transfers title (evidenceRef)",
      );
    }
    const id = newId("vsec");
    const previousAmount = body.previousAmount ?? 0;
    await app.db.transaction(async (tx) => {
      await tx.insert(valuationSections).values({
        id,
        companyId: req.companyId!,
        projectId: val.projectId,
        valuationId,
        kind: body.kind,
        description: body.description,
        sourceType: body.sourceType ?? null,
        sourceId: body.sourceId ?? null,
        amountToDate: round2(body.amountToDate),
        previousAmount: round2(previousAmount),
        thisPeriod: round2(body.amountToDate - previousAmount),
        retentionApplies: body.retentionApplies ?? body.kind !== "contra_charge",
        evidenceRef: body.evidenceRef ?? null,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      });
      await recomputeValuation(tx, valuationId);
    });
    await ledger(
      req,
      "create",
      "valuation_section",
      id,
      { valuationId, kind: body.kind, amountToDate: body.amountToDate },
      val.projectId,
    );
    const created = await app.db
      .select()
      .from(valuationSections)
      .where(eq(valuationSections.id, id))
      .limit(1);
    return reply.status(201).send(created[0]);
  });

  app.patch("/valuation-sections/:sectionId", { preHandler: subWrite }, async (req, reply) => {
    const { sectionId } = req.params as { sectionId: string };
    const body = sectionPatchSchema.parse(req.body);
    const rows = await app.db
      .select()
      .from(valuationSections)
      .where(
        and(eq(valuationSections.id, sectionId), eq(valuationSections.companyId, req.companyId!)),
      )
      .limit(1);
    const section = rows[0];
    if (!section) throw notFound("Valuation section not found");
    await requireCommercialLevel(app, req, reply, section.projectId, "standard");
    const val = await fetchValuation(section.valuationId, req.companyId!);
    if (val.status !== "draft") throw badRequest("Sections can only be edited while the valuation is draft");

    const amountToDate = body.amountToDate ?? section.amountToDate;
    const previousAmount = body.previousAmount ?? section.previousAmount;
    await app.db.transaction(async (tx) => {
      await tx
        .update(valuationSections)
        .set({
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.retentionApplies !== undefined
            ? { retentionApplies: body.retentionApplies }
            : {}),
          ...(body.evidenceRef !== undefined ? { evidenceRef: body.evidenceRef } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          amountToDate: round2(amountToDate),
          previousAmount: round2(previousAmount),
          thisPeriod: round2(amountToDate - previousAmount),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(valuationSections.id, sectionId));
      await recomputeValuation(tx, section.valuationId);
    });
    await ledger(
      req,
      "update",
      "valuation_section",
      sectionId,
      { changed: Object.keys(body) },
      section.projectId,
    );
    const updated = await app.db
      .select()
      .from(valuationSections)
      .where(eq(valuationSections.id, sectionId))
      .limit(1);
    return updated[0];
  });

  app.delete("/valuation-sections/:sectionId", { preHandler: subWrite }, async (req, reply) => {
    const { sectionId } = req.params as { sectionId: string };
    const rows = await app.db
      .select()
      .from(valuationSections)
      .where(
        and(eq(valuationSections.id, sectionId), eq(valuationSections.companyId, req.companyId!)),
      )
      .limit(1);
    const section = rows[0];
    if (!section) throw notFound("Valuation section not found");
    await requireCommercialLevel(app, req, reply, section.projectId, "standard");
    const val = await fetchValuation(section.valuationId, req.companyId!);
    if (val.status !== "draft") throw badRequest("Sections can only be edited while the valuation is draft");
    await app.db.transaction(async (tx) => {
      await tx.delete(valuationSections).where(eq(valuationSections.id, sectionId));
      await recomputeValuation(tx, section.valuationId);
    });
    await ledger(
      req,
      "delete",
      "valuation_section",
      sectionId,
      { valuationId: section.valuationId, kind: section.kind },
      section.projectId,
    );
    return { ok: true };
  });

  /**
   * Pull the agreed variation register and the verified daywork sheets into
   * the application as sections (#166). Idempotent: a source already present
   * is updated, never duplicated.
   */
  app.post("/valuations/:valuationId/sections/sync", { preHandler: subWrite }, async (req, reply) => {
    const { valuationId } = req.params as { valuationId: string };
    const val = await fetchValuation(valuationId, req.companyId!);
    await requireCommercialLevel(app, req, reply, val.projectId, "standard");
    if (val.status !== "draft") throw badRequest("Only a draft valuation can be synced");

    const agreed = await app.db
      .select()
      .from(variations)
      .where(
        and(
          eq(variations.companyId, req.companyId!),
          eq(variations.projectId, val.projectId),
          eq(variations.status, "agreed"),
        ),
      );
    const sheets = await app.db
      .select()
      .from(dayworkSheets)
      .where(
        and(
          eq(dayworkSheets.companyId, req.companyId!),
          eq(dayworkSheets.projectId, val.projectId),
          inArray(dayworkSheets.status, ["verified", "valued"]),
        ),
      );
    const existing = await app.db
      .select()
      .from(valuationSections)
      .where(eq(valuationSections.valuationId, valuationId));
    const bySource = new Map(
      existing
        .filter((s) => s.sourceType && s.sourceId)
        .map((s) => [`${s.sourceType}:${s.sourceId}`, s]),
    );

    let added = 0;
    let updated = 0;
    const skipped: string[] = [];
    await app.db.transaction(async (tx) => {
      const upsert = async (
        kind: "variation" | "daywork",
        sourceId: string,
        description: string,
        amount: number,
        currency: string,
      ) => {
        if (currency !== val.currency) {
          skipped.push(
            `${description} is in ${currency}; this application is in ${val.currency} and the two cannot be added.`,
          );
          return;
        }
        const key = `${kind}:${sourceId}`;
        const found = bySource.get(key);
        if (found) {
          if (Math.abs(found.amountToDate - amount) < 0.005) return;
          await tx
            .update(valuationSections)
            .set({
              amountToDate: round2(amount),
              thisPeriod: round2(amount - found.previousAmount),
              updatedAt: new Date().toISOString(),
            })
            .where(eq(valuationSections.id, found.id));
          updated += 1;
          return;
        }
        await tx.insert(valuationSections).values({
          id: newId("vsec"),
          companyId: req.companyId!,
          projectId: val.projectId,
          valuationId,
          kind,
          description,
          sourceType: kind,
          sourceId,
          amountToDate: round2(amount),
          previousAmount: 0,
          thisPeriod: round2(amount),
          retentionApplies: true,
          createdBy: req.user!.id,
        });
        added += 1;
      };

      for (const v of agreed) {
        if (v.agreedValue == null) {
          skipped.push(`Variation ${v.number} is agreed but carries no agreed value.`);
          continue;
        }
        await upsert("variation", v.id, `VO-${v.number}: ${v.title}`, v.agreedValue, v.currency);
      }
      for (const s of sheets) {
        await upsert(
          "daywork",
          s.id,
          `DW-${s.number}: ${s.description}`,
          s.grossTotal,
          s.currency,
        );
      }
      await recomputeValuation(tx, valuationId);
    });

    await ledger(
      req,
      "update",
      "valuation",
      valuationId,
      { syncedSections: added + updated, added, updated, skipped: skipped.length },
      val.projectId,
    );
    return { added, updated, skipped };
  });

  app.post("/valuations/:valuationId/submit", { preHandler: subWrite }, async (req, reply) => {
    const { valuationId } = req.params as { valuationId: string };
    const val = await fetchValuation(valuationId, req.companyId!);
    await requireCommercialLevel(app, req, reply, val.projectId, "standard");
    if (val.status !== "draft") throw badRequest("Only a draft valuation can be submitted");

    // Statutory due date from the contract's payment clause (#179): a due date
    // with no cited basis is not a due date, so both are stored together.
    let dueDate: string | null = null;
    let dueDateBasis: string | null = null;
    if (val.contractId) {
      const c = await app.db
        .select()
        .from(contracts)
        .where(eq(contracts.id, val.contractId))
        .limit(1);
      const contract = c[0];
      if (contract) {
        const rule = paymentDueRule(contract.form as ContractForm, contract.paymentDueDays);
        if (rule) {
          const d = new Date(`${val.valuationDate}T00:00:00Z`);
          d.setUTCDate(d.getUTCDate() + rule.days);
          dueDate = d.toISOString().slice(0, 10);
          dueDateBasis = rule.basis;
        }
      }
    }

    const now = new Date().toISOString();
    // recompute immediately before freezing so netDue reflects the final state
    await app.db.transaction(async (tx) => {
      await recomputeValuation(tx, valuationId);
      await tx
        .update(valuations)
        .set({
          status: "submitted",
          submittedBy: req.user!.id,
          submittedAt: now,
          dueDate,
          dueDateBasis,
          updatedAt: now,
        })
        .where(eq(valuations.id, valuationId));
    });
    const submitted = await fetchValuation(valuationId, req.companyId!);
    await ledger(
      req,
      "state_change",
      "valuation",
      valuationId,
      { from: "draft", to: "submitted", netDue: submitted.netDue, dueDate },
      val.projectId,
    );
    return submitted;
  });

  /* ---------------------------------------------------------------- */
  /* Payment certificates (#179-180)                                   */
  /* ---------------------------------------------------------------- */

  app.post("/valuations/:valuationId/certify", { preHandler: subAdmin }, async (req, reply) => {
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
    // Sequence discipline: an earlier application still open would net off
    // money certified after it was applied for.
    const earlierOpen = await app.db
      .select({ number: valuations.number, status: valuations.status })
      .from(valuations)
      .where(
        and(
          eq(valuations.boqId, val.boqId),
          inArray(valuations.status, [...OPEN_VALUATION_STATUSES]),
          sql`${valuations.number} < ${val.number}`,
        ),
      )
      .orderBy(asc(valuations.number))
      .limit(1);
    if (earlierOpen[0]) {
      throw conflict(
        `Valuation ${earlierOpen[0].number} on this bill is still ${earlierOpen[0].status} and must be certified first.`,
      );
    }

    const boqRows = await app.db.select().from(boqs).where(eq(boqs.id, val.boqId)).limit(1);
    const currency = boqRows[0]?.currency ?? val.currency;

    const number = await nextRecordNumber(app.db, val.projectId, "certificate");
    const certId = newId("cert");
    const now = new Date().toISOString();
    let result!: {
      certifiedWorkDone: number;
      certifiedMaterials: number;
      certifiedSections: number;
      retentionHeld: number;
      previousCertified: number;
      netCertified: number;
      varianceFromApplication: number;
    };

    await app.db.transaction(async (tx) => {
      // Recompute inside the transaction, immediately before netting: the old
      // code compared a netDue frozen at the last draft edit against a
      // previousCertified read fresh, which is how a certificate could go
      // negative.
      const totals = await recomputeValuation(tx, valuationId);
      const certifiedWorkDone = round2(body.certifiedWorkDone ?? totals.workDoneToDate);
      const certifiedMaterials = round2(
        body.certifiedMaterials ?? totals.materialsOnSite + totals.materialsOffSite,
      );
      const certifiedSections = round2(body.certifiedSections ?? totals.sectionsTotal);
      const certifiedGross = round2(certifiedWorkDone + certifiedMaterials + certifiedSections);
      // Retention is taken on the certified gross LESS the sections that are
      // outside the retention base (contra charges and the like). Any cut the
      // certifier makes is treated as a cut to retainable value, which is the
      // conservative reading — it never retains against a deduction.
      const nonRetainableSections = round2(totals.grossTotal - totals.retentionBase);
      const certifiedRetentionBase = round2(certifiedGross - nonRetainableSections);
      const rawRetention = round2((val.retentionPercent / 100) * Math.max(0, certifiedRetentionBase));
      const cappedRetention =
        val.retentionCap != null ? Math.min(rawRetention, val.retentionCap) : rawRetention;
      const retentionHeld = round2(Math.max(0, cappedRetention - totals.retentionReleased));
      const previousCertified = totals.previousNet;
      const netCertified = round2(certifiedGross - retentionHeld - previousCertified);
      const varianceFromApplication = round2(netCertified - totals.netDue);

      await tx.insert(paymentCertificates).values({
        id: certId,
        companyId: req.companyId!,
        projectId: val.projectId,
        valuationId,
        number,
        currency,
        certifiedWorkDone,
        certifiedMaterials,
        certifiedSections,
        retentionHeld,
        retentionReleased: totals.retentionReleased,
        previousCertified,
        netCertified,
        varianceFromApplication,
        varianceReason: body.varianceReason ?? null,
        dueDate: body.dueDate ?? val.dueDate ?? null,
        dueDateBasis: body.dueDate ? "Set by the certifier" : val.dueDateBasis,
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
      result = {
        certifiedWorkDone,
        certifiedMaterials,
        certifiedSections,
        retentionHeld,
        previousCertified,
        netCertified,
        varianceFromApplication,
      };
    });

    await ledger(
      req,
      "create",
      "payment_certificate",
      certId,
      { number, valuationId, currency, ...result },
      val.projectId,
      true,
    );
    await ledger(
      req,
      "state_change",
      "valuation",
      valuationId,
      { from: "submitted", to: "certified", certificateId: certId },
      val.projectId,
    );
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
    const today = todayISO();
    return paginate(
      items.map((c) => ({
        ...c,
        overdue: c.status === "issued" && c.dueDate != null && c.dueDate < today,
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.get("/certificates/:certId", { preHandler: subRead }, async (req, reply) => {
    const { certId } = req.params as { certId: string };
    const rows = await app.db
      .select()
      .from(paymentCertificates)
      .where(
        and(eq(paymentCertificates.id, certId), eq(paymentCertificates.companyId, req.companyId!)),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Certificate not found");
    await requireCommercialLevel(app, req, reply, rows[0].projectId, "read");
    return rows[0];
  });

  /**
   * Withdraw a certificate that should not have been issued (#180). The
   * valuation returns to `submitted` so a corrected certificate can be
   * issued, and the withdrawn certificate stops counting anywhere.
   */
  app.post("/certificates/:certId/withdraw", { preHandler: subAdmin }, async (req, reply) => {
    const { certId } = req.params as { certId: string };
    const body = withdrawSchema.parse(req.body);
    const rows = await app.db
      .select()
      .from(paymentCertificates)
      .where(
        and(eq(paymentCertificates.id, certId), eq(paymentCertificates.companyId, req.companyId!)),
      )
      .limit(1);
    const cert = rows[0];
    if (!cert) throw notFound("Certificate not found");
    await requireCommercialLevel(app, req, reply, cert.projectId, "admin");
    if (cert.status !== "issued") throw badRequest(`A ${cert.status} certificate cannot be withdrawn`);

    const now = new Date().toISOString();
    await app.db.transaction(async (tx) => {
      await tx
        .update(paymentCertificates)
        .set({
          status: "withdrawn",
          withdrawnReason: body.reason,
          withdrawnBy: req.user!.id,
          withdrawnAt: now,
        })
        .where(and(eq(paymentCertificates.id, certId), eq(paymentCertificates.status, "issued")));
      await tx
        .update(valuations)
        .set({ status: "submitted", updatedAt: now })
        .where(and(eq(valuations.id, cert.valuationId), eq(valuations.status, "certified")));
      await recomputeValuation(tx, cert.valuationId);
    });
    await ledger(
      req,
      "state_change",
      "payment_certificate",
      certId,
      { from: "issued", to: "withdrawn", reason: body.reason, netCertified: cert.netCertified },
      cert.projectId,
      true,
    );
    const updated = await app.db
      .select()
      .from(paymentCertificates)
      .where(eq(paymentCertificates.id, certId))
      .limit(1);
    return updated[0];
  });

  /** Record payment against a certificate so "certified" can become "paid". */
  app.post("/certificates/:certId/paid", { preHandler: subWrite }, async (req, reply) => {
    const { certId } = req.params as { certId: string };
    const body = paidSchema.parse(req.body);
    const rows = await app.db
      .select()
      .from(paymentCertificates)
      .where(
        and(eq(paymentCertificates.id, certId), eq(paymentCertificates.companyId, req.companyId!)),
      )
      .limit(1);
    const cert = rows[0];
    if (!cert) throw notFound("Certificate not found");
    await requireCommercialLevel(app, req, reply, cert.projectId, "standard");
    if (cert.status === "withdrawn") throw badRequest("A withdrawn certificate cannot be paid");
    if (cert.status === "paid") throw conflict("This certificate is already recorded as paid");

    const now = new Date().toISOString();
    const shortPaid = round2(cert.netCertified - body.amount);
    await app.db.transaction(async (tx) => {
      await tx
        .update(paymentCertificates)
        .set({
          status: "paid",
          paidAmount: round2(body.amount),
          paidAt: `${body.paidOn}T00:00:00Z`,
          paymentReference: body.reference ?? null,
        })
        .where(and(eq(paymentCertificates.id, certId), eq(paymentCertificates.status, "issued")));
      await tx
        .update(valuations)
        .set({ status: "paid", paidAt: `${body.paidOn}T00:00:00Z`, updatedAt: now })
        .where(and(eq(valuations.id, cert.valuationId), eq(valuations.status, "certified")));
    });
    await ledger(
      req,
      "state_change",
      "payment_certificate",
      certId,
      {
        from: "issued",
        to: "paid",
        amount: round2(body.amount),
        certified: cert.netCertified,
        shortPaid: shortPaid > 0.005 ? shortPaid : 0,
        paidOn: body.paidOn,
        reference: body.reference ?? null,
      },
      cert.projectId,
      true,
    );
    const updated = await app.db
      .select()
      .from(paymentCertificates)
      .where(eq(paymentCertificates.id, certId))
      .limit(1);
    return { ...updated[0], shortPaid: shortPaid > 0.005 ? shortPaid : 0 };
  });

  /* ---------------------------------------------------------------- */
  /* Retention (#254)                                                  */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/retention", { preHandler: readGate }, async (req) => {
    const projectBoqs = await app.db
      .select()
      .from(boqs)
      .where(and(eq(boqs.companyId, req.companyId!), eq(boqs.projectId, req.projectId!)));
    const today = todayISO();
    const out = [];
    for (const boq of projectBoqs) {
      const latest = await app.db
        .select()
        .from(valuations)
        .where(eq(valuations.boqId, boq.id))
        .orderBy(desc(valuations.number))
        .limit(1);
      const val = latest[0];
      if (!val) continue;
      const released = await releasedFor(app.db, boq.id);
      let contract: typeof contracts.$inferSelect | undefined;
      if (boq.contractId) {
        const c = await app.db
          .select()
          .from(contracts)
          .where(eq(contracts.id, boq.contractId))
          .limit(1);
        contract = c[0];
      }
      const schedule = retentionSchedule({
        retentionHeld: val.retentionHeld,
        takingOverDate: contract?.takingOverDate ?? null,
        defectsPeriodMonths: contract?.defectsPeriodMonths ?? null,
        releaseAtTakingOver: contract?.retentionReleaseAtTakingOver ?? 0.5,
        asOf: today,
        alreadyReleased: released,
      });
      out.push({
        boqId: boq.id,
        boqName: boq.name,
        currency: boq.currency,
        contractId: boq.contractId,
        retentionPercent: val.retentionPercent,
        retentionCap: val.retentionCap,
        retentionHeld: val.retentionHeld,
        released,
        ...schedule,
      });
    }
    const releases = await app.db
      .select()
      .from(retentionReleases)
      .where(
        and(
          eq(retentionReleases.companyId, req.companyId!),
          eq(retentionReleases.projectId, req.projectId!),
        ),
      )
      .orderBy(desc(retentionReleases.releasedOn));
    return { items: out, releases };
  });

  app.post("/projects/:projectId/retention/releases", { preHandler: adminGate }, async (req, reply) => {
    const body = releaseSchema.parse(req.body);
    if (body.boqId) {
      const b = await app.db
        .select({ id: boqs.id, currency: boqs.currency })
        .from(boqs)
        .where(
          and(
            eq(boqs.id, body.boqId),
            eq(boqs.companyId, req.companyId!),
            eq(boqs.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!b[0]) throw badRequest("boqId does not reference a BoQ on this project");
    }
    if (body.kind === "bond_substitution" && !body.bondReference) {
      throw badRequest("Substituting retention with a bond requires the bond reference");
    }
    const currency = body.boqId
      ? (
          await app.db
            .select({ currency: boqs.currency })
            .from(boqs)
            .where(eq(boqs.id, body.boqId))
            .limit(1)
        )[0]?.currency ?? "USD"
      : "USD";
    const id = newId("rrel");
    await app.db.transaction(async (tx) => {
      await tx.insert(retentionReleases).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        contractId: body.contractId ?? null,
        boqId: body.boqId ?? null,
        kind: body.kind,
        amount: round2(body.amount),
        currency,
        releasedOn: body.releasedOn,
        bondReference: body.bondReference ?? null,
        reason: body.reason ?? null,
        approvedBy: req.user!.id,
      });
      if (body.boqId) {
        const drafts = await tx
          .select({ id: valuations.id })
          .from(valuations)
          .where(and(eq(valuations.boqId, body.boqId), eq(valuations.status, "draft")));
        for (const d of drafts) await recomputeValuation(tx, d.id);
      }
    });
    await ledger(
      req,
      "create",
      "retention_release",
      id,
      { kind: body.kind, amount: body.amount, boqId: body.boqId ?? null },
      req.projectId!,
      true,
    );
    const created = await app.db
      .select()
      .from(retentionReleases)
      .where(eq(retentionReleases.id, id))
      .limit(1);
    return reply.status(201).send(created[0]);
  });
};
