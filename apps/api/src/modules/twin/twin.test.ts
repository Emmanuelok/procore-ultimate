/**
 * Digital twin module — assets and geometry binding, telemetry ingestion,
 * alerts, warranties and claims, ISO 19650 delivery milestones, COBie and
 * handover readiness, plus the tool gates on every id-scoped route.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  assets,
  bimElements,
  bimModelVersions,
  companyMemberships,
  files,
  events,
  notifications,
  obligations,
  projectMemberships,
  projects,
  sensorAlerts,
  sensorReadings,
  sensors,
  signals,
  warranties,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import { addDays, todayISO } from "./shared.js";

let built: BuiltApp;
let owner: TestActor;
/** FM manager: project_manager template (twin: standard, not admin) */
let manager: TestActor;
let managerHeaders: Record<string, string>;
/** read_only template: twin read */
let viewer: TestActor;
let viewerHeaders: Record<string, string>;
let projectId: string;

const inject = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) => built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });

beforeAll(async () => {
  built = await buildTestApp();
  owner = await registerActor(built.app);
  manager = await registerActor(built.app);
  viewer = await registerActor(built.app);
  await built.app.db.insert(companyMemberships).values([
    { id: newId("cm"), companyId: owner.companyId, userId: manager.userId, role: "member" },
    { id: newId("cm"), companyId: owner.companyId, userId: viewer.userId, role: "member" },
  ]);
  managerHeaders = {
    authorization: `Bearer ${manager.accessToken}`,
    "x-company-id": owner.companyId,
  };
  viewerHeaders = {
    authorization: `Bearer ${viewer.accessToken}`,
    "x-company-id": owner.companyId,
  };
  projectId = newId("prj");
  await built.app.db
    .insert(projects)
    .values({ id: projectId, companyId: owner.companyId, name: "Twin Tower" });
  await built.app.db.insert(projectMemberships).values([
    {
      id: newId("pm"),
      companyId: owner.companyId,
      projectId,
      userId: manager.userId,
      templateKey: "project_manager",
      overrides: {},
    },
    {
      id: newId("pm"),
      companyId: owner.companyId,
      projectId,
      userId: viewer.userId,
      templateKey: "read_only",
      overrides: {},
    },
  ]);
}, 180_000);

afterAll(async () => {
  await built.close();
});

/* ------------------------------------------------------------------ */

describe("twin — asset register", () => {
  let assetId: string;
  let childId: string;

  it("creates an asset and refuses a duplicate tag code", async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/assets`, owner.headers, {
      tagCode: "AHU-01",
      name: "Air handling unit 01",
      category: "HVAC",
      manufacturer: "Daikin",
      modelNumber: "VRV-X",
      serialNumber: "SN-123",
      criticality: "high",
      ownerId: manager.userId,
      installedAt: "2026-01-10",
    });
    expect(res.statusCode).toBe(201);
    assetId = res.json().id;
    expect(res.json().status).toBe("planned");
    expect(res.json().ownerId).toBe(manager.userId);

    const dupe = await inject("POST", `/api/v1/projects/${projectId}/assets`, owner.headers, {
      tagCode: "AHU-01",
      name: "Duplicate",
    });
    expect(dupe.statusCode).toBe(409);
  });

  it("rejects invalid dates and unknown owners", async () => {
    const badDate = await inject("POST", `/api/v1/projects/${projectId}/assets`, owner.headers, {
      tagCode: "BAD-01",
      name: "Bad dates",
      installedAt: "01/06/2026",
    });
    expect(badDate.statusCode).toBe(400);

    const badOwner = await inject("POST", `/api/v1/projects/${projectId}/assets`, owner.headers, {
      tagCode: "BAD-02",
      name: "Bad owner",
      ownerId: "u_not_a_member",
    });
    expect(badOwner.statusCode).toBe(400);
  });

  it("enforces the forward-only lifecycle and stamps the dates", async () => {
    const commissioned = await inject("PATCH", `/api/v1/assets/${assetId}`, owner.headers, {
      status: "commissioned",
    });
    expect(commissioned.statusCode).toBe(200);
    expect(commissioned.json().commissionedAt).toBe(todayISO());

    const back = await inject("PATCH", `/api/v1/assets/${assetId}`, owner.headers, {
      status: "installed",
    });
    expect(back.statusCode).toBe(400);
  });

  it("validates parent and location on PATCH, refusing cycles and foreign rows", async () => {
    const child = await inject("POST", `/api/v1/projects/${projectId}/assets`, owner.headers, {
      tagCode: "FAN-01",
      name: "Supply fan",
      parentId: assetId,
    });
    expect(child.statusCode).toBe(201);
    childId = child.json().id;

    const selfParent = await inject("PATCH", `/api/v1/assets/${assetId}`, owner.headers, {
      parentId: assetId,
    });
    expect(selfParent.statusCode).toBe(400);
    expect(selfParent.json().message).toContain("own parent");

    const cycle = await inject("PATCH", `/api/v1/assets/${assetId}`, owner.headers, {
      parentId: childId,
    });
    expect(cycle.statusCode).toBe(400);
    expect(cycle.json().message).toContain("descendant");

    // a parent in another project of the same company is refused too
    const otherProject = newId("prj");
    await built.app.db
      .insert(projects)
      .values({ id: otherProject, companyId: owner.companyId, name: "Elsewhere" });
    const foreign = await inject("POST", `/api/v1/projects/${otherProject}/assets`, owner.headers, {
      tagCode: "OTHER-01",
      name: "Other project asset",
    });
    const foreignParent = await inject("PATCH", `/api/v1/assets/${assetId}`, owner.headers, {
      parentId: foreign.json().id,
    });
    expect(foreignParent.statusCode).toBe(400);

    const badLocation = await inject("PATCH", `/api/v1/assets/${assetId}`, owner.headers, {
      locationId: "loc_nope",
    });
    expect(badLocation.statusCode).toBe(400);
  });

  it("exposes the asset hierarchy as a tree", async () => {
    const res = await inject("GET", `/api/v1/projects/${projectId}/assets/tree`, owner.headers);
    expect(res.statusCode).toBe(200);
    const root = res.json().items.find((n: { id: string }) => n.id === assetId);
    expect(root.children.map((c: { id: string }) => c.id)).toEqual([childId]);
  });

  it("creates an asset from a BIM element and colours the viewer map", async () => {
    // a model element, inserted directly: the BIM module owns extraction
    const versionId = newId("bmv");
    await built.app.db.insert(bimElements).values({
      id: newId("bel"),
      modelVersionId: versionId,
      projectId,
      globalId: "1TWINELEMENTGUID000AAA",
      ifcType: "IFCFLOWTERMINAL",
      name: "Diffuser 1",
      classification: "Ss_65_40_33",
      properties: { "Pset_Common.Reference": "DIF-1" },
      storey: "Level 01",
    });

    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/assets/from-element`,
      owner.headers,
      { globalId: "1TWINELEMENTGUID000AAA", modelVersionId: versionId, tagCode: "DIF-01" },
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe("Diffuser 1");
    expect(res.json().classificationCode).toBe("Ss_65_40_33");
    expect(res.json().attributes["Pset_Common.Reference"]).toBe("DIF-1");

    const map = await inject(
      "GET",
      `/api/v1/projects/${projectId}/twin/element-map`,
      owner.headers,
    );
    expect(map.json().items[0]).toMatchObject({
      globalId: "1TWINELEMENTGUID000AAA",
      tagCode: "DIF-01",
    });

    const missing = await inject(
      "POST",
      `/api/v1/projects/${projectId}/assets/from-element`,
      owner.headers,
      { globalId: "0000000000000000000000", modelVersionId: versionId, tagCode: "X-01" },
    );
    expect(missing.statusCode).toBe(404);
  });

  it("bulk-instantiates every element of a type with a tag pattern", async () => {
    const versionId = newId("bmv");
    await built.app.db.insert(bimElements).values([
      {
        id: newId("bel"),
        modelVersionId: versionId,
        projectId,
        globalId: "2BULKELEMENTGUID000AAA",
        ifcType: "IFCSANITARYTERMINAL",
        name: "WC 1",
        storey: "Level 01",
      },
      {
        id: newId("bel"),
        modelVersionId: versionId,
        projectId,
        globalId: "2BULKELEMENTGUID000BBB",
        ifcType: "IFCSANITARYTERMINAL",
        name: "WC 2",
        storey: "Level 01",
      },
    ]);
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/assets/from-elements`,
      owner.headers,
      { modelVersionId: versionId, ifcType: "IFCSANITARYTERMINAL", tagPattern: "WC-{storey}-{seq}" },
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().createdCount).toBe(2);
    expect(res.json().created[0].tagCode).toBe("WC-Level01-001");

    // re-running skips what is already bound
    const again = await inject(
      "POST",
      `/api/v1/projects/${projectId}/assets/from-elements`,
      owner.headers,
      { modelVersionId: versionId, ifcType: "IFCSANITARYTERMINAL", tagPattern: "WC-{seq}" },
    );
    expect(again.json().createdCount).toBe(0);
    expect(again.json().skippedAlreadyLinked).toBe(2);
  });

  it("links and unlinks elements by GlobalId, refusing unknown ones", async () => {
    const bad = await inject("POST", `/api/v1/assets/${assetId}/elements`, owner.headers, {
      globalId: "NOTHINGHERE0000000AAAA",
    });
    expect(bad.statusCode).toBe(400);

    const ok = await inject("POST", `/api/v1/assets/${assetId}/elements`, owner.headers, {
      globalId: "1TWINELEMENTGUID000AAA",
    });
    expect(ok.statusCode).toBe(201);
    const dupe = await inject("POST", `/api/v1/assets/${assetId}/elements`, owner.headers, {
      globalId: "1TWINELEMENTGUID000AAA",
    });
    expect(dupe.statusCode).toBe(409);
    const del = await inject(
      "DELETE",
      `/api/v1/assets/${assetId}/elements/1TWINELEMENTGUID000AAA`,
      owner.headers,
    );
    expect(del.statusCode).toBe(200);
  });

  it("gates id-scoped routes on the twin tool level", async () => {
    const read = await inject("GET", `/api/v1/assets/${assetId}`, viewerHeaders);
    expect(read.statusCode).toBe(200);
    const write = await inject("PATCH", `/api/v1/assets/${assetId}`, viewerHeaders, {
      name: "Renamed by a viewer",
    });
    expect(write.statusCode).toBe(403);
    // delete is admin-only: even a project manager cannot destroy an asset
    const managerDelete = await inject("DELETE", `/api/v1/assets/${assetId}`, managerHeaders);
    expect(managerDelete.statusCode).toBe(403);
    const viewerDelete = await inject("DELETE", `/api/v1/assets/${assetId}`, viewerHeaders);
    expect(viewerDelete.statusCode).toBe(403);
  });

  it("isolates tenants", async () => {
    const outsider = await registerActor(built.app);
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/assets/${assetId}`,
      headers: outsider.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it("re-parents children when an asset is deleted", async () => {
    const grandchild = await inject("POST", `/api/v1/projects/${projectId}/assets`, owner.headers, {
      tagCode: "BEARING-01",
      name: "Bearing",
      parentId: childId,
    });
    const res = await inject("DELETE", `/api/v1/assets/${childId}`, owner.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().childrenReparented).toBe(1);
    const [row] = await built.app.db
      .select()
      .from(assets)
      .where(eq(assets.id, grandchild.json().id));
    expect(row?.parentId).toBe(assetId);
  });
});

/* ------------------------------------------------------------------ */

describe("twin — sensors, ingestion and alerts", () => {
  let assetId: string;
  let sensorId: string;

  beforeAll(async () => {
    const asset = await inject("POST", `/api/v1/projects/${projectId}/assets`, owner.headers, {
      tagCode: "CHW-01",
      name: "Chiller 01",
      criticality: "critical",
      ownerId: manager.userId,
    });
    assetId = asset.json().id;
  });

  it("creates a sensor bound to an asset and validates the bounds", async () => {
    const bad = await inject("POST", `/api/v1/projects/${projectId}/sensors`, owner.headers, {
      name: "Bad bounds",
      kind: "temperature",
      unit: "C",
      minValue: 30,
      maxValue: 10,
    });
    expect(bad.statusCode).toBe(400);

    const res = await inject("POST", `/api/v1/projects/${projectId}/sensors`, owner.headers, {
      name: "Flow temperature",
      kind: "temperature",
      unit: "C",
      assetId,
      ownerId: manager.userId,
      minValue: 4,
      maxValue: 12,
      designSetpoint: 7,
      staleAfterMinutes: 60,
      cooldownMinutes: 60,
    });
    expect(res.statusCode).toBe(201);
    sensorId = res.json().id;
  });

  it("refuses a foreign asset on PATCH and re-checks min <= max", async () => {
    const outsider = await registerActor(built.app);
    const foreignProject = newId("prj");
    await built.app.db
      .insert(projects)
      .values({ id: foreignProject, companyId: outsider.companyId, name: "Foreign" });
    const foreignAsset = newId("ast");
    await built.app.db.insert(assets).values({
      id: foreignAsset,
      companyId: outsider.companyId,
      projectId: foreignProject,
      tagCode: "FOREIGN-01",
      name: "Foreign asset",
      createdBy: outsider.userId,
    });

    const res = await inject("PATCH", `/api/v1/sensors/${sensorId}`, owner.headers, {
      assetId: foreignAsset,
    });
    expect(res.statusCode).toBe(400);

    const bounds = await inject("PATCH", `/api/v1/sensors/${sensorId}`, owner.headers, {
      minValue: 40,
    });
    expect(bounds.statusCode).toBe(400);
    expect(bounds.json().message).toContain("minValue cannot exceed maxValue");
  });

  it("ingests readings, raises exactly one alert per bound and notifies the owner", async () => {
    const readings = [
      { value: 7, at: "2026-05-01T00:00:00.000Z" },
      { value: 18, at: "2026-05-01T00:05:00.000Z" },
      { value: 19, at: "2026-05-01T00:10:00.000Z" },
      { value: 20, at: "2026-05-01T00:15:00.000Z" },
    ];
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/sensors/${sensorId}/readings`,
      owner.headers,
      { readings },
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().inserted).toBe(4);
    expect(res.json().duplicates).toBe(0);
    expect(res.json().alerts.raised).toBe(1);

    const alerts = await built.app.db
      .select()
      .from(sensorAlerts)
      .where(eq(sensorAlerts.sensorId, sensorId));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "max_breach", status: "open", breachCount: 3 });
    expect(alerts[0]!.value).toBe(20);

    // one event, one signal, one notification — not one per reading
    const evts = await built.app.db
      .select()
      .from(events)
      .where(eq(events.type, "sensor_threshold_breach"));
    expect(evts).toHaveLength(1);
    const raised = await built.app.db
      .select()
      .from(signals)
      .where(eq(signals.detector, "twin_sensor_threshold"));
    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe("high");
    const notes = await built.app.db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.userId, manager.userId), eq(notifications.recordId, sensorId)),
      );
    expect(notes).toHaveLength(1);
  });

  it("is idempotent: a retried batch inserts nothing and raises nothing new", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/sensors/${sensorId}/readings`,
      owner.headers,
      {
        readings: [
          { value: 7, at: "2026-05-01T00:00:00.000Z" },
          { value: 18, at: "2026-05-01T00:05:00.000Z" },
        ],
      },
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().inserted).toBe(0);
    expect(res.json().duplicates).toBe(2);
    expect(res.json().alerts.raised).toBe(0);
    expect(res.json().alerts.refreshed).toBe(1);
    const rows = await built.app.db
      .select()
      .from(sensorReadings)
      .where(eq(sensorReadings.sensorId, sensorId));
    expect(rows).toHaveLength(4);
  });

  it("clears the alert when the readings come back inside the thresholds", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/sensors/${sensorId}/readings`,
      owner.headers,
      { readings: [{ value: 8, at: "2026-05-01T01:00:00.000Z" }] },
    );
    expect(res.json().alerts.cleared).toBe(1);
    const alerts = await built.app.db
      .select()
      .from(sensorAlerts)
      .where(eq(sensorAlerts.sensorId, sensorId));
    expect(alerts[0]!.status).toBe("cleared");
  });

  it("refuses telemetry for a deactivated sensor", async () => {
    await inject("PATCH", `/api/v1/sensors/${sensorId}`, owner.headers, { isActive: false });
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/sensors/${sensorId}/readings`,
      owner.headers,
      { readings: [{ value: 9, at: "2026-05-01T02:00:00.000Z" }] },
    );
    expect(res.statusCode).toBe(409);
    await inject("PATCH", `/api/v1/sensors/${sensorId}`, owner.headers, { isActive: true });
  });

  it("acknowledges an alert", async () => {
    const alerts = await inject(
      "GET",
      `/api/v1/projects/${projectId}/sensor-alerts`,
      owner.headers,
    );
    expect(alerts.json().total).toBe(1);
    const alertId = alerts.json().items[0].id;
    const res = await inject("PATCH", `/api/v1/sensor-alerts/${alertId}`, managerHeaders, {
      status: "acknowledged",
      notes: "Chiller reset",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().acknowledgedBy).toBe(manager.userId);
  });

  it("serves the whole sensor tab in one request", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/sensors/overview?hours=100000`,
      owner.headers,
    );
    expect(res.statusCode).toBe(400); // hours is capped
    const ok = await inject(
      "GET",
      `/api/v1/projects/${projectId}/sensors/overview?hours=720`,
      owner.headers,
    );
    expect(ok.statusCode).toBe(200);
    const sensor = ok.json().items.find((s: { id: string }) => s.id === sensorId);
    expect(sensor.lastValue).toBe(8);
    expect(sensor.window.basis).toContain("readings in the last");
  });

  it("reports the true total and the truncation on raw readings", async () => {
    const res = await inject(
      "GET",
      `/api/v1/sensors/${sensorId}/readings?limit=2`,
      owner.headers,
    );
    expect(res.json().total).toBe(5);
    expect(res.json().returned).toBe(2);
    expect(res.json().truncated).toBe(true);
    expect(res.json().nextBefore).toBeTruthy();

    const bucketed = await inject(
      "GET",
      `/api/v1/sensors/${sensorId}/readings?bucketMinutes=60`,
      owner.headers,
    );
    expect(bucketed.json().items.length).toBeGreaterThanOrEqual(1);
    expect(bucketed.json().truncated).toBe(false);
  });

  it("keeps simulated telemetry out of the statistics and the alert register", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/sensors/${sensorId}/simulate`,
      owner.headers,
      { hours: 6, base: 50 },
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().alerts.raised).toBe(0);
    const alerts = await built.app.db
      .select()
      .from(sensorAlerts)
      .where(eq(sensorAlerts.sensorId, sensorId));
    expect(alerts).toHaveLength(1); // still only the cleared one
    const overview = await inject(
      "GET",
      `/api/v1/projects/${projectId}/sensors/overview?hours=720`,
      owner.headers,
    );
    const sensor = overview.json().items.find((s: { id: string }) => s.id === sensorId);
    expect(sensor.window.readings).toBe(0); // the ingested readings are older than the window
  });

  it("opens a stale-channel alert from the scheduler and only once", async () => {
    const stale = await inject("POST", `/api/v1/projects/${projectId}/sensors`, owner.headers, {
      name: "Silent meter",
      kind: "energy",
      unit: "kWh",
      staleAfterMinutes: 1,
    });
    const staleId = stale.json().id;
    await built.app.scheduler.runNow("twin.sensor-stale");
    await built.app.scheduler.runNow("twin.sensor-stale");
    const alerts = await built.app.db
      .select()
      .from(sensorAlerts)
      .where(eq(sensorAlerts.sensorId, staleId));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("stale");
    const raised = await built.app.db
      .select()
      .from(signals)
      .where(and(eq(signals.detector, "twin_sensor_stale"), eq(signals.subjectId, staleId)));
    expect(raised).toHaveLength(1);
  });

  it("refuses ingestion and deletion below the required tool level", async () => {
    const viewerIngest = await inject(
      "POST",
      `/api/v1/projects/${projectId}/sensors/${sensorId}/readings`,
      viewerHeaders,
      { readings: [{ value: 8, at: "2026-06-01T00:00:00.000Z" }] },
    );
    expect(viewerIngest.statusCode).toBe(403);
    const managerDelete = await inject("DELETE", `/api/v1/sensors/${sensorId}`, managerHeaders);
    expect(managerDelete.statusCode).toBe(403);
  });
});

/* ------------------------------------------------------------------ */

describe("twin — warranties, claims and expiry", () => {
  let assetId: string;
  let warrantyId: string;

  beforeAll(async () => {
    const asset = await inject("POST", `/api/v1/projects/${projectId}/assets`, owner.headers, {
      tagCode: "LIFT-01",
      name: "Passenger lift",
      ownerId: manager.userId,
      manufacturer: "Kone",
      modelNumber: "MonoSpace",
      serialNumber: "SN-LIFT",
      installedAt: "2026-01-05",
      commissionedAt: "2026-02-05",
      locationId: null,
    });
    assetId = asset.json().id;
  });

  it("records a warranty with strict dates and refuses an inverted range", async () => {
    const bad = await inject("POST", `/api/v1/assets/${assetId}/warranties`, owner.headers, {
      provider: "Kone",
      startDate: "01/06/2026",
      endDate: "2027-06-01",
    });
    expect(bad.statusCode).toBe(400);

    const inverted = await inject("POST", `/api/v1/assets/${assetId}/warranties`, owner.headers, {
      provider: "Kone",
      startDate: "2026-06-01",
      endDate: "2026-01-01",
    });
    expect(inverted.statusCode).toBe(400);

    const res = await inject("POST", `/api/v1/assets/${assetId}/warranties`, owner.headers, {
      provider: "Kone",
      startDate: "2026-02-05",
      endDate: addDays(todayISO(), 20),
      documentFileId: null,
    });
    expect(res.statusCode).toBe(201);
    warrantyId = res.json().id;
    expect(res.json().status).toBe("active");
  });

  it("re-checks the ordering on PATCH against the merged record", async () => {
    const res = await inject("PATCH", `/api/v1/warranties/${warrantyId}`, owner.headers, {
      endDate: "2020-01-01",
    });
    expect(res.statusCode).toBe(400);
  });

  it("raises an obligation and notifies at the 30-day horizon, once", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/warranties/sweep`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().obligationsCreated).toBe(1);
    expect(res.json().notified).toBe(1);

    const [warranty] = await built.app.db
      .select()
      .from(warranties)
      .where(eq(warranties.id, warrantyId));
    expect(warranty?.obligationId).toBeTruthy();
    expect(warranty?.notifiedDays).toBe(30);

    const obligation = await built.app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, warranty!.obligationId!));
    expect(obligation[0]?.trigger).toContain("Passenger lift");
    expect(obligation[0]?.deadline).toContain(warranty!.endDate);

    // running it again changes nothing
    const again = await inject(
      "POST",
      `/api/v1/projects/${projectId}/warranties/sweep`,
      owner.headers,
    );
    expect(again.json().obligationsCreated).toBe(0);
    expect(again.json().notified).toBe(0);

    const notes = await built.app.db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.recordId, warrantyId), eq(notifications.userId, manager.userId)),
      );
    expect(notes).toHaveLength(1);
    const raised = await built.app.db
      .select()
      .from(signals)
      .where(eq(signals.detector, "twin_warranty_expiring"));
    expect(raised).toHaveLength(1);
  });

  it("reports the expiring horizon with days remaining", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/warranties/expiring?days=90`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().items[0].daysRemaining).toBe(20);
    expect(res.json().items[0].assetName).toBe("Passenger lift");
  });

  it("runs a claim through its lifecycle and returns the warranty to active", async () => {
    const claim = await inject("POST", `/api/v1/warranties/${warrantyId}/claims`, owner.headers, {
      title: "Door sensor intermittent",
      description: "Lift doors re-open at random",
    });
    expect(claim.statusCode).toBe(201);
    const claimId = claim.json().id;
    expect(claim.json().number).toBe(1);
    const [claimed] = await built.app.db
      .select()
      .from(warranties)
      .where(eq(warranties.id, warrantyId));
    expect(claimed?.status).toBe("claimed");

    const illegal = await inject("PATCH", `/api/v1/warranty-claims/${claimId}`, owner.headers, {
      status: "closed",
    });
    expect(illegal.statusCode).toBe(400);

    await inject("PATCH", `/api/v1/warranty-claims/${claimId}`, owner.headers, {
      status: "acknowledged",
    });
    const closed = await inject("PATCH", `/api/v1/warranty-claims/${claimId}`, owner.headers, {
      status: "closed",
      resolution: "Sensor replaced under warranty",
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().closedAt).toBe(todayISO());

    const [after] = await built.app.db
      .select()
      .from(warranties)
      .where(eq(warranties.id, warrantyId));
    expect(after?.status).toBe("active");

    const register = await inject(
      "GET",
      `/api/v1/projects/${projectId}/warranty-claims`,
      owner.headers,
    );
    expect(register.json().items[0].assetName).toBe("Passenger lift");
  });

  it("requires admin to delete a warranty", async () => {
    const res = await inject("DELETE", `/api/v1/warranties/${warrantyId}`, managerHeaders);
    expect(res.statusCode).toBe(403);
  });
});

/* ------------------------------------------------------------------ */

describe("twin — delivery milestones", () => {
  let milestoneId: string;
  let modelId: string;

  beforeAll(async () => {
    const model = await inject("POST", `/api/v1/projects/${projectId}/bim/models`, owner.headers, {
      name: "Asset information model",
      format: "ifc",
    });
    modelId = model.json().id;
  });

  it("creates a milestone with a required container", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/delivery-milestones`,
      owner.headers,
      {
        name: "Stage 6 handover information",
        dueDate: "2026-12-01",
        requiredState: "published",
        requiredSuitability: "A1",
      },
    );
    expect(res.statusCode).toBe(201);
    milestoneId = res.json().id;

    const container = await inject(
      "POST",
      `/api/v1/projects/${projectId}/delivery-milestones/${milestoneId}/containers`,
      owner.headers,
      { label: "Asset information model", modelId },
    );
    expect(container.statusCode).toBe(201);

    const both = await inject(
      "POST",
      `/api/v1/projects/${projectId}/delivery-milestones/${milestoneId}/containers`,
      owner.headers,
      { label: "Neither", modelId, documentFileId: "fil_x" },
    );
    expect(both.statusCode).toBe(400);
  });

  it("refuses delivery until every container is at the required state", async () => {
    const evaluate = await inject(
      "GET",
      `/api/v1/projects/${projectId}/delivery-milestones/${milestoneId}/evaluate`,
      owner.headers,
    );
    expect(evaluate.json().satisfied).toBe(false);
    expect(evaluate.json().containers[0].reason).toContain("no versions");

    const res = await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/delivery-milestones/${milestoneId}`,
      owner.headers,
      { status: "delivered" },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("Asset information model");
  });

  it("accepts delivery once the container is published, and needs a second party to accept", async () => {
    // publish a version of the model directly: the CDE path is covered by the
    // bim suite; this test is about the milestone gate
    const versionId = newId("bmv");
    const fileId = newId("fil");
    await built.app.db.insert(files).values({
      id: fileId,
      companyId: owner.companyId,
      projectId,
      name: "aim.ifc",
      contentType: "application/octet-stream",
      sizeBytes: 1,
      sha256: "a".repeat(64),
      storageKey: "k",
      metadata: { source: "bim_model_version", modelId },
      uploadedBy: owner.userId,
    });
    await built.app.db.insert(bimModelVersions).values({
      id: versionId,
      modelId,
      version: 1,
      fileId,
      cdeState: "published",
      suitability: "A1",
      processing: "ready",
      elementCount: 0,
      uploadedBy: owner.userId,
    });

    const evaluate = await inject(
      "GET",
      `/api/v1/projects/${projectId}/delivery-milestones/${milestoneId}/evaluate`,
      owner.headers,
    );
    expect(evaluate.json().satisfied).toBe(true);

    const delivered = await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/delivery-milestones/${milestoneId}`,
      owner.headers,
      { status: "delivered" },
    );
    expect(delivered.statusCode).toBe(200);
    expect(delivered.json().deliveredAt).toBeTruthy();

    const selfAccept = await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/delivery-milestones/${milestoneId}`,
      owner.headers,
      { status: "accepted" },
    );
    expect(selfAccept.statusCode).toBe(400);

    const accepted = await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/delivery-milestones/${milestoneId}`,
      managerHeaders,
      { status: "accepted", decisionNote: "Checked against the AIR" },
    );
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().acceptedBy).toBe(manager.userId);
  });
});

/* ------------------------------------------------------------------ */

describe("twin — COBie, handover and health", () => {
  it("exports COBie sheets as CSV with formula injection neutralised", async () => {
    await inject("POST", `/api/v1/projects/${projectId}/assets`, owner.headers, {
      tagCode: "EVIL-01",
      name: '=HYPERLINK("http://evil","AHU")',
    });
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/cobie.csv?sheet=Component`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.body).toContain("\"'=HYPERLINK");
  });

  it("validates the workbook and reports completeness", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/cobie/validate`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().completeness.score).toBeGreaterThan(0);
    expect(res.json().completeness.fieldCoverage.length).toBeGreaterThan(0);
    expect(res.json().sheets.find((s: { name: string }) => s.name === "Zone").reason).toBeTruthy();
  });

  it("serves the legacy COBie JSON shape as well as the workbook", async () => {
    const res = await inject("GET", `/api/v1/projects/${projectId}/cobie.json`, owner.headers);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().components)).toBe(true);
    expect(res.json().sheets.length).toBeGreaterThan(5);
  });

  it("scores handover readiness with the gaps named", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/twin/handover-readiness`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().score).not.toBeNull();
    expect(res.json().assetsAssessed).toBeGreaterThan(0);
    expect(res.json().blockers.length).toBeGreaterThan(0);
    expect(res.json().cobie.completeness).toBeGreaterThan(0);
  });

  it("reports asset performance against design intent", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/twin/performance?days=365`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    const withBaseline = res.json().items.find((r: { designSetpoint: number | null }) => r.designSetpoint !== null);
    expect(withBaseline).toBeTruthy();
    expect(["on_design", "above_design", "below_design", "unknown"]).toContain(
      withBaseline.verdict,
    );
    const withoutBaseline = res
      .json()
      .items.find((r: { designSetpoint: number | null }) => r.designSetpoint === null);
    expect(withoutBaseline.verdict).toBe("unknown");
    // a channel with neither readings nor a baseline says which is missing
    expect(withoutBaseline.basis).toContain("no readings in the window");
    expect(res.json().note).toContain("fabricated");
  });

  it("summarises the twin and exposes health inputs", async () => {
    const summary = await inject(
      "GET",
      `/api/v1/projects/${projectId}/twin/summary`,
      owner.headers,
    );
    expect(summary.statusCode).toBe(200);
    expect(summary.json().assetsTotal).toBeGreaterThan(0);
    expect(summary.json().simulationAvailable).toBe(true);

    const health = await inject(
      "GET",
      `/api/v1/projects/${projectId}/twin/health-inputs`,
      owner.headers,
    );
    expect(health.statusCode).toBe(200);
    expect(health.json().metrics.twin_assets).toBeGreaterThan(0);
    expect(health.json().reasons.length).toBeGreaterThan(0);
  });

  it("keeps handover data inside the tenant", async () => {
    const outsider = await registerActor(built.app);
    for (const url of [
      `/api/v1/projects/${projectId}/cobie.json`,
      `/api/v1/projects/${projectId}/twin/handover-readiness`,
      `/api/v1/projects/${projectId}/twin/health-inputs`,
    ]) {
      const res = await built.app.inject({ method: "GET", url, headers: outsider.headers });
      expect(res.statusCode).toBe(403);
    }
  });
});

/* ------------------------------------------------------------------ */

describe("twin — remaining route surface", () => {
  it("serves a sensor detail with its alert history", async () => {
    const list = await inject("GET", `/api/v1/projects/${projectId}/sensors`, owner.headers);
    const sensorId = list.json().items[0].id;
    const res = await inject("GET", `/api/v1/sensors/${sensorId}`, owner.headers);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().alerts)).toBe(true);

    const outsider = await registerActor(built.app);
    const denied = await built.app.inject({
      method: "GET",
      url: `/api/v1/sensors/${sensorId}`,
      headers: outsider.headers,
    });
    expect(denied.statusCode).toBe(404);
  });

  it("deletes a sensor with its readings and alerts (admin)", async () => {
    const created = await inject("POST", `/api/v1/projects/${projectId}/sensors`, owner.headers, {
      name: "Disposable meter",
      kind: "power",
      unit: "kW",
    });
    const sensorId = created.json().id;
    await inject(
      "POST",
      `/api/v1/projects/${projectId}/sensors/${sensorId}/readings`,
      owner.headers,
      { readings: [{ value: 1, at: "2026-07-01T00:00:00.000Z" }] },
    );
    const res = await inject("DELETE", `/api/v1/sensors/${sensorId}`, owner.headers);
    expect(res.statusCode).toBe(200);
    const remaining = await built.app.db
      .select()
      .from(sensorReadings)
      .where(eq(sensorReadings.sensorId, sensorId));
    expect(remaining).toHaveLength(0);
  });

  it("lists an asset's warranties with days remaining and the unlinked-asset gap list", async () => {
    const assetsList = await inject("GET", `/api/v1/projects/${projectId}/assets?search=LIFT`, owner.headers);
    const assetId = assetsList.json().items[0].id;
    const warranties = await inject("GET", `/api/v1/assets/${assetId}/warranties`, owner.headers);
    expect(warranties.statusCode).toBe(200);
    expect(warranties.json().items[0].daysRemaining).toBeDefined();

    const unlinked = await inject(
      "GET",
      `/api/v1/projects/${projectId}/twin/unlinked-assets`,
      owner.headers,
    );
    expect(unlinked.statusCode).toBe(200);
    expect(unlinked.json().total).toBeGreaterThan(0);
  });

  it("summarises warranty cover for the dashboard", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/warranties/summary`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().byStatus).toBeTruthy();
    expect(typeof res.json().expiringWithin90Days).toBe("number");
  });

  it("keeps the whole twin surface out of another tenant's reach", async () => {
    const outsider = await registerActor(built.app);
    for (const url of [
      `/api/v1/projects/${projectId}/assets`,
      `/api/v1/projects/${projectId}/sensors/overview`,
      `/api/v1/projects/${projectId}/sensor-alerts`,
      `/api/v1/projects/${projectId}/warranty-claims`,
      `/api/v1/projects/${projectId}/delivery-milestones`,
      `/api/v1/projects/${projectId}/twin/performance`,
    ]) {
      const res = await built.app.inject({ method: "GET", url, headers: outsider.headers });
      expect(res.statusCode, url).toBe(403);
    }
  });
});
