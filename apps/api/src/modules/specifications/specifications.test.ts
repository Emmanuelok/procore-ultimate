import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companyMemberships, projects, projectMemberships, submittals } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import {
  detectSectionHeadings,
  diffClauses,
  divisionTitle,
  extractSubmittalRequirements,
  normaliseSectionCode,
  parseClauses,
  parseDivisionHeading,
  parseSectionHeading,
  splitCsiParts,
} from "./parser.js";

/* ------------------------------------------------------------------ */
/* PDF + multipart fixtures (same shape as the drawings test)          */
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

const BOUNDARY = "----vitestspecboundary";

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

const mpHeaders = (headers: Record<string, string>) => ({
  ...headers,
  "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
});

/* ================================================================== */
/* Parser unit tests — the messy headings a real book actually has     */
/* ================================================================== */

describe("spec parser: section headings", () => {
  it("reads the canonical MasterFormat 2020 heading", () => {
    expect(parseSectionHeading("SECTION 03 30 00 - CAST-IN-PLACE CONCRETE")).toMatchObject({
      code: "03 30 00",
      normalisedCode: "033000",
      title: "CAST-IN-PLACE CONCRETE",
      divisionCode: "03",
      confidence: 0.95,
    });
  });

  it("tolerates en dashes, em dashes and missing spaces", () => {
    expect(parseSectionHeading("Section 09 91 23 – Interior Painting")).toMatchObject({
      code: "09 91 23",
      title: "Interior Painting",
    });
    expect(
      parseSectionHeading("SECTION 260519—LOW-VOLTAGE ELECTRICAL POWER CONDUCTORS AND CABLES"),
    ).toMatchObject({ code: "26 05 19", normalisedCode: "260519" });
  });

  it("reads MasterFormat 1995 five-digit codes with lower confidence", () => {
    const parsed = parseSectionHeading("03300 CONCRETE WORK");
    expect(parsed).toMatchObject({ code: "03300", normalisedCode: "03300", divisionCode: "03" });
    expect(parsed!.confidence).toBeLessThan(0.8);
  });

  it("strips table-of-contents dot leaders and trailing page numbers", () => {
    expect(
      parseSectionHeading("03 30 00 Cast-in-Place Concrete .................. 12"),
    ).toMatchObject({ code: "03 30 00", title: "Cast-in-Place Concrete" });
    expect(parseSectionHeading("07 92 00  JOINT SEALANTS   14")).toMatchObject({
      title: "JOINT SEALANTS",
    });
  });

  it("keeps level-4 codes intact", () => {
    expect(
      parseSectionHeading("SECTION 05 12 00.13 - ARCHITECTURALLY EXPOSED STRUCTURAL STEEL"),
    ).toMatchObject({ code: "05 12 00.13", normalisedCode: "05120013" });
  });

  it("handles a run-on separator and surrounding whitespace", () => {
    expect(
      parseSectionHeading("   SECTION 23 05 93 -TESTING, ADJUSTING, AND BALANCING FOR HVAC   "),
    ).toMatchObject({ code: "23 05 93", title: "TESTING, ADJUSTING, AND BALANCING FOR HVAC" });
  });

  it("refuses part headings, article numbers, footers and cross-references", () => {
    expect(parseSectionHeading("PART 1 - GENERAL")).toBeNull();
    expect(parseSectionHeading("1.3 SUBMITTALS")).toBeNull();
    expect(parseSectionHeading("2.03 MATERIALS")).toBeNull();
    expect(parseSectionHeading("Refer to Section 03 30 00 for concrete.")).toBeNull();
    expect(parseSectionHeading("03 30 00 - 3")).toBeNull();
    expect(parseSectionHeading("TABLE OF CONTENTS")).toBeNull();
    expect(parseSectionHeading("")).toBeNull();
  });

  it("reads the two-line cover form (code, then title beneath)", () => {
    const hits = detectSectionHeadings("SECTION 03 30 00\nCAST-IN-PLACE CONCRETE\nPART 1 - GENERAL");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ code: "03 30 00", title: "CAST-IN-PLACE CONCRETE" });
    expect(hits[0]!.confidence).toBeLessThan(0.8);
  });

  it("never returns full confidence — a regex reading is not a human reading", () => {
    for (const line of [
      "SECTION 03 30 00 - CAST-IN-PLACE CONCRETE",
      "SECTION 07 92 00 JOINT SEALANTS",
      "03300 CONCRETE WORK",
    ]) {
      expect(parseSectionHeading(line)!.confidence).toBeLessThan(1);
    }
  });

  it("normalises codes and knows the MasterFormat division titles", () => {
    expect(normaliseSectionCode("03 30 00")).toBe("033000");
    expect(normaliseSectionCode("03-30-00")).toBe("033000");
    expect(divisionTitle("03")).toBe("Concrete");
    expect(divisionTitle("26")).toBe("Electrical");
    expect(divisionTitle("99")).toBeNull();
  });

  it("parses division headings, falling back to the canonical title", () => {
    expect(parseDivisionHeading("DIVISION 03 - CONCRETE")).toMatchObject({
      code: "03",
      title: "CONCRETE",
    });
    expect(parseDivisionHeading("Division 26")).toMatchObject({
      code: "26",
      title: "Electrical",
    });
    expect(parseDivisionHeading("SECTION 03 30 00 - CONCRETE")).toBeNull();
  });
});

const SECTION_TEXT = `SECTION 03 30 00 - CAST-IN-PLACE CONCRETE
PART 1 - GENERAL
1.1 SUMMARY
A. Section includes cast-in-place concrete.
1.3 ACTION SUBMITTALS
A. Product Data: For each type of product indicated. Submit three copies.
B. Shop Drawings: Include fabrication and placing drawings for reinforcement,
prior to fabrication. Allow 14 days for the Architect's review.
C. Samples: For each exposed finish, 12 inches square.
D. Coordinate with shop drawings prepared under Section 05 12 00.
1.4 INFORMATIONAL SUBMITTALS
A. Mill certificates for reinforcing steel.
B. Deferred submittal: post-installed anchor calculations.
1.5 CLOSEOUT SUBMITTALS
A. Operation and maintenance manuals for curing compounds.
PART 2 - PRODUCTS
2.1 CONCRETE MATERIALS
A. Portland cement: ASTM C150.
B. See Section 03 20 00 for reinforcement samples.
PART 3 - EXECUTION
3.1 EXAMINATION
A. Examine substrate.
END OF SECTION
03 30 00 - 1`;

describe("spec parser: clauses, parts and diffs", () => {
  it("rebuilds clause refs from the markers alone", () => {
    const clauses = parseClauses(SECTION_TEXT);
    const refs = clauses.map((c) => c.ref);
    expect(refs).toContain("1.3.A");
    expect(refs).toContain("1.3.B");
    expect(refs).toContain("2.1.A");
    expect(refs).not.toContain("");
  });

  it("folds a wrapped line into the clause above it", () => {
    const clause = parseClauses(SECTION_TEXT).find((c) => c.ref === "1.3.B");
    expect(clause!.text).toContain("prior to fabrication");
    expect(clause!.text).toContain("Allow 14 days");
  });

  it("drops footers and END OF SECTION", () => {
    const texts = parseClauses(SECTION_TEXT).map((c) => c.text);
    expect(texts.some((t) => t.includes("END OF SECTION"))).toBe(false);
    expect(texts.some((t) => t.trim() === "03 30 00 - 1")).toBe(false);
  });

  it("splits the CSI three-part structure with its articles", () => {
    const parts = splitCsiParts(SECTION_TEXT);
    expect(parts["part1"]?.title).toBe("GENERAL");
    expect(parts["part2"]?.title).toBe("PRODUCTS");
    expect(parts["part3"]?.title).toBe("EXECUTION");
    expect(parts["part1"]?.articles.map((a) => a.ref)).toEqual(["1.1", "1.3", "1.4", "1.5"]);
  });

  it("diffs revisions clause by clause, in both directions", () => {
    const next = SECTION_TEXT.replace("12 inches square", "18 inches square").replace(
      "A. Examine substrate.",
      "A. Examine substrate.\nB. Verify levels before placement.",
    );
    const changes = diffClauses(SECTION_TEXT, next);
    expect(changes.find((c) => c.ref === "1.3.C")).toMatchObject({ kind: "amended" });
    expect(changes.find((c) => c.ref === "1.3.C")!.previousText).toContain("12 inches");
    expect(changes.find((c) => c.ref === "3.1.B")).toMatchObject({ kind: "added" });

    const removed = diffClauses(next, SECTION_TEXT);
    expect(removed.find((c) => c.ref === "3.1.B")).toMatchObject({ kind: "removed" });
    expect(diffClauses(SECTION_TEXT, SECTION_TEXT)).toEqual([]);
  });
});

describe("spec parser: submittal requirement extraction", () => {
  const found = extractSubmittalRequirements(SECTION_TEXT);
  const byRef = new Map(found.map((r) => [r.paragraphRef, r] as const));

  it("finds each kind of submittal-requiring clause and types it", () => {
    expect(byRef.get("1.3.A")).toMatchObject({ submittalType: "product_data" });
    expect(byRef.get("1.3.B")).toMatchObject({ submittalType: "shop_drawing" });
    expect(byRef.get("1.3.C")).toMatchObject({ submittalType: "sample" });
    expect(byRef.get("1.4.A")).toMatchObject({ submittalType: "certificate" });
    expect(byRef.get("1.5.A")).toMatchObject({ submittalType: "o_and_m" });
  });

  it("refuses a mere mention or a cross-reference", () => {
    // "Coordinate with shop drawings prepared under Section 05 12 00."
    expect(byRef.has("1.3.D")).toBe(false);
    // "See Section 03 20 00 for reinforcement samples."
    expect(byRef.has("2.1.B")).toBe(false);
  });

  it("pulls copies, timing, review allowance and deferral out of the clause", () => {
    expect(byRef.get("1.3.A")!.requiredCopies).toBe(3);
    expect(byRef.get("1.3.B")!.requiredBefore).toBe("prior to fabrication");
    expect(byRef.get("1.3.B")!.reviewDays).toBe(14);
    expect(byRef.get("1.4.B")!.isDeferred).toBe(true);
  });

  it("cites the clause verbatim and names the phrase that fired", () => {
    const shop = byRef.get("1.3.B")!;
    expect(shop.clauseText).toContain("Include fabrication and placing drawings");
    expect(shop.matchedTerm.toLowerCase()).toBe("shop drawings");
    expect(shop.title).toBe("Shop Drawings");
  });

  it("never claims certainty and never drops below its own floor", () => {
    for (const r of found) {
      expect(r.confidence).toBeGreaterThanOrEqual(0.5);
      expect(r.confidence).toBeLessThan(1);
    }
  });

  it("prefers the more specific term over the generic one", () => {
    const [row] = extractSubmittalRequirements(
      "1.3 SUBMITTALS\nA. Coordination Drawings: Submit before installation.",
    );
    expect(row).toMatchObject({ submittalType: "shop_drawing", title: "Coordination Drawings" });
  });

  it("yields one row per paragraph and type, keeping the strongest reading", () => {
    const rows = extractSubmittalRequirements(
      "1.3 SUBMITTALS\nA. Shop Drawings: submit shop drawings for every assembly.",
    );
    expect(rows).toHaveLength(1);
  });

  it("returns nothing at all for a section that demands nothing", () => {
    expect(
      extractSubmittalRequirements("PART 3 - EXECUTION\n3.1 EXAMINATION\nA. Examine substrate."),
    ).toEqual([]);
  });
});

/* ================================================================== */
/* Integration                                                         */
/* ================================================================== */

let built: BuiltApp;
let uploader: TestActor;
let reviewer: TestActor;
let readOnly: TestActor;
let reviewerHeaders: Record<string, string>;
let readOnlyHeaders: Record<string, string>;
let projectId: string;

const BOOK_PAGES = [
  "SECTION 03 30 00 - CAST-IN-PLACE CONCRETE\nPART 1 - GENERAL\n1.3 ACTION SUBMITTALS\nA. Product Data: For each type of product. Submit three copies.\nB. Shop Drawings: Include placing drawings, prior to fabrication.",
  "C. Samples: For each exposed finish.\n1.4 INFORMATIONAL SUBMITTALS\nA. Mill certificates for reinforcing steel.\nEND OF SECTION\n03 30 00 - 2",
  "SECTION 09 91 23 - INTERIOR PAINTING\nPART 1 - GENERAL\n1.3 SUBMITTALS\nA. Product Data: For each paint system.",
];

const inject = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) => built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });

beforeAll(async () => {
  built = await buildTestApp();
  uploader = await registerActor(built.app);
  reviewer = await registerActor(built.app);
  readOnly = await registerActor(built.app);
  await built.app.db.insert(companyMemberships).values([
    {
      id: newId("cm"),
      companyId: uploader.companyId,
      userId: reviewer.userId,
      role: "admin",
    },
    {
      id: newId("cm"),
      companyId: uploader.companyId,
      userId: readOnly.userId,
      role: "member",
    },
  ]);
  reviewerHeaders = {
    authorization: `Bearer ${reviewer.accessToken}`,
    "x-company-id": uploader.companyId,
  };
  readOnlyHeaders = {
    authorization: `Bearer ${readOnly.accessToken}`,
    "x-company-id": uploader.companyId,
  };

  projectId = newId("prj");
  await built.app.db
    .insert(projects)
    .values({ id: projectId, companyId: uploader.companyId, name: "Spec Tower" });
  await built.app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: uploader.companyId,
    projectId,
    userId: readOnly.userId,
    templateKey: "read_only",
    overrides: {},
  });
}, 180_000);

afterAll(async () => {
  await built.close();
});

describe("spec book upload and split", () => {
  let bookId: string;
  let concreteSectionId: string;
  let shopDrawingRequirementId: string;

  it("splits a PDF into divisions, sections and revisions", { timeout: 120_000 }, async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/spec-books`,
      payload: multipartBody(buildPdf(BOOK_PAGES), "spec-book.pdf", {
        name: "Project Specification",
        issueLabel: "IFC",
        issuedDate: "2026-03-01",
        issuedByOrganisation: "Alpha Architects",
      }),
      headers: mpHeaders(uploader.headers),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    bookId = body.id;
    expect(body.processing).toBe("ready");
    expect(body.reference).toMatch(/^SPEC-\d{3}$/);
    expect(body.sourceFileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.sectionsCreated).toBe(2);
    expect(body.divisionsCreated).toBe(2);
    expect(body.revisionsAdded).toBe(2);
    expect(body.requirementsExtracted).toBeGreaterThanOrEqual(4);
    expect(body.requirementsConfirmed).toBe(0);

    const detail = await inject("GET", `/api/v1/projects/${projectId}/spec-books/${bookId}`, uploader.headers);
    const divisions = detail.json().divisions as { code: string; title: string }[];
    expect(divisions.map((d) => d.code).sort()).toEqual(["03", "09"]);
    expect(divisions.find((d) => d.code === "03")!.title).toBe("Concrete");
    const sections = detail.json().sections as { code: string; title: string; id: string }[];
    expect(sections.map((s) => s.code).sort()).toEqual(["03 30 00", "09 91 23"]);
    concreteSectionId = sections.find((s) => s.code === "03 30 00")!.id;
  });

  it("keeps the section's page range and hashed text on the revision", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/spec-sections/${concreteSectionId}`,
      uploader.headers,
    );
    const body = res.json();
    expect(body.currentRevision.revision).toBe("0");
    expect(body.currentRevision.pageStart).toBe(1);
    expect(body.currentRevision.pageEnd).toBe(2);
    expect(body.currentRevision.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.currentRevision.parts.part1.title).toBe("GENERAL");
    expect(body.currentRevision.isSuperseded).toBe(0);
  });

  it("marks every extracted requirement as machine-read and unconfirmed", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/spec-requirements`,
      uploader.headers,
    );
    const items = res.json().items as {
      id: string;
      status: string;
      submittalType: string;
      extractionMethod: string;
      extractionConfidence: number;
      provenance: { humanConfirmed: boolean; extractor: string };
    }[];
    expect(items.length).toBeGreaterThanOrEqual(4);
    for (const item of items) {
      expect(item.status).toBe("identified");
      expect(item.extractionMethod).toBe("ai_extracted");
      expect(item.extractionConfidence).toBeGreaterThan(0);
      expect(item.extractionConfidence).toBeLessThan(1);
      expect(item.provenance.humanConfirmed).toBe(false);
      expect(item.provenance.extractor).toContain("heuristic");
    }
    shopDrawingRequirementId = items.find((i) => i.submittalType === "shop_drawing")!.id;
    expect(shopDrawingRequirementId).toBeTruthy();
  });

  it("refuses to register a requirement no human has confirmed", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/spec-requirements/${shopDrawingRequirementId}/register`,
      uploader.headers,
      {},
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/confirmed by a human/i);
    const after = await inject(
      "GET",
      `/api/v1/projects/${projectId}/spec-requirements/${shopDrawingRequirementId}`,
      uploader.headers,
    );
    expect(after.json().status).toBe("identified");
    expect(after.json().registeredSubmittalId).toBeNull();
  });

  it("refuses to let the extractor confirm their own extraction", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/spec-requirements/${shopDrawingRequirementId}/confirm`,
      uploader.headers,
      {},
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/may not confirm/i);
  });

  it("accepts confirmation from a second person and records who", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/spec-requirements/${shopDrawingRequirementId}/confirm`,
      reviewerHeaders,
      { note: "Read against the issued clause 1.3.B" },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("confirmed");
    expect(body.confirmedBy).toBe(reviewer.userId);
    expect(body.provenance.humanConfirmed).toBe(true);
    // The machine reading is still on the record — confirmation adds, never overwrites.
    expect(body.extractionMethod).toBe("ai_extracted");
    expect(body.extractionConfidence).toBeGreaterThan(0);
  });

  it("refuses a second confirmation", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/spec-requirements/${shopDrawingRequirementId}/confirm`,
      reviewerHeaders,
      {},
    );
    expect(res.statusCode).toBe(409);
  });

  it("registers a confirmed requirement as a real submittal", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/spec-requirements/${shopDrawingRequirementId}/register`,
      reviewerHeaders,
      { requiredOnSite: "2026-09-01", leadTimeDays: 30 },
    );
    expect(res.statusCode).toBe(201);
    const { requirement, submittal } = res.json();
    expect(requirement.status).toBe("registered");
    expect(requirement.registeredSubmittalId).toBe(submittal.id);
    expect(requirement.registeredBy).toBe(reviewer.userId);
    expect(submittal.specSection).toBe("03 30 00");
    expect(submittal.submittalType).toBe("shop_drawing");
    expect(submittal.status).toBe("draft");
    expect(submittal.submitByDate).toBeTruthy();

    const rows = await built.app.db.select().from(submittals);
    expect(rows.find((r) => r.id === submittal.id)).toBeTruthy();
  });

  it("refuses to register the same requirement twice", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/spec-requirements/${shopDrawingRequirementId}/register`,
      reviewerHeaders,
      {},
    );
    expect(res.statusCode).toBe(409);
  });

  it("freezes a registered requirement against edits", async () => {
    const res = await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/spec-requirements/${shopDrawingRequirementId}`,
      reviewerHeaders,
      { title: "Rewritten after the fact" },
    );
    expect(res.statusCode).toBe(400);
  });

  it("builds the register for a book, registering only what was confirmed", async () => {
    const list = await inject(
      "GET",
      `/api/v1/projects/${projectId}/spec-requirements?status=identified`,
      uploader.headers,
    );
    const identified = list.json().items as { id: string }[];
    expect(identified.length).toBeGreaterThan(0);
    // Confirm exactly one more; the rest stay identified.
    const toConfirm = identified[0]!.id;
    const confirmed = await inject(
      "POST",
      `/api/v1/projects/${projectId}/spec-requirements/${toConfirm}/confirm`,
      reviewerHeaders,
      {},
    );
    expect(confirmed.statusCode).toBe(200);

    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/spec-books/${bookId}/build-register`,
      reviewerHeaders,
      {},
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.registeredCount).toBe(1);
    expect(body.registered[0].requirementId).toBe(toConfirm);
    expect(body.skippedCount).toBe(identified.length - 1 + 1); // remaining identified + the already-registered one
    const skippedIdentified = body.skipped.filter(
      (s: { status: string }) => s.status === "identified",
    );
    expect(skippedIdentified.length).toBe(identified.length - 1);
    expect(skippedIdentified[0].reason).toMatch(/not yet confirmed/i);

    const book = await inject(
      "GET",
      `/api/v1/projects/${projectId}/spec-books/${bookId}`,
      uploader.headers,
    );
    expect(book.json().registerBuiltAt).toBeTruthy();
    expect(book.json().registerBuiltBy).toBe(reviewer.userId);
  });

  it("detects an unchanged reissue instead of inventing a revision", { timeout: 120_000 }, async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/spec-books`,
      payload: multipartBody(buildPdf(BOOK_PAGES), "spec-book-again.pdf", {
        name: "Project Specification",
        issueLabel: "IFC (reissued, unchanged)",
        extractRequirements: "false",
      }),
      headers: mpHeaders(uploader.headers),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().unchangedSections).toBe(2);
    expect(res.json().revisionsAdded).toBe(0);

    const section = await inject(
      "GET",
      `/api/v1/projects/${projectId}/spec-sections/${concreteSectionId}`,
      uploader.headers,
    );
    expect(section.json().revisions).toHaveLength(1);
  });

  it("supersedes in both directions when the text actually changes", { timeout: 120_000 }, async () => {
    const changed = [...BOOK_PAGES];
    changed[0] = changed[0]!.replace("Submit three copies.", "Submit five copies.");
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/spec-books`,
      payload: multipartBody(buildPdf(changed), "spec-book-rev-a.pdf", {
        name: "Project Specification",
        issueLabel: "Rev A",
        makeCurrent: "true",
        extractRequirements: "false",
      }),
      headers: mpHeaders(uploader.headers),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().revisionsAdded).toBe(1);
    expect(res.json().unchangedSections).toBe(1);
    expect(res.json().isCurrent).toBe(1);

    const section = await inject(
      "GET",
      `/api/v1/projects/${projectId}/spec-sections/${concreteSectionId}`,
      uploader.headers,
    );
    const body = section.json();
    expect(body.revisions).toHaveLength(2);
    const current = body.revisions.find((r: { id: string }) => r.id === body.currentRevisionId);
    expect(current.revision).toBe("A");
    expect(current.isSuperseded).toBe(0);
    expect(current.supersedesRevisionId).toBeTruthy();
    const old = body.revisions.find((r: { revision: string }) => r.revision === "0");
    expect(old.isSuperseded).toBe(1);
    expect(old.supersededByRevisionId).toBe(current.id);
    expect(old.supersededAt).toBeTruthy();
    // The diff is clause-level, not line-level.
    expect(current.changedClauses.some((c: { ref: string }) => c.ref === "1.3.A")).toBe(true);
  });

  it("supersedes the previous book when a new issue becomes current", async () => {
    const list = await inject("GET", `/api/v1/projects/${projectId}/spec-books`, uploader.headers);
    const books = list.json().items as { id: string; isCurrent: number; status: string }[];
    const current = books.filter((b) => b.isCurrent === 1);
    expect(current).toHaveLength(1);

    const older = books.find((b) => b.id === bookId)!;
    expect(["draft", "superseded"]).toContain(older.status);

    const promote = await inject(
      "POST",
      `/api/v1/projects/${projectId}/spec-books/${bookId}/set-current`,
      uploader.headers,
      {},
    );
    expect(promote.statusCode).toBe(200);
    expect(promote.json().isCurrent).toBe(1);
    expect(promote.json().supersedesId).toBe(current[0]!.id);

    const after = await inject("GET", `/api/v1/projects/${projectId}/spec-books`, uploader.headers);
    const superseded = (after.json().items as { id: string; supersededById: string | null }[]).find(
      (b) => b.id === current[0]!.id,
    );
    expect(superseded!.supersededById).toBe(bookId);
  });

  it("refuses acceptance by the uploader and allows it by a second person", async () => {
    const self = await inject(
      "POST",
      `/api/v1/projects/${projectId}/spec-books/${bookId}/accept`,
      uploader.headers,
      {},
    );
    expect(self.statusCode).toBe(403);
    expect(self.json().message).toMatch(/may not accept/i);

    const other = await inject(
      "POST",
      `/api/v1/projects/${projectId}/spec-books/${bookId}/accept`,
      reviewerHeaders,
      {},
    );
    expect(other.statusCode).toBe(200);
    expect(other.json().acceptedBy).toBe(reviewer.userId);
  });

  it("serves the source PDF with its content hash", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/spec-books/${bookId}/pdf`,
      uploader.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("pdf");
    expect(res.headers["x-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("marks an unreadable PDF failed instead of throwing a 500", { timeout: 120_000 }, async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/spec-books`,
      payload: multipartBody(Buffer.from("definitely not a pdf"), "junk.pdf", { name: "Junk" }),
      headers: mpHeaders(uploader.headers),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().processing).toBe("failed");
    expect(res.json().status).toBe("failed");
    expect(res.json().error).toBeTruthy();
  });

  it("refuses spec writes from a read-only project member", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/spec-sections`,
      readOnlyHeaders,
      { code: "22 11 16", title: "DOMESTIC WATER PIPING" },
    );
    expect(res.statusCode).toBe(403);
    const read = await inject(
      "GET",
      `/api/v1/projects/${projectId}/spec-sections`,
      readOnlyHeaders,
    );
    expect(read.statusCode).toBe(200);
  });
});

describe("manual sections, references and coverage", () => {
  let manualSectionId: string;
  let manualRequirementId: string;
  let bookId: string;

  beforeAll(async () => {
    const books = await inject("GET", `/api/v1/projects/${projectId}/spec-books`, uploader.headers);
    bookId = (books.json().items as { id: string; processing: string }[]).find(
      (b) => b.processing === "ready",
    )!.id;
  });

  it("creates a section by hand with its own text", async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/spec-sections`, uploader.headers, {
      code: "07 92 00",
      title: "JOINT SEALANTS",
      bookId,
      text: "PART 1 - GENERAL\n1.3 SUBMITTALS\nA. Product Data: For each joint sealant product.",
    });
    expect(res.statusCode).toBe(201);
    manualSectionId = res.json().id;
    expect(res.json().normalisedCode).toBe("079200");
    expect(res.json().divisionCode).toBe("07");
  });

  it("refuses a duplicate section code on the same project", async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/spec-sections`, uploader.headers, {
      code: "07-92-00",
      title: "JOINT SEALANTS (again)",
    });
    expect(res.statusCode).toBe(409);
  });

  it("refuses section text with no book to attribute it to", async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/spec-sections`, uploader.headers, {
      code: "08 11 13",
      title: "HOLLOW METAL DOORS",
      text: "PART 1 - GENERAL",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/bookId/);
  });

  it("extracts on demand from the current revision", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/spec-sections/${manualSectionId}/extract-requirements`,
      uploader.headers,
      {},
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(1);
    expect(res.json().confirmedByThisCall).toBe(0);
    expect(res.json().extractionMethod).toBe("ai_extracted");

    // Running it again is idempotent on (paragraph, type).
    const again = await inject(
      "POST",
      `/api/v1/projects/${projectId}/spec-sections/${manualSectionId}/extract-requirements`,
      uploader.headers,
      {},
    );
    expect(again.json().created).toBe(0);
    expect(again.json().skippedAlreadyHeld).toBe(1);
  });

  it("records a hand-typed requirement with no confidence at all", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/spec-sections/${manualSectionId}/requirements`,
      uploader.headers,
      {
        title: "Warranty",
        submittalType: "warranty",
        paragraphRef: "1.5.A",
        clauseText: "Provide a 10 year manufacturer's warranty.",
      },
    );
    expect(res.statusCode).toBe(201);
    manualRequirementId = res.json().id;
    expect(res.json().extractionMethod).toBe("manual");
    expect(res.json().extractionConfidence).toBeNull();
    expect(res.json().provenance.humanConfirmed).toBe(false);
    expect(res.json().status).toBe("identified");
  });

  it("still requires a second human to confirm a hand-typed requirement", async () => {
    const self = await inject(
      "POST",
      `/api/v1/projects/${projectId}/spec-requirements/${manualRequirementId}/confirm`,
      uploader.headers,
      {},
    );
    expect(self.statusCode).toBe(403);
    const other = await inject(
      "POST",
      `/api/v1/projects/${projectId}/spec-requirements/${manualRequirementId}/confirm`,
      reviewerHeaders,
      {},
    );
    expect(other.statusCode).toBe(200);
  });

  it("marks a requirement not required with a reason", async () => {
    const list = await inject(
      "GET",
      `/api/v1/projects/${projectId}/spec-requirements?sectionId=${manualSectionId}&status=identified`,
      uploader.headers,
    );
    const target = (list.json().items as { id: string }[])[0]!;
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/spec-requirements/${target.id}/not-required`,
      reviewerHeaders,
      { reason: "Sealants are supplied under the facade package" },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("not_required");
    expect(res.json().notRequiredReason).toMatch(/facade package/);
  });

  it("anchors a conflict at a paragraph and lists it as unresolved", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/spec-sections/${manualSectionId}/references`,
      uploader.headers,
      {
        targetType: "spec_section",
        targetId: manualSectionId,
        referenceKind: "conflicts_with",
      },
    );
    expect(res.statusCode).toBe(400); // a section cannot conflict with itself

    const sections = await inject(
      "GET",
      `/api/v1/projects/${projectId}/spec-sections`,
      uploader.headers,
    );
    const other = (sections.json().items as { id: string; code: string }[]).find(
      (s) => s.code === "03 30 00",
    )!;
    const created = await inject(
      "POST",
      `/api/v1/projects/${projectId}/spec-sections/${manualSectionId}/references`,
      uploader.headers,
      {
        targetType: "spec_section",
        targetId: other.id,
        referenceKind: "conflicts_with",
        paragraphRef: "2.3.C.4",
        note: "Sealant joint width contradicts the concrete joint detail",
      },
    );
    expect(created.statusCode).toBe(201);
    expect(created.json().targetLabel).toContain("03 30 00");
    expect(created.json().detail.labelVerified).toBe(true);

    const conflicts = await inject(
      "GET",
      `/api/v1/projects/${projectId}/spec-references/conflicts`,
      uploader.headers,
    );
    expect(conflicts.json().unresolved).toBe(1);
    expect(conflicts.json().items[0].paragraphRef).toBe("2.3.C.4");
    expect(conflicts.json().items[0].section.code).toBe("07 92 00");

    const resolved = await inject(
      "POST",
      `/api/v1/projects/${projectId}/spec-references/${created.json().id}/resolve`,
      reviewerHeaders,
      { resolutionNote: "RFI-014 confirmed the sealant detail governs" },
    );
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().resolvedAt).toBeTruthy();

    const after = await inject(
      "GET",
      `/api/v1/projects/${projectId}/spec-references/conflicts`,
      uploader.headers,
    );
    expect(after.json().unresolved).toBe(0);
    const withResolved = await inject(
      "GET",
      `/api/v1/projects/${projectId}/spec-references/conflicts?includeResolved=1`,
      uploader.headers,
    );
    expect(withResolved.json().total).toBe(1);
  });

  it("refuses a reference to a target that does not exist here", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/spec-sections/${manualSectionId}/references`,
      uploader.headers,
      { targetType: "rfi", targetId: newId("rfi"), referenceKind: "clarified_by" },
    );
    expect(res.statusCode).toBe(404);
  });

  it("reports coverage: unconfirmed sections, unregistered requirements, orphan submittals", async () => {
    // A submittal with no spec basis at all.
    const orphan = await inject("POST", `/api/v1/projects/${projectId}/submittals`, uploader.headers, {
      title: "Hand-typed submittal with no spec basis",
    });
    expect(orphan.statusCode).toBe(201);

    const res = await inject("GET", `/api/v1/projects/${projectId}/spec-coverage`, uploader.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.sections).toBeGreaterThanOrEqual(3);
    expect(body.registerCompleteness.value).not.toBeNull();
    expect(body.registerCompleteness.unit).toBe("%");
    expect(body.registerCompleteness.reasons).toEqual([]);

    const orphanRow = body.submittalsWithoutSpecBasis.find(
      (s: { submittalId: string }) => s.submittalId === orphan.json().id,
    );
    expect(orphanRow.reason).toMatch(/No spec section is recorded/i);

    const never = body.requirementsNeverRegistered as { blocker: string }[];
    expect(never.some((r) => r.blocker === "awaiting human confirmation")).toBe(true);
    expect(
      body.sectionsWithoutConfirmedRequirements.every(
        (s: { reason: string }) => typeof s.reason === "string" && s.reason.length > 0,
      ),
    ).toBe(true);
  });

  it("returns null coverage with reasons on a project holding nothing", async () => {
    const emptyProject = newId("prj");
    await built.app.db
      .insert(projects)
      .values({ id: emptyProject, companyId: uploader.companyId, name: "Empty" });
    const res = await inject(
      "GET",
      `/api/v1/projects/${emptyProject}/spec-coverage`,
      uploader.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().registerCompleteness.value).toBeNull();
    expect(res.json().registerCompleteness.reasons.length).toBeGreaterThan(0);
    expect(res.json().registerCompleteness.reasons[0]).toMatch(/no spec sections/i);
  });

  it("finds a section by code across the company's projects", async () => {
    const res = await inject("GET", `/api/v1/spec-library/sections?code=033000`, uploader.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().items[0].projectId).toBe(projectId);

    const other = await registerActor(built.app);
    const denied = await built.app.inject({
      method: "GET",
      url: `/api/v1/spec-library/sections?code=033000`,
      headers: { authorization: `Bearer ${other.accessToken}`, "x-company-id": other.companyId },
    });
    expect(denied.json().total).toBe(0);
  });
});
