import type { FastifyPluginAsync } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { changeConfigs, projects } from "@constructos/db";
import { CHANGE_MANAGEMENT_TIERS, CHANGE_STAGES, type ChangeManagementTier, type ChangeStage } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import type { Db } from "../../lib/db.js";
import { actorOf, changeGates, companyOf, ledgerChange, projectOf } from "./shared.js";

/**
 * CHANGE-MANAGEMENT TIER CONFIGURATION (spec #563).
 *
 * Procore's one/two/three-tier setting decides how many documents stand
 * between "something happened" and "money moved". Here the tier is a project
 * fact with a stage list, and the package route REFUSES members that skipped
 * a mandatory stage for their tier:
 *
 *   one_tier    event → package. A PCO may be packaged straight from its
 *               approved cost position; no owner request is required.
 *   two_tier    event → PCO → package on the commitment side, and
 *               event → COR → package on the owner side (the default).
 *   three_tier  the full chain: a subcontract PCO must be inside an approved
 *               COR before it packages, and (optionally) must carry an
 *               accepted RFQ.
 */

export interface TierDefinition {
  tier: ChangeManagementTier;
  label: string;
  stages: ChangeStage[];
  description: string;
  /** a commitment package may include a PCO not yet inside an approved COR */
  packageWithoutCor: boolean;
}

export const TIER_DEFINITIONS: Record<ChangeManagementTier, TierDefinition> = {
  one_tier: {
    tier: "one_tier",
    label: "One tier",
    stages: ["event", "package"],
    description: "An approved change event executes directly; a PCO is priced and packaged without an owner request.",
    packageWithoutCor: true,
  },
  two_tier: {
    tier: "two_tier",
    label: "Two tier",
    stages: ["event", "pco", "cor", "package"],
    description: "Cost is priced on a PCO and packaged; revenue is requested on a COR and packaged. The default.",
    packageWithoutCor: true,
  },
  three_tier: {
    tier: "three_tier",
    label: "Three tier",
    stages: ["event", "pco", "rfq", "cor", "package"],
    description: "Every subcontract PCO must be quoted, rolled into an approved owner request and only then packaged.",
    packageWithoutCor: false,
  },
};

export interface ChangeConfig {
  projectId: string;
  tier: ChangeManagementTier;
  requireQuoteForSubcontract: boolean;
  stages: ChangeStage[];
  definition: TierDefinition;
  source: "config" | "project_setting" | "default";
}

/** The project's effective configuration: the config row, else the legacy setting, else two-tier. */
export async function loadChangeConfig(db: Db, projectId: string): Promise<ChangeConfig> {
  const rows = await db.select().from(changeConfigs).where(eq(changeConfigs.projectId, projectId)).limit(1);
  const row = rows[0];
  if (row && (CHANGE_MANAGEMENT_TIERS as readonly string[]).includes(row.tier)) {
    const tier = row.tier as ChangeManagementTier;
    return {
      projectId,
      tier,
      requireQuoteForSubcontract: row.requireQuoteForSubcontract === 1,
      stages: TIER_DEFINITIONS[tier].stages,
      definition: TIER_DEFINITIONS[tier],
      source: "config",
    };
  }
  const proj = await db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, projectId)).limit(1);
  const raw = (proj[0]?.settings ?? {})["changeManagementTier"];
  const tier: ChangeManagementTier =
    typeof raw === "string" && (CHANGE_MANAGEMENT_TIERS as readonly string[]).includes(raw) ? (raw as ChangeManagementTier) : "two_tier";
  return {
    projectId,
    tier,
    requireQuoteForSubcontract: false,
    stages: TIER_DEFINITIONS[tier].stages,
    definition: TIER_DEFINITIONS[tier],
    source: typeof raw === "string" ? "project_setting" : "default",
  };
}

/**
 * Pure: the stages a member skipped for the tier. `hasCor` = inside an
 * approved COR; `hasQuote` = an accepted RFQ; `subcontract` = the PCO prices
 * subcontract cost (self-performed work has nobody to quote).
 */
export function skippedStages(
  config: { tier: ChangeManagementTier; requireQuoteForSubcontract: boolean },
  member: { hasCor: boolean; hasAcceptedQuote: boolean; subcontract: boolean },
): ChangeStage[] {
  const skipped: ChangeStage[] = [];
  if (config.tier === "three_tier") {
    if (!member.hasCor) skipped.push("cor");
    if (config.requireQuoteForSubcontract && member.subcontract && !member.hasAcceptedQuote) skipped.push("rfq");
  }
  return skipped;
}

const putSchema = z.object({
  tier: z.enum(CHANGE_MANAGEMENT_TIERS),
  requireQuoteForSubcontract: z.boolean().optional(),
});

export const changeConfigRoutes: FastifyPluginAsync = async (app) => {
  const gates = changeGates(app);

  app.get("/projects/:projectId/change-config", { preHandler: gates.read }, async (req) => {
    const config = await loadChangeConfig(app.db, projectOf(req));
    return { ...config, tiers: Object.values(TIER_DEFINITIONS), allStages: CHANGE_STAGES };
  });

  app.put("/projects/:projectId/change-config", { preHandler: gates.admin }, async (req) => {
    const body = putSchema.parse(req.body);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const existing = await app.db
      .select({ id: changeConfigs.id })
      .from(changeConfigs)
      .where(and(eq(changeConfigs.companyId, companyId), eq(changeConfigs.projectId, projectId)))
      .limit(1);
    const now = new Date().toISOString();
    const values = {
      tier: body.tier,
      requireQuoteForSubcontract: body.requireQuoteForSubcontract ? 1 : 0,
      updatedBy: actorOf(req),
      updatedAt: now,
    };
    let id = existing[0]?.id;
    if (id) {
      await app.db.update(changeConfigs).set(values).where(eq(changeConfigs.id, id));
    } else {
      id = newId("ccfg");
      await app.db.insert(changeConfigs).values({ id, companyId, projectId, ...values });
    }
    await ledgerChange(app.db, req, existing[0] ? "update" : "create", "change_config", id, {
      tier: body.tier,
      requireQuoteForSubcontract: body.requireQuoteForSubcontract === true,
    });
    const config = await loadChangeConfig(app.db, projectId);
    return { ...config, tiers: Object.values(TIER_DEFINITIONS), allStages: CHANGE_STAGES };
  });
};
