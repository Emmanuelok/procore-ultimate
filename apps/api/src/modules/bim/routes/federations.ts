/**
 * Federation groups (spec #232, #247): named sets of model versions viewed
 * and clash-tested together. Nothing here is new behaviour; what changed is
 * that renaming and deleting a federation, and adding or removing members,
 * are ledgered and gated at the same tool level as the rest of the module.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  bimModelVersions,
  bimModels,
  clashTests,
  federationGroups,
  federationMembers,
} from "@constructos/db";
import { newId } from "../../../lib/ids.js";
import { badRequest, conflict, notFound } from "../../../lib/errors.js";
import { buildBimGates, buildLoaders, ledger } from "../shared.js";

const federationCreateSchema = z.object({ name: z.string().min(1).max(200) });

const federationMemberSchema = z.object({
  modelVersionId: z.string().min(1).max(64),
  transform: z.unknown().optional(),
});

export const federationRoutes: FastifyPluginAsync = async (app) => {
  const gates = buildBimGates(app);
  const { getFederation } = buildLoaders(app);

  app.get(
    "/projects/:projectId/bim/federations",
    { preHandler: gates.readGate },
    async (req) => {
      const groups = await app.db
        .select()
        .from(federationGroups)
        .where(
          and(
            eq(federationGroups.companyId, req.companyId!),
            eq(federationGroups.projectId, req.projectId!),
          ),
        )
        .orderBy(asc(federationGroups.name));
      const groupIds = groups.map((g) => g.id);
      const members = groupIds.length
        ? await app.db
            .select({
              member: federationMembers,
              version: bimModelVersions.version,
              processing: bimModelVersions.processing,
              elementCount: bimModelVersions.elementCount,
              modelId: bimModels.id,
              modelName: bimModels.name,
              discipline: bimModels.discipline,
            })
            .from(federationMembers)
            .innerJoin(bimModelVersions, eq(bimModelVersions.id, federationMembers.modelVersionId))
            .innerJoin(bimModels, eq(bimModels.id, bimModelVersions.modelId))
            .where(inArray(federationMembers.groupId, groupIds))
        : [];
      const tests = groupIds.length
        ? await app.db
            .select({ id: clashTests.id, name: clashTests.name, federationId: clashTests.federationId })
            .from(clashTests)
            .where(inArray(clashTests.federationId, groupIds))
        : [];
      const items = groups.map((g) => ({
        ...g,
        members: members
          .filter((m) => m.member.groupId === g.id)
          .map((m) => ({
            ...m.member,
            modelId: m.modelId,
            modelName: m.modelName,
            discipline: m.discipline,
            version: m.version,
            processing: m.processing,
            elementCount: m.elementCount,
          })),
        clashTests: tests.filter((t) => t.federationId === g.id),
      }));
      return { items, total: items.length };
    },
  );

  app.post(
    "/projects/:projectId/bim/federations",
    { preHandler: gates.standardGate },
    async (req, reply) => {
      const body = federationCreateSchema.parse(req.body);
      const id = newId("fed");
      const [created] = await app.db
        .insert(federationGroups)
        .values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          name: body.name,
          createdBy: req.user!.id,
        })
        .returning();
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "federation_group",
        objectId: id,
        payload: created,
      });
      return reply.status(201).send(created);
    },
  );

  app.patch(
    "/projects/:projectId/bim/federations/:groupId",
    { preHandler: gates.standardGate },
    async (req) => {
      const { groupId } = req.params as { groupId: string };
      await getFederation(groupId, req.companyId!, req.projectId!);
      const body = federationCreateSchema.parse(req.body);
      const [updated] = await app.db
        .update(federationGroups)
        .set({ name: body.name })
        .where(eq(federationGroups.id, groupId))
        .returning();
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "federation_group",
        objectId: groupId,
        payload: { name: body.name },
      });
      return updated;
    },
  );

  app.delete(
    "/projects/:projectId/bim/federations/:groupId",
    { preHandler: gates.standardGate },
    async (req) => {
      const { groupId } = req.params as { groupId: string };
      await getFederation(groupId, req.companyId!, req.projectId!);
      const tests = await app.db
        .select({ id: clashTests.id })
        .from(clashTests)
        .where(eq(clashTests.federationId, groupId))
        .limit(1);
      if (tests[0]) {
        throw conflict(
          "This federation has clash tests attached — delete or re-point them before deleting the federation",
        );
      }
      await app.db.transaction(async (tx) => {
        await tx.delete(federationMembers).where(eq(federationMembers.groupId, groupId));
        await tx.delete(federationGroups).where(eq(federationGroups.id, groupId));
      });
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "federation_group",
        objectId: groupId,
      });
      return { ok: true };
    },
  );

  app.post(
    "/projects/:projectId/bim/federations/:groupId/members",
    { preHandler: gates.standardGate },
    async (req, reply) => {
      const { groupId } = req.params as { groupId: string };
      await getFederation(groupId, req.companyId!, req.projectId!);
      const body = federationMemberSchema.parse(req.body);

      const versionRows = await app.db
        .select({ id: bimModelVersions.id })
        .from(bimModelVersions)
        .innerJoin(bimModels, eq(bimModels.id, bimModelVersions.modelId))
        .where(
          and(
            eq(bimModelVersions.id, body.modelVersionId),
            eq(bimModels.companyId, req.companyId!),
            eq(bimModels.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!versionRows[0]) throw badRequest("Model version not found in this project");

      const existing = await app.db
        .select({ id: federationMembers.id })
        .from(federationMembers)
        .where(
          and(
            eq(federationMembers.groupId, groupId),
            eq(federationMembers.modelVersionId, body.modelVersionId),
          ),
        )
        .limit(1);
      if (existing[0]) throw conflict("Model version is already in this federation");

      const id = newId("fdm");
      const [created] = await app.db
        .insert(federationMembers)
        .values({
          id,
          groupId,
          modelVersionId: body.modelVersionId,
          transform: body.transform ?? null,
        })
        .returning();
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "federation_member",
        objectId: id,
        payload: { groupId, modelVersionId: body.modelVersionId },
      });
      return reply.status(201).send(created);
    },
  );

  app.delete(
    "/projects/:projectId/bim/federations/:groupId/members/:memberId",
    { preHandler: gates.standardGate },
    async (req) => {
      const { groupId, memberId } = req.params as { groupId: string; memberId: string };
      await getFederation(groupId, req.companyId!, req.projectId!);
      const deleted = await app.db
        .delete(federationMembers)
        .where(and(eq(federationMembers.id, memberId), eq(federationMembers.groupId, groupId)))
        .returning({ id: federationMembers.id });
      if (!deleted[0]) throw notFound("Federation member not found");
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "federation_member",
        objectId: memberId,
        payload: { groupId },
      });
      return { ok: true };
    },
  );
};
