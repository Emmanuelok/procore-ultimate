/**
 * Predictive insights — cost and schedule overrun probability
 * (spec Vol I §6.3 #753-758).
 *
 * THE HONEST SHAPE OF A PREDICTION. This is reference-class forecasting, not a
 * model: the platform does not claim to know what THIS project will do. It
 * knows what comparable projects DID, and states the project's position in that
 * empirical distribution. So every figure returned here carries the class it was
 * drawn from, the number of distinct contributors behind it, and the growth the
 * project has already booked. When the platform does not hold the inputs — no
 * executed contract, no baseline, no comparable class that survives the
 * anonymity rules — the answer is `probability: null` with reasons, never 0 and
 * never a confident-sounding guess.
 *
 * THE ARITHMETIC. Given the project's growth to date `g` and the empirical
 * distribution `D` of final growth achieved by comparable projects:
 *
 *   P(final growth > t)  =  share of D strictly above t          (exceedance)
 *   P50 / P80 uplift     =  the 50th / 80th percentile of D      (what to carry)
 *   probability          =  P(final growth > g), i.e. the chance the project
 *                           is not yet finished growing.
 *
 * That last one is the number a portfolio owner actually asks for: "how likely
 * is this to get worse?". It is only meaningful while the project is live, so
 * the basis says so in prose.
 *
 * DELIBERATELY NOT DONE: a fitted parametric model, or any use of the caller's
 * own historical projects as if they were an independent class. Both would
 * present precision the sample size does not support.
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { analyticsForecasts, benchmarkSamples, projectMetricSnapshots, projects } from "@constructos/db";
import type { ForecastKind } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { forEachCompany } from "../../lib/scheduler.js";
import type { Db } from "../../lib/db.js";
import { metricByKey, percentileOf, round2 } from "../benchmarks/metrics.js";
import { assessPool, readCell, type PoolVerdict } from "../benchmarks/pool.js";

export type ForecastKindKey = ForecastKind;

export const FORECAST_KIND_LIST: readonly ForecastKindKey[] = [
  "cost_overrun",
  "schedule_overrun",
];

/** The benchmark metric each forecast kind reasons over. */
export const FORECAST_METRIC: Record<ForecastKindKey, string> = {
  cost_overrun: "cost_growth_pct",
  schedule_overrun: "schedule_growth_pct",
};

/** Thresholds every forecast reports an exceedance probability for. */
export const EXCEEDANCE_THRESHOLDS = [10, 25, 50] as const;

/* ------------------------------------------------------------------ */
/* Pure arithmetic                                                     */
/* ------------------------------------------------------------------ */

/**
 * Share of the sample strictly above `threshold`, in [0, 1]. Empirical, with
 * no smoothing: with n=8 the answer moves in eighths and the caller is told n
 * so it can judge that for itself.
 */
export function exceedanceProbability(values: readonly number[], threshold: number): number | null {
  if (values.length === 0) return null;
  const above = values.filter((v) => v > threshold).length;
  return round2(above / values.length);
}

/** The uplift to carry at a given confidence: the pth percentile of growth. */
export function upliftAt(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return round2(percentileOf(sorted, p));
}

export interface ForecastComputation {
  kind: ForecastKindKey;
  probability: number | null;
  p50Uplift: number | null;
  p80Uplift: number | null;
  exceedance: { threshold: number; probability: number | null }[];
  referenceClass: string | null;
  sampleSize: number;
  contributors: number;
  basis: string;
  inputs: Record<string, unknown>;
  reasons: string[];
}

/**
 * Turn a growth-to-date figure and a comparable distribution into a forecast.
 * Pure: every branch is unit-testable without a database.
 */
export function buildForecast(input: {
  kind: ForecastKindKey;
  growthToDate: number | null;
  growthReasons: string[];
  growthInputs: Record<string, unknown>;
  pool: PoolVerdict;
  referenceClass: string | null;
  seedOnly: boolean;
}): ForecastComputation {
  const reasons: string[] = [...input.growthReasons];
  const values = input.pool.suppressed ? [] : input.pool.values;
  if (input.pool.suppressed) reasons.push(...input.pool.reasons);
  if (values.length === 0 && !input.pool.suppressed) {
    reasons.push(
      "No comparable samples in this reference class, so there is no distribution to place " +
        "this project in.",
    );
  }
  const computable = values.length > 0 && input.growthToDate !== null;
  const probability = computable
    ? exceedanceProbability(values, input.growthToDate!)
    : null;
  const basis = computable
    ? `${input.pool.contributors} contributor(s), n=${values.length} comparable project(s) in ` +
      `${input.referenceClass ?? "this class"}. The project has booked ` +
      `${round2(input.growthToDate!)}% growth so far; ${Math.round((probability ?? 0) * 100)}% of ` +
      "comparable projects finished above that figure." +
      (input.seedOnly
        ? " These are ILLUSTRATIVE seed samples, not contributed outcomes — treat the figure as a " +
          "worked example until the pool holds real contributions."
        : "")
    : "Not computable: " + (reasons[0] ?? "inputs unavailable") ;
  return {
    kind: input.kind,
    probability,
    p50Uplift: computable ? upliftAt(values, 50) : null,
    p80Uplift: computable ? upliftAt(values, 80) : null,
    exceedance: EXCEEDANCE_THRESHOLDS.map((t) => ({
      threshold: t,
      probability: computable ? exceedanceProbability(values, t) : null,
    })),
    referenceClass: input.referenceClass,
    sampleSize: values.length,
    contributors: input.pool.contributors,
    basis,
    inputs: {
      ...input.growthInputs,
      growthToDatePct: input.growthToDate,
      poolTotalSamples: input.pool.totalSamples,
      ownSamplesExcluded: input.pool.ownSamples,
      seedOnly: input.seedOnly,
    },
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* Database-facing                                                     */
/* ------------------------------------------------------------------ */

/** The class a project's forecast is drawn from, derived from its own settings. */
export async function referenceClassFor(
  db: Db,
  companyId: string,
  projectId: string,
  metric: string,
): Promise<{ assetClass: string | null; region: string | null; source: string }> {
  // First choice: the cell this project has already contributed into — it is
  // the class its own operator declared, and it is what the comparison uses.
  const [own] = await db
    .select({ assetClass: benchmarkSamples.assetClass, region: benchmarkSamples.region })
    .from(benchmarkSamples)
    .where(
      and(
        eq(benchmarkSamples.metric, metric),
        eq(benchmarkSamples.contributorCompanyId, companyId),
        eq(benchmarkSamples.contributorProjectId, projectId),
      ),
    )
    .orderBy(desc(benchmarkSamples.createdAt))
    .limit(1);
  if (own) return { assetClass: own.assetClass, region: own.region, source: "contributed_sample" };

  // Second: the project's declared settings.
  const [project] = await db
    .select({ settings: projects.settings })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .limit(1);
  const settings = (project?.settings ?? {}) as Record<string, unknown>;
  const assetClass = typeof settings["assetClass"] === "string" ? settings["assetClass"] : null;
  const region = typeof settings["region"] === "string" ? settings["region"] : null;
  return { assetClass, region, source: "project_settings" };
}

export interface ForecastRequest {
  companyId: string;
  projectId: string;
  kind: ForecastKindKey;
  assetClass?: string | null;
  region?: string | null;
}

/**
 * Compute one forecast against live data. Reads the project's growth-to-date
 * from the benchmark metric registry (the same computation a snapshot uses, so
 * the two can never disagree) and the comparable distribution from the pool,
 * with the anonymity rules applied.
 */
export async function computeForecast(
  db: Db,
  req: ForecastRequest,
): Promise<ForecastComputation> {
  const metricKey = FORECAST_METRIC[req.kind];
  const metric = metricByKey(metricKey)!;
  const computation = await metric.compute(db, {
    companyId: req.companyId,
    projectId: req.projectId,
  });

  const derived = await referenceClassFor(db, req.companyId, req.projectId, metricKey);
  const assetClass = req.assetClass ?? derived.assetClass;
  const region = req.region ? req.region.trim().toUpperCase() : derived.region;

  if (!assetClass || !region) {
    return buildForecast({
      kind: req.kind,
      growthToDate: computation.value,
      growthReasons: [
        ...computation.reasons,
        "No reference class: declare assetClass and region in project settings, or pass them, " +
          "or contribute a benchmark snapshot so the class can be derived from it.",
      ],
      growthInputs: computation.inputs,
      pool: {
        rows: [],
        values: [],
        totalSamples: 0,
        contributors: 0,
        ownSamples: 0,
        suppressed: false,
        reasons: [],
        disclosures: [],
      },
      referenceClass: null,
      seedOnly: false,
    });
  }

  const key = { metric: metricKey, assetClass, region, currency: null };
  const contributed = await readCell(db, key, "contributed");
  let pool = assessPool(contributed, req.companyId);
  let seedOnly = false;
  if (pool.suppressed || pool.values.length === 0) {
    const seed = await readCell(db, key, "seed");
    if (seed.length > 0) {
      pool = assessPool(seed, req.companyId, { seed: true });
      seedOnly = true;
    }
  }

  return buildForecast({
    kind: req.kind,
    growthToDate: computation.value,
    growthReasons: computation.reasons,
    growthInputs: { ...computation.inputs, referenceClassSource: derived.source },
    pool,
    referenceClass: `${assetClass}/${region}`,
    seedOnly,
  });
}

/** Persist a forecast so the figure a decision was taken against survives. */
export async function storeForecast(
  db: Db,
  input: { companyId: string; projectId: string; computedBy: string | null },
  f: ForecastComputation,
): Promise<string> {
  const id = newId("fct");
  await db.insert(analyticsForecasts).values({
    id,
    companyId: input.companyId,
    projectId: input.projectId,
    kind: f.kind,
    probability: f.probability,
    p50Uplift: f.p50Uplift,
    p80Uplift: f.p80Uplift,
    referenceClass: f.referenceClass,
    sampleSize: f.sampleSize,
    basis: f.basis,
    inputs: { ...f.inputs, exceedance: f.exceedance, contributors: f.contributors },
    reasons: f.reasons,
    computedBy: input.computedBy,
  });
  return id;
}

/**
 * The nightly refresh. Only projects that already hold a metric snapshot are
 * forecast: a project nobody has ever measured has no growth-to-date to place,
 * and computing one for every project in every tenant every night would be a
 * table scan in service of a null.
 */
export function registerForecastJob(app: FastifyInstance): void {
  app.scheduler.register({
    name: "analytics.forecasts",
    description:
      "Refresh cost and schedule overrun forecasts for every project that holds a benchmark snapshot, from the contributed distribution of comparable projects",
    everyMs: 24 * 60 * 60_000,
    runOnBoot: false,
    run: async ({ db }) =>
      forEachCompany(db, async (companyId) => {
        const rows = await db
          .selectDistinct({ projectId: projectMetricSnapshots.projectId })
          .from(projectMetricSnapshots)
          .where(eq(projectMetricSnapshots.companyId, companyId))
          .limit(500);
        let stored = 0;
        for (const row of rows) {
          for (const kind of FORECAST_KIND_LIST) {
            const f = await computeForecast(db, {
              companyId,
              projectId: row.projectId,
              kind,
            });
            // A forecast that could not be computed is not stored: an empty
            // row would look like an answer in the register.
            if (f.probability === null) continue;
            await storeForecast(db, { companyId, projectId: row.projectId, computedBy: null }, f);
            stored += 1;
          }
        }
        if (stored > 0) {
          await appendLedger(db, {
            companyId,
            actorId: null,
            action: "create",
            objectType: "analytics_forecast_sweep",
            objectId: `sweep-${new Date().toISOString().slice(0, 10)}`,
            payload: { projects: rows.length, forecasts: stored },
          });
        }
        return { projects: rows.length, forecasts: stored };
      }),
  });
}
