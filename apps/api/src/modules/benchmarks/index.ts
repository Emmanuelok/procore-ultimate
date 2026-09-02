import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  benchmarkContributions,
  benchmarkForecasts,
  benchmarkSamples,
  benchmarkSeedMarkers,
  developerSandboxes,
  projectMetricSnapshots,
  signals,
} from "@constructos/db";
import { ASSET_CLASSES, PROCUREMENT_ROUTES, SIZE_BANDS } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import {
  BENCHMARK_METRIC_KEYS,
  BENCHMARK_METRICS,
  MIN_SAMPLE_N,
  computeStats,
  metricByKey,
  percentileOf,
  percentileRank,
  round2,
  type BenchmarkMetricDef,
} from "./metrics.js";
import {
  assessPool,
  MAX_CONTRIBUTOR_SHARE,
  readCell,
  type CellKey,
  type PoolRow,
  type PoolVerdict,
} from "./pool.js";
import { SEED_DISTRIBUTIONS, SEED_METHODOLOGY } from "./seed.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const snapshotCreateSchema = z.object({ metric: z.string().min(1).max(100) });

const snapshotListQuery = pageQuerySchema.extend({
  metric: z.string().min(1).max(100).optional(),
});

const contributeSchema = z.object({
  assetClass: z.enum(ASSET_CLASSES),
  region: z.string().min(2).max(40),
  dataYear: z.coerce.number().int().min(1990).max(2100).optional(),
  methodology: z.string().min(1).max(2000).optional(),
  /** reference-class dimensions (#833-838); optional, published when given */
  sizeBand: z.enum(SIZE_BANDS).optional(),
  procurementRoute: z.enum(PROCUREMENT_ROUTES).optional(),
});

const distributionQuery = z.object({
  metric: z.string().min(1).max(100),
  assetClass: z.enum(ASSET_CLASSES),
  region: z.string().min(2).max(40),
  currency: z.string().length(3).optional(),
});

const compareQuery = z.object({
  metric: z.string().min(1).max(100),
  assetClass: z.enum(ASSET_CLASSES).optional(),
  region: z.string().min(2).max(40).optional(),
  currency: z.string().length(3).optional(),
});

const rcfQuery = z.object({
  metric: z.string().min(1).max(100),
  assetClass: z.enum(ASSET_CLASSES),
  region: z.string().min(2).max(40),
  sizeBand: z.enum(SIZE_BANDS).optional(),
  procurementRoute: z.enum(PROCUREMENT_ROUTES).optional(),
  budget: z.coerce.number().positive().max(1e15).optional(),
  currency: z.string().length(3).optional(),
});

/* ------------------------------------------------------------------ */
/* Views — THE anonymization choke point                               */
/* ------------------------------------------------------------------ */

/**
 * ANONYMIZATION BOUNDARY (schema benchmarks.ts is the law): contributor ids
 * exist only to enforce contribute-to-access and min-n counting. Every
 * benchmark_samples row that leaves this module passes through this view,
 * which does not know the contributor columns exist. Distribution endpoints
 * go further and never even SELECT them.
 */
function viewSample(row: typeof benchmarkSamples.$inferSelect) {
  return {
    id: row.id,
    metric: row.metric,
    assetClass: row.assetClass,
    region: row.region,
    value: row.value,
    unit: row.unit,
    currency: row.currency,
    sizeBand: row.sizeBand,
    procurementRoute: row.procurementRoute,
    source: row.source,
    dataYear: row.dataYear,
    methodology: row.methodology,
    supersededAt: row.supersededAt,
    createdAt: row.createdAt,
  };
}

function viewSnapshot(row: typeof projectMetricSnapshots.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    metric: row.metric,
    value: row.value,
    unit: row.unit,
    currency: row.currency,
    inputs: row.inputs,
    contributedSampleId: row.contributedSampleId,
    outlierSignalId: row.outlierSignalId,
    computedBy: row.computedBy,
    createdAt: row.createdAt,
  };
}

function viewMetric(m: BenchmarkMetricDef) {
  return {
    key: m.key,
    name: m.name,
    unit: m.unit,
    higherIsBetter: m.higherIsBetter,
    description: m.description,
    inputs: m.inputs,
  };
}

const UPGRADE_NOTE =
  "Access is seed-only: contribute a snapshot of this metric to unlock the contributed " +
  "distribution (#855 contribute-to-access).";

const OUTLIER_DETECTOR = "benchmark_outlier";

function requireMetric(key: string): BenchmarkMetricDef {
  const metric = metricByKey(key);
  if (!metric) {
    throw badRequest(`Unknown metric "${key}"`, { validMetrics: BENCHMARK_METRIC_KEYS });
  }
  return metric;
}

const normalizeRegion = (region: string): string => region.trim().toUpperCase();

/**
 * M11 — Independent benchmarking (spec Vol II Domain V #821-858, Vol III M11).
 *
 * Code-resident metric registry, auditable per-project metric snapshots,
 * anonymized contribute-to-access distributions (#855) with min-n
 * suppression and unconditional sample-size disclosure (#831), and
 * percentile comparison with adverse-outlier signals.
 */
export const benchmarksModule: FastifyPluginAsync = async (app) => {
  /** Company-level reads: any authenticated member of the tenant. */
  const companyRead = [app.authenticate, app.requireCompany];
  const projectRead = [app.authenticate, app.requireCompany, app.requireTool("benchmarks", "read")];
  const projectStandard = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("benchmarks", "standard"),
  ];
  /**
   * Contributing crosses the tenant boundary — the value leaves the company's
   * walls (anonymized) forever. That is an admin-of-the-tool decision, not an
   * everyday standard-level action.
   */
  const projectContribute = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("benchmarks", "admin"),
  ];

  /* ---------------------------------------------------------------- */
  /* Shared queries                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Contribute-to-access check (#855). Contributor ids are read in a WHERE
   * clause for enforcement and never returned.
   */
  async function hasContributed(companyId: string, metric: string): Promise<boolean> {
    const rows = await app.db
      .select({ id: benchmarkSamples.id })
      .from(benchmarkSamples)
      .where(
        and(
          eq(benchmarkSamples.metric, metric),
          eq(benchmarkSamples.source, "contributed"),
          eq(benchmarkSamples.contributorCompanyId, companyId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** A sandbox tenant's figures are not real, so they never enter the pool. */
  async function isSandbox(companyId: string): Promise<boolean> {
    const rows = await app.db
      .select({ companyId: developerSandboxes.companyId })
      .from(developerSandboxes)
      .where(eq(developerSandboxes.companyId, companyId))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Lazy seed materialisation, made race-safe.
   *
   * The existence check plus bulk insert it used to do let two first-time
   * queries both see an empty cell and both write it, doubling n and the
   * histogram. The marker table's PRIMARY KEY is the lock: only the insert that
   * WINS the key may write the seed rows, and the loser proceeds to read the
   * cell the winner wrote.
   */
  async function ensureSeeded(metric: string, companyId: string, actorId: string): Promise<void> {
    const cells = SEED_DISTRIBUTIONS[metric];
    if (!cells || cells.length === 0) return;
    const def = requireMetric(metric);
    const rows: (typeof benchmarkSamples.$inferInsert)[] = [];
    for (const cell of cells) {
      for (const value of cell.values) {
        rows.push({
          id: newId("bms"),
          metric,
          assetClass: cell.assetClass,
          region: cell.region,
          value,
          unit: def.unit,
          source: "seed",
          contributorCompanyId: null,
          contributorProjectId: null,
          currency: null,
          dataYear: cell.dataYear,
          methodology: SEED_METHODOLOGY,
        });
      }
    }
    const claimed = await app.db
      .insert(benchmarkSeedMarkers)
      .values({ metric, rowsInserted: rows.length, materialisedBy: companyId })
      .onConflictDoNothing()
      .returning({ metric: benchmarkSeedMarkers.metric });
    if (claimed.length === 0) return; // another request materialised it
    await app.db.insert(benchmarkSamples).values(rows);
    await appendLedger(app.db, {
      companyId,
      actorId,
      action: "create",
      objectType: "benchmark_seed",
      objectId: metric,
      payload: { metric, rowsInserted: rows.length, methodology: SEED_METHODOLOGY },
      storePayload: true,
    });
  }

  /**
   * Read a cell and apply the anonymity rules (see ./pool.ts). Falls back to
   * the illustrative seed cell when the caller has not contributed, which is
   * the contribute-to-access model — and says which it returned.
   */
  async function describeCell(
    key: CellKey,
    viewerCompanyId: string,
    contributedAccess: boolean,
  ): Promise<{ verdict: PoolVerdict; seedIncluded: boolean }> {
    if (!contributedAccess) {
      const seed = await readCell(app.db, { ...key, currency: null }, "seed");
      return { verdict: assessPool(seed, viewerCompanyId, { seed: true }), seedIncluded: seed.length > 0 };
    }
    const contributed = await readCell(app.db, key, "contributed");
    return { verdict: assessPool(contributed, viewerCompanyId), seedIncluded: false };
  }

  /** Disclosure lines shared by distributions and compare (#831, #832). */
  function baseDisclosures(
    verdict: PoolVerdict,
    seedIncluded: boolean,
  ): string[] {
    const disclosures = [...verdict.disclosures];
    if (seedIncluded && verdict.rows.length > 0) disclosures.push(SEED_METHODOLOGY);
    const years = verdict.rows.map((r) => r.dataYear).filter((y): y is number => y != null);
    if (years.length > 0) {
      const lo = Math.min(...years);
      const hi = Math.max(...years);
      disclosures.push(
        lo === hi ? `Samples carry data year ${lo}.` : `Samples span data years ${lo}\u2013${hi}.`,
      );
    }
    if (!verdict.suppressed) {
      const methodologies = [
        ...new Set(verdict.rows.map((r) => r.methodology).filter((m): m is string => m != null)),
      ].sort();
      for (const m of methodologies.slice(0, 10)) {
        if (m !== SEED_METHODOLOGY) disclosures.push(`Methodology (verbatim): ${m}`);
      }
    }
    return disclosures;
  }

  /** The currency a money-unit metric's cell is keyed by; null for the rest. */
  function cellCurrency(metric: BenchmarkMetricDef, explicit?: string | null): string | null {
    if (!metric.unit.includes("currency")) return null;
    return explicit ? explicit.toUpperCase() : null;
  }

  /* ---------------------------------------------------------------- */
  /* Registry                                                          */
  /* ---------------------------------------------------------------- */

  app.get("/benchmarks/metrics", { preHandler: companyRead }, async () => ({
    metrics: BENCHMARK_METRICS.map(viewMetric),
    minSampleN: MIN_SAMPLE_N,
    accessModel:
      "Contribute-to-access (#855): a company sees a metric's contributed distribution only " +
      "after contributing a sample of that metric. Seed-only distributions are available to " +
      "everyone and are clearly labelled as illustrative.",
  }));

  /* ---------------------------------------------------------------- */
  /* Snapshots                                                         */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/benchmarks/snapshots", { preHandler: projectRead }, async (req) => {
    const q = snapshotListQuery.parse(req.query);
    const clauses = [
      eq(projectMetricSnapshots.companyId, req.companyId!),
      eq(projectMetricSnapshots.projectId, req.projectId!),
      ...(q.metric ? [eq(projectMetricSnapshots.metric, q.metric)] : []),
    ];
    const where = and(...clauses);
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(projectMetricSnapshots)
      .where(where);
    const rows = await app.db
      .select()
      .from(projectMetricSnapshots)
      .where(where)
      .orderBy(desc(projectMetricSnapshots.createdAt), desc(projectMetricSnapshots.id))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows.map(viewSnapshot), Number(totalRow?.n ?? 0), q);
  });

  /**
   * Compute a metric NOW and store the number with the exact inputs it was
   * computed from (auditability — the later comparison and any contribution
   * are against this frozen figure, not a moving target). Missing inputs are
   * a 422 with reasons, never a fabricated value.
   */
  app.post(
    "/projects/:projectId/benchmarks/snapshots",
    { preHandler: projectStandard },
    async (req, reply) => {
      const body = snapshotCreateSchema.parse(req.body);
      const metric = requireMetric(body.metric);
      const computation = await metric.compute(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
      });
      if (computation.value == null) {
        throw new AppError(422, `Metric "${metric.key}" cannot be computed for this project`, {
          metric: metric.key,
          reasons: computation.reasons,
          inputs: computation.inputs,
        });
      }
      const id = newId("bsn");
      await app.db.insert(projectMetricSnapshots).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        metric: metric.key,
        value: computation.value,
        unit: computation.unit,
        inputs: computation.inputs,
        // A money-unit figure without its currency is not a figure. The
        // computation reports the single currency it read, or null when the
        // project holds none — a metric whose basis spanned two currencies
        // never reaches here, it returns 422 above with the reason.
        currency:
          typeof computation.inputs["currency"] === "string"
            ? (computation.inputs["currency"] as string)
            : null,
        computedBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "benchmark_snapshot",
        objectId: id,
        payload: {
          projectId: req.projectId!,
          metric: metric.key,
          value: computation.value,
          unit: computation.unit,
          inputs: computation.inputs,
        },
        storePayload: true,
      });
      const [row] = await app.db
        .select()
        .from(projectMetricSnapshots)
        .where(eq(projectMetricSnapshots.id, id))
        .limit(1);
      return reply.status(201).send(viewSnapshot(row!));
    },
  );

  /* ---------------------------------------------------------------- */
  /* Contribution (#853, #855)                                         */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/benchmarks/snapshots/:snapshotId/contribute",
    { preHandler: projectContribute },
    async (req, reply) => {
      const { snapshotId } = req.params as { snapshotId: string };
      const body = contributeSchema.parse(req.body);
      const region = normalizeRegion(body.region);
      const [snapshot] = await app.db
        .select()
        .from(projectMetricSnapshots)
        .where(
          and(
            eq(projectMetricSnapshots.id, snapshotId),
            eq(projectMetricSnapshots.companyId, req.companyId!),
            eq(projectMetricSnapshots.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!snapshot) throw notFound("Snapshot not found");

      // Idempotent per snapshot: a snapshot contributes at most one sample.
      if (snapshot.contributedSampleId) {
        const [existing] = await app.db
          .select()
          .from(benchmarkSamples)
          .where(eq(benchmarkSamples.id, snapshot.contributedSampleId))
          .limit(1);
        return reply.status(200).send({
          alreadyContributed: true,
          snapshotId: snapshot.id,
          sample: existing ? viewSample(existing) : null,
        });
      }

      // A sandbox tenant's numbers are exercises. Letting them into a pool
      // other companies are compared against would corrupt the distribution
      // with figures nobody claims are real.
      if (await isSandbox(req.companyId!)) {
        throw conflict(
          "This company is marked as a developer sandbox, so its figures cannot enter the " +
            "cross-tenant benchmark pool. Disable the sandbox flag first " +
            "(DELETE /integrations/sandbox) if these numbers are real.",
        );
      }

      const metricDef = requireMetric(snapshot.metric);
      const currency = cellCurrency(metricDef, snapshot.currency);
      if (metricDef.unit.includes("currency") && !currency) {
        throw new AppError(
          422,
          `Metric "${snapshot.metric}" is denominated in money, so the sample must carry a ` +
            "currency. This snapshot has none — record a single project currency and recompute " +
            "the snapshot before contributing it.",
          { metric: snapshot.metric, snapshotId: snapshot.id },
        );
      }

      /*
       * ONE LIVE SAMPLE PER PROJECT PER CELL.
       *
       * Contributing a fresh snapshot of a project that has already
       * contributed to this cell SUPERSEDES the earlier sample rather than
       * adding to it. Without this a company could compute five snapshots of
       * one project, contribute all five, lift the cell over min-n on its own
       * and read percentiles of a set it mostly wrote — the de-anonymisation
       * the suppression rule exists to prevent. The unique index on
       * benchmark_contributions is what makes it true under concurrency.
       */
      const sampleId = newId("bms");
      const [priorContribution] = await app.db
        .select()
        .from(benchmarkContributions)
        .where(
          and(
            eq(benchmarkContributions.contributorProjectId, req.projectId!),
            eq(benchmarkContributions.metric, snapshot.metric),
            eq(benchmarkContributions.assetClass, body.assetClass),
            eq(benchmarkContributions.region, region),
          ),
        )
        .limit(1);

      await app.db.insert(benchmarkSamples).values({
        id: sampleId,
        metric: snapshot.metric,
        assetClass: body.assetClass,
        region,
        value: snapshot.value,
        unit: snapshot.unit,
        currency,
        sizeBand: body.sizeBand ?? null,
        procurementRoute: body.procurementRoute ?? null,
        source: "contributed",
        // Kept ONLY for contribute-to-access enforcement, contributor counting
        // and self-exclusion; no read path returns these (see viewSample).
        contributorCompanyId: req.companyId!,
        contributorProjectId: req.projectId!,
        dataYear: body.dataYear ?? new Date(snapshot.createdAt).getUTCFullYear(),
        methodology: body.methodology ?? null,
      });

      if (priorContribution) {
        await app.db
          .update(benchmarkSamples)
          .set({
            supersededAt: new Date().toISOString(),
            supersededBySampleId: sampleId,
          })
          .where(eq(benchmarkSamples.id, priorContribution.sampleId));
        await app.db
          .update(benchmarkContributions)
          .set({ sampleId, supersededSampleId: priorContribution.sampleId })
          .where(eq(benchmarkContributions.id, priorContribution.id));
      } else {
        try {
          await app.db.insert(benchmarkContributions).values({
            id: newId("bct"),
            contributorCompanyId: req.companyId!,
            contributorProjectId: req.projectId!,
            metric: snapshot.metric,
            assetClass: body.assetClass,
            region,
            currency,
            sampleId,
          });
        } catch {
          // A concurrent contribution won the unique index. The sample just
          // written is the loser and must not sit in the pool unclaimed.
          await app.db
            .update(benchmarkSamples)
            .set({ supersededAt: new Date().toISOString() })
            .where(eq(benchmarkSamples.id, sampleId));
          throw conflict(
            "Another contribution for this project and cell was recorded at the same instant; " +
              "re-read the snapshot and try again.",
          );
        }
      }

      await app.db
        .update(projectMetricSnapshots)
        .set({ contributedSampleId: sampleId })
        .where(eq(projectMetricSnapshots.id, snapshot.id));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "benchmark_sample",
        objectId: sampleId,
        payload: {
          snapshotId: snapshot.id,
          metric: snapshot.metric,
          assetClass: body.assetClass,
          region,
          currency,
          sizeBand: body.sizeBand ?? null,
          procurementRoute: body.procurementRoute ?? null,
          value: snapshot.value,
          unit: snapshot.unit,
          dataYear: body.dataYear ?? null,
          methodology: body.methodology ?? null,
          supersededSampleId: priorContribution?.sampleId ?? null,
        },
        storePayload: true,
      });
      const [created] = await app.db
        .select()
        .from(benchmarkSamples)
        .where(eq(benchmarkSamples.id, sampleId))
        .limit(1);
      return reply.status(201).send({
        alreadyContributed: false,
        snapshotId: snapshot.id,
        supersededSampleId: priorContribution?.sampleId ?? null,
        sample: viewSample(created!),
        anonymity:
          `Your project now holds exactly one live sample in ${body.assetClass}/${region}. A cell ` +
          `is described only once ${MIN_SAMPLE_N} distinct companies have contributed to it and ` +
          `no one of them holds ${Math.round(MAX_CONTRIBUTOR_SHARE * 100)}% or more of it.`,
      });
    },
  );

  /* ---------------------------------------------------------------- */
  /* Distributions (#831, #853-855)                                    */
  /* ---------------------------------------------------------------- */

  app.get("/benchmarks/distributions", { preHandler: companyRead }, async (req) => {
    const q = distributionQuery.parse(req.query);
    const metric = requireMetric(q.metric);
    const region = normalizeRegion(q.region);
    const currency = cellCurrency(metric, q.currency);
    if (metric.unit.includes("currency") && !currency) {
      throw badRequest(
        `Metric "${metric.key}" is denominated in money, so a distribution must name the ` +
          "currency its cell is keyed by (?currency=GBP). Percentiles over mixed currencies " +
          "describe the exchange rate.",
      );
    }
    await ensureSeeded(metric.key, req.companyId!, req.user!.id);

    const contributedAccess = await hasContributed(req.companyId!, metric.key);
    const accessLevel = contributedAccess ? "contributed" : "seed_only";
    const { verdict, seedIncluded } = await describeCell(
      { metric: metric.key, assetClass: q.assetClass, region, currency },
      req.companyId!,
      contributedAccess,
    );
    const computable = verdict.values.length > 0 && !verdict.suppressed;
    const disclosures = baseDisclosures(verdict, seedIncluded);
    if (accessLevel === "seed_only") disclosures.push(UPGRADE_NOTE);

    return {
      metric: metric.key,
      unit: metric.unit,
      currency,
      higherIsBetter: metric.higherIsBetter,
      assetClass: q.assetClass,
      region,
      accessLevel,
      minSampleN: MIN_SAMPLE_N,
      maxContributorShare: MAX_CONTRIBUTOR_SHARE,
      contributors: verdict.contributors,
      ownSamplesExcluded: verdict.ownSamples,
      ...(accessLevel === "seed_only" ? { note: UPGRADE_NOTE } : {}),
      distribution: computable
        ? computeStats(verdict.values)
        : {
            n: verdict.values.length,
            ...(verdict.suppressed ? { suppressed: true as const } : {}),
          },
      seedIncluded,
      ...(seedIncluded ? { healthWarning: SEED_METHODOLOGY } : {}),
      disclosures,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Compare (read-only) + explicit evaluation                         */
  /* ---------------------------------------------------------------- */

  /**
   * Place a project's latest snapshot in its cell.
   *
   * THIS ROUTE NO LONGER WRITES. It used to insert a signal and a ledger entry
   * from a GET — which a prefetching browser could fire, which two concurrent
   * compares could both do (there is no uniqueness on detector+snapshot), and
   * which made "look at the comparison" an act with consequences. Raising the
   * signal is now POST .../evaluate, and the answer here tells the caller
   * whether one WOULD be raised.
   */
  async function compareSnapshot(
    companyId: string,
    projectId: string,
    userId: string,
    q: z.infer<typeof compareQuery>,
  ) {
    const metric = requireMetric(q.metric);
    const [snapshot] = await app.db
      .select()
      .from(projectMetricSnapshots)
      .where(
        and(
          eq(projectMetricSnapshots.companyId, companyId),
          eq(projectMetricSnapshots.projectId, projectId),
          eq(projectMetricSnapshots.metric, metric.key),
        ),
      )
      .orderBy(desc(projectMetricSnapshots.createdAt), desc(projectMetricSnapshots.id))
      .limit(1);
    if (!snapshot) {
      throw notFound(
        `No snapshot of "${metric.key}" for this project — compute one via ` +
          "POST /benchmarks/snapshots first",
      );
    }

    let assetClass = q.assetClass as string | undefined;
    let region = q.region ? normalizeRegion(q.region) : undefined;
    if ((!assetClass || !region) && snapshot.contributedSampleId) {
      const [own] = await app.db
        .select({
          assetClass: benchmarkSamples.assetClass,
          region: benchmarkSamples.region,
        })
        .from(benchmarkSamples)
        .where(eq(benchmarkSamples.id, snapshot.contributedSampleId))
        .limit(1);
      if (own) {
        assetClass = assetClass ?? own.assetClass;
        region = region ?? own.region;
      }
    }
    if (!assetClass || !region) {
      throw badRequest(
        "assetClass and region are required (or contribute this snapshot first so the cell " +
          "can be derived from its sample)",
      );
    }
    const currency = cellCurrency(metric, q.currency ?? snapshot.currency);

    await ensureSeeded(metric.key, companyId, userId);
    const contributedAccess = await hasContributed(companyId, metric.key);
    const accessLevel = contributedAccess ? "contributed" : "seed_only";
    const { verdict, seedIncluded } = await describeCell(
      { metric: metric.key, assetClass, region, currency },
      companyId,
      contributedAccess,
    );
    const values = verdict.values;
    const computable = values.length > 0 && !verdict.suppressed;
    const disclosures = baseDisclosures(verdict, seedIncluded);
    if (accessLevel === "seed_only") disclosures.push(UPGRADE_NOTE);

    let percentile: number | null = null;
    let distribution: Record<string, unknown> = {
      n: values.length,
      ...(verdict.suppressed ? { suppressed: true as const } : {}),
    };
    let adverse = false;
    let side: "above_p90" | "below_p10" | null = null;
    let threshold: number | null = null;
    let median: number | null = null;

    if (computable) {
      const sorted = [...values].sort((a, b) => a - b);
      const p10 = round2(percentileOf(sorted, 10));
      median = round2(percentileOf(sorted, 50));
      const p90 = round2(percentileOf(sorted, 90));
      percentile = percentileRank(values, snapshot.value);
      distribution = { n: values.length, p10, median, p90 };
      adverse = metric.higherIsBetter ? snapshot.value < p10 : snapshot.value > p90;
      side = adverse ? (metric.higherIsBetter ? "below_p10" : "above_p90") : null;
      threshold = metric.higherIsBetter ? p10 : p90;
    }

    // A signal is raised ONLY against a genuinely contributed distribution
    // that survived the anonymity rules — never against illustrative seed data.
    const signallable =
      adverse && contributedAccess && !verdict.suppressed && verdict.contributors >= MIN_SAMPLE_N;

    return {
      metric,
      snapshot,
      assetClass,
      region,
      currency,
      accessLevel,
      verdict,
      percentile,
      distribution,
      adverse,
      side,
      threshold,
      median,
      seedIncluded,
      disclosures,
      signallable,
      computable,
    };
  }

  app.get("/projects/:projectId/benchmarks/compare", { preHandler: projectRead }, async (req) => {
    const q = compareQuery.parse(req.query);
    const c = await compareSnapshot(req.companyId!, req.projectId!, req.user!.id, q);
    return {
      metric: c.metric.key,
      assetClass: c.assetClass,
      region: c.region,
      currency: c.currency,
      snapshotId: c.snapshot.id,
      value: c.snapshot.value,
      unit: c.snapshot.unit,
      computedAt: c.snapshot.createdAt,
      accessLevel: c.accessLevel,
      minSampleN: MIN_SAMPLE_N,
      contributors: c.verdict.contributors,
      ownSamplesExcluded: c.verdict.ownSamples,
      percentile: c.percentile,
      distribution: c.distribution,
      ...(c.computable
        ? {
            outlier: {
              adverse: c.adverse,
              side: c.side,
              // Read-only: this route no longer writes. It reports whether an
              // evaluation WOULD raise a signal, and which one already has.
              signalRaised: c.snapshot.outlierSignalId !== null,
              signalId: c.snapshot.outlierSignalId,
              wouldRaise: c.signallable && c.snapshot.outlierSignalId === null,
            },
          }
        : {}),
      seedIncluded: c.seedIncluded,
      ...(c.seedIncluded ? { healthWarning: SEED_METHODOLOGY } : {}),
      disclosures: c.disclosures,
    };
  });

  /**
   * Evaluate a snapshot and raise the adverse-outlier signal if one is due.
   *
   * The signal id is claimed with a CONDITIONAL UPDATE on the snapshot row
   * (`where outlier_signal_id is null … returning`), so two concurrent
   * evaluations cannot both raise one: the loser sees zero rows returned and
   * reports the winner's signal instead of writing a duplicate.
   */
  app.post(
    "/projects/:projectId/benchmarks/snapshots/:snapshotId/evaluate",
    { preHandler: projectStandard },
    async (req) => {
      const { snapshotId } = req.params as { snapshotId: string };
      const [snapshot] = await app.db
        .select()
        .from(projectMetricSnapshots)
        .where(
          and(
            eq(projectMetricSnapshots.id, snapshotId),
            eq(projectMetricSnapshots.companyId, req.companyId!),
            eq(projectMetricSnapshots.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!snapshot) throw notFound("Snapshot not found");
      const body = compareQuery.partial({ metric: true }).parse(req.body ?? {});
      const c = await compareSnapshot(req.companyId!, req.projectId!, req.user!.id, {
        ...body,
        metric: snapshot.metric,
      });

      if (!c.signallable) {
        return {
          snapshotId: snapshot.id,
          signalRaised: false,
          signalId: snapshot.outlierSignalId,
          reason: c.adverse
            ? c.verdict.suppressed
              ? "The comparison cell does not satisfy the anonymity rules, so its tails are not " +
                "a defensible basis for a signal."
              : "The distribution is illustrative seed data, not contributed outcomes."
            : "The snapshot is not in the adverse tail of its cell.",
          percentile: c.percentile,
          distribution: c.distribution,
          disclosures: c.disclosures,
        };
      }

      const signalId = newId("sig");
      const claimed = await app.db
        .update(projectMetricSnapshots)
        .set({ outlierSignalId: signalId })
        .where(
          and(
            eq(projectMetricSnapshots.id, snapshot.id),
            isNull(projectMetricSnapshots.outlierSignalId),
          ),
        )
        .returning({ id: projectMetricSnapshots.id });
      if (claimed.length === 0) {
        const [after] = await app.db
          .select({ outlierSignalId: projectMetricSnapshots.outlierSignalId })
          .from(projectMetricSnapshots)
          .where(eq(projectMetricSnapshots.id, snapshot.id))
          .limit(1);
        return {
          snapshotId: snapshot.id,
          signalRaised: false,
          signalId: after?.outlierSignalId ?? null,
          reason: "A signal has already been raised for this snapshot.",
          percentile: c.percentile,
          distribution: c.distribution,
          disclosures: c.disclosures,
        };
      }

      await app.db.insert(signals).values({
        id: signalId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        detector: OUTLIER_DETECTOR,
        severity: "medium",
        confidence: round2(
          Math.min(0.95, c.verdict.contributors / (c.verdict.contributors + MIN_SAMPLE_N)),
        ),
        title: `${c.metric.name} is beyond the adverse ${
          c.metric.higherIsBetter ? "p10" : "p90"
        } of its benchmark cell`,
        explanation:
          `The project's latest "${c.metric.key}" snapshot is ${snapshot.value} ${snapshot.unit}, ` +
          `${c.metric.higherIsBetter ? "below" : "beyond"} the ${
            c.metric.higherIsBetter ? "10th" : "90th"
          } percentile (${c.threshold} ${c.metric.unit}) of the contributed ` +
          `${c.assetClass}/${c.region} distribution (n=${c.verdict.values.length} from ` +
          `${c.verdict.contributors} distinct contributors, median ${c.median} ${c.metric.unit}; ` +
          "your own samples excluded). Investigate whether the figure reflects scope, data " +
          "quality, or genuine adverse performance.",
        evidenceRefs: {
          snapshotId: snapshot.id,
          metric: c.metric.key,
          assetClass: c.assetClass,
          region: c.region,
          currency: c.currency,
          value: snapshot.value,
          threshold: c.threshold,
          side: c.side,
          n: c.verdict.values.length,
          contributors: c.verdict.contributors,
          percentile: c.percentile,
        },
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "benchmark_outlier_signal",
        objectId: signalId,
        projectId: req.projectId!,
        payload: {
          snapshotId: snapshot.id,
          metric: c.metric.key,
          assetClass: c.assetClass,
          region: c.region,
          value: snapshot.value,
          threshold: c.threshold,
          n: c.verdict.values.length,
          contributors: c.verdict.contributors,
        },
        storePayload: true,
      });
      return {
        snapshotId: snapshot.id,
        signalRaised: true,
        signalId,
        percentile: c.percentile,
        distribution: c.distribution,
        disclosures: c.disclosures,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Reference-class forecasting (#833-838, #846-849)                  */
  /* ---------------------------------------------------------------- */

  /**
   * The classes that exist in the pool, with the anonymity verdict for each.
   * A class that cannot be described is LISTED, with the reason — knowing that
   * a class exists but is too thin to describe is itself information, and
   * hiding it would make the pool look emptier than it is.
   */
  app.get("/benchmarks/reference-classes", { preHandler: companyRead }, async (req) => {
    const metric = z
      .object({ metric: z.string().min(1).max(100).optional() })
      .parse(req.query).metric;
    const rows = await app.db
      .select({
        metric: benchmarkSamples.metric,
        assetClass: benchmarkSamples.assetClass,
        region: benchmarkSamples.region,
        currency: benchmarkSamples.currency,
        contributorCompanyId: benchmarkSamples.contributorCompanyId,
        value: benchmarkSamples.value,
        dataYear: benchmarkSamples.dataYear,
        methodology: benchmarkSamples.methodology,
      })
      .from(benchmarkSamples)
      .where(
        and(
          eq(benchmarkSamples.source, "contributed"),
          isNull(benchmarkSamples.supersededAt),
          metric ? eq(benchmarkSamples.metric, metric) : undefined,
        ),
      )
      .limit(5000);
    const byClass = new Map<string, PoolRow[]>();
    const meta = new Map<string, { metric: string; assetClass: string; region: string; currency: string | null }>();
    for (const r of rows) {
      const key = `${r.metric}|${r.assetClass}|${r.region}|${r.currency ?? ""}`;
      const list = byClass.get(key) ?? [];
      list.push({
        value: r.value,
        dataYear: r.dataYear,
        methodology: r.methodology,
        contributorCompanyId: r.contributorCompanyId,
      });
      byClass.set(key, list);
      meta.set(key, {
        metric: r.metric,
        assetClass: r.assetClass,
        region: r.region,
        currency: r.currency,
      });
    }
    const classes = [...byClass.entries()].map(([key, list]) => {
      const verdict = assessPool(list, req.companyId!);
      const m = meta.get(key)!;
      return {
        id: key,
        ...m,
        contributors: verdict.contributors,
        sampleSize: verdict.values.length,
        describable: !verdict.suppressed && verdict.values.length > 0,
        reasons: verdict.reasons,
      };
    });
    return {
      classes: classes.sort((a, b) => b.contributors - a.contributors),
      minSampleN: MIN_SAMPLE_N,
      maxContributorShare: MAX_CONTRIBUTOR_SHARE,
      membership:
        "A reference class is metric x asset class x region (x currency for money metrics). " +
        "Size band and procurement route are declared on each sample and published with it; " +
        "narrow the class with ?sizeBand= and ?procurementRoute= on the forecast route.",
    };
  });

  /**
   * The forecast itself: given a budget and a class, what comparable projects
   * actually did. Exceedance probabilities are empirical shares of the sample,
   * not a fitted curve — with n=8 the answer moves in eighths, which is why n
   * and the contributor count are always returned.
   */
  app.get("/benchmarks/reference-classes/forecast", { preHandler: companyRead }, async (req) => {
    const q = rcfQuery.parse(req.query);
    const metric = requireMetric(q.metric);
    const region = normalizeRegion(q.region);
    const currency = cellCurrency(metric, q.currency);
    await ensureSeeded(metric.key, req.companyId!, req.user!.id);
    const contributedAccess = await hasContributed(req.companyId!, metric.key);
    const { verdict, seedIncluded } = await describeCell(
      { metric: metric.key, assetClass: q.assetClass, region, currency },
      req.companyId!,
      contributedAccess,
    );
    const values = verdict.suppressed ? [] : verdict.values;
    const sorted = [...values].sort((a, b) => a - b);
    const p50 = values.length > 0 ? round2(percentileOf(sorted, 50)) : null;
    const p80 = values.length > 0 ? round2(percentileOf(sorted, 80)) : null;
    const exceedance = [10, 25, 50].map((threshold) => ({
      threshold,
      probability:
        values.length > 0
          ? round2(values.filter((v) => v > threshold).length / values.length)
          : null,
    }));
    const disclosures = baseDisclosures(verdict, seedIncluded);
    if (seedIncluded) {
      disclosures.push(
        "These are illustrative seed samples, not contributed outcomes: treat the uplift as a " +
          "worked example, not a recommendation.",
      );
    }
    return {
      metric: metric.key,
      unit: metric.unit,
      assetClass: q.assetClass,
      region,
      currency,
      sizeBand: q.sizeBand ?? null,
      procurementRoute: q.procurementRoute ?? null,
      contributors: verdict.contributors,
      sampleSize: values.length,
      p50Uplift: p50,
      p80Uplift: p80,
      exceedance,
      budget: q.budget ?? null,
      recommended:
        q.budget != null && p80 != null
          ? {
              p50: round2(q.budget * (1 + p50! / 100)),
              p80: round2(q.budget * (1 + p80 / 100)),
              contingencyAtP80: round2(q.budget * (p80 / 100)),
              currency: currency ?? q.currency?.toUpperCase() ?? null,
            }
          : null,
      seedIncluded,
      disclosures,
    };
  });

  /**
   * Store a forecast against a project, so the uplift a contingency decision
   * cited can be produced later with the class it came from. The stored row is
   * the figure the risk module's contingency recommendation reads.
   */
  app.post(
    "/projects/:projectId/benchmarks/rcf",
    { preHandler: projectStandard },
    async (req, reply) => {
      const q = rcfQuery.parse(req.body ?? {});
      const metric = requireMetric(q.metric);
      const region = normalizeRegion(q.region);
      const currency = cellCurrency(metric, q.currency);
      await ensureSeeded(metric.key, req.companyId!, req.user!.id);
      const contributedAccess = await hasContributed(req.companyId!, metric.key);
      const { verdict, seedIncluded } = await describeCell(
        { metric: metric.key, assetClass: q.assetClass, region, currency },
        req.companyId!,
        contributedAccess,
      );
      const values = verdict.suppressed ? [] : verdict.values;
      if (values.length === 0) {
        throw new AppError(
          422,
          "No describable reference class for this combination, so there is no forecast to " +
            "store. A stored forecast with no basis would be a number somebody could cite.",
          { reasons: verdict.reasons, contributors: verdict.contributors },
        );
      }
      const sorted = [...values].sort((a, b) => a - b);
      const p50 = round2(percentileOf(sorted, 50));
      const p80 = round2(percentileOf(sorted, 80));
      const exceedance = [10, 25, 50].map((threshold) => ({
        threshold,
        probability: round2(values.filter((v) => v > threshold).length / values.length),
      }));
      const disclosures = baseDisclosures(verdict, seedIncluded);
      const id = newId("bfc");
      await app.db.insert(benchmarkForecasts).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        metric: metric.key,
        referenceClass: `${metric.key}|${q.assetClass}|${region}${currency ? `|${currency}` : ""}`,
        assetClass: q.assetClass,
        region,
        sizeBand: q.sizeBand ?? null,
        procurementRoute: q.procurementRoute ?? null,
        budget: q.budget ?? null,
        currency,
        contributorCount: verdict.contributors,
        sampleSize: values.length,
        p50Uplift: p50,
        p80Uplift: p80,
        exceedance,
        disclosures,
        computedBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "benchmark_forecast",
        objectId: id,
        projectId: req.projectId!,
        payload: {
          metric: metric.key,
          assetClass: q.assetClass,
          region,
          p50Uplift: p50,
          p80Uplift: p80,
          sampleSize: values.length,
          contributors: verdict.contributors,
          seedIncluded,
        },
        storePayload: true,
      });
      const [row] = await app.db
        .select()
        .from(benchmarkForecasts)
        .where(eq(benchmarkForecasts.id, id))
        .limit(1);
      return reply.status(201).send({ forecast: row, seedIncluded });
    },
  );

  app.get("/projects/:projectId/benchmarks/rcf", { preHandler: projectRead }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = and(
      eq(benchmarkForecasts.companyId, req.companyId!),
      eq(benchmarkForecasts.projectId, req.projectId!),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(benchmarkForecasts).where(where);
    const rows = await app.db
      .select()
      .from(benchmarkForecasts)
      .where(where)
      .orderBy(desc(benchmarkForecasts.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, Number(totalRow?.n ?? 0), q);
  });

  /**
   * Health inputs (contract §3.5): the project's standing against its
   * benchmark cells, as counts a health engine can weigh. A metric with no
   * snapshot is null with a reason, never 0.
   */
  app.get(
    "/projects/:projectId/benchmarks/health-inputs",
    { preHandler: projectRead },
    async (req) => {
      const snapshots = await app.db
        .select()
        .from(projectMetricSnapshots)
        .where(
          and(
            eq(projectMetricSnapshots.companyId, req.companyId!),
            eq(projectMetricSnapshots.projectId, req.projectId!),
          ),
        )
        .orderBy(desc(projectMetricSnapshots.createdAt))
        .limit(200);
      const latest = new Map<string, (typeof snapshots)[number]>();
      for (const snap of snapshots) if (!latest.has(snap.metric)) latest.set(snap.metric, snap);
      const reasons: string[] = [];
      if (latest.size === 0) {
        reasons.push(
          "No benchmark snapshots on this project — compute one per metric to make these " +
            "figures available.",
        );
      }
      const [outlierRow] = await app.db
        .select({ n: count() })
        .from(signals)
        .where(
          and(
            eq(signals.companyId, req.companyId!),
            eq(signals.projectId, req.projectId!),
            eq(signals.detector, OUTLIER_DETECTOR),
          ),
        );
      const metrics: Record<string, number | null> = {
        snapshotsHeld: latest.size,
        adverseOutlierSignals: Number(outlierRow?.n ?? 0),
      };
      for (const [key, snap] of latest) metrics[`latest_${key}`] = snap.value;
      for (const def of BENCHMARK_METRICS) {
        if (!latest.has(def.key)) metrics[`latest_${def.key}`] = null;
      }
      return { metrics, reasons };
    },
  );
};
