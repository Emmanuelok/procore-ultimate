/**
 * SITE ACCESS — inductions, passes, the gate feed, the live on-site register
 * and musters (spec Vol II Z #1067–1069).
 *
 * The chain is deliberate: an induction is the fact that a person was told the
 * rules; a pass is the credential that fact justifies; a gate event is a read
 * of that credential; the register is the fold of those reads; a muster is the
 * register tested against a human headcount. Break any link and the platform
 * says so rather than papering over it.
 *
 * The gate feed is a machine endpoint: readers POST batches, events carry the
 * device's own reference so a replay is a no-op, and a read that should not
 * have been accepted is STORED AS REFUSED rather than dropped.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import {
  siteAccessPasses,
  siteGateEvents,
  siteInductions,
  siteMusterCheckins,
  siteMusters,
} from "@constructos/db";
import {
  SITE_CREDENTIAL_TYPES,
  SITE_GATE_DIRECTIONS,
  SITE_GATE_REFUSALS,
  SITE_GATE_SOURCES,
  SITE_INDUCTION_TYPES,
  SITE_MUSTER_KINDS,
  SITE_MUSTER_PERSON_STATUSES,
  SITE_PERSON_KINDS,
} from "@constructos/shared";
import { badRequest, conflict, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { dailyPresence } from "../engines/occupancy.js";
import {
  ingestGateEvents,
  loadGateEvents,
  loadRegister,
  personKeyOf,
  reconcileMusterRecord,
} from "../service.js";
import {
  allocateReference,
  assertVendor,
  assertWorker,
  buildGates,
  fileIdsSchema,
  idSchema,
  isoDateSchema,
  isoTimestampSchema,
  latSchema,
  ledger,
  lonSchema,
  nowISO,
  notFoundIfMissing,
  patchSchemaOf,
  patchSet,
  todayISO,
} from "../shared.js";

const inductionBody = z.object({
  workerId: idSchema.nullish(),
  personName: z.string().trim().min(1).max(200),
  personKind: z.enum(SITE_PERSON_KINDS).default("worker"),
  vendorId: idSchema.nullish(),
  inductionType: z.enum(SITE_INDUCTION_TYPES).default("general"),
  language: z.string().trim().max(40).nullish(),
  conductedByName: z.string().trim().max(200).nullish(),
  conductedAt: isoTimestampSchema.nullish(),
  validFrom: isoDateSchema.nullish(),
  validUntil: isoDateSchema.nullish(),
  topics: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  scorePercent: z.number().min(0).max(100).nullish(),
  passMark: z.number().min(0).max(100).nullish(),
  fileIds: fileIdsSchema.default([]),
  notes: z.string().max(4000).nullish(),
});

const passBody = z.object({
  inductionId: idSchema.nullish(),
  workerId: idSchema.nullish(),
  personName: z.string().trim().min(1).max(200),
  personKind: z.enum(SITE_PERSON_KINDS).default("worker"),
  vendorId: idSchema.nullish(),
  badgeCode: z.string().trim().min(1).max(64),
  credentialType: z.enum(SITE_CREDENTIAL_TYPES).default("badge"),
  validFrom: isoDateSchema.nullish(),
  validUntil: isoDateSchema.nullish(),
  zonesAllowed: z.array(idSchema).max(100).default([]),
  notes: z.string().max(4000).nullish(),
});

const gateEventBody = z.object({
  badgeCode: z.string().trim().min(1).max(64).nullish(),
  passId: idSchema.nullish(),
  workerId: idSchema.nullish(),
  personName: z.string().trim().max(200).nullish(),
  personKind: z.enum(SITE_PERSON_KINDS).nullish(),
  direction: z.enum(SITE_GATE_DIRECTIONS),
  occurredAt: isoTimestampSchema,
  gateName: z.string().trim().max(120).nullish(),
  deviceId: z.string().trim().max(120).nullish(),
  source: z.enum(SITE_GATE_SOURCES).default("turnstile"),
  accepted: z.boolean().optional(),
  refusalReason: z.enum(SITE_GATE_REFUSALS).nullish(),
  zoneId: idSchema.nullish(),
  lat: latSchema.nullish(),
  lon: lonSchema.nullish(),
  externalRef: z.string().trim().min(1).max(200).nullish(),
  raw: z.record(z.string(), z.unknown()).nullish(),
});

export const accessRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate, adminGate } = buildGates(app);
  const base = "/projects/:projectId/site";

  /* ---------------------------------------------------------------- */
  /* Inductions                                                        */
  /* ---------------------------------------------------------------- */

  app.get(`${base}/inductions`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({
        status: z.string().max(20).optional(),
        workerId: idSchema.optional(),
        vendorId: idSchema.optional(),
        expiringWithinDays: z.coerce.number().int().min(0).max(365).optional(),
      })
      .parse(req.query);
    const until =
      q.expiringWithinDays === undefined
        ? undefined
        : new Date(Date.now() + q.expiringWithinDays * 86_400_000).toISOString().slice(0, 10);
    const where = and(
      eq(siteInductions.companyId, req.companyId!),
      eq(siteInductions.projectId, projectId),
      q.status ? eq(siteInductions.status, q.status) : undefined,
      q.workerId ? eq(siteInductions.workerId, q.workerId) : undefined,
      q.vendorId ? eq(siteInductions.vendorId, q.vendorId) : undefined,
      until ? lte(siteInductions.validUntil, until) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(siteInductions).where(where).orderBy(desc(siteInductions.createdAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(siteInductions).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post(`${base}/inductions`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = inductionBody.parse(req.body);
    const companyId = req.companyId!;
    if (body.workerId) await assertWorker(app.db, projectId, body.workerId);
    if (body.vendorId) await assertVendor(app.db, companyId, body.vendorId);
    if (body.validFrom && body.validUntil && body.validUntil < body.validFrom) {
      throw badRequest("An induction cannot expire before it becomes valid.");
    }
    const conducted = body.conductedAt ?? nowISO();
    const passed =
      body.scorePercent === null || body.scorePercent === undefined || body.passMark === null || body.passMark === undefined
        ? true
        : body.scorePercent >= body.passMark;
    const id = newId("ind");
    const [row] = await app.db
      .insert(siteInductions)
      .values({
        id,
        companyId,
        projectId,
        workerId: body.workerId ?? null,
        personName: body.personName,
        personKind: body.personKind,
        vendorId: body.vendorId ?? null,
        inductionType: body.inductionType,
        language: body.language ?? null,
        conductedBy: req.user!.id,
        conductedByName: body.conductedByName ?? null,
        conductedAt: conducted,
        validFrom: body.validFrom ?? conducted.slice(0, 10),
        validUntil: body.validUntil ?? null,
        status: passed ? "valid" : "failed",
        topics: body.topics,
        scorePercent: body.scorePercent ?? null,
        passMark: body.passMark ?? null,
        fileIds: body.fileIds,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "site_induction",
      objectId: id,
      payload: { personName: body.personName, inductionType: body.inductionType, status: passed ? "valid" : "failed" },
    });
    return reply.code(201).send(row);
  });

  app.patch(`${base}/inductions/:id`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const body = patchSchemaOf(inductionBody).parse(req.body);
    const companyId = req.companyId!;
    const existing = notFoundIfMissing(
      (
        await app.db
          .select()
          .from(siteInductions)
          .where(and(eq(siteInductions.id, id), eq(siteInductions.companyId, companyId), eq(siteInductions.projectId, projectId)))
          .limit(1)
      )[0],
      "Induction",
    );
    if (existing.status === "revoked") {
      throw conflict("A revoked induction is a closed record and cannot be edited. Record a new induction instead.");
    }
    if (body.workerId) await assertWorker(app.db, projectId, body.workerId);
    if (body.vendorId) await assertVendor(app.db, companyId, body.vendorId);
    const set = patchSet(body as Record<string, unknown>, [
      "workerId",
      "personName",
      "personKind",
      "vendorId",
      "inductionType",
      "language",
      "conductedByName",
      "conductedAt",
      "validFrom",
      "validUntil",
      "topics",
      "scorePercent",
      "passMark",
      "fileIds",
      "notes",
    ]);
    const [row] = await app.db
      .update(siteInductions)
      .set(set)
      .where(and(eq(siteInductions.id, id), eq(siteInductions.companyId, companyId)))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "site_induction",
      objectId: id,
      payload: set,
    });
    return row;
  });

  app.post(`${base}/inductions/:id/revoke`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const { reason } = z.object({ reason: z.string().trim().min(1).max(1000) }).parse(req.body);
    const companyId = req.companyId!;
    const at = nowISO();
    const [row] = await app.db
      .update(siteInductions)
      .set({ status: "revoked", revokedAt: at, revokedBy: req.user!.id, revokeReason: reason, updatedAt: at })
      .where(
        and(
          eq(siteInductions.id, id),
          eq(siteInductions.companyId, companyId),
          eq(siteInductions.projectId, projectId),
          inArray(siteInductions.status, ["pending", "valid", "expired", "failed"]),
        ),
      )
      .returning();
    if (!row) throw notFound("Induction not found, or already revoked");
    // A revoked induction cannot leave an active pass standing on it.
    const suspended = await app.db
      .update(siteAccessPasses)
      .set({ status: "suspended", updatedAt: at })
      .where(and(eq(siteAccessPasses.companyId, companyId), eq(siteAccessPasses.inductionId, id), eq(siteAccessPasses.status, "active")))
      .returning({ id: siteAccessPasses.id });
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "site_induction",
      objectId: id,
      payload: { to: "revoked", reason, passesSuspended: suspended.map((p) => p.id) },
    });
    return { ...row, passesSuspended: suspended.length };
  });

  /* ---------------------------------------------------------------- */
  /* Passes                                                            */
  /* ---------------------------------------------------------------- */

  app.get(`${base}/passes`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({
        status: z.string().max(20).optional(),
        vendorId: idSchema.optional(),
        badgeCode: z.string().max(64).optional(),
      })
      .parse(req.query);
    const where = and(
      eq(siteAccessPasses.companyId, req.companyId!),
      eq(siteAccessPasses.projectId, projectId),
      q.status ? eq(siteAccessPasses.status, q.status) : undefined,
      q.vendorId ? eq(siteAccessPasses.vendorId, q.vendorId) : undefined,
      q.badgeCode ? eq(siteAccessPasses.badgeCode, q.badgeCode) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(siteAccessPasses).where(where).orderBy(desc(siteAccessPasses.createdAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(siteAccessPasses).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post(`${base}/passes`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = passBody.parse(req.body);
    const companyId = req.companyId!;
    if (body.workerId) await assertWorker(app.db, projectId, body.workerId);
    if (body.vendorId) await assertVendor(app.db, companyId, body.vendorId);

    if (body.inductionId) {
      const induction = (
        await app.db
          .select()
          .from(siteInductions)
          .where(and(eq(siteInductions.id, body.inductionId), eq(siteInductions.companyId, companyId), eq(siteInductions.projectId, projectId)))
          .limit(1)
      )[0];
      if (!induction) throw badRequest(`Induction ${body.inductionId} not found in this project.`);
      if (induction.status !== "valid") {
        throw badRequest(
          `Induction ${induction.id} is ${induction.status}, not valid. A site pass may not be issued on an induction that is not in force.`,
        );
      }
    }

    const clash = (
      await app.db
        .select({ id: siteAccessPasses.id, status: siteAccessPasses.status })
        .from(siteAccessPasses)
        .where(and(eq(siteAccessPasses.projectId, projectId), eq(siteAccessPasses.badgeCode, body.badgeCode)))
        .limit(1)
    )[0];
    if (clash) {
      throw conflict(
        `Badge ${body.badgeCode} is already issued on this project (pass ${clash.id}, ${clash.status}). Two people on one badge makes the register a fiction.`,
      );
    }

    const id = newId("pss");
    const at = nowISO();
    const [row] = await app.db
      .insert(siteAccessPasses)
      .values({
        id,
        companyId,
        projectId,
        inductionId: body.inductionId ?? null,
        workerId: body.workerId ?? null,
        personName: body.personName,
        personKind: body.personKind,
        vendorId: body.vendorId ?? null,
        badgeCode: body.badgeCode,
        credentialType: body.credentialType,
        status: "active",
        validFrom: body.validFrom ?? todayISO(),
        validUntil: body.validUntil ?? null,
        zonesAllowed: body.zonesAllowed,
        issuedBy: req.user!.id,
        issuedAt: at,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "site_access_pass",
      objectId: id,
      payload: { badgeCode: body.badgeCode, personName: body.personName, inductionId: body.inductionId ?? null },
    });
    return reply.code(201).send(row);
  });

  app.patch(`${base}/passes/:id`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const body = patchSchemaOf(passBody.omit({ badgeCode: true })).parse(req.body);
    const companyId = req.companyId!;
    notFoundIfMissing(
      (
        await app.db
          .select({ id: siteAccessPasses.id })
          .from(siteAccessPasses)
          .where(and(eq(siteAccessPasses.id, id), eq(siteAccessPasses.companyId, companyId), eq(siteAccessPasses.projectId, projectId)))
          .limit(1)
      )[0],
      "Pass",
    );
    if (body.vendorId) await assertVendor(app.db, companyId, body.vendorId);
    const set = patchSet(body as Record<string, unknown>, [
      "inductionId",
      "workerId",
      "personName",
      "personKind",
      "vendorId",
      "credentialType",
      "validFrom",
      "validUntil",
      "zonesAllowed",
      "notes",
    ]);
    const [row] = await app.db
      .update(siteAccessPasses)
      .set(set)
      .where(and(eq(siteAccessPasses.id, id), eq(siteAccessPasses.companyId, companyId)))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "site_access_pass",
      objectId: id,
      payload: set,
    });
    return row;
  });

  const passTransition = (action: "revoke" | "suspend" | "reinstate") =>
    app.post(`${base}/passes/:id/${action}`, { preHandler: standardGate }, async (req) => {
      const { projectId, id } = req.params as { projectId: string; id: string };
      const { reason } = z
        .object({ reason: z.string().trim().max(1000).optional() })
        .parse(req.body ?? {});
      if (action === "revoke" && !reason) throw badRequest("A revocation must carry a reason.");
      const companyId = req.companyId!;
      const at = nowISO();
      const from =
        action === "revoke"
          ? (["active", "suspended", "expired", "lost"] as const)
          : action === "suspend"
            ? (["active"] as const)
            : (["suspended"] as const);
      const set =
        action === "revoke"
          ? { status: "revoked", revokedAt: at, revokedBy: req.user!.id, revokeReason: reason ?? null, updatedAt: at }
          : action === "suspend"
            ? { status: "suspended", updatedAt: at }
            : { status: "active", updatedAt: at };
      const [row] = await app.db
        .update(siteAccessPasses)
        .set(set)
        .where(
          and(
            eq(siteAccessPasses.id, id),
            eq(siteAccessPasses.companyId, companyId),
            eq(siteAccessPasses.projectId, projectId),
            inArray(siteAccessPasses.status, [...from]),
          ),
        )
        .returning();
      if (!row) {
        throw conflict(
          `The pass could not be ${action}d: it does not exist in this project, or its status is not one of ${from.join(", ")}.`,
        );
      }
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "site_access_pass",
        objectId: id,
        payload: { action, to: set.status, reason: reason ?? null },
      });
      return row;
    });
  passTransition("revoke");
  passTransition("suspend");
  passTransition("reinstate");

  /* ---------------------------------------------------------------- */
  /* Gate feed                                                         */
  /* ---------------------------------------------------------------- */

  app.post(`${base}/gate-events`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const payload = z
      .union([gateEventBody, z.object({ events: z.array(gateEventBody).min(1).max(1000) })])
      .parse(req.body);
    const events = "events" in payload ? payload.events : [payload];
    const result = await ingestGateEvents(
      app.db,
      { companyId: req.companyId!, projectId, actorId: req.user!.id },
      events,
    );
    return reply.code(201).send(result);
  });

  app.get(`${base}/gate-events`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({
        from: isoTimestampSchema.optional(),
        to: isoTimestampSchema.optional(),
        direction: z.enum(SITE_GATE_DIRECTIONS).optional(),
        accepted: z.coerce.number().int().min(0).max(1).optional(),
        badgeCode: z.string().max(64).optional(),
        passId: idSchema.optional(),
      })
      .parse(req.query);
    const where = and(
      eq(siteGateEvents.companyId, req.companyId!),
      eq(siteGateEvents.projectId, projectId),
      q.from ? gte(siteGateEvents.occurredAt, q.from) : undefined,
      q.to ? lte(siteGateEvents.occurredAt, q.to) : undefined,
      q.direction ? eq(siteGateEvents.direction, q.direction) : undefined,
      q.accepted !== undefined ? eq(siteGateEvents.accepted, q.accepted) : undefined,
      q.badgeCode ? eq(siteGateEvents.badgeCode, q.badgeCode) : undefined,
      q.passId ? eq(siteGateEvents.passId, q.passId) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(siteGateEvents).where(where).orderBy(desc(siteGateEvents.occurredAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(siteGateEvents).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.get(`${base}/register`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = z
      .object({
        asOf: isoTimestampSchema.optional(),
        windowDays: z.coerce.number().int().min(1).max(90).optional(),
        overstayHours: z.coerce.number().int().min(1).max(168).optional(),
      })
      .parse(req.query);
    return loadRegister(app.db, req.companyId!, projectId, q.asOf ?? nowISO(), {
      ...(q.windowDays === undefined ? {} : { windowDays: q.windowDays }),
      ...(q.overstayHours === undefined ? {} : { overstayHours: q.overstayHours }),
    });
  });

  app.get(`${base}/presence`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = z.object({ from: isoDateSchema, to: isoDateSchema }).parse(req.query);
    if (q.to < q.from) throw badRequest("`to` must not be before `from`.");
    const spanDays = Math.round((Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000);
    if (spanDays > 92) throw badRequest("Presence may be read a quarter at a time at most (92 days).");
    const events = await loadGateEvents(
      app.db,
      req.companyId!,
      projectId,
      `${q.from}T00:00:00.000Z`,
      `${q.to}T23:59:59.999Z`,
    );
    const rows = dailyPresence(events, { from: q.from, to: q.to });
    return {
      items: rows,
      total: rows.length,
      from: q.from,
      to: q.to,
      reasons:
        events.length === 0
          ? ["No gate events in this window. Hours on site cannot be derived from a feed that holds nothing."]
          : [],
    };
  });

  /* ---------------------------------------------------------------- */
  /* Musters                                                           */
  /* ---------------------------------------------------------------- */

  app.get(`${base}/musters`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema.extend({ status: z.string().max(20).optional() }).parse(req.query);
    const where = and(
      eq(siteMusters.companyId, req.companyId!),
      eq(siteMusters.projectId, projectId),
      q.status ? eq(siteMusters.status, q.status) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(siteMusters).where(where).orderBy(desc(siteMusters.declaredAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(siteMusters).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post(`${base}/musters`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = z
      .object({
        kind: z.enum(SITE_MUSTER_KINDS).default("drill"),
        musterPoint: z.string().trim().max(200).nullish(),
        declaredAt: isoTimestampSchema.optional(),
        notes: z.string().max(4000).nullish(),
      })
      .parse(req.body ?? {});
    const companyId = req.companyId!;
    const declaredAt = body.declaredAt ?? nowISO();

    // Snapshot the register AT DECLARATION. Later gate reads must not change
    // who a muster was looking for.
    const register = await loadRegister(app.db, companyId, projectId, declaredAt);
    const expectedRegister = register.onSite.map((p) => ({
      key: p.personKey,
      name: p.personName,
      passId: p.passId,
      workerId: p.workerId,
      sinceAt: p.sinceAt,
    }));

    const { number, reference } = await allocateReference(app.db, projectId, "site_muster", "MUS");
    const id = newId("mus");
    const [row] = await app.db
      .insert(siteMusters)
      .values({
        id,
        companyId,
        projectId,
        number,
        reference,
        kind: body.kind,
        musterPoint: body.musterPoint ?? null,
        declaredAt,
        declaredBy: req.user!.id,
        status: "open",
        expectedCount: expectedRegister.length,
        accountedCount: 0,
        unaccountedCount: expectedRegister.length,
        unexpectedCount: 0,
        expectedRegister,
        notes: body.notes ?? null,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "site_muster",
      objectId: id,
      payload: { reference, kind: body.kind, declaredAt, expectedCount: expectedRegister.length },
    });
    return reply.code(201).send({ ...row, registerReasons: register.reasons });
  });

  app.get(`${base}/musters/:id`, { preHandler: readGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const muster = notFoundIfMissing(
      (
        await app.db
          .select()
          .from(siteMusters)
          .where(and(eq(siteMusters.id, id), eq(siteMusters.companyId, companyId), eq(siteMusters.projectId, projectId)))
          .limit(1)
      )[0],
      "Muster",
    );
    const checkins = await app.db
      .select()
      .from(siteMusterCheckins)
      .where(and(eq(siteMusterCheckins.musterId, id), eq(siteMusterCheckins.companyId, companyId)))
      .orderBy(asc(siteMusterCheckins.personName));
    const checkedIn = new Set(checkins.filter((c) => c.status !== "unaccounted").map((c) => c.personKey));
    return {
      ...muster,
      checkins,
      outstanding: (muster.expectedRegister ?? []).filter((p) => !checkedIn.has(p.key)),
    };
  });

  app.post(`${base}/musters/:id/checkins`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const body = z
      .object({
        checkins: z
          .array(
            z.object({
              personKey: z.string().trim().min(1).max(200).optional(),
              passId: idSchema.nullish(),
              workerId: idSchema.nullish(),
              badgeCode: z.string().trim().max(64).nullish(),
              personName: z.string().trim().min(1).max(200),
              status: z.enum(SITE_MUSTER_PERSON_STATUSES).default("present"),
              method: z.enum(["manual", "badge", "radio", "phone"]).default("manual"),
              checkedInAt: isoTimestampSchema.optional(),
              notes: z.string().max(1000).nullish(),
            }),
          )
          .min(1)
          .max(2000),
      })
      .parse(req.body);

    const muster = notFoundIfMissing(
      (
        await app.db
          .select()
          .from(siteMusters)
          .where(and(eq(siteMusters.id, id), eq(siteMusters.companyId, companyId), eq(siteMusters.projectId, projectId)))
          .limit(1)
      )[0],
      "Muster",
    );
    if (muster.status === "closed") throw conflict("This muster is closed; no further check-ins may be recorded.");

    const expectedKeys = new Set((muster.expectedRegister ?? []).map((p) => p.key));
    const at = nowISO();
    let recorded = 0;
    for (const entry of body.checkins) {
      const personKey = entry.personKey ?? personKeyOf(entry);
      await app.db
        .insert(siteMusterCheckins)
        .values({
          id: newId("mck"),
          companyId,
          projectId,
          musterId: id,
          personKey,
          personName: entry.personName,
          passId: entry.passId ?? null,
          workerId: entry.workerId ?? null,
          status: entry.status,
          unexpected: expectedKeys.has(personKey) ? 0 : 1,
          method: entry.method,
          checkedInAt: entry.checkedInAt ?? at,
          checkedInBy: req.user!.id,
          notes: entry.notes ?? null,
        })
        .onConflictDoUpdate({
          target: [siteMusterCheckins.musterId, siteMusterCheckins.personKey],
          set: {
            status: entry.status,
            method: entry.method,
            checkedInAt: entry.checkedInAt ?? at,
            checkedInBy: req.user!.id,
            notes: entry.notes ?? null,
          },
        });
      recorded += 1;
    }
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "site_muster_checkin",
      objectId: id,
      payload: { musterId: id, recorded },
    });
    const outcome = await reconcileMusterRecord(app.db, companyId, projectId, req.user!.id, id);
    return { recorded, muster: outcome.muster, reconciliation: outcome.reconciliation };
  });

  app.post(`${base}/musters/:id/reconcile`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    notFoundIfMissing(
      (
        await app.db
          .select({ id: siteMusters.id })
          .from(siteMusters)
          .where(and(eq(siteMusters.id, id), eq(siteMusters.companyId, companyId), eq(siteMusters.projectId, projectId)))
          .limit(1)
      )[0],
      "Muster",
    );
    const outcome = await reconcileMusterRecord(app.db, companyId, projectId, req.user!.id, id);
    return { muster: outcome.muster, reconciliation: outcome.reconciliation, signalId: outcome.signalId };
  });

  app.post(`${base}/musters/:id/close`, { preHandler: adminGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const { notes } = z.object({ notes: z.string().max(4000).optional() }).parse(req.body ?? {});
    const companyId = req.companyId!;
    notFoundIfMissing(
      (
        await app.db
          .select({ id: siteMusters.id })
          .from(siteMusters)
          .where(and(eq(siteMusters.id, id), eq(siteMusters.companyId, companyId), eq(siteMusters.projectId, projectId)))
          .limit(1)
      )[0],
      "Muster",
    );
    const outcome = await reconcileMusterRecord(app.db, companyId, projectId, req.user!.id, id);
    if (outcome.reconciliation.unaccountedCount > 0 && !notes) {
      throw badRequest(
        `${outcome.reconciliation.unaccountedCount} person(s) are still unaccounted for (${outcome.reconciliation.unaccounted.map((p) => p.name).join(", ")}). A muster with people missing may only be closed with a written account of what happened to them.`,
      );
    }
    const at = nowISO();
    const [row] = await app.db
      .update(siteMusters)
      .set({ status: "closed", notes: notes ?? outcome.muster.notes, updatedAt: at })
      .where(and(eq(siteMusters.id, id), eq(siteMusters.companyId, companyId), eq(siteMusters.projectId, projectId)))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "site_muster",
      objectId: id,
      payload: { to: "closed", unaccounted: outcome.reconciliation.unaccountedCount, notes: notes ?? null },
    });
    return row;
  });
};
