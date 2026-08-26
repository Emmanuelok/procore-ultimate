/**
 * data-table — the DATA layer of the ConstructOS design system.
 *
 * Re-exported wholesale by `src/ui/data.tsx`, which the `../ui` barrel picks
 * up. Pages import from `"../../ui"`; nothing below should ever be imported by
 * a page through a deep path.
 */

/* ---------------------------------------------------------------- components */

export { DataTable } from "./DataTable";
export type { DataTableComponentProps } from "./DataTable";

export { DataToolbar } from "./DataToolbar";
export { Pagination, pageWindow } from "./Pagination";
export { FilterBuilder, FilterBuilderPopover } from "./FilterBuilder";
export type { FilterBuilderProps } from "./FilterBuilder";

export { KanbanBoard, KanbanCard, KanbanChip } from "./KanbanBoard";
export type { KanbanBoardProps, KanbanCardProps, KanbanColumn, KanbanMove } from "./KanbanBoard";

export { Timeline, ActivityFeed, ActivityBadge } from "./Timeline";
export type { TimelineProps, TimelineItem, TimelineActor, ActivityFeedProps } from "./Timeline";

export { TreeView } from "./TreeView";
export type { TreeViewProps, TreeNode } from "./TreeView";

export { DescriptionList } from "./DescriptionList";
export type { DescriptionListProps, DescriptionItem } from "./DescriptionList";

export { FileList, AttachmentGrid, FileTypeIcon, fileGlyph } from "./FileList";
export type {
  FileListProps,
  AttachmentGridProps,
  FileItem,
  FileAction,
  FileActor,
} from "./FileList";

export { CommentThread, renderCommentBody } from "./CommentThread";
export type {
  CommentThreadProps,
  CommentItem,
  CommentAuthor,
  CommentMention,
  CommentReaction,
} from "./CommentThread";

/* ------------------------------------------------------------------- types */

export type {
  DataAccessor,
  DataAccessorFn,
  DataAggregate,
  DataAlign,
  DataBulkAction,
  DataCellChange,
  DataCellContext,
  DataCellEditor,
  DataCellEditorContext,
  DataColumn,
  DataColumnFilter,
  DataColumnType,
  DataColumns,
  DataFilterCondition,
  DataFilterField,
  DataFilterGroup,
  DataFilterKind,
  DataFilterNode,
  DataFilterOperator,
  DataFilterSpec,
  DataFooterContext,
  DataHeaderContext,
  DataIdMap,
  DataOption,
  DataPagination,
  DataPinning,
  DataRowAction,
  DataRowClickContext,
  DataSort,
  DataTableApi,
  DataTableEmpty,
  DataTableHandle,
  DataTableProps,
  DataToolbarProps,
  DataView,
  DataViewModeOption,
  DataViewState,
  PaginationProps,
} from "./types";

/* -------------------------------------------------------------- formatting */

export {
  EMPTY_VALUE,
  aggregateValues,
  dataFormat,
  formatCompactNumber,
  formatCurrency,
  formatDateCell,
  formatDateTimeCell,
  formatDayBucket,
  formatDelta,
  /**
   * Exported as `formatDurationCell` so it cannot collide with the
   * working-calendar `formatDuration` in the INPUTS layer, which takes minutes
   * and understands hours-per-day. This one takes seconds and is the grid's
   * `type: "duration"` renderer. `dataFormat.duration` is the same function.
   */
  formatDuration as formatDurationCell,
  formatFileSize,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatTimeCell,
  toDate,
  toDateInputValue,
  toNumber,
  toText,
  AGGREGATE_LABEL,
} from "./format";
export type { AggregateKind, CurrencyFormatOptions, NumberFormatOptions } from "./format";

/* ------------------------------------------------------------------ filters */

export {
  appendFilterNode,
  applyColumnFilter,
  countConditions,
  createCondition,
  createFilterGroup,
  deriveOptions,
  evaluateFilterNode,
  filterFieldMap,
  filterFieldsFromColumns,
  filterKindFor,
  getByPath,
  isEmptyFilterValue,
  makeAccessor,
  operatorSpec,
  operatorsFor,
  pruneFilter,
  removeFilterNode,
  updateFilterNode,
} from "./filters";
export type { OperatorSpec, RangeFilterValue } from "./filters";

/* ---------------------------------------------------------------- CSV export */

export { downloadCsv, escapeCsvValue, exportCsv, sanitiseFileName, toCsv } from "./csv";
export type { CsvTable } from "./csv";

/* ------------------------------------------------------------- saved views */

export {
  clearLayout,
  loadActiveViewId,
  loadLayout,
  loadViews,
  makeViewId,
  saveActiveViewId,
  saveLayout,
  saveViews,
  viewStatesEqual,
} from "./views";

/* ------------------------------------------------------------------ engine */

export {
  ACTIONS_COLUMN_ID,
  SELECT_COLUMN_ID,
  aggregateFor,
  alignFor,
  headerTextOf,
  isSearchable,
  widthFor,
} from "./table-core";
export type { RowShape } from "./table-core";

/* ------------------------------------------------------- rendering helpers */

export { renderCellValue, csvValueFor, useGlobalDensity } from "./internals";
export type { CellValueOptions } from "./internals";
