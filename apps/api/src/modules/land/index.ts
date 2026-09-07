import type { FastifyPluginAsync } from "fastify";
import { grievances, landParcels } from "@constructos/db";
import { registerSearchSource, tableSource } from "../search/registry.js";
import { registerParcelRoutes } from "./parcels.js";
import { registerPapRoutes } from "./paps.js";
import { registerGrievanceRoutes } from "./grievances.js";
import { registerGrievanceTriageRoutes } from "./grievances-triage.js";
import { registerEngagementRoutes } from "./engagement.js";
import { registerSafeguardRoutes } from "./safeguards.js";
import { registerLandJobs } from "./detectors.js";
import { ACQUISITION_BASES } from "@constructos/shared";
import {
  ENGAGEMENT_KINDS,
  GRIEVANCE_CATEGORIES,
  GRIEVANCE_SLA,
  PAP_TRANSITIONS,
  PARCEL_ACQUIRABLE_FROM,
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
 *    analytics an E&S supervision mission asks for. Intake is assisted, not
 *    automated: `grievances-triage.ts` ranks the closest precedents this
 *    project has already handled (tf-idf, no external service, works with
 *    the model switched off), cites the published SLA rule behind a proposed
 *    severity, and records the proposal against the officer's decision so
 *    the assistant's agreement rate is measured rather than assumed. A
 *    grievance naming a household also flags that household
 *    (`pap-grievance.ts`), reversibly: the flag is an overlay on the
 *    resettlement lifecycle, never a replacement for it.
 *
 *  - Stakeholders & engagement (#579-584): the register with influence /
 *    interest mapping and the consultation log carrying feedback
 *    disposition and FPIC consent status.
 *
 *  - Resettlement DEPTH (safeguards.ts): replacement-cost verification
 *    (#550), Indigenous Peoples & cultural heritage plans with tracked
 *    commitments and the chance-find register (PS7/PS8, #575-578),
 *    livelihood restoration measured as income against the pre-displacement
 *    baseline (#561), and the RAP completion audit + lender supervision pack
 *    that freezes both the indicator set and the ledger sequence it was
 *    built from (#558-560, #568).
 *
 * Every consequential mutation is appended to the company's hash-chained
 * ledger; compensation payments, acquisitions and closure verifications
 * store their full payload, because those are the records an auditor comes
 * back for.
 *
 * HOW FINDINGS ARE RAISED. Every signal in this area — grievance SLA breach
 * and automatic escalation, grievance hotspots, IFC PS5 conformance,
 * replacement-cost shortfall, unnotified chance finds and the
 * consent-to-programme dependency — is raised by ONE set of sweep functions
 * (`detectors.ts`, `consent-service.ts`) as the SYSTEM actor, advisory-locked
 * and fingerprinted so a finding is raised once and auto-closes when its
 * condition clears. Each sweep has two triggers running the same function:
 * the scheduled `land.detectors` job (hourly, every tenant, so a project
 * nobody opens is still policed) and the register read the finding is about
 * — `GET /grievances` and `GET /land/schedule-risk` — scoped to the project
 * being read, so the register never shows a breach it has not recorded and a
 * deployment whose scheduler is off (SCHEDULER_ENABLED=false, NODE_ENV=test)
 * is still policed. Whoever opened the page is never the ledger actor.
 */
export const landModule: FastifyPluginAsync = async (app) => {
  /** Reference data (code-resident, not tenant data) — the published GRM
   *  service standard and the closed value sets the module enforces. */
  app.get("/land/reference", { preHandler: [app.authenticate] }, async () => ({
    grievanceSla: GRIEVANCE_SLA,
    grievanceCategories: GRIEVANCE_CATEGORIES,
    vulnerabilityFlags: VULNERABILITY_FLAGS,
    parcelTransitions: PARCEL_TRANSITIONS,
    parcelAcquirableFrom: PARCEL_ACQUIRABLE_FROM,
    papTransitions: PAP_TRANSITIONS,
    acquisitionBases: ACQUISITION_BASES,
    stakeholderCategories: STAKEHOLDER_CATEGORIES,
    stakeholderQuadrants: STAKEHOLDER_QUADRANTS,
    engagementKinds: ENGAGEMENT_KINDS,
  }));

  /*
   * Company-wide search (contract §3.3). A cadastral reference and a
   * grievance are exactly what someone types into ⌘K — "CAD/12/447", "dust
   * Kibaale" — and a register nobody can find from the search box is a
   * register nobody uses. Both sources carry the `land` tool, so search
   * respects the same gate the workspace does.
   */
  registerSearchSource(
    tableSource({
      type: "land_parcel",
      label: "Land parcel",
      tool: "land",
      scope: "project",
      table: landParcels,
      columns: {
        id: landParcels.id,
        companyId: landParcels.companyId,
        projectId: landParcels.projectId,
        title: landParcels.reference,
        subtitle: landParcels.ownerName,
        status: landParcels.status,
        updatedAt: landParcels.updatedAt,
      },
      searchColumns: [landParcels.reference, landParcels.ownerName, landParcels.description],
      href: (r) => (r.projectId ? `/projects/${r.projectId}/land?tab=parcels` : "/"),
    }),
  );
  registerSearchSource(
    tableSource({
      type: "grievance",
      label: "Grievance",
      tool: "land",
      scope: "project",
      table: grievances,
      columns: {
        id: grievances.id,
        companyId: grievances.companyId,
        projectId: grievances.projectId,
        title: grievances.description,
        subtitle: grievances.category,
        reference: grievances.number,
        status: grievances.status,
        updatedAt: grievances.updatedAt,
      },
      searchColumns: [grievances.description, grievances.resolution],
      href: (r) => (r.projectId ? `/projects/${r.projectId}/land?tab=grievances` : "/"),
    }),
  );

  await registerParcelRoutes(app);
  await registerPapRoutes(app);
  await registerGrievanceRoutes(app);
  await registerGrievanceTriageRoutes(app);
  await registerEngagementRoutes(app);
  await registerSafeguardRoutes(app);

  /*
   * The scheduled trigger. Every land finding — grievance SLA breach and
   * automatic escalation, grievance hotspots, IFC PS5 conformance,
   * replacement-cost shortfall, unnotified chance finds and the
   * consent-to-programme dependency — is raised by this job as the SYSTEM
   * actor, hourly, for every tenant. The grievance and schedule-risk reads
   * run the same functions for the project they are reading (see
   * grievances.ts and parcels.ts); the lock and the fingerprint inside the
   * sweeps are what stopped the old read-time duplicates, so the two
   * triggers claim each finding exactly once.
   */
  registerLandJobs(app);
};
