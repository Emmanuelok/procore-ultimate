/**
 * Predictive insights — the engine, and the door it opens onto.
 *
 * The engine tests are pure arithmetic. The integration tests exist for one
 * reason: the forecast reads the SAME cross-tenant cells the benchmarks module
 * gates behind contribute-to-access (#855), and for a while it did not apply
 * that gate — so a company that had never contributed a sample could read other
 * tenants' contributed P50/P80 uplift through the analytics forecast, the
 * health-inputs endpoint and the nightly job. The reference class needs nothing
 * but projects.settings to resolve, so it cost the caller nothing at all.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { benchmarkSamples, contracts, projects, variations } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import type { PoolVerdict } from "../benchmarks/pool.js";
import { buildForecast, exceedanceProbability, upliftAt } from "./forecast.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
/** the tenant under test — it contributes nothing until the last test */
let subject: TestActor;
let subjectProject: string;

const url = (p: string) => `/api/v1${p}`;

/** Values only the contributed pool holds — seed values are all under 60. */
const CONTRIBUTED_VALUES = [90, 91, 92, 93, 94];

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  subject = await registerActor(app);

  subjectProject = newId("prj");
  await app.db.insert(projects).values({
    id: subjectProject,
    companyId: subject.companyId,
    name: "Forecast Subject",
    // The class resolves from settings alone — no contribution required.
    settings: { assetClass: "commercial", region: "GB" },
  });
  await app.db.insert(contracts).values({
    id: newId("con"),
    companyId: subject.companyId,
    projectId: subjectProject,
    name: "Main works",
    form: "jct_sbc",
    status: "executed",
    contractSum: 1_000_000,
    currency: "GBP",
    createdBy: subject.userId,
  });
  await app.db.insert(variations).values({
    id: newId("var"),
    companyId: subject.companyId,
    projectId: subjectProject,
    number: 1,
    title: "Growth",
    status: "agreed",
    agreedValue: 120_000, // 12% growth to date
    currency: "GBP",
    createdBy: subject.userId,
  });

  // Five OTHER companies' contributed samples in the same cell.
  await app.db.insert(benchmarkSamples).values(
    CONTRIBUTED_VALUES.map((value, i) => ({
      id: newId("bms"),
      metric: "cost_growth_pct",
      assetClass: "commercial",
      region: "GB",
      value,
      unit: "%",
      source: "contributed",
      contributorCompanyId: `co_other_${i}`,
      contributorProjectId: `prj_other_${i}`,
      dataYear: 2024,
    })),
  );

  // Materialise the illustrative seed cell, so the seed fallback is reachable.
  const seeded = await app.inject({
    method: "GET",
    url: url("/benchmarks/distributions?metric=cost_growth_pct&assetClass=commercial&region=GB"),
    headers: subject.headers,
  });
  expect(seeded.statusCode).toBe(200);
}, 120_000);

afterAll(async () => {
  await built.close();
});

const emptyPool: PoolVerdict = {
  rows: [],
  values: [],
  totalSamples: 0,
  contributors: 0,
  ownSamples: 0,
  suppressed: false,
  reasons: [],
  disclosures: [],
};

const poolOf = (values: number[], contributors = values.length): PoolVerdict => ({
  ...emptyPool,
  rows: values.map((value) => ({
    value,
    dataYear: 2024,
    methodology: null,
    contributorCompanyId: null,
  })),
  values,
  totalSamples: values.length,
  contributors,
});

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

describe("forecast arithmetic", () => {
  it("exceedance is the empirical share strictly above the threshold", () => {
    expect(exceedanceProbability([1, 2, 3, 4], 2)).toBe(0.5);
    expect(exceedanceProbability([1, 2, 3, 4], 4)).toBe(0);
    expect(exceedanceProbability([], 2)).toBeNull();
  });

  it("uplift is the percentile of the sample", () => {
    expect(upliftAt([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(upliftAt([], 80)).toBeNull();
  });

  it("reports a probability with its basis when the inputs are present", () => {
    const f = buildForecast({
      kind: "cost_overrun",
      growthToDate: 10,
      growthReasons: [],
      growthInputs: {},
      pool: poolOf([5, 12, 18, 25, 40]),
      referenceClass: "commercial/GB",
      seedOnly: false,
    });
    expect(f.probability).toBe(0.8); // 12, 18, 25 and 40 exceed 10 — four of five
    expect(f.p50Uplift).toBe(18);
    expect(f.sampleSize).toBe(5);
    expect(f.seedOnly).toBe(false);
    expect(f.contributedAccess).toBe(true);
    expect(f.basis).toContain("comparable project");
  });

  it("returns null with reasons — never 0 — when there is no distribution", () => {
    const f = buildForecast({
      kind: "schedule_overrun",
      growthToDate: 10,
      growthReasons: [],
      growthInputs: {},
      pool: emptyPool,
      referenceClass: "commercial/GB",
      seedOnly: false,
    });
    expect(f.probability).toBeNull();
    expect(f.p80Uplift).toBeNull();
    expect(f.reasons.join(" ")).toContain("No comparable samples");
    expect(f.basis).toContain("Not computable");
  });

  it("a suppressed pool yields nothing and carries the suppression reason", () => {
    const f = buildForecast({
      kind: "cost_overrun",
      growthToDate: 10,
      growthReasons: [],
      growthInputs: {},
      pool: { ...poolOf([5, 12], 2), suppressed: true, reasons: ["Only 2 distinct contributors"] },
      referenceClass: "commercial/GB",
      seedOnly: false,
    });
    expect(f.probability).toBeNull();
    expect(f.sampleSize).toBe(0);
    expect(f.reasons.join(" ")).toContain("Only 2 distinct contributors");
  });

  it("labels a seed-only forecast as a worked example", () => {
    const f = buildForecast({
      kind: "cost_overrun",
      growthToDate: 5,
      growthReasons: [],
      growthInputs: {},
      pool: poolOf([5, 12, 18, 25, 40]),
      referenceClass: "commercial/GB",
      seedOnly: true,
      contributedAccess: false,
    });
    expect(f.seedOnly).toBe(true);
    expect(f.contributedAccess).toBe(false);
    expect(f.basis).toContain("ILLUSTRATIVE seed samples");
  });
});

/* ------------------------------------------------------------------ */
/* Contribute-to-access across the tenant boundary (#855)              */
/* ------------------------------------------------------------------ */

describe("analytics forecast honours contribute-to-access", () => {
  interface ForecastBody {
    forecasts: {
      kind: string;
      probability: number | null;
      p50Uplift: number | null;
      p80Uplift: number | null;
      sampleSize: number;
      seedOnly: boolean;
      contributedAccess: boolean;
      reasons: string[];
    }[];
  }

  const forecastFor = async (actor: TestActor, projectId: string) => {
    const res = await app.inject({
      method: "GET",
      url: url(`/projects/${projectId}/analytics/forecast?kind=cost_overrun`),
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as ForecastBody).forecasts[0]!;
  };

  it("REGRESSION: a non-contributing tenant is not shown the contributed pool", async () => {
    const f = await forecastFor(subject, subjectProject);
    expect(f.contributedAccess).toBe(false);
    expect(f.seedOnly).toBe(true);
    expect(f.reasons.join(" ")).toContain("#855");
    // The seed cell tops out at 21.4; the contributed cell is 90-94. Reading
    // either the uplift or the probability off the contributed pool would show
    // here immediately.
    expect(f.p80Uplift).not.toBeNull();
    expect(f.p80Uplift!).toBeLessThan(60);
    expect(CONTRIBUTED_VALUES).not.toContain(f.p50Uplift);
  });

  it("the same gate applies to health-inputs, which feeds the intelligence layer", async () => {
    const res = await app.inject({
      method: "GET",
      url: url(`/projects/${subjectProject}/analytics/health-inputs`),
      headers: subject.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { metrics: Record<string, number | null> };
    // A number IS produced (from the labelled seed pool), and it is not the
    // contributed one: 12% growth is beyond every seed value bar the top two,
    // whereas against 90-94 it would be a certainty.
    expect(body.metrics["costOverrunProbability"]).not.toBe(1);
  });

  it("contributing unlocks the contributed pool for the same project", async () => {
    const snap = await app.inject({
      method: "POST",
      url: url(`/projects/${subjectProject}/benchmarks/snapshots`),
      headers: subject.headers,
      payload: { metric: "cost_growth_pct" },
    });
    expect(snap.statusCode).toBe(201);
    const snapshotId = (snap.json() as { id: string }).id;
    const contributed = await app.inject({
      method: "POST",
      url: url(
        `/projects/${subjectProject}/benchmarks/snapshots/${snapshotId}/contribute`,
      ),
      headers: subject.headers,
      payload: { assetClass: "commercial", region: "GB" },
    });
    expect(contributed.statusCode).toBe(201);

    const f = await forecastFor(subject, subjectProject);
    expect(f.contributedAccess).toBe(true);
    expect(f.seedOnly).toBe(false);
    // Five other contributors, the tenant's own sample self-excluded.
    expect(f.sampleSize).toBe(5);
    expect(f.p50Uplift).toBe(92);
    // 12% growth against a pool of 90-94: every comparable project finished
    // above it.
    expect(f.probability).toBe(1);
  });

  it("keeps a tenant out of another tenant's forecast entirely", async () => {
    const outsider = await registerActor(app);
    const res = await app.inject({
      method: "GET",
      url: url(`/projects/${subjectProject}/analytics/forecast`),
      headers: outsider.headers,
    });
    expect([400, 403, 404]).toContain(res.statusCode);
  });

  it("the nightly job stores forecasts and does not widen access either", async () => {
    const before = await app.db
      .select({ id: benchmarkSamples.id })
      .from(benchmarkSamples)
      .where(
        and(
          eq(benchmarkSamples.metric, "cost_growth_pct"),
          eq(benchmarkSamples.source, "contributed"),
        ),
      );
    const status = await app.scheduler.runNow("analytics.forecasts");
    expect(status.state).toBe("succeeded");
    // The sweep must not have written into the shared pool as a side effect.
    const after = await app.db
      .select({ id: benchmarkSamples.id })
      .from(benchmarkSamples)
      .where(
        and(
          eq(benchmarkSamples.metric, "cost_growth_pct"),
          eq(benchmarkSamples.source, "contributed"),
        ),
      );
    expect(after.length).toBe(before.length);

    const stored = await app.inject({
      method: "GET",
      url: url(`/projects/${subjectProject}/analytics/forecasts`),
      headers: subject.headers,
    });
    expect(stored.statusCode).toBe(200);
    expect((stored.json() as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });
});
