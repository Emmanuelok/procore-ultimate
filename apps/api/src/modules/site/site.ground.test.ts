/**
 * Survey control, setting out, geotechnical baseline comparison, buried
 * utilities, the strikes register and the environmental event log.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { companyMemberships, events, projectMemberships, projects, signals, vendors } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { siteModule } from "./index.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let checker: TestActor;
let viewerHeaders: Record<string, string>;
let stranger: TestActor;
let projectId: string;
let vendorId: string;

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

  checker = await registerActor(app);
  await app.db.insert(companyMemberships).values({ id: newId("cm"), companyId: owner.companyId, userId: checker.userId, role: "admin" });
  checker = { ...checker, companyId: owner.companyId, headers: { authorization: checker.headers["authorization"]!, "x-company-id": owner.companyId } };

  const viewer = await registerActor(app);
  await app.db.insert(companyMemberships).values({ id: newId("cm"), companyId: owner.companyId, userId: viewer.userId, role: "member" });
  viewerHeaders = { authorization: viewer.headers["authorization"]!, "x-company-id": owner.companyId };

  stranger = await registerActor(app);

  projectId = newId("prj");
  await app.db.insert(projects).values({ id: projectId, companyId: owner.companyId, name: "Site — ground", stage: "course_of_construction" });
  await app.db.insert(projectMemberships).values({ id: newId("pm"), companyId: owner.companyId, projectId, userId: viewer.userId, templateKey: "read_only" });

  vendorId = newId("ven");
  await app.db.insert(vendors).values({ id: vendorId, companyId: owner.companyId, name: "Deep Bore Ltd", country: "GB" });
});

afterAll(async () => {
  await built.close();
});

const base = () => `/projects/${projectId}/site`;

describe("survey control", () => {
  it("refuses a point with no coordinates", async () => {
    const res = await post(`${base()}/survey-points`, { pointRef: "CP01" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("needs a position");
  });

  it("creates control points and refuses a duplicate reference", async () => {
    expect(
      (await post(`${base()}/survey-points`, { pointRef: "CP01", easting: 530000, northing: 180000, elevation: 12.5, accuracyMm: 5 })).statusCode,
    ).toBe(201);
    expect((await post(`${base()}/survey-points`, { pointRef: "CP02", lat: 51.5, lon: -0.12, accuracyMm: 10 })).statusCode).toBe(201);
    const clash = await post(`${base()}/survey-points`, { pointRef: "CP01", lat: 1, lon: 1 });
    expect(clash.statusCode).toBe(409);
  });

  it("marks a point disturbed when the check exceeds its own stated accuracy", async () => {
    const list = await get(`${base()}/survey-points?kind=control`);
    const cp01 = list.json().items.find((p: { pointRef: string }) => p.pointRef === "CP01");
    const res = await post(`${base()}/survey-points/${cp01.id}/check`, { deltaMm: 12 });
    expect(res.json().status).toBe("disturbed");
    expect(res.json().verdict).toContain("treated as disturbed");
  });

  it("declines a verdict when the point carries no stated accuracy", async () => {
    const created = await post(`${base()}/survey-points`, { pointRef: "CP03", lat: 51.6, lon: -0.13 });
    const res = await post(`${base()}/survey-points/${created.json().id}/check`, { deltaMm: 40 });
    expect(res.json().verdict).toContain("cannot say");
    expect(res.json().status).toBe("active");
  });
});

describe("setting out", () => {
  let recordId: string;

  it("refuses control points the project does not hold", async () => {
    const res = await post(`${base()}/setting-out`, { description: "Column grid B", controlPointRefs: ["CP99"] });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("CP99");
  });

  it("refuses setting out from a disturbed control point", async () => {
    const res = await post(`${base()}/setting-out`, { description: "Column grid B", controlPointRefs: ["CP01"] });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("disturbed");
  });

  it("records setting out from good control", async () => {
    const res = await post(`${base()}/setting-out`, {
      description: "Column grid B, L2",
      controlPointRefs: ["CP02"],
      toleranceMm: 10,
      method: "total_station",
    });
    expect(res.statusCode).toBe(201);
    recordId = res.json().id;
    expect(res.json().status).toBe("set_out");
    expect(res.json().reference).toMatch(/^SO-\d{3}$/);
  });

  it("refuses a self-check", async () => {
    const res = await post(`${base()}/setting-out/${recordId}/check`, { maxDeviationMm: 4 });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("must be carried out by someone else");
  });

  it("refuses to pass a check whose deviation exceeds the tolerance", async () => {
    const res = await post(`${base()}/setting-out/${recordId}/check`, { maxDeviationMm: 25 }, checker.headers);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("exceeds the stated tolerance");
  });

  it("passes a check by a second person, then refuses a second check", async () => {
    const res = await post(`${base()}/setting-out/${recordId}/check`, { maxDeviationMm: 4 }, checker.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("checked");
    expect((await post(`${base()}/setting-out/${recordId}/check`, { maxDeviationMm: 4 }, checker.headers)).statusCode).toBe(409);
  });

  it("refuses approval by the checker and allows it by a third party", async () => {
    expect((await post(`${base()}/setting-out/${recordId}/approve`, {}, checker.headers)).statusCode).toBe(409);
    const res = await post(`${base()}/setting-out/${recordId}/approve`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("approved");
  });
});

describe("geotechnical baseline comparison", () => {
  let baselineId: string;
  let observedId: string;

  it("refuses overlapping strata", async () => {
    const res = await post(`${base()}/geotech`, {
      holeRef: "BH01",
      strata: [
        { fromM: 0, toM: 3, description: "Clay" },
        { fromM: 2, toM: 6, description: "Sand" },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("overlap");
  });

  it("records the baseline ground model", async () => {
    const res = await post(`${base()}/geotech`, {
      holeRef: "BH01",
      kind: "borehole",
      isBaseline: true,
      contractorVendorId: vendorId,
      depthM: 12,
      waterStrikeDepthM: 8,
      strata: [
        { fromM: 0, toM: 2, description: "Made ground", soilType: "made_ground" },
        { fromM: 2, toM: 6, description: "Firm clay", soilType: "clay", spt: 20 },
        { fromM: 6, toM: 12, description: "Dense sand", soilType: "sand", spt: 40 },
      ],
    });
    expect(res.statusCode).toBe(201);
    baselineId = res.json().id;
    expect(res.json().isBaseline).toBe(1);
    expect(res.json().status).toBe("complete");
  });

  it("refuses to compare the baseline with itself", async () => {
    const res = await post(`${base()}/geotech/${baselineId}/compare`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("cannot be compared with itself");
  });

  it("produces findings against the baseline and raises signals for the serious ones", async () => {
    const created = await post(`${base()}/geotech`, {
      holeRef: "BH01",
      kind: "borehole",
      depthM: 14,
      waterStrikeDepthM: 3,
      strata: [
        { fromM: 0, toM: 2, description: "Made ground with hydrocarbon contamination", soilType: "made_ground_contaminated" },
        { fromM: 2, toM: 6, description: "Firm clay", soilType: "clay", spt: 20 },
        { fromM: 6, toM: 12, description: "Dense sand", soilType: "sand", spt: 40 },
        { fromM: 12, toM: 14, description: "Gravel", soilType: "gravel" },
      ],
    });
    observedId = created.json().id;
    const res = await post(`${base()}/geotech/${observedId}/compare`, {});
    expect(res.statusCode).toBe(200);
    const categories = res.json().findings.map((f: { category: string }) => f.category);
    expect(categories).toContain("contamination");
    expect(categories).toContain("water_table");
    expect(res.json().slicesWithoutBaseline).toBe(1);
    const unbaselined = res.json().findings.find((f: { depthFromM: number }) => f.depthFromM === 12);
    expect(unbaselined.differsFromBaseline).toBe(0);
    expect(res.json().signalsRaised).toBeGreaterThan(0);
    const raised = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, "site_ground_condition_change")));
    expect(raised.length).toBeGreaterThan(0);
  });

  it("re-running replaces open findings and raises nothing new", async () => {
    const before = (await get(`${base()}/ground-findings?investigationId=${observedId}`)).json().total;
    const signalsBefore = (
      await app.db.select().from(signals).where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, "site_ground_condition_change")))
    ).length;
    const res = await post(`${base()}/geotech/${observedId}/compare`, {});
    expect(res.json().replacedFindings).toBe(before);
    expect(res.json().signalsRaised).toBe(0);
    const signalsAfter = (
      await app.db.select().from(signals).where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, "site_ground_condition_change")))
    ).length;
    expect(signalsAfter).toBe(signalsBefore);
    expect((await get(`${base()}/ground-findings?investigationId=${observedId}`)).json().total).toBe(before);
  });

  it("keeps a finding a person has assessed", async () => {
    const list = await get(`${base()}/ground-findings?investigationId=${observedId}&status=open`);
    const finding = list.json().items[0];
    const assessed = await post(`${base()}/ground-findings/${finding.id}/assess`, {
      status: "claimed",
      assessmentNotes: "Notified under clause 60.1(12).",
    });
    expect(assessed.json().status).toBe("claimed");
    await post(`${base()}/geotech/${observedId}/compare`, {});
    const after = await get(`${base()}/ground-findings?investigationId=${observedId}&status=claimed`);
    expect(after.json().total).toBe(1);
  });

  it("says so when the project holds no baseline at all", async () => {
    const other = newId("prj");
    await app.db.insert(projects).values({ id: other, companyId: owner.companyId, name: "No baseline", stage: "course_of_construction" });
    const created = await post(`/projects/${other}/site/geotech`, {
      holeRef: "TP01",
      strata: [{ fromM: 0, toM: 1, description: "Topsoil" }],
    });
    const res = await post(`/projects/${other}/site/geotech/${created.json().id}/compare`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("no baseline ground model");
  });
});

describe("buried utilities and strikes", () => {
  let serviceId: string;

  it("refuses a `verified` service backed only by records", async () => {
    const res = await post(`${base()}/utilities`, {
      serviceRef: "HV-01",
      utilityType: "electricity",
      confidence: "verified",
      detectionMethod: "records",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("records alone");
  });

  it("records a service with a route", async () => {
    const res = await post(`${base()}/utilities`, {
      serviceRef: "HV-01",
      utilityType: "electricity",
      ownerName: "National Grid",
      specification: "11kV",
      depthM: 0.8,
      confidence: "probable",
      detectionMethod: "gpr",
      status: "live",
      route: [
        [-0.12, 51.5],
        [-0.119, 51.5],
        [-0.118, 51.5001],
      ],
    });
    expect(res.statusCode).toBe(201);
    serviceId = res.json().id;
    expect((await post(`${base()}/utilities`, { serviceRef: "HV-01" })).statusCode).toBe(409);
  });

  it("refuses to reach `verified` on records alone through a patch either", async () => {
    const created = await post(`${base()}/utilities`, {
      serviceRef: "GAS-09",
      utilityType: "gas",
      confidence: "probable",
      detectionMethod: "records",
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const escalate = await patch(`${base()}/utilities/${id}`, { confidence: "verified" });
    expect(escalate.statusCode).toBe(400);
    expect(escalate.json().message).toContain("records alone");

    // The same claim with the survey that justifies it is accepted.
    const withSurvey = await patch(`${base()}/utilities/${id}`, { confidence: "verified", detectionMethod: "gpr" });
    expect(withSurvey.statusCode).toBe(200);
    expect(withSurvey.json().confidence).toBe("verified");
  });

  it("records a strike, names the missing controls and raises a signal", async () => {
    const res = await post(`${base()}/strikes`, {
      occurredAt: new Date().toISOString(),
      utilityType: "electricity",
      serviceId,
      severity: "significant",
      operativeName: "Ray Todd",
      plantType: "360 excavator",
      permitInPlace: false,
      scanCompleted: false,
      marksPresent: true,
      injuries: 0,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().reference).toMatch(/^STR-\d{3}$/);
    expect(res.json().controlsMissing).toHaveLength(2);
    expect(res.json().signalId).toBeTruthy();
    const raised = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, "site_utility_strike")));
    expect(raised).toHaveLength(1);
    expect(raised[0]?.severity).toBe("high");
  });

  it("summarises the three controls across the register", async () => {
    const res = await get(`${base()}/strikes`);
    expect(res.json().controls).toEqual({ total: 1, withPermit: 0, withScan: 0, withMarks: 1 });
  });

  it("closes a strike with a root cause", async () => {
    const list = await get(`${base()}/strikes`);
    const id = list.json().items[0].id;
    const res = await post(`${base()}/strikes/${id}/close`, { rootCause: "Excavation began before the survey was ordered." });
    expect(res.json().status).toBe("closed");
  });
});

describe("environmental event log", () => {
  it("refuses to compare two different units", async () => {
    const res = await post(`${base()}/environmental-events`, {
      category: "vibration",
      occurredAt: new Date().toISOString(),
      magnitude: 12,
      magnitudeUnit: "mm/s",
      thresholdValue: 6,
      thresholdUnit: "dB",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("two different units");
  });

  it("refuses a threshold with nothing to test against it", async () => {
    const res = await post(`${base()}/environmental-events`, {
      category: "noise",
      occurredAt: new Date().toISOString(),
      thresholdValue: 75,
    });
    expect(res.statusCode).toBe(400);
  });

  it("logs an exceedance, raises a signal and mirrors it into the platform event log", async () => {
    const res = await post(`${base()}/environmental-events`, {
      category: "vibration",
      detectedVia: "sensor",
      occurredAt: new Date().toISOString(),
      magnitude: 12,
      magnitudeUnit: "mm/s",
      thresholdValue: 6,
      thresholdUnit: "mm/s",
      severity: "high",
      sensorRef: "VIB-03",
      workStopped: true,
      stoppageMinutes: 45,
      impact: "Piling paused beside the listed façade.",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().exceeded).toBe(true);
    expect(res.json().exceededThreshold).toBe(1);
    expect(res.json().thresholdVerdict).toContain("exceeded");
    expect(res.json().signalId).toBeTruthy();

    const mirrored = await app.db
      .select()
      .from(events)
      .where(and(eq(events.companyId, owner.companyId), eq(events.projectId, projectId), eq(events.type, "site_vibration")));
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]?.detectedOrReported).toBe("detected");
  });

  it("logs a within-limit event without a signal", async () => {
    const before = (
      await app.db.select().from(signals).where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, "site_environmental_threshold")))
    ).length;
    const res = await post(`${base()}/environmental-events`, {
      category: "noise",
      occurredAt: new Date().toISOString(),
      magnitude: 60,
      magnitudeUnit: "dB",
      thresholdValue: 75,
      thresholdUnit: "dB",
    });
    expect(res.json().exceeded).toBe(false);
    expect(res.json().exceededThreshold).toBe(0);
    expect(res.json().signalId).toBeNull();
    expect(res.json().thresholdVerdict).toContain("within the limit");
    const after = (
      await app.db.select().from(signals).where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, "site_environmental_threshold")))
    ).length;
    expect(after).toBe(before);
  });

  it("closes an event with the actions taken", async () => {
    const list = await get(`${base()}/environmental-events?exceededOnly=true`);
    const id = list.json().items[0].id;
    const res = await post(`${base()}/environmental-events/${id}/close`, { actionsTaken: "Piling rig changed to a quieter method." });
    expect(res.json().status).toBe("closed");
  });
});

describe("the site plan", () => {
  it("draws the project's own points and says what it could not place", async () => {
    const res = await get(`${base()}/map`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bounds).not.toBeNull();
    const layers = body.byLayer as Record<string, number>;
    expect(layers["survey"]).toBeGreaterThan(0);
    expect(layers["utility"]).toBeGreaterThan(0);
    // CP01 has grid coordinates only, so it cannot be placed and the plan says so.
    expect((body.reasons as string[]).join(" ")).toContain("no latitude/longitude");
    const service = (body.shapes as Array<{ layer: string; kind: string; ring: unknown[] }>).find((sh) => sh.layer === "utility");
    expect(service?.kind).toBe("line");
    expect(service?.ring).toHaveLength(3);
  });

  it("returns an empty plan with a reason when nothing carries a position", async () => {
    const bare = newId("prj");
    await app.db.insert(projects).values({ id: bare, companyId: owner.companyId, name: "No coordinates", stage: "course_of_construction" });
    const res = await get(`/projects/${bare}/site/map`);
    expect(res.statusCode).toBe(200);
    expect(res.json().bounds).toBeNull();
    expect(res.json().points).toEqual([]);
    expect((res.json().reasons as string[]).join(" ")).toContain("Nothing on this site carries a position");
  });
});

describe("tenant isolation", () => {
  it("refuses another company everywhere in this area", async () => {
    expect((await get(`${base()}/geotech`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/utilities`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/strikes`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/survey-points`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/environmental-events`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/map`, stranger.headers)).statusCode).toBe(403);
    expect(
      (await post(`${base()}/setting-out`, { description: "x" }, stranger.headers)).statusCode,
    ).toBe(403);
  });

  it("lets a read-only member read but not write", async () => {
    expect((await get(`${base()}/geotech`, viewerHeaders)).statusCode).toBe(200);
    expect((await post(`${base()}/geotech`, { holeRef: "X" }, viewerHeaders)).statusCode).toBe(403);
  });
});
