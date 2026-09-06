/**
 * Group structure, consolidation and in-country value — spec Vol II Domain K
 * (#600-615) and the multi-entity half of the jurisdiction brief.
 *
 * WHAT IS HERE
 *
 *  - Reporting entities (#600-603): the legal entities a programme is
 *    actually delivered through, each with a FUNCTIONAL currency (the
 *    currency of the primary economic environment it operates in — IAS 21
 *    para 9, not the currency its invoices happen to be written in), a
 *    presentation currency, an ownership share and, where the economy is
 *    hyperinflationary, the general price index series IAS 29 restatement
 *    needs. Entities are linked to projects with a share, because a JV
 *    partner's 40% of a project is not the same fact as the project.
 *
 *  - Consolidation runs (#604-606): translate every entity's position into
 *    one presentation currency, at the closing or average rate, restating
 *    hyperinflationary entities first. An entity with no rate on file is
 *    reported UNPRICED with the reason — never converted at a guess, and
 *    never dropped silently. The difference between the closing-rate and
 *    average-rate totals is the translation reserve exposure.
 *
 *  - ICV certificates (#612-615): the certificate register the Gulf and
 *    Nigerian local-content regimes actually run on, with expiry obligations
 *    and a scheduled expiry sweep.
 *
 *  - Computed local-content readings (#612-613): a local-spend or headcount
 *    percentage derived from the invoice and worker registers, with the
 *    source records recorded as the reading's basis, so the figure a
 *    regulator sees can be traced to the transactions behind it. Manual
 *    readings stay available for ICV scores, which the platform records
 *    rather than computes.
 *
 * WHAT IS DELIBERATELY NOT HERE: statutory accounts. This is a translation
 * and disclosure surface over amounts the caller supplies per entity; it is
 * not a general ledger, and it says so on every run.
 */

import type { FastifyInstance } from "fastify";
import { and, asc, count, desc, eq, inArray, isNull, lte, ne } from "drizzle-orm";
import { z } from "zod";
import {
  consolidationRuns,
  entityProjectLinks,
  fxRates,
  icvCertificates,
  invoices,
  localContentReadings,
  localContentTargets,
  obligations,
  reportingEntities,
  vendors,
  workers,
} from "@constructos/db";
import {
  ENTITY_ROLES,
  ICV_CERTIFICATE_STATUSES,
  TRANSLATION_METHODS,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isoDateSchema, todayISO } from "../field/dates.js";
import {
  buildRateLookup,
  normalizeCurrency,
  round2,
  type RateLookup,
  type RateQuote,
} from "./fx.js";
import { consolidate, type ConsolidationEntity } from "./consolidation.js";
import { LOCAL_CONTENT_METRIC_RULES, localContentRule } from "./reference.js";
import {
  SPEND_STATUSES,
  computeLocalHeadcount,
  computeLocalSpend,
  type ComputedReading,
  type SpendRow,
  type WorkerRow,
} from "./localcontent.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const currencyCode = z
  .string()
  .trim()
  .length(3, "Expected a 3-letter currency code")
  .transform((c) => c.toUpperCase());

const priceIndexPoint = z.object({
  /** an ISO date or YYYY-MM; compared as a string, so keep the shape stable */
  period: z.string().trim().min(4).max(10),
  index: z.number().finite().positive(),
});

const entityCreateSchema = z.object({
  name: z.string().trim().min(1).max(300),
  code: z.string().trim().max(60).nullable().optional(),
  role: z.enum(ENTITY_ROLES).optional(),
  country: z.string().trim().min(1).max(120),
  functionalCurrency: currencyCode,
  presentationCurrency: currencyCode,
  hyperinflationary: z.boolean().optional(),
  priceIndex: z.array(priceIndexPoint).max(400).optional(),
  parentEntityId: z.string().min(1).nullable().optional(),
  ownershipPercent: z.number().finite().min(0).max(100).optional(),
  entityGraphId: z.string().min(1).nullable().optional(),
  taxIdentifier: z.string().trim().max(120).nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
});

const entityPatchSchema = entityCreateSchema.partial().extend({
  active: z.boolean().optional(),
});

const entityListQuery = pageQuerySchema.extend({
  role: z.enum(ENTITY_ROLES).optional(),
  active: z.enum(["true", "false"]).optional(),
});

const linkSchema = z.object({
  entityId: z.string().min(1),
  sharePercent: z.number().finite().min(0).max(100).optional(),
  role: z.string().trim().max(120).nullable().optional(),
});

const consolidationSchema = z.object({
  asOf: isoDateSchema.optional(),
  presentationCurrency: currencyCode,
  method: z.enum(TRANSLATION_METHODS).optional(),
  projectId: z.string().min(1).nullable().optional(),
  /** the amount each entity brings, in ITS OWN functional currency */
  amounts: z
    .array(
      z.object({
        entityId: z.string().min(1),
        amount: z.number().finite(),
        /** the period the amount was struck in, for the IAS 29 restatement */
        amountPeriod: z.string().trim().min(4).max(10).nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
  notes: z.string().max(20000).nullable().optional(),
});

const icvCreateSchema = z.object({
  targetId: z.string().min(1).nullable().optional(),
  entityName: z.string().trim().min(1).max(300),
  vendorId: z.string().min(1).nullable().optional(),
  jurisdiction: z.string().trim().min(1).max(120),
  issuer: z.string().trim().min(1).max(200),
  certificateNumber: z.string().trim().min(1).max(120),
  score: z.number().finite().min(0).max(1000).nullable().optional(),
  scoreUnit: z.string().trim().max(20).optional(),
  issuedAt: isoDateSchema,
  expiresAt: isoDateSchema.nullable().optional(),
  fileIds: z.array(z.string().min(1)).max(100).optional(),
  notes: z.string().max(20000).nullable().optional(),
});

const icvListQuery = pageQuerySchema.extend({
  status: z.enum(ICV_CERTIFICATE_STATUSES).optional(),
});

const icvStatusSchema = z.object({
  status: z.enum(["withdrawn", "superseded"]),
  supersededById: z.string().min(1).nullable().optional(),
  reason: z.string().max(10000).nullable().optional(),
});

const targetPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  targetValue: z.number().finite().min(0).optional(),
  unit: z.string().trim().max(20).optional(),
  periodStart: isoDateSchema.nullable().optional(),
  periodEnd: isoDateSchema.nullable().optional(),
});

const computeSchema = z.object({
  readingDate: isoDateSchema.optional(),
  periodStart: isoDateSchema.nullable().optional(),
  periodEnd: isoDateSchema.nullable().optional(),
  /** false previews the derivation without writing a reading */
  commit: z.boolean().optional(),
});

const supersedeSchema = z.object({
  readingDate: isoDateSchema,
  value: z.number().finite(),
  basis: z.string().max(10000),
  reason: z.string().max(10000),
});

/** ICV certificates warn this far ahead of expiry via an obligation. */
const ICV_OBLIGATION_WARN_DAYS = 60;

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export function registerGroupRoutes(app: FastifyInstance): void {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("jurisdiction", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("jurisdiction", "standard"),
  ];
  const companyGate = [app.authenticate, app.requireCompany];
  const companyWriteGate = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin", "member"]),
  ];

  async function fetchEntity(entityId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(reportingEntities)
      .where(
        and(eq(reportingEntities.id, entityId), eq(reportingEntities.companyId, companyId)),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Reporting entity not found");
    return rows[0];
  }

  async function fetchCertificate(certId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(icvCertificates)
      .where(
        and(
          eq(icvCertificates.id, certId),
          eq(icvCertificates.companyId, companyId),
          eq(icvCertificates.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("ICV certificate not found");
    return rows[0];
  }

  async function fetchTarget(targetId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(localContentTargets)
      .where(
        and(
          eq(localContentTargets.id, targetId),
          eq(localContentTargets.companyId, companyId),
          eq(localContentTargets.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Local content target not found");
    return rows[0];
  }

  /** Rate lookup for consolidation: never a contractual quote. */
  async function loadGroupLookup(
    companyId: string,
    codes: string[],
    asOf: string,
    source?: string,
  ): Promise<RateLookup> {
    const unique = [...new Set(codes.map(normalizeCurrency))];
    if (unique.length === 0) return buildRateLookup([]);
    const filters = [
      eq(fxRates.companyId, companyId),
      lte(fxRates.rateDate, asOf),
      inArray(fxRates.fromCurrency, unique),
      inArray(fxRates.toCurrency, unique),
      ne(fxRates.source, "contractual"),
    ];
    if (source) filters.push(eq(fxRates.source, source));
    const rows = await app.db
      .select()
      .from(fxRates)
      .where(and(...filters))
      .orderBy(asc(fxRates.rateDate), asc(fxRates.createdAt));
    const quotes: RateQuote[] = rows.map((r) => ({
      fromCurrency: r.fromCurrency,
      toCurrency: r.toCurrency,
      rate: r.rate,
      rateDate: r.rateDate,
      source: r.source,
    }));
    return buildRateLookup(quotes, { sourcePriority: ["manual", "market", "central_bank"] });
  }

  /* ================================================================ */
  /* Reporting entities (#600-603) — company-scoped                    */
  /* ================================================================ */

  app.post("/reporting-entities", { preHandler: companyWriteGate }, async (req, reply) => {
    const body = entityCreateSchema.parse(req.body);
    const dup = await app.db
      .select({ id: reportingEntities.id })
      .from(reportingEntities)
      .where(
        and(
          eq(reportingEntities.companyId, req.companyId!),
          eq(reportingEntities.name, body.name),
        ),
      )
      .limit(1);
    if (dup[0]) throw conflict(`A reporting entity named "${body.name}" already exists`);
    if (body.parentEntityId) await fetchEntity(body.parentEntityId, req.companyId!);
    if (body.hyperinflationary && (body.priceIndex ?? []).length === 0) {
      throw badRequest(
        "A hyperinflationary entity needs a general price index series: IAS 29 requires the " +
          "amount to be restated before translation, and there is no honest way to restate " +
          "without the index.",
      );
    }
    const id = newId("rent");
    await app.db.insert(reportingEntities).values({
      id,
      companyId: req.companyId!,
      name: body.name,
      code: body.code ?? null,
      role: body.role ?? "subsidiary",
      country: body.country,
      functionalCurrency: body.functionalCurrency,
      presentationCurrency: body.presentationCurrency,
      hyperinflationary: body.hyperinflationary ? 1 : 0,
      priceIndex: body.priceIndex ?? [],
      parentEntityId: body.parentEntityId ?? null,
      ownershipPercent: body.ownershipPercent ?? 100,
      entityGraphId: body.entityGraphId ?? null,
      taxIdentifier: body.taxIdentifier ?? null,
      notes: body.notes ?? null,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "reporting_entity",
      objectId: id,
      payload: {
        name: body.name,
        role: body.role ?? "subsidiary",
        country: body.country,
        functionalCurrency: body.functionalCurrency,
        presentationCurrency: body.presentationCurrency,
        ownershipPercent: body.ownershipPercent ?? 100,
        hyperinflationary: Boolean(body.hyperinflationary),
      },
      storePayload: true,
    });
    return reply.status(201).send(await fetchEntity(id, req.companyId!));
  });

  app.get("/reporting-entities", { preHandler: companyGate }, async (req) => {
    const q = entityListQuery.parse(req.query);
    const clauses = [eq(reportingEntities.companyId, req.companyId!)];
    if (q.role) clauses.push(eq(reportingEntities.role, q.role));
    if (q.active) clauses.push(eq(reportingEntities.active, q.active === "true" ? 1 : 0));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(reportingEntities).where(where);
    const rows = await app.db
      .select()
      .from(reportingEntities)
      .where(where)
      .orderBy(asc(reportingEntities.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const ids = rows.map((r) => r.id);
    const links = ids.length
      ? await app.db
          .select({ entityId: entityProjectLinks.entityId, n: count() })
          .from(entityProjectLinks)
          .where(
            and(
              eq(entityProjectLinks.companyId, req.companyId!),
              inArray(entityProjectLinks.entityId, ids),
            ),
          )
          .groupBy(entityProjectLinks.entityId)
      : [];
    const byEntity = new Map(links.map((l) => [l.entityId, Number(l.n)]));
    return paginate(
      rows.map((r) => ({
        ...r,
        hyperinflationaryBool: r.hyperinflationary === 1,
        activeBool: r.active === 1,
        projectCount: byEntity.get(r.id) ?? 0,
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.get("/reporting-entities/:entityId", { preHandler: companyGate }, async (req) => {
    const { entityId } = req.params as { entityId: string };
    const entity = await fetchEntity(entityId, req.companyId!);
    const links = await app.db
      .select()
      .from(entityProjectLinks)
      .where(
        and(
          eq(entityProjectLinks.companyId, req.companyId!),
          eq(entityProjectLinks.entityId, entityId),
        ),
      );
    const children = await app.db
      .select({ id: reportingEntities.id, name: reportingEntities.name })
      .from(reportingEntities)
      .where(
        and(
          eq(reportingEntities.companyId, req.companyId!),
          eq(reportingEntities.parentEntityId, entityId),
        ),
      );
    return {
      ...entity,
      hyperinflationaryBool: entity.hyperinflationary === 1,
      activeBool: entity.active === 1,
      projects: links,
      children,
    };
  });

  app.patch("/reporting-entities/:entityId", { preHandler: companyWriteGate }, async (req) => {
    const { entityId } = req.params as { entityId: string };
    const body = entityPatchSchema.parse(req.body);
    const entity = await fetchEntity(entityId, req.companyId!);
    if (body.parentEntityId) {
      if (body.parentEntityId === entityId) throw badRequest("An entity cannot be its own parent");
      await fetchEntity(body.parentEntityId, req.companyId!);
    }
    const hyper = body.hyperinflationary ?? entity.hyperinflationary === 1;
    const index = body.priceIndex ?? (entity.priceIndex as unknown[]);
    if (hyper && index.length === 0) {
      throw badRequest("A hyperinflationary entity needs a general price index series (IAS 29)");
    }
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const key of [
      "name",
      "code",
      "role",
      "country",
      "functionalCurrency",
      "presentationCurrency",
      "parentEntityId",
      "ownershipPercent",
      "entityGraphId",
      "taxIdentifier",
      "notes",
      "priceIndex",
    ] as const) {
      if (body[key] !== undefined) {
        patch[key] = body[key];
        before[key] = (entity as Record<string, unknown>)[key];
        after[key] = body[key];
      }
    }
    if (body.hyperinflationary !== undefined) {
      patch["hyperinflationary"] = body.hyperinflationary ? 1 : 0;
      before["hyperinflationary"] = entity.hyperinflationary === 1;
      after["hyperinflationary"] = body.hyperinflationary;
    }
    if (body.active !== undefined) {
      patch["active"] = body.active ? 1 : 0;
      before["active"] = entity.active === 1;
      after["active"] = body.active;
    }
    await app.db
      .update(reportingEntities)
      .set(patch)
      .where(eq(reportingEntities.id, entityId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "reporting_entity",
      objectId: entityId,
      // before/after, not a list of key names: a functional-currency change
      // silently re-bases every consolidation the entity appears in
      payload: { before, after },
      storePayload: true,
    });
    return fetchEntity(entityId, req.companyId!);
  });

  app.post(
    "/projects/:projectId/reporting-entities",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = linkSchema.parse(req.body);
      const entity = await fetchEntity(body.entityId, req.companyId!);
      const dup = await app.db
        .select({ id: entityProjectLinks.id })
        .from(entityProjectLinks)
        .where(
          and(
            eq(entityProjectLinks.entityId, body.entityId),
            eq(entityProjectLinks.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (dup[0]) throw conflict(`${entity.name} is already linked to this project`);
      const id = newId("epl");
      await app.db.insert(entityProjectLinks).values({
        id,
        companyId: req.companyId!,
        entityId: body.entityId,
        projectId: req.projectId!,
        sharePercent: body.sharePercent ?? 100,
        role: body.role ?? null,
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "entity_project_link",
        objectId: id,
        projectId: req.projectId!,
        payload: {
          entityId: body.entityId,
          entityName: entity.name,
          sharePercent: body.sharePercent ?? 100,
          role: body.role ?? null,
        },
        storePayload: true,
      });
      return reply.status(201).send({ id, entityId: body.entityId, projectId: req.projectId! });
    },
  );

  app.get("/projects/:projectId/reporting-entities", { preHandler: readGate }, async (req) => {
    const rows = await app.db
      .select({
        link: entityProjectLinks,
        entity: reportingEntities,
      })
      .from(entityProjectLinks)
      .innerJoin(reportingEntities, eq(reportingEntities.id, entityProjectLinks.entityId))
      .where(
        and(
          eq(entityProjectLinks.companyId, req.companyId!),
          eq(entityProjectLinks.projectId, req.projectId!),
        ),
      )
      .orderBy(asc(reportingEntities.name));
    const items = rows.map((r) => ({
      ...r.link,
      entity: {
        ...r.entity,
        hyperinflationaryBool: r.entity.hyperinflationary === 1,
      },
    }));
    const shareSum = round2(items.reduce((s, i) => s + i.sharePercent, 0));
    return {
      items,
      total: items.length,
      shareSum,
      // a JV whose shares do not total 100% is a data problem worth seeing
      shareBalanced: Math.abs(shareSum - 100) < 0.01 || items.length === 0,
      functionalCurrencies: [...new Set(items.map((i) => i.entity.functionalCurrency))].sort(),
    };
  });

  app.delete(
    "/projects/:projectId/reporting-entities/:linkId",
    { preHandler: standardGate },
    async (req, reply) => {
      const { linkId } = req.params as { linkId: string };
      const rows = await app.db
        .select()
        .from(entityProjectLinks)
        .where(
          and(
            eq(entityProjectLinks.id, linkId),
            eq(entityProjectLinks.companyId, req.companyId!),
            eq(entityProjectLinks.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!rows[0]) throw notFound("Entity link not found");
      await app.db.delete(entityProjectLinks).where(eq(entityProjectLinks.id, linkId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "entity_project_link",
        objectId: linkId,
        projectId: req.projectId!,
        payload: { entityId: rows[0].entityId },
        storePayload: true,
      });
      return reply.status(204).send();
    },
  );

  /* ================================================================ */
  /* Consolidation (#604-606)                                          */
  /* ================================================================ */

  app.post("/consolidations", { preHandler: companyWriteGate }, async (req, reply) => {
    const body = consolidationSchema.parse(req.body);
    const asOf = body.asOf ?? todayISO();
    const ids = [...new Set(body.amounts.map((a) => a.entityId))];
    const rows = await app.db
      .select()
      .from(reportingEntities)
      .where(
        and(
          eq(reportingEntities.companyId, req.companyId!),
          inArray(reportingEntities.id, ids),
        ),
      );
    if (rows.length !== ids.length) {
      throw badRequest("Every entityId must reference a reporting entity in this company");
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    const entities: ConsolidationEntity[] = body.amounts.map((a) => {
      const e = byId.get(a.entityId)!;
      return {
        id: e.id,
        name: e.name,
        role: e.role,
        country: e.country,
        functionalCurrency: e.functionalCurrency,
        ownershipPercent: e.ownershipPercent,
        hyperinflationary: e.hyperinflationary === 1,
        priceIndex: (e.priceIndex as { period: string; index: number }[]) ?? [],
        amount: a.amount,
        amountPeriod: a.amountPeriod ?? null,
      };
    });
    const codes = [body.presentationCurrency, ...entities.map((e) => e.functionalCurrency)];
    const lookup = await loadGroupLookup(req.companyId!, codes, asOf);
    // The alternative basis is what makes the translation reserve visible:
    // the same positions at the OTHER rate basis. Where the register carries
    // no separate average-rate quotes it simply comes back unusable, and the
    // reserve is reported as null rather than as zero.
    const method = body.method ?? "closing_rate";
    const altSource = method === "average_rate" ? "central_bank" : "market";
    const altLookup = await loadGroupLookup(req.companyId!, codes, asOf, altSource);
    const result = consolidate({
      asOf,
      presentationCurrency: body.presentationCurrency,
      method,
      entities,
      lookup,
      alternativeLookup: altLookup,
    });

    const id = newId("cons");
    await app.db.insert(consolidationRuns).values({
      id,
      companyId: req.companyId!,
      projectId: body.projectId ?? null,
      asOf,
      presentationCurrency: body.presentationCurrency,
      method,
      lines: result.lines,
      totals: result.totals as unknown as Record<string, unknown>,
      unpriced: result.unpriced,
      notes: body.notes ?? null,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "consolidation_run",
      objectId: id,
      projectId: body.projectId ?? null,
      payload: {
        asOf,
        presentationCurrency: body.presentationCurrency,
        method,
        entities: entities.length,
        translated: result.totals.translated,
        unpriced: result.unpriced.length,
        presentationTotal: result.totals.presentationTotal,
      },
      storePayload: true,
    });
    return reply.status(201).send({ id, ...result, notes: body.notes ?? null });
  });

  app.get("/consolidations", { preHandler: companyGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = eq(consolidationRuns.companyId, req.companyId!);
    const [totalRow] = await app.db.select({ n: count() }).from(consolidationRuns).where(where);
    const rows = await app.db
      .select()
      .from(consolidationRuns)
      .where(where)
      .orderBy(desc(consolidationRuns.asOf), desc(consolidationRuns.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, Number(totalRow?.n ?? 0), q);
  });

  app.get("/consolidations/:runId", { preHandler: companyGate }, async (req) => {
    const { runId } = req.params as { runId: string };
    const rows = await app.db
      .select()
      .from(consolidationRuns)
      .where(
        and(eq(consolidationRuns.id, runId), eq(consolidationRuns.companyId, req.companyId!)),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Consolidation run not found");
    return rows[0];
  });

  /* ================================================================ */
  /* ICV certificate register (#612-615)                               */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/icv-certificates",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = icvCreateSchema.parse(req.body);
      if (body.expiresAt && body.expiresAt < body.issuedAt) {
        throw badRequest("expiresAt cannot precede issuedAt");
      }
      if (body.targetId) await fetchTarget(body.targetId, req.companyId!, req.projectId!);
      if (body.vendorId) {
        const v = await app.db
          .select({ id: vendors.id })
          .from(vendors)
          .where(and(eq(vendors.id, body.vendorId), eq(vendors.companyId, req.companyId!)))
          .limit(1);
        if (!v[0]) throw badRequest("vendorId does not belong to this company");
      }
      const dup = await app.db
        .select({ id: icvCertificates.id })
        .from(icvCertificates)
        .where(
          and(
            eq(icvCertificates.projectId, req.projectId!),
            eq(icvCertificates.issuer, body.issuer),
            eq(icvCertificates.certificateNumber, body.certificateNumber),
          ),
        )
        .limit(1);
      if (dup[0]) {
        throw conflict(
          `Certificate ${body.certificateNumber} from ${body.issuer} is already on this project`,
        );
      }
      const id = newId("icv");
      const created = await app.db.transaction(async (tx) => {
        let obligationId: string | null = null;
        if (body.expiresAt) {
          obligationId = newId("obl");
          await tx.insert(obligations).values({
            id: obligationId,
            companyId: req.companyId!,
            projectId: req.projectId!,
            sourceClause: `${body.issuer} ICV certificate ${body.certificateNumber} — ${body.entityName}`,
            trigger: `Certificate issued ${body.issuedAt}, valid to ${body.expiresAt}`,
            deadline: `${body.expiresAt}T23:59:59Z`,
            warnDaysBefore: ICV_OBLIGATION_WARN_DAYS,
            evidenceRequirement: "Renewed ICV certificate from an accredited certifier",
            status: "open",
            createdBy: req.user!.id,
          });
        }
        await tx.insert(icvCertificates).values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          targetId: body.targetId ?? null,
          entityName: body.entityName,
          vendorId: body.vendorId ?? null,
          jurisdiction: body.jurisdiction,
          issuer: body.issuer,
          certificateNumber: body.certificateNumber,
          score: body.score ?? null,
          scoreUnit: body.scoreUnit ?? "%",
          issuedAt: body.issuedAt,
          expiresAt: body.expiresAt ?? null,
          obligationId,
          fileIds: body.fileIds ?? [],
          notes: body.notes ?? null,
          createdBy: req.user!.id,
        });
        await appendLedger(tx, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "create",
          objectType: "icv_certificate",
          objectId: id,
          projectId: req.projectId!,
          payload: {
            entityName: body.entityName,
            issuer: body.issuer,
            certificateNumber: body.certificateNumber,
            jurisdiction: body.jurisdiction,
            score: body.score ?? null,
            issuedAt: body.issuedAt,
            expiresAt: body.expiresAt ?? null,
            obligationId,
          },
          storePayload: true,
        });
        return id;
      });
      return reply
        .status(201)
        .send(await fetchCertificate(created, req.companyId!, req.projectId!));
    },
  );

  app.get("/projects/:projectId/icv-certificates", { preHandler: readGate }, async (req) => {
    const q = icvListQuery.parse(req.query);
    const clauses = [
      eq(icvCertificates.companyId, req.companyId!),
      eq(icvCertificates.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(icvCertificates.status, q.status));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(icvCertificates).where(where);
    const rows = await app.db
      .select()
      .from(icvCertificates)
      .where(where)
      .orderBy(asc(icvCertificates.expiresAt), desc(icvCertificates.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const today = todayISO();
    return paginate(
      rows.map((r) => ({
        ...r,
        daysToExpiry: r.expiresAt
          ? Math.round(
              (Date.parse(`${r.expiresAt}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
                86_400_000,
            )
          : null,
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.post(
    "/projects/:projectId/icv-certificates/:certId/status",
    { preHandler: standardGate },
    async (req) => {
      const { certId } = req.params as { certId: string };
      const body = icvStatusSchema.parse(req.body);
      const cert = await fetchCertificate(certId, req.companyId!, req.projectId!);
      if (cert.status === body.status) throw badRequest(`Certificate is already ${cert.status}`);
      if (body.supersededById) {
        await fetchCertificate(body.supersededById, req.companyId!, req.projectId!);
      }
      if (body.status === "superseded" && !body.supersededById) {
        throw badRequest("supersededById is required when superseding a certificate");
      }
      await app.db
        .update(icvCertificates)
        .set({
          status: body.status,
          supersededById: body.supersededById ?? null,
          notes: body.reason ?? cert.notes,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(icvCertificates.id, certId));
      if (cert.obligationId) {
        await app.db
          .update(obligations)
          .set({ status: body.status === "superseded" ? "satisfied" : "waived" })
          .where(and(eq(obligations.id, cert.obligationId), eq(obligations.status, "open")));
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "icv_certificate",
        objectId: certId,
        projectId: req.projectId!,
        payload: {
          from: cert.status,
          to: body.status,
          supersededById: body.supersededById ?? null,
          reason: body.reason ?? null,
        },
        storePayload: true,
      });
      return fetchCertificate(certId, req.companyId!, req.projectId!);
    },
  );

  /* ================================================================ */
  /* Local content — targets, computation, corrections (#612-613)      */
  /* ================================================================ */

  app.get("/local-content/metrics", { preHandler: companyGate }, async () => ({
    metrics: LOCAL_CONTENT_METRIC_RULES,
  }));

  app.patch(
    "/projects/:projectId/local-content-targets/:targetId",
    { preHandler: standardGate },
    async (req) => {
      const { targetId } = req.params as { targetId: string };
      const body = targetPatchSchema.parse(req.body);
      const target = await fetchTarget(targetId, req.companyId!, req.projectId!);
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const key of ["name", "targetValue", "unit", "periodStart", "periodEnd"] as const) {
        if (body[key] !== undefined) {
          patch[key] = body[key];
          before[key] = (target as Record<string, unknown>)[key];
          after[key] = body[key];
        }
      }
      await app.db
        .update(localContentTargets)
        .set(patch)
        .where(eq(localContentTargets.id, targetId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "local_content_target",
        objectId: targetId,
        projectId: req.projectId!,
        payload: { before, after },
        storePayload: true,
      });
      return fetchTarget(targetId, req.companyId!, req.projectId!);
    },
  );

  app.delete(
    "/projects/:projectId/local-content-targets/:targetId",
    { preHandler: standardGate },
    async (req, reply) => {
      const { targetId } = req.params as { targetId: string };
      const target = await fetchTarget(targetId, req.companyId!, req.projectId!);
      const [readingCount] = await app.db
        .select({ n: count() })
        .from(localContentReadings)
        .where(eq(localContentReadings.targetId, targetId));
      if (Number(readingCount?.n ?? 0) > 0) {
        throw badRequest(
          `"${target.name}" carries ${readingCount?.n} reading(s). A target with a measurement ` +
            `history is a record of what was promised and reported: it is not deletable. ` +
            `Close the period instead by setting periodEnd.`,
        );
      }
      await app.db.delete(localContentTargets).where(eq(localContentTargets.id, targetId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "local_content_target",
        objectId: targetId,
        projectId: req.projectId!,
        payload: { name: target.name, metric: target.metric, targetValue: target.targetValue },
        storePayload: true,
      });
      return reply.status(204).send();
    },
  );

  /**
   * Derive a reading from the source registers rather than trusting a keyed
   * figure (#612-613). The derivation is recorded on the reading — the
   * invoice ids, the worker counts, the currency — so the number a regulator
   * is shown can be walked back to the transactions behind it. An
   * uncomputable metric returns the REASON, never a zero.
   */
  app.post(
    "/projects/:projectId/local-content-targets/:targetId/compute",
    { preHandler: standardGate },
    async (req, reply) => {
      const { targetId } = req.params as { targetId: string };
      const body = computeSchema.parse(req.body);
      const target = await fetchTarget(targetId, req.companyId!, req.projectId!);
      const rule = localContentRule(target.metric);
      if (!rule || !rule.computable) {
        throw badRequest(
          `"${target.metric}" is not derivable from platform records` +
            (rule ? `: ${rule.derivation}` : "") +
            `. Record it as a manual reading, or register the certificate that carries it.`,
        );
      }
      const periodStart = body.periodStart ?? target.periodStart;
      const periodEnd = body.periodEnd ?? target.periodEnd;
      const readingDate = body.readingDate ?? todayISO();

      let computed: ComputedReading;
      if (target.metric === "local_spend_percent") {
        const rows = await app.db
          .select({
            invoiceId: invoices.id,
            vendorId: invoices.vendorId,
            vendorName: vendors.name,
            vendorCountry: vendors.country,
            currency: invoices.currency,
            total: invoices.total,
            billingDate: invoices.billingDate,
            paidDate: invoices.paidDate,
          })
          .from(invoices)
          .leftJoin(vendors, eq(vendors.id, invoices.vendorId))
          .where(
            and(
              eq(invoices.companyId, req.companyId!),
              eq(invoices.projectId, req.projectId!),
              inArray(invoices.status, [...SPEND_STATUSES]),
            ),
          );
        const spend: SpendRow[] = rows.map((r) => ({
          invoiceId: r.invoiceId,
          vendorId: r.vendorId,
          vendorName: r.vendorName,
          vendorCountry: r.vendorCountry,
          currency: r.currency,
          amount: r.total,
          date: r.paidDate ?? r.billingDate,
        }));
        computed = computeLocalSpend({
          rows: spend,
          jurisdiction: target.jurisdiction,
          targetValue: target.targetValue,
          periodStart,
          periodEnd,
        });
      } else {
        const rows = await app.db
          .select({
            id: workers.id,
            nationality: workers.nationality,
            status: workers.status,
          })
          .from(workers)
          .where(
            and(eq(workers.companyId, req.companyId!), eq(workers.projectId, req.projectId!)),
          );
        const population: WorkerRow[] = rows.map((w) => ({
          workerId: w.id,
          nationality: w.nationality,
          status: w.status,
        }));
        computed = computeLocalHeadcount({
          workers: population,
          jurisdiction: target.jurisdiction,
          targetValue: target.targetValue,
          metric: target.metric === "national_quota" ? "national_quota" : "local_headcount_percent",
        });
      }

      const preview = {
        targetId,
        metric: target.metric,
        jurisdiction: target.jurisdiction,
        targetValue: target.targetValue,
        readingDate,
        periodStart,
        periodEnd,
        derivation: rule.derivation,
        ...computed,
      };
      if (computed.value === null) {
        // an unknowable is a 200 with the reason, not a 500 and not a zero
        return { ...preview, committed: false };
      }
      if (body.commit === false) return { ...preview, committed: false };

      const id = newId("lcr");
      await app.db.insert(localContentReadings).values({
        id,
        targetId,
        companyId: req.companyId!,
        readingDate,
        value: computed.value,
        compliant: computed.compliant ? 1 : 0,
        basis: computed.basis,
        source: "computed",
        periodStart: periodStart ?? null,
        periodEnd: periodEnd ?? null,
        inputs: computed.inputs,
        recordedBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "local_content_reading",
        objectId: id,
        projectId: req.projectId!,
        payload: {
          targetId,
          readingDate,
          value: computed.value,
          compliant: computed.compliant,
          source: "computed",
          inputs: computed.inputs,
        },
        storePayload: true,
      });
      return reply.status(201).send({ ...preview, id, committed: true });
    },
  );

  /**
   * Correct a reading by SUPERSEDING it. A reported local-content figure is
   * a regulatory statement; editing it in place erases the fact that a
   * different number was once reported, which is the only thing a
   * verification exercise is looking for.
   */
  app.post(
    "/projects/:projectId/local-content-readings/:readingId/supersede",
    { preHandler: standardGate },
    async (req, reply) => {
      const { readingId } = req.params as { readingId: string };
      const body = supersedeSchema.parse(req.body);
      const rows = await app.db
        .select()
        .from(localContentReadings)
        .where(
          and(
            eq(localContentReadings.id, readingId),
            eq(localContentReadings.companyId, req.companyId!),
          ),
        )
        .limit(1);
      const original = rows[0];
      if (!original) throw notFound("Local content reading not found");
      const target = await fetchTarget(original.targetId, req.companyId!, req.projectId!);
      if (original.supersededById) {
        throw conflict("This reading has already been superseded");
      }
      const id = newId("lcr");
      await app.db.transaction(async (tx) => {
        await tx.insert(localContentReadings).values({
          id,
          targetId: original.targetId,
          companyId: req.companyId!,
          readingDate: body.readingDate,
          value: body.value,
          compliant: body.value >= target.targetValue ? 1 : 0,
          basis: `${body.basis} (supersedes the ${original.readingDate} reading of ${original.value}: ${body.reason})`,
          source: original.source,
          periodStart: original.periodStart,
          periodEnd: original.periodEnd,
          inputs: original.inputs,
          supersedesId: original.id,
          recordedBy: req.user!.id,
        });
        await tx
          .update(localContentReadings)
          .set({ supersededById: id })
          .where(eq(localContentReadings.id, original.id));
        await appendLedger(tx, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "local_content_reading",
          objectId: original.id,
          projectId: req.projectId!,
          payload: {
            supersededById: id,
            previousValue: original.value,
            newValue: body.value,
            reason: body.reason,
          },
          storePayload: true,
        });
      });
      const created = await app.db
        .select()
        .from(localContentReadings)
        .where(eq(localContentReadings.id, id))
        .limit(1);
      return reply.status(201).send(created[0]);
    },
  );

  /** Live local-content position: the current (non-superseded) reading per target. */
  app.get(
    "/projects/:projectId/local-content/summary",
    { preHandler: readGate },
    async (req) => {
      const targets = await app.db
        .select()
        .from(localContentTargets)
        .where(
          and(
            eq(localContentTargets.companyId, req.companyId!),
            eq(localContentTargets.projectId, req.projectId!),
          ),
        )
        .orderBy(asc(localContentTargets.name));
      const ids = targets.map((t) => t.id);
      const readings = ids.length
        ? await app.db
            .select()
            .from(localContentReadings)
            .where(
              and(
                inArray(localContentReadings.targetId, ids),
                isNull(localContentReadings.supersededById),
              ),
            )
            .orderBy(asc(localContentReadings.readingDate), asc(localContentReadings.createdAt))
        : [];
      const latest = new Map<string, (typeof readings)[number]>();
      for (const r of readings) latest.set(r.targetId, r);
      const items = targets.map((t) => {
        const reading = latest.get(t.id) ?? null;
        const rule = localContentRule(t.metric);
        return {
          ...t,
          computable: rule?.computable ?? false,
          derivation: rule?.derivation ?? null,
          latestReading: reading,
          value: reading?.value ?? null,
          source: reading?.source ?? null,
          compliant: reading ? reading.compliant === 1 : null,
          gap: reading ? round2(t.targetValue - reading.value) : null,
          // an unmeasured target is unknown, not compliant
          unavailableReason: reading ? null : "No reading has been recorded against this target",
        };
      });
      const measured = items.filter((i) => i.value !== null);
      return {
        items,
        total: items.length,
        measured: measured.length,
        breaching: measured.filter((i) => i.compliant === false).length,
        compliancePercent:
          measured.length > 0
            ? round2((measured.filter((i) => i.compliant).length / measured.length) * 100)
            : null,
      };
    },
  );

  /** Health inputs for WP-INTEL (contract 3.5). */
  app.get(
    "/projects/:projectId/jurisdiction/health-inputs",
    { preHandler: readGate },
    async (req) => {
      const today = todayISO();
      const reasons: string[] = [];
      const certs = await app.db
        .select({ status: icvCertificates.status, expiresAt: icvCertificates.expiresAt })
        .from(icvCertificates)
        .where(
          and(
            eq(icvCertificates.companyId, req.companyId!),
            eq(icvCertificates.projectId, req.projectId!),
          ),
        );
      const expiredCerts = certs.filter((c) => c.status === "expired").length;
      if (expiredCerts > 0) reasons.push(`${expiredCerts} ICV certificate(s) expired`);

      const targets = await app.db
        .select({ id: localContentTargets.id, targetValue: localContentTargets.targetValue })
        .from(localContentTargets)
        .where(
          and(
            eq(localContentTargets.companyId, req.companyId!),
            eq(localContentTargets.projectId, req.projectId!),
          ),
        );
      let breaching = 0;
      let measured = 0;
      for (const t of targets) {
        const latest = await app.db
          .select({ compliant: localContentReadings.compliant })
          .from(localContentReadings)
          .where(
            and(
              eq(localContentReadings.targetId, t.id),
              isNull(localContentReadings.supersededById),
            ),
          )
          .orderBy(
            desc(localContentReadings.readingDate),
            desc(localContentReadings.createdAt),
          )
          .limit(1);
        if (!latest[0]) continue;
        measured += 1;
        if (latest[0].compliant === 0) breaching += 1;
      }
      if (breaching > 0) reasons.push(`${breaching} local-content target(s) below their floor`);
      if (targets.length > measured) {
        reasons.push(`${targets.length - measured} local-content target(s) never measured`);
      }
      void today;
      return {
        metrics: {
          icvCertificates: certs.length,
          icvExpired: expiredCerts,
          icvExpiring: certs.filter((c) => c.status === "expiring").length,
          localContentTargets: targets.length,
          localContentMeasured: measured,
          localContentBreaching: breaching,
          localContentCompliancePercent:
            measured > 0 ? round2(((measured - breaching) / measured) * 100) : null,
        },
        reasons,
      };
    },
  );
}
