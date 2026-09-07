/**
 * Company-wide search coverage for the commercial register (cross-package
 * contract §3.3).
 *
 * The variation register and the bills are what a commercial manager reaches
 * for by name ("VO 14", "external works remeasure"), so both register with the
 * ⌘K palette. Valuations and certificates deliberately do NOT: they are
 * numbered, not named, and a free-text hit on a period application is noise.
 *
 * Registration is idempotent by type, so building several apps in one test
 * process never duplicates a source.
 */
import { boqs, variations } from "@constructos/db";
import { registerSearchSource, tableSource } from "../search/registry.js";

export function registerCommercialSearch(): void {
  registerSearchSource(
    tableSource({
      type: "variation",
      label: "Variations",
      tool: "commercial",
      scope: "project",
      table: variations,
      columns: {
        id: variations.id,
        companyId: variations.companyId,
        projectId: variations.projectId,
        title: variations.title,
        subtitle: variations.instructionRef,
        reference: variations.clauseRef,
        status: variations.status,
        updatedAt: variations.updatedAt,
      },
      searchColumns: [
        variations.title,
        variations.description,
        variations.instructionRef,
        variations.clauseRef,
      ],
      href: (row) =>
        row.projectId ? `/projects/${row.projectId}/commercial?tab=variations` : "/projects",
    }),
  );

  registerSearchSource(
    tableSource({
      type: "boq",
      label: "Bills of quantities",
      tool: "commercial",
      scope: "project",
      table: boqs,
      columns: {
        id: boqs.id,
        companyId: boqs.companyId,
        projectId: boqs.projectId,
        title: boqs.name,
        subtitle: boqs.method,
        status: boqs.status,
        updatedAt: boqs.updatedAt,
      },
      searchColumns: [boqs.name, boqs.notes],
      href: (row) =>
        row.projectId ? `/projects/${row.projectId}/commercial?tab=boq` : "/projects",
    }),
  );
}
