/**
 * Warranty register, expiry obligations and warranty claims
 * (spec Domain L #642-645).
 *
 * Dates here are strict ISO dates, validated on create AND on patch, and the
 * ordering (end >= start) is re-checked against the merged record rather than
 * only the submitted fields. The previous implementation accepted any 4-30
 * character string and compared dates lexically, so "01/06/2026" was stored
 * happily and then never appeared in the expiry report - the one report the
 * whole feature exists for.
 *
 * Expiry is owned by the scheduler (alerts.ts), not by whoever opens the page:
 * every active warranty gets an obligation with the deadline, notifications
 * fire once per 90/30/7-day horizon, and an elapsed warranty is marked
 * expired.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import { assets, warranties, warrantyClaims } from "@constructos/db";
import { WARRANTY_CLAIM_STATUSES, WARRANTY_STATUSES } from "@constructos/shared";
import { newId } from "../../../lib/ids.js";
import { badRequest, notFound } from "../../../lib/errors.js";
import { nextRecordNumber } from "../../../lib/numbering.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { sweepWarrantyExpiry } from "../alerts.js";
import {
  addDays,
  buildTwinGates,
  buildTwinLoaders,
  isoDateSchema,
  ledger,
  nowISO,
  todayISO,
} from "../shared.js";

const warrantyCreateSchema = z.object({
  provider: z.string().min(1).max(200),
  description: z.string().max(5000).nullable().optional(),
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  documentFileId: z.string().max(64).nullable().optional(),
});

const warrantyPatchSchema = warrantyCreateSchema.partial().extend({
  status: z.enum(WARRANTY_STATUSES).optional(),
});

const claimCreateSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(10000).nullable().optional(),
  lodgedAt: isoDateSchema.optional(),
  punchItemId: z.string().max(64).nullable().optional(),
});

const claimPatchSchema = z.object({
  status: z.enum(WARRANTY_CLAIM_STATUSES).optional(),
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(10000).nullable().optional(),
  resolution: z.string().max(5000).nullable().optional(),
});

/** lodged -> acknowledged -> in_repair -> closed; rejected from either open state */
const CLAIM_TRANSITIONS: Record<string, string[]> = {
  lodged: ["acknowledged", "rejected"],
  acknowledged: ["in_repair", "rejected", "closed"],
  in_repair: ["closed", "rejected"],
  closed: [],
  rejected: ["lodged"],
};

export const warrantyRoutes: FastifyPluginAsync = async (app) => {
  const gates = buildTwinGates(app);
  const { getAsset, getWarranty } = buildTwinLoaders(app);

  app.get("/assets/:assetId/warranties", { preHandler: gates.companyGate }, async (req, reply) => {
    const { assetId } = req.params as { assetId: string };
    const asset = await getAsset(assetId, req.companyId!);
    await gates.requireToolFor(req, reply, asset.projectId, "read");
    const items = await app.db
      .select()
      .from(warranties)
      .where(eq(warranties.assetId, assetId))
      .orderBy(asc(warranties.endDate));
    const today = todayISO();
    return {
      items: items.map((w) => ({
        ...w,
        expired: w.endDate < today,
        daysRemaining: Math.round(
          (Date.parse(`${w.endDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
        ),
      })),
      total: items.length,
    };
  });

  app.post("/assets/:assetId/warranties", { preHandler: gates.companyGate }, async (req, reply) => {
    const { assetId } = req.params as { assetId: string };
    const body = warrantyCreateSchema.parse(req.body);
    const asset = await getAsset(assetId, req.companyId!);
    await gates.requireToolFor(req, reply, asset.projectId, "standard");
    if (body.endDate < body.startDate) throw badRequest("endDate must be on or after startDate");
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
        status: body.endDate < todayISO() ? "expired" : "active",
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: asset.projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "warranty",
      objectId: id,
      payload: created,
      storePayload: true,
    });
    return reply.status(201).send(created);
  });

  app.patch("/warranties/:warrantyId", { preHandler: gates.companyGate }, async (req, reply) => {
    const { warrantyId } = req.params as { warrantyId: string };
    const body = warrantyPatchSchema.parse(req.body);
    const existing = await getWarranty(warrantyId, req.companyId!);
    await gates.requireToolFor(req, reply, existing.projectId, "standard");

    // ordering is checked against the MERGED record, not just what was sent
    const startDate = body.startDate ?? existing.startDate;
    const endDate = body.endDate ?? existing.endDate;
    if (endDate < startDate) throw badRequest("endDate must be on or after startDate");

    const patch: Record<string, unknown> = {};
    for (const key of ["provider", "description", "startDate", "endDate", "documentFileId", "status"] as const) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (Object.keys(patch).length === 0) throw badRequest("Nothing to update");
    // a re-dated warranty must be re-assessed by the expiry sweep
    if (body.endDate !== undefined) patch["notifiedDays"] = null;
    const [updated] = await app.db
      .update(warranties)
      .set(patch)
      .where(eq(warranties.id, warrantyId))
      .returning();
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: existing.projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "warranty",
      objectId: warrantyId,
      payload: patch,
    });
    return updated;
  });

  app.delete("/warranties/:warrantyId", { preHandler: gates.companyGate }, async (req, reply) => {
    const { warrantyId } = req.params as { warrantyId: string };
    const existing = await getWarranty(warrantyId, req.companyId!);
    await gates.requireToolFor(req, reply, existing.projectId, "admin");
    await app.db.transaction(async (tx) => {
      await tx.delete(warrantyClaims).where(eq(warrantyClaims.warrantyId, warrantyId));
      await tx.delete(warranties).where(eq(warranties.id, warrantyId));
    });
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: existing.projectId,
      actorId: req.user!.id,
      action: "delete",
      objectType: "warranty",
      objectId: warrantyId,
      payload: { provider: existing.provider, assetId: existing.assetId },
      storePayload: true,
    });
    return { ok: true };
  });

  /** Expiry horizon report (#644). */
  app.get(
    "/projects/:projectId/warranties/expiring",
    { preHandler: gates.readGate },
    async (req) => {
      const q = z
        .object({ days: z.coerce.number().int().min(1).max(3650).default(90) })
        .parse(req.query);
      const today = todayISO();
      const horizon = addDays(today, q.days);
      const rows = await app.db
        .select({ warranty: warranties, assetName: assets.name, tagCode: assets.tagCode })
        .from(warranties)
        .innerJoin(assets, eq(assets.id, warranties.assetId))
        .where(
          and(
            eq(warranties.companyId, req.companyId!),
            eq(warranties.projectId, req.projectId!),
            lte(warranties.endDate, horizon),
            inArray(warranties.status, ["active", "expired"]),
          ),
        )
        .orderBy(asc(warranties.endDate))
        .limit(500);
      const items = rows.map((r) => ({
        ...r.warranty,
        assetName: r.assetName,
        tagCode: r.tagCode,
        daysRemaining: Math.round(
          (Date.parse(`${r.warranty.endDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
            86_400_000,
        ),
      }));
      return {
        items,
        total: items.length,
        days: q.days,
        expired: items.filter((i) => i.daysRemaining < 0).length,
      };
    },
  );

  /** Operators and tests can run the expiry sweep on demand. */
  app.post(
    "/projects/:projectId/warranties/sweep",
    { preHandler: gates.adminGate },
    async (req) => {
      const result = await sweepWarrantyExpiry(app, req.companyId!, todayISO());
      return { ...result, ranAt: nowISO() };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Claims (#643)                                                     */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/warranty-claims", { preHandler: gates.readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ status: z.enum(WARRANTY_CLAIM_STATUSES).optional() })
      .parse(req.query);
    const conds = [
      eq(warrantyClaims.companyId, req.companyId!),
      eq(warrantyClaims.projectId, req.projectId!),
    ];
    if (q.status) conds.push(eq(warrantyClaims.status, q.status));
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(warrantyClaims).where(where);
    const items = await app.db
      .select({
        claim: warrantyClaims,
        assetName: assets.name,
        tagCode: assets.tagCode,
        provider: warranties.provider,
      })
      .from(warrantyClaims)
      .innerJoin(assets, eq(assets.id, warrantyClaims.assetId))
      .innerJoin(warranties, eq(warranties.id, warrantyClaims.warrantyId))
      .where(where)
      .orderBy(desc(warrantyClaims.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      items.map((r) => ({
        ...r.claim,
        assetName: r.assetName,
        tagCode: r.tagCode,
        provider: r.provider,
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.post("/warranties/:warrantyId/claims", { preHandler: gates.companyGate }, async (req, reply) => {
    const { warrantyId } = req.params as { warrantyId: string };
    const body = claimCreateSchema.parse(req.body);
    const warranty = await getWarranty(warrantyId, req.companyId!);
    await gates.requireToolFor(req, reply, warranty.projectId, "standard");
    const number = await nextRecordNumber(app.db, warranty.projectId, "warranty_claim");
    const id = newId("wcl");
    const [created] = await app.db
      .insert(warrantyClaims)
      .values({
        id,
        companyId: req.companyId!,
        projectId: warranty.projectId,
        warrantyId,
        assetId: warranty.assetId,
        number,
        title: body.title,
        description: body.description ?? null,
        status: "lodged",
        lodgedAt: body.lodgedAt ?? todayISO(),
        punchItemId: body.punchItemId ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    await app.db
      .update(warranties)
      .set({ status: "claimed" })
      .where(eq(warranties.id, warrantyId));
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: warranty.projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "warranty_claim",
      objectId: id,
      payload: created,
      storePayload: true,
    });
    return reply.status(201).send(created);
  });

  app.patch("/warranty-claims/:claimId", { preHandler: gates.companyGate }, async (req, reply) => {
    const { claimId } = req.params as { claimId: string };
    const body = claimPatchSchema.parse(req.body);
    const rows = await app.db
      .select()
      .from(warrantyClaims)
      .where(and(eq(warrantyClaims.id, claimId), eq(warrantyClaims.companyId, req.companyId!)))
      .limit(1);
    const existing = rows[0];
    if (!existing) throw notFound("Warranty claim not found");
    await gates.requireToolFor(req, reply, existing.projectId, "standard");

    const statusChanged = body.status !== undefined && body.status !== existing.status;
    if (statusChanged && !(CLAIM_TRANSITIONS[existing.status] ?? []).includes(body.status!)) {
      throw badRequest(
        `Illegal claim transition ${existing.status} -> ${body.status}. Flow: lodged -> acknowledged -> in_repair -> closed (rejected from an open state).`,
      );
    }
    const patch: Record<string, unknown> = { updatedAt: nowISO() };
    for (const key of ["title", "description", "resolution"] as const) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (statusChanged) {
      patch["status"] = body.status;
      if (body.status === "acknowledged") patch["respondedAt"] = todayISO();
      if (body.status === "closed" || body.status === "rejected") patch["closedAt"] = todayISO();
    }
    const [updated] = await app.db
      .update(warrantyClaims)
      .set(patch)
      .where(eq(warrantyClaims.id, claimId))
      .returning();

    if (statusChanged && (body.status === "closed" || body.status === "rejected")) {
      const open = await app.db
        .select({ n: count() })
        .from(warrantyClaims)
        .where(
          and(
            eq(warrantyClaims.warrantyId, existing.warrantyId),
            inArray(warrantyClaims.status, ["lodged", "acknowledged", "in_repair"]),
          ),
        );
      if (Number(open[0]?.n ?? 0) === 0) {
        const warranty = await getWarranty(existing.warrantyId, req.companyId!);
        await app.db
          .update(warranties)
          .set({ status: warranty.endDate < todayISO() ? "expired" : "active" })
          .where(eq(warranties.id, existing.warrantyId));
      }
    }

    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: existing.projectId,
      actorId: req.user!.id,
      action: statusChanged ? "state_change" : "update",
      objectType: "warranty_claim",
      objectId: claimId,
      payload: statusChanged ? { from: existing.status, to: body.status, patch } : patch,
      storePayload: statusChanged,
    });
    return updated;
  });

  /** Warranty coverage summary for the twin dashboard. */
  app.get("/projects/:projectId/warranties/summary", { preHandler: gates.readGate }, async (req) => {
    const today = todayISO();
    const byStatus = await app.db
      .select({ status: warranties.status, n: count() })
      .from(warranties)
      .where(
        and(
          eq(warranties.companyId, req.companyId!),
          eq(warranties.projectId, req.projectId!),
        ),
      )
      .groupBy(warranties.status);
    const [next90] = await app.db
      .select({ n: count() })
      .from(warranties)
      .where(
        and(
          eq(warranties.companyId, req.companyId!),
          eq(warranties.projectId, req.projectId!),
          eq(warranties.status, "active"),
          gte(warranties.endDate, today),
          lte(warranties.endDate, addDays(today, 90)),
        ),
      );
    const [claimsOpen] = await app.db
      .select({ n: count() })
      .from(warrantyClaims)
      .where(
        and(
          eq(warrantyClaims.companyId, req.companyId!),
          eq(warrantyClaims.projectId, req.projectId!),
          inArray(warrantyClaims.status, ["lodged", "acknowledged", "in_repair"]),
        ),
      );
    return {
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])),
      expiringWithin90Days: Number(next90?.n ?? 0),
      openClaims: Number(claimsOpen?.n ?? 0),
    };
  });
};
