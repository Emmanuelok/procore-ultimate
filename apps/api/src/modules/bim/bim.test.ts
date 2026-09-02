/**
 * BIM module — models, asynchronous ingestion, ISO 19650 CDE authorisation,
 * elements/locations, version comparison, the viewer stream and the tool
 * gates on every id-scoped route.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  bimElements,
  bimModelVersions,
  companyMemberships,
  fileAccessLog,
  files,
  locations,
  projectMemberships,
  projects,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import { DOOR_GUID, IFC_FIXTURE, WALL_A_GUID } from "./fixtures.js";

function multipart(content: Buffer | string, filename: string) {
  const boundary = "----vitestboundary";
  const fileBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: application/octet-stream\r\n\r\n`,
    ),
    fileBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

let built: BuiltApp;
let owner: TestActor;
/** a second company admin: the ISO 19650 authoriser, never the uploader */
let authoriser: TestActor;
let authoriserHeaders: Record<string, string>;
/** a member on the subcontractor template: bim = none */
let subcontractor: TestActor;
let subHeaders: Record<string, string>;
let projectId: string;

const upload = (modelId: string, content: string, filename: string, headers: Record<string, string>) => {
  const mp = multipart(content, filename);
  return built.app.inject({
    method: "POST",
    url: `/api/v1/bim/models/${modelId}/versions`,
    payload: mp.body,
    headers: { ...headers, "content-type": mp.contentType },
  });
};

beforeAll(async () => {
  built = await buildTestApp();
  owner = await registerActor(built.app);
  authoriser = await registerActor(built.app);
  subcontractor = await registerActor(built.app);
  await built.app.db.insert(companyMemberships).values([
    { id: newId("cm"), companyId: owner.companyId, userId: authoriser.userId, role: "admin" },
    { id: newId("cm"), companyId: owner.companyId, userId: subcontractor.userId, role: "member" },
  ]);
  authoriserHeaders = {
    authorization: `Bearer ${authoriser.accessToken}`,
    "x-company-id": owner.companyId,
  };
  subHeaders = {
    authorization: `Bearer ${subcontractor.accessToken}`,
    "x-company-id": owner.companyId,
  };
  projectId = newId("prj");
  await built.app.db
    .insert(projects)
    .values({ id: projectId, companyId: owner.companyId, name: "P1" });
  await built.app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId,
    userId: subcontractor.userId,
    templateKey: "subcontractor",
    overrides: {},
  });
}, 180_000);

afterAll(async () => {
  await built.close();
});

describe("bim module — models and ingestion", () => {
  let modelId: string;
  let versionId: string;
  let fileId: string;

  it("creates a model", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/bim/models`,
      payload: { name: "Architecture", discipline: "architectural", format: "ifc" },
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(201);
    modelId = res.json().id;
    expect(res.json().currentVersionId).toBeNull();
  });

  it("uploads an IFC version, extracts elements and creates locations from the spatial structure", async () => {
    const res = await upload(modelId, IFC_FIXTURE, "arch.ifc", owner.headers);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    versionId = body.id;
    fileId = body.fileId;
    expect(body.version).toBe(1);
    expect(body.cdeState).toBe("wip");
    expect(body.processing).toBe("ready");
    expect(body.elementCount).toBe(3);
    expect(body.spatialCount).toBe(4);
    expect(body.queued).toBe(false);

    // #248 — model-based location assignment
    const locationRows = await built.app.db
      .select()
      .from(locations)
      .where(eq(locations.projectId, projectId));
    expect(locationRows.map((l) => l.name).sort()).toEqual([
      "Level 01",
      "Riverside Site",
      "Room 1.01",
      "Tower A",
    ]);
    const storey = locationRows.find((l) => l.name === "Level 01")!;
    const elements = await built.app.db
      .select()
      .from(bimElements)
      .where(eq(bimElements.modelVersionId, versionId));
    expect(elements).toHaveLength(3);
    expect(elements.every((e) => e.locationId === storey.id)).toBe(true);
    const wall = elements.find((e) => e.globalId === WALL_A_GUID)!;
    expect(wall.storey).toBe("Level 01");
    expect(wall.typeName).toBe("Basic Wall:Interior 100mm");
    expect(wall.classification).toBe("Ss_25_10_30_60");
    expect(wall.properties["Pset_WallCommon.FireRating"]).toBe("2 HR");
    expect(wall.minX).toBeCloseTo(-2, 6);
    expect(wall.propertyHash).toBeTruthy();

    const modelRes = await built.app.inject({
      method: "GET",
      url: `/api/v1/bim/models/${modelId}`,
      headers: owner.headers,
    });
    expect(modelRes.json().currentVersionId).toBe(versionId);
  });

  it("does not create a second copy of a location when the same model is re-uploaded", async () => {
    const before = await built.app.db
      .select()
      .from(locations)
      .where(eq(locations.projectId, projectId));
    const res = await upload(modelId, IFC_FIXTURE, "arch-v2.ifc", owner.headers);
    expect(res.statusCode).toBe(201);
    expect(res.json().version).toBe(2);
    const after = await built.app.db
      .select()
      .from(locations)
      .where(eq(locations.projectId, projectId));
    expect(after).toHaveLength(before.length);
  });

  it("allocates version numbers atomically when two uploads race", async () => {
    const modelRes = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/bim/models`,
      payload: { name: "Race", format: "ifc" },
      headers: owner.headers,
    });
    const raceId = modelRes.json().id;
    const [first, second] = await Promise.all([
      upload(raceId, IFC_FIXTURE, "race-a.ifc", owner.headers),
      upload(raceId, IFC_FIXTURE, "race-b.ifc", owner.headers),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 201]);
    expect([first.json().version, second.json().version].sort()).toEqual([1, 2]);
  });

  it("marks an unparseable IFC failed with the reason instead of 500", async () => {
    const res = await upload(modelId, "definitely not a step file", "broken.ifc", owner.headers);
    expect(res.statusCode).toBe(201);
    expect(res.json().processing).toBe("failed");
    expect(res.json().processingError).toContain("not a STEP/IFC container");
    // the failed version must not become the model's current version
    const modelRes = await built.app.inject({
      method: "GET",
      url: `/api/v1/bim/models/${modelId}`,
      headers: owner.headers,
    });
    expect(modelRes.json().currentVersionId).not.toBe(res.json().id);
  });

  it("refuses a file type the pipeline cannot handle", async () => {
    const res = await upload(modelId, "hello", "notes.txt", owner.headers);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("Unsupported model file type");
  });

  it("re-processes a version on demand and is idempotent", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/bim/versions/${versionId}/process`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().elementCount).toBe(3);
    const elements = await built.app.db
      .select()
      .from(bimElements)
      .where(eq(bimElements.modelVersionId, versionId));
    expect(elements).toHaveLength(3);
  });

  it("drains the ingest queue from the scheduler job", async () => {
    // simulate a large upload that was queued rather than parsed inline
    await built.app.db
      .update(bimModelVersions)
      .set({ processing: "queued", elementCount: 0 })
      .where(eq(bimModelVersions.id, versionId));
    await built.app.db.delete(bimElements).where(eq(bimElements.modelVersionId, versionId));
    await built.app.scheduler.runNow("bim.ingest");
    const [version] = await built.app.db
      .select()
      .from(bimModelVersions)
      .where(eq(bimModelVersions.id, versionId));
    expect(version?.processing).toBe("ready");
    expect(version?.elementCount).toBe(3);
  });

  it("lists elements with filters and groups types and storeys", async () => {
    const doors = await built.app.inject({
      method: "GET",
      url: `/api/v1/bim/versions/${versionId}/elements?ifcType=IFCDOOR`,
      headers: owner.headers,
    });
    expect(doors.json().total).toBe(1);
    expect(doors.json().items[0].globalId).toBe(DOOR_GUID);

    const withBounds = await built.app.inject({
      method: "GET",
      url: `/api/v1/bim/versions/${versionId}/elements?hasBounds=1`,
      headers: owner.headers,
    });
    expect(withBounds.json().total).toBe(2);

    const types = await built.app.inject({
      method: "GET",
      url: `/api/v1/bim/versions/${versionId}/element-types`,
      headers: owner.headers,
    });
    expect(types.json().items).toHaveLength(3);
    expect(types.json().storeys[0]).toMatchObject({ storey: "Level 01", count: 3 });
  });

  it("resolves an element by GlobalId across versions", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/bim/elements/by-guid/${WALL_A_GUID}`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().occurrences.length).toBeGreaterThanOrEqual(2);

    const missing = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/bim/elements/by-guid/0000000000000000000000`,
      headers: owner.headers,
    });
    expect(missing.statusCode).toBe(404);
  });

  /* ------------------------------------------------------------------ */
  /* CDE state machine + ISO 19650 authorisation                         */
  /* ------------------------------------------------------------------ */

  it("enforces the CDE state machine", async () => {
    const patch = (payload: Record<string, string>, headers = owner.headers) =>
      built.app.inject({
        method: "PATCH",
        url: `/api/v1/bim/versions/${versionId}/state`,
        payload,
        headers,
      });

    expect((await patch({ cdeState: "published", suitability: "A1" })).statusCode).toBe(400);
    expect((await patch({ cdeState: "shared", suitability: "S0" })).statusCode).toBe(400);
    const shared = await patch({ cdeState: "shared", suitability: "S2" });
    expect(shared.statusCode).toBe(200);
    expect((await patch({ cdeState: "shared", suitability: "S3" })).statusCode).toBe(200);
    expect((await patch({ cdeState: "wip", suitability: "S0" })).statusCode).toBe(400);
  });

  it("refuses to let the uploader authorise their own publication", async () => {
    const res = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/bim/versions/${versionId}/state`,
      payload: { cdeState: "published", suitability: "A1" },
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("separate authoriser");
  });

  it("publishes when a different admin authorises, and records who", async () => {
    const res = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/bim/versions/${versionId}/state`,
      payload: { cdeState: "published", suitability: "A1", note: "Checked against the BEP" },
      headers: authoriserHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().authorisedBy).toBe(authoriser.userId);
    expect(res.json().authorisedAt).toBeTruthy();
    expect((await built.app.inject({
      method: "PATCH",
      url: `/api/v1/bim/versions/${versionId}/state`,
      payload: { cdeState: "archived", suitability: "CR" },
      headers: authoriserHeaders,
    })).statusCode).toBe(200);
  });

  it("refuses to publish a version whose extraction failed, and one that fails the quality gate", async () => {
    // a failed version
    const failed = await upload(modelId, "still not a step file", "broken2.ifc", owner.headers);
    const failedId = failed.json().id;
    await built.app.inject({
      method: "PATCH",
      url: `/api/v1/bim/versions/${failedId}/state`,
      payload: { cdeState: "shared", suitability: "S2" },
      headers: owner.headers,
    });
    const res = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/bim/versions/${failedId}/state`,
      payload: { cdeState: "published", suitability: "A1" },
      headers: authoriserHeaders,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("extraction");
  });

  /* ------------------------------------------------------------------ */
  /* Version comparison (#236)                                           */
  /* ------------------------------------------------------------------ */

  it("compares two versions of a model and caches the diff", async () => {
    const modelRes = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/bim/models`,
      payload: { name: "Structure", format: "ifc" },
      headers: owner.headers,
    });
    const structureId = modelRes.json().id;
    const v1 = await upload(structureId, IFC_FIXTURE, "str-v1.ifc", owner.headers);
    // v2 renames wall A and drops the door
    const changed = IFC_FIXTURE.replace("'Wall; North ''A''',", "'Wall; North RENAMED',")
      .split("\n")
      .filter((line) => !line.startsWith("#12=IFCDOOR"))
      .join("\n");
    const v2 = await upload(structureId, changed, "str-v2.ifc", owner.headers);
    expect(v2.json().elementCount).toBe(2);

    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/bim/versions/${v2.json().id}/diff`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.baseVersionId).toBe(v1.json().id);
    expect(body.cached).toBe(false);
    expect(body.diff.removedCount).toBe(1);
    expect(body.diff.modifiedCount).toBe(1);
    expect(body.diff.addedCount).toBe(0);
    expect(body.diff.unchangedCount).toBe(1);
    expect(body.diff.byType["IFCDOOR"]).toMatchObject({ removed: 1 });

    const again = await built.app.inject({
      method: "GET",
      url: `/api/v1/bim/versions/${v2.json().id}/diff`,
      headers: owner.headers,
    });
    expect(again.json().cached).toBe(true);
  });

  it("explains that a first version has nothing to compare against", async () => {
    const modelRes = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/bim/models`,
      payload: { name: "MEP", format: "ifc" },
      headers: owner.headers,
    });
    const v1 = await upload(modelRes.json().id, IFC_FIXTURE, "mep.ifc", owner.headers);
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/bim/versions/${v1.json().id}/diff`,
      headers: owner.headers,
    });
    expect(res.json().diff).toBeNull();
    expect(res.json().reason).toContain("first version");
  });

  /* ------------------------------------------------------------------ */
  /* Model stream                                                        */
  /* ------------------------------------------------------------------ */

  it("streams the model container and records the access", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/bim/files/${fileId}/model`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(IFC_FIXTURE);
    const log = await built.app.db
      .select()
      .from(fileAccessLog)
      .where(eq(fileAccessLog.fileId, fileId));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ context: "bim_viewer", action: "download" });
  });

  it("refuses to stream a file that is not a model container", async () => {
    const otherFileId = newId("fil");
    await built.app.db.insert(files).values({
      id: otherFileId,
      companyId: owner.companyId,
      projectId,
      name: "legal-hold.pdf",
      contentType: "application/pdf",
      sizeBytes: 10,
      sha256: "x".repeat(64),
      storageKey: "nope",
      isPrivate: 1,
      metadata: {},
      uploadedBy: owner.userId,
    });
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/bim/files/${otherFileId}/model`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(404);
    const log = await built.app.db
      .select()
      .from(fileAccessLog)
      .where(eq(fileAccessLog.fileId, otherFileId));
    expect(log).toHaveLength(0);
  });

  /* ------------------------------------------------------------------ */
  /* Authorisation                                                       */
  /* ------------------------------------------------------------------ */

  it("refuses every id-scoped route to a member whose template has bim: none", async () => {
    const cases: Array<[string, string, unknown?]> = [
      ["GET", `/api/v1/bim/models/${modelId}`],
      ["PATCH", `/api/v1/bim/models/${modelId}`, { name: "Renamed by a subcontractor" }],
      ["DELETE", `/api/v1/bim/models/${modelId}`],
      ["GET", `/api/v1/bim/versions/${versionId}/elements`],
      ["POST", `/api/v1/bim/versions/${versionId}/process`],
      ["GET", `/api/v1/bim/files/${fileId}/model`],
      [
        "PATCH",
        `/api/v1/bim/versions/${versionId}/state`,
        { cdeState: "shared", suitability: "S2" },
      ],
    ];
    for (const [method, url, payload] of cases) {
      const res = await built.app.inject({
        method: method as "GET",
        url,
        headers: subHeaders,
        ...(payload !== undefined ? { payload } : {}),
      });
      expect([403, 404], `${method} ${url}`).toContain(res.statusCode);
    }
    // the upload path is refused too
    const res = await upload(modelId, IFC_FIXTURE, "sneaky.ifc", subHeaders);
    expect(res.statusCode).toBe(403);
  });

  it("isolates tenants", async () => {
    const outsider = await registerActor(built.app);
    for (const url of [
      `/api/v1/bim/models/${modelId}`,
      `/api/v1/bim/versions/${versionId}/elements`,
      `/api/v1/bim/files/${fileId}/model`,
    ]) {
      const res = await built.app.inject({ method: "GET", url, headers: outsider.headers });
      expect(res.statusCode).toBe(404);
    }
    const write = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/bim/models/${modelId}`,
      payload: { name: "Owned by nobody" },
      headers: outsider.headers,
    });
    expect(write.statusCode).toBe(404);
  });

  it("deletes a model with its elements, files and references (admin only)", async () => {
    const modelRes = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/bim/models`,
      payload: { name: "Temporary", format: "ifc" },
      headers: owner.headers,
    });
    const tempId = modelRes.json().id;
    const version = await upload(tempId, IFC_FIXTURE, "temp.ifc", owner.headers);
    const tempFileId = version.json().fileId;

    const res = await built.app.inject({
      method: "DELETE",
      url: `/api/v1/bim/models/${tempId}`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().filesRemoved).toBe(1);

    const remainingElements = await built.app.db
      .select()
      .from(bimElements)
      .where(eq(bimElements.modelVersionId, version.json().id));
    expect(remainingElements).toHaveLength(0);
    const remainingFiles = await built.app.db
      .select()
      .from(files)
      .where(and(eq(files.id, tempFileId), eq(files.companyId, owner.companyId)));
    expect(remainingFiles).toHaveLength(0);
  });
});
