/**
 * The cross-tenant sample pool and its anonymity rules (spec Vol II R
 * #831, #853-855).
 *
 * WHAT WAS WRONG, precisely. Suppression counted ROWS: `values.length <
 * MIN_SAMPLE_N`. Nothing stopped one company contributing five snapshots of the
 * same project into the same cell, so a company holding one real neighbour's
 * sample could compute five snapshots of its own, lift the cell over the
 * threshold, and read min / max / p25 / median / p75 / p90 and a ten-bin
 * histogram of a six-value set in which it knew five values. The neighbour's
 * exact figure falls out of that arithmetic. The schema comment promised
 * "fewer than MIN_SAMPLE_N contributors"; the code delivered "fewer than
 * MIN_SAMPLE_N rows".
 *
 * THE RULES NOW, all four of which must hold before a cell is described:
 *
 *  1. k-ANONYMITY BY DISTINCT CONTRIBUTOR — at least MIN_SAMPLE_N distinct
 *     contributor companies, counted from `contributor_company_id`, which is
 *     read for counting and never returned.
 *  2. ONE LIVE SAMPLE PER PROJECT PER CELL — enforced upstream by the supersede
 *     model (benchmark_contributions has a unique index on
 *     project+metric+class+region), so a contributor cannot pad a cell at all.
 *  3. NO DOMINANT CONTRIBUTOR — no single contributor may hold half or more of
 *     the samples; a cell one company mostly wrote is that company's number
 *     wearing a distribution's clothes.
 *  4. SELF-EXCLUSION — the caller's OWN samples are removed from the figures it
 *     is shown against. Comparing yourself with a pool that contains you is
 *     circular, and with a small n it is also the disclosure: n − (mine) must
 *     still satisfy rule 1.
 *
 * WHAT IS DELIBERATELY NOT DONE: differential privacy noise. Adding calibrated
 * Laplace noise to a percentile would make the platform state a number that is
 * not the number — and this codebase's rule, everywhere else, is that a figure
 * it cannot compute honestly is reported as absent with reasons rather than
 * approximated. Suppression is the control that keeps that rule; the epsilon
 * budget is recorded here as the upgrade path, not pretended.
 */
import { and, eq, isNull } from "drizzle-orm";
import { benchmarkSamples } from "@constructos/db";
import type { Db } from "../../lib/db.js";
import { MIN_SAMPLE_N } from "./metrics.js";

/** No contributor may hold this share or more of a cell. */
export const MAX_CONTRIBUTOR_SHARE = 0.5;

export interface PoolRow {
  value: number;
  dataYear: number | null;
  methodology: string | null;
  /** counting only — never returned by any route */
  contributorCompanyId: string | null;
}

export interface CellKey {
  metric: string;
  assetClass: string;
  region: string;
  /** null for unitless metrics; money metrics are keyed by currency */
  currency: string | null;
}

export interface PoolVerdict {
  /** samples that may be described (self-excluded, live only) */
  rows: PoolRow[];
  values: number[];
  /** total live samples in the cell before self-exclusion */
  totalSamples: number;
  /** distinct contributor companies after self-exclusion */
  contributors: number;
  /** samples contributed by the caller, excluded from `rows` */
  ownSamples: number;
  suppressed: boolean;
  /** why it is suppressed; empty when it is not */
  reasons: string[];
  /** every rule applied, published so the suppression is auditable (#831) */
  disclosures: string[];
}

/** Distinct contributors, treating a null id (seed rows) as one contributor. */
export function distinctContributors(rows: readonly PoolRow[]): number {
  return new Set(rows.map((r) => r.contributorCompanyId ?? "__seed__")).size;
}

/** The largest share any one contributor holds of the sample. */
export function dominantShare(rows: readonly PoolRow[]): number {
  if (rows.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = r.contributorCompanyId ?? "__seed__";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Math.max(...counts.values()) / rows.length;
}

/**
 * Apply the anonymity rules to a set of live samples. Pure — the database read
 * is the caller's job, so every branch is unit-testable without one.
 *
 * `viewerCompanyId` is the caller: their samples are excluded from the figures
 * they are shown, and counted separately so the disclosure can say so.
 */
export function assessPool(
  all: readonly PoolRow[],
  viewerCompanyId: string | null,
  options: { seed: boolean } = { seed: false },
): PoolVerdict {
  const own = viewerCompanyId
    ? all.filter((r) => r.contributorCompanyId === viewerCompanyId)
    : [];
  const rows = viewerCompanyId
    ? all.filter((r) => r.contributorCompanyId !== viewerCompanyId)
    : [...all];
  const contributors = distinctContributors(rows);
  const share = dominantShare(rows);
  const reasons: string[] = [];
  const disclosures: string[] = [
    `Sample size n=${rows.length} (#831 — sample size is always disclosed).`,
  ];

  if (options.seed) {
    // Seed rows are fictional and belong to nobody, so none of the anonymity
    // rules protect anything; they are shown at any n and labelled as such.
    return {
      rows,
      values: rows.map((r) => r.value),
      totalSamples: all.length,
      contributors,
      ownSamples: own.length,
      suppressed: false,
      reasons: [],
      disclosures,
    };
  }

  disclosures.push(
    `Anonymity rules: at least ${MIN_SAMPLE_N} distinct contributing companies, no contributor ` +
      `holding ${Math.round(MAX_CONTRIBUTOR_SHARE * 100)}% or more of the cell, one live sample ` +
      "per project per cell, and your own samples excluded from the figures you are compared with.",
  );
  if (own.length > 0) {
    disclosures.push(
      `${own.length} sample(s) you contributed are excluded from this distribution, so the ` +
        "comparison is against other contributors only.",
    );
  }
  if (contributors < MIN_SAMPLE_N) {
    reasons.push(
      `Only ${contributors} distinct contributing compan${contributors === 1 ? "y" : "ies"} in ` +
        `this cell; ${MIN_SAMPLE_N} are required before a distribution can be described.`,
    );
  }
  if (rows.length > 0 && share >= MAX_CONTRIBUTOR_SHARE) {
    reasons.push(
      `One contributor holds ${Math.round(share * 100)}% of the samples in this cell, so its ` +
        "percentiles would largely describe that contributor.",
    );
  }
  const suppressed = reasons.length > 0;
  if (suppressed) disclosures.push(...reasons);

  return {
    rows,
    values: rows.map((r) => r.value),
    totalSamples: all.length,
    contributors,
    ownSamples: own.length,
    suppressed,
    reasons,
    disclosures,
  };
}

/**
 * Live samples of one cell for one source. `superseded_at is null` is what
 * makes rule 2 real at read time as well as at write time — a superseded row
 * is kept as the record of what was contributed and never described again.
 *
 * `contributor_company_id` IS selected here, and this is the only place it is:
 * it is used to count contributors and to exclude the caller's own rows, and it
 * never leaves this module (see viewSample in index.ts).
 */
export async function readCell(
  db: Db,
  key: CellKey,
  source: "contributed" | "seed",
): Promise<PoolRow[]> {
  const clauses = [
    eq(benchmarkSamples.metric, key.metric),
    eq(benchmarkSamples.assetClass, key.assetClass),
    eq(benchmarkSamples.region, key.region),
    eq(benchmarkSamples.source, source),
    isNull(benchmarkSamples.supersededAt),
    // A money metric's cell is keyed by currency: percentiles over mixed
    // currencies describe the exchange rate, not the construction cost.
    key.currency ? eq(benchmarkSamples.currency, key.currency) : isNull(benchmarkSamples.currency),
  ];
  return db
    .select({
      value: benchmarkSamples.value,
      dataYear: benchmarkSamples.dataYear,
      methodology: benchmarkSamples.methodology,
      contributorCompanyId: benchmarkSamples.contributorCompanyId,
    })
    .from(benchmarkSamples)
    .where(and(...clauses));
}
