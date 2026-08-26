import type { FastifyPluginAsync } from "fastify";

/**
 * SPECIFICATIONS (M19, spec Vol I §2.3) — tool key `specifications`.
 *
 * The spec book as a record rather than a file: upload and split into
 * divisions and sections, revise sections with explicit supersession, and —
 * the part that earns the module — BUILD THE SUBMITTAL REGISTER FROM IT.
 * `spec_submittal_requirements` rows go identified → confirmed → registered,
 * and registration writes the real `submittals` row (field.ts) while keeping
 * `registeredSubmittalId` as the forward link.
 *
 * Schema: packages/db/src/schema/specifications.ts —
 *   spec_books, spec_divisions, spec_sections, spec_section_revisions,
 *   spec_submittal_requirements, spec_references.
 *
 * Planned route surface, all under `/api/v1`:
 *   /projects/:projectId/spec-books
 *   /projects/:projectId/spec-sections           (+ /:id/revisions)
 *   /projects/:projectId/spec-requirements       (+ /:id/register)
 *   /projects/:projectId/spec-references
 *
 * Routes land in a follow-up; registering the empty plugin now fixes the
 * mount point and the tool key so nothing has to be renamed later.
 */
export const specificationsModule: FastifyPluginAsync = async () => {
  // Routes to follow.
};
