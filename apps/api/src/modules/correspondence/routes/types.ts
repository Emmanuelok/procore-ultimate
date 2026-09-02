/**
 * CORRESPONDENCE TYPES (spec #440 custom types, #445 configurable workflows).
 *
 * A type is tenant configuration, not project data: it decides the reference
 * prefix, whether a response is expected and in how many days, whether the
 * record is a contractual act, and which approval steps stand between a draft
 * and an issued letter. Company-level routes, administrative writes.
 *
 * Deactivation rather than deletion is the default once a type has been used:
 * deleting a type whose letters exist would orphan a register that a dispute
 * may turn on.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { correspondenceLetters, correspondenceTypes, projects } from "@constructos/db";
import { CORRESPONDENCE_DIRECTIONS } from "@constructos/shared";
import { badRequest, conflict, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { buildGates, idSchema, keySchema, ledger, nowISO, patchSchemaOf, patchSet } from "../shared.js";

const approvalStepSchema = z.object({
  name: z.string().min(1).max(120),
  role: z.enum(["owner", "admin", "member"]).nullable().optional(),
  userId: idSchema.nullable().optional(),
});

const typeBodySchema = z.object({
  key: keySchema,
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  prefix: z
    .string()
    .trim()
    .min(1)
    .max(12)
    .regex(/^[A-Za-z][A-Za-z0-9-]*$/, "A prefix starts with a letter and holds letters, digits and hyphens")
    .transform((v) => v.toUpperCase()),
  projectId: idSchema.nullable().optional(),
  defaultDirection: z.enum(CORRESPONDENCE_DIRECTIONS).default("outbound"),
  requiresResponse: z.boolean().default(false),
  responseDays: z.number().int().min(0).max(365).nullable().optional(),
  isContractual: z.boolean().default(false),
  createsObligation: z.boolean().default(true),
  approvalSteps: z.array(approvalStepSchema).max(10).default([]),
});

const typePatchSchema = patchSchemaOf(typeBodySchema)
  .omit({ key: true, projectId: true })
  .extend({ isActive: z.boolean().optional() });

/** The library a new tenant gets on request — the types every project needs. */
const SEED_TYPES: Array<z.input<typeof typeBodySchema>> = [
  {
    key: "letter",
    name: "General letter",
    prefix: "LTR",
    description: "Ordinary project correspondence with no contractual character.",
    requiresResponse: true,
    responseDays: 14,
  },
  {
    key: "instruction",
    name: "Contractual instruction",
    prefix: "INS",
    description: "An instruction issued under the contract. Recipients must acknowledge and comply.",
    requiresResponse: true,
    responseDays: 7,
    isContractual: true,
  },
  {
    key: "notice",
    name: "Contractual notice",
    prefix: "NOT",
    description: "A notice served under the contract — the record a time bar turns on.",
    requiresResponse: true,
    responseDays: 7,
    isContractual: true,
  },
  {
    key: "eot_notice",
    name: "Extension of time notice",
    prefix: "EOT",
    description: "Notification of a delay event and of the intention to claim an extension of time.",
    requiresResponse: true,
    responseDays: 28,
    isContractual: true,
  },
  {
    key: "technical_query",
    name: "Technical query",
    prefix: "TQ",
    description: "A question to the design team that is not formal enough to be an RFI.",
    requiresResponse: true,
    responseDays: 7,
  },
];

export const typeRoutes: FastifyPluginAsync = async (app) => {
  const { companyGate, companyAdminGate } = buildGates(app);

  async function assertProject(companyId: string, projectId: string): Promise<void> {
    const rows = await app.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw badRequest(`Project ${projectId} not found in this company.`);
  }

  app.get("/correspondence/types", { preHandler: companyGate }, async (req) => {
    const q = z
      .object({
        projectId: idSchema.optional(),
        includeInactive: z.coerce.boolean().default(false),
      })
      .parse(req.query);
    const rows = await app.db
      .select()
      .from(correspondenceTypes)
      .where(
        and(
          eq(correspondenceTypes.companyId, req.companyId!),
          q.includeInactive ? undefined : eq(correspondenceTypes.isActive, 1),
          q.projectId
            ? or(isNull(correspondenceTypes.projectId), eq(correspondenceTypes.projectId, q.projectId))
            : undefined,
        ),
      )
      .orderBy(asc(correspondenceTypes.prefix));
    const counts = await app.db
      .select({ typeId: correspondenceLetters.typeId, n: sql<number>`count(*)::int` })
      .from(correspondenceLetters)
      .where(eq(correspondenceLetters.companyId, req.companyId!))
      .groupBy(correspondenceLetters.typeId);
    const used = new Map(counts.map((c) => [c.typeId, Number(c.n)]));
    return {
      items: rows.map((row) => ({ ...row, letterCount: used.get(row.id) ?? 0 })),
      total: rows.length,
    };
  });

  app.post("/correspondence/types", { preHandler: companyAdminGate }, async (req, reply) => {
    const body = typeBodySchema.parse(req.body);
    const companyId = req.companyId!;
    if (body.projectId) await assertProject(companyId, body.projectId);
    if (body.requiresResponse && (body.responseDays === null || body.responseDays === undefined)) {
      throw badRequest(
        "A type that requires a response needs a response period in days — otherwise the register has a deadline it cannot chase.",
      );
    }
    const clash = await app.db
      .select({ id: correspondenceTypes.id })
      .from(correspondenceTypes)
      .where(and(eq(correspondenceTypes.companyId, companyId), eq(correspondenceTypes.key, body.key)))
      .limit(1);
    if (clash[0]) throw conflict(`A correspondence type with the key "${body.key}" already exists.`);

    const id = newId("ctp");
    const [row] = await app.db
      .insert(correspondenceTypes)
      .values({
        id,
        companyId,
        projectId: body.projectId ?? null,
        key: body.key,
        name: body.name,
        description: body.description ?? null,
        prefix: body.prefix,
        defaultDirection: body.defaultDirection,
        requiresResponse: body.requiresResponse ? 1 : 0,
        responseDays: body.responseDays ?? null,
        isContractual: body.isContractual ? 1 : 0,
        createsObligation: body.createsObligation ? 1 : 0,
        approvalSteps: body.approvalSteps.map((s) => ({
          name: s.name,
          role: s.role ?? null,
          userId: s.userId ?? null,
        })),
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId: body.projectId ?? null,
      actorId: req.user!.id,
      action: "create",
      objectType: "correspondence_type",
      objectId: id,
      payload: { key: body.key, prefix: body.prefix, isContractual: body.isContractual },
    });
    return reply.code(201).send(row);
  });

  app.post("/correspondence/types/seed", { preHandler: companyAdminGate }, async (req, reply) => {
    const companyId = req.companyId!;
    const existing = await app.db
      .select({ key: correspondenceTypes.key })
      .from(correspondenceTypes)
      .where(eq(correspondenceTypes.companyId, companyId));
    const have = new Set(existing.map((e) => e.key));
    const created: string[] = [];
    for (const seed of SEED_TYPES) {
      if (have.has(seed.key)) continue;
      const body = typeBodySchema.parse(seed);
      const id = newId("ctp");
      await app.db.insert(correspondenceTypes).values({
        id,
        companyId,
        projectId: null,
        key: body.key,
        name: body.name,
        description: body.description ?? null,
        prefix: body.prefix,
        defaultDirection: body.defaultDirection,
        requiresResponse: body.requiresResponse ? 1 : 0,
        responseDays: body.responseDays ?? null,
        isContractual: body.isContractual ? 1 : 0,
        createsObligation: body.createsObligation ? 1 : 0,
        approvalSteps: [],
        isSystem: 1,
        createdBy: req.user!.id,
      });
      await ledger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "create",
        objectType: "correspondence_type",
        objectId: id,
        payload: { key: body.key, seeded: true },
      });
      created.push(body.key);
    }
    return reply.code(created.length > 0 ? 201 : 200).send({
      created,
      skipped: SEED_TYPES.filter((s) => have.has(s.key)).map((s) => s.key),
    });
  });

  app.get("/correspondence/types/:typeId", { preHandler: companyGate }, async (req) => {
    const { typeId } = req.params as { typeId: string };
    const [row] = await app.db
      .select()
      .from(correspondenceTypes)
      .where(
        and(eq(correspondenceTypes.id, typeId), eq(correspondenceTypes.companyId, req.companyId!)),
      )
      .limit(1);
    if (!row) throw notFound("Correspondence type not found");
    const [{ n = 0 } = { n: 0 }] = await app.db
      .select({ n: sql<number>`count(*)::int` })
      .from(correspondenceLetters)
      .where(
        and(
          eq(correspondenceLetters.companyId, req.companyId!),
          eq(correspondenceLetters.typeId, typeId),
        ),
      );
    return { ...row, letterCount: Number(n) };
  });

  app.patch("/correspondence/types/:typeId", { preHandler: companyAdminGate }, async (req) => {
    const { typeId } = req.params as { typeId: string };
    const body = typePatchSchema.parse(req.body);
    const companyId = req.companyId!;
    const [current] = await app.db
      .select()
      .from(correspondenceTypes)
      .where(and(eq(correspondenceTypes.id, typeId), eq(correspondenceTypes.companyId, companyId)))
      .limit(1);
    if (!current) throw notFound("Correspondence type not found");

    const requiresResponse = body.requiresResponse ?? current.requiresResponse === 1;
    const responseDays =
      body.responseDays !== undefined ? body.responseDays : current.responseDays;
    if (requiresResponse && (responseDays === null || responseDays === undefined)) {
      throw badRequest("A type that requires a response needs a response period in days.");
    }

    const set = patchSet(
      {
        ...body,
        requiresResponse: body.requiresResponse === undefined ? undefined : body.requiresResponse ? 1 : 0,
        isContractual: body.isContractual === undefined ? undefined : body.isContractual ? 1 : 0,
        createsObligation:
          body.createsObligation === undefined ? undefined : body.createsObligation ? 1 : 0,
        isActive: body.isActive === undefined ? undefined : body.isActive ? 1 : 0,
        approvalSteps: body.approvalSteps?.map((s) => ({
          name: s.name,
          role: s.role ?? null,
          userId: s.userId ?? null,
        })),
      },
      [
        "name",
        "description",
        "prefix",
        "defaultDirection",
        "requiresResponse",
        "responseDays",
        "isContractual",
        "createsObligation",
        "approvalSteps",
        "isActive",
      ],
    );
    const [row] = await app.db
      .update(correspondenceTypes)
      .set(set)
      .where(and(eq(correspondenceTypes.id, typeId), eq(correspondenceTypes.companyId, companyId)))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId: current.projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "correspondence_type",
      objectId: typeId,
      payload: { changed: Object.keys(set).filter((k) => k !== "updatedAt") },
    });
    return row;
  });

  app.delete("/correspondence/types/:typeId", { preHandler: companyAdminGate }, async (req) => {
    const { typeId } = req.params as { typeId: string };
    const companyId = req.companyId!;
    const [current] = await app.db
      .select()
      .from(correspondenceTypes)
      .where(and(eq(correspondenceTypes.id, typeId), eq(correspondenceTypes.companyId, companyId)))
      .limit(1);
    if (!current) throw notFound("Correspondence type not found");
    const [{ n = 0 } = { n: 0 }] = await app.db
      .select({ n: sql<number>`count(*)::int` })
      .from(correspondenceLetters)
      .where(
        and(
          eq(correspondenceLetters.companyId, companyId),
          eq(correspondenceLetters.typeId, typeId),
        ),
      );
    if (Number(n) > 0) {
      // Deactivate instead: the register must stay readable.
      const [row] = await app.db
        .update(correspondenceTypes)
        .set({ isActive: 0, updatedAt: nowISO() })
        .where(eq(correspondenceTypes.id, typeId))
        .returning();
      await ledger(app.db, {
        companyId,
        projectId: current.projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "correspondence_type",
        objectId: typeId,
        payload: { deactivated: true, letterCount: Number(n) },
      });
      return {
        deleted: false,
        deactivated: true,
        letterCount: Number(n),
        reason: `${n} letter(s) already use this type, so it was deactivated rather than deleted — the register stays readable.`,
        type: row,
      };
    }
    await app.db.delete(correspondenceTypes).where(eq(correspondenceTypes.id, typeId));
    await ledger(app.db, {
      companyId,
      projectId: current.projectId,
      actorId: req.user!.id,
      action: "delete",
      objectType: "correspondence_type",
      objectId: typeId,
      payload: { key: current.key },
    });
    return { deleted: true, deactivated: false, letterCount: 0, reason: null, type: null };
  });
};
