import type { AssetClass } from "@constructos/shared";

/**
 * Every seed row carries this methodology string verbatim, and every
 * distribution response whose statistics include seed rows repeats it as
 * `healthWarning`. The wording is load-bearing (mirrors the seeded
 * carbon-factor health-warning pattern in esg/carbon.ts): seed data exists
 * so the distribution machinery can be exercised on day one — it is NOT
 * evidence about real projects and must never be quoted as if it were.
 */
export const SEED_METHODOLOGY =
  "Illustrative seed distribution — not derived from real project data";

export interface SeedCell {
  assetClass: AssetClass;
  region: string;
  dataYear: number;
  /** hand-authored plausible spread — deterministic, no RNG */
  values: readonly number[];
}

/**
 * Code-resident starter distributions, lazily materialized into
 * benchmark_samples (source "seed", no contributor ids) the first time a
 * metric's distribution is queried. Values are hand-written to have a
 * plausible order of magnitude and spread for each asset class — nothing
 * more. See SEED_METHODOLOGY.
 */
export const SEED_DISTRIBUTIONS: Readonly<Record<string, readonly SeedCell[]>> = {
  cost_per_gfa_m2: [
    {
      assetClass: "commercial",
      region: "GB",
      dataYear: 2024,
      values: [1850, 2100, 2320, 2480, 2650, 2790, 2950, 3180, 3420, 3900],
    },
    {
      assetClass: "residential",
      region: "GB",
      dataYear: 2024,
      values: [1450, 1620, 1780, 1900, 2050, 2180, 2340, 2520, 2760, 3050],
    },
    {
      assetClass: "hospital",
      region: "GB",
      dataYear: 2023,
      values: [3200, 3550, 3900, 4200, 4550, 4900, 5300, 5750, 6200],
    },
  ],
  cost_growth_pct: [
    {
      assetClass: "commercial",
      region: "GB",
      dataYear: 2024,
      values: [1.5, 3.2, 4.8, 6.5, 8.1, 9.4, 11.2, 13.5, 16.8, 21.4],
    },
    {
      assetClass: "road",
      region: "GB",
      dataYear: 2023,
      values: [4.2, 7.5, 10.8, 14.6, 18.9, 23.5, 28.7, 34.2, 42.6, 55.3],
    },
    {
      assetClass: "hospital",
      region: "GB",
      dataYear: 2023,
      values: [3.8, 6.4, 9.2, 12.7, 15.9, 19.6, 24.8, 30.5, 38.2],
    },
  ],
  schedule_growth_pct: [
    {
      assetClass: "commercial",
      region: "GB",
      dataYear: 2024,
      values: [0, 2.4, 4.6, 6.8, 9.2, 11.8, 14.5, 18.2, 23.6, 30.4],
    },
    {
      assetClass: "road",
      region: "GB",
      dataYear: 2023,
      values: [3.5, 6.8, 10.4, 14.2, 18.6, 23.8, 29.4, 36.5, 45.8, 58.2],
    },
    {
      assetClass: "residential",
      region: "GB",
      dataYear: 2024,
      values: [1.2, 3.6, 5.9, 8.4, 11.2, 14.6, 18.4, 23.2, 29.8],
    },
  ],
  rfi_response_days_median: [
    {
      assetClass: "commercial",
      region: "GB",
      dataYear: 2024,
      values: [3.5, 4.8, 6.2, 7.4, 8.6, 9.8, 11.5, 13.4, 16.2, 20.5],
    },
    {
      assetClass: "hospital",
      region: "GB",
      dataYear: 2023,
      values: [5.2, 6.8, 8.4, 10.2, 12.1, 14.3, 16.8, 19.6, 23.4],
    },
    {
      assetClass: "residential",
      region: "GB",
      dataYear: 2024,
      values: [2.8, 4.1, 5.4, 6.6, 7.9, 9.3, 11.0, 13.2, 15.8, 19.4],
    },
  ],
  variation_rate_pct: [
    {
      assetClass: "commercial",
      region: "GB",
      dataYear: 2024,
      values: [1.8, 3.2, 4.5, 5.8, 7.1, 8.4, 9.9, 11.8, 14.2, 17.6],
    },
    {
      assetClass: "road",
      region: "GB",
      dataYear: 2023,
      values: [3.4, 5.8, 8.2, 10.9, 13.8, 16.9, 20.4, 24.6, 29.8],
    },
    {
      assetClass: "hospital",
      region: "GB",
      dataYear: 2023,
      values: [2.6, 4.4, 6.3, 8.2, 10.4, 12.8, 15.6, 18.9, 23.1, 28.4],
    },
  ],
  punch_open_rate: [
    {
      assetClass: "commercial",
      region: "GB",
      dataYear: 2024,
      values: [8.4, 12.6, 16.8, 21.2, 25.8, 30.6, 35.9, 42.1, 49.6, 58.4],
    },
    {
      assetClass: "residential",
      region: "GB",
      dataYear: 2024,
      values: [10.2, 15.4, 20.5, 25.8, 31.4, 37.2, 43.8, 51.2, 60.1],
    },
    {
      assetClass: "hospital",
      region: "GB",
      dataYear: 2023,
      values: [6.8, 10.4, 14.2, 18.4, 22.9, 27.8, 33.4, 39.8, 47.2, 55.6],
    },
  ],
  payment_cycle_days_median: [
    {
      assetClass: "commercial",
      region: "GB",
      dataYear: 2024,
      values: [18, 23, 28, 32, 37, 42, 48, 55, 64, 76],
    },
    {
      assetClass: "residential",
      region: "GB",
      dataYear: 2024,
      values: [21, 27, 33, 39, 45, 52, 60, 69, 79],
    },
    {
      assetClass: "road",
      region: "GB",
      dataYear: 2023,
      values: [24, 30, 36, 43, 50, 58, 67, 77, 88, 102],
    },
  ],
};
