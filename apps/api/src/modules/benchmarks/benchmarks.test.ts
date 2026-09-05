import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  benchmarkSamples,
  contracts,
  ledgerEntries,
  paymentClaims,
  projectMetricSnapshots,
  projects,
  punchItems,
  rfis,
  scheduleBaselines,
  schedules,
  signals,
  variations,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { MIN_SAMPLE_N } from "./metrics.js";
import { SEED_DISTRIBUTIONS, SEED_METHODOLOGY } from "./seed.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor; // company A
let rival: TestActor; // company B — isolation + contribute-to-access counterparty
let projA: string; // fully-populated project (all metric inputs present)
let projEmpty: string; // nothing on it — missing-inputs cases
let projOutlier: string; // punch open rate 100% — adverse outlier
let projMid: string; // punch open rate 50% — inside the distribution
let projB: string; // company B project

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  rival = await registerActor(app);

  projA = await makeProject(owner, "Benchmark Full", { gfaM2: 10_000 });
  projEmpty = await makeProject(owner, "Benchmark Empty");
  projOutlier = await makeProject(owner, "Benchmark Outlier");
  projMid = await makeProject(owner, "Benchmark Mid");
  projB = await makeProject(rival, "Rival Project");

  await seedCommercialData(owner, projA);
  await seedScheduleData(owner, projA);
  await seedFieldAndPaymentData(owner, projA);

  // projOutlier: every punch item open → 100% open rate
  await insertPunch(owner, projOutlier, [
    { number: 1, status: "open" },
    { number: 2, status: "open" },
    { number: 3, status: "open" },
  ]);
  // projMid: half open → 50%
  await insertPunch(owner, projMid, [
    { number: 1, status: "open" },
    { number: 2, status: "closed" },
  ]);

  // projB: cost data giving 40% cost growth — far beyond the seed p90
  await app.db.insert(contracts).values({
    id: newId("con"),
    companyId: rival.companyId,
    projectId: projB,
    name: "Main works",
    form: "jct_sbc",
    status: "executed",
    contractSum: 1_000_000,
    currency: "GBP",
    createdBy: rival.userId,
  });
  await app.db.insert(variations).values({
    id: newId("var"),
    companyId: rival.companyId,
    projectId: projB,
    number: 1,
    title: "Scope blow-out",
    status: "agreed",
    agreedValue: 400_000,
    // Same currency as the contract: a money metric refuses a project whose
    // basis spans currencies (see mixedCurrencyReason), which is asserted in
    // its own test below rather than accidentally here.
    currency: "GBP",
    createdBy: rival.userId,
  });
});

afterAll(async () => {
  await built.close();
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

async function makeProject(
  actor: TestActor,
  name: string,
  settings?: Record<string, unknown>,
): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({
    id,
    companyId: actor.companyId,
    name,
    ...(settings ? { settings } : {}),
  });
  return id;
}

async function seedCommercialData(actor: TestActor, projectId: string) {
  await app.db.insert(contracts).values({
    id: newId("con"),
    companyId: actor.companyId,
    projectId,
    name: "Main contract",
    form: "jct_sbc",
    status: "executed",
    contractSum: 1_000_000,
    currency: "GBP",
    createdBy: actor.userId,
  });
  // Draft contracts must NOT count toward the approved budget.
  await app.db.insert(contracts).values({
    id: newId("con"),
    companyId: actor.companyId,
    projectId,
    name: "Draft enabling works",
    form: "jct_sbc",
    status: "draft",
    contractSum: 999_999,
    createdBy: actor.userId,
  });
  await app.db.insert(variations).values({
    id: newId("var"),
    companyId: actor.companyId,
    projectId,
    number: 1,
    title: "Agreed change",
    status: "agreed",
    agreedValue: 50_000,
    currency: "GBP",
    createdBy: actor.userId,
  });
  // Proposed variations are not approved budget.
  await app.db.insert(variations).values({
    id: newId("var"),
    companyId: actor.companyId,
    projectId,
    number: 2,
    title: "Proposed change",
    status: "proposed",
    costEstimate: 100_000,
    currency: "GBP",
    createdBy: actor.userId,
  });
}

async function seedScheduleData(actor: TestActor, projectId: string) {
  const scheduleId = newId("sch");
  await app.db.insert(schedules).values({
    id: scheduleId,
    companyId: actor.companyId,
    projectId,
    name: "Master programme",
    projectStart: "2025-01-01",
    isActive: 1,
    computedFinish: "2025-12-31", // 364 days
    createdBy: actor.userId,
  });
  await app.db.insert(scheduleBaselines).values({
    id: newId("bas"),
    scheduleId,
    projectId,
    name: "As-planned",
    projectStart: "2025-01-01",
    computedFinish: "2025-10-31", // 303 days
    snapshot: [],
    capturedBy: actor.userId,
  });
}

async function seedFieldAndPaymentData(actor: TestActor, projectId: string) {
  const rfi = (number: number, createdAt: string, respondedAt: string) => ({
    id: newId("rfi"),
    companyId: actor.companyId,
    projectId,
    number,
    subject: `RFI ${number}`,
    question: "?",
    status: "answered",
    createdBy: actor.userId,
    createdAt,
    respondedAt,
  });
  await app.db.insert(rfis).values([
    rfi(1, "2025-01-01T00:00:00.000Z", "2025-01-06T00:00:00.000Z"), // 5 days
    rfi(2, "2025-01-01T00:00:00.000Z", "2025-01-11T00:00:00.000Z"), // 10 days
    rfi(3, "2025-02-01T00:00:00.000Z", "2025-02-04T00:00:00.000Z"), // 3 days
  ]);
  await insertPunch(actor, projectId, [
    { number: 1, status: "open" },
    { number: 2, status: "in_progress" },
    { number: 3, status: "closed" },
    { number: 4, status: "void" }, // excluded entirely
  ]);
  const claim = (number: number, servedAt: string, paidAt: string) => ({
    id: newId("pcl"),
    companyId: actor.companyId,
    projectId,
    number,
    regime: "uk_construction_act",
    referenceDate: "2025-01-01",
    claimedAmount: 100_000,
    status: "paid",
    servedAt,
    paidAt,
    createdBy: actor.userId,
  });
  await app.db.insert(paymentClaims).values([
    claim(1, "2025-01-01T00:00:00.000Z", "2025-01-21T00:00:00.000Z"), // 20 days
    claim(2, "2025-02-01T00:00:00.000Z", "2025-03-13T00:00:00.000Z"), // 40 days
  ]);
}

async function insertPunch(
  actor: TestActor,
  projectId: string,
  items: { number: number; status: string }[],
) {
  await app.db.insert(punchItems).values(
    items.map((i) => ({
      id: newId("pun"),
      companyId: actor.companyId,
      projectId,
      number: i.number,
      title: `Punch ${i.number}`,
      status: i.status,
      createdBy: actor.userId,
    })),
  );
}

async function createSnapshot(actor: TestActor, projectId: string, metric: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/benchmarks/snapshots`,
    headers: actor.headers,
    payload: { metric },
  });
}

async function getDistribution(actor: TestActor, qs: string) {
  return app.inject({
    method: "GET",
    url: `/api/v1/benchmarks/distributions?${qs}`,
    headers: actor.headers,
  });
}

async function ledgerCount(companyId: string, objectType: string): Promise<number> {
  const rows = await app.db
    .select({ seq: ledgerEntries.seq })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.companyId, companyId), eq(ledgerEntries.objectType, objectType)));
  return rows.length;
}

async function outlierSignals(companyId: string) {
  return app.db
    .select()
    .from(signals)
    .where(and(eq(signals.companyId, companyId), eq(signals.detector, "benchmark_outlier")));
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

describe("metric registry", () => {
  it("lists all seven metrics with direction, unit and input descriptions", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/benchmarks/metrics",
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      metrics: { key: string; unit: string; higherIsBetter: boolean; inputs: string }[];
      minSampleN: number;
    };
    const keys = body.metrics.map((m) => m.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "cost_per_gfa_m2",
        "cost_growth_pct",
        "schedule_growth_pct",
        "rfi_response_days_median",
        "variation_rate_pct",
        "punch_open_rate",
        "payment_cycle_days_median",
      ]),
    );
    expect(body.minSampleN).toBe(MIN_SAMPLE_N);
    for (const m of body.metrics) {
      expect(typeof m.higherIsBetter).toBe("boolean");
      expect(m.unit.length).toBeGreaterThan(0);
      expect(m.inputs.length).toBeGreaterThan(0);
    }
  });

  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/benchmarks/metrics" });
    expect(res.statusCode).toBe(401);
  });
});

/* ------------------------------------------------------------------ */
/* Snapshots                                                           */
/* ------------------------------------------------------------------ */

describe("snapshots", () => {
  it("computes cost_growth_pct from executed contracts and agreed variations only", async () => {
    const res = await createSnapshot(owner, projA, "cost_growth_pct");
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      value: number;
      unit: string;
      inputs: Record<string, unknown>;
    };
    // (1,050,000 - 1,000,000) / 1,000,000 — draft contract and proposed variation ignored
    expect(body.value).toBe(5);
    expect(body.unit).toBe("%");
    expect(body.inputs["originalContractSum"]).toBe(1_000_000);
    expect(body.inputs["approvedVariationsValue"]).toBe(50_000);
    expect(await ledgerCount(owner.companyId, "benchmark_snapshot")).toBeGreaterThan(0);
  });

  it("computes cost_per_gfa_m2 from the approved budget over settings.gfaM2", async () => {
    const res = await createSnapshot(owner, projA, "cost_per_gfa_m2");
    expect(res.statusCode).toBe(201);
    expect((res.json() as { value: number }).value).toBe(105); // 1,050,000 / 10,000
  });

  it("computes schedule_growth_pct from the earliest baseline vs the active schedule", async () => {
    const res = await createSnapshot(owner, projA, "schedule_growth_pct");
    expect(res.statusCode).toBe(201);
    const body = res.json() as { value: number; inputs: Record<string, unknown> };
    expect(body.value).toBeCloseTo(20.13, 2); // (364 - 303) / 303
    expect(body.inputs["baselineDurationDays"]).toBe(303);
    expect(body.inputs["currentDurationDays"]).toBe(364);
  });

  it("computes rfi_response_days_median over answered RFIs", async () => {
    const res = await createSnapshot(owner, projA, "rfi_response_days_median");
    expect(res.statusCode).toBe(201);
    expect((res.json() as { value: number }).value).toBe(5); // median of 5, 10, 3
  });

  it("computes variation_rate_pct, punch_open_rate and payment_cycle_days_median", async () => {
    const variation = await createSnapshot(owner, projA, "variation_rate_pct");
    expect((variation.json() as { value: number }).value).toBe(5); // 50k / 1M

    const punch = await createSnapshot(owner, projA, "punch_open_rate");
    // open + in_progress = 2 of 3 non-void items; the void item is excluded
    expect((punch.json() as { value: number }).value).toBe(66.67);

    const payment = await createSnapshot(owner, projA, "payment_cycle_days_median");
    expect((payment.json() as { value: number }).value).toBe(30); // median of 20, 40
  });

  it("returns 422 with reasons — never a fabricated number — when inputs are missing", async () => {
    const res = await createSnapshot(owner, projEmpty, "cost_growth_pct");
    expect(res.statusCode).toBe(422);
    const body = res.json() as { details: { reasons: string[] } };
    expect(body.details.reasons.length).toBeGreaterThan(0);
    expect(body.details.reasons[0]).toMatch(/contract/i);

    const gfa = await createSnapshot(owner, projEmpty, "cost_per_gfa_m2");
    expect(gfa.statusCode).toBe(422);
    const gfaBody = gfa.json() as { details: { reasons: string[] } };
    expect(gfaBody.details.reasons.join(" ")).toMatch(/gfaM2/);
  });

  it("rejects an unknown metric with the list of valid keys", async () => {
    const res = await createSnapshot(owner, projA, "cost_per_unicorn");
    expect(res.statusCode).toBe(400);
    const body = res.json() as { details: { validMetrics: string[] } };
    expect(body.details.validMetrics).toContain("cost_growth_pct");
  });

  it("lists snapshots newest-first with metric filtering and pagination shape", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projA}/benchmarks/snapshots`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { metric: string }[]; total: number; page: number };
    expect(body.total).toBe(7);
    expect(body.page).toBe(1);

    const filtered = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projA}/benchmarks/snapshots?metric=cost_growth_pct`,
      headers: owner.headers,
    });
    const filteredBody = filtered.json() as { items: { metric: string }[]; total: number };
    expect(filteredBody.total).toBe(1);
    expect(filteredBody.items[0]!.metric).toBe("cost_growth_pct");
  });

  it("refuses another tenant's project", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projA}/benchmarks/snapshots`,
      headers: rival.headers,
    });
    expect(res.statusCode).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/* Contribution (#853, #855)                                           */
/* ------------------------------------------------------------------ */

let rfiSnapshotId: string;
let rfiSampleId: string;

describe("contribution", () => {
  it("creates an anonymized sample, links it to the snapshot, and ledgers it", async () => {
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projA}/benchmarks/snapshots?metric=rfi_response_days_median`,
      headers: owner.headers,
    });
    rfiSnapshotId = (list.json() as { items: { id: string }[] }).items[0]!.id;

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projA}/benchmarks/snapshots/${rfiSnapshotId}/contribute`,
      headers: owner.headers,
      payload: { assetClass: "hospital", region: "gb", methodology: "Median over answered RFIs" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      alreadyContributed: boolean;
      sample: { id: string; source: string; region: string; value: number };
    };
    expect(body.alreadyContributed).toBe(false);
    expect(body.sample.source).toBe("contributed");
    expect(body.sample.region).toBe("GB"); // normalized
    expect(body.sample.value).toBe(5);
    rfiSampleId = body.sample.id;

    // ANONYMIZATION BOUNDARY: contributor ids never appear in any response.
    expect(res.body).not.toContain(owner.companyId);
    expect(res.body).not.toContain(projA);

    const [snapshot] = await app.db
      .select()
      .from(projectMetricSnapshots)
      .where(eq(projectMetricSnapshots.id, rfiSnapshotId));
    expect(snapshot!.contributedSampleId).toBe(rfiSampleId);
    expect(await ledgerCount(owner.companyId, "benchmark_sample")).toBe(1);
  });

  it("is idempotent per snapshot — re-contributing returns the same sample", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projA}/benchmarks/snapshots/${rfiSnapshotId}/contribute`,
      headers: owner.headers,
      payload: { assetClass: "hospital", region: "GB" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { alreadyContributed: boolean; sample: { id: string } };
    expect(body.alreadyContributed).toBe(true);
    expect(body.sample.id).toBe(rfiSampleId);

    const rows = await app.db
      .select({ id: benchmarkSamples.id })
      .from(benchmarkSamples)
      .where(
        and(
          eq(benchmarkSamples.metric, "rfi_response_days_median"),
          eq(benchmarkSamples.source, "contributed"),
        ),
      );
    expect(rows.length).toBe(1);
    expect(await ledgerCount(owner.companyId, "benchmark_sample")).toBe(1);
  });

  it("rejects an invalid asset class and a missing snapshot", async () => {
    const bad = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projA}/benchmarks/snapshots/${rfiSnapshotId}/contribute`,
      headers: owner.headers,
      payload: { assetClass: "castle", region: "GB" },
    });
    expect(bad.statusCode).toBe(400);

    const missing = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projA}/benchmarks/snapshots/bsn_nope/contribute`,
      headers: owner.headers,
      payload: { assetClass: "hospital", region: "GB" },
    });
    expect(missing.statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* Distributions (#831, #855)                                          */
/* ------------------------------------------------------------------ */

let outlierSnapshotId: string;

describe("distributions", () => {
  it("serves seed-only stats with the verbatim health warning to non-contributors", async () => {
    const res = await getDistribution(
      rival,
      "metric=cost_growth_pct&assetClass=commercial&region=GB",
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      accessLevel: string;
      note: string;
      seedIncluded: boolean;
      healthWarning: string;
      distribution: { n: number; min: number; max: number; median: number; histogram: unknown[] };
      disclosures: string[];
    };
    expect(body.accessLevel).toBe("seed_only");
    expect(body.note).toContain("#855");
    expect(body.seedIncluded).toBe(true);
    expect(body.healthWarning).toBe(SEED_METHODOLOGY);
    expect(body.distribution.n).toBe(10);
    expect(body.distribution.min).toBe(1.5);
    expect(body.distribution.max).toBe(21.4);
    expect(body.distribution.median).toBe(8.75);
    expect(body.distribution.histogram.length).toBe(10);
    expect(body.disclosures.join(" ")).toContain("n=10");
  });

  it("lazily seeds a metric exactly once, deterministically, and ledgers it", async () => {
    const before = await app.db
      .select({ id: benchmarkSamples.id })
      .from(benchmarkSamples)
      .where(
        and(
          eq(benchmarkSamples.metric, "cost_growth_pct"),
          eq(benchmarkSamples.source, "seed"),
        ),
      );
    const expected = SEED_DISTRIBUTIONS["cost_growth_pct"]!.reduce(
      (s, c) => s + c.values.length,
      0,
    );
    expect(before.length).toBe(expected);

    await getDistribution(rival, "metric=cost_growth_pct&assetClass=commercial&region=GB");
    const after = await app.db
      .select({ id: benchmarkSamples.id })
      .from(benchmarkSamples)
      .where(
        and(
          eq(benchmarkSamples.metric, "cost_growth_pct"),
          eq(benchmarkSamples.source, "seed"),
        ),
      );
    expect(after.length).toBe(expected);
    expect(await ledgerCount(rival.companyId, "benchmark_seed")).toBe(1);
  });

  it("rejects an unknown metric", async () => {
    const res = await getDistribution(rival, "metric=nope&assetClass=commercial&region=GB");
    expect(res.statusCode).toBe(400);
  });

  it("suppresses a contributed cell below min-n while ALWAYS disclosing n", async () => {
    // Company A contributed rfi_response_days_median → contributed access,
    // but the hospital/GB cell holds a single sample.
    const res = await getDistribution(
      owner,
      "metric=rfi_response_days_median&assetClass=hospital&region=GB",
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      accessLevel: string;
      seedIncluded: boolean;
      distribution: { n: number; suppressed?: boolean; median?: number };
      disclosures: string[];
    };
    expect(body.accessLevel).toBe("contributed");
    expect(body.distribution.suppressed).toBe(true);
    // The caller's OWN sample is excluded from the figures it is compared
    // against, so the only sample in the cell leaves nothing to describe. That
    // is the anonymity repair: a company must never be shown a distribution it
    // is itself most of.
    expect(body.distribution.n).toBe(0);
    expect(body.distribution.median).toBeUndefined();
    expect(body.seedIncluded).toBe(false);
    expect(body.disclosures.join(" ")).toContain("n=0");
    expect(body.disclosures.join(" ")).toContain("you contributed are excluded");
  });

  it("computes contributed stats over contributed rows only, with no contributor ids anywhere", async () => {
    // Five other (fake) contributors in punch_open_rate commercial/GB…
    await app.db.insert(benchmarkSamples).values(
      [10, 15, 20, 25, 30].map((value, i) => ({
        id: newId("bms"),
        metric: "punch_open_rate",
        assetClass: "commercial",
        region: "GB",
        value,
        unit: "%",
        source: "contributed",
        contributorCompanyId: `co_fake_${i}`,
        contributorProjectId: `prj_fake_${i}`,
        dataYear: 2024,
      })),
    );
    // …and company A contributes its own 100% open-rate snapshot.
    const created = await createSnapshot(owner, projOutlier, "punch_open_rate");
    expect(created.statusCode).toBe(201);
    outlierSnapshotId = (created.json() as { id: string }).id;
    const contributed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projOutlier}/benchmarks/snapshots/${outlierSnapshotId}/contribute`,
      headers: owner.headers,
      payload: { assetClass: "commercial", region: "GB" },
    });
    expect(contributed.statusCode).toBe(201);

    const res = await getDistribution(
      owner,
      "metric=punch_open_rate&assetClass=commercial&region=GB",
    );
    const body = res.json() as {
      accessLevel: string;
      seedIncluded: boolean;
      healthWarning?: string;
      distribution: { n: number; min: number; max: number };
    };
    expect(body.accessLevel).toBe("contributed");
    // Six contributed samples exist in the cell; the caller sees FIVE, because
    // its own is excluded from the population it is compared with. Seed rows
    // for the same cell exist and are excluded too.
    expect(body.distribution.n).toBe(5);
    expect(body.distribution.min).toBe(10);
    expect(body.distribution.max).toBe(30);
    expect(body.seedIncluded).toBe(false);
    expect(body.healthWarning).toBeUndefined();
    expect(res.body).not.toContain("co_fake");
    expect(res.body).not.toContain("prj_fake");
    expect(res.body).not.toContain(owner.companyId);
  });
});

/* ------------------------------------------------------------------ */
/* Compare + outlier signal                                            */
/* ------------------------------------------------------------------ */

describe("compare", () => {
  it("compares against seed-only data without ever raising a signal", async () => {
    const created = await createSnapshot(rival, projB, "cost_growth_pct");
    expect(created.statusCode).toBe(201);
    expect((created.json() as { value: number }).value).toBe(40);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projB}/benchmarks/compare?metric=cost_growth_pct&assetClass=commercial&region=GB`,
      headers: rival.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      accessLevel: string;
      percentile: number;
      healthWarning: string;
      outlier: { adverse: boolean; signalRaised: boolean };
      disclosures: string[];
    };
    expect(body.accessLevel).toBe("seed_only");
    expect(body.percentile).toBe(100); // 40% growth beats every seed value
    expect(body.healthWarning).toBe(SEED_METHODOLOGY);
    expect(body.outlier.adverse).toBe(true);
    expect(body.outlier.signalRaised).toBe(false); // seed data never raises signals
    expect((await outlierSignals(rival.companyId)).length).toBe(0);
    expect(body.disclosures.join(" ")).toContain("#855");
  });

  it("raises a medium benchmark_outlier signal beyond the adverse p90 of a contributed cell", async () => {
    // Cell derived from the snapshot's own contributed sample — no query params.
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projOutlier}/benchmarks/compare?metric=punch_open_rate`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      accessLevel: string;
      assetClass: string;
      region: string;
      value: number;
      distribution: { n: number; p90: number };
      outlier: { adverse: boolean; side: string; signalRaised: boolean };
    };
    expect(body.accessLevel).toBe("contributed");
    expect(body.assetClass).toBe("commercial");
    expect(body.region).toBe("GB");
    expect(body.value).toBe(100);
    expect(body.distribution.n).toBe(5);
    expect(body.value).toBeGreaterThan(body.distribution.p90);
    // A GET NEVER WRITES. Compare reports that a signal WOULD be raised; the
    // raising happens on the explicit evaluate route, where a conditional
    // update on the snapshot makes it exactly-once.
    expect(body.outlier).toMatchObject({
      adverse: true,
      side: "above_p90",
      signalRaised: false,
      wouldRaise: true,
    });
    expect(await outlierSignals(owner.companyId)).toHaveLength(0);

    const evaluated = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projOutlier}/benchmarks/snapshots/${outlierSnapshotId}/evaluate`,
      headers: owner.headers,
      payload: {},
    });
    expect(evaluated.statusCode).toBe(200);
    expect((evaluated.json() as { signalRaised: boolean }).signalRaised).toBe(true);

    const raised = await outlierSignals(owner.companyId);
    expect(raised.length).toBe(1);
    expect(raised[0]!.severity).toBe("medium");
    expect(raised[0]!.confidence).toBeGreaterThan(0);
    expect(raised[0]!.confidence).toBeLessThanOrEqual(0.95);
    expect((raised[0]!.evidenceRefs as { snapshotId: string }).snapshotId).toBe(outlierSnapshotId);
    expect(await ledgerCount(owner.companyId, "benchmark_outlier_signal")).toBe(1);
  });

  it("is idempotent per snapshot — a second evaluation raises nothing new", async () => {
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projOutlier}/benchmarks/snapshots/${outlierSnapshotId}/evaluate`,
      headers: owner.headers,
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    // the signal id is claimed with a conditional update, so the second caller
    // reports the first one rather than writing a duplicate
    expect((await outlierSignals(owner.companyId)).length).toBe(1);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projOutlier}/benchmarks/compare?metric=punch_open_rate`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const outlier = (res.json() as { outlier: { signalRaised: boolean; wouldRaise: boolean } })
      .outlier;
    expect(outlier.signalRaised).toBe(true);
    expect(outlier.wouldRaise).toBe(false);
    expect((await outlierSignals(owner.companyId)).length).toBe(1);
  });

  it("stays quiet for a value inside the distribution", async () => {
    // The other contributors sit at 10, 15, 20, 25 and 30. A project at 20%
    // is squarely inside that spread, so nothing adverse is reported and the
    // evaluate route has nothing to raise.
    const projInside = await makeProject(owner, "Inside the pack");
    await insertPunch(owner, projInside, [
      { number: 1, status: "open" },
      { number: 2, status: "closed" },
      { number: 3, status: "closed" },
      { number: 4, status: "closed" },
      { number: 5, status: "closed" },
    ]);
    const created = await createSnapshot(owner, projInside, "punch_open_rate");
    expect((created.json() as { value: number }).value).toBe(20);
    const snapshotId = (created.json() as { id: string }).id;

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projInside}/benchmarks/compare?metric=punch_open_rate&assetClass=commercial&region=GB`,
      headers: owner.headers,
    });
    const body = res.json() as {
      percentile: number;
      outlier: { adverse: boolean; signalRaised: boolean; wouldRaise: boolean };
    };
    expect(body.outlier.adverse).toBe(false);
    expect(body.outlier.signalRaised).toBe(false);
    expect(body.outlier.wouldRaise).toBe(false);
    expect(body.percentile).toBeLessThan(100);

    const evaluated = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projInside}/benchmarks/snapshots/${snapshotId}/evaluate`,
      headers: owner.headers,
      payload: { assetClass: "commercial", region: "GB" },
    });
    expect(evaluated.statusCode).toBe(200);
    expect((evaluated.json() as { signalRaised: boolean }).signalRaised).toBe(false);
    expect((await outlierSignals(owner.companyId)).length).toBe(1); // unchanged
  });

  it("404s when the project has no snapshot of the metric", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projEmpty}/benchmarks/compare?metric=punch_open_rate&assetClass=commercial&region=GB`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s when no cell is given and the snapshot was never contributed", async () => {
    // A snapshot that exists but was never contributed carries no cell, so a
    // compare with no assetClass/region has nothing to compare against and must
    // say so rather than guessing one.
    const created = await createSnapshot(owner, projMid, "punch_open_rate");
    expect(created.statusCode).toBe(201);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projMid}/benchmarks/compare?metric=punch_open_rate`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(400);
  });
});
