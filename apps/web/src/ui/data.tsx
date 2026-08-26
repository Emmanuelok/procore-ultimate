/**
 * ../ui/data — the DATA layer.
 *
 *     import { DataTable, KanbanBoard, TreeView } from "../../ui";
 *
 * A Procore-class application is thousands of dense records, and the grid is
 * where users live. Everything in this layer is built for that: virtualised so
 * 50,000 rows scroll at 60fps, keyboard-driven end to end, and dense by default
 * with a comfortable mode a keystroke away.
 *
 * ---------------------------------------------------------------------------
 * THE SHORT VERSION
 *
 *   const columns: DataColumns<Commitment> = [
 *     { id: "number",  header: "Number",  accessor: "number", type: "code", sticky: "start", width: 120 },
 *     { id: "vendor",  header: "Vendor",  accessor: "vendor.name", type: "text" },
 *     { id: "status",  header: "Status",  accessor: "status", type: "status", groupable: true },
 *     { id: "value",   header: "Value",   accessor: "contractValue", type: "currency", aggregate: "sum" },
 *     { id: "variance",header: "Variance",accessor: "variance", type: "currency", signColor: true },
 *     { id: "due",     header: "Due",     accessor: "dueDate", type: "date" },
 *   ];
 *
 *   <DataTable
 *     tableId="commitments"        // saved views + layout persistence
 *     data={rows}
 *     columns={columns}
 *     getRowId={(row) => row.id}
 *     height={640}                 // bounded height ⇒ virtualisation
 *     selectable="multi"
 *     filterRow
 *     showFooter
 *     rowHref={(row) => `/commitments/${row.id}`}
 *     bulkActions={[{ id: "export", label: "Export", onSelect: exportRows }]}
 *   />
 *
 * ---------------------------------------------------------------------------
 * WHAT IS IN HERE
 *
 *   DataTable         the grid: virtualised rows, sticky header/footer, column
 *                     resize / reorder / pin / hide, multi-sort, a per-column
 *                     filter row, a composable AND/OR filter builder, grouping
 *                     with aggregates, tree rows, inline editing, saved views,
 *                     CSV export, bulk actions.
 *   DataToolbar       search + filters + saved views + view switcher + actions.
 *   Pagination        page control with elided ranges.
 *   FilterBuilder     the field/operator/value query editor, standalone.
 *   KanbanBoard       draggable lanes and cards with WIP counts.
 *   Timeline          approval chains, revision history, milestones.
 *   ActivityFeed      the audit trail, bucketed by day.
 *   TreeView          WBS, cost codes, folders — full ARIA tree keyboard model.
 *   DescriptionList   the label/value grid on every detail page.
 *   FileList          dense document rows with versions and upload progress.
 *   AttachmentGrid    thumbnail tiles for photos and drawings.
 *   CommentThread     avatars, mentions, attachments, replies, resolution.
 *
 * Plus the formatter set (`formatCurrency`, `formatNumber`, `formatDateCell`,
 * `formatRelativeTime`, …) that keeps every numeric column in the product
 * reading the same way.
 * ---------------------------------------------------------------------------
 */
export * from "./data-table";
