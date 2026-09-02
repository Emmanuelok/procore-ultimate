import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  boqItems,
  boqs,
  contracts,
  variationBuildUpLines,
  variations,
} from "@constructos/db";
import { VARIATION_BASES, VARIATION_STATUSES, type VariationStatus } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isoDateSchema, requireCommercialLevel, round2, subResourceGate } from "./shared.js";

const variationCreateSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  basis: z.enum(VARIATION_BASES),
  clauseRef: z.string().max(100).nullable().optional(),
  contractId: z.string().nullable().optional(),
  costEstimate: z.number().nullable().optional(),
  boqItemRefs: z.array(z.string().min(1)).max(200).optional(),
  timeImpactDays: z.number().int().nullable().optional(),
  currency: z.string().min(3).max(8).optional(),
});

const variationPatchSchema = variationCreateSchema.partial().extend({
  instructionRef: z.string().max(200).nullable().optional(),
  instructedAt: isoDateSchema.nullable().optional(),
});

const variationListQuery = pageQuerySchema.extend({
  status: z.enum(VARIATION_STATUSES).optional(),
});

const statusSchema = z.object({
  status: z.enum(VARIATION_STATUSES),
  instructionRef: z.string().max(200).optional(),
  instructedAt: isoDateSchema.optional(),
});

const valueSchema = z.object({
  basis: z.enum(VARIATION_BASES),
  agreedValue: z.number().optional(),
  buildUp: z
    .array(
      z.object({
        boqItemId: z.string().min(1).nullable().optional(),
        description: z.string().min(1).max(1000),
        unit: z.string().max(20).nullable().optional(),
        qty: z.number().finite(),
        rate: z.number().finite(),
        /** pro_rata: the factor applied to the parent BQ rate */
        factor: z.number().finite().nullable().optional(),
      }),
    )
    .min(1)
    .max(200)
    .optional(),
});

const PRE_AGREED: VariationStatus[] = ["proposed", "instructed", "valued"];
const TERMINAL: VariationStatus[] = ["agreed", "rejected", "withdrawn"];

/** Variation register with valuation-basis discipline (spec #168-171). */
export const variationRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("commercial", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("commercial", "standard"),
  ];
  const subRead = subResourceGate(app, "read");
  const subWrite = subResourceGate(app, "standard");

  async function fetchVariation(variationId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(variations)
      .where(and(eq(variations.id, variationId), eq(variations.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Variation not found");
    return rows[0];
  }

  /**
   * The project's commercial currency, taken from its bills. Where the project
   * genuinely has more than one, the first issued bill wins and the register
   * still buckets by currency — nothing is added across them.
   */
  async function projectCurrency(companyId: string, projectId: string): Promise<string> {
    const rows = await app.db
      .select({ currency: boqs.currency })
      .from(boqs)
      .where(and(eq(boqs.companyId, companyId), eq(boqs.projectId, projectId)))
      .orderBy(asc(boqs.createdAt))
      .limit(1);
    return rows[0]?.currency ?? "USD";
  }

  /** BQ items referenced by a variation must belong to a BoQ on its project. */
  async function fetchProjectItems(itemIds: string[], companyId: string, projectId: string) {
    if (itemIds.length === 0) return new Map<string, typeof boqItems.$inferSelect>();
    const rows = await app.db
      .select({ item: boqItems })
      .from(boqItems)
      .innerJoin(boqs, eq(boqs.id, boqItems.boqId))
      .where(
        and(
          inArray(boqItems.id, itemIds),
          eq(boqs.companyId, companyId),
          eq(boqs.projectId, projectId),
        ),
      );
    const byId = new Map(rows.map((r) => [r.item.id, r.item]));
    for (const id of itemIds) {
      if (!byId.has(id)) throw badRequest(`BQ item ${id} not found on this project`);
    }
    return byId;
  }

  async function ledger(
    req: { companyId?: string; user?: { id: string } },
    action: "create" | "update" | "state_change",
    variationId: string,
    payload: unknown,
    storePayload = false,
  ) {
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action,
      objectType: "variation",
      objectId: variationId,
      payload,
      storePayload,
    });
  }

  app.post("/projects/:projectId/variations", { preHandler: standardGate }, async (req, reply) => {
    const body = variationCreateSchema.parse(req.body);
    // A variation carries its own currency so the register can be bucketed
    // rather than summed blindly; it comes from the contract when linked,
    // else from the BQ items it cites, else the caller states it.
    let currency = body.currency ?? null;
    if (body.contractId) {
      const c = await app.db
        .select({ id: contracts.id, currency: contracts.currency })
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
      if (currency && currency !== c[0].currency) {
        throw badRequest(
          `The variation currency (${currency}) must match the contract currency (${c[0].currency})`,
        );
      }
      currency = c[0].currency;
    }
    await fetchProjectItems(body.boqItemRefs ?? [], req.companyId!, req.projectId!);
    if (!currency) currency = await projectCurrency(req.companyId!, req.projectId!);

    const number = await nextRecordNumber(app.db, req.projectId!, "variation");
    const id = newId("var");
    await app.db.insert(variations).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      contractId: body.contractId ?? null,
      number,
      title: body.title,
      description: body.description ?? null,
      status: "proposed",
      basis: body.basis,
      currency,
      clauseRef: body.clauseRef ?? null,
      costEstimate: body.costEstimate ?? null,
      timeImpactDays: body.timeImpactDays ?? null,
      boqItemRefs: body.boqItemRefs ?? [],
      createdBy: req.user!.id,
    });
    await ledger(req, "create", id, {
      number,
      title: body.title,
      basis: body.basis,
      currency,
    });
    return reply.status(201).send(await fetchVariation(id, req.companyId!));
  });

  app.get("/projects/:projectId/variations", { preHandler: readGate }, async (req) => {
    const q = variationListQuery.parse(req.query);
    const scope = and(
      eq(variations.companyId, req.companyId!),
      eq(variations.projectId, req.projectId!),
    );
    const where = q.status ? and(scope, eq(variations.status, q.status)) : scope;
    const [totalRow] = await app.db.select({ n: count() }).from(variations).where(where);
    const items = await app.db
      .select()
      .from(variations)
      .where(where)
      .orderBy(desc(variations.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));

    // register-wide value position, independent of the page/status filter,
    // bucketed by currency — two currencies are two numbers, never a sum.
    const all = await app.db
      .select({
        status: variations.status,
        currency: variations.currency,
        agreedValue: variations.agreedValue,
        costEstimate: variations.costEstimate,
      })
      .from(variations)
      .where(scope);
    const byCurrency = new Map<string, { agreed: number; pending: number }>();
    for (const v of all) {
      const bucket = byCurrency.get(v.currency) ?? { agreed: 0, pending: 0 };
      if (v.status === "agreed") bucket.agreed += v.agreedValue ?? 0;
      else if ((PRE_AGREED as string[]).includes(v.status)) {
        bucket.pending += v.agreedValue ?? v.costEstimate ?? 0;
      }
      byCurrency.set(v.currency, bucket);
    }
    const currencies = [...byCurrency.entries()].map(([currency, b]) => ({
      currency,
      agreed: round2(b.agreed),
      pending: round2(b.pending),
    }));
    const only = currencies.length === 1 ? currencies[0] : null;
    return {
      ...paginate(items, Number(totalRow?.n ?? 0), q),
      byCurrency: currencies,
      // flat totals only where there is one currency to total (#178)
      totals: only
        ? { agreed: only.agreed, pending: only.pending, currency: only.currency }
        : { agreed: null, pending: null, currency: null },
    };
  });

  app.get("/variations/:variationId", { preHandler: subRead }, async (req, reply) => {
    const { variationId } = req.params as { variationId: string };
    const variation = await fetchVariation(variationId, req.companyId!);
    await requireCommercialLevel(app, req, reply, variation.projectId, "read");
    const buildUp = await app.db
      .select()
      .from(variationBuildUpLines)
      .where(eq(variationBuildUpLines.variationId, variationId))
      .orderBy(asc(variationBuildUpLines.sequence));
    return { ...variation, buildUp };
  });

  app.patch("/variations/:variationId", { preHandler: subWrite }, async (req, reply) => {
    const { variationId } = req.params as { variationId: string };
    const body = variationPatchSchema.parse(req.body);
    const variation = await fetchVariation(variationId, req.companyId!);
    await requireCommercialLevel(app, req, reply, variation.projectId, "standard");
    if ((TERMINAL as string[]).includes(variation.status)) {
      throw badRequest(`A ${variation.status} variation can no longer be edited`);
    }
    if (body.contractId) {
      const c = await app.db
        .select({ id: contracts.id })
        .from(contracts)
        .where(
          and(
            eq(contracts.id, body.contractId),
            eq(contracts.companyId, req.companyId!),
            eq(contracts.projectId, variation.projectId),
          ),
        )
        .limit(1);
      if (!c[0]) throw badRequest("contractId does not reference a contract on this project");
    }
    if (body.boqItemRefs) {
      await fetchProjectItems(body.boqItemRefs, req.companyId!, variation.projectId);
    }
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) set[k] = v;
    }
    await app.db.update(variations).set(set).where(eq(variations.id, variationId));
    await ledger(req, "update", variationId, { changed: Object.keys(body) });
    return fetchVariation(variationId, req.companyId!);
  });

  /**
   * Lifecycle: proposed → instructed → valued → agreed;
   * rejected / withdrawn are reachable from any pre-agreed state.
   */
  app.post("/variations/:variationId/status", { preHandler: subWrite }, async (req, reply) => {
    const { variationId } = req.params as { variationId: string };
    const body = statusSchema.parse(req.body);
    const variation = await fetchVariation(variationId, req.companyId!);
    await requireCommercialLevel(app, req, reply, variation.projectId, "standard");
    const from = variation.status as VariationStatus;
    const to = body.status;
    if (to === from) throw badRequest(`Variation is already ${to}`);

    const set: Record<string, unknown> = {
      status: to,
      updatedAt: new Date().toISOString(),
    };
    switch (to) {
      case "instructed": {
        if (from !== "proposed") throw badRequest("Only a proposed variation can be instructed");
        const instructionRef = body.instructionRef ?? variation.instructionRef;
        const instructedAt = body.instructedAt ?? variation.instructedAt;
        if (!instructionRef || !instructedAt) {
          throw badRequest("Instructing a variation requires instructionRef and instructedAt");
        }
        set["instructionRef"] = instructionRef;
        set["instructedAt"] = instructedAt;
        break;
      }
      case "valued": {
        if (from !== "instructed") throw badRequest("Only an instructed variation can be valued");
        if (variation.agreedValue == null && variation.costEstimate == null) {
          throw badRequest("Valuing a variation requires agreedValue or costEstimate");
        }
        break;
      }
      case "agreed": {
        if (from !== "valued") throw badRequest("Only a valued variation can be agreed");
        // Agreeing an unvalued variation used to drop its estimate out of the
        // forecast entirely: the pending bucket stops counting it and the
        // agreed bucket adds `agreedValue ?? 0`.
        if (variation.agreedValue == null) {
          throw badRequest(
            "Value the variation first — an agreed variation with no agreed value would fall out of the forecast.",
          );
        }
        break;
      }
      case "rejected":
      case "withdrawn": {
        if (!(PRE_AGREED as string[]).includes(from)) {
          throw badRequest(`A ${from} variation cannot be ${to}`);
        }
        break;
      }
      default:
        throw badRequest(`Cannot transition a variation back to ${to}`);
    }
    await app.db.update(variations).set(set).where(eq(variations.id, variationId));
    await ledger(req, "state_change", variationId, { from, to });
    return fetchVariation(variationId, req.companyId!);
  });

  /**
   * Value the variation (#168-171): bq_rates demands the exact BQ item rate
   * (±0.01), pro_rata derives from BQ items with a factor, star_rate/daywork
   * are fair-valuation bases. The build-up is written to the ledger as the
   * rate-derivation audit trail (#171).
   */
  app.post("/variations/:variationId/value", { preHandler: subWrite }, async (req, reply) => {
    const { variationId } = req.params as { variationId: string };
    const body = valueSchema.parse(req.body);
    const variation = await fetchVariation(variationId, req.companyId!);
    await requireCommercialLevel(app, req, reply, variation.projectId, "standard");
    if ((TERMINAL as string[]).includes(variation.status)) {
      throw badRequest(`A ${variation.status} variation can no longer be valued`);
    }
    if (body.agreedValue == null && !body.buildUp) {
      throw badRequest("Provide agreedValue or buildUp lines");
    }

    const refIds = [
      ...new Set((body.buildUp ?? []).flatMap((l) => (l.boqItemId ? [l.boqItemId] : []))),
    ];
    if (body.basis === "bq_rates" || body.basis === "pro_rata") {
      if (variation.boqItemRefs.length === 0 && refIds.length === 0) {
        throw badRequest(
          `A ${body.basis} valuation requires BQ item references (boqItemRefs or buildUp lines with boqItemId)`,
        );
      }
      if (body.basis === "bq_rates") {
        for (const line of body.buildUp ?? []) {
          if (!line.boqItemId) {
            throw badRequest(
              "Every bq_rates build-up line must reference a BQ item; use star_rate for fair-valuation lines",
            );
          }
        }
      }
      const itemsById = await fetchProjectItems(refIds, req.companyId!, variation.projectId);
      if (body.basis === "bq_rates") {
        for (const line of body.buildUp ?? []) {
          const item = itemsById.get(line.boqItemId!);
          if (!item) continue; // fetchProjectItems already 400s on unknown ids
          if (item.rate == null || Math.abs(line.rate - item.rate) > 0.01) {
            throw badRequest(
              `Rate ${line.rate} differs from BQ rate ${item.rate ?? "(none)"} on item ${item.code}; use a star_rate (fair valuation) basis instead`,
            );
          }
        }
      }
    }

    const computed = body.buildUp
      ? round2(body.buildUp.reduce((s, l) => s + l.qty * l.rate, 0))
      : null;
    const agreedValue = round2(body.agreedValue ?? computed ?? 0);
    const mergedRefs = [...new Set([...variation.boqItemRefs, ...refIds])];
    const advance = variation.status === "instructed";
    await app.db.transaction(async (tx) => {
      await tx
        .update(variations)
        .set({
          basis: body.basis,
          agreedValue,
          boqItemRefs: mergedRefs,
          ...(advance ? { status: "valued" } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(variations.id, variationId));
      // The derivation is persisted as rows as well as ledgered (#171): a
      // star rate a quantity surveyor has to argue for should be queryable,
      // not archaeology in a hash chain.
      if (body.buildUp) {
        await tx
          .delete(variationBuildUpLines)
          .where(eq(variationBuildUpLines.variationId, variationId));
        let sequence = 0;
        for (const line of body.buildUp) {
          await tx.insert(variationBuildUpLines).values({
            id: newId("vbl"),
            companyId: req.companyId!,
            variationId,
            sequence,
            boqItemId: line.boqItemId ?? null,
            description: line.description,
            unit: line.unit ?? null,
            qty: line.qty,
            rate: line.rate,
            amount: round2(line.qty * line.rate),
            basis: line.boqItemId ? body.basis : body.basis === "bq_rates" ? "star_rate" : body.basis,
            factor: line.factor ?? null,
          });
          sequence += 1;
        }
      }
    });
    await ledger(
      req,
      "update",
      variationId,
      { basis: body.basis, agreedValue, buildUp: body.buildUp ?? null },
      true, // persist the rate derivation audit trail (#171)
    );
    if (advance) {
      await ledger(req, "state_change", variationId, { from: "instructed", to: "valued" });
    }
    return fetchVariation(variationId, req.companyId!);
  });
};
