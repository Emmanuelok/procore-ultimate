import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();

/**
 * M11 — Independent benchmarking (spec Vol II Domain V; Vol III module map).
 *
 * Cross-project cost/schedule/safety distributions built from anonymized
 * contributed samples plus clearly-labelled seed data. The contract is
 * "contribute to access" (#855): a company sees a metric's distribution only
 * for metrics it has contributed a sample to (seed-only metrics excepted, and
 * marked as such). Distribution queries suppress any cell with fewer than
 * MIN_SAMPLE_N contributors and always disclose sample size (#831) — a
 * benchmark that hides its n is an opinion, not a benchmark.
 */
export const benchmarkSamples = pgTable(
  "benchmark_samples",
  {
    id: text("id").primaryKey(),
    /** BenchmarkMetric key from the code-resident metric registry */
    metric: text("metric").notNull(),
    /** AssetClass */
    assetClass: text("asset_class").notNull(),
    /** ISO 3166-1 alpha-2 country, or a coarser declared region key */
    region: text("region").notNull(),
    value: doublePrecision("value").notNull(),
    /** unit copied from the metric registry at write time (denormalized on purpose) */
    unit: text("unit").notNull(),
    /** BenchmarkSampleSource: contributed | seed */
    source: text("source").notNull(),
    /**
     * ANONYMIZATION BOUNDARY — the contributing company, kept ONLY to enforce
     * contribute-to-access and min-n counting. Never exposed through any read
     * path; distribution queries return aggregates only. Null for seed rows.
     */
    contributorCompanyId: text("contributor_company_id"),
    /** the contributing project, same rules as contributorCompanyId */
    contributorProjectId: text("contributor_project_id"),
    /** year the underlying figure was current (for staleness disclosure) */
    dataYear: integer("data_year"),
    /** how the value was derived, shown verbatim in disclosures */
    methodology: text("methodology"),
    /* ---------------- WP-ANALYTICS: the anonymity repair ---------------- */
    /**
     * ISO 4217 of the contributed figure, for metrics whose unit carries money.
     * A cell is keyed by currency as well as metric/assetClass/region: mixing
     * NGN and GBP into one distribution produces percentiles that describe the
     * exchange rate, not the construction cost. Null for unitless metrics
     * (percentages, days, rates).
     */
    currency: text("currency"),
    /**
     * Reference-class dimensions (#833-838): a distribution is only a
     * comparison if the members are comparable. Both are declared at
     * contribution and published as the class's membership criteria.
     */
    sizeBand: text("size_band"),
    procurementRoute: text("procurement_route"),
    /**
     * SUPERSEDE MODEL. A company holds at most ONE live sample per
     * (project, metric, cell): contributing a fresh snapshot supersedes the
     * previous one instead of adding to it, so a contributor cannot pad a cell
     * with repeated snapshots of the same project to lift min-n suppression.
     * Superseded rows are kept — the record of what was contributed and when
     * is itself evidence — but never enter a distribution.
     */
    supersededAt: timestamp("superseded_at", { withTimezone: true, mode: "string" }),
    supersededBySampleId: text("superseded_by_sample_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("benchmark_samples_metric_idx").on(t.metric, t.assetClass, t.region),
    index("benchmark_samples_contributor_idx").on(t.contributorCompanyId),
    index("benchmark_samples_cell_idx").on(t.metric, t.assetClass, t.region, t.currency),
    index("benchmark_samples_live_idx").on(t.metric, t.supersededAt),
  ],
);

/**
 * One row per metric whose illustrative seed cells have been materialised.
 * The primary key IS the lock: two tenants querying a metric's distribution
 * for the first time race, and only the insert that wins the key may write the
 * seed rows. Without it the loser also inserts and the cell reports double the
 * samples it holds.
 */
export const benchmarkSeedMarkers = pgTable("benchmark_seed_markers", {
  metric: text("metric").primaryKey(),
  rowsInserted: integer("rows_inserted").default(0).notNull(),
  materialisedBy: text("materialised_by"),
  createdAt: createdAt(),
});

/**
 * A project's own computed metric values, snapshotted at contribution time so
 * the comparison ("your project vs the distribution") is against the number
 * that was actually contributed, not a moving target.
 */
export const projectMetricSnapshots = pgTable(
  "project_metric_snapshots",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    metric: text("metric").notNull(),
    value: doublePrecision("value").notNull(),
    unit: text("unit").notNull(),
    /** the inputs the computation used: { field: value } for auditability */
    inputs: jsonb("inputs").$type<Record<string, unknown>>().default({}).notNull(),
    /** benchmark_samples.id created from this snapshot, once contributed */
    contributedSampleId: text("contributed_sample_id"),
    /** currency of `value` when the metric's unit carries money; else null */
    currency: text("currency"),
    /**
     * The adverse-outlier signal raised against THIS snapshot, claimed with a
     * conditional update so two concurrent evaluations cannot both raise one.
     */
    outlierSignalId: text("outlier_signal_id"),
    computedBy: text("computed_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("project_metric_snapshots_project_idx").on(t.projectId),
    index("project_metric_snapshots_metric_idx").on(t.companyId, t.metric),
  ],
);

/**
 * A reference-class forecast (#833-838, #846-849): given a project's budget and
 * its reference class — asset class × size band × procurement route × region —
 * the empirical distribution of cost/schedule growth achieved by comparable
 * projects, expressed as exceedance probabilities and the P50/P80 uplift an
 * owner should carry. Stored so the number a contingency decision was taken
 * against is reproducible, with the class membership it was drawn from.
 */
export const benchmarkForecasts = pgTable(
  "benchmark_forecasts",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    /** cost_growth_pct | schedule_growth_pct */
    metric: text("metric").notNull(),
    referenceClass: text("reference_class").notNull(),
    assetClass: text("asset_class").notNull(),
    region: text("region").notNull(),
    sizeBand: text("size_band"),
    procurementRoute: text("procurement_route"),
    /** the budget the uplift was applied to, and its currency */
    budget: doublePrecision("budget"),
    currency: text("currency"),
    /** number of DISTINCT contributors behind the class */
    contributorCount: integer("contributor_count").default(0).notNull(),
    sampleSize: integer("sample_size").default(0).notNull(),
    p50Uplift: doublePrecision("p50_uplift"),
    p80Uplift: doublePrecision("p80_uplift"),
    /** [{ threshold: 10, probability: 0.42 }, …] */
    exceedance: jsonb("exceedance").$type<unknown[]>().default([]).notNull(),
    /** membership criteria + suppression decisions, published verbatim */
    disclosures: jsonb("disclosures").$type<string[]>().default([]).notNull(),
    computedBy: text("computed_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("benchmark_forecasts_project_idx").on(t.projectId, t.metric, t.createdAt),
    index("benchmark_forecasts_company_idx").on(t.companyId),
  ],
);

/**
 * Contribution accounting per (contributor, cell). One live sample per
 * project is enforced by the supersede model above; this row is what makes
 * "no single contributor may dominate a cell" cheap to check and auditable.
 */
export const benchmarkContributions = pgTable(
  "benchmark_contributions",
  {
    id: text("id").primaryKey(),
    contributorCompanyId: text("contributor_company_id").notNull(),
    contributorProjectId: text("contributor_project_id").notNull(),
    metric: text("metric").notNull(),
    assetClass: text("asset_class").notNull(),
    region: text("region").notNull(),
    currency: text("currency"),
    sampleId: text("sample_id").notNull(),
    supersededSampleId: text("superseded_sample_id"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("benchmark_contributions_live_uq").on(
      t.contributorProjectId,
      t.metric,
      t.assetClass,
      t.region,
    ),
    index("benchmark_contributions_cell_idx").on(t.metric, t.assetClass, t.region),
  ],
);
