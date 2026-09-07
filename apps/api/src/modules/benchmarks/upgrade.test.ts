/**
 * Benchmarks — the fixes the adversarial review demanded.
 *
 *  1. A published membership criterion must be one the QUERY APPLIED. The RCF
 *     routes accepted ?sizeBand= and ?procurementRoute=, echoed them, and stored
 *     them on the forecast row as the class the uplift came from — while the
 *     cell key was only (metric, assetClass, region, currency). A citable record
 *     asserting a narrower class than the number came from is the exact failure
 *     "published membership criteria" exists to prevent.
 *  2. The adverse-outlier signal had no caller. Moving it off the GET was right;
 *     leaving it with nothing but a button nobody had built meant no signal was
 *     ever raised in the running product. There is a sweep now.
 *  3. The class register read every tenant's contributed samples with a flat
 *     limit(5000) and no ORDER BY, so past that it silently described a
 *     non-deterministic subset. It aggregates in SQL now.
 *  4. The supersede path was a select-then-update, so a race could leave two
 *     live samples for one project in one cell — which is the rule the min-n
 *     and dominance arithmetic rests on.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import {
  benchmarkContributions,
  benchmarkSamples,
  projectMetricSnapshots,
  projects,
  punchItems,
  signals,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { assessCounts, MAX_CONTRIBUTOR_SHARE } from "./pool.js";
import { MIN_SAMPLE_N } from "./metrics.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let outlierProject: string;

const url = (p: string) => `/api/v1${p}`;

/**
 * The cell used throughout: punch_open_rate / commercial / GB. Five other
 * companies contribute, so the caller's own sample never lifts it over min-n.
 * Two of them declare size band `25m_100m` + `two_stage`; the rest declare
 * nothing, so a narrowed query MUST see a different (and here, suppressed) n.
 */
const OTHERS = [
  { value: 10, sizeBand: "25m_100m", procurementRoute: "two_stage" },
  { value: 15, sizeBand: "25m_100m", procurementRoute: "two_stage" },
  { value: 20, sizeBand: null, procurementRoute: null },
  { value: 25, sizeBand: null, procurementRoute: null },
  { value: 30, sizeBand: null, procurementRoute: null },
] as const;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);

  outlierProject = newId("prj");
  await app.db.insert(projects).values({
    id: outlierProject,
    companyId: owner.companyId,
    name: "Outlier",
  });
  // every punch item open → 100% open rate, well beyond the cell's p90
  await app.db.insert(punchItems).values(
    [1, 2, 3].map((number) => ({
      id: newId("pun"),
      companyId: owner.companyId,
      projectId: outlierProject,
      number,
      title: `Open ${number}`,
      status: "open",
      createdBy: owner.userId,
    })),
  );

  await app.db.insert(benchmarkSamples).values(
    OTHERS.map((o, i) => ({
      id: newId("bms"),
      metric: "punch_open_rate",
      assetClass: "commercial",
      region: "GB",
      value: o.value,
      unit: "%",
      source: "contributed",
      contributorCompanyId: `co_other_${i}`,
      contributorProjectId: `prj_other_${i}`,
      sizeBand: o.sizeBand,
      procurementRoute: o.procurementRoute,
      dataYear: 2024,
    })),
  );
}, 300_000);

afterAll(async () => {
  await built.close();
});

/** Contribute the project's latest snapshot, unlocking contributed access. */
async function contributeSnapshot(projectId: string): Promise<string> {
  const snap = await app.inject({
    method: "POST",
    url: url(`/projects/${projectId}/benchmarks/snapshots`),
    headers: owner.headers,
    payload: { metric: "punch_open_rate" },
  });
  expect(snap.statusCode).toBe(201);
  const snapshotId = (snap.json() as { id: string }).id;
  const contributed = await app.inject({
    method: "POST",
    url: url(`/projects/${projectId}/benchmarks/snapshots/${snapshotId}/contribute`),
    headers: owner.headers,
    payload: { assetClass: "commercial", region: "GB" },
  });
  expect(contributed.statusCode).toBe(201);
  return snapshotId;
}

/* ------------------------------------------------------------------ */
/* assessCounts — the register's arithmetic, without the rows          */
/* ------------------------------------------------------------------ */

describe("assessCounts", () => {
  it("counts distinct contributors and excludes the caller's own samples", () => {
    const v = assessCounts(
      [
        { contributorCompanyId: "me", samples: 4 },
        { contributorCompanyId: "a", samples: 1 },
        { contributorCompanyId: "b", samples: 1 },
      ],
      "me",
    );
    expect(v.ownSamples).toBe(4);
    expect(v.sampleSize).toBe(2);
    expect(v.contributors).toBe(2);
    expect(v.describable).toBe(false);
    expect(v.reasons.join(" ")).toContain(`${MIN_SAMPLE_N} are required`);
  });

  it("refuses a cell one contributor dominates", () => {
    const counts = [
      { contributorCompanyId: "a", samples: 6 },
      ...["b", "c", "d", "e"].map((id) => ({ contributorCompanyId: id, samples: 1 })),
    ];
    const v = assessCounts(counts, null);
    expect(v.contributors).toBe(5);
    expect(v.describable).toBe(false);
    expect(v.reasons.join(" ")).toContain("of the samples in this cell");
    expect(MAX_CONTRIBUTOR_SHARE).toBe(0.5);
  });

  it("describes a cell that satisfies every rule", () => {
    const v = assessCounts(
      ["a", "b", "c", "d", "e"].map((id) => ({ contributorCompanyId: id, samples: 1 })),
      "me",
    );
    expect(v.describable).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.sampleSize).toBe(5);
  });

  it("an empty cell is not describable and says nothing false about it", () => {
    const v = assessCounts([], "me");
    expect(v.sampleSize).toBe(0);
    expect(v.describable).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Reference-class narrowing (#833-838, #846-849)                      */
/* ------------------------------------------------------------------ */

describe("reference-class membership criteria", () => {
  beforeAll(async () => {
    await contributeSnapshot(outlierProject);
  }, 120_000);

  it("REGRESSION: a narrowed forecast narrows the QUERY, not just the label", async () => {
    const wide = await app.inject({
      method: "GET",
      url: url(
        "/benchmarks/reference-classes/forecast?metric=punch_open_rate&assetClass=commercial&region=GB",
      ),
      headers: owner.headers,
    });
    expect(wide.statusCode).toBe(200);
    const wideBody = wide.json() as { sampleSize: number; sizeBand: string | null };
    expect(wideBody.sampleSize).toBe(5);
    expect(wideBody.sizeBand).toBeNull();

    const narrow = await app.inject({
      method: "GET",
      url: url(
        "/benchmarks/reference-classes/forecast?metric=punch_open_rate&assetClass=commercial" +
          "&region=GB&sizeBand=25m_100m&procurementRoute=two_stage",
      ),
      headers: owner.headers,
    });
    expect(narrow.statusCode).toBe(200);
    const narrowBody = narrow.json() as {
      sampleSize: number;
      sizeBand: string | null;
      procurementRoute: string | null;
      contributors: number;
      p80Uplift: number | null;
      disclosures: string[];
    };
    // Only two contributors declared that band, so the narrowed cell is
    // suppressed — which is the honest answer, and provably NOT the wide one.
    expect(narrowBody.contributors).toBe(2);
    expect(narrowBody.sampleSize).toBe(0);
    expect(narrowBody.p80Uplift).toBeNull();
    expect(narrowBody.sizeBand).toBe("25m_100m");
    expect(narrowBody.disclosures.join(" ")).toContain("Membership criteria applied");
    expect(narrowBody.disclosures.join(" ")).toContain("size band 25m_100m");
  });

  it("stores only criteria the query applied on the citable forecast row", async () => {
    const stored = await app.inject({
      method: "POST",
      url: url(`/projects/${outlierProject}/benchmarks/rcf`),
      headers: owner.headers,
      payload: {
        metric: "punch_open_rate",
        assetClass: "commercial",
        region: "GB",
        budget: 1_000_000,
      },
    });
    expect(stored.statusCode).toBe(201);
    const body = stored.json() as {
      forecast: {
        sizeBand: string | null;
        procurementRoute: string | null;
        referenceClass: string;
        sampleSize: number;
        disclosures: string[];
      };
      narrowingDropped: string[];
    };
    expect(body.forecast.sizeBand).toBeNull();
    expect(body.forecast.procurementRoute).toBeNull();
    expect(body.forecast.sampleSize).toBe(5);
    expect(body.narrowingDropped).toEqual([]);
    expect(body.forecast.disclosures.join(" ")).toContain("Membership criteria applied");
  });

  it("refuses to store a forecast for a class it cannot describe", async () => {
    const res = await app.inject({
      method: "POST",
      url: url(`/projects/${outlierProject}/benchmarks/rcf`),
      headers: owner.headers,
      payload: {
        metric: "punch_open_rate",
        assetClass: "commercial",
        region: "GB",
        sizeBand: "25m_100m",
        procurementRoute: "two_stage",
      },
    });
    expect(res.statusCode).toBe(422);
  });
});

/* ------------------------------------------------------------------ */
/* The class register                                                  */
/* ------------------------------------------------------------------ */

describe("reference-class register", () => {
  it("aggregates in SQL and reports contributors, n and the suppression reason", async () => {
    const res = await app.inject({
      method: "GET",
      url: url("/benchmarks/reference-classes?metric=punch_open_rate"),
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      classes: {
        id: string;
        metric: string;
        contributors: number;
        sampleSize: number;
        ownSamplesExcluded: number;
        describable: boolean;
        reasons: string[];
      }[];
      truncated: boolean;
      membership: string;
    };
    expect(body.truncated).toBe(false);
    const cell = body.classes.find((c) => c.id.startsWith("punch_open_rate|commercial|GB"));
    expect(cell).toBeDefined();
    // Five other contributors; the caller's own contributed sample is excluded
    // from the n it is shown, and counted separately.
    expect(cell!.contributors).toBe(5);
    expect(cell!.sampleSize).toBe(5);
    expect(cell!.ownSamplesExcluded).toBe(1);
    expect(cell!.describable).toBe(true);
    // The register no longer promises a narrowing it might not apply.
    expect(body.membership).toContain("applied to the query");
  });

  it("does not leak contributor ids", async () => {
    const res = await app.inject({
      method: "GET",
      url: url("/benchmarks/reference-classes"),
      headers: owner.headers,
    });
    expect(res.body).not.toContain("co_other_");
    expect(res.body).not.toContain("prj_other_");
    expect(res.body).not.toContain(owner.companyId);
  });
});

/* ------------------------------------------------------------------ */
/* The outlier sweep (#843)                                            */
/* ------------------------------------------------------------------ */

describe("benchmarks.outlier-evaluation", () => {
  it("REGRESSION: raises the signal nobody pressed a button for", async () => {
    const before = await app.db
      .select({ id: signals.id })
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "benchmark_outlier")),
      );
    expect(before).toHaveLength(0);

    const status = await app.scheduler.runNow("benchmarks.outlier-evaluation");
    expect(status.state).toBe("succeeded");

    const after = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "benchmark_outlier")),
      );
    expect(after).toHaveLength(1);
    expect(after[0]!.projectId).toBe(outlierProject);
    expect(after[0]!.severity).toBe("medium");
    expect(after[0]!.explanation).toContain("distinct contributors");
  });

  it("is idempotent — a second sweep raises nothing new", async () => {
    const status = await app.scheduler.runNow("benchmarks.outlier-evaluation");
    expect(status.state).toBe("succeeded");
    const after = await app.db
      .select({ id: signals.id })
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "benchmark_outlier")),
      );
    expect(after).toHaveLength(1);
  });

  it("compare now reports the raised signal rather than claiming one exists", async () => {
    const res = await app.inject({
      method: "GET",
      url: url(`/projects/${outlierProject}/benchmarks/compare?metric=punch_open_rate`),
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      outlier: { adverse: boolean; signalRaised: boolean; signalId: string | null; wouldRaise: boolean };
    };
    expect(body.outlier.adverse).toBe(true);
    expect(body.outlier.signalRaised).toBe(true);
    expect(body.outlier.signalId).not.toBeNull();
    expect(body.outlier.wouldRaise).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* One live sample per project per cell                                */
/* ------------------------------------------------------------------ */

describe("contribution supersede", () => {
  it("a re-contribution supersedes rather than pads, and leaves ONE live sample", async () => {
    // Change the project's figure so the second snapshot differs.
    await app.db.insert(punchItems).values({
      id: newId("pun"),
      companyId: owner.companyId,
      projectId: outlierProject,
      number: 99,
      title: "Closed",
      status: "closed",
      createdBy: owner.userId,
    });
    await contributeSnapshot(outlierProject);

    const live = await app.db
      .select({ id: benchmarkSamples.id })
      .from(benchmarkSamples)
      .where(
        and(
          eq(benchmarkSamples.metric, "punch_open_rate"),
          eq(benchmarkSamples.contributorProjectId, outlierProject),
          isNull(benchmarkSamples.supersededAt),
        ),
      );
    expect(live).toHaveLength(1);

    const claims = await app.db
      .select({ id: benchmarkContributions.id })
      .from(benchmarkContributions)
      .where(eq(benchmarkContributions.contributorProjectId, outlierProject));
    expect(claims).toHaveLength(1);
  });

  it("REGRESSION: a concurrent re-contribution cannot leave two live samples", async () => {
    // Two snapshots, contributed at the same instant. The supersede is claimed
    // with a conditional UPDATE, so the loser supersedes ITS OWN sample and
    // reports a conflict instead of leaving a second live row behind.
    const snapshotIds: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const snap = await app.inject({
        method: "POST",
        url: url(`/projects/${outlierProject}/benchmarks/snapshots`),
        headers: owner.headers,
        payload: { metric: "punch_open_rate" },
      });
      expect(snap.statusCode).toBe(201);
      snapshotIds.push((snap.json() as { id: string }).id);
    }
    const results = await Promise.all(
      snapshotIds.map((id) =>
        app.inject({
          method: "POST",
          url: url(`/projects/${outlierProject}/benchmarks/snapshots/${id}/contribute`),
          headers: owner.headers,
          payload: { assetClass: "commercial", region: "GB" },
        }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 201).length).toBeGreaterThanOrEqual(1);

    const live = await app.db
      .select({ id: benchmarkSamples.id })
      .from(benchmarkSamples)
      .where(
        and(
          eq(benchmarkSamples.metric, "punch_open_rate"),
          eq(benchmarkSamples.contributorProjectId, outlierProject),
          isNull(benchmarkSamples.supersededAt),
        ),
      );
    expect(live).toHaveLength(1);

    // …and the distribution the platform describes still counts five others.
    const dist = await app.inject({
      method: "GET",
      url: url("/benchmarks/distributions?metric=punch_open_rate&assetClass=commercial&region=GB"),
      headers: owner.headers,
    });
    expect(dist.statusCode).toBe(200);
    expect((dist.json() as { distribution: { n: number } }).distribution.n).toBe(5);
  });

  it("a superseded snapshot keeps its own contributed sample id for the record", async () => {
    const snaps = await app.db
      .select()
      .from(projectMetricSnapshots)
      .where(eq(projectMetricSnapshots.projectId, outlierProject));
    const contributedSnaps = snaps.filter((s) => s.contributedSampleId !== null);
    expect(contributedSnaps.length).toBeGreaterThanOrEqual(2);
    const ids = new Set(contributedSnaps.map((s) => s.contributedSampleId));
    expect(ids.size).toBe(contributedSnaps.length);
  });
});
