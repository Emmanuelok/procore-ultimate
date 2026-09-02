/**
 * DESIGN PACKAGES, STAGE GATES AND FREEZES
 * (spec Vol I #253; Vol II T #886, #888–#889, #896).
 *
 * A package is the unit that is issued, reviewed, approved, frozen and handed
 * over. Stage gates are the project's plan against the canonical stage
 * library; freezes are what makes "post-freeze change" a fact rather than an
 * opinion.
 *
 * Rules enforced here:
 *  - a package is approved by someone other than whoever created it;
 *  - a gate cannot be signed off while a criterion is unmet, and the refusal
 *    names the criteria;
 *  - lifting a freeze is a distinct, ledgered act — a freeze is never deleted.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import {
  designChangeNotices,
  designDeliverables,
  designFreezes,
  designIssues,
  designPackages,
  designReviews,
  designStageGates,
} from "@constructos/db";
import {
  DESIGN_DISCIPLINES,
  DESIGN_PACKAGE_STATUSES,
  DESIGN_STAGE_FRAMEWORKS,
  DESIGN_STAGE_KEYS,
  DCN_AUTHORISATION_LEVELS,
} from "@constructos/shared";
import { badRequest, conflict, forbidden, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { gateBlockers, outOfOrderStages, stageLabel, stageLibrary } from "../engines/stages.js";
import { computeReadiness } from "../service.js";
import {
  allocateReference,
  assertConsultant,
  assertUser,
  assertVendor,
  buildGates,
  idSchema,
  isoDateSchema,
  isoTimestampSchema,
  ledger,
  nowISO,
  patchSchemaOf,
  patchSet,
} from "../shared.js";

const packageBodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(8000).nullable().optional(),
  discipline: z.enum(DESIGN_DISCIPLINES).default("multi_discipline"),
  stageKey: z.enum(DESIGN_STAGE_KEYS).nullable().optional(),
  leadVendorId: idSchema.nullable().optional(),
  leadUserId: idSchema.nullable().optional(),
  consultantId: idSchema.nullable().optional(),
  plannedIssueDate: isoDateSchema.nullable().optional(),
  plannedApprovalDate: isoDateSchema.nullable().optional(),
  revision: z.string().max(20).nullable().optional(),
  notes: z.string().max(8000).nullable().optional(),
});

const packagePatchSchema = patchSchemaOf(packageBodySchema);

const packageListSchema = pageQuerySchema.extend({
  status: z.enum(DESIGN_PACKAGE_STATUSES).optional(),
  discipline: z.enum(DESIGN_DISCIPLINES).optional(),
  stageKey: z.enum(DESIGN_STAGE_KEYS).optional(),
  q: z.string().max(120).optional(),
});

const gateBodySchema = z.object({
  stageKey: z.enum(DESIGN_STAGE_KEYS),
  framework: z.enum(DESIGN_STAGE_FRAMEWORKS).default("riba_2020"),
  label: z.string().max(120).nullable().optional(),
  plannedStart: isoDateSchema.nullable().optional(),
  plannedEnd: isoDateSchema.nullable().optional(),
  actualStart: isoDateSchema.nullable().optional(),
  actualEnd: isoDateSchema.nullable().optional(),
  criteria: z
    .array(
      z.object({
        key: z.string().min(1).max(60),
        label: z.string().min(1).max(200),
        met: z.boolean().default(false),
        note: z.string().max(2000).optional(),
      }),
    )
    .max(50)
    .default([]),
});

const gatePatchSchema = patchSchemaOf(gateBodySchema.omit({ stageKey: true })).extend({
  status: z.enum(["planned", "open"]).optional(),
});

const freezeBodySchema = z.object({
  scope: z.enum(["project", "stage", "package"]).default("package"),
  packageId: idSchema.nullable().optional(),
  stageKey: z.enum(DESIGN_STAGE_KEYS).nullable().optional(),
  title: z.string().min(1).max(200),
  reason: z.string().max(4000).nullable().optional(),
  effectiveFrom: isoTimestampSchema.optional(),
  requiredAuthorisation: z.enum(DCN_AUTHORISATION_LEVELS).default("client"),
});

export const packageRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate, adminGate } = buildGates(app);

  async function loadPackage(companyId: string, projectId: string, id: string) {
    const [row] = await app.db
      .select()
      .from(designPackages)
      .where(
        and(
          eq(designPackages.id, id),
          eq(designPackages.companyId, companyId),
          eq(designPackages.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Design package not found");
    return row;
  }

  async function validateRefs(
    companyId: string,
    projectId: string,
    body: Partial<z.infer<typeof packageBodySchema>>,
  ) {
    if (body.leadVendorId) await assertVendor(app.db, companyId, body.leadVendorId);
    if (body.leadUserId) await assertUser(app.db, body.leadUserId);
    if (body.consultantId) await assertConsultant(app.db, companyId, projectId, body.consultantId);
  }

  /* ---------------------------------------------------------------- */
  /* Stage library and gates                                          */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/design/stages", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = z.object({ framework: z.enum(DESIGN_STAGE_FRAMEWORKS).default("riba_2020") }).parse(req.query);
    const gates = await app.db
      .select()
      .from(designStageGates)
      .where(and(eq(designStageGates.companyId, req.companyId!), eq(designStageGates.projectId, projectId)))
      .orderBy(asc(designStageGates.stageKey));
    const packages = await app.db
      .select({ stageKey: designPackages.stageKey, status: designPackages.status })
      .from(designPackages)
      .where(and(eq(designPackages.companyId, req.companyId!), eq(designPackages.projectId, projectId)));
    const counts: Record<string, { total: number; approved: number }> = {};
    for (const p of packages) {
      if (!p.stageKey) continue;
      const bucket = (counts[p.stageKey] ??= { total: 0, approved: 0 });
      bucket.total += 1;
      if (p.status === "approved" || p.status === "frozen") bucket.approved += 1;
    }
    return {
      framework: q.framework,
      library: stageLibrary(q.framework),
      gates: gates.map((g) => ({
        ...g,
        criteria: g.criteria ?? [],
        blockers: gateBlockers(g.criteria ?? []),
        displayLabel: g.label ?? stageLabel(g.stageKey, q.framework),
        packages: counts[g.stageKey] ?? { total: 0, approved: 0 },
      })),
      outOfOrder: outOfOrderStages(gates.map((g) => ({ stageKey: g.stageKey, status: g.status }))),
    };
  });

  app.post("/projects/:projectId/design/stages", { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = gateBodySchema.parse(req.body);
    const companyId = req.companyId!;
    const [existing] = await app.db
      .select({ id: designStageGates.id })
      .from(designStageGates)
      .where(
        and(
          eq(designStageGates.companyId, companyId),
          eq(designStageGates.projectId, projectId),
          eq(designStageGates.stageKey, body.stageKey),
        ),
      )
      .limit(1);
    if (existing) throw conflict(`Stage ${body.stageKey} already has a gate on this project.`);
    const id = newId("dsg");
    const [inserted] = await app.db
      .insert(designStageGates)
      .values({
        id,
        companyId,
        projectId,
        stageKey: body.stageKey,
        framework: body.framework,
        label: body.label ?? null,
        plannedStart: body.plannedStart ?? null,
        plannedEnd: body.plannedEnd ?? null,
        actualStart: body.actualStart ?? null,
        actualEnd: body.actualEnd ?? null,
        criteria: body.criteria,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "design_stage_gate",
      objectId: id,
      payload: { stageKey: body.stageKey, framework: body.framework },
    });
    return reply.code(201).send(inserted);
  });

  app.patch("/projects/:projectId/design/stages/:gateId", { preHandler: standardGate }, async (req) => {
    const { projectId, gateId } = req.params as { projectId: string; gateId: string };
    const body = gatePatchSchema.parse(req.body);
    const companyId = req.companyId!;
    const [row] = await app.db
      .select()
      .from(designStageGates)
      .where(
        and(
          eq(designStageGates.id, gateId),
          eq(designStageGates.companyId, companyId),
          eq(designStageGates.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Stage gate not found");
    if (row.status === "signed_off") {
      throw conflict("This gate is signed off. Reopen it deliberately rather than editing a signed-off record.");
    }
    const set = patchSet(body as Record<string, unknown>, [
      "framework",
      "label",
      "plannedStart",
      "plannedEnd",
      "actualStart",
      "actualEnd",
      "criteria",
      "status",
    ]);
    const [updated] = await app.db
      .update(designStageGates)
      .set(set)
      .where(eq(designStageGates.id, gateId))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "design_stage_gate",
      objectId: gateId,
      payload: { keys: Object.keys(set).filter((k) => k !== "updatedAt") },
    });
    return updated;
  });

  app.post("/projects/:projectId/design/stages/:gateId/sign-off", { preHandler: adminGate }, async (req) => {
    const { projectId, gateId } = req.params as { projectId: string; gateId: string };
    const body = z
      .object({ notes: z.string().max(4000).optional(), force: z.boolean().default(false) })
      .parse(req.body ?? {});
    const companyId = req.companyId!;
    const [row] = await app.db
      .select()
      .from(designStageGates)
      .where(
        and(
          eq(designStageGates.id, gateId),
          eq(designStageGates.companyId, companyId),
          eq(designStageGates.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Stage gate not found");
    if (row.status === "signed_off") throw conflict("This gate is already signed off.");
    const blockers = gateBlockers(row.criteria ?? []);
    if (blockers.length > 0 && !body.force) {
      throw badRequest(
        `The gate cannot be signed off while ${blockers.length} criterion/criteria are unmet: ${blockers.join("; ")}.`,
        { blockers },
      );
    }
    const [updated] = await app.db
      .update(designStageGates)
      .set({
        status: "signed_off",
        signedOffBy: req.user!.id,
        signedOffAt: nowISO(),
        signOffNotes: body.notes ?? null,
        actualEnd: row.actualEnd ?? new Date().toISOString().slice(0, 10),
        updatedAt: nowISO(),
      })
      .where(eq(designStageGates.id, gateId))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_stage_gate",
      objectId: gateId,
      payload: { to: "signed_off", stageKey: row.stageKey, forced: body.force, unmetCriteria: blockers },
    });
    return { ...updated, blockersOverridden: body.force ? blockers : [] };
  });

  app.post("/projects/:projectId/design/stages/:gateId/reject", { preHandler: adminGate }, async (req) => {
    const { projectId, gateId } = req.params as { projectId: string; gateId: string };
    const body = z.object({ reason: z.string().min(1).max(4000) }).parse(req.body);
    const companyId = req.companyId!;
    const [row] = await app.db
      .select()
      .from(designStageGates)
      .where(
        and(
          eq(designStageGates.id, gateId),
          eq(designStageGates.companyId, companyId),
          eq(designStageGates.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Stage gate not found");
    const [updated] = await app.db
      .update(designStageGates)
      .set({ status: "rejected", rejectedReason: body.reason, updatedAt: nowISO() })
      .where(eq(designStageGates.id, gateId))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_stage_gate",
      objectId: gateId,
      payload: { to: "rejected", reason: body.reason },
    });
    return updated;
  });

  /* ---------------------------------------------------------------- */
  /* Packages                                                         */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/design/packages", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = packageListSchema.parse(req.query);
    const where = and(
      eq(designPackages.companyId, req.companyId!),
      eq(designPackages.projectId, projectId),
      q.status ? eq(designPackages.status, q.status) : undefined,
      q.discipline ? eq(designPackages.discipline, q.discipline) : undefined,
      q.stageKey ? eq(designPackages.stageKey, q.stageKey) : undefined,
      q.q
        ? or(ilike(designPackages.name, `%${q.q}%`), ilike(designPackages.reference, `%${q.q}%`))
        : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db
        .select()
        .from(designPackages)
        .where(where)
        .orderBy(asc(designPackages.number))
        .limit(q.pageSize)
        .offset(pageOffset(q)),
      app.db.select({ n: count() }).from(designPackages).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post("/projects/:projectId/design/packages", { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = packageBodySchema.parse(req.body);
    const companyId = req.companyId!;
    await validateRefs(companyId, projectId, body);
    const { number, reference } = await allocateReference(app.db, projectId, "design_package", "DP");
    const id = newId("dpk");
    const [inserted] = await app.db
      .insert(designPackages)
      .values({
        id,
        companyId,
        projectId,
        number,
        reference,
        name: body.name,
        description: body.description ?? null,
        discipline: body.discipline,
        stageKey: body.stageKey ?? null,
        leadVendorId: body.leadVendorId ?? null,
        leadUserId: body.leadUserId ?? null,
        consultantId: body.consultantId ?? null,
        plannedIssueDate: body.plannedIssueDate ?? null,
        plannedApprovalDate: body.plannedApprovalDate ?? null,
        revision: body.revision ?? null,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "design_package",
      objectId: id,
      payload: { reference, name: body.name, discipline: body.discipline, stageKey: body.stageKey ?? null },
    });
    return reply.code(201).send(inserted);
  });

  app.get("/projects/:projectId/design/packages/:packageId", { preHandler: readGate }, async (req) => {
    const { projectId, packageId } = req.params as { projectId: string; packageId: string };
    const companyId = req.companyId!;
    const row = await loadPackage(companyId, projectId, packageId);
    const [reviews, issues, deliverables, notices, freezes] = await Promise.all([
      app.db
        .select()
        .from(designReviews)
        .where(and(eq(designReviews.projectId, projectId), eq(designReviews.packageId, packageId)))
        .orderBy(desc(designReviews.cycleNumber)),
      app.db
        .select()
        .from(designIssues)
        .where(and(eq(designIssues.projectId, projectId), eq(designIssues.packageId, packageId)))
        .orderBy(desc(designIssues.createdAt))
        .limit(200),
      app.db
        .select()
        .from(designDeliverables)
        .where(and(eq(designDeliverables.projectId, projectId), eq(designDeliverables.packageId, packageId)))
        .orderBy(asc(designDeliverables.plannedIssueDate))
        .limit(200),
      app.db
        .select()
        .from(designChangeNotices)
        .where(and(eq(designChangeNotices.projectId, projectId), eq(designChangeNotices.packageId, packageId)))
        .orderBy(desc(designChangeNotices.createdAt))
        .limit(200),
      app.db
        .select()
        .from(designFreezes)
        .where(
          and(
            eq(designFreezes.projectId, projectId),
            or(eq(designFreezes.packageId, packageId), eq(designFreezes.scope, "project")),
          ),
        )
        .orderBy(desc(designFreezes.effectiveFrom)),
    ]);
    const readiness = await computeReadiness(app.db, companyId, projectId, packageId, req.user!.id, {
      persist: false,
    });
    return { ...row, reviews, issues, deliverables, changeNotices: notices, freezes, readiness };
  });

  app.patch("/projects/:projectId/design/packages/:packageId", { preHandler: standardGate }, async (req) => {
    const { projectId, packageId } = req.params as { projectId: string; packageId: string };
    const body = packagePatchSchema.parse(req.body);
    const companyId = req.companyId!;
    const row = await loadPackage(companyId, projectId, packageId);
    if (row.status === "approved" || row.status === "frozen") {
      throw conflict(
        `${row.reference} is ${row.status}. Raise a design change notice rather than editing an approved package in place.`,
      );
    }
    await validateRefs(companyId, projectId, body);
    const set = patchSet(body as Record<string, unknown>, [
      "name",
      "description",
      "discipline",
      "stageKey",
      "leadVendorId",
      "leadUserId",
      "consultantId",
      "plannedIssueDate",
      "plannedApprovalDate",
      "revision",
      "notes",
    ]);
    const [updated] = await app.db
      .update(designPackages)
      .set(set)
      .where(eq(designPackages.id, packageId))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "design_package",
      objectId: packageId,
      payload: { keys: Object.keys(set).filter((k) => k !== "updatedAt") },
    });
    return updated;
  });

  /** Transition a package. Approval requires a different actor from the creator. */
  app.post("/projects/:projectId/design/packages/:packageId/transition", { preHandler: standardGate }, async (req) => {
    const { projectId, packageId } = req.params as { projectId: string; packageId: string };
    const body = z
      .object({
        to: z.enum(DESIGN_PACKAGE_STATUSES),
        note: z.string().max(4000).optional(),
        actualIssueDate: isoDateSchema.optional(),
        revision: z.string().max(20).optional(),
      })
      .parse(req.body);
    const companyId = req.companyId!;
    const row = await loadPackage(companyId, projectId, packageId);

    const allowed: Record<string, readonly string[]> = {
      planned: ["in_progress", "cancelled"],
      in_progress: ["in_review", "planned", "cancelled"],
      in_review: ["approved", "in_progress", "cancelled"],
      approved: ["frozen", "superseded", "in_progress"],
      frozen: ["superseded"],
      superseded: [],
      cancelled: [],
    };
    if (!(allowed[row.status] ?? []).includes(body.to)) {
      throw badRequest(
        `A design package cannot move from ${row.status} to ${body.to}. Allowed from ${row.status}: ${(allowed[row.status] ?? []).join(", ") || "nothing — this is a terminal state"}.`,
      );
    }
    if (body.to === "approved") {
      if (row.createdBy === req.user!.id) {
        throw forbidden(
          "A design package must be approved by someone other than the person who raised it. Segregation of duties is not optional on the record that fixes what will be built.",
        );
      }
    }
    if (body.to === "frozen") {
      throw badRequest(
        "Freeze a package by declaring a design freeze (POST /design/freezes with scope=package), not by transitioning it — a freeze carries its effective date and the authorisation it demands.",
      );
    }

    const set: Record<string, unknown> = { status: body.to, updatedAt: nowISO() };
    if (body.actualIssueDate) set["actualIssueDate"] = body.actualIssueDate;
    if (body.revision) set["revision"] = body.revision;
    if (body.to === "approved") {
      set["approvedAt"] = nowISO();
      set["approvedBy"] = req.user!.id;
    }
    if (body.to === "in_progress" && row.status === "approved") {
      // reopening clears the approval: never keep an approval on changed content
      set["approvedAt"] = null;
      set["approvedBy"] = null;
    }
    const [updated] = await app.db
      .update(designPackages)
      .set(set)
      .where(eq(designPackages.id, packageId))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_package",
      objectId: packageId,
      payload: { from: row.status, to: body.to, note: body.note ?? null },
    });
    return updated;
  });

  /* ---------------------------------------------------------------- */
  /* Freezes                                                          */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/design/freezes", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema.extend({ status: z.enum(["active", "lifted"]).optional() }).parse(req.query);
    const where = and(
      eq(designFreezes.companyId, req.companyId!),
      eq(designFreezes.projectId, projectId),
      q.status ? eq(designFreezes.status, q.status) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db
        .select()
        .from(designFreezes)
        .where(where)
        .orderBy(desc(designFreezes.effectiveFrom))
        .limit(q.pageSize)
        .offset(pageOffset(q)),
      app.db.select({ n: count() }).from(designFreezes).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post("/projects/:projectId/design/freezes", { preHandler: adminGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = freezeBodySchema.parse(req.body);
    const companyId = req.companyId!;
    if (body.scope === "package" && !body.packageId) {
      throw badRequest("A package freeze needs packageId: a freeze that names nothing fixes nothing.");
    }
    if (body.scope === "stage" && !body.stageKey) throw badRequest("A stage freeze needs stageKey.");
    if (body.packageId) await loadPackage(companyId, projectId, body.packageId);

    const existing = await app.db
      .select({ id: designFreezes.id })
      .from(designFreezes)
      .where(
        and(
          eq(designFreezes.companyId, companyId),
          eq(designFreezes.projectId, projectId),
          eq(designFreezes.status, "active"),
          eq(designFreezes.scope, body.scope),
          body.packageId ? eq(designFreezes.packageId, body.packageId) : undefined,
          body.stageKey ? eq(designFreezes.stageKey, body.stageKey) : undefined,
        ),
      )
      .limit(1);
    if (existing[0]) {
      throw conflict("An active freeze already covers this scope. Lift it before declaring another.");
    }

    const id = newId("dfz");
    const effectiveFrom = body.effectiveFrom ?? nowISO();
    const [inserted] = await app.db
      .insert(designFreezes)
      .values({
        id,
        companyId,
        projectId,
        scope: body.scope,
        packageId: body.packageId ?? null,
        stageKey: body.stageKey ?? null,
        title: body.title,
        reason: body.reason ?? null,
        effectiveFrom,
        requiredAuthorisation: body.requiredAuthorisation,
        declaredBy: req.user!.id,
      })
      .returning();
    if (body.scope === "package" && body.packageId) {
      await app.db
        .update(designPackages)
        .set({ frozenAt: effectiveFrom, frozenBy: req.user!.id, freezeId: id, status: "frozen", updatedAt: nowISO() })
        .where(eq(designPackages.id, body.packageId));
    }
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "design_freeze",
      objectId: id,
      payload: { scope: body.scope, packageId: body.packageId ?? null, stageKey: body.stageKey ?? null, effectiveFrom },
    });
    return reply.code(201).send(inserted);
  });

  app.post("/projects/:projectId/design/freezes/:freezeId/lift", { preHandler: adminGate }, async (req) => {
    const { projectId, freezeId } = req.params as { projectId: string; freezeId: string };
    const body = z.object({ reason: z.string().min(1).max(4000) }).parse(req.body);
    const companyId = req.companyId!;
    const [row] = await app.db
      .select()
      .from(designFreezes)
      .where(
        and(
          eq(designFreezes.id, freezeId),
          eq(designFreezes.companyId, companyId),
          eq(designFreezes.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Design freeze not found");
    if (row.status === "lifted") throw conflict("This freeze has already been lifted.");
    const [updated] = await app.db
      .update(designFreezes)
      .set({ status: "lifted", liftedBy: req.user!.id, liftedAt: nowISO(), liftReason: body.reason, updatedAt: nowISO() })
      .where(eq(designFreezes.id, freezeId))
      .returning();
    if (row.packageId) {
      const [pkg] = await app.db
        .select()
        .from(designPackages)
        .where(eq(designPackages.id, row.packageId))
        .limit(1);
      if (pkg && pkg.freezeId === freezeId) {
        await app.db
          .update(designPackages)
          .set({ frozenAt: null, frozenBy: null, freezeId: null, status: pkg.status === "frozen" ? "approved" : pkg.status, updatedAt: nowISO() })
          .where(eq(designPackages.id, row.packageId));
      }
    }
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_freeze",
      objectId: freezeId,
      payload: { to: "lifted", reason: body.reason },
    });
    return updated;
  });

  /** Statuses used by the workspace filters, so the client never hard-codes them. */
  app.get("/projects/:projectId/design/packages/:packageId/history", { preHandler: readGate }, async (req) => {
    const { projectId, packageId } = req.params as { projectId: string; packageId: string };
    const companyId = req.companyId!;
    await loadPackage(companyId, projectId, packageId);
    const reviews = await app.db
      .select({
        id: designReviews.id,
        reference: designReviews.reference,
        cycleNumber: designReviews.cycleNumber,
        issuedAt: designReviews.issuedAt,
        closedAt: designReviews.closedAt,
        consolidatedCode: designReviews.consolidatedCode,
        status: designReviews.status,
        turnaroundDays: designReviews.turnaroundDays,
      })
      .from(designReviews)
      .where(and(eq(designReviews.projectId, projectId), eq(designReviews.packageId, packageId)))
      .orderBy(asc(designReviews.cycleNumber));
    const notices = await app.db
      .select({
        id: designChangeNotices.id,
        reference: designChangeNotices.reference,
        title: designChangeNotices.title,
        status: designChangeNotices.status,
        classification: designChangeNotices.classification,
        isPostFreeze: designChangeNotices.isPostFreeze,
        submittedAt: designChangeNotices.submittedAt,
      })
      .from(designChangeNotices)
      .where(and(eq(designChangeNotices.projectId, projectId), eq(designChangeNotices.packageId, packageId)))
      .orderBy(asc(designChangeNotices.number));
    return { reviews, changeNotices: notices };
  });

  /* A tiny helper endpoint the workspace uses to resolve ids to names. */
  app.get("/projects/:projectId/design/packages-lookup", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const rows = await app.db
      .select({
        id: designPackages.id,
        reference: designPackages.reference,
        name: designPackages.name,
        discipline: designPackages.discipline,
        status: designPackages.status,
        stageKey: designPackages.stageKey,
      })
      .from(designPackages)
      .where(and(eq(designPackages.companyId, req.companyId!), eq(designPackages.projectId, projectId)))
      .orderBy(asc(designPackages.number))
      .limit(500);
    return { items: rows, total: rows.length };
  });

};
