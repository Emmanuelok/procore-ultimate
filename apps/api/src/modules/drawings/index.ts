import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, ne, or } from "drizzle-orm";
import { z } from "zod";
import {
  drawingHyperlinks,
  drawingMarkups,
  drawingPins,
  drawingRevisions,
  drawingSets,
  drawingSheets,
  files,
} from "@constructos/db";
import { DRAWING_DISCIPLINES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { detectSheetMeta, nextRevisionLabel } from "./detectors.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const point = z.object({ x: z.number().finite(), y: z.number().finite() });
const color = z.string().min(1).max(32);
const width = z.number().positive().max(100);

const twoPointShape = { from: point, to: point, color, width };

/** Mirrors MarkupShape from @constructos/shared. */
const markupShapeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pen"),
    points: z.array(point).min(1).max(5000),
    color,
    width,
  }),
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

const PIN_RECORD_TYPES = ["rfi", "punch", "observation", "photo", "inspection", "submittal"] as const;

const pinCreateSchema = z.object({
  recordType: z.enum(PIN_RECORD_TYPES),
  recordId: z.string().min(1).max(64),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

const sheetPatchSchema = z.object({
  number: z.string().min(1).max(50).optional(),
  title: z.string().min(1).max(300).optional(),
  discipline: z.enum(DRAWING_DISCIPLINES).optional(),
  area: z.string().max(120).nullable().optional(),
  /** confirm the OCR-suggested naming → clears the review flag */
  confirmReview: z.boolean().optional(),
});

const sheetsQuerySchema = pageQuerySchema.extend({
  discipline: z.enum(DRAWING_DISCIPLINES).optional(),
  search: z.string().max(200).optional(),
  needsReview: z.enum(["0", "1", "true", "false"]).optional(),
  /** include superseded revisions info; default only current */
  area: z.string().max(120).optional(),
});

/* ------------------------------------------------------------------ */
/* Multipart helper                                                    */
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

/* ------------------------------------------------------------------ */
/* PDF text extraction                                                 */
/* ------------------------------------------------------------------ */

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

export const drawingsModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("drawings", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("drawings", "standard"),
  ];
  const companyGate = [app.authenticate, app.requireCompany];

  /* ---------------------------------------------------------------- */
  /* Scoped loaders (routes without :projectId)                        */
  /* ---------------------------------------------------------------- */

  async function loadSheet(req: FastifyRequest, sheetId: string) {
    const rows = await app.db
      .select()
      .from(drawingSheets)
      .where(and(eq(drawingSheets.id, sheetId), eq(drawingSheets.companyId, req.companyId!)))
      .limit(1);
    if (!rows[0]) throw notFound("Sheet not found");
    return rows[0];
  }

  async function loadRevision(req: FastifyRequest, revisionId: string) {
    const rows = await app.db
      .select()
      .from(drawingRevisions)
      .where(eq(drawingRevisions.id, revisionId))
      .limit(1);
    const revision = rows[0];
    if (!revision) throw notFound("Revision not found");
    const sheet = await loadSheet(req, revision.sheetId); // enforces tenant scope
    return { revision, sheet };
  }

  /* ---------------------------------------------------------------- */
  /* Drawing set upload + inline processing (spec #256-#261, #266)     */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/drawing-sets",
    { preHandler: standardGate },
    async (req, reply) => {
      const mp = await req.file();
      if (!mp) throw badRequest("Expected a multipart PDF upload");
      const buf = await mp.toBuffer();
      const name = fieldValue(mp.fields, "name") ?? mp.filename?.replace(/\.pdf$/i, "") ?? "Drawing set";
      const issuedDate = fieldValue(mp.fields, "issuedDate") ?? null;

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
        metadata: { kind: "drawing_set" },
        uploadedBy: req.user!.id,
      });

      const setId = newId("dset");
      await app.db.insert(drawingSets).values({
        id: setId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        name,
        issuedDate,
        processing: "processing",
        sourceFileId: fileId,
        uploadedBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "drawing_set",
        objectId: setId,
        payload: { name, issuedDate, sha256: saved.sha256 },
      });

      // Inline processing: parse → per-page sheet detection → upsert.
      let sheetsCreated = 0;
      let revisionsAdded = 0;
      let failed: string | null = null;
      try {
        const pages = await extractPdfPages(buf);
        if (pages.length === 0) throw new Error("PDF contains no pages");
        for (const page of pages) {
          const det = detectSheetMeta(page.text);
          const number = det.number ?? `UNNAMED-${page.pageIndex + 1}`;
          const title = det.title ?? "UNTITLED";
          const needsReview = det.confident ? 0 : 1;

          const existing = await app.db
            .select()
            .from(drawingSheets)
            .where(
              and(
                eq(drawingSheets.projectId, req.projectId!),
                eq(drawingSheets.number, number),
              ),
            )
            .limit(1);

          if (existing[0]) {
            const sheet = existing[0];
            const currentRev = sheet.currentRevisionId
              ? await app.db
                  .select({ revision: drawingRevisions.revision })
                  .from(drawingRevisions)
                  .where(eq(drawingRevisions.id, sheet.currentRevisionId))
                  .limit(1)
              : [];
            const label = nextRevisionLabel(currentRev[0]?.revision ?? null);
            const revisionId = newId("drev");
            await app.db
              .update(drawingRevisions)
              .set({ isSuperseded: 1 })
              .where(eq(drawingRevisions.sheetId, sheet.id));
            await app.db.insert(drawingRevisions).values({
              id: revisionId,
              sheetId: sheet.id,
              setId,
              revision: label,
              fileId,
              pageIndex: page.pageIndex,
              extractedText: page.text,
              uploadedBy: req.user!.id,
            });
            await app.db
              .update(drawingSheets)
              .set({ currentRevisionId: revisionId, updatedAt: new Date().toISOString() })
              .where(eq(drawingSheets.id, sheet.id));
            revisionsAdded += 1;
            await appendLedger(app.db, {
              companyId: req.companyId!,
              actorId: req.user!.id,
              action: "update",
              objectType: "drawing_sheet",
              objectId: sheet.id,
              payload: { revision: label, setId, pageIndex: page.pageIndex },
            });
          } else {
            const sheetId = newId("dsht");
            const revisionId = newId("drev");
            await app.db.insert(drawingSheets).values({
              id: sheetId,
              companyId: req.companyId!,
              projectId: req.projectId!,
              number,
              title,
              discipline: det.discipline,
              needsReview,
            });
            await app.db.insert(drawingRevisions).values({
              id: revisionId,
              sheetId,
              setId,
              revision: "0",
              fileId,
              pageIndex: page.pageIndex,
              extractedText: page.text,
              uploadedBy: req.user!.id,
            });
            await app.db
              .update(drawingSheets)
              .set({ currentRevisionId: revisionId })
              .where(eq(drawingSheets.id, sheetId));
            sheetsCreated += 1;
            revisionsAdded += 1;
            await appendLedger(app.db, {
              companyId: req.companyId!,
              actorId: req.user!.id,
              action: "create",
              objectType: "drawing_sheet",
              objectId: sheetId,
              payload: { number, title, discipline: det.discipline, needsReview, setId },
            });
          }
        }
      } catch (err) {
        failed = err instanceof Error ? err.message : "PDF processing failed";
      }

      await app.db
        .update(drawingSets)
        .set({ processing: failed ? "failed" : "ready" })
        .where(eq(drawingSets.id, setId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "drawing_set",
        objectId: setId,
        payload: failed
          ? { processing: "failed", error: failed }
          : { processing: "ready", sheetsCreated, revisionsAdded },
      });

      const rows = await app.db
        .select()
        .from(drawingSets)
        .where(eq(drawingSets.id, setId))
        .limit(1);
      return reply.status(201).send({ ...rows[0], sheetsCreated, revisionsAdded, error: failed });
    },
  );

  app.get(
    "/projects/:projectId/drawing-sets",
    { preHandler: readGate },
    async (req) => {
      const q = pageQuerySchema.parse(req.query);
      const where = and(
        eq(drawingSets.companyId, req.companyId!),
        eq(drawingSets.projectId, req.projectId!),
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
      return paginate(
        items.map((s) => ({ ...s, sheetCount: countMap.get(s.id) ?? 0 })),
        Number(totalRow?.n ?? 0),
        q,
      );
    },
  );

  /* ---------------------------------------------------------------- */
  /* Sheets (spec #258, #260, #265, #266, #281)                        */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/sheets",
    { preHandler: readGate },
    async (req) => {
      const q = sheetsQuerySchema.parse(req.query);
      const conds = [
        eq(drawingSheets.companyId, req.companyId!),
        eq(drawingSheets.projectId, req.projectId!),
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
      const where = and(...conds);
      const [totalRow] = await app.db.select({ n: count() }).from(drawingSheets).where(where);
      const items = await app.db
        .select()
        .from(drawingSheets)
        .where(where)
        .orderBy(asc(drawingSheets.number))
        .limit(q.pageSize)
        .offset(pageOffset(q));

      // current revision info via second query
      const revIds = items
        .map((s) => s.currentRevisionId)
        .filter((id): id is string => id != null);
      const revisions = revIds.length
        ? await app.db
            .select({
              id: drawingRevisions.id,
              revision: drawingRevisions.revision,
              fileId: drawingRevisions.fileId,
              pageIndex: drawingRevisions.pageIndex,
              setId: drawingRevisions.setId,
              createdAt: drawingRevisions.createdAt,
            })
            .from(drawingRevisions)
            .where(inArray(drawingRevisions.id, revIds))
        : [];
      const revMap = new Map(revisions.map((r) => [r.id, r]));
      return paginate(
        items.map((s) => ({
          ...s,
          currentRevision: s.currentRevisionId
            ? (revMap.get(s.currentRevisionId) ?? null)
            : null,
        })),
        Number(totalRow?.n ?? 0),
        q,
      );
    },
  );

  /** Sheet log export (spec #281): one JSON row per sheet. */
  app.get(
    "/projects/:projectId/sheets/log",
    { preHandler: readGate },
    async (req) => {
      const sheets = await app.db
        .select()
        .from(drawingSheets)
        .where(
          and(
            eq(drawingSheets.companyId, req.companyId!),
            eq(drawingSheets.projectId, req.projectId!),
          ),
        )
        .orderBy(asc(drawingSheets.number));
      const sheetIds = sheets.map((s) => s.id);
      const revisions = sheetIds.length
        ? await app.db
            .select()
            .from(drawingRevisions)
            .where(inArray(drawingRevisions.sheetId, sheetIds))
        : [];
      const setIds = [...new Set(revisions.map((r) => r.setId))];
      const sets = setIds.length
        ? await app.db.select().from(drawingSets).where(inArray(drawingSets.id, setIds))
        : [];
      const setMap = new Map(sets.map((s) => [s.id, s]));
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
        return {
          sheetId: s.id,
          number: s.number,
          title: s.title,
          discipline: s.discipline,
          area: s.area,
          currentRevision: current?.revision ?? null,
          revisionCount: revs.length,
          issuedDate: set?.issuedDate ?? null,
          setName: set?.name ?? null,
          needsReview: s.needsReview === 1,
        };
      });
      return { items: rows, total: rows.length };
    },
  );

  app.get("/sheets/:sheetId", { preHandler: companyGate }, async (req) => {
    const { sheetId } = req.params as { sheetId: string };
    const sheet = await loadSheet(req, sheetId);
    const revisions = await app.db
      .select()
      .from(drawingRevisions)
      .where(eq(drawingRevisions.sheetId, sheetId))
      .orderBy(desc(drawingRevisions.createdAt));
    const [pinRow] = await app.db
      .select({ n: count() })
      .from(drawingPins)
      .where(eq(drawingPins.sheetId, sheetId));
    return {
      ...sheet,
      revisions: revisions.map((r) => ({ ...r, extractedText: undefined })),
      pinsCount: Number(pinRow?.n ?? 0),
    };
  });

  app.patch("/sheets/:sheetId", { preHandler: companyGate }, async (req) => {
    const { sheetId } = req.params as { sheetId: string };
    const body = sheetPatchSchema.parse(req.body);
    const sheet = await loadSheet(req, sheetId);
    if (body.number && body.number !== sheet.number) {
      const dup = await app.db
        .select({ id: drawingSheets.id })
        .from(drawingSheets)
        .where(
          and(
            eq(drawingSheets.projectId, sheet.projectId),
            eq(drawingSheets.number, body.number),
            ne(drawingSheets.id, sheetId),
          ),
        )
        .limit(1);
      if (dup[0]) throw conflict("A sheet with this number already exists in the project");
    }
    const clearsReview =
      body.confirmReview === true || body.number !== undefined || body.title !== undefined;
    await app.db
      .update(drawingSheets)
      .set({
        number: body.number ?? sheet.number,
        title: body.title ?? sheet.title,
        discipline: body.discipline ?? sheet.discipline,
        area: body.area === undefined ? sheet.area : body.area,
        needsReview: clearsReview ? 0 : sheet.needsReview,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(drawingSheets.id, sheetId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "drawing_sheet",
      objectId: sheetId,
      payload: body,
    });
    const updated = await app.db
      .select()
      .from(drawingSheets)
      .where(eq(drawingSheets.id, sheetId))
      .limit(1);
    return updated[0];
  });

  app.delete(
    "/sheets/:sheetId",
    { preHandler: [...companyGate, app.requireCompanyRole(["owner", "admin"])] },
    async (req) => {
      const { sheetId } = req.params as { sheetId: string };
      const sheet = await loadSheet(req, sheetId);
      const revisions = await app.db
        .select({ id: drawingRevisions.id })
        .from(drawingRevisions)
        .where(eq(drawingRevisions.sheetId, sheetId));
      const revIds = revisions.map((r) => r.id);
      if (revIds.length) {
        await app.db.delete(drawingMarkups).where(inArray(drawingMarkups.revisionId, revIds));
        await app.db
          .delete(drawingHyperlinks)
          .where(inArray(drawingHyperlinks.fromRevisionId, revIds));
      }
      await app.db.delete(drawingHyperlinks).where(eq(drawingHyperlinks.toSheetId, sheetId));
      await app.db.delete(drawingPins).where(eq(drawingPins.sheetId, sheetId));
      await app.db.delete(drawingRevisions).where(eq(drawingRevisions.sheetId, sheetId));
      await app.db.delete(drawingSheets).where(eq(drawingSheets.id, sheetId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "drawing_sheet",
        objectId: sheetId,
        payload: { number: sheet.number, title: sheet.title },
      });
      return { ok: true };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Markups (spec #267-#270)                                          */
  /* ---------------------------------------------------------------- */

  app.get("/revisions/:revisionId/markups", { preHandler: companyGate }, async (req) => {
    const { revisionId } = req.params as { revisionId: string };
    const q = z
      .object({ layer: z.enum(["personal", "published"]).optional() })
      .parse(req.query);
    await loadRevision(req, revisionId);
    const visible = or(
      eq(drawingMarkups.layer, "published"),
      and(eq(drawingMarkups.layer, "personal"), eq(drawingMarkups.authorId, req.user!.id)),
    )!;
    const where = q.layer
      ? and(eq(drawingMarkups.revisionId, revisionId), eq(drawingMarkups.layer, q.layer), visible)
      : and(eq(drawingMarkups.revisionId, revisionId), visible);
    const items = await app.db
      .select()
      .from(drawingMarkups)
      .where(where)
      .orderBy(asc(drawingMarkups.createdAt));
    return { items, total: items.length };
  });

  app.put("/revisions/:revisionId/markups", { preHandler: companyGate }, async (req) => {
    const { revisionId } = req.params as { revisionId: string };
    const body = markupPutSchema.parse(req.body);
    const { revision } = await loadRevision(req, revisionId);
    const existing = await app.db
      .select()
      .from(drawingMarkups)
      .where(
        and(
          eq(drawingMarkups.revisionId, revisionId),
          eq(drawingMarkups.authorId, req.user!.id),
          eq(drawingMarkups.layer, "personal"),
        ),
      )
      .limit(1);
    if (existing[0]) {
      await app.db
        .update(drawingMarkups)
        .set({ shapes: body.shapes, updatedAt: new Date().toISOString() })
        .where(eq(drawingMarkups.id, existing[0].id));
      const updated = await app.db
        .select()
        .from(drawingMarkups)
        .where(eq(drawingMarkups.id, existing[0].id))
        .limit(1);
      return updated[0];
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
    const created = await app.db
      .select()
      .from(drawingMarkups)
      .where(eq(drawingMarkups.id, id))
      .limit(1);
    return created[0];
  });

  app.post("/markups/:markupId/publish", { preHandler: companyGate }, async (req) => {
    const { markupId } = req.params as { markupId: string };
    const rows = await app.db
      .select()
      .from(drawingMarkups)
      .where(eq(drawingMarkups.id, markupId))
      .limit(1);
    const markup = rows[0];
    if (!markup) throw notFound("Markup not found");
    await loadRevision(req, markup.revisionId); // tenant scope
    if (markup.authorId !== req.user!.id) {
      throw forbidden("Only the author can publish their personal layer");
    }
    if (markup.layer !== "personal") throw conflict("Markup is already published");
    await app.db
      .update(drawingMarkups)
      .set({ layer: "published", updatedAt: new Date().toISOString() })
      .where(eq(drawingMarkups.id, markupId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "drawing_markup",
      objectId: markupId,
      payload: { layer: "published", revisionId: markup.revisionId },
    });
    const updated = await app.db
      .select()
      .from(drawingMarkups)
      .where(eq(drawingMarkups.id, markupId))
      .limit(1);
    return updated[0];
  });

  /* ---------------------------------------------------------------- */
  /* Calibration (spec #271)                                           */
  /* ---------------------------------------------------------------- */

  app.put("/revisions/:revisionId/calibration", { preHandler: companyGate }, async (req) => {
    const { revisionId } = req.params as { revisionId: string };
    const body = calibrationSchema.parse(req.body);
    await loadRevision(req, revisionId);
    await app.db
      .update(drawingRevisions)
      .set({ calibration: body })
      .where(eq(drawingRevisions.id, revisionId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "drawing_revision",
      objectId: revisionId,
      payload: { calibration: body },
    });
    return { ok: true, calibration: body };
  });

  /* ---------------------------------------------------------------- */
  /* Hyperlinks (spec #263, #264)                                      */
  /* ---------------------------------------------------------------- */

  app.get("/revisions/:revisionId/hyperlinks", { preHandler: companyGate }, async (req) => {
    const { revisionId } = req.params as { revisionId: string };
    await loadRevision(req, revisionId);
    const items = await app.db
      .select()
      .from(drawingHyperlinks)
      .where(eq(drawingHyperlinks.fromRevisionId, revisionId))
      .orderBy(asc(drawingHyperlinks.createdAt));
    return { items, total: items.length };
  });

  app.post(
    "/revisions/:revisionId/hyperlinks",
    { preHandler: companyGate },
    async (req, reply) => {
      const { revisionId } = req.params as { revisionId: string };
      const body = hyperlinkCreateSchema.parse(req.body);
      const { sheet } = await loadRevision(req, revisionId);
      const target = await loadSheet(req, body.toSheetId);
      if (target.projectId !== sheet.projectId) {
        throw badRequest("Hyperlink target must be a sheet in the same project");
      }
      const id = newId("dhl");
      await app.db.insert(drawingHyperlinks).values({
        id,
        fromRevisionId: revisionId,
        toSheetId: body.toSheetId,
        x: body.x,
        y: body.y,
        w: body.w,
        h: body.h,
        label: body.label ?? null,
        source: "manual",
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "drawing_hyperlink",
        objectId: id,
        payload: { fromRevisionId: revisionId, toSheetId: body.toSheetId },
      });
      const created = await app.db
        .select()
        .from(drawingHyperlinks)
        .where(eq(drawingHyperlinks.id, id))
        .limit(1);
      return reply.status(201).send(created[0]);
    },
  );

  app.delete(
    "/revisions/:revisionId/hyperlinks/:linkId",
    { preHandler: companyGate },
    async (req) => {
      const { revisionId, linkId } = req.params as { revisionId: string; linkId: string };
      await loadRevision(req, revisionId);
      const rows = await app.db
        .select()
        .from(drawingHyperlinks)
        .where(
          and(eq(drawingHyperlinks.id, linkId), eq(drawingHyperlinks.fromRevisionId, revisionId)),
        )
        .limit(1);
      if (!rows[0]) throw notFound("Hyperlink not found");
      await app.db.delete(drawingHyperlinks).where(eq(drawingHyperlinks.id, linkId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "drawing_hyperlink",
        objectId: linkId,
        payload: { fromRevisionId: revisionId },
      });
      return { ok: true };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Pins (spec #272-#276)                                             */
  /* ---------------------------------------------------------------- */

  app.post("/sheets/:sheetId/pins", { preHandler: companyGate }, async (req, reply) => {
    const { sheetId } = req.params as { sheetId: string };
    const body = pinCreateSchema.parse(req.body);
    await loadSheet(req, sheetId);
    const id = newId("pin");
    await app.db.insert(drawingPins).values({
      id,
      sheetId,
      recordType: body.recordType,
      recordId: body.recordId,
      x: body.x,
      y: body.y,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "drawing_pin",
      objectId: id,
      payload: { sheetId, ...body },
    });
    const created = await app.db
      .select()
      .from(drawingPins)
      .where(eq(drawingPins.id, id))
      .limit(1);
    return reply.status(201).send(created[0]);
  });

  app.get("/sheets/:sheetId/pins", { preHandler: companyGate }, async (req) => {
    const { sheetId } = req.params as { sheetId: string };
    await loadSheet(req, sheetId);
    const items = await app.db
      .select()
      .from(drawingPins)
      .where(eq(drawingPins.sheetId, sheetId))
      .orderBy(asc(drawingPins.createdAt));
    return { items, total: items.length };
  });

  app.delete("/pins/:pinId", { preHandler: companyGate }, async (req) => {
    const { pinId } = req.params as { pinId: string };
    const rows = await app.db
      .select()
      .from(drawingPins)
      .where(eq(drawingPins.id, pinId))
      .limit(1);
    const pin = rows[0];
    if (!pin) throw notFound("Pin not found");
    await loadSheet(req, pin.sheetId); // tenant scope
    await app.db.delete(drawingPins).where(eq(drawingPins.id, pinId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "drawing_pin",
      objectId: pinId,
      payload: { sheetId: pin.sheetId, recordType: pin.recordType, recordId: pin.recordId },
    });
    return { ok: true };
  });

  /** Reverse lookup: where is this record pinned? (spec #272-#276) */
  app.get(
    "/projects/:projectId/pins",
    { preHandler: readGate },
    async (req) => {
      const q = z
        .object({
          recordType: z.enum(PIN_RECORD_TYPES).optional(),
          recordId: z.string().max(64).optional(),
        })
        .parse(req.query);
      const conds = [
        eq(drawingSheets.companyId, req.companyId!),
        eq(drawingSheets.projectId, req.projectId!),
      ];
      if (q.recordType) conds.push(eq(drawingPins.recordType, q.recordType));
      if (q.recordId) conds.push(eq(drawingPins.recordId, q.recordId));
      const rows = await app.db
        .select({
          id: drawingPins.id,
          sheetId: drawingPins.sheetId,
          recordType: drawingPins.recordType,
          recordId: drawingPins.recordId,
          x: drawingPins.x,
          y: drawingPins.y,
          createdBy: drawingPins.createdBy,
          createdAt: drawingPins.createdAt,
          sheetNumber: drawingSheets.number,
          sheetTitle: drawingSheets.title,
        })
        .from(drawingPins)
        .innerJoin(drawingSheets, eq(drawingSheets.id, drawingPins.sheetId))
        .where(and(...conds))
        .orderBy(asc(drawingPins.createdAt));
      return { items: rows, total: rows.length };
    },
  );

  /* ---------------------------------------------------------------- */
  /* PDF stream for the viewer (spec #278)                             */
  /* ---------------------------------------------------------------- */

  app.get("/drawing-files/:fileId/pdf", { preHandler: companyGate }, async (req, reply) => {
    const { fileId } = req.params as { fileId: string };
    const rows = await app.db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.companyId, req.companyId!)))
      .limit(1);
    const f = rows[0];
    if (!f) throw notFound("File not found");
    return reply
      .header("content-type", "application/pdf")
      .header("content-disposition", `inline; filename="${encodeURIComponent(f.name)}"`)
      .send(app.storage.readStream(f.storageKey));
  });
};
