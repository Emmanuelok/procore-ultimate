import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import { fileVersions, files, photos } from "@constructos/db";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";

const photoFieldsSchema = z.object({
  album: z.string().max(200).optional(),
  caption: z.string().max(2000).optional(),
  takenAt: z.string().max(40).optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  locationId: z.string().max(50).optional(),
});

const photoPatchSchema = z.object({
  album: z.string().max(200).nullable().optional(),
  caption: z.string().max(2000).nullable().optional(),
  takenAt: z.string().max(40).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  locationId: z.string().max(50).nullable().optional(),
});

const photoListQuery = pageQuerySchema.extend({
  album: z.string().max(200).optional(),
  search: z.string().max(200).optional(),
});

function parseTakenAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw badRequest("takenAt must be an ISO timestamp");
  return new Date(t).toISOString();
}

/** Photos & media — spec Vol I §2.10 #426-#439. Binary is served by the documents download route via fileId. */
export const photoRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("photos", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("photos", "standard"),
  ];
  const companyGate = [app.authenticate, app.requireCompany];

  app.post(
    "/projects/:projectId/photos",
    { preHandler: standardGate },
    async (req, reply) => {
      let fileBuf: Buffer | null = null;
      let filename = "photo";
      let mimetype = "application/octet-stream";
      const rawFields: Record<string, string> = {};
      for await (const part of req.parts()) {
        if (part.type === "file") {
          fileBuf = await part.toBuffer();
          if (part.filename) filename = part.filename;
          if (part.mimetype) mimetype = part.mimetype;
        } else if (typeof part.value === "string" && part.value !== "") {
          rawFields[part.fieldname] = part.value;
        }
      }
      if (!fileBuf) throw badRequest("Expected a multipart file upload");
      const meta = photoFieldsSchema.parse(rawFields);

      const saved = await app.storage.saveBuffer(req.companyId!, fileBuf);
      const fileId = newId("fil");
      await app.db.insert(files).values({
        id: fileId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        folderId: null,
        name: filename,
        contentType: mimetype,
        sizeBytes: saved.sizeBytes,
        sha256: saved.sha256,
        storageKey: saved.storageKey,
        version: 1,
        isPrivate: 0,
        uploadedBy: req.user!.id,
      });
      await app.db.insert(fileVersions).values({
        id: newId("fv"),
        fileId,
        version: 1,
        contentType: mimetype,
        sizeBytes: saved.sizeBytes,
        sha256: saved.sha256,
        storageKey: saved.storageKey,
        uploadedBy: req.user!.id,
      });

      const photoId = newId("pho");
      await app.db.insert(photos).values({
        id: photoId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        fileId,
        album: meta.album ?? null,
        caption: meta.caption ?? null,
        takenAt: parseTakenAt(meta.takenAt),
        latitude: meta.latitude ?? null,
        longitude: meta.longitude ?? null,
        locationId: meta.locationId ?? null,
        uploadedBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "photo",
        objectId: photoId,
        payload: { fileId, sha256: saved.sha256, sizeBytes: saved.sizeBytes, album: meta.album },
      });
      const rows = await app.db.select().from(photos).where(eq(photos.id, photoId)).limit(1);
      return reply.status(201).send({
        ...rows[0],
        file: { id: fileId, name: filename, contentType: mimetype, sizeBytes: saved.sizeBytes },
      });
    },
  );

  app.get("/projects/:projectId/photos", { preHandler: readGate }, async (req) => {
    const q = photoListQuery.parse(req.query);
    const clauses = [eq(photos.companyId, req.companyId!), eq(photos.projectId, req.projectId!)];
    if (q.album) clauses.push(eq(photos.album, q.album));
    if (q.search) {
      clauses.push(
        or(ilike(photos.caption, `%${q.search}%`), ilike(files.name, `%${q.search}%`))!,
      );
    }
    const where = and(...clauses);
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(photos)
      .innerJoin(files, eq(files.id, photos.fileId))
      .where(where);
    const rows = await app.db
      .select({ photo: photos, fileName: files.name, contentType: files.contentType, sizeBytes: files.sizeBytes })
      .from(photos)
      .innerJoin(files, eq(files.id, photos.fileId))
      .where(where)
      .orderBy(desc(photos.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      rows.map((r) => ({
        ...r.photo,
        file: {
          id: r.photo.fileId,
          name: r.fileName,
          contentType: r.contentType,
          sizeBytes: r.sizeBytes,
        },
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.get("/projects/:projectId/photos/albums", { preHandler: readGate }, async (req) => {
    const rows = await app.db
      .select({ album: photos.album, n: count() })
      .from(photos)
      .where(and(eq(photos.companyId, req.companyId!), eq(photos.projectId, req.projectId!)))
      .groupBy(photos.album)
      .orderBy(desc(count()));
    return { items: rows.map((r) => ({ album: r.album, count: Number(r.n) })) };
  });

  app.patch("/photos/:photoId", { preHandler: companyGate }, async (req) => {
    const { photoId } = req.params as { photoId: string };
    const body = photoPatchSchema.parse(req.body);
    const rows = await app.db
      .select()
      .from(photos)
      .where(and(eq(photos.id, photoId), eq(photos.companyId, req.companyId!)))
      .limit(1);
    if (!rows[0]) throw notFound("Photo not found");
    const set: Record<string, unknown> = {};
    if (body.album !== undefined) set["album"] = body.album;
    if (body.caption !== undefined) set["caption"] = body.caption;
    if (body.takenAt !== undefined) set["takenAt"] = parseTakenAt(body.takenAt);
    if (body.latitude !== undefined) set["latitude"] = body.latitude;
    if (body.longitude !== undefined) set["longitude"] = body.longitude;
    if (body.locationId !== undefined) set["locationId"] = body.locationId;
    if (Object.keys(set).length > 0) {
      await app.db.update(photos).set(set).where(eq(photos.id, photoId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "photo",
        objectId: photoId,
        payload: { changed: Object.keys(set) },
      });
    }
    const updated = await app.db.select().from(photos).where(eq(photos.id, photoId)).limit(1);
    return updated[0];
  });

  app.delete("/photos/:photoId", { preHandler: companyGate }, async (req) => {
    const { photoId } = req.params as { photoId: string };
    const rows = await app.db
      .select()
      .from(photos)
      .where(and(eq(photos.id, photoId), eq(photos.companyId, req.companyId!)))
      .limit(1);
    if (!rows[0]) throw notFound("Photo not found");
    // The underlying file row is retained for evidentiary continuity.
    await app.db.delete(photos).where(eq(photos.id, photoId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "photo",
      objectId: photoId,
      payload: { fileId: rows[0].fileId },
    });
    return { deleted: true, id: photoId };
  });
};
