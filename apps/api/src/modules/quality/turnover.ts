/**
 * Turnover packages — and the hand-over INTO the twin.
 *
 * Two ideas carry this file.
 *
 * THE GAP IS THE VALUE. A turnover package is a checklist of artefact kinds
 * with a required count and a present count, and the difference between them
 * is the only number anybody needs: "the O&Ms are missing" has to be a query,
 * not a conversation in a handover meeting six weeks after the contractor
 * demobilised. Every read surfaces the gap by name.
 *
 * ACCEPTANCE IS THE HAND-OVER. When an owner accepts a package the asset
 * register stops being a construction artefact and becomes an operations one.
 * That is a write INTO twin.ts — `assets` move to operational, their IFC GUIDs
 * are bound through `asset_element_links`, warranty rows are created in
 * `warranties`, the COBie file id is recorded and the handover timestamp is
 * stamped. Quality does not keep a second asset register beside the twin's;
 * it fills the twin's in.
 *
 * Open punch items and open NCRs against the package's systems block or warn
 * per a configurable strictness, and the refusal names the records — a
 * blocked turnover that will not say what is blocking it is just an argument.
 */

import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  assetElementLinks,
  assets,
  commissioningSystems,
  commissioningTestRecords,
  nonConformanceReports,
  punchItems,
  turnoverPackages,
  warranties,
} from "@constructos/db";
import {
  TURNOVER_ARTEFACT_KINDS,
  TURNOVER_PACKAGE_TYPES,
  TURNOVER_STATUSES,
  type TurnoverArtefactKind,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import {
  allocateReference,
  assertDistinctActor,
  assertLocation,
  assertVendor,
  buildGates,
  fileIdsSchema,
  idSchema,
  isoDateSchema,
  ledger,
  nowISO,
  todayISO,
  uniq,
} from "./shared.js";
import { sweepQuality } from "./sweeps.js";

/**
 * The twin's asset lifecycle, forward-only (modules/twin/index.ts holds the
 * same list and enforces the same rule on PATCH /assets/:id). Duplicated here
 * as a local constant rather than imported because twin keeps it private;
 * handover only ever moves an asset FORWARD to `operational`, so a divergence
 * would show up as a refusal to advance, never as a silent regression.
 */
const ASSET_LIFECYCLE = [
  "planned",
  "installed",
  "commissioned",
  "operational",
  "decommissioned",
] as const;

/* ------------------------------------------------------------------ */
/* Strictness                                                          */
/* ------------------------------------------------------------------ */

/**
 * How hard the platform holds the line at turnover.
 *
 *   block  — refuse submission and acceptance while anything is outstanding
 *   warn   — allow, but return every outstanding record so the acceptance is
 *            demonstrably informed
 *   ignore — allow silently; the gap is still reported, never hidden
 *
 * `block` is the default because the moment of acceptance is the last moment
 * anybody has leverage to get the missing certificate.
 */
export const TURNOVER_STRICTNESS = ["block", "warn", "ignore"] as const;
export type TurnoverStrictness = (typeof TURNOVER_STRICTNESS)[number];

export function strictnessOf(detail: unknown): TurnoverStrictness {
  const value = (detail as Record<string, unknown> | null)?.["blockingStrictness"];
  return (TURNOVER_STRICTNESS as readonly string[]).includes(value as string)
    ? (value as TurnoverStrictness)
    : "block";
}

/* ------------------------------------------------------------------ */
/* Contents                                                            */
/* ------------------------------------------------------------------ */

export interface ArtefactEntry {
  kind: TurnoverArtefactKind | string;
  required: boolean;
  present: boolean;
  fileId?: string | null;
  note?: string | null;
}

export function normaliseContents(raw: unknown): ArtefactEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ArtefactEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec["kind"] !== "string") continue;
    out.push({
      kind: rec["kind"],
      required: rec["required"] !== false,
      present: rec["present"] === true,
      fileId: typeof rec["fileId"] === "string" ? rec["fileId"] : null,
      note: typeof rec["note"] === "string" ? rec["note"] : null,
    });
  }
  return out;
}

export interface ArtefactGap {
  requiredArtefactCount: number;
  presentArtefactCount: number;
  gap: number;
  missingKinds: string[];
  contents: ArtefactEntry[];
}

export function artefactGap(raw: unknown): ArtefactGap {
  const contents = normaliseContents(raw);
  const required = contents.filter((c) => c.required);
  const present = required.filter((c) => c.present);
  return {
    requiredArtefactCount: required.length,
    presentArtefactCount: present.length,
    gap: required.length - present.length,
    missingKinds: required.filter((c) => !c.present).map((c) => c.kind),
    contents,
  };
}

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const artefactSchema = z.object({
  kind: z.enum(TURNOVER_ARTEFACT_KINDS),
  required: z.boolean().optional(),
  present: z.boolean().optional(),
  fileId: idSchema.nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

const packageCreateSchema = z.object({
  name: z.string().min(1).max(300),
  description: z.string().max(10_000).nullable().optional(),
  packageType: z.enum(TURNOVER_PACKAGE_TYPES).optional(),
  systemId: idSchema.nullable().optional(),
  systemIds: z.array(idSchema).max(500).optional(),
  locationId: idSchema.nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  contents: z.array(artefactSchema).max(TURNOVER_ARTEFACT_KINDS.length).optional(),
  blockingStrictness: z.enum(TURNOVER_STRICTNESS).optional(),
  beneficialUseDate: isoDateSchema.nullable().optional(),
  warrantyStartDate: isoDateSchema.nullable().optional(),
  warrantyEndDate: isoDateSchema.nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const packagePatchSchema = packageCreateSchema.partial().extend({
  asBuiltFileIds: fileIdsSchema.optional(),
  oAndMFileIds: fileIdsSchema.optional(),
  testRecordIds: z.array(idSchema).max(500).optional(),
  certificateFileIds: fileIdsSchema.optional(),
  warrantyIds: z.array(idSchema).max(500).optional(),
  trainingRecordIds: z.array(idSchema).max(500).optional(),
  sparePartsListFileId: idSchema.nullable().optional(),
  packageFileId: idSchema.nullable().optional(),
});

const packageListQuery = pageQuerySchema.extend({
  status: z.enum(TURNOVER_STATUSES).optional(),
  packageType: z.enum(TURNOVER_PACKAGE_TYPES).optional(),
  systemId: idSchema.optional(),
  vendorId: idSchema.optional(),
  search: z.string().max(200).optional(),
});

const contentsSchema = z.object({ contents: z.array(artefactSchema).max(200) });

const markArtefactSchema = z.object({
  present: z.boolean(),
  required: z.boolean().optional(),
  fileId: idSchema.nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

const submitSchema = z.object({ note: z.string().max(10_000).nullable().optional() });

const reviewSchema = z.object({
  outcome: z.enum(["comments_issued", "cleared"]),
  comments: z.string().max(20_000).nullable().optional(),
});

const acceptSchema = z.object({
  cobieFileId: idSchema.nullable().optional(),
  assetIds: z.array(idSchema).max(2000).optional(),
  ifcGlobalIds: z.array(z.string().min(1).max(64)).max(5000).optional(),
  beneficialUseDate: isoDateSchema.nullable().optional(),
  warrantyStartDate: isoDateSchema.nullable().optional(),
  warrantyEndDate: isoDateSchema.nullable().optional(),
  warrantyProvider: z.string().max(200).nullable().optional(),
  note: z.string().max(10_000).nullable().optional(),
  /** acknowledge outstanding records where strictness permits it */
  acceptOutstanding: z.boolean().optional(),
});

const rejectSchema = z.object({ reason: z.string().min(1).max(20_000) });

const PACKAGE_PATCH_COLUMNS = [
  "name",
  "description",
  "packageType",
  "systemId",
  "systemIds",
  "locationId",
  "vendorId",
  "asBuiltFileIds",
  "oAndMFileIds",
  "testRecordIds",
  "certificateFileIds",
  "warrantyIds",
  "trainingRecordIds",
  "sparePartsListFileId",
  "packageFileId",
  "beneficialUseDate",
  "warrantyStartDate",
  "warrantyEndDate",
] as const;

const OPEN_PUNCH_STATUSES = ["open", "in_progress", "ready_for_review"];
const OPEN_NCR_STATUSES = [
  "open",
  "under_review",
  "disposition_proposed",
  "disposition_approved",
  "action_in_progress",
  "verification_pending",
];

const SUBMITTABLE_STATUSES = ["draft", "assembling", "comments_issued", "rejected"];
const REVIEWABLE_STATUSES = ["submitted", "resubmitted", "under_review"];
const ACCEPTABLE_STATUSES = ["submitted", "resubmitted", "under_review"];

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const turnoverRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);

  async function fetchPackage(packageId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(turnoverPackages)
      .where(
        and(
          eq(turnoverPackages.id, packageId),
          eq(turnoverPackages.companyId, companyId),
          eq(turnoverPackages.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Turnover package not found");
    return rows[0];
  }

  function packageSystemIds(pkg: typeof turnoverPackages.$inferSelect): string[] {
    return uniq([pkg.systemId, ...pkg.systemIds].filter((s): s is string => typeof s === "string"));
  }

  async function loadSystems(systemIds: string[], projectId: string) {
    if (systemIds.length === 0) return [];
    return app.db
      .select()
      .from(commissioningSystems)
      .where(
        and(
          eq(commissioningSystems.projectId, projectId),
          inArray(commissioningSystems.id, systemIds),
        ),
      );
  }

  /**
   * Everything still open against this package's systems, BY NAME.
   *
   * The links are real ones, not guesses: a punch item reaches a system
   * through the `deficiencyRecordIds` of that system's commissioning test
   * records, or through the location the system sits in; an NCR reaches it
   * through `testRecordId`, through the twin asset the system is bound to, or
   * through the `systemId` stamped on the NCR when a commissioning test
   * raised it.
   */
  async function blockingRecords(
    pkg: typeof turnoverPackages.$inferSelect,
    projectId: string,
    companyId: string,
  ) {
    const systemIds = packageSystemIds(pkg);
    const systems = await loadSystems(systemIds, projectId);
    const assetIds = uniq(systems.map((s) => s.assetId).filter((a): a is string => !!a));
    const locationIds = uniq(systems.map((s) => s.locationId).filter((l): l is string => !!l));
    const tests = systemIds.length
      ? await app.db
          .select()
          .from(commissioningTestRecords)
          .where(
            and(
              eq(commissioningTestRecords.projectId, projectId),
              inArray(commissioningTestRecords.systemId, systemIds),
            ),
          )
      : [];
    const testIds = tests.map((t) => t.id);
    const deficiencyIds = uniq(tests.flatMap((t) => t.deficiencyRecordIds));

    const openPunch =
      deficiencyIds.length > 0 || locationIds.length > 0
        ? (
            await app.db
              .select()
              .from(punchItems)
              .where(
                and(
                  eq(punchItems.companyId, companyId),
                  eq(punchItems.projectId, projectId),
                  inArray(punchItems.status, OPEN_PUNCH_STATUSES),
                ),
              )
          ).filter(
            (p) =>
              deficiencyIds.includes(p.id) ||
              (p.locationId !== null && locationIds.includes(p.locationId)),
          )
        : [];

    const openNcrs =
      testIds.length > 0 || assetIds.length > 0 || systemIds.length > 0
        ? (
            await app.db
              .select()
              .from(nonConformanceReports)
              .where(
                and(
                  eq(nonConformanceReports.companyId, companyId),
                  eq(nonConformanceReports.projectId, projectId),
                  inArray(nonConformanceReports.status, OPEN_NCR_STATUSES),
                ),
              )
          ).filter((n) => {
            if (n.testRecordId && testIds.includes(n.testRecordId)) return true;
            if (n.assetId && assetIds.includes(n.assetId)) return true;
            const stamped = (n.detail as Record<string, unknown>)["systemId"];
            return typeof stamped === "string" && systemIds.includes(stamped);
          })
        : [];

    const reasons: string[] = [];
    for (const p of openPunch) {
      reasons.push(`Punch item #${p.number} "${p.title}" is ${p.status}.`);
    }
    for (const n of openNcrs) {
      reasons.push(
        `${n.reference} "${n.title}" is ${n.status} with disposition "${n.disposition}".`,
      );
    }
    return { systems, openPunch, openNcrs, reasons };
  }

  async function readinessOf(pkg: typeof turnoverPackages.$inferSelect, req: { companyId: string; projectId: string }) {
    const gap = artefactGap(pkg.contents);
    const blocking = await blockingRecords(pkg, req.projectId, req.companyId);
    const strictness = strictnessOf(pkg.detail);
    const artefactReasons =
      gap.gap > 0
        ? [
            `${gap.gap} required artefact(s) are missing: ${gap.missingKinds.join(", ")}. The gap is the reason the package has a contents list at all — an owner who accepts without them inherits a building nobody can operate or prove compliant.`,
          ]
        : [];
    const outstanding = [...artefactReasons, ...blocking.reasons];
    return {
      strictness,
      artefacts: gap,
      openPunchItems: blocking.openPunch.map((p) => ({
        id: p.id,
        number: p.number,
        title: p.title,
        status: p.status,
      })),
      openNcrs: blocking.openNcrs.map((n) => ({
        id: n.id,
        reference: n.reference,
        title: n.title,
        status: n.status,
        disposition: n.disposition,
      })),
      systems: blocking.systems.map((s) => ({
        id: s.id,
        systemCode: s.systemCode,
        name: s.name,
        status: s.status,
        assetId: s.assetId,
        ifcGlobalIds: s.ifcGlobalIds,
      })),
      outstanding,
      clear: outstanding.length === 0,
      wouldBlock: strictness === "block" && outstanding.length > 0,
    };
  }

  /** Keep the stored counts in step with the contents list. */
  async function persistCounts(
    packageId: string,
    contents: unknown,
    openPunchCount: number,
    openNcrCount: number,
  ) {
    const gap = artefactGap(contents);
    await app.db
      .update(turnoverPackages)
      .set({
        requiredArtefactCount: gap.requiredArtefactCount,
        presentArtefactCount: gap.presentArtefactCount,
        openPunchItemCount: openPunchCount,
        openNcrCount: openNcrCount,
        updatedAt: nowISO(),
      })
      .where(eq(turnoverPackages.id, packageId));
    return gap;
  }

  /* ---------------------------------------------------------------- */
  /* Register                                                          */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/turnover-packages",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = packageCreateSchema.parse(req.body);
      if (body.vendorId) await assertVendor(app.db, req.companyId!, body.vendorId);
      if (body.locationId) await assertLocation(app.db, req.projectId!, body.locationId);
      const systemIds = uniq(
        [body.systemId, ...(body.systemIds ?? [])].filter((s): s is string => !!s),
      );
      if (systemIds.length > 0) {
        const found = await loadSystems(systemIds, req.projectId!);
        const missing = systemIds.filter((id) => !found.some((s) => s.id === id));
        if (missing.length > 0) {
          throw badRequest(`Commissioning system(s) not found in this project: ${missing.join(", ")}`);
        }
      }
      const contents = (body.contents ?? []).map((c) => ({
        kind: c.kind,
        required: c.required !== false,
        present: c.present === true,
        fileId: c.fileId ?? null,
        note: c.note ?? null,
      }));
      const gap = artefactGap(contents);
      const { number, reference } = await allocateReference(
        app.db,
        req.projectId!,
        "turnover_package",
        "TOP",
      );
      const id = newId("top");
      const [created] = await app.db
        .insert(turnoverPackages)
        .values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          number,
          reference,
          name: body.name,
          description: body.description ?? null,
          packageType: body.packageType ?? "system",
          systemId: body.systemId ?? systemIds[0] ?? null,
          systemIds,
          locationId: body.locationId ?? null,
          vendorId: body.vendorId ?? null,
          contents,
          requiredArtefactCount: gap.requiredArtefactCount,
          presentArtefactCount: gap.presentArtefactCount,
          beneficialUseDate: body.beneficialUseDate ?? null,
          warrantyStartDate: body.warrantyStartDate ?? null,
          warrantyEndDate: body.warrantyEndDate ?? null,
          detail: {
            ...(body.detail ?? {}),
            blockingStrictness: body.blockingStrictness ?? "block",
          },
          createdBy: req.user!.id,
        })
        .returning();
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "turnover_package",
        objectId: id,
        payload: created,
        storePayload: true,
      });
      return reply.status(201).send({ ...created, artefacts: gap });
    },
  );

  app.get("/projects/:projectId/turnover-packages", { preHandler: readGate }, async (req) => {
    await sweepQuality(app.db, req.companyId!, req.projectId!, req.user!.id);
    const q = packageListQuery.parse(req.query);
    const clauses = [
      eq(turnoverPackages.companyId, req.companyId!),
      eq(turnoverPackages.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(turnoverPackages.status, q.status));
    if (q.packageType) clauses.push(eq(turnoverPackages.packageType, q.packageType));
    if (q.systemId) clauses.push(eq(turnoverPackages.systemId, q.systemId));
    if (q.vendorId) clauses.push(eq(turnoverPackages.vendorId, q.vendorId));
    if (q.search) clauses.push(ilike(turnoverPackages.name, `%${q.search}%`));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(turnoverPackages).where(where);
    const rows = await app.db
      .select()
      .from(turnoverPackages)
      .where(where)
      .orderBy(desc(turnoverPackages.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      rows.map((p) => ({ ...p, artefacts: artefactGap(p.contents) })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.get(
    "/projects/:projectId/turnover-packages/:packageId",
    { preHandler: readGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const pkg = await fetchPackage(packageId, req.companyId!, req.projectId!);
      const readiness = await readinessOf(pkg, {
        companyId: req.companyId!,
        projectId: req.projectId!,
      });
      await persistCounts(
        packageId,
        pkg.contents,
        readiness.openPunchItems.length,
        readiness.openNcrs.length,
      );
      return {
        ...(await fetchPackage(packageId, req.companyId!, req.projectId!)),
        artefacts: readiness.artefacts,
        readiness,
      };
    },
  );

  app.get(
    "/projects/:projectId/turnover-packages/:packageId/readiness",
    { preHandler: readGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const pkg = await fetchPackage(packageId, req.companyId!, req.projectId!);
      const readiness = await readinessOf(pkg, {
        companyId: req.companyId!,
        projectId: req.projectId!,
      });
      await persistCounts(
        packageId,
        pkg.contents,
        readiness.openPunchItems.length,
        readiness.openNcrs.length,
      );
      return {
        ...readiness,
        canSubmit: SUBMITTABLE_STATUSES.includes(pkg.status) && !readiness.wouldBlock,
        canAccept: ACCEPTABLE_STATUSES.includes(pkg.status) && !readiness.wouldBlock,
      };
    },
  );

  app.patch(
    "/projects/:projectId/turnover-packages/:packageId",
    { preHandler: standardGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const body = packagePatchSchema.parse(req.body);
      const pkg = await fetchPackage(packageId, req.companyId!, req.projectId!);
      if (pkg.status === "accepted" || pkg.status === "handed_over") {
        throw badRequest(
          `${pkg.reference} is ${pkg.status}. A handed-over package is the record of what was handed over and is not edited afterwards.`,
        );
      }
      if (body.vendorId) await assertVendor(app.db, req.companyId!, body.vendorId);
      if (body.locationId) await assertLocation(app.db, req.projectId!, body.locationId);
      const set: Record<string, unknown> = { updatedAt: nowISO() };
      for (const key of PACKAGE_PATCH_COLUMNS) {
        const value = (body as Record<string, unknown>)[key];
        if (value !== undefined) set[key] = value;
      }
      if (body.blockingStrictness || body.detail) {
        set["detail"] = {
          ...(pkg.detail as Record<string, unknown>),
          ...(body.detail ?? {}),
          blockingStrictness: body.blockingStrictness ?? strictnessOf(pkg.detail),
        };
      }
      if (body.contents) {
        const contents = body.contents.map((c) => ({
          kind: c.kind,
          required: c.required !== false,
          present: c.present === true,
          fileId: c.fileId ?? null,
          note: c.note ?? null,
        }));
        set["contents"] = contents;
        const gap = artefactGap(contents);
        set["requiredArtefactCount"] = gap.requiredArtefactCount;
        set["presentArtefactCount"] = gap.presentArtefactCount;
      }
      await app.db.update(turnoverPackages).set(set).where(eq(turnoverPackages.id, packageId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "turnover_package",
        objectId: packageId,
        payload: { changed: Object.keys(body) },
      });
      const updated = await fetchPackage(packageId, req.companyId!, req.projectId!);
      return { ...updated, artefacts: artefactGap(updated.contents) };
    },
  );

  app.put(
    "/projects/:projectId/turnover-packages/:packageId/contents",
    { preHandler: standardGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const body = contentsSchema.parse(req.body);
      const pkg = await fetchPackage(packageId, req.companyId!, req.projectId!);
      if (pkg.status === "handed_over") {
        throw badRequest(`${pkg.reference} has been handed over; its contents are the record.`);
      }
      const contents = body.contents.map((c) => ({
        kind: c.kind,
        required: c.required !== false,
        present: c.present === true,
        fileId: c.fileId ?? null,
        note: c.note ?? null,
      }));
      const gap = artefactGap(contents);
      await app.db
        .update(turnoverPackages)
        .set({
          contents,
          requiredArtefactCount: gap.requiredArtefactCount,
          presentArtefactCount: gap.presentArtefactCount,
          status: pkg.status === "draft" ? "assembling" : pkg.status,
          updatedAt: nowISO(),
        })
        .where(eq(turnoverPackages.id, packageId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "turnover_package",
        objectId: packageId,
        payload: { contents, gap: gap.gap, missingKinds: gap.missingKinds },
        storePayload: true,
      });
      const updated = await fetchPackage(packageId, req.companyId!, req.projectId!);
      return { ...updated, artefacts: artefactGap(updated.contents) };
    },
  );

  app.post(
    "/projects/:projectId/turnover-packages/:packageId/contents/:kind",
    { preHandler: standardGate },
    async (req) => {
      const { packageId, kind } = req.params as { packageId: string; kind: string };
      const body = markArtefactSchema.parse(req.body);
      if (!(TURNOVER_ARTEFACT_KINDS as readonly string[]).includes(kind)) {
        throw badRequest(
          `"${kind}" is not a turnover artefact kind. Known kinds: ${TURNOVER_ARTEFACT_KINDS.join(", ")}.`,
        );
      }
      const pkg = await fetchPackage(packageId, req.companyId!, req.projectId!);
      if (pkg.status === "handed_over") {
        throw badRequest(`${pkg.reference} has been handed over; its contents are the record.`);
      }
      const contents = normaliseContents(pkg.contents);
      const existing = contents.find((c) => c.kind === kind);
      if (existing) {
        existing.present = body.present;
        if (body.required !== undefined) existing.required = body.required;
        if (body.fileId !== undefined) existing.fileId = body.fileId;
        if (body.note !== undefined) existing.note = body.note;
      } else {
        contents.push({
          kind,
          required: body.required !== false,
          present: body.present,
          fileId: body.fileId ?? null,
          note: body.note ?? null,
        });
      }
      const gap = artefactGap(contents);
      await app.db
        .update(turnoverPackages)
        .set({
          contents,
          requiredArtefactCount: gap.requiredArtefactCount,
          presentArtefactCount: gap.presentArtefactCount,
          updatedAt: nowISO(),
        })
        .where(eq(turnoverPackages.id, packageId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "turnover_package",
        objectId: packageId,
        payload: { kind, present: body.present, fileId: body.fileId ?? null, gap: gap.gap },
        storePayload: true,
      });
      const updated = await fetchPackage(packageId, req.companyId!, req.projectId!);
      return { ...updated, artefacts: artefactGap(updated.contents) };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Submission, review, resubmission                                  */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/turnover-packages/:packageId/submit",
    { preHandler: standardGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const body = submitSchema.parse(req.body ?? {});
      const pkg = await fetchPackage(packageId, req.companyId!, req.projectId!);
      if (!SUBMITTABLE_STATUSES.includes(pkg.status)) {
        throw badRequest(`${pkg.reference} is ${pkg.status} and is not awaiting submission.`);
      }
      const readiness = await readinessOf(pkg, {
        companyId: req.companyId!,
        projectId: req.projectId!,
      });
      if (readiness.wouldBlock) {
        throw badRequest(
          `${pkg.reference} cannot be submitted while its strictness is "block" and the following remain outstanding: ${readiness.outstanding.join(" ")}`,
        );
      }
      const resubmission = pkg.status === "comments_issued" || pkg.status === "rejected";
      const at = nowISO();
      await app.db
        .update(turnoverPackages)
        .set({
          status: resubmission ? "resubmitted" : "submitted",
          submittedAt: at,
          submittedBy: req.user!.id,
          resubmissionCount: resubmission ? pkg.resubmissionCount + 1 : pkg.resubmissionCount,
          requiredArtefactCount: readiness.artefacts.requiredArtefactCount,
          presentArtefactCount: readiness.artefacts.presentArtefactCount,
          openPunchItemCount: readiness.openPunchItems.length,
          openNcrCount: readiness.openNcrs.length,
          updatedAt: at,
        })
        .where(eq(turnoverPackages.id, packageId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "turnover_package",
        objectId: packageId,
        payload: {
          from: pkg.status,
          to: resubmission ? "resubmitted" : "submitted",
          submittedBy: req.user!.id,
          artefacts: readiness.artefacts,
          outstanding: readiness.outstanding,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      const updated = await fetchPackage(packageId, req.companyId!, req.projectId!);
      return { ...updated, readiness, warnings: readiness.outstanding };
    },
  );

  app.post(
    "/projects/:projectId/turnover-packages/:packageId/review",
    { preHandler: standardGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const body = reviewSchema.parse(req.body);
      const pkg = await fetchPackage(packageId, req.companyId!, req.projectId!);
      if (!REVIEWABLE_STATUSES.includes(pkg.status)) {
        throw badRequest(`${pkg.reference} is ${pkg.status} and is not with a reviewer.`);
      }
      assertDistinctActor(
        req.user!.id,
        pkg.submittedBy,
        `Review of ${pkg.reference}`,
        "submitted",
      );
      const at = nowISO();
      const status = body.outcome === "comments_issued" ? "comments_issued" : "under_review";
      await app.db
        .update(turnoverPackages)
        .set({
          status,
          reviewedBy: req.user!.id,
          reviewedAt: at,
          reviewComments: body.comments ?? null,
          updatedAt: at,
        })
        .where(eq(turnoverPackages.id, packageId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "turnover_package",
        objectId: packageId,
        payload: {
          from: pkg.status,
          to: status,
          reviewedBy: req.user!.id,
          outcome: body.outcome,
          comments: body.comments ?? null,
        },
        storePayload: true,
      });
      return fetchPackage(packageId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/turnover-packages/:packageId/reject",
    { preHandler: standardGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const body = rejectSchema.parse(req.body);
      const pkg = await fetchPackage(packageId, req.companyId!, req.projectId!);
      if (!REVIEWABLE_STATUSES.includes(pkg.status)) {
        throw badRequest(`${pkg.reference} is ${pkg.status} and is not with a reviewer.`);
      }
      assertDistinctActor(
        req.user!.id,
        pkg.submittedBy,
        `Rejection of ${pkg.reference}`,
        "submitted",
      );
      const at = nowISO();
      await app.db
        .update(turnoverPackages)
        .set({
          status: "rejected",
          reviewedBy: req.user!.id,
          reviewedAt: at,
          rejectionReason: body.reason,
          updatedAt: at,
        })
        .where(eq(turnoverPackages.id, packageId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "turnover_package",
        objectId: packageId,
        payload: { from: pkg.status, to: "rejected", reason: body.reason },
        storePayload: true,
      });
      return fetchPackage(packageId, req.companyId!, req.projectId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Acceptance — and the hand-over INTO the twin                      */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/turnover-packages/:packageId/accept",
    { preHandler: standardGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const body = acceptSchema.parse(req.body ?? {});
      const pkg = await fetchPackage(packageId, req.companyId!, req.projectId!);
      if (!ACCEPTABLE_STATUSES.includes(pkg.status)) {
        throw badRequest(
          `${pkg.reference} is ${pkg.status}; a package is accepted once it has been submitted for acceptance.`,
        );
      }
      assertDistinctActor(
        req.user!.id,
        pkg.submittedBy,
        `Acceptance of ${pkg.reference}`,
        "submitted",
      );
      assertDistinctActor(
        req.user!.id,
        pkg.createdBy,
        `Acceptance of ${pkg.reference}`,
        "assembled",
      );

      const readiness = await readinessOf(pkg, {
        companyId: req.companyId!,
        projectId: req.projectId!,
      });
      if (readiness.strictness === "block" && readiness.outstanding.length > 0) {
        throw badRequest(
          `${pkg.reference} cannot be accepted. Turnover strictness is "block" and the following are outstanding against its systems: ${readiness.outstanding.join(" ")} ` +
            `Close them, or lower the strictness on the package deliberately and record why.`,
        );
      }
      if (
        readiness.strictness === "warn" &&
        readiness.outstanding.length > 0 &&
        body.acceptOutstanding !== true
      ) {
        throw badRequest(
          `${pkg.reference} has outstanding records and its strictness is "warn": ${readiness.outstanding.join(" ")} ` +
            `Re-send with acceptOutstanding: true to accept them knowingly — the acknowledgement is recorded in the ledger.`,
        );
      }

      const at = nowISO();
      const today = todayISO();
      const warrantyStartDate = body.warrantyStartDate ?? pkg.warrantyStartDate ?? today;
      const warrantyEndDate = body.warrantyEndDate ?? pkg.warrantyEndDate ?? null;
      const beneficialUseDate = body.beneficialUseDate ?? pkg.beneficialUseDate ?? today;

      /* ---- the hand-over itself ---- */
      // Full rows, not the trimmed projection `readiness.systems` carries:
      // the handover writes warranty and completion dates back onto them.
      const systems = await loadSystems(packageSystemIds(pkg), req.projectId!);
      const systemAssetIds = systems
        .map((s) => s.assetId)
        .filter((a): a is string => typeof a === "string");
      const assetIdSet = uniq([...pkg.assetIds, ...systemAssetIds, ...(body.assetIds ?? [])]);
      const handoverReasons: string[] = [];
      const linkedAssets: string[] = [];
      const createdLinks: { assetId: string; globalId: string }[] = [];
      const createdWarranties: string[] = [];

      const systemsWithoutAsset = systems.filter((s) => !s.assetId);
      if (systemsWithoutAsset.length > 0) {
        handoverReasons.push(
          `${systemsWithoutAsset.length} system(s) in this package carry no twin asset and so linked nothing: ${systemsWithoutAsset
            .map((s) => s.systemCode)
            .join(", ")}. Register them in the asset register (POST /projects/:projectId/assets) and bind them with PATCH on the system before handover if they are operable plant.`,
        );
      }
      if (!body.cobieFileId) {
        handoverReasons.push(
          "No COBie export file was recorded against this package. The twin can produce one at GET /projects/:projectId/cobie.csv (or .json), but until a file id is stored here the package does not evidence WHICH export the owner received.",
        );
      }

      const assetRows = assetIdSet.length
        ? await app.db
            .select()
            .from(assets)
            .where(
              and(eq(assets.projectId, req.projectId!), inArray(assets.id, assetIdSet)),
            )
        : [];
      const foundAssetIds = new Set(assetRows.map((a) => a.id));
      const unknownAssets = assetIdSet.filter((id) => !foundAssetIds.has(id));
      if (unknownAssets.length > 0) {
        throw badRequest(
          `Asset(s) not found in this project's twin register: ${unknownAssets.join(", ")}. Handover writes INTO the register; it cannot invent rows in it.`,
        );
      }

      /*
       * THE HAND-OVER IS ONE ACT.
       *
       * Assets move to operational, their IFC GUIDs are bound, warranty rows
       * are created, the package is stamped and every system in it is turned
       * over. Before this transaction those writes ran in sequence, so a
       * failure halfway through left assets marked operational under a package
       * that had never been accepted — an owner's asset register saying the
       * building was handed over when it was not, and nothing to retry safely.
       * Ledger appends are collected and written AFTER the commit, so the chain
       * never records a hand-over that was rolled back.
       */
      interface PendingEntry {
        action: "create" | "update" | "state_change";
        objectType: "asset" | "asset_element_link" | "warranty" | "commissioning_system";
        objectId: string;
        payload: Record<string, unknown>;
        storePayload?: boolean;
      }
      const pending: PendingEntry[] = [];

      const ifcGlobalIds = await app.db.transaction(async (tx) => {
        for (const asset of assetRows) {
          const fromIdx = ASSET_LIFECYCLE.indexOf(asset.status as (typeof ASSET_LIFECYCLE)[number]);
          const toIdx = ASSET_LIFECYCLE.indexOf("operational");
          const nextStatus = toIdx > fromIdx ? "operational" : asset.status;
          await tx
            .update(assets)
            .set({
              status: nextStatus,
              commissionedAt: asset.commissionedAt ?? today,
              warrantyStart: asset.warrantyStart ?? warrantyStartDate,
              updatedAt: at,
            })
            .where(eq(assets.id, asset.id));
          linkedAssets.push(asset.id);
          pending.push({
            action: "state_change",
            objectType: "asset",
            objectId: asset.id,
            payload: {
              from: asset.status,
              to: nextStatus,
              handedOverBy: pkg.reference,
              turnoverPackageId: packageId,
              warrantyStart: asset.warrantyStart ?? warrantyStartDate,
            },
            storePayload: true,
          });
        }

        // IFC bindings: each system's GUIDs belong to that system's asset.
        const guidPairs: { assetId: string; globalId: string }[] = [];
        for (const system of systems) {
          if (!system.assetId) continue;
          for (const globalId of system.ifcGlobalIds) {
            guidPairs.push({ assetId: system.assetId, globalId });
          }
        }
        // Anything the caller passed explicitly binds to the package's primary asset.
        const primaryAssetId = systemAssetIds[0] ?? assetIdSet[0] ?? null;
        for (const globalId of body.ifcGlobalIds ?? []) {
          if (primaryAssetId) guidPairs.push({ assetId: primaryAssetId, globalId });
        }
        if ((body.ifcGlobalIds ?? []).length > 0 && !primaryAssetId) {
          handoverReasons.push(
            "IFC GUIDs were supplied but the package has no asset to bind them to, so no element links were created.",
          );
        }
        for (const pair of uniq(guidPairs.map((p) => `${p.assetId}::${p.globalId}`))) {
          const [assetId, globalId] = pair.split("::") as [string, string];
          const existing = await tx
            .select({ id: assetElementLinks.id })
            .from(assetElementLinks)
            .where(
              and(eq(assetElementLinks.assetId, assetId), eq(assetElementLinks.globalId, globalId)),
            )
            .limit(1);
          if (existing[0]) continue;
          const linkId = newId("ael");
          await tx.insert(assetElementLinks).values({
            id: linkId,
            assetId,
            projectId: req.projectId!,
            globalId,
          });
          createdLinks.push({ assetId, globalId });
          pending.push({
            action: "create",
            objectType: "asset_element_link",
            objectId: linkId,
            payload: { assetId, globalId, turnoverPackageId: packageId },
          });
        }

        // Warranties are only created where the platform actually holds the
        // dates and the provider — never invented from a default period.
        if (warrantyEndDate && (body.warrantyProvider || pkg.vendorId)) {
          for (const assetId of linkedAssets) {
            const warrantyId = newId("wty");
            await tx.insert(warranties).values({
              id: warrantyId,
              companyId: req.companyId!,
              projectId: req.projectId!,
              assetId,
              provider: body.warrantyProvider ?? pkg.vendorId!,
              description: `Warranty handed over under turnover package ${pkg.reference}`,
              startDate: warrantyStartDate,
              endDate: warrantyEndDate,
            });
            createdWarranties.push(warrantyId);
            pending.push({
              action: "create",
              objectType: "warranty",
              objectId: warrantyId,
              payload: { assetId, startDate: warrantyStartDate, endDate: warrantyEndDate },
            });
          }
        } else {
          handoverReasons.push(
            warrantyEndDate
              ? "No warranty provider is recorded on the package or the accepting call, so no warranty rows were created in the twin."
              : "No warranty end date is recorded, so no warranty rows were created in the twin — a warranty with an invented expiry is worse than none.",
          );
        }

        const allGuids = uniq([...pkg.ifcGlobalIds, ...guidPairs.map((p) => p.globalId)]);
        await tx
          .update(turnoverPackages)
          .set({
            status: "handed_over",
            acceptedBy: req.user!.id,
            acceptedAt: at,
            handedOverAt: at,
            assetHandoverCompletedAt: at,
            assetIds: linkedAssets,
            assetCount: linkedAssets.length,
            ifcGlobalIds: allGuids,
            cobieFileId: body.cobieFileId ?? pkg.cobieFileId,
            warrantyIds: uniq([...pkg.warrantyIds, ...createdWarranties]),
            warrantyStartDate,
            warrantyEndDate,
            beneficialUseDate,
            requiredArtefactCount: readiness.artefacts.requiredArtefactCount,
            presentArtefactCount: readiness.artefacts.presentArtefactCount,
            openPunchItemCount: readiness.openPunchItems.length,
            openNcrCount: readiness.openNcrs.length,
            updatedAt: at,
          })
          .where(eq(turnoverPackages.id, packageId));

        for (const system of systems) {
          await tx
            .update(commissioningSystems)
            .set({
              status: "turned_over",
              turnoverPackageId: packageId,
              warrantyStartDate: system.warrantyStartDate ?? warrantyStartDate,
              beneficialUseDate: system.beneficialUseDate ?? beneficialUseDate,
              actualCompletionDate: system.actualCompletionDate ?? today,
              percentComplete: 100,
              updatedAt: at,
            })
            .where(eq(commissioningSystems.id, system.id));
          pending.push({
            action: "state_change",
            objectType: "commissioning_system",
            objectId: system.id,
            payload: { from: system.status, to: "turned_over", turnoverPackageId: packageId },
          });
        }
        return allGuids;
      });

      for (const entry of pending) {
        await ledger(app.db, {
          companyId: req.companyId!,
          projectId: req.projectId!,
          actorId: req.user!.id,
          action: entry.action,
          objectType: entry.objectType,
          objectId: entry.objectId,
          payload: entry.payload,
          storePayload: entry.storePayload,
        });
      }

      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "turnover_package",
        objectId: packageId,
        payload: {
          from: pkg.status,
          to: "handed_over",
          acceptedBy: req.user!.id,
          submittedBy: pkg.submittedBy,
          assetIds: linkedAssets,
          ifcGlobalIds,
          elementLinksCreated: createdLinks,
          warrantiesCreated: createdWarranties,
          cobieFileId: body.cobieFileId ?? pkg.cobieFileId,
          warrantyStartDate,
          warrantyEndDate,
          beneficialUseDate,
          artefacts: readiness.artefacts,
          outstandingAccepted: readiness.outstanding,
          acknowledged: body.acceptOutstanding === true,
          note: body.note ?? null,
        },
        storePayload: true,
      });

      const updated = await fetchPackage(packageId, req.companyId!, req.projectId!);
      return {
        ...updated,
        artefacts: artefactGap(updated.contents),
        handover: {
          assetIds: linkedAssets,
          assetCount: linkedAssets.length,
          elementLinksCreated: createdLinks,
          warrantyIds: createdWarranties,
          cobieFileId: updated.cobieFileId,
          handedOverAt: updated.handedOverAt,
          warrantyStartDate: updated.warrantyStartDate,
          systemsTurnedOver: systems.map((s) => s.systemCode),
          reasons: handoverReasons,
        },
        outstandingAccepted: readiness.outstanding,
      };
    },
  );

  /** Every package's gap in one list — the handover dashboard's whole payload. */
  app.get(
    "/projects/:projectId/turnover-packages-summary",
    { preHandler: readGate },
    async (req) => {
      await sweepQuality(app.db, req.companyId!, req.projectId!, req.user!.id);
      const rows = await app.db
        .select()
        .from(turnoverPackages)
        .where(
          and(
            eq(turnoverPackages.companyId, req.companyId!),
            eq(turnoverPackages.projectId, req.projectId!),
          ),
        )
        .orderBy(asc(turnoverPackages.number));
      const items = [];
      let totalRequired = 0;
      let totalPresent = 0;
      for (const pkg of rows) {
        const gap = artefactGap(pkg.contents);
        totalRequired += gap.requiredArtefactCount;
        totalPresent += gap.presentArtefactCount;
        items.push({
          id: pkg.id,
          reference: pkg.reference,
          name: pkg.name,
          status: pkg.status,
          strictness: strictnessOf(pkg.detail),
          ...gap,
          openPunchItemCount: pkg.openPunchItemCount,
          openNcrCount: pkg.openNcrCount,
          handedOverAt: pkg.handedOverAt,
        });
      }
      return {
        items,
        totals: {
          packages: rows.length,
          requiredArtefactCount: totalRequired,
          presentArtefactCount: totalPresent,
          gap: totalRequired - totalPresent,
          completeness:
            totalRequired > 0
              ? {
                  value: Math.round((totalPresent / totalRequired) * 10_000) / 100,
                  unit: "percent",
                  inputs: { totalRequired, totalPresent },
                  reasons: [],
                }
              : {
                  value: null,
                  unit: "percent",
                  inputs: { totalRequired, totalPresent },
                  reasons: [
                    "No turnover package on this project declares a required artefact, so there is no denominator and no completeness figure to report.",
                  ],
                },
        },
      };
    },
  );
};
