import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bimElements, projects } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import { decodeStepString, extractIfcElements, splitStepAttrs } from "./ifc-extract.js";

/* ------------------------------------------------------------------ */
/* Fixture: hand-written STEP file — 2 walls + 1 door, names with      */
/* quoted commas and escaped quotes                                    */
/* ------------------------------------------------------------------ */

const WALL_A_GUID = "2O2Fr$t4X7Zf8NOew3FLOH";
const WALL_B_GUID = "1ABCDEFGHIJKLMNOPQRSTU";
const DOOR_GUID = "3ZYXWVUTSRQPONMLKJIHGF";

const IFC_FIXTURE = [
  "ISO-10303-21;",
  "HEADER;",
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('fixture.ifc','2026-08-21T00:00:00',(''),(''),'','','');",
  "ENDSEC;",
  "DATA;",
  "#1=IFCOWNERHISTORY(#2,#3,$,.ADDED.,$,$,$,1234567890);",
  "#2=IFCPERSONANDORGANIZATION(#4,#5,$);",
  `#10=IFCWALLSTANDARDCASE('${WALL_A_GUID}',#1,'Wall, North ''A''',$,$,#20,#21,'TAG-W1');`,
  `#11=IFCWALL('${WALL_B_GUID}',#1,'Wall B',$,$,#20,#22,'TAG-W2');`,
  `#12=IFCDOOR('${DOOR_GUID}',#1,'Door, Main Entrance',$,$,#20,#23,'TAG-D1',2100.,900.);`,
  "#20=IFCLOCALPLACEMENT($,#24);",
  "#21=IFCPRODUCTDEFINITIONSHAPE($,$,(#25));",
  "ENDSEC;",
  "END-ISO-10303-21;",
].join("\n");

/* ------------------------------------------------------------------ */
/* Pure extraction tests                                               */
/* ------------------------------------------------------------------ */

describe("ifc-extract", () => {
  it("splits STEP attrs respecting quotes and nested parens", () => {
    const attrs = splitStepAttrs("'a, b ''c''',#1,$,(#2,#3),2100.");
    expect(attrs).toEqual(["'a, b ''c'''", "#1", "$", "(#2,#3)", "2100."]);
    expect(decodeStepString(attrs[0]!)).toBe("a, b 'c'");
  });

  it("extracts 2 walls + 1 door from the fixture and skips non-elements", () => {
    const result = extractIfcElements(IFC_FIXTURE);
    expect(result.entityCount).toBe(7);
    expect(result.elements).toHaveLength(3);
    const byGuid = new Map(result.elements.map((e) => [e.globalId, e]));
    expect(byGuid.get(WALL_A_GUID)).toMatchObject({
      ifcType: "IFCWALLSTANDARDCASE",
      name: "Wall, North 'A'",
    });
    expect(byGuid.get(WALL_B_GUID)).toMatchObject({ ifcType: "IFCWALL", name: "Wall B" });
    expect(byGuid.get(DOOR_GUID)).toMatchObject({
      ifcType: "IFCDOOR",
      name: "Door, Main Entrance",
    });
  });

  it("tolerates non-allowlisted rooted entities and skips IFCREL*", () => {
    const text = [
      "DATA;",
      "#1=IFCBUILDINGSTOREY('0AAAAAAAAAAAAAAAAAAAAA',#2,'Level 1',$,$,#3,$,$,.ELEMENT.,0.);",
      "#2=IFCRELAGGREGATES('0BBBBBBBBBBBBBBBBBBBBB',#3,$,$,#4,(#5));",
      "ENDSEC;",
    ].join("\n");
    const result = extractIfcElements(text);
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toMatchObject({
      ifcType: "IFCBUILDINGSTOREY",
      globalId: "0AAAAAAAAAAAAAAAAAAAAA",
      name: "Level 1",
    });
  });

  it("returns zero entities for non-STEP content", () => {
    const result = extractIfcElements("this is not an ifc file at all");
    expect(result.entityCount).toBe(0);
    expect(result.elements).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* API tests                                                           */
/* ------------------------------------------------------------------ */

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
let actor: TestActor;
let projectId: string;

beforeAll(async () => {
  built = await buildTestApp();
  actor = await registerActor(built.app);
  projectId = newId("prj");
  await built.app.db
    .insert(projects)
    .values({ id: projectId, companyId: actor.companyId, name: "P1" });
});

afterAll(async () => {
  await built.close();
});

describe("bim module", () => {
  let modelId: string;
  let versionId: string;
  let fileId: string;

  it("creates a model", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/bim/models`,
      payload: { name: "Architecture", discipline: "architectural", format: "ifc" },
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    modelId = body.id;
    expect(body.format).toBe("ifc");
    expect(body.currentVersionId).toBeNull();
  });

  it("uploads an IFC version and extracts elements inline", async () => {
    const mp = multipart(IFC_FIXTURE, "arch.ifc");
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/bim/models/${modelId}/versions`,
      payload: mp.body,
      headers: { ...actor.headers, "content-type": mp.contentType },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    versionId = body.id;
    fileId = body.fileId;
    expect(body.version).toBe(1);
    expect(body.cdeState).toBe("wip");
    expect(body.suitability).toBe("S0");
    expect(body.processing).toBe("ready");
    expect(body.elementCount).toBe(3);

    // model now points at the new version
    const modelRes = await built.app.inject({
      method: "GET",
      url: `/api/v1/bim/models/${modelId}`,
      headers: actor.headers,
    });
    expect(modelRes.statusCode).toBe(200);
    expect(modelRes.json().currentVersionId).toBe(versionId);
    expect(modelRes.json().versions).toHaveLength(1);
  });

  it("lists models with current version info", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/bim/models`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].currentVersion.id).toBe(versionId);
    expect(body.items[0].currentVersion.elementCount).toBe(3);
  });

  it("lists elements with filters", async () => {
    const all = await built.app.inject({
      method: "GET",
      url: `/api/v1/bim/versions/${versionId}/elements`,
      headers: actor.headers,
    });
    expect(all.statusCode).toBe(200);
    expect(all.json().total).toBe(3);

    const doors = await built.app.inject({
      method: "GET",
      url: `/api/v1/bim/versions/${versionId}/elements?ifcType=IFCDOOR`,
      headers: actor.headers,
    });
    expect(doors.json().total).toBe(1);
    expect(doors.json().items[0].name).toBe("Door, Main Entrance");

    const search = await built.app.inject({
      method: "GET",
      url: `/api/v1/bim/versions/${versionId}/elements?search=North`,
      headers: actor.headers,
    });
    expect(search.json().total).toBe(1);
    expect(search.json().items[0].name).toBe("Wall, North 'A'");
  });

  it("groups element types with counts", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/bim/versions/${versionId}/element-types`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { ifcType: string; count: number }[];
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.ifcType).sort()).toEqual([
      "IFCDOOR",
      "IFCWALL",
      "IFCWALLSTANDARDCASE",
    ]);
    expect(items.every((i) => i.count === 1)).toBe(true);
  });

  it("resolves an element by GlobalId at project level", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/bim/elements/by-guid/${WALL_A_GUID}`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ifcType).toBe("IFCWALLSTANDARDCASE");
    expect(res.json().occurrences).toHaveLength(1);

    const missing = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/bim/elements/by-guid/0000000000000000000000`,
      headers: actor.headers,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("enforces the ISO 19650 CDE state machine", async () => {
    const patch = (payload: Record<string, string>) =>
      built.app.inject({
        method: "PATCH",
        url: `/api/v1/bim/versions/${versionId}/state`,
        payload,
        headers: actor.headers,
      });

    // skipping wip → published is illegal
    expect((await patch({ cdeState: "published", suitability: "A1" })).statusCode).toBe(400);
    // S0 is only coherent with wip
    expect((await patch({ cdeState: "shared", suitability: "S0" })).statusCode).toBe(400);
    // wip → shared with a shared-range code
    const shared = await patch({ cdeState: "shared", suitability: "S2" });
    expect(shared.statusCode).toBe(200);
    expect(shared.json().cdeState).toBe("shared");
    // re-share is allowed
    expect((await patch({ cdeState: "shared", suitability: "S3" })).statusCode).toBe(200);
    // backward to wip is illegal
    expect((await patch({ cdeState: "wip", suitability: "S0" })).statusCode).toBe(400);
    // shared → published
    expect((await patch({ cdeState: "published", suitability: "A1" })).statusCode).toBe(200);
    // published → archived (as-constructed record)
    expect((await patch({ cdeState: "archived", suitability: "CR" })).statusCode).toBe(200);
    // archived is terminal
    expect((await patch({ cdeState: "shared", suitability: "S1" })).statusCode).toBe(400);
  });

  it("increments version numbers on subsequent uploads", async () => {
    const mp = multipart(IFC_FIXTURE, "arch-v2.ifc");
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/bim/models/${modelId}/versions`,
      payload: mp.body,
      headers: { ...actor.headers, "content-type": mp.contentType },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().version).toBe(2);
  });

  it("marks unparseable IFC uploads failed instead of 500", async () => {
    const mp = multipart("definitely not a step file", "broken.ifc");
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/bim/models/${modelId}/versions`,
      payload: mp.body,
      headers: { ...actor.headers, "content-type": mp.contentType },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().processing).toBe("failed");
    expect(res.json().elementCount).toBe(0);
  });

  it("streams the model file for the viewer", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/bim/files/${fileId}/model`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.body).toBe(IFC_FIXTURE);
  });

  it("manages federations and members", async () => {
    const groupRes = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/bim/federations`,
      payload: { name: "Full building" },
      headers: actor.headers,
    });
    expect(groupRes.statusCode).toBe(201);
    const groupId = groupRes.json().id;

    const memberRes = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/bim/federations/${groupId}/members`,
      payload: { modelVersionId: versionId, transform: { tx: 0, ty: 0, tz: 0 } },
      headers: actor.headers,
    });
    expect(memberRes.statusCode).toBe(201);
    const memberId = memberRes.json().id;

    const dupe = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/bim/federations/${groupId}/members`,
      payload: { modelVersionId: versionId },
      headers: actor.headers,
    });
    expect(dupe.statusCode).toBe(409);

    const list = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/bim/federations`,
      headers: actor.headers,
    });
    expect(list.json().items[0].members).toHaveLength(1);
    expect(list.json().items[0].members[0].modelName).toBe("Architecture");

    const delMember = await built.app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/bim/federations/${groupId}/members/${memberId}`,
      headers: actor.headers,
    });
    expect(delMember.statusCode).toBe(200);

    const delGroup = await built.app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/bim/federations/${groupId}`,
      headers: actor.headers,
    });
    expect(delGroup.statusCode).toBe(200);
  });

  it("runs coordination issues through their lifecycle", async () => {
    const createRes = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/bim/issues`,
      payload: {
        title: "Duct clashes with beam",
        elementGlobalIds: [WALL_A_GUID],
        modelVersionId: versionId,
        viewpoint: { camera: [1, 2, 3] },
      },
      headers: actor.headers,
    });
    expect(createRes.statusCode).toBe(201);
    const issue = createRes.json();
    expect(issue.number).toBe(1);
    expect(issue.status).toBe("open");

    const second = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/bim/issues`,
      payload: { title: "Another clash" },
      headers: actor.headers,
    });
    expect(second.json().number).toBe(2);

    const patch = (payload: Record<string, unknown>) =>
      built.app.inject({
        method: "PATCH",
        url: `/api/v1/bim/issues/${issue.id}`,
        payload,
        headers: actor.headers,
      });

    // open → resolved skips assignment
    expect((await patch({ status: "resolved" })).statusCode).toBe(400);
    // assigned requires an assignee
    expect((await patch({ status: "assigned" })).statusCode).toBe(400);
    expect(
      (await patch({ status: "assigned", assigneeId: actor.userId })).statusCode,
    ).toBe(200);
    expect((await patch({ status: "resolved" })).statusCode).toBe(200);
    expect((await patch({ status: "verified" })).statusCode).toBe(200);
    // verified cannot reopen
    expect((await patch({ status: "assigned" })).statusCode).toBe(400);

    const single = await built.app.inject({
      method: "GET",
      url: `/api/v1/bim/issues/${issue.id}`,
      headers: actor.headers,
    });
    expect(single.statusCode).toBe(200);
    expect(single.json().status).toBe("verified");
    expect(single.json().elementGlobalIds).toEqual([WALL_A_GUID]);
  });

  it("isolates tenants", async () => {
    const outsider = await registerActor(built.app);
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/bim/models/${modelId}`,
      headers: outsider.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it("deletes a model and its elements (company admin)", async () => {
    const res = await built.app.inject({
      method: "DELETE",
      url: `/api/v1/bim/models/${modelId}`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    const remaining = await built.app.db
      .select()
      .from(bimElements)
      .where(eq(bimElements.projectId, projectId));
    expect(remaining).toHaveLength(0);
  });
});
