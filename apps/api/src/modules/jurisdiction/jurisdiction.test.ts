import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  contracts,
  obligations,
  projects,
  schedules,
  scheduleTasks,
  signals,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let stranger: TestActor; // different company entirely — isolation counterparty
let projectId: string;
let contractId: string;
let scheduleId: string;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  stranger = await registerActor(app);
  projectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "Cross-Border Rail Package",
  });
  contractId = newId("ctr");
  await app.db.insert(contracts).values({
    id: contractId,
    companyId: owner.companyId,
    projectId,
    name: "Main Works Contract",
    form: "fidic_red",
    currency: "USD",
    contractSum: 100_000,
    createdBy: owner.userId,
  });
  scheduleId = newId("sch");
  await app.db.insert(schedules).values({
    id: scheduleId,
    companyId: owner.companyId,
    projectId,
    name: "Baseline",
    projectStart: todayISO(),
    createdBy: owner.userId,
  });
});

afterAll(async () => {
  await built.close();
});

async function makeProject(name: string): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({ id, companyId: owner.companyId, name });
  return id;
}

async function makeTask(pid: string, name: string, startDate: string | null): Promise<string> {
  const id = newId("tsk");
  await app.db.insert(scheduleTasks).values({
    id,
    scheduleId,
    projectId: pid,
    name,
    durationDays: 10,
    startDate,
  });
  return id;
}

async function createConfig(pid: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/currency-configs`,
    headers: owner.headers,
    payload: {
      baseCurrency: "USD",
      baseDate: "2026-01-01",
      portions: [
        { currency: "USD", proportionPercent: 60, baseRate: 1.0 },
        { currency: "NGN", proportionPercent: 40, baseRate: 0.8 },
      ],
      ...payload,
    },
  });
}

async function postRate(payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/v1/fx-rates",
    headers: owner.headers,
    payload: { source: "market", ...payload },
  });
}

async function createPermit(pid: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/permits`,
    headers: owner.headers,
    payload: {
      kind: "road_closure",
      title: "Northbound carriageway closure",
      authority: "City Highways Authority",
      ...payload,
    },
  });
}

async function listPermits(pid: string, query = "") {
  return app.inject({
    method: "GET",
    url: `/api/v1/projects/${pid}/permits${query}`,
    headers: owner.headers,
  });
}

async function signalsFor(pid: string, detector: string) {
  return app.db
    .select()
    .from(signals)
    .where(and(eq(signals.projectId, pid), eq(signals.detector, detector)));
}

/* ------------------------------------------------------------------ */
/* Currency configurations (#593-595)                                  */
/* ------------------------------------------------------------------ */

describe("currency configurations", () => {
  it("creates a configuration and normalizes currency codes", async () => {
    const pid = await makeProject("Config Create");
    const res = await createConfig(pid, {
      contractId: undefined,
      portions: [
        { currency: "usd", proportionPercent: 70, baseRate: 1 },
        { currency: "eur", proportionPercent: 30, baseRate: 0.9 },
      ],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.baseCurrency).toBe("USD");
    expect(body.rateSource).toBe("contractual");
    expect(body.portions.map((p: { currency: string }) => p.currency)).toEqual(["USD", "EUR"]);
  });

  it("rejects portions that do not sum to 100 and accepts the ±0.01 tolerance", async () => {
    const pid = await makeProject("Portion Sum");
    const bad = await createConfig(pid, {
      portions: [
        { currency: "USD", proportionPercent: 60, baseRate: 1 },
        { currency: "EUR", proportionPercent: 30, baseRate: 0.9 },
      ],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message ?? bad.json().error).toMatch(/sum to 100/);

    const dup = await createConfig(pid, {
      portions: [
        { currency: "USD", proportionPercent: 50, baseRate: 1 },
        { currency: "usd", proportionPercent: 50, baseRate: 1 },
      ],
    });
    expect(dup.statusCode).toBe(400);

    const ok = await createConfig(pid, {
      portions: [
        { currency: "USD", proportionPercent: 33.33, baseRate: 1 },
        { currency: "EUR", proportionPercent: 33.33, baseRate: 0.9 },
        { currency: "GBP", proportionPercent: 33.34, baseRate: 0.8 },
      ],
    });
    expect(ok.statusCode).toBe(201);
  });

  it("validates the linked contract, and lists, patches and deletes", async () => {
    const pid = await makeProject("Config Lifecycle");
    const wrongContract = await createConfig(pid, { contractId });
    expect(wrongContract.statusCode).toBe(400); // contract belongs to another project

    const created = await createConfig(pid, {});
    const id = created.json().id as string;

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/currency-configs`,
      headers: owner.headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(1);

    const badPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/currency-configs/${id}`,
      headers: owner.headers,
      payload: { portions: [{ currency: "USD", proportionPercent: 90, baseRate: 1 }] },
    });
    expect(badPatch.statusCode).toBe(400); // portions revalidated on update

    const goodPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/currency-configs/${id}`,
      headers: owner.headers,
      payload: {
        notes: "Amended by Variation 03",
        portions: [{ currency: "USD", proportionPercent: 100, baseRate: 1 }],
      },
    });
    expect(goodPatch.statusCode).toBe(200);
    expect(goodPatch.json().portions).toHaveLength(1);
    expect(goodPatch.json().notes).toBe("Amended by Variation 03");

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${pid}/currency-configs/${id}`,
      headers: owner.headers,
    });
    expect(del.statusCode).toBe(204);
    const gone = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/currency-configs/${id}`,
      headers: owner.headers,
    });
    expect(gone.statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* FX rate register (#597)                                             */
/* ------------------------------------------------------------------ */

describe("fx rate register", () => {
  it("records a rate, rejects an exact duplicate, and filters the register", async () => {
    const first = await postRate({
      fromCurrency: "usd",
      toCurrency: "zar",
      rate: 18.2,
      rateDate: "2026-05-01",
      source: "central_bank",
      sourceReference: "SARB daily fix",
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().fromCurrency).toBe("USD");

    const dup = await postRate({
      fromCurrency: "USD",
      toCurrency: "ZAR",
      rate: 18.9,
      rateDate: "2026-05-01",
      source: "central_bank",
    });
    expect(dup.statusCode).toBe(409);

    // a different source on the same day is a legitimate second observation
    const other = await postRate({
      fromCurrency: "USD",
      toCurrency: "ZAR",
      rate: 18.4,
      rateDate: "2026-05-01",
      source: "market",
    });
    expect(other.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/fx-rates?from=USD&to=ZAR&from_date=2026-04-01&to_date=2026-06-01",
      headers: owner.headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(2);
  });

  it("returns the latest rate on or before the as-of date, and 404s when none", async () => {
    await postRate({ fromCurrency: "USD", toCurrency: "KES", rate: 128, rateDate: "2026-01-10" });
    await postRate({ fromCurrency: "USD", toCurrency: "KES", rate: 131, rateDate: "2026-03-10" });
    await postRate({ fromCurrency: "USD", toCurrency: "KES", rate: 140, rateDate: "2026-09-10" });

    const asOf = await app.inject({
      method: "GET",
      url: "/api/v1/fx-rates/latest?from=USD&to=KES&asOf=2026-05-01",
      headers: owner.headers,
    });
    expect(asOf.statusCode).toBe(200);
    expect(asOf.json().rate).toBe(131); // never reaches forward to September
    expect(asOf.json().rateDate).toBe("2026-03-10");

    const early = await app.inject({
      method: "GET",
      url: "/api/v1/fx-rates/latest?from=USD&to=KES&asOf=2025-12-31",
      headers: owner.headers,
    });
    expect(early.statusCode).toBe(404);
    expect(early.json().message).toMatch(/on or before 2025-12-31/);
  });
});

/* ------------------------------------------------------------------ */
/* Conversion (#596) and splitting (#596, #599)                        */
/* ------------------------------------------------------------------ */

describe("conversion", () => {
  let pid: string;

  beforeAll(async () => {
    pid = await makeProject("Conversion");
    await createConfig(pid, { baseCurrency: "USD" });
    await postRate({ fromCurrency: "USD", toCurrency: "GHS", rate: 12, rateDate: "2026-02-01" });
    await postRate({ fromCurrency: "USD", toCurrency: "XOF", rate: 600, rateDate: "2026-02-01" });
  });

  async function doConvert(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/fx/convert`,
      headers: owner.headers,
      payload,
    });
  }

  it("converts on a direct rate", async () => {
    const res = await doConvert({ amount: 1000, fromCurrency: "USD", toCurrency: "GHS" });
    expect(res.statusCode).toBe(200);
    expect(res.json().path).toBe("direct");
    expect(res.json().rate).toBe(12);
    expect(res.json().converted).toBe(12_000);
    expect(res.json().rateDate).toBe("2026-02-01");
  });

  it("converts on the reciprocal when only the opposite pair is quoted", async () => {
    const res = await doConvert({ amount: 12_000, fromCurrency: "GHS", toCurrency: "USD" });
    expect(res.statusCode).toBe(200);
    expect(res.json().path).toBe("inverse");
    expect(res.json().converted).toBe(1000);
  });

  it("triangulates through the project's configured base currency", async () => {
    const res = await doConvert({ amount: 12, fromCurrency: "GHS", toCurrency: "XOF" });
    expect(res.statusCode).toBe(200);
    expect(res.json().path).toBe("triangulated");
    expect(res.json().via).toBe("USD");
    expect(res.json().converted).toBe(600); // 12 GHS = 1 USD = 600 XOF
  });

  it("404s when no rate path exists, and never reaches past the as-of date", async () => {
    const none = await doConvert({ amount: 100, fromCurrency: "JPY", toCurrency: "BRL" });
    expect(none.statusCode).toBe(404);
    expect(none.json().message).toMatch(/No rate path/);

    const tooEarly = await doConvert({
      amount: 1000,
      fromCurrency: "USD",
      toCurrency: "GHS",
      asOf: "2026-01-01",
    });
    expect(tooEarly.statusCode).toBe(404);
  });
});

describe("payment splitting and fx exposure", () => {
  it("splits by contractual proportion with hand-checked amounts", async () => {
    const pid = await makeProject("Split Math");
    const cfg = await createConfig(pid, {});
    const configId = cfg.json().id as string;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/currency-configs/${configId}/split`,
      headers: owner.headers,
      payload: { amount: 100_000 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lines[0]).toMatchObject({
      currency: "USD",
      baseAmount: 60_000,
      contractualRate: 1,
      contractualAmount: 60_000,
    });
    expect(body.lines[1]).toMatchObject({
      currency: "NGN",
      baseAmount: 40_000,
      contractualRate: 0.8,
      contractualAmount: 32_000,
    });
    expect(body.totals.baseAmount).toBe(100_000);
    // no NGN rate on file yet — the line is null-safe, not dropped
    expect(body.lines[1].marketRate).toBeNull();
    expect(body.lines[1].marketAmount).toBeNull();
    expect(body.lines[1].fxVariance).toBeNull();
    expect(body.totals.missingRates).toEqual(["NGN"]);
    expect(body.note).toMatch(/No market rate/);
  });

  it("prices the market variance once a rate exists", async () => {
    const pid = await makeProject("Split Variance");
    const cfg = await createConfig(pid, {});
    const configId = cfg.json().id as string;
    await postRate({
      fromCurrency: "USD",
      toCurrency: "NGN",
      rate: 1.0,
      rateDate: "2026-06-01",
      source: "central_bank",
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/currency-configs/${configId}/split`,
      headers: owner.headers,
      payload: { amount: 100_000, asOf: "2026-07-01" },
    });
    expect(res.statusCode).toBe(200);
    const ngn = res.json().lines[1];
    expect(ngn.marketRate).toBe(1);
    expect(ngn.marketAmount).toBe(40_000);
    expect(ngn.fxVariance).toBe(8_000); // 40,000 market - 32,000 contractual
    expect(ngn.baseVariance).toBe(-8_000); // 32,000 USD cost vs a 40,000 USD share
    expect(res.json().totals.missingRates).toEqual([]);
    expect(res.json().note).toBeNull();
  });

  it("values the whole contract sum in the exposure statement (#599)", async () => {
    // the seeded contract lives on the main project and carries a 100,000 sum
    const cfg = await createConfig(projectId, { contractId });
    expect(cfg.statusCode).toBe(201);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/fx/exposure?asOf=2026-07-01`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const item = res.json().items.find((i: { configId: string }) => i.configId === cfg.json().id);
    expect(item.contractSum).toBe(100_000);
    expect(item.contractualValue).toBe(100_000); // both portions quoted at market
    expect(item.marketValue).toBe(92_000); // 60,000 USD + 32,000 USD of NGN
    expect(item.variance).toBe(-8_000);
    expect(res.json().totals[0].baseCurrency).toBe("USD");
  });

  it("notes an unpriceable configuration rather than inventing a number", async () => {
    const pid = await makeProject("Exposure Unpriced");
    await createConfig(pid, {});
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/fx/exposure`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().unpriced).toBe(1);
    expect(res.json().items[0].contractualValue).toBeNull();
    expect(res.json().items[0].notes[0]).toMatch(/No contract linked/);
  });
});

/* ------------------------------------------------------------------ */
/* Permits & consents (#585-591, #608)                                 */
/* ------------------------------------------------------------------ */

describe("permits", () => {
  it("numbers a permit, derives the determination date and raises an obligation", async () => {
    const pid = await makeProject("Permit Create");
    const res = await createPermit(pid, {
      appliedAt: "2026-04-01",
      expectedDays: 56,
      conditions: [{ text: "Submit a traffic management plan", dueDate: "2026-06-01" }],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.number).toBe(1);
    expect(body.status).toBe("applied");
    expect(body.dueAt).toBe("2026-05-27"); // 2026-04-01 + 56 days
    expect(body.obligationId).toBeTruthy();
    expect(body.conditions).toHaveLength(1);
    expect(body.conditions[0].closed).toBe(false);
    expect(body.openConditions).toBe(1);

    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, body.obligationId));
    expect(obl?.sourceClause).toBe("City Highways Authority — Northbound carriageway closure determination");
    expect(obl?.warnDaysBefore).toBe(7);
    expect(obl?.deadline).toContain("2026-05-27");

    // no application date, no clock and no obligation
    const notStarted = await createPermit(pid, { title: "Wayleave", kind: "utility_wayleave" });
    expect(notStarted.json().status).toBe("not_started");
    expect(notStarted.json().dueAt).toBeNull();
    expect(notStarted.json().obligationId).toBeNull();
    expect(notStarted.json().number).toBe(2);
  });

  it("rejects blocking task ids from outside the project", async () => {
    const pid = await makeProject("Permit Task Validation");
    const foreignTask = await makeTask(projectId, "Foreign task", todayISO());
    const res = await createPermit(pid, { blockingTaskIds: [foreignTask] });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/blockingTaskIds/);
  });

  it("satisfies the determination obligation on grant and expires on request", async () => {
    const pid = await makeProject("Permit Grant");
    const created = await createPermit(pid, { appliedAt: todayISO(), expectedDays: 30 });
    const permitId = created.json().id as string;
    const obligationId = created.json().obligationId as string;

    const granted = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/permits/${permitId}/status`,
      headers: owner.headers,
      payload: { status: "granted", expiresAt: addDaysISO(todayISO(), 90), reference: "TMP/2026/114" },
    });
    expect(granted.statusCode).toBe(200);
    expect(granted.json().status).toBe("granted");
    expect(granted.json().grantedAt).toBe(todayISO()); // defaulted
    expect(granted.json().reference).toBe("TMP/2026/114");
    expect(granted.json().daysToExpiry).toBe(90);

    const [obl] = await app.db.select().from(obligations).where(eq(obligations.id, obligationId));
    expect(obl?.status).toBe("satisfied");
  });

  it("discharges a permit condition exactly once", async () => {
    const pid = await makeProject("Permit Conditions");
    const created = await createPermit(pid, {
      conditions: [{ text: "Notify residents 14 days before closure" }, { text: "Reinstate signage" }],
    });
    const permitId = created.json().id as string;
    const conditionId = created.json().conditions[0].id as string;

    const close = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/permits/${permitId}/conditions/${conditionId}/close`,
      headers: owner.headers,
      payload: { note: "Letter drop completed 12 May" },
    });
    expect(close.statusCode).toBe(200);
    expect(close.json().openConditions).toBe(1);
    const closed = close.json().conditions.find((c: { id: string }) => c.id === conditionId);
    expect(closed.closed).toBe(true);
    expect(closed.note).toBe("Letter drop completed 12 May");

    const again = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/permits/${permitId}/conditions/${conditionId}/close`,
      headers: owner.headers,
      payload: {},
    });
    expect(again.statusCode).toBe(400);
  });

  it("recomputes the determination date on patch and filters the register", async () => {
    const pid = await makeProject("Permit Patch");
    const created = await createPermit(pid, { appliedAt: "2026-04-01", expectedDays: 56 });
    const permitId = created.json().id as string;
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/permits/${permitId}`,
      headers: owner.headers,
      payload: { expectedDays: 28 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().dueAt).toBe("2026-04-29");
    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, created.json().obligationId));
    expect(obl?.deadline).toContain("2026-04-29");

    await createPermit(pid, { kind: "visa", title: "Expatriate engineer visa" });
    const filtered = await listPermits(pid, "?kind=visa");
    expect(filtered.json().total).toBe(1);
    expect(filtered.json().items[0].kind).toBe("visa");
  });
});

/* ------------------------------------------------------------------ */
/* Permit sweeps (lazy, idempotent)                                    */
/* ------------------------------------------------------------------ */

describe("permit sweeps", () => {
  it("breaches the obligation and signals once when a determination runs late", async () => {
    const pid = await makeProject("Sweep Determination");
    const created = await createPermit(pid, {
      appliedAt: addDaysISO(todayISO(), -90),
      expectedDays: 30,
    });
    const obligationId = created.json().obligationId as string;

    const first = await listPermits(pid);
    expect(first.statusCode).toBe(200);
    expect(first.json().items[0].overdue).toBe(true);
    expect(first.json().items[0].daysToDue).toBeLessThan(0);

    const [obl] = await app.db.select().from(obligations).where(eq(obligations.id, obligationId));
    expect(obl?.status).toBe("breached");
    let sigs = await signalsFor(pid, "permit_determination_overdue");
    expect(sigs).toHaveLength(1);
    expect(sigs[0]?.severity).toBe("medium");

    // idempotent: re-reading the list does not re-raise
    await listPermits(pid);
    await listPermits(pid, "?overdue=true");
    sigs = await signalsFor(pid, "permit_determination_overdue");
    expect(sigs).toHaveLength(1);

    const overdueOnly = await listPermits(pid, "?overdue=true");
    expect(overdueOnly.json().total).toBe(1);
  });

  it("expires a lapsed grant and signals once", async () => {
    const pid = await makeProject("Sweep Expiry");
    const created = await createPermit(pid, {});
    const permitId = created.json().id as string;
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/permits/${permitId}/status`,
      headers: owner.headers,
      payload: {
        status: "granted",
        grantedAt: addDaysISO(todayISO(), -200),
        expiresAt: addDaysISO(todayISO(), -1),
      },
    });

    const first = await listPermits(pid);
    expect(first.json().items[0].status).toBe("expired");
    let sigs = await signalsFor(pid, "permit_expired");
    expect(sigs).toHaveLength(1);
    expect(sigs[0]?.severity).toBe("high");

    await listPermits(pid);
    sigs = await signalsFor(pid, "permit_expired");
    expect(sigs).toHaveLength(1);
  });

  it("signals once when an ungranted permit blocks imminent work, and maps the risk", async () => {
    const pid = await makeProject("Sweep Programme");
    const soon = await makeTask(pid, "Carriageway excavation", addDaysISO(todayISO(), 10));
    const later = await makeTask(pid, "Landscaping", addDaysISO(todayISO(), 200));
    const created = await createPermit(pid, { blockingTaskIds: [soon, later] });
    const permitId = created.json().id as string;

    await listPermits(pid);
    let sigs = await signalsFor(pid, "permit_blocks_programme");
    expect(sigs).toHaveLength(1);
    expect(sigs[0]?.severity).toBe("high");
    expect(sigs[0]?.title).toMatch(/10 days/);

    await listPermits(pid);
    sigs = await signalsFor(pid, "permit_blocks_programme");
    expect(sigs).toHaveLength(1);

    const risk = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/permits/schedule-risk?days=30`,
      headers: owner.headers,
    });
    expect(risk.statusCode).toBe(200);
    expect(risk.json().total).toBe(1); // the 200-day task is beyond the horizon
    expect(risk.json().items[0]).toMatchObject({
      permitId,
      taskName: "Carriageway excavation",
      daysUntilStart: 10,
      blocked: true,
    });
    expect(risk.json().summary.blockedTasks).toBe(1);

    const wide = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/permits/schedule-risk?days=365`,
      headers: owner.headers,
    });
    expect(wide.json().total).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* Local content / ICV (#612-615)                                      */
/* ------------------------------------------------------------------ */

describe("local content", () => {
  it("records readings, flags a shortfall and returns the series", async () => {
    const pid = await makeProject("Local Content");
    const target = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/local-content-targets`,
      headers: owner.headers,
      payload: {
        name: "Local spend floor",
        jurisdiction: "NG",
        metric: "local_spend_percent",
        targetValue: 45,
      },
    });
    expect(target.statusCode).toBe(201);
    const targetId = target.json().id as string;
    expect(target.json().unit).toBe("%");

    const compliant = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/local-content-targets/${targetId}/readings`,
      headers: owner.headers,
      payload: { readingDate: "2026-03-31", value: 47.5, basis: "Q1 payable ledger" },
    });
    expect(compliant.statusCode).toBe(201);
    expect(compliant.json().compliant).toBe(1);
    expect(compliant.json().gap).toBe(-2.5);
    expect(await signalsFor(pid, "local_content_shortfall")).toHaveLength(0);

    const short = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/local-content-targets/${targetId}/readings`,
      headers: owner.headers,
      payload: { readingDate: "2026-06-30", value: 38 },
    });
    expect(short.statusCode).toBe(201);
    expect(short.json().compliant).toBe(0);
    expect(short.json().gap).toBe(7);
    const sigs = await signalsFor(pid, "local_content_shortfall");
    expect(sigs).toHaveLength(1);
    expect(sigs[0]?.severity).toBe("medium");
    expect(sigs[0]?.title).toMatch(/38%/);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/local-content-targets`,
      headers: owner.headers,
    });
    expect(list.json().items[0]).toMatchObject({
      latestValue: 38,
      compliant: false,
      gap: 7,
      readingCount: 2,
    });

    const series = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/local-content-targets/${targetId}/readings`,
      headers: owner.headers,
    });
    expect(series.json().total).toBe(2);
    expect(series.json().breaches).toBe(1);
    expect(series.json().items.map((r: { value: number }) => r.value)).toEqual([47.5, 38]);
  });

  it("treats an ICV score as higher-is-better too", async () => {
    const pid = await makeProject("ICV");
    const target = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/local-content-targets`,
      headers: owner.headers,
      payload: {
        name: "ICV certificate score",
        jurisdiction: "AE",
        metric: "icv_score",
        targetValue: 60,
      },
    });
    expect(target.json().unit).toBe("score");
    const targetId = target.json().id as string;
    const reading = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/local-content-targets/${targetId}/readings`,
      headers: owner.headers,
      payload: { readingDate: "2026-06-30", value: 60 },
    });
    expect(reading.json().compliant).toBe(1); // exactly on target complies
    expect(await signalsFor(pid, "local_content_shortfall")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Isolation                                                           */
/* ------------------------------------------------------------------ */

describe("tenant isolation", () => {
  it("hides another company's project, permits and rates", async () => {
    const pid = await makeProject("Isolation");
    const permit = await createPermit(pid, {});
    const permitId = permit.json().id as string;

    const foreignList = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/permits`,
      headers: stranger.headers,
    });
    expect([403, 404]).toContain(foreignList.statusCode);

    const foreignPermit = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/permits/${permitId}`,
      headers: owner.headers,
    });
    expect(foreignPermit.statusCode).toBe(404); // right tenant, wrong project

    // the stranger's own FX register is empty despite the owner's rates
    const rates = await app.inject({
      method: "GET",
      url: "/api/v1/fx-rates",
      headers: stranger.headers,
    });
    expect(rates.statusCode).toBe(200);
    expect(rates.json().total).toBe(0);

    const latest = await app.inject({
      method: "GET",
      url: "/api/v1/fx-rates/latest?from=USD&to=KES",
      headers: stranger.headers,
    });
    expect(latest.statusCode).toBe(404);

    const unauth = await app.inject({ method: "GET", url: "/api/v1/fx-rates" });
    expect(unauth.statusCode).toBe(401);
  });
});
