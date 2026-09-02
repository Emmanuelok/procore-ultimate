/**
 * DRAWINGS (spec Vol I §2.1, #256–#286) — tool key `drawings`.
 *
 * Sets are uploaded once and split into sheets/revisions by `pipeline.ts`
 * (inline for small sets, by the `drawings.process-sets` scheduler job for
 * large ones). On top of the register this module serves:
 *
 *   · sheet naming review queue — confirm / merge / discard (#258)
 *   · segregation rules by discipline, area or sheet (#265, #282)
 *   · the sheet PDF, range-served per revision with access logging (#278, #299)
 *   · markups with prior-revision overlay and carry-forward (#267–#270)
 *   · revision change detection: verdict + changed regions (#262)
 *   · automatic callout hyperlinks with a low-confidence review list (#263)
 *   · validated record pins and reverse lookup (#272–#276)
 *   · drawing issues: distribution with acknowledgement + reminders (#280–#281)
 *   · the drawing log report, JSON or CSV (#281)
 *
 * Authorisation: project-scoped routes carry the `drawings` tool gate; every
 * id-scoped route (`/sheets/:id`, `/revisions/:id`, `/markups/:id`,
 * `/pins/:id`, `/hyperlinks/:id`) resolves the record's project and enforces
 * the same level through `assertToolLevel`, then the segregation rules. A
 * sheet a caller may not see is a 404, never a 403.
 *
 * Deliberately not here: rasterised tiles/thumbnails and OCR (no canvas or
 * OCR engine in this runtime — pages without a text layer are recorded as
 * such and land in the review queue rather than being guessed).
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  isNotNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import type { SQL } from "drizzle-orm";
import {
  checklists,
  companyMemberships,
  drawingHyperlinks,
  drawingIssueRecipients,
  drawingIssues,
  drawingMarkups,
  drawingPins,
  drawingRevisions,
  drawingSets,
  drawingSheetPermissions,
  drawingSheets,
  fieldObservations,
  fileAccessLog,
  files,
  fileVersions,
  photos,
  punchItems,
  rfis,
  safetyInspections,
  submittals,
  users,
  type DrawingChangedRegion,
} from "@constructos/db";
import {
  DRAWING_DISCIPLINES,
  DRAWING_ISSUE_PURPOSES,
  DRAWING_PIN_RECORD_TYPES,
  SHEET_PERMISSION_LEVELS,
  SHEET_PERMISSION_SCOPES,
  SHEET_PERMISSION_SUBJECTS,
  SHEET_REVIEW_ACTIONS,
  meetsLevel,
  type LedgerAction,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { forEachCompany } from "../../lib/scheduler.js";
import type { Db } from "../../lib/db.js";
import type { StorageService } from "../../lib/storage.js";
import { pushNotifications } from "../notifications/service.js";
import { assertToolLevel, resolveToolAccess, type ResolvedAccess } from "../documents/access.js";
import { classifyPdfUpload, safeFilename } from "../documents/inbound.js";
import { nextRevisionLabel } from "./detectors.js";
import { normaliseSheetNumber } from "./callouts.js";
import { pointInRegions, shapesInRegions } from "./diff.js";
import { pdfPageCount, streamToBuffer } from "./pdf.js";
import {
  computeHiddenScopes,
  sheetGrantsStandard,
  sheetVisible,
  type HiddenScopes,
  type SheetRule,
} from "./permissions.js";
import {
  INLINE_PAGE_LIMIT,
  JOB_PAGE_BUDGET,
  STALE_LEASE_MS,
  autolinkSet,
  computeRevisionDiff,
  processDrawingSet,
  resolveUnresolvedLinks,
} from "./pipeline.js";
import { sendRanged } from "./stream.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const point = z.object({ x: z.number().finite(), y: z.number().finite() });
const color = z.string().min(1).max(32);
const width = z.number().positive().max(100);
const twoPointShape = { from: point, to: point, color, width };

/** Mirrors MarkupShape from @constructos/shared. */
const markupShapeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pen"), points: z.array(point).min(1).max(5000), color, width }),
  z.object({ kind: z.literal("line"), ...twoPointShape }),
  z.object({ kind: z.literal("arrow"), ...twoPointShape }),
  z.object({ kind: z.literal("rect"), ...twoPointShape }),
  z.object({ kind: z.literal("ellipse"), ...twoPointShape }),
  z.object({ kind: z.literal("cloud"), ...twoPointShape }),
  z.object({
    kind: z.literal("text"),
    at: point,
    text: z.string().min(1).max(2000),
    color,
    fontSize: z.number().positive().max(200),
  }),
  z.object({
    kind: z.literal("measure"),
    ...twoPointShape,
    value: z.number().finite().optional(),
    unit: z.string().max(16).optional(),
  }),
]);

const markupPutSchema = z.object({
  layer: z.literal("personal"),
  shapes: z.array(markupShapeSchema).max(1000),
});

const calibrationSchema = z.object({
  from: point,
  to: point,
  realDistance: z.number().positive().finite(),
  unit: z.string().min(1).max(16),
});

const hyperlinkCreateSchema = z.object({
  toSheetId: z.string().min(1),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
  label: z.string().max(200).optional(),
});

const hyperlinkReviewSchema = z.object({
  action: z.enum(["accept", "reject"]),
  /** accept an unresolved callout by naming the sheet it meant */
  toSheetId: z.string().max(64).optional(),
});

const pinCreateSchema = z.object({
  recordType: z.enum(DRAWING_PIN_RECORD_TYPES),
  recordId: z.string().min(1).max(64),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  locationId: z.string().max(64).nullable().optional(),
});

const sheetPatchSchema = z.object({
  number: z.string().min(1).max(50).optional(),
  title: z.string().min(1).max(300).optional(),
  discipline: z.enum(DRAWING_DISCIPLINES).optional(),
  area: z.string().max(120).nullable().optional(),
  /** confirm the detected naming → clears the review flag */
  confirmReview: z.boolean().optional(),
});

const sheetReviewSchema = z.object({
  action: z.enum(SHEET_REVIEW_ACTIONS),
  number: z.string().min(1).max(50).optional(),
  title: z.string().min(1).max(300).optional(),
  discipline: z.enum(DRAWING_DISCIPLINES).optional(),
  area: z.string().max(120).nullable().optional(),
  /** merge_into: the sheet this page is a revision of */
  targetSheetId: z.string().max(64).optional(),
});

const sheetsQuerySchema = pageQuerySchema.extend({
  discipline: z.enum(DRAWING_DISCIPLINES).optional(),
  search: z.string().max(200).optional(),
  /** full-text search over the current revision's extracted text (#287) */
  text: z.string().max(200).optional(),
  needsReview: z.enum(["0", "1", "true", "false"]).optional(),
  area: z.string().max(120).optional(),
  setId: z.string().max(64).optional(),
});

const permissionCreateSchema = z.object({
  scope: z.enum(SHEET_PERMISSION_SCOPES),
  scopeValue: z.string().min(1).max(120),
  subjectType: z.enum(SHEET_PERMISSION_SUBJECTS),
  subjectId: z.string().min(1).max(64),
  level: z.enum(SHEET_PERMISSION_LEVELS).default("read"),
});

const issueCreateSchema = z.object({
  title: z.string().min(1).max(300),
  purpose: z.enum(DRAWING_ISSUE_PURPOSES).default("for_information"),
  setId: z.string().max(64).optional(),
  sheetIds: z.array(z.string().max(64)).max(2000).optional(),
  revisionIds: z.array(z.string().max(64)).max(2000).optional(),
  recipientUserIds: z.array(z.string().max(64)).min(1).max(200),
  notes: z.string().max(5000).nullable().optional(),
  transmittalId: z.string().max(64).nullable().optional(),
});

const issuePatchSchema = issueCreateSchema.partial();

const ISSUE_REMINDER_DAYS = 3;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
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

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

type SheetRow = typeof drawingSheets.$inferSelect;
type RevisionRow = typeof drawingRevisions.$inferSelect;

/** What the viewer needs of a revision: everything except the bulky text layer. */
function slimRevision(r: RevisionRow) {
  const { extractedText: _t, textItems: _i, ...rest } = r;
  return {
    ...rest,
    textItemCount: r.textItems?.length ?? 0,
    changedRegionCount: r.changedRegions?.length ?? 0,
  };
}

export const drawingsModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("drawings", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("drawings", "standard"),
  ];
  const adminGate = [app.authenticate, app.requireCompany, app.requireTool("drawings", "admin")];
  const companyGate = [app.authenticate, app.requireCompany];
  const deps = { db: app.db, storage: app.storage };

  function ledger(
    req: FastifyRequest,
    action: LedgerAction,
    objectType: string,
    objectId: string,
    payload: unknown,
    projectId: string | null,
  ) {
    return appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action,
      objectType,
      objectId,
      payload,
      projectId,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Access: tool level + segregation                                  */
  /* ---------------------------------------------------------------- */

  interface SheetCtx {
    access: ResolvedAccess;
    hidden: HiddenScopes;
    /** company owner/admin or drawings admin: every sheet, every action */
    bypass: boolean;
  }

  async function projectRules(projectId: string): Promise<SheetRule[]> {
    const rows = await app.db
      .select()
      .from(drawingSheetPermissions)
      .where(eq(drawingSheetPermissions.projectId, projectId));
    return rows.map((r) => ({
      scope: r.scope as SheetRule["scope"],
      scopeValue: r.scopeValue,
      subjectType: r.subjectType as SheetRule["subjectType"],
      subjectId: r.subjectId,
      level: r.level as SheetRule["level"],
    }));
  }

  async function sheetContext(
    req: FastifyRequest,
    projectId: string,
    access?: ResolvedAccess,
  ): Promise<SheetCtx> {
    const a = access ?? (await resolveToolAccess(app, req, projectId, "drawings"));
    const bypass = a.bypass || a.level === "admin";
    const rules = bypass ? [] : await projectRules(projectId);
    const hidden = computeHiddenScopes(rules, { userId: req.user!.id, templateKey: a.templateKey });
    return { access: a, hidden, bypass };
  }

  const canSee = (ctx: SheetCtx, sheet: SheetRow) => ctx.bypass || sheetVisible(sheet, ctx.hidden);
  const canEdit = (ctx: SheetCtx, sheet: SheetRow) =>
    ctx.bypass || meetsLevel(ctx.access.level, "standard") || sheetGrantsStandard(sheet, ctx.hidden);

  /** Segregation as SQL, so paging and totals agree with what the caller may see. */
  function hiddenConds(ctx: SheetCtx): SQL[] {
    const conds: SQL[] = [];
    if (ctx.bypass || !ctx.hidden.anyRules) return conds;
    if (ctx.hidden.disciplines.size > 0) {
      conds.push(notInArray(drawingSheets.discipline, [...ctx.hidden.disciplines]));
    }
    if (ctx.hidden.areas.size > 0) {
      conds.push(or(isNull(drawingSheets.area), notInArray(drawingSheets.area, [...ctx.hidden.areas]))!);
    }
    if (ctx.hidden.sheetIds.size > 0) {
      conds.push(notInArray(drawingSheets.id, [...ctx.hidden.sheetIds]));
    }
    return conds;
  }

  type Wanted = "read" | "standard" | "admin";

  /** Load a sheet by id enforcing tenant, tool level and segregation. */
  async function loadSheet(req: FastifyRequest, sheetId: string, wanted: Wanted) {
    const rows = await app.db
      .select()
      .from(drawingSheets)
      .where(and(eq(drawingSheets.id, sheetId), eq(drawingSheets.companyId, req.companyId!)))
      .limit(1);
    const sheet = rows[0];
    if (!sheet) throw notFound("Sheet not found");
    const access = await assertToolLevel(app, req, sheet.projectId, "drawings", "read");
    const ctx = await sheetContext(req, sheet.projectId, access);
    if (!canSee(ctx, sheet)) throw notFound("Sheet not found");
    if (wanted === "standard" && !canEdit(ctx, sheet)) {
      throw forbidden("Requires standard access to drawings");
    }
    if (wanted === "admin" && !ctx.bypass) throw forbidden("Requires admin access to drawings");
    return { sheet, ctx };
  }

  async function loadRevision(req: FastifyRequest, revisionId: string, wanted: Wanted) {
    const rows = await app.db
      .select()
      .from(drawingRevisions)
      .where(eq(drawingRevisions.id, revisionId))
      .limit(1);
    const revision = rows[0];
    if (!revision) throw notFound("Revision not found");
    const { sheet, ctx } = await loadSheet(req, revision.sheetId, wanted);
    return { revision, sheet, ctx };
  }

  /** The ledgered `view` of a sheet's bytes (#299). */
  async function logView(req: FastifyRequest, fileId: string, projectId: string, revisionId: string) {
    await app.db.insert(fileAccessLog).values({
      id: newId("fal"),
      fileId,
      userId: req.user!.id,
      action: "view",
      companyId: req.companyId!,
      projectId,
      context: "drawing_viewer",
      version: null,
    });
    await ledger(req, "access", "drawing_revision", revisionId, { action: "view", fileId }, projectId);
  }

  async function peopleMap(ids: Iterable<string | null | undefined>) {
    const wanted = [...new Set([...ids].filter((v): v is string => Boolean(v)))];
    if (wanted.length === 0) return {} as Record<string, { id: string; name: string; email: string }>;
    const rows = await app.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, wanted));
    return Object.fromEntries(rows.map((r) => [r.id, r])) as Record<
      string,
      { id: string; name: string; email: string }
    >;
  }

  /** A pin may only point at a record that exists in the sheet's project. */
  async function resolvePinRecord(
    projectId: string,
    recordType: string,
    recordId: string,
  ): Promise<{ label: string; status: string | null } | null> {
    const pad = (n: number) => String(n).padStart(3, "0");
    switch (recordType) {
      case "rfi": {
        const [r] = await app.db
          .select({ number: rfis.number, subject: rfis.subject, status: rfis.status })
          .from(rfis)
          .where(and(eq(rfis.id, recordId), eq(rfis.projectId, projectId)))
          .limit(1);
        return r ? { label: `RFI-${pad(r.number)} ${r.subject}`, status: r.status } : null;
      }
      case "submittal": {
        const [r] = await app.db
          .select({ number: submittals.number, title: submittals.title, status: submittals.status })
          .from(submittals)
          .where(and(eq(submittals.id, recordId), eq(submittals.projectId, projectId)))
          .limit(1);
        return r ? { label: `SUB-${pad(r.number)} ${r.title}`, status: r.status } : null;
      }
      case "punch": {
        const [r] = await app.db
          .select({ number: punchItems.number, title: punchItems.title, status: punchItems.status })
          .from(punchItems)
          .where(and(eq(punchItems.id, recordId), eq(punchItems.projectId, projectId)))
          .limit(1);
        return r ? { label: `PL-${pad(r.number)} ${r.title}`, status: r.status } : null;
      }
      case "observation": {
        const [r] = await app.db
          .select({
            number: fieldObservations.number,
            title: fieldObservations.title,
            status: fieldObservations.status,
          })
          .from(fieldObservations)
          .where(and(eq(fieldObservations.id, recordId), eq(fieldObservations.projectId, projectId)))
          .limit(1);
        return r ? { label: `OBS-${pad(r.number)} ${r.title}`, status: r.status } : null;
      }
      case "photo": {
        const [r] = await app.db
          .select({ caption: photos.caption })
          .from(photos)
          .where(and(eq(photos.id, recordId), eq(photos.projectId, projectId)))
          .limit(1);
        return r ? { label: r.caption ?? "Photo", status: null } : null;
      }
      case "inspection": {
        const [s] = await app.db
          .select({ reference: safetyInspections.reference, title: safetyInspections.title, status: safetyInspections.status })
          .from(safetyInspections)
          .where(and(eq(safetyInspections.id, recordId), eq(safetyInspections.projectId, projectId)))
          .limit(1);
        if (s) return { label: `${s.reference} ${s.title}`, status: s.status };
        const [c] = await app.db
          .select({ reference: checklists.reference, title: checklists.title, status: checklists.status })
          .from(checklists)
          .where(and(eq(checklists.id, recordId), eq(checklists.projectId, projectId)))
          .limit(1);
        return c ? { label: `${c.reference} ${c.title}`, status: c.status } : null;
      }
      default:
        return null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Drawing sets (spec #256–#261, #266)                               */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/drawing-sets", { preHandler: standardGate }, async (req, reply) => {
    const mp = await req.file();
    if (!mp) throw badRequest("Expected a multipart PDF upload");
    const filename = safeFilename(mp.filename, "drawing-set.pdf");
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
    const name = fieldValue(mp.fields, "name") ?? filename.replace(/\.pdf$/i, "") ?? "Drawing set";
    const issuedDate = fieldValue(mp.fields, "issuedDate") ?? null;
    const area = fieldValue(mp.fields, "area") ?? null;
    const projectId = req.projectId!;

    const saved = await app.storage.saveBuffer(req.companyId!, buf);
    const fileId = newId("fil");
    await app.db.insert(files).values({
      id: fileId,
      companyId: req.companyId!,
      projectId,
      folderId: null,
      name: filename,
      contentType: "application/pdf",
      sizeBytes: saved.sizeBytes,
      sha256: saved.sha256,
      storageKey: saved.storageKey,
      documentType: "drawing",
      metadata: { kind: "drawing_set" },
      uploadedBy: req.user!.id,
    });
    await app.db.insert(fileVersions).values({
      id: newId("fv"),
      fileId,
      version: 1,
      contentType: "application/pdf",
      sizeBytes: saved.sizeBytes,
      sha256: saved.sha256,
      storageKey: saved.storageKey,
      uploadedBy: req.user!.id,
    });

    // Page count is an xref parse — cheap — and decides inline vs deferred.
    let pageCount: number | null = null;
    try {
      pageCount = await pdfPageCount(buf);
    } catch {
      pageCount = null; // the pipeline records the failure with its reason
    }
    const setId = newId("dset");
    await app.db.insert(drawingSets).values({
      id: setId,
      companyId: req.companyId!,
      projectId,
      name,
      issuedDate,
      area,
      processing: "pending",
      pageCount,
      sourceFileId: fileId,
      uploadedBy: req.user!.id,
    });
    await ledger(req, "create", "drawing_set", setId, { name, issuedDate, area, sha256: saved.sha256, pageCount }, projectId);

    const inline = pageCount === null || pageCount <= INLINE_PAGE_LIMIT;
    const outcome = inline
      ? await processDrawingSet(deps, setId, { actorId: req.user!.id })
      : null;
    const [row] = await app.db.select().from(drawingSets).where(eq(drawingSets.id, setId)).limit(1);
    return reply.status(201).send({
      ...row!,
      sheetsCreated: row!.sheetsCreated,
      revisionsAdded: row!.revisionsAdded,
      error: row!.processingError,
      deferred: !inline,
      note: inline
        ? null
        : `${pageCount} pages: processing continues in the background (${JOB_PAGE_BUDGET} pages per cycle); poll this set or run it now.`,
      outcome,
    });
  });

  app.get("/projects/:projectId/drawing-sets", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ processing: z.enum(["pending", "processing", "ready", "failed"]).optional() })
      .parse(req.query);
    const where = and(
      eq(drawingSets.companyId, req.companyId!),
      eq(drawingSets.projectId, req.projectId!),
      q.processing ? eq(drawingSets.processing, q.processing) : undefined,
    );
    const [totalRow] = await app.db.select({ n: count() }).from(drawingSets).where(where);
    const items = await app.db
      .select()
      .from(drawingSets)
      .where(where)
      .orderBy(desc(drawingSets.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const setIds = items.map((s) => s.id);
    const revCounts = setIds.length
      ? await app.db
          .select({ setId: drawingRevisions.setId, n: count() })
          .from(drawingRevisions)
          .where(inArray(drawingRevisions.setId, setIds))
          .groupBy(drawingRevisions.setId)
      : [];
    const countMap = new Map(revCounts.map((r) => [r.setId, Number(r.n)]));
    const people = await peopleMap(items.map((s) => s.uploadedBy));
    return paginate(
      items.map((s) => ({
        ...s,
        sheetCount: countMap.get(s.id) ?? 0,
        error: s.processingError,
        uploadedByName: people[s.uploadedBy]?.name ?? null,
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  async function fetchSet(req: FastifyRequest, setId: string) {
    const [set] = await app.db
      .select()
      .from(drawingSets)
      .where(
        and(
          eq(drawingSets.id, setId),
          eq(drawingSets.companyId, req.companyId!),
          eq(drawingSets.projectId, req.projectId!),
        ),
      )
      .limit(1);
    if (!set) throw notFound("Drawing set not found");
    return set;
  }

  /** Process (or resume) a set on demand — what operators and tests call. */
  app.post(
    "/projects/:projectId/drawing-sets/:setId/process",
    { preHandler: standardGate },
    async (req) => {
      const { setId } = req.params as { setId: string };
      const set = await fetchSet(req, setId);
      if (set.processing === "ready") {
        return { ...set, done: true, note: "This set is already fully processed." };
      }
      const outcome = await processDrawingSet(deps, setId, {
        actorId: req.user!.id,
        maxPages: JOB_PAGE_BUDGET,
      });
      return outcome;
    },
  );

  /** Re-run the callout hyperlinking pass over a set (#263). */
  app.post(
    "/projects/:projectId/drawing-sets/:setId/autolink",
    { preHandler: standardGate },
    async (req) => {
      const { setId } = req.params as { setId: string };
      const set = await fetchSet(req, setId);
      if (set.processing !== "ready") throw badRequest("Only a fully processed set can be linked");
      const result = await autolinkSet(deps, set, req.user!.id);
      const resolved = await resolveUnresolvedLinks(app.db, set.projectId);
      const [totals] = await app.db
        .select({
          created: sql<number>`count(*) filter (where ${drawingHyperlinks.status} = 'active')`,
          unresolved: sql<number>`count(*) filter (where ${drawingHyperlinks.status} = 'unresolved')`,
        })
        .from(drawingHyperlinks)
        .innerJoin(drawingRevisions, eq(drawingRevisions.id, drawingHyperlinks.fromRevisionId))
        .where(and(eq(drawingRevisions.setId, setId), eq(drawingHyperlinks.source, "auto")));
      await app.db
        .update(drawingSets)
        .set({
          autoLinksCreated: Number(totals?.created ?? 0),
          unresolvedCallouts: Number(totals?.unresolved ?? 0),
        })
        .where(eq(drawingSets.id, setId));
      return { ...result, resolvedByRerun: resolved };
    },
  );

  /**
   * Set QA report: callouts to sheets that do not exist, pages that could not
   * be named, reissued pages the diff found unchanged, low-confidence links.
   */
  app.get("/projects/:projectId/drawing-sets/:setId/qa", { preHandler: readGate }, async (req) => {
    const { setId } = req.params as { setId: string };
    const set = await fetchSet(req, setId);
    const ctx = await sheetContext(req, set.projectId);
    const revisions = await app.db
      .select()
      .from(drawingRevisions)
      .where(eq(drawingRevisions.setId, setId))
      .orderBy(asc(drawingRevisions.pageIndex));
    const sheetIds = [...new Set(revisions.map((r) => r.sheetId))];
    const sheets = sheetIds.length
      ? await app.db.select().from(drawingSheets).where(inArray(drawingSheets.id, sheetIds))
      : [];
    const sheetById = new Map(sheets.map((s) => [s.id, s] as const));
    const visible = revisions.filter((r) => {
      const s = sheetById.get(r.sheetId);
      return s ? canSee(ctx, s) : false;
    });
    const revIds = visible.map((r) => r.id);
    const links = revIds.length
      ? await app.db
          .select()
          .from(drawingHyperlinks)
          .where(and(inArray(drawingHyperlinks.fromRevisionId, revIds), eq(drawingHyperlinks.source, "auto")))
      : [];
    const revSheet = (id: string) => {
      const r = visible.find((v) => v.id === id);
      const s = r ? sheetById.get(r.sheetId) : undefined;
      return { revisionId: id, pageIndex: r?.pageIndex ?? null, sheetId: s?.id ?? null, number: s?.number ?? null, title: s?.title ?? null };
    };
    const unresolvedCallouts = links
      .filter((l) => l.status === "unresolved")
      .map((l) => ({ ...revSheet(l.fromRevisionId), linkId: l.id, targetNumber: l.targetNumber, label: l.label, confidence: l.confidence }));
    const lowConfidenceLinks = links
      .filter((l) => l.status === "active" && (l.confidence ?? 1) < 0.8)
      .map((l) => ({ ...revSheet(l.fromRevisionId), linkId: l.id, targetNumber: l.targetNumber, toSheetId: l.toSheetId, confidence: l.confidence }));
    const pagesNeedingReview = visible
      .filter((r) => sheetById.get(r.sheetId)?.needsReview === 1)
      .map((r) => ({ ...revSheet(r.id), detection: r.detection ?? null }));
    const noTextLayer = visible.filter((r) => r.hasTextLayer === 0).map((r) => revSheet(r.id));
    const unchangedReissues = visible
      .filter((r) => r.changeVerdict === "unchanged")
      .map((r) => ({ ...revSheet(r.id), revision: r.revision, supersedesRevisionId: r.supersedesRevisionId }));
    const diffUnknown = visible
      .filter((r) => r.supersedesRevisionId && r.changeVerdict === "unknown")
      .map((r) => revSheet(r.id));
    return {
      setId,
      processing: set.processing,
      processedPages: set.processedPages,
      pageCount: set.pageCount,
      summary: {
        pages: visible.length,
        unresolvedCallouts: unresolvedCallouts.length,
        lowConfidenceLinks: lowConfidenceLinks.length,
        pagesNeedingReview: pagesNeedingReview.length,
        noTextLayer: noTextLayer.length,
        unchangedReissues: unchangedReissues.length,
        diffUnknown: diffUnknown.length,
      },
      unresolvedCallouts,
      lowConfidenceLinks,
      pagesNeedingReview,
      noTextLayer,
      unchangedReissues,
      diffUnknown,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Sheets (spec #258, #260, #265, #266, #281, #287)                  */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/sheets", { preHandler: readGate }, async (req) => {
    const q = sheetsQuerySchema.parse(req.query);
    const ctx = await sheetContext(req, req.projectId!);
    const conds = [
      eq(drawingSheets.companyId, req.companyId!),
      eq(drawingSheets.projectId, req.projectId!),
      ...hiddenConds(ctx),
    ];
    if (q.discipline) conds.push(eq(drawingSheets.discipline, q.discipline));
    if (q.area) conds.push(eq(drawingSheets.area, q.area));
    if (q.needsReview !== undefined) {
      const wanted = q.needsReview === "1" || q.needsReview === "true" ? 1 : 0;
      conds.push(eq(drawingSheets.needsReview, wanted));
    }
    if (q.search) {
      const s = `%${q.search}%`;
      conds.push(or(ilike(drawingSheets.number, s), ilike(drawingSheets.title, s))!);
    }
    if (q.text) {
      conds.push(
        inArray(
          drawingSheets.currentRevisionId,
          app.db
            .select({ id: drawingRevisions.id })
            .from(drawingRevisions)
            .where(
              sql`to_tsvector('english', left(coalesce(${drawingRevisions.extractedText}, ''), 400000)) @@ plainto_tsquery('english', ${q.text})`,
            ),
        ),
      );
    }
    if (q.setId) {
      conds.push(
        inArray(
          drawingSheets.id,
          app.db
            .select({ sheetId: drawingRevisions.sheetId })
            .from(drawingRevisions)
            .where(eq(drawingRevisions.setId, q.setId)),
        ),
      );
    }
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(drawingSheets).where(where);
    const items = await app.db
      .select()
      .from(drawingSheets)
      .where(where)
      .orderBy(asc(drawingSheets.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const revIds = items.map((s) => s.currentRevisionId).filter((id): id is string => id != null);
    const revisions = revIds.length
      ? await app.db
          .select({
            id: drawingRevisions.id,
            revision: drawingRevisions.revision,
            fileId: drawingRevisions.fileId,
            pageIndex: drawingRevisions.pageIndex,
            setId: drawingRevisions.setId,
            createdAt: drawingRevisions.createdAt,
            changeVerdict: drawingRevisions.changeVerdict,
            hasTextLayer: drawingRevisions.hasTextLayer,
            supersedesRevisionId: drawingRevisions.supersedesRevisionId,
          })
          .from(drawingRevisions)
          .where(inArray(drawingRevisions.id, revIds))
      : [];
    const revMap = new Map(revisions.map((r) => [r.id, r]));
    return {
      ...paginate(
        items.map((s) => ({
          ...s,
          currentRevision: s.currentRevisionId ? (revMap.get(s.currentRevisionId) ?? null) : null,
          canEdit: canEdit(ctx, s),
        })),
        Number(totalRow?.n ?? 0),
        q,
      ),
      access: { level: ctx.bypass ? "admin" : ctx.access.level, segregated: ctx.hidden.anyRules },
    };
  });

  /** Register summary for the workspace header. */
  app.get("/projects/:projectId/drawings/summary", { preHandler: readGate }, async (req) => {
    const projectId = req.projectId!;
    const ctx = await sheetContext(req, projectId);
    const base = and(eq(drawingSheets.projectId, projectId), ...hiddenConds(ctx));
    const [sheets] = await app.db.select({ n: count() }).from(drawingSheets).where(base);
    const [review] = await app.db
      .select({ n: count() })
      .from(drawingSheets)
      .where(and(base, eq(drawingSheets.needsReview, 1)));
    const byDiscipline = await app.db
      .select({ discipline: drawingSheets.discipline, n: count() })
      .from(drawingSheets)
      .where(base)
      .groupBy(drawingSheets.discipline);
    const sets = await app.db
      .select({ processing: drawingSets.processing, n: count() })
      .from(drawingSets)
      .where(eq(drawingSets.projectId, projectId))
      .groupBy(drawingSets.processing);
    const [unresolved] = await app.db
      .select({ n: sql<number>`coalesce(sum(${drawingSets.unresolvedCallouts}), 0)` })
      .from(drawingSets)
      .where(eq(drawingSets.projectId, projectId));
    const issues = await app.db
      .select({ status: drawingIssues.status, n: count() })
      .from(drawingIssues)
      .where(eq(drawingIssues.projectId, projectId))
      .groupBy(drawingIssues.status);
    const [unacknowledged] = await app.db
      .select({ n: count() })
      .from(drawingIssueRecipients)
      .innerJoin(drawingIssues, eq(drawingIssues.id, drawingIssueRecipients.issueId))
      .where(
        and(
          eq(drawingIssues.projectId, projectId),
          eq(drawingIssues.status, "issued"),
          isNull(drawingIssueRecipients.acknowledgedAt),
        ),
      );
    return {
      sheets: Number(sheets?.n ?? 0),
      needsReview: Number(review?.n ?? 0),
      byDiscipline: Object.fromEntries(byDiscipline.map((d) => [d.discipline, Number(d.n)])),
      sets: Object.fromEntries(sets.map((s) => [s.processing, Number(s.n)])),
      unresolvedCallouts: Number(unresolved?.n ?? 0),
      issues: Object.fromEntries(issues.map((i) => [i.status, Number(i.n)])),
      unacknowledgedRecipients: Number(unacknowledged?.n ?? 0),
      segregated: ctx.hidden.anyRules,
    };
  });

  /** Health inputs for the intelligence layer (plan §3.5). */
  app.get("/projects/:projectId/drawings/health-inputs", { preHandler: readGate }, async (req) => {
    const projectId = req.projectId!;
    const [sheets] = await app.db.select({ n: count() }).from(drawingSheets).where(eq(drawingSheets.projectId, projectId));
    const [review] = await app.db
      .select({ n: count() })
      .from(drawingSheets)
      .where(and(eq(drawingSheets.projectId, projectId), eq(drawingSheets.needsReview, 1)));
    const [failed] = await app.db
      .select({ n: count() })
      .from(drawingSets)
      .where(and(eq(drawingSets.projectId, projectId), eq(drawingSets.processing, "failed")));
    const [unresolved] = await app.db
      .select({ n: sql<number>`coalesce(sum(${drawingSets.unresolvedCallouts}), 0)` })
      .from(drawingSets)
      .where(eq(drawingSets.projectId, projectId));
    const overdueBefore = new Date(Date.now() - ISSUE_REMINDER_DAYS * 86_400_000).toISOString();
    const [overdueAcks] = await app.db
      .select({ n: count() })
      .from(drawingIssueRecipients)
      .innerJoin(drawingIssues, eq(drawingIssues.id, drawingIssueRecipients.issueId))
      .where(
        and(
          eq(drawingIssues.projectId, projectId),
          eq(drawingIssues.status, "issued"),
          isNull(drawingIssueRecipients.acknowledgedAt),
          lt(drawingIssueRecipients.notifiedAt, overdueBefore),
        ),
      );
    const reasons: string[] = [];
    if (Number(sheets?.n ?? 0) === 0) reasons.push("No drawing sheets have been registered on this project.");
    return {
      metrics: {
        sheets: Number(sheets?.n ?? 0),
        sheetsNeedingReview: Number(review?.n ?? 0),
        setsFailed: Number(failed?.n ?? 0),
        unresolvedCallouts: Number(unresolved?.n ?? 0),
        overdueIssueAcknowledgements: Number(overdueAcks?.n ?? 0),
      },
      reasons,
    };
  });

  /** Drawing log report (#281): every sheet, its revisions and its distribution. */
  app.get("/projects/:projectId/sheets/log", { preHandler: readGate }, async (req, reply) => {
    const q = z.object({ format: z.enum(["json", "csv"]).default("json") }).parse(req.query);
    const projectId = req.projectId!;
    const ctx = await sheetContext(req, projectId);
    const sheets = await app.db
      .select()
      .from(drawingSheets)
      .where(and(eq(drawingSheets.companyId, req.companyId!), eq(drawingSheets.projectId, projectId), ...hiddenConds(ctx)))
      .orderBy(asc(drawingSheets.number));
    const sheetIds = sheets.map((s) => s.id);
    const revisions = sheetIds.length
      ? await app.db
          .select({
            id: drawingRevisions.id,
            sheetId: drawingRevisions.sheetId,
            setId: drawingRevisions.setId,
            revision: drawingRevisions.revision,
            createdAt: drawingRevisions.createdAt,
            changeVerdict: drawingRevisions.changeVerdict,
            isSuperseded: drawingRevisions.isSuperseded,
          })
          .from(drawingRevisions)
          .where(inArray(drawingRevisions.sheetId, sheetIds))
          .orderBy(asc(drawingRevisions.createdAt))
      : [];
    const setIds = [...new Set(revisions.map((r) => r.setId))];
    const sets = setIds.length ? await app.db.select().from(drawingSets).where(inArray(drawingSets.id, setIds)) : [];
    const setMap = new Map(sets.map((s) => [s.id, s]));
    const issued = await app.db
      .select()
      .from(drawingIssues)
      .where(and(eq(drawingIssues.projectId, projectId), eq(drawingIssues.status, "issued")))
      .orderBy(desc(drawingIssues.issuedAt));
    const issueIds = issued.map((i) => i.id);
    const recipients = issueIds.length
      ? await app.db
          .select({ issueId: drawingIssueRecipients.issueId, acknowledgedAt: drawingIssueRecipients.acknowledgedAt })
          .from(drawingIssueRecipients)
          .where(inArray(drawingIssueRecipients.issueId, issueIds))
      : [];
    const ackByIssue = new Map<string, { total: number; acknowledged: number }>();
    for (const r of recipients) {
      const e = ackByIssue.get(r.issueId) ?? { total: 0, acknowledged: 0 };
      e.total += 1;
      if (r.acknowledgedAt) e.acknowledged += 1;
      ackByIssue.set(r.issueId, e);
    }
    const issuesByRevision = new Map<string, typeof issued>();
    for (const i of issued) {
      for (const rid of i.revisionIds) {
        const list = issuesByRevision.get(rid) ?? [];
        list.push(i);
        issuesByRevision.set(rid, list);
      }
    }
    const bySheet = new Map<string, typeof revisions>();
    for (const r of revisions) {
      const list = bySheet.get(r.sheetId) ?? [];
      list.push(r);
      bySheet.set(r.sheetId, list);
    }
    const rows = sheets.map((s) => {
      const revs = bySheet.get(s.id) ?? [];
      const current = revs.find((r) => r.id === s.currentRevisionId) ?? null;
      const set = current ? setMap.get(current.setId) : undefined;
      const lastIssue = current ? (issuesByRevision.get(current.id) ?? [])[0] ?? null : null;
      const ack = lastIssue ? ackByIssue.get(lastIssue.id) : undefined;
      return {
        sheetId: s.id,
        number: s.number,
        title: s.title,
        discipline: s.discipline,
        area: s.area,
        currentRevision: current?.revision ?? null,
        currentRevisionId: current?.id ?? null,
        revisionCount: revs.length,
        issuedDate: set?.issuedDate ?? null,
        setName: set?.name ?? null,
        changeVerdict: current?.changeVerdict ?? null,
        needsReview: s.needsReview === 1,
        lastIssuedReference: lastIssue?.reference ?? null,
        lastIssuedAt: lastIssue?.issuedAt ?? null,
        lastIssuePurpose: lastIssue?.purpose ?? null,
        acknowledged: ack ? `${ack.acknowledged}/${ack.total}` : null,
        history: revs.map((r) => ({
          revisionId: r.id,
          revision: r.revision,
          setName: setMap.get(r.setId)?.name ?? null,
          issuedDate: setMap.get(r.setId)?.issuedDate ?? null,
          changeVerdict: r.changeVerdict,
          isSuperseded: r.isSuperseded === 1,
        })),
      };
    });
    if (q.format === "csv") {
      const header = ["Number", "Title", "Discipline", "Area", "Current rev", "Revisions", "Issued date", "Set", "Change", "Needs review", "Last issue", "Issued at", "Acknowledged"];
      const lines = [header.join(",")];
      for (const r of rows) {
        lines.push(
          [r.number, r.title, r.discipline, r.area, r.currentRevision, r.revisionCount, r.issuedDate, r.setName, r.changeVerdict, r.needsReview ? "yes" : "no", r.lastIssuedReference, r.lastIssuedAt, r.acknowledged]
            .map(csvCell)
            .join(","),
        );
      }
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="drawing-log.csv"`)
        .send(lines.join("\r\n"));
    }
    return { items: rows, total: rows.length, generatedAt: new Date().toISOString() };
  });

  /** Sheet naming review queue (#258): what was read, what it might be, why it is here. */
  app.get("/projects/:projectId/sheets/review", { preHandler: readGate }, async (req) => {
    const projectId = req.projectId!;
    const ctx = await sheetContext(req, projectId);
    const sheets = await app.db
      .select()
      .from(drawingSheets)
      .where(and(eq(drawingSheets.projectId, projectId), eq(drawingSheets.needsReview, 1), ...hiddenConds(ctx)))
      .orderBy(asc(drawingSheets.createdAt));
    const revIds = sheets.map((s) => s.currentRevisionId).filter((v): v is string => v != null);
    const revisions = revIds.length
      ? await app.db
          .select({
            id: drawingRevisions.id,
            setId: drawingRevisions.setId,
            pageIndex: drawingRevisions.pageIndex,
            detection: drawingRevisions.detection,
            hasTextLayer: drawingRevisions.hasTextLayer,
          })
          .from(drawingRevisions)
          .where(inArray(drawingRevisions.id, revIds))
      : [];
    const revMap = new Map(revisions.map((r) => [r.id, r]));
    const dupIds = revisions
      .map((r) => (r.detection as Record<string, unknown> | null)?.["duplicateOfSheetId"])
      .filter((v): v is string => typeof v === "string");
    const dups = dupIds.length
      ? await app.db
          .select({ id: drawingSheets.id, number: drawingSheets.number, title: drawingSheets.title })
          .from(drawingSheets)
          .where(inArray(drawingSheets.id, dupIds))
      : [];
    const dupMap = new Map(dups.map((d) => [d.id, d]));
    const setIds = [...new Set(revisions.map((r) => r.setId))];
    const sets = setIds.length
      ? await app.db.select({ id: drawingSets.id, name: drawingSets.name }).from(drawingSets).where(inArray(drawingSets.id, setIds))
      : [];
    const setMap = new Map(sets.map((s) => [s.id, s.name]));
    const items = sheets.map((s) => {
      const rev = s.currentRevisionId ? revMap.get(s.currentRevisionId) : undefined;
      const det = (rev?.detection ?? {}) as Record<string, unknown>;
      const dupId = typeof det["duplicateOfSheetId"] === "string" ? (det["duplicateOfSheetId"] as string) : null;
      return {
        ...s,
        revisionId: rev?.id ?? null,
        setId: rev?.setId ?? null,
        setName: rev ? (setMap.get(rev.setId) ?? null) : null,
        pageIndex: rev?.pageIndex ?? null,
        hasTextLayer: rev ? rev.hasTextLayer === 1 : null,
        detection: det,
        duplicateOf: dupId ? (dupMap.get(dupId) ?? null) : null,
        reason:
          typeof det["reason"] === "string"
            ? (det["reason"] as string)
            : det["noTextLayer"] === true
              ? "This page has no text layer (scanned); nothing could be read from it."
              : det["isIndexPage"] === true
                ? "This page lists many sheet numbers — it reads as a drawing index or cover."
                : det["placeholder"] === true
                  ? "No sheet number could be read from this page."
                  : "A number was read but no title was found beside it.",
      };
    });
    return { items, total: items.length };
  });

  /** Resolve one review-queue sheet: confirm its naming, merge it into a sheet, or discard it. */
  app.post(
    "/projects/:projectId/sheets/:sheetId/review",
    { preHandler: standardGate },
    async (req) => {
      const { sheetId } = req.params as { sheetId: string };
      const body = sheetReviewSchema.parse(req.body);
      const { sheet } = await loadSheet(req, sheetId, "standard");
      if (sheet.projectId !== req.projectId) throw notFound("Sheet not found");
      if (sheet.needsReview !== 1) throw conflict("This sheet is not in the review queue");
      const now = new Date().toISOString();

      if (body.action === "confirm") {
        const number = normaliseSheetNumber(body.number ?? sheet.number);
        const title = body.title ?? sheet.title;
        if (/^UNNAMED-/.test(number) || /-DUP\d+-/.test(number)) {
          throw badRequest("Give the sheet its real number before confirming it");
        }
        const dup = await app.db
          .select({ id: drawingSheets.id })
          .from(drawingSheets)
          .where(and(eq(drawingSheets.projectId, sheet.projectId), eq(drawingSheets.number, number), ne(drawingSheets.id, sheetId)))
          .limit(1);
        if (dup[0]) {
          throw conflict(`A sheet numbered ${number} already exists — merge this page into it instead`);
        }
        await app.db
          .update(drawingSheets)
          .set({
            number,
            title,
            discipline: body.discipline ?? sheet.discipline,
            area: body.area === undefined ? sheet.area : body.area,
            needsReview: 0,
            updatedAt: now,
          })
          .where(eq(drawingSheets.id, sheetId));
        const resolved = await resolveUnresolvedLinks(app.db, sheet.projectId);
        await ledger(req, "state_change", "drawing_sheet", sheetId, { review: "confirm", from: sheet.number, number, title, linksResolved: resolved }, sheet.projectId);
        const [row] = await app.db.select().from(drawingSheets).where(eq(drawingSheets.id, sheetId)).limit(1);
        return { ...row!, action: "confirm", linksResolved: resolved };
      }

      if (body.action === "merge_into") {
        if (!body.targetSheetId) throw badRequest("targetSheetId is required to merge");
        if (body.targetSheetId === sheetId) throw badRequest("A sheet cannot be merged into itself");
        const { sheet: target } = await loadSheet(req, body.targetSheetId, "standard");
        if (target.projectId !== sheet.projectId) throw badRequest("Target sheet is in another project");
        const revs = await app.db
          .select()
          .from(drawingRevisions)
          .where(eq(drawingRevisions.sheetId, sheetId))
          .orderBy(asc(drawingRevisions.createdAt));
        const [targetCurrent] = target.currentRevisionId
          ? await app.db.select().from(drawingRevisions).where(eq(drawingRevisions.id, target.currentRevisionId)).limit(1)
          : [];
        let label = targetCurrent?.revision ?? null;
        let prevId = targetCurrent?.id ?? null;
        let lastId: string | null = null;
        await app.db.update(drawingRevisions).set({ isSuperseded: 1 }).where(eq(drawingRevisions.sheetId, target.id));
        for (const r of revs) {
          label = nextRevisionLabel(label);
          await app.db
            .update(drawingRevisions)
            .set({ sheetId: target.id, revision: label, supersedesRevisionId: prevId, isSuperseded: 0 })
            .where(eq(drawingRevisions.id, r.id));
          if (lastId) await app.db.update(drawingRevisions).set({ isSuperseded: 1 }).where(eq(drawingRevisions.id, lastId));
          prevId = r.id;
          lastId = r.id;
        }
        await app.db.update(drawingMarkups).set({ sheetId: target.id }).where(eq(drawingMarkups.sheetId, sheetId));
        await app.db.update(drawingPins).set({ sheetId: target.id }).where(eq(drawingPins.sheetId, sheetId));
        await app.db.update(drawingHyperlinks).set({ toSheetId: target.id }).where(eq(drawingHyperlinks.toSheetId, sheetId));
        await app.db
          .update(drawingSheets)
          .set({ currentRevisionId: lastId ?? target.currentRevisionId, updatedAt: now })
          .where(eq(drawingSheets.id, target.id));
        await app.db.delete(drawingSheets).where(eq(drawingSheets.id, sheetId));
        // the merged page's diff against what it now supersedes
        if (lastId) {
          const [merged] = await app.db.select().from(drawingRevisions).where(eq(drawingRevisions.id, lastId)).limit(1);
          const [prev] = merged?.supersedesRevisionId
            ? await app.db.select().from(drawingRevisions).where(eq(drawingRevisions.id, merged.supersedesRevisionId)).limit(1)
            : [];
          if (merged && prev) await computeRevisionDiff(app.db, merged, prev);
        }
        await ledger(req, "state_change", "drawing_sheet", target.id, { review: "merge_into", mergedSheetId: sheetId, mergedNumber: sheet.number, revisions: revs.length, currentRevisionId: lastId }, sheet.projectId);
        await ledger(req, "delete", "drawing_sheet", sheetId, { review: "merge_into", targetSheetId: target.id }, sheet.projectId);
        const [row] = await app.db.select().from(drawingSheets).where(eq(drawingSheets.id, target.id)).limit(1);
        return { ...row!, action: "merge_into", mergedRevisions: revs.length };
      }

      // discard: a cover page, an index, a blank scan
      await deleteSheetCascade(sheetId);
      await ledger(req, "delete", "drawing_sheet", sheetId, { review: "discard", number: sheet.number, title: sheet.title }, sheet.projectId);
      return { id: sheetId, action: "discard", ok: true };
    },
  );

  async function deleteSheetCascade(sheetId: string) {
    const revisions = await app.db
      .select({ id: drawingRevisions.id })
      .from(drawingRevisions)
      .where(eq(drawingRevisions.sheetId, sheetId));
    const revIds = revisions.map((r) => r.id);
    if (revIds.length) {
      await app.db.delete(drawingMarkups).where(inArray(drawingMarkups.revisionId, revIds));
      await app.db.delete(drawingHyperlinks).where(inArray(drawingHyperlinks.fromRevisionId, revIds));
    }
    await app.db
      .update(drawingHyperlinks)
      .set({ toSheetId: null, status: "unresolved" })
      .where(eq(drawingHyperlinks.toSheetId, sheetId));
    await app.db.delete(drawingPins).where(eq(drawingPins.sheetId, sheetId));
    await app.db.delete(drawingRevisions).where(eq(drawingRevisions.sheetId, sheetId));
    await app.db.delete(drawingSheets).where(eq(drawingSheets.id, sheetId));
  }

  app.get("/sheets/:sheetId", { preHandler: companyGate }, async (req) => {
    const { sheetId } = req.params as { sheetId: string };
    const { sheet, ctx } = await loadSheet(req, sheetId, "read");
    const revisions = await app.db
      .select()
      .from(drawingRevisions)
      .where(eq(drawingRevisions.sheetId, sheetId))
      .orderBy(desc(drawingRevisions.createdAt));
    const [pinRow] = await app.db.select({ n: count() }).from(drawingPins).where(eq(drawingPins.sheetId, sheetId));
    const setIds = [...new Set(revisions.map((r) => r.setId))];
    const sets = setIds.length
      ? await app.db.select({ id: drawingSets.id, name: drawingSets.name, issuedDate: drawingSets.issuedDate }).from(drawingSets).where(inArray(drawingSets.id, setIds))
      : [];
    const setMap = new Map(sets.map((s) => [s.id, s]));
    return {
      ...sheet,
      revisions: revisions.map((r) => ({ ...slimRevision(r), set: setMap.get(r.setId) ?? null })),
      pinsCount: Number(pinRow?.n ?? 0),
      access: { canEdit: canEdit(ctx, sheet), canAdmin: ctx.bypass, level: ctx.bypass ? "admin" : ctx.access.level },
    };
  });

  app.patch("/sheets/:sheetId", { preHandler: companyGate }, async (req) => {
    const { sheetId } = req.params as { sheetId: string };
    const body = sheetPatchSchema.parse(req.body);
    const { sheet, ctx } = await loadSheet(req, sheetId, "standard");
    const number = body.number ? normaliseSheetNumber(body.number) : sheet.number;
    if (number !== sheet.number) {
      // Renumbering a confirmed sheet rewrites the register's identity: admin only.
      // Confirming a review-queue sheet's real number is the standard user's job.
      if (sheet.needsReview !== 1 && !ctx.bypass) {
        throw forbidden("Renumbering a confirmed sheet requires drawings admin; use the review queue for unconfirmed sheets");
      }
      const dup = await app.db
        .select({ id: drawingSheets.id })
        .from(drawingSheets)
        .where(and(eq(drawingSheets.projectId, sheet.projectId), eq(drawingSheets.number, number), ne(drawingSheets.id, sheetId)))
        .limit(1);
      if (dup[0]) throw conflict("A sheet with this number already exists in the project");
    }
    const clearsReview = body.confirmReview === true;
    await app.db
      .update(drawingSheets)
      .set({
        number,
        title: body.title ?? sheet.title,
        discipline: body.discipline ?? sheet.discipline,
        area: body.area === undefined ? sheet.area : body.area,
        needsReview: clearsReview ? 0 : sheet.needsReview,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(drawingSheets.id, sheetId));
    let linksResolved = 0;
    if (number !== sheet.number) linksResolved = await resolveUnresolvedLinks(app.db, sheet.projectId);
    await ledger(req, "update", "drawing_sheet", sheetId, { ...body, number, previousNumber: sheet.number, linksResolved }, sheet.projectId);
    const [updated] = await app.db.select().from(drawingSheets).where(eq(drawingSheets.id, sheetId)).limit(1);
    return updated;
  });

  app.delete("/sheets/:sheetId", { preHandler: companyGate }, async (req) => {
    const { sheetId } = req.params as { sheetId: string };
    const { sheet } = await loadSheet(req, sheetId, "admin");
    await deleteSheetCascade(sheetId);
    await ledger(req, "delete", "drawing_sheet", sheetId, { number: sheet.number, title: sheet.title }, sheet.projectId);
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* Revision PDF (spec #278, #299) — range-served, access-logged      */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/revisions/:revisionId/pdf",
    { preHandler: readGate },
    async (req, reply) => {
      const { revisionId } = req.params as { revisionId: string };
      const { revision, sheet } = await loadRevision(req, revisionId, "read");
      if (sheet.projectId !== req.projectId) throw notFound("Revision not found");
      const [f] = await app.db
        .select()
        .from(files)
        .where(and(eq(files.id, revision.fileId), eq(files.companyId, req.companyId!)))
        .limit(1);
      if (!f) throw notFound("The revision's source file is missing");
      if (!req.headers.range) await logView(req, f.id, sheet.projectId, revisionId);
      return sendRanged(app.storage, req, reply, {
        storageKey: f.storageKey,
        sizeBytes: f.sizeBytes,
        contentType: "application/pdf",
        filename: `${sheet.number}-rev${revision.revision}.pdf`,
        sha256: f.sha256,
      });
    },
  );

  app.get("/projects/:projectId/revisions/:revisionId", { preHandler: readGate }, async (req) => {
    const { revisionId } = req.params as { revisionId: string };
    const { revision, sheet } = await loadRevision(req, revisionId, "read");
    if (sheet.projectId !== req.projectId) throw notFound("Revision not found");
    return { ...slimRevision(revision), sheet: { id: sheet.id, number: sheet.number, title: sheet.title } };
  });

  /* ---------------------------------------------------------------- */
  /* Revision diff (spec #262)                                         */
  /* ---------------------------------------------------------------- */

  app.get("/revisions/:revisionId/diff", { preHandler: companyGate }, async (req) => {
    const { revisionId } = req.params as { revisionId: string };
    const q = z.object({ against: z.string().max(64).optional() }).parse(req.query);
    const { revision, sheet } = await loadRevision(req, revisionId, "read");
    let against: RevisionRow | undefined;
    if (q.against) {
      [against] = await app.db.select().from(drawingRevisions).where(eq(drawingRevisions.id, q.against)).limit(1);
      if (!against || against.sheetId !== sheet.id) throw badRequest("The comparison revision must belong to the same sheet");
    } else if (revision.supersedesRevisionId) {
      [against] = await app.db.select().from(drawingRevisions).where(eq(drawingRevisions.id, revision.supersedesRevisionId)).limit(1);
    } else {
      [against] = await app.db
        .select()
        .from(drawingRevisions)
        .where(and(eq(drawingRevisions.sheetId, sheet.id), lt(drawingRevisions.createdAt, revision.createdAt)))
        .orderBy(desc(drawingRevisions.createdAt))
        .limit(1);
    }
    if (!against) {
      return {
        revisionId,
        againstRevisionId: null,
        verdict: "unknown",
        regions: [] as DrawingChangedRegion[],
        stats: null,
        basis: "This is the first revision of the sheet; there is nothing to compare it against.",
        computedAt: null,
        stored: false,
        pinsInChangedRegions: [],
      };
    }
    const diff = await computeRevisionDiff(app.db, revision, against);
    const pins = await app.db.select().from(drawingPins).where(eq(drawingPins.sheetId, sheet.id));
    const pinsInChangedRegions = pins
      .filter((p) => pointInRegions({ x: p.x, y: p.y }, diff.regions))
      .map((p) => ({ id: p.id, recordType: p.recordType, recordId: p.recordId, label: p.label, x: p.x, y: p.y }));
    return { ...diff, against: { id: against.id, revision: against.revision }, pinsInChangedRegions };
  });

  /* ---------------------------------------------------------------- */
  /* Markups (spec #267–#270)                                          */
  /* ---------------------------------------------------------------- */

  app.get("/revisions/:revisionId/markups", { preHandler: companyGate }, async (req) => {
    const { revisionId } = req.params as { revisionId: string };
    const q = z
      .object({
        layer: z.enum(["personal", "published"]).optional(),
        /** also return published layers from the sheet's other revisions (#269) */
        includePrior: z.enum(["0", "1"]).optional(),
      })
      .parse(req.query);
    const { revision, sheet } = await loadRevision(req, revisionId, "read");
    const visible = or(
      eq(drawingMarkups.layer, "published"),
      and(eq(drawingMarkups.layer, "personal"), eq(drawingMarkups.authorId, req.user!.id)),
    )!;
    const where = q.layer
      ? and(eq(drawingMarkups.revisionId, revisionId), eq(drawingMarkups.layer, q.layer), visible)
      : and(eq(drawingMarkups.revisionId, revisionId), visible);
    const items = await app.db.select().from(drawingMarkups).where(where).orderBy(asc(drawingMarkups.createdAt));
    let prior: Array<Record<string, unknown>> = [];
    if (q.includePrior === "1") {
      const others = await app.db
        .select({ id: drawingRevisions.id, revision: drawingRevisions.revision, createdAt: drawingRevisions.createdAt })
        .from(drawingRevisions)
        .where(and(eq(drawingRevisions.sheetId, sheet.id), ne(drawingRevisions.id, revisionId)));
      const otherIds = others.map((o) => o.id);
      const label = new Map(others.map((o) => [o.id, o.revision]));
      const rows = otherIds.length
        ? await app.db
            .select()
            .from(drawingMarkups)
            .where(and(inArray(drawingMarkups.revisionId, otherIds), eq(drawingMarkups.layer, "published")))
            .orderBy(asc(drawingMarkups.createdAt))
        : [];
      prior = rows.map((m) => ({ ...m, prior: true, revisionLabel: label.get(m.revisionId) ?? null }));
    }
    const people = await peopleMap([...items.map((m) => m.authorId), ...prior.map((m) => m["authorId"] as string)]);
    return {
      items: items.map((m) => ({ ...m, prior: false, revisionLabel: revision.revision, authorName: people[m.authorId]?.name ?? null })),
      prior: prior.map((m) => ({ ...m, authorName: people[m["authorId"] as string]?.name ?? null })),
      total: items.length,
      changedRegions: revision.changedRegions ?? [],
    };
  });

  app.put("/revisions/:revisionId/markups", { preHandler: companyGate }, async (req) => {
    const { revisionId } = req.params as { revisionId: string };
    const body = markupPutSchema.parse(req.body);
    const { revision } = await loadRevision(req, revisionId, "read");
    const [existing] = await app.db
      .select()
      .from(drawingMarkups)
      .where(and(eq(drawingMarkups.revisionId, revisionId), eq(drawingMarkups.authorId, req.user!.id), eq(drawingMarkups.layer, "personal")))
      .limit(1);
    if (existing) {
      await app.db
        .update(drawingMarkups)
        .set({ shapes: body.shapes, updatedAt: new Date().toISOString() })
        .where(eq(drawingMarkups.id, existing.id));
      const [updated] = await app.db.select().from(drawingMarkups).where(eq(drawingMarkups.id, existing.id)).limit(1);
      return updated;
    }
    const id = newId("mkp");
    await app.db.insert(drawingMarkups).values({
      id,
      sheetId: revision.sheetId,
      revisionId,
      authorId: req.user!.id,
      layer: "personal",
      shapes: body.shapes,
    });
    const [created] = await app.db.select().from(drawingMarkups).where(eq(drawingMarkups.id, id)).limit(1);
    return created;
  });

  app.post("/markups/:markupId/publish", { preHandler: companyGate }, async (req) => {
    const { markupId } = req.params as { markupId: string };
    const [markup] = await app.db.select().from(drawingMarkups).where(eq(drawingMarkups.id, markupId)).limit(1);
    if (!markup) throw notFound("Markup not found");
    const { sheet } = await loadRevision(req, markup.revisionId, "standard");
    if (markup.authorId !== req.user!.id) throw forbidden("Only the author can publish their personal layer");
    if (markup.layer !== "personal") throw conflict("Markup is already published");
    await app.db
      .update(drawingMarkups)
      .set({ layer: "published", updatedAt: new Date().toISOString() })
      .where(eq(drawingMarkups.id, markupId));
    await ledger(req, "state_change", "drawing_markup", markupId, { layer: "published", revisionId: markup.revisionId, shapes: markup.shapes.length }, sheet.projectId);
    const [updated] = await app.db.select().from(drawingMarkups).where(eq(drawingMarkups.id, markupId)).limit(1);
    return updated;
  });

  /**
   * Carry published markups forward from the superseded revision (#269):
   * one published layer on this revision, tagged with where it came from,
   * with every shape that lands inside a changed region flagged for review.
   */
  app.post("/revisions/:revisionId/markups/carry-forward", { preHandler: companyGate }, async (req) => {
    const { revisionId } = req.params as { revisionId: string };
    const body = z.object({ fromRevisionId: z.string().max(64).optional() }).parse(req.body ?? {});
    const { revision, sheet } = await loadRevision(req, revisionId, "standard");
    const fromId = body.fromRevisionId ?? revision.supersedesRevisionId;
    if (!fromId) throw badRequest("This revision supersedes nothing; name the revision to carry markups from");
    const [from] = await app.db.select().from(drawingRevisions).where(eq(drawingRevisions.id, fromId)).limit(1);
    if (!from || from.sheetId !== sheet.id) throw badRequest("Markups can only be carried between revisions of the same sheet");
    if (from.id === revision.id) throw badRequest("A revision cannot carry markups from itself");
    const [already] = await app.db
      .select()
      .from(drawingMarkups)
      .where(and(eq(drawingMarkups.revisionId, revisionId), eq(drawingMarkups.carriedFromRevisionId, fromId)))
      .limit(1);
    if (already) throw conflict(`Markups from revision ${from.revision} were already carried forward`);
    const published = await app.db
      .select()
      .from(drawingMarkups)
      .where(and(eq(drawingMarkups.revisionId, fromId), eq(drawingMarkups.layer, "published")));
    const shapes = published.flatMap((m) => m.shapes);
    if (shapes.length === 0) throw badRequest(`Revision ${from.revision} has no published markups to carry forward`);
    const regions = (revision.changedRegions ?? []) as DrawingChangedRegion[];
    const reviewFlags = shapesInRegions(shapes, regions);
    const id = newId("mkp");
    await app.db.insert(drawingMarkups).values({
      id,
      sheetId: sheet.id,
      revisionId,
      authorId: req.user!.id,
      layer: "published",
      shapes,
      carriedFromRevisionId: fromId,
      reviewFlags,
    });
    await ledger(req, "create", "drawing_markup", id, { carriedFromRevisionId: fromId, revisionId, shapes: shapes.length, flagged: reviewFlags.length }, sheet.projectId);
    const [created] = await app.db.select().from(drawingMarkups).where(eq(drawingMarkups.id, id)).limit(1);
    return {
      ...created!,
      fromRevision: from.revision,
      basis:
        regions.length === 0
          ? "No changed regions are recorded on this revision, so no carried shape was flagged."
          : `${reviewFlags.length} of ${shapes.length} shape(s) overlap a changed region and are flagged for review.`,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Calibration (spec #271)                                           */
  /* ---------------------------------------------------------------- */

  app.put("/revisions/:revisionId/calibration", { preHandler: companyGate }, async (req) => {
    const { revisionId } = req.params as { revisionId: string };
    const body = calibrationSchema.parse(req.body);
    const { revision, sheet } = await loadRevision(req, revisionId, "standard");
    await app.db.update(drawingRevisions).set({ calibration: body }).where(eq(drawingRevisions.id, revisionId));
    await ledger(req, "update", "drawing_revision", revisionId, { calibration: body, previous: revision.calibration ?? null }, sheet.projectId);
    return { ok: true, calibration: body };
  });

  /* ---------------------------------------------------------------- */
  /* Hyperlinks (spec #263, #264)                                      */
  /* ---------------------------------------------------------------- */

  app.get("/revisions/:revisionId/hyperlinks", { preHandler: companyGate }, async (req) => {
    const { revisionId } = req.params as { revisionId: string };
    const q = z.object({ status: z.enum(["active", "unresolved", "rejected"]).optional() }).parse(req.query);
    const { sheet, ctx } = await loadRevision(req, revisionId, "read");
    const rows = await app.db
      .select()
      .from(drawingHyperlinks)
      .where(and(eq(drawingHyperlinks.fromRevisionId, revisionId), q.status ? eq(drawingHyperlinks.status, q.status) : ne(drawingHyperlinks.status, "rejected")))
      .orderBy(asc(drawingHyperlinks.createdAt));
    const targetIds = [...new Set(rows.map((r) => r.toSheetId).filter((v): v is string => v != null))];
    const targets = targetIds.length ? await app.db.select().from(drawingSheets).where(inArray(drawingSheets.id, targetIds)) : [];
    const targetMap = new Map(targets.map((t) => [t.id, t]));
    const items = rows.map((r) => {
      const t = r.toSheetId ? targetMap.get(r.toSheetId) : undefined;
      // a link into a sheet the caller may not see is shown as unresolved
      const seeable = t ? canSee(ctx, t) : false;
      return {
        ...r,
        toSheetId: seeable ? r.toSheetId : null,
        status: seeable || !r.toSheetId ? r.status : "unresolved",
        target: seeable && t ? { id: t.id, number: t.number, title: t.title, currentRevisionId: t.currentRevisionId } : null,
      };
    });
    return { items, total: items.length, sheetId: sheet.id };
  });

  app.post("/revisions/:revisionId/hyperlinks", { preHandler: companyGate }, async (req, reply) => {
    const { revisionId } = req.params as { revisionId: string };
    const body = hyperlinkCreateSchema.parse(req.body);
    const { sheet } = await loadRevision(req, revisionId, "standard");
    const [target] = await app.db.select().from(drawingSheets).where(and(eq(drawingSheets.id, body.toSheetId), eq(drawingSheets.companyId, req.companyId!))).limit(1);
    if (!target || target.projectId !== sheet.projectId) {
      throw badRequest("Hyperlink target must be a sheet in the same project");
    }
    const id = newId("dhl");
    await app.db.insert(drawingHyperlinks).values({
      id,
      fromRevisionId: revisionId,
      toSheetId: body.toSheetId,
      targetNumber: target.number,
      x: body.x,
      y: body.y,
      w: body.w,
      h: body.h,
      label: body.label ?? null,
      source: "manual",
      confidence: null,
      status: "active",
      createdBy: req.user!.id,
    });
    await ledger(req, "create", "drawing_hyperlink", id, { fromRevisionId: revisionId, toSheetId: body.toSheetId }, sheet.projectId);
    const [created] = await app.db.select().from(drawingHyperlinks).where(eq(drawingHyperlinks.id, id)).limit(1);
    return reply.status(201).send(created);
  });

  app.delete("/revisions/:revisionId/hyperlinks/:linkId", { preHandler: companyGate }, async (req) => {
    const { revisionId, linkId } = req.params as { revisionId: string; linkId: string };
    const { sheet } = await loadRevision(req, revisionId, "standard");
    const [row] = await app.db
      .select()
      .from(drawingHyperlinks)
      .where(and(eq(drawingHyperlinks.id, linkId), eq(drawingHyperlinks.fromRevisionId, revisionId)))
      .limit(1);
    if (!row) throw notFound("Hyperlink not found");
    await app.db.delete(drawingHyperlinks).where(eq(drawingHyperlinks.id, linkId));
    await ledger(req, "delete", "drawing_hyperlink", linkId, { fromRevisionId: revisionId, source: row.source }, sheet.projectId);
    return { ok: true };
  });

  /** Low-confidence and unresolved automatic links awaiting a person (#263). */
  app.get("/projects/:projectId/hyperlinks/review", { preHandler: readGate }, async (req) => {
    const projectId = req.projectId!;
    const ctx = await sheetContext(req, projectId);
    const rows = await app.db
      .select({
        link: drawingHyperlinks,
        sheetId: drawingSheets.id,
        number: drawingSheets.number,
        title: drawingSheets.title,
        discipline: drawingSheets.discipline,
        area: drawingSheets.area,
        revision: drawingRevisions.revision,
        pageIndex: drawingRevisions.pageIndex,
      })
      .from(drawingHyperlinks)
      .innerJoin(drawingRevisions, eq(drawingRevisions.id, drawingHyperlinks.fromRevisionId))
      .innerJoin(drawingSheets, eq(drawingSheets.id, drawingRevisions.sheetId))
      .where(
        and(
          eq(drawingSheets.projectId, projectId),
          eq(drawingHyperlinks.source, "auto"),
          or(eq(drawingHyperlinks.status, "unresolved"), and(eq(drawingHyperlinks.status, "active"), lt(drawingHyperlinks.confidence, 0.8)))!,
          sql`coalesce((${drawingHyperlinks.detail}->>'confirmed')::boolean, false) = false`,
        ),
      )
      .orderBy(asc(drawingHyperlinks.confidence), asc(drawingSheets.number));
    const items = rows
      .filter((r) => canSee(ctx, { id: r.sheetId, discipline: r.discipline, area: r.area } as SheetRow))
      .map((r) => ({
        ...r.link,
        from: { sheetId: r.sheetId, number: r.number, title: r.title, revision: r.revision, pageIndex: r.pageIndex },
        reason: r.link.status === "unresolved" ? `No sheet numbered ${r.link.targetNumber} exists in this project` : `Read at ${Math.round((r.link.confidence ?? 0) * 100)}% confidence`,
      }));
    return { items, total: items.length };
  });

  app.post("/hyperlinks/:linkId/review", { preHandler: companyGate }, async (req) => {
    const { linkId } = req.params as { linkId: string };
    const body = hyperlinkReviewSchema.parse(req.body);
    const [link] = await app.db.select().from(drawingHyperlinks).where(eq(drawingHyperlinks.id, linkId)).limit(1);
    if (!link) throw notFound("Hyperlink not found");
    const { sheet } = await loadRevision(req, link.fromRevisionId, "standard");
    const now = new Date().toISOString();
    if (body.action === "reject") {
      await app.db
        .update(drawingHyperlinks)
        .set({ status: "rejected", detail: { ...link.detail, reviewedBy: req.user!.id, reviewedAt: now } })
        .where(eq(drawingHyperlinks.id, linkId));
    } else {
      let toSheetId = body.toSheetId ?? link.toSheetId;
      if (!toSheetId && link.targetNumber) {
        const [t] = await app.db
          .select({ id: drawingSheets.id })
          .from(drawingSheets)
          .where(and(eq(drawingSheets.projectId, sheet.projectId), eq(drawingSheets.number, normaliseSheetNumber(link.targetNumber))))
          .limit(1);
        toSheetId = t?.id ?? null;
      }
      if (!toSheetId) throw badRequest("Name the sheet this callout points at (toSheetId) to accept it");
      const [target] = await app.db.select().from(drawingSheets).where(eq(drawingSheets.id, toSheetId)).limit(1);
      if (!target || target.projectId !== sheet.projectId) throw badRequest("Target must be a sheet in the same project");
      await app.db
        .update(drawingHyperlinks)
        .set({ toSheetId, status: "active", detail: { ...link.detail, confirmed: true, reviewedBy: req.user!.id, reviewedAt: now } })
        .where(eq(drawingHyperlinks.id, linkId));
    }
    await ledger(req, "state_change", "drawing_hyperlink", linkId, { review: body.action, toSheetId: body.toSheetId ?? link.toSheetId, confidence: link.confidence }, sheet.projectId);
    const [updated] = await app.db.select().from(drawingHyperlinks).where(eq(drawingHyperlinks.id, linkId)).limit(1);
    return updated;
  });

  /* ---------------------------------------------------------------- */
  /* Pins (spec #272–#276)                                             */
  /* ---------------------------------------------------------------- */

  app.post("/sheets/:sheetId/pins", { preHandler: companyGate }, async (req, reply) => {
    const { sheetId } = req.params as { sheetId: string };
    const body = pinCreateSchema.parse(req.body);
    const { sheet } = await loadSheet(req, sheetId, "standard");
    const record = await resolvePinRecord(sheet.projectId, body.recordType, body.recordId);
    if (!record) {
      throw badRequest(`No ${body.recordType} with id ${body.recordId} exists on this project`);
    }
    const id = newId("pin");
    await app.db.insert(drawingPins).values({
      id,
      sheetId,
      recordType: body.recordType,
      recordId: body.recordId,
      x: body.x,
      y: body.y,
      label: record.label,
      locationId: body.locationId ?? null,
      createdBy: req.user!.id,
    });
    await ledger(req, "create", "drawing_pin", id, { sheetId, ...body, label: record.label }, sheet.projectId);
    const [created] = await app.db.select().from(drawingPins).where(eq(drawingPins.id, id)).limit(1);
    return reply.status(201).send({ ...created!, recordStatus: record.status });
  });

  app.get("/sheets/:sheetId/pins", { preHandler: companyGate }, async (req) => {
    const { sheetId } = req.params as { sheetId: string };
    await loadSheet(req, sheetId, "read");
    const items = await app.db.select().from(drawingPins).where(eq(drawingPins.sheetId, sheetId)).orderBy(asc(drawingPins.createdAt));
    return { items, total: items.length };
  });

  app.delete("/pins/:pinId", { preHandler: companyGate }, async (req) => {
    const { pinId } = req.params as { pinId: string };
    const [pin] = await app.db.select().from(drawingPins).where(eq(drawingPins.id, pinId)).limit(1);
    if (!pin) throw notFound("Pin not found");
    const { sheet } = await loadSheet(req, pin.sheetId, "standard");
    await app.db.delete(drawingPins).where(eq(drawingPins.id, pinId));
    await ledger(req, "delete", "drawing_pin", pinId, { sheetId: pin.sheetId, recordType: pin.recordType, recordId: pin.recordId }, sheet.projectId);
    return { ok: true };
  });

  /** Reverse lookup: where is this record pinned? ("Pinned on A-101 rev B") */
  app.get("/projects/:projectId/pins", { preHandler: readGate }, async (req) => {
    const q = z
      .object({ recordType: z.enum(DRAWING_PIN_RECORD_TYPES).optional(), recordId: z.string().max(64).optional() })
      .parse(req.query);
    const ctx = await sheetContext(req, req.projectId!);
    const conds = [eq(drawingSheets.companyId, req.companyId!), eq(drawingSheets.projectId, req.projectId!), ...hiddenConds(ctx)];
    if (q.recordType) conds.push(eq(drawingPins.recordType, q.recordType));
    if (q.recordId) conds.push(eq(drawingPins.recordId, q.recordId));
    const rows = await app.db
      .select({
        id: drawingPins.id,
        sheetId: drawingPins.sheetId,
        recordType: drawingPins.recordType,
        recordId: drawingPins.recordId,
        label: drawingPins.label,
        locationId: drawingPins.locationId,
        x: drawingPins.x,
        y: drawingPins.y,
        createdBy: drawingPins.createdBy,
        createdAt: drawingPins.createdAt,
        sheetNumber: drawingSheets.number,
        sheetTitle: drawingSheets.title,
        currentRevisionId: drawingSheets.currentRevisionId,
        currentRevision: drawingRevisions.revision,
      })
      .from(drawingPins)
      .innerJoin(drawingSheets, eq(drawingSheets.id, drawingPins.sheetId))
      .leftJoin(drawingRevisions, eq(drawingRevisions.id, drawingSheets.currentRevisionId))
      .where(and(...conds))
      .orderBy(asc(drawingPins.createdAt));
    return {
      items: rows.map((r) => ({ ...r, pinnedOn: `${r.sheetNumber}${r.currentRevision ? ` rev ${r.currentRevision}` : ""}` })),
      total: rows.length,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Segregation rules (spec #265, #282)                               */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/drawing-permissions", { preHandler: adminGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(drawingSheetPermissions)
      .where(eq(drawingSheetPermissions.projectId, req.projectId!))
      .orderBy(asc(drawingSheetPermissions.scope), asc(drawingSheetPermissions.scopeValue));
    const people = await peopleMap(rows.filter((r) => r.subjectType === "user").map((r) => r.subjectId));
    const sheetIds = rows.filter((r) => r.scope === "sheet").map((r) => r.scopeValue);
    const sheets = sheetIds.length
      ? await app.db.select({ id: drawingSheets.id, number: drawingSheets.number }).from(drawingSheets).where(inArray(drawingSheets.id, sheetIds))
      : [];
    const sheetMap = new Map(sheets.map((s) => [s.id, s.number]));
    const areas = await app.db
      .selectDistinct({ area: drawingSheets.area })
      .from(drawingSheets)
      .where(and(eq(drawingSheets.projectId, req.projectId!), isNotNull(drawingSheets.area)));
    return {
      items: rows.map((r) => ({
        ...r,
        subjectName: r.subjectType === "user" ? (people[r.subjectId]?.name ?? null) : r.subjectId,
        scopeLabel: r.scope === "sheet" ? (sheetMap.get(r.scopeValue) ?? r.scopeValue) : r.scopeValue,
      })),
      total: rows.length,
      areas: areas.map((a) => a.area).filter((a): a is string => a != null),
      note: "A scope with any rule is restricted to the subjects listed for it; company and drawings admins always see every sheet.",
    };
  });

  app.post("/projects/:projectId/drawing-permissions", { preHandler: adminGate }, async (req, reply) => {
    const body = permissionCreateSchema.parse(req.body);
    const projectId = req.projectId!;
    if (body.scope === "discipline" && !(DRAWING_DISCIPLINES as readonly string[]).includes(body.scopeValue)) {
      throw badRequest("scopeValue must be a drawing discipline");
    }
    if (body.scope === "sheet") {
      const [s] = await app.db.select({ id: drawingSheets.id }).from(drawingSheets).where(and(eq(drawingSheets.id, body.scopeValue), eq(drawingSheets.projectId, projectId))).limit(1);
      if (!s) throw notFound("Sheet not found on this project");
    }
    if (body.subjectType === "user") {
      const [m] = await app.db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(and(eq(companyMemberships.companyId, req.companyId!), eq(companyMemberships.userId, body.subjectId)))
        .limit(1);
      if (!m) throw notFound("Subject user is not a member of this company");
    }
    const [dup] = await app.db
      .select({ id: drawingSheetPermissions.id })
      .from(drawingSheetPermissions)
      .where(
        and(
          eq(drawingSheetPermissions.projectId, projectId),
          eq(drawingSheetPermissions.scope, body.scope),
          eq(drawingSheetPermissions.scopeValue, body.scopeValue),
          eq(drawingSheetPermissions.subjectType, body.subjectType),
          eq(drawingSheetPermissions.subjectId, body.subjectId),
        ),
      )
      .limit(1);
    if (dup) throw conflict("This rule already exists");
    const id = newId("dsp");
    await app.db.insert(drawingSheetPermissions).values({ id, companyId: req.companyId!, projectId, ...body, createdBy: req.user!.id });
    await ledger(req, "create", "drawing_sheet_permission", id, body, projectId);
    const [row] = await app.db.select().from(drawingSheetPermissions).where(eq(drawingSheetPermissions.id, id)).limit(1);
    return reply.status(201).send(row);
  });

  app.delete("/projects/:projectId/drawing-permissions/:ruleId", { preHandler: adminGate }, async (req) => {
    const { ruleId } = req.params as { ruleId: string };
    const [row] = await app.db
      .select()
      .from(drawingSheetPermissions)
      .where(and(eq(drawingSheetPermissions.id, ruleId), eq(drawingSheetPermissions.projectId, req.projectId!)))
      .limit(1);
    if (!row) throw notFound("Rule not found");
    await app.db.delete(drawingSheetPermissions).where(eq(drawingSheetPermissions.id, ruleId));
    await ledger(req, "delete", "drawing_sheet_permission", ruleId, { scope: row.scope, scopeValue: row.scopeValue, subjectId: row.subjectId }, req.projectId!);
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* Drawing issues (spec #280–#281)                                   */
  /* ---------------------------------------------------------------- */

  async function fetchIssue(req: FastifyRequest, issueId: string) {
    const [row] = await app.db
      .select()
      .from(drawingIssues)
      .where(and(eq(drawingIssues.id, issueId), eq(drawingIssues.companyId, req.companyId!), eq(drawingIssues.projectId, req.projectId!)))
      .limit(1);
    if (!row) throw notFound("Drawing issue not found");
    return row;
  }

  /** Turn the caller's set / sheet / revision selection into the exact revisions issued. */
  async function resolveIssueRevisions(
    projectId: string,
    body: { setId?: string | undefined; sheetIds?: string[] | undefined; revisionIds?: string[] | undefined },
  ): Promise<string[]> {
    const ids = new Set<string>();
    if (body.setId) {
      const [set] = await app.db.select({ id: drawingSets.id }).from(drawingSets).where(and(eq(drawingSets.id, body.setId), eq(drawingSets.projectId, projectId))).limit(1);
      if (!set) throw notFound("Drawing set not found on this project");
      const revs = await app.db.select({ id: drawingRevisions.id }).from(drawingRevisions).where(eq(drawingRevisions.setId, body.setId));
      for (const r of revs) ids.add(r.id);
    }
    if (body.sheetIds?.length) {
      const sheets = await app.db
        .select({ id: drawingSheets.id, currentRevisionId: drawingSheets.currentRevisionId })
        .from(drawingSheets)
        .where(and(eq(drawingSheets.projectId, projectId), inArray(drawingSheets.id, body.sheetIds)));
      if (sheets.length !== new Set(body.sheetIds).size) throw badRequest("One or more sheets do not belong to this project");
      for (const s of sheets) if (s.currentRevisionId) ids.add(s.currentRevisionId);
    }
    if (body.revisionIds?.length) {
      const revs = await app.db
        .select({ id: drawingRevisions.id, projectId: drawingSheets.projectId })
        .from(drawingRevisions)
        .innerJoin(drawingSheets, eq(drawingSheets.id, drawingRevisions.sheetId))
        .where(inArray(drawingRevisions.id, body.revisionIds));
      if (revs.length !== new Set(body.revisionIds).size || revs.some((r) => r.projectId !== projectId)) {
        throw badRequest("One or more revisions do not belong to this project");
      }
      for (const r of revs) ids.add(r.id);
    }
    return [...ids];
  }

  async function assertRecipients(req: FastifyRequest, userIds: string[]) {
    const unique = [...new Set(userIds)];
    const members = await app.db
      .select({ userId: companyMemberships.userId })
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, req.companyId!), inArray(companyMemberships.userId, unique)));
    if (members.length !== unique.length) throw badRequest("Every recipient must be a member of this company");
    return unique;
  }

  async function issueSheets(revisionIds: string[]) {
    if (revisionIds.length === 0) return [];
    const rows = await app.db
      .select({
        revisionId: drawingRevisions.id,
        revision: drawingRevisions.revision,
        isSuperseded: drawingRevisions.isSuperseded,
        sheetId: drawingSheets.id,
        number: drawingSheets.number,
        title: drawingSheets.title,
        discipline: drawingSheets.discipline,
      })
      .from(drawingRevisions)
      .innerJoin(drawingSheets, eq(drawingSheets.id, drawingRevisions.sheetId))
      .where(inArray(drawingRevisions.id, revisionIds))
      .orderBy(asc(drawingSheets.number));
    return rows;
  }

  async function issueDetail(req: FastifyRequest, issue: typeof drawingIssues.$inferSelect) {
    const recipients = await app.db.select().from(drawingIssueRecipients).where(eq(drawingIssueRecipients.issueId, issue.id));
    const people = await peopleMap([...recipients.map((r) => r.userId), issue.createdBy, issue.issuedBy]);
    return {
      ...issue,
      sheets: await issueSheets(issue.revisionIds),
      recipients: recipients.map((r) => ({ ...r, name: people[r.userId]?.name ?? null, email: people[r.userId]?.email ?? null })),
      acknowledged: recipients.filter((r) => r.acknowledgedAt).length,
      createdByName: people[issue.createdBy]?.name ?? null,
      issuedByName: issue.issuedBy ? (people[issue.issuedBy]?.name ?? null) : null,
      isRecipient: recipients.some((r) => r.userId === req.user!.id),
    };
  }

  app.get("/projects/:projectId/drawing-issues", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.extend({ status: z.enum(["draft", "issued", "cancelled"]).optional() }).parse(req.query);
    const where = and(
      eq(drawingIssues.companyId, req.companyId!),
      eq(drawingIssues.projectId, req.projectId!),
      q.status ? eq(drawingIssues.status, q.status) : undefined,
    );
    const [totalRow] = await app.db.select({ n: count() }).from(drawingIssues).where(where);
    const items = await app.db.select().from(drawingIssues).where(where).orderBy(desc(drawingIssues.number)).limit(q.pageSize).offset(pageOffset(q));
    const ids = items.map((i) => i.id);
    const acks = ids.length
      ? await app.db
          .select({
            issueId: drawingIssueRecipients.issueId,
            total: count(),
            acknowledged: sql<number>`count(${drawingIssueRecipients.acknowledgedAt})`,
          })
          .from(drawingIssueRecipients)
          .where(inArray(drawingIssueRecipients.issueId, ids))
          .groupBy(drawingIssueRecipients.issueId)
      : [];
    const ackMap = new Map(acks.map((a) => [a.issueId, { total: Number(a.total), acknowledged: Number(a.acknowledged) }]));
    return paginate(
      items.map((i) => ({
        ...i,
        sheetCount: i.revisionIds.length,
        recipients: ackMap.get(i.id)?.total ?? 0,
        acknowledged: ackMap.get(i.id)?.acknowledged ?? 0,
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.post("/projects/:projectId/drawing-issues", { preHandler: standardGate }, async (req, reply) => {
    const body = issueCreateSchema.parse(req.body);
    const projectId = req.projectId!;
    const revisionIds = await resolveIssueRevisions(projectId, body);
    if (revisionIds.length === 0) throw badRequest("Select at least one sheet, revision or set to issue");
    const recipients = await assertRecipients(req, body.recipientUserIds);
    const number = await nextRecordNumber(app.db, projectId, "drawing_issue");
    const id = newId("dis");
    await app.db.insert(drawingIssues).values({
      id,
      companyId: req.companyId!,
      projectId,
      number,
      reference: `DI-${String(number).padStart(3, "0")}`,
      title: body.title,
      purpose: body.purpose,
      status: "draft",
      setId: body.setId ?? null,
      revisionIds,
      notes: body.notes ?? null,
      transmittalId: body.transmittalId ?? null,
      createdBy: req.user!.id,
    });
    await app.db.insert(drawingIssueRecipients).values(recipients.map((userId) => ({ id: newId("dir"), issueId: id, userId })));
    await ledger(req, "create", "drawing_issue", id, { number, title: body.title, purpose: body.purpose, revisions: revisionIds.length, recipients: recipients.length }, projectId);
    return reply.status(201).send(await issueDetail(req, await fetchIssue(req, id)));
  });

  app.get("/projects/:projectId/drawing-issues/:issueId", { preHandler: readGate }, async (req) => {
    const { issueId } = req.params as { issueId: string };
    return issueDetail(req, await fetchIssue(req, issueId));
  });

  app.patch("/projects/:projectId/drawing-issues/:issueId", { preHandler: standardGate }, async (req) => {
    const { issueId } = req.params as { issueId: string };
    const body = issuePatchSchema.parse(req.body);
    const issue = await fetchIssue(req, issueId);
    if (issue.status !== "draft") throw conflict("Only a draft issue can be edited; issue a new one instead");
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.title !== undefined) set["title"] = body.title;
    if (body.purpose !== undefined) set["purpose"] = body.purpose;
    if (body.notes !== undefined) set["notes"] = body.notes;
    if (body.transmittalId !== undefined) set["transmittalId"] = body.transmittalId;
    if (body.setId !== undefined || body.sheetIds !== undefined || body.revisionIds !== undefined) {
      const revisionIds = await resolveIssueRevisions(issue.projectId, body);
      if (revisionIds.length === 0) throw badRequest("Select at least one sheet, revision or set to issue");
      set["revisionIds"] = revisionIds;
      if (body.setId !== undefined) set["setId"] = body.setId;
    }
    await app.db.update(drawingIssues).set(set).where(eq(drawingIssues.id, issueId));
    if (body.recipientUserIds) {
      const recipients = await assertRecipients(req, body.recipientUserIds);
      await app.db.delete(drawingIssueRecipients).where(eq(drawingIssueRecipients.issueId, issueId));
      await app.db.insert(drawingIssueRecipients).values(recipients.map((userId) => ({ id: newId("dir"), issueId, userId })));
    }
    await ledger(req, "update", "drawing_issue", issueId, { changed: Object.keys(body) }, issue.projectId);
    return issueDetail(req, await fetchIssue(req, issueId));
  });

  /** Issue it: the distribution is recorded, the recipients are notified. */
  app.post("/projects/:projectId/drawing-issues/:issueId/issue", { preHandler: standardGate }, async (req) => {
    const { issueId } = req.params as { issueId: string };
    const issue = await fetchIssue(req, issueId);
    if (issue.status !== "draft") throw conflict(`This issue is already ${issue.status}`);
    const recipients = await app.db.select().from(drawingIssueRecipients).where(eq(drawingIssueRecipients.issueId, issueId));
    if (recipients.length === 0) throw badRequest("Add at least one recipient before issuing");
    const now = new Date().toISOString();
    await app.db.update(drawingIssues).set({ status: "issued", issuedAt: now, issuedBy: req.user!.id, updatedAt: now }).where(eq(drawingIssues.id, issueId));
    await app.db.update(drawingIssueRecipients).set({ notifiedAt: now }).where(eq(drawingIssueRecipients.issueId, issueId));
    await pushNotifications(
      app.db,
      recipients.map((r) => ({
        companyId: req.companyId!,
        userId: r.userId,
        projectId: issue.projectId,
        kind: "assignment" as const,
        title: `${issue.reference} issued: ${issue.title}`,
        body: `${issue.revisionIds.length} sheet(s) ${issue.purpose.replace(/_/g, " ")}. Please acknowledge receipt.`,
        recordType: "drawing_issue",
        recordId: issue.id,
      })),
    );
    await ledger(req, "state_change", "drawing_issue", issueId, { status: "issued", recipients: recipients.length, revisions: issue.revisionIds.length }, issue.projectId);
    return issueDetail(req, await fetchIssue(req, issueId));
  });

  app.post("/projects/:projectId/drawing-issues/:issueId/acknowledge", { preHandler: readGate }, async (req) => {
    const { issueId } = req.params as { issueId: string };
    const issue = await fetchIssue(req, issueId);
    if (issue.status !== "issued") throw conflict("Only an issued distribution can be acknowledged");
    const [r] = await app.db
      .select()
      .from(drawingIssueRecipients)
      .where(and(eq(drawingIssueRecipients.issueId, issueId), eq(drawingIssueRecipients.userId, req.user!.id)))
      .limit(1);
    if (!r) throw forbidden("You are not a recipient of this issue");
    if (r.acknowledgedAt) throw conflict("You have already acknowledged this issue");
    const now = new Date().toISOString();
    await app.db.update(drawingIssueRecipients).set({ acknowledgedAt: now }).where(eq(drawingIssueRecipients.id, r.id));
    await ledger(req, "state_change", "drawing_issue", issueId, { acknowledgedBy: req.user!.id }, issue.projectId);
    return issueDetail(req, issue);
  });

  app.post("/projects/:projectId/drawing-issues/:issueId/cancel", { preHandler: standardGate }, async (req) => {
    const { issueId } = req.params as { issueId: string };
    const body = z.object({ reason: z.string().max(2000).optional() }).parse(req.body ?? {});
    const issue = await fetchIssue(req, issueId);
    if (issue.status === "cancelled") throw conflict("This issue is already cancelled");
    const now = new Date().toISOString();
    await app.db.update(drawingIssues).set({ status: "cancelled", updatedAt: now }).where(eq(drawingIssues.id, issueId));
    await ledger(req, "state_change", "drawing_issue", issueId, { status: "cancelled", reason: body.reason ?? null, from: issue.status }, issue.projectId);
    return issueDetail(req, await fetchIssue(req, issueId));
  });

  /** The transmittal payload: what was sent, to whom, and the acknowledgement state (hook for correspondence). */
  app.get("/projects/:projectId/drawing-issues/:issueId/transmittal", { preHandler: readGate }, async (req) => {
    const { issueId } = req.params as { issueId: string };
    const detail = await issueDetail(req, await fetchIssue(req, issueId));
    return {
      reference: detail.reference,
      title: detail.title,
      purpose: detail.purpose,
      status: detail.status,
      issuedAt: detail.issuedAt,
      issuedBy: detail.issuedByName,
      notes: detail.notes,
      transmittalId: detail.transmittalId,
      items: detail.sheets.map((s) => ({ number: s.number, title: s.title, revision: s.revision, discipline: s.discipline, superseded: s.isSuperseded === 1 })),
      recipients: detail.recipients.map((r) => ({ name: r.name, email: r.email, notifiedAt: r.notifiedAt, acknowledgedAt: r.acknowledgedAt })),
    };
  });

  /* ---------------------------------------------------------------- */
  /* Scheduler jobs                                                    */
  /* ---------------------------------------------------------------- */

  async function sweepPendingSets(db: Db, storage: StorageService, companyId: string, now: Date) {
    const staleBefore = new Date(now.getTime() - STALE_LEASE_MS).toISOString();
    const due = await db
      .select({ id: drawingSets.id })
      .from(drawingSets)
      .where(
        and(
          eq(drawingSets.companyId, companyId),
          or(
            eq(drawingSets.processing, "pending"),
            and(eq(drawingSets.processing, "processing"), lt(drawingSets.processingStartedAt, staleBefore)),
          ),
        ),
      )
      .orderBy(asc(drawingSets.createdAt))
      .limit(5);
    const outcomes = [];
    for (const s of due) {
      outcomes.push(await processDrawingSet({ db, storage }, s.id, { actorId: null, maxPages: JOB_PAGE_BUDGET }));
    }
    return outcomes;
  }

  app.scheduler.register({
    name: "drawings.process-sets",
    description: `Split pending drawing sets into sheets, ${JOB_PAGE_BUDGET} pages per set per cycle; resumes abandoned runs`,
    everyMs: 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => {
      let processed = 0;
      let done = 0;
      const summary = await forEachCompany(db, async (companyId) => {
        const outcomes = await sweepPendingSets(db, app.storage, companyId, now);
        processed += outcomes.length;
        done += outcomes.filter((o) => o.done).length;
      });
      return { ...summary, setsTouched: processed, setsFinished: done };
    },
  });

  async function sweepIssueReminders(db: Db, companyId: string, now: Date) {
    const cutoff = new Date(now.getTime() - ISSUE_REMINDER_DAYS * 86_400_000).toISOString();
    const due = await db
      .select({ recipient: drawingIssueRecipients, issue: drawingIssues })
      .from(drawingIssueRecipients)
      .innerJoin(drawingIssues, eq(drawingIssues.id, drawingIssueRecipients.issueId))
      .where(
        and(
          eq(drawingIssues.companyId, companyId),
          eq(drawingIssues.status, "issued"),
          isNull(drawingIssueRecipients.acknowledgedAt),
          isNull(drawingIssueRecipients.remindedAt),
          lt(drawingIssueRecipients.notifiedAt, cutoff),
        ),
      )
      .limit(500);
    for (const { recipient, issue } of due) {
      await pushNotifications(db, [
        {
          companyId,
          userId: recipient.userId,
          projectId: issue.projectId,
          kind: "reminder",
          title: `${issue.reference} still awaits your acknowledgement`,
          body: `${issue.title} was issued ${ISSUE_REMINDER_DAYS}+ days ago. Acknowledge receipt so the distribution record is complete.`,
          recordType: "drawing_issue",
          recordId: issue.id,
        },
      ]);
      await db.update(drawingIssueRecipients).set({ remindedAt: now.toISOString() }).where(eq(drawingIssueRecipients.id, recipient.id));
    }
    return due.length;
  }

  app.scheduler.register({
    name: "drawings.issue-reminders",
    description: `Remind drawing-issue recipients who have not acknowledged after ${ISSUE_REMINDER_DAYS} days`,
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => {
      let reminded = 0;
      const summary = await forEachCompany(db, async (companyId) => {
        reminded += await sweepIssueReminders(db, companyId, now);
      });
      return { ...summary, reminded };
    },
  });
};
