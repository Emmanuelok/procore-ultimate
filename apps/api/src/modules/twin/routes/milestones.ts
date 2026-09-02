/**
 * ISO 19650 information delivery milestones and the containers they require
 * (spec Domain L #632-636).
 *
 * A milestone is not "delivered" because somebody clicked delivered: it is
 * delivered when every information container it requires exists at the
 * required CDE state and suitability. `evaluate` computes that from the model
 * register and refuses the transition when a container is missing, naming the
 * containers that fail. Acceptance stays a human decision and records who
 * made it.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  bimModelVersions,
  bimModels,
  deliveryMilestones,
  files,
  milestoneContainers,
} from "@constructos/db";
import { CDE_STATES, SUITABILITY_CODES, type CdeState } from "@constructos/shared";
import { newId } from "../../../lib/ids.js";
import { badRequest, conflict, notFound } from "../../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { buildTwinGates, isoDateSchema, ledger, nowISO, todayISO } from "../shared.js";

const MILESTONE_STATUSES = ["open", "delivered", "accepted", "rejected"] as const;
type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];
const MILESTONE_TRANSITIONS: Record<MilestoneStatus, MilestoneStatus[]> = {
  open: ["delivered"],
  delivered: ["accepted", "rejected"],
  rejected: ["delivered"],
  accepted: [],
};

/** CDE states ordered so "at least published" can be tested. */
const STATE_ORDER: CdeState[] = ["wip", "shared", "published", "archived"];

const milestoneCreateSchema = z.object({
  name: z.string().min(1).max(300),
  dueDate: isoDateSchema.nullable().optional(),
  requiredState: z.enum(CDE_STATES).optional(),
  requiredSuitability: z.enum(SUITABILITY_CODES).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
});

const milestonePatchSchema = milestoneCreateSchema.partial().extend({
  status: z.enum(MILESTONE_STATUSES).optional(),
  decisionNote: z.string().max(2000).optional(),
});

const containerSchema = z
  .object({
    label: z.string().min(1).max(200),
    modelId: z.string().max(64).nullable().optional(),
    documentFileId: z.string().max(64).nullable().optional(),
    requiredState: z.enum(CDE_STATES).optional(),
    requiredSuitability: z.enum(SUITABILITY_CODES).nullable().optional(),
  })
  .refine((v) => !!v.modelId !== !!v.documentFileId, {
    message: "A container is either a model or a document — supply exactly one",
  });

export const milestoneRoutes: FastifyPluginAsync = async (app) => {
  const gates = buildTwinGates(app);

  async function getMilestone(milestoneId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(deliveryMilestones)
      .where(
        and(
          eq(deliveryMilestones.id, milestoneId),
          eq(deliveryMilestones.companyId, companyId),
          eq(deliveryMilestones.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Delivery milestone not found");
    return rows[0];
  }

  interface ContainerVerdict {
    id: string;
    label: string;
    kind: "model" | "document";
    satisfied: boolean;
    reason: string;
    currentState: string | null;
    currentSuitability: string | null;
  }

  /** Evaluate every container of a milestone against the register (#632-636). */
  async function evaluateContainers(
    milestone: typeof deliveryMilestones.$inferSelect,
  ): Promise<{ verdicts: ContainerVerdict[]; satisfied: boolean }> {
    const containers = await app.db
      .select()
      .from(milestoneContainers)
      .where(eq(milestoneContainers.milestoneId, milestone.id));
    const verdicts: ContainerVerdict[] = [];

    for (const container of containers) {
      const requiredState = (container.requiredState ?? milestone.requiredState) as CdeState;
      const requiredSuitability = container.requiredSuitability ?? milestone.requiredSuitability;
      if (container.modelId) {
        const rows = await app.db
          .select({
            state: bimModelVersions.cdeState,
            suitability: bimModelVersions.suitability,
            version: bimModelVersions.version,
          })
          .from(bimModelVersions)
          .innerJoin(bimModels, eq(bimModels.id, bimModelVersions.modelId))
          .where(
            and(
              eq(bimModelVersions.modelId, container.modelId),
              eq(bimModels.companyId, milestone.companyId),
            ),
          )
          .orderBy(desc(bimModelVersions.version));
        const best = rows.find(
          (r) =>
            STATE_ORDER.indexOf(r.state as CdeState) >= STATE_ORDER.indexOf(requiredState) &&
            (!requiredSuitability || r.suitability === requiredSuitability),
        );
        const newest = rows[0];
        verdicts.push({
          id: container.id,
          label: container.label,
          kind: "model",
          satisfied: !!best,
          reason: best
            ? `v${best.version} is ${best.state}/${best.suitability}`
            : rows.length === 0
              ? "the model has no versions"
              : `newest version is ${newest?.state}/${newest?.suitability}, ${requiredState}${
                  requiredSuitability ? `/${requiredSuitability}` : ""
                } required`,
          currentState: newest?.state ?? null,
          currentSuitability: newest?.suitability ?? null,
        });
        continue;
      }
      const fileRows = await app.db
        .select({ id: files.id, deletedAt: files.deletedAt })
        .from(files)
        .where(
          and(eq(files.id, container.documentFileId!), eq(files.companyId, milestone.companyId)),
        )
        .limit(1);
      const file = fileRows[0];
      verdicts.push({
        id: container.id,
        label: container.label,
        kind: "document",
        satisfied: !!file && !file.deletedAt,
        reason: file
          ? file.deletedAt
            ? "the document has been deleted"
            : "the document exists"
          : "the document is missing",
        currentState: null,
        currentSuitability: null,
      });
    }

    return {
      verdicts,
      satisfied: verdicts.length > 0 && verdicts.every((v) => v.satisfied),
    };
  }

  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/delivery-milestones",
    { preHandler: gates.readGate },
    async (req) => {
      const q = pageQuerySchema
        .extend({ status: z.enum(MILESTONE_STATUSES).optional() })
        .parse(req.query);
      const conds = [
        eq(deliveryMilestones.companyId, req.companyId!),
        eq(deliveryMilestones.projectId, req.projectId!),
      ];
      if (q.status) conds.push(eq(deliveryMilestones.status, q.status));
      const where = and(...conds);
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
      const ids = items.map((m) => m.id);
      const containers = ids.length
        ? await app.db
            .select()
            .from(milestoneContainers)
            .where(inArray(milestoneContainers.milestoneId, ids))
        : [];
      const today = todayISO();
      return paginate(
        items.map((m) => ({
          ...m,
          containerCount: containers.filter((c) => c.milestoneId === m.id).length,
          overdue: !!m.dueDate && m.dueDate < today && m.status !== "accepted",
        })),
        Number(totalRow?.n ?? 0),
        q,
      );
    },
  );

  app.post(
    "/projects/:projectId/delivery-milestones",
    { preHandler: gates.standardGate },
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
          createdBy: req.user!.id,
        })
        .returning();
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "delivery_milestone",
        objectId: id,
        payload: created,
      });
      return reply.status(201).send(created);
    },
  );

  app.get(
    "/projects/:projectId/delivery-milestones/:milestoneId",
    { preHandler: gates.readGate },
    async (req) => {
      const { milestoneId } = req.params as { milestoneId: string };
      const milestone = await getMilestone(milestoneId, req.companyId!, req.projectId!);
      const { verdicts, satisfied } = await evaluateContainers(milestone);
      return { ...milestone, containers: verdicts, containersSatisfied: satisfied };
    },
  );

  app.patch(
    "/projects/:projectId/delivery-milestones/:milestoneId",
    { preHandler: gates.standardGate },
    async (req) => {
      const { milestoneId } = req.params as { milestoneId: string };
      const body = milestonePatchSchema.parse(req.body);
      const existing = await getMilestone(milestoneId, req.companyId!, req.projectId!);

      const statusChanged = body.status !== undefined && body.status !== existing.status;
      if (statusChanged) {
        const from = existing.status as MilestoneStatus;
        if (!MILESTONE_TRANSITIONS[from].includes(body.status!)) {
          throw badRequest(
            `Illegal status transition ${from} -> ${body.status}. Flow: open -> delivered -> accepted/rejected (rejected -> delivered on re-delivery).`,
          );
        }
        if (body.status === "delivered") {
          const { verdicts, satisfied } = await evaluateContainers(existing);
          if (verdicts.length > 0 && !satisfied) {
            throw conflict(
              `Not every required container is in place: ${verdicts
                .filter((v) => !v.satisfied)
                .map((v) => `${v.label} (${v.reason})`)
                .join("; ")}`,
            );
          }
        }
        if (body.status === "accepted" && existing.createdBy === req.user!.id) {
          throw badRequest(
            "The person who set up a delivery milestone cannot accept its delivery — acceptance needs a second party",
          );
        }
      }

      const patch: Record<string, unknown> = { updatedAt: nowISO() };
      for (const key of [
        "name",
        "dueDate",
        "requiredState",
        "requiredSuitability",
        "description",
      ] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (body.decisionNote !== undefined) patch["decisionNote"] = body.decisionNote;
      if (statusChanged) {
        patch["status"] = body.status;
        if (body.status === "delivered") patch["deliveredAt"] = nowISO();
        if (body.status === "accepted") {
          patch["acceptedBy"] = req.user!.id;
          patch["acceptedAt"] = nowISO();
        }
      }

      const [updated] = await app.db
        .update(deliveryMilestones)
        .set(patch)
        .where(eq(deliveryMilestones.id, milestoneId))
        .returning();
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: statusChanged ? "state_change" : "update",
        objectType: "delivery_milestone",
        objectId: milestoneId,
        payload: statusChanged ? { from: existing.status, to: body.status, patch } : patch,
        storePayload: statusChanged,
      });
      return updated;
    },
  );

  app.delete(
    "/projects/:projectId/delivery-milestones/:milestoneId",
    { preHandler: gates.standardGate },
    async (req) => {
      const { milestoneId } = req.params as { milestoneId: string };
      await getMilestone(milestoneId, req.companyId!, req.projectId!);
      await app.db.transaction(async (tx) => {
        await tx
          .delete(milestoneContainers)
          .where(eq(milestoneContainers.milestoneId, milestoneId));
        await tx.delete(deliveryMilestones).where(eq(deliveryMilestones.id, milestoneId));
      });
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "delivery_milestone",
        objectId: milestoneId,
      });
      return { ok: true };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Containers                                                        */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/delivery-milestones/:milestoneId/containers",
    { preHandler: gates.standardGate },
    async (req, reply) => {
      const { milestoneId } = req.params as { milestoneId: string };
      const body = containerSchema.parse(req.body);
      await getMilestone(milestoneId, req.companyId!, req.projectId!);
      if (body.modelId) {
        const rows = await app.db
          .select({ id: bimModels.id })
          .from(bimModels)
          .where(
            and(
              eq(bimModels.id, body.modelId),
              eq(bimModels.companyId, req.companyId!),
              eq(bimModels.projectId, req.projectId!),
            ),
          )
          .limit(1);
        if (!rows[0]) throw badRequest("Model not found in this project");
      }
      if (body.documentFileId) {
        const rows = await app.db
          .select({ id: files.id })
          .from(files)
          .where(and(eq(files.id, body.documentFileId), eq(files.companyId, req.companyId!)))
          .limit(1);
        if (!rows[0]) throw badRequest("Document not found in this company");
      }
      const id = newId("mct");
      const [created] = await app.db
        .insert(milestoneContainers)
        .values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          milestoneId,
          modelId: body.modelId ?? null,
          documentFileId: body.documentFileId ?? null,
          label: body.label,
          requiredState: body.requiredState ?? "published",
          requiredSuitability: body.requiredSuitability ?? null,
        })
        .returning();
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "milestone_container",
        objectId: id,
        payload: created,
      });
      return reply.status(201).send(created);
    },
  );

  app.delete(
    "/projects/:projectId/delivery-milestones/:milestoneId/containers/:containerId",
    { preHandler: gates.standardGate },
    async (req) => {
      const { milestoneId, containerId } = req.params as {
        milestoneId: string;
        containerId: string;
      };
      await getMilestone(milestoneId, req.companyId!, req.projectId!);
      const deleted = await app.db
        .delete(milestoneContainers)
        .where(
          and(
            eq(milestoneContainers.id, containerId),
            eq(milestoneContainers.milestoneId, milestoneId),
          ),
        )
        .returning({ id: milestoneContainers.id });
      if (!deleted[0]) throw notFound("Container not found");
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "milestone_container",
        objectId: containerId,
        payload: { milestoneId },
      });
      return { ok: true };
    },
  );

  /** Evaluate without changing anything — the MIDP status board. */
  app.get(
    "/projects/:projectId/delivery-milestones/:milestoneId/evaluate",
    { preHandler: gates.readGate },
    async (req) => {
      const { milestoneId } = req.params as { milestoneId: string };
      const milestone = await getMilestone(milestoneId, req.companyId!, req.projectId!);
      const { verdicts, satisfied } = await evaluateContainers(milestone);
      return {
        milestoneId,
        status: milestone.status,
        containers: verdicts,
        satisfied,
        canDeliver: milestone.status === "open" || milestone.status === "rejected" ? satisfied : false,
        reason:
          verdicts.length === 0
            ? "No information containers have been attached to this milestone"
            : satisfied
              ? "Every required container is in place"
              : "One or more containers are not at the required state",
      };
    },
  );
};
