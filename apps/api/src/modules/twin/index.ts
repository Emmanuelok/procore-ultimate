import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  assetElementLinks,
  assets,
  bimElements,
  deliveryMilestones,
  events,
  locations,
  notifications,
  sensorReadings,
  sensors,
  users,
  warranties,
} from "@constructos/db";
import {
  ASSET_CRITICALITY,
  CDE_STATES,
  SENSOR_KINDS,
  SUITABILITY_CODES,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";

/* ------------------------------------------------------------------ */
/* Lifecycles                                                          */
/* ------------------------------------------------------------------ */

/** asset lifecycle — forward-only (spec Domain L #627-629) */
const ASSET_STATUSES = [
  "planned",
  "installed",
  "commissioned",
  "operational",
  "decommissioned",
] as const;
type AssetStatus = (typeof ASSET_STATUSES)[number];

/** delivery milestone lifecycle (MIDP acceptance, spec Domain L #632-636) */
const MILESTONE_STATUSES = ["open", "delivered", "accepted", "rejected"] as const;
type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];
const MILESTONE_TRANSITIONS: Record<MilestoneStatus, MilestoneStatus[]> = {
  open: ["delivered"],
  delivered: ["accepted", "rejected"],
  rejected: ["delivered"], // re-delivery after rejection
  accepted: [],
};

const CLASSIFICATION_SYSTEMS = ["uniclass", "omniclass", "sfg20", "masterformat"] as const;

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const isoTimestamp = z
  .string()
  .min(4)
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid timestamp");

const assetCreateSchema = z.object({
  tagCode: z.string().min(1).max(100),
  name: z.string().min(1).max(300),
  category: z.string().max(200).nullable().optional(),
  classificationSystem: z.enum(CLASSIFICATION_SYSTEMS).nullable().optional(),
  classificationCode: z.string().max(100).nullable().optional(),
  parentId: z.string().nullable().optional(),
  locationId: z.string().nullable().optional(),
  manufacturer: z.string().max(200).nullable().optional(),
  modelNumber: z.string().max(200).nullable().optional(),
  serialNumber: z.string().max(200).nullable().optional(),
  installedAt: z.string().max(30).nullable().optional(),
  commissionedAt: z.string().max(30).nullable().optional(),
  warrantyStart: z.string().max(30).nullable().optional(),
  warrantyMonths: z.number().min(0).nullable().optional(),
  expectedLifeYears: z.number().min(0).nullable().optional(),
  criticality: z.enum(ASSET_CRITICALITY).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

const assetPatchSchema = assetCreateSchema.partial().extend({
  tagCode: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(300).optional(),
  status: z.enum(ASSET_STATUSES).optional(),
});

const assetListQuery = pageQuerySchema.extend({
  search: z.string().max(200).optional(),
  category: z.string().max(200).optional(),
  status: z.enum(ASSET_STATUSES).optional(),
});

const fromElementSchema = z.object({
  globalId: z.string().min(1).max(64),
  modelVersionId: z.string().min(1),
  tagCode: z.string().min(1).max(100),
  name: z.string().min(1).max(300).optional(),
});

const elementLinkSchema = z.object({
  globalId: z.string().min(1).max(64),
  modelVersionId: z.string().nullable().optional(),
});

const sensorCreateSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(SENSOR_KINDS),
  unit: z.string().min(1).max(30),
  assetId: z.string().nullable().optional(),
  locationId: z.string().nullable().optional(),
  externalId: z.string().max(200).nullable().optional(),
  minValue: z.number().nullable().optional(),
  maxValue: z.number().nullable().optional(),
});

const sensorPatchSchema = sensorCreateSchema.partial().extend({
  isActive: z.boolean().optional(),
});

const sensorListQuery = pageQuerySchema.extend({
  kind: z.enum(SENSOR_KINDS).optional(),
  assetId: z.string().optional(),
  search: z.string().max(200).optional(),
});

const readingsIngestSchema = z.object({
  readings: z
    .array(z.object({ value: z.number().finite(), at: isoTimestamp }))
    .min(1)
    .max(5000),
});

const readingsQuerySchema = z.object({
  from: isoTimestamp.optional(),
  to: isoTimestamp.optional(),
  bucketMinutes: z.coerce.number().int().min(1).max(10080).optional(),
});

const warrantyCreateSchema = z.object({
  provider: z.string().min(1).max(200),
  description: z.string().max(5000).nullable().optional(),
  startDate: z.string().min(4).max(30),
  endDate: z.string().min(4).max(30),
  documentFileId: z.string().nullable().optional(),
});

const warrantyPatchSchema = warrantyCreateSchema.partial();

const milestoneCreateSchema = z.object({
  name: z.string().min(1).max(300),
  dueDate: z.string().max(30).nullable().optional(),
  requiredState: z.enum(CDE_STATES).optional(),
  requiredSuitability: z.enum(SUITABILITY_CODES).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
});

const milestonePatchSchema = milestoneCreateSchema.partial().extend({
  status: z.enum(MILESTONE_STATUSES).optional(),
});

/** COBie.Component column subset (spec Domain L #630) */
const COBIE_COMPONENT_COLUMNS = [
  "Name",
  "CreatedBy",
  "CreatedOn",
  "TypeName",
  "Space",
  "Description",
  "SerialNumber",
  "InstallationDate",
  "WarrantyStartDate",
  "TagNumber",
  "AssetIdentifier",
] as const;

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

export const twinModule: FastifyPluginAsync = async (app) => {
  const memberGate = [app.authenticate, app.requireCompany];
  const tool = (level: "read" | "standard" | "admin") => [
    app.authenticate,
    app.requireCompany,
    app.requireTool("twin", level),
  ];

  async function getAsset(assetId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Asset not found");
    return rows[0];
  }

  async function getSensor(sensorId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(sensors)
      .where(and(eq(sensors.id, sensorId), eq(sensors.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Sensor not found");
    return rows[0];
  }

  async function assertTagCodeFree(projectId: string, tagCode: string) {
    const dupe = await app.db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.projectId, projectId), eq(assets.tagCode, tagCode)))
      .limit(1);
    if (dupe[0]) throw conflict(`Tag code "${tagCode}" already exists in this project`);
  }

  /* ---------------------------------------------------------------- */
  /* Asset register (spec Domain L #627-629, #658)                     */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/assets", { preHandler: tool("read") }, async (req) => {
    const q = assetListQuery.parse(req.query);
    const conds = [eq(assets.companyId, req.companyId!), eq(assets.projectId, req.projectId!)];
    if (q.category) conds.push(eq(assets.category, q.category));
    if (q.status) conds.push(eq(assets.status, q.status));
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
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(assets).where(where);
    const items = await app.db
      .select()
      .from(assets)
      .where(where)
      .orderBy(asc(assets.tagCode))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/projects/:projectId/assets", { preHandler: tool("standard") }, async (req, reply) => {
    const body = assetCreateSchema.parse(req.body);
    await assertTagCodeFree(req.projectId!, body.tagCode);
    if (body.parentId) {
      const parent = await app.db
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.id, body.parentId), eq(assets.projectId, req.projectId!)))
        .limit(1);
      if (!parent[0]) throw badRequest("Parent asset not found in this project");
    }
    if (body.locationId) {
      const loc = await app.db
        .select({ id: locations.id })
        .from(locations)
        .where(and(eq(locations.id, body.locationId), eq(locations.projectId, req.projectId!)))
        .limit(1);
      if (!loc[0]) throw badRequest("Location not found in this project");
    }
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
        manufacturer: body.manufacturer ?? null,
        modelNumber: body.modelNumber ?? null,
        serialNumber: body.serialNumber ?? null,
        installedAt: body.installedAt ?? null,
        commissionedAt: body.commissionedAt ?? null,
        warrantyStart: body.warrantyStart ?? null,
        warrantyMonths: body.warrantyMonths ?? null,
        expectedLifeYears: body.expectedLifeYears ?? null,
        criticality: body.criticality ?? "medium",
        attributes: body.attributes ?? {},
        createdBy: req.user!.id,
      })
      .returning();
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "asset",
      objectId: id,
      payload: created,
      storePayload: true,
    });
    return reply.status(201).send(created);
  });

  app.get("/assets/:assetId", { preHandler: memberGate }, async (req) => {
    const { assetId } = req.params as { assetId: string };
    const asset = await getAsset(assetId, req.companyId!);
    const [links, warrantyRows, sensorRows] = await Promise.all([
      app.db.select().from(assetElementLinks).where(eq(assetElementLinks.assetId, assetId)),
      app.db
        .select()
        .from(warranties)
        .where(eq(warranties.assetId, assetId))
        .orderBy(asc(warranties.endDate)),
      app.db.select().from(sensors).where(eq(sensors.assetId, assetId)),
    ]);
    return { ...asset, elementLinks: links, warranties: warrantyRows, sensors: sensorRows };
  });

  app.patch("/assets/:assetId", { preHandler: memberGate }, async (req) => {
    const { assetId } = req.params as { assetId: string };
    const body = assetPatchSchema.parse(req.body);
    const existing = await getAsset(assetId, req.companyId!);

    const statusChanged = body.status !== undefined && body.status !== existing.status;
    if (statusChanged) {
      const fromIdx = ASSET_STATUSES.indexOf(existing.status as AssetStatus);
      const toIdx = ASSET_STATUSES.indexOf(body.status!);
      if (toIdx <= fromIdx) {
        throw badRequest(
          `Illegal status transition ${existing.status} → ${body.status}. Lifecycle is forward-only: ${ASSET_STATUSES.join(" → ")}.`,
        );
      }
    }
    if (body.tagCode !== undefined && body.tagCode !== existing.tagCode) {
      await assertTagCodeFree(existing.projectId, body.tagCode);
    }

    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const key of [
      "tagCode",
      "name",
      "category",
      "classificationSystem",
      "classificationCode",
      "parentId",
      "locationId",
      "manufacturer",
      "modelNumber",
      "serialNumber",
      "installedAt",
      "commissionedAt",
      "warrantyStart",
      "warrantyMonths",
      "expectedLifeYears",
      "criticality",
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
    }

    const [updated] = await app.db
      .update(assets)
      .set(patch)
      .where(eq(assets.id, assetId))
      .returning();
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: statusChanged ? "state_change" : "update",
      objectType: "asset",
      objectId: assetId,
      payload: statusChanged ? { from: existing.status, to: body.status, patch } : patch,
      storePayload: statusChanged,
    });
    return updated;
  });

  app.delete("/assets/:assetId", { preHandler: memberGate }, async (req) => {
    const { assetId } = req.params as { assetId: string };
    const asset = await getAsset(assetId, req.companyId!);
    await app.db.transaction(async (tx) => {
      await tx.delete(assetElementLinks).where(eq(assetElementLinks.assetId, assetId));
      await tx.delete(warranties).where(eq(warranties.assetId, assetId));
      await tx.update(sensors).set({ assetId: null }).where(eq(sensors.assetId, assetId));
      await tx.delete(assets).where(eq(assets.id, assetId));
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "asset",
      objectId: assetId,
      payload: { tagCode: asset.tagCode, name: asset.name, projectId: asset.projectId },
      storePayload: true,
    });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* Asset from BIM element (spec Domain L #658; twin geometry link)   */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/assets/from-element",
    { preHandler: tool("standard") },
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
            locationId: element.locationId ?? null,
            attributes: { ifcType: element.ifcType, sourceModelVersionId: body.modelVersionId },
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

      await appendLedger(app.db, {
        companyId: req.companyId!,
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

  app.post("/assets/:assetId/elements", { preHandler: memberGate }, async (req, reply) => {
    const { assetId } = req.params as { assetId: string };
    const body = elementLinkSchema.parse(req.body);
    const asset = await getAsset(assetId, req.companyId!);
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
    await appendLedger(app.db, {
      companyId: req.companyId!,
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
    { preHandler: memberGate },
    async (req) => {
      const { assetId, globalId } = req.params as { assetId: string; globalId: string };
      await getAsset(assetId, req.companyId!);
      const deleted = await app.db
        .delete(assetElementLinks)
        .where(
          and(eq(assetElementLinks.assetId, assetId), eq(assetElementLinks.globalId, globalId)),
        )
        .returning({ id: assetElementLinks.id });
      if (!deleted[0]) throw notFound("Element link not found");
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "asset_element_link",
        objectId: deleted[0].id,
        payload: { assetId, globalId },
      });
      return { ok: true };
    },
  );

  /** GlobalId → asset map for viewer coloring */
  app.get("/projects/:projectId/twin/element-map", { preHandler: tool("read") }, async (req) => {
    const rows = await app.db
      .select({
        globalId: assetElementLinks.globalId,
        assetId: assetElementLinks.assetId,
        tagCode: assets.tagCode,
      })
      .from(assetElementLinks)
      .innerJoin(assets, eq(assets.id, assetElementLinks.assetId))
      .where(
        and(
          eq(assetElementLinks.projectId, req.projectId!),
          eq(assets.companyId, req.companyId!),
        ),
      );
    return { items: rows, total: rows.length };
  });

  /* ---------------------------------------------------------------- */
  /* Sensors & readings (spec Domain L #659-661)                       */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/sensors", { preHandler: tool("read") }, async (req) => {
    const q = sensorListQuery.parse(req.query);
    const conds = [eq(sensors.companyId, req.companyId!), eq(sensors.projectId, req.projectId!)];
    if (q.kind) conds.push(eq(sensors.kind, q.kind));
    if (q.assetId) conds.push(eq(sensors.assetId, q.assetId));
    if (q.search) conds.push(ilike(sensors.name, `%${q.search}%`));
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(sensors).where(where);
    const items = await app.db
      .select()
      .from(sensors)
      .where(where)
      .orderBy(asc(sensors.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post(
    "/projects/:projectId/sensors",
    { preHandler: tool("standard") },
    async (req, reply) => {
      const body = sensorCreateSchema.parse(req.body);
      if (
        body.minValue !== null &&
        body.minValue !== undefined &&
        body.maxValue !== null &&
        body.maxValue !== undefined &&
        body.minValue > body.maxValue
      ) {
        throw badRequest("minValue cannot exceed maxValue");
      }
      if (body.assetId) {
        const asset = await app.db
          .select({ id: assets.id })
          .from(assets)
          .where(and(eq(assets.id, body.assetId), eq(assets.projectId, req.projectId!)))
          .limit(1);
        if (!asset[0]) throw badRequest("Asset not found in this project");
      }
      const id = newId("sns");
      const [created] = await app.db
        .insert(sensors)
        .values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          assetId: body.assetId ?? null,
          locationId: body.locationId ?? null,
          externalId: body.externalId ?? null,
          name: body.name,
          kind: body.kind,
          unit: body.unit,
          minValue: body.minValue ?? null,
          maxValue: body.maxValue ?? null,
        })
        .returning();
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "sensor",
        objectId: id,
        payload: created,
      });
      return reply.status(201).send(created);
    },
  );

  app.get("/sensors/:sensorId", { preHandler: memberGate }, async (req) => {
    const { sensorId } = req.params as { sensorId: string };
    return getSensor(sensorId, req.companyId!);
  });

  app.patch("/sensors/:sensorId", { preHandler: memberGate }, async (req) => {
    const { sensorId } = req.params as { sensorId: string };
    const body = sensorPatchSchema.parse(req.body);
    await getSensor(sensorId, req.companyId!);
    const patch: Record<string, unknown> = {};
    for (const key of [
      "name",
      "kind",
      "unit",
      "assetId",
      "locationId",
      "externalId",
      "minValue",
      "maxValue",
    ] as const) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (body.isActive !== undefined) patch["isActive"] = body.isActive ? "true" : "false";
    if (Object.keys(patch).length === 0) throw badRequest("Nothing to update");
    const [updated] = await app.db
      .update(sensors)
      .set(patch)
      .where(eq(sensors.id, sensorId))
      .returning();
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "sensor",
      objectId: sensorId,
      payload: patch,
    });
    return updated;
  });

  app.delete("/sensors/:sensorId", { preHandler: memberGate }, async (req) => {
    const { sensorId } = req.params as { sensorId: string };
    const sensor = await getSensor(sensorId, req.companyId!);
    await app.db.transaction(async (tx) => {
      await tx.delete(sensorReadings).where(eq(sensorReadings.sensorId, sensorId));
      await tx.delete(sensors).where(eq(sensors.id, sensorId));
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "sensor",
      objectId: sensorId,
      payload: { name: sensor.name, projectId: sensor.projectId },
    });
    return { ok: true };
  });

  app.post("/sensors/:sensorId/readings", { preHandler: memberGate }, async (req, reply) => {
    const { sensorId } = req.params as { sensorId: string };
    const body = readingsIngestSchema.parse(req.body);
    const sensor = await getSensor(sensorId, req.companyId!);

    const rows = body.readings.map((r) => ({
      id: newId("srd"),
      sensorId,
      value: r.value,
      at: new Date(r.at).toISOString(),
    }));
    for (let i = 0; i < rows.length; i += 500) {
      await app.db.insert(sensorReadings).values(rows.slice(i, i + 500));
    }

    // threshold evaluation → assurance events + notification
    const breaches: { value: number; at: string; bound: "min" | "max" }[] = [];
    for (const r of rows) {
      if (sensor.minValue !== null && r.value < sensor.minValue) {
        breaches.push({ value: r.value, at: r.at, bound: "min" });
      } else if (sensor.maxValue !== null && r.value > sensor.maxValue) {
        breaches.push({ value: r.value, at: r.at, bound: "max" });
      }
    }
    if (breaches.length > 0) {
      const eventRows = breaches.map((b) => ({
        id: newId("evt"),
        companyId: req.companyId!,
        projectId: sensor.projectId,
        type: "sensor_threshold_breach",
        occurredAt: b.at,
        detectedOrReported: "detected",
        payload: { sensorId, value: b.value, at: b.at, bound: b.bound },
        createdBy: req.user!.id,
      }));
      for (let i = 0; i < eventRows.length; i += 500) {
        await app.db.insert(events).values(eventRows.slice(i, i + 500));
      }
      if (sensor.assetId) {
        const assetRows = await app.db
          .select({ createdBy: assets.createdBy, name: assets.name })
          .from(assets)
          .where(eq(assets.id, sensor.assetId))
          .limit(1);
        const asset = assetRows[0];
        if (asset) {
          await app.db.insert(notifications).values({
            id: newId("ntf"),
            companyId: req.companyId!,
            userId: asset.createdBy,
            projectId: sensor.projectId,
            kind: "signal",
            title: `Sensor threshold breach: ${sensor.name}`,
            body: `${breaches.length} reading(s) breached configured thresholds on asset ${asset.name}`,
            recordType: "sensor",
            recordId: sensorId,
          });
        }
      }
    }

    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "sensor_reading_batch",
      objectId: sensorId,
      payload: { inserted: rows.length, breaches: breaches.length },
    });
    return reply.status(201).send({ inserted: rows.length, breaches: breaches.length });
  });

  app.get("/sensors/:sensorId/readings", { preHandler: memberGate }, async (req) => {
    const { sensorId } = req.params as { sensorId: string };
    await getSensor(sensorId, req.companyId!);
    const q = readingsQuerySchema.parse(req.query);
    const conds = [eq(sensorReadings.sensorId, sensorId)];
    if (q.from) conds.push(gte(sensorReadings.at, new Date(q.from).toISOString()));
    if (q.to) conds.push(lte(sensorReadings.at, new Date(q.to).toISOString()));
    const where = and(...conds);

    if (q.bucketMinutes) {
      const bucketSeconds = q.bucketMinutes * 60;
      // inline the validated integer so SELECT and GROUP BY expressions match
      const bucket = sql<number>`floor(extract(epoch from ${sensorReadings.at}) / ${sql.raw(
        String(bucketSeconds),
      )})`;
      const rows = await app.db
        .select({
          bucket,
          avg: sql<number>`avg(${sensorReadings.value})`,
          min: sql<number>`min(${sensorReadings.value})`,
          max: sql<number>`max(${sensorReadings.value})`,
          count: count(),
        })
        .from(sensorReadings)
        .where(where)
        .groupBy(bucket)
        .orderBy(bucket);
      const items = rows.map((r) => ({
        bucketStart: new Date(Number(r.bucket) * bucketSeconds * 1000).toISOString(),
        avg: Number(r.avg),
        min: Number(r.min),
        max: Number(r.max),
        count: Number(r.count),
      }));
      return { items, total: items.length, bucketMinutes: q.bucketMinutes };
    }

    const items = await app.db
      .select()
      .from(sensorReadings)
      .where(where)
      .orderBy(desc(sensorReadings.at))
      .limit(2000);
    return { items, total: items.length };
  });

  /* ---------------------------------------------------------------- */
  /* Warranties (spec Domain L #642-644)                               */
  /* ---------------------------------------------------------------- */

  app.get("/assets/:assetId/warranties", { preHandler: memberGate }, async (req) => {
    const { assetId } = req.params as { assetId: string };
    await getAsset(assetId, req.companyId!);
    const items = await app.db
      .select()
      .from(warranties)
      .where(eq(warranties.assetId, assetId))
      .orderBy(asc(warranties.endDate));
    return { items, total: items.length };
  });

  app.post("/assets/:assetId/warranties", { preHandler: memberGate }, async (req, reply) => {
    const { assetId } = req.params as { assetId: string };
    const body = warrantyCreateSchema.parse(req.body);
    if (body.endDate < body.startDate) throw badRequest("endDate must be on or after startDate");
    const asset = await getAsset(assetId, req.companyId!);
    const id = newId("wty");
    const [created] = await app.db
      .insert(warranties)
      .values({
        id,
        companyId: req.companyId!,
        projectId: asset.projectId,
        assetId,
        provider: body.provider,
        description: body.description ?? null,
        startDate: body.startDate,
        endDate: body.endDate,
        documentFileId: body.documentFileId ?? null,
      })
      .returning();
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "warranty",
      objectId: id,
      payload: created,
    });
    return reply.status(201).send(created);
  });

  app.patch("/warranties/:warrantyId", { preHandler: memberGate }, async (req) => {
    const { warrantyId } = req.params as { warrantyId: string };
    const body = warrantyPatchSchema.parse(req.body);
    const patch: Record<string, unknown> = {};
    for (const key of [
      "provider",
      "description",
      "startDate",
      "endDate",
      "documentFileId",
    ] as const) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (Object.keys(patch).length === 0) throw badRequest("Nothing to update");
    const [updated] = await app.db
      .update(warranties)
      .set(patch)
      .where(and(eq(warranties.id, warrantyId), eq(warranties.companyId, req.companyId!)))
      .returning();
    if (!updated) throw notFound("Warranty not found");
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "warranty",
      objectId: warrantyId,
      payload: patch,
    });
    return updated;
  });

  app.delete("/warranties/:warrantyId", { preHandler: memberGate }, async (req) => {
    const { warrantyId } = req.params as { warrantyId: string };
    const deleted = await app.db
      .delete(warranties)
      .where(and(eq(warranties.id, warrantyId), eq(warranties.companyId, req.companyId!)))
      .returning({ id: warranties.id });
    if (!deleted[0]) throw notFound("Warranty not found");
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "warranty",
      objectId: warrantyId,
    });
    return { ok: true };
  });

  /** warranty expiry alerting horizon (spec Domain L #644) */
  app.get(
    "/projects/:projectId/warranties/expiring",
    { preHandler: tool("read") },
    async (req) => {
      const q = z
        .object({ days: z.coerce.number().int().min(1).max(3650).default(90) })
        .parse(req.query);
      const today = new Date().toISOString().slice(0, 10);
      const horizon = new Date(Date.now() + q.days * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);
      const rows = await app.db
        .select({
          warranty: warranties,
          assetName: assets.name,
          tagCode: assets.tagCode,
        })
        .from(warranties)
        .innerJoin(assets, eq(assets.id, warranties.assetId))
        .where(
          and(
            eq(warranties.companyId, req.companyId!),
            eq(warranties.projectId, req.projectId!),
            gte(warranties.endDate, today),
            lte(warranties.endDate, horizon),
          ),
        )
        .orderBy(asc(warranties.endDate));
      const items = rows.map((r) => ({
        ...r.warranty,
        assetName: r.assetName,
        tagCode: r.tagCode,
      }));
      return { items, total: items.length, days: q.days };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Delivery milestones — ISO 19650 MIDP (spec Domain L #632-636)     */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/delivery-milestones",
    { preHandler: tool("read") },
    async (req) => {
      const q = pageQuerySchema.parse(req.query);
      const where = and(
        eq(deliveryMilestones.companyId, req.companyId!),
        eq(deliveryMilestones.projectId, req.projectId!),
      );
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(deliveryMilestones)
        .where(where);
      const items = await app.db
        .select()
        .from(deliveryMilestones)
        .where(where)
        .orderBy(asc(deliveryMilestones.dueDate), asc(deliveryMilestones.name))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(items, Number(totalRow?.n ?? 0), q);
    },
  );

  app.post(
    "/projects/:projectId/delivery-milestones",
    { preHandler: tool("standard") },
    async (req, reply) => {
      const body = milestoneCreateSchema.parse(req.body);
      const id = newId("dms");
      const [created] = await app.db
        .insert(deliveryMilestones)
        .values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          name: body.name,
          dueDate: body.dueDate ?? null,
          requiredState: body.requiredState ?? "published",
          requiredSuitability: body.requiredSuitability ?? null,
          description: body.description ?? null,
        })
        .returning();
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "delivery_milestone",
        objectId: id,
        payload: created,
      });
      return reply.status(201).send(created);
    },
  );

  app.patch(
    "/projects/:projectId/delivery-milestones/:milestoneId",
    { preHandler: tool("standard") },
    async (req) => {
      const { milestoneId } = req.params as { milestoneId: string };
      const body = milestonePatchSchema.parse(req.body);
      const rows = await app.db
        .select()
        .from(deliveryMilestones)
        .where(
          and(
            eq(deliveryMilestones.id, milestoneId),
            eq(deliveryMilestones.companyId, req.companyId!),
            eq(deliveryMilestones.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const existing = rows[0];
      if (!existing) throw notFound("Delivery milestone not found");

      const statusChanged = body.status !== undefined && body.status !== existing.status;
      if (statusChanged) {
        const from = existing.status as MilestoneStatus;
        if (!MILESTONE_TRANSITIONS[from].includes(body.status!)) {
          throw badRequest(
            `Illegal status transition ${from} → ${body.status}. Flow: open → delivered → accepted/rejected (rejected → delivered on re-delivery).`,
          );
        }
      }

      const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const key of [
        "name",
        "dueDate",
        "requiredState",
        "requiredSuitability",
        "description",
      ] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (statusChanged) patch["status"] = body.status;

      const [updated] = await app.db
        .update(deliveryMilestones)
        .set(patch)
        .where(eq(deliveryMilestones.id, milestoneId))
        .returning();
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: statusChanged ? "state_change" : "update",
        objectType: "delivery_milestone",
        objectId: milestoneId,
        payload: statusChanged ? { from: existing.status, to: body.status, patch } : patch,
      });
      return updated;
    },
  );

  app.delete(
    "/projects/:projectId/delivery-milestones/:milestoneId",
    { preHandler: tool("standard") },
    async (req) => {
      const { milestoneId } = req.params as { milestoneId: string };
      const deleted = await app.db
        .delete(deliveryMilestones)
        .where(
          and(
            eq(deliveryMilestones.id, milestoneId),
            eq(deliveryMilestones.companyId, req.companyId!),
            eq(deliveryMilestones.projectId, req.projectId!),
          ),
        )
        .returning({ id: deliveryMilestones.id });
      if (!deleted[0]) throw notFound("Delivery milestone not found");
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "delivery_milestone",
        objectId: milestoneId,
      });
      return { ok: true };
    },
  );

  /* ---------------------------------------------------------------- */
  /* COBie export (spec Domain L #630)                                 */
  /* ---------------------------------------------------------------- */

  async function loadCobieRows(companyId: string, projectId: string) {
    return app.db
      .select({
        asset: assets,
        creatorEmail: users.email,
        spaceName: locations.name,
      })
      .from(assets)
      .leftJoin(users, eq(users.id, assets.createdBy))
      .leftJoin(locations, eq(locations.id, assets.locationId))
      .where(and(eq(assets.companyId, companyId), eq(assets.projectId, projectId)))
      .orderBy(asc(assets.tagCode));
  }

  function cobieComponent(row: {
    asset: typeof assets.$inferSelect;
    creatorEmail: string | null;
    spaceName: string | null;
  }) {
    const a = row.asset;
    const attrs = a.attributes as Record<string, unknown>;
    const description =
      typeof attrs["description"] === "string" && attrs["description"]
        ? (attrs["description"] as string)
        : [a.manufacturer, a.modelNumber].filter(Boolean).join(" ") || null;
    return {
      Name: a.name,
      CreatedBy: row.creatorEmail ?? "",
      CreatedOn: a.createdAt,
      TypeName: a.category ?? a.classificationCode ?? "",
      Space: row.spaceName ?? "",
      Description: description ?? "",
      SerialNumber: a.serialNumber ?? "",
      InstallationDate: a.installedAt ?? "",
      WarrantyStartDate: a.warrantyStart ?? "",
      TagNumber: a.tagCode,
      AssetIdentifier: a.id,
    };
  }

  app.get("/projects/:projectId/cobie.csv", { preHandler: tool("read") }, async (req, reply) => {
    const rows = await loadCobieRows(req.companyId!, req.projectId!);
    const lines = [COBIE_COMPONENT_COLUMNS.join(",")];
    for (const row of rows) {
      const c = cobieComponent(row);
      lines.push(COBIE_COMPONENT_COLUMNS.map((col) => csvCell(c[col])).join(","));
    }
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="cobie-components.csv"');
    return reply.send(lines.join("\r\n") + "\r\n");
  });

  app.get("/projects/:projectId/cobie.json", { preHandler: tool("read") }, async (req) => {
    const [rows, spaceRows] = await Promise.all([
      loadCobieRows(req.companyId!, req.projectId!),
      app.db
        .select({
          id: locations.id,
          name: locations.name,
          parentId: locations.parentId,
          path: locations.path,
        })
        .from(locations)
        .where(
          and(eq(locations.companyId, req.companyId!), eq(locations.projectId, req.projectId!)),
        )
        .orderBy(asc(locations.path)),
    ]);
    const components = rows.map(cobieComponent);
    const typeMap = new Map<string, { name: string; count: number; components: string[] }>();
    for (const c of components) {
      const key = c.TypeName || "(uncategorized)";
      const entry = typeMap.get(key) ?? { name: key, count: 0, components: [] };
      entry.count += 1;
      entry.components.push(c.TagNumber);
      typeMap.set(key, entry);
    }
    return {
      components,
      types: [...typeMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
      spaces: spaceRows,
    };
  });
};
