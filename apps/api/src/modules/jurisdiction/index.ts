import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, lt, lte } from "drizzle-orm";
import { z } from "zod";
import {
  contracts,
  currencyConfigs,
  fxRates,
  localContentReadings,
  localContentTargets,
  obligations,
  permits,
  scheduleTasks,
  signals,
} from "@constructos/db";
import { FX_RATE_SOURCES, PERMIT_KINDS, PERMIT_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { addDaysISO, isoDateSchema, todayISO } from "../field/dates.js";
import {
  buildRateLookup,
  convert,
  normalizeCurrency,
  round2,
  splitPayment,
  validatePortions,
  type Portion,
  type RateLookup,
  type RateQuote,
} from "./fx.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const currencyCode = z
  .string()
  .trim()
  .length(3, "Expected a 3-letter currency code")
  .transform((c) => c.toUpperCase());

const portionSchema = z.object({
  currency: z.string().trim().min(1).max(8),
  proportionPercent: z.number().finite().min(0).max(100),
  baseRate: z.number().positive(),
});

const currencyConfigCreateSchema = z.object({
  contractId: z.string().min(1).nullable().optional(),
  baseCurrency: currencyCode,
  baseDate: isoDateSchema,
  portions: z.array(portionSchema).min(1).max(20),
  rateSource: z.enum(FX_RATE_SOURCES).optional(),
  notes: z.string().max(20000).nullable().optional(),
});

const currencyConfigPatchSchema = z.object({
  contractId: z.string().min(1).nullable().optional(),
  baseCurrency: currencyCode.optional(),
  baseDate: isoDateSchema.optional(),
  portions: z.array(portionSchema).min(1).max(20).optional(),
  rateSource: z.enum(FX_RATE_SOURCES).optional(),
  notes: z.string().max(20000).nullable().optional(),
});

const fxRateCreateSchema = z.object({
  fromCurrency: currencyCode,
  toCurrency: currencyCode,
  rate: z.number().positive(),
  rateDate: isoDateSchema,
  source: z.enum(FX_RATE_SOURCES),
  sourceReference: z.string().max(500).nullable().optional(),
});

const fxRateListQuery = pageQuerySchema.extend({
  from: currencyCode.optional(),
  to: currencyCode.optional(),
  from_date: isoDateSchema.optional(),
  to_date: isoDateSchema.optional(),
  source: z.enum(FX_RATE_SOURCES).optional(),
});

const latestRateQuery = z.object({
  from: currencyCode,
  to: currencyCode,
  asOf: isoDateSchema.optional(),
});

const convertSchema = z.object({
  amount: z.number().finite(),
  fromCurrency: currencyCode,
  toCurrency: currencyCode,
  asOf: isoDateSchema.optional(),
  source: z.enum(FX_RATE_SOURCES).optional(),
});

const splitSchema = z.object({
  amount: z.number().positive(),
  asOf: isoDateSchema.optional(),
});

const exposureQuery = z.object({ asOf: isoDateSchema.optional() });

const permitConditionInput = z.object({
  text: z.string().min(1).max(10000),
  dueDate: isoDateSchema.nullable().optional(),
});

const permitCreateSchema = z.object({
  kind: z.enum(PERMIT_KINDS),
  title: z.string().min(1).max(300),
  authority: z.string().min(1).max(300),
  jurisdiction: z.string().max(200).nullable().optional(),
  reference: z.string().max(200).nullable().optional(),
  appliedAt: isoDateSchema.nullable().optional(),
  expectedDays: z.number().int().positive().max(3650).nullable().optional(),
  blockingTaskIds: z.array(z.string().min(1)).max(500).optional(),
  conditions: z.array(permitConditionInput).max(200).optional(),
  ownerId: z.string().min(1).nullable().optional(),
  fileIds: z.array(z.string().min(1)).max(200).optional(),
});

const permitPatchSchema = z.object({
  kind: z.enum(PERMIT_KINDS).optional(),
  title: z.string().min(1).max(300).optional(),
  authority: z.string().min(1).max(300).optional(),
  jurisdiction: z.string().max(200).nullable().optional(),
  reference: z.string().max(200).nullable().optional(),
  appliedAt: isoDateSchema.nullable().optional(),
  expectedDays: z.number().int().positive().max(3650).nullable().optional(),
  blockingTaskIds: z.array(z.string().min(1)).max(500).optional(),
  ownerId: z.string().min(1).nullable().optional(),
  fileIds: z.array(z.string().min(1)).max(200).optional(),
});

const permitListQuery = pageQuerySchema.extend({
  kind: z.enum(PERMIT_KINDS).optional(),
  status: z.enum(PERMIT_STATUSES).optional(),
  // an explicit ?overdue=false must NOT read as truthy, which is exactly
  // what z.coerce.boolean() would do to the string "false"
  overdue: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .optional()
    .transform((v) => v === true || v === "true" || v === "1"),
});

const permitStatusSchema = z.object({
  status: z.enum(PERMIT_STATUSES),
  grantedAt: isoDateSchema.nullable().optional(),
  expiresAt: isoDateSchema.nullable().optional(),
  reference: z.string().max(200).nullable().optional(),
});

const closeConditionSchema = z.object({ note: z.string().max(10000).nullable().optional() });

const scheduleRiskQuery = z.object({
  days: z.coerce.number().int().min(1).max(3650).default(90),
});

const LOCAL_CONTENT_METRICS = [
  "local_spend_percent",
  "local_headcount_percent",
  "icv_score",
  "national_quota",
] as const;

const localContentCreateSchema = z.object({
  name: z.string().min(1).max(300),
  jurisdiction: z.string().min(1).max(200),
  metric: z.enum(LOCAL_CONTENT_METRICS),
  targetValue: z.number().finite(),
  unit: z.string().max(50).optional(),
  periodStart: isoDateSchema.nullable().optional(),
  periodEnd: isoDateSchema.nullable().optional(),
});

const localContentReadingSchema = z.object({
  readingDate: isoDateSchema,
  value: z.number().finite(),
  basis: z.string().max(10000).nullable().optional(),
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

interface PermitCondition {
  id: string;
  text: string;
  dueDate: string | null;
  closed: boolean;
  closedAt: string | null;
  closedBy: string | null;
  note: string | null;
}

/** Whole days from today (UTC) to an ISO date; negative = already past. */
function daysUntil(isoDate: string): number {
  return Math.round(
    (Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${todayISO()}T00:00:00Z`)) / 86_400_000,
  );
}

/** Statuses in which a permit is still awaiting the authority's decision. */
const AWAITING_STATUSES = ["applied", "in_review"] as const;

/**
 * Multi-currency & multi-jurisdiction operation — spec Vol III Tier 4,
 * Vol II Domain K / M19 (#585-591, #593-599, #608, #612-615 subset).
 *
 * Three mechanics that only bite on internationally financed work:
 *
 *  - **Contractual currency proportions** (#593-595). A contract fixes the
 *    share of each payment settled in each currency and the rate applied to
 *    that share at the base date (FIDIC 14.15). Payments split accordingly
 *    (#596) and the drift between the fixed rate and today's market is the
 *    FX gain/loss the project is carrying (#599).
 *  - **Rate provenance** (#597). Every rate is dated, attributed to a source
 *    and immutable once recorded, because a rate-of-exchange dispute (#598)
 *    is won on the audit trail, not the number.
 *  - **Permits and consents** (#585-590, #608). A permit that blocks a
 *    schedule task is a programme risk with a name and an authority
 *    attached (#591); a determination that slips its statutory period is an
 *    assurance breach, not a chase-up email.
 *
 * Local content and ICV obligations (#612-615) close the loop: a target with
 * a jurisdiction, a series of dated readings, and a signal the moment a
 * reading falls below the contractual floor.
 */
export const jurisdictionModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("jurisdiction", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("jurisdiction", "standard"),
  ];
  const companyGate = [app.authenticate, app.requireCompany];

  /* ---------------------------------------------------------------- */
  /* Fetch helpers                                                     */
  /* ---------------------------------------------------------------- */

  async function fetchConfig(configId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(currencyConfigs)
      .where(
        and(
          eq(currencyConfigs.id, configId),
          eq(currencyConfigs.companyId, companyId),
          eq(currencyConfigs.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Currency configuration not found");
    return rows[0];
  }

  async function fetchPermit(permitId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(permits)
      .where(
        and(
          eq(permits.id, permitId),
          eq(permits.companyId, companyId),
          eq(permits.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Permit not found");
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

  /** A referenced contract must live in THIS project. */
  async function validateContract(
    companyId: string,
    projectId: string,
    contractId: string,
  ): Promise<void> {
    const rows = await app.db
      .select({ id: contracts.id })
      .from(contracts)
      .where(
        and(
          eq(contracts.id, contractId),
          eq(contracts.companyId, companyId),
          eq(contracts.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw badRequest("contractId must reference a contract in this project");
  }

  /** Every blocking task id must be a schedule task in THIS project. */
  async function validateTasks(projectId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const unique = [...new Set(ids)];
    const rows = await app.db
      .select({ id: scheduleTasks.id })
      .from(scheduleTasks)
      .where(and(inArray(scheduleTasks.id, unique), eq(scheduleTasks.projectId, projectId)));
    if (rows.length !== unique.length) {
      throw badRequest("blockingTaskIds must reference schedule tasks in this project");
    }
  }

  function parsePortions(config: { portions: unknown[] }): Portion[] {
    return config.portions as Portion[];
  }

  function parseConditions(permit: { conditions: unknown[] }): PermitCondition[] {
    return permit.conditions as PermitCondition[];
  }

  /* ---------------------------------------------------------------- */
  /* Rate loading (#597)                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Load every quote among `codes` dated on/before `asOf`, oldest first,
   * so `buildRateLookup` keeps the latest per ordered pair — i.e. the rate
   * "as at" the as-of date, never a future one. Restricting to the handful
   * of currencies actually in play keeps this a small, indexed read.
   */
  async function loadLookup(
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
    return buildRateLookup(quotes);
  }

  /* ---------------------------------------------------------------- */
  /* Permit sweeps (lazy, idempotent)                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Permit ids that already carry a signal from `detector`, so a sweep with
   * no state flip of its own (the blocks-programme detector) still fires
   * exactly once per permit.
   */
  async function alreadySignalled(
    companyId: string,
    projectId: string,
    detector: string,
  ): Promise<Set<string>> {
    const rows = await app.db
      .select({ refs: signals.evidenceRefs })
      .from(signals)
      .where(
        and(
          eq(signals.companyId, companyId),
          eq(signals.projectId, projectId),
          eq(signals.detector, detector),
        ),
      );
    const ids = new Set<string>();
    for (const row of rows) {
      const refs = row.refs as { permitId?: string } | null;
      if (refs?.permitId) ids.add(refs.permitId);
    }
    return ids;
  }

  /**
   * Three lazy sweeps, run on permit list reads (the same pattern as the
   * payments deemed-liability and finance overdue-condition sweeps). Each is
   * idempotent: (a) and (b) are guarded on a state flip that removes the row
   * from the next sweep, (c) on the presence of its own signal.
   *
   *  (a) A permit still awaiting determination past its statutory due date
   *      breaches its obligation and raises a MEDIUM signal — the authority
   *      is late, which is a claim event before it is an escalation.
   *  (b) A granted permit whose expiry has passed flips to `expired` and
   *      raises a HIGH signal — work proceeding under a lapsed consent is
   *      an enforcement exposure.
   *  (c) An ungranted permit whose blocked tasks start within 30 days
   *      raises a HIGH signal — the consent-to-programme dependency (#591).
   */
  async function sweepPermits(
    companyId: string,
    projectId: string,
    actorId: string,
  ): Promise<void> {
    const today = todayISO();

    /* (a) determination overdue */
    const awaiting = await app.db
      .select()
      .from(permits)
      .where(
        and(
          eq(permits.companyId, companyId),
          eq(permits.projectId, projectId),
          inArray(permits.status, [...AWAITING_STATUSES]),
          isNotNull(permits.dueAt),
          lt(permits.dueAt, today),
          isNotNull(permits.obligationId),
        ),
      );
    for (const permit of awaiting) {
      if (!permit.obligationId) continue;
      const [obl] = await app.db
        .select({ id: obligations.id, status: obligations.status })
        .from(obligations)
        .where(eq(obligations.id, permit.obligationId))
        .limit(1);
      if (!obl || obl.status !== "open") continue; // already swept
      await app.db
        .update(obligations)
        .set({ status: "breached" })
        .where(and(eq(obligations.id, obl.id), eq(obligations.status, "open")));
      await app.db.insert(signals).values({
        id: newId("sig"),
        companyId,
        projectId,
        detector: "permit_determination_overdue",
        severity: "medium",
        confidence: 1,
        title: `Permit determination overdue — ${permit.authority}: ${permit.title}`,
        explanation:
          `Permit #${permit.number} (${permit.kind}) was submitted to ${permit.authority} on ` +
          `${permit.appliedAt} with an expected determination period of ${permit.expectedDays} days, ` +
          `expiring ${permit.dueAt}. No determination has been recorded. Authority delay beyond the ` +
          `statutory period is normally an employer-risk event: record the chase correspondence now, ` +
          `because the entitlement argument later rests on it.`,
        evidenceRefs: { permitId: permit.id, dueAt: permit.dueAt },
      });
      await appendLedger(app.db, {
        companyId,
        actorId,
        action: "state_change",
        objectType: "permit",
        objectId: permit.id,
        payload: { determination: "overdue", dueAt: permit.dueAt, obligationId: obl.id },
      });
    }

    /* (b) granted but expired */
    const lapsed = await app.db
      .select()
      .from(permits)
      .where(
        and(
          eq(permits.companyId, companyId),
          eq(permits.projectId, projectId),
          eq(permits.status, "granted"),
          isNotNull(permits.expiresAt),
          lt(permits.expiresAt, today),
        ),
      );
    for (const permit of lapsed) {
      await app.db
        .update(permits)
        .set({ status: "expired", updatedAt: new Date().toISOString() })
        .where(and(eq(permits.id, permit.id), eq(permits.status, "granted")));
      await app.db.insert(signals).values({
        id: newId("sig"),
        companyId,
        projectId,
        detector: "permit_expired",
        severity: "high",
        confidence: 1,
        title: `Permit expired — ${permit.authority}: ${permit.title}`,
        explanation:
          `Permit #${permit.number} (${permit.kind}), granted ${permit.grantedAt} by ` +
          `${permit.authority}, expired on ${permit.expiresAt}. Any activity still relying on this ` +
          `consent is proceeding without authority and is exposed to a stop notice, prosecution or ` +
          `insurance avoidance. Renew or suspend the dependent work.`,
        evidenceRefs: { permitId: permit.id, expiresAt: permit.expiresAt },
      });
      await appendLedger(app.db, {
        companyId,
        actorId,
        action: "state_change",
        objectType: "permit",
        objectId: permit.id,
        payload: { from: "granted", to: "expired", expiresAt: permit.expiresAt },
      });
    }

    /* (c) ungranted permits blocking imminent work (#591) */
    const horizon = addDaysISO(today, 30);
    const ungranted = await app.db
      .select()
      .from(permits)
      .where(
        and(
          eq(permits.companyId, companyId),
          eq(permits.projectId, projectId),
          inArray(permits.status, ["not_started", "applied", "in_review", "refused", "expired"]),
        ),
      );
    const blocking = ungranted.filter((p) => (p.blockingTaskIds ?? []).length > 0);
    if (blocking.length > 0) {
      const seen = await alreadySignalled(companyId, projectId, "permit_blocks_programme");
      const candidates = blocking.filter((p) => !seen.has(p.id));
      if (candidates.length > 0) {
        const taskIds = [...new Set(candidates.flatMap((p) => p.blockingTaskIds ?? []))];
        const tasks = await app.db
          .select()
          .from(scheduleTasks)
          .where(
            and(inArray(scheduleTasks.id, taskIds), eq(scheduleTasks.projectId, projectId)),
          );
        const taskById = new Map(tasks.map((t) => [t.id, t]));
        for (const permit of candidates) {
          const imminent = (permit.blockingTaskIds ?? [])
            .map((id) => taskById.get(id))
            .filter((t): t is (typeof tasks)[number] => Boolean(t))
            .map((t) => ({ task: t, start: t.startDate ?? t.constraintDate }))
            .filter((x): x is { task: (typeof tasks)[number]; start: string } =>
              Boolean(x.start && x.start <= horizon),
            )
            .sort((a, b) => a.start.localeCompare(b.start));
          const soonest = imminent[0];
          if (!soonest) continue;
          const days = daysUntil(soonest.start);
          await app.db.insert(signals).values({
            id: newId("sig"),
            companyId,
            projectId,
            detector: "permit_blocks_programme",
            severity: "high",
            confidence: 0.9,
            title: `Consent not in place for work starting in ${days} day${days === 1 ? "" : "s"} — ${permit.title}`,
            explanation:
              `Permit #${permit.number} (${permit.kind}, ${permit.authority}) is ${permit.status} and ` +
              `blocks ${imminent.length} schedule task${imminent.length === 1 ? "" : "s"}, the earliest ` +
              `being "${soonest.task.name}" starting ${soonest.start}. A consent-to-programme dependency ` +
              `inside 30 days with no grant on file is a delay already in motion: either the start moves ` +
              `or the work proceeds unlawfully.`,
            evidenceRefs: {
              permitId: permit.id,
              taskIds: imminent.map((x) => x.task.id),
              earliestStart: soonest.start,
            },
          });
          await appendLedger(app.db, {
            companyId,
            actorId,
            action: "state_change",
            objectType: "permit",
            objectId: permit.id,
            payload: { blocksProgramme: true, earliestStart: soonest.start, status: permit.status },
          });
        }
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Currency configurations (#593-595)                                */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/currency-configs",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = currencyConfigCreateSchema.parse(req.body);
      if (body.contractId) {
        await validateContract(req.companyId!, req.projectId!, body.contractId);
      }
      const validation = validatePortions(body.portions);
      if (!validation.ok) throw badRequest(validation.message ?? "Invalid currency portions");
      const id = newId("cfg");
      await app.db.insert(currencyConfigs).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        contractId: body.contractId ?? null,
        baseCurrency: body.baseCurrency,
        baseDate: body.baseDate,
        portions: validation.portions,
        rateSource: body.rateSource ?? "contractual",
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "currency_config",
        objectId: id,
        payload: {
          contractId: body.contractId ?? null,
          baseCurrency: body.baseCurrency,
          baseDate: body.baseDate,
          portions: validation.portions,
        },
        storePayload: true,
      });
      const created = await fetchConfig(id, req.companyId!, req.projectId!);
      return reply.status(201).send(created);
    },
  );

  app.get("/projects/:projectId/currency-configs", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = and(
      eq(currencyConfigs.companyId, req.companyId!),
      eq(currencyConfigs.projectId, req.projectId!),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(currencyConfigs).where(where);
    const rows = await app.db
      .select()
      .from(currencyConfigs)
      .where(where)
      .orderBy(desc(currencyConfigs.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, Number(totalRow?.n ?? 0), q);
  });

  app.get(
    "/projects/:projectId/currency-configs/:configId",
    { preHandler: readGate },
    async (req) => {
      const { configId } = req.params as { configId: string };
      return fetchConfig(configId, req.companyId!, req.projectId!);
    },
  );

  app.patch(
    "/projects/:projectId/currency-configs/:configId",
    { preHandler: standardGate },
    async (req) => {
      const { configId } = req.params as { configId: string };
      const body = currencyConfigPatchSchema.parse(req.body);
      await fetchConfig(configId, req.companyId!, req.projectId!);
      if (body.contractId) {
        await validateContract(req.companyId!, req.projectId!, body.contractId);
      }
      const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      if (body.contractId !== undefined) patch["contractId"] = body.contractId;
      if (body.baseCurrency !== undefined) patch["baseCurrency"] = body.baseCurrency;
      if (body.baseDate !== undefined) patch["baseDate"] = body.baseDate;
      if (body.rateSource !== undefined) patch["rateSource"] = body.rateSource;
      if (body.notes !== undefined) patch["notes"] = body.notes;
      if (body.portions !== undefined) {
        // the whole split is revalidated — a partial update must still
        // leave a contract whose currency proportions exhaust the payment
        const validation = validatePortions(body.portions);
        if (!validation.ok) throw badRequest(validation.message ?? "Invalid currency portions");
        patch["portions"] = validation.portions;
      }
      await app.db.update(currencyConfigs).set(patch).where(eq(currencyConfigs.id, configId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "currency_config",
        objectId: configId,
        payload: patch,
        storePayload: true,
      });
      return fetchConfig(configId, req.companyId!, req.projectId!);
    },
  );

  app.delete(
    "/projects/:projectId/currency-configs/:configId",
    { preHandler: standardGate },
    async (req, reply) => {
      const { configId } = req.params as { configId: string };
      await fetchConfig(configId, req.companyId!, req.projectId!);
      await app.db.delete(currencyConfigs).where(eq(currencyConfigs.id, configId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "currency_config",
        objectId: configId,
        payload: null,
      });
      return reply.status(204).send();
    },
  );

  /* ---------------------------------------------------------------- */
  /* FX rate register (#597) — company-scoped reference data           */
  /* ---------------------------------------------------------------- */

  app.post("/fx-rates", { preHandler: companyGate }, async (req, reply) => {
    const body = fxRateCreateSchema.parse(req.body);
    if (body.fromCurrency === body.toCurrency) {
      throw badRequest("fromCurrency and toCurrency must differ");
    }
    const existing = await app.db
      .select({ id: fxRates.id })
      .from(fxRates)
      .where(
        and(
          eq(fxRates.companyId, req.companyId!),
          eq(fxRates.fromCurrency, body.fromCurrency),
          eq(fxRates.toCurrency, body.toCurrency),
          eq(fxRates.rateDate, body.rateDate),
          eq(fxRates.source, body.source),
        ),
      )
      .limit(1);
    if (existing[0]) {
      throw conflict(
        `A ${body.source} rate for ${body.fromCurrency}/${body.toCurrency} on ${body.rateDate} is already on file`,
      );
    }
    const id = newId("fxr");
    await app.db.insert(fxRates).values({
      id,
      companyId: req.companyId!,
      fromCurrency: body.fromCurrency,
      toCurrency: body.toCurrency,
      rate: body.rate,
      rateDate: body.rateDate,
      source: body.source,
      sourceReference: body.sourceReference ?? null,
      recordedBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "fx_rate",
      objectId: id,
      payload: {
        pair: `${body.fromCurrency}/${body.toCurrency}`,
        rate: body.rate,
        rateDate: body.rateDate,
        source: body.source,
        sourceReference: body.sourceReference ?? null,
      },
      storePayload: true,
    });
    const created = (
      await app.db.select().from(fxRates).where(eq(fxRates.id, id)).limit(1)
    )[0];
    return reply.status(201).send(created);
  });

  app.get("/fx-rates", { preHandler: companyGate }, async (req) => {
    const q = fxRateListQuery.parse(req.query);
    const filters = [eq(fxRates.companyId, req.companyId!)];
    if (q.from) filters.push(eq(fxRates.fromCurrency, q.from));
    if (q.to) filters.push(eq(fxRates.toCurrency, q.to));
    if (q.from_date) filters.push(gte(fxRates.rateDate, q.from_date));
    if (q.to_date) filters.push(lte(fxRates.rateDate, q.to_date));
    if (q.source) filters.push(eq(fxRates.source, q.source));
    const where = and(...filters);
    const [totalRow] = await app.db.select({ n: count() }).from(fxRates).where(where);
    const rows = await app.db
      .select()
      .from(fxRates)
      .where(where)
      .orderBy(desc(fxRates.rateDate), desc(fxRates.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, Number(totalRow?.n ?? 0), q);
  });

  /** The rate in force on a date: the most recent quote on/before it. */
  app.get("/fx-rates/latest", { preHandler: companyGate }, async (req) => {
    const q = latestRateQuery.parse(req.query);
    const asOf = q.asOf ?? todayISO();
    const rows = await app.db
      .select()
      .from(fxRates)
      .where(
        and(
          eq(fxRates.companyId, req.companyId!),
          eq(fxRates.fromCurrency, q.from),
          eq(fxRates.toCurrency, q.to),
          lte(fxRates.rateDate, asOf),
        ),
      )
      .orderBy(desc(fxRates.rateDate), desc(fxRates.createdAt))
      .limit(1);
    if (!rows[0]) {
      throw notFound(
        `No ${q.from}/${q.to} rate recorded on or before ${asOf} — record one via POST /fx-rates`,
      );
    }
    return { ...rows[0], asOf };
  });

  /* ---------------------------------------------------------------- */
  /* Conversion and payment splitting (#596, #599)                     */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/fx/convert", { preHandler: readGate }, async (req) => {
    const body = convertSchema.parse(req.body);
    const asOf = body.asOf ?? todayISO();
    // the project's configured base currencies are the candidate pivots
    const configs = await app.db
      .select({ baseCurrency: currencyConfigs.baseCurrency })
      .from(currencyConfigs)
      .where(
        and(
          eq(currencyConfigs.companyId, req.companyId!),
          eq(currencyConfigs.projectId, req.projectId!),
        ),
      );
    const pivots = [...new Set(configs.map((c) => normalizeCurrency(c.baseCurrency)))].filter(
      (c) => c !== body.fromCurrency && c !== body.toCurrency,
    );
    const lookup = await loadLookup(
      req.companyId!,
      [body.fromCurrency, body.toCurrency, ...pivots],
      asOf,
      body.source,
    );
    for (const pivot of [null, ...pivots]) {
      const result = convert(body.amount, body.fromCurrency, body.toCurrency, lookup, pivot);
      if (result) return { ...result, asOf, source: body.source ?? null };
    }
    throw notFound(
      `No rate path from ${body.fromCurrency} to ${body.toCurrency} on or before ${asOf} — ` +
        `record a direct rate, the reciprocal, or both legs through a configured base currency`,
    );
  });

  /**
   * Split one payment across the contractual currency portions (#596) and
   * value each share at market so the FX position is visible on the
   * certificate rather than at year end (#599).
   */
  app.post(
    "/projects/:projectId/currency-configs/:configId/split",
    { preHandler: readGate },
    async (req) => {
      const { configId } = req.params as { configId: string };
      const body = splitSchema.parse(req.body);
      const config = await fetchConfig(configId, req.companyId!, req.projectId!);
      const asOf = body.asOf ?? todayISO();
      const portions = parsePortions(config);
      const lookup = await loadLookup(
        req.companyId!,
        [config.baseCurrency, ...portions.map((p) => p.currency)],
        asOf,
      );
      const result = splitPayment(body.amount, config.baseCurrency, portions, lookup);
      return {
        configId: config.id,
        contractId: config.contractId,
        baseDate: config.baseDate,
        asOf,
        amount: round2(body.amount),
        ...result,
      };
    },
  );

  /**
   * FX gain/loss statement (#599): every currency configuration in the
   * project, its whole contract sum valued at the contractual base-date
   * rates against today's market, and the variance between the two.
   */
  app.get("/projects/:projectId/fx/exposure", { preHandler: readGate }, async (req) => {
    const q = exposureQuery.parse(req.query);
    const asOf = q.asOf ?? todayISO();
    const configs = await app.db
      .select()
      .from(currencyConfigs)
      .where(
        and(
          eq(currencyConfigs.companyId, req.companyId!),
          eq(currencyConfigs.projectId, req.projectId!),
        ),
      )
      .orderBy(asc(currencyConfigs.createdAt));

    const contractIds = configs.map((c) => c.contractId).filter((id): id is string => Boolean(id));
    const contractRows = contractIds.length
      ? await app.db
          .select({
            id: contracts.id,
            name: contracts.name,
            contractSum: contracts.contractSum,
            currency: contracts.currency,
          })
          .from(contracts)
          .where(
            and(inArray(contracts.id, contractIds), eq(contracts.companyId, req.companyId!)),
          )
      : [];
    const contractById = new Map(contractRows.map((c) => [c.id, c]));

    const items = [];
    for (const config of configs) {
      const contract = config.contractId ? contractById.get(config.contractId) : undefined;
      const contractSum = contract?.contractSum ?? null;
      const portions = parsePortions(config);
      const notes: string[] = [];
      if (!config.contractId) {
        notes.push("No contract linked — the configuration cannot be valued against a sum.");
      } else if (contractSum === null) {
        notes.push(
          `Contract "${contract?.name ?? config.contractId}" has no contract sum recorded — ` +
            `the exposure cannot be quantified.`,
        );
      }
      if (contractSum === null) {
        items.push({
          configId: config.id,
          contractId: config.contractId,
          contractName: contract?.name ?? null,
          baseCurrency: config.baseCurrency,
          baseDate: config.baseDate,
          contractSum: null,
          contractualValue: null,
          marketValue: null,
          variance: null,
          variancePercent: null,
          lines: [],
          missingRates: [],
          notes,
        });
        continue;
      }
      const lookup = await loadLookup(
        req.companyId!,
        [config.baseCurrency, ...portions.map((p) => p.currency)],
        asOf,
      );
      const split = splitPayment(contractSum, config.baseCurrency, portions, lookup);
      if (split.note) notes.push(split.note);
      const contractualValue = split.totals.coveredBaseAmount;
      const marketValue = split.totals.coveredBaseEquivalent;
      items.push({
        configId: config.id,
        contractId: config.contractId,
        contractName: contract?.name ?? null,
        baseCurrency: config.baseCurrency,
        baseDate: config.baseDate,
        contractSum: round2(contractSum),
        // both sides are stated in the BASE currency: what the covered
        // portions were meant to cost, vs what buying the same contractual
        // foreign entitlements costs at the as-of market
        contractualValue,
        marketValue,
        variance: split.totals.baseVariance,
        variancePercent:
          contractualValue > 0 ? round2((split.totals.baseVariance / contractualValue) * 100) : null,
        lines: split.lines,
        missingRates: split.totals.missingRates,
        notes,
      });
    }

    // configurations can be struck in different base currencies; a single
    // grand total across them would be meaningless, so totals are grouped
    const byBase = new Map<
      string,
      { baseCurrency: string; configs: number; contractualValue: number; marketValue: number }
    >();
    for (const item of items) {
      if (item.contractualValue === null || item.marketValue === null) continue;
      const bucket = byBase.get(item.baseCurrency) ?? {
        baseCurrency: item.baseCurrency,
        configs: 0,
        contractualValue: 0,
        marketValue: 0,
      };
      bucket.configs += 1;
      bucket.contractualValue += item.contractualValue;
      bucket.marketValue += item.marketValue;
      byBase.set(item.baseCurrency, bucket);
    }
    const totals = [...byBase.values()].map((b) => ({
      baseCurrency: b.baseCurrency,
      configs: b.configs,
      contractualValue: round2(b.contractualValue),
      marketValue: round2(b.marketValue),
      variance: round2(b.marketValue - b.contractualValue),
    }));

    return {
      asOf,
      items,
      totals,
      unpriced: items.filter((i) => i.contractualValue === null).length,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Permits & consents (#585-590, #608, #614)                         */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/permits", { preHandler: standardGate }, async (req, reply) => {
    const body = permitCreateSchema.parse(req.body);
    const blockingTaskIds = body.blockingTaskIds ?? [];
    await validateTasks(req.projectId!, blockingTaskIds);
    const conditions: PermitCondition[] = (body.conditions ?? []).map((c) => ({
      id: newId("pcn"),
      text: c.text,
      dueDate: c.dueDate ?? null,
      closed: false,
      closedAt: null,
      closedBy: null,
      note: null,
    }));
    // the statutory determination clock only starts once an application is in
    const dueAt =
      body.appliedAt && body.expectedDays ? addDaysISO(body.appliedAt, body.expectedDays) : null;
    let obligationId: string | null = null;
    if (dueAt) {
      obligationId = newId("obl");
      await app.db.insert(obligations).values({
        id: obligationId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        sourceClause: `${body.authority} — ${body.title} determination`,
        trigger: `Application submitted ${body.appliedAt}; ${body.expectedDays}-day determination period`,
        deadline: `${dueAt}T23:59:59Z`,
        warnDaysBefore: 7,
        evidenceRequirement: "Written determination (grant, refusal or requisition) from the authority",
        status: "open",
        createdBy: req.user!.id,
      });
    }
    const number = await nextRecordNumber(app.db, req.projectId!, "permit");
    const id = newId("prm");
    await app.db.insert(permits).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      number,
      kind: body.kind,
      title: body.title,
      authority: body.authority,
      jurisdiction: body.jurisdiction ?? null,
      reference: body.reference ?? null,
      appliedAt: body.appliedAt ?? null,
      expectedDays: body.expectedDays ?? null,
      dueAt,
      status: body.appliedAt ? "applied" : "not_started",
      conditions,
      blockingTaskIds,
      obligationId,
      fileIds: body.fileIds ?? [],
      ownerId: body.ownerId ?? null,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "permit",
      objectId: id,
      payload: {
        number,
        kind: body.kind,
        title: body.title,
        authority: body.authority,
        appliedAt: body.appliedAt ?? null,
        dueAt,
        obligationId,
        blockingTaskIds,
        conditions,
      },
      storePayload: true,
    });
    const created = await fetchPermit(id, req.companyId!, req.projectId!);
    return reply.status(201).send({ ...created, ...permitDerived(created) });
  });

  /** View-model fields every permit read carries. */
  function permitDerived(permit: typeof permits.$inferSelect) {
    const conditions = parseConditions(permit);
    return {
      daysToDue: permit.dueAt ? daysUntil(permit.dueAt) : null,
      daysToExpiry: permit.expiresAt ? daysUntil(permit.expiresAt) : null,
      overdue:
        permit.dueAt !== null &&
        (AWAITING_STATUSES as readonly string[]).includes(permit.status) &&
        permit.dueAt < todayISO(),
      openConditions: conditions.filter((c) => !c.closed).length,
      blockingTaskCount: (permit.blockingTaskIds ?? []).length,
    };
  }

  app.get("/projects/:projectId/permits", { preHandler: readGate }, async (req) => {
    const q = permitListQuery.parse(req.query);
    await sweepPermits(req.companyId!, req.projectId!, req.user!.id);
    const filters = [eq(permits.companyId, req.companyId!), eq(permits.projectId, req.projectId!)];
    if (q.kind) filters.push(eq(permits.kind, q.kind));
    if (q.status) filters.push(eq(permits.status, q.status));
    if (q.overdue) {
      filters.push(isNotNull(permits.dueAt));
      filters.push(lt(permits.dueAt, todayISO()));
      filters.push(inArray(permits.status, [...AWAITING_STATUSES]));
    }
    const where = and(...filters);
    const [totalRow] = await app.db.select({ n: count() }).from(permits).where(where);
    const rows = await app.db
      .select()
      .from(permits)
      .where(where)
      .orderBy(desc(permits.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      rows.map((r) => ({ ...r, ...permitDerived(r) })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  /** Consent-to-programme dependency map (#591). */
  app.get("/projects/:projectId/permits/schedule-risk", { preHandler: readGate }, async (req) => {
    const q = scheduleRiskQuery.parse(req.query);
    await sweepPermits(req.companyId!, req.projectId!, req.user!.id);
    const horizon = addDaysISO(todayISO(), q.days);
    const rows = await app.db
      .select()
      .from(permits)
      .where(and(eq(permits.companyId, req.companyId!), eq(permits.projectId, req.projectId!)));
    const withBlocks = rows.filter((p) => (p.blockingTaskIds ?? []).length > 0);
    const taskIds = [...new Set(withBlocks.flatMap((p) => p.blockingTaskIds ?? []))];
    const tasks = taskIds.length
      ? await app.db
          .select()
          .from(scheduleTasks)
          .where(and(inArray(scheduleTasks.id, taskIds), eq(scheduleTasks.projectId, req.projectId!)))
      : [];
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const items = [];
    for (const permit of withBlocks) {
      for (const taskId of permit.blockingTaskIds ?? []) {
        const task = taskById.get(taskId);
        if (!task) continue;
        const start = task.startDate ?? task.constraintDate;
        if (!start || start > horizon) continue;
        items.push({
          permitId: permit.id,
          permitNumber: permit.number,
          permitTitle: permit.title,
          kind: permit.kind,
          authority: permit.authority,
          status: permit.status,
          dueAt: permit.dueAt,
          taskId: task.id,
          taskName: task.name,
          wbsCode: task.wbsCode,
          startDate: start,
          daysUntilStart: daysUntil(start),
          isCritical: task.isCritical === 1,
          // the point of the view: work that cannot lawfully start on time
          blocked: permit.status !== "granted",
        });
      }
    }
    items.sort((a, b) => a.daysUntilStart - b.daysUntilStart);
    const blocked = items.filter((i) => i.blocked);
    return {
      days: q.days,
      horizon,
      items,
      total: items.length,
      summary: {
        blockedTasks: new Set(blocked.map((i) => i.taskId)).size,
        blockingPermits: new Set(blocked.map((i) => i.permitId)).size,
        criticalBlocked: blocked.filter((i) => i.isCritical).length,
        soonestBlockedStart: blocked[0]?.startDate ?? null,
      },
    };
  });

  app.get("/projects/:projectId/permits/:permitId", { preHandler: readGate }, async (req) => {
    const { permitId } = req.params as { permitId: string };
    const permit = await fetchPermit(permitId, req.companyId!, req.projectId!);
    const ids = permit.blockingTaskIds ?? [];
    const tasks = ids.length
      ? await app.db
          .select({
            id: scheduleTasks.id,
            name: scheduleTasks.name,
            wbsCode: scheduleTasks.wbsCode,
            startDate: scheduleTasks.startDate,
            constraintDate: scheduleTasks.constraintDate,
            isCritical: scheduleTasks.isCritical,
          })
          .from(scheduleTasks)
          .where(and(inArray(scheduleTasks.id, ids), eq(scheduleTasks.projectId, req.projectId!)))
      : [];
    const obligation = permit.obligationId
      ? ((
          await app.db
            .select()
            .from(obligations)
            .where(eq(obligations.id, permit.obligationId))
            .limit(1)
        )[0] ?? null)
      : null;
    return {
      ...permit,
      ...permitDerived(permit),
      blockingTasks: tasks.map((t) => ({
        ...t,
        startDate: t.startDate ?? t.constraintDate,
        daysUntilStart: t.startDate ?? t.constraintDate ? daysUntil((t.startDate ?? t.constraintDate)!) : null,
      })),
      obligation,
    };
  });

  app.patch("/projects/:projectId/permits/:permitId", { preHandler: standardGate }, async (req) => {
    const { permitId } = req.params as { permitId: string };
    const body = permitPatchSchema.parse(req.body);
    const permit = await fetchPermit(permitId, req.companyId!, req.projectId!);
    if (body.blockingTaskIds) await validateTasks(req.projectId!, body.blockingTaskIds);
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const field of [
      "kind",
      "title",
      "authority",
      "jurisdiction",
      "reference",
      "ownerId",
    ] as const) {
      if (body[field] !== undefined) patch[field] = body[field];
    }
    if (body.blockingTaskIds !== undefined) patch["blockingTaskIds"] = body.blockingTaskIds;
    if (body.fileIds !== undefined) patch["fileIds"] = body.fileIds;
    if (body.appliedAt !== undefined) patch["appliedAt"] = body.appliedAt;
    if (body.expectedDays !== undefined) patch["expectedDays"] = body.expectedDays;

    // the determination clock is derived, so it is recomputed whenever
    // either of its inputs moves — and the obligation follows it
    if (body.appliedAt !== undefined || body.expectedDays !== undefined) {
      const appliedAt = body.appliedAt !== undefined ? body.appliedAt : permit.appliedAt;
      const expectedDays = body.expectedDays !== undefined ? body.expectedDays : permit.expectedDays;
      const dueAt = appliedAt && expectedDays ? addDaysISO(appliedAt, expectedDays) : null;
      patch["dueAt"] = dueAt;
      if (dueAt && permit.obligationId) {
        await app.db
          .update(obligations)
          .set({ deadline: `${dueAt}T23:59:59Z` })
          .where(and(eq(obligations.id, permit.obligationId), eq(obligations.status, "open")));
      } else if (dueAt && !permit.obligationId) {
        const obligationId = newId("obl");
        await app.db.insert(obligations).values({
          id: obligationId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          sourceClause: `${body.authority ?? permit.authority} — ${body.title ?? permit.title} determination`,
          trigger: `Application submitted ${appliedAt}; ${expectedDays}-day determination period`,
          deadline: `${dueAt}T23:59:59Z`,
          warnDaysBefore: 7,
          evidenceRequirement:
            "Written determination (grant, refusal or requisition) from the authority",
          status: "open",
          createdBy: req.user!.id,
        });
        patch["obligationId"] = obligationId;
      }
      if (permit.status === "not_started" && appliedAt) patch["status"] = "applied";
    }
    await app.db.update(permits).set(patch).where(eq(permits.id, permitId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "permit",
      objectId: permitId,
      payload: patch,
      storePayload: true,
    });
    const updated = await fetchPermit(permitId, req.companyId!, req.projectId!);
    return { ...updated, ...permitDerived(updated) };
  });

  app.post(
    "/projects/:projectId/permits/:permitId/status",
    { preHandler: standardGate },
    async (req) => {
      const { permitId } = req.params as { permitId: string };
      const body = permitStatusSchema.parse(req.body);
      const permit = await fetchPermit(permitId, req.companyId!, req.projectId!);
      const patch: Record<string, unknown> = {
        status: body.status,
        updatedAt: new Date().toISOString(),
      };
      if (body.reference !== undefined) patch["reference"] = body.reference;
      if (body.expiresAt !== undefined) patch["expiresAt"] = body.expiresAt;

      if (body.status === "granted") {
        // a grant without a date is not a grant — default to today rather
        // than leaving the register unable to compute an expiry window
        const grantedAt = body.grantedAt ?? todayISO();
        patch["grantedAt"] = grantedAt;
        if (permit.obligationId) {
          // a late determination does not rewrite history: only a still-open
          // obligation flips to satisfied, a breached one stays breached
          await app.db
            .update(obligations)
            .set({ status: "satisfied" })
            .where(and(eq(obligations.id, permit.obligationId), eq(obligations.status, "open")));
        }
      } else if (body.status === "refused") {
        // a refusal IS a determination — the authority answered, so the
        // determination obligation is discharged; the consequence is a
        // programme problem, surfaced by the blocks-programme sweep
        if (permit.obligationId) {
          await app.db
            .update(obligations)
            .set({ status: "satisfied" })
            .where(and(eq(obligations.id, permit.obligationId), eq(obligations.status, "open")));
        }
      } else if (body.status === "applied" && !permit.appliedAt) {
        patch["appliedAt"] = todayISO();
      }

      await app.db.update(permits).set(patch).where(eq(permits.id, permitId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "permit",
        objectId: permitId,
        payload: {
          from: permit.status,
          to: body.status,
          grantedAt: patch["grantedAt"] ?? permit.grantedAt,
          expiresAt: body.expiresAt ?? permit.expiresAt,
          reference: body.reference ?? permit.reference,
        },
        storePayload: true,
      });
      const updated = await fetchPermit(permitId, req.companyId!, req.projectId!);
      return { ...updated, ...permitDerived(updated) };
    },
  );

  /** Discharge one condition attached to a grant (#586-587). */
  app.post(
    "/projects/:projectId/permits/:permitId/conditions/:conditionId/close",
    { preHandler: standardGate },
    async (req) => {
      const { permitId, conditionId } = req.params as { permitId: string; conditionId: string };
      const body = closeConditionSchema.parse(req.body);
      const permit = await fetchPermit(permitId, req.companyId!, req.projectId!);
      const conditions = parseConditions(permit);
      const target = conditions.find((c) => c.id === conditionId);
      if (!target) throw notFound("Permit condition not found");
      if (target.closed) throw badRequest("This condition is already discharged");
      const now = new Date().toISOString();
      const next = conditions.map((c) =>
        c.id === conditionId
          ? { ...c, closed: true, closedAt: now, closedBy: req.user!.id, note: body.note ?? null }
          : c,
      );
      await app.db
        .update(permits)
        .set({ conditions: next, updatedAt: now })
        .where(eq(permits.id, permitId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "permit_condition",
        objectId: conditionId,
        payload: { permitId, text: target.text, dueDate: target.dueDate, note: body.note ?? null },
        storePayload: true,
      });
      const updated = await fetchPermit(permitId, req.companyId!, req.projectId!);
      return { ...updated, ...permitDerived(updated) };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Local content / ICV (#612-615)                                    */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/local-content-targets",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = localContentCreateSchema.parse(req.body);
      const id = newId("lct");
      await app.db.insert(localContentTargets).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        name: body.name,
        jurisdiction: body.jurisdiction,
        metric: body.metric,
        targetValue: body.targetValue,
        unit: body.unit ?? (body.metric === "icv_score" ? "score" : "%"),
        periodStart: body.periodStart ?? null,
        periodEnd: body.periodEnd ?? null,
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "local_content_target",
        objectId: id,
        payload: {
          name: body.name,
          jurisdiction: body.jurisdiction,
          metric: body.metric,
          targetValue: body.targetValue,
        },
        storePayload: true,
      });
      const created = await fetchTarget(id, req.companyId!, req.projectId!);
      return reply.status(201).send(created);
    },
  );

  app.get("/projects/:projectId/local-content-targets", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = and(
      eq(localContentTargets.companyId, req.companyId!),
      eq(localContentTargets.projectId, req.projectId!),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(localContentTargets).where(where);
    const rows = await app.db
      .select()
      .from(localContentTargets)
      .where(where)
      .orderBy(desc(localContentTargets.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const ids = rows.map((r) => r.id);
    const readings = ids.length
      ? await app.db
          .select()
          .from(localContentReadings)
          .where(inArray(localContentReadings.targetId, ids))
          .orderBy(asc(localContentReadings.readingDate), asc(localContentReadings.createdAt))
      : [];
    const latest = new Map<string, (typeof readings)[number]>();
    for (const r of readings) latest.set(r.targetId, r); // ascending — last wins
    const items = rows.map((target) => {
      const reading = latest.get(target.id) ?? null;
      return {
        ...target,
        latestReading: reading,
        latestValue: reading?.value ?? null,
        compliant: reading ? reading.compliant === 1 : null,
        // positive gap = distance still to travel to reach the target
        gap: reading ? round2(target.targetValue - reading.value) : null,
        readingCount: readings.filter((r) => r.targetId === target.id).length,
      };
    });
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post(
    "/projects/:projectId/local-content-targets/:targetId/readings",
    { preHandler: standardGate },
    async (req, reply) => {
      const { targetId } = req.params as { targetId: string };
      const body = localContentReadingSchema.parse(req.body);
      const target = await fetchTarget(targetId, req.companyId!, req.projectId!);
      // every local-content metric is "higher is better": a spend or
      // headcount percentage, an ICV score and a national quota are all
      // floors, so compliance is value >= targetValue with no operator
      const compliant = body.value >= target.targetValue;
      const gap = round2(target.targetValue - body.value);
      const id = newId("lcr");
      await app.db.insert(localContentReadings).values({
        id,
        targetId,
        companyId: req.companyId!,
        readingDate: body.readingDate,
        value: body.value,
        compliant: compliant ? 1 : 0,
        basis: body.basis ?? null,
        recordedBy: req.user!.id,
      });
      if (!compliant) {
        await app.db.insert(signals).values({
          id: newId("sig"),
          companyId: req.companyId!,
          projectId: req.projectId!,
          detector: "local_content_shortfall",
          severity: "medium",
          confidence: 1,
          title: `Local content shortfall — ${target.name}: ${body.value}${target.unit} against a ${target.targetValue}${target.unit} floor`,
          explanation:
            `The ${body.readingDate} reading of "${target.name}" (${target.metric}, ` +
            `${target.jurisdiction}) is ${body.value}${target.unit}, ${gap}${target.unit} below the ` +
            `contractual floor of ${target.targetValue}${target.unit}. ` +
            `Local content and in-country value undertakings are typically conditions of the ` +
            `licence or concession: sustained shortfall attracts penalties, withheld certificates ` +
            `or, in Gulf ICV regimes, exclusion from future tenders. ` +
            (body.basis ? `Basis: ${body.basis}.` : "No basis of measurement was stated."),
          evidenceRefs: { targetId, readingId: id, value: body.value, gap },
        });
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "local_content_reading",
        objectId: id,
        payload: {
          targetId,
          readingDate: body.readingDate,
          value: body.value,
          compliant,
          gap,
        },
        storePayload: true,
      });
      const created = (
        await app.db
          .select()
          .from(localContentReadings)
          .where(eq(localContentReadings.id, id))
          .limit(1)
      )[0];
      return reply.status(201).send({ ...created, gap, compliantBool: compliant });
    },
  );

  app.get(
    "/projects/:projectId/local-content-targets/:targetId/readings",
    { preHandler: readGate },
    async (req) => {
      const { targetId } = req.params as { targetId: string };
      const target = await fetchTarget(targetId, req.companyId!, req.projectId!);
      const rows = await app.db
        .select()
        .from(localContentReadings)
        .where(eq(localContentReadings.targetId, targetId))
        .orderBy(asc(localContentReadings.readingDate), asc(localContentReadings.createdAt));
      const items = rows.map((r) => ({
        ...r,
        gap: round2(target.targetValue - r.value),
        compliantBool: r.compliant === 1,
      }));
      return {
        target,
        items,
        total: items.length,
        breaches: items.filter((r) => !r.compliantBool).length,
      };
    },
  );
};
