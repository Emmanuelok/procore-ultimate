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
 *  4. SELF-KNOWLEDGE — the caller's OWN samples do not count toward rule 1. A
 *     contributor already knows its own figures, so the anonymity set it faces
 *     is the OTHER contributors: n − (mine) must still satisfy rule 1. Its
 *     samples stay IN the described set, though: ADR 0016 defines n as the
 *     cell's contributed sample count and the percentile as the project's rank
 *     "in its cell", and #831's unconditional disclosure is not met by an n
 *     that omits samples the cell holds (a one-sample cell once reported n=0
 *     here). How many of the samples are the caller's own is disclosed instead.
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
  /**
   * Optional narrowing dimensions (#833-838). `undefined`/`null` means "do not
   * narrow"; a value means the WHERE clause carries it. A published membership
   * criterion that the query did not apply would be a lie about where the
   * number came from, so these live on the key, not beside it.
   */
  sizeBand?: string | null;
  procurementRoute?: string | null;
}

export interface PoolVerdict {
  /** live samples in the cell — the described set, the caller's own included */
  rows: PoolRow[];
  values: number[];
  /** total live samples in the cell (equals rows.length; kept for consumers) */
  totalSamples: number;
  /** distinct contributor companies in the cell, the caller included */
  contributors: number;
  /** samples contributed by the caller: in `rows`, disclosed, not counted toward the k floor */
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
 * The suppression reasons the anonymity rules produce, in one place: the
 * row-based verdict (`assessPool`) and the count-based one (`assessCounts`)
 * both draw from it, so the class register and the described cell can never
 * disagree about why a cell is refused. `otherContributors` is the anonymity
 * set the caller faces — distinct contributors excluding the caller — and
 * `share` the largest share any one contributor holds of the WHOLE cell, the
 * caller's own samples included.
 */
function suppressionReasons(input: {
  otherContributors: number;
  share: number;
  sampleSize: number;
  viewerKnown: boolean;
}): string[] {
  const reasons: string[] = [];
  if (input.otherContributors < MIN_SAMPLE_N) {
    const n = input.otherContributors;
    const qualifier = input.viewerKnown ? " other than yours" : "";
    reasons.push(
      `Only ${n} distinct contributing compan${n === 1 ? "y" : "ies"}${qualifier} in this cell; ` +
        `${MIN_SAMPLE_N} are required before a distribution can be described.`,
    );
  }
  if (input.sampleSize > 0 && input.share >= MAX_CONTRIBUTOR_SHARE) {
    reasons.push(
      `One contributor holds ${Math.round(input.share * 100)}% of the samples in this cell, ` +
        "so its percentiles would largely describe that contributor.",
    );
  }
  return reasons;
}

/**
 * Apply the anonymity rules to a set of live samples. Pure — the database read
 * is the caller's job, so every branch is unit-testable without one.
 *
 * `viewerCompanyId` is the caller. Its own samples stay in the described set —
 * the cell is the cell (ADR 0016: n is the cell's sample count and the
 * percentile is the project's rank "in its cell") — but they do not count
 * toward the k-anonymity floor, because a contributor already knows its own
 * figures: the anonymity set it faces is everyone else. How many of the
 * samples are its own is disclosed so the comparison is read correctly.
 */
export function assessPool(
  all: readonly PoolRow[],
  viewerCompanyId: string | null,
  options: { seed: boolean } = { seed: false },
): PoolVerdict {
  const rows = [...all];
  const own = viewerCompanyId
    ? rows.filter((r) => r.contributorCompanyId === viewerCompanyId)
    : [];
  const others = viewerCompanyId
    ? rows.filter((r) => r.contributorCompanyId !== viewerCompanyId)
    : rows;
  const contributors = distinctContributors(rows);
  const otherContributors = distinctContributors(others);
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
    `Anonymity rules: at least ${MIN_SAMPLE_N} distinct contributing companies other than you, ` +
      `no contributor holding ${Math.round(MAX_CONTRIBUTOR_SHARE * 100)}% or more of the cell, ` +
      "and one live sample per project per cell. Your own samples are part of the cell — counted " +
      "in n and in the figures — but do not count toward the contributors the rules require.",
  );
  if (own.length > 0) {
    disclosures.push(
      `${own.length} sample(s) in this cell are your own; they are included in n and in the ` +
        "figures, and are excluded from the count of distinct contributing companies.",
    );
  }
  reasons.push(
    ...suppressionReasons({
      otherContributors,
      share,
      sampleSize: rows.length,
      viewerKnown: viewerCompanyId !== null,
    }),
  );
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
 * The same verdict from COUNTS rather than rows.
 *
 * The class register asks one question of every class in the platform: how many
 * contributors, how many samples, is it describable. Reading every sample row
 * into memory to answer it is an unbounded cross-tenant scan (plan §6.4) — and
 * it silently truncated past its row cap, so contributor counts and the
 * "describable" verdict went quietly wrong. The counts come from a GROUP BY
 * now, and this applies exactly the rules `assessPool` applies to rows — the
 * same SELF-KNOWLEDGE included: the caller's own samples are in `sampleSize`
 * and `contributors`, disclosed as `ownSamples`, and do not count toward the
 * k floor. The register and the described cell therefore never disagree about
 * a cell's n, or about why it is refused.
 */
export function assessCounts(
  counts: readonly { contributorCompanyId: string | null; samples: number }[],
  viewerCompanyId: string | null,
): {
  contributors: number;
  sampleSize: number;
  ownSamples: number;
  describable: boolean;
  reasons: string[];
} {
  const perContributor = new Map<string, number>();
  for (const c of counts) {
    const key = c.contributorCompanyId ?? "__seed__";
    perContributor.set(key, (perContributor.get(key) ?? 0) + c.samples);
  }
  const sampleSize = [...perContributor.values()].reduce((sum, n) => sum + n, 0);
  const own = viewerCompanyId === null ? 0 : (perContributor.get(viewerCompanyId) ?? 0);
  const otherContributors = [...perContributor.keys()].filter(
    (key) => viewerCompanyId === null || key !== viewerCompanyId,
  ).length;
  const share = sampleSize === 0 ? 0 : Math.max(...perContributor.values()) / sampleSize;
  const reasons = suppressionReasons({
    otherContributors,
    share,
    sampleSize,
    viewerKnown: viewerCompanyId !== null,
  });
  return {
    contributors: perContributor.size,
    sampleSize,
    ownSamples: own,
    describable: reasons.length === 0 && sampleSize > 0,
    reasons,
  };
}

/**
 * Live samples of one cell for one source. `superseded_at is null` is what
 * makes rule 2 real at read time as well as at write time — a superseded row
 * is kept as the record of what was contributed and never described again.
 *
 * `contributor_company_id` IS selected here, and this is the only place it is:
 * it is used to count contributors and to tell the caller's own rows apart for
 * disclosure, and it never leaves this module (see viewSample in index.ts).
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
  // Narrowing dimensions are applied when asked for, and only then — so a
  // forecast that PUBLISHES "large / design_build" was actually drawn from it.
  if (key.sizeBand) clauses.push(eq(benchmarkSamples.sizeBand, key.sizeBand));
  if (key.procurementRoute) {
    clauses.push(eq(benchmarkSamples.procurementRoute, key.procurementRoute));
  }
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

/**
 * Contribute-to-access (#855), as a function every reader of the pool can call.
 *
 * It lived only inside the benchmarks plugin, so the analytics forecast — which
 * reads exactly the same contributed cells — did not apply it, and a tenant
 * that had never contributed a sample read other tenants' contributed
 * distribution through GET /projects/:id/analytics/forecast. A door is never
 * allowed to be wider than the room it opens onto, so the check lives beside
 * the read it guards.
 *
 * Contributor ids are read in a WHERE clause for enforcement only and never
 * returned.
 */
export async function hasContributed(
  db: Db,
  companyId: string,
  metric: string,
): Promise<boolean> {
  const rows = await db
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
