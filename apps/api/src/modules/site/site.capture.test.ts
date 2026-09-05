/**
 * Weather archive and analysis, drone flights, laser scans, scan-vs-model
 * deviation reports and 360° tours.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { companyMemberships, projectMemberships, projects, signals, siteWeatherObservations } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { siteModule } from "./index.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let viewerHeaders: Record<string, string>;
let stranger: TestActor;
let projectId: string;

function post(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload });
}
function patch(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload });
}
function get(url: string, headers = owner.headers) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers });
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  if (!app.scheduler.has("site.lone-worker")) await app.register(siteModule, { prefix: "/api/v1" });
  owner = await registerActor(app);

  const viewer = await registerActor(app);
  await app.db.insert(companyMemberships).values({ id: newId("cm"), companyId: owner.companyId, userId: viewer.userId, role: "member" });
  viewerHeaders = { authorization: viewer.headers["authorization"]!, "x-company-id": owner.companyId };

  stranger = await registerActor(app);

  projectId = newId("prj");
  await app.db.insert(projects).values({ id: projectId, companyId: owner.companyId, name: "Site — capture", stage: "course_of_construction" });
  await app.db.insert(projectMemberships).values({ id: newId("pm"), companyId: owner.companyId, projectId, userId: viewer.userId, templateKey: "read_only" });
});

afterAll(async () => {
  await built.close();
});

const base = () => `/projects/${projectId}/site`;
let baselineId: string;

describe("weather archive", () => {
  it("stores a batch of daily observations", async () => {
    const res = await post(`${base()}/weather/observations`, {
      observations: [
        { observedOn: "2026-01-01", precipitationMm: 22, windGustKph: 30, tempMinC: 3, workStopped: true, hoursLost: 4 },
        { observedOn: "2026-01-02", precipitationMm: 2, windGustKph: 20, tempMinC: 5 },
        { observedOn: "2026-01-03", precipitationMm: 0, windGustKph: 85, tempMinC: 6 },
        { observedOn: "2026-01-04", precipitationMm: 1, windGustKph: 10, tempMinC: -5 },
      ],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().total).toBe(4);
  });

  it("upserts a repeated date+source rather than duplicating it", async () => {
    await post(`${base()}/weather/observations`, { observedOn: "2026-01-02", precipitationMm: 3, windGustKph: 20, tempMinC: 5 });
    const rows = await app.db
      .select()
      .from(siteWeatherObservations)
      .where(and(eq(siteWeatherObservations.projectId, projectId), eq(siteWeatherObservations.observedOn, "2026-01-02")));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.precipitationMm).toBe(3);
  });

  it("refuses a minimum above the maximum", async () => {
    const res = await post(`${base()}/weather/observations`, { observedOn: "2026-01-05", tempMinC: 10, tempMaxC: 2 });
    expect(res.statusCode).toBe(400);
  });

  it("is a graceful no-op when the provider cannot be used", async () => {
    const res = await post(`${base()}/weather/capture`, { from: "2026-01-01", to: "2026-01-05" });
    expect(res.statusCode).toBe(200);
    expect(res.json().inserted).toBe(0);
    expect(res.json().reasons.length).toBeGreaterThan(0);
  });
});

describe("exceptional-weather analysis", () => {
  it("stores a baseline with thresholds", async () => {
    const res = await post(`${base()}/weather/baselines`, {
      name: "Contract clause 60.1(13)",
      source: "contract",
      contractRef: "NEC4 60.1(13)",
      thresholds: [
        { metric: "precipitation_mm", comparator: "gte", value: 10, label: "Rainfall" },
        { metric: "wind_gust_kph", comparator: "gte", value: 60, label: "Gust" },
        { metric: "temp_min_c", comparator: "lte", value: -2, label: "Frost" },
      ],
      monthlyExpectedAdverseDays: { "1": 3.1 },
    });
    expect(res.statusCode).toBe(201);
    baselineId = res.json().id;
  });

  it("refuses a month key outside 1..12", async () => {
    const res = await post(`${base()}/weather/baselines`, { name: "Bad", monthlyExpectedAdverseDays: { "13": 1 } });
    expect(res.statusCode).toBe(400);
  });

  it("counts adverse days, states coverage and never treats a gap as fair weather", async () => {
    const res = await post(`${base()}/weather/analyses`, {
      baselineId,
      periodStart: "2026-01-01",
      periodEnd: "2026-01-10",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.reference).toMatch(/^WX-\d{3}$/);
    expect(body.observedAdverseDays).toBe(3);
    expect(body.daysObserved).toBe(4);
    expect(body.daysInPeriod).toBe(10);
    expect(body.coveragePercent).toBe(40);
    expect(body.gapDates).toHaveLength(6);
    expect(body.reasons.join(" ")).toContain("NOT counted as fair weather");
    // 3.1 expected days pro-rated over 10 of 31 days = 1.0
    expect(body.baselineAdverseDays).toBe(1);
    expect(body.exceptionalDays).toBe(2);
    expect(body.hoursLost).toBe(4);
  });

  it("stamps the archive with each day's verdict and its reasons", async () => {
    const rows = await app.db
      .select()
      .from(siteWeatherObservations)
      .where(and(eq(siteWeatherObservations.projectId, projectId), eq(siteWeatherObservations.observedOn, "2026-01-03")));
    expect(rows[0]?.adverse).toBe(1);
    expect(rows[0]?.adverseReasons.join(" ")).toContain("Gust");
    const fair = await app.db
      .select()
      .from(siteWeatherObservations)
      .where(and(eq(siteWeatherObservations.projectId, projectId), eq(siteWeatherObservations.observedOn, "2026-01-02")));
    expect(fair[0]?.adverse).toBe(0);
  });

  it("returns the per-day verdicts on the detail view", async () => {
    const list = await get(`${base()}/weather/analyses`);
    const id = list.json().items[0].id;
    const res = await get(`${base()}/weather/analyses/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().baseline.name).toContain("60.1(13)");
    const jan1 = res.json().observations.find((o: { observedOn: string }) => o.observedOn === "2026-01-01");
    expect(jan1.verdict.adverse).toBe(true);
    expect(jan1.verdict.reasons[0]).toContain("Rainfall");
  });

  it("issues a draft once and refuses to issue it twice", async () => {
    const list = await get(`${base()}/weather/analyses`);
    const id = list.json().items[0].id;
    expect((await post(`${base()}/weather/analyses/${id}/issue`, {})).json().status).toBe("issued");
    expect((await post(`${base()}/weather/analyses/${id}/issue`, {})).statusCode).toBe(409);
  });

  it("declines to compute exceptional days without a baseline expectation", async () => {
    const bare = await post(`${base()}/weather/baselines`, {
      name: "Thresholds only",
      thresholds: [{ metric: "precipitation_mm", comparator: "gte", value: 10 }],
    });
    const res = await post(`${base()}/weather/analyses`, {
      baselineId: bare.json().id,
      periodStart: "2026-01-01",
      periodEnd: "2026-01-04",
    });
    expect(res.json().exceptionalDays).toBeNull();
    expect(res.json().reasons.join(" ")).toContain("cannot be derived");
  });

  it("refuses a baseline from another project", async () => {
    const other = newId("prj");
    await app.db.insert(projects).values({ id: other, companyId: owner.companyId, name: "Elsewhere", stage: "course_of_construction" });
    const res = await post(`/projects/${other}/site/weather/analyses`, {
      baselineId,
      periodStart: "2026-01-01",
      periodEnd: "2026-01-02",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("drone flights", () => {
  let flightId: string;

  it("creates a flight with pending permission, and refuses to record it flown", async () => {
    const res = await post(`${base()}/flights`, { purpose: "progress", pilotName: "Ann Reid", aircraft: "M3E" });
    expect(res.statusCode).toBe(201);
    flightId = res.json().id;
    expect(res.json().status).toBe("planned");
    const flown = await post(`${base()}/flights/${flightId}/flown`, {});
    expect(flown.statusCode).toBe(409);
    expect(flown.json().message).toContain("permission");
  });

  it("records it flown once permission is granted", async () => {
    expect((await patch(`${base()}/flights/${flightId}`, { permissionStatus: "granted", permissionRef: "CAA-123" })).json().status).toBe("permitted");
    const res = await post(`${base()}/flights/${flightId}/flown`, {
      durationMinutes: 22,
      imageCount: 480,
      outputs: [{ kind: "orthomosaic", ref: "ortho-01" }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("flown");
    expect(res.json().imageCount).toBe(480);
  });

  it("refuses to edit the plan of a flown flight", async () => {
    expect((await patch(`${base()}/flights/${flightId}`, { aircraft: "other" })).statusCode).toBe(409);
  });
});

describe("scans and deviation reports", () => {
  let scanId: string;

  it("creates a scan and refuses a registered state with no residual", async () => {
    const created = await post(`${base()}/scans`, { name: "L3 slab", method: "terrestrial_laser", coordinateSystem: "OSGB36" });
    expect(created.statusCode).toBe(201);
    scanId = created.json().id;
    const bad = await post(`${base()}/scans/${scanId}/captured`, { registrationStatus: "registered" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain("registration error");
  });

  it("refuses to assess an unregistered scan", async () => {
    await post(`${base()}/scans/${scanId}/captured`, { registrationStatus: "unregistered", setupCount: 12 });
    const res = await post(`${base()}/scans/${scanId}/deviations`, {
      toleranceMm: 10,
      items: [{ elementId: "e1", deviationMm: 30 }],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().verdict).toBe("not_assessable");
    expect(res.json().reasons.join(" ")).toContain("not registered");
    expect(res.json().signalId).toBeNull();
  });

  it("produces statistics, a zone roll-up and a signal once the scan is registered", async () => {
    await post(`${base()}/scans/${scanId}/captured`, { registrationStatus: "registered", registrationErrorMm: 2 });
    const res = await post(`${base()}/scans/${scanId}/deviations`, {
      toleranceMm: 10,
      items: [
        { elementId: "e1", zone: "L1", deviationMm: 2 },
        { elementId: "e2", zone: "L1", deviationMm: -9 },
        { elementId: "e3", zone: "L2", deviationMm: 25 },
        { elementId: "e4", zone: "L2", deviationMm: -1 },
      ],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().verdict).toBe("out_of_tolerance");
    expect(res.json().outOfToleranceCount).toBe(1);
    expect(res.json().marginalCount).toBe(1);
    expect(res.json().maxDeviationMm).toBe(25);
    expect(res.json().byZone[0].zone).toBe("L2");
    expect(res.json().signalId).toBeTruthy();

    const raised = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, "site_scan_out_of_tolerance")));
    expect(raised).toHaveLength(1);
  });

  it("refuses when the registration error swamps the tolerance", async () => {
    const scan = await post(`${base()}/scans`, { name: "Rough scan" });
    await post(`${base()}/scans/${scan.json().id}/captured`, { registrationStatus: "registered", registrationErrorMm: 15 });
    const res = await post(`${base()}/scans/${scan.json().id}/deviations`, {
      toleranceMm: 10,
      items: [{ elementId: "e1", deviationMm: 3 }],
    });
    expect(res.json().verdict).toBe("not_assessable");
    expect(res.json().reasons.join(" ")).toContain("registration error");
  });

  it("accepts a report and lists by verdict", async () => {
    const list = await get(`${base()}/deviations?verdict=out_of_tolerance`);
    expect(list.json().total).toBe(1);
    const id = list.json().items[0].id;
    const res = await post(`${base()}/deviations/${id}/accept`, { status: "accepted" });
    expect(res.json().status).toBe("accepted");
    expect(res.json().acceptedBy).toBe(owner.userId);
  });
});

describe("360 tours", () => {
  let tourId: string;

  it("refuses to publish a tour with no stations", async () => {
    const created = await post(`${base()}/tours`, { name: "L3 walkthrough", level: "L3" });
    expect(created.statusCode).toBe(201);
    tourId = created.json().id;
    expect((await post(`${base()}/tours/${tourId}/publish`, {})).statusCode).toBe(409);
  });

  it("adds stations, counts them and publishes", async () => {
    await post(`${base()}/tours/${tourId}/stations`, { name: "Core", lat: 51.5, lon: -0.12, headingDeg: 90 });
    await post(`${base()}/tours/${tourId}/stations`, { name: "West bay" });
    const detail = await get(`${base()}/tours/${tourId}`);
    expect(detail.json().stations).toHaveLength(2);
    expect(detail.json().stationCount).toBe(2);
    const published = await post(`${base()}/tours/${tourId}/publish`, {});
    expect(published.json().status).toBe("published");
    expect((await post(`${base()}/tours/${tourId}/publish`, {})).statusCode).toBe(409);
  });
});

describe("tenant isolation", () => {
  it("refuses another company on every capture route", async () => {
    expect((await get(`${base()}/weather/observations`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/scans`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/flights`, stranger.headers)).statusCode).toBe(403);
    expect((await post(`${base()}/tours`, { name: "x" }, stranger.headers)).statusCode).toBe(403);
  });

  it("lets a read-only member read but not write", async () => {
    expect((await get(`${base()}/weather/analyses`, viewerHeaders)).statusCode).toBe(200);
    expect((await post(`${base()}/weather/observations`, { observedOn: "2026-02-01" }, viewerHeaders)).statusCode).toBe(403);
  });
});
