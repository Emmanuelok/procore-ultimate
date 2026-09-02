/**
 * Photos & media — spec Vol I §2.10 #426–#439.
 *
 * Covers: capped, sniffed, single-part uploads (#428 — the client's
 * content-type is a claim; the first bytes are the evidence; the whole
 * request is never buffered beyond the photo cap), server-side EXIF
 * (taken-at, GPS, orientation, camera), albums with privacy (#429),
 * manual tags + tag/date/GPS/location/360 filters (#431–#434), drawing
 * pins (#433), an un-ledgered inline content route so a gallery of 48
 * tiles is not 48 access-log rows on the company chain, bulk download as a
 * ZIP (#438), AI photo intelligence that runs after upload when AI is
 * configured and is otherwise honestly marked `skipped` (#437, #439), and
 * record-level PATCH/DELETE that resolve the photo's project and enforce
 * the `photos` tool level (audit: photos.ts:175).
 *
 * Deliberately NOT here: image resizing (no image library in the runtime —
 * the content route serves the original with cache headers and says so),
 * and the daily-log agent's consumption of tags (modules/ai).
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, ne, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { fileVersions, files, photoAlbums, photos, signals } from "@constructos/db";
import { SIGNAL_SEVERITIES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { sendRanged } from "../drawings/stream.js";
import { aiEnabled, runAgent, streamToBuffer } from "../ai/service.js";
import {
  assertCompanyUsers,
  assertProjectLocation,
  hasToolAdmin,
  isCompanyAdmin,
  requireToolLevel,
} from "./access.js";
import {
  PHOTO_MAX_BYTES,
  extractExif,
  isValidPin,
  sniffMediaType,
} from "./photoEngine.js";
import { buildZip } from "./zip.js";
import { actorOf, jsonbHas, nowIso } from "./shared.js";

const photoFieldsSchema = z.object({
  album: z.string().max(200).optional(),
  caption: z.string().max(2000).optional(),
  takenAt: z.string().max(40).optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  locationId: z.string().max(50).optional(),
  /** comma-separated */
  tags: z.string().max(2000).optional(),
  is360: z.enum(["true", "false", "1", "0"]).optional(),
  /** JSON: { sheetId, x, y } */
  pin: z.string().max(500).optional(),
});

const pinSchema = z.object({ sheetId: z.string().min(1).max(60), x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).nullable();

const photoPatchSchema = z.object({
  album: z.string().max(200).nullable().optional(),
  caption: z.string().max(2000).nullable().optional(),
  takenAt: z.string().max(40).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  locationId: z.string().max(50).nullable().optional(),
  tags: z.array(z.string().min(1).max(60)).max(50).optional(),
  is360: z.boolean().optional(),
  pin: pinSchema.optional(),
});

const photoListQuery = pageQuerySchema.extend({
  album: z.string().max(200).optional(),
  unfiled: z.enum(["true", "false"]).optional(),
  tag: z.string().max(60).optional(),
  takenFrom: z.string().max(40).optional(),
  takenTo: z.string().max(40).optional(),
  hasGps: z.enum(["true", "false"]).optional(),
  locationId: z.string().max(50).optional(),
  is360: z.enum(["true", "false"]).optional(),
  uploadedBy: z.string().optional(),
  aiStatus: z.enum(["pending", "done", "failed", "skipped"]).optional(),
  search: z.string().max(200).optional(),
});

const albumSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  isPrivate: z.boolean().optional(),
  allowedUserIds: z.array(z.string().min(1)).max(100).optional(),
});

const bulkDownloadSchema = z.object({ photoIds: z.array(z.string().min(1)).min(1).max(100) });

const AI_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type AiImageType = (typeof AI_IMAGE_TYPES)[number];
const AI_MAX_BYTES = 5 * 1024 * 1024;

const photoIntelSchema = z.object({
  tags: z.array(z.string().min(1).max(60)).max(40).default([]).catch([]),
  progressSummary: z.string().max(5000).optional(),
  safetySignals: z
    .array(z.object({ issue: z.string().min(1).max(500), severity: z.enum(SIGNAL_SEVERITIES).catch("medium") }))
    .default([])
    .catch([]),
  confidence: z.number().min(0).max(1).optional().catch(undefined),
});

function parseTakenAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw badRequest("takenAt must be an ISO timestamp");
  return new Date(t).toISOString();
}

function parseTags(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").map((t) => t.trim().toLowerCase()).filter((t) => t !== "" && t.length <= 60))].slice(0, 50);
}

/**
 * Read a multipart file part into memory up to `cap` bytes. Past the cap the
 * rest of the part is drained and dropped so busboy finishes cleanly and the
 * process never holds more than one photo's worth of upload.
 */
async function readCapped(stream: Readable, cap: number): Promise<{ buf: Buffer; tooLarge: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += b.length;
    if (tooLarge) continue;
    if (size > cap) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(b);
  }
  return { buf: tooLarge ? Buffer.alloc(0) : Buffer.concat(chunks), tooLarge };
}

type PhotoRow = typeof photos.$inferSelect;

export const photoRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("photos", "read")];
  const standardGate = [app.authenticate, app.requireCompany, app.requireTool("photos", "standard")];
  const companyGate = [app.authenticate, app.requireCompany];

  function scope(req: FastifyRequest) {
    return and(eq(photos.companyId, req.companyId!), eq(photos.projectId, req.projectId!))!;
  }

  async function isPhotosAdmin(req: FastifyRequest, projectId: string): Promise<boolean> {
    return isCompanyAdmin(req.companyRole) || hasToolAdmin(app, actorOf(req), projectId, "photos");
  }

  /** Company-scoped load + project tool level for id-addressed routes. */
  async function loadPhotoForLevel(req: FastifyRequest, photoId: string, level: "read" | "standard"): Promise<PhotoRow> {
    const clauses = [eq(photos.id, photoId), eq(photos.companyId, req.companyId!)];
    if (req.projectId) clauses.push(eq(photos.projectId, req.projectId));
    const row = (await app.db.select().from(photos).where(and(...clauses)).limit(1))[0];
    if (!row) throw notFound("Photo not found");
    await requireToolLevel(app, actorOf(req), row.projectId, "photos", level);
    if (!(await canSeeAlbum(req, row.projectId, row.album))) throw notFound("Photo not found");
    return row;
  }

  /** Private albums are visible to their creator, their allow-list and photo admins. */
  async function canSeeAlbum(req: FastifyRequest, projectId: string, album: string | null): Promise<boolean> {
    if (!album) return true;
    const rec = (
      await app.db
        .select()
        .from(photoAlbums)
        .where(and(eq(photoAlbums.companyId, req.companyId!), eq(photoAlbums.projectId, projectId), eq(photoAlbums.name, album)))
        .limit(1)
    )[0];
    if (!rec || rec.isPrivate === 0) return true;
    const me = req.user!.id;
    if (rec.createdBy === me || rec.allowedUserIds.includes(me)) return true;
    return isPhotosAdmin(req, projectId);
  }

  function fileMeta(f: { id: string; name: string; contentType: string; sizeBytes: number }) {
    return { id: f.id, name: f.name, contentType: f.contentType, sizeBytes: f.sizeBytes };
  }

  async function withFile(row: PhotoRow) {
    const f = (await app.db.select().from(files).where(eq(files.id, row.fileId)).limit(1))[0];
    return { ...row, file: f ? fileMeta(f) : null };
  }

  /* ---------------------------------------------------------------- */
  /* AI photo intelligence (#437, #439) — honest about being off       */
  /* ---------------------------------------------------------------- */

  async function analysePhoto(req: FastifyRequest, photo: PhotoRow): Promise<{ status: string; tags: string[]; error: string | null }> {
    const companyId = photo.companyId;
    if (!aiEnabled(app)) {
      await app.db.update(photos).set({ aiStatus: "skipped", aiError: "AI is not configured (ANTHROPIC_API_KEY unset)" }).where(eq(photos.id, photo.id));
      return { status: "skipped", tags: [], error: "AI is not configured (ANTHROPIC_API_KEY unset)" };
    }
    const file = (await app.db.select().from(files).where(and(eq(files.id, photo.fileId), eq(files.companyId, companyId))).limit(1))[0];
    if (!file) throw notFound("Photo file not found");
    if (!(AI_IMAGE_TYPES as readonly string[]).includes(file.contentType)) {
      await app.db.update(photos).set({ aiStatus: "skipped", aiError: `Unsupported media type for analysis: ${file.contentType}` }).where(eq(photos.id, photo.id));
      return { status: "skipped", tags: [], error: `Unsupported media type for analysis: ${file.contentType}` };
    }
    if (file.sizeBytes > AI_MAX_BYTES) {
      await app.db.update(photos).set({ aiStatus: "skipped", aiError: "Photo exceeds the 5MB limit for AI analysis" }).where(eq(photos.id, photo.id));
      return { status: "skipped", tags: [], error: "Photo exceeds the 5MB limit for AI analysis" };
    }
    try {
      const buffer = await streamToBuffer(app.storage.readStream(file.storageKey));
      const instruction = [
        "Analyse this construction jobsite photo.",
        photo.caption ? `Uploader caption: ${photo.caption}` : "",
        'Return ONLY a JSON object: {"tags": string[], "progressSummary": string, "safetySignals": [{"issue": string, "severity": "info"|"low"|"medium"|"high"|"critical"}], "confidence": number 0-1}.',
        "tags are short lowercase keywords (trades, materials, activities). safetySignals lists visible safety issues only; leave it empty when none are visible.",
      ]
        .filter(Boolean)
        .join("\n");
      const result = await runAgent({
        app,
        req,
        agentKind: "photo_intelligence",
        projectId: photo.projectId,
        system: "You are the ConstructOS photo intelligence agent. Describe only what is visible in the image; never speculate beyond it.",
        user: [
          { type: "image", source: { type: "base64", media_type: file.contentType as AiImageType, data: buffer.toString("base64") } },
          { type: "text", text: instruction },
        ],
        inputRefs: [
          { type: "photo", id: photo.id },
          { type: "file", id: file.id },
        ],
        schema: photoIntelSchema,
      });
      const parsed = result.json!;
      await app.db
        .update(photos)
        .set({ aiTags: parsed.tags, aiSummary: parsed.progressSummary ?? photo.aiSummary, aiStatus: "done", aiError: null })
        .where(eq(photos.id, photo.id));
      for (const s of parsed.safetySignals) {
        const signalId = newId("sig");
        await app.db.insert(signals).values({
          id: signalId,
          companyId,
          projectId: photo.projectId,
          detector: "photo_safety",
          severity: s.severity,
          confidence: parsed.confidence ?? 0.5,
          title: s.issue.slice(0, 200),
          explanation: `AI photo intelligence flagged a safety issue in photo ${photo.id}: ${s.issue}`,
          evidenceRefs: [
            { type: "photo", id: photo.id },
            { type: "ai_run", id: result.runId },
          ],
        });
        await appendLedger(app.db, {
          companyId,
          actorId: req.user!.id,
          action: "create",
          objectType: "signal",
          objectId: signalId,
          payload: { detector: "photo_safety", photoId: photo.id, runId: result.runId },
          projectId: photo.projectId,
        });
      }
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "update",
        objectType: "photo",
        objectId: photo.id,
        payload: { aiRunId: result.runId, tags: parsed.tags.length, safetySignals: parsed.safetySignals.length },
        projectId: photo.projectId,
      });
      return { status: "done", tags: parsed.tags, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await app.db.update(photos).set({ aiStatus: "failed", aiError: message.slice(0, 500) }).where(eq(photos.id, photo.id));
      if (err instanceof AppError) throw err;
      return { status: "failed", tags: [], error: message.slice(0, 500) };
    }
  }

  /* ---------------------------------------------------------------- */
  /* Upload                                                            */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/photos", { preHandler: standardGate }, async (req, reply) => {
    let fileBuf: Buffer | null = null;
    let filename = "photo";
    let tooLarge = false;
    let extraFiles = 0;
    const rawFields: Record<string, string> = {};
    for await (const part of req.parts()) {
      if (part.type === "file") {
        if (fileBuf !== null || tooLarge) {
          extraFiles += 1;
          part.file.resume();
          continue;
        }
        if (part.filename) filename = part.filename.replace(/[\\/]/g, "_").slice(0, 200) || "photo";
        const read = await readCapped(part.file, PHOTO_MAX_BYTES);
        if (read.tooLarge || part.file.truncated) tooLarge = true;
        else fileBuf = read.buf;
      } else if (typeof part.value === "string" && part.value !== "") {
        rawFields[part.fieldname] = part.value;
      }
    }
    if (tooLarge) {
      throw new AppError(413, `Photo exceeds the ${Math.round(PHOTO_MAX_BYTES / (1024 * 1024))} MB limit`);
    }
    if (!fileBuf) throw badRequest("Expected a multipart file upload");
    if (extraFiles > 0) throw badRequest("Upload one photo per request");
    if (fileBuf.length === 0) throw badRequest("Empty file");
    const mediaType = sniffMediaType(fileBuf);
    if (!mediaType) {
      throw new AppError(415, "Unsupported media: expected JPEG, PNG, GIF, WebP, HEIC or MP4 (checked by content, not by file name)");
    }
    const meta = photoFieldsSchema.parse(rawFields);
    await assertProjectLocation(app.db, req.companyId!, req.projectId!, meta.locationId);
    if (meta.album && !(await canSeeAlbum(req, req.projectId!, meta.album))) {
      throw forbidden("That album is private");
    }
    let pin: { sheetId: string; x: number; y: number } | null = null;
    if (meta.pin) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(meta.pin);
      } catch {
        throw badRequest("pin must be JSON { sheetId, x, y }");
      }
      if (!isValidPin(parsed)) throw badRequest("pin must be { sheetId, x, y } with x,y in 0..1");
      pin = parsed;
    }
    const exif = mediaType === "image/jpeg" ? extractExif(fileBuf) : null;
    const takenAt = parseTakenAt(meta.takenAt) ?? exif?.takenAt ?? null;
    const latitude = meta.latitude ?? exif?.latitude ?? null;
    const longitude = meta.longitude ?? exif?.longitude ?? null;
    const tags = parseTags(meta.tags);
    const is360 = meta.is360 === "true" || meta.is360 === "1" ? 1 : 0;

    // Was this blob already stored? Content addressing dedupes identical
    // payloads, so a rollback must only remove a blob nobody else references.
    const saved = await app.storage.saveBuffer(req.companyId!, fileBuf);
    const fileId = newId("fil");
    const photoId = newId("pho");
    const aiStatus = aiEnabled(app) ? "pending" : "skipped";
    try {
      await app.db.transaction(async (tx) => {
        await tx.insert(files).values({
          id: fileId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          folderId: null,
          name: filename,
          contentType: mediaType,
          sizeBytes: saved.sizeBytes,
          sha256: saved.sha256,
          storageKey: saved.storageKey,
          version: 1,
          isPrivate: 0,
          uploadedBy: req.user!.id,
        });
        await tx.insert(fileVersions).values({
          id: newId("fv"),
          fileId,
          version: 1,
          contentType: mediaType,
          sizeBytes: saved.sizeBytes,
          sha256: saved.sha256,
          storageKey: saved.storageKey,
          uploadedBy: req.user!.id,
        });
        await tx.insert(photos).values({
          id: photoId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          fileId,
          album: meta.album ?? null,
          caption: meta.caption ?? null,
          takenAt,
          latitude,
          longitude,
          locationId: meta.locationId ?? null,
          tags,
          is360,
          pin,
          exif: exif ? { ...exif, source: "jpeg_app1" } : null,
          aiStatus,
          aiError: aiStatus === "skipped" ? "AI is not configured (ANTHROPIC_API_KEY unset)" : null,
          contentType: mediaType,
          sizeBytes: saved.sizeBytes,
          uploadedBy: req.user!.id,
        });
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "photo",
        objectId: photoId,
        payload: {
          fileId,
          sha256: saved.sha256,
          sizeBytes: saved.sizeBytes,
          contentType: mediaType,
          album: meta.album ?? null,
          takenAt,
          hasGps: latitude !== null && longitude !== null,
          exif: Boolean(exif),
        },
        projectId: req.projectId!,
      });
    } catch (err) {
      const others = await app.db
        .select({ id: files.id })
        .from(files)
        .where(and(eq(files.storageKey, saved.storageKey), ne(files.id, fileId)))
        .limit(1);
      if (others.length === 0) await app.storage.remove(saved.storageKey).catch(() => undefined);
      throw err;
    }

    const row = (await app.db.select().from(photos).where(eq(photos.id, photoId)).limit(1))[0]!;
    if (aiStatus === "pending") {
      // Off the request path; the photo row carries the outcome either way.
      setImmediate(() => {
        analysePhoto(req, row).catch((err: unknown) => {
          req.log.warn({ err, photoId }, "photo intelligence failed");
        });
      });
    }
    return reply.status(201).send({ ...row, file: fileMeta({ id: fileId, name: filename, contentType: mediaType, sizeBytes: saved.sizeBytes }) });
  });

  /* ---------------------------------------------------------------- */
  /* List / albums / tags                                              */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/photos", { preHandler: readGate }, async (req) => {
    const q = photoListQuery.parse(req.query);
    const me = req.user!.id;
    const admin = await isPhotosAdmin(req, req.projectId!);
    const clauses: SQL[] = [scope(req)];
    if (q.album) clauses.push(eq(photos.album, q.album));
    if (q.unfiled === "true") clauses.push(isNull(photos.album));
    if (q.tag) {
      const tag = q.tag.trim().toLowerCase();
      clauses.push(or(jsonbHas(photos.tags, tag), jsonbHas(photos.aiTags, tag))!);
    }
    if (q.takenFrom) clauses.push(gte(photos.takenAt, parseTakenAt(q.takenFrom)!));
    if (q.takenTo) clauses.push(lte(photos.takenAt, parseTakenAt(q.takenTo)!));
    if (q.hasGps === "true") clauses.push(isNotNull(photos.latitude), isNotNull(photos.longitude));
    if (q.hasGps === "false") clauses.push(isNull(photos.latitude));
    if (q.locationId) clauses.push(eq(photos.locationId, q.locationId));
    if (q.is360) clauses.push(eq(photos.is360, q.is360 === "true" ? 1 : 0));
    if (q.uploadedBy) clauses.push(eq(photos.uploadedBy, q.uploadedBy));
    if (q.aiStatus) clauses.push(eq(photos.aiStatus, q.aiStatus));
    if (q.search) clauses.push(or(ilike(photos.caption, `%${q.search}%`), ilike(files.name, `%${q.search}%`))!);
    if (!admin) {
      clauses.push(
        or(
          isNull(photoAlbums.id),
          eq(photoAlbums.isPrivate, 0),
          eq(photoAlbums.createdBy, me),
          jsonbHas(photoAlbums.allowedUserIds, me),
        )!,
      );
    }
    const where = and(...clauses);
    const albumJoin = and(eq(photoAlbums.projectId, photos.projectId), eq(photoAlbums.name, photos.album));
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(photos)
      .innerJoin(files, eq(files.id, photos.fileId))
      .leftJoin(photoAlbums, albumJoin)
      .where(where);
    const rows = await app.db
      .select({ photo: photos, fileName: files.name, contentType: files.contentType, sizeBytes: files.sizeBytes, albumPrivate: photoAlbums.isPrivate })
      .from(photos)
      .innerJoin(files, eq(files.id, photos.fileId))
      .leftJoin(photoAlbums, albumJoin)
      .where(where)
      .orderBy(desc(photos.takenAt), desc(photos.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      rows.map((r) => ({
        ...r.photo,
        albumIsPrivate: r.albumPrivate === 1,
        file: fileMeta({ id: r.photo.fileId, name: r.fileName, contentType: r.contentType, sizeBytes: r.sizeBytes }),
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.get("/projects/:projectId/photos/albums", { preHandler: readGate }, async (req) => {
    const me = req.user!.id;
    const admin = await isPhotosAdmin(req, req.projectId!);
    const counts = await app.db
      .select({ album: photos.album, n: count() })
      .from(photos)
      .where(scope(req))
      .groupBy(photos.album)
      .orderBy(desc(count()));
    const records = await app.db
      .select()
      .from(photoAlbums)
      .where(and(eq(photoAlbums.companyId, req.companyId!), eq(photoAlbums.projectId, req.projectId!)))
      .orderBy(asc(photoAlbums.name));
    const byName = new Map(records.map((r) => [r.name, r]));
    const visible = (name: string | null) => {
      if (!name) return true;
      const rec = byName.get(name);
      if (!rec || rec.isPrivate === 0) return true;
      return admin || rec.createdBy === me || rec.allowedUserIds.includes(me);
    };
    const items = counts
      .filter((c) => visible(c.album))
      .map((c) => {
        const rec = c.album ? byName.get(c.album) : undefined;
        return {
          album: c.album,
          count: Number(c.n),
          id: rec?.id ?? null,
          description: rec?.description ?? null,
          isPrivate: rec?.isPrivate === 1,
          allowedUserIds: rec?.allowedUserIds ?? [],
          createdBy: rec?.createdBy ?? null,
        };
      });
    for (const rec of records) {
      if (!visible(rec.name) || items.some((i) => i.album === rec.name)) continue;
      items.push({ album: rec.name, count: 0, id: rec.id, description: rec.description, isPrivate: rec.isPrivate === 1, allowedUserIds: rec.allowedUserIds, createdBy: rec.createdBy });
    }
    return { items };
  });

  app.post("/projects/:projectId/photos/albums", { preHandler: standardGate }, async (req, reply) => {
    const body = albumSchema.parse(req.body);
    await assertCompanyUsers(app.db, req.companyId!, body.allowedUserIds ?? []);
    const existing = (
      await app.db
        .select({ id: photoAlbums.id })
        .from(photoAlbums)
        .where(and(eq(photoAlbums.projectId, req.projectId!), eq(photoAlbums.name, body.name)))
        .limit(1)
    )[0];
    if (existing) throw badRequest(`Album "${body.name}" already exists on this project`);
    const id = newId("alb");
    await app.db.insert(photoAlbums).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      name: body.name,
      description: body.description ?? null,
      isPrivate: body.isPrivate ? 1 : 0,
      allowedUserIds: body.allowedUserIds ?? [],
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "photo_album",
      objectId: id,
      payload: { name: body.name, isPrivate: Boolean(body.isPrivate) },
      projectId: req.projectId!,
    });
    return reply.status(201).send((await app.db.select().from(photoAlbums).where(eq(photoAlbums.id, id)).limit(1))[0]);
  });

  app.patch("/projects/:projectId/photos/albums/:albumId", { preHandler: standardGate }, async (req) => {
    const { albumId } = req.params as { albumId: string };
    const body = albumSchema.partial().parse(req.body);
    const rec = (
      await app.db
        .select()
        .from(photoAlbums)
        .where(and(eq(photoAlbums.id, albumId), eq(photoAlbums.companyId, req.companyId!), eq(photoAlbums.projectId, req.projectId!)))
        .limit(1)
    )[0];
    if (!rec) throw notFound("Album not found");
    if (rec.createdBy !== req.user!.id && !(await isPhotosAdmin(req, req.projectId!))) {
      throw forbidden("Only the album's creator or a photos admin can change it");
    }
    await assertCompanyUsers(app.db, req.companyId!, body.allowedUserIds ?? []);
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    if (body.name !== undefined) set["name"] = body.name;
    if (body.description !== undefined) set["description"] = body.description;
    if (body.isPrivate !== undefined) set["isPrivate"] = body.isPrivate ? 1 : 0;
    if (body.allowedUserIds !== undefined) set["allowedUserIds"] = body.allowedUserIds;
    await app.db.transaction(async (tx) => {
      await tx.update(photoAlbums).set(set).where(eq(photoAlbums.id, albumId));
      if (body.name !== undefined && body.name !== rec.name) {
        await tx.update(photos).set({ album: body.name }).where(and(eq(photos.projectId, req.projectId!), eq(photos.album, rec.name)));
      }
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "photo_album",
      objectId: albumId,
      payload: { changed: Object.keys(body), renamedFrom: body.name !== undefined && body.name !== rec.name ? rec.name : null },
      projectId: req.projectId!,
    });
    return (await app.db.select().from(photoAlbums).where(eq(photoAlbums.id, albumId)).limit(1))[0];
  });

  app.get("/projects/:projectId/photos/tags", { preHandler: readGate }, async (req) => {
    const rows = await app.db.select({ tags: photos.tags, aiTags: photos.aiTags }).from(photos).where(scope(req)).limit(5000);
    const manual = new Map<string, number>();
    const ai = new Map<string, number>();
    for (const r of rows) {
      for (const t of r.tags) manual.set(t, (manual.get(t) ?? 0) + 1);
      for (const t of r.aiTags) ai.set(t, (ai.get(t) ?? 0) + 1);
    }
    const merged = new Map<string, { tag: string; manual: number; ai: number }>();
    for (const [tag, n] of manual) merged.set(tag, { tag, manual: n, ai: 0 });
    for (const [tag, n] of ai) merged.set(tag, { ...(merged.get(tag) ?? { tag, manual: 0, ai: 0 }), ai: n });
    return {
      items: [...merged.values()].sort((a, b) => b.manual + b.ai - (a.manual + a.ai) || a.tag.localeCompare(b.tag)).slice(0, 200),
      sampled: rows.length,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Bulk download (#438)                                              */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/photos/bulk-download", { preHandler: readGate }, async (req, reply) => {
    const body = bulkDownloadSchema.parse(req.body);
    const rows = await app.db
      .select({ photo: photos, fileName: files.name, storageKey: files.storageKey, sizeBytes: files.sizeBytes })
      .from(photos)
      .innerJoin(files, eq(files.id, photos.fileId))
      .where(and(scope(req), inArray(photos.id, body.photoIds)));
    const allowed = [];
    for (const r of rows) if (await canSeeAlbum(req, req.projectId!, r.photo.album)) allowed.push(r);
    if (allowed.length === 0) throw notFound("No downloadable photos in the selection");
    const total = allowed.reduce((s, r) => s + r.sizeBytes, 0);
    if (total > 500 * 1024 * 1024) throw new AppError(413, "Selection exceeds the 500 MB bulk-download limit — pick fewer photos");
    const entries = [];
    for (const r of allowed) {
      const data = await streamToBuffer(app.storage.readStream(r.storageKey));
      entries.push({ name: r.fileName, data, mtime: r.photo.takenAt ? new Date(r.photo.takenAt) : new Date(r.photo.createdAt) });
    }
    const archive = buildZip(entries);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "access",
      objectType: "photo_bulk_download",
      objectId: req.projectId!,
      payload: { photoIds: allowed.map((r) => r.photo.id), bytes: archive.length },
      projectId: req.projectId!,
    });
    return reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="photos-${req.projectId!}.zip"`)
      .header("content-length", String(archive.length))
      .send(archive);
  });

  /* ---------------------------------------------------------------- */
  /* One photo: detail, content, analyse, patch, delete                */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/photos/:photoId", { preHandler: readGate }, async (req) => {
    const { photoId } = req.params as { photoId: string };
    const row = await loadPhotoForLevel(req, photoId, "read");
    return withFile(row);
  });

  /**
   * Inline binary for gallery tiles and the lightbox. Deliberately NOT
   * access-logged or ledgered: a page of 48 tiles is not 48 evidentiary
   * events. Downloads via /files/:id/download remain logged.
   */
  async function sendContent(req: FastifyRequest, reply: FastifyReply, row: PhotoRow) {
    const f = (await app.db.select().from(files).where(eq(files.id, row.fileId)).limit(1))[0];
    if (!f) throw notFound("Photo file not found");
    return sendRanged(app.storage, req, reply, { storageKey: f.storageKey, sizeBytes: f.sizeBytes, contentType: f.contentType, filename: f.name, sha256: f.sha256 }, { disposition: "inline" });
  }

  app.get("/projects/:projectId/photos/:photoId/content", { preHandler: readGate }, async (req, reply) => {
    const { photoId } = req.params as { photoId: string };
    const row = await loadPhotoForLevel(req, photoId, "read");
    return sendContent(req, reply, row);
  });

  app.post("/projects/:projectId/photos/:photoId/analyse", { preHandler: standardGate }, async (req) => {
    const { photoId } = req.params as { photoId: string };
    const row = await loadPhotoForLevel(req, photoId, "standard");
    const outcome = await analysePhoto(req, row);
    return { photo: await withFile((await app.db.select().from(photos).where(eq(photos.id, photoId)).limit(1))[0]!), ...outcome, aiEnabled: aiEnabled(app) };
  });

  async function patchPhoto(req: FastifyRequest, photoId: string) {
    const body = photoPatchSchema.parse(req.body);
    const row = await loadPhotoForLevel(req, photoId, "standard");
    if (body.locationId) await assertProjectLocation(app.db, row.companyId, row.projectId, body.locationId);
    if (body.album && !(await canSeeAlbum(req, row.projectId, body.album))) throw forbidden("That album is private");
    const set: Record<string, unknown> = {};
    if (body.album !== undefined) set["album"] = body.album;
    if (body.caption !== undefined) set["caption"] = body.caption;
    if (body.takenAt !== undefined) set["takenAt"] = parseTakenAt(body.takenAt);
    if (body.latitude !== undefined) set["latitude"] = body.latitude;
    if (body.longitude !== undefined) set["longitude"] = body.longitude;
    if (body.locationId !== undefined) set["locationId"] = body.locationId;
    if (body.tags !== undefined) set["tags"] = [...new Set(body.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
    if (body.is360 !== undefined) set["is360"] = body.is360 ? 1 : 0;
    if (body.pin !== undefined) set["pin"] = body.pin;
    if (Object.keys(set).length > 0) {
      await app.db.update(photos).set(set).where(eq(photos.id, photoId));
      await appendLedger(app.db, {
        companyId: row.companyId,
        actorId: req.user!.id,
        action: "update",
        objectType: "photo",
        objectId: photoId,
        payload: { changed: Object.keys(set) },
        projectId: row.projectId,
      });
    }
    return withFile((await app.db.select().from(photos).where(eq(photos.id, photoId)).limit(1))[0]!);
  }

  async function deletePhoto(req: FastifyRequest, photoId: string) {
    const row = await loadPhotoForLevel(req, photoId, "standard");
    if (row.uploadedBy !== req.user!.id && !(await isPhotosAdmin(req, row.projectId))) {
      throw forbidden("Only the uploader or a photos admin can delete a photo");
    }
    // The underlying file row is retained for evidentiary continuity.
    await app.db.delete(photos).where(eq(photos.id, photoId));
    await appendLedger(app.db, {
      companyId: row.companyId,
      actorId: req.user!.id,
      action: "delete",
      objectType: "photo",
      objectId: photoId,
      payload: { fileId: row.fileId, album: row.album },
      projectId: row.projectId,
    });
    return { deleted: true, id: photoId };
  }

  app.patch("/projects/:projectId/photos/:photoId", { preHandler: standardGate }, async (req) => {
    const { photoId } = req.params as { photoId: string };
    return patchPhoto(req, photoId);
  });
  app.delete("/projects/:projectId/photos/:photoId", { preHandler: standardGate }, async (req) => {
    const { photoId } = req.params as { photoId: string };
    return deletePhoto(req, photoId);
  });

  /** Legacy id-addressed routes: resolve the project, then enforce the tool level. */
  app.patch("/photos/:photoId", { preHandler: companyGate }, async (req) => {
    const { photoId } = req.params as { photoId: string };
    return patchPhoto(req, photoId);
  });
  app.delete("/photos/:photoId", { preHandler: companyGate }, async (req) => {
    const { photoId } = req.params as { photoId: string };
    return deletePhoto(req, photoId);
  });
  app.get("/photos/:photoId/content", { preHandler: companyGate }, async (req, reply) => {
    const { photoId } = req.params as { photoId: string };
    const row = await loadPhotoForLevel(req, photoId, "read");
    return sendContent(req, reply, row);
  });
};
