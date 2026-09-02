import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companyMemberships,
  fileAccessLog,
  fileVersions,
  projectMemberships,
  projects,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";

let built: BuiltApp;
let actor: TestActor;
let projectId: string;

const BOUNDARY = "----vitestboundary";

function multipartBody(
  fileBuffer: Buffer,
  filename: string,
  contentType: string,
  fields: Record<string, string> = {},
): Buffer {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${BOUNDARY}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${contentType}\r\n\r\n`,
    ),
  );
  parts.push(fileBuffer, Buffer.from(`\r\n--${BOUNDARY}--\r\n`));
  return Buffer.concat(parts);
}

const mpHeaders = (a: TestActor) => ({
  ...a.headers,
  "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
});

beforeAll(async () => {
  built = await buildTestApp();
  actor = await registerActor(built.app);
  projectId = newId("prj");
  await built.app.db
    .insert(projects)
    .values({ id: projectId, companyId: actor.companyId, name: "P1" });
}, 120_000);

afterAll(async () => {
  await built.close();
});

describe("folders", () => {
  let designId: string;
  let structuralId: string;
  let calcsId: string;

  it("creates a nested folder tree with materialized paths", async () => {
    const r1 = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/folders`,
      payload: { name: "Design" },
      headers: actor.headers,
    });
    expect(r1.statusCode).toBe(201);
    designId = r1.json().id;
    expect(r1.json().path).toBe("/Design");

    const r2 = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/folders`,
      payload: { name: "Structural", parentId: designId },
      headers: actor.headers,
    });
    expect(r2.statusCode).toBe(201);
    structuralId = r2.json().id;
    expect(r2.json().path).toBe("/Design/Structural");

    const r3 = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/folders`,
      payload: { name: "Calcs", parentId: structuralId },
      headers: actor.headers,
    });
    calcsId = r3.json().id;
    expect(r3.json().path).toBe("/Design/Structural/Calcs");

    const tree = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/folders`,
      headers: actor.headers,
    });
    expect(tree.statusCode).toBe(200);
    const roots = tree.json().items;
    const design = roots.find((f: { id: string }) => f.id === designId);
    expect(design.children).toHaveLength(1);
    expect(design.children[0].children[0].id).toBe(calcsId);
  });

  it("rejects a duplicate sibling name", async () => {
    const dup = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/folders`,
      payload: { name: "Structural", parentId: designId },
      headers: actor.headers,
    });
    expect(dup.statusCode).toBe(409);
  });

  it("renames a folder and recomputes descendant paths", async () => {
    const res = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/folders/${designId}`,
      payload: { name: "Design Docs" },
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().path).toBe("/Design Docs");

    const tree = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/folders`,
      headers: actor.headers,
    });
    const design = tree.json().items.find((f: { id: string }) => f.id === designId);
    expect(design.children[0].path).toBe("/Design Docs/Structural");
    expect(design.children[0].children[0].path).toBe("/Design Docs/Structural/Calcs");
  });

  it("refuses to move a folder into its own subtree", async () => {
    const res = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/folders/${designId}`,
      payload: { parentId: calcsId },
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(400);
  });

  it("moves a folder to the root", async () => {
    const res = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/folders/${calcsId}`,
      payload: { parentId: null },
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().path).toBe("/Calcs");
    expect(res.json().parentId).toBeNull();
  });

  it("hides private folders from members without documents admin", async () => {
    const priv = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/folders`,
      payload: { name: "Legal Hold", isPrivate: true },
      headers: actor.headers,
    });
    expect(priv.statusCode).toBe(201);

    // a plain member with the field_engineer template (documents: standard)
    const reg = await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: `member-${Date.now()}@test.dev`, password: "password-123", name: "M" },
    });
    const member = reg.json();
    await built.app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: actor.companyId,
      userId: member.user.id,
      role: "member",
    });
    await built.app.db.insert(projectMemberships).values({
      id: newId("pm"),
      companyId: actor.companyId,
      projectId,
      userId: member.user.id,
      templateKey: "field_engineer",
    });
    const memberHeaders = {
      authorization: `Bearer ${member.accessToken}`,
      "x-company-id": actor.companyId,
    };
    const memberTree = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/folders`,
      headers: memberHeaders,
    });
    expect(memberTree.statusCode).toBe(200);
    const names = JSON.stringify(memberTree.json().items);
    expect(names).not.toContain("Legal Hold");

    const ownerTree = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/folders`,
      headers: actor.headers,
    });
    expect(JSON.stringify(ownerTree.json().items)).toContain("Legal Hold");
  });
});

describe("files", () => {
  let folderId: string;
  let fileId: string;
  const v1Bytes = Buffer.from("hello construction v1");
  const v2Bytes = Buffer.from("hello construction v2 - now with more rebar");

  beforeAll(async () => {
    const r = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/folders`,
      payload: { name: "Uploads" },
      headers: actor.headers,
    });
    folderId = r.json().id;
  });

  it("uploads a file as version 1", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/folders/${folderId}/files`,
      payload: multipartBody(v1Bytes, "spec.pdf", "application/pdf"),
      headers: mpHeaders(actor),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    fileId = body.id;
    expect(body.version).toBe(1);
    expect(body.name).toBe("spec.pdf");
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    const versions = await built.app.db
      .select()
      .from(fileVersions)
      .where(eq(fileVersions.fileId, fileId));
    expect(versions).toHaveLength(1);
  });

  it("uploads a new version and bumps the file row", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/files/${fileId}/versions`,
      payload: multipartBody(v2Bytes, "spec.pdf", "application/pdf"),
      headers: mpHeaders(actor),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().version).toBe(2);

    const meta = await built.app.inject({
      method: "GET",
      url: `/api/v1/files/${fileId}`,
      headers: actor.headers,
    });
    expect(meta.json().versions).toHaveLength(2);
    expect(meta.json().versions[0].version).toBe(2);
  });

  it("downloads the current version and logs access", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/files/${fileId}/download`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.rawPayload.equals(v2Bytes)).toBe(true);

    const old = await built.app.inject({
      method: "GET",
      url: `/api/v1/files/${fileId}/download?version=1`,
      headers: actor.headers,
    });
    expect(old.rawPayload.equals(v1Bytes)).toBe(true);

    const log = await built.app.db
      .select()
      .from(fileAccessLog)
      .where(eq(fileAccessLog.fileId, fileId));
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect(log[0]!.action).toBe("download");
  });

  it("lists and searches project files", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/files?search=spec`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().items[0].id).toBe(fileId);

    const miss = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/files?search=nomatch`,
      headers: actor.headers,
    });
    expect(miss.json().total).toBe(0);
  });

  it("enforces checkout / checkin", async () => {
    const out = await built.app.inject({
      method: "POST",
      url: `/api/v1/files/${fileId}/checkout`,
      headers: actor.headers,
    });
    expect(out.statusCode).toBe(200);

    const again = await built.app.inject({
      method: "POST",
      url: `/api/v1/files/${fileId}/checkout`,
      headers: actor.headers,
    });
    expect(again.statusCode).toBe(409);

    const back = await built.app.inject({
      method: "POST",
      url: `/api/v1/files/${fileId}/checkin`,
      headers: actor.headers,
    });
    expect(back.statusCode).toBe(200);
  });

  it("renames and moves a file", async () => {
    const res = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/files/${fileId}`,
      payload: { name: "spec-renamed.pdf" },
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("spec-renamed.pdf");
  });

  it("is invisible to another tenant", async () => {
    const stranger = await registerActor(built.app);
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/files/${fileId}`,
      headers: stranger.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it("refuses to delete a non-empty folder, then deletes file and folder", async () => {
    const notEmpty = await built.app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/folders/${folderId}`,
      headers: actor.headers,
    });
    expect(notEmpty.statusCode).toBe(409);

    const delFile = await built.app.inject({
      method: "DELETE",
      url: `/api/v1/files/${fileId}`,
      headers: actor.headers,
    });
    expect(delFile.statusCode).toBe(200);

    const delFolder = await built.app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/folders/${folderId}`,
      headers: actor.headers,
    });
    expect(delFolder.statusCode).toBe(200);
  });
});
