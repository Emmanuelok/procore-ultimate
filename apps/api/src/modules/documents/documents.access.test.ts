/**
 * Document control upgrades: inherited privacy, folder ACLs, tool-level
 * gating on id-scoped routes, referenced-file protection, multi-file upload,
 * copy/preview/recycle bin, the access report, e-mail-to-folder ingestion
 * and the stale-checkout sweep (spec #287, #291–#301).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { companyMemberships, files, notifications, projectMemberships, projects } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";

const BOUNDARY = "----vitestdocaccess";

interface Part {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

function multipart(parts: Part[], fields: Record<string, string> = {}): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const p of parts) {
    chunks.push(
      Buffer.from(`--${BOUNDARY}\r\ncontent-disposition: form-data; name="file"; filename="${p.filename}"\r\ncontent-type: ${p.contentType}\r\n\r\n`),
      p.buffer,
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

const mp = (headers: Record<string, string>) => ({ ...headers, "content-type": `multipart/form-data; boundary=${BOUNDARY}` });

let built: BuiltApp;
let owner: TestActor;
let projectId: string;

interface Member {
  userId: string;
  headers: Record<string, string>;
}

async function addMember(templateKey: string | null): Promise<Member> {
  const reg = await built.app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: `m-${newId()}@test.dev`, password: "password-123", name: `Member ${templateKey ?? "none"}` },
  });
  const body = reg.json() as { user: { id: string }; accessToken: string };
  await built.app.db.insert(companyMemberships).values({ id: newId("cm"), companyId: owner.companyId, userId: body.user.id, role: "member" });
  if (templateKey) {
    await built.app.db.insert(projectMemberships).values({ id: newId("pm"), companyId: owner.companyId, projectId, userId: body.user.id, templateKey, overrides: {} });
  }
  return { userId: body.user.id, headers: { authorization: `Bearer ${body.accessToken}`, "x-company-id": owner.companyId } };
}

const get = (url: string, headers: Record<string, string>) => built.app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Record<string, string>, payload?: unknown) => built.app.inject({ method: "POST", url, headers, ...(payload !== undefined ? { payload } : {}) });
const patch = (url: string, headers: Record<string, string>, payload: unknown) => built.app.inject({ method: "PATCH", url, headers, payload });
const del = (url: string, headers: Record<string, string>) => built.app.inject({ method: "DELETE", url, headers });

async function mkFolder(name: string, parentId: string | null = null, isPrivate = false): Promise<string> {
  const res = await post(`/api/v1/projects/${projectId}/folders`, owner.headers, { name, parentId, isPrivate });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json().id as string;
}

async function upload(folderId: string, name: string, content: string, contentType = "text/plain", headers = owner.headers): Promise<string> {
  const res = await built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/folders/${folderId}/files`,
    payload: multipart([{ buffer: Buffer.from(content), filename: name, contentType }]),
    headers: mp(headers),
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json().id as string;
}

beforeAll(async () => {
  built = await buildTestApp();
  owner = await registerActor(built.app);
  projectId = newId("prj");
  await built.app.db.insert(projects).values({ id: projectId, companyId: owner.companyId, name: "Docs" });
}, 120_000);

afterAll(async () => {
  await built.close();
});

describe("private folders are inherited (#296)", () => {
  let legalId: string;
  let claimsId: string;
  let claimFileId: string;
  let engineer: Member;

  beforeAll(async () => {
    legalId = await mkFolder("Legal Hold", null, true);
    claimsId = await mkFolder("Claims", legalId);
    claimFileId = await upload(claimsId, "claim.txt", "privileged");
    engineer = await addMember("field_engineer");
  });

  it("REGRESSION: a child of a private folder and its files are invisible to non-admins", async () => {
    const tree = (await get(`/api/v1/projects/${projectId}/folders`, engineer.headers)).json();
    expect(JSON.stringify(tree.items)).not.toContain("Claims");
    expect(tree.items.some((f: { id: string }) => f.id === claimsId)).toBe(false);
    expect((await get(`/api/v1/projects/${projectId}/files?folderId=${claimsId}`, engineer.headers)).json().total).toBe(0);
    expect((await get(`/api/v1/projects/${projectId}/files`, engineer.headers)).json().items.some((f: { id: string }) => f.id === claimFileId)).toBe(false);
    expect((await get(`/api/v1/files/${claimFileId}`, engineer.headers)).statusCode).toBe(404);
    expect((await get(`/api/v1/files/${claimFileId}/download`, engineer.headers)).statusCode).toBe(404);
    expect((await get(`/api/v1/files/${claimFileId}`, owner.headers)).statusCode).toBe(200);
  });

  it("a folder-level admin grant opens the private subtree to that person only", async () => {
    const put = await built.app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/folders/${legalId}/permissions`,
      payload: { permissions: { [engineer.userId]: "admin" } },
      headers: owner.headers,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().people[engineer.userId].name).toContain("Member");
    expect((await get(`/api/v1/files/${claimFileId}`, engineer.headers)).statusCode).toBe(200);
    const other = await addMember("field_engineer");
    expect((await get(`/api/v1/files/${claimFileId}`, other.headers)).statusCode).toBe(404);
    await built.app.inject({ method: "PUT", url: `/api/v1/projects/${projectId}/folders/${legalId}/permissions`, payload: { permissions: {} }, headers: owner.headers });
  });

  it("an explicit `none` hides a public subtree from one person", async () => {
    const designId = await mkFolder("Design");
    const structId = await mkFolder("Structural", designId);
    const fileId = await upload(structId, "calc.txt", "moment = wl^2/8");
    expect((await get(`/api/v1/files/${fileId}`, engineer.headers)).statusCode).toBe(200);
    await built.app.inject({ method: "PUT", url: `/api/v1/projects/${projectId}/folders/${designId}/permissions`, payload: { permissions: { [engineer.userId]: "none" } }, headers: owner.headers });
    const tree = (await get(`/api/v1/projects/${projectId}/folders`, engineer.headers)).json();
    expect(JSON.stringify(tree.items)).not.toContain("Structural");
    expect((await get(`/api/v1/files/${fileId}`, engineer.headers)).statusCode).toBe(404);
    // and `read` lets them look but not touch
    await built.app.inject({ method: "PUT", url: `/api/v1/projects/${projectId}/folders/${designId}/permissions`, payload: { permissions: { [engineer.userId]: "read" } }, headers: owner.headers });
    expect((await get(`/api/v1/files/${fileId}`, engineer.headers)).statusCode).toBe(200);
    expect((await patch(`/api/v1/files/${fileId}`, engineer.headers, { name: "renamed.txt" })).statusCode).toBe(403);
    expect((await get(`/api/v1/projects/${projectId}/folders`, engineer.headers)).json().items.find((f: { id: string }) => f.id === designId).effectiveLevel).toBe("read");
  });
});

describe("tool level on id-scoped file routes", () => {
  let folderId: string;
  let fileId: string;
  let reader: Member;
  let outsider: Member;

  beforeAll(async () => {
    folderId = await mkFolder("Public");
    fileId = await upload(folderId, "notes.txt", "v1");
    reader = await addMember("subcontractor"); // documents: read
    outsider = await addMember(null);
  });

  it("REGRESSION: a non-member holding a file id gets 404 on every route", async () => {
    expect((await get(`/api/v1/files/${fileId}`, outsider.headers)).statusCode).toBe(404);
    expect((await get(`/api/v1/files/${fileId}/download`, outsider.headers)).statusCode).toBe(404);
    expect((await patch(`/api/v1/files/${fileId}`, outsider.headers, { name: "x" })).statusCode).toBe(404);
    expect((await post(`/api/v1/files/${fileId}/checkout`, outsider.headers)).statusCode).toBe(404);
    expect((await del(`/api/v1/files/${fileId}`, outsider.headers)).statusCode).toBe(404);
    const version = await built.app.inject({ method: "POST", url: `/api/v1/files/${fileId}/versions`, payload: multipart([{ buffer: Buffer.from("v2"), filename: "notes.txt", contentType: "text/plain" }]), headers: mp(outsider.headers) });
    expect(version.statusCode).toBe(404);
  });

  it("REGRESSION: a read-level member can read and download but not mutate", async () => {
    expect((await get(`/api/v1/files/${fileId}`, reader.headers)).statusCode).toBe(200);
    expect((await get(`/api/v1/files/${fileId}/download`, reader.headers)).statusCode).toBe(200);
    expect((await patch(`/api/v1/files/${fileId}`, reader.headers, { name: "x" })).statusCode).toBe(403);
    expect((await post(`/api/v1/files/${fileId}/checkout`, reader.headers)).statusCode).toBe(403);
    expect((await del(`/api/v1/files/${fileId}`, reader.headers)).statusCode).toBe(403);
    expect((await post(`/api/v1/files/${fileId}/copy`, reader.headers, {})).statusCode).toBe(403);
    const version = await built.app.inject({ method: "POST", url: `/api/v1/files/${fileId}/versions`, payload: multipart([{ buffer: Buffer.from("v2"), filename: "notes.txt", contentType: "text/plain" }]), headers: mp(reader.headers) });
    expect(version.statusCode).toBe(403);
  });

  it("REGRESSION: the check-in button truth is in the API — only the holder or an admin can check in", async () => {
    const engineer = await addMember("field_engineer");
    expect((await post(`/api/v1/files/${fileId}/checkout`, engineer.headers)).statusCode).toBe(200);
    const list = (await get(`/api/v1/projects/${projectId}/files?folderId=${folderId}`, owner.headers)).json();
    const row = list.items.find((f: { id: string }) => f.id === fileId);
    expect(row.checkedOutByName).toContain("Member");
    expect(row.uploadedByName).toBeTruthy();
    const another = await addMember("field_engineer");
    expect((await post(`/api/v1/files/${fileId}/checkin`, another.headers)).statusCode).toBe(403);
    expect((await get(`/api/v1/files/${fileId}`, another.headers)).json().access.canCheckin).toBe(false);
    expect((await get(`/api/v1/files/${fileId}`, engineer.headers)).json().access.canCheckin).toBe(true);
    expect((await post(`/api/v1/files/${fileId}/checkin`, owner.headers)).statusCode).toBe(200);
  });
});

describe("files: multi-upload, metadata search, copy, preview, references, recycle bin", () => {
  let folderId: string;
  let fileId: string;

  beforeAll(async () => {
    folderId = await mkFolder("Uploads");
  });

  it("accepts several files in one request, classifying each part", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/folders/${folderId}/files`,
      payload: multipart(
        [
          { buffer: Buffer.from("report body"), filename: "report.txt", contentType: "text/plain" },
          { buffer: Buffer.from("MZ..."), filename: "payload.exe", contentType: "application/octet-stream" },
          { buffer: Buffer.from("csv,data"), filename: "rates.csv", contentType: "application/octet-stream" },
        ],
        { documentType: "report", tags: "monthly, qa", description: "September progress report", revisionLabel: "P02" },
      ),
      headers: mp(owner.headers),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().items).toHaveLength(2);
    expect(res.json().rejected).toEqual([{ filename: "payload.exe", reason: expect.stringMatching(/\.exe/) }]);
    const csv = res.json().items.find((f: { name: string }) => f.name === "rates.csv");
    expect(csv.contentType).toBe("text/csv");
    fileId = res.json().items.find((f: { name: string }) => f.name === "report.txt").id;
    expect(res.json().items[0]).toMatchObject({ documentType: "report", tags: ["monthly", "qa"], revisionLabel: "P02" });
    const empty = await built.app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/folders/${folderId}/files`, payload: multipart([{ buffer: Buffer.from("x"), filename: "bad.exe", contentType: "text/plain" }]), headers: mp(owner.headers) });
    expect(empty.statusCode).toBe(400);
  });

  it("searches by metadata: type, tag, description and revision label (#287)", async () => {
    expect((await get(`/api/v1/projects/${projectId}/files?documentType=report`, owner.headers)).json().total).toBe(2);
    expect((await get(`/api/v1/projects/${projectId}/files?tag=monthly`, owner.headers)).json().total).toBe(2);
    expect((await get(`/api/v1/projects/${projectId}/files?tag=weekly`, owner.headers)).json().total).toBe(0);
    expect((await get(`/api/v1/projects/${projectId}/files?search=September`, owner.headers)).json().total).toBe(2);
    expect((await get(`/api/v1/projects/${projectId}/files?search=P02`, owner.headers)).json().total).toBe(2);
    expect((await get(`/api/v1/projects/${projectId}/files?search=qa`, owner.headers)).json().total).toBe(2);
    expect((await get(`/api/v1/projects/${projectId}/files?contentType=text/csv`, owner.headers)).json().total).toBe(1);
  });

  it("copies a file over the same bytes and previews inline where it can", async () => {
    const copy = await post(`/api/v1/files/${fileId}/copy`, owner.headers, {});
    expect(copy.statusCode).toBe(201);
    expect(copy.json().name).toBe("Copy of report.txt");
    const original = (await get(`/api/v1/files/${fileId}`, owner.headers)).json();
    expect(copy.json().sha256).toBe(original.sha256);
    expect(original.previewable).toBe(true);
    const preview = await get(`/api/v1/files/${fileId}/preview`, owner.headers);
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-disposition"]).toMatch(/^inline/);
    const zipId = await upload(folderId, "bundle.zip", "PK...", "application/zip");
    expect((await get(`/api/v1/files/${zipId}/preview`, owner.headers)).statusCode).toBe(415);
  });

  it("logs and reports access (#299)", async () => {
    await get(`/api/v1/files/${fileId}/download`, owner.headers);
    const report = (await get(`/api/v1/projects/${projectId}/files/access-report`, owner.headers)).json();
    expect(report.totals.downloads).toBeGreaterThanOrEqual(1);
    expect(report.totals.views).toBeGreaterThanOrEqual(1);
    const row = report.byFile.find((f: { fileId: string }) => f.fileId === fileId);
    expect(row).toMatchObject({ name: "report.txt" });
    expect(row.downloads).toBeGreaterThanOrEqual(1);
    expect(report.byUser[0].name).toBeTruthy();
    const perFile = (await get(`/api/v1/files/${fileId}/access-log`, owner.headers)).json();
    expect(perFile.items.some((i: { action: string }) => i.action === "copy")).toBe(true);
  });

  it("REGRESSION: refuses to delete a file the drawings pipeline owns, and hides it from the list by default", { timeout: 60_000 }, async () => {
    const pdf = Buffer.from("%PDF-1.4\nnot really\n%%EOF");
    const set = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/drawing-sets`,
      payload: multipart([{ buffer: pdf, filename: "set.pdf", contentType: "application/pdf" }], { name: "Set" }),
      headers: mp(owner.headers),
    });
    expect(set.statusCode).toBe(201);
    const sourceFileId = set.json().sourceFileId as string;
    const listed = (await get(`/api/v1/projects/${projectId}/files`, owner.headers)).json();
    expect(listed.items.some((f: { id: string }) => f.id === sourceFileId)).toBe(false);
    const withPipeline = (await get(`/api/v1/projects/${projectId}/files?includePipeline=1`, owner.headers)).json();
    expect(withPipeline.items.find((f: { id: string }) => f.id === sourceFileId).pipelineOwned).toBe(true);
    const refused = await del(`/api/v1/files/${sourceFileId}`, owner.headers);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toMatch(/drawing set/);
    expect((await patch(`/api/v1/files/${sourceFileId}`, owner.headers, { folderId })).statusCode).toBe(400);
  });

  it("soft-deletes into a recycle bin admins can read and restore from", async () => {
    const deleted = await del(`/api/v1/files/${fileId}`, owner.headers);
    expect(deleted.statusCode).toBe(200);
    expect((await get(`/api/v1/files/${fileId}`, owner.headers)).statusCode).toBe(404);
    const engineer = await addMember("field_engineer");
    expect((await get(`/api/v1/projects/${projectId}/files?deleted=1`, engineer.headers)).statusCode).toBe(403);
    const bin = (await get(`/api/v1/projects/${projectId}/files?deleted=1`, owner.headers)).json();
    expect(bin.items.some((f: { id: string }) => f.id === fileId)).toBe(true);
    expect((await post(`/api/v1/files/${fileId}/restore`, engineer.headers)).statusCode).toBe(403);
    const restored = await post(`/api/v1/files/${fileId}/restore`, owner.headers);
    expect(restored.statusCode).toBe(200);
    expect(restored.json().deletedAt).toBeNull();
  });

  it("REGRESSION: renaming a folder to an existing sibling name is refused", async () => {
    const a = await mkFolder("Alpha");
    await mkFolder("Beta");
    const res = await patch(`/api/v1/projects/${projectId}/folders/${a}`, owner.headers, { name: "Beta" });
    expect(res.statusCode).toBe(409);
  });

  it("REGRESSION: a folder name containing a SQL LIKE wildcard does not repath its neighbours", async () => {
    // "/A_B" as a LIKE prefix also matches "/AxB": the descendant repath must
    // be a literal prefix test, not `like(path, '<oldPath>/%')`.
    const wild = await mkFolder("A_B");
    const wildChild = await mkFolder("inside", wild);
    const neighbour = await mkFolder("AxB");
    const neighbourChild = await mkFolder("untouched", neighbour);
    const renamed = await patch(`/api/v1/projects/${projectId}/folders/${wild}`, owner.headers, { name: "Renamed" });
    expect(renamed.statusCode).toBe(200);
    const tree = (await get(`/api/v1/projects/${projectId}/folders`, owner.headers)).json();
    const flat = new Map<string, string>();
    const walk = (nodes: Array<{ id: string; path: string; children?: unknown[] }>) => {
      for (const n of nodes) {
        flat.set(n.id, n.path);
        walk((n.children ?? []) as Array<{ id: string; path: string; children?: unknown[] }>);
      }
    };
    walk(tree.items as Array<{ id: string; path: string; children?: unknown[] }>);
    expect(flat.get(wildChild)).toBe("/Renamed/inside");
    expect(flat.get(neighbour)).toBe("/AxB");
    expect(flat.get(neighbourChild)).toBe("/AxB/untouched");
  });

  it("REGRESSION: inline preview cannot execute uploaded script (nosniff + sandboxed CSP)", async () => {
    const htmlId = await upload(folderId, "evil.html", "<script>alert(1)</script>", "text/html");
    const preview = await get(`/api/v1/files/${htmlId}/preview`, owner.headers);
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(preview.headers["content-security-policy"])).toMatch(/sandbox/);
    const download = await get(`/api/v1/files/${htmlId}/download`, owner.headers);
    expect(download.headers["content-disposition"]).toMatch(/^attachment/);
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("e-mail-to-folder ingestion (#300)", () => {
  let folderId: string;

  beforeAll(async () => {
    folderId = await mkFolder("Inbox");
  });

  it("files attachments and the message itself, refusing what it must", async () => {
    const res = await post(`/api/v1/projects/${projectId}/documents/inbound`, owner.headers, {
      messageId: "<m-1@sender>",
      from: "engineer@consultant.example",
      to: `docs+${folderId}@constructos.example`,
      subject: "RE: Pour 3 approval",
      text: "Attached as discussed.",
      attachments: [
        { filename: "pour3.pdf", contentType: "application/pdf", contentBase64: Buffer.from("%PDF-1.4 pour").toString("base64") },
        { filename: "virus.exe", contentType: "application/octet-stream", contentBase64: Buffer.from("MZ").toString("base64") },
      ],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "partial", folderId, attachmentCount: 2 });
    expect(res.json().fileIds).toHaveLength(2);
    expect(res.json().rejected).toHaveLength(1);
    const listed = (await get(`/api/v1/projects/${projectId}/files?folderId=${folderId}`, owner.headers)).json();
    expect(listed.items).toHaveLength(2);
    expect(listed.items.some((f: { name: string }) => f.name === "pour3.pdf")).toBe(true);
    const eml = listed.items.find((f: { contentType: string }) => f.contentType === "message/rfc822");
    expect(eml.name).toMatch(/Pour 3 approval\.eml$/);
    expect(eml.documentType).toBe("email");
    expect(eml.tags).toContain("inbound-email");
    const dup = await post(`/api/v1/projects/${projectId}/documents/inbound`, owner.headers, { messageId: "<m-1@sender>", to: `docs+${folderId}@x`, attachments: [] });
    expect(dup.statusCode).toBe(200);
    expect(dup.json().duplicate).toBe(true);
    const nowhere = await post(`/api/v1/projects/${projectId}/documents/inbound`, owner.headers, { messageId: "<m-2@sender>", to: "docs@x", attachments: [] });
    expect(nowhere.json().status).toBe("rejected");
    expect(nowhere.json().rejectReason).toMatch(/No target folder/);
    expect((await get(`/api/v1/projects/${projectId}/documents/inbound`, owner.headers)).json().total).toBe(2);
  });
});

describe("stale checkouts are swept by the scheduler (#293)", () => {
  it("reminds the holder once", async () => {
    const folderId = await mkFolder("Sweep");
    const fileId = await upload(folderId, "held.txt", "held");
    expect((await post(`/api/v1/files/${fileId}/checkout`, owner.headers)).statusCode).toBe(200);
    await built.app.db.update(files).set({ checkedOutAt: new Date(Date.now() - 8 * 86_400_000).toISOString() }).where(eq(files.id, fileId));
    const first = await built.app.scheduler.runNow("documents.stale-checkouts");
    expect(first.state).toBe("succeeded");
    expect((first.lastResult as { notified: number }).notified).toBe(1);
    expect(((await built.app.scheduler.runNow("documents.stale-checkouts")).lastResult as { notified: number }).notified).toBe(0);
    const told = await built.app.db.select().from(notifications).where(and(eq(notifications.userId, owner.userId), eq(notifications.recordId, fileId)));
    expect(told).toHaveLength(1);
    const health = (await get(`/api/v1/projects/${projectId}/documents/health-inputs`, owner.headers)).json();
    expect(health.metrics.staleCheckouts).toBe(1);
    const stranger = await registerActor(built.app);
    expect((await get(`/api/v1/projects/${projectId}/files`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`/api/v1/files/${fileId}`, stranger.headers)).statusCode).toBe(404);
  });
});
