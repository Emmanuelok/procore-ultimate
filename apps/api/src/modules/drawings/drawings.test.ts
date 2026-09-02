import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  drawingIssueRecipients,
  drawingRevisions,
  drawingSheets,
  fileAccessLog,
  notifications,
  projectMemberships,
  projects,
  rfis,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import {
  detectSheetMeta,
  detectSheetNumber,
  detectSheetTitle,
  disciplineForNumber,
  nextRevisionLabel,
} from "./detectors.js";
import { INLINE_PAGE_LIMIT } from "./pipeline.js";

/* ------------------------------------------------------------------ */
/* Handcrafted minimal PDF fixture (pdfjs parses it fine)              */
/* ------------------------------------------------------------------ */

/**
 * Each page is a list of lines. A line is either a string (drawn from the
 * top-left, like the old fixture) or `{ text, x, y }` with x/y in PDF points
 * on a 612×792 page so a title block can be placed bottom-right.
 */
type Line = string | { text: string; x: number; y: number; size?: number };

function esc(s: string): string {
  return s.replace(/[\\()]/g, (c) => `\\${c}`);
}

function buildPdf(pages: Line[][]): Buffer {
  const objects: string[] = [];
  const fontObjNum = 3 + pages.length * 2;
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);
  pages.forEach((lines, i) => {
    const pageNum = 3 + i * 2;
    const contentNum = pageNum + 1;
    objects.push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> >>\nendobj\n`,
    );
    let stream = "";
    let y = 720;
    for (const line of lines) {
      if (typeof line === "string") {
        stream += `BT\n/F1 12 Tf\n72 ${y} Td\n(${esc(line)}) Tj\nET\n`;
        y -= 16;
      } else {
        stream += `BT\n/F1 ${line.size ?? 12} Tf\n${line.x} ${line.y} Td\n(${esc(line.text)}) Tj\nET\n`;
      }
    }
    objects.push(
      `${contentNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  });
  objects.push(
    `${fontObjNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
  );
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

/** A sheet with its number and title in the bottom-right title block. */
function sheetPage(number: string, title: string, notes: string[] = []): Line[] {
  return [
    ...notes,
    { text: title, x: 430, y: 60, size: 14 },
    { text: number, x: 540, y: 30, size: 16 },
  ];
}

const BOUNDARY = "----vitestboundary";

function multipartBody(
  fileBuffer: Buffer,
  filename: string,
  fields: Record<string, string> = {},
  contentType = "application/pdf",
): Buffer {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${BOUNDARY}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
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

const mpHeaders = (headers: Record<string, string>) => ({
  ...headers,
  "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
});

/* ------------------------------------------------------------------ */
/* Detector unit tests (spec #257, #258, #266)                         */
/* ------------------------------------------------------------------ */

describe("detectors", () => {
  it("maps sheet number prefixes to disciplines", () => {
    expect(disciplineForNumber("A-101")).toBe("architectural");
    expect(disciplineForNumber("S1.02")).toBe("structural");
    expect(disciplineForNumber("M-201")).toBe("mechanical");
    expect(disciplineForNumber("FP-101")).toBe("fire_protection");
    expect(disciplineForNumber("C3.1")).toBe("civil");
    expect(disciplineForNumber("X-9")).toBe("other");
  });

  it("advances revision labels 0 → A → B … Z → AA", () => {
    expect(nextRevisionLabel(null)).toBe("0");
    expect(nextRevisionLabel("0")).toBe("A");
    expect(nextRevisionLabel("Z")).toBe("AA");
    expect(nextRevisionLabel("AZ")).toBe("BA");
  });

  it("prefers the last plausible sheet number in the text stream", () => {
    const m = detectSheetNumber("KEY PLAN\nDETAIL 3/A-501\nFLOOR PLAN LEVEL 2\nSCALE: 1/8\" = 1'-0\"\nA-102");
    expect(m?.value).toBe("A-102");
  });

  it("ignores blacklisted prefixes, scale and date rows", () => {
    expect(detectSheetNumber("PROJECT NO.12345\nSCALE: A-1\nDATE JAN-2024")).toBeNull();
  });

  it("extracts an uppercase title near the number, skipping labels", () => {
    const text = "DRAWN BY: JDW\nCHECKED BY: MB\nALPHA TOWER PHASE II\nFOUNDATION PLAN\nSCALE: 1/4\" = 1'-0\"\nS-101";
    const num = detectSheetNumber(text);
    expect(detectSheetTitle(text, num?.index ?? null, num?.value ?? null)).toBe("FOUNDATION PLAN");
  });

  it("detects full sheet metadata with confidence", () => {
    expect(detectSheetMeta("LEVEL 3 REFLECTED CEILING PLAN\nA-303")).toMatchObject({
      number: "A-303",
      title: "LEVEL 3 REFLECTED CEILING PLAN",
      confident: true,
    });
    expect(detectSheetMeta("just some lowercase scribbles here").number).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Pipeline + endpoints                                                */
/* ------------------------------------------------------------------ */

let built: BuiltApp;
let actor: TestActor;
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
  await built.app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: actor.companyId,
    userId: body.user.id,
    role: "member",
  });
  if (templateKey) {
    await built.app.db.insert(projectMemberships).values({
      id: newId("pm"),
      companyId: actor.companyId,
      projectId,
      userId: body.user.id,
      templateKey,
      overrides: {},
    });
  }
  return {
    userId: body.user.id,
    headers: { authorization: `Bearer ${body.accessToken}`, "x-company-id": actor.companyId },
  };
}

const get = (url: string, headers: Record<string, string>) => built.app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Record<string, string>, payload?: unknown) =>
  built.app.inject({ method: "POST", url, headers, ...(payload !== undefined ? { payload } : {}) });

beforeAll(async () => {
  built = await buildTestApp();
  actor = await registerActor(built.app);
  projectId = newId("prj");
  await built.app.db.insert(projects).values({ id: projectId, companyId: actor.companyId, name: "Tower" });
}, 120_000);

afterAll(async () => {
  await built.close();
});

describe("drawing set pipeline", () => {
  let sheetA101: { id: string; currentRevisionId: string };
  let sheetG001Id: string;
  let placeholderId: string;
  let rev0Id: string;
  let revAId: string;

  it("uploads and processes a 3-page PDF into sheets, placeholders scoped to the set", { timeout: 60_000 }, async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/drawing-sets`,
      payload: multipartBody(
        buildPdf([
          sheetPage("A-101", "FLOOR PLAN LEVEL 1", ["ALPHA TOWER", "SCALE: 1/8\" = 1'-0\""]),
          ["GENERAL NOTES", "G-001"],
          ["just an unlabeled photo reference page"],
        ]),
        "set-one.pdf",
        { name: "IFC Set 1", issuedDate: "2026-01-15", area: "Tower A" },
      ),
      headers: mpHeaders(actor.headers),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.processing).toBe("ready");
    expect(body.deferred).toBe(false);
    expect(body.sheetsCreated).toBe(3);
    expect(body.revisionsAdded).toBe(3);
    expect(body.pageCount).toBe(3);

    const sheets = await get(`/api/v1/projects/${projectId}/sheets`, actor.headers);
    expect(sheets.json().total).toBe(3);
    const items = sheets.json().items;
    const a101 = items.find((s: { number: string }) => s.number === "A-101");
    expect(a101).toMatchObject({ title: "FLOOR PLAN LEVEL 1", discipline: "architectural", needsReview: 0, area: "Tower A" });
    expect(a101.currentRevision.revision).toBe("0");
    sheetA101 = a101;
    rev0Id = a101.currentRevisionId;
    sheetG001Id = items.find((s: { number: string }) => s.number === "G-001").id;
    const unnamed = items.find((s: { number: string }) => s.number.startsWith("UNNAMED-3-"));
    expect(unnamed.needsReview).toBe(1);
    placeholderId = unnamed.id;
  });

  it("stores positioned text and detection provenance on the revision", async () => {
    const [rev] = await built.app.db.select().from(drawingRevisions).where(eq(drawingRevisions.id, rev0Id));
    expect(rev!.hasTextLayer).toBe(1);
    expect((rev!.textItems ?? []).length).toBeGreaterThan(2);
    expect(rev!.detection).toMatchObject({ method: "title_block" });
    expect(rev!.extraction).toMatchObject({ engine: "pdfjs-dist/legacy" });
  });

  it("filters sheets by discipline, search, full text and needsReview", async () => {
    expect((await get(`/api/v1/projects/${projectId}/sheets?discipline=architectural`, actor.headers)).json().total).toBe(1);
    expect((await get(`/api/v1/projects/${projectId}/sheets?search=floor`, actor.headers)).json().total).toBe(1);
    expect((await get(`/api/v1/projects/${projectId}/sheets?text=alpha+tower`, actor.headers)).json().total).toBe(1);
    expect((await get(`/api/v1/projects/${projectId}/sheets?text=nonexistentword`, actor.headers)).json().total).toBe(0);
    expect((await get(`/api/v1/projects/${projectId}/sheets?needsReview=1`, actor.headers)).json().total).toBe(1);
    expect((await get(`/api/v1/projects/${projectId}/sheets?needsReview=0`, actor.headers)).json().total).toBe(2);
  });

  it("re-upload supersedes: same number gets revision A with a stored diff verdict", { timeout: 60_000 }, async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/drawing-sets`,
      payload: multipartBody(
        buildPdf([sheetPage("A-101", "FLOOR PLAN LEVEL 1", ["ALPHA TOWER", "SCALE: 1/8\" = 1'-0\""])]),
        "set-two.pdf",
        { name: "IFC Set 2", issuedDate: "2026-02-01" },
      ),
      headers: mpHeaders(actor.headers),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().sheetsCreated).toBe(0);
    expect(res.json().revisionsAdded).toBe(1);

    const detail = await get(`/api/v1/sheets/${sheetA101.id}`, actor.headers);
    const body = detail.json();
    expect(body.revisions).toHaveLength(2);
    const current = body.revisions.find((r: { id: string }) => r.id === body.currentRevisionId);
    expect(current.revision).toBe("A");
    expect(current.supersedesRevisionId).toBe(rev0Id);
    expect(current.changeVerdict).toBe("unchanged");
    expect(current.extractedText).toBeUndefined();
    expect(current.textItems).toBeUndefined();
    expect(body.revisions.find((r: { revision: string }) => r.revision === "0").isSuperseded).toBe(1);
    expect(body.access.canEdit).toBe(true);
    revAId = current.id;
  });

  it("REGRESSION: an unreadable page in a second set never merges with the first set's placeholder", { timeout: 60_000 }, async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/drawing-sets`,
      payload: multipartBody(
        buildPdf([sheetPage("E-101", "POWER PLAN"), ["another unreadable page"], ["and one more"]]),
        "set-three.pdf",
        { name: "Set with scans" },
      ),
      headers: mpHeaders(actor.headers),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().sheetsCreated).toBe(3);
    const first = await built.app.db.select().from(drawingRevisions).where(eq(drawingRevisions.sheetId, placeholderId));
    expect(first).toHaveLength(1);
    expect(first[0]!.isSuperseded).toBe(0);
    const review = await get(`/api/v1/projects/${projectId}/sheets?needsReview=1`, actor.headers);
    expect(review.json().total).toBe(3);
  });

  it("REGRESSION: a duplicate number inside one set becomes a review sheet, not a self-supersession", { timeout: 60_000 }, async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/drawing-sets`,
      payload: multipartBody(
        buildPdf([sheetPage("A-200", "ROOF PLAN"), sheetPage("A-200", "ROOF PLAN RESCAN")]),
        "set-dup.pdf",
        { name: "Set with duplicate" },
      ),
      headers: mpHeaders(actor.headers),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().sheetsCreated).toBe(2);
    const sheets = await built.app.db
      .select()
      .from(drawingSheets)
      .where(and(eq(drawingSheets.projectId, projectId), eq(drawingSheets.number, "A-200")));
    expect(sheets).toHaveLength(1);
    const revs = await built.app.db.select().from(drawingRevisions).where(eq(drawingRevisions.sheetId, sheets[0]!.id));
    expect(revs).toHaveLength(1);
    const queue = await get(`/api/v1/projects/${projectId}/sheets/review`, actor.headers);
    const dup = queue.json().items.find((s: { number: string }) => /^A-200-DUP2-/.test(s.number));
    expect(dup).toBeTruthy();
    expect(dup.duplicateOf.number).toBe("A-200");
    expect(dup.reason).toMatch(/already registered as A-200/);
  });

  it("resolves the review queue: confirm, merge into, discard", async () => {
    const queue = (await get(`/api/v1/projects/${projectId}/sheets/review`, actor.headers)).json().items as Array<{ id: string; number: string; reason: string }>;
    expect(queue.length).toBeGreaterThanOrEqual(4);
    expect(queue.every((q) => typeof q.reason === "string" && q.reason.length > 0)).toBe(true);

    // confirm needs a real number
    const bad = await post(`/api/v1/projects/${projectId}/sheets/${placeholderId}/review`, actor.headers, { action: "confirm" });
    expect(bad.statusCode).toBe(400);
    const confirmed = await post(`/api/v1/projects/${projectId}/sheets/${placeholderId}/review`, actor.headers, {
      action: "confirm",
      number: "a-900",
      title: "PHOTO REFERENCE",
      discipline: "architectural",
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ number: "A-900", needsReview: 0, action: "confirm" });
    // confirming as an existing number is refused with a merge hint
    const other = queue.find((q) => q.id !== placeholderId && q.number.startsWith("UNNAMED"))!;
    const clash = await post(`/api/v1/projects/${projectId}/sheets/${other.id}/review`, actor.headers, { action: "confirm", number: "A-900", title: "X" });
    expect(clash.statusCode).toBe(409);

    // merge the duplicate page into A-200 as its next revision
    const dup = queue.find((q) => /^A-200-DUP2-/.test(q.number))!;
    const [a200] = await built.app.db.select().from(drawingSheets).where(and(eq(drawingSheets.projectId, projectId), eq(drawingSheets.number, "A-200")));
    const merged = await post(`/api/v1/projects/${projectId}/sheets/${dup.id}/review`, actor.headers, { action: "merge_into", targetSheetId: a200!.id });
    expect(merged.statusCode).toBe(200);
    expect(merged.json().mergedRevisions).toBe(1);
    const a200Detail = (await get(`/api/v1/sheets/${a200!.id}`, actor.headers)).json();
    expect(a200Detail.revisions).toHaveLength(2);
    expect(a200Detail.revisions.find((r: { id: string }) => r.id === a200Detail.currentRevisionId).revision).toBe("A");
    expect((await get(`/api/v1/sheets/${dup.id}`, actor.headers)).statusCode).toBe(404);

    // discard a scan
    const discarded = await post(`/api/v1/projects/${projectId}/sheets/${other.id}/review`, actor.headers, { action: "discard" });
    expect(discarded.statusCode).toBe(200);
    expect((await get(`/api/v1/sheets/${other.id}`, actor.headers)).statusCode).toBe(404);
  });

  it("marks a garbage PDF as failed without a 500 and refuses a non-PDF outright", { timeout: 60_000 }, async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/drawing-sets`,
      payload: multipartBody(Buffer.from("this is definitely not a pdf"), "junk.pdf", { name: "Junk" }),
      headers: mpHeaders(actor.headers),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().processing).toBe("failed");
    expect(res.json().error).toBeTruthy();

    const png = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/drawing-sets`,
      payload: multipartBody(Buffer.from("png bytes"), "set.png", { name: "PNG" }, "image/png"),
      headers: mpHeaders(actor.headers),
    });
    expect(png.statusCode).toBe(400);
    expect(png.json().message).toMatch(/Expected a PDF/);
  });

  it("defers a large set to the scheduler job and resumes it there", { timeout: 120_000 }, async () => {
    const pages: Line[][] = [];
    for (let i = 1; i <= INLINE_PAGE_LIMIT + 5; i++) pages.push(sheetPage(`M-${100 + i}`, `MECHANICAL PLAN ${i}`));
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/drawing-sets`,
      payload: multipartBody(buildPdf(pages), "big-set.pdf", { name: "Big set" }),
      headers: mpHeaders(actor.headers),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().processing).toBe("pending");
    expect(res.json().deferred).toBe(true);
    const status = await built.app.scheduler.runNow("drawings.process-sets");
    expect(status.state).toBe("succeeded");
    const set = (await get(`/api/v1/projects/${projectId}/drawing-sets?processing=ready`, actor.headers)).json().items.find(
      (s: { name: string }) => s.name === "Big set",
    );
    expect(set).toBeTruthy();
    expect(set.sheetCount).toBe(INLINE_PAGE_LIMIT + 5);
    expect(set.processedPages).toBe(INLINE_PAGE_LIMIT + 5);
  });

  it("lists drawing sets with status and the register summary", async () => {
    const res = await get(`/api/v1/projects/${projectId}/drawing-sets`, actor.headers);
    expect(res.json().items.filter((s: { processing: string }) => s.processing === "failed")).toHaveLength(1);
    const summary = (await get(`/api/v1/projects/${projectId}/drawings/summary`, actor.headers)).json();
    expect(summary.sheets).toBeGreaterThan(40);
    expect(summary.sets.failed).toBe(1);
    const health = (await get(`/api/v1/projects/${projectId}/drawings/health-inputs`, actor.headers)).json();
    expect(health.metrics.setsFailed).toBe(1);
    expect(health.metrics.sheetsNeedingReview).toBeGreaterThanOrEqual(1);
  });

  it("exports the drawing log as JSON and CSV", async () => {
    const res = await get(`/api/v1/projects/${projectId}/sheets/log`, actor.headers);
    expect(res.statusCode).toBe(200);
    const a101 = res.json().items.find((r: { number: string }) => r.number === "A-101");
    expect(a101).toMatchObject({ currentRevision: "A", revisionCount: 2, issuedDate: "2026-02-01", changeVerdict: "unchanged" });
    expect(a101.history).toHaveLength(2);
    const csv = await get(`/api/v1/projects/${projectId}/sheets/log?format=csv`, actor.headers);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\r\n")[0]).toContain("Number,Title");
    expect(csv.body).toContain("A-101,FLOOR PLAN LEVEL 1");
  });

  it("serves the revision PDF with ranges, logs the view, and hides it from strangers", async () => {
    const full = await get(`/api/v1/projects/${projectId}/revisions/${revAId}/pdf`, actor.headers);
    expect(full.statusCode).toBe(200);
    expect(full.headers["content-type"]).toBe("application/pdf");
    expect(full.headers["accept-ranges"]).toBe("bytes");
    expect(full.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    const size = Number(full.headers["content-length"]);
    const ranged = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/revisions/${revAId}/pdf`,
      headers: { ...actor.headers, range: "bytes=0-9" },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers["content-range"]).toBe(`bytes 0-9/${size}`);
    expect(ranged.rawPayload.length).toBe(10);
    const bad = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/revisions/${revAId}/pdf`,
      headers: { ...actor.headers, range: "bytes=99999999-" },
    });
    expect(bad.statusCode).toBe(416);
    const views = await built.app.db
      .select()
      .from(fileAccessLog)
      .where(and(eq(fileAccessLog.projectId, projectId), eq(fileAccessLog.context, "drawing_viewer")));
    expect(views).toHaveLength(1); // the ranged follow-ups do not double-log

    const stranger = await registerActor(built.app);
    expect((await get(`/api/v1/projects/${projectId}/revisions/${revAId}/pdf`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`/api/v1/sheets/${sheetA101.id}`, stranger.headers)).statusCode).toBe(404);
    expect((await get(`/api/v1/drawing-files/whatever/pdf`, actor.headers)).statusCode).toBe(404);
  });

  describe("authorisation on id-scoped routes", () => {
    let reader: Member;
    let outsider: Member;

    beforeAll(async () => {
      reader = await addMember("subcontractor"); // drawings: read
      outsider = await addMember(null); // company member, not on the project
    });

    it("a project non-member cannot see or touch a sheet by id", async () => {
      expect((await get(`/api/v1/sheets/${sheetA101.id}`, outsider.headers)).statusCode).toBe(404);
      const patch = await built.app.inject({ method: "PATCH", url: `/api/v1/sheets/${sheetA101.id}`, payload: { title: "X" }, headers: outsider.headers });
      expect(patch.statusCode).toBe(404);
      expect((await get(`/api/v1/revisions/${revAId}/markups`, outsider.headers)).statusCode).toBe(404);
    });

    it("a read-level member can read and keep a personal layer but cannot mutate the register", async () => {
      expect((await get(`/api/v1/sheets/${sheetA101.id}`, reader.headers)).statusCode).toBe(200);
      expect((await get(`/api/v1/sheets/${sheetA101.id}`, reader.headers)).json().access.canEdit).toBe(false);
      const personal = await built.app.inject({
        method: "PUT",
        url: `/api/v1/revisions/${revAId}/markups`,
        payload: { layer: "personal", shapes: [{ kind: "text", at: { x: 0.1, y: 0.1 }, text: "mine", color: "#000", fontSize: 12 }] },
        headers: reader.headers,
      });
      expect(personal.statusCode).toBe(200);
      const publish = await post(`/api/v1/markups/${personal.json().id}/publish`, reader.headers);
      expect(publish.statusCode).toBe(403);
      const patch = await built.app.inject({ method: "PATCH", url: `/api/v1/sheets/${sheetA101.id}`, payload: { title: "Renamed" }, headers: reader.headers });
      expect(patch.statusCode).toBe(403);
      const calib = await built.app.inject({
        method: "PUT",
        url: `/api/v1/revisions/${revAId}/calibration`,
        payload: { from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, realDistance: 10, unit: "m" },
        headers: reader.headers,
      });
      expect(calib.statusCode).toBe(403);
      const pin = await post(`/api/v1/sheets/${sheetA101.id}/pins`, reader.headers, { recordType: "rfi", recordId: "x", x: 0.5, y: 0.5 });
      expect(pin.statusCode).toBe(403);
    });

    it("renumbering a confirmed sheet is an admin act; a title edit does not clear review silently", async () => {
      const standard = await addMember("field_engineer");
      const renumber = await built.app.inject({ method: "PATCH", url: `/api/v1/sheets/${sheetA101.id}`, payload: { number: "A-102" }, headers: standard.headers });
      expect(renumber.statusCode).toBe(403);
      const retitle = await built.app.inject({ method: "PATCH", url: `/api/v1/sheets/${sheetA101.id}`, payload: { title: "FLOOR PLAN LEVEL 1" }, headers: standard.headers });
      expect(retitle.statusCode).toBe(200);
      const [placeholder] = await built.app.db
        .select()
        .from(drawingSheets)
        .where(and(eq(drawingSheets.projectId, projectId), eq(drawingSheets.needsReview, 1)))
        .limit(1);
      const touched = await built.app.inject({ method: "PATCH", url: `/api/v1/sheets/${placeholder!.id}`, payload: { title: "Still unsure" }, headers: actor.headers });
      expect(touched.json().needsReview).toBe(1);
    });
  });

  describe("segregation by discipline, area and sheet (#265, #282)", () => {
    let listed: Member;
    let unlisted: Member;
    let sheetE101Id: string;
    let ruleId: string;

    beforeAll(async () => {
      listed = await addMember("subcontractor");
      unlisted = await addMember("subcontractor");
      const [e101] = await built.app.db.select().from(drawingSheets).where(and(eq(drawingSheets.projectId, projectId), eq(drawingSheets.number, "E-101")));
      sheetE101Id = e101!.id;
    });

    it("validates and creates a rule", async () => {
      const bad = await post(`/api/v1/projects/${projectId}/drawing-permissions`, actor.headers, { scope: "discipline", scopeValue: "plumbing-ish", subjectType: "user", subjectId: listed.userId });
      expect(bad.statusCode).toBe(400);
      const res = await post(`/api/v1/projects/${projectId}/drawing-permissions`, actor.headers, { scope: "discipline", scopeValue: "electrical", subjectType: "user", subjectId: listed.userId, level: "standard" });
      expect(res.statusCode).toBe(201);
      ruleId = res.json().id;
      expect((await post(`/api/v1/projects/${projectId}/drawing-permissions`, actor.headers, { scope: "discipline", scopeValue: "electrical", subjectType: "user", subjectId: listed.userId })).statusCode).toBe(409);
      expect((await post(`/api/v1/projects/${projectId}/drawing-permissions`, listed.headers, { scope: "discipline", scopeValue: "electrical", subjectType: "user", subjectId: listed.userId })).statusCode).toBe(403);
    });

    it("hides the restricted discipline from everyone not listed, in lists and by id", async () => {
      const mine = await get(`/api/v1/projects/${projectId}/sheets?discipline=electrical`, listed.headers);
      expect(mine.json().total).toBe(1);
      expect(mine.json().items[0].canEdit).toBe(true); // the rule raised a reader to standard
      const theirs = await get(`/api/v1/projects/${projectId}/sheets?discipline=electrical`, unlisted.headers);
      expect(theirs.json().total).toBe(0);
      expect(theirs.json().access.segregated).toBe(true);
      expect((await get(`/api/v1/sheets/${sheetE101Id}`, unlisted.headers)).statusCode).toBe(404);
      expect((await get(`/api/v1/sheets/${sheetE101Id}`, listed.headers)).statusCode).toBe(200);
      // the unrestricted discipline is untouched
      expect((await get(`/api/v1/sheets/${sheetA101.id}`, unlisted.headers)).statusCode).toBe(200);
      // owners always see everything
      expect((await get(`/api/v1/projects/${projectId}/sheets?discipline=electrical`, actor.headers)).json().total).toBe(1);
    });

    it("a template rule covers everyone on that template; deleting the rule reopens the scope", async () => {
      const tmpl = await post(`/api/v1/projects/${projectId}/drawing-permissions`, actor.headers, { scope: "sheet", scopeValue: sheetG001Id, subjectType: "template", subjectId: "field_engineer" });
      expect(tmpl.statusCode).toBe(201);
      expect((await get(`/api/v1/sheets/${sheetG001Id}`, unlisted.headers)).statusCode).toBe(404);
      const fe = await addMember("field_engineer");
      expect((await get(`/api/v1/sheets/${sheetG001Id}`, fe.headers)).statusCode).toBe(200);
      const list = (await get(`/api/v1/projects/${projectId}/drawing-permissions`, actor.headers)).json();
      expect(list.total).toBe(2);
      expect(list.items.find((r: { id: string }) => r.id === ruleId).subjectName).toContain("Member");
      await built.app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}/drawing-permissions/${tmpl.json().id}`, headers: actor.headers });
      await built.app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}/drawing-permissions/${ruleId}`, headers: actor.headers });
      expect((await get(`/api/v1/sheets/${sheetE101Id}`, unlisted.headers)).statusCode).toBe(200);
      expect((await get(`/api/v1/sheets/${sheetG001Id}`, unlisted.headers)).statusCode).toBe(200);
    });
  });

  describe("markups, prior layers, carry-forward and diff", () => {
    let markupId: string;

    it("saves a personal markup layer, validates shapes and publishes", async () => {
      const shapes = [
        { kind: "rect", from: { x: 0.1, y: 0.1 }, to: { x: 0.3, y: 0.2 }, color: "#f00", width: 2 },
        { kind: "text", at: { x: 0.5, y: 0.5 }, text: "check this beam", color: "#00f", fontSize: 14 },
      ];
      const put = await built.app.inject({ method: "PUT", url: `/api/v1/revisions/${rev0Id}/markups`, payload: { layer: "personal", shapes }, headers: actor.headers });
      expect(put.statusCode).toBe(200);
      markupId = put.json().id;
      const put2 = await built.app.inject({ method: "PUT", url: `/api/v1/revisions/${rev0Id}/markups`, payload: { layer: "personal", shapes: shapes.slice(0, 1) }, headers: actor.headers });
      expect(put2.json().id).toBe(markupId);
      const bad = await built.app.inject({ method: "PUT", url: `/api/v1/revisions/${rev0Id}/markups`, payload: { layer: "personal", shapes: [{ kind: "hexagon", color: "red" }] }, headers: actor.headers });
      expect(bad.statusCode).toBe(400);
      const pub = await post(`/api/v1/markups/${markupId}/publish`, actor.headers);
      expect(pub.statusCode).toBe(200);
      expect(pub.json().layer).toBe("published");
    });

    it("REGRESSION: published markups on the superseded revision are visible from the current one", async () => {
      const plain = await get(`/api/v1/revisions/${revAId}/markups`, actor.headers);
      expect(plain.json().items).toHaveLength(0);
      expect(plain.json().prior).toHaveLength(0);
      const withPrior = await get(`/api/v1/revisions/${revAId}/markups?includePrior=1`, actor.headers);
      expect(withPrior.json().prior).toHaveLength(1);
      expect(withPrior.json().prior[0]).toMatchObject({ id: markupId, prior: true, revisionLabel: "0" });
    });

    it("carries the published layer forward once, flagging shapes in changed regions", async () => {
      const carried = await post(`/api/v1/revisions/${revAId}/markups/carry-forward`, actor.headers, {});
      expect(carried.statusCode).toBe(200);
      expect(carried.json()).toMatchObject({ layer: "published", carriedFromRevisionId: rev0Id, reviewFlags: [] });
      expect(carried.json().shapes).toHaveLength(1);
      expect(carried.json().basis).toMatch(/No changed regions/);
      expect((await post(`/api/v1/revisions/${revAId}/markups/carry-forward`, actor.headers, {})).statusCode).toBe(409);
      expect((await post(`/api/v1/revisions/${rev0Id}/markups/carry-forward`, actor.headers, {})).statusCode).toBe(400);
      const now = await get(`/api/v1/revisions/${revAId}/markups`, actor.headers);
      expect(now.json().items).toHaveLength(1);
    });

    it("reports the revision diff against what it superseded", async () => {
      const diff = await get(`/api/v1/revisions/${revAId}/diff`, actor.headers);
      expect(diff.statusCode).toBe(200);
      expect(diff.json()).toMatchObject({ verdict: "unchanged", stored: true, againstRevisionId: rev0Id });
      expect(diff.json().against.revision).toBe("0");
      const first = await get(`/api/v1/revisions/${rev0Id}/diff`, actor.headers);
      expect(first.json().againstRevisionId).toBeNull();
      expect(first.json().basis).toMatch(/first revision/);
    });

    it("stores calibration and rejects invalid payloads", async () => {
      const ok = await built.app.inject({
        method: "PUT",
        url: `/api/v1/revisions/${revAId}/calibration`,
        payload: { from: { x: 0.1, y: 0.1 }, to: { x: 0.9, y: 0.1 }, realDistance: 30, unit: "ft" },
        headers: actor.headers,
      });
      expect(ok.statusCode).toBe(200);
      const bad = await built.app.inject({ method: "PUT", url: `/api/v1/revisions/${revAId}/calibration`, payload: { from: { x: 0 }, realDistance: -5 }, headers: actor.headers });
      expect(bad.statusCode).toBe(400);
    });
  });

  describe("hyperlinks: automatic callouts and review (#263)", () => {
    let calloutSheetId: string;
    let calloutRevId: string;

    it("links callouts to sheets in the set and keeps unknown targets as unresolved", { timeout: 60_000 }, async () => {
      const res = await built.app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/drawing-sets`,
        payload: multipartBody(
          buildPdf([
            sheetPage("S-101", "FOUNDATION PLAN", [
              { text: "SEE DETAIL 3/S-501", x: 100, y: 600 },
              { text: "REFER TO SHEET S-999", x: 100, y: 560 },
            ]),
            sheetPage("S-501", "FOUNDATION DETAILS"),
          ]),
          "set-struct.pdf",
          { name: "Structural" },
        ),
        headers: mpHeaders(actor.headers),
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().autoLinksCreated).toBe(1);
      expect(res.json().unresolvedCallouts).toBe(1);
      const sheets = (await get(`/api/v1/projects/${projectId}/sheets?search=S-101`, actor.headers)).json().items;
      calloutSheetId = sheets[0].id;
      calloutRevId = sheets[0].currentRevisionId;
      const links = (await get(`/api/v1/revisions/${calloutRevId}/hyperlinks`, actor.headers)).json();
      expect(links.total).toBe(2);
      const active = links.items.find((l: { status: string }) => l.status === "active");
      expect(active).toMatchObject({ source: "auto", targetNumber: "S-501" });
      expect(active.target.number).toBe("S-501");
      expect(active.confidence).toBeGreaterThan(0.5);
      const qa = (await get(`/api/v1/projects/${projectId}/drawing-sets/${res.json().id}/qa`, actor.headers)).json();
      expect(qa.summary.unresolvedCallouts).toBe(1);
      expect(qa.unresolvedCallouts[0].targetNumber).toBe("S-999");
    });

    it("lists unresolved links for review and resolves them when the sheet appears", async () => {
      const review = (await get(`/api/v1/projects/${projectId}/hyperlinks/review`, actor.headers)).json();
      const unresolved = review.items.find((l: { targetNumber: string }) => l.targetNumber === "S-999");
      expect(unresolved).toBeTruthy();
      expect(unresolved.reason).toMatch(/No sheet numbered S-999/);
      // rejecting needs standard; a reader cannot
      const reader = await addMember("subcontractor");
      expect((await post(`/api/v1/hyperlinks/${unresolved.id}/review`, reader.headers, { action: "reject" })).statusCode).toBe(403);
      // a review-queue confirmation that creates S-999 resolves the callout
      const [placeholder] = await built.app.db
        .select()
        .from(drawingSheets)
        .where(and(eq(drawingSheets.projectId, projectId), eq(drawingSheets.needsReview, 1)))
        .limit(1);
      const confirmed = await post(`/api/v1/projects/${projectId}/sheets/${placeholder!.id}/review`, actor.headers, { action: "confirm", number: "S-999", title: "MISC DETAILS", discipline: "structural" });
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json().linksResolved).toBe(1);
      const after = (await get(`/api/v1/revisions/${calloutRevId}/hyperlinks`, actor.headers)).json();
      expect(after.items.every((l: { status: string }) => l.status === "active")).toBe(true);
      // accept marks it confirmed so it leaves the review list; reject removes it from the viewer
      const link = after.items.find((l: { targetNumber: string }) => l.targetNumber === "S-501");
      const accepted = await post(`/api/v1/hyperlinks/${link.id}/review`, actor.headers, { action: "accept" });
      expect(accepted.json().detail.confirmed).toBe(true);
      const rejected = await post(`/api/v1/hyperlinks/${after.items.find((l: { targetNumber: string }) => l.targetNumber === "S-999").id}/review`, actor.headers, { action: "reject" });
      expect(rejected.json().status).toBe("rejected");
      expect((await get(`/api/v1/revisions/${calloutRevId}/hyperlinks`, actor.headers)).json().total).toBe(1);
    });

    it("creates and deletes manual hyperlinks within the project", async () => {
      const create = await post(`/api/v1/revisions/${calloutRevId}/hyperlinks`, actor.headers, { toSheetId: sheetG001Id, x: 0.8, y: 0.9, w: 0.05, h: 0.02, label: "see notes" });
      expect(create.statusCode).toBe(201);
      expect(create.json().confidence).toBeNull();
      const otherProjectId = newId("prj");
      await built.app.db.insert(projects).values({ id: otherProjectId, companyId: actor.companyId, name: "Other" });
      const foreignSheetId = newId("dsht");
      await built.app.db.insert(drawingSheets).values({ id: foreignSheetId, companyId: actor.companyId, projectId: otherProjectId, number: "A-001", title: "FOREIGN" });
      const cross = await post(`/api/v1/revisions/${calloutRevId}/hyperlinks`, actor.headers, { toSheetId: foreignSheetId, x: 0.1, y: 0.1, w: 0.1, h: 0.1 });
      expect(cross.statusCode).toBe(400);
      const del = await built.app.inject({ method: "DELETE", url: `/api/v1/revisions/${calloutRevId}/hyperlinks/${create.json().id}`, headers: actor.headers });
      expect(del.statusCode).toBe(200);
      void calloutSheetId;
    });
  });

  describe("pins are validated against the record they name (#272–#276)", () => {
    let rfiId: string;
    let pinId: string;

    beforeAll(async () => {
      rfiId = newId("rfi");
      await built.app.db.insert(rfis).values({ id: rfiId, companyId: actor.companyId, projectId, number: 12, subject: "Beam clash at grid C", question: "Which beam governs?", createdBy: actor.userId });
    });

    it("refuses an unknown record id and out-of-range coordinates", async () => {
      const ghost = await post(`/api/v1/sheets/${sheetA101.id}/pins`, actor.headers, { recordType: "rfi", recordId: "rfi_doesnotexist", x: 0.4, y: 0.5 });
      expect(ghost.statusCode).toBe(400);
      expect(ghost.json().message).toMatch(/No rfi/);
      expect((await post(`/api/v1/sheets/${sheetA101.id}/pins`, actor.headers, { recordType: "punch", recordId: "pn_1", x: 1.5, y: 0.5 })).statusCode).toBe(400);
    });

    it("places, lists, reverse-looks-up and deletes a pin", async () => {
      const create = await post(`/api/v1/sheets/${sheetA101.id}/pins`, actor.headers, { recordType: "rfi", recordId: rfiId, x: 0.42, y: 0.58 });
      expect(create.statusCode).toBe(201);
      expect(create.json().label).toBe("RFI-012 Beam clash at grid C");
      pinId = create.json().id;
      expect((await get(`/api/v1/sheets/${sheetA101.id}/pins`, actor.headers)).json().total).toBe(1);
      const reverse = await get(`/api/v1/projects/${projectId}/pins?recordType=rfi&recordId=${rfiId}`, actor.headers);
      expect(reverse.json().total).toBe(1);
      expect(reverse.json().items[0].pinnedOn).toBe("A-101 rev A");
      const del = await built.app.inject({ method: "DELETE", url: `/api/v1/pins/${pinId}`, headers: actor.headers });
      expect(del.statusCode).toBe(200);
    });
  });

  describe("drawing issues: distribution with acknowledgement (#280–#281)", () => {
    let recipient: Member;
    let second: Member;
    let issueId: string;

    beforeAll(async () => {
      recipient = await addMember("field_engineer");
      second = await addMember("field_engineer");
    });

    it("creates a draft from sheets, refuses unknown recipients and empty selections", async () => {
      const empty = await post(`/api/v1/projects/${projectId}/drawing-issues`, actor.headers, { title: "Nothing", recipientUserIds: [recipient.userId] });
      expect(empty.statusCode).toBe(400);
      const ghost = await post(`/api/v1/projects/${projectId}/drawing-issues`, actor.headers, { title: "Ghost", sheetIds: [sheetA101.id], recipientUserIds: ["usr_nobody"] });
      expect(ghost.statusCode).toBe(400);
      const res = await post(`/api/v1/projects/${projectId}/drawing-issues`, actor.headers, {
        title: "Level 1 for construction",
        purpose: "for_construction",
        sheetIds: [sheetA101.id, sheetG001Id],
        recipientUserIds: [recipient.userId, second.userId, recipient.userId],
      });
      expect(res.statusCode).toBe(201);
      issueId = res.json().id;
      expect(res.json()).toMatchObject({ status: "draft", reference: "DI-001" });
      expect(res.json().sheets).toHaveLength(2);
      expect(res.json().recipients).toHaveLength(2);
      expect(res.json().sheets.find((s: { number: string }) => s.number === "A-101").revision).toBe("A");
    });

    it("issues it, notifies recipients, and records acknowledgements", async () => {
      expect((await post(`/api/v1/projects/${projectId}/drawing-issues/${issueId}/acknowledge`, recipient.headers)).statusCode).toBe(409);
      const issued = await post(`/api/v1/projects/${projectId}/drawing-issues/${issueId}/issue`, actor.headers);
      expect(issued.statusCode).toBe(200);
      expect(issued.json().status).toBe("issued");
      expect(issued.json().recipients.every((r: { notifiedAt: string | null }) => r.notifiedAt)).toBe(true);
      const notified = await built.app.db
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, recipient.userId), eq(notifications.recordId, issueId)));
      expect(notified).toHaveLength(1);
      expect(notified[0]!.title).toMatch(/DI-001 issued/);

      expect((await post(`/api/v1/projects/${projectId}/drawing-issues/${issueId}/acknowledge`, actor.headers)).statusCode).toBe(403);
      const ack = await post(`/api/v1/projects/${projectId}/drawing-issues/${issueId}/acknowledge`, recipient.headers);
      expect(ack.statusCode).toBe(200);
      expect(ack.json().acknowledged).toBe(1);
      expect((await post(`/api/v1/projects/${projectId}/drawing-issues/${issueId}/acknowledge`, recipient.headers)).statusCode).toBe(409);
      const patch = await built.app.inject({ method: "PATCH", url: `/api/v1/projects/${projectId}/drawing-issues/${issueId}`, payload: { title: "late edit" }, headers: actor.headers });
      expect(patch.statusCode).toBe(409);
      const transmittal = (await get(`/api/v1/projects/${projectId}/drawing-issues/${issueId}/transmittal`, actor.headers)).json();
      expect(transmittal.items).toHaveLength(2);
      expect(transmittal.recipients.filter((r: { acknowledgedAt: string | null }) => r.acknowledgedAt)).toHaveLength(1);
      const list = (await get(`/api/v1/projects/${projectId}/drawing-issues`, actor.headers)).json();
      expect(list.items[0]).toMatchObject({ recipients: 2, acknowledged: 1, sheetCount: 2 });
      const log = (await get(`/api/v1/projects/${projectId}/sheets/log`, actor.headers)).json();
      expect(log.items.find((r: { number: string }) => r.number === "A-101")).toMatchObject({ lastIssuedReference: "DI-001", acknowledged: "1/2" });
    });

    it("the reminder job nags the silent recipient once", async () => {
      const stale = new Date(Date.now() - 4 * 86_400_000).toISOString();
      await built.app.db.update(drawingIssueRecipients).set({ notifiedAt: stale }).where(eq(drawingIssueRecipients.issueId, issueId));
      const first = await built.app.scheduler.runNow("drawings.issue-reminders");
      expect(first.state).toBe("succeeded");
      expect((first.lastResult as { reminded: number }).reminded).toBe(1);
      const again = await built.app.scheduler.runNow("drawings.issue-reminders");
      expect((again.lastResult as { reminded: number }).reminded).toBe(0);
      const reminders = await built.app.db
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, second.userId), eq(notifications.kind, "reminder")));
      expect(reminders).toHaveLength(1);
      expect((await get(`/api/v1/projects/${projectId}/drawings/health-inputs`, actor.headers)).json().metrics.overdueIssueAcknowledgements).toBe(1);
    });

    it("cancels an issue and hides issues from other tenants", async () => {
      const cancelled = await post(`/api/v1/projects/${projectId}/drawing-issues/${issueId}/cancel`, actor.headers, { reason: "superseded by DI-002" });
      expect(cancelled.json().status).toBe("cancelled");
      const stranger = await registerActor(built.app);
      expect((await get(`/api/v1/projects/${projectId}/drawing-issues`, stranger.headers)).statusCode).toBe(403);
    });
  });
});
