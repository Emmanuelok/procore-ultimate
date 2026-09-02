import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { benchmarkSamples, projectMetricSnapshots, signals } from "@constructos/db";
import { ASSET_CLASSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { AppError, badRequest, notFound } from "../../lib/errors.js";
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
    source: row.source,
    dataYear: row.dataYear,
    methodology: row.methodology,
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
    inputs: row.inputs,
    contributedSampleId: row.contributedSampleId,
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

      const sampleId = newId("bms");
      await app.db.insert(benchmarkSamples).values({
        id: sampleId,
        metric: snapshot.metric,
        assetClass: body.assetClass,
        region,
        value: snapshot.value,
        unit: snapshot.unit,
        source: "contributed",
        // Kept ONLY for contribute-to-access enforcement and min-n counting;
        // no read path returns these (see viewSample).
        contributorCompanyId: req.companyId!,
        contributorProjectId: req.projectId!,
        dataYear: body.dataYear ?? new Date(snapshot.createdAt).getUTCFullYear(),
        methodology: body.methodology ?? null,
      });
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
          value: snapshot.value,
          unit: snapshot.unit,
          dataYear: body.dataYear ?? null,
          methodology: body.methodology ?? null,
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
        sample: viewSample(created!),
      });
    },
  );

  /* ---------------------------------------------------------------- */
  /* Distributions (#831, #855)                                        */
  /* ---------------------------------------------------------------- */

  app.get("/benchmarks/distributions", { preHandler: companyRead }, async (req) => {
    const q = distributionQuery.parse(req.query);
    const metric = requireMetric(q.metric);
    const region = normalizeRegion(q.region);
    await ensureSeeded(metric.key, req.companyId!, req.user!.id);

    const contributedAccess = await hasContributed(req.companyId!, metric.key);
    const accessLevel = contributedAccess ? "contributed" : "seed_only";
    const rows = await cellRows(
      metric.key,
      q.assetClass,
      region,
      contributedAccess ? "contributed" : "seed",
    );
    const values = rows.map((r) => r.value);

    // Min-n suppression protects CONTRIBUTORS; seed rows are fictional and
    // are shown at any n. n itself is disclosed in every branch (#831).
    const suppressed = contributedAccess && values.length < MIN_SAMPLE_N;
    const computable = values.length > 0 && !suppressed;
    const seedIncluded = !contributedAccess && values.length > 0;
    const disclosures = baseDisclosures(rows, suppressed, seedIncluded);

    return {
      metric: metric.key,
      unit: metric.unit,
      higherIsBetter: metric.higherIsBetter,
      assetClass: q.assetClass,
      region,
      accessLevel,
      minSampleN: MIN_SAMPLE_N,
      ...(accessLevel === "seed_only" ? { note: UPGRADE_NOTE } : {}),
      distribution: computable
        ? computeStats(values)
        : { n: values.length, ...(suppressed ? { suppressed: true as const } : {}) },
      seedIncluded,
      ...(seedIncluded ? { healthWarning: SEED_METHODOLOGY } : {}),
      disclosures,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Compare + outlier signal                                          */
  /* ---------------------------------------------------------------- */

  /** Has a benchmark_outlier signal for this snapshot already been raised? */
  async function outlierSignalExists(
    companyId: string,
    projectId: string,
    snapshotId: string,
  ): Promise<boolean> {
    const rows = await app.db
      .select({ evidenceRefs: signals.evidenceRefs })
      .from(signals)
      .where(
        and(
          eq(signals.companyId, companyId),
          eq(signals.projectId, projectId),
          eq(signals.detector, OUTLIER_DETECTOR),
        ),
      );
    return rows.some((s) => {
      const refs = s.evidenceRefs as { snapshotId?: unknown } | null;
      return refs?.snapshotId === snapshotId;
    });
  }

  app.get("/projects/:projectId/benchmarks/compare", { preHandler: projectRead }, async (req) => {
    const q = compareQuery.parse(req.query);
    const metric = requireMetric(q.metric);

    const [snapshot] = await app.db
      .select()
      .from(projectMetricSnapshots)
      .where(
        and(
          eq(projectMetricSnapshots.companyId, req.companyId!),
          eq(projectMetricSnapshots.projectId, req.projectId!),
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

    // The cell: explicit query params, else the cell this snapshot was
    // contributed into (its own sample — still returned without contributor
    // ids, like everything else).
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

    await ensureSeeded(metric.key, req.companyId!, req.user!.id);
    const contributedAccess = await hasContributed(req.companyId!, metric.key);
    const accessLevel = contributedAccess ? "contributed" : "seed_only";
    const rows = await cellRows(
      metric.key,
      assetClass,
      region,
      contributedAccess ? "contributed" : "seed",
    );
    const values = rows.map((r) => r.value);
    const suppressed = contributedAccess && values.length < MIN_SAMPLE_N;
    const computable = values.length > 0 && !suppressed;
    const seedIncluded = !contributedAccess && values.length > 0;
    const disclosures = baseDisclosures(rows, suppressed, seedIncluded);
    if (accessLevel === "seed_only") disclosures.push(UPGRADE_NOTE);

    let percentile: number | null = null;
    let distribution: Record<string, unknown> = {
      n: values.length,
      ...(suppressed ? { suppressed: true as const } : {}),
    };
    let outlier: { adverse: boolean; side: "above_p90" | "below_p10" | null; signalRaised: boolean } | null =
      null;

    if (computable) {
      const sorted = [...values].sort((a, b) => a - b);
      const p10 = round2(percentileOf(sorted, 10));
      const median = round2(percentileOf(sorted, 50));
      const p90 = round2(percentileOf(sorted, 90));
      percentile = percentileRank(values, snapshot.value);
      distribution = { n: values.length, p10, median, p90 };

      // Adverse tail depends on the metric's direction of merit. Signals are
      // raised ONLY against a genuinely contributed distribution with a
      // defensible n — never against illustrative seed data (#831 honesty).
      const adverse = metric.higherIsBetter ? snapshot.value < p10 : snapshot.value > p90;
      const side = adverse ? (metric.higherIsBetter ? "below_p10" : "above_p90") : null;
      let signalRaised = false;
      if (
        adverse &&
        contributedAccess &&
        values.length >= MIN_SAMPLE_N &&
        !(await outlierSignalExists(req.companyId!, req.projectId!, snapshot.id))
      ) {
        const signalId = newId("sig");
        const threshold = metric.higherIsBetter ? p10 : p90;
        await app.db.insert(signals).values({
          id: signalId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          detector: OUTLIER_DETECTOR,
          severity: "medium",
          confidence: round2(Math.min(0.95, values.length / (values.length + MIN_SAMPLE_N))),
          title: `${metric.name} is beyond the adverse ${
            metric.higherIsBetter ? "p10" : "p90"
          } of its benchmark cell`,
          explanation:
            `The project's latest "${metric.key}" snapshot is ${snapshot.value} ${snapshot.unit}, ` +
            `${metric.higherIsBetter ? "below" : "beyond"} the ${
              metric.higherIsBetter ? "10th" : "90th"
            } percentile (${threshold} ${metric.unit}) of the contributed ${assetClass}/${region} ` +
            `distribution (n=${values.length}, median ${median} ${metric.unit}). The distribution ` +
            "is built from anonymized contributed samples; investigate whether the project's " +
            "figure reflects scope, data quality, or genuine adverse performance.",
          evidenceRefs: {
            snapshotId: snapshot.id,
            metric: metric.key,
            assetClass,
            region,
            value: snapshot.value,
            threshold,
            side,
            n: values.length,
            percentile,
          },
        });
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "create",
          objectType: "benchmark_outlier_signal",
          objectId: signalId,
          payload: {
            snapshotId: snapshot.id,
            metric: metric.key,
            assetClass,
            region,
            value: snapshot.value,
            threshold,
            n: values.length,
          },
          storePayload: true,
        });
        signalRaised = true;
      }
      outlier = { adverse, side, signalRaised };
    }

    return {
      metric: metric.key,
      assetClass,
      region,
      snapshotId: snapshot.id,
      value: snapshot.value,
      unit: snapshot.unit,
      computedAt: snapshot.createdAt,
      accessLevel,
      minSampleN: MIN_SAMPLE_N,
      percentile,
      distribution,
      ...(outlier ? { outlier } : {}),
      seedIncluded,
      ...(seedIncluded ? { healthWarning: SEED_METHODOLOGY } : {}),
      disclosures,
    };
  });
};
