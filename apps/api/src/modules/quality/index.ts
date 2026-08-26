import type { FastifyPluginAsync } from "fastify";

/**
 * QUALITY (M22) — tool key `quality`.
 *
 * ITPs with hold and witness points (and the notice period a hold point turns
 * on), typed checklists and their templates, non-conformance reports whose
 * disposition is a segregated act, and commissioning: systems and subsystems,
 * pre-functional and functional test records, and turnover packages that hand
 * over INTO the twin asset register (twin.ts) rather than beside it.
 *
 * Schema: packages/db/src/schema/quality.ts —
 *   inspection_test_plans, itp_activities, checklist_templates,
 *   checklist_template_items, checklists, checklist_responses,
 *   non_conformance_reports, commissioning_systems,
 *   commissioning_test_records, turnover_packages.
 *
 * Planned route surface, all under `/api/v1`:
 *   /projects/:projectId/itps              (+ /:id/activities, /:id/release)
 *   /projects/:projectId/checklists        (+ /:id/responses)
 *   /projects/:projectId/ncrs              (+ /:id/disposition, /:id/close)
 *   /projects/:projectId/commissioning/systems
 *   /projects/:projectId/commissioning/test-records
 *   /projects/:projectId/turnover-packages
 *   /companies/current/checklist-templates
 *
 * Routes land in a follow-up; registering the empty plugin now fixes the
 * mount point and the tool key so nothing has to be renamed later.
 */
export const qualityModule: FastifyPluginAsync = async () => {
  // Routes to follow.
};
