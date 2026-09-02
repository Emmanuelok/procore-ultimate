/**
 * DOCUMENTS (spec Vol I §2.2, #287–#301) — tool key `documents`.
 *
 * Folders with inherited privacy and ACLs (#291, #296, #297), versioned
 * content-addressed files with check-in/out (#292–#295, #301), metadata
 * search (#287), copy, inline preview, download tracking and the access
 * report (#299), a recycle bin, and e-mail-to-folder ingestion (#300).
 *
 * Authorisation: project-scoped routes carry the `documents` tool gate; the
 * id-scoped `/files/:fileId` routes resolve the file's project and enforce
 * the same tool level through `assertToolLevel`, then apply the folder's
 * ACL and privacy — a member who can list a folder can read what is in it,
 * a member who cannot cannot fetch its files by id either.
 *
 * Deliberately not here: OCR/full-text of arbitrary office documents (only
 * spec books and drawing sheets get a text layer, in their own modules) and
 * the transport that delivers e-mail — `POST …/documents/inbound` accepts
 * the parsed message a provider webhook or an MTA hands it.
 */
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
  like,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  documentInboundEmails,
  drawingRevisions,
  drawingSets,
  fileAccessLog,
  files,
  fileVersions,
  folders,
  photos,
  specBooks,
  specSectionRevisions,
  submittals,
  users,
} from "@constructos/db";
import { DOCUMENT_TYPES, FOLDER_PERMISSION_LEVELS, meetsLevel } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { forEachCompany } from "../../lib/scheduler.js";
import type { Db } from "../../lib/db.js";
import { pushNotifications } from "../notifications/service.js";
import { sendRanged } from "../drawings/stream.js";
import { streamToBuffer } from "../drawings/pdf.js";
import { assertToolLevel, resolveToolAccess, type ResolvedAccess } from "./access.js";
import {
  levelAtLeast,
  resolveFolderVisibility,
  type FolderLevel,
  type FolderVisibility,
} from "./privacy.js";
import { buildEml, classifyUpload, parseFolderAlias, safeFilename } from "./inbound.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const folderCreateSchema = z.object({
  name: z.string().min(1).max(200).refine((v) => !v.includes("/"), "Folder names cannot contain '/'"),
  parentId: z.string().max(64).nullable().optional(),
  isPrivate: z.boolean().optional(),
});

const folderPatchSchema = z.object({
  name: z.string().min(1).max(200).refine((v) => !v.includes("/"), "Folder names cannot contain '/'").optional(),
  /** move: new parent folder id, or explicit null for root */
  parentId: z.string().max(64).nullable().optional(),
  isPrivate: z.boolean().optional(),
});

const folderPermissionsSchema = z.object({
  permissions: z.record(z.string().min(1).max(64), z.enum(FOLDER_PERMISSION_LEVELS)),
});

const filesQuerySchema = pageQuerySchema.extend({
  folderId: z.string().optional(),
  search: z.string().max(200).optional(),
  documentType: z.enum(DOCUMENT_TYPES).optional(),
  tag: z.string().max(60).optional(),
  uploadedBy: z.string().max(64).optional(),
  contentType: z.string().max(120).optional(),
  checkedOut: z.enum(["0", "1"]).optional(),
  updatedAfter: z.string().max(40).optional(),
  updatedBefore: z.string().max(40).optional(),
  /** recycle bin (documents admin only) */
  deleted: z.enum(["0", "1"]).optional(),
  /** include files owned by the drawing/spec pipelines */
  includePipeline: z.enum(["0", "1"]).optional(),
});

const filePatchSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  folderId: z.string().max(64).nullable().optional(),
  isPrivate: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  documentType: z.enum(DOCUMENT_TYPES).nullable().optional(),
  tags: z.array(z.string().min(1).max(60)).max(30).optional(),
  description: z.string().max(5000).nullable().optional(),
  revisionLabel: z.string().max(60).nullable().optional(),
});

const copySchema = z.object({
  folderId: z.string().max(64).optional(),
  name: z.string().min(1).max(300).optional(),
});

const inboundSchema = z.object({
  messageId: z.string().max(300).nullable().optional(),
  from: z.string().max(300).nullable().optional(),
  to: z.string().max(500).nullable().optional(),
  subject: z.string().max(500).nullable().optional(),
  receivedAt: z.string().max(40).nullable().optional(),
  text: z.string().max(200_000).nullable().optional(),
  /** explicit target; otherwise parsed from the "+folderId" alias in `to` */
  folderId: z.string().max(64).optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1).max(300),
        contentType: z.string().max(120).optional(),
        contentBase64: z.string().min(1),
      }),
    )
    .max(25)
    .default([]),
});

const accessReportQuery = z.object({
  since: z.string().max(40).optional(),
  fileId: z.string().max(64).optional(),
  userId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const PIPELINE_KINDS = ["drawing_set", "spec_book"];
const STALE_CHECKOUT_DAYS = 7;
const PREVIEWABLE = /^(application\/pdf|image\/(png|jpeg|gif|webp|svg\+xml|bmp)|text\/(plain|csv|markdown|html)|application\/json)$/;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function rowsOf<T>(result: unknown): T[] {
  const r = result as { rows?: T[] } | T[];
  return Array.isArray(r) ? r : (r.rows ?? []);
}

function fieldValue(fields: unknown, key: string): string | undefined {
  const f = (fields as Record<string, unknown>)?.[key];
  const v = Array.isArray(f) ? f[0] : f;
  if (v && typeof v === "object" && "value" in v) {
    const val = (v as { value: unknown }).value;
    if (typeof val === "string" && val.length > 0) return val;
  }
  return undefined;
}

function isPipelineOwned(metadata: unknown): boolean {
  const kind = (metadata as Record<string, unknown> | null)?.["kind"];
  return typeof kind === "string" && PIPELINE_KINDS.includes(kind);
}

type FileRow = typeof files.$inferSelect;
type FolderRow = typeof folders.$inferSelect;

interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  isPrivate: number;
  permissions: Record<string, string>;
  effectiveLevel: FolderLevel;
  createdBy: string;
  createdAt: string;
  fileCount: number;
  children: FolderNode[];
}

export const documentsModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("documents", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("documents", "standard"),
  ];
  const adminGate = [app.authenticate, app.requireCompany, app.requireTool("documents", "admin")];
  const companyGate = [app.authenticate, app.requireCompany];

  /* ---------------------------------------------------------------- */
  /* Access resolution                                                 */
  /* ---------------------------------------------------------------- */

  interface DocAccess {
    access: ResolvedAccess;
    toolLevel: FolderLevel;
    seesPrivate: boolean;
    isDocumentsAdmin: boolean;
  }

  async function docAccess(req: FastifyRequest, projectId: string): Promise<DocAccess> {
    const access = await resolveToolAccess(app, req, projectId, "documents");
    const toolLevel: FolderLevel = access.bypass ? "admin" : access.level;
    const isDocumentsAdmin = access.bypass || access.level === "admin";
    return { access, toolLevel, seesPrivate: isDocumentsAdmin, isDocumentsAdmin };
  }

  async function projectFolders(projectId: string): Promise<FolderRow[]> {
    return app.db.select().from(folders).where(eq(folders.projectId, projectId)).orderBy(asc(folders.path));
  }

  async function folderVisibility(
    req: FastifyRequest,
    projectId: string,
    da: DocAccess,
  ): Promise<{ rows: FolderRow[]; vis: FolderVisibility }> {
    const rows = await projectFolders(projectId);
    const vis = resolveFolderVisibility(rows, req.user!.id, da.toolLevel, da.seesPrivate);
    return { rows, vis };
  }

  /** Effective level for the caller on a folder (null folder = the project itself). */
  function levelOn(vis: FolderVisibility, da: DocAccess, folderId: string | null): FolderLevel {
    if (!folderId) return da.toolLevel;
    if (vis.hidden.has(folderId)) return "none";
    return vis.levels.get(folderId) ?? da.toolLevel;
  }

  interface LoadedFile {
    file: FileRow;
    da: DocAccess;
    vis: FolderVisibility;
    level: FolderLevel;
  }

  /**
   * Load a file by id enforcing tenant, tool level, folder ACL and privacy.
   * `wanted` is the level the operation needs; a non-member sees 404.
   */
  async function loadFile(
    req: FastifyRequest,
    fileId: string,
    wanted: FolderLevel,
    options: { includeDeleted?: boolean } = {},
  ): Promise<LoadedFile> {
    const rows = await app.db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.companyId, req.companyId!)))
      .limit(1);
    const f = rows[0];
    if (!f) throw notFound("File not found");
    if (f.deletedAt && !options.includeDeleted) throw notFound("File not found");
    if (!f.projectId) {
      if (req.companyRole !== "owner" && req.companyRole !== "admin") throw notFound("File not found");
      const vis = resolveFolderVisibility([], req.user!.id, "admin", true);
      return {
        file: f,
        da: {
          access: { level: "admin", bypass: true, templateKey: null, isMember: true, assurance: false },
          toolLevel: "admin",
          seesPrivate: true,
          isDocumentsAdmin: true,
        },
        vis,
        level: "admin",
      };
    }
    const da = await docAccess(req, f.projectId);
    req.projectId = f.projectId;
    if (!da.access.bypass && da.access.level === "none") throw notFound("File not found");
    const { vis } = await folderVisibility(req, f.projectId, da);
    const level = levelOn(vis, da, f.folderId);
    if (level === "none") throw notFound("File not found");
    if (f.isPrivate === 1 && !da.seesPrivate && level !== "admin") throw notFound("File not found");
    if (!levelAtLeast(level, wanted)) throw forbidden(`Requires ${wanted} access to documents`);
    return { file: f, da, vis, level };
  }

  async function peopleMap(ids: Iterable<string | null | undefined>) {
    const wanted = [...new Set([...ids].filter((v): v is string => Boolean(v)))];
    if (wanted.length === 0) return {} as Record<string, { id: string; name: string; email: string }>;
    const rows = await app.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, wanted));
    return Object.fromEntries(rows.map((r) => [r.id, r])) as Record<string, { id: string; name: string; email: string }>;
  }

  async function logAccess(
    req: FastifyRequest,
    f: FileRow,
    action: string,
    context: string,
    version?: number | null,
  ) {
    await app.db.insert(fileAccessLog).values({
      id: newId("fal"),
      fileId: f.id,
      userId: req.user!.id,
      action,
      companyId: f.companyId,
      projectId: f.projectId,
      context,
      version: version ?? f.version,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "access",
      objectType: "file",
      objectId: f.id,
      payload: { action, context, version: version ?? f.version },
      projectId: f.projectId,
    });
  }

  /** Where a file is referenced by another module — deletion must refuse. */
  async function fileReferences(fileId: string): Promise<string[]> {
    const refs: string[] = [];
    const [rev] = await app.db
      .select({ n: count() })
      .from(drawingRevisions)
      .where(eq(drawingRevisions.fileId, fileId));
    if (Number(rev?.n ?? 0) > 0) refs.push(`${rev!.n} drawing revision(s)`);
    const [sets] = await app.db
      .select({ n: count() })
      .from(drawingSets)
      .where(eq(drawingSets.sourceFileId, fileId));
    if (Number(sets?.n ?? 0) > 0) refs.push(`${sets!.n} drawing set(s)`);
    const [books] = await app.db
      .select({ n: count() })
      .from(specBooks)
      .where(eq(specBooks.sourceFileId, fileId));
    if (Number(books?.n ?? 0) > 0) refs.push(`${books!.n} spec book(s)`);
    const [srevs] = await app.db
      .select({ n: count() })
      .from(specSectionRevisions)
      .where(eq(specSectionRevisions.fileId, fileId));
    if (Number(srevs?.n ?? 0) > 0) refs.push(`${srevs!.n} spec section revision(s)`);
    const [subs] = await app.db
      .select({ n: count() })
      .from(submittals)
      .where(sql`${submittals.fileIds} @> ${JSON.stringify([fileId])}::jsonb`);
    if (Number(subs?.n ?? 0) > 0) refs.push(`${subs!.n} submittal(s)`);
    const [phs] = await app.db.select({ n: count() }).from(photos).where(eq(photos.fileId, fileId));
    if (Number(phs?.n ?? 0) > 0) refs.push(`${phs!.n} photo(s)`);
    return refs;
  }

  /* ---------------------------------------------------------------- */
  /* Folders (spec #290, #291, #296, #297)                             */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/folders", { preHandler: readGate }, async (req) => {
    const projectId = req.projectId!;
    const da = await docAccess(req, projectId);
    const { rows, vis } = await folderVisibility(req, projectId, da);
    const counts = await app.db
      .select({ folderId: files.folderId, n: count() })
      .from(files)
      .where(
        and(
          eq(files.companyId, req.companyId!),
          eq(files.projectId, projectId),
          isNull(files.deletedAt),
        ),
      )
      .groupBy(files.folderId);
    const countMap = new Map(counts.map((c) => [c.folderId, Number(c.n)]));

    const nodes = new Map<string, FolderNode>();
    const roots: FolderNode[] = [];
    for (const r of rows) {
      if (vis.hidden.has(r.id)) continue;
      nodes.set(r.id, {
        id: r.id,
        name: r.name,
        parentId: r.parentId,
        path: r.path,
        isPrivate: r.isPrivate,
        permissions: da.isDocumentsAdmin ? r.permissions : {},
        effectiveLevel: vis.levels.get(r.id) ?? da.toolLevel,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        fileCount: countMap.get(r.id) ?? 0,
        children: [],
      });
    }
    for (const node of nodes.values()) {
      const parent = node.parentId ? nodes.get(node.parentId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return {
      items: roots,
      total: nodes.size,
      access: { level: da.toolLevel, seesPrivate: da.seesPrivate },
    };
  });

  app.post("/projects/:projectId/folders", { preHandler: standardGate }, async (req, reply) => {
    const body = folderCreateSchema.parse(req.body);
    const projectId = req.projectId!;
    const da = await docAccess(req, projectId);
    const { rows, vis } = await folderVisibility(req, projectId, da);
    let parentPath = "";
    if (body.parentId) {
      const parent = rows.find((f) => f.id === body.parentId);
      if (!parent || vis.hidden.has(parent.id)) throw notFound("Parent folder not found");
      if (!levelAtLeast(levelOn(vis, da, parent.id), "standard")) {
        throw forbidden("You do not have standard access to the parent folder");
      }
      parentPath = parent.path;
    }
    if (body.isPrivate && !da.isDocumentsAdmin) {
      throw forbidden("Only documents admins can create private folders");
    }
    const path = `${parentPath}/${body.name}`;
    if (rows.some((f) => f.path === path)) {
      throw conflict("A folder with this name already exists here");
    }
    const id = newId("fld");
    const row = {
      id,
      companyId: req.companyId!,
      projectId,
      parentId: body.parentId ?? null,
      name: body.name,
      path,
      isPrivate: body.isPrivate ? 1 : 0,
      createdBy: req.user!.id,
    };
    await app.db.insert(folders).values(row);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "folder",
      objectId: id,
      payload: row,
      projectId,
    });
    return reply.status(201).send(row);
  });

  app.patch("/projects/:projectId/folders/:folderId", { preHandler: standardGate }, async (req) => {
    const { folderId } = req.params as { folderId: string };
    const body = folderPatchSchema.parse(req.body);
    const projectId = req.projectId!;
    const da = await docAccess(req, projectId);
    const { rows, vis } = await folderVisibility(req, projectId, da);
    const folder = rows.find((f) => f.id === folderId);
    if (!folder || vis.hidden.has(folder.id)) throw notFound("Folder not found");
    if (!levelAtLeast(levelOn(vis, da, folder.id), "standard")) {
      throw forbidden("You do not have standard access to this folder");
    }
    if (body.isPrivate !== undefined && !da.isDocumentsAdmin) {
      throw forbidden("Only documents admins can change a folder's privacy");
    }

    const newName = body.name ?? folder.name;
    let newParentId = folder.parentId;
    let parentPath = folder.path.slice(0, folder.path.length - folder.name.length - 1);

    if (body.parentId !== undefined) {
      newParentId = body.parentId;
      if (body.parentId === null) {
        parentPath = "";
      } else {
        if (body.parentId === folderId) throw badRequest("A folder cannot be its own parent");
        const parent = rows.find((f) => f.id === body.parentId);
        if (!parent || vis.hidden.has(parent.id)) throw notFound("Target parent folder not found");
        if (parent.path === folder.path || parent.path.startsWith(`${folder.path}/`)) {
          throw badRequest("Cannot move a folder into its own subtree");
        }
        if (!levelAtLeast(levelOn(vis, da, parent.id), "standard")) {
          throw forbidden("You do not have standard access to the target folder");
        }
        parentPath = parent.path;
      }
    }

    const oldPath = folder.path;
    const newPath = `${parentPath}/${newName}`;
    if (newPath !== oldPath && rows.some((f) => f.path === newPath && f.id !== folderId)) {
      throw conflict("A folder with this name already exists here");
    }

    await app.db.transaction(async (tx) => {
      await tx
        .update(folders)
        .set({
          name: newName,
          parentId: newParentId,
          path: newPath,
          isPrivate: body.isPrivate === undefined ? folder.isPrivate : body.isPrivate ? 1 : 0,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(folders.id, folderId));
      if (newPath !== oldPath) {
        const descendants = await tx
          .select({ id: folders.id, path: folders.path })
          .from(folders)
          .where(
            and(
              eq(folders.projectId, projectId),
              like(folders.path, `${oldPath}/%`),
              ne(folders.id, folderId),
            ),
          );
        for (const d of descendants) {
          await tx
            .update(folders)
            .set({ path: newPath + d.path.slice(oldPath.length) })
            .where(eq(folders.id, d.id));
        }
      }
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "folder",
      objectId: folderId,
      payload: { ...body, oldPath, newPath },
      projectId,
    });
    const updated = await app.db.select().from(folders).where(eq(folders.id, folderId)).limit(1);
    return updated[0];
  });

  /** Folder ACL (#291): { userId: level }, inherited down the path. */
  app.put(
    "/projects/:projectId/folders/:folderId/permissions",
    { preHandler: adminGate },
    async (req) => {
      const { folderId } = req.params as { folderId: string };
      const body = folderPermissionsSchema.parse(req.body);
      const rows = await app.db
        .select()
        .from(folders)
        .where(and(eq(folders.id, folderId), eq(folders.projectId, req.projectId!)))
        .limit(1);
      if (!rows[0]) throw notFound("Folder not found");
      await app.db
        .update(folders)
        .set({ permissions: body.permissions, updatedAt: new Date().toISOString() })
        .where(eq(folders.id, folderId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "folder",
        objectId: folderId,
        payload: { permissions: body.permissions, previous: rows[0].permissions },
        projectId: req.projectId!,
      });
      const updated = await app.db.select().from(folders).where(eq(folders.id, folderId)).limit(1);
      return { ...updated[0]!, people: await peopleMap(Object.keys(body.permissions)) };
    },
  );

  app.delete("/projects/:projectId/folders/:folderId", { preHandler: standardGate }, async (req) => {
    const { folderId } = req.params as { folderId: string };
    const projectId = req.projectId!;
    const da = await docAccess(req, projectId);
    const { rows, vis } = await folderVisibility(req, projectId, da);
    const folder = rows.find((f) => f.id === folderId);
    if (!folder || vis.hidden.has(folder.id)) throw notFound("Folder not found");
    if (!levelAtLeast(levelOn(vis, da, folder.id), "standard")) {
      throw forbidden("You do not have standard access to this folder");
    }
    const [childFolders] = await app.db
      .select({ n: count() })
      .from(folders)
      .where(eq(folders.parentId, folderId));
    const [childFiles] = await app.db
      .select({ n: count() })
      .from(files)
      .where(and(eq(files.folderId, folderId), isNull(files.deletedAt)));
    if (Number(childFolders?.n ?? 0) > 0 || Number(childFiles?.n ?? 0) > 0) {
      throw conflict("Folder is not empty");
    }
    await app.db.delete(folders).where(eq(folders.id, folderId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "folder",
      objectId: folderId,
      payload: { name: folder.name, path: folder.path },
      projectId,
    });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* Files (spec #292-#299, #301)                                      */
  /* ---------------------------------------------------------------- */

  /** Multi-file upload into a folder. Each part is classified before it is stored. */
  app.post(
    "/projects/:projectId/folders/:folderId/files",
    { preHandler: standardGate },
    async (req, reply) => {
      const { folderId } = req.params as { folderId: string };
      const projectId = req.projectId!;
      const da = await docAccess(req, projectId);
      const { rows, vis } = await folderVisibility(req, projectId, da);
      const folder = rows.find((f) => f.id === folderId);
      if (!folder || vis.hidden.has(folder.id)) throw notFound("Folder not found");
      if (!levelAtLeast(levelOn(vis, da, folder.id), "standard")) {
        throw forbidden("You do not have standard access to this folder");
      }

      const created: FileRow[] = [];
      const rejected: Array<{ filename: string; reason: string }> = [];
      let sawPart = false;
      const maxBytes = app.appConfig.UPLOAD_MAX_BYTES;
      for await (const part of req.files()) {
        sawPart = true;
        const filename = safeFilename(part.filename);
        const cls = classifyUpload(part.mimetype, filename);
        if (!cls.ok) {
          part.file.resume();
          rejected.push({ filename, reason: cls.reason ?? "Rejected" });
          continue;
        }
        const buf = await streamToBuffer(part.file);
        if (part.file.truncated || buf.length > maxBytes) {
          rejected.push({ filename, reason: `Exceeds the ${Math.round(maxBytes / (1024 * 1024))} MiB upload limit` });
          continue;
        }
        if (buf.length === 0) {
          rejected.push({ filename, reason: "Empty file" });
          continue;
        }
        const saved = await app.storage.saveBuffer(req.companyId!, buf);
        const documentTypeRaw = fieldValue(part.fields, "documentType");
        const documentType = DOCUMENT_TYPES.includes(documentTypeRaw as (typeof DOCUMENT_TYPES)[number])
          ? documentTypeRaw!
          : null;
        const tags = (fieldValue(part.fields, "tags") ?? "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 30);
        const fileId = newId("fil");
        const now = new Date().toISOString();
        const fileRow = {
          id: fileId,
          companyId: req.companyId!,
          projectId,
          folderId,
          name: filename,
          contentType: cls.contentType,
          sizeBytes: saved.sizeBytes,
          sha256: saved.sha256,
          storageKey: saved.storageKey,
          version: 1,
          isPrivate: 0,
          documentType,
          tags,
          description: fieldValue(part.fields, "description") ?? null,
          revisionLabel: fieldValue(part.fields, "revisionLabel") ?? null,
          uploadedBy: req.user!.id,
          createdAt: now,
          updatedAt: now,
        };
        await app.db.insert(files).values(fileRow);
        await app.db.insert(fileVersions).values({
          id: newId("fv"),
          fileId,
          version: 1,
          contentType: fileRow.contentType,
          sizeBytes: saved.sizeBytes,
          sha256: saved.sha256,
          storageKey: saved.storageKey,
          uploadedBy: req.user!.id,
        });
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "create",
          objectType: "file",
          objectId: fileId,
          payload: { name: fileRow.name, sha256: saved.sha256, sizeBytes: saved.sizeBytes, folderId, documentType, tags },
          projectId,
        });
        const [row] = await app.db.select().from(files).where(eq(files.id, fileId)).limit(1);
        if (row) created.push(row);
      }
      if (!sawPart) throw badRequest("Expected a multipart file upload");
      if (created.length === 0) {
        throw badRequest("No file was accepted", { rejected });
      }
      return reply.status(201).send({ ...created[0]!, items: created, rejected });
    },
  );

  app.post("/files/:fileId/versions", { preHandler: companyGate }, async (req, reply) => {
    const { fileId } = req.params as { fileId: string };
    const { file: f } = await loadFile(req, fileId, "standard");
    if (f.checkedOutBy && f.checkedOutBy !== req.user!.id) {
      throw conflict("File is checked out by another user");
    }
    const mp = await req.file();
    if (!mp) throw badRequest("Expected a multipart file upload");
    const filename = safeFilename(mp.filename, f.name);
    const cls = classifyUpload(mp.mimetype, filename);
    if (!cls.ok) {
      mp.file.resume();
      throw badRequest(cls.reason ?? "File type not accepted");
    }
    const buf = await streamToBuffer(mp.file);
    if (mp.file.truncated) throw badRequest("File exceeds the upload limit");
    if (buf.length === 0) throw badRequest("Empty file");
    const saved = await app.storage.saveBuffer(req.companyId!, buf);
    const nextVersion = f.version + 1;
    const now = new Date().toISOString();
    await app.db.insert(fileVersions).values({
      id: newId("fv"),
      fileId,
      version: nextVersion,
      contentType: cls.contentType,
      sizeBytes: saved.sizeBytes,
      sha256: saved.sha256,
      storageKey: saved.storageKey,
      note: fieldValue(mp.fields, "note") ?? null,
      uploadedBy: req.user!.id,
    });
    await app.db
      .update(files)
      .set({
        version: nextVersion,
        contentType: cls.contentType,
        sizeBytes: saved.sizeBytes,
        sha256: saved.sha256,
        storageKey: saved.storageKey,
        name: filename,
        // a new version by the holder releases the checkout (#293)
        checkedOutBy: f.checkedOutBy === req.user!.id ? null : f.checkedOutBy,
        checkedOutAt: f.checkedOutBy === req.user!.id ? null : f.checkedOutAt,
        updatedAt: now,
      })
      .where(eq(files.id, fileId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "file",
      objectId: fileId,
      payload: { version: nextVersion, sha256: saved.sha256, sizeBytes: saved.sizeBytes },
      projectId: f.projectId,
    });
    const updated = await app.db.select().from(files).where(eq(files.id, fileId)).limit(1);
    return reply.status(201).send(updated[0]);
  });

  app.get("/projects/:projectId/files", { preHandler: readGate }, async (req) => {
    const q = filesQuerySchema.parse(req.query);
    const projectId = req.projectId!;
    const da = await docAccess(req, projectId);
    const { vis } = await folderVisibility(req, projectId, da);
    if (q.deleted === "1" && !da.isDocumentsAdmin) {
      throw forbidden("Only documents admins can view the recycle bin");
    }

    const conds = [eq(files.companyId, req.companyId!), eq(files.projectId, projectId)];
    conds.push(q.deleted === "1" ? isNotNull(files.deletedAt) : isNull(files.deletedAt));
    if (q.folderId) {
      if (vis.hidden.has(q.folderId)) return paginate([], 0, q);
      conds.push(eq(files.folderId, q.folderId));
    }
    if (q.search) conds.push(ilike(files.name, `%${q.search}%`));
    if (q.documentType) conds.push(eq(files.documentType, q.documentType));
    if (q.tag) conds.push(sql`${files.tags} @> ${JSON.stringify([q.tag])}::jsonb`);
    if (q.uploadedBy) conds.push(eq(files.uploadedBy, q.uploadedBy));
    if (q.contentType) conds.push(ilike(files.contentType, `${q.contentType}%`));
    if (q.checkedOut === "1") conds.push(isNotNull(files.checkedOutBy));
    if (q.checkedOut === "0") conds.push(isNull(files.checkedOutBy));
    if (q.updatedAfter) conds.push(gte(files.updatedAt, q.updatedAfter));
    if (q.updatedBefore) conds.push(lte(files.updatedAt, q.updatedBefore));
    if (!da.seesPrivate) conds.push(eq(files.isPrivate, 0));
    if (q.includePipeline !== "1") {
      conds.push(sql`coalesce(${files.metadata}->>'kind', '') not in ('drawing_set', 'spec_book')`);
    }
    const hiddenIds = [...vis.hidden];
    if (hiddenIds.length > 0 && !q.folderId) {
      conds.push(or(isNull(files.folderId), notInArray(files.folderId, hiddenIds))!);
    }
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(files).where(where);
    const items = await app.db
      .select()
      .from(files)
      .where(where)
      .orderBy(desc(files.updatedAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const people = await peopleMap([
      ...items.map((i) => i.uploadedBy),
      ...items.map((i) => i.checkedOutBy),
      ...items.map((i) => i.deletedBy),
    ]);
    return {
      ...paginate(
        items.map((f) => ({
          ...f,
          pipelineOwned: isPipelineOwned(f.metadata),
          uploadedByName: people[f.uploadedBy]?.name ?? null,
          checkedOutByName: f.checkedOutBy ? (people[f.checkedOutBy]?.name ?? null) : null,
        })),
        Number(totalRow?.n ?? 0),
        q,
      ),
      people,
      access: { level: da.toolLevel, seesPrivate: da.seesPrivate, isDocumentsAdmin: da.isDocumentsAdmin },
    };
  });

  /** Download tracking report (#299). */
  app.get("/projects/:projectId/files/access-report", { preHandler: standardGate }, async (req) => {
    const q = accessReportQuery.parse(req.query);
    const projectId = req.projectId!;
    const since = q.since ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
    const conds = [eq(fileAccessLog.projectId, projectId), gte(fileAccessLog.at, since)];
    if (q.fileId) conds.push(eq(fileAccessLog.fileId, q.fileId));
    if (q.userId) conds.push(eq(fileAccessLog.userId, q.userId));
    const where = and(...conds);

    const byFileRows = await app.db
      .select({
        fileId: fileAccessLog.fileId,
        action: fileAccessLog.action,
        n: count(),
        lastAt: sql<string>`max(${fileAccessLog.at})`,
        users: sql<number>`count(distinct ${fileAccessLog.userId})`,
      })
      .from(fileAccessLog)
      .where(where)
      .groupBy(fileAccessLog.fileId, fileAccessLog.action);
    const byUserRows = await app.db
      .select({
        userId: fileAccessLog.userId,
        n: count(),
        lastAt: sql<string>`max(${fileAccessLog.at})`,
        filesTouched: sql<number>`count(distinct ${fileAccessLog.fileId})`,
      })
      .from(fileAccessLog)
      .where(where)
      .groupBy(fileAccessLog.userId);
    const recent = await app.db
      .select()
      .from(fileAccessLog)
      .where(where)
      .orderBy(desc(fileAccessLog.at))
      .limit(q.limit);

    const fileIds = [...new Set([...byFileRows.map((r) => r.fileId), ...recent.map((r) => r.fileId)])];
    const fileRows = fileIds.length
      ? await app.db
          .select({ id: files.id, name: files.name, folderId: files.folderId, deletedAt: files.deletedAt })
          .from(files)
          .where(inArray(files.id, fileIds))
      : [];
    const fileMap = new Map(fileRows.map((f) => [f.id, f] as const));
    const byFile = new Map<string, { fileId: string; name: string | null; deleted: boolean; downloads: number; views: number; other: number; uniqueUsers: number; lastAt: string | null }>();
    for (const r of byFileRows) {
      const entry = byFile.get(r.fileId) ?? {
        fileId: r.fileId,
        name: fileMap.get(r.fileId)?.name ?? null,
        deleted: Boolean(fileMap.get(r.fileId)?.deletedAt),
        downloads: 0,
        views: 0,
        other: 0,
        uniqueUsers: 0,
        lastAt: null,
      };
      const n = Number(r.n);
      if (r.action === "download") entry.downloads += n;
      else if (r.action === "view" || r.action === "preview") entry.views += n;
      else entry.other += n;
      entry.uniqueUsers = Math.max(entry.uniqueUsers, Number(r.users));
      if (!entry.lastAt || r.lastAt > entry.lastAt) entry.lastAt = r.lastAt;
      byFile.set(r.fileId, entry);
    }
    const people = await peopleMap([...byUserRows.map((r) => r.userId), ...recent.map((r) => r.userId)]);
    const totals = {
      events: recent.length === 0 && byUserRows.length === 0 ? 0 : byUserRows.reduce((n, r) => n + Number(r.n), 0),
      downloads: [...byFile.values()].reduce((n, f) => n + f.downloads, 0),
      views: [...byFile.values()].reduce((n, f) => n + f.views, 0),
      uniqueUsers: byUserRows.length,
      uniqueFiles: byFile.size,
    };
    return {
      since,
      totals,
      byFile: [...byFile.values()].sort((a, b) => b.downloads + b.views - (a.downloads + a.views)),
      byUser: byUserRows
        .map((r) => ({
          userId: r.userId,
          name: people[r.userId]?.name ?? null,
          events: Number(r.n),
          filesTouched: Number(r.filesTouched),
          lastAt: r.lastAt,
        }))
        .sort((a, b) => b.events - a.events),
      recent: recent.map((r) => ({
        ...r,
        fileName: fileMap.get(r.fileId)?.name ?? null,
        userName: people[r.userId]?.name ?? null,
      })),
      people,
    };
  });

  /** Health inputs for the intelligence layer (plan §3.5). */
  app.get("/projects/:projectId/documents/health-inputs", { preHandler: readGate }, async (req) => {
    const projectId = req.projectId!;
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const staleBefore = new Date(Date.now() - STALE_CHECKOUT_DAYS * 86_400_000).toISOString();
    const [total] = await app.db
      .select({ n: count() })
      .from(files)
      .where(and(eq(files.projectId, projectId), isNull(files.deletedAt)));
    const [checkedOut] = await app.db
      .select({ n: count() })
      .from(files)
      .where(and(eq(files.projectId, projectId), isNull(files.deletedAt), isNotNull(files.checkedOutBy)));
    const [stale] = await app.db
      .select({ n: count() })
      .from(files)
      .where(
        and(
          eq(files.projectId, projectId),
          isNull(files.deletedAt),
          isNotNull(files.checkedOutBy),
          lt(files.checkedOutAt, staleBefore),
        ),
      );
    const [downloads] = await app.db
      .select({ n: count() })
      .from(fileAccessLog)
      .where(and(eq(fileAccessLog.projectId, projectId), gte(fileAccessLog.at, weekAgo), eq(fileAccessLog.action, "download")));
    const [inboundRejected] = await app.db
      .select({ n: count() })
      .from(documentInboundEmails)
      .where(
        and(
          eq(documentInboundEmails.projectId, projectId),
          gte(documentInboundEmails.createdAt, weekAgo),
          ne(documentInboundEmails.status, "stored"),
        ),
      );
    const reasons: string[] = [];
    if (Number(total?.n ?? 0) === 0) reasons.push("No documents have been uploaded to this project yet.");
    return {
      metrics: {
        files: Number(total?.n ?? 0),
        checkedOut: Number(checkedOut?.n ?? 0),
        staleCheckouts: Number(stale?.n ?? 0),
        downloads7d: Number(downloads?.n ?? 0),
        inboundRejected7d: Number(inboundRejected?.n ?? 0),
      },
      reasons,
    };
  });

  /* ---------------------------------------------------------------- */
  /* E-mail-to-folder ingestion (#300)                                 */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/documents/inbound", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = and(
      eq(documentInboundEmails.companyId, req.companyId!),
      eq(documentInboundEmails.projectId, req.projectId!),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(documentInboundEmails).where(where);
    const items = await app.db
      .select()
      .from(documentInboundEmails)
      .where(where)
      .orderBy(desc(documentInboundEmails.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/projects/:projectId/documents/inbound", { preHandler: standardGate }, async (req, reply) => {
    const body = inboundSchema.parse(req.body);
    const projectId = req.projectId!;
    const da = await docAccess(req, projectId);
    const { rows, vis } = await folderVisibility(req, projectId, da);

    if (body.messageId) {
      const dup = await app.db
        .select()
        .from(documentInboundEmails)
        .where(and(eq(documentInboundEmails.projectId, projectId), eq(documentInboundEmails.messageId, body.messageId)))
        .limit(1);
      if (dup[0]) return reply.status(200).send({ ...dup[0], duplicate: true });
    }

    const alias = parseFolderAlias(body.to ?? undefined);
    const folderId = body.folderId ?? alias.folderId;
    const folder = folderId ? rows.find((f) => f.id === folderId) : undefined;
    const rejectWhole = async (reason: string) => {
      const id = newId("inb");
      await app.db.insert(documentInboundEmails).values({
        id,
        companyId: req.companyId!,
        projectId,
        folderId: folderId ?? null,
        messageId: body.messageId ?? null,
        fromAddress: body.from ?? null,
        toAddress: body.to ?? null,
        subject: body.subject ?? null,
        receivedAt: body.receivedAt ?? null,
        status: "rejected",
        rejectReason: reason,
        attachmentCount: body.attachments.length,
        fileIds: [],
        rejected: body.attachments.map((a) => ({ filename: a.filename, reason })),
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "document_inbound_email",
        objectId: id,
        payload: { status: "rejected", reason, messageId: body.messageId ?? null },
        projectId,
      });
      const [row] = await app.db.select().from(documentInboundEmails).where(eq(documentInboundEmails.id, id)).limit(1);
      return reply.status(200).send(row);
    };
    if (!folderId) return rejectWhole("No target folder: address the message to <alias>+<folderId>@… or pass folderId");
    if (!folder || vis.hidden.has(folder.id)) return rejectWhole(`Folder ${folderId} does not exist on this project`);
    if (!levelAtLeast(levelOn(vis, da, folder.id), "standard")) {
      return rejectWhole("The caller does not have standard access to the target folder");
    }

    const maxBytes = app.appConfig.UPLOAD_MAX_BYTES;
    const createdIds: string[] = [];
    const rejected: Array<{ filename: string; reason: string }> = [];
    const now = new Date().toISOString();
    const storeFile = async (
      name: string,
      contentType: string,
      buf: Buffer,
      documentType: string | null,
      extraMeta: Record<string, unknown>,
    ) => {
      const saved = await app.storage.saveBuffer(req.companyId!, buf);
      const fileId = newId("fil");
      await app.db.insert(files).values({
        id: fileId,
        companyId: req.companyId!,
        projectId,
        folderId: folder.id,
        name,
        contentType,
        sizeBytes: saved.sizeBytes,
        sha256: saved.sha256,
        storageKey: saved.storageKey,
        version: 1,
        isPrivate: 0,
        documentType,
        tags: ["inbound-email"],
        metadata: { inbound: { messageId: body.messageId ?? null, from: body.from ?? null, subject: body.subject ?? null }, ...extraMeta },
        uploadedBy: req.user!.id,
        createdAt: now,
        updatedAt: now,
      });
      await app.db.insert(fileVersions).values({
        id: newId("fv"),
        fileId,
        version: 1,
        contentType,
        sizeBytes: saved.sizeBytes,
        sha256: saved.sha256,
        storageKey: saved.storageKey,
        uploadedBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "file",
        objectId: fileId,
        payload: { name, sha256: saved.sha256, sizeBytes: saved.sizeBytes, folderId: folder.id, source: "inbound_email" },
        projectId,
      });
      createdIds.push(fileId);
      return fileId;
    };

    const attachmentsMeta: Array<{ filename: string; contentType: string; sizeBytes: number }> = [];
    const decoded: Array<{ filename: string; contentType: string; buf: Buffer }> = [];
    for (const a of body.attachments) {
      const filename = safeFilename(a.filename);
      const cls = classifyUpload(a.contentType, filename);
      if (!cls.ok) {
        rejected.push({ filename, reason: cls.reason ?? "Rejected" });
        continue;
      }
      let buf: Buffer;
      try {
        buf = Buffer.from(a.contentBase64, "base64");
      } catch {
        rejected.push({ filename, reason: "Attachment is not valid base64" });
        continue;
      }
      if (buf.length === 0) {
        rejected.push({ filename, reason: "Empty attachment" });
        continue;
      }
      if (buf.length > maxBytes) {
        rejected.push({ filename, reason: `Exceeds the ${Math.round(maxBytes / (1024 * 1024))} MiB limit` });
        continue;
      }
      decoded.push({ filename, contentType: cls.contentType, buf });
      attachmentsMeta.push({ filename, contentType: cls.contentType, sizeBytes: buf.length });
    }

    const emlName = `${safeFilename((body.subject ?? "message").replace(/[<>:"|?*]/g, " ").trim() || "message").slice(0, 120)}.eml`;
    await storeFile(
      emlName,
      "message/rfc822",
      Buffer.from(buildEml({ ...body, attachments: attachmentsMeta }), "utf8"),
      "email",
      { attachments: attachmentsMeta.length },
    );
    for (const d of decoded) {
      await storeFile(d.filename, d.contentType, d.buf, null, { fromEmail: emlName });
    }

    const status = rejected.length === 0 ? "stored" : decoded.length === 0 ? "partial" : "partial";
    const id = newId("inb");
    await app.db.insert(documentInboundEmails).values({
      id,
      companyId: req.companyId!,
      projectId,
      folderId: folder.id,
      messageId: body.messageId ?? null,
      fromAddress: body.from ?? null,
      toAddress: body.to ?? null,
      subject: body.subject ?? null,
      receivedAt: body.receivedAt ?? null,
      status,
      rejectReason: rejected.length ? `${rejected.length} attachment(s) refused` : null,
      attachmentCount: body.attachments.length,
      fileIds: createdIds,
      rejected,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "document_inbound_email",
      objectId: id,
      payload: { status, folderId: folder.id, files: createdIds.length, rejected: rejected.length, messageId: body.messageId ?? null },
      projectId,
    });
    const [row] = await app.db.select().from(documentInboundEmails).where(eq(documentInboundEmails.id, id)).limit(1);
    return reply.status(201).send(row);
  });

  /* ---------------------------------------------------------------- */
  /* Id-scoped file routes                                             */
  /* ---------------------------------------------------------------- */

  app.get("/files/:fileId", { preHandler: companyGate }, async (req) => {
    const { fileId } = req.params as { fileId: string };
    const { file: f, level, da } = await loadFile(req, fileId, "read");
    const versions = await app.db
      .select()
      .from(fileVersions)
      .where(eq(fileVersions.fileId, fileId))
      .orderBy(desc(fileVersions.version));
    const [accessRow] = await app.db
      .select({ n: count() })
      .from(fileAccessLog)
      .where(eq(fileAccessLog.fileId, fileId));
    const folder = f.folderId
      ? (await app.db.select({ path: folders.path, name: folders.name }).from(folders).where(eq(folders.id, f.folderId)).limit(1))[0]
      : undefined;
    const people = await peopleMap([f.uploadedBy, f.checkedOutBy, f.deletedBy, ...versions.map((v) => v.uploadedBy)]);
    const references = isPipelineOwned(f.metadata) ? await fileReferences(fileId) : [];
    return {
      ...f,
      versions,
      accessCount: Number(accessRow?.n ?? 0),
      folderPath: folder?.path ?? null,
      pipelineOwned: isPipelineOwned(f.metadata),
      references,
      previewable: PREVIEWABLE.test(f.contentType),
      people,
      access: { level, isDocumentsAdmin: da.isDocumentsAdmin, canCheckin: f.checkedOutBy === req.user!.id || da.isDocumentsAdmin },
    };
  });

  app.get("/files/:fileId/access-log", { preHandler: companyGate }, async (req) => {
    const { fileId } = req.params as { fileId: string };
    await loadFile(req, fileId, "standard");
    const items = await app.db
      .select()
      .from(fileAccessLog)
      .where(eq(fileAccessLog.fileId, fileId))
      .orderBy(desc(fileAccessLog.at))
      .limit(200);
    const people = await peopleMap(items.map((i) => i.userId));
    return { items: items.map((i) => ({ ...i, userName: people[i.userId]?.name ?? null })), total: items.length, people };
  });

  app.get("/files/:fileId/download", { preHandler: companyGate }, async (req, reply) => {
    const { fileId } = req.params as { fileId: string };
    const q = z.object({ version: z.coerce.number().int().min(1).optional() }).parse(req.query);
    const { file: f } = await loadFile(req, fileId, "read");
    let storageKey = f.storageKey;
    let contentType = f.contentType;
    let sizeBytes = f.sizeBytes;
    let sha256 = f.sha256;
    if (q.version && q.version !== f.version) {
      const v = await app.db
        .select()
        .from(fileVersions)
        .where(and(eq(fileVersions.fileId, fileId), eq(fileVersions.version, q.version)))
        .limit(1);
      if (!v[0]) throw notFound("Version not found");
      storageKey = v[0].storageKey;
      contentType = v[0].contentType;
      sizeBytes = v[0].sizeBytes;
      sha256 = v[0].sha256;
    }
    if (!req.headers.range) await logAccess(req, f, "download", "documents", q.version ?? f.version);
    return sendRanged(app.storage, req, reply, { storageKey, sizeBytes, contentType, filename: f.name, sha256 }, { disposition: "attachment" });
  });

  /** Inline preview for pdf / images / text; logs a `view`. */
  app.get("/files/:fileId/preview", { preHandler: companyGate }, async (req, reply) => {
    const { fileId } = req.params as { fileId: string };
    const { file: f } = await loadFile(req, fileId, "read");
    if (!PREVIEWABLE.test(f.contentType)) {
      return reply.status(415).send({
        statusCode: 415,
        error: "NotPreviewable",
        message: `No inline preview for ${f.contentType}; download the file instead.`,
      });
    }
    if (!req.headers.range) await logAccess(req, f, "view", "documents");
    return sendRanged(
      app.storage,
      req,
      reply,
      { storageKey: f.storageKey, sizeBytes: f.sizeBytes, contentType: f.contentType, filename: f.name, sha256: f.sha256 },
      { disposition: "inline" },
    );
  });

  app.post("/files/:fileId/checkout", { preHandler: companyGate }, async (req) => {
    const { fileId } = req.params as { fileId: string };
    const { file: f } = await loadFile(req, fileId, "standard");
    if (f.checkedOutBy && f.checkedOutBy !== req.user!.id) {
      throw conflict("File is already checked out by another user");
    }
    if (f.checkedOutBy === req.user!.id) throw conflict("File is already checked out by you");
    const now = new Date().toISOString();
    await app.db
      .update(files)
      .set({ checkedOutBy: req.user!.id, checkedOutAt: now, staleCheckoutNotifiedAt: null, updatedAt: now })
      .where(eq(files.id, fileId));
    await app.db.insert(fileAccessLog).values({
      id: newId("fal"),
      fileId,
      userId: req.user!.id,
      action: "checkout",
      companyId: f.companyId,
      projectId: f.projectId,
      context: "documents",
      version: f.version,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "file",
      objectId: fileId,
      payload: { checkedOutBy: req.user!.id },
      projectId: f.projectId,
    });
    return { ok: true, checkedOutBy: req.user!.id, checkedOutAt: now };
  });

  app.post("/files/:fileId/checkin", { preHandler: companyGate }, async (req) => {
    const { fileId } = req.params as { fileId: string };
    const { file: f, da } = await loadFile(req, fileId, "standard");
    if (!f.checkedOutBy) throw conflict("File is not checked out");
    if (f.checkedOutBy !== req.user!.id && !da.isDocumentsAdmin) {
      throw forbidden("File is checked out by another user");
    }
    const now = new Date().toISOString();
    await app.db
      .update(files)
      .set({ checkedOutBy: null, checkedOutAt: null, staleCheckoutNotifiedAt: null, updatedAt: now })
      .where(eq(files.id, fileId));
    await app.db.insert(fileAccessLog).values({
      id: newId("fal"),
      fileId,
      userId: req.user!.id,
      action: "checkin",
      companyId: f.companyId,
      projectId: f.projectId,
      context: "documents",
      version: f.version,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "file",
      objectId: fileId,
      payload: { checkedOutBy: null, releasedBy: req.user!.id, previousHolder: f.checkedOutBy },
      projectId: f.projectId,
    });
    return { ok: true };
  });

  app.patch("/files/:fileId", { preHandler: companyGate }, async (req) => {
    const { fileId } = req.params as { fileId: string };
    const body = filePatchSchema.parse(req.body);
    const { file: f, da, vis } = await loadFile(req, fileId, "standard");
    if (f.checkedOutBy && f.checkedOutBy !== req.user!.id) {
      throw conflict("File is checked out by another user");
    }
    if (body.isPrivate !== undefined && !da.isDocumentsAdmin) {
      throw forbidden("Only documents admins can change a file's privacy");
    }
    if (body.folderId !== undefined && isPipelineOwned(f.metadata)) {
      throw badRequest("This file is owned by the drawings/specifications pipeline and cannot be moved");
    }
    if (body.folderId) {
      const folder = await app.db
        .select({ id: folders.id, projectId: folders.projectId })
        .from(folders)
        .where(and(eq(folders.id, body.folderId), eq(folders.companyId, req.companyId!)))
        .limit(1);
      if (!folder[0] || vis.hidden.has(folder[0].id)) throw notFound("Target folder not found");
      if (f.projectId && folder[0].projectId !== f.projectId) {
        throw badRequest("Target folder belongs to a different project");
      }
      if (!levelAtLeast(levelOn(vis, da, folder[0].id), "standard")) {
        throw forbidden("You do not have standard access to the target folder");
      }
    }
    await app.db
      .update(files)
      .set({
        name: body.name ?? f.name,
        folderId: body.folderId === undefined ? f.folderId : body.folderId,
        isPrivate: body.isPrivate === undefined ? f.isPrivate : body.isPrivate ? 1 : 0,
        metadata: body.metadata ? { ...(f.metadata as Record<string, unknown>), ...body.metadata } : (f.metadata as Record<string, unknown>),
        documentType: body.documentType === undefined ? f.documentType : body.documentType,
        tags: body.tags ?? f.tags,
        description: body.description === undefined ? f.description : body.description,
        revisionLabel: body.revisionLabel === undefined ? f.revisionLabel : body.revisionLabel,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(files.id, fileId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "file",
      objectId: fileId,
      payload: body,
      projectId: f.projectId,
    });
    const updated = await app.db.select().from(files).where(eq(files.id, fileId)).limit(1);
    return updated[0];
  });

  /** Copy: a new file row over the same content-addressed bytes (#294). */
  app.post("/files/:fileId/copy", { preHandler: companyGate }, async (req, reply) => {
    const { fileId } = req.params as { fileId: string };
    const body = copySchema.parse(req.body ?? {});
    const { file: f, da, vis } = await loadFile(req, fileId, "read");
    const targetFolderId = body.folderId ?? f.folderId;
    if (!targetFolderId) throw badRequest("A target folder is required");
    const folder = await app.db
      .select({ id: folders.id, projectId: folders.projectId })
      .from(folders)
      .where(and(eq(folders.id, targetFolderId), eq(folders.companyId, req.companyId!)))
      .limit(1);
    if (!folder[0] || vis.hidden.has(folder[0].id)) throw notFound("Target folder not found");
    if (f.projectId && folder[0].projectId !== f.projectId) {
      throw badRequest("Target folder belongs to a different project");
    }
    if (!levelAtLeast(levelOn(vis, da, folder[0].id), "standard")) {
      throw forbidden("You do not have standard access to the target folder");
    }
    const id = newId("fil");
    const now = new Date().toISOString();
    const name = body.name ?? (body.folderId && body.folderId !== f.folderId ? f.name : `Copy of ${f.name}`);
    await app.db.insert(files).values({
      id,
      companyId: f.companyId,
      projectId: f.projectId,
      folderId: targetFolderId,
      name,
      contentType: f.contentType,
      sizeBytes: f.sizeBytes,
      sha256: f.sha256,
      storageKey: f.storageKey,
      version: 1,
      isPrivate: f.isPrivate,
      documentType: f.documentType,
      tags: f.tags,
      description: f.description,
      revisionLabel: f.revisionLabel,
      metadata: { ...(f.metadata as Record<string, unknown>), copiedFrom: f.id, kind: undefined },
      uploadedBy: req.user!.id,
      createdAt: now,
      updatedAt: now,
    });
    await app.db.insert(fileVersions).values({
      id: newId("fv"),
      fileId: id,
      version: 1,
      contentType: f.contentType,
      sizeBytes: f.sizeBytes,
      sha256: f.sha256,
      storageKey: f.storageKey,
      note: `Copied from ${f.name} (v${f.version})`,
      uploadedBy: req.user!.id,
    });
    await logAccess(req, f, "copy", "documents");
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "file",
      objectId: id,
      payload: { name, copiedFrom: f.id, sha256: f.sha256, folderId: targetFolderId },
      projectId: f.projectId,
    });
    const [row] = await app.db.select().from(files).where(eq(files.id, id)).limit(1);
    return reply.status(201).send(row);
  });

  /** Soft delete; refuses when another module points at the bytes. */
  app.delete("/files/:fileId", { preHandler: companyGate }, async (req) => {
    const { fileId } = req.params as { fileId: string };
    const { file: f, da } = await loadFile(req, fileId, "standard");
    if (!da.isDocumentsAdmin && f.uploadedBy !== req.user!.id) {
      throw forbidden("Only the uploader or a documents admin can delete a file");
    }
    if (f.checkedOutBy && f.checkedOutBy !== req.user!.id) {
      throw conflict("File is checked out by another user");
    }
    const refs = await fileReferences(fileId);
    if (refs.length > 0) {
      throw conflict(`This file is referenced by ${refs.join(", ")} and cannot be deleted from Documents`);
    }
    const now = new Date().toISOString();
    await app.db
      .update(files)
      .set({ deletedAt: now, deletedBy: req.user!.id, checkedOutBy: null, checkedOutAt: null, updatedAt: now })
      .where(eq(files.id, fileId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "file",
      objectId: fileId,
      payload: { name: f.name, sha256: f.sha256, soft: true },
      projectId: f.projectId,
    });
    return { ok: true, deletedAt: now };
  });

  app.post("/files/:fileId/restore", { preHandler: companyGate }, async (req) => {
    const { fileId } = req.params as { fileId: string };
    const { file: f, da } = await loadFile(req, fileId, "standard", { includeDeleted: true });
    if (!f.deletedAt) throw conflict("File is not in the recycle bin");
    if (!da.isDocumentsAdmin) throw forbidden("Only documents admins can restore files");
    const now = new Date().toISOString();
    await app.db
      .update(files)
      .set({ deletedAt: null, deletedBy: null, updatedAt: now })
      .where(eq(files.id, fileId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "file",
      objectId: fileId,
      payload: { restored: true, deletedAt: f.deletedAt, deletedBy: f.deletedBy },
      projectId: f.projectId,
    });
    const [row] = await app.db.select().from(files).where(eq(files.id, fileId)).limit(1);
    return row;
  });

  /* ---------------------------------------------------------------- */
  /* Scheduler: stale checkouts (#293)                                 */
  /* ---------------------------------------------------------------- */

  async function sweepStaleCheckouts(db: Db, companyId: string, now: Date) {
    const cutoff = new Date(now.getTime() - STALE_CHECKOUT_DAYS * 86_400_000).toISOString();
    const stale = await db
      .select()
      .from(files)
      .where(
        and(
          eq(files.companyId, companyId),
          isNull(files.deletedAt),
          isNotNull(files.checkedOutBy),
          lt(files.checkedOutAt, cutoff),
          isNull(files.staleCheckoutNotifiedAt),
        ),
      )
      .limit(500);
    for (const f of stale) {
      await pushNotifications(db, [
        {
          companyId,
          userId: f.checkedOutBy!,
          projectId: f.projectId,
          kind: "reminder",
          title: `"${f.name}" has been checked out for over ${STALE_CHECKOUT_DAYS} days`,
          body: "Check it in, or upload the new version, so the rest of the team can work on it.",
          recordType: "file",
          recordId: f.id,
        },
      ]);
      await db
        .update(files)
        .set({ staleCheckoutNotifiedAt: now.toISOString() })
        .where(eq(files.id, f.id));
    }
    return stale.length;
  }

  app.scheduler.register({
    name: "documents.stale-checkouts",
    description: `Remind holders of files checked out for more than ${STALE_CHECKOUT_DAYS} days`,
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => {
      let notified = 0;
      const summary = await forEachCompany(db, async (companyId) => {
        notified += await sweepStaleCheckouts(db, companyId, now);
      });
      return { ...summary, notified };
    },
  });

  // Keep the raw-rows helper referenced for drivers that return { rows }.
  void rowsOf;
};
