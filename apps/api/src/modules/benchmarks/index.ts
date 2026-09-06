import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, isNull } from "drizzle-orm";
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
import { forEachCompany } from "../../lib/scheduler.js";
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
  assessCounts,
  assessPool,
  hasContributed as poolHasContributed,
  MAX_CONTRIBUTOR_SHARE,
  readCell,
  type CellKey,
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
 * The class register reads one row per (class, contributor). The cap bounds a
 * cross-tenant read; hitting it is disclosed rather than silently truncating.
 */
const REGISTER_GROUP_LIMIT = 2000;

/** Snapshots examined per company per outlier sweep. */
const OUTLIER_SWEEP_LIMIT = 1000;

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
  const hasContributed = (companyId: string, metric: string): Promise<boolean> =>
    poolHasContributed(app.db, companyId, metric);

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
  async function ensureSeeded(
    metric: string,
    companyId: string,
    actorId: string | null,
  ): Promise<void> {
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
  ): Promise<{ verdict: PoolVerdict; seedIncluded: boolean; narrowingDropped: string[] }> {
    if (!contributedAccess) {
      // Seed rows carry no size band and no procurement route, so a narrowed
      // request cannot be answered from them. The narrowing is DROPPED and the
      // caller is told, rather than a wider class being passed off as the
      // narrow one it asked for.
      const dropped = [
        ...(key.sizeBand ? ["sizeBand"] : []),
        ...(key.procurementRoute ? ["procurementRoute"] : []),
      ];
      const seed = await readCell(
        app.db,
        { ...key, currency: null, sizeBand: null, procurementRoute: null },
        "seed",
      );
      return {
        verdict: assessPool(seed, viewerCompanyId, { seed: true }),
        seedIncluded: seed.length > 0,
        narrowingDropped: dropped,
      };
    }
    const contributed = await readCell(app.db, key, "contributed");
    return {
      verdict: assessPool(contributed, viewerCompanyId),
      seedIncluded: false,
      narrowingDropped: [],
    };
  }

  /**
   * The published membership criteria (#833-838, #846-849), stated as the
   * predicate the query actually ran. Every criterion named here is in the
   * WHERE clause; nothing that was not applied is named.
   */
  function membershipNote(
    assetClass: string,
    region: string,
    currency: string | null,
    applied: { sizeBand: string | null; procurementRoute: string | null },
  ): string {
    const parts = [`asset class ${assetClass}`, `region ${region}`];
    if (currency) parts.push(`currency ${currency}`);
    if (applied.sizeBand) parts.push(`size band ${applied.sizeBand}`);
    if (applied.procurementRoute) parts.push(`procurement route ${applied.procurementRoute}`);
    return `Membership criteria applied to this class: ${parts.join(", ")}.`;
  }

  /** The membership criteria a describeCell() answer was actually drawn from. */
  function appliedMembership(
    q: { sizeBand?: string; procurementRoute?: string },
    narrowingDropped: string[],
  ): { sizeBand: string | null; procurementRoute: string | null } {
    return {
      sizeBand: narrowingDropped.includes("sizeBand") ? null : (q.sizeBand ?? null),
      procurementRoute: narrowingDropped.includes("procurementRoute")
        ? null
        : (q.procurementRoute ?? null),
    };
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
        /*
         * The supersede is CLAIMED, not assumed. Two concurrent contributions
         * for the same project and cell both read the same prior row; an
         * unconditional update let both of them insert a live sample and both
         * point the contributions row at their own, leaving one live sample
         * with nothing claiming it — exactly the "one live sample per project
         * per cell" rule the dominance and min-n arithmetic rests on. Only the
         * request whose UPDATE still sees the prior sample id wins.
         */
        const claimed = await app.db
          .update(benchmarkContributions)
          .set({ sampleId, supersededSampleId: priorContribution.sampleId })
          .where(
            and(
              eq(benchmarkContributions.id, priorContribution.id),
              eq(benchmarkContributions.sampleId, priorContribution.sampleId),
            ),
          )
          .returning({ id: benchmarkContributions.id });
        if (claimed.length === 0) {
          await app.db
            .update(benchmarkSamples)
            .set({ supersededAt: new Date().toISOString() })
            .where(eq(benchmarkSamples.id, sampleId));
          throw conflict(
            "Another contribution for this project and cell was recorded at the same instant; " +
              "re-read the snapshot and try again.",
          );
        }
        await app.db
          .update(benchmarkSamples)
          .set({
            supersededAt: new Date().toISOString(),
            supersededBySampleId: sampleId,
          })
          .where(eq(benchmarkSamples.id, priorContribution.sampleId));
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
    userId: string | null,
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
  async function evaluateSnapshot(
    snapshot: typeof projectMetricSnapshots.$inferSelect,
    actorId: string | null,
    overrides: Partial<z.infer<typeof compareQuery>> = {},
  ) {
    const companyId = snapshot.companyId;
    const projectId = snapshot.projectId;
    const c = await compareSnapshot(companyId, projectId, actorId, {
      ...overrides,
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
      companyId,
      projectId,
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
      companyId,
      actorId,
      action: "create",
      objectType: "benchmark_outlier_signal",
      objectId: signalId,
      projectId,
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
  }

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
      return evaluateSnapshot(snapshot, req.user!.id, body);
    },
  );

  /**
   * The sweep that makes the signal real (#843).
   *
   * Moving signal-raising off the GET fixed a write-on-read, but left the
   * signal depending on somebody pressing a button: an adverse outlier that
   * nobody looked at was never raised at all. Every project's LATEST snapshot
   * per metric is evaluated here on a schedule, so the compare view, the
   * health inputs and the attention feed describe a signal the platform
   * actually raises. Idempotent by construction: the conditional claim on
   * `outlier_signal_id` means a snapshot can carry at most one signal, and a
   * snapshot that already carries one is filtered out before it is read.
   */
  app.scheduler.register({
    name: "benchmarks.outlier-evaluation",
    description:
      "Evaluate each project's latest benchmark snapshot per metric and raise the adverse-outlier signal when the contributed cell supports one",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: false,
    run: async ({ db }) =>
      forEachCompany(db, async (companyId) => {
        const rows = await app.db
          .select()
          .from(projectMetricSnapshots)
          .where(eq(projectMetricSnapshots.companyId, companyId))
          .orderBy(desc(projectMetricSnapshots.createdAt), desc(projectMetricSnapshots.id))
          .limit(OUTLIER_SWEEP_LIMIT);
        /*
         * Only the NEWEST snapshot of a (project, metric) is a live figure;
         * older ones are history and must not raise anything. The signal state
         * is checked AFTER that reduction, not in the WHERE clause: filtering
         * unsignalled rows first would surface yesterday's snapshot of a
         * project whose current one already carries a signal, and raise a
         * second signal for the same condition.
         */
        const latest = new Map<string, (typeof rows)[number]>();
        for (const row of rows) {
          const key = `${row.projectId}|${row.metric}`;
          if (!latest.has(key)) latest.set(key, row);
        }
        let raised = 0;
        let evaluated = 0;
        for (const snapshot of latest.values()) {
          if (snapshot.outlierSignalId) continue;
          evaluated += 1;
          try {
            const outcome = await evaluateSnapshot(snapshot, null);
            if (outcome.signalRaised) raised += 1;
          } catch {
            // A snapshot whose metric was retired, or whose cell cannot be
            // derived, is skipped: the sweep must not fail a whole tenant.
          }
        }
        return { evaluated, raised };
      }),
  });

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
    /*
     * AGGREGATED IN SQL, NOT IN MEMORY.
     *
     * This used to read every contributed sample on the platform with a flat
     * limit(5000) and no ORDER BY, then group them here — an unbounded
     * cross-tenant scan (plan §6.4) that past 5000 samples silently dropped an
     * arbitrary subset, so the contributor count and the "describable" verdict
     * an operator reads went wrong with nothing disclosing it. One row per
     * (class, contributor) is all the anonymity rules need, the ordering is
     * stable, and a register that HAS hit its cap says so.
     */
    const grouped = await app.db
      .select({
        metric: benchmarkSamples.metric,
        assetClass: benchmarkSamples.assetClass,
        region: benchmarkSamples.region,
        currency: benchmarkSamples.currency,
        contributorCompanyId: benchmarkSamples.contributorCompanyId,
        samples: count(),
      })
      .from(benchmarkSamples)
      .where(
        and(
          eq(benchmarkSamples.source, "contributed"),
          isNull(benchmarkSamples.supersededAt),
          metric ? eq(benchmarkSamples.metric, metric) : undefined,
        ),
      )
      .groupBy(
        benchmarkSamples.metric,
        benchmarkSamples.assetClass,
        benchmarkSamples.region,
        benchmarkSamples.currency,
        benchmarkSamples.contributorCompanyId,
      )
      .orderBy(
        asc(benchmarkSamples.metric),
        asc(benchmarkSamples.assetClass),
        asc(benchmarkSamples.region),
        asc(benchmarkSamples.contributorCompanyId),
      )
      .limit(REGISTER_GROUP_LIMIT + 1);
    const truncated = grouped.length > REGISTER_GROUP_LIMIT;
    const groups = truncated ? grouped.slice(0, REGISTER_GROUP_LIMIT) : grouped;

    const byClass = new Map<
      string,
      { contributorCompanyId: string | null; samples: number }[]
    >();
    const meta = new Map<
      string,
      { metric: string; assetClass: string; region: string; currency: string | null }
    >();
    for (const r of groups) {
      const key = `${r.metric}|${r.assetClass}|${r.region}|${r.currency ?? ""}`;
      const list = byClass.get(key) ?? [];
      list.push({ contributorCompanyId: r.contributorCompanyId, samples: Number(r.samples) });
      byClass.set(key, list);
      meta.set(key, {
        metric: r.metric,
        assetClass: r.assetClass,
        region: r.region,
        currency: r.currency,
      });
    }
    const classes = [...byClass.entries()].map(([key, list]) => {
      const verdict = assessCounts(list, req.companyId!);
      const m = meta.get(key)!;
      return {
        id: key,
        ...m,
        contributors: verdict.contributors,
        sampleSize: verdict.sampleSize,
        ownSamplesExcluded: verdict.ownSamples,
        describable: verdict.describable,
        reasons: verdict.reasons,
      };
    });
    return {
      classes: classes.sort(
        (a, b) => b.contributors - a.contributors || a.id.localeCompare(b.id),
      ),
      truncated,
      ...(truncated
        ? {
            truncationNote:
              `The register lists the first ${REGISTER_GROUP_LIMIT} (class, contributor) groups ` +
              "in a stable order; later classes are not shown. Narrow it with ?metric= to see " +
              "them, rather than reading these counts as the whole pool.",
          }
        : {}),
      minSampleN: MIN_SAMPLE_N,
      maxContributorShare: MAX_CONTRIBUTOR_SHARE,
      membership:
        "A reference class is metric x asset class x region (x currency for money metrics), " +
        "optionally narrowed by size band and procurement route. Narrow it with ?sizeBand= and " +
        "?procurementRoute= on the forecast route: those criteria are then applied to the query " +
        "AND published with the figure. A criterion that could not be applied — seed samples " +
        "carry neither — is dropped from the published class rather than asserted.",
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
    const { verdict, seedIncluded, narrowingDropped } = await describeCell(
      {
        metric: metric.key,
        assetClass: q.assetClass,
        region,
        currency,
        sizeBand: q.sizeBand ?? null,
        procurementRoute: q.procurementRoute ?? null,
      },
      req.companyId!,
      contributedAccess,
    );
    const applied = appliedMembership(q, narrowingDropped);
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
    disclosures.push(membershipNote(q.assetClass, region, currency, applied));
    if (narrowingDropped.length > 0) {
      disclosures.push(
        `The requested ${narrowingDropped.join(" and ")} narrowing was NOT applied: seed samples ` +
          "carry neither, so this figure describes the whole class.",
      );
    }
    return {
      metric: metric.key,
      unit: metric.unit,
      assetClass: q.assetClass,
      region,
      currency,
      sizeBand: applied.sizeBand,
      procurementRoute: applied.procurementRoute,
      requestedSizeBand: q.sizeBand ?? null,
      requestedProcurementRoute: q.procurementRoute ?? null,
      narrowingDropped,
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
      const { verdict, seedIncluded, narrowingDropped } = await describeCell(
        {
          metric: metric.key,
          assetClass: q.assetClass,
          region,
          currency,
          sizeBand: q.sizeBand ?? null,
          procurementRoute: q.procurementRoute ?? null,
        },
        req.companyId!,
        contributedAccess,
      );
      const applied = appliedMembership(q, narrowingDropped);
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
      disclosures.push(membershipNote(q.assetClass, region, currency, applied));
      if (narrowingDropped.length > 0) {
        // The stored row is citable. Storing a criterion the query did not
        // apply would make it a record of a narrower class than the figure
        // came from — precisely what "published membership criteria" exists to
        // prevent — so the unapplied narrowing is dropped from the row and the
        // refusal is disclosed on it.
        disclosures.push(
          `The requested ${narrowingDropped.join(" and ")} narrowing was NOT applied and is ` +
            "therefore not recorded as a membership criterion of this forecast.",
        );
      }
      const id = newId("bfc");
      const referenceClassParts = [
        metric.key,
        q.assetClass,
        region,
        ...(currency ? [currency] : []),
        ...(applied.sizeBand ? [applied.sizeBand] : []),
        ...(applied.procurementRoute ? [applied.procurementRoute] : []),
      ];
      await app.db.insert(benchmarkForecasts).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        metric: metric.key,
        referenceClass: referenceClassParts.join("|"),
        assetClass: q.assetClass,
        region,
        sizeBand: applied.sizeBand,
        procurementRoute: applied.procurementRoute,
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
          sizeBand: applied.sizeBand,
          procurementRoute: applied.procurementRoute,
          narrowingDropped,
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
      return reply.status(201).send({ forecast: row, seedIncluded, narrowingDropped });
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
