/**
 * data-table/table-core — the bridge between the friendly `DataColumn` shape a
 * page writes and the TanStack Table v9 engine that runs the grid.
 *
 * Everything TanStack-specific lives behind this module: the feature registry,
 * the filter/sort/aggregation function registries, and the column adapter.
 * A page never imports `@tanstack/react-table`.
 */
import {
  columnFilteringFeature,
  columnGroupingFeature,
  columnOrderingFeature,
  columnPinningFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createExpandedRowModel,
  createFilteredRowModel,
  createGroupedRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  globalFilteringFeature,
  rowAggregationFeature,
  rowExpandingFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
  aggregationFn_count,
  aggregationFn_extent,
  aggregationFn_first,
  aggregationFn_last,
  aggregationFn_max,
  aggregationFn_mean,
  aggregationFn_median,
  aggregationFn_min,
  aggregationFn_sum,
  aggregationFn_uniqueCount,
} from "@tanstack/react-table";
import type {
  Cell,
  ColumnDef,
  FilterFn,
  Row,
  SortFn,
  Table as CoreTable,
} from "@tanstack/react-table";
import { applyColumnFilter, filterKindFor, isEmptyFilterValue, makeAccessor } from "./filters";
import { toDate, toNumber, toText } from "./format";
import type {
  DataAggregate,
  DataAlign,
  DataColumn,
  DataColumnType,
  DataColumns,
  DataFilterKind,
} from "./types";

/* ============================================================================
   Reserved column ids
============================================================================ */

/** Checkbox column. Rendered by the row, not by a cell template. */
export const SELECT_COLUMN_ID = "__select";
/** Hover-action column, pinned to the end. */
export const ACTIONS_COLUMN_ID = "__actions";

export const RESERVED_COLUMN_IDS: ReadonlySet<string> = new Set([
  SELECT_COLUMN_ID,
  ACTIONS_COLUMN_ID,
]);

/* ============================================================================
   Filter functions
============================================================================ */

function makeFilterFn(kind: DataFilterKind): FilterFn<any, any> {
  const fn: FilterFn<any, any> = (row, columnId, filterValue) =>
    applyColumnFilter(kind, row.getValue(columnId), filterValue);
  fn.autoRemove = (value: unknown) => isEmptyFilterValue(value);
  return fn;
}

const dtText = makeFilterFn("text");
const dtNumber = makeFilterFn("number");
const dtDate = makeFilterFn("date");
const dtEnum = makeFilterFn("enum");
const dtBoolean = makeFilterFn("boolean");

/**
 * Quick filter. Runs per column and the engine ORs the results, so a hit in any
 * searchable column keeps the row. Whitespace splits into AND terms, which is
 * what people expect from "smith rfi 204".
 */
const dtGlobal: FilterFn<any, any> = (row, columnId, filterValue) => {
  const query = toText(filterValue).trim().toLowerCase();
  if (!query) return true;
  const haystack = toText(row.getValue(columnId)).toLowerCase();
  if (!haystack) return false;
  const terms = query.split(/\s+/);
  return terms.every((term) => haystack.includes(term));
};
dtGlobal.autoRemove = (value: unknown) => toText(value).trim() === "";

const FILTER_FN_BY_KIND: Record<DataFilterKind, string> = {
  text: "dtText",
  number: "dtNumber",
  date: "dtDate",
  enum: "dtEnum",
  boolean: "dtBoolean",
  none: "dtText",
};

/* ============================================================================
   Sort functions
============================================================================ */

const collator =
  typeof Intl !== "undefined"
    ? new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
    : null;

function compareBlank(a: unknown, b: unknown): number | null {
  const aBlank = a === null || a === undefined || a === "";
  const bBlank = b === null || b === undefined || b === "";
  if (aBlank && bBlank) return 0;
  if (aBlank) return 1;
  if (bBlank) return -1;
  return null;
}

/** Natural-order text sort: "Level 9" before "Level 10", "01-100" before "01-2". */
const dtSortText: SortFn<any, any> = (rowA, rowB, columnId) => {
  const a = rowA.getValue(columnId);
  const b = rowB.getValue(columnId);
  const blank = compareBlank(a, b);
  if (blank !== null) return blank;
  const textA = toText(a);
  const textB = toText(b);
  return collator ? collator.compare(textA, textB) : textA.localeCompare(textB);
};

const dtSortNumber: SortFn<any, any> = (rowA, rowB, columnId) => {
  const a = toNumber(rowA.getValue(columnId));
  const b = toNumber(rowB.getValue(columnId));
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a === b ? 0 : a < b ? -1 : 1;
};

const dtSortDate: SortFn<any, any> = (rowA, rowB, columnId) => {
  const a = toDate(rowA.getValue(columnId));
  const b = toDate(rowB.getValue(columnId));
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.getTime() - b.getTime();
};

const dtSortBoolean: SortFn<any, any> = (rowA, rowB, columnId) => {
  const a = rowA.getValue(columnId) ? 1 : 0;
  const b = rowB.getValue(columnId) ? 1 : 0;
  return a - b;
};

const SORT_FN_BY_TYPE: Partial<Record<DataColumnType, string>> = {
  number: "dtSortNumber",
  currency: "dtSortNumber",
  percent: "dtSortNumber",
  duration: "dtSortNumber",
  bytes: "dtSortNumber",
  date: "dtSortDate",
  datetime: "dtSortDate",
  boolean: "dtSortBoolean",
};

/* ============================================================================
   Feature registry — one instance for every grid in the app.
============================================================================ */

export const dataTableFeatures = tableFeatures({
  columnFilteringFeature,
  columnGroupingFeature,
  columnOrderingFeature,
  columnPinningFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  globalFilteringFeature,
  rowAggregationFeature,
  rowExpandingFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,

  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  groupedRowModel: createGroupedRowModel(),
  expandedRowModel: createExpandedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),

  filterFns: { dtText, dtNumber, dtDate, dtEnum, dtBoolean, dtGlobal },
  sortFns: { dtSortText, dtSortNumber, dtSortDate, dtSortBoolean },
  aggregationFns: {
    sum: aggregationFn_sum,
    mean: aggregationFn_mean,
    median: aggregationFn_median,
    min: aggregationFn_min,
    max: aggregationFn_max,
    extent: aggregationFn_extent,
    count: aggregationFn_count,
    uniqueCount: aggregationFn_uniqueCount,
    first: aggregationFn_first,
    last: aggregationFn_last,
  },
});

export type DataTableFeatures = typeof dataTableFeatures;

/**
 * The row constraint the engine imposes. Interfaces satisfy it (TypeScript
 * grants an implicit index signature when the value type is `any`), so pages
 * keep using their own domain interfaces unchanged.
 */
export type RowShape = Record<string, any>;

export type DataTableInstance<T extends RowShape> = CoreTable<DataTableFeatures, T>;
export type DataRow<T extends RowShape> = Row<DataTableFeatures, T>;
export type DataCell<T extends RowShape> = Cell<DataTableFeatures, T, unknown>;
export type DataColumnDef<T extends RowShape> = ColumnDef<DataTableFeatures, T, any>;

const AGGREGATION_NAME: Record<DataAggregate, string | undefined> = {
  sum: "sum",
  avg: "mean",
  min: "min",
  max: "max",
  count: "count",
  countUnique: "uniqueCount",
  median: "median",
  extent: "extent",
  first: "first",
  last: "last",
  none: undefined,
};

/* ============================================================================
   Column defaults derived from `type`
============================================================================ */

const DEFAULT_WIDTH: Record<DataColumnType, number> = {
  text: 200,
  number: 120,
  currency: 148,
  percent: 104,
  date: 128,
  datetime: 176,
  duration: 112,
  bytes: 112,
  boolean: 92,
  enum: 148,
  status: 136,
  tags: 200,
  user: 184,
  link: 208,
  code: 140,
  custom: 160,
};

const RIGHT_ALIGNED: ReadonlySet<DataColumnType> = new Set<DataColumnType>([
  "number",
  "currency",
  "percent",
  "duration",
  "bytes",
]);

export function alignFor<T>(column: DataColumn<T, any>): DataAlign {
  if (column.align) return column.align;
  const type = column.type ?? "text";
  if (RIGHT_ALIGNED.has(type)) return "right";
  if (type === "boolean") return "center";
  return "left";
}

export function widthFor<T>(column: DataColumn<T, any>): number {
  if (typeof column.width === "number") return column.width;
  return DEFAULT_WIDTH[column.type ?? "text"] ?? 160;
}

export function aggregateFor<T>(column: DataColumn<T, any>): DataAggregate {
  if (column.aggregate) return column.aggregate;
  const type = column.type ?? "text";
  if (type === "currency" || type === "number" || type === "bytes" || type === "duration") {
    return "sum";
  }
  if (type === "percent") return "avg";
  return "none";
}

export function isSearchable<T>(column: DataColumn<T, any>): boolean {
  if (column.searchable !== undefined) return column.searchable;
  if (!column.accessor) return false;
  const type = column.type ?? "text";
  return type !== "boolean";
}

export function headerTextOf<T>(column: DataColumn<T, any>): string {
  if (column.headerText) return column.headerText;
  if (typeof column.header === "string") return column.header;
  if (typeof column.header === "number") return String(column.header);
  return column.id;
}

/* ============================================================================
   The adapter
============================================================================ */

export interface BuildColumnsOptions {
  sortable: boolean;
  resizable: boolean;
  hideable: boolean;
}

/**
 * Turn `DataColumn`s into TanStack column defs. Headers, cells and footers are
 * rendered by the grid itself, so the defs carry only behaviour and geometry —
 * the render templates stay in React where they can be memoised properly.
 */
export function buildColumnDefs<T extends RowShape>(
  columns: DataColumns<T>,
  options: BuildColumnsOptions,
): Array<DataColumnDef<T>> {
  const defs: Array<DataColumnDef<T>> = [];

  for (const column of columns) {
    const isDisplay = !column.accessor;
    const type = column.type ?? "text";
    const width = widthFor(column);
    const filterKind = filterKindFor(column);
    const aggregate = aggregateFor(column);
    const aggregationFn = AGGREGATION_NAME[aggregate];

    const base: Record<string, unknown> = {
      id: column.id,
      header: headerTextOf(column),
      size: width,
      minSize: column.minWidth ?? Math.min(64, width),
      maxSize: column.maxWidth ?? 1200,
      enableHiding: options.hideable && column.hideable !== false && !isDisplay,
      enableResizing: options.resizable && column.resizable !== false,
      enablePinning: true,
      enableGrouping: Boolean(column.groupable) && !isDisplay,
      enableSorting: options.sortable && column.sortable !== false && !isDisplay,
      enableColumnFilter: !isDisplay && column.filterable !== false && filterKind !== "none",
      enableGlobalFilter: isSearchable(column),
      sortDescFirst:
        column.sortDescFirst ??
        (type === "currency" || type === "number" || type === "date" || type === "datetime"),
      sortUndefined: "last",
    };

    if (!isDisplay) {
      base.accessorFn = makeAccessor<T, unknown>(column.accessor, column.id);
      base.filterFn = FILTER_FN_BY_KIND[filterKind];
      if (column.sortFn) {
        const compare = column.sortFn;
        const custom: SortFn<any, any> = (rowA, rowB, columnId) =>
          compare(
            rowA.getValue(columnId),
            rowB.getValue(columnId),
            rowA.original as T,
            rowB.original as T,
          );
        base.sortFn = custom;
      } else {
        base.sortFn = SORT_FN_BY_TYPE[type] ?? "dtSortText";
      }
      if (aggregationFn) base.aggregationFn = aggregationFn;
    }

    defs.push(base as unknown as DataColumnDef<T>);
  }

  return defs;
}

/** Default row identity: `row.id`, else the path through the tree. */
export function defaultRowId<T>(row: T, index: number, parentId?: string): string {
  const record = row as unknown as Record<string, unknown> | null;
  const raw = record?.["id"] ?? record?.["_id"] ?? record?.["uuid"];
  if (typeof raw === "string" && raw !== "") return raw;
  if (typeof raw === "number") return String(raw);
  return parentId ? `${parentId}.${index}` : String(index);
}

/** Every leaf column id in declaration order — the seed for `columnOrder`. */
export function columnIdsOf<T>(columns: DataColumns<T>): string[] {
  return columns.map((column) => column.id);
}

/** Column ids hidden by default, as a visibility map. */
export function defaultVisibility<T>(columns: DataColumns<T>): Record<string, boolean> {
  const visibility: Record<string, boolean> = {};
  for (const column of columns) {
    if (column.defaultHidden) visibility[column.id] = false;
  }
  return visibility;
}

/** Columns declaring `sticky`, as a pinning state. */
export function defaultPinning<T>(columns: DataColumns<T>): { start: string[]; end: string[] } {
  const start: string[] = [];
  const end: string[] = [];
  for (const column of columns) {
    if (column.sticky === "start") start.push(column.id);
    else if (column.sticky === "end") end.push(column.id);
  }
  return { start, end };
}
