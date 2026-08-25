import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
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
    createdAt: createdAt(),
  },
  (t) => [
    index("benchmark_samples_metric_idx").on(t.metric, t.assetClass, t.region),
    index("benchmark_samples_contributor_idx").on(t.contributorCompanyId),
  ],
);

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
    computedBy: text("computed_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("project_metric_snapshots_project_idx").on(t.projectId),
    index("project_metric_snapshots_metric_idx").on(t.companyId, t.metric),
  ],
);
