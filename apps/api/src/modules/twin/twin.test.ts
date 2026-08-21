import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { bimElements, events, notifications, projects } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";

let built: BuiltApp;
let actor: TestActor;
let projectId: string;

beforeAll(async () => {
  built = await buildTestApp();
  actor = await registerActor(built.app);
  projectId = newId("prj");
  await built.app.db
    .insert(projects)
    .values({ id: projectId, companyId: actor.companyId, name: "Twin P1" });
});

afterAll(async () => {
  await built.close();
});

describe("twin module — assets", () => {
  let assetId: string;

  it("creates an asset and rejects duplicate tag codes", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/assets`,
      payload: {
        tagCode: "FCU-01",
        name: "Fan Coil Unit 01",
        category: "HVAC",
        manufacturer: "Daikin",
        serialNumber: "SN-123",
        criticality: "high",
      },
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(201);
    assetId = res.json().id;
    expect(res.json().status).toBe("planned");

    const dupe = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/assets`,
      payload: { tagCode: "FCU-01", name: "Duplicate" },
      headers: actor.headers,
    });
    expect(dupe.statusCode).toBe(409);
  });

  it("lists assets with filters", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/assets?search=fan&status=planned`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().items[0].tagCode).toBe("FCU-01");
  });

  it("enforces forward-only status transitions", async () => {
    const patch = (payload: Record<string, unknown>) =>
      built.app.inject({
        method: "PATCH",
        url: `/api/v1/assets/${assetId}`,
        payload,
        headers: actor.headers,
      });

    const installed = await patch({ status: "installed" });
    expect(installed.statusCode).toBe(200);
    expect(installed.json().installedAt).toBeTruthy(); // auto-stamped

    // backward move is illegal
    expect((await patch({ status: "planned" })).statusCode).toBe(400);
    // forward again works
    expect((await patch({ status: "commissioned" })).statusCode).toBe(200);
  });

  it("creates an asset from a BIM element and exposes the element map", async () => {
    const modelVersionId = newId("bmv");
    const guid = "1AHU".padEnd(22, "0");
    await built.app.db.insert(bimElements).values({
      id: newId("bel"),
      modelVersionId,
      projectId,
      globalId: guid,
      ifcType: "IFCFLOWTERMINAL",
      name: "AHU Level 1",
      properties: {},
    });

    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/assets/from-element`,
      payload: { globalId: guid, modelVersionId, tagCode: "AHU-01" },
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe("AHU Level 1"); // pulled from the element
    expect(body.category).toBe("IFCFLOWTERMINAL");
    expect(body.elementLinks).toHaveLength(1);
    expect(body.elementLinks[0].globalId).toBe(guid);

    const missing = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/assets/from-element`,
      payload: { globalId: "0".padEnd(22, "0"), modelVersionId, tagCode: "AHU-02" },
      headers: actor.headers,
    });
    expect(missing.statusCode).toBe(404);

    const map = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/twin/element-map`,
      headers: actor.headers,
    });
    expect(map.statusCode).toBe(200);
    expect(map.json().items).toEqual([
      { globalId: guid, assetId: body.id, tagCode: "AHU-01" },
    ]);
  });

  it("links and unlinks elements manually", async () => {
    const guid = "2EXTRA".padEnd(22, "0");
    const link = await built.app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/elements`,
      payload: { globalId: guid },
      headers: actor.headers,
    });
    expect(link.statusCode).toBe(201);

    const dupe = await built.app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/elements`,
      payload: { globalId: guid },
      headers: actor.headers,
    });
    expect(dupe.statusCode).toBe(409);

    const del = await built.app.inject({
      method: "DELETE",
      url: `/api/v1/assets/${assetId}/elements/${guid}`,
      headers: actor.headers,
    });
    expect(del.statusCode).toBe(200);
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
});

describe("twin module — sensors & readings", () => {
  let assetId: string;
  let sensorId: string;

  beforeAll(async () => {
    const assetRes = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/assets`,
      payload: { tagCode: "CHW-01", name: "Chiller 01" },
      headers: actor.headers,
    });
    assetId = assetRes.json().id;
  });

  it("creates a sensor bound to an asset", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/sensors`,
      payload: {
        name: "Supply temp",
        kind: "temperature",
        unit: "C",
        assetId,
        minValue: 10,
        maxValue: 30,
      },
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(201);
    sensorId = res.json().id;
  });

  it("ingests readings and raises threshold breach events + notification", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/sensors/${sensorId}/readings`,
      payload: {
        readings: [
          { value: 15, at: "2026-08-01T10:00:00Z" }, // in range
          { value: 35, at: "2026-08-01T10:05:00Z" }, // above max
          { value: 5, at: "2026-08-01T10:10:00Z" }, // below min
        ],
      },
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ inserted: 3, breaches: 2 });

    const eventRows = await built.app.db
      .select()
      .from(events)
      .where(
        and(eq(events.projectId, projectId), eq(events.type, "sensor_threshold_breach")),
      );
    expect(eventRows).toHaveLength(2);
    expect(eventRows.every((e) => e.detectedOrReported === "detected")).toBe(true);
    const payloads = eventRows.map((e) => e.payload as { bound: string });
    expect(payloads.map((p) => p.bound).sort()).toEqual(["max", "min"]);

    // asset creator was notified
    const notes = await built.app.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, actor.userId), eq(notifications.recordId, sensorId)));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toContain("Supply temp");
  });

  it("caps and validates the ingest batch", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/sensors/${sensorId}/readings`,
      payload: { readings: [] },
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns raw readings newest first", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/sensors/${sensorId}/readings`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(3);
    expect(res.json().items[0].value).toBe(5); // 10:10 is newest
  });

  it("buckets readings with avg/min/max", async () => {
    // second sensor with no thresholds, controlled timestamps
    const sensorRes = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/sensors`,
      payload: { name: "kWh meter", kind: "energy", unit: "kWh" },
      headers: actor.headers,
    });
    const meterId = sensorRes.json().id;
    await built.app.inject({
      method: "POST",
      url: `/api/v1/sensors/${meterId}/readings`,
      payload: {
        readings: [
          { value: 10, at: "2026-01-01T00:05:00Z" },
          { value: 20, at: "2026-01-01T00:20:00Z" },
          { value: 30, at: "2026-01-01T01:10:00Z" },
        ],
      },
      headers: actor.headers,
    });

    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/sensors/${meterId}/readings?bucketMinutes=60`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as {
      bucketStart: string;
      avg: number;
      min: number;
      max: number;
      count: number;
    }[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      bucketStart: "2026-01-01T00:00:00.000Z",
      avg: 15,
      min: 10,
      max: 20,
      count: 2,
    });
    expect(items[1]).toMatchObject({ min: 30, max: 30, count: 1 });
  });
});

describe("twin module — warranties, milestones, COBie", () => {
  let assetId: string;

  const isoDatePlus = (days: number) =>
    new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 10);

  beforeAll(async () => {
    const assetRes = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/assets`,
      payload: {
        tagCode: "PMP-01",
        name: 'Pump "primary", loop A',
        category: "Plumbing",
        serialNumber: "PS-9",
        installedAt: "2026-06-01",
        warrantyStart: "2026-06-01",
      },
      headers: actor.headers,
    });
    assetId = assetRes.json().id;
  });

  it("manages warranties and reports the expiring horizon", async () => {
    const soon = await built.app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/warranties`,
      payload: {
        provider: "PumpCo",
        startDate: isoDatePlus(-30),
        endDate: isoDatePlus(30),
      },
      headers: actor.headers,
    });
    expect(soon.statusCode).toBe(201);

    const far = await built.app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/warranties`,
      payload: {
        provider: "LongCo",
        startDate: isoDatePlus(-30),
        endDate: isoDatePlus(400),
      },
      headers: actor.headers,
    });
    expect(far.statusCode).toBe(201);

    const invalid = await built.app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/warranties`,
      payload: { provider: "BadCo", startDate: "2026-06-01", endDate: "2026-01-01" },
      headers: actor.headers,
    });
    expect(invalid.statusCode).toBe(400);

    const expiring = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/warranties/expiring?days=90`,
      headers: actor.headers,
    });
    expect(expiring.statusCode).toBe(200);
    expect(expiring.json().total).toBe(1);
    expect(expiring.json().items[0].provider).toBe("PumpCo");
    expect(expiring.json().items[0].tagCode).toBe("PMP-01");

    const list = await built.app.inject({
      method: "GET",
      url: `/api/v1/assets/${assetId}/warranties`,
      headers: actor.headers,
    });
    expect(list.json().total).toBe(2);
  });

  it("runs delivery milestones through the MIDP lifecycle", async () => {
    const create = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/delivery-milestones`,
      payload: {
        name: "Stage 4 model drop",
        dueDate: "2026-12-01",
        requiredState: "published",
        requiredSuitability: "A1",
      },
      headers: actor.headers,
    });
    expect(create.statusCode).toBe(201);
    const milestoneId = create.json().id;
    expect(create.json().status).toBe("open");

    const patch = (payload: Record<string, unknown>) =>
      built.app.inject({
        method: "PATCH",
        url: `/api/v1/projects/${projectId}/delivery-milestones/${milestoneId}`,
        payload,
        headers: actor.headers,
      });

    // open → accepted skips delivery
    expect((await patch({ status: "accepted" })).statusCode).toBe(400);
    expect((await patch({ status: "delivered" })).statusCode).toBe(200);
    expect((await patch({ status: "rejected" })).statusCode).toBe(200);
    // rejected → delivered (re-delivery) → accepted
    expect((await patch({ status: "delivered" })).statusCode).toBe(200);
    expect((await patch({ status: "accepted" })).statusCode).toBe(200);
    // accepted is terminal
    expect((await patch({ status: "delivered" })).statusCode).toBe(400);
  });

  it("exports COBie components as CSV", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/cobie.csv`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toContain("text/csv");
    const lines = res.body.trim().split("\r\n");
    expect(lines[0]).toBe(
      "Name,CreatedBy,CreatedOn,TypeName,Space,Description,SerialNumber,InstallationDate,WarrantyStartDate,TagNumber,AssetIdentifier",
    );
    // every asset in the project appears
    expect(lines.length - 1).toBeGreaterThanOrEqual(4);
    const pumpLine = lines.find((l) => l.includes("PMP-01"));
    expect(pumpLine).toBeTruthy();
    // CSV escaping: name contains quotes and a comma
    expect(pumpLine).toContain('"Pump ""primary"", loop A"');
    expect(pumpLine).toContain("2026-06-01");
  });

  it("exports structured COBie JSON", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/cobie.json`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.components.length).toBeGreaterThanOrEqual(4);
    expect(Array.isArray(body.spaces)).toBe(true);
    const plumbing = body.types.find((t: { name: string }) => t.name === "Plumbing");
    expect(plumbing).toBeTruthy();
    expect(plumbing.components).toContain("PMP-01");
  });
});
