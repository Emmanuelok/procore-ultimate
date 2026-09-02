/**
 * Asset register and its binding to model geometry (spec Domain L #627-629,
 * #658).
 *
 * What changed from the first implementation, and why:
 *  - every id-scoped route now resolves the asset's project and enforces the
 *    twin tool level (delete needs admin). A `twin: read` user could
 *    previously destroy an asset, its warranties and its geometry links.
 *  - PATCH validates parentId and locationId exactly as POST does, refuses a
 *    self-parent and refuses a cycle. Cross-project parents used to be stored
 *    verbatim and then leaked through the COBie space join.
 *  - deleting an asset re-parents its children instead of leaving them
 *    pointing at a row that no longer exists.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  assetElementLinks,
  assets,
  bimElements,
  companyMemberships,
  locations,
  sensorAlerts,
  sensors,
  warranties,
  warrantyClaims,
} from "@constructos/db";
import { ASSET_CRITICALITY } from "@constructos/shared";
import { newId } from "../../../lib/ids.js";
import { badRequest, conflict, notFound } from "../../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import {
  buildTwinGates,
  buildTwinLoaders,
  isoDateSchema,
  ledger,
  nowISO,
} from "../shared.js";

/** forward-only asset lifecycle (spec Domain L #627-629) */
const ASSET_STATUSES = [
  "planned",
  "installed",
  "commissioned",
  "operational",
  "decommissioned",
] as const;
type AssetStatus = (typeof ASSET_STATUSES)[number];

const CLASSIFICATION_SYSTEMS = ["uniclass", "omniclass", "sfg20", "masterformat"] as const;

const assetCreateSchema = z.object({
  tagCode: z.string().min(1).max(100),
  name: z.string().min(1).max(300),
  category: z.string().max(200).nullable().optional(),
  classificationSystem: z.enum(CLASSIFICATION_SYSTEMS).nullable().optional(),
  classificationCode: z.string().max(100).nullable().optional(),
  parentId: z.string().max(64).nullable().optional(),
  locationId: z.string().max(64).nullable().optional(),
  ownerId: z.string().max(64).nullable().optional(),
  manufacturer: z.string().max(200).nullable().optional(),
  modelNumber: z.string().max(200).nullable().optional(),
  serialNumber: z.string().max(200).nullable().optional(),
  installedAt: isoDateSchema.nullable().optional(),
  commissionedAt: isoDateSchema.nullable().optional(),
  warrantyStart: isoDateSchema.nullable().optional(),
  warrantyMonths: z.number().min(0).max(1200).nullable().optional(),
  expectedLifeYears: z.number().min(0).max(200).nullable().optional(),
  criticality: z.enum(ASSET_CRITICALITY).optional(),
  designBaseline: z.record(z.string(), z.number()).nullable().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

const assetPatchSchema = assetCreateSchema.partial().extend({
  status: z.enum(ASSET_STATUSES).optional(),
});

const assetListQuery = pageQuerySchema.extend({
  search: z.string().max(200).optional(),
  category: z.string().max(200).optional(),
  status: z.enum(ASSET_STATUSES).optional(),
  criticality: z.enum(ASSET_CRITICALITY).optional(),
  locationId: z.string().max(64).optional(),
  parentId: z.string().max(64).optional(),
  unlinked: z.enum(["0", "1"]).optional(),
});

const fromElementSchema = z.object({
  globalId: z.string().min(1).max(64),
  modelVersionId: z.string().min(1).max(64),
  tagCode: z.string().min(1).max(100),
  name: z.string().min(1).max(300).optional(),
  ownerId: z.string().max(64).nullable().optional(),
  criticality: z.enum(ASSET_CRITICALITY).optional(),
});

const bulkFromElementsSchema = z.object({
  modelVersionId: z.string().min(1).max(64),
  ifcType: z.string().min(1).max(60),
  /** e.g. "AHU-{storey}-{seq}" */
  tagPattern: z.string().min(1).max(100),
  limit: z.number().int().min(1).max(500).optional(),
  criticality: z.enum(ASSET_CRITICALITY).optional(),
});

const elementLinkSchema = z.object({
  globalId: z.string().min(1).max(64),
  modelVersionId: z.string().max(64).nullable().optional(),
});

export const assetRoutes: FastifyPluginAsync = async (app) => {
  const gates = buildTwinGates(app);
  const { getAsset } = buildTwinLoaders(app);

  async function assertTagCodeFree(projectId: string, tagCode: string) {
    const dupe = await app.db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.projectId, projectId), eq(assets.tagCode, tagCode)))
      .limit(1);
    if (dupe[0]) throw conflict(`Tag code "${tagCode}" already exists in this project`);
  }

  async function assertCompanyMember(companyId: string, userId: string | null | undefined) {
    if (!userId) return;
    const rows = await app.db
      .select({ userId: companyMemberships.userId })
      .from(companyMemberships)
      .where(
        and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.userId, userId)),
      )
      .limit(1);
    if (!rows[0]) throw badRequest("Owner must be a member of this company");
  }

  async function assertLocation(projectId: string, locationId: string | null | undefined) {
    if (!locationId) return;
    const rows = await app.db
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.id, locationId), eq(locations.projectId, projectId)))
      .limit(1);
    if (!rows[0]) throw badRequest("Location not found in this project");
  }

  /**
   * A parent must exist in the same project, must not be the asset itself and
   * must not already be a descendant of it (which would create a cycle the
   * hierarchy walk and the COBie assembly export would spin on).
   */
  async function assertParent(
    projectId: string,
    parentId: string | null | undefined,
    selfId?: string,
  ) {
    if (!parentId) return;
    if (selfId && parentId === selfId) throw badRequest("An asset cannot be its own parent");
    const rows = await app.db
      .select({ id: assets.id, parentId: assets.parentId })
      .from(assets)
      .where(and(eq(assets.id, parentId), eq(assets.projectId, projectId)))
      .limit(1);
    if (!rows[0]) throw badRequest("Parent asset not found in this project");
    if (!selfId) return;
    // walk up from the proposed parent: meeting ourselves means a cycle
    let cursor: string | null = rows[0].parentId;
    let hops = 0;
    while (cursor && hops < 64) {
      if (cursor === selfId) {
        throw badRequest("That parent is a descendant of this asset — the hierarchy would loop");
      }
      const next: Array<{ parentId: string | null }> = await app.db
        .select({ parentId: assets.parentId })
        .from(assets)
        .where(eq(assets.id, cursor))
        .limit(1);
      cursor = next[0]?.parentId ?? null;
      hops += 1;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Register                                                          */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/assets", { preHandler: gates.readGate }, async (req) => {
    const q = assetListQuery.parse(req.query);
    const conds = [eq(assets.companyId, req.companyId!), eq(assets.projectId, req.projectId!)];
    if (q.category) conds.push(eq(assets.category, q.category));
    if (q.status) conds.push(eq(assets.status, q.status));
    if (q.criticality) conds.push(eq(assets.criticality, q.criticality));
    if (q.locationId) conds.push(eq(assets.locationId, q.locationId));
    if (q.parentId) conds.push(eq(assets.parentId, q.parentId));
    if (q.search) {
      const term = `%${q.search}%`;
      conds.push(
        or(
          ilike(assets.name, term),
          ilike(assets.tagCode, term),
          ilike(assets.serialNumber, term),
        )!,
      );
    }
    if (q.unlinked === "1") {
      conds.push(
        sql`not exists (select 1 from ${assetElementLinks} where ${assetElementLinks.assetId} = ${assets.id})`,
      );
    }
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(assets).where(where);
    const items = await app.db
      .select()
      .from(assets)
      .where(where)
      .orderBy(asc(assets.tagCode))
      .limit(q.pageSize)
      .offset(pageOffset(q));

    const ids = items.map((a) => a.id);
    const [linkCounts, warrantyRows, sensorRows] = ids.length
      ? await Promise.all([
          app.db
            .select({ assetId: assetElementLinks.assetId, n: count() })
            .from(assetElementLinks)
            .where(inArray(assetElementLinks.assetId, ids))
            .groupBy(assetElementLinks.assetId),
          app.db
            .select({ assetId: warranties.assetId, endDate: warranties.endDate, status: warranties.status })
            .from(warranties)
            .where(inArray(warranties.assetId, ids)),
          app.db
            .select({ assetId: sensors.assetId, n: count() })
            .from(sensors)
            .where(inArray(sensors.assetId, ids))
            .groupBy(sensors.assetId),
        ])
      : [[], [], []];

    return paginate(
      items.map((a) => ({
        ...a,
        elementLinkCount: Number(linkCounts.find((l) => l.assetId === a.id)?.n ?? 0),
        sensorCount: Number(sensorRows.find((s) => s.assetId === a.id)?.n ?? 0),
        warranties: warrantyRows
          .filter((w) => w.assetId === a.id)
          .map((w) => ({ endDate: w.endDate, status: w.status })),
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  /** Asset hierarchy for the tree view (#628). */
  app.get("/projects/:projectId/assets/tree", { preHandler: gates.readGate }, async (req) => {
    const rows = await app.db
      .select({
        id: assets.id,
        parentId: assets.parentId,
        tagCode: assets.tagCode,
        name: assets.name,
        status: assets.status,
        criticality: assets.criticality,
        category: assets.category,
        locationId: assets.locationId,
      })
      .from(assets)
      .where(and(eq(assets.companyId, req.companyId!), eq(assets.projectId, req.projectId!)))
      .orderBy(asc(assets.tagCode))
      .limit(5000);
    const byParent = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = row.parentId ?? "";
      const list = byParent.get(key);
      if (list) list.push(row);
      else byParent.set(key, [row]);
    }
    interface TreeNode {
      id: string;
      tagCode: string;
      name: string;
      status: string;
      criticality: string;
      children: TreeNode[];
    }
    const build = (parentId: string, depth: number): TreeNode[] => {
      if (depth > 16) return [];
      return (byParent.get(parentId) ?? []).map((row) => ({
        id: row.id,
        tagCode: row.tagCode,
        name: row.name,
        status: row.status,
        criticality: row.criticality,
        children: build(row.id, depth + 1),
      }));
    };
    return { items: build("", 0), total: rows.length };
  });

  app.post("/projects/:projectId/assets", { preHandler: gates.standardGate }, async (req, reply) => {
    const body = assetCreateSchema.parse(req.body);
    await assertTagCodeFree(req.projectId!, body.tagCode);
    await assertParent(req.projectId!, body.parentId);
    await assertLocation(req.projectId!, body.locationId);
    await assertCompanyMember(req.companyId!, body.ownerId);
    const id = newId("ast");
    const [created] = await app.db
      .insert(assets)
      .values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        tagCode: body.tagCode,
        name: body.name,
        category: body.category ?? null,
        classificationSystem: body.classificationSystem ?? null,
        classificationCode: body.classificationCode ?? null,
        parentId: body.parentId ?? null,
        locationId: body.locationId ?? null,
        ownerId: body.ownerId ?? null,
        manufacturer: body.manufacturer ?? null,
        modelNumber: body.modelNumber ?? null,
        serialNumber: body.serialNumber ?? null,
        installedAt: body.installedAt ?? null,
        commissionedAt: body.commissionedAt ?? null,
        warrantyStart: body.warrantyStart ?? null,
        warrantyMonths: body.warrantyMonths ?? null,
        expectedLifeYears: body.expectedLifeYears ?? null,
        criticality: body.criticality ?? "medium",
        designBaseline: body.designBaseline ?? null,
        attributes: body.attributes ?? {},
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "asset",
      objectId: id,
      payload: created,
      storePayload: true,
    });
    return reply.status(201).send(created);
  });

  app.get("/assets/:assetId", { preHandler: gates.companyGate }, async (req, reply) => {
    const { assetId } = req.params as { assetId: string };
    const asset = await getAsset(assetId, req.companyId!);
    await gates.requireToolFor(req, reply, asset.projectId, "read");
    const [links, warrantyRows, sensorRows, claims, children, alerts] = await Promise.all([
      app.db.select().from(assetElementLinks).where(eq(assetElementLinks.assetId, assetId)),
      app.db
        .select()
        .from(warranties)
        .where(eq(warranties.assetId, assetId))
        .orderBy(asc(warranties.endDate)),
      app.db.select().from(sensors).where(eq(sensors.assetId, assetId)),
      app.db
        .select()
        .from(warrantyClaims)
        .where(eq(warrantyClaims.assetId, assetId))
        .orderBy(desc(warrantyClaims.number)),
      app.db
        .select({ id: assets.id, tagCode: assets.tagCode, name: assets.name, status: assets.status })
        .from(assets)
        .where(eq(assets.parentId, assetId)),
      app.db
        .select()
        .from(sensorAlerts)
        .where(and(eq(sensorAlerts.assetId, assetId), inArray(sensorAlerts.status, ["open", "acknowledged"])))
        .limit(50),
    ]);
    const location = asset.locationId
      ? (
          await app.db
            .select({ id: locations.id, name: locations.name, path: locations.path })
            .from(locations)
            .where(eq(locations.id, asset.locationId))
            .limit(1)
        )[0]
      : null;
    return {
      ...asset,
      location: location ?? null,
      elementLinks: links,
      warranties: warrantyRows,
      warrantyClaims: claims,
      sensors: sensorRows,
      children,
      openAlerts: alerts,
    };
  });

  app.patch("/assets/:assetId", { preHandler: gates.companyGate }, async (req, reply) => {
    const { assetId } = req.params as { assetId: string };
    const body = assetPatchSchema.parse(req.body);
    const existing = await getAsset(assetId, req.companyId!);
    await gates.requireToolFor(req, reply, existing.projectId, "standard");

    const statusChanged = body.status !== undefined && body.status !== existing.status;
    if (statusChanged) {
      const fromIdx = ASSET_STATUSES.indexOf(existing.status as AssetStatus);
      const toIdx = ASSET_STATUSES.indexOf(body.status!);
      if (toIdx <= fromIdx) {
        throw badRequest(
          `Illegal status transition ${existing.status} -> ${body.status}. Lifecycle is forward-only: ${ASSET_STATUSES.join(" -> ")}.`,
        );
      }
    }
    if (body.tagCode !== undefined && body.tagCode !== existing.tagCode) {
      await assertTagCodeFree(existing.projectId, body.tagCode);
    }
    if (body.parentId !== undefined) await assertParent(existing.projectId, body.parentId, assetId);
    if (body.locationId !== undefined) await assertLocation(existing.projectId, body.locationId);
    if (body.ownerId !== undefined) await assertCompanyMember(req.companyId!, body.ownerId);

    const patch: Record<string, unknown> = { updatedAt: nowISO() };
    for (const key of [
      "tagCode",
      "name",
      "category",
      "classificationSystem",
      "classificationCode",
      "parentId",
      "locationId",
      "ownerId",
      "manufacturer",
      "modelNumber",
      "serialNumber",
      "installedAt",
      "commissionedAt",
      "warrantyStart",
      "warrantyMonths",
      "expectedLifeYears",
      "criticality",
      "designBaseline",
      "attributes",
    ] as const) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (statusChanged) {
      patch["status"] = body.status;
      const today = new Date().toISOString().slice(0, 10);
      if (body.status === "installed" && !existing.installedAt && body.installedAt === undefined) {
        patch["installedAt"] = today;
      }
      if (
        body.status === "commissioned" &&
        !existing.commissionedAt &&
        body.commissionedAt === undefined
      ) {
        patch["commissionedAt"] = today;
      }
      if (body.status === "decommissioned" && !existing.decommissionedAt) {
        patch["decommissionedAt"] = today;
      }
    }

    const [updated] = await app.db
      .update(assets)
      .set(patch)
      .where(eq(assets.id, assetId))
      .returning();
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: existing.projectId,
      actorId: req.user!.id,
      action: statusChanged ? "state_change" : "update",
      objectType: "asset",
      objectId: assetId,
      payload: statusChanged ? { from: existing.status, to: body.status, patch } : patch,
      storePayload: statusChanged,
    });
    return updated;
  });

  app.delete("/assets/:assetId", { preHandler: gates.companyGate }, async (req, reply) => {
    const { assetId } = req.params as { assetId: string };
    const asset = await getAsset(assetId, req.companyId!);
    await gates.requireToolFor(req, reply, asset.projectId, "admin");
    const children = await app.db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.parentId, assetId));
    await app.db.transaction(async (tx) => {
      // children are re-parented to the deleted asset's own parent, so the
      // hierarchy stays connected instead of pointing at a missing row
      if (children.length > 0) {
        await tx
          .update(assets)
          .set({ parentId: asset.parentId, updatedAt: nowISO() })
          .where(eq(assets.parentId, assetId));
      }
      await tx.delete(assetElementLinks).where(eq(assetElementLinks.assetId, assetId));
      await tx.delete(warrantyClaims).where(eq(warrantyClaims.assetId, assetId));
      await tx.delete(warranties).where(eq(warranties.assetId, assetId));
      await tx.update(sensors).set({ assetId: null }).where(eq(sensors.assetId, assetId));
      await tx.update(sensorAlerts).set({ assetId: null }).where(eq(sensorAlerts.assetId, assetId));
      await tx.delete(assets).where(eq(assets.id, assetId));
    });
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: asset.projectId,
      actorId: req.user!.id,
      action: "delete",
      objectType: "asset",
      objectId: assetId,
      payload: {
        tagCode: asset.tagCode,
        name: asset.name,
        projectId: asset.projectId,
        childrenReparented: children.length,
      },
      storePayload: true,
    });
    return { ok: true, childrenReparented: children.length };
  });

  /* ---------------------------------------------------------------- */
  /* Geometry binding (#658)                                           */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/assets/from-element",
    { preHandler: gates.standardGate },
    async (req, reply) => {
      const body = fromElementSchema.parse(req.body);
      const elementRows = await app.db
        .select()
        .from(bimElements)
        .where(
          and(
            eq(bimElements.modelVersionId, body.modelVersionId),
            eq(bimElements.globalId, body.globalId),
            eq(bimElements.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const element = elementRows[0];
      if (!element) throw notFound("BIM element not found in this project");
      await assertTagCodeFree(req.projectId!, body.tagCode);
      await assertCompanyMember(req.companyId!, body.ownerId);

      const assetId = newId("ast");
      const linkId = newId("ael");
      const created = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(assets)
          .values({
            id: assetId,
            companyId: req.companyId!,
            projectId: req.projectId!,
            tagCode: body.tagCode,
            name: body.name ?? element.name ?? body.globalId,
            category: element.ifcType,
            classificationCode: element.classification,
            locationId: element.locationId ?? null,
            ownerId: body.ownerId ?? null,
            criticality: body.criticality ?? "medium",
            attributes: {
              ifcType: element.ifcType,
              sourceModelVersionId: body.modelVersionId,
              typeName: element.typeName,
              storey: element.storey,
              ...element.properties,
            },
            createdBy: req.user!.id,
          })
          .returning();
        await tx.insert(assetElementLinks).values({
          id: linkId,
          assetId,
          projectId: req.projectId!,
          globalId: body.globalId,
          modelVersionId: body.modelVersionId,
        });
        return row;
      });

      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "asset",
        objectId: assetId,
        payload: { ...created, elementGlobalId: body.globalId },
        storePayload: true,
      });
      return reply.status(201).send({
        ...created,
        elementLinks: [
          {
            id: linkId,
            assetId,
            projectId: req.projectId!,
            globalId: body.globalId,
            modelVersionId: body.modelVersionId,
          },
        ],
      });
    },
  );

  /**
   * Instantiate every element of one IfcType as an asset (#658). Tag codes
   * come from a pattern: {storey}, {type}, {seq} and {name} are substituted.
   * Elements already bound to an asset are skipped, so re-running is safe.
   */
  app.post(
    "/projects/:projectId/assets/from-elements",
    { preHandler: gates.standardGate },
    async (req, reply) => {
      const body = bulkFromElementsSchema.parse(req.body);
      const elements = await app.db
        .select()
        .from(bimElements)
        .where(
          and(
            eq(bimElements.projectId, req.projectId!),
            eq(bimElements.modelVersionId, body.modelVersionId),
            eq(bimElements.ifcType, body.ifcType.toUpperCase()),
          ),
        )
        .orderBy(asc(bimElements.name))
        .limit(body.limit ?? 200);
      if (elements.length === 0) {
        throw badRequest(`No ${body.ifcType} elements in that model version`);
      }
      const linked = await app.db
        .select({ globalId: assetElementLinks.globalId })
        .from(assetElementLinks)
        .where(eq(assetElementLinks.projectId, req.projectId!));
      const linkedSet = new Set(linked.map((l) => l.globalId));
      const existingTags = new Set(
        (
          await app.db
            .select({ tagCode: assets.tagCode })
            .from(assets)
            .where(eq(assets.projectId, req.projectId!))
        ).map((a) => a.tagCode),
      );

      const created: Array<{ id: string; tagCode: string; globalId: string }> = [];
      const skipped: string[] = [];
      let seq = 1;
      for (const element of elements) {
        if (linkedSet.has(element.globalId)) {
          skipped.push(element.globalId);
          continue;
        }
        let tagCode = body.tagPattern
          .replace(/\{storey\}/g, (element.storey ?? "NA").replace(/\s+/g, ""))
          .replace(/\{type\}/g, element.ifcType.replace(/^IFC/, ""))
          .replace(/\{name\}/g, (element.name ?? "").replace(/\s+/g, ""))
          .replace(/\{seq\}/g, String(seq).padStart(3, "0"));
        while (existingTags.has(tagCode)) {
          seq += 1;
          tagCode = body.tagPattern
            .replace(/\{storey\}/g, (element.storey ?? "NA").replace(/\s+/g, ""))
            .replace(/\{type\}/g, element.ifcType.replace(/^IFC/, ""))
            .replace(/\{name\}/g, (element.name ?? "").replace(/\s+/g, ""))
            .replace(/\{seq\}/g, String(seq).padStart(3, "0"));
        }
        existingTags.add(tagCode);
        seq += 1;

        const assetId = newId("ast");
        await app.db.transaction(async (tx) => {
          await tx.insert(assets).values({
            id: assetId,
            companyId: req.companyId!,
            projectId: req.projectId!,
            tagCode,
            name: element.name ?? tagCode,
            category: element.ifcType,
            classificationCode: element.classification,
            locationId: element.locationId ?? null,
            criticality: body.criticality ?? "medium",
            attributes: {
              ifcType: element.ifcType,
              sourceModelVersionId: body.modelVersionId,
              storey: element.storey,
              ...element.properties,
            },
            createdBy: req.user!.id,
          });
          await tx.insert(assetElementLinks).values({
            id: newId("ael"),
            assetId,
            projectId: req.projectId!,
            globalId: element.globalId,
            modelVersionId: body.modelVersionId,
          });
        });
        created.push({ id: assetId, tagCode, globalId: element.globalId });
      }

      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "asset",
        objectId: body.modelVersionId,
        payload: {
          bulk: true,
          ifcType: body.ifcType,
          created: created.length,
          skippedAlreadyLinked: skipped.length,
        },
        storePayload: true,
      });
      return reply.status(201).send({
        created,
        createdCount: created.length,
        skippedAlreadyLinked: skipped.length,
        candidates: elements.length,
      });
    },
  );

  app.post("/assets/:assetId/elements", { preHandler: gates.companyGate }, async (req, reply) => {
    const { assetId } = req.params as { assetId: string };
    const body = elementLinkSchema.parse(req.body);
    const asset = await getAsset(assetId, req.companyId!);
    await gates.requireToolFor(req, reply, asset.projectId, "standard");
    const element = await app.db
      .select({ id: bimElements.id })
      .from(bimElements)
      .where(
        and(
          eq(bimElements.projectId, asset.projectId),
          eq(bimElements.globalId, body.globalId),
        ),
      )
      .limit(1);
    if (!element[0]) throw badRequest("No element with that GlobalId exists in this project");
    const existing = await app.db
      .select({ id: assetElementLinks.id })
      .from(assetElementLinks)
      .where(
        and(eq(assetElementLinks.assetId, assetId), eq(assetElementLinks.globalId, body.globalId)),
      )
      .limit(1);
    if (existing[0]) throw conflict("This element is already linked to the asset");
    const id = newId("ael");
    const [created] = await app.db
      .insert(assetElementLinks)
      .values({
        id,
        assetId,
        projectId: asset.projectId,
        globalId: body.globalId,
        modelVersionId: body.modelVersionId ?? null,
      })
      .returning();
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: asset.projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "asset_element_link",
      objectId: id,
      payload: created,
    });
    return reply.status(201).send(created);
  });

  app.delete(
    "/assets/:assetId/elements/:globalId",
    { preHandler: gates.companyGate },
    async (req, reply) => {
      const { assetId, globalId } = req.params as { assetId: string; globalId: string };
      const asset = await getAsset(assetId, req.companyId!);
      await gates.requireToolFor(req, reply, asset.projectId, "standard");
      const deleted = await app.db
        .delete(assetElementLinks)
        .where(
          and(eq(assetElementLinks.assetId, assetId), eq(assetElementLinks.globalId, globalId)),
        )
        .returning({ id: assetElementLinks.id });
      if (!deleted[0]) throw notFound("Element link not found");
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: asset.projectId,
        actorId: req.user!.id,
        action: "delete",
        objectType: "asset_element_link",
        objectId: deleted[0].id,
        payload: { assetId, globalId },
      });
      return { ok: true };
    },
  );

  /** GlobalId -> asset map for viewer colouring. */
  app.get("/projects/:projectId/twin/element-map", { preHandler: gates.readGate }, async (req) => {
    const rows = await app.db
      .select({
        globalId: assetElementLinks.globalId,
        assetId: assetElementLinks.assetId,
        tagCode: assets.tagCode,
        name: assets.name,
        status: assets.status,
        criticality: assets.criticality,
      })
      .from(assetElementLinks)
      .innerJoin(assets, eq(assets.id, assetElementLinks.assetId))
      .where(
        and(
          eq(assetElementLinks.projectId, req.projectId!),
          eq(assets.companyId, req.companyId!),
        ),
      )
      .limit(20_000);
    return { items: rows, total: rows.length };
  });

  /** Assets not yet bound to geometry — the handover gap list. */
  app.get(
    "/projects/:projectId/twin/unlinked-assets",
    { preHandler: gates.readGate },
    async (req) => {
      const rows = await app.db
        .select({ id: assets.id, tagCode: assets.tagCode, name: assets.name })
        .from(assets)
        .leftJoin(assetElementLinks, eq(assetElementLinks.assetId, assets.id))
        .where(
          and(
            eq(assets.companyId, req.companyId!),
            eq(assets.projectId, req.projectId!),
            isNull(assetElementLinks.id),
          ),
        )
        .limit(500);
      return { items: rows, total: rows.length };
    },
  );
};
