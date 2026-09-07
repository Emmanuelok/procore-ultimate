/**
 * Company-wide search coverage for estimating (cross-package contract §3.3).
 *
 * The registry did not exist when this module was written; it does now, so
 * the three estimating records a person reaches for BY NAME register with the
 * ⌘K palette:
 *
 *   - the estimate — "Northgate substructure GMP", or its EST-004 reference;
 *   - the measurement — "external walls, level 3", the thing an estimator
 *     goes looking for when a drawing is revised;
 *   - the sub-quote — by the subcontractor's name or its SQ-012 reference,
 *     which is how a commercial manager asks for it out loud.
 *
 * The rate library deliberately does NOT register. It is company-level data
 * with no project to scope a hit to, it is browsed through its own filtered
 * table rather than looked up by name, and a search that surfaced the
 * company's margin build-up to anybody holding `estimating` read on one
 * project would be a wider disclosure than the library's own gate allows.
 *
 * Registration is idempotent by type, so building several apps in one test
 * process never duplicates a source.
 */
import { estimateSubQuotes, estimates, takeoffItems } from "@constructos/db";
import { registerSearchSource, tableSource } from "../search/registry.js";

export function registerEstimatingSearch(): void {
  registerSearchSource(
    tableSource({
      type: "estimate",
      label: "Estimates",
      tool: "estimating",
      scope: "project",
      table: estimates,
      columns: {
        id: estimates.id,
        companyId: estimates.companyId,
        projectId: estimates.projectId,
        title: estimates.name,
        subtitle: estimates.description,
        reference: estimates.reference,
        status: estimates.status,
        updatedAt: estimates.updatedAt,
      },
      searchColumns: [estimates.name, estimates.reference, estimates.description],
      href: (row) =>
        row.projectId ? `/projects/${row.projectId}/estimating?tab=estimates` : "/projects",
    }),
  );

  registerSearchSource(
    tableSource({
      type: "takeoff_item",
      label: "Takeoff",
      tool: "estimating",
      scope: "project",
      weight: 0.9,
      table: takeoffItems,
      columns: {
        id: takeoffItems.id,
        companyId: takeoffItems.companyId,
        projectId: takeoffItems.projectId,
        title: takeoffItems.name,
        subtitle: takeoffItems.costCode,
        status: takeoffItems.status,
        updatedAt: takeoffItems.updatedAt,
      },
      searchColumns: [takeoffItems.name, takeoffItems.costCode, takeoffItems.sheetNumber],
      href: (row) =>
        row.projectId ? `/projects/${row.projectId}/estimating?tab=takeoff` : "/projects",
    }),
  );

  registerSearchSource(
    tableSource({
      type: "estimate_sub_quote",
      label: "Sub-quotes",
      tool: "estimating",
      scope: "project",
      table: estimateSubQuotes,
      columns: {
        id: estimateSubQuotes.id,
        companyId: estimateSubQuotes.companyId,
        projectId: estimateSubQuotes.projectId,
        title: estimateSubQuotes.vendorName,
        subtitle: estimateSubQuotes.tradePackage,
        reference: estimateSubQuotes.reference,
        status: estimateSubQuotes.status,
        updatedAt: estimateSubQuotes.updatedAt,
      },
      searchColumns: [
        estimateSubQuotes.vendorName,
        estimateSubQuotes.tradePackage,
        estimateSubQuotes.reference,
      ],
      href: (row) =>
        row.projectId ? `/projects/${row.projectId}/estimating?tab=quotes` : "/projects",
    }),
  );
}
