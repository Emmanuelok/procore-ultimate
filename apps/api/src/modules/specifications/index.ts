import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  assuranceGrants,
  bidPackages,
  commitments,
  drawingSheets,
  fileAccessLog,
  files,
  rfis,
  specBooks,
  specDivisions,
  specReferences,
  specRevisionNotices,
  specSectionRevisions,
  specSections,
  specSubmittalRequirements,
  projectMemberships,
  submittals,
  users,
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
  type LedgerAction,
} from "@constructos/shared";
import { sha256Hex } from "@constructos/ledger";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { forEachCompany } from "../../lib/scheduler.js";
import type { Db } from "../../lib/db.js";
import { isExpired } from "../../lib/time.js";
import { addDaysISO, isoDateSchema } from "../field/dates.js";
import { nextRevisionLabel } from "../drawings/detectors.js";
import { extractPdfPages, streamToBuffer } from "../drawings/pdf.js";
import { sendRanged } from "../drawings/stream.js";
import { classifyPdfUpload, safeFilename } from "../documents/inbound.js";
import { pushNotifications } from "../notifications/service.js";
import {
  detectSectionHeadings,
  diffClauses,
  divisionTitle,
  extractSubmittalRequirements,
  EXTRACTOR_VERSION,
  normaliseSectionCode,
  parseDivisionHeading,
  splitCsiParts,
  type ClauseChange,
} from "./parser.js";
import { planReissue } from "./reissue.js";

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
  /** current/superseded move ONLY through set-current, which supersedes two-way */
  status: z.enum(["draft", "archived"]).optional(),
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
  needsReconfirmation: z.enum(["0", "1"]).optional(),
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

  /**
   * Plan §6.3: a company-level list over project data is limited to the
   * projects the caller can see. `null` means "every project in the company"
   * (owner/admin, or a company-wide assurance grant).
   */
  async function visibleProjectIds(req: FastifyRequest): Promise<string[] | null> {
    if (req.companyRole === "owner" || req.companyRole === "admin") return null;
    const nowMs = Date.now();
    const grants = await app.db
      .select({ projectId: assuranceGrants.projectId, expiresAt: assuranceGrants.expiresAt })
      .from(assuranceGrants)
      .where(and(eq(assuranceGrants.companyId, req.companyId!), eq(assuranceGrants.userId, req.user!.id)));
    const live = grants.filter((g) => !isExpired(g.expiresAt, nowMs));
    if (live.some((g) => g.projectId === null)) return null;
    const ids = new Set<string>(live.map((g) => g.projectId).filter((p): p is string => typeof p === "string"));
    const memberships = await app.db
      .select({ projectId: projectMemberships.projectId })
      .from(projectMemberships)
      .where(and(eq(projectMemberships.companyId, req.companyId!), eq(projectMemberships.userId, req.user!.id)));
    for (const m of memberships) ids.add(m.projectId);
    return [...ids];
  }

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
    action: LedgerAction,
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

  async function bumpSectionCounts(db: Db, sectionId: string) {
    const [total] = await db
      .select({ n: count() })
      .from(specSubmittalRequirements)
      .where(eq(specSubmittalRequirements.sectionId, sectionId));
    const [confirmed] = await db
      .select({ n: count() })
      .from(specSubmittalRequirements)
      .where(
        and(
          eq(specSubmittalRequirements.sectionId, sectionId),
          inArray(specSubmittalRequirements.status, ["confirmed", "registered"]),
        ),
      );
    await db
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

  /*
   * A WRITE CONTEXT lets the same helpers run either directly (one request,
   * one section) or inside the book-split transaction. Inside the
   * transaction the ledger is QUEUED and appended after commit, so a split
   * that fails half-way leaves neither rows nor ledger entries behind — the
   * chain never records a revision that was rolled back.
   */
  type LedgerFn = (
    action: LedgerAction,
    objectType: string,
    objectId: string,
    payload: unknown,
  ) => Promise<void>;

  interface WriteCtx {
    db: Db;
    ledger: LedgerFn;
  }

  interface QueuedLedger {
    action: LedgerAction;
    objectType: string;
    objectId: string;
    payload: unknown;
  }

  function liveCtx(req: FastifyRequest): WriteCtx {
    return {
      db: app.db,
      ledger: (action, objectType, objectId, payload) =>
        ledger(action, objectType, objectId, req, payload),
    };
  }

  function queuedCtx(db: Db, queue: QueuedLedger[]): WriteCtx {
    return {
      db,
      ledger: async (action, objectType, objectId, payload) => {
        queue.push({ action, objectType, objectId, payload });
      },
    };
  }

  async function flushLedger(req: FastifyRequest, queue: QueuedLedger[]) {
    for (const q of queue) await ledger(q.action, q.objectType, q.objectId, req, q.payload);
  }

  interface ReissueImpact {
    noticeId: string;
    superseded: number;
    reconfirm: number;
    flagged: number;
    registeredChanged: number;
    notified: number;
  }

  /**
   * Reissue impact (#288): what the clause diff DOES to the register.
   * Removed clause → requirement superseded; amended clause → a confirmed
   * requirement drops back to identified and must be re-confirmed (the SoD
   * chain re-runs); a registered requirement whose clause changed is reported
   * against its submittal as a `superseded_by` reference and in the notice.
   */
  async function applyReissue(
    req: FastifyRequest,
    ctx: WriteCtx,
    section: typeof specSections.$inferSelect,
    rev: { revisionId: string; revision: string; bookId: string; previousId: string },
    changes: ClauseChange[],
  ): Promise<ReissueImpact> {
    const rows = await ctx.db
      .select()
      .from(specSubmittalRequirements)
      .where(eq(specSubmittalRequirements.sectionId, section.id));
    const plan = planReissue(
      changes,
      rows.map((r) => ({
        id: r.id,
        paragraphRef: r.paragraphRef,
        status: r.status,
        registeredSubmittalId: r.registeredSubmittalId,
      })),
    );
    const byId = new Map(rows.map((r) => [r.id, r] as const));
    const now = new Date().toISOString();

    if (plan.superseded.length > 0) {
      await ctx.db
        .update(specSubmittalRequirements)
        .set({
          status: "superseded",
          supersededByRevisionId: rev.revisionId,
          reissueNote: `The clause this was read from was removed in revision ${rev.revision}.`,
          updatedAt: now,
        })
        .where(inArray(specSubmittalRequirements.id, plan.superseded));
      for (const id of plan.superseded) {
        await ctx.ledger("state_change", "spec_submittal_requirement", id, {
          from: byId.get(id)?.status ?? null,
          to: "superseded",
          revisionId: rev.revisionId,
          reason: "clause removed on reissue",
        });
      }
    }
    if (plan.reconfirm.length > 0) {
      await ctx.db
        .update(specSubmittalRequirements)
        .set({
          status: "identified",
          confirmedBy: null,
          confirmedAt: null,
          needsReconfirmation: 1,
          reissueNote: `The clause was amended in revision ${rev.revision} after confirmation; the confirmation is void until a person re-reads it.`,
          updatedAt: now,
        })
        .where(inArray(specSubmittalRequirements.id, plan.reconfirm));
      for (const id of plan.reconfirm) {
        await ctx.ledger("state_change", "spec_submittal_requirement", id, {
          from: "confirmed",
          to: "identified",
          revisionId: rev.revisionId,
          confirmationVoided: byId.get(id)?.confirmedBy ?? null,
          reason: "clause amended on reissue",
        });
      }
    }
    if (plan.flagged.length > 0) {
      await ctx.db
        .update(specSubmittalRequirements)
        .set({
          needsReconfirmation: 1,
          reissueNote: `The clause was amended in revision ${rev.revision}; re-read it before confirming.`,
          updatedAt: now,
        })
        .where(inArray(specSubmittalRequirements.id, plan.flagged));
    }
    const affected: unknown[] = [];
    for (const rc of plan.registeredChanged) {
      const [sub] = await ctx.db
        .select({ number: submittals.number, title: submittals.title })
        .from(submittals)
        .where(eq(submittals.id, rc.submittalId))
        .limit(1);
      const refId = newId("sref");
      await ctx.db.insert(specReferences).values({
        id: refId,
        companyId: section.companyId,
        projectId: section.projectId,
        sectionId: section.id,
        sectionRevisionId: rev.revisionId,
        paragraphRef: rc.paragraphRef,
        targetType: "submittal",
        targetId: rc.submittalId,
        targetLabel: sub ? `SUB-${String(sub.number).padStart(3, "0")} ${sub.title}` : null,
        referenceKind: "superseded_by",
        note: `Clause ${rc.paragraphRef ?? "?"} was ${rc.kind} in revision ${rev.revision} after this submittal was registered against it.`,
        extractionMethod: "ai_extracted",
        extractionConfidence: null,
        detail: { source: "reissue", kind: rc.kind, requirementId: rc.requirementId, previousRevisionId: rev.previousId },
        createdBy: req.user!.id,
      });
      await ctx.db
        .update(specSubmittalRequirements)
        .set({
          needsReconfirmation: 1,
          reissueNote: `Clause ${rc.kind} in revision ${rev.revision} after registration — check the submittal still answers the spec.`,
          updatedAt: now,
        })
        .where(eq(specSubmittalRequirements.id, rc.requirementId));
      await ctx.ledger("create", "spec_reference", refId, {
        sectionId: section.id,
        referenceKind: "superseded_by",
        targetType: "submittal",
        targetId: rc.submittalId,
        revisionId: rev.revisionId,
      });
      affected.push({ ...rc, submittalLabel: sub ? `SUB-${String(sub.number).padStart(3, "0")}` : null });
    }

    // Who is told: the section's responsible person, whoever confirmed a row
    // now void, whoever registered a submittal now cited against a changed clause.
    const recipients = new Set<string>();
    if (section.responsibleUserId) recipients.add(section.responsibleUserId);
    for (const id of plan.reconfirm) {
      const c = byId.get(id)?.confirmedBy;
      if (c) recipients.add(c);
    }
    for (const rc of plan.registeredChanged) {
      const r = byId.get(rc.requirementId)?.registeredBy;
      if (r) recipients.add(r);
    }
    recipients.delete(req.user!.id);
    const noticeId = newId("srn");
    await ctx.db.insert(specRevisionNotices).values({
      id: noticeId,
      companyId: section.companyId,
      projectId: section.projectId,
      sectionId: section.id,
      sectionCode: section.code,
      revisionId: rev.revisionId,
      previousRevisionId: rev.previousId,
      bookId: rev.bookId,
      revision: rev.revision,
      changedClauseCount: changes.length,
      requirementsSuperseded: plan.superseded.length,
      requirementsToReconfirm: plan.reconfirm.length,
      requirementsNew: 0,
      submittalsAffected: affected,
      notifiedUserIds: [...recipients],
      detail: { flagged: plan.flagged.length, changedRefs: changes.map((c) => `${c.kind}:${c.ref}`).slice(0, 200) },
      createdBy: req.user!.id,
    });
    if (recipients.size > 0) {
      await pushNotifications(
        ctx.db,
        [...recipients].map((userId) => ({
          companyId: section.companyId,
          userId,
          projectId: section.projectId,
          kind: "status_change" as const,
          title: `Spec ${section.code} reissued as revision ${rev.revision}`,
          body: `${changes.length} clause(s) changed: ${plan.superseded.length} requirement(s) superseded, ${plan.reconfirm.length} confirmation(s) voided, ${plan.registeredChanged.length} registered submittal(s) affected.`,
          recordType: "spec_revision_notice",
          recordId: noticeId,
        })),
      );
    }
    await ctx.ledger("create", "spec_revision_notice", noticeId, {
      sectionId: section.id,
      sectionCode: section.code,
      revisionId: rev.revisionId,
      changedClauses: changes.length,
      superseded: plan.superseded.length,
      reconfirm: plan.reconfirm.length,
      registeredChanged: plan.registeredChanged.length,
      notified: recipients.size,
    });
    return {
      noticeId,
      superseded: plan.superseded.length,
      reconfirm: plan.reconfirm.length,
      flagged: plan.flagged.length,
      registeredChanged: plan.registeredChanged.length,
      notified: recipients.size,
    };
  }

  /**
   * Insert a new revision of a section with TWO-WAY supersession, or return
   * `unchanged` when the text hashes identically to the revision in force —
   * a reissue that changed nothing must be provable as such rather than
   * generating a phantom revision people then diff against. When the text
   * did change, the reissue impact on the register is applied here (#288).
   */
  async function insertRevision(
    req: FastifyRequest,
    ctx: WriteCtx,
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
  ): Promise<{ revisionId: string; unchanged: boolean; revision: string; impact: ReissueImpact | null }> {
    const previous = section.currentRevisionId
      ? ((
          await ctx.db
            .select()
            .from(specSectionRevisions)
            .where(eq(specSectionRevisions.id, section.currentRevisionId))
            .limit(1)
        )[0] ?? null)
      : null;

    const contentSha256 = input.text ? sha256Hex(input.text) : null;
    if (previous && contentSha256 && previous.contentSha256 === contentSha256) {
      return { revisionId: previous.id, unchanged: true, revision: previous.revision, impact: null };
    }

    const label = input.revision ?? nextRevisionLabel(previous?.revision ?? null);
    const revisionId = newId("srev");
    const now = new Date().toISOString();
    const changedClauses =
      previous?.extractedText && input.text ? diffClauses(previous.extractedText, input.text) : [];

    await ctx.db.insert(specSectionRevisions).values({
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
      await ctx.db
        .update(specSectionRevisions)
        .set({
          isSuperseded: 1,
          supersededByRevisionId: revisionId,
          supersededAt: now,
          updatedAt: now,
        })
        .where(eq(specSectionRevisions.id, previous.id));
    }
    await ctx.db
      .update(specSections)
      .set({
        currentRevisionId: revisionId,
        revisionCount: section.revisionCount + 1,
        status: "current",
        withdrawnAt: null,
        withdrawnBy: null,
        withdrawnReason: null,
        updatedAt: now,
      })
      .where(eq(specSections.id, section.id));

    let impact: ReissueImpact | null = null;
    if (previous && changedClauses.length > 0) {
      impact = await applyReissue(
        req,
        ctx,
        section,
        { revisionId, revision: label, bookId: input.bookId, previousId: previous.id },
        changedClauses,
      );
      await ctx.db
        .update(specSectionRevisions)
        .set({
          impact: {
            superseded: impact.superseded,
            reconfirm: impact.reconfirm,
            flagged: impact.flagged,
            registeredChanged: impact.registeredChanged,
            noticeId: impact.noticeId,
          },
        })
        .where(eq(specSectionRevisions.id, revisionId));
      await bumpSectionCounts(ctx.db, section.id);
    }

    return { revisionId, unchanged: false, revision: label, impact };
  }

  /**
   * Insert extracted requirements for a revision, skipping ones already held.
   * A row superseded by a reissue does not block a fresh reading of the same
   * paragraph; the new row records which superseded row it replaces.
   */
  async function extractInto(
    req: FastifyRequest,
    ctx: WriteCtx,
    section: typeof specSections.$inferSelect,
    revisionId: string,
    text: string,
  ): Promise<{ created: number; skipped: number }> {
    const found = extractSubmittalRequirements(text);
    if (found.length === 0) return { created: 0, skipped: 0 };
    const existing = await ctx.db
      .select({
        id: specSubmittalRequirements.id,
        paragraphRef: specSubmittalRequirements.paragraphRef,
        submittalType: specSubmittalRequirements.submittalType,
        status: specSubmittalRequirements.status,
      })
      .from(specSubmittalRequirements)
      .where(eq(specSubmittalRequirements.sectionId, section.id));
    const keyOf = (ref: string | null, type: string) => `${ref ?? ""}|${type}`;
    const seen = new Set(
      existing.filter((e) => e.status !== "superseded").map((e) => keyOf(e.paragraphRef, e.submittalType)),
    );
    const supersededByKey = new Map(
      existing.filter((e) => e.status === "superseded").map((e) => [keyOf(e.paragraphRef, e.submittalType), e.id] as const),
    );

    let created = 0;
    let skipped = 0;
    for (const r of found) {
      const key = keyOf(r.paragraphRef, r.submittalType);
      if (seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      const id = newId("sreq");
      const supersedesRequirementId = supersededByKey.get(key) ?? null;
      await ctx.db.insert(specSubmittalRequirements).values({
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
          ...(supersedesRequirementId ? { supersedesRequirementId } : {}),
        },
        createdBy: req.user!.id,
      });
      await ctx.ledger("create", "spec_submittal_requirement", id, {
        sectionId: section.id,
        sectionCode: section.code,
        paragraphRef: r.paragraphRef,
        submittalType: r.submittalType,
        status: "identified",
        extractionMethod: "ai_extracted",
        extractionConfidence: r.confidence,
        extractor: EXTRACTOR_VERSION,
        supersedesRequirementId,
      });
      created += 1;
    }
    await bumpSectionCounts(ctx.db, section.id);
    return { created, skipped };
  }

  /* ================================================================ */
  /* 1. Spec books — upload, split, supersede                          */
  /* ================================================================ */

  app.post("/projects/:projectId/spec-books", { preHandler: standardGate }, async (req, reply) => {
    const mp = await req.file();
    if (!mp) throw badRequest("Expected a multipart PDF upload");
    const filename = safeFilename(mp.filename, "specification.pdf");
    const cls = classifyPdfUpload(mp.mimetype, filename);
    if (!cls.ok) {
      mp.file.resume();
      throw badRequest(cls.reason ?? "Expected a PDF");
    }
    const buf = await streamToBuffer(mp.file);
    if (mp.file.truncated) {
      throw badRequest(
        `File exceeds the ${Math.round(app.appConfig.UPLOAD_MAX_BYTES / (1024 * 1024))} MiB upload limit`,
      );
    }
    if (buf.length === 0) throw badRequest("Empty file");
    const name = fieldValue(mp.fields, "name") ?? filename.replace(/\.pdf$/i, "") ?? "Specification";
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
      name: filename,
      contentType: "application/pdf",
      sizeBytes: saved.sizeBytes,
      sha256: saved.sha256,
      storageKey: saved.storageKey,
      documentType: "specification",
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
    const reissued: Array<{ sectionCode: string; revision: string } & ReissueImpact> = [];
    const queue: QueuedLedger[] = [];

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

      /*
       * The split is ONE transaction: a failure on section 40 of 80 leaves no
       * section pointing at a revision from a book that is then marked failed.
       * Ledger entries are queued and appended after commit.
       */
      await app.db.transaction(async (tx) => {
        const ctx = queuedCtx(tx as unknown as Db, queue);

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
          await ctx.db.insert(specDivisions).values({
            id,
            companyId: req.companyId!,
            projectId: req.projectId!,
            bookId,
            code,
            title: explicit?.title ?? divisionTitle(code) ?? `Division ${code}`,
            pageStart: explicit?.pageStart ?? sectionsIn[0]?.pageStart ?? null,
            pageEnd: explicit?.pageEnd ?? sectionsIn[sectionsIn.length - 1]?.pageEnd ?? null,
            sortOrder: order,
            sectionCount: sectionsIn.length,
          });
          divisionIds.set(code, id);
          divisionsCreated += 1;
        }

        for (const found of split.sections) {
          const existing = await ctx.db
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
            await ctx.db.insert(specSections).values({
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
            await ctx.ledger("create", "spec_section", sectionId, {
              code: found.code,
              title: found.title,
              bookId,
              headingConfidence: found.confidence,
            });
            section = (
              await ctx.db.select().from(specSections).where(eq(specSections.id, sectionId)).limit(1)
            )[0]!;
          } else {
            await ctx.db
              .update(specSections)
              .set({
                divisionId: divisionIds.get(found.divisionCode) ?? section.divisionId,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(specSections.id, section.id));
          }

          const result = await insertRevision(req, ctx, section, {
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
          await ctx.ledger("create", "spec_section_revision", result.revisionId, {
            sectionId: section.id,
            code: found.code,
            revision: result.revision,
            bookId,
            pageStart: found.pageStart,
            pageEnd: found.pageEnd,
            impact: result.impact,
          });
          if (result.impact) reissued.push({ sectionCode: section.code, revision: result.revision, ...result.impact });

          if (doExtract) {
            const reloaded = (
              await ctx.db.select().from(specSections).where(eq(specSections.id, section.id)).limit(1)
            )[0]!;
            const extracted = await extractInto(req, ctx, reloaded, result.revisionId, found.text);
            requirementsExtracted += extracted.created;
            if (result.impact && extracted.created > 0) {
              await ctx.db
                .update(specRevisionNotices)
                .set({ requirementsNew: extracted.created })
                .where(eq(specRevisionNotices.id, result.impact.noticeId));
            }
          }
        }
      });
      await flushLedger(req, queue);
    } catch (err) {
      failed = err instanceof Error ? err.message : "Spec book processing failed";
      // the transaction rolled back: nothing this book touched survives
      divisionsCreated = 0;
      sectionsCreated = 0;
      revisionsAdded = 0;
      unchangedSections = 0;
      requirementsExtracted = 0;
      reissued.length = 0;
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
        sectionCount: failed ? 0 : sectionsInBook,
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
      reissued: reissued.length,
    });

    let absentSections: AbsentSection[] = [];
    if (!failed && makeCurrent) absentSections = await promoteBookToCurrent(req, bookId);

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
      reissued,
      absentSections,
      error: failed,
      rolledBack: failed !== null,
    });
  });

  interface AbsentSection {
    sectionId: string;
    code: string;
    title: string;
    status: string;
    lastBookId: string | null;
  }

  /** Current sections that have no revision in `bookId`: candidates for withdrawal (#288). */
  async function absentSectionsFor(req: FastifyRequest, bookId: string): Promise<AbsentSection[]> {
    const inBook = await sectionIdsForBook(bookId);
    const rows = await app.db
      .select()
      .from(specSections)
      .where(
        and(
          eq(specSections.projectId, req.projectId!),
          eq(specSections.status, "current"),
          inBook.length ? notInArray(specSections.id, inBook) : undefined,
        ),
      )
      .orderBy(asc(specSections.code));
    const revIds = rows.map((r) => r.currentRevisionId).filter((v): v is string => v != null);
    const revs = revIds.length
      ? await app.db
          .select({ id: specSectionRevisions.id, bookId: specSectionRevisions.bookId })
          .from(specSectionRevisions)
          .where(inArray(specSectionRevisions.id, revIds))
      : [];
    const bookOf = new Map(revs.map((r) => [r.id, r.bookId]));
    return rows.map((r) => ({
      sectionId: r.id,
      code: r.code,
      title: r.title,
      status: r.status,
      lastBookId: r.currentRevisionId ? (bookOf.get(r.currentRevisionId) ?? null) : null,
    }));
  }

  /**
   * Two-way book supersession: exactly one current book drives the build.
   * Returns the sections absent from the new current issue so a person can
   * withdraw them — coverage must stop counting dead sections, but only after
   * someone confirms they are dead.
   */
  async function promoteBookToCurrent(req: FastifyRequest, bookId: string): Promise<AbsentSection[]> {
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
    const absent = await absentSectionsFor(req, bookId);
    await ledger("state_change", "spec_book", bookId, req, {
      status: "current",
      isCurrent: 1,
      supersedesId: previous[0]?.id ?? null,
      absentSections: absent.length,
    });
    return absent;
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
      const absentSections = await promoteBookToCurrent(req, bookId);
      return { ...(await fetchBook(req, bookId)), absentSections };
    },
  );

  /** Sections marked current that this issue does not contain (#288). */
  app.get(
    "/projects/:projectId/spec-books/:bookId/absent-sections",
    { preHandler: readGate },
    async (req) => {
      const { bookId } = req.params as { bookId: string };
      await fetchBook(req, bookId);
      const items = await absentSectionsFor(req, bookId);
      return {
        items,
        total: items.length,
        note: "A section absent from the current issue is only withdrawn when a person confirms it; coverage keeps counting it until then.",
      };
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
      if (!req.headers.range) {
        await app.db.insert(fileAccessLog).values({
          id: newId("fal"),
          fileId: f.id,
          userId: req.user!.id,
          action: "view",
          companyId: f.companyId,
          projectId: f.projectId,
          context: "spec_book",
          version: f.version,
        });
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "access",
          objectType: "spec_book",
          objectId: bookId,
          payload: { action: "view", fileId: f.id },
          projectId: req.projectId!,
        });
      }
      return sendRanged(app.storage, req, reply, {
        storageKey: f.storageKey,
        sizeBytes: f.sizeBytes,
        contentType: f.contentType || "application/pdf",
        filename: f.name,
        sha256: f.sha256,
      });
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
      const result = await insertRevision(req, liveCtx(req), section, {
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
      const result = await insertRevision(req, liveCtx(req), section, {
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
        impact: result.impact,
      });
      return reply.status(201).send({ ...row, unchanged: false, impact: result.impact });
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
      const result = await extractInto(req, liveCtx(req), section, revisionId, revision.extractedText);
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
      await bumpSectionCounts(app.db, sectionId);
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
      q.needsReconfirmation === "1" ? eq(specSubmittalRequirements.needsReconfirmation, 1) : undefined,
      // The predicate lives in the WHERE so count and page agree: a human-typed
      // row (no confidence) is never hidden by a confidence floor.
      q.minConfidence !== undefined
        ? or(
            isNull(specSubmittalRequirements.extractionConfidence),
            gte(specSubmittalRequirements.extractionConfidence, q.minConfidence),
          )
        : undefined,
      bookSectionIds ? inArray(specSubmittalRequirements.sectionId, bookSectionIds) : undefined,
    );
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(specSubmittalRequirements)
      .where(where);
    const items = await app.db
      .select()
      .from(specSubmittalRequirements)
      .where(where)
      .orderBy(asc(specSubmittalRequirements.sectionCode), asc(specSubmittalRequirements.paragraphRef))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items.map(withProvenance), Number(totalRow?.n ?? 0), q);
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

  /** Fields whose change alters WHAT the requirement claims — a confirmation cannot survive them. */
  const REQUIREMENT_CONTENT_FIELDS = [
    "title",
    "description",
    "clauseText",
    "paragraphRef",
    "submittalType",
    "requiredBefore",
    "requiredCopies",
    "reviewDays",
    "isDeferred",
  ] as const;

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
      if (body.sectionRevisionId) {
        const [rev] = await app.db
          .select({ id: specSectionRevisions.id })
          .from(specSectionRevisions)
          .where(and(eq(specSectionRevisions.id, body.sectionRevisionId), eq(specSectionRevisions.sectionId, row.sectionId)))
          .limit(1);
        if (!rev) throw notFound("sectionRevisionId is not a revision of this requirement's section");
      }
      if (body.commitmentId) {
        const [c] = await app.db
          .select({ id: commitments.id })
          .from(commitments)
          .where(and(eq(commitments.id, body.commitmentId), eq(commitments.projectId, req.projectId!)))
          .limit(1);
        if (!c) throw notFound("commitmentId is not a commitment on this project");
      }
      if (body.bidPackageId) {
        const [b] = await app.db
          .select({ id: bidPackages.id })
          .from(bidPackages)
          .where(and(eq(bidPackages.id, body.bidPackageId), eq(bidPackages.projectId, req.projectId!)))
          .limit(1);
        if (!b) throw notFound("bidPackageId is not a bid package on this project");
      }
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      const rowRecord = row as unknown as Record<string, unknown>;
      let contentChanged = false;
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        const stored = k === "isDeferred" ? (v ? 1 : 0) : v;
        set[k] = stored;
        if ((REQUIREMENT_CONTENT_FIELDS as readonly string[]).includes(k) && rowRecord[k] !== stored) {
          contentChanged = true;
        }
      }
      // Segregation of duties: a confirmation applies to the words the
      // confirmer read. Change the words and the confirmation is void.
      const confirmationReset = row.status === "confirmed" && contentChanged;
      if (confirmationReset) {
        set["status"] = "identified";
        set["confirmedBy"] = null;
        set["confirmedAt"] = null;
        set["needsReconfirmation"] = 1;
        set["reissueNote"] = "Content was edited after confirmation; the confirmation was reset.";
      }
      await app.db
        .update(specSubmittalRequirements)
        .set(set)
        .where(eq(specSubmittalRequirements.id, requirementId));
      if (confirmationReset) await bumpSectionCounts(app.db, row.sectionId);
      await ledger("update", "spec_submittal_requirement", requirementId, req, {
        changed: Object.keys(body),
        confirmationReset,
        previousConfirmedBy: confirmationReset ? row.confirmedBy : undefined,
      });
      if (confirmationReset) {
        await ledger("state_change", "spec_submittal_requirement", requirementId, req, {
          from: "confirmed",
          to: "identified",
          reason: "content edited after confirmation",
          editedBy: req.user!.id,
          confirmationVoided: row.confirmedBy,
        });
      }
      return { ...withProvenance(await fetchRequirement(req, requirementId)), confirmationReset };
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
          needsReconfirmation: 0,
          detail: {
            ...((row.detail as Record<string, unknown>) ?? {}),
            ...(body.note ? { confirmationNote: body.note } : {}),
          },
          updatedAt: now,
        })
        .where(eq(specSubmittalRequirements.id, requirementId));
      await bumpSectionCounts(app.db, row.sectionId);
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
      await bumpSectionCounts(app.db, row.sectionId);
      await ledger("state_change", "spec_submittal_requirement", requirementId, req, {
        from: row.status,
        to: "not_required",
        reason: body.reason,
      });
      return withProvenance(await fetchRequirement(req, requirementId));
    },
  );

  /**
   * Build one register row: the requirement becomes a real submittal.
   *
   * Atomic and conditional: the requirement is claimed with
   * `UPDATE … WHERE status = 'confirmed'` inside one transaction before the
   * submittal exists, so a double click or a build-register overlapping a
   * single register cannot create two submittals or orphan one.
   */
  async function registerRequirement(
    req: FastifyRequest,
    row: RequirementRow,
    overrides: z.infer<typeof registerSchema>,
  ) {
    return app.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      const now = new Date().toISOString();
      const claimed = await db
        .update(specSubmittalRequirements)
        .set({ status: "registered", registeredAt: now, registeredBy: req.user!.id, updatedAt: now })
        .where(
          and(
            eq(specSubmittalRequirements.id, row.id),
            eq(specSubmittalRequirements.status, "confirmed"),
          ),
        )
        .returning({ id: specSubmittalRequirements.id });
      if (claimed.length === 0) {
        throw conflict(
          "This requirement is no longer confirmed — it was registered, reset or superseded by another request",
        );
      }
      const number = await nextRecordNumber(db, req.projectId!, "submittal");
      const submittalId = newId("sub");
      const leadTimeDays = overrides.leadTimeDays ?? row.leadTimeDays ?? null;
      const requiredOnSite = overrides.requiredOnSite ?? null;
      const reviewDays = row.reviewDays ?? DEFAULT_REVIEW_ALLOWANCE_DAYS;
      const submitByDate = requiredOnSite
        ? addDaysISO(requiredOnSite, -((leadTimeDays ?? 0) + reviewDays))
        : null;
      await db.insert(submittals).values({
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
      await db
        .update(specSubmittalRequirements)
        .set({ registeredSubmittalId: submittalId, updatedAt: now })
        .where(eq(specSubmittalRequirements.id, row.id));
      await bumpSectionCounts(db, row.sectionId);
      await appendLedger(db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "submittal",
        objectId: submittalId,
        payload: {
          number,
          title: overrides.title ?? row.title,
          specSection: row.sectionCode,
          builtFromRequirementId: row.id,
          paragraphRef: row.paragraphRef,
          extractionMethod: row.extractionMethod,
          extractionConfidence: row.extractionConfidence,
          confirmedBy: row.confirmedBy,
        },
        projectId: req.projectId!,
      });
      await appendLedger(db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "spec_submittal_requirement",
        objectId: row.id,
        payload: {
          from: "confirmed",
          to: "registered",
          registeredSubmittalId: submittalId,
          registeredBy: req.user!.id,
        },
        projectId: req.projectId!,
      });
      const [submittal] = await db
        .select()
        .from(submittals)
        .where(eq(submittals.id, submittalId))
        .limit(1);
      return submittal!;
    });
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
  /* 5b. Reissue tracking: withdrawal, notices, search, health         */
  /* ================================================================ */

  /** Withdraw a section absent from the current issue — a person's act, with a reason (#288). */
  app.post(
    "/projects/:projectId/spec-sections/:sectionId/withdraw",
    { preHandler: standardGate },
    async (req) => {
      const { sectionId } = req.params as { sectionId: string };
      const body = z.object({ reason: z.string().min(1).max(2000) }).parse(req.body);
      const section = await fetchSection(req, sectionId);
      if (section.status === "withdrawn") throw conflict("This section is already withdrawn");
      const now = new Date().toISOString();
      const [open] = await app.db
        .select({ n: count() })
        .from(specSubmittalRequirements)
        .where(
          and(
            eq(specSubmittalRequirements.sectionId, sectionId),
            inArray(specSubmittalRequirements.status, ["identified", "confirmed"]),
          ),
        );
      await app.db
        .update(specSections)
        .set({
          status: "withdrawn",
          withdrawnAt: now,
          withdrawnBy: req.user!.id,
          withdrawnReason: body.reason,
          updatedAt: now,
        })
        .where(eq(specSections.id, sectionId));
      await ledger("state_change", "spec_section", sectionId, req, {
        from: section.status,
        to: "withdrawn",
        reason: body.reason,
        openRequirements: Number(open?.n ?? 0),
      });
      return {
        ...(await fetchSection(req, sectionId)),
        openRequirements: Number(open?.n ?? 0),
        note:
          Number(open?.n ?? 0) > 0
            ? `${open!.n} unregistered requirement(s) remain on the record; coverage no longer counts this section.`
            : "Coverage no longer counts this section.",
      };
    },
  );

  app.post(
    "/projects/:projectId/spec-sections/:sectionId/reinstate",
    { preHandler: standardGate },
    async (req) => {
      const { sectionId } = req.params as { sectionId: string };
      const section = await fetchSection(req, sectionId);
      if (section.status !== "withdrawn") throw conflict("Only a withdrawn section can be reinstated");
      const now = new Date().toISOString();
      await app.db
        .update(specSections)
        .set({ status: "current", withdrawnAt: null, withdrawnBy: null, withdrawnReason: null, updatedAt: now })
        .where(eq(specSections.id, sectionId));
      await ledger("state_change", "spec_section", sectionId, req, { from: "withdrawn", to: "current" });
      return fetchSection(req, sectionId);
    },
  );

  /** Reissue notices: what each reissue did to the register, and whether it was actioned (#288). */
  app.get("/projects/:projectId/spec-revision-notices", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ acknowledged: z.enum(["0", "1"]).optional(), sectionId: z.string().max(64).optional() })
      .parse(req.query);
    const where = and(
      eq(specRevisionNotices.companyId, req.companyId!),
      eq(specRevisionNotices.projectId, req.projectId!),
      q.acknowledged === "1" ? isNotNull(specRevisionNotices.acknowledgedAt) : undefined,
      q.acknowledged === "0" ? isNull(specRevisionNotices.acknowledgedAt) : undefined,
      q.sectionId ? eq(specRevisionNotices.sectionId, q.sectionId) : undefined,
    );
    const [totalRow] = await app.db.select({ n: count() }).from(specRevisionNotices).where(where);
    const items = await app.db
      .select()
      .from(specRevisionNotices)
      .where(where)
      .orderBy(desc(specRevisionNotices.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const sectionIds = [...new Set(items.map((i) => i.sectionId))];
    const sections = sectionIds.length
      ? await app.db
          .select({ id: specSections.id, title: specSections.title, status: specSections.status })
          .from(specSections)
          .where(inArray(specSections.id, sectionIds))
      : [];
    const sectionMap = new Map(sections.map((s) => [s.id, s]));
    const userIds = [...new Set(items.flatMap((i) => [i.createdBy, i.acknowledgedBy, ...i.notifiedUserIds]))].filter(
      (v): v is string => v != null,
    );
    const people = userIds.length
      ? await app.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds))
      : [];
    const nameOf = new Map(people.map((p) => [p.id, p.name]));
    const [open] = await app.db
      .select({ n: count() })
      .from(specRevisionNotices)
      .where(
        and(
          eq(specRevisionNotices.projectId, req.projectId!),
          isNull(specRevisionNotices.acknowledgedAt),
        ),
      );
    return {
      ...paginate(
        items.map((n) => ({
          ...n,
          sectionTitle: sectionMap.get(n.sectionId)?.title ?? null,
          sectionStatus: sectionMap.get(n.sectionId)?.status ?? null,
          createdByName: nameOf.get(n.createdBy) ?? null,
          acknowledgedByName: n.acknowledgedBy ? (nameOf.get(n.acknowledgedBy) ?? null) : null,
          notifiedNames: n.notifiedUserIds.map((id) => nameOf.get(id) ?? id),
        })),
        Number(totalRow?.n ?? 0),
        q,
      ),
      unacknowledged: Number(open?.n ?? 0),
    };
  });

  app.post(
    "/projects/:projectId/spec-revision-notices/:noticeId/acknowledge",
    { preHandler: standardGate },
    async (req) => {
      const { noticeId } = req.params as { noticeId: string };
      const body = z.object({ note: z.string().max(2000).optional() }).parse(req.body ?? {});
      const [notice] = await app.db
        .select()
        .from(specRevisionNotices)
        .where(
          and(
            eq(specRevisionNotices.id, noticeId),
            eq(specRevisionNotices.companyId, req.companyId!),
            eq(specRevisionNotices.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!notice) throw notFound("Reissue notice not found");
      if (notice.acknowledgedAt) throw conflict("This notice has already been acknowledged");
      const now = new Date().toISOString();
      await app.db
        .update(specRevisionNotices)
        .set({
          acknowledgedBy: req.user!.id,
          acknowledgedAt: now,
          detail: { ...notice.detail, ...(body.note ? { acknowledgementNote: body.note } : {}) },
        })
        .where(eq(specRevisionNotices.id, noticeId));
      await ledger("state_change", "spec_revision_notice", noticeId, req, {
        acknowledgedBy: req.user!.id,
        note: body.note ?? null,
      });
      const [updated] = await app.db.select().from(specRevisionNotices).where(eq(specRevisionNotices.id, noticeId)).limit(1);
      return updated;
    },
  );

  /** Full-text search over the text in force (#298): sections whose current revision matches. */
  app.get("/projects/:projectId/spec-search", { preHandler: readGate }, async (req) => {
    const q = z
      .object({ q: z.string().min(2).max(200), limit: z.coerce.number().int().min(1).max(100).default(25) })
      .parse(req.query);
    const tsquery = sql`plainto_tsquery('english', ${q.q})`;
    const vector = sql`to_tsvector('english', left(coalesce(${specSectionRevisions.extractedText}, ''), 400000))`;
    const rows = await app.db
      .select({
        sectionId: specSections.id,
        code: specSections.code,
        title: specSections.title,
        status: specSections.status,
        revisionId: specSectionRevisions.id,
        revision: specSectionRevisions.revision,
        pageStart: specSectionRevisions.pageStart,
        rank: sql<number>`ts_rank(${vector}, ${tsquery})`,
        snippet: sql<string>`ts_headline('english', left(coalesce(${specSectionRevisions.extractedText}, ''), 400000), ${tsquery}, 'MaxWords=40, MinWords=15, StartSel=[[, StopSel=]]')`,
      })
      .from(specSections)
      .innerJoin(specSectionRevisions, eq(specSectionRevisions.id, specSections.currentRevisionId))
      .where(
        and(
          eq(specSections.companyId, req.companyId!),
          eq(specSections.projectId, req.projectId!),
          sql`${vector} @@ ${tsquery}`,
        ),
      )
      .orderBy(sql`ts_rank(${vector}, ${tsquery}) desc`, asc(specSections.code))
      .limit(q.limit);
    return {
      q: q.q,
      items: rows.map((r) => ({ ...r, rank: Number(r.rank) })),
      total: rows.length,
      basis: "Postgres full-text search over the extracted text of each section's current revision; superseded text is not searched.",
    };
  });

  /** Health inputs for the intelligence layer (plan §3.5). */
  app.get("/projects/:projectId/specifications/health-inputs", { preHandler: readGate }, async (req) => {
    const projectId = req.projectId!;
    const [sections] = await app.db
      .select({ n: count() })
      .from(specSections)
      .where(and(eq(specSections.projectId, projectId), ne(specSections.status, "withdrawn")));
    const byStatus = await app.db
      .select({ status: specSubmittalRequirements.status, n: count() })
      .from(specSubmittalRequirements)
      .where(eq(specSubmittalRequirements.projectId, projectId))
      .groupBy(specSubmittalRequirements.status);
    const statusMap = new Map(byStatus.map((r) => [r.status, Number(r.n)]));
    const [reconfirm] = await app.db
      .select({ n: count() })
      .from(specSubmittalRequirements)
      .where(and(eq(specSubmittalRequirements.projectId, projectId), eq(specSubmittalRequirements.needsReconfirmation, 1)));
    const [notices] = await app.db
      .select({ n: count() })
      .from(specRevisionNotices)
      .where(and(eq(specRevisionNotices.projectId, projectId), isNull(specRevisionNotices.acknowledgedAt)));
    const [conflicts] = await app.db
      .select({ n: count() })
      .from(specReferences)
      .where(
        and(
          eq(specReferences.projectId, projectId),
          eq(specReferences.referenceKind, "conflicts_with"),
          isNull(specReferences.resolvedAt),
        ),
      );
    const [currentBook] = await app.db
      .select({ n: count() })
      .from(specBooks)
      .where(and(eq(specBooks.projectId, projectId), eq(specBooks.isCurrent, 1)));
    const reasons: string[] = [];
    if (Number(sections?.n ?? 0) === 0) reasons.push("No spec sections exist on this project.");
    if (Number(currentBook?.n ?? 0) === 0) reasons.push("No spec book is marked current, so the register has no single issue to be built from.");
    return {
      metrics: {
        sections: Number(sections?.n ?? 0),
        requirementsIdentified: statusMap.get("identified") ?? 0,
        requirementsConfirmed: statusMap.get("confirmed") ?? 0,
        requirementsRegistered: statusMap.get("registered") ?? 0,
        needsReconfirmation: Number(reconfirm?.n ?? 0),
        unacknowledgedReissues: Number(notices?.n ?? 0),
        unresolvedConflicts: Number(conflicts?.n ?? 0),
        hasCurrentBook: Number(currentBook?.n ?? 0) > 0 ? 1 : 0,
      },
      reasons,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Scheduler: reissue notices nobody has actioned                    */
  /* ---------------------------------------------------------------- */

  const REISSUE_REMINDER_DAYS = 7;

  async function sweepReissueReminders(db: Db, companyId: string, now: Date) {
    const cutoff = new Date(now.getTime() - REISSUE_REMINDER_DAYS * 86_400_000).toISOString();
    const due = await db
      .select()
      .from(specRevisionNotices)
      .where(
        and(
          eq(specRevisionNotices.companyId, companyId),
          isNull(specRevisionNotices.acknowledgedAt),
          lt(specRevisionNotices.createdAt, cutoff),
          sql`(${specRevisionNotices.detail}->>'remindedAt') is null`,
        ),
      )
      .limit(200);
    let reminded = 0;
    for (const n of due) {
      const recipients = n.notifiedUserIds.length > 0 ? n.notifiedUserIds : [n.createdBy];
      await pushNotifications(
        db,
        recipients.map((userId) => ({
          companyId,
          userId,
          projectId: n.projectId,
          kind: "reminder" as const,
          title: `Reissue of ${n.sectionCode} (rev ${n.revision}) still unactioned`,
          body: `${n.requirementsToReconfirm} confirmation(s) to re-run, ${n.requirementsSuperseded} requirement(s) superseded, ${n.submittalsAffected.length} registered submittal(s) affected. Acknowledge the notice once the register has been checked.`,
          recordType: "spec_revision_notice",
          recordId: n.id,
        })),
      );
      await db
        .update(specRevisionNotices)
        .set({ detail: { ...n.detail, remindedAt: now.toISOString() } })
        .where(eq(specRevisionNotices.id, n.id));
      reminded += 1;
    }
    return reminded;
  }

  app.scheduler.register({
    name: "specifications.reissue-reminders",
    description: `Remind the people told about a spec reissue when the notice sits unacknowledged for ${REISSUE_REMINDER_DAYS} days`,
    everyMs: 12 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => {
      let reminded = 0;
      const summary = await forEachCompany(db, async (companyId) => {
        reminded += await sweepReissueReminders(db, companyId, now);
      });
      return { ...summary, reminded };
    },
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
    const visible = await visibleProjectIds(req);
    if (visible !== null && visible.length === 0) return paginate([], 0, q);
    const where = and(
      eq(specSections.companyId, req.companyId!),
      visible === null ? undefined : inArray(specSections.projectId, visible),
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
