import type { FastifyPluginAsync } from "fastify";

/**
 * SAFETY (M21, spec Vol I §2.11) — tool key `safety`.
 *
 * Observations (positive and negative), incidents in the vocabulary an
 * insurer and a regulator actually use (treatment level, body part,
 * mechanism, RIDDOR/OSHA classification, statutory reporting clock),
 * inspections against templates, toolbox talks with attendance, and the
 * expiring documentary programme. Corrective actions from every one of those
 * registers — and from quality NCRs — land in ONE table so a project has one
 * overdue-actions list.
 *
 * Schema: packages/db/src/schema/safety.ts —
 *   safety_observations, safety_incidents, safety_corrective_actions,
 *   safety_inspection_templates, safety_inspections, toolbox_talks,
 *   toolbox_talk_attendees, safety_programme_records.
 *
 * Planned route surface, all under `/api/v1`:
 *   /projects/:projectId/observations
 *   /projects/:projectId/incidents         (+ /:id/investigation, /report)
 *   /projects/:projectId/corrective-actions
 *   /projects/:projectId/safety-inspections
 *   /projects/:projectId/toolbox-talks     (+ /:id/attendees)
 *   /companies/current/safety-templates
 *   /companies/current/safety-programme-records
 *
 * Routes land in a follow-up; registering the empty plugin now fixes the
 * mount point and the tool key so nothing has to be renamed later.
 */
export const safetyModule: FastifyPluginAsync = async () => {
  // Routes to follow.
};
