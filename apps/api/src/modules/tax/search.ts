/**
 * Company-wide search coverage for the tax registers (cross-package contract
 * §3.3). The registry did not exist when this module was written; it does
 * now, so the two tax records a person reaches for BY NAME register with the
 * ⌘K palette:
 *
 *   - the withholding certificate — looked up by the payee's name or by the
 *     printed statement reference the payee quotes ("CIS-2026-04-0003");
 *   - the permanent-establishment exposure — looked up by the person or
 *     entity whose days are being counted.
 *
 * Determinations, periods and registrations deliberately do NOT register:
 * they are numbered or keyed, not named, so a free-text hit on them is noise
 * (the same call modules/commercial makes for valuations). Registration is
 * idempotent by type, so building several apps in one test process never
 * duplicates a source.
 */
import { peExposures, withholdingCertificates } from "@constructos/db";
import { registerSearchSource, tableSource } from "../search/registry.js";

export function registerTaxSearch(): void {
  registerSearchSource(
    tableSource({
      type: "withholding_certificate",
      label: "Withholding certificates",
      tool: "tax",
      scope: "project",
      table: withholdingCertificates,
      columns: {
        id: withholdingCertificates.id,
        companyId: withholdingCertificates.companyId,
        projectId: withholdingCertificates.projectId,
        title: withholdingCertificates.vendorName,
        subtitle: withholdingCertificates.scheme,
        reference: withholdingCertificates.reference,
        status: withholdingCertificates.status,
        updatedAt: withholdingCertificates.updatedAt,
      },
      searchColumns: [withholdingCertificates.vendorName, withholdingCertificates.reference],
      href: (row) => (row.projectId ? `/projects/${row.projectId}/tax?tab=certificates` : "/projects"),
    }),
  );

  registerSearchSource(
    tableSource({
      type: "pe_exposure",
      label: "PE exposures",
      tool: "tax",
      scope: "project",
      table: peExposures,
      columns: {
        id: peExposures.id,
        companyId: peExposures.companyId,
        projectId: peExposures.projectId,
        title: peExposures.entityName,
        subtitle: peExposures.hostCountry,
        status: peExposures.status,
        updatedAt: peExposures.updatedAt,
      },
      searchColumns: [peExposures.entityName],
      href: (row) => (row.projectId ? `/projects/${row.projectId}/tax?tab=pe` : "/projects"),
    }),
  );
}
