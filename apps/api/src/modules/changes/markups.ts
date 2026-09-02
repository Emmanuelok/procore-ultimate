import type { FastifyPluginAsync } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { changeMarkupSchedules, primeContracts, projects } from "@constructos/db";
import { newId } from "../../lib/ids.js";
import { badRequest } from "../../lib/errors.js";
import type { Db } from "../../lib/db.js";
import { validateMarkupStack, type MarkupRule } from "./arithmetic.js";
import {
  actorOf,
  changeGates,
  companyOf,
  idSchema,
  ledgerChange,
  markupRuleSchema,
  projectOf,
  readMarkups,
} from "./shared.js";

/**
 * MARKUP SCHEDULES (spec #554) — the contractual OH&P stack, configurable.
 *
 * Before this file `defaultMarkups` read `projects.settings.changeMarkups`,
 * which nothing wrote, so every change order request raised from the web
 * carried zero markup and the revenue on every owner change was understated
 * until somebody called the API by hand. Now a project carries a markup
 * schedule, a prime contract may override it, and each may be BANDED by the
 * cost subtotal the change falls in — "15% OH&P under 50k, 10% to 250k, 5%
 * above" — which is how most owner contracts actually write it.
 *
 * Resolution order at COR creation: explicit markups on the request → the
 * prime contract's schedule → the project's schedule → the legacy project
 * setting → nothing (recorded as `markupSource: "none"` so the zero is
 * visible, never silent).
 */

export interface MarkupBand {
  /** inclusive upper bound of the cost subtotal this band covers; null = open-ended */
  upTo: number | null;
  rules: MarkupRule[];
}

export interface MarkupSchedule {
  id: string;
  name: string;
  primeContractId: string | null;
  rules: MarkupRule[];
  bands: MarkupBand[];
}

const bandSchema = z.object({
  upTo: z.number().finite().positive().nullable(),
  rules: z.array(markupRuleSchema).max(20),
});

const putSchema = z.object({
  name: z.string().min(1).max(200).default("Standard markups"),
  rules: z.array(markupRuleSchema).max(20).default([]),
  bands: z.array(bandSchema).max(20).default([]),
});

export function readBands(stored: unknown): MarkupBand[] {
  if (!Array.isArray(stored)) return [];
  const out: MarkupBand[] = [];
  for (const raw of stored) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const upTo = typeof r["upTo"] === "number" && Number.isFinite(r["upTo"]) ? r["upTo"] : null;
    out.push({ upTo, rules: readMarkups(r["rules"]) });
  }
  return out;
}

/** Pure: validate a schedule — every stack valid, bands ascending, at most one open band, last. */
export function validateSchedule(input: { rules: MarkupRule[]; bands: MarkupBand[] }): string[] {
  const problems = validateMarkupStack(input.rules).map((p) => `Default rules: ${p}`);
  let prev = 0;
  for (const [i, band] of input.bands.entries()) {
    for (const p of validateMarkupStack(band.rules)) problems.push(`Band ${i + 1}: ${p}`);
    if (band.upTo === null) {
      if (i !== input.bands.length - 1) problems.push(`Band ${i + 1} is open-ended but is not the last band.`);
    } else if (band.upTo <= prev) {
      problems.push(`Band ${i + 1} (up to ${band.upTo}) must be above the previous band (${prev}).`);
    } else {
      prev = band.upTo;
    }
  }
  return problems;
}

/** Pure: which rules apply to a change whose cost subtotal is `subtotal`. */
export function rulesForSubtotal(schedule: { rules: MarkupRule[]; bands: MarkupBand[] }, subtotal: number): {
  rules: MarkupRule[];
  band: MarkupBand | null;
} {
  const magnitude = Math.abs(subtotal);
  for (const band of schedule.bands) {
    if (band.upTo === null || magnitude <= band.upTo + 0.005) return { rules: band.rules, band };
  }
  return { rules: schedule.rules, band: null };
}

export interface ResolvedMarkups {
  rules: MarkupRule[];
  source: "request" | "prime_contract" | "project" | "legacy_setting" | "none";
  scheduleId: string | null;
  band: MarkupBand | null;
}

/** The schedule that governs a contract on a project, or null. */
export async function loadSchedule(
  db: Db,
  companyId: string,
  projectId: string,
  primeContractId: string | null,
): Promise<{ schedule: MarkupSchedule; source: "prime_contract" | "project" } | null> {
  const rows = await db
    .select()
    .from(changeMarkupSchedules)
    .where(and(eq(changeMarkupSchedules.companyId, companyId), eq(changeMarkupSchedules.projectId, projectId)));
  const toSchedule = (r: (typeof rows)[number]): MarkupSchedule => ({
    id: r.id,
    name: r.name,
    primeContractId: r.primeContractId,
    rules: readMarkups(r.rules),
    bands: readBands(r.bands),
  });
  const contractRow = primeContractId ? rows.find((r) => r.primeContractId === primeContractId) : undefined;
  if (contractRow) return { schedule: toSchedule(contractRow), source: "prime_contract" };
  const projectRow = rows.find((r) => r.primeContractId === null);
  if (projectRow) return { schedule: toSchedule(projectRow), source: "project" };
  return null;
}

/** Resolve the markups a new COR should carry. */
export async function resolveMarkups(
  db: Db,
  companyId: string,
  projectId: string,
  primeContractId: string | null,
  explicit: MarkupRule[] | undefined,
  subtotal: number,
): Promise<ResolvedMarkups> {
  if (explicit) return { rules: explicit, source: "request", scheduleId: null, band: null };
  const found = await loadSchedule(db, companyId, projectId, primeContractId);
  if (found) {
    const { rules, band } = rulesForSubtotal(found.schedule, subtotal);
    return { rules, source: found.source, scheduleId: found.schedule.id, band };
  }
  const legacy = await db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, projectId)).limit(1);
  const rules = readMarkups((legacy[0]?.settings ?? {})["changeMarkups"]);
  if (rules.length > 0) return { rules, source: "legacy_setting", scheduleId: null, band: null };
  return { rules: [], source: "none", scheduleId: null, band: null };
}

export const markupRoutes: FastifyPluginAsync = async (app) => {
  const gates = changeGates(app);

  /** Project schedule plus every contract override. */
  app.get("/projects/:projectId/change-markups", { preHandler: gates.read }, async (req) => {
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const rows = await app.db
      .select()
      .from(changeMarkupSchedules)
      .where(and(eq(changeMarkupSchedules.companyId, companyId), eq(changeMarkupSchedules.projectId, projectId)));
    const legacy = await app.db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, projectId)).limit(1);
    const legacyRules = readMarkups((legacy[0]?.settings ?? {})["changeMarkups"]);
    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      primeContractId: r.primeContractId,
      rules: readMarkups(r.rules),
      bands: readBands(r.bands),
      updatedBy: r.updatedBy,
      updatedAt: r.updatedAt,
    }));
    return {
      projectId,
      project: items.find((i) => i.primeContractId === null) ?? null,
      contracts: items.filter((i) => i.primeContractId !== null),
      legacyRules,
      note:
        items.length === 0 && legacyRules.length === 0
          ? "No markup schedule is configured. Change order requests raised on this project carry ZERO markup until one is saved here."
          : null,
    };
  });

  /** Create or replace the project default (no primeContractId) or a contract override. */
  app.put("/projects/:projectId/change-markups", { preHandler: gates.admin }, async (req) => {
    const q = z.object({ primeContractId: idSchema.optional() }).parse(req.query ?? {});
    const body = putSchema.parse(req.body ?? {});
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const bands = body.bands.map((b) => ({ upTo: b.upTo, rules: b.rules as MarkupRule[] }));
    const problems = validateSchedule({ rules: body.rules as MarkupRule[], bands });
    if (problems.length > 0) throw badRequest(problems.join(" "), { problems });
    if (q.primeContractId) {
      const c = await app.db
        .select({ id: primeContracts.id })
        .from(primeContracts)
        .where(and(eq(primeContracts.id, q.primeContractId), eq(primeContracts.companyId, companyId), eq(primeContracts.projectId, projectId)))
        .limit(1);
      if (!c[0]) throw badRequest("primeContractId does not reference a prime contract on this project");
    }
    const existing = await app.db
      .select({ id: changeMarkupSchedules.id })
      .from(changeMarkupSchedules)
      .where(
        and(
          eq(changeMarkupSchedules.projectId, projectId),
          q.primeContractId ? eq(changeMarkupSchedules.primeContractId, q.primeContractId) : isNull(changeMarkupSchedules.primeContractId),
        ),
      )
      .limit(1);
    const now = new Date().toISOString();
    let id = existing[0]?.id;
    if (id) {
      await app.db
        .update(changeMarkupSchedules)
        .set({ name: body.name, rules: body.rules, bands, updatedBy: actorOf(req), updatedAt: now })
        .where(eq(changeMarkupSchedules.id, id));
    } else {
      id = newId("cms");
      await app.db.insert(changeMarkupSchedules).values({
        id,
        companyId,
        projectId,
        primeContractId: q.primeContractId ?? null,
        name: body.name,
        rules: body.rules,
        bands,
        createdBy: actorOf(req),
        updatedBy: actorOf(req),
      });
    }
    await ledgerChange(
      app.db,
      req,
      existing[0] ? "update" : "create",
      "change_markup_schedule",
      id,
      { primeContractId: q.primeContractId ?? null, rules: body.rules, bands },
      { storePayload: true },
    );
    const row = (await app.db.select().from(changeMarkupSchedules).where(eq(changeMarkupSchedules.id, id)).limit(1))[0]!;
    return { ...row, rules: readMarkups(row.rules), bands: readBands(row.bands) };
  });

  app.delete("/projects/:projectId/change-markups/:scheduleId", { preHandler: gates.admin }, async (req, reply) => {
    const { scheduleId } = req.params as { scheduleId: string };
    const projectId = projectOf(req);
    const row = (
      await app.db
        .select()
        .from(changeMarkupSchedules)
        .where(and(eq(changeMarkupSchedules.id, scheduleId), eq(changeMarkupSchedules.projectId, projectId)))
        .limit(1)
    )[0];
    if (!row) return reply.status(404).send({ error: "NotFound", message: "Markup schedule not found" });
    await app.db.delete(changeMarkupSchedules).where(eq(changeMarkupSchedules.id, scheduleId));
    await ledgerChange(app.db, req, "delete", "change_markup_schedule", scheduleId, { primeContractId: row.primeContractId });
    return reply.status(204).send();
  });

  /** Preview which rules a subtotal would attract — what the COR modal shows. */
  app.get("/projects/:projectId/change-markups/resolve", { preHandler: gates.read }, async (req) => {
    const q = z
      .object({ primeContractId: idSchema.optional(), subtotal: z.coerce.number().finite().default(0) })
      .parse(req.query ?? {});
    const resolved = await resolveMarkups(app.db, companyOf(req), projectOf(req), q.primeContractId ?? null, undefined, q.subtotal);
    return resolved;
  });
};
