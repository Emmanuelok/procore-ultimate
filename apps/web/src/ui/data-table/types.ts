/**
 * data-table/types — the public vocabulary of the DATA layer.
 *
 * Everything a page needs to describe a grid lives here. Pages never import
 * `@tanstack/react-table`; they describe columns with `DataColumn` and hand
 * them to `<DataTable />`, which owns the adapter.
 */
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { IconLike } from "../primitives";
import type { Tone } from "../tokens";

/* ============================================================================
   Scalars
============================================================================ */

/** Horizontal alignment of a column's header, cells and footer. */
export type DataAlign = "left" | "center" | "right";

/**
 * Semantic column type. Drives the default cell renderer, the default
 * alignment, the default filter control, the default aggregate and the CSV
 * serialisation — set it and most columns need nothing else.
 */
export type DataColumnType =
  | "text"
  | "number"
  | "currency"
  | "percent"
  | "date"
  | "datetime"
  | "duration"
  | "bytes"
  | "boolean"
  | "enum"
  | "status"
  | "tags"
  | "user"
  | "link"
  | "code"
  | "custom";

/** One sort instruction. Multiple entries = multi-column sort, in order. */
export interface DataSort {
  id: string;
  desc: boolean;
}

/** Column-level filter entry (the per-column filter row). */
export interface DataColumnFilter {
  id: string;
  value: unknown;
}

/** Column pinning regions. `start` is left in LTR, right in RTL. */
export interface DataPinning {
  start: string[];
  end: string[];
}

/** Row identity map used by selection and expansion. */
export type DataIdMap = Record<string, boolean>;

/** Pagination cursor. */
export interface DataPagination {
  pageIndex: number;
  pageSize: number;
}

/** Aggregate functions available to footers and group rows. */
export type DataAggregate =
  | "sum"
  | "avg"
  | "min"
  | "max"
  | "count"
  | "countUnique"
  | "median"
  | "extent"
  | "first"
  | "last"
  | "none";

/* ============================================================================
   Enum / option descriptors
============================================================================ */

export interface DataOption {
  value: string;
  label?: ReactNode;
  /** Plain-text label, used by CSV export and the option filter search. */
  text?: string;
  tone?: Tone;
  icon?: IconLike;
  description?: ReactNode;
  count?: number;
}

/** Which control the per-column filter row renders for a column. */
export type DataFilterKind =
  | "text"
  | "number"
  | "date"
  | "enum"
  | "boolean"
  | "none";

export interface DataFilterSpec {
  kind: DataFilterKind;
  /** Explicit option list for `enum`. Omit to derive from the data. */
  options?: readonly DataOption[];
  placeholder?: string;
  /** Numeric step for range inputs. */
  step?: number;
  /** Cap on derived enum options. Default 200. */
  maxOptions?: number;
}

/* ============================================================================
   Cell / header / footer render contexts
============================================================================ */

/** The slice of table behaviour a cell renderer is allowed to reach for. */
export interface DataTableApi<T> {
  /** Row ids currently selected, in display order. */
  selectedIds: readonly string[];
  toggleRowSelected(rowId: string, selected?: boolean): void;
  toggleRowExpanded(rowId: string, expanded?: boolean): void;
  setGlobalFilter(value: string): void;
  setColumnFilter(columnId: string, value: unknown): void;
  /** Begin editing a cell (no-op unless the table is editable). */
  startEditing(rowId: string, columnId: string): void;
  /** Current density resolved for this table. */
  density: "comfortable" | "compact";
  /** All rows after filtering and sorting, before pagination. */
  rows: readonly T[];
}

export interface DataCellContext<T, V = unknown> {
  value: V;
  row: T;
  rowId: string;
  /** Index within the currently rendered row model. */
  rowIndex: number;
  column: DataColumn<T, V>;
  columnId: string;
  isSelected: boolean;
  isExpanded: boolean;
  /** This cell carries the group value of a grouped row. */
  isGrouped: boolean;
  /** This cell shows an aggregate for a grouped row. */
  isAggregated: boolean;
  /** This cell is blanked because a sibling column owns the group value. */
  isPlaceholder: boolean;
  /** Nesting depth for tree data. 0 at the root. */
  depth: number;
  /** Number of leaf rows underneath a group / parent row. */
  subRowCount: number;
  api: DataTableApi<T>;
}

export interface DataHeaderContext<T> {
  column: DataColumn<T, unknown>;
  columnId: string;
  sorted: false | "asc" | "desc";
  sortIndex: number;
  api: DataTableApi<T>;
}

export interface DataFooterContext<T> {
  column: DataColumn<T, unknown>;
  columnId: string;
  /** Rows the aggregate was computed over (filtered, pre-pagination). */
  rows: readonly T[];
  /** Numeric aggregate, when the column has one. */
  value: number | null;
  /** The aggregate already formatted with the column's formatter. */
  formatted: string;
  api: DataTableApi<T>;
}

/* ============================================================================
   Column definition
============================================================================ */

export type DataAccessorFn<T, V> = (row: T, index: number) => V;

/**
 * Where a column reads its value from.
 *
 * • a key of `T`
 * • a dotted path (`"contract.vendor.name"`) — resolved safely
 * • a function
 */
export type DataAccessor<T, V> = keyof T | (string & {}) | DataAccessorFn<T, V>;

export interface DataCellEditor<T, V> {
  /** Control to render while the cell is in edit mode. Default: by type. */
  kind?: "text" | "number" | "select" | "date" | "checkbox" | "textarea";
  options?: readonly DataOption[];
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Fully custom editor. Must call `commit`/`cancel`. */
  render?: (ctx: DataCellEditorContext<T, V>) => ReactNode;
}

export interface DataCellEditorContext<T, V> {
  value: V;
  draft: string;
  row: T;
  rowId: string;
  columnId: string;
  column: DataColumn<T, V>;
  error: string | null;
  setDraft(next: string): void;
  commit(next?: string): void;
  cancel(): void;
}

/** A change produced by inline editing. */
export interface DataCellChange<T> {
  rowId: string;
  columnId: string;
  row: T;
  previous: unknown;
  value: unknown;
  /** Raw string the user typed, before `parse`. */
  raw: string;
}

export interface DataColumn<T, V = unknown> {
  /** Stable identity. Used by sorting, filters, saved views and CSV headers. */
  id: string;

  /** Header content. A string also becomes the CSV header and picker label. */
  header?: ReactNode | ((ctx: DataHeaderContext<T>) => ReactNode);
  /** Plain-text header, for CSV / the column picker / aria-label. */
  headerText?: string;
  /** Extra explanation shown in a tooltip on the header. */
  headerTooltip?: ReactNode;
  /** Banded header group label — adjacent columns sharing it are bracketed. */
  group?: string;

  /** Where the value comes from. Omit for pure display columns. */
  accessor?: DataAccessor<T, V>;

  /** Cell renderer. Omit to use the renderer for `type`. */
  cell?: (ctx: DataCellContext<T, V>) => ReactNode;
  /** Renderer for the aggregated value in a grouped row. */
  aggregatedCell?: (ctx: DataCellContext<T, V>) => ReactNode;
  /** Footer content. A function receives the computed aggregate. */
  footer?: ReactNode | ((ctx: DataFooterContext<T>) => ReactNode);

  /* -- semantics ---------------------------------------------------------- */

  /** Drives default alignment, renderer, filter, aggregate and CSV. */
  type?: DataColumnType;
  /** ISO currency code for `type: "currency"`. Default "USD". */
  currency?: string;
  /** Fraction digits for numeric types. */
  precision?: number;
  /** Abbreviate large numbers (1.2M). */
  compact?: boolean;
  /** Options for `type: "enum" | "status" | "tags"`. */
  options?: readonly DataOption[];
  /** Tint negative numbers red and positives green (variance columns). */
  signColor?: boolean;
  /** Render a percentage as a meter bar as well as a number. */
  progress?: boolean;
  /** Shown instead of an empty value. Default "—". */
  emptyText?: string;

  /* -- layout ------------------------------------------------------------- */

  align?: DataAlign;
  /** Initial width in px. Default 160 (or a type-appropriate width). */
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  /** Pin to a viewport edge; the cells become sticky. */
  sticky?: "start" | "end";
  /** Render with tabular figures + the mono stack. */
  mono?: boolean;
  /** Single-line with an ellipsis. Default true. */
  truncate?: boolean;
  /** Extra classes for every cell in the column. */
  cellClassName?: string;
  headerClassName?: string;
  /** Per-row class, e.g. to tint a variance column red. */
  rowCellClassName?: (ctx: DataCellContext<T, V>) => string | undefined;

  /* -- behaviour ---------------------------------------------------------- */

  /** Default: true when the column has an accessor. */
  sortable?: boolean;
  /** Start a fresh sort descending (right for money and dates). */
  sortDescFirst?: boolean;
  /** Custom comparator. Return <0, 0, >0. */
  sortFn?: (a: V, b: V, rowA: T, rowB: T) => number;
  /** Show a control in the filter row. Default: true when filterable data. */
  filterable?: boolean;
  filter?: DataFilterSpec;
  /** Include in the global quick filter. Default true for text-ish columns. */
  searchable?: boolean;
  /** Offer in the column picker. Default true. */
  hideable?: boolean;
  /** Hidden until the user turns it on in the picker. */
  defaultHidden?: boolean;
  /** Draggable width. Default true. */
  resizable?: boolean;
  /** Offer as a "group by" target. */
  groupable?: boolean;
  /** Aggregate for footers and group rows. Default: by `type`. */
  aggregate?: DataAggregate;
  /** The cell holds its own interactive controls; do not let a row link eat clicks. */
  interactive?: boolean;

  /* -- editing ------------------------------------------------------------ */

  editable?: boolean | ((row: T) => boolean);
  editor?: DataCellEditor<T, V>;
  /** Return a message to reject the edit, or null/undefined to accept. */
  validate?: (value: unknown, row: T, raw: string) => string | null | undefined;
  /** Turn the raw input string into the stored value. Default: by `type`. */
  parse?: (raw: string, row: T) => unknown;
  /** Value shown in the editor when it opens. Default: the formatted value. */
  serialize?: (value: V, row: T) => string;

  /* -- export ------------------------------------------------------------- */

  /** Exclude from CSV export. */
  exportable?: boolean;
  /** Value written to CSV. Default: the formatted primitive. */
  toCsv?: (ctx: DataCellContext<T, V>) => string | number | null | undefined;

  /** Anything else the page wants to hang off the column. */
  meta?: Record<string, unknown>;
}

/** Heterogeneous column list — value types vary per column. */
export type DataColumns<T> = ReadonlyArray<DataColumn<T, any>>;

/* ============================================================================
   Advanced filter builder
============================================================================ */

export type DataFilterOperator =
  | "eq"
  | "neq"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "in"
  | "notIn"
  | "isEmpty"
  | "isNotEmpty"
  | "isTrue"
  | "isFalse";

export interface DataFilterCondition {
  kind: "condition";
  id: string;
  field: string;
  operator: DataFilterOperator;
  value?: unknown;
  /** Upper bound for `between`. */
  value2?: unknown;
}

export interface DataFilterGroup {
  kind: "group";
  id: string;
  conjunction: "and" | "or";
  children: DataFilterNode[];
}

export type DataFilterNode = DataFilterCondition | DataFilterGroup;

/** A field the advanced builder can filter on, derived from the columns. */
export interface DataFilterField {
  id: string;
  label: string;
  kind: DataFilterKind;
  options?: readonly DataOption[];
}

/* ============================================================================
   Selection, actions, views
============================================================================ */

export interface DataBulkAction<T> {
  id: string;
  label: string;
  icon?: IconLike;
  tone?: Tone;
  destructive?: boolean;
  disabled?: boolean | ((rows: readonly T[]) => boolean);
  /** Ask before running. */
  confirm?: string;
  onSelect: (rows: readonly T[], ids: readonly string[]) => void | Promise<void>;
}

export interface DataRowAction<T> {
  id: string;
  label: string;
  icon?: IconLike;
  destructive?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  shortcut?: string;
  onSelect: (row: T) => void;
}

/** The persisted shape of a saved view. */
export interface DataViewState {
  columnVisibility?: Record<string, boolean>;
  columnOrder?: string[];
  columnPinning?: DataPinning;
  columnSizing?: Record<string, number>;
  sorting?: DataSort[];
  columnFilters?: DataColumnFilter[];
  globalFilter?: string;
  grouping?: string[];
  advancedFilter?: DataFilterGroup | null;
  pageSize?: number;
  zebra?: boolean;
}

export interface DataView {
  id: string;
  name: string;
  state: DataViewState;
  /** Ships with the page; cannot be deleted or overwritten. */
  builtIn?: boolean;
  icon?: IconLike;
  createdAt?: string;
}

/* ============================================================================
   DataTable props
============================================================================ */

export interface DataTableEmpty {
  title?: ReactNode;
  description?: ReactNode;
  icon?: IconLike;
  action?: ReactNode;
}

export interface DataRowClickContext<T> {
  row: T;
  rowId: string;
  index: number;
  event: ReactMouseEvent<HTMLElement>;
}

export interface DataTableHandle<T> {
  /** Scroll a row into view by id. */
  scrollToRow(rowId: string, align?: "start" | "center" | "end" | "auto"): void;
  scrollToIndex(index: number, align?: "start" | "center" | "end" | "auto"): void;
  /** Rows after filtering and sorting, before pagination. */
  getRows(): readonly T[];
  getSelectedRows(): readonly T[];
  clearSelection(): void;
  selectAll(): void;
  /** Download the current view as CSV. */
  exportCsv(fileName?: string): void;
  /** Restore column layout, filters and sort to the initial view. */
  resetView(): void;
  /** Discard every pending inline edit. */
  discardEdits(): void;
  /** Rows that have uncommitted inline edits. */
  getDirtyRows(): readonly string[];
  /** Move keyboard focus into the grid. */
  focus(): void;
}

export interface DataTableProps<T> {
  /* -- data ---------------------------------------------------------------- */

  data: readonly T[];
  columns: DataColumns<T>;
  /** Stable row identity. Strongly recommended — defaults to `row.id`. */
  getRowId?: (row: T, index: number) => string;
  /** Return children to turn the grid into a tree (WBS, cost codes). */
  getSubRows?: (row: T) => readonly T[] | undefined;

  /** Namespace for persisted state and saved views. Enables both. */
  tableId?: string;

  /* -- states -------------------------------------------------------------- */

  loading?: boolean;
  /** Skeleton rows drawn while loading. Default 8. */
  loadingRows?: number;
  error?: unknown;
  onRetry?: () => void;
  empty?: DataTableEmpty;
  /** Shown when filters exclude everything (as opposed to no data at all). */
  emptyFiltered?: DataTableEmpty;

  /* -- shell / layout ------------------------------------------------------ */

  /** Fixed viewport height. Required for virtualization to mean anything. */
  height?: number | string;
  maxHeight?: number | string;
  /** Grow to fill a flex parent instead of sizing to content. */
  fill?: boolean;
  /** Force virtualization on/off. Default: on above `virtualizeThreshold`. */
  virtualized?: boolean;
  /** Default 80 rows. */
  virtualizeThreshold?: number;
  /** Rows rendered outside the viewport. Default 12. */
  overscan?: number;
  /** Explicit row height in px. Default: the density token. */
  rowHeight?: number;
  stickyHeader?: boolean;
  /** Sticky aggregate row. Implies `showFooter`. */
  stickyFooter?: boolean;
  showFooter?: boolean;
  /** `auto` follows the global density attribute. */
  density?: "comfortable" | "compact" | "auto";
  zebra?: boolean;
  /** Vertical hairlines between cells. */
  gridLines?: boolean;
  /** Drop the outer border/radius — for tables flush inside a card. */
  flush?: boolean;
  className?: string;
  style?: CSSProperties;
  caption?: string;
  "aria-label"?: string;

  /* -- toolbar ------------------------------------------------------------- */

  /** `false` removes the built-in toolbar; a node replaces it. */
  toolbar?: ReactNode | false;
  /** Extra controls rendered on the toolbar's right side. */
  toolbarActions?: ReactNode;
  /** Show the quick-filter input. Default true when a toolbar is shown. */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Show the column picker button. Default true. */
  columnPicker?: boolean;
  /** Show the density toggle. Default true. */
  densityToggle?: boolean;
  /** Show the "Filter" button that opens the advanced builder. Default true. */
  filterBuilder?: boolean;
  /** Show the CSV export button. Default true. */
  exportable?: boolean;
  exportFileName?: string;
  onExport?: (rows: readonly T[]) => void;
  /** Show the saved-views control. Requires `tableId`. Default true. */
  savedViews?: boolean;
  /** Views that always exist and cannot be deleted. */
  builtInViews?: readonly DataView[];

  /* -- sorting ------------------------------------------------------------- */

  sortable?: boolean;
  defaultSort?: readonly DataSort[];
  sorting?: readonly DataSort[];
  onSortingChange?: (sorting: DataSort[]) => void;
  /** Shift-click adds a column to the sort. Default true. */
  multiSort?: boolean;
  /** Skip client-side sorting — you sort on the server. */
  manualSorting?: boolean;

  /* -- filtering ----------------------------------------------------------- */

  /** Render the per-column filter row under the header. */
  filterRow?: boolean;
  globalFilter?: string;
  onGlobalFilterChange?: (value: string) => void;
  columnFilters?: readonly DataColumnFilter[];
  onColumnFiltersChange?: (filters: DataColumnFilter[]) => void;
  advancedFilter?: DataFilterGroup | null;
  onAdvancedFilterChange?: (filter: DataFilterGroup | null) => void;
  manualFiltering?: boolean;

  /* -- columns ------------------------------------------------------------- */

  columnVisibility?: Record<string, boolean>;
  onColumnVisibilityChange?: (visibility: Record<string, boolean>) => void;
  columnOrder?: readonly string[];
  onColumnOrderChange?: (order: string[]) => void;
  columnPinning?: DataPinning;
  onColumnPinningChange?: (pinning: DataPinning) => void;
  columnSizing?: Record<string, number>;
  onColumnSizingChange?: (sizing: Record<string, number>) => void;
  /** Drag the right edge of a header to resize. Default true. */
  resizableColumns?: boolean;
  /** Drag a header onto another to reorder. Default true. */
  reorderableColumns?: boolean;
  /** Offer pin/hide/group actions in the header menu. Default true. */
  columnMenu?: boolean;

  /* -- selection ----------------------------------------------------------- */

  selectable?: boolean | "single" | "multi";
  selectedIds?: readonly string[];
  onSelectionChange?: (ids: string[], rows: T[]) => void;
  isRowSelectable?: (row: T) => boolean;
  bulkActions?: ReadonlyArray<DataBulkAction<T>>;
  /**
   * Total rows on the server. When the visible page is fully selected the bulk
   * bar offers "select all N" and calls `onSelectAllAcross(true)`.
   */
  totalCount?: number;
  onSelectAllAcross?: (selected: boolean) => void;
  /** True while every row on the server is considered selected. */
  allAcrossSelected?: boolean;

  /* -- grouping & tree ----------------------------------------------------- */

  grouping?: readonly string[];
  onGroupingChange?: (grouping: string[]) => void;
  /** Expanded row ids, or `true` for "everything". */
  expanded?: true | Record<string, boolean>;
  onExpandedChange?: (expanded: true | Record<string, boolean>) => void;
  defaultExpanded?: true | Record<string, boolean>;
  /** Column that carries the tree expander. Default: first data column. */
  treeColumnId?: string;

  /* -- pagination ---------------------------------------------------------- */

  paginated?: boolean;
  pageSize?: number;
  pageSizeOptions?: readonly number[];
  pageIndex?: number;
  onPaginationChange?: (pagination: DataPagination) => void;
  manualPagination?: boolean;
  /** Server-side page count when `manualPagination` is set. */
  pageCount?: number;

  /* -- interaction --------------------------------------------------------- */

  onRowClick?: (ctx: DataRowClickContext<T>) => void;
  onRowDoubleClick?: (ctx: DataRowClickContext<T>) => void;
  /** Turns the row into a real link (middle-click, cmd-click, copy address). */
  rowHref?: (row: T) => string | undefined;
  /** Accessible name for the row link. Default: the first cell's text. */
  rowLabel?: (row: T) => string;
  /** Actions revealed on hover, pinned to the right edge. */
  rowActions?: (row: T) => ReadonlyArray<DataRowAction<T>> | ReactNode;
  rowClassName?: (row: T, index: number) => string | undefined;
  /** Paint a 2px status rail down the left edge of the row. */
  rowTone?: (row: T) => Tone | undefined;
  /** Arrow-key row/cell navigation. Default true. */
  keyboardNavigation?: boolean;

  /* -- inline editing ------------------------------------------------------ */

  /** Turn on spreadsheet mode. Individual columns still opt in via `editable`. */
  editable?: boolean;
  /** Called once per committed cell. Reject by throwing or returning false. */
  onCellEdit?: (change: DataCellChange<T>) => void | boolean | Promise<void | boolean>;
  /** Called with every pending change when `Commit` is pressed. */
  onCommitEdits?: (changes: ReadonlyArray<DataCellChange<T>>) => void | Promise<void>;
  /** Keep edits in the grid until committed. Default true. */
  bufferEdits?: boolean;
}

/* ============================================================================
   Toolbar / pagination / board / feed / tree props
============================================================================ */

export interface DataViewModeOption {
  value: string;
  label: string;
  icon?: IconLike;
}

export interface DataToolbarProps {
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  /** Show a busy spinner in the search field. */
  searching?: boolean;

  /** Filter chips rendered under the control row. */
  filters?: ReactNode;
  /** Number on the "Filter" button's badge. */
  filterCount?: number;
  onOpenFilters?: () => void;
  onClearFilters?: () => void;

  views?: readonly DataView[];
  activeViewId?: string | null;
  onViewChange?: (id: string) => void;
  onSaveView?: (name: string) => void;
  onDeleteView?: (id: string) => void;
  viewDirty?: boolean;

  viewModes?: readonly DataViewModeOption[];
  viewMode?: string;
  onViewModeChange?: (value: string) => void;

  /** Slot for the column picker / density toggle / export cluster. */
  tools?: ReactNode;
  actions?: ReactNode;

  selectionCount?: number;
  totalCount?: number;
  /** Right-aligned summary, e.g. "1–50 of 12,904". */
  summary?: ReactNode;

  title?: ReactNode;
  className?: string;
  /** Remove the bottom hairline (when the toolbar floats above a card). */
  flush?: boolean;
  children?: ReactNode;
}

export interface PaginationProps {
  page: number;
  pageSize: number;
  total?: number;
  pageCount?: number;
  pageSizeOptions?: readonly number[];
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  showSizeSelector?: boolean;
  showSummary?: boolean;
  /** Numbered page buttons rather than just prev/next. Default true. */
  showPages?: boolean;
  size?: "sm" | "md";
  className?: string;
  disabled?: boolean;
  itemNoun?: string;
}
