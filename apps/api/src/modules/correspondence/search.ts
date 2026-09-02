/**
 * Company-wide search coverage for correspondence (cross-package contract
 * §3.3). The registry names `correspondence` as a type it expects a module to
 * register for itself; this is that registration.
 *
 * Registration is idempotent by type, so building several apps in one test
 * process never duplicates a source.
 */
import { registerSearchSource, tableSource } from "../search/registry.js";
import { correspondenceLetters, transmittals } from "@constructos/db";

export function registerCorrespondenceSearch(): void {
  registerSearchSource(
    tableSource({
      type: "correspondence",
      label: "Correspondence",
      tool: "correspondence",
      scope: "project",
      table: correspondenceLetters,
      columns: {
        id: correspondenceLetters.id,
        companyId: correspondenceLetters.companyId,
        projectId: correspondenceLetters.projectId,
        title: correspondenceLetters.subject,
        // The type, not the body: a letter body can be 100k characters and a
        // search hit is a one-line summary.
        subtitle: correspondenceLetters.typeKey,
        reference: correspondenceLetters.reference,
        status: correspondenceLetters.status,
        updatedAt: correspondenceLetters.updatedAt,
      },
      searchColumns: [
        correspondenceLetters.reference,
        correspondenceLetters.subject,
        correspondenceLetters.body,
      ],
      href: (row) =>
        row.projectId
          ? `/projects/${row.projectId}/correspondence?tab=letters&letter=${row.id}`
          : "/projects",
    }),
  );

  registerSearchSource(
    tableSource({
      type: "transmittal",
      label: "Transmittals",
      tool: "correspondence",
      scope: "project",
      table: transmittals,
      columns: {
        id: transmittals.id,
        companyId: transmittals.companyId,
        projectId: transmittals.projectId,
        title: transmittals.subject,
        subtitle: transmittals.purpose,
        reference: transmittals.reference,
        status: transmittals.status,
        updatedAt: transmittals.updatedAt,
      },
      searchColumns: [transmittals.reference, transmittals.subject, transmittals.coverNote],
      href: (row) =>
        row.projectId
          ? `/projects/${row.projectId}/correspondence?tab=transmittals&transmittal=${row.id}`
          : "/projects",
    }),
  );
}
