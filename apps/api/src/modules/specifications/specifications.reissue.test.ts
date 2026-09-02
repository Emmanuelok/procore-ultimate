/**
 * Reissue tracking, atomic registration, SoD reset on edit, withdrawal,
 * full-text search and the hardened upload path (spec #288, #298, #326).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  notifications,
  projects,
  specRevisionNotices,
  specSubmittalRequirements,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";

function buildPdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const fontObjNum = 3 + pages.length * 2;
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);
  pages.forEach((text, i) => {
    const pageNum = 3 + i * 2;
    const contentNum = pageNum + 1;
    objects.push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> >>\nendobj\n`,
    );
    let stream = "BT\n/F1 12 Tf\n72 720 Td\n";
    for (const line of text.split("\n")) {
      stream += `(${line.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj\n0 -16 Td\n`;
    }
    stream += "ET";
    objects.push(`${contentNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  });
  objects.push(`${fontObjNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const xrefStart = pdf.length;
  const n = objects.length + 1;
  pdf += `xref\n0 ${n}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const BOUNDARY = "----vitestreissue";

function multipartBody(fileBuffer: Buffer, filename: string, fields: Record<string, string> = {}, contentType = "application/pdf"): Buffer {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${BOUNDARY}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(`--${BOUNDARY}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${contentType}\r\n\r\n`),
  );
  parts.push(fileBuffer, Buffer.from(`\r\n--${BOUNDARY}--\r\n`));
  return Buffer.concat(parts);
}

const mpHeaders = (headers: Record<string, string>) => ({ ...headers, "content-type": `multipart/form-data; boundary=${BOUNDARY}` });

let built: BuiltApp;
let uploader: TestActor;
let reviewer: TestActor;
let reviewerHeaders: Record<string, string>;
let projectId: string;

const inject = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, headers: Record<string, string>, payload?: unknown) =>
  built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });

const V1 = [
  "SECTION 03 30 00 - CAST-IN-PLACE CONCRETE\nPART 1 - GENERAL\n1.3 ACTION SUBMITTALS\nA. Product Data: For each type of product. Submit three copies.\nB. Shop Drawings: Include placing drawings, prior to fabrication.\nC. Samples: For each exposed finish.",
  "SECTION 09 91 23 - INTERIOR PAINTING\nPART 1 - GENERAL\n1.3 SUBMITTALS\nA. Product Data: For each paint system.",
];
const V2 = [
  "SECTION 03 30 00 - CAST-IN-PLACE CONCRETE\nPART 1 - GENERAL\n1.3 ACTION SUBMITTALS\nA. Product Data: For each type of product. Submit five copies.\nB. Shop Drawings: Include placing and bending drawings, prior to fabrication.\nD. Mock-ups: For each exposed finish, one full-size panel.",
];

beforeAll(async () => {
  built = await buildTestApp();
  uploader = await registerActor(built.app);
  reviewer = await registerActor(built.app);
  await built.app.db.insert(companyMemberships).values({ id: newId("cm"), companyId: uploader.companyId, userId: reviewer.userId, role: "admin" });
  reviewerHeaders = { authorization: `Bearer ${reviewer.accessToken}`, "x-company-id": uploader.companyId };
  projectId = newId("prj");
  await built.app.db.insert(projects).values({ id: projectId, companyId: uploader.companyId, name: "Reissue Tower" });
}, 180_000);

afterAll(async () => {
  await built.close();
});

describe("reissue impact on the register (#288)", () => {
  let concreteId: string;
  let paintingId: string;
  let productDataId: string;
  let shopDrawingsId: string;
  let samplesId: string;
  let submittalId: string;
  let noticeId: string;

  it("uploads the first issue and builds part of the register", { timeout: 120_000 }, async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/spec-books`,
      payload: multipartBody(buildPdf(V1), "spec-v1.pdf", { name: "Spec", issueLabel: "IFC", makeCurrent: "1" }),
      headers: mpHeaders(uploader.headers),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().processing).toBe("ready");
    expect(res.json().rolledBack).toBe(false);
    expect(res.json().reissued).toEqual([]);
    const sections = (await inject("GET", `/api/v1/projects/${projectId}/spec-sections`, uploader.headers)).json().items as Array<{ id: string; code: string }>;
    concreteId = sections.find((s) => s.code === "03 30 00")!.id;
    paintingId = sections.find((s) => s.code === "09 91 23")!.id;
    const reqs = (await inject("GET", `/api/v1/projects/${projectId}/spec-requirements?sectionId=${concreteId}`, uploader.headers)).json().items as Array<{ id: string; paragraphRef: string }>;
    productDataId = reqs.find((r) => r.paragraphRef === "1.3.A")!.id;
    shopDrawingsId = reqs.find((r) => r.paragraphRef === "1.3.B")!.id;
    samplesId = reqs.find((r) => r.paragraphRef === "1.3.C")!.id;
    expect((await inject("POST", `/api/v1/projects/${projectId}/spec-requirements/${productDataId}/confirm`, reviewerHeaders, {})).statusCode).toBe(200);
    expect((await inject("POST", `/api/v1/projects/${projectId}/spec-requirements/${shopDrawingsId}/confirm`, reviewerHeaders, {})).statusCode).toBe(200);
    const registered = await inject("POST", `/api/v1/projects/${projectId}/spec-requirements/${shopDrawingsId}/register`, reviewerHeaders, {});
    expect(registered.statusCode).toBe(201);
    submittalId = registered.json().submittal.id;
  });

  it("applies the reissue: voids a confirmation, supersedes a removed clause, reports the registered submittal", { timeout: 120_000 }, async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/spec-books`,
      payload: multipartBody(buildPdf(V2), "spec-v2.pdf", { name: "Spec", issueLabel: "Rev A", makeCurrent: "1" }),
      headers: mpHeaders(uploader.headers),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.revisionsAdded).toBe(1);
    expect(body.reissued).toHaveLength(1);
    expect(body.reissued[0]).toMatchObject({ sectionCode: "03 30 00", revision: "A", superseded: 1, reconfirm: 1, registeredChanged: 1 });
    noticeId = body.reissued[0].noticeId;
    // the painting section is absent from the new current issue — offered, not withdrawn
    expect(body.absentSections.map((a: { code: string }) => a.code)).toEqual(["09 91 23"]);

    const pd = (await inject("GET", `/api/v1/projects/${projectId}/spec-requirements/${productDataId}`, uploader.headers)).json();
    expect(pd).toMatchObject({ status: "identified", needsReconfirmation: 1, confirmedBy: null });
    expect(pd.reissueNote).toMatch(/amended in revision A/);
    const samples = (await inject("GET", `/api/v1/projects/${projectId}/spec-requirements/${samplesId}`, uploader.headers)).json();
    expect(samples.status).toBe("superseded");
    expect(samples.supersededByRevisionId).toBeTruthy();
    const shop = (await inject("GET", `/api/v1/projects/${projectId}/spec-requirements/${shopDrawingsId}`, uploader.headers)).json();
    expect(shop).toMatchObject({ status: "registered", needsReconfirmation: 1, registeredSubmittalId: submittalId });
    // the new clause D is read as a new requirement
    const reqs = (await inject("GET", `/api/v1/projects/${projectId}/spec-requirements?sectionId=${concreteId}`, uploader.headers)).json().items as Array<{ paragraphRef: string; submittalType: string; status: string }>;
    expect(reqs.find((r) => r.paragraphRef === "1.3.D")).toMatchObject({ submittalType: "mock_up", status: "identified" });
    expect((await inject("GET", `/api/v1/projects/${projectId}/spec-requirements?needsReconfirmation=1`, uploader.headers)).json().total).toBe(2);
  });

  it("writes a superseded_by reference against the submittal and a notice that can be acknowledged once", async () => {
    const refs = (await inject("GET", `/api/v1/projects/${projectId}/spec-references?referenceKind=superseded_by`, uploader.headers)).json();
    expect(refs.total).toBe(1);
    expect(refs.items[0]).toMatchObject({ targetType: "submittal", targetId: submittalId, paragraphRef: "1.3.B" });
    expect(refs.items[0].targetLabel).toMatch(/^SUB-/);

    const notices = (await inject("GET", `/api/v1/projects/${projectId}/spec-revision-notices`, uploader.headers)).json();
    expect(notices.total).toBe(1);
    expect(notices.unacknowledged).toBe(1);
    expect(notices.items[0]).toMatchObject({ id: noticeId, sectionCode: "03 30 00", revision: "A", requirementsSuperseded: 1, requirementsToReconfirm: 1, requirementsNew: 1 });
    expect(notices.items[0].submittalsAffected).toHaveLength(1);
    expect(notices.items[0].notifiedUserIds).toContain(reviewer.userId);
    const told = await built.app.db.select().from(notifications).where(and(eq(notifications.userId, reviewer.userId), eq(notifications.recordId, noticeId)));
    expect(told).toHaveLength(1);
    expect(told[0]!.title).toMatch(/03 30 00 reissued/);

    const ack = await inject("POST", `/api/v1/projects/${projectId}/spec-revision-notices/${noticeId}/acknowledge`, reviewerHeaders, { note: "Register checked" });
    expect(ack.statusCode).toBe(200);
    expect(ack.json().acknowledgedBy).toBe(reviewer.userId);
    expect((await inject("POST", `/api/v1/projects/${projectId}/spec-revision-notices/${noticeId}/acknowledge`, reviewerHeaders, {})).statusCode).toBe(409);
    expect((await inject("GET", `/api/v1/projects/${projectId}/spec-revision-notices?acknowledged=0`, uploader.headers)).json().total).toBe(0);
  });

  it("re-confirmation runs the SoD chain again and clears the flag", async () => {
    expect((await inject("POST", `/api/v1/projects/${projectId}/spec-requirements/${productDataId}/confirm`, uploader.headers, {})).statusCode).toBe(403);
    const ok = await inject("POST", `/api/v1/projects/${projectId}/spec-requirements/${productDataId}/confirm`, reviewerHeaders, {});
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "confirmed", needsReconfirmation: 0 });
  });

  it("withdraws an absent section with a reason, drops it from coverage, and can reinstate it", async () => {
    const absent = (await inject("GET", `/api/v1/projects/${projectId}/spec-books/${(await currentBookId())}/absent-sections`, uploader.headers)).json();
    expect(absent.items.map((a: { sectionId: string }) => a.sectionId)).toEqual([paintingId]);
    const wd = await inject("POST", `/api/v1/projects/${projectId}/spec-sections/${paintingId}/withdraw`, uploader.headers, { reason: "Painting deleted from scope in Rev A" });
    expect(wd.statusCode).toBe(200);
    expect(wd.json()).toMatchObject({ status: "withdrawn", withdrawnBy: uploader.userId, openRequirements: 1 });
    const coverage = (await inject("GET", `/api/v1/projects/${projectId}/spec-coverage`, uploader.headers)).json();
    expect(coverage.sectionsWithoutConfirmedRequirements.some((s: { code: string }) => s.code === "09 91 23")).toBe(false);
    expect((await inject("GET", `/api/v1/projects/${projectId}/spec-books/${await currentBookId()}/absent-sections`, uploader.headers)).json().total).toBe(0);
    expect((await inject("POST", `/api/v1/projects/${projectId}/spec-sections/${paintingId}/withdraw`, uploader.headers, { reason: "again" })).statusCode).toBe(409);
    const back = await inject("POST", `/api/v1/projects/${projectId}/spec-sections/${paintingId}/reinstate`, uploader.headers, {});
    expect(back.json()).toMatchObject({ status: "current", withdrawnAt: null });
  });

  it("the reminder job nags once about a notice left unacknowledged", async () => {
    // a fresh, unacknowledged notice: reissue the painting section by hand
    const rev = await inject("POST", `/api/v1/projects/${projectId}/spec-sections/${paintingId}/revisions`, uploader.headers, {
      bookId: await currentBookId(),
      text: "SECTION 09 91 23 - INTERIOR PAINTING\nPART 1 - GENERAL\n1.3 SUBMITTALS\nA. Product Data: For each paint system, including VOC data.",
    });
    expect(rev.statusCode).toBe(201);
    expect(rev.json().impact).toMatchObject({ flagged: 1 });
    const [n] = await built.app.db.select().from(specRevisionNotices).where(eq(specRevisionNotices.sectionId, paintingId));
    expect(n).toBeTruthy();
    await built.app.db.update(specRevisionNotices).set({ createdAt: new Date(Date.now() - 8 * 86_400_000).toISOString() }).where(eq(specRevisionNotices.id, n!.id));
    const first = await built.app.scheduler.runNow("specifications.reissue-reminders");
    expect(first.state).toBe("succeeded");
    expect((first.lastResult as { reminded: number }).reminded).toBe(1);
    expect(((await built.app.scheduler.runNow("specifications.reissue-reminders")).lastResult as { reminded: number }).reminded).toBe(0);
  });

  async function currentBookId(): Promise<string> {
    const books = (await inject("GET", `/api/v1/projects/${projectId}/spec-books`, uploader.headers)).json().items as Array<{ id: string; isCurrent: number }>;
    return books.find((b) => b.isCurrent === 1)!.id;
  }
});

describe("register integrity", () => {
  let sectionId: string;
  let bookId: string;

  beforeAll(async () => {
    const books = (await inject("GET", `/api/v1/projects/${projectId}/spec-books`, uploader.headers)).json().items as Array<{ id: string; isCurrent: number }>;
    bookId = books.find((b) => b.isCurrent === 1)!.id;
    const created = await inject("POST", `/api/v1/projects/${projectId}/spec-sections`, uploader.headers, {
      code: "07 92 00",
      title: "JOINT SEALANTS",
      bookId,
      text: "PART 1 - GENERAL\n1.3 SUBMITTALS\nA. Product Data: For each joint sealant product.\nB. Samples: For each colour.",
    });
    sectionId = created.json().id;
    await inject("POST", `/api/v1/projects/${projectId}/spec-sections/${sectionId}/extract-requirements`, uploader.headers, {});
  });

  it("REGRESSION: two concurrent registrations of one confirmed requirement create exactly one submittal", async () => {
    const reqs = (await inject("GET", `/api/v1/projects/${projectId}/spec-requirements?sectionId=${sectionId}`, uploader.headers)).json().items as Array<{ id: string; paragraphRef: string }>;
    const target = reqs.find((r) => r.paragraphRef === "1.3.A")!.id;
    expect((await inject("POST", `/api/v1/projects/${projectId}/spec-requirements/${target}/confirm`, reviewerHeaders, {})).statusCode).toBe(200);
    const [a, b] = await Promise.all([
      inject("POST", `/api/v1/projects/${projectId}/spec-requirements/${target}/register`, reviewerHeaders, {}),
      inject("POST", `/api/v1/projects/${projectId}/spec-requirements/${target}/register`, reviewerHeaders, {}),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const [row] = await built.app.db.select().from(specSubmittalRequirements).where(eq(specSubmittalRequirements.id, target));
    const winner = a.statusCode === 201 ? a : b;
    expect(row!.registeredSubmittalId).toBe(winner.json().submittal.id);
  });

  it("REGRESSION: editing a confirmed requirement's content resets its confirmation; a schedule edit does not", async () => {
    const reqs = (await inject("GET", `/api/v1/projects/${projectId}/spec-requirements?sectionId=${sectionId}`, uploader.headers)).json().items as Array<{ id: string; paragraphRef: string }>;
    const target = reqs.find((r) => r.paragraphRef === "1.3.B")!.id;
    expect((await inject("POST", `/api/v1/projects/${projectId}/spec-requirements/${target}/confirm`, reviewerHeaders, {})).statusCode).toBe(200);
    const schedule = await inject("PATCH", `/api/v1/projects/${projectId}/spec-requirements/${target}`, uploader.headers, { leadTimeDays: 21 });
    expect(schedule.statusCode).toBe(200);
    expect(schedule.json()).toMatchObject({ status: "confirmed", confirmationReset: false, leadTimeDays: 21 });
    const rewrite = await inject("PATCH", `/api/v1/projects/${projectId}/spec-requirements/${target}`, uploader.headers, { title: "Shop drawings for structural steel", submittalType: "shop_drawing" });
    expect(rewrite.statusCode).toBe(200);
    expect(rewrite.json()).toMatchObject({ status: "identified", confirmedBy: null, confirmationReset: true, needsReconfirmation: 1 });
    expect((await inject("POST", `/api/v1/projects/${projectId}/spec-requirements/${target}/register`, reviewerHeaders, {})).statusCode).toBe(400);
    const badRef = await inject("PATCH", `/api/v1/projects/${projectId}/spec-requirements/${target}`, uploader.headers, { commitmentId: "cmt_nope" });
    expect(badRef.statusCode).toBe(404);
  });

  it("REGRESSION: a confidence floor filters in the query, so page and total agree", async () => {
    const all = (await inject("GET", `/api/v1/projects/${projectId}/spec-requirements?minConfidence=0`, uploader.headers)).json();
    const strict = (await inject("GET", `/api/v1/projects/${projectId}/spec-requirements?minConfidence=0.999&pageSize=1`, uploader.headers)).json();
    expect(all.total).toBeGreaterThan(1);
    expect(strict.total).toBe(0);
    expect(strict.items).toEqual([]);
    const some = (await inject("GET", `/api/v1/projects/${projectId}/spec-requirements?minConfidence=0.6&pageSize=1`, uploader.headers)).json();
    expect(some.items.length).toBe(1);
    expect(some.total).toBeGreaterThanOrEqual(1);
    expect(some.total).toBeLessThanOrEqual(all.total);
  });

  it("REGRESSION: a book's status cannot be set to current by PATCH", async () => {
    const res = await inject("PATCH", `/api/v1/projects/${projectId}/spec-books/${bookId}`, uploader.headers, { status: "current" });
    expect(res.statusCode).toBe(400);
    expect((await inject("PATCH", `/api/v1/projects/${projectId}/spec-books/${bookId}`, uploader.headers, { description: "fine" })).statusCode).toBe(200);
  });

  it("REGRESSION: a failed split leaves nothing behind", { timeout: 120_000 }, async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/spec-books`,
      payload: multipartBody(buildPdf(["DIVISION 26 - ELECTRICAL\nno section headings anywhere on this page"]), "no-headings.pdf", { name: "Unsplittable" }),
      headers: mpHeaders(uploader.headers),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ processing: "failed", rolledBack: true, divisionsCreated: 0, sectionCount: 0 });
    const detail = (await inject("GET", `/api/v1/projects/${projectId}/spec-books/${res.json().id}`, uploader.headers)).json();
    expect(detail.divisions).toEqual([]);
    expect(detail.sections).toEqual([]);
  });

  it("refuses a non-PDF upload before storing anything", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/spec-books`,
      payload: multipartBody(Buffer.from("x"), "spec.docx", { name: "Word" }, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
      headers: mpHeaders(uploader.headers),
    });
    expect(res.statusCode).toBe(400);
  });

  it("REGRESSION: serves a book with a non-Latin-1 filename, with ranges", { timeout: 120_000 }, async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/spec-books`,
      payload: multipartBody(buildPdf(["SECTION 22 11 16 - DOMESTIC WATER PIPING\nPART 1 - GENERAL\n1.3 SUBMITTALS\nA. Product Data: For each pipe and fitting."]), "仕様書.pdf", { name: "Japanese", extractRequirements: "0" }),
      headers: mpHeaders(uploader.headers),
    });
    expect(res.statusCode).toBe(201);
    const pdf = await inject("GET", `/api/v1/projects/${projectId}/spec-books/${res.json().id}/pdf`, uploader.headers);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-disposition"]).toContain("filename*=UTF-8''%E4%BB%95");
    expect(pdf.headers["accept-ranges"]).toBe("bytes");
    const ranged = await built.app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/spec-books/${res.json().id}/pdf`, headers: { ...uploader.headers, range: "bytes=0-3" } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.rawPayload.toString()).toBe("%PDF");
  });

  it("searches the text in force and reports health inputs", async () => {
    const hits = (await inject("GET", `/api/v1/projects/${projectId}/spec-search?q=bending+drawings`, uploader.headers)).json();
    expect(hits.total).toBe(1);
    expect(hits.items[0].code).toBe("03 30 00");
    expect(hits.items[0].snippet).toContain("[[");
    expect((await inject("GET", `/api/v1/projects/${projectId}/spec-search?q=placing+drawings`, uploader.headers)).json().total).toBe(1);
    const health = (await inject("GET", `/api/v1/projects/${projectId}/specifications/health-inputs`, uploader.headers)).json();
    expect(health.metrics.hasCurrentBook).toBe(1);
    expect(health.metrics.needsReconfirmation).toBeGreaterThanOrEqual(1);
    const stranger = await registerActor(built.app);
    expect((await inject("GET", `/api/v1/projects/${projectId}/spec-revision-notices`, stranger.headers)).statusCode).toBe(403);
  });
});
