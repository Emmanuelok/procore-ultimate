import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import {
  drawingSheets,
  files,
  rfis,
  specBooks,
  specDivisions,
  specReferences,
  specSectionRevisions,
  specSections,
  specSubmittalRequirements,
  submittals,
} from "@constructos/db";
import {
  SPEC_BOOK_STATUSES,
  SPEC_CLASSIFICATION_SYSTEMS,
  SPEC_EXTRACTION_METHODS,
  SPEC_REFERENCE_KINDS,
  SPEC_REFERENCE_TARGETS,
  SPEC_REQUIREMENT_STATUSES,
  SPEC_SECTION_STATUSES,
  SUBMITTAL_TYPES,
} from "@constructos/shared";
import { sha256Hex } from "@constructos/ledger";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { addDaysISO, isoDateSchema } from "../field/dates.js";
import { nextRevisionLabel } from "../drawings/detectors.js";
import {
  detectSectionHeadings,
  diffClauses,
  divisionTitle,
  extractSubmittalRequirements,
  EXTRACTOR_VERSION,
  normaliseSectionCode,
  parseDivisionHeading,
  splitCsiParts,
} from "./parser.js";

/**
 * SPECIFICATIONS (M19, spec Vol I §2.3) — tool key `specifications`.
 *
 * The claim this module has to exist is one sentence: **a submittal register
 * is BUILT FROM the spec book, not typed by hand.** Part 1.3 of every section
 * lists what must be submitted; `spec_submittal_requirements` is that list;
 * `registeredSubmittalId` is the forward link to the real `submittals` row
 * (field.ts) each requirement produced. "The shop drawing for 03 30 00 was
 * never registered" is then a query, not a memory.
 *
 * Three rules hold the honesty of that build:
 *
 *  1. EXTRACTION IS NEVER VALIDATION. Every requirement carries
 *     `extractionMethod` + `extractionConfidence` on every response it ever
 *     appears in, and a machine-read requirement sits at `identified` until a
 *     HUMAN moves it to `confirmed`. Registration refuses anything that is
 *     not `confirmed` — there is no flag, no query parameter and no bulk verb
 *     that skips that step (`/build-register` reports what it skipped and
 *     why, it does not confirm on your behalf).
 *  2. THE CONFIRMER IS NOT THE EXTRACTOR. The person who ran the extraction
 *     or typed the row may not be the person who agrees it is real, and the
 *     person who uploaded a book may not be the person who accepts it.
 *  3. SUPERSESSION IS TWO-WAY. A section revision records both
 *     `supersedesRevisionId` and `supersededByRevisionId`, because the
 *     question asked in a dispute — "what did the spec say the day this was
 *     priced" — is answered by reading a superseded row, not by reading a
 *     history table. An unchanged reissue is detected by `contentSha256` and
 *     creates no revision at all.
 *
 * The PDF split follows `modules/drawings` exactly: upload once,
 * content-address it, extract text per page inline, and detect structure with
 * the pure, unit-tested heuristics in `./parser.ts`. Each section revision
 * points at the WHOLE book file plus its page range — the same compromise
 * drawing revisions make — so nothing is re-encoded and the bytes a reviewer
 * opens are the bytes that were uploaded.
 */

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const bookPatchSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  description: z.string().max(5000).nullable().optional(),
  issueLabel: z.string().max(120).nullable().optional(),
  issuedDate: isoDateSchema.nullable().optional(),
  issuedByOrganisation: z.string().max(300).nullable().optional(),
  classificationSystem: z.enum(SPEC_CLASSIFICATION_SYSTEMS).optional(),
  status: z.enum(SPEC_BOOK_STATUSES).optional(),
  contractId: z.string().max(64).nullable().optional(),
});

const booksListQuery = pageQuerySchema.extend({
  status: z.enum(SPEC_BOOK_STATUSES).optional(),
  processing: z.enum(["pending", "processing", "ready", "failed"]).optional(),
  search: z.string().max(200).optional(),
});

const sectionCreateSchema = z.object({
  code: z.string().min(2).max(60),
  title: z.string().min(1).max(300),
  divisionCode: z.string().max(8).nullable().optional(),
  divisionId: z.string().max(64).nullable().optional(),
  tradeCode: z.string().max(60).nullable().optional(),
  responsibleVendorId: z.string().max(64).nullable().optional(),
  responsibleUserId: z.string().max(64).nullable().optional(),
  /** optional initial revision text, so a hand-keyed section is usable at once */
  text: z.string().max(2_000_000).nullable().optional(),
  /** the issue the text belongs to — required whenever `text` is given */
  bookId: z.string().max(64).optional(),
  revision: z.string().max(20).optional(),
  issuedDate: isoDateSchema.nullable().optional(),
});

const sectionPatchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  status: z.enum(SPEC_SECTION_STATUSES).optional(),
  divisionId: z.string().max(64).nullable().optional(),
  divisionCode: z.string().max(8).nullable().optional(),
  tradeCode: z.string().max(60).nullable().optional(),
  responsibleVendorId: z.string().max(64).nullable().optional(),
  responsibleUserId: z.string().max(64).nullable().optional(),
});

const sectionsListQuery = pageQuerySchema.extend({
  status: z.enum(SPEC_SECTION_STATUSES).optional(),
  divisionCode: z.string().max(8).optional(),
  bookId: z.string().max(64).optional(),
  code: z.string().max(60).optional(),
  search: z.string().max(200).optional(),
  requirementsConfirmed: z.enum(["0", "1"]).optional(),
});

const revisionCreateSchema = z.object({
  bookId: z.string().min(1).max(64),
  revision: z.string().max(20).optional(),
  text: z.string().max(2_000_000).nullable().optional(),
  issuedDate: isoDateSchema.nullable().optional(),
  effectiveFrom: isoDateSchema.nullable().optional(),
  pageStart: z.number().int().min(1).max(100_000).nullable().optional(),
  pageEnd: z.number().int().min(1).max(100_000).nullable().optional(),
  changeSummary: z.string().max(5000).nullable().optional(),
  issuedBy: z.string().max(300).nullable().optional(),
  fileId: z.string().max(64).nullable().optional(),
});

const requirementCreateSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(5000).nullable().optional(),
  clauseText: z.string().max(20_000).nullable().optional(),
  paragraphRef: z.string().max(60).nullable().optional(),
  submittalType: z.enum(SUBMITTAL_TYPES).optional(),
  requiredCopies: z.number().int().min(1).max(100).nullable().optional(),
  requiredBefore: z.string().max(200).nullable().optional(),
  leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
  reviewDays: z.number().int().min(0).max(365).nullable().optional(),
  isDeferred: z.boolean().optional(),
  sectionRevisionId: z.string().max(64).nullable().optional(),
  responsibleVendorId: z.string().max(64).nullable().optional(),
  commitmentId: z.string().max(64).nullable().optional(),
  bidPackageId: z.string().max(64).nullable().optional(),
});

const requirementPatchSchema = requirementCreateSchema.partial();

const requirementsListQuery = pageQuerySchema.extend({
  status: z.enum(SPEC_REQUIREMENT_STATUSES).optional(),
  sectionId: z.string().max(64).optional(),
  bookId: z.string().max(64).optional(),
  submittalType: z.enum(SUBMITTAL_TYPES).optional(),
  extractionMethod: z.enum(SPEC_EXTRACTION_METHODS).optional(),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  registered: z.enum(["0", "1"]).optional(),
});

const registerSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  requiredOnSite: isoDateSchema.nullable().optional(),
  leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
  ballInCourtId: z.string().max(64).nullable().optional(),
});

const referenceCreateSchema = z.object({
  targetType: z.enum(SPEC_REFERENCE_TARGETS),
  targetId: z.string().min(1).max(64),
  targetLabel: z.string().max(300).nullable().optional(),
  referenceKind: z.enum(SPEC_REFERENCE_KINDS).optional(),
  paragraphRef: z.string().max(60).nullable().optional(),
  pageIndex: z.number().int().min(0).max(100_000).nullable().optional(),
  note: z.string().max(5000).nullable().optional(),
  sectionRevisionId: z.string().max(64).nullable().optional(),
});

const referencesListQuery = pageQuerySchema.extend({
  referenceKind: z.enum(SPEC_REFERENCE_KINDS).optional(),
  targetType: z.enum(SPEC_REFERENCE_TARGETS).optional(),
  sectionId: z.string().max(64).optional(),
  resolved: z.enum(["0", "1"]).optional(),
});

/* ------------------------------------------------------------------ */
/* Multipart + PDF helpers (identical shape to modules/drawings)       */
/* ------------------------------------------------------------------ */

function fieldValue(fields: unknown, key: string): string | undefined {
  const f = (fields as Record<string, unknown>)?.[key];
  const v = Array.isArray(f) ? f[0] : f;
  if (v && typeof v === "object" && "value" in v) {
    const val = (v as { value: unknown }).value;
    if (typeof val === "string" && val.length > 0) return val;
  }
  return undefined;
}

function boolField(fields: unknown, key: string, fallback: boolean): boolean {
  const raw = fieldValue(fields, key);
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
}

interface PageText {
  pageIndex: number;
  text: string;
}

async function extractPdfPages(buf: Buffer): Promise<PageText[]> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(buf), useSystemFonts: true });
  try {
    const doc = await task.promise;
    const pages: PageText[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      let text = "";
      for (const item of tc.items) {
        if (!("str" in item)) continue;
        text += item.str;
        text += item.hasEOL ? "\n" : " ";
      }
      pages.push({ pageIndex: p - 1, text });
    }
    return pages;
  } finally {
    try {
      await task.destroy();
    } catch {
      /* ignore cleanup failures */
    }
  }
}

/** A section as the splitter found it in the book, before it touches the db. */
interface SplitSection {
  code: string;
  normalisedCode: string;
  title: string;
  divisionCode: string;
  confidence: number;
  pageStart: number;
  pageEnd: number;
  text: string;
}

/**
 * Split a book's page texts into sections. A section owns every page from its
 * heading up to the page before the next heading — the same rule a person
 * applies with a ruler and a stack of tabs.
 */
export function splitBookPages(pages: PageText[]): {
  sections: SplitSection[];
  divisions: Map<string, { title: string; pageStart: number; pageEnd: number }>;
} {
  const sections: SplitSection[] = [];
  const divisions = new Map<string, { title: string; pageStart: number; pageEnd: number }>();
  let current: SplitSection | null = null;

  for (const page of pages) {
    const pageNumber = page.pageIndex + 1;
    for (const line of page.text.split("\n")) {
      const div = parseDivisionHeading(line);
      if (!div) continue;
      const existing = divisions.get(div.code);
      if (existing) existing.pageEnd = pageNumber;
      else divisions.set(div.code, { title: div.title, pageStart: pageNumber, pageEnd: pageNumber });
    }

    const hits = detectSectionHeadings(page.text);
    // Only the FIRST heading on a page opens a section: a page that mentions
    // three section numbers in a cross-reference list is not three sections,
    // and a genuine section always starts at the top of its own page.
    const opener = hits.find((h) => !sections.some((s) => s.normalisedCode === h.normalisedCode));
    if (opener) {
      if (current) current.pageEnd = Math.max(current.pageStart, pageNumber - 1);
      current = {
        code: opener.code,
        normalisedCode: opener.normalisedCode,
        title: opener.title,
        divisionCode: opener.divisionCode,
        confidence: opener.confidence,
        pageStart: pageNumber,
        pageEnd: pageNumber,
        text: page.text,
      };
      sections.push(current);
      continue;
    }
    if (current) {
      current.text += `\n${page.text}`;
      current.pageEnd = pageNumber;
    }
  }
  return { sections, divisions };
}

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

/** Mirrors REVIEW_ALLOWANCE_DAYS in modules/field/submittals.ts. */
const DEFAULT_REVIEW_ALLOWANCE_DAYS = 14;

export const specificationsModule: FastifyPluginAsync = async (app) => {
  const readGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("specifications", "read"),
  ];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("specifications", "standard"),
  ];
  const adminGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("specifications", "admin"),
  ];
  const companyRead = [app.authenticate, app.requireCompany];

  /* ---------------------------------------------------------------- */
  /* Fetchers                                                          */
  /* ---------------------------------------------------------------- */

  async function fetchBook(req: FastifyRequest, bookId: string) {
    const rows = await app.db
      .select()
      .from(specBooks)
      .where(
        and(
          eq(specBooks.id, bookId),
          eq(specBooks.companyId, req.companyId!),
          eq(specBooks.projectId, req.projectId!),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Spec book not found");
    return rows[0];
  }

  async function fetchSection(req: FastifyRequest, sectionId: string) {
    const rows = await app.db
      .select()
      .from(specSections)
      .where(
        and(
          eq(specSections.id, sectionId),
          eq(specSections.companyId, req.companyId!),
          eq(specSections.projectId, req.projectId!),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Spec section not found");
    return rows[0];
  }

  async function fetchRevision(req: FastifyRequest, revisionId: string) {
    const rows = await app.db
      .select()
      .from(specSectionRevisions)
      .where(
        and(
          eq(specSectionRevisions.id, revisionId),
          eq(specSectionRevisions.companyId, req.companyId!),
          eq(specSectionRevisions.projectId, req.projectId!),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Spec section revision not found");
    return rows[0];
  }

  async function fetchRequirement(req: FastifyRequest, requirementId: string) {
    const rows = await app.db
      .select()
      .from(specSubmittalRequirements)
      .where(
        and(
          eq(specSubmittalRequirements.id, requirementId),
          eq(specSubmittalRequirements.companyId, req.companyId!),
          eq(specSubmittalRequirements.projectId, req.projectId!),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Spec submittal requirement not found");
    return rows[0];
  }

  async function fetchReference(req: FastifyRequest, referenceId: string) {
    const rows = await app.db
      .select()
      .from(specReferences)
      .where(
        and(
          eq(specReferences.id, referenceId),
          eq(specReferences.companyId, req.companyId!),
          eq(specReferences.projectId, req.projectId!),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Spec reference not found");
    return rows[0];
  }

  function ledger(
    action: "create" | "update" | "delete" | "state_change",
    objectType: string,
    objectId: string,
    req: FastifyRequest,
    payload: unknown,
    storePayload = false,
  ) {
    return appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action,
      objectType,
      objectId,
      payload,
      storePayload,
      projectId: req.projectId ?? null,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Provenance envelope                                               */
  /*                                                                   */
  /* Every requirement leaves this module wearing how it was found and */
  /* how sure the finder was. A UI that forgets to render the badge    */
  /* still cannot claim a human validated it: `humanConfirmed` is a    */
  /* fact about `confirmedBy`, not about the extractor.                */
  /* ---------------------------------------------------------------- */

  type RequirementRow = typeof specSubmittalRequirements.$inferSelect;

  function withProvenance(row: RequirementRow) {
    return {
      ...row,
      provenance: {
        extractionMethod: row.extractionMethod,
        extractionConfidence: row.extractionConfidence,
        humanConfirmed: row.confirmedBy != null,
        confirmedBy: row.confirmedBy,
        confirmedAt: row.confirmedAt,
        registered: row.registeredSubmittalId != null,
        extractor:
          (row.detail as Record<string, unknown> | null)?.["extractor"] ??
          (row.extractionMethod === "manual" ? "human" : null),
      },
    };
  }

  async function bumpSectionCounts(sectionId: string) {
    const [total] = await app.db
      .select({ n: count() })
      .from(specSubmittalRequirements)
      .where(eq(specSubmittalRequirements.sectionId, sectionId));
    const [confirmed] = await app.db
      .select({ n: count() })
      .from(specSubmittalRequirements)
      .where(
        and(
          eq(specSubmittalRequirements.sectionId, sectionId),
          inArray(specSubmittalRequirements.status, ["confirmed", "registered"]),
        ),
      );
    await app.db
      .update(specSections)
      .set({
        submittalRequirementCount: Number(total?.n ?? 0),
        requirementsConfirmed: Number(confirmed?.n ?? 0) > 0 ? 1 : 0,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(specSections.id, sectionId));
  }

  /** Section ids that appear in a given book (via their revisions). */
  async function sectionIdsForBook(bookId: string): Promise<string[]> {
    const rows = await app.db
      .selectDistinct({ sectionId: specSectionRevisions.sectionId })
      .from(specSectionRevisions)
      .where(eq(specSectionRevisions.bookId, bookId));
    return rows.map((r) => r.sectionId);
  }

  /**
   * Insert a new revision of a section with TWO-WAY supersession, or return
   * `unchanged` when the text hashes identically to the revision in force —
   * a reissue that changed nothing must be provable as such rather than
   * generating a phantom revision people then diff against.
   */
  async function insertRevision(
    req: FastifyRequest,
    section: typeof specSections.$inferSelect,
    input: {
      bookId: string;
      revision?: string | undefined;
      text: string | null;
      issuedDate: string | null;
      effectiveFrom?: string | null;
      pageStart: number | null;
      pageEnd: number | null;
      fileId: string | null;
      fileSha256: string | null;
      changeSummary?: string | null;
      issuedBy?: string | null;
    },
  ): Promise<{ revisionId: string; unchanged: boolean; revision: string }> {
    const previous = section.currentRevisionId
      ? ((
          await app.db
            .select()
            .from(specSectionRevisions)
            .where(eq(specSectionRevisions.id, section.currentRevisionId))
            .limit(1)
        )[0] ?? null)
      : null;

    const contentSha256 = input.text ? sha256Hex(input.text) : null;
    if (previous && contentSha256 && previous.contentSha256 === contentSha256) {
      return { revisionId: previous.id, unchanged: true, revision: previous.revision };
    }

    const label = input.revision ?? nextRevisionLabel(previous?.revision ?? null);
    const revisionId = newId("srev");
    const now = new Date().toISOString();
    const changedClauses =
      previous?.extractedText && input.text ? diffClauses(previous.extractedText, input.text) : [];

    await app.db.insert(specSectionRevisions).values({
      id: revisionId,
      companyId: req.companyId!,
      projectId: req.projectId!,
      sectionId: section.id,
      bookId: input.bookId,
      revision: label,
      revisionOrdinal: (previous?.revisionOrdinal ?? -1) + 1,
      issuedDate: input.issuedDate,
      effectiveFrom: input.effectiveFrom ?? input.issuedDate,
      pageStart: input.pageStart,
      pageEnd: input.pageEnd,
      fileId: input.fileId,
      fileSha256: input.fileSha256,
      extractedText: input.text,
      contentSha256,
      parts: input.text ? splitCsiParts(input.text) : {},
      changeSummary: input.changeSummary ?? null,
      changedClauses,
      supersedesRevisionId: previous?.id ?? null,
      issuedBy: input.issuedBy ?? null,
      createdBy: req.user!.id,
    });

    if (previous) {
      await app.db
        .update(specSectionRevisions)
        .set({
          isSuperseded: 1,
          supersededByRevisionId: revisionId,
          supersededAt: now,
          updatedAt: now,
        })
        .where(eq(specSectionRevisions.id, previous.id));
    }
    await app.db
      .update(specSections)
      .set({
        currentRevisionId: revisionId,
        revisionCount: section.revisionCount + 1,
        status: "current",
        updatedAt: now,
      })
      .where(eq(specSections.id, section.id));

    return { revisionId, unchanged: false, revision: label };
  }

  /** Insert extracted requirements for a revision, skipping ones already held. */
  async function extractInto(
    req: FastifyRequest,
    section: typeof specSections.$inferSelect,
    revisionId: string,
    text: string,
  ): Promise<{ created: number; skipped: number }> {
    const found = extractSubmittalRequirements(text);
    if (found.length === 0) return { created: 0, skipped: 0 };
    const existing = await app.db
      .select({
        paragraphRef: specSubmittalRequirements.paragraphRef,
        submittalType: specSubmittalRequirements.submittalType,
      })
      .from(specSubmittalRequirements)
      .where(eq(specSubmittalRequirements.sectionId, section.id));
    const seen = new Set(existing.map((e) => `${e.paragraphRef ?? ""}|${e.submittalType}`));

    let created = 0;
    let skipped = 0;
    for (const r of found) {
      const key = `${r.paragraphRef ?? ""}|${r.submittalType}`;
      if (seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      const id = newId("sreq");
      await app.db.insert(specSubmittalRequirements).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        sectionId: section.id,
        sectionRevisionId: revisionId,
        sectionCode: section.code,
        paragraphRef: r.paragraphRef,
        title: r.title,
        description: r.description,
        clauseText: r.clauseText,
        submittalType: r.submittalType,
        requiredCopies: r.requiredCopies,
        requiredBefore: r.requiredBefore,
        reviewDays: r.reviewDays,
        isDeferred: r.isDeferred ? 1 : 0,
        status: "identified",
        extractionMethod: "ai_extracted",
        extractionConfidence: r.confidence,
        detail: {
          extractor: EXTRACTOR_VERSION,
          matchedTerm: r.matchedTerm,
          articleTitle: r.articleTitle,
        },
        createdBy: req.user!.id,
      });
      await ledger("create", "spec_submittal_requirement", id, req, {
        sectionId: section.id,
        sectionCode: section.code,
        paragraphRef: r.paragraphRef,
        submittalType: r.submittalType,
        status: "identified",
        extractionMethod: "ai_extracted",
        extractionConfidence: r.confidence,
        extractor: EXTRACTOR_VERSION,
      });
      created += 1;
    }
    await bumpSectionCounts(section.id);
    return { created, skipped };
  }

  /* ================================================================ */
  /* 1. Spec books — upload, split, supersede                          */
  /* ================================================================ */

  app.post("/projects/:projectId/spec-books", { preHandler: standardGate }, async (req, reply) => {
    const mp = await req.file();
    if (!mp) throw badRequest("Expected a multipart PDF upload");
    const buf = await mp.toBuffer();
    const name =
      fieldValue(mp.fields, "name") ?? mp.filename?.replace(/\.pdf$/i, "") ?? "Specification";
    const issueLabel = fieldValue(mp.fields, "issueLabel") ?? null;
    const issuedDate = fieldValue(mp.fields, "issuedDate") ?? null;
    const issuedByOrganisation = fieldValue(mp.fields, "issuedByOrganisation") ?? null;
    const description = fieldValue(mp.fields, "description") ?? null;
    const contractId = fieldValue(mp.fields, "contractId") ?? null;
    const classificationRaw = fieldValue(mp.fields, "classificationSystem");
    const classificationSystem = SPEC_CLASSIFICATION_SYSTEMS.includes(
      classificationRaw as (typeof SPEC_CLASSIFICATION_SYSTEMS)[number],
    )
      ? (classificationRaw as (typeof SPEC_CLASSIFICATION_SYSTEMS)[number])
      : "masterformat_2020";
    const makeCurrent = boolField(mp.fields, "makeCurrent", false);
    const doExtract = boolField(mp.fields, "extractRequirements", true);

    const saved = await app.storage.saveBuffer(req.companyId!, buf);
    const fileId = newId("fil");
    await app.db.insert(files).values({
      id: fileId,
      companyId: req.companyId!,
      projectId: req.projectId!,
      folderId: null,
      name: mp.filename || `${name}.pdf`,
      contentType: mp.mimetype || "application/pdf",
      sizeBytes: saved.sizeBytes,
      sha256: saved.sha256,
      storageKey: saved.storageKey,
      metadata: { kind: "spec_book" },
      uploadedBy: req.user!.id,
    });

    const number = await nextRecordNumber(app.db, req.projectId!, "spec_book");
    const bookId = newId("sbk");
    await app.db.insert(specBooks).values({
      id: bookId,
      companyId: req.companyId!,
      projectId: req.projectId!,
      number,
      reference: `SPEC-${String(number).padStart(3, "0")}`,
      name,
      description,
      issueLabel,
      issuedDate,
      issuedByOrganisation,
      classificationSystem,
      status: "processing",
      processing: "processing",
      sourceFileId: fileId,
      sourceFileSha256: saved.sha256,
      contractId,
      createdBy: req.user!.id,
    });
    await ledger("create", "spec_book", bookId, req, {
      name,
      issueLabel,
      issuedDate,
      sha256: saved.sha256,
      sizeBytes: saved.sizeBytes,
    });

    let divisionsCreated = 0;
    let sectionsInBook = 0;
    let sectionsCreated = 0;
    let revisionsAdded = 0;
    let unchangedSections = 0;
    let requirementsExtracted = 0;
    let pageCount: number | null = null;
    let failed: string | null = null;

    try {
      const pages = await extractPdfPages(buf);
      if (pages.length === 0) throw new Error("PDF contains no pages");
      pageCount = pages.length;
      const split = splitBookPages(pages);
      sectionsInBook = split.sections.length;
      if (split.sections.length === 0) {
        throw new Error(
          "No section headings were found in this PDF — the book cannot be split. " +
            "Create sections by hand, or upload a text-bearing (non-scanned) PDF.",
        );
      }

      // Divisions: explicit DIVISION headings first, then any division a
      // section code implies, titled from MasterFormat rather than invented.
      const divisionIds = new Map<string, string>();
      const divisionCodes = new Set<string>([
        ...split.divisions.keys(),
        ...split.sections.map((s) => s.divisionCode),
      ]);
      const sortedDivisions = [...divisionCodes].sort();
      for (const [order, code] of sortedDivisions.entries()) {
        const explicit = split.divisions.get(code);
        const id = newId("sdiv");
        const sectionsIn = split.sections.filter((s) => s.divisionCode === code);
        await app.db.insert(specDivisions).values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          bookId,
          code,
          title: explicit?.title ?? divisionTitle(code) ?? `Division ${code}`,
          pageStart: explicit?.pageStart ?? sectionsIn[0]?.pageStart ?? null,
          pageEnd:
            explicit?.pageEnd ?? sectionsIn[sectionsIn.length - 1]?.pageEnd ?? null,
          sortOrder: order,
          sectionCount: sectionsIn.length,
        });
        divisionIds.set(code, id);
        divisionsCreated += 1;
      }

      for (const found of split.sections) {
        const existing = await app.db
          .select()
          .from(specSections)
          .where(
            and(
              eq(specSections.projectId, req.projectId!),
              eq(specSections.normalisedCode, found.normalisedCode),
            ),
          )
          .limit(1);

        let section = existing[0];
        if (!section) {
          const sectionId = newId("ssec");
          await app.db.insert(specSections).values({
            id: sectionId,
            companyId: req.companyId!,
            projectId: req.projectId!,
            divisionId: divisionIds.get(found.divisionCode) ?? null,
            code: found.code,
            normalisedCode: found.normalisedCode,
            title: found.title,
            divisionCode: found.divisionCode,
            status: "current",
            detail: { headingConfidence: found.confidence, extractor: EXTRACTOR_VERSION },
            createdBy: req.user!.id,
          });
          sectionsCreated += 1;
          await ledger("create", "spec_section", sectionId, req, {
            code: found.code,
            title: found.title,
            bookId,
            headingConfidence: found.confidence,
          });
          section = (
            await app.db.select().from(specSections).where(eq(specSections.id, sectionId)).limit(1)
          )[0]!;
        } else {
          await app.db
            .update(specSections)
            .set({
              divisionId: divisionIds.get(found.divisionCode) ?? section.divisionId,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(specSections.id, section.id));
        }

        const result = await insertRevision(req, section, {
          bookId,
          text: found.text,
          issuedDate,
          pageStart: found.pageStart,
          pageEnd: found.pageEnd,
          fileId,
          fileSha256: saved.sha256,
          issuedBy: issuedByOrganisation,
          changeSummary: issueLabel ? `Issued with ${issueLabel}` : null,
        });
        if (result.unchanged) {
          unchangedSections += 1;
          continue;
        }
        revisionsAdded += 1;
        await ledger("create", "spec_section_revision", result.revisionId, req, {
          sectionId: section.id,
          code: found.code,
          revision: result.revision,
          bookId,
          pageStart: found.pageStart,
          pageEnd: found.pageEnd,
        });

        if (doExtract) {
          const reloaded = (
            await app.db.select().from(specSections).where(eq(specSections.id, section.id)).limit(1)
          )[0]!;
          const extracted = await extractInto(req, reloaded, result.revisionId, found.text);
          requirementsExtracted += extracted.created;
        }
      }
    } catch (err) {
      failed = err instanceof Error ? err.message : "Spec book processing failed";
    }

    const now = new Date().toISOString();
    await app.db
      .update(specBooks)
      .set({
        processing: failed ? "failed" : "ready",
        processingError: failed,
        status: failed ? "failed" : "draft",
        pageCount,
        divisionCount: divisionsCreated,
        sectionCount: sectionsInBook,
        updatedAt: now,
      })
      .where(eq(specBooks.id, bookId));
    await ledger("state_change", "spec_book", bookId, req, {
      processing: failed ? "failed" : "ready",
      error: failed,
      divisionsCreated,
      sectionsCreated,
      revisionsAdded,
      unchangedSections,
      requirementsExtracted,
    });

    if (!failed && makeCurrent) await promoteBookToCurrent(req, bookId);

    const [book] = await app.db.select().from(specBooks).where(eq(specBooks.id, bookId)).limit(1);
    return reply.status(201).send({
      ...book,
      divisionsCreated,
      sectionsInBook,
      sectionsCreated,
      revisionsAdded,
      unchangedSections,
      requirementsExtracted,
      /* Extraction is a machine reading: nothing here is confirmed. */
      requirementsConfirmed: 0,
      error: failed,
    });
  });

  /** Two-way book supersession: exactly one current book drives the build. */
  async function promoteBookToCurrent(req: FastifyRequest, bookId: string) {
    const now = new Date().toISOString();
    const previous = await app.db
      .select()
      .from(specBooks)
      .where(
        and(
          eq(specBooks.companyId, req.companyId!),
          eq(specBooks.projectId, req.projectId!),
          eq(specBooks.isCurrent, 1),
          ne(specBooks.id, bookId),
        ),
      );
    for (const p of previous) {
      await app.db
        .update(specBooks)
        .set({
          isCurrent: 0,
          status: "superseded",
          supersededById: bookId,
          updatedAt: now,
        })
        .where(eq(specBooks.id, p.id));
      await ledger("state_change", "spec_book", p.id, req, {
        status: "superseded",
        supersededById: bookId,
      });
    }
    await app.db
      .update(specBooks)
      .set({
        isCurrent: 1,
        status: "current",
        // Only written when this promotion actually displaced something: a
        // re-promotion must not erase the issue this book originally replaced.
        ...(previous[0] ? { supersedesId: previous[0].id } : {}),
        updatedAt: now,
      })
      .where(eq(specBooks.id, bookId));
    await ledger("state_change", "spec_book", bookId, req, {
      status: "current",
      isCurrent: 1,
      supersedesId: previous[0]?.id ?? null,
    });
  }

  app.get("/projects/:projectId/spec-books", { preHandler: readGate }, async (req) => {
    const q = booksListQuery.parse(req.query);
    const where = and(
      eq(specBooks.companyId, req.companyId!),
      eq(specBooks.projectId, req.projectId!),
      q.status ? eq(specBooks.status, q.status) : undefined,
      q.processing ? eq(specBooks.processing, q.processing) : undefined,
      q.search ? ilike(specBooks.name, `%${q.search}%`) : undefined,
    );
    const [totalRow] = await app.db.select({ n: count() }).from(specBooks).where(where);
    const items = await app.db
      .select()
      .from(specBooks)
      .where(where)
      .orderBy(desc(specBooks.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/spec-books/:bookId", { preHandler: readGate }, async (req) => {
    const { bookId } = req.params as { bookId: string };
    const book = await fetchBook(req, bookId);
    const divisions = await app.db
      .select()
      .from(specDivisions)
      .where(eq(specDivisions.bookId, bookId))
      .orderBy(asc(specDivisions.sortOrder));
    const sectionIds = await sectionIdsForBook(bookId);
    const sections = sectionIds.length
      ? await app.db
          .select()
          .from(specSections)
          .where(inArray(specSections.id, sectionIds))
          .orderBy(asc(specSections.code))
      : [];
    return { ...book, divisions, sections };
  });

  app.patch("/projects/:projectId/spec-books/:bookId", { preHandler: standardGate }, async (req) => {
    const { bookId } = req.params as { bookId: string };
    const body = bookPatchSchema.parse(req.body);
    const book = await fetchBook(req, bookId);
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const [k, v] of Object.entries(body)) if (v !== undefined) set[k] = v;
    if (Object.keys(set).length === 1) return book;
    await app.db.update(specBooks).set(set).where(eq(specBooks.id, bookId));
    await ledger("update", "spec_book", bookId, req, { changed: Object.keys(body) });
    return fetchBook(req, bookId);
  });

  /**
   * Acceptance of an issue is a SECOND act by a second person: the uploader
   * asserts "this is the book we were sent", the accepter asserts "this is
   * the book we are building to". Collapsing the two removes the only check
   * that catches an issue nobody actually read.
   */
  app.post(
    "/projects/:projectId/spec-books/:bookId/accept",
    { preHandler: standardGate },
    async (req) => {
      const { bookId } = req.params as { bookId: string };
      const book = await fetchBook(req, bookId);
      if (book.createdBy === req.user!.id) {
        throw forbidden(
          "The person who uploaded a spec book may not accept it. Acceptance is an " +
            "independent act: ask a second person on the project to accept this issue.",
        );
      }
      if (book.acceptedBy) throw conflict("This spec book has already been accepted");
      if (book.processing !== "ready") {
        throw badRequest(`A book whose processing is "${book.processing}" cannot be accepted`);
      }
      const now = new Date().toISOString();
      await app.db
        .update(specBooks)
        .set({ acceptedBy: req.user!.id, acceptedAt: now, updatedAt: now })
        .where(eq(specBooks.id, bookId));
      await ledger("state_change", "spec_book", bookId, req, {
        acceptedBy: req.user!.id,
        uploadedBy: book.createdBy,
      });
      return fetchBook(req, bookId);
    },
  );

  app.post(
    "/projects/:projectId/spec-books/:bookId/set-current",
    { preHandler: adminGate },
    async (req) => {
      const { bookId } = req.params as { bookId: string };
      const book = await fetchBook(req, bookId);
      if (book.processing !== "ready") {
        throw badRequest("Only a fully processed book can become the current issue");
      }
      await promoteBookToCurrent(req, bookId);
      return fetchBook(req, bookId);
    },
  );

  app.get(
    "/projects/:projectId/spec-books/:bookId/pdf",
    { preHandler: readGate },
    async (req, reply) => {
      const { bookId } = req.params as { bookId: string };
      const book = await fetchBook(req, bookId);
      if (!book.sourceFileId) throw notFound("This spec book has no source PDF");
      const [f] = await app.db
        .select()
        .from(files)
        .where(and(eq(files.id, book.sourceFileId), eq(files.companyId, req.companyId!)))
        .limit(1);
      if (!f) throw notFound("Source file not found");
      return reply
        .header("content-type", f.contentType || "application/pdf")
        .header("content-disposition", `inline; filename="${f.name}"`)
        .header("x-content-sha256", f.sha256)
        .send(app.storage.readStream(f.storageKey));
    },
  );

  app.get("/projects/:projectId/spec-divisions", { preHandler: readGate }, async (req) => {
    const q = z.object({ bookId: z.string().max(64).optional() }).parse(req.query);
    const items = await app.db
      .select()
      .from(specDivisions)
      .where(
        and(
          eq(specDivisions.companyId, req.companyId!),
          eq(specDivisions.projectId, req.projectId!),
          q.bookId ? eq(specDivisions.bookId, q.bookId) : undefined,
        ),
      )
      .orderBy(asc(specDivisions.code));
    return { items, total: items.length };
  });

  /* ================================================================ */
  /* 2. Sections and revisions                                         */
  /* ================================================================ */

  app.post("/projects/:projectId/spec-sections", { preHandler: standardGate }, async (req, reply) => {
    const body = sectionCreateSchema.parse(req.body);
    const normalisedCode = normaliseSectionCode(body.code);
    const clash = await app.db
      .select({ id: specSections.id })
      .from(specSections)
      .where(
        and(
          eq(specSections.projectId, req.projectId!),
          eq(specSections.normalisedCode, normalisedCode),
        ),
      )
      .limit(1);
    if (clash[0]) {
      throw conflict(
        `Section ${body.code} already exists on this project — add a revision to it instead`,
      );
    }
    if (body.text && !body.bookId) {
      throw badRequest(
        "A section revision must be attributed to an issue — pass bookId with the text so " +
          "the revision can be traced back to the book it was issued in.",
      );
    }
    const id = newId("ssec");
    await app.db.insert(specSections).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      divisionId: body.divisionId ?? null,
      code: body.code.trim(),
      normalisedCode,
      title: body.title,
      divisionCode: body.divisionCode ?? normalisedCode.slice(0, 2),
      status: "current",
      tradeCode: body.tradeCode ?? null,
      responsibleVendorId: body.responsibleVendorId ?? null,
      responsibleUserId: body.responsibleUserId ?? null,
      detail: { source: "manual" },
      createdBy: req.user!.id,
    });
    await ledger("create", "spec_section", id, req, { code: body.code, title: body.title });

    if (body.text) {
      const section = (
        await app.db.select().from(specSections).where(eq(specSections.id, id)).limit(1)
      )[0]!;
      const result = await insertRevision(req, section, {
        bookId: body.bookId!,
        revision: body.revision ?? "0",
        text: body.text,
        issuedDate: body.issuedDate ?? null,
        pageStart: null,
        pageEnd: null,
        fileId: null,
        fileSha256: null,
      });
      await ledger("create", "spec_section_revision", result.revisionId, req, {
        sectionId: id,
        revision: result.revision,
        source: "manual",
      });
    }
    const [row] = await app.db.select().from(specSections).where(eq(specSections.id, id)).limit(1);
    return reply.status(201).send(row);
  });

  app.get("/projects/:projectId/spec-sections", { preHandler: readGate }, async (req) => {
    const q = sectionsListQuery.parse(req.query);
    const bookSectionIds = q.bookId ? await sectionIdsForBook(q.bookId) : null;
    if (bookSectionIds && bookSectionIds.length === 0) return paginate([], 0, q);
    const where = and(
      eq(specSections.companyId, req.companyId!),
      eq(specSections.projectId, req.projectId!),
      q.status ? eq(specSections.status, q.status) : undefined,
      q.divisionCode ? eq(specSections.divisionCode, q.divisionCode) : undefined,
      q.code ? eq(specSections.normalisedCode, normaliseSectionCode(q.code)) : undefined,
      q.search ? ilike(specSections.title, `%${q.search}%`) : undefined,
      q.requirementsConfirmed
        ? eq(specSections.requirementsConfirmed, Number(q.requirementsConfirmed))
        : undefined,
      bookSectionIds ? inArray(specSections.id, bookSectionIds) : undefined,
    );
    const [totalRow] = await app.db.select({ n: count() }).from(specSections).where(where);
    const items = await app.db
      .select()
      .from(specSections)
      .where(where)
      .orderBy(asc(specSections.code))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get(
    "/projects/:projectId/spec-sections/:sectionId",
    { preHandler: readGate },
    async (req) => {
      const { sectionId } = req.params as { sectionId: string };
      const section = await fetchSection(req, sectionId);
      const revisions = await app.db
        .select()
        .from(specSectionRevisions)
        .where(eq(specSectionRevisions.sectionId, sectionId))
        .orderBy(desc(specSectionRevisions.revisionOrdinal));
      const requirements = await app.db
        .select()
        .from(specSubmittalRequirements)
        .where(eq(specSubmittalRequirements.sectionId, sectionId))
        .orderBy(asc(specSubmittalRequirements.paragraphRef));
      const references = await app.db
        .select()
        .from(specReferences)
        .where(eq(specReferences.sectionId, sectionId))
        .orderBy(desc(specReferences.createdAt));
      const division = section.divisionId
        ? ((
            await app.db
              .select()
              .from(specDivisions)
              .where(eq(specDivisions.id, section.divisionId))
              .limit(1)
          )[0] ?? null)
        : null;
      return {
        ...section,
        division,
        currentRevision: revisions.find((r) => r.id === section.currentRevisionId) ?? null,
        revisions,
        requirements: requirements.map(withProvenance),
        references,
      };
    },
  );

  app.patch(
    "/projects/:projectId/spec-sections/:sectionId",
    { preHandler: standardGate },
    async (req) => {
      const { sectionId } = req.params as { sectionId: string };
      const body = sectionPatchSchema.parse(req.body);
      await fetchSection(req, sectionId);
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const [k, v] of Object.entries(body)) if (v !== undefined) set[k] = v;
      await app.db.update(specSections).set(set).where(eq(specSections.id, sectionId));
      await ledger("update", "spec_section", sectionId, req, { changed: Object.keys(body) });
      return fetchSection(req, sectionId);
    },
  );

  app.post(
    "/projects/:projectId/spec-sections/:sectionId/revisions",
    { preHandler: standardGate },
    async (req, reply) => {
      const { sectionId } = req.params as { sectionId: string };
      const body = revisionCreateSchema.parse(req.body);
      const section = await fetchSection(req, sectionId);
      const result = await insertRevision(req, section, {
        bookId: body.bookId,
        revision: body.revision,
        text: body.text ?? null,
        issuedDate: body.issuedDate ?? null,
        effectiveFrom: body.effectiveFrom ?? null,
        pageStart: body.pageStart ?? null,
        pageEnd: body.pageEnd ?? null,
        fileId: body.fileId ?? null,
        fileSha256: null,
        changeSummary: body.changeSummary ?? null,
        issuedBy: body.issuedBy ?? null,
      });
      const [row] = await app.db
        .select()
        .from(specSectionRevisions)
        .where(eq(specSectionRevisions.id, result.revisionId))
        .limit(1);
      if (result.unchanged) {
        // Provable non-change: identical text hashes to the same content id.
        return reply.status(200).send({
          ...row,
          unchanged: true,
          reason:
            "The submitted text is byte-identical to the revision in force; no new " +
            "revision was created and the current revision still stands.",
        });
      }
      await ledger("create", "spec_section_revision", result.revisionId, req, {
        sectionId,
        revision: result.revision,
        bookId: body.bookId,
      });
      return reply.status(201).send({ ...row, unchanged: false });
    },
  );

  app.get(
    "/projects/:projectId/spec-sections/:sectionId/revisions",
    { preHandler: readGate },
    async (req) => {
      const { sectionId } = req.params as { sectionId: string };
      await fetchSection(req, sectionId);
      const items = await app.db
        .select()
        .from(specSectionRevisions)
        .where(eq(specSectionRevisions.sectionId, sectionId))
        .orderBy(desc(specSectionRevisions.revisionOrdinal));
      return { items, total: items.length };
    },
  );

  app.get("/projects/:projectId/spec-revisions/:revisionId", { preHandler: readGate }, async (req) => {
    const { revisionId } = req.params as { revisionId: string };
    return fetchRevision(req, revisionId);
  });

  app.post(
    "/projects/:projectId/spec-revisions/:revisionId/accept",
    { preHandler: standardGate },
    async (req) => {
      const { revisionId } = req.params as { revisionId: string };
      const revision = await fetchRevision(req, revisionId);
      if (revision.createdBy === req.user!.id) {
        throw forbidden(
          "The person who loaded a section revision may not accept it — acceptance of a " +
            "reissue is an independent act.",
        );
      }
      if (revision.acceptedBy) throw conflict("This revision has already been accepted");
      const now = new Date().toISOString();
      await app.db
        .update(specSectionRevisions)
        .set({ acceptedBy: req.user!.id, acceptedAt: now, updatedAt: now })
        .where(eq(specSectionRevisions.id, revisionId));
      await ledger("state_change", "spec_section_revision", revisionId, req, {
        acceptedBy: req.user!.id,
        loadedBy: revision.createdBy,
      });
      return fetchRevision(req, revisionId);
    },
  );

  /* ================================================================ */
  /* 3. Submittal requirements — identified → confirmed → registered   */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/spec-sections/:sectionId/extract-requirements",
    { preHandler: standardGate },
    async (req) => {
      const { sectionId } = req.params as { sectionId: string };
      const section = await fetchSection(req, sectionId);
      const revisionId = section.currentRevisionId;
      if (!revisionId) throw badRequest("This section has no revision to read");
      const revision = await fetchRevision(req, revisionId);
      if (!revision.extractedText) {
        throw badRequest(
          "The current revision holds no extracted text — nothing can be read out of it. " +
            "Upload a text-bearing PDF or add the section text by hand.",
        );
      }
      const result = await extractInto(req, section, revisionId, revision.extractedText);
      const items = await app.db
        .select()
        .from(specSubmittalRequirements)
        .where(eq(specSubmittalRequirements.sectionId, sectionId))
        .orderBy(asc(specSubmittalRequirements.paragraphRef));
      return {
        sectionId,
        sectionCode: section.code,
        revisionId,
        extractor: EXTRACTOR_VERSION,
        extractionMethod: "ai_extracted" as const,
        created: result.created,
        skippedAlreadyHeld: result.skipped,
        /* Nothing here is confirmed: a machine read it, no human agreed yet. */
        confirmedByThisCall: 0,
        items: items.map(withProvenance),
      };
    },
  );

  app.post(
    "/projects/:projectId/spec-sections/:sectionId/requirements",
    { preHandler: standardGate },
    async (req, reply) => {
      const { sectionId } = req.params as { sectionId: string };
      const body = requirementCreateSchema.parse(req.body);
      const section = await fetchSection(req, sectionId);
      const id = newId("sreq");
      await app.db.insert(specSubmittalRequirements).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        sectionId,
        sectionRevisionId: body.sectionRevisionId ?? section.currentRevisionId ?? null,
        sectionCode: section.code,
        paragraphRef: body.paragraphRef ?? null,
        title: body.title,
        description: body.description ?? null,
        clauseText: body.clauseText ?? null,
        submittalType: body.submittalType ?? "other",
        requiredCopies: body.requiredCopies ?? null,
        requiredBefore: body.requiredBefore ?? null,
        leadTimeDays: body.leadTimeDays ?? null,
        reviewDays: body.reviewDays ?? null,
        isDeferred: body.isDeferred ? 1 : 0,
        status: "identified",
        // A human typed it, so there is no confidence to report: a number here
        // would imply a measurement that was never taken.
        extractionMethod: "manual",
        extractionConfidence: null,
        responsibleVendorId: body.responsibleVendorId ?? null,
        commitmentId: body.commitmentId ?? null,
        bidPackageId: body.bidPackageId ?? null,
        detail: { extractor: "human" },
        createdBy: req.user!.id,
      });
      await bumpSectionCounts(sectionId);
      await ledger("create", "spec_submittal_requirement", id, req, {
        sectionId,
        sectionCode: section.code,
        title: body.title,
        extractionMethod: "manual",
      });
      const row = await fetchRequirement(req, id);
      return reply.status(201).send(withProvenance(row));
    },
  );

  app.get("/projects/:projectId/spec-requirements", { preHandler: readGate }, async (req) => {
    const q = requirementsListQuery.parse(req.query);
    const bookSectionIds = q.bookId ? await sectionIdsForBook(q.bookId) : null;
    if (bookSectionIds && bookSectionIds.length === 0) return paginate([], 0, q);
    const where = and(
      eq(specSubmittalRequirements.companyId, req.companyId!),
      eq(specSubmittalRequirements.projectId, req.projectId!),
      q.status ? eq(specSubmittalRequirements.status, q.status) : undefined,
      q.sectionId ? eq(specSubmittalRequirements.sectionId, q.sectionId) : undefined,
      q.submittalType ? eq(specSubmittalRequirements.submittalType, q.submittalType) : undefined,
      q.extractionMethod
        ? eq(specSubmittalRequirements.extractionMethod, q.extractionMethod)
        : undefined,
      q.registered === "1" ? isNotNull(specSubmittalRequirements.registeredSubmittalId) : undefined,
      q.registered === "0" ? isNull(specSubmittalRequirements.registeredSubmittalId) : undefined,
      bookSectionIds ? inArray(specSubmittalRequirements.sectionId, bookSectionIds) : undefined,
    );
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(specSubmittalRequirements)
      .where(where);
    let items = await app.db
      .select()
      .from(specSubmittalRequirements)
      .where(where)
      .orderBy(asc(specSubmittalRequirements.sectionCode), asc(specSubmittalRequirements.paragraphRef))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    let total = Number(totalRow?.n ?? 0);
    if (q.minConfidence !== undefined) {
      // Confidence filtering is applied after paging deliberately: it is a
      // review aid, and silently re-paginating would hide rows that exist.
      const min = q.minConfidence;
      items = items.filter((r) => (r.extractionConfidence ?? 1) >= min);
      total = items.length;
    }
    return paginate(items.map(withProvenance), total, q);
  });

  app.get(
    "/projects/:projectId/spec-requirements/:requirementId",
    { preHandler: readGate },
    async (req) => {
      const { requirementId } = req.params as { requirementId: string };
      const row = await fetchRequirement(req, requirementId);
      const submittal = row.registeredSubmittalId
        ? ((
            await app.db
              .select()
              .from(submittals)
              .where(eq(submittals.id, row.registeredSubmittalId))
              .limit(1)
          )[0] ?? null)
        : null;
      return { ...withProvenance(row), registeredSubmittal: submittal };
    },
  );

  app.patch(
    "/projects/:projectId/spec-requirements/:requirementId",
    { preHandler: standardGate },
    async (req) => {
      const { requirementId } = req.params as { requirementId: string };
      const body = requirementPatchSchema.parse(req.body);
      const row = await fetchRequirement(req, requirementId);
      if (row.status === "registered") {
        throw badRequest(
          "A registered requirement is frozen — the submittal it produced is the live record now",
        );
      }
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        set[k] = k === "isDeferred" ? (v ? 1 : 0) : v;
      }
      await app.db
        .update(specSubmittalRequirements)
        .set(set)
        .where(eq(specSubmittalRequirements.id, requirementId));
      await ledger("update", "spec_submittal_requirement", requirementId, req, {
        changed: Object.keys(body),
      });
      return withProvenance(await fetchRequirement(req, requirementId));
    },
  );

  /**
   * The human step. `confirmedBy` is the assertion "I read the clause and this
   * requirement is real" — which is worth nothing if it is made by the same
   * person who ran the extractor or typed the row.
   */
  app.post(
    "/projects/:projectId/spec-requirements/:requirementId/confirm",
    { preHandler: standardGate },
    async (req) => {
      const { requirementId } = req.params as { requirementId: string };
      const body = z
        .object({ note: z.string().max(2000).optional() })
        .parse(req.body ?? {});
      const row = await fetchRequirement(req, requirementId);
      if (row.status === "registered") throw conflict("This requirement is already registered");
      if (row.status === "confirmed") throw conflict("This requirement is already confirmed");
      if (row.status === "not_required" || row.status === "superseded") {
        throw badRequest(`A ${row.status} requirement cannot be confirmed`);
      }
      if (row.createdBy === req.user!.id) {
        throw forbidden(
          "The person who extracted or typed a requirement may not confirm it. Confirmation " +
            "is the independent human check that separates a machine reading from an " +
            "agreed register entry — ask a colleague to confirm it.",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(specSubmittalRequirements)
        .set({
          status: "confirmed",
          confirmedBy: req.user!.id,
          confirmedAt: now,
          detail: {
            ...((row.detail as Record<string, unknown>) ?? {}),
            ...(body.note ? { confirmationNote: body.note } : {}),
          },
          updatedAt: now,
        })
        .where(eq(specSubmittalRequirements.id, requirementId));
      await bumpSectionCounts(row.sectionId);
      await ledger("state_change", "spec_submittal_requirement", requirementId, req, {
        from: row.status,
        to: "confirmed",
        confirmedBy: req.user!.id,
        extractedBy: row.createdBy,
        extractionMethod: row.extractionMethod,
        extractionConfidence: row.extractionConfidence,
      });
      return withProvenance(await fetchRequirement(req, requirementId));
    },
  );

  app.post(
    "/projects/:projectId/spec-requirements/:requirementId/not-required",
    { preHandler: standardGate },
    async (req) => {
      const { requirementId } = req.params as { requirementId: string };
      const body = z.object({ reason: z.string().min(1).max(2000) }).parse(req.body);
      const row = await fetchRequirement(req, requirementId);
      if (row.status === "registered") {
        throw badRequest("A registered requirement cannot be marked not required");
      }
      const now = new Date().toISOString();
      await app.db
        .update(specSubmittalRequirements)
        .set({ status: "not_required", notRequiredReason: body.reason, updatedAt: now })
        .where(eq(specSubmittalRequirements.id, requirementId));
      await bumpSectionCounts(row.sectionId);
      await ledger("state_change", "spec_submittal_requirement", requirementId, req, {
        from: row.status,
        to: "not_required",
        reason: body.reason,
      });
      return withProvenance(await fetchRequirement(req, requirementId));
    },
  );

  /** Build one register row: the requirement becomes a real submittal. */
  async function registerRequirement(
    req: FastifyRequest,
    row: RequirementRow,
    overrides: z.infer<typeof registerSchema>,
  ) {
    const number = await nextRecordNumber(app.db, req.projectId!, "submittal");
    const submittalId = newId("sub");
    const leadTimeDays = overrides.leadTimeDays ?? row.leadTimeDays ?? null;
    const requiredOnSite = overrides.requiredOnSite ?? null;
    const reviewDays = row.reviewDays ?? DEFAULT_REVIEW_ALLOWANCE_DAYS;
    const submitByDate = requiredOnSite
      ? addDaysISO(requiredOnSite, -((leadTimeDays ?? 0) + reviewDays))
      : null;
    await app.db.insert(submittals).values({
      id: submittalId,
      companyId: req.companyId!,
      projectId: req.projectId!,
      number,
      revision: 0,
      title: overrides.title ?? row.title,
      specSection: row.sectionCode,
      submittalType: row.submittalType,
      status: "draft",
      ballInCourtId: overrides.ballInCourtId ?? null,
      requiredOnSite,
      leadTimeDays,
      submitByDate,
      fileIds: [],
      createdBy: req.user!.id,
    });
    const now = new Date().toISOString();
    await app.db
      .update(specSubmittalRequirements)
      .set({
        status: "registered",
        registeredSubmittalId: submittalId,
        registeredAt: now,
        registeredBy: req.user!.id,
        updatedAt: now,
      })
      .where(eq(specSubmittalRequirements.id, row.id));
    await bumpSectionCounts(row.sectionId);
    await ledger("create", "submittal", submittalId, req, {
      number,
      title: overrides.title ?? row.title,
      specSection: row.sectionCode,
      builtFromRequirementId: row.id,
      paragraphRef: row.paragraphRef,
      extractionMethod: row.extractionMethod,
      extractionConfidence: row.extractionConfidence,
      confirmedBy: row.confirmedBy,
    });
    await ledger("state_change", "spec_submittal_requirement", row.id, req, {
      from: "confirmed",
      to: "registered",
      registeredSubmittalId: submittalId,
      registeredBy: req.user!.id,
    });
    const [submittal] = await app.db
      .select()
      .from(submittals)
      .where(eq(submittals.id, submittalId))
      .limit(1);
    return submittal!;
  }

  /**
   * REGISTER: the confirmed requirement becomes a real `submittals` row.
   *
   * `identified` is refused outright. There is no override, no `force`, no
   * admin bypass: the whole value of the register being built from the spec
   * is that a human agreed each row belongs in it.
   */
  app.post(
    "/projects/:projectId/spec-requirements/:requirementId/register",
    { preHandler: standardGate },
    async (req, reply) => {
      const { requirementId } = req.params as { requirementId: string };
      const body = registerSchema.parse(req.body ?? {});
      const row = await fetchRequirement(req, requirementId);
      if (row.status === "registered") {
        throw conflict(
          `This requirement was already registered as submittal ${row.registeredSubmittalId}`,
        );
      }
      if (row.status !== "confirmed") {
        throw badRequest(
          `A requirement must be confirmed by a human before it can be registered as a ` +
            `submittal (this one is "${row.status}"). Confirm it first — registration never ` +
            `promotes an unconfirmed reading.`,
        );
      }
      const submittal = await registerRequirement(req, row, body);
      return reply.status(201).send({
        requirement: withProvenance(await fetchRequirement(req, requirementId)),
        submittal,
      });
    },
  );

  /**
   * BUILD THE REGISTER for a whole book. Registers every CONFIRMED
   * requirement and reports — item by item — everything it refused to touch.
   * It never confirms on the caller's behalf.
   */
  app.post(
    "/projects/:projectId/spec-books/:bookId/build-register",
    { preHandler: standardGate },
    async (req) => {
      const { bookId } = req.params as { bookId: string };
      const book = await fetchBook(req, bookId);
      const sectionIds = await sectionIdsForBook(bookId);
      if (sectionIds.length === 0) {
        return {
          bookId,
          registered: [],
          skipped: [],
          registeredCount: 0,
          skippedCount: 0,
          reasons: ["This book has no sections — there is nothing to build a register from."],
        };
      }
      const rows = await app.db
        .select()
        .from(specSubmittalRequirements)
        .where(
          and(
            eq(specSubmittalRequirements.projectId, req.projectId!),
            inArray(specSubmittalRequirements.sectionId, sectionIds),
          ),
        )
        .orderBy(asc(specSubmittalRequirements.sectionCode));

      const registered: { requirementId: string; submittalId: string; sectionCode: string }[] = [];
      const skipped: {
        requirementId: string;
        sectionCode: string;
        status: string;
        reason: string;
      }[] = [];
      for (const row of rows) {
        if (row.status === "confirmed") {
          const submittal = await registerRequirement(req, row, {});
          registered.push({
            requirementId: row.id,
            submittalId: submittal.id,
            sectionCode: row.sectionCode,
          });
          continue;
        }
        skipped.push({
          requirementId: row.id,
          sectionCode: row.sectionCode,
          status: row.status,
          reason:
            row.status === "identified"
              ? "Extracted but not yet confirmed by a human — confirm it before registering."
              : row.status === "registered"
                ? "Already registered."
                : `Status is "${row.status}".`,
        });
      }

      const now = new Date().toISOString();
      await app.db
        .update(specBooks)
        .set({ registerBuiltAt: now, registerBuiltBy: req.user!.id, updatedAt: now })
        .where(eq(specBooks.id, bookId));
      await ledger("state_change", "spec_book", bookId, req, {
        registerBuilt: true,
        registeredCount: registered.length,
        skippedCount: skipped.length,
      });
      return {
        bookId,
        bookReference: book.reference,
        registeredCount: registered.length,
        skippedCount: skipped.length,
        registered,
        skipped,
        reasons: [],
      };
    },
  );

  /* ================================================================ */
  /* 4. Cross-references and conflicts                                 */
  /* ================================================================ */

  async function assertTargetExists(
    req: FastifyRequest,
    targetType: string,
    targetId: string,
  ): Promise<string | null> {
    if (targetType === "spec_section") {
      const [row] = await app.db
        .select({ code: specSections.code, title: specSections.title })
        .from(specSections)
        .where(
          and(eq(specSections.id, targetId), eq(specSections.projectId, req.projectId!)),
        )
        .limit(1);
      if (!row) throw notFound("Target spec section not found on this project");
      return `${row.code} ${row.title}`;
    }
    if (targetType === "drawing_sheet") {
      const [row] = await app.db
        .select({ number: drawingSheets.number, title: drawingSheets.title })
        .from(drawingSheets)
        .where(
          and(eq(drawingSheets.id, targetId), eq(drawingSheets.projectId, req.projectId!)),
        )
        .limit(1);
      if (!row) throw notFound("Target drawing sheet not found on this project");
      return `${row.number} ${row.title}`;
    }
    if (targetType === "rfi") {
      const [row] = await app.db
        .select({ number: rfis.number, subject: rfis.subject })
        .from(rfis)
        .where(and(eq(rfis.id, targetId), eq(rfis.projectId, req.projectId!)))
        .limit(1);
      if (!row) throw notFound("Target RFI not found on this project");
      return `RFI-${String(row.number).padStart(3, "0")} ${row.subject}`;
    }
    if (targetType === "submittal") {
      const [row] = await app.db
        .select({ number: submittals.number, title: submittals.title })
        .from(submittals)
        .where(and(eq(submittals.id, targetId), eq(submittals.projectId, req.projectId!)))
        .limit(1);
      if (!row) throw notFound("Target submittal not found on this project");
      return `SUB-${String(row.number).padStart(3, "0")} ${row.title}`;
    }
    // documents / change events / bid packages are owned by other modules;
    // the label the caller supplies is taken at face value and marked as such.
    return null;
  }

  app.post(
    "/projects/:projectId/spec-sections/:sectionId/references",
    { preHandler: standardGate },
    async (req, reply) => {
      const { sectionId } = req.params as { sectionId: string };
      const body = referenceCreateSchema.parse(req.body);
      const section = await fetchSection(req, sectionId);
      if (body.targetType === "spec_section" && body.targetId === sectionId) {
        throw badRequest("A section cannot reference itself");
      }
      const resolvedLabel = await assertTargetExists(req, body.targetType, body.targetId);
      const id = newId("sref");
      await app.db.insert(specReferences).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        sectionId,
        sectionRevisionId: body.sectionRevisionId ?? section.currentRevisionId ?? null,
        paragraphRef: body.paragraphRef ?? null,
        pageIndex: body.pageIndex ?? null,
        targetType: body.targetType,
        targetId: body.targetId,
        targetLabel: resolvedLabel ?? body.targetLabel ?? null,
        referenceKind: body.referenceKind ?? "referenced_by",
        note: body.note ?? null,
        extractionMethod: "manual",
        extractionConfidence: null,
        detail: { labelVerified: resolvedLabel != null },
        createdBy: req.user!.id,
      });
      await ledger("create", "spec_reference", id, req, {
        sectionId,
        sectionCode: section.code,
        targetType: body.targetType,
        targetId: body.targetId,
        referenceKind: body.referenceKind ?? "referenced_by",
        paragraphRef: body.paragraphRef ?? null,
      });
      const row = await fetchReference(req, id);
      return reply.status(201).send(row);
    },
  );

  /**
   * Unresolved conflicts. A `conflicts_with` reference between a clause and a
   * drawing is where a change order comes from: it says the contract
   * documents disagree at a named paragraph, on a named sheet, from a named
   * date. Registered before `/:referenceId` so the static segment wins.
   */
  app.get(
    "/projects/:projectId/spec-references/conflicts",
    { preHandler: readGate },
    async (req) => {
      const q = z
        .object({ includeResolved: z.enum(["0", "1"]).default("0") })
        .parse(req.query ?? {});
      const includeResolved = q.includeResolved === "1";
      const rows = await app.db
        .select()
        .from(specReferences)
        .where(
          and(
            eq(specReferences.companyId, req.companyId!),
            eq(specReferences.projectId, req.projectId!),
            eq(specReferences.referenceKind, "conflicts_with"),
            includeResolved ? undefined : isNull(specReferences.resolvedAt),
          ),
        )
        .orderBy(asc(specReferences.createdAt));
      const sectionIds = [...new Set(rows.map((r) => r.sectionId))];
      const sections = sectionIds.length
        ? await app.db
            .select({
              id: specSections.id,
              code: specSections.code,
              title: specSections.title,
            })
            .from(specSections)
            .where(inArray(specSections.id, sectionIds))
        : [];
      const byId = new Map(sections.map((s) => [s.id, s] as const));
      const items = rows.map((r) => ({
        ...r,
        section: byId.get(r.sectionId) ?? null,
        ageDays: Math.floor((Date.now() - Date.parse(r.createdAt)) / 86_400_000),
      }));
      return {
        items,
        total: items.length,
        unresolved: items.filter((i) => i.resolvedAt == null).length,
        note:
          "A conflicts_with reference is a change-order origin: the documents disagree at " +
          "this paragraph. Resolve it with the RFI answer or addendum that settled it.",
      };
    },
  );

  app.get("/projects/:projectId/spec-references", { preHandler: readGate }, async (req) => {
    const q = referencesListQuery.parse(req.query);
    const where = and(
      eq(specReferences.companyId, req.companyId!),
      eq(specReferences.projectId, req.projectId!),
      q.referenceKind ? eq(specReferences.referenceKind, q.referenceKind) : undefined,
      q.targetType ? eq(specReferences.targetType, q.targetType) : undefined,
      q.sectionId ? eq(specReferences.sectionId, q.sectionId) : undefined,
      q.resolved === "1" ? isNotNull(specReferences.resolvedAt) : undefined,
      q.resolved === "0" ? isNull(specReferences.resolvedAt) : undefined,
    );
    const [totalRow] = await app.db.select({ n: count() }).from(specReferences).where(where);
    const items = await app.db
      .select()
      .from(specReferences)
      .where(where)
      .orderBy(desc(specReferences.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post(
    "/projects/:projectId/spec-references/:referenceId/resolve",
    { preHandler: standardGate },
    async (req) => {
      const { referenceId } = req.params as { referenceId: string };
      const body = z
        .object({
          resolutionNote: z.string().min(1).max(2000),
          resolvedByRecordId: z.string().max(64).nullable().optional(),
        })
        .parse(req.body);
      const row = await fetchReference(req, referenceId);
      if (row.resolvedAt) throw conflict("This reference is already resolved");
      const now = new Date().toISOString();
      await app.db
        .update(specReferences)
        .set({
          resolvedBy: body.resolvedByRecordId ?? req.user!.id,
          resolvedAt: now,
          resolutionNote: body.resolutionNote,
          updatedAt: now,
        })
        .where(eq(specReferences.id, referenceId));
      await ledger("state_change", "spec_reference", referenceId, req, {
        resolved: true,
        resolutionNote: body.resolutionNote,
        resolvedByRecordId: body.resolvedByRecordId ?? null,
        actor: req.user!.id,
      });
      return fetchReference(req, referenceId);
    },
  );

  app.delete(
    "/projects/:projectId/spec-references/:referenceId",
    { preHandler: standardGate },
    async (req) => {
      const { referenceId } = req.params as { referenceId: string };
      await fetchReference(req, referenceId);
      await app.db.delete(specReferences).where(eq(specReferences.id, referenceId));
      await ledger("delete", "spec_reference", referenceId, req, {});
      return { ok: true };
    },
  );

  /* ================================================================ */
  /* 5. Coverage — the three questions the register must answer        */
  /* ================================================================ */

  app.get("/projects/:projectId/spec-coverage", { preHandler: readGate }, async (req) => {
    const sections = await app.db
      .select()
      .from(specSections)
      .where(
        and(
          eq(specSections.companyId, req.companyId!),
          eq(specSections.projectId, req.projectId!),
        ),
      )
      .orderBy(asc(specSections.code));
    const requirements = await app.db
      .select()
      .from(specSubmittalRequirements)
      .where(
        and(
          eq(specSubmittalRequirements.companyId, req.companyId!),
          eq(specSubmittalRequirements.projectId, req.projectId!),
        ),
      );
    const projectSubmittals = await app.db
      .select()
      .from(submittals)
      .where(
        and(eq(submittals.companyId, req.companyId!), eq(submittals.projectId, req.projectId!)),
      );

    const byStatus = (s: string) => requirements.filter((r) => r.status === s);
    const bySection = new Map<string, typeof requirements>();
    for (const r of requirements) {
      const list = bySection.get(r.sectionId) ?? [];
      list.push(r);
      bySection.set(r.sectionId, list);
    }

    const sectionsWithoutConfirmedRequirements = sections
      .filter((s) => s.status !== "withdrawn")
      .filter(
        (s) =>
          !(bySection.get(s.id) ?? []).some(
            (r) => r.status === "confirmed" || r.status === "registered",
          ),
      )
      .map((s) => ({
        sectionId: s.id,
        code: s.code,
        title: s.title,
        extractedButUnconfirmed: (bySection.get(s.id) ?? []).filter(
          (r) => r.status === "identified",
        ).length,
        reason:
          (bySection.get(s.id) ?? []).length === 0
            ? "No requirement has ever been extracted or typed for this section."
            : "Requirements exist but none has been confirmed by a human.",
      }));

    const requirementsNeverRegistered = requirements
      .filter((r) => r.registeredSubmittalId == null && r.status !== "not_required")
      .map((r) => ({
        requirementId: r.id,
        sectionCode: r.sectionCode,
        paragraphRef: r.paragraphRef,
        title: r.title,
        submittalType: r.submittalType,
        status: r.status,
        extractionMethod: r.extractionMethod,
        extractionConfidence: r.extractionConfidence,
        humanConfirmed: r.confirmedBy != null,
        blocker:
          r.status === "identified"
            ? "awaiting human confirmation"
            : r.status === "confirmed"
              ? "confirmed but never registered as a submittal"
              : r.status,
      }));

    const registeredIds = new Set(
      requirements.map((r) => r.registeredSubmittalId).filter((v): v is string => v != null),
    );
    const knownCodes = new Set(sections.map((s) => normaliseSectionCode(s.code)));
    const submittalsWithoutSpecBasis = projectSubmittals
      .filter((s) => !registeredIds.has(s.id))
      .map((s) => ({
        submittalId: s.id,
        number: s.number,
        revision: s.revision,
        title: s.title,
        specSection: s.specSection,
        reason:
          s.specSection == null || s.specSection.trim() === ""
            ? "No spec section is recorded against this submittal at all."
            : knownCodes.has(normaliseSectionCode(s.specSection))
              ? "Cites a known section, but was not built from any requirement in it."
              : "Cites a section that does not exist in this project's spec book.",
      }));

    /* ---- the coverage figure, or an honest null -------------------- */
    const confirmedOrRegistered = requirements.filter(
      (r) => r.status === "confirmed" || r.status === "registered",
    ).length;
    const registeredCount = byStatus("registered").length;
    const inputs = {
      sections: sections.length,
      requirements: requirements.length,
      identified: byStatus("identified").length,
      confirmed: byStatus("confirmed").length,
      registered: registeredCount,
      notRequired: byStatus("not_required").length,
      submittals: projectSubmittals.length,
    };
    const reasons: string[] = [];
    if (sections.length === 0) {
      reasons.push("This project holds no spec sections — upload or create a spec book first.");
    }
    if (confirmedOrRegistered === 0) {
      reasons.push(
        "No requirement has been confirmed by a human, so there is no agreed register to " +
          "measure coverage against. An extraction on its own is not a register.",
      );
    }
    const registerCompleteness =
      reasons.length > 0
        ? { value: null, unit: "%", inputs, reasons }
        : {
            value: Math.round((registeredCount / confirmedOrRegistered) * 10000) / 100,
            unit: "%",
            inputs,
            reasons: [] as string[],
          };

    return {
      registerCompleteness,
      summary: {
        ...inputs,
        sectionsWithoutConfirmedRequirements: sectionsWithoutConfirmedRequirements.length,
        requirementsNeverRegistered: requirementsNeverRegistered.length,
        submittalsWithoutSpecBasis: submittalsWithoutSpecBasis.length,
      },
      sectionsWithoutConfirmedRequirements,
      requirementsNeverRegistered,
      submittalsWithoutSpecBasis,
    };
  });

  /* ================================================================ */
  /* 6. Company-level: the cross-project section library               */
  /* ================================================================ */

  app.get("/spec-library/sections", { preHandler: companyRead }, async (req) => {
    const q = pageQuerySchema
      .extend({
        code: z.string().max(60).optional(),
        search: z.string().max(200).optional(),
        projectId: z.string().max(64).optional(),
      })
      .parse(req.query);
    const where = and(
      eq(specSections.companyId, req.companyId!),
      q.code ? eq(specSections.normalisedCode, normaliseSectionCode(q.code)) : undefined,
      q.search ? ilike(specSections.title, `%${q.search}%`) : undefined,
      q.projectId ? eq(specSections.projectId, q.projectId) : undefined,
    );
    const [totalRow] = await app.db.select({ n: count() }).from(specSections).where(where);
    const items = await app.db
      .select({
        id: specSections.id,
        projectId: specSections.projectId,
        code: specSections.code,
        normalisedCode: specSections.normalisedCode,
        title: specSections.title,
        divisionCode: specSections.divisionCode,
        status: specSections.status,
        revisionCount: specSections.revisionCount,
        submittalRequirementCount: specSections.submittalRequirementCount,
        requirementsConfirmed: specSections.requirementsConfirmed,
        updatedAt: specSections.updatedAt,
      })
      .from(specSections)
      .where(where)
      .orderBy(asc(specSections.code), desc(specSections.updatedAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });
};
