/**
 * Model ingestion pipeline (spec #234-236, #248, #638).
 *
 * WHY IT IS A JOB AND NOT A REQUEST
 *   Upload used to buffer the whole file, convert it to a string and parse it
 *   on the event loop inside the POST handler. A routine 400 MB discipline
 *   model therefore meant three full copies in the heap and a multi-second
 *   stall for every other tenant, and a crash left the version stuck at
 *   `processing` for ever. Now the request only stores the file and records a
 *   version in `queued`; this module streams the stored object back off disk
 *   in chunks and extracts from it, either inline (small models, so the UI
 *   still gets an immediate answer) or on the scheduler.
 *
 * WHAT ONE PASS PRODUCES
 *   - `bim_elements` rows with property sets, type name, classification,
 *     spatial container, property hash and bounding box
 *   - `locations` created from the IFC spatial structure and bound to every
 *     element inside them (#248), reusing an existing location of the same
 *     name under the same parent
 *   - a model quality report on the version (duplicate GUIDs, missing names,
 *     unclassified elements, orphan elements) that the publish gate reads
 *   - a ledger entry recording the outcome, and a signal when a model the
 *     platform accepted turns out to be unparseable
 *
 * Re-processing a version is idempotent: its elements are deleted first, so a
 * retried job cannot double-count.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  bimElements,
  bimModelVersions,
  bimModels,
  coordinationIssues,
  files,
  locations,
  notifications,
} from "@constructos/db";
import type { Db } from "../../lib/db.js";
import { newId } from "../../lib/ids.js";
import { forEachCompany } from "../../lib/scheduler.js";
import { extractIfcFromStream, type ExtractedSpatialNode } from "./ifc-extract.js";
import { ledger, nowISO, propertyHash, raiseSignal } from "./shared.js";

/** Models at or below this size are parsed inline so the upload answers with counts. */
export const INLINE_PARSE_MAX_BYTES = 8 * 1024 * 1024;

/** Hard ceiling for one IFC upload; larger files are refused with an explanation. */
export const MODEL_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;

const ELEMENT_INSERT_CHUNK = 500;

export interface QualityFinding {
  check: string;
  count: number;
  severity: "info" | "warning" | "blocking";
  detail: string;
}

export interface QualityReport {
  computedAt: string;
  elementCount: number;
  spatialCount: number;
  findings: QualityFinding[];
  /** false when a blocking finding exists - the publish gate refuses (#638) */
  passed: boolean;
  notes: string[];
}

export interface IngestOutcome {
  versionId: string;
  processing: "ready" | "failed";
  elementCount: number;
  spatialCount: number;
  locationsCreated: number;
  processingError: string | null;
  quality: QualityReport | null;
}

/* ------------------------------------------------------------------ */
/* Spatial structure -> locations (#248)                               */
/* ------------------------------------------------------------------ */

interface LocationRow {
  id: string;
  parentId: string | null;
  name: string;
  path: string;
}

/**
 * Create (or reuse) a location per spatial node, parents first, and return a
 * GlobalId -> locationId map. Names are matched case-insensitively under the
 * same parent so re-importing a model does not fork the location tree.
 */
async function syncLocations(
  db: Db,
  companyId: string,
  projectId: string,
  spatial: ExtractedSpatialNode[],
): Promise<{ byGlobalId: Map<string, string>; created: number }> {
  const byGlobalId = new Map<string, string>();
  const usable = spatial.filter(
    (node) => node.ifcType !== "IFCPROJECT" && node.name && node.name.trim().length > 0,
  );
  if (usable.length === 0) return { byGlobalId, created: 0 };

  const existing = await db
    .select({
      id: locations.id,
      parentId: locations.parentId,
      name: locations.name,
      path: locations.path,
    })
    .from(locations)
    .where(and(eq(locations.companyId, companyId), eq(locations.projectId, projectId)));
  const index = new Map<string, LocationRow>();
  for (const row of existing) index.set(`${row.parentId ?? ""}|${row.name.toLowerCase()}`, row);

  const byGuid = new Map(usable.map((node) => [node.globalId, node]));
  const resolved = new Map<string, LocationRow>();
  let created = 0;

  const resolve = async (node: ExtractedSpatialNode, depth: number): Promise<LocationRow | null> => {
    if (depth > 16) return null;
    const already = resolved.get(node.globalId);
    if (already) return already;
    let parentRow: LocationRow | null = null;
    if (node.parentGlobalId) {
      const parentNode = byGuid.get(node.parentGlobalId);
      if (parentNode) parentRow = await resolve(parentNode, depth + 1);
    }
    const name = node.name!.trim();
    const key = `${parentRow?.id ?? ""}|${name.toLowerCase()}`;
    const found = index.get(key);
    if (found) {
      resolved.set(node.globalId, found);
      return found;
    }
    const id = newId("loc");
    const row: LocationRow = {
      id,
      parentId: parentRow?.id ?? null,
      name,
      path: parentRow ? `${parentRow.path}/${id}` : id,
    };
    await db.insert(locations).values({
      id,
      companyId,
      projectId,
      parentId: row.parentId,
      name,
      path: row.path,
      sortOrder: 0,
    });
    created += 1;
    index.set(key, row);
    resolved.set(node.globalId, row);
    return row;
  };

  for (const node of usable) {
    const row = await resolve(node, 0);
    if (row) byGlobalId.set(node.globalId, row.id);
  }
  return { byGlobalId, created };
}

/* ------------------------------------------------------------------ */
/* Quality gate (#638)                                                 */
/* ------------------------------------------------------------------ */

export function buildQualityReport(input: {
  elements: Array<{
    globalId: string;
    name: string | null;
    classification: string | null;
    spatialGlobalId: string | null;
    bounds: unknown;
  }>;
  spatialCount: number;
  notes: string[];
}): QualityReport {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  let missingNames = 0;
  let missingContainer = 0;
  let missingClassification = 0;
  let withoutBounds = 0;
  for (const el of input.elements) {
    if (seen.has(el.globalId)) duplicates.add(el.globalId);
    seen.add(el.globalId);
    if (!el.name || el.name.trim().length === 0) missingNames += 1;
    if (!el.spatialGlobalId) missingContainer += 1;
    if (!el.classification) missingClassification += 1;
    if (!el.bounds) withoutBounds += 1;
  }
  const findings: QualityFinding[] = [];
  if (input.elements.length === 0) {
    findings.push({
      check: "no_elements",
      count: 0,
      severity: "blocking",
      detail: "No building elements were extracted from this container",
    });
  }
  if (duplicates.size > 0) {
    findings.push({
      check: "duplicate_global_ids",
      count: duplicates.size,
      severity: "blocking",
      detail: "GlobalIds must be unique; duplicates break asset, issue and clash binding",
    });
  }
  if (missingNames > 0) {
    findings.push({
      check: "missing_names",
      count: missingNames,
      severity: "warning",
      detail: "Elements without a name cannot be identified in a register or a report",
    });
  }
  if (missingContainer > 0) {
    findings.push({
      check: "missing_spatial_container",
      count: missingContainer,
      severity: "warning",
      detail: "Elements not contained in a storey or space cannot be located (#248)",
    });
  }
  if (missingClassification > 0) {
    findings.push({
      check: "missing_classification",
      count: missingClassification,
      severity: "info",
      detail: "Elements without a classification reference (Uniclass/Omniclass)",
    });
  }
  const notes = [...input.notes];
  if (withoutBounds > 0) {
    notes.push(`${withoutBounds} elements have no extents and are excluded from clash tests`);
  }
  return {
    computedAt: nowISO(),
    elementCount: input.elements.length,
    spatialCount: input.spatialCount,
    findings,
    passed: !findings.some((f) => f.severity === "blocking"),
    notes,
  };
}


/**
 * Point the model at a version once its extraction succeeded. The pointer is
 * only ever moved forward, so a re-processed old version cannot demote the
 * model, and a version that failed never becomes "current".
 */
async function promoteCurrentVersion(
  db: Db,
  modelId: string,
  versionId: string,
  versionNumber: number,
): Promise<void> {
  const current = await db
    .select({ id: bimModelVersions.id, version: bimModelVersions.version })
    .from(bimModels)
    .innerJoin(bimModelVersions, eq(bimModelVersions.id, bimModels.currentVersionId))
    .where(eq(bimModels.id, modelId))
    .limit(1);
  const currentVersion = current[0]?.version ?? 0;
  if (current[0] && currentVersion >= versionNumber) return;
  await db
    .update(bimModels)
    .set({ currentVersionId: versionId, updatedAt: nowISO() })
    .where(eq(bimModels.id, modelId));
}

/* ------------------------------------------------------------------ */
/* The pipeline                                                        */
/* ------------------------------------------------------------------ */

/**
 * Extract one version. Safe to call twice; never throws for a bad model (the
 * version is marked `failed` with the reason instead).
 */
export async function processVersion(
  app: FastifyInstance,
  versionId: string,
  actorId: string | null,
): Promise<IngestOutcome> {
  const rows = await app.db
    .select({ version: bimModelVersions, model: bimModels })
    .from(bimModelVersions)
    .innerJoin(bimModels, eq(bimModels.id, bimModelVersions.modelId))
    .where(eq(bimModelVersions.id, versionId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return {
      versionId,
      processing: "failed",
      elementCount: 0,
      spatialCount: 0,
      locationsCreated: 0,
      processingError: "Version not found",
      quality: null,
    };
  }
  const { version, model } = row;

  await app.db
    .update(bimModelVersions)
    .set({ processing: "processing", processingError: null })
    .where(eq(bimModelVersions.id, versionId));

  // a non-IFC container carries no extractable element table
  if (model.format !== "ifc") {
    const quality: QualityReport = {
      computedAt: nowISO(),
      elementCount: 0,
      spatialCount: 0,
      findings: [],
      passed: true,
      notes: [`${model.format.toUpperCase()} containers are stored and streamed, not parsed`],
    };
    await app.db
      .update(bimModelVersions)
      .set({
        processing: "ready",
        elementCount: 0,
        spatialCount: 0,
        processedAt: nowISO(),
        processingError: null,
        qualityReport: quality as unknown as Record<string, unknown>,
      })
      .where(eq(bimModelVersions.id, versionId));
    await promoteCurrentVersion(app.db, model.id, versionId, version.version);
    return {
      versionId,
      processing: "ready",
      elementCount: 0,
      spatialCount: 0,
      locationsCreated: 0,
      processingError: null,
      quality,
    };
  }

  const fileRows = await app.db
    .select()
    .from(files)
    .where(and(eq(files.id, version.fileId), eq(files.companyId, model.companyId)))
    .limit(1);
  const file = fileRows[0];
  if (!file) {
    return finishFailed(app, model.companyId, model.projectId, versionId, actorId, "Stored model file is missing");
  }

  try {
    const stream = app.storage.readStream(file.storageKey);
    const result = await extractIfcFromStream(stream as unknown as AsyncIterable<Buffer>);
    if (result.entityCount === 0) {
      return finishFailed(
        app,
        model.companyId,
        model.projectId,
        versionId,
        actorId,
        "No IFC entity instances found - the file is not a STEP/IFC container",
      );
    }

    const { byGlobalId, created } = await syncLocations(
      app.db,
      model.companyId,
      model.projectId,
      result.spatial,
    );

    await app.db.delete(bimElements).where(eq(bimElements.modelVersionId, versionId));

    for (let i = 0; i < result.elements.length; i += ELEMENT_INSERT_CHUNK) {
      const chunk = result.elements.slice(i, i + ELEMENT_INSERT_CHUNK).map((el) => ({
        id: newId("bel"),
        modelVersionId: versionId,
        projectId: model.projectId,
        globalId: el.globalId,
        ifcType: el.ifcType,
        name: el.name,
        properties: el.properties,
        classification: el.classification,
        locationId: el.spatialGlobalId ? (byGlobalId.get(el.spatialGlobalId) ?? null) : null,
        typeName: el.typeName,
        storey: el.storey,
        spatialGlobalId: el.spatialGlobalId,
        propertyHash: propertyHash({
          name: el.name,
          ifcType: el.ifcType,
          typeName: el.typeName,
          classification: el.classification,
          storey: el.storey,
          properties: el.properties,
          bounds: el.bounds,
        }),
        minX: el.bounds?.minX ?? null,
        minY: el.bounds?.minY ?? null,
        minZ: el.bounds?.minZ ?? null,
        maxX: el.bounds?.maxX ?? null,
        maxY: el.bounds?.maxY ?? null,
        maxZ: el.bounds?.maxZ ?? null,
      }));
      if (chunk.length > 0) await app.db.insert(bimElements).values(chunk);
    }

    const quality = buildQualityReport({
      elements: result.elements,
      spatialCount: result.spatial.length,
      notes: result.notes,
    });

    await app.db
      .update(bimModelVersions)
      .set({
        processing: "ready",
        elementCount: result.elements.length,
        spatialCount: result.spatial.length,
        processedAt: nowISO(),
        processingError: null,
        qualityReport: quality as unknown as Record<string, unknown>,
      })
      .where(eq(bimModelVersions.id, versionId));

    await promoteCurrentVersion(app.db, model.id, versionId, version.version);

    await ledger(app.db, {
      companyId: model.companyId,
      projectId: model.projectId,
      actorId,
      action: "update",
      objectType: "bim_model_version",
      objectId: versionId,
      payload: {
        processing: "ready",
        elementCount: result.elements.length,
        spatialCount: result.spatial.length,
        locationsCreated: created,
        quality: { passed: quality.passed, findings: quality.findings.length },
      },
      storePayload: true,
    });

    return {
      versionId,
      processing: "ready",
      elementCount: result.elements.length,
      spatialCount: result.spatial.length,
      locationsCreated: created,
      processingError: null,
      quality,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return finishFailed(app, model.companyId, model.projectId, versionId, actorId, message);
  }
}

async function finishFailed(
  app: FastifyInstance,
  companyId: string,
  projectId: string,
  versionId: string,
  actorId: string | null,
  message: string,
): Promise<IngestOutcome> {
  await app.db
    .update(bimModelVersions)
    .set({
      processing: "failed",
      elementCount: 0,
      processedAt: nowISO(),
      processingError: message.slice(0, 2000),
    })
    .where(eq(bimModelVersions.id, versionId));
  await ledger(app.db, {
    companyId,
    projectId,
    actorId,
    action: "update",
    objectType: "bim_model_version",
    objectId: versionId,
    payload: { processing: "failed", error: message.slice(0, 500) },
    storePayload: true,
  });
  await raiseSignal(app.db, companyId, projectId, actorId, {
    detector: "bim_ingest_failed",
    severity: "medium",
    confidence: 1,
    title: "Model ingestion failed",
    explanation: `Element extraction failed for model version ${versionId}: ${message.slice(0, 300)}`,
    key: `bim_ingest_failed:${versionId}`,
    evidence: { versionId, error: message.slice(0, 500) },
    subjectType: "bim_model_version",
    subjectId: versionId,
  });
  return {
    versionId,
    processing: "failed",
    elementCount: 0,
    spatialCount: 0,
    locationsCreated: 0,
    processingError: message,
    quality: null,
  };
}

/** Process up to `limit` queued versions for one company. */
export async function runIngestQueue(
  app: FastifyInstance,
  companyId: string,
  limit = 5,
): Promise<{ processed: number; failed: number }> {
  const pending = await app.db
    .select({ id: bimModelVersions.id })
    .from(bimModelVersions)
    .innerJoin(bimModels, eq(bimModels.id, bimModelVersions.modelId))
    .where(
      and(
        eq(bimModels.companyId, companyId),
        inArray(bimModelVersions.processing, ["pending", "queued"]),
      ),
    )
    .orderBy(asc(bimModelVersions.createdAt))
    .limit(limit);
  let processed = 0;
  let failed = 0;
  for (const row of pending) {
    const outcome = await processVersion(app, row.id, null);
    if (outcome.processing === "ready") processed += 1;
    else failed += 1;
  }
  return { processed, failed };
}

/**
 * Reconcile versions abandoned mid-parse (a crashed worker): anything that has
 * been `processing` for longer than the stall window goes back on the queue.
 */
export async function requeueStalled(
  db: Db,
  companyId: string,
  now: Date,
  stallMinutes = 30,
): Promise<number> {
  const cutoff = new Date(now.getTime() - stallMinutes * 60_000).toISOString();
  const stalled = await db
    .select({ id: bimModelVersions.id })
    .from(bimModelVersions)
    .innerJoin(bimModels, eq(bimModels.id, bimModelVersions.modelId))
    .where(
      and(
        eq(bimModels.companyId, companyId),
        eq(bimModelVersions.processing, "processing"),
        sql`${bimModelVersions.createdAt} < ${cutoff}`,
      ),
    )
    .limit(50);
  if (stalled.length === 0) return 0;
  await db
    .update(bimModelVersions)
    .set({ processing: "queued" })
    .where(
      inArray(
        bimModelVersions.id,
        stalled.map((s) => s.id),
      ),
    );
  return stalled.length;
}

/* ------------------------------------------------------------------ */
/* Coordination SLA sweep                                              */
/* ------------------------------------------------------------------ */

/**
 * Coordination issues past their due date (#241): notify the assignee once,
 * raise one signal per issue, and never repeat either.
 */
export async function sweepOverdueIssues(
  app: FastifyInstance,
  companyId: string,
  today: string,
): Promise<{ overdue: number; notified: number }> {
  const overdue = await app.db
    .select()
    .from(coordinationIssues)
    .where(
      and(
        eq(coordinationIssues.companyId, companyId),
        inArray(coordinationIssues.status, ["open", "assigned"]),
        sql`${coordinationIssues.dueDate} is not null`,
        sql`${coordinationIssues.dueDate} < ${today}`,
        isNull(coordinationIssues.overdueNotifiedAt),
      ),
    )
    .limit(500);

  let notified = 0;
  for (const issue of overdue) {
    if (issue.assigneeId) {
      await app.db.insert(notifications).values({
        id: newId("ntf"),
        companyId,
        userId: issue.assigneeId,
        projectId: issue.projectId,
        kind: "overdue",
        title: `Coordination issue #${issue.number} is overdue`,
        body: `${issue.title} was due ${issue.dueDate}`,
        recordType: "coordination_issue",
        recordId: issue.id,
      });
      notified += 1;
    }
    await raiseSignal(app.db, companyId, issue.projectId, null, {
      detector: "bim_issue_overdue",
      severity: issue.status === "open" ? "medium" : "low",
      confidence: 1,
      title: `Coordination issue #${issue.number} overdue`,
      explanation: `"${issue.title}" was due ${issue.dueDate} and is still ${issue.status}.`,
      key: `bim_issue_overdue:${issue.id}`,
      evidence: { issueId: issue.id, dueDate: issue.dueDate, status: issue.status },
      subjectType: "coordination_issue",
      subjectId: issue.id,
    });
    await app.db
      .update(coordinationIssues)
      .set({ overdueNotifiedAt: nowISO() })
      .where(eq(coordinationIssues.id, issue.id));
  }
  return { overdue: overdue.length, notified };
}

/* ------------------------------------------------------------------ */
/* Scheduler registration                                              */
/* ------------------------------------------------------------------ */

export function registerBimJobs(app: FastifyInstance): void {
  app.scheduler.register({
    name: "bim.ingest",
    description: "Extract elements from queued model versions and requeue stalled ones",
    everyMs: 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, async (companyId) => {
        await requeueStalled(db, companyId, now);
        return runIngestQueue(app, companyId);
      }),
  });

  app.scheduler.register({
    name: "bim.issues-overdue",
    description: "Notify assignees and raise signals for overdue coordination issues",
    everyMs: 60 * 60_000,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        sweepOverdueIssues(app, companyId, now.toISOString().slice(0, 10)),
      ),
  });
}
