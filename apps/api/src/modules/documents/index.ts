import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, count, desc, eq, ilike, isNull, like, ne, notInArray, or } from "drizzle-orm";
import { z } from "zod";
import {
  fileAccessLog,
  files,
  fileVersions,
  folders,
  permissionTemplates,
  projectMemberships,
} from "@constructos/db";
import {
  BUILTIN_PERMISSION_TEMPLATES,
  meetsLevel,
  resolveLevel,
  type ToolPermissionMap,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const folderCreateSchema = z.object({
  name: z.string().min(1).max(200),
  parentId: z.string().max(64).nullable().optional(),
  isPrivate: z.boolean().optional(),
});

const folderPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  /** move: new parent folder id, or explicit null for root */
  parentId: z.string().max(64).nullable().optional(),
  isPrivate: z.boolean().optional(),
});

const filesQuerySchema = pageQuerySchema.extend({
  folderId: z.string().optional(),
  search: z.string().max(200).optional(),
});

const filePatchSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  folderId: z.string().max(64).nullable().optional(),
  isPrivate: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/* ------------------------------------------------------------------ */
/* Private-visibility helper                                           */
/*                                                                     */
/* Private folders/files are visible only to users with documents      */
/* admin: company owners/admins always qualify; project members        */
/* qualify when their permission template (+overrides) resolves        */
/* documents >= admin. (Spec Vol I #291/#297.)                         */
/* ------------------------------------------------------------------ */

async function canSeePrivate(db: Db, req: FastifyRequest, projectId: string | null) {
  if (req.companyRole === "owner" || req.companyRole === "admin") return true;
  if (!projectId || !req.user || !req.companyId) return false;
  const membership = await db
    .select()
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.projectId, projectId),
        eq(projectMemberships.userId, req.user.id),
      ),
    )
    .limit(1);
  if (!membership[0]) return false;
  const templateRow = await db
    .select({ tools: permissionTemplates.tools })
    .from(permissionTemplates)
    .where(
      and(
        eq(permissionTemplates.companyId, req.companyId),
        eq(permissionTemplates.key, membership[0].templateKey),
      ),
    )
    .limit(1);
  const template =
    (templateRow[0]?.tools as ToolPermissionMap | undefined) ??
    BUILTIN_PERMISSION_TEMPLATES.find((t) => t.key === membership[0]!.templateKey)?.tools;
  const effective = resolveLevel(
    "documents",
    template,
    membership[0].overrides as ToolPermissionMap,
  );
  return meetsLevel(effective, "admin");
}

interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  isPrivate: number;
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

  /** Load a file scoped to the tenant, enforcing private-flag visibility. */
  async function loadFile(req: FastifyRequest, fileId: string) {
    const rows = await app.db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.companyId, req.companyId!)))
      .limit(1);
    const f = rows[0];
    if (!f) throw notFound("File not found");
    if (f.isPrivate === 1 && !(await canSeePrivate(app.db, req, f.projectId))) {
      throw notFound("File not found");
    }
    // Private-folder containment also hides the file.
    if (f.folderId) {
      const folder = await app.db
        .select({ isPrivate: folders.isPrivate, projectId: folders.projectId })
        .from(folders)
        .where(eq(folders.id, f.folderId))
        .limit(1);
      if (
        folder[0]?.isPrivate === 1 &&
        !(await canSeePrivate(app.db, req, folder[0].projectId))
      ) {
        throw notFound("File not found");
      }
    }
    return f;
  }

  /* ---------------------------------------------------------------- */
  /* Folders (spec #290, #291, #296, #297)                             */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/folders",
    { preHandler: readGate },
    async (req) => {
      const projectId = req.projectId!;
      const showPrivate = await canSeePrivate(app.db, req, projectId);
      const where = showPrivate
        ? and(eq(folders.companyId, req.companyId!), eq(folders.projectId, projectId))
        : and(
            eq(folders.companyId, req.companyId!),
            eq(folders.projectId, projectId),
            eq(folders.isPrivate, 0),
          );
      const rows = await app.db.select().from(folders).where(where).orderBy(folders.path);

      // file counts per folder
      const counts = await app.db
        .select({ folderId: files.folderId, n: count() })
        .from(files)
        .where(and(eq(files.companyId, req.companyId!), eq(files.projectId, projectId)))
        .groupBy(files.folderId);
      const countMap = new Map(counts.map((c) => [c.folderId, Number(c.n)]));

      const nodes = new Map<string, FolderNode>();
      const roots: FolderNode[] = [];
      for (const r of rows) {
        nodes.set(r.id, {
          id: r.id,
          name: r.name,
          parentId: r.parentId,
          path: r.path,
          isPrivate: r.isPrivate,
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
      return { items: roots, total: rows.length };
    },
  );

  app.post(
    "/projects/:projectId/folders",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = folderCreateSchema.parse(req.body);
      const projectId = req.projectId!;
      let parentPath = "";
      if (body.parentId) {
        const parent = await app.db
          .select()
          .from(folders)
          .where(
            and(
              eq(folders.id, body.parentId),
              eq(folders.companyId, req.companyId!),
              eq(folders.projectId, projectId),
            ),
          )
          .limit(1);
        if (!parent[0]) throw notFound("Parent folder not found");
        parentPath = parent[0].path;
      }
      const dup = await app.db
        .select({ id: folders.id })
        .from(folders)
        .where(
          and(
            eq(folders.projectId, projectId),
            body.parentId ? eq(folders.parentId, body.parentId) : eq(folders.path, `/${body.name}`),
            eq(folders.name, body.name),
          ),
        )
        .limit(1);
      if (dup[0]) throw conflict("A folder with this name already exists here");

      const id = newId("fld");
      const row = {
        id,
        companyId: req.companyId!,
        projectId,
        parentId: body.parentId ?? null,
        name: body.name,
        path: `${parentPath}/${body.name}`,
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
      });
      return reply.status(201).send(row);
    },
  );

  app.patch(
    "/projects/:projectId/folders/:folderId",
    { preHandler: standardGate },
    async (req) => {
      const { folderId } = req.params as { folderId: string };
      const body = folderPatchSchema.parse(req.body);
      const rows = await app.db
        .select()
        .from(folders)
        .where(
          and(
            eq(folders.id, folderId),
            eq(folders.companyId, req.companyId!),
            eq(folders.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const folder = rows[0];
      if (!folder) throw notFound("Folder not found");

      const newName = body.name ?? folder.name;
      let newParentId = folder.parentId;
      let parentPath = folder.path.slice(0, folder.path.length - folder.name.length - 1);

      if (body.parentId !== undefined) {
        newParentId = body.parentId;
        if (body.parentId === null) {
          parentPath = "";
        } else {
          if (body.parentId === folderId) throw badRequest("A folder cannot be its own parent");
          const parent = await app.db
            .select()
            .from(folders)
            .where(
              and(
                eq(folders.id, body.parentId),
                eq(folders.companyId, req.companyId!),
                eq(folders.projectId, req.projectId!),
              ),
            )
            .limit(1);
          if (!parent[0]) throw notFound("Target parent folder not found");
          if (
            parent[0].path === folder.path ||
            parent[0].path.startsWith(`${folder.path}/`)
          ) {
            throw badRequest("Cannot move a folder into its own subtree");
          }
          parentPath = parent[0].path;
        }
      }

      const oldPath = folder.path;
      const newPath = `${parentPath}/${newName}`;

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
          // Recompute every descendant's materialized path.
          const descendants = await tx
            .select({ id: folders.id, path: folders.path })
            .from(folders)
            .where(
              and(
                eq(folders.projectId, req.projectId!),
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
      });
      const updated = await app.db.select().from(folders).where(eq(folders.id, folderId)).limit(1);
      return updated[0];
    },
  );

  app.delete(
    "/projects/:projectId/folders/:folderId",
    { preHandler: standardGate },
    async (req) => {
      const { folderId } = req.params as { folderId: string };
      const rows = await app.db
        .select()
        .from(folders)
        .where(
          and(
            eq(folders.id, folderId),
            eq(folders.companyId, req.companyId!),
            eq(folders.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!rows[0]) throw notFound("Folder not found");
      const [childFolders] = await app.db
        .select({ n: count() })
        .from(folders)
        .where(eq(folders.parentId, folderId));
      const [childFiles] = await app.db
        .select({ n: count() })
        .from(files)
        .where(eq(files.folderId, folderId));
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
        payload: { name: rows[0].name, path: rows[0].path },
      });
      return { ok: true };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Files (spec #292-#299, #301)                                      */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/folders/:folderId/files",
    { preHandler: standardGate },
    async (req, reply) => {
      const { folderId } = req.params as { folderId: string };
      const folder = await app.db
        .select()
        .from(folders)
        .where(
          and(
            eq(folders.id, folderId),
            eq(folders.companyId, req.companyId!),
            eq(folders.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!folder[0]) throw notFound("Folder not found");

      const mp = await req.file();
      if (!mp) throw badRequest("Expected a multipart file upload");
      const buf = await mp.toBuffer();
      const saved = await app.storage.saveBuffer(req.companyId!, buf);

      const fileId = newId("fil");
      const now = new Date().toISOString();
      const fileRow = {
        id: fileId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        folderId,
        name: mp.filename || "untitled",
        contentType: mp.mimetype || "application/octet-stream",
        sizeBytes: saved.sizeBytes,
        sha256: saved.sha256,
        storageKey: saved.storageKey,
        version: 1,
        isPrivate: 0,
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
        payload: { name: fileRow.name, sha256: saved.sha256, sizeBytes: saved.sizeBytes, folderId },
      });
      return reply.status(201).send(fileRow);
    },
  );

  app.post(
    "/files/:fileId/versions",
    { preHandler: companyGate },
    async (req, reply) => {
      const { fileId } = req.params as { fileId: string };
      const f = await loadFile(req, fileId);
      if (f.checkedOutBy && f.checkedOutBy !== req.user!.id) {
        throw conflict("File is checked out by another user");
      }
      const mp = await req.file();
      if (!mp) throw badRequest("Expected a multipart file upload");
      const buf = await mp.toBuffer();
      const saved = await app.storage.saveBuffer(req.companyId!, buf);
      const nextVersion = f.version + 1;
      const now = new Date().toISOString();
      await app.db.insert(fileVersions).values({
        id: newId("fv"),
        fileId,
        version: nextVersion,
        contentType: mp.mimetype || f.contentType,
        sizeBytes: saved.sizeBytes,
        sha256: saved.sha256,
        storageKey: saved.storageKey,
        uploadedBy: req.user!.id,
      });
      await app.db
        .update(files)
        .set({
          version: nextVersion,
          contentType: mp.mimetype || f.contentType,
          sizeBytes: saved.sizeBytes,
          sha256: saved.sha256,
          storageKey: saved.storageKey,
          name: mp.filename || f.name,
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
      });
      const updated = await app.db.select().from(files).where(eq(files.id, fileId)).limit(1);
      return reply.status(201).send(updated[0]);
    },
  );

  app.get(
    "/projects/:projectId/files",
    { preHandler: readGate },
    async (req) => {
      const q = filesQuerySchema.parse(req.query);
      const showPrivate = await canSeePrivate(app.db, req, req.projectId!);

      const conds = [eq(files.companyId, req.companyId!), eq(files.projectId, req.projectId!)];
      if (q.folderId) conds.push(eq(files.folderId, q.folderId));
      if (q.search) conds.push(ilike(files.name, `%${q.search}%`));
      if (!showPrivate) conds.push(eq(files.isPrivate, 0));

      let where = and(...conds);
      if (!showPrivate && !q.folderId) {
        // exclude files living inside private folders
        const privateFolders = await app.db
          .select({ id: folders.id })
          .from(folders)
          .where(
            and(eq(folders.projectId, req.projectId!), eq(folders.isPrivate, 1)),
          );
        const privateIds = privateFolders.map((pf) => pf.id);
        if (privateIds.length > 0) {
          where = and(
            where,
            or(isNull(files.folderId), notInArray(files.folderId, privateIds)),
          );
        }
      } else if (!showPrivate && q.folderId) {
        const folder = await app.db
          .select({ isPrivate: folders.isPrivate })
          .from(folders)
          .where(eq(folders.id, q.folderId))
          .limit(1);
        if (folder[0]?.isPrivate === 1) return paginate([], 0, q);
      }

      const [totalRow] = await app.db.select({ n: count() }).from(files).where(where);
      const items = await app.db
        .select()
        .from(files)
        .where(where)
        .orderBy(desc(files.updatedAt))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(items, Number(totalRow?.n ?? 0), q);
    },
  );

  app.get("/files/:fileId", { preHandler: companyGate }, async (req) => {
    const { fileId } = req.params as { fileId: string };
    const f = await loadFile(req, fileId);
    const versions = await app.db
      .select()
      .from(fileVersions)
      .where(eq(fileVersions.fileId, fileId))
      .orderBy(desc(fileVersions.version));
    const [accessRow] = await app.db
      .select({ n: count() })
      .from(fileAccessLog)
      .where(eq(fileAccessLog.fileId, fileId));
    return { ...f, versions, accessCount: Number(accessRow?.n ?? 0) };
  });

  app.get("/files/:fileId/download", { preHandler: companyGate }, async (req, reply) => {
    const { fileId } = req.params as { fileId: string };
    const q = z.object({ version: z.coerce.number().int().min(1).optional() }).parse(req.query);
    const f = await loadFile(req, fileId);
    let storageKey = f.storageKey;
    let contentType = f.contentType;
    if (q.version && q.version !== f.version) {
      const v = await app.db
        .select()
        .from(fileVersions)
        .where(and(eq(fileVersions.fileId, fileId), eq(fileVersions.version, q.version)))
        .limit(1);
      if (!v[0]) throw notFound("Version not found");
      storageKey = v[0].storageKey;
      contentType = v[0].contentType;
    }
    await app.db.insert(fileAccessLog).values({
      id: newId("fal"),
      fileId,
      userId: req.user!.id,
      action: "download",
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "access",
      objectType: "file",
      objectId: fileId,
      payload: { action: "download", version: q.version ?? f.version },
    });
    return reply
      .header("content-type", contentType)
      .header(
        "content-disposition",
        `attachment; filename="${encodeURIComponent(f.name).replace(/['()]/g, "")}"`,
      )
      .send(app.storage.readStream(storageKey));
  });

  app.post("/files/:fileId/checkout", { preHandler: companyGate }, async (req) => {
    const { fileId } = req.params as { fileId: string };
    const f = await loadFile(req, fileId);
    if (f.checkedOutBy && f.checkedOutBy !== req.user!.id) {
      throw conflict("File is already checked out by another user");
    }
    if (f.checkedOutBy === req.user!.id) throw conflict("File is already checked out by you");
    await app.db
      .update(files)
      .set({ checkedOutBy: req.user!.id, updatedAt: new Date().toISOString() })
      .where(eq(files.id, fileId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "file",
      objectId: fileId,
      payload: { checkedOutBy: req.user!.id },
    });
    return { ok: true, checkedOutBy: req.user!.id };
  });

  app.post("/files/:fileId/checkin", { preHandler: companyGate }, async (req) => {
    const { fileId } = req.params as { fileId: string };
    const f = await loadFile(req, fileId);
    if (!f.checkedOutBy) throw conflict("File is not checked out");
    const isAdmin = req.companyRole === "owner" || req.companyRole === "admin";
    if (f.checkedOutBy !== req.user!.id && !isAdmin) {
      throw forbidden("File is checked out by another user");
    }
    await app.db
      .update(files)
      .set({ checkedOutBy: null, updatedAt: new Date().toISOString() })
      .where(eq(files.id, fileId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "file",
      objectId: fileId,
      payload: { checkedOutBy: null },
    });
    return { ok: true };
  });

  app.patch("/files/:fileId", { preHandler: companyGate }, async (req) => {
    const { fileId } = req.params as { fileId: string };
    const body = filePatchSchema.parse(req.body);
    const f = await loadFile(req, fileId);
    if (f.checkedOutBy && f.checkedOutBy !== req.user!.id) {
      throw conflict("File is checked out by another user");
    }
    if (body.folderId) {
      const folder = await app.db
        .select({ id: folders.id, projectId: folders.projectId })
        .from(folders)
        .where(and(eq(folders.id, body.folderId), eq(folders.companyId, req.companyId!)))
        .limit(1);
      if (!folder[0]) throw notFound("Target folder not found");
      if (f.projectId && folder[0].projectId !== f.projectId) {
        throw badRequest("Target folder belongs to a different project");
      }
    }
    await app.db
      .update(files)
      .set({
        name: body.name ?? f.name,
        folderId: body.folderId === undefined ? f.folderId : body.folderId,
        isPrivate: body.isPrivate === undefined ? f.isPrivate : body.isPrivate ? 1 : 0,
        metadata: body.metadata ?? (f.metadata as Record<string, unknown>),
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
    });
    const updated = await app.db.select().from(files).where(eq(files.id, fileId)).limit(1);
    return updated[0];
  });

  app.delete("/files/:fileId", { preHandler: companyGate }, async (req) => {
    const { fileId } = req.params as { fileId: string };
    const f = await loadFile(req, fileId);
    const isAdmin = req.companyRole === "owner" || req.companyRole === "admin";
    if (!isAdmin && f.uploadedBy !== req.user!.id) {
      throw forbidden("Only the uploader or a company admin can delete a file");
    }
    if (f.checkedOutBy && f.checkedOutBy !== req.user!.id) {
      throw conflict("File is checked out by another user");
    }
    await app.db.delete(fileVersions).where(eq(fileVersions.fileId, fileId));
    await app.db.delete(files).where(eq(files.id, fileId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "file",
      objectId: fileId,
      payload: { name: f.name, sha256: f.sha256 },
    });
    return { ok: true };
  });
};
