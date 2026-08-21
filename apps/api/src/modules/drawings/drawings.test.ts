import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drawingRevisions, drawingSheets, projects } from "@constructos/db";
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

/* ------------------------------------------------------------------ */
/* Handcrafted minimal PDF fixture (pdfjs parses it fine)              */
/* ------------------------------------------------------------------ */

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

const BOUNDARY = "----vitestboundary";

function multipartBody(
  fileBuffer: Buffer,
  filename: string,
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
      `--${BOUNDARY}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: application/pdf\r\n\r\n`,
    ),
  );
  parts.push(fileBuffer, Buffer.from(`\r\n--${BOUNDARY}--\r\n`));
  return Buffer.concat(parts);
}

const mpHeaders = (a: TestActor) => ({
  ...a.headers,
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
    expect(disciplineForNumber("E-101")).toBe("electrical");
    expect(disciplineForNumber("P-301")).toBe("plumbing");
    expect(disciplineForNumber("FP-101")).toBe("fire_protection");
    expect(disciplineForNumber("C3.1")).toBe("civil");
    expect(disciplineForNumber("G-001")).toBe("general");
    expect(disciplineForNumber("L-100")).toBe("landscape");
    expect(disciplineForNumber("X-9")).toBe("other");
    expect(disciplineForNumber("AD-501")).toBe("architectural");
  });

  it("advances revision labels 0 → A → B … Z → AA", () => {
    expect(nextRevisionLabel(null)).toBe("0");
    expect(nextRevisionLabel("0")).toBe("A");
    expect(nextRevisionLabel("A")).toBe("B");
    expect(nextRevisionLabel("Z")).toBe("AA");
    expect(nextRevisionLabel("AA")).toBe("AB");
    expect(nextRevisionLabel("AZ")).toBe("BA");
    expect(nextRevisionLabel("3")).toBe("A");
  });

  it("prefers the last plausible sheet number in the text stream", () => {
    const text =
      "KEY PLAN\nDETAIL 3/A-501\nGENERAL NOTES CONTINUED\nALPHA TOWER\nFLOOR PLAN LEVEL 2\nSCALE: 1/8\" = 1'-0\"\nA-102";
    const m = detectSheetNumber(text);
    expect(m?.value).toBe("A-102");
  });

  it("ignores blacklisted prefixes, scale and date rows", () => {
    expect(detectSheetNumber("PROJECT NO.12345\nSCALE: A-1\nDATE JAN-2024")).toBeNull();
    expect(detectSheetNumber("REV2 issued\nNO.44")).toBeNull();
  });

  it("extracts an uppercase title near the number, skipping labels", () => {
    const text =
      "DRAWN BY: JDW\nCHECKED BY: MB\nALPHA TOWER PHASE II\nFOUNDATION PLAN\nSCALE: 1/4\" = 1'-0\"\nS-101";
    const num = detectSheetNumber(text);
    const title = detectSheetTitle(text, num?.index ?? null, num?.value ?? null);
    expect(title).toBe("FOUNDATION PLAN");
  });

  it("detects full sheet metadata with confidence", () => {
    const det = detectSheetMeta("LEVEL 3 REFLECTED CEILING PLAN\nA-303");
    expect(det).toMatchObject({
      number: "A-303",
      title: "LEVEL 3 REFLECTED CEILING PLAN",
      discipline: "architectural",
      confident: true,
    });
    const blank = detectSheetMeta("just some lowercase scribbles here");
    expect(blank.number).toBeNull();
    expect(blank.confident).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Pipeline + endpoints                                                */
/* ------------------------------------------------------------------ */

let built: BuiltApp;
let actor: TestActor;
let projectId: string;

beforeAll(async () => {
  built = await buildTestApp();
  actor = await registerActor(built.app);
  projectId = newId("prj");
  await built.app.db
    .insert(projects)
    .values({ id: projectId, companyId: actor.companyId, name: "Tower" });
}, 120_000);

afterAll(async () => {
  await built.close();
});

describe("drawing set pipeline", () => {
  let sheetA101: { id: string; currentRevisionId: string };
  let sheetG001Id: string;
  let sourceFileId: string;
  const setPdf = buildPdf([
    "ALPHA TOWER\nFLOOR PLAN LEVEL 1\nSCALE: 1/8\" = 1'-0\"\nA-101",
    "GENERAL NOTES\nG-001",
    "just an unlabeled photo reference page",
  ]);

  it("uploads and processes a 3-page PDF into sheets", { timeout: 60_000 }, async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/drawing-sets`,
      payload: multipartBody(setPdf, "set-one.pdf", {
        name: "IFC Set 1",
        issuedDate: "2026-01-15",
      }),
      headers: mpHeaders(actor),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.processing).toBe("ready");
    expect(body.name).toBe("IFC Set 1");
    expect(body.sheetsCreated).toBe(3);
    expect(body.revisionsAdded).toBe(3);
    sourceFileId = body.sourceFileId;

    const sheets = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/sheets`,
      headers: actor.headers,
    });
    expect(sheets.json().total).toBe(3);
    const items = sheets.json().items;
    const a101 = items.find((s: { number: string }) => s.number === "A-101");
    expect(a101).toMatchObject({
      title: "FLOOR PLAN LEVEL 1",
      discipline: "architectural",
      needsReview: 0,
    });
    expect(a101.currentRevision.revision).toBe("0");
    sheetA101 = a101;
    sheetG001Id = items.find((s: { number: string }) => s.number === "G-001").id;

    const unnamed = items.find((s: { number: string }) => s.number === "UNNAMED-3");
    expect(unnamed.needsReview).toBe(1);
  });

  it("filters sheets by discipline, search and needsReview", async () => {
    const arch = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/sheets?discipline=architectural`,
      headers: actor.headers,
    });
    expect(arch.json().total).toBe(1);

    const search = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/sheets?search=floor`,
      headers: actor.headers,
    });
    expect(search.json().total).toBe(1);

    const review = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/sheets?needsReview=1`,
      headers: actor.headers,
    });
    expect(review.json().total).toBe(1);
    const noReview = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/sheets?needsReview=0`,
      headers: actor.headers,
    });
    expect(noReview.json().total).toBe(2);
  });

  it("re-upload supersedes: same number gets revision A", { timeout: 60_000 }, async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/drawing-sets`,
      payload: multipartBody(
        buildPdf(["ALPHA TOWER\nFLOOR PLAN LEVEL 1\nSCALE: 1/8\" = 1'-0\"\nA-101"]),
        "set-two.pdf",
        { name: "IFC Set 2", issuedDate: "2026-02-01" },
      ),
      headers: mpHeaders(actor),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().processing).toBe("ready");
    expect(res.json().sheetsCreated).toBe(0);
    expect(res.json().revisionsAdded).toBe(1);

    const detail = await built.app.inject({
      method: "GET",
      url: `/api/v1/sheets/${sheetA101.id}`,
      headers: actor.headers,
    });
    const body = detail.json();
    expect(body.revisions).toHaveLength(2);
    const current = body.revisions.find(
      (r: { id: string }) => r.id === body.currentRevisionId,
    );
    expect(current.revision).toBe("A");
    expect(current.isSuperseded).toBe(0);
    const old = body.revisions.find((r: { revision: string }) => r.revision === "0");
    expect(old.isSuperseded).toBe(1);
    expect(body.currentRevisionId).not.toBe(sheetA101.currentRevisionId);
  });

  it("marks a garbage PDF as failed without a 500", { timeout: 60_000 }, async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/drawing-sets`,
      payload: multipartBody(Buffer.from("this is definitely not a pdf"), "junk.pdf", {
        name: "Junk",
      }),
      headers: mpHeaders(actor),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().processing).toBe("failed");
    expect(res.json().error).toBeTruthy();
  });

  it("lists drawing sets with status and sheet counts", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/drawing-sets`,
      headers: actor.headers,
    });
    expect(res.json().total).toBe(3);
    const ready = res.json().items.filter(
      (s: { processing: string }) => s.processing === "ready",
    );
    expect(ready).toHaveLength(2);
  });

  it("confirms review naming via PATCH", async () => {
    const list = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/sheets?needsReview=1`,
      headers: actor.headers,
    });
    const unnamed = list.json().items[0];
    const res = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/sheets/${unnamed.id}`,
      payload: { number: "A-900", title: "PHOTO REFERENCE", discipline: "architectural" },
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().needsReview).toBe(0);
    expect(res.json().number).toBe("A-900");
  });

  it("exports the sheet log", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/sheets/log`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().items;
    const a101 = rows.find((r: { number: string }) => r.number === "A-101");
    expect(a101).toMatchObject({
      currentRevision: "A",
      revisionCount: 2,
      issuedDate: "2026-02-01",
      discipline: "architectural",
    });
  });

  it("streams the source PDF for the viewer", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/drawing-files/${sourceFileId}/pdf`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.rawPayload.equals(setPdf)).toBe(true);

    const stranger = await registerActor(built.app);
    const blocked = await built.app.inject({
      method: "GET",
      url: `/api/v1/drawing-files/${sourceFileId}/pdf`,
      headers: stranger.headers,
    });
    expect(blocked.statusCode).toBe(404);
  });

  describe("markups, calibration, hyperlinks, pins", () => {
    let revisionId: string;

    beforeAll(async () => {
      const sheet = await built.app.inject({
        method: "GET",
        url: `/api/v1/sheets/${sheetA101.id}`,
        headers: actor.headers,
      });
      revisionId = sheet.json().currentRevisionId;
    });

    it("saves a personal markup layer and publishes it", async () => {
      const shapes = [
        { kind: "rect", from: { x: 0.1, y: 0.1 }, to: { x: 0.3, y: 0.2 }, color: "#f00", width: 2 },
        { kind: "text", at: { x: 0.5, y: 0.5 }, text: "check this beam", color: "#00f", fontSize: 14 },
      ];
      const put = await built.app.inject({
        method: "PUT",
        url: `/api/v1/revisions/${revisionId}/markups`,
        payload: { layer: "personal", shapes },
        headers: actor.headers,
      });
      expect(put.statusCode).toBe(200);
      const markupId = put.json().id;
      expect(put.json().shapes).toHaveLength(2);

      // upsert: second PUT updates the same row
      const put2 = await built.app.inject({
        method: "PUT",
        url: `/api/v1/revisions/${revisionId}/markups`,
        payload: { layer: "personal", shapes: shapes.slice(0, 1) },
        headers: actor.headers,
      });
      expect(put2.json().id).toBe(markupId);
      expect(put2.json().shapes).toHaveLength(1);

      const bad = await built.app.inject({
        method: "PUT",
        url: `/api/v1/revisions/${revisionId}/markups`,
        payload: { layer: "personal", shapes: [{ kind: "hexagon", color: "red" }] },
        headers: actor.headers,
      });
      expect(bad.statusCode).toBe(400);

      const pub = await built.app.inject({
        method: "POST",
        url: `/api/v1/markups/${markupId}/publish`,
        headers: actor.headers,
      });
      expect(pub.statusCode).toBe(200);
      expect(pub.json().layer).toBe("published");

      const list = await built.app.inject({
        method: "GET",
        url: `/api/v1/revisions/${revisionId}/markups`,
        headers: actor.headers,
      });
      expect(list.json().items).toHaveLength(1);
      expect(list.json().items[0].layer).toBe("published");
    });

    it("stores calibration and rejects invalid payloads", async () => {
      const ok = await built.app.inject({
        method: "PUT",
        url: `/api/v1/revisions/${revisionId}/calibration`,
        payload: {
          from: { x: 0.1, y: 0.1 },
          to: { x: 0.9, y: 0.1 },
          realDistance: 30,
          unit: "ft",
        },
        headers: actor.headers,
      });
      expect(ok.statusCode).toBe(200);
      const rev = await built.app.db
        .select()
        .from(drawingRevisions)
        .where(eq(drawingRevisions.id, revisionId));
      expect((rev[0]!.calibration as { unit: string }).unit).toBe("ft");

      const bad = await built.app.inject({
        method: "PUT",
        url: `/api/v1/revisions/${revisionId}/calibration`,
        payload: { from: { x: 0 }, to: { x: 1, y: 1 }, realDistance: -5, unit: "" },
        headers: actor.headers,
      });
      expect(bad.statusCode).toBe(400);
    });

    it("creates, lists and deletes hyperlinks within the project", async () => {
      const create = await built.app.inject({
        method: "POST",
        url: `/api/v1/revisions/${revisionId}/hyperlinks`,
        payload: { toSheetId: sheetG001Id, x: 0.8, y: 0.9, w: 0.05, h: 0.02, label: "see notes" },
        headers: actor.headers,
      });
      expect(create.statusCode).toBe(201);
      const linkId = create.json().id;

      // target in another project is rejected
      const otherProjectId = newId("prj");
      await built.app.db
        .insert(projects)
        .values({ id: otherProjectId, companyId: actor.companyId, name: "Other" });
      const foreignSheetId = newId("dsht");
      await built.app.db.insert(drawingSheets).values({
        id: foreignSheetId,
        companyId: actor.companyId,
        projectId: otherProjectId,
        number: "A-001",
        title: "FOREIGN",
      });
      const cross = await built.app.inject({
        method: "POST",
        url: `/api/v1/revisions/${revisionId}/hyperlinks`,
        payload: { toSheetId: foreignSheetId, x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
        headers: actor.headers,
      });
      expect(cross.statusCode).toBe(400);

      const list = await built.app.inject({
        method: "GET",
        url: `/api/v1/revisions/${revisionId}/hyperlinks`,
        headers: actor.headers,
      });
      expect(list.json().total).toBe(1);

      const del = await built.app.inject({
        method: "DELETE",
        url: `/api/v1/revisions/${revisionId}/hyperlinks/${linkId}`,
        headers: actor.headers,
      });
      expect(del.statusCode).toBe(200);
    });

    it("places, lists, reverse-looks-up and deletes pins", async () => {
      const create = await built.app.inject({
        method: "POST",
        url: `/api/v1/sheets/${sheetA101.id}/pins`,
        payload: { recordType: "rfi", recordId: "rfi_abc123", x: 0.42, y: 0.58 },
        headers: actor.headers,
      });
      expect(create.statusCode).toBe(201);
      const pinId = create.json().id;

      const list = await built.app.inject({
        method: "GET",
        url: `/api/v1/sheets/${sheetA101.id}/pins`,
        headers: actor.headers,
      });
      expect(list.json().total).toBe(1);

      const reverse = await built.app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/pins?recordType=rfi&recordId=rfi_abc123`,
        headers: actor.headers,
      });
      expect(reverse.json().total).toBe(1);
      expect(reverse.json().items[0].sheetNumber).toBe("A-101");

      const outOfRange = await built.app.inject({
        method: "POST",
        url: `/api/v1/sheets/${sheetA101.id}/pins`,
        payload: { recordType: "punch", recordId: "pn_1", x: 1.5, y: 0.5 },
        headers: actor.headers,
      });
      expect(outOfRange.statusCode).toBe(400);

      const del = await built.app.inject({
        method: "DELETE",
        url: `/api/v1/pins/${pinId}`,
        headers: actor.headers,
      });
      expect(del.statusCode).toBe(200);
    });

    it("hides sheets from other tenants", async () => {
      const stranger = await registerActor(built.app);
      const res = await built.app.inject({
        method: "GET",
        url: `/api/v1/sheets/${sheetA101.id}`,
        headers: stranger.headers,
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
