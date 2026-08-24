import type { FastifyPluginAsync } from "fastify";
import { registerParcelRoutes } from "./parcels.js";
import { registerPapRoutes } from "./paps.js";
import { registerGrievanceRoutes } from "./grievances.js";
import { registerEngagementRoutes } from "./engagement.js";
import {
  ENGAGEMENT_KINDS,
  GRIEVANCE_CATEGORIES,
  GRIEVANCE_SLA,
  PARCEL_TRANSITIONS,
  STAKEHOLDER_CATEGORIES,
  STAKEHOLDER_QUADRANTS,
  VULNERABILITY_FLAGS,
} from "./reference.js";

/**
 * Land, resettlement & community — spec Vol III Tier 4 / module M16,
 * Vol II Domain J (#547-592 subset).
 *
 * The category of work Procore has no concept of, and frequently the largest
 * single source of delay on internationally financed infrastructure. Four
 * registers, one compliance frame (IFC Performance Standard 5 / World Bank
 * ESS5):
 *
 *  - Land parcels (#547-554): cadastral register with tenure — including
 *    customary and communal tenure that a title-only model cannot represent
 *    — the acquisition flow, and compensation that cannot be recorded
 *    without payment evidence. Plus the consent-to-programme dependency
 *    analysis (#591): which works are about to start on land the project
 *    does not hold, with an integrity signal when the answer is "soon".
 *
 *  - Project Affected Persons (#555-568): the census, vulnerability
 *    screening that drives enhanced entitlements, the entitlement matrix
 *    with a server-recomputed total, cut-off-date enforcement so the
 *    entitlement population cannot be inflated after declaration, and RAP
 *    progress reporting for lender supervision and independent monitoring.
 *
 *  - Grievance redress (#569-574): multi-channel intake including genuinely
 *    anonymous, a severity-driven SLA materialized as an assurance
 *    Obligation, a lazy breach sweep, closure verified WITH the complainant
 *    (a resolution the complainant rejects reopens the grievance), and the
 *    analytics an E&S supervision mission asks for.
 *
 *  - Stakeholders & engagement (#579-584): the register with influence /
 *    interest mapping and the consultation log carrying feedback
 *    disposition and FPIC consent status.
 *
 * Every consequential mutation is appended to the company's hash-chained
 * ledger; compensation payments and closure verifications store their full
 * payload, because those are the records an auditor comes back for.
 */
export const landModule: FastifyPluginAsync = async (app) => {
  /** Reference data (code-resident, not tenant data) — the published GRM
   *  service standard and the closed value sets the module enforces. */
  app.get("/land/reference", { preHandler: [app.authenticate] }, async () => ({
    grievanceSla: GRIEVANCE_SLA,
    grievanceCategories: GRIEVANCE_CATEGORIES,
    vulnerabilityFlags: VULNERABILITY_FLAGS,
    parcelTransitions: PARCEL_TRANSITIONS,
    stakeholderCategories: STAKEHOLDER_CATEGORIES,
    stakeholderQuadrants: STAKEHOLDER_QUADRANTS,
    engagementKinds: ENGAGEMENT_KINDS,
  }));

  await registerParcelRoutes(app);
  await registerPapRoutes(app);
  await registerGrievanceRoutes(app);
  await registerEngagementRoutes(app);
};
