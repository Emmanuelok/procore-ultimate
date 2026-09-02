/**
 * Drawing-set processing pipeline (spec Vol I #256–#263, #266).
 *
 * Upload once, register pages as sheets, resumably. The request path stores
 * the PDF and either processes a small set inline or leaves it `pending`
 * for the `drawings.process-sets` scheduler job; either way the work runs
 * through `processDrawingSet`, which advances `processedPages` after every
 * page so a crash, a restart or a tick budget never re-registers a page and
 * never loses one.
 *
 * Rules that keep the register honest (the audit's UNNAMED-N collisions and
 * same-set self-supersession):
 *   · a page whose number cannot be read gets a SET-SCOPED placeholder
 *     (`UNNAMED-<page>-<set>`) and `needsReview`; it never merges with
 *     another set's unreadable page 3.
 *   · a page whose number matches a sheet whose CURRENT revision came from
 *     THIS SAME SET is a duplicate inside one upload (an index page that
 *     names the last sheet, a re-scanned page); it becomes a review sheet
 *     beside the original instead of silently superseding it.
 *   · supersession across sets computes the vector diff against the
 *     revision it replaces and stores the verdict — an unchanged reissue is a
 *     QA finding, not a new revision people then diff by eye.
 *
 * After the last page an automatic callout pass turns "3/A-501" into a
 * hyperlink (or an `unresolved` one, when no such sheet exists) and
 * "SECTION 03 30 00" into a spec cross-reference.
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  drawingHyperlinks,
  drawingRevisions,
  drawingSets,
  drawingSheets,
  files,
  specReferences,
  specSections,
  type DrawingTextItem,
} from "@constructos/db";
import type { Db } from "../../lib/db.js";
import type { StorageService } from "../../lib/storage.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { detectSheetMetaPositioned, nextRevisionLabel } from "./detectors.js";
import { detectCallouts, detectSpecCitations, normaliseSheetNumber } from "./callouts.js";
import { diffTextItems, type DiffResult } from "./diff.js";
import {
  EXTRACTION_ENGINE,
  EXTRACTION_VERSION,
  openPdf,
  streamToBuffer,
  type ExtractedPage,
} from "./pdf.js";

/** Sets at or under this many pages are processed inside the upload request. */
export const INLINE_PAGE_LIMIT = 40;
/** Pages one scheduler tick spends on one set. */
export const JOB_PAGE_BUDGET = 150;
/** A `processing` set whose heartbeat is older than this is treated as abandoned. */
export const STALE_LEASE_MS = 5 * 60_000;

const inFlight = new Set<string>();

export interface PipelineDeps {
  db: Db;
  storage: StorageService;
}

export interface ProcessOptions {
  /** bound on pages processed in this call; default = all remaining */
  maxPages?: number;
  /** ledger actor; null for the scheduler (system) */
  actorId: string | null;
}

export interface ProcessOutcome {
  setId: string;
  processing: string;
  pageCount: number | null;
  processedPages: number;
  sheetsCreated: number;
  revisionsAdded: number;
  autoLinksCreated: number;
  unresolvedCallouts: number;
  error: string | null;
  done: boolean;
}

type SetRow = typeof drawingSets.$inferSelect;
type RevisionRow = typeof drawingRevisions.$inferSelect;

function outcome(set: SetRow): ProcessOutcome {
  return {
    setId: set.id,
    processing: set.processing,
    pageCount: set.pageCount,
    processedPages: set.processedPages,
    sheetsCreated: set.sheetsCreated,
    revisionsAdded: set.revisionsAdded,
    autoLinksCreated: set.autoLinksCreated,
    unresolvedCallouts: set.unresolvedCallouts,
    error: set.processingError,
    done: set.processing === "ready" || set.processing === "failed",
  };
}

async function reload(db: Db, setId: string): Promise<SetRow> {
  const [row] = await db.select().from(drawingSets).where(eq(drawingSets.id, setId)).limit(1);
  if (!row) throw new Error("Drawing set vanished during processing");
  return row;
}

async function fail(deps: PipelineDeps, set: SetRow, message: string, actorId: string | null) {
  const now = new Date().toISOString();
  await deps.db
    .update(drawingSets)
    .set({ processing: "failed", processingError: message, processingFinishedAt: now })
    .where(eq(drawingSets.id, set.id));
  await appendLedger(deps.db, {
    companyId: set.companyId,
    actorId,
    action: "state_change",
    objectType: "drawing_set",
    objectId: set.id,
    payload: { processing: "failed", error: message, processedPages: set.processedPages },
    projectId: set.projectId,
  });
  return outcome(await reload(deps.db, set.id));
}

/** Loose key for tolerant sheet-number matching: "A-101" == "A101" == "A.101". */
export function looseNumber(n: string): string {
  return normaliseSheetNumber(n).replace(/[-.\s]/g, "");
}

interface PageRegistration {
  created: boolean;
  sheetId: string;
  revisionId: string;
}

async function registerPage(
  deps: PipelineDeps,
  set: SetRow,
  fileId: string,
  page: ExtractedPage,
  actorId: string | null,
): Promise<PageRegistration> {
  const { db } = deps;
  const det = detectSheetMetaPositioned(page.items, page.text);
  const pageNo = page.pageIndex + 1;
  const setShort = set.id.slice(-5).toUpperCase();
  const detectedNumber = det.number ? normaliseSheetNumber(det.number) : null;
  let number = detectedNumber ?? `UNNAMED-${pageNo}-${setShort}`;
  const title = det.title ?? (det.isIndexPage ? "DRAWING INDEX" : "UNTITLED");
  let needsReview = det.confident ? 0 : 1;
  const detection: Record<string, unknown> = {
    method: det.method,
    confidence: det.confidence,
    candidates: det.candidates,
    isIndexPage: det.isIndexPage,
    noTextLayer: det.noTextLayer,
    placeholder: detectedNumber === null,
    detectedNumber,
    detectedTitle: det.title,
    duplicateOfSheetId: null as string | null,
    reason: null as string | null,
  };
  const extraction = {
    engine: EXTRACTION_ENGINE,
    version: EXTRACTION_VERSION,
    items: page.items.length,
    truncated: page.truncated,
    hasTextLayer: page.hasTextLayer,
    pageWidth: page.width,
    pageHeight: page.height,
    ocr: null,
  };
  const now = new Date().toISOString();
  const baseRevision = {
    fileId,
    pageIndex: page.pageIndex,
    extractedText: page.text,
    textItems: page.items as DrawingTextItem[],
    hasTextLayer: page.hasTextLayer ? 1 : 0,
    detection,
    extraction,
    uploadedBy: set.uploadedBy,
  };

  let existing = detectedNumber
    ? (
        await db
          .select()
          .from(drawingSheets)
          .where(and(eq(drawingSheets.projectId, set.projectId), eq(drawingSheets.number, number)))
          .limit(1)
      )[0]
    : undefined;

  if (existing) {
    const currentRev: RevisionRow | undefined = existing.currentRevisionId
      ? (
          await db
            .select()
            .from(drawingRevisions)
            .where(eq(drawingRevisions.id, existing.currentRevisionId))
            .limit(1)
        )[0]
      : undefined;

    if (currentRev && currentRev.setId === set.id) {
      // Same set already registered this number: a duplicate inside one upload.
      detection["duplicateOfSheetId"] = existing.id;
      detection["reason"] =
        `Page ${pageNo} reads as ${number}, but page ${currentRev.pageIndex + 1} of this same set was already ` +
        `registered as ${number}. Confirm which page is the sheet, or merge this one as a revision.`;
      number = `${number}-DUP${pageNo}-${setShort}`;
      needsReview = 1;
      existing = undefined;
    } else {
      const label = nextRevisionLabel(currentRev?.revision ?? null);
      const revisionId = newId("drev");
      const diff: DiffResult | null = currentRev
        ? diffTextItems((currentRev.textItems ?? []) as DrawingTextItem[], page.items, {
            prevHasText:
              currentRev.hasTextLayer === 1 && (currentRev.textItems?.length ?? 0) > 0,
            nextHasText: page.hasTextLayer,
          })
        : null;
      await db
        .update(drawingRevisions)
        .set({ isSuperseded: 1 })
        .where(eq(drawingRevisions.sheetId, existing.id));
      await db.insert(drawingRevisions).values({
        id: revisionId,
        sheetId: existing.id,
        setId: set.id,
        revision: label,
        ...baseRevision,
        supersedesRevisionId: currentRev?.id ?? null,
        changedRegions: diff?.regions ?? null,
        changeVerdict: diff?.verdict ?? null,
        diffComputedAt: diff ? now : null,
      });
      await db
        .update(drawingSheets)
        .set({
          currentRevisionId: revisionId,
          area: existing.area ?? set.area ?? null,
          updatedAt: now,
        })
        .where(eq(drawingSheets.id, existing.id));
      await appendLedger(db, {
        companyId: set.companyId,
        actorId,
        action: "update",
        objectType: "drawing_sheet",
        objectId: existing.id,
        payload: {
          revision: label,
          setId: set.id,
          pageIndex: page.pageIndex,
          supersedes: currentRev?.id ?? null,
          changeVerdict: diff?.verdict ?? null,
          changedRegions: diff?.regions.length ?? 0,
        },
        projectId: set.projectId,
      });
      return { created: false, sheetId: existing.id, revisionId };
    }
  }

  const sheetId = newId("dsht");
  const revisionId = newId("drev");
  await db.insert(drawingSheets).values({
    id: sheetId,
    companyId: set.companyId,
    projectId: set.projectId,
    number,
    title,
    discipline: det.discipline,
    area: set.area ?? null,
    needsReview,
  });
  await db.insert(drawingRevisions).values({
    id: revisionId,
    sheetId,
    setId: set.id,
    revision: "0",
    ...baseRevision,
  });
  await db
    .update(drawingSheets)
    .set({ currentRevisionId: revisionId })
    .where(eq(drawingSheets.id, sheetId));
  await appendLedger(db, {
    companyId: set.companyId,
    actorId,
    action: "create",
    objectType: "drawing_sheet",
    objectId: sheetId,
    payload: {
      number,
      title,
      discipline: det.discipline,
      needsReview,
      setId: set.id,
      pageIndex: page.pageIndex,
      detection: { method: det.method, confidence: det.confidence },
    },
    projectId: set.projectId,
  });
  return { created: true, sheetId, revisionId };
}

/**
 * Process (or resume) a set. Safe to call repeatedly; a second concurrent
 * call in the same process returns the current state without touching it.
 */
export async function processDrawingSet(
  deps: PipelineDeps,
  setId: string,
  opts: ProcessOptions,
): Promise<ProcessOutcome> {
  const { db } = deps;
  let set = await reload(db, setId);
  if (set.processing === "ready") return outcome(set);
  if (inFlight.has(setId)) return outcome(set);
  inFlight.add(setId);
  try {
    if (!set.sourceFileId) return await fail(deps, set, "The set has no source file", opts.actorId);
    const [file] = await db.select().from(files).where(eq(files.id, set.sourceFileId)).limit(1);
    if (!file) return await fail(deps, set, "The source file is missing", opts.actorId);

    const startedAt = new Date().toISOString();
    await db
      .update(drawingSets)
      .set({ processing: "processing", processingStartedAt: startedAt, processingError: null })
      .where(eq(drawingSets.id, setId));
    set = await reload(db, setId);

    let buf: Buffer;
    try {
      buf = await streamToBuffer(deps.storage.readStream(file.storageKey));
    } catch (err) {
      return await fail(deps, set, err instanceof Error ? err.message : "Could not read the PDF", opts.actorId);
    }
    let pdf: Awaited<ReturnType<typeof openPdf>>;
    try {
      pdf = await openPdf(buf);
    } catch (err) {
      return await fail(deps, set, err instanceof Error ? err.message : "PDF could not be opened", opts.actorId);
    }
    try {
      const numPages = pdf.numPages;
      if (numPages === 0) throw new Error("PDF contains no pages");
      if (set.pageCount !== numPages) {
        await db.update(drawingSets).set({ pageCount: numPages }).where(eq(drawingSets.id, setId));
      }
      let processed = set.processedPages;
      let sheetsCreated = set.sheetsCreated;
      let revisionsAdded = set.revisionsAdded;
      const limit = Math.min(numPages, processed + (opts.maxPages ?? numPages));
      for (let p = processed; p < limit; p++) {
        const page = await pdf.page(p);
        const reg = await registerPage(deps, set, file.id, page, opts.actorId);
        if (reg.created) sheetsCreated += 1;
        revisionsAdded += 1;
        processed = p + 1;
        await db
          .update(drawingSets)
          .set({
            processedPages: processed,
            sheetsCreated,
            revisionsAdded,
            processingStartedAt: new Date().toISOString(), // heartbeat
          })
          .where(eq(drawingSets.id, setId));
      }
      if (processed >= numPages) {
        set = await reload(db, setId);
        const links = await autolinkSet(deps, set, opts.actorId);
        const finishedAt = new Date().toISOString();
        await db
          .update(drawingSets)
          .set({
            processing: "ready",
            processingFinishedAt: finishedAt,
            processingError: null,
            autoLinksCreated: links.created,
            unresolvedCallouts: links.unresolved,
          })
          .where(eq(drawingSets.id, setId));
        await appendLedger(db, {
          companyId: set.companyId,
          actorId: opts.actorId,
          action: "state_change",
          objectType: "drawing_set",
          objectId: setId,
          payload: {
            processing: "ready",
            pageCount: numPages,
            sheetsCreated,
            revisionsAdded,
            autoLinksCreated: links.created,
            unresolvedCallouts: links.unresolved,
            specReferences: links.specReferences,
          },
          projectId: set.projectId,
        });
      }
    } catch (err) {
      return await fail(deps, await reload(db, setId), err instanceof Error ? err.message : "PDF processing failed", opts.actorId);
    } finally {
      await pdf.destroy();
    }
    return outcome(await reload(db, setId));
  } finally {
    inFlight.delete(setId);
  }
}

export interface AutolinkOutcome {
  created: number;
  unresolved: number;
  specReferences: number;
  skipped: number;
}

/**
 * Callout hyperlinking pass over every revision in a set (#263). Idempotent:
 * an auto link already present for the same target at the same spot is
 * skipped, so re-running after a sheet rename only adds what changed.
 */
export async function autolinkSet(
  deps: PipelineDeps,
  set: SetRow,
  actorId: string | null,
): Promise<AutolinkOutcome> {
  const { db } = deps;
  const revisions = await db
    .select()
    .from(drawingRevisions)
    .where(eq(drawingRevisions.setId, set.id));
  const sheets = await db
    .select({
      id: drawingSheets.id,
      number: drawingSheets.number,
      title: drawingSheets.title,
    })
    .from(drawingSheets)
    .where(eq(drawingSheets.projectId, set.projectId));
  const byNumber = new Map<string, string>();
  const byLoose = new Map<string, string>();
  const sheetById = new Map(sheets.map((s) => [s.id, s] as const));
  for (const s of sheets) {
    byNumber.set(normaliseSheetNumber(s.number), s.id);
    byLoose.set(looseNumber(s.number), s.id);
  }
  const sections = await db
    .select({
      id: specSections.id,
      normalisedCode: specSections.normalisedCode,
      code: specSections.code,
      title: specSections.title,
    })
    .from(specSections)
    .where(eq(specSections.projectId, set.projectId));
  const sectionByCode = new Map(sections.map((s) => [s.normalisedCode, s] as const));

  const result: AutolinkOutcome = { created: 0, unresolved: 0, specReferences: 0, skipped: 0 };
  const revIds = revisions.map((r) => r.id);
  const existingLinks = revIds.length
    ? await db
        .select({
          fromRevisionId: drawingHyperlinks.fromRevisionId,
          targetNumber: drawingHyperlinks.targetNumber,
          x: drawingHyperlinks.x,
          y: drawingHyperlinks.y,
        })
        .from(drawingHyperlinks)
        .where(and(inArray(drawingHyperlinks.fromRevisionId, revIds), eq(drawingHyperlinks.source, "auto")))
    : [];
  const linkKeys = new Set(
    existingLinks.map((l) => `${l.fromRevisionId}|${l.targetNumber ?? ""}|${l.x.toFixed(2)}|${l.y.toFixed(2)}`),
  );

  for (const rev of revisions) {
    const items = (rev.textItems ?? []) as DrawingTextItem[];
    if (items.length === 0) continue;
    const sheet = sheetById.get(rev.sheetId);
    const callouts = detectCallouts(items, sheet?.number ?? null);
    for (const c of callouts) {
      const toSheetId =
        byNumber.get(c.targetNumber) ?? byLoose.get(looseNumber(c.targetNumber)) ?? null;
      if (toSheetId === rev.sheetId) continue;
      const key = `${rev.id}|${c.targetNumber}|${c.x.toFixed(2)}|${c.y.toFixed(2)}`;
      if (linkKeys.has(key)) {
        result.skipped += 1;
        continue;
      }
      linkKeys.add(key);
      await db.insert(drawingHyperlinks).values({
        id: newId("dhl"),
        fromRevisionId: rev.id,
        toSheetId,
        targetNumber: c.targetNumber,
        x: c.x,
        y: c.y,
        w: c.w,
        h: c.h,
        label: c.label,
        source: "auto",
        confidence: c.confidence,
        status: toSheetId ? "active" : "unresolved",
        detail: { kind: c.kind, pageIndex: rev.pageIndex },
        createdBy: actorId,
      });
      if (toSheetId) result.created += 1;
      else result.unresolved += 1;
    }

    if (sectionByCode.size > 0 && sheet) {
      const citations = detectSpecCitations(items);
      const seen = new Set<string>();
      for (const cit of citations) {
        const section = sectionByCode.get(cit.normalisedCode);
        if (!section || seen.has(section.id)) continue;
        seen.add(section.id);
        const dup = await db
          .select({ id: specReferences.id })
          .from(specReferences)
          .where(
            and(
              eq(specReferences.sectionId, section.id),
              eq(specReferences.targetType, "drawing_sheet"),
              eq(specReferences.targetId, sheet.id),
              eq(specReferences.extractionMethod, "ai_extracted"),
            ),
          )
          .limit(1);
        if (dup[0]) continue;
        await db.insert(specReferences).values({
          id: newId("sref"),
          companyId: set.companyId,
          projectId: set.projectId,
          sectionId: section.id,
          sectionRevisionId: null,
          paragraphRef: null,
          pageIndex: rev.pageIndex,
          targetType: "drawing_sheet",
          targetId: sheet.id,
          targetLabel: `${sheet.number} ${sheet.title}`,
          referenceKind: "detailed_on",
          note: `Cited on sheet ${sheet.number} as "${cit.code}" (automatic callout pass)`,
          extractionMethod: "ai_extracted",
          extractionConfidence: cit.confidence,
          detail: { rect: { x: cit.x, y: cit.y, w: cit.w, h: cit.h }, source: "drawing_callout", revisionId: rev.id },
          createdBy: actorId ?? set.uploadedBy,
        });
        result.specReferences += 1;
      }
    }
  }
  if (result.created + result.unresolved + result.specReferences > 0) {
    await appendLedger(db, {
      companyId: set.companyId,
      actorId,
      action: "update",
      objectType: "drawing_set",
      objectId: set.id,
      payload: { autolink: result },
      projectId: set.projectId,
    });
  }
  return result;
}

/**
 * Point unresolved callouts at a sheet that now exists (after a rename, a
 * review confirmation or a later upload). Returns how many were resolved.
 */
export async function resolveUnresolvedLinks(db: Db, projectId: string): Promise<number> {
  const sheets = await db
    .select({ id: drawingSheets.id, number: drawingSheets.number })
    .from(drawingSheets)
    .where(eq(drawingSheets.projectId, projectId));
  if (sheets.length === 0) return 0;
  const byNumber = new Map<string, string>();
  const byLoose = new Map<string, string>();
  for (const s of sheets) {
    byNumber.set(normaliseSheetNumber(s.number), s.id);
    byLoose.set(looseNumber(s.number), s.id);
  }
  const sheetIds = sheets.map((s) => s.id);
  const revisions = await db
    .select({ id: drawingRevisions.id, sheetId: drawingRevisions.sheetId })
    .from(drawingRevisions)
    .where(inArray(drawingRevisions.sheetId, sheetIds));
  if (revisions.length === 0) return 0;
  const revSheet = new Map(revisions.map((r) => [r.id, r.sheetId] as const));
  const unresolved = await db
    .select()
    .from(drawingHyperlinks)
    .where(
      and(
        inArray(drawingHyperlinks.fromRevisionId, revisions.map((r) => r.id)),
        eq(drawingHyperlinks.status, "unresolved"),
      ),
    );
  let resolved = 0;
  for (const link of unresolved) {
    if (!link.targetNumber) continue;
    const to =
      byNumber.get(normaliseSheetNumber(link.targetNumber)) ??
      byLoose.get(looseNumber(link.targetNumber)) ??
      null;
    if (!to || to === revSheet.get(link.fromRevisionId)) continue;
    await db
      .update(drawingHyperlinks)
      .set({ toSheetId: to, status: "active" })
      .where(eq(drawingHyperlinks.id, link.id));
    resolved += 1;
  }
  return resolved;
}

export interface RevisionDiffView extends DiffResult {
  revisionId: string;
  againstRevisionId: string;
  computedAt: string;
  stored: boolean;
}

/**
 * The diff of a revision against another revision of the same sheet. When
 * `against` is the revision it superseded, the stored result is returned (or
 * computed and stored if the ingest predates the diff).
 */
export async function computeRevisionDiff(
  db: Db,
  revision: RevisionRow,
  against: RevisionRow,
): Promise<RevisionDiffView> {
  const isStored = revision.supersedesRevisionId === against.id;
  if (isStored && revision.changedRegions && revision.changeVerdict && revision.diffComputedAt) {
    const regions = revision.changedRegions;
    return {
      revisionId: revision.id,
      againstRevisionId: against.id,
      verdict: revision.changeVerdict as DiffResult["verdict"],
      regions,
      stats: {
        prevItems: against.textItems?.length ?? 0,
        nextItems: revision.textItems?.length ?? 0,
        added: regions.filter((r) => r.kind === "added").reduce((n, r) => n + r.items, 0),
        removed: regions.filter((r) => r.kind === "removed").reduce((n, r) => n + r.items, 0),
        moved: regions.filter((r) => r.kind === "moved").reduce((n, r) => n + r.items, 0),
        common: 0,
        changeRatio: null,
      },
      basis: "Stored at ingest: the vector diff of the text layer against the revision this one superseded.",
      computedAt: revision.diffComputedAt,
      stored: true,
    };
  }
  const result = diffTextItems(
    (against.textItems ?? []) as DrawingTextItem[],
    (revision.textItems ?? []) as DrawingTextItem[],
    {
      prevHasText: against.hasTextLayer === 1 && (against.textItems?.length ?? 0) > 0,
      nextHasText: revision.hasTextLayer === 1 && (revision.textItems?.length ?? 0) > 0,
    },
  );
  const now = new Date().toISOString();
  if (isStored) {
    await db
      .update(drawingRevisions)
      .set({ changedRegions: result.regions, changeVerdict: result.verdict, diffComputedAt: now })
      .where(eq(drawingRevisions.id, revision.id));
  }
  return {
    ...result,
    revisionId: revision.id,
    againstRevisionId: against.id,
    computedAt: now,
    stored: isStored,
  };
}
