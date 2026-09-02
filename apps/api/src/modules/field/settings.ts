/**
 * Per-project field settings — the knobs the field engines read:
 * escalation ladder (#308/#321/#395/#411), punch closure gates (#403/#408),
 * submittal allowances (#337/#339/#347), daily-log distribution and weather
 * auto-capture (#373/#393), photo geofence radius.
 *
 * Stored as one jsonb row per project; every read goes through
 * `loadFieldSettings` so defaults are applied in exactly one place.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { fieldSettings } from "@constructos/db";
import type { Db } from "../../lib/db.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { assertCompanyUsers } from "./access.js";
import { nowIso } from "./shared.js";

export const fieldSettingsSchema = z.object({
  escalation: z
    .object({
      /** days between ladder rungs */
      stepDays: z.number().int().min(1).max(30).default(3),
      /** explicit PM list; empty = project members with a PM-class template + company admins */
      pmUserIds: z.array(z.string()).max(50).default([]),
      notifyResponsible: z.boolean().default(true),
    })
    .default({ stepDays: 3, pmUserIds: [], notifyResponsible: true }),
  punch: z
    .object({
      requireAfterPhoto: z.boolean().default(false),
      requireVerifier: z.boolean().default(false),
    })
    .default({ requireAfterPhoto: false, requireVerifier: false }),
  submittal: z
    .object({
      reviewAllowanceDays: z.number().int().min(0).max(120).default(14),
      atRiskDays: z.number().int().min(1).max(60).default(7),
      inCourtAllowanceDays: z.number().int().min(1).max(90).default(10),
    })
    .default({ reviewAllowanceDays: 14, atRiskDays: 7, inCourtAllowanceDays: 10 }),
  dailyLog: z
    .object({
      distribution: z.array(z.string()).max(100).default([]),
      weatherAuto: z.boolean().default(true),
      reconciliationThresholdPct: z.number().min(0).max(100).default(15),
    })
    .default({ distribution: [], weatherAuto: true, reconciliationThresholdPct: 15 }),
  photos: z
    .object({ geofenceKm: z.number().min(0.1).max(500).default(5) })
    .default({ geofenceKm: 5 }),
});

export type FieldSettings = z.infer<typeof fieldSettingsSchema>;

export const DEFAULT_FIELD_SETTINGS: FieldSettings = fieldSettingsSchema.parse({});

export async function loadFieldSettings(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<FieldSettings> {
  const row = (
    await db
      .select({ settings: fieldSettings.settings })
      .from(fieldSettings)
      .where(and(eq(fieldSettings.companyId, companyId), eq(fieldSettings.projectId, projectId)))
      .limit(1)
  )[0];
  if (!row) return DEFAULT_FIELD_SETTINGS;
  const parsed = fieldSettingsSchema.safeParse(row.settings);
  return parsed.success ? parsed.data : DEFAULT_FIELD_SETTINGS;
}

/** Settings routes. Reading needs `rfis:read`; writing needs `rfis:admin` (owners/admins bypass). */
export const fieldSettingsRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("rfis", "read")];
  const adminGate = [app.authenticate, app.requireCompany, app.requireTool("rfis", "admin")];

  app.get("/projects/:projectId/field/settings", { preHandler: readGate }, async (req) => {
    return {
      projectId: req.projectId!,
      settings: await loadFieldSettings(app.db, req.companyId!, req.projectId!),
      defaults: DEFAULT_FIELD_SETTINGS,
    };
  });

  app.put("/projects/:projectId/field/settings", { preHandler: adminGate }, async (req) => {
    const body = fieldSettingsSchema.parse(req.body ?? {});
    await assertCompanyUsers(app.db, req.companyId!, body.escalation.pmUserIds, "PM user");
    await assertCompanyUsers(app.db, req.companyId!, body.dailyLog.distribution, "distribution user");
    const existing = (
      await app.db
        .select({ id: fieldSettings.id })
        .from(fieldSettings)
        .where(and(eq(fieldSettings.companyId, req.companyId!), eq(fieldSettings.projectId, req.projectId!)))
        .limit(1)
    )[0];
    const id = existing?.id ?? newId("fset");
    if (existing) {
      await app.db
        .update(fieldSettings)
        .set({ settings: body, updatedBy: req.user!.id, updatedAt: nowIso() })
        .where(eq(fieldSettings.id, id));
    } else {
      await app.db.insert(fieldSettings).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        settings: body,
        updatedBy: req.user!.id,
      });
    }
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: existing ? "update" : "create",
      objectType: "field_settings",
      objectId: id,
      payload: { projectId: req.projectId!, settings: body },
      storePayload: true,
      projectId: req.projectId!,
    });
    return { projectId: req.projectId!, settings: body, defaults: DEFAULT_FIELD_SETTINGS };
  });
};
