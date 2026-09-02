/**
 * Handover surface: COBie workbook + validator, O&M readiness score, asset
 * performance against design intent, and the twin health inputs
 * (spec Domain L #630-631, #645-649, #660-661; contract 3.5).
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  assetElementLinks,
  assets,
  companyMemberships,
  deliveryMilestones,
  locations,
  projects,
  sensorAlerts,
  sensorReadings,
  sensors,
  users,
  warranties,
  warrantyClaims,
} from "@constructos/db";
import { notFound } from "../../../lib/errors.js";
import {
  buildCobieWorkbook,
  sheetToCsv,
  type CobieAsset,
} from "../cobie.js";
import { assessHandover, performanceGap, type HandoverAsset } from "../handover.js";
import { buildTwinGates, csvCell, todayISO } from "../shared.js";

export const handoverRoutes: FastifyPluginAsync = async (app) => {
  const gates = buildTwinGates(app);

  async function loadWorkbookInput(companyId: string, projectId: string) {
    const [projectRow] = await app.db
      .select({
        id: projects.id,
        name: projects.name,
        address: projects.address,
        city: projects.city,
        country: projects.country,
      })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    if (!projectRow) throw notFound("Project not found");

    const [assetRows, locationRows, contactRows, warrantyRows] = await Promise.all([
      app.db
        .select({ asset: assets, creatorEmail: users.email, spaceName: locations.name })
        .from(assets)
        .leftJoin(users, eq(users.id, assets.createdBy))
        .leftJoin(locations, eq(locations.id, assets.locationId))
        .where(and(eq(assets.companyId, companyId), eq(assets.projectId, projectId)))
        .orderBy(asc(assets.tagCode))
        .limit(10_000),
      app.db
        .select({
          id: locations.id,
          name: locations.name,
          parentId: locations.parentId,
          path: locations.path,
        })
        .from(locations)
        .where(and(eq(locations.companyId, companyId), eq(locations.projectId, projectId)))
        .orderBy(asc(locations.path))
        .limit(5000),
      app.db
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .innerJoin(companyMemberships, eq(companyMemberships.userId, users.id))
        .where(eq(companyMemberships.companyId, companyId))
        .limit(500),
      app.db
        .select()
        .from(warranties)
        .where(and(eq(warranties.companyId, companyId), eq(warranties.projectId, projectId)))
        .limit(5000),
    ]);

    const cobieAssets: CobieAsset[] = assetRows.map((r) => ({
      ...r.asset,
      creatorEmail: r.creatorEmail,
      spaceName: r.spaceName,
    }));

    return {
      project: projectRow,
      assets: cobieAssets,
      locations: locationRows,
      contacts: contactRows,
      warranties: warrantyRows.map((w) => ({
        id: w.id,
        assetId: w.assetId,
        provider: w.provider,
        description: w.description,
        startDate: w.startDate,
        endDate: w.endDate,
        documentFileId: w.documentFileId,
      })),
    };
  }

  /* ---------------------------------------------------------------- */
  /* COBie (#630-631)                                                  */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/cobie.json", { preHandler: gates.readGate }, async (req) => {
    const input = await loadWorkbookInput(req.companyId!, req.projectId!);
    const workbook = buildCobieWorkbook(input);
    return {
      ...workbook,
      // the legacy shape the first client used, kept so nothing breaks
      components: workbook.sheets.find((s) => s.name === "Component")?.rows ?? [],
      types: workbook.sheets.find((s) => s.name === "Type")?.rows ?? [],
      spaces: input.locations,
    };
  });

  app.get("/projects/:projectId/cobie/validate", { preHandler: gates.readGate }, async (req) => {
    const input = await loadWorkbookInput(req.companyId!, req.projectId!);
    const workbook = buildCobieWorkbook(input);
    const errors = workbook.issues.filter((i) => i.severity === "error");
    return {
      ok: errors.length === 0,
      errors: errors.length,
      warnings: workbook.issues.length - errors.length,
      issues: workbook.issues.slice(0, 500),
      completeness: workbook.completeness,
      sheets: workbook.sheets.map((s) => ({
        name: s.name,
        rows: s.rows.length,
        reason: s.reason ?? null,
      })),
    };
  });

  app.get("/projects/:projectId/cobie.csv", { preHandler: gates.readGate }, async (req, reply) => {
    const q = z.object({ sheet: z.string().max(40).default("Component") }).parse(req.query);
    const input = await loadWorkbookInput(req.companyId!, req.projectId!);
    const workbook = buildCobieWorkbook(input);
    const sheet =
      workbook.sheets.find((s) => s.name.toLowerCase() === q.sheet.toLowerCase()) ??
      workbook.sheets.find((s) => s.name === "Component")!;
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header(
      "content-disposition",
      `attachment; filename="cobie-${sheet.name.toLowerCase()}.csv"`,
    );
    return reply.send(sheetToCsv(sheet, csvCell));
  });

  /* ---------------------------------------------------------------- */
  /* Handover readiness                                                */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/twin/handover-readiness",
    { preHandler: gates.readGate },
    async (req) => {
      const assetRows = await app.db
        .select()
        .from(assets)
        .where(and(eq(assets.companyId, req.companyId!), eq(assets.projectId, req.projectId!)))
        .limit(10_000);
      const ids = assetRows.map((a) => a.id);
      const [links, warrantyRows, sensorRows] = ids.length
        ? await Promise.all([
            app.db
              .select({ assetId: assetElementLinks.assetId })
              .from(assetElementLinks)
              .where(inArray(assetElementLinks.assetId, ids)),
            app.db
              .select({ assetId: warranties.assetId, documentFileId: warranties.documentFileId })
              .from(warranties)
              .where(inArray(warranties.assetId, ids)),
            app.db
              .select({ assetId: sensors.assetId })
              .from(sensors)
              .where(inArray(sensors.assetId, ids)),
          ])
        : [[], [], []];
      const linked = new Set(links.map((l) => l.assetId));
      const warranted = new Set(warrantyRows.map((w) => w.assetId));
      const documented = new Set(
        warrantyRows.filter((w) => w.documentFileId).map((w) => w.assetId),
      );
      const sensed = new Set(sensorRows.map((s) => s.assetId).filter((v): v is string => !!v));

      const handoverAssets: HandoverAsset[] = assetRows.map((a) => ({
        id: a.id,
        tagCode: a.tagCode,
        name: a.name,
        status: a.status,
        criticality: a.criticality,
        locationId: a.locationId,
        classificationCode: a.classificationCode,
        manufacturer: a.manufacturer,
        modelNumber: a.modelNumber,
        serialNumber: a.serialNumber,
        installedAt: a.installedAt,
        commissionedAt: a.commissionedAt,
        hasWarranty: warranted.has(a.id),
        hasDocument:
          documented.has(a.id) || typeof a.attributes["omDocumentId"] === "string",
        hasElementLink: linked.has(a.id),
        hasSensor: sensed.has(a.id),
      }));

      const readiness = assessHandover(handoverAssets);
      const workbookInput = await loadWorkbookInput(req.companyId!, req.projectId!);
      const workbook = buildCobieWorkbook(workbookInput);
      const milestones = await app.db
        .select({ status: deliveryMilestones.status, n: count() })
        .from(deliveryMilestones)
        .where(
          and(
            eq(deliveryMilestones.companyId, req.companyId!),
            eq(deliveryMilestones.projectId, req.projectId!),
          ),
        )
        .groupBy(deliveryMilestones.status);

      return {
        ...readiness,
        cobie: {
          completeness: workbook.completeness.score,
          errors: workbook.issues.filter((i) => i.severity === "error").length,
          warnings: workbook.issues.filter((i) => i.severity === "warning").length,
        },
        milestones: Object.fromEntries(milestones.map((m) => [m.status, Number(m.n)])),
        generatedAt: new Date().toISOString(),
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Asset performance (#660-661)                                      */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/twin/performance", { preHandler: gates.readGate }, async (req) => {
    const q = z
      .object({
        days: z.coerce.number().int().min(1).max(365).default(30),
        assetId: z.string().max(64).optional(),
      })
      .parse(req.query);
    const since = new Date(Date.now() - q.days * 86_400_000).toISOString();
    const conds = [eq(sensors.companyId, req.companyId!), eq(sensors.projectId, req.projectId!)];
    if (q.assetId) conds.push(eq(sensors.assetId, q.assetId));
    const sensorRows = await app.db
      .select()
      .from(sensors)
      .where(and(...conds))
      .limit(1000);
    const ids = sensorRows.map((s) => s.id);
    const stats = ids.length
      ? await app.db
          .select({
            sensorId: sensorReadings.sensorId,
            readings: count(),
            avg: sql<number>`avg(${sensorReadings.value})`,
            min: sql<number>`min(${sensorReadings.value})`,
            max: sql<number>`max(${sensorReadings.value})`,
          })
          .from(sensorReadings)
          .where(
            and(
              inArray(sensorReadings.sensorId, ids),
              gte(sensorReadings.at, since),
              eq(sensorReadings.source, "ingest"),
            ),
          )
          .groupBy(sensorReadings.sensorId)
      : [];

    const assetIds = [...new Set(sensorRows.map((s) => s.assetId).filter((v): v is string => !!v))];
    const assetRows = assetIds.length
      ? await app.db
          .select({
            id: assets.id,
            tagCode: assets.tagCode,
            name: assets.name,
            criticality: assets.criticality,
            designBaseline: assets.designBaseline,
          })
          .from(assets)
          .where(inArray(assets.id, assetIds))
      : [];

    const rows = sensorRows.map((sensor) => {
      const stat = stats.find((s) => s.sensorId === sensor.id);
      const asset = assetRows.find((a) => a.id === sensor.assetId);
      const baselineFromAsset =
        asset?.designBaseline && typeof asset.designBaseline[sensor.kind] === "number"
          ? (asset.designBaseline[sensor.kind] as number)
          : null;
      return {
        assetId: sensor.assetId,
        assetTag: asset?.tagCode ?? null,
        assetName: asset?.name ?? null,
        ...performanceGap({
          sensorId: sensor.id,
          sensorName: sensor.name,
          kind: sensor.kind,
          unit: sensor.unit,
          designSetpoint: sensor.designSetpoint ?? baselineFromAsset,
          readings: Number(stat?.readings ?? 0),
          avg: stat ? Number(stat.avg) : null,
          min: stat ? Number(stat.min) : null,
          max: stat ? Number(stat.max) : null,
          lastValue: sensor.lastValue,
          lastAt: sensor.lastReadingAt,
        }),
      };
    });

    return {
      items: rows,
      total: rows.length,
      windowDays: q.days,
      withBaseline: rows.filter((r) => r.verdict !== "unknown").length,
      note: "Simulated readings are excluded; a channel with no design setpoint reports verdict \"unknown\" rather than a fabricated gap",
    };
  });

  /* ---------------------------------------------------------------- */
  /* Summary + health inputs                                           */
  /* ---------------------------------------------------------------- */

  async function gather(companyId: string, projectId: string) {
    const today = todayISO();
    const [assetStates, sensorRows, alertRows, warrantyRows, claimRows, milestoneRows, linkRows] =
      await Promise.all([
        app.db
          .select({ status: assets.status, n: count() })
          .from(assets)
          .where(and(eq(assets.companyId, companyId), eq(assets.projectId, projectId)))
          .groupBy(assets.status),
        app.db
          .select({ isActive: sensors.isActive, n: count() })
          .from(sensors)
          .where(and(eq(sensors.companyId, companyId), eq(sensors.projectId, projectId)))
          .groupBy(sensors.isActive),
        app.db
          .select({ status: sensorAlerts.status, n: count() })
          .from(sensorAlerts)
          .where(
            and(eq(sensorAlerts.companyId, companyId), eq(sensorAlerts.projectId, projectId)),
          )
          .groupBy(sensorAlerts.status),
        app.db
          .select({ status: warranties.status, endDate: warranties.endDate })
          .from(warranties)
          .where(and(eq(warranties.companyId, companyId), eq(warranties.projectId, projectId)))
          .limit(5000),
        app.db
          .select({ status: warrantyClaims.status, n: count() })
          .from(warrantyClaims)
          .where(
            and(
              eq(warrantyClaims.companyId, companyId),
              eq(warrantyClaims.projectId, projectId),
            ),
          )
          .groupBy(warrantyClaims.status),
        app.db
          .select({ status: deliveryMilestones.status, dueDate: deliveryMilestones.dueDate })
          .from(deliveryMilestones)
          .where(
            and(
              eq(deliveryMilestones.companyId, companyId),
              eq(deliveryMilestones.projectId, projectId),
            ),
          )
          .limit(1000),
        app.db
          .select({ n: count() })
          .from(assetElementLinks)
          .where(eq(assetElementLinks.projectId, projectId)),
      ]);

    const assetsTotal = assetStates.reduce((s, r) => s + Number(r.n), 0);
    return {
      assets: Object.fromEntries(assetStates.map((r) => [r.status, Number(r.n)])),
      assetsTotal,
      sensors: Object.fromEntries(sensorRows.map((r) => [r.isActive, Number(r.n)])),
      sensorsTotal: sensorRows.reduce((s, r) => s + Number(r.n), 0),
      alerts: Object.fromEntries(alertRows.map((r) => [r.status, Number(r.n)])),
      openAlerts: alertRows
        .filter((r) => r.status === "open" || r.status === "acknowledged")
        .reduce((s, r) => s + Number(r.n), 0),
      warranties: {
        total: warrantyRows.length,
        active: warrantyRows.filter((w) => w.status === "active").length,
        expired: warrantyRows.filter((w) => w.endDate < today).length,
        expiringWithin90Days: warrantyRows.filter(
          (w) => w.status === "active" && w.endDate >= today && w.endDate <= addDaysLocal(today, 90),
        ).length,
      },
      claims: Object.fromEntries(claimRows.map((r) => [r.status, Number(r.n)])),
      openClaims: claimRows
        .filter((r) => ["lodged", "acknowledged", "in_repair"].includes(r.status))
        .reduce((s, r) => s + Number(r.n), 0),
      milestones: {
        total: milestoneRows.length,
        accepted: milestoneRows.filter((m) => m.status === "accepted").length,
        overdue: milestoneRows.filter(
          (m) => m.dueDate && m.dueDate < today && m.status !== "accepted",
        ).length,
      },
      elementLinks: Number(linkRows[0]?.n ?? 0),
    };
  }

  function addDaysLocal(date: string, days: number): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  app.get("/projects/:projectId/twin/summary", { preHandler: gates.readGate }, async (req) => {
    const data = await gather(req.companyId!, req.projectId!);
    return {
      ...data,
      geometryCoverage:
        data.assetsTotal > 0
          ? Math.round((Math.min(data.elementLinks, data.assetsTotal) / data.assetsTotal) * 1000) / 10
          : null,
      geometryCoverageBasis:
        data.assetsTotal > 0
          ? `${data.elementLinks} element links across ${data.assetsTotal} assets`
          : "no assets have been registered",
      simulationAvailable: app.appConfig.NODE_ENV !== "production",
      generatedAt: new Date().toISOString(),
    };
  });

  app.get("/projects/:projectId/twin/health-inputs", { preHandler: gates.readGate }, async (req) => {
    const data = await gather(req.companyId!, req.projectId!);
    const reasons: string[] = [];
    if (data.assetsTotal === 0) reasons.push("No assets have been registered for handover");
    if (data.openAlerts > 0) reasons.push(`${data.openAlerts} open sensor alert(s)`);
    if (data.warranties.expired > 0) {
      reasons.push(`${data.warranties.expired} warranty/warranties have expired`);
    }
    if (data.warranties.expiringWithin90Days > 0) {
      reasons.push(`${data.warranties.expiringWithin90Days} warranty/warranties expire within 90 days`);
    }
    if (data.openClaims > 0) reasons.push(`${data.openClaims} open warranty claim(s)`);
    if (data.milestones.overdue > 0) {
      reasons.push(`${data.milestones.overdue} information delivery milestone(s) overdue`);
    }
    return {
      metrics: {
        twin_assets: data.assetsTotal,
        twin_assets_operational: data.assets["operational"] ?? 0,
        twin_open_sensor_alerts: data.openAlerts,
        twin_active_sensors: data.sensors["true"] ?? 0,
        twin_warranties_expiring_90d: data.warranties.expiringWithin90Days,
        twin_warranties_expired: data.warranties.expired,
        twin_open_warranty_claims: data.openClaims,
        twin_milestones_overdue: data.milestones.overdue,
        twin_geometry_links: data.elementLinks,
      },
      reasons,
    };
  });
};
